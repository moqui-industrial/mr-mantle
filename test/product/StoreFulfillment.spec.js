// Shop's digital delivery (mr-pass impl-shop P6; mantle.product.ShopFulfillmentServices over ShopFulfillment.js; design-shop
// §8.3 Digital items, §10 Downloads): an approved Shop order's digital line is captured, invoiced (the internal split of
// create#InvoiceFromSource), its invoice finalized (the receipt), the part completed and the file granted once, with the
// download-ready notice and no approved email; the guest's link reaches only that order's file, through a short download
// capability with a range; a capture that is declined grants nothing; a run that stopped between the invoice and the grant
// resumes with no second invoice; a refund or a return ends the grant and its download; a digital item passes a store's
// inventory requirement and a physical one still does not (F76). Standalone: spec-local organization, store, site, gateways
// and products. Run: ./moq test mr-mantle --spec StoreFulfillment
const CART = "mantle.order.ShopCartServices."
const CHECKOUT = "mantle.order.ShopCheckoutServices."
const D = "mantle.product.ShopFulfillmentServices."
const S = "mantle.product.store."
const capture = ec.factory.getTool("MailCapture")
const prefix = "SHFU"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    host: "shop.shfu.example.test",
    hosted: prefix + "_HOSTED",
    authOnly: prefix + "_AUTH",
    guide: prefix + "_GUIDE",
    manual: prefix + "_MANUAL",
    mug: prefix + "_MUG",
    file: "dbresource://mantle/spec/shfu/guide.txt",
    otherFile: "dbresource://mantle/spec/shfu/manual.txt"
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// an operation as a visitor: {result} or {error}
function op(service, input) {
    logout()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service)
                .parameters({input: Object.assign({siteId: ids.site}, input)})
                .call() || {}
        return ec.message.hasError() ? {error: ec.message.getErrorsString()} : {result: out.result}
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const checkout = (name, input) => op(CHECKOUT + name, input)
// a guest buys a product through the hosted test page and is returned; {token, orderId, row, confirmation}
function buy(productId, {authorizeOnly = false} = {}) {
    const added = op(CART + "add#CartItem", {productId, quantity: "1"})
    const token = added.result.token
    checkout("begin#Checkout", {token})
    checkout("set#CheckoutContact", {token, emailAddress: "gwen@shfu.example.test", name: "Gwen Guest"})
    checkout("select#Payment", {token, paymentOptionId: "PiCreditCard"})
    const view = checkout("get#Checkout", {token}).result
    const digest = ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").tokenDigest(token)
    const access = one("mantle.order.StoreCartAccess", {capabilityDigest: digest})
    if (authorizeOnly)
        system(() =>
            call("update#mantle.order.StoreCheckout", {
                checkoutId: list("mantle.order.StoreCheckout", {cartAccessId: access.cartAccessId})[0].checkoutId,
                paymentGatewayConfigId: ids.authOnly
            })
        )
    const submitted = checkout("submit#Checkout", {token, expectedRevision: view.checkout.revision})
    const row = list("mantle.order.StoreCheckout", {cartAccessId: access.cartAccessId})[0]
    if (authorizeOnly)
        // the provider approved an authorization (the test page's lookup answers nothing here)
        system(() => {
            call("update#mantle.account.payment.Payment", {
                paymentId: row.paymentId,
                statusId: "PmntAuthorized",
                paymentRefNum: "SHFU-AUTH-" + row.paymentId
            })
            call("create#mantle.account.method.PaymentGatewayResponse", {
                paymentGatewayConfigId: ids.authOnly,
                paymentOperationEnumId: "PgoAuthorize",
                paymentId: row.paymentId,
                amount: row.dueAmount,
                amountUomId: "USD",
                referenceNum: "SHFU-AUTH-" + row.paymentId,
                transactionDate: ec.user.nowTimestamp,
                resultSuccess: "Y",
                resultDeclined: "N"
            })
        })
    system(() => call("update#mantle.account.payment.PortalPaymentAttempt", {paymentId: row.paymentId, lastCheckDate: null}))
    checkout("get#CheckoutPaymentResult", {reference: submitted.result.checkout.reference, key: submitted.result.returnKey})
    const confirmation = checkout("get#OrderConfirmation", {token})
    assert(ec.factory.waitWorkerPoolEmpty(50), "Worker pool did not drain")
    return {token, orderId: row.orderId, row: one("mantle.order.StoreCheckout", {checkoutId: row.checkoutId}), confirmation}
}
const linkOf = message => (/token=([A-Za-z0-9_%-]+)/.exec(String(message?.bodyText || message?.body || "")) || [])[1]

