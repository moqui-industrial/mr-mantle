// Maintenance dispatch: teams, the ranked technicians of a work order and the qualification check of assignment and Start
// (IronStone Maintenance design §3 AssignSchedule and BulkWork, §9 Teams and MaintenanceSettings, review Y4 and Y8; MT-01, MT-02;
// impl-maintenance P8). Every call checks the maintenance permission and scope first (MaintenanceAccess.js).
//
// - Teams are People's (impl-people P3, F60): an OrgTeam Organization owned by its organization, with dated PrtMember rows from
//   the person (from role Assignee for a member, Manager for the lead) to the team (to role OrgTeam), written by
//   mantle.humanres.OrganizationServices. Maintenance reads them (find#MaintenanceTeams) and owns only their dispatch defaults
//   (MaintenanceTeamDefaults, dated: store#MaintenanceTeamDefaults). Membership grants nothing: no permission, no work read (a
//   work order's team row makes no member assigned, MaintenanceAccess.js assignment), no custody.
// - The technicians of a work order (find#MaintenanceCandidates): the organization's people now (employees and agents, those
//   schedule#MaintenanceWorkOrder admits), ranked by Projects' find#StaffingCandidates over the work's skills, each with the least
//   level its steps ask (WorkEffortSkillStandard.minimumSkillLevel), and the free hours of its planned window from
//   get#PartyCapacity (People's schedules, shifts, holidays and approved leave): the team's members first, and in each group those
//   with the hours first, then those whose qualifications meet the work, the team's default assignee, then by skill and free hours. Each with the state People's staffing answer
//   gives (Development.js staffingAnswer, check#Qualifications' projection: qualified, expiring, missing or expired, never a
//   certificate's number, issuer or file).
// - The qualification check (review Y8): assigning a person (schedule#MaintenanceWorkOrder, its bulk form) and starting the work
//   (transition#MaintenanceWorkOrder start, for its assignees) read the requirements of the work's open nodes at the planned start
//   (or now); a person missing or expired is a warning, which the organization's policy (MaintenancePolicy.qualificationBlocks)
//   turns into a refusal, QUALIFICATION_BLOCKED. A dispatcher holds no People reach (impl-people P18's finding), so the answer is
//   read through Development.js's staffingAnswer after Maintenance's own check, not check#Qualifications' People scope.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const work = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceWork.js")
const development = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Development.js")
const {find, one, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const PARTY = "mantle.work.effort.WorkEffortParty"
const SKILL_STANDARD = "mantle.work.effort.WorkEffortSkillStandard"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const DEFAULTS = "mantle.work.maintenance.MaintenanceTeamDefaults"
const ENUM = "moqui.basic.Enumeration"

const teamRole = "OrgTeam"
const assigneeRole = "Assignee"
const memberRelationships = ["PrtEmployee", "PrtAgent"]
const doneStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const candidateCap = 200
const candidateShown = 30
const hourMs = 3600000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => ms(ec.user.nowTimestamp)
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const ids = list => Array.from(new Set(list.filter(Boolean)))
const round = value => Math.round(value * 100) / 100
const partyNames = partyIds => lib.partyNames(partyIds)

function scopeWithAny(capabilities) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use maintenance dispatch")
    const userScope = maintenanceAccess.scope()
    if (!capabilities.some(name => userScope.capabilities[name]))
        denied("PERMISSION_DENIED", "Maintenance " + capabilities.join(" or ") + " is required")
    return userScope
}

