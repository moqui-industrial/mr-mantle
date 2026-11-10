/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The staff part of ShopSubscriptionServices (impl-commerce P12, COM-SUBSCRIPTION; design-commerce §4 Product360 paid
 * access, §6 Subscriptions and SubscriptionDetail, §8 RecurringPolicy), over Shop P7's records and coordinator
 * (ShopSubscriptions.js):
 * - find#StoreSubscriptions and get#StoreSubscription: the stores' recurring contracts with their renewals and the access
 *   each paid term gave, billing and access apart; the store optional (Sales' later mount); COMMERCE_ORDER_VIEW (or
 *   COMMERCE_SUBSCRIPTION_MANAGE). The method is masked (type and last four); no consent evidence, provider profile or
 *   gateway is returned.
 * - cancel#RecurringContract: future renewals stopped at the contract's revision, the paid term kept (no refund: that is
 *   Accounting's); retry#Renewal: a failed or waiting renewal tried again through the coordinator (the same occurrence,
 *   one charge), keyed by an operation (a double submit answers the first result) and refused while a payment is in flight
 *   or with no recorded consent (staff never enter a card); both COMMERCE_SUBSCRIPTION_MANAGE.
 * - get#ProductPaidAccess and store#ProductSubscriptionResource: Product360's Paid access pane (X16), the product's
 *   ProductSubscriptionResource rows with their resources' handlers read only; a change ends the row in effect and starts
 *   the next, so it applies to later purchases (each Subscription keeps its own terms); only a resource whose handler
 *   services are installed; removing one with live subscriptions refused naming the count. Edits need
 *   COMMERCE_SUBSCRIPTION_MANAGE and the product sold in the user's stores only (PRODUCT_SHARED when another sells it).
 * - find#RecurringOffers: CheckoutSettings' RecurringPolicy (COMMERCE_VIEW and the store), saved through store#RecurringOffer.
 * Every operation checks COMMERCE_VIEW and StoreAdmin.js's store scope (the user's organizations; a store-limited staff
 * member's own stores); a record outside it and a missing one are refused alike (RECORD_UNAVAILABLE). Reads below the
 * checks run without artifact authorization.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const shop = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopSubscriptions.js")
const {find, one, rows, denied, call, ms, dateText, access} = lib

const SUB = "mantle.product.subscription."
const OFFER = SUB + "StoreRecurringOffer"
const CONTRACT = SUB + "StoreRecurringContract"
const OCC = SUB + "StoreRenewalOccurrence"
const SUBSCRIPTION = SUB + "Subscription"
const PSR = SUB + "ProductSubscriptionResource"
const RESOURCE = SUB + "SubscriptionResource"
const STORE = "mantle.product.store.ProductStore"

// ===== tables =====
const limits = {candidates: 500, detail: 36, access: 50, offers: 50, resources: 100}
// the handler services a SubscriptionResource names, each installed when given; init is required
const handlerFields = {
    initServiceName: "Start",
    renewServiceName: "Renew",
    revokeAccessServiceName: "Revoke",
    restoreAccessServiceName: "Restore",
    destroyServiceName: "Destroy"
}
// the fields of a ProductSubscriptionResource the pane edits (design-commerce §4 PaidAccess's complete list)
const termFields = [
    "thruDate",
    "purchaseFromDate",
    "purchaseThruDate",
    "availableTime",
    "availableTimeUomId",
    "useCountLimit",
    "useTime",
    "useTimeUomId",
    "useRoleTypeId"
]
const renewalStates = ["SrsRetry", "SrsActionRequired", "SrsFailed"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const yes = value => value === true || value === "true" || value === "Y"
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.description || uomId : "")
const moneyText = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const productName = productId => (productId ? one("mantle.product.Product", {productId})?.productName || productId : "")
const storeName = productStoreId => one(STORE, {productStoreId})?.storeName || productStoreId || ""
function partyName(partyId) {
    if (!partyId) return ""
    const person = one("mantle.party.Person", {partyId})
    const name = person ? [person.firstName, person.lastName].filter(Boolean).join(" ") : ""
    return name || one("mantle.party.Organization", {partyId})?.organizationName || partyId
}
// a payment method as staff see it: its type and last four, nothing of the provider's profile
function methodLabel(paymentMethodId) {
    const method = paymentMethodId ? one("mantle.account.method.PaymentMethod", {paymentMethodId}) : null
    if (!method) return ""
    const card = one("mantle.account.method.CreditCard", {paymentMethodId})
    const last4 = card?.cardNumber ? String(card.cardNumber).replace(/\D/g, "").slice(-4) : ""
    const kind = card?.creditCardTypeEnumId ? enumText(card.creditCardTypeEnumId) : enumText(method.paymentMethodTypeEnumId)
    return [kind || "Card", last4 ? "ending " + last4 : "", method.thruDate ? "(ended)" : ""].filter(Boolean).join(" ")
}
function dateParam(value, label) {
    if (value == null || value === "") return null
    const at = ms(value)
    if (at == null || Number.isNaN(at)) denied("VALUE_INVALID", "Give " + label + " as a date")
    return new Date(at)
}
function wholeParam(value, label) {
    if (value == null || value === "") return null
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) denied("VALUE_INVALID", label + " is a whole number of at least 1")
    return number
}

