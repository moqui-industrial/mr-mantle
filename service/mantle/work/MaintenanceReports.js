// Maintenance's work status report (IronStone Maintenance design §8 WorkStatusReport, §13.2 MaintenanceReportServices;
// impl-maintenance P17): what was opened, completed and cancelled in a period and what stood open at its end, over execution
// roots only (a work order's root WorkEffort and its MaintenanceWorkOrder row; procedures, which are templates, and process steps,
// which have no row, are never counted). A maintenance reader's (MAINTENANCE_VIEW) of the organizations of their scope; a
// technician's assigned view reads none of it.
//
// - The period runs from fromDate (30 days before the as-of time unless given) to the as-of time (thruDate, now unless given).
// - A root's history is its status audit (WorkEffort.statusId is audit logged on create and on every change). Its status at a
//   moment is the last change at or before it; a root with no history (loaded data) stands as it is now and counts no opening.
// - Opened: created in the period. Completed: first completed (Complete or Closed) in the period and still complete at the as-of
//   time, so an order completed, reopened and completed again counts once, and a completion reopened and still open is backlog,
//   not a completion (corrections applied). Cancelled: cancelled in the period and still cancelled at the as-of time.
// - Backlog: open (in planning, approved, in progress or on hold) at the as-of time. Overdue: backlog past its required
//   completion (estimatedCompletionDate), never work with no due date. Unassigned: backlog with no technician assigned at the
//   as-of time.
// - Grouped by state at the as-of time, team, resource (the equipment or facility), source or kind; each total opens its rows.
// - At most rootCap roots are read (capped says so). No cost, rate or amount.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {find, denied, ms} = lib

const ORDER_VIEW = "mantle.work.maintenance.MaintenanceWorkOrderDetail"
const PARTY = "mantle.work.effort.WorkEffortParty"
const FACILITY = "mantle.facility.Facility"
const ASSET = "mantle.product.asset.Asset"
const AUDIT = "moqui.entity.EntityAuditLog"
const WORK = "mantle.work.effort.WorkEffort"

const openStatuses = ["WeInPlanning", "WeApproved", "WeInProgress", "WeOnHold"]
const completeStatuses = ["WeComplete", "WeClosed"]
const cancelled = "WeCancelled"
const teamRole = "OrgTeam"
const assigneeRole = "Assignee"
const inactiveParty = ["WeptDeclined", "WeptUnassigned"]
const rootCap = 2000
const chunkSize = 500
const facilityDepth = 12
const dayMs = 24 * 60 * 60 * 1000
const defaultDays = 30

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const ids = list => Array.from(new Set(list.filter(Boolean)))
const factory = () => ec.entity.conditionFactory
const chunks = list => {
    const out = []
    for (let index = 0; index < list.length; index += chunkSize) out.push(list.slice(index, index + chunkSize))
    return out
}

// The measures, in the order the report shows them.
const measures = [
    {key: "opened", label: "Opened"},
    {key: "completed", label: "Completed"},
    {key: "cancelled", label: "Cancelled"},
    {key: "backlog", label: "Backlog"},
    {key: "overdue", label: "Overdue"},
    {key: "unassigned", label: "Unassigned"}
]
const groupings = ["state", "team", "resource", "source", "kind"]

// ===== scope =====
// A maintenance reader's scope (MAINTENANCE_VIEW), listing as People's rule has it (F83): a holder of every organization who has
// chosen an active internal organization reads that organization's work.
function readScope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read maintenance reports")
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.view) denied("PERMISSION_DENIED", "Maintenance view is required")
    if (userScope.organizationPartyIds != null) return userScope
    const info = ec.service.sync().name("mantle.party.PartyServices.get#PartyOrganizationInfo").disableAuthz().call() || {}
    const active = userScope.activeOrganizationPartyId || info.activeOrgId || null
    if (!active || !find("mantle.party.PartyRole", {partyId: active, roleTypeId: "OrgInternal"}).count()) return userScope
    return Object.assign({}, userScope, {organizationPartyIds: [active]})
}
// The facilities inside one (to facilityDepth levels), so a building's report counts its rooms' work.
function subtreeIds(facilityId) {
    const found = new Set([facilityId])
    let frontier = [facilityId]
    for (let depth = 0; frontier.length && depth < facilityDepth; depth++) {
        const children = Array.from(find(FACILITY).condition("parentFacilityId", "in", frontier).selectField("facilityId").list())
            .map(row => row.facilityId)
            .filter(id => !found.has(id))
        for (const id of children) found.add(id)
        frontier = children
    }
    return Array.from(found)
}

