// Routing templates are drafts. Approved standards live on dated WeatRoutingComp rows.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const W = "mantle.work.effort.WorkEffort",
    A = "mantle.work.effort.WorkEffortAssoc",
    D = "mantle.work.method.MethodReleaseDecision",
    DI = "mantle.work.method.MethodReleaseItem",
    WC = "mantle.work.production.WorkCenter",
    RATE = "mantle.work.production.WorkCenterRate"
const one = (n, p) => policy().one(n, p),
    rows = (n, p) => policy().rows(n, p),
    find = (n, p) => policy().find(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    pick = (p, f) => policy().pick(p, f),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    active = (r, d) => policy().active(r, d)
const names = ["workEffortName", "description"],
    opFields = [
        ...names,
        "sequenceNum",
        "estimatedSetupTime",
        "estimatedWorkTime",
        "timeUomId",
        "methodMachineSetupTime",
        "methodMachineRunTime",
        "methodBatchQuantity",
        "methodQuantityUomId",
        "methodWorkCenterId",
        "methodPredecessorIds",
        "methodRemoved"
    ]
function get(id, need = "read") {
    const r = one(W, {workEffortId: id})
    if (!r || r.purposeEnumId !== "WepRouting") throw new Error("Routing is not available")
    return {routing: map(r), scope: policy().scope({organizationPartyId: r.ownerPartyId}, need)}
}
function ops(id) {
    return rows(W, {parentWorkEffortId: id, purposeEnumId: "WepRoutingTask"})
        .map(map)
        .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0) || a.workEffortId.localeCompare(b.workEffortId))
}
function releases(id) {
    return rows(D, {methodEntityName: W, methodId: id}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
}
function revision(r) {
    return policy().fingerprint({
        routing: pick(r, [...names, "workEffortId", "lastUpdatedStamp"]),
        operations: ops(r.workEffortId),
        resources: ops(r.workEffortId).map(o => ({
            id: o.workEffortId,
            equipment: rows("mantle.work.effort.WorkEffortAssetNeeded", {workEffortId: o.workEffortId}).map(r =>
                pick(map(r), ["assetProductId", "estimatedQuantity", "estimatedDuration", "lastUpdatedStamp"])
            ),
            skills: rows("mantle.work.effort.WorkEffortSkillStandard", {workEffortId: o.workEffortId}).map(r =>
                pick(map(r), ["skillTypeEnumId", "estimatedNumPeople", "estimatedDuration", "lastUpdatedStamp"])
            )
        })),
        decisions: releases(r.workEffortId).map(r => r.methodReleaseDecisionId)
    })
}
function lock(g, expected, required = false) {
    g.routing = map(find(W, {workEffortId: g.routing.workEffortId}).forUpdate(true).one())
    if (required && !expected) throw new Error("Review the routing and provide its expected revision")
    if (expected && revision(g.routing) !== expected) throw new Error("Routing changed; reload and review")
}
function released(id, date) {
    const g = get(id),
        decision = releases(id).find(r => ms(r.fromDate) <= ms(date))
    if (!decision) throw new Error("Routing has no released operations at this date")
    const refs = JSON.parse(decision.auditRefsJson || "{}"),
        operations = []
    for (const assoc of rows(A, {workEffortId: id, workEffortAssocTypeEnumId: "WeatRoutingComp"}).filter(r => active(r, date))) {
        const op = one(W, {workEffortId: assoc.toWorkEffortId})
        if (!op || op.ownerPartyId !== g.scope.organizationPartyId || op.parentWorkEffortId !== id)
            throw new Error("Released operation is not available")
        const reference = refs.operations?.[op.workEffortId]
        if (!reference) throw new Error("Released operation audit evidence is unavailable")
        operations.push(
            Object.assign(
                {workEffortId: op.workEffortId},
                policy().atAudit(W, op.workEffortId, names, reference.names),
                pick(map(assoc), [
                    "sequenceNum",
                    "setupTime",
                    "runTime",
                    "machineSetupTime",
                    "machineRunTime",
                    "batchQuantity",
                    "quantityUomId",
                    "timeUomId",
                    "workCenterFacilityId",
                    "predecessorWorkEffortIds"
                ]),
                {
                    resources: (reference.resources || []).map(r =>
                        Object.assign(
                            {kind: r.keyField === "assetProductId" ? "Equipment" : "Skill", [r.keyField]: r.key},
                            policy().atAudit(
                                r.entity,
                                op.workEffortId,
                                r.keyField === "assetProductId"
                                    ? ["estimatedQuantity", "estimatedDuration"]
                                    : ["estimatedNumPeople", "estimatedDuration"],
                                r.auditRefs,
                                r.key
                            )
                        )
                    )
                }
            )
        )
    }
    return {
        routing: Object.assign(
            {workEffortId: id, ownerPartyId: g.routing.ownerPartyId},
            policy().atAudit(W, id, names, refs.header)
        ),
        operations: operations.sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0)),
        methodReleaseDecisionId: decision.methodReleaseDecisionId,
        asOfDate: date
    }
}
function resourceRows(id) {
    return [
        ...rows("mantle.work.effort.WorkEffortAssetNeeded", {workEffortId: id}).map(r =>
            Object.assign({kind: "Equipment"}, pick(map(r), ["assetProductId", "estimatedQuantity", "estimatedDuration"]))
        ),
        ...rows("mantle.work.effort.WorkEffortSkillStandard", {workEffortId: id}).map(r =>
            Object.assign({kind: "Skill"}, pick(map(r), ["skillTypeEnumId", "estimatedNumPeople", "estimatedDuration"]))
        )
    ]
}
// Standard times are cost inputs: a method reader without cost read sees the operations without them. An editor keeps
// them, since they are the values the editor maintains.
const timeFields = [
    "estimatedSetupTime",
    "estimatedWorkTime",
    "methodMachineSetupTime",
    "methodMachineRunTime",
    "setupTime",
    "runTime",
    "machineSetupTime",
    "machineRunTime"
]
function withoutTimes(row) {
    const out = Object.assign({}, row)
    for (const field of timeFields) delete out[field]
    return out
}
function detail(p) {
    const g = get(p.workEffortId || p.routingWorkEffortId),
        date = p.asOfDate || ec.user.nowTimestamp,
        decision = releases(g.routing.workEffortId).find(r => ms(r.fromDate) <= ms(date)),
        approved = decision ? released(g.routing.workEffortId, date) : null,
        times = g.scope.costRead || g.scope.edit,
        shown = row => (times ? row : withoutTimes(row))
    return {
        routing: pick(g.routing, [...names, "workEffortId", "ownerPartyId", "methodDraft"]),
        operationRows: ops(g.routing.workEffortId)
            .filter(o => o.methodDraft === "Y")
            .map(o => shown(Object.assign(pick(o, ["workEffortId", ...opFields]), {resources: resourceRows(o.workEffortId)}))),
        releasedOperationRows: (approved?.operations || []).map(shown),
        standardTimesShown: times,
        releaseHistory: releases(g.routing.workEffortId).map(r =>
            pick(map(r), ["methodReleaseDecisionId", "fromDate", "approvedDate", "approvedByUserId", "changeReason"])
        ),
        approvedRouting: approved?.routing || null,
        expectedRevision: revision(g.routing),
        methodAccess: g.scope,
        asOfDate: date
    }
}
function list(p) {
    const s = policy().scope(p)
    let query = find(W, {ownerPartyId: s.organizationPartyId, purposeEnumId: "WepRouting"})
    // Manufacturing's Routings list (P2): its text search, by id and name ignoring case
    const text = String(p.text || "").trim()
    if (text) {
        const factory = ec.entity.conditionFactory,
            pattern = "%" + text.replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            factory.makeCondition(
                ["workEffortId", "workEffortName"].map(field => factory.makeCondition(field, "like", pattern).ignoreCase()),
                "or"
            )
        )
    }
    return {
        routingRows: Array.from(query.orderBy("workEffortName").list()).map(r => {
            const operations = ops(r.workEffortId).filter(o => o.methodRemoved !== "Y")
            return Object.assign(pick(map(r), ["workEffortId", ...names, "ownerPartyId", "methodDraft"]), {
                lastReleaseDate: releases(r.workEffortId)[0]?.fromDate || null,
                operationCount: operations.length,
                draftOperationCount: ops(r.workEffortId).filter(o => o.methodDraft === "Y").length
            })
        }),
        organizationPartyId: s.organizationPartyId
    }
}
function store(p) {
    const old = p.workEffortId ? get(p.workEffortId, "edit") : null,
        s = old?.scope || policy().scope(p, "edit"),
        why = policy().reason(p)
    if (old) lock(old, p.expectedRevision)
    if (!String(p.workEffortName || old?.routing.workEffortName || "").trim()) throw new Error("Give the routing a name")
    policy().audit([...names, "methodChangeReason"], why)
    const out = call(
        (old ? "update#" : "create#") + W,
        Object.assign(pick(p, names), {
            workEffortId: p.workEffortId,
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepRouting",
            ownerPartyId: s.organizationPartyId,
            isTemplate: "Y",
            methodDraft: "Y",
            methodChangeReason: why
        })
    )
    const id = p.workEffortId || out.workEffortId
    policy().recordAudit(W, {workEffortId: id}, names, old?.routing || {}, map(one(W, {workEffortId: id})), why)
    return detail({workEffortId: id})
}
function validateOperation(data, g) {
    if (!data.workEffortName) throw new Error("Give the operation a name")
    for (const field of ["estimatedSetupTime", "estimatedWorkTime", "methodMachineSetupTime", "methodMachineRunTime"])
        if (toDecimal(data[field] || 0).compare(0) < 0) throw new Error("Operation times cannot be negative")
    if (toDecimal(data.methodBatchQuantity || 0).compare(0) <= 0) throw new Error("Operation batch quantity must be positive")
    policy().unit(data.methodQuantityUomId)
    const time = policy().unit(data.timeUomId)
    if (time.uomTypeEnumId !== "UT_TIME_FREQ_MEASURE") throw new Error("Choose a time unit for operation standards")
    policy().convert(1, data.timeUomId, "TF_hr", ec.user.nowTimestamp)
    if (data.methodWorkCenterId) {
        policy().facility(data.methodWorkCenterId, g.scope)
        if (!one(WC, {facilityId: data.methodWorkCenterId})) throw new Error("Configure the work center before selecting it")
    }
    data.methodPredecessorIds = [
        ...new Set(
            String(data.methodPredecessorIds || "")
                .split(",")
                .map(v => v.trim())
                .filter(Boolean)
        )
    ]
        .sort()
        .join(",")
}
function operation(p) {
    const old = p.operationWorkEffortId ? one(W, {workEffortId: p.operationWorkEffortId}) : null,
        id = old?.parentWorkEffortId || p.workEffortId || p.routingWorkEffortId,
        g = get(id, "edit"),
        why = policy().reason(p)
    if (
        (p.operationWorkEffortId && (!old || old.purposeEnumId !== "WepRoutingTask")) ||
        (p.workEffortId && p.workEffortId !== id)
    )
        throw new Error("Operation does not belong to this routing")
    lock(g, p.expectedRevision)
    if (old && old.ownerPartyId !== g.scope.organizationPartyId) throw new Error("Operation is not in the method organization")
    const data = Object.assign(
        {
            estimatedSetupTime: 0,
            estimatedWorkTime: 0,
            methodMachineSetupTime: 0,
            methodMachineRunTime: 0,
            methodBatchQuantity: 1,
            methodQuantityUomId: "OTH_ea",
            timeUomId: "TF_hr",
            sequenceNum: 10,
            methodRemoved: "N"
        },
        old ? pick(map(old), opFields) : {},
        pick(p, opFields)
    )
    if (data.sequenceNum == null) data.sequenceNum = 10
    validateOperation(data, g)
    const operationWorkEffortId = old?.workEffortId || "mop-" + ec.user.randomString(24)
    policy().audit([...opFields, "methodChangeReason"], why)
    call(
        (old ? "update#" : "create#") + W,
        Object.assign(data, {
            workEffortId: operationWorkEffortId,
            parentWorkEffortId: id,
            ownerPartyId: g.scope.organizationPartyId,
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepRoutingTask",
            isTemplate: "Y",
            methodDraft: "Y",
            methodChangeReason: why
        })
    )
    policy().recordAudit(
        W,
        {workEffortId: operationWorkEffortId},
        [...names, "sequenceNum", "estimatedSetupTime", "timeUomId"],
        old ? map(old) : {},
        map(one(W, {workEffortId: operationWorkEffortId})),
        why
    )
    return Object.assign(detail({workEffortId: id}), {operationWorkEffortId})
}
function resource(p) {
    const op = one(W, {workEffortId: p.operationWorkEffortId})
    if (!op || op.purposeEnumId !== "WepRoutingTask") throw new Error("Routing operation is not available")
    const g = get(op.parentWorkEffortId, "edit"),
        why = policy().reason(p)
    lock(g, p.expectedRevision)
    if (op.ownerPartyId !== g.scope.organizationPartyId) throw new Error("Operation is not in the method organization")
    let entity, key, fields
    if (p.assetProductId) {
        policy().product(p.assetProductId, g.scope)
        entity = "mantle.work.effort.WorkEffortAssetNeeded"
        key = {workEffortId: op.workEffortId, assetProductId: p.assetProductId}
        fields = ["estimatedQuantity", "estimatedDuration"]
    } else if (p.skillTypeEnumId) {
        const skill = one("moqui.basic.Enumeration", {enumId: p.skillTypeEnumId})
        if (!skill || skill.enumTypeId !== "SkillType") throw new Error("Choose a skill")
        entity = "mantle.work.effort.WorkEffortSkillStandard"
        key = {workEffortId: op.workEffortId, skillTypeEnumId: p.skillTypeEnumId}
        fields = ["estimatedNumPeople", "estimatedDuration"]
    } else throw new Error("Choose equipment or a skill")
    const existing = one(entity, key),
        data = Object.assign({}, existing ? pick(map(existing), fields) : {}, pick(p, fields))
    for (const f of fields)
        if (data[f] != null && toDecimal(data[f]).compare(0) < 0)
            throw new Error("Resource quantities and durations cannot be negative")
    policy().audit([...fields, "methodChangeReason"], why)
    call((existing ? "update#" : "create#") + entity, Object.assign(key, data))
    policy().recordAudit(entity, key, fields, existing ? map(existing) : {}, map(one(entity, key)), why)
    call("update#" + W, {workEffortId: op.workEffortId, methodDraft: "Y", methodChangeReason: why})
    return detail({workEffortId: op.parentWorkEffortId})
}
function validate(p) {
    const g = get(p.workEffortId || p.routingWorkEffortId),
        findings = [],
        operations = ops(g.routing.workEffortId).filter(r => r.methodRemoved !== "Y"),
        ids = new Set(operations.map(r => r.workEffortId))
    if (!operations.length) findings.push({recordId: g.routing.workEffortId, message: "Routing requires at least one operation"})
    for (const o of operations)
        try {
            validateOperation(o, g)
            for (const id of String(o.methodPredecessorIds || "")
                .split(",")
                .filter(Boolean))
                if (!ids.has(id)) throw new Error("Predecessor " + id + " is not in this routing")
            function walk(id, path) {
                if (path.includes(id)) throw new Error("Operation dependency cycle")
                const r = operations.find(r => r.workEffortId === id)
                for (const next of String(r?.methodPredecessorIds || "")
                    .split(",")
                    .filter(Boolean))
                    walk(next, [...path, id])
            }
            walk(o.workEffortId, [])
        } catch (e) {
            findings.push({recordId: o.workEffortId, message: String(e.message || e)})
        }
    return {valid: !findings.length, findings, expectedRevision: revision(g.routing)}
}
function release(p) {
    const g = get(p.workEffortId || p.routingWorkEffortId, "approve"),
        why = policy().reason(p),
        now = ec.user.nowTimestamp,
        date = p.fromDate || now
    lock(g, p.expectedRevision, true)
    if (ms(date) < ms(now)) throw new Error("Routing release must start now or later")
    if (releases(g.routing.workEffortId).some(r => ms(r.fromDate) >= ms(date)))
        throw new Error("Release must follow the latest scheduled routing approval")
    const check = validate({workEffortId: g.routing.workEffortId})
    if (!check.valid)
        throw new Error("Routing release refused: " + check.findings.map(r => r.recordId + ": " + r.message).join("; "))
    const operations = ops(g.routing.workEffortId),
        removed = operations.filter(o => o.methodRemoved === "Y").map(o => o.workEffortId)
    // Removing a referenced operation needs a BOM release first; existing run lines never change.
    for (const item of rows("mantle.product.bom.ProductBomItem", {state: "released"}).filter(
        r => removed.includes(r.operationWorkEffortId) && (ms(r.thruDate) ?? Infinity) > ms(date)
    ))
        throw new Error("Operation is referenced by released BOM line " + item.bomItemId)
    const id = "mrd-" + ec.user.randomString(24),
        refs = {header: policy().capture(W, g.routing.workEffortId, names), operations: {}},
        stamped = []
    policy().audit(["thruDate", "fromDate", "methodDraft", "methodFromDate", "methodChangeReason"], why)
    for (const row of rows(A, {workEffortId: g.routing.workEffortId, workEffortAssocTypeEnumId: "WeatRoutingComp"}).filter(
        r => !r.thruDate
    )) {
        call(
            "update#" + A,
            Object.assign(pick(map(row), ["workEffortId", "toWorkEffortId", "workEffortAssocTypeEnumId"]), {
                fromDate: iso(row.fromDate),
                thruDate: iso(date)
            })
        )
        policy().recordAudit(
            A,
            pick(map(row), ["workEffortId", "toWorkEffortId", "workEffortAssocTypeEnumId", "fromDate"]),
            ["thruDate"],
            map(row),
            {thruDate: iso(date)},
            why
        )
        stamped.push({lineId: row.toWorkEffortId, action: "end", previousFromDate: row.fromDate})
    }
    for (const op of operations) {
        if (op.methodRemoved !== "Y") {
            refs.operations[op.workEffortId] = {names: policy().capture(W, op.workEffortId, names), resources: []}
            for (const [entity, keyField, fields] of [
                ["mantle.work.effort.WorkEffortAssetNeeded", "assetProductId", ["estimatedQuantity", "estimatedDuration"]],
                ["mantle.work.effort.WorkEffortSkillStandard", "skillTypeEnumId", ["estimatedNumPeople", "estimatedDuration"]]
            ])
                for (const row of rows(entity, {workEffortId: op.workEffortId})) {
                    const refsByField = policy().capture(entity, op.workEffortId, fields, row[keyField])
                    refs.operations[op.workEffortId].resources.push({
                        entity,
                        keyField,
                        key: row[keyField],
                        auditRefs: refsByField
                    })
                }
            call("create#" + A, {
                workEffortId: g.routing.workEffortId,
                toWorkEffortId: op.workEffortId,
                workEffortAssocTypeEnumId: "WeatRoutingComp",
                fromDate: iso(date),
                sequenceNum: op.sequenceNum,
                setupTime: op.estimatedSetupTime || 0,
                runTime: op.estimatedWorkTime || 0,
                machineSetupTime: op.methodMachineSetupTime || 0,
                machineRunTime: op.methodMachineRunTime || 0,
                batchQuantity: op.methodBatchQuantity,
                quantityUomId: op.methodQuantityUomId,
                timeUomId: op.timeUomId,
                workCenterFacilityId: op.methodWorkCenterId,
                predecessorWorkEffortIds: op.methodPredecessorIds,
                methodReleaseDecisionId: id
            })
            policy().recordAudit(
                A,
                {
                    workEffortId: g.routing.workEffortId,
                    toWorkEffortId: op.workEffortId,
                    workEffortAssocTypeEnumId: "WeatRoutingComp",
                    fromDate: date
                },
                ["fromDate", "sequenceNum"],
                {},
                {fromDate: iso(date), sequenceNum: op.sequenceNum},
                why
            )
            stamped.push({lineId: op.workEffortId, action: "start"})
        }
        call("update#" + W, {workEffortId: op.workEffortId, methodDraft: "N", methodFromDate: iso(date), methodChangeReason: why})
    }
    call("create#" + D, {
        methodReleaseDecisionId: id,
        methodEntityName: W,
        methodId: g.routing.workEffortId,
        fromDate: iso(date),
        approvedDate: now,
        approvedByUserId: ec.user.userId,
        changeReason: why,
        inputFingerprint: p.expectedRevision,
        auditRefsJson: JSON.stringify(refs)
    })
    for (let i = 0; i < stamped.length; i++)
        call(
            "create#" + DI,
            Object.assign({methodReleaseDecisionId: id, itemSeqId: i + 1, lineEntityName: A, fromDate: iso(date)}, stamped[i])
        )
    call("update#" + W, {workEffortId: g.routing.workEffortId, methodDraft: "N", methodChangeReason: why})
    // the release decides what was asked for: its approvers' RoutingRelease notices are read (MethodReleases.js)
    ec.resource.script("component://mr-mantle/service/mantle/product/MethodReleases.js").clear(W, g.routing.workEffortId)
    return Object.assign(detail({workEffortId: g.routing.workEffortId, asOfDate: date}), {
        methodReleaseDecisionId: id,
        stampedLines: stamped,
        valid: true,
        findings: []
    })
}
// store#WorkCenter is WorkCenters.js's since Manufacturing P3 (capacities, alternates, the plant and a new line)
function center(p) {
    return ec.resource.script("component://mr-mantle/service/mantle/work/WorkCenters.js").execute("center", p)
}
function rate(p) {
    const s = policy().scope(p, "resources"),
        why = policy().reason(p)
    if (!s.costWrite) throw new Error("Separate cost-write authority is required")
    policy().facility(p.facilityId, s)
    if (!one(WC, {facilityId: p.facilityId})) throw new Error("Configure the work center first")
    find(WC, {facilityId: p.facilityId}).forUpdate(true).one()
    const approved = p.approve === true || p.approve === "Y"
    if (approved && !s.costApprove) throw new Error("Separate cost-approval authority is required")
    const old = p.workCenterRateId ? one(RATE, {workCenterRateId: p.workCenterRateId}) : null
    if ((p.workCenterRateId && (!old || old.facilityId !== p.facilityId)) || old?.state === "approved")
        throw new Error("Approved rates are immutable; create a dated replacement")
    const data = Object.assign(
            old ? map(old) : {},
            pick(p, ["componentTypeEnumId", "rateAmount", "priceUomId", "fromDate", "thruDate"])
        ),
        now = ec.user.nowTimestamp,
        date = data.fromDate || now
    if (ms(date) < ms(now)) throw new Error("Work-center rate must start now or later")
    if (data.thruDate && ms(data.thruDate) <= ms(date)) throw new Error("Rate end must follow its start")
    if (!["PccLabor", "PccMachine", "PccOverhead"].includes(data.componentTypeEnumId))
        throw new Error("Choose an hourly labor, machine or overhead component")
    if (data.rateAmount == null || toDecimal(data.rateAmount).compare(0) < 0) throw new Error("Rate cannot be negative")
    const u = one("moqui.basic.Uom", {uomId: data.priceUomId})
    if (!u || u.uomTypeEnumId !== "UT_CURRENCY_MEASURE") throw new Error("Choose a currency for the hourly rate")
    const history = rows(RATE, {
        facilityId: p.facilityId,
        componentTypeEnumId: data.componentTypeEnumId,
        priceUomId: data.priceUomId,
        state: "approved"
    }).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))
    if (history.some(r => ms(r.fromDate) === ms(date))) throw new Error("A rate already starts on this date")
    const previous = history.filter(r => ms(r.fromDate) < ms(date)).at(-1),
        next = history.find(r => ms(r.fromDate) > ms(date))
    if (next && (!data.thruDate || ms(data.thruDate) > ms(next.fromDate))) data.thruDate = iso(next.fromDate)
    if (p.expectedRevision && p.expectedRevision !== policy().fingerprint(history.map(map)))
        throw new Error("Work-center rates changed; reload")
    policy().audit(
        ["rateAmount", "priceUomId", "fromDate", "thruDate", "state", "approvedDate", "approvedByUserId", "changeReason"],
        why
    )
    if (approved && previous && (!previous.thruDate || ms(previous.thruDate) > ms(date)))
        call("update#" + RATE, {workCenterRateId: previous.workCenterRateId, thruDate: iso(date), changeReason: why})
    const id = old?.workCenterRateId || "wcr-" + ec.user.randomString(24)
    call(
        (old ? "update#" : "create#") + RATE,
        Object.assign(pick(data, ["componentTypeEnumId", "rateAmount", "priceUomId", "thruDate"]), {
            workCenterRateId: id,
            facilityId: p.facilityId,
            fromDate: iso(date),
            state: approved ? "approved" : "draft",
            approvedDate: approved ? now : null,
            approvedByUserId: approved ? ec.user.userId : null,
            changeReason: why
        })
    )
    return {workCenterRate: map(one(RATE, {workCenterRateId: id}))}
}
function costBasis(p) {
    const g = get(p.workEffortId || p.routingWorkEffortId)
    if (!g.scope.costRead) throw new Error("Separate cost-read authority is required")
    const date = p.asOfDate || ec.user.nowTimestamp,
        r = released(g.routing.workEffortId, date),
        out = [],
        findings = [],
        quantity = toDecimal(p.quantity ?? 1)
    if (quantity.compare(0) <= 0) throw new Error("Cost-basis quantity must be positive")
    for (const op of r.operations.filter(o => !p.operationWorkEffortId || o.workEffortId === p.operationWorkEffortId))
        try {
            const normalized = policy().convert(quantity, p.quantityUomId || op.quantityUomId, op.quantityUomId, date).quantity
            const lot =
                p.costingLotQuantity == null
                    ? null
                    : policy().convert(
                          p.costingLotQuantity,
                          p.costingLotUomId || p.quantityUomId || op.quantityUomId,
                          op.quantityUomId,
                          date
                      ).quantity
            if (lot && lot.compare(0) <= 0) throw new Error("Costing lot size must be positive")
            const setupCycles = lot ? normalized.divide(lot) : toDecimal(1),
                center = op.workCenterFacilityId ? one(WC, {facilityId: op.workCenterFacilityId}) : null,
                efficiency = p.applyEfficiency ? toDecimal(center?.efficiencyPercent ?? 100).divide(100) : toDecimal(1)
            if (efficiency.compare(0) <= 0) throw new Error("Work-center efficiency must be positive")
            // Standards cost one BOM lot: whole operation cycles within that lot, then allocate the lot cost.
            const batches = lot
                ? lot.divide(op.batchQuantity).setScale(0, "CEILING").multiply(setupCycles)
                : normalized.divide(op.batchQuantity)
            const labor = policy()
                    .convert(
                        toDecimal(op.setupTime || 0)
                            .multiply(setupCycles)
                            .add(toDecimal(op.runTime || 0).multiply(batches)),
                        op.timeUomId,
                        "TF_hr",
                        date
                    )
                    .quantity.divide(efficiency),
                machine = policy()
                    .convert(
                        toDecimal(op.machineSetupTime || 0)
                            .multiply(setupCycles)
                            .add(toDecimal(op.machineRunTime || 0).multiply(batches)),
                        op.timeUomId,
                        "TF_hr",
                        date
                    )
                    .quantity.divide(efficiency),
                hours = {PccLabor: labor, PccMachine: machine, PccOverhead: machine.compare(0) > 0 ? machine : labor}

            if (op.workCenterFacilityId) policy().facility(op.workCenterFacilityId, g.scope)
            const requested = p.componentTypeEnumIds || ["PccLabor", "PccMachine", "PccOverhead"]
            if (requested.some(c => !["PccLabor", "PccMachine", "PccOverhead"].includes(c)))
                throw new Error("Choose supported hourly cost components")
            for (const component of requested) {
                if (hours[component].isZero()) continue
                const available = op.workCenterFacilityId
                    ? rows(RATE, {facilityId: op.workCenterFacilityId, componentTypeEnumId: component, state: "approved"}).filter(
                          r => active(r, date)
                      )
                    : []
                const exact = p.priceUomId ? available.filter(r => r.priceUomId === p.priceUomId) : available
                const rates = exact.length || !p.allowCurrencyConversion ? exact : available
                if (rates.length !== 1) {
                    out.push({
                        workEffortId: op.workEffortId,
                        componentTypeEnumId: component,
                        hours: String(hours[component]),
                        amount: null,
                        valued: false
                    })
                    findings.push({recordId: op.workEffortId, message: "No unique effective " + component + " hourly rate"})
                    continue
                }
                const rate = rates[0]
                out.push({
                    workEffortId: op.workEffortId,
                    componentTypeEnumId: component,
                    hours: String(hours[component]),
                    rateAmount: String(rate.rateAmount),
                    priceUomId: rate.priceUomId,
                    workCenterRateId: rate.workCenterRateId,
                    amount: String(hours[component].multiply(rate.rateAmount)),
                    valued: true
                })
            }
        } catch (e) {
            findings.push({recordId: op.workEffortId, message: String(e.message || e)})
            ec.logger.error("Routing cost basis " + op.workEffortId + ": " + e)
        }
    return {
        operationCostRows: out,
        complete: !findings.length,
        findings,
        asOfDate: date,
        methodReleaseDecisionId: r.methodReleaseDecisionId
    }
}
function access(p) {
    try {
        const id = p.workEffortId || p.routingWorkEffortId,
            row = one(W, {workEffortId: id}),
            // an operation template (a routing task with no routing, OperationTemplates.js) by its own organization
            g =
                row?.purposeEnumId === "WepRoutingTask" && !row.parentWorkEffortId
                    ? {scope: policy().scope({organizationPartyId: row.ownerPartyId}, p.need || "read")}
                    : get(row?.purposeEnumId === "WepRoutingTask" ? row.parentWorkEffortId : id, p.need || "read")
        return {
            recordVisible: true,
            record: pick(map(row), ["workEffortId", "ownerPartyId", "workEffortName", "purposeEnumId"]),
            canChange: g.scope.edit
        }
    } catch (e) {
        return {recordVisible: false, canChange: false}
    }
}
function execute(op, p) {
    return {list, detail, store, operation, resource, validate, release, center, rate, costBasis, access}[op](p)
}
;({execute, released, get, ops, lock, revision, validateOperation, detail, opFields})
