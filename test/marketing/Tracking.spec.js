// Marketing's tracking links and capture (impl-marketing P15; design-marketing §8 TrackingLinks, TrackingLinkDetail, "Capture on the
// authority"; mantle.marketing.TrackingServices over MarketingTracking.js): a link goes only to a registered destination (a landing page
// of the organization's Marketing mount, an https address of its sites or its allowed list), a reader and another organization's author
// are kept out; the public capture keeps a visitor key's digest only where the policy allows, never names a recipient who does not allow
// tracking, marks a scanner's fetch apart, and a disabled link answers its safe destination whatever the request; a send's message gives
// a consenting recipient personalized links and a pixel (the token's digest kept, ninety days) and anyone else the direct destination.
// Standalone: spec-local organizations, users, sites, a landing page, a send and its recipients.
// Run: ./moq test mr-mantle --spec Tracking
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const tracking = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingTracking.js")
const {make, row, rows, system, organization, user, as, campaign} = lib
const K = "mantle.marketing.TrackingServices."
const prefix = "MKTR"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const siteA = prefix + "_SITE_A",
    siteB = prefix + "_SITE_B"
const hostA = "mktr-a.example.test",
    hostB = "mktr-b.example.test"
const users = {}
const ids = {}
const dayMs = 86400000
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
// a public operation as the anonymous request: its result, or {kind} of its refusal
function visitor(operation, input) {
    logout()
    ec.message.pushErrors()
    try {
        const out = ec.service
            .sync()
            .throwOnError(true)
            .name(K + operation)
            .parameters({input})
            .call()
        return ec.message.hasError() ? {kind: "error"} : out.result
    } catch (error) {
        return {kind: error.moquiErrorKind || "error", message: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const events = trackingCodeId => rows("mantle.marketing.tracking.MarketingTrackingEvent", {trackingCodeId})

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Tracking A")
            organization(orgB, "Tracking B")
            for (const [siteId, hostname, org] of [
                [siteA, hostA, orgA],
                [siteB, hostB, orgB]
            ]) {
                make("mantle.public.PublicSite", {
                    siteId,
                    name: "Tracking " + siteId,
                    state: "published",
                    registrationMode: "closed",
                    locale: "en",
                    timeZone: "UTC",
                    policyRevision: 1,
                    generation: 1
                })
                make("mantle.public.PublicSiteHost", {hostname, siteId, canonical: "Y"})
                make("mantle.public.PublicSiteApp", {
                    siteId,
                    appMountId: "marketing",
                    app: "marketing",
                    pathPrefix: "/marketing",
                    enabled: "Y",
                    targetId: org
                })
            }
            for (const [sitePageId, siteId] of [
                [prefix + "_PAGE_A", siteA],
                [prefix + "_PAGE_B", siteB]
            ])
                make("mantle.public.PublicSitePage", {
                    sitePageId,
                    siteId,
                    appMountId: "marketing",
                    routePath: "spring",
                    title: "Spring",
                    versionName: "v1",
                    fromDate: new Date(Date.now() - dayMs)
                })
            for (const [kind, codeValue] of [
                ["MvkUtmSource", "poster"],
                ["MvkUtmMedium", "qr"]
            ])
                make("mantle.marketing.campaign.MarketingVocabulary", {
                    organizationPartyId: orgA,
                    vocabularyKindEnumId: kind,
                    vocabularyCode: codeValue,
                    label: codeValue,
                    fromDate: new Date(Date.now() - dayMs)
                })
            make("mantle.marketing.campaign.MarketingPolicy", {
                organizationPartyId: orgA,
                fromDate: new Date(Date.now() - dayMs),
                trackingDomains: "partner.example.test",
                visitorKeys: "Y"
            })
            const authorPermissions = ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT", "MARKETING_CONTENT_EDIT"]
            users.author = user(prefix, "author", [orgA], authorPermissions)
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.authorB = user(prefix, "authorB", [orgB], authorPermissions)
            users.analyst = user(prefix, "analyst", [orgA], ["MARKETING_REPORT_VIEW"])
            // a send's two recipients: Ann allows tracking, Ben does not
            for (const [partyId, address, allows] of [
                [prefix + "_ANN", "ann@mktr.example.test", true],
                [prefix + "_BEN", "ben@mktr.example.test", false]
            ]) {
                make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId, firstName: partyId})
                make("mantle.party.contact.ContactMech", {
                    contactMechId: partyId + "_CM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: address
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId,
                    contactMechId: partyId + "_CM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: new Date(Date.now() - dayMs)
                })
                if (allows)
                    make("mantle.party.PartyConsent", {
                        partyId,
                        purposeEnumId: "PcpTracking",
                        statusId: "PconGranted",
                        organizationPartyId: orgA,
                        consentDate: new Date(Date.now() - dayMs),
                        sourceEnumId: "PcsForm"
                    })
            }
        })
        ids.campaign = campaign(users.author, orgA, {campaignName: "Tracked spring"})
        ids.campaignB = campaign(users.authorB, orgB, {campaignName: "Other spring"})
        system(() => {
            make("mantle.marketing.campaign.CampaignSend", {
                campaignSendId: prefix + "_SEND",
                marketingCampaignId: ids.campaign,
                organizationPartyId: orgA,
                sendName: "Spring news",
                channelEnumId: "MdcEmail"
            })
            for (const [suffix, partyId, tracked] of [
                ["ANN", prefix + "_ANN", "Y"],
                ["BEN", prefix + "_BEN", "N"]
            ])
                make("mantle.marketing.campaign.CampaignRecipient", {
                    campaignRecipientId: prefix + "_R_" + suffix,
                    campaignSendId: prefix + "_SEND",
                    partyId,
                    contactMechId: partyId + "_CM",
                    channelEnumId: "MdcEmail",
                    tracked,
                    executionKey: prefix + "_EXEC_" + suffix,
                    statusId: "CrsSelected"
                })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("a link goes only to a registered destination; a reader and another organization's author are kept out", {
    when() {
        const page = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Poster QR",
            siteId: siteA,
            destinationKindEnumId: "TdkSitePage",
            sitePageId: prefix + "_PAGE_A",
            utmSource: "poster",
            utmMedium: "qr"
        })
        ids.page = page.trackingCodeId
        ids.pageCode = page.publicCode
        const own = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Own site",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "https://" + hostA + "/marketing/pages/spring?x=1"
        })
        ids.own = own.trackingCodeId
        const partner = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Partner",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "https://shop.partner.example.test/spring"
        })
        const unregistered = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Elsewhere",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "https://evil.example.test/spring"
        })
        const otherSite = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "B's host",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "https://" + hostB + "/x"
        })
        const plainHttp = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Not https",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "http://" + hostA + "/x"
        })
        const userInfo = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "User info",
            destinationKindEnumId: "TdkUrl",
            redirectUrl: "https://" + hostA + "@evil.example.test/x"
        })
        const otherPage = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "B's page",
            destinationKindEnumId: "TdkSitePage",
            sitePageId: prefix + "_PAGE_B"
        })
        const badSource = as(users.author, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Unknown source",
            destinationKindEnumId: "TdkSitePage",
            sitePageId: prefix + "_PAGE_A",
            utmSource: "billboard"
        })
        const readerWrites = as(users.reader, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Poster QR",
            destinationKindEnumId: "TdkSitePage",
            sitePageId: prefix + "_PAGE_A"
        })
        const otherAuthor = as(users.authorB, K + "store#TrackingLink", {
            marketingCampaignId: ids.campaign,
            description: "Poster QR",
            destinationKindEnumId: "TdkSitePage",
            sitePageId: prefix + "_PAGE_A"
        })
        const otherRead = as(users.authorB, K + "get#TrackingLink", {trackingCodeId: ids.page})
        const otherFind = as(users.authorB, K + "find#TrackingLinks", {})
        const shown = as(users.reader, K + "get#TrackingLink", {trackingCodeId: ids.page})
        const listed = as(users.reader, K + "find#TrackingLinks", {marketingCampaignId: ids.campaign})
        const stale = as(users.author, K + "store#TrackingLink", {
            trackingCodeId: ids.page,
            expectedRevision: 1,
            description: "Renamed"
        })
        const fresh = as(users.author, K + "store#TrackingLink", {
            trackingCodeId: ids.page,
            expectedRevision: shown.trackingLink.revision,
            description: "Poster QR code"
        })
        const after = row("mantle.marketing.tracking.TrackingCode", {trackingCodeId: ids.page})
        return {
            page,
            own,
            partner,
            unregistered,
            otherSite,
            plainHttp,
            userInfo,
            otherPage,
            badSource,
            readerWrites,
            otherAuthor,
            otherRead,
            otherFind,
            shown,
            listed,
            stale,
            fresh,
            after
        }
    },
    then(r) {
        r.page.refusal == "" && /^[A-Za-z0-9]{10}$/.test(r.page.publicCode)
        r.own.refusal == "" && r.partner.refusal == ""
        code(r.unregistered) == "DESTINATION_NOT_REGISTERED" && code(r.otherSite) == "DESTINATION_NOT_REGISTERED"
        code(r.plainHttp) == "DESTINATION_INVALID" && code(r.userInfo) == "DESTINATION_INVALID"
        code(r.otherPage) == "DESTINATION_INVALID"
        code(r.badSource) == "VALUE_INVALID"
        code(r.readerWrites) == "PERMISSION_DENIED"
        code(r.otherAuthor) == "RECORD_UNAVAILABLE" && code(r.otherRead) == "RECORD_UNAVAILABLE"
        r.otherFind.refusal == "" && r.otherFind.trackingLinkList.length == 0
        // the reader sees the address and its QR code, and no observations (an author's or a report reader's)
        r.shown.trackingLink.publicUrl == "https://" + hostA + "/trk/" + siteA + "/" + r.page.publicCode
        String(r.shown.qrSvg).includes("<svg")
        r.shown.observations == null && r.shown.capabilities.canEdit == false
        r.shown.trackingLink.destinationNow ==
            "https://" + hostA + "/marketing/pages/spring?utm_source=poster&utm_medium=qr&utm_campaign=" + ids.campaign
        r.listed.trackingLinkList.length == 3 && r.listed.trackingLinkList.every(link => link.label && link.current === true)
        code(r.stale) == "STALE_REVISION"
        r.fresh.refusal == "" && r.after.description == "Poster QR code" && r.after.publicCode == r.page.publicCode
    }
})

