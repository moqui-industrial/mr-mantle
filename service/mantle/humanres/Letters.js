// People's letters (IronStone People design §15 "Employment/offer and lifecycle letters"; impl-people P17): one template for the
// offer letter (Offers.js, RecruitingServices) and the lifecycle letters of an applied employment change (PeopleServices
// issue#EmploymentLetter and get#EmploymentLetter: a hire's confirmation, a transfer, a manager change, a leave of absence, a return
// from leave, a separation), as html-print renders it and its PDF.
// - A letter not yet issued is a preview, marked as a draft, rendered from the record as it is now.
// - Issued, it is rendered once, stored (EmploymentLetter: its PDF, or its html-print page where this server has no PDF engine,
//   with who issued it and when) and read from storage after, never rendered again (design §15: an issued document keeps the
//   statement it made). One letter per offer or change: an issue retried answers the first.
// - Every value of the record is escaped; a letter names the person, the employer and the terms, never a private address, the HR
//   officer's working note or (for an offer) pay unless the letter is issued, when the stored letter holding pay terms is read only
//   with PAYROLL_VIEW (Offers.js).
// A lifecycle letter is HR's: an HR reader of the employer reads it (PEOPLE_HR_VIEW) and an HR editor issues it (PEOPLE_HR_EDIT);
// one holding pay terms is read with PAYROLL_VIEW too. P17 review (the user's call of Nov 12, 2026): the person it is addressed to
// reads their own issued lifecycle letters whole, pay included, in their self-service (find#MyLetters, get#MyLetter: the caller's
// own party alone, PEOPLE_SELF_SERVICE; another person's letter is refused as a missing one).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const employment = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Employment.js")
const {find, one, denied, call, ms} = lib

const LETTER = "mantle.humanres.employment.EmploymentLetter"
const CHANGE = "mantle.humanres.employment.EmploymentChange"

const text = value => String(value ?? "").trim()
const enc = value =>
    String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
const L = value => ec.l10n.localize(value)
// a date as a letter writes it, in the user's zone ("March 4, 2027"); empty for none
const longDate = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "MMMM d, yyyy"))

// ===== the template =====
// The letter's page: the employer and the date, the reference, the addressee, the title, the salutation, the paragraphs, the terms
// (label and value rows, the empty ones left out), the closing paragraphs and the signature; a preview says it is a draft.
// letter: {organizationName, dateText, reference, addresseeName, title, paragraphs, terms: [[label, value]], closing, signerName,
// draft}
function letterHtml(letter) {
    const paragraph = value => (text(value) ? '<p style="margin:0 0 8pt 0">' + enc(value) + "</p>" : "")
    const terms = Array.from(letter.terms || []).filter(([, value]) => text(value))
    return (
        (letter.draft ? '<p style="color:#a33;font-weight:bold;margin:0 0 8pt 0">' + enc(L("Draft: not issued")) + "</p>" : "") +
        '<div class="box-header">' +
        enc(letter.organizationName) +
        "</div>" +
        '<p style="color:#555;margin:0 0 12pt 0">' +
        enc([letter.dateText, letter.reference].filter(Boolean).join(" · ")) +
        "</p>" +
        paragraph(letter.addresseeName) +
        '<div class="group-title" style="margin:12pt 0 8pt 0">' +
        enc(letter.title) +
        "</div>" +
        paragraph(letter.addresseeName ? L("Dear") + " " + letter.addresseeName + "," : "") +
        Array.from(letter.paragraphs || [])
            .map(paragraph)
            .join("") +
        (terms.length
            ? '<table class="field" style="margin:4pt 0 12pt 0">' +
              terms
                  .map(
                      ([label, value]) =>
                          '<tr><td class="field-title" style="padding-right:12pt">' +
                          enc(L(label)) +
                          '</td><td class="field-value">' +
                          enc(value) +
                          "</td></tr>"
                  )
                  .join("") +
              "</table>"
            : "") +
        Array.from(letter.closing || [])
            .map(paragraph)
            .join("") +
        '<p style="margin:16pt 0 0 0">' +
        enc(L("Yours sincerely,")) +
        "</p>" +
        '<p style="margin:24pt 0 0 0">' +
        enc(letter.signerName || "") +
        "<br/>" +
        enc(letter.organizationName) +
        "</p>"
    )
}
const documentOf = letter =>
    '<html><head><meta charset="utf-8"/><title>' +
    enc(letter.title + (letter.reference ? " " + letter.reference : "")) +
    "</title></head><body>" +
    letterHtml(letter) +
    "</body></html>"

