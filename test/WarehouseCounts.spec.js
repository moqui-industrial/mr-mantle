// Counts with snapshots, review and guarded posting (mantle.product.InventoryCountServices; impl-warehouse P10) and the
// count schedule (WarehousePolicyServices.store#CountSchedule): a pick-face location type counted every 30 days, the
// facility's annual date and a location that just reached zero each come due, the earlier date winning; a blind count
// snapshots its scope, gives a counter no expected quantity, finds a move made during counting and a recount resolves it;
// the approved lines post once per asset, an uncounted line stays unchanged, a failed line is named and a retry posts
// nothing twice; the count-entry import names its bad rows. The users are in spec-local groups.
const C = "mantle.product.InventoryCountServices."
const org = "WCN_ORG",
    facility = "WCN_FAC"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? 0 : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const daysAgo = days => new Date(Date.now() - days * 86400000).toISOString()
// the blind count the scenario's features share, in order
const state = {}
let keySeq = 0
const key = () => "wcn-op-" + ++keySeq

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
const run = (username, service, parameters) => as(username, () => invoke(C + service, parameters))
function ensureGroup(userGroupId, permissions) {
    if (!one("moqui.security.UserGroup", {userGroupId})) call("create#moqui.security.UserGroup", {userGroupId})
    for (const userPermissionId of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function user(partyId, userGroupId, organizationPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: partyId})
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId.toLowerCase(),
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId, fromDate: since})
    call("create#mantle.party.PartyRelationship", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
}
function receive(productId, quantity, locationSeqId, facilityId = facility, ownerPartyId = org) {
    return call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId,
        ownerPartyId,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost: 2
    }).assetId
}
function location(locationSeqId, locationTypeEnumId, lastCountDate = null, facilityId = facility) {
    call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId, locationTypeEnumId, lastCountDate})
}
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
const line = (physicalInventoryId, assetId) => one("mantle.product.asset.PhysicalInventoryCount", {physicalInventoryId, assetId})
// a line of the scenario's first count, which belongs to no other count
const lineOfFirst = () =>
    rows("mantle.product.asset.PhysicalInventoryCount", {physicalInventoryId: state.count})[0].physicalInventoryCountId
const dueOf = (rowsDue, locationSeqId) => rowsDue.find(row => row.locationSeqId === locationSeqId && row.itemType === "location")

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ensureGroup("WCN_COUNTERS", ["STOCK_COUNT"])
        ensureGroup("WCN_REVIEWERS", ["STOCK_COUNT_REVIEW"])
        ensureGroup("WCN_ADJUSTERS", ["STOCK_ADJUST"])
        ensureGroup("WCN_MANAGERS", ["STOCK_POLICY_MANAGE"])
        ensureGroup("WCN_PICKERS", ["SHIPMENT_PICK"])
        ensureGroup("WCN_MOVERS", ["STOCK_MOVE"])
        for (const partyId of [org, "WCN_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        user("WCN_COUNTER", "WCN_COUNTERS", org)
        user("WCN_REVIEWER", "WCN_REVIEWERS", org)
        user("WCN_ADJUSTER", "WCN_ADJUSTERS", org)
        user("WCN_MANAGER", "WCN_MANAGERS", org)
        user("WCN_PICKER", "WCN_PICKERS", org)
        user("WCN_MOVER", "WCN_MOVERS", org)
        user("WCN_OUTSIDER", "WCN_COUNTERS", "WCN_OTHER")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.Facility", {facilityId: "WCN_DUE", facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        // the blind count's bins
        for (const [locationSeqId, locationTypeEnumId] of [
            ["A1", "FltBulk"],
            ["A2", "FltBulk"],
            ["A3", "FltBulk"],
            ["B1", "FltBulk"],
            ["IMP1", "FltBulk"],
            ["C1", "FltBulk"],
            ["C2", "FltBulk"]
        ])
            location(locationSeqId, locationTypeEnumId)
        // the due facility: pick faces counted 31 and 10 days ago, a bulk bin counted over a year ago, and a bin emptied
        location("PF_OLD", "FltPick", daysAgo(31), "WCN_DUE")
        location("PF_NEW", "FltPick", daysAgo(10), "WCN_DUE")
        location("BULK_YEAR", "FltBulk", daysAgo(370), "WCN_DUE")
        location("ZERO1", "FltBulk", daysAgo(40), "WCN_DUE")
        for (const productId of ["WCN_WIDGET", "WCN_BOLT", "WCN_NUT", "WCN_FOUND", "WCN_EMPTY", "WCN_IMPORT", "WCN_DRIFT"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea"
            })
        ec.artifactExecution.enableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})

