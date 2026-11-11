// Mantle's connection adapters and the organizations a payment gateway is permitted for, mantle.account
// .GatewayConnectionServices (mr-boss plan/design-admin.md §8.1, Connections, ConnectionDetail, §14 "Connection adapter";
// impl-admin P11, F10). The payment, shipping and tax gateway configurations stay the native records their owners read
// (PaymentGatewayConfig with its type's options and its SystemMessageRemote, ShippingGatewayConfig with its remote,
// TaxGatewayConfig); the framework's org.moqui.admin.ConfigurationServices lists, reads, changes and tests them through
// run#GatewayConnectionAdapter, built with the framework's engine (ConfigurationConnections.js lib.engine), so the
// write-only secrets, the endpoint-change rule and the test mark are the same as every other kind's. Mantle adds its own
// validation:
// - a gateway is of a provider type registered here, whose service names are the type's: an administrator never enters
//   an executable name, and a gateway is started only as one of these types;
// - a gateway's address is one of its provider's on a production instance, and its usage code agrees with the address
//   (a sandbox address is test, the live one production);
// - the type's options are typed (a merchant id is digits, a currency is one, the windows are seconds within limits).
//
// store#PaymentGatewayOrganization is the one writer of PaymentGatewayOrganization (F10): which internal organization may
// use a payment gateway, from when, until when and whether it is enabled, at the revision read, with the reason in the
// audit log. A binding is never deleted: one that payment methods or stores of the organization still name is ended from
// now on at the earliest, so what they started keeps its gateway for reconciliation. Accounting (PaymentMethods) and
// Commerce (checkout) read the enabled, current rows as before and change no credential.
//
// Reading needs ADMIN_CONNECTION_VIEW, a change ADMIN_CONNECTION_MANAGE, and an organization is one the caller
// administers (Identity.js scope(): the organization filters of the authorization the call runs under). Stands without
// BOSS.
const lib = ec.resource.script("component://framework/service/org/moqui/admin/ConfigurationLib.js")
const connections = ec.resource.script("component://framework/service/org/moqui/admin/ConfigurationConnections.js").lib
const identityLib = () => ec.resource.script("component://mr-mantle/service/mantle/party/Identity.js")
const {find, one, rows, map, ms, iso, stamp, text, refused, plainText} = lib
const {patternText, numberText, hostOf, VIEW, MANAGE, REMOTE} = connections

const CONFIG = "mantle.account.method.PaymentGatewayConfig"
const BINDING = "mantle.account.method.PaymentGatewayOrganization"
const METHOD = "mantle.account.method.PaymentMethod"
const STORE = "mantle.product.store.ProductStore"
const STORE_GATEWAY = "mantle.product.store.ProductStorePaymentGateway"
const SHIPPING = "mantle.shipment.carrier.ShippingGatewayConfig"
const TAX = "mantle.other.tax.TaxGatewayConfig"
const production = () => text(System.getProperty("instance_purpose")) === "production"
const nowMs = () => ms(ec.user.nowTimestamp)
const current = (row, at = nowMs()) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const count = (entity, conditions) => Number(find(entity, conditions).count())
const enumName = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const organizationName = partyId =>
    one("mantle.party.Organization", {partyId})?.organizationName || one("mantle.party.Party", {partyId})?.pseudoId || partyId
const scopeIds = () => identityLib().scope().organizationIds

