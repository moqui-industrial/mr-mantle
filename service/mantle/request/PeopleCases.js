// People's confidential cases (grievances; mantle.request.RequestServices' case services; IronStone People design §4 Grievances,
// §13 RequestDetail, PE-01, PE-21; impl-people P21). A case is a Request of the HR-confidential type RqtHrCase (an Enumeration of
// RequestConfidentialType, not a RequestType, so no other app offers or accepts it) whose row says nothing ("Confidential case", no
// description, project, store, facility, category, customer or organization party); what the employee wrote is on PeopleCase,
// opted out of AI. Its people are its RequestParty rows: the employee who filed it (Reporter) and its handlers (Assignee), each
// handler holding PEOPLE_CASE_HANDLE. Nobody else reads it, whatever their other grants: not the employee's manager, not HR, not
// a user with an entity authorization for requests, not the instance administrator, and not the assignee of a task linked to it.
//
// - create#PeopleCase: an employee files a case under a current employment of their own, with the employer's designated intake
//   handlers (the employer's PartySetting PeopleCaseIntake: the parties, each with an account holding PEOPLE_CASE_HANDLE and working
//   for the employer, never the employee); a retry with the operation key answers the case filed.
// - find#PeopleCases and get#PeopleCase: the caller's own cases and those they handle; any other is "not available", a missing one
//   alike.
// - change#PeopleCase: the handler starts, resolves, closes and reopens it; the employee withdraws it while open. Each names the
//   revision it read.
// - assign#PeopleCaseHandler: a handler adds another eligible handler of the employer, or takes one off (never the last).
// - add#PeopleCaseTask: a handler asks someone for work on the case: a task linked by RequestWorkEffort, which is protected (left
//   out of the CalDAV Tasks collection and of every task list but its assignee's), and whose assignee reads nothing of the case.
// - every notice is PeopleCaseUpdate (no push, a title that names nothing), to the case's people.
//
// The other modules read the rule through caseIds, hiddenRequestIds, caseEvents, hiddenEventIds, caseTaskIds and
// protectedTaskIds (CommunicationServices.get#RecordLinkInfo, search#Universal, the task lists and CalDAV, the party timeline,
// lookup#ById, the record notices, a note's edit, delete, reply and link) and leave a case out of every other app's lists and
// screens.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText, calendarDateText, ms} = lib

const CASE_TYPE = "RqtHrCase"
const REQUEST = "mantle.request.Request"
const CASE = "mantle.request.PeopleCase"
const PARTY = "mantle.request.RequestParty"
const TASK_LINK = "mantle.request.RequestWorkEffort"
const WORK = "mantle.work.effort.WorkEffort"
const FOLLOWER = "mantle.party.communication.RecordFollower"
const HANDLE = "PEOPLE_CASE_HANDLE"
const INTAKE = "PeopleCaseIntake"
const caseName = "Confidential case"
const openStatuses = ["ReqSubmitted", "ReqReviewed", "ReqInProgress"]
const stateTexts = {
    ReqSubmitted: "Filed",
    ReqReviewed: "Filed",
    ReqInProgress: "In progress",
    ReqCompleted: "Resolved",
    ReqCancelled: "Closed"
}
const stateColors = {
    ReqSubmitted: "warning",
    ReqReviewed: "warning",
    ReqInProgress: "primary",
    ReqCompleted: "positive",
    ReqCancelled: "grey-7"
}
// a handler's and the employee's moves: the statuses each starts from, where it goes, and its words
const moves = {
    start: {who: "handler", from: ["ReqSubmitted", "ReqReviewed"], to: "ReqInProgress", label: "Start"},
    resolve: {who: "handler", from: openStatuses, to: "ReqCompleted", label: "Resolve"},
    close: {who: "handler", from: openStatuses, to: "ReqCancelled", label: "Close without action"},
    reopen: {who: "handler", from: ["ReqCompleted"], to: "ReqInProgress", label: "Reopen"},
    withdraw: {who: "filer", from: openStatuses, to: "ReqCancelled", label: "Withdraw"}
}
// the notices' words: fixed, naming no person, employer or subject, so a lock screen or an inbox shows nothing of the case
const notices = {
    filed: "A confidential case was filed with you",
    assigned: "A confidential case was assigned to you",
    updated: "A confidential case you are on was updated"
}

const unique = values => Array.from(new Set(values))
const listOf = value =>
    (value == null ? [] : typeof value === "string" ? value.split(",") : Array.from(value))
        .map(id => String(id ?? "").trim())
        .filter(Boolean)
