// This software is in the public domain under CC0 1.0 Universal plus a
// Grant of Patent License.
//
// To the extent possible under law, the author(s) have dedicated all
// copyright and related and neighboring rights to this software to the
// public domain worldwide. This software is distributed without any
// warranty.
//
// You should have received a copy of the CC0 Public Domain Dedication
// along with this software (see the LICENSE.md file). If not, see
// <http://creativecommons.org/publicdomain/zero/1.0/>.

// X12 interchanges (plan/payments-shipping-edi.md E1, docs/EdiX12.md): the operations behind EdiServices.xml. Ported
// from the Java Moqui mantle-edi component (github.com/moqui/mantle-edi, 1.1.5, commit 134acb6, written by David E.
// Jones: EdiServices.xml's receive, consume, 997 and envelope services) to XML Actions and JavaScript, with the
// corrections the plan lists: the receipt is kept before it is parsed; every group and transaction set of every
// interchange is processed, with its controls and trailer counts checked; an untrusted envelope is quarantined while one
// bad transaction set leaves its siblings alone; the routing is the authenticated connection's, never the IDs in the
// payload; control numbers sent are allocated durably; and a document is recorded with the business transaction and
// produced and sent after it commits.
//
// A received document goes Stored, Validated or Rejected (its group's 997 says which), then through its profile's
// mapping service. Each step is a transaction of its own (store, each validation, each group's 997, each application),
// so a crash resumes from the statuses and one failure does not undo another. Payloads and documents are never logged;
// the module logs IDs and reason codes.
const x = ec.resource.script("component://mr-mantle/service/mantle/edi/X12Lib.js")
const {lib, E, IN, OUT, SERVICES, ISA_VERSION, find, one, rows, denied, blank, el} = x
const {call, probe} = lib

const SYSTEM_MESSAGE = "org.moqui.impl.SystemMessageServices."
// X12 4010 functional identifier (GS01) of each transaction set (ST01) taken or sent.
const FUNCTIONAL_ID = {850: "PO", 855: "PR", 856: "SH", 810: "IN", 997: "FA"}

// ---- receive and consume ----

// receive#X12Interchange: keep the bytes as they came, once per remote and content, before anything is parsed.
function receive(p) {
    if (blank(p.systemMessageRemoteId))
        denied("CONNECTION_REQUIRED", "An X12 receipt needs the authenticated connection (systemMessageRemoteId)")
    const messageText = String(p.messageText ?? "")
    const digest = String(ec.user.singleUseCodeHash(messageText)).replace(/[^A-Za-z0-9]/g, "")
    const out = call(SYSTEM_MESSAGE + "store#ReceivedSystemMessage", {
        systemMessageTypeId: p.systemMessageTypeId || "EdiX12",
        systemMessageRemoteId: p.systemMessageRemoteId,
        messageId: "x12-" + digest.slice(0, 40),
        messageText,
        remoteMessageId: p.remoteMessageId
    })
    return {systemMessageIdList: out.systemMessageIdList || [], duplicateOfId: out.duplicateOfId || null}
}

// consume#X12Interchange: store the envelopes, validate each document, record each group's 997, apply each validated
// document, then send what this produced. Resumes a receipt consumed before from its records' statuses.
function consume(p) {
    const systemMessageId = p.systemMessageId
    probe(SERVICES + "store#ReceivedInterchanges", {systemMessageId})
    const interchanges = rows(E.INTERCHANGE, {systemMessageId, directionEnumId: IN})
    const accepted = interchanges.filter(row => row.statusId === "EdinAccepted")
    const documents = () => accepted.flatMap(ic => rows(E.DOCUMENT, {ediInterchangeId: ic.ediInterchangeId, directionEnumId: IN}))
    for (const doc of documents().filter(row => row.statusId === "EdocStored")) {
        try {
            probe(SERVICES + "validate#InboundDocument", {ediDocumentId: doc.ediDocumentId})
        } catch (error) {
            ec.logger.error("X12 document " + doc.ediDocumentId + " not validated, left Stored: " + x.codeOf(error))
            note(doc.ediDocumentId, error)
        }
    }
    for (const ic of accepted)
        for (const group of rows(E.GROUP, {ediInterchangeId: ic.ediInterchangeId})) {
            try {
                probe(SERVICES + "record#GroupAcknowledgment", {
                    ediInterchangeId: ic.ediInterchangeId,
                    groupSeqId: group.groupSeqId
                })
            } catch (error) {
                ec.logger.error(
                    "X12 group " + ic.ediInterchangeId + "/" + group.groupSeqId + " 997 not recorded: " + x.codeOf(error)
                )
            }
        }
    for (const doc of documents().filter(row => row.statusId === "EdocValidated")) applyOrRecord(doc.ediDocumentId)

    const c = x.connection(rows(E.MESSAGE, {systemMessageId})[0]?.systemMessageRemoteId)
    const groups = accepted.flatMap(ic => rows(E.GROUP, {ediInterchangeId: ic.ediInterchangeId}))
    if (c && c.conn.sendOnCommit !== "N") {
        const pending = groups
            .map(group => group.ackDocumentId)
            .filter(Boolean)
            .filter(id => one(E.DOCUMENT, {ediDocumentId: id})?.statusId === "EdocPending")
        // after this consume commits, as the documents sent for business events are
        if (pending.length) {
            try {
                ec.service
                    .special()
                    .name(SERVICES + "send#PendingDocuments")
                    .parameters({ediDocumentIdList: pending})
                    .registerOnCommit()
            } catch (error) {
                ec.logger.warn("X12 997s of receipt " + systemMessageId + " not queued after commit; the send job sends them")
            }
        }
    }

    // Anything not finished is shown on the receipt, so it is not taken for consumed: an interchange quarantined, a
    // document left Stored or Validated (its validation or application could not be recorded), a group that is owed a
    // 997 and has none. retry#Receipt resumes it from here.
    const problems = interchanges
        .filter(row => row.statusId === "EdinQuarantined")
        .map(
            row =>
                "Interchange " +
                (row.controlNumber || "?") +
                " quarantined (" +
                row.reasonCode +
                "): " +
                x.clip(row.errorText, 300)
        )
    for (const doc of documents().filter(row => row.statusId === "EdocStored" || row.statusId === "EdocValidated"))
        problems.push(
            "Document " + doc.ediDocumentId + " left " + doc.statusId + (doc.errorText ? ": " + x.clip(doc.errorText, 300) : "")
        )
    if (c?.profile?.generateFunctionalAck === "Y" && x.profileDocument(c, "997", OUT))
        for (const group of groups.map(row => one(E.GROUP, {ediInterchangeId: row.ediInterchangeId, groupSeqId: row.groupSeqId})))
            if (group.functionalIdCode !== "FA" && !group.ackDocumentId)
                problems.push("Group " + group.controlNumber + " of interchange " + group.ediInterchangeId + " has no 997")
    if (!problems.length) return {}
    call("update#" + E.MESSAGE, {systemMessageId, statusId: "SmsgError", lastAttemptDate: ec.user.nowTimestamp})
    call("create#moqui.service.message.SystemMessageError", {
        systemMessageId,
        errorDate: ec.user.nowTimestamp,
        attemptedStatusId: "SmsgConsumed",
        errorText: x.clip(problems.join("; "), 4000)
    })
    return {noStatusUpdate: true}
}
function note(ediDocumentId, error) {
    try {
        probe("update#" + E.DOCUMENT, {ediDocumentId, errorText: x.clip(String(error?.message ?? error), 2000)})
    } catch (noted) {
        ec.logger.error("X12 document " + ediDocumentId + " error not recorded: " + x.codeOf(noted))
    }
}
// Apply a validated document in a transaction of its own; a refusal or failure rolls that back and is recorded as the
// document's exception, in another.
function applyOrRecord(ediDocumentId) {
    try {
        probe(SERVICES + "apply#InboundDocument", {ediDocumentId})
        return true
    } catch (error) {
        const reasonCode = x.codeOf(error, "APPLY_FAILED")
        ec.logger.warn("X12 document " + ediDocumentId + " not applied: " + reasonCode)
        try {
            probe(SERVICES + "record#InboundException", {
                ediDocumentId,
                reasonCode,
                errorText: x.clip(String(error?.message ?? error), 2000)
            })
        } catch (recorded) {
            ec.logger.error("X12 document " + ediDocumentId + " exception not recorded: " + x.codeOf(recorded))
        }
        return false
    }
}

// ---- the envelope ----

