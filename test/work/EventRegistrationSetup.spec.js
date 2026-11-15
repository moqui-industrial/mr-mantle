// Event registration setup (impl-marketing P16; design-marketing §9 Events, RegistrationSetup, §13 Event; mantle.work.EventRegistrationServices
// over EventRegistrations.js): an events manager who may edit a calendar event offers its registration for an organization, its
// campaign link only with the campaign's edit (CampaignServices store#CampaignAssociation), a reader, another organization's manager and a manager who may not edit the event kept out; capacity is never set below the
// places held or confirmed, one occurrence's seats not another's; a paid ticket is not published without a payment gateway, a stale
// revision is refused, and the published offer's public view names nothing internal. Standalone: spec-local organizations, users, a site,
// a sending profile, a ticket product and its price.
// Run: ./moq test mr-mantle --spec EventRegistrationSetup
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as, campaign} = lib
const E = "mantle.work.EventRegistrationServices."
const prefix = "MKEV"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const site = prefix + "_SITE"
const users = {}
const ids = {}
const dayMs = 86400000
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
const revision = registrationPolicyId =>
    entityLib.ms(row("mantle.work.registration.EventRegistrationPolicy", {registrationPolicyId}).lastUpdatedStamp)
// the start of the day after next at 10:00 in UTC, a week apart for the series
const firstStart = (() => {
    const at = new Date(Date.now() + 2 * dayMs)
    return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 10, 0, 0)
})()
// an event as its organizer makes one in the calendar
function event(username, name, extra = {}) {
    const out = as(
        username,
        "mantle.work.EventServices.create#Event",
        Object.assign(
            {
                workEffortName: name,
                estimatedStartDate: new Date(firstStart),
                estimatedCompletionDate: new Date(firstStart + 2 * 3600000),
                location: "Spec hall"
            },
            extra
        )
    )
    if (out.refusal) throw new Error("event: " + out.refusal)
    return out.workEffortId
}
function places(registrationPolicyId, ticketTypeId, states) {
    system(() =>
        states.forEach((statusId, index) =>
            make("mantle.work.registration.EventRegistration", {
                registrationId: registrationPolicyId + "_R" + index + "_" + statusId,
                registrationPolicyId,
                ticketTypeId,
                statusId,
                holdExpireDate: statusId === "EvrHeld" ? new Date(Date.now() + 3600000) : null,
                createdDate: new Date()
            })
        )
    )
}
// a public operation as the anonymous request: its result, or {kind} of its refusal
function visitor(input, service = "mantle.marketing.MarketingPortalServices.get#Event") {
    logout()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().throwOnError(true).name(service).parameters({input}).call()
        return out.result
    } catch (error) {
        return {kind: error.moquiErrorKind || "error", message: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Events A")
            organization(orgB, "Events B")
            make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: orgA, baseCurrencyUomId: "USD"})
            make("mantle.public.PublicSite", {
                siteId: site,
                name: "Events site",
                state: "published",
                registrationMode: "closed",
                locale: "en",
                timeZone: "UTC",
                policyRevision: 1,
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: "mkev.example.test", siteId: site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: site,
                appMountId: "marketing",
                app: "marketing",
                pathPrefix: "/marketing",
                enabled: "Y",
                targetId: orgA
            })
            // a ready transactional profile of A for the notices
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_RELAY",
                smtpHost: "relay.mkev.example.test",
                smtpPort: "9"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkev.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: prefix + "_PROFILE",
                organizationPartyId: orgA,
                profileName: "A notices",
                channelEnumId: "MdcEmail",
                emailServerId: prefix + "_RELAY",
                fromAddress: "events@mkev.example.test",
                purposeEnumId: "MtpTransactional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mkev.example.test",
                fromDate: new Date(Date.now() - dayMs)
            })
            // a ticket product of A and its price
            make("mantle.product.Product", {
                productId: prefix + "_TICKET",
                productName: "Workshop seat",
                productTypeEnumId: "PtService",
                ownerPartyId: orgA
            })
            make("mantle.product.ProductPrice", {
                productId: prefix + "_TICKET",
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                price: "40.00",
                priceUomId: "USD"
            })
            make("mantle.product.Product", {
                productId: prefix + "_OTHER",
                productName: "B's seat",
                productTypeEnumId: "PtService",
                ownerPartyId: orgB
            })
            users.manager = user(prefix, "manager", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.other = user(prefix, "other", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.managerB = user(prefix, "managerB", [orgB], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE"])
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"])
            users.content = user(prefix, "content", [orgA], ["MARKETING_VIEW", "MARKETING_CONTENT_EDIT"])
            users.lead = user(prefix, "lead", [orgA], ["MARKETING_VIEW", "MARKETING_EVENT_MANAGE", "MARKETING_CAMPAIGN_EDIT"])
        })
        ids.campaign = campaign(users.author, orgA, {campaignName: "Events spring"})
        ids.webinar = event(users.manager, "Spring webinar")
        ids.series = event(users.manager, "Weekly workshop", {rrule: "FREQ=WEEKLY;COUNT=4", recurrenceTimeZone: "UTC"})
        for (const workEffortId of [ids.webinar, ids.series]) {
            const out = as(users.manager, E + "store#RegistrationEvent", {workEffortId, organizationPartyId: orgA})
            if (out.refusal) throw new Error("registration event: " + out.refusal)
        }
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "an events manager who may edit the event offers it; the campaign link asks the campaign's edit; a reader, another organization and a non-editor are kept out",
    {
        when() {
            const own = event(users.manager, "Garden evening")
            const reader = as(users.reader, E + "store#RegistrationEvent", {workEffortId: own, organizationPartyId: orgA})
            const notEditor = as(users.other, E + "store#RegistrationEvent", {workEffortId: own, organizationPartyId: orgA})
            const otherOrg = as(users.manager, E + "store#RegistrationEvent", {workEffortId: own, organizationPartyId: orgB})
            // the campaign link is a change of the campaign: an events manager without its edit is refused and nothing is kept
            const noCampaignEdit = as(users.manager, E + "store#RegistrationEvent", {
                workEffortId: own,
                organizationPartyId: orgA,
                marketingCampaignId: ids.campaign
            })
            const keptNothing = !row("mantle.work.registration.RegistrationEvent", {workEffortId: own})
            const adopted = as(users.manager, E + "store#RegistrationEvent", {workEffortId: own, organizationPartyId: orgA})
            const again = as(users.manager, E + "store#RegistrationEvent", {workEffortId: own, organizationPartyId: orgA})
            // the campaign's author links it (C.store#CampaignAssociation, CakEvent by the event's organization)
            const authorLink = as(users.author, "mantle.marketing.CampaignServices.store#CampaignAssociation", {
                marketingCampaignId: ids.campaign,
                associationKindEnumId: "CakEvent",
                sourceId: own
            })
            // an events manager who also edits campaigns offers an event of theirs with its campaign link, once
            const led = event(users.lead, "Seed swap")
            const withCampaign = as(users.lead, E + "store#RegistrationEvent", {
                workEffortId: led,
                organizationPartyId: orgA,
                marketingCampaignId: ids.campaign
            })
            const linkedAgain = as(users.lead, E + "store#RegistrationEvent", {
                workEffortId: led,
                organizationPartyId: orgA,
                marketingCampaignId: ids.campaign
            })
            const fromB = as(users.managerB, E + "store#RegistrationPolicy", {workEffortId: own, totalSeats: 10})
            const readB = as(users.managerB, E + "get#EventSetup", {workEffortId: own})
            const byCampaign = as(users.reader, E + "find#Events", {marketingCampaignId: ids.campaign})
            const offer = as(users.manager, E + "store#RegistrationPolicy", {workEffortId: own, totalSeats: 10})
            const readerOffer = as(users.reader, E + "store#RegistrationPolicy", {workEffortId: own, totalSeats: 10})
            return {
                reader,
                notEditor,
                otherOrg,
                noCampaignEdit,
                keptNothing,
                adopted,
                again,
                authorLink,
                withCampaign,
                linkedAgain,
                fromB,
                readB,
                byCampaign,
                offer,
                readerOffer,
                own,
                led
            }
        },
        then(r) {
            code(r.reader) == "PERMISSION_DENIED"
            code(r.notEditor) == "EVENT_EDIT_REQUIRED"
            code(r.otherOrg) == "ORGANIZATION_DENIED"
            code(r.noCampaignEdit) == "CAMPAIGN_EDIT_REQUIRED" && r.keptNothing
            r.adopted.refusal == "" && r.adopted.created && !r.adopted.campaignAssociationId
            r.again.refusal == "" && !r.again.created
            r.authorLink.refusal == "" && !!r.authorLink.campaignAssociationId
            r.withCampaign.refusal == "" && r.withCampaign.created && !!r.withCampaign.campaignAssociationId
            r.linkedAgain.refusal == "" && !r.linkedAgain.created
            r.linkedAgain.campaignAssociationId == r.withCampaign.campaignAssociationId
            code(r.fromB) == "RECORD_UNAVAILABLE"
            code(r.readB) == "RECORD_UNAVAILABLE"
            r.byCampaign.refusal == "" &&
                r.byCampaign.eventList
                    .map(found => found.workEffortId)
                    .sort()
                    .join() == [r.own, r.led].sort().join()
            r.byCampaign.eventList[0].campaignText == "Events spring"
            r.offer.refusal == "" && !!r.offer.registrationPolicyId
            code(r.readerOffer) == "PERMISSION_DENIED"
        }
    }
)

