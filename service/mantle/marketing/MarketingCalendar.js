// Marketing's schedule (mantle.marketing.MarketingWorkspaceServices, W of IronStone Marketing design §14.2; design §3 Calendar, §1.3
// CX-SYNC, §14.3 Today; impl-marketing P21, F71). CC0 1.0 Universal plus Grant of Patent License.
//
// - get#CalendarItems: the campaign schedule of the organizations of the caller's marketing scope over a range of days, by source:
//   campaign windows, scheduled sends, automation milestones (an automation's activation and end), approved publication dates (a
//   campaign's blog post with a published page, its landing page live or scheduled) and the events Marketing offers (a registration
//   event of an organization of the scope, or an event linked to one of its campaigns; series expanded by
//   mantle.work.EventServices.get#EventInstances). Only an event is ever changed from a calendar, through the calendar's own
//   update#EventOccurrence; every other item is read only and opens its record. Each source is read on its own: one that fails is
//   logged and named in failedSources while the others answer, and a source the caller may not read (automations without the
//   automation read) is left out.
// - get#CampaignCalendar: the "Campaign calendar" projected CalDAV collection (CalendarProjection MarketingCampaigns, on the projected
//   kind of mantle.work.CalendarDavServices, define#ProjectionOwner): admitted for a holder of MARKETING_VIEW; the same items as
//   ICalendar event maps, read only (the kind refuses a device write).
// - get#TodayItems: Marketing's part of the user's Today: the sends due today or sending (a reader of sends), the approvals awaiting
//   a decision (an approver), the sends with a failed or uncertain delivery (a dispatcher) and the offers with registrations waiting
//   for the organizer (an events manager), each with its place as a route key; one source that fails is named, the rest answered.
//
// No recipient, address, token or attendee is part of an item: titles name a campaign, a send, an automation, a page or an event.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const {find, one, ms, denied} = lib

const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const SEND = "mantle.marketing.campaign.CampaignSend"
const AUTOMATION = "mantle.marketing.automation.MarketingAutomation"
const CONTENT = "mantle.marketing.campaign.CampaignContent"
const DAY = 24 * 60 * 60 * 1000
const sourceLimit = 200
const maxRangeDays = 400
const sendMinutes = 30
const L = text => ec.l10n.localize(text)
const text = value => (value == null || String(value).trim() === "" ? null : String(value).trim())
const truthy = value => value === true || value === "true" || value === "Y"

// The places an item opens, as route keys of the app that shows it (Marketing.js resolves them to its screens).
const routes = {
    campaign: "marketingCampaign",
    send: "marketingSend",
    automation: "marketingAutomation",
    content: "marketingContent",
    event: "marketingEvent",
    approvals: "marketingApprovals",
    delivery: "marketingDelivery",
    registrations: "marketingRegistrations"
}

// ===== days in the user's time zone =====
const dayPattern = "yyyy-MM-dd"
const isDay = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))
const dayOf = millis => ec.l10n.format(new Date(millis), dayPattern)
const wallOf = millis => ec.l10n.format(new Date(millis), "yyyy-MM-dd HH:mm")
const startOfDay = day => ms(ec.l10n.parseTimestamp(day + " 00:00:00.000", "yyyy-MM-dd HH:mm:ss.SSS"))
const addDays = (day, days) => new Date(Date.parse(day + "T12:00:00Z") + days * DAY).toISOString().substring(0, 10)

// The caller's scope for a read of the schedule: a Marketing reader, an organization of their scope or each of them.
function reader(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    const organizationPartyId = text(p.organizationPartyId)
    if (organizationPartyId) marketingAccess.requireOrganization(userScope, organizationPartyId)
    return {
        userScope,
        organizationPartyIds: organizationPartyId ? [organizationPartyId] : marketingAccess.organizationIds(userScope)
    }
}
// A range of days (start and end inclusive, yyyy-MM-dd in the user's zone): its first and last day and its millis [from, thru).
function rangeOf(startDay, endDay) {
    if (!isDay(startDay) || !isDay(endDay) || endDay < startDay)
        denied("DATES_INVALID", "The range is two days, yyyy-MM-dd, the end on or after the start")
    if (Date.parse(endDay) - Date.parse(startDay) > maxRangeDays * DAY)
        denied("DATES_INVALID", "The range is at most " + maxRangeDays + " days")
    return {startDay, endDay, fromMs: startOfDay(startDay), thruMs: startOfDay(addDays(endDay, 1))}
}

