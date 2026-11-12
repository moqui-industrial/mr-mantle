// People's skills and qualifications (mantle.humanres.DevelopmentServices; IronStone People design §10 SkillsMatrix and
// Qualifications, §4 Employee360 SkillsAndReviews, PE-14, PE-01; impl-people P18). Every read is a projection of the caller's
// People scope (People.js scopeOf and partyAccess), read with authorization off after that check.
//
// The records (design §10; impl-people F6, F7, F8):
// - a skill's level is PartySkill's (a SkillLevel value's number, 1 to 5), with where it comes from: each self-declaration and each
//   evaluation is a PartySkillEvaluation kept as history; an evaluation sets the level, a self-declaration only where no
//   evaluation has. A self-declared level is labelled so and satisfies no requirement (a claimed skill is not proof);
// - a qualification is a PartyQualification with its own identity: submitted by the person (or an HR or development editor
//   for them), verified, rejected or revoked by an authorized verifier who is not the person, renewed by a new row that names
//   the one it renews. An identity document or work permit (QualIdentityDocument, QualWorkPermit and their child types) needs
//   an expiry and is restricted: its reference (the document number) is read only by the person and HR of an employer of
//   theirs, and only HR verifies it;
// - a requirement is a job class's (EmplPositionClassSkill: the least level, a qualification type that must prove it, required
//   or desired, its dates) or a work effort's (WorkEffortSkillStandard.minimumSkillLevel, shared with Maintenance's steps).
//
// Who reads what of a person (the levels of projection):
// - full: the person themselves (PEOPLE_SELF_SERVICE) and an HR reader (PEOPLE_HR_VIEW) of an employer of theirs: every field,
//   the reference of a restricted type, and the files (the qualification's content host, PartyQualificationContent);
// - develop: a development reader (PEOPLE_DEVELOP_VIEW) of an employer of theirs: every field but a restricted type's
//   reference, no files;
// - staffing: a manager of the person (PEOPLE_TEAM_VIEW, a live line) and any other People staff reader of their employer:
//   verified qualifications only, as their type, dates and validity; no title, issuer, reference, reason or file.
// check#Qualifications answers the staffing projection to every caller: per requirement qualified, expiring, missing or expired
// at the date, with the reason in words, never a number, issuer or file. Skills are read by the person, a manager, development
// and HR. A self-declaration is the person's; an evaluation needs PEOPLE_DEVELOP_EDIT and a development reader's or manager's
// scope, or is a manager's own of a live report (SksManagerEvaluated, the user's call of Nov 12, 2026, with no PEOPLE_DEVELOP_EDIT);
// certificates stay the development and HR verifiers'. No one verifies or evaluates their own record, whatever their permissions.
// Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const employees = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Employees.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const SKILL = "mantle.humanres.ability.PartySkill"
const EVALUATION = "mantle.humanres.ability.PartySkillEvaluation"
const QUALIFICATION = "mantle.humanres.ability.PartyQualification"
const RESUME = "mantle.humanres.ability.PartyResume"
const CLASS_SKILL = "mantle.humanres.position.EmplPositionClassSkill"
const SKILL_STANDARD = "mantle.work.effort.WorkEffortSkillStandard"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const ENUM = "moqui.basic.Enumeration"
// the qualification kinds whose types are restricted and need an expiry, with every type under them
const restrictedKinds = ["QualIdentityDocument", "QualWorkPermit"]
const self = "SksSelfDeclared"
const evaluated = "SksEvaluated"
// a manager's evaluation of a live report, without PEOPLE_DEVELOP_EDIT (the user's call of Nov 12, 2026): it meets a requirement
// as an evaluation does
const managerEvaluated = "SksManagerEvaluated"
const PENDING = "QlVerPending",
    VERIFIED = "QlVerVerified",
    REJECTED = "QlVerRejected",
    REVOKED = "QlVerRevoked"
const verificationTexts = {
    [PENDING]: "Waiting for verification",
    [VERIFIED]: "Verified",
    [REJECTED]: "Rejected",
    [REVOKED]: "Revoked"
}
// a verified qualification expiring within this many days is "expiring" (Today, the reminder, staffing)
const expiringDays = 30
const day = 24 * 60 * 60 * 1000
// the most people a matrix or a list reads, the columns a matrix shows when no class or skill narrows it
const peopleCap = 2000
const columnCap = 24
const qualificationCap = 2000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
const unique = people.unique
const given = value => value != null
const flag = value => value === true || value === "true" || value === "Y"
const stampOf = row => String(ms(row?.lastUpdatedStamp) ?? 0)
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"

// ===== names and vocabularies =====
function enumRows(enumIds) {
    const ids = unique(enumIds.filter(Boolean))
    if (!ids.length) return new Map()
    return new Map(Array.from(find(ENUM).condition("enumId", "in", ids).list()).map(row => [row.enumId, row]))
}
const nameOf = (names, enumId) => names.get(enumId)?.description || enumId || ""
// the current values of a vocabulary (Enumeration.thruDate: an ended one is offered for no new record)
const isCurrent = row => !!row && (ms(row.thruDate) ?? Infinity) > nowMs()
// The skill levels: {number: name} of the current SkillLevel values (each value's enumCode its number).
function levelNames() {
    const found = {}
    for (const row of rows(ENUM, {enumTypeId: "SkillLevel"}))
        if (isCurrent(row) && /^\d+$/.test(String(row.enumCode || ""))) found[Number(row.enumCode)] = row.description
    return found
}
const levelText = (level, names) => (level == null ? "" : level + (names[level] ? " " + names[level] : ""))
// A skill's level: its own, else a rating recorded before People.
const levelOf = row => (row ? (row.skillLevel ?? row.rating ?? null) : null)
// The kind of a qualification type: the type itself or its parent's (a child type of a kind, such as a passport under
// identity documents), so a requirement of a kind is met by any type under it.
const families = new Map()
function typeFamily(enumId) {
    if (families.has(enumId)) return families.get(enumId)
    const chain = []
    let id = enumId
    for (let depth = 0; id && depth < 6 && !chain.includes(id); depth++) {
        chain.push(id)
        id = one(ENUM, {enumId: id})?.parentEnumId || null
    }
    families.set(enumId, chain)
    return chain
}
const isRestricted = enumId => typeFamily(enumId).some(id => restrictedKinds.includes(id))