// ===== the provider types =====
// Each type a gateway is started as: its services (the type's, never entered), the hosts of its provider with the usage
// code of each (T test, P production), the address it starts with and its options part.
const ext = "mantle.ext.account.gateway."
const paymentTypes = {
    PgtAuthorizeNet: {
        label: "Authorize.Net",
        services: {
            authorizeServiceName: ext + "AuthorizeNetServices.authorize#Payment",
            captureServiceName: ext + "AuthorizeNetServices.capture#Payment",
            releaseServiceName: ext + "AuthorizeNetServices.release#Payment",
            refundServiceName: ext + "AuthorizeNetServices.refund#Payment",
            detailsServiceName: ext + "AuthorizeNetServices.get#PaymentGatewayDetails"
        },
        hosts: {"apitest.authorize.net": "T", "api.authorize.net": "P"},
        address: "https://apitest.authorize.net/xml/v1/request.api",
        optionsPart: "authorizeNet",
        options: {validationMode: "none", lookupGraceSeconds: 300},
        needs: "its API endpoint, API login id (the user) and transaction key (the password)",
        complete: remote => !!text(remote.sendUrl) && !!text(remote.username) && !!text(remote.password)
    },
    PgtPayTrace: {
        label: "PayTrace",
        services: {
            authorizeServiceName: ext + "PayTraceServices.authorize#Payment",
            captureServiceName: ext + "PayTraceServices.capture#Payment",
            releaseServiceName: ext + "PayTraceServices.release#Payment",
            refundServiceName: ext + "PayTraceServices.refund#Payment",
            detailsServiceName: ext + "PayTraceServices.get#PaymentGatewayDetails"
        },
        hosts: {"api.sandbox.paytrace.com": "T", "api.paytrace.com": "P"},
        address: "https://api.sandbox.paytrace.com",
        optionsPart: "payTrace",
        options: {lookupGraceSeconds: 300, sendEnhancedData: "Y"},
        needs: "its API base address, API user and password",
        complete: remote => !!text(remote.sendUrl) && !!text(remote.username) && !!text(remote.password)
    }
}
const shippingTypes = {
    ShGtwyShippo: {
        label: "Shippo",
        services: Object.fromEntries(
            [
                ["getOrderRateServiceName", "get#OrderShippingRate"],
                ["getShippingRatesBulkName", "get#ShippingRatesBulk"],
                ["getRateServiceName", "get#ShippingRate"],
                ["requestLabelsServiceName", "request#ShippingLabels"],
                ["findLabelServiceName", "find#ShippingLabels"],
                ["refundLabelsServiceName", "refund#ShippingLabels"],
                ["trackLabelsServiceName", "track#ShippingLabels"],
                ["validateAddressServiceName", "validate#ShippingPostalAddress"]
            ].map(([field, name]) => [field, "mantle.ext.shipment.ShippoServices." + name])
        ),
        // one host for test and live: the token decides, and the gateway's own test mode says which it is
        hosts: {"api.goshippo.com": ""},
        address: "https://api.goshippo.com",
        needs: "its API base and API token (the password)",
        complete: remote => !!text(remote.sendUrl) && !!text(remote.password)
    }
}
// a gateway's registered type, by its own name only (a type of another name is none of them)
const typeOf = (types, typeEnumId) => (typeEnumId && Object.hasOwn(types, typeEnumId) ? types[typeEnumId] : null)
const typeOptions = types => Object.entries(types).map(([value, type]) => ({value, label: type.label}))

// A gateway's own validation of its connection as it would be saved (after): the provider's address on a production
// instance, and a usage code that agrees with the address.
function addressRefusal(type, remote) {
    if (!type || !remote || !text(remote.sendUrl)) return null
    const host = hostOf(remote.sendUrl)
    const hosts = Object.keys(type.hosts)
    if (!Object.hasOwn(type.hosts, host)) {
        if (production())
            return refused(
                "PROVIDER_ADDRESS",
                "The address of a " + type.label + " gateway is at " + hosts.join(" or ") + ", not " + (host || "there")
            )
        return null
    }
    const usage = type.hosts[host]
    if (usage && text(remote.usageCode) && text(remote.usageCode) !== usage)
        return refused(
            "USAGE_MISMATCH",
            host +
                " is " +
                type.label +
                "'s " +
                (usage === "T" ? "test" : "production") +
                " address: its usage is " +
                usage +
                ", not " +
                text(remote.usageCode)
        )
    return null
}
const usageField = entry =>
    entry.name === "usageCode"
        ? Object.assign({}, entry, {
              validate: value => patternText(value, "The usage", /^[TP]$/, "is T (test) or P (production)", 1),
              help: "T for the provider's test environment, P for production"
          })
        : entry
const newId = (values, what) => {
    const id = text(values.connectionId)
    if (!/^[A-Za-z][A-Za-z0-9_]{2,39}$/.test(id))
        throw new Error(what + " id is 3 to 40 letters, digits or underscores, starting with a letter")
    if (!plainText(values.description, "The name")) throw new Error("Give the gateway a name")
    return id
}

// The connection of a gateway started here: its provider's test address, and what it receives only from a signed-in user
// authorized to receive system messages. /rest/sm takes a message of any type from whoever proves a remote's secret, so the
// provider's webhooks wait for an instance administrator to set how they are verified (Tools), and the webhook key of a
// gateway that has one is not entered here.
const newRemote = (id, values, type) => ({
    systemMessageRemoteId: id,
    description: text(values.description),
    sendUrl: type.address,
    usageCode: "T",
    messageAuthEnumId: "SmatLogin"
})

