// Dated Manufacturing BOMs. A released line is immutable except for its end; replacements retain lineage.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const B = "mantle.product.bom.ProductBom",
    L = "mantle.product.bom.ProductBomItem",
    D = "mantle.work.method.MethodReleaseDecision",
    DI = "mantle.work.method.MethodReleaseItem"
const find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    rows = (n, p) => policy().rows(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    active = (r, d) => policy().active(r, d),
    pick = (p, f) => policy().pick(p, f)
const headerFields = [
        "bomName",
        "baseQuantity",
        "quantityUomId",
        "isPhantom",
        "routingWorkEffortId",
        "leadTimeDays",
        "prepareDays"
    ],
    lineFields = [
        "productId",
        "componentProductBomId",
        "roleEnumId",
        "quantity",
        "quantityUomId",
        "scrapFactor",
        "operationWorkEffortId",
        "sequenceNum",
        "applicabilityFeatureIds",
        "instruction",
        "substitutionRuleEnumId",
        "allocationShare"
    ]
function getBom(id, need = "read") {
    const row = one(B, {productBomId: id})
    if (!row) throw new Error("BOM is not available")
    const s = policy().scope({organizationPartyId: row.organizationPartyId}, need),
        product = policy().product(row.productId, s)
    if (product.productTypeEnumId === "PtPickAssembly")
        throw new Error("Pick kits use Kit components and are never manufacturing BOMs")
    return {bom: map(row), scope: s, product: map(product)}
}
function decisions(id) {
    return rows(D, {methodEntityName: B, methodId: id}).sort((a, b) => ms(b.fromDate) - ms(a.fromDate))
}
function latest(id, date) {
    return decisions(id).find(r => ms(r.fromDate) <= ms(date)) || null
}
function headerAt(bom, date) {
    const release = latest(bom.productBomId, date)
    if (!release) throw new Error("BOM " + bom.productBomId + " has no released method at this date")
    const refs = JSON.parse(release.auditRefsJson || "{}")
    return {
        header: Object.assign(
            {},
            pick(bom, ["productBomId", "productId", "organizationPartyId", "methodCode"]),
            policy().atAudit(B, bom.productBomId, headerFields, refs.header)
        ),
        release: map(release)
    }
}
function items(id, date) {
    return rows(L, {productBomId: id, state: "released"})
        .filter(r => active(r, date))
        .sort(
            (a, b) =>
                Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0) || String(a.bomItemId).localeCompare(String(b.bomItemId))
        )
        .map(map)
}
function drafts(id) {
    return rows(L, {productBomId: id, state: "draft"})
        .sort((a, b) => String(a.bomItemId).localeCompare(String(b.bomItemId)))
        .map(map)
}
function revision(bom) {
    return policy().fingerprint({
        header: pick(bom, [
            "productBomId",
            "productId",
            "organizationPartyId",
            "methodCode",
            ...headerFields,
            "lastUpdatedStamp",
            "legacyImportComplete",
            "legacyImportIssuesJson"
        ]),
        drafts: drafts(bom.productBomId),
        releases: decisions(bom.productBomId).map(r => ({id: r.methodReleaseDecisionId, fromDate: r.fromDate}))
    })
}
function checkRevision(bom, expected) {
    if (expected && expected !== revision(bom)) throw new Error("BOM draft changed; reload and review before saving or releasing")
}
function detail(p) {
    const g = getBom(p.productBomId),
        date = p.asOfDate || ec.user.nowTimestamp,
        release = latest(g.bom.productBomId, date)
    return {
        productBom: map(g.bom),
        product: g.product,
        expectedRevision: revision(g.bom),
        bomItemRows: items(g.bom.productBomId, date),
        draftItemRows: drafts(g.bom.productBomId),
        releaseHistory: decisions(g.bom.productBomId).map(r =>
            pick(map(r), ["methodReleaseDecisionId", "fromDate", "approvedDate", "approvedByUserId", "changeReason"])
        ),
        approvedHeader: release ? headerAt(g.bom, date).header : null,
        asOfDate: date,
        methodAccess: g.scope
    }
}
function list(p) {
    const s = policy().scope(p),
        out = []
    const conditions = {organizationPartyId: s.organizationPartyId}
    if (p.productId) conditions.productId = p.productId
    let query = find(B, conditions)
    // Manufacturing's BillsOfMaterials list (P2): its text search, by product, name and method code ignoring case
    const text = String(p.text || "").trim()
    if (text) {
        const factory = ec.entity.conditionFactory,
            pattern = "%" + text.replace(/[\\%_]/g, character => "\\" + character) + "%"
        query = query.condition(
            factory.makeCondition(
                ["productBomId", "productId", "bomName", "methodCode"].map(field =>
                    factory.makeCondition(field, "like", pattern).ignoreCase()
                ),
                "or"
            )
        )
    }
    for (const row of Array.from(query.orderBy("productId").orderBy("methodCode").list())) {
        // pick kits are never manufacturing methods (D15): left out of the list
        if (one("mantle.product.Product", {productId: row.productId})?.productTypeEnumId === "PtPickAssembly") continue
        try {
            const g = getBom(row.productBomId),
                date = p.asOfDate || ec.user.nowTimestamp,
                r = latest(row.productBomId, date)
            out.push(
                Object.assign({}, g.bom, {
                    productName: g.product.productName,
                    draftCount: drafts(row.productBomId).length,
                    lastReleaseDate: r?.fromDate || null
                })
            )
        } catch (e) {
            ec.logger.error("BOM " + row.productBomId + " omitted: " + e)
        }
    }
    return {bomRows: out, organizationPartyId: s.organizationPartyId}
}
function storeBom(p) {
    const existing = p.productBomId ? getBom(p.productBomId, "edit") : null,
        s = existing?.scope || policy().scope(p, "edit"),
        product = existing?.product || map(policy().product(p.productId, s)),
        why = policy().reason(p)
    if (product.productTypeEnumId === "PtPickAssembly")
        throw new Error("Pick kits use Kit components and are never manufacturing BOMs")
    if (existing) {
        existing.bom = map(find(B, {productBomId: p.productBomId}).forUpdate(true).one())
        checkRevision(existing.bom, p.expectedRevision)
        if (
            (p.productId && p.productId !== existing.bom.productId) ||
            (p.organizationPartyId && p.organizationPartyId !== existing.bom.organizationPartyId) ||
            (p.methodCode && p.methodCode !== existing.bom.methodCode)
        )
            throw new Error("The product, organization and method key are fixed")
    }
    const data = Object.assign(
        {
            bomName: product.productName,
            baseQuantity: 1,
            quantityUomId: product.amountUomId,
            isPhantom: "N",
            leadTimeDays: 0,
            prepareDays: 0
        },
        existing?.bom || {},
        pick(p, headerFields)
    )
    if (toDecimal(data.baseQuantity).compare(0) <= 0) throw new Error("BOM base quantity must be positive")
    policy().unit(data.quantityUomId)
    if (!["Y", "N"].includes(data.isPhantom)) throw new Error("Choose Yes or No for phantom")
    for (const field of ["leadTimeDays", "prepareDays"])
        if (data[field] != null && toDecimal(data[field]).compare(0) < 0) throw new Error(field + " cannot be negative")
    if (data.routingWorkEffortId) {
        const route = one("mantle.work.effort.WorkEffort", {workEffortId: data.routingWorkEffortId})
        if (!route || route.purposeEnumId !== "WepRouting" || route.ownerPartyId !== s.organizationPartyId)
            throw new Error("Routing is not in this method organization")
    }
    const saved = Object.assign(pick(data, headerFields), {
        productBomId: p.productBomId,
        productId: product.productId,
        organizationPartyId: s.organizationPartyId,
        methodCode: existing?.bom.methodCode || p.methodCode || "MAIN",
        changeReason: why
    })
    if (p.acknowledgeImportIssues === true || p.acknowledgeImportIssues === "Y") saved.legacyImportComplete = "Y"
    policy().audit([...headerFields, "legacyImportComplete", "changeReason"], why)
    const result = call((existing ? "update#" : "create#") + B, saved)
    return detail({productBomId: p.productBomId || result.productBomId})
}
function rootLine(row) {
    const seen = new Set()
    let current = row
    while (current?.replacesBomItemId) {
        if (seen.has(current.bomItemId)) throw new Error("BOM replacement lineage contains a cycle")
        seen.add(current.bomItemId)
        const parent = one(L, {bomItemId: current.replacesBomItemId})
        if (!parent || parent.productBomId !== row.productBomId) throw new Error("BOM replacement lineage is unavailable")
        current = parent
    }
    return current.bomItemId
}
function validateLine(data, g, date = ec.user.nowTimestamp) {
    const product = policy().product(data.productId, g.scope)
    policy().unit(data.quantityUomId)
    if (!["BmirConsume", "BmirByproduct"].includes(data.roleEnumId)) throw new Error("Choose a consume or by-product role")
    if (data.roleEnumId === "BmirConsume" && data.productId === g.bom.productId)
        throw new Error("A product cannot consume itself")
    if (data.quantity == null || toDecimal(data.quantity).compare(0) <= 0) throw new Error("BOM line quantity must be positive")
    if (data.scrapFactor != null && (toDecimal(data.scrapFactor).compare(0) < 0 || toDecimal(data.scrapFactor).compare(1) > 0))
        throw new Error("Scrap factor must be between zero and one")
    if (
        data.allocationShare != null &&
        (data.roleEnumId !== "BmirByproduct" ||
            toDecimal(data.allocationShare).compare(0) < 0 ||
            toDecimal(data.allocationShare).compare(1) > 0)
    )
        throw new Error("Allocation shares apply to by-products and must be between zero and one")
    if (data.substitutionRuleEnumId && !["BsrNone", "BsrEquivalent"].includes(data.substitutionRuleEnumId))
        throw new Error("Choose a valid substitution rule")
    const features = [
        ...new Set(
            String(data.applicabilityFeatureIds || "")
                .split(",")
                .map(v => v.trim())
                .filter(Boolean)
        )
    ].sort()
    if (features.length > 32) throw new Error("A BOM line supports at most 32 applicability features")
    for (const id of features) {
        const f = one("mantle.product.feature.ProductFeature", {productFeatureId: id})
        if (!f || (!g.scope.systemAdmin && !g.scope.ownerPartyIds.includes(f.ownerPartyId || "_NA_")))
            throw new Error("Applicability feature is not available")
    }
    data.applicabilityFeatureIds = features.join(",")
    if (product.amountUomId) policy().convert(data.quantity, data.quantityUomId, product.amountUomId, date)
    if (data.componentProductBomId) {
        const child = getBom(data.componentProductBomId)
        if (child.bom.organizationPartyId !== g.bom.organizationPartyId || child.bom.productId !== data.productId)
            throw new Error("The chosen component BOM is not for this component and organization")
    }
}
function storeItem(p) {
    const old = p.bomItemId ? one(L, {bomItemId: p.bomItemId}) : null,
        productBomId = old?.productBomId || p.productBomId,
        g = getBom(productBomId, "edit"),
        why = policy().reason(p)
    if ((p.bomItemId && !old) || (p.productBomId && p.productBomId !== productBomId)) throw new Error("BOM line is not available")
    g.bom = map(find(B, {productBomId}).forUpdate(true).one())
    checkRevision(g.bom, p.expectedRevision)
    let target = old?.state === "draft" ? old : null,
        source = old?.state === "released" ? old : old?.replacesBomItemId ? one(L, {bomItemId: old.replacesBomItemId}) : null
    if (old && old.state !== "draft" && old.state !== "released") throw new Error("This proposal is no longer editable")
    if (source && source.thruDate) throw new Error("Stage the latest released line in this lineage")
    if (source && !target)
        target = rows(L, {productBomId, state: "draft"}).find(r => r.replacesBomItemId === source.bomItemId) || null
    const data = Object.assign(
        {roleEnumId: "BmirConsume", quantity: 1, scrapFactor: 0, sequenceNum: 10, substitutionRuleEnumId: "BsrNone"},
        source ? pick(map(source), lineFields) : {},
        target ? pick(map(target), lineFields) : {},
        pick(p, lineFields)
    )
    if (!data.quantityUomId && data.productId) data.quantityUomId = policy().product(data.productId, g.scope).amountUomId
    validateLine(data, g)
    const bomItemId = target?.bomItemId || "bmi-" + ec.user.randomString(24),
        remove = p.removeOnRelease === "Y" || p.removeOnRelease === true
    const save = Object.assign(data, {
        bomItemId,
        productBomId,
        replacesBomItemId: source?.bomItemId || null,
        state: remove && !source ? "withdrawn" : "draft",
        removeOnRelease: remove ? "Y" : "N",
        changeReason: why
    })
    if (p.legacyAssocKey) save.legacyAssocKey = p.legacyAssocKey
    policy().audit([...lineFields, "state", "removeOnRelease", "changeReason"], why)
    call((target ? "update#" : "create#") + L, save)
    return Object.assign(detail({productBomId}), {bomItemId})
}
function projected(bom, date) {
    const result = items(bom.productBomId, date),
        pending = drafts(bom.productBomId)
    for (const row of pending) {
        const root = rootLine(row)
        for (let i = result.length - 1; i >= 0; i--) if (rootLine(result[i]) === root) result.splice(i, 1)
        if (row.removeOnRelease !== "Y") result.push(row)
    }
    return result
}
function choose(productId, organizationPartyId, date, explicit) {
    if (explicit) {
        const g = getBom(explicit)
        if (g.bom.organizationPartyId !== organizationPartyId || g.bom.productId !== productId)
            throw new Error("Component BOM does not match its product and organization")
        return headerAt(g.bom, date)
    }
    const candidates = rows(B, {productId, organizationPartyId}).filter(r => latest(r.productBomId, date)),
        main = candidates.filter(r => r.methodCode === "MAIN"),
        chosen = main.length === 1 ? main[0] : candidates.length === 1 ? candidates[0] : null
    if (!chosen) {
        if (candidates.length) throw new Error("Several released methods apply to " + productId + "; choose one explicitly")
        if (rows(B, {productId, organizationPartyId}).length)
            throw new Error("Component " + productId + " has no released BOM at this date")
        return null
    }
    return headerAt(map(chosen), date)
}

