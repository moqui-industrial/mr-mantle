// Sales' accounts and contacts (IronStone Sales design §4; impl-sales P3): the account and contact writes of
// mantle.sales.AccountServices and the account reads of mantle.sales.SalesWorkspaceServices. Every operation reads the caller's
// sales scope (SalesAccess.js: the SALES_* permissions, the caller's organizations, the account and contact rules) and refuses
// what it does not cover with a reason code; a party, an account, a parent, a contact or an organization the caller supplies is
// checked, never trusted. An account outside the scope answers as a missing one (RECORD_UNAVAILABLE).
//
// - An account is a party with the Account role and a Customer or Prospect role, owned by the organization it is created for
//   (Party.ownerPartyId); a person may be an account (an individual customer). Its account manager is a dated PrtAccountManager
//   relationship from the representative to the account (data/SalesData.xml), ended, never deleted.
// - A contact is a person with a current PrtContact relationship to an account, owned by the account's organization; ending the
//   relationship keeps the person (delete#Contact). A contact may belong to several accounts; reading one account gives nothing
//   of another.
// - The reads leave out what the caller may not read: an account's orders for a holder of SALES_TEAM_VIEW only until Sales'
//   order scope (P11) is built, its invoices for a finance reader only (ACCOUNTING_VIEW or RECEIVABLE_VIEW, borrowed authority).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const salesAccess = ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const {find, one, rows, denied, ms} = lib
const access = lib.access