// the orders the features share, in order (the refund and return end the first feature's grants)
const state = {}

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Fulfillment organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: ids.org
            })
            // the store requires inventory (F76) and has none
            make(S + "ProductStore", {
                productStoreId: ids.store,
                inventoryFacilityId: prefix + "_WH",
                storeName: "Fulfillment store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "Y",
                defaultDisableShippingCalc: "Y"
            })
            make(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstCheckoutTerms",
                fromDate: 0,
                settingValue: "false"
            })
            // the store approves a paid order of a new customer with nothing to deliver at once (Mantle's approval checks)
            for (const settingTypeEnumId of ["PsstOrdApproveNewCust", "PsstOrdApproveAddrMissing"])
                make(S + "ProductStoreSetting", {
                    productStoreId: ids.store,
                    settingTypeEnumId,
                    fromDate: 0,
                    settingValue: "false"
                })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Fulfillment site",
                state: "published",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"})
            make("mantle.public.PublicSiteApp", {
                siteId: ids.site,
                appMountId: "shop",
                app: "shop",
                pathPrefix: "/shop",
                enabled: "Y",
                targetId: ids.store
            })
            const T = "mantle.account.PaymentTestServices."
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.hosted,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Fulfillment hosted test gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysApprove#PaymentCapture",
                detailsServiceName: T + "alwaysApprove#PaymentDetails"
            })
            // an authorization the provider approves, whose capture it declines
            make("mantle.account.method.PaymentGatewayConfig", {
                paymentGatewayConfigId: ids.authOnly,
                paymentGatewayTypeEnumId: "PgtTest",
                description: "Fulfillment capture-declining gateway",
                authorizeServiceName: T + "hostedPending#PaymentAuthorization",
                captureServiceName: T + "alwaysDecline#PaymentCapture",
                detailsServiceName: T + "alwaysPending#PaymentDetails"
            })
            for (const paymentGatewayConfigId of [ids.hosted, ids.authOnly])
                make("mantle.account.method.PaymentGatewayOrganization", {
                    organizationPartyId: ids.org,
                    paymentGatewayConfigId,
                    fromDate: 0,
                    isEnabled: "Y"
                })
            make(S + "ProductStorePaymentGateway", {
                productStoreId: ids.store,
                paymentInstrumentEnumId: "PiCreditCard",
                paymentGatewayConfigId: ids.hosted
            })
            for (const [productId, amount, type, file] of [
                [ids.guide, "15.00", "PtDigital", ids.file],
                [ids.manual, "9.00", "PtDigital", ids.otherFile],
                [ids.mug, "8.50", "PtAsset", null]
            ]) {
                make("mantle.product.Product", {
                    productId,
                    productName: "Fulfillment " + productId,
                    productTypeEnumId: type,
                    ownerPartyId: ids.org
                })
                make("mantle.product.ProductPrice", {
                    productId,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    price: amount,
                    priceUomId: "USD"
                })
                make(S + "ProductStoreProduct", {
                    productStoreId: ids.store,
                    productId,
                    fromDate: 0,
                    publicationKindEnumId: "PspkPublished"
                })
                if (file) {
                    ec.resource.getLocationReference(file).putText("The " + productId + " file, version one.")
                    make("mantle.product.ProductContent", {
                        productId,
                        productContentTypeEnumId: "PcntDownload",
                        contentLocation: file,
                        description: productId.toLowerCase() + ".txt",
                        fromDate: 0,
                        sequenceNum: 1
                    })
                }
            }
            // the store's emails: approved, the invoice's receipt and the download notice, each its own subject
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            for (const [type, subject] of [
                ["PsetOrderApproved", "SHFU approved"],
                ["PsetInvoiceFinalized", "SHFU receipt"],
                ["PsetDownloadReady", "SHFU downloads"]
            ]) {
                make("moqui.basic.email.EmailTemplate", {
                    emailTemplateId: prefix + "_" + type,
                    emailServerId: prefix + "_SMTP",
                    fromAddress: "store@shfu.example.test",
                    subject,
                    bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
                })
                make(S + "ProductStoreEmail", {
                    productStoreId: ids.store,
                    emailTypeEnumId: type,
                    fromDate: 0,
                    emailTemplateId: prefix + "_" + type
                })
            }
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("a guest's digital line is captured, invoiced, receipted and granted once; only its file by its link", {
    when() {
        capture.clear()
        const bought = (state.guide = buy(ids.guide))
        const other = (state.manual = buy(ids.manual))
        const subjects = capture.getMessages().map(message => message.subject)
        const notice = capture
            .getMessages()
            .find(
                message =>
                    message.subject === "SHFU downloads" && String(message.bodyText || message.body).includes(bought.orderId)
            )
        const link = decodeURIComponent(linkOf(notice) || "")
        const rows = list(S + "StoreItemFulfillment", {orderId: bought.orderId})
        const invoice = one("mantle.account.invoice.Invoice", {invoiceId: rows[0]?.invoiceId})
        const downloads = op(D + "get#Downloads", {orderToken: link})
        const grantId = downloads.result?.downloads[0]?.downloadGrantId
        const otherGrant = list(S + "StoreDownloadGrant", {orderId: other.orderId})[0]
        const issued = op(D + "issue#Download", {orderToken: link, downloadGrantId: grantId})
        const file = op(D + "get#DownloadFile", {
            downloadGrantId: grantId,
            downloadToken: issued.result?.downloadToken,
            range: "bytes=0-3"
        })
        // another order's grant through this order's link, and this file through the confirmation's OrderView-only link
        const otherByLink = op(D + "issue#Download", {orderToken: link, downloadGrantId: otherGrant?.downloadGrantId})
        const sessionLink = op(D + "get#Downloads", {orderToken: bought.confirmation.result?.orderToken})
        const viewToken = system(
            () =>
                ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").create({
                    recordType: "SalesOrder",
                    recordId: bought.orderId,
                    scopes: "OrderView",
                    validDays: 1,
                    issuerKind: "organization"
                }).token
        )
        const viewOnly = op(D + "get#Downloads", {orderToken: viewToken})
        // fulfilling again changes nothing
        system(() => call(D + "fulfill#ShopOrder", {orderId: bought.orderId}))
        return {
            bought,
            subjects,
            link,
            rows,
            invoice,
            downloads,
            issued,
            file,
            otherByLink,
            viewOnly,
            sessionLink,
            deliveries: list("mantle.party.MessageDelivery", {eventKey: "shopDownloads:" + bought.orderId}),
            grantsAfter: list(S + "StoreDownloadGrant", {orderId: bought.orderId}),
            invoicesAfter: list("mantle.account.invoice.Invoice", {}).filter(row =>
                String(row.workflowSourceKey || "").startsWith("source:" + bought.orderId + ":")
            ),
            order: one("mantle.order.OrderHeader", {orderId: bought.orderId})
        }
    },
    then(r) {
        // the digital item passed the store's inventory requirement, and the order is placed and approved
        r.bought.row.statusId == "ScoCompleted"
        r.order.statusId == "OrderApproved" || r.order.statusId == "OrderCompleted"
        // one row, completed; one invoice, paid; the receipt and the notice, no approved email
        r.rows.length == 1
        r.rows[0].stepEnumId == "SifCompleted"
        r.invoice.statusId == "InvoicePmtRecvd"
        r.invoicesAfter.length == 1
        r.subjects.includes("SHFU receipt")
        r.subjects.includes("SHFU downloads")
        !r.subjects.includes("SHFU approved")
        r.deliveries.length == 1
        r.deliveries[0].stateEnumId == "MdsSent"
        // the notice's link reaches this order's one file, through a short capability, a range of it
        r.link.length >= 32
        r.downloads.result.downloads.length == 1
        r.downloads.result.downloads[0].available == true
        r.issued.result.downloadToken.length == 48
        r.file.result.location == ids.file
        r.file.result.range.start == 0 && r.file.result.range.end == 3
        r.otherByLink.error.includes("NOT_AVAILABLE")
        r.viewOnly.error != null
        r.sessionLink.result.downloads.length == 1
        r.grantsAfter.length == 1
        r.grantsAfter[0].downloadCount == 1
    }
})

