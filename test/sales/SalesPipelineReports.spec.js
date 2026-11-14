// Sales' pipeline reports and report scope (impl-sales P19; design-sales §8 PipelineAnalysis, WinLoss, SalesAnalysis, Reports;
// mantle/sales/SalesPipelineReports.js, SalesAnalysis.js, SalesWorkspace.js salesReports): win rate over won and lost
// opportunities only, a disqualified lead apart, a reopened deal counted once in the final-outcome mode and at each close in the
// event mode, amounts by currency; a stage stay whose entry the audit log does not show is unknown, a chained one measured; lead
// conversion over a created cohort; open deals by currency, never added; the report read refused a representative and another
// organization; Sales analysis for a Sales report reader of their organization with the cost and margin only for a price and cost
// reader; the report catalogue by capability and for Sales' root only. Standalone: spec-local organizations, users and records; the
// users' services run with artifact authorization on under a spec grant of the sales services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesPipelineReports
const prefix = "SPR"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const F = "mantle.sales.ForecastServices."
const O = "mantle.sales.OpportunityServices."
const users = {}
const deals = {}
const stages = []
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
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Reports", lastName: kind})
    make("mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Reports " + kind})
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
        const out = ec.service.sync().name(verb).parameters(parameters).requireNewTransaction(true).call() || {}
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
const num = value => (value == null ? null : Number(String(value)))
const revision = (username, salesOpportunityId) => as(username, O + "get#Opportunity", {salesOpportunityId}).opportunity?.revision
const close = (username, salesOpportunityId, statusId, extra = {}) =>
    as(
        username,
        O + "close#Opportunity",
        Object.assign({salesOpportunityId, statusId, expectedRevision: revision(username, salesOpportunityId)}, extra)
    )
const later = days => new Date(Date.now() + days * dayMs)
const dealRow = (found, salesOpportunityId) =>
    Array.from(found.dealList || []).filter(row => row.salesOpportunityId === salesOpportunityId)
