/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Store reviews (impl-commerce P9, F19, F41; design-commerce §4 Reviews, design-shop §5 PublicReviews and SubmitReview; COM-MERCH,
 * SHOP-SUPPORT): staff moderation and the store's reply (StoreMerchandisingServices), a buyer's review of a product they bought
 * and its public projection (ShopCatalogServices), the review's images, and the review request on the delivery ledger.
 *
 * - Staff: find#Reviews and get#Review read with COMMERCE_VIEW in the user's store scope (StoreAdmin.js: the user's
 *   organizations; a user with a current StoreStaff row only those stores); moderate#Review (approve or delete, each review
 *   at its expected revision and in its own transaction, a result per review; the decision covers its images) and
 *   reply#Review (an approved review's public reply, or its withdrawal) need COMMERCE_MERCHANDISE. A decision is a status
 *   change with its reason in the audit log; the reply's text and author are audit-logged (no decision record, §4).
 * - Shop: submit#Review is a signed-in account's with its email verified (ExternalAccess's self relationship, after Shop P6's
 *   claim of the guest purchases of that email), for a product public in the store, proven by the account's own qualifying
 *   order item of it (an order of the store whose parts are all the account's, approved, sent or completed, the line not
 *   cancelled, and delivered: its shipment delivered, the order completed, or a download granted). The proof is found here,
 *   never taken from the request. A new review is pending; the author's edit at the expected revision returns an approved one
 *   to pending, out of the public page and its average. Up to three images, PNG or JPEG, staged and scanned through
 *   PortalMedia.js one a call; an image refused (its type, size or scan) is named and the text kept.
 * - Public reads (get#Reviews): approved reviews only, their author's chosen label (never an account, party or email), the
 *   rating summary of approved reviews only, the store's reply, and images by digest; the signed-in author also sees their own
 *   review in any state. get#ReviewImage serves an image by its digest only while its review is approved and its product
 *   public in the store.
 * - The review request (PsetReviewRequest): once per order item, queued on the delivery ledger (MessageDeliveries.js, one per
 *   event and recipient) when a Shop order's shipment is delivered or a digital item is first downloaded, for a store with a
 *   current PsetReviewRequest email; not transactional, so the ledger sends it only with the recipient's marketing email
 *   consent (PcpMarketingEmail), and its build suppresses it once the item is reviewed, returned or no longer public.
 * Reads and writes run without artifact authorization after these checks. Refusals start with their reason code.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const merchandising = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreMerchandising.js")
const catalog = () => ec.resource.script("component://mr-mantle/service/mantle/product/ShopCatalog.js")
const customers = () => ec.resource.script("component://mr-mantle/service/mantle/party/ShopCustomer.js")
const media = () => ec.resource.script("component://mr-mantle/service/mantle/party/PortalMedia.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, denied, call, ms, dateText, access} = lib
const R = "mantle.product.ProductReview"
const IMAGE = "mantle.product.ProductReviewImage"
const STORE = "mantle.product.store.ProductStore"
const PRODUCT = "mantle.product.Product"
const ITEM = "mantle.order.OrderItem"
const CHECKOUT = "mantle.order.StoreCheckout"

// ===== tables =====
const statuses = {
    PrvwPending: {label: "Pending", color: "warning", shopText: "Waiting for approval"},
    PrvwApproved: {label: "Approved", color: "positive", shopText: "Published"},
    PrvwDeleted: {label: "Deleted", color: "grey", shopText: "Removed"}
}
// The moderation decisions and the status each sets.
const decisions = {approve: "PrvwApproved", delete: "PrvwDeleted"}
// The author's display choices (design-shop §5 SubmitReview): a first name and initial, or no name.
const displayChoices = ["name", "anonymous"]
const anonymousLabel = "A customer"
const limits = {bodyLength: 5000, replyLength: 2000, images: 3, batch: 100, publicPage: 10, maxPublicPage: 20, stores: 500}
const imageTypes = {"image/png": "png", "image/jpeg": "jpg"}
// The order statuses whose lines a buyer may review (placed and accepted; never a cart, a held quote or a cancelled order).
const reviewableOrderStatuses = ["OrderApproved", "OrderSent", "OrderCompleted"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const unique = list => Array.from(new Set(list.filter(Boolean)))
const yes = value => value === true || value === "true" || value === "Y"
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
// Plain text from a visitor or staff: control characters but line breaks dropped, trimmed.
const plain = value =>
    text(value)
        .replace(/\r\n?/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
const ratingOf = row => (row.productRating == null ? null : toDecimal(row.productRating).toNumber())
// A line still ordered (Mantle lowers a cancelled line's quantity to zero).
const stillOrdered = item => item.quantity == null || toDecimal(item.quantity).compare(0) > 0
const authorLabel = row => text(row.displayName) || anonymousLabel
const revisionOf = row => String(ms(row.lastUpdatedStamp) ?? "")
const productName = productId => one(PRODUCT, {productId})?.productName || productId
// A Shop refusal: its kind (the facade's status), its code and message.
function refuse(kind, code, message, field) {
    const error = new Error(code + (field ? "[" + field + "]" : "") + ": " + message)
    error.moquiErrorKind = kind
    error.reason = code
    throw error
}
const notAvailable = what => refuse("NotFound", "NOT_AVAILABLE", (what || "This") + " is not available")
const invalid = (field, message) => refuse("Unprocessable", "VALUE_INVALID", message, field)
// The audit log reads a field's reason (<field>_changeReason) from the context as well as the update's parameters.
function withReason(update, why) {
    if (!why) return update
    for (const field of Object.keys(update)) if (field !== "productReviewId") update[field + "_changeReason"] = why
    ec.context.putAll(Object.fromEntries(Object.entries(update).filter(([field]) => field.endsWith("_changeReason"))))
    return update
}

// ===== staff scope =====
function scope(need) {
    const s = stores.scope("view")
    if (need === "merchandise" && !access.has("COMMERCE_MERCHANDISE"))
        denied("PERMISSION_DENIED", "COMMERCE_MERCHANDISE is required")
    return s
}
// A review in the user's scope (a missing one and another store's refused alike), locked to change it.
function reviewOf(s, productReviewId, forUpdate = false) {
    const row = text(productReviewId)
        ? find(R, {productReviewId: text(productReviewId)})
              .forUpdate(forUpdate)
              .one()
        : null
    if (!row) denied("RECORD_UNAVAILABLE", "Review " + text(productReviewId) + " is not available")
    try {
        stores.storeOf(s, row.productStoreId)
    } catch (error) {
        denied("RECORD_UNAVAILABLE", "Review " + text(productReviewId) + " is not available")
    }
    return row
}
function stale(expected, row) {
    if (expected != null && expected !== "" && ms(expected) !== ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", "Changed since it was read (now " + dateText(row.lastUpdatedStamp) + "); reload")
}
const imagesOf = productReviewId =>
    rows(IMAGE, {productReviewId}).sort((a, b) => String(a.imageSeqId).localeCompare(b.imageSeqId))
// The sites whose pages show a store's reviews drop their caches (impl-commerce §2's one publication generation).
const advance = productStoreId => merchandising().advanceGeneration([productStoreId])

// ===== staff reads =====
function staffRow(row, names, storeNames, imageCounts) {
    const status = statuses[row.statusId] || {label: row.statusId, color: "grey"}
    const body = text(row.productReview)
    return {
        productReviewId: row.productReviewId,
        productStoreId: row.productStoreId,
        storeName: storeNames[row.productStoreId] || row.productStoreId,
        productId: row.productId,
        productName: names[row.productId] || row.productId,
        rating: ratingOf(row),
        ratingText: ratingOf(row) == null ? "" : ratingOf(row) + " of 5",
        authorText: authorLabel(row),
        postedText: dateText(row.postedDateTime),
        statusId: row.statusId,
        statusText: status.label,
        statusColor: status.color,
        excerpt: body.length > 140 ? body.slice(0, 139) + "…" : body,
        body,
        verifiedPurchase: !!row.orderId,
        orderId: row.orderId || null,
        replied: !!text(row.replyText),
        replyText: text(row.replyText),
        replyDateText: dateText(row.replyDate),
        imageCount: imageCounts[row.productReviewId] || 0,
        lastUpdatedStamp: row.lastUpdatedStamp
    }
}
// find#Reviews (ReviewFind, Reviews): the reviews of the user's stores (or one store), by product, status, posted dates and
// text or author ignoring case, newest first, a page at a time.
function findReviews(p) {
    const s = scope("view")
    let storeIds
    if (text(p.productStoreId)) storeIds = [stores.storeOf(s, text(p.productStoreId)).productStoreId]
    else
        storeIds = Array.from(stores.storeQuery(s).selectField("productStoreId").limit(limits.stores).list()).map(
            row => row.productStoreId
        )
    // a find is used once: one for the count, one for the page
    const queryOf = () => {
        let query = find(R).condition("productStoreId", "in", storeIds.length ? storeIds : ["_NA_"])
        if (text(p.productId)) query = query.condition("productId", text(p.productId))
        if (text(p.statusId)) query = query.condition("statusId", text(p.statusId))
        if (p.fromDate) query = query.condition("postedDateTime", "greater-equals", new Date(ms(p.fromDate)))
        if (p.thruDate) query = query.condition("postedDateTime", "less", new Date(ms(p.thruDate)))
        if (text(p.term)) {
            const cf = ec.entity.conditionFactory
            query = query.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("productReview", "like", likeText(text(p.term))).ignoreCase(),
                        cf.makeCondition("displayName", "like", likeText(text(p.term))).ignoreCase(),
                        cf.makeCondition("productReviewId", "equals", text(p.term))
                    ],
                    "or"
                )
            )
        }
        if (yes(p.unreplied)) query = query.condition("replyText", "is-null", null)
        return query
    }
    const count = queryOf().count()
    const found = lib.page(queryOf().orderBy("-postedDateTime").orderBy("-productReviewId"), p, "reviews", count)
    const list = found.rows
    const names = Object.fromEntries(unique(list.map(row => row.productId)).map(productId => [productId, productName(productId)]))
    const storeNames = Object.fromEntries(
        unique(list.map(row => row.productStoreId)).map(id => [id, one(STORE, {productStoreId: id})?.storeName || id])
    )
    const imageCounts = {}
    const images = {}
    const ids = list.map(row => row.productReviewId)
    if (ids.length)
        for (const image of find(IMAGE).condition("productReviewId", "in", ids).orderBy("imageSeqId").list()) {
            imageCounts[image.productReviewId] = (imageCounts[image.productReviewId] || 0) + 1
            ;(images[image.productReviewId] = images[image.productReviewId] || []).push({
                imageSeqId: image.imageSeqId,
                filename: image.filename
            })
        }
    return {
        reviews: list.map(row =>
            Object.assign(staffRow(row, names, storeNames, imageCounts), {
                images: images[row.productReviewId] || [],
                // a row selection's key: the review and the revision shown, so a bulk decision is made at that revision
                selectionKey: row.productReviewId + "@" + (ms(row.lastUpdatedStamp) ?? "")
            })
        ),
        reviewsCount: count,
        reviewsPageIndex: found.reviewsPageIndex,
        reviewsPageSize: found.reviewsPageSize,
        reviewsPageMaxIndex: found.reviewsPageMaxIndex,
        reviewsPageRangeLow: found.reviewsPageRangeLow,
        reviewsPageRangeHigh: found.reviewsPageRangeHigh,
        canModerate: access.has("COMMERCE_MERCHANDISE")
    }
}
// get#Review (ReviewDecision, Reply): one review with its images (staff addresses by sequence) and its proof.
function getReview(p) {
    const s = scope("view")
    const row = reviewOf(s, p.productReviewId)
    const images = imagesOf(row.productReviewId)
    const review = staffRow(
        row,
        {[row.productId]: productName(row.productId)},
        {[row.productStoreId]: one(STORE, {productStoreId: row.productStoreId})?.storeName || row.productStoreId},
        {[row.productReviewId]: images.length}
    )
    review.orderItemSeqId = row.orderItemSeqId || null
    review.images = images.map(image => ({
        imageSeqId: image.imageSeqId,
        filename: image.filename,
        sizeText: image.byteSize ? Math.max(1, Math.round(Number(image.byteSize) / 1024)) + " KB" : ""
    }))
    return {review, canModerate: access.has("COMMERCE_MERCHANDISE")}
}
// get#ReviewImage for staff (ReviewDecision's preview): a review image of the user's scope in any state; its location stays on
// the server for the screen to send.
function getStaffImage(p) {
    const s = scope("view")
    const row = reviewOf(s, p.productReviewId)
    const image = one(IMAGE, {productReviewId: row.productReviewId, imageSeqId: text(p.imageSeqId)})
    if (!image) denied("RECORD_UNAVAILABLE", "This image is not available")
    return {location: image.contentLocation, filename: image.filename, contentType: image.contentType}
}

// ===== staff writes =====
// moderate#Review: approve or delete each review at its expected revision, each in a transaction of its own; one refused is
// named and the rest go on. A delete needs a reason; the reason is the status change's in the audit log. {results}.
function moderateReviews(p) {
    scope("merchandise")
    const statusId = decisions[text(p.decision)]
    if (!statusId) denied("VALUE_INVALID", "Choose approve or delete")
    const why = text(p.changeReason).slice(0, 255)
    if (statusId === "PrvwDeleted" && !why) denied("REASON_REQUIRED", "Give a reason for deleting the reviews")
    let items = p.reviews
    if (typeof items === "string") items = lib.json(items, [])
    items = Array.from(items || [])
    if (!items.length && p.selectionKeys)
        items = (Array.isArray(p.selectionKeys) ? p.selectionKeys : String(p.selectionKeys).split(","))
            .map(text)
            .filter(Boolean)
            .map(key => {
                const [productReviewId, stamp] = key.split("@")
                return {productReviewId, expectedLastUpdatedStamp: stamp ? new Date(Number(stamp)) : null}
            })
    if (!items.length && text(p.productReviewId))
        items = [{productReviewId: p.productReviewId, expectedLastUpdatedStamp: p.expectedLastUpdatedStamp}]
    if (!items.length) denied("VALUE_INVALID", "Choose the reviews to decide")
    if (items.length > limits.batch) denied("VALUE_INVALID", "Decide up to " + limits.batch + " reviews at a time")
    const results = []
    for (const item of items) {
        const productReviewId = text(item.productReviewId)
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name("mantle.product.StoreMerchandisingServices.decide#Review")
                    .parameters({
                        productReviewId,
                        statusId,
                        changeReason: why || null,
                        expectedLastUpdatedStamp: item.expectedLastUpdatedStamp || null
                    })
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({productReviewId, ok: true, statusId: out.statusId, changed: !!out.changed, message: out.message})
        } catch (error) {
            const message = String(error.message || error).split("\n")[0]
            results.push({
                productReviewId,
                ok: false,
                reasonCode: lib.reasonCode(error) || (/([A-Z][A-Z0-9_]+):/.exec(message) || [])[1] || "ERROR",
                message: message.replace(/^(Error: )?([A-Z][A-Z0-9_]+(\[[^\]]*\])?: )?/, "")
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {
        results,
        decidedCount: results.filter(result => result.ok).length,
        failedCount: results.filter(result => !result.ok).length
    }
}
// decide#Review: one review's decision, in the caller's new transaction.
function decideReview(p) {
    const s = scope("merchandise")
    const row = reviewOf(s, p.productReviewId, true)
    stale(p.expectedLastUpdatedStamp, row)
    if (row.statusId === p.statusId)
        return {statusId: row.statusId, changed: false, message: "Already " + statuses[row.statusId].label.toLowerCase()}
    if (row.statusId === "PrvwDeleted") denied("INVALID_STATUS", "A deleted review is not decided again")
    call("update#" + R, withReason({productReviewId: row.productReviewId, statusId: p.statusId}, text(p.changeReason) || null))
    advance(row.productStoreId)
    return {statusId: p.statusId, changed: true, message: statuses[p.statusId].label}
}
// reply#Review: the store's public reply to an approved review at its expected revision (plain text), or its withdrawal.
function replyReview(p) {
    const s = scope("merchandise")
    const row = reviewOf(s, p.productReviewId, true)
    stale(p.expectedLastUpdatedStamp, row)
    const withdraw = yes(p.withdraw)
    const reply = plain(p.replyText)
    if (!withdraw) {
        if (row.statusId !== "PrvwApproved") denied("NOT_APPROVED", "Only an approved review takes a reply")
        if (!reply) denied("VALUE_INVALID", "Write the reply")
        if (reply.length > limits.replyLength) denied("VALUE_INVALID", "Keep the reply to " + limits.replyLength + " characters")
    } else if (!text(row.replyText)) return {replied: false, lastUpdatedStamp: row.lastUpdatedStamp}
    call(
        "update#" + R,
        withReason(
            {
                productReviewId: row.productReviewId,
                replyText: withdraw ? null : reply,
                replyUserId: withdraw ? null : ec.user.userId,
                replyDate: withdraw ? null : ec.user.nowTimestamp
            },
            text(p.changeReason) || (withdraw ? "Reply withdrawn" : null)
        )
    )
    advance(row.productStoreId)
    return {replied: !withdraw, lastUpdatedStamp: one(R, {productReviewId: row.productReviewId}).lastUpdatedStamp}
}

// ===== Shop: the buyer =====
// The signed-in account's party when its email is verified (the self relationship), after Shop P6's claim of its email's
// guest purchases in this store.
function buyerOf(shop) {
    if (!ec.user.userId) refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to review a product")
    const partyId = customers().selfParty()
    if (!partyId) refuse("Unprocessable", "VERIFY_REQUIRED", "Verify your email address to review your purchases")
    customers().claimGuestPurchases(shop, partyId)
    return partyId
}
// A product public in the store now, else NOT_AVAILABLE.
function publicProduct(shop, productIdValue) {
    const productId = text(productIdValue)
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(productId)) notAvailable("This product")
    const found = merchandising().resolve(shop.store, [productId], shop.at, shop.siteId)[0]
    if (!found || !found.isPublic) notAvailable("This product")
    return productId
}
// The product and its variants: an order line of a variant counts for its virtual product's page.
function reviewedIds(productId) {
    const variants = rows("mantle.product.ProductAssoc", {productId, productAssocTypeEnumId: "PatVariant"})
        .filter(row => lib.active(row))
        .map(row => row.toProductId)
    return unique([productId].concat(variants))
}
// Whether an order line was delivered: its shipment delivered, the order completed, or a current download of it granted.
function delivered(order, item) {
    if (order.statusId === "OrderCompleted") return true
    if (
        rows("mantle.product.store.StoreDownloadGrant", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).some(
            grant => !grant.revokedDate
        )
    )
        return true
    const shipmentIds = unique(
        rows("mantle.shipment.ShipmentItemSource", {orderId: item.orderId, orderItemSeqId: item.orderItemSeqId}).map(
            row => row.shipmentId
        )
    )
    return (
        shipmentIds.length > 0 &&
        find("mantle.shipment.Shipment")
            .condition("shipmentId", "in", shipmentIds)
            .condition("statusId", "ShipDelivered")
            .count() > 0
    )
}
// The buyer's qualifying order lines of a product in the store (the proof), newest order first: an order of the store whose
// parts are all the buyer's (ShopCustomer.js ownOrder), approved, sent or completed, the line not cancelled, and delivered.
function qualifyingItems(shop, partyId, productId) {
    const productIds = reviewedIds(productId)
    const orderIds = unique(
        rows("mantle.order.OrderPart", {customerPartyId: partyId, vendorPartyId: shop.store.organizationPartyId}).map(
            row => row.orderId
        )
    )
    if (!orderIds.length) return []
    const orders = Array.from(
        find("mantle.order.OrderHeader")
            .condition("orderId", "in", orderIds)
            .condition("productStoreId", shop.productStoreId)
            .condition("statusId", "in", reviewableOrderStatuses)
            .orderBy("-placedDate")
            .limit(200)
            .list()
    ).filter(order => customers().ownOrder(shop, order, partyId))
    const out = []
    for (const order of orders)
        for (const item of find(ITEM, {orderId: order.orderId}).condition("productId", "in", productIds).list())
            if (stillOrdered(item) && delivered(order, item)) out.push(item)
    return out
}
// The author's own review of a product in the store (not deleted), or null.
const ownReview = (shop, productId) =>
    find(R, {userId: ec.user.userId, productStoreId: shop.productStoreId, productId})
        .condition("statusId", "not-equals", "PrvwDeleted")
        .one()
// The author's public label for a choice: the first name and the last name's initial, or none.
function labelOf(partyId, choice) {
    if (choice === "anonymous") return null
    const person = one("mantle.party.Person", {partyId})
    const first = text(person?.firstName)
    const initial = text(person?.lastName).slice(0, 1)
    return first ? first + (initial ? " " + initial + "." : "") : null
}
// Keep a staged image as the review's: under the store's content root, its digest the review's address for it.
// The content store is the authority's: a visitor's request reads and writes a review's files without artifact
// authorization, after the checks above.
function asAuthority(work) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
function keepImage(review, staged) {
    const existing = imagesOf(review.productReviewId)
    const imageSeqId = String(existing.reduce((max, row) => Math.max(max, Number(row.imageSeqId) || 0), 0) + 1).padStart(2, "0")
    const extension = imageTypes[staged.contentType]
    const location =
        media().contentRoot() +
        "/productReview/" +
        review.productStoreId +
        "/" +
        review.productReviewId +
        "/" +
        imageSeqId +
        "." +
        extension
    const content = asAuthority(() => {
        media().keep(staged, location)
        const stream = ec.resource.getLocationReference(location).openStream()
        try {
            return StringUtilities.base64Encode(stream.readAllBytes())
        } finally {
            stream.close()
        }
    })
    call("create#" + IMAGE, {
        productReviewId: review.productReviewId,
        imageSeqId,
        digest: ec.resource.digestText(review.productReviewId + ":" + imageSeqId + ":" + content, "sha256"),
        contentLocation: location,
        filename: staged.filename,
        contentType: staged.contentType,
        byteSize: staged.byteSize,
        createdDate: ec.user.nowTimestamp
    })
    return imageSeqId
}
function removeImage(review, imageSeqId) {
    const image = one(IMAGE, {productReviewId: review.productReviewId, imageSeqId: text(imageSeqId)})
    if (!image) return false
    call("delete#" + IMAGE, {productReviewId: review.productReviewId, imageSeqId: image.imageSeqId})
    try {
        asAuthority(() => ec.resource.getLocationReference(image.contentLocation).delete())
    } catch (error) {
        ec.logger.warn("Review image file " + image.contentLocation + " was not removed")
    }
    return true
}
// A visitor's image staged and scanned: {staged} or {refused: message}. Only PNG or JPEG (no PDF for a review).
function stageImage(file) {
    if (!file || !(Number(file.size) > 0)) return {}
    if (!imageTypes[String(file.contentType || "")]) return {refused: "Add the photo as a PNG or JPEG file"}
    try {
        return {staged: media().stage(file, "photo", "reviews")}
    } catch (error) {
        ec.message.clearErrors()
        return {refused: String(error.message || error).split("\n")[0]}
    }
}

// submit#Review (SubmitReview): a new review of a product the buyer bought, or an edit of their own at its revision; a
// photo per call; the receipt says it waits for approval.
function submitReview(p) {
    externalAccess().throttle("shop-review", 30, "Wait a few minutes before sending another review")
    const shop = catalog().shopOf(p)
    const partyId = buyerOf(shop)
    const productId = publicProduct(shop, p.productId)
    const rating = Number(text(p.rating))
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) invalid("rating", "Choose a rating from 1 to 5 stars")
    const body = plain(p.body)
    if (!body) invalid("body", "Tell other shoppers what you think")
    if (body.length > limits.bodyLength) invalid("body", "Keep the review to " + limits.bodyLength + " characters")
    const choice = text(p.displayChoice) || "name"
    if (!displayChoices.includes(choice)) invalid("displayChoice", "Choose how your name is shown")
    const mine = ownReview(shop, productId)
    if (text(p.productReviewId)) {
        if (!mine || mine.productReviewId !== text(p.productReviewId)) notAvailable("This review")
        if (text(p.expectedRevision) && text(p.expectedRevision) !== revisionOf(mine))
            refuse("Conflict", "STALE_REVISION", "Your review changed since this page was shown; reload it")
    } else if (mine) refuse("Conflict", "ALREADY_REVIEWED", "You have reviewed this product; change your review instead")
    let proof = null
    if (!mine) {
        proof = qualifyingItems(shop, partyId, productId)[0]
        if (!proof) refuse("Unprocessable", "PURCHASE_REQUIRED", "Only a buyer whose order of it has arrived can review it")
    }
    const removals = (Array.isArray(p.removeImageSeqIds) ? p.removeImageSeqIds : text(p.removeImageSeqIds).split(","))
        .map(text)
        .filter(Boolean)
    const image = stageImage(p.file)
    const values = {
        productRating: rating,
        productReview: body,
        displayName: labelOf(partyId, choice),
        postedAnonymous: choice === "anonymous" ? "Y" : "N"
    }
    let review
    let changedImages = false
    try {
        if (mine) {
            const wasApproved = mine.statusId === "PrvwApproved"
            call(
                "update#" + R,
                withReason(
                    Object.assign({productReviewId: mine.productReviewId}, values, {statusId: "PrvwPending"}),
                    wasApproved ? "Edited by its author" : null
                )
            )
            if (wasApproved) advance(shop.productStoreId)
            review = one(R, {productReviewId: mine.productReviewId})
        } else {
            const made = call(
                "create#" + R,
                Object.assign({}, values, {
                    productStoreId: shop.productStoreId,
                    productId,
                    userId: ec.user.userId,
                    statusId: "PrvwPending",
                    postedDateTime: ec.user.nowTimestamp,
                    orderId: proof.orderId,
                    orderItemSeqId: proof.orderItemSeqId
                })
            )
            review = one(R, {productReviewId: made.productReviewId})
        }
        for (const imageSeqId of removals) changedImages = removeImage(review, imageSeqId) || changedImages
        if (image.staged) {
            if (imagesOf(review.productReviewId).length >= limits.images) {
                image.refused = "A review takes up to " + limits.images + " photos"
                media().unstage(image.staged)
            } else {
                keepImage(review, image.staged)
                media().unstage(image.staged)
                changedImages = true
            }
        }
    } catch (error) {
        if (image.staged) media().unstage(image.staged)
        throw error
    }
    review = one(R, {productReviewId: review.productReviewId})
    return {
        review: {
            id: review.productReviewId,
            statusText: statuses[review.statusId].shopText,
            revision: revisionOf(review),
            imageCount: imagesOf(review.productReviewId).length
        },
        imageChanged: changedImages,
        imageRefused: image.refused || null,
        receipt: {
            message: image.refused
                ? "Thank you. Your review waits for approval; the photo was not added: " + image.refused
                : "Thank you. Your review waits for approval before it is shown."
        }
    }
}

// ===== Shop: public reads =====
const imageUrl = (shop, digest) => shop.base + "/media?reviewImage=" + encodeURIComponent(digest)
// The rating summary of the approved reviews of a product in a store: count, average and the count of each star.
function summaryOf(productStoreId, productId) {
    const counts = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
    let total = 0,
        count = 0
    for (const row of find(R, {productStoreId, productId, statusId: "PrvwApproved"}).selectField("productRating").list()) {
        const rating = Math.round(ratingOf(row))
        if (!(rating >= 1 && rating <= 5)) continue
        counts[rating]++
        total += rating
        count++
    }
    return {
        count,
        average: count ? (Math.round((total / count) * 10) / 10).toFixed(1) : null,
        distribution: [5, 4, 3, 2, 1].map(stars => ({stars, count: counts[stars]}))
    }
}
// get#Reviews (PublicReviews): the approved reviews of a product public in the store, newest first, a page at a time (an
// opaque cursor), with the summary of approved reviews only; the signed-in author's own review in any state; whether the
// visitor can write one.
function getReviews(p) {
    const shop = catalog().shopOf(p)
    const productId = publicProduct(shop, p.productId)
    const name = productName(productId)
    return Object.assign(reviewsView(shop, productId, p), {
        product: {id: productId, name, url: shop.base + "/products/" + productId + "/" + catalog().slug(name)},
        storeName: shop.store.storeName || ""
    })
}
function reviewsView(shop, productId, p = {}) {
    const size = Math.min(limits.maxPublicPage, Math.max(1, Number(p.limit) || limits.publicPage))
    const offset = /^c[0-9a-z]{1,8}$/.test(text(p.cursor)) ? parseInt(text(p.cursor).slice(1), 36) : 0
    const query = find(R, {productStoreId: shop.productStoreId, productId, statusId: "PrvwApproved"})
        .orderBy("-postedDateTime")
        .orderBy("-productReviewId")
    const page = Array.from(
        query
            .offset(offset)
            .limit(size + 1)
            .list()
    )
    const more = page.length > size
    const list = page.slice(0, size)
    const images = {}
    const ids = list.map(row => row.productReviewId)
    if (ids.length)
        for (const image of find(IMAGE).condition("productReviewId", "in", ids).orderBy("imageSeqId").list())
            (images[image.productReviewId] = images[image.productReviewId] || []).push(image)
    const writeUrl = shop.base + "/Review?productId=" + encodeURIComponent(productId)
    let own = null
    let canReview = false
    if (ec.user.userId) {
        const partyId = customers().selfParty()
        const mine = partyId ? ownReview(shop, productId) : null
        if (mine)
            own = {
                id: mine.productReviewId,
                rating: ratingOf(mine),
                body: text(mine.productReview),
                displayChoice: mine.postedAnonymous === "Y" ? "anonymous" : "name",
                authorLabel: authorLabel(mine),
                statusText: statuses[mine.statusId]?.shopText || "",
                approved: mine.statusId === "PrvwApproved",
                revision: revisionOf(mine),
                images: imagesOf(mine.productReviewId).map(image => ({imageSeqId: image.imageSeqId, filename: image.filename}))
            }
        else if (partyId) canReview = qualifyingItems(shop, partyId, productId).length > 0
    }
    return {
        productId,
        summary: summaryOf(shop.productStoreId, productId),
        reviews: list.map(row => ({
            id: row.productReviewId,
            rating: ratingOf(row),
            body: text(row.productReview),
            authorLabel: authorLabel(row),
            dateText: row.postedDateTime ? ec.l10n.format(new Date(ms(row.postedDateTime)), "MMM d, yyyy") : "",
            verifiedPurchase: !!row.orderId,
            reply: text(row.replyText)
                ? {
                      text: text(row.replyText),
                      dateText: row.replyDate ? ec.l10n.format(new Date(ms(row.replyDate)), "MMM d, yyyy") : ""
                  }
                : null,
            images: (images[row.productReviewId] || []).map(image => ({
                url: imageUrl(shop, image.digest),
                alt: "Photo from " + authorLabel(row)
            }))
        })),
        nextCursor: more ? "c" + (offset + size).toString(36) : null,
        own,
        canReview,
        writeUrl
    }
}
// get#ReviewImage (the media route): an image by its digest while its review is approved and its product public in the
// store now; anything else NOT_AVAILABLE. {file, location}: the frontend or the authority's transport streams it.
function getReviewImage(p) {
    const shop = catalog().shopOf(p)
    const digest = text(p.reviewImage)
    if (!/^[A-Za-z0-9+/=_-]{16,128}$/.test(digest)) notAvailable("This image")
    const image = one(IMAGE, {digest})
    const review = image ? one(R, {productReviewId: image.productReviewId}) : null
    if (!review || review.statusId !== "PrvwApproved" || review.productStoreId !== shop.productStoreId) notAvailable("This image")
    const found = merchandising().resolve(shop.store, [review.productId], shop.at, shop.siteId)[0]
    if (!found || !found.isPublic) notAvailable("This image")
    return {
        file: {
            mimeType: image.contentType,
            filename: "review-" + image.productReviewId + "-" + image.imageSeqId + "." + imageTypes[image.contentType]
        },
        location: image.contentLocation
    }
}

// ===== the review request =====
const requestKey = (orderId, orderItemSeqId) => "reviewRequest:" + orderId + ":" + orderItemSeqId
// The store's current review request email, or null (a store without one sends none).
const requestEmail = productStoreId =>
    rows("mantle.product.store.ProductStoreEmail", {productStoreId, emailTypeEnumId: "PsetReviewRequest"}).find(
        row => lib.active(row) && row.emailTemplateId
    ) || null
// queue#ReviewRequests: one request per delivered line of a Shop order (a shipment's lines, or named lines of an order), on the
// delivery ledger; an order Shop did not place, or a store with no review request email, queues nothing. Each line on its own.
function queueRequests(p) {
    const lines = []
    if (text(p.shipmentId))
        for (const row of rows("mantle.shipment.ShipmentItemSource", {shipmentId: text(p.shipmentId)}))
            if (row.orderId && row.orderItemSeqId) lines.push({orderId: row.orderId, orderItemSeqId: row.orderItemSeqId})
    if (text(p.orderId) && text(p.orderItemSeqId)) lines.push({orderId: text(p.orderId), orderItemSeqId: text(p.orderItemSeqId)})
    if (text(p.downloadGrantId)) {
        const grant = one("mantle.product.store.StoreDownloadGrant", {downloadGrantId: text(p.downloadGrantId)})
        if (grant) lines.push({orderId: grant.orderId, orderItemSeqId: grant.orderItemSeqId})
    }
    let queued = 0
    const seen = new Set()
    for (const line of lines) {
        const key = requestKey(line.orderId, line.orderItemSeqId)
        if (seen.has(key)) continue
        seen.add(key)
        try {
            const checkout = one(CHECKOUT, {orderId: line.orderId, statusId: "ScoCompleted"})
            if (!checkout) continue
            const email = requestEmail(checkout.productStoreId)
            const item = one(ITEM, {orderId: line.orderId, orderItemSeqId: line.orderItemSeqId})
            if (!email || !item || item.itemTypeEnumId !== "ItemProduct" || !item.productId) continue
            const part = one("mantle.order.OrderPart", {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId})
            const recipientPartyId = part?.customerPartyId || checkout.customerPartyId
            if (!recipientPartyId) continue
            const out = call("mantle.party.MessageServices.queue#Delivery", {
                eventKey: key,
                sourceEnumId: "MdsrcReviewRequest",
                recipientPartyId,
                toAddress: checkout.contactEmail,
                templateKey: email.emailTemplateId,
                siteId: checkout.siteId,
                productStoreId: checkout.productStoreId,
                transactional: false,
                marketingPurposeEnumId: "PcpMarketingEmail"
            })
            if (out.created) queued++
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error("Review request of " + key + " not queued: " + String(error.message).split("\n")[0])
        }
    }
    return {queued}
}
// build#ReviewRequest (the ledger's source build): the request's parameters, made for each attempt, or suppressed once the
// line is reviewed by its buyer, cancelled or returned, or its product is no longer public in the store.
function buildRequest(p) {
    const match = /^reviewRequest:([^:]+):([^:]+)$/.exec(text(p.eventKey))
    if (!match) return {suppress: "Not a review request"}
    const [, orderId, orderItemSeqId] = match
    const checkout = one(CHECKOUT, {orderId, statusId: "ScoCompleted"})
    const item = one(ITEM, {orderId, orderItemSeqId})
    if (!checkout || !item) return {suppress: "The order line is gone"}
    if (!stillOrdered(item)) return {suppress: "The line was cancelled"}
    if (find("mantle.order.return.ReturnItem", {orderId, orderItemSeqId}).count() > 0) return {suppress: "The line was returned"}
    const store = one(STORE, {productStoreId: checkout.productStoreId})
    // a variant's request is for its virtual product's page
    const parent = rows("mantle.product.ProductAssoc", {toProductId: item.productId, productAssocTypeEnumId: "PatVariant"}).find(
        row => lib.active(row)
    )
    const productId = parent?.productId || item.productId
    const found = merchandising().resolve(store, [productId], ms(ec.user.nowTimestamp), checkout.siteId)[0]
    if (!found || !found.isPublic) return {suppress: "The product is no longer offered"}
    const accounts = rows("moqui.security.UserAccount", {partyId: p.recipientPartyId || checkout.customerPartyId}).map(
        row => row.userId
    )
    if (
        accounts.length &&
        find(R, {productStoreId: store.productStoreId, productId}).condition("userId", "in", accounts).count() > 0
    )
        return {suppress: "Already reviewed"}
    return {
        toAddress: checkout.contactEmail,
        bodyParameters: {
            title: "How was your " + productName(productId) + "?",
            orderId,
            storeName: store?.storeName || "",
            productName: productName(productId),
            reviewUrl: publicApps().pageUrl(checkout.siteId, "shop", "/Review?productId=" + encodeURIComponent(productId)),
            preferencesUrl: publicApps().pageUrl(checkout.siteId, "account", "/EmailPreferences")
        }
    }
}

const operations = {
    findReviews,
    getReview,
    getStaffImage,
    moderateReviews,
    decideReview,
    replyReview,
    submitReview,
    getReviews,
    getReviewImage,
    queueRequests,
    buildRequest
}
;({
    limits,
    // Shop's product view (ShopCatalog.js views.product): the reviews under a product's page
    reviewsView,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store review operation " + op)
        return operations[op](parameters || {})
    }
})