// ===== payment gateways =====
const remoteShared = connections.remoteFields("remote", "Connection: ", true)
const seconds = (what, max) => value => numberText(value, what, 0, max)
const paymentDefinition = {
    adapterKey: "paymentGateway",
    // created in this order: the connection, the gateway that names it, the type's options
    parts: {
        remote: {entity: REMOTE, keyField: "systemMessageRemoteId"},
        main: {entity: CONFIG, keyField: "paymentGatewayConfigId"},
        authorizeNet: {entity: "mantle.account.method.PaymentGatewayAuthorizeNet", keyField: "paymentGatewayConfigId"},
        payTrace: {entity: "mantle.account.method.PaymentGatewayPayTrace", keyField: "paymentGatewayConfigId"}
    },
    statePart: "remote",
    locate: key => {
        const config = one(CONFIG, {paymentGatewayConfigId: key})
        const type = config?.paymentGatewayTypeEnumId
        return {
            main: key,
            remote: config?.systemMessageRemoteId || null,
            authorizeNet: type === "PgtAuthorizeNet" ? key : null,
            payTrace: type === "PgtPayTrace" ? key : null
        }
    },
    fields: [
        {name: "description", label: "Name", kind: "text"},
        {name: "typeName", label: "Provider", kind: "display", read: parts => enumName(parts.main.paymentGatewayTypeEnumId)}
    ]
        .concat(remoteShared.fields.map(usageField))
        .concat([
            {
                name: "publicClientKey",
                part: "authorizeNet",
                label: "Public client key",
                kind: "text",
                validate: value => patternText(value, "The public client key", /^[A-Za-z0-9]{1,255}$/, "is letters and digits"),
                help: "Public: the browser gets it for Accept.js"
            },
            {
                name: "validationMode",
                part: "authorizeNet",
                label: "Card validation",
                kind: "choice",
                options: () => ["none", "testMode", "liveMode"].map(value => ({value, label: value}))
            },
            {
                name: "duplicateWindow",
                part: "authorizeNet",
                label: "Duplicate window (seconds)",
                kind: "number",
                validate: seconds("The duplicate window", 28800)
            },
            {
                name: "anetLookupGraceSeconds",
                column: "lookupGraceSeconds",
                part: "authorizeNet",
                label: "Lookup grace (seconds)",
                kind: "number",
                validate: seconds("The lookup grace", 86400)
            },
            {
                name: "merchantId",
                part: "payTrace",
                label: "Merchant id",
                kind: "text",
                retest: true,
                validate: value => patternText(value, "The merchant id", /^\d{1,20}$/, "is digits", 20)
            },
            {
                name: "integratorId",
                part: "payTrace",
                label: "Integrator id",
                kind: "text",
                validate: value =>
                    patternText(value, "The integrator id", /^[A-Za-z0-9]{1,12}$/, "is up to 12 letters or digits", 12)
            },
            {
                name: "currencyUomId",
                part: "payTrace",
                label: "Account currency",
                kind: "text",
                validate: value => {
                    const found = text(value)
                    if (found && !one("moqui.basic.Uom", {uomId: found, uomTypeEnumId: "UT_CURRENCY_MEASURE"}))
                        throw new Error(found + " is not a currency")
                    return found
                }
            },
            {
                name: "payTraceLookupGraceSeconds",
                column: "lookupGraceSeconds",
                part: "payTrace",
                label: "Lookup grace (seconds)",
                kind: "number",
                validate: seconds("The lookup grace", 86400)
            },
            {name: "sendEnhancedData", part: "payTrace", label: "Send level 2/3 data", kind: "flag"},
            {
                name: "commodityCode",
                part: "payTrace",
                label: "Default commodity code",
                kind: "text",
                validate: value =>
                    patternText(value, "The commodity code", /^[A-Za-z0-9-]{3,20}$/, "is 3 to 20 letters, digits or dashes", 20)
            },
            {
                name: "defaultUnitOfMeasure",
                part: "payTrace",
                label: "Default unit of measure",
                kind: "text",
                validate: value =>
                    patternText(value, "The unit of measure", /^[A-Za-z0-9]{1,12}$/, "is 1 to 12 letters or digits", 12)
            },
            {
                name: "customerLabelPrefix",
                part: "payTrace",
                label: "Customer label prefix",
                kind: "text",
                validate: value =>
                    patternText(
                        value,
                        "The label prefix",
                        /^[A-Za-z0-9_-]{1,20}$/,
                        "is up to 20 letters, digits, dashes or underscores",
                        20
                    )
            }
        ]),
    secrets: remoteShared.secrets,
    name: parts => parts.main.description || parts.main.paymentGatewayConfigId,
    providerName: parts =>
        typeOf(paymentTypes, parts.main.paymentGatewayTypeEnumId)?.label ||
        enumName(parts.main.paymentGatewayTypeEnumId) ||
        "Payment gateway",
    summary: parts => (parts.remote ? hostOf(parts.remote.sendUrl) : "Local, no connection"),
    listKeys: p => {
        const keys = Array.from(
            find(CONFIG).selectField("paymentGatewayConfigId").orderBy("paymentGatewayConfigId").limit(500).list()
        ).map(row => String(row.paymentGatewayConfigId))
        const organizationPartyId = text(p.organizationPartyId)
        if (!organizationPartyId) return keys
        if (!scopeIds().includes(organizationPartyId)) return []
        const bound = new Set(rows(BINDING, {organizationPartyId}).map(row => row.paymentGatewayConfigId))
        return keys.filter(key => bound.has(key))
    },
    readOnly: parts => connections.remoteReadOnly(parts.remote),
    incomplete: parts => {
        const type = typeOf(paymentTypes, parts.main.paymentGatewayTypeEnumId)
        if (!parts.remote) return type ? "The gateway has no connection: an instance administrator gives it one in Tools" : null
        if (type && !type.complete(parts.remote)) return "The gateway needs " + type.needs
        if (
            type &&
            parts.payTrace &&
            (!/^\d+$/.test(text(parts.payTrace.merchantId)) ||
                !text(parts.payTrace.integratorId) ||
                !text(parts.payTrace.currencyUomId))
        )
            return "The gateway needs its PayTrace merchant id, integrator id and account currency"
        return type ? null : connections.remoteIncomplete(parts.remote)
    },
    check: after => addressRefusal(typeOf(paymentTypes, after.main.paymentGatewayTypeEnumId), after.remote),
    test: (parts, context) =>
        parts.remote
            ? connections.remoteTest(parts.remote, context)
            : [{check: "Gateway", ok: true, text: "A local gateway with no connection: nothing is reached"}],
    newParts: values => {
        const typeEnumId = text(values.gatewayTypeEnumId)
        if (!Object.hasOwn(paymentTypes, typeEnumId))
            return refused(
                "UNSUPPORTED_TYPE",
                "A payment gateway is started as " +
                    typeOptions(paymentTypes)
                        .map(row => row.label)
                        .join(" or ")
            )
        const type = paymentTypes[typeEnumId]
        const id = newId(values, "A gateway's")
        return {
            connectionKey: id,
            parts: {
                remote: newRemote(id, values, type),
                main: Object.assign(
                    {paymentGatewayConfigId: id, paymentGatewayTypeEnumId: typeEnumId, systemMessageRemoteId: id},
                    type.services
                ),
                authorizeNet:
                    type.optionsPart === "authorizeNet" ? Object.assign({paymentGatewayConfigId: id}, type.options) : null,
                payTrace: type.optionsPart === "payTrace" ? Object.assign({paymentGatewayConfigId: id}, type.options) : null
            }
        }
    },
    listExtra: (parts, key) => {
        const scope = new Set(scopeIds())
        const names = rows(BINDING, {paymentGatewayConfigId: key})
            .filter(row => scope.has(row.organizationPartyId) && row.isEnabled !== "N" && current(row))
            .map(row => organizationName(row.organizationPartyId))
            .sort()
        return {organizationText: names.join(", ")}
    },
    extra: (parts, key) => {
        const scope = scopeIds()
        const bindings = rows(BINDING, {paymentGatewayConfigId: key}).map(map)
        const organizationList = bindings
            .filter(row => scope.includes(row.organizationPartyId))
            .map(row => Object.assign(bindingRow(row), usage(row.organizationPartyId, key)))
            .sort((a, b) => a.organizationName.localeCompare(b.organizationName))
        const bound = new Set(bindings.map(row => row.organizationPartyId))
        return {
            typeEnumId: parts.main.paymentGatewayTypeEnumId || "",
            remoteId: parts.remote ? parts.remote.systemMessageRemoteId : "",
            organizationList,
            // the count of the bindings of organizations the caller does not administer, never their names
            otherOrganizationCount: bindings.length - organizationList.length,
            organizationOptions: scope
                .filter(partyId => !bound.has(partyId))
                .map(partyId => ({value: partyId, label: organizationName(partyId)}))
                .sort((a, b) => a.label.localeCompare(b.label))
        }
    },
    consumers: (parts, key) => {
        const found = []
        const scope = new Set(scopeIds())
        for (const row of rows(BINDING, {paymentGatewayConfigId: key}).filter(row => scope.has(row.organizationPartyId))) {
            const used = usage(row.organizationPartyId, key)
            const active = row.isEnabled !== "N" && current(row)
            found.push({
                ownerName: "Accounting",
                recordType: "PaymentGatewayOrganization",
                recordId: row.organizationPartyId,
                recordName: organizationName(row.organizationPartyId),
                use:
                    used.paymentMethodCount +
                    (used.paymentMethodCount === 1 ? " payment method" : " payment methods") +
                    " of the organization take payments through it",
                state: active ? "ok" : used.paymentMethodCount ? "attention" : "ended"
            })
        }
        const stores = rows(STORE_GATEWAY, {paymentGatewayConfigId: key})
        for (const storeId of Array.from(new Set(stores.map(row => row.productStoreId)))) {
            const store = one(STORE, {productStoreId: storeId})
            if (!store || !scope.has(store.organizationPartyId)) continue
            found.push({
                ownerName: "Commerce",
                recordType: "ProductStore",
                recordId: storeId,
                recordName: store.storeName || storeId,
                use: "The store's checkout takes payments through it",
                state: "ok"
            })
        }
        return found
    }
}
// How an organization uses a payment gateway now: its payment methods and its stores' checkouts that name it.
function usage(organizationPartyId, paymentGatewayConfigId) {
    const storeIds = new Set(rows(STORE, {organizationPartyId}).map(row => row.productStoreId))
    return {
        paymentMethodCount: count(METHOD, {ownerPartyId: organizationPartyId, paymentGatewayConfigId}),
        storeCount: new Set(
            rows(STORE_GATEWAY, {paymentGatewayConfigId})
                .filter(row => storeIds.has(row.productStoreId))
                .map(row => row.productStoreId)
        ).size
    }
}
const bindingRow = row => ({
    organizationPartyId: row.organizationPartyId,
    organizationName: organizationName(row.organizationPartyId),
    fromDate: iso(row.fromDate),
    thruDate: iso(row.thruDate),
    isEnabled: row.isEnabled !== "N",
    active: row.isEnabled !== "N" && current(row),
    stateText:
        row.isEnabled === "N"
            ? "Not enabled"
            : current(row)
              ? "Permitted"
              : (ms(row.fromDate) ?? 0) > nowMs()
                ? "Permitted from a later date"
                : "Ended",
    revision: stamp(row)
})

