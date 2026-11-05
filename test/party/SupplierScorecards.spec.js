// Supplier performance (impl-purchasing P15, §4): the dated scorecard policy, criteria and response rules under
// PURCHASE_POLICY_EDIT; an evaluation under SUPPLIER_SCORECARD_EDIT scoring on-time delivery from each line's first
// acknowledged date, else its required date, quality from rejected quantities and inspection dispositions, price variance
// from billed against ordered prices; a supplier under five eligible receipts is Insufficient data and blocked from
// nothing; a recalculation is a new evaluation and the earlier one stays; the buying policy's supplier check is unchanged
// without a response rule, and warns or stops under one. Standalone: a spec-local organization, suppliers, orders, receipts,
// inspections and a bill, and users in spec-local groups, with artifact authorization disabled (the rules are the
// services' own permission checks).
// Run: ./moq test mr-mantle --spec SupplierScorecards
const prefix = "SCORECARD_SPEC"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG"
const supplierA = prefix + "_SUP_A",
    supplierB = prefix + "_SUP_B",
    otherSupplier = prefix + "_SUP_OTHER"
const orderA = prefix + "_PO_A",
    orderB = prefix + "_PO_B"
const users = {}
const dayMs = 86400000
const S = "mantle.party.SupplierServices."
const call = (name, parameters) => ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
const one = (entity, key) => ec.entity.find(entity).condition(key).disableAuthz().one()
const rows = (entity, key) => Array.from(ec.entity.find(entity).condition(key).disableAuthz().list())
const svc = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) {
        const errors = ec.message.getErrorsString()
        ec.message.clearErrors()
        throw new Error(errors)
    }
    return out
}
function refused(name, parameters) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).disableAuthz().call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Scorecard " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Scorecard", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
const daysAgo = days => new Date(Number(ec.user.nowTimestamp) - days * dayMs)
const period = () => ({periodFromDate: daysAgo(80), periodThruDate: daysAgo(1)})
// a placed order of the organization from the supplier with lines of ten at 10.00, each required 30 days ago
function order(orderId, supplierPartyId, lineCount) {
    svc("create#mantle.order.OrderHeader", {orderId, statusId: "OrderApproved", currencyUomId: "USD", placedDate: daysAgo(60)})
    svc("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: supplierPartyId,
        customerPartyId: org,
        statusId: "OrderApproved"
    })
    for (let line = 1; line <= lineCount; line++)
        svc("create#mantle.order.OrderItem", {
            orderId,
            orderPartSeqId: "01",
            orderItemSeqId: "0" + line,
            itemTypeEnumId: "ItemInventory",
            quantity: 10,
            unitAmount: 10,
            requiredByDate: daysAgo(30)
        })
}
function receipt(orderId, line, days, accepted = 10, rejected = 0) {
    const id = orderId + "_R" + line
    // the received stock, which the receipt's posting reads
    svc("create#mantle.product.asset.Asset", {
        assetId: id + "_A",
        assetTypeEnumId: "AstTpInventory",
        ownerPartyId: org,
        statusId: "AstAvailable",
        quantityOnHandTotal: 0,
        availableToPromiseTotal: 0
    })
    svc("create#mantle.product.receipt.AssetReceipt", {
        assetReceiptId: id,
        assetId: id + "_A",
        orderId,
        orderItemSeqId: "0" + line,
        receivedDate: daysAgo(days),
        quantityAccepted: accepted,
        quantityRejected: rejected
    })
    return id
}
const measureOf = (scorecardId, metricEnumId) =>
    one("mantle.party.supplier.SupplierScorecardMeasure", {supplierScorecardId: scorecardId, metricEnumId})

