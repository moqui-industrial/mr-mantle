// People's offers of employment (mantle.humanres.RecruitingServices find#Offers, get#Offer, store#Offer, change#OfferState,
// approve#Offer, refuse#Offer and get#OfferLetter; IronStone People design §5 OfferDetail, §15 the offer letter, §12's
// PeopleOfferApproval, PE-04, PE-02; impl-people P17):
// - an offer (EmploymentOffer) is the dated terms of one application at Interview or Offer (a seat of its opening, the department,
//   manager, work location and working schedule, the start and an optional end, when it expires, a note for the letter) and its
//   proposed pay; one open offer per application; drafting one moves the application to Offer;
// - its states: Draft; Waiting for approval (submit asks a People approval of kind PakOffer: the employer's HR officers unless a
//   rule says otherwise, never who submitted it or the applicant; it is bound to the offer's revision, so changed terms supersede it
//   and the offer is a draft again, as they make an approved offer a draft again; who drafted it decides it no more than who
//   submitted it or the applicant, P17 review); Approved; Issued (its letter rendered and stored once, Letters.js, and emailed to the
//   applicant once the issue commits, send#OfferLetter: the user's call of Nov 12, 2026, P17 review; an issued offer past its expiry
//   reads expired and takes no answer); Accepted or Declined (the candidate's
//   answer, with a signed acceptance kept when given); Hired (PeopleServices.hire#Employee consumes an accepted offer exactly once:
//   consumeOffer, under the offer's lock); Withdrawn. Accepted is not hired;
// - who: a recruiter (PEOPLE_RECRUIT_VIEW), an HR reader (PEOPLE_HR_VIEW) and a payroll reader (PAYROLL_VIEW) of the employer, in
//   People's scope, read its offers, and the approver of the step waiting reads the one they decide; a recruiter with
//   PEOPLE_RECRUIT_EDIT or an HR editor (PEOPLE_HR_EDIT) changes the terms and moves it; an HR editor hires from it;
// - pay never leaves its lane (design §1.1, §2): the pay terms are set only with PAYROLL_VIEW and PAYROLL_EDIT and read only with
//   PAYROLL_VIEW, on every path (an offer's answer, the list, the letter's preview, the stored letter holding them, the approval's
//   notice and summary, the hire's terms); a reader without it learns only that the offer has pay terms;
// - an offer grants nothing: the hire from it records no pay and asks for no account but as HR chooses on the hire.
// Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const employment = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Employment.js")
const letters = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Letters.js")
const schedules = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Schedules.js")
const {find, one, rows, denied, call, dateText, ms} = lib

const OFFER = "mantle.humanres.recruitment.EmploymentOffer",
    APPLICATION = "mantle.humanres.employment.EmploymentApplication",
    OPENING = "mantle.humanres.recruitment.JobOpening",
    OPENING_POSITION = "mantle.humanres.recruitment.JobOpeningPosition",
    POSITION = "mantle.humanres.position.EmplPosition",
    LETTER = "mantle.humanres.employment.EmploymentLetter",
    DECISION = "mantle.humanres.approval.PeopleApprovalDecision"
const offerKind = "PakOffer"
const statusTexts = {
    OfrDraft: "Draft",
    OfrSubmitted: "Waiting for approval",
    OfrApproved: "Approved",
    OfrIssued: "Issued",
    OfrExpired: "Expired",
    OfrAccepted: "Accepted",
    OfrDeclined: "Declined",
    OfrHired: "Hired",
    OfrWithdrawn: "Withdrawn"
}
const statusColors = {
    OfrDraft: "grey-8",
    OfrSubmitted: "warning",
    OfrApproved: "info",
    OfrIssued: "primary",
    OfrExpired: "negative",
    OfrAccepted: "positive",
    OfrDeclined: "negative",
    OfrHired: "positive",
    OfrWithdrawn: "grey-8"
}
// an offer still open (one per application), and those whose terms change
const openStatuses = ["OfrDraft", "OfrSubmitted", "OfrApproved", "OfrIssued", "OfrAccepted"]
const termStatuses = ["OfrDraft", "OfrSubmitted", "OfrApproved"]
// the terms of an offer, and its pay
const termFields = [
    "emplPositionId",
    "managerPartyId",
    "facilityId",
    "workingScheduleId",
    "fromDate",
    "thruDate",
    "expireDate",
    "note"
]
const dateFields = ["fromDate", "thruDate", "expireDate"]
const payFields = ["payAmount", "currencyUomId", "timePeriodTypeId"]
const actions = ["submit", "approve", "refuse", "withdraw", "issue", "accept", "decline"]
const sendTexts = {sent: "Emailed to the applicant", queued: "Waiting in the mail queue", failed: "Not emailed"}
const listCap = 500

const text = value => String(value ?? "").trim()
const blank = value => text(value) === ""
const unique = people.unique
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const effective = value => (blank(value) ? null : ec.user.timestampMillis(value))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const dayValue = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "yyyy-MM-dd"))
const unavailable = id => denied("RECORD_UNAVAILABLE", "Offer " + (id || "") + " is not available")
function checkRevision(row, revision) {
    if (!blank(revision) && String(revision) !== String(stampOf(row)))
        denied(
            "REVISION_CHANGED",
            "The offer was changed since you read it (now at revision " + stampOf(row) + "); read it again"
        )
}

// ===== who reads and changes =====
// How the caller reads offers of an employer: recruiter, hr, payroll (each of the employer, in People's scope); none outside it.
function kindsOf(userScope, organizationPartyId) {
    if (!organizationPartyId || !userScope.organizationPartyIds.includes(organizationPartyId)) return []
    const caps = userScope.capabilities
    return [caps.recruitView && "recruiter", caps.hrView && "hr", caps.payrollView && "payroll"].filter(Boolean)
}
const changesTerms = (userScope, kinds) =>
    (kinds.includes("recruiter") && !!userScope.capabilities.recruitEdit) ||
    (kinds.includes("hr") && !!userScope.capabilities.hrEdit)