// ===== access =====
// How the caller reads a person: self, a manager (team), an HR reader, a development reader or another staff reader of an
// employer of theirs; the level of the projection; and what they may change. A person outside the scope reads nothing.
function accessTo(userScope, partyId, asOf = null) {
    const admitted = people.checkedAccess(userScope, partyId, asOf, true)
    const kinds = admitted.kinds
    const staffEmployments = admitted.employments.filter(row => userScope.organizationPartyIds.includes(row.organizationPartyId))
    return accessOf(userScope, partyId, {
        self: kinds.includes("self"),
        staff: kinds.includes("staff") && staffEmployments.length > 0,
        team: kinds.includes("team")
    })
}
// The access of the kinds that admit a person (self, staff of an employer in scope, team), read once for a list's people.
function accessOf(userScope, partyId, kinds) {
    const caps = userScope.capabilities
    const isSelf = !!kinds.self && partyId === userScope.partyId && !!caps.self
    const staff = !!kinds.staff
    const hr = staff && !!caps.hrView
    const develop = staff && !!caps.developView
    const team = !!kinds.team
    // the caller's own record, whatever admits it (a staff reader's own employment too): never verified or evaluated by them
    const own = !!userScope.partyId && partyId === userScope.partyId
    const level = isSelf || hr ? "full" : develop ? "develop" : team || staff ? "staffing" : null
    const developEdit = (develop || team) && !!caps.developEdit
    return {
        partyId,
        admitted: isSelf || staff || team,
        self: isSelf,
        own,
        hr,
        develop,
        team,
        staff,
        level,
        readsSkills: isSelf || hr || develop || team,
        hrEdit: hr && !!caps.hrEdit,
        developEdit,
        // who evaluates the person's skills: a development editor of their employer or manager, and a manager of a live line
        // without PEOPLE_DEVELOP_EDIT (their evaluation recorded as the manager's); never the person themselves
        evaluates: !own && (developEdit || team),
        evaluationSource: developEdit ? evaluated : managerEvaluated
    }
}
function requireAdmitted(found, what) {
    if (!found.admitted) denied("RECORD_UNAVAILABLE", what + " is not available")
    return found
}
// Whether the caller submits or changes a person's qualification of a type: the person, an HR editor of an employer of theirs,
// or a development editor for a type that is not restricted.
const submits = (found, restricted) => found.self || found.hrEdit || (!restricted && found.develop && found.developEdit)
// Whether the caller verifies, rejects or revokes it: an HR editor, or a development editor for a type that is not restricted;
// never the person (checked apart, SELF_APPROVAL).
const verifies = (found, restricted) => found.hrEdit || (!restricted && found.develop && found.developEdit)

