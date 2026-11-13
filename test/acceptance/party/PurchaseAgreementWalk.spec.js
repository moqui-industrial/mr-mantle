// Purchasing P13's "usable when" (impl-purchasing P13; design-purchasing §7 Agreements and AgreementDetail), Mantle only: a
// blanket agreement for 100 units with a value cap is approved, its PDF stored, and releases two purchase orders; a third over
// the cap is refused and one within the tolerance passes; two releases at once cannot exceed the cap together; a changed cap
// shows in the agreement's audit history and its print as of the approval shows the old cap; an expired agreement takes no
// new release and its orders stay; a template has no balance; and the price resolver (PriceExplain's) chooses the agreement's
// price for its release and the supplier's own price otherwise. Standalone: a spec-local organization, supplier, product and
// users. Run: ./moq accept mr-mantle --spec PurchaseAgreementWalk
const prefix = "PUR_AGR_WALK"
const org = prefix + "_ORG",
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
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Agreement walk " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Agreement", lastName: kind})
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
function organization(partyId, name, roleTypeId, ownerPartyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: ownerPartyId || null})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// an approved blanket agreement for 100 units at 10.00 a unit, its value capped at the cap given, with the tolerance given
function approvedAgreement(amountCap, releaseTolerancePercent) {
    const created = run(state.buyer, A + "store#PurchaseAgreement", {
        organizationPartyId: org,
        otherPartyId: supplier,
        currencyUomId: "USD",
        fromDate: since,
        description: "Blanket walk"
    })
    const item = run(state.buyer, A + "store#AgreementItem", {
        agreementId: created.agreementId,
        productId: product,
        quantity: 100,
        amountCap,
        releaseTolerancePercent,
        price: 10
    })
    const submitted = run(state.buyer, A + "submit#PurchaseAgreement", {agreementId: created.agreementId})
    const decided = run(state.approver, P + "decide#PurchaseApproval", {agreementId: created.agreementId})
    return {agreementId: created.agreementId, agreementItemSeqId: item.agreementItemSeqId, created, item, submitted, decided}
}
const release = (made, quantity) =>
    run(state.buyer, A + "release#PurchaseAgreement", {
        agreementId: made.agreementId,
        agreementItemSeqId: made.agreementItemSeqId,
        quantity
    })
