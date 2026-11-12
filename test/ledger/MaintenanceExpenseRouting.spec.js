// Accounting's maintenance expense routing (AC-24; design-accounting PostingDefaults "Maintenance expense routing", design-maintenance
// MT-09; impl-maintenance P9, F32, F71): a part issued to a managed maintenance work order posts to the expense account of the
// organization's MaintenanceCostPolicy (the work's facility's nearest row before the organization's), with the facility and cost
// centre on the entry and the project on the transaction, never to WIP; an ordinary work effort of the same owner still posts to
// WIP; with no mapping the issue is refused by name, and an issue that reaches posting anyway goes to the error journal named
// MAINTENANCE_COST_UNMAPPED and does not post; a return credits the issuance's expense with its dimensions at the original cost; a
// retried operation posts once; Accounting's Posting defaults edits the rows (mapping kind maintenance: a row is ended, not
// rewritten, and its facility is the organization's). Standalone: spec-local organizations with their accounting set up from DefaultSettings,
// facilities, parts, groups and users. The stock side is test/work/MaintenanceMaterials.
// Run: ./moq test mr-mantle --spec MaintenanceExpenseRouting
const prefix = "MNT_EXP_SPEC"
const orgA = prefix + "_A",
    orgC = prefix + "_C",
    costCenter = prefix + "_CC",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices.",
    X = "mantle.work.MaintenanceExecutionServices."
const accounts = {site: "613200000", organization: "613100000", wip: "141200000", inventory: "141000000"}
const state = {}
const hour = 3600000

