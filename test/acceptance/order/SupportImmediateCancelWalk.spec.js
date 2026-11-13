// The Support app's immediate cancel (impl-customer-service P15 review; X7, P10's customerImmediateCancel; CustomerOrders.js),
// Mantle only: with the organization's customerImmediateCancel on, an invited contact asks in the Support app to cancel a
// placed order with nothing reserved and it is cancelled at once ("Cancelled", the order cancelled, the decision the service
// policy's); an approved order's cancel is still only requested. The flag is put back off in the cleanup. The requested path
// and its refusals are the regression SupportPortal spec's. Standalone: a spec-local organization, customer, contact, site and
// queue. Run: ./moq accept mr-mantle --spec SupportImmediateCancelWalk
const prefix = "SPIC"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    facility = prefix + "_WH",
    siteId = prefix + "_SITE",
    product = "DEMO_1_1",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    O = "mantle.order.OrderChangeServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
let keySeq = 0
const opId = () => prefix + "op" + ++keySeq + "x" + Date.now()

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
// a PASS operation as the account, as pass.Facade calls it: its result, or the error's kind
function page(username, service, input) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(service)
            .parameters({input: Object.assign({siteId}, input)})
            .requireNewTransaction(true)
            .call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "Error", error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
function party(partyId, name, roleTypeId, typeId = "PtyOrganization", ownerPartyId = org) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Walk"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function account(partyId) {
    call("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: partyId.toLowerCase() + "@spic.example.test",
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    return partyId
}
// a placed sales order whose part reserves at approval (nothing reserved yet), approved when asked
function sale(approve) {
    login("john.doe")
    const order = call("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: facility
    })
    call("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        productId: product,
        quantity: 2,
        unitAmount: 20,
        requireInventory: false
    })
    call("update#mantle.order.OrderPart", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        reservationAutoEnumId: "AsResAutoApproved"
    })
    call("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    if (approve) call("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    return order.orderId
}
const defaults = immediate =>
    run(state.admin, S + "save#ServiceDefaults", {
        organizationPartyId: org,
        defaultCategoryId: state.queue,
        customerImmediateCancel: immediate ? "Y" : "N"
    })

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Support Immediate Cancel Co", "OrgInternal", "PtyOrganization", "_NA_")
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        party(customer, "Immediate Cancel Customer", "Customer")
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        // the administrator who sets the service defaults
        const admin = (state.admin = prefix + "_ADMIN")
        call("create#moqui.security.UserGroup", {userGroupId: admin, description: "Immediate cancel walk admin"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: admin,
            userPermissionId: "SUPPORT_POLICY_EDIT",
            fromDate: since
        })
        party(admin, "Walk admin", null, "PtyPerson")
        call("create#mantle.party.PartyRelationship", {
            fromPartyId: admin,
            toPartyId: org,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        account(admin)
        call("create#moqui.security.UserGroupMember", {userId: admin, userGroupId: admin, fromDate: since})
        state.queue = run(admin, S + "save#ServiceQueue", {organizationPartyId: org, description: "Walk queue"}).requestCategoryId
        defaults(true)
        call("create#mantle.public.PublicSite", {
            siteId,
            name: "Immediate cancel walk",
            state: "published",
            registrationMode: "invitation",
            locale: "en",
            timeZone: "UTC",
            policyRevision: 1,
            generation: 1
        })
        call("create#mantle.public.PublicSiteHost", {hostname: "spic.example.test", siteId, canonical: "Y"})
        call("create#mantle.public.PublicSiteApp", {
            siteId,
            appMountId: "support",
            app: "support",
            pathPrefix: "/support",
            enabled: "Y",
            targetId: org
        })
        // the customer's invited contact
        state.contact = prefix + "_CONTACT"
        party(state.contact, "Ivy", null, "PtyPerson", "_NA_")
        account(state.contact)
        call("create#mantle.party.ExternalAccessContact", {
            partyId: state.contact,
            outsidePartyId: customer,
            organizationPartyId: org,
            app: "support",
            fromDate: since
        })
        state.placed = sale(false)
        state.approved = sale(true)
    },
    cleanupSpec() {
        ec.artifactExecution.disableAuthz()
        // the flag back off
        defaults(false)
        for (const entity of ["mantle.public.PublicSiteApp", "mantle.public.PublicSiteHost", "mantle.public.PublicSite"])
            find(entity, {siteId}).deleteAll()
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("under customerImmediateCancel a placed order with nothing reserved is cancelled at once; an approved one is requested", {
    when() {
        const intake = page(state.contact, S + "get#CaseIntake", {orderId: state.placed})
        const asked = page(state.contact, O + "request#CustomerCancel", {
            orderId: state.placed,
            lines: intake.order.lines.map(line => ({orderItemSeqId: line.orderItemSeqId})),
            reason: "Ordered by mistake",
            consent: "Y",
            operationId: opId()
        })
        const read = page(state.contact, O + "get#CustomerCancel", {requestId: asked.requestId})
        const approvedIntake = page(state.contact, S + "get#CaseIntake", {orderId: state.approved})
        const approvedAsk = page(state.contact, O + "request#CustomerCancel", {
            orderId: state.approved,
            lines: approvedIntake.order.lines.map(line => ({orderItemSeqId: line.orderItemSeqId})),
            consent: "Y",
            operationId: opId()
        })
        return {
            intake,
            asked,
            read,
            order: one("mantle.order.OrderHeader", {orderId: state.placed}),
            decision: rows("mantle.request.support.OrderChangeDecision", {requestId: asked.requestId})[0],
            approvedAsk,
            approvedOrder: one("mantle.order.OrderHeader", {orderId: state.approved})
        }
    },
    then(r) {
        r.intake.order.capabilities.canRequestCancel === true
        r.asked.immediate === true && r.asked.stateText === "Cancelled"
        r.order.statusId === "OrderCancelled"
        r.decision.servicePolicyId != null && r.decision.decidedByUserId == null
        r.read.request.stateText === "Cancelled"
        !JSON.stringify(r.read).includes("customerImmediateCancel")
        r.approvedAsk.immediate === false && r.approvedAsk.stateText === "Cancellation requested"
        r.approvedOrder.statusId === "OrderApproved"
    }
})