feature("a declined capture grants nothing; a run stopped between the invoice and the grant resumes with no second invoice", {
    when() {
        const declined = buy(ids.guide, {authorizeOnly: true})
        const heldRows = list(S + "StoreItemFulfillment", {orderId: declined.orderId})
        const holds = list("mantle.order.OrderHoldReason", {orderId: declined.orderId})
        // a paid order whose run stopped after its invoice: the rows back at the invoice, the grant gone
        const paid = (state.resumed = buy(ids.manual))
        system(() => {
            for (const row of list(S + "StoreItemFulfillment", {orderId: paid.orderId}))
                call("update#" + S + "StoreItemFulfillment", {
                    fulfillmentId: row.fulfillmentId,
                    stepEnumId: "SifInvoiced",
                    paidDate: null,
                    completedDate: null
                })
            for (const grant of list(S + "StoreDownloadGrant", {orderId: paid.orderId}))
                ec.entity
                    .find(S + "StoreDownloadGrant")
                    .condition("downloadGrantId", grant.downloadGrantId)
                    .disableAuthz()
                    .deleteAll()
        })
        const job = system(() => call(D + "fulfill#StoreItems", {limit: 50}))
        return {
            heldRows,
            holds,
            grants: list(S + "StoreDownloadGrant", {orderId: declined.orderId}),
            job,
            resumed: list(S + "StoreItemFulfillment", {orderId: paid.orderId}),
            resumedGrants: list(S + "StoreDownloadGrant", {orderId: paid.orderId}),
            invoices: list("mantle.account.invoice.Invoice", {}).filter(row =>
                String(row.workflowSourceKey || "").startsWith("source:" + paid.orderId + ":")
            )
        }
    },
    then({heldRows, holds, grants, job, resumed, resumedGrants, invoices}) {
        heldRows[0].stepEnumId == "SifHeld"
        heldRows[0].invoiceId == null
        grants.length == 0
        holds.some(row => row.holdTypeEnumId == "OhtPayment")
        job.failed == 0
        resumed[0].stepEnumId == "SifCompleted"
        resumedGrants.length == 1
        invoices.length == 1
    }
})

