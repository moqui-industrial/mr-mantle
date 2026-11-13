// Authorized journal authoring and reviewed posting. Each batch constituent owns its transaction. The preview reads,
// deletes and the posted metadata correction are inline XML Actions in JournalServices.xml.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const guard = ec.resource.script("component://mr-mantle/service/mantle/ledger/PostingGuard.js")
const {call, find, one, rows, map, pick, ms, hash} = lib
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry",
    P = "mantle.ledger.transaction.JournalPreview",
    O = "mantle.ledger.transaction.PostingOperation",
    H = "mantle.ledger.transaction.AcctgTransTemplate",
    L = "mantle.ledger.transaction.AcctgTransTemplateEntry"
const transaction = (p, lock = true) =>
    lib.record(
        {
            kind: "journals",
            recordId: p.acctgTransId,
            organizationPartyId: p.organizationPartyId
        },
        "glPost",
        lock
    )
// A reviewed preview may be posted for ten minutes.
const previewExpiry = () => new Date(ms(ec.user.nowTimestamp) + 600000)
function draft(p) {
    const s = lib.organization(p, "glPost")
    const old = p.acctgTransId ? transaction(p) : null
    if (old?.isPosted === "Y") throw new Error("Posted entries are read only")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    const amountUomId = p.amountUomId || old?.amountUomId || lib.preference(s.organizationPartyId).baseCurrencyUomId
    lib.currency(amountUomId)
    const values = Object.assign(
        pick(p, ["description", "transactionDate", "acctgTransTypeEnumId", "glJournalId", "otherPartyId", "workEffortId"]),
        {organizationPartyId: s.organizationPartyId, amountUomId}
    )
    if (values.glJournalId)
        lib.record({
            kind: "batches",
            recordId: values.glJournalId,
            organizationPartyId: s.organizationPartyId
        })
    values.transactionDate = p.transactionDate || old?.transactionDate || ec.user.nowTimestamp
    if (!Number.isFinite(ms(values.transactionDate))) throw new Error("Choose a transaction date")
    if (!values.acctgTransTypeEnumId) values.acctgTransTypeEnumId = old?.acctgTransTypeEnumId || "AttInternal"
    refuseClosingType(values.acctgTransTypeEnumId)
    lib.counterparty(values.otherPartyId)
    if (
        values.workEffortId &&
        one("mantle.work.effort.WorkEffort", {
            workEffortId: values.workEffortId
        })?.ownerPartyId !== s.organizationPartyId
    )
        throw new Error("Project is outside the posting organization")
    if (old) values.acctgTransId = old.acctgTransId
    return call("mantle.ledger.LedgerServices." + (old ? "update#AcctgTrans" : "create#AcctgTrans"), values)
}
function line(p) {
    const tx = transaction(p)
    if (tx.isPosted === "Y") throw new Error("Posted entries are read only")
    const old = p.acctgTransEntrySeqId
        ? one(E, {
              acctgTransId: tx.acctgTransId,
              acctgTransEntrySeqId: p.acctgTransEntrySeqId
          })
        : null
    if (p.acctgTransEntrySeqId && !old) throw new Error("Draft line is not available")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    lib.account(tx.organizationPartyId, p.glAccountId, tx.transactionDate)
    lib.dimensions(tx.organizationPartyId, p, tx.transactionDate)
    if (p.assetId && one("mantle.product.asset.Asset", {assetId: p.assetId})?.ownerPartyId !== tx.organizationPartyId)
        throw new Error("Line asset is outside the posting organization")
    if (p.productId) {
        const product = one("mantle.product.Product", {
            productId: p.productId
        })
        if (!product || !["_NA_", ...lib.organizationChain(tx.organizationPartyId)].includes(product.ownerPartyId))
            throw new Error("Line product is outside the posting organization")
    }
    if (!["D", "C"].includes(p.debitCreditFlag) || p.amount == null || toDecimal(p.amount).compare(0) < 0)
        throw new Error("Enter a debit or credit and a nonnegative amount")
    const values = Object.assign(
        pick(p, [
            "glAccountId",
            "debitCreditFlag",
            "amount",
            "description",
            "productId",
            "assetId",
            "facilityId",
            "costCenterId"
        ]),
        {acctgTransId: tx.acctgTransId}
    )
    values.amount = ec.l10n.roundCurrency(toDecimal(p.amount), tx.amountUomId)
    if (old) values.acctgTransEntrySeqId = old.acctgTransEntrySeqId
    return call("mantle.ledger.LedgerServices." + (old ? "update#AcctgTransEntry" : "create#AcctgTransEntry"), values)
}
function move(p) {
    const why = lib.reason(p),
        initial = transaction(p, false)
    const target = lib.record(
        {
            kind: "journals",
            recordId: p.destinationAcctgTransId,
            organizationPartyId: initial.organizationPartyId
        },
        "glPost",
        false
    )
    if (
        target.organizationPartyId !== initial.organizationPartyId ||
        target.amountUomId !== initial.amountUomId ||
        target.acctgTransId === initial.acctgTransId
    )
        throw new Error("Choose another draft in the same organization and currency")
    for (const id of [initial.acctgTransId, target.acctgTransId].sort()) {
        if (find(T, {acctgTransId: id}).forUpdate(true).one().isPosted === "Y")
            throw new Error("Both transactions must be drafts")
    }
    const source = one(E, {
        acctgTransId: initial.acctgTransId,
        acctgTransEntrySeqId: p.acctgTransEntrySeqId
    })
    if (!source) throw new Error("Draft line is not available")
    lib.revision(source, p.lastUpdatedStamp)
    lib.audit(["acctgTransId"], why)
    const out = call(
        "mantle.ledger.LedgerServices.create#AcctgTransEntry",
        Object.assign(map(source), {
            acctgTransId: target.acctgTransId,
            acctgTransEntrySeqId: null
        })
    )
    call("mantle.ledger.LedgerServices.delete#AcctgTransEntry", {
        acctgTransId: source.acctgTransId,
        acctgTransEntrySeqId: source.acctgTransEntrySeqId
    })
    return {
        acctgTransId: target.acctgTransId,
        acctgTransEntrySeqId: out.acctgTransEntrySeqId
    }
}
function preview(p) {
    const tx = transaction(p, false),
        out = guard.validate({acctgTransId: tx.acctgTransId})
    const {previewId} = call("create#" + P, {
        organizationPartyId: tx.organizationPartyId,
        acctgTransId: tx.acctgTransId,
        userId: ec.user.userId,
        inputFingerprint: out.inputFingerprint,
        expiresDate: previewExpiry()
    })
    return {
        previewId,
        inputFingerprint: out.inputFingerprint,
        valid: out.valid,
        findings: out.findings,
        debitTotal: out.debitTotal,
        creditTotal: out.creditTotal,
        acctgTransId: tx.acctgTransId
    }
}
function post(p) {
    const tx = transaction(p, false),
        s = lib.organization({organizationPartyId: tx.organizationPartyId}, "glPost")
    if (!p.operationKey || p.operationKey.length > 40 || !p.previewId)
        throw new Error("A reviewed preview and operation key are required")
    const why = lib.reason(p),
        requestHash = hash({
            type: "JournalPost",
            acctgTransId: tx.acctgTransId,
            previewId: p.previewId,
            inputFingerprint: p.inputFingerprint,
            changeReason: why
        })
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forNoKeyUpdate(true).one()
    const operation = one(O, {operationKey: p.operationKey})
    if (operation) {
        if (
            operation.operationType !== "JournalPost" ||
            operation.organizationPartyId !== tx.organizationPartyId ||
            operation.userId !== ec.user.userId ||
            operation.requestHash !== requestHash
        )
            throw new Error("Operation key was used for a different request")
        return {
            acctgTransId: operation.resultId,
            alreadyPosted: true,
            valid: true
        }
    }
    const reviewed = find(P, {previewId: p.previewId}).forUpdate(true).one()
    if (
        !reviewed ||
        reviewed.acctgTransId !== tx.acctgTransId ||
        reviewed.userId !== ec.user.userId ||
        ms(reviewed.expiresDate) <= ms(ec.user.nowTimestamp)
    )
        throw new Error("Review a current posting preview")
    const current = guard.validate({acctgTransId: tx.acctgTransId}, true)
    if (
        current.tx.isPosted === "Y" ||
        p.inputFingerprint !== reviewed.inputFingerprint ||
        current.inputFingerprint !== reviewed.inputFingerprint
    )
        throw new Error("Posting inputs changed; preview again")
    if (!current.valid) throw new Error(current.findings[0].code + ": " + current.findings.map(r => r.message).join("; "))
    call("create#" + O, {
        operationKey: p.operationKey,
        operationType: "JournalPost",
        organizationPartyId: tx.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestHash,
        previewId: p.previewId,
        previewFingerprint: p.inputFingerprint,
        status: "pending"
    })
    call("mantle.ledger.LedgerServices.post#AcctgTrans", {
        acctgTransId: tx.acctgTransId
    })
    if (one(T, {acctgTransId: tx.acctgTransId}).isPosted !== "Y") throw new Error("Transaction was not posted")
    call("update#" + T, {
        acctgTransId: tx.acctgTransId,
        postingFailureCode: null,
        postingFailureMessage: null,
        changeReason: why
    })
    call("update#" + O, {
        operationKey: p.operationKey,
        status: "complete",
        resultEntityName: T,
        resultId: tx.acctgTransId,
        completedDate: ec.user.nowTimestamp
    })
    return {acctgTransId: tx.acctgTransId, valid: true, alreadyPosted: false}
}
// A period's closing entries are posted only by CloseServices.close#Period: no draft, template or reversal takes their type.
function refuseClosingType(acctgTransTypeEnumId) {
    if (["AttPeriodClosing", "AttNetIncomeClosing"].includes(acctgTransTypeEnumId))
        lib.denied("CLOSING_ENTRY", "Closing entries are posted only by closing the period")
}
function reverse(p) {
    const initial = transaction(p, false),
        why = lib.reason(p)
    refuseClosingType(initial.acctgTransTypeEnumId)
    find("mantle.party.Party", {partyId: initial.organizationPartyId}).forNoKeyUpdate(true).one()
    const tx = transaction(p)
    if (!p.reversalDate || !Number.isFinite(ms(p.reversalDate))) throw new Error("Choose a reversal date")
    if (!p.operationKey || p.operationKey.length > 40) throw new Error("An operation key is required")
    find("mantle.party.Party", {partyId: tx.organizationPartyId}).forNoKeyUpdate(true).one()
    const requestHash = hash({
        acctgTransId: tx.acctgTransId,
        reversalDate: p.reversalDate,
        why
    })
    const old = one(O, {operationKey: p.operationKey})
    if (old) {
        if (
            old.operationType !== "JournalReverse" ||
            old.userId !== ec.user.userId ||
            old.organizationPartyId !== tx.organizationPartyId ||
            old.requestHash !== requestHash
        )
            throw new Error("Operation key was used for a different request")
        return {acctgTransId: old.resultId, alreadyPosted: true}
    }
    const result = call("mantle.ledger.LedgerServices.post#ReverseAcctgTrans", {
        acctgTransId: tx.acctgTransId,
        reversalDate: p.reversalDate,
        changeReason: why
    })
    if (one(T, {acctgTransId: result.acctgTransId})?.isPosted !== "Y") throw new Error("Reversal was not posted")
    call("create#" + O, {
        operationKey: p.operationKey,
        operationType: "JournalReverse",
        organizationPartyId: tx.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestHash,
        status: "complete",
        resultEntityName: T,
        resultId: result.acctgTransId,
        completedDate: ec.user.nowTimestamp
    })
    return result
}
function batch(p) {
    const s = lib.organization(p, "glPost")
    const old = p.glJournalId
        ? lib.record(
              {
                  kind: "batches",
                  recordId: p.glJournalId,
                  organizationPartyId: s.organizationPartyId
              },
              "glPost",
              true
          )
        : null
    if (old?.isPosted === "Y") throw new Error("Posted batches are read only")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    return call("mantle.ledger.LedgerServices." + (old ? "update#GlJournal" : "create#GlJournal"), {
        glJournalId: old?.glJournalId,
        organizationPartyId: s.organizationPartyId,
        glJournalName: p.glJournalName
    })
}
function validateBatch(p) {
    const s = lib.organization(p, "glPost")
    const journal = p.glJournalId
        ? lib.record(
              {
                  kind: "batches",
                  recordId: p.glJournalId,
                  organizationPartyId: s.organizationPartyId
              },
              "glPost",
              false
          )
        : null
    const selected = Array.isArray(p.acctgTransIds)
        ? [...new Set(p.acctgTransIds)]
        : String(p.acctgTransIds || "")
              .split(",")
              .filter(Boolean)
    if (!journal && (!selected.length || selected.length > 100)) throw new Error("Select 1–100 journal entries")
    // by id, so the preview and the batch post take the entries in one order (unordered, Postgres returns them in
    // row-storage order: F429)
    const transactions = journal
        ? Array.from(
              find(T, {
                  glJournalId: journal.glJournalId,
                  organizationPartyId: s.organizationPartyId,
                  isPosted: "N"
              })
                  .orderBy("acctgTransId")
                  .list()
          )
        : selected.map(id =>
              lib.record(
                  {
                      kind: "journals",
                      recordId: id,
                      organizationPartyId: s.organizationPartyId
                  },
                  "glPost",
                  false
              )
          )
    const results = []
    for (const tx of transactions) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name("mantle.ledger.JournalServices.preview#Entry")
                .parameters({
                    acctgTransId: tx.acctgTransId,
                    organizationPartyId: s.organizationPartyId
                })
                .disableAuthz()
                .requireNewTransaction(true)
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push(Object.assign({acctgTransId: tx.acctgTransId}, out))
        } catch (error) {
            ec.logger.error("Journal batch validation " + tx.acctgTransId + ": " + error.message)
            results.push({
                acctgTransId: tx.acctgTransId,
                valid: false,
                findings: [{code: "VALIDATION_FAILED", message: error.message}]
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const {previewId} = call("create#" + P, {
        organizationPartyId: s.organizationPartyId,
        userId: ec.user.userId,
        glJournalId: journal?.glJournalId,
        requestJson: JSON.stringify(results),
        inputFingerprint: hash(results),
        expiresDate: previewExpiry()
    })
    return {previewId, results, valid: results.every(r => r.valid)}
}
function postBatch(p) {
    const s = lib.organization(p, "glPost")
    const journal = p.glJournalId
        ? lib.record(
              {
                  kind: "batches",
                  recordId: p.glJournalId,
                  organizationPartyId: s.organizationPartyId
              },
              "glPost",
              false
          )
        : null
    const reviewed = one(P, {previewId: p.previewId})
    if (
        !reviewed ||
        (reviewed.glJournalId || null) !== (journal?.glJournalId || null) ||
        reviewed.organizationPartyId !== s.organizationPartyId ||
        reviewed.userId !== ec.user.userId ||
        ms(reviewed.expiresDate) <= ms(ec.user.nowTimestamp)
    )
        throw new Error("Review a current batch preview")
    if (!p.operationKey || p.operationKey.length > 40)
        throw new Error("A batch operation key of at most 40 characters is required")
    const previews = JSON.parse(reviewed.requestJson),
        ids = new Set(previews.map(r => r.acctgTransId))
    if (
        journal &&
        rows(T, {
            glJournalId: journal.glJournalId,
            organizationPartyId: journal.organizationPartyId,
            isPosted: "N"
        }).some(r => !ids.has(r.acctgTransId))
    )
        throw new Error("Batch membership changed; validate again")
    const results = []
    for (const item of previews) {
        ec.message.pushErrors()
        try {
            const out = ec.service
                .sync()
                .name("mantle.ledger.JournalServices.post#Entry")
                .disableAuthz()
                .requireNewTransaction(true)
                .parameters(
                    Object.assign({}, item, {
                        organizationPartyId: s.organizationPartyId,
                        operationKey: hash([p.operationKey, item.acctgTransId]).slice(0, 40),
                        changeReason: p.changeReason
                    })
                )
                .call()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({
                acctgTransId: item.acctgTransId,
                success: true,
                code: out.alreadyPosted ? "ALREADY_POSTED" : "POSTED",
                message: out.alreadyPosted ? "Already posted" : "Posted"
            })
        } catch (error) {
            ec.logger.error("Journal batch transaction " + item.acctgTransId + ": " + error.message)
            results.push({
                acctgTransId: item.acctgTransId,
                success: false,
                code: item.findings?.[0]?.code || "POSTING_FAILED",
                message: error.message
            })
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    const complete =
        results.every(r => r.success) &&
        (!journal ||
            !find(T, {
                glJournalId: journal.glJournalId,
                isPosted: "N"
            }).count())
    call("update#" + P, {
        previewId: reviewed.previewId,
        resultJson: JSON.stringify(results)
    })
    if (complete && journal)
        call("mantle.ledger.LedgerServices.update#GlJournal", {
            glJournalId: journal.glJournalId,
            isPosted: "Y"
        })
    return {results, complete}
}
function template(p) {
    const s = lib.organization(p, "glPost")
    const old = p.acctgTransTemplateId
        ? lib.record(
              {
                  kind: "templates",
                  recordId: p.acctgTransTemplateId,
                  organizationPartyId: s.organizationPartyId
              },
              "glPost",
              true
          )
        : null
    if (old) lib.revision(old, p.lastUpdatedStamp)
    if (!p.templateName) throw new Error("Give the template a name")
    const copy = old?.isPublished === "Y"
    if (copy && old.thruDate) throw new Error("Create a version from the latest published template")
    const values = Object.assign(
        copy ? pick(map(old), ["templateName", "acctgTransTypeEnumId", "amountUomId", "description"]) : {},
        pick(p, ["templateName", "acctgTransTypeEnumId", "amountUomId", "description", "fromDate", "thruDate"]),
        {organizationPartyId: s.organizationPartyId, isPublished: "N"}
    )
    values.amountUomId = values.amountUomId || lib.preference(s.organizationPartyId).baseCurrencyUomId
    lib.currency(values.amountUomId)
    refuseClosingType(values.acctgTransTypeEnumId)
    if (copy) {
        values.templateFamilyId = old.templateFamilyId || old.acctgTransTemplateId
        values.replacesTemplateId = old.acctgTransTemplateId
        values.templateVersion = Number(old.templateVersion || 1) + 1
        values.fromDate = p.fromDate || ec.user.nowTimestamp
        values.thruDate = null
    } else if (old) values.acctgTransTemplateId = old.acctgTransTemplateId
    else values.templateVersion = 1
    const result = call((old && !copy ? "update#" : "create#") + H, values)
    const id = old && !copy ? old.acctgTransTemplateId : result.acctgTransTemplateId
    if (!old) call("update#" + H, {acctgTransTemplateId: id, templateFamilyId: id})
    if (copy)
        for (const source of rows(L, {
            acctgTransTemplateId: old.acctgTransTemplateId
        }))
            call(
                "create#" + L,
                Object.assign(
                    pick(map(source), [
                        "entrySeqId",
                        "glAccountId",
                        "debitCreditFlag",
                        "amount",
                        "amountParameter",
                        "facilityId",
                        "costCenterId",
                        "productId",
                        "assetId",
                        "description"
                    ]),
                    {acctgTransTemplateId: id}
                )
            )
    return {acctgTransTemplateId: id}
}
function templateLines(p) {
    const header = lib.record(
        {
            kind: "templates",
            recordId: p.acctgTransTemplateId,
            organizationPartyId: p.organizationPartyId
        },
        "glPost",
        true
    )
    lib.revision(header, p.lastUpdatedStamp)
    if (header.isPublished === "Y") throw new Error("Published template lines are immutable; create a new version")
    if (!Array.isArray(p.lines) || !p.lines.length || p.lines.length > 500) throw new Error("Supply 1–500 template lines")
    let balance = toDecimal(0),
        coefficients = {}
    for (const line of p.lines) {
        lib.account(header.organizationPartyId, line.glAccountId)
        lib.dimensions(header.organizationPartyId, line)
        if (
            line.assetId &&
            one("mantle.product.asset.Asset", {assetId: line.assetId})?.ownerPartyId !== header.organizationPartyId
        )
            throw new Error("Template asset is outside the posting organization")
        if (line.productId) {
            const product = one("mantle.product.Product", {
                productId: line.productId
            })
            if (!product || !["_NA_", ...lib.organizationChain(header.organizationPartyId)].includes(product.ownerPartyId))
                throw new Error("Template product is outside the posting organization")
        }
        if (!["D", "C"].includes(line.debitCreditFlag)) throw new Error("Choose debit or credit")
        const sign = line.debitCreditFlag === "D" ? 1 : -1
        if (line.amountParameter) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(line.amountParameter)) throw new Error("Use a simple amount parameter name")
            coefficients[line.amountParameter] = (coefficients[line.amountParameter] || 0) + sign
        } else {
            if (line.amount == null || toDecimal(line.amount).compare(0) < 0) throw new Error("Enter a nonnegative amount")
            line.amount = ec.l10n.roundCurrency(toDecimal(line.amount), header.amountUomId)
            balance = balance.add(line.amount.multiply(sign))
        }
    }
    if (!balance.isZero() || Object.values(coefficients).some(v => v !== 0))
        throw new Error("Template lines must balance, including amount parameters")
    for (const old of rows(L, {
        acctgTransTemplateId: header.acctgTransTemplateId
    }))
        call("delete#" + L, {
            acctgTransTemplateId: header.acctgTransTemplateId,
            entrySeqId: old.entrySeqId
        })
    for (const [i, line] of p.lines.entries())
        call(
            "create#" + L,
            Object.assign(
                pick(line, [
                    "glAccountId",
                    "debitCreditFlag",
                    "amount",
                    "amountParameter",
                    "description",
                    "facilityId",
                    "costCenterId",
                    "productId",
                    "assetId"
                ]),
                {
                    acctgTransTemplateId: header.acctgTransTemplateId,
                    entrySeqId: String(i + 1).padStart(3, "0")
                }
            )
        )
    const effectiveDate = header.fromDate || ec.user.nowTimestamp
    if (header.replacesTemplateId) {
        const previous = find(H, {
            acctgTransTemplateId: header.replacesTemplateId
        })
            .forUpdate(true)
            .one()
        if (
            !previous ||
            previous.organizationPartyId !== header.organizationPartyId ||
            previous.thruDate ||
            ms(effectiveDate) < (ms(previous.fromDate) || 0)
        )
            throw new Error("Template version changed; create a version from the current publication")
        call("update#" + H, {
            acctgTransTemplateId: previous.acctgTransTemplateId,
            thruDate: effectiveDate
        })
    }
    call("update#" + H, {
        acctgTransTemplateId: header.acctgTransTemplateId,
        fromDate: effectiveDate,
        isPublished: "Y"
    })
    return {acctgTransTemplateId: header.acctgTransTemplateId}
}
function instantiate(p) {
    const header = lib.record(
        {
            kind: "templates",
            recordId: p.acctgTransTemplateId,
            organizationPartyId: p.organizationPartyId
        },
        "glPost",
        true
    )
    if (header.isPublished !== "Y" || !lib.active(header, p.transactionDate || ec.user.nowTimestamp))
        throw new Error("Choose an effective published template")
    refuseClosingType(header.acctgTransTypeEnumId)
    const out = draft({
        organizationPartyId: header.organizationPartyId,
        transactionDate: p.transactionDate,
        amountUomId: header.amountUomId,
        acctgTransTypeEnumId: header.acctgTransTypeEnumId,
        description: header.description
    })
    call("update#" + T, {
        acctgTransId: out.acctgTransId,
        acctgTransTemplateId: header.acctgTransTemplateId,
        templateFromDate: header.fromDate,
        templateVersion: header.templateVersion
    })
    for (const item of rows(L, {
        acctgTransTemplateId: header.acctgTransTemplateId
    })) {
        const amount = item.amountParameter ? p.amounts?.[item.amountParameter] : item.amount
        line(
            Object.assign(map(item), {
                acctgTransId: out.acctgTransId,
                amount
            })
        )
    }
    return out
}
function templateLine(p) {
    const header = lib.record(
        {
            kind: "templates",
            recordId: p.acctgTransTemplateId,
            organizationPartyId: p.organizationPartyId
        },
        "glPost",
        true
    )
    if (header.isPublished === "Y") throw new Error("Published template lines are immutable; create a new version")
    lib.account(header.organizationPartyId, p.glAccountId)
    lib.dimensions(header.organizationPartyId, p)
    if (
        !["D", "C"].includes(p.debitCreditFlag) ||
        (!p.amountParameter && (p.amount == null || toDecimal(p.amount).compare(0) < 0))
    )
        throw new Error("Choose a side and a nonnegative amount or named parameter")
    const old = p.entrySeqId
        ? one(L, {
              acctgTransTemplateId: header.acctgTransTemplateId,
              entrySeqId: p.entrySeqId
          })
        : null
    if (p.entrySeqId && !old) throw new Error("Template line is not available")
    if (old) lib.revision(old, p.lastUpdatedStamp)
    const values = Object.assign(
        pick(p, ["glAccountId", "debitCreditFlag", "amount", "amountParameter", "facilityId", "costCenterId", "description"]),
        {acctgTransTemplateId: header.acctgTransTemplateId}
    )
    if (!p.amountParameter) values.amount = ec.l10n.roundCurrency(toDecimal(p.amount), header.amountUomId)
    values.entrySeqId =
        old?.entrySeqId ||
        String(
            rows(L, {
                acctgTransTemplateId: header.acctgTransTemplateId
            }).reduce((n, r) => Math.max(n, Number(r.entrySeqId) || 0), 0) + 1
        ).padStart(3, "0")
    call((old ? "update#" : "create#") + L, values)
    call("update#" + H, {
        acctgTransTemplateId: header.acctgTransTemplateId,
        isPublished: "N"
    })
    return {acctgTransTemplateId: header.acctgTransTemplateId}
}
function publishTemplate(p) {
    const header = lib.record(
        {
            kind: "templates",
            recordId: p.acctgTransTemplateId,
            organizationPartyId: p.organizationPartyId
        },
        "glPost",
        true
    )
    if (header.isPublished === "Y") return {acctgTransTemplateId: header.acctgTransTemplateId}
    lib.revision(header, p.lastUpdatedStamp)
    return templateLines(
        Object.assign({}, p, {
            lastUpdatedStamp: p.lastUpdatedStamp,
            lines: rows(L, {
                acctgTransTemplateId: header.acctgTransTemplateId
            }).map(map)
        })
    )
}
const operations = {
    draft,
    line,
    move,
    preview,
    post,
    reverse,
    batch,
    validateBatch,
    postBatch,
    template,
    templateLine,
    templateLines,
    publishTemplate,
    instantiate
}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown journal operation " + op)
        return operations[op](p)
    }
})
