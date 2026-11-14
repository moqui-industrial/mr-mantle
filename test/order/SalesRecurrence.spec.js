// Sales' recurring orders (impl-sales P16, F22, §4 Q7; design-sales §7 RecurringOrders and Subscriptions, §13.1;
// mantle.order.SalesRecurrenceServices and the worker OrderServices.create#RecurringOrders, create#RecurringOrder): an approved order
// becomes a monthly base in its own zone, an approved copy marked OrpRecurringTemplate with no payment, never invoiced, shipped or
// listed as a sales order, the order it came from untouched; a keeper of another organization and a reader without the right are
// refused; two runs of the due occurrence and the job make one order, placed with no payment copied, for that occurrence; a paused
// base and an ended one make none, and a resumed base skips the paused occurrence; a base whose agreement ended fails, named on the
// base, and the next base still runs; a Shop contract's base is only Shop's; Subscriptions in Sales' context show a storeless
// subscription of a generated order beside a store contract, and a follow-up is a task on the customer. Follow-up 2 (§4 Nov 14): a
// base repeats the source's charge and discount lines with its products, each under its own parent; the order made is taxed then
// by its seller's gateway (X1), not given the source's tax; with auto-invoice on it is billed once a person approves it, once, and a
// base without it bills nothing.
// Standalone: SalesQuoteIssueFixtures (organizations A and B, accounts, a priced product) and spec-local users and records.
// Run: ./moq test mr-mantle --spec SalesRecurrence
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {call, system, as, make, one, key} = fx
const svc = "mantle.order.SalesRecurrenceServices."
const dayMs = 24 * 60 * 60 * 1000
const zone = "America/Denver"
let f
const users = {}
const ids = {}

const header = orderId => one("mantle.order.OrderHeader", {orderId})
const children = baseOrderId =>
    system(() => Array.from(ec.entity.find("mantle.order.OrderHeader").condition("parentOrderId", baseOrderId).list()))
const count = (entity, values) => system(() => ec.entity.find(entity).condition(values).count())
const code = refused => (/^(?:Error: )?([A-Z][A-Z0-9_]+):/.exec(String(refused || "").trim()) || [])[1] || String(refused || "")
// an approved sales order of the organization for the account, with one line and an authorized payment of its total: its id
function approvedOrder(organizationPartyId, customerPartyId) {
    return system(() => {
        const created = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: organizationPartyId,
            customerPartyId,
            currencyUomId: "USD"
        })
        call("mantle.order.OrderServices.create#OrderItem", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId: f.product,
            itemTypeEnumId: "ItemProduct",
            quantity: 2,
            unitAmount: 100,
            requireInventory: false
        })
        call("mantle.order.OrderServices.place#Order", {orderId: created.orderId, requireInventory: false})
        make("mantle.account.payment.Payment", {
            paymentTypeEnumId: "PtInvoicePayment",
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            fromPartyId: customerPartyId,
            toPartyId: organizationPartyId,
            statusId: "PmntAuthorized",
            amount: 200,
            amountUomId: "USD"
        })
        call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
        return created.orderId
    })
}
// a service call that commits on its own (an approval's tx-commit rules run after it)
const committed = (name, parameters) =>
    system(() => ec.service.sync().name(name).parameters(parameters).disableAuthz().requireNewTransaction(true).call() || {})
const lines = orderId =>
    system(() =>
        Array.from(ec.entity.find("mantle.order.OrderItem").condition("orderId", orderId).orderBy("orderItemSeqId").list())
    )
const taxTypes = ["ItemSalesTax", "ItemVatTax"]
const amountOf = row => toDecimal(row.quantity ?? 1).multiply(toDecimal(row.unitAmount ?? 0))
const taxTotal = orderId =>
    lines(orderId)
        .filter(row => taxTypes.includes(row.itemTypeEnumId))
        .reduce((sum, row) => sum.add(amountOf(row)), toDecimal(0))
