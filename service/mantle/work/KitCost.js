// The cost of a pick-assembly kit made at pack (impl-warehouse P12, F41; design-warehouse §10 Kits, crosscut §3.9
// AssemblyReconciliation). mantle.work.ManufacturingServices.produce#AvailableAssemblies reads it for every caller
// (pack#ShipmentAssemblyComponent, pack#ShipmentProductScan) when the work effort owner's
// PartyAcctgPreference.kitCostFromComponents is Y; with the flag off nothing here runs and the kit is received with no
// cost, as Mantle always did.
//
// The kits made now use the next slice of each component's issuances to the work effort: the component quantity the kits
// received so far used (componentUsedQtyByProduct) is skipped, and the next (kits × component quantity) is valued issuance
// by issuance in issue order at each issuance's asset's acquireCost (AssetIssuance has no cost; the posted issuance amount
// is the same figure). So the receipts of a work effort add up to exactly what its issuances posted, with no division in
// the total. The unit cost is that value ÷ kits at the four decimals Asset.acquireCost keeps, and when that leaves a
// remainder the last kit is received apart at the remainder's cost (P6's repack rule, F166), so WIP nets to zero.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, call} = lib

// The flag of the organization that owns the work effort (its own preference, else the one it inherits).
function enabled(organizationPartyId) {
    if (!organizationPartyId) return false
    const found = call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId})
    return found?.partyAcctgPreference?.kitCostFromComponents === "Y"
}

// The value of the component issuances from quantity `from` to `to` (in issue order), or null when an issuance in that
// slice has an asset with no cost: the kit is then received with none, as before, rather than at a part of its cost.
function sliceValue(issuances, from, to, currency) {
    let value = toDecimal(0),
        start = toDecimal(0)
    for (const issuance of issuances) {
        const quantity = toDecimal(issuance.quantity ?? 0)
        const end = start.add(quantity)
        const low = start.compare(from) > 0 ? start : from
        const high = end.compare(to) < 0 ? end : to
        if (high.compare(low) > 0) {
            const asset = one("mantle.product.asset.Asset", {assetId: issuance.assetId})
            if (asset?.acquireCost == null) return null
            if (!currency.uomId) currency.uomId = asset.acquireCostUomId || null
            value = value.add(high.subtract(low).multiply(asset.acquireCost))
        }
        start = end
        if (start.compare(to) >= 0) break
    }
    return start.compare(to) >= 0 ? value : null
}

// The receipt lines of `quantity` kits of assemblyProductId: [{quantity, acquireCost, acquireCostUomId}], one line, or two when the unit cost
// leaves a remainder; null when the cost is not known (a component with no cost, or fewer components issued than used).
function receiptLines(p) {
    const quantity = toDecimal(p.quantity ?? 0)
    if (quantity.compare(0) <= 0) return null
    const bom = Array.from(
        find("mantle.work.effort.WorkEffortProductAssoc", {
            workEffortId: p.workEffortId,
            typeEnumId: "WeptProduce",
            productId: p.assemblyProductId
        })
            .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
            .conditionDate("componentFromDate", "componentThruDate", ec.user.nowTimestamp)
            .list()
    )
    if (!bom.length) return null
    const used = p.componentUsedQtyByProduct || {}
    let value = toDecimal(0)
    const currency = {uomId: null}
    for (const component of bom) {
        const issuances = Array.from(
            find("mantle.product.issuance.AssetIssuance", {workEffortId: p.workEffortId, productId: component.toProductId})
                .orderBy("assetIssuanceId")
                .list()
        ).filter(row => toDecimal(row.quantity ?? 0).compare(0) > 0)
        const from = toDecimal(used[component.toProductId] ?? 0)
        const componentValue = sliceValue(
            issuances,
            from,
            from.add(quantity.multiply(component.componentQuantity ?? 1)),
            currency
        )
        if (componentValue == null) return null
        value = value.add(componentValue)
    }
    // rounded down, so the remainder unit is never below the unit cost (F292)
    const unit = value.divide(quantity, 4, "DOWN")
    const acquireCostUomId = currency.uomId
    if (quantity.compare(1) <= 0 || quantity.multiply(unit).eq(value)) return [{quantity, acquireCost: unit, acquireCostUomId}]
    const most = quantity.subtract(1)
    return [
        {quantity: most, acquireCost: unit, acquireCostUomId},
        {quantity: toDecimal(1), acquireCost: value.subtract(most.multiply(unit)), acquireCostUomId}
    ]
}

;({enabled, receiptLines})