// ===== shipping and tax gateways =====
const shippingRemote = connections.remoteFields("remote", "Connection: ", true)
const shippingDefinition = {
    adapterKey: "shippingGateway",
    parts: {
        remote: {entity: REMOTE, keyField: "systemMessageRemoteId"},
        main: {entity: SHIPPING, keyField: "shippingGatewayConfigId"}
    },
    statePart: "remote",
    locate: key => ({main: key, remote: one(SHIPPING, {shippingGatewayConfigId: key})?.systemMessageRemoteId || null}),
    fields: [
        {name: "description", label: "Name", kind: "text"},
        {name: "typeName", label: "Provider", kind: "display", read: parts => enumName(parts.main.shippingGatewayTypeEnumId)},
        {name: "testMode", label: "Test mode", kind: "flag", retest: true, help: "A test gateway's labels are not bought"}
    ].concat(shippingRemote.fields.map(usageField)),
    secrets: shippingRemote.secrets,
    name: parts => parts.main.description || parts.main.shippingGatewayConfigId,
    providerName: parts =>
        typeOf(shippingTypes, parts.main.shippingGatewayTypeEnumId)?.label ||
        enumName(parts.main.shippingGatewayTypeEnumId) ||
        "Shipping gateway",
    summary: parts => (parts.remote ? hostOf(parts.remote.sendUrl) : "Local, no connection"),
    listKeys: p =>
        text(p.organizationPartyId)
            ? []
            : Array.from(
                  find(SHIPPING).selectField("shippingGatewayConfigId").orderBy("shippingGatewayConfigId").limit(500).list()
              ).map(row => String(row.shippingGatewayConfigId)),
    readOnly: parts => connections.remoteReadOnly(parts.remote),
    incomplete: parts => {
        const type = typeOf(shippingTypes, parts.main.shippingGatewayTypeEnumId)
        if (!parts.remote) return type ? "The gateway has no connection: an instance administrator gives it one in Tools" : null
        if (type && !type.complete(parts.remote)) return "The gateway needs " + type.needs
        return type ? null : connections.remoteIncomplete(parts.remote)
    },
    check: after => {
        const refusal = addressRefusal(typeOf(shippingTypes, after.main.shippingGatewayTypeEnumId), after.remote)
        if (refusal) return refusal
        // a test gateway and a production usage code disagree, as a live gateway and a test one do
        const usageCode = text(after.remote?.usageCode)
        if (usageCode && (after.main.testMode === "Y") !== (usageCode === "T"))
            return refused("USAGE_MISMATCH", "Test mode and the usage disagree: a test gateway's usage is T, a live one's P")
        return null
    },
    test: (parts, context) =>
        parts.remote
            ? connections.remoteTest(parts.remote, context)
            : [{check: "Gateway", ok: true, text: "A local gateway with no connection: nothing is reached"}],
    newParts: values => {
        const typeEnumId = text(values.gatewayTypeEnumId)
        if (!Object.hasOwn(shippingTypes, typeEnumId))
            return refused(
                "UNSUPPORTED_TYPE",
                "A shipping gateway is started as " +
                    typeOptions(shippingTypes)
                        .map(row => row.label)
                        .join(" or ")
            )
        const type = shippingTypes[typeEnumId]
        const id = newId(values, "A gateway's")
        return {
            connectionKey: id,
            parts: {
                remote: newRemote(id, values, type),
                main: Object.assign(
                    {
                        shippingGatewayConfigId: id,
                        shippingGatewayTypeEnumId: typeEnumId,
                        systemMessageRemoteId: id,
                        testMode: "Y"
                    },
                    type.services
                )
            }
        }
    },
    extra: parts => ({
        typeEnumId: parts.main.shippingGatewayTypeEnumId || "",
        remoteId: parts.remote ? parts.remote.systemMessageRemoteId : ""
    }),
    consumers: (parts, key) => {
        const scope = new Set(scopeIds())
        const found = []
        const storeIds = Array.from(
            new Set(
                rows("mantle.product.store.ProductStoreShippingGateway", {shippingGatewayConfigId: key}).map(
                    row => row.productStoreId
                )
            )
        )
        for (const storeId of storeIds) {
            const store = one(STORE, {productStoreId: storeId})
            if (!store || !scope.has(store.organizationPartyId)) continue
            found.push({
                ownerName: "Commerce",
                recordType: "ProductStore",
                recordId: storeId,
                recordName: store.storeName || storeId,
                use: "The store's carriers are rated and labeled through it",
                state: "ok"
            })
        }
        const carriers = count("mantle.shipment.carrier.ShippingGatewayCarrier", {shippingGatewayConfigId: key})
        found.push({
            ownerName: "Warehouse",
            recordType: "ShippingGatewayCarrier",
            recordId: null,
            recordName: carriers + (carriers === 1 ? " carrier" : " carriers"),
            use: "Carriers bound to this gateway",
            state: "ok"
        })
        return found
    }
}
const taxDefinition = {
    adapterKey: "taxGateway",
    parts: {main: {entity: TAX, keyField: "taxGatewayConfigId"}},
    // a tax gateway has no connection of its own here: the local one calculates in place
    statePart: null,
    fields: [
        {name: "description", label: "Name", kind: "text"},
        {name: "typeName", label: "Provider", kind: "display", read: parts => enumName(parts.main.taxGatewayTypeEnumId)}
    ],
    secrets: [],
    name: parts => parts.main.description || parts.main.taxGatewayConfigId,
    providerName: parts => enumName(parts.main.taxGatewayTypeEnumId) || "Tax gateway",
    summary: () => "Local, no connection",
    listKeys: p =>
        text(p.organizationPartyId)
            ? []
            : Array.from(find(TAX).selectField("taxGatewayConfigId").orderBy("taxGatewayConfigId").limit(500).list()).map(row =>
                  String(row.taxGatewayConfigId)
              ),
    incomplete: parts =>
        text(parts.main.calculateServiceName)
            ? null
            : "The gateway has no calculation: an instance administrator sets it in Tools",
    test: () => [{check: "Gateway", ok: true, text: "A gateway with no connection: nothing is reached"}],
    extra: parts => ({typeEnumId: parts.main.taxGatewayTypeEnumId || "", remoteId: ""}),
    consumers: (parts, key) => {
        const scope = new Set(scopeIds())
        const found = rows(STORE, {taxGatewayConfigId: key})
            .filter(store => scope.has(store.organizationPartyId))
            .map(store => ({
                ownerName: "Commerce",
                recordType: "ProductStore",
                recordId: store.productStoreId,
                recordName: store.storeName || store.productStoreId,
                use: "The store's sales tax is calculated through it",
                state: "ok"
            }))
        for (const row of rows("mantle.ledger.config.PartyAcctgPreference", {taxGatewayConfigId: key}).filter(row =>
            scope.has(row.organizationPartyId)
        ))
            found.push({
                ownerName: "Accounting",
                recordType: "PartyAcctgPreference",
                recordId: row.organizationPartyId,
                recordName: organizationName(row.organizationPartyId),
                use: "The organization's invoices without a store are taxed through it",
                state: "ok"
            })
        return found
    }
}
const engines = {
    paymentGateway: connections.engine(paymentDefinition),
    shippingGateway: connections.engine(shippingDefinition),
    taxGateway: connections.engine(taxDefinition)
}
const kindOptions = {paymentGateway: paymentTypes, shippingGateway: shippingTypes, taxGateway: {}}