// follow-up 2: an approved storeless order of C (its seller's gateway taxes it) with a product line, a shipping charge and a
// discount of the product line, so its tax lines leave gaps in the line ids (each line change retaxes it)
function chargedOrder() {
    return system(() => {
        const created = call("mantle.order.OrderServices.create#Order", {
            vendorPartyId: f.orgC,
            customerPartyId: f.accounts.c,
            currencyUomId: "USD"
        })
        const item = values =>
            call(
                "mantle.order.OrderServices.create#OrderItem",
                Object.assign({orderId: created.orderId, orderPartSeqId: created.orderPartSeqId, requireInventory: false}, values)
            ).orderItemSeqId
        const product = item({productId: f.product, itemTypeEnumId: "ItemProduct", quantity: 2, unitAmount: 100})
        item({itemTypeEnumId: "ItemShipping", quantity: 1, unitAmount: 15, itemDescription: "Freight"})
        item({itemTypeEnumId: "ItemDiscount", quantity: 1, unitAmount: -20, parentItemSeqId: product, itemDescription: "Loyalty"})
        call("mantle.order.OrderServices.place#Order", {orderId: created.orderId, requireInventory: false})
        call("mantle.order.OrderServices.approve#Order", {orderId: created.orderId})
        return created.orderId
    })
}
// a value read again until it is truthy, for up to five seconds (what runs after a commit, on a service worker)
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
}
const monthly = (extra = {}) =>
    Object.assign(
        {
            frequency: "monthly",
            dayOfMonth: "1",
            hourOfDay: "6",
            recurTimeZone: zone,
            recurFromDate: String(Date.now() - 60 * dayMs)
        },
        extra
    )
const revisionOf = baseOrderId => String(header(baseOrderId).recurRevision ?? 1)
const run = baseOrderId =>
    system(() => {
        ec.message.pushErrors()
        try {
            return call("mantle.order.OrderServices.create#RecurringOrder", {baseOrderId}).orderId || null
        } catch (error) {
            return "error: " + error.message
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    })

spec({
    stepwise: true,
    setupSpec() {
        f = fx.setup("SRC")
        system(() => {
            const user = (kind, organizationPartyIds, permissions) => fx.addUser(f, kind, organizationPartyIds, permissions)
            users.keeper = user("keeper", [f.orgA], ["SALES_VIEW", "SALES_RECURRENCE_MANAGE", "SALES_ACCOUNT_EDIT"])
            users.keeperB = user("keeperb", [f.orgB], ["SALES_VIEW", "SALES_RECURRENCE_MANAGE", "SALES_ACCOUNT_EDIT"])
            users.reader = user("reader", [f.orgA], ["SALES_VIEW", "SALES_TEAM_VIEW"])
            users.finance = user("finance", [f.orgA], ["SALES_VIEW", "SALES_RECURRENCE_MANAGE", "RECEIVABLE_EDIT"])
            // follow-up 2: a keeper with the finance right of C, the seller with a tax gateway and no store
            users.financeC = user("financec", [f.orgC], ["SALES_VIEW", "SALES_RECURRENCE_MANAGE", "RECEIVABLE_EDIT"])
            make("mantle.other.tax.TaxAuthority", {
                taxAuthorityId: f.prefix + "_UT",
                taxAuthorityTypeEnumId: "TatState",
                taxAuthGeoId: "USA_UT",
                description: "Recurrence Utah"
            })
            make("mantle.other.tax.TaxAuthorityParty", {
                taxAuthorityId: f.prefix + "_UT",
                partyId: f.orgC,
                fromDate: 0,
                isNexus: "Y"
            })
            make("mantle.other.tax.TaxAuthorityRate", {
                taxAuthorityRateId: f.prefix + "_RATE",
                taxAuthorityId: f.prefix + "_UT",
                rateTypeEnumId: "TarSalesTax",
                taxPercentage: "6",
                taxShipping: "Y",
                fromDate: 0
            })
            // a finance reader of A (the review's check that a customer's finance lists no base as an order)
            users.receivables = user("receivables", [f.orgA], ["RECEIVABLE_VIEW"])
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: f.prefix + "_SERVICES",
                artifactName: "mantle.account.CustomerFinanceServices.get#CustomerFinance",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "N"
            })
            // a store of A whose contract renews a base of its own (Shop's)
            make("mantle.product.store.ProductStore", {
                productStoreId: f.prefix + "_STORE",
                storeName: "Recurrence store",
                organizationPartyId: f.orgA,
                defaultCurrencyUomId: "USD"
            })
            make("mantle.party.agreement.Agreement", {
                agreementId: f.prefix + "_AGR",
                agreementTypeEnumId: "AgrSales",
                organizationPartyId: f.orgA,
                otherPartyId: f.accounts.a,
                statusId: "AgmStActive",
                description: "Recurrence terms",
                fromDate: 0
            })
        })
        ids.source = approvedOrder(f.orgA, f.accounts.a)
    }
})

