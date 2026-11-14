// Marketing's workspace projections (mantle.marketing.MarketingWorkspaceServices, W; IronStone Marketing design §3 Home, §12
// Settings, §14.2; impl-marketing P1): Home's cards, upcoming activity and attention, the settings index and the setup readiness.
// Each reads the caller's scope (MarketingAccess.js), refuses a caller who reads nothing of Marketing (PERMISSION_DENIED) and an
// organization outside the scope (ORGANIZATION_DENIED), and leaves out what the caller may not read.
//
// Home's panels answer by source: each source of a table below is answered by name, a source whose records are not built yet
// is "notAvailable" (never zero) until its phase adds a count, and a source that fails is "failed" and named in failedSources
// while the others are still answered. Later phases add a count, rows or a check to their source; nothing else changes.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const adoption = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAdoption.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const {find, one, rows, denied} = lib
// loaded when the audience card runs, so Home's other sources do not depend on it
const audiences = () => ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAudiences.js")

// The places a finding or a row names, as route keys of the app that shows them (Admin's mount: Admin.js settingsRoutes; the
// Marketing root resolves the same keys to its own paths).
const routes = {
    settings: "marketingSettings",
    adoption: "marketingAdoption",
    // P2
    campaigns: "marketingCampaigns",
    approvals: "marketingApprovals",
    campaign: "marketingCampaign",
    campaignDefaults: "marketingCampaignDefaults",
    vocabularies: "marketingVocabularies",
    // P3
    lists: "marketingLists",
    // P6: Comms' sending profiles and templates under Marketing's mount
    sendingProfiles: "marketingSendingProfiles",
    templates: "marketingTemplates",
    consent: "marketingConsent",
    suppressions: "marketingSuppressions",
    // P9: the sends and a send's delivery
    sends: "marketingSends",
    send: "marketingSend",
    delivery: "marketingDelivery"
}
// ===== Marketing P9: the sends' cards, upcoming and attention rows =====
const SEND = "mantle.marketing.campaign.CampaignSend"
// The sends of the organizations released and waiting for their time or sending now, due within a day.
function dueSends(context) {
    if (!context.organizationPartyIds.length) return []
    const until = new Date(lib.ms(ec.user.nowTimestamp) + dayMs)
    const cf = ec.entity.conditionFactory
    return Array.from(
        find(SEND)
            .condition("organizationPartyId", "in", context.organizationPartyIds)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("statusId", "equals", "CsSending"),
                        cf.makeCondition(
                            [
                                cf.makeCondition("statusId", "equals", "CsScheduled"),
                                cf.makeCondition("scheduledDate", "<=", until)
                            ],
                            "and"
                        )
                    ],
                    "or"
                )
            )
            .orderBy("scheduledDate")
            .limit(100)
            .list()
    )
}
// The released sends of the organizations with a failed or uncertain delivery: {row, failed, uncertain}, the most recent first.
function troubledSends(context) {
    if (!context.organizationPartyIds.length) return []
    const found = []
    for (const row of Array.from(
        find(SEND)
            .condition("organizationPartyId", "in", context.organizationPartyIds)
            .condition("statusId", "in", ["CsSending", "CsPaused", "CsCompletedFailures"])
            .orderBy("-releasedDate")
            .limit(100)
            .list()
    )) {
        const count = state =>
            find("mantle.party.MessageDelivery", {sourceEnumId: "MdsrcCampaignSend", stateEnumId: state})
                .condition("eventKey", "like", "CampaignSend:" + row.campaignSendId + ":%")
                .count()
        const failed = count("MdsFailed"),
            uncertain = count("MdsUncertain")
        if (failed || uncertain) found.push({row, failed, uncertain})
    }
    return found
}
// ===== end of Marketing P9 =====
// loaded when the sending readiness runs (P6)
const sendingProfiles = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const upcomingDays = 60
const dayMs = 24 * 60 * 60 * 1000

function reader(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    const organizationPartyId = String(p.organizationPartyId || "").trim()
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    return {
        userScope,
        organizationPartyId: organizationPartyId || null,
        organizationPartyIds: organizationPartyId ? [organizationPartyId] : marketingAccess.organizationIds(userScope)
    }
}
function configurer() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.configure) denied("PERMISSION_DENIED", "Marketing configure is required")
    return userScope
}
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
// "2 lists, 1 segment and no campaign"
function countText(counts) {
    const parts = [
        [counts.campaign, "campaign", "campaigns"],
        [counts.list, "list", "lists"],
        [counts.segment, "segment", "segments"]
    ].map(([count, singular, plural]) => (count ? count + " " + (count === 1 ? singular : plural) : "no " + singular))
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1]
}
const unownedTotal = counts => Object.values(counts).reduce((total, count) => total + Number(count || 0), 0)