function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        if (!ec.message.hasError()) return out
        const match = /([A-Z][A-Z0-9_]+):/.exec(ec.message.getErrorsString())
        return match ? match[1] : "ERROR " + ec.message.getErrorsString()
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const n = value => (value == null ? null : Number(String(value)))
function organization(partyId, name, accounting = true) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    if (!accounting) return
    call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
        organizationPartyId: partyId,
        sourcePartyId: "DefaultSettings",
        baseCurrencyUomId: "USD"
    })
    call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
        organizationPartyId: partyId,
        filterDate: ec.user.nowTimestamp
    })
}
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance expense " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Expense", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    state[kind + "_PARTY"] = partyId
    return id
}
function facility(facilityId, facilityTypeEnumId, ownerPartyId, parentFacilityId = null) {
    call("create#mantle.facility.Facility", {
        facilityId,
        facilityName: facilityId,
        facilityTypeEnumId,
        ownerPartyId,
        parentFacilityId
    })
    call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "BIN1", locationTypeEnumId: "FltPick"})
}
function stock(productId, quantity, acquireCost, facilityId, ownerPartyId) {
    const assetId = call("mantle.product.AssetServices.receive#Asset", {
        productId,
        quantity,
        facilityId,
        locationSeqId: "BIN1",
        ownerPartyId,
        assetTypeEnumId: "AstTpInventory",
        statusId: "AstAvailable",
        acquireCost
    }).assetId
    call("update#mantle.product.asset.Asset", {assetId, acquireCostUomId: "USD"})
    return assetId
}
const revision = workEffortId => Number(one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId}).revision || 0)
// a started corrective work order on equipment, the planner's, assigned to the technician
function startedWork(planner, tech, techParty, assetId, key) {
    const workEffortId = as(planner, S + "create#MaintenanceWorkOrder", {
        assetId,
        workEffortName: "Expense " + key,
        operationKey: key
    }).workEffortId
    as(planner, S + "schedule#MaintenanceWorkOrder", {
        workEffortId,
        expectedRevision: revision(workEffortId),
        assigneePartyIds: [techParty],
        estimatedStartDate: new Date(Date.now() - hour),
        estimatedCompletionDate: new Date(Date.now() + 4 * hour)
    })
    as(tech, S + "transition#MaintenanceWorkOrder", {workEffortId, action: "start", expectedRevision: revision(workEffortId)})
    return workEffortId
}
// the transactions of a movement (not reversed), each with its entries
function postings(field, id) {
    return rows("mantle.ledger.transaction.AcctgTrans", {[field]: id})
        .filter(row => row.reversedByAcctgTransId == null && row.reverseOfAcctgTransId == null)
        .map(trans => ({trans, entries: rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: trans.acctgTransId})}))
}
const entry = (posting, flag) => posting.entries.find(row => row.debitCreditFlag === flag)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Expense Spec A")
        organization(orgC, "Expense Spec C")
        // a cost centre of A (an internal organization rolling up to it)
        organization(costCenter, "Expense Spec A workshop", false)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: costCenter,
            fromRoleTypeId: "OrgInternal",
            toPartyId: orgA,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_PROJECT",
            workEffortTypeEnumId: "WetProject",
            workEffortName: "Expense spec project",
            ownerPartyId: orgA,
            statusId: "WeInProgress"
        })
        facility(prefix + "_SITE", "FcTpBuilding", orgA)
        facility(prefix + "_ROOM", "FcTpRoom", orgA, prefix + "_SITE")
        facility(prefix + "_WH", "FcTpWarehouse", orgA)
        facility(prefix + "_SITE_C", "FcTpBuilding", orgC)
        facility(prefix + "_WH_C", "FcTpWarehouse", orgC)
        call("create#mantle.product.Product", {
            productId: prefix + "_PART",
            productName: "Expense part",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea"
        })
        for (const [assetId, facilityId, ownerPartyId] of [
            [prefix + "_PUMP", prefix + "_ROOM", orgA],
            [prefix + "_PUMP_C", prefix + "_SITE_C", orgC]
        ])
            call("create#mantle.product.asset.Asset", {
                assetId,
                assetTypeEnumId: "AstTpEquipment",
                assetName: assetId,
                ownerPartyId,
                facilityId
            })
        state.stock = stock(prefix + "_PART", 20, 7.25, prefix + "_WH", orgA)
        state.stockC = stock(prefix + "_PART", 20, 7.25, prefix + "_WH_C", orgC)
        // A's maintenance expense: the site's row (the room is under it) and the organization's
        for (const [maintenanceCostPolicyId, facilityId, glAccountId] of [
            [prefix + "_POL_SITE", prefix + "_SITE", accounts.site],
            [prefix + "_POL_ORG", null, accounts.organization]
        ])
            call("create#mantle.ledger.config.MaintenanceCostPolicy", {
                maintenanceCostPolicyId,
                organizationPartyId: orgA,
                facilityId,
                glAccountId,
                fromDate: since
            })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgA)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "STOCK_ISSUE"], orgA)
        state.plannerC = user("PLANNER_C", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"], orgC)
        state.techC = user("TECH_C", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "STOCK_ISSUE"], orgC)
        state.finance = user("FINANCE", ["ACCOUNTING_ADMIN", "ACCOUNTING_VIEW"], orgA)
        state.work = startedWork(state.planner, state.tech, state.TECH_PARTY, prefix + "_PUMP", prefix + "-a")
        state.charged = as(state.planner, S + "store#MaintenanceWorkOrder", {
            workEffortId: state.work,
            expectedRevision: revision(state.work),
            costCenterId: costCenter,
            projectWorkEffortId: prefix + "_PROJECT"
        })
        state.workC = startedWork(state.plannerC, state.techC, state.TECH_C_PARTY, prefix + "_PUMP_C", prefix + "-c")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a part issued to a work order posts to the mapped expense with its facility, cost centre and project, not WIP", {
    when() {
        const parameters = {operationKey: "exp-1", workEffortId: state.work, assetId: state.stock, quantity: 2}
        const issued = as(state.tech, X + "issue#MaintenanceMaterial", parameters)
        const retry = as(state.tech, X + "issue#MaintenanceMaterial", parameters)
        const badCentre = as(state.planner, S + "store#MaintenanceWorkOrder", {workEffortId: state.work, costCenterId: orgC})
        const issuance = one("mantle.product.issuance.AssetIssuance", {assetIssuanceId: issued.result?.assetIssuanceId})
        return {issued, retry, badCentre, issuance, posted: postings("assetIssuanceId", issued.result?.assetIssuanceId)}
    },
    then({issued, retry, badCentre, issuance, posted}) {
        state.charged.revision != null
        badCentre == "VALUE_INVALID"
        issued.result.resultCode == "ISSUED"
        issuance.costCenterId == costCenter && issuance.projectWorkEffortId == prefix + "_PROJECT"
        // one operation posts once
        retry.result.alreadyApplied === true
        posted.length == 1
        posted[0].trans.isPosted == "Y"
        posted[0].trans.workEffortId == prefix + "_PROJECT"
        // the site's row, the room's nearest; the room owned by A is the facility dimension
        entry(posted[0], "D").glAccountId == accounts.site
        entry(posted[0], "D").facilityId == prefix + "_ROOM"
        entry(posted[0], "D").costCenterId == costCenter
        n(entry(posted[0], "D").amount) == 14.5
        entry(posted[0], "D").glAccountId != accounts.wip
        entry(posted[0], "C").glAccountId == accounts.inventory
        state.issuanceId = issuance.assetIssuanceId
    }
})

feature("an ordinary work effort of the same owner still posts to WIP", {
    when() {
        call("create#mantle.work.effort.WorkEffort", {
            workEffortId: prefix + "_TASK",
            workEffortTypeEnumId: "WetTask",
            workEffortName: "Ordinary task",
            ownerPartyId: orgA,
            statusId: "WeInProgress"
        })
        const issued = call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
            assetId: state.stock,
            workEffortId: prefix + "_TASK",
            quantity: 1,
            noConsumeProduct: "ignore",
            noOriginFacility: "ignore"
        })
        return {posted: postings("assetIssuanceId", issued.assetIssuanceId)}
    },
    then({posted}) {
        posted.length == 1
        entry(posted[0], "D").glAccountId == accounts.wip
        entry(posted[0], "D").facilityId == null
        posted[0].trans.workEffortId == null
    }
})

