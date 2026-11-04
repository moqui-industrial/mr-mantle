// Requests for quotation and supplier quotes (impl-purchasing P11; design-purchasing §5, R-PUR-13, R-PUR-21, F19, F41): an
// RFQ of the organization with its items, three suppliers invited as three requested quotes with a line per item, the
// stopped supplier refused, another organization's buyer and a reader refused; the send storing the published PDF as the
// RFQ's content, the supplier with a bad address InvitationDeliveryFailed by name while the other two are sent, the RFQ
// Submitted, the same key answering the first result; a material change after it moving the revision, the requested quotes
// following it, a new send going only to the suppliers not sent the new revision and the earlier RFQ printing as of its
// send time; a supplier's answer entered with its channel, evidence, validity and prices moving the quote to OrderProposed,
// a price change in the line's history, an unsolicited quote entered straight in OrderProposed; the price publish making a
// supplier price with the quote's dates and source and ending the tier's earlier row, a buyer refused for want of
// SUPPLIER_PRICE_EDIT and an expired quote refused; and the RFQ type's policy (never triaged, never converted to a project).
// Standalone: a spec-local organization, suppliers with their addresses, a product, groups and users, and a mail server and
// template of the spec's own with the mail capture on. Run: ./moq test mr-mantle --spec Sourcing
const prefix = "SOURCING_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    supplierBad = prefix + "_SUP_BAD",
    supplierBlocked = prefix + "_SUP_BLOCKED",
    product = prefix + "_PRODUCT",
    template = prefix + "_RFQ_EMAIL",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.order.SourcingServices.",
    R = "mantle.request.RequestServices."
