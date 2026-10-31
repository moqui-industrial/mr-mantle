// Warehouse adjustments, scrap, lot corrections and repack (mantle.shipment.WarehouseTaskServices, StockAdjustments.js;
// impl-warehouse P6): an adjuster previews and posts a count of one lot bucket with a reason, the variance posting by its
// reason; None differs from Any; a movement after the preview, a closed fiscal period and a missing permission refuse it;
// its value is shown only with ACCOUNTING_VIEW; a scrapped expired lot posts once to the scrap account on a scrap
// PhysicalInventory; extending a lot's expiry needs LOT_EXPIRY_EXTEND and keeps the old and new values with the reason;
// unpacking 2 cases into 24 units carries the lot and the unit cost and nets to zero in WIP; a retry posts nothing twice.
// The organization, users and products are spec-local.
const T = "mantle.shipment.WarehouseTaskServices."
const org = "WHA_ORG",
    facility = "WHA_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
let keySeq = 0
const key = () => "wha-op-" + ++keySeq

function as(username, action) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
// a call's result with its error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
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
const run = (username, service, parameters) => as(username, () => invoke(T + service, parameters))
function ensureGroup(userGroupId, permissions) {
    if (!one("moqui.security.UserGroup", {userGroupId})) call("create#moqui.security.UserGroup", {userGroupId})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function user(partyId, userGroupIds, organizationPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    for (const userGroupId of userGroupIds)
        call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId, fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, locationSeqId, extra = {}) {
    const out = call(
        "mantle.product.AssetServices.receive#Asset",
        Object.assign(
            {
                productId,
                quantity,
                facilityId: facility,
                locationSeqId,
                ownerPartyId: org,
                assetTypeEnumId: "AstTpInventory",
                statusId: "AstAvailable",
                acquireCost: 10,
                acquireCostUomId: "USD"
            },
            extra
        )
    )
    return out.assetId
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const qoh = assetId => n(asset(assetId).quantityOnHandTotal)
// the net of an account's entries (debits less credits) over transactions
function net(acctgTransIds, glAccountId) {
    return acctgTransIds
        .flatMap(acctgTransId => rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId, glAccountId}))
        .reduce((sum, row) => sum + (row.debitCreditFlag === "D" ? 1 : -1) * n(row.amount), 0)
}
function dayText(offsetDays) {
    return ec.l10n.format(new Date(Date.now() + offsetDays * 86400000), "yyyy-MM-dd")
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ensureGroup("WHA_ADJUSTERS", ["STOCK_ADJUST"])
        ensureGroup("WHA_FINANCE", ["ACCOUNTING_VIEW"])
        ensureGroup("WHA_QUALITY", ["LOT_EXPIRY_EXTEND"])
        ensureGroup("WHA_MOVERS", ["STOCK_MOVE", "PRODUCT_CATALOG_VIEW"])
        ensureGroup("WHA_READERS", [])
        for (const partyId of [org, "WHA_OTHER"]) {
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
        // a closed fiscal month 400 days back, for the backdated adjustment
        call("create#mantle.party.time.TimePeriod", {
            timePeriodId: "WHA_CLOSED",
            partyId: org,
            timePeriodTypeId: "FiscalMonth",
            periodName: "Closed month",
            fromDate: dayText(-415),
            thruDate: dayText(-385),
            isClosed: "Y"
        })
        // the organization's inventory mapping (copied from DefaultSettings) gains a scrap account (F40)
        const mapping = rows("mantle.ledger.config.AssetTypeGlAccount", {
            organizationPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            classEnumId: null,
            assetId: null
        })[0]
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: mapping.assetTypeGlAccountId,
            scrapGlAccountId: "519200000"
        })
        user("WHA_ADJUSTER", ["WHA_ADJUSTERS"], org)
        user("WHA_FINANCIAL", ["WHA_ADJUSTERS", "WHA_FINANCE"], org)
        user("WHA_QUALITY", ["WHA_QUALITY"], org)
        user("WHA_MOVER", ["WHA_MOVERS"], org)
        user("WHA_READER", ["WHA_READERS"], org)
        user("WHA_OUTSIDER", ["WHA_ADJUSTERS", "WHA_MOVERS"], "WHA_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        for (const [locationSeqId, locationTypeEnumId] of [
            ["PICK1", "FltPick"],
            ["BULK1", "FltBulk"],
            ["QUAR1", "FltQuarantine"],
            ["MORGUE1", "FltMorgue"]
        ])
            call("create#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId, locationTypeEnumId})
        for (const [locationTypeEnumId, autoStatusId] of [
            ["FltPick", "AstAvailable"],
            ["FltQuarantine", "AstQuarantine"],
            ["FltMorgue", "AstMorgue"]
        ])
            call("create#mantle.facility.FacilityLocationType", {facilityId: facility, locationTypeEnumId, autoStatusId})
        for (const productId of ["WHA_COUNTED", "WHA_DATED", "WHA_SCRAP", "WHA_UNIT", "WHA_CASE", "WHA_LOOSE"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                ownerPartyId: org,
                amountUomId: "OTH_ea"
            })
        call("create#mantle.product.ProductAssoc", {
            productId: "WHA_CASE",
            toProductId: "WHA_UNIT",
            productAssocTypeEnumId: "PatPackagingFor",
            fromDate: since,
            quantity: 12
        })
        for (const [lotId, expirationDate] of [
            ["WHA_LOT_A", dayText(400)],
            ["WHA_LOT_B", dayText(300)],
            ["WHA_LOT_OLD", dayText(-30)],
            ["WHA_LOT_FIX", dayText(60)]
        ])
            call("create#mantle.product.asset.Lot", {lotId, lotNumber: lotId, expirationDate})
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("an adjuster previews and posts a count of one lot bucket with a reason, and a retry answers the first", {
    when() {
        ec.artifactExecution.disableAuthz()
        const lotA = receive("WHA_COUNTED", 10, "BULK1", {lotId: "WHA_LOT_A"})
        const lotB = receive("WHA_COUNTED", 4, "BULK1", {lotId: "WHA_LOT_B"})
        const noLot = receive("WHA_COUNTED", 3, "BULK1")
        ec.artifactExecution.enableAuthz()
        const bucket = {productId: "WHA_COUNTED", facilityId: facility, locationSeqId: "BULK1", lotId: "WHA_LOT_A"}
        const preview = run("wha_adjuster", "preview#StockAdjustment", Object.assign({mode: "count", quantity: 7}, bucket))
        const post = Object.assign({mode: "count", quantity: 7}, bucket, {
            operationKey: key(),
            previewFingerprint: preview.preview?.previewFingerprint,
            varianceReasonEnumId: "InVrLost",
            comments: "Cycle count"
        })
        const noReason = run("wha_adjuster", "adjust#Stock", Object.assign({}, post, {varianceReasonEnumId: null}))
        const reader = run("wha_reader", "adjust#Stock", post)
        const first = run("wha_adjuster", "adjust#Stock", post)
        const retry = run("wha_adjuster", "adjust#Stock", post)
        const outsider = run("wha_outsider", "preview#StockAdjustment", Object.assign({mode: "count", quantity: 7}, bucket))
        // None (the default without a lot) is the stock with no lot; Any is every lot's
        const none = run("wha_adjuster", "preview#StockAdjustment", {
            productId: "WHA_COUNTED",
            facilityId: facility,
            locationSeqId: "BULK1",
            mode: "count",
            quantity: 0
        })
        const any = run("wha_adjuster", "preview#StockAdjustment", {
            productId: "WHA_COUNTED",
            facilityId: facility,
            locationSeqId: "BULK1",
            lotScope: "any",
            mode: "count",
            quantity: 0
        })
        const physicalInventoryId = first.result?.physicalInventoryId
        return {
            lotA,
            lotB,
            noLot,
            preview: preview.preview,
            previewError: preview.error,
            noReason,
            reader,
            first,
            retry,
            outsider,
            none: none.preview,
            any: any.preview,
            physicalInventory: physicalInventoryId ? one("mantle.product.asset.PhysicalInventory", {physicalInventoryId}) : null,
            details: physicalInventoryId ? rows("mantle.product.asset.AssetDetail", {physicalInventoryId}) : [],
            trans: physicalInventoryId ? rows("mantle.ledger.transaction.AcctgTrans", {physicalInventoryId}) : []
        }
    },
    then(r) {
        r.previewError == ""
        r.preview.quantityBefore == "10" && r.preview.quantityChange == "-3" && r.preview.quantityAfter == "7"
        r.preview.assets.length == 1 && r.preview.assets[0].assetId == r.lotA
        // cost is not read for a user without financial read
        r.preview.valueIncluded === false && r.preview.valueChange === undefined
        r.noReason.error.includes("REASON_REQUIRED")
        r.reader.error.includes("PERMISSION_DENIED")
        r.first.error == ""
        r.first.result.resultCode == "ADJUSTED" && r.first.result.alreadyApplied === false
        r.retry.result.alreadyApplied === true && r.retry.result.physicalInventoryId == r.first.result.physicalInventoryId
        qoh(r.lotA) == 7 && qoh(r.lotB) == 4 && qoh(r.noLot) == 3
        r.physicalInventory.statusId == "PIComplete" && r.physicalInventory.scrapIndicator == null
        r.details.length == 1 && r.details[0].varianceReasonEnumId == "InVrLost" && n(r.details[0].quantityOnHandDiff) == -3
        // the variance posts once, at the asset's cost, to shrinkage
        r.trans.length == 1
        r.outsider.error.includes("RECORD_UNAVAILABLE")
        r.none.quantityBefore == "3" && r.none.locationScope == "value" && r.none.lotScope == "none"
        r.any.quantityBefore == "14" && r.any.lotScope == "any"
    }
})

feature("a movement after the preview refuses the adjustment, and its value shows only with financial read", {
    when() {
        ec.artifactExecution.disableAuthz()
        const source = receive("WHA_COUNTED", 5, "PICK1")
        ec.artifactExecution.enableAuthz()
        const bucket = {assetId: source, mode: "delta", quantity: -2}
        const plain = run("wha_adjuster", "preview#StockAdjustment", bucket)
        const financial = run("wha_financial", "preview#StockAdjustment", bucket)
        ec.artifactExecution.disableAuthz()
        call("mantle.product.AssetServices.record#PhysicalInventoryChange", {
            productId: "WHA_COUNTED",
            facilityId: facility,
            quantityChange: -1,
            assetList: [asset(source)],
            varianceReasonEnumId: "InVrDamaged"
        })
        ec.artifactExecution.enableAuthz()
        const stale = run(
            "wha_adjuster",
            "adjust#Stock",
            Object.assign({}, bucket, {
                operationKey: key(),
                previewFingerprint: plain.preview.previewFingerprint,
                varianceReasonEnumId: "InVrLost"
            })
        )
        const tooMuch = run("wha_adjuster", "preview#StockAdjustment", {assetId: source, mode: "delta", quantity: -9})
        const future = run("wha_adjuster", "preview#StockAdjustment", {
            assetId: source,
            mode: "count",
            quantity: 1,
            physicalInventoryDate: ec.l10n.parseTimestamp(dayText(3) + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
        })
        return {source, plain: plain.preview, financial: financial.preview, stale, tooMuch, future}
    },
    then({source, plain, financial, stale, tooMuch, future}) {
        plain.valueIncluded === false && plain.valueChange === undefined
        financial.valueIncluded === true && financial.valueChange == "-20" && financial.valueAvailable === true
        stale.error.includes("PREVIEW_CHANGED")
        qoh(source) == 4
        tooMuch.error.includes("QUANTITY_EXCEEDS_ON_HAND")
        future.error.includes("DATE_INVALID")
    }
})

feature("a backdated adjustment into a closed period is refused, and the default period posts", {
    when() {
        ec.artifactExecution.disableAuthz()
        const receivedDate = ec.l10n.parseTimestamp(dayText(-500) + " 09:00:00", "yyyy-MM-dd HH:mm:ss")
        const source = receive("WHA_DATED", 6, "BULK1", {receivedDate})
        ec.artifactExecution.enableAuthz()
        const backdated = ec.l10n.parseTimestamp(dayText(-400) + " 12:00:00", "yyyy-MM-dd HH:mm:ss")
        const scope = {assetId: source, mode: "count", quantity: 5, physicalInventoryDate: backdated}
        const preview = run("wha_adjuster", "preview#StockAdjustment", scope)
        const closed = run(
            "wha_adjuster",
            "adjust#Stock",
            Object.assign({}, scope, {
                operationKey: key(),
                previewFingerprint: preview.preview.previewFingerprint,
                varianceReasonEnumId: "InVrLost"
            })
        )
        const today = {assetId: source, mode: "count", quantity: 5}
        const todayPreview = run("wha_adjuster", "preview#StockAdjustment", today)
        const open = run(
            "wha_adjuster",
            "adjust#Stock",
            Object.assign({}, today, {
                operationKey: key(),
                previewFingerprint: todayPreview.preview.previewFingerprint,
                varianceReasonEnumId: "InVrLost"
            })
        )
        return {source, preview, closed, open}
    },
    then({source, preview, closed, open}) {
        preview.preview.quantityBefore == "6"
        closed.error.includes("PERIOD_CLOSED")
        open.error == "" && open.result.quantityChange == "-1"
        qoh(source) == 5
    }
})

feature("a scrapped expired lot moves to the morgue, posts once to the scrap account and is a scrap inventory", {
    when() {
        ec.artifactExecution.disableAuthz()
        const expired = receive("WHA_SCRAP", 8, "BULK1", {lotId: "WHA_LOT_OLD"})
        const held = receive("WHA_SCRAP", 2, "QUAR1", {statusId: "AstQuarantine"})
        ec.artifactExecution.enableAuthz()
        const parameters = {
            operationKey: key(),
            assetId: expired,
            quantity: 3,
            varianceReasonEnumId: "InVrExpired",
            toLocationSeqId: "MORGUE1",
            comments: "Expired"
        }
        const wrongReason = run("wha_adjuster", "scrap#Asset", Object.assign({}, parameters, {varianceReasonEnumId: "InVrLost"}))
        const notMorgue = run("wha_adjuster", "scrap#Asset", Object.assign({}, parameters, {toLocationSeqId: "PICK1"}))
        const mover = run("wha_mover", "scrap#Asset", parameters)
        const first = run("wha_adjuster", "scrap#Asset", parameters)
        const retry = run("wha_adjuster", "scrap#Asset", parameters)
        const quarantined = run("wha_adjuster", "scrap#Asset", {
            operationKey: key(),
            assetId: held,
            varianceReasonEnumId: "InVrScrap"
        })
        const physicalInventoryId = first.result?.physicalInventoryId
        return {
            expired,
            held,
            wrongReason,
            notMorgue,
            mover,
            first,
            retry,
            quarantined,
            physicalInventory: physicalInventoryId ? one("mantle.product.asset.PhysicalInventory", {physicalInventoryId}) : null,
            trans: physicalInventoryId ? rows("mantle.ledger.transaction.AcctgTrans", {physicalInventoryId}) : []
        }
    },
    then(r) {
        r.wrongReason.error.includes("REASON_INVALID")
        r.notMorgue.error.includes("LOCATION_NOT_MORGUE")
        r.mover.error.includes("PERMISSION_DENIED")
        r.first.error == ""
        r.first.result.resultCode == "SCRAPPED" && r.first.result.statusId == "AstMorgue"
        r.first.result.scrappedAssetId != r.expired && r.first.result.locationSeqId == "MORGUE1"
        r.first.result.warnings.some(warning => warning.code == "EXPIRED")
        r.retry.result.alreadyApplied === true
        qoh(r.expired) == 5 && qoh(r.first.result.scrappedAssetId) == 0
        asset(r.first.result.scrappedAssetId).statusId == "AstMorgue"
        // one scrap PhysicalInventory, which Counts leave out, and one posting to the scrap account
        r.physicalInventory.scrapIndicator == "Y"
        r.trans.length == 1
        net([r.trans[0].acctgTransId], "519200000") == 30
        r.quarantined.error.includes("HELD_STOCK")
        qoh(r.held) == 2
    }
})

feature("extending a lot's expiry needs LOT_EXPIRY_EXTEND and keeps the old and new values with the reason", {
    when() {
        ec.artifactExecution.disableAuthz()
        const stock = receive("WHA_SCRAP", 4, "BULK1", {lotId: "WHA_LOT_FIX", expectedEndOfLife: dayText(60)})
        const held = receive("WHA_SCRAP", 1, "QUAR1", {lotId: "WHA_LOT_FIX", statusId: "AstQuarantine"})
        ec.artifactExecution.enableAuthz()
        const later = dayText(120)
        const extend = {operationKey: key(), lotId: "WHA_LOT_FIX", expirationDate: later, changeReason: "Retested"}
        const byAdjuster = run("wha_adjuster", "correct#LotMetadata", extend)
        const noReason = run("wha_quality", "correct#LotMetadata", Object.assign({}, extend, {changeReason: ""}))
        const byQuality = run("wha_quality", "correct#LotMetadata", extend)
        const retry = run("wha_quality", "correct#LotMetadata", extend)
        const renumber = run("wha_quality", "correct#LotMetadata", {
            operationKey: key(),
            lotId: "WHA_LOT_FIX",
            lotNumber: "WHA-FIX-2",
            changeReason: "Typo"
        })
        const shorten = run("wha_adjuster", "correct#LotMetadata", {
            operationKey: key(),
            lotId: "WHA_LOT_FIX",
            expirationDate: dayText(90),
            lotNumber: "WHA-FIX-2",
            changeReason: "Supplier notice"
        })
        const audit = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.product.asset.Lot",
            changedFieldName: "expirationDate",
            pkPrimaryValue: "WHA_LOT_FIX"
        })
        return {stock, held, later, byAdjuster, noReason, byQuality, retry, renumber, shorten, audit}
    },
    then(r) {
        r.byAdjuster.error.includes("PERMISSION_DENIED")
        r.noReason.error.includes("REASON_REQUIRED")
        r.byQuality.error == ""
        r.byQuality.result.expiryExtended === true
        r.byQuality.result.changes[0].field == "expirationDate" && r.byQuality.result.changes[0].newValue == r.later
        r.byQuality.result.assetIds.includes(r.stock)
        r.retry.result.alreadyApplied === true
        // the quality manager extends; a renumber needs STOCK_ADJUST
        r.renumber.error.includes("PERMISSION_DENIED")
        r.shorten.error == "" && r.shorten.result.changes.length == 2
        String(one("mantle.product.asset.Lot", {lotId: "WHA_LOT_FIX"}).lotNumber) == "WHA-FIX-2"
        r.audit.some(row => row.changeReason == "Retested" && row.changedByUserId == "WHA_QUALITY")
        // extending the expiry releases no quarantine
        asset(r.held).statusId == "AstQuarantine"
    }
})