feature("capacity is never set below the places held or confirmed, and one occurrence's seats are not another's", {
    when() {
        const second = firstStart + 7 * dayMs
        const noKey = as(users.manager, E + "store#RegistrationPolicy", {workEffortId: ids.series, totalSeats: 3})
        const notOne = as(users.manager, E + "store#RegistrationPolicy", {
            workEffortId: ids.series,
            occurrenceStart: new Date(firstStart + 3600000),
            totalSeats: 3
        })
        const first = as(users.manager, E + "store#RegistrationPolicy", {
            workEffortId: ids.series,
            occurrenceStart: new Date(firstStart),
            totalSeats: 3
        })
        const twice = as(users.manager, E + "store#RegistrationPolicy", {
            workEffortId: ids.series,
            occurrenceStart: new Date(firstStart),
            totalSeats: 3
        })
        const next = as(users.manager, E + "store#RegistrationPolicy", {
            workEffortId: ids.series,
            occurrenceStart: new Date(second),
            totalSeats: 3
        })
        const ticket = as(users.manager, E + "store#TicketType", {
            registrationPolicyId: first.registrationPolicyId,
            ticketName: "Seat",
            capacity: 3
        })
        // two confirmed and one held on the first, and a hold that has ended (not counted)
        places(first.registrationPolicyId, ticket.ticketTypeId, ["EvrConfirmed", "EvrConfirmed", "EvrHeld"])
        system(() =>
            make("mantle.work.registration.EventRegistration", {
                registrationId: first.registrationPolicyId + "_ENDED",
                registrationPolicyId: first.registrationPolicyId,
                ticketTypeId: ticket.ticketTypeId,
                statusId: "EvrHeld",
                holdExpireDate: new Date(Date.now() - 3600000),
                createdDate: new Date()
            })
        )
        const below = as(users.manager, E + "store#RegistrationPolicy", {
            registrationPolicyId: first.registrationPolicyId,
            expectedRevision: revision(first.registrationPolicyId),
            totalSeats: 2
        })
        const atTaken = as(users.manager, E + "store#RegistrationPolicy", {
            registrationPolicyId: first.registrationPolicyId,
            expectedRevision: revision(first.registrationPolicyId),
            totalSeats: 3
        })
        const ticketBelow = as(users.manager, E + "store#TicketType", {
            ticketTypeId: ticket.ticketTypeId,
            expectedRevision: entityLib.ms(
                row("mantle.work.registration.EventTicketType", {ticketTypeId: ticket.ticketTypeId}).lastUpdatedStamp
            ),
            capacity: 2
        })
        const otherOccurrence = as(users.manager, E + "store#RegistrationPolicy", {
            registrationPolicyId: next.registrationPolicyId,
            expectedRevision: revision(next.registrationPolicyId),
            totalSeats: 1
        })
        const setup = as(users.reader, E + "get#EventSetup", {workEffortId: ids.series})
        return {noKey, notOne, first, twice, next, below, atTaken, ticketBelow, otherOccurrence, setup}
    },
    then({noKey, notOne, first, twice, next, below, atTaken, ticketBelow, otherOccurrence, setup}) {
        code(noKey) == "OCCURRENCE_REQUIRED"
        code(notOne) == "OCCURRENCE_UNAVAILABLE"
        first.refusal == "" && next.refusal == "" && first.registrationPolicyId != next.registrationPolicyId
        code(twice) == "OFFER_EXISTS"
        code(below) == "CAPACITY_BELOW_TAKEN"
        atTaken.refusal == ""
        code(ticketBelow) == "CAPACITY_BELOW_TAKEN"
        otherOccurrence.refusal == ""
        setup.refusal == "" && setup.offers.length == 2
        setup.offers.find(offer => offer.registrationPolicyId == first.registrationPolicyId).takenCount == 3
        setup.offers.find(offer => offer.registrationPolicyId == next.registrationPolicyId).takenCount == 0
        // the series' two other occurrences have no offer yet
        setup.occurrences.length == 2
    }
})

