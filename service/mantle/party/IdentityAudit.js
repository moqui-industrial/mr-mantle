// The audit source of the records that belong to an internal organization, mantle.party.IdentityServices.find#IdentityChanges
// (mr-boss plan/design-admin.md §12 AuditChanges; impl-admin P17 and §4, the decisions of Nov 7): the framework's
// org.moqui.admin.AuditServices knows no organization, so a change of a user's account, a group membership, an organization
// membership, an invitation or a lifecycle operation is found here, within the caller's organizations, and answered as the
// ids of its audit rows only: the framework reads and masks the rows by its registered projections.
//
// Scope is not computed here. Each kind of record has a view that joins the audit log's rows back to an internal organization
// (entity/IdentityEntities.xml: an account's rows by the organizations its party works for now, a membership's by its member,
// the others by their own organization), and the find on it runs under the organization entity filters of the authorization
// the call runs under (Identity.js scopedFind: MANTLE_USER_ORG the caller's organizations, MANTLE_ACTIVE_ORG the active one
// or every one; nothing in scope when neither is named, but for an instance administrator). An account that works for no
// internal organization (a site identity, someone whose memberships all ended) is in no organization's scope: only an instance
// administrator with no organization active reads its changes, for whom the audit log's rows of these entities are read as
// they are, with no organization to join.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {denied} = lib
const access = lib.access
const identity = ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const VIEW = "ADMIN_AUDIT_VIEW"
const maxLimit = 2000
const text = value => String(value ?? "").trim()
// the view an entity's audit rows are found through: by what its key values are
const views = {
    "moqui.security.UserAccount": "mantle.party.AuditLogAccountOrganization",
    "moqui.security.UserGroupMember": "mantle.party.AuditLogMemberOrganization",
    "moqui.security.user.NotificationTopicUser": "mantle.party.AuditLogMemberOrganization",
    "mantle.party.PartyRelationship": "mantle.party.AuditLogRelationshipOrganization",
    "mantle.party.UserInvitation": "mantle.party.AuditLogInvitationOrganization",
    "mantle.party.UserLifecycleOperation": "mantle.party.AuditLogLifecycleOrganization",
    "mantle.party.UserLifecycleOperationStep": "mantle.party.AuditLogLifecycleOrganization",
    "mantle.party.Party": "mantle.party.AuditLogOrganization",
    "mantle.account.method.PaymentGatewayOrganization": "mantle.party.AuditLogOrganization",
    // a record that is its maker's own doing (an export, an import): by the organizations of who made the change
    "moqui.server.TransferBatch": "mantle.party.AuditLogActorOrganization"
}
const LOG = "moqui.entity.EntityAuditLog"

// The fields asked for of each entity this source knows, by view: {view: Map(entityName, fieldNames or null for every field)}.
function wanted(projectionList) {
    const byView = new Map()
    for (const projection of Array.from(projectionList || [])) {
        const entityName = text(projection?.changedEntityName)
        const fieldName = text(projection?.changedFieldName)
        if (!Object.hasOwn(views, entityName) || !fieldName) continue
        const view = views[entityName]
        if (!byView.has(view)) byView.set(view, new Map())
        const entities = byView.get(view)
        if (fieldName === "*") entities.set(entityName, null)
        else if (entities.get(entityName) !== null) entities.set(entityName, (entities.get(entityName) || []).concat([fieldName]))
    }
    return byView
}
// A view's audit rows of the entities and fields asked for, narrowed by the caller's filters, under the caller's organization
// filters; null when nothing is in scope.
function scoped(view, entities, p) {
    const found = view === LOG ? ec.entity.find(LOG).disableAuthz() : identity.scopedFind(view)
    if (!found) return null
    const factory = ec.entity.conditionFactory
    found.condition(
        factory.makeCondition(
            Array.from(entities.entries()).map(([entityName, fieldNames]) =>
                fieldNames
                    ? factory.makeCondition([
                          factory.makeCondition("changedEntityName", "equals", entityName),
                          factory.makeCondition("changedFieldName", "in", fieldNames)
                      ])
                    : factory.makeCondition("changedEntityName", "equals", entityName)
            ),
            "or"
        )
    )
    if (text(p.changedByUserId)) found.condition("changedByUserId", text(p.changedByUserId))
    else if (p.actorOnly === true) found.condition("changedByUserId", "not-equals", null)
    if (text(p.visitId)) found.condition("changedInVisitId", text(p.visitId))
    if (text(p.recordKey))
        found.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("pkPrimaryValue", "equals", text(p.recordKey)),
                    factory.makeCondition("pkSecondaryValue", "equals", text(p.recordKey))
                ],
                "or"
            )
        )
    if (p.fromDate != null && p.fromDate !== "") found.condition("changedDate", "greater-equals", new Date(Number(p.fromDate)))
    if (p.thruDate != null && p.thruDate !== "") found.condition("changedDate", "less", new Date(Number(p.thruDate)))
    // an account of two organizations in scope is one audit row: the row's own fields only, distinct
    return found.selectField("auditHistorySeqId").selectField("changedDate").distinct(true)
}
function findIdentityChanges(p) {
    if (!ec.user.userId) denied("SIGN_IN", "Sign in to read the audit log")
    if (!access.has(VIEW)) denied("PERMISSION_DENIED", VIEW + " is required")
    const limit = Math.min(Math.max(Number(p.limit) || 50, 1), maxLimit)
    let found = []
    let changeCount = 0
    let byView = wanted(p.projectionList)
    // an instance administrator with no organization active reads every organization's, and the records of none: the audit
    // log itself, for the entities asked for (Identity.js scope: all)
    if (byView.size && identity.scope().all && !ec.user.context.activeOrgId) {
        const entities = new Map()
        for (const found of byView.values()) for (const [entityName, fieldNames] of found) entities.set(entityName, fieldNames)
        byView = new Map([[LOG, entities]])
    }
    for (const [view, entities] of byView) {
        const count = scoped(view, entities, p)
        if (!count) continue
        changeCount += Number(count.count())
        found = found.concat(
            Array.from(scoped(view, entities, p).orderBy("-changedDate,-auditHistorySeqId").limit(limit).list()).map(row => ({
                auditHistorySeqId: String(row.auditHistorySeqId),
                changedDate: row.changedDate == null ? 0 : new Date(row.changedDate).getTime()
            }))
        )
    }
    found.sort(
        (a, b) =>
            b.changedDate - a.changedDate || b.auditHistorySeqId.localeCompare(a.auditHistorySeqId, undefined, {numeric: true})
    )
    return {auditIdList: found.slice(0, limit).map(row => row.auditHistorySeqId), changeCount}
}

const operations = {findIdentityChanges}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown identity audit operation " + op)
        return operations[op](parameters)
    }
})
