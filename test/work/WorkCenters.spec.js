// Work centers (impl-manufacturing P3, design-manufacturing §6 and §12 M5): store#WorkCenter makes a facility a work center
// with its plant and scheduling policy, or a new line under the plant, and leaves the facility's people capacity alone; its
// dated capacities (parallel slots, a quantity per hour for a product) and alternates, each under METHOD_RESOURCES in the
// center's organization; its rate still needs the separate cost authority; get#WorkCenter answers the rates only to a reader
// of costs; and get#WorkCenterLoad counts a released operation's standard hours against the slots. The users are in
// spec-local groups.
const R = "mantle.work.RoutingServices.",
    W = "mantle.work.WorkCenterServices.",
    L = "mantle.work.ProductionPlanningServices.",
    P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices."
const org = "WCS_ORG",
    plant = "WCS_PLANT",
    line = "WCS_LINE",
    other = "WCS_LINE_2"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "wcs-op-" + ++keySeq

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

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [org, "WCS_OTHER"]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        user("WCS_RESOURCE", ["METHOD_VIEW", "METHOD_RESOURCES", "PRODUCTION_VIEW"])
        user("WCS_COSTER", ["METHOD_VIEW", "METHOD_RESOURCES", "METHOD_COST_EDIT", "METHOD_COST_APPROVE", "PRODUCT_COST_VIEW"])
        user("WCS_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("WCS_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("WCS_OPERATOR", ["PRODUCTION_VIEW", "PRODUCTION_OPERATE", "METHOD_VIEW"])
        user("WCS_COST_READER", ["PRODUCTION_VIEW", "PRODUCT_COST_VIEW"])
        user("WCS_NOBODY", ["PRODUCTION_OPERATE"])
        user("WCS_OUTSIDER", ["METHOD_VIEW", "METHOD_RESOURCES", "PRODUCTION_VIEW"], "WCS_OTHER")
        call("create#mantle.facility.Facility", {facilityId: plant, facilityTypeEnumId: "FcTpPlant", ownerPartyId: org})
        // the line's people capacity is twelve; production capacity never changes it
        for (const facilityId of [line, other])
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpLine",
                parentFacilityId: plant,
                ownerPartyId: org,
                facilityName: facilityId === line ? "Spec line" : "Second spec line",
                capacity: 12
            })
        call("create#mantle.facility.Facility", {
            facilityId: "WCS_FOREIGN",
            facilityTypeEnumId: "FcTpLine",
            ownerPartyId: "WCS_OTHER"
        })
        call("create#mantle.work.calendar.Calendar", {
            calendarId: "WCS_CAL",
            ownerPartyId: org,
            calendarName: "Spec shifts",
            calendarKindEnumId: "CalkResource"
        })
        call("create#mantle.work.calendar.Calendar", {
            calendarId: "WCS_CAL_FOREIGN",
            ownerPartyId: "WCS_OTHER",
            calendarName: "Other shifts",
            calendarKindEnumId: "CalkResource"
        })
        for (const productId of ["WCS_FIN", "WCS_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
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

feature("a resource administrator makes a line a work center and a new line under the plant; people capacity is unchanged", {
    when() {
        const made = run("wcs_resource", R + "store#WorkCenter", {
            facilityId: line,
            calendarId: "WCS_CAL",
            efficiencyPercent: 90,
            oeeTargetPercent: 85,
            schedulingPolicyEnumId: "WcspForward",
            changeReason: "Spec center"
        })
        const second = run("wcs_resource", R + "store#WorkCenter", {facilityId: other, changeReason: "Second center"})
        const created = run("wcs_resource", R + "store#WorkCenter", {
            plantFacilityId: plant,
            facilityName: "New spec line",
            changeReason: "New line"
        })
        const reader = run("wcs_operator", R + "store#WorkCenter", {facilityId: line, changeReason: "Not mine"})
        const outsider = run("wcs_outsider", R + "store#WorkCenter", {facilityId: line, changeReason: "Not mine"})
        const calendar = run("wcs_resource", R + "store#WorkCenter", {
            facilityId: line,
            calendarId: "WCS_CAL_FOREIGN",
            changeReason: "Other calendar"
        })
        const policy = run("wcs_resource", R + "store#WorkCenter", {
            facilityId: line,
            schedulingPolicyEnumId: "WccbSlots",
            changeReason: "Not a policy"
        })
        const percent = run("wcs_resource", R + "store#WorkCenter", {
            facilityId: line,
            efficiencyPercent: 120,
            changeReason: "Too much"
        })
        state.newLine = created.facilityId
        return {made, second, created, reader, outsider, calendar, policy, percent}
    },
    then({made, second, created, reader, outsider, calendar, policy, percent}) {
        made.error == ""
        second.error == ""
        const center = one("mantle.work.production.WorkCenter", {facilityId: line})
        center.plantFacilityId == plant
        center.calendarId == "WCS_CAL"
        center.schedulingPolicyEnumId == "WcspForward"
        center.efficiencyPercent.toNumber() == 90
        one("mantle.facility.Facility", {facilityId: line}).capacity.toNumber() == 12
        rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.work.production.WorkCenter",
            pkPrimaryValue: line,
            changedFieldName: "schedulingPolicyEnumId"
        }).length == 1
        created.error == ""
        const newLine = one("mantle.facility.Facility", {facilityId: created.facilityId})
        newLine.facilityTypeEnumId == "FcTpLine"
        newLine.parentFacilityId == plant
        newLine.ownerPartyId == org
        newLine.facilityName == "New spec line"
        one("mantle.work.production.WorkCenter", {facilityId: created.facilityId}).plantFacilityId == plant
        reader.error.includes("resources authority is required")
        outsider.error.includes("organization is not available")
        calendar.error.includes("Calendar is not in the work-center organization")
        policy.error.includes("Choose a scheduling policy")
        percent.error.includes("between zero and 100")
    }
})

