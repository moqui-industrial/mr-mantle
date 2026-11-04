// Release requests of method drafts (impl-manufacturing P2, F40). A method engineer (METHOD_EDIT) asks for a BOM or routing
// draft to be released; the draft's checks run first, and a draft that fails them is not sent. The request notifies the
// method organization's users holding METHOD_APPROVE (BomRelease, RoutingRelease). The decision is the release on the method
// (release#BomDraft, release#RoutingDraft), which marks the notices read; a new request replaces the one before.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const payables = () => ec.resource.script("component://mr-mantle/service/mantle/account/Payables.js")
const BOM = "mantle.product.bom.ProductBom",
    WORK_EFFORT = "mantle.work.effort.WorkEffort"
const topics = {[BOM]: "BomRelease", [WORK_EFFORT]: "RoutingRelease"}

// Each kind of method: its record, the draft it would release, its checks and the notice's message.
function bomRequest(p) {
    const boms = ec.resource.script("component://mr-mantle/service/mantle/product/Boms.js")
    const method = boms.getBom(p.productBomId, "edit")
    const checked = boms.execute("validate", {productBomId: method.bom.productBomId, fromDate: p.fromDate})
    return {
        recordEntityName: BOM,
        recordId: method.bom.productBomId,
        organizationPartyId: method.bom.organizationPartyId,
        draftCount: boms.drafts(method.bom.productBomId).length,
        neverReleased: !boms.decisions(method.bom.productBomId).length,
        checked,
        message: {
            productBomId: method.bom.productBomId,
            productId: method.bom.productId,
            methodName: method.bom.bomName || method.product.productName || method.bom.productId
        }
    }
}
function routingRequest(p) {
    const routings = ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js")
    const method = routings.get(p.workEffortId || p.routingWorkEffortId, "edit")
    const id = method.routing.workEffortId
    const checked = routings.execute("validate", {workEffortId: id})
    return {
        recordEntityName: WORK_EFFORT,
        recordId: id,
        organizationPartyId: method.routing.ownerPartyId,
        draftCount: routings.ops(id).filter(row => row.methodDraft === "Y").length,
        neverReleased: method.routing.methodDraft === "Y",
        checked,
        message: {workEffortId: id, methodName: method.routing.workEffortName || id}
    }
}
function request(p, kind) {
    const why = policy().reason(p)
    const found = kind === BOM ? bomRequest(p) : routingRequest(p)
    if (!found.draftCount && !found.neverReleased)
        return {valid: true, findings: [], notified: false, message: "Nothing is waiting to be released"}
    if (!found.checked.valid) return {valid: false, findings: found.checked.findings, notified: false}
    clear(found.recordEntityName, found.recordId)
    const sent = payables().execute("notify", {
        topic: topics[kind],
        permission: "METHOD_APPROVE",
        organizationPartyId: found.organizationPartyId,
        recordEntityName: found.recordEntityName,
        recordId: found.recordId,
        message: Object.assign({}, found.message, {
            organizationPartyId: found.organizationPartyId,
            changeReason: why,
            expectedRevision: found.checked.expectedRevision,
            requestedByUserId: ec.user.userId
        })
    })
    return {valid: true, findings: [], notified: true, notificationMessageId: sent.notificationMessageId}
}
// The notices about a method are read: on its release, and before a new request.
function clear(recordEntityName, recordId) {
    if (!topics[recordEntityName]) throw new Error("Unknown method kind " + recordEntityName)
    return payables().execute("clearNotices", {topic: topics[recordEntityName], recordEntityName, recordId})
}

const operations = {
    requestBom: p => request(p, BOM),
    requestRouting: p => request(p, WORK_EFFORT)
}
;({
    clear,
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown method release operation " + op)
        return operations[op](p)
    }
})
