/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * A store's email topics and its checkout opt-ins (impl-commerce P9 follow-up, Nov 6; design-shop §6 Checkout, §9
 * EmailPreferences, §11 Delivery; design-commerce §4 Reviews; X15), for the PASS Account email preferences (AccountHub.js),
 * Shop's checkout (ShopCheckout.js), the review request (StoreReviews.js) and the order receipt (send#OrderStoreEmail).
 *
 * - Topics: a store's "cart reminders" (Shop P6) and "review requests", each a contact list of its own (its type, named by
 *   a store setting, made when first needed) whose state for a party is its latest PartyConsent of the topic's purpose on
 *   that list. The review request is sent only with its topic granted; cart recovery only to an account with its topic.
 * - Checkout opt-ins: the store offers some of reviewRequests, cartReminders (to a signed-in buyer whose account email is
 *   verified only: a guest's cart is never recovered, and a reminder goes to the account's address) and news (its marketing list, only when PsstNewsList names one), by PsstCheckoutOptIns (absent: all
 *   three, news only with its list; "none": none). Each is unchecked until the buyer checks it, and says what it is and is
 *   not. The order's receipt and notices are transactional whatever is chosen.
 * - Recording, at placement: a signed-in buyer whose account email is verified and is the checkout's gets each choice granted
 *   (store#PartyConsent on a topic's list; set#ContactListPartySubscription on the news list). Anyone else's choice waits as
 *   Mantle's pending membership (ContactListParty CLPT_PENDING on the list), never sent to, until it is confirmed: by the
 *   link in the order receipt (make#OptInConfirmLink: a code whose digest the checkout keeps; the page reads, its button
 *   confirms, so a mail scanner's fetch changes nothing) or, for a choice checked while signed in, by the account signing
 *   in with the checkout's email verified (the account pages' claim, the email preferences page); a claimed guest's choice
 *   only by the link. Mantle's PartyConsent has no pending state; the list's pending
 *   membership is the existing one.
 * Reads and writes are the authority's own (authorization disabled by the callers), after their checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, ms, active, json, probe} = lib
const CONSENT = "mantle.party.PartyConsent"
const CLP = "mantle.marketing.contact.ContactListParty"
const LIST = "mantle.marketing.contact.ContactList"
const SETTING = "mantle.product.store.ProductStoreSetting"
const STORE = "mantle.product.store.ProductStore"
const C = "mantle.order.StoreCheckout"
const SERVICES = "mantle.public.AccountHubServices."

// ===== tables =====
// A store's topics: the consent purpose, the list's type and the store setting naming it, and the texts of the email
// preferences page.
const topics = {
    cartReminders: {
        purposeEnumId: "PcpCartReminder",
        listTypeEnumId: "CART_REMINDER",
        settingTypeEnumId: "PsstCartReminderList",
        listName: store => "Cart reminders: " + store,
        listDescription: store => "Reminders of a cart left in " + store,
        name: store => "Cart reminders from " + store,
        description: "An email when you leave items in your cart"
    },
    reviewRequests: {
        purposeEnumId: "PcpReviewRequest",
        listTypeEnumId: "REVIEW_REQUEST",
        settingTypeEnumId: "PsstReviewRequestList",
        listName: store => "Review requests: " + store,
        listDescription: store => "Requests to review an item bought in " + store,
        name: store => "Review requests from " + store,
        description: "One email per item you bought, after it arrives, asking for your review; no offers"
    }
}
// The checkout's opt-ins, in the order shown: each a plain statement of what it is and what it is not.
const optIns = {
    reviewRequests: {
        topic: "reviewRequests",
        label: () => "Ask me to review what I bought",
        statement: "One email per item after it arrives; no offers or newsletters."
    },
    cartReminders: {
        topic: "cartReminders",
        accountOnly: true,
        label: () => "Remind me about a cart I leave",
        statement: "This store only, about items left in your cart while signed in; no newsletters."
    },
    news: {
        label: store => "Send me news and offers from " + store,
        statement: "This store's marketing email; unsubscribe from any message. Not needed for your order."
    }
}
const defaultOptIns = ["reviewRequests", "cartReminders", "news"]
const limits = {confirmDays: 60}
const subscribedStatuses = ["CLPT_ACCEPTED", "CLPT_IN_USE"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const nameOf = store => store?.storeName || store?.productStoreId || "this store"
const settingOf = (productStoreId, settingTypeEnumId) =>
    rows(SETTING, {productStoreId, settingTypeEnumId}).find(row => active(row)) || null
const currentRows = (contactListId, partyId) =>
    Array.from(find(CLP, {contactListId, partyId}).orderBy("-fromDate").list()).filter(row => active(row))
const masked = email => {
    const [local, domain] = text(email).split("@")
    return domain ? local.slice(0, 1) + "***@" + domain : ""
}

// ===== topics =====
// A store's topic list (by its setting), made when first needed.
function topicList(topicId, productStoreId, create) {
    const topic = topics[topicId]
    const current = settingOf(productStoreId, topic.settingTypeEnumId)
    if (current?.settingValue && one(LIST, {contactListId: current.settingValue})) return current.settingValue
    if (!create) return null
    const store = one(STORE, {productStoreId})
    const contactListId = call("create#" + LIST, {
        contactListTypeEnumId: topic.listTypeEnumId,
        contactMechTypeEnumId: "CmtEmailAddress",
        contactListName: topic.listName(nameOf(store)),
        description: topic.listDescription(nameOf(store)),
        ownerPartyId: store?.organizationPartyId || null,
        isPublic: "N"
    }).contactListId
    call("create#" + SETTING, {
        productStoreId,
        settingTypeEnumId: topic.settingTypeEnumId,
        fromDate: ec.user.nowTimestamp,
        settingValue: contactListId
    })
    return contactListId
}
// Whether a party has a store's topic on: its latest consent of the topic's purpose on the list is a grant.
function topicOn(topicId, partyId, productStoreId) {
    const contactListId = topicList(topicId, productStoreId, false)
    if (!partyId || !contactListId) return false
    const latest = Array.from(
        find(CONSENT, {partyId, purposeEnumId: topics[topicId].purposeEnumId, contactListId})
            .orderBy("-consentDate")
            .orderBy("-partyConsentId")
            .limit(1)
            .list()
    )[0]
    return latest?.statusId === "PconGranted"
}
// Whether a party's choice of a topic waits for its confirmation (a current pending membership of the list).
function topicPending(topicId, partyId, productStoreId) {
    const contactListId = topicList(topicId, productStoreId, false)
    return !!partyId && !!contactListId && currentRows(contactListId, partyId).some(row => row.statusId === "CLPT_PENDING")
}
// The list types of the topics (left out of the account's own lists on the preferences page).
const topicListTypes = () => Object.values(topics).map(topic => topic.listTypeEnumId)

// The store's news list: the current list PsstNewsList names, not archived.
function newsList(productStoreId) {
    const value = settingOf(productStoreId, "PsstNewsList")?.settingValue
    const list = value ? one(LIST, {contactListId: value}) : null
    if (!list || (list.archivedDate && ms(list.archivedDate) <= ms(ec.user.nowTimestamp))) return null
    return list.contactListId
}
const listOf = (optInId, productStoreId, create) =>
    optInId === "news" ? newsList(productStoreId) : topicList(optIns[optInId].topic, productStoreId, create)
function optInOn(optInId, partyId, productStoreId) {
    if (optInId !== "news") return topicOn(optIns[optInId].topic, partyId, productStoreId)
    const contactListId = newsList(productStoreId)
    return !!contactListId && currentRows(contactListId, partyId).some(row => subscribedStatuses.includes(row.statusId))
}

// ===== the checkout's opt-ins =====
// The opt-ins a store offers a checkout: cart reminders only to a signed-in buyer whose account email is verified (a
// guest's cart is never recovered, and a reminder goes to the account's address, which Shop P6 review R2 requires verified).
function offered(store, checkout) {
    const value = text(settingOf(store.productStoreId, "PsstCheckoutOptIns")?.settingValue)
    const named = value ? (value === "none" ? [] : value.split(",").map(text)) : defaultOptIns
    const accountOnly = named.some(id => optIns[id]?.accountOnly)
    const verifiedAccount = accountOnly && checkout.accountCheckout === "Y" && verifiedAccountOf(checkout.customerPartyId)
    return defaultOptIns.filter(
        id =>
            named.includes(id) &&
            (!optIns[id].accountOnly || verifiedAccount) &&
            (id !== "news" || !!newsList(store.productStoreId))
    )
}
const stateOf = checkout => json(checkout?.optInsJson, {}) || {}
const chosenOf = checkout => Array.from(stateOf(checkout).chosen || [])
// The checkout view's opt-ins: each offered one, chosen only as the buyer chose it (never pre-checked), with an account's
// topic already on said so.
function checkoutView(checkout) {
    const store = one(STORE, {productStoreId: checkout.productStoreId})
    if (!store) return []
    const account = checkout.accountCheckout === "Y"
    const chosen = chosenOf(checkout)
    return offered(store, checkout).map(id => ({
        optInId: id,
        label: optIns[id].label(nameOf(store)),
        statement: optIns[id].statement,
        chosen: chosen.includes(id),
        alreadyOn: account && optInOn(id, checkout.customerPartyId, store.productStoreId)
    }))
}
// The opt-ins a submit asks for (a list, a comma list or JSON), each once, sorted: the request as sent, for its operation
// identity (a submit asking none is the request it was before opt-ins).
function askedOf(requested) {
    let asked = requested
    if (typeof asked === "string") asked = text(asked).startsWith("[") ? json(asked, []) : text(asked).split(",")
    return [
        ...new Set(
            Array.from(asked || [])
                .map(text)
                .filter(id => id)
        )
    ].sort()
}
// The opt-ins a submit asks for, kept to those the store offers this checkout.
function chosenFrom(checkout, requested) {
    const asked = askedOf(requested)
    const store = asked.length ? one(STORE, {productStoreId: checkout.productStoreId}) : null
    return store ? offered(store, checkout).filter(id => asked.includes(id)) : []
}
// Whether a party has an account whose verified email is this address.
function verifiedFor(partyId, email) {
    const address = text(email).toLowerCase()
    if (!partyId || !address) return false
    return rows("moqui.security.UserAccount", {partyId}).some(
        account =>
            text(account.emailAddress).toLowerCase() === address &&
            rows("moqui.security.public.VerifiedAddress", {userId: account.userId}).some(
                row => !!row.verifiedAt && text(row.emailAddress).toLowerCase() === address
            )
    )
}
// Whether a party has an account whose own email is verified.
function verifiedAccountOf(partyId) {
    return !!partyId && rows("moqui.security.UserAccount", {partyId}).some(account => verifiedFor(partyId, account.emailAddress))
}
// The checkout's email contact, when it is the party's.
function contactOf(checkout) {
    const mechId = checkout.emailContactMechId
    return mechId &&
        rows("mantle.party.contact.PartyContactMech", {partyId: checkout.customerPartyId, contactMechId: mechId}).length
        ? mechId
        : null
}
// One opt-in of a checkout's party applied (apply#CheckoutOptIn, a transaction of its own each): pend (a pending
// membership of the list) or grant (the topic's consent, the news list's subscription). {outcome}: pending, granted,
// already (on before).
function applyOptIn(p) {
    const optInId = text(p.optInId)
    if (!optIns[optInId]) throw new Error("Unknown checkout opt-in " + optInId)
    const partyId = text(p.partyId)
    const productStoreId = text(p.productStoreId)
    const contactListId = listOf(optInId, productStoreId, true)
    if (!partyId || !contactListId) throw new Error("Opt-in " + optInId + " has no list in store " + productStoreId)
    // a confirmation grants only what still waits (the buyer may have turned it off on the preferences page since)
    if (p.mode === "grant" && (p.requirePending === true || p.requirePending === "true")) {
        if (!currentRows(contactListId, partyId).some(row => row.statusId === "CLPT_PENDING")) return {outcome: "withdrawn"}
    }
    if (optInOn(optInId, partyId, productStoreId)) {
        if (p.mode === "grant") endPending(contactListId, partyId)
        return {outcome: "already"}
    }
    const contactMechId = text(p.contactMechId) || null
    if (p.mode === "pend") {
        const current = currentRows(contactListId, partyId)
        if (current.some(row => row.statusId === "CLPT_PENDING")) return {outcome: "pending"}
        // an earlier current row (unsubscribed, rejected) is ended, and the choice waits on a row of its own
        for (const row of current)
            call("update#" + CLP, {contactListId, partyId, fromDate: row.fromDate, thruDate: ec.user.nowTimestamp})
        call("create#" + CLP, {
            contactListId,
            partyId,
            fromDate: ec.user.nowTimestamp,
            statusId: "CLPT_PENDING",
            preferredContactMechId: contactMechId,
            revision: 1
        })
        return {outcome: "pending"}
    }
    if (p.mode !== "grant") throw new Error("Unknown opt-in mode " + p.mode)
    if (optInId === "news") {
        call("mantle.party.ConsentServices.set#ContactListPartySubscription", {
            contactListId,
            partyId,
            subscribe: true,
            contactMechId,
            sourceEnumId: p.sourceEnumId,
            evidenceText: text(p.evidenceText) || null
        })
        return {outcome: "granted"}
    }
    endPending(contactListId, partyId)
    call("mantle.party.ConsentServices.store#PartyConsent", {
        partyId,
        purposeEnumId: topics[optIns[optInId].topic].purposeEnumId,
        statusId: "PconGranted",
        contactListId,
        contactMechId,
        sourceEnumId: p.sourceEnumId,
        evidenceText: text(p.evidenceText) || null,
        updateSolicitation: false
    })
    return {outcome: "granted"}
}
// A topic's pending choice ended (the preferences page turned the topic off).
function endTopicPending(topicId, partyId, productStoreId) {
    const contactListId = topicList(topicId, productStoreId, false)
    if (contactListId && partyId) endPending(contactListId, partyId)
}
// A party's own pending membership of a list declined (F124: the preferences page's decline of a checkout's news choice);
// a list with no pending membership of the party is left as it is.
function declinePending(contactListId, partyId) {
    if (contactListId && partyId) endPending(contactListId, partyId)
}
function endPending(contactListId, partyId) {
    for (const row of currentRows(contactListId, partyId))
        if (row.statusId === "CLPT_PENDING")
            call("update#" + CLP, {contactListId, partyId, fromDate: row.fromDate, thruDate: ec.user.nowTimestamp})
}
// Each chosen opt-in of a checkout applied in a transaction of its own (one that fails is logged and named failed); the
// outcomes kept on the checkout. {outcome}.
function applyAll(checkout, ids, mode, sourceEnumId, evidenceText, requirePending = false) {
    const outcome = {}
    const contactMechId = contactOf(checkout)
    for (const optInId of ids) {
        try {
            outcome[optInId] = probe(SERVICES + "apply#CheckoutOptIn", {
                optInId,
                mode,
                partyId: checkout.customerPartyId,
                productStoreId: checkout.productStoreId,
                contactMechId,
                sourceEnumId,
                evidenceText,
                requirePending
            }).outcome
        } catch (error) {
            ec.logger.error(
                "Checkout " + checkout.checkoutId + " opt-in " + optInId + " not applied: " + String(error.message).split("\n")[0]
            )
            outcome[optInId] = "failed"
        }
    }
    return outcome
}
const evidenceOf = (checkout, optInId, how) =>
    "Checkout of order " +
    checkout.orderId +
    ": " +
    optIns[optInId].label("the store") +
    " (" +
    optIns[optInId].statement +
    ") " +
    how
// record: at placement, the checkout's chosen opt-ins granted for a buyer whose verified account email is the checkout's,
// else pending; once (a checkout with its outcomes is left).
function recordCheckout(checkout) {
    const state = stateOf(checkout)
    const chosen = Array.from(state.chosen || [])
    if (!chosen.length || state.outcome) return {outcome: state.outcome || {}}
    const verified = checkout.accountCheckout === "Y" && verifiedFor(checkout.customerPartyId, checkout.contactEmail)
    const outcome = {}
    for (const optInId of chosen) {
        Object.assign(
            outcome,
            applyAll(
                checkout,
                [optInId],
                verified ? "grant" : "pend",
                "PcsForm",
                evidenceOf(checkout, optInId, verified ? "checked at checkout" : "checked at checkout, to be confirmed")
            )
        )
    }
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        optInsJson: JSON.stringify({chosen, outcome, recordedDate: ms(ec.user.nowTimestamp)}),
        optInPending: Object.values(outcome).includes("pending") ? "Y" : "N"
    })
    return {outcome}
}
// The pending choices of a checkout confirmed (the receipt's link, or a verified sign-in): each granted, the checkout's
// outcomes kept. {outcome}.
function confirmCheckout(checkout, sourceEnumId, how) {
    const state = stateOf(checkout)
    const outcome = Object.assign({}, state.outcome || {})
    const waiting = Object.keys(outcome).filter(id => outcome[id] === "pending")
    for (const optInId of waiting)
        Object.assign(outcome, applyAll(checkout, [optInId], "grant", sourceEnumId, evidenceOf(checkout, optInId, how), true))
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        optInsJson: JSON.stringify(Object.assign({}, state, {outcome, confirmedDate: ms(ec.user.nowTimestamp)})),
        optInPending: Object.values(outcome).includes("pending") ? "Y" : "N"
    })
    return {outcome}
}
// A verified account's own pending checkout choices of a store (checked while signed in to it), made with that verified
// email, confirmed (the account pages' claim and the email preferences page call this after the account's verified email
// is known). A claimed guest checkout's choice is not: whoever checked it was not signed in, so only the receipt's link
// (or the account turning the topic on itself) confirms it. {confirmed}.
function confirmVerified(productStoreId, partyId, email) {
    const address = text(email).toLowerCase()
    if (!productStoreId || !partyId || !address) return {confirmed: 0}
    // one indexed read on each account page; the verification is read only when a choice waits
    const waiting = rows(C, {customerPartyId: partyId, optInPending: "Y", productStoreId}).filter(
        checkout => checkout.accountCheckout === "Y" && text(checkout.contactEmail).toLowerCase() === address
    )
    if (!waiting.length || !verifiedFor(partyId, address)) return {confirmed: 0}
    let confirmed = 0
    for (const checkout of waiting) {
        confirmCheckout(checkout, "PcsForm", "confirmed by signing in with the verified email")
        confirmed++
    }
    return {confirmed}
}

