// People's training (mantle.humanres.DevelopmentServices find#Training, get#Training, store#TrainingClass, store#Training,
// enroll#Training, decide#Enrollment with its notice handlers, mark#TrainingAttendance, complete#Training and
// get#TrainingCertificate; IronStone People design §10 Training and TrainingDetail, §15 the completion certificate, PE-14, PE-15;
// impl-people P19). Every read is a projection of the caller's People scope (People.js scopeOf), read with authorization off
// after that check.
//
// The records (HumanResourcesEntities.xml; refined from the commented sketches, F6):
// - a course (TrainingClass) is an employer's: what passing it grants (a qualification type, valid for a number of months; never
//   an identity document or work permit) and whether its completion needs an assessment;
// - a session (TrainingSession) is a WepTraining event of Commons' calendar (EventServices.create#Event: a private event whose
//   attendees are its trainer and the people enrolled, each reminded a day before), with its course, trainer, seats and the
//   assessment form its results answer (a published form of the training assessment purpose, People's Forms, P16); its place is a
//   meeting room booked through Maintenance's resource booking (EventRooms.js, People follow-up 3: the room's policy, clashes and
//   blackouts apply; moved and cancelled with the session) or, off site, a free-text place;
// - an enrollment (PersonTraining) is a person's place in a session: asked for by the person, it waits for a People approval of
//   kind PakTraining (PeopleTrainingApproval; the manager by default, never the person or who asked); made by a development
//   editor of the employer, it is enrolled at once. Its attendance is the trainer's record;
// - an assessment (PersonTrainingResult) is kept, passed or failed; the form's answers are a FormResponse locked by its
//   FormInvitation (naming the person, the assessor and the enrollment, with no link). The passing one completes the enrollment
//   once: it grants the course's qualification once (verified, the assessor its verifier) and issues the completion certificate,
//   stored when issued (its PDF and the page html-print shows), never rendered again. A completion retried answers the first.
//
// Who reads and does what of a session:
// - a development reader (PEOPLE_DEVELOP_VIEW) of its employer reads it all; a development editor (PEOPLE_DEVELOP_EDIT) schedules,
//   changes and cancels it, enrolls people, records their attendance and assesses them;
// - its trainer, while they work for its employer, reads its enrollments and its assessments alone (no other session's), records
//   the attendance and assesses;
// - a self-service employee (PEOPLE_SELF_SERVICE) of its employer reads its time, place, seats and their own enrollment, asks for a
//   place and withdraws their own; the person reads their own result (outcome, score, date, assessor), never the assessor's answers
//   or evidence, and their own certificate;
// - an approver of a place waiting reads that enrollment and the session.
// No one assesses or marks the attendance of their own enrollment (SELF_APPROVAL). Missing and unauthorized records are refused
// alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const development = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Development.js")
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
// the session's room and equipment bookings kept right when it moves or is cancelled (impl-maintenance F356)
const bookings = () => ec.resource.script("component://mr-mantle/service/mantle/work/ResourceBookingDecisions.js")
const rooms = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/EventRooms.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const COURSE = "mantle.humanres.ability.TrainingClass"
const SESSION = "mantle.humanres.ability.TrainingSession"
const ENROLLMENT = "mantle.humanres.ability.PersonTraining"
const RESULT = "mantle.humanres.ability.PersonTrainingResult"
const QUALIFICATION = "mantle.humanres.ability.PartyQualification"
const WORK = "mantle.work.effort.WorkEffort"
const WORK_PARTY = "mantle.work.effort.WorkEffortParty"
const REMINDER = "mantle.work.effort.WorkEffortReminder"
const INVITATION = "mantle.party.FormInvitation"
const ASSIGNMENT = "mantle.humanres.employment.EmploymentAssignment"
const ENUM = "moqui.basic.Enumeration"
const ASSESSMENT_PURPOSE = "DbfpTrainingAssessment"
const approvalKind = "PakTraining"
const REQUESTED = "PtsRequested",
    ENROLLED = "PtsEnrolled",
    COMPLETED = "PtsCompleted",
    REFUSED = "PtsRefused",
    WITHDRAWN = "PtsWithdrawn",
    CANCELLED = "PtsCancelled"
const statusTexts = {
    [REQUESTED]: "Waiting for approval",
    [ENROLLED]: "Enrolled",
    [COMPLETED]: "Completed",
    [REFUSED]: "Refused",
    [WITHDRAWN]: "Withdrawn",
    [CANCELLED]: "Session cancelled"
}
// the enrollments that hold a seat
const seated = [REQUESTED, ENROLLED, COMPLETED]
const PASSED = "TrrPassed",
    FAILED = "TrrFailed"
const resultTexts = {[PASSED]: "Passed", [FAILED]: "Failed"}
const day = 24 * 60 * 60 * 1000
// a session starting within this many days is due (Today's training due)
const dueDays = 7
// the most sessions a list reads, and the reminder a person enrolled gets before a session (a day)
const sessionCap = 2000
const reminderMinutes = 1440

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const given = value => value != null
const flag = value => value === true || value === "true" || value === "Y"
const unique = people.unique
const stampOf = row => String(ms(row?.lastUpdatedStamp) ?? 0)
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
function timeText(value) {
    if (value == null) return ""
    return ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd HH:mm")
}
function enumNames(enumIds) {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(ENUM).condition("enumId", "in", ids).list()).map(row => [row.enumId, row.description || row.enumId])
    )
}
const isCurrent = row => !!row && (ms(row.thruDate) ?? Infinity) > nowMs()

// ===== scope and access =====
// The caller's People scope with the employers whose training they administer (a development reader's) and those they work for
// (a self-service employee's current employments).
function trainingScope() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    userScope.developEmployers = caps.developView ? userScope.organizationPartyIds.slice() : []
    userScope.ownEmployers = caps.self ? unique((userScope.employments || []).map(row => row.organizationPartyId)) : []
    // P19 review: the employers the caller works for now (an employee or agent), where they train a session they are the trainer of
    userScope.workEmployers = userScope.partyId
        ? unique(
              Array.from(
                  people
                      .current(
                          find("mantle.party.PartyRelationship")
                              .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                              .condition("fromPartyId", userScope.partyId),
                          nowMs()
                      )
                      .list()
              ).map(row => row.toPartyId)
          )
        : []
    return userScope
}
// the session's trainer, while they work for its employer
const trainsIt = (userScope, session) =>
    !!userScope.partyId &&
    session.trainerPartyId === userScope.partyId &&
    userScope.workEmployers.includes(session.organizationPartyId)
// How the caller reads a session: a development reader of its employer (developEdit with PEOPLE_DEVELOP_EDIT), its trainer, a
// self-service employee of its employer (eligible), the person of an enrollment in it (own); assesses: who records attendance and
// results (a development editor of its employer or its trainer).
function sessionAccess(userScope, session) {
    const develop = userScope.developEmployers.includes(session.organizationPartyId)
    const developEdit = develop && !!userScope.capabilities.developEdit
    const trainer = trainsIt(userScope, session)
    const eligible = userScope.ownEmployers.includes(session.organizationPartyId)
    const own = userScope.partyId ? rows(ENROLLMENT, {workEffortId: session.workEffortId, partyId: userScope.partyId}) : []
    return {
        develop,
        developEdit,
        trainer,
        eligible,
        own,
        reads: develop || trainer || eligible || own.length > 0,
        assesses: developEdit || trainer
    }
}
// whether the caller decided, or may decide now, a step of an enrollment's approval
function approverOf(userScope, enrollment) {
    if (!userScope.partyId) return false
    if (enrollment.statusEnumId === REQUESTED && approvals().sourceSummary(approvalKind, enrollment.personTrainingId)?.canDecide)
        return true
    return rows("mantle.humanres.approval.PeopleApproval", {
        sourceEntityName: ENROLLMENT,
        sourceId: enrollment.personTrainingId
    }).some(approval =>
        rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId}).some(
            row => row.decidedByPartyId === userScope.partyId
        )
    )
}
function sessionOf(workEffortId) {
    const session = text(workEffortId) ? one(SESSION, {workEffortId: text(workEffortId)}) : null
    return session
        ? {session, event: one(WORK, {workEffortId: session.workEffortId}), course: courseOf(session.trainingClassId)}
        : null
}
const courseOf = trainingClassId => (trainingClassId ? one(COURSE, {trainingClassId}) : null)
function readableSession(userScope, workEffortId) {
    const found = sessionOf(workEffortId)
    const access = found ? sessionAccess(userScope, found.session) : {reads: false}
    if (!found || !access.reads) denied("RECORD_UNAVAILABLE", "Training session " + text(workEffortId) + " is not available")
    return Object.assign(found, {access})
}
// An enrollment the caller reads, with its session and their access: the session's readers (the person their own only, the
// trainer and development every one) and an approver of it.
function readableEnrollment(userScope, personTrainingId) {
    const enrollment = text(personTrainingId) ? one(ENROLLMENT, {personTrainingId: text(personTrainingId)}) : null
    const found = enrollment ? sessionOf(enrollment.workEffortId) : null
    const access = found ? sessionAccess(userScope, found.session) : {reads: false}
    const self = !!enrollment && !!userScope.partyId && enrollment.partyId === userScope.partyId
    const approver = !!enrollment && !access.develop && !access.trainer && !self && approverOf(userScope, enrollment)
    if (!enrollment || !found || !(access.develop || access.trainer || self || approver))
        denied("RECORD_UNAVAILABLE", "Training enrollment " + text(personTrainingId) + " is not available")
    return Object.assign(found, {enrollment, access, self, approver})
}

