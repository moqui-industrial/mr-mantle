// Standard estimates and the one cost calculator. Approval freezes an estimate; Accounting alone changes book value.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CostPolicy.js")
const H = "mantle.product.cost.ProductStandardCost",
    C = "mantle.product.cost.ProductStandardCostComponent",
    P = "mantle.product.cost.ProductCostCalculation"
const one = (n, p) => policy().one(n, p),
    rows = (n, p = {}) => policy().rows(n, p),
    find = (n, p = {}) => policy().find(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    pick = (p, f) => policy().pick(p, f),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    active = (r, d) => policy().active(r, d)
const headerFields = [
        "productId",
        "organizationPartyId",
        "facilityId",
        "quantity",
        "quantityUomId",
        "priceUomId",
        "productBomId",
        "methodAsOfDate",
        "materialBasis",
        "overheadBasis",
        "overheadPercent"
    ],
    componentFields = [
        "componentTypeEnumId",
        "description",
        "path",
        "productId",
        "quantity",
        "quantityUomId",
        "rateAmount",
        "amount",
        "priceUomId",
        "sourceEntityName",
        "sourceId",
        "sourceFromDate",
        "sourceFingerprint",
        "sourceRequiredCapability",
        "costAllocationFactor"
    ]
const types = ["PccMaterial", "PccLabor", "PccMachine", "PccOverhead", "PccOverheadPercent", "PccOutside"],
    totalsFields = ["totalCost", "unitCost", "materialCost", "laborCost", "machineCost", "overheadCost", "outsideCost"]
function get(id, need = "read") {
    const row = one(H, {productStandardCostId: id})
    if (!row) throw new Error("Standard estimate is not available")
    return {estimate: map(row), scope: policy().scope(row, need)}
}
function components(id) {
    return rows(C, {productStandardCostId: id})
        .map(map)
        .sort(
            (a, b) =>
                Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0) ||
                a.productStandardCostComponentId.localeCompare(b.productStandardCostComponentId)
        )
}
function revision(h) {
    return policy().fingerprint({header: map(h), components: components(h.productStandardCostId)})
}
function locked(id, need, expected, required = false) {
    let g = get(id, need)
    g.estimate = map(find(H, {productStandardCostId: id}).forUpdate(true).one())
    if (required && !expected) throw new Error("Review this estimate and provide its expected revision")
    if (expected && expected !== revision(g.estimate)) throw new Error("Estimate changed; reload and review")
    return g
}
function effective(productId, organizationPartyId, date, facilityId) {
    const matches = rows(H, {productId, organizationPartyId, state: "approved"}).filter(r => active(r, date))
    return matches.find(r => facilityId && r.facilityId === facilityId) || matches.find(r => !r.facilityId) || null
}
function sourceVisible(row, s) {
    if (
        (row.sourceRequiredCapability === "supplierRead" && !s.supplierRead) ||
        (row.sourceRequiredCapability === "methodRead" && !s.methodRead)
    )
        return false
    if (!row.sourceEntityName || !row.sourceId) return true
    try {
        if (row.sourceEntityName === "mantle.product.ProductPrice") {
            const price = one(row.sourceEntityName, {productPriceId: row.sourceId})
            if (!price) return false
            ec.resource.script("component://mr-mantle/service/mantle/product/PricePolicy.js").execute("access", price)
            return true
        }
        if (row.sourceEntityName === "mantle.work.production.WorkCenterRate") {
            const rate = one(row.sourceEntityName, {workCenterRateId: row.sourceId}),
                f = rate ? one("mantle.facility.Facility", {facilityId: rate.facilityId}) : null
            return !!f && f.ownerPartyId === s.organizationPartyId
        }
        if (row.sourceEntityName === H) {
            get(row.sourceId)
            return true
        }
        return true
    } catch (e) {
        return false
    }
}
function projectedComponent(row, s) {
    if (sourceVisible(row, s)) return row
    return Object.assign(
        pick(row, [
            "productStandardCostComponentId",
            "productStandardCostId",
            "sequenceNum",
            "componentTypeEnumId",
            "amount",
            "priceUomId"
        ]),
        {description: "Restricted source", sourceRestricted: true}
    )
}
function detail(p) {
    const g = get(p.productStandardCostId)
    return {
        standardCost: g.estimate,
        componentRows: components(p.productStandardCostId).map(r => projectedComponent(r, g.scope)),
        estimateRevision: revision(g.estimate),
        costAccess: g.scope
    }
}
function list(p) {
    const s = policy().scope(p),
        date = p.asOfDate || ec.user.nowTimestamp,
        out = []
    for (const row of rows(H, {organizationPartyId: s.organizationPartyId})) {
        if (
            (p.productId && row.productId !== p.productId) ||
            (p.facilityId && row.facilityId !== p.facilityId) ||
            (p.state && row.state !== p.state) ||
            (p.priceUomId && row.priceUomId !== p.priceUomId) ||
            (!p.includeHistory && row.state === "approved" && !active(row, date))
        )
            continue
        try {
            policy().product(row.productId, s)
            out.push(map(row))
        } catch (e) {
            ec.logger.error("Standard estimate " + row.productStandardCostId + " omitted: " + e)
        }
    }
    return {standardCostRows: out, organizationPartyId: s.organizationPartyId, costAccess: s}
}
function validateHeader(data, s) {
    policy().product(data.productId, s)
    policy().currency(data.priceUomId)
    policy().unit(data.quantityUomId)
    if (data.quantity == null || toDecimal(data.quantity).compare(0) <= 0) throw new Error("Estimate quantity must be positive")
    const product = policy().product(data.productId, s)
    if (product.amountUomId)
        policy().convert(data.quantity, data.quantityUomId, product.amountUomId, data.methodAsOfDate || ec.user.nowTimestamp)
    if (data.facilityId) policy().facility(data.facilityId, s)
    if (data.productBomId) {
        const method = call("mantle.product.BomServices.get#BomDetail", {productBomId: data.productBomId})
        if (method.productBom.productId !== data.productId || method.productBom.organizationPartyId !== s.organizationPartyId)
            throw new Error("Cost BOM is not in this product and organization")
    }
    if (data.overheadPercent != null && toDecimal(data.overheadPercent).compare(0) < 0)
        throw new Error("Overhead percentage cannot be negative")
}
function totals(header, lines) {
    const result = Object.fromEntries(totalsFields.map(f => [f, toDecimal(0)]))
    for (const row of lines) {
        if (row.amount == null) continue
        const amount = toDecimal(row.amount)
        if (amount.compare(0) < 0) throw new Error("Estimate amounts cannot be negative")
        result.totalCost = result.totalCost.add(amount)
        const field = {
            PccMaterial: "materialCost",
            PccLabor: "laborCost",
            PccMachine: "machineCost",
            PccOverhead: "overheadCost",
            PccOverheadPercent: "overheadCost",
            PccOutside: "outsideCost"
        }[row.componentTypeEnumId]
        if (!field) throw new Error("Unknown cost component")
        result[field] = result[field].add(amount)
    }
    result.totalCost = result.totalCost.setScale(Number(policy().currency(header.priceUomId).fractionDigits ?? 2), "HALF_UP")
    result.unitCost = result.totalCost.divide(header.quantity)
    return Object.fromEntries(Object.entries(result).map(([k, v]) => [k, String(v)]))
}
function recalculate(id, why) {
    const h = map(one(H, {productStandardCostId: id})),
        lines = components(id),
        findings = []
    if (h.calculationId) return pick(h, [...totalsFields, "complete", "findingsJson"])
    if (!lines.length) findings.push({recordId: id, message: "Add at least one explicit cost component"})
    for (const r of lines)
        if (r.amount == null)
            findings.push({recordId: r.productStandardCostComponentId, message: "Component has no valued amount"})
    const data = Object.assign(totals(h, lines), {
        productStandardCostId: id,
        complete: findings.length ? "N" : "Y",
        findingsJson: JSON.stringify(findings)
    })
    if (findings.length) {
        data.totalCost = null
        data.unitCost = null
    }
    policy().audit([...totalsFields, "complete", "findingsJson"], why)
    call("update#" + H, data)
    return data
}
function store(p) {
    const old = p.productStandardCostId ? locked(p.productStandardCostId, "edit", p.expectedRevision) : null,
        s = old?.scope || policy().scope(p, "edit"),
        why = policy().reason(p)
    if (old?.estimate.state === "approved") throw new Error("Approved estimates are immutable; create a new dated draft")
    const data = Object.assign(
        {
            quantity: 1,
            quantityUomId: policy().product(p.productId || old?.estimate.productId, s).amountUomId || "OTH_ea",
            priceUomId: ec.user.userAccount?.currencyUomId || "USD",
            materialBasis: "manual",
            overheadBasis: "none"
        },
        old?.estimate || {},
        pick(p, headerFields),
        {organizationPartyId: s.organizationPartyId}
    )
    if (
        old &&
        ["productId", "organizationPartyId", "facilityId"].some(f => String(data[f] || "") !== String(old.estimate[f] || ""))
    )
        throw new Error("The estimate product and organization/facility scope are fixed")
    if (
        old &&
        components(p.productStandardCostId).length &&
        ["priceUomId", "quantityUomId", "quantity"].some(f => String(data[f]) !== String(old.estimate[f]))
    )
        throw new Error("Create a new draft for another quantity, unit or currency")
    if (old?.estimate.calculationId && headerFields.some(f => String(data[f] ?? "") !== String(old.estimate[f] ?? "")))
        throw new Error("Recalculate sourced estimates to change their inputs")
    validateHeader(data, s)
    policy().audit([...headerFields, "state", "draftedByUserId", "lastEditedByUserId", "changeReason"], why)
    const out = call(
            (old ? "update#" : "create#") + H,
            Object.assign(pick(data, headerFields), {
                productStandardCostId: p.productStandardCostId,
                state: "draft",
                draftedByUserId: old?.estimate.draftedByUserId || ec.user.userId,
                lastEditedByUserId: ec.user.userId,
                changeReason: why
            })
        ),
        id = p.productStandardCostId || out.productStandardCostId
    recalculate(id, why)
    return detail({productStandardCostId: id})
}
function storeComponent(p) {
    const old = p.productStandardCostComponentId
            ? one(C, {productStandardCostComponentId: p.productStandardCostComponentId})
            : null,
        id = old?.productStandardCostId || p.productStandardCostId,
        g = locked(id, "edit", p.expectedRevision),
        why = policy().reason(p)
    if (g.estimate.state !== "draft") throw new Error("Approved cost components are immutable")
    if ((p.productStandardCostId && p.productStandardCostId !== id) || (p.productStandardCostComponentId && !old))
        throw new Error("Cost component is not available")
    if (g.estimate.calculationId || old?.sourceEntityName) throw new Error("Recalculate sourced components; they are read only")
    if (p.sourceEntityName || p.sourceId)
        throw new Error("The calculator records source identities; a manual component has a manual rate")
    const data = Object.assign(
        {componentTypeEnumId: "PccMaterial", quantity: 1, quantityUomId: g.estimate.quantityUomId, rateAmount: 0},
        old ? map(old) : {},
        pick(p, ["componentTypeEnumId", "description", "quantity", "quantityUomId", "rateAmount", "sequenceNum"])
    )
    if (!types.includes(data.componentTypeEnumId) || data.componentTypeEnumId === "PccOverheadPercent")
        throw new Error("Choose a material, labor, machine, hourly overhead or outside-processing component")
    if (
        data.quantity == null ||
        toDecimal(data.quantity).compare(0) <= 0 ||
        data.rateAmount == null ||
        toDecimal(data.rateAmount).compare(0) < 0
    )
        throw new Error("Component quantity must be positive and its rate zero or positive")
    policy().unit(data.quantityUomId)
    policy().audit([...componentFields, "lastEditedByUserId", "changeReason"], why)
    const componentId = old?.productStandardCostComponentId || "scc-" + ec.user.randomString(24)
    call(
        (old ? "update#" : "create#") + C,
        Object.assign(
            pick(data, ["componentTypeEnumId", "description", "quantity", "quantityUomId", "rateAmount", "sequenceNum"]),
            {
                productStandardCostComponentId: componentId,
                productStandardCostId: id,
                priceUomId: g.estimate.priceUomId,
                amount: String(toDecimal(data.quantity).multiply(data.rateAmount)),
                createdByUserId: old?.createdByUserId || ec.user.userId,
                lastEditedByUserId: ec.user.userId,
                changeReason: why
            }
        )
    )
    call("update#" + H, {productStandardCostId: id, lastEditedByUserId: ec.user.userId, changeReason: why})
    recalculate(id, why)
    return detail({productStandardCostId: id})
}
function approved(p) {
    const s = policy().scope(p),
        row = effective(p.productId, s.organizationPartyId, p.asOfDate || ec.user.nowTimestamp, p.facilityId)
    return {standardCost: row ? map(row) : null, costAvailable: !!row}
}
function print(p, approvedHeader = null, canonical = false) {
    const g = get(p.productStandardCostId),
        h = approvedHeader || g.estimate,
        lines = components(h.productStandardCostId).map(r =>
            projectedComponent(r, canonical ? {supplierRead: false, methodRead: false} : g.scope)
        ),
        esc = v =>
            String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c])
    return {
        standardCost: h,
        printHtml:
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Standard estimate ' +
            esc(h.productStandardCostId) +
            "</title><style>body{font:14px sans-serif;color:#18212b;margin:36px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left}h1{font-size:24px}</style></head><body><h1>Standard cost estimate</h1><p>" +
            esc(h.productId) +
            " · " +
            esc(h.organizationPartyId) +
            " · " +
            esc(h.state) +
            "</p><p>Estimate quantity " +
            esc(h.quantity) +
            " " +
            esc(h.quantityUomId) +
            "; currency " +
            esc(h.priceUomId) +
            ". This estimate does not post inventory or ledger changes.</p><p>Effective " +
            esc(h.fromDate ? iso(h.fromDate) : "Draft") +
            " · Approved by " +
            esc(h.approvedByUserId || "Pending") +
            " · Approval time " +
            esc(h.approvedDate ? iso(h.approvedDate) : "Pending") +
            "</p><table><thead><tr><th>Component</th><th>Description</th><th>Quantity</th><th>Rate</th><th>Allocation</th><th>Amount</th></tr></thead><tbody>" +
            lines
                .map(
                    r =>
                        "<tr><td>" +
                        esc(r.componentTypeEnumId) +
                        "</td><td>" +
                        esc(r.description) +
                        "</td><td>" +
                        esc(r.quantity) +
                        "</td><td>" +
                        esc(r.rateAmount) +
                        "</td><td>" +
                        esc(r.costAllocationFactor ?? 1) +
                        "</td><td>" +
                        esc(r.amount) +
                        "</td></tr>"
                )
                .join("") +
            "</tbody></table><h2>Total " +
            esc(h.totalCost) +
            " " +
            esc(h.priceUomId) +
            "</h2><p>Unit estimate " +
            esc(h.unitCost) +
            " per " +
            esc(h.quantityUomId) +
            "</p><p>" +
            esc(h.changeReason) +
            "</p></body></html>"
    }
}
function approve(p) {
    const reviewedEstimate = get(p.productStandardCostId, "approve")
    find("mantle.party.Party", {partyId: reviewedEstimate.estimate.organizationPartyId}).forNoKeyUpdate(true).one()
    const g = locked(p.productStandardCostId, "approve", p.expectedRevision, true),
        h = g.estimate,
        why = policy().reason(p),
        now = ec.user.nowTimestamp,
        date = p.fromDate || now
    if (h.state !== "draft") throw new Error("This estimate is already approved")
    if (ms(date) < ms(now) || (p.thruDate && ms(p.thruDate) <= ms(date)))
        throw new Error("Estimate approval must start now or later, with its end after the start")
    const lines = components(h.productStandardCostId),
        setting = rows("mantle.product.ProductCatalogSetting", {organizationPartyId: h.organizationPartyId})
            .filter(r => active(r, now))
            .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0],
        authors = [h.draftedByUserId, h.lastEditedByUserId, ...lines.flatMap(r => [r.createdByUserId, r.lastEditedByUserId])]
    if (authors.includes(ec.user.userId) && setting?.allowCostSelfApproval !== "Y")
        throw new Error("The drafter cannot approve this estimate unless the dated self-approval setting allows it")
    if (!lines.length || h.complete !== "Y" || lines.some(r => r.amount == null))
        throw new Error("An incomplete estimate cannot be approved")
    if (h.calculationId) {
        const calculation = one(P, {calculationId: h.calculationId})
        if (!calculation) throw new Error("The source calculation is unavailable")
        const current = calculate(JSON.parse(calculation.requestJson))
        if (!current.complete || current.inputFingerprint !== h.inputFingerprint)
            throw new Error("Cost inputs changed; preview and save the roll-up again")
    }
    validateHeader(h, g.scope)
    const history = rows(H, {productId: h.productId, organizationPartyId: h.organizationPartyId, state: "approved"})
            .filter(r => (r.facilityId || null) === (h.facilityId || null))
            .sort((a, b) => ms(a.fromDate) - ms(b.fromDate)),
        previous = history.filter(r => ms(r.fromDate) < ms(date)).at(-1),
        next = history.find(r => ms(r.fromDate) > ms(date))
    if (history.some(r => ms(r.fromDate) === ms(date))) throw new Error("An approved estimate already starts on this date")
    const end = next ? (!p.thruDate || ms(p.thruDate) > ms(next.fromDate) ? iso(next.fromDate) : p.thruDate) : p.thruDate || null
    const approvedHeader = Object.assign({}, h, {
        state: "approved",
        fromDate: iso(date),
        thruDate: end,
        approvedDate: now,
        approvedByUserId: ec.user.userId,
        changeReason: why
    })
    // PDF failure is a failed approval: the required approved print and the estimate commit together.
    const html = print({productStandardCostId: h.productStandardCostId}, approvedHeader, true).printHtml,
        pdf = ec.resource.xslFoTransform(html, null, null, "application/pdf"),
        location = "dbresource://mantle/content/standard-cost/" + h.productStandardCostId + "/approved.pdf"
    ec.resource.getLocationReference(location).putBytes(pdf)
    policy().audit(
        ["fromDate", "thruDate", "state", "approvedDate", "approvedByUserId", "approvedPdfLocation", "changeReason"],
        why
    )
    if (previous && (!previous.thruDate || ms(previous.thruDate) > ms(date)))
        call("update#" + H, {productStandardCostId: previous.productStandardCostId, thruDate: iso(date), changeReason: why})
    call(
        "update#" + H,
        Object.assign(
            pick(approvedHeader, [
                "productStandardCostId",
                "state",
                "fromDate",
                "thruDate",
                "approvedDate",
                "approvedByUserId",
                "changeReason"
            ]),
            {approvedPdfLocation: location}
        )
    )
    return detail({productStandardCostId: h.productStandardCostId})
}
function material(productId, quantity, unit, request, s, evidence) {
    const product = policy().product(productId, s),
        date = request.asOfDate,
        currency = request.priceUomId,
        basis = request.materialBasis
    if (basis === "standard") {
        const cost = effective(productId, s.organizationPartyId, date, request.facilityId)
        if (!cost) throw new Error("No approved component standard estimate")
        const entered = policy().convert(quantity, unit, cost.quantityUomId, date),
            fx = policy().convertCurrency(cost.unitCost, cost.priceUomId, currency, date)
        evidence.push({source: map(cost), quantityConversion: String(entered.factor), currencyConversion: fx.source})
        return {
            quantity: String(entered.quantity),
            quantityUomId: cost.quantityUomId,
            rateAmount: String(fx.amount),
            amount: String(entered.quantity.multiply(fx.amount)),
            sourceEntityName: H,
            sourceId: cost.productStandardCostId,
            sourceFromDate: cost.fromDate,
            sourceFingerprint: policy().fingerprint(map(cost))
        }
    }
    if (basis === "supplier" || basis === "average") {
        if (basis === "supplier" && !s.supplierRead)
            throw new Error("Supplier-price read authority is required for this material basis")
        let offers = rows("mantle.product.ProductPrice", {
            productId,
            priceTypeEnumId: basis === "average" ? "PptAverage" : "PptCurrent"
        }).filter(r => active(r, date) && r.price != null)
        if (basis === "supplier")
            offers = offers.filter(
                r =>
                    r.preferredOrderEnumId === "SpoMain" &&
                    r.vendorPartyId &&
                    (!r.customerPartyId || r.customerPartyId === s.organizationPartyId) &&
                    !one("mantle.party.PartyRole", {partyId: r.vendorPartyId, roleTypeId: "OrgInternal"})
            )
        else offers = offers.filter(r => r.vendorPartyId === s.organizationPartyId && !r.customerPartyId)
        const readable = []
        for (const row of offers)
            try {
                ec.resource
                    .script("component://mr-mantle/service/mantle/product/PricePolicy.js")
                    .execute(
                        "access",
                        basis === "supplier" && !row.customerPartyId
                            ? Object.assign(map(row), {customerPartyId: s.organizationPartyId})
                            : row
                    )
                readable.push(row)
            } catch (e) {
                ec.logger.error("Cost source price " + row.productPriceId + " omitted: " + e)
            }
        const vendors = [...new Set(readable.map(r => r.vendorPartyId))]
        if (vendors.length !== 1)
            throw new Error(
                basis === "supplier" ? "No unique readable main-supplier price" : "No organization average-cost price"
            )
        const currencies = [...new Set(readable.map(r => r.priceUomId))],
            priceUomId = currencies.includes(currency) ? currency : currencies.length === 1 ? currencies[0] : null
        if (!priceUomId) throw new Error("Several material price currencies apply; choose a unique source")
        const args = {
            productId,
            quantity: String(quantity),
            quantityUomId: unit,
            validDate: date,
            priceUomId,
            vendorPartyId: vendors[0],
            customerPartyId: basis === "supplier" ? s.organizationPartyId : null,
            direction: basis === "supplier" ? "purchase" : "sales",
            organizationPartyId: s.organizationPartyId,
            pricePurposeEnumId: "PppPurchase",
            explain: true
        }
        const price = call(
            basis === "average"
                ? "mantle.product.PriceServices.get#ProductPriceByType"
                : "mantle.product.PriceServices.get#ProductPrice",
            Object.assign(args, basis === "average" ? {priceTypeEnumId: "PptAverage"} : {})
        )
        if (price.price == null || price.priceAvailable === false)
            throw new Error("No applicable material price at the batch quantity and date")
        const source = price.productPriceId
            ? one("mantle.product.ProductPrice", {productPriceId: price.productPriceId})
            : price.priceRuleId
              ? one("mantle.product.ProductPriceRule", {priceRuleId: price.priceRuleId})
              : null
        if (!source) throw new Error("Material price has no auditable source identity")
        const fx = policy().convertCurrency(price.price, priceUomId, currency, date),
            entity = price.productPriceId ? "mantle.product.ProductPrice" : "mantle.product.ProductPriceRule"
        evidence.push({
            source: map(source),
            currencyConversion: fx.source,
            trace: price.priceTrace || [],
            priceList: price.priceListId ? map(one("mantle.product.ProductPriceList", {priceListId: price.priceListId})) : null
        })
        return {
            quantity: String(quantity),
            quantityUomId: unit,
            rateAmount: String(fx.amount),
            amount: String(toDecimal(quantity).multiply(fx.amount)),
            sourceEntityName: entity,
            sourceId: price.productPriceId || price.priceRuleId,
            sourceFromDate: source.fromDate,
            sourceFingerprint: policy().fingerprint(map(source)),
            sourceRequiredCapability: basis === "supplier" ? "supplierRead" : null
        }
    }
    if (basis === "last-receipt") {
        let selected = null,
            asset = null
        for (const receipt of rows("mantle.product.receipt.AssetReceipt", {productId})
            .filter(r => ms(r.receivedDate) <= ms(date) && toDecimal(r.quantityAccepted || 0).compare(0) > 0)
            .sort(
                (a, b) =>
                    ms(b.receivedDate) - ms(a.receivedDate) || String(b.assetReceiptId).localeCompare(String(a.assetReceiptId))
            )) {
            const candidate = one("mantle.product.asset.Asset", {assetId: receipt.assetId})
            if (
                candidate?.ownerPartyId === s.organizationPartyId &&
                (!request.facilityId || candidate.facilityId === request.facilityId)
            ) {
                selected = receipt
                asset = candidate
                break
            }
        }
        if (
            !selected ||
            (selected.receiptUnitCost ?? asset.acquireCost) == null ||
            !(selected.receiptCostUomId || asset.acquireCostUomId)
        )
            throw new Error("No owned valued receipt is available")
        const acquired = ec.resource
                .script("component://mr-mantle/service/mantle/ledger/ForwardInventoryCosts.js")
                .at(asset, selected.receivedDate),
            entered = policy().convert(quantity, unit, product.amountUomId || unit, date),
            fx = policy().convertCurrency(acquired.unitCost, acquired.amountUomId, currency, date)
        evidence.push({
            receipt: map(selected),
            asset: pick(map(asset), [
                "assetId",
                "productId",
                "ownerPartyId",
                "facilityId",
                "acquireCost",
                "acquireCostUomId",
                "lastUpdatedStamp"
            ]),
            currencyConversion: fx.source
        })
        return {
            quantity: String(entered.quantity),
            quantityUomId: product.amountUomId || unit,
            rateAmount: String(fx.amount),
            amount: String(entered.quantity.multiply(fx.amount)),
            sourceEntityName: "mantle.product.receipt.AssetReceipt",
            sourceId: selected.assetReceiptId,
            sourceFromDate: selected.receivedDate,
            sourceFingerprint: policy().fingerprint([map(selected), String(asset.acquireCost), asset.acquireCostUomId])
        }
    }
    throw new Error("Choose approved standard, main supplier, average cost or last receipt as material basis")
}
function normalizeRequest(p, s) {
    const product = policy().product(p.productId, s),
        data = {
            productId: p.productId,
            organizationPartyId: s.organizationPartyId,
            facilityId: p.facilityId || null,
            productBomId: p.productBomId || null,
            quantity: String(toDecimal(p.quantity ?? 1)),
            quantityUomId: p.quantityUomId || product.amountUomId || "OTH_ea",
            priceUomId: p.priceUomId || ec.user.userAccount?.currencyUomId || "USD",
            asOfDate: iso(p.asOfDate || ec.user.nowTimestamp),
            materialBasis: p.materialBasis || "standard",
            methodMode: p.methodMode || "auto",
            overheadBasis: p.overheadBasis || (p.overheadPercent != null ? "percent" : "work-center"),
            overheadPercent: String(toDecimal(p.overheadPercent || 0)),
            productFeatureIds: [...new Set(Array.isArray(p.productFeatureIds) ? p.productFeatureIds : [])].sort()
        }
    validateHeader(Object.assign({}, data, {methodAsOfDate: data.asOfDate}), s)
    if (
        !["standard", "supplier", "average", "last-receipt"].includes(data.materialBasis) ||
        !["auto", "purchased"].includes(data.methodMode) ||
        !["work-center", "percent", "none"].includes(data.overheadBasis)
    )
        throw new Error("Choose supported material, method and overhead bases")
    return data
}
function calculate(p) {
    const s = policy().scope(p),
        request = normalizeRequest(p, s),
        date = request.asOfDate,
        evidence = [],
        findings = [],
        demands = {},
        allocationRows = [],
        method = ec.resource.script("component://mr-mantle/service/mantle/product/Boms.js")
    const add = (id, error, path) => {
        findings.push({recordId: id, path: path || "", message: String(error.message || error)})
        ec.logger.error("Cost roll-up " + request.productId + " input " + id + ": " + error)
    }
    function leaf(productId, quantity, unit, path, basis) {
        const key = [productId, unit, basis].join("|")
        if (!demands[key]) demands[key] = {productId, unit, basis, quantity: toDecimal(0)}
        demands[key].quantity = demands[key].quantity.add(quantity)
        return {kind: "material", productId, quantity: toDecimal(quantity), unit, path, key}
    }
    function build(chosen, qty, unit, path, ancestors = []) {
        const header = chosen.header
        if (ancestors.includes(header.productBomId))
            throw new Error("BOM cycle: " + [...ancestors, header.productBomId].join(" → "))
        if (ancestors.length >= 64) throw new Error("BOM depth exceeds 64")
        const detail = call("mantle.product.BomServices.get#BomDetail", {productBomId: header.productBomId, asOfDate: date}),
            normalized = policy().convert(qty, unit, header.quantityUomId, date).quantity,
            node = {kind: "method", header, quantity: normalized, path, children: [], outputs: [], costComplete: true}
        evidence.push({
            bomId: header.productBomId,
            revision: detail.expectedRevision,
            release: chosen.release?.methodReleaseDecisionId
        })
        for (const row of detail.bomItemRows) {
            if (
                row.applicabilityFeatureIds &&
                !String(row.applicabilityFeatureIds)
                    .split(",")
                    .every(f => request.productFeatureIds.includes(f))
            )
                continue
            const linePath = path === "root" ? row.bomItemId : path + "/" + row.bomItemId
            try {
                const product = policy().product(row.productId, s),
                    net = normalized.divide(header.baseQuantity).multiply(row.quantity),
                    gross = row.roleEnumId === "BmirByproduct" ? net : net.multiply(toDecimal(1).add(row.scrapFactor || 0)),
                    stock = policy().convert(gross, row.quantityUomId, product.amountUomId || row.quantityUomId, date)
                if (row.roleEnumId === "BmirByproduct") {
                    node.outputs.push(Object.assign({}, row, {netQuantity: net, path: linePath}))
                    continue
                }
                const child = method.choose(row.productId, s.organizationPartyId, date, row.componentProductBomId)
                if (
                    child &&
                    child.header.isPhantom !== "Y" &&
                    effective(row.productId, s.organizationPartyId, date, request.facilityId)
                )
                    node.children.push(
                        leaf(
                            row.productId,
                            stock.quantity,
                            stock.toUomId || product.amountUomId || row.quantityUomId,
                            linePath,
                            "standard"
                        )
                    )
                else if (child) {
                    const built = build(child, gross, row.quantityUomId, linePath, [...ancestors, header.productBomId])
                    built.phantom = child.header.isPhantom === "Y"
                    built.productId = row.productId
                    built.requiredQuantity = stock.quantity
                    built.requiredUnit = product.amountUomId || row.quantityUomId
                    node.children.push(built)
                } else
                    node.children.push(
                        leaf(
                            row.productId,
                            stock.quantity,
                            product.amountUomId || row.quantityUomId,
                            linePath,
                            request.materialBasis
                        )
                    )
            } catch (error) {
                node.costComplete = false
                add(row.bomItemId, error, linePath)
            }
        }
        return node
    }
    let root = null
    if (request.methodMode === "auto")
        try {
            if (!s.methodRead)
                throw new Error(
                    "Manufacturing method-read authority is required to discover and roll up methods; choose purchased basis explicitly for a purchased item"
                )
            const available = call("mantle.product.BomServices.find#Boms", {
                    productId: request.productId,
                    organizationPartyId: s.organizationPartyId,
                    asOfDate: date
                }).bomRows,
                selected = request.productBomId
                    ? available.find(r => r.productBomId === request.productBomId)
                    : available.find(r => r.methodCode === "MAIN") || (available.length === 1 && available[0])
            if ((request.productBomId && !selected) || (!selected && available.length > 1))
                throw new Error("Choose one released method in this product and organization")
            if (selected) {
                request.productBomId = selected.productBomId
                const chosen = method.choose(request.productId, s.organizationPartyId, date, selected.productBomId)
                if (!chosen) throw new Error("The method has no approval effective on this date")
                root = build(chosen, request.quantity, request.quantityUomId, "root")
            }
        } catch (error) {
            add(request.productId, error)
        }
    if (!root && findings.length === 0)
        root = leaf(request.productId, request.quantity, request.quantityUomId, request.productId, request.materialBasis)
    const prices = {}
    for (const [key, demand] of Object.entries(demands))
        try {
            prices[key] = material(
                demand.productId,
                demand.quantity,
                demand.unit,
                Object.assign({}, request, {materialBasis: demand.basis}),
                s,
                evidence
            )
        } catch (error) {
            add(demand.productId, error)
        }
    const exactTotal = lines => lines.reduce((sum, line) => sum.add(line.amount || 0), toDecimal(0))
    function priceLeaf(node) {
        const source = prices[node.key]
        node.costComplete = !!source
        if (!source) return []
        const fraction = node.quantity.divide(demands[node.key].quantity)
        return [
            Object.assign({}, source, {
                componentTypeEnumId: "PccMaterial",
                productId: node.productId,
                path: node.path,
                description: "Material " + node.productId,
                quantity: String(toDecimal(source.quantity).multiply(fraction)),
                amount: String(toDecimal(source.amount).multiply(fraction)),
                costAllocationFactor: "1"
            })
        ]
    }
    function evaluate(node, blownThrough = false) {
        if (node.kind === "material") return priceLeaf(node)
        let lines = []
        for (const child of node.children) {
            const children = evaluate(child, !!child.phantom)
            if (child.costComplete === false) node.costComplete = false
            if (child.kind === "method" && !child.phantom) {
                const amount = child.costComplete === false ? null : exactTotal(children)
                lines.push({
                    componentTypeEnumId: "PccMaterial",
                    productId: child.productId,
                    path: child.path,
                    description: "Subassembly rolled in this calculation",
                    quantity: String(child.requiredQuantity),
                    quantityUomId: child.requiredUnit,
                    rateAmount: amount == null ? null : String(amount.divide(child.requiredQuantity)),
                    amount: amount == null ? null : String(amount),
                    priceUomId: request.priceUomId,
                    sourceEntityName: "mantle.product.bom.ProductBom",
                    sourceId: child.header.productBomId,
                    sourceFromDate: date,
                    sourceFingerprint: policy().fingerprint(children),
                    sourceRequiredCapability: "methodRead",
                    costAllocationFactor: "1"
                })
            } else lines.push(...children)
        }
        const header = node.header
        if (header.routingWorkEffortId)
            try {
                const routing = call("mantle.work.RoutingServices.get#RoutingDetail", {
                    workEffortId: header.routingWorkEffortId,
                    asOfDate: date
                })
                evidence.push({routingId: header.routingWorkEffortId, revision: routing.expectedRevision})
                const types = ["PccLabor", "PccMachine", ...(request.overheadBasis === "work-center" ? ["PccOverhead"] : [])],
                    basis = call("mantle.work.RoutingServices.get#OperationCostBasis", {
                        workEffortId: header.routingWorkEffortId,
                        asOfDate: date,
                        quantity: String(node.quantity),
                        quantityUomId: header.quantityUomId,
                        costingLotQuantity: header.baseQuantity,
                        costingLotUomId: header.quantityUomId,
                        applyEfficiency: true,
                        priceUomId: request.priceUomId,
                        componentTypeEnumIds: types,
                        allowCurrencyConversion: true
                    })
                if (!basis.complete) node.costComplete = false
                for (const finding of basis.findings || []) findings.push(Object.assign({}, finding, {path: node.path}))
                for (const row of basis.operationCostRows.filter(r => r.valued)) {
                    const rate = one("mantle.work.production.WorkCenterRate", {workCenterRateId: row.workCenterRateId}),
                        center = one("mantle.work.production.WorkCenter", {facilityId: rate.facilityId}),
                        fx = policy().convertCurrency(row.rateAmount, row.priceUomId, request.priceUomId, date)
                    evidence.push({rate: map(rate), workCenter: map(center), currencyConversion: fx.source})
                    lines.push({
                        componentTypeEnumId: row.componentTypeEnumId,
                        path: node.path + "/" + row.workEffortId,
                        description: "Routing " + row.workEffortId,
                        quantity: row.hours,
                        quantityUomId: "TF_hr",
                        rateAmount: String(fx.amount),
                        amount: String(toDecimal(row.hours).multiply(fx.amount)),
                        priceUomId: request.priceUomId,
                        sourceEntityName: "mantle.work.production.WorkCenterRate",
                        sourceId: row.workCenterRateId,
                        sourceFromDate: rate.fromDate,
                        sourceFingerprint: policy().fingerprint(map(rate)),
                        sourceRequiredCapability: "methodRead",
                        costAllocationFactor: "1"
                    })
                }
            } catch (error) {
                node.costComplete = false
                add(header.productBomId, error, node.path)
            }
        // One overhead charge at this manufacturing level. Phantom inputs/routing are blown into it.
        if (request.overheadBasis === "percent" && !blownThrough) {
            const base = exactTotal(lines.filter(r => !["PccOverhead", "PccOverheadPercent"].includes(r.componentTypeEnumId)))
            lines.push({
                componentTypeEnumId: "PccOverheadPercent",
                path: node.path,
                description: "Overhead percentage of material plus conversion",
                quantity: node.costComplete === false ? null : String(base),
                rateAmount: request.overheadPercent,
                amount: node.costComplete === false ? null : String(base.multiply(request.overheadPercent).divide(100)),
                priceUomId: request.priceUomId,
                costAllocationFactor: "1"
            })
        }
        if (node.outputs.length)
            try {
                const fixed = node.outputs.some(r => r.allocationShare != null),
                    fixedTotal = node.outputs
                        .filter(r => r.allocationShare != null)
                        .reduce((sum, r) => sum.add(r.allocationShare), toDecimal(0))
                if (fixedTotal.compare(1) > 0) throw new Error("By-product allocation exceeds one")
                const quantities = node.outputs.map(r =>
                        r.allocationShare == null
                            ? policy().convert(r.netQuantity, r.quantityUomId, header.quantityUomId, date).quantity
                            : toDecimal(0)
                    ),
                    unfixedTotal = quantities.reduce((sum, q) => sum.add(q), node.quantity),
                    remaining = toDecimal(1).subtract(fixedTotal),
                    shares = node.outputs.map((r, i) =>
                        r.allocationShare != null
                            ? toDecimal(r.allocationShare)
                            : remaining.multiply(quantities[i]).divide(unfixedTotal)
                    )
                const byproductShare = shares.reduce((sum, v) => sum.add(v), toDecimal(0))
                if (byproductShare.compare(1) > 0) throw new Error("By-product allocation exceeds one")
                const mainShare = toDecimal(1).subtract(byproductShare),
                    gross = exactTotal(lines)
                allocationRows.push({
                    productId: header.productId,
                    path: node.path,
                    quantity: String(node.quantity),
                    quantityUomId: header.quantityUomId,
                    allocationFactor: String(mainShare),
                    amount: node.costComplete === false ? null : String(gross.multiply(mainShare)),
                    priceUomId: request.priceUomId,
                    allocationBasis: fixed
                        ? node.outputs.some(r => r.allocationShare == null)
                            ? "Fixed shares, remainder by quantity"
                            : "Fixed shares"
                        : "Normalized quantity"
                })
                node.outputs.forEach((row, i) =>
                    allocationRows.push({
                        productId: row.productId,
                        path: row.path,
                        quantity: String(row.netQuantity),
                        quantityUomId: row.quantityUomId,
                        allocationFactor: String(shares[i]),
                        amount: node.costComplete === false ? null : String(gross.multiply(shares[i])),
                        priceUomId: request.priceUomId,
                        allocationBasis: fixed
                            ? node.outputs.some(r => r.allocationShare == null)
                                ? "Fixed shares, remainder by quantity"
                                : "Fixed shares"
                            : "Normalized quantity"
                    })
                )
                lines = lines.map(row =>
                    Object.assign({}, row, {
                        amount: row.amount == null ? null : String(toDecimal(row.amount).multiply(mainShare)),
                        costAllocationFactor: String(toDecimal(row.costAllocationFactor || 1).multiply(mainShare))
                    })
                )
            } catch (error) {
                node.costComplete = false
                add(header.productBomId, error, node.path)
            }
        return lines
    }
    let lines = root ? evaluate(root) : []
    if (root?.kind === "material" && request.overheadBasis === "percent") {
        const base = exactTotal(lines)
        lines.push({
            componentTypeEnumId: "PccOverheadPercent",
            description: "Overhead percentage of material",
            quantity: root.costComplete === false ? null : String(base),
            rateAmount: request.overheadPercent,
            amount: root.costComplete === false ? null : String(base.multiply(request.overheadPercent).divide(100)),
            priceUomId: request.priceUomId,
            costAllocationFactor: "1"
        })
    }
    if (!lines.length && !findings.length) add(request.productId, "No explicit valued cost components apply")
    const header = Object.assign(pick(request, headerFields), {
            methodAsOfDate: date,
            complete: findings.length ? "N" : "Y",
            findingsJson: JSON.stringify(findings)
        }),
        result = totals(header, lines),
        fingerprint = policy().fingerprint({request, evidence, lines, allocationRows, findings})
    if (findings.length) {
        result.totalCost = null
        result.unitCost = null
    }
    return {
        request,
        standardCost: Object.assign(header, result),
        componentRows: lines,
        allocationRows,
        findings,
        complete: findings.length === 0,
        inputFingerprint: fingerprint
    }
}
// The amount of each BOM path and its branch: a line counts toward its own path and every path above it.
function pathTotals(lines) {
    const totals = {}
    for (const line of lines) {
        if (!line.path || line.amount == null) continue
        const parts = String(line.path).split("/")
        for (let i = 1; i <= parts.length; i++) {
            const path = parts.slice(0, i).join("/")
            totals[path] = (totals[path] == null ? toDecimal(0) : toDecimal(totals[path])).add(line.amount)
        }
    }
    for (const path of Object.keys(totals)) totals[path] = String(totals[path])
    return totals
}
function preview(p) {
    const result = calculate(p)
    if (p.includePathTotals) result.pathTotals = pathTotals(result.componentRows)
    if (p.transientPreview) return result
    const id = "pcalc-" + ec.user.randomString(24),
        now = ec.user.nowTimestamp
    call("create#" + P, {
        calculationId: id,
        productId: result.request.productId,
        organizationPartyId: result.request.organizationPartyId,
        userId: ec.user.userId,
        createdDate: now,
        expiresDate: new Date(ms(now) + 1800000).toISOString(),
        requestJson: JSON.stringify(result.request),
        inputFingerprint: result.inputFingerprint,
        complete: result.complete ? "Y" : "N"
    })
    return Object.assign(result, {calculationId: id})
}
function savePreview(p) {
    const calculation = find(P, {calculationId: p.calculationId}).forUpdate(true).one()
    if (!calculation) throw new Error("Cost preview is not available")
    policy().scope(calculation, "edit")
    if (calculation.userId !== ec.user.userId) throw new Error("Review your own calculation before saving")
    const why = policy().reason(p)
    if (calculation.savedProductStandardCostId) return detail({productStandardCostId: calculation.savedProductStandardCostId})
    if (ms(calculation.expiresDate) < ms(ec.user.nowTimestamp)) throw new Error("Cost preview expired; calculate again")
    if (!p.inputFingerprint || p.inputFingerprint !== calculation.inputFingerprint)
        throw new Error("Review the exact calculation before saving")
    const result = calculate(JSON.parse(calculation.requestJson))
    if (result.inputFingerprint !== calculation.inputFingerprint)
        throw new Error("Cost inputs changed; preview again before saving")
    const h = Object.assign(pick(result.standardCost, headerFields), pick(result.standardCost, totalsFields), {
        state: "draft",
        complete: result.complete ? "Y" : "N",
        findingsJson: JSON.stringify(result.findings),
        calculationId: p.calculationId,
        inputFingerprint: result.inputFingerprint,
        draftedByUserId: ec.user.userId,
        lastEditedByUserId: ec.user.userId,
        changeReason: why
    })
    policy().audit([...headerFields, ...totalsFields, "complete", "calculationId", "inputFingerprint", "changeReason"], why)
    const out = call("create#" + H, h),
        id = out.productStandardCostId
    for (let i = 0; i < result.componentRows.length; i++) {
        const row = result.componentRows[i]
        policy().audit(componentFields, why)
        call(
            "create#" + C,
            Object.assign(pick(row, componentFields), {
                productStandardCostId: id,
                sequenceNum: i + 1,
                createdByUserId: ec.user.userId,
                lastEditedByUserId: ec.user.userId,
                changeReason: why
            })
        )
    }
    call("update#" + P, {calculationId: p.calculationId, savedProductStandardCostId: id})
    return detail({productStandardCostId: id})
}

