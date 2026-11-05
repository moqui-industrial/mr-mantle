// Support cases (design-customer-service §3 Cases, NewCase, CaseDetail, §9 Settings; impl-customer-service P2, CS-QUEUE,
// CS-SETTINGS, CX-REQUEST, D23, F5, F6, F41, F62, F64, F74; SupportCaseEntities.xml). A case is a Request in a service queue:
// a RequestCategory owned by an internal organization with a current ServiceQueue row. A request becomes a case when it is
// submitted (not a draft, not closed), has a current Customer RequestParty that is a Customer-role party of the service
// organization (owned by it, or shared: _NA_, F74; never an internal party), and either is in one of the organization's
// service queues or has no category and a type the organization service-enables (then it moves into the type's default
// queue); a request with a project and such a customer is a case too. The organization is the request's OrgInternal party,
// else the queue's owner, the customer's owner, the filer's organization or the project's owner, and it must have a current
// ServicePolicy: nothing here acts where Customer Service is not configured. ensure makes the CaseProfile, the OrgInternal
// party and the queue move; the rules of entity/Request.eecas.xml run it after the commit on a request made, on a type,
// category or status change and on a Customer party added, so every entry point (Comms, Chat, Commons, Projects, email,
// the public form, the forum) gets its case without calling anything new. The case services check SUPPORT_CASE_EDIT,
// SUPPORT_CASE_MANAGE or SUPPORT_POLICY_EDIT and the case's organization (FacilityScope, get#PartyOrganizationInfo); they
// write the Request through its entity so Mantle's update#Request guard, which refuses a case's due date, resolution or close
// from any other path, does not stop them. Refusals carry reason codes (EntityLib.denied).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms} = lib

const REQUEST = "mantle.request.Request",
    PARTY = "mantle.request.RequestParty",
    CATEGORY = "mantle.request.RequestCategory",
    PROFILE = "mantle.request.support.CaseProfile",
    QUEUE = "mantle.request.support.ServiceQueue",
    TYPE = "mantle.request.support.ServiceRequestType",
    POLICY = "mantle.request.support.ServicePolicy",
    MAPPING = "mantle.request.support.CaseStatusMapping",
    TRANSITION = "mantle.request.support.CaseTransition",
    TAG = "mantle.request.RequestTag",
    RELATIONSHIP = "mantle.party.PartyRelationship"