const text = value => (value == null ? "" : String(value).trim())
const truthy = value => value === true || value === "true" || value === "Y"
const now = () => ec.user.nowTimestamp
const currentOf = query => query.conditionDate("fromDate", "thruDate", now())
const myPartyId = () => (ec.user.userId ? ec.user.userAccount?.partyId || null : null)

// ===== the rule other modules read =====
// The cases among the request ids.
function caseIds(requestIds) {
    const ids = unique(listOf(requestIds))
    if (!ids.length) return []
    return Array.from(
        find(REQUEST).condition("requestId", "in", ids).condition("requestTypeEnumId", CASE_TYPE).selectField("requestId").list()
    ).map(row => row.requestId)
}
const isCase = requestId => !!requestId && caseIds([requestId]).length > 0
// The current rows of a party on cases: {requestId: {filer, handler}}.
function partyRows(requestIds, partyId) {
    const found = {}
    if (!partyId || !requestIds.length) return found
    const query = find(PARTY)
        .condition("requestId", "in", requestIds)
        .condition("partyId", partyId)
        .condition("roleTypeId", "in", ["Reporter", "Assignee"])
    for (const row of Array.from(currentOf(query).list())) {
        const roles = found[row.requestId] || (found[row.requestId] = {filer: false, handler: false})
        if (row.roleTypeId === "Reporter") roles.filer = true
        else roles.handler = true
    }
    return found
}
// The current user's part in each case of the ids: "handler" (an Assignee row and PEOPLE_CASE_HANDLE) or "filer"; a case they have
// no part in is absent. A call with no user has none.
function userRoles(requestIds) {
    const cases = caseIds(requestIds)
    const roles = {}
    const partyId = myPartyId()
    if (!cases.length || !partyId) return roles
    const handles = ec.user.hasPermission(HANDLE)
    for (const [requestId, found] of Object.entries(partyRows(cases, partyId))) {
        if (found.handler && handles) roles[requestId] = "handler"
        else if (found.filer) roles[requestId] = "filer"
    }
    return roles
}
// The cases among the request ids the current user is no part of: every case for a call with no user.
function hiddenRequestIds(requestIds) {
    const cases = caseIds(requestIds)
    if (!cases.length) return []
    const roles = userRoles(cases)
    return cases.filter(requestId => !roles[requestId])
}
// The communication events among the ids filed on a case (the event or the root of its thread, by RequestCommEvent or a
// CommunicationEventRecord): {communicationEventId: requestId}.
function caseEvents(communicationEventIds) {
    const ids = unique(listOf(communicationEventIds))
    const found = {}
    if (!ids.length) return found
    const roots = new Map(
        Array.from(
            find("mantle.party.communication.CommunicationEvent")
                .condition("communicationEventId", "in", ids)
                .selectField("communicationEventId")
                .selectField("rootCommEventId")
                .list()
        ).map(row => [row.communicationEventId, row.rootCommEventId || null])
    )
    const all = unique(ids.concat(Array.from(roots.values()).filter(Boolean)))
    const filedOn = new Map()
    const add = (eventId, requestId) => (filedOn.get(eventId) || filedOn.set(eventId, []).get(eventId)).push(requestId)
    for (const row of Array.from(find("mantle.request.RequestCommEvent").condition("communicationEventId", "in", all).list()))
        add(row.communicationEventId, row.requestId)
    for (const row of Array.from(
        find("mantle.party.communication.CommunicationEventRecord")
            .condition("communicationEventId", "in", all)
            .condition("recordEntityName", REQUEST)
            .list()
    ))
        add(row.communicationEventId, row.recordId)
    if (!filedOn.size) return found
    const cases = new Set(caseIds(Array.from(filedOn.values()).flat()))
    if (!cases.size) return found
    for (const id of ids) {
        const requestId = [id, roots.get(id)]
            .filter(Boolean)
            .flatMap(eventId => filedOn.get(eventId) || [])
            .find(requestId => cases.has(requestId))
        if (requestId) found[id] = requestId
    }
    return found
}
// The communication events among the ids filed on a case the current user is no part of (every one filed on a case, for a call with
// no user): a reader that finds an event by another way than its case (a party's record, a reply's parent, a link to another
// record, an edit or a delete) answers such an event as missing (P21 review).
function hiddenEventIds(communicationEventIds) {
    const filedOn = caseEvents(communicationEventIds)
    const ids = Object.keys(filedOn)
    if (!ids.length) return []
    const hidden = new Set(hiddenRequestIds(Object.values(filedOn)))
    return ids.filter(id => hidden.has(filedOn[id]))
}
// The tasks among the ids linked to a case (RequestWorkEffort).
function caseTaskIds(workEffortIds) {
    const ids = unique(listOf(workEffortIds))
    if (!ids.length) return []
    const links = Array.from(find(TASK_LINK).condition("workEffortId", "in", ids).list())
    if (!links.length) return []
    const cases = new Set(caseIds(links.map(link => link.requestId)))
    return unique(links.filter(link => cases.has(link.requestId)).map(link => link.workEffortId))
}
// People's protected tasks among the ids: offboarding and separation work (ChecklistStep isProtected, P7) and the tasks linked to a
// case. They are left out of the CalDAV Tasks collection and reached through a generic list or record rule only by a current
// assignee (Checklists.js hiddenTaskIds).
function protectedTaskIds(workEffortIds) {
    const ids = unique(listOf(workEffortIds))
    if (!ids.length) return []
    const steps = Array.from(
        find("mantle.humanres.checklist.ChecklistStep")
            .condition("workEffortId", "in", ids)
            .condition("isProtected", "Y")
            .selectField("workEffortId")
            .list()
    ).map(row => row.workEffortId)
    return unique(steps.concat(caseTaskIds(ids)))
}

