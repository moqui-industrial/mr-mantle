// Marketing's lead rules and the Sales handoff (mantle.marketing.MarketingFormServices, F of IronStone Marketing design §14.2; design
// §10 Leads and LeadRules, §13 SubmitForm's lead purpose, §15.3 Capture handoff; impl-marketing P13, F66, F68; MKT-LEAD). CC0 1.0
// Universal plus Grant of Patent License.
//
// - A lead rule (MarketingLeadRule) says how the accepted answers of one lead form's publication reach Sales: the team whose queue a
//   lead goes to, the Sales source it takes when the organization's UTM map has none, the published fields mapped to the inquiry's
//   name, organization, email and phone and those entered in its notes, an optional condition on one answer, and the notice the page
//   shows. One current rule per publication; a change starts a new rule from now and ends the one it replaces. A content author
//   (MARKETING_CONTENT_EDIT) of the organization writes it; the team and source are Sales' own, checked against the organization, and
//   the team is a sales manager's choice (SALES_TEAM_MANAGE; else Sales' default team; the user's call of Nov 14, 2026).
// - A capture (MarketingLeadCapture) is one rule's handoff of one accepted submission: made after the answer commits (capture#
//   FormSubmission, from the SubmitForm page's effects) or by the capture job for an answer with none, and handed to Sales'
//   mantle.sales.OpportunityServices.store#LeadIntake once (hand#LeadCapture) under its own operation key, so the job's retry or an
//   operator's ReprocessCapture answers Sales' first result and never makes a second lead (impl-sales P5's contract).
// - The handoff runs as the system (runAsSystem: no user, authorization off), and Sales trusts what a system caller gives (impl-sales
//   F125): so every value comes from Marketing's own records, never the request: the organization and campaign from the publication,
//   the team and source from the rule, the inquiry's fields from the response's answers to the fields published when it was
//   submitted (an internal or unpublished field never reaches Sales), and verified only from Marketing's own verification (an
//   invitation's address, or a signed-in account's address, equal to the answered email). A typed email identifies nobody.
// - A failed handoff keeps the answer and the capture, its reason (errorText: a reason code and words, never an answer) and the time
//   it is tried again (a growing wait, up to a day, for 30 days); each capture is its own transaction, so one failure never stops the
//   others. Nothing here subscribes anyone or records a consent.
// - The handoff counts (get#LeadHandoffs) are Marketing's own capture rows, for any Marketing reader (MARKETING_VIEW alone gives the
//   counts and no pipeline, F66); a capture names its Sales lead only to a caller who can open that lead in Sales.
// Refusals carry reason codes (EntityLib.js denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const salesAccess = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const salesSettings = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const publications = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const salesPolicies = () => ec.resource.script("component://mr-mantle/service/mantle/order/SalesApprovals.js")
const {find, one, rows, call, denied, ms} = lib

const RULE = "mantle.marketing.lead.MarketingLeadRule"
const CAPTURE = "mantle.marketing.lead.MarketingLeadCapture"
const COUNT = "mantle.marketing.lead.MarketingLeadCaptureCount"
const PUBLICATION = "mantle.party.FormPublication"
const SUBMISSION = "mantle.party.FormSubmission"
const INVITATION = "mantle.party.FormInvitation"
const FORM = "moqui.screen.form.DbForm"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const SERVICES = "mantle.marketing.MarketingFormServices."
const INTAKE_SERVICE = "mantle.sales.OpportunityServices.store#LeadIntake"
const SOURCE_PUBLICATION = "MlsFormPublication"
const TRIGGER_FORM = "MltFormSubmitted"
const SOURCE_SUBMISSION = "MlcsFormSubmission"
const LEAD_PURPOSE = "FppLead"
const LEAD_FORM = "DbfpLead"
const statuses = {pending: "MlcPending", handedOff: "MlcHandedOff", skipped: "MlcSkipped", failed: "MlcFailed"}
const statusColors = {MlcPending: "grey", MlcHandedOff: "positive", MlcSkipped: "grey", MlcFailed: "negative"}
const limits = {
    rows: 200,
    ids: 200,
    capturesPerRun: 200,
    rulesPerRun: 200,
    submissionsPerRule: 500,
    pagesPerRule: 40,
    collectDays: 30,
    retryDays: 30,
    retryBaseMinutes: 5,
    retryMaxMinutes: 1440,
    name: 255,
    notes: 4000,
    notice: 1000,
    error: 255
}
// the inquiry's fields a rule maps, each to one published field, with the words a screen shows
const LEAD_FIELDS = {
    nameFieldName: "Name",
    organizationFieldName: "Organization",
    emailFieldName: "Email",
    phoneFieldName: "Phone"
}
const RULE_FIELDS = [
    "ruleName",
    "dataSourceId",
    "teamPartyId",
    ...Object.keys(LEAD_FIELDS),
    "noteFieldNames",
    "conditionFieldName",
    "conditionValue",
    "noticeText"
]
const DAY = 86400000
const emailPattern = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const limited = (value, length) => (blank(value) ? null : String(value).trim().substring(0, length))
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const yes = value => value === true || value === "true" || value === "Y"
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value)).map(item => text(item)).filter(Boolean)
const firstLine = value => String(value ?? "").split("\n")[0]
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const revisionOf = row => String(ms(row.lastUpdatedStamp) ?? "")

