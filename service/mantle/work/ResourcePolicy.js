// Resource booking policy and availability (IronStone Maintenance design §7.1, Resources, ResourcePolicyDetail, Blackouts; MT-07;
// impl-maintenance P15, F15): the dated rules of a managed resource (ResourceBookingPolicy), its approvers (the BookingApprover rows
// of FacilityParty and AssetPartyAssignment), the one availability read of a resource (its bookings, planned blocks and actual
// outages) and the guard EventServices' booking calls for every resource.
//
// - guard (book#Resource, check#ResourceBookings, create#Event's equipment, the CalDAV event PUT through check#): with the resource
//   locked for a write, an outage or a planned block over the booking (a facility's own or one of the facilities above it) refuses
//   it for every resource and is never overridden (RESOURCE_UNAVAILABLE, a safe reason only); a resource with a policy in force is
//   managed: not bookable refuses (NOT_BOOKABLE), a booking longer than its maximum (DURATION_EXCEEDED) or starting past its horizon
//   (HORIZON_EXCEEDED) is refused, a recurring booking is checked over its whole range up to the horizon (a range past it refused,
//   HORIZON_EXCEEDED) and its own instances may not overlap (SERIES_OVERLAP), allowConflicts books over another booking only where
//   the policy allows an override, for a holder of RESOURCE_BOOKING_OVERRIDE, with a reason (OVERRIDE_DENIED), and approval follows
//   its mode: automatic, or by its approvers, none of them blocking (APPROVER_REQUIRED). A resource with no policy keeps the
//   approver fallback (EventServices). A conflict with an event the user may not see is named Busy, with no id or title.
// - availability (get#ResourceAvailability, get#FreeBusy, get#FullCalendarData): the intervals of a resource in a range, kept
//   apart: requested and assigned bookings, planned blocks and actual outages, each with a safe label.
// - the policy's services: find#BookableResources, get#, store# and preview#ResourceBookingPolicy and store#ResourceApprover, each
//   checking the maintenance scope (mantle/work/MaintenanceAccess.js): RESOURCE_POLICY_EDIT writes; RESOURCE_POLICY_VIEW or a
//   resource read reads; a booking approver (RESOURCE_BOOKING_VIEW_ASSIGNED) reads the resources they approve.
// Rows superseded by a correction count for nothing (F119).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const outages = () => ec.resource.script("component://mr-mantle/service/mantle/work/ResourceOutages.js")
const {find, one, call, denied, ms} = lib