feature("unpacking 2 cases into 24 units carries the lot and the unit cost, nets to zero, and a retry posts nothing twice", {
    when() {
        ec.artifactExecution.disableAuthz()
        const cases = receive("WHA_CASE", 5, "BULK1", {lotId: "WHA_LOT_A", acquireCost: 24})
        const loose = receive("WHA_LOOSE", 5, "BULK1")
        ec.artifactExecution.enableAuthz()
        const parameters = {operationKey: key(), assetId: cases, quantity: 2, toLocationSeqId: "PICK1"}
        const preview = run("wha_mover", "preview#Repack", {assetId: cases, quantity: 2})
        const adjuster = run("wha_adjuster", "repack#Asset", parameters)
        const first = run("wha_mover", "repack#Asset", parameters)
        const retry = run("wha_mover", "repack#Asset", parameters)
        const noPack = run("wha_mover", "repack#Asset", {operationKey: key(), assetId: loose, quantity: 1})
        const result = first.result || {}
        const units = result.toAssetId ? asset(result.toAssetId) : null
        const receipt = result.assetReceiptId
            ? one("mantle.product.receipt.AssetReceipt", {assetReceiptId: result.assetReceiptId})
            : null
        const trans = [
            ...rows("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: result.assetIssuanceId || "-"}),
            ...rows("mantle.ledger.transaction.AcctgTrans", {assetReceiptId: result.assetReceiptId || "-"})
        ].map(row => row.acctgTransId)
        // repack 12 units back into a case, and 5 units are not whole cases
        const back = run("wha_mover", "repack#Asset", {
            operationKey: key(),
            assetId: result.toAssetId,
            quantity: 12,
            targetProductId: "WHA_CASE"
        })
        const partial = run("wha_mover", "repack#Asset", {
            operationKey: key(),
            assetId: result.toAssetId,
            quantity: 5,
            targetProductId: "WHA_CASE"
        })
        return {
            cases,
            preview,
            adjuster,
            first,
            retry,
            noPack,
            units,
            receipt,
            trans,
            effort: result.workEffortId ? one("mantle.work.effort.WorkEffort", {workEffortId: result.workEffortId}) : null,
            back,
            partial
        }
    },
    then(r) {
        r.preview.error == "" && r.preview.preview.direction == "unpack" && r.preview.preview.targetQuantity == "24"
        r.preview.preview.costIncluded === false && r.preview.preview.unitCost === undefined
        r.adjuster.error.includes("PERMISSION_DENIED")
        r.first.error == ""
        r.first.result.direction == "unpack" && r.first.result.targetProductId == "WHA_UNIT"
        r.first.result.targetQuantity == "24"
        r.retry.result.alreadyApplied === true && r.retry.result.toAssetId == r.first.result.toAssetId
        qoh(r.cases) == 3
        r.units.productId == "WHA_UNIT" && n(r.units.quantityOnHandTotal) == 24
        r.units.lotId == "WHA_LOT_A" && n(r.units.acquireCost) == 2 && r.units.locationSeqId == "PICK1"
        r.receipt.sourceAssetIssuanceId == r.first.result.assetIssuanceId && n(r.receipt.appliedConversionFactor) == 12
        r.effort.purposeEnumId == "WepAssembling" && r.effort.ownerPartyId == org && r.effort.statusId == "WeComplete"
        // the issue and the receipt post once each and net to zero in WIP and in inventory
        r.trans.length == 2
        net(r.trans, "141200000") == 0
        net(r.trans, "141000000") == 0
        r.noPack.error.includes("PACK_UNDEFINED")
        r.back.error == "" && r.back.result.direction == "repack" && r.back.result.targetQuantity == "1"
        r.partial.error.includes("QUANTITY_NOT_WHOLE_PACKS")
    }
})
