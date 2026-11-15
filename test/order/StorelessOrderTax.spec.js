// X1, a storeless order's tax (impl-sales P7; design-sales §5, CX-PRICING; mantle.other.TaxServices calculate#OrderSalesTax,
// SalesTax.js order): an order without a store is taxed through its seller's gateway (PartyAcctgPreference.taxGatewayConfigId)
// and retaxed by the native order rules on each line change, a shipping charge line the rep enters too; a store order is taxed
// through its store's gateway as before; a storeless order of a seller with no gateway gets no tax line and no error, as before.
// Standalone: spec-local organizations, store, tax authority and rate, customer and product, through Mantle's order services.
// Run: ./moq test mr-mantle --spec StorelessOrderTax
const prefix = "SOT"
const seller = prefix + "_SELLER",
    plain = prefix + "_PLAIN"
const customer = prefix + "_CUSTOMER"
const product = prefix + "_WIDGET"
const authority = prefix + "_UT"
const store = prefix + "_STORE"
const orders = {}

const make = (entity, values) => call("create#" + entity, values)
const rowsOf = (entity, values) => Array.from(ec.entity.find(entity).condition(values).disableAuthz().list())
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const order = (name, parameters) => call("mantle.order.OrderServices." + name, parameters)
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: "USD"})
}
// the order's tax lines, each {parent, amount}, by parent line
function taxLines(orderId) {
    return rowsOf("mantle.order.OrderItem", {orderId, itemTypeEnumId: "ItemSalesTax"})
        .map(row => ({
            parent: row.parentItemSeqId,
            amount: toDecimal(row.quantity ?? 1).multiply(toDecimal(row.unitAmount ?? 0))
        }))
        .sort((a, b) => String(a.parent).localeCompare(String(b.parent)))
}
const total = orderId => toDecimal(one("mantle.order.OrderHeader", {orderId}).grandTotal ?? 0)
// a storeless order of the organization for the customer, at its address, with one line of two widgets at 100.00
function storelessOrder(vendorPartyId) {
    const made = order("create#Order", {
        vendorPartyId,
        customerPartyId: customer,
        currencyUomId: "USD",
        postalContactMechId: one("mantle.party.contact.PartyContactMech", {
            partyId: customer,
            contactMechPurposeId: "PostalShippingDest"
        }).contactMechId
    })
    const line = order("create#OrderItem", {
        orderId: made.orderId,
        orderPartSeqId: made.orderPartSeqId,
        productId: product,
        quantity: "2",
        unitAmount: "100",
        requireInventory: false
    })
    return {orderId: made.orderId, orderPartSeqId: made.orderPartSeqId, lineId: line.orderItemSeqId}
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(seller, "Storeless seller")
        organization(plain, "Seller without a gateway")
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: seller, taxGatewayConfigId: "LOCAL"})
        make("mantle.party.Party", {partyId: customer, partyTypeEnumId: "PtyOrganization"})
        make("mantle.party.Organization", {partyId: customer, organizationName: "Utah customer"})
        make("mantle.party.PartyRole", {partyId: customer, roleTypeId: "Customer"})
        call("mantle.party.ContactServices.store#PartyContactInfo", {
            partyId: customer,
            postalContactMechPurposeId: "PostalShippingDest",
            address1: "1 Main St",
            city: "Somewhere",
            stateProvinceGeoId: "USA_UT",
            postalCode: "84057",
            countryGeoId: "USA"
        })
        make("mantle.product.Product", {
            productId: product,
            productName: "Spec widget",
            productTypeEnumId: "PtAsset",
            ownerPartyId: seller
        })
        // Utah sales tax, 6 % on goods and shipping, where the two sellers have nexus
        make("mantle.other.tax.TaxAuthority", {
            taxAuthorityId: authority,
            taxAuthorityTypeEnumId: "TatState",
            taxAuthGeoId: "USA_UT",
            description: "Spec Utah"
        })
        for (const partyId of [seller, plain])
            make("mantle.other.tax.TaxAuthorityParty", {taxAuthorityId: authority, partyId, fromDate: 0, isNexus: "Y"})
        make("mantle.other.tax.TaxAuthorityRate", {
            taxAuthorityRateId: prefix + "_RATE",
            taxAuthorityId: authority,
            rateTypeEnumId: "TarSalesTax",
            taxPercentage: "6",
            taxShipping: "Y",
            fromDate: 0
        })
        // the plain seller's store, which names the gateway itself
        make("mantle.product.store.ProductStore", {
            productStoreId: store,
            storeName: "Spec store",
            organizationPartyId: plain,
            defaultCurrencyUomId: "USD",
            taxGatewayConfigId: "LOCAL"
        })
    },
    cleanup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})

