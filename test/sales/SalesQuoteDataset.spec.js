// The quote dataset (impl-sales P20, §4 Nov 14 the user's call; design-sales §1.4 CX-OPS-REPORTS L6, §16; report/mantle-sales-quotes.json,
// the MantleSalesQuote document of data/15-seed-initial/SalesDocumentsAndReports.xml, SalesWorkspaceServices get#QuoteRowFilter): its row filter is
// Sales' quote scope, as the quote lists read it, so a representative's rows are their organization's quotes assigned to them or their
// team, a manager's (SALES_TEAM_VIEW) the organization's, never another organization's, a template or a placed quote; a user who reads
// nothing of Sales gets none and another user's filter is refused. The document is a Sales quote's part only (never a template), with
// its validity, owner and team; read through the report engine as each user the rows follow the filter. Standalone: spec-local
// organizations, teams, users, accounts and quotes, the dataset admitted and granted to a spec group.
// Run: ./moq test mr-mantle --spec SalesQuoteDataset
const prefix = "SQX"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const W = "mantle.sales.SalesWorkspaceServices."
const users = {}
const teams = {}
const accounts = {}
const quotes = {}
const dayMs = 24 * 60 * 60 * 1000

const make = (entity, values) => call("create#" + entity, values)
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
function team(kind, organizationPartyId) {
    const partyId = prefix + "_TEAM_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesTeam",
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    return partyId
}
function member(partyId, teamPartyId) {
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    })
}
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Quotes", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Quote dataset " + kind})
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
// As the user with artifact authorization on: the action's result, or the refusal's message (refused).
function as(username, action) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out = action()
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : out
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const invoke = (name, parameters) => ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call() || {}
// the values of a filter's field condition, at its top or in its bool all
function valuesOf(filter, name) {
    const parts = filter?.bool?.all ? Array.from(filter.bool.all) : [filter]
    const found = parts.find(part => part?.field?.name === name)
    return found
        ? Array.from(found.field.values || [])
              .sort()
              .join(",")
        : null
}
const nothing = filter => Array.from(filter?.bool?.none || []).length === 1
function account(kind, ownerPartyId) {
    const partyId = prefix + "_ACC_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Account " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    return partyId
}
const filterOf = username => as(username, () => invoke(W + "get#QuoteRowFilter", {userId: ec.user.userId}).filter)
const partsOf = filter => (filter?.bool?.all ? Array.from(filter.bool.all) : [filter])
const has = (filter, name, op) => partsOf(filter).some(part => part?.field?.name === name && part.field.op === op)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Quote dataset A")
            organization(orgB, "Quote dataset B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Quote dataset spec grant"})
            make("moqui.security.ArtifactGroup", {
                artifactGroupId: prefix + "_SERVICES",
                description: "Quote dataset spec services"
            })
            for (const [artifactName, pattern] of [
                ["mantle\\.(sales|order)\\..*", "Y"],
                ["org.moqui.report.dataset.mantle-sales-quotes", "N"],
                ["org.moqui.report.ReportServices.query#Documents", "N"]
            ])
                make("moqui.security.ArtifactGroupMember", {
                    artifactGroupId: prefix + "_SERVICES",
                    artifactName,
                    artifactTypeEnumId: "AT_SERVICE",
                    nameIsPattern: pattern,
                    inheritAuthz: "Y"
                })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            make("moqui.entity.document.DataDocumentUserGroup", {
                dataDocumentId: "MantleSalesQuote",
                userGroupId: prefix + "_GRANT"
            })
            if (!ec.entity.find("moqui.report.BusinessDataset").condition("datasetId", "mantle-sales-quotes").one())
                make("moqui.report.BusinessDataset", {
                    datasetId: "mantle-sales-quotes",
                    admittedDate: new Date(),
                    versionNumber: 1
                })
            const rep = ["SALES_VIEW", "SALES_QUOTE_EDIT"]
            users.east = user("east", [orgA], rep)
            users.west = user("west", [orgA], rep)
            users.manager = user("manager", [orgA], rep.concat(["SALES_TEAM_VIEW"]))
            users.repB = user("repb", [orgB], rep)
            users.none = user("none", [orgA], ["SALES_QUOTE_EDIT"])
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.east, teams.east)
            member(users.west, teams.west)
            accounts.a = account("a", orgA)
            accounts.b = account("b", orgB)
            // a quote template of A, which is never a quote
            quotes.template = call("mantle.order.OrderServices.create#Order", {
                vendorPartyId: orgA,
                customerPartyId: accounts.a,
                orderPurposeEnumId: "OrpSalesQuoteTemplate"
            }).orderId
        })
        const create = (username, organizationPartyId, customerPartyId, orderName, days) =>
            as(username, () =>
                invoke("mantle.order.SalesQuoteServices.create#Quote", {
                    organizationPartyId,
                    customerPartyId,
                    orderName,
                    currencyUomId: "USD",
                    validThruDate: new Date(Date.now() + days * dayMs)
                })
            ).orderId
        quotes.east = create(users.east, orgA, accounts.a, "East quote", 3)
        quotes.eastLater = create(users.east, orgA, accounts.a, "East later quote", 30)
        quotes.west = create(users.west, orgA, accounts.a, "West quote", 3)
        quotes.placed = create(users.east, orgA, accounts.a, "East placed quote", 3)
        quotes.b = create(users.repB, orgB, accounts.b, "B quote", 3)
        // an accepted quote is placed: an order now, out of the dataset's rows
        system(() =>
            ec.entity
                .find("mantle.order.OrderHeader")
                .condition("orderId", quotes.placed)
                .one()
                .set("placedDate", new Date())
                .set("statusId", "OrderPlaced")
                .update()
        )
    }
})