const sharedOwner = "_NA_"
const listCap = 50
const accountRoleTypes = ["Customer", "Prospect"]
const managerRelationship = "PrtAccountManager"
const memberRelationships = ["PrtEmployee", "PrtAgent", "PrtMember"]
const L = text => ec.l10n.localize(text)
const dayText = value => (value == null || value === "" ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy"))
const money = (value, currencyUomId) =>
    value == null ? "" : ec.l10n.formatCurrency(ec.l10n.roundCurrency(toDecimal(value), currencyUomId), currencyUomId)
const likeText = text => "%" + String(text).replace(/[\\%_]/g, character => "\\" + character) + "%"
const factory = () => ec.entity.conditionFactory
const now = () => ec.user.nowTimestamp
// the revision a write names (§2 "Revisions and operations"; P4, F99): a row's lastUpdatedStamp in milliseconds, "0" for none
const revisionOf = row => String(ms(row?.lastUpdatedStamp) ?? 0)
function requireRevision(revision, expected, label) {
    if (String(expected ?? "").trim() !== revision)
        denied("REVISION_CHANGED", label + " changed since you read it; open it again (revision " + revision + ")")
}

// ===== helpers =====
function nameOf(row) {
    if (!row) return ""
    return (
        row.organizationName ||
        [row.firstName, row.middleName, row.lastName].filter(Boolean).join(" ") ||
        row.pseudoId ||
        row.partyId ||
        ""
    )
}
function partyName(partyId) {
    return partyId ? nameOf(one("mantle.party.PartyDetail", {partyId})) || partyId : ""
}
function enumText(enumId) {
    if (!enumId) return ""
    const row = one("moqui.basic.Enumeration", {enumId})
    return row?.description || enumId
}
function statusText(statusId) {
    if (!statusId) return ""
    const row = one("moqui.basic.StatusItem", {statusId})
    return row?.description || statusId
}
// a current, dated relationship: from on or before now, no end or an end after now
function currentCondition() {
    const cf = factory()
    return cf.makeConditionDate("fromDate", "thruDate", now())
}
function scopeOrRefuse() {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "anyRead")
    return userScope
}
// The organizations of the scope as a list (every internal organization for an all-organizations scope).
function organizationIds(userScope) {
    if (userScope.organizationPartyIds != null) return Array.from(userScope.organizationPartyIds)
    return Array.from(find("mantle.party.PartyRole").condition("roleTypeId", "OrgInternal").selectField("partyId").list()).map(
        row => row.partyId
    )
}
function internalIds() {
    return Array.from(find("mantle.party.PartyRole").condition("roleTypeId", "OrgInternal").selectField("partyId").list()).map(
        row => row.partyId
    )
}
// The owners an account read covers: one organization named in the scope, else the scope's, each with the shared ones.
function owners(userScope, organizationPartyId) {
    if (organizationPartyId) return [sharedOwner, salesAccess.requireOrganization(userScope, organizationPartyId)]
    return userScope.organizationPartyIds == null ? null : [sharedOwner].concat(userScope.organizationPartyIds)
}
function notDisabled(field = "disabled") {
    const cf = factory()
    return cf.makeCondition([cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", "N")], "or")
}
function notPrivate(field = "privateOwnerUserId") {
    const cf = factory()
    return cf.makeCondition(
        [cf.makeCondition(field, "is-null", null), cf.makeCondition(field, "equals", ec.user.userId || "_NA_")],
        "or"
    )
}
function textCondition(text, fields) {
    const cf = factory()
    return cf.makeCondition(
        fields.map(field => cf.makeCondition(field, "like", likeText(text)).ignoreCase()),
        "or"
    )
}
// The current relationships of a kind to the parties, by the to party: {toPartyId: [row]}.
function currentTo(relationshipTypeEnumId, partyIds) {
    const out = {}
    if (!partyIds.length) return out
    for (const row of find("mantle.party.PartyRelationship")
        .condition("relationshipTypeEnumId", relationshipTypeEnumId)
        .condition("toPartyId", "in", partyIds)
        .condition(currentCondition())
        .orderBy("fromDate")
        .list())
        (out[row.toPartyId] = out[row.toPartyId] || []).push(row)
    return out
}
function emailOf(partyId) {
    const row = find("mantle.party.contact.PartyContactMechInfo")
        .condition("partyId", partyId)
        .condition("contactMechTypeEnumId", "CmtEmailAddress")
        .condition(currentCondition())
        .orderBy("-fromDate")
        .limit(1)
        .one()
    return row?.infoString || ""
}
function phoneOf(partyId) {
    const row = find("mantle.party.contact.PartyContactMechTelecomNumber")
        .condition("partyId", partyId)
        .condition(currentCondition())
        .orderBy("-fromDate")
        .limit(1)
        .one()
    return row ? [row.countryCode, row.areaCode, row.contactNumber].filter(Boolean).join(" ") : ""
}
// Whether a person works for the organization now (an employee, agent or member), as get#PartyInternalOrgIds counts it.
function worksFor(partyId, organizationPartyId) {
    return (
        find("mantle.party.PartyRelationship")
            .condition("fromPartyId", partyId)
            .condition("toPartyId", organizationPartyId)
            .condition("relationshipTypeEnumId", "in", memberRelationships)
            .condition(currentCondition())
            .count() > 0
    )
}
function ensureRole(partyId, roleTypeId) {
    if (!one("mantle.party.PartyRole", {partyId, roleTypeId})) lib.call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}

// ===== find#Accounts =====
// The accounts of the caller's scope (design §4 AccountList): those of the organization named, else of every organization of the
// scope, with the shared ones; by name or id, role (Customer or Prospect), kind, account manager (mine: the caller's own), parent
// account; each with its role, owner, account manager, contacts and, for a holder of SALES_TEAM_VIEW, its open orders. Paged in
// the query.
function findAccounts(p) {
    const userScope = scopeOrRefuse()
    const cf = factory()
    let query = find("mantle.party.PartyDetailAndRole")
        .condition(
            "roleTypeId",
            "in",
            p.roleTypeId && accountRoleTypes.includes(p.roleTypeId) ? [p.roleTypeId] : accountRoleTypes
        )
        .condition(notDisabled())
        .condition("mergedToPartyId", "is-null", null)
        .condition(notPrivate())
    const ownerIds = owners(userScope, p.organizationPartyId)
    if (ownerIds) query = query.condition("ownerPartyId", "in", ownerIds)
    const internal = internalIds()
    if (internal.length) query = query.condition("partyId", "not-in", internal)
    const text = String(p.text || "").trim()
    if (text) query = query.condition(textCondition(text, ["partyId", "pseudoId", "organizationName", "firstName", "lastName"]))
    if (p.partyTypeEnumId) query = query.condition("partyTypeEnumId", p.partyTypeEnumId)
    const managerPartyId = p.mine === "Y" || p.mine === true ? userScope.partyId || "_NA_" : p.managerPartyId
    if (managerPartyId) {
        const managed = Array.from(
            find("mantle.party.PartyRelationship")
                .condition("fromPartyId", managerPartyId)
                .condition("relationshipTypeEnumId", managerRelationship)
                .condition(currentCondition())
                .selectField("toPartyId")
                .limit(1000)
                .list()
        ).map(row => row.toPartyId)
        query = query.condition("partyId", "in", managed.length ? managed : ["_NA_"])
    }
    if (p.parentAccountPartyId) {
        const children = Array.from(
            find("mantle.party.PartyRelationship")
                .condition("toPartyId", p.parentAccountPartyId)
                .condition("relationshipTypeEnumId", "PrtOrgRollup")
                .condition(currentCondition())
                .selectField("fromPartyId")
                .limit(1000)
                .list()
        ).map(row => row.fromPartyId)
        query = query.condition("partyId", "in", children.length ? children : ["_NA_"])
    }
    query = query
        .selectField("partyId")
        .selectField("pseudoId")
        .selectField("partyTypeEnumId")
        .selectField("organizationName")
        .selectField("firstName")
        .selectField("lastName")
        .selectField("ownerPartyId")
        .distinct(true)
        // a distinct find orders by its selected fields as they are (an ignore-case order is not in the select list)
        .orderBy(["organizationName", "lastName", "firstName", "partyId"])
    const paged = lib.page(query, p, "accountList", query.count(), {noLimitCap: 1000})
    const ids = paged.rows.map(row => row.partyId)
    return Object.assign(paged, {accountList: accountRows(userScope, paged.rows, ids)})
}
// The list's rows with their role, owner, managers, contacts and, for an organization reader, open orders, each read in one query.
function accountRows(userScope, found, ids) {
    const roles = {}
    if (ids.length)
        for (const row of find("mantle.party.PartyRole")
            .condition("partyId", "in", ids)
            .condition("roleTypeId", "in", accountRoleTypes)
            .list())
            (roles[row.partyId] = roles[row.partyId] || []).push(row.roleTypeId)
    const managers = currentTo(managerRelationship, ids)
    const contacts = currentTo("PrtContact", ids)
    const orderCounts = {}
    if (userScope.capabilities.teamRead && ids.length)
        for (const row of find("mantle.order.OrderHeaderAndPart")
            .condition("customerPartyId", "in", ids)
            .condition("vendorPartyId", "in", organizationIds(userScope))
            .condition("statusId", "in", ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"])
            .selectField("customerPartyId")
            .selectField("orderId")
            .distinct(true)
            .list())
            orderCounts[row.customerPartyId] = (orderCounts[row.customerPartyId] || 0) + 1
    const names = lib.partyNames(
        Object.values(managers)
            .flat()
            .map(row => row.fromPartyId)
            .concat(
                Object.values(contacts)
                    .flat()
                    .map(row => row.fromPartyId)
            )
            .concat(found.map(row => row.ownerPartyId).filter(id => id && id !== sharedOwner))
    )
    return found.map(row => {
        const accountRoles = roles[row.partyId] || []
        const contactRows = contacts[row.partyId] || []
        return {
            partyId: row.partyId,
            pseudoId: row.pseudoId || row.partyId,
            name: nameOf(row),
            partyTypeEnumId: row.partyTypeEnumId,
            kindText: row.partyTypeEnumId === "PtyPerson" ? L("Person") : L("Organization"),
            roleTypeId: accountRoles.includes("Customer") ? "Customer" : "Prospect",
            roleText: accountRoles.includes("Customer") ? L("Customer") : L("Prospect"),
            organizationPartyId: row.ownerPartyId && row.ownerPartyId !== sharedOwner ? row.ownerPartyId : null,
            ownerText:
                !row.ownerPartyId || row.ownerPartyId === sharedOwner ? L("Shared") : names[row.ownerPartyId] || row.ownerPartyId,
            managerText: (managers[row.partyId] || []).map(rel => names[rel.fromPartyId] || rel.fromPartyId).join(", "),
            contactText: contactRows.length ? names[contactRows[0].fromPartyId] || contactRows[0].fromPartyId : "",
            contactCount: contactRows.length,
            openOrderCount: userScope.capabilities.teamRead ? orderCounts[row.partyId] || 0 : null
        }
    })
}

// ===== find#AccountContacts =====
// The contacts of the caller's accounts (design §4 Contacts): current PrtContact relationships to an account of the scope (one
// account named, which must be the caller's; one person's accounts with contactPartyId), by name or account; each row the person, the account, the title and the date.
function findContacts(p) {
    const userScope = scopeOrRefuse()
    let query = find("mantle.sales.SalesAccountContact")
        .condition("relationshipTypeEnumId", "PrtContact")
        .condition(currentCondition())
        .condition("accountRoleTypeId", "in", accountRoleTypes)
        .condition(notDisabled("accountDisabled"))
        .condition(notDisabled("contactDisabled"))
        .condition(notPrivate("accountPrivateOwnerUserId"))
        .condition(notPrivate("contactPrivateOwnerUserId"))
    if (p.accountPartyId) {
        salesAccess.requireAccount(userScope, p.accountPartyId)
        query = query.condition("accountPartyId", p.accountPartyId)
    }
    if (p.contactPartyId) query = query.condition("contactPartyId", p.contactPartyId)
    const ownerIds = owners(userScope, p.organizationPartyId)
    if (ownerIds) query = query.condition("accountOwnerPartyId", "in", ownerIds).condition("contactOwnerPartyId", "in", ownerIds)
    const internal = internalIds()
    if (internal.length) query = query.condition("accountPartyId", "not-in", internal)
    const text = String(p.text || "").trim()
    if (text)
        query = query.condition(
            textCondition(text, ["contactPartyId", "contactPseudoId", "firstName", "lastName", "accountOrganizationName"])
        )
    query = query
        .selectField("partyRelationshipId")
        .selectField("contactPartyId")
        .selectField("contactPseudoId")
        .selectField("firstName")
        .selectField("lastName")
        .selectField("accountPartyId")
        .selectField("accountOrganizationName")
        .selectField("accountFirstName")
        .selectField("accountLastName")
        .selectField("relationshipName")
        .selectField("fromDate")
        .selectField("relationshipStamp")
        .distinct(true)
        .orderBy(["lastName", "firstName", "partyRelationshipId"])
    const paged = lib.page(query, p, "contactList", query.count(), {noLimitCap: 1000})
    const contactList = paged.rows.map(row => ({
        partyRelationshipId: row.partyRelationshipId,
        partyId: row.contactPartyId,
        pseudoId: row.contactPseudoId || row.contactPartyId,
        name: [row.firstName, row.lastName].filter(Boolean).join(" ") || row.contactPartyId,
        accountPartyId: row.accountPartyId,
        accountName:
            row.accountOrganizationName ||
            [row.accountFirstName, row.accountLastName].filter(Boolean).join(" ") ||
            row.accountPartyId,
        titleText: row.relationshipName || "",
        email: emailOf(row.contactPartyId),
        phone: phoneOf(row.contactPartyId),
        fromText: dayText(row.fromDate),
        revision: String(ms(row.relationshipStamp) ?? 0)
    }))
    return Object.assign(paged, {contactList})
}

// ===== get#CustomerSales =====
// Customer360's Sales summary (design §4 Customer360; crosscut §3.2 Sales row): the account as the caller may read it, its owner,
// account managers, parent and child accounts of the scope, its contacts and contact details, and, by the caller's rights, its
// orders with the organizations of the scope (SALES_TEAM_VIEW, until P11's order scope) and its invoices from them (a finance
// reader). An account outside the scope is not found, like a missing one.
function customerSales(p) {
    const userScope = scopeOrRefuse()
    const customerPartyId = String(p.customerPartyId || "")
    const account = salesAccess.accountOf(userScope, customerPartyId)
    if (!account) return {customerFound: false, customerPartyId, customerDetail: null}
    const party = account.party
    const detail = one("mantle.party.PartyDetail", {partyId: customerPartyId})
    const caps = userScope.capabilities
    const vendors = p.organizationPartyId
        ? [salesAccess.requireOrganization(userScope, p.organizationPartyId)]
        : organizationIds(userScope)
    const roles = rows("mantle.party.PartyRole", {partyId: customerPartyId}).map(row => row.roleTypeId)
    const managers = (currentTo(managerRelationship, [customerPartyId])[customerPartyId] || []).map(row => ({
        partyRelationshipId: row.partyRelationshipId,
        partyId: row.fromPartyId,
        name: partyName(row.fromPartyId),
        fromText: dayText(row.fromDate),
        revision: revisionOf(row)
    }))
    const parentRow = Array.from(
        find("mantle.party.PartyRelationship")
            .condition("fromPartyId", customerPartyId)
            .condition("relationshipTypeEnumId", "PrtOrgRollup")
            .condition(currentCondition())
            .list()
    ).find(row => salesAccess.accountOf(userScope, row.toPartyId))
    const children = []
    for (const row of find("mantle.party.PartyRelationship")
        .condition("toPartyId", customerPartyId)
        .condition("relationshipTypeEnumId", "PrtOrgRollup")
        .condition(currentCondition())
        .limit(listCap)
        .list())
        if (salesAccess.accountOf(userScope, row.fromPartyId))
            children.push({partyId: row.fromPartyId, name: partyName(row.fromPartyId)})
    const contacts = []
    for (const row of currentTo("PrtContact", [customerPartyId])[customerPartyId] || []) {
        if (!salesAccess.visibleParty(userScope, row.fromPartyId)) continue
        contacts.push({
            partyRelationshipId: row.partyRelationshipId,
            partyId: row.fromPartyId,
            name: partyName(row.fromPartyId),
            titleText: row.relationshipName || "",
            email: emailOf(row.fromPartyId),
            phone: phoneOf(row.fromPartyId),
            fromText: dayText(row.fromDate),
            revision: revisionOf(row)
        })
    }
    const ordersRead = !!caps.teamRead
    const orders = ordersRead ? ordersOf(customerPartyId, vendors) : []
    const financeRead = access.has("ACCOUNTING_VIEW") || access.has("RECEIVABLE_VIEW")
    const invoices = financeRead ? invoicesOf(customerPartyId, vendors) : []
    const organizationPartyId = account.organizationPartyId
    return {
        customerFound: true,
        customerPartyId,
        customerDetail: {
            customerName: nameOf(detail),
            pseudoId: party.pseudoId || customerPartyId,
            partyTypeEnumId: party.partyTypeEnumId,
            kindText: party.partyTypeEnumId === "PtyPerson" ? L("Person") : L("Organization"),
            roleText: roles.includes("Customer") ? L("Customer") : roles.includes("Prospect") ? L("Prospect") : L("Account"),
            organizationPartyId,
            shared: account.shared,
            ownerText: account.shared ? L("Shared account") : partyName(organizationPartyId),
            email: emailOf(customerPartyId),
            phone: phoneOf(customerPartyId),
            comments: party.comments || "",
            managers,
            // the revision set#AccountManager names: the current manager relationship's, "0" when there is none (P4, F99)
            managerRevision: managerRevision(managers.map(row => ({lastUpdatedStamp: Number(row.revision)}))),
            parent: parentRow ? {partyId: parentRow.toPartyId, name: partyName(parentRow.toPartyId)} : null,
            children,
            contacts,
            contactCount: contacts.length,
            ordersRead,
            orders,
            openOrderCount: ordersRead
                ? orders.filter(row => ["OrderPlaced", "OrderProcessing", "OrderApproved", "OrderHold"].includes(row.statusId))
                      .length
                : null,
            financeRead,
            invoices,
            openInvoiceCount: financeRead ? invoices.filter(row => !row.paid).length : null,
            // the account's own organization's edits: a shared account's contacts are added for an organization of the scope
            canEdit: !!caps.accountEdit,
            canManage: !!caps.accountEdit && (caps.teamManage || caps.configure) && !!organizationPartyId,
            canMerge: salesAccess.mergesFor(userScope, organizationPartyId)
        }
    }
}
// The account's orders with the organizations, newest first: no quote template or recurring base (F7).
function ordersOf(customerPartyId, vendors) {
    if (!vendors.length) return []
    const found = Array.from(
        find("mantle.order.OrderHeaderAndPart")
            .condition("customerPartyId", customerPartyId)
            .condition("vendorPartyId", "in", vendors)
            .condition(
                factory().makeCondition(
                    [
                        factory().makeCondition("orderPurposeEnumId", "is-null", null),
                        factory().makeCondition("orderPurposeEnumId", "not-in", ["OrpRecurringTemplate", "OrpSalesQuoteTemplate"])
                    ],
                    "or"
                )
            )
            .selectField("orderId")
            .selectField("entryDate")
            .selectField("statusId")
            .selectField("grandTotal")
            .selectField("currencyUomId")
            .selectField("orderName")
            .selectField("vendorPartyId")
            .distinct(true)
            .orderBy("-entryDate")
            .limit(listCap)
            .list()
    )
    const seen = new Set()
    return found
        .filter(row => !seen.has(row.orderId) && seen.add(row.orderId))
        .map(row => ({
            orderId: row.orderId,
            orderName: row.orderName || "",
            entryText: dayText(row.entryDate),
            statusId: row.statusId,
            statusText: statusText(row.statusId),
            totalText: money(row.grandTotal ?? 0, row.currencyUomId),
            organizationName: partyName(row.vendorPartyId)
        }))
}
// The account's invoices from the organizations, newest first, for a finance reader.
function invoicesOf(customerPartyId, vendors) {
    if (!vendors.length) return []
    return Array.from(
        find("mantle.account.invoice.Invoice")
            .condition("toPartyId", customerPartyId)
            .condition("fromPartyId", "in", vendors)
            .condition("statusId", "not-equals", "InvoiceCancelled")
            .orderBy("-invoiceDate")
            .limit(listCap)
            .list()
    ).map(invoice => ({
        invoiceId: invoice.invoiceId,
        statusText: statusText(invoice.statusId),
        dateText: dayText(invoice.invoiceDate),
        dueText: dayText(invoice.dueDate),
        totalText: money(invoice.invoiceTotal ?? 0, invoice.currencyUomId),
        unpaidText: money(invoice.unpaidTotal ?? 0, invoice.currencyUomId),
        paid: invoice.statusId === "InvoicePmtRecvd"
    }))
}

// ===== get#AccountDocumentCounts =====
// The Sales documents each party carries with the organizations of the scope, for MergeAccounts' Compare (design §4): its
// opportunities (as the account or a party), orders and agreements; read only, for an organization reader (SALES_TEAM_VIEW). A
// party outside the scope gives no count.
function documentCounts(p) {
    const userScope = scopeOrRefuse()
    salesAccess.requireCapability(userScope, "teamRead")
    const organizations = organizationIds(userScope)
    const counts = []
    for (const partyId of Array.from(p.partyIdList || []).map(String)) {
        if (!salesAccess.visibleParty(userScope, partyId)) continue
        const opportunityIds = new Set(
            Array.from(
                find("mantle.sales.opportunity.SalesOpportunity")
                    .condition("accountPartyId", partyId)
                    .condition("organizationPartyId", "in", organizations)
                    .selectField("salesOpportunityId")
                    .list()
            ).map(row => row.salesOpportunityId)
        )
        for (const row of find("mantle.sales.opportunity.SalesOpportunityParty").condition("partyId", partyId).list()) {
            const opportunity = one("mantle.sales.opportunity.SalesOpportunity", {salesOpportunityId: row.salesOpportunityId})
            if (opportunity && organizations.includes(opportunity.organizationPartyId)) opportunityIds.add(row.salesOpportunityId)
        }
        counts.push({
            partyId,
            opportunityCount: opportunityIds.size,
            orderCount: find("mantle.order.OrderHeaderAndPart")
                .condition("customerPartyId", partyId)
                .condition("vendorPartyId", "in", organizations)
                .selectField("orderId")
                .distinct(true)
                .count(),
            agreementCount: find("mantle.party.agreement.Agreement")
                .condition("otherPartyId", partyId)
                .condition("organizationPartyId", "in", organizations)
                .count()
        })
    }
    return {counts}
}

// ===== create#Account =====
// An account of an organization of the caller's scope (NewAccount, NewPerson): an organization (organizationName) or a person
// (firstName, lastName), owned by that organization, with the Account role and Customer or Prospect, its parent account (an
// account of the scope, of the same organization or shared) and its account manager (the caller, or a person who works for the
// organization). Refuses a caller without SALES_ACCOUNT_EDIT, an organization outside the scope, an unknown or another
// organization's parent and a manager who does not work for the organization.
function createAccount(p) {
    const userScope = salesAccess.scope()
    const organizationPartyId = salesAccess.accountOrganization(userScope, p.organizationPartyId)
    const partyTypeEnumId = p.partyTypeEnumId === "PtyPerson" ? "PtyPerson" : "PtyOrganization"
    const roleTypeId = p.roleTypeId === "Prospect" ? "Prospect" : "Customer"
    if (partyTypeEnumId === "PtyOrganization" && !String(p.organizationName || "").trim())
        denied("NAME_REQUIRED", "Enter the account's name")
    if (partyTypeEnumId === "PtyPerson" && !String(p.firstName || "").trim() && !String(p.lastName || "").trim())
        denied("NAME_REQUIRED", "Enter the person's name")
    if (p.parentAccountPartyId) {
        const parent = salesAccess.requireAccount(userScope, p.parentAccountPartyId)
        if (parent.organizationPartyId && parent.organizationPartyId !== organizationPartyId)
            denied("RECORD_UNAVAILABLE", "Account " + p.parentAccountPartyId + " is not available")
    }
    const managerPartyId = managerFor(userScope, organizationPartyId, p.managerPartyId)
    const partyId = lib.call("create#mantle.party.Party", {
        partyTypeEnumId,
        ownerPartyId: organizationPartyId,
        disabled: "N",
        comments: p.comments || null
    }).partyId
    if (partyTypeEnumId === "PtyPerson")
        lib.call("create#mantle.party.Person", {partyId, firstName: p.firstName || null, lastName: p.lastName || null})
    else lib.call("create#mantle.party.Organization", {partyId, organizationName: String(p.organizationName).trim()})
    ensureRole(partyId, "Account")
    ensureRole(partyId, roleTypeId)
    if (p.parentAccountPartyId)
        lib.call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: partyId,
            fromRoleTypeId: "Account",
            toPartyId: p.parentAccountPartyId,
            toRoleTypeId: "Account",
            fromDate: now()
        })
    if (managerPartyId) startManager(partyId, managerPartyId)
    contactDetails(partyId, p)
    return {partyId}
}
// The manager of a new account: the one named, who must work for the organization, else the caller when they do.
function managerFor(userScope, organizationPartyId, managerPartyId) {
    if (managerPartyId) {
        if (!worksFor(managerPartyId, organizationPartyId))
            denied("MANAGER_INVALID", "The account manager must work for the account's organization")
        return managerPartyId
    }
    return userScope.partyId && worksFor(userScope.partyId, organizationPartyId) ? userScope.partyId : null
}
function startManager(accountPartyId, managerPartyId) {
    ensureRole(managerPartyId, "SalesRepresentative")
    lib.call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: managerRelationship,
        fromPartyId: managerPartyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: accountPartyId,
        toRoleTypeId: "Account",
        fromDate: now()
    })
}
// An email address and a phone number given with a new account or contact.
function contactDetails(partyId, p) {
    if (p.emailAddress)
        lib.call("mantle.party.ContactServices.create#EmailAddress", {
            partyId,
            emailAddress: String(p.emailAddress).trim(),
            contactMechPurposeId: "EmailPrimary"
        })
    if (p.contactNumber)
        lib.call("mantle.party.ContactServices.create#TelecomNumber", {
            partyId,
            countryCode: p.countryCode || null,
            areaCode: p.areaCode || null,
            contactNumber: String(p.contactNumber).trim(),
            contactMechPurposeId: "PhonePrimary"
        })
}
// An account's write: the account of the scope and the organization it is changed for (its own; for a shared account the one
// named, else the caller's active or only one). Refuses a caller without SALES_ACCOUNT_EDIT.
function accountForWrite(userScope, accountPartyId, organizationPartyId) {
    salesAccess.requireCapability(userScope, "accountEdit")
    const account = salesAccess.requireAccount(userScope, accountPartyId)
    return {
        account,
        organizationPartyId: account.organizationPartyId || salesAccess.accountOrganization(userScope, organizationPartyId)
    }
}

