// The opportunity import's row services (impl-sales P6; design-sales §3 OpportunityImport, §16; mantle/sales/SalesImport.js): an
// unknown stage, currency or another organization's account is the row's named error; a valid row makes one deal with its source
// key, and a repeat under its operation key answers the first result with no second deal; a deal matched by its key (or ID) is
// skipped under the skip strategy and updated only under the update strategy; a representative without SALES_IMPORT and another
// organization are refused. Standalone: spec-local organizations, team, users and records; the users' services run with artifact
// authorization on under a spec grant of the sales services, as the framework's import calls them as the importer.
// Run: ./moq test mr-mantle --spec SalesOpportunityImport
const prefix = "SOI"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.sales.OpportunityServices."
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const users = {}
const ids = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const rowsOf = (entity, values) => Array.from(ec.entity.find(entity).condition(values).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Import", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Import " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
// A call as the user with artifact authorization on: its result, or the refusal's message (refused), in an error frame of its own.
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
// a row of the import as the framework gives it: the target, the batch's organization and options, the row's values as text
const row = (rowValues, extra = {}) =>
    Object.assign({targetId: "opportunities", scopeKey: orgA, rowValues, batchOptions: {duplicateStrategy: "skip"}}, extra)
const deal = salesOpportunityId => system(() => one(OPPORTUNITY, {salesOpportunityId}))
const keyed = importSourceKey => system(() => rowsOf(OPPORTUNITY, {organizationPartyId: orgA, importSourceKey}))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Import A")
            organization(orgB, "Import B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Import spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Import spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.sales\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            const manager = ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_TEAM_MANAGE", "SALES_IMPORT"]
            users.manager = user("manager", [orgA], manager)
            users.rep = user("rep", [orgA], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT"])
            // an account of B, which a row of A may not name
            make("mantle.party.Party", {partyId: prefix + "_ACC_B", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgB})
            make("mantle.party.Organization", {partyId: prefix + "_ACC_B", organizationName: "B's customer"})
            make("mantle.party.PartyRole", {partyId: prefix + "_ACC_B", roleTypeId: "Account"})
            make("mantle.party.PartyRole", {partyId: prefix + "_ACC_B", roleTypeId: "Customer"})
        })
    }
})

feature(
    "an unknown stage, currency or another organization's account is the row's error; a rep and another organization are refused",
    {
        when() {
            const valid = {
                externalSource: "crm",
                externalKey: "D-1",
                opportunityName: "Racks for Fabrikam",
                opportunityStageId: "Proposal"
            }
            return {
                valid: as(users.manager, "validate#OpportunityImportRow", row(valid)),
                stage: as(
                    users.manager,
                    "validate#OpportunityImportRow",
                    row(Object.assign({}, valid, {opportunityStageId: "Signed"}))
                ),
                currency: as(
                    users.manager,
                    "validate#OpportunityImportRow",
                    row(Object.assign({}, valid, {estimatedAmount: "100", currencyUomId: "XYZ"}))
                ),
                account: as(
                    users.manager,
                    "validate#OpportunityImportRow",
                    row(Object.assign({}, valid, {accountPartyId: prefix + "_ACC_B"}))
                ),
                otherRowOrganization: as(
                    users.manager,
                    "validate#OpportunityImportRow",
                    row(Object.assign({}, valid, {organizationPartyId: orgB}))
                ),
                rep: as(users.rep, "validate#OpportunityImportRow", row(valid)),
                otherScope: as(users.manager, "validate#OpportunityImportRow", row(valid, {scopeKey: orgB})),
                scopes: as(users.manager, "find#OpportunityImportScopes", {targetId: "opportunities"}).scopeList
            }
        },
        then(r) {
            r.valid.refused == ""
            r.valid.valid == true
            r.valid.normalizedValues.opportunityStageId == "Proposal"
            r.stage.valid == false
            r.stage.errors.join(" ").includes("Stage Signed is not a current stage")
            r.currency.errors.join(" ").includes("Currency XYZ is not known")
            r.account.errors.join(" ").includes("is not an account of Import A")
            r.otherRowOrganization.refused.includes("import another organization's deals apart")
            r.rep.refused.includes("PERMISSION_DENIED")
            r.otherScope.refused.includes("ORGANIZATION_DENIED")
            Array.from(r.scopes)
                .map(scope => scope.scopeKey)
                .join(",") == orgA
        }
    }
)