feature("a pick-face type every 30 days, the annual date and a location just at zero each come due, the earlier date winning", {
    when() {
        ec.artifactExecution.disableAuthz()
        const emptied = receive("WCN_EMPTY", 3, "ZERO1", "WCN_DUE")
        call("mantle.product.AssetServices.change#AssetQuantity", {assetId: emptied, quantityDiff: -3, productId: "WCN_EMPTY"})
        ec.artifactExecution.enableAuthz()
        const month = Number(ec.l10n.format(ec.user.nowTimestamp, "MM"))
        const day = Number(ec.l10n.format(ec.user.nowTimestamp, "dd"))
        const store = (username, parameters) =>
            as(username, () =>
                invoke(
                    "mantle.facility.WarehousePolicyServices.store#CountSchedule",
                    Object.assign({organizationPartyId: org, changeReason: "Cycle count program"}, parameters)
                )
            )
        const counterStore = store("wcn_counter", {
            facilityId: "WCN_DUE",
            scheduleKindEnumId: "CskAnnual",
            annualMonth: month,
            annualDay: day
        })
        const periodic = store("wcn_manager", {
            facilityId: "WCN_DUE",
            locationTypeEnumId: "FltPick",
            scheduleKindEnumId: "CskPeriodic",
            frequencyDays: 30,
            countModeEnumId: "CntModeCycle",
            blindIndicator: "Y"
        })
        const annual = store("wcn_manager", {
            facilityId: "WCN_DUE",
            scheduleKindEnumId: "CskAnnual",
            annualMonth: month,
            annualDay: day
        })
        const zero = store("wcn_manager", {facilityId: "WCN_DUE", scheduleKindEnumId: "CskZero"})
        const mixed = store("wcn_manager", {
            facilityId: "WCN_DUE",
            locationTypeEnumId: "FltPick",
            abcClassEnumId: "AbcA",
            scheduleKindEnumId: "CskPeriodic",
            frequencyDays: 7
        })
        const due = run("wcn_counter", "find#DueCounts", {facilityId: "WCN_DUE"})
        const reader = run("wcn_mover", "find#DueCounts", {facilityId: "WCN_DUE"})
        const outsider = run("wcn_outsider", "find#DueCounts", {facilityId: "WCN_DUE"})
        const listed = as("wcn_counter", () =>
            invoke("mantle.facility.WarehousePolicyServices.find#CountSchedules", {
                organizationPartyId: org,
                facilityId: "WCN_DUE"
            })
        )
        return {
            counterStore,
            periodic,
            annual,
            zero,
            mixed,
            due,
            reader,
            outsider,
            listed,
            today: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
        }
    },
    then({counterStore, periodic, annual, zero, mixed, due, reader, outsider, listed, today}) {
        counterStore.error.includes("POLICY_MANAGE_REQUIRED")
        periodic.error == ""
        annual.error == ""
        zero.error == ""
        mixed.error.includes("POLICY_INVALID")
        due.error == ""
        // the old pick face is due by its 30 days (yesterday), before the annual date (today)
        dueOf(due.dueRows, "PF_OLD").kind == "periodic"
        dueOf(due.dueRows, "PF_OLD").overdue == true
        dueOf(due.dueRows, "PF_OLD").blindIndicator == "Y"
        // the newer pick face (next in 20 days) and the bulk bin come due on the annual date, today
        dueOf(due.dueRows, "PF_NEW").kind == "annual"
        dueOf(due.dueRows, "PF_NEW").nextDate == today
        dueOf(due.dueRows, "BULK_YEAR").kind == "annual"
        // the bin emptied since its last count is due for zero confirmation, from the day it reached zero
        dueOf(due.dueRows, "ZERO1").kind == "zero"
        dueOf(due.dueRows, "ZERO1").nextDate == today
        reader.error.includes("PERMISSION_DENIED")
        outsider.error == ""
        outsider.dueCount == 0
        listed.error == ""
        listed.schedules.length == 3
        listed.schedules.some(row => row.dueText == "Every 30 days")
    }
})

