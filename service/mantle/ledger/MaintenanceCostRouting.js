// Accounting's maintenance expense routing (AC-24; design-accounting PostingDefaults "Maintenance expense routing", design-maintenance
// MT-09; impl-maintenance P9, F32, F71), called by AssetAutoPostServices' post#AssetIssuance and post#AssetReceipt.
//
// - Only stock (AstTpInventory) issued to a managed maintenance work order (a root with a MaintenanceWorkOrder row, not a template)
//   or one of its steps is routed. Production runs, projects and every other issuance post as Mantle always has (the same-owner
//   WIP account, else COGS).
// - The debit is the expense account of the MaintenanceCostPolicy in effect on the issue date for the asset owner's organization:
//   the work's facility or its nearest ancestor with a row before a row of every facility, and the work's kind before any kind.
//   The entry carries the facility (the nearest of the work's facility and its ancestors the posting organization owns, the only
//   facility the posting guard admits as its dimension) and the cost centre, and the transaction the project (AcctgTrans
//   .workEffortId, as project cost posting has it), all from the issuance, else from its work order.
// - No row: the issuance's account is left empty, so the transaction goes to the error journal, named MAINTENANCE_COST_UNMAPPED
//   (issue#MaintenanceMaterial refuses before an issue when the organization posts and has no row, so this is the backstop).
// - A receipt naming a routed issuance (return#MaintenanceMaterial: sourceAssetIssuanceId, the work's workEffortId, which would
//   otherwise credit WIP) is credited to the account and dimensions the issuance's debit took, read from its posted transaction,
//   else from the policy as of the issue date: a return reverses the original cost the way it was charged.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, ms} = lib

const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const WORK = "mantle.work.effort.WorkEffort"
const POLICY = "mantle.ledger.config.MaintenanceCostPolicy"
const facilityDepth = 12

// The managed work order of a root or step: {root, order}, or null for anything else (a template, ordinary work, nothing).
function workOrderOf(workEffortId) {
    if (!workEffortId || !ec.entity.isEntityDefined(ORDER)) return null
    const workEffort = one(WORK, {workEffortId})
    if (!workEffort) return null
    const rootId = workEffort.rootWorkEffortId || workEffort.workEffortId
    const order = one(ORDER, {workEffortId: rootId})
    if (!order) return null
    const root = rootId === workEffort.workEffortId ? workEffort : one(WORK, {workEffortId: rootId})
    if (!root || root.isTemplate === "Y") return null
    return {root, order}
}
// The work's facility: the root's (facility work names it; equipment work holds its equipment's), else the equipment's.
function workFacilityOf(found) {
    if (found.root.facilityId) return found.root.facilityId
    const asset = found.order.assetId ? one("mantle.product.asset.Asset", {assetId: found.order.assetId}) : null
    return asset?.facilityId || null
}
// A facility and its ancestors, nearest first.
function facilityChain(facilityId) {
    const chain = []
    let id = facilityId
    for (let depth = 0; id && !chain.includes(id) && depth < facilityDepth; depth++) {
        const facility = one("mantle.facility.Facility", {facilityId: id})
        if (!facility) break
        chain.push(facility.facilityId)
        id = facility.parentFacilityId
    }
    return chain
}
// The facility dimension the posting organization may carry: the nearest of the chain it owns.
function dimensionFacility(organizationPartyId, chain) {
    for (const facilityId of chain)
        if (one("mantle.facility.Facility", {facilityId})?.ownerPartyId === organizationPartyId) return facilityId
    return null
}
// The policy row in effect: by facility (nearest first, then every facility), then kind (the work's, then any).
function policyFor(organizationPartyId, maintenanceKindEnumId, chain, date) {
    if (!organizationPartyId) return null
    const at = ms(date ?? ec.user.nowTimestamp)
    const rows = Array.from(find(POLICY, {organizationPartyId}).list()).filter(
        row => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
    )
    for (const facilityId of [...chain, null])
        for (const kind of maintenanceKindEnumId ? [maintenanceKindEnumId, null] : [null]) {
            const row = rows.find(r => (r.facilityId || null) === facilityId && (r.maintenanceKindEnumId || null) === kind)
            if (row) return row
        }
    return null
}
const accountType = glAccountId =>
    glAccountId ? one("mantle.ledger.account.GlAccount", {glAccountId})?.glAccountTypeEnumId || null : null

// The route of a work order's material for an organization on a date (issue#MaintenanceMaterial's check and the issuance's
// posting): {policy, glAccountId, facilityId, chain, message}.
function routeFor(found, organizationPartyId, date) {
    const chain = facilityChain(workFacilityOf(found))
    const policy = policyFor(organizationPartyId, found.order.maintenanceKindEnumId, chain, date)
    return {
        policy,
        glAccountId: policy?.glAccountId || null,
        glAccountTypeEnumId: accountType(policy?.glAccountId),
        facilityId: dimensionFacility(organizationPartyId, chain),
        message: policy
            ? null
            : "No maintenance expense account is mapped for " +
              organizationPartyId +
              (found.order.maintenanceKindEnumId ? ", " + found.order.maintenanceKindEnumId : "") +
              (chain[0] ? ", facility " + chain[0] : "") +
              " (Accounting › Posting defaults › Maintenance expense)"
    }
}
// post#AssetIssuance: the debit of an issuance to managed maintenance work, or null.
function issuance(assetIssuance, asset) {
    if (!assetIssuance || asset?.assetTypeEnumId !== "AstTpInventory") return null
    const found = workOrderOf(assetIssuance.workEffortId)
    if (!found) return null
    const route = routeFor(found, asset.ownerPartyId, assetIssuance.issuedDate)
    return Object.assign(route, {
        costCenterId: assetIssuance.costCenterId || found.order.costCenterId || null,
        projectWorkEffortId: assetIssuance.projectWorkEffortId || found.order.projectWorkEffortId || null,
        failureCode: route.glAccountId ? null : "MAINTENANCE_COST_UNMAPPED"
    })
}
// post#AssetReceipt: the credit of a return of a routed issuance, or null.
function receipt(assetReceipt, asset) {
    if (!assetReceipt?.sourceAssetIssuanceId || asset?.assetTypeEnumId !== "AstTpInventory") return null
    const source = one("mantle.product.issuance.AssetIssuance", {assetIssuanceId: assetReceipt.sourceAssetIssuanceId})
    if (!source || !workOrderOf(source.workEffortId)) return null
    // the issuance's own posting: its debit entry and its project
    const posted = Array.from(
        find("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: source.assetIssuanceId})
            .condition("acctgTransTypeEnumId", "in", ["AttInventoryIssuance", "AttAssetIssuance"])
            .condition("reversedByAcctgTransId", null)
            .condition("reverseOfAcctgTransId", null)
            .list()
    )[0]
    const debit = posted
        ? Array.from(
              find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: posted.acctgTransId, debitCreditFlag: "D"}).list()
          )[0]
        : null
    if (debit?.glAccountId)
        return {
            glAccountId: debit.glAccountId,
            glAccountTypeEnumId: debit.glAccountTypeEnumId || accountType(debit.glAccountId),
            facilityId: debit.facilityId || null,
            costCenterId: debit.costCenterId || null,
            projectWorkEffortId: posted.workEffortId || null,
            failureCode: null,
            message: null
        }
    const sourceAsset = one("mantle.product.asset.Asset", {assetId: source.assetId}) || asset
    return issuance(source, Object.assign(lib.map(sourceAsset), {ownerPartyId: asset.ownerPartyId}))
}

;({workOrderOf, routeFor, issuance, receipt})
