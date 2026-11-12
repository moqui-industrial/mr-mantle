// People's recruiting (mantle.humanres.RecruitingServices; IronStone People design §5 Openings, ApplicantPipeline,
// ApplicantDetail, §13 InterviewsCalendar, §15 the interview invitation, PE-04, PE-24; impl-people P16, F9, F11, F65):
// - an opening (JobOpening) is an employer's recruiting text, owner and dates over one or more of its approved active seats
//   (EmplPosition EmpsActive, in effect: a planned seat is P5's approval first); a closed opening takes no application and keeps
//   its applications;
// - an application (EmploymentApplication) is of an applicant (a Person with the Applicant role, never an employee role or an
//   account by applying) to an opening; its stage moves by change#ApplicationStage along the flow Received, Screening,
//   Interview, Offer, with Refused and Withdrawn: Interview needs a scheduled interview, Offer an offer (P17), and Hired is never
//   a stage change (P17 hires from an accepted offer); a bulk change names each failure and goes on, each in its own transaction;
// - an interview (ApplicationInterview) is a private event (WetEvent, WevRestricted) with its panel and the candidate as
//   attendees, a video call link when asked (org.moqui.call.CallServices.create#CallLink) and the iMIP invitation
//   (mantle.work.EventServices.send#EventInvitations); each panel member is assigned the interview's scorecard, a form of the
//   interview scorecard purpose (mantle.party.FormDefinitions), as a FormInvitation naming them and the application, with no link:
//   they answer it once, here (submit#Scorecard), and read their own answer only;
// - mail intake (create#ApplicationFromEmail, the createApplication mail rule action): runs with authorization off, so it checks
//   itself that the rule may file into the opening and answers a message once.
// Who reads what: a recruiter (PEOPLE_RECRUIT_VIEW) of the employer, in People's scope (People.js scopeOf), reads its openings
// and applications and every scorecard; PEOPLE_RECRUIT_EDIT changes them. A panel member (the user's call of Nov 12, 2026: from
// People or from their self-service, find#MyInterviews and get#MyInterview) reads of an application they interview only the
// applicant's name, the opening and its employer, the interviews they are on the panel of with their own scorecard, and the
// files a recruiter shared with the panel (EmploymentApplicationContent.panelShared, get#ApplicationFile): never its stage,
// source, referral, contact, notes or other files, the application's record (its notes and files host is the recruiters'),
// another reviewer's scorecard nor another opening's candidates. Missing and unauthorized records are refused alike
// (RECORD_UNAVAILABLE).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const {find, one, rows, denied, call, dateText, ms} = lib

const OPENING = "mantle.humanres.recruitment.JobOpening",
    OPENING_POSITION = "mantle.humanres.recruitment.JobOpeningPosition",
    APPLICATION = "mantle.humanres.employment.EmploymentApplication",
    CONTENT = "mantle.humanres.employment.EmploymentApplicationContent",
    INTERVIEW = "mantle.humanres.recruitment.ApplicationInterview",
    INVITATION = "mantle.party.FormInvitation",
    POSITION = "mantle.humanres.position.EmplPosition",
    WORK = "mantle.work.effort.WorkEffort",
    WORK_PARTY = "mantle.work.effort.WorkEffortParty",
    RELATIONSHIP = "mantle.party.PartyRelationship"
const SCORECARD = "DbfpInterviewScorecard"
const stageTexts = {
    EaReceived: "Received",
    EaScreening: "Screening",
    EaInterview: "Interview",
    EaOffer: "Offer",
    EaHired: "Hired",
    EaRefused: "Refused",
    EaWithdrawn: "Withdrawn"
}
const stageColors = {
    EaReceived: "info",
    EaScreening: "info",
    EaInterview: "primary",
    EaOffer: "warning",
    EaHired: "positive",
    EaRefused: "negative",
    EaWithdrawn: "grey"
}
const openStages = ["EaReceived", "EaScreening", "EaInterview", "EaOffer"]
// the stages an application moves to from each (Hired is P17's, from an accepted offer)
const moves = {
    EaReceived: ["EaScreening", "EaInterview", "EaRefused", "EaWithdrawn"],
    EaScreening: ["EaReceived", "EaInterview", "EaRefused", "EaWithdrawn"],
    EaInterview: ["EaScreening", "EaOffer", "EaRefused", "EaWithdrawn"],
    EaOffer: ["EaRefused", "EaWithdrawn"]
}
const openingTexts = {JoDraft: "Draft", JoOpen: "Open", JoClosed: "Closed"}
const openingColors = {JoDraft: "warning", JoOpen: "positive", JoClosed: "grey"}
const listCap = 2000
const hourMs = 60 * 60 * 1000

const text = value => String(value ?? "").trim()
const blank = value => text(value) === ""
const truthy = value => value === true || value === "true" || value === "Y"
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const unique = values => Array.from(new Set(values.filter(value => value != null && value !== "")))
const listOf = value =>
    (Array.isArray(value)
        ? value
        : value != null && typeof value === "object" && typeof value[Symbol.iterator] === "function"
          ? Array.from(value)
          : blank(value)
            ? []
            : String(value).split(",")
    )
        .map(part => String(part).trim())
        .filter(Boolean)
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const whenText = (startMs, endMs) =>
    startMs == null
        ? ""
        : ec.l10n.format(new Date(startMs), "EEE d MMM yyyy HH:mm") +
          (endMs ? "–" + ec.l10n.format(new Date(endMs), "HH:mm") : "")
const unavailable = (what, id) => denied("RECORD_UNAVAILABLE", what + " " + (id || "") + " is not available")
function checkRevision(row, revision) {
    if (!blank(revision) && String(revision) !== String(stampOf(row)))
        denied("REVISION_CHANGED", "It was changed since you read it (now at revision " + stampOf(row) + "); read it again")
}

// ===== scope =====
// The caller's People scope with a recruiter's read (PEOPLE_RECRUIT_VIEW) and, for a change, PEOPLE_RECRUIT_EDIT.
function recruiterScope(edit = false) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.recruitView || (edit && !caps.recruitEdit))
        denied(
            "PERMISSION_DENIED",
            edit ? "Recruiting changes need PEOPLE_RECRUIT_VIEW and PEOPLE_RECRUIT_EDIT" : "Recruiting needs PEOPLE_RECRUIT_VIEW"
        )
    return userScope
}
const recruits = (userScope, organizationPartyId) =>
    !!userScope.capabilities.recruitView && Array.from(userScope.organizationPartyIds).includes(organizationPartyId)
const recruitEdits = (userScope, organizationPartyId) =>
    recruits(userScope, organizationPartyId) && !!userScope.capabilities.recruitEdit
// The scorecard assignments (FormInvitation) of a party, of the applications given or every one.
function panelInvitations(partyId, applicationIds = null) {
    if (!partyId) return []
    let query = find(INVITATION).condition("partyId", partyId).condition("recordEntityName", APPLICATION)
    if (applicationIds) {
        if (!applicationIds.length) return []
        query = query.condition("recordId", "in", applicationIds)
    }
    return Array.from(query.list())
}
// How the caller reads an application: recruiter (of its employer), panel (assigned a scorecard of it), or null.
function accessOf(userScope, application) {
    if (!application) return null
    if (recruits(userScope, application.organizationPartyId)) return "recruiter"
    if (panelInvitations(userScope.partyId, [application.employmentApplicationId]).length) return "panel"
    return null
}
function readableApplication(userScope, employmentApplicationId) {
    const application = blank(employmentApplicationId)
        ? null
        : one(APPLICATION, {employmentApplicationId: text(employmentApplicationId)})
    const access = accessOf(userScope, application)
    if (!access) unavailable("Application", employmentApplicationId)
    return {application, access}
}
function editableApplication(userScope, employmentApplicationId) {
    const application = blank(employmentApplicationId)
        ? null
        : one(APPLICATION, {employmentApplicationId: text(employmentApplicationId)})
    if (!application || !recruits(userScope, application.organizationPartyId)) unavailable("Application", employmentApplicationId)
    return application
}
function readableOpening(userScope, jobOpeningId) {
    const opening = blank(jobOpeningId) ? null : one(OPENING, {jobOpeningId: text(jobOpeningId)})
    if (!opening || !recruits(userScope, opening.organizationPartyId)) unavailable("Opening", jobOpeningId)
    return opening
}
// Whether an opening takes applications now: open, started and not past its closing.
const isOpen = opening =>
    !!opening &&
    opening.statusId === "JoOpen" &&
    (ms(opening.fromDate) ?? -Infinity) <= nowMs() &&
    (ms(opening.thruDate) ?? Infinity) > nowMs()

// ===== names =====
function applicantEmails(partyIds) {
    const found = {}
    const ids = unique(partyIds)
    if (!ids.length) return found
    for (const row of Array.from(
        people
            .current(find("mantle.party.contact.PartyContactMechInfo").condition("partyId", "in", ids), null)
            .orderBy("-fromDate")
            .list()
    )) {
        const info = String(row.infoString || "")
        if (!info.includes("@") || found[row.partyId]) continue
        found[row.partyId] = info
    }
    return found
}
const openingTitles = jobOpeningIds =>
    Object.fromEntries(
        unique(jobOpeningIds).length
            ? Array.from(find(OPENING).condition("jobOpeningId", "in", unique(jobOpeningIds)).list()).map(row => [
                  row.jobOpeningId,
                  row.title || row.jobOpeningId
              ])
            : []
    )