feature("an approved order becomes a monthly base: a template every reader leaves out", {
    when() {
        const reader = as(users.reader, svc + "store#SalesRecurrence", monthly({orderId: ids.source}))
        const other = as(users.keeperB, svc + "store#SalesRecurrence", monthly({orderId: ids.source}))
        const invoiced = as(users.keeper, svc + "store#SalesRecurrence", monthly({orderId: ids.source, recurAutoInvoice: "Y"}))
        const stored = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({orderId: ids.source, recurAgreementId: f.prefix + "_AGR"})
        )
        ids.base = stored.baseOrderId
        const stale = as(users.keeper, svc + "store#SalesRecurrence", monthly({baseOrderId: ids.base, recurRevision: "5"}))
        const edited = as(
            users.finance,
            svc + "store#SalesRecurrence",
            monthly({
                baseOrderId: ids.base,
                recurRevision: revisionOf(ids.base),
                hourOfDay: "7",
                recurAutoInvoice: "Y",
                reason: "Bill on approval"
            })
        )
        const back = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({baseOrderId: ids.base, recurRevision: revisionOf(ids.base), hourOfDay: "7", recurAutoInvoice: "N"})
        )
        const invoice = system(() => {
            ec.message.pushErrors()
            try {
                call("mantle.account.InvoiceServices.create#EntireOrderPartInvoice", {orderId: ids.base, orderPartSeqId: "01"})
                return ""
            } catch (error) {
                return String(error.message)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        })
        const shipment = system(() => {
            ec.message.pushErrors()
            try {
                call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {orderId: ids.base, orderPartSeqId: "01"})
                return ""
            } catch (error) {
                return String(error.message)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        })
        const listed = as(users.keeper, svc + "find#RecurringSalesOrders", {}).recurrenceList || []
        const listedB = as(users.keeperB, svc + "find#RecurringSalesOrders", {}).recurrenceList || []
        const orders = as(users.reader, "mantle.sales.SalesWorkspaceServices.find#SalesOrders", {list: "recent"}).orderList || []
        const accounts =
            as(users.reader, "mantle.sales.SalesWorkspaceServices.find#Accounts", {organizationPartyId: f.orgA}).accountList || []
        const openOrders = accounts.find(row => row.partyId == f.accounts.a)?.openOrderCount
        // the review's readers: a customer's finance lists the order and not its base; a bulk part status change passes the base by
        const finance = as(users.receivables, "mantle.account.CustomerFinanceServices.get#CustomerFinance", {
            organizationPartyId: f.orgA,
            customerPartyId: f.accounts.a
        })
        const financeRefused = finance.refused
        const financeOrderIds = JSON.parse(JSON.stringify(finance.orders || [])).map(row => row.orderId)
        system(() =>
            call("mantle.order.OrderBulkServices.change#OrderPartsStatus", {
                toStatusId: "OrderCancelled",
                inputFieldsMap: {orderId: ids.base}
            })
        )
        return {
            reader,
            other,
            invoiced,
            stored,
            stale,
            edited,
            back,
            invoice,
            shipment,
            listed,
            listedB,
            orders,
            openOrders,
            financeRefused,
            financeOrderIds
        }
    },
    then({
        reader,
        other,
        invoiced,
        stored,
        stale,
        edited,
        back,
        invoice,
        shipment,
        listed,
        listedB,
        orders,
        openOrders,
        financeRefused,
        financeOrderIds
    }) {
        financeRefused == ""
        financeOrderIds.includes(ids.source)
        !financeOrderIds.includes(ids.base)
        // the account's open orders count the order and not its base
        openOrders == 1
        code(reader.refused) == "PERMISSION_DENIED"
        code(other.refused) == "RECORD_UNAVAILABLE"
        code(invoiced.refused) == "PERMISSION_DENIED"
        stored.refused == ""
        stored.created == true
        header(ids.base).orderPurposeEnumId == "OrpRecurringTemplate"
        header(ids.base).statusId == "OrderApproved"
        system(() => one("mantle.order.OrderPart", {orderId: ids.base, orderPartSeqId: "01"}).statusId) == "OrderApproved"
        header(ids.base).recurTimeZone == zone
        header(ids.base).recurAgreementId == f.prefix + "_AGR"
        header(ids.base).placedDate == null
        count("mantle.account.payment.Payment", {orderId: ids.base}) == 0
        // the order it came from stays an ordinary order
        header(ids.source).recurCronExpression == null
        header(ids.source).orderPurposeEnumId == null
        code(stale.refused) == "REVISION_CHANGED"
        edited.refused == ""
        back.refused == ""
        header(ids.base).recurCronExpression == "0 0 7 1 * ?"
        header(ids.base).recurAutoInvoice == "N"
        invoice.includes("RECURRING_TEMPLATE")
        shipment.includes("RECURRING_TEMPLATE")
        listed.some(row => row.baseOrderId == ids.base && row.nextText != "" && row.customerName != "")
        !listedB.some(row => row.baseOrderId == ids.base)
        !orders.some(row => row.orderId == ids.base)
        orders.some(row => row.orderId == ids.source)
    }
})