const byCurrency = (list, currencyUomId) => Array.from(list || []).find(row => row.currencyUomId === currencyUomId) || {}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Reports A")
            organization(orgB, "Reports B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Reports spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Reports spec services"})
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
            const edit = ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_ACCOUNT_EDIT"]
            users.rep = user("rep", orgA, edit)
            users.reader = user("reader", orgA, edit.concat(["SALES_TEAM_VIEW", "SALES_REPORT_VIEW"]))
            users.costReader = user("cost", orgA, ["SALES_REPORT_VIEW", "PRICE_VIEW", "PRODUCT_COST_VIEW"])
            users.readerB = user("readerb", orgB, ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_REPORT_VIEW"])
        })
        const deal = values =>
            as(
                users.reader,
                O + "create#Opportunity",
                Object.assign({organizationPartyId: orgA, currencyUomId: "USD", ownerPartyId: users.reader}, values)
            ).salesOpportunityId
        // the close cohort: a won and a lost deal, a deal won then reopened and lost, a lead disqualified, a won deal in euros
        deals.won = deal({opportunityName: "Won", estimatedAmount: "100"})
        deals.lost = deal({opportunityName: "Lost", estimatedAmount: "50"})
        deals.reopened = deal({opportunityName: "Reopened", estimatedAmount: "30"})
        deals.lead = deal({opportunityName: "Lead", typeEnumId: "SotLead", estimatedAmount: "10"})
        deals.euro = deal({opportunityName: "Euro", estimatedAmount: "70", currencyUomId: "EUR"})
        const reason = Array.from(
            system(() =>
                ec.entity.find("moqui.basic.Enumeration").condition("enumTypeId", "SalesLostReason").orderBy("sequenceNum").list()
            )
        ).find(row => !row.thruDate && row.enumId !== "SlrIntakePurged")?.enumId
        deals.reason = reason
        close(users.reader, deals.won, "SalesOppWon")
        close(users.reader, deals.lost, "SalesOppLost", {lostReasonEnumId: reason})
        close(users.reader, deals.reopened, "SalesOppWon")
        as(users.reader, O + "reopen#Opportunity", {
            salesOpportunityId: deals.reopened,
            reason: "The customer came back",
            expectedRevision: revision(users.reader, deals.reopened)
        })
        close(users.reader, deals.reopened, "SalesOppLost", {lostReasonEnumId: reason})
        close(users.reader, deals.lead, "SalesOppLost", {lostReasonEnumId: reason})
        close(users.reader, deals.euro, "SalesOppWon")
        // open deals: one moved a stage on (a stay with a known entry and exit), one whose history starts mid-way (a gap)
        deals.moved = deal({opportunityName: "Moved", estimatedAmount: "400", estimatedProbability: "50"})
        deals.gap = deal({opportunityName: "Gap", estimatedAmount: "60", currencyUomId: "EUR"})
        system(() => {
            const row = ec.entity
                .find("mantle.sales.opportunity.SalesOpportunity")
                .condition("salesOpportunityId", deals.moved)
                .one()
            for (const stage of Array.from(
                ec.entity
                    .find("mantle.sales.opportunity.SalesOpportunityStage")
                    .condition("salesPipelineId", row.salesPipelineId)
                    .orderBy("sequenceNum")
                    .list()
            ))
                if (!stage.thruDate) stages.push(stage.opportunityStageId)
        })
        as(users.reader, O + "move#Opportunity", {
            salesOpportunityId: deals.moved,
            opportunityStageId: stages[1],
            expectedRevision: revision(users.reader, deals.moved)
        })
        // a change the log shows from the second stage to the third, with no record of entering the second: its stay is unknown
        system(() =>
            make("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.sales.opportunity.SalesOpportunity",
                changedFieldName: "opportunityStageId",
                pkPrimaryValue: deals.gap,
                oldValueText: stages[1],
                newValueText: stages[2],
                changedDate: later(0.01)
            })
        )
        // a lead of the cohort qualified
        deals.qualified = deal({opportunityName: "Qualified lead", typeEnumId: "SotLead"})
        as(users.reader, O + "qualify#Lead", {
            salesOpportunityId: deals.qualified,
            expectedRevision: revision(users.reader, deals.qualified),
            operationKey: prefix + "-qualify",
            accountName: "Reports Prospect Co",
            estimatedAmount: "20",
            currencyUomId: "USD"
        })
        // B's deal, for the refusal
        as(users.readerB, O + "create#Opportunity", {organizationPartyId: orgB, opportunityName: "B's", currencyUomId: "USD"})
        // a placed sales order of A shipped from an asset of known cost: 2 at 50, issued at a cost of 20 each
        system(() => {
            make("mantle.party.Party", {partyId: prefix + "_CUSTOMER", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
            make("mantle.party.Organization", {partyId: prefix + "_CUSTOMER", organizationName: "Reports customer"})
            make("mantle.product.Product", {productId: prefix + "_PROD", productName: "Reports product", ownerPartyId: orgA})
            make("mantle.order.OrderHeader", {
                orderId: prefix + "_ORD",
                statusId: "OrderPlaced",
                placedDate: ec.user.nowTimestamp,
                entryDate: ec.user.nowTimestamp,
                currencyUomId: "USD",
                grandTotal: 100
            })
            make("mantle.order.OrderPart", {
                orderId: prefix + "_ORD",
                orderPartSeqId: "01",
                vendorPartyId: orgA,
                customerPartyId: prefix + "_CUSTOMER",
                statusId: "OrderPlaced"
            })
            make("mantle.order.OrderItem", {
                orderId: prefix + "_ORD",
                orderItemSeqId: "01",
                orderPartSeqId: "01",
                itemTypeEnumId: "ItemProduct",
                productId: prefix + "_PROD",
                quantity: 2,
                unitAmount: 50
            })
            make("mantle.product.asset.Asset", {
                assetId: prefix + "_ASSET",
                productId: prefix + "_PROD",
                ownerPartyId: orgA,
                acquireCost: 20,
                acquireCostUomId: "USD"
            })
            make("mantle.product.issuance.AssetIssuance", {
                assetIssuanceId: prefix + "_ISS",
                assetId: prefix + "_ASSET",
                orderId: prefix + "_ORD",
                orderItemSeqId: "01",
                quantity: 2,
                issuedDate: ec.user.nowTimestamp
            })
        })
    }
})

feature(
    "win rate is over won and lost opportunities; a reopened deal counts once in the final outcome and at each close as events",
    {
        when() {
            const options = {
                organizationPartyId: orgA,
                fromDate: later(-1),
                thruDate: later(1),
                asOfDate: later(1),
                pageSize: 100
            }
            return {
                final: as(users.reader, F + "get#WinLoss", options),
                events: as(users.reader, F + "get#WinLoss", Object.assign({mode: "events"}, options)),
                usd: as(users.reader, F + "get#WinLoss", Object.assign({currencyUomId: "USD"}, options))
            }
        },
        then({final, events, usd}) {
            final.refused == ""
            // won: the won deal and the euro deal; lost: the lost deal and the reopened one, once; the lead apart
            final.wonCount == 2
            final.lostCount == 2
            final.disqualifiedCount == 1
            num(final.winRatePercent) == 50
            dealRow(final, deals.reopened).length == 1
            dealRow(final, deals.reopened)[0].outcomeText == "Lost"
            dealRow(final, deals.reopened)[0].reopenCount == 1
            final.reopenCount == 1
            // never added across currencies: dollars and euros apart
            num(byCurrency(final.outcomeList, "USD").wonAmount) == 100
            num(byCurrency(final.outcomeList, "EUR").wonAmount) == 70
            num(byCurrency(final.outcomeList, "USD").lostAmount) == 80
            Array.from(final.reasonList).some(row => row.lostReasonEnumId == deals.reason && row.lostCount == 2)
            // each close: the reopened deal's win and its loss
            events.wonCount == 3
            events.lostCount == 2
            dealRow(events, deals.reopened).length == 2
            usd.wonCount == 1
        }
    }
)