// A receipt's interchanges: the separators from the first ISA (fixed width: element separator at 3, component at 104,
// terminator at 105), then ISA..IEA, GS..GE and ST..SE with what is missing or misplaced. Throws when no ISA can be read.
function tokenize(messageText) {
    const textIn = String(messageText).replace(/^﻿/, "")
    const start = textIn.search(/\S/)
    if (start < 0 || !textIn.startsWith("ISA", start)) denied("NOT_X12", "The receipt does not start with an ISA segment")
    const body = textIn.slice(start)
    if (body.length < 106) denied("ISA_MALFORMED", "The ISA segment is shorter than its 106 characters")
    const separators = {element: body[3], component: body[104], segment: body[105]}
    const chars = Object.values(separators)
    if (new Set(chars).size !== 3 || chars.some(ch => /[A-Za-z0-9 ]/.test(ch)))
        denied("ISA_MALFORMED", "The ISA segment's separators cannot be read")
    const interchanges = []
    const stray = []
    let ic = null,
        group = null,
        tx = null
    const closeTx = () => {
        if (tx && !tx.se) tx.errors.push("2")
        tx = null
    }
    const closeGroup = () => {
        closeTx()
        if (group && !group.ge) group.missingTrailer = true
        group = null
    }
    const closeInterchange = () => {
        closeGroup()
        if (ic && !ic.iea) ic.problems.push(["IEA_MISSING", "The interchange has no IEA trailer"])
        ic = null
    }
    for (const segment of x.segmentsOf(body, separators)) {
        switch (segment.id) {
            case "ISA":
                closeInterchange()
                ic = {isa: segment, groups: [], problems: [], start: segment.start, end: segment.end, other: []}
                interchanges.push(ic)
                break
            case "IEA":
                if (!ic) stray.push(segment)
                else {
                    closeGroup()
                    ic.iea = segment
                    ic.end = segment.end
                    ic = null
                }
                break
            case "GS":
                if (!ic) stray.push(segment)
                else {
                    closeGroup()
                    group = {gs: segment, transactions: [], strays: 0}
                    ic.groups.push(group)
                    ic.end = segment.end
                }
                break
            case "GE":
                if (!group) (ic ? ic.other : stray).push(segment)
                else {
                    closeTx()
                    group.ge = segment
                    group = null
                    ic.end = segment.end
                }
                break
            case "ST":
                if (!group) (ic ? ic.other : stray).push(segment)
                else {
                    closeTx()
                    tx = {st: segment, segments: [segment], errors: []}
                    group.transactions.push(tx)
                    ic.end = segment.end
                }
                break
            case "SE":
                if (!tx) {
                    if (group) group.strays++
                    else (ic ? ic.other : stray).push(segment)
                } else {
                    tx.segments.push(segment)
                    tx.se = segment
                    tx = null
                }
                if (ic) ic.end = segment.end
                break
            default:
                if (tx) tx.segments.push(segment)
                else if (group) group.strays++
                else if (ic) ic.other.push(segment)
                else stray.push(segment)
                if (ic) ic.end = segment.end
        }
    }
    closeInterchange()
    for (const each of interchanges) each.text = body.slice(each.start, Math.min(body.length, each.end + 1))
    return {separators, interchanges, stray, body}
}

// Control numbers and counts compare as numbers: 0001 and 1 are the same control.
const sameNumber = (value, expected) => x.isN(String(value)) && x.isN(String(expected)) && Number(value) === Number(expected)
// The problems that make an interchange untrusted: its ISA form, version, controls and trailer count, and a sender,
// receiver or usage other than its connection's. Each is [reasonCode, text].
function envelopeProblems(ic, c, separators) {
    const problems = [...ic.problems]
    const isa = ic.isa
    if (isa.text.length !== 105 || isa.elements.length !== 17)
        problems.push(["ISA_MALFORMED", "The ISA segment is not 16 fixed-width elements"])
    if (isa.text[3] !== separators.element || isa.text.slice(-1) !== separators.component)
        problems.push(["ISA_MALFORMED", "The ISA separators differ from the receipt's first interchange"])
    const control = el(isa, 13)
    if (!/^\d{9}$/.test(control)) problems.push(["CONTROL_INVALID", "ISA13 is not a nine-digit control number"])
    if (el(isa, 12) !== ISA_VERSION)
        problems.push([
            "UNSUPPORTED_VERSION",
            "Interchange version ISA12 " + el(isa, 12) + " is not supported; " + ISA_VERSION + " is"
        ])
    if (ic.iea) {
        if (!sameNumber(el(ic.iea, 2), control)) problems.push(["CONTROL_MISMATCH", "IEA02 does not match ISA13"])
        if (!sameNumber(el(ic.iea, 1), ic.groups.length))
            problems.push(["COUNT_MISMATCH", "IEA01 says " + el(ic.iea, 1) + " groups and there are " + ic.groups.length])
    }
    if (ic.other.length)
        problems.push(["SEGMENT_OUTSIDE_GROUP", "Segments outside a functional group: " + ic.other.map(s => s.id).join(", ")])
    if (!c) {
        problems.push(["CONNECTION_UNKNOWN", "The remote this came on is not an EDI connection"])
        return problems
    }
    if (!c.profile || !c.organizationPartyId || !c.partnerPartyId)
        problems.push(["CONFIG_INVALID", "The connection needs a profile, a product store with an organization and a partner"])
    const remote = c.remote || {}
    if (el(isa, 5) !== String(remote.remoteIdType ?? "").trim() || el(isa, 6) !== String(remote.remoteId ?? "").trim())
        problems.push([
            "SENDER_UNKNOWN",
            "ISA05/06 is not the connection's partner " + (remote.remoteIdType || "") + "/" + (remote.remoteId || "")
        ])
    if (el(isa, 7) !== String(remote.internalIdType ?? "").trim() || el(isa, 8) !== String(remote.internalId ?? "").trim())
        problems.push(["RECEIVER_UNKNOWN", "ISA07/08 is not this connection's receiver"])
    if (!blank(remote.usageCode) && el(isa, 15) !== remote.usageCode)
        problems.push(["USAGE_MISMATCH", "ISA15 " + el(isa, 15) + " is not the connection's usage " + remote.usageCode])
    for (const group of ic.groups) {
        if (!blank(remote.remoteAppCode) && el(group.gs, 2) !== remote.remoteAppCode)
            problems.push(["SENDER_UNKNOWN", "GS02 is not the connection's partner application code"])
        if (!blank(remote.internalAppCode) && el(group.gs, 3) !== remote.internalAppCode)
            problems.push(["RECEIVER_UNKNOWN", "GS03 is not this connection's application code"])
    }
    return problems
}
// The AK905 code that rejects a whole group, or null: trailer, controls, count, version, functional ID.
function groupErrorCode(group, c) {
    if (!group.ge) return "3"
    const control = el(group.gs, 6)
    if (!/^\d{1,9}$/.test(control)) return "6"
    if (!sameNumber(el(group.ge, 2), control)) return "4"
    if (!sameNumber(el(group.ge, 1), group.transactions.length) || group.strays) return "5"
    if (el(group.gs, 8) !== c.profile.x12Version) return "2"
    const functionalId = el(group.gs, 1)
    if (
        functionalId === "FA"
            ? !x.profileDocument(c, "997", IN)
            : !Object.keys(FUNCTIONAL_ID).some(set => FUNCTIONAL_ID[set] === functionalId && x.profileDocument(c, set, IN))
    )
        return "1"
    return null
}
// The AK502 code that rejects a transaction set before its body is read, or null: 1 a set the profile does not take,
// 6 a set of another functional group.
function transactionErrorCode(tx, group, seen, c) {
    if (tx.errors.length) return tx.errors[0]
    const set = el(tx.st, 1)
    const control = el(tx.st, 2)
    if (!/^\d{3}$/.test(set)) return "6"
    if (FUNCTIONAL_ID[set] && FUNCTIONAL_ID[set] !== el(group.gs, 1)) return "6"
    if (!FUNCTIONAL_ID[set] || !x.profileDocument(c, set, IN)) return "1"
    if (blank(control) || control.length < 4 || control.length > 9) return "7"
    if (el(tx.se, 2) !== control && !sameNumber(el(tx.se, 2), control)) return "3"
    if (!sameNumber(el(tx.se, 1), tx.segments.length)) return "4"
    if (seen.has(control)) return "23"
    return null
}
const groupReasons = {
    1: "UNSUPPORTED_DOCUMENT",
    2: "UNSUPPORTED_VERSION",
    3: "GROUP_TRAILER_MISSING",
    4: "CONTROL_MISMATCH",
    5: "COUNT_MISMATCH",
    6: "CONTROL_INVALID"
}
const transactionReasons = {
    1: "UNSUPPORTED_DOCUMENT",
    2: "TRAILER_MISSING",
    3: "CONTROL_MISMATCH",
    4: "COUNT_MISMATCH",
    5: "SYNTAX_ERRORS",
    6: "SET_ID_INVALID",
    7: "CONTROL_INVALID",
    23: "CONTROL_NOT_UNIQUE"
}
function x12Stamp(date, time) {
    if (!x.validDate(date)) return null
    const full = date.length === 6 ? "20" + date : date
    const clock = x.validTime(time) ? time.slice(0, 4) : "1200"
    return ec.l10n.parseTimestamp(full + " " + clock, "yyyyMMdd HHmm")
}

