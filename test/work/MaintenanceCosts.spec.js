// Maintenance costs (mantle.work.MaintenanceReportServices.get#MaintenanceCosts, MaintenanceSettingsServices
// store#MaintenancePolicy's cost threshold and the Approve gate's cost half; IronStone Maintenance design §3 WorkCosts, §8
// MaintenanceCostReport, §9; review Y2; impl-maintenance P11 and §4): labor is approved hours at the costing rate of the
// technician's position class (get#CostingRate, never the entry's vendorHourRate), and approved hours of a technician with no
// rate are shown unpriced, unapproved hours apart; the root's and the step's time are each counted once; parts are issued less
// returned at the asset's cost; an outside-service line accepted and billed counts once, from its bill, and its currency is
// never added to another; a planner is answered no amount. The threshold's cost half: planned work estimated over the
// organization's cost threshold, and planned work with a part that has no approved standard cost, wait for a supervisor; work
// under both thresholds is approved, on create and by the planner; the work policy's save keeps the cost threshold, and an
// unset threshold is not compared. Standalone: a spec-local organization with its accounting configuration, a position class
// and its costing rate, a part with an approved standard cost and one without, a supplier, equipment, groups and users, the
// services called as each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec MaintenanceCosts
const prefix = "MNT_COST_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_ORG2",
    supplier = prefix + "_SUP",
    part = prefix + "_PART",
    oddPart = prefix + "_ODD",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.work.MaintenanceServices.",
    R = "mantle.work.MaintenanceReportServices.",
    T = "mantle.work.MaintenanceSettingsServices.",
    X = "mantle.work.MaintenanceExecutionServices."
const state = {}
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const hoursAgo = hours => new Date(Date.now() - hours * 3600000)
const number = value => (value == null ? null : Number(String(value)))

