// External access (CX-PORTALS): one record of an organization for an outside party, reached through a bearer token or
// by a signed-in contact of that party. The record types are listed here with the permission an internal user needs to
// issue or revoke their capabilities; an app's Mantle services (PortalServices, and later Purchasing's and Customer
// Service's) call check() first and keep no token rules of their own. Deny by default: an unknown record type, scope,
// expired, revoked or foreign token is unavailable, and says nothing about the record.
const lib = ec.resource.script("component://mr-mantle/service/mantle/account/InvoiceWorkflowLib.js")
const {find, one, rows, call, denied} = lib
const C = "mantle.party.ExternalAccessCapability"
const issuedInvoice = ["InvoiceFinalized", "InvoiceSent", "InvoiceAcked", "InvoicePmtRecvd"]
const closedOrder = ["OrderOpen", "OrderRequested", "OrderProposed", "OrderRejected", "OrderCancelled"]
// a supplier's quote (Purchasing P11): a purchase order requested of the supplier or proposed by it (F32)
const quoteStatuses = ["OrderRequested", "OrderProposed"]
const internal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// The purchase part of an order: the buying organization (internal) as customer, an outside supplier as vendor.
function purchasePart(orderId) {
    const part = rows("mantle.order.OrderPart", {orderId}).find(
        row => internal(row.customerPartyId) && row.vendorPartyId && !internal(row.vendorPartyId)
    )
    return part
        ? {organizationPartyId: part.customerPartyId, partyId: part.vendorPartyId, orderPartSeqId: part.orderPartSeqId}
        : null
}
// Each record type: what it is for an outside party (organization, party) when it may be reached at all, the
// permissions (any one of them) to issue or revoke its capabilities, and its page (by the first scope with one of its own).
const records = {
    Invoice: {
        permissions: ["RECEIVABLE_EDIT"],
        scopes: ["InvoicePay"],
        page: {app: "billing", path: "/InvoicePay?token="},
        resolve(recordId) {
            const invoice = one("mantle.account.invoice.Invoice", {invoiceId: recordId})
            if (!invoice || !issuedInvoice.includes(invoice.statusId) || !internal(invoice.fromPartyId)) return null
            if (internal(invoice.toPartyId)) return null
            return {organizationPartyId: invoice.fromPartyId, partyId: invoice.toPartyId}
        }
    },
    // a purchase order: AP's bill link (PAYABLE_EDIT, Accounting P18), and the buyer's link mailed with the order
    // (PURCHASE_ORDER_EDIT, send#PurchaseOrder; Purchasing P16), which opens OrderAcknowledgement with BillUpload beside it
    Order: {
        permissions: ["PAYABLE_EDIT", "PURCHASE_ORDER_EDIT"],
        scopes: ["BillUpload", "OrderAcknowledgement"],
        page: {app: "supplier", path: "/BillUpload?token="},
        pages: {OrderAcknowledgement: "/OrderAcknowledgement?token="},
        resolve(recordId) {
            const order = one("mantle.order.OrderHeader", {orderId: recordId})
            if (!order || closedOrder.includes(order.statusId)) return null
            return purchasePart(recordId)
        }
    },
    // a supplier's quote order while it is requested or proposed (Purchasing P16, F32): the RFQ's link mailed to the
    // supplier (send#QuoteRequest), which opens QuoteResponse
    Quote: {
        permissions: ["PURCHASE_ORDER_EDIT"],
        scopes: ["QuoteResponse"],
        page: {app: "supplier", path: "/QuoteResponse?token="},
        resolve(recordId) {
            const order = one("mantle.order.OrderHeader", {orderId: recordId})
            if (!order || !quoteStatuses.includes(order.statusId)) return null
            return purchasePart(recordId)
        }
    },
    // a service queue's intake token (Customer Service P6, F10, F61): the queue's public form (the Support app's
    // NewCustomerCase, P15) takes it; a queue has no outside party, so the record kind is party-less and only a token reaches
    // it, never a signed-in contact
    RequestCategory: {
        permissions: ["SUPPORT_POLICY_EDIT"],
        scopes: ["CaseIntake"],
        page: {app: "support", path: "/NewCustomerCase?token="},
        partyless: true,
        resolve(recordId) {
            const category = one("mantle.request.RequestCategory", {requestCategoryId: recordId})
            if (!category || !internal(category.ownerPartyId)) return null
            const queue = Array.from(
                find("mantle.request.support.ServiceQueue", {requestCategoryId: recordId})
                    .condition(ec.entity.conditionFactory.makeCondition("fromDate", "is-not-null", null))
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            )[0]
            return queue ? {organizationPartyId: category.ownerPartyId, partyId: null} : null
        }
    },
    // a support case, read by its customer's contacts (Customer Service P6 registers it; the Support app's CustomerCase
    // reads it, P15): a case (a CaseProfile) of an internal organization (its OrgInternal party) for its customer
    Request: {
        permissions: ["SUPPORT_CASE_EDIT"],
        scopes: ["CaseView"],
        page: {app: "support", path: "/CustomerCase?token="},
        resolve(recordId) {
            if (!recordId || !one("mantle.request.support.CaseProfile", {requestId: recordId})) return null
            const parties = rows("mantle.request.RequestParty", {requestId: recordId}).filter(row => lib.entityLib.active(row))
            const organizationPartyId = parties.find(row => row.roleTypeId === "OrgInternal")?.partyId
            const partyId = parties.find(row => row.roleTypeId === "Customer")?.partyId
            if (!internal(organizationPartyId) || !partyId || internal(partyId)) return null
            return {organizationPartyId, partyId}
        }
    }
}
// The issuer's check: one of the record type's permissions, then the organization (InvoiceWorkflowLib's rule).
function requirePermissions(kind, organizationPartyId) {
    const held = kind.permissions.find(permission => lib.entityLib.access.has(permission))
    if (!held) denied("PERMISSION_DENIED", kind.permissions.join(" or ") + " authority is required")
    lib.organization(organizationPartyId, held)
}
// The page a capability's link opens: the first of its scopes with a page of its own, else the record type's.
function pagePath(kind, scopes) {
    const scope = scopes.find(name => kind.pages?.[name])
    return scope ? kind.pages[scope] : kind.page.path
}
const unavailable = () => {
    const error = new Error("This link is not available")
    error.moquiErrorKind = "NotFound"
    throw error
}
function recordOf(recordType, recordId) {
    const kind = records[recordType]
    return kind && recordId ? kind.resolve(recordId) : null
}
// An internal user issuing or revoking: the record type's permission in the record's organization.
function requireIssuer(recordType, recordId) {
    const kind = records[recordType]
    if (!kind) denied("RECORD_TYPE_INVALID", "External access is not available for this record")
    const record = recordOf(recordType, recordId)
    if (!record) denied("RECORD_UNAVAILABLE", "This record cannot be shared outside the organization now")
    requirePermissions(kind, record.organizationPartyId)
    return record
}
function scopeList(scopes) {
    return (Array.isArray(scopes) ? scopes : String(scopes || "").split(","))
        .map(scope => String(scope).trim())
        .filter(Boolean)
}
// A new capability with its token, shown once; the caller has checked who may issue it.
function create(p) {
    const kind = records[p.recordType]
    const scopes = scopeList(p.scopes)
    if (!kind || !scopes.length || scopes.some(scope => !kind.scopes.includes(scope)))
        denied("SCOPE_INVALID", "Choose what the link allows")
    const record = recordOf(p.recordType, p.recordId)
    if (!record) denied("RECORD_UNAVAILABLE", "This record cannot be shared outside the organization now")
    // a link lasts validDays (60 by default) or to thruDate, never more than 366 days
    const days = Math.min(Math.max(Number(p.validDays || 60), 1), 366)
    const latest = Date.now() + 366 * 86400000
    const thruDate = new Date(p.thruDate ? Math.min(lib.ms(p.thruDate), latest) : Date.now() + days * 86400000)
    if (!(lib.ms(thruDate) > Date.now())) denied("EXPIRY_INVALID", "Choose an expiry in the future")
    const token = ec.user.randomString(48)
    const out = call("create#" + C, {
        organizationPartyId: record.organizationPartyId,
        partyId: record.partyId,
        recordType: p.recordType,
        recordId: p.recordId,
        scopes: scopes.join(","),
        tokenDigest: ec.user.singleUseCodeHash(token),
        issuerKind: p.issuerKind === "contact" ? "contact" : "organization",
        recordRevision: p.recordRevision == null || p.recordRevision === "" ? null : Number(p.recordRevision),
        fromDate: ec.user.nowTimestamp,
        thruDate,
        createdByUserId: ec.user.userId
    })
    // the link: the record's page of the organization's first published site with the app
    const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const siteId = apps.sitesFor(kind.page.app, record.organizationPartyId)[0]
    const url = siteId ? apps.pageUrl(siteId, kind.page.app, pagePath(kind, scopes) + encodeURIComponent(token)) : null
    return {capabilityId: out.capabilityId, token, url, thruDate, organizationPartyId: record.organizationPartyId}
}
// The capability a token names while it is in effect, or null. Every lookup counts against the requester's limit
// before the lookup, so a requester over it is refused whether its token is good or not.
// The requester as the framework's sign-in limits know it: a registered PASS deployment's browser address, else the
// request's own (behind a proxy, configure the framework's trusted proxies so this is the browser's).
const account = () => ec.resource.script("component://framework/service/org/moqui/public/Account.js")
const TOKEN_LOOKUPS = 100
function tokenCapability(token) {
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: "access-token:" + account().requesterKey(), limit: TOKEN_LOOKUPS, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) {
        const error = new Error("Wait before trying another link")
        error.moquiErrorKind = "Tarpit"
        throw error
    }
    const text = String(token || "")
    const row = text.length >= 32 && text.length <= 128 ? one(C, {tokenDigest: ec.user.singleUseCodeHash(text)}) : null
    return row && !row.revokedDate && lib.entityLib.active(row) ? row : null
}
// A signed-in user's contact grant (ExternalAccessContact, in effect): made by redeeming an invitation for one app of
// one organization, for one outside party. A CRM contact relationship gives no portal access.
const G = "mantle.party.ExternalAccessContact"
function grants(organizationPartyId, app) {
    const userPartyId = ec.user.userAccount?.partyId
    if (!userPartyId || !organizationPartyId || !app) return []
    return rows(G, {partyId: userPartyId, organizationPartyId, app}).filter(row => lib.entityLib.active(row))
}
function contactOf(partyId, organizationPartyId, app) {
    return !!partyId && grants(organizationPartyId, app).some(row => row.outsidePartyId === partyId)
}
// What a page may reach: a token's record within its scope, or a record whose outside party the signed-in user is a
// contact of. organizationPartyId, when given, is the organization the page serves (its app mount's target).
function check(p) {
    const kind = records[p.recordType]
    if (!kind || !kind.scopes.includes(p.scope)) unavailable()
    if (p.token) {
        const row = tokenCapability(p.token)
        if (
            !row ||
            row.recordType !== p.recordType ||
            (p.recordId && row.recordId !== p.recordId) ||
            !scopeList(row.scopes).includes(p.scope) ||
            (p.organizationPartyId && row.organizationPartyId !== p.organizationPartyId)
        )
            unavailable()
        const record = recordOf(row.recordType, row.recordId)
        if (!record || record.organizationPartyId !== row.organizationPartyId || record.partyId !== row.partyId) unavailable()
        return {
            via: "token",
            capabilityId: row.capabilityId,
            recordId: row.recordId,
            recordRevision: row.recordRevision ?? null,
            thruDate: row.thruDate,
            ...record
        }
    }
    // a contact needs the organization the page serves, and a grant for this record type's app there; a party-less kind (a
    // queue's intake) is reached only by its token
    const record = recordOf(p.recordType, p.recordId)
    if (
        kind.partyless ||
        !record ||
        !p.organizationPartyId ||
        record.organizationPartyId !== p.organizationPartyId ||
        !contactOf(record.partyId, p.organizationPartyId, kind.page.app)
    )
        unavailable()
    return {via: "contact", capabilityId: null, recordId: p.recordId, recordRevision: null, thruDate: null, ...record}
}
// The outside parties a signed-in user is a contact of, for an app of an organization.
function contactParties(organizationPartyId, app) {
    return [...new Set(grants(organizationPartyId, app).map(row => row.outsidePartyId))]
}
// The issuer's permission for a capability's own organization, so a link to a record since cancelled can be revoked.
function requireCapabilityIssuer(row) {
    const kind = records[row.recordType]
    if (!kind) denied("RECORD_TYPE_INVALID", "External access is not available for this record")
    requirePermissions(kind, row.organizationPartyId)
}
function revoke(p) {
    const row = find(C, {capabilityId: p.capabilityId}).forUpdate(true).one()
    if (!row) denied("CAPABILITY_UNAVAILABLE", "This link is not available")
    requireCapabilityIssuer(row)
    if (!row.revokedDate)
        call("update#" + C, {capabilityId: row.capabilityId, revokedDate: ec.user.nowTimestamp, revokedByUserId: ec.user.userId})
    return {capabilityId: row.capabilityId, revoked: true}
}
// End a record's links in effect for a scope made by one kind of issuer (the organization, or a contact; null for both); the
// caller has checked who may. A new pay link replaces its issuer kind's earlier ones, never the other kind's.
function revokeActive(recordType, recordId, scope, issuerKind = "organization") {
    for (const row of rows(C, {recordType, recordId}))
        if (
            !row.revokedDate &&
            lib.entityLib.active(row) &&
            scopeList(row.scopes).includes(scope) &&
            (issuerKind == null || (row.issuerKind || "organization") === issuerKind)
        )
            call("update#" + C, {capabilityId: row.capabilityId, revokedDate: ec.user.nowTimestamp, revokedByUserId: ec.user.userId})
}
// The links of a record, newest first, without their tokens.
function list(p) {
    const found = Array.from(find(C, {recordType: p.recordType, recordId: p.recordId}).orderBy("-fromDate").limit(50).list())
    if (found.length) requireCapabilityIssuer(found[0])
    else requireIssuer(p.recordType, p.recordId)
    const now = Date.now()
    return found.map(row => ({
        capabilityId: row.capabilityId,
        scopes: row.scopes,
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        revokedDate: row.revokedDate,
        active: !row.revokedDate && lib.ms(row.thruDate) > now
    }))
}
// An invitation to an app's pages bound to an outside party (a customer for Billing, a supplier for Supplier): an
// internal user with the record kind's permission in the organization the app serves. Redeeming it (redeem#Invitation)
// gives the account's party a contact grant for that app, organization and party.
// A supplier contact is invited by AP (PAYABLE_EDIT, Accounting P18) or by a buyer from Supplier360 (PURCHASE_ORDER_EDIT,
// Purchasing P16).
const appKinds = {billing: {permissions: ["RECEIVABLE_EDIT"]}, supplier: {permissions: ["PAYABLE_EDIT", "PURCHASE_ORDER_EDIT"]}}
function invite(p) {
    const app = appKinds[p.app]
    if (!app) denied("APP_INVALID", "Choose the app to invite the contact to")
    requirePermissions(app, p.organizationPartyId)
    const party = one("mantle.party.Party", {partyId: p.partyId})
    if (!party || internal(p.partyId) || party.partyTypeEnumId !== "PtyOrganization")
        denied("PARTY_INVALID", "Choose an outside organization")
    const apps = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const siteId = apps.sitesFor(p.app, p.organizationPartyId)[0]
    if (!siteId) denied("SITE_UNAVAILABLE", "The organization has no published site with this app")
    const email = String(p.emailAddress || "").trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) denied("EMAIL_INVALID", "Enter the contact's email address")
    const token = ec.user.randomString(32) + ec.user.randomString(32)
    const invitationId = ec.user.randomString(32)
    const expiresAt = new Date(Date.now() + 14 * 86400000)
    call("create#mantle.public.PublicSiteInvitation", {
        invitationId,
        siteId,
        tokenHash: ec.user.singleUseCodeHash(token),
        emailHash: ec.user.singleUseCodeHash(email),
        scopes: JSON.stringify([{app: p.app, partyId: p.partyId, organizationPartyId: p.organizationPartyId}]),
        inviterPartyId: ec.user.userAccount?.partyId,
        expiresAt
    })
    return {
        invitationId,
        siteId,
        token,
        expiresAt,
        invitationUrl: apps.pageUrl(siteId, "account", "/Invitation?token=" + encodeURIComponent(token))
    }
}
// On redeem: the account's party gets a contact grant for each app, organization and outside party the invitation names.
function bindContact(partyId, scopes) {
    for (const scope of Array.isArray(scopes) ? scopes : []) {
        if (!scope?.partyId || !scope.organizationPartyId || !appKinds[scope.app]) continue
        const key = {partyId, outsidePartyId: scope.partyId, organizationPartyId: scope.organizationPartyId, app: scope.app}
        if (!rows(G, key).some(row => lib.entityLib.active(row)))
            call("create#" + G, {...key, fromDate: ec.user.nowTimestamp})
    }
}
;({
    records,
    recordOf,
    requireIssuer,
    create,
    check,
    tokenCapability,
    contactOf,
    contactParties,
    revoke,
    revokeActive,
    list,
    invite,
    bindContact
})