// ===== openings =====
// The seats of openings: {jobOpeningId: [{emplPositionId, positionName}]}.
function seatsOf(jobOpeningIds) {
    const found = {}
    if (!jobOpeningIds.length) return found
    const links = Array.from(find(OPENING_POSITION).condition("jobOpeningId", "in", jobOpeningIds).list())
    const positionIds = unique(links.map(row => row.emplPositionId))
    const positions = positionIds.length
        ? new Map(
              Array.from(find(POSITION).condition("emplPositionId", "in", positionIds).list()).map(row => [
                  row.emplPositionId,
                  row
              ])
          )
        : new Map()
    for (const link of links) {
        const position = positions.get(link.emplPositionId)
        ;(found[link.jobOpeningId] || (found[link.jobOpeningId] = [])).push({
            emplPositionId: link.emplPositionId,
            positionName: position?.description || link.emplPositionId
        })
    }
    return found
}
function openingRows(userScope, openings) {
    if (!openings.length) return []
    const ids = openings.map(row => row.jobOpeningId)
    const seats = seatsOf(ids)
    const counts = {}
    for (const row of Array.from(
        find(APPLICATION).condition("jobOpeningId", "in", ids).selectField(["jobOpeningId", "statusId"]).list()
    )) {
        const count = counts[row.jobOpeningId] || (counts[row.jobOpeningId] = {open: 0, all: 0})
        count.all++
        if (openStages.includes(row.statusId)) count.open++
    }
    const organizations = people.organizationNames(unique(openings.map(row => row.organizationPartyId)))
    const owners = people.personNames(unique(openings.map(row => row.ownerPartyId)))
    return openings.map(row => {
        const state = row.statusId === "JoOpen" && !isOpen(row) ? "JoClosed" : row.statusId || "JoDraft"
        return {
            jobOpeningId: row.jobOpeningId,
            title: row.title || row.jobOpeningId,
            description: row.description || "",
            organizationPartyId: row.organizationPartyId,
            organizationName: organizations[row.organizationPartyId] || row.organizationPartyId || "",
            ownerPartyId: row.ownerPartyId || null,
            ownerName: owners[row.ownerPartyId] || "",
            positions: seats[row.jobOpeningId] || [],
            emplPositionIds: (seats[row.jobOpeningId] || []).map(seat => seat.emplPositionId),
            positionsText: (seats[row.jobOpeningId] || []).map(seat => seat.positionName).join(", "),
            statusId: row.statusId || "JoDraft",
            stateText: openingTexts[state] || state,
            stateColor: openingColors[state] || "grey",
            takesApplications: isOpen(row),
            internalOnly: row.internalOnly === "Y",
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            intakePlusTag: row.intakePlusTag || "",
            intakeEmailAccountId: row.intakeEmailAccountId || "",
            scorecardFormId: row.scorecardFormId || "",
            applicationCount: counts[row.jobOpeningId]?.open || 0,
            applicationTotal: counts[row.jobOpeningId]?.all || 0,
            canEdit: recruitEdits(userScope, row.organizationPartyId),
            revision: String(stampOf(row))
        }
    })
}
// find#Openings: the openings of the employers the recruiter reads (one asked for, ORGANIZATION_DENIED outside), by state, and a
// search of the title ignoring case; the closed ones only when asked for (statusId JoClosed or includeClosed). Paged.
function findOpenings(p) {
    const userScope = recruiterScope()
    if (!blank(p.organizationPartyId)) people.requireOrganization(userScope, text(p.organizationPartyId))
    const organizationPartyIds = blank(p.organizationPartyId)
        ? Array.from(userScope.organizationPartyIds)
        : [text(p.organizationPartyId)]
    if (!organizationPartyIds.length) return lib.pageList([], p, "openings")
    let query = find(OPENING).condition("organizationPartyId", "in", organizationPartyIds)
    if (!blank(p.jobOpeningId)) query = query.condition("jobOpeningId", text(p.jobOpeningId))
    if (!blank(p.statusId)) query = query.condition("statusId", text(p.statusId))
    else if (!truthy(p.includeClosed)) query = query.condition("statusId", "in", ["JoDraft", "JoOpen"])
    if (!blank(p.term))
        query = query.condition(ec.entity.conditionFactory.makeCondition("title", "like", likeText(text(p.term))).ignoreCase())
    const found = openingRows(userScope, Array.from(query.orderBy("title").limit(listCap).list()))
    return lib.pageList(found, p, "openings", {noLimitCap: listCap})
}
// The seats an opening fills: approved active positions (EmpsActive, in effect now) of the employer; at least one.
function checkSeats(organizationPartyId, positionIds) {
    if (!positionIds.length) denied("POSITION_REQUIRED", "Choose the approved seats the opening fills")
    for (const emplPositionId of positionIds) {
        const position = one(POSITION, {emplPositionId})
        if (!position || position.organizationPartyId !== organizationPartyId)
            denied("POSITION_UNAVAILABLE", "Position " + emplPositionId + " is not a seat of the employer")
        const active =
            position.statusId === "EmpsActive" &&
            (ms(position.fromDate) ?? -Infinity) <= nowMs() &&
            (ms(position.thruDate) ?? Infinity) > nowMs()
        if (!active)
            denied(
                "POSITION_NOT_APPROVED",
                (position.description || emplPositionId) + " is not an approved active seat: its activation is approved first"
            )
    }
}
// Whether a person is employed by the employer, or one of its agents, now.
const worksFor = (partyId, organizationPartyId) =>
    !!partyId &&
    !!one("mantle.party.Person", {partyId}) &&
    people
        .current(
            find(RELATIONSHIP)
                .condition("fromPartyId", partyId)
                .condition("toPartyId", organizationPartyId)
                .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"]),
            null
        )
        .count() > 0
const enabledAccount = account => !!account && account.disabled !== "Y" && (ms(account.terminateDate) ?? Infinity) > nowMs()
// A recruiting owner: the caller, or a person employed by the employer or one of its agents now.
function checkOwner(userScope, ownerPartyId, organizationPartyId) {
    if (ownerPartyId === userScope.partyId) return
    if (!worksFor(ownerPartyId, organizationPartyId)) denied("OWNER_INVALID", "The recruiting owner works for the employer")
}
// store#Opening: a new opening (a draft, or open with action open) of an employer in the recruiter's scope, or a change of one
// at the revision read; action open, close or reopen. Its seats are approved active positions of the employer; its plus tag is
// one no other draft or open opening has; its scorecard a published form of the interview scorecard purpose of the employer.
function storeOpening(p) {
    const userScope = recruiterScope(true)
    let opening = null
    if (!blank(p.jobOpeningId)) {
        opening = readableOpening(userScope, p.jobOpeningId)
        checkRevision(opening, p.revision)
    }
    const organizationPartyId = opening ? opening.organizationPartyId : text(p.organizationPartyId)
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    if (opening && !blank(p.organizationPartyId) && text(p.organizationPartyId) !== organizationPartyId)
        denied("EMPLOYER_CHANGE", "An opening stays its employer's")
    people.requireOrganization(userScope, organizationPartyId)
    const values = {}
    if (!opening || p.title != null) {
        const title = text(p.title)
        if (!title) denied("TITLE_REQUIRED", "An opening needs a title")
        if (title.includes("${")) denied("NO_EXPRESSIONS", "A title is text, not an expression")
        values.title = title.substring(0, 255)
    }
    if (p.description != null) values.description = text(p.description) || null
    if (!opening || p.ownerPartyId != null) {
        const ownerPartyId = text(p.ownerPartyId) || userScope.partyId
        if (!ownerPartyId) denied("OWNER_REQUIRED", "Choose the recruiting owner")
        checkOwner(userScope, ownerPartyId, organizationPartyId)
        values.ownerPartyId = ownerPartyId
    }
    if (p.internalOnly != null) values.internalOnly = truthy(p.internalOnly) ? "Y" : "N"
    if (p.fromDate != null) values.fromDate = blank(p.fromDate) ? null : p.fromDate
    if (p.thruDate != null) values.thruDate = blank(p.thruDate) ? null : p.thruDate
    const fromMs = values.fromDate !== undefined ? ms(values.fromDate) : ms(opening?.fromDate)
    const thruMs = values.thruDate !== undefined ? ms(values.thruDate) : ms(opening?.thruDate)
    if (fromMs != null && thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "The closing is after the opening")
    if (p.intakePlusTag != null) {
        const tag = text(p.intakePlusTag).toLowerCase()
        if (tag && !/^[a-z0-9][a-z0-9._-]{1,40}$/.test(tag))
            denied("TAG_INVALID", "A plus tag is letters, digits, dots, dashes and underscores")
        if (tag) {
            const taken = Array.from(
                find(OPENING).condition("intakePlusTag", tag).condition("statusId", "in", ["JoDraft", "JoOpen"]).list()
            ).some(row => row.jobOpeningId !== opening?.jobOpeningId)
            if (taken) denied("TAG_TAKEN", "Another opening takes mail with the plus tag " + tag)
        }
        values.intakePlusTag = tag || null
    }
    if (p.intakeEmailAccountId != null) {
        const accountId = text(p.intakeEmailAccountId)
        if (accountId && !one("moqui.basic.email.EmailAccount", {emailAccountId: accountId}))
            denied("ACCOUNT_INVALID", "Mail account " + accountId + " is not available")
        values.intakeEmailAccountId = accountId || null
    }
    if (p.scorecardFormId != null)
        values.scorecardFormId = blank(p.scorecardFormId)
            ? null
            : forms().publishedFormFor(SCORECARD, organizationPartyId, text(p.scorecardFormId))
    const positionIds = p.emplPositionIds != null ? unique(listOf(p.emplPositionIds)) : null
    const action = text(p.action)
    const status = opening?.statusId || "JoDraft"
    if (action && !["open", "close", "reopen"].includes(action))
        denied("ACTION_INVALID", action + " is not open, close or reopen")
    if (action === "open" || action === "reopen") {
        if (status === "JoOpen") denied("ALREADY_OPEN", "The opening is open")
        values.statusId = "JoOpen"
        if ((thruMs ?? Infinity) <= nowMs()) values.thruDate = null
        if (fromMs == null) values.fromDate = ec.user.nowTimestamp
    } else if (action === "close") {
        if (status !== "JoOpen") denied("NOT_OPEN", "Only an open opening closes")
        values.statusId = "JoClosed"
        if ((thruMs ?? Infinity) > nowMs()) values.thruDate = ec.user.nowTimestamp
    }
    const seats =
        positionIds ??
        (opening ? rows(OPENING_POSITION, {jobOpeningId: opening.jobOpeningId}).map(row => row.emplPositionId) : [])
    // an opening is only ever over approved active seats (checked again when it opens)
    if (positionIds || (values.statusId || status) === "JoOpen") checkSeats(organizationPartyId, seats)
    let jobOpeningId = opening?.jobOpeningId
    if (!opening)
        jobOpeningId = call(
            "create#" + OPENING,
            Object.assign(
                {
                    organizationPartyId,
                    statusId: values.statusId || "JoDraft",
                    createdDate: ec.user.nowTimestamp,
                    createdByUserId: ec.user.userId
                },
                values
            )
        ).jobOpeningId
    else if (Object.keys(values).length)
        call(
            "update#" + OPENING,
            Object.assign({jobOpeningId}, values, p.changeReason ? {statusId_changeReason: text(p.changeReason)} : {})
        )
    if (positionIds) {
        for (const row of rows(OPENING_POSITION, {jobOpeningId})) if (!positionIds.includes(row.emplPositionId)) row.delete()
        const existing = new Set(rows(OPENING_POSITION, {jobOpeningId}).map(row => row.emplPositionId))
        for (const emplPositionId of positionIds)
            if (!existing.has(emplPositionId)) call("create#" + OPENING_POSITION, {jobOpeningId, emplPositionId})
    }
    return {jobOpeningId}
}

