// People's job classes and positions (mantle.humanres.PositionServices find#JobClasses, get#JobClass, store#JobClass,
// store#JobRequirement, find#Positions, get#Position, store#Position and store#PositionHolder; IronStone People design §5
// JobClasses, JobClassDetail, Positions and PositionDetail, PE-03; impl-people P4). Every read is a projection of the caller's
// People scope (People.js scopeOf), read with authorization off after that check.
//
// The records (design §5; impl-people F10, F35):
// - a job class is an EmplPositionClass: its title, description, work types (EmplPositionClassWorkType) and required skills
//   (EmplPositionClassSkill, class and skill only until P18 adds levels and dates). Classes are shared by every employer: a staff
//   reader reads them, an HR editor (PEOPLE_HR_VIEW and PEOPLE_HR_EDIT) changes them, and a used class is ended (thruDate), never
//   deleted, so its positions keep it and no new position takes it;
// - a position is a dated seat, an EmplPosition of its legal employer (organizationPartyId, which create#Employment checks), in a
//   department (departmentPartyId, an OrgDepartment that rolls up to the employer), of a class, with a pay grade by name only.
//   A new position is planned (EmpsPlanned); its activation is an approval decision (P5: request#PositionApproval and
//   decide#PositionApproval over Approvals.js, the request bound to the position's revision, so new terms supersede it). Ending
//   it (thruDate) keeps it;
// - a position's holders are its dated occupancy rows (EmplPositionParty, role Employee), and an employment that names the
//   position (Employment.emplPositionId, over the employment's dates) for a person with no occupancy row of it. A seat has one
//   holder at a time: an overlapping holder is refused, and an end before a holder's last day is refused. Vacancy is computed
//   from the holders at a date, never stored.
// Positions are read by an HR, recruiting, payroll or People configuration reader of the employer, and by a manager
// (PEOPLE_TEAM_VIEW) for the departments they lead and the units under them. Pay amounts are never part of any answer here: a
// grade is its name (PayrollSetup.js gives a band's amounts to PAYROLL_VIEW). Missing and unauthorized records are refused
// alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const POSITION = "mantle.humanres.position.EmplPosition"
const CLASS = "mantle.humanres.position.EmplPositionClass"
const CLASS_SKILL = "mantle.humanres.position.EmplPositionClassSkill"
const CLASS_WORK_TYPE = "mantle.humanres.position.EmplPositionClassWorkType"
const HOLDER = "mantle.humanres.position.EmplPositionParty"
const EMPLOYMENT = "mantle.humanres.employment.Employment"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const holderRole = "Employee"
const statusTexts = {EmpsPlanned: "Planned", EmpsActive: "Active", EmpsInactive: "Inactive"}
// the capabilities that read every position of an employer in scope
const positionReads = ["hrView", "recruitView", "payrollView", "configure"]
// the most positions a find reads, and an export answers
const positionCap = 2000
// a parent chain longer than this is taken to be a cycle
const maxDepth = 50

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const unique = people.unique
// a parameter given: null (as an undeclared or unpassed one) leaves a field as it is, an empty text clears it
const given = value => value != null
const flag = value => (value === true || value === "true" || value === "Y" ? "Y" : value == null || value === "" ? null : "N")
// an effective date (now when empty): the start of a date alone, in the user's zone
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const openAt = (row, at) => (row.fromMs ?? -Infinity) <= at && (row.thruMs ?? Infinity) > at
const overlaps = (a, b) => (a.fromMs ?? -Infinity) < (b.thruMs ?? Infinity) && (b.fromMs ?? -Infinity) < (a.thruMs ?? Infinity)
const periodText = row =>
    [dateText(row.fromMs), row.thruMs != null ? dateText(row.thruMs) : ""].filter(Boolean).join(" – ") || "Open"
// a record's revision: its last change, what a change of it names
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
function searchCondition(fields, term) {
    const factory = ec.entity.conditionFactory
    return factory.makeCondition(
        fields.map(field => factory.makeCondition(field, "like", likeText(term)).ignoreCase()),
        "or"
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
function gradeNames(payGradeIds) {
    const ids = unique(payGradeIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.humanres.rate.PayGrade").condition("payGradeId", "in", ids).list()).map(row => [
            row.payGradeId,
            row.description || row.payGradeId
        ])
    )
}

// ===== scope =====
function staffScope(what) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.staff) denied("PERMISSION_DENIED", what + " are not available")
    return userScope
}
function editorScope(what) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !caps.hrEdit) denied("PERMISSION_DENIED", what + " needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT")
    return userScope
}
// The positions the caller reads: every position of the employers in scope for an HR, recruiting, payroll or configuration
// reader; and for a manager the positions of the units they lead now (a Manager membership, P3) and the units under them.
function positionReach(userScope) {
    const caps = userScope.capabilities
    const organizationPartyIds = positionReads.some(name => caps[name]) ? Array.from(userScope.organizationPartyIds) : []
    let unitPartyIds = []
    if (caps.team && userScope.partyId) {
        const led = unique(
            Array.from(
                people
                    .current(
                        find(RELATIONSHIP)
                            .condition("relationshipTypeEnumId", "PrtMember")
                            .condition("fromPartyId", userScope.partyId)
                            .condition("fromRoleTypeId", "Manager"),
                        null
                    )
                    .selectField("toPartyId")
                    .list()
            ).map(row => row.toPartyId)
        )
        unitPartyIds = led.length ? unique(led.concat(people.unitsUnder(led))) : []
    }
    return {organizationPartyIds, unitPartyIds}
}
function positionReader() {
    const userScope = people.scopeOf()
    const reach = positionReach(userScope)
    if (!reach.organizationPartyIds.length && !reach.unitPartyIds.length)
        denied("PERMISSION_DENIED", "Positions are not available")
    return {userScope, reach}
}
const reaches = (reach, row) =>
    reach.organizationPartyIds.includes(row.organizationPartyId) ||
    (!!row.departmentPartyId && reach.unitPartyIds.includes(row.departmentPartyId))
