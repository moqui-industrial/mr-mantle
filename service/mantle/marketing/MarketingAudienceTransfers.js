// Marketing's audience import and membership export (mantle.marketing.AudienceServices preview#, apply#, get#AudienceImport,
// find#AudienceImportRuns, get#AudienceImportErrors, purge#AudienceImports, find#MemberExportScopes, export#MemberTransfer; IronStone
// Marketing design §4 AudienceImport, §14.1, §18; impl-marketing P4): a file of contacts staged for a Marketing list, its columns
// mapped, its consent evidence classified, previewed row by row, then each row applied once through request#Subscriptions' own
// filing, so the import never writes a membership itself; and a list's members as rows of the framework's export.
//
// - Who: preview and apply need MARKETING_AUDIENCE_IMPORT beside MARKETING_AUDIENCE_EDIT and the list's organization (the target's
//   own permission, impl-marketing §4; no ADMIN_* permission); accepting with the evidence MARKETING_CONSENT_EDIT too, as
//   request#Subscriptions. Reading an import, its runs and its error rows needs MARKETING_AUDIENCE_VIEW and the organization; another
//   organization's import answers as missing (RECORD_UNAVAILABLE).
// - The file: read by Commons' contact import (ContactImportServices parse#ContactFile and read#ContactRows, the parser its
//   preview#Contacts and import#Contacts use), no second parser. It is staged by reference and hash (a dbresource file under
//   mantle/marketing/audienceImport, its sha256), never shown or put in shell context, and purged after the import's expiry (30 days),
//   the outcomes kept. The same file staged again for the same list by the same user before it is applied answers the same import.
// - Matching: by the list channel's address alone (as Commons' match#Contact matches an address, a phone with the row's name too,
//   but never by a name alone and never stopping at a personal contact; matchOf), among the parties the user may see: another user's personal contact is never matched, and a personal contact of the importer is not used
//   either (a list's member is the organization's); a row that matches no one makes a directory contact (import#ContactRow, which
//   makes no personal contact here). No party is merged.
// - Evidence: a list supplies none. A row's evidence is its evidence column's text, else the import's text; its date its date
//   column's, else the import's (never in the future, and never now by default: the import names its date or a date column). A row
//   without evidence or its date is invalid.
// - Each row once: its item is locked, applied in a transaction of its own (the contact made or matched and the request filed
//   together) and its outcome recorded, so a restart applies only the rows not yet applied and a retry only the failed ones. The
//   request is decided when applied: a withdrawal after the preview is refused WITHDRAWN, a suppression stays. A row that fails is
//   logged by name and the rest go on.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const suppressions = ec.resource.script("component://mr-mantle/service/mantle/party/MessageSuppressions.js")
const audiences = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAudiences.js")
const {find, one, rows, denied, call} = lib
const audience = audiences.audience

const IMPORT = "mantle.marketing.contact.AudienceImport"
const ITEM = "mantle.marketing.contact.AudienceImportItem"
const CLP = "mantle.marketing.contact.ContactListParty"
const REQUEST = "mantle.marketing.contact.SubscriptionRequest"
const CI = "mantle.party.ContactImportServices."
const maxBytes = 1048576
const maxRows = 1000
const retentionDays = 30
const dayMs = 24 * 60 * 60 * 1000
// the contact fields a Marketing import reads; every other column is left out
const contactFields = /^(firstName|lastName|middleName|fullName|organizationName|email\d+|phone\d+)(:[A-Za-z]+)?$/
const columnFields = {
    emailColumn: "email1",
    phoneColumn: "phone1",
    firstNameColumn: "firstName",
    lastNameColumn: "lastName",
    nameColumn: "fullName",
    organizationColumn: "organizationName"
}
const states = {
    AisStaged: ["staged", "Previewed"],
    AisApplying: ["applying", "Applying"],
    AisComplete: ["complete", "Complete"],
    AisPartial: ["partial", "Complete with failures"],
    AisExpired: ["failed", "Expired"]
}
const outcomeTexts = {
    staged: "Not applied",
    pending: "Pending confirmation",
    accepted: "Accepted",
    existing: "Already on the list",
    refused: "Refused",
    invalid: "Invalid row",
    skipped: "Skipped",
    failed: "Failed"
}
const outcomeColors = {
    pending: "warning",
    accepted: "positive",
    existing: "grey-7",
    refused: "negative",
    invalid: "negative",
    failed: "negative",
    skipped: "grey-7",
    staged: "grey-7"
}
const errorOutcomes = ["refused", "invalid", "failed"]
const reasonTexts = {
    INVALID_ADDRESS: "The address is not valid",
    MISSING_ADDRESS: "No address of the list's channel",
    EVIDENCE_REQUIRED: "No evidence for the row",
    EVIDENCE_DATE_INVALID: "The evidence date is not a date in the past",
    EVIDENCE_DATE_REQUIRED: "No evidence date for the row",
    DUPLICATE_IN_FILE: "The address is on an earlier row",
    EMPTY_ROW: "Nothing to import",
    SUPPRESSED: "The address is suppressed and stays so",
    ALREADY_MEMBER: "Already on the list",
    WITHDRAWN: "Withdrawn after the evidence: not regranted",
    CONSENT_WITHDRAWN: "The person withdrew the purpose: only their own confirmation renews it",
    MISSING_DESTINATION: "No address of the list's channel",
    RECORD_UNAVAILABLE: "The contact is not available",
    ALREADY_PENDING: "Already pending confirmation",
    FAILED: "Failed: retry it"
}

const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
const nowMs = () => lib.ms(ec.user.nowTimestamp)
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const yes = value => value === true || value === "true" || value === "Y"
const userName = userId =>
    userId
        ? one("moqui.security.UserAccount", {userId})?.userFullName ||
          one("moqui.security.UserAccount", {userId})?.username ||
          userId
        : ""

