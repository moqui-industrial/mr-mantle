// Maintenance costs (IronStone Maintenance design §3 WorkCosts, §8 MaintenanceCostReport, §9's approval threshold, "Charging a
// project"; review Y2; MT-08's labor price, MT-09, MT-11; impl-maintenance P11 and §4): mantle.work.MaintenanceReportServices
// get#MaintenanceCosts, the Approve gate's cost half (the threshold is two of MaintenancePolicy's policyFields, stored by
// MaintenanceSettingsServices store#MaintenancePolicy)
// (MaintenanceWork.js) and Projects' money (ProjectServices get#ProjectMoneySummary).
//
// - Answered only to MAINTENANCE_COST_VIEW, over the work orders the cost reader reads (MaintenanceAccess.js and
//   MaintenanceWork.js' scoped query); nothing else here answers an amount, and no person's pay rate is ever read.
// - Parts: each issuance of the work order's tree once (a step's not added again at the root), at its asset's acquireCost,
//   less each return naming it (AssetReceipt.sourceAssetIssuanceId) at the returned asset's cost; the posting state is the
//   issuance's or receipt's AcctgTrans. The issuance's own cost centre and project.
// - Labor: each finished TimeEntry of the tree once. Approved hours (the entry's timesheet TmshApproved) are priced at the
//   costing rate mantle.humanres.RateServices.get#CostingRate answers for the entry's position class (its own, else the
//   technician's at the date), its work type and the work's organization (People P10: the purpose RaprCost, the employer's row
//   before a shared one), never TimeEntry.vendorHourRate or a RaprVendor rate; unapproved hours and hours with no costing rate
//   are apart, as hours with no amount. An entry takes the cost centre and project of its work order: TimeEntry gains no field.
// - Outside service: each service line of a purchase order linked to the work (AssetMaintenanceOrderItem on its primary
//   AssetMaintenance, or sourced from one of its purchase requests, as MaintenancePurchases.js reads them) once: what was billed
//   (OrderItemBilling of an invoice not cancelled) at the bill's amount, and what was accepted (accept#ServiceItem's
//   ServiceAcceptance) beyond what was billed at the order's unit price, so an estimate and its bill count once; what is ordered
//   and neither accepted nor billed is pending, not cost.
// - Amounts are grouped by currency, never added across currencies, and by project where a work order or an issuance names one.
// - The approval threshold's cost half (impl-maintenance §4): the policy's estimated-cost threshold, compared only where set,
//   against an estimate computed when asked and never stored: each open planned part (WorkEffortProduct WeptConsume of the root
//   and its steps) at its estimatedQuantity times the product's approved standard cost for the organization (the rule of
//   mantle.product.CostServices.get#ApprovedStandardCost, read without its product-cost permission: a planner asks nothing of
//   it), plus the estimated hours (the steps' when any has one, else the root's, as treeHours) at the costing rate of the work
//   type and the assigned technician's class (the highest of several). A part with no approved cost, hours with no rate or no
//   one assigned, or an amount in another currency leaves the estimate unknown, and unknown is over the threshold. Outside
//   service is not in it (Purchasing approves its request and order). The planner is told only that a supervisor approves.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const work = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceWork.js")
const standardCosts = () => ec.resource.script("component://mr-mantle/service/mantle/product/Costs.js")
const {find, one, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const ORDER_VIEW = "mantle.work.maintenance.MaintenanceWorkOrderDetail"
const LINE = "mantle.work.effort.WorkEffortProduct"
const PARTY = "mantle.work.effort.WorkEffortParty"
const ISSUANCE = "mantle.product.issuance.AssetIssuance"
const RECEIPT = "mantle.product.receipt.AssetReceipt"
const ASSET = "mantle.product.asset.Asset"
const PRODUCT = "mantle.product.Product"
const TIME = "mantle.work.time.TimeEntry"
const SHEET = "mantle.work.time.Timesheet"
const TRANS = "mantle.ledger.transaction.AcctgTrans"
const LINK = "mantle.product.maintenance.AssetMaintenanceOrderItem"
const REQUEST = "mantle.request.Request"
const REQUEST_WORK = "mantle.request.RequestWorkEffort"
const ITEM_ORDER = "mantle.request.RequestItemOrder"
const HEADER = "mantle.order.OrderHeader"
const PART = "mantle.order.OrderPart"
const ITEM = "mantle.order.OrderItem"
const ACCEPTANCE = "mantle.order.purchase.ServiceAcceptance"
const BILLING = "mantle.order.OrderItemBilling"
const INVOICE = "mantle.account.invoice.Invoice"

const reportLimit = 2000
const sourceLimit = 5000
const chunk = 500
const deadOrderStatuses = ["OrderCancelled", "OrderRejected"]
const components = ["parts", "labor", "outside"]

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const dec = value => toDecimal(value == null || value === "" ? 0 : value)
const zero = () => toDecimal(0)
const ids = list => Array.from(new Set(list.filter(Boolean)))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const qty = value => (value == null ? "" : dec(value).compare(0) === 0 ? "0" : String(dec(value).toNumber()))
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const cash = (amount, currencyUomId) =>
    amount == null ? "" : currencyUomId ? ec.l10n.formatCurrency(lib.money(amount, currencyUomId), currencyUomId) : qty(amount)
// rows of an entity whose field is in a list, read in chunks
function rowsIn(entity, field, values, extra) {
    const out = []
    const list = ids(values)
    for (let i = 0; i < list.length; i += chunk) {
        let query = find(entity).condition(field, "in", list.slice(i, i + chunk))
        if (extra) query = extra(query)
        for (const row of query.list()) out.push(row)
    }
    return out
}
const byId = (rowsList, field) => Object.fromEntries(rowsList.map(row => [row[field], row]))
const inPeriod = (value, p) =>
    (p.fromDate == null || (value != null && ms(value) >= ms(p.fromDate))) &&
    (p.thruDate == null || (value != null && ms(value) < ms(p.thruDate)))

// ===== currencies and rates =====
const currencies = new Map()
// An organization's base currency (its accounting preference), null when it keeps none.
function baseCurrency(organizationPartyId) {
    if (!organizationPartyId) return null
    if (!currencies.has(organizationPartyId))
        currencies.set(
            organizationPartyId,
            call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
                ?.baseCurrencyUomId || null
        )
    return currencies.get(organizationPartyId)
}
// The costing rate of a person's hour at a date (get#CostingRate: the class given or the person's, the work type, the work's
// organization's rows before the shared ones), or null when no row applies. Never the person's pay.
function costingRate(fields) {
    const found = call("mantle.humanres.RateServices.get#CostingRate", {
        emplPositionClassId: fields.emplPositionClassId || null,
        workTypeEnumId: fields.workTypeEnumId || null,
        partyId: fields.partyId || null,
        organizationPartyId: fields.organizationPartyId || null,
        onDate: fields.onDate || ec.user.nowTimestamp
    })
    if (!found.priced || found.rateAmount == null) return null
    // a rate of another period than the hour is not an hour's price
    if (found.timePeriodUomId && found.timePeriodUomId !== "TF_hr") return null
    return {
        rate: dec(found.rateAmount),
        currencyUomId: found.rateCurrencyUomId || null,
        emplPositionClassId: found.emplPositionClassId || null
    }
}
const classTitle = classId =>
    classId ? one("mantle.humanres.position.EmplPositionClass", {emplPositionClassId: classId})?.title || classId : ""

// ===== the estimate (the Approve gate's cost half) =====
const openNow = row =>
    (row.fromDate == null || ms(row.fromDate) <= ms(ec.user.nowTimestamp)) &&
    (row.thruDate == null || ms(row.thruDate) > ms(ec.user.nowTimestamp))
function assigneesOf(workEffortId) {
    if (!workEffortId) return []
    return ids(
        Array.from(
            find(PARTY, {workEffortId, roleTypeId: "Assignee"})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .condition(
                    ec.entity.conditionFactory.makeCondition("statusId", "not-in", ["WeptDeclined", "WeptUnassigned"], true)
                )
                .list()
        ).map(row => row.partyId)
    )
}
// The estimated cost of a work order in a currency: {known, amount, parts, labor, currencyUomId, unknownList}. rootId may be
// null for work not made yet (create's ad hoc work: no parts, no one assigned, the hours given).
function estimateOf(organizationPartyId, rootId, hours, currencyUomId) {
    const currency = currencyUomId || baseCurrency(organizationPartyId)
    const unknownList = []
    let parts = zero()
    let labor = zero()
    if (!currency) unknownList.push("The organization keeps no currency")
    const root = rootId ? one(WORK, {workEffortId: rootId}) : null
    const steps = rootId
        ? Array.from(find(WORK, {rootWorkEffortId: rootId}).list()).filter(row => row.workEffortId !== rootId)
        : []
    // the planned parts at the approved standard cost
    const tree = rootId ? [rootId].concat(steps.map(row => row.workEffortId)) : []
    const lines = tree.length
        ? rowsIn(LINE, "workEffortId", tree, query => query.condition("typeEnumId", "WeptConsume")).filter(openNow)
        : []
    for (const line of lines) {
        const productName = one(PRODUCT, {productId: line.productId})?.productName || line.productId
        const cost = standardCosts().effective(
            line.productId,
            organizationPartyId,
            ec.user.nowTimestamp,
            line.sourceFacilityId || null
        )
        if (!cost || cost.unitCost == null) {
            unknownList.push(productName + " has no approved standard cost")
            continue
        }
        if (cost.priceUomId && currency && cost.priceUomId !== currency) {
            unknownList.push(productName + "'s standard cost is in " + cost.priceUomId)
            continue
        }
        if (line.quantityUomId && cost.quantityUomId && line.quantityUomId !== cost.quantityUomId) {
            unknownList.push(productName + " is planned in another unit than its standard cost")
            continue
        }
        parts = parts.add(dec(line.estimatedQuantity).multiply(dec(cost.unitCost)))
    }
    // the estimated hours at the costing rate of the work type and the assigned technician's class
    const rootAssignees = assigneesOf(rootId)
    const nodes = steps.filter(row => row.estimatedWorkTime != null)
    const priced = nodes.length
        ? nodes.map(row => ({node: row, hours: dec(row.estimatedWorkTime), assignees: assigneesOf(row.workEffortId)}))
        : [{node: root, hours: root ? dec(root.estimatedWorkTime) : dec(hours), assignees: rootAssignees}]
    for (const entry of priced) {
        if (entry.hours.compare(0) <= 0) continue
        const people = entry.assignees.length ? entry.assignees : rootAssignees
        if (!people.length) {
            unknownList.push("Estimated hours with no one assigned")
            continue
        }
        let best = null
        for (const partyId of people) {
            const rate = costingRate({
                partyId,
                workTypeEnumId: entry.node?.workTypeEnumId || root?.workTypeEnumId || null,
                organizationPartyId
            })
            if (!rate) {
                best = null
                unknownList.push("Estimated hours with no costing rate")
                break
            }
            if (rate.currencyUomId && currency && rate.currencyUomId !== currency) {
                best = null
                unknownList.push("A costing rate in " + rate.currencyUomId)
                break
            }
            if (!best || rate.rate.compare(best) > 0) best = rate.rate
        }
        if (best) labor = labor.add(entry.hours.multiply(best))
    }
    const known = unknownList.length === 0
    return {
        known,
        currencyUomId: currency,
        parts: known ? parts : null,
        labor: known ? labor : null,
        amount: known ? parts.add(labor) : null,
        unknownList
    }
}
// Within the policy's cost threshold: always where none is set; else an estimate that is known and no more than it.
function withinCostThreshold(policy, organizationPartyId, rootId, hours) {
    if (policy?.approvalThresholdCost == null) return true
    const estimate = estimateOf(organizationPartyId, rootId, hours, policy.approvalThresholdCurrencyUomId || null)
    return estimate.known && estimate.amount.compare(dec(policy.approvalThresholdCost)) <= 0
}

// ===== the sources =====
// The cost sources of work orders (roots: [{workEffortId, ownerPartyId, workEffortName, costCenterId, projectWorkEffortId,
// assetMaintenanceId, statusId}]) in a period: parts, labor and outside service, each once, with their amounts by currency.
// options.projectWorkEffortId keeps only what carries that project (an issuance's own, else its work order's).
function sourcesOf(roots, p, options = {}) {
    const rootsById = byId(roots, "workEffortId")
    const rootIds = roots.map(row => row.workEffortId)
    const nodes = rowsIn(WORK, "rootWorkEffortId", rootIds).filter(row => !rootsById[row.workEffortId])
    const nodeRoot = Object.fromEntries(
        rootIds.map(id => [id, id]).concat(nodes.map(row => [row.workEffortId, row.rootWorkEffortId]))
    )
    const nodeNames = Object.fromEntries(nodes.map(row => [row.workEffortId, row.workEffortName || row.workEffortId]))
    const treeIds = rootIds.concat(nodes.map(row => row.workEffortId))
    const stepName = id => (rootsById[id] ? "" : nodeNames[id] || id)
    const currencyOf = rootId => baseCurrency(rootsById[rootId]?.ownerPartyId)
    const wanted = component => !p.component || p.component === component
    const projectWanted = projectId => !options.projectWorkEffortId || projectId === options.projectWorkEffortId
    const sources = []
    const add = row => {
        if (p.currencyUomId && row.currencyUomId && row.currencyUomId !== p.currencyUomId) return
        sources.push(row)
    }

    // parts: each issuance and each return naming it, at the asset's cost
    if (wanted("parts") && treeIds.length) {
        const issuances = rowsIn(ISSUANCE, "workEffortId", treeIds)
        const receipts = rowsIn(
            RECEIPT,
            "sourceAssetIssuanceId",
            issuances.map(row => row.assetIssuanceId)
        )
        const assets = byId(
            rowsIn(ASSET, "assetId", issuances.map(row => row.assetId).concat(receipts.map(row => row.assetId))),
            "assetId"
        )
        const products = byId(
            rowsIn(
                PRODUCT,
                "productId",
                issuances.map(row => row.productId)
            ),
            "productId"
        )
        const postedIssues = postedBy(
            "assetIssuanceId",
            issuances.map(row => row.assetIssuanceId)
        )
        const postedReceipts = postedBy(
            "assetReceiptId",
            receipts.map(row => row.assetReceiptId)
        )
        const issuanceById = byId(issuances, "assetIssuanceId")
        const valueOf = (quantity, asset) => (asset?.acquireCost == null ? null : dec(quantity).multiply(dec(asset.acquireCost)))
        for (const row of issuances) {
            const rootId = nodeRoot[row.workEffortId]
            const projectId = row.projectWorkEffortId || null
            if (!projectWanted(projectId) || !inPeriod(row.issuedDate, p)) continue
            const asset = assets[row.assetId]
            const amount = valueOf(row.quantity, asset)
            add({
                component: "parts",
                sourceType: "issue",
                sourceTypeText: "Part issued",
                sourceId: row.assetIssuanceId,
                workEffortId: rootId,
                stepName: stepName(row.workEffortId),
                date: row.issuedDate,
                description: products[row.productId]?.productName || row.productId,
                quantity: dec(row.quantity),
                amount,
                currencyUomId: amount == null ? null : asset.acquireCostUomId || currencyOf(rootId),
                state: amount == null ? "unpriced" : "priced",
                postingText: postedIssues[row.assetIssuanceId] || "Not posted",
                costCenterId: row.costCenterId || null,
                projectWorkEffortId: projectId
            })
        }
        for (const row of receipts) {
            const issuance = issuanceById[row.sourceAssetIssuanceId]
            const rootId = nodeRoot[issuance.workEffortId]
            const projectId = issuance.projectWorkEffortId || null
            if (!projectWanted(projectId) || !inPeriod(row.receivedDate, p)) continue
            const asset = assets[row.assetId] || assets[issuance.assetId]
            const amount = valueOf(row.quantityAccepted, asset)
            add({
                component: "parts",
                sourceType: "return",
                sourceTypeText: "Part returned",
                sourceId: row.assetReceiptId,
                workEffortId: rootId,
                stepName: stepName(issuance.workEffortId),
                date: row.receivedDate,
                description: products[issuance.productId]?.productName || issuance.productId,
                quantity: dec(row.quantityAccepted).negate(),
                amount: amount == null ? null : amount.negate(),
                currencyUomId: amount == null ? null : asset.acquireCostUomId || currencyOf(rootId),
                state: amount == null ? "unpriced" : "priced",
                postingText: postedReceipts[row.assetReceiptId] || "Not posted",
                costCenterId: issuance.costCenterId || null,
                projectWorkEffortId: projectId
            })
        }
    }

    // labor: each finished entry once; approved hours at the costing rate, the rest apart
    if (wanted("labor") && treeIds.length) {
        // a running timer (no end and no hours) is not yet time
        const entries = rowsIn(TIME, "workEffortId", treeIds).filter(row => row.thruDate != null || row.hours != null)
        const sheets = byId(
            rowsIn(
                SHEET,
                "timesheetId",
                entries.map(row => row.timesheetId)
            ),
            "timesheetId"
        )
        const names = lib.partyNames(entries.map(row => row.partyId))
        for (const row of entries) {
            const rootId = nodeRoot[row.workEffortId]
            const order = rootsById[rootId]
            const projectId = order?.projectWorkEffortId || null
            if (!projectWanted(projectId) || !inPeriod(row.fromDate, p)) continue
            const hours =
                row.hours != null
                    ? dec(row.hours)
                    : toDecimal(Math.round(((ms(row.thruDate) - ms(row.fromDate)) / 3600000) * 100) / 100).subtract(
                          dec(row.breakHours)
                      )
            const approved = sheets[row.timesheetId]?.statusId === "TmshApproved"
            const rate = approved
                ? costingRate({
                      emplPositionClassId: row.emplPositionClassId || null,
                      workTypeEnumId: row.workTypeEnumId || null,
                      partyId: row.partyId,
                      organizationPartyId: order?.ownerPartyId || null,
                      onDate: row.fromDate
                  })
                : null
            const currency = rate ? rate.currencyUomId || currencyOf(rootId) : null
            add({
                component: "labor",
                sourceType: "time",
                sourceTypeText: "Time",
                sourceId: row.timeEntryId,
                workEffortId: rootId,
                stepName: stepName(row.workEffortId),
                date: row.fromDate,
                description: [names[row.partyId] || row.partyId, enumText(row.workTypeEnumId)].filter(Boolean).join(" · "),
                quantity: hours,
                hours,
                rateText: rate ? cash(rate.rate, currency) + "/h · " + (classTitle(rate.emplPositionClassId) || "any class") : "",
                amount: rate ? hours.multiply(rate.rate) : null,
                currencyUomId: currency,
                state: !approved ? "unapproved" : rate ? "priced" : "unpriced",
                postingText: approved ? "Approved" : "Not approved",
                costCenterId: order?.costCenterId || null,
                projectWorkEffortId: projectId
            })
        }
    }

    // outside service: each service line of the work once, from its bill, else its acceptance; the rest is pending
    if (wanted("outside") && rootIds.length) for (const row of outsideOf(roots, p, rootsById, projectWanted)) add(row)

    return sources
}
// The posting state of sources by a field of AcctgTrans: "Posted" or "Not posted" (in the error journal).
function postedBy(field, values) {
    const found = {}
    for (const row of rowsIn(TRANS, field, values)) {
        const id = row[field]
        if (row.isPosted === "Y") found[id] = "Posted"
        else if (!found[id]) found[id] = "Not posted"
    }
    return found
}
// The purchase order lines of the work orders (MaintenancePurchases.js' rule, read for many at once): linked to the primary
// AssetMaintenance, or sourced from one of the work's purchase requests; purchase lines (an internal customer, an outside
// vendor) only.
function lineKeysOf(roots) {
    const keys = new Map()
    const add = (orderId, orderItemSeqId, rootId) => keys.set(orderId + ":" + orderItemSeqId, {orderId, orderItemSeqId, rootId})
    const byMaintenance = Object.fromEntries(
        roots.filter(row => row.assetMaintenanceId).map(row => [row.assetMaintenanceId, row.workEffortId])
    )
    for (const row of rowsIn(LINK, "assetMaintenanceId", Object.keys(byMaintenance)))
        add(row.orderId, row.orderItemSeqId, byMaintenance[row.assetMaintenanceId])
    const links = rowsIn(
        REQUEST_WORK,
        "workEffortId",
        roots.map(row => row.workEffortId)
    )
    const purchaseIds = new Set(
        rowsIn(
            REQUEST,
            "requestId",
            links.map(row => row.requestId),
            query => query.condition("requestTypeEnumId", "RqtPurchase")
        ).map(row => row.requestId)
    )
    const requestRoot = Object.fromEntries(
        links.filter(row => purchaseIds.has(row.requestId)).map(row => [row.requestId, row.workEffortId])
    )
    for (const row of rowsIn(ITEM_ORDER, "requestId", Object.keys(requestRoot)))
        if (row.orderId && row.orderItemSeqId && !keys.has(row.orderId + ":" + row.orderItemSeqId))
            add(row.orderId, row.orderItemSeqId, requestRoot[row.requestId])
    const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    return Array.from(keys.values()).filter(key => {
        const item = one(ITEM, {orderId: key.orderId, orderItemSeqId: key.orderItemSeqId})
        const part = item ? one(PART, {orderId: item.orderId, orderPartSeqId: item.orderPartSeqId}) : null
        return !!part && isInternal(part.customerPartyId) && !isInternal(part.vendorPartyId)
    })
}
function outsideOf(roots, p, rootsById, projectWanted) {
    const out = []
    for (const key of lineKeysOf(roots)) {
        const order = rootsById[key.rootId]
        const projectId = order?.projectWorkEffortId || null
        if (!projectWanted(projectId)) continue
        const item = one(ITEM, {orderId: key.orderId, orderItemSeqId: key.orderItemSeqId})
        const header = one(HEADER, {orderId: key.orderId})
        if (!item || !header || deadOrderStatuses.includes(header.statusId)) continue
        const product = item.productId ? one(PRODUCT, {productId: item.productId}) : null
        // goods are counted when issued, as parts
        if (product && product.productTypeEnumId !== "PtService") continue
        const description = item.itemDescription || product?.productName || key.orderId
        const ordered = dec(item.quantity).subtract(dec(item.quantityCancelled))
        const unit = dec(item.unitAmount)
        const base = {
            component: "outside",
            workEffortId: key.rootId,
            stepName: "",
            costCenterId: order?.costCenterId || null,
            projectWorkEffortId: projectId,
            orderId: key.orderId,
            orderItemSeqId: key.orderItemSeqId
        }
        // the bills of the line, each at its own amount and currency
        let billedQuantity = zero()
        for (const billing of Array.from(find(BILLING, {orderId: key.orderId, orderItemSeqId: key.orderItemSeqId}).list())) {
            const invoice = one(INVOICE, {invoiceId: billing.invoiceId})
            if (!invoice || invoice.statusId === "InvoiceCancelled") continue
            const quantity = billing.quantity == null ? dec(1) : dec(billing.quantity)
            billedQuantity = billedQuantity.add(quantity)
            if (!inPeriod(invoice.invoiceDate, p)) continue
            out.push(
                Object.assign({}, base, {
                    sourceType: "bill",
                    sourceTypeText: "Supplier bill",
                    sourceId: billing.invoiceId + ":" + (billing.invoiceItemSeqId || ""),
                    date: invoice.invoiceDate,
                    description,
                    quantity,
                    amount: quantity.multiply(dec(billing.amount)),
                    currencyUomId: invoice.currencyUomId || header.currencyUomId || null,
                    state: "priced",
                    postingText: statusText(invoice.statusId)
                })
            )
        }
        // what was accepted beyond the bills, at the order's price
        const acceptances = Array.from(
            find(ACCEPTANCE, {orderId: key.orderId, orderItemSeqId: key.orderItemSeqId}).orderBy("-acceptedDate").list()
        )
        const accepted = acceptances.reduce((total, row) => total.add(dec(row.acceptedQuantity)), zero())
        const unbilled = accepted.subtract(billedQuantity)
        if (unbilled.compare(0) > 0 && inPeriod(acceptances[0]?.acceptedDate, p))
            out.push(
                Object.assign({}, base, {
                    sourceType: "acceptance",
                    sourceTypeText: "Service accepted",
                    sourceId: acceptances.map(row => row.serviceAcceptanceId).join(", "),
                    date: acceptances[0]?.acceptedDate || null,
                    description,
                    quantity: unbilled,
                    amount: unbilled.multiply(unit),
                    currencyUomId: header.currencyUomId || null,
                    state: "priced",
                    postingText: "Not billed"
                })
            )
        // ordered and neither accepted nor billed: pending, not cost
        const done = accepted.compare(billedQuantity) > 0 ? accepted : billedQuantity
        const open = ordered.subtract(done)
        if (open.compare(0) > 0 && inPeriod(header.entryDate || header.orderDate || null, p))
            out.push(
                Object.assign({}, base, {
                    sourceType: "order",
                    sourceTypeText: "Ordered, not accepted",
                    sourceId: key.orderId + ":" + key.orderItemSeqId,
                    date: header.entryDate || header.orderDate || null,
                    description,
                    quantity: open,
                    amount: open.multiply(unit),
                    currencyUomId: header.currencyUomId || null,
                    state: "pending",
                    postingText: statusText(header.statusId)
                })
            )
    }
    return out
}

// ===== totals =====
// Priced amounts by currency (never added across currencies), the pending outside service, and the hours apart.
function totalsOf(sources) {
    const totals = new Map()
    const totalFor = currencyUomId => {
        if (!totals.has(currencyUomId))
            totals.set(currencyUomId, {
                currencyUomId,
                parts: zero(),
                labor: zero(),
                outside: zero(),
                total: zero(),
                pending: zero()
            })
        return totals.get(currencyUomId)
    }
    let unapprovedHours = zero()
    let unpricedHours = zero()
    let unpricedParts = 0
    for (const row of sources) {
        if (row.state === "unapproved") unapprovedHours = unapprovedHours.add(row.hours)
        else if (row.state === "unpriced" && row.component === "labor") unpricedHours = unpricedHours.add(row.hours)
        else if (row.state === "unpriced") unpricedParts++
        else if (row.state === "pending") {
            const total = totalFor(row.currencyUomId)
            total.pending = total.pending.add(row.amount)
        } else if (row.amount != null) {
            const total = totalFor(row.currencyUomId)
            total[row.component] = total[row.component].add(row.amount)
            total.total = total.total.add(row.amount)
        }
    }
    const totalList = Array.from(totals.values())
        .sort((a, b) => String(a.currencyUomId).localeCompare(String(b.currencyUomId)))
        .map(row =>
            Object.assign(row, {
                partsText: cash(row.parts, row.currencyUomId),
                laborText: cash(row.labor, row.currencyUomId),
                outsideText: cash(row.outside, row.currencyUomId),
                totalText: cash(row.total, row.currencyUomId),
                pendingText: row.pending.compare(0) === 0 ? "" : cash(row.pending, row.currencyUomId)
            })
        )
    return {totalList, unapprovedHours, unpricedHours, unpricedParts}
}
// Priced amounts by project and currency, where a source carries a project.
function projectsOf(sources) {
    const groups = new Map()
    for (const row of sources) {
        if (!row.projectWorkEffortId || row.amount == null || row.state !== "priced") continue
        const key = row.projectWorkEffortId + "|" + row.currencyUomId
        if (!groups.has(key))
            groups.set(key, {projectWorkEffortId: row.projectWorkEffortId, currencyUomId: row.currencyUomId, total: zero()})
        const group = groups.get(key)
        group.total = group.total.add(row.amount)
    }
    const names = byId(
        rowsIn(
            WORK,
            "workEffortId",
            Array.from(groups.values()).map(row => row.projectWorkEffortId)
        ),
        "workEffortId"
    )
    return Array.from(groups.values()).map(row =>
        Object.assign(row, {
            projectName: names[row.projectWorkEffortId]?.workEffortName || row.projectWorkEffortId,
            totalText: cash(row.total, row.currencyUomId)
        })
    )
}
// A source as the screens and the CSV show it.
function displayOf(row, workNames) {
    return Object.assign({}, row, {
        workEffortName: workNames[row.workEffortId] || row.workEffortId,
        dateText: dateText(row.date),
        quantityText: qty(row.quantity),
        amountText: row.amount == null ? "" : cash(row.amount, row.currencyUomId),
        stateText:
            {priced: "", unpriced: "No costing rate", unapproved: "Not approved", pending: "Pending"}[row.state] ?? row.state
    })
}

// ===== get#MaintenanceCosts =====
function signedIn() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to read maintenance costs")
}
function costScope() {
    signedIn()
    const userScope = maintenanceAccess.scope()
    if (!userScope.capabilities.costView)
        denied("PERMISSION_DENIED", "Maintenance costs are the cost reader's (MAINTENANCE_COST_VIEW)")
    if (!userScope.capabilities.workRead) denied("PERMISSION_DENIED", "Maintenance work view is required")
    return userScope
}
const rootFields =
    "workEffortId,workEffortName,ownerPartyId,statusId,costCenterId,projectWorkEffortId,assetMaintenanceId,assetId,facilityId"