// ===== scope =====
// COMMERCE_VIEW and the store scope; "read" adds COMMERCE_ORDER_VIEW (or COMMERCE_SUBSCRIPTION_MANAGE), "manage"
// COMMERCE_SUBSCRIPTION_MANAGE. The user's stores by id (storeIds).
function scope(need = "read") {
    const s = stores.scope("view")
    s.canManage = access.has("COMMERCE_SUBSCRIPTION_MANAGE")
    if (need === "manage" && !s.canManage) denied("PERMISSION_DENIED", "COMMERCE_SUBSCRIPTION_MANAGE is required")
    if (need === "read" && !s.canManage && !access.has("COMMERCE_ORDER_VIEW"))
        denied("PERMISSION_DENIED", "COMMERCE_ORDER_VIEW is required")
    s.storeIds = Array.from(stores.storeQuery(s).selectField("productStoreId").orderBy("productStoreId").list()).map(
        row => row.productStoreId
    )
    return s
}
function contractOf(s, contractId, forUpdate = false) {
    const row = text(contractId)
        ? find(CONTRACT, {contractId: text(contractId)})
              .forUpdate(forUpdate)
              .one()
        : null
    if (!row || !s.storeIds.includes(row.productStoreId))
        denied("RECORD_UNAVAILABLE", "Subscription " + text(contractId) + " is not available")
    return row
}
// A product the user may bind to paid access: in the current or coming assortment of one of their stores, and of no store
// outside their scope, since its paid access is the product's own and every store selling it grants what it says (P12
// review R2: a store-limited member, or another organization sharing the product, never changes a store they do not work).
function productStoreIds(productId) {
    return rows("mantle.product.store.ProductStoreProduct", {productId})
        .filter(row => row.publicationKindEnumId !== "PspkExcluded" && (row.thruDate == null || ms(row.thruDate) > nowMs()))
        .map(row => row.productStoreId)
}
function productOf(s, productId) {
    const product = text(productId) ? one("mantle.product.Product", {productId: text(productId)}) : null
    const storeIds = product ? productStoreIds(product.productId) : []
    if (!storeIds.some(storeId => s.storeIds.includes(storeId)))
        denied("RECORD_UNAVAILABLE", "Product " + text(productId) + " is not available")
    if (storeIds.some(storeId => !s.storeIds.includes(storeId)))
        denied(
            "PRODUCT_SHARED",
            "Product " +
                product.productId +
                " is also sold in a store you do not work; its paid access is changed by staff of all its stores"
        )
    return product
}

