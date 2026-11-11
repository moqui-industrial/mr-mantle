// Purchase agreements (impl-purchasing P13; design-purchasing §7 Agreements and AgreementDetail, F10): a buyer's blanket
// agreement with its item's quantity and value caps, tolerance and price, approved through decide#PurchaseApproval with the
// agreement as source (the activation, the approved revision and its PDF as AgreementContent; a template refused); releases at
// the agreement's price within the caps, one over the remaining value refused beyond the tolerance and one within it passing, a
// cancelled line giving its quantity back; a changed cap counted as a revision that takes no release until approved (its
// history and print as of a time are acceptance's PurchaseAgreementWalk); a released line raised past its release, the
// agreement's price changed through store#ProductPrice, an item without the agreement's price and an expired agreement
// refused.
// Standalone: a spec-local organization, supplier, product, buyer and approver, with artifact authorization disabled (the
// rules are the services' own permission checks).
// Run: ./moq test mr-mantle --spec PurchaseAgreements
const prefix = "PUR_AGR_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    supplier = prefix + "_SUPPLIER",
    product = prefix + "_PRODUCT",
    since = "2000-01-01T00:00:00Z"
const A = "mantle.party.AgreementServices.",
    P = "mantle.order.PurchaseServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const now = () => Number(ec.user.nowTimestamp)
