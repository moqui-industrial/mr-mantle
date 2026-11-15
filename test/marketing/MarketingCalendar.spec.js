// Marketing's schedule (impl-marketing P21, F71; design-marketing §3 Calendar, §1.3 CX-SYNC, §14.3 Today;
// mantle.marketing.MarketingWorkspaceServices over MarketingCalendar.js): the calendar items of the caller's organizations (a campaign's
// window, a scheduled send and a registration event) and none of another organization's; only an event of the calendar is one a drag
// may move (a send refused); the "Campaign calendar" projected CalDAV collection listed for a holder of MARKETING_VIEW alone, holding the
// same items, read only (a device write refused 403) and naming no address or token; Today's sends due for an author and none for a
// reader. Standalone: spec-local organizations, users, a campaign, sends and an event.
// Run: ./moq test mr-mantle --spec MarketingCalendar
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, system, organization, user, as, campaign} = lib
const W = "mantle.marketing.MarketingWorkspaceServices."
const DAV = "mantle.work.CalendarDavServices."
const prefix = "MKCAL"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const dayMs = 24 * 60 * 60 * 1000
const users = {}
const ids = {}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
const day = millis => ec.l10n.format(new Date(millis), "yyyy-MM-dd")
const range = {start: day(Date.now()), end: day(Date.now() + 40 * dayMs)}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Calendar A")
            organization(orgB, "Calendar B")
            const authorPermissions = ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_SEND_EDIT"]
            users.author = user(prefix, "author", [orgA], authorPermissions)
            users.authorB = user(prefix, "authorB", [orgB], authorPermissions)
            // reads Marketing's reports only: no MARKETING_VIEW, so no projected collection and no send of Today
            users.analyst = user(prefix, "analyst", [orgA], ["MARKETING_REPORT_VIEW"])
        })
        ids.campaign = campaign(users.author, orgA, {campaignName: "Calendar spring"})
        ids.campaignB = campaign(users.authorB, orgB, {campaignName: "Calendar other"})
        // the event its organizer makes in the calendar, then offered by organization A (its registration event)
        const event = as(users.author, "mantle.work.EventServices.create#Event", {
            workEffortName: "Calendar workshop",
            estimatedStartDate: new Date(Date.now() + 5 * dayMs),
            estimatedCompletionDate: new Date(Date.now() + 5 * dayMs + 2 * 3600000),
            location: "Spec hall"
        })
        if (event.refusal) throw new Error("event: " + event.refusal)
        ids.event = event.workEffortId
        system(() => {
            make("mantle.work.registration.RegistrationEvent", {workEffortId: ids.event, organizationPartyId: orgA})
            const send = (campaignSendId, marketingCampaignId, organizationPartyId, sendName, scheduledDate) =>
                make("mantle.marketing.campaign.CampaignSend", {
                    campaignSendId,
                    marketingCampaignId,
                    organizationPartyId,
                    sendName,
                    statusId: "CsScheduled",
                    scheduledDate,
                    sendRevision: 1
                })
            send(prefix + "_SEND", ids.campaign, orgA, "Calendar newsletter", new Date(Date.now() + 3 * dayMs))
            send(prefix + "_SEND_NOW", ids.campaign, orgA, "Calendar reminder", new Date(Date.now() + 3600000))
            send(prefix + "_SEND_B", ids.campaignB, orgB, "Calendar other newsletter", new Date(Date.now() + 3 * dayMs))
        })
    }
})