function tick() {
    const start = now()
    while (now() <= start + 2) {}
    return now()
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(org, "Agreement Walk Org", "OrgInternal")
        organization(supplier, "Agreement Walk Supplier", "Supplier", org)
        call("create#mantle.product.Product", {
            productId: product,
            productName: product,
            productTypeEnumId: "PtAsset",
            assetTypeEnumId: "AstTpInventory",
            amountUomId: "OTH_ea",
            ownerPartyId: org,
            statusId: "PrdActive"
        })
        call("create#mantle.product.ProductPrice", {
            productId: product,
            vendorPartyId: supplier,
            pricePurposeEnumId: "PppPurchase",
            priceTypeEnumId: "PptCurrent",
            fromDate: since,
            minQuantity: 1,
            price: 12,
            priceUomId: "USD"
        })
        state.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PRICE_VIEW"])
        state.approver = user("APPROVER", ["PURCHASE_APPROVE", "PURCHASE_ORDER_APPROVE", "SUPPLIER_PRICE_VIEW"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a blanket agreement for 100 units and a value cap is approved, its PDF stored, and releases two purchase orders; a third over the cap is refused, and one within the tolerance passes",
    {
        when() {
            // 900.00 for 100 units at 10.00: the value cap is the tighter one; 5% allows 945.00
            const made = approvedAgreement(900, 5)
            const first = release(made, 40)
            const second = release(made, 40)
            const third = release(made, 15)
            const withinTolerance = release(made, 14)
            return {
                made,
                first,
                second,
                third,
                withinTolerance,
                pdf: rows("mantle.party.agreement.AgreementContent", {agreementId: made.agreementId}),
                balance: run(state.buyer, A + "get#ReleaseBalance", {agreementId: made.agreementId}).balance
            }
        },
        then(r) {
            r.made.submitted.error == ""
            r.made.submitted.notifiedCount >= 1
            r.made.decided.error == ""
            r.made.decided.statusId == "AgmStActive"
            r.pdf.length == 1
            r.pdf[0].contentTypeEnumId == "AcntApprovedVersion"
            r.first.error == ""
            r.second.error == ""
            r.first.orderId != r.second.orderId
            r.first.unitAmount == 10
            r.third.error.includes("RELEASE_OVER_VALUE")
            r.withinTolerance.error == ""
            r.withinTolerance.overCap == true
            r.balance.itemBalances[0].releasedAmount == 940
            r.balance.releaseRows.length == 3
        }
    }
)

feature("two releases at once cannot exceed the cap together", {
    when() {
        const made = approvedAgreement(null, null)
        const args = {
            buyer: state.buyer,
            request: {agreementId: made.agreementId, agreementItemSeqId: made.agreementItemSeqId, quantity: 60}
        }
        const results = parallel(
            2,
            (thread, args) => {
                login(args.buyer)
                ec.artifactExecution.disableAuthz()
                try {
                    return {result: call("mantle.party.AgreementServices.release#PurchaseAgreement", args.request)}
                } catch (error) {
                    ec.message.clearErrors()
                    return {error: String(error.message || error)}
                }
            },
            args,
            {transaction: false, timeout: 30}
        )
        return {results, releases: rows("mantle.party.agreement.AgreementRelease", {agreementId: made.agreementId})}
    },
    then({results, releases}) {
        results.filter(row => row.result).length == 1
        results.filter(row => row.error && row.error.includes("RELEASE_OVER_QUANTITY")).length == 1
        releases.length == 1
    }
})

feature(
    "a changed cap shows in the agreement's history, and its print as of the approval shows the old cap; an expired agreement takes no new release and its orders stay",
    {
        when() {
            const made = approvedAgreement(700, null)
            const released = release(made, 10)
            const approvedAt = tick()
            tick()
            const changed = run(state.buyer, A + "store#AgreementItem", {
                agreementId: made.agreementId,
                agreementItemSeqId: made.agreementItemSeqId,
                amountCap: 950,
                changeReason: "Second season added"
            })
            const reapproved = run(state.approver, P + "decide#PurchaseApproval", {agreementId: made.agreementId})
            const history = ec.resource
                .script("component://mr-mantle/service/mantle/party/PurchaseAgreements.js")
                .historyOf(made.agreementId)
            const asOfApproval = run(state.buyer, A + "get#PurchaseAgreementPrint", {
                agreementId: made.agreementId,
                asOfDate: approvedAt
            })
            const current = run(state.buyer, A + "get#PurchaseAgreementPrint", {agreementId: made.agreementId})
            run(state.buyer, A + "store#PurchaseAgreement", {agreementId: made.agreementId, thruDate: now() - 1000})
            const expiredRelease = release(made, 1)
            run("john.doe", A + "expire#PurchaseAgreements", {})
            return {
                changed,
                reapproved,
                history,
                asOfApproval,
                current,
                expiredRelease,
                agreement: one("mantle.party.agreement.Agreement", {agreementId: made.agreementId}),
                order: one("mantle.order.OrderHeader", {orderId: released.orderId}),
                line: one("mantle.order.OrderItem", {orderId: released.orderId, orderItemSeqId: released.orderItemSeqId})
            }
        },
        then(r) {
            r.changed.error == ""
            r.reapproved.error == ""
            r.history.some(
                row =>
                    row.fieldText == "Value cap" &&
                    row.fromText == "$700.00" &&
                    row.toText == "$950.00" &&
                    row.reason == "Second season added"
            )
            r.asOfApproval.printHtml.includes("$700.00")
            !r.asOfApproval.printHtml.includes("$950.00")
            r.current.printHtml.includes("$950.00")
            r.expiredRelease.error.includes("AGREEMENT_EXPIRED")
            r.agreement.statusId == "AgmStExpired"
            r.order.statusId == "OrderOpen"
            r.line.quantity == 10
        }
    }
)

feature("a template has no balance, and the price resolver chooses the agreement's price for its release", {
    when() {
        const template = run(state.buyer, A + "store#PurchaseAgreement", {
            organizationPartyId: org,
            otherPartyId: supplier,
            currencyUomId: "USD",
            isTemplate: "Y"
        })
        run(state.buyer, A + "store#AgreementItem", {
            agreementId: template.agreementId,
            productId: product,
            quantity: 50,
            price: 9
        })
        const templateBalance = run(state.buyer, A + "get#ReleaseBalance", {agreementId: template.agreementId}).balance
        const made = approvedAgreement(null, null)
        const priceOf = agreement =>
            run(state.buyer, "mantle.product.PriceServices.get#ProductPrice", {
                productId: product,
                quantity: 5,
                vendorPartyId: supplier,
                customerPartyId: org,
                organizationPartyId: org,
                pricePurposeEnumId: "PppPurchase",
                priceUomId: "USD",
                direction: "purchase",
                agreementId: agreement ? made.agreementId : null,
                agreementItemSeqId: agreement ? made.agreementItemSeqId : null,
                explain: true
            })
        const withAgreement = priceOf(true)
        const without = priceOf(false)
        return {
            templateBalance,
            withAgreement,
            without,
            agreementRow: one("mantle.product.ProductPrice", {productPriceId: withAgreement.productPriceId})
        }
    },
    then(r) {
        r.templateBalance.template == true
        r.templateBalance.releasable == false
        r.templateBalance.itemBalances.length == 0
        r.withAgreement.price == 10
        r.agreementRow.agreementId != null
        r.without.price == 12
    }
})