// ===== contracts =====
const latestOccurrence = contractId => Array.from(find(OCC, {contractId}).orderBy("-periodStartDate").limit(1).list())[0] || null
// The list's row: billing (the contract's state, next charge) and access (whether a paid term is current) apart.
function contractRow(contract) {
    const subs = shop().subscriptionsOf(contract.contractId)
    const hasAccess = subs.some(shop().accessActive)
    const renews = contract.autoRenew === "Y" && shop().renewableStates.includes(contract.stateEnumId)
    const latest = latestOccurrence(contract.contractId)
    return {
        contractId: contract.contractId,
        productStoreId: contract.productStoreId,
        storeName: storeName(contract.productStoreId),
        customerPartyId: contract.customerPartyId,
        customerName: partyName(contract.customerPartyId),
        productId: contract.productId,
        productName: productName(contract.productId),
        planText:
            (contract.autoRenew === "Y" ? "Renews every " : "Prepaid ") +
            shop().termText(shop().termOf(contract.productId, contract.subscriptionResourceId)),
        paidThroughText: dateText(contract.paidThroughDate),
        nextChargeText: renews ? dateText(contract.nextRenewalDate) : "",
        amountText: moneyText(contract.priceAmount ?? 0, contract.currencyUomId),
        billingText: shop().stateTexts[contract.stateEnumId] || enumText(contract.stateEnumId),
        billingState: contract.stateEnumId,
        accessText: hasAccess ? "Access" : "No access now",
        hasAccess,
        outcomeText: latest ? enumText(latest.stateEnumId) : "",
        actionNeeded: !!latest && shop().reopenable(contract, latest)
    }
}
// find#StoreSubscriptions (Subscriptions; ResourceUse with a product): the contracts of the user's stores or one, by
// customer, product, resource, state and next renewal, newest first.
function findStoreSubscriptions(p) {
    const s = scope("read")
    let storeIds = s.storeIds
    if (text(p.productStoreId)) {
        stores.storeOf(s, text(p.productStoreId))
        storeIds = [text(p.productStoreId)]
    }
    if (!storeIds.length) return lib.pageList([], p, "subscriptions")
    let query = find(CONTRACT).condition("productStoreId", "in", storeIds)
    for (const field of ["customerPartyId", "productId", "subscriptionResourceId", "stateEnumId"])
        if (text(p[field])) query = query.condition(field, text(p[field]))
    const from = dateParam(p.renewalFromDate, "the renewal period's start")
    const thru = dateParam(p.renewalThruDate, "the renewal period's end")
    if (from) query = query.condition("nextRenewalDate", "greater-equals", from)
    if (thru) query = query.condition("nextRenewalDate", "less", thru)
    const contracts = Array.from(query.orderBy("-createdDate").limit(limits.candidates).list())
    const page = lib.pageList(contracts, p, "subscriptions")
    page.subscriptions = page.subscriptions.map(contractRow)
    page.truncated = contracts.length >= limits.candidates
    return page
}
// The contract's renewals, newest first: period, order, payment, attempts, state, next retry, its safe failure.
function occurrenceRow(contract, row) {
    const payment = row.paymentId ? one("mantle.account.payment.Payment", {paymentId: row.paymentId}) : null
    return {
        occurrenceId: row.occurrenceId,
        periodText: dateText(row.periodStartDate),
        orderId: row.orderId || null,
        invoiceId: row.invoiceId || null,
        paymentId: row.paymentId || null,
        paymentText: payment ? one("moqui.basic.StatusItem", {statusId: payment.statusId})?.description || payment.statusId : "",
        attemptCount: Number(row.attemptCount || 0),
        stateEnumId: row.stateEnumId,
        stateText: enumText(row.stateEnumId),
        nextRetryText: row.stateEnumId === "SrsRetry" ? dateText(row.nextRetryDate) : "",
        failureText: row.failureCode ? [row.failureCode, row.failureMessage].filter(Boolean).join(": ") : "",
        retryable: shop().reopenable(contract, row)
    }
}
// get#StoreSubscription (SubscriptionDetail: Contract, Renewals, Access, CancelRenewal, RetryRenewal).
function getStoreSubscription(p) {
    const s = scope("read")
    const contract = contractOf(s, p.contractId)
    const offer = contract.offerId ? one(OFFER, {offerId: contract.offerId}) : null
    const term = shop().termOf(contract.productId, contract.subscriptionResourceId)
    const renews = contract.autoRenew === "Y" && shop().renewableStates.includes(contract.stateEnumId)
    const consented = shop().consentHolds(contract)
    const renewals = Array.from(
        find(OCC, {contractId: contract.contractId}).orderBy("-periodStartDate").limit(limits.detail).list()
    ).map(row => occurrenceRow(contract, row))
    const inFlight = renewals.some(row => ["SrsCharging", "SrsPlaced"].includes(row.stateEnumId))
    const accessRows = shop()
        .subscriptionsOf(contract.contractId)
        .slice(-limits.access)
        .reverse()
        .map(sub => ({
            subscriptionId: sub.subscriptionId,
            resourceText:
                one(RESOURCE, {subscriptionResourceId: sub.subscriptionResourceId})?.description || sub.subscriptionResourceId,
            fromText: dateText(sub.fromDate),
            thruText: dateText(sub.thruDate),
            orderId: sub.orderId || null,
            stateText: sub.accessRevokedDate
                ? "Revoked " + dateText(sub.accessRevokedDate)
                : shop().accessActive(sub)
                  ? "Current"
                  : (ms(sub.fromDate) ?? 0) > nowMs()
                    ? "Starts later"
                    : "Ended"
        }))
    return {
        subscription: Object.assign(contractRow(contract), {
            revision: String(contract.revision || 1),
            offerName: offer?.offerName || productName(contract.productId),
            termText: shop().termText(term),
            autoRenew: contract.autoRenew === "Y",
            termsVersion: contract.termsVersion || "",
            originOrderId: contract.originOrderId || null,
            baseOrderId: contract.baseOrderId || null,
            createdText: dateText(contract.createdDate),
            cancelAtText: dateText(contract.cancelAtDate),
            cancelText: contract.cancelDate
                ? dateText(contract.cancelDate) + (contract.cancelReason ? " · " + contract.cancelReason : "")
                : "",
            methodText: methodLabel(contract.paymentMethodId),
            consentText:
                contract.autoRenew !== "Y"
                    ? "A prepaid term: nothing is charged off-session"
                    : consented
                      ? "Recorded on " +
                        dateText(contract.consentDate) +
                        " for this card (terms " +
                        (contract.consentTermsVersion || "1") +
                        ")"
                      : "Not recorded" +
                        (contract.consentEndedReason ? " (" + contract.consentEndedReason + ")" : "") +
                        ": the customer chooses a card in Shop",
            consentHolds: consented,
            canCancel: s.canManage && renews && !inFlight,
            canRetry: s.canManage && renews && consented && !inFlight && renewals.some(row => row.retryable),
            inFlight
        }),
        renewals,
        access: accessRows
    }
}

