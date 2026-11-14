// Sales' quote templates (impl-sales P12, §4 Nov 11; design-sales §5 QuoteTemplates and QuoteTemplateDetail, SAL-TEMPLATE;
// mantle.order.SalesQuoteServices find#, get#, store#, publish# and preview#QuoteTemplate, create#Quote's templateOrderId): a manager
// keeps a draft template of the quote draft's lines (a product priced on the quote's date, a fixed price with its reason, a charge),
// which a rep, another organization's manager and a published template's edit are refused; a quote copied from the published
// template is priced as of its own date, the fixed line keeping its price beside today's basis; a published successor ends the
// template and leaves the earlier quote's terms; a template is never placed, reserved, counted as an order or offered as a quote.
// Standalone: SalesQuoteIssueFixtures (organizations A and B, the rep, a priced product) and spec-local managers and a product.
// Run: ./moq test mr-mantle --spec SalesQuoteTemplates
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {call, system, as, make, one, revision, status} = fx
const Q = "mantle.order.SalesQuoteServices."
let f
const t = {}

const items = orderId =>
    system(() =>
        Array.from(ec.entity.find("mantle.order.OrderItem").condition("orderId", orderId).orderBy("orderItemSeqId").list())
    )
const productLine = (orderId, productId) => items(orderId).find(item => item.productId === productId)
const num = value => (value == null ? null : Number(String(value)))
const part = orderId => system(() => ec.entity.find("mantle.order.OrderPart").condition("orderId", orderId).one())
// a native order service as the system: its refusal, or ""
function nativeRefusal(name, parameters) {
    return system(() => {
        ec.message.pushErrors()
        try {
            ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call()
            return ec.message.hasError() ? ec.message.getErrorsString() : ""
        } catch (error) {
            return String(error.message)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    })
}

spec({
    stepwise: true,
    setupSpec() {
        f = fx.setup("SQT")
        system(() => {
            const manager = ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_QUOTE_EDIT", "SALES_TEAM_MANAGE"]
            t.manager = fx.addUser(f, "manager", [f.orgA], manager)
            t.managerB = fx.addUser(f, "managerb", [f.orgB], manager)
            // P12 review: a person of A with no Sales permission (another app's user of the organization)
            t.clerk = fx.addUser(f, "clerk", [f.orgA], [])
            // the record rule's service opened to the spec's users, filtered by their organizations (as an app's root grants it)
            make("moqui.security.ArtifactGroup", {artifactGroupId: f.prefix + "_RLI", description: "Template record links"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: f.prefix + "_RLI",
                artifactTypeEnumId: "AT_SERVICE",
                artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: f.prefix + "_RLI",
                userGroupId: f.prefix + "_GRANT",
                artifactGroupId: f.prefix + "_RLI",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            make("moqui.security.ArtifactAuthzFilter", {artifactAuthzId: f.prefix + "_RLI", entityFilterSetId: "MANTLE_USER_ORG"})
            // a product A sells at 50, which the template fixes at a contract rate
            t.fixed = f.prefix + "_FIXED"
            make("mantle.product.Product", {productId: t.fixed, productName: "Contract service", productTypeEnumId: "PtService"})
            make("mantle.product.ProductPrice", {
                productId: t.fixed,
                vendorPartyId: f.orgA,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD",
                price: "50"
            })
            // a product A prices for its account a alone: a template line with no price of its own, priced on each quote
            t.customerOnly = f.prefix + "_CUSTOMER"
            make("mantle.product.Product", {
                productId: t.customerOnly,
                productName: "Account rate",
                productTypeEnumId: "PtService"
            })
            make("mantle.product.ProductPrice", {
                productId: t.customerOnly,
                vendorPartyId: f.orgA,
                customerPartyId: f.accounts.a,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD",
                price: "70"
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "a manager keeps a draft template of quote lines and publishes it; a rep, another organization and a published edit refused",
    {
        when() {
            const created = as(t.manager, Q + "store#QuoteTemplate", {
                organizationPartyId: f.orgA,
                orderName: "Standard install",
                templateDescription: "Two days' service and the contract rate",
                templateValidityDays: "14"
            })
            t.first = created.orderId
            const line = values =>
                as(t.manager, Q + "store#QuoteLine", Object.assign({orderId: t.first, orderRevision: revision(t.first)}, values))
            const product = line({productId: f.product, quantity: 2})
            const fixed = line({productId: t.fixed, quantity: 1, unitAmount: 45, overrideReason: "Contract rate"})
            const shipping = line({itemTypeEnumId: "ItemShipping", unitAmount: 25, itemDescription: "Freight"})
            const unpriced = line({productId: t.customerOnly, quantity: 1})
            // the same change by a rep (no template upkeep) and by B's manager (another organization's template: missing)
            const repEdit = as(f.users.rep, Q + "store#QuoteTemplate", {
                orderId: t.first,
                orderRevision: revision(t.first),
                orderName: "Mine"
            }).refused
            const otherEdit = as(t.managerB, Q + "store#QuoteTemplate", {
                orderId: t.first,
                orderRevision: revision(t.first),
                orderName: "Mine"
            }).refused
            const repDraft = as(f.users.rep, Q + "get#QuoteTemplate", {orderId: t.first}).templateFound
            const preview = as(f.users.rep, Q + "preview#QuoteTemplate", {orderId: t.first}).refused
            const managerPreview = as(t.manager, Q + "preview#QuoteTemplate", {orderId: t.first, customerPartyId: f.accounts.a})
            const published = as(t.manager, Q + "publish#QuoteTemplate", {orderId: t.first, orderRevision: revision(t.first)})
            const publishedEdit = line({productId: f.product, quantity: 1}).refused
            const repFind = as(f.users.rep, Q + "find#QuoteTemplates", {organizationPartyId: f.orgA})
            const repSees = as(f.users.rep, Q + "get#QuoteTemplate", {orderId: t.first})
            const otherFind = as(t.managerB, Q + "find#QuoteTemplates", {})
            return {
                created,
                product,
                fixed,
                shipping,
                unpriced,
                unpricedLine: productLine(t.first, t.customerOnly),
                repEdit,
                otherEdit,
                repDraft,
                preview,
                managerPreview,
                published,
                publishedEdit,
                repFind,
                repSees,
                otherFind
            }
        },
        then(r) {
            r.created.refused == "" && !!t.first
            r.product.refused == "" && r.fixed.refused == "" && r.shipping.refused == ""
            r.unpriced.refused == "" && r.unpricedLine.calculatedUnitAmount == null && r.unpricedLine.priceSource == null
            r.repEdit.includes("PERMISSION_DENIED")
            r.otherEdit.includes("RECORD_UNAVAILABLE")
            r.repDraft == false
            r.preview.includes("RECORD_UNAVAILABLE")
            r.managerPreview.refused == "" && r.managerPreview.lines.length == 4
            r.managerPreview.preview.totalText.includes("340")
            r.published.refused == "" && r.published.state == "current"
            r.publishedEdit.includes("TEMPLATE_PUBLISHED")
            r.repFind.templateList.map(row => row.orderId).includes(t.first) && r.repFind.canManage == false
            r.repSees.templateFound && r.repSees.template.canEdit == false && r.repSees.template.canQuote == true
            r.repSees.lines.find(line => line.fixed).pricingText.includes("Contract rate")
            !r.otherFind.templateList.some(row => row.orderId == t.first)
        }
    }
)

feature("a quote from the template is priced as of its own date; the fixed line keeps its price beside today's basis", {
    when() {
        // A's price of the product rises from 100 to 120 after the template was made
        system(() => {
            const now = ec.user.nowTimestamp
            const old = ec.entity
                .find("mantle.product.ProductPrice")
                .condition({productId: f.product, vendorPartyId: f.orgA})
                .one()
            call("update#mantle.product.ProductPrice", {productPriceId: old.productPriceId, thruDate: now})
            make("mantle.product.ProductPrice", {
                productId: f.product,
                vendorPartyId: f.orgA,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: now,
                minQuantity: 1,
                priceUomId: "USD",
                price: "120"
            })
        })
        const created = as(f.users.rep, Q + "create#Quote", {customerPartyId: f.accounts.a, templateOrderId: t.first})
        t.quote = created.orderId
        const header = one("mantle.order.OrderHeader", {orderId: t.quote})
        const quotePart = part(t.quote)
        const owner = one("mantle.order.OrderPartParty", {orderId: t.quote, roleTypeId: "SalesRepresentative"})
        const wrongCurrency = as(f.users.rep, Q + "create#Quote", {
            customerPartyId: f.accounts.a,
            templateOrderId: t.first,
            currencyUomId: "EUR"
        }).refused
        const otherOrganization = as(f.users.rep, Q + "create#Quote", {
            organizationPartyId: f.orgB,
            customerPartyId: f.accounts.b,
            templateOrderId: t.first
        }).refused
        return {
            created,
            header,
            days: Math.round((Number(quotePart.validThruDate) - Number(quotePart.validFromDate)) / 86400000),
            ownerPartyId: owner?.partyId,
            product: productLine(t.quote, f.product),
            fixed: productLine(t.quote, t.fixed),
            shipping: items(t.quote).find(item => item.itemTypeEnumId == "ItemShipping"),
            customerOnly: productLine(t.quote, t.customerOnly),
            templateProduct: productLine(t.first, f.product),
            quoteView: as(f.users.rep, Q + "get#Quote", {orderId: t.quote}),
            wrongCurrency,
            otherOrganization
        }
    },
    then(r) {
        r.created.refused == "" && r.created.warnings.length == 0
        r.header.orderPurposeEnumId == "OrpSalesQuote" && r.header.parentOrderId == t.first && r.header.statusId == "OrderOpen"
        r.header.orderName == "Standard install" && r.header.templateDescription == null
        r.days == 14
        r.ownerPartyId == f.users.rep
        num(r.product.unitAmount) == 120 && num(r.product.calculatedUnitAmount) == 120 && r.product.priceSource != "manual"
        num(r.fixed.unitAmount) == 45 && num(r.fixed.calculatedUnitAmount) == 50 && r.fixed.priceSource == "manual"
        r.fixed.priceOverrideReason == "Contract rate" && r.fixed.priceOverrideUserId == f.users.rep
        num(r.shipping.unitAmount) == 25
        num(r.customerOnly.unitAmount) == 70
        num(r.templateProduct.unitAmount) == 100
        r.quoteView.quoteFound && r.quoteView.quote.canEdit
        r.wrongCurrency.includes("TEMPLATE_CURRENCY")
        r.otherOrganization.includes("TEMPLATE_INVALID")
    }
})

feature("a published successor ends the template and leaves the earlier quote's terms; the next quote copies the successor", {
    when() {
        const quoteRevision = revision(t.quote)
        const successor = as(t.manager, Q + "store#QuoteTemplate", {predecessorOrderId: t.first})
        t.second = successor.orderId
        const second = as(t.manager, Q + "store#QuoteTemplate", {predecessorOrderId: t.first}).refused
        const changed = as(t.manager, Q + "store#QuoteLine", {
            orderId: t.second,
            orderRevision: revision(t.second),
            orderItemSeqId: productLine(t.second, f.product).orderItemSeqId,
            quantity: 3
        })
        const published = as(t.manager, Q + "publish#QuoteTemplate", {orderId: t.second, orderRevision: revision(t.second)})
        const firstView = as(t.manager, Q + "get#QuoteTemplate", {orderId: t.first})
        const repOld = as(f.users.rep, Q + "create#Quote", {customerPartyId: f.accounts.a, templateOrderId: t.first}).refused
        const managerOld = as(t.manager, Q + "create#Quote", {customerPartyId: f.accounts.a, templateOrderId: t.first}).refused
        const next = as(f.users.rep, Q + "create#Quote", {customerPartyId: f.accounts.a, templateOrderId: t.second})
        return {
            quoteRevision,
            successor,
            second,
            changed,
            published,
            firstView,
            repOld,
            managerOld,
            next,
            earlier: productLine(t.quote, f.product),
            earlierRevision: revision(t.quote),
            nextLine: productLine(next.orderId, f.product)
        }
    },
    then(r) {
        r.successor.refused == "" && one("mantle.order.OrderHeader", {orderId: t.second}).parentOrderId == t.first
        r.second.includes("SUCCESSOR_EXISTS")
        r.changed.refused == ""
        r.published.refused == "" && r.published.predecessorOrderId == t.first
        r.firstView.template.state == "ended" && r.firstView.template.successorOrderId == t.second
        r.repOld.includes("RECORD_UNAVAILABLE")
        r.managerOld.includes("TEMPLATE_UNAVAILABLE")
        num(r.earlier.quantity) == 2 && num(r.earlier.unitAmount) == 120 && r.earlierRevision == r.quoteRevision
        r.next.refused == "" && num(r.nextLine.quantity) == 3
    }
})

feature("a template is never placed, reserved, counted as an order or offered as a quote", {
    when() {
        const quoteIds = as(t.manager, Q + "find#Quotes", {organizationPartyId: f.orgA, state: "all"}).quoteList.map(
            row => row.orderId
        )
        const orderIds = as(t.manager, "mantle.sales.SalesWorkspaceServices.find#SalesOrders", {
            organizationPartyId: f.orgA,
            list: "recent"
        }).orderList.map(row => row.orderId)
        return {
            quoteIds,
            orderIds,
            asQuote: as(t.manager, Q + "get#Quote", {orderId: t.second}).quoteFound,
            proposed: as(t.manager, Q + "propose#Quote", {orderId: t.second, orderRevision: revision(t.second)}).refused,
            placed: nativeRefusal("mantle.order.OrderServices.place#Order", {orderId: t.second, requireInventory: false}),
            statusId: status(t.second),
            // P12 review: no other app's record view shows a template as an order (get#RecordLinkInfo, behind Chatter, files,
            // product connections): a Sales reader of A sees the current one only, a template manager every one
            visible: Object.fromEntries(
                [
                    ["clerkCurrent", t.clerk, t.second],
                    ["repCurrent", f.users.rep, t.second],
                    ["repEnded", f.users.rep, t.first],
                    ["managerEnded", t.manager, t.first]
                ].map(([name, user, orderId]) => [
                    name,
                    as(user, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
                        recordEntityName: "mantle.order.OrderHeader",
                        recordId: orderId,
                        checkOnly: true
                    }).recordVisible
                ])
            ),
            reservations: system(() =>
                ec.entity.find("mantle.product.issuance.AssetReservation").condition("orderId", "in", [t.first, t.second]).count()
            )
        }
    },
    then(r) {
        r.quoteIds.includes(t.quote) && !r.quoteIds.includes(t.first) && !r.quoteIds.includes(t.second)
        !r.orderIds.includes(t.first) && !r.orderIds.includes(t.second)
        r.asQuote == false
        r.proposed.includes("RECORD_UNAVAILABLE")
        r.placed.includes("QUOTE_TEMPLATE") && r.statusId == "OrderOpen"
        r.reservations == 0
        r.visible.clerkCurrent == false && r.visible.repCurrent == true
        r.visible.repEnded == false && r.visible.managerEnded == true
    }
})
