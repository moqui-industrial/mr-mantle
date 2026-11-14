// The opportunity import (mantle.sales.OpportunityServices validate#OpportunityImportRow, apply#OpportunityImportRow and
// find#OpportunityImportScopes; IronStone Sales design §3 OpportunityImport, §16; impl-sales P6, F24, F44): the row services of the
// framework's import target `opportunities` (data/SalesWorkspaceData.xml), called by org.moqui.admin.DataTransferServices for each
// row of a staged file, as the importer.
//
// A row is one lead or opportunity of the batch's organization (its scope), kept by its source system and row key
// (SalesOpportunity.importSourceKey: one deal of the organization a key), or naming a deal by its ID. A row whose key or ID names a
// deal already there is a match: under the batch's duplicate strategy "skip" (the default) it is skipped and changes nothing, under
// "update" it changes that deal; any other row makes a new deal. The writes are Sales' own guarded services, as the importer:
// create#Opportunity, update#Opportunity, move#Opportunity, store#OpportunityParty (a new owner) and qualify#Lead (a lead matched by a
// row of an opportunity with its account), so a row meets every rule a person's entry meets: the account and contact of the scope,
// a stage of the pipeline the organization uses, an owner who works for it and the team rule, an offered source, a currency. An
// unknown or unavailable currency, organization, party or stage is the row's error, named; no account is made (a row names an
// existing account or none).
//
// The importer holds SALES_IMPORT and SALES_OPPORTUNITY_EDIT (the registration asks those with SALES_TEAM_MANAGE, all required, and
// no ADMIN_* permission: impl-sales §4, F44) and the organization is in their sales scope. Each row's apply carries the framework's
// operation key: a repeat under it answers the first result (a PostingOperation of the row's key), never a second deal.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const settings = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesSettings.js")
const {find, one, denied} = lib

const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const service = "mantle.sales.OpportunityServices."
const types = {lead: "SotLead", opportunity: "SotOpportunity"}
const operationType = "SalesOpportunityImport"
// the registered fields a row may give
const fields = [
    "externalSource",
    "externalKey",
    "salesOpportunityId",
    "typeEnumId",
    "opportunityName",
    "description",
    "accountPartyId",
    "contactPartyId",
    "salesPipelineId",
    "opportunityStageId",
    "ownerPartyId",
    "teamPartyId",
    "estimatedAmount",
    "currencyUomId",
    "estimatedProbability",
    "estimatedCloseDate",
    "dataSourceId",
    "nextStep"
]
// the facts a matched deal's update changes (update#Opportunity), when the row gives them
const factFields = [
    "opportunityName",
    "description",
    "nextStep",
    "accountPartyId",
    "estimatedAmount",
    "currencyUomId",
    "estimatedProbability",
    "estimatedCloseDate",
    "dataSourceId"
]
const text = value => String(value ?? "").trim()
const mapOf = value => (value?.getMap ? value.getMap() : Object.assign({}, value || {}))
const refusal = message => String(message ?? "").replace(/^(Error: )?[A-Z][A-Z0-9_]+: /, "")
const codeOf = error => lib.reasonCode(error) || /\b([A-Z][A-Z0-9_]{3,}):/.exec(String(error?.message || error))?.[1] || null

