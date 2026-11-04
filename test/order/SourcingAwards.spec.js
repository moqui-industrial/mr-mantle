// The comparison and award of supplier quotes (impl-purchasing P12; design-purchasing §5 QuoteComparison and Award, R-PUR-35,
// D8, F19, F35): an RFQ made from an approved purchase request line of 10 each, quoted by A (12 each at 5.00, a published
// tier of 4.50 from 10), B (a pack of 5 at 22.00, with a freight estimate), C (in a currency with no rate) and D (later
// blocked). The comparison in the demand's unit: B's pack per each first, A at its tier, C Not comparable for its rate, the
// landed cost Unknown without freight; the quote orders marked as quotes. The award: A's 5 placed with its RequirementSupply
// while D's group fails by name, the same key answering the first result, B's pack placed by a second award and the
// requirement Ordered, more than the demand refused; the awarded quote's price still publishes. The close: C and D cancelled
// as Not awarded and E (invited, never answering) cancelled, with a regret notice per recipient (D's missing address named),
// C's link revoked, the RFQ completed. An
// award under an award approval policy places nothing until its approver's decision.
// Standalone: a spec-local organization, suppliers, products, request, groups and users, and a mail template of its own with
// the mail capture on. Run: ./moq test mr-mantle --spec SourcingAwards
const prefix = "AWARD_SPEC"
const org = prefix + "_ORG",
    supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    supplierC = prefix + "_SUP_C",
    supplierD = prefix + "_SUP_D",
    supplierE = prefix + "_SUP_E",
    product = prefix + "_PRODUCT",
    pack = prefix + "_PACK",
    template = prefix + "_REGRET_EMAIL",
    purchaseRequest = prefix + "_PR",
    requirement = prefix + "_RQMT",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.order.SourcingServices."
const capture = ec.factory.getTool("MailCapture")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
let keyCount = 0
const key = () => prefix + "-" + Date.now() + "-" + keyCount++
const dayMs = 24 * 60 * 60 * 1000

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
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Award " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Award", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: org,
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
function organization(partyId, name, roleTypeId, ownerPartyId, address) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
    if (!address) return
    call("create#mantle.party.contact.ContactMech", {
        contactMechId: partyId + "_EMAIL",
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    })
    call("create#mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId: partyId + "_EMAIL",
        contactMechPurposeId: "EmailPrimary",
        fromDate: since
    })
}
function productOf(productId, name) {
    call("create#mantle.product.Product", {
        productId,
        productName: name,
        productTypeEnumId: "PtAsset",
        assetTypeEnumId: "AstTpInventory",
        amountUomId: "OTH_ea",
        ownerPartyId: org,
        statusId: "PrdActive"
    })
}
const quoteOf = (requestId, supplierPartyId) =>
    [...new Set(rows("mantle.request.RequestItemOrder", {requestId}).map(row => row.orderId))].find(
        orderId => rows("mantle.order.OrderPart", {orderId})[0].vendorPartyId === supplierPartyId
    )
