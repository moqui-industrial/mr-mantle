// Sales' workspace (impl-sales P6; design-sales §3 Home, design-admin §14; SalesWorkspaceServices get#SalesHome,
// find#OwnedSalesAssignments, transfer#SalesAssignment; UserFactServices get#OrganizationFacts): each Home counter is its list's count
// with the list's own filters, and the assigned work is the user's own open deals; the lifecycle participant lists a departing
// rep's open deals, open quotes (P7) and managed accounts to a holder of SALES_OWNER_CHANGE (another user without it is refused) and moves them to a
// new owner who works for the organization (one who does not is NOT_EMPLOYED); Mantle's user facts name the user's organizations and
// the active one. Standalone: spec-local organizations, team, users and deals.
// Run: ./moq test mr-mantle --spec SalesWorkspace
const prefix = "SWS"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const W = "mantle.sales.SalesWorkspaceServices."
const O = "mantle.sales.OpportunityServices."
const users = {}
const teams = {}
const deals = {}
const quotes = {}

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
    make("mantle.party.Person", {partyId: id, firstName: "Workspace", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Workspace " + kind})
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
const ownerOf = salesOpportunityId =>
    system(() =>
        Array.from(
            ec.entity
                .find("mantle.sales.opportunity.SalesOpportunityParty")
                .condition({salesOpportunityId, roleTypeId: "SalesRepresentative"})
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.partyId)
    ).join(",")

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Workspace A")
            organization(orgB, "Workspace B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Workspace spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Workspace spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.(sales|party)\\..*",
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
            const rep = ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_ACCOUNT_EDIT"]
            users.rep = user("rep", [orgA], rep)
            users.mate = user("mate", [orgA], rep)
            users.repB = user("repb", [orgB], rep)
            users.operator = user("operator", [orgA], ["SALES_OWNER_CHANGE"])
            users.reader = user("reader", [orgA], ["SALES_VIEW"])
            teams.east = team("east", orgA)
            member(users.rep, teams.east)
            member(users.mate, teams.east)
        })
        const create = (username, parameters) =>
            as(username, () => invoke(O + "create#Opportunity", Object.assign({organizationPartyId: orgA}, parameters)))
                .salesOpportunityId
        const yesterday = ec.l10n.format(new Date(Date.now() - 3 * 86400000), "yyyy-MM-dd")
        deals.open = create(users.rep, {opportunityName: "Rep's open deal", estimatedCloseDate: "2099-01-01"})
        deals.late = create(users.rep, {opportunityName: "Rep's late deal", estimatedCloseDate: yesterday})
        deals.lead = create(users.rep, {opportunityName: "Rep's lead", typeEnumId: "SotLead"})
        deals.mate = create(users.mate, {opportunityName: "Mate's deal"})
        deals.queue = create(users.mate, {opportunityName: "Team queue lead", typeEnumId: "SotLead"})
        // an account the rep manages
        users.account = as(users.rep, () =>
            invoke("mantle.sales.AccountServices.create#Account", {
                organizationPartyId: orgA,
                organizationName: "Workspace customer"
            })
        ).partyId
    }
})