// ===== staff actions =====
// cancel#RecurringContract (CancelRenewal): future renewals stopped at the contract's revision, its paid term kept;
// refused while a renewal payment is in flight (RENEWAL_IN_PROGRESS) and at a stale revision (STALE_REVISION).
function cancelRecurringContract(p) {
    const s = scope("manage")
    const contract = contractOf(s, p.contractId, true)
    if (text(p.expectedRevision) === "") denied("VALUE_INVALID", "Reload the subscription and try again")
    if (text(p.expectedRevision) !== String(contract.revision || 1))
        denied(
            "STALE_REVISION",
            "Subscription " + contract.contractId + " changed; its current revision is " + (contract.revision || 1)
        )
    if (contract.stateEnumId === "ScsCancelled") return getStoreSubscription(p)
    if (contract.autoRenew !== "Y" || !shop().renewableStates.includes(contract.stateEnumId))
        denied("NOT_RENEWING", "Subscription " + contract.contractId + " does not renew")
    shop().stopRenewal(contract, text(p.reason) || "Cancelled by staff", true)
    return getStoreSubscription(p)
}
// retry#Renewal (RetryRenewal): the contract's failed or waiting renewal (the occurrence given, or the one that can be
// tried again) tried again now through the coordinator, which charges the same occurrence once with the recorded consent;
// keyed by its operation (a retry of the request answers the first result); refused while a renewal payment is in flight
// (PAYMENT_UNRESOLVED: it is looked up by the job, never charged again), without the customer's recorded consent
// (CONSENT_REQUIRED) and when nothing can be tried again (NOTHING_TO_RETRY).
function retryRenewal(p) {
    const s = scope("manage")
    const contract = contractOf(s, p.contractId)
    const op = lib.operation(
        p,
        "StoreRenewalRetry",
        one(STORE, {productStoreId: contract.productStoreId})?.organizationPartyId || null,
        {
            contractId: contract.contractId,
            occurrenceId: text(p.occurrenceId) || null
        }
    )
    const again = lib.previous(op)
    if (again) return again
    if (contract.autoRenew !== "Y" || !shop().renewableStates.includes(contract.stateEnumId) || contract.cancelDate)
        denied("NOT_RENEWING", "Subscription " + contract.contractId + " does not renew")
    const occurrences = rows(OCC, {contractId: contract.contractId})
    if (occurrences.some(row => row.stateEnumId === "SrsPlaced" || (row.stateEnumId === "SrsCharging" && row.paymentId)))
        denied("PAYMENT_UNRESOLVED", "A renewal payment is still being processed; it is looked up, never charged again")
    const target = occurrences.find(
        row => shop().reopenable(contract, row) && (!text(p.occurrenceId) || row.occurrenceId === text(p.occurrenceId))
    )
    if (!target) denied("NOTHING_TO_RETRY", "Subscription " + contract.contractId + " has no renewal to try again")
    if (!shop().consentHolds(contract))
        denied("CONSENT_REQUIRED", "The customer has no recorded consent for a card; they choose one in Shop")
    // each step in its own transaction, this one holding no lock (Shop P7 review R3)
    shop().resumeWaiting(contract.contractId, target.occurrenceId)
    const after = one(OCC, {occurrenceId: target.occurrenceId})
    const answer = {
        contractId: contract.contractId,
        occurrenceId: target.occurrenceId,
        stateEnumId: after.stateEnumId,
        stateText: enumText(after.stateEnumId),
        attemptCount: Number(after.attemptCount || 0),
        message: "Renewal of " + dateText(after.periodStartDate) + ": " + enumText(after.stateEnumId)
    }
    lib.complete(op, OCC, target.occurrenceId, answer)
    return answer
}

