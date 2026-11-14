// Sales' forecasts and targets (impl-sales P18; design-sales §8 Forecast and TargetAttainment, §9 Targets; mantle/sales/SalesForecasts.js,
// SalesAccess.js forecastOf): the weighted pipeline equals its deals' (a manual probability used), a deal with no close date, a lead
// and another currency left out with their reasons, won deals and their recurring revenue apart; a parent's roll-up counts a deal
// once across an owner change and never adds the children's entered forecasts; a zero quota gives no percentage; a second forecast
// or target for one key, a hierarchy cycle, a stale revision, a rep's target and another person's judgement refused, another
// organization's forecast missing and a team manager seeing their team's; allocations reconcile to the forecast and never count a
// product twice; attainment compares each target with its own basis, an order-basis target counting placed orders and no template,
// orders with no representative apart. Standalone: spec-local organizations, teams, users and records; the users' services run with
// artifact authorization on under a spec grant of the sales services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesForecasts
const prefix = "SFC"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const F = "mantle.sales.ForecastServices."
const O = "mantle.sales.OpportunityServices."
const users = {}
const teams = {}
const deals = {}
const keys = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
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
function member(partyId, teamPartyId, roleTypeId = "SalesRepresentative") {
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: roleTypeId,
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    })
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Forecast", lastName: kind})
    make("mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Forecast " + kind})
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
const measureOf = (found, measureKey) => num(Array.from(found.measures || []).find(row => row.measureKey === measureKey)?.amount)
const dealOf = (found, salesOpportunityId) =>
    Array.from(found.dealList || []).find(row => row.salesOpportunityId === salesOpportunityId)
const forecastOf = (username, parameters) =>
    as(username, F + "get#Forecast", Object.assign({currencyUomId: "USD", pageSize: 100}, parameters))
const today = () => ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd")
const revisionOf = (username, salesForecastId) => as(username, F + "get#Forecast", {salesForecastId}).forecast?.revision

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Forecast A")
            organization(orgB, "Forecast B")
            make("mantle.party.Party", {partyId: prefix + "_CUSTOMER", partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
            make("mantle.party.Organization", {partyId: prefix + "_CUSTOMER", organizationName: "Forecast customer"})
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Forecast spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Forecast spec services"})
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
            const rep = ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_FORECAST_EDIT"]
            users.rep = user("rep", orgA, rep)
            users.mate = user("mate", orgA, rep)
            users.lead = user("lead", orgA, rep)
            users.west = user("west", orgA, rep)
            users.manager = user("manager", orgA, rep.concat(["SALES_TEAM_VIEW", "SALES_TEAM_MANAGE", "SALES_REPORT_VIEW"]))
            users.repB = user("repb", orgB, rep)
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.rep, teams.east)
            member(users.mate, teams.east)
            member(users.lead, teams.east, "Manager")
            member(users.west, teams.west)
            // a product in a category, for the allocations
            make("mantle.product.Product", {productId: prefix + "_PROD", productName: "Forecast product", ownerPartyId: orgA})
            make("mantle.product.category.ProductCategory", {
                productCategoryId: prefix + "_CAT",
                categoryName: "Forecast category"
            })
            make("mantle.product.category.ProductCategoryMember", {
                productCategoryId: prefix + "_CAT",
                productId: prefix + "_PROD",
                fromDate: 0
            })
        })
        // this year's sales periods of A, by the manager; the quarter holding today is the default period
        as(users.manager, F + "ensure#SalesPeriods", {organizationPartyId: orgA})
        keys.quarter = as(users.manager, F + "get#Forecast", {
            organizationPartyId: orgA,
            currencyUomId: "USD"
        }).forecast?.timePeriodId
        const deal = (username, values) =>
            as(
                username,
                O + "create#Opportunity",
                Object.assign({organizationPartyId: orgA, currencyUomId: "USD", estimatedCloseDate: today()}, values)
            ).salesOpportunityId
        // the rep's: a stage-probability deal, a manual-probability deal, one with no close date, one in euros, a lead, a won deal
        deals.stage = deal(users.rep, {opportunityName: "Stage deal", estimatedAmount: "1000"})
        deals.manual = deal(users.rep, {opportunityName: "Manual deal", estimatedAmount: "500", estimatedProbability: "40"})
        deals.noDate = deal(users.rep, {opportunityName: "Undated deal", estimatedAmount: "300", estimatedCloseDate: null})
        deals.euro = deal(users.rep, {opportunityName: "Euro deal", estimatedAmount: "700", currencyUomId: "EUR"})
        deals.lead = deal(users.rep, {opportunityName: "A lead", typeEnumId: "SotLead", estimatedAmount: "50"})
        deals.won = deal(users.rep, {
            opportunityName: "Won deal",
            estimatedAmount: "200",
            recurringAmount: "30",
            recurringPlanEnumId: "SrpQuarterly"
        })
        as(users.rep, O + "close#Opportunity", {
            salesOpportunityId: deals.won,
            statusId: "SalesOppWon",
            expectedRevision: as(users.rep, O + "get#Opportunity", {salesOpportunityId: deals.won}).opportunity?.revision
        })
        // the mate's and West's deals
        deals.mate = deal(users.mate, {opportunityName: "Mate's deal", estimatedAmount: "100", estimatedProbability: "50"})
        deals.west = deal(users.west, {opportunityName: "West's deal", estimatedAmount: "9000", estimatedProbability: "90"})
        // placed orders of A this period: the rep's, one with no representative and a recurring base that never counts
        system(() => {
            const order = (orderId, values, ownerPartyId) => {
                make(
                    "mantle.order.OrderHeader",
                    Object.assign(
                        {
                            orderId,
                            statusId: "OrderPlaced",
                            placedDate: ec.user.nowTimestamp,
                            currencyUomId: "USD",
                            entryDate: ec.user.nowTimestamp
                        },
                        values
                    )
                )
                make("mantle.order.OrderPart", {
                    orderId,
                    orderPartSeqId: "01",
                    vendorPartyId: orgA,
                    customerPartyId: prefix + "_CUSTOMER",
                    statusId: "OrderPlaced"
                })
                if (ownerPartyId)
                    make("mantle.order.OrderPartParty", {
                        orderId,
                        orderPartSeqId: "01",
                        partyId: ownerPartyId,
                        roleTypeId: "SalesRepresentative"
                    })
            }
            order(prefix + "_ORD_REP", {grandTotal: 250}, users.rep)
            order(prefix + "_ORD_NONE", {grandTotal: 80}, null)
            order(prefix + "_ORD_BASE", {grandTotal: 999, orderPurposeEnumId: "OrpRecurringTemplate"}, users.rep)
        })
    }
})