// ===== storage =====
// The letter issued: rendered once now and stored with its row (values: the record it is of, the person, employer, title, file
// name without its extension, whether it holds pay). The PDF when this server has one, else the html-print page (logged). Answers
// the row.
function store(values, letter) {
    const now = ec.user.nowTimestamp
    const employmentLetterId = call("create#" + LETTER, {
        employmentOfferId: values.employmentOfferId || null,
        employmentChangeId: values.employmentChangeId || null,
        changeKindEnumId: values.changeKindEnumId || null,
        partyId: values.partyId || null,
        organizationPartyId: values.organizationPartyId || null,
        partyRelationshipId: values.partyRelationshipId || null,
        title: letter.title,
        includesPay: values.includesPay ? "Y" : "N",
        issuedDate: now,
        issuedByUserId: ec.user.userId || null
    }).employmentLetterId
    const document = documentOf(Object.assign({}, letter, {draft: false}))
    const root = ec.user.getPreference("mantle.content.large.root") || "dbresource://mantle/content"
    const folder = root + "/peopleLetter/" + employmentLetterId + "/"
    const baseName = String(values.fileName || "Letter-" + employmentLetterId).replace(/[^A-Za-z0-9._-]/g, "_")
    let fileName = baseName + ".pdf"
    let contentType = "application/pdf"
    try {
        const pdf = ec.resource.xslFoTransform(document, null, null, "application/pdf")
        ec.resource.getLocationReference(folder + fileName).putBytes(pdf)
    } catch (error) {
        ec.logger.warn("Letter " + employmentLetterId + ": no PDF engine, its html-print page is stored: " + error.message)
        fileName = baseName + ".html"
        contentType = "text/html"
        ec.resource.getLocationReference(folder + fileName).putText(document)
    }
    call("update#" + LETTER, {employmentLetterId, contentLocation: folder + fileName, contentType, fileName})
    return one(LETTER, {employmentLetterId})
}
// A stored letter as its readers get it: its location and name to send, its type, when and by whom it was issued.
function fileOf(row) {
    const issuer = row.issuedByUserId ? one("moqui.security.UserAccount", {userId: row.issuedByUserId}) : null
    return {
        employmentLetterId: row.employmentLetterId,
        title: row.title || "",
        location: row.contentLocation,
        fileName: row.fileName,
        contentType: row.contentType,
        inline: true,
        includesPay: row.includesPay === "Y",
        issuedDateText: lib.dateText(row.issuedDate),
        issuedByName: issuer?.partyId ? people.personNames([issuer.partyId])[issuer.partyId] || "" : ""
    }
}
const letterOf = conditions => Array.from(find(LETTER).condition(conditions).orderBy("issuedDate").limit(1).list())[0] || null
// The signer of a letter: the person of the user issuing it (or previewing it).
const signerName = () => {
    const partyId = ec.user.userAccount?.partyId
    return partyId ? people.personNames([partyId])[partyId] || "" : ""
}

