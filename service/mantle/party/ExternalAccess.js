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
        // Shop P6 (design-shop §9 AccountOverview, R-SHP-W06): the customer's own verified account reaches its invoice
        self: true,
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
        // P15: the customer's own account reaches it (self), and a contact reaches only a case they filed or report, unless
        // a customer administrator (organization-wide visibility; design §8 Access)
        self: true,
        contactAllows(recordId, grantRows) {
            if (grantRows.some(row => row.administrator === "Y")) return true
            const partyId = ec.user.userAccount?.partyId
            if (!partyId) return false
            if (one("mantle.request.Request", {requestId: recordId})?.filedByPartyId === partyId) return true
            return rows("mantle.request.RequestParty", {requestId: recordId, partyId}).some(
                row => ["Reporter", "Customer"].includes(row.roleTypeId) && lib.entityLib.active(row)
            )
        },
        resolve(recordId) {
            if (!recordId || !one("mantle.request.support.CaseProfile", {requestId: recordId})) return null
            const parties = rows("mantle.request.RequestParty", {requestId: recordId}).filter(row => lib.entityLib.active(row))
            const organizationPartyId = parties.find(row => row.roleTypeId === "OrgInternal")?.partyId
            const partyId = parties.find(row => row.roleTypeId === "Customer")?.partyId
            if (!internal(organizationPartyId) || !partyId || internal(partyId)) return null
            return {organizationPartyId, partyId}
        }
    },
    // a customer return's RMA (Customer Service P9, F61): the link mailed with the authorization (send#ReturnAuthorization),
    // which the Support app's CustomerReturn takes (P15); a customer return of an internal organization (its vendor) to a
    // customer that is not one, while it is not cancelled
    ReturnHeader: {
        permissions: ["RETURN_AUTHORIZE", "SUPPORT_CASE_EDIT"],
        scopes: ["ReturnRma"],
        page: {app: "support", path: "/CustomerReturn?token="},
        // P15: the customer's own account reaches it (self)
        self: true,
        resolve(recordId) {
            const header = one("mantle.order.return.ReturnHeader", {returnId: recordId})
            if (!header || header.statusId === "ReturnCancelled") return null
            if (!internal(header.vendorPartyId) || !header.customerPartyId || internal(header.customerPartyId)) return null
            return {organizationPartyId: header.vendorPartyId, partyId: header.customerPartyId}
        }
    },
    // a Commons form invitation (FormInvitation, crosscut X16; Customer Service P13, F61): the link mailed with it, which the
    // Support app's Feedback page takes for case feedback (CaseFeedback scope); an invitation of an internal organization to
    // an outside party while it is not withdrawn, expired or undeliverable (an answered one stays reachable, to show its
    // receipt). The links are made by the invitation's send job (CaseFeedback.js), never by a user.
    FormInvitation: {
        permissions: ["SUPPORT_CASE_MANAGE"],
        scopes: ["CaseFeedback"],
        page: {app: "support", path: "/Feedback?token="},
        resolve(recordId) {
            const invitation = one("mantle.party.FormInvitation", {invitationId: recordId})
            if (!invitation || ["FinRevoked", "FinSuppressed", "FinFailed", "FinExpired"].includes(invitation.statusEnumId))
                return null
            if (!internal(invitation.organizationPartyId) || !invitation.partyId || internal(invitation.partyId)) return null
            // impl-people P16: a form whose purpose takes no invited recipients (People's private purposes) has no link
            if (!ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js").linkAllowed(invitation.formId))
                return null
            return {organizationPartyId: invitation.organizationPartyId, partyId: invitation.partyId}
        }
    },
    // a customer's sales order (mr-pass impl-shop P5, X6, F16): the customer-direction kind of a placed order of an internal
    // organization (its sales part's vendor) to an outside customer: OrderView, the guest's order link a Shop checkout
    // issues at its confirmation; Download (P6) and RenewalAction (P7) follow. The customer's own verified account reaches
    // it by the self relationship. Customer Service staff may issue or revoke a link (a resent order link).
    SalesOrder: {
        permissions: ["SUPPORT_CASE_EDIT"],
        scopes: ["OrderView", "Download", "RenewalAction"],
        page: {app: "shop", path: "/Orders/Status?token="},
        self: true,
        // Shop P6 (F82): the link's site is the order's store's Shop site (a Shop mount targets a store, not the organization)
        siteTarget: recordId => one("mantle.order.OrderHeader", {orderId: recordId})?.productStoreId || null,
        resolve(recordId) {
            const order = one("mantle.order.OrderHeader", {orderId: recordId})
            if (!order || ["OrderOpen", "OrderRequested", "OrderProposed", "OrderCancelled", "OrderRejected"].includes(order.statusId))
                return null
            const part = rows("mantle.order.OrderPart", {orderId: recordId}).find(
                row => internal(row.vendorPartyId) && row.customerPartyId && !internal(row.customerPartyId)
            )
            return part ? {organizationPartyId: part.vendorPartyId, partyId: part.customerPartyId} : null
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
    const siteId = apps.sitesFor(kind.page.app, kind.siteTarget ? kind.siteTarget(p.recordId) : record.organizationPartyId)[0]
    const url = siteId ? apps.pageUrl(siteId, kind.page.app, pagePath(kind, scopes) + encodeURIComponent(token)) : null
    return {capabilityId: out.capabilityId, token, url, thruDate, organizationPartyId: record.organizationPartyId}
}
// The capability a token names while it is in effect, or null. Every lookup counts against the requester's limit
// before the lookup, so a requester over it is refused whether its token is good or not.
// The requester as the framework's sign-in limits know it: a registered PASS deployment's browser address, else the
// request's own (behind a proxy, configure the framework's trusted proxies so this is the browser's).
const account = () => ec.resource.script("component://framework/service/org/moqui/public/Account.js")
const TOKEN_LOOKUPS = 100
// The digest a capability is kept by (the token itself is never stored), and the requester's lookup throttle: each lookup
// of a scope counts against the requester's limit in a ten-minute window, in its own transaction, before the lookup, and
// one over it is refused (Tarpit, RATE_LIMITED). Shop P4 (impl-shop F16) exports both for StoreCartAccess (ShopCart.js),
// so a cart's capability uses the same digest and throttle as a link's.
const tokenDigest = token => ec.user.singleUseCodeHash(String(token))
function throttle(scope, limit, message) {
    const allowed = ec.service
        .sync()
        .throwOnError(true)
        .name("org.moqui.public.AccountServices.record#Attempt")
        .parameters({input: {key: scope + ":" + account().requesterKey(), limit, windowMillis: 600000}})
        .requireNewTransaction(true)
        .call().result.allowed
    if (!allowed) {
        const error = new Error("RATE_LIMITED: " + (message || "Wait before trying another link"))
        error.moquiErrorKind = "Tarpit"
        throw error
    }
}
function tokenCapability(token) {
    throttle("access-token", TOKEN_LOOKUPS)
    const text = String(token || "")
    const row = text.length >= 32 && text.length <= 128 ? one(C, {tokenDigest: tokenDigest(text)}) : null
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
// The self relationship (Customer Service P15; design-customer-service §8 Access, review X6): a signed-in account whose own
// party is the outside party, not internal and not working for an internal organization, with its current email address
// verified (a PASS account's VerifiedAddress of that address), reaches that party's records of a kind that allows it with no invitation. A
// customer contact's account is a different party, so this never reaches a colleague's or an employer's records.
function selfOf(partyId) {
    const account = ec.user.userAccount
    if (!account?.partyId || !partyId || account.partyId !== partyId || internal(partyId)) return false
    if (account.disabled === "Y") return false
    const works = rows("mantle.party.PartyRelationship", {fromPartyId: partyId}).some(
        row =>
            ["PrtEmployee", "PrtAgent", "PrtMember", "PrtRepresentative"].includes(row.relationshipTypeEnumId) &&
            lib.entityLib.active(row) &&
            internal(row.toPartyId)
    )
    if (works) return false
    // the account's current address verified (a changed email needs fresh verification; an older verified one is not it)
    return ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js").verified(account.userId)
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
    if (kind.partyless || !record || !p.organizationPartyId || record.organizationPartyId !== p.organizationPartyId)
        unavailable()
    // P15: the account's own party (self), else a contact grant, which a kind may narrow (a case: the contact's own unless an
    // administrator)
    if (kind.self && selfOf(record.partyId))
        return {via: "self", capabilityId: null, recordId: p.recordId, recordRevision: null, thruDate: null, ...record}
    const held = grants(p.organizationPartyId, kind.page.app).filter(row => row.outsidePartyId === record.partyId)
    if (!held.length || (kind.contactAllows && !kind.contactAllows(p.recordId, held))) unavailable()
    return {via: "contact", capabilityId: null, recordId: p.recordId, recordRevision: null, thruDate: null, ...record}
}
// The outside parties a signed-in user is a contact of, for an app of an organization.
function contactParties(organizationPartyId, app) {
    return [...new Set(grants(organizationPartyId, app).map(row => row.outsidePartyId))]
}
// The outside parties a signed-in user may act for on an app of an organization (Customer Service P15): each contact grant's
// party with whether it is a customer administrator, and the account's own party through the self relationship when it is
// a party of the app's kind (selfRole, a Customer for Support). [{partyId, administrator, via}]
function actingParties(organizationPartyId, app, selfRole = null) {
    const byParty = new Map()
    for (const row of grants(organizationPartyId, app)) {
        const was = byParty.get(row.outsidePartyId)
        byParty.set(row.outsidePartyId, {
            partyId: row.outsidePartyId,
            administrator: !!was?.administrator || row.administrator === "Y",
            via: "contact"
        })
    }
    const own = ec.user.userAccount?.partyId
    if (own && selfRole && !byParty.has(own) && one("mantle.party.PartyRole", {partyId: own, roleTypeId: selfRole}) && selfOf(own))
        byParty.set(own, {partyId: own, administrator: true, via: "self"})
    return Array.from(byParty.values())
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
// A customer contact is invited to the Support app by a Customer Service user holding SUPPORT_CONTACT_INVITE (Customer
// Service P13 registers the app, F57; P15 invites from ContactDetail).
const appKinds = {
    billing: {permissions: ["RECEIVABLE_EDIT"]},
    supplier: {permissions: ["PAYABLE_EDIT", "PURCHASE_ORDER_EDIT"]},
    // P15 (F57): a customer may be a person (a consumer) under the Support app
    support: {permissions: ["SUPPORT_CONTACT_INVITE"], persons: true}
}
function invite(p) {
    const app = appKinds[p.app]
    if (!app) denied("APP_INVALID", "Choose the app to invite the contact to")
    requirePermissions(app, p.organizationPartyId)
    const party = one("mantle.party.Party", {partyId: p.partyId})
    if (!party || internal(p.partyId) || (party.partyTypeEnumId !== "PtyOrganization" && !app.persons))
        denied("PARTY_INVALID", "Choose an outside organization")
    if (!party.partyTypeEnumId || !["PtyOrganization", "PtyPerson"].includes(party.partyTypeEnumId))
        denied("PARTY_INVALID", "Choose an outside organization or person")
    // a Support invitation is for a customer of the organization (Customer Service P15)
    if (p.app === "support" && !one("mantle.party.PartyRole", {partyId: p.partyId, roleTypeId: "Customer"}))
        denied("PARTY_INVALID", "Choose a customer")
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
        scopes: JSON.stringify([
            Object.assign(
                {app: p.app, partyId: p.partyId, organizationPartyId: p.organizationPartyId},
                // P15: a customer administrator sees the customer's cases, not only their own
                p.app === "support" && (p.administrator === true || p.administrator === "Y" || p.administrator === "true")
                    ? {administrator: "Y"}
                    : {}
            )
        ]),
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
        const administrator = scope.administrator === "Y" ? "Y" : null
        const current = rows(G, key).find(row => lib.entityLib.active(row))
        if (!current) call("create#" + G, {...key, administrator, fromDate: ec.user.nowTimestamp})
        else if (administrator && current.administrator !== "Y")
            call("update#" + G, {contactGrantId: current.contactGrantId, administrator})
    }
}
;({
    records,
    recordOf,
    requireIssuer,
    create,
    check,
    tokenCapability,
    // Shop P4 (F16): the capability digest and the lookup throttle, for StoreCartAccess
    tokenDigest,
    throttle,
    contactOf,
    contactParties,
    // Customer Service P15: the self relationship and the parties a signed-in user acts for
    selfOf,
    actingParties,
    revoke,
    revokeActive,
    list,
    invite,
    bindContact
})