function costs(p) {
    const userScope = costScope()
    const options = {
        fromDate: p.fromDate || null,
        thruDate: p.thruDate || null,
        currencyUomId: text(p.currencyUomId),
        component: components.includes(text(p.component)) ? text(p.component) : null
    }
    let roots
    let capped = false
    let estimate = null
    const workEffortId = text(p.workEffortId)
    if (workEffortId) {
        const found = maintenanceAccess.requireWork(userScope, workEffortId)
        const row = Array.from(find(ORDER_VIEW, {workEffortId: found.rootWorkEffortId}).list())[0]
        if (!row || row.isTemplate === "Y") denied("RECORD_UNAVAILABLE", "Work order " + workEffortId + " is not available")
        roots = [row]
        const policy = work().policyOf(found.organizationPartyId)
        const hours = work().treeHours(found.rootWorkEffortId)
        estimate = estimateOf(found.organizationPartyId, found.rootWorkEffortId, hours, policy.approvalThresholdCurrencyUomId)
        estimate = Object.assign(estimate, {
            hoursText: hours == null ? "" : qty(hours),
            partsText: estimate.known ? cash(estimate.parts, estimate.currencyUomId) : "",
            laborText: estimate.known ? cash(estimate.labor, estimate.currencyUomId) : "",
            amountText: estimate.known ? cash(estimate.amount, estimate.currencyUomId) : ""
        })
    } else {
        const organizationPartyId = text(p.organizationPartyId)
        if (organizationPartyId) maintenanceAccess.requireOrganization(userScope, organizationPartyId)
        let query = work().scopedQuery(userScope, {
            organizationPartyId,
            facilityId: p.facilityId,
            assetId: p.assetId,
            teamPartyId: p.teamPartyId,
            maintenanceKindEnumId: p.maintenanceKindEnumId,
            statusId: "all"
        })
        if (text(p.projectWorkEffortId)) query = query.condition("projectWorkEffortId", text(p.projectWorkEffortId))
        roots = Array.from(
            query
                .selectField(rootFields)
                .orderBy("workEffortId")
                .limit(reportLimit + 1)
                .list()
        )
        capped = roots.length > reportLimit
        if (capped) roots = roots.slice(0, reportLimit)
    }
    const sources = sourcesOf(roots, options)
    const workNames = Object.fromEntries(roots.map(row => [row.workEffortId, row.workEffortName || row.workEffortId]))
    const totals = totalsOf(sources)
    const sorted = sources.sort(
        (a, b) =>
            String(a.workEffortId).localeCompare(String(b.workEffortId)) ||
            components.indexOf(a.component) - components.indexOf(b.component) ||
            (a.date == null ? 0 : ms(a.date)) - (b.date == null ? 0 : ms(b.date))
    )
    return {
        costs: {
            asOf: ec.user.nowTimestamp,
            asOfText: dateText(ec.user.nowTimestamp),
            workOrderCount: roots.length,
            capped,
            totalList: totals.totalList,
            unapprovedHours: totals.unapprovedHours,
            unapprovedHoursText: qty(totals.unapprovedHours),
            unpricedHours: totals.unpricedHours,
            unpricedHoursText: qty(totals.unpricedHours),
            unpricedParts: totals.unpricedParts,
            projectList: projectsOf(sources),
            currencies: ids(sources.map(row => row.currencyUomId)).sort(),
            sourceList: sorted.slice(0, sourceLimit).map(row => displayOf(row, workNames)),
            sourcesCapped: sorted.length > sourceLimit,
            estimate
        }
    }
}