// ===== paid access (Product360) =====
// A resource's handlers: each named service and whether it is installed; usable when init is named and every named one is.
function handlersOf(resource) {
    const handlers = Object.entries(handlerFields)
        .filter(([field]) => text(resource[field]))
        .map(([field, label]) => ({
            label,
            serviceName: text(resource[field]),
            installed: !!ec.service.getServiceDefinition(text(resource[field]))
        }))
    return {
        handlers,
        handlersText: handlers
            .map(row => row.label + ": " + row.serviceName + (row.installed ? "" : " (not installed)"))
            .join("; "),
        usable: !!text(resource.initServiceName) && handlers.every(row => row.installed)
    }
}
const termRowText = (count, uomId) =>
    count ? count + " " + uomText(uomId || "TF_mon").toLowerCase() + (Number(count) === 1 ? "" : "s") : ""
const liveCount = (productId, subscriptionResourceId) =>
    find(SUBSCRIPTION, {productId, subscriptionResourceId})
        .condition("accessRevokedDate", "is-null", null)
        .condition(
            ec.entity.conditionFactory.makeCondition(
                [
                    ec.entity.conditionFactory.makeCondition("thruDate", "is-null", null),
                    ec.entity.conditionFactory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                ],
                "or"
            )
        )
        .count()