// store#ReceivedInterchanges: the receipt's interchanges, groups and documents, once. A receipt that cannot be read and
// an untrusted interchange are quarantined; a group whose controls, trailer, version or functional ID fail is rejected
// as a whole; a document whose ST/SE controls or count fail is rejected; the others are Stored for validation.
function storeReceipt(p) {
    const systemMessageId = p.systemMessageId
    const message = one(E.MESSAGE, {systemMessageId})
    if (!message) denied("RECORD_UNAVAILABLE", "No system message " + systemMessageId)
    const c = x.connection(message.systemMessageRemoteId)
    const scope = {
        directionEnumId: IN,
        systemMessageId,
        systemMessageRemoteId: message.systemMessageRemoteId,
        organizationPartyId: c?.organizationPartyId,
        partnerPartyId: c?.partnerPartyId,
        usageCode: c?.usageCode
    }
    const existing = rows(E.INTERCHANGE, {systemMessageId, directionEnumId: IN})
    // A receipt stored before: only its quarantined interchanges are looked at again, from the kept bytes, since the
    // connection's configuration may have been fixed since (resend of the same bytes is a duplicate receipt).
    const retrying = existing.filter(row => row.statusId === "EdinQuarantined")
    if (existing.length && !retrying.length) return {resumed: true}
    let parsed
    try {
        parsed = tokenize(message.messageText ?? "")
    } catch (error) {
        if (existing.length) return {resumed: true}
        call(
            "create#" + E.INTERCHANGE,
            Object.assign({}, scope, {
                receiptSeq: 1,
                statusId: "EdinQuarantined",
                reasonCode: x.codeOf(error, "NOT_X12"),
                errorText: x.clip(error.message, 2000)
            })
        )
        return {quarantined: 1}
    }
    let quarantined = 0
    // Segments outside any interchange are the receipt's own error (receipt sequence 0); its interchanges stand alone.
    if (parsed.stray.length && !existing.some(row => Number(row.receiptSeq) === 0))
        call(
            "create#" + E.INTERCHANGE,
            Object.assign({}, scope, {
                receiptSeq: 0,
                statusId: "EdinQuarantined",
                reasonCode: "SEGMENT_OUTSIDE_INTERCHANGE",
                errorText: "Segments outside an interchange: " + parsed.stray.map(segment => segment.id).join(", ")
            })
        )
    parsed.interchanges.forEach((ic, index) => {
        const receiptSeq = index + 1
        const before = existing.filter(row => Number(row.receiptSeq) === receiptSeq && row.statusId !== "EdinSuperseded")
        if (before.length && before.every(row => row.statusId !== "EdinQuarantined")) return
        const outcome = storeInterchange(c, ic, receiptSeq, parsed, scope)
        if (outcome === "EdinQuarantined") {
            quarantined++
            return
        }
        // the earlier quarantine of this interchange is replaced by the record made now
        for (const row of before.filter(row => row.statusId === "EdinQuarantined"))
            call("update#" + E.INTERCHANGE, {ediInterchangeId: row.ediInterchangeId, statusId: "EdinSuperseded"})
    })
    return {quarantined, resumed: existing.length > 0}
}
// One interchange of a receipt: quarantined, a duplicate, or accepted with its groups and documents. On a retry a
// quarantine that still holds updates the earlier row instead of adding one.
function storeInterchange(c, ic, receiptSeq, parsed, scope) {
    const isa = ic.isa
    const header = Object.assign({}, scope, {
        receiptSeq,
        senderQualifier: el(isa, 5),
        senderId: el(isa, 6),
        receiverQualifier: el(isa, 7),
        receiverId: el(isa, 8),
        controlNumber: el(isa, 13),
        versionCode: el(isa, 12),
        interchangeDate: x12Stamp(el(isa, 9), el(isa, 10)),
        interchangeText: ic.text
    })
    const problems = envelopeProblems(ic, c, parsed.separators)
    if (problems.length) {
        const quarantine = {
            statusId: "EdinQuarantined",
            reasonCode: problems[0][0],
            errorText: x.clip(problems.map(problem => problem[1]).join("; "), 2000)
        }
        const earlier = rows(E.INTERCHANGE, {
            systemMessageId: scope.systemMessageId,
            directionEnumId: IN,
            receiptSeq,
            statusId: "EdinQuarantined"
        })[0]
        if (earlier) call("update#" + E.INTERCHANGE, Object.assign({ediInterchangeId: earlier.ediInterchangeId}, quarantine))
        else call("create#" + E.INTERCHANGE, Object.assign(header, quarantine))
        return "EdinQuarantined"
    }
    // The same interchange processed before (its bytes again under a new receipt): kept, not processed again.
    const before = rows(E.INTERCHANGE, {
        directionEnumId: IN,
        partnerPartyId: c.partnerPartyId,
        organizationPartyId: c.organizationPartyId,
        usageCode: c.usageCode,
        senderId: header.senderId,
        controlNumber: header.controlNumber,
        statusId: "EdinAccepted"
    })
    const same = before.find(row => row.interchangeText === ic.text)
    if (same) {
        call(
            "create#" + E.INTERCHANGE,
            Object.assign(header, {
                statusId: "EdinDuplicate",
                reasonCode: "DUPLICATE_INTERCHANGE",
                errorText: "The same interchange was received in " + same.systemMessageId
            })
        )
        return "EdinDuplicate"
    }
    const ediInterchangeId = call(
        "create#" + E.INTERCHANGE,
        Object.assign(header, {
            statusId: "EdinAccepted",
            errorText: before.length ? "Control number " + header.controlNumber + " was received before with other content" : null
        })
    ).ediInterchangeId
    ic.groups.forEach((group, groupIndex) => storeGroup(c, ediInterchangeId, groupIndex, group, parsed.separators, scope))
    return "EdinAccepted"
}
function storeGroup(c, ediInterchangeId, groupIndex, group, separators, scope) {
    const groupSeqId = String(groupIndex + 1).padStart(2, "0")
    const errorCode = groupErrorCode(group, c)
    call("create#" + E.GROUP, {
        ediInterchangeId,
        groupSeqId,
        functionalIdCode: el(group.gs, 1),
        controlNumber: el(group.gs, 6),
        versionCode: el(group.gs, 8),
        appSenderCode: el(group.gs, 2),
        appReceiverCode: el(group.gs, 3),
        groupDate: x12Stamp(el(group.gs, 4), el(group.gs, 5)),
        includedCount: group.ge && x.isN(el(group.ge, 1)) ? Number(el(group.ge, 1)) : null,
        receivedCount: group.transactions.length,
        groupErrorCode: errorCode
    })
    const seen = new Set()
    for (const tx of group.transactions) {
        const txCode = errorCode ? null : transactionErrorCode(tx, group, seen, c)
        seen.add(el(tx.st, 2))
        const documentText = tx.segments.map(segment => segment.text + separators.segment).join("")
        const rejected = errorCode || txCode
        call("create#" + E.DOCUMENT, {
            directionEnumId: IN,
            ediInterchangeId,
            groupSeqId,
            systemMessageId: scope.systemMessageId,
            systemMessageRemoteId: scope.systemMessageRemoteId,
            organizationPartyId: c.organizationPartyId,
            partnerPartyId: c.partnerPartyId,
            usageCode: c.usageCode,
            transactionSetId: el(tx.st, 1),
            controlNumber: el(tx.st, 2),
            statusId: rejected ? "EdocRejected" : "EdocStored",
            reasonCode: errorCode ? groupReasons[errorCode] : txCode ? transactionReasons[txCode] : null,
            eventDate: ec.user.nowTimestamp,
            documentText,
            documentData: x.json({separators, validation: rejected ? {ak5: "R", codes: txCode ? [txCode] : [], ak3: []} : null})
        })
    }
}

// ---- validation ----

