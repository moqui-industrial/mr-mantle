// Event registration setup (mantle.work.EventRegistrationServices, E of IronStone Marketing design §14.2; design §9 Events,
// EventDetail, RegistrationSetup, §13 Event; impl-marketing P16). CC0 1.0 Universal plus Grant of Patent License.
//
// - An event is the Commons calendar's WorkEffort (WetEvent), edited only under the calendar's rules (EventServices
//   check#EventAccess: its organizer or an editor of a calendar it is in). Registration adds the organization that offers it
//   (RegistrationEvent, impl-marketing F107): made once by an events manager (MARKETING_EVENT_MANAGE) of that organization who may
//   edit the event, with a campaign link (CampaignAssociation CakEvent) to an open campaign of the organization when one is named.
// - An offer (EventRegistrationPolicy) is one occurrence's: an event that does not repeat has one, a series one per occurrence
//   chosen by the start its rule gives it, never one seat count shared across its dates. Its seats are what every ticket type
//   shares; a ticket type may hold fewer. Capacity is never set below the places that take a seat now (held, pending the
//   seller's approval, confirmed: EventRegistration, whose writes are P17's), counted per offer and per ticket type only.
// - Ticket types keep no amount: a free one, or a ticket product of the organization priced by the product's own prices
//   (PriceServices get#ProductPrice, in the organization's currency, of the offer's store when it names one), linked to the event
//   by WorkEffortProduct (WeptSales).
// - publish#Registration opens a draft offer when it is ready: an occurrence still to come of an event not cancelled, seats, a
//   current ticket type, a window that ends by the occurrence's end, a published site whose Marketing mount serves the organization,
//   a ready transactional sending profile for the notices, a payment gateway of the organization (or of its store) when a ticket
//   has a price, and the registration questions' form published when it has one; each missing one is named. close#Registration
//   ends it. A published offer's changes count in policyRevision, its terms' in termsRevision, for the registrations of P17.
// - Every service checks MARKETING_EVENT_MANAGE (a write) or a Marketing read and the event's organization itself, whoever calls;
//   another organization's event or offer is RECORD_UNAVAILABLE, as a missing one. Reads and writes run with artifact
//   authorization off below those checks; the question publication (Commons' FormPublication, purpose registration) is written here
//   after them, since Commons' publication services ask the form's editor (a content author) and an events manager only names a
//   published registration form of the organization.
// - publicView answers PASS's Event page (MarketingPortal.js getEvent): a published offer of the organization on that site, for an
//   occurrence still to come of an event not cancelled, as an allow-listed view (title, description, dates in the offer's zone,
//   where or online, ticket prices and advisory availability, terms); never the event's people, rooms, budget, campaign or call
//   link. Anything else is null, which the page answers as its one NotFound.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const apps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
const profiles = () => ec.resource.script("component://mr-mantle/service/mantle/party/MessageSendingProfiles.js")
const publications = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js")
const definitions = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const {find, one, rows, call, denied, ms} = lib

const EVENT = "mantle.work.registration.RegistrationEvent"
const POLICY = "mantle.work.registration.EventRegistrationPolicy"
const TICKET = "mantle.work.registration.EventTicketType"
const SCHEDULE = "mantle.work.registration.EventCommunicationSchedule"
const REGISTRATION = "mantle.work.registration.EventRegistration"
const WORK_EFFORT = "mantle.work.effort.WorkEffort"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const ASSOCIATION = "mantle.marketing.campaign.CampaignAssociation"
const PUBLICATION = "mantle.party.FormPublication"
const openCampaignStatuses = ["MKTG_CAMP_PLANNED", "MKTG_CAMP_APPROVED", "MKTG_CAMP_INPROGRESS"]
// the places that take a seat (P17 writes them): held (until its hold ends), pending the seller's approval, confirmed
const SEAT_STATES = ["EvrHeld", "EvrPending", "EvrConfirmed"]
const stateTexts = {ErpDraft: "Draft", ErpPublished: "Published", ErpClosed: "Closed"}
const stateColors = {ErpDraft: "grey-8", ErpPublished: "positive", ErpClosed: "grey-7"}
const limits = {
    events: 500,
    occurrences: 24,
    seats: 100000,
    holdMinutes: [5, 1440],
    perOrder: 50,
    title: 255,
    description: 20000,
    terms: 20000,
    fewLeft: 5
}
const MINUTE = 60000
const HOUR = 3600000
const DAY = 86400000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const yes = value => value === true || ["Y", "y", "true", "on"].includes(String(value ?? ""))
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const userText = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")
const fail = (kind, message) => {
    const error = new Error(message)
    error.moquiErrorKind = kind
    throw error
}
// A whole number from a parameter in a range, or null when empty; refused with code when it is not.
function wholeOf(value, code, label, min, max) {
    if (blank(value)) return null
    const number = Number(String(value).trim())
    if (!Number.isInteger(number) || number < min || number > max)
        denied(code, label + " is a whole number from " + min + " to " + max)
    return number
}
const timeOf = value => (blank(value) ? null : ms(value))
function zoneText(millis, zone, pattern = "yyyy-MM-dd HH:mm") {
    if (millis == null) return ""
    try {
        return ec.l10n.format(new Date(millis), pattern, null, zone || null)
    } catch (error) {
        return ec.l10n.format(new Date(millis), pattern)
    }
}