feature(
    "the weighted pipeline equals its deals'; a deal with no date, a lead and another currency are left out with their reasons",
    {
        when() {
            const found = forecastOf(users.rep, {organizationPartyId: orgA, timePeriodId: keys.quarter})
            const stageRow = system(() => one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: deals.stage}))
            return {found, stageProbability: num(stageRow.estimatedProbability)}
        },
        then({found, stageProbability}) {
            found.refused == ""
            found.forecast.internalPartyId == users.rep
            found.forecast.timePeriodId == keys.quarter
            found.forecast.periodName.includes(" Q")
            measureOf(found, "open") == 1500
            measureOf(found, "weighted") == (1000 * stageProbability) / 100 + 200
            dealOf(found, deals.manual).included == true
            dealOf(found, deals.manual).manualProbability == true
            dealOf(found, deals.noDate).included == false
            dealOf(found, deals.noDate).reasonText == "No expected close date"
            dealOf(found, deals.lead).included == false
            dealOf(found, deals.lead).reasonText == "A lead, not yet qualified"
            dealOf(found, deals.euro).included == false
            dealOf(found, deals.euro).reasonText.includes("another currency")
            measureOf(found, "won") == 200
            measureOf(found, "wonMrr") == 10
            measureOf(found, "openMrr") == 0
            // the rep's placed order counts; the recurring base never does
            measureOf(found, "orders") == 250
            // the mate's deal is not the rep's
            dealOf(found, deals.mate) == null
            found.forecast.quotaAmount == null
            found.forecast.actualPercentText == ""
        }
    }
)

