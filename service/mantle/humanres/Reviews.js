// People's reviews and goals (mantle.humanres.ReviewServices: find#Cycles, store#ReviewTemplate, store#Cycle, start#Cycle,
// find#Reviews, get#Review, store#Assessment, submit#Feedback, change#ReviewState with the PeopleReviewStep handlers, store#ReviewNote,
// get#ReviewRelease, check#ReviewAccess, find#Goals and store#Goal; IronStone People design §11 ReviewCycles, Reviews, ReviewDetail and
// Goals, §15 the review release, PE-16, PE-01, PE-21; impl-people P20). Every read is a projection of the caller's People scope
// (People.js scopeOf), read with authorization off after that check.
//
// The records (PeopleReviewEntities.xml, refined from the commented sketches, F6):
// - a template (ReviewTemplate) of an employer says which steps its reviews ask for, the review form each answers (a published form
//   of the DbfpReview purpose, People's Forms; none: a written summary) and its release policy;
// - a cycle (ReviewCycle) of an employer, or of one of its units and those under it, is started into one review (PerformanceReview)
//   per current employee in scope, each in its own transaction: the reviewer is the manager of the employment's live reporting line
//   then (a person with none is named and left out; a later start adds them once a line exists);
// - a review's steps (PerformanceReviewStep): the person's self assessment, the reviewer's assessment (the overall rating) and the
//   feedback the reviewer asks of colleagues, each answered once by its assignee and locked; a step returned (with its reason)
//   waits again;
// - the reviewer's private notes (PerformanceNote): their author's alone, never in the release, an export, Chatter, a notice or the
//   search index;
// - the review is finalized by its reviewer (after a People approval of kind PakReview when the template asks for one), released (the
//   employee-visible assessment rendered once and stored, its page and PDF, never rendered again; the person told), and
//   acknowledged by the person;
// - a goal is a WorkEffort of the WetGoal type and WepGoal purpose with its measure (PersonGoal): never a task, so in no task list.
//
// Who reads and does what of a review:
// - the person reads their review's state and their own self assessment; once released, the reviewer's assessment, the rating and
//   (when the template says so) the feedback, and acknowledges it;
// - its reviewer (while they work for its employer) reads its steps, the feedback given on the review included, whoever asked for
//   it (it belongs to the review: the user's call of Nov 12, 2026), assesses, asks for and withdraws feedback, returns the self
//   assessment, finalizes and releases; an earlier reviewer's private notes never pass to them;
// - a feedback giver reads and answers their own feedback alone;
// - an approver of its PakReview step reads its steps (never a note) and decides;
// - a development reader (PEOPLE_DEVELOP_VIEW) of its employer reads every step; a development editor (PEOPLE_DEVELOP_EDIT) also
//   returns a submitted step, releases, reassigns the reviewer and excludes the review.
// A private note is read by its author alone, whoever else reads the review. Nobody acts on their own review but the person's own
// steps (SELF_APPROVAL). Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const TEMPLATE = "mantle.humanres.ability.ReviewTemplate"
const CYCLE = "mantle.humanres.ability.ReviewCycle"
const REVIEW = "mantle.humanres.ability.PerformanceReview"
const STEP = "mantle.humanres.ability.PerformanceReviewStep"
const NOTE = "mantle.humanres.ability.PerformanceNote"
const GOAL = "mantle.humanres.ability.PersonGoal"
const WORK = "mantle.work.effort.WorkEffort"
const INVITATION = "mantle.party.FormInvitation"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const ENUM = "moqui.basic.Enumeration"
const REVIEW_PURPOSE = "DbfpReview"
const approvalKind = "PakReview"
const DRAFT = "RcsDraft",
    ACTIVE = "RcsActive",
    CLOSED = "RcsClosed"
const cycleTexts = {[DRAFT]: "Draft", [ACTIVE]: "In progress", [CLOSED]: "Closed"}
const IN_PROGRESS = "PrvInProgress",
    APPROVAL = "PrvApproval",
    FINALIZED = "PrvFinalized",
    RELEASED = "PrvReleased",
    ACKNOWLEDGED = "PrvAcknowledged",
    EXCLUDED = "PrvExcluded"
const reviewTexts = {
    [IN_PROGRESS]: "Assessing",
    [APPROVAL]: "Waiting for approval",
    [FINALIZED]: "Finalized",
    [RELEASED]: "Released",
    [ACKNOWLEDGED]: "Acknowledged",
    [EXCLUDED]: "Excluded"
}
// a review still to finish: its reviewer and steps follow the reporting lines (rerouteSteps)
const openStates = [IN_PROGRESS, APPROVAL, FINALIZED]
const releasedStates = [RELEASED, ACKNOWLEDGED]
const SELF = "RskSelf",
    MANAGER = "RskManager",
    FEEDBACK = "RskFeedback"
const kindTexts = {[SELF]: "Self assessment", [MANAGER]: "Reviewer's assessment", [FEEDBACK]: "Feedback"}
const WAITING = "RssWaiting",
    SUBMITTED = "RssSubmitted",
    CANCELLED = "RssCancelled"
const stepTexts = {[WAITING]: "Waiting", [SUBMITTED]: "Submitted", [CANCELLED]: "Cancelled"}
const RATING_TYPE = "PerformanceReviewRating"
const OUTCOME_TYPE = "GoalOutcome"
// the most people a start reads, the most reviews and goals a list reads
const peopleCap = 2000
const listCap = 2000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const given = value => value != null
const flag = value => value === true || value === "true" || value === "Y"
const unique = people.unique
const stampOf = row => String(ms(row?.lastUpdatedStamp) ?? 0)
const dayText = value => (value == null || value === "" ? "" : lib.calendarDateText(value))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
function enumNames(enumIds) {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(ENUM).condition("enumId", "in", ids).list()).map(row => [row.enumId, row.description || row.enumId])
    )
}
function enumOf(enumId, enumTypeId, what) {
    const value = text(enumId)
    if (!value) return null
    const row = one(ENUM, {enumId: value})
    if (!row || row.enumTypeId !== enumTypeId) denied("VALUE_INVALID", value + " is not a " + what)
    return value
}
// a calendar day given as text or a date, else null; one that is not a day is refused
function dayOf(value, what) {
    if (!given(value) || text(value) === "") return null
    let day
    try {
        day = lib.calendarDateText(text(value).slice(0, 10))
    } catch (error) {
        day = ""
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) denied("DATE_INVALID", "Give " + what + " as a day")
    return day
}
// a goal's day as a timestamp at its start in the user's zone, and back
const stampDay = day => (day ? ec.l10n.parseTimestamp(day + " 00:00:00", "yyyy-MM-dd HH:mm:ss") : null)
const stampDayText = value => (value == null || value === "" ? "" : ec.l10n.format(value, "yyyy-MM-dd"))
const isCurrent = row => !!row && (ms(row.thruDate) ?? Infinity) > nowMs()

// ===== scope and access =====
// The employers the party works for now (an employee or agent).
function worksFor(partyId) {
    if (!partyId) return []
    return unique(
        Array.from(
            people
                .current(
                    find(RELATIONSHIP)
                        .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                        .condition("fromPartyId", partyId)
                        .selectField("toPartyId"),
                    nowMs()
                )
                .list()
        ).map(row => row.toPartyId)
    )
}
// The caller's People scope with the employers whose reviews they administer (a development reader's) and those they work for now.
function reviewScope() {
    const userScope = people.scopeOf()
    userScope.developEmployers = userScope.capabilities.developView ? userScope.organizationPartyIds.slice() : []
    userScope.workEmployers = worksFor(userScope.partyId)
    return userScope
}
const reviewOf = performanceReviewId =>
    text(performanceReviewId) ? one(REVIEW, {performanceReviewId: text(performanceReviewId)}) : null
const stepsOf = performanceReviewId => rows(STEP, {performanceReviewId})
// whether the caller decided, or may decide now, the review's approval
function approverOf(userScope, review) {
    if (!userScope.partyId) return {approver: false, summary: null}
    const summary = approvals().sourceSummary(approvalKind, review.performanceReviewId)
    if (summary?.canDecide) return {approver: true, summary}
    const decided = rows("mantle.humanres.approval.PeopleApproval", {
        sourceEntityName: REVIEW,
        sourceId: review.performanceReviewId
    }).some(approval =>
        rows("mantle.humanres.approval.PeopleApprovalDecision", {peopleApprovalId: approval.peopleApprovalId}).some(
            row => row.decidedByPartyId === userScope.partyId
        )
    )
    return {approver: decided, summary}
}
// How the caller reads a review: the person (self, which no staff reading of theirs widens), its reviewer while they work for its
// employer, a giver of feedback on it, an approver of its approval, a development reader (develop) or editor (developEdit) of its
// employer; full: every step (never a note).
function accessOf(userScope, review, steps = stepsOf(review.performanceReviewId)) {
    const partyId = userScope.partyId
    const self = !!partyId && review.partyId === partyId
    const develop = !self && userScope.developEmployers.includes(review.organizationPartyId)
    const developEdit = develop && !!userScope.capabilities.developEdit
    const reviewer =
        !self && !!partyId && review.managerPartyId === partyId && userScope.workEmployers.includes(review.organizationPartyId)
    const feedbackSteps = partyId
        ? steps.filter(step => step.stepKindEnumId === FEEDBACK && step.partyId === partyId && step.statusEnumId !== CANCELLED)
        : []
    const decision = self ? {approver: false, summary: null} : approverOf(userScope, review)
    const approver = !reviewer && !develop && decision.approver
    const released = releasedStates.includes(review.statusEnumId)
    return {
        self,
        develop,
        developEdit,
        reviewer,
        giver: !self && feedbackSteps.length > 0,
        feedbackSteps,
        approver,
        summary: decision.summary,
        released,
        full: develop || reviewer || approver,
        reads: self || develop || reviewer || approver || (!self && feedbackSteps.length > 0)
    }
}
function readableReview(userScope, performanceReviewId) {
    const review = reviewOf(performanceReviewId)
    const steps = review ? stepsOf(review.performanceReviewId) : []
    const access = review ? accessOf(userScope, review, steps) : {reads: false}
    if (!review || !access.reads) denied("RECORD_UNAVAILABLE", "Review " + text(performanceReviewId) + " is not available")
    return {review, steps, access}
}
// Which steps the caller reads the content of: the full readers every one (the reviewer every feedback on the review, an earlier
// reviewer's asking included: it belongs to the review, the user's call of Nov 12, 2026), the person their own self assessment
// and, once released, the reviewer's assessment and (by the template) the feedback; a giver their own feedback.
function readsStep(access, step, review, template) {
    if (step.stepKindEnumId === SELF) return access.full || access.self
    if (step.stepKindEnumId === MANAGER) return access.full || (access.self && access.released)
    if (access.full) return true
    if (access.self) return access.released && template?.feedbackReleased === "Y" && step.statusEnumId === SUBMITTED
    return access.feedbackSteps.some(own => own.performanceReviewStepId === step.performanceReviewStepId)
}
// Which steps the caller sees at all: the person sees the self and reviewer's steps' state (feedback only once released by the
// template); a giver their own; the full readers every one
function seesStep(access, step, review, template) {
    if (step.stepKindEnumId !== FEEDBACK) return access.full || access.self
    return readsStep(access, step, review, template)
}

