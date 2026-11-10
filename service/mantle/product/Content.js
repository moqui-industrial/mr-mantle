// Typed catalog content uses the resource facade's version store, never a parallel file store.
const helper = () => ec.resource.script("component://mr-mantle/service/mantle/product/MethodPolicy.js")
const find = (n, p = {}) => helper().find(n, p),
    one = (n, p) => helper().one(n, p),
    rows = (n, p = {}) => helper().rows(n, p),
    map = r => helper().map(r),
    call = (n, p = {}) => helper().call(n, p),
    ms = v => helper().ms(v),
    pick = (p, f) => helper().pick(p, f)
const metadata = [
    "description",
    "locale",
    "productStoreId",
    "productFeatureId",
    "fromDate",
    "thruDate",
    "sequenceNum",
    "sourceProductContentId",
    "sourceProductCategoryContentId",
    "reviewedSourceRevision",
    "reviewedByUserId",
    "reviewedDate"
]
function config(p) {
    const category = p.recordKind === "category" || !!p.productCategoryContentId || !!p.productCategoryId
    return category
        ? {
              kind: "category",
              entity: "mantle.product.category.ProductCategoryContent",
              id: "productCategoryContentId",
              owner: "productCategoryId",
              master: "mantle.product.category.ProductCategory",
              type: "categoryContentTypeEnumId",
              enumType: "ProductCategoryContentType",
              source: "sourceProductCategoryContentId",
              folder: "productCategory",
              noun: "ProductCategoryContent"
          }
        : {
              kind: "product",
              entity: "mantle.product.ProductContent",
              id: "productContentId",
              owner: "productId",
              master: "mantle.product.Product",
              type: "productContentTypeEnumId",
              enumType: "ProductContentType",
              source: "sourceProductContentId",
              folder: "product",
              noun: "ProductContent"
          }
}
function access(p, edit = false) {
    const c = config(p),
        permissions = ec.resource.script("component://mr-mantle/service/mantle/product/ProductAccess.js"),
        canEdit = permissions.has("PRODUCT_CATALOG_EDIT"),
        s = call("mantle.product.ProductServices.get#CatalogOwnerScope")
    if ((!permissions.has("PRODUCT_CATALOG_VIEW") && !canEdit) || (edit && !canEdit))
        throw new Error("Catalog content " + (edit ? "edit" : "read") + " authority is required")
    const owner = p[c.owner] ? one(c.master, {[c.owner]: p[c.owner]}) : null
    if (p[c.owner] && (!owner || (!s.systemAdmin && !s.ownerPartyIds.includes(owner.ownerPartyId || "_NA_"))))
        throw new Error("Catalog content owner is not available")
    if (edit && owner && (!owner.ownerPartyId || owner.ownerPartyId === "_NA_") && !s.systemAdmin)
        throw new Error("Shared catalog content requires system administration")
    return Object.assign({}, s, {
        canEdit: canEdit && (!owner || (owner.ownerPartyId && owner.ownerPartyId !== "_NA_") || s.systemAdmin),
        config: c,
        owner
    })
}
function owned(row, c, location = row.contentLocation) {
    const value = String(location || ""),
        roots = [
            "dbresource://mantle/content",
            ec.user.getPreference("mantle.content.root"),
            ec.user.getPreference("mantle.content.large.root")
        ].filter(Boolean)
    return (
        !value.split("/").includes("..") &&
        roots.some(root => value.startsWith(String(root).replace(/\/+$/, "") + "/" + c.folder + "/" + row[c.owner] + "/"))
    )
}
function reference(row, c) {
    if (!owned(row, c)) throw new Error("Copy this resource through an authorized drive before opening or editing it")
    return ec.resource.getLocationReference(row.contentLocation)
}
function revision(row, c) {
    let resourceVersion = null
    if (owned(row, c)) {
        const ref = ec.resource.getLocationReference(row.contentLocation)
        resourceVersion = ref.exists && ref.supportsVersion() ? ref.getCurrentVersion()?.versionName : null
    }
    return helper().fingerprint({metadata: map(row), resourceVersion})
}
function get(p, edit = false, lock = false) {
    const c = config(p),
        id = p[c.id] || p.contentId,
        row = id
            ? lock
                ? find(c.entity, {[c.id]: id})
                      .forUpdate(true)
                      .one()
                : one(c.entity, {[c.id]: id})
            : null
    if (!row) throw new Error("Catalog document is not available")
    if (p[c.owner] && p[c.owner] !== row[c.owner]) throw new Error("Document belongs to another catalog record")
    const a = access(Object.assign({}, p, {[c.owner]: row[c.owner]}), edit)
    return {row: map(row), c, a}
}
function safeName(name) {
    return (
        String(name || "document.txt")
            .split(/[\\/]/)
            .at(-1)
            .replace(/[\x00-\x1f#?]/g, "_") || "document.txt"
    )
}
function retainConflict(row, c, p, currentRevision) {
    const id = "content-conflict-" + ec.user.randomString(20),
        file = p.contentFile,
        hasFile = file && file.size > 0,
        hasText = p.contentText != null,
        filename = hasFile ? safeName(file.getName()) : "submitted.txt",
        location =
            (ec.user.getPreference("mantle.content.root") || "dbresource://mantle/content") +
            "/" +
            c.folder +
            "/" +
            row[c.owner] +
            "/conflicts/" +
            id +
            "/" +
            filename
    if (hasFile) {
        const stream = file.getInputStream()
        try {
            ec.resource.getLocationReference(location).putStream(stream)
        } finally {
            stream.close()
        }
    } else if (hasText) ec.resource.getLocationReference(location).putText(String(p.contentText))
    call("create#mantle.product.ContentEditConflict", {
        contentEditConflictId: id,
        contentEntityName: c.entity,
        contentId: row[c.id],
        expectedRevision: p.expectedRevision,
        currentRevision,
        draftLocation: hasFile || hasText ? location : null,
        submittedMetadataJson: JSON.stringify(pick(p, [...metadata, c.type, "contentLocation", "filename"])),
        submittedByUserId: ec.user.userId,
        submittedDate: ec.user.nowTimestamp
    })
    return {conflict: true, contentEditConflictId: id, currentRevision, [c.id]: row[c.id], contentId: row[c.id]}
}
// Shared by both legacy update services. Legacy callers may omit the token; all new editors require it.
function update(p, category = false) {
    const c = config(Object.assign({}, p, {recordKind: category ? "category" : "product"})),
        row = map(
            find(c.entity, {[c.id]: p[c.id]})
                .forUpdate(true)
                .one()
        )
    if (!row[c.id]) throw new Error("Catalog document is not available")
    if (p[c.owner] && p[c.owner] !== row[c.owner]) throw new Error("A content record cannot move to another catalog record")
    const currentRevision = revision(row, c)
    if (p.requireRevision && !p.expectedRevision) throw new Error("Review the current document revision before saving")
    if (p.expectedRevision && p.expectedRevision !== currentRevision) return retainConflict(row, c, p, currentRevision)
    const dated = Object.assign({}, row, pick(p, ["fromDate", "thruDate"]))
    if (dated.fromDate && dated.thruDate && ms(dated.thruDate) <= ms(dated.fromDate))
        throw new Error("Content end must follow its start")
    const data = Object.assign(pick(p, [...metadata, c.type, "contentLocation"]), {[c.id]: row[c.id]}),
        file = p.contentFile,
        hasFile = file && file.size > 0
    if (hasFile && !owned(row, c)) {
        const uploaded = call("mantle.product.ProductServices.save#" + c.noun + "File", {
            [c.id]: row[c.id],
            [c.owner]: row[c.owner],
            contentFile: file,
            saveContentLocation: false
        })
        data.contentLocation = uploaded.contentLocation
    } else if (hasFile || p.contentText != null) {
        const ref = reference(row, c)
        if (hasFile) {
            const name = safeName(file.getName()),
                old = String(row.contentLocation).split("/").at(-1)
            if (name.split(".").at(-1).toLowerCase() !== old.split(".").at(-1).toLowerCase())
                throw new Error("Add a new document when changing its file format")
            const stream = file.getInputStream()
            try {
                ref.putStream(stream)
            } finally {
                stream.close()
            }
        } else ref.putText(String(p.contentText))
        delete data.contentLocation
    }
    call("update#" + c.entity, data)
    return {
        [c.id]: row[c.id],
        contentId: row[c.id],
        conflict: false,
        currentRevision: revision(one(c.entity, {[c.id]: row[c.id]}), c)
    }
}
function decorate(row, c, a) {
    const out = Object.assign(map(row), {
            recordKind: c.kind,
            contentId: row[c.id],
            recordId: row[c.owner],
            contentType: row[c.type],
            filename:
                String(row.contentLocation || "")
                    .split("/")
                    .at(-1) || "",
            managed: owned(row, c),
            expectedRevision: revision(row, c)
        }),
        type = one("moqui.basic.Enumeration", {enumId: row[c.type]})
    out.contentTypeText = type?.description || row[c.type]
    out.isText = out.managed && ec.resource.isTextFilename(out.filename)
    out.mimeType = ec.resource.contentTypeOf(out.filename)
    out.inlineAllowed = /\.(png|jpe?g|gif|webp|pdf)$/i.test(out.filename)
    out.canEdit = a.canEdit
    return out
}
function list(p) {
    const a = access(p),
        c = a.config,
        at = p.asOfDate || ec.user.nowTimestamp,
        out = []
    for (const row of rows(c.entity, p[c.owner] ? {[c.owner]: p[c.owner]} : {}))
        try {
            const scope = access(Object.assign({}, p, {[c.owner]: row[c.owner]}))
            if (
                (p.contentType && row[c.type] !== p.contentType) ||
                (p.locale && row.locale !== p.locale) ||
                (p.productStoreId && row.productStoreId !== p.productStoreId) ||
                (p.productFeatureId && row.productFeatureId !== p.productFeatureId) ||
                (!p.includeHistory && !helper().active(row, at))
            )
                continue
            const data = decorate(row, c, scope)
            if (p.filename && !data.filename.toLowerCase().includes(String(p.filename).toLowerCase())) continue
            data.inherited = false
            out.push(data)
        } catch (e) {
            ec.logger.error("Catalog content " + row[c.id] + " omitted: " + e)
        }
    if (c.kind === "product" && p.productId && p.includeInherited !== false)
        for (const link of rows("mantle.product.ProductAssoc", {
            toProductId: p.productId,
            productAssocTypeEnumId: "PatVariant"
        }).filter(r => helper().active(r, at)))
            try {
                const base = list(Object.assign({}, p, {productId: link.productId, includeInherited: false}))
                for (const row of base.contentRows)
                    if (
                        !out.some(
                            r =>
                                r.contentType === row.contentType &&
                                (r.locale || "") === (row.locale || "") &&
                                (r.productStoreId || "") === (row.productStoreId || "") &&
                                (r.productFeatureId || "") === (row.productFeatureId || "")
                        )
                    )
                        out.push(Object.assign({}, row, {inherited: true, canEdit: false}))
            } catch (e) {
                ec.logger.error("Inherited content " + link.productId + ": " + e)
            }
    return {
        contentRows: out.sort(
            (x, y) => Number(x.sequenceNum || 0) - Number(y.sequenceNum || 0) || x.contentId.localeCompare(y.contentId)
        ),
        canEdit: a.canEdit
    }
}
function detail(p) {
    const {row, c, a} = get(p),
        document = decorate(row, c, a),
        ref = document.managed ? reference(row, c) : null,
        versionRows =
            ref?.exists && ref.supportsVersion()
                ? Array.from(ref.getVersionHistory()).map(v => ({
                      versionName: v.versionName,
                      previousVersionName: v.previousVersionName,
                      versionDate: v.versionDate,
                      userId: v.userId,
                      note: v.note
                  }))
                : [],
        conflictRows = rows("mantle.product.ContentEditConflict", {contentEntityName: c.entity, contentId: row[c.id]}).map(map)
    const result = {
        document,
        contentText: document.isText ? ec.resource.getLocationText(row.contentLocation, false) : null,
        expectedRevision: document.expectedRevision,
        versionRows,
        conflictRows,
        canEdit: a.canEdit,
        diff: null
    }
    if (p.fromVersion && document.isText) {
        if (
            !versionRows.some(v => v.versionName === p.fromVersion) ||
            (p.toVersion && !versionRows.some(v => v.versionName === p.toVersion))
        )
            throw new Error("Content version is not available")
        result.diff = ref.getVersionDiff(p.fromVersion, p.toVersion || "")
    }
    return result
}
function store(p, translation = false) {
    const c = config(p),
        old = p[c.id] ? get(p, true) : null,
        a = old?.a || access(p, true)
    if (!a.owner) throw new Error("Choose a catalog record")
    const allowed = translation
            ? metadata
            : metadata.filter(
                  f =>
                      ![
                          "sourceProductContentId",
                          "sourceProductCategoryContentId",
                          "reviewedSourceRevision",
                          "reviewedByUserId",
                          "reviewedDate"
                      ].includes(f)
              ),
        data = Object.assign(
            pick(p, [
                ...allowed,
                c.id,
                c.owner,
                c.type,
                "contentText",
                "contentFile",
                "contentLocation",
                "filename",
                "expectedRevision"
            ]),
            {requireRevision: !!old}
        )
    if (typeof p.contentText === "string") data.contentText = p.contentText
    if (p.contentLocation && !owned(Object.assign({}, p, {[c.owner]: a.owner[c.owner]}), c))
        throw new Error("Copy external content through an authorized drive")
    if (!old && !data[c.type]) throw new Error("Choose a valid catalog content type")
    if (data[c.type]) {
        const type = one("moqui.basic.Enumeration", {enumId: data[c.type]})
        if (type?.enumTypeId !== c.enumType) throw new Error("Choose a valid catalog content type")
    }
    if (p.sourceDriveId || p.sourcePath) {
        const source = call("org.moqui.resource.FileServices.get#ResourceInfo", {
            driveId: p.sourceDriveId,
            path: p.sourcePath
        }).resource
        if (!source || source.isDirectory) throw new Error("Source file is not available")
        const location =
                (ec.user.getPreference("mantle.content.root") || "dbresource://mantle/content") +
                "/" +
                c.folder +
                "/" +
                a.owner[c.owner] +
                "/linked_" +
                ec.user.randomString(20) +
                "/" +
                safeName(source.name),
            stream = ec.resource.getLocationReference(source.location).openStream()
        try {
            ec.resource.getLocationReference(location).putStream(stream)
        } finally {
            if (stream) stream.close()
        }
        data.contentLocation = location
    }
    if (p.productFeatureId) {
        const feature = one("mantle.product.feature.ProductFeature", {productFeatureId: p.productFeatureId})
        if (!feature || (!a.systemAdmin && !a.ownerPartyIds.includes(feature.ownerPartyId || "_NA_")))
            throw new Error("Content feature is not available")
    }
    if (p.productStoreId) {
        const store = one("mantle.product.store.ProductStore", {productStoreId: p.productStoreId})
        if (!store || (!a.systemAdmin && !a.organizationPartyIds.includes(store.organizationPartyId)))
            throw new Error("Content store is not available")
    }
    if (p.fromDate && p.thruDate && ms(p.thruDate) <= ms(p.fromDate)) throw new Error("Content end must follow its start")
    const out = call("mantle.product.ProductServices." + (old ? "update" : "create") + "#" + c.noun, data)
    return Object.assign({}, out, {contentId: out[c.id] || p[c.id]})
}
function upload(p) {
    access(p, true)
    const results = [],
        raw = p.contentFiles,
        files = raw == null ? [] : raw.getName ? [raw] : Array.from(raw)
    for (const file of files) {
        let name = "unnamed file"
        try {
            name = safeName(file?.getName())
            if (!file || file.size <= 0) throw new Error("File is empty")
            const out =
                ec.service
                    .sync()
                    .name("mantle.product.ContentServices.store#CatalogContent")
                    .parameters(Object.assign({}, p, {contentFiles: null, contentFile: file, contentText: null}))
                    .disableAuthz()
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({
                filename: name,
                success: true,
                contentId: out.contentId || out.productContentId || out.productCategoryContentId
            })
        } catch (e) {
            ec.logger.error("Catalog upload " + name + ": " + e)
            results.push({filename: name, success: false, error: String(e.message || e)})
            ec.message.clearErrors()
        }
    }
    return {uploadResults: results}
}
function resource(p) {
    const {row, c} = get(p)
    let location = row.contentLocation
    if (p.contentEditConflictId) {
        const conflict = one("mantle.product.ContentEditConflict", {contentEditConflictId: p.contentEditConflictId})
        if (!conflict || conflict.contentEntityName !== c.entity || conflict.contentId !== row[c.id] || !conflict.draftLocation)
            throw new Error("Submitted draft is not available")
        location = conflict.draftLocation
    }
    if (!owned(row, c, location)) throw new Error("Resource is not available")
    const ref = ec.resource.getLocationReference(location)
    if (p.versionName) {
        const versions = Array.from(ref.getVersionHistory())
        if (!versions.some(v => v.versionName === p.versionName)) throw new Error("Content version is not available")
        location += "#" + p.versionName
    }
    const filename = String(location).split("#")[0].split("/").at(-1),
        mime = ec.resource.contentTypeOf(filename)
    return {contentLocation: location, filename, inlineAllowed: /\.(png|jpe?g|gif|webp|pdf)$/i.test(filename)}
}
function restore(p) {
    const {row, c} = get(p, true, true)
    if (!p.expectedRevision || revision(row, c) !== p.expectedRevision)
        throw new Error("Content changed; review its current revision before restoring")
    const ref = reference(row, c)
    if (!ref.supportsVersion() || !Array.from(ref.getVersionHistory()).some(v => v.versionName === p.versionName))
        throw new Error("Content version is not available")
    ec.resource.restoreVersion(row.contentLocation, p.versionName, "Restored catalog content version " + p.versionName)
    return {contentId: row[c.id], [c.id]: row[c.id]}
}
function translations(p) {
    // with no target language there is nothing to compare
    if (!p.targetLocale) return {translationRows: [], directLocalizationRows: []}
    const c = config(p),
        sources = list(Object.assign({}, p, {locale: p.sourceLocale || "en", includeInherited: false})).contentRows,
        result = []
    for (const source of sources) {
        const candidates = rows(c.entity, {[c.owner]: source.recordId, locale: p.targetLocale}).filter(
                r =>
                    r[c.source] === source.contentId ||
                    (!r[c.source] &&
                        r[c.type] === source.contentType &&
                        (r.productStoreId || "") === (source.productStoreId || "") &&
                        (r.productFeatureId || "") === (source.productFeatureId || ""))
            ),
            target = candidates.filter(r => helper().active(r, p.asOfDate || ec.user.nowTimestamp))[0],
            state = !target ? "Missing" : target.reviewedSourceRevision === source.expectedRevision ? "Reviewed" : "Needs review"
        if (p.missingOnly && state !== "Missing") continue
        result.push({
            recordKind: c.kind,
            recordId: source.recordId,
            contentId: source.contentId,
            contentType: source.contentType,
            contentTypeText: source.contentTypeText,
            sourceText: source.isText ? ec.resource.getLocationText(source.contentLocation, false) : "",
            sourceRevision: source.expectedRevision,
            targetContentId: target?.[c.id] || null,
            targetText:
                target && owned(target, c) && ec.resource.isTextFilename(target.contentLocation)
                    ? ec.resource.getLocationText(target.contentLocation, false)
                    : "",
            targetRevision: target ? revision(target, c) : null,
            reviewState: state,
            storageSource: c.entity
        })
    }
    const direct = []
    for (const r of rows("moqui.basic.LocalizedEntityField", {locale: p.targetLocale}))
        try {
            const allowed = {
                    "mantle.product.Product": "productId",
                    "mantle.product.category.ProductCategory": "productCategoryId",
                    "mantle.product.feature.ProductFeature": "productFeatureId"
                },
                key = allowed[r.entityName]
            if (!key) continue
            const master = one(r.entityName, {[key]: r.pkValue}),
                a = access(p)
            if (
                !master ||
                (!a.systemAdmin && !a.ownerPartyIds.includes(master.ownerPartyId || "_NA_")) ||
                (p[c.owner] && r.pkValue !== p[c.owner])
            )
                continue
            direct.push(Object.assign(map(r), {storageSource: "moqui.basic.LocalizedEntityField"}))
        } catch (e) {
            ec.logger.error("Localized field " + r.entityName + ":" + r.pkValue + ": " + e)
        }
    return {translationRows: result, directLocalizationRows: direct}
}
function translate(p) {
    const c = config(p),
        source = get(Object.assign({}, p, {[c.id]: p.sourceContentId}), true).row,
        current = revision(source, c)
    if (!p.sourceRevision || p.sourceRevision !== current) throw new Error("Translation source changed; review it again")
    if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(p.targetLocale || "") || p.targetLocale === source.locale)
        throw new Error("Choose a different valid target locale")
    const target = p.targetContentId ? get(Object.assign({}, p, {[c.id]: p.targetContentId}), true).row : null
    if (
        target &&
        (target[c.owner] !== source[c.owner] ||
            target.locale !== p.targetLocale ||
            target[c.type] !== source[c.type] ||
            (target[c.source] && target[c.source] !== source[c.id]))
    )
        throw new Error("Translation target does not match this source")
    if (
        !target &&
        rows(c.entity, {[c.owner]: source[c.owner], locale: p.targetLocale, [c.type]: source[c.type]}).some(
            r => r[c.source] === source[c.id] && helper().active(r, ec.user.nowTimestamp)
        )
    )
        throw new Error("A target translation already exists; reload it before editing")
    const data = Object.assign(pick(source, [c.owner, c.type, "productStoreId", "productFeatureId"]), {
        recordKind: c.kind,
        [c.id]: target?.[c.id],
        locale: p.targetLocale,
        contentText: p.targetText ?? "",
        expectedRevision: p.targetRevision,
        [c.source]: source[c.id]
    })
    if (p.markReviewed)
        Object.assign(data, {
            reviewedSourceRevision: current,
            reviewedByUserId: ec.user.userId,
            reviewedDate: ec.user.nowTimestamp
        })
    return store(data, true)
}
function datasheet(p) {
    const a = access(p),
        product = a.owner
    if (!product || a.config.kind !== "product") throw new Error("Choose a product")
    const esc = v =>
        String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c])
    const contents = list(Object.assign({}, p, {includeHistory: false})).contentRows
    return {
        printHtml:
            '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
            esc(product.productName) +
            "</title><style>body{font:14px sans-serif;margin:36px}pre{white-space:pre-wrap}</style></head><body><h1>" +
            esc(product.productName) +
            "</h1><p>" +
            esc(product.productId) +
            "</p><p>" +
            esc(product.description) +
            "</p>" +
            contents
                .map(
                    r =>
                        "<h2>" +
                        esc(r.contentTypeText) +
                        " · " +
                        esc(r.locale || "") +
                        "</h2>" +
                        (r.isText
                            ? "<pre>" + esc(ec.resource.getLocationText(r.contentLocation, false)) + "</pre>"
                            : "<p>" + esc(r.filename) + "</p>")
                )
                .join("") +
            "</body></html>"
    }
}
function execute(op, p) {
    p = Object.assign({}, p)
    const c = config(p)
    if (!p[c.id] && p.contentId) p[c.id] = p.contentId
    return {list, detail, store, upload, resource, restore, translations, translate, datasheet}[op](p)
}
;({execute, update, revision, config, owned, safeName, get})