feature("a parent's roll-up counts a deal once across an owner change and never adds the children's entered forecasts", {
    when() {
        const target = (internalPartyId, quotaAmount, parentSalesForecastId = null) =>
            as(users.manager, F + "store#Target", {
                organizationPartyId: orgA,
                internalPartyId,
                timePeriodId: keys.quarter,
                currencyUomId: "USD",
                quotaAmount,
                parentSalesForecastId
            })
        keys.team = target(teams.east, "5000").salesForecastId
        keys.rep = target(users.rep, "3000", keys.team).salesForecastId
        keys.mate = target(users.mate, "0", keys.team).salesForecastId
        const repJudgement = as(users.rep, F + "store#Forecast", {
            salesForecastId: keys.rep,
            forecastAmount: "700",
            bestCaseAmount: "900",
            reason: "Two deals likely",
            expectedRevision: revisionOf(users.rep, keys.rep)
        }).refused
        const before = forecastOf(users.manager, {salesForecastId: keys.team})
        // the stage deal moves from the rep to the mate (the manager's owner change)
        const moved = as(users.manager, O + "store#OpportunityParty", {
            salesOpportunityId: deals.stage,
            partyId: users.mate,
            roleTypeId: "SalesRepresentative",
            expectedRevision: as(users.manager, O + "get#Opportunity", {salesOpportunityId: deals.stage}).opportunity?.revision
        }).refused
        return {
            repJudgement,
            moved,
            before,
            after: forecastOf(users.manager, {salesForecastId: keys.team}),
            rep: forecastOf(users.manager, {salesForecastId: keys.rep}),
            mate: forecastOf(users.manager, {salesForecastId: keys.mate})
        }
    },
    then({repJudgement, moved, before, after, rep, mate}) {
        repJudgement == ""
        moved == ""
        // the team's roll-up: the rep's and the mate's open deals, the stage deal once before and after its owner changed
        measureOf(before, "open") == 1600
        measureOf(after, "open") == 1600
        dealOf(after, deals.stage) != null
        dealOf(rep, deals.stage) == null
        dealOf(mate, deals.stage) != null
        measureOf(mate, "open") == 1100
        // the parent's own judgement is not the children's sum
        after.forecast.forecastAmount == null
        after.children.length == 2
        after.children.some(row => row.forecastText.includes("700"))
        // a zero quota gives no percentage; a set one does
        mate.forecast.actualPercentText == ""
        mate.forecast.forecastPercentText == ""
        rep.forecast.forecastPercentText != ""
    }
})

feature("a second forecast or target for a key, a cycle, a stale revision, a rep's target and another's judgement are refused", {
    when() {
        const key = {organizationPartyId: orgA, internalPartyId: users.rep, timePeriodId: keys.quarter, currencyUomId: "USD"}
        return {
            duplicateTarget: as(users.manager, F + "store#Target", Object.assign({quotaAmount: "1"}, key)).refused,
            duplicateForecast: as(users.rep, F + "store#Forecast", Object.assign({forecastAmount: "1"}, key)).refused,
            // West's target under East, then East under West: a cycle
            cycle: (() => {
                keys.west = as(users.manager, F + "store#Target", {
                    organizationPartyId: orgA,
                    internalPartyId: teams.west,
                    timePeriodId: keys.quarter,
                    currencyUomId: "USD",
                    quotaAmount: "100",
                    parentSalesForecastId: keys.team
                }).salesForecastId
                return as(users.manager, F + "store#Target", {
                    salesForecastId: keys.team,
                    quotaAmount: "5000",
                    parentSalesForecastId: keys.west,
                    expectedRevision: revisionOf(users.manager, keys.team)
                }).refused
            })(),
            stale: as(users.rep, F + "store#Forecast", {salesForecastId: keys.rep, forecastAmount: "800", expectedRevision: "1"})
                .refused,
            repTarget: as(users.rep, F + "store#Target", {
                salesForecastId: keys.rep,
                quotaAmount: "1",
                expectedRevision: revisionOf(users.rep, keys.rep)
            }).refused,
            mateJudges: as(users.mate, F + "store#Forecast", {
                salesForecastId: keys.rep,
                forecastAmount: "1",
                expectedRevision: revisionOf(users.manager, keys.rep)
            }).refused,
            mateSees: as(users.mate, F + "get#Forecast", {salesForecastId: keys.rep}).refused,
            leadSees: as(users.lead, F + "get#Forecast", {salesForecastId: keys.rep}).refused,
            leadTeam: as(users.lead, F + "get#Forecast", {salesForecastId: keys.team}).refused,
            westSees: as(users.west, F + "get#Forecast", {salesForecastId: keys.team}).refused,
            otherOrganization: as(users.repB, F + "get#Forecast", {salesForecastId: keys.rep}).refused,
            bestCase: as(users.rep, F + "store#Forecast", {
                salesForecastId: keys.rep,
                forecastAmount: "800",
                bestCaseAmount: "500",
                expectedRevision: revisionOf(users.rep, keys.rep)
            }).refused
        }
    },
    then(r) {
        r.duplicateTarget.includes("DUPLICATE_KEY")
        r.duplicateForecast.includes("FORECAST_EXISTS")
        r.cycle.includes("HIERARCHY_CYCLE")
        r.stale.includes("REVISION_CHANGED")
        r.repTarget.includes("PERMISSION_DENIED")
        r.mateJudges.includes("RECORD_UNAVAILABLE")
        r.mateSees.includes("RECORD_UNAVAILABLE")
        r.leadSees == ""
        r.leadTeam == ""
        r.westSees.includes("RECORD_UNAVAILABLE")
        r.otherOrganization.includes("RECORD_UNAVAILABLE")
        r.bestCase.includes("BEST_CASE_INVALID")
    }
})

