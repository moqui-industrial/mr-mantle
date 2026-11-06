/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shop's digital delivery (mr-pass impl-shop P6; design-shop §8.3 Digital items, §10 Downloads; SHOP-DIGITAL, F20, F22):
 * an approved Shop order's plain digital lines (a PtDigital product with no subscription resource, P7's) are fulfilled by
 * StoreItemFulfillment rows, each step in a transaction of its own and resumable by its marker.
 *
 * - The steps, for the order's digital lines together: the payment captured (capture#SinglePayment with its operation key,
 *   in a transaction holding only the payment, before any invoice, so no provider is asked while the invoice or order is
 *   held); the lines invoiced through create#FulfillmentInvoice (the internal split of create#InvoiceFromSource, F22),
 *   which applies the captured payment; the invoice finalized (its InvoiceFinalized email is the receipt) and checked paid;
 *   the part checked complete (checkComplete#OrderPart); then a StoreDownloadGrant per downloadable file and the
 *   download-ready notice on the delivery ledger (MessageServices). A capture that does not succeed holds the lines
 *   (SifHeld; check#CaptureOutcome holds the order) and grants nothing; an unknown one waits for the job.
 * - Downloads: get#Downloads lists the grants a signed-in verified buyer owns in this store (the self relationship) or a
 *   guest's order link (the SalesOrder capability with the Download scope) reaches; issue#Download makes a capability of ten
 *   minutes for one grant (SalesOrder, Download, its order); get#DownloadFile checks it and the grant again and answers the
 *   file's location (kept on the server) with its range. A raw location is never answered to a page.
 * - Refunds (reconcile#RefundedItem, from the PaymentRefundedReconcileAccess and ReturnSettledReconcileAccess SECAs): a
 *   returned digital line, a cancelled one, or an order whose payment no longer covers its digital lines ends their grants.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const attempts = () => ec.resource.script("component://mr-mantle/service/mantle/account/PaymentAttempts.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, ms} = lib
const F = "mantle.product.store.StoreItemFulfillment"
const G = "mantle.product.store.StoreDownloadGrant"
const C = "mantle.order.StoreCheckout"
const P = "mantle.account.payment.Payment"
const SERVICES = "mantle.product.ShopFulfillmentServices."

// ===== tables =====
// Bounds: minutes a download capability lives, days a guest's download link lives, tries before a row waits for staff, rows
// the job takes a run, minutes between tries.
const limits = {downloadMinutes: 10, linkDays: 90, tries: 8, batch: 100, backoffMinutes: [5, 15, 60, 240, 720]}
const approvedOrderStatuses = ["OrderApproved", "OrderSent", "OrderProcessing", "OrderCompleted"]
const paidStatuses = ["PmntDelivered", "PmntConfirmed"]
const openSteps = ["SifPending", "SifInvoiced", "SifPaid", "SifHeld"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
function refuse(kind, code, message) {
    const error = new Error(code + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This download is not available")
// A step in a transaction of its own: {result} or {error}.
function step(name, input) {
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(SERVICES + "run#FulfillmentStep")
                .parameters({input: Object.assign({step: name}, input)})
                .disableAuthz()
                .requireNewTransaction(true)
                .call() || {}
        if (ec.message.hasError()) return {error: ec.message.getErrorsString()}
        return {result: out.result || {}}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const firstLine = value =>
    String(value || "")
        .split("\n")[0]
        .replace(/^(?:Error: )+/, "")
        .slice(0, 255)

// ===== which lines =====
// The order's Shop checkout, when Shop placed it (the rules here act only on what Shop makes).
const checkoutOf = orderId => (orderId ? one(C, {orderId, statusId: "ScoCompleted"}) : null)
const productLines = orderId =>
    rows("mantle.order.OrderItem", {orderId})
        .filter(item => item.productId && !item.parentItemSeqId && item.isPromo !== "Y" && item.itemTypeEnumId === "ItemProduct")
        .sort((a, b) => String(a.orderItemSeqId).localeCompare(String(b.orderItemSeqId)))
// A plain downloadable product: digital, with no subscription resource (paid access is P7's).
function plainDigital(productId) {
    const product = one("mantle.product.Product", {productId})
    if (!product || product.productTypeEnumId !== "PtDigital") return false
    return !rows("mantle.product.subscription.ProductSubscriptionResource", {productId}).some(row => lib.active(row))
}
const digitalLines = orderId => productLines(orderId).filter(item => plainDigital(item.productId))
// Whether every product line of a Shop order is plain digital (OrderApprovedSendEmail does not run for it: its payment's
// approval is its approval, and the invoice's receipt and the download notice follow; design-shop §8.3).
function allDigitalShopOrder(orderId) {
    if (!checkoutOf(orderId)) return false
    const lines = productLines(orderId)
    return lines.length > 0 && lines.every(item => plainDigital(item.productId))
}
// The files a product delivers: its current PcntDownload contents.
const downloadContents = productId =>
    rows("mantle.product.ProductContent", {productId, productContentTypeEnumId: "PcntDownload"})
        .filter(row => lib.active(row) && row.contentLocation)
        .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))

// ===== fulfillment =====
// fulfill#ShopOrder (the ShopOrderApprovedFulfillDigital SECA, the job): an approved Shop order's digital lines get their
// fulfillment rows, then advance. A non-Shop order, or one with no digital line, is left as it is.
function fulfillOrder(p) {
    const order = one("mantle.order.OrderHeader", {orderId: p.orderId})
    const checkout = order ? checkoutOf(order.orderId) : null
    if (!checkout || !approvedOrderStatuses.includes(order.statusId)) return {fulfilled: false}
    const lines = digitalLines(order.orderId)
    if (!lines.length) return {fulfilled: false}
    if (rows(F, {orderId: order.orderId}).length < lines.length) {
        const prepared = step("prepare", {orderId: order.orderId})
        if (prepared.error)
            ec.logger.error("Shop fulfillment of order " + order.orderId + " not prepared: " + firstLine(prepared.error))
    }
    return advance(order.orderId)
}
// Each step not yet done, in order; one that fails is recorded on the rows (with the next try) and stops this run.
function advance(orderId) {
    const order = () => rows(F, {orderId}).filter(row => row.stepEnumId !== "SifRevoked")
    const run = (name, needed) => {
        if (!needed()) return true
        const done = step(name, {orderId})
        if (done.error) {
            ec.logger.warn("Shop fulfillment of order " + orderId + " step " + name + ": " + firstLine(done.error))
            step("failed", {orderId, message: firstLine(done.error)})
            return false
        }
        if (name === "capture" && done.result.wait) step("captureOutcome", {orderId, statusId: done.result.statusId})
        return !done.result.wait
    }
    const pending = order()
    if (!pending.length) return {fulfilled: false}
    const ok =
        run("capture", () => order().some(row => !row.invoicedDate)) &&
        run("invoice", () => order().some(row => !row.invoicedDate)) &&
        run("finalize", () => order().some(row => !row.paidDate)) &&
        run("complete", () => order().some(row => !row.completedDate))
    if (ok && order().some(row => row.completedDate && !row.noticeDate)) notify(orderId)
    const rowsNow = order()
    return {fulfilled: rowsNow.length > 0 && rowsNow.every(row => row.stepEnumId === "SifCompleted")}
}
// prepare: a row per digital line (the order's Shop checkout names the store, site and recipient).
function prepareStep(p) {
    const checkout = checkoutOf(p.orderId)
    for (const item of digitalLines(p.orderId))
        if (!one(F, {orderId: p.orderId, orderItemSeqId: item.orderItemSeqId}))
            call("create#" + F, {
                orderId: p.orderId,
                orderItemSeqId: item.orderItemSeqId,
                orderPartSeqId: item.orderPartSeqId,
                productId: item.productId,
                productStoreId: checkout.productStoreId,
                siteId: checkout.siteId,
                recipientPartyId: checkout.customerPartyId,
                paymentId: checkout.paymentId || null,
                stepEnumId: "SifPending",
                tries: 0,
                createdDate: ec.user.nowTimestamp
            })
    return {}
}
const lockRows = orderId => Array.from(find(F, {orderId}).forUpdate(true).list()).filter(row => row.stepEnumId !== "SifRevoked")
const setRows = (list, values) => {
    for (const row of list) call("update#" + F, Object.assign({fulfillmentId: row.fulfillmentId}, values))
}
// capture: the checkout's payment captured in full in a transaction that holds only it (no provider is asked while an
// invoice, the order or the rows are held; one capture of an authorization is what a provider allows, so a mixed order's
// physical part applies the captured payment at its invoice), with the payment's operation key so a retry asks nothing new.
// Captured already, or nothing due: on. Not captured: the rows are held or wait (captureOutcome).
function captureStep(p) {
    const paymentId = rows(F, {orderId: p.orderId}).find(row => row.paymentId)?.paymentId
    if (!paymentId) return {}
    const payment = find(P, {paymentId}).forUpdate(true).one()
    if (paidStatuses.includes(payment.statusId)) return {}
    if (payment.statusId !== "PmntAuthorized") return {wait: true, statusId: payment.statusId}
    attempts().asAttempt(paymentId, () =>
        call("mantle.account.PaymentServices.capture#SinglePayment", {paymentId, operationKey: "shop-capture-" + paymentId})
    )
    const after = one(P, {paymentId})
    return paidStatuses.includes(after.statusId) ? {} : {wait: true, statusId: after.statusId}
}
// A capture that did not succeed: declined (or the payment not capturable) holds the rows, which grant nothing; one whose
// outcome is not known yet waits for the job.
function captureOutcomeStep(p) {
    const list = lockRows(p.orderId).filter(row => !row.invoicedDate)
    const declined = ["PmntDeclined", "PmntVoid", "PmntCancelled", "PmntPromised"].includes(p.statusId)
    for (const row of list)
        call("update#" + F, {
            fulfillmentId: row.fulfillmentId,
            stepEnumId: declined ? "SifHeld" : "SifPending",
            tries: Number(row.tries || 0) + 1,
            failureCode: declined ? "CAPTURE_DECLINED" : "CAPTURE_PENDING",
            failureMessage: declined ? "The payment was not captured" : "The capture's outcome is not known yet",
            nextTryDate: new Date(nowMs() + limits.backoffMinutes[declined ? 2 : 0] * 60000)
        })
    return {}
}
// invoice: the digital lines (and their adjustments) invoiced once through the internal split of create#InvoiceFromSource;
// an all-digital order's whole part. The captured payment applies to it.
function invoiceStep(p) {
    const list = lockRows(p.orderId).filter(row => !row.invoicedDate)
    if (!list.length) return {}
    const paymentId = list.find(row => row.paymentId)?.paymentId
    if (paymentId && !paidStatuses.includes(one(P, {paymentId}).statusId)) return {wait: true}
    const partSeqId = list[0].orderPartSeqId
    const all = productLines(p.orderId).filter(item => item.orderPartSeqId === partSeqId)
    const ids = list.map(row => row.orderItemSeqId)
    const whole = all.every(item => ids.includes(item.orderItemSeqId))
    const invoiceId = call(
        "mantle.account.InvoiceServices.create#FulfillmentInvoice",
        Object.assign({orderId: p.orderId, orderPartSeqId: partSeqId}, whole ? {} : {orderItemSeqIds: ids})
    ).invoiceId
    setRows(list, {
        invoiceId,
        invoicedDate: ec.user.nowTimestamp,
        stepEnumId: "SifInvoiced",
        failureCode: null,
        failureMessage: null
    })
    return {invoiceId}
}
// finalize: the invoice finalized (its receipt email), and settled: fully paid by the captured payment, else held.
function finalizeStep(p) {
    const list = lockRows(p.orderId).filter(row => row.invoicedDate && !row.paidDate)
    if (!list.length) return {}
    const invoiceId = list[0].invoiceId
    let invoice = find("mantle.account.invoice.Invoice", {invoiceId}).forUpdate(true).one()
    if (invoice.statusId === "InvoiceInProcess") {
        call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceFinalized"})
        invoice = one("mantle.account.invoice.Invoice", {invoiceId})
    }
    const totals = call("mantle.account.InvoiceServices.get#InvoiceTotal", {invoiceId})
    if (dec(totals.unpaidTotal).compare(0) > 0) {
        setRows(list, {stepEnumId: "SifHeld", failureCode: "NOT_SETTLED", failureMessage: "The invoice is not paid"})
        return {wait: true}
    }
    setRows(list, {paidDate: ec.user.nowTimestamp, stepEnumId: "SifPaid", failureCode: null, failureMessage: null})
    return {}
}
// complete: the part checked complete, then a grant per downloadable file of each line, once.
function completeStep(p) {
    const list = lockRows(p.orderId).filter(row => row.paidDate && !row.completedDate)
    if (!list.length) return {}
    for (const partSeqId of new Set(list.map(row => row.orderPartSeqId)))
        call("mantle.order.OrderServices.checkComplete#OrderPart", {orderId: p.orderId, orderPartSeqId: partSeqId})
    for (const row of list) {
        for (const content of downloadContents(row.productId))
            if (!one(G, {orderId: row.orderId, orderItemSeqId: row.orderItemSeqId, productContentId: content.productContentId}))
                call("create#" + G, {
                    fulfillmentId: row.fulfillmentId,
                    orderId: row.orderId,
                    orderItemSeqId: row.orderItemSeqId,
                    productId: row.productId,
                    productContentId: content.productContentId,
                    versionText: [content.sequenceNum != null ? "v" + content.sequenceNum : null, lib.dateText(content.fromDate)]
                        .filter(Boolean)
                        .join(" · ")
                        .slice(0, 60),
                    recipientPartyId: row.recipientPartyId,
                    productStoreId: row.productStoreId,
                    siteId: row.siteId,
                    fromDate: ec.user.nowTimestamp,
                    downloadCount: 0,
                    createdDate: ec.user.nowTimestamp
                })
        call("update#" + F, {
            fulfillmentId: row.fulfillmentId,
            completedDate: ec.user.nowTimestamp,
            stepEnumId: "SifCompleted",
            failureCode: null,
            failureMessage: null
        })
    }
    return {}
}
// failed: the rows' tries counted and the next try set (backoff); past the tries they wait for staff.
function failedStep(p) {
    const list = lockRows(p.orderId).filter(row => row.stepEnumId !== "SifCompleted")
    for (const row of list) {
        const tries = Number(row.tries || 0) + 1
        call("update#" + F, {
            fulfillmentId: row.fulfillmentId,
            tries,
            failureCode: /^([A-Z][A-Z0-9_]+):/.exec(text(p.message))?.[1] || "FULFILLMENT_FAILED",
            failureMessage: text(p.message).slice(0, 255),
            nextTryDate:
                tries >= limits.tries
                    ? null
                    : new Date(nowMs() + limits.backoffMinutes[Math.min(tries - 1, limits.backoffMinutes.length - 1)] * 60000)
        })
    }
    return {}
}

// ===== the download-ready notice =====
// The order's notice on the delivery ledger (one per order and recipient), sent at once; a store with no download email
// sends none. The rows are marked handed off either way.
function notify(orderId) {
    const checkout = checkoutOf(orderId)
    const email = rows("mantle.product.store.ProductStoreEmail", {
        productStoreId: checkout.productStoreId,
        emailTypeEnumId: "PsetDownloadReady"
    }).find(row => lib.active(row) && row.emailTemplateId)
    if (email && checkout.contactEmail) {
        try {
            call("mantle.party.MessageServices.queue#Delivery", {
                eventKey: "shopDownloads:" + orderId,
                sourceEnumId: "MdsrcShopDownloads",
                recipientPartyId: checkout.customerPartyId,
                toAddress: checkout.contactEmail,
                templateKey: email.emailTemplateId,
                siteId: checkout.siteId,
                productStoreId: checkout.productStoreId,
                transactional: true,
                sendNow: true
            })
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Shop download notice of order " + orderId + " not queued: " + firstLine(error.message))
            return
        }
    }
    step("noticed", {orderId})
}
function noticedStep(p) {
    setRows(
        lockRows(p.orderId).filter(row => row.completedDate && !row.noticeDate),
        {noticeDate: ec.user.nowTimestamp}
    )
    return {}
}
// build#DownloadNotice (the ledger's source build): the notice's parameters, made fresh for each attempt: the order, its
// files, and where to download them (a guest's link with a new SalesOrder capability, OrderView and Download, its token
// only in this message; a signed-in buyer's Downloads page). None left to download: suppressed.
function buildNotice(p) {
    const orderId = text(p.eventKey).replace(/^shopDownloads:/, "")
    const checkout = checkoutOf(orderId)
    if (!checkout) return {suppress: "The order is not a Shop order"}
    const grants = rows(G, {orderId}).filter(row => !row.revokedDate)
    if (!grants.length) return {suppress: "Nothing is left to download"}
    let downloadsUrl
    if (checkout.accountCheckout === "Y") downloadsUrl = publicApps().pageUrl(checkout.siteId, "shop", "/Downloads")
    else {
        const link = externalAccess().create({
            recordType: "SalesOrder",
            recordId: orderId,
            scopes: "OrderView,Download",
            validDays: limits.linkDays,
            issuerKind: "organization"
        })
        downloadsUrl = publicApps().pageUrl(checkout.siteId, "shop", "/Orders/Status?token=" + encodeURIComponent(link.token))
    }
    const store = one("mantle.product.store.ProductStore", {productStoreId: checkout.productStoreId})
    return {
        toAddress: checkout.contactEmail,
        bodyParameters: {
            title: "Your downloads are ready",
            orderId,
            storeName: store?.storeName || "",
            files: grants
                .map(
                    row =>
                        one("mantle.product.ProductContent", {productContentId: row.productContentId})?.description ||
                        row.productId
                )
                .join(", "),
            downloadsUrl
        }
    }
}

// ===== jobs =====
// fulfill#StoreItems (the fulfill_StoreItems job): orders whose digital lines are not all done and are due a try, each
// order on its own; one that fails is named and the rest go on. A held row is tried again only to see its payment settled
// (its capture is never sent again with a new key).
function fulfillDue(p) {
    const due = Array.from(
        find(F)
            .condition("stepEnumId", "in", openSteps)
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("nextTryDate", "is-null", null),
                        ec.entity.conditionFactory.makeCondition("nextTryDate", "less-equals", ec.user.nowTimestamp)
                    ],
                    "or"
                )
            )
            .condition("tries", "less", limits.tries)
            .orderBy("createdDate")
            .limit(Number(p.limit || limits.batch))
            .list()
    )
    let orders = 0,
        fulfilled = 0,
        failed = 0
    for (const orderId of new Set(due.map(row => row.orderId))) {
        orders++
        try {
            if (fulfillOrder({orderId}).fulfilled) fulfilled++
        } catch (error) {
            ec.message.clearErrors()
            failed++
            ec.logger.error("Shop fulfillment of order " + orderId + " failed: " + firstLine(error.message))
        }
    }
    return {orders, fulfilled, failed}
}

// ===== downloads =====
const shopOf = p => catalog().shopOf(p)
const activeGrant = row =>
    !!row && !row.revokedDate && (ms(row.fromDate) ?? 0) <= nowMs() && (ms(row.thruDate) ?? Infinity) > nowMs()
// What a call reaches: the guest's order link with the Download scope (its one order), else the signed-in verified buyer's
// own grants in this store (the self relationship). {shop, orderId, partyId, via}.
function reachDownloads(p) {
    const shop = shopOf(p)
    if (text(p.orderToken)) {
        const checked = externalAccess().check({
            token: text(p.orderToken),
            scope: "Download",
            recordType: "SalesOrder",
            organizationPartyId: shop.store.organizationPartyId
        })
        const checkout = checkoutOf(checked.recordId)
        if (!checkout || checkout.siteId !== shop.siteId) notAvailable()
        return {shop, orderId: checked.recordId, partyId: checked.partyId, via: "orderLink"}
    }
    const partyId = ec.user.userAccount?.partyId
    if (!partyId || !externalAccess().selfOf(partyId))
        refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in with a verified email address to see your downloads")
    return {shop, orderId: null, partyId, via: "self"}
}
function grantsReached(reached) {
    const found = reached.orderId
        ? rows(G, {orderId: reached.orderId})
        : rows(G, {recipientPartyId: reached.partyId, productStoreId: reached.shop.productStoreId})
    return found
        .filter(row => row.productStoreId === reached.shop.productStoreId && row.recipientPartyId === reached.partyId)
        .sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))
}
// A file's public facts: its name, type and size (from the resource), never its location.
function fileOf(content) {
    const location = content?.contentLocation
    if (!location) return null
    const filename = String(location).split("/").pop()
    let size = null
    let mimeType = null
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const reference = ec.resource.getLocationReference(location)
        size = Number(reference.getSize())
        mimeType = reference.getContentType()
    } catch (error) {
        size = null
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
    return {filename, mimeType: mimeType || ec.resource.contentTypeOf(filename) || "application/octet-stream", size}
}
// get#Downloads (DownloadList): the reached grants with the product, order, file, version, dates and availability.
function getDownloads(p) {
    const reached = reachDownloads(p)
    const list = grantsReached(reached).slice(0, 200)
    return {
        downloads: list.map(row => {
            const content = one("mantle.product.ProductContent", {productContentId: row.productContentId})
            const file = fileOf(content)
            const product = one("mantle.product.Product", {productId: row.productId})
            return {
                downloadGrantId: row.downloadGrantId,
                orderId: row.orderId,
                productName: product?.productName || row.productId,
                fileName: content?.description || file?.filename || "",
                versionText: row.versionText || "",
                sizeText: file?.size != null ? ec.l10n.format(Math.max(1, Math.round(file.size / 1024)), "#,##0") + " KB" : "",
                grantedText: lib.dateText(row.fromDate),
                untilText: row.thruDate ? lib.dateText(row.thruDate) : "",
                available: activeGrant(row) && !!file,
                stateText: row.revokedDate
                    ? one("moqui.basic.Enumeration", {enumId: row.revokeReasonEnumId})?.description || "Ended"
                    : activeGrant(row)
                      ? "Available"
                      : "Not available"
            }
        }),
        via: reached.via
    }
}
function grantOf(reached, downloadGrantId) {
    const row = text(downloadGrantId) ? one(G, {downloadGrantId: text(downloadGrantId)}) : null
    if (!row || !grantsReached(reached).some(grant => grant.downloadGrantId === row.downloadGrantId)) notAvailable()
    const fulfillment = row.fulfillmentId ? one(F, {fulfillmentId: row.fulfillmentId}) : null
    if (!activeGrant(row) || !fulfillment || fulfillment.stepEnumId !== "SifCompleted") notAvailable()
    return row
}
// issue#Download (DownloadAction): a capability of ten minutes for one reached grant (SalesOrder, Download, the grant's
// order), rate limited by requester; the page streams the file with it at once.
function issueDownload(p) {
    externalAccess().throttle("shop-download", 60, "Wait a few minutes before downloading again")
    const reached = reachDownloads(p)
    const grant = grantOf(reached, p.downloadGrantId)
    const minutes = Math.min(limits.downloadMinutes, Math.max(1, Number(p.minutes || limits.downloadMinutes)))
    const made = externalAccess().create({
        recordType: "SalesOrder",
        recordId: grant.orderId,
        scopes: "Download",
        thruDate: new Date(nowMs() + minutes * 60000),
        issuerKind: "organization"
    })
    return {downloadGrantId: grant.downloadGrantId, downloadToken: made.token, expiresText: lib.dateText(made.thruDate)}
}
// get#DownloadFile: the capability and the grant checked again (a revoked grant or an expired capability reaches nothing),
// the use counted, and the file's location for the transport to stream (it stays on the server), with the range asked
// (bytes=start-end) when it is within the file.
function getDownloadFile(p) {
    const shop = shopOf(p)
    const grantRow = text(p.downloadGrantId) ? one(G, {downloadGrantId: text(p.downloadGrantId)}) : null
    if (!grantRow || grantRow.productStoreId !== shop.productStoreId) notAvailable()
    const checked = externalAccess().check({
        token: text(p.downloadToken),
        scope: "Download",
        recordType: "SalesOrder",
        recordId: grantRow.orderId,
        organizationPartyId: shop.store.organizationPartyId
    })
    const grant = grantOf({shop, orderId: checked.recordId, partyId: checked.partyId}, grantRow.downloadGrantId)
    const content = one("mantle.product.ProductContent", {productContentId: grant.productContentId})
    const file = fileOf(content)
    if (!file) notAvailable()
    call("update#" + G, {
        downloadGrantId: grant.downloadGrantId,
        downloadCount: Number(grant.downloadCount || 0) + 1,
        lastDownloadDate: ec.user.nowTimestamp
    })
    const range = rangeOf(p.range, file.size)
    return {
        location: content.contentLocation,
        file: {
            mimeType: file.mimeType,
            filename:
                content.description && /\.[A-Za-z0-9]{1,8}$/.test(content.description) ? content.description : file.filename,
            size: file.size,
            ranged: true
        },
        range
    }
}
// A single byte range of a file of size bytes, or null (the whole file).
function rangeOf(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(text(value))
    if (!match || size == null || !(size > 0)) return null
    let start = match[1] === "" ? null : Number(match[1])
    let end = match[2] === "" ? null : Number(match[2])
    if (start == null && end == null) return null
    if (start == null) {
        start = Math.max(0, size - end)
        end = size - 1
    } else if (end == null || end >= size) end = size - 1
    if (start > end || start >= size) return {unsatisfiable: true, size}
    return {start, end, size}
}

// ===== refunds =====
// reconcile#RefundedItem: the grants a refund, a return's settlement or a chargeback leaves unpaid end (their fulfillment
// revoked): a returned digital line's (returnId: its settled return items), a named line (orderItemSeqId), a cancelled line,
// and every digital line of an order whose payment no longer covers them (paymentId: what is kept after refunds is less
// than the digital lines' total). Independent access (another order, a manual grant) is not touched. {revoked}.
function reconcileRefunded(p) {
    const reason = p.reasonEnumId || (p.returnId ? "SdrReturned" : "SdrRefunded")
    const targets = new Map()
    const add = (orderId, orderItemSeqId) => {
        if (orderId && orderItemSeqId && one(F, {orderId, orderItemSeqId}))
            targets.set(orderId + ":" + orderItemSeqId, {orderId, orderItemSeqId})
    }
    if (p.returnId)
        for (const item of rows("mantle.order.return.ReturnItem", {returnId: p.returnId}))
            if (
                item.orderId &&
                item.orderItemSeqId &&
                ["ReturnCompleted", "ReturnManualRefund"].concat(["ReturnReceived"]).includes(item.statusId)
            )
                add(item.orderId, item.orderItemSeqId)
    if (p.orderId && p.orderItemSeqId) add(p.orderId, p.orderItemSeqId)
    const payment = p.paymentId ? one(P, {paymentId: p.paymentId}) : null
    const orderId = p.orderId || payment?.orderId
    if (orderId && checkoutOf(orderId)) {
        const fulfilled = rows(F, {orderId}).filter(row => row.stepEnumId !== "SifRevoked")
        // a cancelled line
        for (const row of fulfilled) {
            const item = one("mantle.order.OrderItem", {orderId, orderItemSeqId: row.orderItemSeqId})
            if (!item || dec(item.quantity).compare(0) <= 0) add(orderId, row.orderItemSeqId)
        }
        // the order's payment no longer covering its digital lines
        if (payment && fulfilled.length) {
            const refunded = rows(P, {refundForPaymentId: payment.paymentId})
                .filter(row => !["PmntDeclined", "PmntCancelled", "PmntVoid"].includes(row.statusId))
                .reduce((sum, row) => sum.add(dec(row.amount)), dec(0))
            const kept = dec(payment.amount).subtract(refunded)
            const digitalTotal = fulfilled.reduce((sum, row) => sum.add(lineTotal(orderId, row.orderItemSeqId)), dec(0))
            if (kept.compare(digitalTotal) < 0) for (const row of fulfilled) add(orderId, row.orderItemSeqId)
        }
    }
    let revoked = 0
    for (const target of targets.values()) {
        for (const grant of rows(G, target))
            if (!grant.revokedDate) {
                call("update#" + G, {
                    downloadGrantId: grant.downloadGrantId,
                    revokedDate: ec.user.nowTimestamp,
                    revokeReasonEnumId: reason
                })
                revoked++
            }
        const row = one(F, target)
        if (row && row.stepEnumId !== "SifRevoked")
            call("update#" + F, {fulfillmentId: row.fulfillmentId, stepEnumId: "SifRevoked", revokedDate: ec.user.nowTimestamp})
    }
    return {revoked}
}
// A line's total with its adjustments (discounts, tax).
function lineTotal(orderId, orderItemSeqId) {
    return rows("mantle.order.OrderItem", {orderId})
        .filter(item => item.orderItemSeqId === orderItemSeqId || item.parentItemSeqId === orderItemSeqId)
        .reduce((sum, item) => sum.add(dec(item.quantity ?? 1).multiply(dec(item.unitAmount))), dec(0))
}

const steps = {
    prepare: prepareStep,
    capture: captureStep,
    captureOutcome: captureOutcomeStep,
    invoice: invoiceStep,
    finalize: finalizeStep,
    complete: completeStep,
    failed: failedStep,
    noticed: noticedStep
}
const operations = {
    fulfillOrder,
    fulfillDue,
    buildNotice,
    getDownloads,
    issueDownload,
    getDownloadFile,
    reconcileRefunded,
    approvedEmailSkipped: p => ({skip: allDigitalShopOrder(p.orderId)}),
    runStep: p => {
        if (!steps[p.step]) throw new Error("Unknown Shop fulfillment step " + p.step)
        return steps[p.step](p) || {}
    }
}
;({
    limits,
    allDigitalShopOrder,
    digitalLines,
    plainDigital,
    rangeOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown Shop fulfillment operation " + op)
        return operations[op](parameters || {})
    }
})
