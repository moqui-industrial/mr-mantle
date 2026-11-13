// A hire and an employment's dated changes (mantle.humanres.PeopleServices preview#Hire, hire#Employee, preview#EmploymentChange,
// apply#EmploymentChange, decide#EmploymentChange with the PeopleEmploymentChangeApproval topic's approve and refuse services, and
// find#EmploymentChanges; IronStone People design §4 HireEmployee and EmploymentChange, PE-02; impl-people P6). Every service checks
// the caller's People scope first (People.js scopeOf: an HR editor, PEOPLE_HR_VIEW and PEOPLE_HR_EDIT, of the employer, for a hire
// and a change) and reads and writes with authorization off after it. A decision is checked by record#Decision (Approvals.js).
//
// The records (HumanResourcesEntities.xml):
// - an employment is the PrtEmployee relationship from the person to the legal employer and its Employment row, one at a time per
//   person and employer (create#Employment's overlap check is of PrtEmployee alone, F3); a rehire is a new one, the old one kept;
//   an orphan PrtEmployee relationship (no Employment row) is completed, never duplicated; People never deletes one, nor calls
//   create#PersonEmployee (F5);
// - an assignment (EmploymentAssignment) holds the employment's department, primary position, manager and work location from a
//   date, and its state (working or on leave); a change ends the one in effect and starts the next, inside the employment, one
//   primary at a time. It is the source of the manager per employment (People.js linesOf reads it: F81, F86, F91) and of three
//   projections written in the same transaction: the department membership (a dated PrtMember row from role Assignee, so a
//   department's members are its assignments'), the position occupancy (a dated EmplPositionParty row, Positions.js holdSeat; and
//   Employment.emplPositionId kept equal to the newest primary seat for its legacy readers: TimeServices, the contact card) and the
//   reporting line (a PrtManager row from the manager, ended only when no other employment of the person still uses it);
// - a change (EmploymentChange) is the hire or change itself, with its operation key: a transfer and a separation wait for an
//   approval (Approvals.js, kind PakEmploymentChange, bound to the change and the employment's revision) and are applied by its
//   last decision; a hire, a manager change, a leave of absence and a return are applied at once. A change applied to an employment
//   supersedes the changes of it still waiting.
// A separation ends the employment, its assignment and their projections, the person's lead and team memberships at the employer
// and the reporting lines they manage there (each report's assignment continues with no manager), leaves another employer's
// employment alone, and routes again the People decisions waiting on the leaver (Approvals.js reroute) and the confidential cases
// they handled there (PeopleCases.js rerouteCases, P21). The person's Party owner is left as it is (F59). Missing and unauthorized
// records are refused alike (RECORD_UNAVAILABLE).
// P23: the pay change (kind EckPayChange), payroll's part of a change: a new salary from a date asked by a payroll editor of the
// employer (PAYROLL_VIEW and PAYROLL_EDIT, not HR), checked by PayrollAssignments.js checkPayTerms; it waits for approval on the
// same topic, a request of its own kind (Approvals.js PakPayChange: the employer's payroll approvers by default, or whom its rules
// name; never who asked), the first salary too (the user's calls of Nov 12, 2026), and is applied by writing the salary from its
// date (PayrollAssignments.js writeSalary: the row in effect ends there). Its request is bound to the change and the employment's
// salary rows, not its assignments, so a transfer and a pay change neither supersede nor invalidate each other; a separation
// supersedes both. Its salary is read only by a payroll reader of the employer and the approver of its step; HR without
// PAYROLL_VIEW does not see a pay change. A hire from an accepted offer records the offer's approved pay as the first salary
// (hireEmployee). Other pay is never read or written here.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const positions = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Positions.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
const cases = () => ec.resource.script("component://mr-mantle/service/mantle/request/PeopleCases.js")
const offers = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Offers.js")
const letters = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Letters.js")
const payroll = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/PayrollAssignments.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const RELATIONSHIP = "mantle.party.PartyRelationship"
const EMPLOYMENT = "mantle.humanres.employment.Employment"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const CHANGE = "mantle.humanres.employment.EmploymentChange"
const POSITION = "mantle.humanres.position.EmplPosition"
const HOLDER = "mantle.humanres.position.EmplPositionParty"
const FACILITY = "mantle.facility.Facility"
const approvalKind = "PakEmploymentChange"
// P23 review: a pay change's approval is a kind of its own (Approvals.js PakPayChange: payroll approvers by default)
const payApprovalKind = "PakPayChange"
const kindOfChange = change => (change?.changeKindEnumId === "EckPayChange" ? payApprovalKind : approvalKind)
// the kinds of change apply#EmploymentChange takes, and those that wait for approval (the PeopleEmploymentChangeApproval topic:
// a transfer and a separation, design §12)
const changeKinds = {
    transfer: "EckTransfer",
    manager: "EckManager",
    leave: "EckLeave",
    return: "EckReturn",
    separation: "EckSeparation",
    // P23: payroll's part of a change
    pay: "EckPayChange"
}
const approvalKinds = ["EckTransfer", "EckSeparation", "EckPayChange"]
const payKind = "EckPayChange"
const kindTexts = {
    EckHire: "Hire",
    EckTransfer: "Transfer",
    EckManager: "Manager change",
    EckLeave: "Leave of absence",
    EckReturn: "Return from leave",
    EckSeparation: "Separation",
    EckReorganization: "Reorganization",
    EckSchedule: "Working schedule",
    EckPayChange: "Pay change"
}
const statusTexts = {
    EchRequested: "Waiting for approval",
    EchApplied: "Applied",
    EchRefused: "Refused",
    EchSuperseded: "Superseded",
    EchWithdrawn: "Withdrawn"
}
// the kinds of applied change HR may withdraw while their date is still to come (P7, F131): not a hire; a separation set for a
// later date too (the user's call, Nov 11), withdrawn by its own path (withdrawSeparation); P9: a working schedule set for a later date
const withdrawableKinds = [
    "EckTransfer",
    "EckManager",
    "EckLeave",
    "EckReturn",
    "EckReorganization",
    "EckSeparation",
    "EckSchedule"
]
const stateTexts = {EasActive: "Working", EasLeave: "On leave of absence"}
// P9: the working schedule and its holiday calendar are terms too, so every change carries them to the next assignment; a transfer
// or a manager change never asks for them (assign#Schedule changes them alone)
const termFields = [
    "departmentPartyId",
    "emplPositionId",
    "managerPartyId",
    "facilityId",
    "workingScheduleId",
    "holidayCategoryId"
]
const scheduleFields = ["workingScheduleId", "holidayCategoryId"]
// the most people a match search answers, and the shortest name it searches by
const matchLimit = 10
const matchMinLength = 2
// a reporting chain longer than this is taken to be a cycle
const maxDepth = 50

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const unique = people.unique
const truthy = value => value === true || value === "true" || value === "Y"
// an effective date (now when empty): the start of a date alone, in the user's zone
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const stamp = millis => (millis == null ? null : new Date(millis))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
// a parameter given: null (not passed) leaves a term as it is, an empty text clears it
const given = value => value != null

// ===== scope =====
function editorScope(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !caps.hrEdit) denied("PERMISSION_DENIED", what + " needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
// P23: a change's asker: a pay change is a payroll editor's (PAYROLL_VIEW and PAYROLL_EDIT), every other kind an HR editor's
function changeScope(changeKind) {
    if (text(changeKind) !== "pay") return editorScope("Changing an employment")
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.payrollView || !caps.payrollEdit) denied("PERMISSION_DENIED", "A pay change needs PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
const employmentOf = row => ({
    partyRelationshipId: row.partyRelationshipId,
    partyId: row.fromPartyId,
    organizationPartyId: row.toPartyId,
    fromMs: ms(row.fromDate),
    thruMs: ms(row.thruDate)
})
// An employment of an employer in the caller's scope (a PrtEmployee relationship with its Employment row); refused alike when
// missing or outside (RECORD_UNAVAILABLE).
function employmentIn(userScope, partyRelationshipId) {
    const id = text(partyRelationshipId)
    const row = id ? one(RELATIONSHIP, {partyRelationshipId: id}) : null
    if (
        !row ||
        row.relationshipTypeEnumId !== "PrtEmployee" ||
        !userScope.organizationPartyIds.includes(row.toPartyId) ||
        !one(EMPLOYMENT, {partyRelationshipId: id})
    )
        denied("RECORD_UNAVAILABLE", "Employment " + id + " is not available")
    return employmentOf(row)
}
// The checks of a preview: each refusal is kept as an error finding and the next check goes on.
function attempt(findings, check) {
    try {
        return check()
    } catch (error) {
        const code = lib.reasonCode(error)
        if (!code) throw error
        findings.push({code, severity: "error", message: String(error.message).replace(/^[A-Z][A-Z0-9_]+: /, "")})
        return null
    }
}
const firstError = findings => findings.find(finding => finding.severity === "error")
function refuseErrors(findings) {
    const error = firstError(findings)
    if (error) denied(error.code, error.message)
}

// ===== names =====
function positionNames(positionIds) {
    const ids = unique(positionIds.filter(Boolean))
    if (!ids.length) return {}
    const found = Array.from(find(POSITION).condition("emplPositionId", "in", ids).list())
    const classIds = unique(found.map(row => row.emplPositionClassId).filter(Boolean))
    const titles = classIds.length
        ? Object.fromEntries(
              Array.from(
                  find("mantle.humanres.position.EmplPositionClass").condition("emplPositionClassId", "in", classIds).list()
              ).map(row => [row.emplPositionClassId, row.title])
          )
        : {}
    return Object.fromEntries(
        found.map(row => [row.emplPositionId, row.description || titles[row.emplPositionClassId] || row.emplPositionId])
    )
}
function facilityNames(facilityIds) {
    const ids = unique(facilityIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(FACILITY).condition("facilityId", "in", ids).list()).map(row => [
            row.facilityId,
            row.facilityName || row.facilityId
        ])
    )
}
function enumNames(enumIds) {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [
            row.enumId,
            row.description || row.enumId
        ])
    )
}
// Terms as display text: the department, position, manager and work location names, and the working schedule's (P9).
function termTexts(terms) {
    const organizations = people.organizationNames([terms.departmentPartyId].filter(Boolean))
    const persons = people.personNames([terms.managerPartyId].filter(Boolean))
    return {
        departmentName: terms.departmentPartyId ? organizations[terms.departmentPartyId] || terms.departmentPartyId : "",
        positionName: terms.emplPositionId ? positionNames([terms.emplPositionId])[terms.emplPositionId] || "" : "",
        managerName: terms.managerPartyId ? persons[terms.managerPartyId] || terms.managerPartyId : "",
        facilityName: terms.facilityId ? facilityNames([terms.facilityId])[terms.facilityId] || "" : "",
        scheduleName: terms.workingScheduleId
            ? schedules().scheduleNames([terms.workingScheduleId])[terms.workingScheduleId] || ""
            : ""
    }
}

// ===== the terms in effect =====
// an assignment of a withdrawn change never took effect: it ends on its own start (P7, F131) and is no assignment
const voided = row => row.thruDate != null && ms(row.thruDate) <= (ms(row.fromDate) ?? -Infinity)
const assignmentsOf = partyRelationshipId =>
    rows(ASSIGNMENT, {partyRelationshipId, isPrimary: "Y"})
        .filter(row => !voided(row))
        .sort((a, b) => (ms(a.fromDate) ?? 0) - (ms(b.fromDate) ?? 0))
const termsOfRow = row => Object.fromEntries(termFields.map(field => [field, row?.[field] || null]))
// The terms of an employment on the date: its assignment's, else (an employment written before People's assignments, or a hire's
// first assignment of an orphan relationship) the ones its records give: a department membership (Assignee) under the employer, a
// seat of the employer held, else Employment.emplPositionId, and the reporting line at the employer.
function termsAt(employment, at) {
    const assignment = assignmentsOf(employment.partyRelationshipId).find(row => openAt(row, at)) || null
    if (assignment) return Object.assign(termsOfRow(assignment), {assignment, stateEnumId: assignment.stateEnumId || "EasActive"})
    const org = employment.organizationPartyId
    const units = people.unitsUnder([org])
    const departments = units.length
        ? Array.from(
              find("mantle.party.PartyRole").condition("partyId", "in", units).condition("roleTypeId", "OrgDepartment").list()
          ).map(row => row.partyId)
        : []
    const membership = departments.length
        ? rows(RELATIONSHIP, {
              relationshipTypeEnumId: "PrtMember",
              fromPartyId: employment.partyId,
              fromRoleTypeId: "Assignee"
          }).find(row => departments.includes(row.toPartyId) && openAt(row, at))
        : null
    const heldIds = rows(HOLDER, {partyId: employment.partyId, roleTypeId: "Employee"})
        .filter(row => openAt(row, at))
        .map(row => row.emplPositionId)
    let seat = heldIds.length
        ? Array.from(find(POSITION).condition("emplPositionId", "in", heldIds).condition("organizationPartyId", org).list())[0]
              ?.emplPositionId || null
        : null
    if (!seat) {
        const named = one(EMPLOYMENT, {partyRelationshipId: employment.partyRelationshipId})?.emplPositionId
        if (named && one(POSITION, {emplPositionId: named})?.organizationPartyId === org) seat = named
    }
    const line = people.linesOf({reportPartyIds: [employment.partyId]}, at).find(row => row.organizationPartyIds.includes(org))
    return {
        departmentPartyId: membership?.toPartyId || null,
        emplPositionId: seat,
        managerPartyId: line?.managerPartyId || null,
        facilityId: null,
        assignment: null,
        stateEnumId: "EasActive"
    }
}