// run#GatewayConnectionAdapter: one operation of a gateway kind, for org.moqui.admin.ConfigurationServices.
function runGatewayConnectionAdapter(p) {
    lib.requireView(VIEW, MANAGE)
    const adapterKey = text(p.adapterKey)
    if (!Object.hasOwn(engines, adapterKey)) throw new Error("No gateway kind " + adapterKey)
    const result = engines[adapterKey].run(text(p.operation), p)
    // the provider types a gateway of the kind is started as, for the form that starts one
    if (text(p.operation) === "list") result.typeOptions = typeOptions(kindOptions[adapterKey])
    return {result}
}

// ===== store#PaymentGatewayOrganization =====
function dateMs(value, what) {
    if (value === undefined || value === null || value === "") return null
    const found = ms(value)
    if (found === null || Number.isNaN(found)) throw new Error(what + " is not a date")
    return found
}
function storePaymentGatewayOrganization(p) {
    lib.requireManage(MANAGE)
    const reason = lib.reasonText(p)
    const organizationPartyId = text(p.organizationPartyId)
    const paymentGatewayConfigId = text(p.paymentGatewayConfigId)
    // an organization the caller does not administer and one that is not internal are refused alike
    if (
        !organizationPartyId ||
        !scopeIds().includes(organizationPartyId) ||
        !one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"})
    )
        throw new Error("Organization " + organizationPartyId + " is not available")
    if (!paymentGatewayConfigId || !one(CONFIG, {paymentGatewayConfigId}))
        throw new Error("Payment gateway " + paymentGatewayConfigId + " is not available")
    const key = {organizationPartyId, paymentGatewayConfigId}
    const storedRow = find(BINDING, key).forUpdate(true).one()
    const stored = storedRow ? map(storedRow) : null
    const revision = stamp(stored)
    const used = usage(organizationPartyId, paymentGatewayConfigId)
    const out = extra => Object.assign({organizationPartyId, paymentGatewayConfigId}, used, extra)
    if (text(p.expectedRevision) !== revision)
        return refused(
            "STALE_REVISION",
            stored
                ? "The binding was changed since it was read; read it again and repeat the change"
                : "The binding was removed since it was read",
            out({revision})
        )
    const now = nowMs()
    const given = name => p[name] !== undefined && p[name] !== null && p[name] !== ""
    const yes = value => value === true || value === "true" || value === "Y"
    const ended = !!stored && ms(stored.thruDate) !== null && ms(stored.thruDate) <= now
    let isEnabled = given("isEnabled") ? (yes(p.isEnabled) ? "Y" : "N") : stored ? (stored.isEnabled === "N" ? "N" : "Y") : "Y"
    // a binding that had ended and is enabled again starts a new period now: its earlier one is in the audit log
    const reopened = ended && isEnabled === "Y" && yes(p.isEnabled) && !yes(p.remove) && !given("thruDate")
    let fromDate = given("fromDate") ? dateMs(p.fromDate, "The from date") : stored && !reopened ? ms(stored.fromDate) : now
    let thruDate = given("thruDate") ? dateMs(p.thruDate, "The thru date") : stored && !reopened ? ms(stored.thruDate) : null
    const inUse = used.paymentMethodCount > 0 || used.storeCount > 0
    let endedProspectively = false
    if (yes(p.remove)) {
        if (!stored) return refused("NOT_BOUND", "The gateway is not permitted for this organization", out({revision}))
        // never deleted: ended from now on, so what was started through it keeps its gateway for reconciliation
        thruDate = Math.min(thruDate ?? Infinity, now)
        if (ms(stored.thruDate) !== null && ms(stored.thruDate) <= now) thruDate = ms(stored.thruDate)
        endedProspectively = inUse
    }
    // a binding in use is not ended in the past: methods and stores that name it used it until now
    const wasActive = !!stored && stored.isEnabled !== "N" && current(stored, now)
    if (inUse && wasActive && thruDate !== null && thruDate < now) {
        thruDate = now
        endedProspectively = true
    }
    if (inUse && wasActive && fromDate !== null && fromDate > now && !yes(p.remove))
        return refused(
            "IN_USE",
            "Payment methods or stores of the organization use the gateway now: it cannot start at a later date",
            out({revision})
        )
    if (thruDate !== null && fromDate !== null && thruDate < fromDate) {
        if (yes(p.remove)) fromDate = thruDate
        else return refused("DATES_INVALID", "The binding ends before it starts", out({revision}))
    }
    const fields = {fromDate, thruDate, isEnabled}
    const changed =
        !stored ||
        ["fromDate", "thruDate"].some(name => ms(stored[name]) !== fields[name]) ||
        (stored.isEnabled === "N" ? "N" : "Y") !== isEnabled
    if (changed) {
        lib.auditReason(reason, ["fromDate", "thruDate", "isEnabled", "organizationPartyId", "paymentGatewayConfigId"])
        lib.write(BINDING, Object.assign({}, key, fields), !stored)
        // the entity audit-logs a change of a value, not the first row nor a value where there was none (an end date
        // set): those are recorded here
        if (!stored)
            lib.auditRow(
                BINDING,
                "isEnabled",
                organizationPartyId,
                paymentGatewayConfigId,
                null,
                isEnabled + " from " + iso(fromDate) + (thruDate ? " until " + iso(thruDate) : ""),
                reason
            )
        else
            for (const name of ["fromDate", "thruDate", "isEnabled"])
                if (
                    (stored[name] === null || stored[name] === undefined) &&
                    fields[name] !== null &&
                    (name !== "isEnabled" || isEnabled === "N")
                )
                    lib.auditRow(BINDING, name, organizationPartyId, paymentGatewayConfigId, null, String(fields[name]), reason)
    }
    const after = map(one(BINDING, key))
    const stillNamed = inUse && !(after.isEnabled !== "N" && current(after, now + 1))
    return out({
        applied: true,
        reasonCode: null,
        reason: stillNamed
            ? used.paymentMethodCount +
              (used.paymentMethodCount === 1 ? " payment method and " : " payment methods and ") +
              used.storeCount +
              (used.storeCount === 1 ? " store" : " stores") +
              " of the organization still name this gateway: they keep it for what they started and take nothing new through it until Accounting and Commerce choose another"
            : null,
        revision: stamp(after),
        fromDate: iso(after.fromDate),
        thruDate: iso(after.thruDate),
        isEnabled: after.isEnabled !== "N",
        active: after.isEnabled !== "N" && current(after, now + 1),
        endedProspectively
    })
}

