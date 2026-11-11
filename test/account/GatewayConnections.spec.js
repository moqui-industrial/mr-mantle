// Mantle's gateway connection adapters and the organizations a payment gateway is permitted for, mantle.account
// .GatewayConnectionServices through the framework's org.moqui.admin.ConfigurationServices (mr-boss plan/impl-admin.md P11,
// F10; design-admin §8.1, ConnectionDetail): a gateway is started only as a registered provider type, with that type's
// service names; its usage agrees with its provider's address and its options are typed; its connection keeps the
// framework's rules (a write-only secret, an endpoint change clears it and disables the connection); and
// PaymentGatewayOrganization is written by one service, dated, at the revision read, a binding in use ended from now on and
// never deleted. No request leaves the machine (the HTTP fixtures are on and count none).
// Run: ./moq test mr-mantle --spec GatewayConnections
const C = "org.moqui.admin.ConfigurationServices."
const G = "mantle.account.GatewayConnectionServices."
const CONFIG = "mantle.account.method.PaymentGatewayConfig"
const BINDING = "mantle.account.method.PaymentGatewayOrganization"
const REMOTE = "moqui.service.message.SystemMessageRemote"
const METHOD_ENTITY = "mantle.account.method.PaymentMethod"
const ids = {
    anet: "SPEC_GWC_ANET",
    trace: "SPEC_GWC_TRACE",
    shippo: "SPEC_GWC_SHIPPO",
    local: "SPEC_GWC_LOCAL",
    other: "SPEC_GWC_OTHER"
}
const org = "SPEC_GWC_ORG"
const method = "SPEC_GWC_METHOD"
const users = {manage: "SPEC_GWC_MANAGE", none: "SPEC_GWC_NONE"}
const group = "SPEC_GWC_MANAGERS"
const secret = "spec-gwc-key-8h3w"