function visiblePosition(reach, emplPositionId) {
    const id = text(emplPositionId)
    const position = id ? one(POSITION, {emplPositionId: id}) : null
    if (!position || !reaches(reach, position)) denied("RECORD_UNAVAILABLE", "Position " + id + " is not available")
    return position
}

// ===== holders =====
// The holders of the positions: {emplPositionId: [holder]}, each {partyId, fromMs, thruMs, source, comments}: the dated
// occupancy rows, and an employment naming the position for a person with no occupancy row of it (source employment). A row that
// ends on its own start (a withdrawn change's seat, P7) never held it and is left out (P7 review).
function holdersOf(positionIds) {
    const found = {}
    if (!positionIds.length) return found
    const listOf = emplPositionId => found[emplPositionId] || (found[emplPositionId] = [])
    for (const row of Array.from(
        find(HOLDER).condition("emplPositionId", "in", positionIds).condition("roleTypeId", holderRole).list()
    ).filter(row => row.thruDate == null || ms(row.thruDate) > (ms(row.fromDate) ?? -Infinity)))
        listOf(row.emplPositionId).push({
            partyId: row.partyId,
            fromMs: ms(row.fromDate),
            thruMs: ms(row.thruDate),
            source: "position",
            comments: row.comments || ""
        })
    const named = Array.from(
        find(EMPLOYMENT)
            .condition("emplPositionId", "in", positionIds)
            .selectField(["partyRelationshipId", "emplPositionId"])
            .list()
    )
    if (named.length) {
        const relationships = new Map(
            Array.from(
                find(RELATIONSHIP)
                    .condition(
                        "partyRelationshipId",
                        "in",
                        named.map(row => row.partyRelationshipId)
                    )
                    .list()
            ).map(row => [row.partyRelationshipId, row])
        )
        for (const row of named) {
            const relationship = relationships.get(row.partyRelationshipId)
            if (!relationship) continue
            const holders = listOf(row.emplPositionId)
            if (holders.some(holder => holder.partyId === relationship.fromPartyId && holder.source === "position")) continue
            holders.push({
                partyId: relationship.fromPartyId,
                fromMs: ms(relationship.fromDate),
                thruMs: ms(relationship.thruDate),
                source: "employment",
                comments: ""
            })
        }
    }
    for (const holders of Object.values(found)) holders.sort((a, b) => (b.fromMs ?? 0) - (a.fromMs ?? 0))
    return found
}

// ===== position rows =====
// A position's state on the date: ended, not yet started, inactive, or planned or active by its status.
function positionState(position, at) {
    const fromMs = ms(position.fromDate)
    const thruMs = ms(position.thruDate)
    if (thruMs != null && thruMs <= at) return {state: "ended", stateText: "Ended " + dateText(position.thruDate)}
    if (fromMs != null && fromMs > at) return {state: "future", stateText: "From " + dateText(position.fromDate)}
    if (position.statusId === "EmpsInactive") return {state: "inactive", stateText: "Inactive"}
    if (position.statusId === "EmpsActive") return {state: "active", stateText: "Active"}
    return {state: "planned", stateText: "Planned"}
}
// The rows of the positions on the date, as the list and the record show them: the seat's name, employer, department, class,
// grade name, dates, state, vacancy (filled or vacant while in effect, from its holders at the date) and holder, whether the
// caller may change it and its revision. No pay amount.
function positionRows(userScope, positions, at) {
    if (!positions.length) return []
    const holders = holdersOf(positions.map(row => row.emplPositionId))
    const classIds = unique(positions.map(row => row.emplPositionClassId).filter(Boolean))
    const classes = classIds.length
        ? new Map(
              Array.from(find(CLASS).condition("emplPositionClassId", "in", classIds).list()).map(row => [
                  row.emplPositionClassId,
                  row
              ])
          )
        : new Map()
    const organizations = people.organizationNames(
        unique(positions.flatMap(row => [row.organizationPartyId, row.departmentPartyId]).filter(Boolean))
    )
    const grades = gradeNames(positions.map(row => row.payGradeId))
    const currentHolders = Object.fromEntries(
        Object.entries(holders).map(([emplPositionId, list]) => [emplPositionId, list.filter(holder => openAt(holder, at))])
    )
    const names = people.personNames(
        unique(
            Object.values(currentHolders)
                .flat()
                .map(holder => holder.partyId)
        )
    )
    const caps = userScope.capabilities
    const canEdit = !!caps.hrView && !!caps.hrEdit
    return positions.map(row => {
        const positionClass = row.emplPositionClassId ? classes.get(row.emplPositionClassId) : null
        const state = positionState(row, at)
        const held = currentHolders[row.emplPositionId] || []
        const inEffect = state.state === "planned" || state.state === "active"
        const vacancy = inEffect ? (held.length ? "filled" : "vacant") : null
        return {
            emplPositionId: row.emplPositionId,
            pseudoId: row.pseudoId || row.emplPositionId,
            positionName: row.description || positionClass?.title || row.emplPositionId,
            description: row.description || "",
            organizationPartyId: row.organizationPartyId,
            organizationName: organizations[row.organizationPartyId] || row.organizationPartyId || "",
            departmentPartyId: row.departmentPartyId || null,
            departmentName: row.departmentPartyId ? organizations[row.departmentPartyId] || row.departmentPartyId : "",
            emplPositionClassId: row.emplPositionClassId || null,
            classTitle: positionClass?.title || "",
            payGradeId: row.payGradeId || null,
            payGradeName: row.payGradeId ? grades[row.payGradeId] || row.payGradeId : "",
            statusId: row.statusId || "EmpsPlanned",
            statusText: statusTexts[row.statusId] || "Planned",
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            standardHoursPerWeek: row.standardHoursPerWeek ?? null,
            fullTimeFlag: row.fullTimeFlag || null,
            temporaryFlag: row.temporaryFlag || null,
            salaryFlag: row.salaryFlag || null,
            overtimeFlag: row.overtimeFlag || null,
            state: state.state,
            stateText: state.stateText,
            vacancy,
            vacancyText: vacancy === "filled" ? "Filled" : vacancy === "vacant" ? "Vacant" : "",
            holderPartyId: held[0]?.partyId || null,
            holderName: held.map(holder => names[holder.partyId] || holder.partyId).join(", "),
            canEdit: canEdit && userScope.organizationPartyIds.includes(row.organizationPartyId),
            revision: String(stampOf(row))
        }
    })
}