// An item of the schedule: an all-day one from its first day to the day after its last (as FullCalendar and iCalendar take it), a
// timed one from its start to its end as wall-clock text in the user's zone.
function allDayItem(fields, firstDay, lastDay) {
    return Object.assign(fields, {
        allDay: true,
        startText: firstDay,
        endText: addDays(lastDay, 1),
        startDay: firstDay,
        endDay: lastDay
    })
}
function timedItem(fields, startMs, endMs) {
    return Object.assign(fields, {
        allDay: false,
        startMillis: startMs,
        endMillis: endMs,
        startText: wallOf(startMs),
        endText: wallOf(endMs)
    })
}
const statusName = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const between = (millis, range) => millis != null && millis >= range.fromMs && millis < range.thruMs

// ===== the sources =====
// Each reads the organizations of the scope over the range and answers its items; admits leaves a source out for a caller who may not
// read it.
const calendarSources = [
    {
        key: "campaignWindows",
        title: "Campaign windows",
        run: (context, range) => {
            if (!context.organizationPartyIds.length) return []
            const cf = ec.entity.conditionFactory
            const rows = Array.from(
                find(CAMPAIGN)
                    .condition("organizationPartyId", "in", context.organizationPartyIds)
                    .condition("statusId", "not-equals", "MKTG_CAMP_CANCELLED")
                    .condition("fromDate", "less-than", new Date(range.thruMs))
                    .condition(
                        cf.makeCondition(
                            [
                                cf.makeCondition("thruDate", "is-null", null),
                                cf.makeCondition("thruDate", "greater-equals", new Date(range.fromMs))
                            ],
                            "or"
                        )
                    )
                    .orderBy("fromDate")
                    .limit(sourceLimit)
                    .list()
            )
            return rows.map(row => {
                const fromMs = ms(row.fromDate)
                const thruMs = ms(row.thruDate)
                // a window ends on the day before its thru instant (an end at midnight ends the day before)
                const lastDay = thruMs != null && thruMs > fromMs ? dayOf(thruMs - 1) : dayOf(fromMs)
                return allDayItem(
                    {
                        kind: "campaign",
                        key: "campaign|" + row.marketingCampaignId,
                        title: L("Campaign") + ": " + (row.campaignName || row.marketingCampaignId),
                        stateText: statusName(row.statusId),
                        recordKind: "campaign",
                        recordId: row.marketingCampaignId,
                        recordParameter: "marketingCampaignId",
                        route: routes.campaign,
                        organizationPartyId: row.organizationPartyId,
                        revision: Number(row.campaignRevision || 0),
                        lastModified: ms(row.lastUpdatedStamp)
                    },
                    dayOf(fromMs),
                    lastDay
                )
            })
        }
    },
    // a send with a schedule in the range, whatever its state but cancelled (an automation's send steps are the automation's)
    {
        key: "sends",
        title: "Scheduled sends",
        run: (context, range) => {
            if (!context.organizationPartyIds.length) return []
            const rows = Array.from(
                find(SEND)
                    .condition("organizationPartyId", "in", context.organizationPartyIds)
                    .condition("statusId", "not-in", ["CsCancelled", "CsAutomation"])
                    .condition("scheduledDate", "greater-equals", new Date(range.fromMs))
                    .condition("scheduledDate", "less-than", new Date(range.thruMs))
                    .orderBy("scheduledDate")
                    .limit(sourceLimit)
                    .list()
            )
            return rows.map(row =>
                timedItem(
                    {
                        kind: "send",
                        key: "send|" + row.campaignSendId,
                        title: L("Send") + ": " + (row.sendName || row.campaignSendId),
                        stateText: statusName(row.statusId),
                        recordKind: "send",
                        recordId: row.campaignSendId,
                        recordParameter: "campaignSendId",
                        route: routes.send,
                        organizationPartyId: row.organizationPartyId,
                        revision: Number(row.sendRevision || 0),
                        lastModified: ms(row.lastUpdatedStamp)
                    },
                    ms(row.scheduledDate),
                    ms(row.scheduledDate) + sendMinutes * 60 * 1000
                )
            )
        }
    },
    // an automation's milestones, its activation and its end, for a reader of automations (as AutomationServices ask)
    {
        key: "automations",
        title: "Automation milestones",
        admits: context => {
            const caps = context.userScope.capabilities
            return !!(caps.sendEdit || caps.approve || caps.dispatch || caps.audienceRead)
        },
        run: (context, range) => {
            if (!context.organizationPartyIds.length) return []
            const items = []
            for (const [field, word] of [
                ["activatedDate", "Automation starts"],
                ["endedDate", "Automation ends"]
            ])
                for (const row of Array.from(
                    find(AUTOMATION)
                        .condition("organizationPartyId", "in", context.organizationPartyIds)
                        .condition(field, "greater-equals", new Date(range.fromMs))
                        .condition(field, "less-than", new Date(range.thruMs))
                        .orderBy(field)
                        .limit(sourceLimit)
                        .list()
                ))
                    items.push(
                        timedItem(
                            {
                                kind: "automation",
                                key: "automation|" + field + "|" + row.marketingAutomationId,
                                title: L(word) + ": " + (row.automationName || row.marketingAutomationId),
                                stateText: statusName(row.statusId),
                                recordKind: "automation",
                                recordId: row.marketingAutomationId,
                                recordParameter: "marketingAutomationId",
                                route: routes.automation,
                                organizationPartyId: row.organizationPartyId,
                                revision: Number(row.automationRevision || 0),
                                lastModified: ms(row.lastUpdatedStamp)
                            },
                            ms(row[field]),
                            ms(row[field]) + sendMinutes * 60 * 1000
                        )
                    )
            return items
        }
    },
    // a campaign's content with an approved publication date: a blog post whose page has a published version, on its publish date;
    // a landing page live from its from date, or with a version scheduled for its scheduled date
    {
        key: "publications",
        title: "Publication dates",
        run: (context, range) => {
            if (!context.organizationPartyIds.length) return []
            const cf = ec.entity.conditionFactory
            const links = Array.from(
                find(CONTENT)
                    .condition("organizationPartyId", "in", context.organizationPartyIds)
                    .condition("contentKindEnumId", "in", ["CckBlogPost", "CckSitePage"])
                    .condition(
                        cf.makeCondition(
                            [
                                cf.makeCondition("thruDate", "is-null", null),
                                cf.makeCondition("thruDate", "greater-than", ec.user.nowTimestamp)
                            ],
                            "or"
                        )
                    )
                    .limit(sourceLimit)
                    .list()
            )
            const items = []
            for (const link of links) {
                const fields = (title, suffix) => ({
                    kind: "publication",
                    key: "publication|" + link.campaignContentId + (suffix ? "|" + suffix : ""),
                    title,
                    stateText: "",
                    recordKind: "content",
                    recordId: link.campaignContentId,
                    recordParameter: "campaignContentId",
                    route: routes.content,
                    organizationPartyId: link.organizationPartyId,
                    revision: 0,
                    lastModified: ms(link.lastUpdatedStamp)
                })
                if (link.contentKindEnumId === "CckBlogPost" && link.wikiBlogId) {
                    const blog = one("moqui.resource.wiki.WikiBlog", {wikiBlogId: link.wikiBlogId})
                    const page = blog?.wikiPageId ? one("moqui.resource.wiki.WikiPage", {wikiPageId: blog.wikiPageId}) : null
                    const publishMs = ms(blog?.publishDate)
                    if (!page?.publishedVersionName || !between(publishMs, range)) continue
                    const item = allDayItem(
                        fields(L("Blog post") + ": " + (blog.title || blog.wikiBlogId)),
                        dayOf(publishMs),
                        dayOf(publishMs)
                    )
                    item.stateText = publishMs <= ms(ec.user.nowTimestamp) ? L("Published") : L("Scheduled")
                    items.push(item)
                } else if (link.contentKindEnumId === "CckSitePage" && link.sitePageId) {
                    const page = one("mantle.public.PublicSitePage", {sitePageId: link.sitePageId})
                    if (!page) continue
                    const name = L("Landing page") + ": " + (page.title || page.routePath || page.sitePageId)
                    const liveMs = page.versionName ? ms(page.fromDate) : null
                    if (between(liveMs, range)) {
                        const item = allDayItem(fields(name, "live"), dayOf(liveMs), dayOf(liveMs))
                        item.stateText = L("Published")
                        items.push(item)
                    }
                    const scheduledMs = page.scheduledVersionName ? ms(page.scheduledFromDate) : null
                    if (between(scheduledMs, range)) {
                        const item = allDayItem(fields(name, "scheduled"), dayOf(scheduledMs), dayOf(scheduledMs))
                        item.stateText = L("Scheduled")
                        items.push(item)
                    }
                }
            }
            return items
        }
    },
    // the events Marketing offers: a registration event of an organization of the scope and an event linked to one of its campaigns,
    // each instance in the range (a series expanded by the calendar's own rule); the event stays the calendar's
    {
        key: "events",
        title: "Events",
        run: (context, range) => {
            const workEffortIds = eventIds(context.organizationPartyIds)
            if (!workEffortIds.length) return []
            const workEfforts = Array.from(
                find("mantle.work.effort.WorkEffort")
                    .condition("workEffortId", "in", workEffortIds)
                    .condition("workEffortTypeEnumId", "WetEvent")
                    .condition("statusId", "not-equals", "WeCancelled")
                    .list()
            ).map(row => row.getMap())
            if (!workEfforts.length) return []
            const out =
                ec.service
                    .sync()
                    .name("mantle.work.EventServices.get#EventInstances")
                    .parameters({
                        workEffortList: workEfforts,
                        rangeStart: new Date(range.fromMs),
                        rangeEnd: new Date(range.thruMs)
                    })
                    .disableAuthz()
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            const organizationOf = eventOrganizations(workEffortIds)
            const items = []
            for (const instance of Array.from(out.instanceList || []).slice(0, sourceLimit)) {
                const event = instance.workEffort || {}
                const seriesId = instance.seriesWorkEffortId || instance.workEffortId
                const instanceStart = instance.recurring ? ms(instance.recurrenceStart) : null
                const fields = {
                    kind: "event",
                    key: "event|" + instance.workEffortId + "|" + (instanceStart ?? "") + "|" + ms(instance.start),
                    title: event.workEffortName || instance.workEffortId,
                    stateText: statusName(event.statusId),
                    recordKind: "event",
                    recordId: seriesId,
                    recordParameter: "workEffortId",
                    route: routes.event,
                    organizationPartyId: organizationOf[seriesId] || organizationOf[instance.workEffortId] || null,
                    workEffortId: instance.workEffortId,
                    seriesWorkEffortId: seriesId,
                    recurring: !!instance.recurring,
                    instanceStart: instanceStart == null ? null : instance.allDay ? dayOf(instanceStart) : wallOf(instanceStart),
                    location: event.location || null,
                    revision: 0,
                    lastModified: ms(event.lastUpdatedStamp)
                }
                if (instance.allDay)
                    items.push(
                        allDayItem(fields, instance.startDay, addDays(instance.endDay || addDays(instance.startDay, 1), -1))
                    )
                else {
                    const startMs = ms(instance.start)
                    const endMs = instance.end != null ? ms(instance.end) : startMs + 60 * 60 * 1000
                    items.push(timedItem(fields, startMs, endMs > startMs ? endMs : startMs + 15 * 60 * 1000))
                }
            }
            return items
        }
    }
]
// The events Marketing offers for the organizations: their registration events and the events linked to their campaigns.
function eventIds(organizationPartyIds) {
    if (!organizationPartyIds.length) return []
    const ids = new Set(
        Array.from(
            find("mantle.work.registration.RegistrationEvent")
                .condition("organizationPartyId", "in", organizationPartyIds)
                .selectField("workEffortId")
                .limit(1000)
                .list()
        ).map(row => row.workEffortId)
    )
    const campaignIds = Array.from(
        find(CAMPAIGN)
            .condition("organizationPartyId", "in", organizationPartyIds)
            .condition("statusId", "not-equals", "MKTG_CAMP_CANCELLED")
            .selectField("marketingCampaignId")
            .limit(2000)
            .list()
    ).map(row => row.marketingCampaignId)
    if (campaignIds.length)
        for (const row of Array.from(
            find("mantle.marketing.campaign.CampaignAssociation", {associationKindEnumId: "CakEvent"})
                .condition("marketingCampaignId", "in", campaignIds)
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .limit(1000)
                .list()
        ))
            if (row.sourceId) ids.add(row.sourceId)
    return Array.from(ids)
}
// The organization each event is Marketing's for: its registration event's, else its campaign's.
function eventOrganizations(workEffortIds) {
    const found = {}
    for (const row of Array.from(
        find("mantle.work.registration.RegistrationEvent").condition("workEffortId", "in", workEffortIds).list()
    ))
        found[row.workEffortId] = row.organizationPartyId
    return found
}
// Whether an event is one the scope's calendar holds (the event a calendar drag may move): a registration event of an organization of
// the scope, or an event linked to one of its campaigns.
function scopeHoldsEvent(organizationPartyIds, workEffortId) {
    if (!workEffortId) return false
    const held = eventIds(organizationPartyIds)
    if (held.includes(workEffortId)) return true
    // an instance of a series changed on its own is held through its series
    return Array.from(
        find("mantle.work.effort.WorkEffortAssoc", {
            toWorkEffortId: workEffortId,
            workEffortAssocTypeEnumId: "WeatRecurrenceInstance"
        })
            .limit(5)
            .list()
    ).some(row => held.includes(row.workEffortId))
}

