// Stock movements and lineage (impl-warehouse P4, WH-TRACE): the stock ledger (AssetDetail) with each row's source document,
// its correction chain and the revaluation split it belongs to, and the lineage of an asset, lot, shipment or work effort
// across receipts, issuances, splits and adjustments. Both read only the user's organizations (StockScope) and, when the
// caller passes them, its facilities; cost (unit cost, acquire cost) is answered only with ACCOUNTING_VIEW.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stock = ec.resource.script("component://mr-mantle/service/mantle/product/StockScope.js")
const {find, one, denied, dateText} = lib

const DETAIL_VIEW = "mantle.product.asset.AssetAndDetail"
const ASSET = "mantle.product.asset.Asset"
const RECEIPT = "mantle.product.receipt.AssetReceipt"
const ISSUANCE = "mantle.product.issuance.AssetIssuance"
const DETAIL = "mantle.product.asset.AssetDetail"
const maxDepthLimit = 10
const maxNodesLimit = 1000
const maxTreeRows = 500

const number = value => (value == null ? null : Number(String(value)))
const unique = values => [...new Set(values.filter(value => value != null && value !== ""))]
function rowsIn(entity, field, values, conditions = {}) {
    const distinct = unique(values)
    if (!distinct.length) return []
    return Array.from(find(entity, conditions).condition(field, "in", distinct).list())
}
function byId(entity, field, values) {
    return new Map(rowsIn(entity, field, values).map(row => [row[field], row]))
}
function names(entity, field, nameField, values) {
    return new Map(rowsIn(entity, field, values).map(row => [row[field], row[nameField] || row[field]]))
}
// One page of a list built in memory, with the fields a form-list reads (prefixed by field).
// A request with pageNoLimit (an export) gets every row on one page, up to noLimitCap.
const noLimitCap = 5000
const noLimit = p => p.pageNoLimit === true || p.pageNoLimit === "true"
function pageOf(list, p, field) {
    const pageSize = noLimit(p)
        ? Math.max(1, Math.min(list.length, noLimitCap))
        : Math.min(200, Math.max(1, Number(p.pageSize) || 50))
    const pageMaxIndex = Math.max(0, Math.ceil(list.length / pageSize) - 1)
    const pageIndex = Math.min(pageMaxIndex, Math.max(0, Number(p.pageIndex) || 0))
    return {
        [field]: list.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize),
        [field + "Count"]: list.length,
        [field + "PageIndex"]: pageIndex,
        [field + "PageSize"]: pageSize,
        [field + "PageMaxIndex"]: pageMaxIndex,
        [field + "PageRangeLow"]: list.length ? pageIndex * pageSize + 1 : 0,
        [field + "PageRangeHigh"]: Math.min(list.length, (pageIndex + 1) * pageSize)
    }
}
function callerFacilityIds(p) {
    if (p.facilityIds == null) return null
    return Array.isArray(p.facilityIds) ? p.facilityIds : Array.from(p.facilityIds)
}

// The revaluation splits among asset pairs (AssetBookEvent AbeInventoryRevaluation from sourceAssetId to assetId): a set
// of "source>target" keys.
function revaluationPairs(assetIds) {
    const ids = unique(assetIds)
    if (!ids.length) return new Set()
    const factory = ec.entity.conditionFactory
    const pairs = new Set()
    // in parts, so a long list of assets (stock at a date reads up to 2000) stays within an IN's bounds
    for (let index = 0; index < ids.length; index += 500) {
        const part = ids.slice(index, index + 500)
        const events = find("mantle.product.asset.AssetBookEvent")
            .condition("eventTypeEnumId", "AbeInventoryRevaluation")
            .condition(
                factory.makeCondition(
                    [factory.makeCondition("assetId", "in", part), factory.makeCondition("sourceAssetId", "in", part)],
                    "or"
                )
            )
            .list()
        for (const row of Array.from(events))
            if (row.sourceAssetId && row.sourceAssetId !== row.assetId) pairs.add(row.sourceAssetId + ">" + row.assetId)
    }
    return pairs
}

