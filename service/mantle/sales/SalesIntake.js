// Sales' lead intake (IronStone Sales design §3 Leads, §9 LeadSources UtmSourceMap, §11 LeadIntakeForms, §1.4 CX-MAIL-INTAKE and
// CX-SYNC; impl-sales P5; X10, X15, X16): store#LeadIntake, the one door an inquiry comes in by (a mail rule, a Comms action, a
// staff entry, Marketing's lead rules), the mail rule action createLead, the organization's UTM source map, the purge of
// unverified intakes, and the "My accounts" projected address book.
//
// - An intake (SalesLeadIntake) holds what the inquirer submitted, never on the deal and never as a new party; the party is made at
//   qualification (qualify#Lead).
// - One source identity (the kind and its id: a form response, a mail message by its Message-ID, a communication event, a chat
//   message, a voicemail) makes one intake, and a repeated operation key answers the first result; another request under the key is
//   OPERATION_KEY_CONFLICT. The key is the intake's own, not a PostingOperation, so Marketing's capture job and an operator's
//   reprocess of the same capture answer alike whoever runs them.
// - The duplicate policy: an open lead of the organization that an earlier intake with the same submitted email made or joined is
//   joined (outcome SlioDuplicate, a review item on that lead), never merged and never answered to a public caller.
// - The caller: a user needs SALES_OPPORTUNITY_EDIT and the organization in their scope, and assigns as create#Opportunity does; a
//   system caller (no user, or authorization disabled: the mail rule, Marketing's capture job) vouches for its own source and names
//   a current team of the organization as the queue.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const settings = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const {find, one, rows, denied, call, ms} = lib

const INTAKE = "mantle.sales.opportunity.SalesLeadIntake"
const SOURCE_MAP = "mantle.sales.opportunity.SalesLeadSourceMap"
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const OPPORTUNITY_PARTY = "mantle.sales.opportunity.SalesOpportunityParty"
const TRACKING = "mantle.sales.opportunity.SalesOpportunityTracking"
const roles = salesAccess.opportunityRoles
const sourceKinds = {
    formResponse: "SlisFormResponse",
    emailMessage: "SlisEmailMessage",
    communicationEvent: "SlisCommEvent",
    chatMessage: "SlisChatMessage",
    voicemail: "SlisVoicemail",
    staff: "SlisStaff"
}
const outcomes = {created: "SlioCreated", duplicate: "SlioDuplicate"}
const defaultRetentionDays = 30
const plusTagSetting = "SalesIntakePlusTag"
const sourceSetting = "SalesIntakeSource"
const projectionLimit = 2000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = value => ec.l10n.localize(value)
const nowMs = () => ms(ec.user.nowTimestamp)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const lower = value => (blank(value) ? null : String(value).trim().toLowerCase())
const limited = (value, length) => (blank(value) ? null : String(value).trim().substring(0, length))
const flag = value => value === true || value === "true" || value === "Y"
const isSystem = () => !ec.user.userId || ec.artifactExecution.authzDisabled()
// HTML mail as plain text, for a lead's description
const plainText = html =>
    String(html || "")
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n\s*\n+/g, "\n\n")
        .trim()