// The revision of an account's management: its latest current manager relationship's, "0" with none.
function managerRevision(current) {
    return String(current.reduce((max, row) => Math.max(max, ms(row.lastUpdatedStamp) ?? 0), 0))
}

// ===== set#AccountManager =====
// The account's manager from now (design §4 Customer360's Overview): the current one ended, the new one started, a person who works
// for the account's organization. A manager or administrator (SALES_TEAM_MANAGE or SALES_CONFIGURE) changes any account of their
// organization; a representative takes an account with no manager. Refuses a shared account (it has no organization to manage it).
function setManager(p) {
    const userScope = salesAccess.scope()
    const {account} = accountForWrite(userScope, p.accountPartyId, null)
    if (!account.organizationPartyId) denied("ACCOUNT_SHARED", "A shared account has no account manager")
    const current = currentTo(managerRelationship, [p.accountPartyId])[p.accountPartyId] || []
    const caps = userScope.capabilities
    if (!(caps.teamManage || caps.configure) && (current.length || p.managerPartyId !== userScope.partyId))
        denied("PERMISSION_DENIED", "Only a sales manager changes an account's manager")
    if (!p.managerPartyId || !worksFor(p.managerPartyId, account.organizationPartyId))
        denied("MANAGER_INVALID", "The account manager must work for the account's organization")
    // the management read (P4, F99): its current manager relationship's revision, "0" when it had none
    requireRevision(managerRevision(current), p.expectedRevision, "The account's manager")
    if (current.some(row => row.fromPartyId === p.managerPartyId)) return {accountPartyId: p.accountPartyId}
    for (const row of current)
        lib.call("update#mantle.party.PartyRelationship", {partyRelationshipId: row.partyRelationshipId, thruDate: now()})
    startManager(p.accountPartyId, p.managerPartyId)
    return {accountPartyId: p.accountPartyId}
}

