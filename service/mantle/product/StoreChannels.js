// Store channel integrations and channel import (impl-commerce P13, COM-CHANNEL; design-commerce §9): a store's bindings to
// registered connectors, their messages with safe summaries, retry with the message's identity, and ChannelImport's batches
// through the same connector path as the API's intake. (Feeds and channel health, P14, are in a module of their own.)
//
// A binding is a SystemMessageRemote with the store (productStoreId) and a registered connector (storeConnectorId, a
// StoreChannelConnector row with a handler in `connectors` below) with its mapping version and typed parameters. Its
// transport, authentication and credentials are the operator's, set in the System tools: no service here takes, changes or
// returns them; a binding says only whether credentials are set. A new binding starts with its intake stopped, and is enabled
// only once the operator has set an authentication method and its credentials. An EDI trading partner is the EDI
// administrator's (EdiConnection, plan/payments-shipping-edi.md E1): Commerce lists it, its rejected and quarantined
// transactions, and retries them through the EDI services with their identity.
//
// Intake (receive#ChannelOrders, the StoreChannelOrders message type's receive service, behind /rest/sm or a committed
// import): the receipt is kept as it came, then each order is its own message, kept by the four keys of design §9 (the
// store, the remote, the message kind and the external ID, SystemMessage.productStoreId, systemMessageRemoteId, docType and
// messageId) with the hash of its canonical content: a new one is Received and consumed in its own transaction
// (consume#ChannelOrder makes and places one order); a matching replay is kept Consumed as a duplicate of the original
// and answers its order; a conflicting one is kept Rejected, quarantined, with the evidence (what differs) in its error.
// A failing order does not stop the others; retrying it consumes the same message again (its ID and external ID), and an
// order already made for a message is never made twice.
//
// Every staff operation checks COMMERCE_VIEW, COMMERCE_CHANNEL_OPERATE and the store scope of StoreAdmin.js (the user's own
// organizations; a current StoreStaff row's stores, F51): a binding, a message or a batch outside it is refused as a
// missing one (RECORD_UNAVAILABLE). A message's text is never returned: its summary is the canonical fields, and its
// errors a first line. Decimals are read with their methods, never with + or comparison.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const stores = ec.resource.script("component://mr-mantle/service/mantle/product/StoreAdmin.js")
const {find, one, rows, denied, call, ms, dateText, access, json, hash, probe} = lib

const MESSAGE = "moqui.service.message.SystemMessage"
const REMOTE = "moqui.service.message.SystemMessageRemote"
const ERROR = "moqui.service.message.SystemMessageError"
const CONNECTOR = "mantle.product.store.StoreChannelConnector"
const STORE = "mantle.product.store.ProductStore"
const EDI_CONNECTION = "mantle.edi.EdiConnection"
const EDI_DOCUMENT = "mantle.edi.EdiDocument"
const EDI_INTERCHANGE = "mantle.edi.EdiInterchange"
const SERVICES = "mantle.product.StoreChannelServices."
const SM = "org.moqui.impl.SystemMessageServices."
const ORDER_TYPE = "StoreChannelOrders"
const IMPORT_TYPE = "StoreChannelImport"
const ORDER_KIND = "ChannelOrder"
const RECEIPT_KIND = "ChannelReceipt"

// ===== tables =====
const limits = {
    // orders in one receipt or import file, lines in one order
    orders: 500,
    lines: 200,
    // an import file's size
    bytes: 2 * 1024 * 1024,
    // the rows of a detail's lists
    detail: 50,
    // an error's first line as shown
    errorText: 240,
    // messages retried in one call
    retry: 100,
    // an external ID's length
    externalId: 60
}
// The handlers of the registered connectors (StoreChannelConnector rows): the mapping versions each implements and its typed
// parameters. A connector registered without a handler here is not offered.
const connectors = {
    ChannelOrders: {
        intake: true,
        imports: true,
        versions: [1],
        parameters: {
            customerPartyId: {label: "Customer", kind: "customer", required: true},
            salesChannelEnumId: {label: "Sales channel", kind: "enum", enumTypeId: "SalesChannel", fallback: "ScWebExternal"}
        }
    },
    EdiX12: {managed: "edi", versions: [1], parameters: {}}
}
const importFormats = {SciCsv: {label: "CSV", parse: parseCsv}, SciJson: {label: "JSON", parse: parseJson}}
// the remote's fields that hold a credential (read only to say whether one is set)
const credentialFields = ["password", "sharedSecret", "sendSharedSecret", "privateKey"]
// the EDI documents and interchanges a store's channel operator works (design §9: rejected and quarantined)
const ediExceptionStatuses = ["EdocRejected", "EdocConflict", "EdocException", "EdocRefused", "EdocAckRejected"]
const appliedStatuses = ["SmsgConsumed", "SmsgConfirmed", "SmsgSent"]

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const unique = list => Array.from(new Set(list.filter(Boolean)))
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const likeText = term => "%" + String(term).replace(/[\\%_]/g, character => "\\" + character) + "%"
const rowsIn = (entity, field, values, conditions = {}) =>
    values.length ? Array.from(find(entity, conditions).condition(field, "in", values).list()) : []
const storeName = productStoreId => one(STORE, {productStoreId})?.storeName || productStoreId || ""
const indicator = value => value === true || value === "true" || value === "Y"
// An error as shown: its first line, cut, never a stack or a payload.
function safeError(value) {
    const line = text(value)
        .split(/\r?\n/)[0]
        .replace(/^((Type|Reference)?Error:\s*)+/, "")
    return line.length > limits.errorText ? line.slice(0, limits.errorText - 1) + "…" : line
}
// A decimal as plain text (no exponent, no trailing zeros), or the text as given when it is not a number.
function decimalText(value) {
    if (value == null || text(value) === "") return null
    const raw = text(value)
    try {
        let out = String(toDecimal(raw))
        if (/e/i.test(out)) out = String(toDecimal(raw).toNumber())
        if (out.includes(".")) out = out.replace(/0+$/, "").replace(/\.$/, "")
        return out === "-0" ? "0" : out
    } catch (_) {
        return raw
    }
}
function decimalOf(value) {
    if (value == null || value === "") return null
    try {
        return toDecimal(String(value))
    } catch (_) {
        return null
    }
}
const moneyText = (value, currencyUomId) => {
    const decimal = decimalOf(value)
    return decimal == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(decimal, currencyUomId), currencyUomId)
}

// ===== scope =====
// COMMERCE_VIEW, COMMERCE_CHANNEL_OPERATE and the store scope: the user's stores by id (storeIds).
function scope() {
    const s = stores.scope("view")
    if (!access.has("COMMERCE_CHANNEL_OPERATE")) denied("PERMISSION_DENIED", "COMMERCE_CHANNEL_OPERATE is required")
    s.storeIds = Array.from(stores.storeQuery(s).selectField("productStoreId").orderBy("productStoreId").list()).map(
        row => row.productStoreId
    )
    s.orderView = access.has("COMMERCE_ORDER_VIEW")
    return s
}
const unavailable = (kind, id) => denied("RECORD_UNAVAILABLE", kind + " " + (id || "") + " is not available")
// A remote as a binding: its store (the remote's, or an EDI connection's) and connector.
function bindingOf(remote) {
    const connection = remote ? one(EDI_CONNECTION, {systemMessageRemoteId: remote.systemMessageRemoteId}) : null
    const productStoreId = remote?.productStoreId || connection?.productStoreId || null
    const connectorId = remote?.storeConnectorId || (connection ? "EdiX12" : null)
    return {remote, connection, productStoreId, connectorId, handler: connectors[connectorId] || null}
}
// The bindings of the user's stores (or one of them): remotes with a store and a connector, and EDI partners' remotes.
function storeBindings(s, storeIds) {
    if (!storeIds.length) return []
    const remotes = Array.from(
        find(REMOTE).condition("productStoreId", "in", storeIds).condition("storeConnectorId", "is-not-null", null).list()
    )
    const ediIds = rowsIn(EDI_CONNECTION, "productStoreId", storeIds).map(row => row.systemMessageRemoteId)
    const have = new Set(remotes.map(row => row.systemMessageRemoteId))
    for (const remote of rowsIn(
        REMOTE,
        "systemMessageRemoteId",
        ediIds.filter(id => !have.has(id))
    ))
        remotes.push(remote)
    return remotes.map(bindingOf).filter(b => b.productStoreId && storeIds.includes(b.productStoreId))
}
// A binding the user works; a missing one and one outside the scope are refused alike.
function bindingIn(s, systemMessageRemoteId, forUpdate = false) {
    const remote = systemMessageRemoteId ? find(REMOTE, {systemMessageRemoteId}).forUpdate(forUpdate).one() : null
    const b = bindingOf(remote)
    if (!remote || !b.connectorId || !b.productStoreId || !s.storeIds.includes(b.productStoreId))
        unavailable("Integration", systemMessageRemoteId)
    return b
}
// A message of a binding the user works.
function messageIn(s, systemMessageId) {
    const message = systemMessageId ? one(MESSAGE, {systemMessageId}) : null
    if (!message || !message.systemMessageRemoteId) unavailable("Message", systemMessageId)
    let b
    try {
        b = bindingIn(s, message.systemMessageRemoteId)
    } catch (_) {
        unavailable("Message", systemMessageId)
    }
    return {message, binding: b}
}
const registered = connectorId => {
    const row = connectorId ? one(CONNECTOR, {connectorId}) : null
    return row && row.disabled !== "Y" && connectors[connectorId] ? row : null
}
function credentialsSet(remote) {
    try {
        return credentialFields.some(field => text(remote[field]) !== "")
    } catch (error) {
        // a credential that will not decrypt is not a usable one (AGENTS.md: log it and go on)
        ec.logger.error("Store channel: credentials of remote " + remote.systemMessageRemoteId + " not read: " + error.message)
        return false
    }
}
const mappingOf = remote => json(remote?.storeMappingJson, {}) || {}