// Runs each source of a table on its own: its answer, "notAvailable" when it has none yet, "failed" (named) when it throws.
function answerSources(sources, context, answer) {
    const answered = []
    const failedSources = []
    for (const source of sources) {
        if (source.admits && !source.admits(context)) continue
        if (!source.run) {
            answered.push(Object.assign(answer(source, null), {state: "notAvailable", message: "Not available"}))
            continue
        }
        ec.message.pushErrors()
        try {
            const found = source.run(context)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            answered.push(Object.assign(answer(source, found), {state: "available", message: null}))
        } catch (error) {
            ec.logger.error("Marketing source " + source.key + " failed: " + error.message)
            failedSources.push(source.title)
            answered.push(Object.assign(answer(source, null), {state: "failed", message: source.title + " could not be read"}))
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {answered, failedSources}
}

// ===== Home (design §3) =====
// MarketingCards: each card's count, by its phase. None is built in P1: running campaigns and approvals P2, audience changes P3,
// sends due P8, failed and uncertain deliveries P9, registration capacity P17.
const cardSources = [
    {
        key: "campaigns",
        title: "Running campaigns",
        phase: "P2",
        run: context => ({
            value: context.organizationPartyIds.length
                ? find(CAMPAIGN)
                      .condition("organizationPartyId", "in", context.organizationPartyIds)
                      .condition("statusId", "MKTG_CAMP_INPROGRESS")
                      .count()
                : 0,
            linkPath: routes.campaigns
        })
    },
    {
        key: "approvals",
        title: "Pending approvals",
        phase: "P2",
        run: context => ({value: approvals.pendingRows(context.organizationPartyIds).length, linkPath: routes.approvals})
    },
    // P9: the sends released and due within a day or sending, and the sends with a failed or uncertain delivery (counts only)
    {
        key: "dueSends",
        title: "Sends due",
        phase: "P8",
        run: context => ({value: dueSends(context).length, linkPath: routes.sends})
    },
    {
        key: "failedDeliveries",
        title: "Failed or uncertain deliveries",
        phase: "P9",
        run: context => ({
            value: troubledSends(context).reduce((total, found) => total + found.failed + found.uncertain, 0),
            linkPath: routes.sends
        })
    },
    {key: "registrations", title: "Registrations against capacity", phase: "P17"},
    // P3: the subscription requests of the last seven days for the organizations' lists (a count, no person)
    {
        key: "audienceChanges",
        title: "Audience changes",
        phase: "P3",
        run: context => ({value: audiences().recentRequestCount(context.organizationPartyIds), linkPath: routes.lists})
    }
]
function home(p) {
    const context = reader(p)
    const {answered, failedSources} = answerSources(cardSources, context, (source, found) => ({
        cardKey: source.key,
        title: source.title,
        value: found?.value ?? null,
        linkPath: found?.linkPath || null
    }))
    return {cards: answered, failedSources}
}
// Upcoming: campaign windows P2, sends P8, events P16, approved publication dates P14; each source's rows merged by date.
const upcomingSources = [
    {
        key: "campaignWindows",
        title: "Campaign windows",
        phase: "P2",
        // the open campaigns starting or ending in the next 60 days, each date a row
        run: context => {
            if (!context.organizationPartyIds.length) return {rows: []}
            const now = lib.ms(ec.user.nowTimestamp)
            const until = new Date(now + upcomingDays * dayMs)
            const cf = ec.entity.conditionFactory
            const found = find(CAMPAIGN)
                .condition("organizationPartyId", "in", context.organizationPartyIds)
                .condition("statusId", "in", ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"])
                .condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition(
                                [
                                    cf.makeCondition("fromDate", ">=", ec.user.nowTimestamp),
                                    cf.makeCondition("fromDate", "<=", until)
                                ],
                                "and"
                            ),
                            cf.makeCondition(
                                [
                                    cf.makeCondition("thruDate", ">=", ec.user.nowTimestamp),
                                    cf.makeCondition("thruDate", "<=", until)
                                ],
                                "and"
                            )
                        ],
                        "or"
                    )
                )
                .limit(100)
                .list()
            const out = []
            for (const row of Array.from(found))
                for (const [field, kind] of [
                    ["fromDate", "Campaign starts"],
                    ["thruDate", "Campaign ends"]
                ]) {
                    const at = lib.ms(row[field])
                    if (at == null || at < now || at > lib.ms(until)) continue
                    out.push({
                        kind,
                        title: row.campaignName || row.marketingCampaignId,
                        date: row[field],
                        state: {
                            MKTG_CAMP_PLANNED: "Planned",
                            MKTG_CAMP_APPROVED: "Approved",
                            MKTG_CAMP_INPROGRESS: "In progress"
                        }[row.statusId],
                        recordId: row.marketingCampaignId,
                        route: routes.campaign
                    })
                }
            return {rows: out}
        }
    },
    // P9 (the Today source of due sends): the approved and released sends with a schedule in the next 60 days
    {
        key: "sends",
        title: "Scheduled sends",
        phase: "P8",
        run: context => {
            if (!context.organizationPartyIds.length) return {rows: []}
            const now = lib.ms(ec.user.nowTimestamp)
            const found = find(SEND)
                .condition("organizationPartyId", "in", context.organizationPartyIds)
                .condition("statusId", "in", ["CsApproved", "CsScheduled", "CsSending", "CsPaused"])
                .condition("scheduledDate", ">=", ec.user.nowTimestamp)
                .condition("scheduledDate", "<=", new Date(now + upcomingDays * dayMs))
                .orderBy("scheduledDate")
                .limit(100)
                .list()
            return {
                rows: Array.from(found).map(row => ({
                    kind: "Send",
                    title: row.sendName || row.campaignSendId,
                    date: row.scheduledDate,
                    state: one("moqui.basic.StatusItem", {statusId: row.statusId})?.description || row.statusId,
                    recordId: row.campaignSendId,
                    recordParameter: "campaignSendId",
                    route: routes.send
                }))
            }
        }
    },
    {key: "events", title: "Events", phase: "P16"},
    {key: "publications", title: "Publication dates", phase: "P14"}
]
function upcoming(p) {
    const context = reader(p)
    const {answered, failedSources} = answerSources(upcomingSources, context, (source, found) => ({
        sourceKey: source.key,
        title: source.title,
        rows: found?.rows || []
    }))
    const rows = answered.flatMap(source => source.rows).sort((a, b) => (lib.ms(a.date) ?? 0) - (lib.ms(b.date) ?? 0))
    return {rows, sources: answered.map(({rows, ...source}) => source), failedSources}
}
// Attention: the records awaiting adoption (P1, an administrator's: MARKETING_CONFIGURE), approvals awaiting a decision P2,
// failed and uncertain deliveries P9.
const attentionSources = [
    {
        key: "adoption",
        title: "Records awaiting adoption",
        phase: "P1",
        admits: context => context.userScope.capabilities.configure,
        run: () => {
            const counts = adoption.unownedCounts()
            const rows = Object.entries(adoption.kinds)
                .filter(([kindKey]) => counts[kindKey])
                .map(([kindKey, kind]) => ({
                    recordKind: kindKey,
                    record: counts[kindKey] + " " + kind.name.toLowerCase() + (counts[kindKey] === 1 ? "" : "s"),
                    reason: "No organization: not editable or sendable until adopted",
                    action: "Adopt",
                    route: routes.adoption
                }))
            return {rows}
        }
    },
    {
        key: "approvals",
        title: "Approvals awaiting a decision",
        phase: "P2",
        // an approver's: the requests awaiting a decision, each its campaign
        admits: context => context.userScope.capabilities.approve,
        run: context => {
            const kinds = approvals.targetKinds
            const rowsFound = approvals
                .pendingRows(context.organizationPartyIds)
                .slice(0, 50)
                .map(request => {
                    const kindKey = approvals.kindByEnum(request.targetKindEnumId)
                    const target = kindKey ? kinds[kindKey].read(request.targetId) : null
                    return {
                        recordKind: kindKey,
                        recordId: request.targetId,
                        record:
                            (kindKey ? kinds[kindKey].name + " " : "") +
                            (target ? kinds[kindKey].label(target) : request.targetId),
                        reason: "Awaits approval at revision " + request.targetRevision,
                        age:
                            Math.max(0, Math.floor((lib.ms(ec.user.nowTimestamp) - lib.ms(request.decisionDate)) / dayMs)) +
                            " days",
                        action: "Review",
                        route: routes.approvals
                    }
                })
            return {rows: rowsFound}
        }
    },
    // P9: a send with a failed or uncertain delivery, for its dispatchers (a failure to retry, an uncertainty to reconcile)
    {
        key: "deliveries",
        title: "Failed or uncertain deliveries",
        phase: "P9",
        admits: context => context.userScope.capabilities.dispatch,
        run: context => ({
            rows: troubledSends(context)
                .slice(0, 50)
                .map(({row, failed, uncertain}) => ({
                    recordKind: "send",
                    recordId: row.campaignSendId,
                    recordParameter: "campaignSendId",
                    record: "Send " + (row.sendName || row.campaignSendId),
                    reason: [failed ? failed + " failed" : null, uncertain ? uncertain + " uncertain" : null]
                        .filter(Boolean)
                        .join(", "),
                    age: row.releasedDate
                        ? Math.max(0, Math.floor((lib.ms(ec.user.nowTimestamp) - lib.ms(row.releasedDate)) / dayMs)) + " days"
                        : "",
                    action: uncertain ? "Reconcile" : "Retry",
                    route: routes.delivery
                }))
        })
    }
]
function attention(p) {
    const context = reader(p)
    const {answered, failedSources} = answerSources(attentionSources, context, (source, found) => ({
        sourceKey: source.key,
        title: source.title,
        rows: found?.rows || []
    }))
    const rows = answered.flatMap(source => source.rows.map(row => Object.assign({sourceKey: source.sourceKey}, row)))
    return {rows, sources: answered.map(({rows, ...source}) => source), failedSources}
}