feature("a refund or a return ends the grant and its download; another order's grant stays", {
    when() {
        const refunded = state.guide
        const returned = state.manual
        const kept = state.resumed
        const grant = list(S + "StoreDownloadGrant", {orderId: refunded.orderId})[0]
        // a download capability issued before the refund
        const before = system(() =>
            ec.resource.script("component://mr-mantle/service/mantle/party/ExternalAccess.js").create({
                recordType: "SalesOrder",
                recordId: refunded.orderId,
                scopes: "Download",
                thruDate: new Date(Date.now() + 600000),
                issuerKind: "organization"
            })
        )
        const refund = system(() => {
            call("mantle.account.PaymentServices.create#RefundPayment", {
                paymentId: refunded.row.paymentId,
                amount: refunded.row.dueAmount,
                statusId: "PmntPromised"
            })
            const made = list("mantle.account.payment.Payment", {refundForPaymentId: refunded.row.paymentId})[0]
            call("update#mantle.account.payment.Payment", {
                paymentId: made.paymentId,
                statusId: "PmntDelivered",
                effectiveDate: ec.user.nowTimestamp
            })
            return call(D + "reconcile#RefundedItem", {paymentId: refunded.row.paymentId, reasonEnumId: "SdrRefunded"})
        })
        const afterRefund = op(D + "get#DownloadFile", {downloadGrantId: grant.downloadGrantId, downloadToken: before.token})
        // a settled return of the other order's digital line
        const line = list(S + "StoreItemFulfillment", {orderId: returned.orderId})[0]
        const ret = system(() => {
            const header = call("create#mantle.order.return.ReturnHeader", {
                statusId: "ReturnCreated",
                vendorPartyId: ids.org,
                customerPartyId: returned.row.customerPartyId,
                currencyUomId: "USD"
            })
            call("create#mantle.order.return.ReturnItem", {
                returnId: header.returnId,
                returnItemSeqId: "01",
                orderId: returned.orderId,
                orderItemSeqId: line.orderItemSeqId,
                productId: ids.manual,
                returnQuantity: 1,
                statusId: "ReturnCompleted"
            })
            return call(D + "reconcile#RefundedItem", {returnId: header.returnId})
        })
        return {
            refund,
            afterRefund,
            ret,
            refundedGrant: one(S + "StoreDownloadGrant", {downloadGrantId: grant.downloadGrantId}),
            returnedGrants: list(S + "StoreDownloadGrant", {orderId: returned.orderId}),
            keptGrants: list(S + "StoreDownloadGrant", {orderId: kept.orderId}),
            refundedRow: list(S + "StoreItemFulfillment", {orderId: refunded.orderId})[0]
        }
    },
    then({refund, afterRefund, ret, refundedGrant, returnedGrants, keptGrants, refundedRow}) {
        refund.revoked == 1
        refundedGrant.revokeReasonEnumId == "SdrRefunded"
        refundedRow.stepEnumId == "SifRevoked"
        afterRefund.error.includes("NOT_AVAILABLE")
        ret.revoked == 1
        returnedGrants[0].revokeReasonEnumId == "SdrReturned"
        keptGrants[0].revokedDate == null
    }
})

feature("a physical item is still held back by a store's inventory requirement (F76's default)", {
    when() {
        return {
            physical: op(CART + "add#CartItem", {productId: ids.mug, quantity: "1"}),
            digital: op(CART + "add#CartItem", {productId: ids.guide, quantity: "1"})
        }
    },
    then({physical, digital}) {
        physical.error != null
        digital.result.cart.items.length == 1
    }
})