feature("each Home counter is its list's count, and the assigned work is the user's own open deals", {
    when() {
        const home = as(users.rep, () => invoke(W + "get#SalesHome", {}))
        const listCount = counter =>
            as(users.rep, () =>
                invoke(
                    O + "find#Opportunities",
                    Object.assign(
                        {
                            pageSize: 1,
                            statusId: "SalesOppOpen",
                            typeEnumId: counter.listPath === "Pipeline/Leads" ? "SotLead" : "SotOpportunity"
                        },
                        counter.parameters
                    )
                )
            ).opportunityListCount
        const counters = Object.fromEntries(Array.from(home.counters || []).map(counter => [counter.counterKey, counter]))
        return {
            home,
            counters,
            lists: {
                leads: listCount(counters.leads),
                myOpportunities: listCount(counters.myOpportunities),
                pastClose: listCount(counters.pastClose)
            },
            otherOrganization: as(users.rep, () => invoke(W + "get#SalesHome", {organizationPartyId: orgB})),
            noRead: as(users.operator, () => invoke(W + "get#SalesHome", {}))
        }
    },
    then(r) {
        r.counters.leads.state == "ready"
        r.counters.leads.count == r.lists.leads
        r.counters.leads.count == 2
        r.counters.myOpportunities.count == r.lists.myOpportunities
        r.counters.myOpportunities.count == 2
        r.counters.pastClose.count == r.lists.pastClose
        r.counters.pastClose.count == 1
        r.counters.quotesToSend.state == "ready"
        r.counters.quotesToSend.count == 0
        r.counters.ordersBlocked.state == "ready" && r.counters.ordersBlocked.listPath == "Orders/Orders"
        r.home.assignedCount == 3
        Array.from(r.home.assignedWork)
            .map(row => row.salesOpportunityId)
            .includes(deals.late)
        !Array.from(r.home.assignedWork)
            .map(row => row.salesOpportunityId)
            .includes(deals.mate)
        r.otherOrganization.refused.includes("ORGANIZATION_DENIED")
        r.noRead.refused.includes("PERMISSION_DENIED")
    }
})