// ===== scope =====
function readScope() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    return userScope
}
// The lead rules are read by a content author or the Marketing administrator (design §2 LeadRules: A, S) and written by an author.
function ruleScope() {
    const userScope = readScope()
    if (!userScope.capabilities.contentEdit && !userScope.capabilities.configure)
        denied("PERMISSION_DENIED", "Marketing lead rules are the content authors'")
    return userScope
}
// A lead form's publication: a Marketing publication of the lead purpose whose form is a lead form of its organization, else
// RECORD_UNAVAILABLE.
function leadPublication(publicationId) {
    const row = blank(publicationId) ? null : one(PUBLICATION, {publicationId: text(publicationId)})
    const form = row ? one(FORM, {formId: row.formId}) : null
    if (
        !row ||
        row.purposeEnumId !== LEAD_PURPOSE ||
        !form ||
        form.purposeEnumId !== LEAD_FORM ||
        form.ownerPartyId !== row.organizationPartyId
    )
        denied("RECORD_UNAVAILABLE", "Lead form publication " + (publicationId || "") + " is not available")
    return {row, form}
}
// The rule of a publication in effect at a time (now by default), or null.
function ruleAt(publicationId, at = ec.user.nowTimestamp) {
    if (!publicationId) return null
    return (
        Array.from(
            find(RULE, {sourceKindEnumId: SOURCE_PUBLICATION, sourceId: publicationId}).orderBy("-fromDate").limit(20).list()
        ).find(rule => lib.active(rule, at)) || null
    )
}
// A rule of the caller's scope, else RECORD_UNAVAILABLE.
function ruleOf(userScope, leadRuleId) {
    const rule = blank(leadRuleId) ? null : one(RULE, {leadRuleId: text(leadRuleId)})
    if (!rule || !marketingAccess.covers(userScope, rule.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Lead rule " + (leadRuleId || "") + " is not available")
    return rule
}
// The sales team (the user's call of Nov 14, 2026): choosing or changing a rule's team needs SALES_TEAM_MANAGE in the organization (a
// sales manager); without it a content author saves a rule only with the organization's default team of Sales' SalesPolicy, or with no
// team, which hands each lead to the default team in effect at the handoff.
const defaultTeamOf = organizationPartyId => salesPolicies().policyOf(organizationPartyId)?.defaultTeamPartyId || null
function teamChooser(organizationPartyId) {
    let salesScope = null
    try {
        salesScope = salesAccess().scope()
    } catch (error) {
        salesScope = null
    }
    return !!salesScope?.capabilities.teamManage && salesAccess().covers(salesScope, organizationPartyId)
}
// The team a rule hands its leads to now: its own, else the organization's default team.
const queueOf = rule => rule.teamPartyId || defaultTeamOf(rule.organizationPartyId)
const teamNameOf = teamPartyId => (teamPartyId ? salesSettings().teamRow(teamPartyId)?.teamName || teamPartyId : "")
const campaignOfPublication = row => (row.contextEntityName === CAMPAIGN && row.contextId ? row.contextId : null)
const campaignName = marketingCampaignId =>
    marketingCampaignId ? one(CAMPAIGN, {marketingCampaignId})?.campaignName || marketingCampaignId : ""
// The customer-visible fields of a form as of a date (published ones; with drafts, what an author is building).
function customerFields(formId, at = null, drafts = false) {
    const definitions = forms()
    return definitions.formAt(formId, at, drafts).filter(field => field.audienceEnumId === definitions.CUSTOMER)
}

// ===== the handoff counts =====
// Captures counted by state, of the conditions given (a rule, a campaign, a publication, organizations): {captured, handedOff,
// newLeads, joined, pending, failed, skipped}.
function countsOf(conditions, organizationPartyIds) {
    let query = find(COUNT, conditions).selectField(["statusEnumId", "duplicate", "captureCount"])
    if (organizationPartyIds)
        query = query.condition("organizationPartyId", "in", organizationPartyIds.length ? organizationPartyIds : ["-"])
    const counts = {captured: 0, handedOff: 0, newLeads: 0, joined: 0, pending: 0, failed: 0, skipped: 0}
    for (const row of Array.from(query.list())) {
        const count = Number(row.captureCount || 0)
        counts.captured += count
        if (row.statusEnumId === statuses.handedOff) {
            counts.handedOff += count
            if (row.duplicate === "Y") counts.joined += count
            else counts.newLeads += count
        } else if (row.statusEnumId === statuses.pending) counts.pending += count
        else if (row.statusEnumId === statuses.failed) counts.failed += count
        else if (row.statusEnumId === statuses.skipped) counts.skipped += count
    }
    return counts
}
const counted = (count, one, many) => count + " " + L(count === 1 ? one : many)
const countsText = counts =>
    counts.captured
        ? [
              counted(counts.newLeads, "new lead", "new leads"),
              counts.joined ? counted(counts.joined, "joined an open lead", "joined open leads") : null,
              counts.pending ? counts.pending + " " + L("waiting") : null,
              counts.failed ? counts.failed + " " + L("failed") : null,
              counts.skipped ? counts.skipped + " " + L("not handed off") : null
          ]
              .filter(Boolean)
              .join(" · ")
        : L("No answers handed off yet")
// get#LeadHandoffs: the handoff counts of a campaign, a rule or a publication of the caller's scope, for any Marketing reader.
function getLeadHandoffs(p) {
    const userScope = readScope()
    const conditions = {}
    let organizationPartyId = null
    if (!blank(p.marketingCampaignId)) {
        const campaign = one(CAMPAIGN, {marketingCampaignId: text(p.marketingCampaignId)})
        if (!campaign || !marketingAccess.covers(userScope, campaign.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Campaign " + p.marketingCampaignId + " is not available")
        conditions.marketingCampaignId = campaign.marketingCampaignId
        organizationPartyId = campaign.organizationPartyId
    }
    if (!blank(p.leadRuleId)) {
        const rule = ruleOf(userScope, p.leadRuleId)
        conditions.leadRuleId = rule.leadRuleId
        organizationPartyId = rule.organizationPartyId
    }
    if (!blank(p.publicationId)) {
        const {row} = leadPublication(p.publicationId)
        if (!marketingAccess.covers(userScope, row.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Lead form publication " + p.publicationId + " is not available")
        conditions.publicationId = row.publicationId
        organizationPartyId = row.organizationPartyId
    }
    if (!organizationPartyId) denied("RECORD_REQUIRED", "Name a campaign, a lead rule or a lead form")
    const counts = countsOf(conditions, [organizationPartyId])
    return {handoffs: Object.assign(counts, {summaryText: countsText(counts)})}
}

// ===== the rules =====
// A rule's view for the screens: its source, campaign, team, source, mapping, dates and state.
function ruleView(rule, fieldTitles = null) {
    const titleOf = name => (name ? fieldTitles?.[name] || name : "")
    const publication = one(PUBLICATION, {publicationId: rule.sourceId})
    const queue = queueOf(rule)
    const current = lib.active(rule)
    const ended = rule.thruDate != null && Number(ms(rule.thruDate)) <= nowMs()
    return {
        leadRuleId: rule.leadRuleId,
        ruleName: rule.ruleName || "",
        organizationPartyId: rule.organizationPartyId,
        organizationName: partyName(rule.organizationPartyId),
        publicationId: rule.sourceId,
        publicationText: publication
            ? publication.titleText || publication.description || publication.publicationId
            : rule.sourceId,
        publicationState: publication ? publications().stateOf(publication) : "",
        sourceKindText: enumText(rule.sourceKindEnumId),
        triggerText: enumText(rule.triggerEnumId),
        marketingCampaignId: publication ? campaignOfPublication(publication) : rule.marketingCampaignId,
        campaignName: campaignName(publication ? campaignOfPublication(publication) : rule.marketingCampaignId),
        teamPartyId: rule.teamPartyId,
        teamName: rule.teamPartyId
            ? teamNameOf(rule.teamPartyId)
            : queue
              ? teamNameOf(queue) + " " + L("(Sales' default team)")
              : L("Sales' default team (none set)"),
        dataSourceId: rule.dataSourceId || null,
        sourceText: rule.dataSourceId
            ? one("moqui.basic.DataSource", {dataSourceId: rule.dataSourceId})?.description || rule.dataSourceId
            : "",
        nameFieldName: rule.nameFieldName || null,
        organizationFieldName: rule.organizationFieldName || null,
        emailFieldName: rule.emailFieldName || null,
        phoneFieldName: rule.phoneFieldName || null,
        noteFieldNames: rule.noteFieldNames || "",
        conditionFieldName: rule.conditionFieldName || null,
        conditionValue: rule.conditionValue || "",
        noticeText: rule.noticeText || "",
        mappingText:
            Object.entries(LEAD_FIELDS)
                .filter(([field]) => rule[field])
                .map(([field, words]) => L(words) + " ← " + titleOf(rule[field]))
                .join(" · ") +
            (rule.noteFieldNames ? " · " + L("Notes") + " ← " + listOf(rule.noteFieldNames).map(titleOf).join(", ") : ""),
        conditionText: rule.conditionFieldName ? titleOf(rule.conditionFieldName) + " = " + (rule.conditionValue || "") : "",
        fromText: lib.dateText(rule.fromDate),
        thruText: lib.dateText(rule.thruDate),
        stateText: current ? L("Current") : ended ? L("Ended") : L("Starts later"),
        stateColor: current ? "positive" : "grey",
        current,
        revision: revisionOf(rule)
    }
}
// find#LeadRules: the rules of the caller's scope (current ones unless includeEnded), of one publication, campaign or organization when
// named, newest first, each with its handoff counts.
function findLeadRules(p) {
    const userScope = ruleScope()
    const ids = marketingAccess.organizationIds(userScope)
    let query = find(RULE)
        .condition("organizationPartyId", "in", ids.length ? ids : ["-"])
        .orderBy("-fromDate")
        .limit(limits.rows)
    if (!blank(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    if (!blank(p.publicationId)) query = query.condition("sourceId", text(p.publicationId))
    if (!blank(p.marketingCampaignId)) query = query.condition("marketingCampaignId", text(p.marketingCampaignId))
    let found = Array.from(query.list())
    if (!yes(p.includeEnded)) found = found.filter(rule => rule.thruDate == null || Number(ms(rule.thruDate)) > nowMs())
    const counts = {}
    if (found.length)
        for (const row of Array.from(
            find(COUNT)
                .condition(
                    "leadRuleId",
                    "in",
                    found.map(rule => rule.leadRuleId)
                )
                .selectField(["leadRuleId", "statusEnumId", "duplicate", "captureCount"])
                .list()
        )) {
            const entry = (counts[row.leadRuleId] ||= {handedOff: 0, failed: 0, pending: 0})
            const count = Number(row.captureCount || 0)
            if (row.statusEnumId === statuses.handedOff) entry.handedOff += count
            else if (row.statusEnumId === statuses.failed) entry.failed += count
            else if (row.statusEnumId === statuses.pending) entry.pending += count
        }
    return {
        ruleList: found.map(rule =>
            Object.assign(ruleView(rule), {
                handedOffCount: counts[rule.leadRuleId]?.handedOff || 0,
                failedCount: counts[rule.leadRuleId]?.failed || 0,
                pendingCount: counts[rule.leadRuleId]?.pending || 0
            })
        )
    }
}
// The lead form publications of the scope a new rule may route (not closed, no current rule), newest first.
function leadPublicationOptions(userScope) {
    const ids = marketingAccess.organizationIds(userScope)
    return Array.from(
        find(PUBLICATION)
            .condition("purposeEnumId", LEAD_PURPOSE)
            .condition("organizationPartyId", "in", ids.length ? ids : ["-"])
            .orderBy("-createdDate")
            .limit(limits.rows)
            .list()
    )
        .filter(row => publications().stateOf(row) !== "closed" && !ruleAt(row.publicationId))
        .filter(row => {
            const form = one(FORM, {formId: row.formId})
            return form && form.purposeEnumId === LEAD_FORM && form.ownerPartyId === row.organizationPartyId
        })
        .map(row => ({value: row.publicationId, label: row.titleText || row.description || row.publicationId}))
}
// get#LeadRule: one rule of the scope (or, with publicationId alone, what a new rule of that publication offers; with neither, the
// publications a new rule may route): its view, the publication's fields to map, the organization's current teams and offered
// sources, its recent captures and counts, and whether the caller may change it.
function getLeadRule(p) {
    const userScope = ruleScope()
    let rule = null,
        publication = null,
        form = null
    if (!blank(p.leadRuleId)) {
        rule = ruleOf(userScope, p.leadRuleId)
        ;({row: publication, form} = leadPublication(rule.sourceId))
    } else if (!blank(p.publicationId)) {
        ;({row: publication, form} = leadPublication(p.publicationId))
        if (!marketingAccess.covers(userScope, publication.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Lead form publication " + p.publicationId + " is not available")
        rule = ruleAt(publication.publicationId)
    }
    const canEdit = !!userScope.capabilities.contentEdit
    if (!publication) return {rule: null, publication: null, publicationOptions: leadPublicationOptions(userScope), canEdit}
    const org = publication.organizationPartyId
    const fields = customerFields(form.formId, null, true)
    const titles = Object.fromEntries(fields.map(field => [field.fieldName, field.title]))
    const view = rule ? ruleView(rule, titles) : null
    const settings = salesSettings()
    const canChooseTeam = teamChooser(org)
    const defaultTeamPartyId = defaultTeamOf(org)
    return {
        rule: view,
        publication: {
            publicationId: publication.publicationId,
            publicationText: publication.titleText || publication.description || publication.publicationId,
            formName: form.description || form.formId,
            state: publications().stateOf(publication),
            organizationPartyId: org,
            organizationName: partyName(org),
            marketingCampaignId: campaignOfPublication(publication),
            campaignName: campaignName(campaignOfPublication(publication))
        },
        choices: {
            fieldOptions: fields.map(field => ({value: field.fieldName, label: field.title})),
            teamOptions: settings.teamsOf(org).map(team => ({value: team.teamPartyId, label: team.teamName})),
            sourceOptions: settings.sourcesOffered(org).map(source => ({value: source.dataSourceId, label: source.description})),
            // without SALES_TEAM_MANAGE the team is shown, not chosen: the rule's own, or Sales' default for a new rule
            canChooseTeam,
            defaultTeamPartyId,
            teamText: view
                ? view.teamName
                : defaultTeamPartyId
                  ? teamNameOf(defaultTeamPartyId) + " " + L("(Sales' default team)")
                  : L("Sales' default team (none set): a sales manager chooses the team")
        },
        handoffs: rule ? Object.assign(countsOf({leadRuleId: rule.leadRuleId}, null), {}) : null,
        captures: rule ? captureRows(userScope, {leadRuleId: rule.leadRuleId}, 50) : [],
        canEdit: canEdit && (!rule || view.current) && publications().stateOf(publication) !== "closed"
    }
}
// store#LeadRule: a new rule of a lead form's publication (none current: RULE_EXISTS), a change of a current one (a new rule from now
// replacing it, at the revision read), or its end (end), by a content author of the publication's organization.
function storeLeadRule(p) {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "contentEdit")
    let previous = null
    if (!blank(p.leadRuleId)) {
        previous = find(RULE, {leadRuleId: text(p.leadRuleId)})
            .forUpdate(true)
            .one()
        if (!previous || !marketingAccess.covers(userScope, previous.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Lead rule " + p.leadRuleId + " is not available")
        if (!lib.active(previous)) denied("RULE_ENDED", "The lead rule has ended; make a new one")
        if (!blank(p.expectedRevision) && String(p.expectedRevision) !== revisionOf(previous))
            denied("REVISION_CHANGED", "The lead rule changed since you read it (revision " + revisionOf(previous) + ")")
    }
    const {row: publication, form} = leadPublication(previous ? previous.sourceId : p.publicationId)
    const org = publication.organizationPartyId
    if (!marketingAccess.covers(userScope, org))
        denied("RECORD_UNAVAILABLE", "Lead form publication " + (p.publicationId || "") + " is not available")
    const now = ec.user.nowTimestamp
    if (yes(p.end)) {
        if (!previous) denied("RECORD_REQUIRED", "Name the lead rule to end")
        call("update#" + RULE, {leadRuleId: previous.leadRuleId, thruDate: now, endedByUserId: ec.user.userId})
        return {leadRuleId: previous.leadRuleId, created: false}
    }
    if (publications().stateOf(publication) === "closed") denied("PUBLICATION_CLOSED", "The lead form is closed")
    if (!previous && ruleAt(publication.publicationId))
        denied("RULE_EXISTS", "The lead form already has a current lead rule: change that one")
    // the values: the previous rule's, with each one given (an empty one clears)
    const values = {}
    for (const name of RULE_FIELDS) {
        const given = p[name] !== undefined && p[name] !== null
        values[name] = given ? text(p[name]) : previous ? previous[name] || null : null
    }
    values.ruleName = limited(values.ruleName, limits.name)
    values.noticeText = limited(values.noticeText, limits.notice)
    // the team and the source: Sales' own, of the organization; a team other than the rule's own or Sales' default is a sales
    // manager's choice (the user's call of Nov 14, 2026)
    const defaultTeam = defaultTeamOf(org)
    if (
        values.teamPartyId &&
        values.teamPartyId !== (previous?.teamPartyId || null) &&
        values.teamPartyId !== defaultTeam &&
        !teamChooser(org)
    )
        denied(
            "TEAM_PERMISSION",
            "A sales manager (SALES_TEAM_MANAGE) chooses the lead rule's sales team; without it the rule takes Sales' default team"
        )
    if (values.teamPartyId) {
        const team = salesSettings().teamRow(values.teamPartyId)
        if (!team || team.organizationPartyId !== org || !salesSettings().inEffect(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current sales team of the organization as the queue")
    } else if (!defaultTeam)
        denied(
            "TEAM_REQUIRED",
            "The organization has no default sales team in Sales: a sales manager chooses the lead rule's team"
        )
    if (
        values.dataSourceId &&
        !salesSettings()
            .sourcesOffered(org)
            .some(row => row.dataSourceId === values.dataSourceId)
    )
        denied("SOURCE_INVALID", "Choose a lead source offered to the organization")
    // the mapping: the form's customer-visible fields only
    const known = new Set(customerFields(form.formId, null, true).map(field => field.fieldName))
    const notes = listOf(values.noteFieldNames)
    for (const name of [...Object.keys(LEAD_FIELDS).map(field => values[field]), ...notes, values.conditionFieldName])
        if (name && !known.has(name)) denied("FIELD_UNKNOWN", "Field " + name + " is not a question of the lead form")
    if (!Object.keys(LEAD_FIELDS).some(field => values[field]))
        denied("MAPPING_REQUIRED", "Map at least one question to the lead's name, organization, email or phone")
    values.noteFieldNames = notes.length ? notes.join(",") : null
    if (values.conditionFieldName && !values.conditionValue)
        denied("CONDITION_INVALID", "Give the answer the condition asks for, or no condition")
    if (!values.conditionFieldName) values.conditionValue = null
    if (previous) call("update#" + RULE, {leadRuleId: previous.leadRuleId, thruDate: now, endedByUserId: ec.user.userId})
    const made = call(
        "create#" + RULE,
        Object.assign(values, {
            organizationPartyId: org,
            sourceKindEnumId: SOURCE_PUBLICATION,
            sourceId: publication.publicationId,
            triggerEnumId: TRIGGER_FORM,
            marketingCampaignId: campaignOfPublication(publication),
            fromDate: now,
            createdDate: now,
            createdByUserId: ec.user.userId,
            replacesLeadRuleId: previous?.leadRuleId || null
        })
    )
    return {leadRuleId: made.leadRuleId, created: !previous}
}

// ===== the handoff =====
// A response's answers keyed by field.
const answerMapOf = formResponseId =>
    Object.fromEntries(
        rows("moqui.screen.form.FormResponseAnswer", {formResponseId}).map(answer => [answer.fieldName, answer.valueText])
    )
// The inquiry a capture hands to Sales, from Marketing's own records only: {request} for store#LeadIntake, or {skip} with the reason
// when the rule's condition is not met. A source that does not match its rule (another publication or organization) is refused.
function inquiryOf(rule, submission, publication, {sample = null, fields = null} = {}) {
    if (
        !rule ||
        !submission ||
        !publication ||
        publication.purposeEnumId !== LEAD_PURPOSE ||
        rule.sourceId !== publication.publicationId ||
        rule.organizationPartyId !== publication.organizationPartyId ||
        submission.organizationPartyId !== publication.organizationPartyId ||
        submission.publicationId !== publication.publicationId
    )
        denied("SOURCE_MISMATCH", "The answer is not of the lead rule's form")
    // the fields published when it was submitted: no other answer reaches Sales
    const published = new Map(
        (fields || customerFields(submission.formId, submission.submittedDate, false)).map(field => [field.fieldName, field])
    )
    const answers = sample || answerMapOf(submission.formResponseId)
    const answerOf = name => (name && published.has(name) && !blank(answers[name]) ? String(answers[name]).trim() : null)
    const displayOf = name => {
        const value = answerOf(name)
        if (value == null) return null
        const field = published.get(name)
        return forms().TYPES[field.fieldTypeEnumId]?.choice
            ? value
                  .split(",")
                  .map(part => field.options.find(option => option.key === part.trim())?.text || part.trim())
                  .join(", ")
            : value
    }
    if (rule.conditionFieldName) {
        const parts = (answerOf(rule.conditionFieldName) || "").split(",").map(part => part.trim())
        if (!parts.includes(String(rule.conditionValue || "").trim()))
            return {skip: "CONDITION_NOT_MET: " + L("The answer to the rule's condition does not match")}
    }
    const problems = []
    let email = answerOf(rule.emailFieldName)?.toLowerCase() || null
    if (email && (email.length > 254 || !emailPattern.test(email))) {
        problems.push(L("the email answer is not an address"))
        email = null
    }
    // verified only by Marketing's own verification: the invitation's address, or the signed-in account's, equal to the email answered
    let verified = false
    if (email && submission.invitationId) {
        const invitation = one(INVITATION, {invitationId: submission.invitationId})
        verified = !!invitation?.emailAddress && String(invitation.emailAddress).trim().toLowerCase() === email
    } else if (email && submission.partyId) {
        const account = Array.from(
            find("moqui.security.UserAccount", {partyId: submission.partyId}).selectField("emailAddress").limit(5).list()
        )
        verified = account.some(row => row.emailAddress && String(row.emailAddress).trim().toLowerCase() === email)
    }
    const notes = listOf(rule.noteFieldNames)
        .map(name => {
            const value = displayOf(name)
            return value == null ? null : published.get(name).title + ": " + value
        })
        .filter(Boolean)
        .join("\n")
    const name = limited(answerOf(rule.nameFieldName), limits.name)
    const organization = limited(answerOf(rule.organizationFieldName), limits.name)
    const title = publication.titleText || one(FORM, {formId: publication.formId})?.description || ""
    return {
        problems,
        request: {
            organizationPartyId: publication.organizationPartyId,
            sourceKind: "formResponse",
            sourceId: submission.formResponseId,
            submittedName: name,
            submittedOrganization: organization,
            submittedEmail: email,
            submittedPhone: limited(answerOf(rule.phoneFieldName), 60),
            verified,
            marketingCampaignId: campaignOfPublication(publication),
            defaultDataSourceId: rule.dataSourceId || null,
            teamPartyId: queueOf(rule),
            opportunityName: limited([organization || name || L("Inquiry"), title].filter(Boolean).join(" · "), limits.name),
            description: limited(notes, limits.notes)
        }
    }
}
// The next time a failed capture is tried: a wait doubling from five minutes up to a day, none after 30 days from its capture.
function nextAttemptOf(capture, attemptCount) {
    if (nowMs() - Number(ms(capture.capturedDate) ?? nowMs()) > limits.retryDays * DAY) return null
    const minutes = Math.min(limits.retryBaseMinutes * Math.pow(2, Math.max(0, attemptCount - 1)), limits.retryMaxMinutes)
    return new Date(nowMs() + minutes * 60000)
}
// hand#LeadCapture (internal, its own transaction): one capture under its lock, handed to Sales once, as the system, in a transaction of
// Sales' own, so its refusal is kept on the capture; a capture handed off or skipped answers as it is.
function handCapture(p) {
    const capture = find(CAPTURE, {leadCaptureId: text(p.leadCaptureId)})
        .forUpdate(true)
        .one()
    if (!capture) return {statusEnumId: null}
    if ([statuses.handedOff, statuses.skipped].includes(capture.statusEnumId))
        return {statusEnumId: capture.statusEnumId, salesOpportunityId: capture.salesOpportunityId || null}
    if (!blank(p.reprocessedByUserId)) {
        capture.set("reprocessedByUserId", text(p.reprocessedByUserId))
        capture.set("reprocessReason", limited(p.reprocessReason, limits.name))
    }
    const attemptCount = Number(capture.attemptCount || 0) + 1
    capture.set("attemptCount", attemptCount)
    capture.set("lastAttemptDate", ec.user.nowTimestamp)
    let problem = null,
        out = null,
        noteText = null
    try {
        const rule = one(RULE, {leadRuleId: capture.leadRuleId})
        const submission = one(SUBMISSION, {formSubmissionId: capture.sourceId})
        const publication = submission ? one(PUBLICATION, {publicationId: submission.publicationId}) : null
        const inquiry = inquiryOf(rule, submission, publication)
        if (inquiry.skip) {
            capture.set("statusEnumId", statuses.skipped)
            capture.set("errorText", limited(inquiry.skip, limits.error))
            capture.set("nextAttemptDate", null)
            capture.update()
            return {statusEnumId: statuses.skipped}
        }
        const request = Object.assign(inquiry.request, {operationKey: capture.operationKey})
        ec.message.pushErrors()
        try {
            out = ec.artifactExecution.runAsSystem(
                () => ec.service.sync().name(INTAKE_SERVICE).parameters(request).requireNewTransaction(true).call() || {}
            )
            if (ec.message.hasError()) problem = ec.message.getErrorsString()
        } catch (error) {
            problem = String(error?.message || error)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        if (!problem && !out?.salesOpportunityId) problem = "NO_LEAD: " + L("Sales answered no lead")
        noteText = limited(inquiry.problems.join("; "), limits.error)
    } catch (error) {
        problem = String(error?.message || error)
        ec.message.clearErrors()
    }
    if (problem) {
        capture.set("statusEnumId", statuses.failed)
        capture.set("errorText", limited(firstLine(problem), limits.error))
        capture.set("nextAttemptDate", nextAttemptOf(capture, attemptCount))
        capture.update()
        ec.logger.warn("Lead capture " + capture.leadCaptureId + " not handed to Sales: " + firstLine(problem))
        return {statusEnumId: statuses.failed, errorText: capture.errorText}
    }
    capture.set("statusEnumId", statuses.handedOff)
    capture.set("salesOpportunityId", out.salesOpportunityId)
    capture.set("salesLeadIntakeId", out.salesLeadIntakeId || null)
    capture.set("duplicate", out.duplicate ? "Y" : "N")
    capture.set("handedOffDate", ec.user.nowTimestamp)
    capture.set("nextAttemptDate", null)
    capture.set("errorText", noteText)
    capture.update()
    return {statusEnumId: statuses.handedOff, salesOpportunityId: out.salesOpportunityId}
}
// The capture of a submission by its rule, made once (the rule and source event are unique): the capture row.
function ensureCapture(rule, submission, publication) {
    const existing = one(CAPTURE, {
        leadRuleId: rule.leadRuleId,
        sourceKindEnumId: SOURCE_SUBMISSION,
        sourceId: submission.formSubmissionId
    })
    if (existing) return {capture: existing, created: false}
    const leadCaptureId = ec.entity.sequencedIdPrimary(CAPTURE, 0, 50)
    call("create#" + CAPTURE, {
        leadCaptureId,
        leadRuleId: rule.leadRuleId,
        organizationPartyId: publication.organizationPartyId,
        sourceKindEnumId: SOURCE_SUBMISSION,
        sourceId: submission.formSubmissionId,
        publicationId: publication.publicationId,
        formResponseId: submission.formResponseId,
        marketingCampaignId: campaignOfPublication(publication),
        statusEnumId: statuses.pending,
        operationKey: "mkt-lead:" + leadCaptureId,
        attemptCount: 0,
        capturedDate: ec.user.nowTimestamp
    })
    return {capture: one(CAPTURE, {leadCaptureId}), created: true}
}
// capture#FormSubmission (internal, its own transaction; after a lead form's answer commits, and the capture job): the submission
// captured by the rule in effect when it was submitted, once, and handed to Sales. {captured, statusEnumId}.
function captureSubmission(p) {
    const submission = blank(p.formSubmissionId) ? null : one(SUBMISSION, {formSubmissionId: text(p.formSubmissionId)})
    const publication = submission ? one(PUBLICATION, {publicationId: submission.publicationId}) : null
    if (!publication || publication.purposeEnumId !== LEAD_PURPOSE) return {captured: false}
    const rule = ruleAt(publication.publicationId, submission.submittedDate)
    if (!rule) return {captured: false}
    const {capture, created} = ensureCapture(rule, submission, publication)
    if (!created && [statuses.handedOff, statuses.skipped, statuses.failed].includes(capture.statusEnumId))
        return {captured: false, statusEnumId: capture.statusEnumId}
    return Object.assign({captured: created}, handCapture({leadCaptureId: capture.leadCaptureId}))
}
// A service in a transaction of its own; its errors thrown, the caller's kept apart.
function apart(name, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return out
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// run#LeadCaptures (the capture job, as the system): the accepted answers of each rule's lead form in the last 30 days with no capture
// yet captured (each its own transaction), then the pending captures and the failed ones whose time has come handed to Sales (each
// its own transaction); one that fails is logged and the next goes on.
function runLeadCaptures(p) {
    const totals = {captured: 0, handedOff: 0, failed: 0, skipped: 0}
    const since = new Date(nowMs() - limits.collectDays * DAY)
    let ruleQuery = find(RULE, {sourceKindEnumId: SOURCE_PUBLICATION})
        .condition(
            ec.entity.conditionFactory.makeCondition(
                [
                    ec.entity.conditionFactory.makeCondition("thruDate", "is-null", null),
                    ec.entity.conditionFactory.makeCondition("thruDate", "greater-equals", since)
                ],
                "or"
            )
        )
        .orderBy("fromDate")
        .limit(limits.rulesPerRun)
    if (!blank(p.leadRuleId)) ruleQuery = ruleQuery.condition("leadRuleId", text(p.leadRuleId))
    const tally = statusEnumId => {
        if (statusEnumId === statuses.handedOff) totals.handedOff++
        else if (statusEnumId === statuses.failed) totals.failed++
        else if (statusEnumId === statuses.skipped) totals.skipped++
    }
    for (const rule of Array.from(ruleQuery.list())) {
        try {
            const from = Math.max(Number(ms(rule.fromDate) ?? 0), Number(ms(since)))
            // page past the answers already captured, so a busy form's later answers are reached (at most submissionsPerRule
            // captured a run; the rest the next run)
            let attempted = 0
            for (let page = 0; page < limits.pagesPerRule && attempted < limits.submissionsPerRule; page++) {
                let submissions = find(SUBMISSION, {publicationId: rule.sourceId})
                    .condition("submittedDate", "greater-equals", new Date(from))
                    .orderBy(["submittedDate", "formSubmissionId"])
                    .offset(page * limits.submissionsPerRule)
                    .limit(limits.submissionsPerRule)
                if (rule.thruDate != null) submissions = submissions.condition("submittedDate", "less", rule.thruDate)
                const found = Array.from(submissions.list())
                if (!found.length) break
                const captured = new Set(
                    Array.from(
                        find(CAPTURE, {leadRuleId: rule.leadRuleId, sourceKindEnumId: SOURCE_SUBMISSION})
                            .condition(
                                "sourceId",
                                "in",
                                found.map(row => row.formSubmissionId)
                            )
                            .selectField("sourceId")
                            .list()
                    ).map(row => row.sourceId)
                )
                for (const submission of found.filter(row => !captured.has(row.formSubmissionId))) {
                    if (attempted >= limits.submissionsPerRule) break
                    attempted++
                    try {
                        const out = apart(SERVICES + "capture#FormSubmission", {formSubmissionId: submission.formSubmissionId})
                        if (out.captured) totals.captured++
                        tally(out.statusEnumId)
                    } catch (error) {
                        totals.failed++
                        ec.logger.error(
                            "Lead form answer " + submission.formSubmissionId + " not captured: " + firstLine(error?.message)
                        )
                    }
                }
                if (found.length < limits.submissionsPerRule) break
            }
        } catch (error) {
            ec.logger.error("Lead rule " + rule.leadRuleId + ": its answers were not read: " + firstLine(error?.message))
        }
    }
    const factory = ec.entity.conditionFactory
    let due = find(CAPTURE)
        .condition(
            factory.makeCondition(
                [
                    factory.makeCondition("statusEnumId", "equals", statuses.pending),
                    factory.makeCondition([
                        factory.makeCondition("statusEnumId", "equals", statuses.failed),
                        factory.makeCondition("nextAttemptDate", "less-equals", ec.user.nowTimestamp)
                    ])
                ],
                "or"
            )
        )
        .orderBy("capturedDate")
        .limit(limits.capturesPerRun)
    if (!blank(p.leadRuleId)) due = due.condition("leadRuleId", text(p.leadRuleId))
    for (const capture of Array.from(due.selectField("leadCaptureId").list())) {
        try {
            tally(apart(SERVICES + "hand#LeadCapture", {leadCaptureId: capture.leadCaptureId}).statusEnumId)
        } catch (error) {
            totals.failed++
            ec.logger.error("Lead capture " + capture.leadCaptureId + " not handed to Sales: " + firstLine(error?.message))
        }
    }
    return totals
}
// process#LeadCaptures (ReprocessCapture, design §10): the failed or waiting captures named (or a rule's failed ones) of the caller's
// scope handed to Sales again, each in its own transaction, with the reason; a capture already handed off or skipped is left as it is.
function processLeadCaptures(p) {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "contentEdit")
    const reason = limited(p.reason, limits.name)
    if (!reason) denied("REASON_REQUIRED", "Say why the handoff is tried again")
    let ids = listOf(p.leadCaptureIds)
    if (!ids.length && !blank(p.leadRuleId)) {
        const rule = ruleOf(userScope, p.leadRuleId)
        ids = Array.from(
            find(CAPTURE, {leadRuleId: rule.leadRuleId, statusEnumId: statuses.failed})
                .selectField("leadCaptureId")
                .orderBy("capturedDate")
                .limit(limits.ids)
                .list()
        ).map(row => row.leadCaptureId)
    }
    if (!ids.length) denied("RECORD_REQUIRED", "Choose the handoffs to try again")
    if (ids.length > limits.ids) denied("TOO_MANY", "Try at most " + limits.ids + " handoffs at a time")
    const totals = {handedOff: 0, failed: 0, unchanged: 0, unavailable: 0}
    const results = []
    for (const leadCaptureId of ids) {
        const capture = one(CAPTURE, {leadCaptureId})
        if (!capture || !marketingAccess.covers(userScope, capture.organizationPartyId)) {
            totals.unavailable++
            results.push({leadCaptureId, statusText: L("Not available")})
            continue
        }
        if (![statuses.failed, statuses.pending].includes(capture.statusEnumId)) {
            totals.unchanged++
            results.push({leadCaptureId, statusText: enumText(capture.statusEnumId)})
            continue
        }
        try {
            const out = apart(SERVICES + "hand#LeadCapture", {
                leadCaptureId,
                reprocessedByUserId: ec.user.userId,
                reprocessReason: reason
            })
            if (out.statusEnumId === statuses.handedOff) totals.handedOff++
            else if (out.statusEnumId === statuses.failed) totals.failed++
            else totals.unchanged++
            results.push({leadCaptureId, statusText: enumText(out.statusEnumId), errorText: out.errorText || ""})
        } catch (error) {
            totals.failed++
            results.push({leadCaptureId, statusText: L("Handoff failed"), errorText: firstLine(error?.message)})
        }
    }
    return Object.assign(totals, {results})
}

// ===== captures and the preview =====
// The captures of the conditions for a reader of the scope, newest first: state, attempts, reason and when it is tried again; its Sales
// lead named only when the caller can open it in Sales.
function captureRows(userScope, conditions, limit = limits.rows) {
    const ids = marketingAccess.organizationIds(userScope)
    let query = find(CAPTURE, conditions)
        .condition("organizationPartyId", "in", ids.length ? ids : ["-"])
        .orderBy("-capturedDate")
        .limit(limit)
    let salesScope = null
    try {
        salesScope = salesAccess().scope()
    } catch (error) {
        salesScope = null
    }
    return Array.from(query.list()).map(capture => {
        const visible =
            !!capture.salesOpportunityId && !!salesScope && !!salesAccess().opportunityOf(salesScope, capture.salesOpportunityId)
        return {
            leadCaptureId: capture.leadCaptureId,
            leadRuleId: capture.leadRuleId,
            publicationId: capture.publicationId,
            statusEnumId: capture.statusEnumId,
            statusText: enumText(capture.statusEnumId),
            statusColor: statusColors[capture.statusEnumId] || "grey",
            capturedText: lib.dateText(capture.capturedDate),
            handedOffText: lib.dateText(capture.handedOffDate),
            attemptCount: Number(capture.attemptCount || 0),
            errorText: capture.errorText || "",
            nextAttemptText: lib.dateText(capture.nextAttemptDate),
            outcomeText:
                capture.statusEnumId === statuses.handedOff
                    ? capture.duplicate === "Y"
                        ? L("Joined an open lead")
                        : L("New lead")
                    : "",
            salesOpportunityId: visible ? capture.salesOpportunityId : null,
            retryable: [statuses.failed, statuses.pending].includes(capture.statusEnumId),
            operationKey: capture.operationKey
        }
    })
}
// find#LeadCaptures: the captures of a rule, a campaign or a publication of the caller's scope, of one state when named.
function findLeadCaptures(p) {
    const userScope = readScope()
    const conditions = {}
    if (!blank(p.leadRuleId)) conditions.leadRuleId = ruleOf(userScope, p.leadRuleId).leadRuleId
    if (!blank(p.marketingCampaignId)) conditions.marketingCampaignId = text(p.marketingCampaignId)
    if (!blank(p.publicationId)) conditions.publicationId = text(p.publicationId)
    if (!blank(p.statusEnumId)) conditions.statusEnumId = text(p.statusEnumId)
    if (!conditions.leadRuleId && !conditions.marketingCampaignId && !conditions.publicationId)
        denied("RECORD_REQUIRED", "Name a lead rule, a campaign or a lead form")
    return {captureList: captureRows(userScope, conditions)}
}
// preview#LeadRule (LeadRulePreview): what a rule (saved, or the values given for a new one of a publication) would hand to Sales for a
// sample answer: the latest answer of the publication (or the one named) for an audience reader, else an answer made of the questions'
// titles; the mapped values, the notes, the condition, the queue and source, verification and the duplicate policy, and a capture
// already made of that answer with its outcome. Changes nothing.
function previewLeadRule(p) {
    const userScope = ruleScope()
    let rule = null
    if (!blank(p.leadRuleId)) rule = ruleOf(userScope, p.leadRuleId)
    const {row: publication, form} = leadPublication(rule ? rule.sourceId : p.publicationId)
    if (!marketingAccess.covers(userScope, publication.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Lead form publication " + (p.publicationId || "") + " is not available")
    const draft = Object.assign({}, rule ? lib.map(rule) : {}, {sourceId: publication.publicationId})
    for (const name of RULE_FIELDS) if (p[name] !== undefined && p[name] !== null) draft[name] = text(p[name])
    draft.organizationPartyId = publication.organizationPartyId
    const audience = !!userScope.capabilities.audienceRead
    let submission = null
    if (audience) {
        submission = !blank(p.formSubmissionId)
            ? one(SUBMISSION, {formSubmissionId: text(p.formSubmissionId)})
            : Array.from(
                  find(SUBMISSION, {publicationId: publication.publicationId}).orderBy("-submittedDate").limit(1).list()
              )[0] || null
        if (submission && submission.publicationId !== publication.publicationId)
            denied("RECORD_UNAVAILABLE", "Answer " + p.formSubmissionId + " is not available")
    }
    const reasons = []
    let sample = null
    if (!submission) {
        // an answer made of the questions' titles (a choice's first option), as of now
        const fields = customerFields(form.formId, null, true)
        sample = Object.fromEntries(
            fields.map(field => [field.fieldName, field.options?.length ? field.options[0].key : "[" + field.title + "]"])
        )
        submission = {
            formSubmissionId: null,
            publicationId: publication.publicationId,
            organizationPartyId: publication.organizationPartyId,
            formId: form.formId,
            formResponseId: null,
            submittedDate: null,
            invitationId: null,
            partyId: null
        }
        reasons.push(audience ? L("No answer yet: a sample made of the questions") : L("A sample made of the questions"))
    }
    let inquiry
    try {
        // a sample answer is read against the questions now, drafts too
        inquiry = sample
            ? inquiryOf(draft, submission, publication, {sample, fields: customerFields(form.formId, null, true)})
            : inquiryOf(draft, submission, publication)
    } catch (error) {
        denied(lib.reasonCode(error) || "PREVIEW_FAILED", firstLine(String(error?.message).replace(/^[A-Z_]+: /, "")))
    }
    const queue = queueOf(draft)
    const team = queue ? salesSettings().teamRow(queue) : null
    const capture =
        rule && submission.formSubmissionId
            ? one(CAPTURE, {
                  leadRuleId: rule.leadRuleId,
                  sourceKindEnumId: SOURCE_SUBMISSION,
                  sourceId: submission.formSubmissionId
              })
            : null
    const request = inquiry.request || {}
    if (inquiry.skip) reasons.push(L("Not handed off: the answer to the condition does not match"))
    for (const problem of inquiry.problems || []) reasons.push(problem)
    if (!team) reasons.push(L("No sales team is chosen: Sales refuses the handoff"))
    const shown = value => (value == null ? "" : String(value))
    return {
        preview: {
            sampleText: sample ? L("A sample answer") : L("The answer of") + " " + lib.dateText(submission.submittedDate),
            values: [
                {label: L("Name"), valueText: shown(request.submittedName)},
                {label: L("Organization"), valueText: shown(request.submittedOrganization)},
                {label: L("Email"), valueText: shown(request.submittedEmail)},
                {label: L("Phone"), valueText: shown(request.submittedPhone)},
                {label: L("Lead"), valueText: shown(request.opportunityName)},
                {label: L("Notes"), valueText: shown(request.description)}
            ],
            handedOff: !inquiry.skip,
            queueText: team ? team.teamName : "",
            sourceText: draft.dataSourceId
                ? (one("moqui.basic.DataSource", {dataSourceId: draft.dataSourceId})?.description || draft.dataSourceId) +
                  " " +
                  L("(unless the organization's UTM map names another)")
                : L("The organization's UTM map, else none"),
            campaignText: campaignName(campaignOfPublication(publication)),
            verifiedText: request.verified ? L("Verified by the invitation or account") : L("Unverified"),
            duplicateText: L("An open lead of the organization with the same email takes this inquiry as Sales' review item"),
            captureText: capture ? enumText(capture.statusEnumId) + (capture.errorText ? ": " + capture.errorText : "") : "",
            reasons
        }
    }
}
// ===== for the other modules =====
// The notice a lead form's page shows (its current rule's), or null.
function noticeOf(publicationId) {
    return ruleAt(publicationId)?.noticeText || null
}
// Whether a lead form's publication has a current rule (its readiness).
const routed = publicationId => !!ruleAt(publicationId)
// After a lead form's answer commits: its capture and handoff on a service worker, in their own transaction (the answer never waits
// on Sales); the capture job takes up an answer this misses.
function captureAfterCommit(formSubmissionId) {
    ec.service
        .special()
        .name(SERVICES + "capture#FormSubmission")
        .parameters({formSubmissionId})
        .registerOnCommit()
}

const operations = {
    findLeadRules,
    getLeadRule,
    storeLeadRule,
    previewLeadRule,
    findLeadCaptures,
    getLeadHandoffs,
    processLeadCaptures,
    runLeadCaptures,
    captureSubmission,
    handCapture
}
;({
    noticeOf,
    routed,
    captureAfterCommit,
    // each operation checks the caller's Marketing scope and permission (the internal ones run as the system), and reads and writes
    // with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing lead operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