// ===== Settings (design §12) =====
// The entries built so far, each with its route key, owner and readiness: P1 the adoption of unowned records. Later phases add
// CampaignDefaults and Vocabularies (P2), Consent and Suppressions (P3), LeadSources (P13), SendingProfiles and Templates (P6).
const settingsEntries = [
    // P2: the organization's campaign defaults (design §12 CampaignDefaults) and the values it offers (Vocabularies)
    {
        entryKey: "campaignDefaults",
        title: "Campaign defaults",
        description: "Currency, approval and the one-person team's self-approval, audience limit, frequency cap and retention",
        category: "Campaigns",
        owner: "Marketing",
        route: routes.campaignDefaults,
        readiness: userScope => {
            const ids = marketingAccess.organizationIds(userScope)
            const missing = ids.filter(partyId => !approvals.policyOf(partyId)).length
            return missing ? missing + " organizations use the defaults" : "Every organization has its policy"
        }
    },
    {
        entryKey: "vocabularies",
        title: "Vocabularies",
        description: "The list types, tracking code types and UTM sources, media and content offered",
        category: "Campaigns",
        owner: "Marketing",
        route: routes.vocabularies,
        readiness: () => "Dated values by organization"
    },
    // P6: Comms' sending profiles and templates, mounted under Marketing's Settings and Sends (design §12 Settings' links)
    {
        entryKey: "sendingProfiles",
        title: "Sending profiles",
        description: "The senders, relays, limits and bounce addresses campaign mail goes out from, with their readiness",
        category: "Sending",
        owner: "Comms",
        route: routes.sendingProfiles,
        readiness: userScope => {
            const ids = marketingAccess.organizationIds(userScope)
            let count = 0,
                ready = 0
            for (const partyId of ids.slice(0, 50)) {
                const found = sendingProfiles().organizationReadiness(partyId)
                count += found.count
                ready += found.ready
            }
            return count ? ready + " of " + count + " ready" : "No sending profile yet"
        }
    },
    {
        entryKey: "templates",
        title: "Message templates",
        description: "The shared template library: content with declared variables, published by date",
        category: "Sending",
        owner: "Comms",
        route: routes.templates,
        readiness: () => "Dated content by organization"
    },
    // P6: the links design §12 Settings names, to the screens P3 mounted under Audiences
    {
        entryKey: "consent",
        title: "Consent",
        description: "The consent of each contact by purpose and organization, with its history",
        category: "Audiences",
        owner: "Comms",
        route: routes.consent,
        readiness: () => "Recorded by evidence"
    },
    {
        entryKey: "suppressions",
        title: "Suppressions",
        description: "The addresses no message may reach: hard bounces, complaints and staff blocks",
        category: "Audiences",
        owner: "Comms",
        route: routes.suppressions,
        readiness: () => "Kept until a reviewer ends one"
    },
    {
        entryKey: "adoption",
        title: "Adoption of existing records",
        description: "Assign the campaigns, lists and segments that belong to no organization",
        category: "Organization",
        owner: "Marketing",
        route: routes.adoption,
        readiness: () => {
            const counts = adoption.unownedCounts()
            return unownedTotal(counts) ? countText(counts) + " await adoption" : "Nothing awaits adoption"
        }
    }
]
function settings() {
    const userScope = configurer()
    const entries = []
    for (const entry of settingsEntries) {
        let readiness
        try {
            readiness = entry.readiness(userScope)
        } catch (error) {
            ec.logger.error("Marketing settings entry " + entry.entryKey + " failed: " + error.message)
            readiness = "Could not be checked"
        }
        entries.push(Object.assign({}, entry, {readiness}))
    }
    return {entries}
}