// ===== sessions as lines =====
const qualificationText = (course, names) =>
    course?.qualificationTypeEnumId
        ? (names[course.qualificationTypeEnumId] || course.qualificationTypeEnumId) +
          (course.validityMonths ? ", valid " + course.validityMonths + " months" : "")
        : ""
function stateOf(event, at) {
    if (!event || event.statusId === "WeCancelled") return {state: "cancelled", stateText: "Cancelled"}
    const startMs = ms(event.estimatedStartDate)
    const endMs = ms(event.estimatedCompletionDate) ?? startMs
    if (startMs != null && startMs > at) return {state: "scheduled", stateText: "Scheduled"}
    if (endMs != null && endMs > at) return {state: "running", stateText: "In progress"}
    return {state: "ended", stateText: "Ended"}
}
// The sessions as the caller's list shows them: course, employer, time, place, trainer, seats, what passing grants, the state, the
// caller's own enrollment and what they may do.
function sessionLines(userScope, sessions) {
    if (!sessions.length) return []
    const at = nowMs()
    const ids = sessions.map(row => row.workEffortId)
    const events = new Map(Array.from(find(WORK).condition("workEffortId", "in", ids).list()).map(row => [row.workEffortId, row]))
    const courses = new Map(
        Array.from(
            find(COURSE)
                .condition("trainingClassId", "in", unique(sessions.map(row => row.trainingClassId)))
                .list()
        ).map(row => [row.trainingClassId, row])
    )
    const enrollments = Array.from(find(ENROLLMENT).condition("workEffortId", "in", ids).list())
    const names = enumNames(
        Array.from(courses.values()).flatMap(row => [row.qualificationTypeEnumId, row.trainingClassTypeEnumId])
    )
    const trainerNames = people.personNames(unique(sessions.map(row => row.trainerPartyId).filter(Boolean)))
    const organizationNames = people.organizationNames(unique(sessions.map(row => row.organizationPartyId)))
    const roomOf = rooms().roomsOf(ids)
    return sessions.map(session => {
        const event = events.get(session.workEffortId)
        const course = courses.get(session.trainingClassId)
        const ofSession = enrollments.filter(row => row.workEffortId === session.workEffortId)
        const enrolledCount = ofSession.filter(row => [ENROLLED, COMPLETED].includes(row.statusEnumId)).length
        const waitingCount = ofSession.filter(row => row.statusEnumId === REQUESTED).length
        const capacity = Number(session.capacity || 0)
        const seatsLeft = Math.max(0, capacity - enrolledCount - waitingCount)
        const mine = userScope.partyId ? ofSession.filter(row => row.partyId === userScope.partyId) : []
        const open = mine.find(row => seated.includes(row.statusEnumId)) || null
        const latest = open || mine.sort((a, b) => (ms(b.requestedDate) ?? 0) - (ms(a.requestedDate) ?? 0))[0] || null
        const access = {
            develop: userScope.developEmployers.includes(session.organizationPartyId),
            trainer: trainsIt(userScope, session),
            eligible: userScope.ownEmployers.includes(session.organizationPartyId)
        }
        const {state, stateText} = stateOf(event, at)
        const startMs = ms(event?.estimatedStartDate)
        const endMs = ms(event?.estimatedCompletionDate)
        return {
            workEffortId: session.workEffortId,
            trainingClassId: session.trainingClassId,
            title: course?.title || session.trainingClassId,
            typeText: course?.trainingClassTypeEnumId ? names[course.trainingClassTypeEnumId] || "" : "",
            organizationPartyId: session.organizationPartyId,
            organizationName: organizationNames[session.organizationPartyId] || session.organizationPartyId,
            startDate: startMs,
            startText: timeText(startMs),
            endText: timeText(endMs),
            whenText:
                timeText(startMs) +
                (endMs != null
                    ? " – " +
                      (timeText(endMs).slice(0, 10) === timeText(startMs).slice(0, 10)
                          ? timeText(endMs).slice(11)
                          : timeText(endMs))
                    : ""),
            location: event?.location || "",
            facilityId: roomOf[session.workEffortId]?.facilityId || null,
            roomName: roomOf[session.workEffortId]?.roomName || "",
            roomStatus: roomOf[session.workEffortId]?.roomStatus || null,
            roomStatusText: roomOf[session.workEffortId]?.roomStatusText || "",
            trainerPartyId: session.trainerPartyId,
            trainerName: trainerNames[session.trainerPartyId] || session.trainerPartyId || "",
            capacity,
            enrolledCount,
            waitingCount,
            seatsLeft,
            seatsText: enrolledCount + waitingCount + " of " + capacity + " taken",
            qualificationTypeEnumId: course?.qualificationTypeEnumId || null,
            qualificationText: qualificationText(course, names),
            state,
            stateText,
            cancelled: state === "cancelled",
            myPersonTrainingId: latest?.personTrainingId || null,
            myStatusEnumId: latest?.statusEnumId || null,
            myStatusText: latest ? statusTexts[latest.statusEnumId] || latest.statusEnumId : "",
            isTrainer: access.trainer,
            canRequest:
                access.eligible &&
                !!userScope.capabilities.self &&
                state === "scheduled" &&
                !open &&
                !access.trainer &&
                seatsLeft > 0,
            canManage: access.develop && !!userScope.capabilities.developEdit,
            revision: stampOf(session) + ":" + stampOf(event)
        }
    })
}

// ===== find#Training =====
// The sessions the caller reads: a development reader's employers' (organizationPartyId narrows them), a self-service employee's
// employers', the ones they train and the ones they are enrolled in. show: upcoming (the default: not cancelled, not ended),
// past (ended or cancelled), mine (their own enrollments), training (as the trainer), due (their own enrolled sessions and those
// they train starting within seven days, not ended), all; trainingClassId and term (the course's title) narrow them. Paged; with
// the employers' courses for a development editor (who schedules). Refused: an employer outside the scope (ORGANIZATION_DENIED),
// a show that is not one (SHOW_INVALID).
function findTraining(p) {
    const userScope = trainingScope()
    const caps = userScope.capabilities
    const at = nowMs()
    const show = text(p.show) || "upcoming"
    if (!["upcoming", "past", "mine", "training", "due", "all"].includes(show))
        denied("SHOW_INVALID", "Show one of upcoming, past, mine, training, due or all")
    const reachOrgs = unique(userScope.developEmployers.concat(userScope.ownEmployers))
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId && !reachOrgs.includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    const myEnrollments = userScope.partyId ? rows(ENROLLMENT, {partyId: userScope.partyId}) : []
    const mySessions = unique(myEnrollments.map(row => row.workEffortId))
    const factory = ec.entity.conditionFactory
    const reach = []
    if (show !== "mine" && show !== "training" && show !== "due" && reachOrgs.length)
        reach.push(factory.makeCondition("organizationPartyId", "in", organizationPartyId ? [organizationPartyId] : reachOrgs))
    if (userScope.partyId && show !== "mine" && userScope.workEmployers.length)
        reach.push(
            factory.makeCondition(
                factory.makeCondition("trainerPartyId", "equals", userScope.partyId),
                "and",
                factory.makeCondition("organizationPartyId", "in", userScope.workEmployers)
            )
        )
    const ownSessions =
        show === "due"
            ? unique(myEnrollments.filter(row => row.statusEnumId === ENROLLED).map(row => row.workEffortId))
            : mySessions
    if (show !== "training" && ownSessions.length) reach.push(factory.makeCondition("workEffortId", "in", ownSessions))
    const canSchedule = !!caps.developEdit && userScope.developEmployers.length > 0
    const empty = Object.assign(lib.pageList([], p, "sessions"), {canSchedule, classes: canSchedule ? coursesOf(userScope) : []})
    if (!reach.length) return empty
    let query = find(SESSION).condition(factory.makeCondition(reach, "or"))
    if (organizationPartyId) query = query.condition("organizationPartyId", organizationPartyId)
    if (text(p.trainingClassId)) query = query.condition("trainingClassId", text(p.trainingClassId))
    if (text(p.term)) {
        const courseIds = Array.from(
            find(COURSE)
                .condition(factory.makeCondition("title", "like", likeText(text(p.term))).ignoreCase())
                .selectField("trainingClassId")
                .list()
        ).map(row => row.trainingClassId)
        if (!courseIds.length) return empty
        query = query.condition("trainingClassId", "in", courseIds)
    }
    const sessions = Array.from(query.limit(sessionCap).list())
    if (!sessions.length) return empty
    // the sessions' times are their events': the date conditions and the order in the event query
    let events = find(WORK)
        .condition(
            "workEffortId",
            "in",
            sessions.map(row => row.workEffortId)
        )
        .selectField(["workEffortId", "estimatedStartDate", "estimatedCompletionDate", "statusId"])
    const now = stamp(at)
    if (show === "upcoming" || show === "due")
        events = events.condition("statusId", "not-equals", "WeCancelled").condition("estimatedCompletionDate", "greater", now)
    if (show === "due") events = events.condition("estimatedStartDate", "less-equals", stamp(at + dueDays * day))
    if (show === "past")
        events = events.condition(
            factory.makeCondition(
                factory.makeCondition("statusId", "equals", "WeCancelled"),
                "or",
                factory.makeCondition("estimatedCompletionDate", "less-equals", now)
            )
        )
    const order = Array.from(events.orderBy(show === "past" ? "-estimatedStartDate" : "estimatedStartDate").list()).map(
        row => row.workEffortId
    )
    const byId = new Map(sessions.map(row => [row.workEffortId, row]))
    const lines = sessionLines(
        userScope,
        order.map(id => byId.get(id))
    )
    return Object.assign(lib.pageList(lines, p, "sessions"), {canSchedule, classes: canSchedule ? coursesOf(userScope) : []})
}
// The courses of the employers a development editor administers, not ended, by title.
function coursesOf(userScope) {
    if (!userScope.developEmployers.length) return []
    const factory = ec.entity.conditionFactory
    const found = Array.from(
        find(COURSE)
            .condition("organizationPartyId", "in", userScope.developEmployers)
            .condition(
                factory.makeCondition(
                    factory.makeCondition("thruDate", "is-null", null),
                    "or",
                    factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
                )
            )
            .orderBy("title")
            .limit(200)
            .list()
    )
    const names = enumNames(found.flatMap(row => [row.qualificationTypeEnumId, row.trainingClassTypeEnumId]))
    const organizationNames = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    return found.map(row => ({
        trainingClassId: row.trainingClassId,
        title: row.title || row.trainingClassId,
        organizationPartyId: row.organizationPartyId,
        organizationName: organizationNames[row.organizationPartyId] || row.organizationPartyId,
        trainingClassTypeEnumId: row.trainingClassTypeEnumId || null,
        typeText: row.trainingClassTypeEnumId ? names[row.trainingClassTypeEnumId] || "" : "",
        description: row.description || "",
        qualificationTypeEnumId: row.qualificationTypeEnumId || null,
        validityMonths: row.validityMonths ?? null,
        qualificationText: qualificationText(row, names),
        assessmentRequired: row.assessmentRequired === "Y",
        assessmentFormId: row.assessmentFormId || null,
        revision: stampOf(row)
    }))
}