feature(
    "capacities are dated rows: two parallel slots replace one, a quantity per hour for a product, and bad ones are refused",
    {
        when() {
            const store = (username, fields) =>
                run(
                    username,
                    W + "store#WorkCenterCapacity",
                    Object.assign({facilityId: line, changeReason: "Spec capacity"}, fields)
                )
            const single = store("wcs_resource", {parallelSlots: 1})
            const two = store("wcs_resource", {parallelSlots: 2})
            const rate = store("wcs_resource", {
                capacityBasisEnumId: "WccbRate",
                productId: "WCS_FIN",
                quantity: 30,
                quantityUomId: "OTH_ea",
                perDuration: 1,
                durationUomId: "TF_hr"
            })
            const zero = store("wcs_resource", {parallelSlots: 0})
            const noTime = store("wcs_resource", {capacityBasisEnumId: "WccbRate", quantity: 5, quantityUomId: "OTH_ea"})
            const past = store("wcs_resource", {parallelSlots: 3, fromDate: "2001-01-01T00:00:00Z"})
            const reader = store("wcs_operator", {parallelSlots: 4})
            const notCenter = run("wcs_resource", W + "store#WorkCenterCapacity", {
                facilityId: plant,
                parallelSlots: 1,
                changeReason: "Not a center"
            })
            state.rateCapacityId = rate.workCenterCapacity?.workCenterCapacityId
            return {single, two, rate, zero, noTime, past, reader, notCenter}
        },
        then({single, two, rate, zero, noTime, past, reader, notCenter}) {
            single.error == ""
            two.error == ""
            rate.error == ""
            two.workCenterCapacity.capacityText == "2 parallel slots"
            rate.workCenterCapacity.capacityText.includes("30")
            rate.workCenterCapacity.appliesToText.includes("WCS_FIN")
            // the slot row in effect at the second's start ended there
            const ended = rows("mantle.work.production.WorkCenterCapacity", {
                facilityId: line,
                capacityBasisEnumId: "WccbSlots"
            }).find(row => row.workCenterCapacityId === single.workCenterCapacity.workCenterCapacityId)
            ended.thruDate != null
            one("mantle.facility.Facility", {facilityId: line}).capacity.toNumber() == 12
            zero.error.includes("at least one")
            noTime.error.includes("time must be positive")
            past.error.includes("starts now or later")
            reader.error.includes("resources authority is required")
            notCenter.error.includes("WORK_CENTER_REQUIRED")
        }
    }
)