// ===== the receipt's confirmation link =====
// make#OptInConfirmLink (send#OrderStoreEmail's receipt, PsetOrderPlaced): a Shop order whose checkout has a pending
// choice gets a new code (its digest kept on the checkout; the code only in the message) and the site's email preferences
// link carrying it; any other order, or a site without Account, none. {confirmUrl}.
function makeConfirmLink(p) {
    const checkout = text(p.orderId) ? one(C, {orderId: text(p.orderId), statusId: "ScoCompleted"}) : null
    if (!checkout || checkout.optInPending !== "Y") return {}
    const code = checkout.checkoutId + "." + ec.user.randomString(32)
    const confirmUrl = publicApps().pageUrl(checkout.siteId, "account", "/EmailPreferences?confirm=" + encodeURIComponent(code))
    if (!confirmUrl) return {}
    call("update#" + C, {
        checkoutId: checkout.checkoutId,
        optInCodeDigest: ec.user.singleUseCodeHash(code),
        optInCodeDate: ec.user.nowTimestamp
    })
    return {confirmUrl}
}
// The checkout a confirmation code names, on this site, while its code is current (60 days), else null.
function checkoutOfCode(siteId, code) {
    const value = text(code)
    const match = /^([A-Za-z0-9_-]{1,40})\.([A-Za-z0-9_-]{16,128})$/.exec(value)
    if (!match) return null
    const checkout = one(C, {checkoutId: match[1]})
    if (!checkout || checkout.siteId !== siteId || !checkout.optInCodeDigest) return null
    if (checkout.optInCodeDigest !== ec.user.singleUseCodeHash(value)) return null
    if (ms(ec.user.nowTimestamp) - (ms(checkout.optInCodeDate) ?? 0) > limits.confirmDays * 86400000) return null
    return checkout
}
// The confirmation page's view: the store, the masked address and each choice with its state.
function confirmView(checkout) {
    const store = one(STORE, {productStoreId: checkout.productStoreId})
    const outcome = stateOf(checkout).outcome || {}
    return {
        mode: "confirm",
        storeName: nameOf(store),
        maskedAddress: masked(checkout.contactEmail),
        confirmed: checkout.optInPending !== "Y",
        choices: Object.keys(outcome)
            .filter(id => optIns[id])
            .map(id => ({
                optInId: id,
                label: optIns[id].label(nameOf(store)),
                statement: optIns[id].statement,
                state: outcome[id]
            }))
    }
}
// The page's confirm button: the checkout's pending choices granted (source the email's link).
function confirmByCode(siteId, code) {
    const checkout = checkoutOfCode(siteId, code)
    if (!checkout) return null
    if (checkout.optInPending === "Y") confirmCheckout(checkout, "PcsEmailLink", "confirmed by the order receipt's link")
    return one(C, {checkoutId: checkout.checkoutId})
}

const operations = {applyOptIn, makeConfirmLink}
;({
    topics,
    optIns,
    limits,
    topicList,
    topicOn,
    topicPending,
    topicListTypes,
    endTopicPending,
    declinePending,
    checkoutView,
    askedOf,
    chosenFrom,
    recordCheckout,
    confirmVerified,
    checkoutOfCode,
    confirmView,
    confirmByCode,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store topic operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