feature(
    "a stage stay the history does not show is unknown, a chained one measured; open deals by currency; conversion of a cohort",
    {
        when() {
            return as(users.reader, F + "get#PipelineAnalysis", {
                organizationPartyId: orgA,
                asOfDate: later(1),
                cohortFrom: later(-1),
                pageSize: 100
            })
        },
        then(found) {
            found.refused == ""
            const durationOf = stageId => Array.from(found.stageDurationList).find(row => row.opportunityStageId == stageId) || {}
            // the moved deal left the first stage at a known time
            durationOf(stages[0]).completedCount >= 1
            durationOf(stages[0]).averageDays != null
            // the gap deal: its first stage's exit and its second stage's entry are not in the log
            durationOf(stages[1]).unknownCount >= 1
            durationOf(stages[0]).unknownCount >= 1
            // the open opportunities by currency, never one total
            const usd = Array.from(found.measureList).filter(row => row.currencyUomId == "USD")
            const eur = Array.from(found.measureList).filter(row => row.currencyUomId == "EUR")
            usd.reduce((sum, row) => sum + num(row.estimatedAmount), 0) == 420
            eur.reduce((sum, row) => sum + num(row.estimatedAmount), 0) == 60
            usd.every(row => row.weightedAmount != null)
            // two leads created in the cohort: one qualified, one disqualified
            found.conversion.leadCount == 2
            found.conversion.convertedCount == 1
            found.conversion.disqualifiedCount == 1
            num(found.conversion.conversionPercent) == 50
            // the visit step waits for Marketing: not available, never zero
            found.funnelSteps[0].stepKey == "visits"
            found.funnelSteps[0].count == null
            found.funnelSteps[2].count == 1
        }
    }
)

feature(
    "the report read: a representative and another organization refused; the catalogue by capability and for Sales' root only",
    {
        when() {
            return {
                rep: as(users.rep, F + "get#PipelineAnalysis", {organizationPartyId: orgA}).refused,
                other: as(users.readerB, F + "get#WinLoss", {organizationPartyId: orgA}).refused,
                readerCatalogue: Array.from(
                    as(users.reader, "mantle.sales.SalesWorkspaceServices.get#SalesReports", {appRoot: "Sales"}).reports || []
                ).map(row => row.entryId),
                repCatalogue: Array.from(
                    as(users.rep, "mantle.sales.SalesWorkspaceServices.get#SalesReports", {appRoot: "Sales"}).reports || []
                ).map(row => row.entryId),
                accounting: as(users.reader, "mantle.sales.SalesWorkspaceServices.get#SalesReports", {appRoot: "Accounting"})
                    .refused
            }
        },
        then({rep, other, readerCatalogue, repCatalogue, accounting}) {
            rep.includes("PERMISSION_DENIED")
            other.includes("ORGANIZATION_DENIED")
            readerCatalogue ==
                [
                    "Sales.SalesSummary",
                    "Sales.SalesAnalysis",
                    "Sales.PipelineAnalysis",
                    "Sales.WinLoss",
                    "Sales.TargetAttainment",
                    "Sales.Forecast"
                ]
            repCatalogue == ["Sales.Forecast"]
            accounting.includes("REPORTS_UNAVAILABLE")
        }
    }
)

feature(
    "Sales analysis answers a Sales report reader of their organization, the cost and margin only for a price and cost reader",
    {
        when() {
            const options = {organizationPartyId: orgA, fromDate: later(-1), thruDate: later(1)}
            const R = "mantle.sales.SalesReportServices.run#SalesAnalysis"
            return {
                reader: as(users.reader, R, options),
                cost: as(users.costReader, R, options),
                other: as(users.readerB, R, options).refused
            }
        },
        then({reader, cost, other}) {
            reader.refused == ""
            reader.costShown == false
            const plain = Array.from(reader.analysisRows).find(row => row.productId == prefix + "_PROD")
            num(plain.orderedValue) == 100
            num(plain.issuedValue) == 100
            plain.issuedCost == null
            plain.marginValue == null
            cost.costShown == true
            const costed = Array.from(cost.analysisRows).find(row => row.productId == prefix + "_PROD")
            num(costed.issuedCost) == 40
            num(costed.marginValue) == 60
            num(costed.marginPercent) == 60
            other.includes("ORGANIZATION_DENIED")
        }
    }
)
