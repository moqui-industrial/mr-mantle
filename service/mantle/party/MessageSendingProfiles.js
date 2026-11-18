/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Comms' sending profiles (mantle.party.MessageServices find#SendingProfiles, get#SendingProfile, store#SendingProfile,
 * check#SendingProfile; design-marketing §12 SendingProfiles, §14.1; impl-marketing P6, F13, F76; Comms' owner contract,
 * design-drawers-commons' Mailboxes row): the business use of infrastructure Admin approved.
 *
 * - Who: a holder of MESSAGE_SENDING_CONFIGURE reads and writes the profiles of the organizations they work for (every internal one
 *   for a system administrator or a holder of MARKETING_ALL_ORGANIZATIONS); Marketing's configurer, authors and dispatchers read
 *   them (MARKETING_CONFIGURE, MARKETING_SEND_EDIT, MARKETING_DISPATCH), to see readiness and choose one. Another organization's
 *   profile answers as missing.
 * - The relay is chosen from what Admin approved: an EmailServer no mail account owns (design-admin §9), named by its id; no answer
 *   carries a host, port, user or credential, and a profile never changes the relay.
 * - Readiness (design §12 SenderReadiness): the profile in effect; the relay there, not a mail account's, not disabled, with a host,
 *   its last Admin test not failed; the sender an address, its domain one this server signs (a hosted account's domain or
 *   mail-delivery/dkim@domains) or sent through a relay whose Admin test passed; the bounce account (a hosted or shared mail account
 *   bounces@ the bounce domain, which receives bounces+(delivery)@ that domain by the listener's plus-tag lookup, F76); the
 *   unsubscribe page (the PASS site's Account Email preferences when a site is named, else the server's own /u/ page). A blocked
 *   check makes the profile not ready, with its reason and the place that fixes it (a route key: Comms' mail accounts, Admin's
 *   relays, the profile itself).
 * - forDelivery: what the ledger's attempt sends with for a delivery naming a profile (its relay, sender, reply-to and VERP
 *   bounce address; its throttle and quiet hours), or why it waits.
 * - P22: an SMS profile (channel MdcSms) is bound to one of the organization's messaging numbers instead of a relay, sender and
 *   bounce domain, ready only while the number is the organization's with a messaging bridge (MessageSms.js smsChecks), with a
 *   configured cost a segment for the estimate before approval; its deliveries go from the number (forDelivery's fromNumber).
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, denied, call, ms} = lib
const access = lib.access
const P = "mantle.party.MessageSendingProfile"
const SERVER = "moqui.basic.email.EmailServer"
const channels = {MdcEmail: "Email", MdcSms: "Text message"}
// P22: an SMS profile's number, readiness and estimate
const sms = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageSms.js")
const bounceLocal = "bounces"
const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)
const emailPattern = /^[^\s@<>,;"]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/
const domainPattern = /^(?=.{3,253}$)([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,}$/
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/
const fixRoutes = {profile: "marketingSendingProfiles", relay: "adminMailRelay", mailAccount: "mailAccount"}

// ===== scope =====
function scopeOf() {
    const all = access.systemAdmin() || access.has("MARKETING_ALL_ORGANIZATIONS")
    const configure = access.has("MESSAGE_SENDING_CONFIGURE")
    const read =
        configure ||
        access.systemAdmin() ||
        ["MARKETING_CONFIGURE", "MARKETING_SEND_EDIT", "MARKETING_DISPATCH"].some(permission => access.has(permission))
    const organizationPartyIds = !read
        ? []
        : all
          ? Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
                row => row.partyId
            )
          : marketingAccess.memberOrganizations().memberPartyIds
    return {read, configure, organizationPartyIds}
}
function reader() {
    const scope = scopeOf()
    if (!scope.read)
        denied("PERMISSION_DENIED", "Reading sending profiles needs MESSAGE_SENDING_CONFIGURE or Marketing's sending")
    return scope
}
const covers = (scope, partyId) => !!partyId && scope.organizationPartyIds.includes(partyId)
function profileOf(scope, sendingProfileId, lock = false) {
    let query = find(P, {sendingProfileId: text(sendingProfileId)})
    if (lock) query = query.forUpdate(true)
    const row = blank(sendingProfileId) ? null : query.one()
    if (!row || !covers(scope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Sending profile " + text(sendingProfileId) + " is not available")
    return row
}
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")

// ===== the relays Admin approved =====
const accountOwned = emailServerId => find("moqui.basic.email.EmailAccount", {emailServerId, ownsEmailServer: "Y"}).count() > 0
// The relays a profile may name: every EmailServer no mail account owns, by id; never a host or credential.
function relayOptions() {
    return Array.from(
        find(SERVER).selectField("emailServerId").selectField("disabled").orderBy("emailServerId").limit(200).list()
    )
        .filter(row => !accountOwned(row.emailServerId))
        .map(row => ({value: row.emailServerId, label: row.emailServerId + (row.disabled === "Y" ? " (disabled)" : "")}))
}
const lastTest = emailServerId => one("moqui.server.ConnectionCheck", {adapterKey: "relay", connectionKey: emailServerId})
// The domains this server signs with its DKIM key (moqui-mail auth.rs): mail-delivery/dkim@domains, else the hosted and
// shared accounts'.
function signedDomains() {
    let configured = ""
    try {
        configured = text(ec.factory.getConfValue("mail-delivery/dkim@domains"))
    } catch (error) {
        configured = ""
    }
    if (configured)
        return configured
            .split(",")
            .map(domain => domain.trim().toLowerCase())
            .filter(Boolean)
    return Array.from(
        new Set(
            Array.from(
                find("moqui.basic.email.EmailAccount")
                    .condition("accountKindEnumId", "in", ["EakHosted", "EakShared"])
                    .condition("statusId", "not-equals", "EasRemoved")
                    .selectField("emailAddress")
                    .list()
            )
                .map(row => text(row.emailAddress).toLowerCase().split("@")[1])
                .filter(Boolean)
        )
    )
}
// The hosted or shared mail account that receives bounces@ a domain (its address, or one of its identities'), not removed.
function bounceAccount(domain) {
    if (!domain) return null
    const address = bounceLocal + "@" + domain.toLowerCase()
    const receives = row => row && ["EakHosted", "EakShared"].includes(row.accountKindEnumId) && row.statusId !== "EasRemoved"
    const factory = ec.entity.conditionFactory
    const byAddress = Array.from(
        find("moqui.basic.email.EmailAccount")
            .condition(factory.makeCondition("emailAddress", "equals", address).ignoreCase())
            .list()
    ).find(receives)
    if (byAddress) return byAddress
    for (const identity of Array.from(
        find("moqui.basic.email.EmailIdentity")
            .condition(factory.makeCondition("emailAddress", "equals", address).ignoreCase())
            .list()
    )) {
        const account = one("moqui.basic.email.EmailAccount", {emailAccountId: identity.emailAccountId})
        if (receives(account)) return account
    }
    return null
}

// ===== readiness =====
// Each check: {checkKey, title, state (ready, warning, blocked), message, fixRoute}.
function readinessOf(profile) {
    const checks = []
    const add = (checkKey, title, state, message, fixRoute = null) => checks.push({checkKey, title, state, message, fixRoute})
    const at = nowMs()
    if ((ms(profile.fromDate) ?? -Infinity) > at || (profile.thruDate != null && ms(profile.thruDate) <= at))
        add("profile", "In effect", "blocked", "The profile is not in effect now", fixRoutes.profile)
    else add("profile", "In effect", "ready", "In effect")
    // P22: an SMS profile's number and its messaging bridge, in place of the email checks
    if (profile.channelEnumId === "MdcSms") {
        sms().smsChecks(profile, add)
        const ready = checks.every(check => check.state !== "blocked")
        return {ready, checks, reasons: checks.filter(check => check.state === "blocked").map(check => check.message)}
    }
    // transport: the relay Admin approved
    const server = blank(profile.emailServerId) ? null : one(SERVER, {emailServerId: profile.emailServerId})
    let relayTested = false
    if (!server) add("transport", "Transport", "blocked", "The relay is not there: choose one Admin approved", fixRoutes.profile)
    else if (accountOwned(server.emailServerId))
        add("transport", "Transport", "blocked", "That server belongs to a mail account, not a relay", fixRoutes.profile)
    else if (server.disabled === "Y")
        add("transport", "Transport", "blocked", "The relay " + server.emailServerId + " is disabled in Admin", fixRoutes.relay)
    else if (blank(server.smtpHost))
        add(
            "transport",
            "Transport",
            "blocked",
            "The relay " + server.emailServerId + " has no host set in Admin",
            fixRoutes.relay
        )
    else {
        const tested = lastTest(server.emailServerId)
        if (tested?.lastCheckPassed === "N")
            add("transport", "Transport", "blocked", "The relay's last test in Admin failed", fixRoutes.relay)
        else {
            relayTested = tested?.lastCheckPassed === "Y"
            add(
                "transport",
                "Transport",
                relayTested ? "ready" : "warning",
                relayTested
                    ? "The relay " + server.emailServerId + " passed its test"
                    : "The relay " + server.emailServerId + " is available, not tested in Admin",
                relayTested ? null : fixRoutes.relay
            )
        }
    }
    // the sender and its domain
    const from = text(profile.fromAddress).toLowerCase()
    if (!emailPattern.test(from)) add("sender", "Sender", "blocked", "Give the sender's address", fixRoutes.profile)
    else {
        const domain = from.split("@")[1]
        if (signedDomains().includes(domain))
            add("sender", "Sender", "ready", "Its domain " + domain + " is signed by this server")
        else if (relayTested) add("sender", "Sender", "ready", "Sent through a relay that passed its test")
        else
            add(
                "sender",
                "Sender",
                "warning",
                "Its domain " + domain + " is not one this server signs, and the relay is not tested: receivers may not trust it",
                fixRoutes.relay
            )
    }
    // the bounce account (F76): bounces+(delivery)@ the domain reach bounces@ it
    const bounceDomain = text(profile.bounceDomain).toLowerCase()
    if (!bounceDomain) add("bounce", "Bounce address", "blocked", "Give the bounce domain", fixRoutes.profile)
    else if (!bounceAccount(bounceDomain))
        add(
            "bounce",
            "Bounce address",
            "blocked",
            "No bounce account " + bounceLocal + "@" + bounceDomain + ": make it as a hosted mail account",
            fixRoutes.mailAccount
        )
    else add("bounce", "Bounce address", "ready", "Bounces come back to " + bounceLocal + "@" + bounceDomain + " and are read")
    // the unsubscribe page and the permitted site
    if (blank(profile.siteId)) add("unsubscribe", "Unsubscribe page", "ready", "The server's own unsubscribe page")
    else {
        const site = one("mantle.public.PublicSite", {siteId: profile.siteId})
        let mounted = false
        try {
            mounted =
                !!site &&
                !!ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js").mount(profile.siteId, "account")
        } catch (error) {
            mounted = false
        }
        if (!site) add("unsubscribe", "Unsubscribe page", "blocked", "The site is not there", fixRoutes.profile)
        else if (!mounted)
            add(
                "unsubscribe",
                "Unsubscribe page",
                "blocked",
                "The site " + (site.name || site.siteId) + " does not offer Account's email preferences",
                fixRoutes.profile
            )
        else add("unsubscribe", "Unsubscribe page", "ready", "The email preferences of " + (site.name || site.siteId))
    }
    const ready = checks.every(check => check.state !== "blocked")
    return {ready, checks, reasons: checks.filter(check => check.state === "blocked").map(check => check.message)}
}

// ===== projections =====
function profileDisplay(row, scope, withReadiness = true) {
    const readiness = withReadiness ? readinessOf(row) : null
    return {
        sendingProfileId: row.sendingProfileId,
        profileName: row.profileName || row.sendingProfileId,
        organizationPartyId: row.organizationPartyId,
        organizationName: organizationName(row.organizationPartyId),
        channelEnumId: row.channelEnumId,
        channelText: channels[row.channelEnumId] || enumText(row.channelEnumId),
        relayId: row.emailServerId || null,
        fromAddress: row.fromAddress || "",
        fromName: row.fromName || "",
        replyToAddress: row.replyToAddress || "",
        purposeEnumId: row.purposeEnumId || null,
        purposeText: row.purposeEnumId ? enumText(row.purposeEnumId) : "Promotional and transactional",
        throttlePerHour: row.throttlePerHour ?? null,
        quietFrom: row.quietFrom || "",
        quietThru: row.quietThru || "",
        timeZone: row.timeZone || "",
        limitsText:
            [
                row.throttlePerHour ? row.throttlePerHour + " an hour" : null,
                row.quietFrom && row.quietThru ? "quiet " + row.quietFrom + "–" + row.quietThru : null
            ]
                .filter(Boolean)
                .join(", ") || "None",
        trackingPolicyEnumId: row.trackingPolicyEnumId || null,
        trackingText: enumText(row.trackingPolicyEnumId || "MtrNone"),
        bounceDomain: row.bounceDomain || "",
        siteId: row.siteId || null,
        // P22: an SMS profile's number and its cost a segment
        fromPhoneNumber: row.fromPhoneNumber || "",
        segmentCost: row.segmentCost ?? null,
        segmentCostUomId: row.segmentCostUomId || null,
        senderText: row.channelEnumId === "MdcSms" ? row.fromPhoneNumber || "" : row.fromAddress || "",
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        lastCheckText: row.lastCheckDate
            ? lib.dateText(row.lastCheckDate) + (row.lastCheckReady === "Y" ? ", ready" : ", not ready")
            : "",
        ready: readiness ? readiness.ready : null,
        readinessText: readiness ? (readiness.ready ? "Ready" : "Not ready: " + readiness.reasons.join("; ")) : "",
        readinessColor: readiness ? (readiness.ready ? "positive" : "negative") : "grey-7",
        revision: ms(row.lastUpdatedStamp),
        canEdit: scope.configure
    }
}
// find#SendingProfiles: the profiles the caller reads, by name, each with its readiness, a page at a time.
function findProfiles(p) {
    const scope = reader()
    let ids = scope.organizationPartyIds
    if (text(p.organizationPartyId)) {
        if (!covers(scope, text(p.organizationPartyId))) denied("ORGANIZATION_DENIED", "That organization is not available")
        ids = [text(p.organizationPartyId)]
    }
    if (!ids.length) return Object.assign(lib.pageList([], p, "profileList"), {canCreate: false, relayOptions: []})
    const factory = ec.entity.conditionFactory
    let query = find(P).condition("organizationPartyId", "in", ids).orderBy("^profileName").orderBy("sendingProfileId")
    if (text(p.channelEnumId)) query = query.condition("channelEnumId", text(p.channelEnumId))
    const state = text(p.state) || "active"
    if (state === "active")
        query = query.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("thruDate", "equals", null),
                    factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                ],
                "or"
            )
        )
    const found = lib.page(query, p, "profileList", query.count())
    found.profileList = found.rows.map(row => profileDisplay(row, scope))
    return Object.assign(found, {
        canCreate: scope.configure,
        relayOptions: scope.configure ? relayOptions() : [],
        numberOptions: scope.configure ? numberOptions(ids) : []
    })
}
// get#SendingProfile: one profile with its readiness, and for a configurer the relays and trackings to choose from.
function getProfile(p) {
    const scope = reader()
    const row = profileOf(scope, p.sendingProfileId)
    const readiness = readinessOf(row)
    return {
        profile: profileDisplay(row, scope, false),
        ready: readiness.ready,
        checkList: readiness.checks,
        relayOptions: scope.configure ? relayOptions() : [],
        numberOptions: scope.configure ? numberOptions([row.organizationPartyId]) : []
    }
}
// P22: the messaging numbers of the organizations an SMS profile may be bound to, each named with its organization.
function numberOptions(organizationPartyIds) {
    const out = []
    for (const organizationPartyId of organizationPartyIds.slice(0, 50))
        for (const option of sms().organizationNumbers(organizationPartyId))
            out.push({
                value: option.value,
                label: option.label + " — " + organizationName(organizationPartyId),
                organizationPartyId
            })
    return out
}
// check#SendingProfile: the readiness of one profile now; with refresh, a configurer's check is kept as the last one.
function checkProfile(p) {
    const scope = reader()
    const row = profileOf(scope, p.sendingProfileId)
    const readiness = readinessOf(row)
    if ((p.refresh === true || p.refresh === "true") && scope.configure)
        call("update#" + P, {
            sendingProfileId: row.sendingProfileId,
            lastCheckDate: ec.user.nowTimestamp,
            lastCheckReady: readiness.ready ? "Y" : "N"
        })
    return {
        sendingProfileId: row.sendingProfileId,
        ready: readiness.ready,
        checkList: readiness.checks,
        reasons: readiness.reasons
    }
}
// The organization's profiles' readiness, for Marketing's readiness provider (as the viewer): {count, ready, notReady: [names]}.
function organizationReadiness(organizationPartyId) {
    const scope = reader()
    if (!covers(scope, organizationPartyId)) denied("ORGANIZATION_DENIED", "That organization is not available")
    const factory = ec.entity.conditionFactory
    const profiles = Array.from(
        find(P, {organizationPartyId})
            .condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("thruDate", "equals", null),
                        factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                    ],
                    "or"
                )
            )
            .list()
    )
    const notReady = []
    let ready = 0
    for (const row of profiles) {
        const found = readinessOf(row)
        if (found.ready) ready++
        else notReady.push((row.profileName || row.sendingProfileId) + ": " + found.reasons.join("; "))
    }
    return {count: profiles.length, ready, notReady}
}
function timeOf(value, label) {
    const found = text(value)
    if (found && !timePattern.test(found)) denied("VALUE_INVALID", label + " is a time as HH:mm")
    return found || null
}
// store#SendingProfile: a new profile, or one changed at the revision read; the relay one Admin approved (no mail account's), the
// addresses and domain checked; MESSAGE_SENDING_CONFIGURE and the organization.
function storeProfile(p) {
    const scope = scopeOf()
    if (!scope.configure) denied("PERMISSION_DENIED", "Configuring sending profiles needs MESSAGE_SENDING_CONFIGURE")
    const existing = blank(p.sendingProfileId) ? null : profileOf(scope, p.sendingProfileId, true)
    if (existing) {
        if (blank(p.expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of the profile you read")
        if (Number(p.expectedRevision) !== ms(existing.lastUpdatedStamp))
            denied("STALE_RECORD", "The profile changed since you read it (now revision " + ms(existing.lastUpdatedStamp) + ")")
    }
    const value = name => (p[name] !== undefined && p[name] !== null ? p[name] : existing ? existing[name] : null)
    const organizationPartyId = existing ? existing.organizationPartyId : text(p.organizationPartyId)
    if (!existing && !covers(scope, organizationPartyId)) denied("ORGANIZATION_DENIED", "Choose an organization you work for")
    const profileName = text(value("profileName"))
    if (!profileName) denied("NAME_REQUIRED", "Give the profile a name")
    const channelEnumId = text(value("channelEnumId")) || "MdcEmail"
    if (!channels[channelEnumId]) denied("CHANNEL_INVALID", "Sending profiles are kept for email and text messages")
    if (existing && existing.channelEnumId && existing.channelEnumId !== channelEnumId)
        denied("CHANNEL_INVALID", "A profile keeps its channel: make a new one")
    // P22: an SMS profile, bound to one of the organization's messaging numbers
    if (channelEnumId === "MdcSms") return storeSmsProfile(p, existing, value, organizationPartyId, profileName)
    const emailServerId = text(value("emailServerId"))
    if (!emailServerId || !one(SERVER, {emailServerId}) || accountOwned(emailServerId))
        denied("RELAY_INVALID", "Choose a relay Admin approved")
    const fromAddress = text(value("fromAddress")).toLowerCase()
    if (!emailPattern.test(fromAddress)) denied("ADDRESS_INVALID", "Give the sender's address")
    const replyToAddress = text(value("replyToAddress")).toLowerCase() || null
    if (replyToAddress && !emailPattern.test(replyToAddress)) denied("ADDRESS_INVALID", "The reply-to is one address")
    const fromName =
        text(value("fromName"))
            .replace(/[\r\n<>"]/g, "")
            .slice(0, 120) || null
    const purposeEnumId = text(value("purposeEnumId")) || null
    if (purposeEnumId && !one("moqui.basic.Enumeration", {enumId: purposeEnumId, enumTypeId: "MessageTemplatePurpose"}))
        denied("VALUE_INVALID", "Unknown purpose " + purposeEnumId)
    const throttle = value("throttlePerHour")
    const throttlePerHour = blank(throttle) ? null : Number(throttle)
    if (throttlePerHour != null && (!Number.isInteger(throttlePerHour) || throttlePerHour < 1 || throttlePerHour > 1000000))
        denied("VALUE_INVALID", "The throttle is a whole number of messages an hour")
    const quietFrom = timeOf(value("quietFrom"), "The start of the quiet hours")
    const quietThru = timeOf(value("quietThru"), "The end of the quiet hours")
    if (!quietFrom !== !quietThru) denied("VALUE_INVALID", "Give both ends of the quiet hours, or neither")
    const timeZone = text(value("timeZone")).slice(0, 40) || null
    const trackingPolicyEnumId = text(value("trackingPolicyEnumId")) || "MtrNone"
    if (!one("moqui.basic.Enumeration", {enumId: trackingPolicyEnumId, enumTypeId: "MessageTrackingPolicy"}))
        denied("VALUE_INVALID", "Unknown tracking policy " + trackingPolicyEnumId)
    const bounceDomain = text(value("bounceDomain")).toLowerCase()
    if (!domainPattern.test(bounceDomain)) denied("DOMAIN_INVALID", "Give the bounce domain, as bounce.example.com")
    const siteId = text(value("siteId")) || null
    if (siteId && !one("mantle.public.PublicSite", {siteId})) denied("VALUE_INVALID", "Unknown site " + siteId)
    const fromDate = value("fromDate") || ec.user.nowTimestamp
    const thruDate = value("thruDate") || null
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("DATE_INVALID", "A profile ends after it begins")
    const values = {
        organizationPartyId,
        profileName: profileName.slice(0, 120),
        channelEnumId,
        emailServerId,
        fromAddress,
        fromName,
        replyToAddress,
        purposeEnumId,
        throttlePerHour,
        quietFrom,
        quietThru,
        timeZone,
        trackingPolicyEnumId,
        bounceDomain,
        siteId,
        fromDate,
        thruDate
    }
    if (existing) {
        call("update#" + P, Object.assign({sendingProfileId: existing.sendingProfileId}, values))
        return {sendingProfileId: existing.sendingProfileId}
    }
    return {
        sendingProfileId: call("create#" + P, Object.assign(values, {createdByUserId: ec.user.userId || null})).sendingProfileId
    }
}

// P22: an SMS profile's values: one of the organization's messaging numbers (NUMBER_INVALID), the purpose, throttle, quiet hours,
// its cost a segment and dates; no relay, sender or bounce domain.
function storeSmsProfile(p, existing, value, organizationPartyId, profileName) {
    const fromPhoneNumber = sms().e164Text(value("fromPhoneNumber"))
    if (
        !fromPhoneNumber ||
        !sms()
            .organizationNumbers(organizationPartyId)
            .some(option => option.value === fromPhoneNumber)
    )
        denied("NUMBER_INVALID", "Choose one of the organization's messaging numbers")
    const purposeEnumId = text(value("purposeEnumId")) || null
    if (purposeEnumId && !one("moqui.basic.Enumeration", {enumId: purposeEnumId, enumTypeId: "MessageTemplatePurpose"}))
        denied("VALUE_INVALID", "Unknown purpose " + purposeEnumId)
    const throttle = value("throttlePerHour")
    const throttlePerHour = blank(throttle) ? null : Number(throttle)
    if (throttlePerHour != null && (!Number.isInteger(throttlePerHour) || throttlePerHour < 1 || throttlePerHour > 1000000))
        denied("VALUE_INVALID", "The throttle is a whole number of messages an hour")
    const quietFrom = timeOf(value("quietFrom"), "The start of the quiet hours")
    const quietThru = timeOf(value("quietThru"), "The end of the quiet hours")
    if (!quietFrom !== !quietThru) denied("VALUE_INVALID", "Give both ends of the quiet hours, or neither")
    const cost = value("segmentCost")
    const segmentCost = blank(cost) ? null : /^\d+(\.\d+)?$/.test(text(cost)) ? toNumber(text(cost)) : NaN
    if (segmentCost != null && (!Number.isFinite(segmentCost) || segmentCost < 0 || segmentCost > 100))
        denied("VALUE_INVALID", "The cost a segment is an amount of 0 or more")
    const segmentCostUomId = text(value("segmentCostUomId")) || null
    if (segmentCostUomId && !one("moqui.basic.Uom", {uomId: segmentCostUomId}))
        denied("VALUE_INVALID", "Unknown currency " + segmentCostUomId)
    const fromDate = value("fromDate") || ec.user.nowTimestamp
    const thruDate = value("thruDate") || null
    if (thruDate && ms(thruDate) <= ms(fromDate)) denied("DATE_INVALID", "A profile ends after it begins")
    const values = {
        organizationPartyId,
        profileName: profileName.slice(0, 120),
        channelEnumId: "MdcSms",
        fromPhoneNumber,
        purposeEnumId,
        throttlePerHour,
        quietFrom,
        quietThru,
        timeZone: text(value("timeZone")).slice(0, 40) || null,
        trackingPolicyEnumId: "MtrNone",
        segmentCost,
        segmentCostUomId,
        fromDate,
        thruDate
    }
    if (existing) {
        call("update#" + P, Object.assign({sendingProfileId: existing.sendingProfileId}, values))
        return {sendingProfileId: existing.sendingProfileId}
    }
    return {
        sendingProfileId: call("create#" + P, Object.assign(values, {createdByUserId: ec.user.userId || null})).sendingProfileId
    }
}

// ===== the ledger (F13) =====
// The minutes of the day in a time zone at a time.
function minutesIn(timeZone, atMs) {
    const pattern = "HH:mm"
    let shown
    try {
        shown = timeZone ? ec.l10n.format(new Date(atMs), pattern, null, timeZone) : ec.l10n.format(new Date(atMs), pattern)
    } catch (error) {
        shown = ec.l10n.format(new Date(atMs), pattern)
    }
    const [hours, minutes] = String(shown).split(":").map(Number)
    return hours * 60 + minutes
}
const minutesOf = value => {
    const [hours, minutes] = String(value).split(":").map(Number)
    return hours * 60 + minutes
}
// How many minutes from now the quiet hours end, or 0 outside them.
function quietMinutes(profile, atMs) {
    if (!profile.quietFrom || !profile.quietThru) return 0
    const now = minutesIn(profile.timeZone, atMs)
    const from = minutesOf(profile.quietFrom)
    const thru = minutesOf(profile.quietThru)
    const inside = from <= thru ? now >= from && now < thru : now >= from || now < thru
    if (!inside) return 0
    return (thru - now + 1440) % 1440 || 1440
}
// What a delivery naming the profile sends with: {wait: {minutes, reason}} while it waits (quiet hours, the throttle), {refuse}
// when it cannot go (the profile gone, ended or not ready), else {send: the send#EmailTemplate parameters}, its bounce address
// bounces+(deliveryId).(bounceKey)@ the profile's bounce domain.
function forDelivery(sendingProfileId, deliveryId, bounceKey) {
    const profile = one(P, {sendingProfileId})
    if (!profile) return {refuse: "The sending profile is gone"}
    const readiness = readinessOf(profile)
    if (!readiness.ready) return {refuse: "The sending profile is not ready: " + readiness.reasons.join("; ")}
    const at = nowMs()
    const quiet = quietMinutes(profile, at)
    if (quiet) return {wait: {minutes: quiet, reason: "Quiet hours of the sending profile"}}
    if (profile.throttlePerHour) {
        const sentLastHour = find("mantle.party.MessageDelivery", {sendingProfileId})
            .condition("sentDate", "greater-equals", new Date(at - 3600000))
            .count()
        if (sentLastHour >= Number(profile.throttlePerHour)) return {wait: {minutes: 5, reason: "The sending profile's throttle"}}
    }
    // P22: a text goes from the profile's number (org.moqui.SmsServices.send#SmsMessage fromNumber)
    if (profile.channelEnumId === "MdcSms")
        return {send: {fromNumber: profile.fromPhoneNumber}, organizationPartyId: profile.organizationPartyId}
    return {
        send: {
            emailServerId: profile.emailServerId,
            fromAddress: profile.fromAddress,
            ...(profile.fromName ? {fromName: profile.fromName} : {}),
            ...(profile.replyToAddress ? {replyToAddresses: profile.replyToAddress} : {}),
            // VERP with the delivery's random key (P6 review): bounces+(delivery).(key)@ the bounce domain
            bounceAddress: bounceLocal + "+" + deliveryId + "." + bounceKey + "@" + text(profile.bounceDomain).toLowerCase()
        },
        organizationPartyId: profile.organizationPartyId
    }
}

const operations = {find: findProfiles, get: getProfile, store: storeProfile, check: checkProfile}
;({
    bounceLocal,
    readinessOf,
    organizationReadiness,
    forDelivery,
    bounceAccount,
    // P11 (impl-marketing): an automation's send step waits out the quiet hours with its due time shown
    quietMinutes,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sending profile operation " + op)
        return operations[op](parameters || {})
    }
})