feature("the calendar shows the organization's campaign window, scheduled send and event, and nothing of another organization", {
    when() {
        const items = as(users.author, W + "get#CalendarItems", range)
        const kinds = {}
        for (const item of Array.from(items.items || [])) kinds[item.key] = item
        return {
            items,
            kinds,
            other: as(users.author, W + "get#CalendarItems", Object.assign({organizationPartyId: orgB}, range)),
            backwards: as(users.author, W + "get#CalendarItems", {start: range.end, end: range.start}),
            analyst: as(users.analyst, W + "get#CalendarItems", range)
        }
    },
    then({items, kinds, other, backwards, analyst}) {
        items.refusal == "" && items.failedSources.length == 0
        kinds["campaign|" + ids.campaign].allDay == true
        kinds["campaign|" + ids.campaign].title == "Campaign: Calendar spring"
        kinds["campaign|" + ids.campaign].route == "marketingCampaign"
        kinds["send|" + prefix + "_SEND"].allDay == false
        kinds["send|" + prefix + "_SEND"].title == "Send: Calendar newsletter"
        kinds["send|" + prefix + "_SEND"].stateText.length > 0
        Object.values(kinds).some(item => item.kind === "event" && item.workEffortId === ids.event)
        // another organization's campaign and send are not in the author's calendar, and its organization is refused
        !Object.keys(kinds).some(key => key.includes(ids.campaignB) || key.includes(prefix + "_SEND_B"))
        code(other) == "ORGANIZATION_DENIED"
        code(backwards) == "DATES_INVALID"
        // a report reader reads the same schedule (aggregate dates, no person)
        analyst.refusal == "" && Array.from(analyst.items).some(item => item.key === "send|" + prefix + "_SEND")
    }
})

feature("only an event of the calendar moves: a send and another organization's event are refused", {
    when() {
        return {
            event: as(users.author, W + "check#CalendarEvent", {workEffortId: ids.event}),
            send: as(users.author, W + "check#CalendarEvent", {workEffortId: prefix + "_SEND"}),
            otherOrganization: as(users.authorB, W + "check#CalendarEvent", {workEffortId: ids.event})
        }
    },
    then({event, send, otherOrganization}) {
        event.refusal == "" && event.workEffortId == ids.event
        code(send) == "RECORD_UNAVAILABLE"
        code(otherOrganization) == "RECORD_UNAVAILABLE"
    }
})

feature("the Campaign calendar collection: listed for MARKETING_VIEW, the same items read only, a device write refused", {
    when() {
        const collections = username =>
            Array.from(as(username, DAV + "get#DavCollections").collectionList || []).map(row => row.collectionId)
        const collection = Array.from(as(users.author, DAV + "get#DavCollections").collectionList || []).find(
            row => row.collectionId === "projected-MarketingCampaigns"
        )
        const objects = Array.from(
            as(users.author, DAV + "get#DavObjects", {collectionId: "projected-MarketingCampaigns", withData: true}).objectList ||
                []
        )
        const put = as(users.author, DAV + "put#DavObject", {
            collectionId: "projected-MarketingCampaigns",
            objectName: objects[0]?.name || "marketing-send.ics",
            data: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
        })
        return {
            author: collections(users.author),
            analyst: collections(users.analyst),
            collection,
            data: objects.map(object => String(object.data || "")).join("\n"),
            put
        }
    },
    then({author, analyst, collection, data, put}) {
        author.includes("projected-MarketingCampaigns")
        !analyst.includes("projected-MarketingCampaigns")
        collection.readOnly == true
        data.includes("Campaign: Calendar spring")
        data.includes("Send: Calendar newsletter")
        data.includes("Calendar workshop")
        !data.includes("Calendar other")
        !data.includes("@")
        put.status == 403
    }
})

feature("Today names the sends due for an author of the organization; none for a reader without sends", {
    when() {
        const thruDate = new Date(Date.now() + 2 * 3600000)
        return {
            author: as(users.author, W + "get#TodayItems", {thruDate}),
            authorB: as(users.authorB, W + "get#TodayItems", {thruDate}),
            analyst: as(users.analyst, W + "get#TodayItems", {thruDate})
        }
    },
    then({author, authorB, analyst}) {
        author.failedSources.length == 0
        Array.from(author.items).some(item => item.recordId === prefix + "_SEND_NOW" && item.route === "marketingSend")
        !Array.from(author.items).some(item => item.recordId === prefix + "_SEND")
        !Array.from(authorB.items).some(item => String(item.recordId).startsWith(prefix + "_SEND_NOW"))
        analyst.items.length == 0
    }
})