function validate(p) {
    const g = getBom(p.productBomId),
        date = p.fromDate || p.asOfDate || ec.user.nowTimestamp,
        findings = [],
        pending = drafts(g.bom.productBomId),
        lines = projected(g.bom, date)
    const add = (id, e) => findings.push({recordId: id, message: String(e.message || e)})
    if (g.bom.legacyImportComplete === "N")
        add(g.bom.productBomId, "Review and acknowledge the named legacy import issues before release")
    if (!lines.some(r => r.roleEnumId === "BmirConsume"))
        add(g.bom.productBomId, "A method needs at least one consumed component")
    // a release at this date would overlap the effective window of one already approved to start then or later
    const later = decisions(g.bom.productBomId).find(r => ms(r.fromDate) >= ms(date))
    if (later && pending.length)
        add(
            g.bom.productBomId,
            "Overlapping effective window: approval " + later.methodReleaseDecisionId + " already starts on or after this date"
        )
    try {
        policy().convert(g.bom.baseQuantity, g.bom.quantityUomId, g.product.amountUomId || g.bom.quantityUomId, date)
    } catch (e) {
        add(g.bom.productBomId, e)
    }
    let operationIds = []
    if (g.bom.routingWorkEffortId)
        try {
            const r = ec.resource
                .script("component://mr-mantle/service/mantle/work/Routings.js")
                .released(g.bom.routingWorkEffortId, date)
            operationIds = r.operations.map(o => o.workEffortId)
            for (const op of r.operations) policy().convert(g.bom.baseQuantity, g.bom.quantityUomId, op.quantityUomId, date)
        } catch (e) {
            add(g.bom.routingWorkEffortId, e)
        }
    let allocated = toDecimal(0)
    const roots = new Set()
    for (const row of lines)
        try {
            validateLine(row, g, date)
            const root = rootLine(row)
            if (roots.has(root)) throw new Error("Overlapping effective lines in replacement lineage")
            roots.add(root)
            if (row.operationWorkEffortId && !operationIds.includes(row.operationWorkEffortId))
                throw new Error("Consuming operation is not released in the selected routing at this date")
            if (row.allocationShare != null) allocated = allocated.add(row.allocationShare)
        } catch (e) {
            add(row.bomItemId, e)
        }
    if (allocated.compare(1) > 0) add(g.bom.productBomId, "By-product allocation shares exceed one")
    // Test every known future boundary too: a scheduled component change must not introduce a cycle later.
    const dates = [
        ms(date),
        ...rows(D)
            .filter(r => r.methodEntityName === B && ms(r.fromDate) > ms(date))
            .map(r => ms(r.fromDate))
    ]
    for (const boundary of [...new Set(dates)]) {
        function visit(bom, path) {
            if (path.includes(bom.productBomId)) throw new Error("BOM cycle: " + [...path, bom.productBomId].join(" → "))
            if (path.length >= 64) throw new Error("BOM depth exceeds 64")
            const header = bom.productBomId === g.bom.productBomId ? bom : headerAt(bom, boundary).header,
                selected = bom.productBomId === g.bom.productBomId ? projected(bom, boundary) : items(bom.productBomId, boundary)
            for (const r of selected.filter(r => r.roleEnumId === "BmirConsume")) {
                const child = choose(r.productId, bom.organizationPartyId, boundary, r.componentProductBomId)
                if (child)
                    visit(Object.assign({}, child.header, {organizationPartyId: bom.organizationPartyId}), [
                        ...path,
                        bom.productBomId
                    ])
            }
        }
        try {
            visit(g.bom, [])
        } catch (e) {
            add(g.bom.productBomId, e)
        }
    }
    return {
        valid: findings.length === 0,
        findings,
        expectedRevision: revision(g.bom),
        draftItemRows: pending,
        projectedItemRows: lines,
        fromDate: date
    }
}
function release(p) {
    const g = getBom(p.productBomId, "approve"),
        why = policy().reason(p),
        now = ec.user.nowTimestamp,
        date = p.fromDate || now
    g.bom = map(find(B, {productBomId: g.bom.productBomId}).forUpdate(true).one())
    if (!p.expectedRevision) throw new Error("Review the draft and provide its expected revision before release")
    checkRevision(g.bom, p.expectedRevision)
    if (ms(date) < ms(now)) throw new Error("A method release must start now or later")
    if (decisions(g.bom.productBomId).some(r => ms(r.fromDate) >= ms(date)))
        throw new Error("Release must follow the latest scheduled approval")
    const checked = validate(Object.assign({}, p, {fromDate: date}))
    if (!checked.valid)
        throw new Error("BOM release refused: " + checked.findings.map(r => r.recordId + ": " + r.message).join("; "))
    const decisionId = "mrd-" + ec.user.randomString(24),
        stamped = [],
        pending = drafts(g.bom.productBomId)
    policy().audit(["state", "fromDate", "thruDate", "changeReason"], why)
    for (const row of pending) {
        if (row.replacesBomItemId) {
            const source = one(L, {bomItemId: row.replacesBomItemId})
            if (!source || source.thruDate || ms(source.fromDate) >= ms(date))
                throw new Error("Replacement source changed; review the latest released line")
            call("update#" + L, {bomItemId: source.bomItemId, thruDate: iso(date), changeReason: why})
            stamped.push({lineId: source.bomItemId, action: "end", previousFromDate: source.fromDate})
        }
        call("update#" + L, {
            bomItemId: row.bomItemId,
            state: row.removeOnRelease === "Y" ? "withdrawn" : "released",
            fromDate: row.removeOnRelease === "Y" ? null : iso(date),
            changeReason: why
        })
        stamped.push({lineId: row.bomItemId, action: row.removeOnRelease === "Y" ? "withdraw" : "start"})
    }
    call("create#" + D, {
        methodReleaseDecisionId: decisionId,
        methodEntityName: B,
        methodId: g.bom.productBomId,
        fromDate: iso(date),
        approvedDate: now,
        approvedByUserId: ec.user.userId,
        changeReason: why,
        inputFingerprint: p.expectedRevision,
        auditRefsJson: JSON.stringify({header: policy().capture(B, g.bom.productBomId, headerFields)})
    })
    for (let i = 0; i < stamped.length; i++)
        call(
            "create#" + DI,
            Object.assign(
                {methodReleaseDecisionId: decisionId, itemSeqId: i + 1, lineEntityName: L, fromDate: iso(date)},
                stamped[i]
            )
        )
    // the release decides what was asked for: its approvers' BomRelease notices are read (MethodReleases.js)
    ec.resource.script("component://mr-mantle/service/mantle/product/MethodReleases.js").clear(B, g.bom.productBomId)
    return Object.assign(detail({productBomId: g.bom.productBomId, asOfDate: date}), {
        methodReleaseDecisionId: decisionId,
        stampedLines: stamped,
        findings: [],
        valid: true
    })
}
function applicable(row, features) {
    return (
        !row.applicabilityFeatureIds ||
        String(row.applicabilityFeatureIds)
            .split(",")
            .every(f => features.has(f))
    )
}
function explode(p) {
    const g = getBom(p.productBomId),
        date = p.asOfDate || ec.user.nowTimestamp,
        quantity = toDecimal(p.quantity ?? 1),
        out = [],
        findings = [],
        features = new Set(
            Array.isArray(p.productFeatureIds)
                ? p.productFeatureIds
                : String(p.productFeatureIds || "")
                      .split(",")
                      .filter(Boolean)
        ),
        requirements = {}
    if (quantity.compare(0) <= 0) throw new Error("Explosion quantity must be positive")
    if (p.facilityId) policy().facility(p.facilityId, g.scope)
    const top = headerAt(g.bom, date),
        entered = policy().convert(quantity, p.quantityUomId || top.header.quantityUomId, top.header.quantityUomId, date)
    function walk(header, qty, path, ids, planning = true) {
        if (ids.includes(header.productBomId)) throw new Error("BOM cycle: " + [...ids, header.productBomId].join(" → "))
        if (ids.length >= 64) throw new Error("BOM depth exceeds 64")
        const base = toDecimal(header.baseQuantity)
        if (base.compare(0) <= 0) throw new Error("BOM base quantity is invalid")
        for (const row of items(header.productBomId, date)) {
            if (out.length >= 10000) throw new Error("Explosion exceeds 10000 lines")
            const occurrence = [...path, row.bomItemId],
                node = Object.assign(pick(row, lineFields), {
                    bomItemId: row.bomItemId,
                    productBomId: header.productBomId,
                    path: occurrence.join("/"),
                    parentPath: path.join("/"),
                    depth: ids.length + 1,
                    fromDate: row.fromDate,
                    asOfDate: date,
                    applicable: applicable(row, features)
                })
            out.push(node)
            if (!node.applicable) continue
            try {
                const product = policy().product(row.productId, g.scope),
                    net = qty.divide(base).multiply(row.quantity),
                    gross = net.multiply(toDecimal(1).add(row.scrapFactor || 0)),
                    converted = policy().convert(gross, row.quantityUomId, product.amountUomId || row.quantityUomId, date)
                Object.assign(node, {
                    productName: product.productName,
                    netQuantity: String(net),
                    grossQuantity: String(gross),
                    inventoryQuantity: String(converted.quantity),
                    inventoryUomId: product.amountUomId || row.quantityUomId,
                    conversionFactor: String(converted.factor),
                    uomConversionId: converted.uomConversionId,
                    complete: true
                })
                if (row.roleEnumId === "BmirByproduct") continue
                const child = choose(row.productId, g.bom.organizationPartyId, date, row.componentProductBomId)
                const boundary = planning && (!child || (child.header.isPhantom !== "Y" && !p.fullBlowThrough))
                node.requiredForProduction = boundary
                node.planningBoundary = !!child && boundary
                if (boundary) {
                    const key = row.productId + "|" + node.inventoryUomId
                    requirements[key] = Object.assign(
                        requirements[key] || {
                            productId: row.productId,
                            quantity: toDecimal(0),
                            quantityUomId: node.inventoryUomId
                        },
                        {quantity: (requirements[key]?.quantity || toDecimal(0)).add(converted.quantity)}
                    )
                }
                if (child) {
                    const childQty = policy().convert(gross, row.quantityUomId, child.header.quantityUomId, date)
                    Object.assign(node, {
                        componentProductBomId: child.header.productBomId,
                        componentReleaseDecisionId: child.release.methodReleaseDecisionId,
                        isPhantom: child.header.isPhantom
                    })
                    walk(child.header, childQty.quantity, occurrence, [...ids, header.productBomId], planning && !boundary)
                } else node.leaf = true
            } catch (e) {
                node.complete = false
                findings.push({recordId: row.bomItemId, path: node.path, message: String(e.message || e)})
                ec.logger.error("BOM explosion line " + row.bomItemId + ": " + e)
            }
        }
    }
    try {
        walk(top.header, entered.quantity, [], [])
    } catch (e) {
        findings.push({recordId: g.bom.productBomId, message: String(e.message || e)})
    }
    let buildableQuantity = null
    if (p.facilityId && findings.length === 0) {
        for (const r of Object.values(requirements))
            try {
                const inv = call("mantle.product.AssetServices.get#AvailableInventory", {
                        productId: r.productId,
                        facilityId: p.facilityId,
                        ownerPartyIdList: [g.bom.organizationPartyId]
                    }),
                    need = r.quantity.divide(quantity)
                if (need.compare(0) > 0) {
                    const possible = toDecimal(inv.availableToPromiseTotal || 0).divide(need)
                    buildableQuantity =
                        buildableQuantity == null || possible.compare(buildableQuantity) < 0 ? possible : buildableQuantity
                }
            } catch (e) {
                findings.push({recordId: r.productId, message: "Availability unavailable: " + String(e.message || e)})
            }
    }
    return {
        productBom: top.header,
        releaseDecisionId: top.release.methodReleaseDecisionId,
        asOfDate: date,
        quantity: String(quantity),
        quantityUomId: p.quantityUomId || top.header.quantityUomId,
        explosionRows: out,
        requirements: Object.values(requirements).map(r => Object.assign({}, r, {quantity: String(r.quantity)})),
        findings,
        complete: findings.length === 0,
        buildableQuantity: findings.length ? null : buildableQuantity == null ? null : String(buildableQuantity)
    }
}
function compareDates(p) {
    const g = getBom(p.productBomId),
        leftDate = p.leftDate,
        rightDate = p.rightDate
    if (!leftDate || !rightDate) throw new Error("Choose both comparison dates")
    const left = headerAt(g.bom, leftDate),
        right = headerAt(g.bom, rightDate),
        leftRows = items(g.bom.productBomId, leftDate),
        rightRows = items(g.bom.productBomId, rightDate),
        a = Object.fromEntries(leftRows.map(r => [rootLine(r), r])),
        b = Object.fromEntries(rightRows.map(r => [rootLine(r), r])),
        changes = []
    for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
        const fields = lineFields.filter(f => String(a[id]?.[f] ?? "") !== String(b[id]?.[f] ?? ""))
        if (fields.length)
            changes.push({
                lineageId: id,
                changeType: !a[id] ? "Added" : !b[id] ? "Removed" : "Changed",
                fields: fields.join(", "),
                left: a[id] || null,
                right: b[id] || null
            })
    }
    const headerChanges = headerFields
        .filter(f => String(left.header[f] ?? "") !== String(right.header[f] ?? ""))
        .map(field => ({field, left: left.header[field], right: right.header[field]}))
    const routing = ec.resource.script("component://mr-mantle/service/mantle/work/Routings.js"),
        operationChanges = []
    let leftOps = [],
        rightOps = []
    if (left.header.routingWorkEffortId) leftOps = routing.released(left.header.routingWorkEffortId, leftDate).operations
    if (right.header.routingWorkEffortId) rightOps = routing.released(right.header.routingWorkEffortId, rightDate).operations
    const x = Object.fromEntries(leftOps.map(r => [r.workEffortId, r])),
        y = Object.fromEntries(rightOps.map(r => [r.workEffortId, r]))
    for (const id of new Set([...Object.keys(x), ...Object.keys(y)]))
        if (JSON.stringify(x[id]) !== JSON.stringify(y[id]))
            operationChanges.push({workEffortId: id, left: x[id] || null, right: y[id] || null})
    return {
        productBom: g.bom,
        leftDate,
        rightDate,
        comparisonRows: changes,
        headerChanges,
        operationChanges,
        complete: true,
        findings: []
    }
}
function whereUsed(p) {
    const s = policy().scope(p),
        product = policy().product(p.productId, s),
        date = p.asOfDate || ec.user.nowTimestamp,
        out = [],
        findings = []
    function visit(id, path, products) {
        if (products.includes(id) || products.length >= 64) return
        for (const bom of rows(B, {organizationPartyId: s.organizationPartyId}))
            try {
                getBom(bom.productBomId)
                if (!latest(bom.productBomId, date)) continue
                for (const line of items(bom.productBomId, date).filter(r => r.productId === id)) {
                    const full = [...path, line.bomItemId]
                    out.push({
                        path: full.join("/"),
                        parentPath: path.join("/"),
                        depth: products.length + 1,
                        productBomId: bom.productBomId,
                        productId: bom.productId,
                        componentProductId: id,
                        bomItemId: line.bomItemId,
                        quantity: line.quantity,
                        quantityUomId: line.quantityUomId,
                        kind: "Manufacturing method",
                        readOnly: false,
                        fromDate: line.fromDate,
                        thruDate: line.thruDate
                    })
                    if (p.transitive !== false) visit(bom.productId, full, [...products, id])
                }
            } catch (e) {
                findings.push({recordId: bom.productBomId, message: String(e.message || e)})
                ec.logger.error("Where-used BOM " + bom.productBomId + ": " + e)
            }
        for (const assoc of rows("mantle.product.ProductAssoc", {toProductId: id, productAssocTypeEnumId: "PatMfgBom"}).filter(
            r => active(r, date)
        ))
            try {
                const parent = policy().product(assoc.productId, s)
                if (parent.productTypeEnumId !== "PtPickAssembly") continue
                const full = [...path, "kit:" + parent.productId + ":" + id]
                out.push({
                    path: full.join("/"),
                    parentPath: path.join("/"),
                    depth: products.length + 1,
                    productId: parent.productId,
                    componentProductId: id,
                    quantity: assoc.quantity,
                    kind: "Kit components",
                    readOnly: true,
                    fromDate: assoc.fromDate,
                    thruDate: assoc.thruDate
                })
                if (p.transitive !== false) visit(parent.productId, full, [...products, id])
            } catch (e) {
                ec.logger.error("Where-used kit " + assoc.productId + " omitted: " + e)
            }
    }
    visit(product.productId, [], [])
    return {product: map(product), whereUsedRows: out, asOfDate: date, complete: findings.length === 0, findings}
}
function importLegacy(p) {
    const s = policy().scope(p, "edit"),
        product = policy().product(p.productId, s)
    if (product.productTypeEnumId === "PtPickAssembly")
        return {skipped: true, findings: [{recordId: product.productId, message: "Kits retain their dated Kit components"}]}
    const date = p.asOfDate || ec.user.nowTimestamp,
        why = policy().reason(p),
        existing = rows(B, {
            productId: p.productId,
            organizationPartyId: s.organizationPartyId,
            methodCode: p.methodCode || "MAIN"
        })[0]
    // Every row commits separately. Never hold the header lock while invoking a new transaction.
    function fresh(name, args) {
        const out = ec.service.sync().name(name).parameters(args).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return out
    }
    const result = existing
            ? detail({productBomId: existing.productBomId})
            : fresh("mantle.product.BomServices.store#Bom", {
                  productId: p.productId,
                  organizationPartyId: s.organizationPartyId,
                  methodCode: p.methodCode || "MAIN",
                  quantityUomId: p.quantityUomId || product.amountUomId,
                  changeReason: why
              }),
        id = result.productBom.productBomId,
        findings = [],
        imported = []
    for (const assoc of rows("mantle.product.ProductAssoc", {productId: p.productId, productAssocTypeEnumId: "PatMfgBom"}).filter(
        r => active(r, date)
    )) {
        const key = JSON.stringify([assoc.productId, assoc.toProductId, String(assoc.fromDate)])
        if (rows(L, {productBomId: id, legacyAssocKey: key}).length) continue
        try {
            const component = policy().product(assoc.toProductId, s),
                saved = fresh("mantle.product.BomServices.store#BomItem", {
                    productBomId: id,
                    productId: component.productId,
                    roleEnumId: "BmirConsume",
                    quantity: assoc.quantity ?? 1,
                    quantityUomId: component.amountUomId || p.quantityUomId,
                    sequenceNum: assoc.sequenceNum || 10,
                    scrapFactor: assoc.scrapFactor || 0,
                    instruction: assoc.instruction,
                    legacyAssocKey: key,
                    changeReason: why
                })
            imported.push(saved.bomItemId)
        } catch (e) {
            ec.message.clearErrors()
            findings.push({recordId: assoc.toProductId, message: String(e.message || e)})
            ec.logger.error("Legacy BOM " + p.productId + " component " + assoc.toProductId + ": " + e)
        }
    }
    policy().audit(["legacyImportComplete", "legacyImportIssuesJson"], why)
    call("update#" + B, {
        productBomId: id,
        legacyImportComplete: findings.length ? "N" : "Y",
        legacyImportIssuesJson: JSON.stringify(findings)
    })
    return Object.assign(detail({productBomId: id}), {importedItemIds: imported, findings, skipped: false})
}
function createContent(p) {
    getBom(p.productBomId, "edit")
    if (p.productBomContentTypeEnumId && !["BomctDocument", "BomctInstruction"].includes(p.productBomContentTypeEnumId))
        throw new Error("Choose a method file type")
    if (!p.contentFile && !p.contentText) throw new Error("Choose a method file or enter instruction text")
    const id = "bmc-" + ec.user.randomString(24),
        filename = String(p.contentFile?.getName() || p.filename || "instruction.txt")
            .replace(/[\/\\?#%:*"<>|]/g, "_")
            .slice(0, 160),
        location = "dbresource://mantle/content/bom/" + p.productBomId + "/content_" + id + "/" + filename,
        ref = ec.resource.getLocationReference(location)
    if (p.contentFile) {
        const stream = p.contentFile.getInputStream()
        try {
            ref.putStream(stream)
        } finally {
            stream.close()
        }
    } else ref.putText(String(p.contentText))
    const why = "Method file added"
    policy().audit(["productBomId", "productBomContentTypeEnumId", "description", "contentLocation", "fromDate", "userId"], why)
    call("create#mantle.product.bom.ProductBomContent", {
        productBomContentId: id,
        productBomId: p.productBomId,
        productBomContentTypeEnumId: p.productBomContentTypeEnumId || "BomctDocument",
        description: p.description || filename,
        contentLocation: location,
        fromDate: ec.user.nowTimestamp,
        userId: ec.user.userId
    })
    return {productBomContentId: id, contentLocation: location}
}
function access(p) {
    try {
        const g = getBom(p.productBomId, p.need || "read")
        return {recordVisible: true, record: g.bom, canChange: g.scope.edit}
    } catch (e) {
        return {recordVisible: false, record: null, canChange: false}
    }
}
function execute(op, p) {
    return {
        detail,
        list,
        storeBom,
        storeItem,
        access,
        validate,
        release,
        explode,
        compareDates,
        whereUsed,
        importLegacy,
        createContent
    }[op](p)
}
;({
    execute,
    getBom,
    detail,
    list,
    storeBom,
    storeItem,
    rootLine,
    validateLine,
    projected,
    choose,
    headerAt,
    latest,
    decisions,
    items,
    drafts,
    revision,
    checkRevision,
    headerFields,
    lineFields
})