// ===== applications =====
// The next interview of each application: {employmentApplicationId: startMs}.
function nextInterviews(applicationIds) {
    const found = {}
    if (!applicationIds.length) return found
    const interviews = Array.from(find(INTERVIEW).condition("employmentApplicationId", "in", applicationIds).list())
    if (!interviews.length) return found
    const events = new Map(
        Array.from(
            find(WORK)
                .condition(
                    "workEffortId",
                    "in",
                    interviews.map(row => row.workEffortId)
                )
                .list()
        ).map(row => [row.workEffortId, row])
    )
    for (const interview of interviews) {
        const event = events.get(interview.workEffortId)
        const startMs = ms(event?.estimatedStartDate)
        if (!event || event.statusId === "WeCancelled" || startMs == null || startMs < nowMs()) continue
        const current = found[interview.employmentApplicationId]
        if (current == null || startMs < current) found[interview.employmentApplicationId] = startMs
    }
    return found
}
function applicationRows(userScope, applications) {
    if (!applications.length) return []
    const ids = applications.map(row => row.employmentApplicationId)
    const names = people.personNames(unique(applications.map(row => row.applyingPartyId)))
    const titles = openingTitles(applications.map(row => row.jobOpeningId))
    const openings = new Map(
        unique(applications.map(row => row.jobOpeningId)).length
            ? Array.from(
                  find(OPENING)
                      .condition("jobOpeningId", "in", unique(applications.map(row => row.jobOpeningId)))
                      .list()
              ).map(row => [row.jobOpeningId, row])
            : []
    )
    const owners = people.personNames(unique(Array.from(openings.values()).map(row => row.ownerPartyId)))
    const next = nextInterviews(ids)
    return applications.map(row => ({
        employmentApplicationId: row.employmentApplicationId,
        applicantPartyId: row.applyingPartyId,
        applicantName: names[row.applyingPartyId] || row.applyingPartyId || "",
        jobOpeningId: row.jobOpeningId || null,
        openingTitle: titles[row.jobOpeningId] || "",
        organizationPartyId: row.organizationPartyId,
        statusId: row.statusId,
        stageText: stageTexts[row.statusId] || row.statusId || "",
        stageColor: stageColors[row.statusId] || "grey",
        ownerName: owners[openings.get(row.jobOpeningId)?.ownerPartyId] || "",
        applicationDateText: dateText(row.applicationDate),
        nextInterviewText: next[row.employmentApplicationId] ? whenText(next[row.employmentApplicationId]) : "",
        sourceText: row.referredByEnumId ? one("moqui.basic.Enumeration", {enumId: row.referredByEnumId})?.description || "" : "",
        possibleDuplicate: !!row.duplicateOfApplicationId,
        canEdit: recruitEdits(userScope, row.organizationPartyId),
        canMove: recruitEdits(userScope, row.organizationPartyId) && !!moves[row.statusId],
        revision: String(stampOf(row))
    }))
}
// find#Applications: a recruiter's applications of the employers in scope (of one opening, ORGANIZATION_DENIED or not available
// outside), by stage (the closed stages only when asked), and a search of the applicant's name ignoring case. Paged; stages
// gives each stage's count for the board.
function findApplications(p) {
    const userScope = recruiterScope()
    const organizationPartyIds = Array.from(userScope.organizationPartyIds)
    if (!organizationPartyIds.length) return Object.assign(lib.pageList([], p, "applications"), {stages: []})
    let query = find(APPLICATION).condition("organizationPartyId", "in", organizationPartyIds)
    if (!blank(p.jobOpeningId)) query = query.condition("jobOpeningId", readableOpening(userScope, p.jobOpeningId).jobOpeningId)
    const stageIds = listOf(p.statusId)
    if (stageIds.length) query = query.condition("statusId", "in", stageIds)
    else if (!truthy(p.includeClosed)) query = query.condition("statusId", "in", openStages)
    if (!blank(p.term)) {
        const factory = ec.entity.conditionFactory
        const term = likeText(text(p.term))
        const partyIds = Array.from(
            find("mantle.party.Person")
                .condition(
                    factory.makeCondition(
                        ["firstName", "lastName"].map(field => factory.makeCondition(field, "like", term).ignoreCase()),
                        "or"
                    )
                )
                .selectField("partyId")
                .limit(500)
                .list()
        ).map(row => row.partyId)
        query = query.condition("applyingPartyId", "in", partyIds.length ? partyIds : ["_NA_"])
    }
    const found = applicationRows(userScope, Array.from(query.orderBy("-applicationDate").limit(listCap).list()))
    const stages = Object.keys(stageTexts)
        .filter(statusId => truthy(p.includeClosed) || stageIds.includes(statusId) || openStages.includes(statusId))
        .map(statusId => ({
            statusId,
            stageText: stageTexts[statusId],
            count: found.filter(row => row.statusId === statusId).length,
            dropAllowed: !["EaHired"].includes(statusId)
        }))
    return Object.assign(lib.pageList(found, p, "applications", {noLimitCap: listCap}), {stages})
}
// An open application of the same person to the same employer (a possible duplicate), other than one given.
function duplicateOf(partyId, organizationPartyId, exceptId = null) {
    return (
        Array.from(
            find(APPLICATION)
                .condition("applyingPartyId", partyId)
                .condition("organizationPartyId", organizationPartyId)
                .condition("statusId", "in", openStages)
                .orderBy("applicationDate")
                .list()
        ).find(row => row.employmentApplicationId !== exceptId)?.employmentApplicationId || null
    )
}
// The person of an exact email address in effect (not a disabled party nor anyone's private contact), or null.
function personByEmail(address) {
    const email = text(address).toLowerCase()
    if (!email.includes("@")) return null
    for (const info of Array.from(
        people.current(find("mantle.party.contact.PartyContactMechInfo").condition("infoString", email), null).list()
    )) {
        const party = one("mantle.party.PartyDetail", {partyId: info.partyId})
        if (!party || party.disabled === "Y" || party.privateOwnerUserId || party.partyTypeEnumId !== "PtyPerson") continue
        return info.partyId
    }
    return null
}
// The applicant of a new application: a person chosen by id who is related to the employer (an employee, an agent, or an
// applicant to one of its openings: RECORD_UNAVAILABLE otherwise, as a missing one), the person of the email given, or a new
// person with the Applicant role and the email.
function applicantOf(p, organizationPartyId) {
    if (!blank(p.applicantPartyId)) {
        const partyId = text(p.applicantPartyId)
        const related =
            people
                .current(find(RELATIONSHIP).condition("fromPartyId", partyId).condition("toPartyId", organizationPartyId), null)
                .count() > 0 ||
            find(APPLICATION)
                .condition("applyingPartyId", partyId)
                .condition("organizationPartyId", organizationPartyId)
                .count() > 0
        if (!one("mantle.party.Person", {partyId}) || !related) unavailable("Person", partyId)
        return partyId
    }
    const found = personByEmail(p.emailAddress)
    if (found) return found
    const firstName = text(p.firstName)
    const lastName = text(p.lastName)
    if (!firstName || !lastName) denied("NAME_REQUIRED", "Name the applicant, or choose them")
    const partyId = call("mantle.party.PartyServices.create#Person", {
        firstName: firstName.substring(0, 60),
        lastName: lastName.substring(0, 60)
    }).partyId
    if (!blank(p.emailAddress))
        call("mantle.party.ContactServices.create#EmailAddress", {
            partyId,
            emailAddress: text(p.emailAddress).toLowerCase(),
            contactMechPurposeId: "EmailPrimary"
        })
    return partyId
}
// The referral of an application: a source of the referral vocabulary and, for a personal referral, the employee who referred
// (employed by the employer now).
function referralOf(p, organizationPartyId) {
    const values = {}
    if (p.referredByEnumId != null) {
        const enumId = text(p.referredByEnumId)
        if (enumId && !one("moqui.basic.Enumeration", {enumId, enumTypeId: "EmploymentApplicationReferredBy"}))
            denied("SOURCE_INVALID", enumId + " is not a source of applications")
        values.referredByEnumId = enumId || null
    }
    if (p.referredByPartyId != null) {
        const partyId = text(p.referredByPartyId)
        if (
            partyId &&
            !people
                .current(
                    find(RELATIONSHIP)
                        .condition("relationshipTypeEnumId", "PrtEmployee")
                        .condition("fromPartyId", partyId)
                        .condition("toPartyId", organizationPartyId),
                    null
                )
                .count()
        )
            denied("REFERRER_INVALID", "The referrer is an employee of the employer")
        values.referredByPartyId = partyId || null
    }
    return values
}
// The application row of a new application to an open opening, its applicant with the Applicant role.
function makeApplication(opening, partyId, values) {
    call("mantle.party.PartyServices.ensure#PartyRole", {partyId, roleTypeId: "Applicant"})
    const duplicate = duplicateOf(partyId, opening.organizationPartyId)
    const employmentApplicationId = call(
        "create#" + APPLICATION,
        Object.assign(
            {
                jobOpeningId: opening.jobOpeningId,
                organizationPartyId: opening.organizationPartyId,
                applyingPartyId: partyId,
                statusId: "EaReceived",
                applicationDate: ec.user.nowTimestamp,
                duplicateOfApplicationId: duplicate,
                createdByUserId: ec.user.userId || null
            },
            values
        )
    ).employmentApplicationId
    return {employmentApplicationId, duplicateOfApplicationId: duplicate}
}
// create#Application: a recruiter (PEOPLE_RECRUIT_EDIT) records an application to an open opening of an employer in scope
// (OPENING_CLOSED for one that takes none), for a person chosen or named; a possible duplicate (another open application of the
// person to the employer) is flagged, never merged.
function createApplication(p) {
    const userScope = recruiterScope(true)
    const opening = readableOpening(userScope, p.jobOpeningId)
    if (!isOpen(opening)) denied("OPENING_CLOSED", (opening.title || opening.jobOpeningId) + " takes no application now")
    const partyId = applicantOf(p, opening.organizationPartyId)
    const values = Object.assign(referralOf(p, opening.organizationPartyId), {
        contactAllowed: truthy(p.contactAllowed) ? "Y" : "N",
        comments: text(p.comments) || null
    })
    if (!blank(p.applicationDate)) values.applicationDate = p.applicationDate
    return Object.assign({applicantPartyId: partyId}, makeApplication(opening, partyId, values))
}
// store#Application: a recruiter changes an application's opening (another open opening of the same employer), source,
// referral, contact permission or notes, at the revision read; a closed application keeps its opening.
function storeApplication(p) {
    const userScope = recruiterScope(true)
    const application = editableApplication(userScope, p.employmentApplicationId)
    checkRevision(application, p.revision)
    const values = referralOf(p, application.organizationPartyId)
    if (!blank(p.jobOpeningId) && text(p.jobOpeningId) !== application.jobOpeningId) {
        const opening = readableOpening(userScope, p.jobOpeningId)
        if (opening.organizationPartyId !== application.organizationPartyId)
            denied("EMPLOYER_CHANGE", "An application moves only to another opening of the same employer")
        if (!isOpen(opening)) denied("OPENING_CLOSED", (opening.title || opening.jobOpeningId) + " takes no application now")
        if (!openStages.includes(application.statusId)) denied("APPLICATION_CLOSED", "A closed application keeps its opening")
        values.jobOpeningId = opening.jobOpeningId
    }
    if (p.contactAllowed != null) values.contactAllowed = truthy(p.contactAllowed) ? "Y" : "N"
    if (p.comments != null) values.comments = text(p.comments) || null
    if (Object.keys(values).length)
        call("update#" + APPLICATION, Object.assign({employmentApplicationId: application.employmentApplicationId}, values))
    return {employmentApplicationId: application.employmentApplicationId}
}
// Why a stage change of an application is refused, or null: its stage's moves, an interview before Interview, an offer before
// Offer (P17), never Hired.
function stageProblem(application, statusId) {
    if (statusId === "EaHired")
        return ["HIRED_BY_OFFER", "An applicant is hired from an accepted offer, never by moving the application"]
    if (!stageTexts[statusId]) return ["STAGE_INVALID", statusId + " is not a stage"]
    if (!moves[application.statusId])
        return [
            "APPLICATION_CLOSED",
            "The application is " + (stageTexts[application.statusId] || application.statusId).toLowerCase()
        ]
    if (application.statusId === statusId) return ["SAME_STAGE", "The application is already at " + stageTexts[statusId]]
    if (!moves[application.statusId].includes(statusId))
        return [
            "STAGE_INVALID",
            "An application at " + stageTexts[application.statusId] + " does not move to " + stageTexts[statusId]
        ]
    if (statusId === "EaInterview" && !rows(INTERVIEW, {employmentApplicationId: application.employmentApplicationId}).length)
        return ["INTERVIEW_REQUIRED", "Schedule an interview: it moves the application to Interview"]
    if (statusId === "EaOffer") return ["OFFER_REQUIRED", "Make an offer first: it moves the application to Offer"]
    return null
}
// change#ApplicationStage: a recruiter moves applications (employmentApplicationIds, or one with its revision) to a stage with a
// reason (the status's audit change reason), each in its own transaction under the stage rules (stageProblem), a refused or
// failed one named with its code and the rest going on.
function changeApplicationStage(p) {
    const userScope = recruiterScope(true)
    const statusId = text(p.statusId)
    const ids = unique(
        listOf(p.employmentApplicationIds).concat(blank(p.employmentApplicationId) ? [] : [text(p.employmentApplicationId)])
    )
    if (!ids.length) denied("APPLICATION_REQUIRED", "Choose the applications to move")
    const reason = text(p.reason) || null
    const changed = []
    const failures = []
    const names = people.personNames(
        unique(
            Array.from(find(APPLICATION).condition("employmentApplicationId", "in", ids).list()).map(row => row.applyingPartyId)
        )
    )
    for (const employmentApplicationId of ids) {
        ec.message.pushErrors()
        let applicantName = ""
        let done = false
        try {
            ec.transaction.runRequireNew(null, "Moving application " + employmentApplicationId + " failed", () => {
                const application = editableApplication(userScope, employmentApplicationId)
                applicantName = names[application.applyingPartyId] || application.applyingPartyId || ""
                if (!recruitEdits(userScope, application.organizationPartyId)) unavailable("Application", employmentApplicationId)
                if (ids.length === 1) checkRevision(application, p.revision)
                const problem = stageProblem(application, statusId)
                if (problem) denied(problem[0], problem[1])
                call("update#" + APPLICATION, {employmentApplicationId, statusId, statusId_changeReason: reason})
                if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                done = true
            })
            if (done) changed.push(employmentApplicationId)
        } catch (error) {
            const code = lib.reasonCode(error)
            if (!code) ec.logger.error("Moving application " + employmentApplicationId + " failed: " + error.message)
            failures.push({
                employmentApplicationId,
                applicantName: applicantName || names[one(APPLICATION, {employmentApplicationId})?.applyingPartyId] || "",
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
    return {changedIds: changed, failures, stageText: stageTexts[statusId] || statusId}
}

// ===== interviews and scorecards =====
// The interviews of applications with their events and scorecard assignments.
function interviewsOf(applicationIds) {
    if (!applicationIds.length) return []
    const interviews = Array.from(find(INTERVIEW).condition("employmentApplicationId", "in", applicationIds).list())
    if (!interviews.length) return []
    const eventIds = interviews.map(row => row.workEffortId)
    const events = new Map(
        Array.from(find(WORK).condition("workEffortId", "in", eventIds).list()).map(row => [row.workEffortId, row])
    )
    const invitations = Array.from(
        find(INVITATION)
            .condition("contextEntityName", WORK)
            .condition("contextId", "in", eventIds)
            .condition("recordEntityName", APPLICATION)
            .list()
    )
    return interviews
        .map(row => ({
            row,
            event: events.get(row.workEffortId),
            invitations: invitations.filter(item => item.contextId === row.workEffortId)
        }))
        .filter(item => item.event)
        .sort((a, b) => (ms(a.event.estimatedStartDate) ?? 0) - (ms(b.event.estimatedStartDate) ?? 0))
}
// The scorecards of an interview the caller reads: every one for a recruiter, the caller's own for a panel member; each with
// its reviewer, state and, when answered, its answers with the form as of then (the scorecard text is opted out of AI on the
// screens that show it).
function scorecardRows(invitationRows, access, partyId) {
    const shown = invitationRows.filter(row => access === "recruiter" || row.partyId === partyId)
    const names = people.personNames(unique(shown.map(row => row.partyId)))
    return shown.map(row => {
        let answers = []
        if (row.formResponseId) {
            const response = one("moqui.screen.form.FormResponse", {formResponseId: row.formResponseId})
            const responseMap = {}
            for (const answer of rows("moqui.screen.form.FormResponseAnswer", {formResponseId: row.formResponseId}))
                responseMap[answer.fieldName] = answer.valueText
            answers = response ? forms().answersOf(row.formId, response.responseDate, responseMap) : []
        }
        return {
            invitationId: row.invitationId,
            formId: row.formId,
            workEffortId: row.contextId,
            reviewerPartyId: row.partyId,
            reviewerName: names[row.partyId] || row.partyId || "",
            own: row.partyId === partyId,
            answered: !!row.formResponseId,
            stateText: row.formResponseId ? "Submitted " + dateText(row.responseDate) : "Waiting",
            answers,
            summaryText: answers.map(answer => answer.title + ": " + answer.displayText).join(" · ")
        }
    })
}
function interviewRows(items, access, partyId) {
    const people_ = people.personNames(unique(items.flatMap(item => item.invitations.map(row => row.partyId))))
    return items.map(({row, event, invitations}) => {
        const startMs = ms(event.estimatedStartDate)
        const endMs = ms(event.estimatedCompletionDate)
        return {
            workEffortId: row.workEffortId,
            title: event.workEffortName || "",
            whenText: whenText(startMs, endMs),
            startMs,
            endMs,
            cancelled: event.statusId === "WeCancelled",
            location: access === "recruiter" || invitations.some(item => item.partyId === partyId) ? event.location || "" : "",
            hasCall: !!row.callLinkId,
            panelText: invitations.map(item => people_[item.partyId] || item.partyId).join(", "),
            scorecards: scorecardRows(invitations, access, partyId)
        }
    })
}
// get#Application: an application the caller reads, as a recruiter (everything, every scorecard) or a panel member (the
// applicant's name, the opening, the stage, the files and their interviews, and their own scorecards to answer or answered).
// The files of an application a recruiter shared with its interview panels.
function sharedFiles(employmentApplicationId) {
    return rows(CONTENT, {employmentApplicationId})
        .filter(file => file.panelShared === "Y" && !!file.contentLocation)
        .sort((a, b) => (ms(b.contentDate) ?? 0) - (ms(a.contentDate) ?? 0))
        .map(file => ({
            applicationContentId: file.applicationContentId,
            description: fileName(file),
            typeText: one("moqui.basic.Enumeration", {enumId: file.contentTypeEnumId})?.description || "",
            contentDateText: dateText(file.contentDate)
        }))
}
const fileName = file =>
    file.description ||
    String(file.contentLocation || "")
        .split("/")
        .pop() ||
    file.applicationContentId
// The interviews of an application a party is on the panel of (their scorecard assignments name them).
const panelInterviews = (employmentApplicationId, partyId) =>
    interviewsOf([employmentApplicationId]).filter(item => item.invitations.some(row => row.partyId === partyId))
// What a panel member reads of an application they interview (the user's call of Nov 12, 2026): the applicant's name, the
// opening and its employer, their own interviews with their own scorecard, and the files shared with the panel; nothing else.
function panelView(application, partyId) {
    const names = people.personNames([application.applyingPartyId])
    const interviews = interviewRows(panelInterviews(application.employmentApplicationId, partyId), "panel", partyId)
    return {
        employmentApplicationId: application.employmentApplicationId,
        access: "panel",
        applicantName: names[application.applyingPartyId] || "",
        jobOpeningId: application.jobOpeningId || null,
        openingTitle: openingTitles([application.jobOpeningId])[application.jobOpeningId] || "",
        organizationPartyId: application.organizationPartyId,
        openingOrganizationName:
            people.organizationNames([application.organizationPartyId])[application.organizationPartyId] || "",
        stageText: "",
        possibleDuplicate: false,
        canEdit: false,
        canMove: false,
        nextStages: [],
        files: [],
        sharedFiles: sharedFiles(application.employmentApplicationId),
        interviews,
        myScorecards: interviews.flatMap(interview =>
            interview.scorecards
                .filter(card => card.own)
                .map(card => Object.assign({}, card, {interviewText: interview.whenText}))
        )
    }
}
function getApplication(p) {
    const userScope = people.scopeOf()
    const {application, access} = readableApplication(userScope, p.employmentApplicationId)
    if (access === "panel") return {application: panelView(application, userScope.partyId)}
    const row = applicationRows(userScope, [application])[0]
    const opening = application.jobOpeningId ? one(OPENING, {jobOpeningId: application.jobOpeningId}) : null
    const recruiter = access === "recruiter"
    const files = rows(CONTENT, {employmentApplicationId: application.employmentApplicationId})
        .sort((a, b) => (ms(b.contentDate) ?? 0) - (ms(a.contentDate) ?? 0))
        .map(file => ({
            applicationContentId: file.applicationContentId,
            description: fileName(file),
            typeText: one("moqui.basic.Enumeration", {enumId: file.contentTypeEnumId})?.description || "",
            contentDateText: dateText(file.contentDate),
            hasFile: !!file.contentLocation,
            panelShared: file.panelShared === "Y"
        }))
    const interviews = interviewRows(interviewsOf([application.employmentApplicationId]), access, userScope.partyId)
    const out = Object.assign(row, {
        access,
        sharedFiles: sharedFiles(application.employmentApplicationId),
        canEdit: recruiter && row.canEdit,
        openingOrganizationName:
            people.organizationNames([application.organizationPartyId])[application.organizationPartyId] || "",
        openingTakesApplications: isOpen(opening),
        files,
        interviews,
        myScorecards: interviews.flatMap(interview =>
            interview.scorecards
                .filter(card => card.own)
                .map(card => Object.assign({}, card, {interviewText: interview.whenText}))
        ),
        nextStages:
            recruiter && row.canEdit
                ? (moves[application.statusId] || []).map(statusId => ({value: statusId, label: stageTexts[statusId]}))
                : []
    })
    if (recruiter) {
        const referrer = application.referredByPartyId
        Object.assign(out, {
            emailAddress: applicantEmails([application.applyingPartyId])[application.applyingPartyId] || "",
            referredByEnumId: application.referredByEnumId || "",
            referredByPartyId: referrer || "",
            referredByName: referrer ? people.personNames([referrer])[referrer] || referrer : "",
            contactAllowed: application.contactAllowed === "Y",
            comments: application.comments || "",
            duplicateOfApplicationId: application.duplicateOfApplicationId || "",
            canSchedule: row.canEdit && ["EaReceived", "EaScreening", "EaInterview"].includes(application.statusId),
            scorecardFormId: opening?.scorecardFormId || ""
        })
    }
    return {application: out}
}
// A panel member: a person employed by the employer now, with an account to answer in (PANEL_INVALID otherwise).
function checkPanel(partyIds, organizationPartyId) {
    if (!partyIds.length) denied("PANEL_REQUIRED", "Choose who interviews")
    const employed = people.employersOfParties(partyIds, null)
    for (const partyId of partyIds) {
        const account = find("moqui.security.UserAccount").condition("partyId", partyId).list()
        const hasAccount = Array.from(account).some(user => user.disabled !== "Y")
        if (!(employed[partyId] || []).includes(organizationPartyId) || !hasAccount)
            denied(
                "PANEL_INVALID",
                (people.personNames([partyId])[partyId] || partyId) + " is not an employee of the employer with an account"
            )
    }
}
// The site's own address for a link in an invitation, from the webapp properties (empty: a path alone).
function siteUrl() {
    const property = name => {
        const value = System.getProperty(name)
        return value == null ? "" : String(value).trim()
    }
    const host = property("webapp_http_host")
    if (!host) return ""
    const https = property("webapp_https_port")
    if (https) return "https://" + host + (https === "443" ? "" : ":" + https)
    const http = property("webapp_http_port")
    return "http://" + host + (!http || http === "80" ? "" : ":" + http)
}
// schedule#Interview: a recruiter schedules an interview of an application that is not closed past Interview: a private event
// (WetEvent, WevRestricted) from start for minutes, owned by the caller, at a location or on a video call (create#CallLink:
// the link in the event's location, so the iMIP invitation carries it), with the panel (employees of the employer with an
// account) and, when asked, the candidate as attendees; each panel member assigned the scorecard (the form given, else the
// opening's, else the employer's only published interview scorecard; SCORECARD_REQUIRED for none) with no link. Moves a
// received or screening application to Interview. The invitations go after (send#EventInvitations: a user is notified, the
// candidate gets an email with the .ics); a failure to send is named and the interview stays.
function scheduleInterview(p) {
    const userScope = recruiterScope(true)
    const application = editableApplication(userScope, p.employmentApplicationId)
    if (!recruitEdits(userScope, application.organizationPartyId)) unavailable("Application", p.employmentApplicationId)
    if (!["EaReceived", "EaScreening", "EaInterview"].includes(application.statusId))
        denied("APPLICATION_CLOSED", "Only an application before its offer is interviewed")
    const opening = application.jobOpeningId ? one(OPENING, {jobOpeningId: application.jobOpeningId}) : null
    const startMs = blank(p.startDate) ? null : Number(ms(p.startDate))
    if (startMs == null || !Number.isFinite(startMs)) denied("START_REQUIRED", "Choose when the interview starts")
    if (startMs < nowMs() - 5 * 60 * 1000) denied("DATE_PAST", "An interview is scheduled from now on")
    const minutes = blank(p.durationMinutes) ? 60 : Number(p.durationMinutes)
    if (!Number.isInteger(minutes) || minutes < 10 || minutes > 480)
        denied("DURATION_INVALID", "An interview lasts 10 minutes to 8 hours")
    const endMs = startMs + minutes * 60 * 1000
    const panel = unique(listOf(p.panelPartyIds))
    checkPanel(panel, application.organizationPartyId)
    const formId = forms().publishedFormFor(
        SCORECARD,
        application.organizationPartyId,
        text(p.formId) || opening?.scorecardFormId || null
    )
    if (!formId) denied("SCORECARD_REQUIRED", "Choose the scorecard the panel answers: publish one under People settings, Forms")
    const video = truthy(p.videoCall)
    const inviteCandidate = truthy(p.inviteCandidate)
    const candidateEmail = applicantEmails([application.applyingPartyId])[application.applyingPartyId] || ""
    if (inviteCandidate && !candidateEmail) denied("CANDIDATE_NO_EMAIL", "The applicant has no email address to invite")
    const title = "Interview: " + (opening?.title || "application " + application.employmentApplicationId)
    let location = text(p.location) || null
    let callLinkId = null
    let callPath = null
    if (video) {
        const hours = Math.min(90 * 24, Math.max(24, Math.ceil((endMs - nowMs()) / hourMs) + 24))
        const link = call("org.moqui.call.CallServices.create#CallLink", {
            name: title.substring(0, 200),
            policy: "lobby",
            video: true,
            expiryHours: hours
        })
        if (!link.callLinkId) denied(link.reasonCode || "CALL_UNAVAILABLE", "The video call link was not made")
        callLinkId = link.callLinkId
        callPath = link.path
        location = siteUrl() + link.path
    }
    const ownerPartyId = userScope.partyId
    if (!ownerPartyId) denied("PARTY_REQUIRED", "Scheduling needs your own person record")
    const workEffortId = call("mantle.work.EventServices.create#Event", {
        workEffortName: title.substring(0, 255),
        workEffortTypeEnumId: "WetEvent",
        visibilityEnumId: "WevRestricted",
        ownerPartyId,
        estimatedStartDate: stamp(startMs),
        estimatedCompletionDate: stamp(endMs),
        location,
        description: text(p.note) || null
    }).workEffortId
    const now = ec.user.nowTimestamp
    call("create#" + WORK_PARTY, {
        workEffortId,
        partyId: ownerPartyId,
        roleTypeId: "Assignee",
        fromDate: now,
        statusId: "WeptAssigned"
    })
    const attendees = panel.filter(partyId => partyId !== ownerPartyId)
    if (inviteCandidate) attendees.push(application.applyingPartyId)
    for (const partyId of attendees)
        call("create#" + WORK_PARTY, {
            workEffortId,
            partyId,
            roleTypeId: "Assignee",
            fromDate: now,
            statusId: "WeptOffered",
            mustRsvp: "Y"
        })
    call("create#" + INTERVIEW, {
        workEffortId,
        employmentApplicationId: application.employmentApplicationId,
        jobOpeningId: application.jobOpeningId,
        organizationPartyId: application.organizationPartyId,
        formId,
        callLinkId,
        createdDate: now,
        createdByUserId: ec.user.userId
    })
    const invitationIds = panel.map(
        partyId =>
            call("create#" + INVITATION, {
                formId,
                organizationPartyId: application.organizationPartyId,
                partyId,
                contextEntityName: WORK,
                contextId: workEffortId,
                recordEntityName: APPLICATION,
                recordId: application.employmentApplicationId,
                invitationKey: "interview:" + workEffortId + ":" + partyId,
                statusEnumId: "FinSent",
                sentDate: now,
                createdDate: now
            }).invitationId
    )
    if (["EaReceived", "EaScreening"].includes(application.statusId))
        call("update#" + APPLICATION, {
            employmentApplicationId: application.employmentApplicationId,
            statusId: "EaInterview",
            statusId_changeReason: "Interview scheduled"
        })
    let invitationsSent = true
    let invitationProblem = null
    ec.message.pushErrors()
    try {
        call("mantle.work.EventServices.send#EventInvitations", {
            workEffortId,
            eventUrl: "/qapps/People/Staffing/InterviewsCalendar/EventDetail?workEffortId=" + encodeURIComponent(workEffortId)
        })
    } catch (error) {
        invitationsSent = false
        invitationProblem = String(error.message || error)
        ec.logger.error("Interview " + workEffortId + ": the invitations were not sent: " + invitationProblem)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return {workEffortId, invitationIds, callPath, invitationsSent, invitationProblem}
}
// submit#Scorecard: a panel member answers the scorecard assigned to them (the invitation's party is the caller's: another's is
// not available), once (ALREADY_ANSWERED), the values checked against the form as of now (FORM_VALUES_INVALID).
function submitScorecard(p) {
    const userScope = people.scopeOf()
    const invitation = blank(p.invitationId) ? null : one(INVITATION, {invitationId: text(p.invitationId)})
    if (
        !invitation ||
        invitation.recordEntityName !== APPLICATION ||
        !userScope.partyId ||
        invitation.partyId !== userScope.partyId
    )
        unavailable("Scorecard", p.invitationId)
    if (invitation.formResponseId) denied("ALREADY_ANSWERED", "You submitted this scorecard " + dateText(invitation.responseDate))
    const values = typeof p.values === "string" ? lib.json(p.values, {}) : Object.assign({}, p.values || {})
    const formResponseId = forms().recordAnswer(invitation.formId, values)
    call("update#" + INVITATION, {
        invitationId: invitation.invitationId,
        formResponseId,
        responseDate: ec.user.nowTimestamp,
        statusEnumId: "FinResponded"
    })
    return {invitationId: invitation.invitationId, formResponseId}
}
// The interviews a user sees between two instants: those they are on the panel of, and for a recruiter those of the employers
// in scope; each with its application's opening and, for a recruiter or the panel, the applicant's name.
function visibleInterviews(userScope, startMs, endMs) {
    const panelIds = unique(
        panelInvitations(userScope.partyId)
            .filter(row => row.contextEntityName === WORK)
            .map(row => row.contextId)
    )
    const factory = ec.entity.conditionFactory
    const reach = []
    if (panelIds.length) reach.push(factory.makeCondition("workEffortId", "in", panelIds))
    if (userScope.capabilities.recruitView && userScope.organizationPartyIds.length)
        reach.push(factory.makeCondition("organizationPartyId", "in", Array.from(userScope.organizationPartyIds)))
    if (!reach.length) return []
    const interviews = Array.from(find(INTERVIEW).condition(factory.makeCondition(reach, "or")).limit(listCap).list())
    if (!interviews.length) return []
    const events = Array.from(
        find(WORK)
            .condition(
                "workEffortId",
                "in",
                interviews.map(row => row.workEffortId)
            )
            .condition("estimatedStartDate", "less", stamp(endMs))
            .condition("estimatedCompletionDate", "greater", stamp(startMs))
            .list()
    ).filter(event => event.statusId !== "WeCancelled")
    const byId = new Map(interviews.map(row => [row.workEffortId, row]))
    const applications = new Map(
        Array.from(
            find(APPLICATION)
                .condition("employmentApplicationId", "in", unique(interviews.map(row => row.employmentApplicationId)))
                .list()
        ).map(row => [row.employmentApplicationId, row])
    )
    const names = people.personNames(unique(Array.from(applications.values()).map(row => row.applyingPartyId)))
    const titles = openingTitles(interviews.map(row => row.jobOpeningId))
    return events.map(event => {
        const interview = byId.get(event.workEffortId)
        const application = applications.get(interview.employmentApplicationId)
        return {
            workEffortId: event.workEffortId,
            employmentApplicationId: interview.employmentApplicationId,
            openingTitle: titles[interview.jobOpeningId] || "",
            applicantName: application ? names[application.applyingPartyId] || "" : "",
            startMs: ms(event.estimatedStartDate),
            endMs: ms(event.estimatedCompletionDate),
            // the user is on its panel or scheduled it: the event's attendee or organizer, who opens the event itself
            attends: panelIds.includes(event.workEffortId) || (!!userScope.partyId && event.ownerPartyId === userScope.partyId),
            lastModified: stampOf(event)
        }
    })
}
// find#Interviews: InterviewsCalendar's items from start to end (yyyy-MM-dd days or instants) as Commons' Calendar.qvue takes
// them (kind interview: "{applicant} · {opening}", opening EventDetail under People), for a panel member and a recruiter.
function findInterviews(p) {
    const userScope = people.scopeOf()
    if (!userScope.partyId && !userScope.capabilities.recruitView) denied("PERMISSION_DENIED", "Interviews are not available")
    const toMs = (value, fallback) => {
        if (blank(value)) return fallback
        const day = /^\d{4}-\d{2}-\d{2}$/.test(text(value))
        return day
            ? Number(ms(ec.l10n.parseTimestamp(text(value) + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS")))
            : Number(ms(value))
    }
    const startMs = toMs(p.start, nowMs() - 7 * 24 * hourMs)
    const endMs = toMs(p.end, startMs + 42 * 24 * hourMs)
    const eventList = visibleInterviews(userScope, startMs, endMs).map(item => ({
        kind: "interview",
        key: item.workEffortId,
        workEffortId: item.workEffortId,
        employmentApplicationId: item.employmentApplicationId,
        attends: item.attends,
        title: [item.applicantName, item.openingTitle].filter(Boolean).join(" · ") || "Interview",
        start: ec.l10n.format(new Date(item.startMs), "yyyy-MM-dd HH:mm"),
        end: ec.l10n.format(new Date(item.endMs), "yyyy-MM-dd HH:mm"),
        allDay: false,
        canEdit: false
    }))
    return {eventList}
}
// get#InterviewProjection: My interviews' projected CalDAV collection (define#ProjectionOwner): admitted for a user with a
// person who is on an interview panel; the interviews they are on the panel of, "Interview · {opening}", never the candidate.
function getInterviewProjection(p) {
    const userScope = people.scopeOf()
    const panelIds = unique(
        panelInvitations(userScope.partyId)
            .filter(row => row.contextEntityName === WORK)
            .map(row => row.contextId)
    )
    const admitted = !!userScope.partyId && panelIds.length > 0
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const startMs = p.start != null && p.start !== "" ? Number(p.start) : nowMs() - 30 * 24 * hourMs
    const endMs = p.end != null && p.end !== "" ? Number(p.end) : nowMs() + 180 * 24 * hourMs
    const own = new Set(panelIds)
    const eventList = visibleInterviews(
        Object.assign({}, userScope, {capabilities: {}, organizationPartyIds: []}),
        startMs,
        endMs
    )
        .filter(item => own.has(item.workEffortId))
        .map(item => ({
            uid: "people-interview-" + item.workEffortId,
            sequence: 0,
            summary: "Interview · " + (item.openingTitle || "an applicant"),
            status: "CONFIRMED",
            allDay: false,
            start: item.startMs,
            end: item.endMs,
            timeZone: ec.user.timeZone || null,
            lastModified: item.lastModified || null
        }))
    return {admitted, eventList}
}

// ===== My interviews (the user's call of Nov 12, 2026: a panel member answers from their self-service) =====
// The caller's own scorecard assignments of interviews, newest first.
const myInvitations = partyId => panelInvitations(partyId).filter(row => row.contextEntityName === WORK)
// find#MyInterviews: the interviews the caller is on the panel of (no party parameter: their own), the coming ones and those of
// the last 30 days, and any older one whose scorecard is still to submit; each with when, the applicant's name, the opening, its
// employer and the scorecard's state. Nothing about the application beyond those.
function findMyInterviews(p) {
    const userScope = people.scopeOf()
    const invitations = myInvitations(userScope.partyId)
    if (!invitations.length) return {interviews: [], toAnswerCount: 0}
    const byEvent = new Map(invitations.map(row => [row.contextId, row]))
    const interviews = Array.from(
        find(INTERVIEW).condition("workEffortId", "in", Array.from(byEvent.keys())).limit(listCap).list()
    )
    const events = new Map(
        interviews.length
            ? Array.from(
                  find(WORK)
                      .condition(
                          "workEffortId",
                          "in",
                          interviews.map(row => row.workEffortId)
                      )
                      .list()
              ).map(row => [row.workEffortId, row])
            : []
    )
    const applications = new Map(
        interviews.length
            ? Array.from(
                  find(APPLICATION)
                      .condition("employmentApplicationId", "in", unique(interviews.map(row => row.employmentApplicationId)))
                      .list()
              ).map(row => [row.employmentApplicationId, row])
            : []
    )
    const names = people.personNames(unique(Array.from(applications.values()).map(row => row.applyingPartyId)))
    const titles = openingTitles(interviews.map(row => row.jobOpeningId))
    const organizations = people.organizationNames(unique(interviews.map(row => row.organizationPartyId)))
    const since = nowMs() - 30 * 24 * hourMs
    const found = interviews
        .map(interview => {
            const event = events.get(interview.workEffortId)
            const invitation = byEvent.get(interview.workEffortId)
            const application = applications.get(interview.employmentApplicationId)
            if (!event || !application) return null
            const startMs = ms(event.estimatedStartDate)
            const endMs = ms(event.estimatedCompletionDate)
            const cancelled = event.statusId === "WeCancelled"
            const answered = !!invitation.formResponseId
            if ((endMs ?? startMs ?? 0) < since && (answered || cancelled)) return null
            return {
                workEffortId: interview.workEffortId,
                whenText: whenText(startMs, endMs),
                startMs,
                applicantName: names[application.applyingPartyId] || "",
                openingTitle: titles[interview.jobOpeningId] || "",
                organizationName: organizations[interview.organizationPartyId] || "",
                cancelled,
                answered,
                toAnswer: !answered && !cancelled,
                scorecardText: cancelled ? "Cancelled" : answered ? "Submitted " + dateText(invitation.responseDate) : "To submit"
            }
        })
        .filter(Boolean)
        .sort((a, b) => (b.startMs ?? 0) - (a.startMs ?? 0))
    return {interviews: found, toAnswerCount: found.filter(row => row.toAnswer).length}
}
// get#MyInterview: one interview the caller is on the panel of (RECORD_UNAVAILABLE otherwise, as a missing one): when and where
// (the call link is in its location), the note to the attendees, the applicant's name, the opening and its employer, the files
// shared with the panel, and the caller's own scorecard (its form to answer once, or their answers). Never the application's
// stage, source, contact, notes or other files, nor another reviewer's scorecard.
function getMyInterview(p) {
    const userScope = people.scopeOf()
    const workEffortId = text(p.workEffortId)
    const invitation = workEffortId ? myInvitations(userScope.partyId).find(row => row.contextId === workEffortId) : null
    const interview = invitation ? one(INTERVIEW, {workEffortId}) : null
    const event = interview ? one(WORK, {workEffortId}) : null
    const application = interview ? one(APPLICATION, {employmentApplicationId: interview.employmentApplicationId}) : null
    if (!invitation || !interview || !event || !application) unavailable("Interview", workEffortId)
    const view = panelView(application, userScope.partyId)
    const own = view.interviews.find(row => row.workEffortId === workEffortId)
    const card = own?.scorecards.find(row => row.own) || null
    return {
        interview: {
            workEffortId,
            employmentApplicationId: application.employmentApplicationId,
            whenText: own?.whenText || "",
            location: own?.location || "",
            hasCall: !!own?.hasCall,
            cancelled: !!own?.cancelled,
            note: event.description || "",
            panelText: own?.panelText || "",
            applicantName: view.applicantName,
            openingTitle: view.openingTitle,
            organizationName: view.openingOrganizationName,
            sharedFiles: view.sharedFiles,
            scorecard: card
        }
    }
}

// ===== files (the application's content host) =====
// check#ApplicationAccess: whether the caller reads an application's record (its notes and files: a recruiter of its employer)
// and adds files (a recruiter with PEOPLE_RECRUIT_EDIT). A panel member reads the application only through get#Application,
// get#MyInterview and the shared files (get#ApplicationFile), never its record host. Never refuses.
function applicationAccess(p) {
    const none = {recordVisible: false, canEdit: false}
    if (!ec.user.userId) return none
    const application = blank(p.employmentApplicationId)
        ? null
        : one(APPLICATION, {employmentApplicationId: text(p.employmentApplicationId)})
    if (!application) return none
    const userScope = people.scopeOf()
    const recruiter = recruits(userScope, application.organizationPartyId)
    return {
        recordVisible: recruiter,
        canEdit: recruiter && recruitEdits(userScope, application.organizationPartyId),
        organizationPartyId: recruiter ? application.organizationPartyId : null
    }
}
// share#ApplicationContent: a recruiter (PEOPLE_RECRUIT_EDIT of the employer) shares a file of an application with its interview
// panels, or stops sharing it.
function shareApplicationContent(p) {
    const userScope = recruiterScope(true)
    const file = blank(p.applicationContentId) ? null : one(CONTENT, {applicationContentId: text(p.applicationContentId)})
    const application = file ? one(APPLICATION, {employmentApplicationId: file.employmentApplicationId}) : null
    if (!application || !recruitEdits(userScope, application.organizationPartyId)) unavailable("File", p.applicationContentId)
    const panelShared = truthy(p.shared) ? "Y" : "N"
    if ((file.panelShared || "N") !== panelShared)
        call("update#" + CONTENT, {applicationContentId: file.applicationContentId, panelShared})
    return {applicationContentId: file.applicationContentId, shared: panelShared === "Y"}
}
// get#ApplicationFile: a file of an application for a recruiter of its employer, or for a member of one of its interview panels
// when it is shared with the panel; its location, name and whether it may show inline (a raster image or a PDF). Refused alike
// when missing or not the caller's to read (RECORD_UNAVAILABLE).
function applicationFile(p) {
    const file = blank(p.applicationContentId) ? null : one(CONTENT, {applicationContentId: text(p.applicationContentId)})
    const application = file ? one(APPLICATION, {employmentApplicationId: file.employmentApplicationId}) : null
    const userScope = people.scopeOf()
    const access = accessOf(userScope, application)
    if (!file || !file.contentLocation || !access || (access === "panel" && file.panelShared !== "Y"))
        unavailable("File", p.applicationContentId)
    const name = String(file.contentLocation).split("/").pop() || fileName(file)
    return {
        location: file.contentLocation,
        fileName: name,
        inline: /\.(png|jpe?g|gif|webp|pdf)$/i.test(name)
    }
}
function contentAccess(p) {
    const found = applicationAccess(p)
    if (!found.recordVisible) unavailable("Application", p.employmentApplicationId)
    if (!found.canEdit) denied("PERMISSION_DENIED", "Adding an application's files needs PEOPLE_RECRUIT_EDIT")
    return found
}

// ===== mail intake (the createApplication rule action) =====
// Whether a user holds a permission (ADMIN holds every one), read for a user other than the caller.
function userHolds(userId, permission) {
    if (!userId) return false
    const current = (from, thru) => ec.entity.conditionFactory.makeConditionDate(from, thru, null)
    const inGroup = groupId =>
        find("moqui.security.UserGroupMember")
            .condition("userId", userId)
            .condition("userGroupId", groupId)
            .condition(current("fromDate", "thruDate"))
            .count() > 0
    if (inGroup("ADMIN")) return true
    return (
        find("moqui.security.UserPermissionCheck")
            .condition("userId", userId)
            .condition("userPermissionId", permission)
            .condition(current("groupFromDate", "groupThruDate"))
            .condition(current("permissionFromDate", "permissionThruDate"))
            .count() > 0
    )
}
// The opening of a received message: the one the rule's value names, else the one whose plus tag a To or Cc address carries.
function intakeOpening(message, value) {
    if (!blank(value)) return one(OPENING, {jobOpeningId: text(value)})
    const tags = new Set()
    for (const list of [message.toAddresses, message.ccAddresses])
        for (const match of String(list || "").matchAll(/[^\s<>,;"]+\+([A-Za-z0-9._-]+)@[^\s<>,;"]+/g))
            tags.add(match[1].toLowerCase())
    if (!tags.size) return null
    return (
        Array.from(find(OPENING).condition("intakePlusTag", "in", Array.from(tags)).condition("statusId", "JoOpen").list())[0] ||
        null
    )
}
// create#ApplicationFromEmail: the message, once (a message already an application answers it), becomes a Received application
// to its opening when the opening takes applications and the rule may file into it (the opening's intake account is the
// message's, or the rule's owner is its recruiting owner and holds PEOPLE_RECRUIT_EDIT): the sender is the applicant (the person
// of the address, else a new person with the Applicant role), the subject its notes, the attachments its private files (the
// first its resume); a possible duplicate is flagged. Anything else is logged and nothing is made (reason).
function createApplicationFromEmail(p) {
    const message = blank(p.emailMessageId)
        ? null
        : one("moqui.basic.email.EmailMessage", {emailMessageId: text(p.emailMessageId)})
    if (!message) return {reason: "MESSAGE_UNAVAILABLE"}
    const already = Array.from(find(APPLICATION).condition("emailMessageId", message.emailMessageId).list())[0]
    if (already) return {employmentApplicationId: already.employmentApplicationId, created: false, reason: "ALREADY_FILED"}
    const opening = intakeOpening(message, p.value)
    const log = reason => {
        ec.logger.warn("Email " + message.emailMessageId + ": no application made (" + reason + ")")
        return {created: false, reason}
    }
    if (!opening) return log("NO_OPENING")
    if (!isOpen(opening)) return log("OPENING_CLOSED")
    const accountId = text(p.emailAccountId) || message.emailAccountId || ""
    const byAccount = !!accountId && opening.intakeEmailAccountId === accountId
    // the rule's owner: the opening's recruiting owner now, with an enabled account, PEOPLE_RECRUIT_EDIT and still working for
    // the employer (an owner who left files nothing, whatever rules they left behind)
    const owner = blank(p.ruleOwnerUserId) ? null : one("moqui.security.UserAccount", {userId: text(p.ruleOwnerUserId)})
    const ownerPartyId = owner && enabledAccount(owner) ? owner.partyId : null
    const byOwner =
        !!ownerPartyId &&
        ownerPartyId === opening.ownerPartyId &&
        worksFor(ownerPartyId, opening.organizationPartyId) &&
        userHolds(owner.userId, "PEOPLE_RECRUIT_EDIT")
    if (!byAccount && !byOwner) return log("RULE_NOT_ALLOWED")
    const address = String(message.fromAddress || "")
        .trim()
        .toLowerCase()
    if (!address.includes("@")) return log("NO_SENDER")
    let partyId = personByEmail(address)
    if (!partyId) {
        const name =
            String(message.fromName || "")
                .replace(/["']/g, "")
                .trim() || address.split("@")[0]
        const parts = name.split(/\s+/)
        partyId = applicantOf(
            {
                firstName: parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0],
                lastName: parts.length > 1 ? parts[parts.length - 1] : "@" + address.split("@")[1],
                emailAddress: address
            },
            opening.organizationPartyId
        )
    }
    const made = makeApplication(opening, partyId, {
        applicationDate: message.receivedDate || message.messageDate || ec.user.nowTimestamp,
        referredByEnumId: "EarbEmail",
        emailMessageId: message.emailMessageId,
        comments:
            String(message.subject || "")
                .trim()
                .substring(0, 255) || null,
        createdByUserId: null
    })
    keepFiles(
        made.employmentApplicationId,
        Array.from(find("moqui.basic.email.EmailMessageAttachment").condition("emailMessageId", message.emailMessageId).list())
            .filter(file => file.attachmentLocation && file.isInline !== "Y")
            .map(file => ({location: file.attachmentLocation, fileName: file.fileName})),
        "email " + message.emailMessageId
    )
    return {
        employmentApplicationId: made.employmentApplicationId,
        created: true,
        duplicateOfApplicationId: made.duplicateOfApplicationId
    }
}

// Files of a received message or chat event kept as an application's private files, the first its resume; a file that cannot
// be copied is logged and the rest go on.
function keepFiles(employmentApplicationId, files, what) {
    let first = !rows(CONTENT, {employmentApplicationId}).length
    for (const file of files) {
        try {
            const name = String(file.fileName || "attachment").replace(/[\/\\?#%:]/g, "_")
            const applicationContentId = call("create#" + CONTENT, {
                employmentApplicationId,
                contentTypeEnumId: first ? "EactResume" : "EactOther",
                description: name,
                contentDate: ec.user.nowTimestamp
            }).applicationContentId
            const location =
                "dbresource://mantle/content/employmentApplication/" +
                employmentApplicationId +
                "/content_" +
                applicationContentId +
                "/" +
                name
            ec.resource.getLocationReference(location).copyFrom(file.location)
            call("update#" + CONTENT, {applicationContentId, contentLocation: location})
            first = false
        } catch (error) {
            ec.logger.error(
                "Application " +
                    employmentApplicationId +
                    " from " +
                    what +
                    ": file " +
                    file.fileName +
                    " not kept: " +
                    error.message
            )
        }
    }
}
// create#ApplicationFromChat (the "Create application" create-from of a chat message): a recruiter (PEOPLE_RECRUIT_EDIT) makes an
// application of the message's sender (a candidate writing in the room, or an employee applying from within; never the caller's
// own message, NOT_AN_APPLICANT) to the opening of the room's record (a JobOpening's room), else the open opening whose plus tag
// the message names (+tag), else the one open opening the caller owns (OPENING_REQUIRED otherwise), an opening the caller changes
// and that takes applications; the message's first line its notes, its files the application's files (the first its resume).
// Once per message; the room the caller reads, not end-to-end encrypted.
function createApplicationFromChat(p) {
    const userScope = recruiterScope(true)
    const chatRoomId = text(p.chatRoomId)
    const eventSeq = Number(p.eventSeq)
    const notAvailable = () => unavailable("Message", eventSeq)
    const access = chatRoomId ? lib.probe("org.moqui.chat.ChatServices.get#RoomAccess", {chatRoomId}) : null
    if (!access?.canRead) notAvailable()
    const room = one("moqui.chat.ChatRoom", {chatRoomId})
    if (room?.encrypted === "Y") denied("ROOM_ENCRYPTED", "A message of an end-to-end encrypted room is not read on the server")
    const event = one("moqui.chat.ChatEvent", {chatRoomId, eventSeq})
    if (!event || event.eventTypeEnumId !== "CetMessage" || event.redactedDate) notAvailable()
    const sourceKey = "chat:" + chatRoomId + ":" + eventSeq
    const known = Array.from(find(APPLICATION).condition("sourceKey", sourceKey).list())[0]
    if (known) {
        if (!recruits(userScope, known.organizationPartyId)) notAvailable()
        return {employmentApplicationId: known.employmentApplicationId, created: false}
    }
    if (event.senderUserId === ec.user.userId)
        denied("NOT_AN_APPLICANT", "Make an application from the applicant's own message; add another's with Add application")
    const sender = event.senderUserId ? one("moqui.security.UserAccount", {userId: event.senderUserId}) : null
    const partyId = sender?.partyId && one("mantle.party.Person", {partyId: sender.partyId}) ? sender.partyId : null
    if (!partyId) denied("NOT_AN_APPLICANT", "The message's sender is no person to apply")
    const body = text(event.bodyText)
    let opening = null
    if (room?.recordEntityName === OPENING && room.recordId) opening = one(OPENING, {jobOpeningId: room.recordId})
    if (!opening) {
        const tags = Array.from(body.matchAll(/(?:^|\s)\+([A-Za-z0-9][A-Za-z0-9._-]{1,40})\b/g)).map(match =>
            match[1].toLowerCase()
        )
        if (tags.length)
            opening =
                Array.from(
                    find(OPENING).condition("intakePlusTag", "in", unique(tags)).condition("statusId", "JoOpen").list()
                )[0] || null
    }
    if (!opening && userScope.partyId) {
        const owned = Array.from(
            find(OPENING).condition("ownerPartyId", userScope.partyId).condition("statusId", "JoOpen").list()
        ).filter(isOpen)
        if (owned.length === 1) opening = owned[0]
    }
    if (!opening)
        denied("OPENING_REQUIRED", "Post it in the opening's room, or name the opening's plus tag in the message (+tag)")
    if (!recruitEdits(userScope, opening.organizationPartyId)) unavailable("Opening", opening.jobOpeningId)
    if (!isOpen(opening)) denied("OPENING_CLOSED", (opening.title || opening.jobOpeningId) + " takes no application now")
    const made = makeApplication(opening, partyId, {
        sourceKey,
        comments: body.split("\n")[0].substring(0, 255) || null
    })
    keepFiles(
        made.employmentApplicationId,
        rows("moqui.chat.ChatAttachment", {chatRoomId, eventSeq})
            .filter(row => row.location)
            .map(row => ({location: row.location, fileName: row.fileName})),
        "chat message " + sourceKey
    )
    return {
        employmentApplicationId: made.employmentApplicationId,
        created: true,
        duplicateOfApplicationId: made.duplicateOfApplicationId
    }
}

// ===== People's lifecycle participant (find#OwnedApprovals, transfer#ApprovalOwner, P5): the openings a user owns =====
// The draft and open openings a person is the recruiting owner of, as owned resources (opening:id, handed to a new owner).
function ownedOpenings(partyId) {
    if (!partyId) return []
    const owned = Array.from(
        find(OPENING).condition("ownerPartyId", partyId).condition("statusId", "in", ["JoDraft", "JoOpen"]).limit(listCap).list()
    )
    const organizations = people.organizationNames(unique(owned.map(row => row.organizationPartyId)))
    return owned.map(row => ({
        resourceId: "opening:" + row.jobOpeningId,
        resourceName:
            "Opening " +
            (row.title || row.jobOpeningId) +
            " of " +
            (organizations[row.organizationPartyId] || row.organizationPartyId),
        resourceKind: "jobOpening",
        transferable: true,
        note: "Recruiting owner"
    }))
}
// An opening's recruiting owner handed from one person to another (the audit log keeps the change with its reason): with
// PEOPLE_APPROVAL_OWNER_CHANGE (the offboarding operator) or as a recruiter who changes the employer's openings. Refused: an
// opening that is not the person's draft or open one (RECORD_UNAVAILABLE), a new owner with no enabled account and person
// (OWNER_INVALID) or who does not work for the employer (NOT_EMPLOYED).
function transferOpening(p) {
    const opening = blank(p.jobOpeningId) ? null : one(OPENING, {jobOpeningId: text(p.jobOpeningId)})
    if (!opening || !p.fromPartyId || opening.ownerPartyId !== p.fromPartyId || !["JoDraft", "JoOpen"].includes(opening.statusId))
        unavailable("Opening", p.jobOpeningId)
    if (!lib.access.has("PEOPLE_APPROVAL_OWNER_CHANGE") && !recruitEdits(people.scopeOf(), opening.organizationPartyId))
        denied(
            "PERMISSION_DENIED",
            "Handing over an opening needs PEOPLE_APPROVAL_OWNER_CHANGE, or PEOPLE_RECRUIT_EDIT of its employer"
        )
    const to = p.toUserId ? one("moqui.security.UserAccount", {userId: text(p.toUserId)}) : null
    if (!enabledAccount(to) || !to.partyId) denied("OWNER_INVALID", "The new owner needs an enabled account with a person")
    if (to.partyId === p.fromPartyId) denied("OWNER_INVALID", "The new owner is the current one")
    if (!worksFor(to.partyId, opening.organizationPartyId))
        denied("NOT_EMPLOYED", "The new owner works for the opening's employer")
    call("update#" + OPENING, {
        jobOpeningId: opening.jobOpeningId,
        ownerPartyId: to.partyId,
        ownerPartyId_changeReason:
            text(p.reason) || "Handed over from " + (people.personNames([p.fromPartyId])[p.fromPartyId] || p.fromPartyId)
    })
    return {transferred: true}
}

const operations = {
    findOpenings,
    storeOpening,
    findApplications,
    createApplication,
    getApplication,
    storeApplication,
    changeApplicationStage,
    scheduleInterview,
    submitScorecard,
    findInterviews,
    getInterviewProjection,
    applicationAccess,
    contentAccess,
    createApplicationFromEmail,
    createApplicationFromChat,
    shareApplicationContent,
    applicationFile,
    findMyInterviews,
    getMyInterview,
    ownedOpenings: p => ({resourceList: ownedOpenings(p.partyId)}),
    transferOpening
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown recruiting operation " + op)
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return operations[op](p || {})
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
;({execute: run})
