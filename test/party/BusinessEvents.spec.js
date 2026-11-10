// Business events on the report engine's time series (mantle.party.BusinessEventServices.record#BusinessEvent, BusinessEvents.js;
// BOSS impl-insights P6, F13, F31): the marker of a published price list is made from the record as stored (its name, its
// organization, its key; no amount), a list that is not published or has no organization writes nothing, one event keeps one
// marker, and the mantle-business-events dataset reads it; a dated promotion is a band of its store's organization and a
// closed period a marker named by the period. The owners register the call after their commit (publish#ProductPriceList,
// store#Promotion, close#Period); the organization scope of the dataset is get#OrganizationRowFilter's (OrganizationRowFilter
// spec). New spec, no Groovy original.
const RECORD = "mantle.party.BusinessEventServices.record#BusinessEvent"
const range = {from: "now-1d", thru: "now+1d"}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
    }
})

function attempt(parameters) {
    try {
        return call(RECORD, parameters)
    } catch (error) {
        ec.message.clearErrors()
        return {error: String(error.message)}
    }
}
const markers = recordId =>
    Array.from(
        call(
            "org.moqui.report.ReportServices.query#Documents",
            Object.assign({datasetId: "mantle-business-events", queryString: "recordId:" + recordId}, range)
        ).hits || []
    )

feature("a published price list is one marker of its organization, made from the record", {
    when() {
        call("create#mantle.party.Party", {partyId: "BEV_ORG", partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_"})
        call("create#mantle.party.Organization", {partyId: "BEV_ORG", organizationName: "Business Events Org"})
        call("create#mantle.party.PartyRole", {partyId: "BEV_ORG", roleTypeId: "OrgInternal"})
        for (const [priceListId, state, organizationPartyId] of [
            ["BEV_LIST", "published", "BEV_ORG"],
            ["BEV_DRAFT", "draft", "BEV_ORG"],
            ["BEV_SHARED", "published", null]
        ])
            call("create#mantle.product.ProductPriceList", {
                priceListId,
                listName: "Spring list " + priceListId,
                state,
                organizationPartyId,
                direction: "sales",
                fromDate: Date.now() - 3600000
            })
        // a dated promotion of the organization's store, and a closed period of the organization
        call("create#mantle.product.store.ProductStore", {
            productStoreId: "BEV_STORE",
            storeName: "Events store",
            organizationPartyId: "BEV_ORG"
        })
        call("create#moqui.service.ServiceRegister", {serviceRegisterId: "BEV_RULE", description: "Business events spec"})
        call("create#mantle.product.store.ProductStorePromotion", {
            storePromotionId: "BEV_PROMO",
            productStoreId: "BEV_STORE",
            serviceRegisterId: "BEV_RULE",
            itemDescription: "Spring sale",
            fromDate: Date.now() - 7200000,
            thruDate: Date.now() + 7200000
        })
        call("create#mantle.party.time.TimePeriod", {
            timePeriodId: "BEV_PERIOD",
            timePeriodTypeId: "FiscalMonth",
            partyId: "BEV_ORG",
            periodName: "March",
            fromDate: "2026-03-01",
            thruDate: "2026-03-31"
        })
        call("create#mantle.ledger.transaction.AccountingCloseRun", {
            closeRunId: "BEV_RUN",
            organizationPartyId: "BEV_ORG",
            timePeriodId: "BEV_PERIOD",
            statusId: "CrnClosed",
            closedDate: Date.now() - 1800000
        })
        const promotion = attempt({event: "PromotionStart", recordId: "BEV_PROMO"})
        const closed = attempt({event: "PeriodClosed", recordId: "BEV_RUN"})
        const first = attempt({event: "PriceListPublished", recordId: "BEV_LIST"})
        const again = attempt({event: "PriceListPublished", recordId: "BEV_LIST"})
        const found = markers("BEV_LIST")
        return {
            first,
            again,
            count: found.length,
            promotion,
            promotionBody: markers("BEV_PROMO")[0]?.body || {},
            closed,
            closedBody: markers("BEV_PERIOD")[0]?.body || {},
            body: found[0]?.body || {},
            draft: attempt({event: "PriceListPublished", recordId: "BEV_DRAFT"}),
            shared: attempt({event: "PriceListPublished", recordId: "BEV_SHARED"}),
            missing: attempt({event: "PriceListPublished", recordId: "BEV_NONE"}),
            unknown: attempt({event: "Anything", recordId: "BEV_LIST"}).error || ""
        }
    },
    then({first, again, count, promotion, promotionBody, closed, closedBody, body, draft, shared, missing, unknown}) {
        first.recorded
        first.annotationId.startsWith("business-")
        again.annotationId == first.annotationId
        count == 1
        body.source == "business"
        body.organizationPartyId == "BEV_ORG"
        body.event == "PriceListPublished"
        body.recordType == "mantle.product.ProductPriceList"
        body.text == "Price list published: Spring list BEV_LIST"
        promotion.recorded
        promotionBody.text == "Promotion: Spring sale"
        promotionBody.organizationPartyId == "BEV_ORG"
        // a band from its start to its end
        promotionBody.time_end != null
        closed.recorded
        closedBody.text == "Period closed: March"
        closedBody.event == "PeriodClosed"
        !draft.recorded
        !shared.recorded
        !missing.recorded
        unknown.includes("Unknown business event")
    }
})