feature("a blind count snapshots its scope and a counter never receives an expected quantity", {
    when() {
        ec.artifactExecution.disableAuthz()
        state.widget = receive("WCN_WIDGET", 10, "A1")
        state.bolt = receive("WCN_BOLT", 20, "A2")
        state.nut = receive("WCN_NUT", 5, "A3")
        state.away = receive("WCN_WIDGET", 7, "B1")
        ec.artifactExecution.enableAuthz()
        const created = run("wcn_counter", "create#Count", {
            facilityId: facility,
            assetIds: [state.widget, state.bolt, state.nut],
            countModeEnumId: "CntModeSpot",
            blindIndicator: "Y"
        })
        state.count = created.physicalInventoryId
        const outsider = run("wcn_outsider", "start#Count", {physicalInventoryId: state.count})
        const reviewer = run("wcn_reviewer", "start#Count", {physicalInventoryId: state.count})
        const started = run("wcn_counter", "start#Count", {physicalInventoryId: state.count})
        const seen = run("wcn_counter", "get#Count", {physicalInventoryId: state.count})
        const listed = run("wcn_counter", "find#Counts", {facilityId: facility})
        return {created, outsider, reviewer, started, seen, listed}
    },
    then({created, outsider, reviewer, started, seen, listed}) {
        created.error == ""
        created.blindIndicator == "Y"
        outsider.error.includes("RECORD_UNAVAILABLE")
        reviewer.error.includes("PERMISSION_DENIED")
        started.error == ""
        started.lineCount == 3
        seen.error == ""
        seen.count.statusId == "PIInProgress"
        seen.expectedShown == false
        seen.lines.length == 3
        seen.lines.every(row => row.snapshotQuantity === undefined && row.varianceQuantity === undefined)
        // the snapshot is on the line, kept on the server
        n(line(state.count, state.widget).snapshotQuantity) == 10
        listed.counts.some(row => row.physicalInventoryId == state.count && row.lineCount == 3)
    }
})

