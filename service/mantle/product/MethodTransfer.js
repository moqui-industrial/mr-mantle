// Method copies and imports (impl-manufacturing P2, design §11 and BillsOfMaterials): clone a BOM into a new method of
// the organization as draft lines, and import BOM and routing versions from CSV with a preview. A version is the rows of one
// method key (a BOM's product and method code, a routing's name); each imports in its own transaction, a bad one is named
// and skipped, pick kits are left out (D15), and nothing is released: release stays the approver's explicit decision.
// Every row passes the same checks as the editor (store#Bom, store#BomItem, store#Routing, store#RoutingOperation).
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const boms = () => ec.resource.script("component://mr-mantle/service/mantle/product/Boms.js")
const routings = () => ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js")
const csvLib = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js")
const B = "mantle.product.bom.ProductBom",
    W = "mantle.work.effort.WorkEffort"
const one = (n, p) => policy().one(n, p),
    rows = (n, p) => policy().rows(n, p),
    call = (n, p = {}) => policy().call(n, p),
    pick = (p, f) => policy().pick(p, f)

// clone#Bom: a new method (another method code of the product, or another product of the organization) whose header and
// draft lines copy the source as of a date: its released method then, else its draft.
function cloneBom(p) {
    const source = boms().getBom(p.productBomId)
    const why = policy().reason(p)
    const productId = p.productId || source.bom.productId,
        methodCode = String(p.methodCode || "").trim()
    if (!methodCode || methodCode.length > 60) throw new Error("Give the new method a code of 1–60 characters")
    if (rows(B, {productId, organizationPartyId: source.bom.organizationPartyId, methodCode}).length)
        throw new Error("Method " + methodCode + " of " + productId + " already exists")
    const date = p.asOfDate || ec.user.nowTimestamp
    const released = boms().latest(source.bom.productBomId, date)
    const header = released ? boms().headerAt(source.bom, date).header : source.bom
    const lines = released ? boms().items(source.bom.productBomId, date) : boms().drafts(source.bom.productBomId)
    const created = call(
        "mantle.product.BomServices.store#Bom",
        Object.assign(pick(header, boms().headerFields), {
            productId,
            organizationPartyId: source.bom.organizationPartyId,
            methodCode,
            bomName: p.bomName || header.bomName,
            changeReason: why
        })
    )
    const productBomId = created.productBom.productBomId
    for (const line of lines.filter(row => row.removeOnRelease !== "Y"))
        call(
            "mantle.product.BomServices.store#BomItem",
            Object.assign(pick(line, boms().lineFields), {productBomId, changeReason: why + " (from " + line.bomItemId + ")"})
        )
    return Object.assign(boms().detail({productBomId}), {sourceProductBomId: source.bom.productBomId})
}