// get#ProductPaidAccess (PaidAccess): the product's ProductSubscriptionResource rows, newest first, each with its resource's
// handlers read only and whether it is in effect, and the resources a row may name (installed handlers only). Products shows
// the rows read only (PRODUCT_CATALOG_VIEW); a Commerce user edits them with COMMERCE_SUBSCRIPTION_MANAGE for a product of
// their stores (canEdit).
function getProductPaidAccess(p) {
    if (!ec.user.userId || !(access.has("COMMERCE_VIEW") || access.has("PRODUCT_CATALOG_VIEW")))
        denied("PERMISSION_DENIED", "PRODUCT_CATALOG_VIEW or COMMERCE_VIEW is required")
    const product = text(p.productId) ? one("mantle.product.Product", {productId: text(p.productId)}) : null
    if (!product) denied("RECORD_UNAVAILABLE", "Product " + text(p.productId) + " is not available")
    const catalogScope = access.has("PRODUCT_CATALOG_VIEW")
            ? call("mantle.product.ProductServices.get#CatalogOwnerScope")
            : null,
        catalogRead =
            catalogScope &&
            (catalogScope.systemAdmin || catalogScope.ownerPartyIds.includes(product.ownerPartyId || "_NA_")),
        commerceScope = !catalogRead && access.has("COMMERCE_VIEW") ? scope("view") : null
    if (
        !catalogRead &&
        (!commerceScope || !productStoreIds(product.productId).some(id => commerceScope.storeIds.includes(id)))
    )
        denied("RECORD_UNAVAILABLE", "Product " + text(p.productId) + " is not available")
    let canEdit = false
    if (access.has("COMMERCE_VIEW") && access.has("COMMERCE_SUBSCRIPTION_MANAGE"))
        try {
            productOf(scope("manage"), product.productId)
            canEdit = true
        } catch (error) {
            ec.message.clearErrors()
        }
    const terms = Array.from(find(PSR, {productId: product.productId}).orderBy("-fromDate").limit(limits.resources).list()).map(
        row => {
            const resource = one(RESOURCE, {subscriptionResourceId: row.subscriptionResourceId}) || {}
            const handlers = handlersOf(resource)
            return {
                subscriptionResourceId: row.subscriptionResourceId,
                resourceText: resource.description || row.subscriptionResourceId,
                fromDate: ms(row.fromDate),
                fromText: dateText(row.fromDate),
                thruText: dateText(row.thruDate),
                purchaseText: [dateText(row.purchaseFromDate), dateText(row.purchaseThruDate)].filter(Boolean).join(" to "),
                availableText: termRowText(row.availableTime, row.availableTimeUomId),
                useText: [row.useCountLimit ? row.useCountLimit + " uses" : "", termRowText(row.useTime, row.useTimeUomId)]
                    .filter(Boolean)
                    .join(", "),
                useRoleText: row.useRoleTypeId
                    ? one("mantle.party.RoleType", {roleTypeId: row.useRoleTypeId})?.description || row.useRoleTypeId
                    : "",
                current: lib.active(row),
                handlersText: handlers.handlersText,
                values: Object.fromEntries(termFields.map(field => [field, row[field] == null ? null : row[field]]))
            }
        }
    )
    const resourceOptions = canEdit
        ? Array.from(find(RESOURCE).orderBy("description").limit(limits.resources).list())
              .filter(resource => handlersOf(resource).usable)
              .map(resource => ({
                  value: resource.subscriptionResourceId,
                  label: resource.description || resource.subscriptionResourceId
              }))
        : []
    return {productId: product.productId, productName: product.productName || product.productId, canEdit, terms, resourceOptions}
}
// store#ProductSubscriptionResource (PaidAccess): a resource bound to the product (from fromDate, now by default), a row's
// terms changed (the row in effect ended now and its successor started, so only later purchases take them; a row not yet
// started is changed in place), or a row ended (ended). Only a resource whose handlers are installed (RESOURCE_UNAVAILABLE);
// one current row a resource (RESOURCE_BOUND); ending one with live subscriptions refused naming the count
// (SUBSCRIPTIONS_LIVE). COMMERCE_SUBSCRIPTION_MANAGE and the product sold in the user's stores only (productOf).
function storeProductSubscriptionResource(p) {
    const s = scope("manage")
    const product = productOf(s, p.productId)
    const subscriptionResourceId = text(p.subscriptionResourceId)
    const resource = subscriptionResourceId ? one(RESOURCE, {subscriptionResourceId}) : null
    if (!resource) denied("RESOURCE_UNAVAILABLE", "Choose a subscription resource")
    const key = {productId: product.productId, subscriptionResourceId}
    const existing =
        p.fromDate != null && p.fromDate !== ""
            ? find(PSR, Object.assign({fromDate: dateParam(p.fromDate, "the row's start")}, key))
                  .forUpdate(true)
                  .one()
            : null
    // a change or an end names its row (review R3: an end without one was a script error)
    if (!existing && (yes(p.ended) || yes(p.change))) denied("RECORD_UNAVAILABLE", "That paid access row is not available")
    if (yes(p.ended)) {
        const live = liveCount(product.productId, subscriptionResourceId)
        if (live)
            denied(
                "SUBSCRIPTIONS_LIVE",
                live + " live subscription" + (live === 1 ? " uses" : "s use") + " this paid access; it stays until they end"
            )
        if (lib.active(existing) || (ms(existing.fromDate) ?? 0) > nowMs())
            call("update#" + PSR, Object.assign({fromDate: existing.fromDate, thruDate: ec.user.nowTimestamp}, key))
        return {productId: product.productId, subscriptionResourceId, ended: true}
    }
    if (!handlersOf(resource).usable)
        denied(
            "RESOURCE_UNAVAILABLE",
            (resource.description || subscriptionResourceId) + " has no installed handlers; its component binds it"
        )
    const values = {
        thruDate: dateParam(p.thruDate, "the end"),
        purchaseFromDate: dateParam(p.purchaseFromDate, "the purchase start"),
        purchaseThruDate: dateParam(p.purchaseThruDate, "the purchase end"),
        availableTime: wholeParam(p.availableTime, "The access time"),
        availableTimeUomId: text(p.availableTimeUomId) || null,
        useCountLimit: wholeParam(p.useCountLimit, "The use limit"),
        useTime: wholeParam(p.useTime, "The use time"),
        useTimeUomId: text(p.useTimeUomId) || null,
        useRoleTypeId: text(p.useRoleTypeId) || null
    }
    for (const field of ["availableTimeUomId", "useTimeUomId"])
        if (values[field] && one("moqui.basic.Uom", {uomId: values[field]})?.uomTypeEnumId !== "UT_TIME_FREQ_MEASURE")
            denied("VALUE_INVALID", "Choose a time unit")
    if (values.useRoleTypeId && !one("mantle.party.RoleType", {roleTypeId: values.useRoleTypeId}))
        denied("VALUE_INVALID", "Choose a role")
    if (values.availableTime && !values.availableTimeUomId) values.availableTimeUomId = "TF_mon"
    if (values.useTime && !values.useTimeUomId) denied("VALUE_INVALID", "Choose the use time's unit")
    if (existing && (ms(existing.fromDate) ?? 0) > nowMs()) {
        // not started yet: no purchase took it, so it changes in place
        call("update#" + PSR, Object.assign({fromDate: existing.fromDate}, key, values))
        return {productId: product.productId, subscriptionResourceId, fromDate: ms(existing.fromDate)}
    }
    // one instant ends the row in effect and starts its successor, so no purchase falls between them (review R5)
    const now = ec.user.nowTimestamp
    const fromDate = existing ? now : dateParam(p.newFromDate, "the start") || now
    if (values.thruDate && ms(values.thruDate) <= ms(fromDate)) denied("VALUE_INVALID", "The end comes after the start")
    const others = rows(PSR, key).filter(
        row => (!existing || ms(row.fromDate) !== ms(existing.fromDate)) && (lib.active(row) || (ms(row.fromDate) ?? 0) > nowMs())
    )
    if (others.length)
        denied(
            "RESOURCE_BOUND",
            "The product already grants " + (resource.description || subscriptionResourceId) + "; change that row"
        )
    if (existing) {
        if (!lib.active(existing)) denied("VALUE_INVALID", "That paid access row has ended; add a new one")
        call("update#" + PSR, Object.assign({fromDate: existing.fromDate, thruDate: now}, key))
    }
    call("create#" + PSR, Object.assign({fromDate}, key, values))
    return {productId: product.productId, subscriptionResourceId, fromDate: ms(fromDate)}
}