// ===== checks of the terms =====
// The new terms on the date: a department of the employer (Positions.js checkDepartment), a position of the employer in effect and
// not inactive, in the department when both are named (the position's department when none is), free of another holder; a
// manager employed by the employer then, never the person nor one who reports to them there; a work location of the employer.
// Each refusal is a finding; the terms come back with the position's department filled in.
function checkTerms(employment, terms, at, findings) {
    const org = employment.organizationPartyId
    const out = Object.assign({}, terms)
    if (out.emplPositionId) {
        const position = one(POSITION, {emplPositionId: out.emplPositionId})
        attempt(findings, () => {
            if (!position || position.organizationPartyId !== org)
                denied("RECORD_UNAVAILABLE", "Position " + out.emplPositionId + " is not available")
            if ((ms(position.fromDate) ?? -Infinity) > at || (ms(position.thruDate) ?? Infinity) <= at)
                denied("POSITION_NOT_IN_EFFECT", "The position is not in effect on that date")
            if (position.statusId === "EmpsInactive") denied("POSITION_INACTIVE", "The position is inactive")
            if (position.departmentPartyId) {
                if (out.departmentPartyId && out.departmentPartyId !== position.departmentPartyId)
                    denied(
                        "POSITION_DEPARTMENT",
                        "The position belongs to " +
                            (people.organizationNames([position.departmentPartyId])[position.departmentPartyId] ||
                                "another department")
                    )
                out.departmentPartyId = position.departmentPartyId
            }
            const holders = positions().holdersOf([position.emplPositionId])[position.emplPositionId] || []
            const other = holders.find(
                holder =>
                    holder.partyId !== employment.partyId &&
                    (holder.fromMs ?? -Infinity) < (employment.thruMs ?? Infinity) &&
                    (holder.thruMs ?? Infinity) > at
            )
            if (other)
                denied(
                    "POSITION_OCCUPIED",
                    (people.personNames([other.partyId])[other.partyId] || other.partyId) + " holds this position then"
                )
        })
    }
    if (out.departmentPartyId) attempt(findings, () => positions().checkDepartment(out.departmentPartyId, org, at))
    if (out.managerPartyId)
        attempt(findings, () => {
            if (out.managerPartyId === employment.partyId) denied("SELF_REPORTING", "A person cannot report to themselves")
            const employed = people
                .current(people.employmentFind().condition({fromPartyId: out.managerPartyId, toPartyId: org}), at)
                .count()
            if (!employed)
                denied(
                    "MANAGER_NOT_EMPLOYED",
                    "The manager is not employed by " + (people.organizationNames([org])[org] || org) + " on that date"
                )
            let above = out.managerPartyId
            for (let depth = 0; above && depth < maxDepth; depth++) {
                if (above === employment.partyId)
                    denied("REPORTING_CYCLE", "The manager reports to this person; a reporting line cannot loop")
                above =
                    people.linesOf({reportPartyIds: [above]}, at).find(line => line.organizationPartyIds.includes(org))
                        ?.managerPartyId || null
            }
        })
    if (out.facilityId)
        attempt(findings, () => {
            const facility = one(FACILITY, {facilityId: out.facilityId})
            if (!facility || facility.ownerPartyId !== org)
                denied("FACILITY_OUTSIDE", "The work location is not one of " + (people.organizationNames([org])[org] || org))
        })
    return out
}
// The date of a change inside the employment and after the assignment in effect began, with no later assignment set but those
// the change supersedes (allow: a separation's and an early return's, P7, F131).
function checkDate(employment, at, findings, allow = null) {
    attempt(findings, () => {
        if ((employment.fromMs ?? -Infinity) > at || (employment.thruMs ?? Infinity) <= at)
            denied("DATE_OUTSIDE", "The date is outside the employment")
        const later = assignmentsOf(employment.partyRelationshipId).filter(row => (ms(row.fromDate) ?? -Infinity) >= at)
        const blocking = allow ? later.filter(row => !allow(row)) : later
        if (blocking.length)
            denied(
                "ASSIGNMENT_SCHEDULED",
                "A change from " + dateText(blocking[0].fromDate) + " is in effect or cannot be withdrawn; choose a later date"
            )
    })
}
// The later assignments a change of the kind supersedes (P7, F131), else null: a separation every assignment set for a date
// still to come but a hire's; a return the scheduled return of the leave of absence in effect (so it can come early).
function supersedesFor(kindEnumId) {
    const scheduled = row => (ms(row.fromDate) ?? -Infinity) > nowMs()
    if (kindEnumId === "EckSeparation")
        return row =>
            scheduled(row) && !!row.employmentChangeId && changeOf(row.employmentChangeId)?.changeKindEnumId !== "EckHire"
    if (kindEnumId === "EckReturn")
        return row =>
            scheduled(row) &&
            (row.stateEnumId || "EasActive") === "EasActive" &&
            !!row.employmentChangeId &&
            changeOf(row.employmentChangeId)?.changeKindEnumId === "EckLeave"
    return null
}
// The scheduled changes a change from the date supersedes, withdrawn latest first (each recorded with the superseding change).
function supersedeScheduled(employment, at, allow, byChangeId, reason) {
    const later = assignmentsOf(employment.partyRelationshipId).filter(row => (ms(row.fromDate) ?? -Infinity) >= at && allow(row))
    const changeIds = unique(later.sort((a, b) => ms(b.fromDate) - ms(a.fromDate)).map(row => row.employmentChangeId))
    for (const employmentChangeId of changeIds) withdrawScheduled(changeOf(employmentChangeId), reason, byChangeId)
    return changeIds
}