// ===== find#Movements =====
const sourceConditions = {
    receipt: [["assetReceiptId", "is-not-null"]],
    issuance: [["assetIssuanceId", "is-not-null"]],
    adjustment: [["physicalInventoryId", "is-not-null"]],
    split: [["otherAssetId", "is-not-null"]],
    other: [
        ["assetReceiptId", "is-null"],
        ["assetIssuanceId", "is-null"],
        ["physicalInventoryId", "is-null"],
        ["otherAssetId", "is-null"]
    ]
}
function movementQuery(userScope, p) {
    const factory = ec.entity.conditionFactory
    let query = find(DETAIL_VIEW)
    const fields = ["assetId", "productId", "lotId", "facilityId", "varianceReasonEnumId", "assetReceiptId", "shipmentId"]
    for (const field of fields) if (p[field]) query = query.condition(field, p[field])
    if (p.fromDate) query = query.condition("effectiveDate", "greater-equals", p.fromDate)
    if (p.thruDate) query = query.condition("effectiveDate", "less", p.thruDate)
    if (p.sourceType) {
        const conditions = sourceConditions[p.sourceType]
        if (!conditions) throw new Error("Unknown movement source type " + p.sourceType)
        for (const [field, operator] of conditions) query = query.condition(field, operator, null)
    }
    const orgFacilityIds = stock.facilityIds(userScope)
    if (orgFacilityIds != null)
        query = query.condition(
            factory.makeCondition(
                [
                    factory.makeCondition("facilityId", "in", orgFacilityIds),
                    factory.makeCondition("ownerPartyId", "in", userScope.organizationIds)
                ],
                "or"
            )
        )
    const facilityIds = callerFacilityIds(p)
    if (facilityIds != null) query = query.condition("facilityId", "in", facilityIds)
    return query
}
// The movement rows of a page, described: the source and its document, the correction chain and the split.
function describeMovements(details, userScope) {
    const receipts = byId(
        RECEIPT,
        "assetReceiptId",
        details.map(row => row.assetReceiptId)
    )
    const issuances = byId(
        ISSUANCE,
        "assetIssuanceId",
        details.map(row => row.assetIssuanceId)
    )
    const products = names(
        "mantle.product.Product",
        "productId",
        "productName",
        details.map(row => row.productId)
    )
    const facilities = names(
        "mantle.facility.Facility",
        "facilityId",
        "facilityName",
        details.map(row => row.facilityId)
    )
    const lots = names(
        "mantle.product.asset.Lot",
        "lotId",
        "lotNumber",
        details.map(row => row.lotId)
    )
    const reasons = names(
        "moqui.basic.Enumeration",
        "enumId",
        "description",
        details.map(row => row.varianceReasonEnumId)
    )
    const userIds = unique([
        ...Array.from(receipts.values()).map(row => row.receivedByUserId),
        ...Array.from(issuances.values()).map(row => row.issuedByUserId)
    ])
    const users = names("moqui.security.UserAccount", "userId", "username", userIds)
    const revaluations = revaluationPairs(details.flatMap(row => [row.assetId, row.otherAssetId]))
    // every ledger row of the page's receipts and issuances, oldest first: the first is the original, the later ones
    // correct it (a cancelled issuance, a receipt quantity changed by update#AssetAndReceipt)
    const chains = new Map()
    for (const [field, ids] of [
        ["assetReceiptId", unique(details.map(row => row.assetReceiptId))],
        ["assetIssuanceId", unique(details.map(row => row.assetIssuanceId))]
    ]) {
        if (!ids.length) continue
        const chainRows = Array.from(
            find(DETAIL).condition(field, "in", ids).orderBy("effectiveDate").orderBy("assetDetailId").list()
        )
        for (const row of chainRows) {
            const key = field + ":" + row[field]
            if (!chains.has(key)) chains.set(key, [])
            chains.get(key).push(row.assetDetailId)
        }
    }
    return details.map(row => {
        const receipt = row.assetReceiptId ? receipts.get(row.assetReceiptId) : null
        const issuance = row.assetIssuanceId ? issuances.get(row.assetIssuanceId) : null
        const diff = toDecimal(row.quantityOnHandDiff ?? 0)
        let sourceType = "other"
        let sourceText = row.description || "Ledger entry"
        let documentType = null
        let documentId = null
        const documentOf = record => {
            if (!record) return
            for (const [field, kind] of [
                ["workEffortId", "workEffort"],
                ["shipmentId", "shipment"],
                ["returnId", "return"],
                ["orderId", "order"]
            ])
                if (record[field]) {
                    documentType = kind
                    documentId = record[field]
                    return
                }
        }
        if (row.assetReceiptId) {
            sourceType = "receipt"
            documentOf(receipt || row)
            sourceText = "Receipt " + row.assetReceiptId
        } else if (row.assetIssuanceId) {
            sourceType = "issuance"
            documentOf(issuance || row)
            sourceText = "Issuance " + row.assetIssuanceId
        } else if (row.physicalInventoryId) {
            sourceType = "adjustment"
            documentType = "count"
            documentId = row.physicalInventoryId
            sourceText = "Adjustment " + row.physicalInventoryId
        } else if (row.otherAssetId) {
            const incoming = diff.compare(0) > 0
            const pair = incoming ? row.otherAssetId + ">" + row.assetId : row.assetId + ">" + row.otherAssetId
            sourceType = revaluations.has(pair) ? "revaluation" : "split"
            sourceText =
                (sourceType === "revaluation" ? "Revaluation split " : "Moved part ") +
                (incoming ? "from asset " : "to asset ") +
                row.otherAssetId
        } else documentOf(row)
        const documentText = documentId
            ? {workEffort: "Work effort ", shipment: "Shipment ", return: "Return ", order: "Order ", count: "Count "}[
                  documentType
              ] + documentId
            : ""
        const chainField = row.assetReceiptId ? "assetReceiptId" : row.assetIssuanceId ? "assetIssuanceId" : null
        const chain = chainField ? chains.get(chainField + ":" + row[chainField]) || [] : []
        const position = chain.indexOf(row.assetDetailId)
        const correctsDetailId = position > 0 ? chain[0] : null
        const correctionText =
            position > 0
                ? "Corrects " + (row.assetReceiptId ? "receipt " : "issuance ") + row[chainField] + " (" + position + ")"
                : chain.length > 1
                  ? "Corrected " + (chain.length - 1) + (chain.length === 2 ? " time" : " times")
                  : ""
        const userId = receipt?.receivedByUserId || issuance?.issuedByUserId || null
        const out = {
            assetDetailId: row.assetDetailId,
            effectiveDate: row.effectiveDate,
            effectiveDateText: dateText(row.effectiveDate),
            assetId: row.assetId,
            productId: row.productId,
            productName: products.get(row.productId) || row.productId || "",
            facilityId: row.facilityId,
            facilityName: facilities.get(row.facilityId) || row.facilityId || "",
            locationSeqId: row.locationSeqId,
            lotId: row.lotId,
            lotNumber: lots.get(row.lotId) || row.lotId || "",
            ownerPartyId: row.ownerPartyId,
            quantityOnHandDiff: number(row.quantityOnHandDiff),
            availableToPromiseDiff: number(row.availableToPromiseDiff),
            sourceType,
            sourceText,
            documentType,
            documentId,
            documentText,
            assetReceiptId: row.assetReceiptId,
            assetIssuanceId: row.assetIssuanceId,
            physicalInventoryId: row.physicalInventoryId,
            otherAssetId: row.otherAssetId,
            varianceReasonEnumId: row.varianceReasonEnumId,
            reasonText: reasons.get(row.varianceReasonEnumId) || "",
            userId,
            userText: users.get(userId) || "",
            correctsDetailId,
            correctionText
        }
        if (userScope.financeRead) {
            out.unitCost = number(row.unitCost)
            out.acquireCost = number(row.acquireCost)
            out.acquireCostUomId = row.acquireCostUomId
        }
        return out
    })
}
function movements(p) {
    const userScope = stock.scope()
    if (p.assetId) {
        const asset = one(ASSET, {assetId: p.assetId})
        if (!stock.assetAllowed(userScope, asset)) denied("RECORD_UNAVAILABLE", "Asset " + p.assetId + " is not available")
    }
    const count = movementQuery(userScope, p).count()
    const ordered = movementQuery(userScope, p).orderBy("-effectiveDate").orderBy("-assetDetailId")
    const paged = lib.page(ordered, p, "movementList", count, {noLimitCap})
    return Object.assign(
        {
            movementList: describeMovements(paged.rows, userScope),
            costIncluded: userScope.financeRead
        },
        Object.fromEntries(
            ["Count", "PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"].map(key => [
                "movementList" + key,
                paged["movementList" + key]
            ])
        )
    )
}