// Runs each source on its own: its items, or its name in failedSources when it throws.
function readSources(context, range) {
    const items = []
    const failedSources = []
    for (const source of calendarSources) {
        if (source.admits && !source.admits(context)) continue
        ec.message.pushErrors()
        try {
            const found = source.run(context, range)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            items.push(...found)
        } catch (error) {
            ec.logger.error("Marketing calendar source " + source.key + " failed for " + ec.user.username + ": " + error.message)
            failedSources.push(source.title)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    items.sort((a, b) => String(a.startText).localeCompare(String(b.startText)) || String(a.title).localeCompare(String(b.title)))
    return {items, failedSources}
}

// ===== get#CalendarItems =====
function calendarItems(p) {
    const context = reader(p)
    const range = rangeOf(text(p.start), text(p.end))
    const found = readSources(context, range)
    return {items: found.items, failedSources: found.failedSources, startDay: range.startDay, endDay: range.endDay}
}

// ===== check#CalendarEvent (a calendar drag) =====
// Whether an event is the scope's calendar's, for a Marketing reader: the event the Calendar screen may move through the calendar's own
// update#EventOccurrence (which decides who may change it). Anything else, a send among them, is refused as not available.
function checkCalendarEvent(p) {
    const context = reader(p)
    const workEffortId = text(p.workEffortId)
    if (!scopeHoldsEvent(context.organizationPartyIds, workEffortId))
        denied(
            "RECORD_UNAVAILABLE",
            "Only an event of the campaign calendar moves here; " + (workEffortId || "this") + " is not one"
        )
    return {workEffortId}
}

// ===== get#CampaignCalendar (the projected CalDAV collection) =====
const projectionUid = key => "marketing-" + String(key).replace(/[^A-Za-z0-9_.-]+/g, "-")
function campaignCalendar(p) {
    if (!ec.user.userId) return {admitted: false, eventList: []}
    const userScope = marketingAccess.scope()
    const admitted = !!userScope.capabilities.view
    if (!admitted || truthy(p.checkOnly)) return {admitted, eventList: []}
    const nowMs = ms(ec.user.nowTimestamp)
    const startDay = p.start != null && p.start !== "" ? dayOf(Number(p.start)) : addDays(dayOf(nowMs), -30)
    let endDay = p.end != null && p.end !== "" ? dayOf(Number(p.end)) : addDays(dayOf(nowMs), 180)
    if (endDay < startDay) endDay = startDay
    if (Date.parse(endDay) - Date.parse(startDay) > maxRangeDays * DAY) endDay = addDays(startDay, maxRangeDays)
    const context = {userScope, organizationPartyIds: marketingAccess.organizationIds(userScope)}
    const found = readSources(context, rangeOf(startDay, endDay))
    const eventList = found.items.map(item => ({
        uid: projectionUid(item.key),
        sequence: Number(item.revision || 0),
        summary: item.title + (item.stateText ? " · " + item.stateText : ""),
        status: "CONFIRMED",
        allDay: !!item.allDay,
        start: item.allDay ? null : item.startMillis,
        end: item.allDay ? null : item.endMillis,
        startDate: item.allDay ? item.startText : null,
        endDate: item.allDay ? item.endText : null,
        timeZone: ec.user.timeZone || null,
        lastModified: item.lastModified || null
    }))
    return {admitted, eventList}
}

// ===== get#TodayItems =====
// Marketing's part of Today, by source; each source that fails is named in failedSources and the others answer.
const todaySources = [
    // the sends of the organizations due by the end of today (released and waiting) or sending, for a reader of sends
    {
        key: "dueSends",
        title: "Sends due",
        admits: caps => !!(caps.sendEdit || caps.approve || caps.dispatch),
        run: (organizationPartyIds, thruMs) => {
            const cf = ec.entity.conditionFactory
            return Array.from(
                find(SEND)
                    .condition("organizationPartyId", "in", organizationPartyIds)
                    .condition(
                        cf.makeCondition(
                            [
                                cf.makeCondition("statusId", "equals", "CsSending"),
                                cf.makeCondition(
                                    [
                                        cf.makeCondition("statusId", "equals", "CsScheduled"),
                                        cf.makeCondition("scheduledDate", "less-than", new Date(thruMs))
                                    ],
                                    "and"
                                )
                            ],
                            "or"
                        )
                    )
                    .orderBy("scheduledDate")
                    .limit(20)
                    .list()
            ).map(row => ({
                kind: "marketingSend",
                title: L("Send") + " " + (row.sendName || row.campaignSendId) + " · " + statusName(row.statusId),
                dueDate: row.scheduledDate || null,
                recordKind: "send",
                recordId: row.campaignSendId,
                recordParameter: "campaignSendId",
                recordEntity: SEND,
                recordName: row.sendName || row.campaignSendId,
                route: routes.send
            }))
        }
    },
    // the approvals awaiting a decision, for an approver: each its target
    {
        key: "approvals",
        title: "Approvals awaiting a decision",
        admits: caps => !!caps.approve,
        run: organizationPartyIds =>
            approvals
                .pendingRows(organizationPartyIds)
                .slice(0, 20)
                .map(request => {
                    const kindKey = approvals.kindByEnum(request.targetKindEnumId)
                    const kind = kindKey ? approvals.targetKinds[kindKey] : null
                    const target = kind ? kind.read(request.targetId) : null
                    return {
                        kind: "marketingApproval",
                        title:
                            L("Approve") +
                            " " +
                            (kind ? kind.name.toLowerCase() + " " : "") +
                            (target ? kind.label(target) : request.targetId),
                        dueDate: request.decisionDate || null,
                        recordKind: kindKey,
                        recordId: request.targetId,
                        recordParameter: null,
                        recordEntity: null,
                        recordName: null,
                        route: routes.approvals
                    }
                })
    },
    // the released sends with a failed or uncertain delivery in the last 30 days, for a dispatcher (counts, no recipient)
    {
        key: "deliveries",
        title: "Failed or uncertain deliveries",
        admits: caps => !!caps.dispatch,
        run: organizationPartyIds => {
            const items = []
            for (const row of Array.from(
                find(SEND)
                    .condition("organizationPartyId", "in", organizationPartyIds)
                    .condition("statusId", "in", ["CsSending", "CsPaused", "CsSampleSent", "CsCompletedFailures"])
                    .condition("releasedDate", "greater-equals", new Date(ms(ec.user.nowTimestamp) - 30 * DAY))
                    .orderBy("-releasedDate")
                    .limit(50)
                    .list()
            )) {
                const count = state =>
                    find("mantle.party.MessageDelivery", {sourceEnumId: "MdsrcCampaignSend", stateEnumId: state})
                        .condition("eventKey", "like", "CampaignSend:" + row.campaignSendId + ":%")
                        .count()
                const failed = count("MdsFailed")
                const uncertain = count("MdsUncertain")
                if (!failed && !uncertain) continue
                items.push({
                    kind: "marketingDelivery",
                    title:
                        L("Send") +
                        " " +
                        (row.sendName || row.campaignSendId) +
                        ": " +
                        [failed ? failed + " " + L("failed") : null, uncertain ? uncertain + " " + L("uncertain") : null]
                            .filter(Boolean)
                            .join(", "),
                    dueDate: row.releasedDate || null,
                    recordKind: "send",
                    recordId: row.campaignSendId,
                    recordParameter: "campaignSendId",
                    recordEntity: SEND,
                    recordName: row.sendName || row.campaignSendId,
                    route: routes.delivery
                })
                if (items.length >= 20) break
            }
            return items
        }
    },
    // the offers with registrations waiting for the organizer (paid and pending, or held for review), for an events manager: a count
    // per offer, never an attendee
    {
        key: "registrations",
        title: "Registrations to review",
        admits: caps => !!caps.eventManage,
        run: organizationPartyIds => {
            const offers = Array.from(
                find("mantle.work.registration.EventRegistrationPolicy")
                    .condition("organizationPartyId", "in", organizationPartyIds)
                    .condition("occurrenceEnd", "greater-than", ec.user.nowTimestamp)
                    .orderBy("occurrenceStart")
                    .limit(200)
                    .list()
            )
            const items = []
            for (const offer of offers) {
                const waiting = find("mantle.work.registration.EventRegistration", {
                    registrationPolicyId: offer.registrationPolicyId
                })
                    .condition("statusId", "in", ["EvrPending", "EvrReview"])
                    .count()
                if (!waiting) continue
                items.push({
                    kind: "marketingRegistration",
                    title:
                        waiting +
                        " " +
                        L(waiting === 1 ? "registration to review" : "registrations to review") +
                        " · " +
                        (offer.publicTitle || offer.registrationPolicyId),
                    dueDate: offer.occurrenceStart || null,
                    recordKind: "event",
                    recordId: offer.registrationPolicyId,
                    recordParameter: "registrationPolicyId",
                    recordEntity: null,
                    recordName: null,
                    route: routes.registrations
                })
                if (items.length >= 20) break
            }
            return items
        }
    }
]
function today(p) {
    if (!ec.user.userId) return {items: [], failedSources: []}
    const userScope = marketingAccess.scope()
    const caps = userScope.capabilities
    if (!caps.anyRead) return {items: [], failedSources: []}
    const organizationPartyIds = marketingAccess.organizationIds(userScope)
    if (!organizationPartyIds.length) return {items: [], failedSources: []}
    const thruMs = p.thruDate ? ms(p.thruDate) : startOfDay(addDays(dayOf(ms(ec.user.nowTimestamp)), 1))
    const items = []
    const failedSources = []
    for (const source of todaySources) {
        if (!source.admits(caps)) continue
        ec.message.pushErrors()
        try {
            const found = source.run(organizationPartyIds, thruMs)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            items.push(...found.map(item => Object.assign({sourceKey: source.key}, item)))
        } catch (error) {
            ec.logger.error("Marketing Today source " + source.key + " failed for " + ec.user.username + ": " + error.message)
            failedSources.push(source.title)
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    return {items, failedSources}
}

const operations = {calendarItems, checkCalendarEvent, campaignCalendar, today}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing calendar operation " + op)
        return operations[op](parameters || {})
    }
})