feature(
    "a paid ticket is not published without a payment gateway; a stale revision is refused; the public view names nothing internal",
    {
        when() {
            const offer = as(users.manager, E + "store#RegistrationPolicy", {
                workEffortId: ids.webinar,
                totalSeats: 12,
                siteId: site,
                publicTitle: "Spring webinar",
                publicDescription: "An hour on spring planting.",
                termsText: "Seats are held for 15 minutes."
            })
            const id = offer.registrationPolicyId
            const otherProduct = as(users.manager, E + "store#TicketType", {
                registrationPolicyId: id,
                ticketName: "B",
                productId: prefix + "_OTHER"
            })
            const paid = as(users.manager, E + "store#TicketType", {
                registrationPolicyId: id,
                ticketName: "Standard",
                productId: prefix + "_TICKET"
            })
            as(users.manager, E + "store#TicketType", {registrationPolicyId: id, ticketName: "Guest"})
            // registration questions a content author built and published; a survey of the organization is not registration questions
            const formOf = (purposeEnumId, description) => {
                const form = as(users.content, "mantle.party.FormDefinitionServices.create#Form", {
                    purposeEnumId,
                    organizationPartyId: orgA,
                    description
                })
                as(users.content, "mantle.party.FormDefinitionServices.save#FormField", {
                    formId: form.formId,
                    title: "Dietary needs",
                    fieldTypeEnumId: "DBFFT_text-line",
                    audienceEnumId: "CfaCustomer"
                })
                as(users.content, "mantle.party.FormDefinitionServices.publish#Form", {formId: form.formId})
                return form.formId
            }
            const surveyForm = as(users.manager, E + "store#RegistrationForm", {
                registrationPolicyId: id,
                expectedRevision: revision(id),
                formId: formOf("DbfpSurvey", "Spec survey")
            })
            const questions = as(users.manager, E + "store#RegistrationForm", {
                registrationPolicyId: id,
                expectedRevision: revision(id),
                formId: formOf("DbfpRegistration", "Spec registration")
            })
            const noGateway = as(users.manager, E + "publish#Registration", {
                registrationPolicyId: id,
                expectedRevision: revision(id)
            })
            const draftView = visitor({siteId: site, registrationPolicyId: id})
            system(() =>
                make("mantle.account.method.PaymentGatewayOrganization", {
                    organizationPartyId: orgA,
                    paymentGatewayConfigId: "TEST_APPROVE",
                    fromDate: new Date(Date.now() - dayMs),
                    isEnabled: "Y"
                })
            )
            const stale = as(users.manager, E + "publish#Registration", {registrationPolicyId: id, expectedRevision: 1})
            const published = as(users.manager, E + "publish#Registration", {
                registrationPolicyId: id,
                expectedRevision: revision(id)
            })
            const view = visitor({siteId: site, registrationPolicyId: id})
            // the offer's question publication: the offer's own, of its organization, open with it, and never answered on SubmitForm
            const publication = row("mantle.party.FormPublication", {publicationId: questions.formPublicationId})
            const formPage = visitor(
                {siteId: site, publicationId: questions.formPublicationId},
                "mantle.marketing.MarketingPortalServices.get#Form"
            )
            // the terms a registration accepts: a change of the terms or of the questions' consent after publication is a new revision
            as(users.manager, E + "store#RegistrationPolicy", {
                registrationPolicyId: id,
                expectedRevision: revision(id),
                termsText: "Seats are held for 20 minutes."
            })
            as(users.manager, E + "store#RegistrationForm", {
                registrationPolicyId: id,
                expectedRevision: revision(id),
                consentText: "I accept the workshop's terms."
            })
            const termsRevision = Number(
                row("mantle.work.registration.EventRegistrationPolicy", {registrationPolicyId: id}).termsRevision
            )
            const otherSite = visitor({siteId: prefix + "_NONE", registrationPolicyId: id})
            const closed = as(users.manager, E + "close#Registration", {registrationPolicyId: id, expectedRevision: revision(id)})
            const closedView = visitor({siteId: site, registrationPolicyId: id})
            const links = rows("mantle.work.effort.WorkEffortProduct", {workEffortId: ids.webinar, productId: prefix + "_TICKET"})
            return {
                otherProduct,
                paid,
                surveyForm,
                questions,
                noGateway,
                draftView,
                stale,
                published,
                view,
                publication,
                formPage,
                termsRevision,
                otherSite,
                closed,
                closedView,
                links
            }
        },
        then({
            otherProduct,
            paid,
            surveyForm,
            questions,
            noGateway,
            draftView,
            stale,
            published,
            view,
            publication,
            formPage,
            termsRevision,
            otherSite,
            closed,
            closedView,
            links
        }) {
            code(otherProduct) == "PRODUCT_INVALID"
            code(surveyForm) == "FORM_INVALID"
            questions.refusal == "" && !!questions.formPublicationId
            publication.purposeEnumId == "FppRegistration" && publication.organizationPartyId == orgA
            publication.contextId == published.registrationPolicyId && publication.siteId == site && publication.fromDate != null
            formPage.kind == "NotFound"
            termsRevision == 2
            paid.refusal == ""
            links.length == 1 && links[0].typeEnumId == "WeptSales"
            code(noGateway) == "NOT_READY" && noGateway.refusal.includes("payment gateway")
            draftView.kind == "NotFound"
            code(stale) == "STALE_REVISION"
            published.refusal == "" && published.statusId == "ErpPublished"
            published.publicUrl == "https://mkev.example.test/marketing/Event?offer=" + published.registrationPolicyId
            view.event.title == "Spring webinar" && view.event.location == "Spec hall" && !view.event.online
            view.event.tickets.map(ticket => ticket.name + " " + ticket.priceText).join(", ") == "Standard $40.00, Guest Free"
            view.event.registrationOpen && view.event.availability == "Places available"
            Object.keys(view.event).sort().join() ==
                "availability,cancellationTerms,description,endText,location,online,organizationName,registrationOpen,registrationPolicyId,registrationText,startText,terms,tickets,timeZone,title"
            Object.keys(view.event.tickets[0]).sort().join() == "availability,name,priceText,ticketTypeId"
            otherSite.kind == "NotFound"
            closed.refusal == "" && closedView.kind == "NotFound"
        }
    }
)