// ===== qualifications =====
// A qualification's validity at a time: not yet valid, valid, expiring within the window, expired; a qualification with no
// expiry stays valid.
function validityOf(row, at) {
    const fromMs = ms(row.fromDate)
    const thruMs = ms(row.thruDate)
    if (fromMs != null && fromMs > at) return "notYet"
    if (thruMs != null && thruMs <= at) return "expired"
    if (thruMs != null && thruMs - at <= expiringDays * day) return "expiring"
    return "valid"
}
const validityTexts = {notYet: "Not yet valid", valid: "Valid", expiring: "Expiring", expired: "Expired"}
// One qualification as the caller's level of projection reads it (null when that level does not show it: staffing reads only
// verified ones).
function qualificationRow(row, found, names, personNames, at) {
    const restricted = isRestricted(row.qualificationTypeEnumId)
    const level = found.level
    if (!level || (level === "staffing" && row.verificationStatusId !== VERIFIED)) return null
    const validity = validityOf(row, at)
    const out = {
        partyQualificationId: row.partyQualificationId,
        partyId: row.partyId,
        personName: personNames[row.partyId] || row.partyId,
        qualificationTypeEnumId: row.qualificationTypeEnumId,
        typeText: nameOf(names, row.qualificationTypeEnumId),
        restricted,
        fromDate: ms(row.fromDate),
        thruDate: ms(row.thruDate),
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        verificationStatusId: row.verificationStatusId,
        verificationText: verificationTexts[row.verificationStatusId] || "",
        validity: row.verificationStatusId === VERIFIED ? validity : null,
        validityText: row.verificationStatusId === VERIFIED ? validityTexts[validity] : "",
        renewsQualificationId: level === "staffing" ? null : row.renewsQualificationId || null,
        canVerify: false,
        canChange: false,
        canReadFiles: false,
        revision: stampOf(row)
    }
    if (level === "staffing") return out
    Object.assign(out, {
        title: row.title || "",
        issuerName: row.issuerName || "",
        // a restricted type's reference: the person's and HR's alone
        referenceNumber: level === "full" || !restricted ? row.referenceNumber || "" : null,
        submittedDateText: dateText(row.submittedDate),
        verifiedDateText: dateText(row.verifiedDate),
        decisionReason: row.decisionReason || "",
        comments: row.comments || ""
    })
    const open = row.verificationStatusId === PENDING || row.verificationStatusId === REJECTED
    out.canVerify =
        !found.own &&
        verifies(found, restricted) &&
        (row.verificationStatusId === PENDING || row.verificationStatusId === VERIFIED)
    out.canChange = open && submits(found, restricted)
    out.canReadFiles = found.self || found.hr
    return out
}
// The people a list reads without a person asked for: the current employees of the employers a staff reader sees (or the one
// asked), and a manager's live reports at their lines' employers: {partyId: {self, staff, team}}, the kinds that admit each
// (withStaff false leaves out a staff reader's employees).
function populationOf(userScope, p, asOf, withStaff = true) {
    const caps = userScope.capabilities
    const found = new Map()
    const entry = partyId => found.get(partyId) || found.set(partyId, {self: true, staff: false, team: false}).get(partyId)
    if (withStaff && caps.staff) {
        people.requireOrganization(userScope, p.organizationPartyId || null)
        const organizationPartyIds = p.organizationPartyId ? [p.organizationPartyId] : userScope.organizationPartyIds
        if (organizationPartyIds.length) {
            const query = people
                .current(people.employmentFind().condition("toPartyId", "in", organizationPartyIds), asOf)
                .limit(peopleCap)
            for (const row of Array.from(query.list())) entry(row.fromPartyId).staff = true
        }
    }
    for (const [partyId, employers] of Object.entries(userScope.reportLines || {}))
        if (!p.organizationPartyId || employers.includes(p.organizationPartyId)) entry(partyId).team = true
    return found
}
// The people whose names hold a text, ignoring case.
function peopleNamed(partyIds, term) {
    if (!partyIds.length || !text(term)) return partyIds
    const factory = ec.entity.conditionFactory
    const found = new Set()
    for (let index = 0; index < partyIds.length; index += 500) {
        const query = find("mantle.party.Person")
            .condition("partyId", "in", partyIds.slice(index, index + 500))
            .condition(
                factory.makeCondition(
                    ["partyId", "firstName", "lastName", "nickname"].map(field =>
                        factory.makeCondition(field, "like", likeText(text(term))).ignoreCase()
                    ),
                    "or"
                )
            )
            .selectField("partyId")
        for (const row of Array.from(query.list())) found.add(row.partyId)
    }
    return partyIds.filter(partyId => found.has(partyId))
}
// find#Qualifications: the qualifications the caller reads, as their level of projection reads each: their own (mine), one
// person's (partyId), one qualification (partyQualificationId), or every person the caller's scope reaches (an employer's
// employees for a staff reader, a manager's reports). show narrows them: waiting (submitted, not decided), valid, expiring
// (verified, expiring within thirty days), expired, attention (verified and expiring or expired, not renewed by a later
// verified one); qualificationTypeEnumId to a type and those under it; term to the people named. Paged.
function findQualifications(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const at = nowMs()
    let accessByParty = new Map()
    let partyIds
    if (text(p.partyQualificationId)) {
        const row = one(QUALIFICATION, {partyQualificationId: text(p.partyQualificationId)})
        const found = row ? accessTo(userScope, row.partyId) : {level: null}
        if (!row || !found.level || (found.level === "staffing" && row.verificationStatusId !== VERIFIED))
            denied("RECORD_UNAVAILABLE", "Qualification " + p.partyQualificationId + " is not available")
        accessByParty.set(row.partyId, found)
        partyIds = [row.partyId]
    } else if (flag(p.mine) || (text(p.partyId) && text(p.partyId) === userScope.partyId)) {
        if (!userScope.partyId || !caps.self) denied("PERMISSION_DENIED", "Your qualifications need PEOPLE_SELF_SERVICE")
        accessByParty.set(userScope.partyId, accessTo(userScope, userScope.partyId))
        partyIds = [userScope.partyId]
    } else if (text(p.partyId)) {
        const found = requireAdmitted(accessTo(userScope, text(p.partyId)), "Person " + p.partyId)
        accessByParty.set(found.partyId, found)
        partyIds = [found.partyId]
    } else {
        if (!caps.staff && !caps.team) denied("PERMISSION_DENIED", "Qualifications are not available")
        const population = populationOf(userScope, p, at)
        partyIds = peopleNamed(Array.from(population.keys()), p.term)
        accessByParty = new Map(partyIds.map(partyId => [partyId, accessOf(userScope, partyId, population.get(partyId))]))
    }
    const empty = Object.assign(lib.pageList([], p, "qualifications"), {canSubmit: !!caps.self && !!userScope.partyId})
    if (!partyIds.length) return empty
    let query = find(QUALIFICATION).condition("partyId", "in", partyIds.slice(0, peopleCap))
    if (text(p.partyQualificationId)) query = query.condition("partyQualificationId", text(p.partyQualificationId))
    if (text(p.qualificationTypeEnumId)) {
        const typeIds = [text(p.qualificationTypeEnumId)].concat(
            Array.from(find(ENUM).condition("parentEnumId", text(p.qualificationTypeEnumId)).list()).map(row => row.enumId)
        )
        query = query.condition("qualificationTypeEnumId", "in", typeIds)
    }
    const show = text(p.show) || "all"
    const window = people.stamp(at + expiringDays * day)
    const now = people.stamp(at)
    if (show === "waiting") query = query.condition("verificationStatusId", PENDING)
    else if (show !== "all") {
        query = query.condition("verificationStatusId", VERIFIED)
        const factory = ec.entity.conditionFactory
        if (show === "valid")
            query = query.condition(
                factory.makeCondition(
                    factory.makeCondition("thruDate", "is-null", null),
                    "or",
                    factory.makeCondition("thruDate", "greater", now)
                )
            )
        else if (show === "expiring")
            query = query.condition("thruDate", "greater", now).condition("thruDate", "less-equals", window)
        else if (show === "expired") query = query.condition("thruDate", "less-equals", now)
        else if (show === "attention") query = query.condition("thruDate", "less-equals", window)
        else denied("SHOW_INVALID", "Show one of all, waiting, valid, expiring, expired or attention")
    }
    let found = Array.from(query.limit(qualificationCap).list())
    if (show === "attention") found = notRenewed(found)
    const names = enumRows(found.map(row => row.qualificationTypeEnumId))
    const personNames = people.personNames(unique(found.map(row => row.partyId)))
    const out = []
    for (const row of found) {
        if (!accessByParty.has(row.partyId)) accessByParty.set(row.partyId, accessTo(userScope, row.partyId))
        const shown = qualificationRow(row, accessByParty.get(row.partyId), names, personNames, at)
        if (shown) out.push(shown)
    }
    out.sort(
        (a, b) =>
            a.personName.localeCompare(b.personName) ||
            a.typeText.localeCompare(b.typeText) ||
            (b.fromDate ?? 0) - (a.fromDate ?? 0)
    )
    return Object.assign(lib.pageList(out, p, "qualifications", {noLimitCap: qualificationCap}), {
        canSubmit: !!caps.self && !!userScope.partyId
    })
}
// The verified qualifications not renewed by a later verified one of the same person and type (a later expiry, or none).
function notRenewed(found) {
    if (!found.length) return found
    const later = Array.from(
        find(QUALIFICATION)
            .condition("partyId", "in", unique(found.map(row => row.partyId)))
            .condition("verificationStatusId", VERIFIED)
            .list()
    )
    return found.filter(
        row =>
            !later.some(
                other =>
                    other.partyQualificationId !== row.partyQualificationId &&
                    other.partyId === row.partyId &&
                    other.qualificationTypeEnumId === row.qualificationTypeEnumId &&
                    (ms(other.thruDate) ?? Infinity) > (ms(row.thruDate) ?? Infinity)
            )
    )
}
// store#Qualification: a qualification submitted, or one waiting or rejected changed and submitted again. Refused: a person not
// in scope (RECORD_UNAVAILABLE); a caller who may not submit it (PERMISSION_DENIED: the person, an HR editor, or a development
// editor for a type not restricted); no type, not one, or ended (TYPE_REQUIRED, TYPE_INVALID, VALUE_ENDED); an identity
// document or work permit with no expiry (EXPIRY_REQUIRED); an expiry not after its start (DATES_INVALID); a renewal of
// another person's or another type's qualification (RENEWAL_INVALID); a change of a verified or revoked one, which is renewed
// instead (QUALIFICATION_DECIDED); a revision other than the one read (REVISION_CHANGED).
function storeQualification(p) {
    const userScope = people.scopeOf()
    const id = text(p.partyQualificationId)
    const existing = id ? one(QUALIFICATION, {partyQualificationId: id}) : null
    if (id && !existing) denied("RECORD_UNAVAILABLE", "Qualification " + id + " is not available")
    const partyId = existing ? existing.partyId : text(p.partyId) || userScope.partyId
    if (!partyId) denied("RECORD_UNAVAILABLE", "Choose the person")
    const found = accessTo(userScope, partyId)
    if (!found.admitted || (existing && found.level !== "full" && found.level !== "develop"))
        denied("RECORD_UNAVAILABLE", (existing ? "Qualification " + id : "Person " + partyId) + " is not available")
    const typeId = given(p.qualificationTypeEnumId) ? text(p.qualificationTypeEnumId) : existing?.qualificationTypeEnumId || ""
    if (!typeId) denied("TYPE_REQUIRED", "Choose the kind of qualification")
    const type = one(ENUM, {enumId: typeId})
    if (!type || type.enumTypeId !== "QualificationType") denied("TYPE_INVALID", typeId + " is not a qualification type")
    if ((!existing || existing.qualificationTypeEnumId !== typeId) && !isCurrent(type))
        denied("VALUE_ENDED", (type.description || typeId) + " has ended")
    const restricted = isRestricted(typeId) || (existing && isRestricted(existing.qualificationTypeEnumId))
    if (!submits(found, restricted))
        denied("PERMISSION_DENIED", "Submitting this qualification is the person's, or an HR or development editor's")
    if (existing) {
        if (![PENDING, REJECTED].includes(existing.verificationStatusId))
            denied("QUALIFICATION_DECIDED", "A verified or revoked qualification is not changed; add its renewal")
        if (text(p.expectedRevision) !== stampOf(existing))
            denied(
                "REVISION_CHANGED",
                "This qualification changed since you read it; open it again (revision " + stampOf(existing) + ")"
            )
    }
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const dateValue = (name, fallback) =>
        given(p[name]) ? (text(p[name]) ? new Date(effective(p[name])) : null) : fallback == null ? null : new Date(ms(fallback))
    const fromDate = dateValue("fromDate", existing?.fromDate)
    const thruDate = dateValue("thruDate", existing?.thruDate)
    if (isRestricted(typeId) && !thruDate) denied("EXPIRY_REQUIRED", (type.description || typeId) + " needs its expiry")
    if (fromDate && thruDate && thruDate.getTime() <= fromDate.getTime())
        denied("DATES_INVALID", "The expiry is after the date it was issued")
    const renewsId = value("renewsQualificationId", existing?.renewsQualificationId)
    if (renewsId) {
        const renewed = one(QUALIFICATION, {partyQualificationId: renewsId})
        if (
            !renewed ||
            renewed.partyId !== partyId ||
            renewsId === id ||
            typeFamily(renewed.qualificationTypeEnumId).at(-1) !== typeFamily(typeId).at(-1)
        )
            denied("RENEWAL_INVALID", "A renewal renews an earlier qualification of the same person and kind")
    }
    const values = {
        partyId,
        qualificationTypeEnumId: typeId,
        title: value("title", existing?.title),
        issuerName: value("issuerName", existing?.issuerName),
        referenceNumber: value("referenceNumber", existing?.referenceNumber),
        fromDate,
        thruDate,
        renewsQualificationId: renewsId,
        comments: value("comments", existing?.comments),
        verificationStatusId: PENDING,
        submittedByUserId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        verifiedByUserId: null,
        verifiedDate: null,
        decisionReason: null
    }
    let partyQualificationId = id
    if (existing) {
        values.partyQualificationId = id
        values.verificationStatusId_changeReason = existing.verificationStatusId === REJECTED ? "Submitted again" : "Changed"
        call("update#" + QUALIFICATION, values)
    } else {
        values.verificationStatusId_changeReason = "Submitted"
        partyQualificationId = call("create#" + QUALIFICATION, values).partyQualificationId
    }
    return {partyQualificationId, revision: stampOf(one(QUALIFICATION, {partyQualificationId}))}
}
// verify#Qualification: a waiting qualification verified or rejected, or a verified one revoked, by an authorized verifier at the
// revision read; the state audit-logged with the reason. Refused: one not in scope (RECORD_UNAVAILABLE); a caller who may not
// verify it (PERMISSION_DENIED: an HR editor of an employer of the person, or a development editor for a type not restricted);
// the person's own (SELF_APPROVAL); a decision that is not one (DECISION_INVALID); verifying or rejecting one not waiting
// (NOT_PENDING), revoking one not verified (NOT_VERIFIED); a rejection or revocation with no reason (REASON_REQUIRED); a revision
// other than the one read (REVISION_CHANGED).
function verifyQualification(p) {
    const userScope = people.scopeOf()
    const id = text(p.partyQualificationId)
    const row = id ? one(QUALIFICATION, {partyQualificationId: id}) : null
    const found = row ? accessTo(userScope, row.partyId) : {admitted: false}
    if (!row || !found.admitted || !found.level || (found.level === "staffing" && row.verificationStatusId !== VERIFIED))
        denied("RECORD_UNAVAILABLE", "Qualification " + id + " is not available")
    // the verifier's own qualification, whatever admits them to it (an HR editor's own employment too)
    if (found.own) denied("SELF_APPROVAL", "Your own qualification is verified by someone else")
    const restricted = isRestricted(row.qualificationTypeEnumId)
    if (!verifies(found, restricted))
        denied(
            "PERMISSION_DENIED",
            restricted
                ? "An identity document or work permit is verified by HR"
                : "Verifying needs PEOPLE_DEVELOP_EDIT or PEOPLE_HR_EDIT"
        )
    const decision = text(p.decision) || "verify"
    if (!["verify", "reject", "revoke"].includes(decision)) denied("DECISION_INVALID", "Verify, reject or revoke")
    if (decision !== "revoke" && row.verificationStatusId !== PENDING)
        denied("NOT_PENDING", "Only a qualification waiting for verification is verified or rejected")
    if (decision === "revoke" && row.verificationStatusId !== VERIFIED)
        denied("NOT_VERIFIED", "Only a verified qualification is revoked")
    const reason = text(p.reason)
    if (decision !== "verify" && !reason) denied("REASON_REQUIRED", "Say why")
    if (text(p.expectedRevision) !== stampOf(row))
        denied("REVISION_CHANGED", "This qualification changed since you read it; open it again (revision " + stampOf(row) + ")")
    const statusId = {verify: VERIFIED, reject: REJECTED, revoke: REVOKED}[decision]
    call("update#" + QUALIFICATION, {
        partyQualificationId: id,
        verificationStatusId: statusId,
        verificationStatusId_changeReason: reason || "Verified",
        verifiedByUserId: ec.user.userId,
        verifiedDate: ec.user.nowTimestamp,
        decisionReason: decision === "verify" ? null : reason
    })
    return {
        partyQualificationId: id,
        verificationStatusId: statusId,
        revision: stampOf(one(QUALIFICATION, {partyQualificationId: id}))
    }
}

