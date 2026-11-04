// The shop floor and production time (impl-manufacturing P10, design-manufacturing ShopFloor, OperationExecution,
// Instructions and ProductionTime): the queue shows a running work order's operations by state; an operation's start is
// blocked by a required skill until a supervisor overrides it and by its instruction until the operator acknowledges it, and
// starts the person timer, switching from another timer only once confirmed; a successor may start once its predecessor
// has started but is not completed before it, naming it; machine runtime is recorded apart from labor, valued at the work
// center's machine rate in effect and unvalued without one; the required evidence is asked for; the output operation
// completes 5 good and 1 scrap with the coupled output receipt in its transaction, and a retry answers the first; under the
// piece-rate policy the pieces go on the time entry; the run's supervisor approves the operator's week, which writes the
// labor event at the costing rate, and reopening it writes the reversal, while a run whose policy leaves laborCostSync off
// and a plain task record none; a work order's completion refuses operations not completed on the shop floor until the
// supervisor closes them with it; Today leaves out a run's operations and keeps plain Mantle's items. The users are in
// spec-local groups.
const P = "mantle.work.ProductionServices.",
    B = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices.",
    T = "mantle.work.TimesheetServices."
const WORK = "mantle.work.effort.WorkEffort",
    LINE = "mantle.work.production.ProductionRunLine",
    TIME = "mantle.work.time.TimeEntry",
    EVENT = "mantle.work.production.ProductionCostEvent",
    RUNTIME = "mantle.work.production.MachineRuntimeEvent",
    RECEIPT = "mantle.product.receipt.AssetReceipt",
    LOSS = "mantle.work.production.ProductionLoss",
    ACK = "mantle.work.production.InstructionAcknowledgment"
const org = "PSF_ORG",
    other = "PSF_OTHER",
    plant = "PSF_PLANT",
    plant2 = "PSF_PLANT2"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const n = value => (value == null ? null : Number(String(value)))
const since = "2000-01-01T00:00:00Z"
const state = {}
let keySeq = 0
const key = () => "psf-op-" + ++keySeq
function tick() {
    const until = Date.now() + 25
    while (Date.now() < until) {}
}
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
const revision = workEffortId => Number(one(WORK, {workEffortId}).productionRevision || 0)
const act = (username, workEffortId, action, extra = {}) =>
    run(
        username,
        P + "transition#ProductionOrder",
        Object.assign({operationKey: key(), workEffortId, action, expectedRevision: revision(workEffortId)}, extra)
    )
// a released and started work order of six at a plant, its material issued; its operations Assemble then Pack
function runningRun(facilityId) {
    const created = run("psf_planner", P + "create#ProductionOrder", {
        operationKey: key(),
        organizationPartyId: org,
        productId: "PSF_FIN",
        quantity: 6,
        facilityId
    })
    if (created.error) throw new Error("Create failed: " + created.error)
    const workEffortId = created.workEffortId
    const released = act("psf_planner", workEffortId, "release")
    if (released.error) throw new Error("Release failed: " + released.error)
    // the supervisor is a Manager of the work order: the approver of its time under the project rule (F33)
    const party = run("psf_planner", P + "store#ProductionParty", {
        operationKey: key(),
        workEffortId,
        expectedRevision: revision(workEffortId),
        partyId: "PSF_SUPER",
        roleTypeId: "Manager"
    })
    if (party.error) throw new Error("Assignment failed: " + party.error)
    const started = act("psf_super", workEffortId, "start")
    if (started.error) throw new Error("Start failed: " + started.error)
    const material = rows(LINE, {workEffortId}).find(row => row.lineRoleEnumId === "PrlrMaterial")
    const issued = run("psf_operator", P + "issue#ProductionMaterial", {
        operationKey: key(),
        workEffortId,
        productionRunLineId: material.productionRunLineId,
        assetId: facilityId === plant ? state.rm : state.rm2,
        quantity: 6
    })
    if (issued.error) throw new Error("Issue failed: " + issued.error)
    const operations = rows(WORK, {parentWorkEffortId: workEffortId}).sort(
        (a, b) => Number(a.operationSequenceNum || 0) - Number(b.operationSequenceNum || 0)
    )
    return {workEffortId, assemble: operations[0].workEffortId, pack: operations[1].workEffortId}
}
// the user's running timer entry moved back by some minutes, so its stop counts time (a timer under a minute is discarded)
function backdate(username, minutes) {
    const partyId = username.toUpperCase()
    const entry = rows(TIME, {partyId}).find(row => row.thruDate == null && row.fromDate != null)
    if (entry) call("update#" + TIME, {timeEntryId: entry.timeEntryId, fromDate: new Date(Date.now() - minutes * 60000)})
    return entry?.timeEntryId || null
}
const read = (username, operationWorkEffortId) =>
    run(username, P + "get#ProductionOperation", {operationWorkEffortId}).productionOperation || {}
const check = (operation, code) => (operation.checks || []).find(row => row.code === code) || {}

