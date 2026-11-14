// Sales' quote drafts (impl-sales P7; design-sales §5; mantle.order.SalesQuoteServices over SalesQuotes.js, SalesAccess.js quoteOf):
// the quotes are orders of purpose SalesQuote of the caller's scope, never a Shop cart or a recurring base; a rep sees their own and
// their team's, not another team's or organization's, and a manager the organization's; a quote is for one account of its seller;
// a line takes the seller's price for the customer (a customer price over the list price, for a rep without PRICE_VIEW), and an
// entered price keeps its calculated basis with the reason and actor; a free line needs SALES_APPROVE; a product with no price
// blocks the line until one is entered; a stale revision and another team's rep are refused. Standalone: spec-local organizations,
// teams, users, accounts, products and prices; the users' services run with artifact authorization on under a spec grant of the
// services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesQuoteDrafts
const prefix = "SQD"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.order.SalesQuoteServices."
const users = {}
const teams = {}
const accounts = {}
const products = {priced: prefix + "_PRICED", unpriced: prefix + "_UNPRICED", listed: prefix + "_LISTED"}
const quotes = {}

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
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: "USD"})
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
// a user, agent of the organization, in a spec group holding the permissions and the spec's service grant
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Quotes", lastName: kind})
    make("mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Quotes " + kind})
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
function account(kind, ownerPartyId) {
    const partyId = prefix + "_ACC_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Account " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    return partyId
}
function price(productId, values) {
    make(
        "mantle.product.ProductPrice",
        Object.assign(
            {
                productId,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD"
            },
            values
        )
    )
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
                .name(verb.includes(".") ? verb : service + verb)
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
// whether the user sees a record through the record link host (Chatter and Files), with authorization on
const linkVisible = (username, recordEntityName, recordId) =>
    as(username, "mantle.party.CommunicationServices.get#RecordLinkInfo", {recordEntityName, recordId, checkOnly: true})
        .recordVisible === true
const idsOf = found => Array.from(found.quoteList || []).map(row => row.orderId)
const revision = (username, orderId) => as(username, "get#Quote", {orderId}).quote?.orderRevision
const lineOf = (username, orderId, orderItemSeqId) =>
    Array.from(as(username, "get#Quote", {orderId}).lines || []).find(line => line.orderItemSeqId == orderItemSeqId)

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            organization(orgA, "Quotes A")
            organization(orgB, "Quotes B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Quotes spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Quotes spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.order\\.SalesQuoteServices\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            // the record link host, whose quote rule (check#QuoteAccess) is Sales' scope (P7 review)
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            const rep = ["SALES_VIEW", "SALES_QUOTE_EDIT"]
            users.rep = user("rep", orgA, rep)
            users.other = user("other", orgA, rep)
            users.manager = user("manager", orgA, rep.concat(["SALES_TEAM_VIEW"]))
            users.approver = user("approver", orgA, rep.concat(["SALES_APPROVE"]))
            users.reader = user("reader", orgA, ["SALES_VIEW"])
            users.repB = user("repb", orgB, rep)
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.rep, teams.east)
            member(users.approver, teams.east)
            member(users.reader, teams.east)
            member(users.other, teams.west)
            accounts.a = account("a", orgA)
            accounts.b = account("b", orgB)
            for (const productId of Object.values(products))
                make("mantle.product.Product", {
                    productId,
                    productName: productId,
                    productTypeEnumId: "PtAsset",
                    ownerPartyId: orgA
                })
            // the list price of A and the customer's own price, which a rep without PRICE_VIEW gets through the seller's authority
            price(products.priced, {vendorPartyId: orgA, priceTypeEnumId: "PptList", price: "100"})
            price(products.priced, {vendorPartyId: orgA, price: "100"})
            price(products.priced, {vendorPartyId: orgA, customerPartyId: accounts.a, price: "80"})
            // a Shop cart and a recurring base of A for the account, which are no quotes
            make("mantle.product.store.ProductStore", {
                productStoreId: prefix + "_STORE",
                storeName: "Quotes store",
                organizationPartyId: orgA
            })
            quotes.cart = call("mantle.order.OrderServices.create#Order", {
                productStoreId: prefix + "_STORE",
                customerPartyId: accounts.a
            }).orderId
            quotes.base = call("mantle.order.OrderServices.create#Order", {
                vendorPartyId: orgA,
                customerPartyId: accounts.a,
                orderPurposeEnumId: "OrpRecurringTemplate",
                statusId: "OrderApproved"
            }).orderId
        })
        quotes.rep = as(users.rep, "create#Quote", {customerPartyId: accounts.a, orderName: "Rep's quote"}).orderId
        quotes.other = as(users.other, "create#Quote", {organizationPartyId: orgA, customerPartyId: accounts.a}).orderId
        quotes.b = as(users.repB, "create#Quote", {organizationPartyId: orgB, customerPartyId: accounts.b}).orderId
    },
    cleanup() {
        login("john.doe")
    }
})