// ===== the projections of an assignment =====
// The person's department membership moves with the assignment's department: the Assignee row of the department before ends on
// the date and one of the department after starts (to the employment's end).
function moveMembership(partyId, before, after, at, thruMs, reason) {
    if (before === after) return
    if (before)
        for (const row of rows(RELATIONSHIP, {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: partyId,
            toPartyId: before,
            fromRoleTypeId: "Assignee"
        }).filter(row => openAt(row, at)))
            endRow(row, at, reason)
    if (after) {
        const open = rows(RELATIONSHIP, {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: partyId,
            toPartyId: after,
            fromRoleTypeId: "Assignee"
        }).some(row => openAt(row, at))
        if (open) return
        call("mantle.party.PartyServices.ensure#PartyRole", {partyId, roleTypeId: "Assignee"})
        call("create#" + RELATIONSHIP, {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: partyId,
            fromRoleTypeId: "Assignee",
            toPartyId: after,
            toRoleTypeId: "OrgDepartment",
            fromDate: stamp(at),
            thruDate: stamp(thruMs),
            comments: reason || null
        })
    }
}
// The person's seat moves with the assignment's position: the holding before ends on the date and the one after starts (to the
// employment's end), refused when another holds it (Positions.js holdSeat). A seat held only by Employment.emplPositionId (written
// before People, with no occupancy row) gets its dated row from the employment's start to the date, so the seat is free after it
// while Employment.emplPositionId still names it until the date (Positions.js holdersOf reads the row before the Employment).
function moveSeat(employment, before, after, at, thruMs, reason) {
    if (before === after) return
    const partyId = employment.partyId
    if (before) {
        const position = one(POSITION, {emplPositionId: before})
        const held = rows(HOLDER, {emplPositionId: before, partyId, roleTypeId: "Employee"})
        const holding = held.find(row => openAt(row, at))
        if (position && holding && ms(holding.fromDate) < at)
            positions().endHolding(position, partyId, ms(holding.fromDate), at, reason)
        else if (
            position &&
            !held.length &&
            employment.fromMs != null &&
            employment.fromMs < at &&
            one(EMPLOYMENT, {partyRelationshipId: employment.partyRelationshipId})?.emplPositionId === before
        )
            call("create#" + HOLDER, {
                emplPositionId: before,
                partyId,
                roleTypeId: "Employee",
                fromDate: stamp(employment.fromMs),
                thruDate: stamp(at),
                comments: reason || null
            })
    }
    if (after) positions().holdSeat(one(POSITION, {emplPositionId: after}), partyId, at, thruMs, reason)
}
// Whether the person's line from the manager is still used, from the date, by an employment of theirs at another employer: one
// whose assignment names the manager, or one with no assignment where the manager works too (or nowhere, a line written before
// People) when no assignment of the person names the manager, as People.js linesOf reads it.
function lineInUse(partyId, managerPartyId, exceptOrganizationPartyId, at) {
    const employers = people.employersOfParties([partyId, managerPartyId], at)
    const assigned = people.assignmentsAt([partyId], at)
    const named = Object.values(assigned).some(assignment => assignment.managerPartyId === managerPartyId)
    for (const organizationPartyId of employers[partyId] || []) {
        if (organizationPartyId === exceptOrganizationPartyId) continue
        const assignment = assigned[organizationPartyId + "/" + partyId]
        if (assignment) {
            if (assignment.managerPartyId === managerPartyId) return true
        } else if (!named && (!employers[managerPartyId] || employers[managerPartyId].includes(organizationPartyId))) return true
    }
    return false
}
// The person's reporting line moves with the assignment's manager: a line from the manager after (a PrtManager row from them to
// the person) is in effect from the date, and the line from the manager before ends on it unless another employment uses it.
function moveLine(employment, before, after, at, reason) {
    if (before === after) return
    const partyId = employment.partyId
    if (after) {
        const live = rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtManager", fromPartyId: after, toPartyId: partyId}).some(
            row => openAt(row, at)
        )
        if (!live) {
            call("mantle.party.PartyServices.ensure#PartyRole", {partyId: after, roleTypeId: "Manager"})
            call("create#" + RELATIONSHIP, {
                relationshipTypeEnumId: "PrtManager",
                fromPartyId: after,
                fromRoleTypeId: "Manager",
                toPartyId: partyId,
                toRoleTypeId: "Employee",
                fromDate: stamp(at),
                comments: reason || null
            })
        }
    }
    if (before && !lineInUse(partyId, before, employment.organizationPartyId, at))
        for (const row of rows(RELATIONSHIP, {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: before,
            toPartyId: partyId
        }).filter(row => openAt(row, at) && (ms(row.fromDate) ?? -Infinity) < at))
            endRow(row, at, reason)
}
function endRow(row, at, reason) {
    call("update#" + RELATIONSHIP, {
        partyRelationshipId: row.partyRelationshipId,
        thruDate: stamp(at),
        thruDate_changeReason: reason || null
    })
}
// The projections of a change of terms on the date. Employment.emplPositionId holds the seat in effect (TimeServices' rates and
// the contact card read it; the user's call, Nov 11): a change in effect now sets it at once, one dated later leaves it until its
// date, when the daily job apply#DueAssignments sets it; a separation keeps the last one.
function project(employment, before, after, at, thruMs, reason, separation = false) {
    moveMembership(employment.partyId, before.departmentPartyId, after.departmentPartyId, at, thruMs, reason)
    moveSeat(employment, before.emplPositionId, after.emplPositionId, at, thruMs, reason)
    moveLine(employment, before.managerPartyId, after.managerPartyId, at, reason)
    if (!separation && at <= nowMs() && (before.emplPositionId || null) !== (after.emplPositionId || null)) {
        const row = one(EMPLOYMENT, {partyRelationshipId: employment.partyRelationshipId})
        if (row && (row.emplPositionId || null) !== (after.emplPositionId || null))
            call("update#" + EMPLOYMENT, {
                partyRelationshipId: employment.partyRelationshipId,
                emplPositionId: after.emplPositionId || null
            })
    }
}
// The daily job (apply#DueAssignments): each employment open now whose primary assignment in effect names another seat than
// Employment.emplPositionId gets the assignment's seat (of partyRelationshipIds when given), each in its own transaction, a failing one logged by its employment and the
// rest going on. A rerun changes nothing (idempotent); an employment with no assignment in effect (one written before People, an
// ended one) is left as it is.
function applyDueAssignments(p) {
    const at = nowMs()
    let query = find(ASSIGNMENT).condition("isPrimary", "Y")
    const only = Array.from(p.partyRelationshipIds || [])
        .map(String)
        .filter(Boolean)
    if (only.length) query = query.condition("partyRelationshipId", "in", only)
    const due = Array.from(people.current(query, at).list())
    const failedList = []
    let applied = 0
    const pageSize = 200
    for (let start = 0; start < due.length; start += pageSize) {
        const page = due.slice(start, start + pageSize)
        const employments = new Map(
            Array.from(
                find(EMPLOYMENT)
                    .condition(
                        "partyRelationshipId",
                        "in",
                        page.map(row => row.partyRelationshipId)
                    )
                    .list()
            ).map(row => [row.partyRelationshipId, row])
        )
        for (const assignment of page) {
            const row = employments.get(assignment.partyRelationshipId)
            if (!row || (row.emplPositionId || null) === (assignment.emplPositionId || null)) continue
            ec.message.pushErrors()
            try {
                ec.service
                    .sync()
                    .name("update#" + EMPLOYMENT)
                    .parameters({
                        partyRelationshipId: assignment.partyRelationshipId,
                        emplPositionId: assignment.emplPositionId || null
                    })
                    .requireNewTransaction(true)
                    .disableAuthz()
                    .call()
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                applied++
            } catch (error) {
                ec.logger.error(
                    "The seat of employment " +
                        assignment.partyRelationshipId +
                        " was not set from its assignment: " +
                        error.message
                )
                failedList.push({partyRelationshipId: assignment.partyRelationshipId, message: String(error.message)})
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
    }
    // F134: the employers whose separation or manager change has come since it was applied (dated later) route their waiting
    // People decisions again on its date, each employer in its own transaction (a leaver decides nothing from then)
    const rerouted = rerouteDueChanges(failedList)
    return {applied, rerouted, failed: failedList.length, failedList}
}
const rerouteKinds = ["EckSeparation", "EckManager", "EckTransfer", "EckReorganization"]
function rerouteDueChanges(failedList) {
    const due = Array.from(
        find(CHANGE)
            .condition("changeKindEnumId", "in", rerouteKinds)
            .condition("statusId", "EchApplied")
            .condition("reroutedDate", "is-null", null)
            .condition("effectiveDate", "less-equals", ec.user.nowTimestamp)
            .selectField("employmentChangeId,organizationPartyId,partyId,changeKindEnumId")
            .list()
    )
    const byOrganization = new Map()
    for (const row of due)
        (
            byOrganization.get(row.organizationPartyId) ||
            byOrganization.set(row.organizationPartyId, []).get(row.organizationPartyId)
        ).push(row.employmentChangeId)
    let rerouted = 0
    for (const [organizationPartyId, changeIds] of byOrganization) {
        ec.message.pushErrors()
        try {
            ec.transaction.runRequireNew(null, "Error routing the People decisions of " + organizationPartyId + " again", () => {
                approvals().reroute(organizationPartyId)
                // P21: and the confidential cases whose handler left (PeopleCases.js rerouteCases)
                cases().rerouteCases(
                    organizationPartyId,
                    due
                        .filter(row => row.organizationPartyId === organizationPartyId)
                        .filter(row => row.changeKindEnumId === "EckSeparation")
                        .map(row => row.partyId)
                )
                for (const employmentChangeId of changeIds)
                    call("update#" + CHANGE, {employmentChangeId, reroutedDate: ec.user.nowTimestamp})
            })
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            rerouted++
        } catch (error) {
            ec.logger.error("The waiting People decisions of " + organizationPartyId + " were not routed again: " + error.message)
            failedList.push({organizationPartyId, message: String(error.message)})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return rerouted
}
// A new assignment of the employment from the date with the terms (and state): the one in effect ends on the date (audited with
// the reason) and the projections follow, from the terms before (the caller's, else those in effect) to the new ones.
function startAssignment(employment, terms, at, thruMs, options = {}) {
    const before = options.before || termsAt(employment, at)
    const reason = options.reason || null
    if (before.assignment)
        call("update#" + ASSIGNMENT, {
            employmentAssignmentId: before.assignment.employmentAssignmentId,
            thruDate: stamp(at),
            thruDate_changeReason: reason
        })
    const end = Math.min(thruMs ?? Infinity, employment.thruMs ?? Infinity)
    const created = call(
        "create#" + ASSIGNMENT,
        Object.assign(
            {
                partyRelationshipId: employment.partyRelationshipId,
                partyId: employment.partyId,
                organizationPartyId: employment.organizationPartyId,
                fromDate: stamp(at),
                thruDate: end === Infinity ? null : stamp(end),
                isPrimary: "Y",
                stateEnumId: options.stateEnumId || "EasActive",
                employmentChangeId: options.employmentChangeId || null,
                comments: reason
            },
            termsOfRow(terms)
        )
    )
    // the membership and the seat to the assignment's end (a later assignment set already takes them on from there)
    project(employment, before, terms, at, end === Infinity ? null : end, reason)
    return created.employmentAssignmentId
}

// ===== changes =====
const changeOf = employmentChangeId => one(CHANGE, {employmentChangeId})
function createChange(employment, kindEnumId, values) {
    return call(
        "create#" + CHANGE,
        Object.assign(
            {
                partyRelationshipId: employment.partyRelationshipId,
                partyId: employment.partyId,
                organizationPartyId: employment.organizationPartyId,
                changeKindEnumId: kindEnumId,
                requestedByUserId: ec.user.userId,
                requestedDate: ec.user.nowTimestamp
            },
            values
        )
    ).employmentChangeId
}
// The changes of the employment still waiting, other than one, superseded (their requests too, with their notices read): a change
// applied to the employment, or a new one asked for, replaces them.
// P23: a pay change supersedes only a pay change waiting, and any other change but a separation leaves a waiting pay change as it is
function supersedeWaiting(partyRelationshipId, exceptId = null, kindEnumId = null) {
    let superseded = 0
    for (const row of rows(CHANGE, {partyRelationshipId, statusId: "EchRequested"})) {
        if (row.employmentChangeId === exceptId) continue
        if (kindEnumId && kindEnumId !== "EckSeparation" && (row.changeKindEnumId === payKind) !== (kindEnumId === payKind))
            continue
        call("update#" + CHANGE, {employmentChangeId: row.employmentChangeId, statusId: "EchSuperseded"})
        approvals().sourceChanged(kindOfChange(row), row.employmentChangeId)
        superseded++
    }
    return superseded
}
// ===== a scheduled change withdrawn (P7, F131) =====
// The part of an applied change set for a date still to come withdrawn: its scheduled assignments end on their own start (they
// never take effect; dated rows are ended, never deleted), the assignment before continues to where they ended, and the
// projections go back: the department membership, the seat and the reporting line the change would have moved start never, and
// those it ended on its date continue (the seat refused when another holds it then, POSITION_OCCUPIED). A change wholly
// scheduled is Withdrawn (when, by whom, why, and the separation that superseded it); a leave of absence already begun keeps it
// and loses only its return (returnDate cleared). Refuses a change in effect (CHANGE_IN_EFFECT) and one a later change follows
// (LATER_CHANGE_SCHEDULED: that one first).
function withdrawScheduled(change, reason, supersededById = null) {
    const employment = employmentOf(one(RELATIONSHIP, {partyRelationshipId: change.partyRelationshipId}))
    const now = nowMs()
    const all = assignmentsOf(employment.partyRelationshipId)
    const own = all.filter(row => row.employmentChangeId === change.employmentChangeId)
    const scheduled = own.filter(row => (ms(row.fromDate) ?? -Infinity) > now)
    if (!scheduled.length) denied("CHANGE_IN_EFFECT", "This change is in effect already; make a new change instead")
    const fromMs = ms(scheduled[0].fromDate)
    const following = all.filter(
        row => (ms(row.fromDate) ?? -Infinity) > fromMs && row.employmentChangeId !== change.employmentChangeId
    )
    if (following.length)
        denied(
            "LATER_CHANGE_SCHEDULED",
            "A change from " + dateText(following[0].fromDate) + " follows it; withdraw that one first"
        )
    const endMs = ms(scheduled[scheduled.length - 1].thruDate)
    const prior = all.find(row => !scheduled.includes(row) && ms(row.thruDate) === fromMs) || null
    const before = prior ? termsOfRow(prior) : termsOfRow(termsAt(employment, fromMs - 1))
    const withdrawn = termsOfRow(scheduled[0])
    if (before.emplPositionId && before.emplPositionId !== withdrawn.emplPositionId) {
        const findings = []
        checkTerms(employment, {emplPositionId: before.emplPositionId}, fromMs, findings)
        refuseErrors(findings.filter(finding => finding.code === "POSITION_OCCUPIED"))
    }
    const why = text(reason) || "Withdrawn"
    for (const row of scheduled)
        call("update#" + ASSIGNMENT, {
            employmentAssignmentId: row.employmentAssignmentId,
            thruDate: row.fromDate,
            thruDate_changeReason: "Withdrawn: " + why
        })
    if (prior)
        call("update#" + ASSIGNMENT, {
            employmentAssignmentId: prior.employmentAssignmentId,
            thruDate: stamp(endMs),
            thruDate_changeReason: "Continues: " + why
        })
    restoreProjections(employment, withdrawn, before, fromMs, endMs, why)
    const whole = scheduled.length === own.length
    call(
        "update#" + CHANGE,
        whole
            ? {
                  employmentChangeId: change.employmentChangeId,
                  statusId: "EchWithdrawn",
                  withdrawnDate: ec.user.nowTimestamp,
                  withdrawnByUserId: ec.user.userId || null,
                  withdrawReason: why,
                  supersededByChangeId: supersededById
              }
            : {
                  employmentChangeId: change.employmentChangeId,
                  returnDate: null,
                  withdrawReason: "The return of " + dateText(fromMs) + " was withdrawn: " + why,
                  supersededByChangeId: supersededById
              }
    )
    return {employmentChangeId: change.employmentChangeId, whole}
}
// The projections of withdrawn terms back to the terms before, from the date: a row the withdrawn terms started then ends on its
// own start; a row of the terms before that ended then continues to endMs (the line has no end), else one starts.
function restoreProjections(employment, withdrawn, before, at, endMs, reason) {
    const partyId = employment.partyId
    const startedThen = list => list.filter(row => ms(row.fromDate) === at && (ms(row.thruDate) ?? Infinity) > at)
    const endedThen = list => list.filter(row => ms(row.thruDate) === at)
    if (withdrawn.departmentPartyId !== before.departmentPartyId) {
        const members = toPartyId =>
            rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtMember", fromPartyId: partyId, toPartyId, fromRoleTypeId: "Assignee"})
        if (withdrawn.departmentPartyId)
            for (const row of startedThen(members(withdrawn.departmentPartyId))) endRow(row, at, reason)
        if (before.departmentPartyId) {
            const ended = endedThen(members(before.departmentPartyId))
            if (ended.length)
                for (const row of ended)
                    call("update#" + RELATIONSHIP, {
                        partyRelationshipId: row.partyRelationshipId,
                        thruDate: stamp(endMs),
                        thruDate_changeReason: reason
                    })
            else moveMembership(partyId, null, before.departmentPartyId, at, endMs, reason)
        }
    }
    if (withdrawn.emplPositionId !== before.emplPositionId) {
        const holdings = emplPositionId => rows(HOLDER, {emplPositionId, partyId, roleTypeId: "Employee"})
        const setThru = (row, thru) =>
            call("update#" + HOLDER, {
                emplPositionId: row.emplPositionId,
                partyId: row.partyId,
                roleTypeId: row.roleTypeId,
                fromDate: row.fromDate,
                thruDate: thru,
                comments: [row.comments, reason].filter(Boolean).join("; ") || null
            })
        if (withdrawn.emplPositionId)
            for (const row of startedThen(holdings(withdrawn.emplPositionId))) setThru(row, row.fromDate)
        if (before.emplPositionId) {
            const ended = endedThen(holdings(before.emplPositionId))
            if (ended.length) for (const row of ended) setThru(row, stamp(endMs))
            else positions().holdSeat(one(POSITION, {emplPositionId: before.emplPositionId}), partyId, at, endMs, reason)
        }
    }
    if (withdrawn.managerPartyId !== before.managerPartyId) {
        const lines = fromPartyId => rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtManager", fromPartyId, toPartyId: partyId})
        if (withdrawn.managerPartyId) for (const row of startedThen(lines(withdrawn.managerPartyId))) endRow(row, at, reason)
        if (before.managerPartyId)
            for (const row of endedThen(lines(before.managerPartyId)))
                call("update#" + RELATIONSHIP, {
                    partyRelationshipId: row.partyRelationshipId,
                    thruDate: null,
                    thruDate_changeReason: reason
                })
    }
}
// ===== a separation set for a later date withdrawn (the user's call, Nov 11) =====
// Before its date, as the other scheduled changes: the employment's end goes back to what it was (priorThruDate), its termination
// reason and type are cleared, the assignment it ended continues, and so do the department membership, the seat and the line it
// ended on its date, and the person's memberships of the employer's units ended then; each report's manager change it made
// (causedByChangeId) is withdrawn, so their assignments keep the manager, and a line it ended goes on. Nothing of the access end
// is done (Admin's operation is Withdrawn: its waiting steps skipped, what it ended at the date continued) and its checklists' and
// equipment return's work is cancelled. The scheduled changes it withdrew when applied stay withdrawn (made again if wanted).
// Refuses one in effect (CHANGE_IN_EFFECT) and one whose employment changed its end since (NOT_WITHDRAWABLE).
function withdrawSeparation(change, employment, reason) {
    const now = nowMs()
    const at = ms(change.effectiveDate)
    if (at == null || at <= now) denied("CHANGE_IN_EFFECT", "This separation is in effect already; hire the person again instead")
    if (employment.thruMs !== at)
        denied("NOT_WITHDRAWABLE", "The employment's end changed since the separation; change it from the employment")
    const why = "Withdrawn: " + reason
    const priorMs = ms(change.priorThruDate) ?? null
    const ended = assignmentsOf(employment.partyRelationshipId)
        .filter(row => ms(row.thruDate) === at)
        .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))[0]
    const before = ended ? termsOfRow(ended) : termsOfRow(termsAt(employment, at - 1))
    call("update#" + RELATIONSHIP, {
        partyRelationshipId: employment.partyRelationshipId,
        thruDate: stamp(priorMs),
        thruDate_changeReason: why
    })
    call("update#" + EMPLOYMENT, {
        partyRelationshipId: employment.partyRelationshipId,
        terminationReasonEnumId: null,
        terminationTypeEnumId: null,
        terminationReasonEnumId_changeReason: why,
        terminationTypeEnumId_changeReason: why
    })
    if (ended)
        call("update#" + ASSIGNMENT, {
            employmentAssignmentId: ended.employmentAssignmentId,
            thruDate: stamp(priorMs),
            thruDate_changeReason: why
        })
    restoreProjections(
        Object.assign({}, employment, {thruMs: priorMs}),
        {departmentPartyId: null, emplPositionId: null, managerPartyId: null},
        before,
        at,
        priorMs,
        why
    )
    // the person's memberships of the employer's units it ended on its date go on
    const org = employment.organizationPartyId
    const units = people.unitsUnder([org])
    if (units.length)
        for (const row of Array.from(
            find(RELATIONSHIP)
                .condition({relationshipTypeEnumId: "PrtMember", fromPartyId: employment.partyId})
                .condition("toPartyId", "in", units)
                .list()
        ).filter(row => ms(row.thruDate) === at && (ms(row.fromDate) ?? -Infinity) < at))
            call("update#" + RELATIONSHIP, {
                partyRelationshipId: row.partyRelationshipId,
                thruDate: null,
                thruDate_changeReason: why
            })
    // the reports: their manager changes made by the separation withdrawn, and a line it ended (a report with no assignment) on
    for (const report of rows(CHANGE, {causedByChangeId: change.employmentChangeId, statusId: "EchApplied"}))
        withdrawScheduled(report, reason)
    for (const line of rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtManager", fromPartyId: employment.partyId}).filter(
        row => ms(row.thruDate) === at && (ms(row.fromDate) ?? -Infinity) < at
    ))
        call("update#" + RELATIONSHIP, {
            partyRelationshipId: line.partyRelationshipId,
            thruDate: null,
            thruDate_changeReason: why
        })
    call("update#" + CHANGE, {
        employmentChangeId: change.employmentChangeId,
        statusId: "EchWithdrawn",
        withdrawnDate: ec.user.nowTimestamp,
        withdrawnByUserId: ec.user.userId || null,
        withdrawReason: reason
    })
    // no access end and no offboarding work: Admin's operation withdrawn, the checklists' and return's tasks cancelled
    ec.resource
        .script("component://mr-mantle/service/mantle/party/Lifecycle.js")
        .withdrawAccessEnd(change.employmentChangeId, reason)
    ec.resource.script("component://mr-mantle/service/mantle/humanres/Checklists.js").cancelChecklists(change.employmentChangeId)
    return {employmentChangeId: change.employmentChangeId, whole: true}
}
// withdraw#EmploymentChange: an applied change of an employment in the caller's scope whose date is still to come (a transfer, a
// manager change, a leave of absence or its return date, a return, a reorganization) withdrawn by an HR editor with a reason, at
// the employment's revision read when given; the employment's waiting changes superseded (asked at the revision before), but
// for a working schedule's, which keeps them waiting with their approval (P9).
function withdrawEmploymentChange(p) {
    const userScope = editorScope("Withdrawing a change")
    const change = changeOf(text(p.employmentChangeId))
    if (!change) denied("RECORD_UNAVAILABLE", "Employment change " + text(p.employmentChangeId) + " is not available")
    const employment = employmentIn(userScope, change.partyRelationshipId)
    if (change.statusId !== "EchApplied" || !withdrawableKinds.includes(change.changeKindEnumId) || change.causedByChangeId)
        denied(
            "NOT_WITHDRAWABLE",
            "Only a transfer, manager change, leave, return, separation or working schedule set for a later date is withdrawn"
        )
    if (text(p.expectedRevision) && text(p.expectedRevision) !== people.employmentRevision(employment.partyRelationshipId))
        denied("REVISION_CHANGED", "This employment changed since you read it; open it again")
    if (!text(p.reason)) denied("REASON_REQUIRED", "Say why")
    const withdraw = () =>
        change.changeKindEnumId === "EckSeparation"
            ? withdrawSeparation(change, employment, text(p.reason))
            : withdrawScheduled(change, text(p.reason))
    let done
    if (change.changeKindEnumId === "EckSchedule") {
        // a working schedule withdrawn leaves the changes waiting as they were, as its assignment did (P9)
        const waiting = rows(CHANGE, {partyRelationshipId: employment.partyRelationshipId, statusId: "EchRequested"})
        done = approvals().keepWaiting(
            approvalKind,
            waiting.filter(row => row.changeKindEnumId !== payKind).map(row => row.employmentChangeId),
            () => {
                const out = withdraw()
                carrySchedule(employment, waiting)
                return out
            }
        )
    } else {
        done = withdraw()
        supersedeWaiting(employment.partyRelationshipId, null, change.changeKindEnumId)
    }
    const after = changeOf(change.employmentChangeId)
    return {
        employmentChangeId: after.employmentChangeId,
        statusId: after.statusId,
        statusText: statusTexts[after.statusId],
        whole: done.whole
    }
}

// note#AccessRequestFailure: why an app's provisioning or access end request for an applied hire or separation failed, on the
// change (P7: logged against the employment and retried by key; the hire or change stands), for the change's requester, an HR
// editor of its employer or the one whose decision applied it; anyone else is refused alike (RECORD_UNAVAILABLE).
function noteAccessRequestFailure(p) {
    const change = changeOf(text(p.employmentChangeId))
    const unavailable = () =>
        denied("RECORD_UNAVAILABLE", "Employment change " + text(p.employmentChangeId) + " is not available")
    if (!change || change.statusId !== "EchApplied" || !["EckHire", "EckSeparation"].includes(change.changeKindEnumId))
        unavailable()
    const userScope = people.scopeOf()
    const decided = () => {
        const approvalIds = rows("mantle.humanres.approval.PeopleApproval", {
            approvalKindEnumId: approvalKind,
            sourceId: change.employmentChangeId
        }).map(row => row.peopleApprovalId)
        return (
            approvalIds.length > 0 &&
            find("mantle.humanres.approval.PeopleApprovalDecision")
                .condition("peopleApprovalId", "in", approvalIds)
                .condition("decidedByUserId", ec.user.userId)
                .count() > 0
        )
    }
    const allowed =
        (!!ec.user.userId && change.requestedByUserId === ec.user.userId) ||
        (userScope.capabilities.hrEdit && userScope.organizationPartyIds.includes(change.organizationPartyId)) ||
        decided()
    if (!allowed) unavailable()
    call("update#" + CHANGE, {
        employmentChangeId: change.employmentChangeId,
        accessRequestFailure: text(p.failure).slice(0, 2000) || "The request failed",
        accessRequestDate: ec.user.nowTimestamp
    })
    ec.logger.error(
        "The access request of employment " +
            change.partyRelationshipId +
            " (change " +
            change.employmentChangeId +
            ") failed: " +
            text(p.failure)
    )
    return {noted: true}
}

// A change applied: its terms written from its date (the checks again, as of now, refusing what changed since it was asked), its
// row Applied with the assignment it started, the employment's other waiting changes superseded and, when a manager or the
// employment ended, the employer's waiting People decisions routed again.
function applyChange(change) {
    const relationship = one(RELATIONSHIP, {partyRelationshipId: change.partyRelationshipId})
    const employment = employmentOf(relationship)
    const at = ms(change.effectiveDate)
    const kind = change.changeKindEnumId
    const reason = change.reason || kindTexts[kind]
    const findings = []
    // P23: a pay change writes the salary from its date (the row in effect ends there), checked again, and moves no assignment
    if (kind === payKind) {
        if ((employment.fromMs ?? -Infinity) > at || (employment.thruMs ?? Infinity) <= at)
            denied("DATE_OUTSIDE", "The date is outside the employment")
        payroll().writeSalary(
            change.partyRelationshipId,
            {
                fromMs: at,
                amount: change.salaryAmount,
                currencyUomId: change.salaryCurrencyUomId,
                timePeriodTypeId: change.salaryPeriodTypeId,
                payGradeId: change.payGradeId || null
            },
            reason
        )
        call("update#" + CHANGE, {
            employmentChangeId: change.employmentChangeId,
            statusId: "EchApplied",
            appliedDate: ec.user.nowTimestamp
        })
        supersedeWaiting(change.partyRelationshipId, change.employmentChangeId, payKind)
        return {employmentAssignmentId: null}
    }
    // a separation supersedes the changes set for its date or later, a return the leave's scheduled return (P7, F131)
    const allow = supersedesFor(kind)
    // a working schedule from the day the assignment in effect starts changes that assignment's (P9)
    const kept = kind === "EckSchedule" ? sameStart(employment, at) : null
    checkDate(
        employment,
        at,
        findings,
        allow || (kept ? row => row.employmentAssignmentId === kept.employmentAssignmentId : null)
    )
    if (allow && !firstError(findings)) supersedeScheduled(employment, at, allow, change.employmentChangeId, reason)
    const before = termsAt(employment, at)
    let assignmentId = null
    // the working schedule the change applied, when it carries terms (P9: a transfer takes the schedule in effect on its date)
    let applied = {}
    if (kind === "EckSeparation") {
        refuseErrors(findings)
        // the employment's end before it, given back if a separation set for later is withdrawn (the user's call, Nov 11)
        call("update#" + CHANGE, {employmentChangeId: change.employmentChangeId, priorThruDate: stamp(employment.thruMs ?? null)})
        separate(employment, change, before, at, reason)
    } else if (kind === "EckLeave" || kind === "EckReturn") {
        if (kind === "EckLeave" && before.stateEnumId === "EasLeave")
            findings.push({code: "ALREADY_ON_LEAVE", severity: "error", message: "The person is on leave already"})
        if (kind === "EckReturn" && before.stateEnumId !== "EasLeave")
            findings.push({code: "NOT_ON_LEAVE", severity: "error", message: "The person is not on leave then"})
        refuseErrors(findings)
        const returnMs = ms(change.returnDate)
        assignmentId = startAssignment(employment, before, at, kind === "EckLeave" ? returnMs : null, {
            before,
            reason,
            employmentChangeId: change.employmentChangeId,
            stateEnumId: kind === "EckLeave" ? "EasLeave" : "EasActive"
        })
        // a leave with its return date: working again from it, on the same terms
        if (kind === "EckLeave" && returnMs != null && returnMs < (employment.thruMs ?? Infinity))
            startAssignment(employment, before, returnMs, null, {
                before: Object.assign({}, before, {assignment: null}),
                reason: "Return from leave",
                employmentChangeId: change.employmentChangeId
            })
    } else if (kind === "EckSchedule") {
        // P9: the working schedule alone changes; the other terms continue as they are, in the state they are in
        refuseErrors(findings)
        const schedule = {
            workingScheduleId: change.workingScheduleId || null,
            holidayCategoryId: change.holidayCategoryId || null
        }
        if (kept) {
            // the assignment starting on the date (a hire's first day) follows it from its start: changed in place, audited
            call("update#" + ASSIGNMENT, {
                employmentAssignmentId: kept.employmentAssignmentId,
                workingScheduleId: schedule.workingScheduleId,
                workingScheduleId_changeReason: reason,
                holidayCategoryId: schedule.holidayCategoryId,
                holidayCategoryId_changeReason: reason
            })
            assignmentId = kept.employmentAssignmentId
        } else
            assignmentId = startAssignment(employment, Object.assign(termsOfRow(before), schedule), at, null, {
                before,
                reason,
                employmentChangeId: change.employmentChangeId,
                stateEnumId: before.stateEnumId || "EasActive"
            })
    } else {
        // the working schedule is not the change's to give (assign#Schedule's alone): the one in effect on the date continues,
        // so a schedule assigned while the change waited is kept (P9)
        applied = Object.fromEntries(scheduleFields.map(field => [field, before[field] || null]))
        const terms = checkTerms(employment, Object.assign(termsOfRow(change), applied), at, findings)
        refuseErrors(findings)
        assignmentId = startAssignment(employment, terms, at, null, {
            before,
            reason,
            employmentChangeId: change.employmentChangeId
        })
    }
    call(
        "update#" + CHANGE,
        Object.assign(
            {
                employmentChangeId: change.employmentChangeId,
                statusId: "EchApplied",
                appliedDate: ec.user.nowTimestamp,
                employmentAssignmentId: assignmentId
            },
            applied
        )
    )
    // a working schedule leaves the changes waiting as they were (assign#Schedule keeps their approval, P9); any other change
    // supersedes them
    if (kind !== "EckSchedule") supersedeWaiting(change.partyRelationshipId, change.employmentChangeId, kind)
    if (kind === "EckSeparation" || before.managerPartyId !== (change.managerPartyId || null))
        approvals().reroute(employment.organizationPartyId)
    // P21 (the user's call of Nov 12, 2026): a leaver's confidential cases there go back to the employer's intake handlers, once
    // the separation is in effect (a later one by the daily job on its date, below)
    if (kind === "EckSeparation" && at <= nowMs()) cases().rerouteCases(employment.organizationPartyId, [change.partyId])
    // routed again from its date: now for a change in effect, else by the daily job on the date (F134)
    if (at <= nowMs())
        call("update#" + CHANGE, {employmentChangeId: change.employmentChangeId, reroutedDate: ec.user.nowTimestamp})
    return {employmentAssignmentId: assignmentId}
}
// A separation from the date: the assignment and its projections end, the employment ends with its termination reason and type,
// the person's lead and team memberships at the employer end, each report whose assignment there names them continues with no
// manager (and a line they manage there without assignments ends unless still used elsewhere). Another employer's employment
// is left alone.
function separate(employment, change, before, at, reason) {
    const org = employment.organizationPartyId
    const partyId = employment.partyId
    if (before.assignment)
        call("update#" + ASSIGNMENT, {
            employmentAssignmentId: before.assignment.employmentAssignmentId,
            thruDate: stamp(at),
            thruDate_changeReason: reason
        })
    call("update#" + RELATIONSHIP, {
        partyRelationshipId: employment.partyRelationshipId,
        thruDate: stamp(at),
        thruDate_changeReason: reason
    })
    // the membership, the seat and the line end with the employment (Employment.emplPositionId keeps the last seat, its history)
    const ended = Object.assign({}, employment, {thruMs: at})
    project(ended, before, {departmentPartyId: null, emplPositionId: null, managerPartyId: null}, at, at, reason, true)
    call("update#" + EMPLOYMENT, {
        partyRelationshipId: employment.partyRelationshipId,
        terminationReasonEnumId: change.terminationReasonEnumId || null,
        terminationTypeEnumId: change.terminationTypeEnumId || null,
        terminationReasonEnumId_changeReason: reason,
        terminationTypeEnumId_changeReason: reason
    })
    // the person's memberships of the employer's units (a lead's, a team's) end, one starting later on its own start (never in
    // effect)
    const units = people.unitsUnder([org])
    if (units.length)
        for (const row of Array.from(
            find(RELATIONSHIP)
                .condition({relationshipTypeEnumId: "PrtMember", fromPartyId: partyId})
                .condition("toPartyId", "in", units)
                .list()
        ).filter(row => (ms(row.thruDate) ?? Infinity) > at))
            endRow(row, Math.max(at, ms(row.fromDate) ?? at), reason)
    // the reports at the employer: an assignment naming the leaver continues with no manager; a line they manage with no
    // assignment ends unless another employment of the report uses it
    const reportAssignments = Array.from(
        find(ASSIGNMENT).condition({organizationPartyId: org, managerPartyId: partyId, isPrimary: "Y"}).list()
    ).filter(row => openAt(row, at) && (ms(row.fromDate) ?? -Infinity) < at)
    for (const row of reportAssignments) {
        const reportEmployment = employmentOf(one(RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId}))
        const reportBefore = Object.assign(termsOfRow(row), {assignment: row})
        const changeId = createChange(reportEmployment, "EckManager", {
            statusId: "EchApplied",
            effectiveDate: stamp(at),
            departmentPartyId: row.departmentPartyId,
            emplPositionId: row.emplPositionId,
            managerPartyId: null,
            facilityId: row.facilityId,
            reason: "The manager left",
            appliedDate: ec.user.nowTimestamp,
            // withdrawn with the separation (the user's call, Nov 11)
            causedByChangeId: change.employmentChangeId
        })
        const assignmentId = startAssignment(
            reportEmployment,
            Object.assign({}, reportBefore, {managerPartyId: null}),
            at,
            null,
            {
                before: reportBefore,
                reason: "The manager left",
                employmentChangeId: changeId,
                stateEnumId: row.stateEnumId
            }
        )
        call("update#" + CHANGE, {employmentChangeId: changeId, employmentAssignmentId: assignmentId})
        supersedeWaiting(row.partyRelationshipId)
    }
    const assignedReports = new Set(reportAssignments.map(row => row.partyId))
    for (const line of rows(RELATIONSHIP, {relationshipTypeEnumId: "PrtManager", fromPartyId: partyId}).filter(
        row => openAt(row, at) && (ms(row.fromDate) ?? -Infinity) < at && !assignedReports.has(row.toPartyId)
    )) {
        const employedHere = people.employersOfParties([line.toPartyId], at)[line.toPartyId] || []
        if (employedHere.includes(org) && !people.assignmentsAt([line.toPartyId], at)[org + "/" + line.toPartyId])
            if (!lineInUse(line.toPartyId, partyId, org, at)) endRow(line, at, reason)
    }
}