// ===== the lifecycle letters of an employment change =====
// The kinds of applied change that have a letter, each its title and what it says (t: the change's texts). A working schedule
// and a reorganization (a report's manager change made by another's separation) have none.
const changeLetters = {
    EckHire: {
        title: "Confirmation of employment",
        body: t => ["This letter confirms your employment with " + t.organizationName + " from " + t.dateText + "."],
        terms: t => [
            ["Starts", t.dateText],
            ["Department", t.departmentName],
            ["Position", t.positionName],
            ["Reports to", t.managerName],
            ["Work location", t.facilityName],
            ["Working schedule", t.scheduleName]
        ]
    },
    EckTransfer: {
        title: "Transfer",
        body: t => ["From " + t.dateText + " your role at " + t.organizationName + " is as set out below."],
        terms: t => [
            ["From", t.dateText],
            ["Department", t.departmentName],
            ["Position", t.positionName],
            ["Reports to", t.managerName],
            ["Work location", t.facilityName],
            ["Working schedule", t.scheduleName]
        ]
    },
    EckManager: {
        title: "Change of manager",
        body: t => [
            "From " + t.dateText + " you report to " + (t.managerName || "no manager") + " at " + t.organizationName + "."
        ],
        terms: t => [
            ["From", t.dateText],
            ["Reports to", t.managerName]
        ]
    },
    EckLeave: {
        title: "Leave of absence",
        body: t => [
            "Your leave of absence from " +
                t.organizationName +
                " starts on " +
                t.dateText +
                (t.returnDateText ? " and ends on " + t.returnDateText : "") +
                ". Your employment continues during it."
        ],
        terms: t => [
            ["Starts", t.dateText],
            ["Ends", t.returnDateText]
        ]
    },
    EckReturn: {
        title: "Return from leave",
        body: t => ["We confirm your return to work at " + t.organizationName + " on " + t.dateText + "."],
        terms: t => [["Returns", t.dateText]]
    },
    EckSeparation: {
        title: "End of employment",
        body: t => ["This letter confirms that your employment with " + t.organizationName + " ends on " + t.dateText + "."],
        terms: t => [
            ["Last day of employment", t.dateText],
            ["Kind of separation", t.terminationType],
            ["Reason", t.terminationReason]
        ]
    }
}
const letterKinds = Object.keys(changeLetters)
// The change's letter as the template takes it: its kind's title, paragraphs and terms from the change row (the terms it started),
// the person, the employer and the signer. Never the change's reason (HR's working note).
function changeLetter(change, draft) {
    const kind = changeLetters[change.changeKindEnumId]
    const names = employment().termTexts(change)
    const organizationName = people.organizationNames([change.organizationPartyId])[change.organizationPartyId] || ""
    const reasons = Object.fromEntries(
        [change.terminationReasonEnumId, change.terminationTypeEnumId]
            .filter(Boolean)
            .map(enumId => [enumId, one("moqui.basic.Enumeration", {enumId})?.description || ""])
    )
    const t = Object.assign({}, names, {
        organizationName,
        dateText: longDate(change.effectiveDate),
        returnDateText: longDate(change.returnDate),
        terminationReason: reasons[change.terminationReasonEnumId] || "",
        terminationType: reasons[change.terminationTypeEnumId] || ""
    })
    return {
        organizationName,
        dateText: longDate(ec.user.nowTimestamp),
        reference: L("Reference") + " " + change.employmentChangeId,
        addresseeName: people.personNames([change.partyId])[change.partyId] || "",
        title: L(kind.title),
        paragraphs: kind.body(t),
        terms: kind.terms(t),
        closing: [],
        signerName: signerName(),
        draft
    }
}
// The change of an HR reader's employer (PEOPLE_HR_VIEW; an issue PEOPLE_HR_EDIT too): missing, or another employer's, is refused
// alike (RECORD_UNAVAILABLE).
function hrChange(p, edit) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || (edit && !caps.hrEdit))
        denied(
            "PERMISSION_DENIED",
            edit ? "Issuing a letter needs PEOPLE_HR_VIEW and PEOPLE_HR_EDIT" : "A letter needs PEOPLE_HR_VIEW"
        )
    const id = text(p.employmentChangeId)
    const change = id ? one(CHANGE, {employmentChangeId: id}) : null
    if (!change || !userScope.organizationPartyIds.includes(change.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Employment change " + id + " is not available")
    return {change, caps}
}
// Why a change has no letter, or null: a kind without one (LETTER_NOT_OFFERED), a change not applied or withdrawn
// (CHANGE_NOT_APPLIED).
function letterProblem(change) {
    if (!changeLetters[change.changeKindEnumId]) return ["LETTER_NOT_OFFERED", "This kind of change has no letter"]
    if (change.statusId !== "EchApplied" || change.withdrawnDate)
        return ["CHANGE_NOT_APPLIED", "A letter is issued for a change once it is applied"]
    return null
}
// get#EmploymentLetter: an HR reader's letter of a change: the stored one once issued (its file), else the preview (letterHtml,
// marked as a draft) and whether the caller may issue it.
function getEmploymentLetter(p) {
    const {change, caps} = hrChange(p, false)
    const problem = letterProblem(change)
    const issued = letterOf({employmentChangeId: change.employmentChangeId})
    if (issued?.includesPay === "Y" && !caps.payrollView)
        denied("PERMISSION_DENIED", "This letter holds pay terms: it is read with PAYROLL_VIEW")
    return {
        employmentChangeId: change.employmentChangeId,
        partyId: change.partyId,
        partyRelationshipId: change.partyRelationshipId,
        issued: !!issued,
        letter: issued ? fileOf(issued) : null,
        offered: !problem,
        problem: problem ? problem[1] : "",
        title: changeLetters[change.changeKindEnumId]?.title || "",
        letterHtml: problem || issued ? "" : letterHtml(changeLetter(change, true)),
        canIssue: !problem && !issued && !!caps.hrEdit
    }
}
// issue#EmploymentLetter: an HR editor issues the letter of an applied change, rendered and stored once (the change's row locked,
// so two issues make one letter); a letter already issued answers it (repeated).
function issueEmploymentLetter(p) {
    const found = hrChange(p, true).change
    const change = find(CHANGE, {employmentChangeId: found.employmentChangeId}).forUpdate(true).one()
    const issued = letterOf({employmentChangeId: change.employmentChangeId})
    if (issued) return Object.assign(fileOf(issued), {repeated: true})
    const problem = letterProblem(change)
    if (problem) denied(problem[0], problem[1])
    const kindText = String(changeLetters[change.changeKindEnumId].title).replace(/\s+/g, "-")
    const row = store(
        {
            employmentChangeId: change.employmentChangeId,
            changeKindEnumId: change.changeKindEnumId,
            partyId: change.partyId,
            organizationPartyId: change.organizationPartyId,
            partyRelationshipId: change.partyRelationshipId,
            fileName: kindText + "-" + change.employmentChangeId
        },
        changeLetter(change, false)
    )
    return Object.assign(fileOf(row), {repeated: false})
}
// Whether an applied change of these has its letter issued: {employmentChangeId: true}.
function issuedFor(employmentChangeIds) {
    const ids = people.unique(employmentChangeIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(LETTER).condition("employmentChangeId", "in", ids).selectField("employmentChangeId").list()).map(row => [
            row.employmentChangeId,
            true
        ])
    )
}

