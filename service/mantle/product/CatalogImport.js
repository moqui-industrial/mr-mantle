// Durable imports use the catalog operation manifest. Source and store adapters belong to their native domains.
const policy = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogPolicy.js"),
    csv = () => ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js"),
    access = () => ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js")
const J = "mantle.product.ProductCatalogOperation",
    I = "mantle.product.ProductCatalogOperationItem",
    K = "mantle.product.ProductCatalogImportKind",
    find = (n, p = {}) => policy().find(n, p),
    one = (n, p) => policy().one(n, p),
    rows = (n, p = {}) => policy().rows(n, p),
    map = r => policy().map(r),
    hash = v => policy().fingerprint(v),
    call = (n, p = {}) => policy().call(n, p)
const fresh = (n, p) => {
        const r = ec.service.sync().name(n).parameters(p).disableAuthz().requireNewTransaction(true).call() || {}
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return r
    },
    own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
function granted(permission, s) {
    return permission === "PRODUCT_CATALOG_EDIT"
        ? s.edit
        : permission === "PRODUCT_CATALOG_VIEW"
          ? s.read
          : access().has(permission)
}
function kind(id, s, write = false) {
    const r = one(K, {kindId: id})
    if (!r) throw new Error("Import kind is not available")
    if (
        !granted(write ? r.permissionId : r.readPermissionId || r.permissionId, s) &&
        !(write === false && granted(r.permissionId, s))
    )
        throw new Error("This import kind needs its own " + (write ? "edit" : "read") + " authority")
    for (const n of [r.validatorService, r.storeService, r.afterStoreService, r.batchValidatorService].filter(Boolean))
        if (!/^mantle\.[A-Za-z0-9_.]+\.[A-Za-z]+#[A-Za-z0-9]+$/.test(n))
            throw new Error("Import adapters must be guarded Mantle services")
    return Object.assign(map(r), {columns: JSON.parse(r.columnsJson), fixedParameters: JSON.parse(r.fixedParametersJson || "{}")})
}
function kinds(p) {
    const s = policy().scope(p)
    return {
        kindOptions: rows(K)
            .sort((a, b) => Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0))
            .filter(r => granted(r.permissionId, s))
            .map(r => ({value: r.kindId, label: r.description}))
    }
}
function revision(request) {
    return hash({
        kindId: request.kindId,
        fileHash: request.fileHash,
        mapping: request.mapping,
        defaults: request.defaults,
        valueMappings: request.valueMappings,
        clearFields: request.clearFields,
        updateMode: request.updateMode,
        numberFormat: request.numberFormat,
        dateFormat: request.dateFormat,
        defaultFromDate: request.defaultFromDate
    })
}
function job(p, write = false, lock = false) {
    const row = p.operationKey
        ? lock
            ? find(J, {operationKey: p.operationKey}).forUpdate(true).one()
            : one(J, {operationKey: p.operationKey})
        : null
    if (!row || row.operationType !== "import") throw new Error("Catalog import is not available")
    const s = policy().scope({organizationPartyId: row.ownerPartyId})
    if (row.submittedByUserId !== ec.user.userId && !s.systemAdmin) throw new Error("Open your own catalog import")
    const request = JSON.parse(row.requestJson),
        cfg = kind(request.kindId, s, write)
    return {row: map(row), request, cfg, s}
}
function stage(p) {
    const s = policy().organization(p, "read"),
        cfg = kind(p.kindId, s, true),
        file = p.importFile
    if (!["create", "update", "upsert"].includes(p.updateMode || "upsert")) throw new Error("Choose Create, Update or Upsert")
    if (file && file.size > 2 * 1024 * 1024) throw new Error("Import files may contain at most 2 MiB")
    if (file && file.size > 0) {
        const stream = file.getInputStream()
        try {
            csv().validateUtf8(stream.readAllBytes())
        } finally {
            stream.close()
        }
    }
    const text = file && file.size > 0 ? file.getString("UTF-8") : String(p.sourceText || ""),
        delimiter = p.delimiter === "tab" ? "\t" : p.delimiter || ",",
        parsed = csv().parse(text, delimiter),
        fileHash = hash({text, delimiter}),
        operationKey =
            "import-" +
            hash({
                actor: ec.user.userId,
                organization: s.organizationPartyId,
                kindId: cfg.kindId,
                fileHash,
                salt: p.forceNew ? ec.user.randomString(20) : ""
            }).slice(0, 32)
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forNoKeyUpdate(true).one()
    if (one(J, {operationKey})) return get({operationKey})
    const request = {
        kindId: cfg.kindId,
        fileHash,
        filename: String(file ? file.getName() : p.filename || "catalog.csv")
            .split(/[\\/]/)
            .at(-1)
            .replace(/[\x00-\x1f]/g, "_"),
        headers: parsed.headers,
        delimiter,
        mapping: Object.fromEntries(parsed.headers.map(h => [h, cfg.columns.some(c => c.name === h) ? h : null])),
        defaults: {},
        valueMappings: {},
        clearFields: [],
        updateMode: p.updateMode || "upsert",
        numberFormat: {decimal: ".", group: ""},
        dateFormat: "iso",
        defaultFromDate: policy().iso(ec.user.nowTimestamp),
        sourceLocation: "dbresource://mantle/catalog-import/" + operationKey + "/source.csv"
    }
    call("create#" + J, {
        operationKey,
        operationType: "import",
        ownerPartyId: s.organizationPartyId,
        submittedByUserId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp,
        requestJson: JSON.stringify(request),
        state: "staged"
    })
    ec.resource.getLocationReference(request.sourceLocation).putText(text)
    for (let i = 0; i < parsed.rows.length; i++)
        call("create#" + I, {
            operationKey,
            itemSeqId: i + 1,
            itemKey: String(parsed.rows[i].rowNumber),
            requestJson: JSON.stringify(parsed.rows[i]),
            result: "staged"
        })
    return get({operationKey})
}
function configure(p) {
    const g = job(p, true, true)
    if (!p.mappingRevision || p.mappingRevision !== revision(g.request))
        throw new Error("Import mapping changed; reload before saving")
    const next = Object.assign({}, g.request),
        fields = new Set(g.cfg.columns.map(c => c.name)),
        names = o => Object.keys(o || {}).every(k => fields.has(k))
    for (const n of ["mapping", "defaults", "valueMappings", "clearFields", "updateMode", "numberFormat", "dateFormat"])
        if (own(p, n)) next[n] = p[n]
    if (
        !next.mapping ||
        Object.keys(next.mapping).some(h => !g.request.headers.includes(h)) ||
        Object.values(next.mapping).some(v => v && !fields.has(v))
    )
        throw new Error("Map source columns to fields of this import kind")
    const targets = Object.values(next.mapping).filter(Boolean)
    if (new Set(targets).size !== targets.length) throw new Error("Each target field may have only one source column")
    if (
        !names(next.defaults) ||
        !names(next.valueMappings) ||
        Object.values(next.valueMappings || {}).some(
            v => !v || typeof v !== "object" || Array.isArray(v) || Object.values(v).some(x => typeof x !== "string")
        )
    )
        throw new Error("Defaults and value mappings must use fields of this import kind")
    if (
        !Array.isArray(next.clearFields) ||
        next.clearFields.some(k => !["description", "comments", "pseudoId"].includes(k) || !fields.has(k))
    )
        throw new Error("Only the explicitly selected optional text fields may be cleared")
    if (
        !["create", "update", "upsert"].includes(next.updateMode) ||
        !["iso", "yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy"].includes(next.dateFormat) ||
        ![".", ","].includes(next.numberFormat?.decimal) ||
        !["", ",", ".", " "].includes(next.numberFormat?.group) ||
        next.numberFormat.group === next.numberFormat.decimal
    )
        throw new Error("Choose supported update, date and number formats")
    call("update#" + J, {
        operationKey: p.operationKey,
        requestJson: JSON.stringify(next),
        inputFingerprint: null,
        state: "mapped",
        lastError: null
    })
    for (const row of rows(I, {operationKey: p.operationKey}).filter(r => r.result !== "applied")) {
        const data = JSON.parse(row.requestJson)
        delete data.preview
        call("update#" + I, {
            operationKey: p.operationKey,
            itemSeqId: row.itemSeqId,
            requestJson: JSON.stringify(data),
            result: "staged",
            errorMessage: null
        })
    }
    return get(p)
}
function numeric(value, format) {
    let text = String(value).trim()
    if (format.group && text.includes(format.group)) {
        const escaped = format.group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            decimal = format.decimal.replace(".", "\\."),
            pattern = new RegExp("^[+-]?\\d{1,3}(?:" + escaped + "\\d{3})+(?:" + decimal + "\\d+)?$")
        if (!pattern.test(text)) throw new Error("Number grouping does not match the selected format")
        text = text.split(format.group).join("")
    }
    if (format.decimal !== ".") text = text.replace(format.decimal, ".")
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error("Number does not match the selected format")
    return String(toDecimal(text))
}
function dateValue(value, format) {
    const text = String(value).trim()
    let year,
        month,
        day,
        iso = text
    if (format === "MM/dd/yyyy" || format === "dd/MM/yyyy") {
        const m = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
        if (!m) throw new Error("Date does not match " + format)
        year = Number(m[3])
        month = Number(m[format === "MM/dd/yyyy" ? 1 : 2])
        day = Number(m[format === "MM/dd/yyyy" ? 2 : 1])
        iso = String(year).padStart(4, "0") + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0")
    } else {
        const m = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/)
        if (
            !m ||
            (format === "yyyy-MM-dd" && text.length !== 10) ||
            Number(m[4] || 0) > 23 ||
            Number(m[5] || 0) > 59 ||
            Number(m[6] || 0) > 59
        )
            throw new Error("Date does not match " + format)
        year = Number(m[1])
        month = Number(m[2])
        day = Number(m[3])
    }
    if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())
        throw new Error("Date is not a calendar date")
    const parsed = iso.length === 10 ? ec.l10n.parseTimestamp(iso, "yyyy-MM-dd") : ec.l10n.parseTimestamp(iso, null)
    if (parsed == null || !Number.isFinite(policy().ms(parsed))) throw new Error("Date is not available")
    return policy().iso(parsed)
}
function normalize(g, data) {
    if (data.sourceError) throw new Error(data.sourceError)
    const values = Object.fromEntries(
            Object.entries(g.request.defaults).filter(([k, v]) => (v !== "" && v != null) || g.request.clearFields.includes(k))
        ),
        columns = Object.fromEntries(g.cfg.columns.map(c => [c.name, c]))
    for (const [source, target] of Object.entries(g.request.mapping))
        if (target) {
            const raw = data.sourceValues[source]
            if (raw !== "" && raw != null) values[target] = raw
            else if (g.request.clearFields.includes(target)) values[target] = null
        }
    for (const [name, value] of Object.entries(values)) {
        if (!columns[name]) throw new Error("Unknown import field")
        let v = value
        if (v != null && own(g.request.valueMappings[name] || {}, String(v))) v = g.request.valueMappings[name][String(v)]
        if ((v == null || v === "") && !g.request.clearFields.includes(name)) {
            delete values[name]
            continue
        }
        if (v != null) {
            v =
                columns[name].type === "decimal"
                    ? numeric(v, g.request.numberFormat)
                    : columns[name].type === "date"
                      ? dateValue(v, g.request.dateFormat)
                      : ["description", "comments", "productName"].includes(name)
                        ? String(v)
                        : String(v).trim()
        }
        values[name] = v
    }
    for (const c of g.cfg.columns) if (c.name === "fromDate" && !values.fromDate) values.fromDate = g.request.defaultFromDate
    return Object.assign({}, values, g.cfg.fixedParameters)
}
function preview(g, data) {
    const rowParameters = normalize(g, data)
    const result = fresh(g.cfg.validatorService, {
        kindId: g.cfg.kindId,
        organizationPartyId: g.row.ownerPartyId,
        rowParameters,
        updateMode: g.request.updateMode,
        registryFingerprint: hash(map(one(K, {kindId: g.cfg.kindId})))
    })
    if (result.valid) {
        ec.service
            .getServiceDefinition(g.cfg.storeService)
            .convertValidateCleanParameters(Object.assign({}, result.normalizedParameters))
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    }
    return result
}
function validate(p) {
    const g = job(p, true, true)
    if (p.mappingRevision !== revision(g.request)) throw new Error("Import mapping changed; reload before validation")
    const seen = new Map()
    for (const row of rows(I, {operationKey: p.operationKey}).sort((a, b) => Number(a.itemSeqId) - Number(b.itemSeqId))) {
        const data = JSON.parse(row.requestJson)
        if (row.result === "applied") continue
        let checked
        try {
            checked = preview(g, data)
            if (checked.valid !== true) throw new Error((checked.errors || ["Row is not valid"]).join("; "))
            const keys = String(g.cfg.keyFields || "")
                    .split(",")
                    .filter(Boolean),
                key = JSON.stringify(keys.map(k => checked.normalizedParameters[k] ?? null))
            if (keys.length && checked.normalizedParameters[keys[0]] && seen.has(key))
                throw new Error("Repeated update key in this file (also row " + seen.get(key) + ")")
            if (keys.length) seen.set(key, data.rowNumber)
            data.preview = checked
            call("update#" + I, {
                operationKey: p.operationKey,
                itemSeqId: row.itemSeqId,
                requestJson: JSON.stringify(data),
                result: "valid",
                errorMessage: null
            })
        } catch (e) {
            ec.logger.error("Catalog import " + p.operationKey + " row " + data.rowNumber + ": " + e)
            ec.message.clearErrors()
            data.preview = {valid: false, errors: [String(e.message || e)]}
            call("update#" + I, {
                operationKey: p.operationKey,
                itemSeqId: row.itemSeqId,
                requestJson: JSON.stringify(data),
                result: "invalid",
                errorMessage: String(e.message || e)
            })
        }
    }
    if (g.cfg.batchValidatorService) {
        const eligible = rows(I, {operationKey: p.operationKey})
            .filter(r => r.result === "valid")
            .map(r => ({itemSeqId: r.itemSeqId, parameters: JSON.parse(r.requestJson).preview.normalizedParameters}))
        try {
            const batch = fresh(g.cfg.batchValidatorService, {
                kindId: g.cfg.kindId,
                organizationPartyId: g.row.ownerPartyId,
                importRows: eligible
            })
            for (const conflict of batch.conflictRows || []) {
                const r = one(I, {operationKey: p.operationKey, itemSeqId: conflict.itemSeqId})
                if (!r || r.result !== "valid") continue
                const data = JSON.parse(r.requestJson)
                data.preview.valid = false
                data.preview.errors = [conflict.errorMessage]
                call("update#" + I, {
                    operationKey: p.operationKey,
                    itemSeqId: r.itemSeqId,
                    result: "invalid",
                    errorMessage: conflict.errorMessage,
                    requestJson: JSON.stringify(data)
                })
            }
        } catch (e) {
            ec.logger.error("Catalog import " + p.operationKey + " batch validation: " + e)
            ec.message.clearErrors()
            for (const r of eligible)
                call("update#" + I, {
                    operationKey: p.operationKey,
                    itemSeqId: r.itemSeqId,
                    result: "invalid",
                    errorMessage: "Batch validation could not finish: " + String(e.message || e)
                })
        }
    }
    const inputFingerprint = hash({
        mappingRevision: revision(g.request),
        items: rows(I, {operationKey: p.operationKey})
            .sort((a, b) => Number(a.itemSeqId) - Number(b.itemSeqId))
            .map(r => ({itemSeqId: r.itemSeqId, request: JSON.parse(r.requestJson)}))
    })
    call("update#" + J, {operationKey: p.operationKey, inputFingerprint, state: "validated", lastError: null})
    return get(p)
}
function applyItem(p) {
    const g = job(p, true, true)
    if (!p.inputFingerprint || p.inputFingerprint !== g.row.inputFingerprint)
        throw new Error("Validation changed; review the import again")
    const row = find(I, {operationKey: p.operationKey, itemSeqId: p.itemSeqId}).forUpdate(true).one()
    if (!row) throw new Error("Import row is not available")
    if (row.result === "applied") return {alreadyApplied: true}
    if (row.result !== "valid") throw new Error("Only validated rows can be applied")
    const data = JSON.parse(row.requestJson),
        checked = preview(g, data)
    if (
        !checked.valid ||
        checked.sourceFingerprint !== data.preview.sourceFingerprint ||
        hash(checked.normalizedParameters) !== hash(data.preview.normalizedParameters)
    ) {
        call("update#" + I, {
            operationKey: p.operationKey,
            itemSeqId: p.itemSeqId,
            result: "stale",
            errorMessage: "Source changed; validate and review this row again"
        })
        return {stale: true}
    }
    const params = Object.assign({}, checked.normalizedParameters, {catalogOperationKey: p.operationKey}),
        out = call(g.cfg.storeService, params)
    if (g.cfg.afterStoreService)
        call(g.cfg.afterStoreService, Object.assign({}, params, out, {rowParameters: params, storeResult: out}))
    const productId = out.productId || params.productId,
        resultRecordId = out.productPriceId || productId || out.resultRecordId
    call("update#" + I, {
        operationKey: p.operationKey,
        itemSeqId: p.itemSeqId,
        result: "applied",
        resultProductId: productId,
        resultRecordId,
        resultEntityName: out.productPriceId ? "mantle.product.ProductPrice" : "mantle.product.Product",
        errorMessage: null,
        completedDate: ec.user.nowTimestamp
    })
    return {applied: true, resultProductId: productId, resultRecordId}
}
function failedItem(p) {
    const g = job(p, false, true),
        row = one(I, {operationKey: p.operationKey, itemSeqId: p.itemSeqId})
    if (row && row.result !== "applied")
        call("update#" + I, {
            operationKey: p.operationKey,
            itemSeqId: p.itemSeqId,
            result: "failed",
            errorMessage: String(p.errorMessage || "Row could not be applied").slice(0, 4000)
        })
    return {}
}
function apply(p) {
    const g = job(p, true)
    if (!p.inputFingerprint || p.inputFingerprint !== g.row.inputFingerprint)
        throw new Error("Validate and review this import before applying")
    const selected =
        p.selectedRowIds == null
            ? null
            : new Set(
                  (Array.isArray(p.selectedRowIds) ? p.selectedRowIds : [p.selectedRowIds])
                      .flatMap(v =>
                          String(v)
                              .split(/[\s,]+/)
                              .filter(Boolean)
                      )
                      .map(Number)
              )
    if (selected && [...selected].some(n => !Number.isInteger(n) || n < 1)) throw new Error("Choose valid row numbers")
    const work = rows(I, {operationKey: p.operationKey})
        .filter(r => r.result === "valid" && (!selected || selected.has(Number(r.itemSeqId))))
        .sort((a, b) => Number(a.itemSeqId) - Number(b.itemSeqId))
    let changedRows = 0
    for (const row of work)
        try {
            const out = fresh("mantle.product.ProductImportServices.apply#CatalogImportItem", {
                operationKey: p.operationKey,
                itemSeqId: row.itemSeqId,
                inputFingerprint: p.inputFingerprint
            })
            if (out.applied) changedRows++
        } catch (e) {
            ec.logger.error("Catalog import " + p.operationKey + " row " + row.itemSeqId + " apply: " + e)
            ec.message.clearErrors()
            try {
                fresh("mantle.product.ProductImportServices.record#CatalogImportFailure", {
                    operationKey: p.operationKey,
                    itemSeqId: row.itemSeqId,
                    errorMessage: String(e.message || e)
                })
            } catch (mark) {
                ec.logger.error("Catalog import " + p.operationKey + " row " + row.itemSeqId + " result: " + mark)
                ec.message.clearErrors()
            }
        }
    const result = get(p),
        state = result.appliedCount === result.rowCount ? "complete" : "partial"
    call("update#" + J, {
        operationKey: p.operationKey,
        state,
        lastError: result.errorCount ? result.errorCount + " rows need attention" : null
    })
    return Object.assign({}, result, {state, changedRows, attemptedCount: work.length})
}
function get(p) {
    const g = job(p),
        all = rows(I, {operationKey: p.operationKey}).sort((a, b) => Number(a.itemSeqId) - Number(b.itemSeqId)),
        pageSize = 50,
        pageIndex = Math.max(0, Math.min(Math.max(0, Math.ceil(all.length / pageSize) - 1), Number(p.pageIndex) || 0))
    return {
        operationKey: p.operationKey,
        kindId: g.cfg.kindId,
        kindDescription: g.cfg.description,
        organizationPartyId: g.row.ownerPartyId,
        state: g.row.state,
        lastError: g.row.lastError,
        filename: g.request.filename,
        fileHash: g.request.fileHash,
        headers: g.request.headers,
        mapping: g.request.mapping,
        defaults: g.request.defaults,
        valueMappings: g.request.valueMappings,
        clearFields: g.request.clearFields,
        updateMode: g.request.updateMode,
        numberFormat: g.request.numberFormat,
        dateFormat: g.request.dateFormat,
        columns: g.cfg.columns,
        mappingRevision: revision(g.request),
        inputFingerprint: g.row.inputFingerprint,
        rowCount: all.length,
        validCount: all.filter(r => r.result === "valid").length,
        appliedCount: all.filter(r => r.result === "applied").length,
        errorCount: all.filter(r => ["invalid", "failed", "stale"].includes(r.result)).length,
        pageIndex,
        pageSize,
        canEdit: granted(g.cfg.permissionId, g.s),
        importRows: all.slice(pageIndex * pageSize, (pageIndex + 1) * pageSize).map(r => {
            const data = JSON.parse(r.requestJson)
            return {
                itemSeqId: r.itemSeqId,
                rowNumber: data.rowNumber,
                sourceValues: data.sourceValues,
                values: data.preview?.normalizedParameters || null,
                changes: data.preview?.changes || [],
                warnings: data.preview?.warnings || [],
                result: r.result,
                errorMessage: r.errorMessage,
                resultProductId: r.resultProductId,
                resultRecordId: r.resultRecordId
            }
        })
    }
}
function report(p) {
    const g = job(p),
        headers = [...g.request.headers, "Import result", "Import error", "Target ID"],
        all = rows(I, {operationKey: p.operationKey}).sort((a, b) => Number(a.itemSeqId) - Number(b.itemSeqId))
    return {
        reportCsv: csv().csv(
            headers,
            all
                .filter(r => !p.errorsOnly || ["invalid", "failed", "stale"].includes(r.result))
                .map(r =>
                    Object.assign({}, JSON.parse(r.requestJson).sourceValues, {
                        "Import result": r.result,
                        "Import error": r.errorMessage,
                        "Target ID": r.resultRecordId
                    })
                )
        ),
        filename: p.errorsOnly ? "catalog-import-errors.csv" : "catalog-import-results.csv"
    }
}
function sample(p) {
    const s = policy().scope(p),
        cfg = kind(p.kindId, s, true)
    return {
        reportCsv: csv().csv(
            cfg.columns.map(c => c.name),
            []
        ),
        filename: cfg.kindId + "-sample.csv"
    }
}
function allowed(p) {
    try {
        job(p)
        return {recordVisible: true}
    } catch (e) {
        return {recordVisible: false}
    }
}
function execute(op, p) {
    return {kinds, stage, configure, validate, applyItem, failedItem, apply, get, report, sample, allowed}[op](p)
}
;({execute, kind, normalize, numeric, dateValue})