feature("counting saves observations only; a move during counting is found at review and a recount resolves it", {
    when() {
        const lineOf = assetId => line(state.count, assetId).physicalInventoryCountId
        const widget = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: lineOf(state.widget),
            quantity: 9
        })
        const bolt = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: lineOf(state.bolt),
            quantity: 20
        })
        const negative = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: lineOf(state.bolt),
            quantity: -1
        })
        const blankQuantity = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: lineOf(state.bolt)
        })
        // stock found that the snapshot did not hold, and a line of the snapshot named again by its stock
        const found = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            productId: "WCN_FOUND",
            locationSeqId: "A3",
            quantity: 4
        })
        const duplicate = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            productId: "WCN_BOLT",
            locationSeqId: "A2",
            quantity: 1
        })
        const unchanged = n(asset(state.widget).quantityOnHandTotal)
        // part of the bolts moves away while the count is open
        const moved = as("wcn_mover", () =>
            invoke("mantle.shipment.WarehouseTaskServices.move#Stock", {
                operationKey: key(),
                assetId: state.bolt,
                quantity: 5,
                toLocationSeqId: "B1"
            })
        )
        const submitted = run("wcn_counter", "submit#Count", {physicalInventoryId: state.count})
        const lateEntry = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: lineOf(state.widget),
            quantity: 8
        })
        const counterReview = run("wcn_counter", "review#Count", {physicalInventoryId: state.count})
        const reviewed = run("wcn_reviewer", "review#Count", {physicalInventoryId: state.count})
        const reviewerView = run("wcn_reviewer", "get#Count", {physicalInventoryId: state.count})
        const counterView = run("wcn_counter", "get#Count", {physicalInventoryId: state.count})
        const boltLine = line(state.count, state.bolt)
        const recount = run("wcn_reviewer", "resolve#CountConflict", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: boltLine.physicalInventoryCountId
        })
        const afterRecount = line(state.count, state.bolt)
        const recounted = run("wcn_counter", "record#CountLine", {
            physicalInventoryId: state.count,
            physicalInventoryCountId: boltLine.physicalInventoryCountId,
            quantity: 15
        })
        const resubmitted = run("wcn_counter", "submit#Count", {physicalInventoryId: state.count})
        const reviewedAgain = run("wcn_reviewer", "review#Count", {physicalInventoryId: state.count})
        state.reviewVersion = reviewedAgain.reviewVersion
        return {
            widget,
            bolt,
            negative,
            blankQuantity,
            found,
            duplicate,
            unchanged,
            moved,
            submitted,
            lateEntry,
            counterReview,
            reviewed,
            reviewerView,
            counterView,
            recount,
            afterRecount,
            recounted,
            resubmitted,
            reviewedAgain,
            boltAfter: line(state.count, state.bolt),
            nutAfter: line(state.count, state.nut)
        }
    },
    then(r) {
        r.widget.error == ""
        r.widget.result.line.snapshotQuantity === undefined
        r.bolt.error == ""
        r.negative.error.includes("QUANTITY_INVALID")
        r.blankQuantity.error.includes("QUANTITY_REQUIRED")
        r.found.error == ""
        r.found.result.line.extra == true
        r.duplicate.error.includes("LINE_EXISTS")
        r.unchanged == 10
        r.moved.error == ""
        r.submitted.error == ""
        r.lateEntry.error.includes("COUNT_NOT_IN_PROGRESS")
        r.counterReview.error.includes("PERMISSION_DENIED")
        r.reviewed.error == ""
        // the widget and the stock found are approved, the moved bolts are a conflict, the uncounted nut skipped
        r.reviewed.approvedCount == 2
        r.reviewed.conflictCount == 1
        r.reviewed.skippedCount == 1
        r.reviewerView.expectedShown == true
        r.reviewerView.lines.some(row => row.statusId == "PicConflict" && row.movements.length == 1)
        // a counter still gets no expected quantity once the blind count is submitted
        r.counterView.expectedShown == false
        r.counterView.lines.every(row => row.approvedDelta === undefined)
        r.recount.error == ""
        r.recount.countStatusId == "PIInProgress"
        r.afterRecount.statusId == "PicOpen"
        n(r.afterRecount.snapshotQuantity) == 15
        r.afterRecount.recountNumber == 1
        r.recounted.error == ""
        r.resubmitted.error == ""
        r.reviewedAgain.error == ""
        r.reviewedAgain.conflictCount == 0
        r.boltAfter.statusId == "PicApproved"
        n(r.boltAfter.approvedDelta) == 0
        r.nutAfter.statusId == "PicSkipped"
        r.nutAfter.skipReasonEnumId == "CntSkNotCounted"
    }
})