// ===== RecurringPolicy (CheckoutSettings) =====
// find#RecurringOffers: the store's offers (current first, then ended), whether its gateway charges a kept card off-session,
// its renewal notices (PsetPaymentRetry, PsetSubscriptionRenewal, edited with the store's emails), the subscriptions
// readiness (each Shop site's address), and the paid-access products of its assortment an offer may name.
function findRecurringOffers(p) {
    const s = stores.scope("view")
    const store = stores.storeOf(s, text(p.productStoreId))
    const all = Array.from(find(OFFER, {productStoreId: store.productStoreId}).orderBy("-fromDate").limit(limits.offers).list())
    const offers = all
        .map(offer => ({
            offerId: offer.offerId,
            revision: String(offer.revision || 1),
            offerName: offer.offerName || productName(offer.productId),
            productId: offer.productId,
            productName: productName(offer.productId),
            termText: shop().termText(shop().termOf(offer.productId, offer.subscriptionResourceId)),
            priceText: moneyText(offer.priceAmount, offer.currencyUomId),
            priceAmount: offer.priceAmount == null ? null : String(offer.priceAmount),
            currencyUomId: offer.currencyUomId,
            autoRenew: offer.autoRenew === "Y" ? "Y" : "N",
            renewText: offer.autoRenew === "Y" ? "Renews automatically" : "Prepaid term",
            termsVersion: offer.termsVersion || "",
            retryDays: offer.retryDays || shop().limits.retryDays.join(","),
            fromText: dateText(offer.fromDate),
            thruText: dateText(offer.thruDate),
            current: lib.active(offer)
        }))
        .sort((a, b) => Number(b.current) - Number(a.current))
    const emailText = emailTypeEnumId => {
        const email = rows("mantle.product.store.ProductStoreEmail", {
            productStoreId: store.productStoreId,
            emailTypeEnumId
        }).find(row => lib.active(row) && row.emailTemplateId)
        return email
            ? one("moqui.basic.email.EmailTemplate", {emailTemplateId: email.emailTemplateId})?.description ||
                  email.emailTemplateId
            : "None: not sent"
    }
    const productIds = Array.from(
        new Set(
            Array.from(
                find("mantle.product.store.ProductStoreProduct", {productStoreId: store.productStoreId})
                    .selectField("productId")
                    .limit(limits.candidates)
                    .list()
            ).map(row => row.productId)
        )
    )
    const productOptions = productIds
        .filter(productId => !!shop().termOf(productId, null))
        .map(productId => ({
            value: productId,
            label: productName(productId) + " (" + shop().termText(shop().termOf(productId, null)) + ")"
        }))
    const readiness = shop().readiness(store)
    return {
        productStoreId: store.productStoreId,
        canEdit: s.canEdit,
        offers,
        offSession: shop().offSessionGateways(store.productStoreId).length > 0,
        retryNoticeText: emailText("PsetPaymentRetry"),
        renewalNoticeText: emailText("PsetSubscriptionRenewal"),
        readinessText: readiness ? readiness.message : "No current offer",
        ready: !readiness || readiness.ready,
        productOptions
    }
}

// ===== Customer360 (StoreOperations.js get#StoreCustomer) =====
// A customer's contracts in the given stores (already the user's), newest first, as the list's rows.
function customerSubscriptions(storeIds, partyId) {
    if (!storeIds.length || !partyId) return []
    return Array.from(
        find(CONTRACT, {customerPartyId: partyId})
            .condition("productStoreId", "in", storeIds)
            .orderBy("-createdDate")
            .limit(limits.detail)
            .list()
    ).map(contractRow)
}

const operations = {
    findStoreSubscriptions,
    getStoreSubscription,
    cancelRecurringContract,
    retryRenewal,
    getProductPaidAccess,
    storeProductSubscriptionResource,
    findRecurringOffers
}
;({
    customerSubscriptions,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store subscription operation " + op)
        return operations[op](parameters || {})
    }
})