const POLICY = "mantle.work.effort.ResourceBookingPolicy"
const OUTAGE = "mantle.work.effort.ResourceUnavailability"
const ASSET = "mantle.product.asset.Asset"
const FACILITY = "mantle.facility.Facility"
const dayMs = 24 * 60 * 60 * 1000
// a recurring booking of a resource with no horizon is checked this far ahead, and a range past it is refused
const defaultRecurringDays = 365
const instanceLimit = 500
const facilityDepth = 12
const stockTypes = ["AstTpInventory", "AstTpSupplies"]
const approvalModes = ["RbamAutomatic", "RbamApprovers"]
const requestedStatuses = ["WefRequested", "WeaaRequested"]
const assignedStatuses = ["WefAssigned", "WeaaAssigned"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yes = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const dayText = millis => ec.l10n.format(String(millis), "yyyy-MM-dd")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const ids = list => Array.from(new Set(list.filter(Boolean)))
const minutesText = minutes =>
    minutes % 60 === 0 ? minutes / 60 + (minutes === 60 ? " hour" : " hours") : minutes + " minutes"

// ===== the resource =====
// Exactly one resource, equipment (an asset that is not stock) or a facility, locked when asked.
function resourceOf(p, lock = false) {
    const assetId = text(p.assetId)
    const facilityId = text(p.facilityId)
    if (!!assetId === !!facilityId) denied("RESOURCE_REQUIRED", "Name the equipment or the facility, one of them")
    if (assetId) {
        const asset = find(ASSET, {assetId}).forUpdate(lock).one()
        if (!asset || stockTypes.includes(asset.assetTypeEnumId)) denied("RECORD_UNAVAILABLE", "Equipment " + assetId + " is not available")
        return {assetId, facilityId: null, row: asset, name: asset.assetName || assetId}
    }
    const facility = find(FACILITY, {facilityId}).forUpdate(lock).one()
    if (!facility) denied("RECORD_UNAVAILABLE", "Facility " + facilityId + " is not available")
    return {assetId: null, facilityId, row: facility, name: facility.facilityName || facilityId}
}
const keyOf = resource => (resource.assetId ? {assetId: resource.assetId} : {facilityId: resource.facilityId})
// A facility and those above it (a block of a building covers its rooms).
function facilityAndAbove(facilityId) {
    const found = []
    let id = facilityId
    for (let depth = 0; id && !found.includes(id) && depth < facilityDepth; depth++) {
        found.push(id)
        id = one(FACILITY, {facilityId: id})?.parentFacilityId || null
    }
    return found
}
const organizationOf = resource =>
    resource.assetId
        ? maintenanceAccess.assetOrganization(resource.assetId)
        : maintenanceAccess.facilityOrganization(resource.facilityId)

// ===== the policy and approvers =====
// The policy in force at a time (now by default), or null: the resource is then not managed.
function policyAt(resource, atMs = nowMs()) {
    const f = ec.entity.conditionFactory
    return (
        Array.from(
            find(POLICY, keyOf(resource))
                .condition("fromDate", "less-equals", new Date(atMs))
                .condition(f.makeCondition([f.makeCondition("thruDate", "is-null", null), f.makeCondition("thruDate", "greater", new Date(atMs))], "or"))
                .orderBy("-fromDate")
                .limit(1)
                .list()
        )[0] || null
    )
}
// The resource's approver rows (current, or every one not ended with all).
function approverRows(resource, all = false) {
    const query = resource.assetId
        ? find("mantle.product.asset.AssetPartyAssignment", {assetId: resource.assetId, roleTypeId: "BookingApprover"})
        : find("mantle.facility.FacilityParty", {facilityId: resource.facilityId, roleTypeId: "BookingApprover"})
    if (!all) return Array.from(query.conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list())
    const f = ec.entity.conditionFactory
    return Array.from(
        query
            .condition(f.makeCondition([f.makeCondition("thruDate", "is-null", null), f.makeCondition("thruDate", "greater", ec.user.nowTimestamp)], "or"))
            .orderBy("fromDate")
            .list()
    )
}
const approversOf = resource => ids(approverRows(resource).map(row => row.partyId))
function partyName(partyId) {
    const detail = partyId ? one("mantle.party.PartyDetail", {partyId}) : null
    return detail ? detail.organizationName || [detail.firstName, detail.lastName].filter(Boolean).join(" ") || partyId : partyId || ""
}
// The policy's rules in words, for a list or a header.
function policyText(policy, approverIds) {
    if (!policy) return approverIds.length ? "Not managed: approved by its approvers" : "Not managed: booked at once"
    if (policy.bookable === "N") return "Managed: not bookable"
    const parts = [
        policy.approvalModeEnumId === "RbamApprovers"
            ? approverIds.length
                ? "approved by " + approverIds.map(partyName).join(", ")
                : "approval required, no approver"
            : policy.approvalModeEnumId === "RbamAutomatic"
              ? "booked at once"
              : "approved by its approvers when it has any"
    ]
    if (policy.maximumDurationMinutes) parts.push("at most " + minutesText(Number(policy.maximumDurationMinutes)))
    if (policy.bookingHorizonDays) parts.push("up to " + policy.bookingHorizonDays + " days ahead")
    if (policy.softConflictOverride === "Y") parts.push("override with a reason")
    return "Managed: " + parts.join(", ")
}
function policyMap(policy) {
    if (!policy) return null
    return {
        resourceBookingPolicyId: policy.resourceBookingPolicyId,
        fromDate: policy.fromDate,
        fromText: dateText(policy.fromDate),
        thruDate: policy.thruDate || null,
        thruText: dateText(policy.thruDate),
        bookable: policy.bookable || "Y",
        approvalModeEnumId: policy.approvalModeEnumId || null,
        approvalModeText: enumText(policy.approvalModeEnumId) || "Its approvers when it has any",
        bookingHorizonDays: policy.bookingHorizonDays == null ? null : Number(policy.bookingHorizonDays),
        maximumDurationMinutes: policy.maximumDurationMinutes == null ? null : Number(policy.maximumDurationMinutes),
        timeZone: policy.timeZone || null,
        softConflictOverride: policy.softConflictOverride || "N",
        changeReason: policy.changeReason || "",
        revision: Number(policy.revision || 0),
        createdByName: policy.createdByUserId
            ? one("moqui.security.UserAccount", {userId: policy.createdByUserId})?.userFullName || policy.createdByUserId
            : ""
    }
}

// ===== availability =====
// The planned blocks and actual outages in force over a range, of the asset, or of the facility and those above it; an actual
// outage still open runs on.
function blocksOver(resource, fromMs, thruMs) {
    const f = ec.entity.conditionFactory
    let query = find(OUTAGE)
        .condition("supersededByUnavailabilityId", "is-null", null)
        .condition("fromDate", "less", new Date(thruMs))
        .condition(f.makeCondition([f.makeCondition("thruDate", "is-null", null), f.makeCondition("thruDate", "greater", new Date(fromMs))], "or"))
        .orderBy("fromDate")
    query = resource.assetId
        ? query.condition("assetId", resource.assetId)
        : query.condition("facilityId", "in", facilityAndAbove(resource.facilityId))
    // a withdrawn block (its end at its start) is no block
    return Array.from(query.list()).filter(row => row.thruDate == null || ms(row.thruDate) > ms(row.fromDate))
}
// A block's safe label: out of service, or the planned block's reason (never its description or source).
function blockLabel(row, resource) {
    const inherited = resource.facilityId && row.facilityId && row.facilityId !== resource.facilityId
    const where = inherited ? " (" + (one(FACILITY, {facilityId: row.facilityId})?.facilityName || row.facilityId) + ")" : ""
    if (row.unavailabilityKindEnumId === "RukPlanned") return "Not available: " + (enumText(row.unavailabilityReasonEnumId) || "planned block").toLowerCase() + where
    return "Out of service" + where
}
// Whether the user may see an event (organizer, attendee, a calendar's reader or visible to all), read once per event.
function eventVisibility() {
    const known = new Map()
    return workEffortId => {
        if (!workEffortId) return false
        if (!known.has(workEffortId)) {
            ec.message.pushErrors()
            let visible = false
            try {
                visible = !!ec.service
                    .sync()
                    .name("mantle.work.EventServices.check#EventAccess")
                    .parameters({workEffortId, permission: "none"})
                    .disableAuthz()
                    .call()?.canView
            } catch (error) {
                visible = false
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
            known.set(workEffortId, visible)
        }
        return known.get(workEffortId)
    }
}
// The bookings of the resource over a range, through get#FullCalendarData (not cancelled, not denied, recurrences expanded).
function bookingsOver(resource, fromMs, thruMs) {
    const out =
        ec.service
            .sync()
            .name("mantle.work.EventServices.get#FullCalendarData")
            .parameters(
                Object.assign({start: dayText(fromMs), end: dayText(thruMs), excludeCancelled: true, titleGString: "${workEffort.workEffortName || workEffort.workEffortId}"}, keyOf(resource))
            )
            .disableAuthz()
            .call() || {}
    return Array.from(out.eventList || [])
        .map(event => {
            const start = ms(event.startMillis)
            return Object.assign({}, event, {fromMs: start, thruMs: event.endMillis != null ? ms(event.endMillis) : start + 3600000})
        })
        .filter(event => event.fromMs < thruMs && event.thruMs > fromMs)
}
// get#ResourceAvailability: the intervals of the resource from fromDate to thruDate (two weeks from now by default, at most 92
// days), each {fromDate, thruDate, kind (assigned, requested, planned, actual), label (Busy for an event the user may not see),
// workEffortId (an event the user sees), resourceUnavailabilityId, hard}, and its policy in words.
function availability(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read a resource's availability")
    const resource = resourceOf(p)
    const fromMs = ms(p.fromDate) ?? nowMs()
    const thruMs = ms(p.thruDate) ?? fromMs + 14 * dayMs
    if (!(thruMs > fromMs) || thruMs - fromMs > 92 * dayMs) denied("INTERVAL_INVALID", "A range of at most 92 days, ending after it starts")
    const visible = eventVisibility()
    const intervals = []
    for (const event of bookingsOver(resource, fromMs, thruMs)) {
        if (p.excludeWorkEffortId && (event.workEffortId === p.excludeWorkEffortId || event.recurringEventId === p.excludeWorkEffortId)) continue
        const seen = visible(event.recurringEventId || event.workEffortId)
        intervals.push({
            fromMs: event.fromMs,
            thruMs: event.thruMs,
            kind: requestedStatuses.includes(event.bookingStatusId) ? "requested" : "assigned",
            label: seen ? event.title : "Busy",
            workEffortId: seen ? event.workEffortId : null,
            resourceUnavailabilityId: null,
            hard: false
        })
    }
    for (const row of blocksOver(resource, fromMs, thruMs))
        intervals.push({
            fromMs: ms(row.fromDate),
            thruMs: row.thruDate == null ? thruMs : ms(row.thruDate),
            kind: row.unavailabilityKindEnumId === "RukPlanned" ? "planned" : "actual",
            label: blockLabel(row, resource),
            workEffortId: null,
            resourceUnavailabilityId: row.resourceUnavailabilityId,
            open: row.thruDate == null,
            hard: true
        })
    intervals.sort((a, b) => a.fromMs - b.fromMs || a.thruMs - b.thruMs)
    const policy = policyAt(resource)
    const kindText = {assigned: "Booked", requested: "Pending approval", planned: "Blocked", actual: "Out of service"}
    return {
        resourceName: resource.name,
        managed: !!policy,
        policyText: policyText(policy, approversOf(resource)),
        intervalList: intervals.map(row =>
            Object.assign(row, {
                fromDate: new Date(row.fromMs),
                thruDate: new Date(row.thruMs),
                fromText: dateText(new Date(row.fromMs)),
                thruText: row.open ? "until restored" : dateText(new Date(row.thruMs)),
                kindText: kindText[row.kind]
            })
        )
    }
}
// The intervals get#FreeBusy and get#FullCalendarData add for a resource: its blocks only, with a safe label.
function unavailableOver(p) {
    const resource = resourceOf(p)
    const fromMs = ms(p.fromDate)
    const thruMs = ms(p.thruDate)
    return blocksOver(resource, fromMs, thruMs).map(row => ({
        assetId: resource.assetId,
        facilityId: resource.facilityId,
        fromDate: new Date(Math.max(fromMs, ms(row.fromDate))),
        thruDate: new Date(row.thruDate == null ? thruMs : Math.min(thruMs, ms(row.thruDate))),
        kind: row.unavailabilityKindEnumId === "RukPlanned" ? "planned" : "actual",
        status: row.unavailabilityKindEnumId === "RukPlanned" ? "blocked" : "down",
        label: blockLabel(row, resource)
    }))
}

// ===== the booking guard =====
// The instances a booking of a recurring event covers, within the bound: [[startMs, endMs]], and whether the range runs past it.
function seriesInstances(workEffortId, startMs, endMs, boundMs) {
    const row = one("mantle.work.effort.WorkEffort", {workEffortId})
    const recurring = !!row && (!!row.recurStartCron || !!one("mantle.work.effort.WorkEffortRecurrence", {workEffortId}))
    if (!recurring) return {instances: [[startMs, endMs]], pastBound: false, recurring: false}
    const out =
        ec.service
            .sync()
            .name("mantle.work.EventServices.get#EventInstances")
            .parameters({workEffortList: [row.getMap()], rangeStart: new Date(startMs), rangeEnd: new Date(boundMs + dayMs)})
            .disableAuthz()
            .call() || {}
    const length = endMs - startMs
    const all = Array.from(out.instanceList || [])
        .map(instance => [ms(instance.start), instance.end != null ? ms(instance.end) : ms(instance.start) + length])
        .filter(([from]) => from != null)
    return {
        instances: all.filter(([from]) => from <= boundMs).slice(0, instanceLimit),
        pastBound: all.some(([from]) => from > boundMs) || all.length > instanceLimit,
        recurring: true
    }
}
// The other bookings of the resource over the instances (the event's own series left out), each a conflict.
function conflictsOver(resource, instances, own) {
    if (!instances.length) return []
    const first = Math.min(...instances.map(([from]) => from))
    const last = Math.max(...instances.map(([, to]) => to))
    const conflicts = []
    for (const event of bookingsOver(resource, first, last)) {
        if (own.has(event.workEffortId) || own.has(event.recurringEventId)) continue
        if (instances.some(([from, to]) => event.fromMs < to && event.thruMs > from))
            conflicts.push({
                workEffortId: event.workEffortId,
                workEffortName: event.title,
                fromDate: new Date(event.fromMs),
                thruDate: new Date(event.thruMs),
                bookingStatusId: event.bookingStatusId ?? null
            })
    }
    return conflicts
}
// A conflict list with every event the user may not see named Busy, without its id or title.
function safeConflicts(conflicts) {
    const visible = eventVisibility()
    return Array.from(conflicts || []).map(conflict =>
        visible(conflict.workEffortId) ? conflict : Object.assign({}, conflict, {workEffortId: null, workEffortName: "Busy"})
    )
}
// guard: what a booking of the resource for the event at startMs to endMs is allowed. p: facilityId or assetId, workEffortId,
// startMs, endMs, conflicts (the caller's, for one interval), allowConflicts, overrideReason, lock (a write: the resource locked),
// own (the ids of the event and its series). Answers {managed, refusal {code, message, hard} or null, conflicts (safe), approval
// {requiresApproval, approverPartyIdList} or null (the caller's approver fallback), overridden}.
function guard(p) {
    const resource = resourceOf(p, !!p.lock)
    const startMs = ms(p.startMs)
    const endMs = ms(p.endMs)
    const own = new Set(Array.from(p.own || [p.workEffortId]).filter(Boolean))
    const refuse = (code, message, hard = false) => ({
        managed: !!policy,
        refusal: {code, message, hard},
        conflicts: [],
        approval: null,
        overridden: false
    })
    const policy = policyAt(resource)
    const now = nowMs()
    // a recurring booking of a managed resource is checked over its whole range within the bound
    const horizonDays = policy?.bookingHorizonDays == null ? null : Number(policy.bookingHorizonDays)
    const boundMs = now + (horizonDays ?? defaultRecurringDays) * dayMs
    const series = policy && p.workEffortId ? seriesInstances(p.workEffortId, startMs, endMs, boundMs) : null
    const instances = series ? series.instances : [[startMs, endMs]]
    // an outage or a planned block is never overridden, for any resource
    for (const [from, to] of instances) {
        const block = blocksOver(resource, from, to)[0]
        if (block)
            return refuse(
                "RESOURCE_UNAVAILABLE",
                resource.name + (block.unavailabilityKindEnumId === "RukPlanned" ? " is not available then (" + blockLabel(block, resource).replace(/^Not available: /, "") + ")" : " is out of service then"),
                true
            )
    }
    if (!policy) return {managed: false, refusal: null, conflicts: safeConflicts(p.conflicts), approval: null, overridden: false}
    if (policy.bookable === "N") return refuse("NOT_BOOKABLE", resource.name + " is not bookable now", true)
    const maximum = policy.maximumDurationMinutes == null ? null : Number(policy.maximumDurationMinutes)
    if (maximum && instances.some(([from, to]) => to - from > maximum * 60000))
        return refuse("DURATION_EXCEEDED", resource.name + " is booked for at most " + minutesText(maximum), true)
    if (series?.pastBound || (horizonDays != null && instances.some(([from]) => from > now + horizonDays * dayMs)))
        return refuse(
            "HORIZON_EXCEEDED",
            resource.name + " is booked at most " + (horizonDays ?? defaultRecurringDays) + " days ahead" + (series?.recurring ? "; end the series within it" : ""),
            true
        )
    const sorted = instances.slice().sort((a, b) => a[0] - b[0])
    if (sorted.some(([from], index) => index > 0 && from < sorted[index - 1][1]))
        return refuse("SERIES_OVERLAP", "The meetings of this series overlap each other on " + resource.name, true)
    const conflicts = safeConflicts(series?.recurring ? conflictsOver(resource, instances, own) : p.conflicts)
    let overridden = false
    if (conflicts.length && yes(p.allowConflicts)) {
        if (policy.softConflictOverride !== "Y")
            return refuse("OVERRIDE_DENIED", resource.name + " is booked then, and its policy allows no override")
        if (!lib.access.has("RESOURCE_BOOKING_OVERRIDE") || blank(p.overrideReason))
            return refuse("OVERRIDE_DENIED", resource.name + " is booked then: an override needs the override permission and a reason")
        overridden = true
    }
    let approval = null
    if (approvalModes.includes(policy.approvalModeEnumId)) {
        const approverPartyIdList = approversOf(resource)
        if (policy.approvalModeEnumId === "RbamApprovers" && !approverPartyIdList.length)
            return refuse("APPROVER_REQUIRED", resource.name + " needs approval and has no approver; ask its resource administrator", true)
        const userPartyId = ec.user.userAccount?.partyId || null
        approval = {
            requiresApproval: policy.approvalModeEnumId === "RbamApprovers" && !approverPartyIdList.includes(userPartyId),
            approverPartyIdList
        }
    }
    return {managed: true, refusal: null, conflicts, approval, overridden}
}

// ===== the policy's services =====
// Who may read and change a resource's policy: RESOURCE_POLICY_EDIT in its organization writes; RESOURCE_POLICY_VIEW or a resource
// read in it reads; a booking approver reads the resources they approve.
function authorityOf(resource) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read a booking policy")
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    const organizationPartyId = organizationOf(resource)
    const inScope = maintenanceAccess.covers(userScope, organizationPartyId)
    const approver = !!caps.bookingViewAssigned && !!userScope.partyId && approversOf(resource).includes(userScope.partyId)
    return {
        userScope,
        organizationPartyId,
        canEdit: inScope && !!caps.policyEdit,
        canRead: (inScope && !!(caps.policyView || caps.policyEdit || caps.resourceRead)) || approver
    }
}
function requireReader(resource) {
    const authority = authorityOf(resource)
    const caps = authority.userScope.capabilities
    if (!(caps.policyView || caps.policyEdit || caps.resourceRead || caps.bookingViewAssigned))
        denied("PERMISSION_DENIED", "A resource policy, resource or booking approval view is required")
    if (!authority.canRead) denied("RECORD_UNAVAILABLE", resource.name + " is not available")
    return authority
}
function requireEditor(resource) {
    const authority = authorityOf(resource)
    if (!authority.canEdit) {
        if (!authority.userScope.capabilities.policyEdit) denied("PERMISSION_DENIED", "RESOURCE_POLICY_EDIT is required")
        denied("RECORD_UNAVAILABLE", resource.name + " is not available")
    }
    return authority
}
function approverList(resource) {
    return approverRows(resource, true).map(row => ({
        partyId: row.partyId,
        partyName: partyName(row.partyId),
        fromDate: row.fromDate,
        fromText: dateText(row.fromDate),
        thruDate: row.thruDate || null,
        thruText: dateText(row.thruDate),
        current: lib.active(row)
    }))
}
// get#ResourceBookingPolicy: the policy in force, the later ones and the history, the approvers, and what the user may do.
function getPolicy(p) {
    const resource = resourceOf(p)
    const authority = requireReader(resource)
    const policy = policyAt(resource)
    const history = Array.from(find(POLICY, keyOf(resource)).orderBy("-fromDate").limit(50).list()).map(policyMap)
    const approvers = approverList(resource)
    return {
        resourceName: resource.name,
        resourceType: resource.assetId ? "asset" : "facility",
        organizationPartyId: authority.organizationPartyId,
        managed: !!policy,
        policy: policyMap(policy),
        policyText: policyText(policy, approversOf(resource)),
        historyList: history,
        approverList: approvers,
        setupFindings: setupFindings(policy, resource),
        canEdit: authority.canEdit
    }
}
function setupFindings(policy, resource) {
    const findings = []
    if (policy?.approvalModeEnumId === "RbamApprovers" && !approversOf(resource).length)
        findings.push("Approval is required and no approver is named: every booking is refused until one is")
    if (policy?.bookable === "N") findings.push("Not bookable: every new booking is refused")
    return findings
}
function requireNumber(value, name) {
    if (blank(value)) return null
    const number = Number(value)
    if (!Number.isInteger(number) || number < 1) denied("VALUE_INVALID", name + " is a whole number of at least 1")
    return number
}
// The policy asked for, checked: the values of a store# or preview#.
function wantedPolicy(p) {
    const mode = text(p.approvalModeEnumId)
    if (mode && !approvalModes.includes(mode)) denied("VALUE_INVALID", "Approval is automatic or by the approvers")
    return {
        bookable: p.bookable === "N" || p.bookable === false || p.bookable === "false" ? "N" : "Y",
        approvalModeEnumId: mode,
        bookingHorizonDays: requireNumber(p.bookingHorizonDays, "The horizon in days"),
        maximumDurationMinutes: requireNumber(p.maximumDurationMinutes, "The longest booking in minutes"),
        timeZone: text(p.timeZone),
        softConflictOverride: yes(p.softConflictOverride) ? "Y" : "N"
    }
}
// What a policy change from fromMs would mean for the bookings already made: each requested or assigned booking from then on (the
// next 180 days) it no longer allows, flagged for review; none is changed. And each a planned block covers.
function impactOf(resource, wanted, fromMs, endPolicy) {
    const visible = eventVisibility()
    const thruMs = fromMs + 180 * dayMs
    const impact = []
    for (const event of bookingsOver(resource, fromMs, thruMs)) {
        const findings = []
        if (!endPolicy) {
            if (wanted.bookable === "N") findings.push("not bookable")
            if (wanted.maximumDurationMinutes && event.thruMs - event.fromMs > wanted.maximumDurationMinutes * 60000)
                findings.push("longer than " + minutesText(wanted.maximumDurationMinutes))
            if (wanted.bookingHorizonDays && event.fromMs > nowMs() + wanted.bookingHorizonDays * dayMs)
                findings.push("past the " + wanted.bookingHorizonDays + "-day horizon")
            if (wanted.approvalModeEnumId === "RbamApprovers" && assignedStatuses.includes(event.bookingStatusId) && !approversOf(resource).length)
                findings.push("approval required with no approver")
        }
        if (!findings.length) continue
        const seen = visible(event.recurringEventId || event.workEffortId)
        impact.push({
            workEffortId: seen ? event.workEffortId : null,
            label: seen ? event.title : "Busy",
            fromText: dateText(new Date(event.fromMs)),
            thruText: dateText(new Date(event.thruMs)),
            statusText: requestedStatuses.includes(event.bookingStatusId) ? "Pending approval" : "Booked",
            finding: findings.join("; "),
            consequence: "Kept; review it with its organizer"
        })
    }
    return impact
}
// preview#ResourceBookingPolicy: the impact of a change before it is saved.
function previewPolicy(p) {
    const resource = resourceOf(p)
    requireEditor(resource)
    const wanted = wantedPolicy(p)
    const fromMs = ms(p.fromDate) ?? nowMs()
    const impactList = impactOf(resource, wanted, Math.max(fromMs, nowMs()), yes(p.endPolicy))
    return {impactList, impactCount: impactList.length, setupFindings: setupFindings(Object.assign({}, wanted), resource)}
}
// store#ResourceBookingPolicy: a new policy from fromDate (now when empty; not in the past), the one in force and any later one
// ended then, or (endPolicy) the resource unmanaged from then; with the expected revision of the policy in force and a reason
// for a change. Bookings already made are kept; the impact lists those it no longer allows.
function storePolicy(p) {
    const resource = resourceOf(p, true)
    const authority = requireEditor(resource)
    const now = nowMs()
    const fromMs = ms(p.fromDate) ?? now
    if (fromMs < now - 5 * 60000) denied("DATE_PAST", "A policy change takes effect now or later")
    const inForce = policyAt(resource)
    if (inForce && Number(p.expectedRevision ?? -1) !== Number(inForce.revision || 0))
        denied("REVISION_CHANGED", "The policy of " + resource.name + " changed; reload it")
    const changeReason = text(p.changeReason)
    if (inForce && !changeReason) denied("REASON_REQUIRED", "A change of the policy needs its reason")
    const endPolicy = yes(p.endPolicy)
    if (endPolicy && !inForce) denied("POLICY_NONE", resource.name + " has no policy in force")
    const wanted = endPolicy ? null : wantedPolicy(p)
    const fromDate = new Date(fromMs)
    // the rows in force from the date on end then; one beginning later is withdrawn (its end at its start)
    const f = ec.entity.conditionFactory
    for (const row of Array.from(
        find(POLICY, keyOf(resource))
            .condition(f.makeCondition([f.makeCondition("thruDate", "is-null", null), f.makeCondition("thruDate", "greater", fromDate)], "or"))
            .forUpdate(true)
            .list()
    )) {
        const starts = ms(row.fromDate)
        call("update#" + POLICY, {
            resourceBookingPolicyId: row.resourceBookingPolicyId,
            thruDate: starts < fromMs ? fromDate : row.fromDate,
            revision: Number(row.revision || 0) + 1
        })
    }
    const impactList = impactOf(resource, wanted || {}, Math.max(fromMs, now), endPolicy)
    if (endPolicy) return {resourceBookingPolicyId: null, revision: 0, impactList, impactCount: impactList.length}
    const created = call("create#" + POLICY, Object.assign({}, keyOf(resource), wanted, {
        organizationPartyId: authority.organizationPartyId,
        fromDate,
        changeReason,
        revision: 1,
        createdByUserId: ec.user.userId,
        createdDate: ec.user.nowTimestamp
    }))
    return {resourceBookingPolicyId: created.resourceBookingPolicyId, revision: 1, impactList, impactCount: impactList.length}
}
// The requested bookings of the resource not over yet (an approver's pending work), as event ids: of events not cancelled whose
// end is ahead or unset (a series).
function pendingRequests(resource) {
    const f = ec.entity.conditionFactory
    const ahead = f.makeCondition(
        [f.makeCondition("estimatedCompletionDate", "is-null", null), f.makeCondition("estimatedCompletionDate", "greater", ec.user.nowTimestamp)],
        "or"
    )
    const query = resource.assetId
        ? find("mantle.work.effort.WorkEffortAndAssetBooking", {assetId: resource.assetId, bookingStatusId: "WeaaRequested"}).condition(
              f.makeCondition([f.makeCondition("bookingThruDate", "is-null", null), f.makeCondition("bookingThruDate", "greater", ec.user.nowTimestamp)], "or")
          )
        : find("mantle.work.effort.WorkEffortAndFacilityBooking", {facilityId: resource.facilityId, bookingStatusId: "WefRequested"})
    return ids(
        Array.from(query.condition(f.makeCondition("statusId", "not-equals", "WeCancelled", true)).condition(ahead).selectField("workEffortId").list()).map(
            row => row.workEffortId
        )
    )
}
// store#ResourceApprover: a BookingApprover of the resource added from fromDate (now when empty), or (thruDate, or end) ended then.
// Ending the last current approver while requests wait needs another (replacementPartyId) or the reason it is left unresolved
// (unresolvedReason; APPROVER_PENDING otherwise).
function storeApprover(p) {
    const resource = resourceOf(p, true)
    requireEditor(resource)
    const partyId = text(p.partyId)
    const party = partyId ? one("mantle.party.Party", {partyId}) : null
    if (!party || party.partyTypeEnumId !== "PtyPerson") denied("PARTY_INVALID", "An approver is a person")
    const entity = resource.assetId ? "mantle.product.asset.AssetPartyAssignment" : "mantle.facility.FacilityParty"
    const now = nowMs()
    const ending = yes(p.end) || p.thruDate != null
    if (!ending) {
        const fromMs = ms(p.fromDate) ?? now
        const existing = approverRows(resource, true).find(row => row.partyId === partyId)
        if (existing) return {added: false, ended: false, partyId, pendingCount: pendingRequests(resource).length}
        call("create#" + entity, Object.assign({}, keyOf(resource), {partyId, roleTypeId: "BookingApprover", fromDate: new Date(fromMs)}))
        return {added: true, ended: false, partyId, pendingCount: pendingRequests(resource).length}
    }
    const thruMs = ms(p.thruDate) ?? now
    const rows = approverRows(resource, true).filter(row => row.partyId === partyId)
    if (!rows.length) denied("APPROVER_NONE", partyName(partyId) + " approves no booking of " + resource.name)
    const replacementPartyId = text(p.replacementPartyId)
    const others = approversOf(resource).filter(id => id !== partyId)
    const pending = pendingRequests(resource)
    if (pending.length && !others.length && !replacementPartyId && blank(p.unresolvedReason))
        denied(
            "APPROVER_PENDING",
            pending.length + " request(s) of " + resource.name + " wait for approval: name another approver or say why they are left unresolved"
        )
    for (const row of rows)
        call("update#" + entity, Object.assign({}, keyOf(resource), {partyId, roleTypeId: "BookingApprover", fromDate: row.fromDate,
            thruDate: new Date(Math.max(thruMs, ms(row.fromDate)))}))
    if (replacementPartyId && replacementPartyId !== partyId)
        storeApprover(Object.assign({}, keyOf(resource), {partyId: replacementPartyId, fromDate: new Date(thruMs)}))
    if (pending.length && !others.length && !replacementPartyId)
        ec.logger.warn("Approver " + partyId + " of " + resource.name + " ended with " + pending.length + " request(s) unresolved: " + text(p.unresolvedReason))
    return {added: false, ended: true, partyId, pendingCount: pending.length}
}
// find#BookableResources: the bookable equipment and facilities of the user's scope (a policy reader or resource reader; a booking
// approver, the resources they approve), with their policy in words, approvers, capacity and features, what blocks them now and
// how many requests wait. Filters: resourceType (asset or facility), text, facilityId (that facility and those inside it, and the
// equipment there), managed (Y or N).
function findBookable(p) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to find resources")
    const userScope = maintenanceAccess.scope()
    const caps = userScope.capabilities
    const broad = !!(caps.policyView || caps.policyEdit || caps.resourceRead)
    if (!broad && !caps.bookingViewAssigned) denied("PERMISSION_DENIED", "A resource policy, resource or booking approval view is required")
    const f = ec.entity.conditionFactory
    const like = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
    const term = text(p.text)
    const within = text(p.facilityId) ? outages().subtreeIds(text(p.facilityId)) : null
    // an approver without a broad read: only the resources they approve now
    let approvedFacilities = null
    let approvedAssets = null
    if (!broad) {
        const partyId = userScope.partyId || "_NA_"
        approvedFacilities = Array.from(find("mantle.facility.FacilityParty", {partyId, roleTypeId: "BookingApprover"}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()).map(row => row.facilityId)
        approvedAssets = Array.from(find("mantle.product.asset.AssetPartyAssignment", {partyId, roleTypeId: "BookingApprover"}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()).map(row => row.assetId)
    }
    const covers = organizationPartyId => (broad ? maintenanceAccess.covers(userScope, organizationPartyId) : true)
    const found = []
    if (p.resourceType !== "asset") {
        let query = find(FACILITY, {bookable: "Y"}).condition("closedDate", "is-null", null).orderBy("facilityName").limit(300)
        if (term) query = query.condition(f.makeCondition("facilityName", "like", like(term)).ignoreCase())
        if (within) query = query.condition("facilityId", "in", within)
        if (approvedFacilities) query = query.condition("facilityId", "in", approvedFacilities.length ? approvedFacilities : ["_NA_"])
        for (const row of Array.from(query.list())) {
            const organizationPartyId = maintenanceAccess.facilityOrganization(row.facilityId)
            if (covers(organizationPartyId)) found.push({facilityId: row.facilityId, row, organizationPartyId})
        }
    }
    if (p.resourceType !== "facility") {
        let query = find(ASSET, {bookable: "Y"})
            .condition(f.makeCondition("assetTypeEnumId", "not-in", stockTypes, true))
            .orderBy("assetName")
            .limit(300)
        if (term) query = query.condition(f.makeCondition("assetName", "like", like(term)).ignoreCase())
        if (within) query = query.condition("facilityId", "in", within)
        if (approvedAssets) query = query.condition("assetId", "in", approvedAssets.length ? approvedAssets : ["_NA_"])
        for (const row of Array.from(query.list())) {
            const organizationPartyId = maintenanceAccess.assetOrganization(row.assetId)
            if (covers(organizationPartyId)) found.push({assetId: row.assetId, row, organizationPartyId})
        }
    }
    const now = nowMs()
    const candidates = []
    for (const item of found) {
        const resource = {assetId: item.assetId || null, facilityId: item.facilityId || null, row: item.row,
            name: (item.assetId ? item.row.assetName : item.row.facilityName) || item.assetId || item.facilityId}
        const policy = policyAt(resource)
        if (p.managed === "Y" && !policy) continue
        if (p.managed === "N" && policy) continue
        candidates.push({item, resource, policy})
    }
    candidates.sort((a, b) => String(a.resource.name).localeCompare(String(b.resource.name)))
    const paged = lib.pageList(candidates, p, "resourceList")
    paged.resourceList = paged.resourceList.map(({item, resource, policy}) => {
        const approverIds = approversOf(resource)
        const blockNow = blocksOver(resource, now, now + 1)[0]
        const blockAhead = blockNow ? null : blocksOver(resource, now, now + 14 * dayMs)[0]
        const locationId = item.assetId ? item.row.facilityId : item.row.parentFacilityId
        const features = item.facilityId
            ? Array.from(find("mantle.facility.FacilityFeature", {facilityId: item.facilityId}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list())
                  .map(row => enumText(row.featureEnumId))
                  .join(", ")
            : ""
        return {
            resourceType: item.assetId ? "asset" : "facility",
            assetId: resource.assetId,
            facilityId: resource.facilityId,
            resourceName: resource.name,
            typeText: enumText(item.assetId ? item.row.classEnumId || item.row.assetTypeEnumId : item.row.facilityTypeEnumId),
            locationName: locationId ? one(FACILITY, {facilityId: locationId})?.facilityName || locationId : "",
            capacityText: item.row.capacity != null ? "Holds " + String(item.row.capacity).replace(/\.0+$/, "") : "",
            featuresText: features,
            managed: !!policy,
            managedText: policy ? (policy.bookable === "N" ? "Not bookable" : "Managed") : "Not managed",
            policyText: policyText(policy, approverIds),
            // the policy in force, for Bookability's change of it
            policyRevision: policy ? Number(policy.revision || 0) : null,
            bookable: policy?.bookable || "Y",
            approvalModeEnumId: policy?.approvalModeEnumId || null,
            bookingHorizonDays: policy?.bookingHorizonDays ?? null,
            maximumDurationMinutes: policy?.maximumDurationMinutes ?? null,
            softConflictOverride: policy?.softConflictOverride || "N",
            maximumText: policy?.maximumDurationMinutes ? minutesText(Number(policy.maximumDurationMinutes)) : "",
            approverNames: approverIds.map(partyName).join(", "),
            blockText: blockNow ? blockLabel(blockNow, resource) : blockAhead ? blockLabel(blockAhead, resource) + " from " + dateText(blockAhead.fromDate) : "",
            blockedNow: !!blockNow,
            pendingCount: pendingRequests(resource).length,
            canEdit: !!caps.policyEdit && maintenanceAccess.covers(userScope, item.organizationPartyId)
        }
    })
    return Object.assign({}, paged, {canEdit: !!caps.policyEdit})
}

;({
    policyAt,
    approversOf,
    blocksOver,
    guard,
    availability,
    unavailableOver,
    execute: (op, p) => {
        const operations = {
            availability,
            findBookable,
            get: getPolicy,
            store: storePolicy,
            preview: previewPolicy,
            storeApprover
        }
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown resource policy operation " + op)
        return operations[op](p || {})
    }
})