// ===== people =====
function personNames(partyIds) {
    const ids = unique(partyIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.party.Person").condition("partyId", "in", ids).list()).map(row => [
            row.partyId,
            [row.firstName, row.lastName].filter(Boolean).join(" ") || row.partyId
        ])
    )
}
const organizationName = partyId => one("mantle.party.Organization", {partyId})?.organizationName || partyId
// The enabled accounts of the parties: {partyId: [userId]}.
function accountsOf(partyIds) {
    const found = {}
    if (!partyIds.length) return found
    for (const row of Array.from(find("moqui.security.UserAccount").condition("partyId", "in", unique(partyIds)).list())) {
        if (row.disabled === "Y") continue
        ;(found[row.partyId] || (found[row.partyId] = [])).push(row.userId)
    }
    return found
}
// Whether one of a party's enabled accounts holds PEOPLE_CASE_HANDLE now.
function handlesCases(partyId) {
    const userIds = accountsOf([partyId])[partyId] || []
    if (!userIds.length) return false
    const at = ms(now())
    const open = (from, thru) => (ms(from) ?? -Infinity) <= at && (ms(thru) ?? Infinity) > at
    return Array.from(
        find("moqui.security.UserPermissionCheck").condition("userId", "in", userIds).condition("userPermissionId", HANDLE).list()
    ).some(row => open(row.groupFromDate, row.groupThruDate) && open(row.permissionFromDate, row.permissionThruDate))
}
// Whether a party works for the organization now (its internal organizations, as a staff reader's are read).
function worksFor(partyId, organizationPartyId) {
    const info = call("mantle.party.PartyServices.get#PartyInternalOrgIds", {partyId})
    return Array.from(info.userOrgIds || []).includes(organizationPartyId)
}
// Whether a party may handle a case of the employer: an account holding PEOPLE_CASE_HANDLE, working for the employer.
const eligibleHandler = (partyId, organizationPartyId) =>
    !!partyId && handlesCases(partyId) && worksFor(partyId, organizationPartyId)