// ===== scope =====
function importScope(accept) {
    const userScope = audience.audienceScope("audienceEdit")
    marketingAccess.requireCapability(userScope, "audienceImport")
    if (accept) marketingAccess.requireCapability(userScope, "consentEdit")
    return userScope
}
// An import of the scope (its list's organization), else RECORD_UNAVAILABLE.
function importOfScope(userScope, audienceImportId, lock = false) {
    const id = text(audienceImportId)
    let query = id ? find(IMPORT, {audienceImportId: id}) : null
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Import " + id + " is not available")
    return row
}
const expired = row => row.purgedDate != null || (row.expireDate != null && lib.ms(row.expireDate) <= nowMs())
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of the import you read")
    if (lib.ms(expectedRevision) !== lib.ms(row.lastUpdatedStamp))
        denied("STALE_REVISION", "The import changed since it was read; its revision is now " + lib.ms(row.lastUpdatedStamp))
}

// ===== the file =====
function uploadText(p) {
    if (p.importFile != null) {
        const out = ec.service
            .sync()
            .name(CI + "read#ContactFileText")
            .parameters({contactFile: p.importFile, characterSet: text(p.characterSet) || "UTF-8"})
            .disableAuthz()
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        let name = ""
        try {
            name = text(p.importFile.getName())
        } catch (error) {
            name = ""
        }
        return {fileText: out?.text == null ? "" : String(out.text), fileName: text(p.fileName) || name}
    }
    return {fileText: p.fileText == null ? "" : String(p.fileText), fileName: text(p.fileName)}
}
const safeName = name => (text(name) || "audience-import.csv").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80)
function stagedText(row) {
    if (!row.fileLocation) denied("IMPORT_EXPIRED", "The import's file was removed after its expiry; import the file again")
    const out = ec.resource.getLocationReference(row.fileLocation).getText()
    if (out == null) denied("IMPORT_EXPIRED", "The import's file is no longer there; import the file again")
    return String(out)
}
// The columns of the file with the contact field each maps to (Commons' presets), and the mapping a Marketing import uses: the
// columns the request names for a field, else those stored, else the presets' restricted to the fields read here; evidence columns
// and every other column left out.
function mappingOf(p, fileText, fileName, stored) {
    const parsed = call(CI + "parse#ContactFile", {fileText, fileName, sampleSize: 3})
    const columns = Array.from(parsed.columnList || []).map(column => ({
        columnName: text(column.columnName),
        targetField: text(column.targetField)
    }))
    const names = columns.map(column => column.columnName)
    const evidenceColumn = text(p.evidenceColumn ?? stored.evidenceColumn)
    const evidenceDateColumn = text(p.evidenceDateColumn ?? stored.evidenceDateColumn)
    for (const column of [evidenceColumn, evidenceDateColumn])
        if (column && !names.includes(column)) denied("COLUMN_UNKNOWN", "The file has no column " + column)
    const named = Object.keys(columnFields).some(key => !blank(p[key]))
    const chosen = {}
    if (named) {
        for (const [key, field] of Object.entries(columnFields)) {
            const column = text(p[key])
            if (!column) continue
            if (!names.includes(column)) denied("COLUMN_UNKNOWN", "The file has no column " + column)
            chosen[column] = field
        }
    } else if (stored.columnMapping && Object.keys(stored.columnMapping).length) {
        Object.assign(chosen, stored.columnMapping)
    } else {
        for (const column of columns) if (contactFields.test(column.targetField)) chosen[column.columnName] = column.targetField
    }
    const columnMapping = {}
    for (const name of names)
        columnMapping[name] =
            name === evidenceColumn || name === evidenceDateColumn || !contactFields.test(text(chosen[name]))
                ? "ignore"
                : chosen[name]
    // the columns chosen per field, for the screen's mapping step
    const fieldColumns = {}
    for (const [key, field] of Object.entries(columnFields))
        fieldColumns[key] = names.find(name => columnMapping[name] === field) || ""
    return {
        columns: names,
        columnMapping,
        fieldColumns,
        evidenceColumn,
        evidenceDateColumn,
        fileKind: parsed.fileKind || "csv"
    }
}
function readRows(fileText, fileName, columnMapping) {
    const read = call(CI + "read#ContactRows", {fileText, fileName, columnMapping})
    return {rowCount: Number(read.rowCount || 0), rows: Array.from(read.contactList || [])}
}

// ===== a row =====
const normalizePhone = value =>
    String(value || "")
        .replace(/\D/g, "")
        .slice(-10)