feature(
    "the public capture: a visitor key's digest where the policy allows, no recipient without tracking consent, a scanner apart",
    {
        when() {
            const resolved = visitor("resolve#TrackingLink", {siteId: siteA, code: ids.pageCode})
            const otherSite = visitor("resolve#TrackingLink", {siteId: siteB, code: ids.pageCode})
            const unknown = visitor("resolve#TrackingLink", {siteId: siteA, code: "NoSuchCode1"})
            const key = "visitor-key-0123456789abcdef"
            const click = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, visitorKey: key, kind: "click"})
            const again = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, visitorKey: key, kind: "visit"})
            const scanner = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, kind: "fetch"})
            const crossSite = visitor("record#TrackingEvent", {siteId: siteB, code: ids.pageCode, kind: "click"})
            const openWithCode = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, kind: "open"})
            const pixelWithoutToken = visitor("record#TrackingEvent", {siteId: siteA, kind: "open"})
            // a link of an organization whose policy sets no visitor key: the key is dropped
            system(() =>
                make("mantle.marketing.tracking.TrackingCode", {
                    trackingCodeId: prefix + "_B_LINK",
                    marketingCampaignId: ids.campaignB,
                    organizationPartyId: orgB,
                    siteId: siteB,
                    publicCode: "MktrBLink01",
                    destinationKindEnumId: "TdkSitePage",
                    sitePageId: prefix + "_PAGE_B",
                    disabled: "N",
                    fromDate: new Date(Date.now() - dayMs)
                })
            )
            const keyless = visitor("record#TrackingEvent", {siteId: siteB, code: "MktrBLink01", visitorKey: key, kind: "click"})
            const resolvedB = visitor("resolve#TrackingLink", {siteId: siteB, code: "MktrBLink01"})
            const observed = as(users.analyst, K + "get#TrackingLink", {trackingCodeId: ids.page})
            return {
                resolved,
                otherSite,
                unknown,
                click,
                again,
                scanner,
                crossSite,
                openWithCode,
                pixelWithoutToken,
                keyless,
                resolvedB,
                observed,
                pageEvents: events(ids.page),
                bEvents: events(prefix + "_B_LINK"),
                key
            }
        },
        then(r) {
            r.resolved.destination ==
                "https://" + hostA + "/marketing/pages/spring?utm_source=poster&utm_medium=qr&utm_campaign=" + ids.campaign
            r.resolved.available == true && r.resolved.visitorKeys == true
            r.otherSite.kind == "NotFound" && r.unknown.kind == "NotFound"
            r.click.recorded == true && r.again.recorded == true && r.scanner.recorded == true
            r.crossSite.recorded == false && r.openWithCode.recorded == false && r.pixelWithoutToken.recorded == false
            r.pageEvents.length == 3
            // the key is kept as its digest only, never itself; no event names a recipient or a party
            r.pageEvents.filter(event => event.visitorKeyHash).length == 2
            r.pageEvents.every(event => event.visitorKeyHash != r.key && !event.campaignRecipientId)
            r.pageEvents.filter(event => event.automated == "Y").length == 1
            r.resolvedB.visitorKeys == false &&
                r.keyless.recorded == true &&
                r.bEvents.length == 1 &&
                !r.bEvents[0].visitorKeyHash
            // one visitor by key, one click and one visit; the scanner apart and never counted as a visit
            r.observed.observations.period.clicks == 1 && r.observed.observations.period.visits == 1
            r.observed.observations.period.visitors == 1 && r.observed.observations.period.automated == 1
        }
    }
)