// ===== the roots and their history =====
// The roots that may count: of the scope and the filters, open now or changed since the period began (a root closed before it
// and untouched since counts in no measure). Templates are left out here; steps have no MaintenanceWorkOrder row.
function candidateRoots(userScope, p, from) {
    let query = find(ORDER_VIEW).condition(
        factory().makeCondition(
            [factory().makeCondition("isTemplate", "is-null", null), factory().makeCondition("isTemplate", "equals", "N")],
            "or"
        )
    )
    if (userScope.organizationPartyIds != null)
        query = query.condition("ownerPartyId", "in", Array.from(userScope.organizationPartyIds).concat(["_NA_"]))
    const organizationId = text(p.organizationPartyId)
    if (organizationId) query = query.condition("ownerPartyId", maintenanceAccess.requireOrganization(userScope, organizationId))
    if (text(p.facilityId)) query = query.condition("facilityId", "in", subtreeIds(text(p.facilityId)))
    if (text(p.assetId)) query = query.condition("assetId", text(p.assetId))
    if (text(p.maintenanceKindEnumId)) query = query.condition("maintenanceKindEnumId", text(p.maintenanceKindEnumId))
    if (text(p.sourceEnumId)) query = query.condition("sourceEnumId", text(p.sourceEnumId))
    query = query.condition(
        factory().makeCondition(
            [
                factory().makeCondition("statusId", "in", openStatuses),
                factory().makeCondition("lastUpdatedStamp", "greater-equals", new Date(from))
            ],
            "or"
        )
    )
    const rows = Array.from(
        query
            .selectField(
                "workEffortId,workEffortName,statusId,ownerPartyId,facilityId,assetId,maintenanceKindEnumId,sourceEnumId," +
                    "estimatedStartDate,estimatedCompletionDate,actualCompletionDate"
            )
            .orderBy("workEffortId")
            .limit(rootCap + 1)
            .list()
    )
    return {roots: rows.slice(0, rootCap), capped: rows.length > rootCap}
}
// Each root's status changes in order. Changes stamped at the same moment (a create approved on create) are put in the order
// their values chain (each one's old value the previous one's new value).
function statusHistory(rootIds) {
    const byRoot = new Map()
    for (const chunk of chunks(rootIds))
        for (const row of Array.from(
            find(AUDIT, {changedEntityName: WORK, changedFieldName: "statusId"})
                .condition("pkPrimaryValue", "in", chunk)
                .selectField("pkPrimaryValue,oldValueText,newValueText,changedDate")
                .list()
        )) {
            const list = byRoot.get(row.pkPrimaryValue) || []
            list.push({at: ms(row.changedDate), from: row.oldValueText || null, to: row.newValueText || null})
            byRoot.set(row.pkPrimaryValue, list)
        }
    for (const [rootId, list] of byRoot) byRoot.set(rootId, chained(list))
    return byRoot
}
function chained(list) {
    list.sort((a, b) => a.at - b.at)
    const out = []
    let index = 0
    while (index < list.length) {
        let end = index
        while (end + 1 < list.length && list[end + 1].at === list[index].at) end++
        const tied = list.slice(index, end + 1)
        let previous = out.length ? out[out.length - 1].to : null
        while (tied.length) {
            const next = tied.findIndex(row => row.from === previous)
            const row = tied.splice(next >= 0 ? next : 0, 1)[0]
            out.push(row)
            previous = row.to
        }
        index = end + 1
    }
    return out
}
// A root's life from its history: its status at a moment, when it was created, first completed and last cancelled.
function lifeOf(root, history) {
    const changes = history || []
    const statusAt = at => {
        let status
        for (const change of changes) {
            if (change.at > at) break
            status = change.to
        }
        if (status !== undefined) return status
        // no history: as it is now; a history that starts later: what it was before, or nothing yet (created later)
        return changes.length ? changes[0].from : root.statusId
    }
    const createdAt = changes.length && changes[0].from == null ? changes[0].at : null
    const completion = changes.find(change => completeStatuses.includes(change.to) && !completeStatuses.includes(change.from))
    const completedAt = completion
        ? completion.at
        : !changes.length && completeStatuses.includes(root.statusId) && root.actualCompletionDate != null
          ? ms(root.actualCompletionDate)
          : null
    const cancellation = changes.filter(change => change.to === cancelled).pop()
    return {statusAt, createdAt, completedAt, cancelledAt: cancellation ? cancellation.at : null}
}
// The current team and technicians of each root at a moment.
function partiesAt(rootIds, at) {
    const out = new Map()
    for (const chunk of chunks(rootIds))
        for (const row of Array.from(
            find(PARTY)
                .condition("workEffortId", "in", chunk)
                .condition("roleTypeId", "in", [teamRole, assigneeRole])
                .selectField("workEffortId,partyId,roleTypeId,fromDate,thruDate,statusId")
                .list()
        )) {
            if (row.statusId && inactiveParty.includes(row.statusId)) continue
            if (row.fromDate != null && ms(row.fromDate) > at) continue
            if (row.thruDate != null && ms(row.thruDate) <= at) continue
            const entry = out.get(row.workEffortId) || {teams: [], assignees: []}
            ;(row.roleTypeId === teamRole ? entry.teams : entry.assignees).push(row.partyId)
            out.set(row.workEffortId, entry)
        }
    return out
}
// Names of the records a page of rows shows, read in one query each.
function namesOf(entityName, keyField, nameField, keys) {
    const wanted = ids(keys)
    const out = new Map()
    for (const chunk of chunks(wanted))
        for (const row of Array.from(
            find(entityName)
                .condition(keyField, "in", chunk)
                .selectField(keyField + "," + nameField)
                .list()
        ))
            out.set(row[keyField], row[nameField] || row[keyField])
    return out
}
function enumTexts(enumIds) {
    return namesOf("moqui.basic.Enumeration", "enumId", "description", enumIds)
}