const http = ec.factory.getTool("HttpFixtures")
const find = (entityName, conditions = {}) => ec.entity.find(entityName).condition(conditions).disableAuthz()
const one = (entityName, conditions) => find(entityName, conditions).one()
const make = (entityName, fields) => {
    const row = ec.entity.makeValue(entityName)
    row.setFields(fields, true, null, null)
    row.create()
}
function as(userId, action) {
    ec.user.internalLoginUser(userId.toLowerCase().replace(/_/g, "."))
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        ec.user.internalLoginUser("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function invoke(name, parameters = {}) {
    try {
        const result = ec.service.sync().name(name).parameters(parameters).call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        ec.message.clearErrors()
        return Object.assign({}, result, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
const get = (adapterKey, connectionKey) => invoke(C + "get#Connection", {adapterKey, connectionKey}).connection
const store = (adapterKey, connectionKey, values, extra = {}) =>
    invoke(
        C + "store#Connection",
        Object.assign({adapterKey, connectionKey, values, expectedRevision: get(adapterKey, connectionKey)?.revision}, extra)
    )
const start = (adapterKey, values) => invoke(C + "store#Connection", {adapterKey, values})
const binding = paymentGatewayConfigId => one(BINDING, {organizationPartyId: org, paymentGatewayConfigId})
const revision = paymentGatewayConfigId => {
    const row = binding(paymentGatewayConfigId)
    return row ? String(Number(row.lastUpdatedStamp)) : ""
}
// as john.doe, an instance administrator, with authorization on: every organization is in scope
function admin(action) {
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        ec.artifactExecution.disableAuthz()
    }
}
const bind = (paymentGatewayConfigId, parameters = {}) =>
    invoke(
        G + "store#PaymentGatewayOrganization",
        Object.assign(
            {organizationPartyId: org, paymentGatewayConfigId, expectedRevision: revision(paymentGatewayConfigId)},
            parameters
        )
    )

spec({
    setupSpec() {
        http.enable()
        ec.user.internalLoginUser("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [key, userId] of Object.entries(users))
            make("moqui.security.UserAccount", {
                userId,
                username: userId.toLowerCase().replace(/_/g, "."),
                userFullName: "Spec gateways " + key
            })
        make("moqui.security.UserGroup", {userGroupId: group, description: "Spec gateway managers"})
        for (const userPermissionId of ["ADMIN_CONNECTION_VIEW", "ADMIN_CONNECTION_MANAGE"])
            make("moqui.security.UserGroupPermission", {userGroupId: group, userPermissionId, fromDate: 0})
        make("moqui.security.UserGroupMember", {userGroupId: group, userId: users.manage, fromDate: 0})
        make("mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        make("mantle.party.Organization", {partyId: org, organizationName: "Spec gateway organization"})
        make("mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        // local test gateways, as Mantle's own: no connection
        for (const paymentGatewayConfigId of [ids.local, ids.other])
            make(CONFIG, {
                paymentGatewayConfigId,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Spec local gateway",
                authorizeServiceName: "mantle.account.PaymentTestServices.alwaysApprove#PaymentAuthorization"
            })
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        http.reset()
        ec.message.clearErrors()
        ec.artifactExecution.disableAuthz()
        const keys = Object.values(ids)
        ec.entity.find(METHOD_ENTITY).condition("paymentMethodId", method).deleteAll()
        ec.entity.find(BINDING).condition("organizationPartyId", org).deleteAll()
        ec.entity.find("moqui.server.ConnectionCheck").condition("connectionKey", "in", keys).deleteAll()
        for (const entityName of [
            "mantle.account.method.PaymentGatewayAuthorizeNet",
            "mantle.account.method.PaymentGatewayPayTrace",
            CONFIG
        ])
            ec.entity.find(entityName).condition("paymentGatewayConfigId", "in", keys).deleteAll()
        ec.entity
            .find("mantle.shipment.carrier.ShippingGatewayConfig")
            .condition("shippingGatewayConfigId", "in", keys)
            .deleteAll()
        ec.entity.find(REMOTE).condition("systemMessageRemoteId", "in", keys).deleteAll()
        ec.entity.find("mantle.party.PartyRole").condition("partyId", org).deleteAll()
        ec.entity.find("mantle.party.Organization").condition("partyId", org).deleteAll()
        ec.entity.find("mantle.party.Party").condition("partyId", org).deleteAll()
        ec.entity.find("moqui.security.UserGroupPermission").condition("userGroupId", group).deleteAll()
        ec.entity.find("moqui.security.UserGroupMember").condition("userId", "in", Object.values(users)).deleteAll()
        ec.entity.find("moqui.security.UserGroup").condition("userGroupId", group).deleteAll()
        ec.entity.find("moqui.security.UserAccount").condition("userId", "in", Object.values(users)).deleteAll()
        ec.artifactExecution.enableAuthz()
    }
})
feature("a gateway is a registered provider type with that type's services, and its address, usage and options are validated", {
    when() {
        const out = {}
        as(users.manage, () => {
            out.kinds = invoke(C + "find#Connections", {adapterGroup: "integration", text: "Spec local"})
            out.testType = start("paymentGateway", {
                connectionId: ids.anet,
                description: "Spec test",
                gatewayTypeEnumId: "PgtTest"
            })
            out.anet = start("paymentGateway", {
                connectionId: ids.anet,
                description: "Spec Authorize.Net",
                gatewayTypeEnumId: "PgtAuthorizeNet",
                authorizeServiceName: "spec.Evil#Service"
            })
            out.credentials = store("paymentGateway", ids.anet, {
                username: "spec-login",
                password: secret,
                authorizeServiceName: "spec.Evil#Service"
            })
            out.read = get("paymentGateway", ids.anet)
            out.usage = store("paymentGateway", ids.anet, {usageCode: "P"})
            // the live address without the key: the stored key is cleared and the connection stays disabled
            out.live = store("paymentGateway", ids.anet, {
                sendUrl: "https://api.authorize.net/xml/v1/request.api",
                usageCode: "P"
            })
            out.unsent = invoke(C + "test#Connection", {adapterKey: "paymentGateway", connectionKey: ids.anet})
            out.requests = http.count()
            out.trace = start("paymentGateway", {
                connectionId: ids.trace,
                description: "Spec PayTrace",
                gatewayTypeEnumId: "PgtPayTrace"
            })
            out.merchant = store("paymentGateway", ids.trace, {merchantId: "not-a-number"})
            out.currency = store("paymentGateway", ids.trace, {currencyUomId: "SPEC_NO_CURRENCY"})
            out.options = store("paymentGateway", ids.trace, {merchantId: "123456", integratorId: "SPEC1", currencyUomId: "USD"})
            out.shippo = start("shippingGateway", {
                connectionId: ids.shippo,
                description: "Spec Shippo",
                gatewayTypeEnumId: "ShGtwyShippo"
            })
            out.mode = store("shippingGateway", ids.shippo, {testMode: "N"})
            out.local = get("paymentGateway", ids.local)
            out.localTest = invoke(C + "test#Connection", {adapterKey: "paymentGateway", connectionKey: ids.local})
            out.tax = get("taxGateway", "LOCAL")
            out.taxNew = start("taxGateway", {connectionId: "SPEC_GWC_TAX", description: "Spec tax"})
            out.remoteUse = invoke(C + "find#ConnectionConsumers", {adapterKey: "remote", connectionKey: ids.anet})
            // the gateway's connection is not repointed as a plain remote, past the gateway's own validation
            out.asRemote = get("remote", ids.anet)
            out.asRemoteStore = store("remote", ids.anet, {sendUrl: "https://elsewhere.example.com/api"})
            out.asRemoteTest = invoke(C + "test#Connection", {adapterKey: "remote", connectionKey: ids.anet})
            out.asRemoteRequests = http.count()
            // the adapter itself is no service a user calls
            out.direct = invoke(G + "run#GatewayConnectionAdapter", {
                operation: "get",
                adapterKey: "paymentGateway",
                connectionKey: ids.anet
            })
        })
        out.config = one(CONFIG, {paymentGatewayConfigId: ids.anet}).getMap()
        out.remote = one(REMOTE, {systemMessageRemoteId: ids.anet}).getMap()
        out.anetOptions = one("mantle.account.method.PaymentGatewayAuthorizeNet", {paymentGatewayConfigId: ids.anet})?.getMap()
        out.traceOptions = one("mantle.account.method.PaymentGatewayPayTrace", {paymentGatewayConfigId: ids.trace}).getMap()
        out.shipping = one("mantle.shipment.carrier.ShippingGatewayConfig", {shippingGatewayConfigId: ids.shippo}).getMap()
        out.none = as(users.none, () => get("paymentGateway", ids.local))
        context.out = out
    },
    then() {
        const out = context.out
        // Mantle's kinds are registered, each started only as one of its provider types
        const payment = out.kinds.adapterList.find(row => row.adapterKey === "paymentGateway")
        payment.creatable === true && payment.organizationBinding === true
        JSON.stringify(payment.typeOptions.map(row => row.value)) === JSON.stringify(["PgtAuthorizeNet", "PgtPayTrace"])
        out.kinds.connectionList.some(row => row.connectionKey === ids.local && row.adapterKey === "paymentGateway")
        out.testType.reasonCode === "UNSUPPORTED_TYPE"
        // the type's service names, never one that was entered; its connection saved disabled at the provider's address
        out.anet.applied === true
        out.config.authorizeServiceName === "mantle.ext.account.gateway.AuthorizeNetServices.authorize#Payment"
        out.config.systemMessageRemoteId === ids.anet
        out.anetOptions.validationMode === "none"
        out.credentials.applied === true
        out.read.secretList.find(row => row.name === "password").secretSet === true
        !JSON.stringify(out.read).includes(secret)
        out.read.state === "needsTest"
        out.read.fieldList.some(row => row.name === "publicClientKey")
        !out.read.fieldList.some(row => row.name === "merchantId" || row.name === "authorizeServiceName")
        // the test address is not production's; the live address without the key clears the key
        out.usage.reasonCode === "USAGE_MISMATCH"
        out.live.applied === true && out.live.secretCleared === true && out.live.enabled === false
        out.remote.sendUrl === "https://api.authorize.net/xml/v1/request.api"
        out.remote.password == null
        out.remote.disabled === "Y"
        out.unsent.passed === false
        !out.unsent.checkList.some(row => row.check === "Address")
        out.requests === 0
        // a gateway started here receives nothing by a secret: its connection takes a signed-in, authorized sender only
        out.remote.messageAuthEnumId === "SmatLogin"
        // typed options
        out.merchant.error.includes("digits")
        out.currency.error.includes("not a currency")
        out.options.applied === true
        out.traceOptions.merchantId === "123456" && out.traceOptions.currencyUomId === "USD"
        out.shippo.applied === true
        out.shipping.requestLabelsServiceName === "mantle.ext.shipment.ShippoServices.request#ShippingLabels"
        out.shipping.testMode === "Y"
        out.mode.reasonCode === "USAGE_MISMATCH"
        // a local gateway has no connection: nothing to enter, nothing reached
        out.local.secretList.length === 0
        out.local.state === "ready"
        out.localTest.passed === true
        out.tax.connectionKey === "LOCAL"
        out.taxNew.reasonCode === "NOT_CREATABLE"
        out.remoteUse.consumerList.some(row => row.recordType === "PaymentGatewayConfig" && row.recordId === ids.anet)
        out.asRemote.state === "readOnly" && out.asRemote.readOnlyReason.includes("Spec Authorize.Net")
        out.asRemoteStore.reasonCode === "READ_ONLY" && out.asRemoteTest.reasonCode === "READ_ONLY"
        out.asRemoteRequests === 0
        !!out.direct.error
        out.none == null
    }
})

feature("a payment gateway is permitted for an organization by one dated service, and a binding in use is ended from now on", {
    when() {
        const out = {}
        const before = Date.now()
        admin(() => {
            out.stale = invoke(G + "store#PaymentGatewayOrganization", {
                organizationPartyId: org,
                paymentGatewayConfigId: ids.local,
                expectedRevision: "1"
            })
            out.permitted = bind(ids.local, {reason: "Spec: the organization takes cards"})
            out.detail = get("paymentGateway", ids.local)
            out.listed = invoke(C + "find#Connections", {adapterKey: "paymentGateway", organizationPartyId: org})
        })
        out.row = binding(ids.local).getMap()
        // a payment method of the organization takes payments through it
        ec.artifactExecution.disableAuthz()
        make(METHOD_ENTITY, {
            paymentMethodId: method,
            ownerPartyId: org,
            paymentMethodTypeEnumId: "PmtCreditCard",
            paymentGatewayConfigId: ids.local
        })
        admin(() => {
            out.past = bind(ids.local, {thruDate: before - 10 * 86400000})
            out.again = bind(ids.local, {isEnabled: true})
            out.later = bind(ids.local, {fromDate: before + 10 * 86400000})
            out.removed = bind(ids.local, {remove: true, reason: "Spec: the contract ended"})
            out.consumers = invoke(C + "find#ConnectionConsumers", {adapterKey: "paymentGateway", connectionKey: ids.local})
            // one not in use may end at any date after its start, and never before it
            out.other = bind(ids.other, {fromDate: before - 20 * 86400000, thruDate: before - 10 * 86400000})
            out.dates = bind(ids.other, {thruDate: before - 30 * 86400000})
            out.unbound = invoke(G + "store#PaymentGatewayOrganization", {
                organizationPartyId: org,
                paymentGatewayConfigId: ids.anet,
                remove: true
            })
        })
        out.removedRow = binding(ids.local)?.getMap()
        out.audit = Array.from(
            find("moqui.entity.EntityAuditLog", {
                changedEntityName: BINDING,
                pkPrimaryValue: org,
                pkSecondaryValue: ids.local
            }).list()
        ).map(row => row.getMap())
        // without the organization in scope, or without the permission, nothing is written
        out.outside = as(users.manage, () => bind(ids.other, {isEnabled: true}))
        out.none = as(users.none, () => bind(ids.other, {isEnabled: true}))
        out.otherRow = binding(ids.other).getMap()
        out.before = before
        context.out = out
    },
    then() {
        const out = context.out
        out.stale.reasonCode === "STALE_REVISION"
        out.permitted.applied === true && out.permitted.active === true
        out.row.isEnabled === "Y" && Number(out.row.fromDate) >= out.before - 1000 && out.row.thruDate == null
        out.detail.organizationList.some(row => row.organizationPartyId === org && row.active === true)
        out.listed.connectionList.map(row => row.connectionKey).join() === ids.local
        // in use: an end in the past is an end now; enabled again it starts a new period; it cannot start later
        out.past.applied === true && out.past.endedProspectively === true
        Date.parse(out.past.thruDate) >= out.before - 1000
        out.again.applied === true && out.again.active === true && out.again.thruDate == null
        out.later.reasonCode === "IN_USE"
        out.removed.applied === true && out.removed.endedProspectively === true && out.removed.active === false
        out.removed.reason.includes("1 payment method")
        out.removedRow != null && Number(out.removedRow.thruDate) >= out.before - 1000
        out.consumers.consumerList.some(row => row.recordId === org && row.state === "attention")
        out.audit.some(row => row.changeReason === "Spec: the organization takes cards")
        out.audit.some(row => row.changedFieldName === "thruDate" && row.changeReason === "Spec: the contract ended")
        out.other.applied === true && out.other.active === false
        out.dates.reasonCode === "DATES_INVALID"
        out.unbound.reasonCode === "NOT_BOUND"
        out.outside.error.includes("is not available")
        out.none.error.includes("ADMIN_CONNECTION_MANAGE")
        out.otherRow.isEnabled === "Y" && Number(out.otherRow.thruDate) < out.before
    }
})