// The sample profile's element rules for the documents taken, by segment: [position, type, min, max, required, codes].
// Codes are the profile's supported subset (its implementation guide), not X12's whole code list; a code outside it is
// an invalid code (AK403 7). Types: AN text, ID code, N0 integer, R decimal, N2 two implied decimals, DT date, TM time.
function rulesFor(set, c) {
    const keys = codeType => Object.keys(x.codes(c, codeType))
    if (set === "850")
        return {
            BEG: [
                [1, "ID", 2, 2, true, ["00"]],
                [2, "ID", 2, 2, true, ["SA", "NE"]],
                [3, "AN", 1, 22, true],
                [4, "AN", 1, 30, false],
                [5, "DT", 8, 8, true]
            ],
            CUR: [
                [1, "ID", 2, 3, true, ["BY", "SE"]],
                [2, "ID", 3, 3, true]
            ],
            REF: [
                [1, "ID", 2, 3, true],
                [2, "AN", 1, 30, false]
            ],
            DTM: [
                [1, "ID", 3, 3, true, ["001", "002", "010", "037", "038"]],
                [2, "DT", 8, 8, true]
            ],
            N1: [
                [1, "ID", 2, 3, true, ["ST", "BT", "BY", "VN", "SF"]],
                [2, "AN", 1, 60, false],
                [3, "ID", 1, 2, false, ["1", "9", "91", "92", "UL"]],
                [4, "AN", 2, 80, false]
            ],
            N3: [
                [1, "AN", 1, 55, true],
                [2, "AN", 1, 55, false]
            ],
            N4: [
                [1, "AN", 2, 30, false],
                [2, "ID", 2, 2, false],
                [3, "ID", 3, 15, false],
                [4, "ID", 2, 3, false]
            ],
            PO1: [
                [1, "AN", 1, 20, true],
                [2, "R", 1, 15, true],
                [3, "ID", 2, 2, true, keys("EdctUom")],
                [4, "R", 1, 17, true],
                [5, "ID", 2, 2, false, ["PE"]]
            ],
            PID: [
                [1, "ID", 1, 1, true, ["F"]],
                [5, "AN", 1, 80, false]
            ],
            SAC: [
                [1, "ID", 1, 1, true, ["A", "C"]],
                [2, "ID", 4, 4, true, keys("EdctCharge")],
                [5, "N2", 1, 15, false],
                [12, "ID", 2, 2, false, ["02", "06"]],
                [15, "AN", 1, 80, false]
            ],
            CTT: [
                [1, "N0", 1, 6, true],
                [2, "R", 1, 10, false]
            ],
            AMT: [
                [1, "ID", 1, 3, true, ["TT"]],
                [2, "R", 1, 18, true]
            ],
            N9: [
                [1, "ID", 2, 3, true],
                [2, "AN", 1, 30, false]
            ],
            MSG: [[1, "AN", 1, 264, true]]
        }
    if (set === "997")
        return {
            AK1: [
                [1, "ID", 2, 2, true, ["PR", "SH", "IN"]],
                [2, "N0", 1, 9, true]
            ],
            AK2: [
                [1, "ID", 3, 3, true, ["855", "856", "810"]],
                [2, "AN", 4, 9, true]
            ],
            AK5: [[1, "ID", 1, 1, true, ["A", "E", "R"]]],
            AK9: [
                [1, "ID", 1, 1, true, ["A", "E", "P", "R"]],
                [2, "N0", 1, 6, true],
                [3, "N0", 1, 6, true],
                [4, "N0", 1, 6, true]
            ]
        }
    return {}
}
function elementError(rule, value) {
    const [, type, min, max, required, allowed] = rule
    if (value === "") return required ? "MANDATORY_MISSING" : null
    if (type === "DT") return x.validDate(value) && value.length >= min && value.length <= max ? null : "INVALID_DATE"
    if (type === "TM") return x.validTime(value) ? null : "INVALID_TIME"
    if (type === "N0" || type === "N2") {
        if (!x.isN(value)) return "INVALID_CHAR"
    } else if (type === "R") {
        if (!x.isR(value)) return "INVALID_CHAR"
    } else if (/[\u0000-\u001f]/.test(value)) return "INVALID_CHAR"
    const length = type === "R" || type === "N0" || type === "N2" ? value.replace(/[-.]/g, "").length : value.length
    if (length < min) return "TOO_SHORT"
    if (length > max) return "TOO_LONG"
    if (allowed && !allowed.includes(value)) return "INVALID_CODE"
    return null
}
// A segment error map EdiHandler.makeAk3 reads.
function segmentError(segment, position, errorType, elementErrors = []) {
    return {
        errorType,
        segmentIndex: position - 1,
        positionInTxSet: position,
        segmentId: segment.id,
        segmentText: "",
        elementErrors
    }
}
// The element rules on each segment of the document, and the pairs the profile reads together.
function elementErrors(set, segments, c) {
    const rules = rulesFor(set, c)
    const qualifiers = x.codes(c, "EdctProductId")
    const errors = []
    segments.forEach((segment, index) => {
        const segmentRules = rules[segment.id]
        if (!segmentRules) return
        const found = []
        for (const rule of segmentRules) {
            const value = el(segment, rule[0])
            const kind = elementError(rule, value)
            if (kind)
                found.push({errorType: kind, elementPosition: rule[0], compositePosition: null, elementText: value.slice(0, 99)})
        }
        // N103 and N104 come together (X12 P0304).
        if (segment.id === "N1" && blank(el(segment, 3)) !== blank(el(segment, 4)))
            found.push({
                errorType: "CONDITIONAL_REQUIRED_MISSING",
                elementPosition: blank(el(segment, 3)) ? 3 : 4,
                compositePosition: null,
                elementText: ""
            })
        // PO106..PO125: a qualifier the profile knows with its ID.
        if (segment.id === "PO1") {
            for (let position = 6; position < Math.max(segment.elements.length, 7); position += 2) {
                const qualifier = el(segment, position)
                const value = el(segment, position + 1)
                if (blank(qualifier) && blank(value)) continue
                if (blank(qualifier) || blank(value))
                    found.push({
                        errorType: "CONDITIONAL_REQUIRED_MISSING",
                        elementPosition: blank(qualifier) ? position : position + 1,
                        compositePosition: null,
                        elementText: ""
                    })
                else if (!qualifiers[qualifier])
                    found.push({
                        errorType: "INVALID_CODE",
                        elementPosition: position,
                        compositePosition: null,
                        elementText: qualifier
                    })
            }
        }
        if (segment.id === "SAC" && blank(el(segment, 5)))
            found.push({errorType: "MANDATORY_MISSING", elementPosition: 5, compositePosition: null, elementText: ""})
        if (found.length) errors.push(segmentError(segment, index + 1, "ELEMENT_ERRORS", found))
    })
    return errors
}
// The 850's control totals: CTT01 the PO1 count, CTT02 the sum of PO102, AMT*TT the lines and charges less allowances.
function totalErrors(set, segments, st, c) {
    if (set !== "850" || !st) return []
    const errors = []
    const ctt = x.kids(st, "CTT")[0]
    const positionOf = id => segments.findIndex(segment => segment.id === id) + 1
    const lines = x.kids(st, "PO1")
    const ok = value => !blank(value) && x.isR(value)
    if (ctt) {
        const count = el(ctt, 1)
        if (x.isN(count) && Number(count) !== lines.length)
            errors.push(
                segmentError({id: "CTT"}, positionOf("CTT"), "ELEMENT_ERRORS", [
                    {errorType: "INVALID_CODE", elementPosition: 1, compositePosition: null, elementText: count}
                ])
            )
        const hash = el(ctt, 2)
        if (ok(hash) && lines.every(line => ok(el(line, 2)))) {
            const sum = lines.reduce((total, line) => total.add(toDecimal(el(line, 2))), toDecimal(0))
            if (!sum.eq(toDecimal(hash)))
                errors.push(
                    segmentError({id: "CTT"}, positionOf("CTT"), "ELEMENT_ERRORS", [
                        {errorType: "INVALID_CODE", elementPosition: 2, compositePosition: null, elementText: hash}
                    ])
                )
        }
        const amt = x.kids(ctt, "AMT").find(row => el(row, 1) === "TT")
        const currencyUomId = c.store?.defaultCurrencyUomId
        if (amt && ok(el(amt, 2)) && currencyUomId && lines.every(line => ok(el(line, 2)) && ok(el(line, 4)))) {
            let total = toDecimal(0)
            const sac = row => {
                const value = el(row, 5)
                if (!x.isN(value)) return toDecimal(0)
                return el(row, 1) === "A" ? x.fromN2(value).multiply(-1) : x.fromN2(value)
            }
            for (const line of lines) {
                total = total.add(toDecimal(el(line, 2)).multiply(toDecimal(el(line, 4))))
                for (const row of x.kids(line, "SAC")) total = total.add(sac(row))
            }
            for (const row of x.kids(st, "SAC")) total = total.add(sac(row))
            const round = value => ec.l10n.roundCurrency(value, currencyUomId)
            if (!round(total).eq(round(toDecimal(el(amt, 2)))))
                errors.push(
                    segmentError(
                        {id: "AMT"},
                        segments.findIndex(segment => segment.id === "AMT" && el(segment, 1) === "TT") + 1,
                        "ELEMENT_ERRORS",
                        [{errorType: "INVALID_CODE", elementPosition: 2, compositePosition: null, elementText: el(amt, 2)}]
                    )
                )
        }
    }
    return errors
}
// validate#InboundDocument: the grammar (order, occurrences, segments the set does not define), the element rules and
// the totals. Validated, or Rejected with the AK3/AK4 its 997 reports.
function validateDocument(p) {
    const doc = find(E.DOCUMENT, {ediDocumentId: p.ediDocumentId}).forUpdate(true).one()
    if (!doc || doc.statusId !== "EdocStored") return {statusId: doc?.statusId}
    const c = x.connection(doc.systemMessageRemoteId)
    const pdoc = x.profileDocument(c, doc.transactionSetId, IN)
    const data = x.parseJson(doc.documentData)
    if (!pdoc) return reject(doc, data, "1", [], "UNSUPPORTED_DOCUMENT")
    const separators = data.separators
    const parsed = x.parseSet(doc.documentText, separators, pdoc.grammarLocation)
    const segments = x.segmentsOf(doc.documentText, separators)
    const errors = parsed.errors
        .concat(elementErrors(doc.transactionSetId, segments, c))
        .concat(totalErrors(doc.transactionSetId, segments, parsed.st, c))
    if (errors.length) return reject(doc, data, "5", errors, "SYNTAX_ERRORS")
    data.validation = {ak5: "A", codes: [], ak3: []}
    call("update#" + E.DOCUMENT, {ediDocumentId: doc.ediDocumentId, statusId: "EdocValidated", documentData: x.json(data)})
    return {statusId: "EdocValidated"}
}
function reject(doc, data, code, errors, reasonCode) {
    data.validation = {ak5: "R", codes: [code], ak3: errors}
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocRejected",
        reasonCode,
        errorText: x.clip(
            errors.map(error => error.segmentId + "@" + error.positionInTxSet + " " + error.errorType).join(", "),
            2000
        ),
        documentData: x.json(data)
    })
    return {statusId: "EdocRejected"}
}