spec({
    setupSpec() {
        for (const partyId of [org, otherOrg]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: "Scorecard " + partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        for (const [partyId, owner] of [
            [supplierA, org],
            [supplierB, org],
            [otherSupplier, otherOrg]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: owner})
            call("create#mantle.party.Organization", {partyId, organizationName: "Scorecard " + partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"})
        }
        users.admin = user("ADMIN", ["PURCHASE_POLICY_EDIT"])
        users.evaluator = user("EVALUATOR", ["SUPPLIER_SCORECARD_EDIT"])
        users.buyer = user("BUYER", ["PURCHASE_ORDER_EDIT", "SUPPLIER_PROFILE_EDIT"])
        users.none = user("NONE", [])
        // supplier A: six receipts of six lines. Line 1 was first acknowledged for 40 days ago, then promised for 20 days
        // ago, and received 35 days ago: late against its first acknowledged date. Line 4 acknowledged for 20 days ago and
        // received 21 days ago: on time, after its required date. Lines 2, 5 and 6 have no acknowledgement and arrive before
        // the required date; line 3 after it.
        order(orderA, supplierA, 6)
        svc("update#mantle.order.OrderItem", {orderId: orderA, orderItemSeqId: "01", promisedDate: daysAgo(40)})
        svc("update#mantle.order.OrderItem", {orderId: orderA, orderItemSeqId: "01", promisedDate: daysAgo(20)})
        svc("update#mantle.order.OrderItem", {orderId: orderA, orderItemSeqId: "04", promisedDate: daysAgo(20)})
        receipt(orderA, 1, 35)
        receipt(orderA, 2, 31, 9, 1)
        const scrapped = receipt(orderA, 3, 25)
        receipt(orderA, 4, 21)
        const undecided = receipt(orderA, 5, 32)
        receipt(orderA, 6, 33)
        // quality: line 3's receipt inspected and two scrapped; line 5's inspection is not decided, so it is left out
        svc("create#mantle.product.quality.QualityInspection", {
            qualityInspectionId: prefix + "_QI_3",
            assetReceiptId: scrapped,
            orderId: orderA,
            orderItemSeqId: "03",
            statusId: "QiDisposed",
            quantity: 10,
            quantityAccepted: 8,
            quantityRejected: 2
        })
        svc("create#mantle.product.quality.QualityInspectionDisposition", {
            qualityInspectionId: prefix + "_QI_3",
            dispositionSeqId: "01",
            dispositionEnumId: "QdScrap",
            quantity: 2
        })
        svc("create#mantle.product.quality.QualityInspection", {
            qualityInspectionId: prefix + "_QI_5",
            assetReceiptId: undecided,
            orderId: orderA,
            orderItemSeqId: "05",
            statusId: "QiSubmitted",
            quantity: 10
        })
        // price variance: five of line 6 billed at 11.00 against 10.00 ordered
        svc("create#mantle.account.invoice.Invoice", {
            invoiceId: prefix + "_BILL",
            invoiceTypeEnumId: "InvoiceSales",
            fromPartyId: supplierA,
            toPartyId: org,
            statusId: "InvoiceIncoming",
            invoiceDate: daysAgo(20),
            currencyUomId: "USD"
        })
        svc("create#mantle.account.invoice.InvoiceItem", {
            invoiceId: prefix + "_BILL",
            invoiceItemSeqId: "01",
            itemTypeEnumId: "ItemInventory",
            quantity: 5,
            amount: 11
        })
        svc("create#mantle.order.OrderItemBilling", {
            orderItemBillingId: prefix + "_OIB",
            orderId: orderA,
            orderItemSeqId: "06",
            invoiceId: prefix + "_BILL",
            invoiceItemSeqId: "01",
            quantity: 5,
            amount: 55
        })
        // supplier B: two receipts on time, under the minimum sample
        order(orderB, supplierB, 2)
        receipt(orderB, 1, 31)
        receipt(orderB, 2, 32)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("an administrator keeps the scorecard basis, criteria and response rules as dated rows; others are refused", {
    when() {
        login(users.buyer)
        const read = svc(S + "get#ScorecardPolicy", {organizationPartyId: org})
        const buyerRefused = refused(S + "store#ScorecardPolicy", {organizationPartyId: org, minimumSample: 4, changeReason: "x"})
        login(users.none)
        const noneRefused = refused(S + "get#ScorecardPolicy", {organizationPartyId: org})
        login(users.admin)
        const noReason = refused(S + "store#ScorecardPolicy", {organizationPartyId: org, periodDays: 60})
        const stored = svc(S + "store#ScorecardPolicy", {
            organizationPartyId: org,
            periodDays: 120,
            changeReason: "Quarterly reviews"
        })
        const after = svc(S + "get#ScorecardPolicy", {organizationPartyId: org})
        const criterion = svc(S + "store#ScorecardCriterion", {
            organizationPartyId: org,
            metricEnumId: "SsmResponse",
            weight: 5,
            changeReason: "Fewer RFQs"
        })
        const wrongSide = refused(S + "store#ScorecardCriterion", {
            organizationPartyId: org,
            metricEnumId: "SsmOnTime",
            targetValue: 60,
            floorValue: 80,
            changeReason: "x"
        })
        const noBand = refused(S + "store#ScorecardAction", {
            organizationPartyId: org,
            effectEnumId: "SseWarn",
            changeReason: "x"
        })
        const otherOrgRefused = refused(S + "get#ScorecardPolicy", {organizationPartyId: otherOrg})
        login("john.doe")
        return {read, buyerRefused, noneRefused, noReason, stored, after, criterion, wrongSide, noBand, otherOrgRefused}
    },
    then({read, buyerRefused, noneRefused, noReason, stored, after, criterion, wrongSide, noBand, otherOrgRefused}) {
        read.policy.periodDays == 90
        read.policy.minimumSample == 5
        read.policy.dueDateBasisEnumId == "SddbAcknowledged"
        read.policyFromDate == null
        read.criterionRows.length == 4
        read.canEdit == false
        buyerRefused.includes("PERMISSION_DENIED")
        noneRefused.includes("PERMISSION_DENIED")
        noReason.includes("POLICY_INVALID")
        stored.policyFromDate != null
        after.policy.periodDays == 120
        after.policy.minimumSample == 5
        after.history.length == 1
        after.canEdit == true
        criterion.organizationPartyId == org
        after.criterionRows.find(row => row.metricEnumId == "SsmOnTime").sourceText == "Built-in"
        rows("mantle.party.supplier.SupplierScorecardCriterion", {organizationPartyId: org, metricEnumId: "SsmResponse"})
            .length == 1
        wrongSide.includes("CRITERION_INVALID")
        noBand.includes("ACTION_INVALID")
        otherOrgRefused.includes("RECORD_UNAVAILABLE")
    }
})

feature(
    "an evaluation scores on-time delivery from the first acknowledged date, quality from dispositions and price variance; under five receipts is Insufficient data; a recalculation keeps the earlier one",
    {
        when() {
            login(users.evaluator)
            // the same period twice: the second is a recalculation of the first
            const basis = period()
            const first = svc(
                S + "evaluate#SupplierScorecard",
                Object.assign({organizationPartyId: org, supplierPartyIds: [supplierA, supplierB]}, basis)
            )
            const again = svc(
                S + "evaluate#SupplierScorecard",
                Object.assign({organizationPartyId: org, supplierPartyId: supplierA}, basis)
            )
            login("john.doe")
            const scoredId = first.resultRows.find(row => row.supplierPartyId == supplierA).supplierScorecardId
            const insufficientId = first.resultRows.find(row => row.supplierPartyId == supplierB).supplierScorecardId
            const recalculatedId = again.resultRows[0].supplierScorecardId
            return {
                first,
                scored: one("mantle.party.supplier.SupplierScorecard", {supplierScorecardId: scoredId}),
                insufficient: one("mantle.party.supplier.SupplierScorecard", {supplierScorecardId: insufficientId}),
                recalculated: one("mantle.party.supplier.SupplierScorecard", {supplierScorecardId: recalculatedId}),
                onTime: measureOf(scoredId, "SsmOnTime"),
                quality: measureOf(scoredId, "SsmQuality"),
                price: measureOf(scoredId, "SsmPriceVariance"),
                response: measureOf(scoredId, "SsmResponse"),
                lateFirst: rows("mantle.party.supplier.SupplierScorecardEvidence", {
                    supplierScorecardId: scoredId,
                    metricEnumId: "SsmOnTime",
                    orderItemSeqId: "01"
                })[0],
                undecided: rows("mantle.party.supplier.SupplierScorecardEvidence", {
                    supplierScorecardId: scoredId,
                    metricEnumId: "SsmQuality",
                    orderItemSeqId: "05"
                })[0],
                scoredId,
                evaluations: rows("mantle.party.supplier.SupplierScorecard", {
                    organizationPartyId: org,
                    supplierPartyId: supplierA
                }).length
            }
        },
        then({
            first,
            scored,
            insufficient,
            recalculated,
            onTime,
            quality,
            price,
            response,
            lateFirst,
            undecided,
            scoredId,
            evaluations
        }) {
            first.evaluatedCount == 2
            first.failedCount == 0
            scored.resultEnumId == "SsrScored"
            scored.eligibleCount == 6
            scored.minimumSample == 5
            scored.dueDateBasisEnumId == "SddbAcknowledged"
            // receipts of lines 1 and 3 late: 40 of 60 on time
            onTime.numerator.compare(40) == 0
            onTime.denominator.compare(60) == 0
            onTime.eligibleCount == 6
            lateFirst.dueBasisText == "First acknowledged"
            lateFirst.numerator.compare(0) == 0
            // one rejected at receipt and two scrapped of fifty decided; line 5's undecided inspection left out
            quality.numerator.compare(47) == 0
            quality.denominator.compare(50) == 0
            quality.excludedCount == 1
            undecided.excludedReason == "Inspection not decided yet"
            // 5 over 50 ordered
            price.numerator.compare(5) == 0
            price.denominator.compare(50) == 0
            price.measureValue.compare(10) == 0
            response.measureValue == null
            response.missingText == "No RFQ invitation sent in the period"
            // on-time 66.7% is below its floor of 70 (0), quality 94% is 44.44 between 90 and 99, price variance at its floor
            // of 10% is 0, response has no evidence: (0 x 40 + 44.4444 x 30 + 0 x 20) / 90
            scored.score.compare(toDecimal("14.81")) == 0
            insufficient.resultEnumId == "SsrInsufficient"
            insufficient.eligibleCount == 2
            insufficient.missingDataText.startsWith("2 eligible receipts of the 5")
            recalculated.previousScorecardId == scoredId
            recalculated.score.compare(toDecimal("14.81")) == 0
            evaluations == 2
        }
    }
)

feature(
    "the supplier check is unchanged without a response rule; a rule warns on a low score, Insufficient data draws nothing, and a risk rule blocks",
    {
        when() {
            login(users.buyer)
            const check = supplierPartyId =>
                svc("mantle.order.PurchaseServices.check#SupplierUsable", {organizationPartyId: org, supplierPartyId})
            const before = check(supplierA)
            login(users.admin)
            const warnRule = svc(S + "store#ScorecardAction", {
                organizationPartyId: org,
                scoreBelow: 50,
                effectEnumId: "SseWarn",
                changeReason: "Low performers"
            })
            const blockRule = svc(S + "store#ScorecardAction", {
                organizationPartyId: org,
                riskSeverityEnumId: "SrsHigh",
                effectEnumId: "SseBlock",
                changeReason: "High risks"
            })
            login(users.evaluator)
            svc(
                S + "evaluate#SupplierScorecard",
                Object.assign({organizationPartyId: org, supplierPartyIds: [supplierA, supplierB]}, period())
            )
            login(users.buyer)
            const warned = check(supplierA)
            const insufficient = check(supplierB)
            const risk = svc(S + "store#SupplierRisk", {
                organizationPartyId: org,
                supplierPartyId: supplierB,
                severityEnumId: "SrsHigh",
                categoryEnumId: "SrcQuality",
                description: "Failed audit"
            })
            const blocked = check(supplierB)
            const otherSupplierRisk = refused(S + "store#SupplierRisk", {
                organizationPartyId: org,
                supplierPartyId: otherSupplier,
                severityEnumId: "SrsLow",
                categoryEnumId: "SrcOther",
                description: "x"
            })
            const noReasonEnd = refused(S + "store#SupplierRisk", {
                organizationPartyId: org,
                supplierRiskId: risk.supplierRiskId,
                end: "Y"
            })
            svc(S + "store#SupplierRisk", {
                organizationPartyId: org,
                supplierRiskId: risk.supplierRiskId,
                end: "Y",
                changeReason: "Re-audited"
            })
            const ended = check(supplierB)
            login(users.none)
            const noneRisk = refused(S + "store#SupplierRisk", {
                organizationPartyId: org,
                supplierPartyId: supplierB,
                severityEnumId: "SrsLow",
                categoryEnumId: "SrcOther",
                description: "x"
            })
            login(users.admin)
            svc(S + "store#ScorecardAction", {
                organizationPartyId: org,
                scorecardActionId: warnRule.scorecardActionId,
                end: "Y",
                changeReason: "Done"
            })
            svc(S + "store#ScorecardAction", {
                organizationPartyId: org,
                scorecardActionId: blockRule.scorecardActionId,
                end: "Y",
                changeReason: "Done"
            })
            login("john.doe")
            return {before, warned, insufficient, blocked, otherSupplierRisk, noReasonEnd, ended, noneRisk}
        },
        then({before, warned, insufficient, blocked, otherSupplierRisk, noReasonEnd, ended, noneRisk}) {
            before.result == "OK"
            warned.result == "WARN"
            warned.reasonCode == "SUPPLIER_SCORE_WARNING"
            warned.message.includes("scored 14.8")
            insufficient.result == "OK"
            blocked.result == "STOP"
            blocked.reasonCode == "SUPPLIER_SCORE_BLOCKED"
            blocked.message.includes("Failed audit")
            otherSupplierRisk.includes("SUPPLIER_UNAVAILABLE")
            noReasonEnd.includes("RISK_INVALID")
            ended.result == "OK"
            noneRisk.includes("PERMISSION_DENIED")
        }
    }
)

feature(
    "an evaluation needs SUPPLIER_SCORECARD_EDIT in the organization and a valid period; a supplier it cannot evaluate is named and the others go on",
    {
        when() {
            login(users.buyer)
            const buyer = refused(
                S + "evaluate#SupplierScorecard",
                Object.assign({organizationPartyId: org, supplierPartyId: supplierA}, period())
            )
            login(users.evaluator)
            const otherOrganization = refused(S + "evaluate#SupplierScorecard", {
                organizationPartyId: otherOrg,
                supplierPartyId: otherSupplier
            })
            const backwards = refused(S + "evaluate#SupplierScorecard", {
                organizationPartyId: org,
                supplierPartyId: supplierA,
                periodFromDate: daysAgo(1),
                periodThruDate: daysAgo(10)
            })
            const mixed = svc(
                S + "evaluate#SupplierScorecard",
                Object.assign({organizationPartyId: org, supplierPartyIds: [otherSupplier, supplierB]}, period())
            )
            login("john.doe")
            return {buyer, otherOrganization, backwards, mixed}
        },
        then({buyer, otherOrganization, backwards, mixed}) {
            buyer.includes("PERMISSION_DENIED")
            otherOrganization.includes("RECORD_UNAVAILABLE")
            backwards.includes("PERIOD_INVALID")
            mixed.failedCount == 1
            mixed.evaluatedCount == 1
            mixed.resultRows.find(row => row.supplierPartyId == otherSupplier).errorText.includes("SUPPLIER_UNAVAILABLE")
        }
    }
)