spec({
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
        user("PSF_METHOD", ["METHOD_VIEW", "METHOD_EDIT", "METHOD_APPROVE", "METHOD_RESOURCES"])
        user("PSF_PLANNER", ["PRODUCTION_PLAN", "PRODUCTION_VIEW", "METHOD_VIEW"])
        user("PSF_ADMIN", ["PRODUCTION_POLICY_EDIT", "PRODUCTION_VIEW"])
        user("PSF_SUPER", ["PRODUCTION_SUPERVISE", "PRODUCTION_VIEW", "PRODUCTION_OPERATE"])
        user("PSF_OPERATOR", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW", "STOCK_ISSUE"])
        user("PSF_OPERATOR2", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"])
        user("PSF_READER", ["PRODUCTION_VIEW"])
        user("PSF_OUTSIDER", ["PRODUCTION_OPERATE", "PRODUCTION_VIEW"], other)
        call("create#moqui.basic.Enumeration", {enumId: "PSF_SKILL", enumTypeId: "SkillType", description: "Torque wrench"})
        for (const facilityId of [plant, plant2]) {
            call("create#mantle.facility.Facility", {
                facilityId,
                facilityTypeEnumId: "FcTpWarehouse",
                facilityName: facilityId,
                ownerPartyId: org
            })
            call("create#mantle.facility.FacilityLocation", {facilityId, locationSeqId: "PICK1", locationTypeEnumId: "FltPick"})
        }
        for (const productId of ["PSF_FIN", "PSF_RM"])
            call("create#mantle.product.Product", {
                productId,
                productName: productId === "PSF_FIN" ? "Shop floor widget" : "Shop floor part",
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
        call("create#mantle.product.cost.ProductStandardCost", {
            productStandardCostId: "PSF_FIN_STD",
            productId: "PSF_FIN",
            organizationPartyId: org,
            state: "approved",
            fromDate: since,
            quantity: 1,
            quantityUomId: "OTH_ea",
            priceUomId: "USD",
            unitCost: 5,
            totalCost: 5,
            materialCost: 5,
            complete: "Y"
        })
        // the costing rates of production run and set-up time (design Y2), from yesterday so they are the latest started
        // (RateAmount names no organization: a demo rate would otherwise match too), and a plain task with time of its own
        const rateFrom = new Date(Date.now() - 86400000)
        for (const [rateAmountId, workTypeEnumId, rateAmount] of [
            ["PSF_RATE", "WktpProductionRun", 20],
            ["PSF_RATE_SETUP", "WktpProductionSetup", 30]
        ])
            call("create#mantle.humanres.rate.RateAmount", {
                rateAmountId,
                rateTypeEnumId: "RatpStandard",
                ratePurposeEnumId: "RaprProductionCost",
                workTypeEnumId,
                rateCurrencyUomId: "USD",
                timePeriodUomId: "TF_hr",
                rateAmount,
                fromDate: rateFrom
            })
        call("create#" + WORK, {
            workEffortId: "PSF_TASK",
            workEffortTypeEnumId: "WetTask",
            statusId: "WeInProgress",
            workEffortName: "Paperwork",
            ownerPartyId: org
        })
        ec.artifactExecution.enableAuthz()
        as("psf_method", () => {
            call(R + "store#WorkCenter", {organizationPartyId: org, facilityId: plant, changeReason: "Spec work center"})
            // Assemble: a template with a skill, its published instruction and the evidence it requires; Pack after it
            const templateId = call(R + "store#OperationTemplate", {
                organizationPartyId: org,
                workEffortName: "Assemble",
                estimatedWorkTime: 6,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: plant,
                methodRequiredEvidence: "Torque reading",
                changeReason: "Spec template"
            }).template.workEffortId
            ec.artifactExecution.disableAuthz()
            call("create#mantle.work.effort.WorkEffortSkillStandard", {workEffortId: templateId, skillTypeEnumId: "PSF_SKILL"})
            call(R + "store#OperationInstruction", {
                workEffortId: templateId,
                contentText: "# Assemble\nFasten the four bolts to 12 Nm.",
                filename: "assemble.md",
                changeReason: "Spec instruction"
            })
            const routeId = call(R + "store#Routing", {
                organizationPartyId: org,
                workEffortName: "Shop floor routing",
                changeReason: "Spec"
            }).routing.workEffortId
            const assembleId = call(R + "copy#RoutingOperations", {
                workEffortId: routeId,
                sourceWorkEffortIds: [templateId],
                changeReason: "Spec copy"
            }).copiedOperationIds[0]
            call(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Pack",
                sequenceNum: 20,
                estimatedWorkTime: 3,
                timeUomId: "TF_min",
                methodBatchQuantity: 1,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: plant,
                methodPredecessorIds: assembleId,
                changeReason: "Spec operation"
            })
            const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
            call(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Spec"
            })
            const productBomId = call(B + "store#Bom", {
                productId: "PSF_FIN",
                organizationPartyId: org,
                routingWorkEffortId: routeId,
                changeReason: "Spec method"
            }).productBom.productBomId
            call(B + "store#BomItem", {
                productBomId,
                productId: "PSF_RM",
                quantity: 1,
                operationWorkEffortId: assembleId,
                changeReason: "Spec line"
            })
            const bom = call(B + "get#BomDetail", {productBomId})
            call(B + "release#BomDraft", {productBomId, expectedRevision: bom.expectedRevision, changeReason: "Spec release"})
        })
        // the policy: piece rate and the labor cost hook for the organization, the hook off at the second plant
        const policies = [
            run("psf_admin", P + "store#ProductionPolicy", {
                organizationPartyId: org,
                pieceRate: "Y",
                laborCostSync: "Y",
                machineRuntimeEnumId: "PmrOptional",
                changeReason: "Spec policy"
            }),
            run("psf_admin", P + "store#ProductionPolicy", {
                organizationPartyId: org,
                facilityId: plant2,
                laborCostSync: "N",
                changeReason: "Spec plant"
            })
        ]
        for (const out of policies) if (out.error) throw new Error("Policy failed: " + out.error)
        tick()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // line's machine rate, from two hours ago: an interval before it is not valued
        call("create#mantle.work.production.WorkCenterRate", {
            workCenterRateId: "PSF_MRATE",
            facilityId: plant,
            componentTypeEnumId: "PccMachine",
            rateAmount: 30,
            priceUomId: "USD",
            fromDate: new Date(Date.now() - 2 * 3600000),
            state: "approved",
            approvedDate: ec.user.nowTimestamp,
            changeReason: "Spec rate"
        })
        for (const [facilityId, field] of [
            [plant, "rm"],
            [plant2, "rm2"]
        ]) {
            const received = call("mantle.product.AssetServices.receive#Asset", {
                productId: "PSF_RM",
                quantity: 100,
                facilityId,
                locationSeqId: "PICK1",
                ownerPartyId: org,
                assetTypeEnumId: "AstTpInventory",
                statusId: "AstAvailable",
                acquireCost: 2
            })
            call("update#mantle.product.asset.Asset", {assetId: received.assetId, acquireCostUomId: "USD"})
            state[field] = received.assetId
        }
        call("create#mantle.product.asset.Asset", {
            assetId: "PSF_PRESS",
            assetTypeEnumId: "AstTpEquipment",
            assetName: "Press",
            statusId: "AstAvailable",
            facilityId: plant,
            ownerPartyId: org
        })
        ec.artifactExecution.enableAuthz()
        state.r = runningRun(plant)
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

feature("the queue shows the operations by state, and a start waits for the skill override and the acknowledgment", {
    when() {
        const r = state.r
        const queue = run("psf_operator", P + "get#ShopFloorQueue", {facilityId: plant})
        const outsiderQueue = run("psf_outsider", P + "get#ShopFloorQueue", {})
        const before = read("psf_operator", r.assemble)
        const packEarly = run("psf_operator2", P + "start#ProductionOperation", {
            operationKey: key(),
            operationWorkEffortId: r.pack
        })
        const skill = run("psf_operator", P + "start#ProductionOperation", {
            operationKey: key(),
            operationWorkEffortId: r.assemble
        })
        const operatorOverride = run("psf_operator", P + "override#ProductionOperationStart", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            reason: "Trained today"
        })
        const override = run("psf_super", P + "override#ProductionOperationStart", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            reason: "Trained today, certificate to follow"
        })
        const unread = run("psf_operator", P + "start#ProductionOperation", {
            operationKey: key(),
            operationWorkEffortId: r.assemble
        })
        const instructions = run("psf_operator", P + "get#ProductionInstructions", {
            operationWorkEffortId: r.assemble
        }).productionInstructions
        const contentId = instructions.instructionRows[0].workEffortContentId
        const wrong = run("psf_operator", P + "record#InstructionStep", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            workEffortContentId: "PSF_NO_CONTENT"
        })
        const reader = run("psf_reader", P + "record#InstructionStep", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            workEffortContentId: contentId
        })
        const acknowledged = run("psf_operator", P + "record#InstructionStep", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            workEffortContentId: contentId
        })
        const again = run("psf_operator", P + "record#InstructionStep", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            workEffortContentId: contentId
        })
        // a timer on other work: the start asks to switch, then switches once confirmed
        const other = run("psf_operator", T + "start#Timer", {workEffortId: "PSF_TASK"})
        const switchAsked = run("psf_operator", P + "start#ProductionOperation", {
            operationKey: key(),
            operationWorkEffortId: r.assemble
        })
        const startKey = key()
        const started = run("psf_operator", P + "start#ProductionOperation", {
            operationKey: startKey,
            operationWorkEffortId: r.assemble,
            confirmSwitch: true
        })
        const retried = run("psf_operator", P + "start#ProductionOperation", {
            operationKey: startKey,
            operationWorkEffortId: r.assemble,
            confirmSwitch: true
        })
        const timer = run("psf_operator", T + "get#Timer", {}).timer
        const after = read("psf_operator", r.assemble)
        const queueAfter = run("psf_operator", P + "get#ShopFloorQueue", {facilityId: plant})
        return {
            r,
            queue,
            outsiderQueue,
            before,
            packEarly,
            skill,
            operatorOverride,
            override,
            unread,
            instructions,
            wrong,
            reader,
            acknowledged,
            again,
            other,
            switchAsked,
            started,
            retried,
            timer,
            after,
            queueAfter,
            taskEntry: one(TIME, {timeEntryId: other.timeEntryId}),
            acks: rows(ACK, {operationWorkEffortId: r.assemble})
        }
    },
    then(x) {
        x.queue.error == ""
        x.queue.operationRows.find(row => row.operationWorkEffortId == x.r.assemble).state == "ready"
        x.queue.operationRows.find(row => row.operationWorkEffortId == x.r.pack).state == "blocked"
        x.queue.operationRows.find(row => row.operationWorkEffortId == x.r.pack).readinessText.includes("Assemble")
        x.queue.groups.length == 4
        x.outsiderQueue.operationRows.every(row => row.workEffortId != x.r.workEffortId)
        check(x.before, "SKILL_MISSING").blocking == true
        check(x.before, "SKILL_MISSING").message.includes("Torque wrench")
        check(x.before, "ACKNOWLEDGMENT_REQUIRED").blocking == true
        x.before.blocked.code == "SKILL_MISSING"
        x.before.evidence.text == "Torque reading"
        x.before.operation.outputOperation == false
        x.packEarly.error.includes("PREDECESSOR_NOT_STARTED")
        x.packEarly.error.includes("Assemble")
        x.skill.error.includes("SKILL_MISSING")
        x.operatorOverride.error.includes("PERMISSION_DENIED")
        x.override.error == ""
        x.override.result.resultCode == "OVERRIDDEN"
        x.unread.error.includes("ACKNOWLEDGMENT_REQUIRED")
        x.instructions.instructionRows.length == 1
        x.instructions.instructionRows[0].body.includes("12 Nm")
        x.instructions.instructionRows[0].acknowledged == false
        x.wrong.error.includes("INSTRUCTION_INVALID")
        x.reader.error.includes("PERMISSION_DENIED")
        x.acknowledged.error == ""
        x.acknowledged.result.resultCode == "ACKNOWLEDGED"
        x.again.result.resultCode == "ALREADY_ACKNOWLEDGED"
        x.acks.length == 1
        x.acks[0].partyId == "PSF_OPERATOR"
        x.other.error == ""
        x.switchAsked.error.includes("TIMER_SWITCH_REQUIRED")
        x.switchAsked.error.includes("Paperwork")
        x.started.error == ""
        x.started.result.resultCode == "STARTED"
        x.started.result.switched == true
        x.started.result.stoppedTimeEntryIds.includes(x.other.timeEntryId)
        x.retried.result.alreadyApplied == true
        x.retried.result.timeEntryId == x.started.result.timeEntryId
        x.timer.workEffortId == x.r.assemble
        one(WORK, {workEffortId: x.r.assemble}).statusId == "WeInProgress"
        x.after.timer.here == true
        check(x.after, "SKILL_MISSING").ok == true
        x.queueAfter.operationRows.find(row => row.operationWorkEffortId == x.r.assemble).state == "running"
        x.queueAfter.operationRows.find(row => row.operationWorkEffortId == x.r.assemble).timerHere == true
    }
})