// ===== preview#Hire and hire#Employee =====
// The people who may be the person hired (People's own search, with the filters off and their public identity only, F59; the
// user's call, Nov 11): a name (the name searched, two characters at least, or the first and last names given) finds only people
// with a relationship to one of the caller's employers (an employee, a contractor, a contact, an applicant to one of their
// positions; any dates); anyone else is found only by an exact email (the work email given, or a searched term that is an email),
// so a person another employer employs is found and not made again. Each with their relationships with the employer (never
// another employer's).
function matchesOf(p, organizationPartyId, userScope) {
    const factory = ec.entity.conditionFactory
    const conditions = []
    const term = text(p.term)
    const termEmail = isEmail(term) ? term : ""
    if (term.length >= matchMinLength && !termEmail)
        conditions.push(
            factory.makeCondition(
                ["firstName", "lastName", "nickname"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    if (text(p.firstName) && text(p.lastName))
        conditions.push(
            factory.makeCondition(
                factory.makeCondition("firstName", "like", text(p.firstName)).ignoreCase(),
                "and",
                factory.makeCondition("lastName", "like", text(p.lastName)).ignoreCase()
            )
        )
    const byEmail = new Set()
    for (const email of unique([text(p.workEmail), termEmail].filter(Boolean)))
        for (const partyId of personsByEmail(email)) byEmail.add(partyId)
    const partyIds = new Set(byEmail)
    if (conditions.length)
        for (const partyId of relatedByName(factory.makeCondition(conditions, "or"), userScope.organizationPartyIds))
            partyIds.add(partyId)
    const ids = Array.from(partyIds).slice(0, matchLimit)
    if (!ids.length) return []
    const persons = Object.fromEntries(
        Array.from(find("mantle.party.Person").condition("partyId", "in", ids).list()).map(row => [row.partyId, row])
    )
    return ids
        .filter(partyId => persons[partyId])
        .map(partyId => {
            const person = persons[partyId]
            const relationships = organizationPartyId ? relationshipsWith(partyId, organizationPartyId) : []
            return {
                partyId,
                personName: [person.firstName, person.lastName].filter(Boolean).join(" ") || partyId,
                preferredName: person.nickname || "",
                matchedBy: byEmail.has(partyId) ? "email" : "name",
                employedNow: relationships.some(row => row.kind === "employment" && row.state === "current"),
                relationshipText: relationships.map(row => row.typeText + " (" + row.stateText.toLowerCase() + ")").join(", ")
            }
        })
}
const isEmail = value => /^[^\s@]+@[^\s@]+$/.test(value)
// The people whose work or primary email is the address, exactly (ignoring case).
function personsByEmail(email) {
    const factory = ec.entity.conditionFactory
    const mechIds = Array.from(
        find("mantle.party.contact.ContactMech")
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .condition(factory.makeCondition("infoString", "equals", email).ignoreCase())
            .selectField("contactMechId")
            .limit(matchLimit)
            .list()
    ).map(row => row.contactMechId)
    if (!mechIds.length) return []
    return unique(
        Array.from(
            people
                .current(
                    find("mantle.party.contact.PartyContactMech")
                        .condition("contactMechId", "in", mechIds)
                        .condition("contactMechPurposeId", "in", ["EmailWork", "EmailPrimary"]),
                    null
                )
                .list()
        ).map(row => row.partyId)
    )
}
// The people matching the name condition (on Person's names) with a relationship of any type and dates to one of the employers,
// either way, or an application to one of their positions; the first matchLimit by name.
function relatedByName(nameCondition, organizationPartyIds) {
    if (!organizationPartyIds.length) return []
    const found = []
    const add = (list, idField) => {
        for (const row of list) found.push({partyId: row[idField], name: [row.firstName, row.lastName].join(" ")})
    }
    const related = (view, personField, organizationField) =>
        Array.from(
            find(view)
                .condition(organizationField, "in", organizationPartyIds)
                .condition(nameCondition)
                .selectField([personField, "firstName", "lastName"])
                .distinct(true)
                .orderBy(["firstName", "lastName"])
                .limit(matchLimit)
                .list()
        )
    add(related("mantle.party.PartyFromAndRelationship", "fromPartyId", "toPartyId"), "fromPartyId")
    add(related("mantle.party.PartyToAndRelationship", "toPartyId", "fromPartyId"), "toPartyId")
    // the applicants to the employers' positions, and (P17) to their openings (an application names its employer, P16)
    const positionIds = Array.from(
        find(POSITION).condition("organizationPartyId", "in", organizationPartyIds).selectField("emplPositionId").list()
    ).map(row => row.emplPositionId)
    const factory = ec.entity.conditionFactory
    const applied = [factory.makeCondition("organizationPartyId", "in", organizationPartyIds)]
    if (positionIds.length) applied.push(factory.makeCondition("emplPositionId", "in", positionIds))
    const applicantIds = unique(
        Array.from(
            find("mantle.humanres.employment.EmploymentApplication")
                .condition(factory.makeCondition(applied, "or"))
                .selectField("applyingPartyId")
                .distinct(true)
                .list()
        )
            .map(row => row.applyingPartyId)
            .filter(Boolean)
    )
    if (applicantIds.length)
        add(
            Array.from(
                find("mantle.party.Person")
                    .condition("partyId", "in", applicantIds)
                    .condition(nameCondition)
                    .selectField(["partyId", "firstName", "lastName"])
                    .orderBy(["firstName", "lastName"])
                    .limit(matchLimit)
                    .list()
            ),
            "partyId"
        )
    return unique(
        found
            .filter(row => row.partyId)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(row => row.partyId)
    ).slice(0, matchLimit)
}
// Whether a chosen person is one the caller may hire by id: related to one of their employers (as relatedByName reads it), or
// matched by the exact email given. Anyone else is refused as missing (RECORD_UNAVAILABLE), so an id names no one.
function personAdmitted(partyId, p, userScope) {
    const orgIds = userScope.organizationPartyIds
    if (orgIds.length) {
        const related =
            find(RELATIONSHIP).condition("fromPartyId", partyId).condition("toPartyId", "in", orgIds).count() ||
            find(RELATIONSHIP).condition("toPartyId", partyId).condition("fromPartyId", "in", orgIds).count()
        if (related) return true
        // P17: an applicant to one of their openings (an application names its employer, P16)
        if (
            find("mantle.humanres.employment.EmploymentApplication")
                .condition("applyingPartyId", partyId)
                .condition("organizationPartyId", "in", orgIds)
                .count()
        )
            return true
        const positionIds = Array.from(
            find(POSITION).condition("organizationPartyId", "in", orgIds).selectField("emplPositionId").list()
        ).map(row => row.emplPositionId)
        if (
            positionIds.length &&
            find("mantle.humanres.employment.EmploymentApplication")
                .condition("applyingPartyId", partyId)
                .condition("emplPositionId", "in", positionIds)
                .count()
        )
            return true
    }
    const term = text(p.term)
    return unique([text(p.workEmail), isEmail(term) ? term : ""].filter(Boolean)).some(email =>
        personsByEmail(email).includes(partyId)
    )
}
const relationshipTexts = {
    employment: "Employment",
    orphan: "Employee relationship with no employment record",
    contractor: "Contractor",
    other: "Relationship"
}
// The person's relationships with the employer, of any type (an employment, an orphan PrtEmployee relationship, a contractor's
// PrtAgent, a contact's), each with its state on the date.
function relationshipsWith(partyId, organizationPartyId, at = nowMs()) {
    const found = rows(RELATIONSHIP, {fromPartyId: partyId, toPartyId: organizationPartyId})
    const types = enumNames(found.map(row => row.relationshipTypeEnumId))
    const withEmployment = new Set(
        found.length
            ? Array.from(
                  find(EMPLOYMENT)
                      .condition(
                          "partyRelationshipId",
                          "in",
                          found.map(row => row.partyRelationshipId)
                      )
                      .list()
              ).map(row => row.partyRelationshipId)
            : []
    )
    return found
        .map(row => {
            const kind =
                row.relationshipTypeEnumId === "PrtEmployee"
                    ? withEmployment.has(row.partyRelationshipId)
                        ? "employment"
                        : "orphan"
                    : row.relationshipTypeEnumId === "PrtAgent"
                      ? "contractor"
                      : "other"
            const state =
                (ms(row.thruDate) ?? Infinity) <= at ? "ended" : (ms(row.fromDate) ?? -Infinity) > at ? "future" : "current"
            return {
                partyRelationshipId: row.partyRelationshipId,
                relationshipTypeEnumId: row.relationshipTypeEnumId,
                kind,
                typeText:
                    kind === "other" ? types[row.relationshipTypeEnumId] || relationshipTexts.other : relationshipTexts[kind],
                fromMs: ms(row.fromDate),
                thruMs: ms(row.thruDate),
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                state,
                stateText: {ended: "Ended", future: "Starts " + dateText(row.fromDate), current: "Current"}[state]
            }
        })
        .sort((a, b) => (b.fromMs ?? 0) - (a.fromMs ?? 0))
}
const overlaps = (row, fromMs, thruMs) => (row.fromMs ?? -Infinity) < (thruMs ?? Infinity) && (row.thruMs ?? Infinity) > fromMs
// The plan of a hire, checked: the person (chosen, or new with no person matching unless confirmed), the employment (new, an
// orphan relationship completed, or a rehire beside an ended one; an overlapping employment refused), the first assignment's
// terms, and the findings (errors refuse the hire; warnings and notes inform it). P17: a hire from an accepted offer
// (employmentOfferId; the offer locked by hire#Employee) is of its employer and applicant, and once (Offers.js hireProblem:
// OFFER_USED, OFFER_NOT_ACCEPTED, OFFER_PERSON, OFFER_EMPLOYER); its working schedule follows the hire.
// P23 review: whether an offer carries pay approved with it (an amount and a currency on an offer approved before it was accepted)
const offerPay = offer => !!offer && offer.payAmount != null && !!offer.currencyUomId && !!offer.approvedDate
function planHire(p, userScope, lockedOffer = null) {
    const findings = []
    const offer = lockedOffer || (text(p.employmentOfferId) ? offers().offerForHire(p.employmentOfferId, userScope) : null)
    const organizationPartyId = text(p.organizationPartyId) || offer?.organizationPartyId || ""
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
    // a term not given (null): the offer's, for a hire from one
    const term = field => (p[field] != null ? p[field] : (offer?.[field] ?? null))
    if (offer) {
        const problem = offers().hireProblem(offer, text(p.partyId) || null, organizationPartyId)
        if (problem) findings.push({code: problem[0], severity: "error", message: problem[1]})
        else
            findings.push({
                code: "FROM_OFFER",
                severity: "info",
                message: "From the accepted offer " + offer.employmentOfferId + ": it is hired from once"
            })
        // P23 review: the offer's approved pay becomes the first salary (named without its amount: HR reads no pay)
        if (!problem && offerPay(offer))
            findings.push({
                code: "OFFER_PAY",
                severity: "info",
                message: "The offer's approved pay becomes the employment's first salary from its first day"
            })
    }
    const fromMs = effective(term("fromDate"))
    const thruMs = text(term("thruDate")) ? effective(term("thruDate")) : null
    if (thruMs != null && thruMs <= fromMs)
        findings.push({code: "DATES_INVALID", severity: "error", message: "The end is after the start"})
    let person = null
    const partyId = text(p.partyId) || offer?.partyId || ""
    let matches = []
    if (partyId) {
        const found = one("mantle.party.Person", {partyId})
        // the applicant of the offer is admitted by it
        if (!found || (offer?.partyId !== partyId && !personAdmitted(partyId, p, userScope)))
            denied(
                "RECORD_UNAVAILABLE",
                "Person " + partyId + " is not available; a person not related to your employers is found by their exact email"
            )
        person = {
            partyId,
            personName: [found.firstName, found.lastName].filter(Boolean).join(" ") || partyId,
            preferredName: found.nickname || "",
            isNew: false
        }
    } else {
        matches = matchesOf(p, organizationPartyId, userScope)
        if (text(p.firstName) && text(p.lastName)) {
            person = {
                partyId: null,
                personName: text(p.firstName) + " " + text(p.lastName),
                preferredName: text(p.preferredName),
                isNew: true
            }
            if (matches.length && !truthy(p.confirmNewPerson))
                findings.push({
                    code: "PERSON_MATCHES",
                    severity: "error",
                    message:
                        matches.map(row => row.personName).join(", ") +
                        (matches.length === 1 ? " may be this person" : " may be this person") +
                        ": choose them, or confirm a new person"
                })
        } else if (!text(p.term))
            findings.push({code: "PERSON_REQUIRED", severity: "error", message: "Choose or name the person"})
    }
    const relationships = person?.partyId ? relationshipsWith(person.partyId, organizationPartyId) : []
    let plan = "new"
    let orphan = null
    if (person?.partyId) {
        const overlapping = relationships.filter(row => overlaps(row, fromMs, thruMs))
        if (overlapping.some(row => row.kind === "employment"))
            findings.push({
                code: "EMPLOYMENT_OVERLAP",
                severity: "error",
                message: person.personName + " is employed by this employer then already"
            })
        orphan = overlapping.find(row => row.kind === "orphan") || null
        if (orphan) {
            plan = "complete"
            findings.push({
                code: "ORPHAN_COMPLETED",
                severity: "info",
                message: "The employee relationship from " + orphan.fromDateText + " is completed; no second one is made"
            })
        } else if (relationships.some(row => row.kind === "employment" && row.state === "ended")) {
            plan = "rehire"
            findings.push({
                code: "REHIRE",
                severity: "info",
                message: "A rehire: the earlier employment is kept as it is"
            })
        }
        for (const row of relationships.filter(row => row.kind === "contractor" || row.kind === "other"))
            findings.push({
                code: "OTHER_RELATIONSHIP",
                severity: "info",
                message:
                    row.typeText + " since " + row.fromDateText + " (" + row.stateText.toLowerCase() + "); it is left as it is"
            })
    }
    // the employment the hire makes or completes, for the checks of its terms
    const employment = {
        partyRelationshipId: orphan?.partyRelationshipId || null,
        partyId: person?.partyId || "_NEW_",
        organizationPartyId,
        fromMs: orphan ? orphan.fromMs : fromMs,
        thruMs: orphan ? orphan.thruMs : thruMs
    }
    const assignmentFromMs = orphan ? Math.max(orphan.fromMs ?? -Infinity, fromMs) : fromMs
    const terms = checkTerms(
        employment,
        {
            departmentPartyId: text(term("departmentPartyId")) || null,
            emplPositionId: text(term("emplPositionId")) || null,
            managerPartyId: text(term("managerPartyId")) || null,
            facilityId: text(term("facilityId")) || null
        },
        assignmentFromMs,
        findings
    )
    // P17: the offer's working schedule, which the hire's first assignment follows
    if (offer?.workingScheduleId)
        attempt(findings, () => schedules().checkAssignable(offer.workingScheduleId, organizationPartyId, assignmentFromMs))
    if (!terms.managerPartyId)
        findings.push({code: "NO_MANAGER", severity: "warning", message: "No manager: the person is listed under No manager"})
    if (!terms.emplPositionId)
        findings.push({code: "NO_POSITION", severity: "warning", message: "No position: the person holds no seat"})
    findings.push({
        code: "PAY_SETUP",
        severity: "info",
        message: "Pay terms are payroll's: the hire records no salary, currency or pay group"
    })
    // P7: the employer's onboarding checklists, which start once the hire is made
    const onboarding = rows("mantle.humanres.checklist.ChecklistTemplate", {
        organizationPartyId,
        lifecycleKindEnumId: "ClkOnboarding"
    }).filter(row => openAt(row, nowMs()))
    if (onboarding.length) {
        const names = Object.fromEntries(
            Array.from(
                find("mantle.work.effort.WorkEffort")
                    .condition(
                        "workEffortId",
                        "in",
                        onboarding.map(row => row.workEffortId)
                    )
                    .list()
            ).map(row => [row.workEffortId, row.workEffortName])
        )
        findings.push({
            code: "CHECKLISTS",
            severity: "info",
            message:
                "Onboarding starts once hired: " + onboarding.map(row => names[row.workEffortId] || row.workEffortId).join(", ")
        })
    }
    return {
        organizationPartyId,
        fromMs,
        thruMs,
        assignmentFromMs,
        person,
        matches,
        relationships,
        plan,
        orphan,
        terms,
        findings,
        offer
    }
}
const planTexts = {
    new: "A new employment",
    complete: "The existing employee relationship is completed",
    rehire: "A rehire: a new employment beside the earlier one"
}
function previewHire(p) {
    const userScope = editorScope("Hiring")
    const plan = planHire(p, userScope)
    const texts = termTexts(plan.terms)
    return {
        organizationPartyId: plan.organizationPartyId,
        organizationName: people.organizationNames([plan.organizationPartyId])[plan.organizationPartyId] || "",
        person: plan.person,
        matches: plan.matches,
        relationships: plan.relationships.map(row => ({
            partyRelationshipId: row.partyRelationshipId,
            typeText: row.typeText,
            fromDateText: row.fromDateText,
            thruDateText: row.thruDateText,
            stateText: row.stateText
        })),
        plan: plan.plan,
        planText: planTexts[plan.plan],
        terms: Object.assign({}, plan.terms, texts, {
            fromDateText: dateText(plan.assignmentFromMs),
            thruDateText: plan.thruMs == null ? "" : dateText(plan.thruMs)
        }),
        findings: plan.findings,
        canHire: !!plan.person && !firstError(plan.findings)
    }
}
// hire#Employee: one transaction for the person (chosen, or new), the Employee role, exactly one employment (new through
// create#Employment, or an orphan relationship completed), the first assignment and its projections, and the hire's change row with
// its operation key; a retry with the key answers the first hire. Refused as planHire's errors say.
function hireEmployee(p) {
    const userScope = editorScope("Hiring")
    const operationKey = text(p.operationKey) || null
    // P17: the accepted offer the hire is made from, locked first, so it is consumed once (a second hire from it is OFFER_USED) and
    // a hire sent twice at once answers the first (P17 review: the second waits on the offer, then finds the first by its key)
    const lockedOffer = text(p.employmentOfferId) ? offers().offerForHire(p.employmentOfferId, userScope, true) : null
    if (operationKey) {
        const first = rows(CHANGE, {operationKey, requestedByUserId: ec.user.userId, changeKindEnumId: "EckHire"})[0]
        if (first) {
            const firstRelationship = one(RELATIONSHIP, {partyRelationshipId: first.partyRelationshipId})
            if (firstRelationship && userScope.organizationPartyIds.includes(firstRelationship.toPartyId))
                return {
                    partyId: first.partyId,
                    partyRelationshipId: first.partyRelationshipId,
                    employmentChangeId: first.employmentChangeId,
                    employmentAssignmentId: first.employmentAssignmentId,
                    plan: null,
                    accessRequested: first.accessRequested === "Y",
                    repeated: true
                }
        }
    }
    const plan = planHire(p, userScope, lockedOffer)
    if (!plan.person) denied("PERSON_REQUIRED", "Choose or name the person")
    refuseErrors(plan.findings)
    const reason = text(p.reason) || "Hired"
    let partyId = plan.person.partyId
    if (!partyId) {
        // a new person; the Party's owner is left as it is (F59)
        partyId = call("mantle.party.PartyServices.create#Person", {
            firstName: text(p.firstName),
            lastName: text(p.lastName),
            nickname: text(p.preferredName) || null
        }).partyId
    }
    call("mantle.party.PartyServices.ensure#PartyRole", {partyId, roleTypeId: "Employee"})
    addWorkContacts(partyId, p)
    let partyRelationshipId
    if (plan.orphan) {
        partyRelationshipId = plan.orphan.partyRelationshipId
        call("create#" + EMPLOYMENT, {partyRelationshipId})
    } else
        partyRelationshipId = call("mantle.humanres.EmploymentServices.create#Employment", {
            fromPartyId: partyId,
            toPartyId: plan.organizationPartyId,
            fromDate: stamp(plan.fromMs),
            thruDate: stamp(plan.thruMs)
        }).partyRelationshipId
    const employment = employmentOf(one(RELATIONSHIP, {partyRelationshipId}))
    const before = termsAt(employment, plan.assignmentFromMs)
    const employmentChangeId = createChange(employment, "EckHire", {
        statusId: "EchApplied",
        effectiveDate: stamp(plan.assignmentFromMs),
        departmentPartyId: plan.terms.departmentPartyId,
        emplPositionId: plan.terms.emplPositionId,
        managerPartyId: plan.terms.managerPartyId,
        facilityId: plan.terms.facilityId,
        reason,
        operationKey,
        appliedDate: ec.user.nowTimestamp,
        // P7: HR asked for the person's account (the provisioning request after commit); none merely to be paid
        accessRequested: truthy(p.requestAccount) ? "Y" : "N",
        reroutedDate: ec.user.nowTimestamp
    })
    const employmentAssignmentId = startAssignment(employment, plan.terms, plan.assignmentFromMs, null, {
        before,
        reason,
        employmentChangeId
    })
    call("update#" + CHANGE, {employmentChangeId, employmentAssignmentId})
    // P17: the offer's working schedule from the first day, and the offer consumed (its application hired); no account asked but as
    // HR chose above. P23 review (the user's call of Nov 12, 2026): the offer's pay, approved with the offer, is the employment's
    // first salary from its first day, recorded at once (no pay change: its approval was the offer's); the hire's answer names no
    // amount
    if (plan.offer) {
        if (plan.offer.workingScheduleId)
            assignSchedule({
                partyRelationshipId,
                workingScheduleId: plan.offer.workingScheduleId,
                fromDate: stamp(plan.assignmentFromMs),
                reason: "From offer " + plan.offer.employmentOfferId
            })
        if (offerPay(plan.offer) && !payroll().salariesOf(partyRelationshipId).length)
            payroll().writeSalary(
                partyRelationshipId,
                {
                    fromMs: plan.assignmentFromMs,
                    amount: plan.offer.payAmount,
                    currencyUomId: plan.offer.currencyUomId,
                    timePeriodTypeId: plan.offer.timePeriodTypeId || null
                },
                "From offer " + plan.offer.employmentOfferId
            )
        offers().consumeOffer(plan.offer, {partyRelationshipId, employmentChangeId})
    }
    return {
        partyId,
        partyRelationshipId,
        employmentChangeId,
        employmentAssignmentId,
        plan: plan.plan,
        accessRequested: truthy(p.requestAccount),
        repeated: false
    }
}
// A new hire's work email and phone (EmailWork, PhoneWork: the directory's work identity), each unless the person has it already.
function addWorkContacts(partyId, p) {
    const contacts = people.unique(
        rows("mantle.party.contact.PartyContactMech", {partyId})
            .filter(row => openAt(row, nowMs()))
            .map(row => row.contactMechId)
    )
    const infos = contacts.length
        ? Array.from(find("mantle.party.contact.ContactMech").condition("contactMechId", "in", contacts).list()).map(row =>
              String(row.infoString || "").toLowerCase()
          )
        : []
    const email = text(p.workEmail)
    if (email && !infos.includes(email.toLowerCase()))
        call("mantle.party.ContactServices.create#EmailAddress", {
            emailAddress: email,
            partyId,
            contactMechPurposeId: "EmailWork"
        })
    const phone = text(p.workPhone)
    if (phone)
        call("mantle.party.ContactServices.create#TelecomNumber", {
            contactNumber: phone,
            partyId,
            contactMechPurposeId: "PhoneWork"
        })
}

// ===== preview#EmploymentChange and apply#EmploymentChange =====
// The change asked for, checked against the employment on its date: its kind, date, the new terms (each term not given kept, an
// empty one cleared), a leave's return date, a separation's reason and type; with the impact (what else moves) and whether it waits
// for approval, and who would decide it (Approvals.js resolve).
function planChange(p, userScope) {
    const employment = employmentIn(userScope, p.partyRelationshipId)
    const kindName = text(p.changeKind)
    const kindEnumId = changeKinds[kindName] || null
    const at = effective(p.effectiveDate)
    const findings = []
    // the terms now (or at the employment's start, when it starts later), for the screen
    const current = termsAt(employment, Math.max(nowMs(), employment.fromMs ?? -Infinity))
    const before = termsAt(employment, at)
    let terms = termsOfRow(before)
    const impact = []
    let pay = null
    if (!kindEnumId) findings.push({code: "KIND_INVALID", severity: "error", message: "Choose what changes"})
    else if (kindEnumId === payKind) {
        // P23: the date inside the employment, the salary's terms and the salary rows from the date; no assignment moves
        attempt(findings, () => {
            if ((employment.fromMs ?? -Infinity) > at || (employment.thruMs ?? Infinity) <= at)
                denied("DATE_OUTSIDE", "The date is outside the employment")
        })
        pay = attempt(findings, () => payroll().checkPayTerms(employment, p, at))
        attempt(findings, () => payroll().checkSalaryDate(employment.partyRelationshipId, at))
        if (pay?.note) findings.push({code: "OUTSIDE_BAND", severity: "note", message: pay.note})
        const first = !payroll().salariesOf(employment.partyRelationshipId).length
        if (pay)
            impact.push({
                kind: "pay",
                impactText:
                    (first ? "The first salary, " : "The salary becomes ") +
                    payroll().salaryText({
                        amount: pay.amount,
                        currencyUomId: pay.currencyUomId,
                        timePeriodTypeId: pay.timePeriodTypeId
                    }) +
                    " from " +
                    dateText(at)
            })
        if (pay) pay.first = first
    } else {
        checkDate(employment, at, findings, supersedesFor(kindEnumId))
        if (kindEnumId === "EckTransfer" || kindEnumId === "EckManager") {
            const asked = Object.assign({}, terms)
            for (const field of kindEnumId === "EckManager" ? ["managerPartyId"] : termFields)
                if (given(p[field])) asked[field] = text(p[field]) || null
            // a new position without a department named takes the position's department
            if (kindEnumId === "EckTransfer" && given(p.emplPositionId) && !given(p.departmentPartyId) && asked.emplPositionId)
                asked.departmentPartyId = null
            terms = checkTerms(employment, asked, at, findings)
            if (termFields.every(field => (terms[field] || null) === (before[field] || null)))
                findings.push({code: "NOTHING_CHANGES", severity: "error", message: "Nothing changes from that date"})
        }
        if (kindEnumId === "EckLeave") {
            if (before.stateEnumId === "EasLeave")
                findings.push({code: "ALREADY_ON_LEAVE", severity: "error", message: "The person is on leave already"})
            if (text(p.returnDate) && effective(p.returnDate) <= at)
                findings.push({code: "DATES_INVALID", severity: "error", message: "The return is after the leave starts"})
        }
        if (kindEnumId === "EckReturn" && before.stateEnumId !== "EasLeave")
            findings.push({code: "NOT_ON_LEAVE", severity: "error", message: "The person is not on leave then"})
        if (kindEnumId === "EckSeparation") {
            if (text(p.terminationReasonEnumId))
                attempt(findings, () => checkVocabulary("TerminationReason", text(p.terminationReasonEnumId)))
            if (text(p.terminationTypeEnumId))
                attempt(findings, () => checkVocabulary("TerminationType", text(p.terminationTypeEnumId)))
        }
        impact.push(...impactOf(employment, kindEnumId, before, terms, at))
    }
    if (!text(p.reason) && kindEnumId && approvalKinds.includes(kindEnumId))
        findings.push({code: "REASON_REQUIRED", severity: "error", message: "Say why"})
    return {employment, kindEnumId, at, before, current, terms, findings, impact, pay}
}
// An HR vocabulary value (People's lookups): of the family and not ended.
function checkVocabulary(enumTypeId, enumId) {
    const row = one("moqui.basic.Enumeration", {enumId})
    if (!row || row.enumTypeId !== enumTypeId) denied("VALUE_INVALID", "Choose a value of the list")
    if ((ms(row.thruDate) ?? Infinity) <= nowMs()) denied("VALUE_ENDED", (row.description || enumId) + " has ended")
}
// What a change moves besides the assignment (design §4 EmploymentChange's ImpactAndConfirm): the seat, the department
// membership, the reporting line, and for a separation the reports, the units led, the employment at another employer and the
// waiting decisions. Later phases add theirs (equipment, checklists, access end, leave, pay).
function impactOf(employment, kindEnumId, before, terms, at) {
    const items = []
    const add = (kind, impactText) => items.push({kind, impactText})
    const names = (ids, of) => of(ids.filter(Boolean))
    const separation = kindEnumId === "EckSeparation"
    const after = separation ? {departmentPartyId: null, emplPositionId: null, managerPartyId: null} : terms
    const seats = names([before.emplPositionId, after.emplPositionId], positionNames)
    const units = names([before.departmentPartyId, after.departmentPartyId], people.organizationNames)
    const persons = names([before.managerPartyId, after.managerPartyId], people.personNames)
    if (before.emplPositionId !== after.emplPositionId) {
        if (before.emplPositionId) add("position", "The position " + seats[before.emplPositionId] + " becomes vacant")
        if (after.emplPositionId) add("position", "The position " + seats[after.emplPositionId] + " is held from " + dateText(at))
    }
    if (before.departmentPartyId !== after.departmentPartyId)
        add(
            "department",
            before.departmentPartyId && after.departmentPartyId
                ? "Moves from " + units[before.departmentPartyId] + " to " + units[after.departmentPartyId]
                : after.departmentPartyId
                  ? "Joins " + units[after.departmentPartyId]
                  : "Leaves " + units[before.departmentPartyId]
        )
    if (kindEnumId === "EckTransfer") {
        const transfer = rows("mantle.humanres.checklist.ChecklistTemplate", {
            organizationPartyId: employment.organizationPartyId,
            lifecycleKindEnumId: "ClkTransfer"
        }).filter(row => openAt(row, nowMs()))
        if (transfer.length)
            add(
                "checklists",
                transfer.length +
                    (transfer.length === 1 ? " transfer checklist starts" : " transfer checklists start") +
                    " when it is applied"
            )
    }
    if (before.managerPartyId !== after.managerPartyId)
        add(
            "manager",
            after.managerPartyId
                ? "Reports to " +
                      persons[after.managerPartyId] +
                      (before.managerPartyId ? " in place of " + persons[before.managerPartyId] : "")
                : "No longer reports to " + persons[before.managerPartyId]
        )
    if (kindEnumId === "EckLeave") add("state", "On leave of absence from " + dateText(at))
    if (kindEnumId === "EckReturn") add("state", "Working again from " + dateText(at))
    // the scheduled changes it withdraws (P7, F131)
    const allow = supersedesFor(kindEnumId)
    if (allow)
        for (const row of assignmentsOf(employment.partyRelationshipId).filter(
            row => (ms(row.fromDate) ?? -Infinity) >= at && allow(row)
        )) {
            const scheduledChange = changeOf(row.employmentChangeId)
            add(
                "withdrawn",
                (scheduledChange?.changeKindEnumId === "EckLeave"
                    ? "The return set for "
                    : "The " + (kindTexts[scheduledChange?.changeKindEnumId] || "change").toLowerCase() + " set for ") +
                    dateText(row.fromDate) +
                    " is withdrawn"
            )
        }
    if (separation) {
        const org = employment.organizationPartyId
        add("employment", "The employment ends from " + dateText(at))
        const reports = people
            .linesOf({managerPartyIds: [employment.partyId]}, at)
            .filter(line => line.organizationPartyIds.includes(org))
        if (reports.length)
            add(
                "reports",
                reports.length +
                    (reports.length === 1 ? " person reports" : " people report") +
                    " to them here; they will have no manager"
            )
        const units = people.unitsUnder([org])
        const led = units.length
            ? rows(RELATIONSHIP, {
                  relationshipTypeEnumId: "PrtMember",
                  fromPartyId: employment.partyId,
                  fromRoleTypeId: "Manager"
              }).filter(row => units.includes(row.toPartyId) && openAt(row, at))
            : []
        if (led.length)
            add(
                "units",
                "Leads " +
                    Object.values(people.organizationNames(led.map(row => row.toPartyId))).join(", ") +
                    "; the unit will have no lead"
            )
        const elsewhere = (people.employersOfParties([employment.partyId], at)[employment.partyId] || []).filter(
            organizationPartyId => organizationPartyId !== org
        )
        if (elsewhere.length) add("otherEmployment", "Their employment at another employer continues and is not changed")
        add("approvals", "Approvals waiting on them go to the step's alternate or the HR fallback")
        // P7: the equipment they hold, the offboarding checklists and their account's access
        const held = rows("mantle.product.asset.AssetPartyAssignment", {partyId: employment.partyId}).filter(
            row => (ms(row.thruDate) ?? Infinity) > at
        )
        if (held.length)
            add(
                "equipment",
                held.length +
                    (held.length === 1 ? " piece of equipment is" : " pieces of equipment are") +
                    " to be returned: a return task each"
            )
        const offboarding = rows("mantle.humanres.checklist.ChecklistTemplate", {
            organizationPartyId: org,
            lifecycleKindEnumId: "ClkOffboarding"
        }).filter(row => openAt(row, nowMs()))
        if (offboarding.length)
            add(
                "checklists",
                offboarding.length +
                    (offboarding.length === 1 ? " offboarding checklist starts" : " offboarding checklists start")
            )
        if (one("moqui.security.UserAccount", {partyId: employment.partyId}))
            add(
                "access",
                elsewhere.length
                    ? "Their account keeps its access for the other employer"
                    : "Their account's access ends from " + dateText(at) + " (Admin's lifecycle)"
            )
    }
    return items
}
// P23: whether a planned change waits for approval: a transfer, a separation and a pay change do (the first salary too: the user's
// call of Nov 12, 2026; only a hire from an accepted offer records the offer's approved pay at once, hireEmployee)
const waitsFor = plan => !!plan.kindEnumId && approvalKinds.includes(plan.kindEnumId)
function previewEmploymentChange(p) {
    const userScope = changeScope(p.changeKind)
    const plan = planChange(p, userScope)
    const employment = plan.employment
    const org = employment.organizationPartyId
    const out = {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.partyId,
        personName: people.personNames([employment.partyId])[employment.partyId] || employment.partyId,
        organizationPartyId: org,
        organizationName: people.organizationNames([org])[org] || org,
        employmentFromDateText: dateText(employment.fromMs),
        employmentThruDateText: dateText(employment.thruMs),
        // P23 review: a pay change names the salary revision, every other change the employment's
        revision:
            plan.kindEnumId === payKind
                ? payroll().salaryRevision(employment.partyRelationshipId)
                : people.employmentRevision(employment.partyRelationshipId),
        current: Object.assign(termsOfRow(plan.current), termTexts(plan.current), {
            stateEnumId: plan.current.stateEnumId,
            stateText: stateTexts[plan.current.stateEnumId] || "Working"
        }),
        changeKindEnumId: plan.kindEnumId,
        changeText: kindTexts[plan.kindEnumId] || "",
        effectiveDateText: dateText(plan.at),
        terms: Object.assign({}, termsOfRow(plan.terms), termTexts(plan.terms)),
        impact: plan.impact,
        findings: plan.findings,
        needsApproval: waitsFor(plan),
        canApply: !!plan.kindEnumId && !firstError(plan.findings),
        route: []
    }
    // who would decide it (the default: the person's manager at the employer). P23 review: a pay change's route is read through the
    // module, the caller checked already (a payroll editor reads no approval rules, so resolve#Approvers would refuse them and mark
    // the transaction); the employer's payroll approvers by default
    if (out.needsApproval && plan.kindEnumId === payKind)
        out.route = Array.from(
            approvals().previewRoute({
                approvalKindEnumId: payApprovalKind,
                organizationPartyId: org,
                departmentPartyId: plan.before.departmentPartyId || null,
                subjectPartyId: employment.partyId,
                requesterPartyId: ec.user.userAccount?.partyId || null
            }).steps || []
        ).map(step => ({stepText: step.stepText, explanation: step.explanation, unresolved: !!step.unresolved}))
    else if (out.needsApproval)
        try {
            out.route = Array.from(
                call("mantle.humanres.PeopleApprovalServices.resolve#Approvers", {
                    approvalKindEnumId: plan.kindEnumId === payKind ? payApprovalKind : approvalKind,
                    organizationPartyId: org,
                    departmentPartyId: plan.before.departmentPartyId,
                    subjectPartyId: employment.partyId,
                    requesterPartyId: ec.user.userAccount?.partyId || null
                }).steps || []
            ).map(step => ({stepText: step.stepText, explanation: step.explanation, unresolved: !!step.unresolved}))
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.warn("The route of an employment change could not be read: " + error.message)
        }
    return out
}
// apply#EmploymentChange: the change asked for, at the employment's revision read; a retry with the operation key answers the
// first. A transfer or a separation waits for approval (its request routed by the employer's rules, the person's manager by
// default, never the requester or the person); a manager change, a leave of absence and a return are applied now. A new change
// supersedes one of the employment still waiting.
function applyEmploymentChange(p) {
    const userScope = changeScope(p.changeKind)
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const first = rows(CHANGE, {operationKey, requestedByUserId: ec.user.userId}).find(
            row => row.changeKindEnumId !== "EckHire" && row.partyRelationshipId === text(p.partyRelationshipId)
        )
        if (first) return Object.assign(changeAnswer(first), {repeated: true})
    }
    const employment = employmentIn(userScope, p.partyRelationshipId)
    // P23: a pay change names the salary revision it read (get#Compensation's payRevision), every other change the employment's
    const revision =
        text(p.changeKind) === "pay"
            ? payroll().salaryRevision(employment.partyRelationshipId)
            : people.employmentRevision(employment.partyRelationshipId)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This employment changed since you read it; open it again (revision " + revision + ")")
    const plan = planChange(p, userScope)
    refuseErrors(plan.findings)
    const needsApproval = waitsFor(plan)
    const values = {
        statusId: needsApproval ? "EchRequested" : "EchApplied",
        effectiveDate: stamp(plan.at),
        returnDate: plan.kindEnumId === "EckLeave" && text(p.returnDate) ? stamp(effective(p.returnDate)) : null,
        reason: text(p.reason) || null,
        employmentRevision: revision,
        operationKey
    }
    if (plan.kindEnumId === "EckSeparation")
        Object.assign(values, {
            terminationReasonEnumId: text(p.terminationReasonEnumId) || null,
            terminationTypeEnumId: text(p.terminationTypeEnumId) || null
        })
    else if (plan.kindEnumId === payKind)
        Object.assign(values, {
            salaryAmount: plan.pay.amount,
            salaryCurrencyUomId: plan.pay.currencyUomId,
            salaryPeriodTypeId: plan.pay.timePeriodTypeId,
            payGradeId: plan.pay.payGradeId
        })
    else Object.assign(values, termsOfRow(plan.terms))
    if (needsApproval) {
        supersedeWaiting(employment.partyRelationshipId, null, plan.kindEnumId)
        values.statusId = "EchRequested"
        const employmentChangeId = createChange(employment, plan.kindEnumId, values)
        approvals().request({
            approvalKindEnumId: plan.kindEnumId === payKind ? payApprovalKind : approvalKind,
            sourceId: employmentChangeId,
            organizationPartyId: employment.organizationPartyId,
            departmentPartyId: plan.before.departmentPartyId,
            subjectPartyId: employment.partyId,
            effectiveDate: stamp(plan.at),
            justification: text(p.reason) || null,
            operationKey
        })
        return Object.assign(changeAnswer(changeOf(employmentChangeId)), {repeated: false})
    }
    // applied now: created waiting, then applied (its status a transition)
    values.statusId = "EchRequested"
    const employmentChangeId = createChange(employment, plan.kindEnumId, values)
    applyChange(changeOf(employmentChangeId))
    return Object.assign(changeAnswer(changeOf(employmentChangeId)), {repeated: false})
}
function changeAnswer(change) {
    const summary = change.statusId === "EchRequested" || change.statusId === "EchRefused" ? approvalOf(change) : null
    return {
        employmentChangeId: change.employmentChangeId,
        partyRelationshipId: change.partyRelationshipId,
        statusId: change.statusId,
        statusText: statusTexts[change.statusId] || change.statusId,
        applied: change.statusId === "EchApplied",
        employmentAssignmentId: change.employmentAssignmentId || null,
        peopleApprovalId: summary?.peopleApprovalId || null,
        waitingText: summary?.waitingText || "",
        unresolved: !!summary?.unresolved
    }
}
const approvalOf = change => approvals().sourceSummary(kindOfChange(change), change.employmentChangeId)

// ===== decide#EmploymentChange and the topic's services =====
// The step waiting of a change's request decided (record#Decision rechecks the decider and the change's and employment's
// revision); the last approval applies the change, a refusal refuses it. A decision retried answers the first and applies nothing
// again.
function decideEmploymentChange(p) {
    // P23 review: the kind of the change's request (a pay change's is PakPayChange), from the change or the request named
    const named = text(p.employmentChangeId) ? changeOf(text(p.employmentChangeId)) : null
    const asked =
        !named && text(p.peopleApprovalId)
            ? one("mantle.humanres.approval.PeopleApproval", {peopleApprovalId: text(p.peopleApprovalId)})
            : null
    const kindEnumId = named
        ? kindOfChange(named)
        : asked?.approvalKindEnumId === payApprovalKind
          ? payApprovalKind
          : approvalKind
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: kindEnumId,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: text(p.employmentChangeId) || null,
        decision: text(p.decision) || "approve",
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    const change = changeOf(decided.sourceId)
    let applied = false
    if (change && !decided.repeated && change.statusId === "EchRequested") {
        if (decided.complete) {
            applyChange(change)
            applied = true
        } else if (decided.statusId === "PapRefused")
            call("update#" + CHANGE, {employmentChangeId: change.employmentChangeId, statusId: "EchRefused"})
    }
    const after = changeOf(decided.sourceId)
    return {
        peopleApprovalId: decided.peopleApprovalId,
        peopleApprovalDecisionId: decided.peopleApprovalDecisionId,
        statusId: decided.statusId,
        employmentChangeId: decided.sourceId,
        changeStatusId: after?.statusId || null,
        applied,
        repeated: decided.repeated
    }
}
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== CHANGE) denied("SOURCE_INVALID", "Not an employment change approval")
    return decideEmploymentChange({
        employmentChangeId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}

// ===== find#EmploymentChanges =====
// A person's employment changes the caller may see: an HR reader's of the employers in their scope (waiting ones, and with
// includeDone those applied, refused or superseded), and a waiting one whose step waiting the caller decides (a manager reads
// their report's transfer to approve it). Each with its terms as text and, while it waits or once refused, its approval.
function findEmploymentChanges(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const partyId = text(p.partyId)
    if (!partyId) denied("PERSON_REQUIRED", "Choose the person")
    let query = find(CHANGE).condition("partyId", partyId)
    if (text(p.partyRelationshipId)) query = query.condition("partyRelationshipId", text(p.partyRelationshipId))
    const found = Array.from(query.orderBy("-requestedDate").limit(50).list())
    const hrOf = row => !!caps.hrView && userScope.organizationPartyIds.includes(row.organizationPartyId)
    // P23: a pay change is payroll's to read (PAYROLL_VIEW of the employer), not HR's; its approver reads the one they decide
    const payOf = row => !!caps.payrollView && userScope.organizationPartyIds.includes(row.organizationPartyId)
    const readerOf = row => (row.changeKindEnumId === payKind ? payOf(row) : hrOf(row))
    const includeDone = truthy(p.includeDone)
    const changes = []
    for (const row of found) {
        const waiting = row.statusId === "EchRequested"
        if (!waiting && !(includeDone && readerOf(row))) continue
        const approval = waiting || row.statusId === "EchRefused" ? approvalOf(row) : null
        if (!readerOf(row) && !approval?.canDecide) continue
        changes.push(changeRow(row, approval, hrOf(row) && !!caps.hrEdit, readerOf(row) || !!approval?.canDecide))
    }
    // P17: each applied change's lifecycle letter (Letters.js): offered to an HR editor, and whether it is issued
    const issued = letters().issuedFor(changes.map(row => row.employmentChangeId))
    for (const row of changes) {
        row.letterIssued = !!issued[row.employmentChangeId]
        row.letterOffered =
            !!row.hrEdit &&
            row.statusId === "EchApplied" &&
            !row.withdrawnDateText &&
            letters().letterKinds.includes(row.changeKindEnumId)
    }
    return {changes}
}
function changeRow(row, approval, hrEdit = false, readsPay = false) {
    const texts = termTexts(row)
    const reasons = enumNames([row.terminationReasonEnumId, row.terminationTypeEnumId])
    // P7: a change applied for a date still to come (a leave's return too) is withdrawn by HR (F131); the access request's state
    const scheduled =
        row.statusId === "EchApplied" &&
        withdrawableKinds.includes(row.changeKindEnumId) &&
        !row.causedByChangeId &&
        (row.changeKindEnumId === "EckSeparation"
            ? (ms(row.effectiveDate) ?? -Infinity) > nowMs()
            : assignmentsOf(row.partyRelationshipId).some(
                  assignment =>
                      assignment.employmentChangeId === row.employmentChangeId && (ms(assignment.fromDate) ?? -Infinity) > nowMs()
              ))
    const partial = scheduled && row.changeKindEnumId === "EckLeave" && (ms(row.effectiveDate) ?? Infinity) <= nowMs()
    return Object.assign(
        {
            employmentChangeId: row.employmentChangeId,
            partyRelationshipId: row.partyRelationshipId,
            partyId: row.partyId,
            organizationPartyId: row.organizationPartyId,
            organizationName: people.organizationNames([row.organizationPartyId])[row.organizationPartyId] || "",
            changeKindEnumId: row.changeKindEnumId,
            changeText: kindTexts[row.changeKindEnumId] || row.changeKindEnumId,
            statusId: row.statusId,
            statusText: statusTexts[row.statusId] || row.statusId,
            effectiveDateText: dateText(row.effectiveDate),
            returnDateText: dateText(row.returnDate),
            terminationReason: reasons[row.terminationReasonEnumId] || "",
            terminationType: reasons[row.terminationTypeEnumId] || "",
            reason: row.reason || "",
            requestedDateText: dateText(row.requestedDate),
            appliedDateText: dateText(row.appliedDate),
            approval: approval || null,
            canDecide: !!approval?.canDecide,
            scheduled,
            canWithdraw: scheduled && hrEdit,
            withdrawText: partial ? "Withdraw the return" : "Withdraw",
            withdrawnDateText: dateText(row.withdrawnDate),
            withdrawReason: row.withdrawReason || "",
            accessRequested: row.accessRequested === "Y",
            hrEdit,
            accessOperationId: hrEdit ? row.accessOperationId || null : null,
            accessFailure: hrEdit ? row.accessRequestFailure || "" : "",
            // P23: a pay change's new salary, to a payroll reader of the employer and the approver of its step alone
            isPayChange: row.changeKindEnumId === payKind,
            salaryText:
                row.changeKindEnumId === payKind && readsPay
                    ? payroll().salaryText({
                          amount: row.salaryAmount,
                          currencyUomId: row.salaryCurrencyUomId,
                          timePeriodTypeId: row.salaryPeriodTypeId
                      })
                    : "",
            canRequestAccess:
                hrEdit &&
                row.statusId === "EchApplied" &&
                !!row.accessRequestFailure &&
                ((row.changeKindEnumId === "EckHire" && row.accessRequested === "Y") || row.changeKindEnumId === "EckSeparation")
        },
        row.changeKindEnumId === "EckSeparation" ? {} : texts
    )
}

// ===== for OrganizationServices: a manager changed on the chart, and a department closed =====
// change#Manager of an employment with an assignment (Organization.js has checked the caller and the line): a manager change
// applied from the date, as apply#EmploymentChange's.
function changeManagerOfAssignment(partyRelationshipId, managerPartyId, at, reason) {
    const employment = employmentOf(one(RELATIONSHIP, {partyRelationshipId}))
    const before = termsAt(employment, at)
    const findings = []
    checkDate(employment, at, findings)
    const terms = checkTerms(
        employment,
        Object.assign(termsOfRow(before), {managerPartyId: managerPartyId || null}),
        at,
        findings
    )
    refuseErrors(findings)
    const employmentChangeId = createChange(employment, "EckManager", {
        statusId: "EchRequested",
        effectiveDate: stamp(at),
        departmentPartyId: terms.departmentPartyId,
        emplPositionId: terms.emplPositionId,
        managerPartyId: terms.managerPartyId,
        facilityId: terms.facilityId,
        reason: reason || null,
        employmentRevision: people.employmentRevision(partyRelationshipId)
    })
    applyChange(changeOf(employmentChangeId))
    return {employmentChangeId}
}
// A department closed from the date (OrganizationServices.store#Unit): each assignment naming it in effect then moves to the
// department given (a reorganization, applied now, the employments' waiting changes superseded); refused when an assignment
// naming it starts later (ASSIGNMENT_SCHEDULED). Returns how many moved.
function reassignDepartment(departmentPartyId, toDepartmentPartyId, at, reason) {
    const naming = Array.from(find(ASSIGNMENT).condition({departmentPartyId, isPrimary: "Y"}).list()).filter(
        row => !voided(row) && (ms(row.thruDate) ?? Infinity) > at
    )
    if (naming.some(row => (ms(row.fromDate) ?? -Infinity) >= at))
        denied("ASSIGNMENT_SCHEDULED", "Someone joins this department on or after that date; change their employment first")
    let moved = 0
    for (const row of naming) {
        const employment = employmentOf(one(RELATIONSHIP, {partyRelationshipId: row.partyRelationshipId}))
        const before = Object.assign(termsOfRow(row), {assignment: row})
        const terms = Object.assign({}, before, {departmentPartyId: toDepartmentPartyId})
        const employmentChangeId = createChange(employment, "EckReorganization", {
            statusId: "EchApplied",
            effectiveDate: stamp(at),
            departmentPartyId: toDepartmentPartyId,
            emplPositionId: row.emplPositionId,
            managerPartyId: row.managerPartyId,
            facilityId: row.facilityId,
            reason,
            appliedDate: ec.user.nowTimestamp
        })
        const employmentAssignmentId = startAssignment(employment, terms, at, ms(row.thruDate), {
            before,
            reason,
            employmentChangeId,
            stateEnumId: row.stateEnumId
        })
        call("update#" + CHANGE, {employmentChangeId, employmentAssignmentId})
        supersedeWaiting(row.partyRelationshipId)
        moved++
    }
    return moved
}

// ===== the wizards' drafts (get#, store# and delete#EmploymentDraft) =====
// An HR editor's unfinished hire or change (EmploymentDraft): the caller's own alone; another user's, or one of an employment
// outside the caller's scope, is missing (RECORD_UNAVAILABLE). Only the parameters of the kind's preview are kept.
const DRAFT = "mantle.humanres.employment.EmploymentDraft"
const draftFields = {
    hire: [
        "organizationPartyId",
        "partyId",
        "firstName",
        "lastName",
        "preferredName",
        "workEmail",
        "workPhone",
        "confirmNewPerson",
        "fromDate",
        "thruDate",
        "departmentPartyId",
        "emplPositionId",
        "managerPartyId",
        "facilityId",
        "reason",
        // P17: the accepted offer the hire is made from
        "employmentOfferId"
    ],
    change: [
        "effectiveDate",
        "departmentPartyId",
        "emplPositionId",
        "managerPartyId",
        "facilityId",
        "returnDate",
        "terminationReasonEnumId",
        "terminationTypeEnumId",
        "reason"
    ]
}
function draftKindOf(p) {
    const kind = text(p.draftKind)
    if (!Object.hasOwn(draftFields, kind)) denied("KIND_INVALID", "A draft is of a hire or a change")
    return kind
}
// the caller's draft by id, else their newest of the kind (a change's: of the employment and kind)
function ownDraft(userScope, kind, p) {
    const id = text(p.employmentDraftId)
    if (id) {
        const row = one(DRAFT, {employmentDraftId: id})
        if (!row || row.userId !== ec.user.userId || row.draftKind !== kind)
            denied("RECORD_UNAVAILABLE", "This draft is not available")
        return row
    }
    const conditions = {userId: ec.user.userId, draftKind: kind}
    if (kind === "change") {
        employmentIn(userScope, p.partyRelationshipId)
        Object.assign(conditions, {partyRelationshipId: text(p.partyRelationshipId), changeKind: text(p.changeKind)})
    }
    return Array.from(find(DRAFT).condition(conditions).orderBy("-fromDate").limit(1).list())[0] || null
}
function draftAnswer(row) {
    let draft = {}
    try {
        draft = row?.draftJson ? JSON.parse(row.draftJson) : {}
    } catch (error) {
        ec.logger.warn("Employment draft " + row.employmentDraftId + " could not be read: " + error.message)
    }
    return {
        employmentDraftId: row?.employmentDraftId || null,
        draft,
        operationKey: row?.operationKey || null,
        fromDateText: row ? dateText(row.fromDate) : ""
    }
}
function getEmploymentDraft(p) {
    const userScope = editorScope("A hire or change draft")
    return draftAnswer(ownDraft(userScope, draftKindOf(p), p))
}
// The draft kept: the caller's own (new when they have none of the kind, employment and kind), its values those of the kind's
// fields only; the employer one of the caller's, the employment one in their scope.
function storeEmploymentDraft(p) {
    const userScope = editorScope("A hire or change draft")
    const kind = draftKindOf(p)
    const values = p.draft && typeof p.draft === "object" ? p.draft : {}
    const draft = {}
    // an empty value is kept: a change's term cleared stays cleared
    for (const field of draftFields[kind]) if (values[field] != null) draft[field] = String(values[field])
    let organizationPartyId = null
    if (kind === "change") {
        if (!Object.hasOwn(changeKinds, text(p.changeKind))) denied("KIND_INVALID", "Choose what changes")
        organizationPartyId = employmentIn(userScope, p.partyRelationshipId).organizationPartyId
    } else if (draft.organizationPartyId) {
        people.requireOrganization(userScope, draft.organizationPartyId)
        organizationPartyId = draft.organizationPartyId
    }
    const row = ownDraft(userScope, kind, p)
    if (row) {
        call("update#" + DRAFT, {
            employmentDraftId: row.employmentDraftId,
            organizationPartyId,
            draftJson: JSON.stringify(draft)
        })
        return draftAnswer(one(DRAFT, {employmentDraftId: row.employmentDraftId}))
    }
    const employmentDraftId = call("create#" + DRAFT, {
        userId: ec.user.userId,
        draftKind: kind,
        organizationPartyId,
        partyRelationshipId: kind === "change" ? text(p.partyRelationshipId) : null,
        changeKind: kind === "change" ? text(p.changeKind) : null,
        draftJson: JSON.stringify(draft),
        fromDate: ec.user.nowTimestamp
    }).employmentDraftId
    // the key the hire or change is made with, made once: a second Hire or Apply answers the first
    call("update#" + DRAFT, {employmentDraftId, operationKey: "DRAFT-" + employmentDraftId})
    return draftAnswer(one(DRAFT, {employmentDraftId}))
}
// The caller's own draft discarded (made, or given up); none is no error.
function deleteEmploymentDraft(p) {
    editorScope("A hire or change draft")
    const id = text(p.employmentDraftId)
    const row = id ? one(DRAFT, {employmentDraftId: id}) : null
    if (!row || row.userId !== ec.user.userId) return {deleted: false}
    call("delete#" + DRAFT, {employmentDraftId: id})
    return {deleted: true}
}

// ===== get#EmploymentHistory's assignments =====
// The dated assignments of the employments, newest first: their dates, state, department, position, manager, work location and
// the change that started each.
function assignmentHistory(employmentIds) {
    if (!employmentIds.length) return []
    const found = Array.from(
        find(ASSIGNMENT).condition("partyRelationshipId", "in", employmentIds).orderBy("-fromDate").list()
    ).filter(row => !voided(row))
    if (!found.length) return []
    const departments = people.organizationNames(unique(found.map(row => row.departmentPartyId).filter(Boolean)))
    const seats = positionNames(found.map(row => row.emplPositionId))
    const managers = people.personNames(unique(found.map(row => row.managerPartyId).filter(Boolean)))
    const facilities = facilityNames(found.map(row => row.facilityId))
    const scheduleNames = schedules().scheduleNames(found.map(row => row.workingScheduleId))
    const changeIds = unique(found.map(row => row.employmentChangeId).filter(Boolean))
    const changes = changeIds.length
        ? Object.fromEntries(
              Array.from(find(CHANGE).condition("employmentChangeId", "in", changeIds).list()).map(row => [
                  row.employmentChangeId,
                  row
              ])
          )
        : {}
    return found.map(row => {
        const change = changes[row.employmentChangeId] || null
        return {
            employmentAssignmentId: row.employmentAssignmentId,
            partyRelationshipId: row.partyRelationshipId,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            stateText: stateTexts[row.stateEnumId] || "Working",
            departmentName: departments[row.departmentPartyId] || "",
            positionName: seats[row.emplPositionId] || "",
            managerName: managers[row.managerPartyId] || "",
            facilityName: facilities[row.facilityId] || "",
            scheduleName: scheduleNames[row.workingScheduleId] || "",
            changeText: change ? kindTexts[change.changeKindEnumId] || "" : "",
            reason: change?.reason || row.comments || ""
        }
    })
}

// ===== a working schedule (P9; ScheduleServices assign#Schedule) =====
// The employment follows the schedule (and the holiday calendar in place of the schedule's) from the date: an HR editor of the
// employer's; applied at once, a change of its own (EckSchedule) that ends the assignment in effect and starts the next with the
// other terms as they were (an employment written before People's assignments gets its first), or, from the day the assignment in
// effect starts (a hire's first day), changes that assignment's schedule (sameStart). The date is the start of today when empty
// (or of the employment or assignment that began later today). The schedule is one of the employer's in effect on the date
// (Schedules.js checkAssignable), the calendar the employer's or a shared one; an empty schedule ends the following of one.
// A transfer or separation of the employment waiting for approval stays waiting, its approval kept (Approvals.js keepWaiting), and
// takes the schedule on its date (applyChange); the schedule's date comes before the waiting change's (CHANGE_WAITING).
// expectedRevision, when given, is the employment's (REVISION_CHANGED); an operation key a retry answers with. Refuses:
// DATE_OUTSIDE, ASSIGNMENT_SCHEDULED (a later change is set; choose a later date), CHANGE_WAITING, SCHEDULE_REQUIRED (a calendar
// with no schedule), NOTHING_CHANGES and the schedule's and calendar's refusals.
function assignSchedule(p) {
    const userScope = editorScope("Assigning a working schedule")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const first = rows(CHANGE, {operationKey, requestedByUserId: ec.user.userId}).find(
            row => row.changeKindEnumId === "EckSchedule" && row.partyRelationshipId === text(p.partyRelationshipId)
        )
        if (first) return Object.assign(changeAnswer(first), {repeated: true})
    }
    const employment = employmentIn(userScope, p.partyRelationshipId)
    const revision = people.employmentRevision(employment.partyRelationshipId)
    if (text(p.expectedRevision) && text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This employment changed since you read it; open it again (revision " + revision + ")")
    const at = text(p.fromDate) ? effective(p.fromDate) : scheduleStart(employment)
    const findings = []
    const kept = sameStart(employment, at)
    checkDate(employment, at, findings, kept ? row => row.employmentAssignmentId === kept.employmentAssignmentId : null)
    const waiting = rows(CHANGE, {partyRelationshipId: employment.partyRelationshipId, statusId: "EchRequested"})
    const conflict = waiting.find(row => (ms(row.effectiveDate) ?? -Infinity) <= at)
    if (conflict)
        findings.push({
            code: "CHANGE_WAITING",
            severity: "error",
            message:
                "A " +
                (kindTexts[conflict.changeKindEnumId] || "change").toLowerCase() +
                " from " +
                dateText(conflict.effectiveDate) +
                " is waiting for approval; assign the schedule from an earlier date, or once it is decided"
        })
    const before = termsAt(employment, at)
    const asked = {workingScheduleId: text(p.workingScheduleId) || null, holidayCategoryId: text(p.holidayCategoryId) || null}
    if (asked.holidayCategoryId && !asked.workingScheduleId)
        findings.push({code: "SCHEDULE_REQUIRED", severity: "error", message: "A holiday calendar goes with a schedule"})
    if (asked.workingScheduleId)
        attempt(findings, () => schedules().checkAssignable(asked.workingScheduleId, employment.organizationPartyId, at))
    if (asked.holidayCategoryId)
        attempt(findings, () => schedules().checkCalendar(asked.holidayCategoryId, employment.organizationPartyId))
    if (scheduleFields.every(field => (asked[field] || null) === (before[field] || null)))
        findings.push({code: "NOTHING_CHANGES", severity: "error", message: "Nothing changes from that date"})
    refuseErrors(findings)
    const employmentChangeId = createChange(
        employment,
        "EckSchedule",
        Object.assign(termsOfRow(before), asked, {
            statusId: "EchRequested",
            effectiveDate: stamp(at),
            reason: text(p.reason) || null,
            employmentRevision: revision,
            operationKey
        })
    )
    approvals().keepWaiting(
        approvalKind,
        waiting.filter(row => row.changeKindEnumId !== payKind).map(row => row.employmentChangeId),
        () => {
            applyChange(changeOf(employmentChangeId))
            carrySchedule(employment, waiting)
        }
    )
    return Object.assign(changeAnswer(changeOf(employmentChangeId)), {repeated: false})
}
// A schedule's date when none is given: the start of today in the user's zone, or the start of the employment or of the assignment
// in effect when it began later today (a hire made today), so the day is planned from its start.
function scheduleStart(employment) {
    const now = nowMs()
    const today = ec.user.timestampMillis(ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"))
    const current = assignmentsOf(employment.partyRelationshipId).find(row => openAt(row, now))
    return Math.max(today, employment.fromMs ?? -Infinity, ms(current?.fromDate) ?? -Infinity)
}
// The assignment in effect on a schedule's date that starts on it (a hire's first day), whose schedule then changes in place
// rather than by a new assignment that would void it; none when it is a change set for a later date HR may still withdraw
// (withdraw that first, ASSIGNMENT_SCHEDULED).
function sameStart(employment, at) {
    const row = assignmentsOf(employment.partyRelationshipId).find(row => openAt(row, at) && ms(row.fromDate) === at)
    if (!row) return null
    const change = row.employmentChangeId ? changeOf(row.employmentChangeId) : null
    if (at > nowMs() && change && withdrawableKinds.includes(change.changeKindEnumId)) return null
    return row
}
// The waiting changes that carry terms (a transfer) given the working schedule in effect on their date, as they will apply it.
function carrySchedule(employment, waiting) {
    for (const row of waiting) {
        if (row.changeKindEnumId === "EckSeparation") continue
        const terms = termsAt(employment, ms(row.effectiveDate))
        if (scheduleFields.every(field => (row[field] || null) === (terms[field] || null))) continue
        call(
            "update#" + CHANGE,
            Object.assign(
                {employmentChangeId: row.employmentChangeId},
                Object.fromEntries(scheduleFields.map(field => [field, terms[field] || null]))
            )
        )
    }
}

const operations = {
    previewHire,
    hireEmployee,
    previewEmploymentChange,
    applyEmploymentChange,
    decideEmploymentChange,
    approveNotice: p => decideNotice(p, "approve"),
    refuseNotice: p => decideNotice(p, "refuse"),
    findEmploymentChanges,
    getEmploymentDraft,
    storeEmploymentDraft,
    deleteEmploymentDraft,
    applyDueAssignments,
    withdrawEmploymentChange,
    noteAccessRequestFailure,
    assignSchedule
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown employment operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for OrganizationServices (Organization.js) and the employee record (Employees.js)
    changeManagerOfAssignment,
    // P17: an offer's terms checked as a hire checks them, and seats by name (Offers.js)
    checkTerms,
    positionNames,
    reassignDepartment,
    assignmentHistory,
    termsAt,
    termTexts,
    stateTexts
})
