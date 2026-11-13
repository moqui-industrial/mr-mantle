// Opt-in dated delta for a changed receipt (impl-manufacturing P9, F31, F32), beside IssuanceAdjustments.js: with the asset
// owner's PartyAcctgPreference.forwardReceiptRepostEnabled, repost#AssetReceipt leaves the posted history alone and posts one
// AcctgTrans dated now for what should be posted (quantityAccepted × acquireCost, debit the asset account, credit work in
// process for a work-effort receipt, else the receipt account, or the transfer account of a transfer) less what was posted,
// idempotent by its operation key. A receipt never posted, or one whose receivedDate moved, keeps the legacy path (unpost,
// delete and post again), as does every receipt with the flag off.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry",
    O = "mantle.ledger.transaction.PostingOperation"
function repost(p) {
    const receipt = lib
        .find("mantle.product.receipt.AssetReceipt", {
            assetReceiptId: p.assetReceiptId
        })
        .forUpdate(true)
        .one()
    if (!receipt || receipt.quantityAccepted == null) return false
    const asset = lib.one("mantle.product.asset.Asset", {
        assetId: receipt.assetId
    })
    if (!asset || lib.preference(asset.ownerPartyId).forwardReceiptRepostEnabled !== "Y") return false
    const history = Array.from(
        lib
            .find(T, {
                assetReceiptId: receipt.assetReceiptId,
                isPosted: "Y"
            })
            .condition("acctgTransTypeEnumId", "in", ["AttInventoryReceipt", "AttAssetReceipt"])
            .orderBy("transactionDate,acctgTransId")
            .list()
    )
    // nothing posted yet, or a new received date: the legacy path posts it as of its date
    if (!history.length || receipt.receivedDate == null || lib.ms(history[0].transactionDate) !== lib.ms(receipt.receivedDate))
        return false
    lib.find("mantle.party.Party", {partyId: asset.ownerPartyId}).forNoKeyUpdate(true).one()
    const mapped =
        lib.call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
            organizationPartyId: asset.ownerPartyId,
            assetId: asset.assetId,
            assetTypeEnumId: asset.assetTypeEnumId,
            classEnumId: asset.classEnumId
        }).assetTypeGlAccount || {}
    const inventory = asset.assetTypeEnumId === "AstTpInventory"
    const account = (specific, type) =>
        specific ||
        lib.call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            organizationPartyId: asset.ownerPartyId,
            glAccountTypeEnumId: type
        }).glAccountId
    const debit = account(mapped.assetGlAccountId, inventory ? "GatInventory" : "GatFixedAsset")
    let credit = account(
        receipt.workEffortId ? mapped.wipAssetGlAccountId : mapped.receiptGlAccountId,
        inventory ? (receipt.workEffortId ? "GatWipInventory" : "GatUnreceivedInventory") : "GatUnreceivedFixedAsset"
    )
    const shipment = receipt.shipmentId ? lib.one("mantle.shipment.Shipment", {shipmentId: receipt.shipmentId}) : null
    if (shipment?.shipmentTypeEnumId === "ShpTpTransfer" && mapped.transferGlAccountId) credit = mapped.transferGlAccountId
    const amount = toDecimal(receipt.quantityAccepted || 0).multiply(asset.acquireCost ?? 0),
        difference = {}
    for (const tx of history)
        for (const line of lib.rows(E, {acctgTransId: tx.acctgTransId})) {
            const id = line.glAccountId
            difference[id] = (difference[id] || toDecimal(0)).subtract(
                toDecimal(line.amount).multiply(line.debitCreditFlag === "D" ? 1 : -1)
            )
        }
    if (debit) difference[debit] = (difference[debit] || toDecimal(0)).add(amount)
    if (credit) difference[credit] = (difference[credit] || toDecimal(0)).subtract(amount)
    if (Object.values(difference).every(v => v.isZero())) return true
    const requestHash = lib.hash({
        receipt: lib.map(receipt),
        acquireCost: asset.acquireCost == null ? null : String(asset.acquireCost),
        debit,
        credit,
        amount: String(amount)
    })
    const operationKey = "ra:" + lib.hash([receipt.assetReceiptId, requestHash]).slice(0, 37)
    if (lib.one(O, {operationKey})) return true
    const out = lib.call("mantle.ledger.LedgerServices.create#AcctgTrans", {
        organizationPartyId: asset.ownerPartyId,
        acctgTransTypeEnumId: history[0].acctgTransTypeEnumId,
        assetReceiptId: receipt.assetReceiptId,
        assetId: asset.assetId,
        workEffortId: receipt.workEffortId,
        shipmentId: receipt.shipmentId,
        amountUomId: asset.acquireCostUomId || history[0].amountUomId,
        transactionDate: ec.user.nowTimestamp,
        description: "Forward receipt adjustment for " + receipt.assetReceiptId,
        changeReason: "Receipt changed"
    })
    for (const [glAccountId, value] of Object.entries(difference))
        if (!value.isZero())
            lib.call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId: out.acctgTransId,
                glAccountId: glAccountId === "undefined" ? null : glAccountId,
                amount: value.abs(),
                debitCreditFlag: value.compare(0) > 0 ? "D" : "C",
                assetId: asset.assetId,
                productId: asset.productId
            })
    if (!debit || !credit)
        lib.call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
            acctgTransId: out.acctgTransId,
            amount: 0,
            debitCreditFlag: "D"
        })
    lib.call("mantle.ledger.LedgerServices.post#AcctgTrans", {
        acctgTransId: out.acctgTransId
    })
    const posted = lib.one(T, {acctgTransId: out.acctgTransId}).isPosted === "Y"
    lib.call("create#" + O, {
        operationKey,
        operationType: "ReceiptAdjustment",
        organizationPartyId: asset.ownerPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestHash,
        status: posted ? "complete" : "error",
        resultEntityName: T,
        resultId: out.acctgTransId
    })
    return true
}
;({repost})