// ===== CSV =====
const truthy = v => v === true || v === "Y" || v === "true"
const decimal = (value, name) => {
    if (value == null || value === "") return null
    const text = String(value).trim()
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new Error(name + " " + text + " is not a number")
    return toDecimal(text)
}
// The rows of the file as maps by header (case-insensitive, spaces ignored), with their line numbers.
function records(p, required) {
    const file = p.contentFile
    const text = file && file.size > 0 ? file.getString("UTF-8") : p.csvText
    const parsed = csvLib().parse(String(text || ""), p.delimiter || ",")
    const key = header => String(header).replace(/\s+/g, "").toLowerCase()
    const headers = parsed.headers.map(key)
    for (const name of required) if (!headers.includes(name.toLowerCase())) throw new Error("The file has no " + name + " column")
    return parsed.rows.map(source => {
        if (source.sourceError) throw new Error("Line " + source.rowNumber + ": " + source.sourceError)
        const row = {lineNumber: source.rowNumber}
        for (const [header, value] of Object.entries(source.sourceValues)) row[key(header)] = String(value ?? "").trim()
        return row
    })
}
function groupBy(list, key) {
    const groups = new Map()
    for (const row of list) {
        const k = key(row)
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(row)
    }
    return groups
}
// Each version: checked in the preview; with apply, imported in its own transaction by its import#…Version service, and its
// failure named. A probe call, so one version's error does not mark the others' rollback.
function importVersions(p, versions, service) {
    const apply = !truthy(p.preview)
    for (const version of versions) {
        if (version.status !== "ready" || !apply) continue
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name(service)
                    .parameters({version: version.data, changeReason: p.changeReason, organizationPartyId: p.organizationPartyId})
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            Object.assign(version, {status: "imported", recordId: out.recordId})
        } catch (error) {
            Object.assign(version, {status: "failed", messages: [...version.messages, String(error.message || error)]})
            ec.logger.error("Method import version " + version.versionKey + " failed: " + error)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    for (const version of versions) delete version.data
    return {
        versionRows: versions,
        preview: !apply,
        readyCount: versions.filter(v => v.status === "ready").length,
        importedCount: versions.filter(v => v.status === "imported").length,
        failedCount: versions.filter(v => v.status === "failed").length,
        skippedCount: versions.filter(v => v.status === "skipped").length
    }
}

// import#BomCsv: columns productId, componentProductId, quantity and optional methodCode (MAIN), bomName, baseQuantity,
// baseUomId, quantityUomId, scrapFactor, sequenceNum and role (Consume or Byproduct). A version is a product and method code.
function importBomCsv(p) {
    const scope = policy().scope(p, "edit")
    policy().reason(p)
    const list = records(p, ["productId", "componentProductId", "quantity"])
    const groups = groupBy(list, row => row.productid + "|" + (row.methodcode || "MAIN"))
    const versions = []
    for (const [versionKey, lines] of groups) {
        const version = {versionKey, productId: lines[0].productid, methodCode: lines[0].methodcode || "MAIN"}
        Object.assign(version, {lineCount: lines.length, messages: [], status: "ready"})
        versions.push(version)
        try {
            const product = policy().product(version.productId, scope)
            if (product.productTypeEnumId === "PtPickAssembly") {
                Object.assign(version, {status: "skipped", messages: ["A pick kit keeps its Kit components; left out"]})
                continue
            }
            const existing = rows(B, {productId: product.productId, organizationPartyId: scope.organizationPartyId}).find(
                row => row.methodCode === version.methodCode
            )
            version.productBomId = existing?.productBomId || null
            const header = {
                bomName: lines[0].bomname || null,
                baseQuantity: decimal(lines[0].basequantity, "Base quantity"),
                quantityUomId: lines[0].baseuomid || null
            }
            // a new method needs its base unit: the file's, else the product's
            if (!existing) {
                if (!header.quantityUomId && !product.amountUomId) throw new Error("Give the method's base unit (baseUomId)")
                policy().unit(header.quantityUomId || product.amountUomId)
            }
            const items = []
            for (const line of lines)
                try {
                    const role = (line.role || "Consume").toLowerCase()
                    const component = policy().product(line.componentproductid, scope)
                    const data = {
                        productId: component.productId,
                        roleEnumId:
                            role === "byproduct" || role === "by-product"
                                ? "BmirByproduct"
                                : role === "consume"
                                  ? "BmirConsume"
                                  : line.role,
                        quantity: decimal(line.quantity, "Quantity"),
                        quantityUomId: line.quantityuomid || component.amountUomId,
                        scrapFactor: decimal(line.scrapfactor, "Scrap factor") ?? 0,
                        sequenceNum: line.sequencenum ? Number(line.sequencenum) : 10
                    }
                    boms().validateLine(Object.assign({}, data), {
                        scope,
                        bom: {productId: product.productId, organizationPartyId: scope.organizationPartyId}
                    })
                    items.push(data)
                } catch (error) {
                    version.messages.push("Line " + line.lineNumber + ": " + String(error.message || error))
                }
            if (version.messages.length) version.status = "failed"
            version.data = {
                productId: product.productId,
                methodCode: version.methodCode,
                productBomId: version.productBomId,
                header,
                items
            }
        } catch (error) {
            Object.assign(version, {status: "failed", messages: [...version.messages, String(error.message || error)]})
        }
    }
    return importVersions(p, versions, "mantle.product.BomServices.import#BomVersion")
}
// import#BomVersion: one checked version, in the transaction its caller gives it: the method when it is new, then its lines
// as drafts.
function importBomVersion(p) {
    const why = policy().reason(p),
        v = p.version
    let productBomId = v.productBomId
    if (!productBomId)
        productBomId = call(
            "mantle.product.BomServices.store#Bom",
            Object.assign(Object.fromEntries(Object.entries(v.header).filter(([, value]) => value != null)), {
                productId: v.productId,
                organizationPartyId: p.organizationPartyId,
                methodCode: v.methodCode,
                changeReason: why
            })
        ).productBom.productBomId
    for (const item of v.items)
        call("mantle.product.BomServices.store#BomItem", Object.assign({}, item, {productBomId, changeReason: why}))
    return {recordId: productBomId}
}

// import#RoutingCsv: columns routingName, operationName and optional sequenceNum, setupTime, runTime, machineSetupTime,
// machineRunTime, timeUomId (TF_hr), batchQuantity (1), quantityUomId and workCenterId. A version is a routing by its name: a
// routing of the organization with that name takes the operations as drafts, else a new routing is made.
function importRoutingCsv(p) {
    const scope = policy().scope(p, "edit")
    policy().reason(p)
    const list = records(p, ["routingName", "operationName", "quantityUomId"])
    const versions = []
    for (const [versionKey, lines] of groupBy(list, row => row.routingname)) {
        const version = {versionKey, routingName: versionKey, lineCount: lines.length, messages: [], status: "ready"}
        versions.push(version)
        try {
            if (!versionKey) throw new Error("A routing name is required")
            const existing = rows(W, {
                ownerPartyId: scope.organizationPartyId,
                purposeEnumId: "WepRouting",
                workEffortName: versionKey
            })
            if (existing.length > 1) throw new Error("Several routings are named " + versionKey)
            version.workEffortId = existing[0]?.workEffortId || null
            const operations = []
            lines.forEach((line, index) => {
                try {
                    const data = {
                        workEffortName: line.operationname,
                        sequenceNum: line.sequencenum ? Number(line.sequencenum) : (index + 1) * 10,
                        estimatedSetupTime: decimal(line.setuptime, "Setup time") ?? 0,
                        estimatedWorkTime: decimal(line.runtime, "Run time") ?? 0,
                        methodMachineSetupTime: decimal(line.machinesetuptime, "Machine setup time") ?? 0,
                        methodMachineRunTime: decimal(line.machineruntime, "Machine run time") ?? 0,
                        timeUomId: line.timeuomid || "TF_hr",
                        methodBatchQuantity: decimal(line.batchquantity, "Batch quantity") ?? 1,
                        methodQuantityUomId: line.quantityuomid,
                        methodWorkCenterId: line.workcenterid || null
                    }
                    routings().validateOperation(Object.assign({}, data), {scope})
                    operations.push(data)
                } catch (error) {
                    version.messages.push("Line " + line.lineNumber + ": " + String(error.message || error))
                }
            })
            if (version.messages.length) version.status = "failed"
            version.data = {routingName: versionKey, workEffortId: version.workEffortId, operations}
        } catch (error) {
            Object.assign(version, {status: "failed", messages: [...version.messages, String(error.message || error)]})
        }
    }
    return importVersions(p, versions, "mantle.work.RoutingServices.import#RoutingVersion")
}
function importRoutingVersion(p) {
    const why = policy().reason(p),
        v = p.version
    let workEffortId = v.workEffortId
    if (!workEffortId)
        workEffortId = call("mantle.work.RoutingServices.store#Routing", {
            workEffortName: v.routingName,
            organizationPartyId: p.organizationPartyId,
            changeReason: why
        }).routing.workEffortId
    for (const operation of v.operations) {
        const out = call(
            "mantle.work.RoutingServices.store#RoutingOperation",
            Object.assign({}, operation, {workEffortId, changeReason: why})
        )
        if (!out.operationWorkEffortId) throw new Error("Operation " + operation.workEffortName + " was not stored")
    }
    return {recordId: workEffortId}
}

const operations = {cloneBom, importBomCsv, importBomVersion, importRoutingCsv, importRoutingVersion}
;({
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown method transfer operation " + op)
        return operations[op](p)
    }
})