// ===== the qualification's content host (PE-01) =====
// Whether the caller reads a qualification's files: the person and an HR reader of an employer of theirs; canEdit for the person
// while it waits or was rejected, and for an HR editor of another person's. Never refuses: a qualification that is not one, or
// not the caller's to read, answers recordVisible false, and so does a call with no user.
function qualificationAccess(p) {
    const no = {recordVisible: false, canEdit: false, partyId: null}
    if (!ec.user.userId || !text(p.partyQualificationId)) return no
    const row = one(QUALIFICATION, {partyQualificationId: text(p.partyQualificationId)})
    if (!row) return no
    const found = accessTo(people.scopeOf(), row.partyId)
    if (!found.self && !found.hr) return no
    const open = row.verificationStatusId === PENDING || row.verificationStatusId === REJECTED
    // an HR editor changes another person's files at any state, their own only while it waits or was rejected, as the person does
    return {recordVisible: true, canEdit: (found.hrEdit && !found.own) || (found.own && open), partyId: row.partyId}
}
function contentAccess(p) {
    const found = qualificationAccess(p)
    if (!found.recordVisible) denied("RECORD_UNAVAILABLE", "Qualification " + p.partyQualificationId + " is not available")
    if (!found.canEdit)
        denied("PERMISSION_DENIED", "This qualification's files are changed by the person while it waits, or by HR")
    return found
}