feature("two runs of the due occurrence and the job make one order, with no payment copied", {
    when() {
        const first = run(ids.base)
        const second = run(ids.base)
        system(() => call("mantle.order.OrderServices.create#RecurringOrders", {}))
        const made = children(ids.base)
        const retry = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.base,
            recurRevision: revisionOf(ids.base),
            operation: "retry",
            operationKey: key("retry")
        })
        return {first, second, made, retry}
    },
    then({first, second, made, retry}) {
        first != null
        second == null
        made.length == 1
        made[0].orderId == first
        made[0].orderPurposeEnumId == null
        made[0].statusId == "OrderPlaced"
        made[0].recurCronExpression == null
        made[0].recurAgreementId == null
        // the occurrence is the 1st at 07:00 in the base's zone
        ec.l10n.format(made[0].recurOccurrenceDate, "d HH:mm", null, zone) == "1 07:00"
        count("mantle.account.payment.Payment", {orderId: first}) == 0
        header(ids.base).lastOrderedDate != null
        code(retry.refused) == "NOTHING_DUE"
    }
})

feature("a paused base and an ended one make none; a resumed base skips the paused occurrence", {
    when() {
        // the base due again: its last order a month and a half ago
        system(() =>
            call("update#mantle.order.OrderHeader", {orderId: ids.base, lastOrderedDate: new Date(Date.now() - 45 * dayMs)})
        )
        // the occurrence ordered already (feature 2's) answers its order, not a second one (recurOccurrenceDate, not lastOrderedDate)
        const firstOrderId = children(ids.base)[0].orderId
        const again = run(ids.base)
        const againCount = children(ids.base).length
        const noReason = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.base,
            recurRevision: revisionOf(ids.base),
            operation: "pause"
        })
        const paused = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.base,
            recurRevision: revisionOf(ids.base),
            operation: "pause",
            reason: "Customer closed for the season"
        })
        const whilePaused = run(ids.base)
        system(() => call("mantle.order.OrderServices.create#RecurringOrders", {}))
        const pausedCount = children(ids.base).length
        const stale = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.base,
            recurRevision: "1",
            operation: "resume"
        })
        const resumed = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.base,
            recurRevision: revisionOf(ids.base),
            operation: "resume"
        })
        const afterResume = run(ids.base)
        const resumedCount = children(ids.base).length
        // a second base, ended now
        ids.ended = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({orderId: approvedOrder(f.orgA, f.accounts.a)})
        ).baseOrderId
        const ended = as(users.keeper, svc + "change#SalesRecurrence", {
            baseOrderId: ids.ended,
            recurRevision: revisionOf(ids.ended),
            operation: "end",
            reason: "Contract not renewed"
        })
        const afterEnd = run(ids.ended)
        return {
            firstOrderId,
            again,
            againCount,
            noReason,
            paused,
            whilePaused,
            pausedCount,
            stale,
            resumed,
            afterResume,
            resumedCount,
            ended,
            afterEnd
        }
    },
    then({
        firstOrderId,
        again,
        againCount,
        noReason,
        paused,
        whilePaused,
        pausedCount,
        stale,
        resumed,
        afterResume,
        resumedCount,
        ended,
        afterEnd
    }) {
        again == firstOrderId
        againCount == 1
        code(noReason.refused) == "REASON_REQUIRED"
        paused.refused == ""
        whilePaused == null
        pausedCount == 1
        code(stale.refused) == "REVISION_CHANGED"
        resumed.refused == ""
        afterResume == null
        resumedCount == 1
        ended.refused == ""
        afterEnd == null
        children(ids.ended).length == 0
    }
})