// ===== teams and people =====
// The organization's people now: persons with a current employee or agent relationship to it.
function organizationPeople(organizationPartyId) {
    const partyIds = Array.from(
        find(RELATIONSHIP)
            .condition("toPartyId", organizationPartyId)
            .condition("relationshipTypeEnumId", "in", memberRelationships)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .selectField("fromPartyId")
            .list()
    ).map(row => row.fromPartyId)
    if (!partyIds.length) return []
    return Array.from(find("mantle.party.Person").condition("partyId", "in", ids(partyIds)).selectField("partyId").list()).map(
        row => row.partyId
    )
}
// A team's membership rows (People's PrtMember to the team as OrgTeam, F60): those in effect now and those starting later, or every
// row with includeEnded.
function membershipRows(teamPartyIds, includeEnded = false) {
    if (!teamPartyIds.length) return []
    let query = find(RELATIONSHIP)
        .condition("relationshipTypeEnumId", "PrtMember")
        .condition("toRoleTypeId", teamRole)
        .condition("toPartyId", "in", teamPartyIds)
        .orderBy("fromDate")
    if (!includeEnded)
        query = query.condition(
            ec.entity.conditionFactory.makeCondition(
                ec.entity.conditionFactory.makeCondition("thruDate", "is-null", null),
                "or",
                ec.entity.conditionFactory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
            )
        )
    return Array.from(query.list())
}
const currentAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// The people who are members of a team now.
function teamMemberIds(teamPartyId) {
    const at = nowMs()
    return teamPartyId
        ? ids(
              membershipRows([teamPartyId])
                  .filter(row => currentAt(row, at))
                  .map(row => row.fromPartyId)
          )
        : []
}
// A team's defaults in effect now, or null.
function defaultsOf(teamPartyId) {
    return teamPartyId
        ? Array.from(
              find(DEFAULTS, {teamPartyId})
                  .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                  .orderBy("-fromDate")
                  .limit(1)
                  .list()
          )[0] || null
        : null
}
// A team the caller's scope reaches: an OrgTeam party whose owner is one of the scope's organizations (RECORD_UNAVAILABLE
// otherwise, a missing team alike).
function requireTeam(userScope, teamPartyId) {
    const id = text(teamPartyId)
    const party = id ? one("mantle.party.Party", {partyId: id}) : null
    if (
        !party ||
        !one("mantle.party.PartyRole", {partyId: id, roleTypeId: teamRole}) ||
        !maintenanceAccess.covers(userScope, party.ownerPartyId)
    )
        denied("RECORD_UNAVAILABLE", "Team " + (id || "") + " is not available")
    return {teamPartyId: id, organizationPartyId: party.ownerPartyId}
}
// The teams of organizations (null: every one), by name.
function teamsOf(organizationPartyIds) {
    const teamIds = Array.from(find("mantle.party.PartyRole", {roleTypeId: teamRole}).selectField("partyId").list()).map(
        row => row.partyId
    )
    if (!teamIds.length) return []
    let query = find("mantle.party.PartyDetail").condition("partyId", "in", teamIds).orderBy("^organizationName")
    if (organizationPartyIds != null) {
        if (!organizationPartyIds.length) return []
        query = query.condition("ownerPartyId", "in", organizationPartyIds)
    }
    return Array.from(query.list())
}
function defaultsDisplay(row) {
    if (!row) return null
    const names = partyNames([row.defaultAssigneePartyId])
    return {
        fromDate: row.fromDate,
        fromDateText: dateText(row.fromDate),
        facilityId: row.facilityId || null,
        facilityName: row.facilityId
            ? one("mantle.facility.Facility", {facilityId: row.facilityId})?.facilityName || row.facilityId
            : "",
        defaultAssigneePartyId: row.defaultAssigneePartyId || null,
        defaultAssigneeName: row.defaultAssigneePartyId ? names[row.defaultAssigneePartyId] || row.defaultAssigneePartyId : "",
        intakeTag: row.intakeTag || null,
        projectWorkEffortId: row.projectWorkEffortId || null,
        projectName: row.projectWorkEffortId
            ? one(WORK, {workEffortId: row.projectWorkEffortId})?.workEffortName || row.projectWorkEffortId
            : "",
        comments: row.comments || null
    }
}