const lineOf = orderId => rows("mantle.order.OrderItem", {orderId}).find(row => row.productId === product)
// a quote of the RFQ entered on the supplier's behalf: the RFQ's line priced (or left unpriced), valid two weeks
function quote(requestId, supplierPartyId, unitAmount, currencyUomId = null) {
    const stored = run(state.buyer, S + "store#SupplierQuote", {
        requestId,
        vendorPartyId: supplierPartyId,
        currencyUomId,
        validThruDate: Number(ec.user.nowTimestamp) + 14 * dayMs,
        salesChannelEnumId: "ScEmail"
    })
    const line = lineOf(stored.orderId)
    if (unitAmount != null)
        run(state.buyer, S + "store#SupplierQuoteItem", {
            orderId: stored.orderId,
            orderItemSeqId: line.orderItemSeqId,
            unitAmount
        })
    return stored.orderId
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Award Spec Org", "OrgInternal", null, "buying@award-spec.example.com")
        call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, baseCurrencyUomId: "USD"})
        organization(supplierA, "Award Spec Supplier A", "Supplier", org, "quotes@a.award-spec.example.com")
        organization(supplierB, "Award Spec Supplier B", "Supplier", org, "quotes@b.award-spec.example.com")
        organization(supplierC, "Award Spec Supplier C", "Supplier", org, "quotes@c.award-spec.example.com")
        organization(supplierD, "Award Spec Supplier D", "Supplier", org, null)
        organization(supplierE, "Award Spec Supplier E", "Supplier", org, "quotes@e.award-spec.example.com")
        productOf(product, "Award spec widget")
        productOf(pack, "Award spec widget, box of 5")
        call("create#mantle.product.ProductAssoc", {
            productId: pack,
            toProductId: product,
            productAssocTypeEnumId: "PatPackagingFor",
            fromDate: since,
            quantity: 5,
            quantityUomId: "OTH_ea"
        })
        // an approved purchase request line of 10 and its requirement
        call("create#mantle.request.Request", {
            requestId: purchaseRequest,
            requestTypeEnumId: "RqtPurchase",
            statusId: "ReqInProgress"
        })
        call("create#mantle.request.RequestParty", {
            requestId: purchaseRequest,
            partyId: org,
            roleTypeId: "OrgInternal",
            fromDate: since
        })
        call("create#mantle.request.RequestItem", {
            requestId: purchaseRequest,
            requestItemSeqId: "01",
            productId: product,
            quantity: 10,
            quantityUomId: "OTH_ea"
        })
        call("create#mantle.request.requirement.Requirement", {
            requirementId: requirement,
            requirementTypeEnumId: "RqTpProduct",
            statusId: "RqmtStApproved",
            productId: product,
            quantity: 10,
            quantityUomId: "OTH_ea"
        })
        call("create#mantle.request.requirement.RequirementRequestItem", {
            requirementId: requirement,
            requestId: purchaseRequest,
            requestItemSeqId: "01"
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
            description: "Spec regret",
            emailServerId: prefix + "_SMTP",
            fromAddress: "${fromAddress}",
            subject: "${subject}"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW", "SUPPLIER_PRICE_EDIT"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE"])
        capture.enable()

        // the RFQ from the request line, quoted by four suppliers
        const created = run(state.buyer, S + "create#QuoteRequest", {
            organizationPartyId: org,
            requestName: "Award spec widgets",
            sourceRequestItemKeys: purchaseRequest + ":01"
        })
        state.requestId = created.requestId
        state.itemSeqId = created.requestItemSeqIds[0]
        state.quoteA = quote(state.requestId, supplierA, 5)
        const tier = run(state.buyer, S + "publish#SupplierQuotePrice", {
            orderId: state.quoteA,
            orderItemSeqId: lineOf(state.quoteA).orderItemSeqId,
            minQuantity: 10,
            price: 4.5
        })
        // a published price starts a second ahead (F142); the spec's starts now
        call("update#mantle.product.ProductPrice", {productPriceId: tier.productPriceId, fromDate: ec.user.nowTimestamp})
        state.quoteB = quote(state.requestId, supplierB, null)
        state.packLine = run(state.buyer, S + "store#SupplierQuoteItem", {
            orderId: state.quoteB,
            productId: pack,
            quantity: 2,
            unitAmount: 22
        }).orderItemSeqId
        state.freight = run(state.buyer, S + "store#SupplierQuoteFreight", {orderId: state.quoteB, amount: 4})
        state.quoteC = quote(state.requestId, supplierC, 3, "NZD")
        state.quoteD = quote(state.requestId, supplierD, 4.8)
        // E invited and never answering
        state.quoteE = run(state.buyer, S + "store#QuoteInvitation", {
            requestId: state.requestId,
            supplierPartyId: supplierE
        }).orderId
    },
    cleanupSpec() {
        capture.reset()
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "The comparison in the demand's unit: the pack per each first, the tier price, a currency without a rate Not comparable",
    {
        when() {
            const compared = run(state.buyer, S + "compare#SupplierQuotes", {
                requestId: state.requestId,
                displayCurrencyUomId: "USD"
            })
            const offer = (orderId, seq) =>
                (compared.offerRows || []).find(row => row.orderId === orderId && (!seq || row.orderItemSeqId === seq)) || {}
            const csv = run(state.buyer, S + "compare#SupplierQuotes", {requestId: state.requestId, output: "csv"})
            const reader = run(state.approver, S + "compare#SupplierQuotes", {requestId: state.requestId})
            const marks = [state.quoteA, state.quoteC].map(orderId => one("mantle.order.OrderHeader", {orderId}).supplierQuote)
            return {
                compared,
                a: offer(state.quoteA),
                pack: offer(state.quoteB, state.packLine),
                c: offer(state.quoteC),
                csv,
                reader,
                marks
            }
        },
        then({compared, a, pack, c, csv, reader, marks}) {
            compared.error == ""
            compared.demandRows.length == 1
            compared.demandRows[0].comparedQuantity == "10"
            pack.kind == "pack"
            pack.normalizedPrice == "4.4"
            pack.rank == 1
            pack.freightText != "Unknown"
            a.normalizedPrice == "4.5"
            a.rank == 2
            a.basisText.includes("tier from 10")
            a.landedText == "Unknown"
            c.comparable == false
            c.reasonCode == "RATE_MISSING"
            c.rankText == "Not comparable"
            c.canSelect == true
            csv.csvText.includes("Not comparable: no exchange rate from NZD to USD")
            reader.error == ""
            marks.every(mark => mark == "Y")
        }
    }
)