feature("machine runtime is recorded apart from labor, valued at the work center's rate, and unvalued without one", {
    when() {
        const r = state.r
        const started = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "start",
            assetId: "PSF_PRESS"
        })
        const twice = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "start",
            assetId: "PSF_PRESS"
        })
        call("update#" + RUNTIME, {
            machineRuntimeEventId: started.result.machineRuntimeEventId,
            fromDate: new Date(Date.now() - 3600000)
        })
        const stopped = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "stop",
            assetId: "PSF_PRESS"
        })
        const early = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "record",
            fromDate: new Date(Date.now() - 5 * 3600000),
            thruDate: new Date(Date.now() - 4 * 3600000)
        })
        const backwards = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "record",
            fromDate: new Date(Date.now() - 3600000),
            thruDate: new Date(Date.now() - 2 * 3600000)
        })
        const stock = run("psf_operator", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "start",
            assetId: state.rm
        })
        const reader = run("psf_reader", P + "record#MachineRuntime", {
            operationKey: key(),
            operationWorkEffortId: r.assemble,
            action: "record",
            fromDate: new Date(Date.now() - 3600000),
            thruDate: new Date(Date.now() - 1800000)
        })
        const operatorRead = read("psf_operator", r.assemble)
        return {
            r,
            started,
            twice,
            stopped,
            early,
            backwards,
            stock,
            reader,
            operatorRead,
            valuedEvent: one(EVENT, {productionCostEventId: stopped.result?.productionCostEventId}),
            unvaluedEvent: one(EVENT, {productionCostEventId: early.result?.productionCostEventId}),
            entries: rows(TIME, {workEffortId: r.assemble})
        }
    },
    then(x) {
        x.started.error == ""
        x.started.result.resultCode == "STARTED"
        x.twice.error.includes("RUNTIME_OPEN")
        x.stopped.error == ""
        x.stopped.result.resultCode == "STOPPED"
        x.stopped.result.valued == true
        Math.abs(n(x.stopped.result.hours) - 1) < 0.01
        x.valuedEvent.costEventTypeEnumId == "PcetMachine"
        x.valuedEvent.costComponentEnumId == "PrcMachine"
        x.valuedEvent.ledgerStatusEnumId == "PclAwaitingClose"
        x.valuedEvent.rateId == "PSF_MRATE"
        Math.abs(n(x.valuedEvent.amount) - 30) < 0.5
        x.valuedEvent.workEffortId == x.r.workEffortId
        x.valuedEvent.operationWorkEffortId == x.r.assemble
        x.early.error == ""
        x.early.result.valued == false
        x.unvaluedEvent.valuationStatusEnumId == "PcvUnvalued"
        x.unvaluedEvent.amount == null
        x.backwards.error.includes("INTERVAL_INVALID")
        x.stock.error.includes("ASSET_INVALID")
        x.reader.error.includes("PERMISSION_DENIED")
        // machine time is no person's time: the operation's only entry is the operator's timer
        x.entries.length == 1
        x.operatorRead.runtimeRows.length == 2
        x.operatorRead.runtimeRows.every(row => row.amount === undefined)
    }
})