// find#MaintenanceTeams: the teams of the caller's organizations (organizationPartyId narrows them; teamPartyId reads one), each with
// its organization, lead and members (People's dated PrtMember rows: those in effect and starting later, every one with
// includeEnded) and the dispatch defaults in effect. Read by a maintenance reader, planner, supervisor or the settings editor;
// written by People (memberships) and store#MaintenanceTeamDefaults (the defaults).
function findTeams(p) {
    const userScope = scopeWithAny(["settingsEdit", "view", "plan", "supervise"])
    let organizations = userScope.organizationPartyIds
    if (text(p.organizationPartyId))
        organizations = [maintenanceAccess.requireOrganization(userScope, text(p.organizationPartyId))]
    let teams = teamsOf(organizations)
    if (text(p.teamPartyId)) {
        requireTeam(userScope, p.teamPartyId)
        teams = teams.filter(row => row.partyId === text(p.teamPartyId))
    }
    const teamIds = teams.map(row => row.partyId)
    const memberships = membershipRows(teamIds, p.includeEnded === true || p.includeEnded === "true")
    const names = partyNames(memberships.map(row => row.fromPartyId).concat(teams.map(row => row.ownerPartyId)))
    const at = nowMs()
    return {
        teamList: teams.map(team => {
            const rows = memberships.filter(row => row.toPartyId === team.partyId)
            const members = rows.map(row => ({
                partyId: row.fromPartyId,
                personName: names[row.fromPartyId] || row.fromPartyId,
                roleTypeId: row.fromRoleTypeId || assigneeRole,
                roleText: row.fromRoleTypeId === "Manager" ? "Lead" : "Member",
                fromDate: row.fromDate,
                thruDate: row.thruDate || null,
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                current: currentAt(row, at),
                stateText: currentAt(row, at) ? "Current" : (ms(row.fromDate) ?? 0) > at ? "Starts later" : "Ended"
            }))
            const current = members.filter(row => row.current)
            return {
                teamPartyId: team.partyId,
                teamName: team.organizationName || team.partyId,
                organizationPartyId: team.ownerPartyId,
                organizationName: names[team.ownerPartyId] || team.ownerPartyId,
                memberCount: ids(current.map(row => row.partyId)).length,
                leadName: current
                    .filter(row => row.roleTypeId === "Manager")
                    .map(row => row.personName)
                    .join(", "),
                members,
                defaults: defaultsDisplay(defaultsOf(team.partyId))
            }
        }),
        canEdit: !!userScope.capabilities.settingsEdit
    }
}

// store#MaintenanceTeamDefaults (MAINTENANCE_SETTINGS_EDIT): a team's dispatch defaults from now, the row in effect ending then
// (nothing is deleted): the resource scope (a facility of the team's organization), the default assignee (a current member of the
// team), the intake address's plus-tag (lower case letters, digits and hyphens, unique among the defaults in effect) and the
// project (an open project). Each field not given is kept from the row in effect; an empty one clears it. Refused: a team out of
// scope (RECORD_UNAVAILABLE), a facility of another organization (FACILITY_INVALID), an assignee who is not a member
// (ASSIGNEE_INVALID), a tag that is not one or taken (TAG_INVALID, TAG_TAKEN), a project that is not one (PROJECT_INVALID).
const tagPattern = /^[a-z0-9][a-z0-9-]{0,39}$/
function storeTeamDefaults(p) {
    const userScope = scopeWithAny(["settingsEdit"])
    const team = requireTeam(userScope, p.teamPartyId)
    const current = defaultsOf(team.teamPartyId)
    const given = name => Object.hasOwn(p, name) && p[name] !== undefined
    const value = name => (given(name) ? text(p[name]) : current?.[name] || null)
    const facilityId = value("facilityId")
    if (facilityId && maintenanceAccess.facilityOrganization(facilityId) !== team.organizationPartyId)
        denied("FACILITY_INVALID", "Facility " + facilityId + " is not one of the team's organization")
    const defaultAssigneePartyId = value("defaultAssigneePartyId")
    if (
        given("defaultAssigneePartyId") &&
        defaultAssigneePartyId &&
        !teamMemberIds(team.teamPartyId).includes(defaultAssigneePartyId)
    )
        denied("ASSIGNEE_INVALID", "The default assignee is a current member of the team")
    const intakeTag = value("intakeTag") ? value("intakeTag").toLowerCase() : null
    if (intakeTag) {
        if (!tagPattern.test(intakeTag))
            denied("TAG_INVALID", "An intake tag is lower case letters, digits and hyphens, up to 40")
        const taken = Array.from(
            find(DEFAULTS, {intakeTag}).conditionDate("fromDate", "thruDate", ec.user.nowTimestamp).list()
        ).some(row => row.teamPartyId !== team.teamPartyId)
        if (taken) denied("TAG_TAKEN", "Another team's intake address uses " + intakeTag)
    }
    const projectWorkEffortId = value("projectWorkEffortId")
    if (projectWorkEffortId) {
        const project = one(WORK, {workEffortId: projectWorkEffortId})
        if (!project || project.workEffortTypeEnumId !== "WetProject" || project.isTemplate === "Y")
            denied("PROJECT_INVALID", "Project " + projectWorkEffortId + " is not a project")
    }
    const now = ec.user.nowTimestamp
    for (const row of Array.from(
        find(DEFAULTS, {teamPartyId: team.teamPartyId}).conditionDate("fromDate", "thruDate", now).list()
    ))
        call("update#" + DEFAULTS, {teamPartyId: team.teamPartyId, fromDate: row.fromDate, thruDate: now})
    call("create#" + DEFAULTS, {
        teamPartyId: team.teamPartyId,
        fromDate: now,
        organizationPartyId: team.organizationPartyId,
        facilityId,
        defaultAssigneePartyId,
        intakeTag,
        projectWorkEffortId,
        changedByUserId: ec.user.userId,
        comments: given("comments") ? text(p.comments) : null
    })
    return {teamPartyId: team.teamPartyId, fromDate: now}
}