feature("a row makes one deal with its source key, and a repeat under its operation key answers the first result", {
    when() {
        const values = {
            externalSource: "crm",
            externalKey: "D-2",
            opportunityName: "Shelving for Northwind",
            opportunityStageId: "SalesDiscovery",
            estimatedAmount: "2500",
            currencyUomId: "USD",
            estimatedCloseDate: "2026-12-15"
        }
        const first = as(users.manager, "apply#OpportunityImportRow", row(values, {operationKey: "tr.spec-row-2"}))
        const again = as(users.manager, "apply#OpportunityImportRow", row(values, {operationKey: "tr.spec-row-2"}))
        const revalidated = as(users.manager, "validate#OpportunityImportRow", row(values, {operationKey: "tr.spec-row-2"}))
        ids.d2 = first.resultRef
        return {first, again, revalidated, made: deal(first.resultRef || "_NA_"), keyedRows: keyed("crm / D-2")}
    },
    then(r) {
        r.first.refused == ""
        r.first.applied == true
        r.first.resultText.startsWith("New opportunity")
        r.made.opportunityName == "Shelving for Northwind"
        r.made.opportunityStageId == "SalesDiscovery"
        r.made.typeEnumId == "SotOpportunity"
        r.made.importSourceKey == "crm / D-2"
        r.again.applied == true
        r.again.resultRef == r.first.resultRef
        r.keyedRows.length == 1
        r.revalidated.valid == true
    }
})

feature("a matched deal is skipped under the skip strategy and changed only under update, by its key or its ID", {
    when() {
        const changed = {externalSource: "crm", externalKey: "D-2", estimatedAmount: "4000", opportunityStageId: "Negotiation"}
        const update = {batchOptions: {duplicateStrategy: "update"}}
        const skipped = as(users.manager, "validate#OpportunityImportRow", row(changed))
        const skippedApply = as(users.manager, "apply#OpportunityImportRow", row(changed, {operationKey: "tr.spec-row-3"}))
        const afterSkip = deal(ids.d2)
        const updatedCheck = as(users.manager, "validate#OpportunityImportRow", row(changed, update))
        const updated = as(
            users.manager,
            "apply#OpportunityImportRow",
            row(changed, Object.assign({operationKey: "tr.spec-row-4"}, update))
        )
        const afterUpdate = deal(ids.d2)
        // the deal's ID with another key is refused; with its own key and the ID it is the same deal
        const otherKey = as(
            users.manager,
            "validate#OpportunityImportRow",
            row({externalSource: "crm", externalKey: "D-9", salesOpportunityId: ids.d2}, update)
        )
        return {skipped, skippedApply, afterSkip, updatedCheck, updated, afterUpdate, otherKey, keyedRows: keyed("crm / D-2")}
    },
    then(r) {
        r.skipped.valid == true
        r.skipped.skip == true
        r.skippedApply.applied == false
        r.skippedApply.reasonCode == "SKIPPED"
        String(r.afterSkip.estimatedAmount) == "2500"
        r.updatedCheck.skip == false
        r.updatedCheck.valid == true
        r.updated.refused == ""
        r.updated.applied == true
        r.updated.resultRef == ids.d2
        Number(String(r.afterUpdate.estimatedAmount)) == 4000
        r.afterUpdate.opportunityStageId == "SalesNegotiation"
        r.otherKey.valid == false
        r.otherKey.errors.join(" ").includes("is source key crm / D-2")
        r.keyedRows.length == 1
    }
})