// ===== messages =====
const failedCondition = () => {
    const cf = ec.entity.conditionFactory
    return cf.makeCondition(
        [
            cf.makeCondition("statusId", "equals", "SmsgError"),
            cf.makeCondition(
                [cf.makeCondition("statusId", "equals", "SmsgReceived"), cf.makeCondition("failCount", "greater", 0)],
                "and"
            )
        ],
        "or"
    )
}
// A message's state for staff: its outcome, never a guess.
function stateOf(m) {
    const failed = Number(m.failCount || 0) > 0
    switch (m.statusId) {
        case "SmsgStaged":
            return {key: "staged", text: "Staged, not committed"}
        case "SmsgRejected":
            return m.duplicateOfMessageId ? {key: "conflict", text: "Conflict, quarantined"} : {key: "rejected", text: "Rejected"}
        case "SmsgConsumed":
        case "SmsgConfirmed":
            if (m.duplicateOfMessageId) return {key: "duplicate", text: "Duplicate of " + m.duplicateOfMessageId}
            return {
                key: "applied",
                text: m.docType === RECEIPT_KIND || m.systemMessageTypeId === IMPORT_TYPE ? "Received" : "Applied"
            }
        case "SmsgError":
            return {key: "failed", text: "Failed"}
        case "SmsgReceived":
            return failed ? {key: "failed", text: "Failed, waiting to retry"} : {key: "waiting", text: "Waiting"}
        case "SmsgConsuming":
            return {key: "waiting", text: "Processing"}
        case "SmsgProduced":
        case "SmsgSending":
            return {key: "waiting", text: "Waiting to send"}
        case "SmsgSent":
            return {key: "applied", text: "Sent"}
        case "SmsgCancelled":
            return {key: "cancelled", text: "Cancelled"}
        default:
            return {key: "other", text: statusText(m.statusId)}
    }
}
const stateConditions = {
    failed: query => query.condition(failedCondition()),
    conflict: query => query.condition("statusId", "SmsgRejected"),
    duplicate: query =>
        query
            .condition("statusId", "in", ["SmsgConsumed", "SmsgConfirmed"])
            .condition("duplicateOfMessageId", "is-not-null", null),
    applied: query => query.condition("statusId", "in", appliedStatuses).condition("duplicateOfMessageId", "is-null", null),
    waiting: query =>
        query
            .condition("statusId", "in", ["SmsgReceived", "SmsgConsuming", "SmsgProduced", "SmsgSending", "SmsgStaged"])
            .condition(
                ec.entity.conditionFactory.makeCondition(
                    [
                        ec.entity.conditionFactory.makeCondition("failCount", "is-null", null),
                        ec.entity.conditionFactory.makeCondition("failCount", "equals", 0)
                    ],
                    "or"
                )
            )
}
function kindText(m) {
    if (m.systemMessageTypeId === IMPORT_TYPE) return "Import batch"
    if (m.docType === ORDER_KIND) return "Order"
    if (m.docType === RECEIPT_KIND) return "Receipt"
    if (m.systemMessageTypeId === "EdiX12") return m.isOutgoing === "Y" ? "EDI interchange sent" : "EDI interchange"
    return (
        enumText(m.docType) ||
        one("moqui.service.message.SystemMessageType", {systemMessageTypeId: m.systemMessageTypeId})?.description ||
        ""
    )
}
// Whether a message is retried by retry#StoreMessages: an incoming channel order or EDI receipt that failed, an outgoing EDI
// interchange in error; never a conflict, a duplicate, an applied one or a batch.
function retryable(m) {
    if (m.duplicateOfMessageId || m.orderId) return false
    const failed = m.statusId === "SmsgError" || (m.statusId === "SmsgReceived" && Number(m.failCount || 0) > 0)
    if (!failed) return false
    // a channel order kept without its canonical content (unreadable as it came: no external ID, no hash) is never made
    if (m.systemMessageTypeId === ORDER_TYPE) return m.docType === ORDER_KIND && m.isOutgoing !== "Y" && !!m.contentHash
    if (m.systemMessageTypeId === "EdiX12") return m.isOutgoing !== "Y" || m.statusId === "SmsgError"
    return false
}
function latestErrors(messageIds) {
    const byMessage = new Map()
    for (const row of Array.from(
        find(ERROR)
            .condition("systemMessageId", "in", messageIds.length ? messageIds : ["_none_"])
            .orderBy("-errorDate")
            .list()
    )) {
        if (!byMessage.has(row.systemMessageId)) byMessage.set(row.systemMessageId, row)
    }
    return byMessage
}
function messageRow(m, errors) {
    const state = stateOf(m)
    const error = errors?.get(m.systemMessageId)
    return {
        systemMessageId: m.systemMessageId,
        systemMessageRemoteId: m.systemMessageRemoteId,
        kindText: kindText(m),
        direction: m.isOutgoing === "Y" ? "out" : "in",
        directionText: m.isOutgoing === "Y" ? "Sent" : "Received",
        externalId: m.messageId || "",
        stateKey: state.key,
        stateText: state.text,
        attempts: Number(m.failCount || 0),
        receivedText: dateText(m.initDate),
        processedText: dateText(m.processedDate),
        safeError:
            state.key === "failed" || state.key === "conflict" || state.key === "rejected" ? safeError(error?.errorText) : "",
        orderId: m.orderId || null,
        duplicateOfMessageId: m.duplicateOfMessageId || null,
        parentMessageId: m.parentMessageId || null,
        retryable: retryable(m)
    }
}

// ===== bindings =====
function bindingFacts(b) {
    const remoteId = b.remote.systemMessageRemoteId
    const failureCount = find(MESSAGE, {systemMessageRemoteId: remoteId}).condition(failedCondition()).count()
    const conflictCount = find(MESSAGE, {systemMessageRemoteId: remoteId, statusId: "SmsgRejected"}).count()
    const last = find(MESSAGE, {systemMessageRemoteId: remoteId})
        .condition("statusId", "in", appliedStatuses)
        .condition("processedDate", "is-not-null", null)
        .orderBy("-processedDate")
        .limit(1)
        .list()[0]
    const exceptionCount = b.connection
        ? find(EDI_DOCUMENT, {systemMessageRemoteId: remoteId}).condition("statusId", "in", ediExceptionStatuses).count() +
          find(EDI_INTERCHANGE, {systemMessageRemoteId: remoteId, statusId: "EdinQuarantined"}).count()
        : 0
    return {failureCount, conflictCount, exceptionCount, lastSuccess: last?.processedDate ?? null}
}
function healthOf(b, facts, enabled, credentials) {
    if (!enabled) return {key: "disabled", text: b.handler?.managed ? "Not connected" : "Intake stopped"}
    if (!credentials && !b.handler?.managed) return {key: "credentials", text: "Credentials not set"}
    if (facts.failureCount || facts.exceptionCount) return {key: "failing", text: "Failures to resolve"}
    if (facts.conflictCount) return {key: "conflicts", text: "Conflicts to review"}
    return facts.lastSuccess ? {key: "ok", text: "Working"} : {key: "idle", text: "No messages yet"}
}
function bindingRow(b) {
    const remote = b.remote
    const facts = bindingFacts(b)
    const registry = one(CONNECTOR, {connectorId: b.connectorId})
    // an EDI partner is enabled when its connection is (the EDI administrator's); another binding unless its intake is stopped
    const enabled = b.handler?.managed ? !!b.connection : remote.storeDisabled !== "Y" && registry?.disabled !== "Y"
    const credentials = b.handler?.managed ? true : credentialsSet(remote)
    const mapping = mappingOf(remote)
    const health = healthOf(b, facts, enabled, credentials)
    return {
        systemMessageRemoteId: remote.systemMessageRemoteId,
        description: remote.description || remote.systemMessageRemoteId,
        productStoreId: b.productStoreId,
        storeName: storeName(b.productStoreId),
        connectorId: b.connectorId,
        connectorText: registry?.description || b.connectorId,
        direction: registry?.direction || "",
        managed: b.handler?.managed || null,
        enabled,
        credentialsText: b.handler?.managed ? "The EDI administrator's" : credentials ? "Set" : "Not set",
        authText: b.handler?.managed ? "" : enumText(remote.messageAuthEnumId) || "Not set",
        mappingVersion: remote.storeMappingVersion ?? registry?.mappingVersion ?? null,
        customerPartyId: mapping.customerPartyId || null,
        customerName: mapping.customerPartyId ? partyName(mapping.customerPartyId) : "",
        salesChannelEnumId: mapping.salesChannelEnumId || null,
        salesChannelText: enumText(mapping.salesChannelEnumId || b.handler?.parameters?.salesChannelEnumId?.fallback),
        ediProfileId: b.connection?.ediProfileId || null,
        lastSuccessText: dateText(facts.lastSuccess),
        failureCount: facts.failureCount,
        conflictCount: facts.conflictCount,
        exceptionCount: facts.exceptionCount,
        healthKey: health.key,
        healthText: health.text,
        lastUpdatedStamp: remote.lastUpdatedStamp
    }
}
function partyName(partyId) {
    return lib.partyNames([partyId])[partyId] || partyId
}

// find#StoreIntegrations: the bindings of the user's stores (or one), by connector, enabled and health.
function findStoreIntegrations(p) {
    const s = scope()
    const storeIds = p.productStoreId ? [stores.storeOf(s, p.productStoreId).productStoreId] : s.storeIds
    let list = storeBindings(s, storeIds)
    if (p.connectorId) list = list.filter(b => b.connectorId === p.connectorId)
    let integrations = list.map(bindingRow)
    if (p.enabled === "Y" || p.enabled === "N") integrations = integrations.filter(row => row.enabled === (p.enabled === "Y"))
    if (p.health) integrations = integrations.filter(row => row.healthKey === p.health)
    integrations.sort((a, b) => a.storeName.localeCompare(b.storeName) || a.description.localeCompare(b.description))
    return {integrations, integrationsCount: integrations.length}
}