feature("An award places A's group with its supply while blocked D's fails by name; the same key answers the first result", {
    when() {
        call("create#mantle.party.supplier.SupplierProfile", {
            organizationPartyId: org,
            supplierPartyId: supplierD,
            fromDate: since,
            purchaseBlockFromDate: since,
            purchaseBlockReason: "Quality hold"
        })
        const lineA = lineOf(state.quoteA).orderItemSeqId
        const lineD = lineOf(state.quoteD).orderItemSeqId
        const allocationsText = [
            state.quoteA + ":" + lineA + ":" + state.itemSeqId + ":5",
            state.quoteD + ":" + lineD + ":" + state.itemSeqId + ":5"
        ].join(";")
        const preview = run(state.buyer, S + "preview#Award", {requestId: state.requestId, allocationsText})
        const operationKey = key()
        const first = run(state.buyer, S + "commit#Award", {requestId: state.requestId, allocationsText, operationKey})
        const again = run(state.buyer, S + "commit#Award", {requestId: state.requestId, allocationsText, operationKey})
        const placedLine = lineOf(state.quoteA)
        const quantityAudit = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.order.OrderItem",
            changedFieldName: "quantity",
            pkPrimaryValue: state.quoteA
        }).find(row => String(row.changeReason || "").includes("Awarded from RFQ"))
        const supplies = rows("mantle.request.requirement.RequirementSupply", {requirementId: requirement})
        state.firstKey = operationKey
        return {preview, first, again, placedLine, quantityAudit, supplies}
    },
    then({preview, first, again, placedLine, quantityAudit, supplies}) {
        preview.groupRows.find(row => row.orderId == state.quoteD).errorCode == "SUPPLIER_BLOCKED"
        preview.groupRows.find(row => row.orderId == state.quoteA).resultStatus == "READY"
        first.error == ""
        first.placedCount == 1
        first.failedCount == 1
        first.groupRows.find(row => row.orderId == state.quoteD).errorCode == "SUPPLIER_BLOCKED"
        first.groupRows.find(row => row.orderId == state.quoteD).errorMessage.includes("Award Spec Supplier D")
        one("mantle.order.OrderHeader", {orderId: state.quoteA}).statusId == "OrderPlaced"
        one("mantle.order.OrderHeader", {orderId: state.quoteD}).statusId == "OrderProposed"
        placedLine.quantity.toNumber() == 5
        quantityAudit != null
        supplies.length == 1
        supplies[0].quantity.toNumber() == 5
        supplies[0].orderId == state.quoteA
        again.alreadyApplied == true
        again.placedCount == 1
        one("mantle.request.requirement.Requirement", {requirementId: requirement}).statusId == "RqmtStApproved"
    }
})

feature("B's pack covers the rest and the requirement is Ordered; more than the demand is refused; the awarded price publishes", {
    when() {
        const packFive = state.quoteB + ":" + state.packLine + ":" + state.itemSeqId + ":5"
        const notWhole = run(state.buyer, S + "preview#Award", {
            requestId: state.requestId,
            allocationsText: state.quoteB + ":" + state.packLine + ":" + state.itemSeqId + ":4"
        })
        const placed = run(state.buyer, S + "commit#Award", {
            requestId: state.requestId,
            allocationsText: packFive,
            operationKey: key()
        })
        const lineC = lineOf(state.quoteC).orderItemSeqId
        const over = run(state.buyer, S + "commit#Award", {
            requestId: state.requestId,
            allocationsText: state.quoteC + ":" + lineC + ":" + state.itemSeqId + ":1",
            operationKey: key()
        })
        const lines = rows("mantle.order.OrderItem", {orderId: state.quoteB})
        const published = run(state.buyer, S + "publish#SupplierQuotePrice", {
            orderId: state.quoteA,
            orderItemSeqId: lineOf(state.quoteA).orderItemSeqId,
            minQuantity: 20,
            price: 4.25
        })
        return {notWhole, placed, over, lines, published}
    },
    then({notWhole, placed, over, lines, published}) {
        notWhole.groupRows[0].errorCode == "QUANTITY_NOT_WHOLE"
        placed.placedCount == 1
        one("mantle.order.OrderHeader", {orderId: state.quoteB}).statusId == "OrderPlaced"
        lines.filter(line => line.productId).length == 1
        lines.find(line => line.productId == pack).quantity.toNumber() == 1
        lines.some(line => line.itemTypeEnumId == "ItemShipping")
        one("mantle.request.requirement.Requirement", {requirementId: requirement}).statusId == "RqmtStOrdered"
        over.groupRows[0].errorCode == "DEMAND_ALREADY_COVERED"
        published.error == ""
        published.productPriceId != null
    }
})