feature("a disabled link answers its safe destination whatever the request; an ended one with none answers the neutral page", {
    when() {
        const shown = as(users.author, K + "get#TrackingLink", {trackingCodeId: ids.own})
        const disabled = as(users.author, K + "store#TrackingLink", {
            trackingCodeId: ids.own,
            expectedRevision: shown.trackingLink.revision,
            disabled: "Y",
            safeUrl: "https://" + hostA + "/marketing"
        })
        const ownCode = row("mantle.marketing.tracking.TrackingCode", {trackingCodeId: ids.own}).publicCode
        const resolved = visitor("resolve#TrackingLink", {
            siteId: siteA,
            code: ownCode,
            destination: "https://evil.example.test/"
        })
        const badSafe = as(users.author, K + "store#TrackingLink", {
            trackingCodeId: ids.own,
            expectedRevision: entityLib.ms(
                row("mantle.marketing.tracking.TrackingCode", {trackingCodeId: ids.own}).lastUpdatedStamp
            ),
            safeUrl: "https://evil.example.test/"
        })
        system(() =>
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_ENDED",
                marketingCampaignId: ids.campaign,
                organizationPartyId: orgA,
                siteId: siteA,
                publicCode: "MktrEnded01",
                destinationKindEnumId: "TdkUrl",
                redirectUrl: "https://" + hostA + "/old",
                disabled: "N",
                fromDate: new Date(Date.now() - 10 * dayMs),
                thruDate: new Date(Date.now() - dayMs)
            })
        )
        const ended = visitor("resolve#TrackingLink", {siteId: siteA, code: "MktrEnded01"})
        // a disabled or ended link counts nothing
        const before = events(ids.own).length + events(prefix + "_ENDED").length
        const disabledClick = visitor("record#TrackingEvent", {siteId: siteA, code: ownCode, kind: "click"})
        const endedClick = visitor("record#TrackingEvent", {siteId: siteA, code: "MktrEnded01", kind: "click"})
        const added = events(ids.own).length + events(prefix + "_ENDED").length - before
        return {disabled, resolved, badSafe, ended, disabledClick, endedClick, added}
    },
    then(r) {
        r.disabled.refusal == ""
        r.resolved.destination == "https://" + hostA + "/marketing" && r.resolved.available == false
        code(r.badSafe) == "DESTINATION_NOT_REGISTERED"
        r.ended.destination == null && r.ended.available == false
        r.disabledClick.recorded == false && r.endedClick.recorded == false && r.added == 0
    }
})

