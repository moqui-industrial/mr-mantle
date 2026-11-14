// Sales' customer agreements (impl-sales P15; design-sales §7 Agreements and AgreementDetail, SAL-AGREEMENT;
// mantle.party.SalesAgreementServices): an agreement keeper drafts an agreement of A with its account and two negotiated prices,
// whose activation is refused without the customer's signer and without acceptance evidence; once active, a rep's new quote for the
// account takes the negotiated prices and the explanation names the agreement; ended, a new quote takes the general price while the
// earlier quote keeps its own; a renewal is a new draft linked to the old, ending it when activated; another organization's
// agreement is missing to A's keeper, a reader's change refused, and the expiry job expires an active one past its date.
// Standalone: SalesQuoteIssueFixtures (organizations A and B, the rep, the account and contacts, a priced product).
// Run: ./moq test mr-mantle --spec SalesAgreements
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {system, as, make, one, revision} = fx
const G = "mantle.party.SalesAgreementServices."
const Q = "mantle.order.SalesQuoteServices."
let f
const t = {}
const agreementRevision = agreementId => Number(one("mantle.party.agreement.Agreement", {agreementId}).agreementRevision ?? 1)
const status = agreementId => one("mantle.party.agreement.Agreement", {agreementId}).statusId
const lineOf = (orderId, productId) =>
    system(() => Array.from(ec.entity.find("mantle.order.OrderItem").condition({orderId, productId}).list())[0])
const num = value => (value == null ? null : Number(String(value)))
// a call as the user with artifact authorization off (its own permission checks still apply): its result, or the refusal (refused)
function asUser(username, verb, parameters) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(verb).parameters(parameters).requireNewTransaction(true).call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
// a quote of the rep for the account with a line of each product
function quote(products) {
    const orderId = as(f.users.rep, Q + "create#Quote", {
        organizationPartyId: f.orgA,
        customerPartyId: f.accounts.a,
        contactPartyId: f.contacts.mailed
    }).orderId
    for (const productId of products)
        as(f.users.rep, Q + "store#QuoteLine", {orderId, orderRevision: revision(orderId), productId, quantity: 1})
    return orderId
}

spec({
    stepwise: true,
    setupSpec() {
        f = fx.setup("SAG")
        system(() => {
            // the agreement services opened to the spec's users, as an app's root grants them
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: f.prefix + "_SERVICES",
                artifactName: "mantle\\.party\\.SalesAgreementServices\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            t.keeper = fx.addUser(f, "keeper", [f.orgA], ["SALES_VIEW", "SALES_AGREEMENT_EDIT"])
            t.keeperB = fx.addUser(f, "keeperb", [f.orgB], ["SALES_VIEW", "SALES_AGREEMENT_EDIT"])
            t.reader = fx.addUser(f, "reader", [f.orgA], ["SALES_VIEW", "SALES_TEAM_VIEW"])
            // a second product A sells at 60
            t.second = f.prefix + "_SECOND"
            make("mantle.product.Product", {productId: t.second, productName: "Second", productTypeEnumId: "PtService"})
            make("mantle.product.ProductPrice", {
                productId: t.second,
                vendorPartyId: f.orgA,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD",
                price: "60"
            })
            // B's own agreement with its account
            t.agreementB = system(() => {
                const created = ec.service
                    .sync()
                    .name("create#mantle.party.agreement.Agreement")
                    .parameters({
                        agreementTypeEnumId: "AgrSales",
                        statusId: "AgmStDraft",
                        organizationPartyId: f.orgB,
                        otherPartyId: f.accounts.b,
                        description: "B terms",
                        currencyUomId: "USD"
                    })
                    .call()
                return created.agreementId
            })
        })
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature(
    "a keeper drafts an agreement with two negotiated prices; activation needs the customer's signer and acceptance evidence",
    {
        when() {
            const created = as(t.keeper, G + "create#SalesAgreement", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a,
                description: "Account A supply terms"
            })
            t.agreement = created.agreementId
            const item = values =>
                as(
                    t.keeper,
                    G + "store#AgreementItem",
                    Object.assign({agreementId: t.agreement, agreementRevision: agreementRevision(t.agreement)}, values)
                )
            const first = item({productId: f.product, price: "80"})
            const second = item({productId: t.second, price: "45"})
            const term = as(t.keeper, G + "store#AgreementTerm", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                termTypeEnumId: "TtFinPaymentDays",
                termNumber: "30"
            })
            const stale = as(t.keeper, G + "store#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: 1,
                description: "x"
            }).refused
            const readerEdit = as(t.reader, G + "store#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                description: "Mine"
            }).refused
            // a draft's price is no price yet: a quote now takes the general price
            const draftQuote = quote([f.product])
            const noSigner = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                acceptanceEvidence: "Signed by email"
            }).refused
            const outsider = as(t.keeper, G + "store#AgreementParty", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                partyId: f.accounts.b
            }).refused
            const signer = as(t.keeper, G + "store#AgreementParty", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                partyId: f.contacts.mailed
            })
            const noEvidence = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement)
            }).refused
            const detail = as(t.keeper, G + "get#SalesAgreement", {agreementId: t.agreement})
            const activated = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                acceptanceEvidence: "Signed by Mailed Contact, PO 1234"
            })
            return {
                created,
                first,
                second,
                term,
                stale,
                readerEdit,
                draftQuote,
                noSigner,
                outsider,
                signer,
                noEvidence,
                detail,
                activated
            }
        },
        then(r) {
            r.created.refused == ""
            r.first.refused == ""
            r.second.refused == ""
            r.term.refused == ""
            r.stale.includes("REVISION_CHANGED")
            r.readerEdit.includes("PERMISSION_DENIED")
            num(lineOf(r.draftQuote, f.product).unitAmount) == 100
            r.noSigner.includes("PARTIES_REQUIRED")
            r.outsider.includes("PARTY_INVALID")
            r.signer.refused == ""
            r.noEvidence.includes("EVIDENCE_REQUIRED")
            r.detail.items.length == 2
            r.detail.activationIssues.map(issue => issue.code).includes("EVIDENCE_REQUIRED")
            r.activated.refused == ""
            status(t.agreement) == "AgmStActive"
            system(() =>
                ec.entity.find("mantle.party.agreement.AgreementContent").condition("agreementId", t.agreement).count()
            ) == 1
        }
    }
)

