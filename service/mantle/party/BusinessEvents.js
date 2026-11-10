// Business events on the report engine's time series (mantle.party.BusinessEventServices; mr-boss plan/design-insights.md §4
// "Business annotations", impl-insights P6, F13, F31): a domain's event written after its commit as a business annotation
// (org.moqui.report.ReportServices.create#Annotation, source business), which a dashboard over business data shows as a marker to
// a viewer of the event's organization (the mantle-business-events dataset, scoped by get#OrganizationRowFilter).
//
// An owner registers its event with register(event, recordId) once its change is made; the call runs after the commit, so a
// rolled-back change writes nothing, and a failure to register or to write is logged and never fails the owner's change. The
// marker is read from the record as stored (the events table below): a name, a time, the organization and the record's key,
// never an amount and nothing the caller supplies. An event whose record is not in its state, or has no organization, writes
// nothing. One event keeps one marker by its key.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {one} = lib

const SERVICE = "mantle.party.BusinessEventServices.record#BusinessEvent"
const ANNOTATION = "org.moqui.report.ReportServices.create#Annotation"
// an instant for the engine (never shown): the stored time as an ISO instant
const stamp = value => (lib.ms(value) == null ? null : new Date(lib.ms(value)).toISOString())

// Each event: the record it reads, and the marker it makes of it (null when the record is not in the event's state).
const events = {
    PriceListPublished(recordId) {
        const list = one("mantle.product.ProductPriceList", {priceListId: recordId})
        if (!list || list.state !== "published" || !list.organizationPartyId) return null
        return {
            organizationPartyId: list.organizationPartyId,
            text: "Price list published: " + (list.listName || list.priceListId),
            time: stamp(list.lastUpdatedStamp),
            recordType: "mantle.product.ProductPriceList"
        }
    },
    PromotionStart(recordId) {
        const promotion = one("mantle.product.store.ProductStorePromotion", {storePromotionId: recordId})
        if (!promotion || !promotion.fromDate) return null
        const store = one("mantle.product.store.ProductStore", {productStoreId: promotion.productStoreId})
        if (!store?.organizationPartyId) return null
        const from = stamp(promotion.fromDate)
        const thru = promotion.thruDate ? stamp(promotion.thruDate) : null
        return {
            organizationPartyId: store.organizationPartyId,
            text: "Promotion: " + (promotion.itemDescription || promotion.storePromotionId),
            time: from,
            timeEnd: thru && thru > from ? thru : null,
            recordType: "mantle.product.store.ProductStorePromotion"
        }
    },
    PeriodClosed(recordId) {
        const run = one("mantle.ledger.transaction.AccountingCloseRun", {closeRunId: recordId})
        if (!run || run.statusId !== "CrnClosed" || !run.organizationPartyId) return null
        const period = one("mantle.party.time.TimePeriod", {timePeriodId: run.timePeriodId})
        return {
            organizationPartyId: run.organizationPartyId,
            text: "Period closed: " + (period?.periodName || run.timePeriodId),
            time: stamp(run.closedDate),
            recordType: "mantle.party.time.TimePeriod",
            recordId: run.timePeriodId
        }
    }
}

// record#BusinessEvent: the marker of one event, written with authorization off (the owner's service checked its own
// permission; the engine's business source is the owner's to write). A failure is logged and answered, not thrown.
function record(p) {
    const read = Object.prototype.hasOwnProperty.call(events, p.event) ? events[p.event] : null
    if (!read) throw new Error("Unknown business event " + p.event)
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        const marker = read(String(p.recordId))
        if (!marker) return {recorded: false}
        const written = ec.service
            .sync()
            .name(ANNOTATION)
            .parameters({
                source: "business",
                event: p.event,
                eventKey: p.event + ":" + p.recordId,
                text: String(marker.text).slice(0, 250),
                time: marker.time || undefined,
                timeEnd: marker.timeEnd || undefined,
                organizationPartyId: marker.organizationPartyId,
                recordType: marker.recordType,
                recordId: String(marker.recordId || p.recordId)
            })
            .requireNewTransaction(true)
            .call()
        if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        return {recorded: true, annotationId: written.annotationId}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            "Business event " + p.event + " of " + p.recordId + " was not recorded: " + String(error.message || error)
        )
        return {recorded: false}
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}

// For an owner's service, once its change is made: record the event after the commit. Never fails the owner's change.
function register(event, recordId) {
    ec.message.pushErrors()
    try {
        ec.service
            .special()
            .name(SERVICE)
            .parameters({event, recordId: String(recordId)})
            .registerOnCommit()
    } catch (error) {
        ec.logger.error("Business event " + event + " of " + recordId + " was not registered: " + String(error.message || error))
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

const operations = {record}
;({
    register,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown business event operation " + op)
        return operations[op](parameters)
    }
})