// ---- functional acknowledgments ----

// record#GroupAcknowledgment: the 997 this side owes a received group, once its documents are validated. None for a 997
// group (acknowledgments are never acknowledged) or when the profile does not send them.
function recordGroupAck(p) {
    const group = find(E.GROUP, {ediInterchangeId: p.ediInterchangeId, groupSeqId: p.groupSeqId}).forUpdate(true).one()
    if (!group || group.ackDocumentId || group.functionalIdCode === "FA") return {}
    const ic = one(E.INTERCHANGE, {ediInterchangeId: p.ediInterchangeId})
    const c = x.connection(ic.systemMessageRemoteId)
    if (!c || c.profile?.generateFunctionalAck !== "Y" || !x.profileDocument(c, "997", OUT)) return {}
    const docs = rows(E.DOCUMENT, {ediInterchangeId: p.ediInterchangeId, groupSeqId: p.groupSeqId, directionEnumId: IN})
    if (docs.some(doc => doc.statusId === "EdocStored")) return {waiting: true}
    const accepted = docs.filter(doc => doc.statusId !== "EdocRejected").length
    const ackCode = group.groupErrorCode || !accepted ? "R" : accepted === docs.length ? "A" : "P"
    const ediDocumentId = call("create#" + E.DOCUMENT, {
        directionEnumId: OUT,
        systemMessageRemoteId: c.systemMessageRemoteId,
        organizationPartyId: c.organizationPartyId,
        partnerPartyId: c.partnerPartyId,
        usageCode: c.usageCode,
        transactionSetId: "997",
        statusId: "EdocPending",
        documentRevision: 1,
        businessKey: "FA " + group.functionalIdCode + " " + group.controlNumber + " of " + ic.controlNumber,
        ackedInterchangeId: p.ediInterchangeId,
        ackedGroupSeqId: p.groupSeqId,
        eventDate: ec.user.nowTimestamp
    }).ediDocumentId
    call("update#" + E.GROUP, {
        ediInterchangeId: p.ediInterchangeId,
        groupSeqId: p.groupSeqId,
        ackCode,
        acceptedCount: accepted,
        ackDocumentId: ediDocumentId,
        ackDate: ec.user.nowTimestamp
    })
    return {ediDocumentId}
}
// produce#FunctionalAck: the body of a 997 for the group it acknowledges, from its documents' validation: AK1, an AK2
// with its AK3/AK4 and AK5 for each set (none when the group is rejected as a whole), and AK9.
function functionalAckBody(p) {
    const doc = one(E.DOCUMENT, {ediDocumentId: p.ediDocumentId})
    const group = one(E.GROUP, {ediInterchangeId: doc.ackedInterchangeId, groupSeqId: doc.ackedGroupSeqId})
    if (!group) denied("RECORD_UNAVAILABLE", "No group to acknowledge for " + p.ediDocumentId)
    const docs = rows(E.DOCUMENT, {
        ediInterchangeId: group.ediInterchangeId,
        groupSeqId: group.groupSeqId,
        directionEnumId: IN
    }).sort((a, b) => String(a.ediDocumentId).localeCompare(String(b.ediDocumentId)))
    const body = {AK1: [{elements: ["AK1", group.functionalIdCode, group.controlNumber]}]}
    let accepted = 0
    if (!group.groupErrorCode) {
        body.AK2 = docs.map(row => {
            const validation = x.parseJson(row.documentData).validation || {ak5: "R", codes: [], ak3: []}
            const rejected = row.statusId === "EdocRejected" || validation.ak5 === "R"
            if (!rejected) accepted++
            const ak2 = {elements: ["AK2", row.transactionSetId, row.controlNumber]}
            if (rejected && validation.ak3?.length) ak2.AK3 = validation.ak3.map(error => EdiHandler.makeAk3(error))
            ak2.AK5 = [{elements: ["AK5", rejected ? "R" : "A"].concat(rejected ? (validation.codes || []).slice(0, 5) : [])}]
            return ak2
        })
    }
    const ackCode = group.groupErrorCode || !accepted ? "R" : accepted === docs.length ? "A" : "P"
    const included = group.includedCount ?? docs.length
    const ak9 = ["AK9", ackCode, String(included), String(docs.length), String(accepted)]
    if (group.groupErrorCode) ak9.push(group.groupErrorCode)
    body.AK9 = [{elements: ak9}]
    return {bodyEdiMap: body}
}
// apply#FunctionalAck: a 997 the partner sent for one of this side's groups. Its AK5s (or AK9 for the sets it does not
// list) accept or reject the documents sent; nothing is acknowledged back.
function applyFunctionalAck(p) {
    const doc = find(E.DOCUMENT, {ediDocumentId: p.ediDocumentId}).forUpdate(true).one()
    const data = x.parseJson(doc.documentData)
    const parsed = x.parseSet(
        doc.documentText,
        data.separators,
        x.profileDocument(x.connection(doc.systemMessageRemoteId), "997", IN).grammarLocation
    )
    const ak1 = x.kids(parsed.st, "AK1")[0]
    const ak9 = x.kids(parsed.st, "AK9")[0]
    // GS06 is stored as sent (no leading zeros); the partner's AK102 is read as a number. One query for the candidates'
    // interchanges, which must be this side's to this partner in this environment.
    const groupControl = x.isN(el(ak1, 2)) ? String(Number(el(ak1, 2))) : el(ak1, 2)
    const candidates = rows(E.GROUP, {functionalIdCode: el(ak1, 1), controlNumber: groupControl})
    const ours = candidates.length
        ? new Set(
              Array.from(
                  find(E.INTERCHANGE, {
                      directionEnumId: OUT,
                      organizationPartyId: doc.organizationPartyId,
                      partnerPartyId: doc.partnerPartyId,
                      usageCode: doc.usageCode
                  })
                      .condition(
                          "ediInterchangeId",
                          "in",
                          candidates.map(group => group.ediInterchangeId)
                      )
                      .list()
              ).map(row => row.ediInterchangeId)
          )
        : new Set()
    const groups = candidates.filter(group => ours.has(group.ediInterchangeId))
    if (groups.length !== 1) denied("ACK_UNMATCHED", "No group " + el(ak1, 1) + " " + el(ak1, 2) + " was sent to this partner")
    const group = groups[0]
    const sent = rows(E.DOCUMENT, {ediInterchangeId: group.ediInterchangeId, groupSeqId: group.groupSeqId, directionEnumId: OUT})
    const listed = {}
    for (const ak2 of x.kids(parsed.st, "AK2")) {
        const ak5 = x.kids(ak2, "AK5")[0]
        listed[Number(el(ak2, 2))] = {
            set: el(ak2, 1),
            code: el(ak5, 1),
            reasons: (ak5?.elements || []).slice(2).map(String).filter(Boolean)
        }
    }
    for (const control of Object.keys(listed))
        if (!sent.some(row => Number(row.controlNumber) === Number(control)))
            denied("ACK_UNMATCHED", "Set " + control + " was not sent in group " + el(ak1, 2))
    const groupCode = el(ak9, 1)
    let rejected = 0
    for (const row of sent) {
        const outcome = listed[Number(row.controlNumber)]
        const code = outcome ? outcome.code : groupCode === "R" ? "R" : "A"
        const accepted = code === "A" || code === "E"
        if (!accepted) rejected++
        call("update#" + E.DOCUMENT, {
            ediDocumentId: row.ediDocumentId,
            statusId: accepted ? "EdocAccepted" : "EdocAckRejected",
            reasonCode: accepted ? null : "ACK_REJECTED",
            errorText: accepted
                ? null
                : "The partner's 997 rejected it" + (outcome?.reasons.length ? " (AK5 " + outcome.reasons.join(",") + ")" : ""),
            ackCode: code,
            ackDocumentId: doc.ediDocumentId,
            ackDate: ec.user.nowTimestamp
        })
        const message = row.systemMessageId ? one(E.MESSAGE, {systemMessageId: row.systemMessageId}) : null
        if (message?.statusId === "SmsgSent")
            call("update#" + E.MESSAGE, {
                systemMessageId: message.systemMessageId,
                statusId: accepted ? "SmsgConfirmed" : "SmsgRejected"
            })
    }
    call("update#" + E.GROUP, {
        ediInterchangeId: group.ediInterchangeId,
        groupSeqId: group.groupSeqId,
        ackCode: groupCode,
        ackDocumentId: doc.ediDocumentId,
        ackDate: ec.user.nowTimestamp
    })
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocApplied",
        businessKey: "FA " + el(ak1, 1) + " " + el(ak1, 2)
    })
    return {rejectedCount: rejected}
}

