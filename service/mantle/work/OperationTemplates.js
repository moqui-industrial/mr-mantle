// Operation templates, their published instructions and copies into routings (impl-manufacturing P2, §4; design
// OperationTemplates). A template is a WepRoutingTask with no routing (parentWorkEffortId empty), owned by its organization,
// with its standards, center requirement, required evidence and quality template as audit-logged fields. A published
// instruction is a WectInstruction WorkEffortContent row of the template: its file is stored once with its checksum, and a
// publish ends the one in effect and starts the next (fromDate, thruDate). Copying operations into a routing makes draft
// operations with their source (methodSourceWorkEffortId); it never changes the source or a released routing. Archive blocks
// new copies only. Each service checks METHOD_VIEW or METHOD_EDIT and the organization through MethodPolicy.js.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const routings = () => ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js")
const W = "mantle.work.effort.WorkEffort",
    CONTENT = "mantle.work.effort.WorkEffortContent",
    INSTRUCTION = "WectInstruction"
const one = (n, p) => policy().one(n, p),
    rows = (n, p) => policy().rows(n, p),
    find = (n, p) => policy().find(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    pick = (p, f) => policy().pick(p, f),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    active = (r, d) => policy().active(r, d)

const names = ["workEffortName", "description"]
const standards = [
    "estimatedSetupTime",
    "estimatedWorkTime",
    "timeUomId",
    "methodMachineSetupTime",
    "methodMachineRunTime",
    "methodBatchQuantity",
    "methodQuantityUomId",
    "methodWorkCenterId"
]
const qualityFields = ["methodRequiredEvidence", "methodInspectionTemplateId"]
const templateFields = [...names, ...standards, ...qualityFields, "methodArchived"]
// standard times are cost inputs, shown to an editor or a cost reader only (as Routings.js)
const timeFields = ["estimatedSetupTime", "estimatedWorkTime", "methodMachineSetupTime", "methodMachineRunTime"]

// A template of the user's method organizations, with the scope the need asks for.
function template(id, need = "read") {
    const row = id ? one(W, {workEffortId: id}) : null
    if (!row || row.purposeEnumId !== "WepRoutingTask" || row.parentWorkEffortId)
        throw new Error("Operation template is not available")
    return {template: map(row), scope: policy().scope({organizationPartyId: row.ownerPartyId}, need)}
}
function instructions(id) {
    return rows(CONTENT, {workEffortId: id, contentTypeEnumId: INSTRUCTION})
        .map(map)
        .sort((a, b) => (ms(b.fromDate) ?? 0) - (ms(a.fromDate) ?? 0))
}
// The instruction of a template in effect at a date (a run's operation reads it as of its release), or null.
function instructionAt(id, date) {
    return instructions(id).find(row => row.fromDate && active(row, date || ec.user.nowTimestamp)) || null
}
function revision(row) {
    return policy().fingerprint({
        template: pick(row, ["workEffortId", ...templateFields, "lastUpdatedStamp"]),
        instructions: instructions(row.workEffortId).map(r => [r.workEffortContentId, r.fromDate, r.thruDate])
    })
}
function shown(row, scope) {
    const out = Object.assign({}, row)
    if (!scope.costRead && !scope.edit) for (const field of timeFields) delete out[field]
    return out
}
function instructionRow(row) {
    return row
        ? pick(row, [
              "workEffortContentId",
              "description",
              "contentLocation",
              "contentChecksum",
              "fromDate",
              "thruDate",
              "userId"
          ])
        : null
}
function templateRow(row, scope, date) {
    const inspection = row.methodInspectionTemplateId
        ? one("mantle.product.quality.InspectionTemplate", {inspectionTemplateId: row.methodInspectionTemplateId})
        : null
    return Object.assign(shown(pick(row, ["workEffortId", "ownerPartyId", ...templateFields]), scope), {
        archived: row.methodArchived === "Y",
        inspectionTemplateName: inspection?.templateName || null,
        instruction: instructionRow(instructionAt(row.workEffortId, date))
    })
}

// find#OperationTemplates: the organization's templates, searched by id and name ignoring case, archived ones only when
// asked, a page at a time; or one template with its instruction history and expected revision.
function findTemplates(p) {
    const date = p.asOfDate || ec.user.nowTimestamp
    if (p.workEffortId) {
        const g = template(p.workEffortId)
        return {
            template: templateRow(g.template, g.scope, date),
            instructionRows: instructions(g.template.workEffortId).map(instructionRow),
            expectedRevision: revision(g.template),
            organizationPartyId: g.scope.organizationPartyId,
            methodAccess: g.scope
        }
    }
    const scope = policy().scope(p)
    const factory = ec.entity.conditionFactory
    // a find runs once: one for the count and one for the page
    const templates = () => {
        let query = find(W, {ownerPartyId: scope.organizationPartyId, purposeEnumId: "WepRoutingTask"}).condition(
            "parentWorkEffortId",
            "is-null",
            null
        )
        if (!(p.includeArchived === true || p.includeArchived === "Y"))
            query = query.condition(
                factory.makeCondition(
                    [
                        factory.makeCondition("methodArchived", "is-null", null),
                        factory.makeCondition("methodArchived", "equals", "N")
                    ],
                    "or"
                )
            )
        const text = String(p.text || "").trim()
        if (text) {
            const pattern = "%" + text.replace(/[\\%_]/g, character => "\\" + character) + "%"
            query = query.condition(
                factory.makeCondition(
                    ["workEffortId", "workEffortName"].map(field => factory.makeCondition(field, "like", pattern).ignoreCase()),
                    "or"
                )
            )
        }
        return query
    }
    const count = templates().count()
    const pageSize = Math.max(1, Math.min(200, Number(p.pageSize || 50))),
        pageIndex = Math.max(0, Number(p.pageIndex || 0))
    const found = Array.from(
        templates()
            .orderBy("workEffortName")
            .orderBy("workEffortId")
            .offset(pageIndex * pageSize)
            .limit(pageSize)
            .list()
    )
    const templateRows = []
    for (const row of found)
        try {
            templateRows.push(templateRow(map(row), scope, date))
        } catch (error) {
            ec.logger.error("Operation template " + row.workEffortId + " omitted: " + error)
        }
    return {templateRows, templateCount: count, pageIndex, pageSize, organizationPartyId: scope.organizationPartyId}
}

function validateTemplate(data, scope) {
    routings().validateOperation(data, {scope})
    delete data.methodPredecessorIds
    if (!["Y", "N"].includes(data.methodArchived)) throw new Error("Choose Yes or No for archived")
    if (data.methodRequiredEvidence && String(data.methodRequiredEvidence).length > 255)
        throw new Error("Describe the required evidence in at most 255 characters")
    if (data.methodInspectionTemplateId) {
        const inspection = one("mantle.product.quality.InspectionTemplate", {
            inspectionTemplateId: data.methodInspectionTemplateId
        })
        if (
            !inspection ||
            inspection.organizationPartyId !== scope.organizationPartyId ||
            inspection.inspectionContextEnumId !== "QicProduction" ||
            inspection.statusId === "QtRetired"
        )
            throw new Error("Choose a production inspection template of the method organization")
    }
}
// store#OperationTemplate: a new template, or a change to one at its expected revision.
function storeTemplate(p) {
    const old = p.workEffortId ? template(p.workEffortId, "edit") : null
    const scope = old?.scope || policy().scope(p, "edit"),
        why = policy().reason(p)
    if (old) {
        old.template = map(find(W, {workEffortId: old.template.workEffortId}).forUpdate(true).one())
        if (p.expectedRevision && revision(old.template) !== p.expectedRevision)
            throw new Error("Operation template changed; reload and review")
    }
    const data = Object.assign(
        {
            estimatedSetupTime: 0,
            estimatedWorkTime: 0,
            methodMachineSetupTime: 0,
            methodMachineRunTime: 0,
            methodBatchQuantity: 1,
            timeUomId: "TF_hr",
            methodArchived: "N"
        },
        old ? pick(old.template, templateFields) : {},
        pick(p, templateFields)
    )
    if (data.methodArchived === true) data.methodArchived = "Y"
    validateTemplate(data, scope)
    policy().audit([...templateFields, "methodChangeReason"], why)
    const out = call(
        (old ? "update#" : "create#") + W,
        Object.assign({}, data, {
            workEffortId: old?.template.workEffortId,
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepRoutingTask",
            ownerPartyId: scope.organizationPartyId,
            isTemplate: "Y",
            methodChangeReason: why
        })
    )
    const id = old?.template.workEffortId || out.workEffortId
    // the names have no audit log of their own (WorkEffort's legacy policy): the method writes them, as Routings.js does
    policy().recordAudit(W, {workEffortId: id}, names, old?.template || {}, map(one(W, {workEffortId: id})), why)
    return findTemplates({workEffortId: id})
}

function filename(p) {
    return String(p.contentFile?.getName() || p.filename || "instruction.md")
        .replace(/[\/\\?#%:*"<>|]/g, "_")
        .slice(0, 160)
}
// store#OperationInstruction: publish the template's next instruction, from a file or text. It starts at its fromDate (now
// by default, never earlier, and after the last one published), and ends the instruction in effect then.
function storeInstruction(p) {
    const g = template(p.workEffortId, "edit"),
        why = policy().reason(p),
        now = ec.user.nowTimestamp,
        date = p.fromDate || now
    if (g.template.methodArchived === "Y") throw new Error("An archived template takes no new instruction")
    if (!p.contentFile && !String(p.contentText || "").trim()) throw new Error("Choose an instruction file or enter its text")
    if (ms(date) < ms(now) - 1000) throw new Error("An instruction takes effect now or later")
    find(W, {workEffortId: g.template.workEffortId}).forUpdate(true).one()
    if (p.expectedRevision && revision(g.template) !== p.expectedRevision)
        throw new Error("Operation template changed; reload and review")
    const history = instructions(g.template.workEffortId)
    if (history.some(row => row.fromDate && ms(row.fromDate) >= ms(date)))
        throw new Error("A published instruction already starts on or after this date")
    const contentId = ec.entity.sequencedIdPrimary(CONTENT, null, null)
    const name = filename(p),
        location = "dbresource://mantle/content/workEffort/" + g.template.workEffortId + "/instruction_" + contentId + "/" + name,
        ref = ec.resource.getLocationReference(location)
    if (ref.getExists()) throw new Error("Instruction file already exists")
    if (p.contentFile) {
        const stream = p.contentFile.getInputStream()
        try {
            ref.putStream(stream)
        } finally {
            stream.close()
        }
    } else ref.putText(String(p.contentText))
    const checksum = ec.resource.digest(location, "sha256")
    policy().audit(["fromDate", "thruDate"], why)
    const current = history.find(row => !row.thruDate || ms(row.thruDate) > ms(date))
    if (current) call("update#" + CONTENT, {workEffortContentId: current.workEffortContentId, thruDate: iso(date)})
    call("create#" + CONTENT, {
        workEffortContentId: contentId,
        workEffortId: g.template.workEffortId,
        contentTypeEnumId: INSTRUCTION,
        contentLocation: location,
        contentChecksum: checksum,
        description: String(p.description || name).slice(0, 4000),
        fromDate: iso(date),
        contentDate: now,
        userId: ec.user.userId
    })
    return Object.assign(findTemplates({workEffortId: g.template.workEffortId}), {workEffortContentId: contentId})
}

// The operations to copy: templates (not archived) or operations of another routing, all of the target's organization.
function sources(ids, scope, targetId) {
    return ids.map(id => {
        const row = one(W, {workEffortId: id})
        if (!row || row.purposeEnumId !== "WepRoutingTask" || row.ownerPartyId !== scope.organizationPartyId)
            throw new Error("Operation " + id + " is not available")
        if (!row.parentWorkEffortId && row.methodArchived === "Y")
            throw new Error("Operation template " + id + " is archived and blocks new use")
        if (row.parentWorkEffortId === targetId) throw new Error("Operation " + id + " is already in this routing")
        if (row.methodRemoved === "Y") throw new Error("Operation " + id + " is removed")
        return map(row)
    })
}
// copy#RoutingOperations: draft copies, in order after the routing's operations, of templates or another routing's
// operations; predecessors among the copied operations follow them. With replaceExisting the routing's current operations
// are marked removed in the draft (a release then ends them).
function copyOperations(p) {
    const target = routings().get(p.workEffortId || p.routingWorkEffortId, "edit"),
        why = policy().reason(p),
        targetId = target.routing.workEffortId
    routings().lock(target, p.expectedRevision)
    const ids = (Array.isArray(p.sourceWorkEffortIds) ? p.sourceWorkEffortIds : String(p.sourceWorkEffortIds || "").split(","))
        .map(id => String(id).trim())
        .filter(Boolean)
    if (!ids.length) throw new Error("Choose the operations to copy")
    const found = sources([...new Set(ids)], target.scope, targetId)
    const existing = routings()
        .ops(targetId)
        .filter(row => row.methodRemoved !== "Y")
    const replace = p.replaceExisting === true || p.replaceExisting === "Y"
    policy().audit([...routings().opFields, ...qualityFields, "methodSourceWorkEffortId", "methodChangeReason"], why)
    if (replace)
        for (const row of existing)
            call("update#" + W, {workEffortId: row.workEffortId, methodRemoved: "Y", methodDraft: "Y", methodChangeReason: why})
    let sequence = replace ? 0 : Math.max(0, ...existing.map(row => Number(row.sequenceNum || 0)))
    const copied = new Map()
    for (const source of found) {
        sequence += 10
        const data = Object.assign(pick(source, [...names, ...standards, ...qualityFields]), {
            parentWorkEffortId: targetId,
            ownerPartyId: target.scope.organizationPartyId,
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: "WepRoutingTask",
            isTemplate: "Y",
            methodDraft: "Y",
            methodRemoved: "N",
            sequenceNum: sequence,
            methodSourceWorkEffortId: source.workEffortId,
            methodChangeReason: why
        })
        if (!data.methodQuantityUomId) delete data.methodQuantityUomId
        const workEffortId = call("create#" + W, data).workEffortId
        copied.set(source.workEffortId, workEffortId)
        policy().recordAudit(W, {workEffortId}, names, {}, map(one(W, {workEffortId})), why)
        for (const [entity, keyField, fields] of [
            ["mantle.work.effort.WorkEffortAssetNeeded", "assetProductId", ["estimatedQuantity", "estimatedDuration"]],
            ["mantle.work.effort.WorkEffortSkillStandard", "skillTypeEnumId", ["estimatedNumPeople", "estimatedDuration"]]
        ])
            for (const row of rows(entity, {workEffortId: source.workEffortId})) {
                const key = {workEffortId, [keyField]: row[keyField]}
                policy().audit([...fields, "methodChangeReason"], why)
                call("create#" + entity, Object.assign({}, key, pick(map(row), fields)))
                policy().recordAudit(entity, key, fields, {}, map(one(entity, key)), why)
            }
    }
    // predecessors within the copied set follow the copies; others are left out
    for (const source of found) {
        const predecessors = String(source.methodPredecessorIds || "")
            .split(",")
            .filter(id => copied.has(id))
            .map(id => copied.get(id))
        if (predecessors.length)
            call("update#" + W, {
                workEffortId: copied.get(source.workEffortId),
                methodPredecessorIds: predecessors.sort().join(","),
                methodChangeReason: why
            })
    }
    call("update#" + W, {workEffortId: targetId, methodDraft: "Y", methodChangeReason: why})
    return Object.assign(routings().execute("detail", {workEffortId: targetId}), {
        copiedOperationIds: Array.from(copied.values())
    })
}

// The instruction rows' guard (Work.eecas.xml WorkEffortInstructionImmutable): the generic file screens and services write
// WorkEffortContent too, so a published instruction is kept on the entity. It is created once with its checksum, never
// removed, and an update may only end it (thruDate); its file, type, template and start never change.
function guardInstruction(p) {
    const original = p.originalValue ? map(p.originalValue) : null
    const candidate = Object.assign({}, original || {}, map(p.entityValue || {}))
    if (p.eecaOperation === "delete") throw new Error("A published instruction cannot be removed; publish the next one")
    if (p.eecaOperation === "create") {
        if (
            !candidate.contentChecksum ||
            !String(candidate.contentLocation || "").startsWith("dbresource://mantle/content/workEffort/") ||
            !candidate.fromDate
        )
            throw new Error("An instruction is published with store#OperationInstruction")
        return {}
    }
    for (const field of ["workEffortId", "contentTypeEnumId", "contentLocation", "contentChecksum", "fromDate"]) {
        const before = original?.[field],
            after = candidate[field]
        if (field === "fromDate" ? ms(before) !== ms(after) : String(before ?? "") !== String(after ?? ""))
            throw new Error("A published instruction's file and start cannot be changed; publish the next one")
    }
    if (original?.thruDate && ms(original.thruDate) !== ms(candidate.thruDate))
        throw new Error("A published instruction that has ended stays ended")
    return {}
}

const operations = {findTemplates, storeTemplate, storeInstruction, copyOperations, guardInstruction}
;({
    instructionAt,
    template,
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown operation template operation " + op)
        return operations[op](p)
    }
})