// ===== store#LeadIntake =====
function sourceKindOf(value) {
    const wanted = text(value)
    if (wanted && Object.hasOwn(sourceKinds, wanted)) return sourceKinds[wanted]
    if (wanted && Object.values(sourceKinds).includes(wanted)) return wanted
    denied("SOURCE_KIND_INVALID", "The source kind is one of " + Object.keys(sourceKinds).join(", "))
}
function emailOf(value) {
    const email = lower(value)
    if (email && !/^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(email))
        denied("EMAIL_INVALID", "The submitted email is not an address")
    return email ? email.substring(0, 254) : null
}
// The lead source of a tracked link's UTM pair in the organization: its current row for the source and medium, else for the source
// alone (no medium), else null (the caller's default stands).
function mappedSource(organizationPartyId, utmSource, utmMedium) {
    if (!utmSource) return null
    const current = rows(SOURCE_MAP, {organizationPartyId, utmSource}).filter(row => settings.inEffect(row))
    const both = utmMedium ? current.find(row => row.utmMedium === utmMedium) : null
    const alone = current.find(row => blank(row.utmMedium))
    return (both || alone)?.dataSourceId || null
}
// The answer for an intake: the lead it made or joined, and whether this call made it.
function answerOf(intake, alreadyApplied) {
    return {
        salesLeadIntakeId: intake.salesLeadIntakeId,
        salesOpportunityId: intake.salesOpportunityId,
        outcomeEnumId: intake.outcomeEnumId,
        duplicate: intake.outcomeEnumId === outcomes.duplicate,
        dataSourceId: intake.dataSourceId || null,
        alreadyApplied
    }
}
// The assignment of a new lead: a system caller's queue is the team it names (a current team of the organization), with an owner
// only when one is named who works for it; a user's is themselves (when they work for the organization) or the person they name
// (in their teams, unless SALES_TEAM_MANAGE), on the team named (one of theirs, unless SALES_TEAM_MANAGE) or the owner's only team
// there.
function assignmentOf(userScope, organizationPartyId, p) {
    const teamPartyId = text(p.teamPartyId)
    let team = null
    if (teamPartyId) {
        team = settings.teamRow(teamPartyId)
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship))
            denied("TEAM_UNAVAILABLE", "Choose a current team of the organization as the queue")
    }
    let ownerPartyId = text(p.ownerPartyId)
    if (!userScope) {
        if (!team) denied("TEAM_REQUIRED", "Name the team whose queue the lead goes to")
        if (ownerPartyId && !settings.worksFor(ownerPartyId, organizationPartyId))
            denied("OWNER_INVALID", "The owner must be a person who works for the organization")
        return {teamPartyId: team.teamPartyId, ownerPartyId}
    }
    if (!ownerPartyId && settings.worksFor(userScope.partyId, organizationPartyId)) ownerPartyId = userScope.partyId
    if (ownerPartyId) {
        if (!settings.worksFor(ownerPartyId, organizationPartyId))
            denied("OWNER_INVALID", "The owner must be a person who works for the organization")
        if (ownerPartyId !== userScope.partyId && !userScope.capabilities.teamManage) {
            const mine = salesAccess.memberTeams(userScope.partyId)
            if (!salesAccess.memberTeams(ownerPartyId).some(partyId => mine.includes(partyId)))
                denied("PERMISSION_DENIED", "A sales manager assigns a lead outside your teams")
        }
    }
    if (team && !userScope.capabilities.teamManage && !salesAccess.memberTeams(userScope.partyId).includes(team.teamPartyId))
        denied("PERMISSION_DENIED", "A sales manager puts a lead in a team you are not in")
    let chosenTeam = team?.teamPartyId || null
    if (!chosenTeam && ownerPartyId) {
        const teams = salesAccess
            .memberTeams(ownerPartyId)
            .filter(partyId => salesAccess.teamOrganization(partyId) === organizationPartyId)
        chosenTeam = teams.length === 1 ? teams[0] : null
    }
    if (!ownerPartyId && !chosenTeam) denied("ASSIGNMENT_REQUIRED", "Choose the lead's owner or team")
    return {teamPartyId: chosenTeam, ownerPartyId}
}
// The open lead of the organization an earlier intake with this email made or joined (the duplicate policy), or null; for a user
// caller only a lead they see (P5 review R1), so a rep's inquiry is never filed out of their sight on another team's lead and the
// answer names no lead they may not open.
function openLeadOf(organizationPartyId, submittedEmail, userScope) {
    if (!submittedEmail) return null
    const leadIds = Array.from(
        new Set(
            Array.from(
                find(INTAKE, {organizationPartyId, submittedEmail})
                    .condition("purgedDate", null)
                    .selectField("salesOpportunityId")
                    .list()
            )
                .map(row => row.salesOpportunityId)
                .filter(Boolean)
        )
    )
    if (!leadIds.length) return null
    return (
        Array.from(
            find(OPPORTUNITY)
                .condition("salesOpportunityId", "in", leadIds)
                .condition("typeEnumId", "SotLead")
                .condition("statusId", "in", ["SalesOppOpen"])
                .orderBy("createdDate")
                .limit(userScope ? 50 : 1)
                .list()
        ).find(row => !userScope || salesAccess.opportunityOf(userScope, row.salesOpportunityId)) || null
    )
}
// The first result of an intake for a repeat: a system caller's whoever made it; a user's only when they see its lead (P5 review
// R1), else one refusal that names no lead and no organization.
function replayOf(intake, userScope) {
    if (userScope && !(intake.salesOpportunityId && salesAccess.opportunityOf(userScope, intake.salesOpportunityId)))
        denied("INTAKE_TAKEN", "This inquiry is already a lead you cannot open")
    return answerOf(intake, true)
}
function storeLeadIntake(p) {
    const system = isSystem()
    const organizationPartyId = text(p.organizationPartyId)
    if (!organizationPartyId || !salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + (organizationPartyId || "") + " is not available")
    let userScope = null
    if (!system) {
        userScope = salesAccess.scope()
        salesAccess.requireCapability(userScope, "opportunityEdit")
        salesAccess.requireCapability(userScope, "anyRead")
        salesAccess.requireOrganization(userScope, organizationPartyId)
    }
    const sourceKindEnumId = sourceKindOf(p.sourceKind)
    const sourceId = limited(p.sourceId, 255)
    if (!sourceId && sourceKindEnumId !== sourceKinds.staff)
        denied("SOURCE_REQUIRED", "Name the message or response the inquiry came from")
    const operationKey = text(p.operationKey)
    if (operationKey && operationKey.length > 60) denied("OPERATION_KEY_INVALID", "An operation key has at most 60 characters")
    if (!operationKey && !sourceId) denied("OPERATION_KEY_REQUIRED", "A staff entry needs an operation key")
    const submittedEmail = emailOf(p.submittedEmail)
    const request = {
        organizationPartyId,
        sourceKindEnumId,
        sourceId,
        submittedName: limited(p.submittedName, 255),
        submittedOrganization: limited(p.submittedOrganization, 255),
        submittedEmail,
        submittedPhone: limited(p.submittedPhone, 60),
        utmSource: lower(p.utmSource)?.substring(0, 60) || null,
        utmMedium: lower(p.utmMedium)?.substring(0, 60) || null,
        marketingCampaignId: text(p.marketingCampaignId),
        trackingCodeId: text(p.trackingCodeId),
        defaultDataSourceId: text(p.defaultDataSourceId),
        teamPartyId: text(p.teamPartyId),
        ownerPartyId: text(p.ownerPartyId),
        opportunityName: limited(p.opportunityName, 255),
        verified: flag(p.verified)
    }
    const requestHash = lib.hash(request)
    // a repeated key answers the first result; another request under it is refused
    if (operationKey) {
        const old = one(INTAKE, {operationKey})
        if (old) {
            if (old.requestHash !== requestHash || old.organizationPartyId !== organizationPartyId)
                denied("OPERATION_KEY_CONFLICT", "Operation key was used for another request")
            return replayOf(old, userScope)
        }
    }
    // one source identity, one intake
    if (sourceId) {
        const old = one(INTAKE, {sourceKindEnumId, sourceId})
        if (old) {
            if (!userScope && old.organizationPartyId !== organizationPartyId)
                denied("SOURCE_TAKEN", "This inquiry already came in for another organization")
            if (userScope && old.organizationPartyId !== organizationPartyId)
                denied("INTAKE_TAKEN", "This inquiry is already a lead you cannot open")
            return replayOf(old, userScope)
        }
    }
    const assignment = assignmentOf(userScope, organizationPartyId, p)
    // the source: the UTM map's, else the caller's default (offered to the organization)
    let dataSourceId = mappedSource(organizationPartyId, request.utmSource, request.utmMedium)
    if (!dataSourceId && request.defaultDataSourceId) {
        if (!settings.sourcesOffered(organizationPartyId).some(row => row.dataSourceId === request.defaultDataSourceId))
            denied("SOURCE_INVALID", "Choose a lead source offered to the organization")
        dataSourceId = request.defaultDataSourceId
    }
    let marketingCampaignId = request.marketingCampaignId
    let tracking = null
    if (request.trackingCodeId) {
        tracking = one("mantle.marketing.tracking.TrackingCode", {trackingCodeId: request.trackingCodeId})
        if (!tracking) denied("TRACKING_INVALID", "Tracking code " + request.trackingCodeId + " is not available")
        if (!marketingCampaignId) marketingCampaignId = tracking.marketingCampaignId || null
    }
    if (marketingCampaignId && !one("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId}))
        denied("CAMPAIGN_INVALID", "Campaign " + marketingCampaignId + " is not available")
    // the duplicate policy: an open lead an intake with this email made joins this one too
    const existing = openLeadOf(organizationPartyId, submittedEmail, userScope)
    let salesOpportunityId = existing?.salesOpportunityId || null
    if (!existing) {
        const opportunityName =
            request.opportunityName || request.submittedOrganization || L("Inquiry") + " " + dayText(ec.user.nowTimestamp)
        salesOpportunityId = call("create#" + OPPORTUNITY, {
            typeEnumId: "SotLead",
            organizationPartyId,
            opportunityName,
            description: limited(p.description, 20000),
            probabilityModeEnumId: "SpmStage",
            dataSourceId,
            marketingCampaignId,
            statusId: "SalesOppOpen",
            createdDate: ec.user.nowTimestamp
        }).salesOpportunityId
        const start = (partyId, roleTypeId) =>
            call("create#" + OPPORTUNITY_PARTY, {salesOpportunityId, partyId, roleTypeId, fromDate: ec.user.nowTimestamp})
        start(organizationPartyId, roles.organization)
        if (assignment.ownerPartyId) start(assignment.ownerPartyId, roles.owner)
        if (assignment.teamPartyId) start(assignment.teamPartyId, roles.team)
    }
    if (tracking && !one(TRACKING, {salesOpportunityId, trackingCodeId: tracking.trackingCodeId}))
        call("create#" + TRACKING, {
            salesOpportunityId,
            trackingCodeId: tracking.trackingCodeId,
            receivedDate: ec.user.nowTimestamp
        })
    const intake = call("create#" + INTAKE, {
        organizationPartyId,
        salesOpportunityId,
        sourceKindEnumId,
        sourceId,
        outcomeEnumId: existing ? outcomes.duplicate : outcomes.created,
        operationKey,
        requestHash,
        submittedName: request.submittedName,
        submittedOrganization: request.submittedOrganization,
        submittedEmail,
        submittedPhone: request.submittedPhone,
        verifiedDate: request.verified ? ec.user.nowTimestamp : null,
        utmSource: request.utmSource,
        utmMedium: request.utmMedium,
        marketingCampaignId,
        trackingCodeId: tracking?.trackingCodeId || null,
        dataSourceId,
        teamPartyId: assignment.teamPartyId,
        receivedDate: ec.user.nowTimestamp,
        receivedByUserId: ec.user.userId || null
    })
    return answerOf(one(INTAKE, {salesLeadIntakeId: intake.salesLeadIntakeId}), false)
}

// ===== create#LeadFromEmail: the createLead mail rule action =====
// The team a message is for: the rule's value (a team's partyId), else the team whose SalesIntakePlusTag one of its To or Cc
// addresses carries (sales+leads@...); only a current team of an organization the rule's owner works for, so a rule cannot file
// into another organization. The team row, or null.
function intakeTeam(message, value, ruleOwnerUserId) {
    let candidates = []
    if (!blank(value)) candidates = [text(value)]
    else {
        const tags = new Set()
        for (const list of [message.toAddresses, message.ccAddresses])
            for (const match of String(list || "").matchAll(/[^\s<>,;"]+\+([A-Za-z0-9._-]+)@[^\s<>,;"]+/g))
                tags.add(match[1].toLowerCase())
        if (!tags.size) return null
        candidates = rows("mantle.party.PartySetting", {partySettingTypeId: plusTagSetting})
            .filter(row => tags.has(lower(row.settingValue)))
            .map(row => row.partyId)
    }
    const ownerPartyId = ruleOwnerUserId ? one("moqui.security.UserAccount", {userId: ruleOwnerUserId})?.partyId : null
    for (const partyId of candidates) {
        const team = settings.teamRow(partyId)
        if (!team || !settings.inEffect(team.relationship)) continue
        if (!ownerPartyId || !settings.worksFor(ownerPartyId, team.organizationPartyId)) {
            ec.logger.warn(
                "Email " +
                    message.emailMessageId +
                    ": the rule of " +
                    (ruleOwnerUserId || "nobody") +
                    " may not file into team " +
                    partyId
            )
            continue
        }
        return team
    }
    return null
}
// The source identity of a mail message: its Message-ID, so the same mail delivered to two addresses or accounts is one intake;
// the row's id when it has none.
function emailIdentity(message) {
    const messageId = lower(String(message.messageId || "").replace(/^<|>$/g, ""))
    return messageId ? ("mid:" + messageId).substring(0, 255) : "id:" + message.emailMessageId
}
const subjectName = subject =>
    String(subject || "")
        .replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, "")
        .trim()
        .substring(0, 255) || null
function leadFromEmail(p) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const emailMessageId = text(p.emailMessageId)
        const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
        if (!message) denied("RECORD_UNAVAILABLE", "Email message " + (emailMessageId || "") + " is not available")
        const team = intakeTeam(message, p.value, p.ruleOwnerUserId)
        if (!team) denied("TEAM_UNAVAILABLE", "No sales team takes mail at the addresses of message " + emailMessageId)
        const defaultSource = rows("mantle.party.PartySetting", {partyId: team.teamPartyId, partySettingTypeId: sourceSetting})[0]
        const offered = defaultSource?.settingValue
            ? settings.sourcesOffered(team.organizationPartyId).some(row => row.dataSourceId === defaultSource.settingValue)
            : false
        const answer = storeLeadIntake({
            organizationPartyId: team.organizationPartyId,
            sourceKind: "emailMessage",
            sourceId: emailIdentity(message),
            submittedName: message.fromName || null,
            submittedEmail: message.fromAddress || null,
            opportunityName: subjectName(message.subject),
            description: (message.bodyText || plainText(message.body)).substring(0, 20000) || null,
            defaultDataSourceId: offered ? defaultSource.settingValue : null,
            teamPartyId: team.teamPartyId
        })
        // the message on the lead's history, as the evidence of the intake (its files stay on the message)
        if (!answer.alreadyApplied) {
            // in an error frame of its own, so a failure to file leaves the lead made (P5 review R2)
            ec.message.pushErrors()
            try {
                const event = call("mantle.party.CommunicationServices.create#EmailCommunicationEvent", {emailMessageId})
                if (event.communicationEventId)
                    call("mantle.party.CommunicationServices.link#CommunicationEventRecord", {
                        communicationEventId: event.communicationEventId,
                        recordEntityName: OPPORTUNITY,
                        recordId: answer.salesOpportunityId,
                        checkRecord: false
                    })
            } catch (error) {
                ec.logger.error(
                    "Email " +
                        emailMessageId +
                        " made lead " +
                        answer.salesOpportunityId +
                        " but was not filed on it: " +
                        error.message
                )
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        return answer
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// ===== store#LeadSourceMapping, find#LeadSourceMappings =====
const mapRevision = row => String(ms(row.lastUpdatedStamp) ?? 0)
function configurer(organizationPartyId) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "configure")
    salesAccess.requireOrganization(userScope, text(organizationPartyId))
    return userScope
}
function storeLeadSourceMapping(p) {
    if (!blank(p.salesLeadSourceMapId)) {
        const row = one(SOURCE_MAP, {salesLeadSourceMapId: text(p.salesLeadSourceMapId)})
        let userScope = null
        try {
            userScope = row ? configurer(row.organizationPartyId) : null
        } catch (error) {
            if (lib.reasonCode(error) === "ORGANIZATION_DENIED") userScope = null
            else throw error
        }
        if (!row || !userScope) denied("RECORD_UNAVAILABLE", "Mapping " + p.salesLeadSourceMapId + " is not available")
        if (text(p.expectedRevision) !== mapRevision(row))
            denied(
                "REVISION_CHANGED",
                "This mapping changed since you read it; open it again (revision " + mapRevision(row) + ")"
            )
        if (!flag(p.end) && blank(p.thruDate)) denied("CHANGE_REQUIRED", "A mapping is ended, never changed; add a new one")
        const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : p.thruDate
        if (ms(thruDate) < nowMs() - 60000) denied("DATE_INVALID", "A mapping ends now or later")
        call("update#" + SOURCE_MAP, {salesLeadSourceMapId: row.salesLeadSourceMapId, thruDate})
        return {salesLeadSourceMapId: row.salesLeadSourceMapId}
    }
    const organizationPartyId = text(p.organizationPartyId)
    configurer(organizationPartyId)
    const utmSource = lower(p.utmSource)
    if (!utmSource || utmSource.length > 60) denied("UTM_SOURCE_REQUIRED", "Give the UTM source, at most 60 characters")
    const utmMedium = lower(p.utmMedium)
    if (utmMedium && utmMedium.length > 60) denied("UTM_MEDIUM_INVALID", "A UTM medium has at most 60 characters")
    const dataSourceId = text(p.dataSourceId)
    if (!dataSourceId || !settings.sourcesOffered(organizationPartyId).some(row => row.dataSourceId === dataSourceId))
        denied("SOURCE_INVALID", "Choose a lead source offered to the organization")
    const fromDate = blank(p.fromDate) ? ec.user.nowTimestamp : p.fromDate
    if (ms(fromDate) < nowMs() - 60000) denied("DATE_INVALID", "A mapping starts now or later")
    const clash = rows(SOURCE_MAP, {organizationPartyId, utmSource}).find(
        row => (row.utmMedium || null) === utmMedium && !settings.ended(row)
    )
    if (clash) denied("MAPPING_EXISTS", "This source and medium are mapped already; end that mapping first")
    const made = call("create#" + SOURCE_MAP, {organizationPartyId, utmSource, utmMedium, dataSourceId, fromDate})
    return {salesLeadSourceMapId: made.salesLeadSourceMapId}
}
function findLeadSourceMappings(p) {
    const organizationPartyId = text(p.organizationPartyId)
    configurer(organizationPartyId)
    const found = rows(SOURCE_MAP, {organizationPartyId}).filter(row => flag(p.includeEnded) || !settings.ended(row))
    const ids = Array.from(new Set(found.map(row => row.dataSourceId).filter(Boolean)))
    const names = ids.length
        ? Object.fromEntries(
              Array.from(find("moqui.basic.DataSource").condition("dataSourceId", "in", ids).list()).map(row => [
                  row.dataSourceId,
                  row.description || row.dataSourceId
              ])
          )
        : {}
    const mappingList = found
        .sort(
            (a, b) =>
                String(a.utmSource).localeCompare(String(b.utmSource)) ||
                String(a.utmMedium || "").localeCompare(String(b.utmMedium || ""))
        )
        .map(row => ({
            salesLeadSourceMapId: row.salesLeadSourceMapId,
            utmSource: row.utmSource,
            utmMedium: row.utmMedium || "",
            mediumText: row.utmMedium || L("Any medium"),
            dataSourceId: row.dataSourceId,
            sourceText: names[row.dataSourceId] || row.dataSourceId,
            fromText: dayText(row.fromDate),
            thruText: dayText(row.thruDate),
            ended: settings.ended(row),
            revision: mapRevision(row)
        }))
    return {mappingList}
}

// ===== store#TeamIntake, find#TeamIntakes: a team's intake address =====
// A team's plus tag (sales+<tag>@...: the createLead rule files mail to it into the team's queue) and its default lead source, as
// PartySettings of the team. A tag is one team's (TAG_TAKEN), letters, digits, dot, dash and underscore (TAG_INVALID); the source
// one offered to the team's organization (SOURCE_INVALID); empty clears either. Needs SALES_CONFIGURE and the team's organization
// in the scope (RECORD_UNAVAILABLE otherwise).
function settingOf(teamPartyId, partySettingTypeId) {
    return rows("mantle.party.PartySetting", {partyId: teamPartyId, partySettingTypeId})[0]?.settingValue || null
}
function putSetting(teamPartyId, partySettingTypeId, value) {
    const old = one("mantle.party.PartySetting", {partyId: teamPartyId, partySettingTypeId})
    if (old && !value) call("delete#mantle.party.PartySetting", {partyId: teamPartyId, partySettingTypeId})
    else if (old) call("update#mantle.party.PartySetting", {partyId: teamPartyId, partySettingTypeId, settingValue: value})
    else if (value) call("create#mantle.party.PartySetting", {partyId: teamPartyId, partySettingTypeId, settingValue: value})
}
function storeTeamIntake(p) {
    const team = settings.teamRow(text(p.teamPartyId))
    let userScope = null
    try {
        userScope = team ? configurer(team.organizationPartyId) : null
    } catch (error) {
        if (lib.reasonCode(error) === "ORGANIZATION_DENIED") userScope = null
        else throw error
    }
    if (!team || !userScope) denied("RECORD_UNAVAILABLE", "Team " + (p.teamPartyId || "") + " is not available")
    const tag = lower(p.intakePlusTag)
    if (tag && !/^[a-z0-9._-]{1,40}$/.test(tag)) denied("TAG_INVALID", "A tag is letters, digits, dots, dashes or underscores")
    if (
        tag &&
        rows("mantle.party.PartySetting", {partySettingTypeId: plusTagSetting}).some(
            row => lower(row.settingValue) === tag && row.partyId !== team.teamPartyId
        )
    )
        denied("TAG_TAKEN", "Another team takes mail with " + tag)
    const dataSourceId = text(p.intakeDataSourceId)
    if (dataSourceId && !settings.sourcesOffered(team.organizationPartyId).some(row => row.dataSourceId === dataSourceId))
        denied("SOURCE_INVALID", "Choose a lead source offered to the team's organization")
    putSetting(team.teamPartyId, plusTagSetting, tag)
    putSetting(team.teamPartyId, sourceSetting, dataSourceId)
    return {teamPartyId: team.teamPartyId}
}
function findTeamIntakes(p) {
    const organizationPartyId = text(p.organizationPartyId)
    configurer(organizationPartyId)
    const sources = Object.fromEntries(
        settings.sourcesOffered(organizationPartyId).map(row => [row.dataSourceId, row.description])
    )
    return {
        teamList: settings.teamsOf(organizationPartyId).map(team => {
            const tag = settingOf(team.teamPartyId, plusTagSetting)
            const dataSourceId = settingOf(team.teamPartyId, sourceSetting)
            return {
                teamPartyId: team.teamPartyId,
                teamName: team.teamName,
                intakePlusTag: tag || "",
                addressText: tag ? "sales+" + tag + "@…" : "",
                intakeDataSourceId: dataSourceId || "",
                sourceText: dataSourceId ? sources[dataSourceId] || dataSourceId : ""
            }
        })
    }
}

// ===== purge#LeadIntakes =====
// The submitted name, organization, email and phone of each unverified intake received before the retention days whose lead never
// qualified (no conversion), blanked with its purgedDate; the intake row, its source identity and key stay so a retry still answers
// one lead. A user needs SALES_CONFIGURE and purges the organizations of their scope; the job (no user) every organization. Each
// intake on its own: one that fails is logged and the rest go on.
function purgeLeadIntakes(p) {
    let organizationPartyIds = null
    if (!isSystem()) {
        const userScope = salesAccess.scope()
        salesAccess.requireCapability(userScope, "configure")
        organizationPartyIds = userScope.organizationPartyIds
    }
    const days = Number(p.retentionDays || defaultRetentionDays)
    if (!Number.isFinite(days) || days < 1) denied("RETENTION_INVALID", "The retention is at least one day")
    const before = new Date(nowMs() - days * 24 * 60 * 60 * 1000)
    let query = find(INTAKE)
        .condition("purgedDate", null)
        .condition("verifiedDate", null)
        .condition("receivedDate", "less", before)
        .orderBy("receivedDate")
        .limit(5000)
    if (organizationPartyIds != null) {
        if (!organizationPartyIds.length) return {purgedCount: 0, keptCount: 0}
        query = query.condition("organizationPartyId", "in", organizationPartyIds)
    }
    let purgedCount = 0
    let keptCount = 0
    for (const intake of Array.from(query.list())) {
        try {
            const lead = intake.salesOpportunityId ? one(OPPORTUNITY, {salesOpportunityId: intake.salesOpportunityId}) : null
            if (lead && (lead.convertedDate || lead.typeEnumId !== "SotLead")) {
                keptCount++
                continue
            }
            // in a transaction and error frame of its own (P5 review R2), so one row's failure is that row's alone
            lib.probe("update#" + INTAKE, {
                salesLeadIntakeId: intake.salesLeadIntakeId,
                submittedName: null,
                submittedOrganization: null,
                submittedEmail: null,
                submittedPhone: null,
                purgedDate: ec.user.nowTimestamp
            })
            purgedCount++
        } catch (error) {
            ec.logger.error("Lead intake " + intake.salesLeadIntakeId + " was not purged: " + error.message)
        }
    }
    return {purgedCount, keptCount}
}

// ===== reads for the opportunity services =====
const kindTexts = () =>
    Object.fromEntries(
        rows("moqui.basic.Enumeration", {enumTypeId: "SalesLeadIntakeSource"}).map(row => [row.enumId, row.description])
    )
// The first intake of each deal of a page: {kindText, receivedText, verified}, for LeadList's intake columns.
function summaries(salesOpportunityIds) {
    const out = {}
    if (!salesOpportunityIds.length) return out
    const kinds = kindTexts()
    for (const row of Array.from(
        find(INTAKE).condition("salesOpportunityId", "in", salesOpportunityIds).orderBy("receivedDate").list()
    )) {
        const entry = out[row.salesOpportunityId]
        if (entry) {
            entry.count++
            continue
        }
        out[row.salesOpportunityId] = {
            kindText: kinds[row.sourceKindEnumId] || "",
            receivedText: dayText(row.receivedDate),
            verified: !!row.verifiedDate,
            count: 1
        }
    }
    return out
}
// A deal's intakes for OpportunityDetail (a reader of the deal): what was submitted (blank once purged), how it came, its UTM
// pair, campaign and tracking code, verified or not, and whether it joined the lead as a duplicate.
function details(salesOpportunityId) {
    const kinds = kindTexts()
    return rows(INTAKE, {salesOpportunityId})
        .sort((a, b) => (ms(a.receivedDate) ?? 0) - (ms(b.receivedDate) ?? 0))
        .map(row => ({
            salesLeadIntakeId: row.salesLeadIntakeId,
            kindText: kinds[row.sourceKindEnumId] || "",
            receivedText: dayText(row.receivedDate),
            submittedName: row.submittedName || "",
            submittedOrganization: row.submittedOrganization || "",
            submittedEmail: row.submittedEmail || "",
            submittedPhone: row.submittedPhone || "",
            utmText: [row.utmSource, row.utmMedium].filter(Boolean).join(" / "),
            verified: !!row.verifiedDate,
            duplicate: row.outcomeEnumId === outcomes.duplicate,
            purged: !!row.purgedDate,
            purgedText: dayText(row.purgedDate)
        }))
}

// ===== log#OpportunityCall: a call logged on a deal (the Comms call and voicemail actions) =====
// A Phone communication event of the caller (in from, or out to, the deal's contact named, which must be one of its current contact
// rows, else no party), when it was (not ahead), how long and what it was about, filed on the deal (its Conversation). Needs
// SALES_OPPORTUNITY_EDIT on a deal the caller sees (RECORD_UNAVAILABLE otherwise); the deal's revision is not needed, as a call
// changes none of its fields.
const escapeHtml = value =>
    String(value).replace(
        /[&<>"']/g,
        character => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[character]
    )
function logOpportunityCall(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to log a call")
    const userScope = salesAccess.scope()
    const {opportunity} = salesAccess.requireOpportunity(userScope, text(p.salesOpportunityId), true)
    const summary = text(p.summary)
    if (!summary) denied("SUMMARY_REQUIRED", "Say what the call was about")
    const direction = p.direction === "in" ? "in" : p.direction === "out" || blank(p.direction) ? "out" : null
    if (!direction) denied("DIRECTION_INVALID", "A call is in or out")
    const contactPartyId = text(p.contactPartyId)
    if (
        contactPartyId &&
        !rows(OPPORTUNITY_PARTY, {
            salesOpportunityId: opportunity.salesOpportunityId,
            partyId: contactPartyId,
            roleTypeId: roles.contact
        }).some(row => settings.inEffect(row))
    )
        denied("CONTACT_UNAVAILABLE", "Choose one of the deal's contacts")
    const startMs = blank(p.occurredDate) ? nowMs() : ms(p.occurredDate)
    if (startMs == null || startMs > nowMs() + 60000) denied("DATE_INVALID", "A call is logged after it happened")
    const minutes = blank(p.durationMinutes) ? 0 : Number(p.durationMinutes)
    if (!(minutes >= 0 && minutes <= 24 * 60)) denied("DURATION_INVALID", "A call lasts 0 to 1440 minutes")
    const out = direction === "out"
    const communicationEventId = call("create#mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: "Phone",
        contactMechTypeEnumId: "CmtTelecomNumber",
        statusId: out ? "CeSent" : "CeReceived",
        fromPartyId: out ? userScope.partyId : contactPartyId,
        toPartyId: out ? contactPartyId : userScope.partyId,
        entryDate: ec.user.nowTimestamp,
        datetimeStarted: new Date(startMs),
        datetimeEnded: new Date(startMs + Math.round(minutes * 60000)),
        subject: (
            L(out ? "Call about" : "Call in about") +
            " " +
            (opportunity.opportunityName || opportunity.salesOpportunityId)
        ).substring(0, 255),
        contentType: "text/html",
        body: "<p>" + escapeHtml(summary).replace(/\n/g, "<br>") + "</p>"
    }).communicationEventId
    call("mantle.party.CommunicationServices.link#CommunicationEventRecord", {
        communicationEventId,
        recordEntityName: OPPORTUNITY,
        recordId: opportunity.salesOpportunityId,
        checkRecord: false
    })
    return {communicationEventId}
}

// ===== My accounts: the projected address book (SalesWorkspaceServices get#AccountContactProjection) =====
// Admits a Sales reader; the parties are the current contacts (PrtContact) of the accounts the user may see that they manage
// (PrtAccountManager) or that are the account of a deal assigned now to them or a team of theirs, each a person the user may see,
// computed per request, at most projectionLimit. A user who reads nothing of Sales is not admitted.
function accountContactProjection(p) {
    if (!ec.user.userId) return {admitted: false, partyIdList: []}
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.anyRead || !userScope.partyId) return {admitted: false, partyIdList: []}
    if (flag(p.checkOnly)) return {admitted: true, partyIdList: []}
    const accountIds = new Set()
    for (const row of Array.from(
        find("mantle.party.PartyRelationship", {fromPartyId: userScope.partyId, relationshipTypeEnumId: "PrtAccountManager"})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("toPartyId")
            .list()
    ))
        accountIds.add(row.toPartyId)
    const assigned = Array.from(
        find(OPPORTUNITY_PARTY)
            .condition("partyId", "in", salesAccess.assignmentParties(userScope))
            .condition("roleTypeId", "in", [roles.owner, roles.team])
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("salesOpportunityId")
            .limit(projectionLimit)
            .list()
    ).map(row => row.salesOpportunityId)
    if (assigned.length)
        for (const row of Array.from(
            find(OPPORTUNITY)
                .condition("salesOpportunityId", "in", Array.from(new Set(assigned)))
                .condition("accountPartyId", "is-not-null", null)
                .selectField("accountPartyId")
                .selectField("organizationPartyId")
                .list()
        ))
            // only a deal of an organization of the scope (P5 review R3): a deal left assigned in an organization the user no
            // longer sells for brings no account, a shared one included
            if (salesAccess.covers(userScope, row.organizationPartyId)) accountIds.add(row.accountPartyId)
    const visibleAccounts = Array.from(accountIds).filter(partyId => salesAccess.accountOf(userScope, partyId))
    if (!visibleAccounts.length) return {admitted: true, partyIdList: []}
    const contacts = new Set()
    for (const row of Array.from(
        find("mantle.party.PartyRelationship")
            .condition("toPartyId", "in", visibleAccounts)
            .condition("relationshipTypeEnumId", "PrtContact")
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("fromPartyId")
            .limit(projectionLimit)
            .list()
    ))
        contacts.add(row.fromPartyId)
    return {
        admitted: true,
        partyIdList: Array.from(contacts)
            .filter(partyId => salesAccess.visibleParty(userScope, partyId))
            .slice(0, projectionLimit)
    }
}

const operations = {
    storeLeadIntake,
    leadFromEmail,
    storeLeadSourceMapping,
    findLeadSourceMappings,
    storeTeamIntake,
    findTeamIntakes,
    purgeLeadIntakes,
    logOpportunityCall,
    accountContactProjection
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales intake operation " + op)
        return operations[op](parameters || {})
    },
    // for SalesOpportunities.js's reads, never a service's parameters
    summaries,
    details,
    sourceKinds,
    // for BOSS's Comms action on a mail message: the same source identity the mail rule writes
    emailIdentity
})