// ===== find#Positions =====
// The positions the caller reads as of a date, with their vacancy, filtered by employer (refused outside the scope), department,
// class, grade, status, vacancy and a search of the seat's name, id and class title ignoring case; ended positions only when
// asked. Paged, an export up to the cap.
function findPositions(p) {
    const {userScope, reach} = positionReader()
    if (text(p.organizationPartyId) && reach.organizationPartyIds.length)
        people.requireOrganization({organizationPartyIds: reach.organizationPartyIds}, text(p.organizationPartyId))
    const at = people.asOfMillis(p.asOfDate)
    const factory = ec.entity.conditionFactory
    const reachConditions = []
    if (reach.organizationPartyIds.length)
        reachConditions.push(factory.makeCondition("organizationPartyId", "in", reach.organizationPartyIds))
    if (reach.unitPartyIds.length) reachConditions.push(factory.makeCondition("departmentPartyId", "in", reach.unitPartyIds))
    let query = find(POSITION).condition(factory.makeCondition(reachConditions, "or"))
    for (const field of ["organizationPartyId", "departmentPartyId", "emplPositionClassId", "payGradeId", "statusId"])
        if (text(p[field])) query = query.condition(field, text(p[field]))
    if (!(p.includeEnded === true || p.includeEnded === "true"))
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", people.stamp(at))
            )
        )
    if (text(p.term)) {
        const classIds = Array.from(
            find(CLASS)
                .condition(searchCondition(["title"], text(p.term)))
                .selectField("emplPositionClassId")
                .limit(200)
                .list()
        ).map(row => row.emplPositionClassId)
        const searched = [searchCondition(["emplPositionId", "pseudoId", "description"], text(p.term))]
        if (classIds.length) searched.push(factory.makeCondition("emplPositionClassId", "in", classIds))
        query = query.condition(factory.makeCondition(searched, "or"))
    }
    let found = positionRows(userScope, Array.from(query.limit(positionCap).list()), at)
    if (text(p.vacancy)) found = found.filter(row => row.vacancy === text(p.vacancy))
    found.sort(
        (a, b) =>
            a.organizationName.localeCompare(b.organizationName) ||
            a.departmentName.localeCompare(b.departmentName) ||
            a.positionName.localeCompare(b.positionName) ||
            a.emplPositionId.localeCompare(b.emplPositionId)
    )
    const vacantCount = found.filter(row => row.vacancy === "vacant").length
    return Object.assign(lib.pageList(found, p, "positions", {noLimitCap: positionCap}), {vacantCount, asOfDate: at})
}

// ===== get#Position =====
// One position the caller reads, as of a date: its row and every holder, dated (current, future, ended), with the person's
// employment by the position's employer in that period.
function getPosition(p) {
    const {userScope, reach} = positionReader()
    const position = visiblePosition(reach, p.emplPositionId)
    const at = people.asOfMillis(p.asOfDate)
    const row = positionRows(userScope, [position], at)[0]
    const holders = holdersOf([position.emplPositionId])[position.emplPositionId] || []
    const partyIds = unique(holders.map(holder => holder.partyId))
    const names = people.personNames(partyIds)
    const employments = partyIds.length
        ? Array.from(
              people
                  .employmentFind()
                  .condition("fromPartyId", "in", partyIds)
                  .condition("toPartyId", position.organizationPartyId)
                  .list()
          ).map(employment => ({
              partyRelationshipId: employment.partyRelationshipId,
              partyId: employment.fromPartyId,
              fromMs: ms(employment.fromDate),
              thruMs: ms(employment.thruDate)
          }))
        : []
    const rank = {current: 0, future: 1, ended: 2}
    const holderRows = holders
        .map(holder => {
            const state =
                (holder.thruMs ?? Infinity) <= at
                    ? {state: "ended", stateText: "Ended"}
                    : (holder.fromMs ?? -Infinity) > at
                      ? {state: "future", stateText: "From " + dateText(holder.fromMs)}
                      : {state: "current", stateText: "Current"}
            const employment = employments.find(row => row.partyId === holder.partyId && overlaps(row, holder))
            return Object.assign(
                {
                    partyId: holder.partyId,
                    personName: names[holder.partyId] || holder.partyId,
                    fromMs: holder.fromMs,
                    fromDateText: dateText(holder.fromMs),
                    thruDateText: dateText(holder.thruMs),
                    periodText: periodText(holder),
                    source: holder.source,
                    sourceText: holder.source === "employment" ? "Named by the employment" : "Holder",
                    partyRelationshipId: employment?.partyRelationshipId || null,
                    comments: holder.comments
                },
                state
            )
        })
        .sort((a, b) => rank[a.state] - rank[b.state] || (b.fromMs ?? 0) - (a.fromMs ?? 0))
    // P5: the seat's latest activation request, and whether an HR editor may ask for one (a planned seat not ended, with none
    // waiting); an approver of the step waiting may decide it here (canDecide)
    const approval = approvals().sourceSummary(approvalKind, position.emplPositionId)
    row.canRequestApproval =
        !!row.canEdit && row.statusId === "EmpsPlanned" && row.state !== "ended" && !(approval && approval.waiting)
    return {position: row, holders: holderRows, approval, asOfDate: at}
}