// ===== templates and cycles =====
const templateOf = reviewTemplateId => (text(reviewTemplateId) ? one(TEMPLATE, {reviewTemplateId: text(reviewTemplateId)}) : null)
function requireDevelopEdit(userScope, organizationPartyId) {
    if (!userScope.capabilities.developEdit || !userScope.developEmployers.length)
        denied("PERMISSION_DENIED", "Reviews are set up by a development administrator")
    if (organizationPartyId && !userScope.developEmployers.includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
}
function templateLine(row, organizationNames) {
    const formNames = {}
    for (const formId of [row.selfFormId, row.managerFormId, row.feedbackFormId].filter(Boolean)) {
        const form = one("moqui.screen.form.DbForm", {formId})
        formNames[formId] = form?.formName || form?.description || formId
    }
    const parts = [row.selfAssessment === "Y" ? "self assessment" : "", "reviewer's assessment"]
    if (row.feedbackAllowed === "Y") parts.push("feedback")
    return {
        reviewTemplateId: row.reviewTemplateId,
        templateName: row.templateName || row.reviewTemplateId,
        organizationPartyId: row.organizationPartyId,
        organizationName: organizationNames[row.organizationPartyId] || row.organizationPartyId,
        description: row.description || "",
        selfAssessment: row.selfAssessment === "Y",
        feedbackAllowed: row.feedbackAllowed === "Y",
        feedbackReleased: row.feedbackReleased === "Y",
        approvalRequired: row.approvalRequired === "Y",
        selfFormId: row.selfFormId || null,
        managerFormId: row.managerFormId || null,
        feedbackFormId: row.feedbackFormId || null,
        stepsText: parts.filter(Boolean).join(", "),
        releaseText:
            (row.approvalRequired === "Y" ? "Approved before release" : "Released by the reviewer") +
            (row.feedbackReleased === "Y" ? "; feedback shared with the person" : ""),
        formsText: [row.selfFormId, row.managerFormId, row.feedbackFormId]
            .filter(Boolean)
            .map(formId => formNames[formId])
            .join(", "),
        ended: !isCurrent(row),
        revision: stampOf(row)
    }
}
// store#ReviewTemplate: a template added (organizationPartyId) or changed (reviewTemplateId, at its revision; only while no started
// cycle uses it), or ended (end), by a development editor of its employer: its name, the steps it asks for, the form of each (a
// published review form of the employer) and its release policy. Refused: no development editor's reach (PERMISSION_DENIED), an
// employer outside it (ORGANIZATION_DENIED), a template not in it (RECORD_UNAVAILABLE), no name (NAME_REQUIRED), a form that is not
// one of the employer's published review forms (FORM_UNAVAILABLE), a template a started cycle uses (TEMPLATE_IN_USE: end it and add
// another), a revision other than the one read (REVISION_CHANGED).
function storeReviewTemplate(p) {
    const userScope = reviewScope()
    requireDevelopEdit(userScope, null)
    const id = text(p.reviewTemplateId)
    const existing = id ? templateOf(id) : null
    if (id && (!existing || !userScope.developEmployers.includes(existing.organizationPartyId)))
        denied("RECORD_UNAVAILABLE", "Review template " + id + " is not available")
    const organizationPartyId = existing ? existing.organizationPartyId : text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    requireDevelopEdit(userScope, organizationPartyId)
    if (existing && text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(existing))
        denied("REVISION_CHANGED", "This template changed since you read it; open it again (revision " + stampOf(existing) + ")")
    if (existing && flag(p.end)) {
        call("update#" + TEMPLATE, {reviewTemplateId: id, thruDate: ec.user.nowTimestamp})
        return {reviewTemplateId: id, revision: stampOf(templateOf(id))}
    }
    if (existing) {
        const started = find(CYCLE).condition("reviewTemplateId", id).condition("statusEnumId", "in", [ACTIVE, CLOSED]).count()
        if (started) denied("TEMPLATE_IN_USE", "A started cycle uses this template; end it and add another")
    }
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const yesNo = (name, fallback) => (given(p[name]) ? (flag(p[name]) ? "Y" : "N") : fallback || "N")
    const templateName = value("templateName", existing?.templateName)
    if (!templateName) denied("NAME_REQUIRED", "Name the template")
    const formFor = (name, fallback) => {
        const formId = value(name, fallback)
        if (formId && formId !== fallback) forms().publishedFormFor(REVIEW_PURPOSE, organizationPartyId, formId)
        return formId
    }
    const values = {
        organizationPartyId,
        templateName,
        description: value("description", existing?.description),
        selfAssessment: yesNo("selfAssessment", existing?.selfAssessment || "Y"),
        feedbackAllowed: yesNo("feedbackAllowed", existing?.feedbackAllowed),
        feedbackReleased: yesNo("feedbackReleased", existing?.feedbackReleased),
        approvalRequired: yesNo("approvalRequired", existing?.approvalRequired),
        selfFormId: formFor("selfFormId", existing?.selfFormId),
        managerFormId: formFor("managerFormId", existing?.managerFormId),
        feedbackFormId: formFor("feedbackFormId", existing?.feedbackFormId)
    }
    let reviewTemplateId = id
    if (existing) call("update#" + TEMPLATE, Object.assign({reviewTemplateId: id}, values))
    else
        reviewTemplateId = call(
            "create#" + TEMPLATE,
            Object.assign(values, {
                fromDate: ec.user.nowTimestamp,
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
        ).reviewTemplateId
    return {reviewTemplateId, revision: stampOf(templateOf(reviewTemplateId))}
}

// A cycle's counts: its reviews by state and their steps done.
function cycleCounts(reviewCycleIds) {
    const counts = {}
    if (!reviewCycleIds.length) return counts
    const reviews = Array.from(
        find(REVIEW)
            .condition("reviewCycleId", "in", reviewCycleIds)
            .selectField(["performanceReviewId", "reviewCycleId", "statusEnumId"])
            .list()
    )
    const steps = reviews.length
        ? Array.from(
              find(STEP)
                  .condition(
                      "performanceReviewId",
                      "in",
                      reviews.map(row => row.performanceReviewId)
                  )
                  .condition("stepKindEnumId", "in", [SELF, MANAGER])
                  .condition("statusEnumId", SUBMITTED)
                  .selectField(["performanceReviewId", "stepKindEnumId"])
                  .list()
          )
        : []
    const cycleOfReview = new Map(reviews.map(row => [row.performanceReviewId, row.reviewCycleId]))
    for (const id of reviewCycleIds)
        counts[id] = {reviewCount: 0, selfDone: 0, managerDone: 0, releasedCount: 0, acknowledgedCount: 0, excludedCount: 0}
    for (const row of reviews) {
        const count = counts[row.reviewCycleId]
        count.reviewCount++
        if (releasedStates.includes(row.statusEnumId)) count.releasedCount++
        if (row.statusEnumId === ACKNOWLEDGED) count.acknowledgedCount++
        if (row.statusEnumId === EXCLUDED) count.excludedCount++
    }
    for (const row of steps) {
        const count = counts[cycleOfReview.get(row.performanceReviewId)]
        if (row.stepKindEnumId === SELF) count.selfDone++
        else count.managerDone++
    }
    return counts
}
function cycleLines(userScope, cycles) {
    if (!cycles.length) return []
    const counts = cycleCounts(cycles.map(row => row.reviewCycleId))
    const organizationNames = people.organizationNames(
        unique(cycles.flatMap(row => [row.organizationPartyId, row.departmentPartyId]).filter(Boolean))
    )
    const templates = new Map(
        Array.from(
            find(TEMPLATE)
                .condition("reviewTemplateId", "in", unique(cycles.map(row => row.reviewTemplateId).filter(Boolean)))
                .list()
        ).map(row => [row.reviewTemplateId, row])
    )
    return cycles.map(row => {
        const count = counts[row.reviewCycleId]
        const template = templates.get(row.reviewTemplateId)
        const developEdit = !!userScope.capabilities.developEdit && userScope.developEmployers.includes(row.organizationPartyId)
        const open = count.reviewCount - count.releasedCount - count.excludedCount
        return Object.assign(
            {
                reviewCycleId: row.reviewCycleId,
                cycleName: row.cycleName || row.reviewCycleId,
                organizationPartyId: row.organizationPartyId,
                organizationName: organizationNames[row.organizationPartyId] || row.organizationPartyId,
                departmentPartyId: row.departmentPartyId || null,
                scopeText: row.departmentPartyId
                    ? organizationNames[row.departmentPartyId] || row.departmentPartyId
                    : organizationNames[row.organizationPartyId] || row.organizationPartyId,
                reviewTemplateId: row.reviewTemplateId,
                templateName: template?.templateName || row.reviewTemplateId || "",
                periodFromDate: dayText(row.periodFromDate),
                periodThruDate: dayText(row.periodThruDate),
                periodText: dayText(row.periodFromDate) + " – " + dayText(row.periodThruDate),
                selfDueDate: dayText(row.selfDueDate),
                managerDueDate: dayText(row.managerDueDate),
                dueText:
                    (row.selfDueDate ? "Self " + dayText(row.selfDueDate) + " · " : "") +
                    (row.managerDueDate ? "Reviewer " + dayText(row.managerDueDate) : ""),
                statusEnumId: row.statusEnumId,
                statusText: cycleTexts[row.statusEnumId] || row.statusEnumId,
                progressText:
                    count.reviewCount === 0
                        ? row.statusEnumId === DRAFT
                            ? "Not started"
                            : "No review"
                        : count.reviewCount +
                          " reviews · " +
                          count.managerDone +
                          " assessed · " +
                          count.releasedCount +
                          " released · " +
                          count.acknowledgedCount +
                          " acknowledged" +
                          (count.excludedCount ? " · " + count.excludedCount + " excluded" : ""),
                openCount: open,
                canChange: developEdit && row.statusEnumId === DRAFT,
                canStart: developEdit && row.statusEnumId !== CLOSED && isCurrent(template),
                canClose: developEdit && row.statusEnumId === ACTIVE,
                revision: stampOf(row)
            },
            count
        )
    })
}
// find#Cycles: the cycles of the employers whose reviews the caller administers (a development reader's; organizationPartyId
// narrows them), by state (open: draft and in progress, the default; closed; all) and name, newest first, paged; each with its
// scope, template, period, due dates, state and counts. With the templates of those employers for a development editor.
function findCycles(p) {
    const userScope = reviewScope()
    const show = text(p.show) || "open"
    if (!["open", "closed", "all"].includes(show)) denied("SHOW_INVALID", "Show one of open, closed or all")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId && !userScope.developEmployers.includes(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    const canSetUp = !!userScope.capabilities.developEdit && userScope.developEmployers.length > 0
    const extra = {canSetUp, templates: canSetUp || userScope.developEmployers.length ? templatesOf(userScope, p) : []}
    if (!userScope.developEmployers.length) return Object.assign(lib.pageList([], p, "cycles"), extra)
    let query = find(CYCLE).condition(
        "organizationPartyId",
        "in",
        organizationPartyId ? [organizationPartyId] : userScope.developEmployers
    )
    if (show === "open") query = query.condition("statusEnumId", "in", [DRAFT, ACTIVE])
    if (show === "closed") query = query.condition("statusEnumId", CLOSED)
    if (text(p.term))
        query = query.condition(
            ec.entity.conditionFactory.makeCondition("cycleName", "like", likeText(text(p.term))).ignoreCase()
        )
    const cycles = Array.from(query.orderBy("-periodThruDate").orderBy("cycleName").limit(listCap).list())
    return Object.assign(lib.pageList(cycleLines(userScope, cycles), p, "cycles"), extra)
}
function templatesOf(userScope, p) {
    if (!userScope.developEmployers.length) return []
    let query = find(TEMPLATE).condition("organizationPartyId", "in", userScope.developEmployers)
    if (!flag(p.includeEnded))
        query = query.condition(
            ec.entity.conditionFactory.makeCondition(
                ec.entity.conditionFactory.makeCondition("thruDate", "is-null", null),
                "or",
                ec.entity.conditionFactory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
            )
        )
    const found = Array.from(query.orderBy("templateName").limit(200).list())
    const organizationNames = people.organizationNames(unique(found.map(row => row.organizationPartyId)))
    return found.map(row => templateLine(row, organizationNames))
}
const cycleOf = reviewCycleId => (text(reviewCycleId) ? one(CYCLE, {reviewCycleId: text(reviewCycleId)}) : null)
// store#Cycle: a draft cycle added (organizationPartyId) or changed (reviewCycleId, at its revision), or a started one closed
// (close, with its reason), by a development editor of its employer: its name, the unit reviewed (and those under it), the
// template (the employer's, not ended), the period and the due dates. Closing needs every review released, acknowledged or
// excluded, unless excludeOpen excludes the open ones with the reason. Refused: no development editor's reach (PERMISSION_DENIED),
// an employer outside it (ORGANIZATION_DENIED), a cycle not in it (RECORD_UNAVAILABLE), no name (NAME_REQUIRED), a unit not the
// employer's (DEPARTMENT_OUTSIDE), no template, another employer's or an ended one (TEMPLATE_INVALID), a period or a due date out
// of order (DATES_INVALID), a change of a started cycle (CYCLE_STARTED), a close of a draft or closed one (NOT_ACTIVE), a close
// with reviews open (REVIEWS_OPEN), a close with no reason (REASON_REQUIRED), a revision other than the one read (REVISION_CHANGED).
function storeCycle(p) {
    const userScope = reviewScope()
    requireDevelopEdit(userScope, null)
    const id = text(p.reviewCycleId)
    const existing = id ? cycleOf(id) : null
    if (id && (!existing || !userScope.developEmployers.includes(existing.organizationPartyId)))
        denied("RECORD_UNAVAILABLE", "Review cycle " + id + " is not available")
    if (existing && text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(existing))
        denied("REVISION_CHANGED", "This cycle changed since you read it; open it again (revision " + stampOf(existing) + ")")
    if (existing && flag(p.close)) return closeCycle(userScope, existing, p)
    if (existing && existing.statusEnumId !== DRAFT) denied("CYCLE_STARTED", "A started cycle is not changed")
    const organizationPartyId = existing ? existing.organizationPartyId : text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    requireDevelopEdit(userScope, organizationPartyId)
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const cycleName = value("cycleName", existing?.cycleName)
    if (!cycleName) denied("NAME_REQUIRED", "Name the cycle")
    const departmentPartyId = value("departmentPartyId", existing?.departmentPartyId)
    if (departmentPartyId && !people.unitsUnder([organizationPartyId]).includes(departmentPartyId))
        denied("DEPARTMENT_OUTSIDE", "The unit is not one of the employer's")
    const reviewTemplateId = value("reviewTemplateId", existing?.reviewTemplateId)
    const template = templateOf(reviewTemplateId)
    if (!template || template.organizationPartyId !== organizationPartyId || !isCurrent(template))
        denied("TEMPLATE_INVALID", "Choose a template of the employer that has not ended")
    const day = (name, fallback, what) => (given(p[name]) ? dayOf(p[name], what) : fallback ? dayText(fallback) : null)
    const periodFromDate = day("periodFromDate", existing?.periodFromDate, "the period's start")
    const periodThruDate = day("periodThruDate", existing?.periodThruDate, "the period's end")
    const selfDueDate = day("selfDueDate", existing?.selfDueDate, "the self assessment's due date")
    const managerDueDate = day("managerDueDate", existing?.managerDueDate, "the reviewer's due date")
    if (!periodFromDate || !periodThruDate || periodThruDate < periodFromDate)
        denied("DATES_INVALID", "The period starts on or before it ends")
    if (selfDueDate && managerDueDate && managerDueDate < selfDueDate)
        denied("DATES_INVALID", "The reviewer's assessment is due on or after the self assessment")
    const values = {
        organizationPartyId,
        departmentPartyId,
        cycleName,
        reviewTemplateId,
        periodFromDate,
        periodThruDate,
        selfDueDate,
        managerDueDate
    }
    let reviewCycleId = id
    if (existing) call("update#" + CYCLE, Object.assign({reviewCycleId: id}, values))
    else
        reviewCycleId = call(
            "create#" + CYCLE,
            Object.assign(values, {
                statusEnumId: DRAFT,
                statusEnumId_changeReason: "Set up",
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
        ).reviewCycleId
    return {reviewCycleId, revision: stampOf(cycleOf(reviewCycleId))}
}
function closeCycle(userScope, cycle, p) {
    if (cycle.statusEnumId !== ACTIVE) denied("NOT_ACTIVE", "Only a cycle in progress is closed")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the cycle closes")
    const open = rows(REVIEW, {reviewCycleId: cycle.reviewCycleId}).filter(row => openStates.includes(row.statusEnumId))
    if (open.length && !flag(p.excludeOpen))
        denied("REVIEWS_OPEN", open.length + " reviews are not released yet; release or exclude them first")
    for (const review of open) excludeReview(review, "Cycle closed: " + reason)
    call("update#" + CYCLE, {
        reviewCycleId: cycle.reviewCycleId,
        statusEnumId: CLOSED,
        statusEnumId_changeReason: reason,
        closedDate: ec.user.nowTimestamp,
        closeReason: reason
    })
    return {reviewCycleId: cycle.reviewCycleId, excludedCount: open.length, revision: stampOf(cycleOf(cycle.reviewCycleId))}
}

// ===== start#Cycle =====
// The people a cycle reviews now: the current employees of its employer, in its unit and the units under it when it names one,
// each once by their current employment there, with their department and the manager of the employment's live line.
function participantsOf(cycle) {
    const at = nowMs()
    const employments = Array.from(
        people.current(people.employmentFind().condition("toPartyId", cycle.organizationPartyId), at).limit(peopleCap).list()
    )
    const partyIds = unique(employments.map(row => row.fromPartyId))
    const assigned = people.assignmentsAt(partyIds, at)
    const units = cycle.departmentPartyId ? [cycle.departmentPartyId].concat(people.unitsUnder([cycle.departmentPartyId])) : null
    const managers = people.managersByEmployment(partyIds, at)
    const names = people.personNames(partyIds.concat(Object.values(managers).flat()))
    const seen = new Set()
    const found = []
    for (const employment of employments) {
        if (seen.has(employment.fromPartyId)) continue
        const assignment = assigned[cycle.organizationPartyId + "/" + employment.fromPartyId]
        if (units && !units.includes(assignment?.departmentPartyId)) continue
        seen.add(employment.fromPartyId)
        const managerPartyId =
            (managers[cycle.organizationPartyId + "/" + employment.fromPartyId] || []).find(
                partyId => partyId !== employment.fromPartyId
            ) || null
        found.push({
            partyId: employment.fromPartyId,
            personName: names[employment.fromPartyId] || employment.fromPartyId,
            partyRelationshipId: employment.partyRelationshipId,
            departmentPartyId: assignment?.departmentPartyId || null,
            managerPartyId,
            managerName: managerPartyId ? names[managerPartyId] || managerPartyId : ""
        })
    }
    return found.sort((a, b) => a.personName.localeCompare(b.personName))
}
// start#Cycle: a draft or started cycle (at its revision) started, by a development editor of its employer: one review for each
// person in scope who has none in it yet, each in its own transaction, with the person's self assessment (when the template asks
// for one) and the reviewer's assessment, each due on the cycle's day and on the template's form, the person and the reviewer told
// (PeopleReviewUpdate). A person with no reviewer (no live reporting line at the employer) is named and left out (NO_REVIEWER); a
// failure of one person is named and the rest go on. preview answers the people and their reviewers and changes nothing. Refused: no
// development editor's reach (PERMISSION_DENIED), a cycle not in it (RECORD_UNAVAILABLE), a closed one (CYCLE_CLOSED), an ended
// template (TEMPLATE_INVALID), a revision other than the one read (REVISION_CHANGED).
function startCycle(p) {
    const userScope = reviewScope()
    requireDevelopEdit(userScope, null)
    const cycle = cycleOf(p.reviewCycleId)
    if (!cycle || !userScope.developEmployers.includes(cycle.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Review cycle " + text(p.reviewCycleId) + " is not available")
    requireDevelopEdit(userScope, cycle.organizationPartyId)
    if (cycle.statusEnumId === CLOSED) denied("CYCLE_CLOSED", "A closed cycle starts no review")
    if (text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(cycle))
        denied("REVISION_CHANGED", "This cycle changed since you read it; open it again (revision " + stampOf(cycle) + ")")
    const template = templateOf(cycle.reviewTemplateId)
    if (!template || !isCurrent(template)) denied("TEMPLATE_INVALID", "The cycle's template has ended")
    const reviewed = new Set(
        Array.from(find(REVIEW).condition("reviewCycleId", cycle.reviewCycleId).selectField("partyId").list()).map(
            row => row.partyId
        )
    )
    const participants = participantsOf(cycle).map(row =>
        Object.assign(row, {
            alreadyReviewed: reviewed.has(row.partyId),
            problem: reviewed.has(row.partyId) ? "" : row.managerPartyId ? "" : "No manager to review them"
        })
    )
    if (flag(p.preview)) return {participants, startedCount: 0, failedCount: 0, failures: [], reviewCycleId: cycle.reviewCycleId}
    const started = []
    const failures = []
    for (const participant of participants.filter(row => !row.alreadyReviewed)) {
        ec.message.pushErrors()
        let performanceReviewId = null
        try {
            if (!participant.managerPartyId) denied("NO_REVIEWER", "No manager to review them; set their reporting line first")
            ec.transaction.runRequireNew(null, "Starting the review of " + participant.partyId + " failed", () => {
                performanceReviewId = startReview(cycle, template, participant)
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            })
            started.push(performanceReviewId)
        } catch (error) {
            const code = lib.reasonCode(error)
            if (!code) ec.logger.error("The review of " + participant.partyId + " was not started: " + error.message)
            failures.push({
                partyId: participant.partyId,
                personName: participant.personName,
                code: code || "FAILED",
                message: String(error.message || error)
                    .replace(/^Error: /, "")
                    .replace(/^[A-Z][A-Z0-9_]+: /, "")
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    if (cycle.statusEnumId === DRAFT)
        call("update#" + CYCLE, {
            reviewCycleId: cycle.reviewCycleId,
            statusEnumId: ACTIVE,
            statusEnumId_changeReason: "Started",
            startedDate: ec.user.nowTimestamp
        })
    return {
        reviewCycleId: cycle.reviewCycleId,
        participants,
        startedCount: started.length,
        startedIds: started,
        failedCount: failures.length,
        failures
    }
}
function startReview(cycle, template, participant) {
    const now = ec.user.nowTimestamp
    const performanceReviewId = call("create#" + REVIEW, {
        reviewCycleId: cycle.reviewCycleId,
        partyId: participant.partyId,
        partyRelationshipId: participant.partyRelationshipId,
        organizationPartyId: cycle.organizationPartyId,
        departmentPartyId: participant.departmentPartyId,
        managerPartyId: participant.managerPartyId,
        managerPartyId_changeReason: "The manager when the cycle started",
        statusEnumId: IN_PROGRESS,
        statusEnumId_changeReason: "Cycle started",
        createdDate: now
    }).performanceReviewId
    if (template.selfAssessment === "Y")
        call("create#" + STEP, {
            performanceReviewId,
            stepKindEnumId: SELF,
            partyId: participant.partyId,
            statusEnumId: WAITING,
            statusEnumId_changeReason: "Cycle started",
            dueDate: cycle.selfDueDate || null,
            formId: template.selfFormId || null,
            requestedDate: now
        })
    call("create#" + STEP, {
        performanceReviewId,
        stepKindEnumId: MANAGER,
        partyId: participant.managerPartyId,
        statusEnumId: WAITING,
        statusEnumId_changeReason: "Cycle started",
        dueDate: cycle.managerDueDate || null,
        formId: template.managerFormId || null,
        requestedDate: now
    })
    const cycleName = cycle.cycleName || cycle.reviewCycleId
    if (template.selfAssessment === "Y")
        tell(
            [participant.partyId],
            performanceReviewId,
            "Your self assessment for " +
                cycleName +
                (cycle.selfDueDate ? " is due " + dayText(cycle.selfDueDate) : " waits for you")
        )
    tell(
        [participant.managerPartyId],
        performanceReviewId,
        "A review for " +
            cycleName +
            " waits for your assessment" +
            (cycle.managerDueDate ? ", by " + dayText(cycle.managerDueDate) : "")
    )
    return performanceReviewId
}

// ===== notices =====
// The enabled accounts of the parties.
function userIdsOf(partyIds) {
    const ids = unique(partyIds.filter(Boolean))
    if (!ids.length) return []
    return unique(
        Array.from(find("moqui.security.UserAccount").condition("partyId", "in", ids).list())
            .filter(row => row.disabled !== "Y")
            .map(row => row.userId)
    )
}
// A review notice (PeopleReviewUpdate) to the parties' accounts but the caller's, and to them alone (directOnly: a subscription to
// every message of the topic, set in Tools, receives none; People follow-up 1): the sentence alone, naming the cycle and a date,
// never the person reviewed (a lock-screen-safe title, design §1.4), a rating, an answer or a note. A failure is logged and the
// change stays.
function tell(partyIds, performanceReviewId, noticeText) {
    try {
        const userIds = userIdsOf(partyIds).filter(userId => userId !== ec.user.userId)
        if (!userIds.length) return
        ec.makeNotificationMessage()
            .topic("PeopleReviewUpdate")
            .message({performanceReviewId, noticeText})
            .record(REVIEW, performanceReviewId)
            .userIds(userIds)
            .directOnly()
            .send()
    } catch (error) {
        ec.logger.error("Review notice of " + performanceReviewId + " was not sent: " + error.message)
    }
}

// ===== reviews as lines =====
function reviewLines(userScope, reviews, todoMap = {}) {
    if (!reviews.length) return []
    const ids = reviews.map(row => row.performanceReviewId)
    const steps = Array.from(find(STEP).condition("performanceReviewId", "in", ids).list())
    const cycles = new Map(
        Array.from(
            find(CYCLE)
                .condition("reviewCycleId", "in", unique(reviews.map(row => row.reviewCycleId)))
                .list()
        ).map(row => [row.reviewCycleId, row])
    )
    const names = people.personNames(unique(reviews.flatMap(row => [row.partyId, row.managerPartyId]).filter(Boolean)))
    const organizationNames = people.organizationNames(unique(reviews.map(row => row.organizationPartyId)))
    return reviews.map(review => {
        const ofReview = steps.filter(step => step.performanceReviewId === review.performanceReviewId)
        const selfStep = ofReview.find(step => step.stepKindEnumId === SELF)
        const managerStep = ofReview.find(step => step.stepKindEnumId === MANAGER)
        const feedback = ofReview.filter(step => step.stepKindEnumId === FEEDBACK && step.statusEnumId !== CANCELLED)
        const cycle = cycles.get(review.reviewCycleId)
        const self = review.partyId === userScope.partyId
        const due = [selfStep, managerStep]
            .filter(step => step?.statusEnumId === WAITING && step.dueDate)
            .map(step => dayText(step.dueDate))
            .sort()[0]
        return {
            performanceReviewId: review.performanceReviewId,
            reviewCycleId: review.reviewCycleId,
            cycleName: cycle?.cycleName || review.reviewCycleId,
            periodText: cycle ? dayText(cycle.periodFromDate) + " – " + dayText(cycle.periodThruDate) : "",
            partyId: review.partyId,
            personName: names[review.partyId] || review.partyId,
            organizationName: organizationNames[review.organizationPartyId] || review.organizationPartyId,
            reviewerName: review.managerPartyId ? names[review.managerPartyId] || review.managerPartyId : "No reviewer",
            selfStateText: selfStep ? stepTexts[selfStep.statusEnumId] || selfStep.statusEnumId : "Not asked",
            managerStateText: managerStep ? stepTexts[managerStep.statusEnumId] || managerStep.statusEnumId : "",
            // the person is not told who was asked for feedback before release
            feedbackText: self
                ? ""
                : feedback.length
                  ? feedback.filter(step => step.statusEnumId === SUBMITTED).length + " of " + feedback.length
                  : "",
            dueText: due || "",
            statusEnumId: review.statusEnumId,
            statusText: reviewTexts[review.statusEnumId] || review.statusEnumId,
            todoText: todoMap[review.performanceReviewId] || "",
            isOwn: self
        }
    })
}
// What the caller has to do on each review: their step waiting, a decision, a release, an acknowledgment.
function todoOf(userScope) {
    const todo = {}
    const partyId = userScope.partyId
    if (!partyId) return todo
    const add = (id, line) => {
        if (!todo[id]) todo[id] = line
    }
    const waiting = Array.from(find(STEP).condition({partyId, statusEnumId: WAITING}).limit(listCap).list())
    const reviews = new Map(
        waiting.length
            ? Array.from(
                  find(REVIEW)
                      .condition("performanceReviewId", "in", unique(waiting.map(row => row.performanceReviewId)))
                      .list()
              ).map(row => [row.performanceReviewId, row])
            : []
    )
    for (const step of waiting) {
        const review = reviews.get(step.performanceReviewId)
        if (!review || review.statusEnumId !== IN_PROGRESS) continue
        if (step.stepKindEnumId === MANAGER && !userScope.workEmployers.includes(review.organizationPartyId)) continue
        add(
            review.performanceReviewId,
            step.stepKindEnumId === SELF ? "Your self assessment" : step.stepKindEnumId === MANAGER ? "Assess" : "Give feedback"
        )
    }
    for (const review of rows(REVIEW, {managerPartyId: partyId, statusEnumId: FINALIZED}))
        if (userScope.workEmployers.includes(review.organizationPartyId)) add(review.performanceReviewId, "Release")
    for (const review of rows(REVIEW, {partyId, statusEnumId: RELEASED})) add(review.performanceReviewId, "Acknowledge")
    for (const line of approvals()
        .waitingFor(200)
        .filter(row => row.approvalKindEnumId === approvalKind))
        add(line.sourceId, "Approve")
    return todo
}
// find#Reviews: the reviews the caller reads, by what they do: todo (the default: their step waiting, a decision, a release or an
// acknowledgment), mine (their own reviews), team (those they review), all (a development reader's employers'), or a person's
// (partyId, for Employee360: their own, those they review and a development reader's of the employer, never a giver's or an
// approver's); reviewCycleId and term (the person's name) narrow them. Paged; each with the person, the cycle and period, the
// reviewer, the steps' states (the person sees nobody asked for feedback), the earliest due date and the state, never a rating but
// a person's released result (resultText: the overall rating once released, to the person, its reviewer and development). Refused:
// a show that is not one (SHOW_INVALID).
function findReviews(p) {
    const userScope = reviewScope()
    const partyIdWanted = text(p.partyId)
    const show = partyIdWanted ? "person" : text(p.show) || "todo"
    if (!["todo", "mine", "team", "all", "person"].includes(show)) denied("SHOW_INVALID", "Show one of todo, mine, team or all")
    const todo = todoOf(userScope)
    let reviews = []
    const partyId = userScope.partyId
    if (show === "todo") {
        const ids = Object.keys(todo)
        reviews = ids.length ? Array.from(find(REVIEW).condition("performanceReviewId", "in", ids).list()) : []
    } else if (show === "mine") reviews = partyId ? rows(REVIEW, {partyId}) : []
    else if (show === "team")
        reviews = partyId
            ? rows(REVIEW, {managerPartyId: partyId}).filter(row => userScope.workEmployers.includes(row.organizationPartyId))
            : []
    else if (show === "person")
        // a person's reviews as the caller reads them in their own right (the person, the reviewer, development), each checked
        reviews = rows(REVIEW, {partyId: partyIdWanted}).filter(review => {
            const access = accessOf(userScope, review)
            return access.self || access.reviewer || access.develop
        })
    else if (userScope.developEmployers.length) {
        let query = find(REVIEW).condition("organizationPartyId", "in", userScope.developEmployers)
        if (partyId) query = query.condition("partyId", "not-equals", partyId)
        reviews = Array.from(query.limit(listCap).list())
    }
    if (text(p.reviewCycleId)) reviews = reviews.filter(row => row.reviewCycleId === text(p.reviewCycleId))
    let lines = reviewLines(userScope, reviews, todo)
    if (show === "person") {
        // the released result alone (every reader here reads the rating once released)
        const ratings = enumNames(reviews.map(row => row.ratingEnumId))
        const byId = new Map(reviews.map(row => [row.performanceReviewId, row]))
        lines = lines.map(line => {
            const review = byId.get(line.performanceReviewId)
            const released = releasedStates.includes(review.statusEnumId)
            return Object.assign(line, {
                resultText: released && review.ratingEnumId ? ratings[review.ratingEnumId] || "" : "",
                releasedText: released ? dateText(review.releasedDate) : ""
            })
        })
    }
    if (text(p.term)) {
        const term = text(p.term).toLowerCase()
        lines = lines.filter(line => line.personName.toLowerCase().includes(term))
    }
    lines.sort((a, b) => (a.dueText || "9999").localeCompare(b.dueText || "9999") || a.personName.localeCompare(b.personName))
    return Object.assign(lib.pageList(lines, p, "reviews"), {
        todoCount: Object.keys(todo).length,
        canSeeAll: userScope.developEmployers.length > 0
    })
}

// ===== get#Review =====
function answersOfStep(step) {
    if (!step.formResponseId) return []
    const response = one("moqui.screen.form.FormResponse", {formResponseId: step.formResponseId})
    const responseMap = {}
    for (const answer of rows("moqui.screen.form.FormResponseAnswer", {formResponseId: step.formResponseId}))
        responseMap[answer.fieldName] = answer.valueText
    return response ? forms().answersOf(step.formId, response.responseDate, responseMap) : []
}
function stepLine(step, review, access, template, names, ratings, userScope) {
    const reads = readsStep(access, step, review, template)
    const own = !!userScope.partyId && step.partyId === userScope.partyId
    const answers = reads && step.statusEnumId === SUBMITTED ? answersOfStep(step) : []
    return {
        performanceReviewStepId: step.performanceReviewStepId,
        stepKindEnumId: step.stepKindEnumId,
        kindText: kindTexts[step.stepKindEnumId] || step.stepKindEnumId,
        partyId: step.partyId || null,
        assigneeName: step.partyId ? names[step.partyId] || step.partyId : "No reviewer yet",
        statusEnumId: step.statusEnumId,
        statusText: stepTexts[step.statusEnumId] || step.statusEnumId,
        dueText: dayText(step.dueDate),
        submittedText: dateText(step.submittedDate),
        readable: reads,
        summary: reads ? step.summary || "" : null,
        ratingText: reads && step.ratingEnumId ? ratings[step.ratingEnumId] || step.ratingEnumId : "",
        answers: reads ? answers : [],
        answersText: reads ? answers.map(answer => answer.title + ": " + answer.displayText).join("; ") : "",
        // why a step was returned (by the reviewer, development or an approver's refusal) is the full readers' and its assignee's;
        // the person reading the released assessment is not shown the discussion that led to it
        returnReason: access.full || own ? step.returnReason || "" : "",
        cancelReason: access.full ? step.cancelReason || "" : "",
        formId: step.formId || null,
        isOwn: own,
        revision: stampOf(step)
    }
}
// A review as the caller reads it: its header (the person, the cycle and period, the employer, the reviewer, the state and, for whom
// reads the reviewer's assessment, the overall rating), the steps they see with the content they read, the caller's own private
// notes (never another's), the approval while it waits, the release and acknowledgment, and what the caller may do.
function getReview(p) {
    const userScope = reviewScope()
    const {review, steps, access} = readableReview(userScope, p.performanceReviewId)
    const cycle = cycleOf(review.reviewCycleId)
    const template = templateOf(cycle?.reviewTemplateId)
    const names = people.personNames(
        unique(
            steps
                .map(row => row.partyId)
                .concat([review.partyId, review.managerPartyId])
                .filter(Boolean)
        )
    )
    const ratings = enumNames(steps.map(row => row.ratingEnumId).concat([review.ratingEnumId]))
    const organizationNames = people.organizationNames([review.organizationPartyId, review.departmentPartyId].filter(Boolean))
    const kindOrder = {[SELF]: 1, [MANAGER]: 2, [FEEDBACK]: 3}
    const visible = steps
        .filter(step => seesStep(access, step, review, template))
        .sort(
            (a, b) =>
                kindOrder[a.stepKindEnumId] - kindOrder[b.stepKindEnumId] ||
                (ms(a.requestedDate) ?? 0) - (ms(b.requestedDate) ?? 0)
        )
        .map(step => stepLine(step, review, access, template, names, ratings, userScope))
    const managerStep = steps.find(step => step.stepKindEnumId === MANAGER)
    const selfStep = steps.find(step => step.stepKindEnumId === SELF)
    const waitingFeedback = steps.filter(step => step.stepKindEnumId === FEEDBACK && step.statusEnumId === WAITING)
    const inProgress = review.statusEnumId === IN_PROGRESS
    const readsRating = access.full || (access.self && access.released)
    const notes = userScope.partyId
        ? rows(NOTE, {performanceReviewId: review.performanceReviewId, authorPartyId: userScope.partyId})
              .sort((a, b) => (ms(b.noteDate) ?? 0) - (ms(a.noteDate) ?? 0))
              .map(row => ({
                  performanceNoteId: row.performanceNoteId,
                  noteText: row.noteText || "",
                  noteDateText: dateText(row.noteDate),
                  revision: stampOf(row)
              }))
        : []
    // the approval (its approvers, decisions and reasons) is the full readers'; the person sees the review's state alone
    const summary = access.full ? access.summary : null
    const waitingOwn = steps.find(
        step =>
            !!userScope.partyId &&
            step.partyId === userScope.partyId &&
            step.statusEnumId === WAITING &&
            (step.stepKindEnumId !== MANAGER || access.reviewer)
    )
    const ownWaiting = waitingOwn && inProgress ? waitingOwn : null
    return {
        review: {
            performanceReviewId: review.performanceReviewId,
            reviewCycleId: review.reviewCycleId,
            cycleName: cycle?.cycleName || review.reviewCycleId,
            periodText: cycle ? dayText(cycle.periodFromDate) + " – " + dayText(cycle.periodThruDate) : "",
            partyId: review.partyId,
            personName: names[review.partyId] || review.partyId,
            organizationPartyId: review.organizationPartyId,
            organizationName: organizationNames[review.organizationPartyId] || review.organizationPartyId,
            departmentName: review.departmentPartyId ? organizationNames[review.departmentPartyId] || "" : "",
            managerPartyId: review.managerPartyId || null,
            reviewerName: review.managerPartyId ? names[review.managerPartyId] || review.managerPartyId : "No reviewer yet",
            statusEnumId: review.statusEnumId,
            statusText: reviewTexts[review.statusEnumId] || review.statusEnumId,
            ratingText: readsRating && review.ratingEnumId ? ratings[review.ratingEnumId] || review.ratingEnumId : "",
            templateName: template?.templateName || "",
            feedbackAllowed: template?.feedbackAllowed === "Y",
            feedbackReleased: template?.feedbackReleased === "Y",
            approvalRequired: template?.approvalRequired === "Y",
            finalizedText: dateText(review.finalizedDate),
            releasedText: dateText(review.releasedDate),
            acknowledgedText: dateText(review.acknowledgedDate),
            acknowledgementComment: access.self || access.full ? review.acknowledgementComment || "" : "",
            excludedReason: access.full || access.self ? review.excludedReason || "" : "",
            hasRelease: !!review.releaseHtmlLocation && (access.self || access.reviewer || access.develop),
            hasReleasePdf: !!review.releaseLocation && (access.self || access.reviewer || access.develop),
            revision: stampOf(review)
        },
        steps: visible,
        notes,
        approval: summary
            ? {
                  waiting: !!summary.waiting,
                  statusText: summary.statusText,
                  waitingText: summary.waitingText,
                  peopleApprovalId: summary.waiting ? summary.peopleApprovalId : null,
                  sourceRevision: summary.waiting ? summary.sourceRevision : null,
                  decisions: summary.decisions
              }
            : null,
        isSelf: access.self,
        isReviewer: access.reviewer,
        isDevelop: access.develop,
        isApprover: access.approver,
        ownStepId: ownWaiting?.performanceReviewStepId || null,
        ownStepKindEnumId: ownWaiting?.stepKindEnumId || null,
        ownFormId: ownWaiting?.formId || null,
        canAssess: !!ownWaiting && ownWaiting.stepKindEnumId !== FEEDBACK,
        canGiveFeedback: !!ownWaiting && ownWaiting.stepKindEnumId === FEEDBACK,
        canRequestFeedback: access.reviewer && inProgress && template?.feedbackAllowed === "Y",
        canReturnSelf: (access.reviewer || access.developEdit) && inProgress && selfStep?.statusEnumId === SUBMITTED,
        canReturnManager: access.developEdit && inProgress && managerStep?.statusEnumId === SUBMITTED,
        canFinalize:
            access.reviewer &&
            inProgress &&
            managerStep?.statusEnumId === SUBMITTED &&
            selfStep?.statusEnumId !== WAITING &&
            !waitingFeedback.length,
        canDecide: !!summary?.canDecide && !access.reviewer,
        canRelease: (access.reviewer || access.developEdit) && review.statusEnumId === FINALIZED,
        canAcknowledge: access.self && review.statusEnumId === RELEASED,
        canExclude: access.developEdit && openStates.includes(review.statusEnumId),
        canReassign: access.developEdit && openStates.includes(review.statusEnumId),
        canNote: access.reviewer && !releasedStates.includes(review.statusEnumId) && review.statusEnumId !== EXCLUDED,
        canAddFiles: access.reviewer || access.developEdit,
        asOfText: dateText(ec.user.nowTimestamp)
    }
}

// ===== store#Assessment and submit#Feedback =====
// The caller's own waiting step of the kinds asked for, the review in progress, under the review's lock.
function ownStep(userScope, p, kinds) {
    const read = readableReview(userScope, p.performanceReviewId)
    const review = find(REVIEW, {performanceReviewId: read.review.performanceReviewId}).forUpdate(true).one()
    const partyId = userScope.partyId
    const candidates = stepsOf(review.performanceReviewId).filter(
        step => kinds.includes(step.stepKindEnumId) && step.partyId === partyId && step.statusEnumId !== CANCELLED
    )
    let step = text(p.performanceReviewStepId)
        ? candidates.find(row => row.performanceReviewStepId === text(p.performanceReviewStepId))
        : candidates.find(row => row.statusEnumId === WAITING) || candidates[0]
    if (!step) denied("NOT_ASSIGNED", "No step of this review waits for you")
    if (step.stepKindEnumId === MANAGER && !read.access.reviewer) denied("NOT_ASSIGNED", "You no longer review this person")
    if (step.statusEnumId === SUBMITTED) denied("ALREADY_SUBMITTED", "You submitted it " + dateText(step.submittedDate))
    if (review.statusEnumId !== IN_PROGRESS)
        denied("REVIEW_CLOSED", "This review is " + reviewTexts[review.statusEnumId].toLowerCase())
    return {review, step, access: read.access}
}
// A step answered and locked: the form's answers (a FormResponse its FormInvitation locks, naming the person, the respondent and
// the review), the summary and, for the reviewer, the rating.
function submitStep(review, step, p, userScope, ratingAllowed) {
    const values = typeof p.values === "string" ? lib.json(p.values, {}) : Object.assign({}, p.values || {})
    const summary = text(p.summary) || null
    const ratingEnumId = ratingAllowed ? enumOf(p.ratingEnumId, RATING_TYPE, "rating") : null
    const now = ec.user.nowTimestamp
    let formResponseId = null
    let invitationId = null
    if (step.formId) {
        if (!Object.keys(values).length) denied("ASSESSMENT_REQUIRED", "Answer the review form")
        formResponseId = forms().recordAnswer(step.formId, values)
        invitationId = call("create#" + INVITATION, {
            formId: step.formId,
            organizationPartyId: review.organizationPartyId,
            partyId: review.partyId,
            contactPartyId: userScope.partyId,
            contextEntityName: REVIEW,
            contextId: review.performanceReviewId,
            recordEntityName: STEP,
            recordId: step.performanceReviewStepId,
            invitationKey: "review:" + step.performanceReviewStepId + ":" + (ms(now) ?? 0),
            statusEnumId: "FinResponded",
            formResponseId,
            responseDate: now,
            createdDate: now
        }).invitationId
    } else if (!summary) denied("ASSESSMENT_REQUIRED", "Write the assessment")
    call("update#" + STEP, {
        performanceReviewStepId: step.performanceReviewStepId,
        statusEnumId: SUBMITTED,
        statusEnumId_changeReason: "Submitted",
        summary,
        ratingEnumId,
        formResponseId,
        invitationId,
        submittedDate: now,
        submittedByUserId: ec.user.userId
    })
    if (step.stepKindEnumId === MANAGER) call("update#" + REVIEW, {performanceReviewId: review.performanceReviewId, ratingEnumId})
    return {
        performanceReviewId: review.performanceReviewId,
        performanceReviewStepId: step.performanceReviewStepId,
        statusEnumId: SUBMITTED
    }
}
// store#Assessment: the caller's own self assessment (the person) or reviewer's assessment (the reviewer, while they work for the
// employer) of a review in progress, answered and locked: the step's review form (values; FORM_VALUES_INVALID), the summary and the
// reviewer's overall rating. Refused: a review not in reach (RECORD_UNAVAILABLE), no step of theirs (NOT_ASSIGNED), one submitted
// (ALREADY_SUBMITTED), a review not in progress (REVIEW_CLOSED), no answers or summary (ASSESSMENT_REQUIRED), a rating that is not
// one (VALUE_INVALID).
function storeAssessment(p) {
    const userScope = reviewScope()
    const {review, step} = ownStep(userScope, p, [SELF, MANAGER])
    return submitStep(review, step, p, userScope, step.stepKindEnumId === MANAGER)
}
// submit#Feedback: the caller's own feedback on a review in progress, answered once on the template's feedback form (or as a
// summary) and locked. Refused as store#Assessment.
function submitFeedback(p) {
    const userScope = reviewScope()
    const {review, step} = ownStep(userScope, p, [FEEDBACK])
    return submitStep(review, step, p, userScope, false)
}

// ===== change#ReviewState =====
// A review's state changed by one who may, under the review's lock and at the revision read (expectedRevision):
// - requestFeedback (the reviewer, the template allowing it): a colleague working for the employer (partyId; never the person, the
//   reviewer or one already asked) is asked for feedback, due dueDate, and told;
// - cancelFeedback (the reviewer or a development editor): a waiting feedback step withdrawn, with the reason;
// - return (the reviewer or a development editor the self assessment; a development editor the reviewer's): a submitted step waits
//   again, with the reason, its assignee told;
// - finalize (the reviewer): the reviewer's assessment submitted, the self assessment not waiting and no feedback waiting; when the
//   template asks for approval it waits for a People approval of kind PakReview, else it is finalized;
// - approve, refuse (an approver of the step waiting, through PeopleApprovalServices.record#Decision at the review's revision; a
//   refusal needs its reason): the last approval finalizes it, a refusal returns the reviewer's assessment to them;
// - release (the reviewer or a development editor of a finalized review): the employee-visible review rendered once and stored (its
//   page and PDF), the person told;
// - acknowledge (the person, of a released review, with an optional comment);
// - reassign (a development editor): the reviewer changed to a person working for the employer (partyId), never the person, with
//   the reason, audit-logged; their waiting assessment goes with it and the new reviewer reads the feedback on the review (it
//   belongs to the review); an earlier reviewer's private notes stay theirs;
// - exclude (a development editor, with the reason): an open review closed, its waiting steps cancelled, its approval superseded.
// One who reads nothing of the review is answered as for a missing one (RECORD_UNAVAILABLE). Refused: PERMISSION_DENIED (not theirs
// to do), SELF_APPROVAL (an action on their own review the person may not take), ACTION_INVALID, REVIEW_CLOSED (not in the state
// the action needs), REASON_REQUIRED, FEEDBACK_NOT_ALLOWED, NOT_EMPLOYED, ALREADY_ASKED, STEP_INVALID, SELF_WAITING,
// FEEDBACK_WAITING, NOT_SUBMITTED, REVISION_CHANGED; and as record#Decision refuses.
function changeReviewState(p) {
    const userScope = reviewScope()
    const action = text(p.action)
    const actions = {
        requestFeedback,
        cancelFeedback,
        returnStep,
        finalize,
        approve,
        refuse,
        release,
        acknowledge,
        reassign,
        exclude
    }
    const named = action === "return" ? "returnStep" : action
    if (!Object.hasOwn(actions, named)) denied("ACTION_INVALID", "Not a review action: " + action)
    const read = readableReview(userScope, p.performanceReviewId)
    const review = find(REVIEW, {performanceReviewId: read.review.performanceReviewId}).forUpdate(true).one()
    const access = accessOf(userScope, review)
    if (text(p.expectedRevision) && !["approve", "refuse"].includes(action) && text(p.expectedRevision) !== stampOf(review))
        denied("REVISION_CHANGED", "This review changed since you read it; open it again (revision " + stampOf(review) + ")")
    const result = actions[named]({userScope, review, access, p, reason: text(p.reason) || null})
    const after = reviewOf(review.performanceReviewId)
    return Object.assign(
        {
            performanceReviewId: after.performanceReviewId,
            statusEnumId: after.statusEnumId,
            statusText: reviewTexts[after.statusEnumId] || after.statusEnumId,
            revision: stampOf(after),
            repeated: false
        },
        result || {}
    )
}
const requireState = (review, states, what) => {
    if (!states.includes(review.statusEnumId))
        denied("REVIEW_CLOSED", what + ": this review is " + (reviewTexts[review.statusEnumId] || "").toLowerCase())
}
const personName = partyId => people.personNames([partyId])[partyId] || partyId
const cycleNameOf = review => cycleOf(review.reviewCycleId)?.cycleName || review.reviewCycleId
function requestFeedback({userScope, review, access, p}) {
    if (!access.reviewer) denied("PERMISSION_DENIED", "The reviewer asks for feedback")
    requireState(review, [IN_PROGRESS], "Feedback is asked for while assessing")
    const template = templateOf(cycleOf(review.reviewCycleId)?.reviewTemplateId)
    if (template?.feedbackAllowed !== "Y") denied("FEEDBACK_NOT_ALLOWED", "This review asks for no feedback")
    const partyId = text(p.partyId)
    if (!partyId || partyId === review.partyId || partyId === review.managerPartyId)
        denied("PARTY_INVALID", "Ask a colleague other than the person and their reviewer")
    if (!worksFor(partyId).includes(review.organizationPartyId)) denied("NOT_EMPLOYED", "They do not work for the employer")
    if (
        stepsOf(review.performanceReviewId).some(
            step => step.stepKindEnumId === FEEDBACK && step.partyId === partyId && step.statusEnumId !== CANCELLED
        )
    )
        denied("ALREADY_ASKED", "They were already asked")
    const dueDate = dayOf(p.dueDate, "the due date")
    const created = call("create#" + STEP, {
        performanceReviewId: review.performanceReviewId,
        stepKindEnumId: FEEDBACK,
        partyId,
        statusEnumId: WAITING,
        statusEnumId_changeReason: "Feedback asked for",
        dueDate,
        formId: template.feedbackFormId || null,
        requestedByPartyId: userScope.partyId,
        requestedDate: ec.user.nowTimestamp
    })
    tell(
        [partyId],
        review.performanceReviewId,
        "Your feedback on a colleague's review for " + cycleNameOf(review) + " is asked for" + (dueDate ? " by " + dueDate : "")
    )
    return {performanceReviewStepId: created.performanceReviewStepId}
}
function stepOfReview(review, p, kind) {
    const step = text(p.performanceReviewStepId) ? one(STEP, {performanceReviewStepId: text(p.performanceReviewStepId)}) : null
    if (!step || step.performanceReviewId !== review.performanceReviewId || (kind && step.stepKindEnumId !== kind))
        denied("STEP_INVALID", "Choose a step of this review")
    return step
}
function cancelFeedback({userScope, review, access, p, reason}) {
    const step = stepOfReview(review, p, FEEDBACK)
    // the review's reviewer withdraws any feedback waiting on it, an earlier reviewer's asking included (it belongs to the review)
    if (!(access.developEdit || access.reviewer))
        denied("PERMISSION_DENIED", "The reviewer, or a development administrator, withdraws feedback")
    if (step.statusEnumId !== WAITING) denied("NOT_WAITING", "Only feedback still waiting is withdrawn")
    if (!reason) denied("REASON_REQUIRED", "Say why the feedback is withdrawn")
    cancelStep(step, reason)
    return {performanceReviewStepId: step.performanceReviewStepId}
}
function cancelStep(step, reason) {
    call("update#" + STEP, {
        performanceReviewStepId: step.performanceReviewStepId,
        statusEnumId: CANCELLED,
        statusEnumId_changeReason: reason,
        cancelReason: reason
    })
}
function returnStep({userScope, review, access, p, reason}) {
    requireState(review, [IN_PROGRESS], "A step is returned while assessing")
    const step = stepOfReview(review, p, null)
    if (step.stepKindEnumId === SELF ? !(access.reviewer || access.developEdit) : !access.developEdit)
        denied(
            "PERMISSION_DENIED",
            step.stepKindEnumId === SELF
                ? "The reviewer or a development administrator returns a self assessment"
                : "A development administrator returns this step"
        )
    if (step.statusEnumId !== SUBMITTED) denied("NOT_SUBMITTED", "Only a submitted step is returned")
    if (!reason) denied("REASON_REQUIRED", "Say why it is returned")
    call("update#" + STEP, {
        performanceReviewStepId: step.performanceReviewStepId,
        statusEnumId: WAITING,
        statusEnumId_changeReason: reason,
        returnedDate: ec.user.nowTimestamp,
        returnReason: reason
    })
    if (step.stepKindEnumId === MANAGER)
        call("update#" + REVIEW, {performanceReviewId: review.performanceReviewId, ratingEnumId: null})
    tell(
        [step.partyId],
        review.performanceReviewId,
        (step.stepKindEnumId === SELF ? "Your self assessment" : "Your assessment") +
            " for " +
            cycleNameOf(review) +
            " was returned to you"
    )
    return {performanceReviewStepId: step.performanceReviewStepId}
}
function finalize({review, access}) {
    if (!access.reviewer) denied("PERMISSION_DENIED", "The reviewer finalizes the review")
    requireState(review, [IN_PROGRESS], "A review is finalized after its assessments")
    const steps = stepsOf(review.performanceReviewId)
    if (steps.find(step => step.stepKindEnumId === MANAGER)?.statusEnumId !== SUBMITTED)
        denied("NOT_SUBMITTED", "Submit your assessment first")
    if (steps.some(step => step.stepKindEnumId === SELF && step.statusEnumId === WAITING))
        denied("SELF_WAITING", "The self assessment still waits; wait for it or return to it later")
    if (steps.some(step => step.stepKindEnumId === FEEDBACK && step.statusEnumId === WAITING))
        denied("FEEDBACK_WAITING", "Feedback still waits; wait for it or withdraw it")
    const template = templateOf(cycleOf(review.reviewCycleId)?.reviewTemplateId)
    if (template?.approvalRequired === "Y") {
        call("update#" + REVIEW, {
            performanceReviewId: review.performanceReviewId,
            statusEnumId: APPROVAL,
            statusEnumId_changeReason: "Finalizing asked for"
        })
        const after = reviewOf(review.performanceReviewId)
        approvals().request({
            approvalKindEnumId: approvalKind,
            sourceId: review.performanceReviewId,
            organizationPartyId: review.organizationPartyId,
            departmentPartyId: review.departmentPartyId || null,
            subjectPartyId: review.partyId,
            justification: "The review of " + personName(review.partyId) + " for " + cycleNameOf(review)
        })
        return {approvalAsked: !!after}
    }
    call("update#" + REVIEW, {
        performanceReviewId: review.performanceReviewId,
        statusEnumId: FINALIZED,
        statusEnumId_changeReason: "Finalized",
        finalizedDate: ec.user.nowTimestamp
    })
    return {approvalAsked: false}
}
function decide(context, decision) {
    const {review, p, reason, access} = context
    // the review's reviewer never decides its approval, though they became the reviewer after asking (record#Decision refuses the
    // one who asked and the person)
    if (access.reviewer) denied("SELF_APPROVAL", "You give this review; another approver decides it")
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: approvalKind,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: review.performanceReviewId,
        decision,
        reason,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.repeated) return {repeated: true}
    if (review.statusEnumId !== APPROVAL)
        denied("REVIEW_CLOSED", "This review is " + reviewTexts[review.statusEnumId].toLowerCase())
    if (decided.complete) {
        // the approval names the review's revision; its approval closed, the review moves on
        call("update#" + REVIEW, {
            performanceReviewId: review.performanceReviewId,
            statusEnumId: FINALIZED,
            statusEnumId_changeReason: "Approved",
            finalizedDate: ec.user.nowTimestamp
        })
        tell(
            [review.managerPartyId],
            review.performanceReviewId,
            "A review you gave for " + cycleNameOf(review) + " is approved: release it"
        )
    } else if (decided.statusId === "PapRefused") {
        const managerStep = stepsOf(review.performanceReviewId).find(step => step.stepKindEnumId === MANAGER)
        call("update#" + REVIEW, {
            performanceReviewId: review.performanceReviewId,
            statusEnumId: IN_PROGRESS,
            statusEnumId_changeReason: reason,
            ratingEnumId: null
        })
        if (managerStep)
            call("update#" + STEP, {
                performanceReviewStepId: managerStep.performanceReviewStepId,
                statusEnumId: WAITING,
                statusEnumId_changeReason: reason,
                returnedDate: ec.user.nowTimestamp,
                returnReason: reason
            })
        tell(
            [review.managerPartyId],
            review.performanceReviewId,
            "Your assessment for " + cycleNameOf(review) + " was returned to you"
        )
    }
    return {repeated: false}
}
const approve = context => decide(context, "approve")
const refuse = context => decide(context, "refuse")
function release({review, access}) {
    if (!(access.reviewer || access.developEdit))
        denied("PERMISSION_DENIED", "The reviewer or a development administrator releases the review")
    requireState(review, [FINALIZED], "A finalized review is released")
    issueRelease(review)
    call("update#" + REVIEW, {
        performanceReviewId: review.performanceReviewId,
        statusEnumId: RELEASED,
        statusEnumId_changeReason: "Released",
        releasedDate: ec.user.nowTimestamp,
        releasedByUserId: ec.user.userId
    })
    tell(
        [review.partyId],
        review.performanceReviewId,
        "Your review for " + cycleNameOf(review) + " is released: read and acknowledge it"
    )
    return {}
}
function acknowledge({review, access, p}) {
    if (!access.self) denied("PERMISSION_DENIED", "The person acknowledges their review")
    requireState(review, [RELEASED], "A released review is acknowledged")
    call("update#" + REVIEW, {
        performanceReviewId: review.performanceReviewId,
        statusEnumId: ACKNOWLEDGED,
        statusEnumId_changeReason: "Acknowledged",
        acknowledgedDate: ec.user.nowTimestamp,
        acknowledgementComment: text(p.comment) || null
    })
    return {}
}
function reassign({review, access, p, reason}) {
    if (!access.developEdit) denied("PERMISSION_DENIED", "A development administrator changes the reviewer")
    requireState(review, openStates, "The reviewer of an open review is changed")
    const partyId = text(p.partyId)
    if (!partyId || partyId === review.partyId) denied("PARTY_INVALID", "Choose a reviewer other than the person")
    if (!worksFor(partyId).includes(review.organizationPartyId))
        denied("NOT_EMPLOYED", "The reviewer does not work for the employer")
    if (!reason) denied("REASON_REQUIRED", "Say why the reviewer changes")
    if (partyId === review.managerPartyId) return {}
    setReviewer(review, partyId, reason)
    return {}
}
// The reviewer changed (audit-logged with the reason): their waiting assessment goes with it (an approval waiting is kept at the
// review's new revision), the new reviewer told. The feedback given or waiting on the review passes to the new reviewer (it belongs
// to the review; the user's call of Nov 12, 2026); an earlier reviewer's private notes stay theirs alone.
function setReviewer(review, partyId, reason) {
    const change = () => {
        call("update#" + REVIEW, {
            performanceReviewId: review.performanceReviewId,
            managerPartyId: partyId,
            managerPartyId_changeReason: reason
        })
        for (const step of stepsOf(review.performanceReviewId).filter(
            row => row.stepKindEnumId === MANAGER && row.statusEnumId === WAITING
        ))
            call("update#" + STEP, {
                performanceReviewStepId: step.performanceReviewStepId,
                partyId,
                statusEnumId_changeReason: reason
            })
    }
    if (review.statusEnumId === APPROVAL) approvals().keepWaiting(approvalKind, [review.performanceReviewId], change)
    else change()
    if (partyId) tell([partyId], review.performanceReviewId, "A review for " + cycleNameOf(review) + " is now yours to give")
}
function exclude({review, access, reason}) {
    if (!access.developEdit) denied("PERMISSION_DENIED", "A development administrator excludes a review")
    requireState(review, openStates, "An open review is excluded")
    if (!reason) denied("REASON_REQUIRED", "Say why the review is excluded")
    excludeReview(review, reason)
    return {}
}
function excludeReview(review, reason) {
    for (const step of stepsOf(review.performanceReviewId).filter(row => row.statusEnumId === WAITING)) cancelStep(step, reason)
    call("update#" + REVIEW, {
        performanceReviewId: review.performanceReviewId,
        statusEnumId: EXCLUDED,
        statusEnumId_changeReason: reason,
        excludedReason: reason
    })
    approvals().sourceChanged(approvalKind, review.performanceReviewId)
}
function decideNotice(p, decision) {
    const message = p.message || {}
    if (p.recordEntityName && p.recordEntityName !== REVIEW) denied("SOURCE_INVALID", "Not a review approval")
    return changeReviewState({
        performanceReviewId: p.recordId,
        action: decision,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        reason: p.reason
    })
}
const approveNotice = p => decideNotice(p, "approve")
const refuseNotice = p => decideNotice(p, "refuse")

// ===== the release (design §15) =====
// The employee-visible review as released: the person, the cycle and period, the employer, the reviewer, the overall rating, the
// self assessment, the reviewer's assessment and (when the template shares it) the feedback with who gave it; never a private note.
function releaseHtml(review) {
    const cycle = cycleOf(review.reviewCycleId)
    const template = templateOf(cycle?.reviewTemplateId)
    const steps = stepsOf(review.performanceReviewId).filter(
        step => step.statusEnumId === SUBMITTED && (step.stepKindEnumId !== FEEDBACK || template?.feedbackReleased === "Y")
    )
    const kindOrder = {[SELF]: 1, [MANAGER]: 2, [FEEDBACK]: 3}
    steps.sort((a, b) => kindOrder[a.stepKindEnumId] - kindOrder[b.stepKindEnumId])
    const names = people.personNames(
        unique(
            steps
                .map(row => row.partyId)
                .concat([review.partyId, review.managerPartyId])
                .filter(Boolean)
        )
    )
    const ratings = enumNames(steps.map(row => row.ratingEnumId).concat([review.ratingEnumId]))
    return ec.resource.template("component://mr-mantle/template/humanres/ReviewRelease.print.html.fancy", {
        reviewNumber: review.performanceReviewId,
        personName: names[review.partyId] || review.partyId,
        cycleName: cycle?.cycleName || review.reviewCycleId,
        periodText: cycle ? dayText(cycle.periodFromDate) + " – " + dayText(cycle.periodThruDate) : "",
        organizationName: people.organizationNames([review.organizationPartyId])[review.organizationPartyId] || "",
        reviewerName: review.managerPartyId ? names[review.managerPartyId] || "" : "",
        ratingText: review.ratingEnumId ? ratings[review.ratingEnumId] || "" : "",
        sections: steps.map(step => ({
            title: kindTexts[step.stepKindEnumId] || step.stepKindEnumId,
            byText: names[step.partyId] || step.partyId || "",
            dateText: dateText(step.submittedDate),
            ratingText: step.ratingEnumId ? ratings[step.ratingEnumId] || "" : "",
            summary: step.summary || "",
            answers: answersOfStep(step).map(answer => ({title: answer.title, displayText: answer.displayText}))
        })),
        releasedText: dateText(ec.user.nowTimestamp)
    })
}
function issueRelease(review) {
    if (review.releaseHtmlLocation) return
    const printHtml = releaseHtml(review)
    const fileName = "Review-" + review.performanceReviewId
    const folder = "dbresource://mantle/content/review/" + review.performanceReviewId + "/release"
    const htmlLocation = folder + "/" + fileName + ".html"
    ec.resource.getLocationReference(htmlLocation).putText(printHtml)
    let pdfLocation = null
    try {
        const pdf = ec.resource.xslFoTransform(printHtml, null, null, "application/pdf")
        pdfLocation = folder + "/" + fileName + ".pdf"
        ec.resource.getLocationReference(pdfLocation).putBytes(pdf)
    } catch (error) {
        // the page is released and kept; a PDF that does not render is logged, and the page prints from the browser
        pdfLocation = null
        ec.logger.error("The PDF of review " + review.performanceReviewId + " was not made: " + error.message)
    }
    call("update#" + REVIEW, {
        performanceReviewId: review.performanceReviewId,
        releaseHtmlLocation: htmlLocation,
        releaseLocation: pdfLocation
    })
}
// get#ReviewRelease: a released review as it was released, to the person, its reviewer and development readers of the employer:
// its stored page, its PDF's location and name. Refused: one not in reach or not released (RECORD_UNAVAILABLE, NOT_RELEASED).
function reviewRelease(p) {
    const userScope = reviewScope()
    const review = reviewOf(p.performanceReviewId)
    const access = review ? accessOf(userScope, review) : null
    if (!review || !(access.self || access.reviewer || access.develop))
        denied("RECORD_UNAVAILABLE", "Review " + text(p.performanceReviewId) + " is not available")
    if (!review.releaseHtmlLocation) denied("NOT_RELEASED", "This review is not released yet")
    return {
        performanceReviewId: review.performanceReviewId,
        printHtml: ec.resource.getLocationReference(review.releaseHtmlLocation).getText(),
        pdfLocation: review.releaseLocation || null,
        fileName: "Review-" + review.performanceReviewId + ".pdf",
        releasedDateText: dateText(review.releasedDate)
    }
}

// ===== store#ReviewNote =====
// A private note of the reviewer on a review (not released or excluded): added by its current reviewer, changed or removed only by
// its author. Read by its author alone (get#Review's notes). Refused: a review not in reach (RECORD_UNAVAILABLE), one who is not its
// reviewer or the note's author (PERMISSION_DENIED), a review released or excluded (REVIEW_CLOSED), no text (TEXT_REQUIRED), a
// revision other than the one read (REVISION_CHANGED).
function storeReviewNote(p) {
    const userScope = reviewScope()
    const {review, access} = readableReview(userScope, p.performanceReviewId)
    const id = text(p.performanceNoteId)
    const existing = id ? one(NOTE, {performanceNoteId: id}) : null
    if (
        id &&
        (!existing || existing.performanceReviewId !== review.performanceReviewId || existing.authorPartyId !== userScope.partyId)
    )
        denied("RECORD_UNAVAILABLE", "Note " + id + " is not available")
    if (!existing && !access.reviewer) denied("PERMISSION_DENIED", "The reviewer keeps private notes")
    if (releasedStates.includes(review.statusEnumId) || review.statusEnumId === EXCLUDED)
        denied("REVIEW_CLOSED", "The review is " + reviewTexts[review.statusEnumId].toLowerCase())
    if (existing && text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(existing))
        denied("REVISION_CHANGED", "This note changed since you read it; open it again")
    if (existing && flag(p.remove)) {
        call("delete#" + NOTE, {performanceNoteId: id})
        return {performanceNoteId: id, removed: true}
    }
    const noteText = text(p.noteText)
    if (!noteText) denied("TEXT_REQUIRED", "Write the note")
    if (existing) {
        call("update#" + NOTE, {performanceNoteId: id, noteText})
        return {performanceNoteId: id, removed: false}
    }
    const created = call("create#" + NOTE, {
        performanceReviewId: review.performanceReviewId,
        partyId: review.partyId,
        authorPartyId: userScope.partyId,
        authorUserId: ec.user.userId,
        noteDate: ec.user.nowTimestamp,
        noteText
    })
    return {performanceNoteId: created.performanceNoteId, removed: false}
}

// ===== check#ReviewAccess (the review's content host) =====
// Whether the caller reads a review's files and Chatter: its reviewer and development readers of its employer, and the person once
// it is released; canEdit for the reviewer and development editors. Never refuses; a call with no user sees none.
function reviewAccess(p) {
    const none = {recordVisible: false, canEdit: false, partyId: null}
    if (!ec.user.userId) return none
    const review = reviewOf(p.performanceReviewId)
    if (!review) return none
    const userScope = reviewScope()
    const access = accessOf(userScope, review)
    return {
        recordVisible: access.reviewer || access.develop || (access.self && access.released),
        canEdit: (access.reviewer || access.developEdit) && review.statusEnumId !== EXCLUDED,
        partyId: review.partyId
    }
}
function contentAccess(p) {
    const found = reviewAccess(p)
    if (!found.recordVisible) denied("RECORD_UNAVAILABLE", "Review " + text(p.performanceReviewId) + " is not available")
    if (!found.canEdit) denied("PERMISSION_DENIED", "The reviewer or a development administrator adds a review's files")
    return found
}

// ===== goals =====
const goalOf = workEffortId => {
    const goal = text(workEffortId) ? one(GOAL, {workEffortId: text(workEffortId)}) : null
    return goal ? {goal, work: one(WORK, {workEffortId: goal.workEffortId})} : null
}
// How the caller reads a person's goals at an employer: the person (own), a manager of a live line at the employer (team), a
// development reader of the employer (develop; developEdit), the reviewer of the review it was agreed in (reviewer).
function goalAccess(userScope, goal) {
    const own = !!userScope.partyId && goal.partyId === userScope.partyId
    const team = !own && (userScope.reportLines?.[goal.partyId] || []).includes(goal.organizationPartyId)
    const develop = !own && userScope.developEmployers.includes(goal.organizationPartyId)
    const developEdit = develop && !!userScope.capabilities.developEdit
    let reviewer = false
    if (!own && !team && !develop && goal.performanceReviewId) {
        const review = reviewOf(goal.performanceReviewId)
        reviewer = !!review && accessOf(userScope, review).reviewer
    }
    return {
        own,
        team,
        develop,
        developEdit,
        reviewer,
        reads: own || team || develop || reviewer,
        changes: own || team || developEdit
    }
}
// For get#RecordLinkInfo: whether the caller reads a goal's work effort (its person, their manager, the reviewer of its review and
// development readers of its employer); no user reads none.
function goalVisible(workEffortId) {
    if (!ec.user.userId) return false
    const found = goalOf(workEffortId)
    if (!found) return false
    return goalAccess(reviewScope(), found.goal).reads
}
const goalStateTexts = {WeInProgress: "Open", WeComplete: "Closed", WeCancelled: "Cancelled"}
function decimalText(value) {
    return value == null ? "" : ec.l10n.format(value, "#,##0.##")
}
function goalLines(userScope, goals) {
    if (!goals.length) return []
    const works = new Map(
        Array.from(
            find(WORK)
                .condition(
                    "workEffortId",
                    "in",
                    goals.map(row => row.workEffortId)
                )
                .list()
        ).map(row => [row.workEffortId, row])
    )
    const parentIds = unique(
        Array.from(works.values())
            .map(row => row.parentWorkEffortId)
            .filter(Boolean)
    )
    const parents = new Map(
        parentIds.length
            ? Array.from(find(WORK).condition("workEffortId", "in", parentIds).list()).map(row => [row.workEffortId, row])
            : []
    )
    const names = people.personNames(unique(goals.map(row => row.partyId)))
    const outcomes = enumNames(goals.map(row => row.outcomeEnumId))
    return goals
        .map(goal => {
            const work = works.get(goal.workEffortId)
            const access = goalAccess(userScope, goal)
            const parent = work?.parentWorkEffortId ? parents.get(work.parentWorkEffortId) : null
            const statusId = work?.statusId || "WeInProgress"
            return {
                workEffortId: goal.workEffortId,
                title: work?.workEffortName || goal.workEffortId,
                description: work?.description || "",
                partyId: goal.partyId,
                ownerName: names[goal.partyId] || goal.partyId,
                organizationPartyId: goal.organizationPartyId,
                parentWorkEffortId: work?.parentWorkEffortId || null,
                parentTitle: parent?.workEffortName || "",
                performanceReviewId: goal.performanceReviewId || null,
                fromDate: stampDayText(work?.estimatedStartDate),
                thruDate: stampDayText(work?.estimatedCompletionDate),
                periodText:
                    stampDayText(work?.estimatedStartDate) +
                    (work?.estimatedCompletionDate ? " – " + stampDayText(work.estimatedCompletionDate) : ""),
                measureText: goal.measureText || "",
                targetValue: goal.targetValue != null ? String(goal.targetValue) : "",
                actualValue: goal.actualValue != null ? String(goal.actualValue) : "",
                unitText: goal.unitText || "",
                progressText:
                    goal.targetValue != null
                        ? decimalText(goal.actualValue ?? 0) +
                          " of " +
                          decimalText(goal.targetValue) +
                          (goal.unitText ? " " + goal.unitText : "")
                        : work?.percentComplete != null
                          ? String(work.percentComplete) + "%"
                          : "",
                percentComplete: work?.percentComplete ?? null,
                progressNote: goal.progressNote || "",
                statusId,
                stateText:
                    statusId === "WeComplete" && goal.outcomeEnumId
                        ? outcomes[goal.outcomeEnumId] || "Closed"
                        : goalStateTexts[statusId] || statusId,
                open: statusId === "WeInProgress",
                canChange: access.changes && statusId === "WeInProgress",
                revision: stampOf(work) + ":" + stampOf(goal)
            }
        })
        .sort((a, b) => a.ownerName.localeCompare(b.ownerName) || (a.thruDate || "9999").localeCompare(b.thruDate || "9999"))
}
// find#Goals: the goals the caller reads: mine (the default), team (a manager's reports' at the line's employers), a person's
// (partyId, as goalAccess admits), a review's (performanceReviewId: the goals agreed in a review the caller reads), all (a
// development reader's employers'); open (the default), closed or every state. Paged; each with its owner, parent, period, measure,
// progress and state, and whether the caller may change it. Refused: a show or state that is not one (SHOW_INVALID), a person or
// review not in reach (RECORD_UNAVAILABLE).
function findGoals(p) {
    const userScope = reviewScope()
    const partyId = text(p.partyId)
    const performanceReviewId = text(p.performanceReviewId)
    const show = performanceReviewId ? "review" : partyId ? "person" : text(p.show) || "mine"
    if (!["mine", "team", "person", "review", "all"].includes(show)) denied("SHOW_INVALID", "Show one of mine, team or all")
    const state = text(p.state) || "open"
    if (!["open", "closed", "all"].includes(state)) denied("SHOW_INVALID", "Show open, closed or all goals")
    let query = find(GOAL)
    if (show === "mine") query = query.condition("partyId", userScope.partyId || "_NA_")
    else if (show === "team")
        query = query.condition("partyId", "in", userScope.reportPartyIds.length ? userScope.reportPartyIds : ["_NA_"])
    else if (show === "person") query = query.condition("partyId", partyId)
    else if (show === "review") {
        // a review's goals: its person and its full readers (a feedback giver reads none)
        const {access} = readableReview(userScope, performanceReviewId)
        if (!(access.full || access.self)) denied("RECORD_UNAVAILABLE", "Review " + performanceReviewId + " is not available")
        query = query.condition("performanceReviewId", performanceReviewId)
    } else
        query = query.condition(
            "organizationPartyId",
            "in",
            userScope.developEmployers.length ? userScope.developEmployers : ["_NA_"]
        )
    let goals = Array.from(query.limit(listCap).list()).filter(goal => goalAccess(userScope, goal).reads || show === "review")
    if (show === "person" && partyId !== userScope.partyId && !goals.length && !personReadable(userScope, partyId))
        denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    let lines = goalLines(userScope, goals)
    if (state === "open") lines = lines.filter(line => line.open)
    if (state === "closed") lines = lines.filter(line => !line.open)
    return Object.assign(lib.pageList(lines, p, "goals"), {canAdd: true})
}
function personReadable(userScope, partyId) {
    if (partyId === userScope.partyId) return true
    if (userScope.reportPartyIds.includes(partyId)) return true
    return userScope.developEmployers.length > 0 && worksFor(partyId).some(id => userScope.developEmployers.includes(id))
}
// store#Goal: a goal agreed (partyId: the person, or the caller) or changed (workEffortId, at its revision), closed with its outcome
// (close, outcomeEnumId) or cancelled (cancel, with a reason), by the person, the manager of a live line at the employer, or a
// development editor of the employer: its title, description, parent goal (one of the same person's or a goal of the employer the
// caller reads), period, measure, target, unit, actual value, percent complete and progress note, and the review it was agreed in (a
// review of the person the caller reads). Refused: a person or goal not in reach (RECORD_UNAVAILABLE), no current employment at an
// employer the caller may set goals at (NOT_EMPLOYED), no title (TITLE_REQUIRED), dates out of order (DATES_INVALID), a number that
// is not one (VALUE_INVALID), a percent outside 0 to 100 (PERCENT_INVALID), a parent that is not one (PARENT_INVALID), a review that is
// not the person's (REVIEW_INVALID), a closed goal changed (GOAL_CLOSED), a revision other than the one read (REVISION_CHANGED).
function storeGoal(p) {
    const userScope = reviewScope()
    const id = text(p.workEffortId)
    const found = id ? goalOf(id) : null
    if (id && (!found || !goalAccess(userScope, found.goal).reads))
        denied("RECORD_UNAVAILABLE", "Goal " + id + " is not available")
    let goal = found?.goal || null
    if (goal && !goalAccess(userScope, goal).changes)
        denied("PERMISSION_DENIED", "The person, their manager or development changes a goal")
    if (found) {
        const revision = stampOf(found.work) + ":" + stampOf(goal)
        if (text(p.expectedRevision) && text(p.expectedRevision) !== revision)
            denied("REVISION_CHANGED", "This goal changed since you read it; open it again (revision " + revision + ")")
        if (found.work.statusId !== "WeInProgress") denied("GOAL_CLOSED", "A closed or cancelled goal is not changed")
    }
    let partyId = goal ? goal.partyId : text(p.partyId) || userScope.partyId
    let organizationPartyId = goal?.organizationPartyId || null
    let partyRelationshipId = goal?.partyRelationshipId || null
    if (!goal) {
        if (!partyId) denied("RECORD_UNAVAILABLE", "Choose the person")
        const own = partyId === userScope.partyId
        const employers = own
            ? (userScope.employments || []).map(row => row.organizationPartyId)
            : unique(
                  ((userScope.reportLines || {})[partyId] || []).concat(
                      userScope.capabilities.developEdit ? userScope.developEmployers : []
                  )
              )
        const employments = Array.from(
            people
                .current(
                    people
                        .employmentFind()
                        .condition("fromPartyId", partyId)
                        .condition("toPartyId", "in", employers.length ? employers : ["_NA_"]),
                    nowMs()
                )
                .list()
        )
        const wanted = text(p.organizationPartyId)
        const employment = employments.find(row => !wanted || row.toPartyId === wanted)
        if (!employment)
            denied(
                own || employers.length ? "NOT_EMPLOYED" : "RECORD_UNAVAILABLE",
                own || employers.length ? "No current employment to set this goal at" : "Person " + partyId + " is not available"
            )
        organizationPartyId = employment.toPartyId
        partyRelationshipId = employment.partyRelationshipId
    }
    const work = found?.work || null
    if (goal && flag(p.cancel)) {
        const reason = text(p.reason)
        if (!reason) denied("REASON_REQUIRED", "Say why the goal is cancelled")
        call("update#" + WORK, {workEffortId: id, statusId: "WeCancelled", statusId_changeReason: reason})
        return goalAnswer(id)
    }
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const number = (name, fallback) => {
        if (!given(p[name])) return fallback ?? null
        const raw = text(p[name])
        if (!raw) return null
        if (!/^-?\d+(\.\d+)?$/.test(raw)) denied("VALUE_INVALID", raw + " is not a number")
        return toDecimal(raw)
    }
    const title = value("title", work?.workEffortName)
    if (!title) denied("TITLE_REQUIRED", "Name the goal")
    const fromDate = given(p.fromDate) ? dayOf(p.fromDate, "the start") : stampDayText(work?.estimatedStartDate) || null
    const thruDate = given(p.thruDate) ? dayOf(p.thruDate, "the due date") : stampDayText(work?.estimatedCompletionDate) || null
    if (fromDate && thruDate && thruDate < fromDate) denied("DATES_INVALID", "The goal is due on or after it starts")
    let percent = work?.percentComplete ?? null
    if (given(p.percentComplete) && text(p.percentComplete) !== "") {
        percent = Number(text(p.percentComplete))
        if (!Number.isInteger(percent) || percent < 0 || percent > 100) denied("PERCENT_INVALID", "Percent complete is 0 to 100")
    }
    const parentId = value("parentWorkEffortId", work?.parentWorkEffortId)
    if (parentId && parentId !== work?.parentWorkEffortId) {
        const parent = goalOf(parentId)
        if (
            !parent ||
            parentId === id ||
            !goalAccess(userScope, parent.goal).reads ||
            parent.goal.organizationPartyId !== organizationPartyId
        )
            denied("PARENT_INVALID", "Choose a goal of the same employer you read")
    }
    const performanceReviewId = value("performanceReviewId", goal?.performanceReviewId)
    if (performanceReviewId && performanceReviewId !== goal?.performanceReviewId) {
        const review = reviewOf(performanceReviewId)
        if (!review || review.partyId !== partyId) denied("REVIEW_INVALID", "Choose a review of this person")
        const {access} = readableReview(userScope, performanceReviewId)
        if (!(access.full || access.self)) denied("REVIEW_INVALID", "Choose a review of this person")
    }
    const closing = flag(p.close)
    const outcomeEnumId = closing ? enumOf(p.outcomeEnumId, OUTCOME_TYPE, "goal outcome") : null
    if (closing && !outcomeEnumId) denied("OUTCOME_REQUIRED", "Say whether the goal was met")
    const workValues = {
        workEffortName: title,
        description: value("description", work?.description),
        estimatedStartDate: stampDay(fromDate),
        estimatedCompletionDate: stampDay(thruDate),
        percentComplete: percent,
        parentWorkEffortId: parentId
    }
    const goalValues = {
        measureText: value("measureText", goal?.measureText),
        targetValue: number("targetValue", goal?.targetValue),
        actualValue: number("actualValue", goal?.actualValue),
        unitText: value("unitText", goal?.unitText),
        progressNote: value("progressNote", goal?.progressNote),
        performanceReviewId
    }
    let workEffortId = id
    if (!goal) {
        workEffortId = call(
            "create#" + WORK,
            Object.assign(workValues, {
                workEffortTypeEnumId: "WetGoal",
                purposeEnumId: "WepGoal",
                visibilityEnumId: "WevRestricted",
                statusId: "WeInProgress",
                ownerPartyId: partyId
            })
        ).workEffortId
        call(
            "create#" + GOAL,
            Object.assign(goalValues, {
                workEffortId,
                partyId,
                partyRelationshipId,
                organizationPartyId,
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            })
        )
    } else {
        call("update#" + WORK, Object.assign({workEffortId: id}, workValues))
        call("update#" + GOAL, Object.assign({workEffortId: id}, goalValues))
    }
    if (closing) {
        call("update#" + GOAL, {workEffortId, outcomeEnumId})
        call("update#" + WORK, {workEffortId, statusId: "WeComplete", actualCompletionDate: ec.user.nowTimestamp})
    }
    return goalAnswer(workEffortId)
}
function goalAnswer(workEffortId) {
    const found = goalOf(workEffortId)
    return {workEffortId, statusId: found.work.statusId, revision: stampOf(found.work) + ":" + stampOf(found.goal)}
}

// ===== the lifecycle participant (People's find#OwnedApprovals; rerouted with Approvals.js reroute) =====
// The open reviews a party reviews and the feedback asked of them, as owned resources, names only, not transferable: when they
// leave or their line changes, each goes as rerouteSteps says.
function ownedSteps(partyId) {
    if (!partyId) return []
    const found = []
    const reviewing = Array.from(
        find(REVIEW).condition("managerPartyId", partyId).condition("statusEnumId", "in", openStates).limit(listCap).list()
    )
    const feedback = Array.from(
        find(STEP).condition({partyId, stepKindEnumId: FEEDBACK, statusEnumId: WAITING}).limit(listCap).list()
    )
    const feedbackReviews = new Map(
        feedback.length
            ? Array.from(
                  find(REVIEW)
                      .condition("performanceReviewId", "in", unique(feedback.map(row => row.performanceReviewId)))
                      .list()
              ).map(row => [row.performanceReviewId, row])
            : []
    )
    const names = people.personNames(
        unique(reviewing.map(row => row.partyId).concat(Array.from(feedbackReviews.values()).map(row => row.partyId)))
    )
    for (const review of reviewing)
        found.push({
            resourceId: "review:" + review.performanceReviewId,
            resourceName: "Review of " + (names[review.partyId] || review.partyId),
            resourceKind: "reviewStep",
            transferable: false,
            note: "Goes to the person's manager when the reviewer leaves; development may change the reviewer"
        })
    for (const step of feedback) {
        const review = feedbackReviews.get(step.performanceReviewId)
        if (!review || review.statusEnumId !== IN_PROGRESS) continue
        found.push({
            resourceId: "reviewStep:" + step.performanceReviewStepId,
            resourceName: "Feedback on " + (names[review.partyId] || review.partyId),
            resourceKind: "reviewStep",
            transferable: false,
            note: "Withdrawn when they leave"
        })
    }
    return found
}
// The open reviews of an employer routed again after a separation or a reporting line changed (Approvals.js reroute calls it, in the
// caller's transaction): a review whose person no longer works there is excluded; a reviewer who left, or whose line no longer
// manages the person while their assessment waits, is replaced by the manager of the employment's live line (none: the review waits
// with no reviewer for development to assign); feedback waiting on a colleague who left is withdrawn. Each review on its own: a
// failure is logged and the rest go on.
function rerouteSteps(organizationPartyId) {
    const counts = {excluded: 0, reassigned: 0, withdrawn: 0}
    if (!organizationPartyId) return counts
    const open = Array.from(
        find(REVIEW).condition({organizationPartyId}).condition("statusEnumId", "in", openStates).limit(listCap).list()
    )
    if (!open.length) return counts
    const at = nowMs()
    const employed = people.employersOfParties(unique(open.map(row => row.partyId)), at)
    for (const review of open) {
        ec.message.pushErrors()
        try {
            rerouteReview(review, organizationPartyId, employed, at, counts)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            ec.logger.error("Review " + review.performanceReviewId + " was not routed again: " + error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return counts
}
function rerouteReview(review, organizationPartyId, employed, at, counts) {
    if (!(employed[review.partyId] || []).includes(organizationPartyId)) {
        excludeReview(review, "Left the employer")
        counts.excluded++
        return
    }
    const steps = stepsOf(review.performanceReviewId)
    for (const step of steps.filter(row => row.stepKindEnumId === FEEDBACK && row.statusEnumId === WAITING))
        if (!worksFor(step.partyId).includes(organizationPartyId)) {
            cancelStep(step, "The colleague left the employer")
            counts.withdrawn++
        }
    const managerWaiting = steps.some(row => row.stepKindEnumId === MANAGER && row.statusEnumId === WAITING)
    const reviewerStays =
        !!review.managerPartyId &&
        worksFor(review.managerPartyId).includes(organizationPartyId) &&
        (!managerWaiting ||
            (people.managersByEmployment([review.partyId], at)[organizationPartyId + "/" + review.partyId] || []).includes(
                review.managerPartyId
            ))
    if (reviewerStays) return
    const next =
        (people.managersByEmployment([review.partyId], at)[organizationPartyId + "/" + review.partyId] || []).find(
            partyId => partyId !== review.partyId && worksFor(partyId).includes(organizationPartyId)
        ) || null
    if (next === (review.managerPartyId || null)) return
    setReviewer(
        review,
        next,
        review.managerPartyId && !worksFor(review.managerPartyId).includes(organizationPartyId)
            ? "The reviewer left the employer"
            : "The reporting line changed"
    )
    counts.reassigned++
}

const operations = {
    findCycles,
    storeReviewTemplate,
    storeCycle,
    startCycle,
    findReviews,
    getReview,
    storeAssessment,
    submitFeedback,
    changeReviewState,
    approveNotice,
    refuseNotice,
    storeReviewNote,
    reviewRelease,
    reviewAccess,
    contentAccess,
    findGoals,
    storeGoal
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown review operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    // for Approvals.js (People's lifecycle participant and its re-route) and get#RecordLinkInfo
    ownedSteps,
    rerouteSteps,
    goalVisible
})
