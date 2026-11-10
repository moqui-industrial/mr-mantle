// Accounting's reviewed forward-cost revaluation, behind the organization's explicit flag.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CostPolicy.js"),
    costs = () => ec.resource.script("component://mr-mantle/service/mantle/product/Costs.js")
const B = "mantle.product.asset.AssetBookEvent",
    P = "mantle.product.asset.AssetRevaluationPreview",
    O = "mantle.ledger.transaction.PostingOperation",
    A = "mantle.product.asset.Asset"
const find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    rows = (n, p = {}) => policy().rows(n, p),
    call = (n, p = {}) => policy().call(n, p),
    map = r => policy().map(r),
    ms = v => policy().ms(v),
    iso = v => policy().iso(v),
    hash = v => policy().fingerprint(v)
function scope(p) {
    return policy().scope(p, "glPost")
}
function fiscal(org, date, lock = false, visited = []) {
    if (visited.includes(org)) throw new Error("Organization fiscal-period hierarchy contains a cycle")
    const day = iso(date).slice(0, 10),
        periods = rows("mantle.party.time.TimePeriodAndType", {partyId: org, periodPurposeEnumId: "Fiscal"}).filter(
            r => iso(r.fromDate).slice(0, 10) <= day && iso(r.thruDate).slice(0, 10) >= day
        )
    if (!periods.length) {
        const parent = rows("mantle.party.PartyRelationship", {
            fromPartyId: org,
            relationshipTypeEnumId: "PrtOrgRollup",
            fromRoleTypeId: "OrgInternal",
            toRoleTypeId: "OrgInternal"
        }).filter(r => policy().active(r, date))
        if (parent.length !== 1) throw new Error("No fiscal period is configured for this date")
        return fiscal(parent[0].toPartyId, date, lock, [...visited, org])
    }
    const result = []
    for (const r of periods.sort((a, b) => a.timePeriodId.localeCompare(b.timePeriodId))) {
        const current = lock ? find("mantle.party.time.TimePeriod", {timePeriodId: r.timePeriodId}).forUpdate(true).one() : r
        if (current.isClosed === "Y") throw new Error("Fiscal period " + r.timePeriodId + " is closed")
        result.push(
            policy().pick(map(current), ["timePeriodId", "partyId", "timePeriodTypeId", "fromDate", "thruDate", "isClosed"])
        )
    }
    return result
}
function account(org, type) {
    const setting = one("mantle.ledger.config.GlAccountTypeDefault", {organizationPartyId: org, glAccountTypeEnumId: type}),
        gl = setting ? one("mantle.ledger.account.GlAccount", {glAccountId: setting.glAccountId}) : null
    if (!gl || gl.disallowPosting === "Y") throw new Error("Configure a posting account for " + type + " in " + org)
    return {setting: map(setting), gl: map(gl)}
}
function calculate(p, lock = false) {
    const g = costs().get(p.productStandardCostId),
        s = scope(Object.assign({}, p, {organizationPartyId: g.estimate.organizationPartyId, productId: g.estimate.productId})),
        h = g.estimate,
        now = ec.user.nowTimestamp,
        date = p.eventDate || now,
        facilityId = p.facilityId || h.facilityId || null
    if (
        (p.organizationPartyId && p.organizationPartyId !== s.organizationPartyId) ||
        (p.productId && p.productId !== h.productId)
    )
        throw new Error("Revaluation scope does not match this estimate")
    if (facilityId) policy().facility(facilityId, s)
    if (h.facilityId && facilityId !== h.facilityId) throw new Error("A facility estimate applies only to its own facility")
    if (h.state !== "approved" || !policy().active(h, date))
        throw new Error("Choose an approved estimate effective on the posting date")
    if (!Number.isFinite(ms(date)) || ms(date) > ms(now)) throw new Error("Revaluation cannot be future-dated")
    const preference = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: s.organizationPartyId})
    if (!preference?.baseCurrencyUomId) throw new Error("Configure organization accounting preferences before revaluation")
    if (preference.inventoryRevaluationEnabled !== "Y") throw new Error("Inventory revaluation is disabled for this organization")
    const currency = preference.baseCurrencyUomId,
        digits = Number(policy().currency(currency).fractionDigits ?? 2),
        periods = fiscal(s.organizationPartyId, date, lock),
        offset = account(s.organizationPartyId, "GatInventoryRevaluation")
    const postedIds = [
        ...new Set(rows("mantle.ledger.transaction.AcctgTransEntry", {productId: h.productId}).map(r => r.acctgTransId))
    ]
    for (const acctgTransId of postedIds) {
        const transaction = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId})
        if (
            transaction?.organizationPartyId === s.organizationPartyId &&
            transaction.isPosted === "Y" &&
            ms(transaction.transactionDate) > ms(date)
        )
            throw new Error("Revaluation cannot predate the product last posted movement")
    }
    const request = {
            productStandardCostId: h.productStandardCostId,
            productId: h.productId,
            organizationPartyId: s.organizationPartyId,
            facilityId,
            eventDate: iso(date),
            changeReason: policy().reason(p)
        },
        evidence = [{estimate: map(h), revision: costs().revision(h), preference: map(preference), periods, offset}],
        bookRows = [],
        findings = []
    let total = toDecimal(0),
        quantity = toDecimal(0)
    for (const initial of rows(A, {ownerPartyId: s.organizationPartyId, productId: h.productId})
        .filter(
            r =>
                r.assetTypeEnumId === "AstTpInventory" &&
                (!facilityId || r.facilityId === facilityId) &&
                toDecimal(r.quantityOnHandTotal || 0).compare(0) !== 0
        )
        .sort((a, b) => a.assetId.localeCompare(b.assetId)))
        try {
            const asset = lock ? find(A, {assetId: initial.assetId}).forUpdate(true).one() : initial,
                qty = toDecimal(asset.quantityOnHandTotal || 0)
            if (qty.compare(0) <= 0) throw new Error("Negative on-hand stock must be resolved before revaluation")
            const laterPosted = rows("mantle.ledger.transaction.AcctgTrans", {assetId: asset.assetId, isPosted: "Y"}).some(
                r => ms(r.transactionDate) > ms(date)
            )
            if (laterPosted) throw new Error("Revaluation cannot predate the last posted asset movement")
            const mapping = call("mantle.ledger.AssetAutoPostServices.get#AssetTypeGlAccount", {
                organizationPartyId: s.organizationPartyId,
                assetTypeEnumId: asset.assetTypeEnumId,
                classEnumId: asset.classEnumId,
                assetId: asset.assetId
            }).assetTypeGlAccount
            const inventory = mapping?.assetGlAccountId
                ? {setting: mapping, gl: map(one("mantle.ledger.account.GlAccount", {glAccountId: mapping.assetGlAccountId}))}
                : account(s.organizationPartyId, "GatInventory")
            if (
                !inventory.gl.glAccountId ||
                inventory.gl.disallowPosting === "Y" ||
                inventory.gl.glAccountId === offset.gl.glAccountId
            )
                throw new Error("Configure distinct, posting-enabled inventory and revaluation accounts")
            evidence.push({assetId: asset.assetId, inventory})
            const unit = policy().one("mantle.product.Product", {productId: h.productId}).amountUomId || h.quantityUomId,
                conversion = policy().convert(1, unit, h.quantityUomId, date),
                converted = policy().convertCurrency(
                    toDecimal(h.unitCost).multiply(conversion.quantity),
                    h.priceUomId,
                    currency,
                    date
                )
            if (asset.acquireCost == null || !asset.acquireCostUomId) throw new Error("Asset has no current acquisition cost")
            const futureDetail = rows("mantle.product.asset.AssetDetail", {assetId: asset.assetId}).some(
                r => toDecimal(r.quantityOnHandDiff || 0).compare(0) !== 0 && ms(r.effectiveDate) > ms(date)
            )
            if (futureDetail) throw new Error("Revaluation cannot predate a recorded stock movement")
            const forward = policy().convertCurrency(
                    toDecimal(h.unitCost).multiply(conversion.quantity),
                    h.priceUomId,
                    asset.acquireCostUomId,
                    date
                ),
                previousUnit = toDecimal(asset.acquireCost)
            // a cost in another currency than the base changes at the rate the asset's postings use (its receipt's,
            // kept on the asset), so the issues that relieve it later clear the inventory account (impl-accounting F417)
            let delta
            if (asset.acquireCostUomId === currency) delta = {amount: forward.amount.subtract(previousUnit), source: null}
            else {
                const keptRate = ec.resource
                    .script("component://mr-mantle/service/mantle/ledger/Currencies.js")
                    .assetKeptRate(asset, currency)
                if (!keptRate)
                    throw new Error("ASSET_RATE_MISSING: The asset's cost has no kept exchange rate; post its receipt first")
                delta = {
                    amount: forward.amount.subtract(previousUnit).multiply(keptRate),
                    source: {exchangeRate: asset.exchangeRate, exchangeRateDate: asset.exchangeRateDate}
                }
            }
            const amount = delta.amount.multiply(qty).setScale(digits, "HALF_UP")
            evidence.push({
                asset: map(asset),
                costConversion: converted.source,
                forwardConversion: forward.source,
                deltaConversion: delta.source
            })
            bookRows.push({
                assetId: asset.assetId,
                productId: h.productId,
                organizationPartyId: s.organizationPartyId,
                facilityId: asset.facilityId,
                quantity: String(qty),
                quantityUomId: unit,
                previousUnitCost: String(previousUnit),
                newUnitCost: String(forward.amount),
                unitCostUomId: asset.acquireCostUomId,
                amount: String(amount),
                amountUomId: currency,
                assetGlAccountId: inventory.gl.glAccountId,
                offsetGlAccountId: offset.gl.glAccountId
            })
            total = total.add(amount)
            quantity = quantity.add(qty)
        } catch (e) {
            ec.logger.error("Revaluation asset " + initial.assetId + ": " + e)
            findings.push({recordId: initial.assetId, message: String(e.message || e)})
        }
    if (!bookRows.length && !findings.length)
        findings.push({recordId: h.productId, message: "No owned on-hand stock is available in this scope"})
    return {
        request,
        bookRows,
        findings,
        complete: findings.length === 0,
        totalAmount: String(total),
        quantity: String(quantity),
        amountUomId: currency,
        inputFingerprint: hash({request, evidence, bookRows, findings})
    }
}
function preview(p) {
    scope(p)
    const out = calculate(p),
        previewId = "reval-" + ec.user.randomString(24),
        now = ec.user.nowTimestamp
    call("create#" + P, {
        previewId,
        organizationPartyId: out.request.organizationPartyId,
        productId: out.request.productId,
        facilityId: out.request.facilityId,
        productStandardCostId: p.productStandardCostId,
        userId: ec.user.userId,
        createdDate: now,
        expiresDate: new Date(ms(now) + 1800000).toISOString(),
        requestJson: JSON.stringify(out.request),
        inputFingerprint: out.inputFingerprint,
        complete: out.complete ? "Y" : "N"
    })
    return Object.assign(out, {previewId})
}
function getPreview(p) {
    const c = one(P, {previewId: p.previewId})
    if (!c) throw new Error("Revaluation preview is not available")
    scope(c)
    if (c.userId !== ec.user.userId) throw new Error("Review your own revaluation")
    const out = calculate(JSON.parse(c.requestJson)),
        stale = out.inputFingerprint !== c.inputFingerprint || ms(c.expiresDate) < ms(ec.user.nowTimestamp)
    return Object.assign(out, {
        previewId: c.previewId,
        inputFingerprint: c.inputFingerprint,
        stale,
        complete: out.complete && !stale
    })
}
function post(p) {
    if (!p.previewId || !p.operationKey || String(p.operationKey).length > 255)
        throw new Error("A reviewed preview and operation key are required")
    let c = one(P, {previewId: p.previewId})
    if (!c) throw new Error("Revaluation preview is not available")
    scope(c)
    if (c.userId !== ec.user.userId) throw new Error("Review your own revaluation")
    // Organization serializes operation-key lookup with the sources, result facts and ledger commit.
    find("mantle.party.Party", {partyId: c.organizationPartyId}).forNoKeyUpdate(true).one()
    c = find(P, {previewId: p.previewId}).forUpdate(true).one()
    const reviewedRequest = JSON.parse(c.requestJson)
    for (const field of ["productStandardCostId", "organizationPartyId", "productId", "facilityId"])
        if (p[field] && p[field] !== reviewedRequest[field]) throw new Error("Revaluation scope changed; preview again")
    if (p.eventDate && ms(p.eventDate) !== ms(reviewedRequest.eventDate))
        throw new Error("Revaluation date changed; preview again")
    const requestHash = hash({
            previewId: p.previewId,
            inputFingerprint: p.inputFingerprint,
            changeReason: p.changeReason || JSON.parse(c.requestJson).changeReason
        }),
        operation = one(O, {operationKey: p.operationKey})
    if (operation) {
        if (
            operation.organizationPartyId !== c.organizationPartyId ||
            operation.userId !== ec.user.userId ||
            operation.requestHash !== requestHash
        )
            throw new Error("Operation key was used for a different request")
        return {acctgTransId: operation.resultId, alreadyPosted: true}
    }
    if (c.postedAcctgTransId) throw new Error("This preview was already posted with another operation key")
    if (ms(c.expiresDate) < ms(ec.user.nowTimestamp) || p.inputFingerprint !== c.inputFingerprint)
        throw new Error("Review the exact current revaluation before posting")
    const args = JSON.parse(c.requestJson)
    if (p.changeReason && p.changeReason !== args.changeReason) throw new Error("Revaluation reason changed; preview again")
    find("mantle.product.cost.ProductStandardCost", {productStandardCostId: c.productStandardCostId}).forUpdate(true).one()
    const out = calculate(args, true)
    if (out.inputFingerprint !== c.inputFingerprint) throw new Error("Revaluation inputs changed; preview again")
    if (!out.complete) throw new Error("An incomplete revaluation cannot be posted")
    if (out.bookRows.every(r => toDecimal(r.newUnitCost).compare(r.previousUnitCost) === 0))
        throw new Error("The reviewed revaluation has no forward cost change")
    call("create#" + O, {
        operationKey: p.operationKey,
        operationType: "inventory-revaluation",
        organizationPartyId: c.organizationPartyId,
        userId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestHash,
        previewId: p.previewId,
        previewFingerprint: c.inputFingerprint,
        status: "posting"
    })
    const forwardCosts = ec.resource.script("component://mr-mantle/service/mantle/ledger/ForwardInventoryCosts.js")
    for (const row of out.bookRows) {
        if (toDecimal(row.newUnitCost).compare(row.previousUnitCost) === 0) continue
        const source = one(A, {assetId: row.assetId}),
            target = forwardCosts.split(source, args.eventDate)
        row.sourceAssetId = target.sourceAssetId
        row.assetId = target.assetId
        forwardCosts.apply(row.assetId, row.newUnitCost, args.changeReason)
    }
    const transaction = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
            organizationPartyId: c.organizationPartyId,
            acctgTransTypeEnumId: "AttInventoryRevaluation",
            transactionDate: args.eventDate,
            amountUomId: out.amountUomId,
            description: args.changeReason
        }),
        acctgTransId = transaction.acctgTransId
    for (const row of out.bookRows) {
        if (toDecimal(row.newUnitCost).compare(row.previousUnitCost) === 0) continue
        for (const [account, flag] of [
            [row.assetGlAccountId, "D"],
            [row.offsetGlAccountId, "C"]
        ])
            call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                acctgTransId,
                glAccountId: account,
                debitCreditFlag: flag,
                amount: row.amount,
                assetId: row.assetId,
                productId: row.productId,
                description: args.changeReason
            })
    }
    call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId})
    if (one("mantle.ledger.transaction.AcctgTrans", {acctgTransId})?.isPosted !== "Y")
        throw new Error("Revaluation did not post to the ledger; no book events were committed")
    const eventIds = []
    for (const row of out.bookRows) {
        if (toDecimal(row.newUnitCost).compare(row.previousUnitCost) === 0) continue
        const event = call(
            "create#" + B,
            Object.assign({}, row, {
                eventTypeEnumId: "AbeInventoryRevaluation",
                eventDate: args.eventDate,
                productStandardCostId: c.productStandardCostId,
                acctgTransId,
                operationKey: p.operationKey,
                postedByUserId: ec.user.userId,
                postedDate: ec.user.nowTimestamp,
                changeReason: args.changeReason
            })
        )
        eventIds.push(event.assetBookEventId)
    }
    call("update#" + P, {previewId: c.previewId, postedAcctgTransId: acctgTransId})
    call("update#" + O, {
        operationKey: p.operationKey,
        status: "posted",
        resultEntityName: "mantle.ledger.transaction.AcctgTrans",
        resultId: acctgTransId,
        completedDate: ec.user.nowTimestamp
    })
    return {acctgTransId, assetBookEventIds: eventIds, alreadyPosted: false}
}
function context(p) {
    const a = policy().capabilities(),
        out = {
            bookAccess: a,
            bookMessage: a.glPost ? "" : "Accounting GL authority is required.",
            bookRows: [],
            findings: [],
            facilityOptions: [],
            complete: false,
            operationKey: p.operationKey || "reval-" + ec.user.randomString(24)
        }
    if (!a.glPost) return out
    const g = costs().get(p.productStandardCostId),
        h = g.estimate
    scope(h)
    if (p.productId && p.productId !== h.productId) throw new Error("Revaluation estimate does not match this product")
    const preference = one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: h.organizationPartyId})
    out.revaluationEnabled = preference?.inventoryRevaluationEnabled === "Y"
    if (!out.revaluationEnabled)
        out.bookMessage = "Inventory revaluation is disabled. Enable it in Accounting configuration before previewing."
    Object.assign(out, {
        standardCost: h,
        productId: h.productId,
        organizationPartyId: h.organizationPartyId,
        facilityId: p.facilityId || h.facilityId || null,
        facilityOptions: rows("mantle.facility.Facility", {ownerPartyId: h.organizationPartyId}).map(r => ({
            value: r.facilityId,
            label: r.facilityName || r.facilityId
        }))
    })
    if (p.previewId) {
        const c = one(P, {previewId: p.previewId})
        if (!c || c.productStandardCostId !== h.productStandardCostId)
            throw new Error("Revaluation preview does not match this estimate")
        if (c.postedAcctgTransId) {
            out.request = JSON.parse(c.requestJson)
            out.bookRows = rows(B, {acctgTransId: c.postedAcctgTransId}).map(map)
            out.quantity = String(out.bookRows.reduce((n, r) => n.add(r.quantity), toDecimal(0)))
            out.totalAmount = String(out.bookRows.reduce((n, r) => n.add(r.amount), toDecimal(0)))
            out.amountUomId = out.bookRows[0]?.amountUomId
            out.acctgTransId = c.postedAcctgTransId
            out.posted = true
            out.complete = true
            out.stale = false
            out.previewId = c.previewId
            out.ledgerRows = rows("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: c.postedAcctgTransId}).map(map)
        } else Object.assign(out, getPreview(p))
        out.changeReason = out.request.changeReason
        out.eventDate = iso(out.request.eventDate)
        out.eventDateText = ec.l10n.format(new Date(ms(out.request.eventDate)), "yyyy-MM-dd HH:mm:ss")
    }
    return out
}

function execute(op, p) {
    return {preview, getPreview, post, context}[op](p)
}
;({execute, calculate, fiscal})
