// The reversal of a supported pick assembly (impl-manufacturing P9, design-manufacturing Disassembly, F15, F29–F32): two packs of
// the DEMO_PA kit (DEMO_1_1 x1, DEMO_2_1 x2) assembled at two component costs, so the kits are received at their components'
// cost (kitCostFromComponents) on two kit assets; the reversal is refused naming each of Accounting's two forward repost flags
// while it is off, for an older kit whose newest component issues carry another cost, for a product that is not a kit and for
// a kit unit already sold; with both flags on the newest pack is reversed in an open period with dated reversing entries,
// the original receipt's posting kept, and work in process nets to zero after it and after the older pack's reversal. The
// organization, stock and users (in spec-local groups) are the spec's own.
const P = "mantle.work.ProductionServices."
const org = "SAK_ORG",
    other = "SAK_OTHER",
    facility = "SAK_FAC"
const TRANS = "mantle.ledger.transaction.AcctgTrans",
    ENTRY = "mantle.ledger.transaction.AcctgTransEntry",
    ISSUANCE = "mantle.product.issuance.AssetIssuance",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    ASSET = "mantle.product.asset.Asset"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "sak-op-" + ++keySeq
function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
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
const run = (username, service, parameters) => as(username, () => invoke(service, parameters))
function user(partyId, permissions, organizationPartyId = org) {
    call("create#moqui.security.UserGroup", {userGroupId: partyId + "_G"})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: partyId + "_G", userPermissionId, fromDate: since})
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId: partyId + "_G", fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
const preference = fields =>
    call("update#mantle.ledger.config.PartyAcctgPreference", Object.assign({organizationPartyId: org}, fields))
function receive(productId, quantity, acquireCost) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId: facility,
        locationSeqId: "PICK1",
        ownerPartyId: org,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost,
        acquireCostUomId: "USD"
    }).assetId
}
// a pack: the components issued to the assembly work effort and the kits it can make received (no shipment, so on hand)
function pack(kits, componentOne, componentTwo) {
    call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
        assetId: componentOne,
        workEffortId: state.effort,
        quantity: kits
    })
    call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
        assetId: componentTwo,
        workEffortId: state.effort,
        quantity: kits * 2
    })
    call("mantle.work.ManufacturingServices.produce#AvailableAssemblies", {workEffortId: state.effort})
}
// the WIP account's balance of the work effort's issuances and receipts, every posting and delta
function wipBalance() {
    const issuances = rows(ISSUANCE, {workEffortId: state.effort}).map(row => row.assetIssuanceId)
    const receipts = rows(RECEIPT, {workEffortId: state.effort}).map(row => row.assetReceiptId)
    let balance = 0
    for (const trans of rows(TRANS, {organizationPartyId: org, isPosted: "Y"}))
        if (issuances.includes(trans.assetIssuanceId) || receipts.includes(trans.assetReceiptId))
            for (const entry of rows(ENTRY, {acctgTransId: trans.acctgTransId})) {
                const account = one("mantle.ledger.account.GlAccount", {glAccountId: entry.glAccountId})
                if (account?.glAccountTypeEnumId === "GatWipInventory")
                    balance += (entry.debitCreditFlag === "D" ? 1 : -1) * n(entry.amount)
            }
    return Math.round(balance * 10000) / 10000
}
const preview = (username, assetId, quantity) => run(username, P + "preview#SupportedAssemblyReversal", {assetId, quantity})
const reverse = (username, assetId, quantity, previewKey, operationKey = key()) =>
    run(username, P + "reverse#SupportedAssembly", {operationKey, assetId, quantity, previewKey, reason: "Kit returned unopened"})

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, other]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        user("SAK_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW", "ACCOUNTING_VIEW"])
        user("SAK_READER", ["PRODUCTION_VIEW"])
        user("SAK_OUTSIDER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW"], other)
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        // the pick assembly work effort, as create#ShipmentAssemblyWorkEffort makes one
        state.effort = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepPickAssembly",
            statusId: "WeInProgress",
            ownerPartyId: org,
            facilityId: facility,
            workEffortName: "Kit assembly"
        }).workEffortId
        for (const [productId, typeEnumId, estimatedQuantity] of [
            ["DEMO_PA", "WeptProduce", 10],
            ["DEMO_1_1", "WeptConsume", 10],
            ["DEMO_2_1", "WeptConsume", 20]
        ])
            call("create#mantle.work.effort.WorkEffortProduct", {
                workEffortId: state.effort,
                productId,
                typeEnumId,
                fromDate: "0",
                statusId: "WepdCreated",
                estimatedQuantity
            })
        preference({kitCostFromComponents: "Y"})
        // the first pack: two kits at 2 + 2 x 1 = 4; the second: one kit at 3 + 2 x 1.5 = 6, its own asset
        state.one1 = receive("DEMO_1_1", 10, 2)
        state.two1 = receive("DEMO_2_1", 10, 1)
        pack(2, state.one1, state.two1)
        state.one2 = receive("DEMO_1_1", 5, 3)
        state.two2 = receive("DEMO_2_1", 5, 1.5)
        pack(1, state.one2, state.two2)
        const kits = rows(RECEIPT, {workEffortId: state.effort, productId: "DEMO_PA"}).map(row =>
            one(ASSET, {assetId: row.assetId})
        )
        state.older = kits.find(asset => n(asset.acquireCost) === 4)?.assetId
        state.newer = kits.find(asset => n(asset.acquireCost) === 6)?.assetId
        state.wipBefore = wipBalance()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("a kit reversal is refused naming each forward repost flag while it is off", {
    when() {
        const neither = preview("sak_super", state.newer, 1)
        preference({forwardIssuanceRepostEnabled: "Y"})
        const issuanceOnly = preview("sak_super", state.newer, 1)
        preference({forwardReceiptRepostEnabled: "Y"})
        return {neither, issuanceOnly}
    },
    then({neither, issuanceOnly}) {
        state.older != null
        state.newer != null
        state.wipBefore === 0
        neither.error.includes("FORWARD_REPOST_REQUIRED")
        neither.error.includes("forwardIssuanceRepostEnabled")
        issuanceOnly.error.includes("FORWARD_REPOST_REQUIRED")
        issuanceOnly.error.includes("forwardReceiptRepostEnabled")
    }
})

