// Finance setup that XML Actions do not express well: the readiness checks, posting mappings and their clone, and
// masked method identifiers. Only explicit business fields are accepted; credentials and services are absent. The
// preference, due term and payment method services are inline XML Actions in SetupServices.xml, which read
// preferenceFields from here.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const {one, rows, find, map, call, pick, ms, hash} = lib
const C = "mantle.ledger.config.",
    PREF = C + "PartyAcctgPreference"
const preferenceFields = [
    "baseCurrencyUomId",
    "localCurrencyUomId",
    "fiscalYearStartMonth",
    "fiscalYearStartDay",
    "cogsMethodEnumId",
    "realTimeGlSummary",
    "settlementTermId",
    "invoiceSequenceEnumId",
    "invoiceIdPrefix",
    "orderSequenceEnumId",
    "orderIdPrefix",
    "glAccountCodeMask",
    "errorGlJournalId",
    "postingGuardEnabled",
    "requiredLedgerDimensionsEnabled",
    "forwardIssuanceRepostEnabled",
    "forwardReceiptRepostEnabled",
    "allowAccountingSelfApproval",
    "invoiceApprovalRequired",
    "inventoryRevaluationEnabled",
    "receiptInvoiceSelfBilledOnly",
    "returnSettlementRequired",
    "salesInvoiceFinalizedAtShip",
    "kitCostFromComponents",
    "projectCostPostingEnabled",
    "taxGatewayConfigId",
    "invoicePayGatewayConfigId",
    "invoiceDocumentTemplate",
    "paymentDocumentTemplate",
    "documentLocale",
    "documentFooter",
    "invoiceEmailTemplateId",
    "rateProviderServiceName"
]
const mappingEntity = descriptor => (descriptor[0].includes(".") ? descriptor[0] : C + descriptor[0])
const mappings = {
    assignment: [
        "mantle.ledger.account.GlAccountOrganization",
        ["glAccountId"],
        ["fromDate", "thruDate", "facilityRequired", "costCenterRequired"]
    ],
    type: ["GlAccountTypeDefault", ["glAccountTypeEnumId"], ["glAccountId"]],
    item: ["ItemTypeGlAccount", ["itemTypeEnumId", "direction"], ["glAccountId"]],
    invoice: ["InvoiceTypeTransType", ["invoiceTypeEnumId", "isPayable"], ["acctgTransTypeEnumId", "glAccountId"]],
    payment: ["PaymentTypeGlAccount", ["paymentTypeEnumId", "isPayable", "isApplied"], ["glAccountId"]],
    instrument: ["PaymentInstrumentGlAccount", ["paymentInstrumentEnumId", "isPayable"], ["glAccountId"]],
    asset: [
        "AssetTypeGlAccount",
        ["assetTypeGlAccountId"],
        [
            "assetTypeEnumId",
            "classEnumId",
            "assetId",
            "assetGlAccountId",
            "wipAssetGlAccountId",
            "receiptGlAccountId",
            "issuanceGlAccountId",
            "transferGlAccountId",
            "accDepreciationGlAccountId",
            "depreciationGlAccountId",
            "profitGlAccountId",
            "lossGlAccountId",
            "shrinkageGlAccountId",
            "foundGlAccountId",
            "scrapGlAccountId"
        ]
    ],
    financialType: ["FinancialAccountTypeGlAccount", ["finAccountTypeId"], ["glAccountId"]],
    financialReason: ["FinancialAccountReasonGlAccount", ["reasonEnumId"], ["glAccountId"]],
    variance: ["VarianceReasonGlAccount", ["varianceReasonEnumId"], ["glAccountId"]],
    product: ["ProductGlAccount", ["productId", "glAccountTypeEnumId"], ["glAccountId", "contraGlAccountId"]],
    category: ["ProductCategoryGlAccount", ["productCategoryId", "glAccountTypeEnumId"], ["glAccountId", "contraGlAccountId"]],
    account: ["GlAccountTypePartyDefault", ["partyId", "roleTypeId", "glAccountTypeEnumId"], ["glAccountId"]]
}
// What each mapping kind is called on the screens.
const mappingLabels = {
    type: "Account types",
    item: "Invoice item types",
    invoice: "Invoice types",
    payment: "Payment types",
    instrument: "Payment instruments",
    asset: "Assets",
    financialType: "Financial account types",
    financialReason: "Financial account reasons",
    variance: "Inventory variance reasons",
    product: "Products",
    category: "Product categories",
    account: "Party defaults"
}
// The readable key of a mapping row: enumeration descriptions, sides and directions in words, other ids as they are.
const keyWords = {
    direction: {I: "Incoming", O: "Outgoing", E: "Either direction"},
    isPayable: {Y: "Payable", N: "Receivable", E: "Payable or receivable"},
    isApplied: {Y: "Applied", N: "Unapplied", E: "Applied or not"}
}
function keyTexts(rows, keyFields) {
    const enumIds = rows.flatMap(row => keyFields.filter(field => field.endsWith("EnumId")).map(field => row[field]))
    const enums = enumIds.length
        ? Object.fromEntries(
              Array.from(
                  find("moqui.basic.Enumeration")
                      .condition("enumId", "in", [...new Set(enumIds.filter(Boolean))])
                      .list()
              ).map(row => [row.enumId, row.description || row.enumId])
          )
        : {}
    for (const row of rows)
        row.mappingKeyText = keyFields
            .map(field => keyWords[field]?.[row[field]] || enums[row[field]] || row[field] || "")
            .filter(Boolean)
            .join(" · ")
    return rows
}
function readiness(p) {
    const s = lib.scope(p),
        findings = []
    if (!s.organizationPartyId)
        return {
            findings: [
                {
                    code: "ORGANIZATION",
                    message: "Choose an organization to check accounting setup"
                }
            ]
        }
    const org = s.organizationPartyId
    // where the organization's accounting setup stands: not set up, being set up (a setup run not yet activated), active
    // (activated), or set up without a setup run
    const run = find("mantle.ledger.config.AccountingSetupRun", {organizationPartyId: org}).one()
    const setupStatus = run
        ? run.statusId === "AsrActivated"
            ? "active"
            : "inSetup"
        : lib.preference(org).organizationPartyId
          ? "configured"
          : "unconfigured"
    for (const [name, check] of [
        [
            "PREFERENCES",
            () => {
                const pref = lib.preference(org)
                if (!pref.baseCurrencyUomId) throw new Error("Choose a base currency")
                if (!pref.errorGlJournalId) throw new Error("Choose an error journal")
            }
        ],
        [
            "PERIODS",
            () => {
                if (!find("mantle.party.time.TimePeriod").condition("partyId", "in", lib.organizationChain(org)).count())
                    throw new Error("Generate fiscal periods")
            }
        ],
        [
            "CHART",
            () => {
                if (
                    !find("mantle.ledger.account.GlAccountOrganization")
                        .condition("organizationPartyId", "in", lib.organizationChain(org))
                        .count()
                )
                    throw new Error("Assign a chart of accounts")
            }
        ]
    ]) {
        try {
            check()
        } catch (error) {
            ec.logger.error("Accounting readiness " + name + ": " + error.message)
            findings.push({code: name, message: error.message})
        }
    }
    return {findings, setupStatus}
}
function mappingList(p) {
    const s = lib.scope(p, "admin"),
        mappingRows = [],
        missingMappings = []
    const kind = p.mappingKind || "type",
        descriptor = mappings[kind]
    if (!descriptor || !mappingLabels[kind]) throw new Error("Unknown posting mapping kind")
    // the kinds, and the key and account fields of the chosen one, for the screen's mapping form
    const kindOut = {
        mappingKind: kind,
        mappingKindOptions: Object.entries(mappingLabels).map(([key, label]) => ({key, label})),
        mappingKeyFields: descriptor[1],
        mappingFields: [...descriptor[1], ...descriptor[2]]
    }
    if (!s.organizationPartyId)
        return Object.assign(kindOut, {
            mappingRows,
            mappingRowsCount: 0,
            missingMappings,
            errorTransactions: []
        })
    const size = Math.max(1, Math.min(100, Number(p.pageSize || 25))),
        index = Math.max(0, Number(p.pageIndex || 0))
    const conditions = {organizationPartyId: s.organizationPartyId},
        entity = mappingEntity(descriptor)
    const mappingRowsCount = find(entity, conditions).count()
    for (const row of Array.from(
        find(entity, conditions)
            .orderBy(descriptor[1].join(","))
            .offset(index * size)
            .limit(size)
            .list()
    )) {
        const key = descriptor[1].map(f => row[f]).join(" / ")
        mappingRows.push(
            Object.assign(map(row), {
                mappingKind: kind,
                mappingKey: key,
                mappingToken: hash({kind, key})
            })
        )
    }
    keyTexts(mappingRows, descriptor[1])
    const selectedMapping = p.mappingToken ? mappingRows.find(row => row.mappingToken === p.mappingToken) : null
    if (p.mappingToken && !selectedMapping) throw new Error("Mapping changed; select it again")
    for (const type of rows("moqui.basic.Enumeration", {
        enumTypeId: "GlAccountType"
    })) {
        const out = call("mantle.ledger.LedgerServices.get#DefaultGlAccountByType", {
            organizationPartyId: s.organizationPartyId,
            glAccountTypeEnumId: type.enumId
        })
        if (!out.glAccountId)
            missingMappings.push({
                mappingKind: "type",
                mappingKey: type.enumId,
                description: type.description
            })
    }
    for (const item of rows("moqui.basic.Enumeration", {
        enumTypeId: "ItemType"
    })) {
        for (const direction of ["I", "O"]) {
            const out = call("mantle.ledger.InvoiceAutoPostServices.get#InvoiceItemGlAccount", {
                organizationPartyId: s.organizationPartyId,
                itemTypeEnumId: item.enumId,
                direction
            })
            if (!out.glAccountId)
                missingMappings.push({
                    mappingKind: "item",
                    mappingKey: item.enumId + " / " + direction,
                    description:
                        item.description +
                        (direction === "I" ? ", incoming" : ", outgoing") +
                        " — default without a product override",
                    itemTypeEnumId: item.enumId,
                    direction
                })
        }
    }
    const errorId = lib.preference(s.organizationPartyId).errorGlJournalId
    const errorTransactions = errorId
        ? Array.from(
              find("mantle.ledger.transaction.AcctgTrans", {
                  organizationPartyId: s.organizationPartyId,
                  glJournalId: errorId,
                  isPosted: "N"
              })
                  .limit(100)
                  .list()
          ).map(map)
        : []
    return Object.assign(kindOut, {
        mappingRows,
        mappingRowsCount,
        mappingRowsPageIndex: index,
        mappingRowsPageSize: size,
        mappingRowsPageMaxIndex: Math.max(0, Math.ceil(mappingRowsCount / size) - 1),
        mappingRowsPageRangeLow: mappingRowsCount ? index * size + 1 : 0,
        mappingRowsPageRangeHigh: Math.min(mappingRowsCount, (index + 1) * size),
        selectedMapping,
        missingMappings,
        errorTransactions
    })
}
function storeMapping(p) {
    const s = lib.organization(p, "admin"),
        why = lib.reason(p),
        descriptor = mappings[p.mappingKind]
    if (!descriptor) throw new Error("Unknown posting mapping kind")
    const entity = mappingEntity(descriptor),
        values = Object.assign(pick(p.mapping || {}, [...descriptor[1], ...descriptor[2]]), {
            organizationPartyId: s.organizationPartyId
        })
    for (const key of descriptor[1])
        if (!values[key] && !(p.mappingKind === "asset" && key === "assetTypeGlAccountId"))
            throw new Error("Mapping requires " + key)
    for (const field of [...descriptor[1], ...descriptor[2]])
        if (field.endsWith("GlAccountId") || field === "glAccountId") {
            if (values[field]) {
                if (p.mappingKind === "assignment") {
                    const account = one("mantle.ledger.account.GlAccount", {
                        glAccountId: values[field]
                    })
                    if (!account || account.disallowPosting === "Y") throw new Error("Choose a posting account")
                } else lib.account(s.organizationPartyId, values[field])
            }
        }
    if (p.mappingKind === "assignment") {
        if (values.fromDate && values.thruDate && ms(values.fromDate) >= ms(values.thruDate))
            throw new Error("Assignment end must follow start")
        for (const field of ["facilityRequired", "costCenterRequired"])
            if (values[field] != null && !["Y", "N"].includes(values[field]))
                throw new Error("Choose Enabled or Disabled for " + field)
    }
    if (p.mappingKind === "asset" && !values.assetTypeEnumId && !values.assetId)
        throw new Error("Choose an asset type or an owned asset")
    if (values.partyId) lib.counterparty(values.partyId)
    if (values.assetId && one("mantle.product.asset.Asset", {assetId: values.assetId})?.ownerPartyId !== s.organizationPartyId)
        throw new Error("Asset is outside the mapping organization")
    if (values.productId) {
        const product = one("mantle.product.Product", {
            productId: values.productId
        })
        if (!product || !["_NA_", ...lib.organizationChain(s.organizationPartyId)].includes(product.ownerPartyId))
            throw new Error("Product is outside the mapping organization")
    }
    if (values.productCategoryId) {
        const category = one("mantle.product.category.ProductCategory", {
            productCategoryId: values.productCategoryId
        })
        if (!category || !["_NA_", ...lib.organizationChain(s.organizationPartyId)].includes(category.ownerPartyId))
            throw new Error("Category is outside the mapping organization")
    }
    find("mantle.party.Party", {partyId: s.organizationPartyId}).forUpdate(true).one()
    const key = pick(values, ["organizationPartyId", ...descriptor[1]])
    const old = descriptor[1].every(f => values[f]) ? find(entity, key).forUpdate(true).one() : null
    if (old) lib.revision(old, p.lastUpdatedStamp)
    lib.audit(Object.keys(values), why)
    call((old ? "update#" : "create#") + entity, values)
    return {complete: true}
}
function clone(p) {
    const sourceAccess = lib.scope({}, "admin"),
        source = p.sourceOrganizationPartyId
    if (!source || !sourceAccess.organizationPartyIds.includes(source)) throw new Error("Source organization is not available")
    const target = lib.organization(p, "admin").organizationPartyId
    if (source === target) throw new Error("Choose different source and destination organizations")
    for (const id of [source, target].sort()) find("mantle.party.Party", {partyId: id}).forUpdate(true).one()
    const kinds = p.mappingKinds || Object.keys(mappings),
        copies = [],
        conflicts = []
    const sourcePref = one(PREF, {organizationPartyId: source}),
        targetPref = one(PREF, {organizationPartyId: target})
    if (!sourcePref) throw new Error("Source accounting preferences are unavailable")
    if (targetPref) conflicts.push({kind: "preferences", key: target})
    else
        copies.push({
            entity: PREF,
            values: Object.assign(
                pick(
                    map(sourcePref),
                    preferenceFields.filter(f => f !== "errorGlJournalId")
                ),
                {organizationPartyId: target}
            )
        })
    for (const kind of kinds) {
        const descriptor = mappings[kind]
        if (!descriptor) throw new Error("Unknown posting mapping kind")
        for (const row of rows(mappingEntity(descriptor), {
            organizationPartyId: source
        })) {
            if (kind === "asset" && row.assetId) continue
            const values = Object.assign(pick(map(row), [...descriptor[1], ...descriptor[2]]), {organizationPartyId: target})
            // A source-specific product, category or account must also be usable by the destination.
            // Name incompatible rows in the preview and leave the remaining independent mappings available.
            try {
                for (const field of descriptor[2])
                    if (field.endsWith("GlAccountId") || field === "glAccountId") {
                        if (values[field]) lib.account(target, values[field])
                    }
                const owners = ["_NA_", ...lib.organizationChain(target)]
                for (const [field, entity] of [
                    ["productId", "mantle.product.Product"],
                    ["productCategoryId", "mantle.product.category.ProductCategory"]
                ])
                    if (values[field] && !owners.includes(one(entity, {[field]: values[field]})?.ownerPartyId))
                        throw new Error("Mapping record is outside the destination organization")
            } catch (error) {
                conflicts.push({
                    kind,
                    key: descriptor[1].map(field => row[field]).join(" / "),
                    reason: error.message
                })
                continue
            }
            const old = one(mappingEntity(descriptor), pick(values, ["organizationPartyId", ...descriptor[1]]))
            if (old)
                conflicts.push({
                    kind,
                    key: descriptor[1].map(f => row[f]).join(" / ")
                })
            else {
                if (kind === "asset") delete values.assetTypeGlAccountId
                copies.push({entity: mappingEntity(descriptor), values})
            }
        }
    }
    if (
        !targetPref &&
        find("mantle.ledger.transaction.AcctgTrans", {
            organizationPartyId: target,
            isPosted: "Y"
        }).count()
    ) {
        const effective = lib.preference(target)
        if (
            ["baseCurrencyUomId", "cogsMethodEnumId", "fiscalYearStartMonth", "fiscalYearStartDay"].some(
                field => String(sourcePref[field] ?? "") !== String(effective[field] ?? "")
            )
        ) {
            if (p.apply === true)
                throw new Error("Posted history requires a migration before cloning a different accounting basis")
            conflicts.push({
                kind: "postedHistory",
                key: target,
                reason: "Accounting basis requires migration"
            })
        }
    }
    const inputFingerprint = hash({
        source: map(sourcePref),
        target: targetPref ? map(targetPref) : null,
        copies,
        conflicts
    })
    if (p.apply === true) {
        lib.reason(p)
        if (p.inputFingerprint !== inputFingerprint) throw new Error("Clone inputs changed; preview again")
        // Conflicting destination configuration is preserved; the result names every skipped key.
        for (const copy of copies) {
            if (copy.entity === PREF)
                copy.values.errorGlJournalId = call("mantle.ledger.LedgerServices.create#GlJournal", {
                    organizationPartyId: target,
                    glJournalName: "Error journal",
                    glJournalTypeEnumId: "GLJRNL_ERROR"
                }).glJournalId
            call("create#" + copy.entity, copy.values)
        }
    }
    return {
        inputFingerprint,
        conflicts,
        copyCount: copies.length,
        complete: p.apply === true
    }
}
// Masked identifiers of payment methods by id: the last four digits of a bank account or card number. Each number is
// read alone, so one that will not decrypt is named and the others go on.
function maskedIdentifiers(p) {
    const masked = {}
    for (const paymentMethodId of Array.from(p.paymentMethodIds || [])) {
        for (const [entity, field] of [
            ["BankAccount", "accountNumber"],
            ["CreditCard", "cardNumber"]
        ]) {
            try {
                const row = one("mantle.account.method." + entity, {paymentMethodId})
                if (row?.[field]) masked[paymentMethodId] = "•••• " + String(row[field]).slice(-4)
            } catch (error) {
                ec.logger.error("Masked method " + paymentMethodId + ": " + error.message)
                masked[paymentMethodId] = "Identifier unavailable"
            }
        }
    }
    return {maskedIdentifiers: masked}
}
const operations = {readiness, mappingList, storeMapping, clone, maskedIdentifiers}
;({
    mappings,
    preferenceFields,
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown accounting setup operation " + op)
        return operations[op](p)
    }
})