feature(
    "the approved lines post once per asset, the uncounted line is unchanged, a failed line is named, a retry posts nothing twice",
    {
        when() {
            const parameters = {physicalInventoryId: state.count, reviewVersion: state.reviewVersion}
            const counter = run("wcn_counter", "post#Count", Object.assign({operationKey: key()}, parameters))
            const reviewer = run("wcn_reviewer", "post#Count", Object.assign({operationKey: key()}, parameters))
            const stale = run("wcn_adjuster", "post#Count", Object.assign({operationKey: key()}, parameters, {reviewVersion: 99}))
            // the stock found has nowhere to go: its bin closes after the review
            ec.artifactExecution.disableAuthz()
            call("update#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId: "A3", thruDate: daysAgo(1)})
            ec.artifactExecution.enableAuthz()
            const operationKey = key()
            const first = run("wcn_adjuster", "post#Count", Object.assign({operationKey}, parameters))
            const same = run("wcn_adjuster", "post#Count", Object.assign({operationKey}, parameters))
            ec.artifactExecution.disableAuthz()
            call("update#mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId: "A3", thruDate: null})
            ec.artifactExecution.enableAuthz()
            const retry = run("wcn_adjuster", "post#Count", Object.assign({operationKey: key()}, parameters))
            const details = assetId => rows("mantle.product.asset.AssetDetail", {assetId, physicalInventoryId: state.count})
            return {
                counter,
                reviewer,
                stale,
                first,
                same,
                retry,
                widget: asset(state.widget),
                nut: asset(state.nut),
                widgetDetails: details(state.widget),
                boltDetails: details(state.bolt),
                foundAssets: rows("mantle.product.asset.Asset", {productId: "WCN_FOUND", facilityId: facility}),
                count: one("mantle.product.asset.PhysicalInventory", {physicalInventoryId: state.count}),
                location: one("mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId: "A1"}),
                productFacility: one("mantle.facility.ProductFacility", {facilityId: facility, productId: "WCN_WIDGET"}),
                nutLocation: one("mantle.facility.FacilityLocation", {facilityId: facility, locationSeqId: "A3"})
            }
        },
        then(r) {
            r.counter.error.includes("PERMISSION_DENIED")
            r.reviewer.error.includes("PERMISSION_DENIED")
            r.stale.error.includes("REVIEW_CHANGED")
            r.first.error == ""
            r.first.result.resultCode == "PARTIAL"
            r.first.result.failedCount == 1
            r.first.result.results.some(row => !row.ok && row.reasonCode == "LOCATION_CLOSED")
            r.first.result.countStatusId == "PIInValidation"
            r.same.result.alreadyApplied == true
            r.retry.error == ""
            r.retry.result.resultCode == "POSTED"
            r.retry.result.postedCount == 1
            r.retry.result.countStatusId == "PIComplete"
            // the widget lost 1 once; the bolts (counted right after the recount) and the nut (not counted) are unchanged
            n(r.widget.quantityOnHandTotal) == 9
            r.widgetDetails.length == 1
            n(r.widgetDetails[0].quantityOnHandDiff) == -1
            r.widgetDetails[0].varianceReasonEnumId == "InVrLost"
            r.boltDetails.length == 0
            n(r.nut.quantityOnHandTotal) == 5
            r.foundAssets.length == 1
            n(r.foundAssets[0].quantityOnHandTotal) == 4
            r.count.statusId == "PIComplete"
            r.location.lastCountDate != null
            r.productFacility.lastCountDate != null
        }
    }
)

feature("the count-entry import saves its good rows and names the bad ones; a preview saves nothing", {
    when() {
        ec.artifactExecution.disableAuthz()
        const stock = receive("WCN_IMPORT", 6, "IMP1")
        ec.artifactExecution.enableAuthz()
        const created = run("wcn_counter", "create#Count", {
            facilityId: facility,
            scopeLocationSeqId: "IMP1",
            blindIndicator: "N"
        })
        run("wcn_counter", "start#Count", {physicalInventoryId: created.physicalInventoryId})
        const csvText = "asset,quantity,comments\n" + stock + ",6,shelf\nNO_SUCH,3,\n" + stock + ",-2,\n"
        const preview = run("wcn_counter", "import#CountLines", {
            physicalInventoryId: created.physicalInventoryId,
            csvText,
            preview: true
        })
        const previewLine = line(created.physicalInventoryId, stock)
        const saved = run("wcn_counter", "import#CountLines", {physicalInventoryId: created.physicalInventoryId, csvText})
        const shortPick = run("wcn_picker", "request#Count", {
            facilityId: facility,
            assetIds: [stock],
            countSourceEnumId: "CntSrcShortPick"
        })
        const again = run("wcn_picker", "request#Count", {
            facilityId: facility,
            assetIds: [stock],
            countSourceEnumId: "CntSrcShortPick"
        })
        const pickerRequest = run("wcn_picker", "request#Count", {facilityId: facility, assetIds: [stock]})
        const due = run("wcn_counter", "find#DueCounts", {facilityId: facility})
        return {
            preview,
            previewLine,
            saved,
            savedLine: line(created.physicalInventoryId, stock),
            shortPick,
            again,
            pickerRequest,
            due
        }
    },
    then({preview, previewLine, saved, savedLine, shortPick, again, pickerRequest, due}) {
        preview.error == ""
        preview.savedCount == 0
        previewLine.quantityOnHand == null
        saved.error == ""
        saved.savedCount == 1
        saved.failedCount == 2
        saved.results.some(row => row.rowNumber == 3 && row.reasonCode == "ROW_INVALID")
        saved.results.some(row => row.rowNumber == 4 && row.reasonCode == "QUANTITY_INVALID")
        saved.resultCsv.includes("rowNumber")
        n(savedLine.quantityOnHand) == 6
        savedLine.statusId == "PicCounted"
        shortPick.error == ""
        shortPick.existing == false
        again.physicalInventoryId == shortPick.physicalInventoryId
        again.existing == true
        pickerRequest.error.includes("PERMISSION_DENIED")
        due.dueRows.some(row => row.kind == "shortPick" && row.physicalInventoryId == shortPick.physicalInventoryId)
    }
})

feature("a planned count changes its scope and cancels; the variance report and the due notice reach their users only", {
    when() {
        const created = run("wcn_counter", "create#Count", {facilityId: facility, scopeLocationSeqId: "A1", blindIndicator: "N"})
        const physicalInventoryId = created.physicalInventoryId
        const updated = run("wcn_counter", "update#Count", {
            physicalInventoryId,
            scopeLocationSeqId: "A2",
            expectedScopeVersion: 1
        })
        const stale = run("wcn_counter", "update#Count", {physicalInventoryId, scopeLocationSeqId: "A3", expectedScopeVersion: 1})
        const cancelled = run("wcn_counter", "cancel#Count", {physicalInventoryId})
        const startCancelled = run("wcn_counter", "start#Count", {physicalInventoryId})
        const reviewerVariance = run("wcn_reviewer", "find#CountVariance", {facilityId: facility})
        const counterVariance = run("wcn_counter", "find#CountVariance", {facilityId: facility})
        ec.artifactExecution.disableAuthz()
        const notified = invoke(C + "notify#DueCounts", {})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "WarehouseCountsDue", recordId: "WCN_DUE"})
        const recipients = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId}).map(
                  row => row.userId
              )
            : []
        const again = invoke(C + "notify#DueCounts", {})
        ec.artifactExecution.enableAuthz()
        return {
            updated,
            stale,
            cancelled,
            startCancelled,
            count: one("mantle.product.asset.PhysicalInventory", {physicalInventoryId}),
            reviewerVariance,
            counterVariance,
            notified,
            notices: rows("moqui.security.user.NotificationMessage", {topic: "WarehouseCountsDue", recordId: "WCN_DUE"}),
            recipients,
            again
        }
    },
    then(r) {
        r.updated.error == ""
        r.updated.scopeVersion == 2
        r.stale.error.includes("COUNT_CHANGED")
        r.cancelled.error == ""
        r.count.statusId == "PICancelled"
        r.count.scopeLocationSeqId == "A2"
        r.startCancelled.error.includes("COUNT_NOT_PLANNED")
        r.reviewerVariance.error == ""
        r.reviewerVariance.varianceRows.some(row => row.physicalInventoryId == state.count && row.postedDelta == "-1")
        r.counterVariance.error.includes("PERMISSION_DENIED")
        r.notified.error == ""
        // once a day: the second run sends no second notice
        r.notices.length == 1
        r.recipients.includes("WCN_COUNTER")
        !r.recipients.includes("WCN_OUTSIDER")
    }
})

