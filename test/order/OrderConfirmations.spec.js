// A sales order's confirmation as placed (impl-customer-service P3, F29, F55; mantle.order.OrderConfirmationServices,
// OrderConfirmations.js): the first resend renders the order as of its placed time (a line changed after placement prints
// its placed quantity, a line added after it is left out), stores the PDF once and sends it to a checked recipient through the mail client
// (send#EmailDraft), recording the recipient's party and the content sent; the same operation key answers the first
// result; a second resend is a second message of the same stored content, not a new render. The refusals: no permission,
// the print's amounts without price read, a store order whose lines changed after placement, another organization's order and a missing one alike, a recipient that is not the customer's or its contact's, an order
// not placed, no account to send from. Standalone: spec-local organizations, customer, contact, users, mail server and
// account; the mail capture keeps the sends. Run: ./moq test mr-mantle --spec OrderConfirmations
const prefix = "OCF"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    contact = prefix + "_CONTACT",
    stranger = prefix + "_STRANGER",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.order.OrderConfirmationServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const capture = ec.factory.getTool("MailCapture")
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
function party(partyId, name, roleTypeId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function email(partyId, address) {
    const contactMechId = call("create#mantle.party.contact.ContactMech", {
        contactMechTypeEnumId: "CmtEmailAddress",
        infoString: address
    }).contactMechId
    call("create#mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId,
        contactMechPurposeId: "EmailPrimary",
        fromDate: since
    })
}
function user(kind, permissions, organizationPartyId) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Order confirmation " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Confirmation", lastName: kind})
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
// a sales order of the organization to the customer, its lines made at one time and placed at a later one
function salesOrder(orderId, placed, productStoreId = null, vendorPartyId = org) {
    const now = Number(ec.user.nowTimestamp)
    call("create#mantle.order.OrderHeader", {
        orderId,
        statusId: "OrderOpen",
        currencyUomId: "USD",
        entryDate: now - 7200000,
        productStoreId
    })
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId,
        customerPartyId: customer,
        statusId: "OrderOpen"
    })
    ec.user.setEffectiveTime(now - 3600000)
    try {
        for (const [orderItemSeqId, quantity, unitAmount] of [
            ["01", 2, 10],
            ["02", 1, 25]
        ])
            call("create#mantle.order.OrderItem", {
                orderId,
                orderItemSeqId,
                orderPartSeqId: "01",
                itemTypeEnumId: "ItemProduct",
                itemDescription: "Confirmation spec item " + orderItemSeqId,
                quantity,
                unitAmount
            })
    } finally {
        ec.user.setEffectiveTime(null)
    }
    if (placed) call("update#mantle.order.OrderHeader", {orderId, statusId: "OrderPlaced", placedDate: now - 1800000})
}
// the message once its send commits (send#Draft sends after the commit, on a service worker)
function messageOf(emailMessageId) {
    const end = Date.now() + 5000
    let message = one("moqui.basic.email.EmailMessage", {emailMessageId})
    while (message && !["ES_SENT", "ES_BOUNCED"].includes(message.statusId) && message.sendError == null && Date.now() < end)
        message = one("moqui.basic.email.EmailMessage", {emailMessageId})
    return message
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        capture.enable()
        party(org, "Confirmation Spec Org", "OrgInternal")
        party(otherOrg, "Confirmation Spec Other Org", "OrgInternal")
        party(customer, "Confirmation Spec Customer", "Customer")
        party(contact, "Confirmation Contact", null, "PtyPerson")
        party(stranger, "Confirmation Stranger", null, "PtyPerson")
        email(customer, "orders@confirmation-customer.example")
        email(contact, "Buyer@Confirmation-Customer.example")
        email(stranger, "someone@elsewhere.example")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: contact,
            toPartyId: customer,
            fromDate: since
        })
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT", "PRICE_VIEW"], org)
        state.reader = user("READER", [], org)
        state.outsider = user("OUTSIDER", ["SUPPORT_CASE_EDIT"], otherOrg)
        state.noAccount = user("NOACCOUNT", ["SUPPORT_CASE_EDIT"], org)
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_MAIL",
            smtpHost: "127.0.0.1",
            smtpPort: 9,
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailAccount", {
            emailAccountId: prefix + "_ACCOUNT",
            ownerPartyId: org,
            accountKindEnumId: "EakShared",
            emailServerId: prefix + "_MAIL",
            emailAddress: "service@confirmation-org.example",
            accountName: "Confirmation spec service mail",
            statusId: "EasActive",
            recordFilingEnumId: "ErfLinkedOnly"
        })
        for (const userId of [state.agent, state.outsider])
            call("create#moqui.basic.email.EmailAccountUser", {
                emailAccountId: prefix + "_ACCOUNT",
                userId,
                fromDate: since,
                permissionEnumId: "EapSend"
            })
        salesOrder(prefix + "_SO", true)
        salesOrder(prefix + "_SO_OPEN", false)
        // after placement the customer's change of line 01 (2 to 5) and a line 03 added: the confirmation as placed still
        // says 2 and has no line 03
        call("update#mantle.order.OrderItem", {orderId: prefix + "_SO", orderItemSeqId: "01", quantity: 5})
        const added = {orderPartSeqId: "01", itemTypeEnumId: "ItemProduct", quantity: 1, unitAmount: 7}
        call(
            "create#mantle.order.OrderItem",
            Object.assign({orderId: prefix + "_SO", orderItemSeqId: "03"}, added, {
                itemDescription: "Confirmation spec item added later"
            })
        )
        // a store order with a line added after placement: Mantle recalculates its promotion, shipping and tax lines, deleting
        // the placed ones, which the audit log cannot bring back
        call("create#mantle.product.store.ProductStore", {
            productStoreId: prefix + "_STORE",
            storeName: "Confirmation spec store",
            organizationPartyId: org
        })
        salesOrder(prefix + "_SO_STORE", true, prefix + "_STORE")
        // the other organization stores its confirmations at placement (orderConfirmationOnPlace); the spec's own is off
        call("create#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: otherOrg,
            baseCurrencyUomId: "USD",
            orderConfirmationOnPlace: "Y"
        })
        salesOrder(prefix + "_SO_AUTO", false, null, otherOrg)
        call("create#mantle.order.OrderItem", Object.assign({orderId: prefix + "_SO_STORE", orderItemSeqId: "03"}, added))
    },
    cleanupSpec() {
        capture.reset()
        ec.artifactExecution.enableAuthz()
    }
})