// The connectors a store's channel operator may bind (registered, enabled, with a handler, not the EDI administrator's).
function connectorOptions() {
    return Array.from(find(CONNECTOR).orderBy("description").list())
        .filter(row => row.disabled !== "Y" && connectors[row.connectorId] && !connectors[row.connectorId].managed)
        .map(row => ({value: row.connectorId, label: row.description || row.connectorId}))
}

// get#StoreIntegration: one binding with its mapping fields and, for an EDI partner, its rejected and quarantined transactions.
function getStoreIntegration(p) {
    const s = scope()
    const b = bindingIn(s, p.systemMessageRemoteId)
    const integration = bindingRow(b)
    const mapping = mappingOf(b.remote)
    const parameterFields = Object.entries(b.handler?.parameters || {}).map(([name, def]) => ({
        name,
        label: def.label,
        kind: def.kind,
        required: !!def.required,
        value: mapping[name] ?? null
    }))
    const out = {
        integration,
        parameterFields,
        mappingVersions: (b.handler?.versions || []).map(version => ({value: String(version), label: "Version " + version})),
        importFormats: b.handler?.imports
            ? Object.entries(importFormats).map(([value, format]) => ({value, label: enumText(value) || format.label}))
            : [],
        ediDocuments: [],
        ediInterchanges: []
    }
    if (b.connection) {
        const remoteId = b.remote.systemMessageRemoteId
        out.ediDocuments = Array.from(
            find(EDI_DOCUMENT, {systemMessageRemoteId: remoteId})
                .condition("statusId", "in", ediExceptionStatuses)
                .orderBy("-eventDate")
                .limit(limits.detail)
                .list()
        ).map(doc => ediDocumentRow(doc))
        out.ediInterchanges = Array.from(
            find(EDI_INTERCHANGE, {systemMessageRemoteId: remoteId, statusId: "EdinQuarantined"})
                .orderBy("-interchangeDate")
                .limit(limits.detail)
                .list()
        ).map(row => ({
            ediInterchangeId: row.ediInterchangeId,
            systemMessageId: row.systemMessageId,
            controlNumber: row.controlNumber || "",
            statusText: statusText(row.statusId),
            reasonCode: row.reasonCode || "",
            safeError: safeError(row.errorText),
            interchangeDateText: dateText(row.interchangeDate)
        }))
    }
    return out
}
function ediDocumentRow(doc) {
    return {
        ediDocumentId: doc.ediDocumentId,
        systemMessageId: doc.systemMessageId || null,
        transactionSetId: doc.transactionSetId || "",
        direction: doc.directionEnumId === "EdiDirOut" ? "out" : "in",
        controlNumber: doc.controlNumber || "",
        businessKey: doc.businessKey || "",
        statusText: statusText(doc.statusId),
        reasonCode: doc.reasonCode || "",
        safeError: safeError(doc.errorText),
        orderId: doc.orderId || null,
        eventDateText: dateText(doc.eventDate),
        // X12.js retry#Document: an exception applied again, a refusal produced again
        retryable:
            (doc.directionEnumId === "EdiDirIn" && doc.statusId === "EdocException") ||
            (doc.directionEnumId === "EdiDirOut" && doc.statusId === "EdocRefused")
    }
}

// A binding's typed parameters from the request (a name not given keeps its value), each checked by its kind.
function parametersOf(handler, p, current, organizationPartyId) {
    const values = Object.assign({}, current)
    for (const [name, def] of Object.entries(handler.parameters || {})) {
        if (p[name] == null) continue
        const value = text(p[name]) || null
        if (value && def.kind === "enum" && one("moqui.basic.Enumeration", {enumId: value})?.enumTypeId !== def.enumTypeId)
            denied("VALUE_INVALID", "Choose a valid " + def.label.toLowerCase())
        if (value && def.kind === "customer") {
            // the store organization's own customer (F167): a Customer-role party not disabled, not an internal organization,
            // not someone else's private contact, owned by the store's organization or shared (_NA_)
            const party = one("mantle.party.PartyDetail", {partyId: value})
            const customer = !!one("mantle.party.PartyRole", {partyId: value, roleTypeId: "Customer"})
            const internal = !!one("mantle.party.PartyRole", {partyId: value, roleTypeId: "OrgInternal"})
            const privateToOther = party?.privateOwnerUserId && party.privateOwnerUserId !== ec.user.userId
            const owned =
                party && (party.ownerPartyId === "_NA_" || (organizationPartyId && party.ownerPartyId === organizationPartyId))
            if (!party || party.disabled === "Y" || !customer || internal || privateToOther || !owned)
                denied("CUSTOMER_UNAVAILABLE", "Customer " + value + " is not available")
        }
        values[name] = value
    }
    return values
}
const missingParameters = (handler, values) =>
    Object.entries(handler.parameters || {})
        .filter(([name, def]) => def.required && !values[name])
        .map(([, def]) => def.label)

// store#StoreIntegration: a new binding of a store to a registered connector (its intake stopped until the operator has set
// its credentials), or a binding's description, mapping version, typed parameters and intake changed. Never a credential, an
// endpoint or an authentication method; a binding's store and connector are fixed; an EDI partner is the EDI administrator's.
function storeStoreIntegration(p) {
    const s = scope()
    if (!p.systemMessageRemoteId) {
        const store = stores.storeOf(s, p.productStoreId)
        const registry = registered(p.connectorId)
        const handler = connectors[p.connectorId]
        if (!registry || !handler) denied("CONNECTOR_UNAVAILABLE", "Connector " + (p.connectorId || "") + " is not registered")
        if (handler.managed) denied("EDI_MANAGED", "An EDI trading partner is set up by the EDI administrator")
        const description = text(p.description)
        if (!description) denied("VALUE_REQUIRED", "Name the integration")
        const version = Number(p.mappingVersion || registry.mappingVersion || handler.versions[0])
        if (!handler.versions.includes(version))
            denied("MAPPING_UNSUPPORTED", "Mapping version " + version + " is not registered")
        const values = parametersOf(handler, p, {}, store.organizationPartyId)
        const created = call("create#" + REMOTE, {
            description,
            productStoreId: store.productStoreId,
            storeConnectorId: p.connectorId,
            systemMessageTypeId: registry.systemMessageTypeId,
            storeMappingVersion: version,
            storeMappingJson: JSON.stringify(values),
            storeDisabled: "Y",
            // an HMAC signature is required of the remote until the operator chooses otherwise: never an anonymous intake
            messageAuthEnumId: "SmatHmacSha256"
        })
        return {
            systemMessageRemoteId: created.systemMessageRemoteId,
            message:
                "Integration " +
                description +
                " is bound to " +
                store.storeName +
                "; its intake starts once the operator has set its credentials and it is enabled"
        }
    }
    const b = bindingIn(s, p.systemMessageRemoteId, true)
    const remote = b.remote
    if (b.handler?.managed) denied("EDI_MANAGED", "An EDI trading partner is changed by the EDI administrator")
    if (!b.handler) denied("CONNECTOR_UNAVAILABLE", "Connector " + b.connectorId + " is not registered")
    if (p.expectedLastUpdatedStamp && ms(p.expectedLastUpdatedStamp) !== ms(remote.lastUpdatedStamp))
        denied(
            "STALE_REVISION",
            "Changed by someone else since it was read (now " + dateText(remote.lastUpdatedStamp) + "); reload"
        )
    if (p.productStoreId && p.productStoreId !== b.productStoreId) denied("STORE_FIXED", "An integration's store is not changed")
    if (p.connectorId && p.connectorId !== b.connectorId) denied("CONNECTOR_FIXED", "An integration's connector is not changed")
    const changes = {systemMessageRemoteId: remote.systemMessageRemoteId}
    if (p.description != null) {
        if (!text(p.description)) denied("VALUE_REQUIRED", "Name the integration")
        changes.description = text(p.description)
    }
    if (p.mappingVersion != null && p.mappingVersion !== "") {
        const version = Number(p.mappingVersion)
        if (!b.handler.versions.includes(version))
            denied("MAPPING_UNSUPPORTED", "Mapping version " + version + " is not registered")
        changes.storeMappingVersion = version
    }
    const values = parametersOf(
        b.handler,
        p,
        mappingOf(remote),
        one(STORE, {productStoreId: b.productStoreId})?.organizationPartyId
    )
    changes.storeMappingJson = JSON.stringify(values)
    if (p.enabled != null && p.enabled !== "") {
        const enable = indicator(p.enabled)
        if (enable) {
            if (!registered(b.connectorId)) denied("CONNECTOR_UNAVAILABLE", "Connector " + b.connectorId + " is not enabled")
            const missing = missingParameters(b.handler, values)
            if (missing.length) denied("MAPPING_INCOMPLETE", "Set " + missing.join(", ") + " before enabling the integration")
            if (!remote.messageAuthEnumId || remote.messageAuthEnumId === "SmatNone" || !credentialsSet(remote))
                denied(
                    "CREDENTIALS_REQUIRED",
                    "The operator sets the integration's authentication and credentials before it is enabled"
                )
        }
        changes.storeDisabled = enable ? "N" : "Y"
    }
    call("update#" + REMOTE, changes)
    return {
        systemMessageRemoteId: remote.systemMessageRemoteId,
        message: "Integration " + (changes.description || remote.description || remote.systemMessageRemoteId) + " saved"
    }
}