// ===== requirements and the staffing check =====
// A job class's requirements in effect at a time (EmplPositionClassSkill: the level, the qualification type, required or desired).
// Each period of a requirement is its own row (keyed by its start, the user's call of Nov 12, 2026): the row in effect at the time,
// the latest start should two overlap.
function classRequirements(emplPositionClassIds, at) {
    const found = {}
    if (!emplPositionClassIds.length) return found
    const inEffect = new Map()
    for (const row of Array.from(find(CLASS_SKILL).condition("emplPositionClassId", "in", emplPositionClassIds).list())) {
        if (!openAt(row, at)) continue
        const key = row.emplPositionClassId + "/" + row.skillTypeEnumId
        const other = inEffect.get(key)
        if (!other || (ms(row.fromDate) ?? -Infinity) > (ms(other.fromDate) ?? -Infinity)) inEffect.set(key, row)
    }
    for (const row of inEffect.values()) {
        ;(found[row.emplPositionClassId] || (found[row.emplPositionClassId] = [])).push({
            skillTypeEnumId: row.skillTypeEnumId,
            minimumLevel: row.minimumLevel ?? null,
            qualificationTypeEnumId: row.qualificationTypeEnumId || null,
            required: row.requiredFlag !== "N"
        })
    }
    return found
}
// The requirements a check is against: a job class's, a work effort's skill standards (their minimumSkillLevel), or one skill or
// qualification type asked for; null when none is named (each person's own job class then).
function requirementsAsked(p, at) {
    if (text(p.emplPositionClassId)) {
        if (!one("mantle.humanres.position.EmplPositionClass", {emplPositionClassId: text(p.emplPositionClassId)}))
            denied("RECORD_UNAVAILABLE", "Job class " + p.emplPositionClassId + " is not available")
        return classRequirements([text(p.emplPositionClassId)], at)[text(p.emplPositionClassId)] || []
    }
    if (text(p.workEffortId))
        return rows(SKILL_STANDARD, {workEffortId: text(p.workEffortId)}).map(row => ({
            skillTypeEnumId: row.skillTypeEnumId,
            minimumLevel: row.minimumSkillLevel ?? null,
            qualificationTypeEnumId: null,
            required: true
        }))
    if (text(p.skillTypeEnumId) || text(p.qualificationTypeEnumId))
        return [
            {
                skillTypeEnumId: text(p.skillTypeEnumId) || null,
                minimumLevel: given(p.minimumLevel) && text(p.minimumLevel) ? Number(p.minimumLevel) : null,
                qualificationTypeEnumId: text(p.qualificationTypeEnumId) || null,
                required: true
            }
        ]
    return null
}
// The job classes of the people's current employments (the seat each holds, People's job title): {partyId: [classId]}.
function classesOf(partyIds, at) {
    const found = {}
    if (!partyIds.length) return found
    const employments = Array.from(
        people.current(people.employmentFind().condition("fromPartyId", "in", partyIds), people.stamp(at)).list()
    )
    const titles = employments.length
        ? employees().titlesOf(
              employments.map(row => row.partyRelationshipId),
              people.stamp(at)
          )
        : {}
    for (const row of employments) {
        const classId = titles[row.partyRelationshipId]?.emplPositionClassId
        if (classId && !(found[row.fromPartyId] || (found[row.fromPartyId] = [])).includes(classId))
            found[row.fromPartyId].push(classId)
    }
    return found
}
const states = ["missing", "expired", "expiring", "qualified"]
const stateTexts = {missing: "Missing", expired: "Expired", expiring: "Expiring", qualified: "Qualified"}
const worse = (a, b) => (states.indexOf(a) <= states.indexOf(b) ? a : b)
// One requirement of one person at a time: its state and why, from their skill row and their qualifications. A self-declared level
// and an unverified, rejected or revoked qualification meet nothing; a verified one expired at the date is expired, one expiring
// within the window is expiring.
function assess(requirement, skillRow, qualifications, at, levels) {
    let state = "qualified"
    const reasons = []
    let validThru = null
    // the skill's level is asked for when the requirement names a least level, or no qualification proves it (a qualification
    // that proves a skill with no level asked meets the skill part)
    if (requirement.skillTypeEnumId && (requirement.minimumLevel != null || !requirement.qualificationTypeEnumId)) {
        const level = levelOf(skillRow)
        if (level == null) {
            state = "missing"
            reasons.push("No level recorded")
        } else if (skillRow.sourceEnumId === self) {
            state = "missing"
            reasons.push("Self-declared only")
        } else if (requirement.minimumLevel != null && level < requirement.minimumLevel) {
            state = "missing"
            reasons.push("Level " + levelText(level, levels) + " of " + levelText(requirement.minimumLevel, levels))
        }
    }
    if (requirement.qualificationTypeEnumId) {
        const ofType = qualifications.filter(row =>
            typeFamily(row.qualificationTypeEnumId).includes(requirement.qualificationTypeEnumId)
        )
        const verified = ofType.filter(row => row.verificationStatusId === VERIFIED && (ms(row.fromDate) ?? -Infinity) <= at)
        const valid = verified.filter(row => (ms(row.thruDate) ?? Infinity) > at)
        let found = "missing"
        if (valid.length) {
            const best = valid.reduce((a, b) => ((ms(a.thruDate) ?? Infinity) >= (ms(b.thruDate) ?? Infinity) ? a : b))
            validThru = ms(best.thruDate)
            found = validThru != null && validThru - at <= expiringDays * day ? "expiring" : "qualified"
            if (found === "expiring") reasons.push("Expires " + dateText(validThru))
        } else if (verified.length) {
            found = "expired"
            const last = verified.reduce((a, b) => ((ms(a.thruDate) ?? 0) >= (ms(b.thruDate) ?? 0) ? a : b))
            reasons.push("Expired " + dateText(last.thruDate))
        } else if (ofType.some(row => row.verificationStatusId === PENDING)) reasons.push("Waiting for verification")
        else reasons.push("No verified qualification")
        state = worse(state, found)
    }
    return {state, stateText: stateTexts[state], explanation: reasons.join("; "), validThru, validThruText: dateText(validThru)}
}
// check#Qualifications: for each person (partyIdList or partyId) the requirements asked (a job class's, a work effort's skill
// standards, or one skill and qualification type), else each person's own job class's, at the date (now when none): each
// requirement qualified, expiring, missing or expired with the reason in words, and the person's state, the worst of the required
// ones. The staffing projection: no reference, issuer, title, reason of a decision or file, for every caller. A person the
// caller's People scope does not admit answers state unavailable and nothing else; a caller with no People reach is refused
// (PERMISSION_DENIED).
function checkQualifications(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.staff && !caps.team && !caps.self) denied("PERMISSION_DENIED", "Qualification checks are not available")
    const at = given(p.asOfDate) && text(p.asOfDate) ? people.asOfMillis(p.asOfDate) : nowMs()
    const asked = requirementsAsked(p, at)
    const partyIds = unique(
        (Array.isArray(p.partyIdList)
            ? p.partyIdList
            : given(p.partyIdList) && text(p.partyIdList)
              ? String(p.partyIdList).split(",")
              : []
        )
            .concat(text(p.partyId) ? [text(p.partyId)] : [])
            .map(text)
            .filter(Boolean)
    ).slice(0, 500)
    const admitted = partyIds.filter(partyId => accessTo(userScope, partyId).admitted)
    const own = asked ? null : classesOf(admitted, at)
    const ownRequirements = own ? classRequirements(unique(Object.values(own).flat()), at) : {}
    const requirementsFor = partyId =>
        asked ||
        (own[partyId] || [])
            .flatMap(classId => ownRequirements[classId] || [])
            .filter((row, index, list) => list.findIndex(other => other.skillTypeEnumId === row.skillTypeEnumId) === index)
    const allRequirements = admitted.flatMap(requirementsFor)
    const skillRows = new Map()
    const skillIds = unique(allRequirements.map(row => row.skillTypeEnumId).filter(Boolean))
    if (admitted.length && skillIds.length)
        for (const row of Array.from(
            find(SKILL).condition("partyId", "in", admitted).condition("skillTypeEnumId", "in", skillIds).list()
        ))
            skillRows.set(row.partyId + "/" + row.skillTypeEnumId, row)
    const qualifications = admitted.length ? Array.from(find(QUALIFICATION).condition("partyId", "in", admitted).list()) : []
    const names = enumRows(allRequirements.flatMap(row => [row.skillTypeEnumId, row.qualificationTypeEnumId]).filter(Boolean))
    const levels = levelNames()
    const personNames = people.personNames(admitted)
    const results = partyIds.map(partyId => {
        if (!admitted.includes(partyId)) return {partyId, state: "unavailable", stateText: "Not available", requirements: []}
        const own = qualifications.filter(row => row.partyId === partyId)
        const requirements = requirementsFor(partyId).map(requirement => {
            const found = assess(requirement, skillRows.get(partyId + "/" + requirement.skillTypeEnumId), own, at, levels)
            return {
                skillTypeEnumId: requirement.skillTypeEnumId,
                skillName: nameOf(names, requirement.skillTypeEnumId),
                minimumLevel: requirement.minimumLevel,
                minimumLevelText: levelText(requirement.minimumLevel, levels),
                qualificationTypeEnumId: requirement.qualificationTypeEnumId,
                qualificationTypeName: nameOf(names, requirement.qualificationTypeEnumId),
                required: requirement.required,
                state: found.state,
                stateText: found.stateText,
                explanation: found.explanation,
                validThruText: found.validThruText
            }
        })
        const state = requirements.filter(row => row.required).reduce((worst, row) => worse(worst, row.state), "qualified")
        return {partyId, personName: personNames[partyId] || partyId, state, stateText: stateTexts[state], requirements}
    })
    return {results, asOfDate: at, asOfText: dateText(at)}
}