// The employer's designated intake handlers (its PartySetting PeopleCaseIntake: party ids, comma-separated), those eligible now;
// one who is not is skipped and logged.
function intakeHandlers(organizationPartyId) {
    const setting = one("mantle.party.PartySetting", {partyId: organizationPartyId, partySettingTypeId: INTAKE})
    const handlers = []
    for (const partyId of listOf(setting?.settingValue)) {
        if (eligibleHandler(partyId, organizationPartyId)) handlers.push(partyId)
        else ec.logger.warn(`Case intake of ${organizationPartyId}: ${partyId} does not handle cases there now, skipped`)
    }
    return unique(handlers)
}
// The current people of a case: {filerPartyId, handlerPartyIds}.
function peopleOf(requestId) {
    const found = Array.from(
        currentOf(find(PARTY).condition("requestId", requestId).condition("roleTypeId", "in", ["Reporter", "Assignee"])).list()
    )
    return {
        filerPartyId: found.find(row => row.roleTypeId === "Reporter")?.partyId || null,
        handlerPartyIds: unique(found.filter(row => row.roleTypeId === "Assignee").map(row => row.partyId))
    }
}
// The case's people as follower rows (notes, messages and activities), so a note on it tells them (the case notice, below).
function follow(requestId, partyIds) {
    for (const userIds of Object.values(accountsOf(partyIds)))
        for (const userId of userIds) {
            const keys = {recordEntityName: REQUEST, recordId: requestId, userId}
            if (one(FOLLOWER, keys)) continue
            call("create#" + FOLLOWER, {
                ...keys,
                fromDate: now(),
                notifyMessages: "Y",
                notifyNotes: "Y",
                notifyActivities: "Y",
                notifyChanges: "N"
            })
        }
}
function unfollow(requestId, partyId) {
    const userIds = accountsOf([partyId])[partyId] || []
    if (userIds.length)
        find(FOLLOWER).condition({recordEntityName: REQUEST, recordId: requestId}).condition("userId", "in", userIds).deleteAll()
}
// A PeopleCaseUpdate notice to the case's people (or the parties given) but the current user: the case's id and fixed words, no
// push, to them alone (directOnly: a Tools subscription to every message of the topic receives none; the user's call of Nov 12,
// 2026, People follow-up 1). A failure is logged and the change stays.
function tell(requestId, noticeKind, partyIds = null) {
    try {
        const people = peopleOf(requestId)
        const parties = partyIds || [people.filerPartyId].concat(people.handlerPartyIds)
        const userIds = unique(Object.values(accountsOf(parties.filter(Boolean))).flat()).filter(
            userId => userId !== ec.user.userId
        )
        if (!userIds.length) return []
        ec.makeNotificationMessage()
            .topic("PeopleCaseUpdate")
            .message({requestId, noticeText: notices[noticeKind] || notices.updated})
            .userIds(userIds)
            .directOnly()
            .send()
        return userIds
    } catch (error) {
        ec.logger.error(`Case ${requestId}: the notice was not sent: ${error.message}`)
        return []
    }
}
// For the record notices (CommunicationServices.notify#RecordMention and notify#RecordFollowers): a note or message on a case tells
// only its people, on PeopleCaseUpdate, never the generic topics that carry the record's name and the start of the text.
function tellUpdate(p) {
    const requestId = text(p.requestId)
    if (!isCase(requestId)) return {notifiedUserIds: []}
    return {notifiedUserIds: tell(requestId, "updated")}
}