const defaultWorkflow = "CwfDefault"
const teamRelationship = "PrtServiceTeam"
const closedStatuses = ["ReqCompleted", "ReqCancelled"]
const openStatuses = ["ReqSubmitted", "ReqReviewed", "ReqInProgress", "ReqWaitingCustomer", "ReqOnHold"]
const visibilities = ["SqvOrganization", "SqvTeam", "SqvRestricted"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = (value, fallback = "N") => (value === true || value === "Y" || value === "true" ? "Y" : blank(value) ? fallback : "N")
const now = () => ec.user.nowTimestamp
const listOf = value =>
    value == null
        ? []
        : (typeof value === "string" ? value.split(",") : Array.from(value))
              .map(String)
              .map(s => s.trim())
              .filter(Boolean)
const factory = () => ec.entity.conditionFactory
// P5: the assignment rules and team groups (Assignment.js), read once for this evaluation
let assignmentModule = null
const assignment = () =>
    assignmentModule || (assignmentModule = ec.resource.script("component://mr-mantle/service/mantle/request/Assignment.js"))

// ===== effective-dated rows =====
// The rows in effect at a date: started (a draft has no from date) and not ended, the latest first.
function currentRows(entity, conditions, date = now()) {
    return Array.from(
        find(entity, conditions)
            .condition(factory().makeCondition("fromDate", "is-not-null", null))
            .conditionDate("fromDate", "thruDate", date)
            .orderBy("-fromDate")
            .list()
    )
}
const currentRow = (entity, conditions, date) => currentRows(entity, conditions, date)[0] || null
// A save of an effective-dated row: the new row from its date (now when not given; a draft has none) ends the rows it
// replaces at that date, so history stays.
function startRow(entity, idField, conditions, values, p) {
    const draft = p.draft === true || p.draft === "Y" || p.draft === "true"
    const fromDate = draft ? null : p.fromDate || now()
    if (!draft)
        for (const row of currentRows(entity, conditions, fromDate)) {
            row.set("thruDate", fromDate)
            row.update()
        }
    const out = call("create#" + entity, Object.assign({}, conditions, values, {fromDate, thruDate: p.thruDate || null}))
    return out[idField]
}

// ===== parties =====
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
const partiesOf = requestId => currentRows(PARTY, {requestId})
const roleParty = (parties, roleTypeId) => parties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
// A customer the organization serves: a Customer-role party, not internal (an internal organization, or a person who works
// for one), owned by the organization or shared (_NA_).
function servedCustomer(partyId, organizationPartyId) {
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    if (!party || party.disabled === "Y" || isInternal(partyId) || organizationsOf(partyId).length) return false
    if (!one("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})) return false
    return party.ownerPartyId === "_NA_" || !party.ownerPartyId || party.ownerPartyId === organizationPartyId
}
// The internal organizations a party works for (employee, agent or member), current.
function organizationsOf(partyId) {
    if (!partyId) return []
    return currentRows(RELATIONSHIP, {fromPartyId: partyId})
        .filter(row => ["PrtEmployee", "PrtAgent", "PrtMember", "PrtRepresentative"].includes(row.relationshipTypeEnumId))
        .map(row => row.toPartyId)
        .filter(isInternal)
}
const partyName = partyId => (partyId ? lib.partyNames([partyId])[partyId] || partyId : "")

// ===== queues and policy =====
const policyOf = (organizationPartyId, date) => (organizationPartyId ? currentRow(POLICY, {organizationPartyId}, date) : null)
// A service queue: a category with an owner organization and a current ServiceQueue row.
function queueOf(requestCategoryId, date) {
    const category = requestCategoryId ? one(CATEGORY, {requestCategoryId}) : null
    if (!category || !category.ownerPartyId) return null
    const queue = currentRow(QUEUE, {requestCategoryId}, date)
    return queue ? {category, queue, organizationPartyId: category.ownerPartyId} : null
}
const typeOf = (organizationPartyId, requestTypeEnumId, date) =>
    organizationPartyId && requestTypeEnumId ? currentRow(TYPE, {organizationPartyId, requestTypeEnumId}, date) : null
const teamMembers = (teamPartyId, date) =>
    teamPartyId ? currentRows(RELATIONSHIP, {toPartyId: teamPartyId, relationshipTypeEnumId: teamRelationship}, date) : []
const isTeamMember = (partyId, teamPartyId) => teamMembers(teamPartyId).some(row => row.fromPartyId === partyId)

// ===== the case rule =====
// The organizations a request may be a case of, in order: its OrgInternal party, its category's owner, its customers'
// owners, its filer's organizations, its project's owner.
function candidateOrganizations(request, parties) {
    const ids = [roleParty(parties, "OrgInternal")]
    if (request.requestCategoryId) ids.push(one(CATEGORY, {requestCategoryId: request.requestCategoryId})?.ownerPartyId)
    for (const row of parties.filter(row => row.roleTypeId === "Customer"))
        ids.push(one("mantle.party.Party", {partyId: row.partyId})?.ownerPartyId)
    ids.push(...organizationsOf(request.filedByPartyId))
    if (request.rootWorkEffortId)
        ids.push(one("mantle.work.effort.WorkEffort", {workEffortId: request.rootWorkEffortId})?.ownerPartyId)
    return Array.from(new Set(ids.filter(id => id && id !== "_NA_" && isInternal(id))))
}
// The customers a filer stands for: itself when it is a customer, and the customers it is a current contact or employee of
// (PrtContact, PrtEmployee to a Customer-role party); never an internal party, nor anyone who works for an internal
// organization (an employee's or agent's own request is never a case by inference, even when they are a customer too or an
// account's representative; Nov 5 decision).
function customerSidesOf(partyId) {
    if (!partyId || isInternal(partyId) || organizationsOf(partyId).length) return []
    const ids = [partyId].concat(
        currentRows(RELATIONSHIP, {fromPartyId: partyId})
            .filter(row => ["PrtContact", "PrtEmployee"].includes(row.relationshipTypeEnumId))
            .map(row => row.toPartyId)
    )
    return Array.from(new Set(ids)).filter(
        id => !isInternal(id) && !!one("mantle.party.PartyRole", {partyId: id, roleTypeId: "Customer"})
    )
}
// The case a request is or would be: its organization, policy, customer and queue (and whether it moves into the type's
// default queue), or null with the reason it is not one.
function route(request, parties = partiesOf(request.requestId)) {
    if (!request) return {reason: "NO_REQUEST"}
    if (request.statusId === "ReqDraft" || closedStatuses.includes(request.statusId)) return {reason: "NOT_SUBMITTED"}
    // a request becomes a case when it is Submitted (Nov 5 decision); one already in progress becomes one only by a move into a
    // service queue, so a policy set up later, or a Customer party added to a request in progress, converts no open request
    if (request.statusId !== "ReqSubmitted" && !queueOf(request.requestCategoryId)) return {reason: "NOT_SUBMITTED"}
    let customers = parties.filter(row => row.roleTypeId === "Customer").map(row => row.partyId)
    // a customer contact's own request (Chat, Commons, the forum: no Customer party): its filer when the filer is a customer,
    // else the customer organizations the filer is a contact of; ensure adds the Customer party (F-P2-1)
    const inferred = !customers.length
    if (inferred) customers = customerSidesOf(request.filedByPartyId)
    if (!customers.length) return {reason: "NO_CUSTOMER"}
    const withCustomers = inferred ? parties.concat(customers.map(partyId => ({roleTypeId: "Customer", partyId}))) : parties
    for (const organizationPartyId of candidateOrganizations(request, withCustomers)) {
        const policy = policyOf(organizationPartyId)
        if (!policy) continue
        const customerPartyId = customers.find(partyId => servedCustomer(partyId, organizationPartyId))
        if (!customerPartyId) continue
        if (request.requestCategoryId) {
            const queue = queueOf(request.requestCategoryId)
            if (queue && queue.organizationPartyId === organizationPartyId)
                return {
                    organizationPartyId,
                    policy,
                    customerPartyId,
                    inferred,
                    requestCategoryId: request.requestCategoryId,
                    move: false
                }
            continue
        }
        const type = typeOf(organizationPartyId, request.requestTypeEnumId)
        const queue = type?.serviceEnabled === "Y" ? queueOf(type.defaultCategoryId) : null
        if (queue && queue.organizationPartyId === organizationPartyId)
            return {
                organizationPartyId,
                policy,
                type,
                customerPartyId,
                inferred,
                requestCategoryId: type.defaultCategoryId,
                move: true
            }
    }
    return {reason: "NOT_A_CASE"}
}
// ensure#CaseProfile: make the request a case when the rule says it is one (idempotent; the request is locked so the rules
// of one change, run after its commit, make one profile).
function ensure(p) {
    const request = find(REQUEST, {requestId: p.requestId}).forUpdate(true).one()
    if (!request) return {isCase: false, created: false}
    if (one(PROFILE, {requestId: p.requestId})) return {isCase: true, created: false}
    const parties = partiesOf(p.requestId)
    const found = route(request, parties)
    if (!found.organizationPartyId) return {isCase: false, created: false, reason: found.reason}
    const fields = {}
    if (found.move) fields.requestCategoryId = found.requestCategoryId
    const type = found.type || typeOf(found.organizationPartyId, request.requestTypeEnumId)
    if (request.priority == null && type?.defaultPriority != null) fields.priority = type.defaultPriority
    if (Object.keys(fields).length) call("update#" + REQUEST, Object.assign({requestId: p.requestId}, fields))
    if (found.inferred)
        call("create#" + PARTY, {requestId: p.requestId, partyId: found.customerPartyId, roleTypeId: "Customer", fromDate: now()})
    if (!roleParty(parties, "OrgInternal"))
        call("create#" + PARTY, {
            requestId: p.requestId,
            partyId: found.organizationPartyId,
            roleTypeId: "OrgInternal",
            fromDate: now()
        })
    // the accepted intake time: the received date of the mail it came by (the one given, filed or not yet), else the request
    // date (F84: the clocks start from it, P6)
    const mail = rows("mantle.request.RequestEmailMessage", {requestId: p.requestId})[0] || null
    const intakeMailId = p.emailMessageId || mail?.emailMessageId || null
    const received = intakeMailId ? one("moqui.basic.email.EmailMessage", {emailMessageId: intakeMailId})?.receivedDate : null
    const event = rows("mantle.request.RequestCommEvent", {requestId: p.requestId})[0] || null
    call("create#" + PROFILE, {
        requestId: p.requestId,
        servicePolicyId: found.policy.servicePolicyId,
        caseWorkflowId: type?.caseWorkflowId || found.policy.caseWorkflowId || defaultWorkflow,
        intakeCategoryId: found.requestCategoryId,
        intakeDate: received || request.requestDate || now(),
        communicationEventId: p.communicationEventId || event?.communicationEventId || null,
        emailMessageId: p.emailMessageId || mail?.emailMessageId || null
    })
    // its clocks (P4, mantle.request.SlaServices.start#CaseEpisode): a failure is logged, never the case's
    ec.message.pushErrors()
    try {
        ec.resource
            .script("component://mr-mantle/service/mantle/request/Sla.js")
            .execute("startEpisode", {requestId: p.requestId})
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    } catch (error) {
        ec.logger.error("Case " + p.requestId + ": its service level clocks were not started: " + (error?.message || error))
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    // P5: its assignee by the queue's assignment rules (assign#Case; an assigned request stays so): a failure is logged,
    // never the case's
    if (!p.skipAssignment) {
        ec.message.pushErrors()
        try {
            assignment().execute("assign", {requestId: p.requestId})
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            ec.logger.error("Case " + p.requestId + ": its assignment rules did not run: " + (error?.message || error))
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {
        isCase: true,
        created: true,
        organizationPartyId: found.organizationPartyId,
        requestCategoryId: found.requestCategoryId
    }
}
// get#CaseState: whether a request is a case (and its organization and queue), or with no request whether one with these
// fields would be (raise#Request's due date, F64).
function state(p) {
    if (p.requestId) {
        const profile = one(PROFILE, {requestId: p.requestId})
        const request = profile ? one(REQUEST, {requestId: p.requestId}) : null
        return {
            isCase: !!profile,
            wouldBeCase: !!profile,
            organizationPartyId: profile ? roleParty(partiesOf(p.requestId), "OrgInternal") : null,
            requestCategoryId: request?.requestCategoryId || null,
            statusCategoryEnumId: profile
                ? mappingFor(profile.caseWorkflowId, request.statusId)?.statusCategoryEnumId || null
                : null
        }
    }
    const request = {
        requestId: null,
        statusId: p.statusId || "ReqSubmitted",
        requestTypeEnumId: p.requestTypeEnumId || "RqtSupport",
        requestCategoryId: p.requestCategoryId || null,
        filedByPartyId: p.filedByPartyId || ec.user.userAccount?.partyId || null,
        rootWorkEffortId: p.rootWorkEffortId || null
    }
    const parties = []
    if (p.customerPartyId) parties.push({roleTypeId: "Customer", partyId: p.customerPartyId})
    if (p.organizationPartyId) parties.push({roleTypeId: "OrgInternal", partyId: p.organizationPartyId})
    const found = route(request, parties)
    return {
        isCase: false,
        wouldBeCase: !!found.organizationPartyId,
        organizationPartyId: found.organizationPartyId || null,
        requestCategoryId: found.requestCategoryId || null,
        statusCategoryEnumId: null
    }
}

// ===== status mappings =====
// The current mapping of a status in a workflow, falling back to the default workflow's.
function mappingFor(caseWorkflowId, statusId) {
    return (
        currentRow(MAPPING, {caseWorkflowId: caseWorkflowId || defaultWorkflow, statusId}) ||
        (caseWorkflowId && caseWorkflowId !== defaultWorkflow
            ? currentRow(MAPPING, {caseWorkflowId: defaultWorkflow, statusId})
            : null)
    )
}
function mappings(p) {
    const workflowId = p.caseWorkflowId || defaultWorkflow
    const byStatus = new Map()
    for (const row of currentRows(MAPPING, {caseWorkflowId: defaultWorkflow})) byStatus.set(row.statusId, row)
    if (workflowId !== defaultWorkflow)
        for (const row of currentRows(MAPPING, {caseWorkflowId: workflowId})) byStatus.set(row.statusId, row)
    const list = Array.from(byStatus.values())
        .map(row => lib.map(row))
        .sort((a, b) => (a.sequenceNum ?? 99) - (b.sequenceNum ?? 99))
    const transitions = currentRows(TRANSITION, {caseWorkflowId: workflowId}).map(row => lib.map(row))
    return {
        mappingList: list,
        transitionList:
            transitions.length || workflowId === defaultWorkflow
                ? transitions
                : currentRows(TRANSITION, {caseWorkflowId: defaultWorkflow}).map(row => lib.map(row))
    }
}
function transitionFor(caseWorkflowId, statusId, toStatusId) {
    const workflowId = caseWorkflowId || defaultWorkflow
    const own = currentRows(TRANSITION, {caseWorkflowId: workflowId})
    const moves = own.length ? own : currentRows(TRANSITION, {caseWorkflowId: defaultWorkflow})
    return moves.find(row => row.statusId === statusId && row.toStatusId === toStatusId) || null
}

// ===== the case and its access =====
function requirePermission(permission) {
    if (!access.has(permission)) denied("PERMISSION_DENIED", permission + " is required")
}
function requireOrganization(organizationPartyId) {
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !facilityScope.owns(facilityScope.scope(), organizationPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
// The case's revision: the last change of the request or of its assignee (a stale batch row names it).
function revisionOf(requestId, request = one(REQUEST, {requestId})) {
    let revision = Number(ms(request?.lastUpdatedStamp) || 0)
    for (const row of rows(PARTY, {requestId, roleTypeId: "Assignee"}))
        revision = Math.max(revision, Number(ms(row.lastUpdatedStamp) || 0))
    return revision
}
// A case of one of the user's organizations; a missing request, one that is not a case and another organization's are
// refused alike (RECORD_UNAVAILABLE).
function caseOf(requestId, lock = false) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Case " + (requestId || "") + " is not available")
    if (blank(requestId)) unavailable()
    const request = lock ? find(REQUEST, {requestId}).forUpdate(true).one() : one(REQUEST, {requestId})
    const profile = request ? one(PROFILE, {requestId}) : null
    if (!profile) unavailable()
    const parties = partiesOf(requestId)
    const organizationPartyId = roleParty(parties, "OrgInternal")
    if (!organizationPartyId || !facilityScope.owns(facilityScope.scope(), organizationPartyId)) unavailable()
    return {
        request,
        profile,
        parties,
        requestId: String(requestId),
        organizationPartyId,
        customerPartyId: roleParty(parties, "Customer"),
        assigneePartyId: roleParty(parties, "Assignee"),
        revision: revisionOf(requestId, request)
    }
}
// P8: a case merged into another is no longer worked (CaseRelations.js): a change is refused naming the case it went into.
function refuseMerged(theCase) {
    const merged = Array.from(
        find("mantle.request.support.CaseRelation", {fromRequestId: theCase.requestId, relationTypeEnumId: "CrtMerge"})
            .limit(1)
            .list()
    )[0]
    if (merged)
        denied(
            "CASE_MERGED",
            "Case " + theCase.requestId + " was merged into case " + merged.toRequestId + "; work on case " + merged.toRequestId
        )
}
function checkRevision(theCase, caseRevision) {
    if (!blank(caseRevision) && Number(caseRevision) !== theCase.revision)
        denied("STALE_CASE", "Case " + theCase.requestId + " changed; its current revision is " + theCase.revision)
}
// An assignee for a case in a queue: a member of the queue's team, else of any of the organization's service teams or one
// who works for the organization.
function checkAssignee(partyId, queue, organizationPartyId) {
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    const unavailable = () => denied("ASSIGNEE_UNAVAILABLE", partyName(partyId) + " is not someone this case can be assigned to")
    if (!party || party.disabled === "Y" || party.partyTypeEnumId !== "PtyPerson") unavailable()
    if (queue?.responsibleTeamPartyId) {
        if (!isTeamMember(partyId, queue.responsibleTeamPartyId)) unavailable()
        return
    }
    const teams = rows(RELATIONSHIP, {fromPartyId: partyId, relationshipTypeEnumId: teamRelationship}).filter(row =>
        lib.active(row)
    )
    const ownTeam = teams.some(row => one("mantle.party.Party", {partyId: row.toPartyId})?.ownerPartyId === organizationPartyId)
    if (!ownTeam && !organizationsOf(partyId).includes(organizationPartyId)) unavailable()
}
// The assignee's users are told of the assignment (SupportCaseAssigned), not the user who made it.
function notifyAssigned(theCase, assigneePartyId) {
    try {
        const userIds = rows("moqui.security.UserAccount", {partyId: assigneePartyId})
            .map(row => row.userId)
            .filter(userId => userId && userId !== ec.user.userId)
        if (!userIds.length) return
        const message = {
            requestId: theCase.requestId,
            requestName: theCase.request.requestName || theCase.requestId,
            customerName: partyName(theCase.customerPartyId),
            assignedByName: partyName(ec.user.userAccount?.partyId) || ec.user.username || "The assignment rules",
            recordEntityName: REQUEST,
            recordId: theCase.requestId
        }
        const nm = ec.makeNotificationMessage().topic("SupportCaseAssigned").userIds(userIds).message(message)
        if (typeof nm.record === "function") nm.record(REQUEST, theCase.requestId)
        nm.send()
    } catch (error) {
        ec.logger.error("Case " + theCase.requestId + ": the assignment notice was not sent: " + error.message)
    }
}
function assign(theCase, assigneePartyId) {
    if (assigneePartyId === theCase.assigneePartyId) return false
    if (assigneePartyId) {
        call("mantle.request.RequestServices.replace#RequestParty", {
            requestId: theCase.requestId,
            roleTypeId: "Assignee",
            newPartyId: assigneePartyId
        })
        notifyAssigned(theCase, assigneePartyId)
    } else {
        for (const row of theCase.parties.filter(row => row.roleTypeId === "Assignee")) {
            row.set("thruDate", now())
            row.update()
        }
    }
    return true
}

// ===== create#Case, update#Case, transition#Case =====
function create(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    if (!policyOf(organizationPartyId))
        denied("SERVICE_NOT_CONFIGURED", "Customer Service is not set up for " + partyName(organizationPartyId))
    if (!servedCustomer(p.customerPartyId, organizationPartyId))
        denied("CUSTOMER_UNAVAILABLE", "Customer " + (p.customerPartyId || "") + " is not available")
    const requestTypeEnumId = p.requestTypeEnumId || "RqtSupport"
    const type = typeOf(organizationPartyId, requestTypeEnumId)
    const requestCategoryId = p.requestCategoryId || type?.defaultCategoryId || policyOf(organizationPartyId).defaultCategoryId
    const queue = queueOf(requestCategoryId)
    if (!queue || queue.organizationPartyId !== organizationPartyId)
        denied("QUEUE_UNAVAILABLE", "Choose a service queue of " + partyName(organizationPartyId))
    const offered = listOf(queue.queue.offeredTypeEnumIds)
    if (offered.length && !offered.includes(requestTypeEnumId))
        denied("TYPE_NOT_OFFERED", "The queue " + (queue.category.description || requestCategoryId) + " does not take this type")
    const name = text(p.requestName)
    if (!name) denied("NAME_REQUIRED", "A case needs a subject")
    const priority = blank(p.priority) ? (type?.defaultPriority ?? 5) : Number(p.priority)
    if (!(priority >= 1 && priority <= 9)) denied("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
    if (p.assigneePartyId) checkAssignee(p.assigneePartyId, queue.queue, organizationPartyId)
    // P7: the case's template values, checked before anything is made (CaseTemplates.js)
    const templates = ec.resource.script("component://mr-mantle/service/mantle/request/CaseTemplates.js")
    const templateFormId = templates.forCase(organizationPartyId, requestCategoryId, p.templateFormId)
    let templateValues = null
    if (templateFormId) {
        const checked = templates.checkValues(templateFormId, p.templateValues, "internal")
        if (!checked.valid) denied("TEMPLATE_VALUES_INVALID", checked.errors.map(error => error.message).join("; "))
        templateValues = checked.values
    }
    const created = call("mantle.request.RequestServices.create#Request", {
        requestName: name.substring(0, 255),
        description: p.description || null,
        requestTypeEnumId,
        requestCategoryId,
        priority,
        statusId: "ReqSubmitted",
        salesChannelEnumId: p.salesChannelEnumId || null,
        customerPartyId: p.customerPartyId
    })
    const requestId = created.requestId
    if (p.contactPartyId && p.contactPartyId !== ec.user.userAccount?.partyId)
        call("mantle.request.RequestServices.replace#RequestParty", {
            requestId,
            roleTypeId: "Reporter",
            newPartyId: p.contactPartyId
        })
    call("create#" + PARTY, {requestId, partyId: organizationPartyId, roleTypeId: "OrgInternal", fromDate: now()})
    for (const record of Array.isArray(p.records) ? p.records : [])
        if (record?.recordEntityName && record?.recordId)
            call("mantle.request.RequestServices.link#RequestRecord", {
                requestId,
                recordEntityName: record.recordEntityName,
                recordId: record.recordId
            })
    const made = ensure({
        requestId,
        communicationEventId: p.communicationEventId,
        emailMessageId: p.emailMessageId,
        skipAssignment: !blank(p.assigneePartyId)
    })
    if (!made.isCase) denied("NOT_A_CASE", "Request " + requestId + " is not a case: " + (made.reason || ""))
    if (templateFormId) templates.record(requestId, templateFormId, templateValues)
    if (p.assigneePartyId) {
        const theCase = caseOf(requestId)
        assign(theCase, p.assigneePartyId)
    }
    return {requestId}
}
function update(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = caseOf(p.requestId, true)
    refuseMerged(theCase)
    checkRevision(theCase, p.caseRevision)
    const mine = !theCase.assigneePartyId || theCase.assigneePartyId === ec.user.userAccount?.partyId
    if (!mine && !access.has("SUPPORT_CASE_MANAGE"))
        denied("PERMISSION_DENIED", "Case " + theCase.requestId + " is another agent's: SUPPORT_CASE_MANAGE is required")
    if (closedStatuses.includes(theCase.request.statusId)) denied("CASE_CLOSED", "Case " + theCase.requestId + " is closed")
    const fields = {}
    let queue = queueOf(theCase.request.requestCategoryId)?.queue || null
    if (!blank(p.requestCategoryId) && p.requestCategoryId !== theCase.request.requestCategoryId) {
        const moved = queueOf(p.requestCategoryId)
        if (!moved || moved.organizationPartyId !== theCase.organizationPartyId)
            denied("QUEUE_UNAVAILABLE", "Queue " + p.requestCategoryId + " is not a service queue of the case's organization")
        fields.requestCategoryId = p.requestCategoryId
        queue = moved.queue
    }
    if (!blank(p.priority)) {
        const priority = Number(p.priority)
        if (!(priority >= 1 && priority <= 9)) denied("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
        if (priority !== Number(theCase.request.priority)) fields.priority = priority
    }
    if (Object.keys(fields).length) call("update#" + REQUEST, Object.assign({requestId: theCase.requestId}, fields))
    let assigned = false
    if (p.assigneePartyId !== undefined && p.assigneePartyId !== null) {
        const assigneePartyId = text(p.assigneePartyId)
        if (assigneePartyId) checkAssignee(assigneePartyId, queue, theCase.organizationPartyId)
        assigned = assign(theCase, assigneePartyId)
    } else if (fields.requestCategoryId) {
        // P5: moved with no assignee given, the new queue's rules assign it (a queue with none leaves it); the clocks stay
        const out = assignment().execute("assign", {requestId: theCase.requestId, reassign: true})
        assigned = !!out.outcome && out.assigneePartyId !== theCase.assigneePartyId
    }
    return {
        requestId: theCase.requestId,
        changed: assigned || Object.keys(fields).length > 0,
        revision: revisionOf(theCase.requestId)
    }
}
// The time a case was completed: its last status change into Completed (the audit log), else its last update.
function completedDate(theCase) {
    const latest = Array.from(
        find("moqui.entity.EntityAuditLog", {
            changedEntityName: REQUEST,
            changedFieldName: "statusId",
            pkPrimaryValue: theCase.requestId,
            newValueText: "ReqCompleted"
        })
            .orderBy("-changedDate")
            .limit(1)
            .list()
    )[0]
    return Number(ms(latest?.changedDate || theCase.request.lastUpdatedStamp) || 0)
}
function transition(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = caseOf(p.requestId, true)
    refuseMerged(theCase)
    checkRevision(theCase, p.caseRevision)
    const fromStatusId = theCase.request.statusId
    const toStatusId = text(p.toStatusId)
    const move = toStatusId ? transitionFor(theCase.profile.caseWorkflowId, fromStatusId, toStatusId) : null
    if (!move)
        denied(
            "TRANSITION_NOT_ALLOWED",
            "Case " + theCase.requestId + " does not move from " + fromStatusId + " to " + (toStatusId || "")
        )
    if (move.manageRequired === "Y") requirePermission("SUPPORT_CASE_MANAGE")
    const policy = one(POLICY, {servicePolicyId: theCase.profile.servicePolicyId}) || policyOf(theCase.organizationPartyId)
    const resolutionEnumId = text(p.resolutionEnumId)
    if (move.resolutionRequired === "Y" && !resolutionEnumId && policy?.resolutionRequired !== "N")
        denied("RESOLUTION_REQUIRED", "Choose the resolution of case " + theCase.requestId)
    if (move.reasonRequired === "Y" && !text(p.reason)) denied("REASON_REQUIRED", "Give the reason")
    const fields = {requestId: theCase.requestId, statusId: toStatusId}
    if (fromStatusId === "ReqCompleted") {
        // a reopen: within the policy's window, and not of a closed case (a later reply makes a follow-up case, P8)
        if (theCase.profile.closedDate) denied("CASE_CLOSED", "Case " + theCase.requestId + " is closed; open a follow-up case")
        const days = policy?.reopenWindowDays ?? 14
        if (Number(ms(now())) - completedDate(theCase) > days * 86400000)
            denied("REOPEN_WINDOW_PASSED", "Case " + theCase.requestId + " was resolved more than " + days + " days ago")
        fields.requestResolutionEnumId = "RrUnresolved"
    } else if (closedStatuses.includes(toStatusId)) {
        fields.requestResolutionEnumId = resolutionEnumId || (toStatusId === "ReqCancelled" ? "RrRejected" : "RrCompleted")
    }
    call("update#" + REQUEST, fields)
    // the reason on the clocks' events of this move (P4: a pause, a resume, a reopen)
    if (text(p.reason))
        ec.resource
            .script("component://mr-mantle/service/mantle/request/Sla.js")
            .attachReason(theCase.requestId, toStatusId, p.reason)
    if (text(p.reason))
        call("mantle.request.RequestServices.add#RequestComment", {
            requestId: theCase.requestId,
            body: String(p.reason).trim(),
            contentType: "text/plain"
        })
    const mapping = mappingFor(theCase.profile.caseWorkflowId, toStatusId)
    return {
        requestId: theCase.requestId,
        statusId: toStatusId,
        statusLabel: mapping?.agentLabel || one("moqui.basic.StatusItem", {statusId: toStatusId})?.description || toStatusId,
        revision: revisionOf(theCase.requestId)
    }
}
// set#CaseTags: add, remove or replace the case's tags (RequestTag rows of the RequestTag enumeration; ended, not deleted).
function tags(p) {
    requirePermission("SUPPORT_CASE_EDIT")
    const theCase = caseOf(p.requestId)
    refuseMerged(theCase)
    const wanted = listOf(p.tagEnumIds)
    for (const tagEnumId of wanted)
        if (one("moqui.basic.Enumeration", {enumId: tagEnumId})?.enumTypeId !== "RequestTag")
            denied("TAG_UNKNOWN", tagEnumId + " is not a request tag")
    const mode = p.mode || "add"
    const live = currentRows(TAG, {requestId: theCase.requestId})
    const has = new Set(live.map(row => row.tagEnumId))
    for (const row of live)
        if ((mode === "remove" && wanted.includes(row.tagEnumId)) || (mode === "replace" && !wanted.includes(row.tagEnumId))) {
            row.set("thruDate", now())
            row.update()
            has.delete(row.tagEnumId)
        }
    if (mode !== "remove")
        for (const tagEnumId of wanted)
            if (!has.has(tagEnumId)) {
                call("create#" + TAG, {requestId: theCase.requestId, tagEnumId, fromDate: now()})
                has.add(tagEnumId)
            }
    return {tagEnumIds: Array.from(has)}
}

// ===== settings (CS-SETTINGS) =====
function requireTeam(teamPartyId, organizationPartyId) {
    const team = teamPartyId ? one("mantle.party.Party", {partyId: teamPartyId}) : null
    if (
        !team ||
        team.ownerPartyId !== organizationPartyId ||
        !one("mantle.party.PartyRole", {partyId: teamPartyId, roleTypeId: "OrgTeam"})
    )
        denied("TEAM_UNAVAILABLE", "Team " + (teamPartyId || "") + " is not a team of " + partyName(organizationPartyId))
    return team
}
function saveQueue(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    let requestCategoryId = text(p.requestCategoryId)
    let category = requestCategoryId ? one(CATEGORY, {requestCategoryId}) : null
    const organizationPartyId = requireOrganization(category?.ownerPartyId || p.organizationPartyId)
    if (category && p.organizationPartyId && p.organizationPartyId !== category.ownerPartyId)
        denied("QUEUE_ORGANIZATION", "A queue stays its organization's")
    if (category && !category.ownerPartyId) denied("QUEUE_ORGANIZATION", "Category " + requestCategoryId + " is not a queue")
    if (p.parentCategoryId) {
        const parent = one(CATEGORY, {requestCategoryId: p.parentCategoryId})
        if (!parent || parent.ownerPartyId !== organizationPartyId || p.parentCategoryId === requestCategoryId)
            denied("QUEUE_UNAVAILABLE", "The parent must be another queue of the organization")
    }
    const categoryFields = {}
    for (const field of ["description", "parentCategoryId", "responsiblePartyId"])
        if (p[field] !== undefined) categoryFields[field] = p[field] || null
    if (!category) {
        if (!text(p.description)) denied("NAME_REQUIRED", "A queue needs a name")
        requestCategoryId = call(
            "create#" + CATEGORY,
            Object.assign({ownerPartyId: organizationPartyId}, categoryFields)
        ).requestCategoryId
        category = one(CATEGORY, {requestCategoryId})
    } else if (Object.keys(categoryFields).length) call("update#" + CATEGORY, Object.assign({requestCategoryId}, categoryFields))
    if (p.end === true || p.end === "Y" || p.end === "true") {
        // a queue new intake goes to is not ended (design Queues: disabling needs a destination); its cases stay
        const policy = policyOf(organizationPartyId)
        const usedByType = currentRows(TYPE, {organizationPartyId, defaultCategoryId: requestCategoryId}).some(
            row => row.serviceEnabled === "Y"
        )
        if (policy?.defaultCategoryId === requestCategoryId || usedByType)
            denied("QUEUE_IN_USE", "New cases still go to this queue; choose another default first")
        for (const row of currentRows(QUEUE, {requestCategoryId})) {
            row.set("thruDate", p.fromDate || now())
            row.set("changeReason", text(p.changeReason))
            row.update()
        }
        return {requestCategoryId, serviceQueueId: null}
    }
    const visibilityEnumId = p.visibilityEnumId || "SqvOrganization"
    if (!visibilities.includes(visibilityEnumId)) denied("VISIBILITY_INVALID", visibilityEnumId + " is not a queue visibility")
    if (p.responsibleTeamPartyId) requireTeam(p.responsibleTeamPartyId, organizationPartyId)
    if (visibilityEnumId === "SqvRestricted" && !p.responsibleTeamPartyId)
        denied("TEAM_REQUIRED", "A restricted queue needs its team")
    const offered = listOf(p.offeredTypeEnumIds)
    for (const enumId of offered)
        if (one("moqui.basic.Enumeration", {enumId})?.enumTypeId !== "RequestType")
            denied("TYPE_UNKNOWN", enumId + " is not a request type")
    if (p.fallbackAssigneePartyId)
        checkAssignee(p.fallbackAssigneePartyId, {responsibleTeamPartyId: p.responsibleTeamPartyId}, organizationPartyId)
    // P7: the queue keeps its template unless one is given (empty: none), an organization's case template
    const templateFormId =
        p.templateFormId == null ? currentRow(QUEUE, {requestCategoryId})?.templateFormId || null : text(p.templateFormId)
    if (templateFormId) {
        const template = one("moqui.screen.form.DbForm", {formId: templateFormId})
        if (template?.purposeEnumId !== "DbfpCaseTemplate" || template.ownerPartyId !== organizationPartyId)
            denied("TEMPLATE_UNAVAILABLE", "Template " + templateFormId + " is not one of the organization's")
    }
    const serviceQueueId = startRow(
        QUEUE,
        "serviceQueueId",
        {requestCategoryId},
        {
            offeredTypeEnumIds: offered.join(",") || null,
            visibilityEnumId,
            responsibleTeamPartyId: p.responsibleTeamPartyId || null,
            fallbackAssigneePartyId: p.fallbackAssigneePartyId || null,
            templateFormId,
            changeReason: text(p.changeReason)
        },
        p
    )
    return {requestCategoryId, serviceQueueId}
}
function saveType(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    if (one("moqui.basic.Enumeration", {enumId: p.requestTypeEnumId})?.enumTypeId !== "RequestType")
        denied("TYPE_UNKNOWN", (p.requestTypeEnumId || "") + " is not a request type")
    const serviceEnabled = yn(p.serviceEnabled)
    if (p.defaultCategoryId) {
        const queue = queueOf(p.defaultCategoryId)
        if (!queue || queue.organizationPartyId !== organizationPartyId)
            denied("QUEUE_UNAVAILABLE", "The default queue must be a service queue of the organization")
    } else if (serviceEnabled === "Y") denied("QUEUE_REQUIRED", "A service-enabled type needs its default queue")
    if (!blank(p.defaultPriority) && !(Number(p.defaultPriority) >= 1 && Number(p.defaultPriority) <= 9))
        denied("PRIORITY_INVALID", "A priority is 1 (highest) to 9 (lowest)")
    const serviceRequestTypeId = startRow(
        TYPE,
        "serviceRequestTypeId",
        {organizationPartyId, requestTypeEnumId: p.requestTypeEnumId},
        {
            serviceEnabled,
            customerLabel: text(p.customerLabel),
            defaultCategoryId: p.defaultCategoryId || null,
            defaultPriority: blank(p.defaultPriority) ? null : Number(p.defaultPriority),
            caseWorkflowId: p.caseWorkflowId || null,
            publicAvailable: yn(p.publicAvailable)
        },
        p
    )
    return {serviceRequestTypeId}
}
function requireWorkflow(caseWorkflowId) {
    if (one("moqui.basic.Enumeration", {enumId: caseWorkflowId})?.enumTypeId !== "CaseWorkflow")
        denied("WORKFLOW_UNKNOWN", (caseWorkflowId || "") + " is not a case workflow")
}
function saveMapping(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const caseWorkflowId = p.caseWorkflowId || defaultWorkflow
    requireWorkflow(caseWorkflowId)
    if (one("moqui.basic.StatusItem", {statusId: p.statusId})?.statusTypeId !== "Request")
        denied("STATUS_UNKNOWN", (p.statusId || "") + " is not a request status")
    if (one("moqui.basic.Enumeration", {enumId: p.statusCategoryEnumId})?.enumTypeId !== "CaseStatusCategory")
        denied("CATEGORY_UNKNOWN", "Choose the status category")
    if (!text(p.agentLabel) || !text(p.customerLabel)) denied("LABEL_REQUIRED", "A status needs its agent and customer labels")
    const caseStatusMappingId = startRow(
        MAPPING,
        "caseStatusMappingId",
        {caseWorkflowId, statusId: p.statusId},
        {
            agentLabel: text(p.agentLabel),
            customerLabel: text(p.customerLabel),
            statusCategoryEnumId: p.statusCategoryEnumId,
            reasonRequired: yn(p.reasonRequired),
            sequenceNum: blank(p.sequenceNum) ? null : Number(p.sequenceNum)
        },
        p
    )
    return {caseStatusMappingId}
}
// save#CaseWorkflow: a workflow (a new one by its description) and one of its moves, started or ended by date.
function saveWorkflow(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    let caseWorkflowId = text(p.caseWorkflowId)
    if (!caseWorkflowId) {
        if (!text(p.description)) denied("NAME_REQUIRED", "A workflow needs a name")
        caseWorkflowId = "Cwf" + ec.entity.sequencedIdPrimary("moqui.basic.Enumeration", null, null)
        call("create#moqui.basic.Enumeration", {
            enumId: caseWorkflowId,
            enumTypeId: "CaseWorkflow",
            description: text(p.description)
        })
    }
    requireWorkflow(caseWorkflowId)
    if (!p.statusId || !p.toStatusId) return {caseWorkflowId, caseTransitionId: null}
    if (!one("moqui.basic.StatusFlowTransition", {statusFlowId: "Default", statusId: p.statusId, toStatusId: p.toStatusId}))
        denied("STATUS_FLOW_MISSING", "A request does not move from " + p.statusId + " to " + p.toStatusId)
    const keys = {caseWorkflowId, statusId: p.statusId, toStatusId: p.toStatusId}
    if (p.end === true || p.end === "Y" || p.end === "true") {
        for (const row of currentRows(TRANSITION, keys)) {
            row.set("thruDate", p.fromDate || now())
            row.update()
        }
        return {caseWorkflowId, caseTransitionId: null}
    }
    const caseTransitionId = startRow(
        TRANSITION,
        "caseTransitionId",
        keys,
        {
            resolutionRequired: yn(p.resolutionRequired),
            reasonRequired: yn(p.reasonRequired),
            manageRequired: yn(p.manageRequired),
            notifyCustomer: yn(p.notifyCustomer)
        },
        p
    )
    return {caseWorkflowId, caseTransitionId}
}
function saveDefaults(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    if (p.defaultCategoryId) {
        const queue = queueOf(p.defaultCategoryId)
        if (!queue || queue.organizationPartyId !== organizationPartyId)
            denied("QUEUE_UNAVAILABLE", "The default queue must be a service queue of the organization")
    }
    if (p.caseWorkflowId) requireWorkflow(p.caseWorkflowId)
    const days = blank(p.reopenWindowDays) ? 14 : Number(p.reopenWindowDays)
    if (!(days >= 0 && days <= 365)) denied("DAYS_INVALID", "The reopen window is 0 to 365 days")
    const servicePolicyId = startRow(
        POLICY,
        "servicePolicyId",
        {organizationPartyId},
        {
            defaultCategoryId: p.defaultCategoryId || null,
            caseWorkflowId: p.caseWorkflowId || defaultWorkflow,
            unknownSenderEnumId: p.unknownSenderEnumId || "SusReview",
            reopenWindowDays: days,
            autoCloseDays: blank(p.autoCloseDays) ? null : Number(p.autoCloseDays),
            resolutionRequired: yn(p.resolutionRequired, "Y"),
            customerImmediateCancel: yn(p.customerImmediateCancel),
            fallbackOwnerPartyId: p.fallbackOwnerPartyId || null
        },
        p
    )
    return {servicePolicyId}
}
function saveTeam(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    const organizationPartyId = requireOrganization(p.organizationPartyId)
    const name = text(p.teamName)
    if (!name) denied("NAME_REQUIRED", "A team needs a name")
    if (p.teamPartyId) {
        requireTeam(p.teamPartyId, organizationPartyId)
        call("update#mantle.party.Organization", {partyId: p.teamPartyId, organizationName: name})
        assignment().syncTeamGroup(p.teamPartyId)
        return {teamPartyId: p.teamPartyId}
    }
    const teamPartyId = call("create#mantle.party.Party", {
        partyTypeEnumId: "PtyOrganization",
        ownerPartyId: organizationPartyId
    }).partyId
    call("create#mantle.party.Organization", {partyId: teamPartyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId: teamPartyId, roleTypeId: "OrgTeam"})
    // P5: the team's user group, its saved replies' audience (F3)
    assignment().syncTeamGroup(teamPartyId)
    return {teamPartyId}
}
// save#ServiceTeamMember: an agent (Agent) or a team manager (Manager) joins or leaves a team, by a dated
// PartyRelationship; a manager changes only a team they manage, an administrator any of the organization's.
function saveMember(p) {
    requirePermission("SUPPORT_CASE_MANAGE")
    const team = one("mantle.party.Party", {partyId: p.teamPartyId})
    const organizationPartyId = requireOrganization(team?.ownerPartyId)
    requireTeam(p.teamPartyId, organizationPartyId)
    const me = ec.user.userAccount?.partyId
    const manages = teamMembers(p.teamPartyId).some(row => row.fromPartyId === me && row.fromRoleTypeId === "Manager")
    if (!manages && !access.has("SUPPORT_POLICY_EDIT"))
        denied("PERMISSION_DENIED", "Only a manager of the team or the service administrator changes its members")
    const person = p.partyId ? one("mantle.party.Party", {partyId: p.partyId}) : null
    // a member works for the team's organization (a customer's contact or another organization's agent never joins, and
    // so never sees a restricted queue's cases through Mantle's record visibility)
    const end = p.end === true || p.end === "Y" || p.end === "true"
    if (
        !person ||
        person.partyTypeEnumId !== "PtyPerson" ||
        (!end && (person.disabled === "Y" || !organizationsOf(p.partyId).includes(organizationPartyId)))
    )
        denied("MEMBER_UNAVAILABLE", (p.partyId || "") + " is not someone who can join a team")
    const roleTypeId = p.roleTypeId === "Manager" ? "Manager" : "Agent"
    const live = teamMembers(p.teamPartyId).filter(row => row.fromPartyId === p.partyId)
    // P5: a participation change of a current member keeps the membership as it is
    const participationOnly = !end && p.participation === true && live.length > 0
    for (const row of live)
        if (end || (!participationOnly && row.fromRoleTypeId !== roleTypeId)) {
            row.set("thruDate", p.fromDate || now())
            row.update()
        }
    if (end) {
        // P5: the participation ends with the membership, and the team's user group follows
        assignment().endParticipation(p.teamPartyId, p.partyId, p.fromDate || now())
        assignment().syncTeamGroup(p.teamPartyId)
        return {partyRelationshipId: null, participationId: null}
    }
    let partyRelationshipId = null
    if (!participationOnly && !live.some(row => row.fromRoleTypeId === roleTypeId)) {
        for (const roleType of [roleTypeId])
            if (!one("mantle.party.PartyRole", {partyId: p.partyId, roleTypeId: roleType}))
                call("create#mantle.party.PartyRole", {partyId: p.partyId, roleTypeId: roleType})
        partyRelationshipId = call("create#" + RELATIONSHIP, {
            relationshipTypeEnumId: teamRelationship,
            fromPartyId: p.partyId,
            fromRoleTypeId: roleTypeId,
            toPartyId: p.teamPartyId,
            toRoleTypeId: "OrgTeam",
            fromDate: p.fromDate || now()
        }).partyRelationshipId
    }
    // P5: the participation (eligible, the most open cases, the substitute, the calendar) from its date, when given
    const participationId =
        p.participation === true ? assignment().saveParticipation(p, p.teamPartyId, organizationPartyId) : null
    assignment().syncTeamGroup(p.teamPartyId)
    return {partyRelationshipId, participationId}
}

// ===== rules on other paths =====
// The customer's reply on a case tells its assignee (SupportCaseCustomerReply): a message filed on the case from its
// customer, its contact, or a contact of the customer organization.
function customerReply(p) {
    const profile = one(PROFILE, {requestId: p.requestId})
    if (!profile) return {}
    const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: p.communicationEventId})
    if (!event?.fromPartyId || event.communicationEventTypeId === "Comment") return {}
    // P8: a message a merge or split referenced on this case is the source's, no new reply
    if (
        find("mantle.request.support.CaseRelationItem", {
            toRequestId: p.requestId,
            communicationEventId: p.communicationEventId
        }).count() > 0
    )
        return {}
    // an automatic message (an autoresponder's, filed on its case only: P6) tells no one
    const purpose = purposeEnumId =>
        one("mantle.party.communication.CommunicationEventPurpose", {
            communicationEventId: event.communicationEventId,
            purposeEnumId
        })
    if (purpose("CpAcknowledgement") || purpose("CpServiceInternal")) return {}
    const parties = partiesOf(p.requestId)
    const customerPartyId = roleParty(parties, "Customer")
    const fromCustomer =
        event.fromPartyId === customerPartyId ||
        event.fromPartyId === roleParty(parties, "Reporter") ||
        currentRows(RELATIONSHIP, {fromPartyId: event.fromPartyId, toPartyId: customerPartyId}).length > 0
    const assigneePartyId = roleParty(parties, "Assignee")
    if (!fromCustomer || !assigneePartyId || isInternal(event.fromPartyId)) return {}
    const userIds = rows("moqui.security.UserAccount", {partyId: assigneePartyId})
        .map(row => row.userId)
        .filter(Boolean)
    if (!userIds.length) return {}
    const request = one(REQUEST, {requestId: p.requestId})
    const nm = ec
        .makeNotificationMessage()
        .topic("SupportCaseCustomerReply")
        .userIds(userIds)
        .message({
            requestId: p.requestId,
            requestName: request?.requestName || p.requestId,
            customerName: partyName(customerPartyId),
            fromName: partyName(event.fromPartyId),
            recordEntityName: REQUEST,
            recordId: p.requestId
        })
    if (typeof nm.record === "function") nm.record(REQUEST, p.requestId)
    nm.send()
    return {userIds}
}
// update#Request's guard (F64): on a case, a due date (SlaServices', P4), a resolution or a close is changed only through
// transition#Case; any other path, mr-marble's EditRequest among them, is refused naming the case (CASE_MANAGED).
function guardUpdate(p) {
    const changesDue = "responseRequiredDate" in p.fields
    const changesResolution = !blank(p.fields.requestResolutionEnumId)
    const closes = closedStatuses.includes(p.fields.statusId)
    if (!changesDue && !changesResolution && !closes) return {}
    if (!one(PROFILE, {requestId: p.requestId})) return {}
    const request = one(REQUEST, {requestId: p.requestId})
    const sameDue = Number(ms(request?.responseRequiredDate) || 0) === Number(ms(p.fields.responseRequiredDate) || 0)
    const sameResolution = !changesResolution || p.fields.requestResolutionEnumId === request?.requestResolutionEnumId
    const sameStatus = !closes || p.fields.statusId === request?.statusId
    if ((!changesDue || sameDue) && sameResolution && sameStatus) return {}
    denied(
        "CASE_MANAGED",
        "Request " + p.requestId + " is a support case: its due date, resolution and close are set in Customer Service"
    )
}
// Whether a case is in a restricted queue, and so seen only by its team (record visibility, Customer Service's scope).
function restrictedTeam(requestId, requestCategoryId) {
    if (!requestCategoryId) return null
    const queue = currentRow(QUEUE, {requestCategoryId})
    if (queue?.visibilityEnumId !== "SqvRestricted") return null
    return one(PROFILE, {requestId}) ? queue.responsibleTeamPartyId || "_NA_" : null
}

const operations = {
    ensure,
    state,
    mappings,
    create,
    update,
    transition,
    tags,
    saveQueue,
    saveType,
    saveMapping,
    saveWorkflow,
    saveDefaults,
    saveTeam,
    saveMember,
    customerReply,
    guardUpdate
}
;({
    // for the record visibility rule and Customer Service's reads
    restrictedTeam,
    isTeamMember,
    currentRows,
    queueOf,
    mappingFor,
    revisionOf,
    openStatuses,
    // P12: the dated save of Knowledge.js's sources
    startRow,
    // P6: Channels.js's intake (the rule's route, the profile, the parties and the checks)
    route,
    ensureCase: p => ensure(p),
    caseOf,
    policyOf,
    servedCustomer,
    customerSidesOf,
    organizationsOf,
    isInternal,
    partyName,
    requirePermission,
    requireOrganization,
    currentRow,
    // P5: for Assignment.js and SavedReplies.js
    teamMembers,
    checkAssignee,
    checkRevision,
    requireTeam,
    partiesOf,
    roleParty,
    transitionFor,
    // P8: CaseRelations.js (merge, split, follow-up, closing)
    refuseMerged,
    listOf,
    typeOf,
    assignParty: assign,
    transitionCase: transition,
    setTags: tags,
    updateCase: update,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown support case operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters)
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