function phoneText(phone) {
    return [phone.countryCode ? "+" + phone.countryCode : null, phone.areaCode, phone.contactNumber].filter(Boolean).join(" ")
}
// The row's address of the list's channel: {address, key, problem}.
function addressOf(row, channel) {
    const contact = row.contact || {}
    if (channel === "CmtTelecomNumber") {
        const phone = Array.from(contact.phones || [])[0]
        if (!phone) return {problem: "MISSING_ADDRESS"}
        const address = phoneText(phone)
        const key = normalizePhone(address)
        return key.length < 7 ? {problem: "INVALID_ADDRESS", address} : {address, key, phone}
    }
    const email = Array.from(contact.emails || [])[0]
    if (!email || !text(email.emailAddress)) return {problem: "MISSING_ADDRESS"}
    const address = text(email.emailAddress)
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return {problem: "INVALID_ADDRESS", address}
    return {address, key: address.toLowerCase()}
}
// The row's evidence: its column's, else the import's; {evidenceText, evidenceDate, problem}.
function evidenceOf(row, terms) {
    const values = row.values || {}
    const evidenceText = (terms.evidenceColumn && text(values[terms.evidenceColumn])) || terms.evidenceText
    if (!evidenceText) return {problem: "EVIDENCE_REQUIRED"}
    let evidenceDate = terms.evidenceDate || null
    const dateValue = terms.evidenceDateColumn ? text(values[terms.evidenceDateColumn]) : ""
    if (dateValue) {
        try {
            evidenceDate = audience.evidenceDateOf(dateValue)
        } catch (error) {
            return {problem: "EVIDENCE_DATE_INVALID"}
        }
    }
    // never dated now by default: a date of today would be later than every earlier withdrawal (Marketing P4 review)
    if (evidenceDate == null) return {problem: "EVIDENCE_DATE_REQUIRED"}
    return {evidenceText, evidenceDate}
}
// The contact a row makes or is matched by: its names and the list channel's address only.
function channelContact(row, channel, found) {
    const contact = row.contact || {}
    const out = {
        partyTypeEnumId: contact.partyTypeEnumId || "PtyPerson",
        firstName: contact.firstName || null,
        middleName: contact.middleName || null,
        lastName: contact.lastName || null,
        organizationName: contact.organizationName || null
    }
    if (channel === "CmtTelecomNumber") out.phones = [Object.assign({}, found.phone, {contactMechPurposeId: "PhoneMobile"})]
    else out.emails = [{emailAddress: found.address, contactMechPurposeId: "EmailPrimary"}]
    return out
}
// The party the address matches among those the user may see, when it may be a member: a current address of the list's channel
// (an email ignoring case; a phone by its last digits, at least seven, and the row's name when it has one, as Commons' match#Contact:
// a shared office number is not a match), the first by party of those not a personal contact (the importer's own included), merged
// or disabled. Commons' match#Contact is not called for it: it stops at the first visible party, so the importer's own personal
// contact would hide a directory contact of the same address (a duplicate made), and it falls back to a name alone, which would
// file the evidence of one number on another (Marketing P4 review).
function matchOf(row, channel, found, organizationPartyId) {
    const cf = ec.entity.conditionFactory
    const now = ec.user.nowTimestamp
    // a party of the list's organization's audience only (SEC-BAP-88): another organization's is no match, and is not named
    const member = partyId => {
        const party = audience.requestableParty(partyId, organizationPartyId)
        return party && !party.privateOwnerUserId ? party : null
    }
    if (channel !== "CmtTelecomNumber") {
        const infos = ec.entity
            .find("mantle.party.contact.PartyContactMechInfo")
            .condition("contactMechTypeEnumId", "CmtEmailAddress")
            .condition(cf.makeCondition("infoString", "equals", found.address, false, true))
            .conditionDate("fromDate", "thruDate", now)
            .orderBy("partyId")
            .limit(50)
            .list()
        for (const info of Array.from(infos)) if (member(info.partyId)) return {partyId: info.partyId, reason: "email"}
        return null
    }
    const contact = row.contact || {}
    const same = (a, b) => !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
    const hasName = contact.firstName || contact.lastName || contact.organizationName
    const digits = found.key
    const numbers = ec.entity
        .find("mantle.party.contact.PartyContactMechTelecomNumber")
        .condition(cf.makeCondition("contactNumber", "like", "%" + digits.slice(-4)))
        .conditionDate("fromDate", "thruDate", now)
        .orderBy("partyId")
        .limit(200)
        .list()
    for (const number of Array.from(numbers)) {
        const have = normalizePhone(String(number.areaCode || "") + String(number.contactNumber || ""))
        const length = Math.min(have.length, digits.length)
        if (length < 7 || have.slice(-length) !== digits.slice(-length)) continue
        if (!member(number.partyId)) continue
        const detail = one("mantle.party.PartyDetail", {partyId: number.partyId}) || {}
        if (
            !hasName ||
            same(detail.firstName, contact.firstName) ||
            same(detail.lastName, contact.lastName) ||
            same(detail.organizationName, contact.organizationName)
        )
            return {partyId: number.partyId, reason: "phone"}
    }
    return null
}
// What the preview can say of a matched party's membership and consent (the apply decides).
function membershipNote(list, policy, partyId, evidenceDate) {
    const latest = Array.from(
        find(CLP, {contactListId: list.contactListId, partyId})
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .orderBy("-fromDate")
            .list()
    )[0]
    if (latest && ["CLPT_ACCEPTED", "CLPT_IN_USE", "CLPT_PENDING"].includes(latest.statusId)) return "ALREADY_MEMBER"
    const purposeEnumId = audience.purposeOf(list, policy)
    const evidenceMs = lib.ms(evidenceDate)
    const withdrawn = rows("mantle.party.PartyConsent", {partyId}).some(
        row =>
            row.statusId === "PconWithdrawn" &&
            lib.ms(row.consentDate) >= evidenceMs &&
            (row.contactListId === list.contactListId ||
                (!row.contactListId &&
                    row.purposeEnumId === purposeEnumId &&
                    (!row.organizationPartyId || row.organizationPartyId === list.ownerPartyId)))
    )
    if (withdrawn || (latest && ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"].includes(latest.statusId))) return "WITHDRAWN"
    return null
}
const channelOf = list => list.contactMechTypeEnumId || "CmtEmailAddress"
const deliveryChannel = channel => (channel === "CmtTelecomNumber" ? "MdcSms" : "MdcEmail")
function nameOf(row) {
    const contact = row.contact || {}
    return contact.partyTypeEnumId === "PtyOrganization"
        ? text(contact.organizationName)
        : [contact.firstName, contact.lastName].filter(Boolean).join(" ")
}
// The terms an import's rows are read with: its evidence and columns.
function termsOf(row) {
    return {
        sourceEnumId: row.sourceEnumId || "PcsImport",
        evidenceText: text(row.evidenceText),
        evidenceDate: row.evidenceDate,
        evidenceColumn: text(row.evidenceColumn),
        evidenceDateColumn: text(row.evidenceDateColumn),
        accept: row.acceptEvidence === "Y"
    }
}

// ===== preview#AudienceImport =====
function previewAudienceImport(p) {
    const accept = yes(p.accept)
    const userScope = importScope(accept)
    let row = null
    let list
    let fileText
    let fileName
    if (text(p.audienceImportId)) {
        row = importOfScope(userScope, p.audienceImportId, true)
        if (row.stateEnumId !== "AisStaged") denied("IMPORT_APPLIED", "The import was applied; its results are final")
        if (expired(row)) denied("IMPORT_EXPIRED", "The import expired; import the file again")
        requireRevision(row, p.expectedRevision)
        list = audience.listOfScope(userScope, row.contactListId)
        fileText = stagedText(row)
        fileName = row.fileName
    } else {
        list = audience.listOfScope(userScope, p.contactListId)
        const upload = uploadText(p)
        fileText = upload.fileText
        fileName = upload.fileName
        if (!text(fileText)) denied("FILE_REQUIRED", "Choose a file of contacts")
    }
    audience.requireOpen(list)
    if (fileText.length > maxBytes) denied("FILE_TOO_LARGE", "A file of at most 1 MiB")
    // the evidence (a list supplies none)
    const sourceEnumId = audience.sourceOf(p.sourceEnumId, "PcsImport")
    // the evidence's original date, the import's or each row's column: never today by default, which would be later than every
    // withdrawal the people made before (the file's evidence is of the past)
    const evidenceDate = blank(p.evidenceDate) ? null : audience.evidenceDateOf(p.evidenceDate)
    const evidenceText = text(p.evidenceText)
    const stored = row ? lib.json(row.mappingJson, {}) : {}
    const mapping = mappingOf(p, fileText, fileName, stored)
    if (!evidenceText && !mapping.evidenceColumn)
        denied(
            "EVIDENCE_REQUIRED",
            "Give the evidence of the requests, or the column that gives each row's: choosing a list is not evidence"
        )
    if (!evidenceDate && !mapping.evidenceDateColumn)
        denied(
            "EVIDENCE_DATE_REQUIRED",
            "Give the date the people gave the evidence, or the column that gives each row's: an import is never dated today by default"
        )
    const read = readRows(fileText, fileName, mapping.columnMapping)
    if (read.rowCount > maxRows) denied("TOO_MANY_ROWS", "A file of at most " + maxRows + " rows")
    const fileHash = String(ec.resource.digestText(fileText, "sha256"))
    // the import: the one named, the same file staged before by this user for this list, or a new one
    if (!row) {
        const importKey = String(lib.hash([ec.user.userId, list.contactListId, fileHash]))
        row =
            Array.from(find(IMPORT, {importKey, stateEnumId: "AisStaged"}).orderBy("-stagedDate").forUpdate(true).list()).find(
                found => !expired(found)
            ) || null
        if (!row) {
            const created = call("create#" + IMPORT, {
                contactListId: list.contactListId,
                organizationPartyId: list.ownerPartyId,
                importKey,
                fileName: fileName || null,
                fileHash,
                stateEnumId: "AisStaged",
                stagedDate: ec.user.nowTimestamp,
                stagedByUserId: ec.user.userId || null,
                expireDate: new Date(nowMs() + retentionDays * dayMs)
            })
            const location = "dbresource://mantle/marketing/audienceImport/" + created.audienceImportId + "/" + safeName(fileName)
            ec.resource.getLocationReference(location).putText(fileText, "Audience import " + created.audienceImportId)
            call("update#" + IMPORT, {audienceImportId: created.audienceImportId, fileLocation: location})
            row = one(IMPORT, {audienceImportId: created.audienceImportId})
        }
    }
    const terms = {
        sourceEnumId,
        evidenceText,
        evidenceDate,
        evidenceColumn: mapping.evidenceColumn,
        evidenceDateColumn: mapping.evidenceDateColumn,
        accept
    }
    // the rows' preview, replacing an earlier one (nothing is applied while the import is staged)
    for (const item of rows(ITEM, {audienceImportId: row.audienceImportId}))
        call("delete#" + ITEM, {audienceImportId: item.audienceImportId, rowNumber: item.rowNumber})
    const policy = audience.currentPolicy(list.contactListId)
    const channel = channelOf(list)
    const seen = new Map()
    const counts = {add: 0, match: 0, exclude: 0, skip: 0, suppressed: 0, noted: 0}
    for (const source of read.rows) {
        const item = {
            audienceImportId: row.audienceImportId,
            rowNumber: Number(source.rowNumber),
            outcome: "staged",
            attemptCount: 0,
            contactName: nameOf(source).slice(0, 255) || null,
            problemText:
                Array.from(source.problems || [])
                    .join("; ")
                    .slice(0, 4000) || null
        }
        const found = source.empty ? {problem: "EMPTY_ROW"} : addressOf(source, channel)
        if (found.address) item.addressMasked = suppressions.mask(found.address)
        const evidence = found.problem ? {} : evidenceOf(source, terms)
        let exclusion = found.problem || evidence.problem || null
        if (!exclusion && seen.has(found.key)) exclusion = "DUPLICATE_IN_FILE"
        if (exclusion) {
            item.proposedAction = exclusion === "EMPTY_ROW" || exclusion === "DUPLICATE_IN_FILE" ? "skip" : "exclude"
            item.exclusionCode = exclusion
            counts[item.proposedAction]++
        } else {
            seen.set(found.key, item.rowNumber)
            const match = matchOf(source, channel, found, list.ownerPartyId)
            item.proposedAction = match ? "match" : "add"
            counts[item.proposedAction]++
            if (match) {
                item.matchedPartyId = match.partyId
                item.matchReason = match.reason
                item.exclusionCode = membershipNote(list, policy, match.partyId, evidence.evidenceDate)
            }
            if (suppressions.suppressedOf(deliveryChannel(channel), [found.address], list.ownerPartyId).suppressed.length) {
                item.exclusionCode = item.exclusionCode || "SUPPRESSED"
                counts.suppressed++
            }
            if (item.exclusionCode) counts.noted++
        }
        call("create#" + ITEM, item)
    }
    call("update#" + IMPORT, {
        audienceImportId: row.audienceImportId,
        rowCount: read.rowCount,
        mappingJson: JSON.stringify({
            columnMapping: mapping.columnMapping,
            evidenceColumn: mapping.evidenceColumn,
            evidenceDateColumn: mapping.evidenceDateColumn
        }),
        sourceEnumId,
        evidenceDate,
        evidenceText: evidenceText || null,
        evidenceColumn: mapping.evidenceColumn || null,
        evidenceDateColumn: mapping.evidenceDateColumn || null,
        acceptEvidence: accept ? "Y" : "N"
    })
    const saved = one(IMPORT, {audienceImportId: row.audienceImportId})
    return {
        audienceImportId: saved.audienceImportId,
        revision: lib.ms(saved.lastUpdatedStamp),
        rowCount: read.rowCount,
        addCount: counts.add,
        matchCount: counts.match,
        excludeCount: counts.exclude,
        skipCount: counts.skip,
        suppressedCount: counts.suppressed,
        notedCount: counts.noted,
        columns: mapping.columns,
        fieldColumns: mapping.fieldColumns
    }
}

// ===== apply#AudienceImport =====
// One row in its own transaction (apply#AudienceImportRow, internal): the item locked, then the contact matched or made and the
// request filed with the import and row as its source record, and the outcome recorded; an item already applied answers as it is.
function applyAudienceImportRow(p) {
    const item = find(ITEM, {audienceImportId: p.audienceImportId, rowNumber: Number(p.rowNumber)})
        .forUpdate(true)
        .one()
    if (!item) throw new Error("Import " + p.audienceImportId + " has no row " + p.rowNumber)
    const retry = yes(p.retryFailed) && item.outcome === "failed"
    if (item.outcome !== "staged" && !retry) return {outcome: item.outcome, reasonCode: item.reasonCode, already: true}
    const done = (outcome, reasonCode, extra = {}) => {
        call(
            "update#" + ITEM,
            Object.assign(
                {
                    audienceImportId: item.audienceImportId,
                    rowNumber: item.rowNumber,
                    outcome,
                    reasonCode: reasonCode || null,
                    attemptCount: Number(item.attemptCount || 0) + 1,
                    appliedDate: ec.user.nowTimestamp
                },
                extra
            )
        )
        return {outcome, reasonCode: reasonCode || null}
    }
    if (item.proposedAction === "skip") return done("skipped", item.exclusionCode)
    if (item.proposedAction === "exclude") return done("invalid", item.exclusionCode)
    const imported = one(IMPORT, {audienceImportId: item.audienceImportId})
    const list = one("mantle.marketing.contact.ContactList", {contactListId: imported.contactListId})
    const channel = channelOf(list)
    const source = p.row || {}
    const found = addressOf(source, channel)
    if (found.problem) return done("invalid", found.problem)
    const terms = termsOf(imported)
    const evidence = evidenceOf(source, terms)
    if (evidence.problem) return done("invalid", evidence.problem)
    // the contact: the address's party the user may see, else a new directory contact of the row's names and address
    let partyId = matchOf(source, channel, found, list.ownerPartyId)?.partyId || null
    if (!partyId) {
        const made = ec.service
            .sync()
            .name(CI + "import#ContactRow")
            .parameters({contact: channelContact(source, channel, found), duplicatePolicy: "create", asPersonal: false})
            .disableAuthz()
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        partyId = made?.partyId || null
        if (!partyId) throw new Error("No contact was made for row " + item.rowNumber)
        // a contact the import makes is the list's organization's, not the shared directory's every organization reads
        // (SEC-BAP-123); a matched party keeps its owner
        if (made.action === "create" && list.ownerPartyId)
            ec.service
                .sync()
                .name("update#mantle.party.Party")
                .parameters({partyId, ownerPartyId: list.ownerPartyId})
                .disableAuthz()
                .call()
    }
    const mech = Array.from(
        find("mantle.party.contact.PartyContactMechInfo")
            .condition("partyId", partyId)
            .condition("contactMechTypeEnumId", channel)
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .list()
    ).find(info =>
        channel === "CmtTelecomNumber"
            ? normalizePhone(phoneText(info)) === found.key
            : text(info.infoString).toLowerCase() === found.key
    )
    const sourceRecordId = item.audienceImportId + ":" + item.rowNumber
    const filed = call("mantle.marketing.AudienceServices.file#SubscriptionRequest", {
        contactListId: list.contactListId,
        partyId,
        request: {
            requestKindEnumId: "SrkImport",
            sourceEnumId: terms.sourceEnumId,
            evidenceDate: evidence.evidenceDate,
            evidenceText: evidence.evidenceText,
            sourceRecordId,
            contactMechId: mech?.contactMechId || null,
            accept: terms.accept
        }
    }).result
    const request = Array.from(
        find(REQUEST, {contactListId: list.contactListId, partyId, sourceRecordId}).orderBy("-requestedDate").limit(1).list()
    )[0]
    return done(filed.outcome, filed.reasonCode, {partyId, subscriptionRequestId: request?.subscriptionRequestId || null})
}
function applyAudienceImport(p) {
    const retryFailed = yes(p.retryFailed)
    // the import checked and marked applying in a transaction of its own, so each row's transaction stands by itself
    const started = ec.transaction.runRequireNew(null, "Error starting the audience import", () => {
        const imported = find(IMPORT, {audienceImportId: text(p.audienceImportId)})
            .forUpdate(true)
            .one()
        const userScope = importScope(imported?.acceptEvidence === "Y")
        const row = importOfScope(userScope, p.audienceImportId)
        requireRevision(row, p.expectedRevision)
        if (row.stateEnumId === "AisExpired" || (row.stateEnumId === "AisStaged" && expired(row)))
            denied("IMPORT_EXPIRED", "The import expired; import the file again")
        if (row.stateEnumId === "AisComplete" && !retryFailed) return {row, nothing: true}
        if (row.stateEnumId === "AisPartial" && !retryFailed) return {row, nothing: true}
        const list = audience.listOfScope(userScope, row.contactListId)
        audience.requireOpen(list)
        call("update#" + IMPORT, {
            audienceImportId: row.audienceImportId,
            stateEnumId: "AisApplying",
            appliedDate: row.appliedDate || ec.user.nowTimestamp,
            appliedByUserId: ec.user.userId || null
        })
        return {row}
    })
    if (started.nothing) return summaryOf(started.row)
    const row = started.row
    // the rows as the file holds them (a purged file leaves the not yet applied rows failed, to import again)
    let byNumber = new Map()
    let fileProblem = null
    try {
        const fileText = stagedText(row)
        const mapping = lib.json(row.mappingJson, {})
        for (const source of readRows(fileText, row.fileName, mapping.columnMapping || {}).rows)
            byNumber.set(Number(source.rowNumber), source)
    } catch (error) {
        fileProblem = lib.reasonCode(error) || "FAILED"
        ec.logger.error("Audience import " + row.audienceImportId + ": its file could not be read: " + error.message)
    }
    const items = Array.from(find(ITEM, {audienceImportId: row.audienceImportId}).orderBy("rowNumber").list()).filter(
        item => item.outcome === "staged" || (retryFailed && item.outcome === "failed")
    )
    for (const item of items) {
        ec.message.pushErrors()
        try {
            if (fileProblem && !["skip", "exclude"].includes(item.proposedAction)) throw new Error(fileProblem + ": the file")
            ec.service
                .sync()
                .name("mantle.marketing.AudienceServices.apply#AudienceImportRow")
                .parameters({
                    audienceImportId: item.audienceImportId,
                    rowNumber: item.rowNumber,
                    row: byNumber.get(Number(item.rowNumber)) || {},
                    retryFailed
                })
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        } catch (error) {
            const reasonCode = lib.reasonCode(error) || "FAILED"
            ec.logger.error("Audience import " + item.audienceImportId + " row " + item.rowNumber + " failed: " + error.message)
            ec.message.clearErrors()
            ec.transaction.runRequireNew(null, "Error recording the import row's failure", () =>
                call("update#" + ITEM, {
                    audienceImportId: item.audienceImportId,
                    rowNumber: item.rowNumber,
                    outcome: "failed",
                    reasonCode,
                    attemptCount: Number(item.attemptCount || 0) + 1
                })
            )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const finished = ec.transaction.runRequireNew(null, "Error finishing the audience import", () => {
        const counts = countsOf(row.audienceImportId)
        call("update#" + IMPORT, {
            audienceImportId: row.audienceImportId,
            stateEnumId: counts.failed ? "AisPartial" : "AisComplete",
            completedDate: ec.user.nowTimestamp,
            pendingCount: counts.pending,
            acceptedCount: counts.accepted,
            existingCount: counts.existing,
            refusedCount: counts.refused + counts.invalid,
            skippedCount: counts.skipped,
            failedCount: counts.failed
        })
        return one(IMPORT, {audienceImportId: row.audienceImportId})
    })
    return summaryOf(finished)
}
function countsOf(audienceImportId) {
    const counts = {staged: 0, pending: 0, accepted: 0, existing: 0, refused: 0, invalid: 0, skipped: 0, failed: 0}
    for (const item of rows(ITEM, {audienceImportId})) counts[item.outcome] = (counts[item.outcome] || 0) + 1
    return counts
}
function summaryOf(row) {
    const counts = countsOf(row.audienceImportId)
    return {
        audienceImportId: row.audienceImportId,
        stateEnumId: row.stateEnumId,
        revision: lib.ms(row.lastUpdatedStamp),
        pendingCount: counts.pending,
        acceptedCount: counts.accepted,
        existingCount: counts.existing,
        refusedCount: counts.refused,
        invalidCount: counts.invalid,
        skippedCount: counts.skipped,
        failedCount: counts.failed,
        stagedCount: counts.staged
    }
}

// ===== get#AudienceImport =====
function importRow(row, list) {
    const state = states[row.stateEnumId] || ["staged", row.stateEnumId]
    return {
        audienceImportId: row.audienceImportId,
        contactListId: row.contactListId,
        listName: list?.contactListName || row.contactListId,
        organizationPartyId: row.organizationPartyId,
        organizationName: row.organizationPartyId
            ? one("mantle.party.Organization", {partyId: row.organizationPartyId})?.organizationName || row.organizationPartyId
            : "",
        fileName: row.fileName || "",
        rowCount: Number(row.rowCount || 0),
        stateEnumId: row.stateEnumId,
        state: state[0],
        stateText: state[1],
        stateColor:
            row.stateEnumId === "AisComplete"
                ? "positive"
                : row.stateEnumId === "AisPartial" || row.stateEnumId === "AisExpired"
                  ? "negative"
                  : "warning",
        sourceText: enumText(row.sourceEnumId),
        sourceEnumId: row.sourceEnumId,
        evidenceText: row.evidenceText || "",
        evidenceDate: row.evidenceDate,
        evidenceDateText: lib.dateText(row.evidenceDate),
        evidenceColumn: row.evidenceColumn || "",
        evidenceDateColumn: row.evidenceDateColumn || "",
        acceptEvidence: row.acceptEvidence || "N",
        stagedText: lib.dateText(row.stagedDate),
        stagedBy: userName(row.stagedByUserId),
        appliedText: lib.dateText(row.appliedDate),
        appliedBy: userName(row.appliedByUserId),
        completedText: lib.dateText(row.completedDate),
        expireText: lib.dateText(row.expireDate),
        purged: row.purgedDate != null,
        expired: expired(row),
        revision: lib.ms(row.lastUpdatedStamp)
    }
}
function itemRow(item, names) {
    const reason = item.reasonCode || item.exclusionCode || ""
    return {
        rowNumber: item.rowNumber,
        proposedAction: item.proposedAction,
        actionText:
            item.proposedAction === "match"
                ? "Existing contact " + (names[item.matchedPartyId] || item.matchedPartyId)
                : item.proposedAction === "add"
                  ? "New contact"
                  : item.proposedAction === "skip"
                    ? "Skipped"
                    : "Excluded",
        contactName: item.contactName || "",
        addressMasked: item.addressMasked || "",
        matchedPartyId: item.matchedPartyId || null,
        partyId: item.partyId || null,
        partyName: item.partyId ? names[item.partyId] || item.partyId : "",
        exclusionCode: item.exclusionCode || "",
        problemText: item.problemText || "",
        outcome: item.outcome,
        outcomeText: outcomeTexts[item.outcome] || item.outcome,
        outcomeColor: outcomeColors[item.outcome] || "grey-7",
        reasonCode: reason,
        reasonText: reason ? reasonTexts[reason] || reason : "",
        attemptCount: Number(item.attemptCount || 0)
    }
}
function getAudienceImport(p) {
    const userScope = audience.audienceScope()
    const row = importOfScope(userScope, p.audienceImportId)
    const list = one("mantle.marketing.contact.ContactList", {contactListId: row.contactListId})
    let query = find(ITEM, {audienceImportId: row.audienceImportId}).orderBy("rowNumber")
    const filter = text(p.outcome)
    if (filter === "errors") query = query.condition("outcome", "in", errorOutcomes)
    else if (filter === "excluded") query = query.condition("proposedAction", "in", ["exclude", "skip"])
    else if (filter) query = query.condition("outcome", filter)
    const paged = lib.page(query, p, "itemList", query.count())
    const names = lib.partyNames(paged.rows.flatMap(item => [item.partyId, item.matchedPartyId]).filter(Boolean))
    paged.itemList = paged.rows.map(item => itemRow(item, names))
    delete paged.rows
    const caps = userScope.capabilities
    const counts = countsOf(row.audienceImportId)
    const proposed = {add: 0, match: 0, exclude: 0, skip: 0, noted: 0}
    for (const item of rows(ITEM, {audienceImportId: row.audienceImportId})) {
        proposed[item.proposedAction] = (proposed[item.proposedAction] || 0) + 1
        if (item.exclusionCode && ["add", "match"].includes(item.proposedAction)) proposed.noted++
    }
    const importer = !!(caps.audienceEdit && caps.audienceImport)
    const open = list && !audience.archived(list)
    const accepting = row.acceptEvidence === "Y"
    const errorCount = counts.refused + counts.invalid + counts.failed
    let stored = lib.json(row.mappingJson, {})
    let fieldColumns = {}
    for (const [key, field] of Object.entries(columnFields))
        fieldColumns[key] = Object.keys(stored.columnMapping || {}).find(name => stored.columnMapping[name] === field) || ""
    return Object.assign(paged, {
        audienceImport: importRow(row, list),
        counts,
        proposed,
        errorCount,
        columns: Object.keys(stored.columnMapping || {}),
        fieldColumns,
        capabilities: {
            canPreview:
                importer && open && row.stateEnumId === "AisStaged" && !expired(row) && (!accepting || !!caps.consentEdit),
            canApply:
                importer &&
                open &&
                (row.stateEnumId === "AisStaged" || row.stateEnumId === "AisApplying") &&
                !expired(row) &&
                (!accepting || !!caps.consentEdit),
            canRetry: importer && open && row.stateEnumId === "AisPartial" && counts.failed > 0 && !!row.fileLocation,
            canAccept: !!caps.consentEdit,
            canDownloadErrors: importer && errorCount > 0 && !!row.fileLocation
        }
    })
}

// ===== find#AudienceImportRuns (DataTransferServices.find#TargetRuns) =====
// The imports of the organizations the caller reads audiences of, newest first, as summaries: the file's name and list, the
// organization, the state, who staged it and the counts; never a row or an address. None for a caller without the audience view.
function findAudienceImportRuns(p) {
    let userScope
    try {
        userScope = audience.audienceScope()
    } catch (error) {
        return {runList: []}
    }
    const organizationPartyIds = marketingAccess.organizationIds(userScope)
    if (!organizationPartyIds.length) return {runList: []}
    let query = find(IMPORT).condition("organizationPartyId", "in", organizationPartyIds)
    if (text(p.scopeKey)) query = query.condition("organizationPartyId", text(p.scopeKey))
    if (text(p.contactListId)) query = query.condition("contactListId", text(p.contactListId))
    if (p.fromDate != null && p.fromDate !== "")
        query = query.condition("stagedDate", "greater-equals", new Date(Number(p.fromDate)))
    if (p.thruDate != null && p.thruDate !== "") query = query.condition("stagedDate", "less", new Date(Number(p.thruDate)))
    const runList = []
    for (const row of Array.from(
        query
            .orderBy("-stagedDate")
            .limit(Math.min(Number(p.maxRows) || 50, 200))
            .list()
    )) {
        const list = one("mantle.marketing.contact.ContactList", {contactListId: row.contactListId})
        const shown = importRow(row, list)
        const counts = countsOf(row.audienceImportId)
        runList.push({
            runId: row.audienceImportId,
            fileLabel: [row.fileName, list?.contactListName].filter(Boolean).join(" · "),
            listName: shown.listName,
            scopeKey: row.organizationPartyId,
            scopeTitle: shown.organizationName,
            state: shown.state,
            stateText: shown.stateText,
            stateColor: shown.stateColor,
            startedDate: lib.ms(row.stagedDate),
            startedText: shown.stagedText,
            userName: shown.stagedBy,
            rowCount: Number(row.rowCount || 0),
            appliedCount: counts.pending + counts.accepted + counts.existing,
            errorCount: counts.refused + counts.invalid + counts.failed,
            skippedCount: counts.skipped,
            ownerParameters: {audienceImportId: row.audienceImportId}
        })
    }
    return {runList}
}

// ===== get#AudienceImportErrors =====
// The rows refused, invalid or failed, as the file held them, with the reason of each (design §18 "error rows"): CSV whose cells a
// spreadsheet would read as a formula are written as text. For an audience reader of the organization while the file is staged.
const cell = value => {
    let out = String(value ?? "")
    if (/^[=+\-@\t\r]/.test(out)) out = "'" + out
    return /[",\r\n]/.test(out) ? '"' + out.replace(/"/g, '""') + '"' : out
}
function getAudienceImportErrors(p) {
    // the file as staged, every column of it (those the import ignores too): its importers' alone, not every audience reader's
    const userScope = audience.audienceScope("audienceEdit")
    marketingAccess.requireCapability(userScope, "audienceImport")
    const row = importOfScope(userScope, p.audienceImportId)
    const fileText = stagedText(row)
    const parsed = call(CI + "read#ContactRows", {fileText, fileName: row.fileName, columnMapping: {}})
    const columns = Array.from(parsed.columnList || []).map(column => text(column.columnName))
    const sources = new Map(Array.from(parsed.contactList || []).map(source => [Number(source.rowNumber), source]))
    const lines = [columns.concat(["Row", "Reason"]).map(cell).join(",")]
    let rowCount = 0
    for (const item of Array.from(
        find(ITEM, {audienceImportId: row.audienceImportId}).condition("outcome", "in", errorOutcomes).orderBy("rowNumber").list()
    )) {
        const values = sources.get(Number(item.rowNumber))?.values || {}
        const reason = item.reasonCode || item.exclusionCode || ""
        lines.push(
            columns
                .map(column => values[column])
                .concat([item.rowNumber, reason + (reasonTexts[reason] ? ": " + reasonTexts[reason] : "")])
                .map(cell)
                .join(",")
        )
        rowCount++
    }
    return {
        fileText: lines.join("\r\n") + "\r\n",
        fileName: "audience-import-" + row.audienceImportId + "-errors.csv",
        rowCount
    }
}

// ===== purge#AudienceImports (the daily job) =====
// The staged files of the imports past their expiry removed and the outcomes kept; an import never applied expires. Each import on
// its own: one that fails is logged and the rest go on.
function purgeAudienceImports(p) {
    let purgedCount = 0
    const due = Array.from(
        find(IMPORT)
            .condition("purgedDate", "is-null", null)
            .condition("expireDate", "less", ec.user.nowTimestamp)
            .orderBy("expireDate")
            .limit(Math.min(Number(p.maxImports) || 500, 5000))
            .list()
    )
    for (const row of due) {
        try {
            ec.transaction.runRequireNew(null, "Error purging an audience import", () => {
                if (row.fileLocation) {
                    const reference = ec.resource.getLocationReference(row.fileLocation)
                    if (reference.getExists()) reference.delete()
                }
                call("update#" + IMPORT, {
                    audienceImportId: row.audienceImportId,
                    fileLocation: null,
                    purgedDate: ec.user.nowTimestamp,
                    stateEnumId: row.stateEnumId === "AisStaged" ? "AisExpired" : row.stateEnumId
                })
            })
            purgedCount++
        } catch (error) {
            ec.logger.error("Audience import " + row.audienceImportId + " was not purged: " + error.message)
        }
    }
    return {purgedCount}
}

// ===== the membership export (DataTransferServices find#TargetScopes, run#TargetExport; design §18) =====
// The lists a holder of MARKETING_AUDIENCE_EXPORT may export: the Marketing lists of their organizations (scopeKey the list).
function exportScope() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.audienceExport) return null
    return userScope
}
function findMemberExportScopes() {
    const userScope = exportScope()
    if (!userScope) return {scopeList: []}
    const organizationPartyIds = marketingAccess.organizationIds(userScope)
    if (!organizationPartyIds.length) return {scopeList: []}
    return {
        scopeList: Array.from(
            find("mantle.marketing.contact.ContactList")
                .condition("ownerPartyId", "in", organizationPartyIds)
                .condition("contactListTypeEnumId", "not-equals", "MAILBOX")
                .orderBy("contactListName")
                .limit(500)
                .list()
        ).map(list => ({scopeKey: list.contactListId, title: list.contactListName || list.contactListId}))
    }
}
// A list's members by state (selection.memberStatus: current, the default; subscribed, pending, unsubscribed or history): each its
// party, name, state, since and until, and the address, which the registration gives only to a holder of MARKETING_AUDIENCE_VIEW;
// the fields asked for alone. rowCount alone with countOnly or past maxRows.
const exportStatuses = {
    current: ["CLPT_PENDING", "CLPT_ACCEPTED", "CLPT_IN_USE", "CLPT_UNSUBS_PENDING"],
    subscribed: ["CLPT_ACCEPTED", "CLPT_IN_USE"],
    pending: ["CLPT_PENDING"],
    unsubscribed: ["CLPT_UNSUBSCRIBED", "CLPT_UNSUBS_PENDING"]
}
function exportMemberTransfer(p) {
    const refused = (reasonCode, reason) => ({refused: true, reasonCode, reason, rowCount: 0})
    const userScope = exportScope()
    if (!userScope) return refused("PERMISSION_DENIED", "Exporting list members needs MARKETING_AUDIENCE_EXPORT")
    const list = one("mantle.marketing.contact.ContactList", {contactListId: text(p.scopeKey)})
    if (!list || list.contactListTypeEnumId === "MAILBOX" || !marketingAccess.covers(userScope, list.ownerPartyId))
        return refused("SCOPE_INVALID", "Choose one of your organizations' lists")
    const filter = text(p.selection?.memberStatus) || "current"
    let query = find(CLP, {contactListId: list.contactListId}).orderBy("partyId,-fromDate")
    if (filter !== "history") query = query.conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    if (exportStatuses[filter]) query = query.condition("statusId", "in", exportStatuses[filter])
    const limit = Number(p.maxRows) || 5000
    const count = query.count()
    if (p.countOnly === true || p.countOnly === "true" || count > limit) return {rowCount: count}
    const fields = new Set(Array.from(p.fieldList || []).map(field => text(field?.name ?? field)))
    const memberRows = Array.from(query.list())
    const names = lib.partyNames(memberRows.map(row => row.partyId))
    const statusTexts = audiences.statusTexts
    const rowList = memberRows.map(row => {
        const out = {}
        const values = {
            partyId: row.partyId,
            partyName: names[row.partyId] || row.partyId,
            status: statusTexts[row.statusId] || row.statusId,
            fromDate: lib.dateText(row.fromDate),
            thruDate: lib.dateText(row.thruDate),
            // the registration gives the field to an audience reader alone; checked here too, for any other caller
            address:
                fields.has("address") && userScope.capabilities.audienceView
                    ? audience.addressText(row.preferredContactMechId)
                    : ""
        }
        for (const [name, value] of Object.entries(values)) if (fields.has(name)) out[name] = value
        return out
    })
    return {rowList, rowCount: rowList.length}
}

const operations = {
    findMemberExportScopes,
    exportMemberTransfer,
    previewAudienceImport,
    applyAudienceImport,
    applyAudienceImportRow,
    getAudienceImport,
    findAudienceImportRuns,
    getAudienceImportErrors,
    purgeAudienceImports
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown audience import operation " + op)
        return operations[op](parameters || {})
    }
})
