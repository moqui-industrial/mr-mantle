// Accounting's customer and supplier pages on CX-PORTALS: ExternalAccessServices' capabilities, tokens and contact
// invitations, and PortalServices' invoice reads and payment through a hosted gateway, as the PASS Billing app calls
// them. The organizations, users, site and test gateways are spec-local. PASS's Portals spec covers the pages and the
// supplier's scanned upload.
const settlement = () => ec.resource.script("component://mr-mantle/test/AccountingSettlementFixtures.js")
const tests = "mantle.account.PaymentTestServices."
const capture = ec.factory.getTool("MailCapture")
let f, other, site, otherSite
// A portal operation as PASS calls it: its result, or the error kind a page shows.
function portal(name, input) {
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name("mantle.account.PortalServices." + name)
            .parameters({input})
            .call().result
    } catch (error) {
        ec.message.clearErrors()
        return {errorKind: error.moquiErrorKind || "Error", errorMessage: String(error.message)}
    }
}
const access = (name, p) => settlement().call("mantle.party.ExternalAccessServices." + name, p)
const rejected = (name, p) => settlement().rejected("mantle.party.ExternalAccessServices." + name, p)
const invoice = (amount = "100") => settlement().invoice(f, amount)
const one = (entity, fields) => settlement().lib.one(entity, fields)
function gateway(id, authorize, details) {
    settlement().call("create#mantle.account.method.PaymentGatewayConfig", {
        paymentGatewayConfigId: id,
        paymentGatewayTypeEnumId: "PgtTest",
        description: "Portal gateway " + id,
        authorizeServiceName: tests + authorize + "#PaymentAuthorization",
        captureServiceName: tests + "alwaysApprove#PaymentCapture",
        detailsServiceName: tests + details + "#PaymentDetails"
    })
    settlement().call("create#mantle.account.method.PaymentGatewayOrganization", {
        organizationPartyId: f.org,
        paymentGatewayConfigId: id,
        fromDate: 0,
        isEnabled: "Y"
    })
}
const payThrough = paymentGatewayConfigId =>
    settlement().call("update#mantle.ledger.config.PartyAcctgPreference", {
        organizationPartyId: f.org,
        invoicePayGatewayConfigId: paymentGatewayConfigId
    })
function publicSite(siteId, org, hostname) {
    const c = settlement().call
    c("create#mantle.public.PublicSite", {
        siteId,
        name: siteId,
        state: "published",
        registrationMode: "invitation",
        locale: "en",
        timeZone: "UTC",
        policyRevision: 1,
        generation: 1
    })
    c("create#mantle.public.PublicSiteParty", {siteId, partyId: ec.user.userAccount.partyId, state: "active", role: "owner", revision: 1})
    c("mantle.public.SiteServices.store#Mounts", {
        input: {
            siteId,
            expectedRevision: 1,
            mounts: [
                {app: "forum", pathPrefix: "/forum"},
                {app: "account", pathPrefix: "/account"},
                {app: "billing", pathPrefix: "/billing", targetId: org},
                {app: "supplier", pathPrefix: "/supplier", targetId: org}
            ],
            hosts: [{hostname, canonical: true}]
        }
    })
    return siteId
}
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = settlement().fixtures("ACCT_PORTAL")
        other = settlement().fixtures("ACCT_PORTAL_OTHER")
        site = publicSite("ACCT_PORTAL_SITE", f.org, "billing.portal.example.test")
        otherSite = publicSite("ACCT_PORTAL_OTHER_SITE", other.org, "billing.other.example.test")
        gateway("ACCT_PORTAL_HOSTED", "hostedPending", "alwaysApprove")
        gateway("ACCT_PORTAL_WAIT", "hostedPending", "alwaysPending")
        gateway("ACCT_PORTAL_DECLINE", "alwaysDecline", "alwaysApprove")
        gateway("ACCT_PORTAL_LOST", "alwaysUnknown", "alwaysApprove")
        capture.enable()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("AR issues an invoice's capability in its organization; AP, another organization's user and a draft cannot", {
    when() {
        const invoiceId = invoice()
        const draft = settlement().base.draft(f).invoiceId
        login(f.users.ar)
        const issued = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        const draftRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: draft, scopes: "InvoicePay"})
        const scopeRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "BillUpload"})
        login(f.users.ap)
        const apRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        login(other.users.ar)
        const otherRefused = rejected("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        login("john.doe")
        const row = one("mantle.party.ExternalAccessCapability", {capabilityId: issued.capabilityId})
        return {issued, row, draftRefused, scopeRefused, apRefused, otherRefused, check: access("check#AccessToken", {token: issued.token})}
    },
    then({issued, row, draftRefused, scopeRefused, apRefused, otherRefused, check}) {
        issued.token.length == 48
        issued.url == "https://billing.portal.example.test/billing/InvoicePay?token=" + issued.token
        row.tokenDigest != issued.token
        row.organizationPartyId == f.org
        row.partyId == f.customer
        row.createdByUserId == f.users.ar
        draftRefused.includes("RECORD_UNAVAILABLE")
        scopeRefused.includes("SCOPE_INVALID")
        apRefused.includes("PERMISSION_DENIED")
        otherRefused.includes("ORGANIZATION_DENIED")
        check.valid == true
        check.recordType == "Invoice"
    }
})