feature("ending a dated row: a future one is withdrawn at its start and can be added again; an end before now is refused", {
    when() {
        const store = fields =>
            run(
                "wcs_resource",
                W + "store#WorkCenterCapacity",
                Object.assign({facilityId: line, changeReason: "Spec future capacity"}, fields)
            )
        const start = new Date(Date.now() + 3 * 24 * 3600000).toISOString()
        const future = {capacityBasisEnumId: "WccbSlots", productTypeEnumId: "PtAsset", parallelSlots: 3, fromDate: start}
        const added = store(future)
        const withdrawn = store({workCenterCapacityId: added.workCenterCapacity?.workCenterCapacityId})
        const again = store(future)
        const againWithdrawn = store({workCenterCapacityId: again.workCenterCapacity?.workCenterCapacityId})
        const pastEnd = store({workCenterCapacityId: state.rateCapacityId, thruDate: "2001-01-01T00:00:00Z"})
        return {added, withdrawn, again, againWithdrawn, pastEnd}
    },
    then({added, withdrawn, again, againWithdrawn, pastEnd}) {
        added.error == ""
        withdrawn.error == ""
        withdrawn.workCenterCapacity.thruDate != null
        String(withdrawn.workCenterCapacity.thruDate) == String(withdrawn.workCenterCapacity.fromDate)
        withdrawn.workCenterCapacity.inEffect == false
        again.error == ""
        againWithdrawn.error == ""
        pastEnd.error.includes("now or later")
    }
})

feature("an alternate is another work center of the organization; the center itself, a foreign one and a duplicate are refused", {
    when() {
        const store = (username, fields) =>
            run(
                username,
                W + "store#WorkCenterAlternate",
                Object.assign({facilityId: line, changeReason: "Spec alternate"}, fields)
            )
        const added = store("wcs_resource", {alternateFacilityId: other, sequenceNum: 1, qualification: "Same fixtures"})
        const again = store("wcs_resource", {alternateFacilityId: other})
        const itself = store("wcs_resource", {alternateFacilityId: line})
        const foreign = store("wcs_resource", {alternateFacilityId: "WCS_FOREIGN"})
        const ended = run("wcs_resource", W + "store#WorkCenterAlternate", {
            workCenterAlternateId: added.workCenterAlternate?.workCenterAlternateId,
            changeReason: "No longer"
        })
        return {added, again, itself, foreign, ended}
    },
    then({added, again, itself, foreign, ended}) {
        added.error == ""
        added.workCenterAlternate.alternateName == "Second spec line"
        again.error.includes("already an alternate")
        itself.error.includes("not its own alternate")
        foreign.error.includes("RECORD_UNAVAILABLE")
        ended.error == ""
        ended.workCenterAlternate.thruDate != null
    }
})