// the service's answer as a user, or the reason code it refuses with (and its message)
function as(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return call(service, parameters)
    } catch (error) {
        const match = /([A-Z][A-Z0-9_]+):/.exec(String(error.message))
        state.lastMessage = String(error.message)
        return match ? match[1] : "ERROR " + error.message
    } finally {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// a user of a spec-local group with the permissions, an agent of the organization
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Maintenance costs " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Costs", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: org,
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
// a row written directly (no posting SECA: the spec's organization keeps no ledger mapping)
const write = (entity, fields) => ec.entity.makeValue(entity).setAll(fields).create()
// a time entry of the technician through the work order's own entry point
const recordTime = (username, workEffortId, from, thru) =>
    as(username, S + "record#MaintenanceTime", {workEffortId, fromDate: hoursAgo(from), thruDate: hoursAgo(thru)}).timeEntryId
const approve = (username, workEffortId) => as(username, S + "transition#MaintenanceWorkOrder", {workEffortId, action: "approve"})
const status = workEffortId => one("mantle.work.effort.WorkEffort", {workEffortId}).statusId

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Costs Spec Org", "OrgInternal")
        organization(otherOrg, "Costs Spec Other Org", "OrgInternal")
        organization(supplier, "Costs Spec Rewinds", "Supplier", org)
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("create#mantle.facility.Facility", {
            facilityId: prefix + "_SITE",
            facilityName: "Costs site",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: org
        })
        call("create#mantle.product.asset.Asset", {
            assetId: prefix + "_PUMP",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Costs spec pump",
            ownerPartyId: org,
            facilityId: prefix + "_SITE"
        })
        state.planner = user("PLANNER", ["MAINTENANCE_VIEW", "MAINTENANCE_PLAN"])
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.tech2 = user("TECH2", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE"])
        state.cost = user("COST", ["MAINTENANCE_VIEW", "MAINTENANCE_COST_VIEW"])
        state.settings = user("SETTINGS", ["MAINTENANCE_VIEW", "MAINTENANCE_SETTINGS_EDIT"])
        // the technician's position class and its costing rate, 40 USD an hour (the organization's row); the second
        // technician holds no position, so no costing rate applies to their hours
        call("create#mantle.humanres.position.EmplPositionClass", {
            emplPositionClassId: prefix + "_CLASS",
            title: "Costs spec technician"
        })
        call("create#mantle.humanres.position.EmplPosition", {
            emplPositionId: prefix + "_POSITION",
            organizationPartyId: org,
            emplPositionClassId: prefix + "_CLASS"
        })
        call("create#mantle.humanres.position.EmplPositionParty", {
            emplPositionId: prefix + "_POSITION",
            partyId: state.TECH_PARTY,
            roleTypeId: "Employee",
            fromDate: new Date(since)
        })
        call("create#mantle.humanres.rate.RateAmount", {
            rateAmountId: prefix + "_RATE",
            rateTypeEnumId: "RatpStandard",
            ratePurposeEnumId: "RaprCost",
            emplPositionClassId: prefix + "_CLASS",
            organizationPartyId: org,
            rateAmount: 40,
            rateCurrencyUomId: "USD",
            timePeriodUomId: "TF_hr",
            fromDate: new Date(since)
        })
        // a part with an approved standard cost of 20 USD, and one with none
        for (const [productId, productName] of [
            [part, "Costs spec bearing"],
            [oddPart, "Costs spec seal"]
        ])
            call("create#mantle.product.Product", {
                productId,
                productName,
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea",
                ownerPartyId: org,
                statusId: "PrdActive"
            })
        write("mantle.product.cost.ProductStandardCost", {
            productStandardCostId: prefix + "_STD",
            productId: part,
            organizationPartyId: org,
            state: "approved",
            fromDate: new Date(since),
            quantity: 1,
            priceUomId: "USD",
            unitCost: 20,
            totalCost: 20
        })
        call("create#mantle.product.Product", {
            productId: prefix + "_REWIND",
            productName: "Costs spec rewind",
            productTypeEnumId: "PtService",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        // the repair: corrective work on the pump, both technicians assigned, started, with a step in progress
        const created = as(state.planner, S + "create#MaintenanceWorkOrder", {
            assetId: prefix + "_PUMP",
            workEffortName: "Pump seal leak",
            estimatedCompletionDate: new Date(Date.now() + 7 * 86400000)
        })
        state.work = created.workEffortId
        state.assetMaintenanceId = created.assetMaintenanceId
        as(state.planner, S + "schedule#MaintenanceWorkOrder", {
            workEffortId: state.work,
            assigneePartyIds: [state.TECH_PARTY, state.TECH2_PARTY]
        })
        as(state.tech, S + "transition#MaintenanceWorkOrder", {workEffortId: state.work, action: "start"})
        state.step = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepMaintenance",
            rootWorkEffortId: state.work,
            parentWorkEffortId: state.work,
            ownerPartyId: org,
            statusId: "WeInProgress",
            workEffortName: "Replace the bearing",
            timeUomId: "TF_hr"
        }).workEffortId
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "labor is approved hours at the class's costing rate, the root's and the step's once; hours with no rate and unapproved hours are apart",
    {
        when() {
            state.rootEntry = recordTime(state.tech, state.work, 10, 9)
            state.stepEntry = recordTime(state.tech, state.step, 8, 6)
            state.openEntry = recordTime(state.tech, state.work, 5, 4.5)
            state.tech2Entry = recordTime(state.tech2, state.work, 10, 8.5)
            // the timesheets approved, but the last of the technician's hours (taken off its timesheet); a vendor rate written on
            // an entry is never read
            for (const id of [state.rootEntry, state.stepEntry, state.tech2Entry]) {
                const entry = one("mantle.work.time.TimeEntry", {timeEntryId: id})
                if (entry.timesheetId)
                    call("update#mantle.work.time.Timesheet", {timesheetId: entry.timesheetId, statusId: "TmshApproved"})
                else {
                    const timesheetId = prefix + "_TS_" + entry.partyId
                    if (!one("mantle.work.time.Timesheet", {timesheetId}))
                        call("create#mantle.work.time.Timesheet", {timesheetId, partyId: entry.partyId, statusId: "TmshApproved"})
                    call("update#mantle.work.time.TimeEntry", {timeEntryId: id, timesheetId})
                }
            }
            call("update#mantle.work.time.TimeEntry", {timeEntryId: state.openEntry, timesheetId: null})
            call("update#mantle.work.time.TimeEntry", {timeEntryId: state.rootEntry, vendorHourRate: 99})
            const read = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: state.work, component: "labor"})
            return {read: read.costs}
        },
        then({read}) {
            const labor = read.sourceList.filter(row => row.component == "labor")
            labor.length == 4
            labor.filter(row => row.state == "priced").length == 2
            labor.filter(row => row.state == "priced").every(row => row.rateText.includes("Costs spec technician"))
            labor.find(row => row.sourceId == state.rootEntry).amount.compare(40) == 0
            labor.find(row => row.sourceId == state.stepEntry).amount.compare(80) == 0
            labor.find(row => row.sourceId == state.stepEntry).stepName == "Replace the bearing"
            labor.find(row => row.sourceId == state.tech2Entry).state == "unpriced"
            labor.find(row => row.sourceId == state.tech2Entry).amount == null
            labor.find(row => row.sourceId == state.openEntry).state == "unapproved"
            read.totalList.length == 1
            read.totalList[0].currencyUomId == "USD"
            read.totalList[0].labor.compare(120) == 0
            number(read.unpricedHours) == 1.5
            number(read.unapprovedHours) == 0.5
        }
    }
)