feature(
    "the lifecycle participant lists a rep's deals and accounts to SALES_OWNER_CHANGE and moves them to one who works there",
    {
        when() {
            // a shared account the rep manages from before set#AccountManager refused one (made directly): listed, not transferable
            const shared = prefix + "_SHARED"
            system(() => {
                make("mantle.party.Party", {partyId: shared, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_"})
                make("mantle.party.Organization", {partyId: shared, organizationName: "Shared customer"})
                make("mantle.party.PartyRole", {partyId: shared, roleTypeId: "Account"})
                make("mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtAccountManager",
                    fromPartyId: users.rep,
                    fromRoleTypeId: "SalesRepresentative",
                    toPartyId: shared,
                    toRoleTypeId: "Account",
                    fromDate: 0
                })
                // P7: the rep's open quote and a cancelled one (made directly: the quote services are SalesQuoteDrafts')
                for (const [kind, statusId] of [
                    ["open", "OrderOpen"],
                    ["cancelled", "OrderCancelled"]
                ]) {
                    const orderId = prefix + "_QUOTE_" + kind.toUpperCase()
                    make("mantle.order.OrderHeader", {
                        orderId,
                        orderName: "Rep's " + kind + " quote",
                        orderPurposeEnumId: "OrpSalesQuote",
                        statusId,
                        currencyUomId: "USD",
                        entryDate: ec.user.nowTimestamp
                    })
                    make("mantle.order.OrderPart", {
                        orderId,
                        orderPartSeqId: "01",
                        vendorPartyId: orgA,
                        customerPartyId: users.account,
                        statusId
                    })
                    for (const [partyId, roleTypeId] of [
                        [users.rep, "SalesRepresentative"],
                        [teams.east, "SalesTeam"]
                    ])
                        make("mantle.order.OrderPartParty", {orderId, orderPartSeqId: "01", partyId, roleTypeId})
                    quotes[kind] = orderId
                }
            })
            const lookup = username => as(username, () => invoke(W + "find#OwnedSalesAssignments", {userId: users.rep}))
            const owned = lookup(users.operator)
            const refused = lookup(users.reader)
            const move = (username, salesResourceId, toUserId) =>
                as(username, () =>
                    invoke(W + "transfer#SalesAssignment", {
                        fromUserId: users.rep,
                        toUserId,
                        salesResourceId,
                        reason: "Offboarding"
                    })
                )
            const notEmployed = move(users.operator, "deal:" + deals.open, users.repB)
            const readerMove = move(users.reader, "deal:" + deals.open, users.mate)
            const moved = move(users.operator, "deal:" + deals.open, users.mate)
            const notOwned = move(users.operator, "deal:" + deals.mate, users.mate)
            const quoteElsewhere = move(users.operator, "quote:" + quotes.open, users.repB)
            const quote = move(users.operator, "quote:" + quotes.open, users.mate)
            const closedQuote = move(users.operator, "quote:" + quotes.cancelled, users.mate)
            const quoteParties = system(() =>
                Array.from(ec.entity.find("mantle.order.OrderPartParty").condition({orderId: quotes.open}).list())
                    .map(row => row.roleTypeId + ":" + row.partyId)
                    .sort()
                    .join(",")
            )
            const account = move(users.operator, "account:" + users.account, users.mate)
            const managers = system(() =>
                Array.from(
                    ec.entity
                        .find("mantle.party.PartyRelationship")
                        .condition({toPartyId: users.account, relationshipTypeEnumId: "PrtAccountManager"})
                        .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                        .list()
                ).map(row => row.fromPartyId)
            )
            return {
                ids: Array.from(owned.resourceList || []).map(row => row.resourceId),
                names: Array.from(owned.resourceList || [])
                    .map(row => row.resourceName)
                    .join(" | "),
                sharedRow: Array.from(owned.resourceList || []).find(row => row.resourceId === "account:" + shared) || null,
                refused,
                notEmployed,
                readerMove,
                moved,
                notOwned,
                quoteElsewhere,
                quote,
                closedQuote,
                quoteParties,
                account,
                openOwner: ownerOf(deals.open),
                managers,
                after: Array.from(lookup(users.operator).resourceList || []).map(row => row.resourceId)
            }
        },
        then(r) {
            r.ids.includes("deal:" + deals.open)
            r.ids.includes("deal:" + deals.lead)
            r.ids.includes("account:" + users.account)
            r.ids.includes("quote:" + quotes.open)
            !r.ids.includes("quote:" + quotes.cancelled)
            r.names.includes("Quote Rep's open quote · Workspace A")
            !r.ids.includes("deal:" + deals.mate)
            r.names.includes("Rep's open deal · Workspace A")
            r.sharedRow != null
            r.sharedRow.transferable == false
            r.refused.refused.includes("PERMISSION_DENIED")
            r.notEmployed.refused.includes("NOT_EMPLOYED")
            r.readerMove.refused.includes("PERMISSION_DENIED")
            r.moved.transferred == true
            r.notOwned.refused.includes("RECORD_UNAVAILABLE")
            r.quoteElsewhere.refused.includes("NOT_EMPLOYED")
            r.quote.transferred == true
            r.closedQuote.refused.includes("RECORD_CLOSED")
            r.quoteParties == "SalesRepresentative:" + users.mate + ",SalesTeam:" + teams.east
            !r.after.includes("quote:" + quotes.open)
            r.account.transferred == true
            r.openOwner == users.mate
            r.managers.join(",") == users.mate
            !r.after.includes("deal:" + deals.open)
            !r.after.includes("account:" + users.account)
        }
    }
)

feature("Mantle's user facts name the user's organizations and the active one, and nothing of another user", {
    when() {
        const F = "mantle.party.UserFactServices.get#OrganizationFacts"
        const factsOf = username => as(username, () => invoke(F, {userId: ec.user.userId}).factList)
        const before = factsOf(users.rep)
        system(() => {
            login(users.rep)
            ec.user.setPreference("ACTIVE_ORGANIZATION", orgA)
            login("john.doe")
        })
        const active = factsOf(users.rep)
        const other = as(users.rep, () => invoke(F, {userId: users.repB}).factList)
        const text = list =>
            Array.from(list || [])
                .map(fact => fact.label + ": " + fact.value)
                .join(" | ")
        return {before: text(before), active: text(active), other: Array.from(other || []).length}
    },
    then(r) {
        r.before.includes("Organizations: Workspace A (" + orgA + ")")
        r.before.includes("Active organization: none chosen")
        r.active.includes("Active organization: Workspace A (" + orgA + ")")
        r.other == 0
    }
})
