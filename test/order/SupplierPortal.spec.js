// Purchasing's supplier pages (impl-purchasing P16; design-purchasing §13, CX-PORTALS, F32): mantle.order.SupplierPortalServices
// as the PASS Supplier app calls them. A buyer (PURCHASE_ORDER_EDIT) issues a quote's QuoteResponse link and a purchase
// order's OrderAcknowledgement link and invites a supplier contact; a revoked, expired, forged or another site's token
// shows nothing; the supplier reads its quote with no competitor, internal request, source line or private file; a draft
// is private, the submit proposes the quote with the supplier's prices and a repeat answers the first receipt; an
// acknowledgement of the current revision records the promise and changes no quantity, a link of an earlier revision
// answers SupersededRevision; a signed-in contact lists only its supplier's documents; a cancel revokes the links.
// Standalone: a spec-local organization, suppliers, product, buyer, contact and published site.
const prefix = "SUP_PORTAL_SPEC"
const org = prefix + "_ORG",
    supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    product = prefix + "_PRODUCT",
    siteId = prefix + "_SITE",
    otherSiteId = prefix + "_OTHER_SITE",
    otherOrg = prefix + "_OTHER_ORG",
    since = "2000-01-01T00:00:00Z"
const P = "mantle.order.SupplierPortalServices.",
    S = "mantle.order.SourcingServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