feature("a base whose agreement ended fails, named on the base, and the next base still runs", {
    when() {
        // a base kept under the agreement, and a third with none, both due; then the agreement is closed
        ids.agreed = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({orderId: approvedOrder(f.orgA, f.accounts.a), recurAgreementId: f.prefix + "_AGR"})
        ).baseOrderId
        ids.third = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({orderId: approvedOrder(f.orgA, f.accounts.a)})
        ).baseOrderId
        system(() => call("update#mantle.party.agreement.Agreement", {agreementId: f.prefix + "_AGR", statusId: "AgmStClosed"}))
        system(() => call("mantle.order.OrderServices.create#RecurringOrders", {}))
        const failing = as(users.keeper, svc + "find#RecurringSalesOrders", {state: "failing"}).recurrenceList || []
        return {failing}
    },
    then({failing}) {
        children(ids.agreed).length == 0
        String(header(ids.agreed).recurFailureMessage).includes("AGREEMENT_INACTIVE")
        header(ids.agreed).recurFailureDate != null
        failing.some(row => row.baseOrderId == ids.agreed && row.failureText.includes("AGREEMENT_INACTIVE"))
        children(ids.third).length == 1
        header(ids.third).recurFailureDate == null
        // the first base's occurrence was ordered once already: the job did not order it again
        children(ids.base).length == 1
    }
})