feature(
    "with no mapping the issue is refused by name; an issue that reaches posting goes to the error journal and does not post",
    {
        when() {
            const refused = as(state.techC, X + "issue#MaintenanceMaterial", {
                operationKey: "exp-c1",
                workEffortId: state.workC,
                assetId: state.stockC,
                quantity: 1
            })
            // the backstop: Mantle's primitive issue to C's managed work, past the maintenance entry point
            const issued = call("mantle.product.AssetServices.issue#AssetToWorkEffort", {
                assetId: state.stockC,
                workEffortId: state.workC,
                quantity: 1,
                noConsumeProduct: "ignore",
                noOriginFacility: "ignore"
            })
            return {refused, posted: postings("assetIssuanceId", issued.assetIssuanceId)}
        },
        then({refused, posted}) {
            refused == "COST_POLICY_MISSING"
            posted.length == 1
            posted[0].trans.isPosted == "N"
            posted[0].trans.postingFailureCode == "MAINTENANCE_COST_UNMAPPED"
            posted[0].trans.postingFailureMessage.includes(orgC)
            entry(posted[0], "D").glAccountId == null
        }
    }
)

feature("a return credits the issuance's expense with the same dimensions at the original cost, posted once", {
    when() {
        // the organization's row ended and a new site row started after the issue: the return follows the issuance, not them
        call("update#mantle.ledger.config.MaintenanceCostPolicy", {
            maintenanceCostPolicyId: prefix + "_POL_SITE",
            thruDate: ec.user.nowTimestamp
        })
        const parameters = {operationKey: "exp-r1", assetIssuanceId: state.issuanceId, quantity: 1, reason: "One spare"}
        const returned = as(state.tech, X + "return#MaintenanceMaterial", parameters)
        const retry = as(state.tech, X + "return#MaintenanceMaterial", parameters)
        return {returned, retry, posted: postings("assetReceiptId", returned.result?.assetReceiptId)}
    },
    then({returned, retry, posted}) {
        returned.result.resultCode == "RETURNED"
        retry.result.alreadyApplied === true && retry.result.assetReceiptId == returned.result.assetReceiptId
        posted.length == 1
        posted[0].trans.isPosted == "Y"
        posted[0].trans.workEffortId == prefix + "_PROJECT"
        entry(posted[0], "C").glAccountId == accounts.site
        entry(posted[0], "C").facilityId == prefix + "_ROOM"
        entry(posted[0], "C").costCenterId == costCenter
        n(entry(posted[0], "C").amount) == 7.25
        entry(posted[0], "D").glAccountId == accounts.inventory
    }
})

feature("Posting defaults maps maintenance expense by kind and facility; a row is ended, not rewritten", {
    when() {
        const store = (mapping, extra = {}) =>
            as(
                state.finance,
                "mantle.ledger.SetupServices.store#PostingDefault",
                Object.assign({organizationPartyId: orgA, mappingKind: "maintenance", mapping, changeReason: "Spec"}, extra)
            )
        const added = store({
            maintenanceKindEnumId: "MkPreventive",
            facilityId: prefix + "_WH",
            glAccountId: accounts.organization
        })
        const row = one("mantle.ledger.config.MaintenanceCostPolicy", {
            maintenanceKindEnumId: "MkPreventive",
            facilityId: prefix + "_WH"
        })
        const otherFacility = store({facilityId: prefix + "_WH_C", glAccountId: accounts.site})
        const rewritten = store(
            {maintenanceCostPolicyId: row.maintenanceCostPolicyId, glAccountId: accounts.site},
            {lastUpdatedStamp: row.lastUpdatedStamp}
        )
        const ended = store(
            {
                maintenanceCostPolicyId: row.maintenanceCostPolicyId,
                maintenanceKindEnumId: "MkPreventive",
                facilityId: prefix + "_WH",
                glAccountId: accounts.organization,
                fromDate: row.fromDate,
                thruDate: new Date(Date.now() + hour)
            },
            {lastUpdatedStamp: row.lastUpdatedStamp}
        )
        const listed = as(state.finance, "mantle.ledger.SetupServices.get#PostingDefaults", {
            organizationPartyId: orgA,
            mappingKind: "maintenance"
        })
        return {added, row, otherFacility, rewritten, ended, listed}
    },
    then({added, row, otherFacility, rewritten, ended, listed}) {
        added.complete === true
        row.organizationPartyId == orgA && row.fromDate != null
        otherFacility.startsWith("ERROR") && otherFacility.includes("outside the mapping organization")
        rewritten.startsWith("ERROR") && rewritten.includes("End this maintenance expense mapping")
        ended.complete === true
        one("mantle.ledger.config.MaintenanceCostPolicy", {maintenanceCostPolicyId: row.maintenanceCostPolicyId}).thruDate != null
        listed.mappingKindOptions.some(option => option.key == "maintenance")
        listed.mappingRows.some(r => r.mappingKeyText.startsWith("Preventive") && r.mappingKeyText.includes(prefix + "_WH"))
    }
})
