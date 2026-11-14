/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The PASS Account hub and email preferences (mr-pass impl-shop P6, F6; design-shop §9 Shared account screens, design-forum
 * §8, design-crosscut §5.1, X6, X15), built here as the PASS Account foundation's.
 *
 * - The hub (get#AccountHub): one card per app the site mounts that registers one (PublicApps' accountCard: Shop's
 *   AccountOverview summary, Billing's invoices, Support's cases and returns), each asked on its own; one that fails is
 *   named and the others still show.
 * - Email preferences (get#/store#EmailPreferences): list unsubscribe over ConsentServices' tokens (the /u/ link's token, or
 *   the signed-in account's own lists), the topics, and a link to the Forum's opt-out. Among the topics is each store's
 *   "cart reminders" (the site's Shop store), which a signed-in customer turns on with store#PartyConsent (purpose
 *   PcpCartReminder on the store's topic list) and Commerce's cart recovery requires (check#CartReminderConsent; guests never
 *   get recovery). Commerce P9 follow-up (Nov 6): each store's "review requests" too (PcpReviewRequest), which the review
 *   request needs (check#ReviewRequestConsent); the topics and their lists are StoreTopics.js'. A checkout opt-in waiting for
 *   confirmation is confirmed here: by the receipt's link (?confirm=, read only; its button confirms) or, for a signed-in
 *   account with its email verified, on opening the page.
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const storeTopics = () => ec.resource.script("component://mr-mantle/service/mantle/public/StoreTopics.js")
const {find, one, rows, call, ms} = lib
const text = value => (value == null ? "" : String(value).trim())
function refuse(kind, code, message) {
    const error = new Error(code + ": " + message)
    error.moquiErrorKind = kind
    throw error
}
const signedIn = () => {
    if (!ec.user.userId || !ec.user.userAccount?.partyId)
        refuse("AuthenticationRequired", "SIGN_IN_REQUIRED", "Sign in to see your account")
    return ec.user.userAccount.partyId
}
function siteOf(siteId) {
    const site = siteId ? one("mantle.public.PublicSite", {siteId}) : null
    if (!site || site.state !== "published") refuse("NotFound", "NOT_AVAILABLE", "This site is not available")
    return site
}

// ===== the hub =====
// get#AccountHub: the signed-in account's cards from the apps the site mounts (each asked in a transaction of its own; one
// that fails shows that it cannot be read now), and the account's links.
function getAccountHub(p) {
    const site = siteOf(p.siteId)
    signedIn()
    const cards = []
    for (const [app, registration] of Object.entries(publicApps().apps)) {
        if (!registration.accountCard || !publicApps().mount(site.siteId, app)) continue
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name(registration.accountCard)
                    .parameters({input: {siteId: site.siteId}})
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            if (out.result) cards.push(Object.assign({app}, out.result))
        } catch (error) {
            ec.logger.warn("Account hub card " + app + " of site " + site.siteId + ": " + String(error.message).split("\n")[0])
            cards.push({app, title: app, lines: ["This cannot be shown right now."], url: null, failed: true})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const account = ec.user.userAccount
    return {
        account: {name: account.userFullName || account.username || "", emailAddress: account.emailAddress || ""},
        cards,
        links: {
            settings: publicApps().pageUrl(site.siteId, "account", "/Settings"),
            emailPreferences: publicApps().pageUrl(site.siteId, "account", "/EmailPreferences")
        }
    }
}

// Whether the signed-in account's current email address is verified (a PASS account's VerifiedAddress of it).
const emailVerified = () => ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js").currentVerified()
// ===== a store's topics (StoreTopics.js) =====
const cartReminderList = (productStoreId, create) => storeTopics().topicList("cartReminders", productStoreId, create)
const cartReminderOn = (partyId, productStoreId) => storeTopics().topicOn("cartReminders", partyId, productStoreId)
const topicOrder = ["cartReminders", "reviewRequests"]
const topicIdOf = (topic, store) => topic + ":" + store.productStoreId
// The stores whose topics a site offers: its Shop mount's store.
function siteStores(siteId) {
    const mount = publicApps().mount(siteId, "shop")
    const store = mount?.targetId ? one("mantle.product.store.ProductStore", {productStoreId: mount.targetId}) : null
    return store ? [store] : []
}

// ===== email preferences =====
// get#EmailPreferences: by a list link's token (its list and the party's other lists of that organization; anonymous),
// or for the signed-in account (its current lists, the site's store topics, and the Forum's opt-out link).
function getEmailPreferences(p) {
    const site = siteOf(p.siteId)
    const forumUrl = publicApps().mount(site.siteId, "account") ? publicApps().pageUrl(site.siteId, "account", "/Settings") : null
    // a receipt's confirmation link: read only (a mail scanner's fetch changes nothing); the page's button confirms
    if (text(p.confirm)) {
        const checkout = storeTopics().checkoutOfCode(site.siteId, p.confirm)
        if (!checkout) refuse("NotFound", "NOT_AVAILABLE", "This confirmation link is not valid or has expired")
        return Object.assign(storeTopics().confirmView(checkout), {lists: [], topics: [], forumUrl})
    }
    if (text(p.token)) {
        const resolved = call("mantle.party.ConsentServices.resolve#UnsubscribeToken", {token: text(p.token)})
        return {
            mode: "token",
            organizationName: resolved.organizationName || "",
            maskedAddress: resolved.maskedAddress || "",
            marketingWithdrawn: !!resolved.marketingWithdrawn,
            lists: Array.from(resolved.listList || []).map(list => ({
                contactListId: list.contactListId,
                name: list.contactListName || "",
                description: list.description || "",
                subscribed: !!list.subscribed,
                pending: !!list.unsubscribePending,
                fromLink: !!list.isTokenList
            })),
            topics: [],
            forumUrl
        }
    }
    const partyId = signedIn()
    const stores = siteStores(site.siteId)
    // a verified account's checkout opt-ins made with this email, waiting for confirmation, are confirmed by signing in
    if (emailVerified())
        for (const store of stores)
            confirmApart(() => storeTopics().confirmVerified(store.productStoreId, partyId, ec.user.userAccount.emailAddress))
    const lists = rows("mantle.marketing.contact.ContactListParty", {partyId})
        .filter(row => lib.active(row))
        .map(row => ({row, list: one("mantle.marketing.contact.ContactList", {contactListId: row.contactListId})}))
        .filter(
            ({list}) =>
                list &&
                !storeTopics().topicListTypes().includes(list.contactListTypeEnumId) &&
                list.contactListTypeEnumId !== "MAILBOX" &&
                !list.archivedDate
        )
        .map(({row, list}) => ({
            contactListId: list.contactListId,
            name: list.contactListName || "",
            description: list.description || "",
            subscribed: !["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING", "CLPT_PENDING"].includes(row.statusId),
            pending: row.statusId === "CLPT_UNSUBS_PENDING",
            // a checkout's opt-in waiting for its confirmation (StoreTopics.js)
            confirmPending: row.statusId === "CLPT_PENDING",
            fromLink: false
        }))
    const topics = storeTopics().topics
    return {
        mode: "account",
        emailAddress: ec.user.userAccount.emailAddress || "",
        lists,
        topics: stores.flatMap(store =>
            topicOrder
                .map(topic => ({
                    topicId: topicIdOf(topic, store),
                    name: topics[topic].name(store.storeName || "this store"),
                    description: topics[topic].description,
                    on: storeTopics().topicOn(topic, partyId, store.productStoreId)
                }))
                .map(row =>
                    Object.assign(row, {
                        confirmPending:
                            !row.on && storeTopics().topicPending(row.topicId.split(":")[0], partyId, store.productStoreId)
                    })
                )
        ),
        forumUrl
    }
}
// store#EmailPreferences: by a list link's token, the lists chosen (apply#UnsubscribePreferences: each list of the
// organization offered, or all marketing email); for the signed-in account, its lists unsubscribed or kept and the site's
// store topics turned on or off (store#PartyConsent on the store's topic list, source PcsForm). The preferences after.
function storeEmailPreferences(p) {
    const site = siteOf(p.siteId)
    const choices = typeof p.choices === "string" ? lib.json(p.choices, {}) : p.choices || {}
    const on = value => value === true || value === "true" || value === "Y" || value === "on"
    if (text(p.confirm)) {
        if (!on(choices.confirm)) return getEmailPreferences({siteId: site.siteId, confirm: p.confirm})
        const checkout = storeTopics().confirmByCode(site.siteId, p.confirm)
        if (!checkout) refuse("NotFound", "NOT_AVAILABLE", "This confirmation link is not valid or has expired")
        return getEmailPreferences({siteId: site.siteId, confirm: p.confirm})
    }
    if (text(p.token)) {
        const lists = Object.entries(choices.lists || {}).map(([contactListId, subscribed]) => ({
            contactListId,
            subscribed: on(subscribed)
        }))
        call("mantle.party.ConsentServices.apply#UnsubscribePreferences", {
            token: text(p.token),
            listChoices: lists,
            unsubscribeAll: on(choices.unsubscribeAll),
            reasonText: text(choices.reason).slice(0, 255) || null
        })
        return getEmailPreferences({siteId: site.siteId, token: p.token})
    }
    const partyId = signedIn()
    // F124: a pending checkout choice declined on the page (its decline box, never an unchecked box: a pending choice shows
    // unchecked) ends that pending membership, so neither the receipt's link nor a verified sign-in confirms it later
    const declined = choices.decline || {}
    const listOf = value => (Array.isArray(value) ? value : value ? [value] : []).map(text).filter(Boolean)
    for (const contactListId of listOf(declined.lists)) storeTopics().declinePending(contactListId, partyId)
    const declineStores = siteStores(site.siteId)
    for (const topicId of listOf(declined.topics)) {
        const [topic, productStoreId] = topicId.split(":")
        if (topicOrder.includes(topic) && declineStores.some(row => row.productStoreId === productStoreId))
            storeTopics().endTopicPending(topic, partyId, productStoreId)
    }
    for (const [contactListId, subscribed] of Object.entries(choices.lists || {})) {
        const row = rows("mantle.marketing.contact.ContactListParty", {partyId, contactListId: text(contactListId)}).find(item =>
            lib.active(item)
        )
        // a checkout opt-in waiting for its confirmation is not a subscription to end
        if (!row || on(subscribed) || row.statusId === "CLPT_PENDING") continue
        call("mantle.party.ConsentServices.unsubscribe#ContactListParty", {contactListId: row.contactListId, partyId})
    }
    const stores = siteStores(site.siteId)
    for (const [topicId, wanted] of Object.entries(choices.topics || {})) {
        const [topic, productStoreId] = text(topicId).split(":")
        const store = topicOrder.includes(topic) ? stores.find(row => row.productStoreId === productStoreId) : null
        if (!store || on(wanted) === storeTopics().topicOn(topic, partyId, store.productStoreId)) continue
        // a topic's email goes to the account's address, so turning one on needs that address verified (Shop P6 review);
        // turning one off never does
        if (on(wanted) && !emailVerified())
            refuse(
                "Unauthorized",
                "VERIFY_REQUIRED",
                "Verify your email address to turn on " + (topic === "cartReminders" ? "cart reminders" : "review requests")
            )
        call("mantle.party.ConsentServices.store#PartyConsent", {
            partyId,
            purposeEnumId: storeTopics().topics[topic].purposeEnumId,
            statusId: on(wanted) ? "PconGranted" : "PconWithdrawn",
            contactListId: storeTopics().topicList(topic, store.productStoreId, true),
            sourceEnumId: "PcsForm",
            evidenceText: "Email preferences of site " + site.siteId
        })
        // turned off here: a checkout's choice still waiting is not confirmed later
        if (!on(wanted)) storeTopics().endTopicPending(topic, partyId, store.productStoreId)
    }
    return getEmailPreferences({siteId: site.siteId})
}
// apply#OneClickUnsubscribe: RFC 8058's one-click POST to a list link: the token's list unsubscribed.
function oneClick(p) {
    siteOf(p.siteId)
    const resolved = call("mantle.party.ConsentServices.resolve#UnsubscribeToken", {token: text(p.token)})
    call("mantle.party.ConsentServices.apply#UnsubscribePreferences", {
        token: text(p.token),
        listChoices: [{contactListId: resolved.contactListId, subscribed: false}]
    })
    return {unsubscribed: true}
}
// check#CartReminderConsent (Commerce's cart recovery, impl-commerce P10): whether a party turned on a store's cart
// reminders; never true for a party with no account (a guest).
function checkCartReminder(p) {
    const hasAccount = !!p.partyId && find("moqui.security.UserAccount", {partyId: p.partyId}).count() > 0
    return {consented: hasAccount && cartReminderOn(p.partyId, p.productStoreId)}
}
// check#ReviewRequestConsent (the review request, Commerce P9 follow-up): whether a party has a store's review requests on;
// a guest's confirmed checkout opt-in counts (the request's page asks them to sign in to write the review).
function checkReviewRequest(p) {
    return {consented: !!p.partyId && storeTopics().topicOn("reviewRequests", p.partyId, p.productStoreId)}
}
// A confirmation apart from the page (each opt-in is granted in a transaction of its own): one that fails is logged and the
// page still shows.
function confirmApart(work) {
    ec.message.pushErrors()
    try {
        work()
    } catch (error) {
        ec.logger.error("Checkout opt-ins not confirmed: " + String(error.message).split("\n")[0])
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

const operations = {getAccountHub, getEmailPreferences, storeEmailPreferences, oneClick, checkCartReminder, checkReviewRequest}
;({
    cartReminderOn,
    cartReminderList,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown account hub operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