feature("allocations reconcile to the forecast and never count a product both directly and through its category", {
    when() {
        const detail = values =>
            as(
                users.rep,
                F + "store#ForecastDetail",
                Object.assign({salesForecastId: keys.rep, expectedRevision: revisionOf(users.rep, keys.rep)}, values)
            )
        const category = detail({productCategoryId: prefix + "_CAT", amount: "400"})
        return {
            category: category.refused,
            overlap: detail({productId: prefix + "_PROD", amount: "100"}).refused,
            over: detail({productCategoryId: "_NA_", amount: "100"}).refused,
            both: detail({productId: prefix + "_PROD", productCategoryId: prefix + "_CAT", amount: "1"}).refused,
            tooMuch: as(users.rep, F + "store#Forecast", {
                salesForecastId: keys.rep,
                forecastAmount: "300",
                expectedRevision: revisionOf(users.rep, keys.rep)
            }).refused,
            moreThanForecast: detail({
                salesForecastDetailSeqId: category.salesForecastDetailSeqId,
                productCategoryId: prefix + "_CAT",
                amount: "701"
            }).refused,
            details: as(users.rep, F + "get#Forecast", {salesForecastId: keys.rep}).details
        }
    },
    then(r) {
        r.category == ""
        r.overlap.includes("DETAIL_OVERLAP")
        r.over.includes("CATEGORY_INVALID")
        r.both.includes("DIMENSION_REQUIRED")
        r.tooMuch.includes("DETAIL_OVER_FORECAST")
        r.moreThanForecast.includes("DETAIL_OVER_FORECAST")
        r.details.length == 1
        r.details[0].dimensionText == "Forecast category"
    }
})

feature("attainment compares each target with its own basis; orders with no representative apart, never a template", {
    when() {
        // the mate's target measured on placed orders (they have none); the team's on won deals
        const toOrders = as(users.manager, F + "store#Target", {
            salesForecastId: keys.rep,
            quotaAmount: "1000",
            basisEnumId: "SfbPlacedOrder",
            reason: "Measured on orders",
            expectedRevision: revisionOf(users.manager, keys.rep)
        }).refused
        const found = as(users.manager, F + "get#TargetAttainment", {
            organizationPartyId: orgA,
            timePeriodId: keys.quarter,
            currencyUomId: "USD"
        })
        const rows = Array.from(found.resultList || [])
        const audit = system(() =>
            Array.from(
                ec.entity
                    .find("moqui.entity.EntityAuditLog")
                    .condition({
                        changedEntityName: "mantle.sales.forecast.SalesForecast",
                        changedFieldName: "basisEnumId",
                        pkPrimaryValue: keys.rep
                    })
                    .list()
            )
        )
        return {
            toOrders,
            found,
            rep: rows.find(row => row.salesForecastId === keys.rep),
            team: rows.find(row => row.salesForecastId === keys.team),
            mate: rows.find(row => row.salesForecastId === keys.mate),
            audit: audit.map(row => row.newValueText + ":" + (row.changeReason || "")),
            repReport: as(users.rep, F + "get#TargetAttainment", {organizationPartyId: orgA, timePeriodId: keys.quarter}).refused
        }
    },
    then(r) {
        r.toOrders == ""
        r.found.refused == ""
        r.rep.basisEnumId == "SfbPlacedOrder"
        Number(String(r.rep.actualAmount)) == 250
        r.rep.sourceCount == 1
        r.team.basisEnumId == "SfbWonOpportunity"
        Number(String(r.team.actualAmount)) == 200
        r.mate.percentText == "No quota"
        r.found.unassignedList.length == 1
        r.found.unassignedList[0].amountText.includes("80")
        r.audit.includes("SfbPlacedOrder:Measured on orders")
        r.repReport.includes("PERMISSION_DENIED")
    }
})