// ===== get#Training =====
// A session (workEffortId, or the session of personTrainingId) as the caller reads it: its line, description and assessment form,
// what they may do, the enrollments they read (development and the trainer every one, an approver the one they decide, the person
// their own) and the results (development and the trainer every one with the assessor's answers and evidence, the person their own
// outcome, score, date and assessor).
function getTraining(p) {
    const userScope = trainingScope()
    let found
    let approverOnly = null
    if (!text(p.workEffortId) && text(p.personTrainingId)) {
        const enrollment = readableEnrollment(userScope, p.personTrainingId)
        found = enrollment
        if (enrollment.approver) approverOnly = enrollment.enrollment.personTrainingId
    } else found = readableSession(userScope, p.workEffortId)
    const {session, event, course, access} = found
    const at = nowMs()
    const line = sessionLines(userScope, [session])[0]
    const all = access.develop || access.trainer
    let enrollments = rows(ENROLLMENT, {workEffortId: session.workEffortId})
    if (!all) enrollments = enrollments.filter(row => row.partyId === userScope.partyId || row.personTrainingId === approverOnly)
    const results = enrollments.length
        ? Array.from(
              find(RESULT)
                  .condition(
                      "personTrainingId",
                      "in",
                      enrollments.map(row => row.personTrainingId)
                  )
                  .list()
          )
        : []
    const personNames = people.personNames(
        unique(
            enrollments
                .map(row => row.partyId)
                .concat(results.map(row => row.assessorPartyId))
                .filter(Boolean)
        )
    )
    const started = line.state !== "scheduled" && line.state !== "cancelled"
    const qualifications = new Map(
        enrollments.filter(row => row.partyQualificationId).length
            ? Array.from(
                  find(QUALIFICATION)
                      .condition("partyQualificationId", "in", enrollments.map(row => row.partyQualificationId).filter(Boolean))
                      .list()
              ).map(row => [row.partyQualificationId, row])
            : []
    )
    const enrollmentRows = enrollments
        .map(row => {
            const own = row.partyId === userScope.partyId
            const ofIt = results
                .filter(result => result.personTrainingId === row.personTrainingId)
                .sort((a, b) => (ms(a.assessedDate) ?? 0) - (ms(b.assessedDate) ?? 0))
            const last = ofIt[ofIt.length - 1] || null
            const summary = row.statusEnumId === REQUESTED ? approvals().sourceSummary(approvalKind, row.personTrainingId) : null
            const granted = row.partyQualificationId ? qualifications.get(row.partyQualificationId) : null
            const open = [REQUESTED, ENROLLED].includes(row.statusEnumId)
            return {
                personTrainingId: row.personTrainingId,
                partyId: row.partyId,
                personName: personNames[row.partyId] || row.partyId,
                statusEnumId: row.statusEnumId,
                statusText: statusTexts[row.statusEnumId] || row.statusEnumId,
                requestedDateText: dateText(row.requestedDate),
                // why a place was asked for, and why it was refused: development's, the person's and the approver's (P19 review:
                // not the trainer's)
                reason: access.develop || own || row.personTrainingId === approverOnly ? row.reason || "" : "",
                decisionReason: access.develop || own || row.personTrainingId === approverOnly ? row.decisionReason || "" : "",
                waitingText: summary?.waitingText || "",
                peopleApprovalId: summary?.waiting ? summary.peopleApprovalId : null,
                sourceRevision: summary?.waiting ? summary.sourceRevision : null,
                canDecide: !!summary?.canDecide,
                attendedFlag: row.attendedFlag || null,
                attendanceText: row.attendedFlag === "Y" ? "Attended" : row.attendedFlag === "N" ? "Absent" : "",
                attendedHours: row.attendedHours != null ? Number(String(row.attendedHours)) : null,
                attemptCount: ofIt.length,
                resultText: last ? resultTexts[last.resultEnumId] || last.resultEnumId : "",
                completedDateText: dateText(row.completedDate),
                qualificationText: granted
                    ? "Granted" + (granted.thruDate ? ", valid until " + dateText(granted.thruDate) : "")
                    : "",
                hasCertificate: !!row.certificateHtmlLocation && (own || access.develop),
                canWithdraw:
                    open && (own || row.requestedByUserId === ec.user.userId || access.developEdit) && line.state !== "ended",
                canMarkAttendance: access.assesses && !own && row.statusEnumId === ENROLLED && started,
                canAssess: access.assesses && !own && row.statusEnumId === ENROLLED && row.attendedFlag === "Y",
                revision: stampOf(row)
            }
        })
        .sort((a, b) => a.personName.localeCompare(b.personName))
    const resultRows = results
        .map(row => {
            const enrollment = enrollments.find(item => item.personTrainingId === row.personTrainingId)
            const full = all
            let answers = []
            if (full && row.formResponseId) {
                const response = one("moqui.screen.form.FormResponse", {formResponseId: row.formResponseId})
                const responseMap = {}
                for (const answer of rows("moqui.screen.form.FormResponseAnswer", {formResponseId: row.formResponseId}))
                    responseMap[answer.fieldName] = answer.valueText
                answers = response ? forms().answersOf(row.formId, response.responseDate, responseMap) : []
            }
            return {
                personTrainingResultId: row.personTrainingResultId,
                personTrainingId: row.personTrainingId,
                personName: personNames[enrollment?.partyId] || enrollment?.partyId || "",
                resultEnumId: row.resultEnumId,
                resultText: resultTexts[row.resultEnumId] || row.resultEnumId,
                score: row.score != null ? Number(String(row.score)) : null,
                scoreText: row.score != null ? ec.l10n.format(row.score, "#,##0.##") : "",
                assessedDateText: dateText(row.assessedDate),
                assessorName: personNames[row.assessorPartyId] || row.assessorPartyId || "",
                // the assessor's evidence and answers: development's and the trainer's, never the person's
                evidence: full ? row.evidence || "" : null,
                answers: full ? answers : [],
                answersText: full ? answers.map(answer => answer.title + ": " + answer.displayText).join("; ") : ""
            }
        })
        .sort((a, b) => a.personName.localeCompare(b.personName) || a.assessedDateText.localeCompare(b.assessedDateText))
    const formRow = session.assessmentFormId ? one("moqui.screen.form.DbForm", {formId: session.assessmentFormId}) : null
    return {
        session: Object.assign(line, {
            description: event?.description || "",
            courseDescription: course?.description || "",
            assessmentFormId: all ? session.assessmentFormId || null : null,
            assessmentFormName: formRow?.formName || formRow?.description || "",
            assessmentRequired: course?.assessmentRequired === "Y",
            ownerPartyId: event?.ownerPartyId || null
        }),
        isDevelop: access.develop,
        isTrainer: access.trainer,
        canChange: access.developEdit && line.state !== "cancelled" && line.state !== "ended",
        canEnrollOthers: access.developEdit && line.state === "scheduled",
        canRequest: line.canRequest,
        canAssess: access.assesses,
        enrollments: enrollmentRows,
        results: resultRows,
        asOfText: dateText(at)
    }
}