feature("a storeless order is taxed through its seller's gateway, and retaxed when a line changes", {
    when() {
        orders.storeless = storelessOrder(seller)
        const first = taxLines(orders.storeless.orderId)
        const firstTotal = total(orders.storeless.orderId)
        order("update#OrderItem", {
            orderId: orders.storeless.orderId,
            orderItemSeqId: orders.storeless.lineId,
            quantity: "3",
            unitAmount: "100"
        })
        const changed = taxLines(orders.storeless.orderId)
        const changedTotal = total(orders.storeless.orderId)
        return {first, firstTotal, changed, changedTotal}
    },
    then({first, firstTotal, changed, changedTotal}) {
        first.length == 1
        first[0].parent == orders.storeless.lineId
        first[0].amount.eq(toDecimal("12"))
        firstTotal.eq(toDecimal("212"))
        changed.length == 1
        changed[0].amount.eq(toDecimal("18"))
        changedTotal.eq(toDecimal("318"))
    }
})

feature("a shipping charge line on a storeless order is taxed with it; a removed line takes its tax away", {
    when() {
        const shipping = order("create#OrderItem", {
            orderId: orders.storeless.orderId,
            orderPartSeqId: orders.storeless.orderPartSeqId,
            itemTypeEnumId: "ItemShipping",
            quantity: "1",
            unitAmount: "50",
            itemDescription: "Freight"
        })
        const withShipping = taxLines(orders.storeless.orderId)
        const shippingTotal = total(orders.storeless.orderId)
        order("delete#OrderItem", {orderId: orders.storeless.orderId, orderItemSeqId: orders.storeless.lineId})
        return {shipping: shipping.orderItemSeqId, withShipping, shippingTotal, after: taxLines(orders.storeless.orderId)}
    },
    then({shipping, withShipping, shippingTotal, after}) {
        withShipping.length == 2
        withShipping.find(line => line.parent == shipping).amount.eq(toDecimal("3"))
        shippingTotal.eq(toDecimal("371"))
        after.length == 1
        after[0].parent == shipping
    }
})

feature(
    "a store order is taxed through its store's gateway as before; a storeless order of a seller with no gateway gets no tax",
    {
        when() {
            ec.message.clearErrors()
            const storeOrder = order("create#Order", {
                productStoreId: store,
                customerPartyId: customer,
                postalContactMechId: one("mantle.party.contact.PartyContactMech", {
                    partyId: customer,
                    contactMechPurposeId: "PostalShippingDest"
                }).contactMechId
            })
            order("create#OrderItem", {
                orderId: storeOrder.orderId,
                orderPartSeqId: storeOrder.orderPartSeqId,
                productId: product,
                quantity: "1",
                unitAmount: "100",
                requireInventory: false
            })
            const untaxed = storelessOrder(plain)
            const revision = one("mantle.order.OrderHeader", {orderId: untaxed.orderId}).orderRevision
            const explicit = call("mantle.other.TaxServices.calculate#OrderSalesTax", {orderId: untaxed.orderId})
            return {
                storeTax: taxLines(storeOrder.orderId),
                untaxedTax: taxLines(untaxed.orderId),
                untaxedTotal: total(untaxed.orderId),
                checked: call("mantle.other.TaxServices.check#OrderTaxGateway", {orderId: untaxed.orderId}).taxed,
                sellerChecked: call("mantle.other.TaxServices.check#OrderTaxGateway", {orderId: orders.storeless.orderId}).taxed,
                explicit,
                revisionAfter: one("mantle.order.OrderHeader", {orderId: untaxed.orderId}).orderRevision,
                revision,
                errors: ec.message.hasError()
            }
        },
        then({storeTax, untaxedTax, untaxedTotal, checked, sellerChecked, revision, revisionAfter, errors}) {
            storeTax.length == 1
            storeTax[0].amount.eq(toDecimal("6"))
            untaxedTax.length == 0
            untaxedTotal.eq(toDecimal("200"))
            checked == false
            sellerChecked == true
            String(revisionAfter) == String(revision)
            errors == false
        }
    }
)