feature("a send's message: personalized links and a pixel for a recipient who allows tracking, direct links for anyone else", {
    when() {
        const send = row("mantle.marketing.campaign.CampaignSend", {campaignSendId: prefix + "_SEND"})
        const ann = row("mantle.marketing.campaign.CampaignRecipient", {campaignRecipientId: prefix + "_R_ANN"})
        const ben = row("mantle.marketing.campaign.CampaignRecipient", {campaignRecipientId: prefix + "_R_BEN"})
        const link = "https://" + hostA + "/trk/" + siteA + "/" + ids.pageCode
        // the same code on a host the site does not have: left as written, never given the token
        const foreign = "https://elsewhere.example.test/trk/" + siteA + "/" + ids.pageCode
        const body = '<p><a href="' + link + '">Spring</a> <a href="' + foreign + '">Mirror</a></p>'
        const text = "Spring: " + link + "\n"
        const profile = {trackingPolicyEnumId: "MtrConsented"}
        const forAnn = system(() => tracking.messageTracking(send, ann, profile, body, text))
        const forBen = system(() => tracking.messageTracking(send, ben, profile, body, text))
        const noPolicy = system(() => tracking.messageTracking(send, ann, {trackingPolicyEnumId: "MtrNone"}, body, text))
        const token = (/\?token=([A-Za-z0-9_-]+)/.exec(forAnn.body) || [])[1] || ""
        const tokens = rows("mantle.marketing.tracking.MarketingTrackingToken", {campaignRecipientId: prefix + "_R_ANN"})
        // Ann's click through her link names her; Ben's direct link and a click with a made-up token name no one
        const annClick = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, token, kind: "click"})
        const annOpen = visitor("record#TrackingEvent", {siteId: siteA, token, kind: "open"})
        const forged = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, token: "x".repeat(40), kind: "click"})
        // an expired token names no one, though Ann still allows tracking
        const expireToken = expireDate =>
            system(() =>
                ec.service
                    .sync()
                    .name("update#mantle.marketing.tracking.MarketingTrackingToken")
                    .parameters({tokenHash: tokens[0].tokenHash, expireDate})
                    .call()
            )
        expireToken(new Date(Date.now() - 1000))
        const expiredClick = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, token, kind: "click"})
        expireToken(tokens[0].expireDate)
        // Ann withdraws tracking: her token names her no more
        system(() =>
            make("mantle.party.PartyConsent", {
                partyId: prefix + "_ANN",
                purposeEnumId: "PcpTracking",
                statusId: "PconWithdrawn",
                organizationPartyId: orgA,
                consentDate: ec.user.nowTimestamp,
                sourceEnumId: "PcsForm"
            })
        )
        const afterWithdrawal = visitor("record#TrackingEvent", {siteId: siteA, code: ids.pageCode, token, kind: "click"})
        // the token expired: the link still works, as an anonymous click
        expireToken(new Date(Date.now() - 1000))
        const expired = visitor("resolve#TrackingLink", {siteId: siteA, code: ids.pageCode, token})
        const named = rows("mantle.marketing.tracking.MarketingTrackingEvent", {campaignRecipientId: prefix + "_R_ANN"})
        const clicks = tracking.recipientClicks([prefix + "_R_ANN", prefix + "_R_BEN"])
        return {
            forAnn,
            forBen,
            noPolicy,
            token,
            tokens,
            annClick,
            annOpen,
            forged,
            expiredClick,
            afterWithdrawal,
            expired,
            named,
            clicks,
            link,
            foreign
        }
    },
    then(r) {
        r.forAnn.tracked == true && r.token.length >= 32
        r.forAnn.body.includes(r.link + "?token=" + r.token) && r.forAnn.bodyText.includes(r.link + "?token=" + r.token)
        r.forAnn.body.includes("/trk-o/" + siteA + "?token=" + r.token)
        r.forAnn.body.includes('href="' + r.foreign + '"') && !r.forAnn.body.includes(r.foreign + "?token=")
        // the token's digest alone is kept, for ninety days
        r.tokens.length == 1 && r.tokens[0].tokenHash != r.token && !JSON.stringify(r.tokens[0]).includes(r.token)
        entityLib.ms(r.tokens[0].expireDate) - entityLib.ms(r.tokens[0].createdDate) == 90 * 86400000
        // no token, no pixel: the direct destination, the &amp; escaped in the HTML
        r.forBen.tracked == false && !r.forBen.body.includes(r.link) && !r.forBen.body.includes("/trk-o/")
        !r.forBen.bodyText.includes("/trk")
        r.forBen.body.includes("https://" + hostA + "/marketing/pages/spring?utm_source=poster&amp;utm_medium=qr")
        r.forBen.bodyText.includes("https://" + hostA + "/marketing/pages/spring?utm_source=poster&utm_medium=qr")
        r.noPolicy.tracked == false && !r.noPolicy.body.includes("token=")
        r.annClick.recorded == true &&
            r.annOpen.recorded == true &&
            r.forged.recorded == true &&
            r.expiredClick.recorded == true &&
            r.afterWithdrawal.recorded == true
        r.named.length == 2 && r.named.every(event => event.campaignSendId == prefix + "_SEND")
        r.expired.destination.startsWith("https://" + hostA + "/marketing/pages/spring") && r.expired.visitorKeys == true
        r.clicks.get(prefix + "_R_ANN").clicks == 1 && !r.clicks.has(prefix + "_R_BEN")
    }
})