// ===== a handler who leaves (the user's call of Nov 12, 2026) =====
// The open cases of an employer whose handlers no longer handle cases there (they left it, or lost PEOPLE_CASE_HANDLE): each such
// handler is taken off the case (their Assignee row ended, no longer following it), so a leaver reads none of the employer's
// cases; a case left with no handler goes back to the employer's intake handlers (PeopleCaseIntake, those eligible now, never its
// employee), who are told on PeopleCaseUpdate with a title that names nothing. A case with no intake handler to go to keeps its
// employee and waits (logged), and is routed by the next call. Employment.js calls it for the employer of a separation once it is
// in effect, and the daily job for the employers of the changes come since, naming the leavers (taken off whatever this
// transaction reads of their employment); each case on its own (a failure is logged and the rest go on).
function rerouteCases(organizationPartyId, leaverPartyIds = []) {
    const leavers = listOf(leaverPartyIds)
    const found = {rerouted: 0, released: 0, waiting: 0}
    if (!organizationPartyId) return found
    const requestIds = Array.from(
        find(CASE).condition("organizationPartyId", organizationPartyId).selectField("requestId").list()
    ).map(row => row.requestId)
    if (!requestIds.length) return found
    const open = Array.from(
        find(REQUEST)
            .condition("requestId", "in", requestIds)
            .condition("requestTypeEnumId", CASE_TYPE)
            .condition("statusId", "in", openStatuses)
            .selectField("requestId")
            .list()
    ).map(row => row.requestId)
    let intake = null
    const intakeOf = () => intake || (intake = intakeHandlers(organizationPartyId))
    for (const requestId of open) {
        // in the caller's transaction (a separation's apply, whose ended employment this reads); a failure is logged
        ec.message.pushErrors()
        try {
            rerouteCase(requestId, organizationPartyId, leavers, intakeOf, found)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            ec.logger.error(`Case ${requestId} was not routed again: ${error.message}`)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return found
}
function rerouteCase(requestId, organizationPartyId, leavers, intakeOf, found) {
    const people = peopleOf(requestId)
    const gone = people.handlerPartyIds.filter(
        partyId => leavers.includes(partyId) || !eligibleHandler(partyId, organizationPartyId)
    )
    for (const partyId of gone) {
        currentOf(find(PARTY).condition({requestId, partyId, roleTypeId: "Assignee"})).updateAll({thruDate: now()})
        unfollow(requestId, partyId)
        found.released++
    }
    if (people.handlerPartyIds.length > gone.length) return
    const handlers = intakeOf().filter(partyId => partyId !== people.filerPartyId)
    if (!handlers.length) {
        found.waiting++
        ec.logger.error(`Case ${requestId} of ${organizationPartyId} has no handler and the employer no intake handler`)
        return
    }
    for (const partyId of handlers) call("create#" + PARTY, {requestId, partyId, roleTypeId: "Assignee", fromDate: now()})
    follow(requestId, handlers)
    tell(requestId, "assigned", handlers)
    found.rerouted++
}
// For People's lifecycle participant (PeopleApprovalServices.find#OwnedApprovals): the open cases a party handles now, as owned
// resources that name nothing of the case (no subject, employee or employer), not transferable: when they leave, each goes back to
// the employer's intake handlers (rerouteCases).
function ownedCases(partyId) {
    if (!partyId) return []
    const handled = Array.from(
        currentOf(
            find("mantle.request.RequestAndParty")
                .condition("partyId", partyId)
                .condition("roleTypeId", "Assignee")
                .condition("requestTypeEnumId", CASE_TYPE)
                .condition("statusId", "in", openStatuses)
                .selectField("requestId")
                .distinct(true)
        ).list()
    ).map(row => row.requestId)
    return unique(handled).map(requestId => ({
        resourceId: "case:" + requestId,
        resourceName: caseName,
        resourceKind: "case",
        transferable: false,
        note: "Goes back to the employer's case intake handlers when they leave"
    }))
}

// ===== the caller's case =====
// A case of the caller's, with their part in it, else "not available" (a missing case alike).
function caseFor(requestId) {
    const id = text(requestId)
    const role = id ? userRoles([id])[id] : null
    if (!role) denied("RECORD_UNAVAILABLE", "Case " + (id || "") + " is not available")
    const request = one(REQUEST, {requestId: id})
    const facts = one(CASE, {requestId: id}) || {}
    return {requestId: id, role, request, facts}
}
const revisionOf = request => String(ms(request.lastUpdatedStamp) ?? 0)
function checkRevision(request, expectedRevision) {
    if (expectedRevision != null && text(expectedRevision) !== "" && text(expectedRevision) !== revisionOf(request))
        denied("REVISION_CHANGED", "The case changed since you read it (now revision " + revisionOf(request) + "); open it again")
}

// ===== services =====
function createCase(p) {
    const partyId = myPartyId()
    if (!partyId) denied("PERMISSION_DENIED", "Sign in to file a case")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const earlier = Array.from(find(CASE).condition("operationKey", operationKey).list()).find(
            row => one(REQUEST, {requestId: row.requestId})?.filedByPartyId === partyId
        )
        if (earlier) return {requestId: earlier.requestId, created: false}
    }
    const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
    const employments = Array.from(people.current(people.employmentFind().condition("fromPartyId", partyId), null).list())
    if (!employments.length) denied("NOT_EMPLOYED", "You have no current employment to file a case under")
    let employment = employments.length === 1 ? employments[0] : null
    if (text(p.partyRelationshipId)) {
        employment = employments.find(row => row.partyRelationshipId === text(p.partyRelationshipId))
        if (!employment) denied("RECORD_UNAVAILABLE", "Employment " + text(p.partyRelationshipId) + " is not available")
    }
    if (!employment) denied("EMPLOYMENT_REQUIRED", "Choose the employer the case is for")
    const subject = text(p.subject)
    if (!subject) denied("SUBJECT_REQUIRED", "Say what the case is about")
    let incidentDate = null
    if (text(p.incidentDate)) {
        incidentDate = calendarDateText(p.incidentDate)
        if (incidentDate > ec.l10n.format(new Date(ms(now())), "yyyy-MM-dd"))
            denied("DATE_INVALID", "The day it happened cannot be in the future")
    }
    const organizationPartyId = employment.toPartyId
    const handlers = intakeHandlers(organizationPartyId).filter(handler => handler !== partyId)
    if (!handlers.length)
        denied("NO_CASE_HANDLER", "Your employer has nobody to take confidential cases yet; ask HR who handles them")
    const requestId = call("create#" + REQUEST, {
        requestTypeEnumId: CASE_TYPE,
        statusId: "ReqSubmitted",
        requestName: caseName,
        priority: 5,
        requestDate: now(),
        requestResolutionEnumId: "RrUnresolved",
        filedByPartyId: partyId
    }).requestId
    call("create#" + CASE, {
        requestId,
        organizationPartyId,
        partyRelationshipId: employment.partyRelationshipId,
        subject,
        details: text(p.details) || null,
        incidentDate,
        contactPreference: text(p.contactPreference) || null,
        operationKey
    })
    call("create#" + PARTY, {requestId, partyId, roleTypeId: "Reporter", fromDate: now()})
    for (const handler of handlers)
        call("create#" + PARTY, {requestId, partyId: handler, roleTypeId: "Assignee", fromDate: now()})
    follow(requestId, [partyId].concat(handlers))
    tell(requestId, "filed", handlers)
    return {requestId, created: true}
}

// One case as a row of the list, for the caller's part in it.
function caseRow(request, facts, role, names, people) {
    return {
        requestId: request.requestId,
        referenceText: "Case " + request.requestId,
        subject: facts.subject || "",
        statusId: request.statusId,
        stateText: stateTexts[request.statusId] || request.statusId,
        stateColor: stateColors[request.statusId] || "grey-7",
        role,
        roleText: role === "handler" ? "Handling" : "Filed by you",
        organizationPartyId: facts.organizationPartyId || null,
        organizationText: facts.organizationPartyId ? organizationName(facts.organizationPartyId) : "",
        handlersText: people.handlerPartyIds.map(id => names[id] || id).join(", "),
        filedByText: role === "handler" ? names[people.filerPartyId] || "" : "",
        submittedDateText: dateText(request.requestDate),
        open: openStatuses.includes(request.statusId)
    }
}
function findCases(p) {
    const partyId = myPartyId()
    if (!partyId) denied("PERMISSION_DENIED", "Sign in to see your cases")
    const show = text(p.show) || "open"
    if (!["open", "closed", "all"].includes(show)) denied("SHOW_INVALID", "Show open, closed or all cases")
    const mine = Array.from(
        currentOf(
            find("mantle.request.RequestAndParty")
                .condition("partyId", partyId)
                .condition("roleTypeId", "in", ["Reporter", "Assignee"])
                .condition("requestTypeEnumId", CASE_TYPE)
                .selectField("requestId")
                .distinct(true)
        ).list()
    ).map(row => row.requestId)
    const roles = userRoles(mine)
    let ids = Object.keys(roles)
    if (text(p.requestId)) {
        if (!roles[text(p.requestId)]) denied("RECORD_UNAVAILABLE", "Case " + text(p.requestId) + " is not available")
        ids = [text(p.requestId)]
    }
    const requests = ids.length
        ? Array.from(find(REQUEST).condition("requestId", "in", ids).orderBy("-requestDate").list()).filter(request =>
              show === "all"
                  ? true
                  : show === "open"
                    ? openStatuses.includes(request.statusId)
                    : !openStatuses.includes(request.statusId)
          )
        : []
    const facts = new Map(
        requests.length
            ? Array.from(
                  find(CASE)
                      .condition(
                          "requestId",
                          "in",
                          requests.map(row => row.requestId)
                      )
                      .list()
              ).map(row => [row.requestId, row])
            : []
    )
    const peopleBy = new Map(requests.map(request => [request.requestId, peopleOf(request.requestId)]))
    const names = personNames(
        Array.from(peopleBy.values()).flatMap(people => [people.filerPartyId].concat(people.handlerPartyIds))
    )
    const list = requests.map(request =>
        caseRow(request, facts.get(request.requestId) || {}, roles[request.requestId], names, peopleBy.get(request.requestId))
    )
    const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
    const employments = Array.from(people.current(people.employmentFind().condition("fromPartyId", partyId), null).list())
    return Object.assign(lib.pageList(list, p, "cases"), {
        canFile: employments.length > 0,
        employerOptions: employments.map(row => ({
            partyRelationshipId: row.partyRelationshipId,
            label: organizationName(row.toPartyId)
        }))
    })
}

// The tasks linked to a case, for its handlers: name, assignee, state and due day.
function taskRows(requestId) {
    const ids = rows(TASK_LINK, {requestId}).map(row => row.workEffortId)
    if (!ids.length) return []
    const tasks = Array.from(find(WORK).condition("workEffortId", "in", ids).orderBy("workEffortId").list())
    const assigned = Array.from(
        currentOf(
            find("mantle.work.effort.WorkEffortParty").condition("workEffortId", "in", ids).condition("roleTypeId", "Assignee")
        ).list()
    )
    const names = personNames(assigned.map(row => row.partyId))
    const statuses = new Map(
        Array.from(
            find("moqui.basic.StatusItem")
                .condition("statusId", "in", unique(tasks.map(row => row.statusId).filter(Boolean)))
                .list()
        ).map(row => [row.statusId, row.description])
    )
    return tasks.map(task => ({
        workEffortId: task.workEffortId,
        workEffortName: task.workEffortName || task.workEffortId,
        assigneeText: assigned
            .filter(row => row.workEffortId === task.workEffortId)
            .map(row => names[row.partyId] || row.partyId)
            .join(", "),
        statusText: statuses.get(task.statusId) || task.statusId || "",
        dueDateText: task.estimatedCompletionDate ? dateText(task.estimatedCompletionDate) : ""
    }))
}
function getCase(p) {
    const found = caseFor(p.requestId)
    const {request, facts, role} = found
    const people = peopleOf(found.requestId)
    const names = personNames([people.filerPartyId].concat(people.handlerPartyIds))
    const handler = role === "handler"
    const open = openStatuses.includes(request.statusId)
    const allowed = Object.entries(moves)
        .filter(([, move]) => move.who === role && move.from.includes(request.statusId))
        .map(([action, move]) => ({action, label: move.label}))
    let handlerOptions = []
    if (handler && open) {
        const designated = listOf(
            one("mantle.party.PartySetting", {partyId: facts.organizationPartyId, partySettingTypeId: INTAKE})?.settingValue
        )
        const candidates = unique(
            designated.concat(
                Array.from(
                    find("moqui.security.UserPermissionCheck")
                        .condition("userPermissionId", HANDLE)
                        .selectField("userId")
                        .distinct(true)
                        .list()
                )
                    .map(row => one("moqui.security.UserAccount", {userId: row.userId})?.partyId)
                    .filter(Boolean)
            )
        ).filter(id => id !== people.filerPartyId && !people.handlerPartyIds.includes(id))
        const eligible = candidates.filter(id => eligibleHandler(id, facts.organizationPartyId))
        const optionNames = personNames(eligible)
        handlerOptions = eligible.map(id => ({partyId: id, label: optionNames[id] || id}))
    }
    return {
        peopleCase: {
            requestId: found.requestId,
            referenceText: "Case " + found.requestId,
            subject: facts.subject || "",
            details: facts.details || "",
            incidentDateText: facts.incidentDate ? calendarDateText(facts.incidentDate) : "",
            contactPreference: facts.contactPreference || "",
            outcomeNote: facts.outcomeNote || "",
            statusId: request.statusId,
            stateText: stateTexts[request.statusId] || request.statusId,
            stateColor: stateColors[request.statusId] || "grey-7",
            submittedDateText: dateText(request.requestDate),
            organizationText: facts.organizationPartyId ? organizationName(facts.organizationPartyId) : "",
            filedByText: names[people.filerPartyId] || "",
            handlers: people.handlerPartyIds.map(id => ({partyId: id, name: names[id] || id})),
            handlersText: people.handlerPartyIds.map(id => names[id] || id).join(", "),
            role,
            roleText: handler ? "You handle this case" : "You filed this case",
            open,
            revision: revisionOf(request)
        },
        moves: allowed,
        canHandle: handler,
        canAddFiles: open,
        tasks: handler ? taskRows(found.requestId) : [],
        handlerOptions
    }
}

function changeCase(p) {
    const found = caseFor(p.requestId)
    const action = text(p.action)
    const move = moves[action]
    if (!move) denied("ACTION_INVALID", "Start, resolve, close, reopen or withdraw a case")
    if (move.who !== found.role)
        denied(
            "PERMISSION_DENIED",
            move.who === "handler" ? "Only the case's handlers do that" : "Only who filed the case withdraws it"
        )
    checkRevision(found.request, p.expectedRevision)
    if (!move.from.includes(found.request.statusId)) denied("ACTION_INVALID", "The case is " + stateTexts[found.request.statusId])
    const values = {requestId: found.requestId, statusId: move.to}
    if (action === "resolve") values.requestResolutionEnumId = "RrCompleted"
    if (action === "reopen") values.requestResolutionEnumId = "RrUnresolved"
    call("update#" + REQUEST, values)
    if ((action === "resolve" || action === "close") && text(p.outcomeNote))
        call("update#" + CASE, {requestId: found.requestId, outcomeNote: text(p.outcomeNote)})
    tell(found.requestId, "updated")
    return {statusId: move.to, stateText: stateTexts[move.to]}
}

function assignHandler(p) {
    const found = caseFor(p.requestId)
    if (found.role !== "handler") denied("PERMISSION_DENIED", "Only the case's handlers assign it")
    checkRevision(found.request, p.expectedRevision)
    const partyId = text(p.partyId)
    const people = peopleOf(found.requestId)
    if (truthy(p.remove)) {
        if (!people.handlerPartyIds.includes(partyId)) denied("HANDLER_INVALID", "They do not handle this case")
        if (people.handlerPartyIds.length < 2) denied("LAST_HANDLER", "A case keeps at least one handler; add another first")
        currentOf(find(PARTY).condition({requestId: found.requestId, partyId, roleTypeId: "Assignee"})).updateAll({
            thruDate: now()
        })
        unfollow(found.requestId, partyId)
        return {removed: true}
    }
    if (!openStatuses.includes(found.request.statusId)) denied("CASE_CLOSED", "The case is closed")
    if (people.handlerPartyIds.includes(partyId)) return {added: false}
    const facts = found.facts
    if (partyId === people.filerPartyId || !eligibleHandler(partyId, facts.organizationPartyId))
        denied("HANDLER_INVALID", "Choose a case handler of the employer")
    call("create#" + PARTY, {requestId: found.requestId, partyId, roleTypeId: "Assignee", fromDate: now()})
    follow(found.requestId, [partyId])
    tell(found.requestId, "assigned", [partyId])
    return {added: true}
}

function addTask(p) {
    const found = caseFor(p.requestId)
    if (found.role !== "handler") denied("PERMISSION_DENIED", "Only the case's handlers ask for work on it")
    if (!openStatuses.includes(found.request.statusId)) denied("CASE_CLOSED", "The case is closed")
    const workEffortName = text(p.workEffortName)
    if (!workEffortName) denied("NAME_REQUIRED", "Name the task")
    const assigneePartyId = text(p.assigneePartyId)
    if (!assigneePartyId || !one("mantle.party.Party", {partyId: assigneePartyId}))
        denied("ASSIGNEE_REQUIRED", "Choose who does the task")
    const workEffortId = call("mantle.work.TaskServices.create#SimpleTask", {
        workEffortName,
        estimatedCompletionDate: text(p.dueDate) || null,
        ownerPartyId: myPartyId(),
        assignToPartyId: assigneePartyId,
        requestId: found.requestId
    }).workEffortId
    // the assignee is told who asked and when it is due, never the case (PeopleTaskAssigned's title)
    call("mantle.humanres.PeopleServices.notify#PeopleTaskAssigned", {workEffortId, partyId: assigneePartyId})
    return {workEffortId}
}

// Whether the caller reads a case (its files and notes, through get#RecordLinkInfo and RecordFiles): its people only; canEdit
// while it is open.
function caseAccess(p) {
    const requestId = text(p.requestId)
    const role = requestId ? userRoles([requestId])[requestId] : null
    if (!role) return {recordVisible: false, canEdit: false, role: null}
    const request = one(REQUEST, {requestId})
    return {recordVisible: true, canEdit: openStatuses.includes(request?.statusId), role}
}

// The search index's view of a document (a DataDocument's manual data service): a case's request, and a message filed on one,
// gain the marker confidentialCase, which the documents' post-query condition leaves out of the index, so no case text is in it.
// Any other document is answered empty, which keeps it as it was.
function documentData(p) {
    const document = p.document || {}
    const marked = () => ({document: Object.assign({}, document, {confidentialCase: "Y"})})
    if (p.dataDocumentId === "MantleRequest" && document.requestTypeEnumId === CASE_TYPE) return marked()
    if (p.dataDocumentId === "MantleCommunicationEvent" && document.communicationEventId)
        if (caseEvents([document.communicationEventId])[document.communicationEventId]) return marked()
    return {document: {}}
}

const operations = {
    createCase,
    findCases,
    getCase,
    changeCase,
    assignHandler,
    addTask,
    caseAccess,
    tellUpdate,
    documentData
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown case operation " + op)
        return operations[op](parameters || {})
    },
    CASE_TYPE,
    caseIds,
    isCase,
    hiddenRequestIds,
    caseEvents,
    hiddenEventIds,
    caseTaskIds,
    protectedTaskIds,
    rerouteCases,
    ownedCases,
    // P29: the employer's intake setting, as People's settings and readiness read it (PeopleSettings.js, People.js)
    INTAKE,
    listOf,
    eligibleHandler,
    intakeHandlers
})