feature(
    "a cart and a recurring base are no quotes; a rep finds their own and their team's quotes, a manager the organization's",
    {
        when() {
            const created = one("mantle.order.OrderHeader", {orderId: quotes.rep})
            const part = one("mantle.order.OrderPart", {orderId: quotes.rep, orderPartSeqId: "01"})
            return {
                created,
                part,
                team: one("mantle.order.OrderPartParty", {orderId: quotes.rep, roleTypeId: "SalesTeam"}),
                rep: idsOf(as(users.rep, "find#Quotes", {state: "all"})),
                approver: idsOf(as(users.approver, "find#Quotes")),
                manager: idsOf(as(users.manager, "find#Quotes")),
                other: as(users.other, "get#Quote", {orderId: quotes.rep}),
                repB: as(users.repB, "get#Quote", {orderId: quotes.rep}),
                cart: as(users.manager, "get#Quote", {orderId: quotes.cart}),
                // Chatter and Files of a quote: Sales' scope, not every agent of the seller (P7 review)
                linked: Object.fromEntries(
                    ["rep", "approver", "manager", "other", "repB"].map(kind => [
                        kind,
                        linkVisible(users[kind], "mantle.order.OrderHeader", quotes.rep)
                    ])
                )
            }
        },
        then({created, part, team, rep, approver, manager, other, repB, cart, linked}) {
            created.orderPurposeEnumId == "OrpSalesQuote"
            created.statusId == "OrderOpen"
            created.productStoreId == null
            part.vendorPartyId == orgA
            part.customerPartyId == accounts.a
            part.validFromDate != null
            team.partyId == teams.east
            rep.length == 1
            rep[0] == quotes.rep
            approver.includes(quotes.rep)
            !approver.includes(quotes.other)
            manager.length == 2
            manager.includes(quotes.rep) && manager.includes(quotes.other)
            !manager.includes(quotes.cart) && !manager.includes(quotes.base) && !manager.includes(quotes.b)
            other.refused == "" && other.quoteFound == false
            repB.quoteFound == false
            cart.quoteFound == false
            linked.rep && linked.approver && linked.manager
            !linked.other && !linked.repB
        }
    }
)

feature("a quote is for one account of its seller: another organization's account and a reader are refused", {
    when() {
        return {
            otherAccount: as(users.rep, "create#Quote", {organizationPartyId: orgA, customerPartyId: accounts.b}).refused,
            otherOrganization: as(users.rep, "create#Quote", {organizationPartyId: orgB, customerPartyId: accounts.b}).refused,
            reader: as(users.reader, "create#Quote", {organizationPartyId: orgA, customerPartyId: accounts.a}).refused,
            readerFinds: as(users.reader, "find#Quotes").refused
        }
    },
    then({otherAccount, otherOrganization, reader, readerFinds}) {
        otherAccount.includes("RECORD_UNAVAILABLE")
        otherOrganization.includes("ORGANIZATION_DENIED")
        reader.includes("PERMISSION_DENIED")
        readerFinds == ""
    }
})

feature("a line takes the customer's price; an entered price keeps its calculated basis with the reason and actor", {
    when() {
        const added = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            productId: products.priced,
            quantity: "2"
        })
        const priced = lineOf(users.rep, quotes.rep, added.orderItemSeqId)
        const noReason = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            orderItemSeqId: added.orderItemSeqId,
            unitAmount: "70"
        }).refused
        const stale = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: String(Number(revision(users.rep, quotes.rep)) - 1),
            orderItemSeqId: added.orderItemSeqId,
            unitAmount: "70",
            overrideReason: "Volume deal"
        }).refused
        as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            orderItemSeqId: added.orderItemSeqId,
            unitAmount: "70",
            overrideReason: "Volume deal"
        })
        const item = one("mantle.order.OrderItem", {orderId: quotes.rep, orderItemSeqId: added.orderItemSeqId})
        // a quantity change keeps the entered price and refreshes the basis
        as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            orderItemSeqId: added.orderItemSeqId,
            quantity: "3"
        })
        const kept = one("mantle.order.OrderItem", {orderId: quotes.rep, orderItemSeqId: added.orderItemSeqId})
        const explained = as(users.rep, "explain#QuoteLinePrice", {
            orderId: quotes.rep,
            orderItemSeqId: added.orderItemSeqId
        }).explanation
        const total = one("mantle.order.OrderHeader", {orderId: quotes.rep}).grandTotal
        return {added, priced, noReason, stale, item, kept, explained, total}
    },
    then({added, priced, noReason, stale, item, kept, explained, total}) {
        added.refused == ""
        priced.unitAmount != null && toDecimal(priced.unitAmount).eq(toDecimal("80"))
        priced.priceSource == "product-price"
        priced.overridden == false
        noReason.includes("OVERRIDE_REASON_REQUIRED")
        stale.includes("REVISION_CHANGED")
        toDecimal(item.unitAmount).eq(toDecimal("70"))
        toDecimal(item.calculatedUnitAmount).eq(toDecimal("80"))
        toDecimal(item.unitListPrice).eq(toDecimal("100"))
        item.priceSource == "manual"
        item.priceOverrideReason == "Volume deal"
        item.priceOverrideUserId == users.rep
        item.isModifiedPrice == "Y"
        toDecimal(kept.unitAmount).eq(toDecimal("70"))
        toDecimal(kept.quantity).eq(toDecimal("3"))
        kept.priceSource == "manual"
        explained.overridden == true
        explained.customerPrice == true
        explained.overrideReason == "Volume deal"
        toDecimal(total).eq(toDecimal("210"))
    }
})