// find#StoreMessages: the messages of the user's stores' bindings (or one binding), newest first, by state, direction and
// external ID or message ID; a page at a time, each with its safe error.
function findStoreMessages(p) {
    const s = scope()
    let remoteIds
    if (p.systemMessageRemoteId) remoteIds = [bindingIn(s, p.systemMessageRemoteId).remote.systemMessageRemoteId]
    else {
        const storeIds = p.productStoreId ? [stores.storeOf(s, p.productStoreId).productStoreId] : s.storeIds
        remoteIds = storeBindings(s, storeIds).map(b => b.remote.systemMessageRemoteId)
    }
    const query = () => {
        let q = find(MESSAGE).condition("systemMessageRemoteId", "in", remoteIds.length ? remoteIds : ["_none_"])
        if (p.state && stateConditions[p.state]) q = stateConditions[p.state](q)
        if (p.direction === "in") q = q.condition("isOutgoing", "N")
        if (p.direction === "out") q = q.condition("isOutgoing", "Y")
        if (p.parentMessageId) q = q.condition("parentMessageId", p.parentMessageId)
        if (text(p.term)) {
            const cf = ec.entity.conditionFactory
            q = q.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("messageId", "like", likeText(text(p.term))).ignoreCase(),
                        cf.makeCondition("systemMessageId", "equals", text(p.term))
                    ],
                    "or"
                )
            )
        }
        return q.orderBy("-initDate").orderBy("-systemMessageId")
    }
    const found = lib.page(query(), p, "messages", query().count())
    const errors = latestErrors(found.rows.map(row => row.systemMessageId))
    return Object.assign({}, found, {messages: found.rows.map(m => messageRow(m, errors)), rows: undefined})
}

// get#StoreMessage: one message's safe summary: its outcome, the canonical fields of a channel order (never its text), what
// its mapping finds, its business links, the original of a replay or conflict, its errors' first lines and, for a receipt or
// a batch, its orders; for an EDI receipt its interchanges and documents.
function getStoreMessage(p) {
    const s = scope()
    const {message: m, binding: b} = messageIn(s, p.systemMessageId)
    const errors = Array.from(find(ERROR, {systemMessageId: m.systemMessageId}).orderBy("-errorDate").limit(10).list()).map(
        row => ({
            errorDateText: dateText(row.errorDate),
            text: safeError(row.errorText)
        })
    )
    const out = {
        message: Object.assign(messageRow(m, null), {
            safeError: errors[0]?.text || "",
            integrationName: b.remote.description || b.remote.systemMessageRemoteId,
            productStoreId: b.productStoreId,
            storeName: storeName(b.productStoreId)
        }),
        errors,
        summary: null,
        findings: [],
        order: null,
        original: null,
        children: [],
        ediDocuments: [],
        orderView: s.orderView
    }
    const orderOf = orderId => {
        const order = orderId ? one("mantle.order.OrderHeader", {orderId}) : null
        return order
            ? {orderId, statusText: statusText(order.statusId), totalText: moneyText(order.grandTotal, order.currencyUomId)}
            : null
    }
    if (m.docType === ORDER_KIND) {
        const canonical = json(m.messageText, null)
        if (canonical) {
            const store = one(STORE, {productStoreId: b.productStoreId})
            out.summary = orderSummary(canonical, store)
            if (!m.orderId && !m.duplicateOfMessageId) out.findings = validateOrder(store, b, canonical)
        }
        out.order = orderOf(m.orderId)
    }
    if (m.duplicateOfMessageId) {
        const original = one(MESSAGE, {systemMessageId: m.duplicateOfMessageId})
        if (original) out.original = Object.assign(messageRow(original, null), {order: orderOf(original.orderId)})
    }
    if (m.docType === RECEIPT_KIND || m.systemMessageTypeId === IMPORT_TYPE) {
        const children = Array.from(
            find(MESSAGE, {parentMessageId: m.systemMessageId}).orderBy("systemMessageId").limit(limits.orders).list()
        )
        const childErrors = latestErrors(children.map(row => row.systemMessageId))
        out.children = children.map(child => messageRow(child, childErrors))
    }
    if (b.connection && m.systemMessageTypeId === "EdiX12") {
        const interchangeIds = rows(EDI_INTERCHANGE, {systemMessageId: m.systemMessageId}).map(row => row.ediInterchangeId)
        const docs = rowsIn(EDI_DOCUMENT, "ediInterchangeId", interchangeIds).concat(
            rows(EDI_DOCUMENT, {systemMessageId: m.systemMessageId})
        )
        const seen = new Set()
        out.ediDocuments = docs
            .filter(doc => !seen.has(doc.ediDocumentId) && seen.add(doc.ediDocumentId))
            .slice(0, limits.detail)
            .map(ediDocumentRow)
    }
    return out
}