feature(
    "The close cancels C, D and unanswered E as Not awarded with a regret notice per recipient, revokes C's link and completes the RFQ",
    {
        when() {
            call("create#mantle.party.ExternalAccessCapability", {
                capabilityId: prefix + "_CAP_C",
                organizationPartyId: org,
                partyId: supplierC,
                recordType: "Order",
                recordId: state.quoteC,
                scopes: "QuoteResponse",
                tokenDigest: "spec",
                fromDate: since
            })
            const preview = run(state.buyer, S + "close#QuoteRequest", {requestId: state.requestId, preview: true})
            capture.clear()
            const closed = run(state.buyer, S + "close#QuoteRequest", {
                requestId: state.requestId,
                sendRegret: true,
                regretMessage: "Thank you; not this time.",
                emailTemplateId: template,
                operationKey: key()
            })
            return {
                preview,
                closed,
                mails: capture.count(),
                cancelled: [state.quoteC, state.quoteD, state.quoteE].every(
                    orderId => one("mantle.order.OrderHeader", {orderId}).statusId == "OrderCancelled"
                ),
                capability: one("mantle.party.ExternalAccessCapability", {capabilityId: prefix + "_CAP_C"})
            }
        },
        then({preview, closed, mails, cancelled, capability}) {
            preview.closingRows.length == 3
            preview.regretMessage.includes(state.requestId)
            preview.recipientRows.find(row => row.orderId == state.quoteD).resultStatus == "RECIPIENT_REQUIRED"
            closed.error == ""
            cancelled == true
            closed.recipientRows.find(row => row.orderId == state.quoteD).errorCode == "RECIPIENT_REQUIRED"
            closed.recipientRows.find(row => row.orderId == state.quoteC).resultStatus != "FAILED"
            mails == 2
            capability.revokedDate != null
            one("mantle.request.Request", {requestId: state.requestId}).statusId == "ReqCompleted"
            one("mantle.order.OrderHeader", {orderId: state.quoteA}).statusId == "OrderPlaced"
        }
    }
)

feature("Under an award approval policy the award waits for its approver, who places it", {
    when() {
        call("create#mantle.order.purchase.PurchaseApprovalPolicy", {
            purchaseApprovalPolicyId: prefix + "_AWARD_POLICY",
            organizationPartyId: org,
            sourceTypeEnumId: "PasAward",
            fromAmount: 0,
            sequenceNum: 1,
            quorum: 1,
            fromDate: since
        })
        const created = run(state.buyer, S + "create#QuoteRequest", {
            organizationPartyId: org,
            requestName: "Award spec approval"
        })
        run(state.buyer, S + "store#QuoteRequestItem", {requestId: created.requestId, productId: product, quantity: 3})
        const orderId = quote(created.requestId, supplierA, 6)
        const allocationsText = orderId + ":" + lineOf(orderId).orderItemSeqId + "::3"
        const pending = run(state.buyer, S + "commit#Award", {requestId: created.requestId, allocationsText, operationKey: key()})
        const waiting = one("mantle.order.OrderHeader", {orderId}).statusId
        const notice = rows("moqui.security.user.NotificationMessage", {
            topic: "PurchaseAwardApproval",
            recordId: created.requestId
        })
        const selfDecision = run(state.buyer, S + "decide#AwardApproval", {
            requestId: created.requestId,
            awardKey: pending.awardKey
        })
        const decided = run(state.approver, "mantle.order.PurchaseServices.approve#PurchaseSource", {
            recordEntityName: "mantle.request.Request",
            recordId: created.requestId,
            message: {awardKey: pending.awardKey, sourceRevision: pending.sourceRevision}
        })
        return {pending, waiting, notice, selfDecision, decided, placed: one("mantle.order.OrderHeader", {orderId}).statusId}
    },
    then({pending, waiting, notice, selfDecision, decided, placed}) {
        pending.error == ""
        pending.resultStatus == "PENDING_APPROVAL"
        waiting == "OrderProposed"
        notice.length == 1
        selfDecision.error.includes("PERMISSION_DENIED")
        decided.error == ""
        placed == "OrderPlaced"
    }
})