// apply#InboundDocument: the profile's mapping service for the document, which applies it through Mantle's services and
// sets its status. The connection is locked so two deliveries of one business document are applied one after the other.
function applyInbound(p) {
    const doc = one(E.DOCUMENT, {ediDocumentId: p.ediDocumentId})
    if (!doc || !["EdocValidated", "EdocException"].includes(doc.statusId)) return {statusId: doc?.statusId}
    find(E.CONNECTION, {systemMessageRemoteId: doc.systemMessageRemoteId}).forUpdate(true).one()
    const c = x.connection(doc.systemMessageRemoteId)
    const pdoc = x.profileDocument(c, doc.transactionSetId, IN)
    if (!pdoc?.mappingServiceName) denied("UNSUPPORTED_DOCUMENT", "The profile has no mapping for " + doc.transactionSetId)
    call(pdoc.mappingServiceName, {ediDocumentId: doc.ediDocumentId})
    return {statusId: one(E.DOCUMENT, {ediDocumentId: doc.ediDocumentId}).statusId}
}
// record#InboundException: a received document that its mapping refused or failed on, with the reason.
function recordException(p) {
    const doc = one(E.DOCUMENT, {ediDocumentId: p.ediDocumentId})
    if (!doc || !["EdocValidated", "EdocException"].includes(doc.statusId)) return {}
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocException",
        reasonCode: p.reasonCode,
        errorText: p.errorText
    })
    return {}
}

// ---- documents sent ----

// Record a document to send for a business record, in its business transaction: the next revision for the record and
// set, with an older one not produced yet superseded; sent after the commit unless the connection batches.
function recordEvent(c, transactionSetId, keys, businessKey) {
    const previous = rows(
        E.DOCUMENT,
        Object.assign({directionEnumId: OUT, transactionSetId, systemMessageRemoteId: c.systemMessageRemoteId}, keys)
    )
    const revision = previous.reduce((max, row) => Math.max(max, Number(row.documentRevision) || 0), 0) + 1
    // Locked and read again: the send job may be producing one now (it holds the lock), and once it is Produced it is
    // sent as it is, before this revision.
    for (const row of previous.filter(row => row.statusId === "EdocPending" || row.statusId === "EdocRefused")) {
        const locked = find(E.DOCUMENT, {ediDocumentId: row.ediDocumentId}).forUpdate(true).one()
        if (locked && (locked.statusId === "EdocPending" || locked.statusId === "EdocRefused"))
            call("update#" + E.DOCUMENT, {ediDocumentId: row.ediDocumentId, statusId: "EdocSuperseded"})
    }
    const ediDocumentId = call(
        "create#" + E.DOCUMENT,
        Object.assign(
            {
                directionEnumId: OUT,
                systemMessageRemoteId: c.systemMessageRemoteId,
                organizationPartyId: c.organizationPartyId,
                partnerPartyId: c.partnerPartyId,
                usageCode: c.usageCode,
                transactionSetId,
                statusId: "EdocPending",
                documentRevision: revision,
                purposeCode: revision > 1 ? "05" : "00",
                businessKey,
                eventDate: ec.user.nowTimestamp
            },
            keys
        )
    ).ediDocumentId
    if (c.conn.sendOnCommit !== "N") {
        try {
            ec.service
                .special()
                .name(SERVICES + "send#PendingDocuments")
                .parameters({ediDocumentIdList: [ediDocumentId]})
                .registerOnCommit()
        } catch (error) {
            ec.logger.warn(
                "X12 document " + ediDocumentId + " not queued after commit; the send job sends it: " + x.codeOf(error)
            )
        }
    }
    return {ediDocumentId}
}
// record#OrderAcknowledgment: an 855 for an EDI order's decision (approved, cancelled or rejected).
function recordOrderAck(p) {
    const order = one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (!order || !["OrderApproved", "OrderCancelled", "OrderRejected"].includes(order.statusId)) return {}
    const po = x.purchaseOrderOf(p.orderId)
    const c = po ? x.connection(po.systemMessageRemoteId) : null
    if (!c || !x.profileDocument(c, "855", OUT)) return {}
    return recordEvent(c, "855", {orderId: p.orderId}, po.businessKey)
}
// record#ShipNotice: an 856 for a shipped shipment of EDI orders, one per connection of its orders.
function recordShipNotice(p) {
    const orderIds = [
        ...new Set(
            rows("mantle.shipment.ShipmentItemSource", {shipmentId: p.shipmentId})
                .map(row => row.orderId)
                .filter(Boolean)
        )
    ]
    const out = []
    const done = new Set()
    for (const orderId of orderIds) {
        const po = x.purchaseOrderOf(orderId)
        if (!po || done.has(po.systemMessageRemoteId)) continue
        done.add(po.systemMessageRemoteId)
        const c = x.connection(po.systemMessageRemoteId)
        if (c && x.profileDocument(c, "856", OUT))
            out.push(recordEvent(c, "856", {shipmentId: p.shipmentId}, "ASN " + p.shipmentId).ediDocumentId)
    }
    return {ediDocumentIdList: out}
}
// record#InvoiceDocument: an 810 for a sales invoice of an EDI order reaching the profile's billing status.
function recordInvoice(p) {
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId: p.invoiceId})
    if (!invoice) return {}
    const orderIds = [...new Set(rows("mantle.order.OrderItemBilling", {invoiceId: p.invoiceId}).map(row => row.orderId))]
    for (const orderId of orderIds) {
        const po = x.purchaseOrderOf(orderId)
        const c = po ? x.connection(po.systemMessageRemoteId) : null
        if (!c || !x.profileDocument(c, "810", OUT) || c.profile.invoiceStatusId !== invoice.statusId) continue
        return recordEvent(c, "810", {invoiceId: p.invoiceId}, "INV " + p.invoiceId)
    }
    return {}
}