function clone(p) {
    const g = locked(p.productStandardCostId, "edit", p.expectedRevision, true),
        why = policy().reason(p),
        source = g.estimate
    const out = call(
            "create#" + H,
            Object.assign(
                pick(source, [...headerFields, ...totalsFields, "complete", "findingsJson", "calculationId", "inputFingerprint"]),
                {state: "draft", draftedByUserId: ec.user.userId, lastEditedByUserId: ec.user.userId, changeReason: why}
            )
        ),
        id = out.productStandardCostId
    for (const row of components(source.productStandardCostId))
        call(
            "create#" + C,
            Object.assign(pick(row, [...componentFields, "sequenceNum"]), {
                productStandardCostId: id,
                createdByUserId: ec.user.userId,
                lastEditedByUserId: ec.user.userId,
                changeReason: why
            })
        )
    return detail({productStandardCostId: id})
}
function reviewed(p) {
    const c = one(P, {calculationId: p.calculationId})
    if (!c) throw new Error("Cost preview is not available")
    const s = policy().scope(c)
    if (c.userId !== ec.user.userId && !s.systemAdmin) throw new Error("Review your own calculation")
    const result = calculate(JSON.parse(c.requestJson)),
        stale = result.inputFingerprint !== c.inputFingerprint || ms(c.expiresDate) < ms(ec.user.nowTimestamp)
    if (stale) {
        result.complete = false
        result.findings.push({
            recordId: c.calculationId,
            message: "Inputs changed or this review expired. Preview again before saving."
        })
    }
    return Object.assign(result, {calculationId: c.calculationId, inputFingerprint: c.inputFingerprint, stale})
}
function previewMany(p) {
    const results = []
    for (const productId of [...new Set(p.productIds || [])])
        try {
            results.push(Object.assign({productId}, preview(Object.assign({}, p, {productId, productBomId: null}))))
        } catch (e) {
            ec.logger.error("Cost preview product " + productId + ": " + e)
            results.push({productId, complete: false, findings: [{recordId: productId, message: String(e.message || e)}]})
        }
    return {calculationRows: results}
}