feature("a rate needs cost authority; an operator reads the center without its rate and a cost reader with it", {
    when() {
        const rate = {
            facilityId: line,
            componentTypeEnumId: "PccMachine",
            rateAmount: 42,
            priceUomId: "USD",
            approve: true,
            changeReason: "Spec rate"
        }
        const resource = run("wcs_resource", R + "store#WorkCenterRate", rate)
        const coster = run("wcs_coster", R + "store#WorkCenterRate", rate)
        const operator = run("wcs_operator", W + "get#WorkCenter", {facilityId: line})
        const costReader = run("wcs_cost_reader", W + "get#WorkCenter", {facilityId: line})
        const nobody = run("wcs_nobody", W + "get#WorkCenter", {facilityId: line})
        const outsider = run("wcs_outsider", W + "get#WorkCenter", {facilityId: line})
        const plainFacility = run("wcs_operator", W + "get#WorkCenter", {facilityId: plant})
        return {resource, coster, operator, costReader, nobody, outsider, plainFacility}
    },
    then({resource, coster, operator, costReader, nobody, outsider, plainFacility}) {
        resource.error.includes("Separate cost-write authority is required")
        coster.error == ""
        coster.workCenterRate.state == "approved"
        operator.error == ""
        operator.isWorkCenter == true
        operator.workCenter.plantFacilityId == plant
        operator.workCenter.calendarName == "Spec shifts"
        operator.workCenter.schedulingPolicyText == "Forward from the start"
        operator.capacityList.length == 2
        operator.alternateList.length == 0
        operator.peopleCapacity == "12"
        operator.costRead == false
        operator.rateList == null
        operator.canEdit == false
        costReader.error == ""
        costReader.rateList.length == 1
        costReader.rateList[0].rateAmount == "42"
        costReader.rateList[0].state == "approved"
        nobody.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        plainFacility.isWorkCenter == false
    }
})

feature("the load of a released operation counts its standard hours against the center's two slots", {
    when() {
        const operationKey = key()
        const outcome = as("wcs_method", () => {
            const route = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Spec route",
                changeReason: "Spec"
            })
            const routeId = route.routing.workEffortId
            call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Assemble",
                sequenceNum: 10,
                estimatedSetupTime: 30,
                estimatedWorkTime: 15,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: line,
                changeReason: "Spec operation"
            })
            const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Spec"
            })
            const bom = call(B + "store#Bom", {
                productId: "WCS_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec"
            }).productBom.productBomId
            call(B + "store#BomItem", {productBomId: bom, productId: "WCS_RM", quantity: 1, changeReason: "Spec line"})
            const bomDetail = call(B + "get#BomDetail", {productBomId: bom})
            call(B + "release#BomDraft", {productBomId: bom, expectedRevision: bomDetail.expectedRevision, changeReason: "Spec"})
            return routeId
        })
        const created = run("wcs_planner", P + "create#ProductionOrder", {
            operationKey,
            organizationPartyId: org,
            productId: "WCS_FIN",
            quantity: 4,
            facilityId: line
        })
        const released = run("wcs_planner", P + "release#ProductionOrder", {
            operationKey: key(),
            workEffortId: created.workEffortId,
            expectedRevision: 1
        })
        const load = run("wcs_planner", L + "get#WorkCenterLoad", {facilityId: line})
        const plantLoad = run("wcs_planner", L + "get#WorkCenterLoad", {plantFacilityId: plant, text: "spec"})
        const methodOnly = run("wcs_method", L + "get#WorkCenterLoad", {})
        const outsider = run("wcs_outsider", L + "get#WorkCenterLoad", {facilityId: line})
        const outsiderAll = run("wcs_outsider", L + "get#WorkCenterLoad", {})
        return {outcome, created, released, load, plantLoad, methodOnly, outsider, outsiderAll}
    },
    then({created, released, load, plantLoad, methodOnly, outsider, outsiderAll}) {
        created.error == ""
        released.error == ""
        load.error == ""
        load.centerList.length == 1
        const center = load.centerList[0]
        center.facilityId == line
        center.parallelSlots == 2
        center.operationCount == 1
        // 30 minutes of setup and 15 a piece for four: 1.5 hours
        center.loadHours == "1.5"
        center.findings.length == 0
        center.capacityText.includes("30")
        // two slots for two weeks at 90 percent
        center.nominalHours == "604.8"
        plantLoad.centerList.map(row => row.facilityId).includes(line)
        plantLoad.centerList.map(row => row.facilityId).includes(other)
        methodOnly.error.includes("PERMISSION_DENIED")
        outsider.error.includes("RECORD_UNAVAILABLE")
        outsiderAll.centerList.length == 0
    }
})