feature(
    "an active agreement prices a new quote and the explanation names it; ended, a new quote does not and the earlier keeps its price",
    {
        when() {
            t.agreedQuote = quote([f.product, t.second])
            const line = lineOf(t.agreedQuote, f.product)
            const explained = as(f.users.rep, Q + "explain#QuoteLinePrice", {
                orderId: t.agreedQuote,
                orderItemSeqId: line.orderItemSeqId
            })
            const listed = as(f.users.rep, G + "find#SalesAgreements", {customerPartyId: f.accounts.a})
            // the rep (no PRICE_VIEW) naming the agreement and its customer to the general price service gets no agreement price
            const crafted = asUser(f.users.rep, "mantle.product.PriceServices.get#ProductPrice", {
                productId: f.product,
                vendorPartyId: f.orgA,
                customerPartyId: f.accounts.a,
                agreementId: t.agreement,
                priceUomId: "USD"
            })
            // Products' price editor changes no customer agreement's price (it changes on the agreement)
            const agreementRow = system(
                () =>
                    Array.from(
                        ec.entity
                            .find("mantle.product.ProductPrice")
                            .condition({agreementId: t.agreement, productId: f.product})
                            .list()
                    )[0]
            )
            const editorChange = asUser("john.doe", "mantle.product.PriceServices.store#ProductPrice", {
                productPriceId: agreementRow.productPriceId,
                productId: f.product,
                price: "1",
                changeReason: "Cheaper"
            }).refused
            const byOrder = as(t.reader, G + "find#SalesAgreements", {orderId: t.agreedQuote, state: "all"})
            const noReason = as(t.keeper, G + "end#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement)
            }).refused
            const ended = as(t.keeper, G + "end#SalesAgreement", {
                agreementId: t.agreement,
                agreementRevision: agreementRevision(t.agreement),
                reason: "Customer moved to list prices"
            })
            const afterQuote = quote([f.product])
            // the quote lines priced from it, for a reader who sees the quotes (the keeper sees none of the rep's)
            const connections = as(t.reader, G + "get#SalesAgreement", {agreementId: t.agreement}).connections
            const keeperConnections = as(t.keeper, G + "get#SalesAgreement", {agreementId: t.agreement}).connections
            return {
                explained,
                listed,
                crafted,
                editorChange,
                byOrder,
                noReason,
                ended,
                afterQuote,
                connections,
                keeperConnections
            }
        },
        then(r) {
            num(lineOf(t.agreedQuote, f.product).unitAmount) == 80
            num(lineOf(t.agreedQuote, t.second).unitAmount) == 45
            r.explained.explanation.agreementId == t.agreement
            r.explained.explanation.agreementName == "Account A supply terms"
            r.listed.agreementList.map(row => row.agreementId).includes(t.agreement)
            num(r.crafted.price) != 80
            r.editorChange.includes("changes on the agreement")
            r.byOrder.agreementList.length == 1
            r.noReason.includes("REASON_REQUIRED")
            r.ended.statusId == "AgmStClosed"
            num(lineOf(r.afterQuote, f.product).unitAmount) == 100
            // the earlier quote keeps the agreement's price
            num(lineOf(t.agreedQuote, f.product).unitAmount) == 80
            r.connections.some(row => row.orderId == t.agreedQuote)
            r.keeperConnections.length == 0
        }
    }
)