feature("the row filter is Sales' quote scope: a rep's assigned quotes, a manager's organization, never a placed one", {
    when() {
        return {
            east: filterOf(users.east),
            manager: filterOf(users.manager),
            repB: filterOf(users.repB),
            none: filterOf(users.none),
            otherUser: as(users.east, () => invoke(W + "get#QuoteRowFilter", {userId: users.manager}))
        }
    },
    then(r) {
        valuesOf(r.east, "vendorPartyId") == orgA
        valuesOf(r.east, "orderId") == [quotes.east, quotes.eastLater, quotes.placed].sort().join(",")
        has(r.east, "placedDate", "exists") && has(r.east, "orderPurposeEnumId", "eq")
        valuesOf(r.manager, "vendorPartyId") == orgA
        valuesOf(r.manager, "orderId") == null
        has(r.manager, "placedDate", "exists")
        valuesOf(r.repB, "vendorPartyId") == orgB
        nothing(r.none)
        r.otherUser.refused.includes("signed-in user only")
    }
})

feature(
    "the document is a quote's part with its validity, owner and team, never a template's; the engine's rows follow the filter",
    {
        when() {
            const documents = system(() =>
                Object.fromEntries(
                    Object.entries(quotes).map(([key, orderId]) => [
                        key,
                        Array.from(ec.entity.getDataDocuments("MantleSalesQuote", {orderId}))[0] || null
                    ])
                )
            )
            const searched = ec.search.isAvailable()
            let rows = {}
            if (searched) {
                system(() => ec.search.indexDocuments(Object.values(documents).filter(Boolean)))
                // the quotes valid through the next 7 days, as the quote-expiring alert asks
                const seen = username =>
                    as(username, () =>
                        Array.from(
                            invoke("org.moqui.report.ReportServices.query#Documents", {
                                datasetId: "mantle-sales-quotes",
                                from: "now",
                                thru: "now+7d",
                                pageSize: 200
                            }).hits || []
                        )
                            .map(hit => hit.body?.orderId)
                            .filter(id => Object.values(quotes).includes(id))
                            .sort()
                            .join(",")
                    )
                rows = {east: seen(users.east), manager: seen(users.manager), repB: seen(users.repB), none: seen(users.none)}
            }
            return {documents, searched, rows}
        },
        then({documents, searched, rows}) {
            documents.template == null
            documents.east.vendorPartyId == orgA
            documents.east.customerPartyId == accounts.a
            documents.east.orderPurposeEnumId == "OrpSalesQuote"
            documents.east.ownerPartyId == users.east
            documents.east.teamPartyId == teams.east
            documents.east.validThruDate != null
            documents.placed.placedDate != null
            // through the report engine: each reader's own quotes expiring within 7 days, not placed
            searched
            rows.east == quotes.east
            rows.manager == [quotes.east, quotes.west].sort().join(",")
            rows.repB == quotes.b
            rows.none == ""
        }
    }
)