feature("a Shop contract's base is only Shop's; Subscriptions show a storeless subscription beside a store contract", {
    when() {
        ids.shopBase = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({orderId: approvedOrder(f.orgA, f.accounts.a)})
        ).baseOrderId
        system(() => {
            make("mantle.product.subscription.StoreRecurringContract", {
                contractId: f.prefix + "_CONTRACT",
                productStoreId: f.prefix + "_STORE",
                customerPartyId: f.accounts.a,
                productId: f.product,
                priceAmount: 20,
                currencyUomId: "USD",
                autoRenew: "N",
                stateEnumId: "ScsActive",
                baseOrderId: ids.shopBase,
                createdDate: ec.user.nowTimestamp
            })
            const child = children(ids.third)[0]
            make("mantle.product.subscription.Subscription", {
                subscriptionId: f.prefix + "_SUB",
                subscriberPartyId: f.accounts.a,
                orderId: child.orderId,
                orderItemSeqId: "01",
                productId: f.product,
                fromDate: new Date(Date.now() - dayMs),
                thruDate: new Date(Date.now() + 30 * dayMs)
            })
        })
        const shopRun = run(ids.shopBase)
        const shopStore = as(
            users.keeper,
            svc + "store#SalesRecurrence",
            monthly({baseOrderId: ids.shopBase, recurRevision: "1"})
        )
        const listed = as(users.keeper, svc + "find#RecurringSalesOrders", {state: "all"}).recurrenceList || []
        const subscriptions = as(users.reader, svc + "find#SalesSubscriptions", {}).subscriptionList || []
        const subscriptionsB = as(users.keeperB, svc + "find#SalesSubscriptions", {}).subscriptionList || []
        const storeless =
            as(users.reader, svc + "find#SalesSubscriptions", {kind: "storeless", agreementId: f.prefix + "_AGR"})
                .subscriptionList || []
        const readerFollow = as(users.reader, svc + "add#SubscriptionFollowUp", {subscriptionId: f.prefix + "_SUB"})
        const otherFollow = as(users.keeperB, svc + "add#SubscriptionFollowUp", {subscriptionId: f.prefix + "_SUB"})
        const follow = as(users.keeper, svc + "add#SubscriptionFollowUp", {contractId: f.prefix + "_CONTRACT"})
        return {shopRun, shopStore, listed, subscriptions, subscriptionsB, storeless, readerFollow, otherFollow, follow}
    },
    then({shopRun, shopStore, listed, subscriptions, subscriptionsB, storeless, readerFollow, otherFollow, follow}) {
        shopRun == null
        children(ids.shopBase).length == 0
        code(shopStore.refused) == "RECORD_UNAVAILABLE"
        !listed.some(row => row.baseOrderId == ids.shopBase)
        listed.some(row => row.baseOrderId == ids.ended && row.state == "ended")
        subscriptions.some(
            row => row.kind == "storeless" && row.subscriptionId == f.prefix + "_SUB" && row.baseOrderId == ids.third
        )
        subscriptions.some(row => row.subscriptionId == f.prefix + "_SUB" && row.billingText == "No billing link")
        subscriptions.some(row => row.kind == "store" && row.contractId == f.prefix + "_CONTRACT")
        !subscriptionsB.some(row => row.subscriptionId == f.prefix + "_SUB" || row.contractId == f.prefix + "_CONTRACT")
        // the third base names no agreement: the agreement filter leaves its subscription out
        !storeless.some(row => row.subscriptionId == f.prefix + "_SUB")
        code(readerFollow.refused) == "PERMISSION_DENIED"
        code(otherFollow.refused) == "RECORD_UNAVAILABLE"
        follow.refused == ""
        follow.workEffortId != null
        one("mantle.work.effort.WorkEffort", {workEffortId: follow.workEffortId}).workEffortTypeEnumId == "WetTask"
    }
})