// ===== skills =====
// store#Skill: a person's level of a skill, as a self-declaration (the person themselves) or an evaluation (a development editor,
// PEOPLE_DEVELOP_EDIT, of an employer of theirs or as their manager; or a manager of a live line without it, recorded as the
// manager's evaluation, SksManagerEvaluated: the user's call of Nov 12, 2026), each kept as a PartySkillEvaluation; PartySkill takes
// an evaluation, and a self-declaration only where no evaluation (or level recorded before People) has set it. Refused: a person
// not in scope (RECORD_UNAVAILABLE); a caller who may not evaluate them (PERMISSION_DENIED); no skill, not one or ended
// (SKILL_REQUIRED, SKILL_INVALID, VALUE_ENDED); a level that is not a current skill level (LEVEL_INVALID); a date after now
// (DATE_INVALID); a qualification as evidence that is not the person's (QUALIFICATION_INVALID); a revision other than the one read
// (REVISION_CHANGED).
function storeSkill(p) {
    const userScope = people.scopeOf()
    const partyId = text(p.partyId) || userScope.partyId
    if (!partyId) denied("RECORD_UNAVAILABLE", "Choose the person")
    const found = requireAdmitted(accessTo(userScope, partyId), "Person " + partyId)
    // the caller's own skill is a self-declaration, whatever else admits them to their record
    const selfDeclared = found.own
    if (!selfDeclared && !found.evaluates)
        denied(
            "PERMISSION_DENIED",
            "Evaluating a skill needs PEOPLE_DEVELOP_EDIT and the person in your scope, or a report of yours"
        )
    const skillTypeEnumId = text(p.skillTypeEnumId)
    if (!skillTypeEnumId) denied("SKILL_REQUIRED", "Choose the skill")
    const skill = one(ENUM, {enumId: skillTypeEnumId})
    if (!skill || skill.enumTypeId !== "SkillType") denied("SKILL_INVALID", skillTypeEnumId + " is not a skill")
    if (!isCurrent(skill)) denied("VALUE_ENDED", (skill.description || skillTypeEnumId) + " has ended")
    const levels = levelNames()
    const level = Number(text(p.skillLevel))
    if (!Number.isInteger(level) || !levels[level]) denied("LEVEL_INVALID", "Choose one of the skill levels")
    const evaluatedAt = given(p.evaluationDate) && text(p.evaluationDate) ? effective(p.evaluationDate) : nowMs()
    if (evaluatedAt > nowMs() + 60 * 1000) denied("DATE_INVALID", "An evaluation is dated today or before")
    const evidenceId = text(p.partyQualificationId)
    if (evidenceId && one(QUALIFICATION, {partyQualificationId: evidenceId})?.partyId !== partyId)
        denied("QUALIFICATION_INVALID", "The evidence is a qualification of the same person")
    const current = one(SKILL, {partyId, skillTypeEnumId})
    if (given(p.expectedRevision) && text(p.expectedRevision) && text(p.expectedRevision) !== stampOf(current))
        denied("REVISION_CHANGED", "This skill changed since you read it; open it again (revision " + stampOf(current) + ")")
    const sourceEnumId = selfDeclared ? self : found.evaluationSource
    const partySkillEvaluationId = call("create#" + EVALUATION, {
        partyId,
        skillTypeEnumId,
        sourceEnumId,
        skillLevel: level,
        evaluationDate: new Date(evaluatedAt),
        assessorPartyId: userScope.partyId,
        evaluatedByUserId: ec.user.userId,
        evidence: text(p.evidence) || null,
        partyQualificationId: evidenceId || null
    }).partySkillEvaluationId
    // an evaluation sets the level; a self-declaration only over another self-declaration or none
    const accepted = !selfDeclared || !current || current.sourceEnumId === self
    if (accepted) {
        const values = {
            partyId,
            skillTypeEnumId,
            skillLevel: level,
            sourceEnumId,
            partySkillEvaluationId,
            evaluatedDate: new Date(evaluatedAt)
        }
        call((current ? "update#" : "create#") + SKILL, values)
    }
    return {partySkillEvaluationId, accepted, revision: stampOf(one(SKILL, {partyId, skillTypeEnumId}))}
}
// get#SkillsMatrix: people by skill, with the requirements of a job class (emplPositionClassId), else of each person's own job
// class, as the columns, each cell the person's level (self-declared labelled so) and whether it meets the requirement (met, gap,
// held, none), a qualification-proved requirement with its validity. The people: a development or HR reader's employers'
// current employees (organizationPartyId narrows them) and a manager's live reports, narrowed to a unit and those under it
// (unitPartyId, current memberships), a job class, a skill and a name (term); paged by person. Refused: a caller who reads no
// skills of anyone (PERMISSION_DENIED); an employer outside the scope (ORGANIZATION_DENIED).
function getSkillsMatrix(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const readsStaff = !!(caps.developView || caps.hrView)
    if (!readsStaff && !caps.team) denied("PERMISSION_DENIED", "The skills matrix is not available")
    const at = given(p.asOfDate) && text(p.asOfDate) ? people.asOfMillis(p.asOfDate) : nowMs()
    // a directory or payroll reader without development or HR reads only their own reports
    const population = populationOf(userScope, p, at, readsStaff)
    let partyIds = Array.from(population.keys())
    if (text(p.unitPartyId)) {
        // the people of the population who are members of the unit or a unit under it now (an intersection: nothing more)
        const unitId = text(p.unitPartyId)
        const units = [unitId].concat(people.unitsUnder([unitId]))
        const members = new Set(
            Array.from(
                people
                    .current(
                        find(RELATIONSHIP)
                            .condition("relationshipTypeEnumId", "PrtMember")
                            .condition("toPartyId", "in", units)
                            .selectField("fromPartyId"),
                        people.stamp(at)
                    )
                    .list()
            ).map(row => row.fromPartyId)
        )
        partyIds = partyIds.filter(partyId => members.has(partyId))
    }
    partyIds = peopleNamed(partyIds, p.term)
    const classes = classesOf(partyIds, at)
    const classId = text(p.emplPositionClassId)
    if (classId) partyIds = partyIds.filter(partyId => (classes[partyId] || []).includes(classId))
    const skillId = text(p.skillTypeEnumId)
    const levels = levelNames()
    const personNames = people.personNames(partyIds)
    partyIds.sort((a, b) => String(personNames[a] || a).localeCompare(String(personNames[b] || b)))
    const paged = lib.pageList(partyIds, p, "people", {})
    const pageIds = paged.people
    const requirementsByClass = classRequirements(
        unique(
            Object.values(classes)
                .flat()
                .concat(classId ? [classId] : [])
        ),
        at
    )
    // the columns: the class's requirements, else one skill, else the requirements of the page's people's classes and the skills
    // they hold
    let columns
    if (classId) columns = (requirementsByClass[classId] || []).map(row => Object.assign({}, row))
    else if (skillId) columns = [{skillTypeEnumId: skillId, minimumLevel: null, qualificationTypeEnumId: null, required: false}]
    else {
        const bySkill = new Map()
        for (const partyId of pageIds)
            for (const id of classes[partyId] || [])
                for (const row of requirementsByClass[id] || [])
                    if (!bySkill.has(row.skillTypeEnumId))
                        bySkill.set(row.skillTypeEnumId, {skillTypeEnumId: row.skillTypeEnumId})
        if (pageIds.length)
            for (const row of Array.from(find(SKILL).condition("partyId", "in", pageIds).selectField("skillTypeEnumId").list()))
                if (!bySkill.has(row.skillTypeEnumId)) bySkill.set(row.skillTypeEnumId, {skillTypeEnumId: row.skillTypeEnumId})
        columns = Array.from(bySkill.values())
    }
    const skillRows = new Map()
    const qualifications = pageIds.length ? Array.from(find(QUALIFICATION).condition("partyId", "in", pageIds).list()) : []
    if (pageIds.length && columns.length)
        for (const row of Array.from(
            find(SKILL)
                .condition("partyId", "in", pageIds)
                .condition(
                    "skillTypeEnumId",
                    "in",
                    columns.map(column => column.skillTypeEnumId)
                )
                .list()
        ))
            skillRows.set(row.partyId + "/" + row.skillTypeEnumId, row)
    const names = enumRows(
        columns
            .flatMap(row => [row.skillTypeEnumId, row.qualificationTypeEnumId])
            .concat(Array.from(skillRows.values()).map(row => row.sourceEnumId))
            .filter(Boolean)
    )
    columns = columns
        .map(column =>
            Object.assign(column, {
                skillName: nameOf(names, column.skillTypeEnumId),
                minimumLevelText: levelText(column.minimumLevel, levels),
                qualificationTypeName: nameOf(names, column.qualificationTypeEnumId)
            })
        )
        .sort((a, b) => a.skillName.localeCompare(b.skillName))
        .slice(0, columnCap)
    const titles = {}
    const employments = pageIds.length
        ? Array.from(people.current(people.employmentFind().condition("fromPartyId", "in", pageIds), people.stamp(at)).list())
        : []
    const titled = employments.length
        ? employees().titlesOf(
              employments.map(row => row.partyRelationshipId),
              people.stamp(at)
          )
        : {}
    const employerNames = people.organizationNames(unique(employments.map(row => row.toPartyId)))
    for (const row of employments)
        (titles[row.fromPartyId] || (titles[row.fromPartyId] = [])).push(
            [titled[row.partyRelationshipId]?.jobTitle, employerNames[row.toPartyId]].filter(Boolean).join(", ")
        )
    const rowsOut = pageIds.map(partyId => {
        const found = accessOf(userScope, partyId, population.get(partyId))
        const own = qualifications.filter(row => row.partyId === partyId)
        const personRequirements = new Map()
        for (const id of classId ? [classId] : classes[partyId] || [])
            for (const row of requirementsByClass[id] || [])
                if (!personRequirements.has(row.skillTypeEnumId)) personRequirements.set(row.skillTypeEnumId, row)
        let gapCount = 0
        const cells = columns.map(column => {
            const skillRow = skillRows.get(partyId + "/" + column.skillTypeEnumId)
            const level = levelOf(skillRow)
            const requirement = personRequirements.get(column.skillTypeEnumId)
            const cell = {
                skillTypeEnumId: column.skillTypeEnumId,
                level,
                levelText: levelText(level, levels),
                selfDeclared: skillRow?.sourceEnumId === self,
                sourceText: skillRow?.sourceEnumId ? nameOf(names, skillRow.sourceEnumId) : skillRow ? "Recorded" : "",
                revision: skillRow ? stampOf(skillRow) : "",
                minimumLevel: requirement?.minimumLevel ?? null,
                required: requirement ? requirement.required : null
            }
            if (requirement) {
                const assessed = assess(requirement, skillRow, own, at, levels)
                cell.state = assessed.state === "qualified" || assessed.state === "expiring" ? "met" : "gap"
                cell.qualificationState = requirement.qualificationTypeEnumId ? assessed.state : null
                cell.stateText =
                    cell.state === "met"
                        ? assessed.state === "expiring"
                            ? "Met · " + assessed.explanation
                            : "Met"
                        : "Gap · " + assessed.explanation
                if (cell.state === "gap" && requirement.required) gapCount++
            } else {
                cell.state = level != null ? "held" : "none"
                cell.stateText = level != null ? (cell.selfDeclared ? "Self-declared" : "Held") : ""
            }
            return cell
        })
        return {
            partyId,
            personName: personNames[partyId] || partyId,
            jobText: (titles[partyId] || []).join(" · "),
            gapCount,
            canEvaluate: found.evaluates,
            cells
        }
    })
    const out = {}
    for (const key of Object.keys(paged)) if (key.startsWith("people") && key !== "people") out[key] = paged[key]
    return Object.assign(out, {
        columns,
        rows: rowsOut,
        canEvaluate: !!caps.developEdit || rowsOut.some(row => row.canEvaluate),
        levelOptions: Object.entries(levels).map(([value, label]) => ({value: String(value), label: value + " " + label})),
        asOfText: dateText(at),
        // every person the filters keep (FindAvailable bounds Projects' staffing candidates to them)
        scopePartyIds: partyIds
    })
}