// ===== the work's requirements and the qualification check =====
// The requirements of a work order's open nodes (the root and its steps not done): each skill (with the qualification that proves
// it) once, at the highest least level any node asks.
function requirementsOf(rootId) {
    const nodeIds = [rootId].concat(
        Array.from(
            find(WORK, {rootWorkEffortId: rootId})
                .condition("statusId", "not-in", doneStatuses)
                .selectField("workEffortId")
                .list()
        ).map(row => row.workEffortId)
    )
    const merged = new Map()
    for (const row of Array.from(find(SKILL_STANDARD).condition("workEffortId", "in", ids(nodeIds)).list())) {
        const key = row.skillTypeEnumId + "/" + (row.qualificationTypeEnumId || "")
        const level = row.minimumSkillLevel == null ? null : Number(row.minimumSkillLevel)
        const found = merged.get(key)
        if (!found)
            merged.set(key, {
                skillTypeEnumId: row.skillTypeEnumId,
                minimumLevel: level,
                qualificationTypeEnumId: row.qualificationTypeEnumId || null,
                required: true
            })
        else if (level != null && (found.minimumLevel == null || level > found.minimumLevel)) found.minimumLevel = level
    }
    return Array.from(merged.values())
}
const warns = state => state === "missing" || state === "expired"
// The staffing answer for people against the work's requirements at a time: {partyId: {state, stateText, explanation}} ({} with
// no requirement: nothing to meet).
function qualificationsOf(partyIds, requirements, at) {
    if (!requirements.length || !partyIds.length) return {}
    const found = {}
    for (const row of development().staffingAnswer(partyIds, requirements, at)) {
        const short = Array.from(row.requirements || [])
            .filter(one => one.state !== "qualified")
            .map(
                one =>
                    [
                        one.skillName || one.qualificationTypeName,
                        one.qualificationTypeName && one.skillName ? one.qualificationTypeName : null
                    ]
                        .filter(Boolean)
                        .join(" proved by ") +
                    ": " +
                    (one.explanation || one.stateText)
            )
        found[row.partyId] = {
            state: row.state,
            stateText: row.stateText,
            personName: row.personName || row.partyId,
            explanation: short.join("; ")
        }
    }
    return found
}
// The check of assigning people to work or starting it (review Y8): the warnings for the people who are missing or expired on the
// work's requirements at the time, refused (QUALIFICATION_BLOCKED) when the organization's policy blocks.
function checkQualified(organizationPartyId, rootId, partyIds, at) {
    const people = ids(Array.from(partyIds || []))
    if (!people.length) return []
    const requirements = requirementsOf(rootId)
    if (!requirements.length) return []
    const answer = qualificationsOf(people, requirements, at ?? ec.user.nowTimestamp)
    const warnings = people
        .filter(partyId => answer[partyId] && warns(answer[partyId].state))
        .map(partyId => Object.assign({partyId}, answer[partyId]))
    if (warnings.length && work().policyOf(organizationPartyId).qualificationBlocks)
        denied(
            "QUALIFICATION_BLOCKED",
            "The work needs qualifications they lack: " +
                warnings.map(row => row.personName + " (" + row.explanation + ")").join(", ")
        )
    return warnings
}
// Start's recheck: the root's current assignees at now.
function assigneesOf(rootId) {
    return ids(
        Array.from(
            find(PARTY, {workEffortId: rootId, roleTypeId: assigneeRole})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .condition(
                    ec.entity.conditionFactory.makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true)
                )
                .list()
        ).map(row => row.partyId)
    )
}
function checkStart(organizationPartyId, rootId) {
    return checkQualified(organizationPartyId, rootId, assigneesOf(rootId), ec.user.nowTimestamp)
}
// The text of a set of warnings, for a result's message.
const warningText = warnings =>
    warnings.length
        ? "Qualification warning: " + warnings.map(row => row.personName + " (" + row.explanation + ")").join(", ")
        : ""