feature("AP issues a purchase order's bill link for its supplier, listed and revoked without its token; AR cannot", {
    when() {
        const c = settlement().call
        c("create#mantle.party.Party", {partyId: "ACCT_PORTAL_SUPPLIER", partyTypeEnumId: "PtyOrganization"})
        c("create#mantle.order.OrderHeader", {orderId: "ACCT_PORTAL_PO", statusId: "OrderApproved", currencyUomId: "USD"})
        c("create#mantle.order.OrderPart", {
            orderId: "ACCT_PORTAL_PO",
            orderPartSeqId: "01",
            vendorPartyId: "ACCT_PORTAL_SUPPLIER",
            customerPartyId: f.org
        })
        login(f.users.ap)
        const issued = access("create#AccessCapability", {recordType: "Order", recordId: "ACCT_PORTAL_PO", scopes: "BillUpload"})
        const listed = access("find#AccessCapabilities", {recordType: "Order", recordId: "ACCT_PORTAL_PO"}).capabilityList
        access("revoke#AccessCapability", {capabilityId: issued.capabilityId})
        const after = access("find#AccessCapabilities", {recordType: "Order", recordId: "ACCT_PORTAL_PO"}).capabilityList
        login(f.users.ar)
        const arRefused = rejected("create#AccessCapability", {recordType: "Order", recordId: "ACCT_PORTAL_PO", scopes: "BillUpload"})
        return {issued, listed, after, arRefused}
    },
    then({issued, listed, after, arRefused}) {
        issued.url == "https://billing.portal.example.test/supplier/BillUpload?token=" + issued.token
        listed.length == 1
        listed[0].active == true
        listed[0].token === undefined
        listed[0].scopes == "BillUpload"
        after[0].active == false
        arRefused.includes("PERMISSION_DENIED")
    }
})

feature("a pay link shows only its invoice's public fields; another invoice, another organization's site, a revoked or an expired token say unavailable", {
    when() {
        const invoiceId = invoice("80"),
            otherInvoiceId = invoice("25")
        login(f.users.ar)
        const issued = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        const expiring = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"})
        logout()
        const shown = portal("get#Invoice", {siteId: site, token: issued.token})
        const wrongInvoice = portal("get#Invoice", {siteId: site, token: issued.token, invoiceId: otherInvoiceId})
        const wrongSite = portal("get#Invoice", {siteId: otherSite, token: issued.token})
        const noToken = portal("get#Invoice", {siteId: site, invoiceId})
        const forged = portal("get#Invoice", {siteId: site, token: "x".repeat(48)})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        settlement().call("update#mantle.party.ExternalAccessCapability", {capabilityId: expiring.capabilityId, thruDate: new Date(Date.now() - 1000)})
        login(f.users.ar)
        access("revoke#AccessCapability", {capabilityId: issued.capabilityId})
        logout()
        const revoked = portal("get#Invoice", {siteId: site, token: issued.token})
        const expired = portal("get#Invoice", {siteId: site, token: expiring.token})
        return {invoiceId, shown, wrongInvoice, wrongSite, noToken, forged, revoked, expired}
    },
    then({invoiceId, shown, wrongInvoice, wrongSite, noToken, forged, revoked, expired}) {
        shown.invoice.invoiceId == invoiceId
        shown.invoice.dueText.includes("80.00")
        shown.invoice.lines.length == 1
        Object.keys(shown.invoice).sort().join() ==
            "currencyUomId,due,dueDateText,dueText,fromName,invoiceDateText,invoiceId,lines,paidText,statusText,toName,totalText"
        Object.keys(shown.invoice.lines[0]).sort().join() == "amountText,description,quantity,totalText"
        shown.capabilities.canShare == false
        ;[wrongInvoice, wrongSite, noToken, forged, revoked, expired].every(out => out.errorKind == "NotFound")
        !JSON.stringify([wrongInvoice, wrongSite, revoked]).includes(invoiceId)
    }
})

