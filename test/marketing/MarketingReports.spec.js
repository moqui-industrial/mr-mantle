// Marketing's reports (impl-marketing P20; design-marketing §11; mantle.marketing.MarketingReportServices over MarketingReports.js): a
// send's recipient and variant counts reconcile, accepted is not delivered, an untracked recipient is in no rate's denominator and an
// automated fetch is no engagement; a parent counts its child's sends once; ROI is unavailable without a cost or across currencies and
// two currencies are never summed; a partial refund reduces the net once; audience growth reconciles opening to closing with a merge
// apart; an attributed order is listed only for its reader; the visits count for Sales' funnel; the reports' and the row filter's
// scope; the campaign-sent marker.
// Standalone: spec-local organizations, users, campaigns, a send with its recipients and deliveries, events, orders and decisions.
// Run: ./moq test mr-mantle --spec MarketingReports
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, run, system, organization, user, as, campaign} = lib
const R = "mantle.marketing.MarketingReportServices."
const prefix = "MKRP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const ids = {}
const dayMs = 86400000
const ago = days => new Date(Date.now() - days * dayMs)
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")
const period = {fromDate: ago(60), thruDate: new Date(Date.now() + 3 * dayMs)}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Reports A")
            organization(orgB, "Reports B")
            for (const name of ["P1", "P2", "P3", "P4", "P5", "P6"]) {
                make("mantle.party.Party", {partyId: prefix + "_" + name, partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId: prefix + "_" + name, firstName: name})
            }
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"])
            users.analyst = user(prefix, "analyst", [orgA], ["MARKETING_REPORT_VIEW"])
            users.analystB = user(prefix, "analystB", [orgB], ["MARKETING_REPORT_VIEW"])
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            users.salesAnalyst = user(
                prefix,
                "sales",
                [orgA],
                ["MARKETING_REPORT_VIEW", "SALES_VIEW", "SALES_TEAM_VIEW", "SALES_REPORT_VIEW"]
            )
            users.salesB = user(prefix, "salesB", [orgB], ["SALES_REPORT_VIEW"])
        })
        ids.parent = campaign(users.author, orgA, {campaignName: "Year"})
        ids.child = campaign(users.author, orgA, {campaignName: "Spring", parentCampaignId: ids.parent})
        ids.priced = campaign(users.author, orgA, {campaignName: "Priced"})
        system(() => {
            run("update#mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: ids.parent, actualCost: 100})
            run("update#mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: ids.priced, actualCost: 50})
            // the child's send: an experiment of two variants, five recipients
            make("mantle.marketing.campaign.CampaignSend", {
                campaignSendId: prefix + "_SEND",
                marketingCampaignId: ids.child,
                organizationPartyId: orgA,
                sendName: "Spring news",
                channelEnumId: "MdcEmail",
                statusId: "CsCompleted",
                releasedDate: ago(5),
                preparedRevision: 1
            })
            make("mantle.marketing.campaign.CampaignExperiment", {
                campaignExperimentId: prefix + "_EXP",
                campaignSendId: prefix + "_SEND",
                organizationPartyId: orgA
            })
            for (const label of ["A", "B"])
                make("mantle.marketing.campaign.CampaignExperimentVariant", {
                    campaignExperimentVariantId: prefix + "_VAR_" + label,
                    campaignExperimentId: prefix + "_EXP",
                    variantLabel: label
                })
            // R1 accepted and delivered, tracked; R2 accepted with no receipt, untracked; R3 failed; R4 uncertain; R5 skipped
            for (const [n, variant, tracked, status, state, receipt] of [
                ["1", "A", "Y", "CrsHandedOff", "MdsSent", "MdrDelivered"],
                ["2", "B", "N", "CrsHandedOff", "MdsSent", null],
                ["3", "A", "Y", "CrsHandedOff", "MdsFailed", null],
                ["4", "B", "N", "CrsHandedOff", "MdsUncertain", null],
                ["5", "A", "Y", "CrsSkipped", null, null]
            ]) {
                const deliveryId = state ? prefix + "_DLV" + n : null
                if (deliveryId)
                    make("mantle.party.MessageDelivery", {
                        deliveryId,
                        eventKey: "CampaignSend:" + prefix + "_SEND:" + n,
                        sourceEnumId: "MdsrcCampaignSend",
                        recipientPartyId: prefix + "_P" + n,
                        channelEnumId: "MdcEmail",
                        organizationPartyId: orgA,
                        stateEnumId: state,
                        receiptEnumId: receipt,
                        createdDate: ago(5),
                        sentDate: state === "MdsSent" ? ago(5) : null
                    })
                make("mantle.marketing.campaign.CampaignRecipient", {
                    campaignRecipientId: prefix + "_R" + n,
                    campaignSendId: prefix + "_SEND",
                    preparedRevision: 1,
                    partyId: prefix + "_P" + n,
                    channelEnumId: "MdcEmail",
                    tracked,
                    executionKey: prefix + "_EXEC" + n,
                    statusId: status,
                    messageDeliveryId: deliveryId,
                    campaignExperimentVariantId: prefix + "_VAR_" + variant
                })
            }
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.child,
                organizationPartyId: orgA,
                publicCode: prefix + "L1CODE"
            })
            const event = (n, fields) =>
                make(
                    "mantle.marketing.tracking.MarketingTrackingEvent",
                    Object.assign({trackingEventId: prefix + "_EV" + n, organizationPartyId: orgA, eventDate: ago(4)}, fields)
                )
            // R1 opened and clicked (twice), a scanner fetched its link; two visits by key K1 and one without a key
            event("1", {campaignRecipientId: prefix + "_R1", campaignSendId: prefix + "_SEND", eventKindEnumId: "MteOpen"})
            event("2", {
                campaignRecipientId: prefix + "_R1",
                campaignSendId: prefix + "_SEND",
                eventKindEnumId: "MteClick",
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.child
            })
            event("3", {
                campaignRecipientId: prefix + "_R1",
                campaignSendId: prefix + "_SEND",
                eventKindEnumId: "MteClick",
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.child
            })
            event("4", {
                campaignRecipientId: prefix + "_R1",
                campaignSendId: prefix + "_SEND",
                eventKindEnumId: "MteClick",
                trackingCodeId: prefix + "_L1",
                automated: "Y"
            })
            event("5", {
                eventKindEnumId: "MteClick",
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.child,
                visitorKeyHash: "K1"
            })
            event("6", {
                eventKindEnumId: "MteVisit",
                trackingCodeId: prefix + "_L1",
                marketingCampaignId: ids.child,
                visitorKeyHash: "K1"
            })
            event("7", {eventKindEnumId: "MteVisit", trackingCodeId: prefix + "_L1", marketingCampaignId: ids.child})
            // orders: two of the child (USD and EUR), one of the priced campaign (USD, invoiced 150, 30 refunded), one unattributed
            for (const [n, currencyUomId, grandTotal, marketingCampaignId, eventId] of [
                ["1", "USD", 100, ids.child, prefix + "_EV2"],
                ["2", "EUR", 80, ids.child, null],
                ["3", "USD", 150, ids.priced, null],
                ["4", "USD", 40, null, null]
            ]) {
                const orderId = prefix + "_ORD" + n
                make("mantle.order.OrderHeader", {
                    orderId,
                    statusId: "OrderPlaced",
                    placedDate: ago(3),
                    currencyUomId,
                    grandTotal,
                    orderPurposeEnumId: "OrpSalesOrder"
                })
                make("mantle.order.OrderPart", {
                    orderId,
                    orderPartSeqId: "01",
                    vendorPartyId: orgA,
                    customerPartyId: prefix + "_P6"
                })
                make("mantle.marketing.tracking.MarketingOutcomeLink", {
                    outcomeKindEnumId: "MokOrder",
                    orderId,
                    organizationPartyId: orgA,
                    marketingCampaignId,
                    basisEnumId: marketingCampaignId ? (eventId ? "MobTrackingEvent" : "MobOpportunity") : "MobNone",
                    trackingEventId: eventId,
                    placedDate: ago(3),
                    decidedDate: ago(3)
                })
            }
            make("mantle.order.OrderItemBilling", {
                orderItemBillingId: prefix + "_BILL",
                orderId: prefix + "_ORD3",
                quantity: 1,
                amount: 150
            })
            make("mantle.order.return.ReturnHeader", {
                returnId: prefix + "_RET",
                statusId: "ReturnCompleted",
                vendorPartyId: orgA
            })
            make("mantle.order.return.ReturnItem", {
                returnId: prefix + "_RET",
                returnItemSeqId: "01",
                orderId: prefix + "_ORD3",
                statusId: "ReturnCompleted",
                returnQuantity: 1,
                returnPrice: 30
            })
            // a list: P1 granted before the period's start, P3 granted before and withdrawn in it, P2 granted in it, P4 carried in by a
            // merge, P5 pending
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_LIST",
                contactListName: "Newsletter",
                ownerPartyId: orgA,
                contactListTypeEnumId: "NEWSLETTER"
            })
            const consent = (partyConsentId, partyId, statusId, days, comments) =>
                make("mantle.party.PartyConsent", {
                    partyConsentId,
                    partyId,
                    contactListId: prefix + "_LIST",
                    purposeEnumId: "PcpMarketingEmail",
                    statusId,
                    consentDate: ago(days),
                    comments,
                    sourceEnumId: "PcsForm"
                })
            consent(prefix + "_C1", prefix + "_P1", "PconGranted", 90)
            consent(prefix + "_C3", prefix + "_P3", "PconGranted", 90)
            consent(prefix + "_C3W", prefix + "_P3", "PconWithdrawn", 5, "Too many emails")
            consent(prefix + "_C2", prefix + "_P2", "PconGranted", 10)
            consent(prefix + "_C4", prefix + "_P4", "PconGranted", 10)
            make("mantle.marketing.contact.SubscriptionRequest", {
                subscriptionRequestId: prefix + "_SRM",
                contactListId: prefix + "_LIST",
                partyId: prefix + "_P4",
                requestKindEnumId: "SrkMerge",
                statusEnumId: "SrsAccepted",
                partyConsentId: prefix + "_C4",
                requestedDate: ago(10)
            })
            make("mantle.marketing.contact.SubscriptionRequest", {
                subscriptionRequestId: prefix + "_SRP",
                contactListId: prefix + "_LIST",
                partyId: prefix + "_P5",
                requestKindEnumId: "SrkPublic",
                statusEnumId: "SrsPending",
                requestedDate: ago(2),
                expireDate: new Date(Date.now() + 5 * dayMs)
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "a send's recipient and variant counts reconcile; accepted is not delivered; untracked and automated stay out of the rates",
    {
        when() {
            const out = as(
                users.analyst,
                R + "get#DeliveryAnalysis",
                Object.assign({organizationPartyId: orgA, campaignSendId: prefix + "_SEND"}, period)
            )
            const send = (out.sendRows || [])[0] || {}
            const variants = out.variantRows || []
            const sum = field => variants.reduce((total, variant) => total + variant[field], 0)
            return {
                out,
                send,
                variants,
                sums: {
                    preparedCount: sum("preparedCount"),
                    acceptedCount: sum("acceptedCount"),
                    failedCount: sum("failedCount"),
                    uncertainCount: sum("uncertainCount")
                }
            }
        },
        then({out, send, variants, sums}) {
            out.refusal == ""
            send.preparedCount == 5 && send.attemptedCount == 4 && send.skippedCount == 1
            send.acceptedCount == 2 && send.deliveredCount == 1 && send.failedCount == 1 && send.uncertainCount == 1
            // delivered over accepted, with the receipt coverage: one receipt of two accepted
            send.deliveryRate == 50 && send.receiptCoverage == 50
            // the untracked accepted recipient is in no denominator: one tracked accepted recipient opened and clicked once
            send.trackedAcceptedCount == 1 && send.openCount == 1 && send.clickCount == 1
            send.openRate == 100 && send.clickRate == 100
            send.automatedCount == 1
            // the conversion: the order attributed to R1's own click
            send.conversionCount == 1
            variants.length == 2
            sums.preparedCount == send.preparedCount && sums.acceptedCount == send.acceptedCount
            sums.failedCount == send.failedCount && sums.uncertainCount == send.uncertainCount
            out.totals.acceptedCount == 2
        }
    }
)

feature(
    "a parent counts its child once; ROI only with a cost and one currency; two currencies never summed; a refund reduces the net once",
    {
        when() {
            const out = as(
                users.analyst,
                R + "get#CampaignPerformance",
                Object.assign({organizationPartyId: orgA, includeChildren: "true"}, period)
            )
            const rowOf = id => (out.campaignRows || []).find(found => found.marketingCampaignId == id) || {}
            return {out, parent: rowOf(ids.parent), child: rowOf(ids.child), priced: rowOf(ids.priced)}
        },
        then({out, parent, child, priced}) {
            out.refusal == ""
            parent.includedCount == 2
            parent.acceptedCount == child.acceptedCount && child.acceptedCount == 2
            parent.reachCount == 2
            parent.orderCount == child.orderCount && child.orderCount == 2
            // visits: K1's click and visit once, each event without a key (R1's two clicks, a visit); the scanner's fetch none
            child.visitCount == 4
            // two currencies, two amounts: never one total
            child.amounts.length == 2
            child.orderValueText.includes(";")
            // the child has no cost; the parent's cost is in dollars but its revenue in two currencies
            child.roiPercent == null && child.roiText == "No actual cost"
            parent.roiPercent == null && parent.roiText == "Revenue in another currency than the cost"
            // 150 invoiced, 30 refunded: a net of 120 against a cost of 50
            priced.amounts[0].net == 120
            priced.roiPercent == 140
        }
    }
)

feature("attribution: each order once by campaign, unattributed apart; an order's row only for its reader", {
    when() {
        const analyst = as(users.analyst, R + "get#Attribution", Object.assign({organizationPartyId: orgA}, period))
        const sales = as(users.salesAnalyst, R + "get#Attribution", Object.assign({organizationPartyId: orgA}, period))
        return {analyst, sales}
    },
    then({analyst, sales}) {
        analyst.refusal == ""
        analyst.orderCount == 4 && analyst.unattributedCount == 1
        analyst.summaryRows.find(found => found.marketingCampaignId == ids.child).orderCount == 2
        analyst.summaryRows.find(found => found.marketingCampaignId == null).orderCount == 1
        // the analyst reads no order: counted, never named
        analyst.outcomeRows.length == 0 && analyst.hiddenCount == 4
        // a Sales reader of the organization's orders sees each row
        sales.outcomeRows.length == 4 && sales.hiddenCount == 0
    }
})

feature("audience growth reconciles opening to closing, a merge apart; the reasons people leave", {
    when() {
        return as(users.analyst, R + "get#AudienceGrowth", {
            organizationPartyId: orgA,
            contactListId: prefix + "_LIST",
            fromDate: ago(30),
            thruDate: new Date(Date.now() + dayMs)
        })
    },
    then(out) {
        out.refusal == ""
        const list = out.listRows[0]
        list.openingCount == 2 && list.grantCount == 1 && list.mergedCount == 1 && list.withdrawalCount == 1
        list.closingCount == list.openingCount + list.grantCount + list.mergedCount - list.withdrawalCount
        list.pendingCount == 1
        out.reasonRows[0].reason == "Too many emails" && out.reasonRows[0].sharePercent == 100
        out.reachCount == 3
    }
})

feature(
    "scope: another organization and a reader without the report permission refused; visits for Sales' funnel; the row filter",
    {
        when() {
            const r = {}
            r.otherOrganization = as(
                users.analystB,
                R + "get#CampaignPerformance",
                Object.assign({organizationPartyId: orgA}, period)
            )
            r.otherCampaign = as(
                users.analystB,
                R + "get#CampaignPerformance",
                Object.assign({marketingCampaignId: ids.child}, period)
            )
            r.reader = as(users.reader, R + "get#DeliveryAnalysis", Object.assign({organizationPartyId: orgA}, period))
            r.salesVisits = as(users.salesAnalyst, R + "count#SalesVisits", Object.assign({organizationPartyId: orgA}, period))
            r.salesCampaign = as(
                users.salesAnalyst,
                R + "count#SalesVisits",
                Object.assign({organizationPartyId: orgA, marketingCampaignId: ids.priced}, period)
            )
            r.salesB = as(users.salesB, R + "count#SalesVisits", Object.assign({organizationPartyId: orgA}, period))
            r.filter = as(users.analyst, R + "get#ReportRowFilter", {
                userId: users.analyst,
                datasetId: "boss-marketing-deliveries"
            })
            r.readerFilter = as(users.reader, R + "get#ReportRowFilter", {userId: users.reader})
            r.catalog = as(users.analyst, R + "get#ReportCatalog", {appRoot: "Marketing"})
            r.catalogElsewhere = as(users.analyst, R + "get#ReportCatalog", {appRoot: "Sales"})
            return r
        },
        then(r) {
            code(r.otherOrganization) == "ORGANIZATION_DENIED"
            code(r.otherCampaign) == "RECORD_UNAVAILABLE"
            code(r.reader) == "PERMISSION_DENIED"
            // R1's two clicks name no key: each counts; K1's click and visit once; the unkeyed visit
            r.salesVisits.refusal == "" && r.salesVisits.visitCount == 4
            r.salesCampaign.visitCount == 0
            code(r.salesB) == "ORGANIZATION_DENIED"
            JSON.stringify(r.filter.filter).includes(orgA)
            !JSON.stringify(r.filter.filter).includes(orgB)
            JSON.stringify(r.readerFilter.filter).includes("match_all")
            r.catalog.reports.length == 4
            code(r.catalogElsewhere) == "REPORTS_UNAVAILABLE"
        }
    }
)

feature("a released send is one campaign-sent marker of its organization; an unreleased one none", {
    when() {
        system(() =>
            make("mantle.marketing.campaign.CampaignSend", {
                campaignSendId: prefix + "_DRAFT",
                marketingCampaignId: ids.child,
                organizationPartyId: orgA,
                sendName: "Draft",
                statusId: "CsDraft"
            })
        )
        const record = recordId =>
            system(() => run("mantle.party.BusinessEventServices.record#BusinessEvent", {event: "CampaignSent", recordId}))
        return {released: record(prefix + "_SEND"), draft: record(prefix + "_DRAFT")}
    },
    then({released, draft}) {
        released.recorded == true
        released.annotationId.startsWith("business-")
        draft.recorded == false
    }
})

feature("the reporting job keeps each campaign's accepted sends and qualified leads with their time", {
    when() {
        system(() =>
            make("mantle.sales.opportunity.SalesOpportunity", {
                salesOpportunityId: prefix + "_OPP",
                organizationPartyId: orgA,
                marketingCampaignId: ids.child,
                convertedDate: ago(2),
                createdDate: ago(8)
            })
        )
        const out = system(() => run(R + "run#MarketingAggregation", {}))
        const child = row("mantle.marketing.campaign.MarketingCampaign", {marketingCampaignId: ids.child})
        const performance = as(
            users.analyst,
            R + "get#CampaignPerformance",
            Object.assign({marketingCampaignId: ids.child}, period)
        )
        return {out, child, performance: (performance.campaignRows || [])[0] || {}}
    },
    then({out, child, performance}) {
        out.failedCount == 0 && out.summarizedCount >= 3
        child.numSent == 2 && child.qualifiedLeadCount == 1 && child.summaryDate != null
        performance.numSent == 2 && performance.qualifiedLeadCount == 1
    }
})