// ===== find#MaintenanceCandidates =====
// The technicians a planner or supervisor may assign to a work order, ranked (see the header): the window is windowFrom and
// windowThru, else the work's planned start and due, else from now for its estimated hours; the hours are the work's estimate
// (its steps' sum), else the window's length; the team is teamPartyId, else the work's. Each candidate: partyId, name, onTeam,
// isDefault (the team's default assignee), assigned, fits, freeHours, needHours, skills [{skillName, level, meets}],
// qualificationState and qualificationText (empty with no requirement), warns, and a one-line label.
function findCandidates(p) {
    const userScope = scopeWithAny(["plan", "supervise"])
    const workEffortId = text(p.workEffortId)
    if (!workEffortId) denied("RECORD_UNAVAILABLE", "Work order is not available")
    const found = maintenanceAccess.requireWork(userScope, workEffortId)
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (found.rootWorkEffortId !== workEffortId || !one(ORDER, {workEffortId}) || root.isTemplate === "Y")
        denied("RECORD_UNAVAILABLE", "Work order " + workEffortId + " is not available")
    const organizationPartyId = found.organizationPartyId
    const estimate = work().treeHours(workEffortId)
    let fromMs = ms(blank(p.windowFrom) ? root.estimatedStartDate : p.windowFrom)
    let thruMs = ms(blank(p.windowThru) ? root.estimatedCompletionDate : p.windowThru)
    if (fromMs == null) fromMs = thruMs != null ? thruMs - Math.max(1, estimate || 1) * hourMs : nowMs()
    if (thruMs == null || thruMs <= fromMs) thruMs = fromMs + Math.max(1, estimate || 1) * hourMs
    const hours = estimate != null && estimate > 0 ? estimate : (thruMs - fromMs) / hourMs
    const teamPartyId =
        p.teamPartyId != null
            ? text(p.teamPartyId)
            : Array.from(
                  find(PARTY, {workEffortId, roleTypeId: teamRole})
                      .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                      .list()
              )[0]?.partyId || null
    const members = new Set(teamMemberIds(teamPartyId))
    const defaults = defaultsOf(teamPartyId)
    const assigned = new Set(assigneesOf(workEffortId))
    const people = organizationPeople(organizationPartyId).slice(0, candidateCap)
    const requirements = requirementsOf(workEffortId)
    const skillAsks = []
    for (const row of requirements)
        if (!skillAsks.some(one => one.skillTypeEnumId === row.skillTypeEnumId))
            skillAsks.push({skillTypeEnumId: row.skillTypeEnumId, minimumLevel: row.minimumLevel})
    const staffing = people.length
        ? lib.probe("mantle.work.ResourceServices.find#StaffingCandidates", {
              partyIdList: people,
              skillList: skillAsks,
              windowFrom: new Date(fromMs),
              windowThru: new Date(thruMs),
              windowHours: round(hours),
              limit: candidateCap
          }).candidateList || []
        : []
    const candidateIds = Array.from(staffing).map(row => row.partyId)
    const qualifications = qualificationsOf(candidateIds, requirements, new Date(fromMs))
    const blocks = !!work().policyOf(organizationPartyId).qualificationBlocks
    const skillNames = Object.fromEntries(skillAsks.map(ask => [ask.skillTypeEnumId, enumText(ask.skillTypeEnumId)]))
    const candidates = Array.from(staffing).map((row, index) => {
        const qualification = qualifications[row.partyId] || null
        const skills = Array.from(row.skills || []).map(one => ({
            skillTypeEnumId: one.skillTypeEnumId,
            skillName: skillNames[one.skillTypeEnumId] || one.skillTypeEnumId,
            level: one.level,
            meets: !!one.meets,
            selfDeclared: !!one.selfDeclared
        }))
        const freeText = round(Number(row.freeHours) || 0) + " h free"
        const warning = !!qualification && warns(qualification.state)
        return {
            partyId: row.partyId,
            name: row.name,
            onTeam: members.has(row.partyId),
            isDefault: !!defaults && defaults.defaultAssigneePartyId === row.partyId,
            assigned: assigned.has(row.partyId),
            fits: !!row.fits,
            freeHours: Number(row.freeHours) || 0,
            needHours: Number(row.needHours) || 0,
            skills,
            qualificationState: qualification?.state || null,
            qualificationText: qualification
                ? qualification.stateText + (qualification.explanation ? ": " + qualification.explanation : "")
                : "",
            warns: warning,
            blocked: warning && blocks,
            order: index,
            label: [
                row.name,
                freeText + (row.fits ? "" : " (needs " + round(Number(row.needHours) || 0) + ")"),
                skills
                    .map(
                        one =>
                            one.skillName +
                            " " +
                            (one.level == null ? "none" : one.level + (one.selfDeclared ? " self-declared" : ""))
                    )
                    .join(", "),
                qualification ? qualification.stateText : "",
                members.has(row.partyId) ? "team" : ""
            ]
                .filter(Boolean)
                .join(" · ")
        }
    })
    const okRank = row => (row.warns ? 0 : 1)
    // the team's members first (the work's team, or the one being chosen), each group ranked alike
    candidates.sort(
        (a, b) =>
            Number(b.onTeam) - Number(a.onTeam) ||
            Number(b.fits) - Number(a.fits) ||
            okRank(b) - okRank(a) ||
            Number(b.isDefault) - Number(a.isDefault) ||
            a.order - b.order
    )
    return {
        candidateList: candidates
            .slice(0, Math.max(1, Number(p.limit) || candidateShown))
            .map((row, index) => Object.assign(row, {rank: index + 1})),
        requirementList: requirements.map(row => ({
            skillTypeEnumId: row.skillTypeEnumId,
            skillName: enumText(row.skillTypeEnumId),
            minimumLevel: row.minimumLevel,
            qualificationTypeEnumId: row.qualificationTypeEnumId,
            qualificationTypeName: enumText(row.qualificationTypeEnumId)
        })),
        windowFrom: new Date(fromMs),
        windowThru: new Date(thruMs),
        windowText: dateText(new Date(fromMs)) + " to " + dateText(new Date(thruMs)),
        hours: round(hours),
        teamPartyId,
        qualificationBlocks: blocks
    }
}

const operations = {findTeams, storeTeamDefaults, findCandidates}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance dispatch operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js's schedule, bulk and Start only, never a service's parameters
    checkQualified,
    checkStart,
    warningText
})