// ===== a person's development record (Employee360 SkillsAndReviews) =====
// get#PersonDevelopment: a person's skills (level, where it comes from, when), qualifications (as the caller's level of
// projection reads them, with their expiry) and resume lines (the person, HR and development), and what the caller may change.
// The person, a manager, development and HR read it; another staff reader reads the verified qualifications alone. checkOnly
// answers visible false, not a refusal, for a person not in scope.
function personDevelopment(p) {
    const userScope = people.scopeOf()
    const partyId = text(p.partyId) || userScope.partyId
    const found = partyId ? accessTo(userScope, partyId) : {admitted: false}
    if (!found.admitted || !found.level) {
        if (flag(p.checkOnly)) return {visible: false, skills: [], qualifications: [], resumeLines: []}
        denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    }
    const at = nowMs()
    const levels = levelNames()
    const skillRows = found.readsSkills ? rows(SKILL, {partyId}) : []
    const qualificationRows = rows(QUALIFICATION, {partyId})
    const resumeRows = found.self || found.hr || found.develop ? rows(RESUME, {partyId}) : []
    const names = enumRows(
        skillRows
            .flatMap(row => [row.skillTypeEnumId, row.sourceEnumId])
            .concat(qualificationRows.map(row => row.qualificationTypeEnumId))
            .concat(resumeRows.map(row => row.resumeLineTypeEnumId))
            .filter(Boolean)
    )
    const personNames = people.personNames([partyId])
    const skills = skillRows
        .map(row => ({
            skillTypeEnumId: row.skillTypeEnumId,
            skillName: nameOf(names, row.skillTypeEnumId),
            level: levelOf(row),
            levelText: levelText(levelOf(row), levels),
            selfDeclared: row.sourceEnumId === self,
            sourceText: row.sourceEnumId ? nameOf(names, row.sourceEnumId) : "Recorded",
            evaluatedDateText: dateText(row.evaluatedDate),
            revision: stampOf(row)
        }))
        .sort((a, b) => a.skillName.localeCompare(b.skillName))
    const qualifications = qualificationRows
        .map(row => qualificationRow(row, found, names, personNames, at))
        .filter(Boolean)
        .sort((a, b) => (a.thruDate ?? Infinity) - (b.thruDate ?? Infinity) || a.typeText.localeCompare(b.typeText))
    const resumeLines = resumeRows
        .map(row => ({
            partyResumeId: row.partyResumeId,
            resumeLineTypeEnumId: row.resumeLineTypeEnumId,
            typeText: nameOf(names, row.resumeLineTypeEnumId),
            organizationName: row.organizationName || "",
            title: row.title || "",
            fromDate: row.fromDate ? lib.calendarDateText(row.fromDate) : "",
            thruDate: row.thruDate ? lib.calendarDateText(row.thruDate) : "",
            periodText: [row.fromDate, row.thruDate].map(value => (value ? lib.calendarDateText(value) : "")).join(" – "),
            description: row.description || ""
        }))
        .sort((a, b) => String(b.fromDate).localeCompare(String(a.fromDate)))
    return {
        visible: true,
        partyId,
        skills,
        qualifications,
        resumeLines,
        showsSkills: found.readsSkills,
        showsResume: found.self || found.hr || found.develop,
        canDeclare: found.self,
        canEvaluate: found.evaluates,
        canSubmit: submits(found, false),
        canEditResume: found.self || found.hrEdit || (found.develop && found.developEdit)
    }
}
// store#ResumeLine: a resume line added, changed or removed (remove) by the person or an HR or development editor of an employer
// of theirs. Refused: a person or line not in scope (RECORD_UNAVAILABLE); another caller (PERMISSION_DENIED); a type that is not
// one (TYPE_INVALID); no organization or title (DESCRIPTION_REQUIRED); dates out of order (DATES_INVALID).
function storeResumeLine(p) {
    const userScope = people.scopeOf()
    const id = text(p.partyResumeId)
    const existing = id ? one(RESUME, {partyResumeId: id}) : null
    if (id && !existing) denied("RECORD_UNAVAILABLE", "Resume line " + id + " is not available")
    const partyId = existing ? existing.partyId : text(p.partyId) || userScope.partyId
    const found = partyId ? accessTo(userScope, partyId) : {admitted: false}
    if (!found.admitted || !(found.self || found.hr || found.develop))
        denied("RECORD_UNAVAILABLE", "Person " + partyId + " is not available")
    if (!(found.self || found.hrEdit || (found.develop && found.developEdit)))
        denied("PERMISSION_DENIED", "A resume is changed by the person or an HR or development editor")
    if (existing && flag(p.remove)) {
        call("delete#" + RESUME, {partyResumeId: id})
        return {partyResumeId: id}
    }
    const value = (name, fallback) => (given(p[name]) ? text(p[name]) || null : (fallback ?? null))
    const typeId = value("resumeLineTypeEnumId", existing?.resumeLineTypeEnumId) || "RltExperience"
    if (one(ENUM, {enumId: typeId})?.enumTypeId !== "ResumeLineType")
        denied("TYPE_INVALID", typeId + " is not a resume line type")
    const values = {
        partyId,
        resumeLineTypeEnumId: typeId,
        organizationName: value("organizationName", existing?.organizationName),
        title: value("title", existing?.title),
        fromDate: value("fromDate", existing?.fromDate),
        thruDate: value("thruDate", existing?.thruDate),
        description: value("description", existing?.description)
    }
    if (!values.organizationName && !values.title) denied("DESCRIPTION_REQUIRED", "Name the organization or the role")
    if (values.fromDate && values.thruDate && String(values.thruDate) < String(values.fromDate))
        denied("DATES_INVALID", "The end is after the start")
    if (existing) {
        call("update#" + RESUME, Object.assign({partyResumeId: id}, values))
        return {partyResumeId: id}
    }
    return {partyResumeId: call("create#" + RESUME, values).partyResumeId}
}