feature(
    "completion waits for its predecessor and the evidence; the output operation completes 5 good and 1 scrap with its receipt",
    {
        when() {
            const r = state.r
            const packStart = run("psf_operator2", P + "start#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.pack
            })
            const pauseNoReason = run("psf_operator2", P + "pause#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.pack
            })
            const paused = run("psf_operator2", P + "pause#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.pack,
                reason: "Waiting for boxes",
                stopTimer: true
            })
            const quantities = {good: 5, scrap: 1, reason: "Dropped", toLocationSeqId: "PICK1"}
            const early = run(
                "psf_operator",
                P + "complete#ProductionOperation",
                Object.assign({operationKey: key(), operationWorkEffortId: r.pack}, quantities)
            )
            const receiptsAfterEarly = rows(RECEIPT, {workEffortId: r.workEffortId}).length
            const noEvidence = run("psf_operator", P + "complete#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.assemble,
                good: 6
            })
            const evidence = run("psf_operator", P + "record#InstructionStep", {
                operationKey: key(),
                operationWorkEffortId: r.assemble,
                stepTypeEnumId: "IstEvidence",
                valueText: "12 Nm",
                valueUomId: "OTH_ea"
            })
            const entryId = backdate("psf_operator", 12)
            state.entryId = entryId
            const assembled = run("psf_operator", P + "complete#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.assemble,
                good: 6
            })
            const noStock = run(
                "psf_operator2",
                P + "complete#ProductionOperation",
                Object.assign({operationKey: key(), operationWorkEffortId: r.pack}, quantities)
            )
            const completeKey = key()
            const packed = run(
                "psf_operator",
                P + "complete#ProductionOperation",
                Object.assign({operationKey: completeKey, operationWorkEffortId: r.pack}, quantities)
            )
            const receipts = rows(RECEIPT, {workEffortId: r.workEffortId}).length
            const retried = run(
                "psf_operator",
                P + "complete#ProductionOperation",
                Object.assign({operationKey: completeKey, operationWorkEffortId: r.pack}, quantities)
            )
            const figures = run("psf_super", P + "get#ProductionQuantities", {workEffortId: r.workEffortId})
            const completed = act("psf_super", r.workEffortId, "complete")
            return {
                r,
                packStart,
                pauseNoReason,
                paused,
                early,
                receiptsAfterEarly,
                noEvidence,
                evidence,
                entryId,
                assembled,
                noStock,
                packed,
                receipts,
                retried,
                figures,
                completed,
                entry: one(TIME, {timeEntryId: entryId}),
                assemble: one(WORK, {workEffortId: r.assemble}),
                pack: one(WORK, {workEffortId: r.pack}),
                losses: rows(LOSS, {workEffortId: r.workEffortId}),
                receiptsAfter: rows(RECEIPT, {workEffortId: r.workEffortId}).length
            }
        },
        then(x) {
            // Pack overlaps Assemble once it has started, but is not completed before it
            x.packStart.error == ""
            x.pauseNoReason.error.includes("REASON_REQUIRED")
            x.paused.error == ""
            x.paused.result.resultCode == "PAUSED"
            x.early.error.includes("PREDECESSOR_OPEN")
            x.early.error.includes("Assemble")
            x.receiptsAfterEarly == 0
            x.noEvidence.error.includes("EVIDENCE_REQUIRED")
            x.noEvidence.error.includes("Torque reading")
            x.evidence.result.resultCode == "EVIDENCE_RECORDED"
            x.assembled.error == ""
            x.assembled.result.outputOperation == false
            x.assembled.result.quantity == null
            x.assembled.result.timeEntryId == x.entryId
            n(x.entry.hours) > 0.15
            n(x.entry.pieceCount) == 6
            x.entry.thruDate != null
            x.assemble.statusId == "WeComplete"
            n(x.assemble.productionGoodQuantity) == 6
            // the coupled receipt needs the stock issue permission, which an operation assignment does not give (F96)
            x.noStock.error.includes("STOCK_ISSUE_REQUIRED")
            x.packed.error == ""
            x.packed.result.resultCode == "COMPLETED"
            x.packed.result.outputOperation == true
            x.packed.result.quantity.resultCode == "RECORDED"
            x.packed.result.operationsLeft == 0
            x.receipts == 1
            x.retried.result.alreadyApplied == true
            x.receiptsAfter == 1
            x.losses.length == 1
            x.losses[0].lossTypeEnumId == "PltOutputScrap"
            n(x.losses[0].quantity) == 1
            x.pack.statusId == "WeComplete"
            n(x.pack.productionLossQuantity) == 1
            x.completed.error == ""
            x.completed.result.resultCode == "COMPLETED"
        }
    }
)