// ===== store#TrainingClass =====
// A course added (organizationPartyId) or changed (trainingClassId, at its revision), or ended (end), by a development editor of
// its employer: its title, kind, description, what passing grants (a qualification type not restricted, valid validityMonths
// months) and whether its completion needs an assessment. Refused: no development editor's reach (PERMISSION_DENIED), an employer
// outside it (ORGANIZATION_DENIED), a course not in it (RECORD_UNAVAILABLE), no title (TITLE_REQUIRED), a kind or qualification
// type that is not one or ended (TYPE_INVALID, VALUE_ENDED), an identity document or work permit (TYPE_RESTRICTED), a validity
// outside 1 to 120 months (VALIDITY_INVALID), a form that is not one of the employer's published assessments (FORM_UNAVAILABLE),
// a revision other than the one read (REVISION_CHANGED).
function storeTrainingClass(p) {
    const userScope = trainingScope()
    if (!userScope.capabilities.developEdit || !userScope.developEmployers.length)
        denied("PERMISSION_DENIED", "Courses are changed by a development administrator")
    const id = text(p.trainingClassId)
    const existing = id ? one(COURSE, {trainingClassId: id}) : null
    if (id && (!existing || !userScope.developEmployers.includes(existing.organizationPartyId)))
        denied("RECORD_UNAVAILABLE", "Course " + id + " is not available")
    const organizationPartyId = existing ? existing.organizationPartyId : text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    if (!userScope.developEmployers.includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    if (existing && text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(existing))
        denied("REVISION_CHANGED", "This course changed since you read it; open it again (revision " + stampOf(existing) + ")")
    if (existing && flag(p.end)) {
        call("update#" + COURSE, {trainingClassId: id, thruDate: ec.user.nowTimestamp})
        return {trainingClassId: id, revision: stampOf(one(COURSE, {trainingClassId: id}))}
    }
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const title = value("title", existing?.title)
    if (!title) denied("TITLE_REQUIRED", "Name the course")
    const kindId = value("trainingClassTypeEnumId", existing?.trainingClassTypeEnumId)
    if (kindId && one(ENUM, {enumId: kindId})?.enumTypeId !== "TrainingClassType")
        denied("TYPE_INVALID", kindId + " is not a kind of training")
    const typeId = value("qualificationTypeEnumId", existing?.qualificationTypeEnumId)
    if (typeId) {
        const type = one(ENUM, {enumId: typeId})
        if (!type || type.enumTypeId !== "QualificationType") denied("TYPE_INVALID", typeId + " is not a qualification type")
        if (typeId !== existing?.qualificationTypeEnumId && !isCurrent(type))
            denied("VALUE_ENDED", (type.description || typeId) + " has ended")
        if (development().isRestricted(typeId))
            denied("TYPE_RESTRICTED", "An identity document or work permit is not granted by training")
    }
    const validity = given(p.validityMonths)
        ? text(p.validityMonths)
        : existing?.validityMonths != null
          ? String(existing.validityMonths)
          : ""
    if (validity && !(/^\d+$/.test(validity) && Number(validity) >= 1 && Number(validity) <= 120))
        denied("VALIDITY_INVALID", "A qualification is valid 1 to 120 months, or with no expiry")
    const formId = value("assessmentFormId", existing?.assessmentFormId)
    if (formId && formId !== existing?.assessmentFormId) forms().publishedFormFor(ASSESSMENT_PURPOSE, organizationPartyId, formId)
    const values = {
        organizationPartyId,
        title,
        trainingClassTypeEnumId: kindId,
        description: value("description", existing?.description),
        qualificationTypeEnumId: typeId,
        validityMonths: validity ? Number(validity) : null,
        assessmentRequired: given(p.assessmentRequired)
            ? flag(p.assessmentRequired)
                ? "Y"
                : "N"
            : existing?.assessmentRequired || "N",
        assessmentFormId: formId
    }
    let trainingClassId = id
    if (existing) call("update#" + COURSE, Object.assign({trainingClassId: id}, values))
    else
        trainingClassId = call(
            "create#" + COURSE,
            Object.assign(values, {createdDate: ec.user.nowTimestamp, createdByUserId: ec.user.userId})
        ).trainingClassId
    return {trainingClassId, revision: stampOf(one(COURSE, {trainingClassId}))}
}

// ===== store#Training =====
// A session scheduled (trainingClassId: a course of an employer the caller administers, not ended) or changed (workEffortId, at
// its revision), or cancelled (cancel), by a development editor of its employer: its start and end (a new one from now on), place
// (a bookable meeting room, facilityId, booked for it through the resource booking and named its place, or a free-text place off
// site; People follow-up 3),
// trainer (who works for the employer now, never one enrolled in it), seats (not fewer than the places taken) and assessment form
// (a published form of the training assessment purpose of the employer; the course's when none is named; one is needed when the
// course needs an assessment). The session is a WepTraining event of Commons' calendar (EventServices.create#Event, private),
// its trainer an attendee. A cancellation cancels the event and the places, a place waiting for approval superseded. Refused:
// no development editor's reach (PERMISSION_DENIED), a session or course not in it (RECORD_UNAVAILABLE), an ended course
// (CLASS_ENDED), no start (START_REQUIRED), a new start in the past (DATE_PAST), an end not after the start (DATES_INVALID), no
// trainer or one not working for the employer (TRAINER_REQUIRED, NOT_EMPLOYED), the trainer enrolled (TRAINER_ENROLLED), seats
// below 1 or the places taken (CAPACITY_INVALID), a form that is not one of the employer's published assessments
// (FORM_UNAVAILABLE), no form for a course that needs one (FORM_REQUIRED), a change of a cancelled or ended session
// (SESSION_CLOSED), a revision other than the one read (REVISION_CHANGED), a room that is not bookable or is not free then
// (ROOM_UNAVAILABLE: a clash, a blackout or outage, its policy; the whole change is refused with it).
function storeTraining(p) {
    const userScope = trainingScope()
    if (!userScope.capabilities.developEdit || !userScope.developEmployers.length)
        denied("PERMISSION_DENIED", "Training sessions are scheduled by a development administrator")
    const at = nowMs()
    const id = text(p.workEffortId)
    let found = null
    if (id) {
        found = sessionOf(id)
        if (!found || !userScope.developEmployers.includes(found.session.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Training session " + id + " is not available")
        const state = stateOf(found.event, at).state
        if (state === "cancelled" || state === "ended") denied("SESSION_CLOSED", "A cancelled or ended session is not changed")
        const revision = stampOf(found.session) + ":" + stampOf(found.event)
        if (text(p.expectedRevision) && text(p.expectedRevision) !== revision)
            denied("REVISION_CHANGED", "This session changed since you read it; open it again (revision " + revision + ")")
        if (flag(p.cancel)) return cancelSession(found, text(p.reason))
    }
    const course = found ? found.course : courseOf(text(p.trainingClassId))
    if (!course || !userScope.developEmployers.includes(course.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Course " + text(p.trainingClassId) + " is not available")
    if (!found && !isCurrent(course)) denied("CLASS_ENDED", "The course " + (course.title || "") + " has ended")
    const organizationPartyId = course.organizationPartyId
    const startMs = given(p.startDate) && text(p.startDate) ? ms(p.startDate) : ms(found?.event?.estimatedStartDate)
    if (startMs == null || !Number.isFinite(startMs)) denied("START_REQUIRED", "Choose when the session starts")
    const startChanged = !found || startMs !== ms(found.event.estimatedStartDate)
    if (startChanged && startMs < at - 5 * 60 * 1000) denied("DATE_PAST", "A session is scheduled from now on")
    const endMs = given(p.endDate) && text(p.endDate) ? ms(p.endDate) : (ms(found?.event?.estimatedCompletionDate) ?? null)
    if (endMs == null || !Number.isFinite(endMs) || endMs <= startMs) denied("DATES_INVALID", "The session ends after it starts")
    const trainerPartyId = given(p.trainerPartyId) ? text(p.trainerPartyId) : found?.session.trainerPartyId || ""
    if (!trainerPartyId) denied("TRAINER_REQUIRED", "Choose the trainer")
    if (
        !people
            .current(
                find("mantle.party.PartyRelationship")
                    .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                    .condition({fromPartyId: trainerPartyId, toPartyId: organizationPartyId}),
                at
            )
            .count()
    )
        denied("NOT_EMPLOYED", "The trainer does not work for this employer")
    const taken = found ? rows(ENROLLMENT, {workEffortId: id}).filter(row => seated.includes(row.statusEnumId)) : []
    if (taken.some(row => row.partyId === trainerPartyId))
        denied("TRAINER_ENROLLED", "The trainer is enrolled in this session; withdraw their place first")
    const capacityText = given(p.capacity) && text(p.capacity) ? text(p.capacity) : String(found?.session.capacity ?? "")
    const capacity = Number(capacityText)
    if (!/^\d+$/.test(capacityText) || capacity < 1 || capacity < taken.length)
        denied("CAPACITY_INVALID", "A session has at least one seat, and no fewer than the places taken (" + taken.length + ")")
    let formId = given(p.assessmentFormId)
        ? text(p.assessmentFormId) || null
        : found
          ? found.session.assessmentFormId || null
          : course.assessmentFormId || null
    if (formId && formId !== found?.session.assessmentFormId)
        formId = forms().publishedFormFor(ASSESSMENT_PURPOSE, organizationPartyId, formId)
    if (!formId && course.assessmentRequired === "Y")
        denied("FORM_REQUIRED", "This course needs an assessment: choose a published training assessment form")
    const workEffortName = ("Training: " + (course.title || course.trainingClassId)).substring(0, 255)
    // the room: one given (empty for none), else the one booked; a room is the place, else the free text given (or kept)
    const currentRoom = found ? rooms().roomsOf([id])[id] || null : null
    const facilityId = given(p.facilityId) ? text(p.facilityId) || null : currentRoom?.facilityId || null
    // a room kept is not asked again whether it is bookable (a change of the policy since leaves its bookings to its administrator)
    const room = !facilityId ? null : facilityId === currentRoom?.facilityId ? currentRoom : rooms().roomOf(facilityId)
    const location = room
        ? room.roomName
        : given(p.location)
          ? text(p.location) || null
          : currentRoom
            ? null
            : found?.event?.location || null
    const description = given(p.description) ? text(p.description) || null : found?.event?.description || null
    if (!found) {
        if (!userScope.partyId) denied("PARTY_REQUIRED", "Scheduling needs your own person record")
        const workEffortId = call("mantle.work.EventServices.create#Event", {
            workEffortName,
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepTraining",
            visibilityEnumId: "WevRestricted",
            ownerPartyId: userScope.partyId,
            estimatedStartDate: stamp(startMs),
            estimatedCompletionDate: stamp(endMs),
            location,
            description
        }).workEffortId
        call("create#" + SESSION, {
            workEffortId,
            trainingClassId: course.trainingClassId,
            organizationPartyId,
            trainerPartyId,
            capacity,
            assessmentFormId: formId,
            createdDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId
        })
        addAttendee(workEffortId, trainerPartyId, false)
        if (room) rooms().place(workEffortId, room.facilityId, false)
        const created = sessionOf(workEffortId)
        return {workEffortId, revision: stampOf(created.session) + ":" + stampOf(created.event)}
    }
    call("update#" + WORK, {
        workEffortId: id,
        workEffortName,
        estimatedStartDate: stamp(startMs),
        estimatedCompletionDate: stamp(endMs),
        location,
        description
    })
    if (startMs !== ms(found.event.estimatedStartDate) || endMs !== ms(found.event.estimatedCompletionDate))
        bookings().keptEventMoved(id)
    rooms().place(id, facilityId, startChanged || endMs !== ms(found.event.estimatedCompletionDate))
    const previousTrainer = found.session.trainerPartyId
    call("update#" + SESSION, {workEffortId: id, trainerPartyId, capacity, assessmentFormId: formId})
    if (previousTrainer !== trainerPartyId) {
        removeAttendee(id, previousTrainer)
        addAttendee(id, trainerPartyId, false)
    }
    const changed = sessionOf(id)
    return {workEffortId: id, revision: stampOf(changed.session) + ":" + stampOf(changed.event)}
}
// A session cancelled: its event (WeCancelled), its room booking and every place taken (a place waiting for approval superseded).
function cancelSession(found, reason) {
    const workEffortId = found.session.workEffortId
    call("update#" + WORK, {workEffortId, statusId: "WeCancelled"})
    bookings().keptEventCancelled(workEffortId)
    rooms().cancelAll(workEffortId)
    for (const row of rows(ENROLLMENT, {workEffortId}).filter(item => [REQUESTED, ENROLLED].includes(item.statusEnumId))) {
        call("update#" + ENROLLMENT, {
            personTrainingId: row.personTrainingId,
            statusEnumId: CANCELLED,
            statusEnumId_changeReason: reason || "Session cancelled",
            decidedDate: ec.user.nowTimestamp
        })
        if (row.statusEnumId === REQUESTED) approvals().sourceChanged(approvalKind, row.personTrainingId)
        removeAttendee(workEffortId, row.partyId)
    }
    const cancelled = sessionOf(workEffortId)
    return {workEffortId, revision: stampOf(cancelled.session) + ":" + stampOf(cancelled.event)}
}
// The person an attendee of the session's event (Commons' calendar shows it), and, for a person enrolled, a reminder a day before.
function addAttendee(workEffortId, partyId, remind) {
    const current = people.current(find(WORK_PARTY).condition({workEffortId, partyId, roleTypeId: "Assignee"}), nowMs()).count()
    if (!current)
        call("create#" + WORK_PARTY, {
            workEffortId,
            partyId,
            roleTypeId: "Assignee",
            fromDate: ec.user.nowTimestamp,
            statusId: "WeptAssigned"
        })
    if (remind && !find(REMINDER).condition({workEffortId, partyId}).count())
        call("create#" + REMINDER, {
            workEffortId,
            partyId,
            reminderSeqId: "01",
            offsetMinutes: reminderMinutes,
            methodEnumId: "WermNotification"
        })
}
// The person no longer an attendee (their current rows ended); their reminders removed.
function removeAttendee(workEffortId, partyId) {
    if (!partyId) return
    for (const row of Array.from(people.current(find(WORK_PARTY).condition({workEffortId, partyId}), nowMs()).list()))
        call("update#" + WORK_PARTY, {
            workEffortId,
            partyId,
            roleTypeId: row.roleTypeId,
            fromDate: row.fromDate,
            thruDate: ec.user.nowTimestamp
        })
    for (const row of rows(REMINDER, {workEffortId, partyId}))
        call("delete#" + REMINDER, {workEffortId, partyId, reminderSeqId: row.reminderSeqId})
}

// ===== enroll#Training =====
// A place in a session: asked for by the person for themselves (PEOPLE_SELF_SERVICE, a current employment of theirs at the
// session's employer), waiting for a People approval of kind PakTraining; or a person enrolled by a development editor of the
// employer (partyId: a current employee there), enrolled at once. Refused: a session not in reach (RECORD_UNAVAILABLE), one
// cancelled, started or ended (SESSION_CLOSED), another person by one who is not a development editor of the employer
// (PERMISSION_DENIED), a person not employed there now (NOT_EMPLOYED), the trainer (TRAINER_ENROLLED), a place already taken in
// it (ALREADY_ENROLLED), no seat left (SESSION_FULL). A retry with the same operationKey answers the first.
function enrollTraining(p) {
    const userScope = trainingScope()
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const earlier = find(ENROLLMENT).condition({operationKey, requestedByUserId: ec.user.userId}).one()
        if (earlier) return Object.assign(enrollmentAnswer(earlier), {repeated: true})
    }
    const found = readableSession(userScope, p.workEffortId)
    const {session, event, access} = found
    const partyId = text(p.partyId) || userScope.partyId
    if (!partyId) denied("RECORD_UNAVAILABLE", "Choose the person")
    const own = partyId === userScope.partyId
    if (!own && !access.developEdit)
        denied("PERMISSION_DENIED", "You ask a place for yourself; a development administrator enrolls others")
    if (own && !access.developEdit && !userScope.capabilities.self)
        denied("PERMISSION_DENIED", "Asking for a training place needs PEOPLE_SELF_SERVICE")
    if (stateOf(event, nowMs()).state !== "scheduled") denied("SESSION_CLOSED", "Places are taken before the session starts")
    const employment = people
        .current(people.employmentFind().condition({fromPartyId: partyId, toPartyId: session.organizationPartyId}), nowMs())
        .one()
    if (!employment) denied("NOT_EMPLOYED", "The person is not employed by the session's employer")
    if (partyId === session.trainerPartyId) denied("TRAINER_ENROLLED", "The trainer is not enrolled in their own session")
    // the session's places, locked through its row, so two requests do not take the last seat
    find(SESSION, {workEffortId: session.workEffortId}).forUpdate(true).one()
    const taken = rows(ENROLLMENT, {workEffortId: session.workEffortId}).filter(row => seated.includes(row.statusEnumId))
    if (taken.some(row => row.partyId === partyId)) denied("ALREADY_ENROLLED", "There is already a place for this person")
    if (taken.length >= Number(session.capacity || 0)) denied("SESSION_FULL", "No seat is left in this session")
    const assignment = Array.from(
        people
            .current(find(ASSIGNMENT).condition({partyRelationshipId: employment.partyRelationshipId, isPrimary: "Y"}), nowMs())
            .orderBy("-fromDate")
            .limit(1)
            .list()
    )[0]
    // the person's own request waits for approval; a development editor's enrollment of another is made at once
    const direct = !own
    const created = call("create#" + ENROLLMENT, {
        partyId,
        partyRelationshipId: employment.partyRelationshipId,
        organizationPartyId: session.organizationPartyId,
        departmentPartyId: assignment?.departmentPartyId || null,
        workEffortId: session.workEffortId,
        trainingClassId: session.trainingClassId,
        statusEnumId: direct ? ENROLLED : REQUESTED,
        statusEnumId_changeReason: direct ? "Enrolled by development" : "Place asked for",
        reason: text(p.reason) || null,
        requestedByUserId: ec.user.userId,
        requestedDate: ec.user.nowTimestamp,
        decidedDate: direct ? ec.user.nowTimestamp : null,
        operationKey
    })
    const enrollment = one(ENROLLMENT, {personTrainingId: created.personTrainingId})
    if (direct) addAttendee(session.workEffortId, partyId, true)
    else
        approvals().request({
            approvalKindEnumId: approvalKind,
            sourceId: enrollment.personTrainingId,
            organizationPartyId: enrollment.organizationPartyId,
            departmentPartyId: enrollment.departmentPartyId || null,
            subjectPartyId: partyId,
            effectiveDate: event.estimatedStartDate,
            justification: text(p.reason) || null
        })
    return Object.assign(enrollmentAnswer(enrollment), {repeated: false})
}
const enrollmentAnswer = row => ({
    personTrainingId: row.personTrainingId,
    workEffortId: row.workEffortId,
    statusEnumId: row.statusEnumId,
    statusText: statusTexts[row.statusEnumId] || row.statusEnumId
})

// ===== decide#Enrollment =====
// A place waiting decided, under its lock: approve or refuse (with a reason) the step waiting through
// PeopleApprovalServices.record#Decision at the enrollment's revision; the last approval enrolls the person (an attendee of the
// session's event, reminded a day before), refused when no seat is left (SESSION_FULL). withdraw: the person, who asked, or a
// development editor of the employer, while it waits or is enrolled and the session has not ended. One who reads nothing of it is
// answered as for a missing one. A decision retried answers the first. Refused as record#Decision refuses, and NOT_PENDING.
function decideEnrollment(p) {
    const userScope = trainingScope()
    const action = text(p.decision) || "approve"
    if (!["approve", "refuse", "withdraw"].includes(action)) denied("DECISION_INVALID", "Approve, refuse or withdraw")
    const read = readableEnrollment(userScope, p.personTrainingId)
    const enrollment = find(ENROLLMENT, {personTrainingId: read.enrollment.personTrainingId}).forUpdate(true).one()
    const {session, event, access} = read
    if (action === "withdraw") {
        if (!read.self && enrollment.requestedByUserId !== ec.user.userId && !access.developEdit)
            denied("NOT_YOURS", "The person, who asked or a development administrator withdraws a place")
        if (![REQUESTED, ENROLLED].includes(enrollment.statusEnumId))
            denied("NOT_PENDING", "Only a place waiting or enrolled is withdrawn")
        if (stateOf(event, nowMs()).state === "ended") denied("SESSION_CLOSED", "The session has ended")
        call("update#" + ENROLLMENT, {
            personTrainingId: enrollment.personTrainingId,
            statusEnumId: WITHDRAWN,
            statusEnumId_changeReason: text(p.reason) || "Withdrawn",
            decidedDate: ec.user.nowTimestamp
        })
        approvals().sourceChanged(approvalKind, enrollment.personTrainingId)
        removeAttendee(session.workEffortId, enrollment.partyId)
        return Object.assign(enrollmentAnswer(one(ENROLLMENT, {personTrainingId: enrollment.personTrainingId})), {
            repeated: false
        })
    }
    const asked = enrollment.statusEnumId
    // P19 review: a place is approved before the session starts (a refusal may follow later)
    if (action === "approve" && asked === REQUESTED && stateOf(event, nowMs()).state !== "scheduled")
        denied("SESSION_CLOSED", "The session has started; a place is approved before it starts")
    if (action === "approve" && asked === REQUESTED) {
        const others = rows(ENROLLMENT, {workEffortId: session.workEffortId}).filter(
            row => [ENROLLED, COMPLETED].includes(row.statusEnumId) && row.personTrainingId !== enrollment.personTrainingId
        )
        if (others.length >= Number(session.capacity || 0)) denied("SESSION_FULL", "No seat is left in this session")
    }
    const reason = text(p.reason) || null
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: approvalKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: enrollment.personTrainingId,
        decision: action,
        reason,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    const current = () => one(ENROLLMENT, {personTrainingId: enrollment.personTrainingId})
    if (decided.repeated) return Object.assign(enrollmentAnswer(current()), {repeated: true})
    if (asked !== REQUESTED) denied("NOT_PENDING", "This place is " + (statusTexts[asked] || asked).toLowerCase())
    if (decided.complete || decided.statusId === "PapRefused") {
        call("update#" + ENROLLMENT, {
            personTrainingId: enrollment.personTrainingId,
            statusEnumId: decided.complete ? ENROLLED : REFUSED,
            statusEnumId_changeReason: decided.complete ? "Approved" : reason,
            decidedDate: ec.user.nowTimestamp,
            decisionReason: decided.complete ? null : reason
        })
        if (decided.complete) addAttendee(session.workEffortId, enrollment.partyId, true)
        tellPerson(current(), event, decided.complete ? "approved" : "refused")
    }
    return Object.assign(enrollmentAnswer(current()), {repeated: false})
}
// P19 review: the decision told to the person (and to who asked, when another): PeopleTrainingDecision, with the course, the
// session's day and the outcome only, never the reason, to them alone (directOnly, People follow-up 1). A failure is logged and the
// decision stays.
function tellPerson(enrollment, event, outcomeText) {
    try {
        const userIds = unique(
            rows("moqui.security.UserAccount", {partyId: enrollment.partyId})
                .map(row => row.userId)
                .concat(enrollment.requestedByUserId ? [enrollment.requestedByUserId] : [])
        ).filter(userId => userId && userId !== ec.user.userId)
        if (!userIds.length) return
        const course = courseOf(enrollment.trainingClassId)
        ec.makeNotificationMessage()
            .topic("PeopleTrainingDecision")
            .message({
                personTrainingId: enrollment.personTrainingId,
                workEffortId: enrollment.workEffortId,
                courseText: course?.title || enrollment.trainingClassId || "",
                dayText: event?.estimatedStartDate ? ec.l10n.format(event.estimatedStartDate, "yyyy-MM-dd") : "",
                outcomeText
            })
            .record(ENROLLMENT, enrollment.personTrainingId)
            .userIds(userIds)
            .directOnly()
            .send()
    } catch (error) {
        ec.logger.error("Training decision notice of " + enrollment.personTrainingId + " was not sent: " + error.message)
    }
}
function decideEnrollmentNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== ENROLLMENT) denied("SOURCE_INVALID", "Not a training approval")
    return decideEnrollment({
        personTrainingId: p.recordId,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        decision,
        reason: p.reason
    })
}
const approveEnrollmentNotice = p => decideEnrollmentNotice(p, "approve")
const refuseEnrollmentNotice = p => decideEnrollmentNotice(p, "refuse")

// ===== mark#TrainingAttendance =====
// A person enrolled marked attended (with the hours, at most the session's length) or absent by the session's trainer or a
// development editor of its employer, once the session has started; never their own. Refused: one not in reach
// (RECORD_UNAVAILABLE), a caller who does not assess it (PERMISSION_DENIED), their own (SELF_APPROVAL), one not enrolled
// (NOT_ENROLLED), a session not started (SESSION_NOT_STARTED), hours that are not 0 to the session's length (HOURS_INVALID), a
// revision other than the one read (REVISION_CHANGED).
function markAttendance(p) {
    const userScope = trainingScope()
    const read = readableEnrollment(userScope, p.personTrainingId)
    const {event, access} = read
    if (!access.assesses) denied("PERMISSION_DENIED", "Attendance is recorded by the trainer or a development administrator")
    const enrollment = find(ENROLLMENT, {personTrainingId: read.enrollment.personTrainingId}).forUpdate(true).one()
    if (read.self) denied("SELF_APPROVAL", "Your own attendance is recorded by someone else")
    if (enrollment.statusEnumId !== ENROLLED) denied("NOT_ENROLLED", "Only a person enrolled is marked")
    if (stateOf(event, nowMs()).state === "scheduled")
        denied("SESSION_NOT_STARTED", "Attendance is marked once the session starts")
    if (text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(enrollment))
        denied("REVISION_CHANGED", "This place changed since you read it; open it again (revision " + stampOf(enrollment) + ")")
    const attended = flag(p.attended)
    const lengthHours = (ms(event.estimatedCompletionDate) - ms(event.estimatedStartDate)) / (60 * 60 * 1000)
    let hours = null
    if (attended) {
        hours = given(p.attendedHours) && text(p.attendedHours) ? Number(text(p.attendedHours)) : lengthHours
        if (!Number.isFinite(hours) || hours <= 0 || hours > lengthHours + 0.01)
            denied(
                "HOURS_INVALID",
                "Attended hours are more than 0 and at most the session's " + Math.round(lengthHours * 100) / 100
            )
    }
    call("update#" + ENROLLMENT, {
        personTrainingId: enrollment.personTrainingId,
        attendedFlag: attended ? "Y" : "N",
        attendedFlag_changeReason: attended ? "Attended" : "Absent",
        attendedHours: hours == null ? null : toDecimal(String(Math.round(hours * 100) / 100)),
        attendanceByUserId: ec.user.userId
    })
    const after = one(ENROLLMENT, {personTrainingId: enrollment.personTrainingId})
    return {personTrainingId: after.personTrainingId, attendedFlag: after.attendedFlag, revision: stampOf(after)}
}

// ===== complete#Training =====
// An assessment of a person enrolled who attended, by the session's trainer or a development editor of its employer (never their
// own): passed or failed, a score of 0 to 100, evidence, and the session's assessment form answered (values; FORM_VALUES_INVALID),
// kept as a FormResponse its FormInvitation locks. A failed one is kept and the person stays enrolled for another attempt; the
// passing one completes the enrollment once, grants the course's qualification once (verified, the assessor its verifier, valid
// for the course's months, renewing the person's earlier one of the type) and issues the completion certificate, stored when
// issued. A completion retried answers the first (repeated), as does a retry with the same operationKey. Refused: one not in reach
// (RECORD_UNAVAILABLE), a caller who does not assess it (PERMISSION_DENIED), their own (SELF_APPROVAL), an outcome that is not one
// (OUTCOME_INVALID), a score outside 0 to 100 (SCORE_INVALID), a failure after completion (ALREADY_COMPLETED), one not enrolled
// (NOT_ENROLLED), one not marked attended (ATTENDANCE_REQUIRED), no answers when the session has a form (ASSESSMENT_REQUIRED).
function completeTraining(p) {
    const userScope = trainingScope()
    const read = readableEnrollment(userScope, p.personTrainingId)
    const {session, course, event, access} = read
    if (!access.assesses) denied("PERMISSION_DENIED", "Training is assessed by the trainer or a development administrator")
    if (read.self) denied("SELF_APPROVAL", "Your own training is assessed by someone else")
    const enrollment = find(ENROLLMENT, {personTrainingId: read.enrollment.personTrainingId}).forUpdate(true).one()
    const outcome = text(p.outcome) || "pass"
    if (!["pass", "fail"].includes(outcome)) denied("OUTCOME_INVALID", "Passed or failed")
    const operationKey = text(p.operationKey) || null
    if (operationKey) {
        const earlier = find(RESULT).condition({personTrainingId: enrollment.personTrainingId, operationKey}).one()
        if (earlier) return Object.assign(completionAnswer(enrollment, earlier), {repeated: true})
    }
    if (enrollment.statusEnumId === COMPLETED) {
        if (outcome === "fail") denied("ALREADY_COMPLETED", "This training was completed " + dateText(enrollment.completedDate))
        const passing = find(RESULT).condition({personTrainingId: enrollment.personTrainingId, resultEnumId: PASSED}).one()
        return Object.assign(completionAnswer(enrollment, passing), {repeated: true})
    }
    if (enrollment.statusEnumId !== ENROLLED) denied("NOT_ENROLLED", "Only a person enrolled is assessed")
    if (enrollment.attendedFlag !== "Y") denied("ATTENDANCE_REQUIRED", "Mark the person attended before assessing them")
    let score = null
    if (given(p.score) && text(p.score)) {
        const value = Number(text(p.score))
        if (!Number.isFinite(value) || value < 0 || value > 100) denied("SCORE_INVALID", "A score is 0 to 100")
        score = toDecimal(text(p.score))
    }
    const values = typeof p.values === "string" ? lib.json(p.values, {}) : Object.assign({}, p.values || {})
    const formId = session.assessmentFormId || null
    if (!formId && course?.assessmentRequired === "Y")
        denied("ASSESSMENT_REQUIRED", "This course needs an assessment form on the session")
    const now = ec.user.nowTimestamp
    let formResponseId = null
    let invitationId = null
    const attempt = rows(RESULT, {personTrainingId: enrollment.personTrainingId}).length + 1
    if (formId) {
        if (!Object.keys(values).length) denied("ASSESSMENT_REQUIRED", "Answer the session's assessment")
        formResponseId = forms().recordAnswer(formId, values)
        invitationId = call("create#" + INVITATION, {
            formId,
            organizationPartyId: enrollment.organizationPartyId,
            partyId: enrollment.partyId,
            contactPartyId: userScope.partyId,
            contextEntityName: WORK,
            contextId: session.workEffortId,
            recordEntityName: ENROLLMENT,
            recordId: enrollment.personTrainingId,
            invitationKey: "training:" + enrollment.personTrainingId + ":" + attempt,
            statusEnumId: "FinResponded",
            formResponseId,
            responseDate: now,
            createdDate: now
        }).invitationId
    }
    const passed = outcome === "pass"
    const resultId = call("create#" + RESULT, {
        personTrainingId: enrollment.personTrainingId,
        resultEnumId: passed ? PASSED : FAILED,
        score,
        assessedDate: now,
        assessorPartyId: userScope.partyId,
        assessedByUserId: ec.user.userId,
        evidence: text(p.evidence) || null,
        formId,
        formResponseId,
        invitationId,
        operationKey
    }).personTrainingResultId
    const result = one(RESULT, {personTrainingResultId: resultId})
    if (!passed) return Object.assign(completionAnswer(enrollment, result), {repeated: false})
    const partyQualificationId = course?.qualificationTypeEnumId ? grant(enrollment, course, now) : null
    call("update#" + ENROLLMENT, {
        personTrainingId: enrollment.personTrainingId,
        statusEnumId: COMPLETED,
        statusEnumId_changeReason: "Passed",
        completedDate: now,
        partyQualificationId
    })
    issueCertificate(one(ENROLLMENT, {personTrainingId: enrollment.personTrainingId}), course, session, event, result)
    return Object.assign(completionAnswer(one(ENROLLMENT, {personTrainingId: enrollment.personTrainingId}), result), {
        repeated: false
    })
}
const completionAnswer = (enrollment, result) => ({
    personTrainingId: enrollment.personTrainingId,
    personTrainingResultId: result?.personTrainingResultId || null,
    resultEnumId: result?.resultEnumId || null,
    statusEnumId: enrollment.statusEnumId,
    partyQualificationId: enrollment.partyQualificationId || null
})
// The course's qualification granted to the person once: verified by the assessor's completion, valid for the course's months,
// renewing the person's latest verified one of the type.
function grant(enrollment, course, now) {
    const nowMillis = ms(now)
    let thru = null
    if (course.validityMonths) {
        const date = new Date(nowMillis)
        date.setMonth(date.getMonth() + Number(course.validityMonths))
        thru = date
    }
    const earlier = rows(QUALIFICATION, {
        partyId: enrollment.partyId,
        qualificationTypeEnumId: course.qualificationTypeEnumId,
        verificationStatusId: "QlVerVerified"
    }).sort((a, b) => (ms(b.thruDate) ?? Infinity) - (ms(a.thruDate) ?? Infinity))[0]
    const organizationName = people.organizationNames([enrollment.organizationPartyId])[enrollment.organizationPartyId] || ""
    return call("create#" + QUALIFICATION, {
        partyId: enrollment.partyId,
        qualificationTypeEnumId: course.qualificationTypeEnumId,
        title: course.title || null,
        issuerName: organizationName || null,
        referenceNumber: enrollment.personTrainingId,
        fromDate: now,
        thruDate: thru,
        verificationStatusId: "QlVerVerified",
        verificationStatusId_changeReason: "Granted by passing training " + enrollment.personTrainingId,
        submittedByUserId: ec.user.userId,
        submittedDate: now,
        verifiedByUserId: ec.user.userId,
        verifiedDate: now,
        renewsQualificationId: earlier?.partyQualificationId || null,
        comments: "Granted by the training session " + enrollment.workEffortId
    }).partyQualificationId
}

// ===== the completion certificate (design §15) =====
// The certificate's page as issued: the person, the course, the employer, the completion, the assessor, what it grants and until
// when; stored when issued (the page html-print shows and its PDF), never rendered again.
function certificateHtml(enrollment, course, session, event, result) {
    const names = people.personNames([enrollment.partyId, result?.assessorPartyId].filter(Boolean))
    const qualification = enrollment.partyQualificationId
        ? one(QUALIFICATION, {partyQualificationId: enrollment.partyQualificationId})
        : null
    const typeNames = enumNames([course?.qualificationTypeEnumId])
    return ec.resource.template("component://mr-mantle/template/humanres/TrainingCertificate.print.html.fancy", {
        certificateNumber: enrollment.personTrainingId,
        personName: names[enrollment.partyId] || enrollment.partyId,
        courseTitle: course?.title || enrollment.trainingClassId,
        organizationName: people.organizationNames([enrollment.organizationPartyId])[enrollment.organizationPartyId] || "",
        sessionText: event?.estimatedStartDate ? ec.l10n.format(event.estimatedStartDate, "yyyy-MM-dd") : "",
        completedText: dateText(enrollment.completedDate),
        assessorName: result?.assessorPartyId ? names[result.assessorPartyId] || "" : "",
        attendedText: enrollment.attendedHours != null ? ec.l10n.format(enrollment.attendedHours, "#,##0.##") + " h" : "",
        qualificationText: qualification ? typeNames[course.qualificationTypeEnumId] || course.qualificationTypeEnumId : "",
        validThruText: qualification?.thruDate ? dateText(qualification.thruDate) : "",
        issuedText: dateText(ec.user.nowTimestamp)
    })
}
function issueCertificate(enrollment, course, session, event, result) {
    const printHtml = certificateHtml(enrollment, course, session, event, result)
    const fileName = "Training-certificate-" + enrollment.personTrainingId
    const folder = "dbresource://mantle/content/training/" + enrollment.personTrainingId + "/certificate"
    const htmlLocation = folder + "/" + fileName + ".html"
    ec.resource.getLocationReference(htmlLocation).putText(printHtml)
    let pdfLocation = null
    try {
        const pdf = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf")
        pdfLocation = folder + "/" + fileName + ".pdf"
        ec.resource.getLocationReference(pdfLocation).putBytes(pdf)
    } catch (error) {
        // the page is issued and kept; a PDF that does not render is logged, and the page prints from the browser
        pdfLocation = null
        ec.logger.error("The PDF of training certificate " + enrollment.personTrainingId + " was not made: " + error.message)
    }
    call("update#" + ENROLLMENT, {
        personTrainingId: enrollment.personTrainingId,
        certificateHtmlLocation: htmlLocation,
        certificateLocation: pdfLocation,
        certificateIssuedDate: ec.user.nowTimestamp
    })
}
// get#TrainingCertificate: a completed enrollment's certificate as issued, to the person, a development reader or an HR reader of
// the employer: its stored page, its PDF's location and name. Refused: one not in reach or with no certificate issued
// (RECORD_UNAVAILABLE, CERTIFICATE_UNAVAILABLE).
function trainingCertificate(p) {
    const userScope = trainingScope()
    const enrollment = text(p.personTrainingId) ? one(ENROLLMENT, {personTrainingId: text(p.personTrainingId)}) : null
    const caps = userScope.capabilities
    const self = !!enrollment && !!userScope.partyId && enrollment.partyId === userScope.partyId && !!caps.self
    const staff =
        !!enrollment &&
        (userScope.developEmployers.includes(enrollment.organizationPartyId) ||
            (!!caps.hrView && userScope.organizationPartyIds.includes(enrollment.organizationPartyId)))
    if (!enrollment || !(self || staff))
        denied("RECORD_UNAVAILABLE", "Training enrollment " + text(p.personTrainingId) + " is not available")
    if (!enrollment.certificateHtmlLocation) denied("CERTIFICATE_UNAVAILABLE", "No certificate was issued for this training")
    return {
        personTrainingId: enrollment.personTrainingId,
        printHtml: ec.resource.getLocationReference(enrollment.certificateHtmlLocation).getText(),
        pdfLocation: enrollment.certificateLocation || null,
        fileName: "Training-certificate-" + enrollment.personTrainingId + ".pdf",
        issuedDateText: dateText(enrollment.certificateIssuedDate)
    }
}

const operations = {
    findTraining,
    getTraining,
    storeTrainingClass,
    storeTraining,
    enrollTraining,
    decideEnrollment,
    approveEnrollmentNotice,
    refuseEnrollmentNotice,
    markAttendance,
    completeTraining,
    trainingCertificate
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown training operation " + op)
    return operations[op](p || {})
}
// sessionHours: each person's hours in training sessions from fromMs to thruMs, the sessions they are enrolled in or train, not
// cancelled; sessions that overlap counted once. For Maintenance's dispatch (find#MaintenanceCandidates' free hours,
// impl-maintenance F360), which checked its own caller; nothing of a session but its time is answered.
function sessionHours(partyIds, fromMs, thruMs) {
    const ids = unique(Array.from(partyIds || []).filter(Boolean))
    const hours = {}
    if (!ids.length || !(thruMs > fromMs)) return hours
    const sessionsOf = new Map()
    const add = (partyId, workEffortId) => sessionsOf.set(partyId, (sessionsOf.get(partyId) || []).concat([workEffortId]))
    for (const row of Array.from(find(ENROLLMENT).condition("partyId", "in", ids).condition("statusEnumId", ENROLLED).list()))
        add(row.partyId, row.workEffortId)
    for (const row of Array.from(find(SESSION).condition("trainerPartyId", "in", ids).list()))
        add(row.trainerPartyId, row.workEffortId)
    const eventIds = unique([].concat(...Array.from(sessionsOf.values())))
    if (!eventIds.length) return hours
    const spans = new Map()
    for (const event of Array.from(
        find(WORK)
            .condition("workEffortId", "in", eventIds)
            .condition("statusId", "not-equals", "WeCancelled")
            .condition("estimatedStartDate", "less", stamp(thruMs))
            .condition("estimatedCompletionDate", "greater", stamp(fromMs))
            .list()
    ))
        spans.set(event.workEffortId, [
            Math.max(fromMs, ms(event.estimatedStartDate)),
            Math.min(thruMs, ms(event.estimatedCompletionDate))
        ])
    for (const [partyId, sessions] of sessionsOf) {
        const own = unique(sessions)
            .map(id => spans.get(id))
            .filter(Boolean)
            .sort((a, b) => a[0] - b[0])
        let total = 0
        let end = -Infinity
        for (const [start, stop] of own) {
            if (stop <= end) continue
            total += stop - Math.max(start, end)
            end = stop
        }
        if (total > 0) hours[partyId] = total / (60 * 60 * 1000)
    }
    return hours
}

// ===== capacity =====
// The training sessions that take people's time, for mantle.work.ResourceServices.get#PartyCapacity (People follow-up 3,
// impl-maintenance F360): each session not cancelled that overlaps fromMs to thruMs, of each person as its trainer or holding a place
// enrolled or completed and not marked absent; {partyId: [[startMs, endMs]]}. Times only: no course, employer or result. No access
// check: its callers answer hours alone, for readers they checked.
function sessionTimesOf(partyIds, fromMs, thruMs) {
    const found = {}
    const ids = unique(Array.from(partyIds || []).filter(Boolean))
    if (!ids.length) return found
    const partiesOf = new Map()
    const add = (workEffortId, partyId) => {
        if (!partiesOf.has(workEffortId)) partiesOf.set(workEffortId, new Set())
        partiesOf.get(workEffortId).add(partyId)
    }
    for (const row of Array.from(
        find(SESSION).condition("trainerPartyId", "in", ids).selectField("workEffortId,trainerPartyId").list()
    ))
        add(row.workEffortId, row.trainerPartyId)
    for (const row of Array.from(
        find(ENROLLMENT)
            .condition("partyId", "in", ids)
            .condition("statusEnumId", "in", [ENROLLED, COMPLETED])
            .selectField("workEffortId,partyId,attendedFlag")
            .list()
    ))
        if (row.attendedFlag !== "N") add(row.workEffortId, row.partyId)
    if (!partiesOf.size) return found
    const events = Array.from(
        find(WORK)
            .condition("workEffortId", "in", Array.from(partiesOf.keys()))
            .condition("estimatedStartDate", "less", stamp(thruMs))
            .condition("estimatedCompletionDate", "greater", stamp(fromMs))
            .selectField("workEffortId,statusId,estimatedStartDate,estimatedCompletionDate")
            .list()
    )
    for (const event of events) {
        if (event.statusId === "WeCancelled") continue
        const interval = [ms(event.estimatedStartDate), ms(event.estimatedCompletionDate)]
        for (const partyId of partiesOf.get(event.workEffortId)) (found[partyId] = found[partyId] || []).push(interval)
    }
    return found
}
;({execute: run, sessionHours, sessionTimesOf})
