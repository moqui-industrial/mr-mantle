// What limits a search of the mantle index for the user, shared by the universal search (UniversalSearchServices.xml
// search#Universal) and Marble's general search (GeneralServices.xml search#MantleFiltered): the organization fields of each
// document type, the user's organization limit, and the clauses that show a type's records under it. CC0 plus patent grant.

// what shows a record of each document type under an organization limit: org fields holding one of the user's
// organizations, user fields holding the user's party, and party fields holding either; a type that is not here
// shows nothing, and null is not limited
// TODO: only current party rows (parties.partyThruDate empty or later than now) once the Postgres backend can
//     compare a date in a child list (it casts the stored text, which the feed writes as epoch millis)
const scopes = {
    MantleParty: {org: ["ownerPartyId"]},
    MantleProduct: {org: ["ownerPartyId"]},
    MantleFacility: {org: ["ownerPartyId"]},
    MantleAsset: {org: ["ownerPartyId"]},
    MantleOrder: {org: ["parts.vendorPartyId", "parts.customerPartyId"]},
    MantleInvoice: {org: ["fromPartyId", "toPartyId"]},
    MantlePayment: {org: ["fromPartyId", "toPartyId"]},
    MantleAcctgTrans: {org: ["organizationPartyId"]},
    MantleGlAccount: {org: ["organizationPartyIds"]},
    MantleShipment: {org: ["fromPartyId", "toPartyId"]},
    MantleProject: {party: ["ownerPartyId", "parties.partyId"]},
    MantleTask: {party: ["ownerPartyId", "parties.partyId"]},
    MantleEvent: {party: ["ownerPartyId", "parties.partyId"]},
    MantleRequest: {org: ["storeOrganizationPartyId", "facilityOwnerPartyId"], user: ["filedByPartyId"], party: ["parties.partyId"]},
    MantleCommunicationEvent: {user: ["fromPartyId", "toPartyId", "parties.partyId"]},
    MantleWikiPage: null
}
// a type's scope: its row of the table, {} (shows nothing under a limit) for a type not in it
const scopeOf = type => (Object.prototype.hasOwnProperty.call(scopes, type) ? scopes[type] : {})

// the user's organization limit, as get#RecordLinkInfo has it: every filter set on a party find is looked at (an
// authorization may carry MANTLE_PRIVATE_CONTACT and others beside the organization set); the organizations, or null for
// none
function organizationLimit() {
    if (ec.user.context.filterOrgIds === undefined)
        ec.service.sync().name("mantle.party.PartyServices.setup#UserOrganizationInfo").call()
    const filterSetIds = () =>
        new Set(Array.from(ec.artifactExecution.getFindFiltersForUser("mantle.party.Party") || []).map(filter => filter.entityFilterSetId))
    const activeOrgId = ec.user.context.activeOrgId || null
    const filterOrgIds = Array.from(ec.user.context.filterOrgIds || [])
    let filterSets = filterSetIds()
    if (filterSets.has("MANTLE_USER_ORG")) return filterOrgIds
    if (filterSets.has("MANTLE_ACTIVE_ORG")) return activeOrgId ? [activeOrgId] : filterOrgIds
    if (activeOrgId) return null
    // MANTLE_ACTIVE_ORG applies only with an active organization (its applyCond): whether the authorization names it is
    // asked with one in the user context for the moment
    const hadActive = "activeOrgId" in ec.user.context
    const oldActive = ec.user.context.activeOrgId
    ec.user.context.activeOrgId = "_NA_"
    try {
        filterSets = filterSetIds()
    } finally {
        if (hadActive) ec.user.context.activeOrgId = oldActive ?? null
        else delete ec.user.context.activeOrgId
    }
    return filterSets.has("MANTLE_ACTIVE_ORG") ? filterOrgIds : null
}

// the clauses that show a type's records under the limit, any one of them; none leaves the type out. extraClauses: more
// alternatives the caller has (the mailboxes the user reads, for a communication event)
function scopeClauses(type, scope, orgIds, userPartyId, extraClauses = []) {
    const orgValues = type === "MantleParty" ? orgIds.concat(["_NA_"]) : orgIds
    const partyValues = userPartyId ? orgIds.concat([userPartyId]) : orgIds
    const any = []
    if (orgValues.length) for (const name of scope.org || []) any.push({field: {name, op: "in", values: orgValues}})
    if (userPartyId) for (const name of scope.user || []) any.push({field: {name, op: "eq", value: userPartyId}})
    if (partyValues.length) for (const name of scope.party || []) any.push({field: {name, op: "in", values: partyValues}})
    return any.concat(extraClauses)
}

// a party that is a personal contact (privateOwnerUserId) only for its owner, with or without a limit
function privateClause() {
    const notPrivate = {field: {name: "privateOwnerUserId", op: "exists", negate: true}}
    return ec.user.userId
        ? {bool: {any: [notPrivate, {field: {name: "privateOwnerUserId", op: "eq", value: ec.user.userId}}]}}
        : notPrivate
}

