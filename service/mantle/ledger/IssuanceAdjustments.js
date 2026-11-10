// Opt-in dated delta for a changed issuance. Posted movements and their transaction dates are never rewritten.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const T = "mantle.ledger.transaction.AcctgTrans",
    E = "mantle.ledger.transaction.AcctgTransEntry",
    O = "mantle.ledger.transaction.PostingOperation"
function repost(p) {
    const issuance = lib
        .find("mantle.product.issuance.AssetIssuance", {
            assetIssuanceId: p.assetIssuanceId
        })
        .forUpdate(true)
        .one()
    if (!issuance) return false
    const asset = lib.one("mantle.product.asset.Asset", {
        assetId: issuance.assetId
    })
    if (!asset || lib.preference(asset.ownerPartyId).forwardIssuanceRepostEnabled !== "Y") return false
    const history = Array.from(
        lib
            .find(T, {
                assetIssuanceId: issuance.assetIssuanceId,
                isPosted: "Y"
            })
            .orderBy("transactionDate,acctgTransId")
            .list()
    )
    if (!history.length) {
        lib.call("mantle.ledger.AssetAutoPostServices.post#AssetIssuance", {
            assetIssuanceId: issuance.assetIssuanceId
        })
        return true
    }
    lib.find("mantle.party.Party", {partyId: asset.ownerPartyId}).forNoKeyUpdate(true).one()
    const mapped =
        lib.call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
            organizationPartyId: asset.ownerPartyId,
            assetId: asset.assetId,
            assetTypeEnumId: asset.assetTypeEnumId,
            classEnumId: asset.classEnumId
        }).assetTypeGlAccount || {}
    const effort = issuance.workEffortId
        ? lib.one("mantle.work.effort.WorkEffort", {
              workEffortId: issuance.workEffortId
          })
        : null
    const inventory = asset.assetTypeEnumId === "AstTpInventory",
        wip = effort?.ownerPartyId === asset.ownerPartyId
    const account = (specific, type) =>
        specific ||
        lib.call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            organizationPartyId: asset.ownerPartyId,
            glAccountTypeEnumId: type
        }).glAccountId
    const credit = account(mapped.assetGlAccountId, inventory ? "GatInventory" : "GatFixedAsset")
    let debit = account(
        wip ? mapped.wipAssetGlAccountId : mapped.issuanceGlAccountId,
        inventory ? (wip ? "GatWipInventory" : "GatCogs") : "GatUnissuedFixedAsset"
    )
    const shipment = issuance.shipmentId
        ? lib.one("mantle.shipment.Shipment", {
              shipmentId: issuance.shipmentId
          })
        : null
    if (shipment?.shipmentTypeEnumId === "ShpTpTransfer" && mapped.transferGlAccountId) debit = mapped.transferGlAccountId
    const cost = ec.resource
        .script("component://mr-mantle/service/mantle/ledger/ForwardInventoryCosts.js")
        .at(asset, issuance.issuedDate)
    const amount = toDecimal(issuance.quantity || 0).multiply(cost.unitCost || 0),
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
        issuance: lib.map(issuance),
        debit,
        credit,
        amount: String(amount)
    })
    const operationKey = "ia:" + lib.hash([issuance.assetIssuanceId, requestHash]).slice(0, 37)
    if (lib.one(O, {operationKey})) return true
    const out = lib.call("mantle.ledger.LedgerServices.create#AcctgTrans", {
        organizationPartyId: asset.ownerPartyId,
        acctgTransTypeEnumId: history[0].acctgTransTypeEnumId,
        assetIssuanceId: issuance.assetIssuanceId,
        assetId: asset.assetId,
        workEffortId: issuance.workEffortId,
        shipmentId: issuance.shipmentId,
        amountUomId: cost.amountUomId,
        transactionDate: ec.user.nowTimestamp,
        description: "Forward issuance adjustment for " + issuance.assetIssuanceId,
        changeReason: "Issuance changed"
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
        operationType: "IssuanceAdjustment",
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