feature("a missing price blocks the line until one is entered; a free line needs a sales approver", {
    when() {
        const missing = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            productId: products.unpriced
        }).refused
        const entered = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            productId: products.unpriced,
            unitAmount: "45",
            overrideReason: "Quoted by phone"
        })
        const free = {
            orderId: quotes.rep,
            productId: products.priced,
            freeLine: "Y",
            overrideReason: "Sample unit"
        }
        const repFree = as(
            users.rep,
            "store#QuoteLine",
            Object.assign({orderRevision: revision(users.rep, quotes.rep)}, free)
        ).refused
        const approverFree = as(
            users.approver,
            "store#QuoteLine",
            Object.assign({orderRevision: revision(users.approver, quotes.rep)}, free)
        )
        const shipping = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            itemTypeEnumId: "ItemShipping",
            unitAmount: "25"
        })
        return {
            missing,
            entered,
            enteredLine: lineOf(users.rep, quotes.rep, entered.orderItemSeqId),
            repFree,
            approverFree,
            freeLine: lineOf(users.rep, quotes.rep, approverFree.orderItemSeqId),
            shippingLine: lineOf(users.rep, quotes.rep, shipping.orderItemSeqId)
        }
    },
    then({missing, entered, enteredLine, repFree, approverFree, freeLine, shippingLine}) {
        missing.includes("PRICE_UNAVAILABLE")
        entered.refused == ""
        enteredLine.priceAvailable == false
        enteredLine.priceSource == "manual"
        repFree.includes("FREE_LINE_DENIED")
        approverFree.refused == ""
        freeLine.priceSource == "free"
        toDecimal(freeLine.unitAmount).isZero()
        shippingLine.shipping == true
        toDecimal(shippingLine.unitAmount).eq(toDecimal("25"))
    }
})

feature("another team's rep cannot change the quote; a removed line is gone", {
    when() {
        const line = Array.from(as(users.rep, "get#Quote", {orderId: quotes.rep}).lines).find(row => row.shipping)
        const parameters = {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            orderItemSeqId: line.orderItemSeqId
        }
        const other = as(users.other, "delete#QuoteLine", parameters).refused
        const reader = as(users.reader, "delete#QuoteLine", parameters).refused
        const removed = as(users.rep, "delete#QuoteLine", parameters).refused
        return {
            other,
            reader,
            removed,
            gone: one("mantle.order.OrderItem", {orderId: quotes.rep, orderItemSeqId: line.orderItemSeqId})
        }
    },
    then({other, reader, removed, gone}) {
        other.includes("RECORD_UNAVAILABLE")
        reader.includes("PERMISSION_DENIED")
        removed == ""
        gone == null
    }
})

// P7 review: the seller's authority reads a rule's base list as it reads the list itself (a rep without PRICE_VIEW was refused)
feature("a line priced by the seller's published list whose rule is based on another of its lists", {
    when() {
        const S = "mantle.product.PriceServices."
        system(() => {
            const list = (listName, priority, rules) => {
                const priceListId = call(S + "store#ProductPriceList", {
                    listName,
                    organizationPartyId: orgA,
                    direction: "sales",
                    priceUomId: "USD",
                    priority,
                    fromDate: 0,
                    changeReason: "Spec list"
                }).priceListId
                call(
                    S + "store#ProductPriceRule",
                    Object.assign(
                        {
                            priceListId,
                            sequenceNum: 10,
                            selector: "product",
                            productId: products.listed,
                            fromDate: 0,
                            percentChange: 0,
                            amountChange: 0,
                            changeReason: "Spec rule"
                        },
                        rules
                    )
                )
                const preview = call(S + "get#ProductPriceListPublication", {priceListId})
                call(S + "publish#ProductPriceList", {
                    priceListId,
                    publicationToken: preview.publicationToken,
                    changeReason: "Spec publication"
                })
                return priceListId
            }
            const base = list("Quotes base", 200, {baseType: "fixed", fixedPrice: 50})
            // the outer list first (a lower priority number)
            list("Quotes outer", 10, {baseType: "list", basePriceListId: base, percentChange: 10})
        })
        const added = as(users.rep, "store#QuoteLine", {
            orderId: quotes.rep,
            orderRevision: revision(users.rep, quotes.rep),
            productId: products.listed
        })
        return {added, line: added.orderItemSeqId ? lineOf(users.rep, quotes.rep, added.orderItemSeqId) : null}
    },
    then({added, line}) {
        added.refused == ""
        line.priceSource == "price-list"
        toDecimal(line.unitAmount).eq(toDecimal("55"))
    }
})