function unitValue(row, p) {
    const unit = p.quantityUomId || one("mantle.product.Product", {productId: row.productId})?.amountUomId || row.quantityUomId,
        date = p.asOfDate || p.validDate || ec.user.nowTimestamp,
        quantity = policy().convert(1, unit, row.quantityUomId, date),
        currency = policy().convertCurrency(
            toDecimal(row.unitCost).multiply(quantity.quantity),
            row.priceUomId,
            p.priceUomId || row.priceUomId,
            date
        )
    return {
        unitCost: String(currency.amount),
        productStandardCostId: row.productStandardCostId,
        quantityUomId: unit,
        priceUomId: p.priceUomId || row.priceUomId
    }
}
// Private consumers may compute a selling price or store an order fact without returning the restricted base.
// They are script helpers, never CostServices operations or remote cost-read bypasses.
function pricingBase(p) {
    const s = call("mantle.product.ProductServices.get#CatalogOwnerScope"),
        a = policy().capabilities()
    if (!a.priceRead || (!s.systemAdmin && !s.ownerPartyIds.includes(p.organizationPartyId)))
        throw new Error("Standard pricing base is not available")
    policy().product(p.productId, Object.assign({}, s, a))
    const row = effective(p.productId, p.organizationPartyId, p.validDate || ec.user.nowTimestamp, p.facilityId)
    if (!row) throw new Error("No approved standard estimate applies")
    return unitValue(row, p)
}
function orderSnapshot(p) {
    const part = one("mantle.order.OrderPart", {orderId: p.orderId, orderPartSeqId: p.orderPartSeqId}),
        header = one("mantle.order.OrderHeader", {orderId: p.orderId})
    if (
        !part ||
        !header ||
        !one("mantle.party.PartyRole", {partyId: part.vendorPartyId, roleTypeId: "OrgInternal"}) ||
        one("mantle.party.PartyRole", {partyId: part.customerPartyId, roleTypeId: "OrgInternal"})
    )
        return {sales: false}
    const row = effective(p.productId, part.vendorPartyId, ec.user.nowTimestamp, part.facilityId)
    if (!row) return {sales: true, costAvailable: false}
    try {
        return Object.assign(
            {sales: true, costAvailable: true},
            unitValue(row, Object.assign({}, p, {priceUomId: header.currencyUomId, asOfDate: ec.user.nowTimestamp}))
        )
    } catch (e) {
        ec.logger.error(
            "Order cost snapshot " + p.orderId + ":" + p.orderPartSeqId + " product " + p.productId + " unavailable: " + e
        )
        return {sales: true, costAvailable: false}
    }
}
function history(p) {
    const s = policy().scope(p),
        out = [],
        costs = list(Object.assign({}, p, {includeHistory: true})).standardCostRows
    for (const row of costs)
        out.push({
            basis: "Standard estimate",
            date: row.fromDate || row.approvedDate || row.lastUpdatedStamp,
            productId: row.productId,
            productStandardCostId: row.productStandardCostId,
            quantity: row.quantity,
            quantityUomId: row.quantityUomId,
            unitCost: row.unitCost,
            amount: row.totalCost,
            priceUomId: row.priceUomId,
            state: row.state,
            sourceEntityName: H,
            sourceId: row.productStandardCostId
        })
    for (const receipt of rows("mantle.product.receipt.AssetReceipt", p.productId ? {productId: p.productId} : {}))
        try {
            const asset = one("mantle.product.asset.Asset", {assetId: receipt.assetId})
            if (
                !asset ||
                asset.ownerPartyId !== s.organizationPartyId ||
                (p.facilityId && asset.facilityId !== p.facilityId) ||
                asset.acquireCost == null
            )
                continue
            policy().product(asset.productId, s)
            const acquired = ec.resource
                .script("component://mr-mantle/service/mantle/ledger/ForwardInventoryCosts.js")
                .at(asset, receipt.receivedDate)
            out.push({
                basis: "Actual receipt acquisition cost",
                date: receipt.receivedDate,
                productId: asset.productId,
                quantity: receipt.quantityAccepted,
                quantityUomId: one("mantle.product.Product", {productId: asset.productId})?.amountUomId,
                unitCost: acquired.unitCost,
                amount: String(toDecimal(receipt.quantityAccepted || 0).multiply(acquired.unitCost)),
                priceUomId: acquired.amountUomId,
                sourceEntityName: "mantle.product.receipt.AssetReceipt",
                sourceId: receipt.assetReceiptId
            })
        } catch (e) {
            ec.logger.error("Cost history receipt " + receipt.assetReceiptId + ": " + e)
        }
    // The Accounting event entity is installed with P9; each event is a distinct basis, never added to an estimate.
    for (const event of rows("mantle.product.asset.AssetBookEvent", {organizationPartyId: s.organizationPartyId}))
        try {
            if ((p.productId && event.productId !== p.productId) || (p.facilityId && event.facilityId !== p.facilityId)) continue
            policy().product(event.productId, s)
            const row = {
                basis: "Valuation adjustment",
                date: event.eventDate,
                productId: event.productId,
                productStandardCostId: event.productStandardCostId,
                quantity: event.quantity,
                quantityUomId: event.quantityUomId,
                unitCost: event.newUnitCost,
                amount: event.amount,
                priceUomId: event.unitCostUomId || event.amountUomId,
                amountUomId: event.amountUomId,
                sourceEntityName: "mantle.product.asset.AssetBookEvent",
                sourceId: s.financeRead ? event.assetBookEventId : null,
                sourceRestricted: !s.financeRead
            }
            if (s.financeRead) row.acctgTransId = event.acctgTransId
            out.push(row)
        } catch (e) {
            ec.logger.error("Cost history book event " + event.assetBookEventId + ": " + e)
        }
    return {
        costHistoryRows: out
            .map(r => Object.assign({amountUomId: r.priceUomId}, r))
            .filter(
                r =>
                    (!p.priceUomId || r.priceUomId === p.priceUomId) &&
                    (!p.fromDate || ms(r.date) >= ms(p.fromDate)) &&
                    (!p.thruDate || ms(r.date) < ms(p.thruDate))
            )
            .sort((a, b) => (ms(b.date) || 0) - (ms(a.date) || 0)),
        organizationPartyId: s.organizationPartyId,
        costAccess: s
    }
}