// ===== retry =====
// retry#StoreMessages: an operator's retry of failed messages of one binding, each in its own transaction, keeping its identity
// (the same message, external ID and, for EDI, the document and its controls); keyed by operationKey, so a second submit
// answers the first result. A conflict, a duplicate and an applied message are not retried; each item's result is named.
function retryStoreMessages(p) {
    const s = scope()
    const b = bindingIn(s, p.systemMessageRemoteId)
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give a reason for the retry")
    const listOf = value =>
        unique(
            (Array.isArray(value)
                ? value
                : value == null
                  ? []
                  : Array.from(value?.toArray ? value.toArray() : String(value).split(","))
            ).map(text)
        )
    const messageIds = listOf(p.systemMessageIds)
    const documentIds = listOf(p.ediDocumentIds)
    if (!messageIds.length && !documentIds.length) denied("VALUE_REQUIRED", "Choose the messages to retry")
    if (messageIds.length + documentIds.length > limits.retry) denied("TOO_MANY", "Retry at most " + limits.retry + " at a time")
    const organizationPartyId = one(STORE, {productStoreId: b.productStoreId})?.organizationPartyId || null
    const op = lib.operation(p, "StoreChannelRetry", organizationPartyId, {
        systemMessageRemoteId: b.remote.systemMessageRemoteId,
        messageIds: messageIds.slice().sort(),
        documentIds: documentIds.slice().sort(),
        reason
    })
    const again = lib.previous(op)
    if (again) return again
    const results = []
    const each = (kind, id, parameters) => {
        ec.message.pushErrors()
        try {
            const out =
                ec.service
                    .sync()
                    .name(SERVICES + "retry#StoreMessage")
                    .parameters(Object.assign({systemMessageRemoteId: b.remote.systemMessageRemoteId}, parameters))
                    .requireNewTransaction(true)
                    .call() || {}
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            results.push({
                kind,
                id,
                ok: !!out.ok,
                stateText: out.stateText || "",
                orderId: out.orderId || null,
                message: out.message || ""
            })
        } catch (error) {
            const code = lib.reasonCode(safeError(error.message))
            results.push({kind, id, ok: false, reasonCode: code, stateText: "", orderId: null, message: safeError(error.message)})
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    for (const id of messageIds) each("message", id, {systemMessageId: id})
    for (const id of documentIds) each("ediDocument", id, {ediDocumentId: id})
    const retried = results.filter(row => row.ok).length
    const answer = {
        results,
        retriedCount: retried,
        failedCount: results.length - retried,
        reason,
        message: retried + " of " + results.length + " retried"
    }
    lib.complete(op, REMOTE, b.remote.systemMessageRemoteId, answer)
    return answer
}
// retry#StoreMessage: one item of retry#StoreMessages, in its own transaction, checked again here.
function retryStoreMessage(p) {
    const s = scope()
    const b = bindingIn(s, p.systemMessageRemoteId)
    const x12 = () => ec.resource.script("component://mr-mantle/service/mantle/edi/X12.js")
    if (p.ediDocumentId) {
        const doc = one(EDI_DOCUMENT, {ediDocumentId: p.ediDocumentId})
        if (!doc || doc.systemMessageRemoteId !== b.remote.systemMessageRemoteId) unavailable("EDI document", p.ediDocumentId)
        const out = x12().storeRetry("retry", {ediDocumentId: doc.ediDocumentId})
        const statusId = out.statusId || one(EDI_DOCUMENT, {ediDocumentId: doc.ediDocumentId}).statusId
        return {ok: !ediExceptionStatuses.includes(statusId), stateText: statusText(statusId), orderId: doc.orderId || null}
    }
    const m = p.systemMessageId ? one(MESSAGE, {systemMessageId: p.systemMessageId}) : null
    if (!m || m.systemMessageRemoteId !== b.remote.systemMessageRemoteId) unavailable("Message", p.systemMessageId)
    if (m.statusId === "SmsgRejected" && m.duplicateOfMessageId)
        denied(
            "CONFLICT_REVIEW",
            "Message " + m.systemMessageId + " conflicts with " + m.duplicateOfMessageId + "; it is kept as evidence, not retried"
        )
    if (!retryable(m)) denied("NOT_RETRYABLE", "Message " + m.systemMessageId + " is " + stateOf(m).text.toLowerCase())
    if (m.systemMessageTypeId === "EdiX12") {
        if (m.isOutgoing === "Y") {
            const doc = one(EDI_DOCUMENT, {systemMessageId: m.systemMessageId})
            if (!doc) denied("NOT_RETRYABLE", "Message " + m.systemMessageId + " has no EDI document")
            x12().storeRetry("retry", {ediDocumentId: doc.ediDocumentId})
        } else x12().storeRetry("retryReceipt", {systemMessageId: m.systemMessageId})
    } else {
        // the same message consumed again: its order is made once (consume#ChannelOrder answers one already made)
        call(SM + "consume#ReceivedSystemMessage", {systemMessageId: m.systemMessageId, allowError: true, willRetry: false})
    }
    const after = one(MESSAGE, {systemMessageId: m.systemMessageId})
    const state = stateOf(after)
    const error = state.key === "failed" ? latestErrors([after.systemMessageId]).get(after.systemMessageId) : null
    return {
        ok: state.key === "applied",
        stateText: state.text,
        orderId: after.orderId || null,
        message: safeError(error?.errorText)
    }
}

// ===== channel orders =====
// The canonical channel order (mapping version 1): only the fields the mapping reads, normalized, so its hash is the same for
// the same order however it was spelled or ordered (an order with no currency is in the store's). Anything else a channel
// sends is not kept in it.
function canonicalOrder(raw, index, storeCurrencyUomId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        denied("ORDER_UNREADABLE", "Order " + (index + 1) + " is not an object")
    const externalId = text(raw.externalId ?? raw.orderId ?? raw.id)
    if (!externalId) denied("EXTERNAL_ID_REQUIRED", "Order " + (index + 1) + " has no external ID")
    if (externalId.length > limits.externalId || /[\x00-\x1f]/.test(externalId))
        denied(
            "EXTERNAL_ID_INVALID",
            "Order " +
                (index + 1) +
                "'s external ID is longer than " +
                limits.externalId +
                " characters or holds control characters"
        )
    const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.lines) ? raw.lines : []
    const placed = text(raw.placedDate)
    const placedMs = placed ? ms(placed) : null
    const order = {
        externalId,
        currencyUomId: text(raw.currencyUomId ?? raw.currency) || storeCurrencyUomId || null,
        placedDate: placed ? (Number.isFinite(placedMs) ? new Date(placedMs).toISOString() : placed) : null,
        items: items.map((item, i) => ({
            lineId: text(item?.lineId ?? item?.lineNumber) || String(i + 1),
            productId: text(item?.productId ?? item?.sku) || null,
            quantity: decimalText(item?.quantity),
            unitAmount: decimalText(item?.unitAmount ?? item?.price)
        })),
        shippingAmount: decimalText(raw.shippingAmount),
        taxAmount: decimalText(raw.taxAmount),
        note: text(raw.note).slice(0, 255) || null
    }
    return order
}
// A product a store sells, by ID or pseudo ID: currently purchasable in the store (StoreMerchandising.js resolve).
function storeProduct(store, reference, facts) {
    if (!reference) return null
    if (facts.products.has(reference)) return facts.products.get(reference)
    let product = one("mantle.product.Product", {productId: reference})
    if (!product) {
        const found = Array.from(find("mantle.product.Product", {pseudoId: reference}).limit(2).list())
        product = found.length === 1 ? found[0] : null
    }
    let resolved = null
    if (product) {
        try {
            facts.merch = facts.merch || ec.resource.script("component://mr-mantle/service/mantle/product/StoreMerchandising.js")
            resolved = facts.merch.resolve(store, [product.productId], ec.user.nowTimestamp, null)[0]
        } catch (error) {
            ec.logger.error("Store channel: publication of " + product.productId + " not read: " + error.message)
        }
    }
    const answer = product
        ? {
              productId: product.productId,
              productName: product.productName || product.productId,
              purchasable: !!resolved?.purchasable,
              reasonCode: resolved?.reasonCode || null
          }
        : null
    facts.products.set(reference, answer)
    return answer
}
const positive = value => {
    const decimal = decimalOf(value)
    return decimal != null && decimal.compare(0) > 0
}
const notNegative = (value, currencyUomId) => {
    const decimal = decimalOf(value)
    return decimal != null && decimal.compare(0) >= 0 && decimal.eq(ec.l10n.roundCurrency(decimal, currencyUomId))
}
// What a channel order's mapping finds against its store and binding: [{code, message}], empty when it can be made.
function validateOrder(store, b, order, facts = {products: new Map()}) {
    const findings = []
    const add = (code, message) => findings.push({code, message})
    const mapping = mappingOf(b.remote)
    const missing = missingParameters(b.handler || {}, mapping)
    if (missing.length) add("MAPPING_INCOMPLETE", "The integration's " + missing.join(", ") + " is not set")
    const currencyUomId = store?.defaultCurrencyUomId
    if (order.currencyUomId && currencyUomId && order.currencyUomId !== currencyUomId)
        add("CURRENCY_MISMATCH", "The order is in " + order.currencyUomId + "; the store sells in " + currencyUomId)
    if (order.placedDate && !Number.isFinite(ms(order.placedDate)))
        add("DATE_INVALID", "The placed date " + order.placedDate + " is not a date")
    if (!order.items.length) add("ITEMS_REQUIRED", "The order has no lines")
    if (order.items.length > limits.lines) add("TOO_MANY_LINES", "An order has at most " + limits.lines + " lines")
    const seen = new Set()
    for (const item of order.items.slice(0, limits.lines)) {
        const line = "Line " + item.lineId
        if (seen.has(item.lineId)) add("LINE_DUPLICATE", line + " appears twice")
        seen.add(item.lineId)
        if (!positive(item.quantity)) add("LINE_QUANTITY_INVALID", line + " has no positive quantity")
        if (!notNegative(item.unitAmount, currencyUomId)) add("LINE_PRICE_INVALID", line + " has no valid price")
        const product = storeProduct(store, item.productId, facts)
        if (!product) add("ITEM_UNKNOWN", line + ": product " + (item.productId || "(none)") + " is not known")
        else if (!product.purchasable)
            add(
                "ITEM_UNAVAILABLE",
                line +
                    ": " +
                    product.productName +
                    " is not sold by the store (" +
                    (product.reasonCode || "not purchasable") +
                    ")"
            )
    }
    for (const [field, label] of [
        ["shippingAmount", "shipping"],
        ["taxAmount", "tax"]
    ])
        if (order[field] != null && !notNegative(order[field], currencyUomId))
            add("AMOUNT_INVALID", "The " + label + " amount is not valid")
    return findings
}
function orderSummary(order, store, facts = {products: new Map()}) {
    const currencyUomId = order.currencyUomId || store?.defaultCurrencyUomId
    return {
        externalId: order.externalId,
        currencyUomId,
        placedDateText: order.placedDate ? dateText(ms(order.placedDate)) || order.placedDate : "",
        lines: order.items.slice(0, limits.lines).map(item => ({
            lineId: item.lineId,
            productId: item.productId,
            productName: storeProduct(store, item.productId, facts)?.productName || item.productId || "",
            quantity: item.quantity || "",
            unitAmountText: moneyText(item.unitAmount, currencyUomId) || item.unitAmount || ""
        })),
        lineCount: order.items.length,
        shippingText: moneyText(order.shippingAmount, currencyUomId),
        taxText: moneyText(order.taxAmount, currencyUomId),
        note: order.note || ""
    }
}
// What differs between two canonical orders, as evidence of a conflict (field paths and both values; no other field).
function differences(original, replay) {
    const flat = (value, prefix, out) => {
        if (value && typeof value === "object") {
            for (const [key, inner] of Object.entries(value)) flat(inner, prefix ? prefix + "." + key : key, out)
        } else out[prefix] = value == null ? "" : String(value)
        return out
    }
    const a = flat(original || {}, "", {})
    const b = flat(replay || {}, "", {})
    return unique(Object.keys(a).concat(Object.keys(b)))
        .filter(key => a[key] !== b[key])
        .slice(0, 10)
        .map(key => key + " " + (a[key] ?? "") + " → " + (b[key] ?? ""))
}
// The original of an external ID: the first message of the store, remote and kind with it that is no replay or conflict.
function originalOf(b, externalId) {
    return (
        find(MESSAGE, {
            productStoreId: b.productStoreId,
            systemMessageRemoteId: b.remote.systemMessageRemoteId,
            docType: ORDER_KIND,
            messageId: externalId,
            isOutgoing: "N"
        })
            .condition("duplicateOfMessageId", "is-null", null)
            .orderBy("initDate")
            .orderBy("systemMessageId")
            .limit(1)
            .list()[0] || null
    )
}
// One order of a receipt or batch kept: new (Received, to consume), a replay (Consumed, the original's order) or a conflict
// (Rejected, its evidence). An order already kept at the same place of the same batch (a commit resumed) is not kept again.
function intakeOrder(b, raw, index, parentMessageId, storeCurrencyUomId) {
    const base = {
        systemMessageTypeId: ORDER_TYPE,
        systemMessageRemoteId: b.remote.systemMessageRemoteId,
        productStoreId: b.productStoreId,
        isOutgoing: "N",
        initDate: ec.user.nowTimestamp,
        docType: ORDER_KIND,
        docControl: String(index + 1),
        parentMessageId
    }
    const kept = parentMessageId
        ? find(MESSAGE, {parentMessageId, docControl: String(index + 1), docType: ORDER_KIND})
              .limit(1)
              .list()[0]
        : null
    if (kept) return kept.statusId === "SmsgReceived" ? kept.systemMessageId : null
    let order
    try {
        order = canonicalOrder(raw, index, storeCurrencyUomId)
    } catch (error) {
        // an order that cannot be read is kept as it came, failed, so the receipt says what was refused
        const created = call(
            "create#" + MESSAGE,
            Object.assign({}, base, {statusId: "SmsgError", messageText: JSON.stringify(raw ?? null), failCount: 1})
        )
        call("create#" + ERROR, {
            systemMessageId: created.systemMessageId,
            errorDate: ec.user.nowTimestamp,
            attemptedStatusId: "SmsgConsumed",
            errorText: error.message
        })
        return null
    }
    const contentHash = hash(order)
    const values = Object.assign({}, base, {messageId: order.externalId, messageText: JSON.stringify(order), contentHash})
    const original = originalOf(b, order.externalId)
    if (!original) return call("create#" + MESSAGE, Object.assign(values, {statusId: "SmsgReceived"})).systemMessageId
    if (original.contentHash === contentHash) {
        // a matching replay answers the original: kept, linked, never consumed
        call(
            "create#" + MESSAGE,
            Object.assign(values, {
                statusId: "SmsgConsumed",
                processedDate: ec.user.nowTimestamp,
                duplicateOfMessageId: original.systemMessageId,
                orderId: original.orderId || null
            })
        )
        return null
    }
    // a conflicting replay is quarantined with the evidence of what differs
    const evidence = differences(json(original.messageText, {}), order)
    const created = call(
        "create#" + MESSAGE,
        Object.assign(values, {statusId: "SmsgRejected", duplicateOfMessageId: original.systemMessageId})
    )
    call("create#" + ERROR, {
        systemMessageId: created.systemMessageId,
        errorDate: ec.user.nowTimestamp,
        attemptedStatusId: "SmsgConsumed",
        errorText:
            "CONFLICT: external ID " +
            order.externalId +
            " was received as message " +
            original.systemMessageId +
            (original.orderId ? " (order " + original.orderId + ")" : "") +
            " with other content: " +
            (evidence.join("; ") || "the content differs")
    })
    return null
}
// receive#ChannelOrders: the StoreChannelOrders type's receive service (behind receive#IncomingSystemMessage, the remote
// authenticated by the endpoint; or commit#ChannelImport with its batch as parentMessageId). The remote must be an enabled
// binding of a registered intake connector of this type; the receipt is kept before it is read.
function receiveChannelOrders(p) {
    const remote = p.systemMessageRemoteId
        ? find(REMOTE, {systemMessageRemoteId: p.systemMessageRemoteId}).forUpdate(true).one()
        : null
    const b = bindingOf(remote)
    const registry = registered(b.connectorId)
    if (!remote || !b.productStoreId || !b.handler?.intake || !registry || registry.systemMessageTypeId !== p.systemMessageTypeId)
        denied(
            "BINDING_UNAVAILABLE",
            "Remote " +
                (p.systemMessageRemoteId || "") +
                " is not a store integration taking " +
                (p.systemMessageTypeId || "this message")
        )
    let parentId = p.parentMessageId || null
    if (parentId) {
        // an import's batch: the binding's own, being committed (an import does not need the API intake enabled)
        const batch = one(MESSAGE, {systemMessageId: parentId})
        if (
            !batch ||
            batch.systemMessageTypeId !== IMPORT_TYPE ||
            batch.systemMessageRemoteId !== remote.systemMessageRemoteId ||
            batch.statusId !== "SmsgConsuming"
        )
            denied("BATCH_UNAVAILABLE", "Batch " + parentId + " is not being committed")
    } else if (remote.storeDisabled === "Y") denied("BINDING_DISABLED", "The integration's intake is stopped")
    // the API's intake only from an authenticated remote: an operator who later set no authentication stops it
    else if (!remote.messageAuthEnumId || remote.messageAuthEnumId === "SmatNone")
        denied("BINDING_UNAUTHENTICATED", "The integration's endpoint has no authentication; its intake is stopped")
    let data = null
    let unreadable = null
    try {
        data = JSON.parse(String(p.messageText ?? ""))
    } catch (error) {
        unreadable = "MESSAGE_UNREADABLE: the message is not JSON (" + safeError(error.message) + ")"
    }
    const orders = data == null ? [] : Array.isArray(data) ? data : Array.isArray(data.orders) ? data.orders : [data]
    if (!unreadable && !orders.length) unreadable = "ORDERS_REQUIRED: the message holds no order"
    if (!unreadable && orders.length > limits.orders)
        unreadable = "TOO_MANY_ORDERS: a message holds at most " + limits.orders + " orders"
    if (!parentId) {
        const receipt = call("create#" + MESSAGE, {
            systemMessageTypeId: p.systemMessageTypeId,
            systemMessageRemoteId: remote.systemMessageRemoteId,
            productStoreId: b.productStoreId,
            remoteMessageId: p.remoteMessageId || null,
            isOutgoing: "N",
            statusId: unreadable ? "SmsgError" : "SmsgConsumed",
            initDate: ec.user.nowTimestamp,
            processedDate: unreadable ? null : ec.user.nowTimestamp,
            failCount: unreadable ? 1 : 0,
            messageText: String(p.messageText ?? ""),
            docType: RECEIPT_KIND,
            contentHash: hash(String(p.messageText ?? ""))
        })
        parentId = receipt.systemMessageId
        if (unreadable)
            call("create#" + ERROR, {
                systemMessageId: parentId,
                errorDate: ec.user.nowTimestamp,
                attemptedStatusId: "SmsgConsumed",
                errorText: unreadable
            })
    } else if (unreadable) denied(unreadable.split(":")[0], unreadable)
    const systemMessageIdList = []
    const currencyUomId = one(STORE, {productStoreId: b.productStoreId})?.defaultCurrencyUomId || null
    if (!unreadable)
        orders.forEach((raw, index) => {
            const id = intakeOrder(b, raw, index, parentId, currencyUomId)
            if (id) systemMessageIdList.push(id)
        })
    return {systemMessageIdList, systemMessageId: parentId}
}
// consume#ChannelOrder: one received channel order made and placed through Mantle's order services, in its own
// transaction (consume#ReceivedSystemMessage's), refused with its mapping's finding codes. A message whose order was made
// answers it: retrying never makes a second order.
function consumeChannelOrder(p) {
    // locked for this consume's transaction: a concurrent consume of the same message (the framework's job, a retry, a
    // second commit of a batch) waits, then finds its order and answers it, so one message never makes two orders
    const m = p.systemMessageId ? find(MESSAGE, {systemMessageId: p.systemMessageId}).forUpdate(true).one() : null
    if (!m) denied("RECORD_UNAVAILABLE", "No message " + p.systemMessageId)
    if (m.orderId) return {}
    if (m.docType !== ORDER_KIND || m.duplicateOfMessageId)
        denied("NOT_AN_ORDER", "Message " + m.systemMessageId + " is not a channel order to make")
    // only a canonical order (kept with its external ID and hash, so deduplicated) is made; one kept as it came, unreadable,
    // holds the channel's raw text
    if (!m.contentHash || !m.messageId)
        denied("ORDER_UNREADABLE", "Message " + m.systemMessageId + " was not readable as a channel order")
    const b = bindingOf(one(REMOTE, {systemMessageRemoteId: m.systemMessageRemoteId}))
    if (!b.remote || !b.handler?.intake || b.productStoreId !== m.productStoreId)
        denied("BINDING_UNAVAILABLE", "Message " + m.systemMessageId + "'s integration is not available")
    const store = one(STORE, {productStoreId: b.productStoreId})
    const order = json(m.messageText, null)
    if (!order) denied("ORDER_UNREADABLE", "Message " + m.systemMessageId + " holds no order")
    const facts = {products: new Map()}
    const findings = validateOrder(store, b, order, facts)
    if (findings.length) denied(findings[0].code, findings.map(row => row.message).join("; "))
    const mapping = mappingOf(b.remote)
    const header = {
        productStoreId: store.productStoreId,
        vendorPartyId: store.organizationPartyId,
        customerPartyId: mapping.customerPartyId,
        currencyUomId: store.defaultCurrencyUomId,
        salesChannelEnumId: mapping.salesChannelEnumId || b.handler.parameters.salesChannelEnumId.fallback,
        systemMessageRemoteId: b.remote.systemMessageRemoteId,
        externalId: order.externalId,
        otherPartyOrderId: order.externalId,
        facilityId: store.inventoryFacilityId || null,
        disablePromotions: "Y",
        disableShippingCalc: "Y",
        disableTaxCalc: "Y"
    }
    if (order.placedDate) header.otherPartyOrderDate = ms(order.placedDate)
    const created = call("mantle.order.OrderServices.create#Order", header)
    const {orderId, orderPartSeqId} = created
    for (const item of order.items) {
        call("mantle.order.OrderServices.create#OrderItem", {
            orderId,
            orderPartSeqId,
            productId: facts.products.get(item.productId).productId,
            quantity: item.quantity,
            unitAmount: item.unitAmount,
            isModifiedPrice: "N",
            externalItemSeqId: item.lineId,
            requireInventory: false
        })
    }
    for (const [field, itemTypeEnumId, description] of [
        ["shippingAmount", "ItemShipping", "Shipping"],
        ["taxAmount", "ItemSalesTax", "Sales tax"]
    ])
        if (order[field] != null && toDecimal(order[field]).compare(0) > 0)
            call("mantle.order.OrderServices.create#OrderItem", {
                orderId,
                orderPartSeqId,
                itemTypeEnumId,
                quantity: 1,
                unitAmount: order[field],
                itemDescription: description
            })
    if (order.note) call("create#mantle.order.OrderNote", {orderId, noteDate: ec.user.nowTimestamp, noteText: order.note})
    call("mantle.order.OrderServices.place#Order", {orderId, requireInventory: false})
    call("update#" + MESSAGE, {systemMessageId: m.systemMessageId, orderId, orderPartSeqId})
    call("create#mantle.order.OrderSystemMessage", {orderId, systemMessageId: m.systemMessageId, externalId: order.externalId})
    // the matching replays kept while this original had no order (it had failed) now answer its order (F168)
    for (const replay of rows(MESSAGE, {duplicateOfMessageId: m.systemMessageId, statusId: "SmsgConsumed"}))
        if (!replay.orderId) call("update#" + MESSAGE, {systemMessageId: replay.systemMessageId, orderId, orderPartSeqId})
    return {}
}

// ===== channel import =====
function parseJson(textValue) {
    let data
    try {
        data = JSON.parse(textValue)
    } catch (error) {
        denied("IMPORT_UNREADABLE", "The file is not JSON: " + safeError(error.message))
    }
    const orders = Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : null
    if (!orders) denied("IMPORT_UNREADABLE", "The file holds no orders list")
    return orders
}
// CSV, one row per order line: externalId, lineId, productId, quantity, unitAmount, and optionally currencyUomId,
// placedDate, shippingAmount, taxAmount, note (the order's from its first row). A row repeated exactly is one line.
function parseCsv(textValue) {
    let parsed
    try {
        parsed = ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js").parse(textValue, ",")
    } catch (error) {
        denied("IMPORT_UNREADABLE", safeError(error.message))
    }
    for (const column of ["externalId", "productId", "quantity", "unitAmount"])
        if (!parsed.headers.includes(column)) denied("IMPORT_UNREADABLE", "The file has no " + column + " column")
    const orders = new Map()
    for (const row of parsed.rows) {
        const v = row.sourceValues
        const id = text(v.externalId)
        const key = id || "row " + row.rowNumber
        if (!orders.has(key))
            orders.set(key, {
                externalId: id,
                currencyUomId: v.currencyUomId,
                placedDate: v.placedDate,
                shippingAmount: v.shippingAmount,
                taxAmount: v.taxAmount,
                note: v.note,
                items: [],
                seen: new Set()
            })
        const order = orders.get(key)
        const line = {
            lineId: text(v.lineId) || String(order.items.length + 1),
            productId: v.productId,
            quantity: v.quantity,
            unitAmount: v.unitAmount
        }
        const signature = JSON.stringify(line)
        if (order.seen.has(signature)) continue
        order.seen.add(signature)
        order.items.push(line)
    }
    return Array.from(orders.values()).map(order => {
        delete order.seen
        return order
    })
}
// The length of a text in UTF-8 bytes.
function utf8Length(value) {
    let bytes = 0
    for (let index = 0; index < value.length; index++) {
        const unit = value.charCodeAt(index)
        if (unit < 0x80) bytes += 1
        else if (unit < 0x800) bytes += 2
        else if (unit >= 0xd800 && unit < 0xdc00 && index + 1 < value.length) {
            // a surrogate pair: one character of four bytes
            bytes += 4
            index++
        } else bytes += 3
    }
    return bytes
}
function importFileText(p) {
    const file = p.importFile
    if (file && Number(file.size) > 0) {
        if (Number(file.size) > limits.bytes) denied("IMPORT_TOO_LARGE", "An import file holds at most 2 MiB")
        const stream = file.getInputStream()
        try {
            ec.resource.script("component://mr-mantle/service/mantle/product/CatalogCsv.js").validateUtf8(stream.readAllBytes())
        } catch (error) {
            denied("IMPORT_UNREADABLE", safeError(error.message))
        } finally {
            stream.close()
        }
        return {textValue: file.getString("UTF-8"), fileName: String(file.getName() || "")}
    }
    const textValue = String(p.importText ?? "")
    // bytes, as the upload's limit counts them (F169): a character is one to four bytes in UTF-8
    if (textValue.length > limits.bytes || utf8Length(textValue) > limits.bytes)
        denied("IMPORT_TOO_LARGE", "An import file holds at most 2 MiB")
    return {textValue, fileName: String(p.fileName || "")}
}
function batchIn(s, systemMessageId) {
    const {message, binding} = messageIn(s, systemMessageId)
    if (message.systemMessageTypeId !== IMPORT_TYPE) unavailable("Import", systemMessageId)
    return {batch: message, binding}
}
const outcomeTexts = {new: "New order", duplicate: "Duplicate", conflict: "Conflict", error: "Will fail"}
// prepare#ChannelImport: a file of a registered format read for a binding that imports, kept as a Staged batch (the same
// file for the same binding answers the batch already staged), with its preview.
function prepareChannelImport(p) {
    const s = scope()
    const b = bindingIn(s, p.systemMessageRemoteId)
    if (!b.handler?.imports || !registered(b.connectorId)) denied("IMPORT_UNSUPPORTED", "The integration does not import files")
    const format = importFormats[p.formatEnumId]
    if (!format || one("moqui.basic.Enumeration", {enumId: p.formatEnumId})?.enumTypeId !== "StoreChannelImportFormat")
        denied("FORMAT_UNSUPPORTED", "Choose a registered import format")
    const {textValue, fileName} = importFileText(p)
    if (!text(textValue)) denied("IMPORT_UNREADABLE", "Choose a file with orders")
    const orders = format.parse(textValue)
    if (!orders.length) denied("IMPORT_UNREADABLE", "The file holds no orders")
    if (orders.length > limits.orders) denied("TOO_MANY_ORDERS", "A file holds at most " + limits.orders + " orders")
    const version = Number(b.remote.storeMappingVersion || 1)
    const digest = hash({textValue, format: p.formatEnumId, remote: b.remote.systemMessageRemoteId, version})
    const staged = find(MESSAGE, {
        systemMessageRemoteId: b.remote.systemMessageRemoteId,
        systemMessageTypeId: IMPORT_TYPE,
        contentHash: digest,
        statusId: "SmsgStaged"
    })
        .limit(1)
        .list()[0]
    if (staged) return getChannelImport({systemMessageId: staged.systemMessageId})
    const created = call("create#" + MESSAGE, {
        systemMessageTypeId: IMPORT_TYPE,
        systemMessageRemoteId: b.remote.systemMessageRemoteId,
        productStoreId: b.productStoreId,
        isOutgoing: "N",
        statusId: "SmsgStaged",
        initDate: ec.user.nowTimestamp,
        messageText: textValue,
        contentHash: digest,
        docType: p.formatEnumId,
        docVersion: String(version),
        messageId: (fileName.split(/[\\/]/).at(-1) || "import").replace(/[\x00-\x1f]/g, "_").slice(0, 60)
    })
    return getChannelImport({systemMessageId: created.systemMessageId})
}
// get#ChannelImport: a batch, with its preview while staged (each order's predicted outcome: a new order, a duplicate of an
// order received before, a conflict, or the finding it will fail with) and its orders' outcomes once committed.
function getChannelImport(p) {
    const s = scope()
    const {batch, binding: b} = batchIn(s, p.systemMessageId)
    const store = one(STORE, {productStoreId: b.productStoreId})
    const staged = batch.statusId === "SmsgStaged"
    const operation = one(lib.operationEntity, {operationKey: "ChannelImport:" + batch.systemMessageId})
    const result = json(operation?.resultJson, {}) || {}
    const out = {
        batch: {
            systemMessageId: batch.systemMessageId,
            systemMessageRemoteId: b.remote.systemMessageRemoteId,
            integrationName: b.remote.description || b.remote.systemMessageRemoteId,
            productStoreId: b.productStoreId,
            storeName: store?.storeName || b.productStoreId,
            formatText: enumText(batch.docType),
            fileName: batch.messageId || "",
            digest: batch.contentHash,
            staged,
            statusText: staged ? "Staged, not committed" : statusText(batch.statusId),
            preparedText: dateText(batch.initDate),
            committedText: dateText(batch.processedDate),
            reason: result.reason || "",
            committedBy: operation?.userId
                ? one("moqui.security.UserAccount", {userId: operation.userId})?.userFullName || operation.userId
                : ""
        },
        rows: [],
        counts: {}
    }
    if (staged) {
        const format = importFormats[batch.docType]
        const facts = {products: new Map()}
        const seen = new Map()
        out.rows = format.parse(String(batch.messageText || "")).map((raw, index) => {
            let order
            try {
                order = canonicalOrder(raw, index, store?.defaultCurrencyUomId)
            } catch (error) {
                return {
                    rowKey: "Order " + (index + 1),
                    outcome: "error",
                    outcomeText: outcomeTexts.error,
                    detail: safeError(error.message),
                    lineCount: 0
                }
            }
            const contentHash = hash(order)
            const findings = validateOrder(store, b, order, facts)
            const original = seen.get(order.externalId) || originalOf(b, order.externalId)
            if (!seen.has(order.externalId)) seen.set(order.externalId, original || {contentHash, systemMessageId: null})
            let outcome = original
                ? original.contentHash === contentHash
                    ? "duplicate"
                    : "conflict"
                : findings.length
                  ? "error"
                  : "new"
            const detail =
                outcome === "duplicate"
                    ? original.systemMessageId
                        ? "Answers message " +
                          original.systemMessageId +
                          (original.orderId ? " (order " + original.orderId + ")" : "")
                        : "Repeats an order earlier in the file"
                    : outcome === "conflict"
                      ? "Differs from " +
                        (original.systemMessageId ? "message " + original.systemMessageId : "an order earlier in the file") +
                        ": " +
                        differences(original.messageText ? json(original.messageText, {}) : {}, order)
                            .slice(0, 3)
                            .join("; ")
                      : findings.map(row => row.message).join("; ")
            return {rowKey: order.externalId, outcome, outcomeText: outcomeTexts[outcome], detail, lineCount: order.items.length}
        })
    } else {
        const children = Array.from(
            find(MESSAGE, {parentMessageId: batch.systemMessageId}).orderBy("systemMessageId").limit(limits.orders).list()
        )
        const errors = latestErrors(children.map(row => row.systemMessageId))
        out.rows = children.map(child => {
            const row = messageRow(child, errors)
            return Object.assign(row, {
                rowKey: row.externalId || "Order " + child.docControl,
                outcome: row.stateKey,
                outcomeText: row.stateText,
                detail: row.safeError
            })
        })
    }
    for (const row of out.rows) out.counts[row.outcome] = (out.counts[row.outcome] || 0) + 1
    out.countsText = Object.entries(out.counts)
        .map(([key, count]) => count + " " + (outcomeTexts[key] || key).toLowerCase())
        .join(", ")
    return out
}
// claim#ChannelImport (commit#ChannelImport's claim, its own transaction): the batch locked and, while still staged, marked
// committing. {claimed}.
function claimChannelImport(p) {
    const s = scope()
    batchIn(s, p.systemMessageId)
    const batch = find(MESSAGE, {systemMessageId: p.systemMessageId}).forUpdate(true).one()
    if (!batch || batch.statusId !== "SmsgStaged") return {claimed: false}
    call("update#" + MESSAGE, {
        systemMessageId: batch.systemMessageId,
        statusId: "SmsgConsuming",
        lastAttemptDate: ec.user.nowTimestamp
    })
    return {claimed: true}
}
// commit#ChannelImport: the staged batch, as previewed (its digest), committed with a reason: its orders received through the
// API's connector path (receive#ChannelOrders, the batch as their parent) and each consumed in its own transaction; a
// failing order does not stop the others. Committing again answers the batch's outcome; a commit that fails before its
// orders are kept leaves the batch staged, and committing it again does not keep an order twice.
function commitChannelImport(p) {
    const s = scope()
    const {batch, binding: b} = batchIn(s, p.systemMessageId)
    if (!p.digest || p.digest !== batch.contentHash)
        denied("BATCH_CHANGED", "The batch is not the one previewed; prepare it again")
    if (batch.statusId === "SmsgConsumed")
        return Object.assign(getChannelImport({systemMessageId: batch.systemMessageId}), {
            alreadyApplied: true,
            message: "Already committed"
        })
    if (batch.statusId !== "SmsgStaged")
        denied("BATCH_BUSY", "Batch " + batch.systemMessageId + " is " + statusText(batch.statusId).toLowerCase())
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give a reason for the import")
    if (!b.handler?.imports || !registered(b.connectorId)) denied("IMPORT_UNSUPPORTED", "The integration does not import files")
    const id = batch.systemMessageId
    // a claim of the staged batch under its lock, in a transaction of its own (F165): of two concurrent commits only one
    // finds it staged; the other is refused as busy
    let claim
    try {
        claim = probe(SERVICES + "claim#ChannelImport", {systemMessageId: id})
    } catch (error) {
        denied("BATCH_BUSY", "Batch " + id + " is being committed")
    }
    if (!claim.claimed) denied("BATCH_BUSY", "Batch " + id + " is being committed")
    let kept
    try {
        const orders = importFormats[batch.docType].parse(String(batch.messageText || ""))
        kept = probe(SERVICES + "receive#ChannelOrders", {
            systemMessageTypeId: ORDER_TYPE,
            systemMessageRemoteId: b.remote.systemMessageRemoteId,
            messageText: JSON.stringify({orders}),
            parentMessageId: id
        })
    } catch (error) {
        probe("update#" + MESSAGE, {systemMessageId: id, statusId: "SmsgStaged"})
        throw error
    }
    for (const systemMessageId of Array.from(kept.systemMessageIdList || [])) {
        // each order in its own transaction (consume#ReceivedSystemMessage records a failure on the message and goes on)
        try {
            probe(SM + "consume#ReceivedSystemMessage", {systemMessageId, allowError: false, willRetry: false})
        } catch (error) {
            ec.logger.error("Channel import " + id + ": message " + systemMessageId + " not consumed: " + error.message)
        }
    }
    probe("update#" + MESSAGE, {systemMessageId: id, statusId: "SmsgConsumed", processedDate: ec.user.nowTimestamp})
    const answer = getChannelImport({systemMessageId: id})
    const organizationPartyId = one(STORE, {productStoreId: b.productStoreId})?.organizationPartyId || null
    lib.complete(
        {
            operationKey: "ChannelImport:" + id,
            operationType: "StoreChannelImport",
            organizationPartyId,
            requestHash: hash({id, digest: p.digest})
        },
        MESSAGE,
        id,
        {
            reason,
            counts: answer.counts
        }
    )
    answer.batch.reason = reason
    answer.batch.committedBy = ec.user.userAccount?.userFullName || ec.user.userId || ""
    return Object.assign(answer, {message: "Batch " + id + " committed: " + answer.countsText})
}

// ===== recovery registration =====
// Store channel messages as a registered recovery of the framework's operational recovery (moqui.server.RecoveryDescriptor
// rows in data/StoreChannelSetupData.xml; org.moqui.admin.OperationServices preview#Recovery and execute#Recovery; mr-boss
// impl-admin P13, design-commerce §9): an administrator's queue offers the same retry as IntegrationDetail, through
// retry#StoreMessages, with nothing added. The registration gives no right: both services answer by this caller's own
// COMMERCE_VIEW, COMMERCE_CHANNEL_OPERATE and store scope.
//
// find#MessageRecoveryTargets: which of these system messages are a store binding's, and what retry#StoreMessages would take
// now for this caller. A message of a store outside the caller's scope is answered as held, with no state, detail or reason
// of its own; a message of no store binding is not answered (it is not Commerce's). Never a retry of a conflict, a
// duplicate, an applied message or a batch; nothing is reconciled or cancelled here, and no payload is shown.
function findMessageRecoveryTargets(p) {
    if (text(p.targetKind) !== "SystemMessage") return {targetList: []}
    let s = null
    try {
        s = scope()
    } catch (_) {
        // a caller with no channel permission is answered what it may not do
        s = null
    }
    const ids = unique(Array.from(p.targetIdList?.toArray ? p.targetIdList.toArray() : p.targetIdList || []).map(text))
    const targetList = []
    for (const m of rowsIn(MESSAGE, "systemMessageId", ids.slice(0, limits.retry))) {
        const b = m.systemMessageRemoteId ? bindingOf(one(REMOTE, {systemMessageRemoteId: m.systemMessageRemoteId})) : null
        if (!b?.remote || !b.connectorId || !b.productStoreId) continue
        const inScope = !!s && s.storeIds.includes(b.productStoreId)
        const state = stateOf(m)
        const eligible = inScope && retryable(m)
        targetList.push({
            targetId: m.systemMessageId,
            ownerRef: inScope ? b.remote.systemMessageRemoteId : "",
            ownerStateText: inScope ? state.text : "",
            retryEligible: eligible,
            reconcileEligible: false,
            cancelEligible: false,
            uncertain: false,
            detailVisible: inScope,
            payloadVisible: false,
            reason: eligible
                ? ""
                : !inScope
                  ? "It is a store integration's message outside the stores you work"
                  : m.statusId === "SmsgRejected" && m.duplicateOfMessageId
                    ? "It conflicts with message " + m.duplicateOfMessageId + ": it is kept as evidence, not retried"
                    : "It is not retried: " + state.text.toLowerCase()
        })
    }
    return {targetList}
}
// recover#StoreMessage: the registered action on one message: retry#StoreMessages for it, with the reason and the operation
// key, whose repeat answers the first result. Anything else is not offered.
function recoverStoreMessage(p) {
    if (text(p.targetKind) !== "SystemMessage" || text(p.action) !== "retry")
        return {
            applied: false,
            reasonCode: "NOT_OFFERED",
            reason: "A failed store channel message is retried; nothing else is offered"
        }
    const m = p.targetId ? one(MESSAGE, {systemMessageId: p.targetId}) : null
    if (!m || !m.systemMessageRemoteId) unavailable("Message", p.targetId)
    const out = call(SERVICES + "retry#StoreMessages", {
        systemMessageRemoteId: m.systemMessageRemoteId,
        systemMessageIds: [m.systemMessageId],
        reason: p.reason,
        operationKey: p.operationKey
    })
    const item = Array.from(out.results || [])[0] || {}
    if (item.ok) return {applied: true, ownerStateText: (item.stateText || "") + (item.orderId ? ", order " + item.orderId : "")}
    return {
        applied: false,
        reasonCode: item.reasonCode || "RETRY_FAILED",
        reason: safeError(item.message) || item.stateText || "Not retried",
        ownerStateText: item.stateText || ""
    }
}

// The channel import batches of the stores the caller operates (the framework's DataTransferServices.find#TargetRuns):
// COMMERCE_VIEW, COMMERCE_CHANNEL_OPERATE and the store scope, as get#ChannelImport; none otherwise. Summaries only: the
// file's name, the store's organization, staged, committing or committed, the counts a commit kept, and the parameters that
// open the batch in ChannelImport. No order, customer or payload.
function findChannelImportRuns(p) {
    let s
    try {
        s = scope()
    } catch (error) {
        return {runList: []}
    }
    if (!s.storeIds.length) return {runList: []}
    let query = find(MESSAGE, {systemMessageTypeId: IMPORT_TYPE}).condition("productStoreId", "in", s.storeIds)
    if (p.fromDate != null) query = query.condition("initDate", "greater-equals", String(Number(p.fromDate)))
    if (p.thruDate != null) query = query.condition("initDate", "less", String(Number(p.thruDate)))
    const states = {
        SmsgStaged: ["open", "Staged"],
        SmsgConsuming: ["running", "Committing"],
        SmsgConsumed: ["complete", "Committed"]
    }
    const runList = []
    for (const row of Array.from(
        query
            .orderBy("-initDate")
            .limit(Math.min(Number(p.maxRows) || 100, 200))
            .list()
    )) {
        const store = one("mantle.product.store.ProductStore", {productStoreId: row.productStoreId})
        const organizationPartyId = store?.organizationPartyId || null
        if (p.scopeKey && organizationPartyId !== p.scopeKey) continue
        const operation = one(lib.operationEntity, {operationKey: "ChannelImport:" + row.systemMessageId})
        const counts = lib.json(operation?.resultJson, {})?.counts || {}
        const total = Object.values(counts).reduce((sum, value) => sum + (Number(value) || 0), 0)
        const account = operation?.userId ? one("moqui.security.UserAccount", {userId: operation.userId}) : null
        runList.push({
            runId: row.systemMessageId,
            fileLabel: [row.messageId, store?.storeName].filter(Boolean).join(" · "),
            scopeKey: organizationPartyId,
            scopeTitle: organizationPartyId
                ? one("mantle.party.Organization", {partyId: organizationPartyId})?.organizationName || organizationPartyId
                : null,
            state: (states[row.statusId] || ["open"])[0],
            stateText: (states[row.statusId] || [null, null])[1],
            startedDate: lib.ms(row.initDate),
            userName: account?.userFullName || account?.username || null,
            rowCount: operation ? total : null,
            ownerParameters: {systemMessageId: row.systemMessageId, systemMessageRemoteId: row.systemMessageRemoteId}
        })
    }
    return {runList}
}

const operations = {
    findChannelImportRuns,
    findMessageRecoveryTargets,
    recoverStoreMessage,
    findStoreIntegrations,
    getStoreIntegration,
    storeStoreIntegration,
    findStoreMessages,
    getStoreMessage,
    retryStoreMessages,
    retryStoreMessage,
    receiveChannelOrders,
    consumeChannelOrder,
    prepareChannelImport,
    getChannelImport,
    commitChannelImport,
    claimChannelImport,
    connectorOptions: () => ({connectors: (scope(), connectorOptions())})
}
;({
    // the scope and the bindings, for P14's feed and health module (StoreFeeds.js) and the readers of a store's integrations
    scope,
    storeBindings,
    bindingIn,
    stateOf,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store channel operation " + op)
        return operations[op](parameters || {})
    }
})