feature("the first resend renders the order as placed, stores it once and sends it to the customer's checked address", {
    when() {
        capture.clear()
        const printed = run(state.agent, S + "get#OrderConfirmationPrint", {orderId: prefix + "_SO"})
        const first = run(state.agent, S + "resend#OrderConfirmation", {
            orderId: prefix + "_SO",
            toAddress: "Orders@Confirmation-Customer.example",
            note: "As you asked on the phone",
            operationKey: prefix + "-first"
        })
        const message = first.emailMessageId ? messageOf(first.emailMessageId) : null
        const sent = capture.getMessages().find(row => row.toList.includes("orders@confirmation-customer.example")) || null
        const record = first.emailMessageId
            ? one("mantle.order.OrderEmailMessage", {orderId: prefix + "_SO", emailMessageId: first.emailMessageId})
            : null
        const contents = rows("mantle.order.OrderContent", {
            orderId: prefix + "_SO",
            orderContentTypeEnumId: "OctOrderConfirmation"
        })
        // line 01 as placed: 2, not the 5 it was changed to after
        const html = String(printed.printHtml || "")
        const asPlaced =
            html.includes('<td class="amount">2 ') &&
            !html.includes('<td class="amount">5 ') &&
            !html.includes("Confirmation spec item added later")
        return {printed, html, asPlaced, first, message, sent, record, contents}
    },
    then({printed, html, asPlaced, first, message, sent, record, contents}) {
        printed.error == ""
        html.includes("Confirmation spec item 01")
        asPlaced
        first.error == ""
        first.stored == true
        first.recipient == "orders@confirmation-customer.example"
        first.recipientPartyId == customer
        first.emailAccountId == prefix + "_ACCOUNT"
        contents.length == 1
        first.orderContentId == contents[0].orderContentId
        record.orderContentId == contents[0].orderContentId
        record.partyId == customer
        record.roleTypeId == "Customer"
        message.statusId == "ES_SENT"
        sent.attachmentNames.includes("OrderConfirmation-" + prefix + "_SO.pdf")
    }
})