feature(
    "a post finds stock changed or moved since the review (STOCK_MOVED), a moved asset is counted again, a line is its count's",
    {
        when() {
            ec.artifactExecution.disableAuthz()
            const changed = receive("WCN_DRIFT", 8, "C1")
            const steady = receive("WCN_DRIFT", 5, "C1")
            const moved = receive("WCN_DRIFT", 3, "C1")
            ec.artifactExecution.enableAuthz()
            const created = run("wcn_counter", "create#Count", {
                facilityId: facility,
                assetIds: [changed, steady, moved],
                blindIndicator: "N"
            })
            const physicalInventoryId = created.physicalInventoryId
            run("wcn_counter", "start#Count", {physicalInventoryId})
            const lineId = assetId => line(physicalInventoryId, assetId).physicalInventoryCountId
            for (const [assetId, quantity] of [
                [changed, 7],
                [steady, 5],
                [moved, 3]
            ])
                run("wcn_counter", "record#CountLine", {physicalInventoryId, physicalInventoryCountId: lineId(assetId), quantity})
            const otherCount = run("wcn_counter", "record#CountLine", {
                physicalInventoryId,
                physicalInventoryCountId: lineOfFirst(),
                quantity: 1
            })
            run("wcn_counter", "submit#Count", {physicalInventoryId})
            const reviewed = run("wcn_reviewer", "review#Count", {physicalInventoryId})
            // after the review: one asset's quantity changes, another moves whole to another bin
            ec.artifactExecution.disableAuthz()
            call("mantle.product.AssetServices.change#AssetQuantity", {
                assetId: changed,
                quantityDiff: -1,
                productId: "WCN_DRIFT"
            })
            call("mantle.product.AssetServices.move#Asset", {
                assetId: moved,
                facilityId: facility,
                locationSeqId: "C2",
                quantity: 3
            })
            ec.artifactExecution.enableAuthz()
            const posted = run("wcn_adjuster", "post#Count", {
                operationKey: key(),
                physicalInventoryId,
                reviewVersion: reviewed.reviewVersion
            })
            const carryMoved = run("wcn_reviewer", "resolve#CountConflict", {
                physicalInventoryId,
                physicalInventoryCountId: lineId(moved),
                resolution: "carry",
                varianceReasonEnumId: "InVrLost"
            })
            const recountChanged = run("wcn_reviewer", "resolve#CountConflict", {
                physicalInventoryId,
                physicalInventoryCountId: lineId(changed)
            })
            const reenter = run("wcn_counter", "record#CountLine", {
                physicalInventoryId,
                physicalInventoryCountId: lineId(moved),
                quantity: 3
            })
            const early = run("wcn_counter", "record#CountLine", {
                physicalInventoryId,
                physicalInventoryCountId: lineId(changed),
                quantity: 6,
                countDate: "2001-01-01T00:00:00Z"
            })
            const pickerScope = run("wcn_picker", "request#Count", {
                facilityId: facility,
                scopeProductId: "WCN_DRIFT",
                countSourceEnumId: "CntSrcShortPick"
            })
            return {
                otherCount,
                reviewed,
                posted,
                carryMoved,
                recountChanged,
                reenter,
                early,
                pickerScope,
                changedLine: line(physicalInventoryId, changed),
                steadyLine: line(physicalInventoryId, steady),
                movedLine: line(physicalInventoryId, moved),
                changedQuantity: n(asset(changed).quantityOnHandTotal)
            }
        },
        then(r) {
            r.otherCount.error.includes("RECORD_UNAVAILABLE")
            r.reviewed.approvedCount == 3
            r.posted.error == ""
            r.posted.result.resultCode == "PARTIAL"
            r.posted.result.results.filter(row => !row.ok).every(row => row.reasonCode == "STOCK_MOVED")
            r.posted.result.failedCount == 2
            r.steadyLine.statusId == "PicPosted"
            // the changed asset's line is a conflict again, and nothing posted to it
            r.changedQuantity == 7
            r.carryMoved.error.includes("MOVED_RECOUNT")
            r.recountChanged.error == ""
            r.changedLine.statusId == "PicOpen"
            r.reenter.error.includes("LINE_REVIEWED")
            r.early.error.includes("COUNT_DATE_INVALID")
            r.movedLine.statusId == "PicConflict"
            r.pickerScope.error.includes("SCOPE_INVALID")
        }
    }
)