let keyCount = 0
const key = () => "spspec" + Date.now() + "x" + keyCount++

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const services = {
    getSupplierHome: "get#SupplierHome",
    getQuoteInvitation: "get#QuoteInvitation",
    saveQuoteResponse: "save#QuoteResponse",
    submitQuoteResponse: "submit#QuoteResponse",
    getPublishedPurchaseOrder: "get#PublishedPurchaseOrder",
    acknowledgePurchaseOrder: "acknowledge#PurchaseOrder"
}
// a page's operation as PASS calls it, as no one signed in (or as the given user): its result, or the error kind a page shows
function page(name, input, username = null) {
    if (username) login(username)
    else logout()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(P + services[name])
            .parameters({input: Object.assign({siteId}, input)})
            .requireNewTransaction(true)
            .call().result
    } catch (error) {
        ec.message.clearErrors()
        return {errorKind: error.moquiErrorKind || "Error", errorMessage: String(error.message)}
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Supplier portal " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Portal", lastName: kind})
    if (organizationPartyId)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: id,
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function publicSite(id, target, hostname) {
    call("create#mantle.public.PublicSite", {
        siteId: id,
        name: id,
        state: "published",
        registrationMode: "invitation",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    call("create#mantle.public.PublicSiteParty", {
        siteId: id,
        partyId: ec.user.userAccount.partyId,
        state: "active",
        role: "owner",
        revision: 1
    })
    call("mantle.public.SiteServices.store#Mounts", {
        input: {
            siteId: id,
            expectedRevision: 1,
            mounts: [
                {app: "account", pathPrefix: "/account"},
                {app: "supplier", pathPrefix: "/supplier", targetId: target}
            ],
            hosts: [{hostname, canonical: true}]
        }
    })
}
// a sent purchase order from a supplier, revision 1, with one line of 10 at 5.00 needed by Dec 1
function purchaseOrder(orderId, supplierPartyId) {
    call("create#mantle.order.OrderHeader", {
        orderId,
        orderName: "Portal spec order",
        statusId: "OrderSent",
        currencyUomId: "USD",
        grandTotal: 50,
        placedDate: ec.user.nowTimestamp,
        orderRevision: 1
    })
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: supplierPartyId,
        customerPartyId: org,
        statusId: "OrderSent",
        partTotal: 50
    })
    call("create#mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemInventory",
        productId: product,
        quantity: 10,
        unitAmount: 5,
        requiredByDate: "2026-12-01T00:00:00Z"
    })
    // the line's create counted a revision: the order as sent is revision 1
    call("update#mantle.order.OrderHeader", {orderId, orderRevision: 1})
}
// a capability row with a known token, as the fixtures of the PASS specs make them
function capability(recordType, recordId, scopes, token, partyId, extra = {}) {
    call(
        "create#mantle.party.ExternalAccessCapability",
        Object.assign(
            {
                organizationPartyId: org,
                partyId,
                recordType,
                recordId,
                scopes,
                tokenDigest: ec.user.singleUseCodeHash(token),
                fromDate: ec.user.nowTimestamp,
                thruDate: new Date(Date.now() + 30 * 86400000),
                createdByUserId: ec.user.userId
            },
            extra
        )
    )
}
const token = name => (prefix + "_" + name + "_" + "0".repeat(48)).slice(0, 48)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Portal Spec Buyer", "OrgInternal")
        organization(otherOrg, "Portal Spec Other Buyer", "OrgInternal")
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        organization(supplierA, "Portal Spec Supplier A", "Supplier", org)
        organization(supplierB, "Portal Spec Competitor B", "Supplier", org)
        call("create#mantle.product.Product", {
            productId: product,
            productName: "Portal spec bracket",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        publicSite(siteId, org, "suppliers.portal-spec.example.test")
        publicSite(otherSiteId, otherOrg, "suppliers.portal-spec-other.example.test")
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT"])
        state.reader = user("READER", ["PURCHASE_APPROVE"])
        state.contact = user("CONTACT", [], null)
        // an RFQ of the buyer with one item, and two suppliers invited
        const created = run(state.buyer, S + "create#QuoteRequest", {
            organizationPartyId: org,
            requestName: "Brackets for line 4",
            responseRequiredDate: new Date(Date.now() + 7 * 86400000)
        })
        state.requestId = created.requestId
        run(state.buyer, S + "store#QuoteRequestItem", {requestId: state.requestId, productId: product, quantity: 100})
        state.quoteA = run(state.buyer, S + "store#QuoteInvitation", {
            requestId: state.requestId,
            supplierPartyId: supplierA
        }).orderId
        state.quoteB = run(state.buyer, S + "store#QuoteInvitation", {
            requestId: state.requestId,
            supplierPartyId: supplierB
        }).orderId
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        purchaseOrder(prefix + "_PO", supplierA)
        purchaseOrder(prefix + "_PO_B", supplierB)
        capability("Quote", state.quoteA, "QuoteResponse", token("QUOTE_A"), supplierA)
        capability("Quote", state.quoteA, "QuoteResponse", token("QUOTE_EXPIRED"), supplierA, {
            fromDate: new Date(Date.now() - 10 * 86400000),
            thruDate: new Date(Date.now() - 86400000)
        })
        capability("Quote", state.quoteA, "QuoteResponse", token("QUOTE_REVOKED"), supplierA, {revokedDate: ec.user.nowTimestamp})
        capability("Order", prefix + "_PO", "OrderAcknowledgement,BillUpload", token("PO_R1"), supplierA, {recordRevision: 1})
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("A buyer issues a quote's and an order's link and invites a supplier contact; a reader and another site are refused", {
    when() {
        login(state.buyer)
        ec.artifactExecution.disableAuthz()
        const portal = ec.resource.script("component://mr-mantle/service/mantle/order/SupplierPortal.js")
        const quoteUrl = portal.quoteLink(state.quoteB)
        const orderUrl = portal.orderLink(prefix + "_PO_B", 1)
        login("john.doe")
        const reader = run(state.reader, "mantle.party.ExternalAccessServices.create#AccessCapability", {
            recordType: "Quote",
            recordId: state.quoteA,
            scopes: "QuoteResponse"
        })
        const invited = run(state.buyer, "mantle.party.ExternalAccessServices.invite#Contact", {
            organizationPartyId: org,
            app: "supplier",
            partyId: supplierA,
            emailAddress: "contact@supplier-a.portal-spec.example.test"
        })
        const latest = rows("mantle.party.ExternalAccessCapability", {recordType: "Order", recordId: prefix + "_PO_B"})
        const otherSite = page("getQuoteInvitation", {siteId: otherSiteId, token: token("QUOTE_A")})
        return {quoteUrl, orderUrl, reader, invited, latest, otherSite}
    },
    then({quoteUrl, orderUrl, reader, invited, latest, otherSite}) {
        quoteUrl.startsWith("https://suppliers.portal-spec.example.test/supplier/QuoteResponse?token=")
        orderUrl.startsWith("https://suppliers.portal-spec.example.test/supplier/OrderAcknowledgement?token=")
        latest.length === 1
        latest[0].recordRevision == 1
        latest[0].scopes.includes("BillUpload")
        reader.error.includes("PERMISSION_DENIED")
        invited.error === ""
        invited.invitationUrl.includes("/account/Invitation?token=")
        otherSite.errorKind === "NotFound"
    }
})

feature("A revoked, expired or forged token, or none, shows nothing about the supplier or the quote", {
    when() {
        return {
            revoked: page("getQuoteInvitation", {token: token("QUOTE_REVOKED")}),
            expired: page("getQuoteInvitation", {token: token("QUOTE_EXPIRED")}),
            forged: page("getQuoteInvitation", {token: "f".repeat(48)}),
            home: page("getSupplierHome", {token: "f".repeat(48)}),
            noToken: page("getSupplierHome", {}),
            byId: page("getQuoteInvitation", {orderId: state.quoteA}),
            orderAsQuote: page("getQuoteInvitation", {token: token("PO_R1")})
        }
    },
    then({revoked, expired, forged, home, noToken, byId, orderAsQuote}) {
        revoked.errorKind === "NotFound"
        expired.errorKind === "NotFound"
        forged.errorKind === "NotFound"
        home.errorKind === "NotFound"
        !forged.errorMessage.includes("Supplier A")
        !forged.errorMessage.includes(state.quoteA)
        noToken.errorKind === "AuthenticationRequired"
        byId.errorKind === "NotFound"
        orderAsQuote.errorKind === "NotFound"
    }
})

feature("The supplier reads its quote with no competitor, internal request or source line; a draft stays private", {
    when() {
        const view = page("getQuoteInvitation", {token: token("QUOTE_A")})
        const seq = view.lines?.[0]?.orderItemSeqId
        const saved = page("saveQuoteResponse", {
            token: token("QUOTE_A"),
            rfqRevision: view.quote?.revision,
            otherPartyOrderId: "QA-77",
            lines: JSON.stringify([{orderItemSeqId: seq, unitAmount: "4.25", promisedDate: "2026-12-10"}])
        })
        const again = page("getQuoteInvitation", {token: token("QUOTE_A")})
        const line = one("mantle.order.OrderItem", {orderId: state.quoteA, orderItemSeqId: seq})
        return {view, saved, again, line, status: one("mantle.order.OrderHeader", {orderId: state.quoteA}).statusId}
    },
    then({view, saved, again, line, status}) {
        view.quote.orderId === state.quoteA
        view.quote.requestId === state.requestId
        view.quote.buyerName === "Portal Spec Buyer"
        view.lines.length === 1
        view.lines[0].quantityText === "100"
        view.capabilities.canSubmit === true
        const text = JSON.stringify(view)
        !text.includes("Competitor B")
        !text.includes(supplierB)
        !text.includes(state.quoteB)
        !text.includes("requestItemSeqId")
        !text.includes("unitListPrice")
        saved.saved === true
        again.draft != null
        again.quote.otherPartyOrderId === "QA-77"
        again.lines[0].unitAmount === "4.25"
        toDecimal(line.unitAmount ?? 0).compare(0) === 0
        status === "OrderRequested"
    }
})

feature(
    "Submitting proposes the quote with the supplier's prices for the buyer, and a repeated submit answers the first receipt",
    {
        when() {
            const view = page("getQuoteInvitation", {token: token("QUOTE_A")})
            const lines = JSON.stringify(
                view.lines.map(line => ({orderItemSeqId: line.orderItemSeqId, unitAmount: "4.25", otherPartyProductId: "BRK-4"}))
            )
            const unconfirmed = page("submitQuoteResponse", {
                token: token("QUOTE_A"),
                operationId: key(),
                rfqRevision: view.quote.revision,
                lines
            })
            const first = page("submitQuoteResponse", {
                token: token("QUOTE_A"),
                operationId: key(),
                rfqRevision: view.quote.revision,
                confirm: "true",
                otherPartyOrderId: "QA-77",
                validThruDate: "2027-03-01",
                lines
            })
            const repeat = page("submitQuoteResponse", {
                token: token("QUOTE_A"),
                operationId: key(),
                rfqRevision: view.quote.revision,
                confirm: "true",
                lines: JSON.stringify(view.lines.map(line => ({orderItemSeqId: line.orderItemSeqId, unitAmount: "1.00"})))
            })
            const after = page("getQuoteInvitation", {token: token("QUOTE_A")})
            const order = one("mantle.order.OrderHeader", {orderId: state.quoteA})
            const part = rows("mantle.order.OrderPart", {orderId: state.quoteA})[0]
            const item = rows("mantle.order.OrderItem", {orderId: state.quoteA})[0]
            const notices = rows("moqui.security.user.NotificationMessage", {topic: "PurchaseSupplierResponse"}).filter(row =>
                String(row.messageJson).includes(state.quoteA)
            )
            const prices = rows("mantle.product.ProductPrice", {productId: product, vendorPartyId: supplierA})
            return {
                unconfirmed,
                first,
                repeat,
                after,
                order,
                part,
                item,
                notices,
                prices,
                drafts: rows("mantle.order.SupplierPortalResponse", {orderId: state.quoteA, state: "draft"})
            }
        },
        then({unconfirmed, first, repeat, after, order, part, item, notices, prices, drafts}) {
            unconfirmed.errorKind === "Unprocessable"
            first.alreadyApplied === false
            first.receipt.kind === "QuoteResponse"
            first.receipt.reference === "QA-77"
            order.statusId === "OrderProposed"
            order.salesChannelEnumId === "ScWeb"
            part.otherPartyOrderId === "QA-77"
            toDecimal(item.unitAmount).compare(toDecimal("4.25")) === 0
            item.otherPartyProductId === "BRK-4"
            repeat.alreadyApplied === true
            repeat.receipt.responseId === first.receipt.responseId
            after.receipt.responseId === first.receipt.responseId
            after.capabilities.canSubmit === false
            notices.length === 1
            prices.length === 0
            drafts.length === 0
        }
    }
)

feature(
    "Acknowledging the order records the promise and changes no quantity; an earlier revision's link answers SupersededRevision",
    {
        when() {
            const view = page("getPublishedPurchaseOrder", {token: token("PO_R1")})
            const changed = page("acknowledgePurchaseOrder", {
                token: token("PO_R1"),
                operationId: key(),
                orderRevision: 1,
                outcome: "change",
                lines: JSON.stringify([{orderItemSeqId: "01", promisedDate: "2026-12-15", promisedQuantity: "8"}])
            })
            const first = page("acknowledgePurchaseOrder", {
                token: token("PO_R1"),
                operationId: key(),
                orderRevision: 1,
                outcome: "change",
                note: "Two weeks later, eight in the first lot",
                otherPartyOrderId: "SO-551",
                lines: JSON.stringify([{orderItemSeqId: "01", promisedDate: "2026-12-15", promisedQuantity: "8"}])
            })
            const repeat = page("acknowledgePurchaseOrder", {
                token: token("PO_R1"),
                operationId: key(),
                orderRevision: 1,
                outcome: "accept"
            })
            const item = one("mantle.order.OrderItem", {orderId: prefix + "_PO", orderItemSeqId: "01"})
            const part = one("mantle.order.OrderPart", {orderId: prefix + "_PO", orderPartSeqId: "01"})
            // the buyer revises the order: the revision 1 link now says so, and its acknowledgement is refused
            call("update#mantle.order.OrderHeader", {orderId: prefix + "_PO", orderRevision: 2})
            const superseded = page("getPublishedPurchaseOrder", {token: token("PO_R1")})
            const supersededHome = page("getSupplierHome", {token: token("PO_R1")})
            const late = page("acknowledgePurchaseOrder", {
                token: token("PO_R1"),
                operationId: key(),
                orderRevision: 1,
                outcome: "accept"
            })
            const bill = ec.resource
                .script("component://mr-mantle/service/mantle/party/ExternalAccess.js")
                .check({token: token("PO_R1"), scope: "BillUpload", recordType: "Order", organizationPartyId: org})
            return {view, changed, first, repeat, item, part, superseded, supersededHome, late, bill}
        },
        then({view, changed, first, repeat, item, part, superseded, supersededHome, late, bill}) {
            view.order.revision === 1
            view.order.buyerName === "Portal Spec Buyer"
            view.lines[0].quantityText === "10"
            view.capabilities.canAcknowledge === true
            changed.errorKind === "Unprocessable"
            first.receipt.outcomeText === "Accepted with changes"
            repeat.alreadyApplied === true
            repeat.receipt.responseId === first.receipt.responseId
            toDecimal(item.quantity).compare(10) === 0
            toDecimal(item.promisedQuantity).compare(8) === 0
            item.promisedDate != null
            part.acknowledgementEnumId === "PakChanged"
            part.acknowledgedRevision == 1
            part.otherPartyOrderId === "SO-551"
            superseded.superseded.code === "SupersededRevision"
            superseded.order == null
            supersededHome.documentList[0].stateText === "Revised"
            supersededHome.documentList[0].reference.endsWith("revision 1")
            supersededHome.documentList[0].dueText == null
            late.errorKind === "Conflict"
            late.errorMessage.includes("SupersededRevision")
            bill.recordId === prefix + "_PO"
        }
    }
)

feature("A signed-in contact sees only its supplier's documents; a cancel revokes the order's links", {
    when() {
        call("create#mantle.party.ExternalAccessContact", {
            partyId: state.contact,
            outsidePartyId: supplierA,
            organizationPartyId: org,
            app: "supplier",
            fromDate: since
        })
        // a quote of supplier A on an RFQ not sent yet is the buyer's draft: the contact does not see it
        const draftRfq = run(state.buyer, S + "create#QuoteRequest", {
            organizationPartyId: org,
            requestName: "Brackets not sent yet",
            responseRequiredDate: new Date(Date.now() + 7 * 86400000)
        }).requestId
        run(state.buyer, S + "store#QuoteRequestItem", {requestId: draftRfq, productId: product, quantity: 5})
        const unsentId = run(state.buyer, S + "store#QuoteInvitation", {requestId: draftRfq, supplierPartyId: supplierA}).orderId
        const unsent = page("getQuoteInvitation", {orderId: unsentId}, state.contact)
        const home = page("getSupplierHome", {}, state.contact)
        const own = page("getPublishedPurchaseOrder", {orderId: prefix + "_PO"}, state.contact)
        const competitor = page("getPublishedPurchaseOrder", {orderId: prefix + "_PO_B"}, state.contact)
        const competitorQuote = page("getQuoteInvitation", {orderId: state.quoteB}, state.contact)
        capability("Order", prefix + "_PO", "OrderAcknowledgement,BillUpload", token("PO_R2"), supplierA, {recordRevision: 2})
        call("update#mantle.order.OrderHeader", {orderId: prefix + "_PO", statusId: "OrderCancelled"})
        const live = rows("mantle.party.ExternalAccessCapability", {recordType: "Order", recordId: prefix + "_PO"}).filter(
            row => !row.revokedDate
        )
        const cancelled = page("getPublishedPurchaseOrder", {token: token("PO_R2")})
        return {home, own, competitor, competitorQuote, live, cancelled, unsent, unsentId}
    },
    then({home, own, competitor, competitorQuote, live, cancelled, unsent, unsentId}) {
        unsentId != null
        unsent.errorKind === "NotFound"
        !home.documentList.some(doc => doc.orderId === unsentId)
        home.via === "contact"
        home.documentList.some(doc => doc.orderId === prefix + "_PO")
        home.documentList.some(doc => doc.orderId === state.quoteA)
        !home.documentList.some(doc => doc.orderId === prefix + "_PO_B" || doc.orderId === state.quoteB)
        !JSON.stringify(home).includes("Competitor B")
        own.order.orderId === prefix + "_PO"
        competitor.errorKind === "NotFound"
        competitorQuote.errorKind === "NotFound"
        live.length === 0
        cancelled.errorKind === "NotFound"
    }
})