feature(
    "the run's supervisor approves the week, which writes the labor event; reopening writes the reversal; the flag off writes none",
    {
        when() {
            const r = state.r
            // time on a work order of the plant whose policy leaves laborCostSync off, in the same week
            const off = runningRun(plant2)
            const offEntry = run("psf_operator", "mantle.work.TimeServices.store#TimeEntry", {
                workEffortId: off.assemble,
                workTypeEnumId: "WktpProductionRun",
                fromDate: new Date(Date.now() - 20 * 60000),
                thruDate: new Date(Date.now() - 10 * 60000)
            })
            // and time on a plain task: Projects' time, never a production cost
            const taskEntry = run("psf_operator", "mantle.work.TimeServices.store#TimeEntry", {
                workEffortId: "PSF_TASK",
                fromDate: new Date(Date.now() - 40 * 60000),
                thruDate: new Date(Date.now() - 30 * 60000)
            })
            const entry = one(TIME, {timeEntryId: state.entryId || rows(TIME, {workEffortId: r.assemble})[0].timeEntryId})
            const timesheetId = entry.timesheetId
            const submitted = run("psf_operator", T + "submit#Timesheet", {timesheetId})
            const approved = run("psf_super", T + "approve#Timesheet", {timesheetId})
            const afterApproval = rows(EVENT, {sourceEntityName: TIME, sourceId: entry.timeEntryId})
            const time = run("psf_super", P + "get#ProductionTime", {workEffortId: r.workEffortId}).productionTime
            const reopened = run("psf_super", T + "reopen#Timesheet", {timesheetId, reason: "Wrong week"})
            const afterReopen = rows(EVENT, {sourceEntityName: TIME, sourceId: entry.timeEntryId})
            state.off = off
            return {
                r,
                off,
                offEntry,
                taskEntry,
                entry,
                submitted,
                approved,
                afterApproval,
                time,
                reopened,
                afterReopen,
                offEvents: rows(EVENT, {sourceEntityName: TIME, sourceId: offEntry.timeEntryId || "_NA_"}),
                taskEvents: rows(TIME, {workEffortId: "PSF_TASK"}).flatMap(row =>
                    rows(EVENT, {sourceEntityName: TIME, sourceId: row.timeEntryId})
                )
            }
        },
        then(x) {
            x.offEntry.error == ""
            x.taskEntry.error == ""
            one(TIME, {timeEntryId: x.offEntry.timeEntryId}).timesheetId == x.entry.timesheetId
            x.submitted.error == ""
            x.approved.error == ""
            x.afterApproval.length == 1
            x.afterApproval[0].costEventTypeEnumId == "PcetLabor"
            x.afterApproval[0].costComponentEnumId == "PrcLabor"
            x.afterApproval[0].rateId == "PSF_RATE"
            x.afterApproval[0].valuationStatusEnumId == "PcvValued"
            x.afterApproval[0].ledgerStatusEnumId == "PclAwaitingClose"
            x.afterApproval[0].workEffortId == x.r.workEffortId
            x.afterApproval[0].operationWorkEffortId == x.r.assemble
            n(x.afterApproval[0].quantity) == n(x.entry.hours)
            Math.abs(n(x.afterApproval[0].amount) - n(x.entry.hours) * 20) < 0.01
            x.time.timeRows.some(row => row.timeEntryId == x.entry.timeEntryId && row.laborRecorded)
            x.time.timesheetRows.some(row => row.timesheetId == x.entry.timesheetId)
            x.reopened.error == ""
            x.afterReopen.length == 2
            n(x.afterReopen[1].quantity) == -n(x.entry.hours)
            n(x.afterReopen[1].amount) == -n(x.afterApproval[0].amount)
            x.afterReopen[1].originalCostEventId == x.afterApproval[0].productionCostEventId
            x.offEvents.length == 0
            rows(TIME, {workEffortId: "PSF_TASK"}).length >= 1
            x.taskEvents.length == 0
        }
    }
)