const seesPay = kinds => kinds.includes("payroll")
// Whether the offer's letter, and so the candidate's signed copy of it, holds the pay terms (P17 review)
const holdsPay = (offer, letter) => letter?.includesPay === "Y" || (offer.payAmount != null && offer.payAmount !== "")
const changesPay = (userScope, kinds) => kinds.includes("payroll") && !!userScope.capabilities.payrollEdit
const hires = (userScope, kinds) => kinds.includes("hr") && !!userScope.capabilities.hrEdit
// The latest approval of an offer as its record shows it (Approvals.js: state, steps, decisions, canDecide); null when none.
const approvalOf = offer => approvals().sourceSummary(offerKind, offer.employmentOfferId)
// An offer the caller reads, with how: as recruiter, HR or payroll of its employer, or as an approver of the step waiting (or who
// decided a step of it), who reads it without pay. Refused alike when missing (RECORD_UNAVAILABLE).
function readableOffer(userScope, employmentOfferId) {
    const id = text(employmentOfferId)
    const offer = id ? one(OFFER, {employmentOfferId: id}) : null
    if (!offer) unavailable(id)
    let kinds = kindsOf(userScope, offer.organizationPartyId)
    let approval = null
    if (!kinds.length) {
        approval = approvalOf(offer)
        const decided =
            !!approval &&
            find(DECISION, {peopleApprovalId: approval.peopleApprovalId, decidedByUserId: ec.user.userId}).count() > 0
        if (!approval?.canDecide && !decided) unavailable(id)
        kinds = ["approver"]
    }
    return {offer, kinds, approval}
}
// Whether an issued offer is past its expiry, and its state as read (an issued one past its expiry reads expired).
const isExpired = offer =>
    offer.statusId === "OfrIssued" && offer.expireDate != null && (ms(offer.expireDate) ?? Infinity) <= nowMs()
const stateOf = offer => (isExpired(offer) ? "OfrExpired" : offer.statusId || "OfrDraft")

// ===== names and texts =====
function frequencyText(timePeriodTypeId) {
    if (!timePeriodTypeId) return ""
    const row = one("mantle.party.time.TimePeriodType", {timePeriodTypeId})
    return String(row?.description || timePeriodTypeId).replace(/^Payroll /, "")
}
// The pay terms as text: "52,000.00 USD a year" (an amount, its currency and the frequency); empty for none.
function payText(offer) {
    if (offer.payAmount == null || offer.payAmount === "") return ""
    const amount = ec.l10n.formatCurrencyNoSymbol(offer.payAmount, offer.currencyUomId, null)
    const frequency = frequencyText(offer.timePeriodTypeId).toLowerCase()
    return amount + " " + (offer.currencyUomId || "") + (frequency ? " a " + frequency.replace(/-/g, " ") : "")
}
const openingTitleOf = offer =>
    offer.jobOpeningId ? one(OPENING, {jobOpeningId: offer.jobOpeningId})?.title || offer.jobOpeningId : ""
// An offer as its reader reads it: its terms by name, dates, state, the answers recorded, what the caller may do, and the pay terms
// only for a payroll reader of the employer (others: hasPayTerms alone).
function offerRow(userScope, offer, kinds) {
    const names = employment().termTexts(offer)
    const state = stateOf(offer)
    const pay = seesPay(kinds)
    const editsTerms = changesTerms(userScope, kinds)
    const persons = people.personNames([offer.partyId])
    const organizations = people.organizationNames([offer.organizationPartyId])
    const letter = offer.employmentLetterId ? one(LETTER, {employmentLetterId: offer.employmentLetterId}) : null
    return Object.assign(
        {
            employmentOfferId: offer.employmentOfferId,
            employmentApplicationId: offer.employmentApplicationId,
            jobOpeningId: offer.jobOpeningId || null,
            openingTitle: openingTitleOf(offer),
            organizationPartyId: offer.organizationPartyId,
            organizationName: organizations[offer.organizationPartyId] || offer.organizationPartyId || "",
            partyId: offer.partyId,
            applicantName: persons[offer.partyId] || offer.partyId || "",
            emplPositionId: offer.emplPositionId || null,
            departmentPartyId: offer.departmentPartyId || null,
            managerPartyId: offer.managerPartyId || null,
            facilityId: offer.facilityId || null,
            workingScheduleId: offer.workingScheduleId || null,
            fromDate: dayValue(offer.fromDate),
            thruDate: dayValue(offer.thruDate),
            expireDate: dayValue(offer.expireDate),
            fromDateText: dateText(offer.fromDate),
            thruDateText: dateText(offer.thruDate),
            expireDateText: dateText(offer.expireDate),
            note: offer.note || "",
            statusId: offer.statusId,
            stateId: state,
            stateText: statusTexts[state] || state,
            stateColor: statusColors[state] || "grey-8",
            expired: state === "OfrExpired",
            decisionReason: offer.decisionReason || "",
            submittedDateText: dateText(offer.submittedDate),
            approvedDateText: dateText(offer.approvedDate),
            issuedDateText: dateText(offer.issuedDate),
            responseDateText: dateText(offer.responseDate),
            responseNote: offer.responseNote || "",
            hasEvidence: !!offer.evidenceLocation,
            // P17 review: the signed copy of a letter holding pay is payroll's, as the letter is
            evidenceRestricted: !!offer.evidenceLocation && holdsPay(offer, letter) && !pay,
            hiredDateText: dateText(offer.hiredDate),
            hiredPartyRelationshipId: kinds.includes("hr") ? offer.partyRelationshipId || null : null,
            hasPayTerms: offer.payAmount != null && offer.payAmount !== "",
            paySees: pay,
            payAmount: pay && offer.payAmount != null ? String(offer.payAmount) : null,
            currencyUomId: pay ? offer.currencyUomId || null : null,
            timePeriodTypeId: pay ? offer.timePeriodTypeId || null : null,
            payText: pay ? payText(offer) : "",
            access: kinds,
            canEdit: editsTerms && termStatuses.includes(offer.statusId),
            canEditPay: changesPay(userScope, kinds) && termStatuses.includes(offer.statusId),
            canSubmit: editsTerms && offer.statusId === "OfrDraft",
            canIssue: editsTerms && offer.statusId === "OfrApproved",
            canRespond: editsTerms && state === "OfrIssued",
            canWithdraw: editsTerms && openStatuses.includes(offer.statusId),
            canHire: hires(userScope, kinds) && offer.statusId === "OfrAccepted",
            letterIssued: !!letter,
            letterRestricted: !!letter && letter.includesPay === "Y" && !pay,
            // P17 review (the user's call of Nov 12, 2026): the issued letter emailed to the applicant, its outcome without its
            // content; the address for the offer's recruiters and HR
            letterSendStatus: offer.letterSendStatus || "",
            letterSendText: sendTexts[offer.letterSendStatus] || "",
            letterSendDateText: dateText(offer.letterSendDate),
            letterSentTo: kinds.includes("recruiter") || kinds.includes("hr") ? offer.letterSentTo || "" : "",
            letterSendError: offer.letterSendError || "",
            canSendLetter:
                editsTerms &&
                !!letter &&
                ["OfrIssued", "OfrAccepted"].includes(offer.statusId) &&
                !["sent", "queued"].includes(offer.letterSendStatus),
            revision: String(stampOf(offer))
        },
        names
    )
}