// Whether a hit's record is kept from the user inside their organizations, by the record's own rule as get#RecordLinkInfo
// has it: a confidential HR case and a message filed on one (PeopleCases.js), a person who is only an applicant the user does
// not recruit (Recruiting.js hiddenApplicants), a protected People task (Checklists.js hiddenTaskIds), the task of a
// confidential Smithy issue (check#TaskHidden), and a maintenance work order or request outside the user's Maintenance reach
// (MaintenanceAccess.js). current is the hit's primary entity row. search#Universal and Marble's search#MantleFiltered ask
// it of every hit (SEC-DAT-98).
function hitHidden(documentId, current, userPartyId) {
    if (!current) return true
    const script = location => ec.resource.script("component://mr-mantle/service/mantle/" + location)
    if (documentId === "MantleRequest" && current.requestTypeEnumId === "RqtHrCase") return true
    if (
        documentId === "MantleCommunicationEvent" &&
        script("request/PeopleCases.js").caseEvents([current.communicationEventId])[current.communicationEventId]
    )
        return true
    if (
        documentId === "MantleParty" &&
        current.partyTypeEnumId === "PtyPerson" &&
        script("humanres/Recruiting.js").hiddenApplicants([current.partyId]).length
    )
        return true
    if (documentId === "MantleTask") {
        if (
            script("request/PeopleCases.js").protectedTaskIds([current.workEffortId]).length > 0 &&
            script("humanres/Checklists.js").hiddenTaskIds([current.workEffortId], userPartyId).length > 0
        )
            return true
        const smithy = ec.service
            .sync()
            .name("mantle.smithy.SmithyIssueServices.check#TaskHidden")
            .parameter("workEffortId", current.workEffortId)
            .disableAuthz()
            .call()
        if (smithy?.hidden !== false) return true
        if (script("work/MaintenanceAccess.js").workHidden(current.workEffortId, userPartyId)) return true
    }
    if (
        documentId === "MantleRequest" &&
        current.requestTypeEnumId === "RqtMaintenance" &&
        script("work/MaintenanceAccess.js").requestHidden(current, userPartyId)
    )
        return true
    return false
}

// Whether a finance hit is kept from the user by its own read, as get#RecordLinkInfo has it: an invoice and a payment of their
// side (a receivable reader does not read a bill; InvoiceWorkflowLib.js readable, PaymentWorkflow.js paymentScope), and a ledger
// transaction of payroll origin only for a payroll reader (PayrollOrigin.js). memo: the invoice reads of one search.
// search#Universal and Marble's search#MantleFiltered ask it (IronStone Accounting P21, F431, F438; SEC-DAT-98).
function financeHidden(documentId, current, memo = {}) {
    if (!current) return true
    const account = "component://mr-mantle/service/mantle/account/"
    if (documentId === "MantleInvoice")
        return !ec.resource.script(account + "InvoiceWorkflowLib.js").readable(current.invoiceId, memo)
    if (documentId === "MantlePayment") {
        ec.message.pushErrors()
        try {
            ec.resource.script(account + "PaymentWorkflow.js").paymentScope({paymentId: current.paymentId})
            return ec.message.hasError()
        } catch (error) {
            return true
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    if (documentId === "MantleAcctgTrans" && current.payrollOrigin === "Y")
        return !ec.resource.script(account + "PayrollOrigin.js").canRead()
    return false
}

// A search page with the hits the caller keeps: keep(doc) answers whether a hit stays. The count is the page's (what was
// skipped before it and what it keeps) unless the page holds the whole match, so a total never counts a hidden hit, and one
// more page is offered after a full page (SEC-DAT-98 review). out: search#DataDocuments' document list fields.
function keepPage(out, keep) {
    const before = Array.from(out.documentList || [])
    const pageIndex = Number(out.documentListPageIndex || 0)
    const pageSize = Number(out.documentListPageSize || before.length || 20)
    const total = Number(out.documentListCount || 0)
    const kept = before.filter(keep)
    const whole = pageIndex === 0 && before.length >= total
    const count = whole ? kept.length : pageIndex * pageSize + kept.length
    const rangeLow = kept.length ? pageIndex * pageSize + 1 : 0
    return {
        documentList: kept,
        documentListCount: count,
        documentListPageIndex: pageIndex,
        documentListPageSize: pageSize,
        documentListPageMaxIndex: whole || before.length < pageSize ? pageIndex : pageIndex + 1,
        documentListPageRangeLow: rangeLow,
        documentListPageRangeHigh: kept.length ? rangeLow + kept.length - 1 : 0
    }
}

;({scopes, scopeOf, organizationLimit, scopeClauses, privateClause, hitHidden, financeHidden, keepPage})