feature(
    "the labor event follows its entry: approved again a new recording, a work type change re-valued, an hours change a delta, the deletion keeps the events",
    {
        when() {
            const entry = one(TIME, {timeEntryId: state.entryId || rows(TIME, {workEffortId: state.r.assemble})[0].timeEntryId})
            const timeEntryId = entry.timeEntryId
            const events = () =>
                rows(EVENT, {sourceEntityName: TIME, sourceId: timeEntryId}).sort(
                    (a, b) => Number(a.sourceRevision) - Number(b.sourceRevision)
                )
            const sync = () => run("psf_super", P + "sync#ProductionLaborCost", {timeEntryIdList: [timeEntryId]})
            const timesheetId = entry.timesheetId
            const submitted = run("psf_operator", T + "submit#Timesheet", {timesheetId})
            const approved = run("psf_super", T + "approve#Timesheet", {timesheetId})
            const afterApproval = events()
            const repeated = sync()
            // a change of what values it while approved (a plain update, as with the week's lock off): set-up time
            call("update#" + TIME, {timeEntryId, workTypeEnumId: "WktpProductionSetup"})
            const retyped = sync()
            const afterRetype = events()
            call("update#" + TIME, {timeEntryId, hours: n(entry.hours) + 1})
            const changed = sync()
            const afterHours = events()
            const reopened = run("psf_super", T + "reopen#Timesheet", {timesheetId, reason: "Correct the time"})
            const afterReopen = events()
            const deleted = run("psf_operator", "mantle.work.TimeServices.delete#TimeEntry", {timeEntryId})
            return {
                entry,
                submitted,
                approved,
                afterApproval,
                repeated,
                retyped,
                afterRetype,
                changed,
                afterHours,
                reopened,
                afterReopen,
                deleted,
                gone: one(TIME, {timeEntryId}) == null,
                afterDelete: events()
            }
        },
        then(x) {
            const h = n(x.entry.hours)
            const near = (a, b) => Math.abs(n(a) - b) < 0.01
            x.submitted.error == ""
            x.approved.error == ""
            // approved again after the reopen: a new recording at the run rate, naming its entry
            x.afterApproval.length == 3
            n(x.afterApproval[2].quantity) == h
            x.afterApproval[2].rateId == "PSF_RATE"
            x.afterApproval[2].timeEntryId == x.entry.timeEntryId
            x.afterApproval[2].originalCostEventId == null
            x.repeated.error == ""
            x.repeated.productionCostEventIds.length == 0
            // the work type change reverses the run-rate recording and records it again at the set-up rate
            x.retyped.error == ""
            x.afterRetype.length == 5
            n(x.afterRetype[3].quantity) == -h
            near(x.afterRetype[3].amount, -h * 20)
            x.afterRetype[3].originalCostEventId == x.afterApproval[2].productionCostEventId
            n(x.afterRetype[4].quantity) == h
            x.afterRetype[4].rateId == "PSF_RATE_SETUP"
            near(x.afterRetype[4].amount, h * 30)
            // an hour more is a delta at the set-up rate
            x.changed.error == ""
            x.afterHours.length == 6
            near(x.afterHours[5].quantity, 1)
            near(x.afterHours[5].amount, 30)
            x.afterHours[5].originalCostEventId == x.afterRetype[4].productionCostEventId
            // the reopen reverses the set-up recording; the entry of the reopened week is then deleted, its events kept
            x.reopened.error == ""
            x.afterReopen.length == 7
            near(x.afterReopen[6].quantity, -(h + 1))
            near(x.afterReopen[6].amount, -(h + 1) * 30)
            x.deleted.error == ""
            x.gone == true
            x.afterDelete.length == 7
            x.afterDelete.every(row => row.timeEntryId == x.entry.timeEntryId)
            near(
                x.afterDelete.reduce((sum, row) => sum + n(row.quantity), 0),
                0
            )
        }
    }
)