// ===== create#Contact, add#Contact, delete#Contact =====
// A new person as a contact of an account of the scope, owned by the account's organization (for a shared account, the
// organization named or the caller's), with the Contact role.
function createContact(p) {
    const userScope = salesAccess.scope()
    const {organizationPartyId} = accountForWrite(userScope, p.accountPartyId, p.organizationPartyId)
    if (!String(p.firstName || "").trim() && !String(p.lastName || "").trim()) denied("NAME_REQUIRED", "Enter the contact's name")
    const partyId = lib.call("create#mantle.party.Party", {
        partyTypeEnumId: "PtyPerson",
        ownerPartyId: organizationPartyId,
        disabled: "N"
    }).partyId
    lib.call("create#mantle.party.Person", {partyId, firstName: p.firstName || null, lastName: p.lastName || null})
    ensureRole(partyId, "Contact")
    startContact(partyId, p.accountPartyId, p.relationshipName)
    contactDetails(partyId, p)
    return {partyId}
}
// An existing person as a contact of an account: a person the caller may see (of the scope or shared, never someone else's
// personal contact or an internal party), not a contact of it already.
function addContact(p) {
    const userScope = salesAccess.scope()
    accountForWrite(userScope, p.accountPartyId, p.organizationPartyId)
    const person = salesAccess.visibleParty(userScope, p.partyId)
    if (!person || person.partyTypeEnumId !== "PtyPerson" || salesAccess.isInternal(p.partyId))
        denied("RECORD_UNAVAILABLE", "Person " + (p.partyId || "") + " is not available")
    const current = (currentTo("PrtContact", [p.accountPartyId])[p.accountPartyId] || []).find(
        row => row.fromPartyId === p.partyId
    )
    if (current) return {partyId: p.partyId, partyRelationshipId: current.partyRelationshipId}
    ensureRole(p.partyId, "Contact")
    return {partyId: p.partyId, partyRelationshipId: startContact(p.partyId, p.accountPartyId, p.relationshipName)}
}
function startContact(partyId, accountPartyId, relationshipName) {
    return lib.call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtContact",
        fromPartyId: partyId,
        fromRoleTypeId: "Contact",
        toPartyId: accountPartyId,
        toRoleTypeId: "Account",
        relationshipName: relationshipName || null,
        fromDate: now()
    }).partyRelationshipId
}
// Ends a contact's relationship with an account of the scope; the person is kept. Refuses another kind of relationship and one of
// an account outside the scope alike (RECORD_UNAVAILABLE).
function endContact(p) {
    const userScope = salesAccess.scope()
    salesAccess.requireCapability(userScope, "accountEdit")
    const row = one("mantle.party.PartyRelationship", {partyRelationshipId: p.partyRelationshipId})
    if (!row || row.relationshipTypeEnumId !== "PrtContact" || !salesAccess.accountOf(userScope, row.toPartyId))
        denied("RECORD_UNAVAILABLE", "Contact relationship " + (p.partyRelationshipId || "") + " is not available")
    // the relationship read (P4, F99)
    requireRevision(revisionOf(row), p.expectedRevision, "This contact")
    if (row.thruDate && ms(row.thruDate) <= ms(now())) return {partyRelationshipId: row.partyRelationshipId}
    lib.call("update#mantle.party.PartyRelationship", {partyRelationshipId: row.partyRelationshipId, thruDate: now()})
    return {partyRelationshipId: row.partyRelationshipId}
}

const operations = {
    findAccounts,
    findContacts,
    customerSales,
    documentCounts,
    createAccount,
    setManager,
    createContact,
    addContact,
    endContact
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown sales account operation " + op)
        return operations[op](parameters || {})
    }
})