function margin(p) {
    const a = policy().capabilities()
    if (!a.read || !a.priceRead || p.price == null) return {marginAvailable: false}
    const s = policy().scope(p),
        row = effective(p.productId, s.organizationPartyId, p.asOfDate || ec.user.nowTimestamp, p.facilityId)
    if (!row) return {marginAvailable: false}
    try {
        const cost = unitValue(row, p),
            price = toDecimal(p.price),
            difference = price.subtract(cost.unitCost)
        return {
            marginAvailable: true,
            standardCostAmount: cost.unitCost,
            marginAmount: String(difference),
            marginPercent: price.isZero() ? null : String(difference.divide(price).multiply(100).setScale(4, "HALF_UP")),
            productStandardCostId: row.productStandardCostId,
            priceUomId: cost.priceUomId
        }
    } catch (e) {
        ec.logger.error("Price margin " + p.productId + " unavailable: " + e)
        return {marginAvailable: false, marginMessage: String(e.message || e)}
    }
}

function access(p) {
    try {
        const g = get(p.productStandardCostId, p.need || "read")
        return {recordVisible: true, record: g.estimate, canChange: g.scope.edit && g.estimate.state === "draft"}
    } catch (e) {
        return {recordVisible: false, record: null, canChange: false}
    }
}
function execute(op, p) {
    return {
        list,
        detail,
        store,
        storeComponent,
        approved,
        print,
        approve,
        access,
        preview,
        savePreview,
        history,
        margin,
        clone,
        reviewed,
        previewMany
    }[op](p)
}
;({
    execute,
    effective,
    get,
    revision,
    components,
    totals,
    headerFields,
    componentFields,
    calculate,
    sourceVisible,
    pricingBase,
    orderSnapshot
})
