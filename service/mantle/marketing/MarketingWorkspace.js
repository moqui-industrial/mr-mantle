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
const {one, denied} = lib

// The places a finding or a row names, as route keys of the app that shows them (Admin's mount: Admin.js settingsRoutes; the
// Marketing root resolves the same keys to its own paths).
const routes = {settings: "marketingSettings", adoption: "marketingAdoption"}

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
    {key: "campaigns", title: "Running campaigns", phase: "P2"},
    {key: "approvals", title: "Pending approvals", phase: "P2"},
    {key: "dueSends", title: "Sends due", phase: "P8"},
    {key: "failedDeliveries", title: "Failed or uncertain deliveries", phase: "P9"},
    {key: "registrations", title: "Registrations against capacity", phase: "P17"},
    {key: "audienceChanges", title: "Audience changes", phase: "P3"}
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
    {key: "campaignWindows", title: "Campaign windows", phase: "P2"},
    {key: "sends", title: "Scheduled sends", phase: "P8"},
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
    {key: "approvals", title: "Approvals awaiting a decision", phase: "P2"},
    {key: "deliveries", title: "Failed or uncertain deliveries", phase: "P9"}
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
    configurer()
    const entries = []
    for (const entry of settingsEntries) {
        let readiness
        try {
            readiness = entry.readiness()
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