// ===== expiry reminders =====
// send#ExpiryReminders: each verified qualification expiring within the window and not renewed by a later verified one, whose
// person was not yet reminded of that expiry, reminded once (QualificationExpiring, to the person's own accounts: its type and
// expiry, never its reference) and marked (reminderThruDate); each in its own transaction, a failing one logged by its id and the
// rest going on.
function sendExpiryReminders() {
    const at = nowMs()
    const due = notRenewed(
        Array.from(
            find(QUALIFICATION)
                .condition("verificationStatusId", VERIFIED)
                .condition("thruDate", "greater", people.stamp(at))
                .condition("thruDate", "less-equals", people.stamp(at + expiringDays * day))
                .list()
        )
    ).filter(row => ms(row.reminderThruDate) !== ms(row.thruDate))
    const names = enumRows(due.map(row => row.qualificationTypeEnumId))
    let sentCount = 0
    let failedCount = 0
    for (const row of due) {
        try {
            ec.transaction.runRequireNew(
                null,
                "The expiry reminder of qualification " + row.partyQualificationId + " failed",
                () => {
                    const userIds = Array.from(find("moqui.security.UserAccount").condition("partyId", row.partyId).list())
                        .filter(account => account.disabled !== "Y")
                        .map(account => account.userId)
                    if (userIds.length)
                        ec.makeNotificationMessage()
                            .topic("QualificationExpiring")
                            .message({
                                partyQualificationId: row.partyQualificationId,
                                typeText: nameOf(names, row.qualificationTypeEnumId).toLowerCase(),
                                expiryText: "on " + ec.l10n.format(new Date(ms(row.thruDate)), "yyyy-MM-dd")
                            })
                            .userIds(userIds)
                            // the person's own document or permit: to them alone (People follow-up 1)
                            .directOnly()
                            .send()
                    call("update#" + QUALIFICATION, {
                        partyQualificationId: row.partyQualificationId,
                        reminderThruDate: row.thruDate
                    })
                    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
                }
            )
            sentCount++
        } catch (error) {
            failedCount++
            ec.message.clearErrors()
            ec.logger.error("The expiry reminder of qualification " + row.partyQualificationId + " failed: " + error.message)
        }
    }
    return {sentCount, failedCount}
}

const operations = {
    findQualifications,
    storeQualification,
    verifyQualification,
    qualificationAccess,
    contentAccess,
    checkQualifications,
    storeSkill,
    getSkillsMatrix,
    personDevelopment,
    storeResumeLine,
    sendExpiryReminders
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown development operation " + op)
    return operations[op](p || {})
}
;({execute: run, isRestricted})
