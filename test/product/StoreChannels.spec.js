// Store channel integrations and channel import (impl-commerce P13, COM-CHANNEL; mantle.product.StoreChannelServices,
// StoreChannels.js): a binding of a registered connector made and enabled by a store's channel operator with the
// operator's credentials never taken or returned; the permission, another organization and a store-limited staff member
// refused (F51); intake deduplicated by the store, remote, kind and external ID (a matching replay answers the original, a
// conflicting one is quarantined with its evidence, the same ID on another binding is new); a failing order not stopping
// its receipt and retried with its identity, once per operation key; a staged import previewed, guarded by its digest and
// committed once through the same connector path; an EDI partner's exceptions listed and its conflict not retried.
// Standalone: spec-local organizations, stores, users, products and remotes; artifact authorization disabled (the rules are
// the services' own checks). Run: ./moq test mr-mantle --spec StoreChannels
const I = "mantle.product.StoreChannelServices."
const SM = "moqui.service.message.SystemMessage"
const prefix = "STCH13"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    storeA: prefix + "_A1",
    storeA2: prefix + "_A2",
    storeB: prefix + "_B1",
    product: prefix + "_PROD",
    product2: prefix + "_PROD2",
    customer: prefix + "_CUST",
    remoteA2: prefix + "_RA2",
    remoteB: prefix + "_RB",
    edi: prefix + "_EDI"
}
const secret = "spec-secret-not-shown"

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
const list = (entity, conditions) =>
    system(() =>
        Array.from(ec.entity.find(entity).condition(conditions).useCache(false).disableAuthz().list()).map(row => row.getMap())
    )