// ===== Projects' money (owner contract) =====
// The maintenance work charged to a project (a work order naming it, or an issuance carrying it) with its cost by currency,
// for get#ProjectMoneySummary, which checks the money reader and the project first: per work order its total by currency and
// the hours not priced, and the totals by currency; never a source, a component, a rate or a person (a work order's labor alone
// would be one technician's hours at their class's rate).
function projectCosts(projectWorkEffortId) {
    if (!projectWorkEffortId || !ec.entity.isEntityDefined(ORDER)) return {workList: [], totalList: []}
    const charged = Array.from(find(ORDER, {projectWorkEffortId}).selectField("workEffortId").list()).map(row => row.workEffortId)
    const issued = Array.from(find(ISSUANCE, {projectWorkEffortId}).selectField("workEffortId").list()).map(row => {
        const node = one(WORK, {workEffortId: row.workEffortId})
        return node?.rootWorkEffortId || row.workEffortId
    })
    const rootIds = ids(charged.concat(issued))
    const roots = rootIds.length ? rowsIn(ORDER_VIEW, "workEffortId", rootIds).filter(row => row.isTemplate !== "Y") : []
    if (!roots.length) return {workList: [], totalList: []}
    const sources = sourcesOf(roots, {}, {projectWorkEffortId})
    // the total of each currency alone (P11 review R3)
    const totalsOnly = totalList =>
        totalList.map(row => ({currencyUomId: row.currencyUomId, total: row.total, totalText: row.totalText}))
    const workList = roots.map(root => {
        const own = sources.filter(row => row.workEffortId === root.workEffortId)
        const totals = totalsOf(own)
        return {
            workEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            statusText: statusText(root.statusId),
            totalList: totalsOnly(totals.totalList),
            unpricedHours: totals.unpricedHours.add(totals.unapprovedHours)
        }
    })
    return {workList, totalList: totalsOnly(totalsOf(sources).totalList)}
}

const operations = {costs}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance cost operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js's Approve gate and create, and ProjectServices' money, never a service's parameters
    withinCostThreshold,
    estimateOf,
    projectCosts
})