// ===== the terms =====
// The terms checked as the hire will check them (Employment.js checkTerms: the seat in effect, not inactive, of the department,
// free then; the manager employed by the employer and no loop; the work location the employer's), the seat one of the opening's
// (POSITION_NOT_OF_OPENING; POSITION_REQUIRED for none), the start (START_REQUIRED) before the end (DATES_INVALID), the schedule
// one the employer's in effect then. Answers the department of the seat.
function checkOfferTerms(offer) {
    if (!offer.emplPositionId) denied("POSITION_REQUIRED", "Choose the position offered")
    const fromMs = ms(offer.fromDate)
    if (fromMs == null) denied("START_REQUIRED", "Give the start")
    const thruMs = ms(offer.thruDate)
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "The end is after the start")
    if (offer.jobOpeningId && !one(OPENING_POSITION, {jobOpeningId: offer.jobOpeningId, emplPositionId: offer.emplPositionId}))
        denied("POSITION_NOT_OF_OPENING", "The position is not one of the opening's seats")
    const findings = []
    const terms = employment().checkTerms(
        {partyRelationshipId: null, partyId: offer.partyId, organizationPartyId: offer.organizationPartyId, fromMs, thruMs},
        {
            departmentPartyId: null,
            emplPositionId: offer.emplPositionId,
            managerPartyId: offer.managerPartyId || null,
            facilityId: offer.facilityId || null
        },
        fromMs,
        findings
    )
    const error = findings.find(finding => finding.severity === "error")
    if (error) denied(error.code, error.message)
    if (offer.workingScheduleId) schedules().checkAssignable(offer.workingScheduleId, offer.organizationPartyId, fromMs)
    return terms.departmentPartyId || one(POSITION, {emplPositionId: offer.emplPositionId})?.departmentPartyId || null
}
// The pay terms given: all three or none (an empty amount clears them): an amount of at least zero within the currency's precision
// (AMOUNT_INVALID, CURRENCY_PRECISION), a currency (CURRENCY_INVALID) and a payroll frequency (FREQUENCY_INVALID); PAY_INCOMPLETE
// for an amount without both.
function payValues(p) {
    if (blank(p.payAmount)) return {payAmount: null, currencyUomId: null, timePeriodTypeId: null}
    const currencyUomId = text(p.currencyUomId)
    const timePeriodTypeId = text(p.timePeriodTypeId)
    if (!currencyUomId || !timePeriodTypeId) denied("PAY_INCOMPLETE", "Pay terms are an amount, its currency and its frequency")
    const currency = one("moqui.basic.Uom", {uomId: currencyUomId})
    if (!currency || currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", currencyUomId + " is not a currency")
    if (!timePeriodTypeId.startsWith("Payroll") || !one("mantle.party.time.TimePeriodType", {timePeriodTypeId}))
        denied("FREQUENCY_INVALID", timePeriodTypeId + " is not a pay frequency")
    let amount
    try {
        amount = toDecimal(text(p.payAmount))
    } catch (_) {
        denied("AMOUNT_INVALID", "The pay is not an amount")
    }
    if (amount == null || amount.compare(0) < 0) denied("AMOUNT_INVALID", "The pay is not an amount")
    if (!amount.eq(ec.l10n.roundCurrency(amount, currencyUomId)))
        denied("CURRENCY_PRECISION", "The pay exceeds the currency's precision")
    return {payAmount: amount, currencyUomId, timePeriodTypeId}
}
// Whether a value of a field differs from the row's (dates by instant, the amount by value).
function differs(row, field, value) {
    const before = row?.[field]
    if (dateFields.includes(field)) return (ms(before) ?? null) !== (ms(value) ?? null)
    if (field === "payAmount")
        return before == null || value == null ? before != value : toDecimal(String(before)).compare(value) !== 0
    return text(before) !== text(value)
}

// ===== store#Offer =====
// A new offer of an application at Interview or Offer (APPLICATION_STAGE), one open offer at a time (OFFER_OPEN), drafted by a
// recruiter with PEOPLE_RECRUIT_EDIT or an HR editor of the employer; or a change of one's terms at the revision read, while a
// draft, waiting or approved (OFFER_LOCKED otherwise): changed terms make a waiting or approved offer a draft again and supersede
// its approval. Pay terms only with PAYROLL_VIEW and PAYROLL_EDIT of the employer (PERMISSION_DENIED); terms not given are kept.
function storeOffer(p) {
    const userScope = people.scopeOf()
    let offer = null
    let kinds
    if (!blank(p.employmentOfferId)) {
        const found = readableOffer(userScope, p.employmentOfferId)
        offer = find(OFFER, {employmentOfferId: found.offer.employmentOfferId}).forUpdate(true).one()
        kinds = found.kinds
        checkRevision(offer, p.revision)
        if (!changesTerms(userScope, kinds) && !changesPay(userScope, kinds))
            denied("PERMISSION_DENIED", "Changing an offer needs PEOPLE_RECRUIT_EDIT or PEOPLE_HR_EDIT")
        if (!termStatuses.includes(offer.statusId))
            denied(
                "OFFER_LOCKED",
                "An offer " + (statusTexts[offer.statusId] || offer.statusId).toLowerCase() + " keeps its terms"
            )
    }
    let application = null
    if (!offer) {
        const id = text(p.employmentApplicationId)
        application = id ? one(APPLICATION, {employmentApplicationId: id}) : null
        kinds = application ? kindsOf(userScope, application.organizationPartyId) : []
        if (!application || !kinds.length) denied("RECORD_UNAVAILABLE", "Application " + id + " is not available")
        if (!changesTerms(userScope, kinds))
            denied("PERMISSION_DENIED", "Making an offer needs PEOPLE_RECRUIT_EDIT or PEOPLE_HR_EDIT")
        if (!["EaInterview", "EaOffer"].includes(application.statusId))
            denied("APPLICATION_STAGE", "An offer follows an interview: the application is not at Interview or Offer")
        if (rows(OFFER, {employmentApplicationId: id}).some(row => openStatuses.includes(row.statusId)))
            denied("OFFER_OPEN", "This application has an open offer: change it, or withdraw it first")
    }
    const values = {}
    for (const field of termFields) {
        if (p[field] == null) continue
        if (dateFields.includes(field)) values[field] = stamp(effective(p[field]))
        else if (field === "note") {
            const note = text(p.note)
            if (note.includes("${")) denied("NO_EXPRESSIONS", "A note is text, not an expression")
            values.note = note.substring(0, 4000) || null
        } else values[field] = text(p[field]) || null
    }
    const payGiven = payFields.some(field => p[field] != null)
    if (Object.keys(values).length && !changesTerms(userScope, kinds))
        denied("PERMISSION_DENIED", "An offer's terms are changed with PEOPLE_RECRUIT_EDIT or PEOPLE_HR_EDIT")
    if (payGiven) {
        if (!changesPay(userScope, kinds)) denied("PERMISSION_DENIED", "Pay terms are set with PAYROLL_VIEW and PAYROLL_EDIT")
        Object.assign(values, payValues(p))
    }
    const base = offer
        ? lib.map(offer)
        : {
              employmentApplicationId: application.employmentApplicationId,
              jobOpeningId: application.jobOpeningId || null,
              organizationPartyId: application.organizationPartyId,
              partyId: application.applyingPartyId
          }
    const merged = Object.assign({}, base, values)
    merged.departmentPartyId = checkOfferTerms(merged)
    values.departmentPartyId = merged.departmentPartyId
    if (!offer) {
        const employmentOfferId = call(
            "create#" + OFFER,
            Object.assign({}, merged, {statusId: "OfrDraft", createdDate: ec.user.nowTimestamp, createdByUserId: ec.user.userId})
        ).employmentOfferId
        if (application.statusId === "EaInterview")
            call("update#" + APPLICATION, {
                employmentApplicationId: application.employmentApplicationId,
                statusId: "EaOffer",
                statusId_changeReason: "Offer drafted"
            })
        return {employmentOfferId, statusId: "OfrDraft", changed: true}
    }
    const changed = Object.keys(values).filter(field => differs(offer, field, values[field]))
    if (!changed.length) return {employmentOfferId: offer.employmentOfferId, statusId: offer.statusId, changed: false}
    const update = Object.fromEntries(changed.map(field => [field, values[field]]))
    // changed terms invalidate approval: a waiting or approved offer is a draft again
    if (offer.statusId !== "OfrDraft")
        Object.assign(update, {statusId: "OfrDraft", statusId_changeReason: "Terms changed", approvedDate: null})
    call("update#" + OFFER, Object.assign({employmentOfferId: offer.employmentOfferId}, update))
    approvals().sourceChanged(offerKind, offer.employmentOfferId)
    return {employmentOfferId: offer.employmentOfferId, statusId: update.statusId || offer.statusId, changed: true}
}

// ===== the offer letter =====
// The offer letter as the template takes it (Letters.js): the applicant, the employer, the position and its terms, the expiry and
// the note; pay only when withPay (a payroll reader's preview, or the issued letter).
function offerLetter(offer, withPay, draft) {
    const names = employment().termTexts(offer)
    const organizationName = people.organizationNames([offer.organizationPartyId])[offer.organizationPartyId] || ""
    const long = letters().longDate
    const expires = long(offer.expireDate)
    return {
        organizationName,
        dateText: long(ec.user.nowTimestamp),
        reference: ec.l10n.localize("Offer") + " " + offer.employmentOfferId,
        addresseeName: people.personNames([offer.partyId])[offer.partyId] || "",
        title: ec.l10n.localize("Offer of employment"),
        paragraphs: [
            "We are pleased to offer you the position of " +
                (names.positionName || "the role set out below") +
                " at " +
                organizationName +
                ", on the terms below.",
            offer.note || ""
        ],
        terms: [
            ["Position", names.positionName],
            ["Department", names.departmentName],
            ["Reports to", names.managerName],
            ["Work location", names.facilityName],
            ["Working schedule", names.scheduleName],
            ["Starts", long(offer.fromDate)],
            ["Ends", offer.thruDate ? long(offer.thruDate) : "Open-ended"],
            ["Pay", withPay ? payText(offer) : ""]
        ],
        closing: expires
            ? ["This offer is open until " + expires + ". To accept it, sign this letter and return it to us by then."]
            : [],
        signerName: letters().signerName(),
        draft
    }
}
// get#OfferLetter: the offer's letter for a reader of the offer: the stored one once issued (its file; one holding pay terms only
// for a payroll reader, PERMISSION_DENIED otherwise), else the preview marked as a draft (pay for a payroll reader alone).
function getOfferLetter(p) {
    const userScope = people.scopeOf()
    const {offer, kinds} = readableOffer(userScope, p.employmentOfferId)
    const stored = offer.employmentLetterId ? one(LETTER, {employmentLetterId: offer.employmentLetterId}) : null
    if (stored) {
        if (stored.includesPay === "Y" && !seesPay(kinds))
            denied("PERMISSION_DENIED", "This letter holds the offer's pay terms: it is read with PAYROLL_VIEW")
        return {employmentOfferId: offer.employmentOfferId, issued: true, letter: letters().fileOf(stored), letterHtml: ""}
    }
    return {
        employmentOfferId: offer.employmentOfferId,
        issued: false,
        letter: null,
        letterHtml: letters().letterHtml(offerLetter(offer, seesPay(kinds), true))
    }
}

// ===== find#Offers, get#Offer =====
// find#Offers: the offers of the employers the caller reads offers of (a recruiter, HR or payroll reader; PERMISSION_DENIED
// otherwise): of an application (RECORD_UNAVAILABLE outside), of an employer (ORGANIZATION_DENIED outside), by state (a comma
// list; the open ones unless asked); newest first, paged.
function findOffers(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.recruitView && !caps.hrView && !caps.payrollView)
        denied("PERMISSION_DENIED", "Offers need PEOPLE_RECRUIT_VIEW, PEOPLE_HR_VIEW or PAYROLL_VIEW")
    let organizationPartyIds = Array.from(userScope.organizationPartyIds)
    if (!blank(p.organizationPartyId)) {
        people.requireOrganization(userScope, text(p.organizationPartyId))
        organizationPartyIds = [text(p.organizationPartyId)]
    }
    if (!organizationPartyIds.length) return lib.pageList([], p, "offers")
    let query = find(OFFER).condition("organizationPartyId", "in", organizationPartyIds)
    if (!blank(p.employmentApplicationId)) {
        const application = one(APPLICATION, {employmentApplicationId: text(p.employmentApplicationId)})
        if (!application || !organizationPartyIds.includes(application.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Application " + text(p.employmentApplicationId) + " is not available")
        query = query.condition("employmentApplicationId", application.employmentApplicationId)
    }
    const statusIds = text(p.statusId)
        .split(",")
        .map(part => part.trim())
        .filter(Boolean)
    if (statusIds.length) query = query.condition("statusId", "in", statusIds)
    else if (blank(p.employmentApplicationId) && !(p.includeClosed === true || p.includeClosed === "true"))
        query = query.condition("statusId", "in", openStatuses)
    const found = Array.from(query.orderBy("-createdDate").limit(listCap).list()).map(offer =>
        offerRow(userScope, offer, kindsOf(userScope, offer.organizationPartyId))
    )
    return lib.pageList(found, p, "offers")
}
// The terms a hire from an accepted offer starts with (HireEmployee's draft): the employer, the applicant, the dates and the first
// assignment; never pay.
const hireTermsOf = offer => ({
    employmentOfferId: offer.employmentOfferId,
    organizationPartyId: offer.organizationPartyId,
    partyId: offer.partyId,
    fromDate: dayValue(offer.fromDate),
    thruDate: dayValue(offer.thruDate),
    departmentPartyId: offer.departmentPartyId || "",
    emplPositionId: offer.emplPositionId || "",
    managerPartyId: offer.managerPartyId || "",
    facilityId: offer.facilityId || ""
})
// get#Offer: an offer the caller reads, with its approval (the route, the decisions, whether the caller decides the step waiting:
// names only) and, for an HR editor of an accepted offer, the terms its hire starts with.
function getOffer(p) {
    const userScope = people.scopeOf()
    const found = readableOffer(userScope, p.employmentOfferId)
    const row = offerRow(userScope, found.offer, found.kinds)
    const approval = found.approval || approvalOf(found.offer)
    // the opening's seats, for an editor of its terms
    const seatIds =
        row.canEdit && found.offer.jobOpeningId
            ? rows(OPENING_POSITION, {jobOpeningId: found.offer.jobOpeningId}).map(seat => seat.emplPositionId)
            : []
    const seatNames = seatIds.length ? employment().positionNames(seatIds) : {}
    return {
        offer: Object.assign(row, {
            approval,
            canDecide: !!approval?.canDecide && found.offer.statusId === "OfrSubmitted",
            hireTerms: row.canHire ? hireTermsOf(found.offer) : null,
            openingSeats: seatIds.map(emplPositionId => ({
                emplPositionId,
                positionName: seatNames[emplPositionId] || emplPositionId
            }))
        })
    }
}

// ===== change#OfferState =====
// The offer moved, under its lock: submit (a draft asks for approval, its terms checked again), approve and refuse (the step
// waiting, through PeopleApprovalServices.record#Decision at the offer's revision; the last approval approves it, a refusal makes
// it a draft again with the reason), withdraw (an open offer, its approval superseded), issue (an approved offer with an expiry to
// come: its letter rendered and stored once), accept and decline (the candidate's answer to an issued offer before its expiry,
// with a signed acceptance kept when given). An action already done answers as it is (repeated). Refused: ACTION_INVALID,
// RECORD_UNAVAILABLE, PERMISSION_DENIED, REVISION_CHANGED, NOT_DRAFT, NOT_APPROVED, NOT_ISSUED, NOT_OPEN, OFFER_EXPIRED,
// EXPIRY_REQUIRED, EXPIRY_PAST, the terms' refusals and record#Decision's (NOT_APPROVER, SELF_APPROVAL, ALREADY_DECIDED,
// SOURCE_CHANGED, REASON_REQUIRED, NOT_PENDING).
function changeOfferState(p) {
    const userScope = people.scopeOf()
    const action = text(p.action)
    if (!actions.includes(action)) denied("ACTION_INVALID", "Submit, approve, refuse, withdraw, issue, accept or decline")
    const found = readableOffer(userScope, p.employmentOfferId)
    const id = found.offer.employmentOfferId
    let offer = find(OFFER, {employmentOfferId: id}).forUpdate(true).one()
    const answer = repeated => Object.assign(offerAnswer(one(OFFER, {employmentOfferId: id})), {repeated})
    if (action === "approve" || action === "refuse") {
        const reason = text(p.reason) || null
        const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
            approvalKindEnumId: offerKind,
            peopleApprovalId: text(p.peopleApprovalId) || null,
            sourceId: id,
            decision: action,
            reason,
            sourceRevision: text(p.sourceRevision) || null,
            operationKey: text(p.operationKey) || null
        })
        if (decided.repeated) return answer(true)
        if (decided.complete)
            call("update#" + OFFER, {
                employmentOfferId: id,
                statusId: "OfrApproved",
                approvedDate: ec.user.nowTimestamp,
                decisionReason: null
            })
        else if (decided.statusId === "PapRefused")
            call("update#" + OFFER, {
                employmentOfferId: id,
                statusId: "OfrDraft",
                statusId_changeReason: "Not approved",
                decisionReason: reason
            })
        return answer(false)
    }
    if (!changesTerms(userScope, found.kinds))
        denied("PERMISSION_DENIED", "Moving an offer needs PEOPLE_RECRUIT_EDIT or PEOPLE_HR_EDIT of its employer")
    checkRevision(offer, p.revision)
    const now = ec.user.nowTimestamp
    const stateName = (statusTexts[stateOf(offer)] || offer.statusId).toLowerCase()
    if (action === "submit") {
        if (offer.statusId === "OfrSubmitted") return answer(true)
        if (offer.statusId !== "OfrDraft") denied("NOT_DRAFT", "Only a draft offer is submitted; this one is " + stateName)
        checkOfferTerms(offer)
        call("update#" + OFFER, {employmentOfferId: id, statusId: "OfrSubmitted", submittedDate: now, decisionReason: null})
        offer = one(OFFER, {employmentOfferId: id})
        approvals().request({
            approvalKindEnumId: offerKind,
            sourceId: id,
            organizationPartyId: offer.organizationPartyId,
            departmentPartyId: offer.departmentPartyId || null,
            subjectPartyId: offer.partyId,
            effectiveDate: offer.fromDate,
            justification: openingTitleOf(offer) || null
        })
        return answer(false)
    }
    if (action === "withdraw") {
        if (offer.statusId === "OfrWithdrawn") return answer(true)
        if (!openStatuses.includes(offer.statusId)) denied("NOT_OPEN", "This offer is " + stateName)
        call("update#" + OFFER, {
            employmentOfferId: id,
            statusId: "OfrWithdrawn",
            statusId_changeReason: text(p.reason) || "Withdrawn",
            decisionReason: text(p.reason) || null
        })
        approvals().sourceChanged(offerKind, id)
        return answer(false)
    }
    if (action === "issue") {
        if (offer.statusId === "OfrIssued") return answer(true)
        if (offer.statusId !== "OfrApproved") denied("NOT_APPROVED", "An offer is issued once approved; this one is " + stateName)
        if (offer.expireDate == null) denied("EXPIRY_REQUIRED", "Give the date the offer is open until before issuing it")
        if ((ms(offer.expireDate) ?? 0) <= nowMs()) denied("EXPIRY_PAST", "The offer's expiry has passed: change its terms")
        checkOfferTerms(offer)
        const withPay = offer.payAmount != null && offer.payAmount !== ""
        const stored = letters().store(
            {
                employmentOfferId: id,
                partyId: offer.partyId,
                organizationPartyId: offer.organizationPartyId,
                includesPay: withPay,
                fileName: "Offer-" + id
            },
            offerLetter(offer, withPay, false)
        )
        call("update#" + OFFER, {
            employmentOfferId: id,
            statusId: "OfrIssued",
            issuedDate: now,
            issuedByUserId: ec.user.userId,
            employmentLetterId: stored.employmentLetterId
        })
        return answer(false)
    }
    // the candidate's answer
    const target = action === "accept" ? "OfrAccepted" : "OfrDeclined"
    if (offer.statusId === target) return answer(true)
    if (offer.statusId !== "OfrIssued") denied("NOT_ISSUED", "The candidate answers an issued offer; this one is " + stateName)
    if (isExpired(offer)) denied("OFFER_EXPIRED", "The offer expired " + dateText(offer.expireDate) + ": make a new one")
    const answeredMs = effective(p.responseDate) ?? nowMs()
    if (answeredMs > nowMs()) denied("DATE_FUTURE", "The candidate's answer is dated today or earlier")
    const values = {
        employmentOfferId: id,
        statusId: target,
        responseDate: stamp(answeredMs),
        responseNote: text(p.responseNote) || null,
        responseByUserId: ec.user.userId
    }
    if (action === "accept" && p.evidenceFile != null && p.evidenceFile.size > 0) {
        const name =
            String(p.evidenceFile.getName() || "")
                .replace(/[\/\\?#%:]/g, "_")
                .replace(/^\.+/, "") || "acceptance"
        const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
        const location = root + "/employmentOffer/" + id + "/acceptance/" + name
        const stream = p.evidenceFile.getInputStream()
        try {
            ec.resource.getLocationReference(location).putStream(stream)
        } finally {
            stream.close()
        }
        values.evidenceLocation = location
    }
    call("update#" + OFFER, values)
    return answer(false)
}
const offerAnswer = offer => ({
    employmentOfferId: offer.employmentOfferId,
    statusId: offer.statusId,
    stateText: statusTexts[stateOf(offer)] || offer.statusId
})
// The PeopleOfferApproval topic's services: the notice's offer at the revision in its message.
function decideOfferNotice(p, action) {
    if (p.recordEntityName && p.recordEntityName !== OFFER) denied("SOURCE_INVALID", "Not an offer's approval")
    const message = p.message || {}
    return changeOfferState({
        employmentOfferId: p.recordId,
        action,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision,
        reason: p.reason
    })
}
// get#OfferEvidence: the candidate's signed acceptance of an offer, for a reader of the offer; the signed copy of a letter holding
// pay terms only for a payroll reader, as the letter (P17 review).
function offerEvidence(p) {
    const {offer, kinds} = readableOffer(people.scopeOf(), p.employmentOfferId)
    if (!offer.evidenceLocation) unavailable(offer.employmentOfferId)
    const letter = offer.employmentLetterId ? one(LETTER, {employmentLetterId: offer.employmentLetterId}) : null
    if (holdsPay(offer, letter) && !seesPay(kinds))
        denied("PERMISSION_DENIED", "The signed letter holds the offer's pay terms: it is read with PAYROLL_VIEW")
    return {location: offer.evidenceLocation, fileName: String(offer.evidenceLocation).split("/").pop()}
}

// ===== the issued letter emailed to the applicant (P17 review, the user's call of Nov 12, 2026) =====
// The current address of a purpose of a party, or "".
function emailOf(partyId, purposes) {
    if (!partyId) return ""
    for (const purpose of purposes) {
        const row = Array.from(
            people
                .current(
                    find("mantle.party.contact.PartyContactMechInfo").condition({
                        partyId,
                        contactMechPurposeId: purpose,
                        contactMechTypeEnumId: "CmtEmailAddress"
                    }),
                    null
                )
                .orderBy("-fromDate")
                .limit(1)
                .list()
        )[0]
        if (row?.infoString) return String(row.infoString).trim()
    }
    return ""
}
const escapeHtml = value =>
    String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
// send#OfferLetter: the stored letter of an issued offer emailed to the applicant's address, attached as it was stored (the issuer
// need not read it: a letter holding pay is the candidate's to read), from the employer's address, by the template
// PEOPLE_OFFER_LETTER; the message names the position and the expiry, never pay. Once: a letter sent or waiting in the mail queue
// answers repeated (the issue's tx-commit rule runs at least once). Failure tolerant: no address, no sender or a failed send is
// recorded on the offer (letterSendStatus failed, letterSendError) and the issue stands; an offer editor sends it again. Who:
// the issue's own rule, as the issuer, or a recruiter with PEOPLE_RECRUIT_EDIT or an HR editor of the employer (PERMISSION_DENIED).
function sendOfferLetter(p) {
    const userScope = people.scopeOf()
    const found = readableOffer(userScope, p.employmentOfferId)
    if (!changesTerms(userScope, found.kinds))
        denied("PERMISSION_DENIED", "Sending an offer's letter needs PEOPLE_RECRUIT_EDIT or PEOPLE_HR_EDIT of its employer")
    const id = found.offer.employmentOfferId
    // the offer locked while it is sent, so two runs send it once
    const offer = find(OFFER, {employmentOfferId: id}).forUpdate(true).one()
    const letter = offer.employmentLetterId ? one(LETTER, {employmentLetterId: offer.employmentLetterId}) : null
    if (!letter || !["OfrIssued", "OfrAccepted", "OfrHired"].includes(offer.statusId))
        denied("NOT_ISSUED", "An offer's letter is sent once the offer is issued")
    const answer = (status, repeated) => ({
        employmentOfferId: id,
        letterSendStatus: status,
        letterSendText: sendTexts[status] || "",
        repeated
    })
    if (["sent", "queued"].includes(offer.letterSendStatus) && offer.letterEmailMessageId) {
        const message = one("moqui.basic.email.EmailMessage", {emailMessageId: offer.letterEmailMessageId})
        if (["ES_SENT", "ES_READY", "ES_SCHEDULED"].includes(message?.statusId)) return answer(offer.letterSendStatus, true)
    }
    const record = (status, values) => {
        call(
            "update#" + OFFER,
            Object.assign(
                {
                    employmentOfferId: id,
                    letterSendStatus: status,
                    letterSendDate: ec.user.nowTimestamp,
                    letterSendError: null
                },
                values
            )
        )
        if (status === "failed")
            ec.logger.warn("Offer " + id + ": its letter was not emailed to the applicant: " + (values.letterSendError || ""))
        return answer(status, false)
    }
    const toAddress = ec.resource
        .script("component://mr-mantle/service/mantle/humanres/Recruiting.js")
        .applicantEmails([offer.partyId])[offer.partyId]
    if (!toAddress) return record("failed", {letterSentTo: null, letterSendError: "The applicant has no email address"})
    const organizationName = people.organizationNames([offer.organizationPartyId])[offer.organizationPartyId] || ""
    const fromAddress = emailOf(offer.organizationPartyId, ["EmailPrimary", "EmailWork"])
    if (!fromAddress)
        return record("failed", {letterSentTo: toAddress, letterSendError: "The employer has no email address to send from"})
    const names = employment().termTexts(offer)
    const position = names.positionName || openingTitleOf(offer) || "the position"
    const applicantName = people.personNames([offer.partyId])[offer.partyId] || ""
    const expires = letters().longDate(offer.expireDate)
    const lines = [
        "Dear " + (applicantName || "candidate") + ",",
        "Please find attached our offer of employment for " + position + " at " + organizationName + ".",
        expires ? "It is open until " + expires + ": to accept it, sign the letter and return it to us by then." : "",
        "Yours sincerely,\n" + organizationName
    ].filter(Boolean)
    const body =
        "<html><body>" + lines.map(line => "<p>" + escapeHtml(line).replace(/\n/g, "<br/>") + "</p>").join("") + "</body></html>"
    let emailMessageId = null
    let error = ""
    ec.message.pushErrors()
    try {
        const stream = ec.resource.getLocationStream(letter.contentLocation)
        if (!stream) throw new Error("The stored letter is not there")
        let bytes
        try {
            bytes = stream.readAllBytes()
        } finally {
            stream.close()
        }
        const out =
            ec.service
                .sync()
                .name("org.moqui.mail.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: "PEOPLE_OFFER_LETTER",
                    toAddresses: toAddress,
                    bodyParameters: {
                        subject: "Offer of employment from " + organizationName,
                        fromAddress,
                        fromName: organizationName
                    },
                    body,
                    bodyText: lines.join("\n\n"),
                    attachments: [{fileName: letter.fileName, contentType: letter.contentType, contentBytes: bytes}]
                })
                .requireNewTransaction(true)
                .disableAuthz()
                .call() || {}
        if (ec.message.hasError()) error = ec.message.getErrorsString()
        emailMessageId = out.emailMessageId || null
    } catch (thrown) {
        error = String(thrown?.message || thrown)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    const message = emailMessageId ? one("moqui.basic.email.EmailMessage", {emailMessageId}) : null
    const status =
        !error && message?.statusId === "ES_SENT"
            ? "sent"
            : !error && ["ES_READY", "ES_SCHEDULED"].includes(message?.statusId)
              ? "queued"
              : "failed"
    return record(status, {
        letterSentTo: toAddress,
        letterEmailMessageId: emailMessageId,
        letterSendError: status === "failed" ? String(error || "The message was not sent").substring(0, 255) : null
    })
}

// ===== the hire from an accepted offer (Employment.js hire#Employee and preview#Hire) =====
// The offer a hire is made from, of an employer of the HR editor (RECORD_UNAVAILABLE otherwise), locked for the hire.
function offerForHire(employmentOfferId, userScope, lock = false) {
    const id = text(employmentOfferId)
    const offer = !id
        ? null
        : lock
          ? find(OFFER, {employmentOfferId: id}).forUpdate(true).one()
          : one(OFFER, {employmentOfferId: id})
    if (!offer || !userScope.organizationPartyIds.includes(offer.organizationPartyId)) unavailable(id)
    return offer
}
// Why a hire is not made from the offer, or null: consumed already (OFFER_USED: a second hire from it is refused), not accepted
// (OFFER_NOT_ACCEPTED), of another person (OFFER_PERSON) or employer (OFFER_EMPLOYER), its application refused or withdrawn since
// (OFFER_APPLICATION_CLOSED).
function hireProblem(offer, partyId, organizationPartyId) {
    if (offer.statusId === "OfrHired")
        return ["OFFER_USED", "This offer was hired from on " + dateText(offer.hiredDate) + "; no second hire is made from it"]
    if (offer.statusId !== "OfrAccepted")
        return [
            "OFFER_NOT_ACCEPTED",
            "Only an accepted offer is hired from; this one is " + statusTexts[stateOf(offer)].toLowerCase()
        ]
    if (partyId && partyId !== offer.partyId) return ["OFFER_PERSON", "The offer is the applicant's: hire them from it"]
    if (organizationPartyId && organizationPartyId !== offer.organizationPartyId)
        return ["OFFER_EMPLOYER", "The offer is of another employer"]
    const application = one(APPLICATION, {employmentApplicationId: offer.employmentApplicationId})
    if (["EaRefused", "EaWithdrawn"].includes(application?.statusId))
        return ["OFFER_APPLICATION_CLOSED", "The application was closed: withdraw the offer"]
    return null
}
// The accepted offer consumed by the hire, once: Hired, with the employment and change it made; its application Hired.
function consumeOffer(offer, hired) {
    call("update#" + OFFER, {
        employmentOfferId: offer.employmentOfferId,
        statusId: "OfrHired",
        statusId_changeReason: "Hired",
        hiredDate: ec.user.nowTimestamp,
        partyRelationshipId: hired.partyRelationshipId,
        employmentChangeId: hired.employmentChangeId
    })
    const application = one(APPLICATION, {employmentApplicationId: offer.employmentApplicationId})
    if (application?.statusId === "EaOffer")
        call("update#" + APPLICATION, {
            employmentApplicationId: application.employmentApplicationId,
            statusId: "EaHired",
            statusId_changeReason: "Hired from offer " + offer.employmentOfferId
        })
}

const operations = {
    findOffers,
    getOffer,
    storeOffer,
    changeOfferState,
    approveNotice: p => decideOfferNotice(p, "approve"),
    refuseNotice: p => decideOfferNotice(p, "refuse"),
    getOfferLetter,
    offerEvidence,
    sendOfferLetter
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown offer operation " + op)
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return operations[op](p || {})
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute: run,
    // for Employment.js (hire#Employee and preview#Hire) and Recruiting.js (the Offer stage)
    offerForHire,
    hireProblem,
    consumeOffer,
    openStatuses,
    // for Approvals.js (the notice of an offer to approve)
    openingTitleOf
})
