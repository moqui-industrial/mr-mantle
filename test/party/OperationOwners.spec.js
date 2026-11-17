// The owner services the framework's operation screens call as the caller (SEC-ADM-10): the store channel recovery
// (StoreChannelServices.find#MessageRecoveryTargets, recover#StoreMessage), the delivery ledger's mail outcomes
// (MessageServices.find#MailOutcomeOwners, recover#OwnedMailOutcome) and the forum's (DeliveryWorkerServices.find#MailOutcomeOwners).
// Every user may call them (MantleOperationOwners, data/PartyAccessData.xml), so an operator reaches them with no grant of
// its own; each refuses a caller without its permission by its own check. Authorization on, spec-local users and records.
// Run: ./moq test mr-mantle --spec OperationOwners
const SC = "mantle.product.StoreChannelServices.",
    MS = "mantle.party.MessageServices.",
    FW = "mantle.forum.DeliveryWorkerServices."
const ids = {store: "OPO_STORE", remote: "OPO_REMOTE", message: "OPO_MSG", operator: "OPO_OPERATOR", plain: "OPO_PLAIN"}
const since = "2026-01-01 00:00:00"

function user(id, permissions) {
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Owner", lastName: id})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Owner spec " + id})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
}
// a call as a user with authorization on: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.enableAuthz()
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
const notAuthorized = out => /not authorized/i.test(out.error || "")
const mailIds = {emailMessageIdList: ["OPO_NO_SUCH_MESSAGE"]}
const recoveryIds = () => ({targetKind: "SystemMessage", targetIdList: [ids.message]})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.product.store.ProductStore", {productStoreId: ids.store, storeName: "Owner spec store"})
        call("create#moqui.service.message.SystemMessageRemote", {
            systemMessageRemoteId: ids.remote,
            description: "Owner spec remote",
            productStoreId: ids.store,
            storeConnectorId: "ChannelOrders",
            systemMessageTypeId: "StoreChannelOrders"
        })
        call("create#moqui.service.message.SystemMessage", {
            systemMessageId: ids.message,
            systemMessageTypeId: "StoreChannelOrders",
            systemMessageRemoteId: ids.remote,
            statusId: "SmsgError",
            isOutgoing: "N",
            messageText: "{}"
        })
        user(ids.operator, ["ADMIN_OPERATION_VIEW"])
        user(ids.plain, [])
    },
    cleanupSpec() {
        ec.artifactExecution.enableAuthz()
    }
})

feature("an operator with no grant of the owner services of its own is answered by each", {
    when() {
        return {
            targets: run(ids.operator, SC + "find#MessageRecoveryTargets", recoveryIds()),
            ledger: run(ids.operator, MS + "find#MailOutcomeOwners", mailIds),
            forum: run(ids.operator, FW + "find#MailOutcomeOwners", mailIds)
        }
    },
    then({targets, ledger, forum}) {
        targets.error == ""
        Array.from(targets.targetList).length == 1
        ledger.error == "" && Array.from(ledger.ownerList).length == 0
        forum.error == "" && Array.from(forum.ownerList).length == 0
    }
})

feature("a caller without an owner's permission is refused by the service's own check, not by its grant", {
    when() {
        return {
            targets: run(ids.plain, SC + "find#MessageRecoveryTargets", recoveryIds()),
            retry: run(ids.plain, SC + "recover#StoreMessage", {
                targetKind: "SystemMessage",
                targetId: ids.message,
                action: "retry",
                reason: "spec",
                operationKey: "opo-retry"
            }),
            ledger: run(ids.plain, MS + "find#MailOutcomeOwners", mailIds),
            reconcile: run(ids.plain, MS + "recover#OwnedMailOutcome", {
                emailMessageId: "OPO_NO_SUCH_MESSAGE",
                ownerRef: "OPO_NO_SUCH_DELIVERY",
                action: "sent",
                reason: "spec"
            }),
            forum: run(ids.plain, FW + "find#MailOutcomeOwners", mailIds)
        }
    },
    then({targets, retry, ledger, reconcile, forum}) {
        // the store's message is answered as held: no state, no detail, no retry
        targets.error == ""
        Array.from(targets.targetList)[0].detailVisible == false
        Array.from(targets.targetList)[0].retryEligible == false
        Array.from(targets.targetList)[0].ownerStateText == ""
        !notAuthorized(retry) && /PERMISSION_DENIED|is required/.test(retry.error)
        !notAuthorized(ledger) && /PERMISSION_DENIED/.test(ledger.error)
        reconcile.error == "" && reconcile.applied == false && reconcile.reasonCode == "PERMISSION_DENIED"
        !notAuthorized(forum) && /PERMISSION_DENIED/.test(forum.error)
    }
})