function party(partyId, organization, name, roleTypeId) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: organization ? "PtyOrganization" : "PtyPerson"})
    if (organization) make("mantle.party.Organization", {partyId, organizationName: name})
    else make("mantle.party.Person", {partyId, firstName: "Channel", lastName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    party(id, false, kind, "StoreStaff")
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store channels " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
const users = {}
// a call as a user, in its own transaction: its result and its refusal ("" when it succeeds)
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
// the API's intake as the endpoint calls it (receive#IncomingSystemMessage's receive service), then each order consumed in
// its own transaction, as the framework's async consume does
function deliver(remoteId, orders) {
    return system(() => {
        const out = ec.service
            .sync()
            .name(I + "receive#ChannelOrders")
            .parameters({
                systemMessageTypeId: "StoreChannelOrders",
                systemMessageRemoteId: remoteId,
                messageText: JSON.stringify({orders})
            })
            .requireNewTransaction(true)
            .call()
        for (const systemMessageId of Array.from(out.systemMessageIdList))
            ec.service
                .sync()
                .name("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage")
                .parameters({systemMessageId, willRetry: false})
                .call()
        return out
    })
}
const order = (externalId, productId, quantity = "2", unitAmount = "10.00") => ({
    externalId,
    currencyUomId: "USD",
    items: [{lineId: "1", productId, quantity, unitAmount}],
    // a field outside the canonical order is neither kept nor shown
    buyerEmail: "someone@example.com"
})
const messageOf = (remoteId, externalId, statusId) =>
    list(SM, Object.assign({systemMessageRemoteId: remoteId, messageId: externalId}, statusId ? {statusId} : {}))
const state = {}

spec({
    setupSpec() {
        system(() => {
            party(orgA, true, "Channels A", "OrgInternal")
            party(orgB, true, "Channels B", "OrgInternal")
            for (const [productStoreId, organizationPartyId] of [
                [ids.storeA, orgA],
                [ids.storeA2, orgA],
                [ids.storeB, orgB]
            ])
                make("mantle.product.store.ProductStore", {
                    productStoreId,
                    storeName: "Channels " + productStoreId,
                    organizationPartyId,
                    defaultCurrencyUomId: "USD"
                })
            for (const productId of [ids.product, ids.product2])
                make("mantle.product.Product", {
                    productId,
                    productName: "Channel item " + productId,
                    productTypeEnumId: "PtService",
                    ownerPartyId: orgA
                })
            // the first product is sold by store A and A2; the second not yet (published later, then retried)
            for (const productStoreId of [ids.storeA, ids.storeA2])
                make("mantle.product.store.ProductStoreProduct", {
                    productStoreId,
                    productId: ids.product,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
            party(ids.customer, true, "Marketplace", "Customer")
            // organization A's own customer (Commerce F167: a binding's customer is the store organization's or shared)
            call("update#mantle.party.Party", {partyId: ids.customer, ownerPartyId: orgA})
            const channel = ["COMMERCE_VIEW", "COMMERCE_CHANNEL_OPERATE"]
            users.reader = user("reader", orgA, ["COMMERCE_VIEW", "COMMERCE_ORDER_VIEW"])
            users.operator = user("operator", orgA, channel)
            users.staff = user("staff", orgA, channel)
            users.other = user("other", orgB, channel)
            // the framework's operational recovery (mr-boss impl-admin P13): operators of each organization who also hold
            // the administration's operation permissions, and one who holds those alone
            const operation = ["ADMIN_OPERATION_VIEW", "ADMIN_OPERATION_MANAGE"]
            users.recoverer = user("recoverer", orgA, channel.concat(operation))
            users.otherRecoverer = user("otherrecoverer", orgB, channel.concat(operation))
            users.adminOnly = user("adminonly", orgA, operation)
            make("mantle.product.store.ProductStoreParty", {
                productStoreId: ids.storeA,
                partyId: users.staff,
                roleTypeId: "StoreStaff",
                fromDate: 0
            })
            // bindings of store A2 and of organization B's store, made as the operator would, credentials set
            for (const [systemMessageRemoteId, productStoreId] of [
                [ids.remoteA2, ids.storeA2],
                [ids.remoteB, ids.storeB]
            ])
                make("moqui.service.message.SystemMessageRemote", {
                    systemMessageRemoteId,
                    description: "Remote " + productStoreId,
                    productStoreId,
                    storeConnectorId: "ChannelOrders",
                    systemMessageTypeId: "StoreChannelOrders",
                    storeMappingVersion: 1,
                    storeMappingJson: JSON.stringify({customerPartyId: ids.customer}),
                    storeDisabled: "N",
                    messageAuthEnumId: "SmatHmacSha256",
                    sharedSecret: secret
                })
            // an EDI partner of store A (the EDI administrator's connection) with a conflicting document and a quarantine
            make("moqui.service.message.SystemMessageRemote", {
                systemMessageRemoteId: ids.edi,
                description: "EDI partner",
                systemMessageTypeId: "EdiX12"
            })
            make("mantle.edi.EdiConnection", {
                systemMessageRemoteId: ids.edi,
                productStoreId: ids.storeA,
                partnerPartyId: ids.customer
            })
            make("mantle.edi.EdiDocument", {
                ediDocumentId: prefix + "_DOC",
                directionEnumId: "EdiDirIn",
                systemMessageRemoteId: ids.edi,
                transactionSetId: "850",
                statusId: "EdocConflict",
                reasonCode: "PO_CONFLICT",
                errorText: "PO_CONFLICT: purchase order 4500 was received with other content\nsecond line",
                documentText: "ST*850*0001~BEG*00*SA*4500~",
                eventDate: ec.user.nowTimestamp
            })
            make("mantle.edi.EdiInterchange", {
                ediInterchangeId: prefix + "_ISA",
                directionEnumId: "EdiDirIn",
                systemMessageRemoteId: ids.edi,
                statusId: "EdinQuarantined",
                reasonCode: "SENDER_MISMATCH",
                interchangeText: "ISA*00*secret~",
                interchangeDate: ec.user.nowTimestamp
            })
        })
    }
})

feature(
    "a channel operator binds a registered connector; credentials stay the operator's and enabling waits for them; the scope holds",
    {
        when() {
            const problems = []
            const made = run(users.operator, I + "store#StoreIntegration", {
                productStoreId: ids.storeA,
                connectorId: "ChannelOrders",
                description: "Marketplace A",
                customerPartyId: ids.customer
            })
            if (made.error) problems.push("bind: " + made.error)
            state.remoteA = made.systemMessageRemoteId
            const remote = list("moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: state.remoteA})[0] || {}
            if (
                remote.storeDisabled !== "Y" ||
                remote.messageAuthEnumId !== "SmatHmacSha256" ||
                remote.productStoreId !== ids.storeA
            )
                problems.push("a new binding starts stopped with a signature required: " + JSON.stringify(remote))
            const enable = {systemMessageRemoteId: state.remoteA, enabled: "Y"}
            if (code(run(users.operator, I + "store#StoreIntegration", enable)) !== "CREDENTIALS_REQUIRED")
                problems.push("enabled with no credentials")
            // the operator sets the secret in the System tools; then the channel operator enables the intake
            system(() =>
                call("update#moqui.service.message.SystemMessageRemote", {
                    systemMessageRemoteId: state.remoteA,
                    sharedSecret: secret
                })
            )
            const enabled = run(users.operator, I + "store#StoreIntegration", enable)
            if (enabled.error) problems.push("enable: " + enabled.error)
            const got = run(users.operator, I + "get#StoreIntegration", {systemMessageRemoteId: state.remoteA})
            const answer = JSON.stringify(got)
            if (!got.integration?.enabled || got.integration.credentialsText !== "Set" || answer.includes(secret))
                problems.push("the binding reads enabled with credentials set and never their value: " + answer.slice(0, 300))
            const found = run(users.operator, I + "find#StoreIntegrations", {})
            const remoteIds = Array.from(found.integrations || []).map(row => row.systemMessageRemoteId)
            for (const id of [state.remoteA, ids.remoteA2, ids.edi])
                if (!remoteIds.includes(id)) problems.push("not listed " + id)
            if (remoteIds.includes(ids.remoteB)) problems.push("listed organization B's binding")
            for (const [username, service, parameters, expected] of [
                [users.reader, "find#StoreIntegrations", {}, "PERMISSION_DENIED"],
                [users.other, "get#StoreIntegration", {systemMessageRemoteId: state.remoteA}, "RECORD_UNAVAILABLE"],
                [users.staff, "get#StoreIntegration", {systemMessageRemoteId: ids.remoteA2}, "RECORD_UNAVAILABLE"],
                [
                    users.operator,
                    "store#StoreIntegration",
                    {productStoreId: ids.storeA, connectorId: "EdiX12", description: "x"},
                    "EDI_MANAGED"
                ],
                [
                    users.operator,
                    "store#StoreIntegration",
                    {systemMessageRemoteId: state.remoteA, customerPartyId: orgB},
                    "CUSTOMER_UNAVAILABLE"
                ]
            ]) {
                const out = run(username, I + service, parameters)
                if (code(out) !== expected)
                    problems.push(username + " " + service + ": " + (out.error || "allowed") + ", not " + expected)
            }
            if (problems.length) ec.logger.warn("PROBLEMS " + problems.join(" | "))
            return {problems: problems.join("\n")}
        },
        then(r) {
            r.problems == ""
        }
    }
)

feature(
    "intake keeps each order by store, remote, kind and external ID: a replay answers the original, a conflict is quarantined, a failure stops nothing and is retried with its identity",
    {
        when() {
            const problems = []
            deliver(state.remoteA, [order("E1", ids.product), order("E2", ids.product2), order("E3", ids.product, "1")])
            const e1 = messageOf(state.remoteA, "E1")[0] || {}
            const e2 = messageOf(state.remoteA, "E2")[0] || {}
            const e3 = messageOf(state.remoteA, "E3")[0] || {}
            if (!e1.orderId || !e3.orderId)
                problems.push("the good orders were not made: " + JSON.stringify([e1.statusId, e3.statusId]))
            const made = list("mantle.order.OrderHeader", {orderId: e1.orderId})[0] || {}
            if (made.statusId !== "OrderPlaced" || made.productStoreId !== ids.storeA || made.externalId !== "E1")
                problems.push("E1's order: " + JSON.stringify([made.statusId, made.productStoreId, made.externalId]))
            if (e2.orderId || e2.statusId !== "SmsgReceived" || Number(e2.failCount) !== 1)
                problems.push("E2 not failed: " + JSON.stringify(e2))
            // the replay, the conflict and the same ID on another binding
            deliver(state.remoteA, [order("E1", ids.product), order("E1", ids.product, "3")])
            deliver(ids.remoteA2, [order("E1", ids.product)])
            const again = messageOf(state.remoteA, "E1")
            const duplicate = again.find(
                row => row.statusId === "SmsgConsumed" && row.duplicateOfMessageId === e1.systemMessageId
            )
            const conflict = again.find(row => row.statusId === "SmsgRejected" && row.duplicateOfMessageId === e1.systemMessageId)
            if (!duplicate || duplicate.orderId !== e1.orderId) problems.push("the replay does not answer the original's order")
            const evidence = conflict
                ? list("moqui.service.message.SystemMessageError", {systemMessageId: conflict.systemMessageId})[0]?.errorText ||
                  ""
                : ""
            if (!/^CONFLICT: .*items\.0\.quantity 2 → 3/.test(evidence)) problems.push("the conflict's evidence: " + evidence)
            const other = messageOf(ids.remoteA2, "E1")[0] || {}
            if (!other.orderId || other.duplicateOfMessageId) problems.push("the same ID on another binding is not a new order")
            if (list("mantle.order.OrderHeader", {productStoreId: ids.storeA, externalId: "E1"}).length !== 1)
                problems.push("store A has not exactly one order E1")
            // the lists and the safe summary
            const failed = run(users.operator, I + "find#StoreMessages", {systemMessageRemoteId: state.remoteA, state: "failed"})
            const failedRow = Array.from(failed.messages || [])[0] || {}
            if (
                failed.messagesCount !== 1 ||
                failedRow.externalId !== "E2" ||
                !failedRow.retryable ||
                !/^ITEM_UNAVAILABLE/.test(failedRow.safeError)
            )
                problems.push("failed list: " + JSON.stringify(failed).slice(0, 300))
            const detail = run(users.operator, I + "get#StoreMessage", {systemMessageId: e2.systemMessageId})
            const shown = JSON.stringify(detail)
            if (
                shown.includes("someone@example.com") ||
                shown.includes("messageText") ||
                detail.summary?.lines?.[0]?.productId !== ids.product2
            )
                problems.push("the summary is not the canonical fields alone: " + shown.slice(0, 300))
            if (!Array.from(detail.findings || []).some(row => row.code === "ITEM_UNAVAILABLE"))
                problems.push("no mapping finding")
            if (code(run(users.other, I + "get#StoreMessage", {systemMessageId: e2.systemMessageId})) !== "RECORD_UNAVAILABLE")
                problems.push("organization B read A's message")
            // the same retry as a registered operational recovery (org.moqui.admin.OperationServices, mr-boss impl-admin
            // P13): offered to the store's own operator and no one else, a conflict never, and nothing settled or cancelled
            const R = "org.moqui.admin.OperationServices."
            deliver(state.remoteA, [order("E8", ids.product2)])
            const e8 = messageOf(state.remoteA, "E8")[0] || {}
            const previewOf = username =>
                run(username, R + "preview#Recovery", {
                    targetKind: "SystemMessage",
                    targetIdList: [e8.systemMessageId, conflict?.systemMessageId]
                })
            const offered = (preview, index, name) =>
                Array.from(Array.from(preview.previewList || [])[index]?.actionList || []).find(row => row.action === name) || {}
            const queueRow = username =>
                Array.from(
                    run(username, R + "find#Messages", {reference: e8.systemMessageId, state: "all"}).messageList || []
                )[0] || {}
            const recover = (username, operationKey) =>
                run(username, R + "execute#Recovery", {
                    targetKind: "SystemMessage",
                    action: "retry",
                    targetId: e8.systemMessageId,
                    expectedRevision: queueRow(username).revision,
                    reason: "Product published",
                    operationKey
                })
            const mine = previewOf(users.recoverer)
            if (
                !offered(mine, 0, "retry").eligible ||
                offered(mine, 0, "retry").mode !== "owner" ||
                offered(mine, 0, "reconcile").reasonCode !== "NOT_OFFERED" ||
                offered(mine, 0, "cancel").reasonCode !== "NOT_OFFERED" ||
                offered(mine, 1, "retry").reasonCode !== "NOT_FAILED"
            )
                problems.push("the recovery offered to the store's operator: " + JSON.stringify(mine).slice(0, 400))
            if (
                !/^ITEM_UNAVAILABLE/.test(queueRow(users.recoverer).errorText || "") ||
                queueRow(users.recoverer).ownerRef !== state.remoteA
            )
                problems.push("the queue row of the store's operator: " + JSON.stringify(queueRow(users.recoverer)).slice(0, 300))
            const theirs = previewOf(users.otherRecoverer)
            const theirRow = queueRow(users.otherRecoverer)
            if (
                offered(theirs, 0, "retry").reasonCode !== "OWNER_REFUSES" ||
                theirRow.retryEligible ||
                theirRow.errorText ||
                theirRow.ownerRef ||
                theirRow.messageId ||
                theirRow.ownerStateText ||
                JSON.stringify([theirs, theirRow]).includes("ITEM_UNAVAILABLE")
            )
                problems.push("organization B's operator on A's message: " + JSON.stringify([theirs, theirRow]).slice(0, 400))
            if (offered(previewOf(users.adminOnly), 0, "retry").reasonCode !== "OWNER_PERMISSION")
                problems.push("an administrator without the channel permission was offered the retry")
            const refusedB = recover(users.otherRecoverer, prefix + "-recover-b")
            const refusedAdmin = recover(users.adminOnly, prefix + "-recover-admin")
            // while the product is not sold the retry fails again, named, and the message stays as it was
            const failedAgain = recover(users.recoverer, prefix + "-recover-0")
            const e8Failed = list(SM, {systemMessageId: e8.systemMessageId})[0] || {}
            if (
                refusedB.reasonCode !== "OWNER_REFUSES" ||
                refusedAdmin.reasonCode !== "OWNER_PERMISSION" ||
                failedAgain.applied ||
                e8Failed.orderId ||
                Number(e8Failed.failCount) !== 2
            )
                problems.push(
                    "recovery refused or failing: " +
                        JSON.stringify([refusedB, refusedAdmin, failedAgain, e8Failed.failCount]).slice(0, 400)
                )
            // the product published, the failed order retried: the same message makes its order; a second submit answers it
            system(() =>
                make("mantle.product.store.ProductStoreProduct", {
                    productStoreId: ids.storeA,
                    productId: ids.product2,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
            )
            const retry = {
                systemMessageRemoteId: state.remoteA,
                systemMessageIds: [e2.systemMessageId, conflict?.systemMessageId].join(","),
                reason: "Product published",
                operationKey: prefix + "-retry-1"
            }
            const retried = run(users.operator, I + "retry#StoreMessages", retry)
            const results = Array.from(retried.results || [])
            const e2After = list(SM, {systemMessageId: e2.systemMessageId})[0] || {}
            if (retried.retriedCount !== 1 || !results[0]?.ok || !e2After.orderId || e2After.messageId !== "E2")
                problems.push("retry: " + JSON.stringify(retried).slice(0, 300))
            if (results[1]?.reasonCode !== "CONFLICT_REVIEW")
                problems.push("the conflict was retried: " + JSON.stringify(results[1]))
            const second = run(users.operator, I + "retry#StoreMessages", retry)
            if (
                !second.alreadyApplied ||
                list("mantle.order.OrderHeader", {productStoreId: ids.storeA, externalId: "E2"}).length !== 1
            )
                problems.push("a second submit did not answer the first")
            // and through the registered recovery: the same message makes its order once, and its key's repeat answers it
            const recovered = recover(users.recoverer, prefix + "-recover-1")
            const e8After = list(SM, {systemMessageId: e8.systemMessageId})[0] || {}
            const recoveredAgain = run(users.recoverer, R + "execute#Recovery", {
                targetKind: "SystemMessage",
                action: "retry",
                targetId: e8.systemMessageId,
                expectedRevision: "0",
                reason: "Product published",
                operationKey: prefix + "-recover-1"
            })
            if (
                !recovered.applied ||
                !e8After.orderId ||
                e8After.messageId !== "E8" ||
                !recoveredAgain.repeated ||
                list("mantle.order.OrderHeader", {productStoreId: ids.storeA, externalId: "E8"}).length !== 1
            )
                problems.push("recovery: " + JSON.stringify([recovered, recoveredAgain, e8After.statusId]).slice(0, 400))
            // an order unreadable as it came (its external ID too long) is kept failed and never made by a retry (review R2)
            const bad = {
                externalId: "X".repeat(61),
                items: [{lineId: "1", productId: ids.product, quantity: "1", unitAmount: "10.00"}]
            }
            deliver(ids.remoteA2, [bad])
            const unreadable = list(SM, {systemMessageRemoteId: ids.remoteA2, statusId: "SmsgError", docType: "ChannelOrder"})[0]
            const badRetry = run(users.operator, I + "retry#StoreMessages", {
                systemMessageRemoteId: ids.remoteA2,
                systemMessageIds: unreadable?.systemMessageId,
                reason: "Check",
                operationKey: prefix + "-retry-bad"
            })
            if (!unreadable || Array.from(badRetry.results || [])[0]?.reasonCode !== "NOT_RETRYABLE")
                problems.push("an unreadable order retried: " + JSON.stringify(badRetry).slice(0, 200))
            if (list("mantle.order.OrderHeader", {productStoreId: ids.storeA2}).length !== 1)
                problems.push("store A2 has an order beyond E1")
            // the API's intake refuses a stopped binding and one whose authentication was removed (the default stays HMAC)
            const receive = () =>
                code(
                    run("john.doe", I + "receive#ChannelOrders", {
                        systemMessageTypeId: "StoreChannelOrders",
                        systemMessageRemoteId: ids.remoteA2,
                        messageText: JSON.stringify({orders: [order("E9", ids.product)]})
                    })
                )
            const remoteA2 = changes =>
                system(() =>
                    call(
                        "update#moqui.service.message.SystemMessageRemote",
                        Object.assign({systemMessageRemoteId: ids.remoteA2}, changes)
                    )
                )
            remoteA2({storeDisabled: "Y"})
            const stopped = receive()
            remoteA2({storeDisabled: "N", messageAuthEnumId: "SmatNone"})
            const anonymous = receive()
            remoteA2({messageAuthEnumId: "SmatHmacSha256"})
            if (stopped !== "BINDING_DISABLED" || anonymous !== "BINDING_UNAUTHENTICATED")
                problems.push("intake through a stopped or unauthenticated binding: " + stopped + ", " + anonymous)
            if (messageOf(ids.remoteA2, "E9").length) problems.push("a refused intake kept an order")
            return {problems: problems.join("\n")}
        },
        then(r) {
            r.problems == ""
        }
    }
)

feature("a staged import previews each order, is guarded by its digest and commits once through the same connector path", {
    when() {
        const problems = []
        // E3 again as it was (a duplicate), E1 at another price (a conflict), E4 new, E5 of an unknown product
        const csv = [
            "externalId,lineId,productId,quantity,unitAmount",
            "E3,1," + ids.product + ",1,10.00",
            "E1,1," + ids.product + ",2,12.00",
            "E4,1," + ids.product + ",4,10.00",
            "E4,1," + ids.product + ",4,10.00",
            "E5,1,NO_SUCH_PRODUCT,1,1.00"
        ].join("\n")
        const prepared = run(users.operator, I + "prepare#ChannelImport", {
            systemMessageRemoteId: state.remoteA,
            formatEnumId: "SciCsv",
            importText: csv,
            fileName: "orders.csv"
        })
        const preview = Object.fromEntries(Array.from(prepared.rows || []).map(row => [row.rowKey, row.outcome]))
        if (JSON.stringify(preview) !== JSON.stringify({E3: "duplicate", E1: "conflict", E4: "new", E5: "error"}))
            problems.push("preview " + (prepared.error || JSON.stringify(preview)))
        const batchId = prepared.batch?.systemMessageId
        const again = run(users.operator, I + "prepare#ChannelImport", {
            systemMessageRemoteId: state.remoteA,
            formatEnumId: "SciCsv",
            importText: csv
        })
        if (again.batch?.systemMessageId !== batchId) problems.push("the same file staged twice")
        if (
            code(
                run(users.operator, I + "prepare#ChannelImport", {
                    systemMessageRemoteId: state.remoteA,
                    formatEnumId: "SciXml",
                    importText: csv
                })
            ) !== "FORMAT_UNSUPPORTED"
        )
            problems.push("an unregistered format was read")
        const commit = {systemMessageId: batchId, digest: prepared.batch?.digest, reason: "Marketplace export"}
        if (
            code(run(users.operator, I + "commit#ChannelImport", Object.assign({}, commit, {digest: "other"}))) !==
            "BATCH_CHANGED"
        )
            problems.push("committed with another digest")
        const done = run(users.operator, I + "commit#ChannelImport", commit)
        const outcomes = Object.fromEntries(Array.from(done.rows || []).map(row => [row.rowKey, row.outcome]))
        if (JSON.stringify(outcomes) !== JSON.stringify({E3: "duplicate", E1: "conflict", E4: "applied", E5: "failed"}))
            problems.push("commit " + (done.error || JSON.stringify(outcomes)))
        const twice = run(users.operator, I + "commit#ChannelImport", commit)
        if (
            !twice.alreadyApplied ||
            list("mantle.order.OrderHeader", {productStoreId: ids.storeA, externalId: "E4"}).length !== 1
        )
            problems.push("a second commit made another order")
        if (list("mantle.order.OrderHeader", {productStoreId: ids.storeA, externalId: "E3"}).length !== 1)
            problems.push("the duplicate made an order")
        if (twice.batch?.reason !== "Marketplace export") problems.push("the reason is not recorded")
        // the EDI partner: its exceptions listed with their first line only, a conflict not retried
        const edi = run(users.operator, I + "get#StoreIntegration", {systemMessageRemoteId: ids.edi})
        const docs = Array.from(edi.ediDocuments || [])
        if (
            docs.length !== 1 ||
            docs[0].safeError.includes("second line") ||
            JSON.stringify(edi).includes("ST*850") ||
            edi.ediInterchanges?.length !== 1
        )
            problems.push("EDI exceptions: " + (edi.error || JSON.stringify(edi).slice(0, 300)))
        const ediRetry = run(users.operator, I + "retry#StoreMessages", {
            systemMessageRemoteId: ids.edi,
            ediDocumentIds: prefix + "_DOC",
            reason: "Check",
            operationKey: prefix + "-edi"
        })
        if (Array.from(ediRetry.results || [])[0]?.reasonCode !== "NOT_RETRYABLE")
            problems.push("EDI conflict retried: " + JSON.stringify(ediRetry).slice(0, 200))
        return {problems: problems.join("\n")}
    },
    then(r) {
        r.problems == ""
    }
})

// Commerce P15 (F167, F168, F165, F169): a binding's customer is the store organization's own or shared (another
// organization's refused); a replay kept while its original had failed answers the original's order once a retry makes it; a
// batch is claimed under its lock, so a second claim of it finds it taken; a pasted import's 2 MiB limit counts bytes.
feature(
    "P15: the organization's own customer; a failed original's replay gets its order; a batch claimed once; the import limit in bytes",
    {
        when() {
            const problems = []
            const product3 = prefix + "_PROD3"
            system(() => {
                party(prefix + "_CUST_B", true, "Other marketplace", "Customer")
                call("update#mantle.party.Party", {partyId: prefix + "_CUST_B", ownerPartyId: orgB})
                make("mantle.product.Product", {
                    productId: product3,
                    productName: "Channel item " + product3,
                    productTypeEnumId: "PtService",
                    ownerPartyId: orgA
                })
            })
            for (const customerPartyId of [prefix + "_CUST_B"]) {
                const out = run(users.operator, I + "store#StoreIntegration", {
                    systemMessageRemoteId: state.remoteA,
                    customerPartyId
                })
                if (code(out) !== "CUSTOMER_UNAVAILABLE")
                    problems.push("bound customer " + customerPartyId + ": " + (out.error || "allowed"))
            }
            // E6 fails (its product not sold yet); its replay is kept a duplicate with no order; the retry makes the order for both
            deliver(state.remoteA, [order("E6", product3)])
            deliver(state.remoteA, [order("E6", product3)])
            const original = messageOf(state.remoteA, "E6").find(row => !row.duplicateOfMessageId) || {}
            system(() =>
                make("mantle.product.store.ProductStoreProduct", {
                    productStoreId: ids.storeA,
                    productId: product3,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
            )
            run(users.operator, I + "retry#StoreMessages", {
                systemMessageRemoteId: state.remoteA,
                systemMessageIds: original.systemMessageId,
                reason: "Product published",
                operationKey: prefix + "-retry-e6"
            })
            const after = messageOf(state.remoteA, "E6")
            const made = after.find(row => !row.duplicateOfMessageId)?.orderId
            const replay = after.find(row => row.duplicateOfMessageId === original.systemMessageId)
            if (!made || !replay || replay.orderId !== made)
                problems.push("the replay's order: " + JSON.stringify(after.map(row => [row.statusId, row.orderId])))
            // a staged batch claimed twice: the second finds it taken
            const prepared = run(users.operator, I + "prepare#ChannelImport", {
                systemMessageRemoteId: state.remoteA,
                formatEnumId: "SciCsv",
                importText: "externalId,lineId,productId,quantity,unitAmount\nE7,1," + ids.product + ",1,10.00"
            })
            const claim = () =>
                run(users.operator, I + "claim#ChannelImport", {systemMessageId: prepared.batch?.systemMessageId}).claimed
            const claims = [claim(), claim()]
            if (JSON.stringify(claims) !== "[true,false]")
                problems.push("claims " + JSON.stringify(claims) + " " + (prepared.error || ""))
            // 1.1 million two-byte characters: 2.2 MB, refused though under 2 Mi characters
            const large = run(users.operator, I + "prepare#ChannelImport", {
                systemMessageRemoteId: state.remoteA,
                formatEnumId: "SciCsv",
                importText: "é".repeat(1100000)
            })
            if (code(large) !== "IMPORT_TOO_LARGE") problems.push("a 2.2 MB text: " + (large.error || "accepted").slice(0, 200))
            return {problems: problems.join("\n")}
        },
        then(r) {
            r.problems == ""
        }
    }
)