// The next control number at a level for the connection's scope, under the sequence row's lock.
function nextControl(c, controlLevel, max) {
    const keys = {
        organizationPartyId: c.organizationPartyId,
        partnerPartyId: c.partnerPartyId,
        usageCode: c.usageCode || "_",
        directionEnumId: OUT,
        controlLevel
    }
    // The scope's first allocation makes its row in a transaction of its own, so two first allocations at once do not
    // both create it (one finds the other's); every allocation then takes the row's lock.
    if (!one(E.CONTROL, keys)) {
        try {
            probe("create#" + E.CONTROL, Object.assign({}, keys, {lastNumber: 0}))
        } catch (error) {
            ec.logger.info("X12 control sequence " + controlLevel + " made by another allocation: " + x.codeOf(error))
        }
    }
    const row = find(E.CONTROL, keys).forUpdate(true).one()
    if (!row) denied("CONTROL_UNAVAILABLE", "No control sequence " + controlLevel + " for the connection's scope")
    let next = (Number(row.lastNumber) || 0) + 1
    if (next > max) next = 1
    call("update#" + E.CONTROL, Object.assign({}, keys, {lastNumber: next}))
    return next
}
// The first element value of a body that holds a separator, terminator or NUL, as text, or null. X12 has no release
// character, so such a value would end its element or segment in the partner's parse.
function separatorIn(body, separators) {
    const bad = [separators.segment, separators.element, separators.component, "\u0000"]
    let found = null
    const visit = (segment, id) => {
        if (found || !segment || typeof segment !== "object") return
        for (const [key, value] of Object.entries(segment)) {
            if (key === "elements") {
                Array.from(value || []).forEach((element, index) => {
                    const parts = Array.isArray(element) ? element : [element]
                    for (const part of parts)
                        if (!found && part != null && bad.some(ch => String(part).includes(ch)))
                            found = "Element " + id + String(index).padStart(2, "0") + " holds a separator: " + x.clip(part, 40)
                })
            } else for (const child of Array.from(value || [])) visit(child, key)
        }
    }
    for (const [key, list] of Object.entries(body || {})) for (const segment of Array.from(list || [])) visit(segment, key)
    return found
}
// What the connection's remote gives the ISA and GS that does not fit their fixed or bounded widths, or null.
function envelopeFieldProblem(remote) {
    const checks = [
        ["internalIdType", 2, 2],
        ["remoteIdType", 2, 2],
        ["internalId", 1, 15],
        ["remoteId", 1, 15],
        ["ackRequested", 0, 1],
        ["internalAppCode", 0, 15],
        ["remoteAppCode", 0, 15]
    ]
    for (const [field, min, max] of checks) {
        const value = String(remote[field] ?? "")
        if (value.length < min || value.length > max)
            return "The remote's " + field + " must be " + min + " to " + max + " characters"
        if (/[^\x20-\x7e]/.test(value)) return "The remote's " + field + " has a character X12 does not take"
    }
    if (remote.ackRequested && !["0", "1"].includes(remote.ackRequested)) return "The remote's ackRequested must be 0 or 1"
    return null
}
// produce#Document: a pending document's body from its profile's mapping service (in a transaction of its own, so a
// refusal leaves nothing), checked on its grammar, in an envelope with controls allocated now, kept with its outgoing
// SystemMessage in this one transaction. A refusal is recorded (Refused) and nothing is sent.
function produceDocument(p) {
    const doc = find(E.DOCUMENT, {ediDocumentId: p.ediDocumentId}).forUpdate(true).one()
    if (!doc || doc.statusId !== "EdocPending") return {statusId: doc?.statusId}
    const c = x.connection(doc.systemMessageRemoteId)
    const pdoc = x.profileDocument(c, doc.transactionSetId, OUT)
    const refuse = (reasonCode, message) => {
        call("update#" + E.DOCUMENT, {
            ediDocumentId: doc.ediDocumentId,
            statusId: "EdocRefused",
            reasonCode,
            errorText: x.clip(message, 2000)
        })
        ec.logger.warn("X12 " + doc.transactionSetId + " document " + doc.ediDocumentId + " refused: " + reasonCode)
        return {statusId: "EdocRefused", reasonCode}
    }
    if (!c || !c.organizationPartyId || !c.partnerPartyId)
        return refuse("CONFIG_INVALID", "The connection has no organization or partner")
    const ids = ["internalIdType", "internalId", "remoteIdType", "remoteId"]
    if (ids.some(field => blank(c.remote[field])) || !["T", "P"].includes(c.remote.usageCode))
        return refuse(
            "CONFIG_INVALID",
            "The connection's remote needs its interchange IDs and qualifiers and a usage code T or P"
        )
    if (!pdoc?.mappingServiceName) return refuse("UNSUPPORTED_DOCUMENT", "The profile does not send " + doc.transactionSetId)
    let body
    try {
        body = probe(pdoc.mappingServiceName, {ediDocumentId: doc.ediDocumentId}).bodyEdiMap
    } catch (error) {
        // A refusal has its reason code; anything else (a lock, a lost connection) leaves the document Pending for the
        // next run, with its error noted by the caller.
        const reasonCode = x.codeOf(error, null)
        if (!reasonCode) throw error
        return refuse(reasonCode, String(error.message ?? error))
    }
    const separators = c.separators
    const remote = c.remote
    const dataProblem = separatorIn(body, separators)
    if (dataProblem) return refuse("SEPARATOR_IN_DATA", dataProblem)
    const envelopeProblem = envelopeFieldProblem(remote)
    if (envelopeProblem) return refuse("CONFIG_INVALID", envelopeProblem)
    const now = ec.user.nowTimestamp
    const isaControl = String(nextControl(c, "ISA", 999999999)).padStart(9, "0")
    const gsControl = String(nextControl(c, "GS", 999999999))
    const stControl = "0001"
    const functionalId = pdoc.functionalIdCode || FUNCTIONAL_ID[doc.transactionSetId]
    const edi = new EdiHandler(ec)
        .setChars(separators.segment, separators.element, separators.component, x.NO_ESCAPE)
        .setSegmentSuffix(null)
        .setPaddingChar(" ")
    const st = Object.assign({elements: ["ST", doc.transactionSetId, stControl]}, body)
    st.SE = [{elements: ["SE", String(edi.countSegments(st) + 2), stControl]}]
    const documentText = edi.generateText({ST: [st]})
    // The body is checked on the set's grammar, so a mapping's mistake is refused rather than sent.
    const check = x.parseSet(documentText, separators, pdoc.grammarLocation)
    if (check.errors.length)
        return refuse(
            "GENERATED_INVALID",
            check.errors.map(error => error.segmentId + "@" + error.positionInTxSet + " " + error.errorType).join(", ")
        )
    const version = c.profile.x12Version
    const isa = [
        "ISA",
        "00",
        "",
        "00",
        "",
        remote.internalIdType,
        remote.internalId,
        remote.remoteIdType,
        remote.remoteId,
        x.x12Date(now, "yyMMdd"),
        x.x12Date(now, "HHmm"),
        "U",
        x.ISA_VERSION,
        isaControl,
        remote.ackRequested || "0",
        remote.usageCode,
        separators.component
    ]
    const gs = [
        "GS",
        functionalId,
        remote.internalAppCode || remote.internalId || "",
        remote.remoteAppCode || remote.remoteId || "",
        x.x12Date(now, "yyyyMMdd"),
        x.x12Date(now, "HHmm"),
        gsControl,
        "X",
        version
    ]
    const messageText = edi.generateText({
        ISA: [
            {
                elements: isa,
                GS: [{elements: gs, ST: [st], GE: [{elements: ["GE", "1", gsControl]}]}],
                IEA: [{elements: ["IEA", "1", isaControl]}]
            }
        ]
    })
    // The ISA is fixed width; a value that does not fit is caught above, and this is the last guard before sending.
    if (messageText.indexOf(separators.segment) !== 105 || messageText[104] !== separators.component)
        throw new Error("X12 document " + doc.ediDocumentId + " generated an ISA that is not 106 characters")
    const systemMessageId = call("create#" + E.MESSAGE, {
        systemMessageTypeId: remote.systemMessageTypeId || "EdiX12",
        systemMessageRemoteId: c.systemMessageRemoteId,
        statusId: "SmsgProduced",
        isOutgoing: "Y",
        initDate: now,
        messageText,
        senderId: remote.internalId,
        receiverId: remote.remoteId,
        messageId: isaControl,
        messageDate: now,
        docType: functionalId,
        docSubType: doc.transactionSetId,
        docControl: gsControl,
        docSubControl: stControl,
        docVersion: version,
        orderId: doc.orderId,
        shipmentId: doc.shipmentId,
        invoiceId: doc.invoiceId
    }).systemMessageId
    const ediInterchangeId = call("create#" + E.INTERCHANGE, {
        directionEnumId: OUT,
        systemMessageId,
        receiptSeq: 1,
        systemMessageRemoteId: c.systemMessageRemoteId,
        organizationPartyId: c.organizationPartyId,
        partnerPartyId: c.partnerPartyId,
        usageCode: c.usageCode,
        senderQualifier: isa[5],
        senderId: isa[6],
        receiverQualifier: isa[7],
        receiverId: isa[8],
        controlNumber: isaControl,
        versionCode: x.ISA_VERSION,
        interchangeDate: now,
        statusId: "EdinProduced"
    }).ediInterchangeId
    call("create#" + E.GROUP, {
        ediInterchangeId,
        groupSeqId: "01",
        functionalIdCode: functionalId,
        controlNumber: gsControl,
        versionCode: version,
        appSenderCode: gs[2],
        appReceiverCode: gs[3],
        groupDate: now,
        includedCount: 1
    })
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocProduced",
        ediInterchangeId,
        groupSeqId: "01",
        controlNumber: stControl,
        systemMessageId,
        documentText,
        contentHash: ec.user.singleUseCodeHash(
            documentText.slice(documentText.indexOf(separators.segment) + 1, documentText.lastIndexOf("SE" + separators.element))
        ),
        producedDate: now
    })
    return {statusId: "EdocProduced", systemMessageId}
}
// send#PendingDocuments: produce the pending documents (those given, else the oldest), each in a transaction of its own,
// then send each produced document's message and record it Sent. A document whose production failed stays Pending and
// one whose send failed stays Produced, both with their identity, for the next run.
function sendPending(p) {
    const limit = Math.max(1, Math.min(500, Number(p.limit) || 100))
    const given = p.ediDocumentIdList ? Array.from(p.ediDocumentIdList).map(String) : null
    const pending =
        given ||
        Array.from(
            find(E.DOCUMENT, {directionEnumId: OUT, statusId: "EdocPending"}).orderBy("eventDate").limit(limit).list()
        ).map(row => row.ediDocumentId)
    let produced = 0,
        sent = 0
    for (const ediDocumentId of pending) {
        try {
            if (probe(SERVICES + "produce#Document", {ediDocumentId}).statusId === "EdocProduced") produced++
        } catch (error) {
            ec.logger.error("X12 document " + ediDocumentId + " not produced, left Pending: " + x.codeOf(error))
            note(ediDocumentId, error)
        }
    }
    const toSend = given
        ? given.map(id => one(E.DOCUMENT, {ediDocumentId: id})).filter(row => row?.statusId === "EdocProduced")
        : Array.from(
              find(E.DOCUMENT, {directionEnumId: OUT, statusId: "EdocProduced"}).orderBy("producedDate").limit(limit).list()
          )
    for (const doc of toSend) {
        try {
            let message = one(E.MESSAGE, {systemMessageId: doc.systemMessageId})
            if (message?.statusId === "SmsgProduced")
                call(SYSTEM_MESSAGE + "send#ProducedSystemMessage", {systemMessageId: doc.systemMessageId, willRetry: true})
            message = one(E.MESSAGE, {systemMessageId: doc.systemMessageId})
            if (["SmsgSent", "SmsgConfirmed", "SmsgRejected"].includes(message?.statusId)) {
                probe(SERVICES + "record#DocumentSent", {ediDocumentId: doc.ediDocumentId})
                sent++
            }
        } catch (error) {
            ec.logger.error("X12 document " + doc.ediDocumentId + " not sent, left Produced: " + x.codeOf(error))
        }
    }
    return {producedCount: produced, sentCount: sent}
}
function recordSent(p) {
    const doc = find(E.DOCUMENT, {ediDocumentId: p.ediDocumentId}).forUpdate(true).one()
    if (doc?.statusId !== "EdocProduced") return {}
    const message = one(E.MESSAGE, {systemMessageId: doc.systemMessageId})
    call("update#" + E.DOCUMENT, {
        ediDocumentId: doc.ediDocumentId,
        statusId: "EdocSent",
        sentDate: message?.processedDate || ec.user.nowTimestamp
    })
    return {}
}