feature("a base repeats the source's charge and discount lines; each order is taxed when placed and billed once approved", {
    when() {
        ids.charged = chargedOrder()
        const sourceTax = taxTotal(ids.charged)
        ids.chargedBase = as(
            users.financeC,
            svc + "store#SalesRecurrence",
            monthly({orderId: ids.charged, recurAutoInvoice: "Y"})
        ).baseOrderId
        const baseLines = lines(ids.chargedBase)
        // the rate rises before the occurrence: the order made is taxed then, not given the source's tax
        system(() =>
            call("update#mantle.other.tax.TaxAuthorityRate", {taxAuthorityRateId: f.prefix + "_RATE", taxPercentage: "7"})
        )
        const made = run(ids.chargedBase)
        const madeLines = lines(made)
        const madeTax = taxTotal(made)
        const placedBillings = count("mantle.order.OrderItemBilling", {orderId: made})
        const placedStatus = header(made).statusId
        // a person approves it: the base's auto-invoice bills it, once
        committed("mantle.order.OrderServices.approve#Order", {orderId: made})
        // the approval's tx-commit rule runs on a service worker after the commit
        const billings = waitFor(() => count("mantle.order.OrderItemBilling", {orderId: made}))
        const invoiceIds = system(() =>
            Array.from(
                new Set(
                    Array.from(ec.entity.find("mantle.order.OrderItemBilling").condition("orderId", made).list()).map(
                        row => row.invoiceId
                    )
                )
            )
        )
        const again = committed(svc + "invoice#RecurringOrder", {orderId: made}).invoiceIds || []
        const billingsAgain = count("mantle.order.OrderItemBilling", {orderId: made})
        // a base without auto-invoice: its order approved is not billed
        const plain = children(ids.third)[0].orderId
        committed("mantle.order.OrderServices.approve#Order", {orderId: plain})
        const plainInvoices = committed(svc + "invoice#RecurringOrder", {orderId: plain}).invoiceIds || []
        const plainBillings = count("mantle.order.OrderItemBilling", {orderId: plain})
        // the review: a base whose order the gateway cannot tax (its rate ended) fails its occurrence, named on the base, and
        // makes no order
        const untaxed = as(
            users.financeC,
            svc + "store#SalesRecurrence",
            monthly({orderId: chargedOrder(), recurAutoInvoice: "Y"})
        ).baseOrderId
        system(() =>
            call("update#mantle.other.tax.TaxAuthorityRate", {
                taxAuthorityRateId: f.prefix + "_RATE",
                thruDate: String(Date.now() - 60 * dayMs - 1000)
            })
        )
        system(() => call("mantle.order.OrderServices.create#RecurringOrders", {}))
        const untaxedBase = header(untaxed)
        const untaxedCount = children(untaxed).length
        return {
            untaxedBase,
            untaxedCount,
            sourceTax,
            baseLines,
            made,
            madeLines,
            madeTax,
            placedStatus,
            placedBillings,
            billings,
            invoiceIds,
            again,
            billingsAgain,
            plainInvoices,
            plainBillings
        }
    },
    then({
        sourceTax,
        baseLines,
        made,
        madeLines,
        madeTax,
        placedStatus,
        placedBillings,
        billings,
        invoiceIds,
        again,
        billingsAgain,
        plainInvoices,
        plainBillings,
        untaxedBase,
        untaxedCount
    }) {
        sourceTax.compare(0) > 0
        // the base: the product, the shipping charge and the discount, each child under its own parent
        const kinds = rows =>
            rows
                .filter(row => !taxTypes.includes(row.itemTypeEnumId))
                .map(row => row.itemTypeEnumId)
                .sort()
                .join(",")
        kinds(baseLines) == "ItemDiscount,ItemProduct,ItemShipping"
        const parentOf = (rows, type) => {
            const child = rows.find(row => row.itemTypeEnumId == type)
            return rows.find(row => row.orderItemSeqId == child.parentItemSeqId)?.itemTypeEnumId
        }
        parentOf(baseLines, "ItemDiscount") == "ItemProduct"
        baseLines
            .filter(row => taxTypes.includes(row.itemTypeEnumId))
            .every(row =>
                ["ItemProduct", "ItemShipping"].includes(
                    baseLines.find(line => line.orderItemSeqId == row.parentItemSeqId)?.itemTypeEnumId
                )
            )
        // the order made: the same lines, its tax figured at the new rate under its own lines
        made != null && !String(made).startsWith("error")
        placedStatus == "OrderPlaced"
        kinds(madeLines) == "ItemDiscount,ItemProduct,ItemShipping"
        parentOf(madeLines, "ItemDiscount") == "ItemProduct"
        madeLines.filter(row => taxTypes.includes(row.itemTypeEnumId)).length == 2
        madeLines
            .filter(row => taxTypes.includes(row.itemTypeEnumId))
            .every(row =>
                ["ItemProduct", "ItemShipping"].includes(
                    madeLines.find(line => line.orderItemSeqId == row.parentItemSeqId)?.itemTypeEnumId
                )
            )
        madeTax.compare(sourceTax) > 0
        toDecimal(header(made).grandTotal).compare(toDecimal(195).add(madeTax)) == 0
        placedBillings == 0
        // approved by a person: every line billed on one invoice, and a second ask bills nothing more
        billings == madeLines.length
        invoiceIds.length == 1
        again.length == 0
        billingsAgain == billings
        plainInvoices.length == 0
        plainBillings == 0
        untaxedBase.recurFailureDate != null
        String(untaxedBase.recurFailureMessage).includes("No sales tax rate")
        untaxedCount == 0
    }
})
