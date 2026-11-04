// The forward receipt repost (impl-manufacturing P9, F31, F32; ReceiptAdjustments.js): with the owner's
// PartyAcctgPreference.forwardReceiptRepostEnabled off a changed receipt reposts as before (its transaction unposted, deleted and
// posted again at the received date; under a hard lock its new posting is refused, so the posted history is lost, F-P9-2,
// Accounting's); with it on the posted history stays and one transaction dated now carries the difference, once, in an open
// period and with the receipt's day under a hard lock. The organization is the spec's own.
const org = "RAJ_ORG",
    facility = "RAJ_FAC"
const TRANS = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const day = 86400000
const state = {}
function invoke(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const preference = fields =>
    call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: org}, fields))
// 3 units at 10 received from the work effort on a date, posted Dr inventory / Cr WIP
function received(daysAgo) {
    const out = call("mantle.product.AssetServices.receive#Asset", {
        productId: "DEMO_1_1",
        quantity: 3,
        facilityId: facility,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost: 10,
        acquireCostUomId: "USD",
        workEffortId: state.effort,
        receivedDate: new Date(Number(ec.user.nowTimestamp) - daysAgo * day)
    })
    return {assetId: out.assetId, assetReceiptId: out.assetReceiptId}
}
const lower = receipt =>
    invoke("mantle.product.AssetServices.update#AssetAndReceipt", {
        assetId: receipt.assetId,
        assetReceiptId: receipt.assetReceiptId,
        workEffortId: state.effort,
        quantityAccepted: 2
    })
const posted = receipt => rows(TRANS, {assetReceiptId: receipt.assetReceiptId, isPosted: "Y"})
const amountOf = trans =>
    rows(ENTRY, {acctgTransId: trans.acctgTransId, debitCreditFlag: "D"}).reduce((total, row) => total + n(row.amount), 0)
const typeOf = entry => one("mantle.ledger.account.GlAccount", {glAccountId: entry.glAccountId})?.glAccountTypeEnumId

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: org})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        state.effort = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTask",
            statusId: "WeInProgress",
            ownerPartyId: org,
            facilityId: facility,
            workEffortName: "Receipt adjustments"
        }).workEffortId
        state.legacy = received(1)
        state.forward = received(1)
        state.locked = received(2)
        state.lockedLegacy = received(2)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("with the flag off a changed receipt reposts as before: the transaction is posted again at the received date", {
    when() {
        const before = posted(state.legacy)
        const out = lower(state.legacy)
        return {
            before,
            out,
            after: posted(state.legacy),
            receipt: one("mantle.product.receipt.AssetReceipt", {assetReceiptId: state.legacy.assetReceiptId})
        }
    },
    then({before, out, after, receipt}) {
        before.length === 1
        out.error === ""
        after.length === 1
        after[0].acctgTransId !== before[0].acctgTransId
        Number(after[0].transactionDate) === Number(receipt.receivedDate)
        amountOf(after[0]) === 20
    }
})

feature("with the flag on the posted history stays and one transaction dated now carries the difference, once", {
    when() {
        preference({forwardReceiptRepostEnabled: "Y"})
        const before = posted(state.forward)
        const started = Number(ec.user.nowTimestamp)
        const out = lower(state.forward)
        const again = invoke("mantle.ledger.AssetAutoPostServices.repost#AssetReceipt", {
            assetReceiptId: state.forward.assetReceiptId
        })
        const after = posted(state.forward)
        const delta = after.find(row => row.acctgTransId !== before[0]?.acctgTransId)
        return {before, out, again, after, delta, started, entries: delta ? rows(ENTRY, {acctgTransId: delta.acctgTransId}) : []}
    },
    then({before, out, again, after, delta, started, entries}) {
        before.length === 1
        out.error === ""
        again.error === ""
        after.length === 2
        after.some(
            row =>
                row.acctgTransId === before[0].acctgTransId && Number(row.transactionDate) === Number(before[0].transactionDate)
        )
        Number(delta.transactionDate) >= started
        // one unit less: Dr WIP 10, Cr inventory 10
        entries.some(row => row.debitCreditFlag === "D" && typeOf(row) === "GatWipInventory" && n(row.amount) === 10)
        entries.some(row => row.debitCreditFlag === "C" && typeOf(row) === "GatInventory" && n(row.amount) === 10)
    }
})

feature("under a hard lock of the receipt's day the delta posts today, and with the flag off the posting is lost (F-P9-2)", {
    when() {
        preference({postingGuardEnabled: "Y"})
        const lock = invoke("mantle.ledger.CloseServices.store#Lock", {
            organizationPartyId: org,
            lockScope: "all",
            lockThroughDate: ec.l10n.format(new Date(Number(ec.user.nowTimestamp) - day), "yyyy-MM-dd"),
            isHard: "Y",
            changeReason: "Protect the receipts"
        })
        const before = posted(state.locked)
        const out = lower(state.locked)
        const after = posted(state.locked)
        preference({forwardReceiptRepostEnabled: "N"})
        const legacy = lower(state.lockedLegacy)
        return {
            lock,
            before,
            out,
            after,
            legacy,
            legacyPosted: posted(state.lockedLegacy),
            legacyReceipt: one("mantle.product.receipt.AssetReceipt", {assetReceiptId: state.lockedLegacy.assetReceiptId})
        }
    },
    then({lock, before, out, after, legacy, legacyPosted, legacyReceipt}) {
        lock.error === ""
        out.error === ""
        after.length === 2
        after.some(row => row.acctgTransId === before[0].acctgTransId)
        after.every(row => row.isPosted === "Y")
        // the legacy path cannot keep the locked day's posting: it refuses, or loses the posted history
        legacy.error !== "" || legacyPosted.length === 0
    }
})