feature("a work order's completion refuses operations not completed on the shop floor until the supervisor closes them", {
    when() {
        const off = state.off
        const recorded = run("psf_operator", P + "record#ProductionQuantity", {
            operationKey: key(),
            workEffortId: off.workEffortId,
            good: 6,
            toLocationSeqId: "PICK1"
        })
        const refused = act("psf_super", off.workEffortId, "complete")
        const closed = act("psf_super", off.workEffortId, "complete", {closeUnreportedOperations: true})
        return {recorded, refused, closed, operations: rows(WORK, {parentWorkEffortId: off.workEffortId})}
    },
    then(x) {
        x.recorded.error == ""
        x.refused.error.includes("OPERATION_UNREPORTED")
        x.refused.error.includes("Assemble")
        x.closed.error == ""
        x.closed.result.resultCode == "COMPLETED"
        x.operations.every(op => op.statusId == "WeComplete")
    }
})

feature("an operator's assignment and a schedule preview read the person's skills (mantle.humanres.ability.PartySkill)", {
    when() {
        const created = run("psf_planner", P + "create#ProductionOrder", {
            operationKey: key(),
            organizationPartyId: org,
            productId: "PSF_FIN",
            quantity: 2,
            facilityId: plant
        })
        const workEffortId = created.workEffortId
        const released = act("psf_planner", workEffortId, "release")
        const assemble = rows(WORK, {parentWorkEffortId: workEffortId}).sort(
            (a, b) => Number(a.operationSequenceNum || 0) - Number(b.operationSequenceNum || 0)
        )[0]
        const assigned = run("psf_planner", P + "store#ProductionParty", {
            operationKey: key(),
            workEffortId,
            expectedRevision: revision(workEffortId),
            partyId: "PSF_OPERATOR2",
            roleTypeId: "Assignee"
        })
        const preview = () =>
            run("psf_super", "mantle.work.ProductionPlanningServices.schedule#ProductionOperation", {
                workEffortId: assemble.workEffortId,
                action: "preview",
                startDate: new Date(Date.now() + 86400000),
                endDate: new Date(Date.now() + 90000000)
            })
        const unqualified = preview()
        call("create#mantle.humanres.ability.PartySkill", {partyId: "PSF_OPERATOR2", skillTypeEnumId: "PSF_SKILL"})
        const qualified = preview()
        call("delete#mantle.humanres.ability.PartySkill", {partyId: "PSF_OPERATOR2", skillTypeEnumId: "PSF_SKILL"})
        return {created, released, assigned, unqualified, qualified}
    },
    then(x) {
        x.created.error == ""
        x.released.error == ""
        x.assigned.error == ""
        x.assigned.result.warnings.some(text => text.includes("Torque wrench"))
        x.unqualified.error == ""
        x.unqualified.result.conflicts.some(row => row.code == "SKILLS")
        x.qualified.error == ""
        x.qualified.result.conflicts.every(row => row.code != "SKILLS")
    }
})