// ===== get#Traceability =====
const documentKinds = {
    workEffort: {field: "workEffortId", text: "Work effort"},
    shipment: {field: "shipmentId", text: "Shipment"},
    return: {field: "returnId", text: "Return"},
    order: {field: "orderId", text: "Order"}
}
// The document a receipt came from or an issuance went to, in order of precedence; null when it names none (a gap).
function documentKey(record) {
    for (const [kind, definition] of Object.entries(documentKinds))
        if (record[definition.field]) return kind + ":" + record[definition.field]
    return null
}

function traceability(p) {
    const userScope = stock.scope()
    const facilityIds = callerFacilityIds(p)
    const direction = p.direction || "both"
    if (!["upstream", "downstream", "both"].includes(direction)) throw new Error("Unknown trace direction " + direction)
    const maxDepth = Math.min(maxDepthLimit, Math.max(1, Number(p.maxDepth) || 5))
    const maxNodes = Math.min(maxNodesLimit, Math.max(1, Number(p.maxNodes) || 200))

    const assets = new Map()
    const assetOf = assetId => {
        if (!assets.has(assetId)) assets.set(assetId, one(ASSET, {assetId}))
        return assets.get(assetId)
    }
    const assetVisible = asset =>
        !!asset &&
        stock.assetAllowed(userScope, asset) &&
        (facilityIds == null ||
            facilityIds.includes(asset.facilityId) ||
            (!asset.facilityId && stock.ownerAllowed(userScope, asset.ownerPartyId)))

    // the roots: an asset, a lot's assets, or the assets a shipment or work effort received and issued
    const unavailable = () => denied("RECORD_UNAVAILABLE", "The trace root " + p.rootId + " is not available")
    if (!p.rootId) unavailable()
    let rootKeys = []
    const rootType = p.rootType || "asset"
    if (rootType === "asset") {
        if (!assetVisible(assetOf(p.rootId))) unavailable()
        rootKeys = ["asset:" + p.rootId]
    } else if (rootType === "lot") {
        if (!one("mantle.product.asset.Lot", {lotId: p.rootId})) unavailable()
        const lotAssets = Array.from(find(ASSET, {lotId: p.rootId}).orderBy("assetId").list())
        for (const asset of lotAssets) assets.set(asset.assetId, asset)
        rootKeys = lotAssets.filter(assetVisible).map(asset => "asset:" + asset.assetId)
        if (!rootKeys.length) unavailable()
    } else if (documentKinds[rootType]) {
        const field = documentKinds[rootType].field
        const touched = unique([
            ...Array.from(
                find(RECEIPT, {[field]: p.rootId})
                    .selectField("assetId")
                    .list()
            ).map(row => row.assetId),
            ...Array.from(
                find(ISSUANCE, {[field]: p.rootId})
                    .selectField("assetId")
                    .list()
            ).map(row => row.assetId)
        ])
        if (!touched.some(assetId => assetVisible(assetOf(assetId)))) unavailable()
        rootKeys = [rootType + ":" + p.rootId]
    } else throw new Error("Unknown trace root type " + rootType)
    // a receipt's or issuance's document, the root's first when the record names it (a subcontract receipt names its work
    // effort and its shipment), else in documentKey's order
    const docKey = record => {
        for (const rootKey of rootKeys) {
            const [kind, ...rest] = rootKey.split(":")
            if (documentKinds[kind] && record[documentKinds[kind].field] === rest.join(":")) return rootKey
        }
        return documentKey(record)
    }

    const nodes = new Map()
    const edges = new Map()
    let truncated = false
    // stock outside the scope is one restricted node, which names nothing and is not followed, however many assets it stands for
    const restrictedNode = {nodeKey: "restricted", kind: "restricted", label: "Stock outside your facilities"}
    const nodeCount = () => new Set(nodes.values()).size
    // a node by its key, with its label
    function node(key) {
        if (nodes.has(key)) return nodes.get(key)
        const [kind, ...rest] = key.split(":")
        const id = rest.join(":")
        let out
        if (kind === "asset") {
            const asset = assetOf(id)
            if (!assetVisible(asset)) out = restrictedNode
            else {
                out = {
                    nodeKey: key,
                    kind,
                    recordId: id,
                    productId: asset.productId,
                    lotId: asset.lotId,
                    serialNumber: asset.serialNumber,
                    facilityId: asset.facilityId,
                    locationSeqId: asset.locationSeqId,
                    statusId: asset.statusId,
                    quantityOnHand: number(asset.quantityOnHandTotal)
                }
                if (userScope.financeRead) {
                    out.acquireCost = number(asset.acquireCost)
                    out.acquireCostUomId = asset.acquireCostUomId
                }
            }
        } else if (kind === "unknown")
            out = {nodeKey: key, kind, label: id.startsWith("issuance:") ? "Unknown destination" : "Unknown provenance"}
        else out = {nodeKey: key, kind, recordId: id}
        nodes.set(key, out)
        return out
    }
    function edge(key, fromKey, toKey, values) {
        if (!edges.has(key)) edges.set(key, Object.assign({edgeKey: key, fromKey, toKey}, values))
        return edges.get(key)
    }
    // cost only for a user with financial read, and only of stock in their scope (an asset already read for its node)
    const costOf = assetId =>
        userScope.financeRead && assetVisible(assetOf(assetId)) ? number(assetOf(assetId).acquireCost) : undefined
    const withCost = (values, assetId) => {
        const cost = costOf(assetId)
        if (cost !== undefined) values.unitCost = cost
        return values
    }
    const receiptEdge = receipt => {
        const from = docKey(receipt) || "unknown:receipt:" + receipt.assetReceiptId
        const values = withCost(
            {
                event: "receipt",
                eventId: receipt.assetReceiptId,
                date: receipt.receivedDate,
                productId: receipt.productId,
                quantity: number(receipt.quantityAccepted)
            },
            receipt.assetId
        )
        return edge("receipt:" + receipt.assetReceiptId, from, "asset:" + receipt.assetId, values)
    }
    const issuanceEdge = issuance => {
        const to = docKey(issuance) || "unknown:issuance:" + issuance.assetIssuanceId
        const quantity = toDecimal(issuance.quantity ?? 0).subtract(issuance.quantityCancelled ?? 0)
        const values = withCost(
            {
                event: "issuance",
                eventId: issuance.assetIssuanceId,
                date: issuance.issuedDate,
                productId: issuance.productId,
                quantity: number(quantity)
            },
            issuance.assetId
        )
        return edge("issuance:" + issuance.assetIssuanceId, "asset:" + issuance.assetId, to, values)
    }
    // a split or partial move: the pair of ledger rows linked by otherAssetId, from the source asset to the new one
    const splitEdge = (detail, revaluations) => {
        const incoming = toDecimal(detail.quantityOnHandDiff ?? 0).compare(0) > 0
        const sourceId = incoming ? detail.otherAssetId : detail.assetId
        const targetId = incoming ? detail.assetId : detail.otherAssetId
        const event = revaluations.has(sourceId + ">" + targetId) ? "revaluation" : "split"
        const values = {
            event,
            eventId: detail.assetDetailId,
            date: detail.effectiveDate,
            productId: detail.productId,
            quantity: number(toDecimal(detail.quantityOnHandDiff ?? 0).abs())
        }
        if (costOf(targetId) !== undefined) values.unitCost = costOf(targetId)
        if (costOf(sourceId) !== undefined) values.previousUnitCost = costOf(sourceId)
        return edge(
            event + ":" + sourceId + ">" + targetId + ":" + lib.ms(detail.effectiveDate),
            "asset:" + sourceId,
            "asset:" + targetId,
            values
        )
    }
    // a neighbor query's rows, at most the nodes still allowed (and one more, to know the trace was cut)
    function capped(query) {
        const budget = Math.max(1, maxNodes - nodeCount())
        const list = Array.from(query.limit(budget + 1).list())
        if (list.length > budget) {
            truncated = true
            return list.slice(0, budget)
        }
        return list
    }
    // the edges of a node in one direction, each with the node at its other end
    function neighbors(key, dir) {
        const [kind, ...rest] = key.split(":")
        const id = rest.join(":")
        const found = []
        if (kind === "asset") {
            if (!assetVisible(assetOf(id))) return found
            const splits = capped(find(DETAIL, {assetId: id}).condition("otherAssetId", "is-not-null", null))
            const revaluations = revaluationPairs(splits.flatMap(row => [row.assetId, row.otherAssetId]))
            if (dir === "up") {
                const receipts = capped(find(RECEIPT, {assetId: id}).orderBy("receivedDate"))
                for (const receipt of receipts) {
                    const e = receiptEdge(receipt)
                    found.push([e, e.fromKey])
                }
                const incoming = splits.filter(row => toDecimal(row.quantityOnHandDiff ?? 0).compare(0) > 0)
                for (const detail of incoming) {
                    const e = splitEdge(detail, revaluations)
                    found.push([e, e.fromKey])
                }
                if (!receipts.length && !incoming.length) {
                    // a gap: the asset's first known movement, from Unknown provenance
                    const first = find(DETAIL, {assetId: id}).orderBy("effectiveDate").orderBy("assetDetailId").limit(1).one()
                    const e = edge("unknown:" + id, "unknown:" + id, key, {
                        event: "unknown",
                        eventId: first?.assetDetailId || null,
                        date: first?.effectiveDate || null,
                        productId: assetOf(id).productId,
                        quantity: first ? number(first.quantityOnHandDiff) : null
                    })
                    found.push([e, e.fromKey])
                }
            } else {
                for (const issuance of capped(find(ISSUANCE, {assetId: id}).orderBy("issuedDate"))) {
                    const e = issuanceEdge(issuance)
                    found.push([e, e.toKey])
                }
                for (const detail of splits.filter(row => toDecimal(row.quantityOnHandDiff ?? 0).compare(0) < 0)) {
                    const e = splitEdge(detail, revaluations)
                    found.push([e, e.toKey])
                }
                const adjustments = capped(
                    find(DETAIL, {assetId: id}).condition("physicalInventoryId", "is-not-null", null).orderBy("effectiveDate")
                )
                for (const detail of adjustments) {
                    const e = edge("adjustment:" + detail.assetDetailId, key, "count:" + detail.physicalInventoryId, {
                        event: "adjustment",
                        eventId: detail.assetDetailId,
                        date: detail.effectiveDate,
                        productId: detail.productId,
                        quantity: number(detail.quantityOnHandDiff),
                        varianceReasonEnumId: detail.varianceReasonEnumId
                    })
                    found.push([e, e.toKey])
                }
            }
        } else if (documentKinds[kind]) {
            const field = documentKinds[kind].field
            // a document's own receipts and issuances: those whose first document is this one
            if (dir === "down") {
                for (const receipt of capped(find(RECEIPT, {[field]: id}).orderBy("receivedDate")))
                    if (docKey(receipt) === key) {
                        const e = receiptEdge(receipt)
                        found.push([e, e.toKey])
                    }
            } else {
                for (const issuance of capped(find(ISSUANCE, {[field]: id}).orderBy("issuedDate")))
                    if (docKey(issuance) === key) {
                        const e = issuanceEdge(issuance)
                        found.push([e, e.fromKey])
                    }
            }
        }
        return found
    }

    // breadth first from the roots, upstream and downstream apart, to the depth and node limits; a node seen before in a
    // direction is not followed again (a cycle or a join), and the edge to it is marked
    const visited = new Set()
    const children = new Map()
    const directions = direction === "both" ? ["up", "down"] : [direction === "upstream" ? "up" : "down"]
    for (const rootKey of rootKeys) node(rootKey)
    for (const dir of directions) {
        let frontier = rootKeys.slice()
        for (const rootKey of rootKeys) visited.add(dir + "|" + rootKey)
        for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
            const next = []
            for (const key of frontier) {
                const childList = []
                for (const [e, otherKey] of neighbors(key, dir)) {
                    if (nodeCount() >= maxNodes && !nodes.has(otherKey)) {
                        truncated = true
                        edges.delete(e.edgeKey)
                        continue
                    }
                    node(otherKey)
                    const seen = visited.has(dir + "|" + otherKey)
                    if (seen) e.joined = true
                    childList.push({edgeKey: e.edgeKey, nodeKey: otherKey, followed: !seen})
                    if (!seen) {
                        visited.add(dir + "|" + otherKey)
                        next.push(otherKey)
                    }
                }
                children.set(dir + "|" + key, childList)
            }
            frontier = next
        }
        // the depth limit stopped the walk with nodes still to follow
        if (frontier.length) truncated = true
    }

    // labels and display text, reading names for every node and edge in a few queries
    const nodeList = Array.from(new Set(nodes.values()))
    const assetNodes = nodeList.filter(row => row.kind === "asset")
    const products = names("mantle.product.Product", "productId", "productName", [
        ...assetNodes.map(row => row.productId),
        ...Array.from(edges.values()).map(row => row.productId)
    ])
    const lots = names(
        "mantle.product.asset.Lot",
        "lotId",
        "lotNumber",
        assetNodes.map(row => row.lotId)
    )
    const facilities = names(
        "mantle.facility.Facility",
        "facilityId",
        "facilityName",
        assetNodes.map(row => row.facilityId)
    )
    const statuses = names(
        "moqui.basic.StatusItem",
        "statusId",
        "description",
        assetNodes.map(row => row.statusId)
    )
    const kindTexts = {
        asset: "Asset",
        restricted: "Not available",
        unknown: "Unknown",
        count: "Count",
        workEffort: "Work effort",
        shipment: "Shipment",
        return: "Return",
        order: "Order"
    }
    for (const row of nodeList) {
        row.kindText = kindTexts[row.kind] || row.kind
        if (row.kind === "asset") {
            row.label = products.get(row.productId) || row.productId || row.recordId
            row.detail = [
                row.lotId ? "Lot " + (lots.get(row.lotId) || row.lotId) : "",
                row.serialNumber ? "Serial " + row.serialNumber : "",
                [facilities.get(row.facilityId) || row.facilityId, row.locationSeqId].filter(Boolean).join(" "),
                statuses.get(row.statusId) || row.statusId || ""
            ]
                .filter(Boolean)
                .join(" · ")
        } else if (row.recordId && !row.label) row.label = row.kindText + " " + row.recordId
        if (row.detail == null) row.detail = ""
    }
    const eventTexts = {
        receipt: "Received",
        issuance: "Issued",
        split: "Moved part",
        revaluation: "Revaluation split",
        adjustment: "Adjusted",
        unknown: "First known movement"
    }
    const outKey = key => nodes.get(key)?.nodeKey || key
    // an edge with stock outside the scope at one end carries nothing of that stock (product, quantity, date, cost, reason):
    // the edges of one visible node to it are one restricted edge
    const edgeKeys = new Map()
    const edgeList = []
    const restrictedEdges = new Map()
    for (const row of edges.values()) {
        const fromKey = outKey(row.fromKey),
            toKey = outKey(row.toKey)
        if (fromKey === restrictedNode.nodeKey || toKey === restrictedNode.nodeKey) {
            const edgeKey = "restricted-edge:" + fromKey + ">" + toKey
            edgeKeys.set(row.edgeKey, edgeKey)
            if (!restrictedEdges.has(edgeKey))
                restrictedEdges.set(edgeKey, {
                    edgeKey,
                    fromKey,
                    toKey,
                    event: "restricted",
                    eventText: "Stock outside your facilities",
                    joined: false
                })
            continue
        }
        const out = Object.assign({}, row, {
            fromKey,
            toKey,
            dateText: dateText(row.date),
            eventText: eventTexts[row.event] || row.event,
            productName: products.get(row.productId) || row.productId || "",
            joined: !!row.joined
        })
        delete out.date
        edgeList.push(out)
    }
    edgeList.push(...restrictedEdges.values())

    // the tree: one row per occurrence of a node under its parent, keyed by its path (Products P3's occurrence keys), a
    // node reached again shown without its children
    const treeRows = []
    const expanded = new Set()
    const edgeByKey = new Map(edgeList.map(row => [row.edgeKey, row]))
    for (const [internalKey, restrictedKey] of edgeKeys) edgeByKey.set(internalKey, edgeByKey.get(restrictedKey))
    // a node's children, one per edge shown (the edges to the restricted node are one)
    const shownChildren = (dir, key) => {
        const seen = new Set()
        return (children.get(dir + "|" + key) || []).filter(child => {
            const shownKey = edgeByKey.get(child.edgeKey)?.edgeKey || child.edgeKey
            if (seen.has(shownKey)) return false
            seen.add(shownKey)
            return true
        })
    }
    function walk(dir, key, path, parentPath, viaEdgeKey, depth) {
        if (treeRows.length >= maxTreeRows) {
            truncated = true
            return
        }
        const item = nodes.get(key)
        const via = viaEdgeKey ? edgeByKey.get(viaEdgeKey) : null
        const repeated = expanded.has(dir + "|" + key)
        const childList = shownChildren(dir, key)
        treeRows.push({
            occurrenceKey: path,
            parentOccurrenceKey: parentPath,
            nodeKey: item.nodeKey,
            kind: item.kind,
            kindText: item.kindText,
            label: item.label || "",
            detail: item.detail || "",
            recordId: item.recordId || null,
            direction: dir === "up" ? "upstream" : "downstream",
            directionText: viaEdgeKey ? (dir === "up" ? "From" : "To") : "",
            eventText: via?.eventText || "",
            quantity: via?.quantity ?? null,
            dateText: via?.dateText || "",
            repeated: repeated && childList.length > 0,
            childCount: repeated ? 0 : childList.length,
            depth
        })
        if (repeated) return
        expanded.add(dir + "|" + key)
        childList.forEach((child, index) =>
            walk(dir, child.nodeKey, path + "/" + dir[0] + (index + 1), path, child.edgeKey, depth + 1)
        )
    }
    rootKeys.forEach((rootKey, rootIndex) => {
        const rootPath = "r" + (rootIndex + 1)
        const item = nodes.get(rootKey)
        treeRows.push({
            occurrenceKey: rootPath,
            parentOccurrenceKey: null,
            nodeKey: item.nodeKey,
            kind: item.kind,
            kindText: item.kindText,
            label: item.label || "",
            detail: item.detail || "",
            recordId: item.recordId || null,
            direction: "root",
            directionText: "",
            eventText: "",
            quantity: null,
            dateText: "",
            repeated: false,
            childCount: directions.reduce((total, dir) => total + shownChildren(dir, rootKey).length, 0),
            depth: 0
        })
        for (const dir of directions) {
            expanded.add(dir + "|" + rootKey)
            shownChildren(dir, rootKey).forEach((child, index) =>
                walk(dir, child.nodeKey, rootPath + "/" + dir[0] + (index + 1), rootPath, child.edgeKey, 1)
            )
        }
    })

    return Object.assign(
        {
            rootKeys: rootKeys.map(outKey),
            truncated,
            unknownCount: nodeList.filter(row => row.kind === "unknown").length,
            // whether some of the trace is stock outside the scope (one restricted node, whatever it stands for)
            restrictedCount: nodeList.includes(restrictedNode) ? 1 : 0,
            costIncluded: userScope.financeRead,
            treeRows
        },
        pageOf(nodeList, p, "nodeList"),
        pageOf(edgeList, p, "edgeList")
    )
}

const operations = {movements, traceability}
;({
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown traceability operation " + op)
        return operations[op](parameters)
    },
    // the revaluation-split rule (F121), which get#InventoryAtDate reads too
    revaluationPairs
})
