// Sales defaults, approval rules and approvals (impl-sales P9; design-sales §9 SalesDefaults and ApprovalPolicies, §5 the approval
// binding; mantle.order.SalesApprovalServices over SalesApprovals.js): an organization's defaults publish as a dated successor and
// set a new quote's validity; an entered price over the organization's discount rule waits for an approver, who is not its author
// and decides at the quote's current revision; a line change supersedes the approval and a file does not (the seller's commercial
// revision on); propose#Quote is refused until the approval is current; a free line is the rep's only where a rule will need it
// approved (the user's call of Nov 13); with the seller's approval setting off a Sales order rule stops autoApprove#Order and not a
// person's approve#Order, and an organization with no rule auto-approves as before. Standalone: spec-local organizations, stores,
// teams, users, accounts and products; the users' services run with artifact authorization on under a spec grant of the services.
// Run: ./moq test mr-mantle --spec SalesQuoteApprovals
const prefix = "SQA"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B",
    orgC = prefix + "_ORG_C"
const service = "mantle.order.SalesApprovalServices."
const quoteService = "mantle.order.SalesQuoteServices."
const users = {}
const accounts = {}
const product = prefix + "_PRICED"
const quotes = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    // the commercial revision on (X2): a file or a note does not move a quote's revision
    make("mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: partyId,
        baseCurrencyUomId: "USD",
        salesCommercialRevisionOnly: "Y"
    })
    // a store whose own approval checks are off, so only the order's payment and the SECAs' warnings decide autoApprove#Order
    make("mantle.product.store.ProductStore", {
        productStoreId: partyId + "_STORE",
        storeName: name + " store",
        organizationPartyId: partyId,
        defaultCurrencyUomId: "USD",
        requireInventory: "N"
    })
    for (const settingTypeEnumId of [
        "PsstOrdApproveNewCust",
        "PsstOrdApproveAddrMissing",
        "PsstOrdApproveAddrNotValid",
        "PsstOrdApproveBillShipAddrDiff",
        "PsstOrdApprovePayMethNameDiff",
        "PsstOrdApprovePayMethBlacklist",
        "PsstOrdApproveContactBlacklist"
    ].filter(enumId => !!one("moqui.basic.Enumeration", {enumId})))
        make("mantle.product.store.ProductStoreSetting", {
            productStoreId: partyId + "_STORE",
            settingTypeEnumId,
            fromDate: 0,
            settingValue: "false"
        })
}
// a user, agent of the organizations, in a spec group holding the permissions and the spec's service grant
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Approvals", lastName: kind})
    for (const organizationPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId: organizationPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Approvals " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
function account(kind, ownerPartyId) {
    const partyId = prefix + "_ACC_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Account " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    return partyId
}
// A call as the user with artifact authorization on: its result, or the refusal's message (refused), in an error frame of its own.
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(verb.includes(".") ? verb : service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const revision = orderId => Number(one("mantle.order.OrderHeader", {orderId}).orderRevision ?? 1)
const approvalOf = (username, orderId) => as(username, "preview#Quote", {orderId}).approval
const states = approval => Array.from(approval?.requirements || []).map(row => row.ruleTypeEnumId + ":" + row.state)
// a quote of the rep with one line of the product at an entered price
function quoteWithPrice(username, organizationPartyId, customerPartyId, unitAmount) {
    const orderId = as(username, quoteService + "create#Quote", {organizationPartyId, customerPartyId}).orderId
    const line = as(username, quoteService + "store#QuoteLine", {
        orderId,
        orderRevision: revision(orderId),
        productId: product,
        unitAmount,
        overrideReason: "Volume deal"
    })
    return {orderId, orderItemSeqId: line.orderItemSeqId}
}
// a store order of the organization for the account, placed, with an authorized payment of its total, then autoApprove#Order
function paidStoreOrder(organizationPartyId, customerPartyId) {
    return system(() => {
        const created = call("mantle.order.OrderServices.create#Order", {
            productStoreId: organizationPartyId + "_STORE",
            vendorPartyId: organizationPartyId,
            customerPartyId,
            currencyUomId: "USD"
        })
        call("mantle.order.OrderServices.create#OrderItem", {
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            productId: product,
            itemTypeEnumId: "ItemProduct",
            quantity: 1,
            unitAmount: 100,
            requireInventory: false
        })
        call("mantle.order.OrderServices.place#Order", {orderId: created.orderId, requireInventory: false})
        const order = one("mantle.order.OrderHeader", {orderId: created.orderId})
        make("mantle.account.payment.Payment", {
            paymentTypeEnumId: "PtInvoicePayment",
            orderId: created.orderId,
            orderPartSeqId: created.orderPartSeqId,
            fromPartyId: customerPartyId,
            toPartyId: organizationPartyId,
            statusId: "PmntAuthorized",
            amount: order.grandTotal,
            amountUomId: "USD"
        })
        call("mantle.order.OrderServices.autoApprove#Order", {orderId: created.orderId})
        return {
            orderId: created.orderId,
            statusId: one("mantle.order.OrderHeader", {orderId: created.orderId}).statusId,
            warnings: Array.from(
                call("mantle.order.OrderInfoServices.check#OrderPreApprove", {orderId: created.orderId}).approveWarnings || []
            )
        }
    })
}

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            organization(orgA, "Approvals A")
            organization(orgB, "Approvals B")
            organization(orgC, "Approvals C")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Approvals spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Approvals spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.order\\.Sales(Quote|Approval)Services\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            const rep = ["SALES_VIEW", "SALES_QUOTE_EDIT"]
            users.rep = user("rep", [orgA], rep)
            users.lead = user("lead", [orgA], rep.concat(["SALES_APPROVE"]))
            users.approver = user("approver", [orgA], ["SALES_VIEW", "SALES_APPROVE"])
            users.approverB = user("approverb", [orgB], ["SALES_VIEW", "SALES_APPROVE"])
            users.repB = user("repb", [orgB], rep)
            users.admin = user("admin", [orgA, orgB], ["SALES_VIEW", "SALES_CONFIGURE"])
            accounts.a = account("a", orgA)
            accounts.b = account("b", orgB)
            accounts.c = account("c", orgC)
            make("mantle.product.Product", {productId: product, productName: "Priced", productTypeEnumId: "PtService"})
            for (const vendorPartyId of [orgA, orgB])
                make("mantle.product.ProductPrice", {
                    productId: product,
                    vendorPartyId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    priceUomId: "USD",
                    price: "100"
                })
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature(
    "an organization's defaults publish as a dated successor and set a new quote's validity; its rules are its configurer's",
    {
        when() {
            const preview = as(users.admin, "store#SalesPolicy", {
                organizationPartyId: orgA,
                quoteValidityDays: "14",
                previewOnly: "Y"
            })
            const before = as(users.admin, "get#SalesPolicy", {organizationPartyId: orgA}).policy
            const first = as(users.admin, "store#SalesPolicy", {
                organizationPartyId: orgA,
                quoteValidityDays: "14",
                intakeRetentionDays: "60",
                changeReason: "Two weeks"
            })
            const read = as(users.admin, "get#SalesPolicy", {organizationPartyId: orgA})
            const stale = as(users.admin, "store#SalesPolicy", {
                organizationPartyId: orgA,
                revision: "1",
                quoteValidityDays: "21",
                changeReason: "Three weeks"
            }).refused
            const unnamed = as(users.admin, "store#SalesPolicy", {
                organizationPartyId: orgA,
                quoteValidityDays: "21",
                changeReason: "Three weeks"
            }).refused
            const repRefused = as(users.rep, "store#SalesPolicy", {
                organizationPartyId: orgA,
                quoteValidityDays: "7",
                changeReason: "x"
            }).refused
            // the rules: a discount at or beyond 10 % needs an approver; a rep may not set one
            const rule = as(users.admin, "store#SalesApprovalPolicy", {
                organizationPartyId: orgA,
                purposeEnumId: "SapQuote",
                ruleTypeEnumId: "SarDiscount",
                discountPercent: "10",
                changeReason: "Discount control"
            })
            const badRule = as(users.admin, "store#SalesApprovalPolicy", {
                organizationPartyId: orgA,
                purposeEnumId: "SapQuote",
                ruleTypeEnumId: "SarAmount",
                changeReason: "No amount"
            }).refused
            const repRule = as(users.rep, "store#SalesApprovalPolicy", {
                organizationPartyId: orgA,
                purposeEnumId: "SapQuote",
                ruleTypeEnumId: "SarFreeLine",
                changeReason: "Mine"
            }).refused
            const quote = as(users.rep, quoteService + "create#Quote", {customerPartyId: accounts.a})
            const part = one("mantle.order.OrderPart", {orderId: quote.orderId, orderPartSeqId: "01"})
            const ms = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js").ms
            const days = (ms(part.validThruDate) - ms(part.validFromDate)) / 86400000
            return {preview, before, first, read, stale, unnamed, repRefused, rule, badRule, repRule, days}
        },
        then({preview, before, first, read, stale, unnamed, repRefused, rule, badRule, repRule, days}) {
            preview.published == false
            Array.from(preview.changes).some(change => change.field == "quoteValidityDays" && change.afterText == "14")
            before == null
            first.published == true
            read.policy.quoteValidityDays == 14
            read.policy.changeReason == "Two weeks"
            read.commercialRevisionOnly == true
            stale.includes("REVISION_CHANGED")
            unnamed.includes("REVISION_REQUIRED")
            repRefused.includes("PERMISSION_DENIED")
            rule.refused == ""
            badRule.includes("THRESHOLD_REQUIRED")
            repRule.includes("PERMISSION_DENIED")
            Math.round(days) == 14
        }
    }
)

feature("an entered price over the rule waits for an approver who is not its author, at the quote's current revision", {
    when() {
        quotes.discount = quoteWithPrice(users.rep, orgA, accounts.a, "85")
        const orderId = quotes.discount.orderId
        const required = approvalOf(users.rep, orderId)
        const proposeRefused = as(users.rep, quoteService + "propose#Quote", {orderId, orderRevision: revision(orderId)}).refused
        // the approver sees the quote only once its approval is asked
        const unseen = as(users.approver, quoteService + "get#Quote", {orderId}).quoteFound
        const asked = as(users.rep, "request#QuoteApproval", {orderId, orderRevision: revision(orderId)})
        const notice = one("moqui.security.user.NotificationMessage", {
            topic: "SalesQuoteApproval",
            recordEntityName: "mantle.order.OrderHeader",
            recordId: orderId
        })
        const noticeUsers = Array.from(
            ec.entity
                .find("moqui.security.user.NotificationMessageUser")
                .condition("notificationMessageId", notice?.notificationMessageId || "_NONE_")
                .disableAuthz()
                .list()
        ).map(row => row.userId)
        const seen = as(users.approver, quoteService + "get#Quote", {orderId}).quoteFound
        // an approver who also drafts quotes sees this one to decide it, not to change it
        const leadEdit = as(users.lead, quoteService + "store#QuoteLine", {
            orderId,
            orderRevision: revision(orderId),
            orderItemSeqId: quotes.discount.orderItemSeqId,
            quantity: "3"
        }).refused
        const repDecide = as(users.rep, "decide#Quote", {orderId, orderRevision: revision(orderId)}).refused
        const otherOrg = as(users.approverB, "decide#Quote", {orderId, orderRevision: revision(orderId)}).refused
        const staleDecide = as(users.approver, "decide#Quote", {orderId, orderRevision: revision(orderId) - 1}).refused
        // a lead who approves quotes may not approve the one they priced
        quotes.own = quoteWithPrice(users.lead, orgA, accounts.a, "80")
        const selfDecide = as(users.lead, "decide#Quote", {
            orderId: quotes.own.orderId,
            orderRevision: revision(quotes.own.orderId)
        }).refused
        const approved = as(users.approver, "decide#Quote", {
            orderId,
            orderRevision: revision(orderId),
            reason: "Strategic account",
            operationKey: prefix + "-decide-1"
        })
        const again = as(users.approver, "decide#Quote", {
            orderId,
            orderRevision: revision(orderId) - 0,
            reason: "Strategic account",
            operationKey: prefix + "-decide-1"
        })
        const noticeRead = ec.entity
            .find("moqui.security.user.NotificationMessageUser")
            .condition("notificationMessageId", notice?.notificationMessageId || "_NONE_")
            .condition("viewedDate", "is-null", null)
            .disableAuthz()
            .count()
        return {
            required,
            proposeRefused,
            unseen,
            asked,
            notice,
            noticeUsers,
            seen,
            leadEdit,
            repDecide,
            otherOrg,
            staleDecide,
            selfDecide,
            approved,
            again,
            noticeRead,
            after: approvalOf(users.rep, orderId)
        }
    },
    then(r) {
        states(r.required).join() == "SarDiscount:required"
        Array.from(r.required.requirements)[0].inputsText.includes("15")
        r.proposeRefused.includes("APPROVAL_REQUIRED")
        r.unseen == false
        r.asked.notifiedCount >= 1
        r.noticeUsers.includes(users.approver)
        r.noticeUsers.includes(users.lead)
        !r.noticeUsers.includes(users.rep)
        String(r.notice.titleText).includes(quotes.discount.orderId)
        String(r.notice.titleText).includes("discount")
        // the entered price (85) is in neither, as a number of its own: an id with those digits (order 100185) is not it
        !/(^|[^0-9])85([.,]0+)?([^0-9]|$)/.test(String(r.notice.titleText))
        !/(^|[^0-9])85([.,]0+)?([^0-9]|$)/.test(String(r.notice.messageJson))
        r.seen == true
        r.leadEdit.includes("PERMISSION_DENIED")
        r.repDecide.includes("PERMISSION_DENIED")
        r.otherOrg.includes("RECORD_UNAVAILABLE")
        r.staleDecide.includes("REVISION_CHANGED")
        r.selfDecide.includes("SELF_APPROVAL")
        r.approved.approved == true
        r.again.alreadyApplied == true
        r.noticeRead == 0
        states(r.after).join() == "SarDiscount:approved"
        r.after.approved == true
    }
})

feature("a file leaves the approval current, a line change supersedes it, and the quote proposes once approved again", {
    when() {
        const {orderId, orderItemSeqId} = quotes.discount
        const before = revision(orderId)
        system(() =>
            call("mantle.order.OrderServices.create#OrderContent", {
                orderId,
                orderContentTypeEnumId: "OctOther",
                description: "customer's spec sheet"
            })
        )
        const afterFile = {revision: revision(orderId), approval: approvalOf(users.rep, orderId)}
        as(users.rep, quoteService + "store#QuoteLine", {
            orderId,
            orderRevision: revision(orderId),
            orderItemSeqId,
            quantity: "2"
        })
        const afterLine = {revision: revision(orderId), approval: approvalOf(users.rep, orderId)}
        const superseded = Array.from(
            ec.entity
                .find("mantle.order.OrderDecision")
                .condition("orderId", orderId)
                .condition("decisionResultEnumId", "SdrApproved")
                .disableAuthz()
                .list()
        ).filter(row => row.invalidatedDate).length
        as(users.rep, "request#QuoteApproval", {orderId, orderRevision: revision(orderId)})
        as(users.approver, "decide#Quote", {orderId, orderRevision: revision(orderId)})
        const proposed = as(users.rep, quoteService + "propose#Quote", {orderId, orderRevision: revision(orderId)})
        return {before, afterFile, afterLine, superseded, proposed}
    },
    then({before, afterFile, afterLine, superseded, proposed}) {
        afterFile.revision == before
        afterFile.approval.approved == true
        afterLine.revision > before
        states(afterLine.approval).join() == "SarDiscount:required"
        superseded == 1
        proposed.refused == ""
        proposed.statusId == "OrderProposed"
    }
})

feature("a free line is the rep's where a rule will need it approved, a sales approver's elsewhere", {
    when() {
        // B's only rule is an amount, which does not meet a free line
        as(users.admin, "store#SalesApprovalPolicy", {
            organizationPartyId: orgB,
            purposeEnumId: "SapQuote",
            ruleTypeEnumId: "SarAmount",
            thresholdAmount: "10000",
            currencyUomId: "USD",
            changeReason: "Large quotes"
        })
        const orderId = as(users.repB, quoteService + "create#Quote", {
            organizationPartyId: orgB,
            customerPartyId: accounts.b
        }).orderId
        quotes.freeB = orderId
        const free = {orderId, productId: product, freeLine: "Y", overrideReason: "Sample"}
        const uncovered = as(
            users.repB,
            quoteService + "store#QuoteLine",
            Object.assign({orderRevision: revision(orderId)}, free)
        ).refused
        as(users.admin, "store#SalesApprovalPolicy", {
            organizationPartyId: orgB,
            purposeEnumId: "SapQuote",
            ruleTypeEnumId: "SarFreeLine",
            changeReason: "Samples need approval"
        })
        const covered = as(users.repB, quoteService + "store#QuoteLine", Object.assign({orderRevision: revision(orderId)}, free))
        // A's discount rule meets a free line of a priced product (100 % under its calculated price)
        const orderA = as(users.rep, quoteService + "create#Quote", {customerPartyId: accounts.a}).orderId
        const coveredA = as(
            users.rep,
            quoteService + "store#QuoteLine",
            Object.assign({}, free, {orderId: orderA, orderRevision: revision(orderA)})
        )
        return {uncovered, covered, approval: approvalOf(users.repB, orderId), coveredA, approvalA: approvalOf(users.rep, orderA)}
    },
    then({uncovered, covered, approval, coveredA, approvalA}) {
        uncovered.includes("FREE_LINE_DENIED")
        covered.refused == ""
        states(approval).join() == "SarFreeLine:required"
        coveredA.refused == ""
        states(approvalA).join() == "SarDiscount:required"
    }
})

feature("deciding the notice decides the rules it asked for, never one set after it was sent", {
    when() {
        const orderId = quotes.freeB
        as(users.repB, "request#QuoteApproval", {orderId, orderRevision: revision(orderId)})
        const notice = one("moqui.security.user.NotificationMessage", {
            topic: "SalesQuoteApproval",
            recordEntityName: "mantle.order.OrderHeader",
            recordId: orderId
        })
        // a discount rule set after the notice was sent meets the free line too (100 % under its calculated price)
        as(users.admin, "store#SalesApprovalPolicy", {
            organizationPartyId: orgB,
            purposeEnumId: "SapQuote",
            ruleTypeEnumId: "SarDiscount",
            discountPercent: "10",
            changeReason: "Discount control"
        })
        const beforeDecide = states(approvalOf(users.repB, orderId))
        const decided = as(users.approverB, "approve#QuoteMessage", {
            recordEntityName: "mantle.order.OrderHeader",
            recordId: orderId,
            message: JSON.parse(notice.messageJson)
        })
        const afterDecide = approvalOf(users.repB, orderId)
        // the rep asks again for the rule set since
        const askedAgain = as(users.repB, "request#QuoteApproval", {orderId, orderRevision: revision(orderId)})
        return {beforeDecide, decided, afterDecide, askedAgain, after: approvalOf(users.repB, orderId)}
    },
    then({beforeDecide, decided, afterDecide, askedAgain, after}) {
        beforeDecide.join() == "SarFreeLine:requested,SarDiscount:required"
        decided.refused == ""
        states(afterDecide).join() == "SarFreeLine:approved,SarDiscount:required"
        afterDecide.approved == false
        afterDecide.canRequest == true
        askedAgain.refused == ""
        states(after).join() == "SarFreeLine:approved,SarDiscount:requested"
    }
})

feature("with the approval setting off a Sales order rule stops autoApprove#Order and not a person's approve#Order", {
    when() {
        as(users.admin, "store#SalesApprovalPolicy", {
            organizationPartyId: orgA,
            purposeEnumId: "SapOrder",
            ruleTypeEnumId: "SarAmount",
            thresholdAmount: "50",
            currencyUomId: "USD",
            changeReason: "Orders over 50 are approved by a person"
        })
        const ruled = paidStoreOrder(orgA, accounts.a)
        system(() => call("mantle.order.OrderServices.approve#Order", {orderId: ruled.orderId}))
        const approvedByPerson = one("mantle.order.OrderHeader", {orderId: ruled.orderId}).statusId
        // an organization with no Sales rule approves as before
        const plain = paidStoreOrder(orgC, accounts.c)
        return {ruled, approvedByPerson, plain}
    },
    then({ruled, approvedByPerson, plain}) {
        ruled.statusId == "OrderPlaced"
        ruled.warnings.some(warning => warning.startsWith("Sales order approval needed"))
        // the warning names the rule, never its threshold or the order's amounts
        !ruled.warnings.some(warning => warning.startsWith("Sales") && warning.includes("$"))
        approvedByPerson == "OrderApproved"
        plain.statusId == "OrderApproved"
        !plain.warnings.some(warning => warning.startsWith("Sales"))
    }
})
