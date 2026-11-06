/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Cart recovery (impl-commerce P10, COM-OPS; design-commerce §6 CartDetail's RecoveryHistory and RecoverCart, §8
 * RecoveryPolicy; design-shop §7.1, §11 Delivery, §13.2 recoverCart): a reminder of a cart a signed-in shopper left, sent once
 * per cart and inactivity window through the Comms delivery ledger, whose one-time link restores the cart repriced in the
 * shopper's session.
 *
 * - The policy: dated ProductStoreSetting rows (PsstRecoveryEnabled, PsstRecoveryDelay in minutes, PsstRecoverySender,
 *   PsstRecoveryMaxSends, PsstRecoveryRetention in days), saved by store#CartRecoveryPolicy (COMMERCE_STORE_EDIT) as the
 *   checkout policy is (StoreCheckout.js), with F118's checkout opt-ins and news list beside it. The binding is the store's
 *   current PsetCartRecovery ProductStoreEmail. Nothing is sent for a store until it enables recovery.
 * - Who: only a signed-in customer's cart (its access row's customerPartyId; a guest's never) whose account email is
 *   verified, holding the store's cart reminders topic (check#CartReminderConsent); the ledger checks the same topic again at
 *   each hand-off (consentContactListId). A cart staff made has no shopper.
 * - When: idle past the delay (StoreCartAccess.lastActivityDate, never lastUpdatedStamp) and within the recovery window, not in
 *   a live or completed checkout, with something in it. One abandonment event per cart and window: the event key is the cart
 *   and its last activity (cartRecovery:{orderId}:{activity ms}), so the ledger's unique event, recipient and template keeps it
 *   to one mail; the most sends a cart gets (across its windows) is the policy's. The sender is built-in recovery, the only
 *   one until Marketing's automation exists (design §8); the other never sends.
 * - The job (run#CartRecovery): the enabled stores' carts idle past their delay, each in its own transaction (queue#Recovery,
 *   which hands the delivery to the ledger and tries it at once); one that fails is logged and named, and the rest go on.
 * - Each attempt (build#CartRecovery, the ledger's source build) checks the cart again: closed, completed, checking out, or
 *   the shopper back since the window suppresses it; a cart whose site has no Shop or preferences page fails it. It makes a
 *   new one-time token (only its digest is kept, on the access row, until the window ends) for the link in that message.
 * - The link (recover#Cart, Shop's recoverCart): the signed-in account the cart belongs to spends the token, the cart's
 *   capability is rotated into its session, its lines repriced and the unavailable ones named; a spent, expired, replaced or
 *   revoked token, or another account's, is NOT_AVAILABLE; a visitor is asked to sign in, and the token is kept.
 * - Staff (COMMERCE_ORDER_VIEW, the store scope of StoreOperations.js): get#CartRecovery (the eligibility and its reason, the
 *   consent state, the policy, the prior sends from the ledger and, with COMMERCE_RECOVERY, the exact body previewed) and
 *   send#CartRecovery (COMMERCE_RECOVERY: one send of an eligible cart, with its reason, its operation key and the cart's
 *   revision). Sending never changes the order or signs staff in as the shopper.
 * Reads and writes below the checks are the authority's own (authorization disabled).
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, ms, dateText, active, access} = lib
const admin = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const storeCheckout = () => ec.resource.script("component://mr-mantle/service/mantle/product/StoreCheckout.js")
const operations = () => ec.resource.script("component://mr-mantle/service/mantle/order/StoreOperations.js")
const carts = () => ec.resource.script("component://mr-mantle/service/mantle/order/ShopCart.js")
const storeTopics = () => ec.resource.script("component://mr-mantle/service/mantle/public/StoreTopics.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const externalAccess = () => ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
const A = "mantle.order.StoreCartAccess"
const ORDER = "mantle.order.OrderHeader"
const CHECKOUT = "mantle.order.StoreCheckout"
const DELIVERY = "mantle.party.MessageDelivery"
const STORE = "mantle.product.store.ProductStore"
const SETTING = "mantle.product.store.ProductStoreSetting"
const SOURCE = "MdsrcCartRecovery"
const SERVICES = "mantle.order.StoreOperationsServices."

// ===== tables =====
// RecoveryPolicy's fields (design §8): each a dated setting type with its default.
const policy = {
    enabled: {settingTypeEnumId: "PsstRecoveryEnabled", defaultValue: "false", label: "Recovery"},
    delayMinutes: {settingTypeEnumId: "PsstRecoveryDelay", defaultValue: "60", label: "Inactivity delay"},
    sender: {settingTypeEnumId: "PsstRecoverySender", defaultValue: "builtin", label: "Sender"},
    maxSends: {settingTypeEnumId: "PsstRecoveryMaxSends", defaultValue: "1", label: "Most sends a cart"},
    retentionDays: {settingTypeEnumId: "PsstRecoveryRetention", defaultValue: "7", label: "Recovery window"}
}
// F118: the checkout's optional emails (StoreTopics.js reads them) and the store's news list, kept beside the policy.
const consentPolicy = {
    checkoutOptIns: {settingTypeEnumId: "PsstCheckoutOptIns", defaultValue: "", label: "Checkout opt-ins"},
    newsListId: {settingTypeEnumId: "PsstNewsList", defaultValue: "", label: "News and offers list"}
}
const senderTexts = {builtin: "Built-in recovery"}
const optInTexts = {reviewRequests: "Review requests", cartReminders: "Cart reminders", news: "News and offers"}
// The job's bounds: stores and carts a run, and the recovery link lookups a requester makes in ten minutes.
const limits = {stores: 200, carts: 500, lookups: 120}
const liveCheckoutStatuses = ["ScoPaymentPending", "ScoPlacementPending"]
// a ledger state that reached no one does not count toward the policy's most sends
const unsentStates = ["MdsSuppressed", "MdsFailed"]
const DAY_MS = 86400000

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
function refuse(kind, code, message) {
    const error = new Error(code + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const keyOf = (orderId, windowMs) => "cartRecovery:" + orderId + ":" + windowMs
const keyPrefix = orderId => "cartRecovery:" + orderId + ":"
const parseKey = key => {
    const match = /^cartRecovery:([^:]+):(\d+)$/.exec(text(key))
    return match ? {orderId: match[1], windowMs: Number(match[2])} : null
}
function masked(address) {
    const value = text(address)
    const at = value.indexOf("@")
    return at < 1 ? (value ? "…" : "") : value[0] + "…" + value.slice(at)
}
const minutesText = minutes =>
    minutes % 1440 === 0
        ? minutes / 1440 + (minutes === 1440 ? " day" : " days")
        : minutes % 60 === 0
          ? minutes / 60 + (minutes === 60 ? " hour" : " hours")
          : minutes + " minutes"

// ===== the policy =====
// The store's policy in effect at a time: {enabled, delayMinutes, sender, maxSends, retentionDays}.
function policyOf(productStoreId, at = nowMs()) {
    const value = field => storeCheckout().settingAt(productStoreId, policy[field].settingTypeEnumId, at)?.settingValue
    const number = (field, fallback) => {
        const parsed = Number(value(field))
        return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
    }
    return {
        enabled: value("enabled") === "true",
        delayMinutes: number("delayMinutes", 60),
        sender: value("sender") || "builtin",
        maxSends: number("maxSends", 1),
        retentionDays: number("retentionDays", 7)
    }
}
// The abandonment delay in minutes (StoreOperations.js: Carts and CartDetail).
const delayOf = productStoreId => policyOf(productStoreId).delayMinutes
// The store's current cart recovery email (PsetCartRecovery), or null.
const recoveryEmail = productStoreId =>
    rows("mantle.product.store.ProductStoreEmail", {productStoreId, emailTypeEnumId: "PsetCartRecovery"}).find(
        row => active(row) && row.emailTemplateId
    ) || null

// ===== a cart's facts and eligibility =====
// The cart's order, its Shop access row (the latest active one), its checkouts and its product lines.
function factsOf(order) {
    const access =
        rows(A, {orderId: order.orderId}).sort((a, b) => (ms(b.lastActivityDate) ?? 0) - (ms(a.lastActivityDate) ?? 0))[0] || null
    return {
        order,
        access,
        checkouts: rows(CHECKOUT, {orderId: order.orderId}),
        lines: carts().productLines(order.orderId)
    }
}
// The verified email of the account of a party (its UserAccount's own address, verified), or null.
function verifiedEmail(partyId) {
    if (!partyId) return null
    for (const account of rows("moqui.security.UserAccount", {partyId})) {
        const address = text(account.emailAddress).toLowerCase()
        if (
            address &&
            rows("moqui.security.public.VerifiedAddress", {userId: account.userId}).some(
                row => !!row.verifiedAt && text(row.emailAddress).toLowerCase() === address
            )
        )
            return text(account.emailAddress)
    }
    return null
}
const consentOf = (partyId, productStoreId) =>
    !!partyId && !!call("mantle.public.AccountHubServices.check#CartReminderConsent", {partyId, productStoreId}).consented
// The cart's recovery sends on the ledger (its event keys), newest first.
const sendsOf = orderId =>
    Array.from(
        find(DELIVERY, {sourceEnumId: SOURCE})
            .condition("eventKey", "like", keyPrefix(orderId) + "%")
            .list()
    )
        .filter(row => String(row.eventKey).startsWith(keyPrefix(orderId)))
        .sort((a, b) => (ms(b.createdDate) ?? 0) - (ms(a.createdDate) ?? 0))
// Whether a cart may be sent a recovery now, and why not: {eligible, code, text, windowMs, partyId, email, consent}. A
// delivery being built (forDelivery) is the window's own send, so neither the window nor the most sends count it.
function eligibility(store, facts, pol, at = nowMs(), forDelivery = null) {
    const no = (code, reason, extra) => Object.assign({eligible: false, code, text: reason}, extra || {})
    const {order, access, checkouts, lines} = facts
    const partyId = access?.customerPartyId || null
    const consent = partyId ? consentOf(partyId, store.productStoreId) : false
    const base = {partyId, consent}
    if (!pol.enabled) return no("RECOVERY_OFF", "Recovery is off for this store", base)
    if (pol.sender !== "builtin") return no("OTHER_SENDER", "The store's recovery is sent by its Marketing automation", base)
    if (!recoveryEmail(store.productStoreId))
        return no("NO_TEMPLATE", "The store has no current cart recovery email (PsetCartRecovery)", base)
    if (!access) return no("MADE_BY_STAFF", "Made by staff: there is no shopper to remind", base)
    if (!partyId) return no("GUEST", "A guest's cart is never recovered", base)
    if (order.statusId !== "OrderOpen" || access.revokedDate) return no("CLOSED", "The cart is closed", base)
    if (checkouts.some(row => row.statusId === "ScoCompleted")) return no("COMPLETED", "Its checkout completed", base)
    if (checkouts.some(row => liveCheckoutStatuses.includes(row.statusId)))
        return no("CHECKING_OUT", "A payment or placement is in progress", base)
    if (!lines.length) return no("EMPTY", "The cart is empty", base)
    if (!consent) return no("NO_CONSENT", "The customer has not turned on cart reminders for this store", base)
    const email = verifiedEmail(partyId)
    if (!email) return no("NOT_VERIFIED", "The customer's account email is not verified", base)
    const windowMs = ms(access.lastActivityDate)
    if (windowMs == null) return no("NO_ACTIVITY", "No shopper activity is recorded", base)
    const idle = at - windowMs
    Object.assign(base, {email, windowMs})
    if (idle < pol.delayMinutes * 60000)
        return no("ACTIVE", "Active: abandoned " + minutesText(pol.delayMinutes) + " after the last activity", base)
    if (idle > pol.retentionDays * DAY_MS) return no("PAST_WINDOW", "Idle longer than the store's recovery window", base)
    const sends = sendsOf(order.orderId).filter(row => row.recipientPartyId === partyId && row.deliveryId !== forDelivery)
    if (!forDelivery && sends.some(row => row.eventKey === keyOf(order.orderId, windowMs)))
        return no("ALREADY_SENT", "Already handled for this visit to the cart", base)
    if (sends.filter(row => !unsentStates.includes(row.stateEnumId)).length >= pol.maxSends)
        return no("SEND_LIMIT", "The cart had the most sends the store allows (" + pol.maxSends + ")", base)
    return Object.assign(base, {
        eligible: true,
        code: "ELIGIBLE",
        text: "Eligible: idle since " + dateText(access.lastActivityDate)
    })
}

// ===== the message =====
// The message's parameters for a cart, with its link (recoveryUrl): {toAddress, bodyParameters}. A cart whose site has no
// Shop or preferences page cannot be reminded (an error, so the ledger names it failed).
function messageOf(store, facts, email, recoveryUrl) {
    const {access, order, lines} = facts
    const preferencesUrl = publicApps().pageUrl(access.siteId, "account", "/EmailPreferences")
    if (!recoveryUrl) throw new Error("The cart's site " + access.siteId + " has no Shop page to link")
    if (!preferencesUrl) throw new Error("The cart's site " + access.siteId + " has no email preferences page to link")
    const storeName = store.storeName || store.productStoreId
    const name = line => line.itemDescription || one("mantle.product.Product", {productId: line.productId})?.productName || "Item"
    return {
        toAddress: email,
        bodyParameters: {
            title: "You left items in your cart at " + storeName,
            storeName,
            itemsText: lines
                .slice(0, 10)
                .map(line => name(line) + " × " + Number(String(line.quantity)))
                .join(", "),
            recoveryUrl,
            preferencesUrl,
            preferencesText:
                "You get this because you turned on cart reminders for " +
                storeName +
                ". Turn them off on your email preferences page.",
            cartRevision: String(order.orderRevision || 1)
        }
    }
}
const shopLink = (siteId, token) => publicApps().pageUrl(siteId, "shop", "/Recover?r=" + encodeURIComponent(token))

// ===== queue#Recovery (one cart, its own transaction) =====
// A cart's recovery handed to the ledger when it is eligible now (the job's and staff's send), tried at once unless sendNow is
// false. {queued, code, deliveryId, stateEnumId}.
function queueRecovery(p) {
    const order = one(ORDER, {orderId: text(p.orderId)})
    const store = order ? one(STORE, {productStoreId: order.productStoreId}) : null
    if (!order || !store) return {queued: false, code: "NOT_AVAILABLE"}
    const facts = factsOf(order)
    const found = eligibility(store, facts, policyOf(store.productStoreId))
    if (!found.eligible) return {queued: false, code: found.code, text: found.text}
    const email = recoveryEmail(store.productStoreId)
    const out = call("mantle.party.MessageServices.queue#Delivery", {
        eventKey: keyOf(order.orderId, found.windowMs),
        sourceEnumId: SOURCE,
        recipientPartyId: found.partyId,
        toAddress: found.email,
        templateKey: email.emailTemplateId,
        siteId: facts.access.siteId,
        productStoreId: store.productStoreId,
        transactional: false,
        // the store's cart reminders topic, checked again at each hand-off
        marketingPurposeEnumId: "PcpCartReminder",
        consentContactListId: storeTopics().topicList("cartReminders", store.productStoreId, true),
        // who asked and why (no secret: the link is made at each attempt)
        bodyParameters: {sentBy: text(p.sentBy) || "job", reason: text(p.reason) || null},
        sendNow: p.sendNow !== false && p.sendNow !== "false"
    })
    return {
        queued: !!out.created,
        code: out.created ? "QUEUED" : "ALREADY_SENT",
        deliveryId: out.deliveryId,
        stateEnumId: out.stateEnumId
    }
}

// ===== run#CartRecovery (the job) =====
// The stores with recovery enabled now (or the ones named), each store's carts idle past its delay within its window, each
// cart in its own transaction; one that fails is logged and named. {stores, carts, queued, failed, failures}.
function runRecovery(p) {
    const at = nowMs()
    const named = Array.isArray(p.productStoreIds) ? p.productStoreIds.map(text).filter(Boolean) : null
    let query = find(SETTING, {settingTypeEnumId: policy.enabled.settingTypeEnumId, settingValue: "true"})
    if (named) query = query.condition("productStoreId", "in", named.length ? named : ["-"])
    const storeIds = Array.from(
        new Set(
            Array.from(query.list())
                .filter(row => active(row))
                .map(row => row.productStoreId)
        )
    )
        .sort()
        .slice(0, limits.stores)
    const out = {stores: 0, carts: 0, queued: 0, failed: 0, failures: []}
    for (const productStoreId of storeIds) {
        const pol = policyOf(productStoreId, at)
        if (!pol.enabled || pol.sender !== "builtin" || !recoveryEmail(productStoreId)) continue
        out.stores++
        const candidates = Array.from(
            find(A, {productStoreId})
                .condition("customerPartyId", "is-not-null", null)
                .condition("revokedDate", "is-null", null)
                .condition("lastActivityDate", "less-equals", new Date(at - pol.delayMinutes * 60000))
                .condition("lastActivityDate", "greater-equals", new Date(at - pol.retentionDays * DAY_MS))
                .orderBy("lastActivityDate")
                .limit(limits.carts)
                .list()
        )
        for (const row of candidates) {
            out.carts++
            try {
                const done = lib.probe(SERVICES + "queue#CartRecovery", {orderId: row.orderId})
                if (done.queued) out.queued++
                if (done.stateEnumId === "MdsFailed") {
                    out.failed++
                    out.failures.push(row.orderId + ": not sent")
                }
            } catch (error) {
                out.failed++
                out.failures.push(row.orderId + ": " + String(error.message).split("\n")[0])
                ec.logger.error("Cart recovery of cart " + row.orderId + " failed: " + String(error.message).split("\n")[0])
            }
        }
    }
    return out
}

// ===== build#CartRecovery (the ledger's source build, each attempt) =====
// The message of a recovery delivery, made fresh: suppressed when the cart is closed, completed, checking out, the shopper came
// back since its window, or it is no longer eligible; else a new one-time token (its digest on the access row until the end
// of the window) for the link of this message.
function buildRecovery(p) {
    const key = parseKey(p.eventKey)
    if (!key) return {suppress: "Not a cart recovery"}
    const order = one(ORDER, {orderId: key.orderId})
    const store = order ? one(STORE, {productStoreId: order.productStoreId}) : null
    if (!order || !store) return {suppress: "The cart is gone"}
    const facts = factsOf(order)
    if (facts.access && ms(facts.access.lastActivityDate) !== key.windowMs) return {suppress: "The shopper came back to the cart"}
    const pol = policyOf(store.productStoreId)
    const found = eligibility(store, facts, pol, nowMs(), text(p.deliveryId) || "-")
    if (!found.eligible) return {suppress: found.text}
    if (found.partyId !== text(p.recipientPartyId)) return {suppress: "The cart is another customer's now"}
    const token = ec.user.randomString(48)
    const message = messageOf(store, facts, found.email, shopLink(facts.access.siteId, token))
    call("update#" + A, {
        cartAccessId: facts.access.cartAccessId,
        recoveryTokenDigest: externalAccess().tokenDigest(token),
        recoveryUsedDate: null,
        recoveryExpireDate: new Date(key.windowMs + pol.retentionDays * DAY_MS)
    })
    return message
}

// ===== recover#Cart (Shop's recoverCart) =====
// The recovery link spent by the signed-in account whose cart it is: the token spent, the cart's capability rotated into the
// session (result.token), its lines repriced and the ones that cannot be bought now named. A visitor is asked to sign in (the
// token is kept); a spent, expired, replaced or revoked token, or another account's, is NOT_AVAILABLE.
function recoverCart(p) {
    const shopCart = carts()
    const shop = shopCart.shopOf(p)
    const notAvailable = () => refuse("NotFound", "NOT_AVAILABLE", "This link is no longer available")
    const presented = text(p.token)
    if (presented.length < 32 || presented.length > 128) notAvailable()
    externalAccess().throttle("cart-recovery", limits.lookups, "Wait a few minutes before opening a cart link again")
    if (!shop.customerPartyId) refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to open your saved cart")
    const row = one(A, {recoveryTokenDigest: externalAccess().tokenDigest(presented)})
    if (
        !row ||
        row.recoveryUsedDate ||
        (ms(row.recoveryExpireDate) ?? 0) <= shop.at ||
        !shopCart.usable(shop, row) ||
        row.customerPartyId !== shop.customerPartyId
    )
        notAvailable()
    // spent first, under the order's lock, so a second use of the same link finds it spent
    find(ORDER, {orderId: row.orderId}).forUpdate(true).one()
    const fresh = one(A, {cartAccessId: row.cartAccessId})
    if (fresh.recoveryUsedDate || fresh.recoveryTokenDigest !== row.recoveryTokenDigest) notAvailable()
    call("update#" + A, {cartAccessId: row.cartAccessId, recoveryTokenDigest: null, recoveryUsedDate: ec.user.nowTimestamp})
    const cart = shopCart.loaded(row)
    const pending = shopCart.pendingCheckout(cart)
    const missing = pending ? [] : shopCart.reprice(shop, cart)
    const token = shopCart.rotate(cart.row, {
        lastActivityDate: ec.user.nowTimestamp,
        expireDate: new Date(shop.at + shopCart.limits.accountDays * DAY_MS)
    })
    return shopCart.answer(shop, cart, {token, recovered: true, unavailableItems: missing})
}

// ===== staff =====
function staffScope() {
    return operations().scope()
}
function cartOf(s, orderId) {
    const order = operations().storeOrder(s, text(orderId), true)
    return {order, store: one(STORE, {productStoreId: order.productStoreId})}
}
function policyView(store) {
    const pol = policyOf(store.productStoreId)
    const email = recoveryEmail(store.productStoreId)
    const template = email ? one("moqui.basic.email.EmailTemplate", {emailTemplateId: email.emailTemplateId}) : null
    return Object.assign({}, pol, {
        enabledText: pol.enabled ? "On" : "Off: nothing is sent",
        delayText: minutesText(pol.delayMinutes),
        senderText: senderTexts[pol.sender] || pol.sender,
        maxSendsText: String(pol.maxSends),
        retentionText: pol.retentionDays + (pol.retentionDays === 1 ? " day" : " days"),
        emailTemplateId: email?.emailTemplateId || null,
        templateText: template ? template.description || template.emailTemplateId : "None: set the store's Cart Recovery email"
    })
}
// The previewed message of an eligible cart: its subject and the exact body the template renders, the link shown as made at
// the send (its token is made then and never shown).
function previewOf(store, facts, found) {
    const email = recoveryEmail(store.productStoreId)
    const template = email ? one("moqui.basic.email.EmailTemplate", {emailTemplateId: email.emailTemplateId}) : null
    if (!template) return null
    let message
    try {
        message = messageOf(store, facts, found.email, shopLink(facts.access.siteId, "LINK-MADE-WHEN-SENT"))
    } catch (error) {
        return {subject: "", body: "", problem: String(error.message)}
    }
    const parameters = message.bodyParameters
    let subject = template.subject || ""
    try {
        subject = ec.resource.expand(subject, "", parameters) || subject
    } catch (error) {
        ec.message.clearErrors()
    }
    let body = ""
    let problem = ""
    if (template.bodyScreenLocation) {
        for (const mode of ["text", "html"]) {
            try {
                body = ec.screen
                    .makeRender()
                    .rootScreen(template.bodyScreenLocation)
                    .renderMode(mode)
                    .parameters(Object.assign({}, parameters, {bodyParameters: parameters, title: parameters.title}))
                    .render()
                if (text(body)) break
            } catch (error) {
                ec.message.clearErrors()
                problem = "The body could not be rendered: " + String(error.message).split("\n")[0]
            }
        }
    }
    return {subject, body: text(body), toText: masked(found.email), problem: text(body) ? "" : problem}
}
// get#CartRecovery (CartDetail's RecoveryHistory): the cart's eligibility and its reason, the consent state, the store's
// policy, the prior sends on the ledger (the address masked, redeemed when the link was spent after it), whether the user may
// send, and with preview (COMMERCE_RECOVERY, an eligible cart) the exact body.
function getRecovery(p) {
    const s = staffScope()
    const {order, store} = cartOf(s, p.orderId)
    const facts = factsOf(order)
    const found = eligibility(store, facts, policyOf(store.productStoreId))
    const canRecovery = access.has("COMMERCE_RECOVERY")
    const usedMs = ms(facts.access?.recoveryUsedDate)
    const sends = sendsOf(order.orderId).map((row, index) =>
        Object.assign(operations().deliveryRow(row), {
            channelText: enumText(row.channelEnumId),
            sentBy: lib.json(row.parametersJson, {})?.sentBy === "job" ? "Recovery job" : "Staff",
            redeemed: index === 0 && usedMs != null && usedMs >= (ms(row.sentDate) ?? Infinity)
        })
    )
    return {
        orderId: order.orderId,
        orderRevision: String(order.orderRevision || 1),
        eligible: found.eligible,
        reasonCode: found.code,
        reasonText: found.text,
        consentText: !facts.access?.customerPartyId
            ? "A guest: never asked"
            : found.consent
              ? "Cart reminders on"
              : "Cart reminders off",
        recipientText: found.email ? masked(found.email) : "",
        redeemedText: usedMs != null ? dateText(facts.access.recoveryUsedDate) : "",
        policy: policyView(store),
        sends,
        canSend: canRecovery && found.eligible,
        preview: p.preview && canRecovery && found.eligible ? previewOf(store, facts, found) : null
    }
}
// send#CartRecovery (RecoverCart): one recovery of an eligible cart, with its reason, an operation key (a retry answers the
// first) and the cart's revision as CartDetail showed it. COMMERCE_RECOVERY.
function sendRecovery(p) {
    const s = staffScope()
    if (!access.has("COMMERCE_RECOVERY")) denied("PERMISSION_DENIED", "COMMERCE_RECOVERY is required")
    const {order, store} = cartOf(s, p.orderId)
    const op = lib.operation(p, "CartRecovery", store.organizationPartyId || null, {orderId: order.orderId})
    const again = lib.previous(op)
    if (again) return again
    const why = text(p.reason)
    if (!why) denied("REASON_REQUIRED", "Give a reason for the send")
    if (why.length > 255) denied("VALUE_INVALID", "The reason is at most 255 characters")
    const revision = String(order.orderRevision || 1)
    if (text(p.orderRevision) && text(p.orderRevision) !== revision)
        denied("STALE_REVISION", "Cart " + order.orderId + " changed since; its current revision is " + revision)
    const found = eligibility(store, factsOf(order), policyOf(store.productStoreId))
    if (!found.eligible) denied(found.code, found.text)
    const out = lib.probe(SERVICES + "queue#CartRecovery", {orderId: order.orderId, sentBy: ec.user.userId, reason: why})
    if (!out.deliveryId) denied(out.code || "NOT_SENT", out.text || "The recovery was not sent")
    const delivery = one(DELIVERY, {deliveryId: out.deliveryId})
    const answer = {
        orderId: order.orderId,
        deliveryId: out.deliveryId,
        stateEnumId: delivery?.stateEnumId || out.stateEnumId || null,
        stateText: enumText(delivery?.stateEnumId || out.stateEnumId),
        message: "Recovery of cart " + order.orderId + ": " + enumText(delivery?.stateEnumId || out.stateEnumId)
    }
    lib.complete(op, DELIVERY, out.deliveryId, answer)
    return answer
}
// get#CartRecoveryPolicy (CheckoutSettings' RecoveryPolicy): the policy's dated settings (each value, default, later change),
// the binding, and F118's checkout opt-ins and news list. COMMERCE_VIEW and the store scope.
function getRecoveryPolicy(p) {
    const s = admin().scope()
    const store = admin().storeOf(s, p.productStoreId)
    const values = storeCheckout().settingsOf(store, Object.assign({}, policy, consentPolicy), nowMs())
    const view = policyView(store)
    const optIns = text(values.checkoutOptIns)
    const list = values.newsListId ? one("mantle.marketing.contact.ContactList", {contactListId: values.newsListId}) : null
    return {
        productStoreId: store.productStoreId,
        values,
        view: Object.assign(view, {
            checkoutOptInsText: !optIns
                ? "Review requests and cart reminders, and news once a list is set"
                : optIns === "none"
                  ? "None"
                  : optIns
                        .split(",")
                        .map(id => optInTexts[id] || id)
                        .join(", "),
            newsListText: list ? list.contactListName || list.contactListId : "None"
        }),
        canEdit: s.canEdit
    }
}
// store#CartRecoveryPolicy: the policy's fields (and F118's opt-ins and news list) from a date, each changed one a new dated
// setting ending the one it replaces, with the change's reason; COMMERCE_STORE_EDIT and the store scope.
function storeRecoveryPolicy(p) {
    const s = admin().scope("edit")
    const store = admin().storeOf(s, p.productStoreId)
    return storeCheckout().storeSettings(store, Object.assign({}, policy, consentPolicy), p)
}

const ops = {
    queueRecovery,
    runRecovery,
    buildRecovery,
    recoverCart,
    getRecovery,
    sendRecovery,
    getRecoveryPolicy,
    storeRecoveryPolicy
}
;({
    policy,
    consentPolicy,
    limits,
    policyOf,
    delayOf,
    execute: (op, parameters) => {
        if (!ops[op]) throw new Error("Unknown cart recovery operation " + op)
        return ops[op](parameters || {})
    }
})