feature("an older kit, a product that is not a kit, another organization and a reader are refused", {
    when() {
        return {
            older: preview("sak_super", state.older, 1),
            component: preview("sak_super", state.one1, 1),
            outsider: preview("sak_outsider", state.newer, 1),
            reader: reverse("sak_reader", state.newer, 1, "x")
        }
    },
    then({older, component, outsider, reader}) {
        older.error.includes("COST_SLICE_MISMATCH")
        component.error.includes("ASSEMBLY_UNSUPPORTED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        reader.error.includes("PERMISSION_DENIED")
    }
})

feature("the newest DEMO_PA kit is reversed with dated reversing entries in an open period, and WIP nets to zero", {
    when() {
        const receipt = rows(RECEIPT, {assetId: state.newer, workEffortId: state.effort})[0]
        const original = rows(TRANS, {assetReceiptId: receipt.assetReceiptId, isPosted: "Y"})
        const shown = preview("sak_super", state.newer)
        const started = Number(ec.user.nowTimestamp)
        const reverseKey = key()
        const stale = reverse("sak_super", state.newer, 1, "not-the-preview")
        const done = reverse("sak_super", state.newer, 1, shown.reversal?.previewKey, reverseKey)
        const retried = reverse("sak_super", state.newer, 1, shown.reversal?.previewKey, reverseKey)
        const after = rows(TRANS, {assetReceiptId: receipt.assetReceiptId, isPosted: "Y"})
        return {
            shown,
            stale,
            done,
            retried,
            started,
            original,
            after,
            kit: one(ASSET, {assetId: state.newer}),
            secondOne: rows(ISSUANCE, {workEffortId: state.effort, assetId: state.one2})[0],
            secondTwo: rows(ISSUANCE, {workEffortId: state.effort, assetId: state.two2})[0],
            firstTwo: rows(ISSUANCE, {workEffortId: state.effort, assetId: state.two1})[0],
            wip: wipBalance(),
            componentBack: one(ASSET, {assetId: state.two2})
        }
    },
    then(x) {
        x.shown.reversal.quantity === "1"
        x.shown.reversal.kitValue === "6"
        x.shown.reversal.sliceValue === "6"
        x.shown.reversal.componentRows.length === 2
        x.shown.reversal.componentRows.every(row => [state.one2, state.two2].includes(row.assetId))
        x.stale.error.includes("PREVIEW_CHANGED")
        x.done.error === ""
        x.done.result.resultCode === "REVERSED"
        x.retried.result.alreadyApplied === true
        n(x.kit.quantityOnHandTotal) === 0
        // the newest slices are cancelled, the first pack's issues untouched
        n(x.secondOne.quantity) === 0
        n(x.secondTwo.quantity) === 0
        n(x.firstTwo.quantity) === 4
        n(x.componentBack.quantityOnHandTotal) === 5
        // the original receipt posting stays with its date; the reversal is a new entry dated now
        x.original.length === 1
        x.after.length === 2
        x.after.some(
            row =>
                row.acctgTransId === x.original[0].acctgTransId &&
                Number(row.transactionDate) === Number(x.original[0].transactionDate)
        )
        x.after.some(row => row.acctgTransId !== x.original[0].acctgTransId && Number(row.transactionDate) >= x.started)
        x.done.result.acctgTransIds.length >= 3
        x.wip === 0
    }
})

feature("the older pack is then the newest and reverses too; a kit unit already sold is refused", {
    when() {
        const shipmentId = call("create#mantle.shipment.Shipment", {
            shipmentTypeEnumId: "ShpTpSales",
            statusId: "ShipInput",
            fromPartyId: org,
            toPartyId: other
        }).shipmentId
        call("mantle.product.AssetServices.issue#Asset", {assetId: state.older, shipmentId, quantity: 1})
        const sold = preview("sak_super", state.older, 2)
        const shown = preview("sak_super", state.older, 1)
        const done = reverse("sak_super", state.older, 1, shown.reversal?.previewKey)
        return {sold, shown, done, kit: one(ASSET, {assetId: state.older}), wip: wipBalance()}
    },
    then(x) {
        x.sold.error.includes("KIT_SOLD")
        x.shown.reversal.kitValue === "4"
        x.shown.reversal.sliceValue === "4"
        x.done.error === ""
        n(x.kit.quantityOnHandTotal) === 0
        x.wip === 0
    }
})