feature(
    "parts are issued less returned at cost; an accepted and billed service counts once, from its bill, in its own currency; a planner is answered no amount",
    {
        when() {
            write("mantle.product.asset.Asset", {
                assetId: prefix + "_STOCK",
                assetTypeEnumId: "AstTpInventory",
                productId: part,
                ownerPartyId: org,
                facilityId: prefix + "_SITE",
                acquireCost: 20,
                acquireCostUomId: "USD",
                quantityOnHandTotal: 7,
                availableToPromiseTotal: 7
            })
            write("mantle.product.issuance.AssetIssuance", {
                assetIssuanceId: prefix + "_ISS",
                assetId: prefix + "_STOCK",
                productId: part,
                workEffortId: state.step,
                quantity: 3,
                issuedDate: hoursAgo(7)
            })
            write("mantle.product.receipt.AssetReceipt", {
                assetReceiptId: prefix + "_RET",
                assetId: prefix + "_STOCK",
                productId: part,
                workEffortId: state.step,
                sourceAssetIssuanceId: prefix + "_ISS",
                quantityAccepted: 1,
                receivedDate: hoursAgo(6)
            })
            // the rewind: a purchase order line in euros linked to the work, accepted, and billed at 320
            write("mantle.order.OrderHeader", {
                orderId: prefix + "_PO",
                statusId: "OrderPlaced",
                currencyUomId: "EUR",
                entryDate: hoursAgo(48)
            })
            write("mantle.order.OrderPart", {
                orderId: prefix + "_PO",
                orderPartSeqId: "01",
                customerPartyId: org,
                vendorPartyId: supplier
            })
            write("mantle.order.OrderItem", {
                orderId: prefix + "_PO",
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                productId: prefix + "_REWIND",
                itemDescription: "Motor rewind",
                quantity: 1,
                unitAmount: 300
            })
            write("mantle.product.maintenance.AssetMaintenanceOrderItem", {
                assetMaintenanceId: state.assetMaintenanceId,
                orderId: prefix + "_PO",
                orderItemSeqId: "01"
            })
            write("mantle.order.purchase.ServiceAcceptance", {
                serviceAcceptanceId: prefix + "_ACC",
                orderId: prefix + "_PO",
                orderItemSeqId: "01",
                acceptedQuantity: 1,
                acceptedDate: hoursAgo(3)
            })
            write("mantle.account.invoice.Invoice", {
                invoiceId: prefix + "_BILL",
                invoiceTypeEnumId: "InvoiceSales",
                fromPartyId: supplier,
                toPartyId: org,
                statusId: "InvoiceApproved",
                currencyUomId: "EUR",
                invoiceDate: hoursAgo(2)
            })
            write("mantle.account.invoice.InvoiceItem", {
                invoiceId: prefix + "_BILL",
                invoiceItemSeqId: "01",
                productId: prefix + "_REWIND",
                quantity: 1,
                amount: 320
            })
            write("mantle.order.OrderItemBilling", {
                orderItemBillingId: prefix + "_OIB",
                orderId: prefix + "_PO",
                orderItemSeqId: "01",
                invoiceId: prefix + "_BILL",
                invoiceItemSeqId: "01",
                quantity: 1,
                amount: 320
            })
            const read = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: state.step}).costs
            const report = as(state.cost, R + "get#MaintenanceCosts", {organizationPartyId: org}).costs
            const planner = as(state.planner, R + "get#MaintenanceCosts", {workEffortId: state.work})
            const otherOrganization = as(state.cost, R + "get#MaintenanceCosts", {organizationPartyId: otherOrg})
            return {read, report, planner, otherOrganization}
        },
        then({read, report, planner, otherOrganization}) {
            const usd = read.totalList.find(row => row.currencyUomId == "USD")
            const eur = read.totalList.find(row => row.currencyUomId == "EUR")
            read.totalList.length == 2
            usd.parts.compare(40) == 0
            usd.labor.compare(120) == 0
            usd.total.compare(160) == 0
            eur.outside.compare(320) == 0
            eur.total.compare(320) == 0
            eur.pending.compare(0) == 0
            read.sourceList.filter(row => row.component == "outside").length == 1
            read.sourceList.find(row => row.component == "outside").sourceType == "bill"
            read.sourceList.find(row => row.sourceType == "return").amount.compare(-20) == 0
            read.estimate != null
            report.workOrderCount >= 1
            report.totalList.find(row => row.currencyUomId == "USD").total.compare(160) == 0
            planner == "PERMISSION_DENIED"
            otherOrganization == "ORGANIZATION_DENIED"
        }
    }
)

