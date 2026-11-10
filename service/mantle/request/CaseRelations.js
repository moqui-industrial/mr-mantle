// Merge, split and closing of support cases (design-customer-service §3 MergeCases, SplitCase, CaseDetail's lineage, §9
// StatusCategories, ServiceDefaults; impl-customer-service P8, CS-MERGE, CS-JOBS; SupportRelationEntities.xml). A case relation
// is lineage: a merge (sources into the case kept), a split (a new case from some of a case's evidence) or a follow-up (a new
// case for a reply that cannot reopen the case), with its items (the messages, files, records, work and clocks it referenced
// or carried, each with its audience).
// - A merge (SUPPORT_CASE_MANAGE) takes cases of one organization and one customer, none closed, cancelled or merged, the case
//   kept open; every case is locked (in id order), a stale revision is refused naming the current one, and an operation key
//   answers a retry with the first result. The kept case's own clocks are untouched; each open clock of a source is carried
//   as an obligation (Sla.js carryOnMerge), a source's breach kept; the source's messages are referenced on the kept case
//   (the same CommunicationEvent, its audience and time unchanged), its records and work linked to it too, its files listed;
//   the source becomes non-actionable (cancelled as a duplicate when open, closed) and its changes are refused naming the
//   kept case (SupportCases.js CASE_MERGED); a reply to it goes to the kept case.
// - A split (SUPPORT_CASE_EDIT) makes a new case of the source's customer from the messages, records, work and files chosen
//   (referenced, never copied across audiences), its clock from the earliest chosen message's receipt, or from a manager's
//   start with its reason, assigned by the queue's rules unless an assignee is given, with no template values unless given;
//   the source stays open.
// - A reply from the customer side to a resolved case within the reopen window (ServicePolicy.reopenWindowDays, 14) reopens
//   it (the status rule starts the new resolution episode, P4); after the window, once auto-close set the closed date, or to
//   a cancelled case, it makes a follow-up case linked by the relation, or joins the open follow-up it already has.
// - Auto-close (close#ResolvedCases, the close_ResolvedCases ServiceJob) sets CaseProfile.closedDate on a case resolved longer
//   than its organization's autoCloseDays, keeping ReqCompleted; bounded batches, each case in its own transaction, a failing
//   one named and the rest going on; a rerun changes nothing.
// Refusals carry reason codes (EntityLib.denied). Nothing here acts on a request that is not a case.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
const requestContent = ec.resource.script("component://mr-mantle/service/mantle/request/RequestContent.js")
const {find, one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    PROFILE = "mantle.request.support.CaseProfile",
    POLICY = "mantle.request.support.ServicePolicy",
    TRANSITION = "mantle.request.support.CaseTransition",
    EPISODE = "mantle.request.support.CaseSlaEpisode",
    RELATION = "mantle.request.support.CaseRelation",
    ITEM = "mantle.request.support.CaseRelationItem",
    CASE_ORG = "mantle.request.support.CaseRequestOrganization",
    COMM = "mantle.party.communication.CommunicationEvent",
    COMM_LINK = "mantle.request.RequestCommEvent",
    RECORD = "mantle.request.RequestRecord",
    WORK = "mantle.request.RequestWorkEffort",
    CONTENT = "mantle.request.RequestContent",
    MAIL = "moqui.basic.email.EmailMessage"
const R = "mantle.request.RequestServices."
const dayMs = 86400000
const maxSources = 10
const internalTypes = ["Comment", "Message", "StatusUpdate"]
const runningStates = ["SlsRunning", "SlsPaused"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const now = () => ec.user.nowTimestamp
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const msOf = value => (value == null || value === "" ? null : Number(ms(value)))
const L = words => ec.l10n.localize(words)
const dateText = value => (value == null ? "" : ec.l10n.format(new Date(msOf(value)), "d MMM yyyy HH:mm"))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const first = (entity, conditions, order) => {
    let query = find(entity, conditions)
    if (order) query = query.orderBy(order)
    return Array.from(query.limit(1).list())[0] || null
}
const sla = () => ec.resource.script("component://mr-mantle/service/mantle/request/Sla.js")
const templates = () => ec.resource.script("component://mr-mantle/service/mantle/request/CaseTemplates.js")

// ===== lineage =====
// The case a case was merged into (the direct relation), and the case its merges end in (a merge of a merged case's kept case).
const mergeOf = requestId => first(RELATION, {fromRequestId: requestId, relationTypeEnumId: "CrtMerge"})
function mergedInto(requestId) {
    let current = requestId
    for (let step = 0; step < 10; step++) {
        const merge = mergeOf(current)
        if (!merge) break
        current = merge.toRequestId
    }
    return current === requestId ? null : current
}
// The open follow-up a closed or cancelled case already has (its latest), so a second reply joins it.
function openFollowUp(requestId) {
    for (const relation of Array.from(
        find(RELATION, {fromRequestId: requestId, relationTypeEnumId: "CrtFollowUp"}).orderBy("-relationDate").list()
    )) {
        const request = one(REQUEST, {requestId: relation.toRequestId})
        if (request && cases.openStatuses.includes(request.statusId) && !mergedInto(relation.toRequestId))
            return relation.toRequestId
    }
    return null
}
// The last time a case moved into one of the statuses (its status audit log), else its last update.
function finishedAt(request, statusIds) {
    const latest = Array.from(
        find("moqui.entity.EntityAuditLog", {
            changedEntityName: REQUEST,
            changedFieldName: "statusId",
            pkPrimaryValue: request.requestId
        })
            .condition("newValueText", "in", statusIds)
            .orderBy("-changedDate")
            .limit(1)
            .list()
    )[0]
    return msOf(latest?.changedDate) ?? msOf(request.lastUpdatedStamp) ?? 0
}
// Where a case stands for a reply: resolved (Completed, or a status its workflow maps to Resolved or Closed), cancelled, its
// close date, when it got there, and whether a reply at a time still reopens it (resolved, not closed, within the reopen
// window of the policy it was opened under, else of the organization's current one).
function finishState(request, profile, organizationPartyId) {
    const category = sla().mappingCategory(profile.caseWorkflowId, request.statusId)
    const resolved = request.statusId === "ReqCompleted" || category === "CscResolved" || category === "CscClosed"
    const cancelled = request.statusId === "ReqCancelled" || category === "CscCancelled"
    const policy = one(POLICY, {servicePolicyId: profile.servicePolicyId}) || cases.policyOf(organizationPartyId)
    const windowDays = policy?.reopenWindowDays ?? 14
    const finishedMs = resolved || cancelled ? finishedAt(request, [request.statusId]) : null
    return {
        resolved,
        cancelled,
        closed: !!profile.closedDate,
        finishedMs,
        windowDays,
        reopenable: atMs => resolved && !profile.closedDate && atMs - finishedMs <= windowDays * dayMs
    }
}
// Whether a party is the case's customer side: its customer, its reporter, or a contact of its customer; never staff.
function customerSide(partyId, parties) {
    if (!partyId || cases.isInternal(partyId) || cases.organizationsOf(partyId).length) return false
    const customerPartyId = cases.roleParty(parties, "Customer")
    if (partyId === customerPartyId || partyId === cases.roleParty(parties, "Reporter")) return true
    return !!customerPartyId && cases.customerSidesOf(partyId).includes(customerPartyId)
}

// ===== items and audiences =====
function messageAudience(event) {
    if (!event || internalTypes.includes(event.communicationEventTypeId)) return "CfaInternal"
    const internal = one("mantle.party.communication.CommunicationEventPurpose", {
        communicationEventId: event.communicationEventId,
        purposeEnumId: "CpServiceInternal"
    })
    return internal ? "CfaInternal" : "CfaCustomer"
}
const fileAudience = row => (requestContent.customerVisibleContentType(row.contentTypeEnumId) ? "CfaCustomer" : "CfaInternal")
// The receipt of a message: its mail's received date, else when it happened, else when it was entered.
function receiptOf(event) {
    const mail = event?.emailMessageId ? one(MAIL, {emailMessageId: event.emailMessageId}) : null
    return msOf(mail?.receivedDate) ?? msOf(event?.datetimeStarted) ?? msOf(event?.entryDate) ?? null
}
// A relation's items, written in order; an item is written before the link it explains, so the rules on the other case see a
// referenced message as the source's (no new reply or response).
function itemWriter(caseRelationId, toRequestId) {
    let seq = 0
    return fields => {
        seq++
        call("create#" + ITEM, Object.assign({caseRelationId, itemSeqId: String(seq).padStart(3, "0"), toRequestId}, fields))
    }
}
function linkMessage(requestId, communicationEventId) {
    if (!one(COMM_LINK, {requestId, communicationEventId})) call("create#" + COMM_LINK, {requestId, communicationEventId})
}
function linkRecord(requestId, recordEntityName, recordId) {
    if (!one(RECORD, {requestId, recordEntityName, recordId}))
        call(R + "link#RequestRecord", {requestId, recordEntityName, recordId})
}
function linkWork(requestId, workEffortId) {
    if (!one(WORK, {requestId, workEffortId})) call("create#" + WORK, {requestId, workEffortId})
}
// The new case's contact (Reporter), unless it is already (create#Request makes the filer one)
function setReporter(requestId, partyId) {
    if (!partyId || cases.roleParty(cases.partiesOf(requestId), "Reporter") === partyId) return
    call(R + "replace#RequestParty", {requestId, roleTypeId: "Reporter", newPartyId: partyId})
}
const comment = (requestId, body) => call(R + "add#RequestComment", {requestId, body, contentType: "text/plain"})
// The case revisions a merge was previewed at: a map, or text "id:revision,id:revision".
function revisionMap(value) {
    if (value == null || value === "") return {}
    if (typeof value === "string")
        return Object.fromEntries(
            value
                .split(",")
                .map(pair => pair.trim().split(":"))
                .filter(pair => pair.length === 2 && pair[0] && pair[1])
        )
    return Object.assign({}, value)
}

// ===== a case for a merge or split preview =====
function summaryOf(theCase) {
    const requestId = theCase.requestId
    const request = theCase.request
    const messages = rows(COMM_LINK, {requestId}).map(link => one(COMM, {communicationEventId: link.communicationEventId}))
    const customerMessages = messages.filter(event => messageAudience(event) === "CfaCustomer").length
    const files = rows(CONTENT, {requestId})
    const clocks = rows(EPISODE, {requestId})
    const records = rows(RECORD, {requestId}).map(link => ({
        recordEntityName: link.recordEntityName,
        recordId: link.recordId,
        recordText: link.recordEntityName.split(".").pop() + " " + link.recordId
    }))
    const parties = theCase.parties
    return {
        requestId,
        requestName: request.requestName || requestId,
        statusId: request.statusId,
        statusText: statusText(request.statusId),
        customerPartyId: theCase.customerPartyId,
        customerName: cases.partyName(theCase.customerPartyId),
        organizationPartyId: theCase.organizationPartyId,
        queueName: request.requestCategoryId
            ? one("mantle.request.RequestCategory", {requestCategoryId: request.requestCategoryId})?.description ||
              request.requestCategoryId
            : "",
        assigneeName: cases.partyName(theCase.assigneePartyId),
        participantNames: Array.from(new Set(parties.map(row => cases.partyName(row.partyId)).filter(Boolean))).join(", "),
        receivedText: dateText(theCase.profile.intakeDate),
        messageCount: messages.length,
        customerMessageCount: customerMessages,
        internalMessageCount: messages.length - customerMessages,
        fileCount: files.length,
        workCount: rows(WORK, {requestId}).length,
        records,
        recordText: records.map(record => record.recordText).join(", "),
        openClockCount: clocks.filter(row => runningStates.includes(row.stateEnumId)).length,
        breachedClockCount: clocks.filter(row => !!row.breachedDate).length,
        caseRevision: theCase.revision
    }
}

// ===== merge =====
// The cases of a merge, each one of the user's organizations' (RECORD_UNAVAILABLE), locked in id order for the merge itself.
function mergeSet(p, lock) {
    const targetRequestId = text(p.targetRequestId)
    const sourceIds = Array.from(new Set(cases.listOf(p.sourceRequestIds)))
    if (!targetRequestId) denied("TARGET_REQUIRED", "Choose the case to keep")
    if (!sourceIds.length) denied("SOURCE_REQUIRED", "Choose a case to merge into case " + targetRequestId)
    if (sourceIds.length > maxSources) denied("TOO_MANY_CASES", "Merge at most " + maxSources + " cases at a time")
    if (sourceIds.includes(targetRequestId)) denied("SAME_CASE", "Case " + targetRequestId + " cannot be merged into itself")
    const byId = new Map()
    for (const requestId of [targetRequestId].concat(sourceIds).sort()) byId.set(requestId, cases.caseOf(requestId, lock))
    return {target: byId.get(targetRequestId), sources: sourceIds.map(requestId => byId.get(requestId))}
}
// What stops a merge, each naming its case: a closed, cancelled or merged case, a kept case that is not open, another
// organization's or another customer's case (cross-customer duplicates are only linked, never merged).
function mergeProblems(target, sources) {
    const problems = []
    const add = (code, requestId, message) => problems.push({code, requestId, message: L(message)})
    for (const theCase of [target].concat(sources)) {
        const merged = mergeOf(theCase.requestId)
        if (merged)
            add("CASE_MERGED", theCase.requestId, "Case " + theCase.requestId + " was merged into case " + merged.toRequestId)
        else if (theCase.profile.closedDate || theCase.request.statusId === "ReqCancelled")
            add("CASE_CLOSED", theCase.requestId, "Case " + theCase.requestId + " is closed")
    }
    if (!mergeOf(target.requestId) && !cases.openStatuses.includes(target.request.statusId) && !target.profile.closedDate)
        add(
            "TARGET_NOT_OPEN",
            target.requestId,
            "Case " + target.requestId + " is resolved: reopen it to keep it, or keep another"
        )
    for (const source of sources) {
        if (source.organizationPartyId !== target.organizationPartyId)
            add("ORGANIZATION_MISMATCH", source.requestId, "Case " + source.requestId + " is another organization's")
        else if (source.customerPartyId !== target.customerPartyId)
            add(
                "CUSTOMER_MISMATCH",
                source.requestId,
                "Case " + source.requestId + " is another customer's: link it as related instead of merging it"
            )
    }
    return problems
}
// What the merge carries from a source: its open clocks as obligations and its breaches.
function carriedOf(source) {
    return rows(EPISODE, {requestId: source.requestId})
        .filter(row => runningStates.includes(row.stateEnumId) || !!row.breachedDate)
        .map(row => ({
            requestId: source.requestId,
            clockText:
                enumText(row.clockEnumId) +
                (row.clockEnumId === "SlcResolution" && Number(row.sequenceNum) > 1 ? " " + row.sequenceNum : ""),
            stateText: enumText(row.stateEnumId),
            dueText: dateText(row.dueDate),
            breachedText: dateText(row.breachedDate),
            carriedText: runningStates.includes(row.stateEnumId)
                ? L("An obligation on the kept case, due as it was")
                : L("Its breach stays on the record")
        }))
}
function previewMerge(p) {
    cases.requirePermission("SUPPORT_CASE_MANAGE")
    const {target, sources} = mergeSet(p, false)
    const problems = mergeProblems(target, sources)
    return {
        preview: {
            target: summaryOf(target),
            sources: sources.map(summaryOf),
            carried: sources.flatMap(carriedOf),
            problems,
            canMerge: problems.length === 0,
            caseRevisions: [target]
                .concat(sources)
                .map(theCase => theCase.requestId + ":" + theCase.revision)
                .join(",")
        }
    }
}
// One source into the kept case: its relation and items, its messages referenced and records and work linked, its clocks
// carried, and the source no longer worked.
function mergeOne(source, target, reason, operationKey) {
    const at = now()
    const caseRelationId = call("create#" + RELATION, {
        fromRequestId: source.requestId,
        toRequestId: target.requestId,
        relationTypeEnumId: "CrtMerge",
        organizationPartyId: target.organizationPartyId,
        userId: ec.user.userId || null,
        relationDate: at,
        reason,
        operationKey,
        fromRevision: String(source.revision)
    }).caseRelationId
    const item = itemWriter(caseRelationId, target.requestId)
    for (const link of rows(COMM_LINK, {requestId: source.requestId})) {
        const event = one(COMM, {communicationEventId: link.communicationEventId})
        if (one(COMM_LINK, {requestId: target.requestId, communicationEventId: link.communicationEventId})) continue
        item({
            itemTypeEnumId: "CriMessage",
            communicationEventId: link.communicationEventId,
            emailMessageId: event?.emailMessageId || null,
            audienceEnumId: messageAudience(event)
        })
        linkMessage(target.requestId, link.communicationEventId)
    }
    for (const row of rows(CONTENT, {requestId: source.requestId}))
        item({itemTypeEnumId: "CriFile", requestContentId: row.requestContentId, audienceEnumId: fileAudience(row)})
    for (const link of rows(RECORD, {requestId: source.requestId})) {
        if (link.recordEntityName === REQUEST && [source.requestId, target.requestId].includes(link.recordId)) continue
        item({
            itemTypeEnumId: "CriRecord",
            recordEntityName: link.recordEntityName,
            recordId: link.recordId,
            audienceEnumId: "CfaInternal"
        })
        linkRecord(target.requestId, link.recordEntityName, link.recordId)
    }
    for (const link of rows(WORK, {requestId: source.requestId})) {
        item({itemTypeEnumId: "CriWork", workEffortId: link.workEffortId, audienceEnumId: "CfaInternal"})
        linkWork(target.requestId, link.workEffortId)
    }
    for (const clock of sla().carryOnMerge(source.requestId, target.requestId, caseRelationId))
        item({
            itemTypeEnumId: "CriClock",
            caseSlaEpisodeId: clock.caseSlaEpisodeId,
            carriedEpisodeId: clock.carriedEpisodeId,
            audienceEnumId: "CfaInternal"
        })
    // the source: cancelled as a duplicate when it was open (its clocks already ended Merged), and closed
    if (cases.openStatuses.includes(source.request.statusId))
        call("update#" + REQUEST, {requestId: source.requestId, statusId: "ReqCancelled", requestResolutionEnumId: "RrDuplicate"})
    call("update#" + PROFILE, {requestId: source.requestId, closedDate: at})
    comment(source.requestId, L("Merged into case") + " " + target.requestId + ": " + reason)
    return caseRelationId
}
function merge(p) {
    cases.requirePermission("SUPPORT_CASE_MANAGE")
    const {target, sources} = mergeSet(p, true)
    const operation = lib.operation(p, "CaseMerge", target.organizationPartyId, {
        targetRequestId: target.requestId,
        sourceRequestIds: sources.map(source => source.requestId).sort()
    })
    if (operation.old) return lib.previous(operation)
    const problems = mergeProblems(target, sources)
    if (problems.length) denied(problems[0].code, problems[0].message)
    const revisions = revisionMap(p.caseRevisions)
    for (const theCase of [target].concat(sources))
        if (!blank(revisions[theCase.requestId])) cases.checkRevision(theCase, revisions[theCase.requestId])
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the merge")
    const caseRelationIds = sources.map(source => mergeOne(source, target, reason, operation.operationKey))
    comment(
        target.requestId,
        L("Merged into this case") + ": " + sources.map(source => source.requestId).join(", ") + ". " + reason
    )
    const result = {
        targetRequestId: target.requestId,
        mergedRequestIds: sources.map(source => source.requestId),
        caseRelationIds
    }
    lib.complete(operation, RELATION, caseRelationIds[0], result)
    return result
}

// ===== split =====
// The evidence of the source a split may take: its messages, linked records, work and files, each with its audience and
// whether it is chosen; a chosen one not on the source is refused (EVIDENCE_UNAVAILABLE).
function splitEvidence(source, p) {
    const requestId = source.requestId
    const chosen = {
        messages: new Set(cases.listOf(p.communicationEventIds)),
        records: new Set(cases.listOf(p.recordKeys)),
        work: new Set(cases.listOf(p.workEffortIds)),
        files: new Set(cases.listOf(p.requestContentIds))
    }
    const messages = rows(COMM_LINK, {requestId})
        .map(link => one(COMM, {communicationEventId: link.communicationEventId}))
        .filter(Boolean)
        .map(event => {
            const audienceEnumId = messageAudience(event)
            return {
                communicationEventId: event.communicationEventId,
                emailMessageId: event.emailMessageId || null,
                typeText: enumText(event.communicationEventTypeId) || event.communicationEventTypeId || "",
                fromName: cases.partyName(event.fromPartyId),
                subject: event.subject || "",
                snippet: String(event.body || "")
                    .replace(/<[^>]*>/g, " ")
                    .replace(/\s+/g, " ")
                    .trim()
                    .substring(0, 140),
                receivedMs: receiptOf(event),
                receivedText: dateText(receiptOf(event)),
                audienceEnumId,
                audienceText: audienceEnumId === "CfaCustomer" ? L("Customer-visible") : L("Internal"),
                chosen: chosen.messages.has(event.communicationEventId)
            }
        })
        .sort((a, b) => (a.receivedMs ?? 0) - (b.receivedMs ?? 0))
    const records = rows(RECORD, {requestId})
        .filter(link => !(link.recordEntityName === REQUEST && link.recordId === requestId))
        .map(link => {
            const recordKey = link.recordEntityName + "|" + link.recordId
            return {
                recordKey,
                recordEntityName: link.recordEntityName,
                recordId: link.recordId,
                recordText: link.recordEntityName.split(".").pop() + " " + link.recordId,
                chosen: chosen.records.has(recordKey)
            }
        })
    const work = rows(WORK, {requestId}).map(link => ({
        workEffortId: link.workEffortId,
        workEffortName:
            one("mantle.work.effort.WorkEffort", {workEffortId: link.workEffortId})?.workEffortName || link.workEffortId,
        chosen: chosen.work.has(link.workEffortId)
    }))
    const files = rows(CONTENT, {requestId}).map(row => {
        const audienceEnumId = fileAudience(row)
        return {
            requestContentId: row.requestContentId,
            fileName:
                row.description ||
                String(row.contentLocation || "")
                    .split("/")
                    .pop() ||
                row.requestContentId,
            audienceEnumId,
            audienceText: audienceEnumId === "CfaCustomer" ? L("Customer-visible") : L("Internal"),
            chosen: chosen.files.has(row.requestContentId)
        }
    })
    const missing = (set, list, key) => Array.from(set).filter(id => !list.some(row => row[key] === id))
    const unavailable = missing(chosen.messages, messages, "communicationEventId")
        .concat(missing(chosen.records, records, "recordKey"))
        .concat(missing(chosen.work, work, "workEffortId"))
        .concat(missing(chosen.files, files, "requestContentId"))
    if (unavailable.length) denied("EVIDENCE_UNAVAILABLE", unavailable.join(", ") + " " + L("is not on case") + " " + requestId)
    return {messages, records, work, files}
}
// When the new case's clocks start: the earliest chosen message's receipt, else a manager's start (with its reason), else now.
function splitStart(evidence, p) {
    if (!blank(p.intakeDate)) {
        cases.requirePermission("SUPPORT_CASE_MANAGE")
        const reason = text(p.startReason)
        if (!reason) denied("START_REASON_REQUIRED", "Give the reason for the start you chose")
        const startMs = msOf(p.intakeDate)
        if (startMs == null || startMs > nowMs()) denied("DATE_INVALID", "The start is a time that has passed")
        return {startMs, reason, emailMessageId: null, communicationEventId: null, byManager: true}
    }
    const earliest = evidence.messages.filter(row => row.chosen && row.receivedMs != null)[0] || null
    return {
        startMs: earliest?.receivedMs ?? nowMs(),
        reason: null,
        emailMessageId: earliest?.emailMessageId || null,
        communicationEventId: earliest?.communicationEventId || null,
        byManager: false
    }
}
function splitSource(p, lock) {
    const source = cases.caseOf(p.requestId, lock)
    cases.refuseMerged(source)
    if (!cases.openStatuses.includes(source.request.statusId))
        denied("CASE_NOT_OPEN", "Case " + source.requestId + " is resolved or closed: a split comes from an open case")
    return source
}
function previewSplit(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const source = splitSource(p, false)
    const evidence = splitEvidence(source, p)
    const start = splitStart(evidence, Object.assign({}, p, {intakeDate: null}))
    return {
        preview: Object.assign({source: summaryOf(source)}, evidence, {
            startText: dateText(start.startMs),
            startFrom: start.communicationEventId ? "message" : "now",
            chosenCount:
                evidence.messages.filter(row => row.chosen).length +
                evidence.records.filter(row => row.chosen).length +
                evidence.work.filter(row => row.chosen).length +
                evidence.files.filter(row => row.chosen).length
        })
    }
}
function split(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const source = splitSource(p, true)
    const mine = !source.assigneePartyId || source.assigneePartyId === ec.user.userAccount?.partyId
    if (!mine && !access.has("SUPPORT_CASE_MANAGE"))
        denied("PERMISSION_DENIED", "Case " + source.requestId + " is another agent's: SUPPORT_CASE_MANAGE is required")
    const evidence = splitEvidence(source, p)
    const operation = lib.operation(p, "CaseSplit", source.organizationPartyId, {
        requestId: source.requestId,
        communicationEventIds: evidence.messages.filter(row => row.chosen).map(row => row.communicationEventId),
        requestName: text(p.requestName)
    })
    if (operation.old) return lib.previous(operation)
    cases.checkRevision(source, p.caseRevision)
    const organizationPartyId = source.organizationPartyId
    const name = text(p.requestName)
    if (!name) denied("NAME_REQUIRED", "The new case needs a subject")
    const requestTypeEnumId = text(p.requestTypeEnumId) || source.request.requestTypeEnumId || "RqtSupport"
    const requestCategoryId = text(p.requestCategoryId) || source.request.requestCategoryId
    const queue = cases.queueOf(requestCategoryId)
    if (!queue || queue.organizationPartyId !== organizationPartyId)
        denied("QUEUE_UNAVAILABLE", "Choose a service queue of " + cases.partyName(organizationPartyId))
    const offered = cases.listOf(queue.queue.offeredTypeEnumIds)
    if (offered.length && !offered.includes(requestTypeEnumId))
        denied("TYPE_NOT_OFFERED", "The queue " + (queue.category.description || requestCategoryId) + " does not take this type")
    const priority = blank(p.priority) ? Number(source.request.priority ?? 5) : Number(p.priority)
    if (!(priority >= 1 && priority <= 9)) denied("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
    const assigneePartyId = text(p.assigneePartyId)
    if (assigneePartyId) cases.checkAssignee(assigneePartyId, queue.queue, organizationPartyId)
    const start = splitStart(evidence, p)
    // a split's case has no template values unless they are given (P7)
    let templateFormId = null,
        templateValues = null
    const given = p.templateValues && Object.keys(Object.assign({}, p.templateValues)).length > 0
    if (given) {
        templateFormId = templates().forCase(organizationPartyId, requestCategoryId, p.templateFormId)
        if (templateFormId) {
            const checked = templates().checkValues(templateFormId, p.templateValues, "internal")
            if (!checked.valid) denied("TEMPLATE_VALUES_INVALID", checked.errors.map(error => error.message).join("; "))
            templateValues = checked.values
        }
    }
    const requestId = call(R + "create#Request", {
        requestName: name.substring(0, 255),
        description: p.description || null,
        requestTypeEnumId,
        requestCategoryId,
        priority,
        statusId: "ReqSubmitted",
        requestDate: stamp(start.startMs),
        salesChannelEnumId: source.request.salesChannelEnumId || null,
        customerPartyId: source.customerPartyId
    }).requestId
    setReporter(requestId, cases.roleParty(source.parties, "Reporter"))
    call("create#mantle.request.RequestParty", {
        requestId,
        partyId: organizationPartyId,
        roleTypeId: "OrgInternal",
        fromDate: now()
    })
    const made = cases.ensureCase({
        requestId,
        communicationEventId: start.communicationEventId,
        emailMessageId: start.emailMessageId,
        skipAssignment: !!assigneePartyId
    })
    if (!made.isCase) denied("NOT_A_CASE", "Request " + requestId + " is not a case: " + (made.reason || ""))
    const caseRelationId = call("create#" + RELATION, {
        fromRequestId: source.requestId,
        toRequestId: requestId,
        relationTypeEnumId: "CrtSplit",
        organizationPartyId,
        userId: ec.user.userId || null,
        relationDate: now(),
        reason: start.reason || text(p.reason),
        operationKey: operation.operationKey,
        fromRevision: String(source.revision)
    }).caseRelationId
    const item = itemWriter(caseRelationId, requestId)
    for (const row of evidence.messages.filter(row => row.chosen)) {
        item({
            itemTypeEnumId: "CriMessage",
            communicationEventId: row.communicationEventId,
            emailMessageId: row.emailMessageId,
            audienceEnumId: row.audienceEnumId
        })
        linkMessage(requestId, row.communicationEventId)
    }
    for (const row of evidence.records.filter(row => row.chosen)) {
        item({
            itemTypeEnumId: "CriRecord",
            recordEntityName: row.recordEntityName,
            recordId: row.recordId,
            audienceEnumId: "CfaInternal"
        })
        linkRecord(requestId, row.recordEntityName, row.recordId)
    }
    for (const row of evidence.work.filter(row => row.chosen)) {
        item({itemTypeEnumId: "CriWork", workEffortId: row.workEffortId, audienceEnumId: "CfaInternal"})
        linkWork(requestId, row.workEffortId)
    }
    for (const row of evidence.files.filter(row => row.chosen))
        item({itemTypeEnumId: "CriFile", requestContentId: row.requestContentId, audienceEnumId: row.audienceEnumId})
    if (assigneePartyId) cases.assignParty(cases.caseOf(requestId), assigneePartyId)
    if (templateFormId) templates().record(requestId, templateFormId, templateValues)
    comment(source.requestId, L("Split into case") + " " + requestId + ": " + name)
    comment(
        requestId,
        L("Split from case") +
            " " +
            source.requestId +
            (start.byManager ? ". " + L("Its clock starts") + " " + dateText(start.startMs) + ": " + start.reason : "")
    )
    const result = {requestId, sourceRequestId: source.requestId, caseRelationId}
    lib.complete(operation, RELATION, caseRelationId, result)
    return result
}

// ===== follow-up =====
// A follow-up case of a closed or cancelled case (or one past its reopen window): the same customer and organization, the
// case's queue while it is one of the organization's (else the default queue) and type when the queue takes it, its
// reporter (or the reply's sender when that is the customer's contact), dated by the reply's receipt; a case at once, assigned
// by the queue's rules; the reply on it (a mail filed, a message referenced), and the relation and its item.
function makeFollowUp(requestId, o = {}) {
    const request = one(REQUEST, {requestId})
    const parties = cases.partiesOf(requestId)
    const organizationPartyId = cases.roleParty(parties, "OrgInternal")
    const customerPartyId = cases.roleParty(parties, "Customer")
    let requestCategoryId = request.requestCategoryId
    let queue = cases.queueOf(requestCategoryId)
    if (!queue || queue.organizationPartyId !== organizationPartyId) {
        requestCategoryId = cases.policyOf(organizationPartyId)?.defaultCategoryId || null
        queue = cases.queueOf(requestCategoryId)
    }
    if (!queue || queue.organizationPartyId !== organizationPartyId)
        denied("QUEUE_UNAVAILABLE", "No service queue of " + cases.partyName(organizationPartyId) + " takes a follow-up")
    const offered = cases.listOf(queue.queue.offeredTypeEnumIds)
    const requestTypeEnumId =
        !offered.length || offered.includes(request.requestTypeEnumId) ? request.requestTypeEnumId : offered[0]
    const name = text(o.requestName) || L("Follow-up") + ": " + (request.requestName || requestId)
    const newId = call(R + "create#Request", {
        requestName: name.substring(0, 255),
        description: o.description || null,
        requestTypeEnumId,
        requestCategoryId,
        priority: request.priority ?? 5,
        statusId: "ReqSubmitted",
        requestDate: stamp(o.receivedMs ?? nowMs()),
        salesChannelEnumId: o.emailMessageId ? "ScEmail" : request.salesChannelEnumId || null,
        customerPartyId,
        filedByPartyId: o.senderPartyId || ec.user.userAccount?.partyId || null,
        emailContactMechId: o.emailContactMechId || null
    }).requestId
    const sender = o.senderPartyId
    const reporterPartyId =
        sender && sender !== customerPartyId && customerSide(sender, parties) ? sender : cases.roleParty(parties, "Reporter")
    if (reporterPartyId !== customerPartyId) setReporter(newId, reporterPartyId)
    if (!cases.partiesOf(newId).some(row => row.roleTypeId === "OrgInternal"))
        call("create#mantle.request.RequestParty", {
            requestId: newId,
            partyId: organizationPartyId,
            roleTypeId: "OrgInternal",
            fromDate: now()
        })
    const made = cases.ensureCase({
        requestId: newId,
        emailMessageId: o.emailMessageId || null,
        communicationEventId: o.communicationEventId || null
    })
    if (!made.isCase) denied("NOT_A_CASE", "Request " + newId + " is not a case: " + (made.reason || ""))
    // the reply on the new case once it is a case, so its assignee hears of it
    let communicationEventId = o.communicationEventId || null
    if (o.emailMessageId)
        communicationEventId = call(R + "file#RequestEmail", {
            requestId: newId,
            emailMessageId: o.emailMessageId
        }).communicationEventId
    else if (communicationEventId) linkMessage(newId, communicationEventId)
    const caseRelationId = call("create#" + RELATION, {
        fromRequestId: requestId,
        toRequestId: newId,
        relationTypeEnumId: "CrtFollowUp",
        organizationPartyId,
        userId: o.byAgent ? ec.user.userId || null : null,
        relationDate: now(),
        reason: text(o.reason) || (o.byAgent ? null : L("The customer replied after the case was closed"))
    }).caseRelationId
    if (communicationEventId || o.emailMessageId)
        itemWriter(
            caseRelationId,
            newId
        )({
            itemTypeEnumId: "CriMessage",
            communicationEventId,
            emailMessageId: o.emailMessageId || null,
            audienceEnumId: "CfaCustomer"
        })
    comment(requestId, L("Followed up by case") + " " + newId)
    comment(newId, L("Follow-up of case") + " " + requestId + (text(o.reason) ? ": " + text(o.reason) : ""))
    return {requestId: newId, caseRelationId}
}
// create#FollowUpCase: an agent's follow-up of a closed or cancelled case (or one past its reopen window).
function createFollowUp(p) {
    cases.requirePermission("SUPPORT_CASE_EDIT")
    const theCase = cases.caseOf(p.requestId, true)
    cases.refuseMerged(theCase)
    const state = finishState(theCase.request, theCase.profile, theCase.organizationPartyId)
    if (!state.resolved && !state.cancelled)
        denied("CASE_OPEN", "Case " + theCase.requestId + " is open: add to it instead of following it up")
    if (state.reopenable(nowMs()))
        denied("CASE_REOPENABLE", "Case " + theCase.requestId + " can still be reopened: reopen it instead")
    return makeFollowUp(theCase.requestId, {
        requestName: p.requestName,
        description: p.description,
        reason: p.reason,
        byAgent: true
    })
}
// make#FollowUpCase (after the commit of a customer's reply on a closed or cancelled case): once per reply; a second reply
// joins the follow-up still open.
function followUpReply(p) {
    const request = one(REQUEST, {requestId: p.requestId})
    const event = one(COMM, {communicationEventId: p.communicationEventId})
    if (!request || !event || !one(PROFILE, {requestId: p.requestId})) return {}
    const done = rows(ITEM, {communicationEventId: p.communicationEventId}).some(
        row => one(RELATION, {caseRelationId: row.caseRelationId})?.relationTypeEnumId === "CrtFollowUp"
    )
    if (done) return {}
    const open = openFollowUp(p.requestId)
    if (open) {
        linkMessage(open, p.communicationEventId)
        return {requestId: open, joined: true}
    }
    return makeFollowUp(p.requestId, {
        communicationEventId: p.communicationEventId,
        receivedMs: receiptOf(event),
        senderPartyId: event.fromPartyId,
        description: String(event.body || "")
            .replace(/<[^>]*>/g, " ")
            .trim()
            .substring(0, 20000)
    })
}

// ===== a reply (Sla.js recordMessage, Channels.js mail) =====
// A message from the case's customer side filed on a case: to a merged case, it goes to the case kept; to a resolved case
// within the reopen window, it reopens it (by the workflow's move back to an open status; the status rule starts the new
// resolution episode); to a closed or cancelled case, or after the window, a follow-up case after the commit. A message older
// than the resolution (filed late) does nothing, nor does one a merge or split referenced, or one not from the customer side.
function replyArrived(requestId, communicationEventId) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const profile = one(PROFILE, {requestId})
        const request = profile ? one(REQUEST, {requestId}) : null
        const event = request ? one(COMM, {communicationEventId}) : null
        if (!event?.fromPartyId) return {}
        if (find(ITEM, {toRequestId: requestId, communicationEventId}).count() > 0) return {}
        const parties = cases.partiesOf(requestId)
        if (!customerSide(event.fromPartyId, parties)) return {}
        const kept = mergedInto(requestId)
        if (kept) {
            linkMessage(kept, communicationEventId)
            return {action: "redirect", requestId: kept}
        }
        const state = finishState(request, profile, cases.roleParty(parties, "OrgInternal"))
        if (!state.resolved && !state.cancelled) return {}
        const atMs = receiptOf(event) ?? nowMs()
        if (atMs < state.finishedMs) return {}
        if (state.reopenable(atMs)) {
            reopen(request, profile)
            return {action: "reopen"}
        }
        queueFollowUp(requestId, communicationEventId)
        return {action: "followUp"}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
// The customer's reply reopens a resolved case: the workflow's move from its status to In progress (else to another open
// status), its resolution cleared, with the reason on its events.
function reopen(request, profile) {
    const workflowId = profile.caseWorkflowId || "CwfDefault"
    const movesOf = caseWorkflowId =>
        cases
            .currentRows(TRANSITION, {caseWorkflowId, statusId: request.statusId})
            .filter(row => sla().mappingCategory(workflowId, row.toStatusId) === "CscOpen")
    const moves = movesOf(workflowId).length ? movesOf(workflowId) : movesOf("CwfDefault")
    const move = moves.find(row => row.toStatusId === "ReqInProgress") || moves[0]
    if (!move) return
    call("update#" + REQUEST, {requestId: request.requestId, statusId: move.toStatusId, requestResolutionEnumId: "RrUnresolved"})
    sla().attachReason(request.requestId, move.toStatusId, "The customer replied")
}
function queueFollowUp(requestId, communicationEventId) {
    const name = "mantle.request.SupportCaseServices.make#FollowUpCase"
    try {
        ec.service.special().name(name).parameters({requestId, communicationEventId}).registerOnCommit()
    } catch (error) {
        ec.service.sync().name(name).parameters({requestId, communicationEventId}).disableAuthz().call()
    }
}
// Where a mail to a queue that answers a case goes (Channels.js resolveMail, before anything is written): to the case kept
// when the case was merged; for the customer side's own (not automatic) mail to a closed or cancelled case, or one past its
// reopen window, to the open follow-up it has, else to a new follow-up; otherwise to the case (a reply within the window
// reopens it by the rule).
function mailTarget(requestId, sender, automatic) {
    const kept = mergedInto(requestId)
    if (kept) return {action: "join", requestId: kept, mergedFrom: requestId}
    const profile = one(PROFILE, {requestId})
    const request = profile ? one(REQUEST, {requestId}) : null
    if (!request || automatic || !sender?.partyId) return {action: "join", requestId}
    const parties = cases.partiesOf(requestId)
    if (!customerSide(sender.partyId, parties)) return {action: "join", requestId}
    const state = finishState(request, profile, cases.roleParty(parties, "OrgInternal"))
    if ((!state.resolved && !state.cancelled) || state.reopenable(nowMs())) return {action: "join", requestId}
    const open = openFollowUp(requestId)
    if (open) return {action: "join", requestId: open, followUpOf: requestId}
    return {action: "followUp", followUpOf: requestId, customerPartyId: cases.roleParty(parties, "Customer")}
}

// ===== closing (CS-JOBS) =====
// close#ResolvedCases: for each organization whose current ServicePolicy has an auto-close delay, its cases resolved longer
// ago than that and not closed (of requestIds when given), oldest first, a bounded batch; each closed in its own transaction
// (close#ResolvedCase), a failing one logged and named and the rest going on. A case with a clock still running is named
// without a try and never takes a place in the batch, so such cases cannot hold back the others run after run.
function closeResolved(p) {
    const limit = Math.max(1, Math.min(2000, Number(p.limit) || 200))
    const scope = cases.listOf(p.requestIds)
    const at = nowMs()
    const policies = cases.currentRows(POLICY, {}).filter(row => row.autoCloseDays != null && Number(row.autoCloseDays) >= 0)
    const failed = []
    const fail = (requestId, message) => {
        ec.logger.error("Case " + requestId + " was not closed: " + message)
        failed.push({requestId, message})
    }
    let closed = 0,
        scanned = 0
    for (const policy of policies) {
        if (scanned >= limit) break
        const days = Number(policy.autoCloseDays)
        let query = find(CASE_ORG, {partyId: policy.organizationPartyId, roleTypeId: "OrgInternal", statusId: "ReqCompleted"})
            .condition("closedDate", "is-null", null)
            .condition("thruDate", "is-null", null)
            .condition("lastUpdatedStamp", "less", stamp(at - days * dayMs))
        if (scope.length) query = query.condition("requestId", "in", scope)
        const ids = Array.from(
            query
                .orderBy("lastUpdatedStamp")
                .limit(limit * 5)
                .list()
        ).map(row => row.requestId)
        const running = new Set(
            ids.length
                ? Array.from(
                      find(EPISODE, {}).condition("requestId", "in", ids).condition("stateEnumId", "in", runningStates).list()
                  ).map(row => row.requestId)
                : []
        )
        for (const requestId of ids) {
            if (running.has(requestId)) {
                fail(requestId, "CLOCK_OPEN: Case " + requestId + " is resolved with a clock still running; it is not closed")
                continue
            }
            if (scanned >= limit) break
            scanned++
            ec.message.pushErrors()
            try {
                const out =
                    ec.service
                        .sync()
                        .name("mantle.request.SupportCaseServices.close#ResolvedCase")
                        .parameters({requestId, autoCloseDays: days})
                        .requireNewTransaction(true)
                        .disableAuthz()
                        .call() || {}
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                if (out.closed) closed++
            } catch (error) {
                fail(requestId, error && error.message ? error.message : String(error))
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
    }
    return {scannedCount: scanned, closedCount: closed, failedList: failed}
}
// close#ResolvedCase: one case, locked: still Completed, not closed and resolved longer ago than the delay; a case with a
// clock still running is not closed (auto-close never closes an unhandled case) and is named (CLOCK_OPEN).
function closeOne(p) {
    const request = find(REQUEST, {requestId: p.requestId}).forUpdate(true).one()
    const profile = request ? one(PROFILE, {requestId: p.requestId}) : null
    if (!profile || request.statusId !== "ReqCompleted" || profile.closedDate) return {closed: false}
    if (nowMs() - finishedAt(request, ["ReqCompleted"]) < Number(p.autoCloseDays) * dayMs) return {closed: false}
    if (find(EPISODE, {requestId: p.requestId}).condition("stateEnumId", "in", runningStates).count() > 0)
        denied("CLOCK_OPEN", "Case " + p.requestId + " is resolved with a clock still running; it is not closed")
    call("update#" + PROFILE, {requestId: p.requestId, closedDate: now()})
    return {closed: true}
}

// ===== get#CaseLineage =====
// A case's lineage for CaseDetail: each relation from or to it (merged into or from, split into or from, followed up by or a
// follow-up of) with the other case, who, when, why and its items with their audience; the case it was merged into (its
// redirect), whether it is closed, and what may still be done (a change, a reopen, a follow-up).
const relationTexts = {
    CrtMerge: ["Merged into", "Merged from"],
    CrtSplit: ["Split into", "Split from"],
    CrtFollowUp: ["Followed up by", "Follow-up of"]
}
function itemText(row) {
    switch (row.itemTypeEnumId) {
        case "CriMessage": {
            const event = row.communicationEventId ? one(COMM, {communicationEventId: row.communicationEventId}) : null
            return event
                ? [enumText(event.communicationEventTypeId), cases.partyName(event.fromPartyId), dateText(receiptOf(event))]
                      .filter(Boolean)
                      .join(" · ")
                : L("Mail") + " " + (row.emailMessageId || "")
        }
        case "CriFile": {
            const file = one(CONTENT, {requestContentId: row.requestContentId})
            return (
                file?.description ||
                String(file?.contentLocation || "")
                    .split("/")
                    .pop() ||
                row.requestContentId
            )
        }
        case "CriRecord":
            return (
                String(row.recordEntityName || "")
                    .split(".")
                    .pop() +
                " " +
                row.recordId
            )
        case "CriWork":
            return one("mantle.work.effort.WorkEffort", {workEffortId: row.workEffortId})?.workEffortName || row.workEffortId
        case "CriClock": {
            const clock = one(EPISODE, {caseSlaEpisodeId: row.caseSlaEpisodeId})
            return (
                enumText(clock?.clockEnumId) +
                (clock?.breachedDate ? " · " + L("breached") + " " + dateText(clock.breachedDate) : "") +
                (row.carriedEpisodeId ? " · " + L("carried, due") + " " + dateText(clock?.dueDate) : "")
            )
        }
        default:
            return ""
    }
}
function lineage(p) {
    const theCase = cases.caseOf(p.requestId)
    const requestId = theCase.requestId
    const relationsOf = (field, direction) =>
        Array.from(
            find(RELATION, {[field]: requestId})
                .orderBy("relationDate")
                .list()
        ).map(relation => {
            const otherRequestId = direction === "from" ? relation.toRequestId : relation.fromRequestId
            const items = rows(ITEM, {caseRelationId: relation.caseRelationId}).map(row => ({
                itemTypeEnumId: row.itemTypeEnumId,
                typeText: enumText(row.itemTypeEnumId),
                itemText: itemText(row),
                audienceEnumId: row.audienceEnumId,
                audienceText: row.audienceEnumId === "CfaCustomer" ? L("Customer-visible") : L("Internal")
            }))
            const user = relation.userId ? one("moqui.security.UserAccount", {userId: relation.userId}) : null
            return {
                caseRelationId: relation.caseRelationId,
                relationTypeEnumId: relation.relationTypeEnumId,
                direction,
                relationText: L((relationTexts[relation.relationTypeEnumId] || ["", ""])[direction === "from" ? 0 : 1]),
                otherRequestId,
                otherName: one(REQUEST, {requestId: otherRequestId})?.requestName || otherRequestId,
                otherStatusText: statusText(one(REQUEST, {requestId: otherRequestId})?.statusId),
                dateText: dateText(relation.relationDate),
                userName: user ? cases.partyName(user.partyId) || user.username || "" : L("The customer's reply"),
                reason: relation.reason || "",
                itemsText: Object.entries(
                    items.reduce((counts, row) => {
                        counts[row.typeText] = (counts[row.typeText] || 0) + 1
                        return counts
                    }, {})
                )
                    .map(([label, count]) => count + " " + label.toLowerCase() + (count > 1 ? "s" : ""))
                    .join(", "),
                items
            }
        })
    const relations = relationsOf("fromRequestId", "from").concat(relationsOf("toRequestId", "to"))
    const kept = mergedInto(requestId)
    const state = finishState(theCase.request, theCase.profile, theCase.organizationPartyId)
    return {
        relations,
        mergedIntoRequestId: kept,
        mergedIntoName: kept ? one(REQUEST, {requestId: kept})?.requestName || kept : null,
        closed: state.closed,
        closedText: dateText(theCase.profile.closedDate),
        cancelled: state.cancelled,
        resolved: state.resolved,
        reopenable: state.reopenable(nowMs()),
        actionable: !kept && !state.closed,
        canFollowUp: !kept && (state.cancelled || (state.resolved && !state.reopenable(nowMs()))),
        reopenWindowDays: state.windowDays
    }
}

const operations = {previewMerge, merge, previewSplit, split, createFollowUp, followUpReply, closeResolved, closeOne, lineage}
;({
    // for Sla.js (a reply on a case) and Channels.js (a mail answering a case)
    replyArrived,
    mailTarget,
    makeFollowUp: (requestId, options) => {
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return makeFollowUp(requestId, options)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    },
    mergedInto,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown case relation operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