// ===== Readiness (moqui.server.ReadinessProvider marketing.setup) =====
// Each check of what is built, with its fix place as a route key; one check that fails is unavailable by name and the others go
// on. P1: the unowned campaigns, lists and segments awaiting adoption (instance-wide: they belong to no organization). Later
// phases add theirs (no policy P2, no ready sending profile P6, a mount with nothing published P7, failed jobs and captures
// P9–P17), per organization.
const readinessChecks = [
    // P2: the organization's campaign policy (none: no self-approval and a manager required, a new campaign's currency from its
    // accounting); asked per organization
    {
        checkKey: "marketing.policy",
        title: "Campaign defaults",
        run: organizationPartyId => {
            if (!organizationPartyId) return {state: "ready", message: "Asked per organization"}
            if (approvals.policyOf(organizationPartyId)) return {state: "ready", message: "Its campaign defaults are set"}
            return {
                state: "warning",
                reasonCode: "NO_POLICY",
                message: "No campaign defaults: campaigns use the default approval rules and the accounting currency",
                fixRoute: routes.campaignDefaults
            }
        }
    },
    // P6: the organization's sending profiles (design §12; impl-marketing §4: a check of Marketing's provider), read through
    // check#SendingProfile's rule as the viewer: none, or none ready, is a warning with the profiles as the fix
    {
        checkKey: "marketing.sending",
        title: "Sending profiles",
        run: organizationPartyId => {
            if (!organizationPartyId) return {state: "ready", message: "Asked per organization"}
            const found = sendingProfiles().organizationReadiness(organizationPartyId)
            if (!found.count)
                return {
                    state: "warning",
                    reasonCode: "NO_SENDING_PROFILE",
                    message: "No sending profile: campaign mail cannot be released",
                    fixRoute: routes.sendingProfiles
                }
            if (!found.ready)
                return {
                    state: "warning",
                    reasonCode: "SENDING_NOT_READY",
                    message: "No sending profile is ready: " + found.notReady.slice(0, 3).join(" | "),
                    fixRoute: routes.sendingProfiles
                }
            return {
                state: "ready",
                message:
                    found.ready +
                    " of " +
                    found.count +
                    " sending profiles ready" +
                    (found.notReady.length ? "; not ready: " + found.notReady.slice(0, 2).join(" | ") : "")
            }
        }
    },
    {
        checkKey: "marketing.adoption",
        title: "Records awaiting adoption",
        run: () => {
            const counts = adoption.unownedCounts()
            if (!unownedTotal(counts))
                return {state: "ready", message: "Every campaign, list and segment belongs to an organization"}
            return {
                state: "warning",
                reasonCode: "UNOWNED_RECORDS",
                message: countText(counts) + " belong to no organization and await adoption",
                fixRoute: routes.adoption
            }
        }
    }
]
function readiness(p) {
    const userScope = configurer()
    const organizationPartyId = String(p.organizationPartyId || "").trim() || null
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    const subject = organizationPartyId ? organizationName(organizationPartyId) : "Marketing"
    const checks = []
    for (const check of readinessChecks) {
        let found
        ec.message.pushErrors()
        try {
            found = check.run(organizationPartyId)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            ec.logger.error("Marketing readiness " + check.checkKey + " failed: " + error.message)
            found = {state: "unavailable", reasonCode: "CHECK_FAILED", message: check.title + " could not be checked"}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        checks.push({
            checkKey: check.checkKey,
            title: check.title,
            state: found.state,
            reasonCode: found.reasonCode || null,
            message: found.message,
            fixRoute: found.state === "ready" ? null : found.fixRoute || routes.settings,
            fixId: null,
            subject,
            scope: {organizationPartyId},
            organizationPartyId,
            organizationName: organizationPartyId ? subject : null
        })
    }
    return {checks}
}

const operations = {home, upcoming, attention, settings, readiness}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing workspace operation " + op)
        return operations[op](parameters || {})
    }
})