const state = {}

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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase agreement " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Agreement", lastName: kind})
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
// an approved blanket agreement of 100 units capped at 1,000.00 with a 10% tolerance, at 8.00 a unit
function approvedAgreement(extra = {}, itemExtra = {}) {
    const created = run(
        state.buyer,
        A + "store#PurchaseAgreement",
        Object.assign({organizationPartyId: org, otherPartyId: supplier, currencyUomId: "USD", fromDate: since}, extra)
    )
    const item = run(
        state.buyer,
        A + "store#AgreementItem",
        Object.assign(
            {
                agreementId: created.agreementId,
                productId: product,
                quantity: 100,
                amountCap: 1000,
                releaseTolerancePercent: 10,
                price: 8
            },
            itemExtra
        )
    )
    const decided = run(state.approver, P + "decide#PurchaseApproval", {agreementId: created.agreementId})
    return {agreementId: created.agreementId, agreementItemSeqId: item.agreementItemSeqId, created, item, decided}
}
const agreementOf = agreementId => one("mantle.party.agreement.Agreement", {agreementId})
// wait for the clock to move on, so a change after a time is after it
function tick() {
    const start = now()
    while (now() <= start + 2) {}
    return now()
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Purchase Agreement Spec Org", "OrgInternal")
        organization(otherOrg, "Purchase Agreement Spec Other Org", "OrgInternal")
        organization(supplier, "Agreement Spec Supplier", "Supplier", org)
        call("create#mantle.product.Product", {
            productId: product,
            productName: product,
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        // the supplier's own price, which the agreement's price takes over for its releases
        call("create#mantle.product.ProductPrice", {
            productId: product,
            vendorPartyId: supplier,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 1,
            price: 9.5,
            priceUomId: "USD"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE", "SUPPLIER_PRICE_VIEW"])
        state.reader = user("READER", ["SUPPLIER_PRICE_VIEW"])
        state.other = user("OTHER", ["PURCHASE_ORDER_EDIT", "PURCHASE_APPROVE"], otherOrg)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a buyer stores a blanket agreement; a non-holder and another organization are refused; an approver activates it and its PDF is stored; a template is neither approved nor released",
    {
        when() {
            const refused = run(state.reader, A + "store#PurchaseAgreement", {organizationPartyId: org, otherPartyId: supplier})
            const otherOrganization = run(state.other, A + "store#PurchaseAgreement", {
                organizationPartyId: org,
                otherPartyId: supplier
            })
            const made = approvedAgreement({description: "Blanket for widgets"})
            const otherDecides = run(state.other, P + "decide#PurchaseApproval", {agreementId: made.agreementId})
            const template = run(state.buyer, A + "store#PurchaseAgreement", {
                organizationPartyId: org,
                otherPartyId: supplier,
                currencyUomId: "USD",
                isTemplate: "Y"
            })
            run(state.buyer, A + "store#AgreementItem", {agreementId: template.agreementId, productId: product, price: 7})
            const templateDecided = run(state.approver, P + "decide#PurchaseApproval", {agreementId: template.agreementId})
            const templateRelease = run(state.buyer, A + "release#PurchaseAgreement", {
                agreementId: template.agreementId,
                agreementItemSeqId: "01",
                quantity: 1
            })
            const fromTemplate = run(state.buyer, A + "store#PurchaseAgreement", {
                organizationPartyId: org,
                templateAgreementId: template.agreementId,
                fromDate: since
            })
            const balance = run(state.buyer, A + "get#ReleaseBalance", {agreementId: template.agreementId})
            return {
                refused,
                otherOrganization,
                made,
                otherDecides,
                agreement: agreementOf(made.agreementId),
                contents: rows("mantle.party.agreement.AgreementContent", {agreementId: made.agreementId}),
                templateDecided,
                templateRelease,
                copiedItems: rows("mantle.party.agreement.AgreementItem", {agreementId: fromTemplate.agreementId}),
                copiedPrices: rows("mantle.product.ProductPrice", {agreementId: fromTemplate.agreementId}),
                copy: agreementOf(fromTemplate.agreementId),
                balance
            }
        },
        then(r) {
            r.refused.error.includes("PERMISSION_DENIED")
            r.otherOrganization.error.includes("RECORD_UNAVAILABLE")
            r.made.created.error == ""
            r.made.item.error == ""
            r.otherDecides.error.includes("RECORD_UNAVAILABLE")
            r.made.decided.error == ""
            r.made.decided.statusId == "AgmStActive"
            r.agreement.agreementTypeEnumId == "AgrPurchase"
            Number(r.agreement.approvedRevision) == Number(r.agreement.agreementRevision)
            r.contents.length == 1
            r.contents[0].contentTypeEnumId == "AcntApprovedVersion"
            r.templateDecided.error.includes("TEMPLATE_NO_APPROVAL")
            r.templateRelease.error.includes("TEMPLATE_NO_RELEASE")
            r.copy.statusId == "AgmStDraft"
            r.copy.isTemplate == "N"
            r.copiedItems.length == 1
            r.copiedPrices.length == 1
            r.balance.balance.template == true
            r.balance.balance.itemBalances.length == 0
        }
    }
)

feature(
    "releases make draft purchase order lines at the agreement's price; one over the remaining value is refused, one within the tolerance passes, and a cancelled line gives its quantity back",
    {
        when() {
            // the value cap (600.00, 75 units) is the tighter one; with 10% it allows 660.00
            const made = approvedAgreement({}, {amountCap: 600})
            const release = quantity =>
                run(state.buyer, A + "release#PurchaseAgreement", {
                    agreementId: made.agreementId,
                    agreementItemSeqId: made.agreementItemSeqId,
                    quantity
                })
            const first = release(60)
            const second = release(5)
            const over = release(30)
            const withinTolerance = release(15)
            const line = one("mantle.order.OrderItem", {orderId: first.orderId, orderItemSeqId: first.orderItemSeqId})
            // the second order's line cancelled: what it released is given back
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: second.orderId,
                orderItemSeqId: second.orderItemSeqId,
                quantityCancelled: 5
            })
            const balance = run(state.buyer, A + "get#ReleaseBalance", {agreementId: made.agreementId}).balance
            const reader = run(state.reader, A + "get#ReleaseBalance", {agreementId: made.agreementId})
            return {first, second, over, withinTolerance, line, balance, reader}
        },
        then(r) {
            r.first.error == ""
            r.first.unitAmount == 8
            r.first.amount == 480
            r.line.unitAmount == 8
            r.line.isModifiedPrice == "N"
            one("mantle.order.OrderHeader", {orderId: r.first.orderId}).statusId == "OrderOpen"
            r.second.error == ""
            r.over.error.includes("RELEASE_OVER_VALUE")
            r.withinTolerance.error == ""
            r.withinTolerance.overCap == true
            r.balance.releaseRows.length == 3
            r.balance.itemBalances[0].releasedQuantity == 75
            r.balance.itemBalances[0].remainingQuantity == 25
            r.reader.error.includes("PERMISSION_DENIED")
        }
    }
)

feature(
    "a changed cap counts the revision and takes no release until its approval; a released line takes no more than its release; the agreement's price changes only on the agreement; an item without it and an expired agreement take no release",
    {
        when() {
            const made = approvedAgreement()
            const released = run(state.buyer, A + "release#PurchaseAgreement", {
                agreementId: made.agreementId,
                agreementItemSeqId: made.agreementItemSeqId,
                quantity: 10
            })
            // the released draft line raised past its release, or priced above it (P13 review)
            const raised = run(state.buyer, P + "store#PurchaseOrderItem", {
                orderId: released.orderId,
                orderItemSeqId: released.orderItemSeqId,
                quantity: 500
            })
            const repriced = run(state.buyer, P + "store#PurchaseOrderItem", {
                orderId: released.orderId,
                orderItemSeqId: released.orderItemSeqId,
                unitAmount: 20
            })
            const lowered = run(state.buyer, P + "store#PurchaseOrderItem", {
                orderId: released.orderId,
                orderItemSeqId: released.orderItemSeqId,
                quantity: 8
            })
            // the agreement's price row through the general price service
            const priceRow = rows("mantle.product.ProductPrice", {agreementId: made.agreementId})[0]
            const generalEdit = run("john.doe", "mantle.product.PriceServices.store#ProductPrice", {
                productPriceId: priceRow.productPriceId,
                productId: product,
                price: 1,
                changeReason: "Cheaper"
            })
            const changed = run(state.buyer, A + "store#AgreementItem", {
                agreementId: made.agreementId,
                agreementItemSeqId: made.agreementItemSeqId,
                amountCap: 1500,
                changeReason: "Volume renegotiated"
            })
            const pendingRelease = run(state.buyer, A + "release#PurchaseAgreement", {
                agreementId: made.agreementId,
                agreementItemSeqId: made.agreementItemSeqId,
                quantity: 1
            })
            const notices = rows("moqui.security.user.NotificationMessage", {
                topic: "PurchaseOrderApproval",
                recordId: made.agreementId
            })
            const stale = run(state.approver, P + "decide#PurchaseApproval", {
                agreementId: made.agreementId,
                agreementRevision: made.decided.agreementRevision
            })
            // an item without the agreement's price is not released at the supplier's own price
            const unpriced = approvedAgreement({}, {price: null})
            const unpricedRelease = run(state.buyer, A + "release#PurchaseAgreement", {
                agreementId: unpriced.agreementId,
                agreementItemSeqId: unpriced.agreementItemSeqId,
                quantity: 1
            })
            // ended yesterday: no release; its order stays
            const ended = run(state.buyer, A + "store#PurchaseAgreement", {agreementId: made.agreementId, thruDate: now() - 1000})
            const expiredRelease = run(state.buyer, A + "release#PurchaseAgreement", {
                agreementId: made.agreementId,
                agreementItemSeqId: made.agreementItemSeqId,
                quantity: 1
            })
            return {
                made,
                released,
                raised,
                repriced,
                lowered,
                generalEdit,
                changed,
                pendingRelease,
                notices,
                stale,
                unpriced,
                unpricedRelease,
                ended,
                expiredRelease,
                order: one("mantle.order.OrderHeader", {orderId: released.orderId})
            }
        },
        then(r) {
            r.released.error == ""
            r.raised.error.includes("RELEASE_LINE_OVER")
            r.repriced.error.includes("RELEASE_LINE_OVER")
            r.lowered.error == ""
            r.generalEdit.error.includes("changes on the agreement")
            r.changed.error == ""
            r.changed.revised == true
            r.changed.agreementRevision == r.made.decided.agreementRevision + 1
            r.pendingRelease.error.includes("AGREEMENT_CHANGE_PENDING")
            r.notices.length >= 1
            // the agreement's own wording, taken from the message by name (a title is expanded as a script when sent)
            r.notices.every(notice => String(notice.titleText).startsWith("Approve purchase agreement " + r.made.agreementId))
            r.stale.error.includes("STALE_REVISION")
            r.unpriced.decided.error == ""
            r.unpricedRelease.error.includes("PRICE_UNAVAILABLE")
            r.ended.error == ""
            r.expiredRelease.error.includes("AGREEMENT_EXPIRED")
            r.order.statusId == "OrderOpen"
        }
    }
)