// ===== get#MaintenanceStatusReport =====
function statusReport(p) {
    const userScope = readScope()
    const at = blank(p.thruDate) ? ms(ec.user.nowTimestamp) : ms(p.thruDate)
    const from = blank(p.fromDate) ? at - defaultDays * dayMs : ms(p.fromDate)
    if (!(from <= at)) denied("DATE_INVALID", "The period ends before it starts")
    const groupBy = text(p.groupBy) || "team"
    if (!groupings.includes(groupBy) && groupBy !== "none")
        denied("VALUE_INVALID", "Group by state, team, resource, source, kind or none")
    const measure = text(p.measure)
    if (measure && !measures.some(row => row.key === measure)) denied("VALUE_INVALID", "Unknown measure " + measure)

    const {roots, capped} = candidateRoots(userScope, p, from)
    const rootIds = roots.map(root => root.workEffortId)
    const history = statusHistory(rootIds)
    const parties = partiesAt(rootIds, at)
    const teamFilter = text(p.teamPartyId)

    const counted = []
    for (const root of roots) {
        const life = lifeOf(root, history.get(root.workEffortId))
        const state = life.statusAt(at)
        // not yet created at the as-of time
        if (state == null) continue
        const party = parties.get(root.workEffortId) || {teams: [], assignees: []}
        if (teamFilter && !party.teams.includes(teamFilter)) continue
        const inPeriod = moment => moment != null && moment >= from && moment <= at
        const backlog = openStatuses.includes(state)
        const flags = {
            opened: inPeriod(life.createdAt),
            completed: inPeriod(life.completedAt) && completeStatuses.includes(state),
            cancelled: state === cancelled && inPeriod(life.cancelledAt),
            backlog,
            overdue: backlog && root.estimatedCompletionDate != null && ms(root.estimatedCompletionDate) < at,
            unassigned: backlog && !party.assignees.length
        }
        if (!flags.opened && !flags.completed && !flags.cancelled && !flags.backlog) continue
        counted.push({root, life, state, party, flags})
    }

    // the names of what the rows show
    const statusNames = new Map(
        Array.from(find("moqui.basic.StatusItem", {statusTypeId: "WorkEffort"}).list()).map(row => [
            row.statusId,
            row.description
        ])
    )
    const enums = enumTexts(counted.flatMap(row => [row.root.sourceEnumId, row.root.maintenanceKindEnumId]))
    const assets = namesOf(
        ASSET,
        "assetId",
        "assetName",
        counted.map(row => row.root.assetId)
    )
    const facilities = namesOf(
        FACILITY,
        "facilityId",
        "facilityName",
        counted.map(row => row.root.facilityId)
    )
    const people = lib.partyNames(
        ids(counted.flatMap(row => row.party.teams.concat(row.party.assignees, [row.root.ownerPartyId])))
    )
    const groupOf = row => {
        if (groupBy === "state") return {key: row.state, text: statusNames.get(row.state) || row.state}
        if (groupBy === "team") {
            const teamId = row.party.teams[0] || null
            return {key: teamId || "_none", text: teamId ? people[teamId] || teamId : "No team"}
        }
        if (groupBy === "resource") {
            const key = row.root.assetId || row.root.facilityId || "_none"
            const name = row.root.assetId
                ? assets.get(row.root.assetId) || row.root.assetId
                : row.root.facilityId
                  ? facilities.get(row.root.facilityId) || row.root.facilityId
                  : "No resource"
            return {key, text: name}
        }
        if (groupBy === "source") {
            const key = row.root.sourceEnumId || "_none"
            return {key, text: row.root.sourceEnumId ? enums.get(key) || key : "No source"}
        }
        if (groupBy === "kind") {
            const key = row.root.maintenanceKindEnumId || "_none"
            return {key, text: row.root.maintenanceKindEnumId ? enums.get(key) || key : "No kind"}
        }
        return {key: "_all", text: "All work"}
    }

    const summary = {
        fromText: lib.dateText(new Date(from)),
        asOfText: lib.dateText(new Date(at)),
        rootCount: counted.length,
        capped,
        noteText:
            "Work orders only: procedures and their steps are not counted. A completion counts once, when first completed, " +
            "and only while the order is still complete." +
            (capped ? " Only the first " + rootCap + " work orders were read: narrow the options." : "")
    }
    for (const {key} of measures) summary[key + "Count"] = counted.filter(row => row.flags[key]).length

    const groups = new Map()
    const now = at
    const rows = counted.map(row => {
        const group = groupOf(row)
        const entry = groups.get(group.key) || {groupKey: group.key, groupText: group.text}
        for (const {key} of measures) entry[key + "Count"] = (entry[key + "Count"] || 0) + (row.flags[key] ? 1 : 0)
        groups.set(group.key, entry)
        const root = row.root
        const ageFrom = row.life.createdAt
        return {
            workEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            organizationPartyId: root.ownerPartyId,
            organizationName: people[root.ownerPartyId] || root.ownerPartyId,
            statusId: row.state,
            stateText: statusNames.get(row.state) || row.state,
            groupKey: group.key,
            groupText: group.text,
            targetName: root.assetId
                ? assets.get(root.assetId) || root.assetId
                : facilities.get(root.facilityId) || root.facilityId || "",
            teamName: row.party.teams.map(id => people[id] || id).join(", "),
            assigneeNames: row.party.assignees.map(id => people[id] || id).join(", "),
            sourceText: root.sourceEnumId ? enums.get(root.sourceEnumId) || root.sourceEnumId : "",
            kindText: root.maintenanceKindEnumId ? enums.get(root.maintenanceKindEnumId) || root.maintenanceKindEnumId : "",
            dueText: root.estimatedCompletionDate == null ? "" : lib.dateText(root.estimatedCompletionDate),
            windowText: [root.estimatedStartDate, root.estimatedCompletionDate]
                .map(value => (value == null ? "" : lib.dateText(value)))
                .filter(Boolean)
                .join(" – "),
            elapsedDays: row.flags.backlog && ageFrom != null ? Math.floor((now - ageFrom) / dayMs) : null,
            measuresText: measures
                .filter(({key}) => row.flags[key])
                .map(({label}) => label)
                .join(", "),
            ...row.flags
        }
    })
    const groupList = groupBy === "none" ? [] : Array.from(groups.values()).sort((a, b) => a.groupText.localeCompare(b.groupText))

    const groupKey = text(p.groupKey)
    const shown = rows
        .filter(row => (!measure || row[measure]) && (!groupKey || row.groupKey === groupKey))
        .sort(
            (a, b) =>
                a.groupText.localeCompare(b.groupText) ||
                Number(b.overdue) - Number(a.overdue) ||
                a.workEffortId.localeCompare(b.workEffortId)
        )
    return Object.assign(lib.pageList(shown, p, "statusList", {noLimitCap: rootCap}), {
        summary,
        groupList,
        measureList: measures.map(row => Object.assign({count: summary[row.key + "Count"]}, row))
    })
}

const operations = {statusReport}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance report operation " + op)
        return operations[op](parameters || {})
    }
})