// The importer: a holder of SALES_IMPORT and SALES_OPPORTUNITY_EDIT, importing into an organization of their sales scope.
function importer(scopeKey) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to import leads and opportunities")
    const userScope = salesAccess.scope()
    const caps = userScope.capabilities
    if (!caps.import || !caps.opportunityEdit)
        denied("PERMISSION_DENIED", "Importing leads and opportunities needs SALES_IMPORT and SALES_OPPORTUNITY_EDIT")
    const organizationPartyId = text(scopeKey)
    if (!organizationPartyId) throw new Error("Choose the organization the deals are for")
    if (!salesAccess.isInternal(organizationPartyId))
        denied("ORGANIZATION_DENIED", "Organization " + organizationPartyId + " is not available")
    salesAccess.requireOrganization(userScope, organizationPartyId)
    return {userScope, organizationPartyId}
}
function organizationName(partyId) {
    return one("mantle.party.Organization", {partyId})?.organizationName || partyId
}
// The stored key of a row: the source system and the row key (the key alone with no source).
function sourceKeyOf(values) {
    const key = text(values.externalKey)
    if (!key) return null
    const source = text(values.externalSource)
    return ((source ? source + " / " : "") + key).substring(0, 255)
}
function strategyOf(batchOptions) {
    return text(mapOf(batchOptions).duplicateStrategy) === "update" ? "update" : "skip"
}
// The row's values: the registered fields given, trimmed; a row naming another organization is refused whole.
function rowValues(p, organizationPartyId) {
    const values = mapOf(p.rowValues)
    const rowOrganization = text(values.organizationPartyId)
    if (rowOrganization && rowOrganization !== organizationPartyId)
        throw new Error(
            "This import is for " + organizationName(organizationPartyId) + ": import another organization's deals apart"
        )
    const normalized = {}
    for (const field of fields) if (text(values[field])) normalized[field] = text(values[field])
    return normalized
}
// The type a row asks: lead or opportunity (the words or the ids), an opportunity when it says none.
function typeOf(value) {
    const given = text(value).toLowerCase()
    if (!given || given === "opportunity" || given === "sotopportunity" || given === "deal") return types.opportunity
    if (given === "lead" || given === "sotlead") return types.lead
    return null
}
// The deal a key names in the organization (one at most); another organization's deal with the same key is neither found nor named.
function keyedOf(sourceKey, organizationPartyId) {
    if (!sourceKey) return null
    const found = Array.from(
        find(OPPORTUNITY, {organizationPartyId, importSourceKey: sourceKey}).selectField("salesOpportunityId").list()
    ).map(row => row.salesOpportunityId)
    if (found.length > 1) throw new Error("Source key " + sourceKey + " names more than one deal")
    return found[0] || null
}
// The deal a row names, or null for a new one: by its ID (one the importer sees, of the organization), else by its key; an ID and a
// key naming two deals, and a deal kept under another key, are refused.
function existingOf(userScope, values, organizationPartyId) {
    const sourceKey = sourceKeyOf(values)
    const keyedId = keyedOf(sourceKey, organizationPartyId)
    const named = text(values.salesOpportunityId) || null
    if (named && keyedId && named !== keyedId)
        throw new Error("Source key " + sourceKey + " is deal " + keyedId + ", not " + named)
    const salesOpportunityId = named || keyedId
    if (!salesOpportunityId) return null
    const found = salesAccess.opportunityOf(userScope, salesOpportunityId)
    if (!found || found.organizationPartyId !== organizationPartyId)
        throw new Error(
            "Deal " + (named ? salesOpportunityId : "of source key " + sourceKey) + " is not available in this organization"
        )
    const deal = found.opportunity
    if (named && sourceKey && deal.importSourceKey && deal.importSourceKey !== sourceKey)
        throw new Error("Deal " + named + " is source key " + deal.importSourceKey + ", not " + sourceKey)
    return deal
}
// The stage a row names in the pipeline: by its ID or its name (ignoring case), of the pipeline given or the organization's default.
function stageOf(organizationPartyId, values, existing) {
    const salesPipelineId = values.salesPipelineId || existing?.salesPipelineId || null
    const pipeline = salesPipelineId
        ? one("mantle.sales.opportunity.SalesPipeline", {salesPipelineId})
        : settings.defaultPipeline(organizationPartyId)
    if (
        salesPipelineId &&
        (!pipeline ||
            !settings.inEffect(pipeline) ||
            (pipeline.organizationPartyId && pipeline.organizationPartyId !== organizationPartyId))
    )
        throw new Error("Pipeline " + salesPipelineId + " is not one " + organizationName(organizationPartyId) + " uses")
    if (!values.opportunityStageId) return {pipeline, stage: null}
    if (!pipeline) throw new Error(organizationName(organizationPartyId) + " has no pipeline; Sales settings add one")
    const wanted = values.opportunityStageId.toLowerCase()
    const stage = settings
        .stagesOf(pipeline.salesPipelineId)
        .find(row => row.opportunityStageId.toLowerCase() === wanted || text(row.description).toLowerCase() === wanted)
    if (!stage)
        throw new Error(
            "Stage " +
                values.opportunityStageId +
                " is not a current stage of " +
                (pipeline.pipelineName || pipeline.salesPipelineId)
        )
    return {pipeline, stage}
}
// What a row would do, changing nothing; each error named. Shared by the validation and the apply (which checks the current state
// again before it writes).
function plan(p) {
    const {userScope, organizationPartyId} = importer(p.scopeKey)
    const values = rowValues(p, organizationPartyId)
    const strategy = strategyOf(p.batchOptions)
    const errors = []
    if (!values.externalKey && !values.salesOpportunityId) errors.push("Give the row's source key or the deal's ID")
    let existing = null
    try {
        existing = existingOf(userScope, values, organizationPartyId)
    } catch (error) {
        errors.push(refusal(error.message))
    }
    const typeEnumId = values.typeEnumId ? typeOf(values.typeEnumId) : existing ? existing.typeEnumId : types.opportunity
    if (!typeEnumId) errors.push("Type " + values.typeEnumId + " is not lead or opportunity")
    if (!existing && !values.opportunityName && !errors.length) errors.push("Give the new deal's name")
    let stage = null
    let pipeline = null
    try {
        ;({pipeline, stage} = stageOf(organizationPartyId, values, existing))
    } catch (error) {
        errors.push(refusal(error.message))
    }
    if (values.currencyUomId) {
        const uom = one("moqui.basic.Uom", {uomId: values.currencyUomId})
        if (!uom || uom.uomTypeEnumId !== "UT_CURRENCY_MEASURE") errors.push("Currency " + values.currencyUomId + " is not known")
    }
    if (values.accountPartyId) {
        const account = salesAccess.accountOf(userScope, values.accountPartyId)
        if (!account || (account.organizationPartyId && account.organizationPartyId !== organizationPartyId))
            errors.push("Account " + values.accountPartyId + " is not an account of " + organizationName(organizationPartyId))
    }
    if (values.contactPartyId) {
        const person = salesAccess.visibleParty(userScope, values.contactPartyId)
        if (!person || person.partyTypeEnumId !== "PtyPerson" || salesAccess.isInternal(values.contactPartyId))
            errors.push("Contact " + values.contactPartyId + " is not a person you may see")
    }
    if (values.ownerPartyId && !settings.worksFor(values.ownerPartyId, organizationPartyId))
        errors.push("Owner " + values.ownerPartyId + " does not work for " + organizationName(organizationPartyId))
    if (values.teamPartyId) {
        const team = settings.teamRow(values.teamPartyId)
        if (!team || team.organizationPartyId !== organizationPartyId || !settings.inEffect(team.relationship))
            errors.push("Team " + values.teamPartyId + " is not a current team of " + organizationName(organizationPartyId))
    }
    if (
        values.dataSourceId &&
        !settings.sourcesOffered(organizationPartyId).some(row => row.dataSourceId === values.dataSourceId)
    )
        errors.push("Lead source " + values.dataSourceId + " is not offered to " + organizationName(organizationPartyId))
    for (const [field, label] of [
        ["estimatedAmount", "The amount"],
        ["estimatedProbability", "The probability"]
    ])
        if (values[field] && !/^\d+(\.\d+)?$/.test(values[field])) errors.push(label + " " + values[field] + " is not a number")
    if (values.estimatedProbability && Number(values.estimatedProbability) > 100) errors.push("A probability is from 0 to 100")
    if (values.estimatedCloseDate && !/^\d{4}-\d{2}-\d{2}$/.test(values.estimatedCloseDate))
        errors.push("Give the expected close as a date (yyyy-MM-dd)")
    if (existing && existing.statusId && existing.statusId !== "SalesOppOpen" && strategy === "update")
        errors.push("Deal " + existing.salesOpportunityId + " is closed; reopen it in Sales, not by import")
    if (existing && typeEnumId === types.lead && existing.typeEnumId === types.opportunity)
        errors.push("Deal " + existing.salesOpportunityId + " is an opportunity already")
    if (
        existing &&
        typeEnumId === types.opportunity &&
        existing.typeEnumId === types.lead &&
        !values.accountPartyId &&
        !existing.accountPartyId
    )
        errors.push("Give the account to qualify lead " + existing.salesOpportunityId + " as an opportunity")
    return {userScope, organizationPartyId, values, strategy, existing, typeEnumId, pipeline, stage, errors}
}
// The PostingOperation of a row's operation key (the framework's key is longer than an operation key, so it is hashed).
function operationOf(operationKey) {
    const key = text(operationKey)
    return key
        ? "soi-" +
              String(lib.hash(key))
                  .replace(/[^A-Za-z0-9]/g, "")
                  .substring(0, 36)
        : null
}
function validateRow(p) {
    const {organizationPartyId} = importer(p.scopeKey)
    // at an apply: a row its key already made says valid, so the apply answers the first result (only this importer's import row of
    // this organization: any other use of the key is the apply's OPERATION_KEY_CONFLICT)
    const operationKey = operationOf(p.operationKey)
    const done = operationKey ? one(lib.operationEntity, {operationKey}) : null
    if (
        done &&
        done.operationType === operationType &&
        done.organizationPartyId === organizationPartyId &&
        done.userId === ec.user.userId
    ) {
        const values = rowValues(p, organizationPartyId)
        return {
            valid: true,
            errors: [],
            warnings: [],
            normalizedValues: values,
            displayText: values.opportunityName || values.externalKey || ""
        }
    }
    const {values, strategy, existing, errors} = plan(p)
    const name = values.opportunityName || existing?.opportunityName || values.salesOpportunityId || ""
    if (!errors.length && existing && strategy === "skip")
        return {
            valid: true,
            skip: true,
            errors: [],
            warnings: ["Deal " + existing.salesOpportunityId + " is already here; choose Update matched deals to change it"],
            normalizedValues: values,
            displayText: name + " (already " + existing.salesOpportunityId + ")"
        }
    return {
        valid: !errors.length,
        errors,
        warnings: [],
        normalizedValues: values,
        displayText: name + (existing ? " (changes " + existing.salesOpportunityId + ")" : " (new)")
    }
}
// A guarded Sales service as the importer, its refusal thrown.
function write(name, parameters) {
    const out =
        ec.service
            .sync()
            .name(service + name)
            .parameters(parameters)
            .disableAuthz()
            .call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const revisionOf = salesOpportunityId => write("get#Opportunity", {salesOpportunityId}).opportunity?.revision
function applyRow(p) {
    ec.message.pushErrors()
    try {
        const {organizationPartyId} = importer(p.scopeKey)
        const values = rowValues(p, organizationPartyId)
        const operationKey = operationOf(p.operationKey)
        if (!operationKey) return {applied: false, reasonCode: "OPERATION_KEY_REQUIRED", reason: "The row has no operation key"}
        const op = lib.operation({operationKey}, operationType, organizationPartyId, values)
        const previous = lib.previous(op)
        if (previous) return {applied: true, resultRef: previous.salesOpportunityId, resultText: previous.resultText}
        const planned = plan(p)
        const {existing, strategy, typeEnumId, stage, errors} = planned
        if (errors.length) return {applied: false, reasonCode: "ROW_INVALID", reason: errors.join("; ")}
        if (existing && strategy === "skip")
            return {applied: false, reasonCode: "SKIPPED", reason: "Deal " + existing.salesOpportunityId + " is already here"}
        const sourceKey = sourceKeyOf(values)
        let salesOpportunityId
        let resultText
        if (!existing) {
            salesOpportunityId = write(
                "create#Opportunity",
                Object.assign(
                    {organizationPartyId, typeEnumId, opportunityStageId: stage?.opportunityStageId || null},
                    Object.fromEntries(
                        [
                            "opportunityName",
                            "description",
                            "nextStep",
                            "accountPartyId",
                            "contactPartyId",
                            "salesPipelineId",
                            "ownerPartyId",
                            "teamPartyId",
                            "estimatedAmount",
                            "currencyUomId",
                            "estimatedProbability",
                            "estimatedCloseDate",
                            "dataSourceId"
                        ].map(field => [field, values[field] || null])
                    )
                )
            ).salesOpportunityId
            resultText = (typeEnumId === types.lead ? "New lead: " : "New opportunity: ") + values.opportunityName
        } else {
            salesOpportunityId = existing.salesOpportunityId
            // a lead matched by an opportunity's row is qualified first (its account given or its own), under a key of the row's
            if (typeEnumId === types.opportunity && existing.typeEnumId === types.lead)
                write("qualify#Lead", {
                    salesOpportunityId,
                    expectedRevision: revisionOf(salesOpportunityId),
                    accountPartyId: values.accountPartyId || null,
                    contactPartyId: values.contactPartyId || null,
                    salesPipelineId: values.salesPipelineId || null,
                    opportunityStageId: stage?.opportunityStageId || null,
                    operationKey: "soq-" + operationKey.substring(4, 40)
                })
            const changes = {}
            for (const field of factFields) if (values[field]) changes[field] = values[field]
            if (Object.keys(changes).length)
                write(
                    "update#Opportunity",
                    Object.assign({salesOpportunityId, expectedRevision: revisionOf(salesOpportunityId)}, changes)
                )
            const current = one(OPPORTUNITY, {salesOpportunityId})
            if (stage && stage.opportunityStageId !== current.opportunityStageId)
                write("move#Opportunity", {
                    salesOpportunityId,
                    expectedRevision: revisionOf(salesOpportunityId),
                    salesPipelineId: values.salesPipelineId || current.salesPipelineId || null,
                    opportunityStageId: stage.opportunityStageId,
                    note: "Import"
                })
            if (values.ownerPartyId)
                write("store#OpportunityParty", {
                    salesOpportunityId,
                    expectedRevision: revisionOf(salesOpportunityId),
                    roleTypeId: "SalesRepresentative",
                    partyId: values.ownerPartyId
                })
            resultText = "Updated: " + (current.opportunityName || salesOpportunityId)
        }
        // the row's key, kept with the deal (one a key; plan refuses a deal kept under another)
        if (sourceKey && one(OPPORTUNITY, {salesOpportunityId}).importSourceKey !== sourceKey)
            lib.call("update#" + OPPORTUNITY, {salesOpportunityId, importSourceKey: sourceKey})
        lib.complete(op, OPPORTUNITY, salesOpportunityId, {salesOpportunityId, resultText})
        return {applied: true, resultRef: salesOpportunityId, resultText}
    } catch (error) {
        return {applied: false, reasonCode: codeOf(error) || "DEAL_REFUSED", reason: refusal(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The organizations an opportunity import may be for and whose imports the caller may read: the internal organizations of their
// sales scope, for a Sales reader. None otherwise.
function findScopes() {
    if (!ec.user.userId) return {scopeList: []}
    const userScope = salesAccess.scope()
    if (!userScope.capabilities.anyRead) return {scopeList: []}
    const internal = Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
        row => row.partyId
    )
    const ids =
        userScope.organizationPartyIds == null ? internal : userScope.organizationPartyIds.filter(id => internal.includes(id))
    return {
        scopeList: ids
            .map(scopeKey => ({scopeKey, title: organizationName(scopeKey)}))
            .sort((a, b) => a.title.localeCompare(b.title))
    }
}

const operations = {validateRow, applyRow, findScopes}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown opportunity import operation " + op)
        return operations[op](parameters || {})
    }
})