feature(
    "planned work over the cost threshold or with an unpriced part waits for a supervisor; under both thresholds it is approved; the policy's save keeps the threshold",
    {
        when() {
            as(state.settings, T + "store#MaintenancePolicy", {organizationPartyId: org, approvalThresholdHours: 10})
            const threshold = as(state.settings, T + "store#MaintenancePolicy", {
                organizationPartyId: org,
                approvalThresholdCost: 500
            })
            // a later save of the work policy keeps the cost threshold
            as(state.settings, T + "store#MaintenancePolicy", {
                organizationPartyId: org,
                approvalThresholdHours: 10,
                comments: "Spec"
            })
            const kept = as(state.settings, T + "get#MaintenancePolicy", {organizationPartyId: org}).policy
            const plannerPolicy = as(state.planner, T + "get#MaintenancePolicy", {organizationPartyId: org}).policy
            const plan = (name, hours, parts) => {
                const created = as(state.planner, S + "create#MaintenanceWorkOrder", {
                    assetId: prefix + "_PUMP",
                    workEffortName: name,
                    maintenanceKindEnumId: "MkPreventive",
                    estimatedWorkTime: hours
                })
                if (parts) {
                    as(state.planner, S + "schedule#MaintenanceWorkOrder", {
                        workEffortId: created.workEffortId,
                        assigneePartyIds: [state.TECH_PARTY]
                    })
                    for (const [productId, estimatedQuantity] of parts)
                        as(state.planner, X + "store#MaintenanceMaterial", {
                            workEffortId: created.workEffortId,
                            productId,
                            estimatedQuantity
                        })
                }
                return created
            }
            // no hours and no parts: under both, approved on create
            const nothing = plan("Look over the pump", 0)
            // two hours and nobody assigned: the estimate is unknown, held
            const unassigned = plan("Pump alignment", 2)
            // two hours at 40 and two bearings at 20: 120, under 500
            const under = plan("Pump bearing service", 2, [[part, 2]])
            // two hours and thirty bearings: 680, over 500
            const over = plan("Pump overhaul", 2, [[part, 30]])
            // one hour and a seal with no approved standard cost: unknown, held
            const odd = plan("Pump seal change", 1, [[oddPart, 1]])
            const underApproved = approve(state.planner, under.workEffortId)
            const overRefused = approve(state.planner, over.workEffortId)
            const overMessage = state.lastMessage
            const oddRefused = approve(state.planner, odd.workEffortId)
            const estimate = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: over.workEffortId}).costs.estimate
            const oddEstimate = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: odd.workEffortId}).costs.estimate
            const supervisorApproves = approve(state.supervisor, over.workEffortId)
            // unset, the cost is not compared: the seal's work is the planner's to approve
            as(state.settings, T + "store#MaintenancePolicy", {organizationPartyId: org, approvalThresholdCost: ""})
            const unsetApproved = approve(state.planner, odd.workEffortId)
            // P11 review: the second technician now holds a class of 60 USD an hour; with both on the work its hours take the higher
            // rate. A threshold in euros leaves the estimate unknown (the costs are in dollars), so the planner cannot approve it
            call("create#mantle.humanres.position.EmplPositionClass", {
                emplPositionClassId: prefix + "_LEAD",
                title: "Costs spec lead"
            })
            call("create#mantle.humanres.position.EmplPosition", {
                emplPositionId: prefix + "_LEAD_POSITION",
                organizationPartyId: org,
                emplPositionClassId: prefix + "_LEAD"
            })
            call("create#mantle.humanres.position.EmplPositionParty", {
                emplPositionId: prefix + "_LEAD_POSITION",
                partyId: state.TECH2_PARTY,
                roleTypeId: "Employee",
                fromDate: new Date(since)
            })
            call("create#mantle.humanres.rate.RateAmount", {
                rateAmountId: prefix + "_LEAD_RATE",
                rateTypeEnumId: "RatpStandard",
                ratePurposeEnumId: "RaprCost",
                emplPositionClassId: prefix + "_LEAD",
                organizationPartyId: org,
                rateAmount: 60,
                rateCurrencyUomId: "USD",
                timePeriodUomId: "TF_hr",
                fromDate: new Date(since)
            })
            as(state.settings, T + "store#MaintenancePolicy", {
                organizationPartyId: org,
                approvalThresholdCost: 500,
                approvalThresholdCurrencyUomId: "EUR"
            })
            const pair = plan("Pump rebuild", 2, [[part, 2]])
            as(state.planner, S + "schedule#MaintenanceWorkOrder", {
                workEffortId: pair.workEffortId,
                assigneePartyIds: [state.TECH_PARTY, state.TECH2_PARTY]
            })
            const euroEstimate = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: pair.workEffortId}).costs.estimate
            const euroRefused = approve(state.planner, pair.workEffortId)
            // a field not sent is kept (P18): the currency is emptied by name, back to the organization's
            as(state.settings, T + "store#MaintenancePolicy", {
                organizationPartyId: org,
                approvalThresholdCost: 500,
                approvalThresholdCurrencyUomId: ""
            })
            const pairEstimate = as(state.cost, R + "get#MaintenanceCosts", {workEffortId: pair.workEffortId}).costs.estimate
            const pairApproved = approve(state.planner, pair.workEffortId)
            // the ended policies carry the threshold to the settings editor, never to the planner (P11 merge with P18)
            const settingsEnded = as(state.settings, T + "get#MaintenancePolicy", {organizationPartyId: org}).ended
            const plannerEnded = as(state.planner, T + "get#MaintenancePolicy", {organizationPartyId: org}).ended
            as(state.settings, T + "store#MaintenancePolicy", {organizationPartyId: org, approvalThresholdCost: ""})
            return {
                settingsEnded,
                plannerEnded,
                euroEstimate,
                euroRefused,
                pairEstimate,
                pairApproved,
                threshold,
                kept,
                plannerPolicy,
                nothing,
                unassigned,
                under,
                underApproved,
                overRefused,
                overMessage,
                oddRefused,
                estimate,
                oddEstimate,
                supervisorApproves,
                unsetApproved,
                over
            }
        },
        then(r) {
            r.threshold.organizationPartyId == org
            number(r.kept.approvalThresholdCost) == 500
            number(r.kept.approvalThresholdHours) == 10
            r.plannerPolicy.approvalThresholdCost == null
            r.nothing.statusId == "WeApproved"
            r.unassigned.statusId == "WeInPlanning"
            r.under.statusId == "WeInPlanning"
            r.underApproved.statusId == "WeApproved"
            r.overRefused == "APPROVAL_REQUIRED"
            !r.overMessage.includes("680")
            !r.overMessage.includes("500")
            r.oddRefused == "APPROVAL_REQUIRED"
            r.estimate.known == true
            r.estimate.amount.compare(680) == 0
            r.oddEstimate.known == false
            r.oddEstimate.unknownList.some(reason => reason.includes("no approved standard cost"))
            r.supervisorApproves.statusId == "WeApproved"
            r.unsetApproved.statusId == "WeApproved"
            status(r.over.workEffortId) == "WeApproved"
            r.euroEstimate.known == false
            r.euroEstimate.unknownList.some(reason => reason.includes("is in USD"))
            r.euroRefused == "APPROVAL_REQUIRED"
            r.pairEstimate.known == true
            r.pairEstimate.labor.compare(120) == 0
            r.pairEstimate.amount.compare(160) == 0
            r.pairApproved.statusId == "WeApproved"
            r.settingsEnded.some(row => row.approvalThresholdCost != null)
            r.plannerEnded.length == r.settingsEnded.length
            r.plannerEnded.every(row => row.approvalThresholdCost == null)
        }
    }
)