const capture = ec.factory.getTool("MailCapture")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
let keyCount = 0
const key = () => prefix + "-" + Date.now() + "-" + keyCount++

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
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Sourcing " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Sourcing", lastName: kind})
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
function email(partyId, address, purpose) {
    const contactMechId = partyId + "_" + purpose
    call("create#mantle.party.contact.ContactMech", {
        contactMechId,
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    })
    call("create#mantle.party.contact.PartyContactMech", {partyId, contactMechId, contactMechPurposeId: purpose, fromDate: since})
}
const quotesOf = requestId => [...new Set(rows("mantle.request.RequestItemOrder", {requestId}).map(row => row.orderId))].sort()
const statusOf = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
const supplierOf = orderId => rows("mantle.order.OrderPart", {orderId})[0].vendorPartyId
// an RFQ of the buyer with one item of the product, quantity 10
function rfqWithItem(name) {
    const created = run(state.buyer, S + "create#QuoteRequest", {organizationPartyId: org, requestName: name})
    run(state.buyer, S + "store#QuoteRequestItem", {requestId: created.requestId, productId: product, quantity: 10})
    return created.requestId
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Sourcing Spec Org", "OrgInternal")
        organization(otherOrg, "Sourcing Spec Other Org", "OrgInternal")
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        email(org, "buying@sourcing-spec.example.com", "EmailPrimary")
        organization(supplierA, "Sourcing Spec Supplier A", "Supplier", org)
        organization(supplierB, "Sourcing Spec Supplier B", "Supplier", org)
        organization(supplierBad, "Sourcing Spec Supplier Bad", "Supplier", org)
        organization(supplierBlocked, "Sourcing Spec Supplier Blocked", "Supplier", org)
        email(supplierA, "quotes@a.sourcing-spec.example.com", "EmailOrder")
        email(supplierB, "sales@b.sourcing-spec.example.com", "EmailPrimary")
        email(supplierBad, "not-an-address", "EmailOrder")
        call("create#mantle.party.supplier.SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: supplierBlocked,
            fromDate: since,
            purchaseBlockFromDate: since,
            purchaseBlockReason: "Quality hold"
        })
        call("create#mantle.product.Product", {
            productId: product,
            productName: "Sourcing spec widget",
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        // the supplier's price in effect for the organization, which a published quote price ends
        call("create#mantle.product.ProductPrice", {
            productPriceId: prefix + "_PRICE_A",
            productId: product,
            vendorPartyId: supplierA,
            customerPartyId: org,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 0,
            price: 12,
            priceUomId: "USD"
        })
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailTemplate", {
            emailTemplateId: template,
            description: "Spec RFQ",
            emailServerId: prefix + "_SMTP",
            fromAddress: "${fromAddress}",
            subject: "${subject}"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.priceEditor = user("PRICE_EDITOR", ["SUPPLIER_PRICE_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.reader = user("READER", ["PURCHASE_APPROVE"])
        state.otherBuyer = user("OTHER_BUYER", ["PURCHASE_ORDER_EDIT"], otherOrg)
        capture.enable()
    },
    cleanupSpec() {
        capture.reset()
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "An RFQ goes to three suppliers as three requested quotes; the stopped supplier, a reader and another organization are refused",
    {
        when() {
            const requestId = rfqWithItem("Spec widgets")
            state.requestId = requestId
            const second = run(state.buyer, S + "store#QuoteRequestItem", {
                requestId,
                description: "Mounting kit",
                quantity: 2
            })
            const invited = [supplierA, supplierB, supplierBad].map(supplierPartyId =>
                run(state.buyer, S + "store#QuoteInvitation", {requestId, supplierPartyId})
            )
            const again = run(state.buyer, S + "store#QuoteInvitation", {requestId, supplierPartyId: supplierA})
            const blocked = run(state.buyer, S + "store#QuoteInvitation", {requestId, supplierPartyId: supplierBlocked})
            const reader = run(state.reader, S + "store#QuoteInvitation", {requestId, supplierPartyId: supplierB})
            const other = run(state.otherBuyer, S + "store#QuoteRequestItem", {requestId, productId: product, quantity: 1})
            const quotes = quotesOf(requestId)
            const lines = quotes.map(orderId => rows("mantle.order.OrderItem", {orderId}).length)
            return {
                second,
                invited,
                again,
                blocked,
                reader,
                other,
                quotes,
                lines,
                rfq: one("mantle.request.Request", {requestId})
            }
        },
        then({second, invited, again, blocked, reader, other, quotes, lines, rfq}) {
            second.error == ""
            invited.every(row => row.error == "" && row.statusId == "OrderRequested")
            quotes.length == 3
            quotes.every(orderId => statusOf(orderId) == "OrderRequested")
            lines.every(count => count == 2)
            again.existing == true
            again.orderId == invited[0].orderId
            blocked.error.includes("SUPPLIER_BLOCKED")
            reader.error.includes("PERMISSION_DENIED")
            other.error.includes("RECORD_UNAVAILABLE")
            rfq.requestTypeEnumId == "RqtPurchaseRfq"
            rfq.statusId == "ReqDraft"
        }
    }
)

feature(
    "The send publishes the PDF on the RFQ and mails two suppliers; the bad address is named; a retry answers the first result",
    {
        when() {
            capture.clear()
            state.sendKey = key()
            const sent = run(state.buyer, S + "send#QuoteRequest", {
                requestId: state.requestId,
                operationKey: state.sendKey,
                emailTemplateId: template
            })
            const mails = capture.count()
            const replay = run(state.buyer, S + "send#QuoteRequest", {
                requestId: state.requestId,
                operationKey: state.sendKey,
                emailTemplateId: template
            })
            const published = rows("mantle.request.RequestContent", {
                requestId: state.requestId,
                contentTypeEnumId: "RqCntRfqPublished"
            })
            state.firstSendAt = Number(ec.user.nowTimestamp)
            return {
                sent,
                mails,
                replay,
                published,
                mailsAfter: capture.count(),
                status: one("mantle.request.Request", {requestId: state.requestId}).statusId
            }
        },
        then({sent, mails, replay, published, mailsAfter, status}) {
            sent.error == ""
            sent.sentCount == 2
            sent.failedCount == 1
            sent.supplierResults.find(row => row.supplierPartyId == supplierBad).resultStatus == "InvitationDeliveryFailed"
            sent.supplierResults.find(row => row.supplierPartyId == supplierBad).errorCode == "RECIPIENT_INVALID"
            sent.supplierResults.filter(row => row.resultStatus == "SENT").length == 2
            mails == 2
            replay.alreadyApplied == true
            mailsAfter == 2
            published.length == 1
            published[0].contentLocation.endsWith(".pdf")
            status == "ReqSubmitted"
        }
    }
)

feature("A material change after the send moves the revision; the requested quotes follow; a new send; the earlier print", {
    when() {
        const item = rows("mantle.request.RequestItem", {requestId: state.requestId}).find(row => row.productId == product)
        const before = run(state.buyer, S + "get#QuoteRequestPrint", {requestId: state.requestId}).revision
        const changed = run(state.buyer, S + "store#QuoteRequestItem", {
            requestId: state.requestId,
            requestItemSeqId: item.requestItemSeqId,
            quantity: 25,
            changeReason: "Season demand"
        })
        const quoteLine = rows("mantle.request.RequestItemOrder", {
            requestId: state.requestId,
            requestItemSeqId: item.requestItemSeqId
        }).map(link => one("mantle.order.OrderItem", {orderId: link.orderId, orderItemSeqId: link.orderItemSeqId}))
        capture.clear()
        const resent = run(state.buyer, S + "send#QuoteRequest", {
            requestId: state.requestId,
            operationKey: key(),
            emailTemplateId: template
        })
        const earlier = run(state.buyer, S + "get#QuoteRequestPrint", {requestId: state.requestId, asOfDate: state.firstSendAt})
        const now = run(state.buyer, S + "get#QuoteRequestPrint", {requestId: state.requestId})
        const published = rows("mantle.request.RequestContent", {
            requestId: state.requestId,
            contentTypeEnumId: "RqCntRfqPublished"
        })
        return {before, changed, quoteLine, resent, mails: capture.count(), earlier, now, published}
    },
    then({before, changed, quoteLine, resent, mails, earlier, now, published}) {
        changed.error == ""
        changed.sourceRevision > before
        quoteLine.every(line => String(line.quantity) == "25")
        resent.error == ""
        resent.supplierResults.length == 3
        resent.sentCount == 2
        mails == 2
        earlier.printHtml.includes(">10 ")
        !earlier.printHtml.includes(">25 ")
        now.printHtml.includes(">25 ")
        published.length == 2
    }
})

feature(
    "A buyer enters a supplier's answer with channel, evidence, validity and prices; a price change is in the line's history",
    {
        when() {
            const quoteA = quotesOf(state.requestId).find(orderId => supplierOf(orderId) == supplierA)
            state.quoteA = quoteA
            const lines = rows("mantle.order.OrderItem", {orderId: quoteA}).filter(line => line.productId == product)
            state.quoteLine = lines[0].orderItemSeqId
            const priced = run(state.buyer, S + "store#SupplierQuoteItem", {
                orderId: quoteA,
                orderItemSeqId: state.quoteLine,
                unitAmount: 9.5
            })
            const now = Number(ec.user.nowTimestamp)
            const answered = run(state.buyer, S + "store#SupplierQuote", {
                orderId: quoteA,
                otherPartyOrderId: "Q-A-77",
                validFromDate: now - 1000,
                validThruDate: now + 30 * 86400000,
                salesChannelEnumId: "ScEmail",
                evidenceText: "Emailed quote Q-A-77"
            })
            const repriced = run(state.buyer, S + "store#SupplierQuoteItem", {
                orderId: quoteA,
                orderItemSeqId: state.quoteLine,
                unitAmount: 9.25,
                changeReason: "Volume discount"
            })
            const history = rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.order.OrderItem",
                changedFieldName: "unitAmount",
                pkPrimaryValue: quoteA,
                pkSecondaryValue: state.quoteLine
            })
            const unsolicited = run(state.buyer, S + "store#SupplierQuote", {
                organizationPartyId: org,
                vendorPartyId: supplierB,
                salesChannelEnumId: "ScPhone",
                evidenceText: "Phone call"
            })
            const badChannel = run(state.buyer, S + "store#SupplierQuote", {orderId: quoteA, salesChannelEnumId: "PtyPerson"})
            return {
                priced,
                answered,
                repriced,
                history,
                unsolicited,
                badChannel,
                header: one("mantle.order.OrderHeader", {orderId: quoteA}),
                part: rows("mantle.order.OrderPart", {orderId: quoteA})[0],
                evidence: rows("mantle.order.OrderContent", {orderId: quoteA, orderContentTypeEnumId: "OctSupplierQuote"})
            }
        },
        then({priced, answered, repriced, history, unsolicited, badChannel, header, part, evidence}) {
            priced.error == ""
            answered.error == ""
            answered.statusId == "OrderProposed"
            header.salesChannelEnumId == "ScEmail"
            part.otherPartyOrderId == "Q-A-77"
            part.validThruDate != null
            evidence.length == 1
            repriced.error == ""
            history.some(row => row.newValueText && Number(row.newValueText) == 9.25 && row.changeReason == "Volume discount")
            unsolicited.error == ""
            unsolicited.statusId == "OrderProposed"
            statusOf(unsolicited.orderId) == "OrderProposed"
            badChannel.error.includes("CHANNEL_INVALID")
        }
    }
)

feature(
    "Publishing a quoted price makes the supplier price with its dates and source; a buyer is refused; an expired quote is refused",
    {
        when() {
            const buyer = run(state.buyer, S + "publish#SupplierQuotePrice", {
                orderId: state.quoteA,
                orderItemSeqId: state.quoteLine
            })
            const published = run(state.priceEditor, S + "publish#SupplierQuotePrice", {
                orderId: state.quoteA,
                orderItemSeqId: state.quoteLine
            })
            const price = published.productPriceId
                ? one("mantle.product.ProductPrice", {productPriceId: published.productPriceId})
                : null
            const earlier = one("mantle.product.ProductPrice", {productPriceId: prefix + "_PRICE_A"})
            // the quote expires: its validity ended a moment ago
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            const part = rows("mantle.order.OrderPart", {orderId: state.quoteA})[0]
            call("update#mantle.order.OrderPart", {
                orderId: state.quoteA,
                orderPartSeqId: part.orderPartSeqId,
                validThruDate: Number(ec.user.nowTimestamp) - 1000
            })
            const expired = run(state.priceEditor, S + "publish#SupplierQuotePrice", {
                orderId: state.quoteA,
                orderItemSeqId: state.quoteLine,
                minQuantity: 100
            })
            return {buyer, published, price, earlier, expired, quoteValidThru: part.validThruDate}
        },
        then({buyer, published, price, earlier, expired, quoteValidThru}) {
            buyer.error.includes("PERMISSION_DENIED")
            published.error == ""
            price.vendorPartyId == supplierA
            price.customerPartyId == org
            String(price.price).startsWith("9.25")
            price.sourceOrderId == state.quoteA
            price.sourceOrderItemSeqId == state.quoteLine
            Number(price.thruDate) == Number(quoteValidThru)
            Number(earlier.thruDate) == Number(price.fromDate)
            published.endedPriceIds.includes(prefix + "_PRICE_A")
            expired.error.includes("QUOTE_EXPIRED")
        }
    }
)

feature("The RFQ type is never triaged or converted to a project", {
    when() {
        const types = call(R + "get#IntakeSettings", {organizationPartyId: org}).settings?.triagedTypes || []
        // refused before the project is looked at
        const converted = run("john.doe", R + "convert#RequestToProject", {requestId: state.requestId, workEffortId: "NONE"})
        return {types, converted, rfq: one("mantle.request.Request", {requestId: state.requestId})}
    },
    then({types, converted, rfq}) {
        !types.includes("RqtPurchaseRfq")
        converted.error.includes("REQUEST_TYPE_FIXED")
        rfq.rootWorkEffortId == null
    }
})