// ===== scope =====
function readScope() {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "anyRead")
    return userScope
}
function manageScope() {
    const userScope = readScope()
    marketingAccess.requireCapability(userScope, "eventManage")
    return userScope
}
// The registration event of the scope: {event, workEffort}; a missing one, another organization's and one with no organization
// kept are RECORD_UNAVAILABLE alike.
function eventOf(userScope, workEffortId) {
    const event = blank(workEffortId) ? null : one(EVENT, {workEffortId: text(workEffortId)})
    const workEffort = event ? one(WORK_EFFORT, {workEffortId: event.workEffortId}) : null
    if (!event || !workEffort || !marketingAccess.covers(userScope, event.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Event " + (workEffortId || "") + " is not available")
    return {event, workEffort}
}
// An offer of the scope, locked for a write.
function policyOf(userScope, registrationPolicyId, lock = false) {
    let query = blank(registrationPolicyId) ? null : find(POLICY, {registrationPolicyId: text(registrationPolicyId)})
    if (query && lock) query = query.forUpdate(true)
    const row = query ? query.one() : null
    if (!row || !marketingAccess.covers(userScope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Registration offer " + (registrationPolicyId || "") + " is not available")
    return row
}
function requireRevision(row, expectedRevision, label) {
    if (blank(expectedRevision)) denied("REVISION_REQUIRED", "Name the revision of " + label + " you read")
    if (ms(expectedRevision) !== ms(row.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            label + " changed since it was read; review it again (revision " + ms(row.lastUpdatedStamp) + ")"
        )
}
function requireDraftOrPublished(row) {
    if (row.statusId === "ErpClosed") denied("POLICY_CLOSED", "A closed registration offer is not changed; make another")
}
// What the caller may do with the event in the calendar (check#EventAccess, no refusal): {canEdit, canView}.
function eventAccess(workEffortId) {
    const out = ec.service
        .sync()
        .name("mantle.work.EventServices.check#EventAccess")
        .parameters({workEffortId, permission: "flags"})
        .disableAuthz()
        .call()
    return {canEdit: !!out?.canEdit, canView: !!out?.canView}
}

// ===== occurrences =====
const recurrenceOf = workEffortId => one("mantle.work.effort.WorkEffortRecurrence", {workEffortId})
const repeats = workEffort => !!recurrenceOf(workEffort.workEffortId) || !blank(workEffort.recurStartCron)
function instancesOf(workEffort, fromMs, thruMs) {
    const out = call("mantle.work.EventServices.get#EventInstances", {
        workEffortList: [workEffort.getMap ? workEffort.getMap() : workEffort],
        rangeStart: new Date(fromMs),
        rangeEnd: new Date(thruMs)
    })
    return Array.from(out.instanceList || []).map(instance => ({
        key: Number(instance.recurrenceStart ?? instance.start),
        start: Number(instance.start),
        end: instance.end == null ? Number(instance.start) + HOUR : Number(instance.end),
        workEffortId: instance.workEffortId
    }))
}
// An occurrence of the event by its key (the start the series' rule gives it); an event that does not repeat, its one occurrence
// whatever its dates now. Null when there is none (a cancelled event or instance, a key the rule does not give).
function occurrenceOf(workEffort, key) {
    if (workEffort.statusId === "WeCancelled") return null
    if (!repeats(workEffort)) {
        const start = ms(workEffort.estimatedStartDate)
        if (start == null) return null
        return instancesOf(workEffort, start - DAY, start + DAY).find(instance => instance.start === start) || null
    }
    if (key == null) return null
    return instancesOf(workEffort, key - 31 * DAY, key + 31 * DAY).find(instance => instance.key === key) || null
}
// The occurrences to come a series offers for a choice (the next ones), or the event's own.
function upcomingOf(workEffort, zone) {
    if (workEffort.statusId === "WeCancelled") return []
    const list = repeats(workEffort)
        ? instancesOf(workEffort, nowMs(), nowMs() + 400 * DAY).slice(0, limits.occurrences)
        : [occurrenceOf(workEffort, null)].filter(Boolean)
    return list.map(instance => ({
        occurrenceStart: instance.key,
        startText: zoneText(instance.start, zone),
        endText: zoneText(instance.end, zone),
        label: zoneText(instance.start, zone)
    }))
}
const zoneOf = (workEffort, policy) =>
    text(policy?.timeZone) || text(recurrenceOf(workEffort.workEffortId)?.timeZone) || String(ec.user.timeZone || "UTC")

// ===== places, prices and gateways =====
// The places that take a seat on an offer (or one of its ticket types), and its waitlist.
function seatsTaken(registrationPolicyId, ticketTypeId = null) {
    const at = nowMs()
    const conditions = {registrationPolicyId}
    if (ticketTypeId) conditions.ticketTypeId = ticketTypeId
    return Array.from(
        find(REGISTRATION, conditions).condition("statusId", "in", SEAT_STATES).selectField("statusId,holdExpireDate").list()
    ).filter(row => row.statusId !== "EvrHeld" || row.holdExpireDate == null || ms(row.holdExpireDate) > at).length
}
const waitlisted = registrationPolicyId => find(REGISTRATION, {registrationPolicyId, statusId: "EvrWaitlisted"}).count()
// The organization's currency: its accounting preference's (its own, else the settings it rolls up to, find#PartyAcctgPreference).
function currencyOf(organizationPartyId) {
    try {
        return (
            call("mantle.ledger.LedgerServices.find#PartyAcctgPreference", {organizationPartyId}).partyAcctgPreference
                ?.baseCurrencyUomId || null
        )
    } catch (error) {
        ec.message.clearErrors()
        return one("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId})?.baseCurrencyUomId || null
    }
}
// A ticket's price now: {free, price, priceUomId, priceText} by its source; a product with no price in the currency is not
// available (priced false), never free.
function priceOf(ticket, policy) {
    if (ticket.priceSourceEnumId !== "EtpProduct" || blank(ticket.productId))
        return {free: true, priced: true, price: null, priceUomId: null, priceText: L("Free")}
    const priceUomId = currencyOf(policy.organizationPartyId)
    if (!priceUomId) return {free: false, priced: false, price: null, priceUomId: null, priceText: L("No price")}
    let out = null
    try {
        out = lib.probe("mantle.product.PriceServices.get#ProductPrice", {
            productId: ticket.productId,
            priceUomId,
            vendorPartyId: policy.organizationPartyId,
            productStoreId: policy.productStoreId || null
        })
    } catch (error) {
        ec.logger.error("Ticket type " + ticket.ticketTypeId + " price: " + String(error?.message || error).split("\n")[0])
    }
    if (!out?.priceAvailable || out.price == null)
        return {free: false, priced: false, price: null, priceUomId, priceText: L("No price")}
    const amount = Number(String(out.price))
    if (amount === 0) return {free: true, priced: true, price: out.price, priceUomId, priceText: L("Free")}
    return {free: false, priced: true, price: out.price, priceUomId, priceText: ec.l10n.formatCurrency(out.price, priceUomId)}
}
// The payment gateway a paid registration would pay through: the store's (its card gateway) when the offer names a store, else
// the organization's invoice gateway when it is bound, else its first binding in effect. Null when there is none.
function gatewayOf(policy) {
    if (policy.productStoreId)
        return (
            rows("mantle.product.store.ProductStorePaymentGateway", {productStoreId: policy.productStoreId})
                .map(row => row.paymentGatewayConfigId)
                .filter(Boolean)
                .sort()[0] || null
        )
    const bindings = rows("mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId: policy.organizationPartyId
    }).filter(row => row.isEnabled !== "N" && lib.active(row))
    const preferred = one("mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: policy.organizationPartyId
    })?.invoicePayGatewayConfigId
    if (preferred && bindings.some(row => row.paymentGatewayConfigId === preferred)) return preferred
    return bindings.map(row => row.paymentGatewayConfigId).sort()[0] || null
}
// The transactional profile the notices are sent from: the offer's when it names one of the organization, else the organization's
// ready one; with its readiness.
function profileOf(policy) {
    const candidates = rows("mantle.party.MessageSendingProfile", {
        organizationPartyId: policy.organizationPartyId,
        channelEnumId: "MdcEmail"
    }).filter(row => (!row.purposeEnumId || row.purposeEnumId === "MtpTransactional") && lib.active(row))
    if (policy.sendingProfileId) {
        const named = candidates.find(row => row.sendingProfileId === policy.sendingProfileId)
        return named ? {profile: named, ready: profiles().readinessOf(named).ready} : null
    }
    const ready = candidates
        .sort((a, b) => String(a.sendingProfileId).localeCompare(String(b.sendingProfileId)))
        .find(row => profiles().readinessOf(row).ready)
    return ready ? {profile: ready, ready: true} : null
}
// The sites an offer of the organization may be on: an enabled Marketing mount targeting it (published or not; publishing asks a
// published one).
const mountedSiteIds = organizationPartyId =>
    rows("mantle.public.PublicSiteApp", {app: "marketing", enabled: "Y", targetId: organizationPartyId}).map(row => row.siteId)
const publishedSiteIds = organizationPartyId => apps().sitesFor("marketing", organizationPartyId)
const currentTickets = registrationPolicyId =>
    rows(TICKET, {registrationPolicyId})
        .filter(row => lib.active(row))
        .sort(
            (a, b) =>
                Number(a.sequenceNum || 0) - Number(b.sequenceNum || 0) || String(a.ticketTypeId).localeCompare(b.ticketTypeId)
        )
const currentSchedules = registrationPolicyId => rows(SCHEDULE, {registrationPolicyId}).filter(row => lib.active(row))

// ===== readiness =====
// What an offer needs before it opens, each check named (design §9 PublishRegistration; impl-marketing P16).
function readinessOf(policy, workEffort) {
    const occurrence = workEffort ? occurrenceOf(workEffort, ms(policy.occurrenceStart)) : null
    const tickets = currentTickets(policy.registrationPolicyId)
    const prices = tickets.map(ticket => priceOf(ticket, policy))
    const paid = prices.some(price => !price.free)
    const closes = timeOf(policy.closesDate)
    const opens = timeOf(policy.opensDate)
    const form = policy.formPublicationId ? one(PUBLICATION, {publicationId: policy.formPublicationId}) : null
    const checks = [
        {
            name: "occurrence",
            label: L("An occurrence still to come, of an event not cancelled"),
            ready: !!occurrence && occurrence.end > nowMs()
        },
        {name: "seats", label: L("Seats to offer"), ready: Number(policy.totalSeats || 0) > 0},
        {name: "tickets", label: L("A ticket type"), ready: tickets.length > 0},
        {
            name: "prices",
            label: L("Each paid ticket priced in the organization's currency"),
            ready: prices.every(price => price.priced)
        },
        {
            name: "window",
            label: L("Registration closes after it opens and by the end of the occurrence"),
            ready:
                (opens == null || closes == null || closes > opens) &&
                (closes == null || closes > nowMs()) &&
                (!occurrence || closes == null || closes <= occurrence.end)
        },
        {
            name: "site",
            label: L("A published site whose Marketing pages serve the organization"),
            ready: !!policy.siteId && publishedSiteIds(policy.organizationPartyId).includes(policy.siteId)
        },
        {
            name: "profile",
            label: L("A ready sending profile for the registration notices"),
            ready: !!profileOf(policy)?.ready
        },
        {
            name: "gateway",
            label: L("A payment gateway for the paid tickets"),
            ready: !paid || !!gatewayOf(policy)
        },
        {
            name: "questions",
            label: L("The registration questions' form published"),
            ready: !form || definitions().formAt(form.formId, null, false).length > 0
        }
    ]
    return checks
}

// ===== find#Events, get#EventSetup =====
function eventRow(event, workEffort, policies, campaignNames) {
    const zone = zoneOf(workEffort, policies[0])
    const occurrence = occurrenceOf(workEffort, policies[0] ? ms(policies[0].occurrenceStart) : null)
    let confirmed = 0,
        held = 0,
        seats = 0,
        waiting = 0
    for (const policy of policies) {
        const counts = Array.from(
            find(REGISTRATION, {registrationPolicyId: policy.registrationPolicyId}).selectField("statusId,holdExpireDate").list()
        )
        confirmed += counts.filter(row => row.statusId === "EvrConfirmed").length
        held += counts.filter(
            row =>
                row.statusId === "EvrPending" ||
                (row.statusId === "EvrHeld" && (row.holdExpireDate == null || ms(row.holdExpireDate) > nowMs()))
        ).length
        waiting += counts.filter(row => row.statusId === "EvrWaitlisted").length
        if (policy.statusId !== "ErpClosed") seats += Number(policy.totalSeats || 0)
    }
    const published = policies.filter(policy => policy.statusId === "ErpPublished").length
    const state = published ? "ErpPublished" : policies.some(policy => policy.statusId === "ErpDraft") ? "ErpDraft" : null
    return {
        workEffortId: workEffort.workEffortId,
        eventName: workEffort.workEffortName || workEffort.workEffortId,
        organizationPartyId: event.organizationPartyId,
        organizationName: organizationName(event.organizationPartyId),
        whenText: occurrence
            ? zoneText(occurrence.start, zone) + (repeats(workEffort) ? " · " + L("repeats") : "")
            : workEffort.statusId === "WeCancelled"
              ? L("Cancelled")
              : zoneText(ms(workEffort.estimatedStartDate), zone),
        startMs: occurrence?.start ?? ms(workEffort.estimatedStartDate) ?? 0,
        timeZone: zone,
        location: workEffort.location || (workEffort.infoUrl ? L("Online") : ""),
        campaignText: campaignNames.join(", "),
        offerCount: policies.length,
        confirmedCount: confirmed,
        heldCount: held,
        waitlistedCount: waiting,
        seatCount: seats,
        capacityText: seats ? confirmed + held + " / " + seats : "",
        statusId: state,
        stateText: state ? L(stateTexts[state]) : L("No offer"),
        stateColor: state ? stateColors[state] : "grey-6"
    }
}
// The current campaign links of events (CakEvent): {workEffortId: [{marketingCampaignId, campaignName}]}.
function campaignsOf(workEffortIds) {
    const out = {}
    if (!workEffortIds.length) return out
    const links = Array.from(
        find(ASSOCIATION, {associationKindEnumId: "CakEvent"}).condition("sourceId", "in", workEffortIds).list()
    ).filter(link => lib.active(link))
    const campaigns = new Map(
        links.length
            ? Array.from(
                  find(CAMPAIGN)
                      .condition(
                          "marketingCampaignId",
                          "in",
                          links.map(link => link.marketingCampaignId)
                      )
                      .list()
              ).map(row => [row.marketingCampaignId, row])
            : []
    )
    for (const link of links) {
        const campaign = campaigns.get(link.marketingCampaignId)
        if (!campaign) continue
        ;(out[link.sourceId] = out[link.sourceId] || []).push({
            marketingCampaignId: campaign.marketingCampaignId,
            campaignName: campaign.campaignName || campaign.marketingCampaignId,
            organizationPartyId: campaign.organizationPartyId
        })
    }
    return out
}
function findEvents(p) {
    const userScope = readScope()
    const organizationIds = marketingAccess.organizationIds(userScope)
    let query = find(EVENT).condition("organizationPartyId", "in", organizationIds.length ? organizationIds : ["_NONE_"])
    if (!blank(p.organizationPartyId)) query = query.condition("organizationPartyId", text(p.organizationPartyId))
    let events = Array.from(query.orderBy("-createdDate").limit(limits.events).list())
    if (!blank(p.marketingCampaignId)) {
        const campaign = one(CAMPAIGN, {marketingCampaignId: text(p.marketingCampaignId)})
        if (!campaign || !marketingAccess.covers(userScope, campaign.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Campaign " + p.marketingCampaignId + " is not available")
        const linked = new Set(
            rows(ASSOCIATION, {marketingCampaignId: campaign.marketingCampaignId, associationKindEnumId: "CakEvent"})
                .filter(link => lib.active(link))
                .map(link => link.sourceId)
        )
        events = events.filter(event => linked.has(event.workEffortId))
    }
    const ids = events.map(event => event.workEffortId)
    const workEfforts = new Map(
        ids.length
            ? Array.from(find(WORK_EFFORT).condition("workEffortId", "in", ids).list()).map(row => [row.workEffortId, row])
            : []
    )
    const policies = {}
    if (ids.length)
        for (const policy of Array.from(find(POLICY).condition("workEffortId", "in", ids).orderBy("occurrenceStart").list()))
            (policies[policy.workEffortId] = policies[policy.workEffortId] || []).push(policy)
    const links = campaignsOf(ids)
    const term = text(p.term)?.toLowerCase()
    const fromMs = timeOf(p.fromDate)
    const thruMs = timeOf(p.thruDate)
    let list = []
    for (const event of events) {
        const workEffort = workEfforts.get(event.workEffortId)
        if (!workEffort) continue
        try {
            const row = eventRow(
                event,
                workEffort,
                policies[event.workEffortId] || [],
                (links[event.workEffortId] || []).map(link => link.campaignName)
            )
            if (term && !String(row.eventName).toLowerCase().includes(term) && !String(row.location).toLowerCase().includes(term))
                continue
            if (fromMs != null && row.startMs < fromMs) continue
            if (thruMs != null && row.startMs >= thruMs) continue
            if (!blank(p.statusId) && (p.statusId === "none" ? row.statusId : row.statusId !== p.statusId)) continue
            list.push(row)
        } catch (error) {
            // one event that cannot be read is logged and the others listed
            ec.logger.error("Registration event " + event.workEffortId + ": " + String(error?.message || error).split("\n")[0])
        }
    }
    list.sort((a, b) => a.startMs - b.startMs)
    return Object.assign({canCreate: !!userScope.capabilities.eventManage}, lib.pageList(list, p, "eventList"))
}
function ticketView(ticket, policy) {
    const price = priceOf(ticket, policy)
    const taken = seatsTaken(policy.registrationPolicyId, ticket.ticketTypeId)
    const product = ticket.productId ? one("mantle.product.Product", {productId: ticket.productId}) : null
    return {
        ticketTypeId: ticket.ticketTypeId,
        ticketName: ticket.ticketName || "",
        priceSourceEnumId: ticket.priceSourceEnumId,
        productId: ticket.productId || "",
        productName: product ? product.productName || product.productId : "",
        priceText: price.priceText,
        free: price.free,
        priced: price.priced,
        capacity: ticket.capacity,
        capacityText: ticket.capacity == null ? L("The offer's seats") : String(ticket.capacity),
        takenCount: taken,
        salesFromDate: ticket.salesFromDate,
        salesThruDate: ticket.salesThruDate,
        salesText: [lib.dateText(ticket.salesFromDate), lib.dateText(ticket.salesThruDate)].filter(Boolean).join(" – "),
        perOrderLimit: ticket.perOrderLimit,
        sequenceNum: ticket.sequenceNum,
        revision: ms(ticket.lastUpdatedStamp)
    }
}
function scheduleView(schedule) {
    const template = schedule.messageTemplateId
        ? one("mantle.party.MessageTemplate", {messageTemplateId: schedule.messageTemplateId})
        : null
    const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
    return {
        scheduleId: schedule.scheduleId,
        triggerEnumId: schedule.triggerEnumId,
        triggerText: enumText(schedule.triggerEnumId),
        offsetMinutes: schedule.offsetMinutes,
        offsetText: schedule.offsetMinutes ? String(schedule.offsetMinutes) + " " + L("minutes") : "",
        messageTemplateId: schedule.messageTemplateId,
        templateName: template?.templateName || schedule.messageTemplateId || "",
        recipientScopeEnumId: schedule.recipientScopeEnumId,
        recipientText: enumText(schedule.recipientScopeEnumId),
        purposeEnumId: schedule.purposeEnumId,
        kindText: schedule.purposeEnumId === "MtpPromotional" ? L("Promotional") : L("Transactional"),
        revision: ms(schedule.lastUpdatedStamp)
    }
}
function policyView(policy, workEffort, canManage) {
    const zone = zoneOf(workEffort, policy)
    const occurrence = occurrenceOf(workEffort, ms(policy.occurrenceStart))
    const checks = readinessOf(policy, workEffort)
    const form = policy.formPublicationId ? one(PUBLICATION, {publicationId: policy.formPublicationId}) : null
    const dbForm = form ? one("moqui.screen.form.DbForm", {formId: form.formId}) : null
    const taken = seatsTaken(policy.registrationPolicyId)
    const site = policy.siteId ? one("mantle.public.PublicSite", {siteId: policy.siteId}) : null
    const store = policy.productStoreId ? one("mantle.product.store.ProductStore", {productStoreId: policy.productStoreId}) : null
    return {
        registrationPolicyId: policy.registrationPolicyId,
        statusId: policy.statusId,
        stateText: L(stateTexts[policy.statusId] || policy.statusId),
        stateColor: stateColors[policy.statusId] || "grey-8",
        occurrenceStart: ms(policy.occurrenceStart),
        occurrenceText: occurrence
            ? zoneText(occurrence.start, zone) + " – " + zoneText(occurrence.end, zone, "HH:mm")
            : L("No longer an occurrence of the event"),
        timeZone: zone,
        publicTitle: policy.publicTitle || "",
        publicDescription: policy.publicDescription || "",
        siteId: policy.siteId || "",
        siteName: site ? site.name || site.siteId : "",
        productStoreId: policy.productStoreId || "",
        storeName: store ? store.storeName || store.productStoreId : "",
        opensDate: policy.opensDate,
        closesDate: policy.closesDate,
        windowText: [lib.dateText(policy.opensDate) || L("now"), lib.dateText(policy.closesDate) || L("the start")].join(" – "),
        totalSeats: policy.totalSeats,
        takenCount: taken,
        waitlistedCount: waitlisted(policy.registrationPolicyId),
        seatsText: policy.totalSeats == null ? "" : taken + " / " + policy.totalSeats,
        holdMinutes: policy.holdMinutes,
        waitlistEnabled: policy.waitlistEnabled || "N",
        waitlistLimit: policy.waitlistLimit,
        termsText: policy.termsText || "",
        cancellationTerms: policy.cancellationTerms || "",
        formPublicationId: policy.formPublicationId || "",
        formId: form?.formId || "",
        formName: dbForm ? dbForm.description || dbForm.formId : "",
        questionScopeEnumId: policy.questionScopeEnumId || "ErqAttendee",
        consentText: policy.consentText || "",
        sendingProfileId: policy.sendingProfileId || "",
        policyRevision: Number(policy.policyRevision || 1),
        termsRevision: Number(policy.termsRevision || 0),
        publishedText: policy.publishedDate
            ? lib.dateText(policy.publishedDate) + " " + L("by") + " " + userText(policy.publishedByUserId)
            : "",
        revision: ms(policy.lastUpdatedStamp),
        tickets: currentTickets(policy.registrationPolicyId).map(ticket => ticketView(ticket, policy)),
        schedules: currentSchedules(policy.registrationPolicyId).map(scheduleView),
        checks,
        ready: checks.every(check => check.ready),
        publicUrl:
            policy.siteId && policy.statusId === "ErpPublished"
                ? apps().pageUrl(policy.siteId, "marketing", "/Event?offer=" + encodeURIComponent(policy.registrationPolicyId))
                : null,
        canPublish: canManage && policy.statusId === "ErpDraft",
        canClose: canManage && policy.statusId === "ErpPublished",
        canChange: canManage && policy.statusId !== "ErpClosed"
    }
}
function getEventSetup(p) {
    const userScope = readScope()
    const {event, workEffort} = eventOf(userScope, p.workEffortId)
    const canManage = !!userScope.capabilities.eventManage
    const access = eventAccess(workEffort.workEffortId)
    const policies = rows(POLICY, {workEffortId: workEffort.workEffortId}).sort(
        (a, b) => (ms(a.occurrenceStart) ?? 0) - (ms(b.occurrenceStart) ?? 0)
    )
    const zone = zoneOf(workEffort, policies[0])
    const offered = new Set(policies.map(policy => ms(policy.occurrenceStart)))
    const campaigns = campaignsOf([workEffort.workEffortId])[workEffort.workEffortId] || []
    return {
        event: Object.assign(
            eventRow(
                event,
                workEffort,
                policies,
                campaigns.map(link => link.campaignName)
            ),
            {
                description: workEffort.description || "",
                repeats: repeats(workEffort),
                online: !blank(workEffort.infoUrl),
                cancelled: workEffort.statusId === "WeCancelled",
                createdText: lib.dateText(event.createdDate) + " " + L("by") + " " + userText(event.createdByUserId),
                campaigns
            }
        ),
        offers: policies.map(policy => policyView(policy, workEffort, canManage)),
        // the occurrences still to come that have no offer yet
        occurrences: upcomingOf(workEffort, zone).filter(occurrence => !offered.has(occurrence.occurrenceStart)),
        canManage,
        canEditEvent: access.canEdit
    }
}

// ===== store#RegistrationEvent =====
// The organization an event's registration is offered by, and its campaign link: an events manager of the organization who may edit
// the event (the calendar's own rule) adopts it once; the same organization again changes nothing, another is refused. A campaign
// named is an open campaign of the organization, linked once (CakEvent).
function storeRegistrationEvent(p) {
    const userScope = manageScope()
    const workEffortId = text(p.workEffortId)
    const workEffort = workEffortId ? one(WORK_EFFORT, {workEffortId}) : null
    const organizationPartyId = text(p.organizationPartyId)
    const existing = workEffortId ? one(EVENT, {workEffortId}) : null
    if (existing) {
        if (!marketingAccess.covers(userScope, existing.organizationPartyId))
            denied("RECORD_UNAVAILABLE", "Event " + workEffortId + " is not available")
        if (organizationPartyId && organizationPartyId !== existing.organizationPartyId)
            denied(
                "ORGANIZATION_FIXED",
                "The event's registration is offered by " + organizationName(existing.organizationPartyId)
            )
    } else {
        if (!workEffort || workEffort.workEffortTypeEnumId !== "WetEvent")
            denied("RECORD_UNAVAILABLE", "Event " + (workEffortId || "") + " is not available")
        if (!eventAccess(workEffortId).canEdit)
            denied("EVENT_EDIT_REQUIRED", "Only the event's organizer or an editor of its calendar offers registration for it")
        marketingAccess.requireOrganization(userScope, organizationPartyId)
        if (!marketingAccess.internalOrganization(organizationPartyId))
            denied("ORGANIZATION_DENIED", "An internal organization offers registration")
        call("create#" + EVENT, {
            workEffortId,
            organizationPartyId,
            createdByUserId: ec.user.userId,
            createdDate: ec.user.nowTimestamp
        })
    }
    const orgId = existing?.organizationPartyId || organizationPartyId
    let campaignAssociationId = null
    if (!blank(p.marketingCampaignId)) {
        const campaign = one(CAMPAIGN, {marketingCampaignId: text(p.marketingCampaignId)})
        if (!campaign || campaign.organizationPartyId !== orgId)
            denied(
                "RECORD_UNAVAILABLE",
                "Campaign " + p.marketingCampaignId + " is not available; an event links a campaign of its organization"
            )
        if (!openCampaignStatuses.includes(campaign.statusId))
            denied("CAMPAIGN_CLOSED", "Campaign " + (campaign.campaignName || campaign.marketingCampaignId) + " is closed")
        const link = rows(ASSOCIATION, {
            marketingCampaignId: campaign.marketingCampaignId,
            associationKindEnumId: "CakEvent",
            sourceId: workEffortId
        }).find(row => lib.active(row))
        campaignAssociationId = link
            ? link.campaignAssociationId
            : call("create#" + ASSOCIATION, {
                  marketingCampaignId: campaign.marketingCampaignId,
                  associationKindEnumId: "CakEvent",
                  sourceId: workEffortId,
                  purpose: "Event",
                  fromDate: ec.user.nowTimestamp,
                  createdByUserId: ec.user.userId
              }).campaignAssociationId
    }
    return {workEffortId, organizationPartyId: orgId, campaignAssociationId, created: !existing}
}

// ===== store#RegistrationPolicy =====
const POLICY_FIELDS = ["publicTitle", "publicDescription", "termsText", "cancellationTerms", "timeZone"]
function storeRegistrationPolicy(p) {
    const userScope = manageScope()
    let row = null,
        workEffort,
        event
    if (!blank(p.registrationPolicyId)) {
        row = policyOf(userScope, p.registrationPolicyId, true)
        requireRevision(row, p.expectedRevision, "Registration offer " + row.registrationPolicyId)
        requireDraftOrPublished(row)
        ;({event, workEffort} = eventOf(userScope, row.workEffortId))
    } else ({event, workEffort} = eventOf(userScope, p.workEffortId))
    const organizationPartyId = event.organizationPartyId
    const values = {}
    // the occurrence: an event that does not repeat has one; a series names one of its occurrences
    if (!row) {
        const key = repeats(workEffort) ? timeOf(p.occurrenceStart) : null
        if (repeats(workEffort) && key == null) denied("OCCURRENCE_REQUIRED", "Choose the occurrence of the series to offer")
        const occurrence = occurrenceOf(workEffort, key)
        if (!occurrence) denied("OCCURRENCE_UNAVAILABLE", "That is not an occurrence of the event, or it is cancelled")
        if (occurrence.end <= nowMs()) denied("OCCURRENCE_PAST", "That occurrence is over")
        if (find(POLICY, {workEffortId: workEffort.workEffortId, occurrenceStart: new Date(occurrence.key)}).count())
            denied("OFFER_EXISTS", "That occurrence has an offer already")
        Object.assign(values, {occurrenceStart: new Date(occurrence.key), occurrenceEnd: new Date(occurrence.end)})
    }
    for (const name of POLICY_FIELDS) {
        if (p[name] === undefined || p[name] === null) continue
        const value = text(p[name])
        const limit = name === "publicTitle" ? limits.title : name === "timeZone" ? 64 : limits.terms
        if (value && value.length > limit) denied("TEXT_TOO_LONG", "At most " + limit + " characters")
        if (
            name === "timeZone" &&
            value &&
            !Array.from(ec.l10n.getAvailableTimeZones() || [])
                .map(String)
                .includes(value)
        )
            denied("ZONE_INVALID", "Choose a time zone")
        values[name] = value
    }
    if (p.siteId !== undefined && p.siteId !== null) {
        const siteId = text(p.siteId)
        if (siteId && !mountedSiteIds(organizationPartyId).includes(siteId))
            denied("SITE_INVALID", "Choose a site whose Marketing pages serve the organization")
        values.siteId = siteId
    }
    if (p.productStoreId !== undefined && p.productStoreId !== null) {
        const productStoreId = text(p.productStoreId)
        const store = productStoreId ? one("mantle.product.store.ProductStore", {productStoreId}) : null
        if (productStoreId && (!store || store.organizationPartyId !== organizationPartyId))
            denied("STORE_INVALID", "Choose a store of the organization, or none for a storeless order")
        if (
            row?.statusId === "ErpPublished" &&
            productStoreId !== (row.productStoreId || null) &&
            seatsTaken(row.registrationPolicyId)
        )
            denied("STORE_FIXED", "An offer with places taken keeps how its orders are placed")
        values.productStoreId = productStoreId
    }
    for (const [name, label] of [
        ["opensDate", "It opens"],
        ["closesDate", "It closes"]
    ])
        if (p[name] !== undefined && p[name] !== null) values[name] = blank(p[name]) ? null : p[name]
    const opens = timeOf(values.opensDate !== undefined ? values.opensDate : row?.opensDate)
    const closes = timeOf(values.closesDate !== undefined ? values.closesDate : row?.closesDate)
    if (opens != null && closes != null && closes <= opens) denied("WINDOW_INVALID", "Registration closes after it opens")
    if (p.totalSeats !== undefined && p.totalSeats !== null) {
        const seats = wholeOf(p.totalSeats, "SEATS_INVALID", "The seats", 0, limits.seats)
        const taken = row ? seatsTaken(row.registrationPolicyId) : 0
        if (seats != null && seats < taken)
            denied("CAPACITY_BELOW_TAKEN", "The seats cannot be fewer than the " + taken + " places held or confirmed")
        values.totalSeats = seats
    }
    if (p.holdMinutes !== undefined && p.holdMinutes !== null)
        values.holdMinutes = wholeOf(
            p.holdMinutes,
            "HOLD_INVALID",
            "The hold in minutes",
            limits.holdMinutes[0],
            limits.holdMinutes[1]
        )
    if (p.waitlistEnabled !== undefined && p.waitlistEnabled !== null) values.waitlistEnabled = yes(p.waitlistEnabled) ? "Y" : "N"
    if (p.waitlistLimit !== undefined && p.waitlistLimit !== null)
        values.waitlistLimit = wholeOf(p.waitlistLimit, "WAITLIST_INVALID", "The waitlist's places", 0, limits.seats)
    if (p.sendingProfileId !== undefined && p.sendingProfileId !== null) {
        const sendingProfileId = text(p.sendingProfileId)
        const profile = sendingProfileId ? one("mantle.party.MessageSendingProfile", {sendingProfileId}) : null
        if (
            sendingProfileId &&
            (!profile || profile.organizationPartyId !== organizationPartyId || profile.purposeEnumId === "MtpPromotional")
        )
            denied("PROFILE_INVALID", "Choose a transactional sending profile of the organization")
        values.sendingProfileId = sendingProfileId
    }
    if (row) {
        const changed = Object.keys(values).filter(name => String(values[name] ?? "") !== String(row[name] ?? ""))
        if (!changed.length) return {registrationPolicyId: row.registrationPolicyId, changed: false}
        values.policyRevision = Number(row.policyRevision || 1) + 1
        // the terms a registration accepts: a change after it was published is a new terms revision (P17 keeps it on each)
        if (row.publishedDate && changed.some(name => name === "termsText" || name === "cancellationTerms"))
            values.termsRevision = Number(row.termsRevision || 0) + 1
        call("update#" + POLICY, Object.assign({registrationPolicyId: row.registrationPolicyId}, values))
        // the questions are answered on the offer's site
        if (changed.includes("siteId") && row.formPublicationId) {
            const publication = one(PUBLICATION, {publicationId: row.formPublicationId})
            if (publication && publications().stateOf(publication) !== "closed")
                call("update#" + PUBLICATION, {publicationId: publication.publicationId, siteId: values.siteId || null})
        }
        return {registrationPolicyId: row.registrationPolicyId, changed: true}
    }
    const registrationPolicyId = call(
        "create#" + POLICY,
        Object.assign(
            {
                workEffortId: workEffort.workEffortId,
                organizationPartyId,
                statusId: "ErpDraft",
                publicTitle: values.publicTitle || workEffort.workEffortName || null,
                timeZone: values.timeZone || zoneOf(workEffort, null),
                holdMinutes: 15,
                waitlistEnabled: "N",
                questionScopeEnumId: "ErqAttendee",
                policyRevision: 1,
                termsRevision: 0,
                createdByUserId: ec.user.userId,
                createdDate: ec.user.nowTimestamp
            },
            Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined && value !== null))
        )
    ).registrationPolicyId
    return {registrationPolicyId, changed: true}
}

// ===== store#TicketType =====
function ticketProductOf(productId, organizationPartyId) {
    const product = blank(productId) ? null : one("mantle.product.Product", {productId: text(productId)})
    if (!product || product.ownerPartyId !== organizationPartyId || product.salesAllowed === "N")
        denied("PRODUCT_INVALID", "Choose a ticket product the organization sells")
    if (product.requireInventory === "Y")
        denied("PRODUCT_INVALID", "A ticket product is not kept in inventory; its places are the seats")
    return product
}
function linkProduct(workEffortId, productId) {
    if (!productId) return
    const linked = rows("mantle.work.effort.WorkEffortProduct", {workEffortId, productId}).some(row => lib.active(row))
    if (!linked)
        call("create#mantle.work.effort.WorkEffortProduct", {
            workEffortId,
            productId,
            fromDate: ec.user.nowTimestamp,
            typeEnumId: "WeptSales"
        })
}
// The event's ticket product link ends when no current ticket type of its offers names the product.
function unlinkProduct(workEffortId, productId) {
    if (!productId) return
    const policyIds = rows(POLICY, {workEffortId}).map(row => row.registrationPolicyId)
    const stillUsed = policyIds.some(id => currentTickets(id).some(ticket => ticket.productId === productId))
    if (stillUsed) return
    for (const link of rows("mantle.work.effort.WorkEffortProduct", {workEffortId, productId}).filter(row => lib.active(row)))
        call("update#mantle.work.effort.WorkEffortProduct", {
            workEffortId,
            productId,
            fromDate: link.fromDate,
            thruDate: ec.user.nowTimestamp
        })
}
function storeTicketType(p) {
    const userScope = manageScope()
    let ticket = null,
        policy
    if (!blank(p.ticketTypeId)) {
        ticket = one(TICKET, {ticketTypeId: text(p.ticketTypeId)})
        if (!ticket) denied("RECORD_UNAVAILABLE", "Ticket type " + p.ticketTypeId + " is not available")
        policy = policyOf(userScope, ticket.registrationPolicyId, true)
        requireRevision(ticket, p.expectedRevision, "Ticket type " + ticket.ticketTypeId)
        if (!lib.active(ticket)) denied("TICKET_ENDED", "An ended ticket type is not changed")
    } else policy = policyOf(userScope, p.registrationPolicyId, true)
    requireDraftOrPublished(policy)
    const action = text(p.action) || "store"
    if (action === "end") {
        if (!ticket) denied("RECORD_UNAVAILABLE", "Name the ticket type to end")
        call("update#" + TICKET, {ticketTypeId: ticket.ticketTypeId, thruDate: ec.user.nowTimestamp})
        unlinkProduct(policy.workEffortId, ticket.productId)
        call("update#" + POLICY, {
            registrationPolicyId: policy.registrationPolicyId,
            policyRevision: Number(policy.policyRevision || 1) + 1
        })
        return {ticketTypeId: ticket.ticketTypeId}
    }
    if (action !== "store") denied("ACTION_INVALID", "Store or end")
    const values = {}
    if (p.ticketName !== undefined && p.ticketName !== null) {
        const name = text(p.ticketName)
        if (!name) denied("NAME_REQUIRED", "Name the ticket type")
        if (name.length > limits.title) denied("TEXT_TOO_LONG", "At most " + limits.title + " characters")
        values.ticketName = name
    } else if (!ticket) denied("NAME_REQUIRED", "Name the ticket type")
    const source = text(p.priceSourceEnumId) || ticket?.priceSourceEnumId || (blank(p.productId) ? "EtpFree" : "EtpProduct")
    if (!["EtpFree", "EtpProduct"].includes(source)) denied("PRICE_SOURCE_INVALID", "Free, or the ticket product's price")
    values.priceSourceEnumId = source
    const productId = source === "EtpProduct" ? (text(p.productId) ?? ticket?.productId ?? null) : null
    if (source === "EtpProduct") ticketProductOf(productId, policy.organizationPartyId)
    const taken = ticket ? seatsTaken(policy.registrationPolicyId, ticket.ticketTypeId) : 0
    if (ticket && taken && (productId || null) !== (ticket.productId || null))
        denied("PRODUCT_FIXED", "A ticket type with places taken keeps its product; end it and add another")
    values.productId = productId
    if (p.capacity !== undefined && p.capacity !== null) {
        const capacity = wholeOf(p.capacity, "CAPACITY_INVALID", "The ticket's places", 0, limits.seats)
        if (capacity != null && capacity < taken)
            denied("CAPACITY_BELOW_TAKEN", "The ticket's places cannot be fewer than the " + taken + " held or confirmed")
        values.capacity = capacity
    }
    for (const name of ["salesFromDate", "salesThruDate"])
        if (p[name] !== undefined && p[name] !== null) values[name] = blank(p[name]) ? null : p[name]
    const from = timeOf(values.salesFromDate !== undefined ? values.salesFromDate : ticket?.salesFromDate)
    const thru = timeOf(values.salesThruDate !== undefined ? values.salesThruDate : ticket?.salesThruDate)
    if (from != null && thru != null && thru <= from) denied("WINDOW_INVALID", "Sales end after they start")
    if (p.perOrderLimit !== undefined && p.perOrderLimit !== null)
        values.perOrderLimit = wholeOf(p.perOrderLimit, "LIMIT_INVALID", "The places an order may take", 1, limits.perOrder)
    if (p.sequenceNum !== undefined && p.sequenceNum !== null)
        values.sequenceNum = wholeOf(p.sequenceNum, "SEQUENCE_INVALID", "The order", 0, 999)
    let ticketTypeId
    if (ticket) {
        call("update#" + TICKET, Object.assign({ticketTypeId: ticket.ticketTypeId}, values))
        ticketTypeId = ticket.ticketTypeId
        if ((ticket.productId || null) !== productId) unlinkProduct(policy.workEffortId, ticket.productId)
    } else
        ticketTypeId = call(
            "create#" + TICKET,
            Object.assign(
                {
                    registrationPolicyId: policy.registrationPolicyId,
                    perOrderLimit: 10,
                    sequenceNum: currentTickets(policy.registrationPolicyId).length + 1,
                    fromDate: ec.user.nowTimestamp,
                    createdByUserId: ec.user.userId
                },
                Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
            )
        ).ticketTypeId
    linkProduct(policy.workEffortId, productId)
    call("update#" + POLICY, {
        registrationPolicyId: policy.registrationPolicyId,
        policyRevision: Number(policy.policyRevision || 1) + 1
    })
    return {ticketTypeId}
}

// ===== store#RegistrationForm =====
// The registration questions: a published registration form (DbfpRegistration) of the organization, as the offer's publication of
// purpose registration (anonymous, answered with each registration, P17), whom they are for and the consent text; a new form closes
// the earlier publication; no form ends them.
function storeRegistrationForm(p) {
    const userScope = manageScope()
    const policy = policyOf(userScope, p.registrationPolicyId, true)
    requireRevision(policy, p.expectedRevision, "Registration offer " + policy.registrationPolicyId)
    requireDraftOrPublished(policy)
    const values = {}
    if (p.questionScopeEnumId !== undefined && p.questionScopeEnumId !== null) {
        const scope = text(p.questionScopeEnumId) || "ErqAttendee"
        if (!["ErqAttendee", "ErqBuyer"].includes(scope)) denied("SCOPE_INVALID", "Each attendee or the buyer once")
        values.questionScopeEnumId = scope
    }
    if (p.consentText !== undefined && p.consentText !== null) {
        const consent = text(p.consentText)
        if (consent && consent.length > limits.terms) denied("TEXT_TOO_LONG", "At most " + limits.terms + " characters")
        values.consentText = consent
    }
    const current = policy.formPublicationId ? one(PUBLICATION, {publicationId: policy.formPublicationId}) : null
    if (p.formId !== undefined && p.formId !== null) {
        const formId = text(p.formId)
        if (!formId) {
            if (current) closePublication(current)
            values.formPublicationId = null
        } else if (current?.formId !== formId) {
            const form = one("moqui.screen.form.DbForm", {formId})
            if (!form || form.purposeEnumId !== "DbfpRegistration" || form.ownerPartyId !== policy.organizationPartyId)
                denied("FORM_INVALID", "Choose registration questions of the organization")
            if (!definitions().formAt(formId, null, false).length)
                denied("FORM_NOT_PUBLISHED", "Publish the registration questions first")
            if (current) closePublication(current)
            // the publication row written here, after these checks: Commons' publication services ask the form's editor (a
            // content author), and an events manager only names a published registration form of the organization
            const opened = policy.statusId === "ErpPublished"
            values.formPublicationId = call("create#" + PUBLICATION, {
                formId,
                organizationPartyId: policy.organizationPartyId,
                purposeEnumId: "FppRegistration",
                accessEnumId: "FpaAnonymous",
                repeatEnumId: "FprMany",
                siteId: policy.siteId || null,
                contextEntityName: POLICY,
                contextId: policy.registrationPolicyId,
                description: "Registration questions of offer " + policy.registrationPolicyId,
                titleText: policy.publicTitle || null,
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId,
                fromDate: opened ? ec.user.nowTimestamp : null,
                publishedDate: opened ? ec.user.nowTimestamp : null,
                publishedByUserId: opened ? ec.user.userId : null
            }).publicationId
        }
    }
    values.policyRevision = Number(policy.policyRevision || 1) + 1
    call("update#" + POLICY, Object.assign({registrationPolicyId: policy.registrationPolicyId}, values))
    const after = one(POLICY, {registrationPolicyId: policy.registrationPolicyId})
    return {registrationPolicyId: policy.registrationPolicyId, formPublicationId: after.formPublicationId || null}
}
function closePublication(publication) {
    if (publications().stateOf(publication) === "closed") return
    call("update#" + PUBLICATION, {
        publicationId: publication.publicationId,
        thruDate: ec.user.nowTimestamp,
        closedByUserId: ec.user.userId || null
    })
}
// The question publication follows the offer: its site, open while the offer is, closed with it.
function syncPublication(policy, open) {
    const publication = policy.formPublicationId ? one(PUBLICATION, {publicationId: policy.formPublicationId}) : null
    if (!publication) return
    if (!open) return closePublication(publication)
    if (publications().stateOf(publication) === "closed") return
    const values = {publicationId: publication.publicationId, siteId: policy.siteId || null}
    if (publication.fromDate == null)
        Object.assign(values, {
            fromDate: ec.user.nowTimestamp,
            publishedDate: ec.user.nowTimestamp,
            publishedByUserId: ec.user.userId
        })
    call("update#" + PUBLICATION, values)
}

// ===== store#CommunicationSchedule =====
function storeCommunicationSchedule(p) {
    const userScope = manageScope()
    let schedule = null,
        policy
    if (!blank(p.scheduleId)) {
        schedule = one(SCHEDULE, {scheduleId: text(p.scheduleId)})
        if (!schedule) denied("RECORD_UNAVAILABLE", "Notice " + p.scheduleId + " is not available")
        policy = policyOf(userScope, schedule.registrationPolicyId, true)
        requireRevision(schedule, p.expectedRevision, "Notice " + schedule.scheduleId)
        if (!lib.active(schedule)) denied("SCHEDULE_ENDED", "An ended notice is not changed")
    } else policy = policyOf(userScope, p.registrationPolicyId, true)
    requireDraftOrPublished(policy)
    if (text(p.action) === "end") {
        if (!schedule) denied("RECORD_UNAVAILABLE", "Name the notice to end")
        call("update#" + SCHEDULE, {scheduleId: schedule.scheduleId, thruDate: ec.user.nowTimestamp})
        return {scheduleId: schedule.scheduleId}
    }
    const triggerEnumId = text(p.triggerEnumId) || schedule?.triggerEnumId
    if (!["EctConfirmed", "EctBeforeStart", "EctAfterEnd", "EctChanged", "EctCancelled"].includes(triggerEnumId))
        denied("TRIGGER_INVALID", "Choose when the notice is sent")
    const offsetMinutes =
        p.offsetMinutes !== undefined && p.offsetMinutes !== null
            ? wholeOf(p.offsetMinutes, "OFFSET_INVALID", "The offset in minutes", 0, 60 * 24 * 60)
            : (schedule?.offsetMinutes ?? null)
    if (["EctBeforeStart", "EctAfterEnd"].includes(triggerEnumId) && !offsetMinutes)
        denied("OFFSET_REQUIRED", "Say how long before the start or after the end")
    const messageTemplateId = text(p.messageTemplateId) || schedule?.messageTemplateId
    const template = messageTemplateId ? one("mantle.party.MessageTemplate", {messageTemplateId}) : null
    if (
        !template ||
        template.organizationPartyId !== policy.organizationPartyId ||
        template.channelEnumId !== "MdcEmail" ||
        !lib.active(template)
    )
        denied("TEMPLATE_INVALID", "Choose an email template of the organization in use")
    const purposeEnumId = text(p.purposeEnumId) || schedule?.purposeEnumId || template.purposeEnumId || "MtpTransactional"
    if (!["MtpTransactional", "MtpPromotional"].includes(purposeEnumId)) denied("PURPOSE_INVALID", "Transactional or promotional")
    // a promotional template never goes as a registration's own notice (design §9 Registrations)
    if (purposeEnumId === "MtpTransactional" && template.purposeEnumId === "MtpPromotional")
        denied("PURPOSE_INVALID", "A promotional template is sent as a promotional notice, to those who consented")
    const recipientScopeEnumId = text(p.recipientScopeEnumId) || schedule?.recipientScopeEnumId || "EcrAttendee"
    if (!["EcrAttendee", "EcrBuyer", "EcrBoth"].includes(recipientScopeEnumId))
        denied("RECIPIENTS_INVALID", "Choose whom it goes to")
    const values = {
        triggerEnumId,
        offsetMinutes,
        messageTemplateId,
        recipientScopeEnumId,
        purposeEnumId,
        channelEnumId: "MdcEmail"
    }
    if (schedule) {
        call("update#" + SCHEDULE, Object.assign({scheduleId: schedule.scheduleId}, values))
        return {scheduleId: schedule.scheduleId}
    }
    const scheduleId = call(
        "create#" + SCHEDULE,
        Object.assign(
            {
                registrationPolicyId: policy.registrationPolicyId,
                fromDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId
            },
            values
        )
    ).scheduleId
    return {scheduleId}
}

// ===== publish#Registration, close#Registration =====
function publishRegistration(p) {
    const userScope = manageScope()
    const policy = policyOf(userScope, p.registrationPolicyId, true)
    requireRevision(policy, p.expectedRevision, "Registration offer " + policy.registrationPolicyId)
    if (policy.statusId !== "ErpDraft") denied("STATUS_INVALID", "Only a draft offer is published")
    const {workEffort} = eventOf(userScope, policy.workEffortId)
    const missing = readinessOf(policy, workEffort).filter(check => !check.ready)
    if (missing.length) denied("NOT_READY", L("Before it opens") + ": " + missing.map(check => check.label).join("; "))
    const occurrence = occurrenceOf(workEffort, ms(policy.occurrenceStart))
    call("update#" + POLICY, {
        registrationPolicyId: policy.registrationPolicyId,
        statusId: "ErpPublished",
        statusId_changeReason: "Published by " + (ec.user.username || ec.user.userId),
        occurrenceEnd: new Date(occurrence.end),
        publishedDate: ec.user.nowTimestamp,
        publishedByUserId: ec.user.userId,
        policyRevision: Number(policy.policyRevision || 1) + 1
    })
    syncPublication(one(POLICY, {registrationPolicyId: policy.registrationPolicyId}), true)
    return {
        registrationPolicyId: policy.registrationPolicyId,
        statusId: "ErpPublished",
        publicUrl: apps().pageUrl(policy.siteId, "marketing", "/Event?offer=" + encodeURIComponent(policy.registrationPolicyId))
    }
}
function closeRegistration(p) {
    const userScope = manageScope()
    const policy = policyOf(userScope, p.registrationPolicyId, true)
    requireRevision(policy, p.expectedRevision, "Registration offer " + policy.registrationPolicyId)
    if (policy.statusId === "ErpClosed") return {registrationPolicyId: policy.registrationPolicyId, statusId: "ErpClosed"}
    call("update#" + POLICY, {
        registrationPolicyId: policy.registrationPolicyId,
        statusId: "ErpClosed",
        statusId_changeReason: (text(p.reason) || "Closed") + " by " + (ec.user.username || ec.user.userId),
        closedDate: ec.user.nowTimestamp,
        closedByUserId: ec.user.userId,
        policyRevision: Number(policy.policyRevision || 1) + 1
    })
    syncPublication(policy, false)
    return {registrationPolicyId: policy.registrationPolicyId, statusId: "ErpClosed"}
}

// ===== add#EventVideoCall =====
// An online occurrence's call: a call link (the framework's, lobby and video) as the event's join address, for an events manager of
// the organization who may edit the event. Registrants get it with their confirmation (P17); the public page says online only.
function addEventVideoCall(p) {
    const userScope = manageScope()
    const {workEffort} = eventOf(userScope, p.workEffortId)
    if (!eventAccess(workEffort.workEffortId).canEdit)
        denied("EVENT_EDIT_REQUIRED", "Only the event's organizer or an editor of its calendar adds its call")
    if (!blank(workEffort.infoUrl)) denied("CALL_EXISTS", "The event has a call already")
    const policies = rows(POLICY, {workEffortId: workEffort.workEffortId})
    const lastEnd = Math.max(nowMs() + DAY, ...policies.map(policy => ms(policy.occurrenceEnd) ?? 0))
    const link = call("org.moqui.call.CallServices.create#CallLink", {
        name: (L("Event") + ": " + (workEffort.workEffortName || workEffort.workEffortId)).substring(0, 255),
        policy: "lobby",
        video: true,
        expiryHours: Math.min(2160, Math.max(24, Math.ceil((lastEnd - nowMs()) / HOUR) + 24))
    })
    if (link.reasonCode || !link.path) denied("CALL_UNAVAILABLE", "A call link cannot be made: " + (link.reasonCode || "no link"))
    let base = ""
    try {
        base = ec.web?.getWebappRootUrl(true, null) || ""
    } catch (error) {
        base = ""
    }
    const joinUrl = base + link.path
    call("update#" + WORK_EFFORT, {workEffortId: workEffort.workEffortId, infoUrl: joinUrl})
    return {workEffortId: workEffort.workEffortId, joinUrl}
}

// ===== the public view (PASS's Event page, MarketingPortal.js getEvent) =====
// A published offer of the organization on the site, for an occurrence still to come of an event not cancelled: the allow-listed
// view, or null.
function publicView(registrationPolicyId, siteId, organizationPartyId) {
    const policy = blank(registrationPolicyId) ? null : one(POLICY, {registrationPolicyId: text(registrationPolicyId)})
    if (
        !policy ||
        policy.statusId !== "ErpPublished" ||
        policy.siteId !== siteId ||
        policy.organizationPartyId !== organizationPartyId
    )
        return null
    const workEffort = one(WORK_EFFORT, {workEffortId: policy.workEffortId})
    const occurrence = workEffort ? occurrenceOf(workEffort, ms(policy.occurrenceStart)) : null
    if (!occurrence || occurrence.end <= nowMs()) return null
    const zone = zoneOf(workEffort, policy)
    const at = nowMs()
    const opens = timeOf(policy.opensDate)
    const closes = timeOf(policy.closesDate) ?? occurrence.start
    const open = (opens == null || opens <= at) && closes > at
    const seats = Number(policy.totalSeats || 0)
    const left = Math.max(0, seats - seatsTaken(policy.registrationPolicyId))
    const waitlist = policy.waitlistEnabled === "Y"
    const advisory = remaining =>
        remaining <= 0
            ? waitlist
                ? L("Full: join the waitlist")
                : L("Sold out")
            : remaining <= limits.fewLeft
              ? L("A few places left")
              : L("Places available")
    const tickets = currentTickets(policy.registrationPolicyId)
        .filter(ticket => (timeOf(ticket.salesThruDate) ?? Infinity) > at)
        .map(ticket => {
            const price = priceOf(ticket, policy)
            const ticketLeft =
                ticket.capacity == null
                    ? left
                    : Math.min(
                          left,
                          Math.max(0, Number(ticket.capacity) - seatsTaken(policy.registrationPolicyId, ticket.ticketTypeId))
                      )
            const salesFrom = timeOf(ticket.salesFromDate)
            return {
                ticketTypeId: ticket.ticketTypeId,
                name: ticket.ticketName || "",
                priceText: price.priced ? price.priceText : L("Price to be announced"),
                availability:
                    salesFrom != null && salesFrom > at
                        ? L("On sale from") + " " + zoneText(salesFrom, zone)
                        : advisory(ticketLeft)
            }
        })
    const dayPattern = "EEEE d MMMM yyyy, HH:mm"
    const sameDay = zoneText(occurrence.start, zone, "yyyy-MM-dd") === zoneText(occurrence.end, zone, "yyyy-MM-dd")
    return {
        registrationPolicyId: policy.registrationPolicyId,
        title: policy.publicTitle || workEffort.workEffortName || "",
        description: policy.publicDescription || "",
        organizationName: organizationName(organizationPartyId),
        startText: zoneText(occurrence.start, zone, dayPattern),
        endText: zoneText(occurrence.end, zone, sameDay ? "HH:mm" : dayPattern),
        timeZone: zone,
        location: workEffort.location || "",
        online: !blank(workEffort.infoUrl),
        tickets,
        availability: advisory(left),
        registrationOpen: open,
        registrationText: open
            ? L("Registration is open until") + " " + zoneText(closes, zone, dayPattern)
            : opens != null && opens > at
              ? L("Registration opens") + " " + zoneText(opens, zone, dayPattern)
              : L("Registration has closed"),
        terms: policy.termsText || "",
        cancellationTerms: policy.cancellationTerms || ""
    }
}
// The offers published on a site now (the Marketing app's readiness).
const liveOffersOf = (siteId, organizationPartyId) =>
    rows(POLICY, {siteId, organizationPartyId, statusId: "ErpPublished"}).filter(
        policy => (ms(policy.occurrenceEnd) ?? Infinity) > nowMs()
    ).length

const operations = {
    findEvents,
    getEventSetup,
    storeRegistrationEvent,
    storeRegistrationPolicy,
    storeTicketType,
    storeRegistrationForm,
    storeCommunicationSchedule,
    publishRegistration,
    closeRegistration,
    addEventVideoCall
}
;({
    SEAT_STATES,
    seatsTaken,
    occurrenceOf,
    priceOf,
    gatewayOf,
    readinessOf,
    publicView,
    liveOffersOf,
    // the event's organization (CampaignAssociation CakEvent, MarketingCampaigns.js): {owner, label} or null
    organizationOfEvent: workEffortId => {
        const event = blank(workEffortId) ? null : one(EVENT, {workEffortId: text(workEffortId)})
        const workEffort = event ? one(WORK_EFFORT, {workEffortId: event.workEffortId}) : null
        return event && workEffort
            ? {owner: event.organizationPartyId, label: workEffort.workEffortName || workEffort.workEffortId}
            : null
    },
    // each operation checks the caller's permission and the event's organization, and reads and writes with artifact authorization off
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown event registration operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
