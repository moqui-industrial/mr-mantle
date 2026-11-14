// Spec-local fixtures of Sales' quote issue and response specs (impl-sales P10; SalesQuoteIssue, SalesQuoteResponse): organizations
// (A counts commercial changes only and mails from its own address through a spec mail server; B does not count them only; C names a
// tax gateway and has no store), users (a rep who sends, a rep who may not send, a rep of B, a manager of A), an account of each with
// contacts (one with an email, one without) and a priced product. The users' services run with artifact authorization on under a
// spec grant of the Sales services.
const call = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
    return out
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const issueService = "mantle.order.SalesQuoteIssueServices."
const quoteService = "mantle.order.SalesQuoteServices."

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// A call as the user with artifact authorization on: its result, or the refusal's message (refused), in a transaction of its own.
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(verb.includes(".") ? verb : issueService + verb)
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
function email(partyId, address) {
    const mech = make("mantle.party.contact.ContactMech", {contactMechTypeEnumId: "CmtEmailAddress", infoString: address})
    make("mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId: mech.contactMechId,
        contactMechPurposeId: "EmailPrimary",
        fromDate: ec.user.nowTimestamp
    })
}
function postal(partyId) {
    const mech = make("mantle.party.contact.ContactMech", {contactMechTypeEnumId: "CmtPostalAddress"})
    make("mantle.party.contact.PostalAddress", {
        contactMechId: mech.contactMechId,
        address1: "1 Main St",
        city: "Salt Lake City",
        postalCode: "84101",
        countryGeoId: "USA",
        stateProvinceGeoId: "USA_UT"
    })
    make("mantle.party.contact.PartyContactMech", {
        partyId,
        contactMechId: mech.contactMechId,
        contactMechPurposeId: "PostalPrimary",
        fromDate: ec.user.nowTimestamp
    })
    return mech.contactMechId
}
function person(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: name, lastName: "Contact"})
}
// A user of the spec, agent of the organizations, in a group of its own holding the permissions and the spec's service grant (P11:
// exported for SalesOrderApproval and StorelessOrderConfirmation).
function addUser(f, kind, organizationPartyIds, permissions) {
    const id = f.prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Issue", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Issue " + kind})
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
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: f.prefix + "_GRANT", fromDate: 0})
    return id
}
// The fixtures of a spec: ids under its prefix.
function setup(prefix) {
    const f = {
        prefix,
        orgA: prefix + "_ORG_A",
        orgB: prefix + "_ORG_B",
        orgC: prefix + "_ORG_C",
        product: prefix + "_PRICED",
        template: prefix + "_QUOTE_MAIL",
        users: {},
        accounts: {},
        contacts: {}
    }
    system(() => {
        make("moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N"
        })
        make("moqui.basic.email.EmailTemplate", {
            emailTemplateId: f.template,
            description: "Quote spec mail",
            emailServerId: prefix + "_SMTP",
            fromAddress: "${fromAddress}",
            fromName: "${fromName}",
            subject: "${subject}"
        })
        const organization = (partyId, name, preference) => {
            make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
            make("mantle.party.Organization", {partyId, organizationName: name})
            make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
            make(
                "mantle.ledger.config.PartyAcctgPreference",
                Object.assign({organizationPartyId: partyId, baseCurrencyUomId: "USD"}, preference)
            )
            email(partyId, "sales@" + partyId.toLowerCase().replace(/_/g, "-") + ".example.test")
            // the organization's defaults: 30 days' validity, its quotes mailed through the spec's mail server
            make("mantle.sales.policy.SalesPolicy", {
                organizationPartyId: partyId,
                fromDate: ec.user.nowTimestamp,
                quoteValidityDays: 30,
                quoteEmailTemplateId: f.template,
                changeReason: "Spec defaults"
            })
        }
        organization(f.orgA, "Issue A", {salesCommercialRevisionOnly: "Y"})
        organization(f.orgB, "Issue B", {salesCommercialRevisionOnly: "N"})
        organization(f.orgC, "Issue C", {salesCommercialRevisionOnly: "Y", taxGatewayConfigId: "LOCAL"})
        make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Quote issue spec grant"})
        make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Quote issue spec services"})
        make("moqui.security.ArtifactGroupMember", {
            artifactGroupId: prefix + "_SERVICES",
            artifactName: "mantle\\.(order\\.Sales(Quote|Approval|QuoteIssue|Order)Services|sales\\.SalesWorkspaceServices)\\..*",
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
        const user = (kind, organizationPartyIds, permissions) => addUser(f, kind, organizationPartyIds, permissions)
        const rep = ["SALES_VIEW", "SALES_QUOTE_EDIT", "SALES_QUOTE_SEND"]
        f.users.rep = user("rep", [f.orgA, f.orgB, f.orgC], rep)
        f.users.drafter = user("drafter", [f.orgA], ["SALES_VIEW", "SALES_QUOTE_EDIT"])
        f.users.repB = user("repb", [f.orgB], rep)
        const account = (kind, ownerPartyId) => {
            const partyId = prefix + "_ACC_" + kind.toUpperCase()
            make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId})
            make("mantle.party.Organization", {partyId, organizationName: "Account " + kind})
            make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
            return partyId
        }
        f.accounts.a = account("a", f.orgA)
        f.accounts.b = account("b", f.orgB)
        f.accounts.c = account("c", f.orgC)
        f.accounts.cNoAddress = account("cn", f.orgC)
        postal(f.accounts.c)
        // the A account's two contacts: one with an email, one without
        f.contacts.mailed = prefix + "_MAILED"
        f.contacts.unmailed = prefix + "_UNMAILED"
        person(f.contacts.mailed, "Mailed")
        person(f.contacts.unmailed, "Unmailed")
        for (const fromPartyId of [f.contacts.mailed, f.contacts.unmailed])
            make("mantle.party.PartyRelationship", {
                fromPartyId,
                toPartyId: f.accounts.a,
                relationshipTypeEnumId: "PrtContact",
                fromDate: 0
            })
        email(f.contacts.mailed, prefix.toLowerCase() + "_mailed@issue.example.test")
        make("mantle.product.Product", {productId: f.product, productName: "Priced", productTypeEnumId: "PtService"})
        for (const vendorPartyId of [f.orgA, f.orgB, f.orgC])
            make("mantle.product.ProductPrice", {
                productId: f.product,
                vendorPartyId,
                pricePurposeEnumId: "PppPurchase",
                priceTypeEnumId: "PptCurrent",
                fromDate: 0,
                minQuantity: 1,
                priceUomId: "USD",
                price: "100"
            })
    })
    return f
}
const revision = orderId => Number(one("mantle.order.OrderHeader", {orderId}).orderRevision ?? 1)
const status = orderId => one("mantle.order.OrderHeader", {orderId}).statusId
// A quote of the user with one line at the product's price, proposed (its result, or the refusal).
function proposedQuote(f, username, organizationPartyId, customerPartyId, contactPartyId) {
    const orderId = as(username, quoteService + "create#Quote", {organizationPartyId, customerPartyId, contactPartyId}).orderId
    as(username, quoteService + "store#QuoteLine", {orderId, orderRevision: revision(orderId), productId: f.product, quantity: 2})
    const proposed = as(username, quoteService + "propose#Quote", {orderId, orderRevision: revision(orderId)})
    return {orderId, proposed}
}
// The issue's ledger deliveries attempted now (send#Quote attempts them once it commits; this attempts any still queued).
function attempt(issueId) {
    return system(() => call(issueService + "attempt#QuoteDeliveries", {issueId}))
}
function deliveries(issueId) {
    return system(() =>
        Array.from(
            ec.entity
                .find("mantle.party.MessageDelivery")
                .condition("eventKey", "SalesQuoteIssue:" + issueId)
                .list()
        )
    )
}
const key = name => (name + "-" + ec.user.randomString(12)).slice(0, 40)

;({
    call,
    system,
    as,
    make,
    one,
    email,
    postal,
    addUser,
    setup,
    revision,
    status,
    proposedQuote,
    attempt,
    deliveries,
    key,
    issueService,
    quoteService
})