// ===== where a framework connection is used by Mantle's records =====
// find#RemoteConsumers: the gateways whose connection a remote is and the store integration it binds.
function findRemoteConsumers(p) {
    lib.requireView(VIEW, MANAGE)
    const systemMessageRemoteId = text(p.connectionKey)
    const found = []
    for (const row of rows(CONFIG, {systemMessageRemoteId}))
        found.push({
            ownerName: "Payment gateways",
            recordType: "PaymentGatewayConfig",
            recordId: row.paymentGatewayConfigId,
            recordName: row.description || row.paymentGatewayConfigId,
            use: "The gateway's connection",
            state: "ok"
        })
    for (const row of rows(SHIPPING, {systemMessageRemoteId}))
        found.push({
            ownerName: "Shipping gateways",
            recordType: "ShippingGatewayConfig",
            recordId: row.shippingGatewayConfigId,
            recordName: row.description || row.shippingGatewayConfigId,
            use: "The gateway's connection",
            state: "ok"
        })
    const remote = one(REMOTE, {systemMessageRemoteId})
    const store = remote?.productStoreId ? one(STORE, {productStoreId: remote.productStoreId}) : null
    if (store && scopeIds().includes(store.organizationPartyId))
        found.push({
            ownerName: "Commerce",
            recordType: "ProductStore",
            recordId: store.productStoreId,
            recordName: store.storeName || store.productStoreId,
            use: "The store's integration",
            state: "ok"
        })
    return {consumerList: found}
}
// find#PrinterConsumers: the facilities that print a kind of document on a printer, those of the caller's organizations.
function findPrinterConsumers(p) {
    lib.requireView(VIEW, MANAGE)
    const networkPrinterId = text(p.connectionKey)
    const scope = new Set(scopeIds())
    const found = []
    let others = 0
    for (const row of rows("mantle.facility.FacilityPrinter", {networkPrinterId})) {
        const facility = one("mantle.facility.Facility", {facilityId: row.facilityId})
        if (!facility || !scope.has(facility.ownerPartyId)) {
            others += 1
            continue
        }
        found.push({
            ownerName: "Warehouse",
            recordType: "Facility",
            recordId: row.facilityId,
            recordName: facility.facilityName || row.facilityId,
            use: "Prints " + (enumName(row.printerPurposeEnumId) || "documents").toLowerCase(),
            state: row.thruDate && ms(row.thruDate) <= nowMs() ? "ended" : "ok"
        })
    }
    if (others)
        found.push({
            ownerName: "Warehouse",
            recordType: "Facility",
            recordId: null,
            recordName: others + (others === 1 ? " other facility binding" : " other facility bindings"),
            use: "Of organizations you do not administer",
            state: "ok"
        })
    return {consumerList: found}
}

const operations = {runGatewayConnectionAdapter, storePaymentGatewayOrganization, findRemoteConsumers, findPrinterConsumers}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown gateway connection operation " + op)
        return operations[op](parameters)
    }
})