feature(
    "a renewal is a new draft linked to the old one; another organization's agreement is missing; the job expires one past its date",
    {
        when() {
            // a second agreement of A, active, renewed from its end
            const second = as(t.keeper, G + "create#SalesAgreement", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a,
                description: "Service terms",
                thruDate: new Date(Date.now() + 86400000).toISOString()
            }).agreementId
            as(t.keeper, G + "store#AgreementItem", {
                agreementId: second,
                agreementRevision: agreementRevision(second),
                productId: t.second,
                price: "50"
            })
            as(t.keeper, G + "store#AgreementParty", {
                agreementId: second,
                agreementRevision: agreementRevision(second),
                partyId: f.accounts.a
            })
            const activated = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: second,
                agreementRevision: agreementRevision(second),
                acceptanceEvidence: "Accepted on the call"
            })
            // a second active agreement with the customer pricing the same product is refused
            const overlapping = as(t.keeper, G + "create#SalesAgreement", {
                organizationPartyId: f.orgA,
                customerPartyId: f.accounts.a,
                description: "Overlapping terms"
            }).agreementId
            as(t.keeper, G + "store#AgreementItem", {
                agreementId: overlapping,
                agreementRevision: agreementRevision(overlapping),
                productId: t.second,
                price: "40"
            })
            as(t.keeper, G + "store#AgreementParty", {
                agreementId: overlapping,
                agreementRevision: agreementRevision(overlapping),
                partyId: f.accounts.a
            })
            const overlap = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: overlapping,
                agreementRevision: agreementRevision(overlapping),
                acceptanceEvidence: "Accepted on the call"
            }).refused
            const read = agreementRevision(second)
            const unnamed = as(t.keeper, G + "renew#SalesAgreement", {agreementId: second}).refused
            const renewed = as(t.keeper, G + "renew#SalesAgreement", {agreementId: second, agreementRevision: read})
            const stale = as(t.keeper, G + "renew#SalesAgreement", {agreementId: second, agreementRevision: read}).refused
            const again = as(t.keeper, G + "renew#SalesAgreement", {
                agreementId: second,
                agreementRevision: agreementRevision(second)
            }).refused
            const renewal = as(t.keeper, G + "get#SalesAgreement", {agreementId: renewed.agreementId})
            // the renewal prices the same product; activated from before the predecessor's end, it ends the predecessor at its start
            const renewalActivated = as(t.keeper, G + "activate#SalesAgreement", {
                agreementId: renewed.agreementId,
                agreementRevision: agreementRevision(renewed.agreementId),
                fromDate: new Date(Date.now() + 43200000).toISOString(),
                acceptanceEvidence: "Renewal accepted"
            })
            const otherOrg = as(t.keeper, G + "get#SalesAgreement", {agreementId: t.agreementB}).agreementFound
            const otherEdit = as(t.keeper, G + "store#SalesAgreement", {
                agreementId: t.agreementB,
                agreementRevision: 1,
                description: "x"
            }).refused
            const otherFind = as(t.keeperB, G + "find#SalesAgreements", {state: "all"})
            // past its date (set directly, as time passing would), the job expires it
            system(() =>
                fx.call("update#mantle.party.agreement.Agreement", {agreementId: second, thruDate: new Date(Date.now() - 1000)})
            )
            const expired = system(() => fx.call(G + "expire#SalesAgreements", {}))
            return {
                second,
                activated,
                overlap,
                unnamed,
                renewed,
                stale,
                again,
                renewal,
                renewalActivated,
                otherOrg,
                otherEdit,
                otherFind,
                expired
            }
        },
        then(r) {
            r.activated.refused == ""
            r.overlap.includes("AGREEMENT_OVERLAP")
            r.unnamed.includes("REVISION_REQUIRED")
            r.renewed.refused == ""
            r.renewed.predecessorAgreementId == r.second
            r.stale.includes("REVISION_CHANGED")
            r.again.includes("SUCCESSOR_EXISTS")
            r.renewal.agreement.statusId == "AgmStDraft"
            r.renewal.agreement.predecessorAgreementId == r.second
            r.renewal.items.length == 1
            num(r.renewal.items[0].price) == 50
            r.renewal.parties.length == 1
            r.renewalActivated.refused == ""
            r.renewalActivated.predecessorEnded == r.second
            r.otherOrg == false
            r.otherEdit.includes("RECORD_UNAVAILABLE")
            !r.otherFind.agreementList.some(row => row.agreementId == t.agreement)
            r.otherFind.agreementList.some(row => row.agreementId == t.agreementB)
            r.expired.expiredCount >= 1
            status(r.second) == "AgmStExpired"
        }
    }
)