feature("a hosted payment stays pending until the gateway answers: the return's claim never pays it, and a retry resumes it", {
    when() {
        const invoiceId = invoice("60")
        payThrough("ACCT_PORTAL_WAIT")
        login(f.users.ar)
        const token = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"}).token
        logout()
        const unconfirmed = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0001"})
        const started = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0002", confirm: true})
        const replay = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0002", confirm: true})
        const result = portal("get#PaymentResult", {siteId: site, token, attemptId: started.attempt.attemptId})
        const resumed = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-pay-0003", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const payments = settlement().lib.rows("mantle.account.payment.Payment", {forInvoiceId: invoiceId})
        return {unconfirmed, started, replay, result, resumed, payments, after: one("mantle.account.invoice.Invoice", {invoiceId})}
    },
    then({unconfirmed, started, replay, result, resumed, payments, after}) {
        unconfirmed.errorKind == "Unprocessable"
        started.attempt.state == "pending"
        started.attempt.nextAction == "continue"
        started.attempt.redirectUrl.startsWith(
            "https://billing.portal.example.test/billing/InvoicePay/return?attemptId=" + started.attempt.attemptId
        )
        started.attempt.redirectUrl.includes("result=paid")
        replay.alreadyApplied == true
        replay.attempt.attemptId == started.attempt.attemptId
        result.attempt.state == "pending"
        result.invoice.dueText.includes("60.00")
        resumed.resumed == true
        resumed.attempt.attemptId == started.attempt.attemptId
        payments.length == 1
        payments[0].statusId == "PmntPromised"
        payments[0].paymentRefNum == "TEST-HOSTED-" + started.attempt.attemptId
        after.statusId == "InvoiceFinalized"
    }
})

feature("when the gateway approves, the result is paid and the payment is applied; a declined one can be tried again", {
    when() {
        const paidId = invoice("45"),
            declinedId = invoice("30")
        login(f.users.ar)
        const paidToken = access("create#AccessCapability", {recordType: "Invoice", recordId: paidId, scopes: "InvoicePay"}).token
        const declinedToken = access("create#AccessCapability", {recordType: "Invoice", recordId: declinedId, scopes: "InvoicePay"}).token
        login("john.doe")
        payThrough("ACCT_PORTAL_HOSTED")
        logout()
        const started = portal("start#InvoicePayment", {siteId: site, token: paidToken, operationId: "portal-pay-0101", confirm: true})
        const result = portal("get#PaymentResult", {siteId: site, token: paidToken, attemptId: started.attempt.attemptId})
        const afterPaid = portal("get#Invoice", {siteId: site, token: paidToken})
        const again = portal("start#InvoicePayment", {siteId: site, token: paidToken, operationId: "portal-pay-0102", confirm: true})
        login("john.doe")
        payThrough("ACCT_PORTAL_DECLINE")
        logout()
        const declined = portal("start#InvoicePayment", {siteId: site, token: declinedToken, operationId: "portal-pay-0103", confirm: true})
        const retry = portal("get#Invoice", {siteId: site, token: declinedToken})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {started, result, afterPaid, again, declined, retry, paid: one("mantle.account.invoice.Invoice", {invoiceId: paidId})}
    },
    then({started, result, afterPaid, again, declined, retry, paid}) {
        started.attempt.state == "pending"
        result.attempt.state == "paid"
        result.attempt.reference == "TEST-HOSTED-" + started.attempt.attemptId
        paid.statusId == "InvoicePmtRecvd"
        toDecimal(paid.unpaidTotal).eq(0)
        afterPaid.invoice.statusText == "Paid"
        afterPaid.capabilities.canPay == false
        again.errorKind == "Conflict"
        declined.attempt.state == "declined"
        declined.attempt.nextAction == "retry"
        retry.capabilities.canPay == true
        retry.attempt == null
    }
})

