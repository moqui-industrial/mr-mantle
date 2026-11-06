// The Support app's customer services (impl-customer-service P15, CS-PORTAL; SupportPortal.js, CustomerReturns.js,
// CustomerOrders.js; ExternalAccess.js's self relationship and contact rule): a contact invited for a customer sees and files
// its own cases, a customer administrator the customer's, the customer's own account (a person with a verified email) its own
// with no invitation; an unverified own account, an uninvited account and another customer's case get nothing; a case shows
// outward messages and customer-shared files only, takes the customer's reply and is cancelled at its revision; a queue's form
// token files a request that reads no case, a forged token nothing; a return of a shipped order's eligible lines is requested
// with the server's facility and policy, read through its RMA link and withdrawn before receipt; a cancel request of an
// approved order is filed as a proposal ("Cancellation requested"), read and withdrawn by its filer. P15 review: MyCases' opaque
// cursor, a changed email ending the self relationship, a stale change naming the current revision, a retried return request
// answering the first and the authorization's notice to the customer with the return's link. Standalone: spec-local
// organization, customers, accounts, stock and site, artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec SupportPortal
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const svc = (name, p) => helper().call(name, p)
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const prefix = "SPP"
const org = prefix + "_ORG",
    customer = prefix + "_CUST",
    otherCustomer = prefix + "_CUST2",
    facility = prefix + "_WH",
    siteId = prefix + "_SITE",
    product = "DEMO_1_1",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    R = "mantle.order.ReturnPolicyServices.",
    O = "mantle.order.OrderChangeServices."
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
// a PASS operation as an account (null: a visitor), as pass.Facade calls it: its result, or the error's kind
function page(username, service, input) {
    if (username) login(username)
    else logout()
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
    svc("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId})
    if (typeId === "PtyOrganization") svc("create#mantle.party.Organization", {partyId, organizationName: name})
    else svc("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) svc("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function account(partyId, verifiedEmail) {
    svc("create#moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: verifiedEmail || partyId.toLowerCase() + "@spp.example.test",
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    if (verifiedEmail)
        svc("create#moqui.security.public.VerifiedAddress", {
            userId: partyId,
            emailAddress: verifiedEmail,
            verifiedAt: ec.user.nowTimestamp
        })
    return partyId
}
function staff(kind, permissions) {
    const id = prefix + "_" + kind
    svc("create#moqui.security.UserGroup", {userGroupId: id, description: "Support portal " + kind})
    for (const permission of permissions)
        svc("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Portal " + kind, null, "PtyPerson", org)
    svc("create#mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: org,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    account(id, null)
    svc("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// a contact grant as redeeming a Support invitation makes it
const grant = (partyId, outsidePartyId, administrator = null) =>
    svc("create#mantle.party.ExternalAccessContact", {
        partyId,
        outsidePartyId,
        organizationPartyId: org,
        app: "support",
        administrator,
        fromDate: since
    })
function sale(shipped) {
    login("john.doe")
    const order = svc("mantle.order.OrderServices.create#Order", {
        vendorPartyId: org,
        customerPartyId: customer,
        facilityId: facility
    })
    svc("mantle.order.OrderServices.add#OrderProductQuantity", {
        orderId: order.orderId,
        orderPartSeqId: order.orderPartSeqId,
        productId: product,
        quantity: 3,
        unitAmount: 20
    })
    svc("mantle.order.OrderServices.place#Order", {orderId: order.orderId})
    svc("mantle.order.OrderServices.approve#Order", {orderId: order.orderId})
    if (shipped)
        svc("mantle.shipment.ShipmentServices.ship#OrderPart", {orderId: order.orderId, orderPartSeqId: order.orderPartSeqId})
    return order.orderId
}
const capability = (recordType, recordId, scopes, token, partyId = customer) =>
    svc("create#mantle.party.ExternalAccessCapability", {
        organizationPartyId: org,
        partyId,
        recordType,
        recordId,
        scopes,
        tokenDigest: ec.user.singleUseCodeHash(token),
        fromDate: since,
        thruDate: new Date(Date.now() + 7 * 86400000),
        createdByUserId: ec.user.userId
    })
const token = name => (prefix + name + "0".repeat(48)).slice(0, 48)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Support Portal Spec Co", "OrgInternal", "PtyOrganization", "_NA_")
        svc("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        svc("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        party(customer, "Portal Customer Co", "Customer")
        party(otherCustomer, "Portal Other Customer", "Customer")
        svc("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        svc("mantle.product.AssetServices.receive#Asset", {
            productId: product,
            facilityId: facility,
            ownerPartyId: org,
            quantity: 20,
            acquireCost: 5
        })
        state.admin = staff("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT", "SUPPORT_CASE_MANAGE", "RETURN_POLICY_EDIT"])
        state.agent = staff("AGENT", ["SUPPORT_CASE_EDIT"])
        state.authorizer = staff("AUTHORIZER", ["RETURN_AUTHORIZE"])
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Portal spec queue"
        }).requestCategoryId
        state.hidden = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Portal spec internal queue"
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        state.setting = run(state.admin, S + "save#SupportAppSetting", {organizationPartyId: org, queueIds: state.queue})
        // the return policy a customer may use itself, and a customer reason
        run(state.admin, R + "save#Policy", {
            organizationPartyId: org,
            policyName: "Portal returns",
            windowDays: "30",
            windowFromEnumId: "RpwShipped",
            selfServiceEnabled: "Y",
            destinationFacilityId: facility
        })
        run(state.admin, R + "save#ReturnReason", {
            organizationPartyId: org,
            returnReasonEnumId: "RrsnDefective",
            customerLabel: "It does not work",
            customerVisible: "Y"
        })
        // the organization's site with the Support app
        svc("create#mantle.public.PublicSite", {
            siteId,
            name: "Support portal spec",
            state: "published",
            registrationMode: "invitation",
            locale: "en",
            timeZone: "UTC",
            policyRevision: 1,
            generation: 1
        })
        svc("create#mantle.public.PublicSiteHost", {hostname: "spp.example.test", siteId, canonical: "Y"})
        svc("create#mantle.public.PublicSiteApp", {
            siteId,
            appMountId: "support",
            app: "support",
            pathPrefix: "/support",
            enabled: "Y",
            targetId: org
        })
        // the customer's contacts: one invited, one invited as its administrator, one of the same email domain never invited;
        // a consumer customer with its own verified account, another with an unverified one
        state.contact = prefix + "_CONTACT"
        party(state.contact, "Ana", null, "PtyPerson", "_NA_")
        account(state.contact, "ana@portal-customer.example.test")
        grant(state.contact, customer)
        state.boss = prefix + "_BOSS"
        party(state.boss, "Bo", null, "PtyPerson", "_NA_")
        account(state.boss, "bo@portal-customer.example.test")
        grant(state.boss, customer, "Y")
        state.outsider = prefix + "_OUTSIDER"
        party(state.outsider, "Cy", null, "PtyPerson", "_NA_")
        account(state.outsider, "cy@portal-customer.example.test")
        state.self = prefix + "_SELF"
        party(state.self, "Dee", "Customer", "PtyPerson", org)
        account(state.self, "dee@consumer.example.test")
        state.unverified = prefix + "_UNVERIFIED"
        party(state.unverified, "Eve", "Customer", "PtyPerson", org)
        account(state.unverified, null)
        // the customer's address, for the return decision's notice
        const mech = svc("create#mantle.party.contact.ContactMech", {
            contactMechTypeEnumId: "CmtEmailAddress",
            infoString: "office@portal-customer.example.test"
        }).contactMechId
        svc("create#mantle.party.contact.PartyContactMech", {
            partyId: customer,
            contactMechId: mech,
            contactMechPurposeId: "EmailPrimary",
            fromDate: since
        })
        state.shipped = sale(true)
        state.approved = sale(false)
    },
    cleanupSpec() {
        ec.artifactExecution.disableAuthz()
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

feature("a contact files and sees its own cases, an administrator the customer's, the customer's own account its own", {
    when() {
        const filed = page(state.contact, S + "create#CustomerCase", {
            requestName: "Filter does not fit",
            description: "The new filter is too wide",
            operationId: opId()
        })
        const repeat = page(state.contact, S + "create#CustomerCase", {requestName: "x", description: "y", operationId: "short"})
        const hiddenQueue = page(state.contact, S + "create#CustomerCase", {
            requestName: "Other",
            description: "Other",
            requestCategoryId: state.hidden,
            operationId: opId()
        })
        const colleague = run(state.agent, S + "create#Case", {
            organizationPartyId: org,
            customerPartyId: customer,
            requestName: "Billing address change"
        }).requestId
        const other = run(state.agent, S + "create#Case", {
            organizationPartyId: org,
            customerPartyId: otherCustomer,
            requestName: "Another customer's"
        }).requestId
        const own = page(state.self, S + "create#CustomerCase", {
            requestName: "Thermostat reads high",
            description: "Two degrees",
            operationId: opId()
        })
        const ids = list => (list.caseList || []).map(row => row.requestId)
        Object.assign(state, {filed: filed.requestId, colleague, other})
        return {
            filed,
            repeat,
            hiddenQueue,
            contact: ids(page(state.contact, S + "find#CustomerCases", {})),
            boss: ids(page(state.boss, S + "find#CustomerCases", {})),
            outsider: page(state.outsider, S + "find#CustomerCases", {}),
            self: ids(page(state.self, S + "find#CustomerCases", {})),
            unverified: page(state.unverified, S + "find#CustomerCases", {}),
            ownId: own.requestId,
            colleagueAsContact: page(state.contact, S + "get#CustomerCase", {requestId: colleague}).kind,
            colleagueAsBoss: page(state.boss, S + "get#CustomerCase", {requestId: colleague}).case?.requestId,
            otherAsBoss: page(state.boss, S + "get#CustomerCase", {requestId: other}).kind,
            visitor: page(null, S + "get#CustomerCase", {requestId: filed.requestId}).kind,
            parties: rows("mantle.request.RequestParty", {requestId: filed.requestId}).map(
                row => row.roleTypeId + ":" + row.partyId
            ),
            profile: one("mantle.request.support.CaseProfile", {requestId: filed.requestId})
        }
    },
    then(r) {
        !!r.filed.requestId
        r.repeat.kind === "Unprocessable"
        r.hiddenQueue.kind === "Unprocessable"
        r.contact.includes(r.filed.requestId)
        !r.contact.includes(state.colleague)
        r.boss.includes(r.filed.requestId) && r.boss.includes(state.colleague)
        !r.boss.includes(state.other)
        r.outsider.caseList.length === 0 && r.outsider.customers.length === 0
        r.self.length === 1 && r.self[0] === r.ownId
        r.unverified.customers.length === 0
        r.colleagueAsContact === "NotFound"
        r.colleagueAsBoss === state.colleague
        r.otherAsBoss === "NotFound"
        r.visitor === "AuthenticationRequired"
        r.parties.includes("Customer:" + customer) &&
            r.parties.includes("Reporter:" + state.contact) &&
            r.parties.includes("OrgInternal:" + org)
        !!r.profile
    }
})

feature("MyCases pages by an opaque cursor scoped to the list and the account; a changed email ends the self relationship", {
    when() {
        const first = page(state.boss, S + "find#CustomerCases", {limit: 1})
        const second = page(state.boss, S + "find#CustomerCases", {limit: 1, cursor: first.nextCursor})
        const otherFilter = page(state.boss, S + "find#CustomerCases", {
            limit: 1,
            statusCategory: "open",
            cursor: first.nextCursor
        })
        const otherAccount = page(state.contact, S + "find#CustomerCases", {limit: 1, cursor: first.nextCursor})
        const altered = page(state.boss, S + "find#CustomerCases", {limit: 1, cursor: "00" + first.nextCursor})
        const tooMany = page(state.boss, S + "find#CustomerCases", {limit: 101})
        // the own account's email changed to an address not verified: no longer its own customer's
        svc("update#moqui.security.UserAccount", {userId: state.self, emailAddress: "dee.new@consumer.example.test"})
        const changed = page(state.self, S + "find#CustomerCases", {})
        svc("update#moqui.security.UserAccount", {userId: state.self, emailAddress: "dee@consumer.example.test"})
        const restored = page(state.self, S + "find#CustomerCases", {})
        return {first, second, otherFilter, otherAccount, altered, tooMany, changed, restored}
    },
    then(r) {
        r.first.caseList.length === 1 && !!r.first.nextCursor
        !/SPP/.test(r.first.nextCursor)
        r.second.caseList.length === 1 && r.second.caseList[0].requestId !== r.first.caseList[0].requestId
        r.otherFilter.kind === "Unprocessable"
        r.otherAccount.kind === "Unprocessable"
        r.altered.kind === "Unprocessable"
        r.tooMany.kind === "Unprocessable"
        r.changed.customers.length === 0 && r.changed.caseList.length === 0
        r.restored.caseList.length === 1
    }
})

feature("a case shows outward messages and shared files only, takes a reply, and is cancelled at its revision", {
    when() {
        const requestId = state.filed
        // an agent's internal note and file, and a file shared with the customer
        const note = svc("create#mantle.party.communication.CommunicationEvent", {
            communicationEventTypeId: "Comment",
            statusId: "CeReceived",
            fromPartyId: state.agent,
            body: "Internal: refund risk",
            entryDate: ec.user.nowTimestamp
        }).communicationEventId
        svc("create#mantle.request.RequestCommEvent", {requestId, communicationEventId: note})
        svc("create#mantle.request.RequestContent", {
            requestId,
            contentTypeEnumId: "RqCntInternal",
            contentLocation: "dbresource://spp/internal.pdf",
            contentDate: ec.user.nowTimestamp
        })
        svc("create#mantle.request.RequestContent", {
            requestId,
            contentTypeEnumId: "RqCntCustomerShared",
            contentLocation: "dbresource://spp/size-chart.pdf",
            contentDate: ec.user.nowTimestamp
        })
        const reply = page(state.contact, S + "reply#CustomerCase", {requestId, body: "It is 2 mm too wide", operationId: opId()})
        const read = page(state.contact, S + "get#CustomerCase", {requestId})
        const stale = page(state.contact, S + "cancel#CustomerCase", {requestId, expectedRevision: 1, reason: "Fixed it"})
        const cancelled = page(state.contact, S + "cancel#CustomerCase", {
            requestId,
            expectedRevision: read.case.revision,
            reason: "Fixed it myself"
        })
        return {reply, read, stale, cancelled, request: one("mantle.request.Request", {requestId})}
    },
    then({reply, read, stale, cancelled, request}) {
        !!reply.messageId
        read.messageList.some(m => m.body === "It is 2 mm too wide" && m.fromCustomer)
        !read.messageList.some(m => String(m.body).includes("refund risk"))
        read.fileList.length === 1 && read.fileList[0].filename === "size-chart.pdf"
        read.case.statusText === "Received"
        read.capabilities.canCancel === true
        stale.kind === "Conflict" && stale.error.includes("it is now at revision " + read.case.revision)
        cancelled.alreadyApplied === false
        request.statusId === "ReqCancelled" && request.requestResolutionEnumId === "RrWithdrawn"
    }
})

// P16: the case summary print (CaseSummary.js) holds what the page above shows in its customer-visible variant, and the note
// and internal file in its internal one, each labeled
feature("the case summary's customer copy holds the outward messages and shared files only; the internal one all, labeled", {
    when() {
        const print = (username, audience) => run(username, S + "get#CaseSummaryPrint", {requestId: state.filed, audience})
        return {
            customer: print(state.agent, "customer"),
            internal: print(state.agent, "internal"),
            invalid: print(state.agent, "partner"),
            refused: print(state.authorizer, "customer")
        }
    },
    then({customer, internal, invalid, refused}) {
        customer.error === "" && customer.audience === "customer"
        customer.printHtml.includes("Customer copy")
        customer.printHtml.includes("It is 2 mm too wide")
        customer.printHtml.includes("size-chart.pdf")
        customer.printHtml.includes("Withdrawn by the customer")
        !customer.printHtml.includes("refund risk")
        !customer.printHtml.includes("internal.pdf")
        !customer.printHtml.includes("Internal")
        internal.error === "" && internal.fileName.includes("-internal")
        internal.printHtml.includes("Internal: not for the customer")
        internal.printHtml.includes("refund risk")
        internal.printHtml.includes("internal.pdf")
        internal.printHtml.includes("It is 2 mm too wide")
        invalid.error.includes("AUDIENCE_INVALID")
        refused.error.includes("PERMISSION_DENIED")
    }
})

feature("a queue's form token files a request that reads no case; a forged token finds nothing", {
    when() {
        const intake = token("Intake")
        capability("RequestCategory", state.queue, "CaseIntake", intake, null)
        const intakeView = page(null, S + "get#CaseIntake", {token: intake})
        const sent = page(null, S + "create#CustomerCase", {
            token: intake,
            firstName: "Fay",
            lastName: "Visitor",
            emailAddress: "fay@visitor.example.test",
            requestName: "Do you ship to Canada?",
            description: "Asking before I order",
            operationId: opId()
        })
        const forged = page(null, S + "create#CustomerCase", {
            token: "x".repeat(48),
            firstName: "A",
            lastName: "B",
            emailAddress: "a@b.example.test",
            requestName: "s",
            description: "d",
            operationId: opId()
        })
        const made = rows("mantle.request.Request", {requestCategoryId: state.queue, requestName: "Do you ship to Canada?"})
        return {intakeView, sent, forged, made}
    },
    then({intakeView, sent, forged, made}) {
        intakeView.mode === "token" && intakeView.capabilities.needsSender === true
        sent.receipt.received === true
        sent.requestId == null
        forged.kind === "NotFound"
        made.length === 1
    }
})

feature("a return of a shipped order's eligible lines is requested, read through its RMA link and withdrawn before receipt", {
    when() {
        const offer = page(state.contact, R + "get#ReturnableOrder", {orderId: state.shipped})
        const seq = offer.order.lines[0].orderItemSeqId
        const tooMany = page(state.contact, R + "request#CustomerReturn", {
            orderId: state.shipped,
            lines: [{orderItemSeqId: seq, quantity: 9, returnReasonEnumId: "RrsnDefective", returnResponseEnumId: "RrspCredit"}],
            operationId: opId()
        })
        const otherReason = page(state.contact, R + "request#CustomerReturn", {
            orderId: state.shipped,
            lines: [
                {orderItemSeqId: seq, quantity: 1, returnReasonEnumId: "RrsnDamagedShip", returnResponseEnumId: "RrspCredit"}
            ],
            operationId: opId()
        })
        const requested = page(state.contact, R + "request#CustomerReturn", {
            orderId: state.shipped,
            lines: [{orderItemSeqId: seq, quantity: 1, returnReasonEnumId: "RrsnDefective", returnResponseEnumId: "RrspCredit"}],
            customerReference: "ANA-1",
            operationId: opId()
        })
        const header = one("mantle.order.return.ReturnHeader", {returnId: requested.returnId})
        const rma = token("Rma")
        capability("ReturnHeader", requested.returnId, "ReturnRma", rma)
        const byLink = page(null, R + "get#CustomerReturn", {token: rma})
        const outsider = page(state.outsider, R + "get#CustomerReturn", {returnId: requested.returnId})
        const listed = page(state.boss, R + "find#CustomerReturns", {})
        const withdrawn = page(null, R + "withdraw#CustomerReturn", {
            token: rma,
            expectedRevision: byLink.return.revision,
            operationId: opId()
        })
        return {
            offer,
            tooMany,
            otherReason,
            requested,
            header,
            byLink,
            outsider,
            listed,
            withdrawn,
            after: one("mantle.order.return.ReturnHeader", {returnId: requested.returnId})
        }
    },
    then(r) {
        r.offer.order.lines[0].returnable === true
        r.offer.reasons.some(row => row.text === "It does not work")
        r.tooMany.kind === "Unprocessable"
        r.otherReason.kind === "Unprocessable"
        !!r.requested.returnId
        r.header.statusId === "ReturnRequested" &&
            r.header.facilityId === facility &&
            !!r.header.returnPolicyId &&
            r.header.customerReference === "ANA-1"
        rows("mantle.order.return.ReturnParty", {returnId: r.requested.returnId, roleTypeId: "Assignee"}).length === 0
        r.byLink.return.reference && r.byLink.return.statusText === "Requested" && r.byLink.capabilities.canWithdraw === true
        r.byLink.via === "token"
        r.outsider.kind === "NotFound"
        r.listed.returnList.some(row => row.returnId === r.requested.returnId)
        r.withdrawn.alreadyApplied === false
        r.after.statusId === "ReturnCancelled"
    }
})

feature(
    "a retried return request answers the first; a withdrawal needs the revision shown; the authorization tells the customer",
    {
        when() {
            const seq = page(state.contact, R + "get#ReturnableOrder", {orderId: state.shipped}).order.lines[0].orderItemSeqId
            const input = {
                orderId: state.shipped,
                lines: [
                    {orderItemSeqId: seq, quantity: 3, returnReasonEnumId: "RrsnDefective", returnResponseEnumId: "RrspCredit"}
                ],
                operationId: opId()
            }
            const first = page(state.contact, R + "request#CustomerReturn", input)
            const retry = page(state.contact, R + "request#CustomerReturn", input)
            const otherPayload = page(
                state.contact,
                R + "request#CustomerReturn",
                Object.assign({}, input, {customerReference: "X"})
            )
            const noRevision = page(state.contact, R + "withdraw#CustomerReturn", {returnId: first.returnId, operationId: opId()})
            const stale = page(state.contact, R + "withdraw#CustomerReturn", {
                returnId: first.returnId,
                expectedRevision: "1",
                operationId: opId()
            })
            const authorized = run(state.authorizer, R + "authorize#Return", {operationKey: opId(), returnId: first.returnId})
            const end = Date.now() + 5000
            // The notice is sent after the authorization commits, on another thread: its message is written first as a
            // draft without a body, then given its body (ES_READY, or ES_SENT once sent), so wait for that.
            let notices = []
            while (!(notices.length && notices.every(row => row.statusId !== "ES_DRAFT")) && Date.now() < end)
                notices = rows("moqui.basic.email.EmailMessage", {emailTemplateId: "MANTLE_RETURN_DECISION_EMAIL"}).filter(row =>
                    String(row.toAddresses || "").includes("office@portal-customer.example.test")
                )
            return {first, retry, otherPayload, noRevision, stale, authorized, notices}
        },
        then(r) {
            !!r.first.returnId && r.first.alreadyApplied === false
            r.retry.returnId === r.first.returnId && r.retry.alreadyApplied === true
            r.otherPayload.kind === "Conflict"
            r.noRevision.kind === "Unprocessable"
            r.stale.kind === "Conflict" && r.stale.error.includes("it is now at revision")
            r.authorized.error === ""
            r.notices.length === 1
            String(r.notices[0].body).includes("https://spp.example.test/support/CustomerReturn?token=")
            String(r.notices[0].body).includes("is authorized")
        }
    }
)

feature("a cancel request of an approved order is filed as a proposal, read and withdrawn by its filer", {
    when() {
        const intake = page(state.contact, S + "get#CaseIntake", {orderId: state.approved})
        const seq = intake.order.lines[0].orderItemSeqId
        const noConsent = page(state.contact, O + "request#CustomerCancel", {
            orderId: state.approved,
            lines: [{orderItemSeqId: seq}],
            operationId: opId()
        })
        const asked = page(state.contact, O + "request#CustomerCancel", {
            orderId: state.approved,
            lines: [{orderItemSeqId: seq, quantity: 2}],
            reason: "Ordered twice",
            consent: "Y",
            operationId: opId()
        })
        const read = page(state.contact, O + "get#CustomerCancel", {requestId: asked.requestId})
        const otherCustomer = page(state.outsider, O + "get#CustomerCancel", {requestId: asked.requestId})
        const noRevision = page(state.contact, O + "withdraw#CustomerCancel", {requestId: asked.requestId})
        const withdrawn = page(state.contact, O + "withdraw#CustomerCancel", {
            requestId: asked.requestId,
            expectedRevision: read.request.revision
        })
        return {
            intake,
            noConsent,
            asked,
            read,
            otherCustomer,
            noRevision,
            withdrawn,
            request: one("mantle.request.Request", {requestId: asked.requestId})
        }
    },
    then(r) {
        r.intake.order.capabilities.canRequestCancel === true
        r.noConsent.kind === "Unprocessable"
        r.asked.stateText === "Cancellation requested" && r.asked.immediate === false
        r.request.requestTypeEnumId === "RqtOrderChange" && r.request.filedByPartyId === state.contact
        r.read.request.stateText && r.read.request.capabilities.canWithdraw === true
        r.otherCustomer.kind === "NotFound"
        r.noRevision.kind === "Unprocessable"
        r.withdrawn.stateText === "Withdrawn"
        r.request.statusId === "ReqCancelled"
    }
})

// Shop P6 (impl-shop F27; design-customer-service §8 Access): a guest's order link (the SalesOrder OrderView capability)
// admits the customer services for its one order, as a contact or the self relationship does; the case carries the order's
// store (impl-commerce F37)
feature("a guest's order link files a case, a return and a cancel request for its one order; another order is refused", {
    when() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        svc("create#mantle.product.store.ProductStore", {
            productStoreId: prefix + "_STORE",
            storeName: "Portal spec store",
            organizationPartyId: org
        })
        const shipped = sale(true)
        const approved = sale(false)
        for (const orderId of [shipped, approved])
            svc("update#mantle.order.OrderHeader", {orderId, productStoreId: prefix + "_STORE"})
        capability("SalesOrder", shipped, "OrderView", token("LinkShipped"))
        capability("SalesOrder", approved, "OrderView", token("LinkApproved"))
        const link = token("LinkShipped")
        const intake = page(null, S + "get#CaseIntake", {orderToken: link})
        const filed = page(null, S + "create#CustomerCase", {
            orderToken: link,
            requestName: "About my order",
            description: "Where is the second one?",
            operationId: opId()
        })
        const offer = page(null, R + "get#ReturnableOrder", {orderToken: link, orderId: shipped})
        const seq = offer.order?.lines[0]?.orderItemSeqId
        const returned = page(null, R + "request#CustomerReturn", {
            orderToken: link,
            orderId: shipped,
            lines: [{orderItemSeqId: seq, quantity: 1, returnReasonEnumId: "RrsnDefective", returnResponseEnumId: "RrspCredit"}],
            operationId: opId()
        })
        const cancelSeq = page(null, S + "get#CaseIntake", {orderToken: token("LinkApproved")}).order?.lines[0]?.orderItemSeqId
        const cancel = page(null, O + "request#CustomerCancel", {
            orderToken: token("LinkApproved"),
            orderId: approved,
            lines: [{orderItemSeqId: cancelSeq, quantity: 1}],
            consent: "Y",
            operationId: opId()
        })
        // the link of one order reaches no other, and no link no order
        const otherOrder = page(null, R + "get#ReturnableOrder", {orderToken: link, orderId: approved})
        const noLink = page(null, R + "request#CustomerReturn", {orderId: shipped, lines: [], operationId: opId()})
        return {
            shipped,
            intake,
            filed,
            request: one("mantle.request.Request", {requestId: filed.requestId}),
            caseCustomer: rows("mantle.request.RequestParty", {requestId: filed.requestId, roleTypeId: "Customer"})[0]?.partyId,
            returned,
            header: one("mantle.order.return.ReturnHeader", {returnId: returned.returnId}),
            cancel,
            otherOrder,
            noLink
        }
    },
    then(r) {
        r.intake.mode === "orderLink"
        r.intake.order.orderId === r.shipped
        r.caseCustomer === customer
        r.request.productStoreId === prefix + "_STORE"
        r.request.filedByPartyId == null
        r.header.statusId === "ReturnRequested"
        r.cancel.stateText != null
        r.otherOrder.kind === "NotFound"
        r.noLink.kind === "AuthenticationRequired"
    }
})