// ===== the person's own letters (self-service) =====
// The caller's own party with PEOPLE_SELF_SERVICE (PERMISSION_DENIED otherwise).
function ownParty() {
    const partyId = ec.user.userAccount?.partyId
    if (!partyId || !ec.user.hasPermission("PEOPLE_SELF_SERVICE"))
        denied("PERMISSION_DENIED", "Your letters need PEOPLE_SELF_SERVICE and a person")
    return partyId
}
// find#MyLetters: the issued lifecycle letters addressed to the caller (no party is taken), newest first: the title, the
// employer, when it was issued, its file's name and type.
function findMyLetters() {
    const partyId = ownParty()
    const found = Array.from(
        find(LETTER)
            .condition("partyId", partyId)
            .condition("employmentChangeId", "is-not-null", null)
            .orderBy("-issuedDate")
            .limit(200)
            .list()
    )
    const organizations = people.organizationNames(people.unique(found.map(row => row.organizationPartyId).filter(Boolean)))
    return {
        letters: found.map(row => ({
            employmentLetterId: row.employmentLetterId,
            title: row.title || "",
            organizationPartyId: row.organizationPartyId || null,
            organizationName: organizations[row.organizationPartyId] || "",
            issuedDateText: lib.dateText(row.issuedDate),
            fileName: row.fileName || "",
            contentType: row.contentType || ""
        }))
    }
}
// get#MyLetter: one of the caller's own issued lifecycle letters as it was stored (its location, name and type); another
// person's, an offer's or a missing one is refused alike (RECORD_UNAVAILABLE).
function getMyLetter(p) {
    const partyId = ownParty()
    const id = text(p.employmentLetterId)
    const row = id ? one(LETTER, {employmentLetterId: id}) : null
    if (!row || row.partyId !== partyId || !row.employmentChangeId || !row.contentLocation)
        denied("RECORD_UNAVAILABLE", "Letter " + id + " is not available")
    return {letter: fileOf(row)}
}

const operations = {getEmploymentLetter, issueEmploymentLetter, findMyLetters, getMyLetter}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown letter operation " + op)
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return operations[op](p || {})
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute: run,
    // for Offers.js: the template, storage and a stored letter's file
    letterHtml,
    longDate,
    store,
    fileOf,
    letterOf,
    signerName,
    // for Employment.js's find#EmploymentChanges: the kinds with a letter and the changes whose letter is issued
    letterKinds,
    issuedFor
})