feature("an invited contact redeems into a contact of the customer, with no user group, and sees and shares only its invoices", {
    when() {
        const invoiceId = invoice("70"),
            otherCustomerInvoice = settlement().invoice(other, "20")
        login(f.users.ap)
        const apRefused = rejected("invite#Contact", {
            organizationPartyId: f.org,
            app: "billing",
            partyId: f.customer,
            emailAddress: "payer@customer.example"
        })
        login(f.users.ar)
        const invited = access("invite#Contact", {
            organizationPartyId: f.org,
            app: "billing",
            partyId: f.customer,
            emailAddress: "Payer@Customer.example"
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const c = settlement().call
        c("create#mantle.party.Party", {partyId: "ACCT_PORTAL_PAYER", partyTypeEnumId: "PtyPerson"})
        c("create#mantle.party.Person", {partyId: "ACCT_PORTAL_PAYER", firstName: "Portal", lastName: "Payer"})
        c("create#moqui.security.UserAccount", {
            userId: "ACCT_PORTAL_PAYER",
            username: "acct.portal.payer",
            partyId: "ACCT_PORTAL_PAYER",
            emailAddress: "payer@customer.example",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        c("create#moqui.security.public.VerifiedAddress", {
            userId: "ACCT_PORTAL_PAYER",
            emailAddress: "payer@customer.example",
            verifiedAt: ec.user.nowTimestamp
        })
        login("acct.portal.payer")
        const before = portal("find#Invoices", {siteId: site})
        c("mantle.public.SiteServices.redeem#Invitation", {input: {siteId: site, token: invited.token}})
        const list = portal("find#Invoices", {siteId: site})
        const shown = portal("get#Invoice", {siteId: site, invoiceId})
        const foreign = portal("get#Invoice", {siteId: otherSite, invoiceId: otherCustomerInvoice})
        const shared = portal("issue#InvoiceAccess", {siteId: site, invoiceId})
        logout()
        const anonymousList = portal("find#Invoices", {siteId: site})
        const viaShared = portal("get#Invoice", {siteId: site, token: shared.token})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const groups = settlement().lib.rows("moqui.security.UserGroupMember", {userId: "ACCT_PORTAL_PAYER"})
        return {apRefused, invited, before, list, shown, foreign, shared, anonymousList, viaShared, groups, invoiceId}
    },
    then({apRefused, invited, before, list, shown, foreign, shared, anonymousList, viaShared, groups, invoiceId}) {
        apRefused.includes("PERMISSION_DENIED")
        invited.invitationUrl.startsWith("https://billing.portal.example.test/account/Invitation?token=")
        before.invoiceList.length == 0
        list.invoiceList.some(row => row.invoiceId == invoiceId)
        list.invoiceList.every(row => row.toName.includes("ACCT_PORTAL customer"))
        shown.invoice.invoiceId == invoiceId
        shown.capabilities.canShare == true
        foreign.errorKind == "NotFound"
        shared.url.startsWith("https://billing.portal.example.test/billing/InvoicePay?token=")
        anonymousList.errorKind == "AuthenticationRequired"
        viaShared.invoice.invoiceId == invoiceId
        viaShared.capabilities.canShare == false
        groups.length == 0
    }
})

feature("send#Invoice carries the pay link of the organization's Billing site", {
    when() {
        login(f.users.ar)
        const draft = settlement().base.draft(f, "55")
        capture.clear()
        const sent = settlement().call("mantle.account.InvoiceServices.send#Invoice", {
            invoiceId: draft.invoiceId,
            organizationPartyId: f.org,
            operationKey: "portal-send-0001",
            emailTemplateId: f.emailTemplateId,
            toAddresses: "payer@customer.example",
            lastUpdatedStamp: draft.lastUpdatedStamp
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const links = settlement().lib.rows("mantle.party.ExternalAccessCapability", {recordId: draft.invoiceId})
        return {sent, message: capture.last(), links}
    },
    then({sent, message, links}) {
        sent.successCount == 1
        message.body.includes("https://billing.portal.example.test/billing/InvoicePay?token=")
        message.body.includes("View and pay this invoice online")
        links.length == 1
        links[0].scopes == "InvoicePay"
    }
})

feature("Billing and Supplier mounts take an internal organization from an operator, survive a core save and add readiness", {
    when() {
        const c = settlement().call
        const mounts = input => settlement().rejected("mantle.public.SiteServices.store#Mounts", {input})
        const revision = () => one("mantle.public.PublicSite", {siteId: site}).policyRevision
        const notInternal = mounts({
            siteId: site,
            expectedRevision: revision(),
            mounts: [{app: "billing", pathPrefix: "/billing", targetId: f.customer}]
        })
        const forumTarget = mounts({
            siteId: site,
            expectedRevision: revision(),
            mounts: [{app: "forum", pathPrefix: "/forum", targetId: f.org}]
        })
        c("mantle.public.SiteServices.store#Mounts", {
            input: {siteId: site, expectedRevision: revision(), mounts: [{app: "forum", pathPrefix: "/forum"}, {app: "account", pathPrefix: "/account"}]}
        })
        const kept = settlement().lib.rows("mantle.public.PublicSiteApp", {siteId: site}).map(row => row.app + ":" + (row.targetId || ""))
        payThrough("ACCT_PORTAL_HOSTED")
        const ready = c("mantle.public.SiteServices.check#Readiness", {input: {siteId: site}}).result.checks
        payThrough(null)
        const unready = c("mantle.public.SiteServices.check#Readiness", {input: {siteId: site}}).result.checks
        return {notInternal, forumTarget, kept, ready, unready}
    },
    then({notInternal, forumTarget, kept, ready, unready}) {
        notInternal.includes("Choose the organization")
        forumTarget.includes("takes no target")
        kept.sort().join() == ["account:", "billing:" + f.org, "forum:", "supplier:" + f.org].join()
        ready.find(c => c.name == "billing payment gateway").ready == true
        ready.find(c => c.name == "billing organization").ready == true
        unready.find(c => c.name == "billing payment gateway").ready == false
    }
})

feature("a contact grant holds for its organization's Billing app only; another organization's site, the Supplier app and a CRM contact relationship give nothing", {
    when() {
        const c = settlement().call
        // an invoice of the other organization to the same customer, and a purchase order the customer supplies
        const otherOrgInvoice = settlement().invoice({...other, customer: f.customer}, "15")
        const ownInvoice = invoice("16")
        c("create#mantle.order.OrderHeader", {orderId: "ACCT_PORTAL_PO_CUST", statusId: "OrderApproved", currencyUomId: "USD"})
        c("create#mantle.order.OrderPart", {orderId: "ACCT_PORTAL_PO_CUST", orderPartSeqId: "01", vendorPartyId: f.customer, customerPartyId: f.org})
        // a person who is only a CRM contact of the customer
        c("create#mantle.party.Party", {partyId: "ACCT_PORTAL_CRM", partyTypeEnumId: "PtyPerson"})
        c("create#moqui.security.UserAccount", {
            userId: "ACCT_PORTAL_CRM",
            username: "acct.portal.crm",
            partyId: "ACCT_PORTAL_CRM",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        c("create#mantle.party.PartyRelationship", {
            fromPartyId: "ACCT_PORTAL_CRM",
            toPartyId: f.customer,
            relationshipTypeEnumId: "PrtContact",
            fromDate: 0
        })
        login("acct.portal.payer")
        const own = portal("get#Invoice", {siteId: site, invoiceId: ownInvoice})
        const otherOrg = portal("get#Invoice", {siteId: otherSite, invoiceId: otherOrgInvoice})
        const supplierApp = portal("get#Submission", {siteId: site, orderId: "ACCT_PORTAL_PO_CUST"})
        login("acct.portal.crm")
        const crm = portal("get#Invoice", {siteId: site, invoiceId: ownInvoice})
        const crmList = portal("find#Invoices", {siteId: site})
        return {own, otherOrg, supplierApp, crm, crmList}
    },
    then({own, otherOrg, supplierApp, crm, crmList}) {
        !!own.invoice
        otherOrg.errorKind == "NotFound"
        supplierApp.errorKind == "NotFound"
        crm.errorKind == "NotFound"
        crmList.invoiceList.length == 0
    }
})

feature("the posting guard lets only the marked portal payment through: another source with no user, or with a public account, is refused", {
    when() {
        const c = settlement().call
        // promised payments of another organization, delivered below by no user and by a public account
        const promised = () =>
            c("mantle.account.PaymentServices.create#Payment", {
                fromPartyId: other.customer,
                toPartyId: other.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiCompanyCheck",
                amount: "12",
                amountUomId: "USD",
                statusId: "PmntPromised",
                effectiveDate: ec.user.nowTimestamp
            }).paymentId
        const ids = [promised(), promised(), promised()]
        const unmarked = () =>
            settlement().rejected("update#mantle.account.payment.Payment", {
                paymentId: ids.shift(),
                statusId: "PmntDelivered",
                effectiveDate: ec.user.nowTimestamp
            })
        logout()
        ec.artifactExecution.disableAuthz()
        const noUser = unmarked()
        // a marker naming another payment does not help either
        ec.context.sharedMap["mantle.portalPaymentId"] = "ACCT_PORTAL_NOT_THIS"
        const otherMarked = unmarked()
        delete ec.context.sharedMap["mantle.portalPaymentId"]
        login("acct.portal.payer")
        ec.artifactExecution.disableAuthz()
        const publicAccount = unmarked()
        return {noUser, otherMarked, publicAccount}
    },
    then({noUser, otherMarked, publicAccount}) {
        noUser.includes("Posting organization is not available")
        otherMarked.includes("Posting organization is not available")
        publicAccount.includes("Posting organization is not available")
    }
})

feature("pending attempts resolve: the invoice page asks the gateway, the job settles a payer who never returns, the return's reference reads without the link, and an attempt with nothing to ask fails", {
    when() {
        const pageId = invoice("41"),
            jobId = invoice("42"),
            stuckId = invoice("43")
        login(f.users.ar)
        const token = id => access("create#AccessCapability", {recordType: "Invoice", recordId: id, scopes: "InvoicePay"}).token
        const pageToken = token(pageId),
            jobToken = token(jobId),
            stuckToken = token(stuckId)
        login("john.doe")
        payThrough("ACCT_PORTAL_HOSTED")
        logout()
        const pageStart = portal("start#InvoicePayment", {siteId: site, token: pageToken, operationId: "portal-res-0001", confirm: true})
        const pageView = portal("get#Invoice", {siteId: site, token: pageToken})
        const jobStart = portal("start#InvoicePayment", {siteId: site, token: jobToken, operationId: "portal-res-0002", confirm: true})
        const returnKey = decodeURIComponent(/[?&]key=([^&]+)/.exec(jobStart.attempt.redirectUrl)[1])
        const wrongKey = portal("get#PaymentResult", {siteId: site, attemptId: jobStart.attempt.attemptId, returnKey: "x".repeat(40)})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const job = settlement().call("mantle.account.PortalServices.resolve#PortalPayments", {})
        logout()
        const byKey = portal("get#PaymentResult", {siteId: site, attemptId: jobStart.attempt.attemptId, returnKey})
        login("john.doe")
        payThrough("ACCT_PORTAL_WAIT")
        logout()
        const stuckStart = portal("start#InvoicePayment", {siteId: site, token: stuckToken, operationId: "portal-res-0003", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // the gateway gave neither a reference to ask about nor a page to go to, and the start-up grace has passed
        settlement().call("update#mantle.account.payment.Payment", {paymentId: stuckStart.attempt.attemptId, paymentRefNum: null})
        settlement().call("update#mantle.account.payment.PortalPaymentAttempt", {
            paymentId: stuckStart.attempt.attemptId,
            createdDate: new Date(Date.now() - 10 * 60000)
        })
        for (const row of settlement().lib.rows("mantle.account.method.PaymentGatewayResponse", {paymentId: stuckStart.attempt.attemptId}))
            settlement().call("update#mantle.account.method.PaymentGatewayResponse", {
                paymentGatewayResponseId: row.paymentGatewayResponseId,
                redirectUrl: null
            })
        logout()
        const stuckView = portal("get#Invoice", {siteId: site, token: stuckToken})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const status = paymentId => one("mantle.account.payment.Payment", {paymentId}).statusId
        return {
            pageStart,
            pageView,
            job,
            wrongKey,
            byKey,
            stuckView,
            jobStatus: status(jobStart.attempt.attemptId),
            stuckStatus: status(stuckStart.attempt.attemptId)
        }
    },
    then({pageStart, pageView, job, wrongKey, byKey, stuckView, jobStatus, stuckStatus}) {
        pageStart.attempt.state == "pending"
        pageView.attempt == null
        pageView.invoice.statusText == "Paid"
        job.resolved >= 1
        jobStatus == "PmntDelivered"
        wrongKey.errorKind == "NotFound"
        byKey.attempt.state == "paid"
        byKey.invoice.statusText == "Paid"
        stuckStatus == "PmntCancelled"
        stuckView.attempt == null
        stuckView.capabilities.canPay == true
    }
})

feature("a lost authorization answer stays pending, never cancelled, and the invoice page's lookup finds and captures it", {
    when() {
        const invoiceId = invoice("47")
        login(f.users.ar)
        const token = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"}).token
        login("john.doe")
        payThrough("ACCT_PORTAL_LOST")
        logout()
        const started = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-lost-0001", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const status = () => one("mantle.account.payment.Payment", {paymentId: started.attempt.attemptId}).statusId
        const whileLost = status()
        logout()
        const view = portal("get#Invoice", {siteId: site, token})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {started, whileLost, view, after: status()}
    },
    then({started, whileLost, view, after}) {
        started.attempt.state == "pending"
        started.attempt.nextAction == "wait"
        whileLost == "PmntPromised"
        after == "PmntDelivered"
        view.invoice.statusText == "Paid"
    }
})

feature("a pay link never shows or captures a card authorization made in Accounting for the same invoice", {
    when() {
        const invoiceId = invoice("33")
        const c = settlement().call
        const bossPayment = c("mantle.account.PaymentServices.create#Payment", {
            fromPartyId: f.customer,
            toPartyId: f.org,
            paymentTypeEnumId: "PtInvoicePayment",
            paymentInstrumentEnumId: "PiCreditCard",
            paymentGatewayConfigId: "ACCT_PORTAL_HOSTED",
            forInvoiceId: invoiceId,
            amount: "33",
            amountUomId: "USD",
            statusId: "PmntPromised",
            paymentRefNum: "BOSS-AUTH",
            effectiveDate: ec.user.nowTimestamp
        }).paymentId
        c("update#mantle.account.payment.Payment", {paymentId: bossPayment, statusId: "PmntAuthorized"})
        login(f.users.ar)
        const token = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"}).token
        login("john.doe")
        payThrough("ACCT_PORTAL_WAIT")
        logout()
        const shown = portal("get#Invoice", {siteId: site, token})
        const bossResult = portal("get#PaymentResult", {siteId: site, token, attemptId: bossPayment})
        const started = portal("start#InvoicePayment", {siteId: site, token, operationId: "portal-boss-0001", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {bossPayment, shown, bossResult, started, after: one("mantle.account.payment.Payment", {paymentId: bossPayment})}
    },
    then({bossPayment, shown, bossResult, started, after}) {
        shown.attempt == null
        bossResult.errorKind == "NotFound"
        started.attempt.attemptId != bossPayment
        after.statusId == "PmntAuthorized"
    }
})

feature("a new pay link ends the invoice's earlier ones, an expiry is capped at a year, and an issuer revokes a link to a cancelled invoice", {
    when() {
        const invoiceId = invoice("27")
        login(f.users.ar)
        const first = settlement().call("mantle.account.PortalServices.issue#InvoiceAccess", {input: {invoiceId}}).result
        const second = settlement().call("mantle.account.PortalServices.issue#InvoiceAccess", {input: {invoiceId}}).result
        const far = access("create#AccessCapability", {
            recordType: "Invoice",
            recordId: invoiceId,
            scopes: "InvoicePay",
            thruDate: new Date(Date.now() + 5 * 366 * 86400000)
        })
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        settlement().call("update#mantle.account.invoice.Invoice", {invoiceId, statusId: "InvoiceCancelled"})
        login(f.users.ar)
        const revoked = access("revoke#AccessCapability", {capabilityId: far.capabilityId})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const row = id => one("mantle.party.ExternalAccessCapability", {capabilityId: id})
        return {first: row(first.capabilityId), second: row(second.capabilityId), far: row(far.capabilityId), revoked}
    },
    then({first, second, far, revoked}) {
        first.revokedDate != null
        second.revokedDate == null
        Number(far.thruDate) <= Date.now() + 367 * 86400000
        revoked.revoked == true
    }
})

feature("the return's reference reads for a day after its attempt settles and only while the invoice stands; a young attempt waits and an abandoned one fails", {
    when() {
        const c = settlement().call
        const paidId = invoice("21"),
            waitId = invoice("22"),
            youngId = invoice("23")
        login(f.users.ar)
        const token = id => access("create#AccessCapability", {recordType: "Invoice", recordId: id, scopes: "InvoicePay"}).token
        const paidToken = token(paidId),
            waitToken = token(waitId),
            youngToken = token(youngId)
        const keyOf = out => decodeURIComponent(/[?&]key=([^&]+)/.exec(out.attempt.redirectUrl)[1])
        login("john.doe")
        payThrough("ACCT_PORTAL_HOSTED")
        logout()
        const paid = portal("start#InvoicePayment", {siteId: site, token: paidToken, operationId: "portal-key-0001", confirm: true})
        const paidKey = keyOf(paid)
        const paidRead = portal("get#PaymentResult", {siteId: site, attemptId: paid.attempt.attemptId, returnKey: paidKey})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        c("update#mantle.account.payment.PortalPaymentAttempt", {
            paymentId: paid.attempt.attemptId,
            settledDate: new Date(Date.now() - 25 * 3600000)
        })
        payThrough("ACCT_PORTAL_WAIT")
        logout()
        const paidLater = portal("get#PaymentResult", {siteId: site, attemptId: paid.attempt.attemptId, returnKey: paidKey})
        const wait = portal("start#InvoicePayment", {siteId: site, token: waitToken, operationId: "portal-key-0002", confirm: true})
        const waitKey = keyOf(wait)
        const waitRead = portal("get#PaymentResult", {siteId: site, attemptId: wait.attempt.attemptId, returnKey: waitKey})
        const young = portal("start#InvoicePayment", {siteId: site, token: youngToken, operationId: "portal-key-0003", confirm: true})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        c("update#mantle.account.invoice.Invoice", {invoiceId: waitId, statusId: "InvoiceCancelled"})
        // the young attempt lost its reference and page at once: still within its start-up grace
        c("update#mantle.account.payment.Payment", {paymentId: young.attempt.attemptId, paymentRefNum: null})
        for (const row of settlement().lib.rows("mantle.account.method.PaymentGatewayResponse", {paymentId: young.attempt.attemptId}))
            c("update#mantle.account.method.PaymentGatewayResponse", {paymentGatewayResponseId: row.paymentGatewayResponseId, redirectUrl: null})
        logout()
        const waitCancelled = portal("get#PaymentResult", {siteId: site, attemptId: wait.attempt.attemptId, returnKey: waitKey})
        const youngView = portal("get#Invoice", {siteId: site, token: youngToken})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // pending at the gateway for eight days: abandoned
        c("update#mantle.account.payment.Payment", {paymentId: young.attempt.attemptId, paymentRefNum: "TEST-HOSTED-OLD"})
        c("update#mantle.account.payment.PortalPaymentAttempt", {
            paymentId: young.attempt.attemptId,
            createdDate: new Date(Date.now() - 8 * 86400000)
        })
        logout()
        const abandonedView = portal("get#Invoice", {siteId: site, token: youngToken})
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        return {
            paidRead,
            paidLater,
            waitRead,
            waitCancelled,
            youngView,
            abandonedView,
            youngStatus: one("mantle.account.payment.Payment", {paymentId: young.attempt.attemptId}).statusId
        }
    },
    then({paidRead, paidLater, waitRead, waitCancelled, youngView, abandonedView, youngStatus}) {
        paidRead.attempt.state == "paid"
        paidLater.errorKind == "NotFound"
        waitRead.attempt.state == "pending"
        waitCancelled.errorKind == "NotFound"
        youngView.attempt.state == "pending"
        abandonedView.attempt == null
        youngStatus == "PmntCancelled"
    }
})

feature("a contact's shared pay link never ends the organization's emailed link; each kind replaces only its own", {
    when() {
        const invoiceId = invoice("19")
        const issue = input => settlement().call("mantle.account.PortalServices.issue#InvoiceAccess", {input}).result
        login(f.users.ar)
        const emailed = issue({invoiceId})
        login("acct.portal.payer")
        const shared = issue({siteId: site, invoiceId})
        const sharedAgain = issue({siteId: site, invoiceId})
        const revoked = id => {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            return one("mantle.party.ExternalAccessCapability", {capabilityId: id}).revokedDate != null
        }
        const emailedAfterShares = revoked(emailed.capabilityId)
        login(f.users.ar)
        const emailedAgain = issue({invoiceId})
        return {
            emailedAfterShares,
            emailed: revoked(emailed.capabilityId),
            shared: revoked(shared.capabilityId),
            sharedAgain: revoked(sharedAgain.capabilityId),
            emailedAgain: revoked(emailedAgain.capabilityId)
        }
    },
    then({emailedAfterShares, emailed, shared, sharedAgain, emailedAgain}) {
        emailedAfterShares == false
        emailed == true
        shared == true
        sharedAgain == false
        emailedAgain == false
    }
})

feature("token lookups count before the lookup: past the limit even a good token is refused, with no hit or miss told", {
    when() {
        const invoiceId = invoice("11")
        login(f.users.ar)
        const token = access("create#AccessCapability", {recordType: "Invoice", recordId: invoiceId, scopes: "InvoicePay"}).token
        logout()
        let refusedAt = null
        for (let i = 0; i < 150 && refusedAt == null; i++) {
            const out = portal("get#Invoice", {siteId: site, token: i % 2 ? token : "y".repeat(48)})
            if (out.errorKind == "Tarpit") refusedAt = i
        }
        const good = portal("get#Invoice", {siteId: site, token})
        const bad = portal("get#Invoice", {siteId: site, token: "z".repeat(48)})
        login("john.doe")
        return {refusedAt, good, bad}
    },
    then({refusedAt, good, bad}) {
        refusedAt != null
        good.errorKind == "Tarpit"
        bad.errorKind == "Tarpit"
    }
})
