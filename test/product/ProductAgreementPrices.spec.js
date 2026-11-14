// The price resolver's agreement guard (impl-sales P15, F20; design-sales §7, Products' owner contract;
// mantle/product/PriceResolver.js agreementApplies): an agreement's price row and price list apply only while the agreement is active
// (or has no status, an agreement outside the status flow) and in its dates, of the price organization and with the transaction's
// customer; a draft, closed, not yet started, ended or another customer's agreement prices nothing and the general price applies.
// The seller's authority (get#SellerProductPrice, Sales' quote lines) takes the seller's current agreement with the customer and no
// other. Beside ProductPriceLists, whose agreement feature (an agreement with no status or dates) passes unchanged.
// Run: ./moq test mr-mantle --spec ProductAgreementPrices
const P = "mantle.product.",
    S = P + "PriceServices.",
    time = Date.now(),
    start = new Date(time - 60000).toISOString(),
    hour = 60 * 60 * 1000
const create = (entity, p) => call("create#" + entity, p)
const org = "ORG_ZIZI_SERVICES",
    customer = "PAG_CUSTOMER",
    other = "PAG_OTHER",
    product = "PAG_PRODUCT"
function agreement(id, values) {
    create(
        "mantle.party.agreement.Agreement",
        Object.assign(
            {
                agreementId: id,
                agreementTypeEnumId: "AgrSales",
                statusId: "AgmStActive",
                organizationPartyId: org,
                otherPartyId: customer,
                fromDate: start,
                currencyUomId: "USD"
            },
            values
        )
    )
}
function price(p) {
    return create(
        P + "ProductPrice",
        Object.assign(
            {
                productId: product,
                vendorPartyId: org,
                priceTypeEnumId: "PptCurrent",
                pricePurposeEnumId: "PppPurchase",
                priceUomId: "USD",
                price: 20,
                fromDate: start
            },
            p
        )
    )
}
const resolve = (p = {}) =>
    call(
        S + "get#ProductPrice",
        Object.assign({productId: product, vendorPartyId: org, customerPartyId: customer, priceUomId: "USD", explain: true}, p)
    )
const seller = (p = {}) =>
    call(
        S + "get#SellerProductPrice",
        Object.assign({productId: product, organizationPartyId: org, customerPartyId: customer, priceUomId: "USD"}, p)
    )
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ec.user.setEffectiveTime(time)
        create(P + "Product", {productId: product, productName: product, productTypeEnumId: "PtService", ownerPartyId: org})
        for (const partyId of [customer, other]) {
            create("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            create("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
        }
        price({})
        // one agreement of each kind, each with its own price for the product
        const kinds = {
            ACTIVE: [{}, 11],
            NOSTATUS: [{statusId: null, otherPartyId: null}, 12],
            DRAFT: [{statusId: "AgmStDraft"}, 13],
            CLOSED: [{statusId: "AgmStClosed"}, 14],
            FUTURE: [{fromDate: new Date(time + hour).toISOString()}, 15],
            PAST: [{thruDate: new Date(time - 1000).toISOString()}, 16],
            OTHER: [{otherPartyId: other}, 17],
            TEMPLATE: [{statusId: "AgmStDraft", isTemplate: "Y", otherPartyId: null}, 18]
        }
        for (const [kind, [values, amount]] of Object.entries(kinds)) {
            agreement("PAG_" + kind, values)
            price({
                agreementId: "PAG_" + kind,
                customerPartyId: values.otherPartyId === undefined ? customer : values.otherPartyId,
                price: amount
            })
        }
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("an agreement's price applies only while its agreement is active, dated and with the customer", {
    when() {
        const prices = {}
        for (const kind of ["ACTIVE", "NOSTATUS", "DRAFT", "CLOSED", "FUTURE", "PAST", "OTHER", "TEMPLATE"])
            prices[kind] = resolve({agreementId: "PAG_" + kind})
        return {prices, otherCustomer: resolve({agreementId: "PAG_ACTIVE", customerPartyId: other})}
    },
    then({prices, otherCustomer}) {
        prices.ACTIVE.price == 11
        prices.NOSTATUS.price == 12
        prices.DRAFT.price == 20
        prices.CLOSED.price == 20
        prices.FUTURE.price == 20
        prices.PAST.price == 20
        prices.OTHER.price == 20
        prices.TEMPLATE.price == 20
        // the trace names why a draft's row did not apply
        prices.DRAFT.priceTrace.some(step => String(step.reason).startsWith("Agreement not active"))
        otherCustomer.price == 20
    }
})
feature("the seller's authority takes the seller's current agreement with the customer, and none once it ends", {
    when() {
        const current = seller()
        const otherCustomer = seller({customerPartyId: other})
        const named = seller({validDate: new Date(time + 2 * hour).toISOString()})
        call("update#mantle.party.agreement.Agreement", {agreementId: "PAG_ACTIVE", statusId: "AgmStClosed"})
        const closed = seller()
        // a reader passing no agreement gets the general price: an agreement's row needs its agreement named
        const reader = resolve()
        return {current, otherCustomer, named, closed, reader}
    },
    then({current, otherCustomer, named, closed, reader}) {
        current.price == 11
        current.priceAvailable == true
        // another customer's own agreement (OTHER) is active and dated: its customer takes its price, this one's does not apply
        otherCustomer.price == 17
        // two hours on, the future agreement (FUTURE) has started and is the latest current one
        named.price == 15
        closed.price == 20
        reader.price == 20
    }
})