feature(
    "an invoice counts for a reader who sees every order it bills; a team manager enters no member's judgement; the hierarchy and allocations hold",
    {
        when() {
            system(() => {
                for (const orderId of [prefix + "_ORD_REP", prefix + "_ORD_NONE"])
                    make("mantle.order.OrderItem", {
                        orderId,
                        orderItemSeqId: "01",
                        orderPartSeqId: "01",
                        itemTypeEnumId: "ItemProduct",
                        quantity: 1,
                        unitAmount: 1
                    })
                // the rep's order billed alone, and with the order of no representative on one invoice
                const invoice = (amounts, orderIds) => {
                    const invoiceId = make("mantle.account.invoice.Invoice", {
                        invoiceTypeEnumId: "InvoiceSales",
                        fromPartyId: orgA,
                        toPartyId: prefix + "_CUSTOMER",
                        statusId: "InvoiceFinalized",
                        invoiceDate: ec.user.nowTimestamp,
                        currencyUomId: "USD"
                    }).invoiceId
                    orderIds.forEach((orderId, index) => {
                        const invoiceItemSeqId = "0" + (index + 1)
                        const amount = amounts[index]
                        make("mantle.account.invoice.InvoiceItem", {
                            invoiceId,
                            invoiceItemSeqId,
                            itemTypeEnumId: "ItemProduct",
                            quantity: 1,
                            amount
                        })
                        make("mantle.order.OrderItemBilling", {
                            orderId,
                            orderItemSeqId: "01",
                            invoiceId,
                            invoiceItemSeqId,
                            quantity: 1,
                            amount
                        })
                    })
                }
                invoice([250], [prefix + "_ORD_REP"])
                invoice([250, 80], [prefix + "_ORD_REP", prefix + "_ORD_NONE"])
                // a second category holding the product, and another organization's category
                make("mantle.product.category.ProductCategory", {
                    productCategoryId: prefix + "_CAT2",
                    categoryName: "Forecast category 2"
                })
                make("mantle.product.category.ProductCategoryMember", {
                    productCategoryId: prefix + "_CAT2",
                    productId: prefix + "_PROD",
                    fromDate: 0
                })
                make("mantle.product.category.ProductCategory", {
                    productCategoryId: prefix + "_CAT_B",
                    categoryName: "B's",
                    ownerPartyId: orgB
                })
            })
            const detail = values =>
                as(
                    users.rep,
                    F + "store#ForecastDetail",
                    Object.assign({salesForecastId: keys.rep, expectedRevision: revisionOf(users.rep, keys.rep)}, values)
                ).refused
            return {
                rep: forecastOf(users.rep, {salesForecastId: keys.rep}),
                organization: forecastOf(users.manager, {
                    organizationPartyId: orgA,
                    internalPartyId: orgA,
                    timePeriodId: keys.quarter
                }),
                leadJudgesRep: as(users.lead, F + "store#Forecast", {
                    salesForecastId: keys.rep,
                    forecastAmount: "1",
                    expectedRevision: revisionOf(users.lead, keys.rep)
                }).refused,
                leadJudgesTeam: as(users.lead, F + "store#Forecast", {
                    salesForecastId: keys.team,
                    forecastAmount: "1500",
                    expectedRevision: revisionOf(users.lead, keys.team)
                }).refused,
                personParent: as(users.manager, F + "store#Target", {
                    salesForecastId: keys.mate,
                    quotaAmount: "0",
                    parentSalesForecastId: keys.rep,
                    expectedRevision: revisionOf(users.manager, keys.mate)
                }).refused,
                twoCategories: detail({productCategoryId: prefix + "_CAT2", amount: "1"}),
                otherCategory: detail({productCategoryId: prefix + "_CAT_B", amount: "1"})
            }
        },
        then(r) {
            // the rep sees the invoice of their order alone, not the one that also bills an order they do not see
            measureOf(r.rep, "invoices") == 250
            // the organization's reader counts both; the invoice of two differently attributed orders is unassigned
            measureOf(r.organization, "invoices") == 580
            measureOf(r.organization, "unassignedInvoices") == 330
            r.leadJudgesRep.includes("PERMISSION_DENIED")
            r.leadJudgesTeam == ""
            r.personParent.includes("PARENT_INVALID")
            r.twoCategories.includes("DETAIL_OVERLAP")
            r.otherCategory.includes("CATEGORY_INVALID")
        }
    }
)

feature("a measure past its row limit is refused, never counted short", {
    when() {
        system(() => {
            const day = ec.l10n.parseTimestamp(today() + " 12:00", "yyyy-MM-dd HH:mm")
            for (let index = 0; index <= 2000; index++)
                make("mantle.sales.opportunity.SalesOpportunity", {
                    salesOpportunityId: prefix + "_BULK_" + index,
                    organizationPartyId: orgA,
                    typeEnumId: "SotOpportunity",
                    opportunityName: "Bulk " + index,
                    currencyUomId: "USD",
                    estimatedAmount: 1,
                    estimatedCloseDate: day
                })
        })
        return {
            refused: forecastOf(users.manager, {organizationPartyId: orgA, internalPartyId: orgA, timePeriodId: keys.quarter})
                .refused
        }
    },
    then(r) {
        r.refused.includes("TOO_MANY_RECORDS")
    }
})