feature("a retry answers the first send; a second resend to a contact is a second message of the same stored content", {
    when() {
        const retry = run(state.agent, S + "resend#OrderConfirmation", {
            orderId: prefix + "_SO",
            toAddress: "Orders@Confirmation-Customer.example",
            note: "As you asked on the phone",
            operationKey: prefix + "-first"
        })
        const second = run(state.agent, S + "resend#OrderConfirmation", {
            orderId: prefix + "_SO",
            toAddress: "buyer@confirmation-customer.example",
            operationKey: prefix + "-second"
        })
        const records = rows("mantle.order.OrderEmailMessage", {orderId: prefix + "_SO"})
        const contents = rows("mantle.order.OrderContent", {
            orderId: prefix + "_SO",
            orderContentTypeEnumId: "OctOrderConfirmation"
        })
        return {retry, second, records, contents}
    },
    then({retry, second, records, contents}) {
        retry.error == ""
        retry.alreadyApplied == true
        second.error == ""
        second.stored == false
        second.recipientPartyId == contact
        second.emailMessageId != retry.emailMessageId
        records.length == 2
        records.every(row => row.orderContentId == contents[0].orderContentId)
        contents.length == 1
    }
})

feature("placement stores the confirmation only for an organization that turned it on; a failed resend is cancelled", {
    when() {
        const stored = orderId => rows("mantle.order.OrderContent", {orderId, orderContentTypeEnumId: "OctOrderConfirmation"})
        // the default (off): the spec organization's order placed in setup had none until its first resend
        const defaultRecord = one("mantle.order.OrderEmailMessage", {orderId: prefix + "_SO"})
        const placed = run(state.agent, "update#mantle.order.OrderHeader", {
            orderId: prefix + "_SO_AUTO",
            statusId: "OrderPlaced",
            placedDate: ec.user.nowTimestamp
        })
        // after the placement commits, in a transaction of its own
        const end = Date.now() + 10000
        let auto = stored(prefix + "_SO_AUTO")
        while (!auto.length && Date.now() < end) auto = stored(prefix + "_SO_AUTO")
        // a resend whose send fails (no capture: the spec's mail server refuses the connection, and the mail client puts it in
        // the Outbox with a sendError) is cancelled
        capture.disable()
        let resent
        try {
            resent = run(state.agent, S + "resend#OrderConfirmation", {
                orderId: prefix + "_SO",
                toAddress: "orders@confirmation-customer.example",
                operationKey: prefix + "-failed"
            })
            messageOf(resent.emailMessageId)
        } finally {
            capture.enable()
        }
        const failed = one("moqui.basic.email.EmailMessage", {emailMessageId: resent.emailMessageId})
        return {defaultRecord, placed, auto, failed}
    },
    then({defaultRecord, placed, auto, failed}) {
        defaultRecord != null
        placed.error == ""
        auto.length == 1
        failed.statusId == "ES_CANCELLED"
        failed.sendError != null
    }
})

feature(
    "a resend is refused without permission, for another organization's or a missing order, an unchecked recipient, an open order, no account and a store order changed since placement; the print without price read",
    {
        when() {
            const resend = (username, orderId, toAddress, key) =>
                code(run(username, S + "resend#OrderConfirmation", {orderId, toAddress, operationKey: prefix + "-" + key}))
            return {
                reader: resend(state.reader, prefix + "_SO", "orders@confirmation-customer.example", "reader"),
                outsider: resend(state.outsider, prefix + "_SO", "orders@confirmation-customer.example", "outsider"),
                missing: resend(state.agent, prefix + "_NONE", "orders@confirmation-customer.example", "missing"),
                stranger: resend(state.agent, prefix + "_SO", "someone@elsewhere.example", "stranger"),
                invalid: resend(state.agent, prefix + "_SO", "not an address", "invalid"),
                open: resend(state.agent, prefix + "_SO_OPEN", "orders@confirmation-customer.example", "open"),
                noAccount: resend(state.noAccount, prefix + "_SO", "orders@confirmation-customer.example", "noaccount"),
                changed: resend(state.agent, prefix + "_SO_STORE", "orders@confirmation-customer.example", "changed"),
                noPriceRead: code(run(state.noAccount, S + "get#OrderConfirmationPrint", {orderId: prefix + "_SO"})),
                openStored: rows("mantle.order.OrderContent", {orderId: prefix + "_SO_OPEN"}).length
            }
        },
        then({reader, outsider, missing, stranger, invalid, open, noAccount, changed, noPriceRead, openStored}) {
            reader == "PERMISSION_DENIED"
            outsider == "RECORD_UNAVAILABLE"
            missing == "RECORD_UNAVAILABLE"
            stranger == "RECIPIENT_UNCHECKED"
            invalid == "RECIPIENT_INVALID"
            open == "ORDER_NOT_PLACED"
            noAccount == "SEND_ACCOUNT_REQUIRED"
            changed == "ORDER_CHANGED_SINCE_PLACED"
            noPriceRead == "PERMISSION_DENIED"
            openStored == 0
        }
    }
)