// retry#Document: an operator's retry with the document's identity kept: a received document in exception is applied
// again (after its mapping was fixed), a refused one sent is produced again, a produced one whose message is in error is
// sent again with the same bytes. Needs EDI_ADMIN, unless a caller that checked its own permission and scope calls it
// through storeRetry (Commerce's channel operator for a store's partner, StoreChannels.js).
function retry(p, checked = false) {
    if (!checked && !ec.user.hasPermission("EDI_ADMIN")) denied("PERMISSION_DENIED", "Retrying an EDI document needs EDI_ADMIN")
    const doc = one(E.DOCUMENT, {ediDocumentId: p.ediDocumentId})
    if (!doc) denied("RECORD_UNAVAILABLE", "No EDI document " + p.ediDocumentId)
    if (doc.directionEnumId === IN && doc.statusId === "EdocException") {
        applyOrRecord(doc.ediDocumentId)
        return {statusId: one(E.DOCUMENT, {ediDocumentId: doc.ediDocumentId}).statusId}
    }
    if (doc.directionEnumId === OUT && doc.statusId === "EdocRefused") {
        probe("update#" + E.DOCUMENT, {
            ediDocumentId: doc.ediDocumentId,
            statusId: "EdocPending",
            reasonCode: null,
            errorText: null
        })
        sendPending({ediDocumentIdList: [doc.ediDocumentId]})
        return {statusId: one(E.DOCUMENT, {ediDocumentId: doc.ediDocumentId}).statusId}
    }
    // A produced document whose message the framework gave up on (SmsgError after its retries): the same message, bytes
    // and controls are sent again.
    const message = doc.systemMessageId ? one(E.MESSAGE, {systemMessageId: doc.systemMessageId}) : null
    if (doc.directionEnumId === OUT && doc.statusId === "EdocProduced" && message?.statusId === "SmsgError") {
        probe(SYSTEM_MESSAGE + "reset#SystemMessageInError", {systemMessageId: message.systemMessageId})
        sendPending({ediDocumentIdList: [doc.ediDocumentId]})
        return {statusId: one(E.DOCUMENT, {ediDocumentId: doc.ediDocumentId}).statusId}
    }
    denied("NOT_RETRYABLE", "Document " + doc.ediDocumentId + " in " + doc.statusId + " is not retried")
}
// A timestamp minutes before now, for a date condition.
function minutesAgo(minutes) {
    const pattern = "yyyy-MM-dd HH:mm:ss.SSS"
    return ec.l10n.parseTimestamp(ec.l10n.format(new Date(Number(ec.user.nowTimestamp) - minutes * 60000), pattern), pattern)
}
// find#OverdueAcknowledgments: per connection whose profile expects 997s, the documents sent (not 997s) longer ago than
// its ackOverdueMinutes with no acknowledgment, found in the query; and the documents sent that are stuck: Pending or
// Produced longer than stuckMinutes (a crash after the commit, a send that failed, a message in error) or Refused.
function overdue(p) {
    const stuckMinutes = p.stuckMinutes == null ? 60 : Number(p.stuckMinutes)
    const connections = p.systemMessageRemoteId
        ? rows(E.CONNECTION, {systemMessageRemoteId: p.systemMessageRemoteId})
        : rows(E.CONNECTION, {})
    const overdueList = []
    const stuckList = []
    for (const conn of connections) {
        const c = x.connection(conn.systemMessageRemoteId)
        if (c?.profile?.expectFunctionalAck === "Y") {
            const minutes = c.profile.ackOverdueMinutes == null ? 1440 : Number(c.profile.ackOverdueMinutes)
            const late = find(E.DOCUMENT, {
                directionEnumId: OUT,
                statusId: "EdocSent",
                systemMessageRemoteId: conn.systemMessageRemoteId
            })
                .condition("transactionSetId", "not-equals", "997")
                .condition("sentDate", "less-equals", minutesAgo(minutes))
                .orderBy("sentDate")
                .limit(500)
                .list()
            for (const doc of Array.from(late))
                overdueList.push({
                    ediDocumentId: doc.ediDocumentId,
                    transactionSetId: doc.transactionSetId,
                    businessKey: doc.businessKey,
                    sentDate: doc.sentDate
                })
        }
        const stuck = find(E.DOCUMENT, {directionEnumId: OUT, systemMessageRemoteId: conn.systemMessageRemoteId})
            .condition("statusId", "in", ["EdocPending", "EdocProduced", "EdocRefused"])
            .orderBy("eventDate")
            .limit(500)
            .list()
        const cutoff = Number(minutesAgo(stuckMinutes))
        for (const doc of Array.from(stuck)) {
            const message = doc.systemMessageId ? one(E.MESSAGE, {systemMessageId: doc.systemMessageId}) : null
            const since = lib.ms(doc.statusId === "EdocProduced" ? doc.producedDate : doc.eventDate)
            if (doc.statusId !== "EdocRefused" && message?.statusId !== "SmsgError" && since > cutoff) continue
            stuckList.push({
                ediDocumentId: doc.ediDocumentId,
                transactionSetId: doc.transactionSetId,
                statusId: doc.statusId,
                messageStatusId: message?.statusId || null,
                reasonCode: doc.reasonCode,
                businessKey: doc.businessKey
            })
        }
    }
    return {overdueList, stuckList}
}

// retry#Receipt: an operator's retry of a receipt left in error (an interchange quarantined while the connection was
// misconfigured, a document whose step could not be recorded): consumed again from its kept bytes and records, which
// re-checks its quarantined interchanges and repeats nothing done. Needs EDI_ADMIN, or storeRetry's caller's own check.
function retryReceipt(p, checked = false) {
    if (!checked && !ec.user.hasPermission("EDI_ADMIN")) denied("PERMISSION_DENIED", "Retrying an EDI receipt needs EDI_ADMIN")
    const message = one(E.MESSAGE, {systemMessageId: p.systemMessageId})
    if (!message || message.isOutgoing === "Y") denied("RECORD_UNAVAILABLE", "No EDI receipt " + p.systemMessageId)
    if (!["SmsgError", "SmsgReceived"].includes(message.statusId))
        denied("NOT_RETRYABLE", "Receipt " + p.systemMessageId + " is " + message.statusId)
    call(SYSTEM_MESSAGE + "consume#ReceivedSystemMessage", {systemMessageId: p.systemMessageId, allowError: true})
    return {statusId: one(E.MESSAGE, {systemMessageId: p.systemMessageId}).statusId}
}

const operations = {
    receive,
    consume,
    storeReceipt,
    validateDocument,
    recordGroupAck,
    functionalAckBody,
    applyFunctionalAck,
    applyInbound,
    recordException,
    recordOrderAck,
    recordShipNotice,
    recordInvoice,
    produceDocument,
    sendPending,
    recordSent,
    retry,
    retryReceipt,
    overdue
}
;({
    execute(op, input) {
        if (!operations[op]) throw new Error("Unknown X12 operation " + op)
        const was = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](input || {}) || {}
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    },
    // retry#Document and retry#Receipt for a caller that checked its own permission and the partner's scope (Commerce's
    // channel operator, StoreChannels.js retry#StoreMessage): the same retry, its identity kept; reachable from scripts
    // only, never through the services' parameters
    storeRetry(op, input) {
        const retries = {retry, retryReceipt}
        if (!retries[op]) throw new Error("Unknown X12 retry " + op)
        const was = ec.artifactExecution.disableAuthz()
        try {
            return retries[op](input || {}, true) || {}
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
})
