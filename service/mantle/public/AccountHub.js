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
 *   get recovery).
 * Reads and writes are the authority's own (authorization disabled), after these checks.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const {find, one, rows, call, ms} = lib
const CONSENT = "mantle.party.PartyConsent"
const SETTING = "mantle.product.store.ProductStoreSetting"
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
function emailVerified() {
    const account = ec.user.userAccount
    const email = text(account?.emailAddress).toLowerCase()
    return (
        !!email &&
        rows("moqui.security.public.VerifiedAddress", {userId: account.userId}).some(
            row => !!row.verifiedAt && text(row.emailAddress).toLowerCase() === email
        )
    )
}
// ===== a store's cart reminders topic =====
// The store's topic list (a ContactList of type CART_REMINDER, named by the store's PsstCartReminderList setting), made
// when first needed.
function cartReminderList(productStoreId, create) {
    const current = rows(SETTING, {productStoreId, settingTypeEnumId: "PsstCartReminderList"}).find(row => lib.active(row))
    if (current?.settingValue && one("mantle.marketing.contact.ContactList", {contactListId: current.settingValue}))
        return current.settingValue
    if (!create) return null
    const store = one("mantle.product.store.ProductStore", {productStoreId})
    const contactListId = call("create#mantle.marketing.contact.ContactList", {
        contactListTypeEnumId: "CART_REMINDER",
        contactMechTypeEnumId: "CmtEmailAddress",
        contactListName: "Cart reminders: " + (store?.storeName || productStoreId),
        description: "Reminders of a cart left in " + (store?.storeName || productStoreId),
        ownerPartyId: store?.organizationPartyId || null,
        isPublic: "N"
    }).contactListId
    call("create#" + SETTING, {
        productStoreId,
        settingTypeEnumId: "PsstCartReminderList",
        fromDate: ec.user.nowTimestamp,
        settingValue: contactListId
    })
    return contactListId
}
// Whether a party has the store's cart reminders turned on: its latest consent row of the topic is a grant.
function cartReminderOn(partyId, productStoreId) {
    const contactListId = cartReminderList(productStoreId, false)
    if (!partyId || !contactListId) return false
    const latest = Array.from(
        find(CONSENT, {partyId, purposeEnumId: "PcpCartReminder", contactListId})
            .orderBy("-consentDate")
            .orderBy("-partyConsentId")
            .limit(1)
            .list()
    )[0]
    return latest?.statusId === "PconGranted"
}
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
    const lists = rows("mantle.marketing.contact.ContactListParty", {partyId})
        .filter(row => lib.active(row))
        .map(row => ({row, list: one("mantle.marketing.contact.ContactList", {contactListId: row.contactListId})}))
        .filter(
            ({list}) =>
                list &&
                list.contactListTypeEnumId !== "CART_REMINDER" &&
                list.contactListTypeEnumId !== "MAILBOX" &&
                !list.archivedDate
        )
        .map(({row, list}) => ({
            contactListId: list.contactListId,
            name: list.contactListName || "",
            description: list.description || "",
            subscribed: !["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"].includes(row.statusId),
            pending: row.statusId === "CLPT_UNSUBS_PENDING",
            fromLink: false
        }))
    return {
        mode: "account",
        emailAddress: ec.user.userAccount.emailAddress || "",
        lists,
        topics: siteStores(site.siteId).map(store => ({
            topicId: "cartReminders:" + store.productStoreId,
            name: "Cart reminders from " + (store.storeName || "this store"),
            description: "An email when you leave items in your cart",
            on: cartReminderOn(partyId, store.productStoreId)
        })),
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
    for (const [contactListId, subscribed] of Object.entries(choices.lists || {})) {
        const row = rows("mantle.marketing.contact.ContactListParty", {partyId, contactListId: text(contactListId)}).find(item =>
            lib.active(item)
        )
        if (!row || on(subscribed)) continue
        call("mantle.party.ConsentServices.unsubscribe#ContactListParty", {contactListId: row.contactListId, partyId})
    }
    const stores = siteStores(site.siteId)
    for (const [topicId, wanted] of Object.entries(choices.topics || {})) {
        const store = stores.find(row => "cartReminders:" + row.productStoreId === topicId)
        if (!store || on(wanted) === cartReminderOn(partyId, store.productStoreId)) continue
        // a reminder goes to the account's address, so turning one on needs that address verified (Shop P6 review); turning
        // one off never does
        if (on(wanted) && !emailVerified())
            refuse("Unauthorized", "VERIFY_REQUIRED", "Verify your email address to turn on cart reminders")
        call("mantle.party.ConsentServices.store#PartyConsent", {
            partyId,
            purposeEnumId: "PcpCartReminder",
            statusId: on(wanted) ? "PconGranted" : "PconWithdrawn",
            contactListId: cartReminderList(store.productStoreId, true),
            sourceEnumId: "PcsForm",
            evidenceText: "Email preferences of site " + site.siteId
        })
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

const operations = {getAccountHub, getEmailPreferences, storeEmailPreferences, oneClick, checkCartReminder}
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