feature("Today leaves out a production run and its operations and keeps plain Mantle's items", {
    when() {
        const now = new Date()
        call("create#" + WORK, {
            workEffortId: "PSF_TODAY_TASK",
            workEffortTypeEnumId: "WetTask",
            statusId: "WeInProgress",
            workEffortName: "Plain task due today",
            ownerPartyId: org,
            estimatedCompletionDate: now
        })
        call("create#" + WORK, {
            workEffortId: "PSF_TODAY_RUN",
            workEffortTypeEnumId: "WetEvent",
            purposeEnumId: "WepProductionRun",
            statusId: "WeInProgress",
            workEffortName: "A run today",
            ownerPartyId: org,
            estimatedStartDate: now,
            estimatedCompletionDate: new Date(now.getTime() + 3600000)
        })
        call("create#" + WORK, {
            workEffortId: "PSF_TODAY_OP",
            workEffortTypeEnumId: "WetTask",
            parentWorkEffortId: "PSF_TODAY_RUN",
            rootWorkEffortId: "PSF_TODAY_RUN",
            statusId: "WeApproved",
            workEffortName: "An operation due today",
            ownerPartyId: org,
            estimatedCompletionDate: now
        })
        for (const workEffortId of ["PSF_TODAY_TASK", "PSF_TODAY_RUN", "PSF_TODAY_OP"])
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId,
                partyId: "PSF_READER",
                roleTypeId: "Assignee",
                fromDate: since,
                statusId: "WeptAssigned"
            })
        const today = as("psf_reader", () => invoke("mantle.work.WorkEffortServices.get#UserTodayItems", {}))
        const all = (today.overdue || []).concat(today.dueToday || [], today.laterToday || [])
        return {today, all}
    },
    then(x) {
        x.today.error == ""
        x.all.some(item => item.workEffortId == "PSF_TODAY_TASK" && item.kind == "task" && item.canUpdate == true)
        x.all.every(item => item.workEffortId != "PSF_TODAY_OP")
        x.all.every(item => item.workEffortId != "PSF_TODAY_RUN")
    }
})

feature("the operation reads are refused outside the user's organizations and without a production permission", {
    when() {
        const r = state.r
        return {
            outsider: run("psf_outsider", P + "get#ProductionOperation", {operationWorkEffortId: r.assemble}),
            outsiderTime: run("psf_outsider", P + "get#ProductionTime", {workEffortId: r.workEffortId}),
            method: run("psf_method", P + "get#ProductionOperation", {operationWorkEffortId: r.assemble}),
            reader: run("psf_reader", P + "get#ProductionOperation", {operationWorkEffortId: r.assemble}),
            readerStart: run("psf_reader", P + "start#ProductionOperation", {operationKey: key(), operationWorkEffortId: r.pack}),
            closedStart: run("psf_operator", P + "start#ProductionOperation", {
                operationKey: key(),
                operationWorkEffortId: r.pack
            })
        }
    },
    then(x) {
        x.outsider.error.includes("RECORD_UNAVAILABLE")
        x.outsiderTime.error.includes("RECORD_UNAVAILABLE")
        x.method.error.includes("PERMISSION_DENIED")
        x.reader.error == ""
        x.reader.productionOperation.can.start == false
        x.readerStart.error.includes("PERMISSION_DENIED")
        x.closedStart.error.includes("RUN_NOT_RUNNING") || x.closedStart.error.includes("OPERATION_CLOSED")
    }
})