// ===== store#Position =====
// A new planned position, or a position's new terms (design §5 NewPosition, PositionTerms). Refused: a caller without
// PEOPLE_HR_VIEW and PEOPLE_HR_EDIT (PERMISSION_DENIED); no employer (ORGANIZATION_REQUIRED), one outside the scope
// (ORGANIZATION_DENIED) or another one for an existing position (EMPLOYER_CHANGE); no class (CLASS_REQUIRED), a missing one
// (RECORD_UNAVAILABLE) or an ended one (CLASS_ENDED); a department that is not one (NOT_A_DEPARTMENT) or does not roll up to the
// employer (DEPARTMENT_OUTSIDE); a missing grade or another employer's (RECORD_UNAVAILABLE); an end on or before the start (DATES_INVALID); hours
// outside 0 to 168 (HOURS_INVALID); an end before a holder's last day (OCCUPIED_AFTER_END) or a start after a holder's first
// (OCCUPIED_BEFORE_START); a position outside the scope (RECORD_UNAVAILABLE); a revision other than the one read
// (REVISION_CHANGED). The department, class and grade are audited, with the change reason.
function checkClass(emplPositionClassId, at) {
    const id = text(emplPositionClassId)
    if (!id) denied("CLASS_REQUIRED", "Choose the job class")
    const positionClass = one(CLASS, {emplPositionClassId: id})
    if (!positionClass) denied("RECORD_UNAVAILABLE", "Job class " + id + " is not available")
    if ((ms(positionClass.thruDate) ?? Infinity) <= at)
        denied("CLASS_ENDED", (positionClass.title || id) + " has ended; choose a current job class")
    return id
}
// A department of the employer: an OrgDepartment whose rollups in effect on the date reach the employer.
function checkDepartment(departmentPartyId, organizationPartyId, at) {
    const id = text(departmentPartyId)
    if (!id) return null
    const name = people.organizationNames([id])[id] || id
    if (!one("mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgDepartment"}))
        denied("NOT_A_DEPARTMENT", name + " is not a department")
    let above = id
    for (let depth = 0; above && depth < maxDepth; depth++) {
        const parent = Array.from(
            people
                .current(
                    find(RELATIONSHIP).condition("relationshipTypeEnumId", "PrtOrgRollup").condition("fromPartyId", above),
                    at
                )
                .list()
        )[0]
        if (!parent) break
        if (parent.toPartyId === organizationPartyId) return id
        above = parent.toPartyId
    }
    denied(
        "DEPARTMENT_OUTSIDE",
        name +
            " is not a department of " +
            (people.organizationNames([organizationPartyId])[organizationPartyId] || organizationPartyId)
    )
}
// A grade the employer's positions take: its own or a shared one (PayrollSetup.js); another employer's is a missing one.
function checkGrade(payGradeId, organizationPartyId) {
    const id = text(payGradeId)
    if (!id) return null
    const grade = one("mantle.humanres.rate.PayGrade", {payGradeId: id})
    if (!grade || (grade.organizationPartyId && grade.organizationPartyId !== organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Pay grade " + id + " is not available")
    return id
}
function checkHours(value) {
    if (value == null || value === "") return null
    const hours = Number(value)
    if (!Number.isInteger(hours) || hours < 0 || hours > 168)
        denied("HOURS_INVALID", "Hours a week are a whole number from 0 to 168")
    return hours
}
function storePosition(p) {
    const userScope = editorScope("Changing a position")
    const reason = text(p.changeReason) || null
    if (!text(p.emplPositionId)) {
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
        people.requireOrganization(userScope, organizationPartyId)
        const fromMs = effective(p.fromDate)
        const thruMs = text(p.thruDate) ? effective(p.thruDate) : null
        if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A position ends after it starts")
        const checkAt = Math.max(fromMs, nowMs())
        const values = {
            organizationPartyId,
            emplPositionClassId: checkClass(p.emplPositionClassId, checkAt),
            departmentPartyId: checkDepartment(p.departmentPartyId, organizationPartyId, checkAt),
            payGradeId: checkGrade(p.payGradeId, organizationPartyId),
            description: text(p.description) || null,
            statusId: "EmpsPlanned",
            fromDate: new Date(fromMs),
            thruDate: thruMs == null ? null : new Date(thruMs),
            standardHoursPerWeek: checkHours(p.standardHoursPerWeek),
            fullTimeFlag: flag(p.fullTimeFlag),
            temporaryFlag: flag(p.temporaryFlag),
            salaryFlag: flag(p.salaryFlag),
            overtimeFlag: flag(p.overtimeFlag)
        }
        const created = call("create#" + POSITION, values)
        const position = one(POSITION, {emplPositionId: created.emplPositionId})
        return {emplPositionId: created.emplPositionId, revision: String(stampOf(position))}
    }
    const position = one(POSITION, {emplPositionId: text(p.emplPositionId)})
    if (!position || !userScope.organizationPartyIds.includes(position.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Position " + text(p.emplPositionId) + " is not available")
    const revision = String(stampOf(position))
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This position changed since you read it; open it again (revision " + revision + ")")
    if (text(p.organizationPartyId) && text(p.organizationPartyId) !== position.organizationPartyId)
        denied("EMPLOYER_CHANGE", "A position stays with its legal employer; plan a position of the other employer instead")
    const changes = {emplPositionId: position.emplPositionId}
    const fromMs = given(p.fromDate) && text(p.fromDate) ? effective(p.fromDate) : ms(position.fromDate)
    const thruMs = given(p.thruDate) ? (text(p.thruDate) ? effective(p.thruDate) : null) : ms(position.thruDate)
    if (thruMs != null && thruMs <= (fromMs ?? -Infinity)) denied("DATES_INVALID", "A position ends after it starts")
    const checkAt = Math.max(fromMs ?? 0, nowMs())
    if (given(p.emplPositionClassId) && text(p.emplPositionClassId) !== (position.emplPositionClassId || ""))
        changes.emplPositionClassId = checkClass(p.emplPositionClassId, checkAt)
    if (given(p.departmentPartyId) && (text(p.departmentPartyId) || null) !== (position.departmentPartyId || null))
        changes.departmentPartyId = checkDepartment(p.departmentPartyId, position.organizationPartyId, checkAt)
    if (given(p.payGradeId) && (text(p.payGradeId) || null) !== (position.payGradeId || null))
        changes.payGradeId = checkGrade(p.payGradeId, position.organizationPartyId)
    if (given(p.description)) changes.description = text(p.description) || null
    if (given(p.standardHoursPerWeek)) changes.standardHoursPerWeek = checkHours(p.standardHoursPerWeek)
    for (const field of ["fullTimeFlag", "temporaryFlag", "salaryFlag", "overtimeFlag"])
        if (given(p[field])) changes[field] = flag(p[field])
    // the holders stay inside the position's dates: an end checks every holder after it, a start every holder before it
    const holders = holdersOf([position.emplPositionId])[position.emplPositionId] || []
    const names = people.personNames(unique(holders.map(holder => holder.partyId)))
    if (thruMs !== ms(position.thruDate)) {
        const after = thruMs == null ? null : holders.find(holder => (holder.thruMs ?? Infinity) > thruMs)
        if (after)
            denied(
                "OCCUPIED_AFTER_END",
                (names[after.partyId] || after.partyId) + " holds this position after " + dateText(thruMs) + "; end that first"
            )
        changes.thruDate = thruMs == null ? null : new Date(thruMs)
    }
    if (fromMs !== ms(position.fromDate)) {
        const before = holders.find(holder => (holder.fromMs ?? -Infinity) < fromMs)
        if (before)
            denied(
                "OCCUPIED_BEFORE_START",
                (names[before.partyId] || before.partyId) + " holds this position before " + dateText(fromMs)
            )
        changes.fromDate = new Date(fromMs)
    }
    for (const field of ["emplPositionClassId", "departmentPartyId", "payGradeId"])
        if (Object.hasOwn(changes, field)) changes[field + "_changeReason"] = reason
    if (Object.keys(changes).length > 1) {
        call("update#" + POSITION, changes)
        // new terms supersede an activation request made at the earlier revision (P5)
        approvals().sourceChanged(approvalKind, position.emplPositionId)
    }
    return {
        emplPositionId: position.emplPositionId,
        revision: String(stampOf(one(POSITION, {emplPositionId: position.emplPositionId})))
    }
}

// ===== store#PositionHolder =====
// A person holds a position from a date (the occupancy P6's hire and employment change write), or a holding ends. Refused: a
// caller without PEOPLE_HR_VIEW and PEOPLE_HR_EDIT (PERMISSION_DENIED); a position outside the scope (RECORD_UNAVAILABLE), not in
// effect on the date (POSITION_NOT_IN_EFFECT) or inactive (POSITION_INACTIVE); no person (PERSON_REQUIRED) or one the employer
// does not employ on the date (NOT_EMPLOYED); a holder in the same period (POSITION_OCCUPIED: one holder at a time); an end of a
// holding that is not the position's (RECORD_UNAVAILABLE), has ended (HOLDER_ENDED), is on or before its start (DATE_STALE) or
// moves later into another holder's period (POSITION_OCCUPIED). A holding ends with the position at the latest.
function storePositionHolder(p) {
    const userScope = editorScope("Changing a position's holder")
    const position = one(POSITION, {emplPositionId: text(p.emplPositionId)})
    if (!position || !userScope.organizationPartyIds.includes(position.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Position " + text(p.emplPositionId) + " is not available")
    const partyId = text(p.partyId)
    if (!partyId) denied("PERSON_REQUIRED", "Choose the person")
    if (text(p.holderFromDate)) {
        const holderFromMs = /^\d+$/.test(text(p.holderFromDate)) ? Number(text(p.holderFromDate)) : effective(p.holderFromDate)
        return endHolding(position, partyId, holderFromMs, effective(p.thruDate), text(p.changeReason), true)
    }
    return holdSeat(
        position,
        partyId,
        effective(p.fromDate),
        text(p.thruDate) ? effective(p.thruDate) : null,
        text(p.changeReason)
    )
}
// A person's holding of a seat from fromMs to thruMs (open when null), checked as store#PositionHolder checks it but not the
// caller, which has checked its own (store#PositionHolder; P6's hire and employment change, Employment.js, applied by an
// approver too): the seat in effect and not inactive on the date, the person employed by its employer then, no other holder in
// the period; a holding ends with the position at the latest.
function holdSeat(position, partyId, fromMs, thruMs, reason) {
    const holders = holdersOf([position.emplPositionId])[position.emplPositionId] || []
    const positionThruMs = ms(position.thruDate)
    if (thruMs != null && thruMs <= fromMs) denied("DATE_STALE", "A holding ends after it starts")
    if ((ms(position.fromDate) ?? -Infinity) > fromMs || (positionThruMs ?? Infinity) <= fromMs)
        denied("POSITION_NOT_IN_EFFECT", "The position is not in effect on that date")
    if (position.statusId === "EmpsInactive") denied("POSITION_INACTIVE", "The position is inactive")
    // a holding ends with the position at the latest
    if (positionThruMs != null && (thruMs ?? Infinity) > positionThruMs) thruMs = positionThruMs
    const employed = people
        .current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: position.organizationPartyId}), fromMs)
        .count()
    if (!employed)
        denied(
            "NOT_EMPLOYED",
            "The person is not employed by " +
                (people.organizationNames([position.organizationPartyId])[position.organizationPartyId] || "the employer") +
                " on that date"
        )
    const other = otherHolder(holders, partyId, {fromMs, thruMs})
    if (other) occupied(other)
    call("create#" + HOLDER, {
        emplPositionId: position.emplPositionId,
        partyId,
        roleTypeId: holderRole,
        fromDate: new Date(fromMs),
        thruDate: thruMs == null ? null : new Date(thruMs),
        comments: reason || null
    })
    return {emplPositionId: position.emplPositionId, partyId, fromMs}
}
// The end of a person's holding of a seat (the row starting holderFromMs) on thruMs, capped at the seat's end and refused when a
// later end reaches another holder's period. checkEnded refuses a holding that has ended (store#PositionHolder); P6's changes end
// the holding in effect, which has not.
function endHolding(position, partyId, holderFromMs, thruMs, reason, checkEnded = false) {
    const nameOf = () => people.personNames([partyId])[partyId] || partyId
    const holders = holdersOf([position.emplPositionId])[position.emplPositionId] || []
    const row = rows(HOLDER, {emplPositionId: position.emplPositionId, partyId, roleTypeId: holderRole}).find(
        found => ms(found.fromDate) === holderFromMs
    )
    if (!row) denied("RECORD_UNAVAILABLE", "This holding is not available")
    if (checkEnded && (ms(row.thruDate) ?? Infinity) <= nowMs()) denied("HOLDER_ENDED", nameOf() + "'s holding has ended")
    if (thruMs <= holderFromMs) denied("DATE_STALE", "A holding ends after it starts")
    // a holding ends with the position at the latest, and a later end overlaps no other holder
    if (ms(position.thruDate) != null && thruMs > ms(position.thruDate)) thruMs = ms(position.thruDate)
    const self = holders.find(
        holder => holder.source === "position" && holder.partyId === partyId && holder.fromMs === holderFromMs
    )
    const other = otherHolder(holders, partyId, {fromMs: holderFromMs, thruMs}, self)
    if (other) occupied(other)
    call("update#" + HOLDER, {
        emplPositionId: row.emplPositionId,
        partyId: row.partyId,
        roleTypeId: row.roleTypeId,
        fromDate: row.fromDate,
        thruDate: new Date(thruMs),
        comments: [row.comments, reason].filter(Boolean).join("; ") || null
    })
    return {emplPositionId: position.emplPositionId, partyId, fromMs: holderFromMs}
}
// another holder of the seat in the period (the person's own employment naming the seat is the holding being written, not another)
const otherHolder = (holders, partyId, holding, except) =>
    holders.find(
        holder =>
            holder !== except && !(holder.partyId === partyId && holder.source === "employment") && overlaps(holder, holding)
    )
const occupied = other =>
    denied(
        "POSITION_OCCUPIED",
        (people.personNames([other.partyId])[other.partyId] || other.partyId) + " holds this position then; a seat has one holder"
    )

// ===== the activation approval (P5) =====
const approvalKind = "PakPosition"
// request#PositionApproval: an HR editor asks for a planned seat's activation, at the revision read, with the effective date and
// a justification; routed by the employer's rules for the position's department (Approvals.js), never to the requester. A retry
// with the same operation key answers the first request. Refused: a caller without PEOPLE_HR_VIEW and PEOPLE_HR_EDIT
// (PERMISSION_DENIED); a position outside the scope (RECORD_UNAVAILABLE); one not planned or ended (NOT_PLANNED); no
// justification (JUSTIFICATION_REQUIRED); a revision other than the one read (REVISION_CHANGED); a request already waiting
// (APPROVAL_PENDING).
function requestPositionApproval(p) {
    const userScope = editorScope("Asking for a position's activation")
    const position = one(POSITION, {emplPositionId: text(p.emplPositionId)})
    if (!position || !userScope.organizationPartyIds.includes(position.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Position " + text(p.emplPositionId) + " is not available")
    if (text(p.operationKey)) {
        const first = rows("mantle.humanres.approval.PeopleApproval", {
            sourceEntityName: POSITION,
            sourceId: position.emplPositionId,
            operationKey: text(p.operationKey)
        }).find(row => row.requestedByUserId === ec.user.userId)
        if (first)
            return approvals().request({
                approvalKindEnumId: approvalKind,
                sourceId: position.emplPositionId,
                operationKey: text(p.operationKey)
            })
    }
    if (position.statusId !== "EmpsPlanned" || (ms(position.thruDate) ?? Infinity) <= nowMs())
        denied("NOT_PLANNED", "Only a planned position that has not ended is asked to be activated")
    const revision = String(stampOf(position))
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This position changed since you read it; open it again (revision " + revision + ")")
    if (!text(p.justification)) denied("JUSTIFICATION_REQUIRED", "Say why the position is needed")
    return approvals().request({
        approvalKindEnumId: approvalKind,
        sourceId: position.emplPositionId,
        organizationPartyId: position.organizationPartyId,
        departmentPartyId: position.departmentPartyId,
        effectiveDate: p.effectiveDate,
        justification: p.justification,
        operationKey: p.operationKey
    })
}
// decide#PositionApproval: the step waiting of a seat's activation request decided (PeopleApprovalServices.record#Decision, which
// rechecks the decider's authority and the position's revision); the last step's approval activates the planned seat
// (EmpsActive). A decision retried answers the first and activates nothing again.
function decidePositionApproval(p) {
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: approvalKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: text(p.emplPositionId) || null,
        decision: text(p.decision) || "approve",
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    const position = one(POSITION, {emplPositionId: decided.sourceId})
    let activated = false
    if (decided.complete && !decided.repeated && position && position.statusId === "EmpsPlanned") {
        call("update#" + POSITION, {emplPositionId: position.emplPositionId, statusId: "EmpsActive"})
        activated = true
    }
    return {
        peopleApprovalId: decided.peopleApprovalId,
        peopleApprovalDecisionId: decided.peopleApprovalDecisionId,
        statusId: decided.statusId,
        emplPositionId: decided.sourceId,
        positionStatusId: one(POSITION, {emplPositionId: decided.sourceId})?.statusId || null,
        activated,
        repeated: decided.repeated
    }
}
// approve#PositionApproval and refuse#PositionApproval, the PeoplePositionApproval topic's services, which the framework calls
// as the user deciding a notice: decide#PositionApproval at the request and revision in the message.
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== POSITION) denied("SOURCE_INVALID", "Not a position approval")
    return decidePositionApproval({
        emplPositionId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}

// ===== job classes =====
function classRevision(emplPositionClassId) {
    const stamps = [stampOf(one(CLASS, {emplPositionClassId}))]
        .concat(rows(CLASS_WORK_TYPE, {emplPositionClassId}).map(stampOf))
        .concat(rows(CLASS_SKILL, {emplPositionClassId}).map(stampOf))
    return String(Math.max(...stamps))
}
// The rows of the classes: title, a short description, the skill count, the positions of it in effect the caller reads (none
// counted for a reader of no position), state, whether the caller may change it and its revision.
function classRows(userScope, classes) {
    if (!classes.length) return []
    const ids = classes.map(row => row.emplPositionClassId)
    const skills = {}
    for (const row of Array.from(find(CLASS_SKILL).condition("emplPositionClassId", "in", ids).list()))
        skills[row.emplPositionClassId] = (skills[row.emplPositionClassId] || 0) + 1
    const reach = positionReach(userScope)
    const positions = {}
    if (reach.organizationPartyIds.length || reach.unitPartyIds.length) {
        const at = nowMs()
        for (const row of Array.from(find(POSITION).condition("emplPositionClassId", "in", ids).list()))
            if (reaches(reach, row) && (ms(row.thruDate) ?? Infinity) > at)
                positions[row.emplPositionClassId] = (positions[row.emplPositionClassId] || 0) + 1
    }
    const caps = userScope.capabilities
    const now = nowMs()
    return classes.map(row => {
        const ended = (ms(row.thruDate) ?? Infinity) <= now
        const description = String(row.description || "")
        return {
            emplPositionClassId: row.emplPositionClassId,
            title: row.title || row.emplPositionClassId,
            description,
            summary: description.length > 140 ? description.slice(0, 139) + "…" : description,
            skillCount: skills[row.emplPositionClassId] || 0,
            positionCount:
                reach.organizationPartyIds.length || reach.unitPartyIds.length ? positions[row.emplPositionClassId] || 0 : null,
            state: ended ? "ended" : "current",
            stateText: ended ? "Ended " + dateText(row.thruDate) : "Current",
            thruDateText: dateText(row.thruDate),
            canEdit: !!caps.hrView && !!caps.hrEdit,
            revision: classRevision(row.emplPositionClassId)
        }
    })
}
// find#JobClasses: the job classes by title, searched ignoring case, current ones unless ended ones are asked for; paged.
function findJobClasses(p) {
    const userScope = staffScope("Job classes")
    const factory = ec.entity.conditionFactory
    let query = find(CLASS)
    if (!(p.includeEnded === true || p.includeEnded === "true"))
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", people.stamp(nowMs()))
            )
        )
    if (text(p.term)) query = query.condition(searchCondition(["emplPositionClassId", "title"], text(p.term)))
    const recordCount = query.count()
    const paged = lib.page(query.orderBy(["^title", "emplPositionClassId"]), p, "jobClasses", recordCount, {
        noLimitCap: positionCap
    })
    const found = classRows(userScope, paged.rows)
    const out = {}
    for (const key of Object.keys(paged)) if (key.startsWith("jobClasses")) out[key] = paged[key]
    out.jobClasses = found
    return out
}
// get#JobClass: one job class, with its required skills and work types.
function getJobClass(p) {
    const userScope = staffScope("Job classes")
    const id = text(p.emplPositionClassId)
    const positionClass = id ? one(CLASS, {emplPositionClassId: id}) : null
    if (!positionClass) denied("RECORD_UNAVAILABLE", "Job class " + id + " is not available")
    const skillRows = rows(CLASS_SKILL, {emplPositionClassId: id})
    const workTypeRows = rows(CLASS_WORK_TYPE, {emplPositionClassId: id})
    const names = enumNames(skillRows.map(row => row.skillTypeEnumId).concat(workTypeRows.map(row => row.workTypeEnumId)))
    return {
        jobClass: classRows(userScope, [positionClass])[0],
        skills: skillRows
            .map(row => ({skillTypeEnumId: row.skillTypeEnumId, skillName: names[row.skillTypeEnumId] || row.skillTypeEnumId}))
            .sort((a, b) => a.skillName.localeCompare(b.skillName)),
        workTypes: workTypeRows
            .map(row => ({workTypeEnumId: row.workTypeEnumId, workTypeName: names[row.workTypeEnumId] || row.workTypeEnumId}))
            .sort((a, b) => a.workTypeName.localeCompare(b.workTypeName))
    }
}
// store#JobClass: a new job class, or a class's title, description, work types or end. Refused: a caller without PEOPLE_HR_VIEW
// and PEOPLE_HR_EDIT (PERMISSION_DENIED); no title (TITLE_REQUIRED); a work type that is not one (WORK_TYPE_INVALID); a missing
// class (RECORD_UNAVAILABLE); an end of an ended class (CLASS_ENDED); a revision other than the one read (REVISION_CHANGED).
function workTypeIds(value) {
    const list = (Array.isArray(value) ? value : value == null || value === "" ? [] : String(value).split(","))
        .map(text)
        .filter(Boolean)
    const ids = unique(list)
    if (!ids.length) return ids
    const known = Array.from(
        find("moqui.basic.Enumeration").condition("enumTypeId", "WorkType").condition("enumId", "in", ids).list()
    ).map(row => row.enumId)
    const unknown = ids.find(id => !known.includes(id))
    if (unknown) denied("WORK_TYPE_INVALID", unknown + " is not a work type")
    return ids
}
function storeJobClass(p) {
    editorScope("Changing a job class")
    if (!text(p.emplPositionClassId)) {
        if (!text(p.title)) denied("TITLE_REQUIRED", "A job class has a title")
        const workTypes = workTypeIds(p.workTypeEnumIds)
        const created = call("create#" + CLASS, {title: text(p.title), description: text(p.description) || null})
        for (const workTypeEnumId of workTypes)
            call("create#" + CLASS_WORK_TYPE, {emplPositionClassId: created.emplPositionClassId, workTypeEnumId})
        return {emplPositionClassId: created.emplPositionClassId, revision: classRevision(created.emplPositionClassId)}
    }
    const id = text(p.emplPositionClassId)
    const positionClass = one(CLASS, {emplPositionClassId: id})
    if (!positionClass) denied("RECORD_UNAVAILABLE", "Job class " + id + " is not available")
    const revision = classRevision(id)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This job class changed since you read it; open it again (revision " + revision + ")")
    const changes = {emplPositionClassId: id}
    if (given(p.title)) {
        if (!text(p.title)) denied("TITLE_REQUIRED", "A job class has a title")
        changes.title = text(p.title)
    }
    if (given(p.description)) changes.description = text(p.description) || null
    if (given(p.thruDate) && text(p.thruDate)) {
        if ((ms(positionClass.thruDate) ?? Infinity) <= nowMs()) denied("CLASS_ENDED", (positionClass.title || id) + " has ended")
        changes.thruDate = new Date(effective(p.thruDate))
    }
    if (given(p.workTypeEnumIds)) {
        const wanted = workTypeIds(p.workTypeEnumIds)
        const existing = rows(CLASS_WORK_TYPE, {emplPositionClassId: id})
        for (const row of existing)
            if (!wanted.includes(row.workTypeEnumId))
                call("delete#" + CLASS_WORK_TYPE, {emplPositionClassId: id, workTypeEnumId: row.workTypeEnumId})
        for (const workTypeEnumId of wanted)
            if (!existing.some(row => row.workTypeEnumId === workTypeEnumId))
                call("create#" + CLASS_WORK_TYPE, {emplPositionClassId: id, workTypeEnumId})
    }
    if (Object.keys(changes).length > 1) call("update#" + CLASS, changes)
    return {emplPositionClassId: id, revision: classRevision(id)}
}
// store#JobRequirement: a skill a job class requires, added or removed (class and skill only until P18 adds levels and dates).
// Refused: a caller without PEOPLE_HR_VIEW and PEOPLE_HR_EDIT (PERMISSION_DENIED); a missing class (RECORD_UNAVAILABLE) or an
// ended one (CLASS_ENDED); no skill (SKILL_REQUIRED) or one that is not a skill type (SKILL_INVALID); a skill required already
// (ALREADY_REQUIRED) or ended (VALUE_ENDED, P5's lookups; an ended one is still removed) or, to remove, not required
// (RECORD_UNAVAILABLE).
function storeJobRequirement(p) {
    editorScope("Changing a job class")
    const id = text(p.emplPositionClassId)
    const positionClass = id ? one(CLASS, {emplPositionClassId: id}) : null
    if (!positionClass) denied("RECORD_UNAVAILABLE", "Job class " + id + " is not available")
    if ((ms(positionClass.thruDate) ?? Infinity) <= nowMs()) denied("CLASS_ENDED", (positionClass.title || id) + " has ended")
    const skillTypeEnumId = text(p.skillTypeEnumId)
    if (!skillTypeEnumId) denied("SKILL_REQUIRED", "Choose the skill")
    const skill = one("moqui.basic.Enumeration", {enumId: skillTypeEnumId})
    if (!skill || skill.enumTypeId !== "SkillType") denied("SKILL_INVALID", skillTypeEnumId + " is not a skill")
    const existing = one(CLASS_SKILL, {emplPositionClassId: id, skillTypeEnumId})
    if (p.remove === true || p.remove === "true") {
        if (!existing) denied("RECORD_UNAVAILABLE", (skill.description || skillTypeEnumId) + " is not required")
        call("delete#" + CLASS_SKILL, {emplPositionClassId: id, skillTypeEnumId})
        return {emplPositionClassId: id, skillTypeEnumId}
    }
    if (existing) denied("ALREADY_REQUIRED", (skill.description || skillTypeEnumId) + " is required already")
    // an ended skill type (People's lookups, Enumeration.thruDate) is kept where it is held and taken by no new requirement
    if ((ms(skill.thruDate) ?? Infinity) <= nowMs()) denied("VALUE_ENDED", (skill.description || skillTypeEnumId) + " has ended")
    call("create#" + CLASS_SKILL, {emplPositionClassId: id, skillTypeEnumId})
    return {emplPositionClassId: id, skillTypeEnumId}
}

const operations = {
    findJobClasses,
    getJobClass,
    storeJobClass,
    storeJobRequirement,
    findPositions,
    getPosition,
    storePosition,
    storePositionHolder,
    requestPositionApproval,
    decidePositionApproval,
    approveNotice: p => decideNotice(p, "approve"),
    refuseNotice: p => decideNotice(p, "refuse")
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown position operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // P6: a seat's holders and a holding written or ended by a hire or an employment change (Employment.js), whose caller is checked
    holdersOf,
    holdSeat,
    endHolding,
    checkDepartment
})
