// Store reviews (impl-commerce P9, F19, F41; mantle.product.StoreMerchandisingServices' reviews and ShopCatalogServices'
// get#Reviews, submit#Review and get#ReviewImage over StoreReviews.js): a review needs the signed-in buyer's own delivered
// order line (no proof refused), a wrong-type or unscanned photo is refused and the text kept; only approved reviews are public
// and in the summary, a pending review's image is not served, the reply shows and the author's label hides the account; the
// author's edit returns it to pending and out of the average; the review request is queued once per delivered line of a Shop
// order, needs the store's review requests topic (marketing email consent is not enough; P9 follow-up, F95), stops once the
// line is reviewed, and another order queues none. Standalone: a spec-local
// organization, store, site, product, staff and buyers; orders written directly. Run: ./moq test mr-mantle --spec StoreReviews
const M = "mantle.product.StoreMerchandisingServices."
const K = "mantle.product.ShopCatalogServices."
const S = "mantle.product.store."
const prefix = "STRV"
const ids = {
    org: prefix + "_ORG",
    store: prefix + "_STORE",
    site: prefix + "_SITE",
    host: "shop.strv.example.test",
    product: prefix + "_MUG",
    buyer: prefix + "_BUYER",
    other: prefix + "_OTHER",
    template: prefix + "_REQUEST"
}
const make = (entity, values) => call("create#" + entity, values)
const one = (entity, fields) => ec.entity.find(entity).condition(fields).useCache(false).disableAuthz().one()
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).useCache(false).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// a Shop operation as an account (null: a visitor): {result} or {error}
function op(username, service, input) {
    if (username) login(username)
    else logout()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service)
                .parameters({input: Object.assign({siteId: ids.site}, input)})
                .requireNewTransaction(true)
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
// a staff call as a Commerce screen makes it (authorization inherited), in its own transaction
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const code = text => (/([A-Z][A-Z0-9_]+)(\[[^\]]*\])?:/.exec(text || "") || [])[1] || (text ? "ERROR" : "")
function person(partyId, firstName, lastName) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName, lastName})
}
function account(partyId, firstName, lastName) {
    person(partyId, firstName, lastName)
    make("mantle.party.PartyRole", {partyId, roleTypeId: "Customer"})
    const email = partyId.toLowerCase() + "@strv.example.test"
    make("moqui.security.UserAccount", {
        userId: partyId,
        username: partyId,
        partyId,
        emailAddress: email,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    make("moqui.security.public.VerifiedAddress", {userId: partyId, emailAddress: email, verifiedAt: ec.user.nowTimestamp})
}
function staff(kind, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    person(id, "Review", kind)
    make("mantle.party.PartyRelationship", {
        partyRelationshipId: id,
        fromPartyId: id,
        toPartyId: ids.org,
        relationshipTypeEnumId: "PrtAgent",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store reviews " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "UTC"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
// a completed Shop order of the product for a customer (shopCheckout: with its StoreCheckout, as Shop places one), delivered by
// a shipment that is shipped and not yet delivered: {orderId, shipmentId}
function order(customerPartyId, shopCheckout) {
    return system(() => {
        const orderId = make("mantle.order.OrderHeader", {
            productStoreId: ids.store,
            statusId: "OrderOpen",
            currencyUomId: "USD",
            placedDate: ec.user.nowTimestamp,
            entryDate: ec.user.nowTimestamp,
            grandTotal: "12.00"
        }).orderId
        make("mantle.order.OrderPart", {
            orderId,
            orderPartSeqId: "01",
            customerPartyId,
            vendorPartyId: ids.org,
            statusId: "OrderOpen"
        })
        make("mantle.order.OrderItem", {
            orderId,
            orderItemSeqId: "01",
            orderPartSeqId: "01",
            itemTypeEnumId: "ItemProduct",
            productId: ids.product,
            quantity: 1,
            unitAmount: "12.00"
        })
        // approved as a record, not through update#OrderHeader, so no reservation runs for the spec's product
        for (const entity of ["mantle.order.OrderHeader", "mantle.order.OrderPart"])
            for (const row of ec.entity.find(entity).condition({orderId}).disableAuthz().list()) {
                row.statusId = "OrderApproved"
                row.update()
            }
        if (shopCheckout)
            make("mantle.order.StoreCheckout", {
                orderId,
                siteId: ids.site,
                productStoreId: ids.store,
                statusId: "ScoCompleted",
                customerPartyId,
                accountCheckout: "Y",
                contactEmail: customerPartyId.toLowerCase() + "@strv.example.test"
            })
        const shipmentId = make("mantle.shipment.Shipment", {
            shipmentTypeEnumId: "ShpTpSales",
            statusId: "ShipShipped",
            fromPartyId: ids.org,
            toPartyId: customerPartyId
        }).shipmentId
        make("mantle.shipment.ShipmentItem", {shipmentId, productId: ids.product, quantity: 1})
        make("mantle.shipment.ShipmentItemSource", {
            shipmentId,
            productId: ids.product,
            orderId,
            orderItemSeqId: "01",
            quantity: 1
        })
        return {orderId, shipmentId}
    })
}
const deliver = shipmentId => run("john.doe", "update#mantle.shipment.Shipment", {shipmentId, statusId: "ShipDelivered"})
// a FileItem as a form post gives it
const photo = (name, contentType) => ({
    name,
    size: 16,
    contentType,
    write(location) {
        ec.resource.getLocationReference(location).putText("not really a photo")
    }
})
const state = {}

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            make("mantle.party.Party", {partyId: ids.org, partyTypeEnumId: "PtyOrganization"})
            make("mantle.party.Organization", {partyId: ids.org, organizationName: "Store reviews organization"})
            make("mantle.party.PartyRole", {partyId: ids.org, roleTypeId: "OrgInternal"})
            make(S + "ProductStore", {
                productStoreId: ids.store,
                storeName: "Store reviews store",
                organizationPartyId: ids.org,
                defaultCurrencyUomId: "USD",
                defaultLocale: "en_US",
                requireInventory: "N"
            })
            make("mantle.public.PublicSite", {
                siteId: ids.site,
                name: "Store reviews site",
                state: "published",
                locale: "en",
                generation: 1
            })
            make("mantle.public.PublicSiteHost", {hostname: ids.host, siteId: ids.site, canonical: "Y"})
            for (const [appMountId, pathPrefix, targetId] of [
                ["shop", "/shop", ids.store],
                ["account", "/account", null]
            ])
                make("mantle.public.PublicSiteApp", {
                    siteId: ids.site,
                    appMountId,
                    app: appMountId,
                    pathPrefix,
                    enabled: "Y",
                    targetId
                })
            make("mantle.product.Product", {
                productId: ids.product,
                productName: "Review mug",
                productTypeEnumId: "PtAsset",
                ownerPartyId: ids.org
            })
            make(S + "ProductStoreProduct", {
                productStoreId: ids.store,
                productId: ids.product,
                fromDate: 0,
                publicationKindEnumId: "PspkPublished"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: ids.template,
                description: "Store reviews request",
                emailServerId: "SYSTEM",
                bodyScreenLocation: "component://mr-mantle/test/product/StoreReviews.spec.js",
                fromAddress: "store@strv.example.test",
                subject: "How was it?"
            })
            make(S + "ProductStoreEmail", {
                productStoreId: ids.store,
                emailTypeEnumId: "PsetReviewRequest",
                fromDate: 0,
                emailTemplateId: ids.template
            })
            account(ids.buyer, "Rita", "Reviewer")
            account(ids.other, "Otto", "Other")
            state.merchandiser = staff("merchandiser", ["COMMERCE_VIEW", "COMMERCE_MERCHANDISE"])
            state.reader = staff("reader", ["COMMERCE_VIEW"])
        })
        state.bought = order(ids.buyer, true)
        deliver(state.bought.shipmentId)
    },
    cleanupSpec() {
        login("john.doe")
    }
})

feature("a review needs the buyer's own delivered order line; a wrong-type or unscanned photo is refused and the text kept", {
    when() {
        const input = {productId: ids.product, rating: "4", body: "Holds a lot of coffee.", displayChoice: "name"}
        const visitor = op(null, K + "submit#Review", input)
        const noProof = op(ids.other, K + "submit#Review", input)
        const first = op(ids.buyer, K + "submit#Review", Object.assign({file: photo("receipt.pdf", "application/pdf")}, input))
        const again = op(ids.buyer, K + "submit#Review", input)
        const unscanned = withProperty("pass_scanner_service", null, () =>
            op(
                ids.buyer,
                K + "submit#Review",
                Object.assign({}, input, {
                    productReviewId: first.result?.review.id,
                    expectedRevision: first.result?.review.revision,
                    file: photo("mug.png", "image/png")
                })
            )
        )
        const publicView = op(ids.buyer, K + "get#Reviews", {productId: ids.product})
        state.reviewId = first.result?.review.id
        return {
            visitor,
            noProof,
            first,
            again,
            unscanned,
            publicView,
            row: one("mantle.product.ProductReview", {productReviewId: state.reviewId})
        }
    },
    then(r) {
        code(r.visitor.error) == "SIGN_IN_REQUIRED"
        code(r.noProof.error) == "PURCHASE_REQUIRED"
        r.first.result.review.statusText == "Waiting for approval"
        r.first.result.imageRefused.includes("PNG or JPEG")
        code(r.again.error) == "ALREADY_REVIEWED"
        r.unscanned.result.imageRefused != null
        r.unscanned.result.review.imageCount == 0
        r.row.statusId == "PrvwPending"
        r.row.orderId == state.bought.orderId
        r.row.productReview == "Holds a lot of coffee."
        r.publicView.result.summary.count == 0
        r.publicView.result.reviews.length == 0
        r.publicView.result.own.statusText == "Waiting for approval"
    }
})

feature("only approved reviews are public; a pending review's image is not served; the reply shows without the account", {
    when() {
        system(() => {
            ec.resource.getLocationReference("runtime://tmp/strv/mug.png").putText("an approved photo")
            make("mantle.product.ProductReviewImage", {
                productReviewId: state.reviewId,
                imageSeqId: "01",
                digest: "strv0000000000000000000000000001",
                contentLocation: "runtime://tmp/strv/mug.png",
                filename: "mug.png",
                contentType: "image/png",
                byteSize: 17
            })
        })
        const pendingImage = op(null, K + "get#ReviewImage", {reviewImage: "strv0000000000000000000000000001"})
        const revision = one("mantle.product.ProductReview", {productReviewId: state.reviewId}).lastUpdatedStamp
        const readerDecision = run(state.reader, M + "moderate#Review", {decision: "approve", productReviewId: state.reviewId})
        const stale = run(state.merchandiser, M + "moderate#Review", {
            decision: "approve",
            reviews: [{productReviewId: state.reviewId, expectedLastUpdatedStamp: new Date(1000)}]
        })
        const approved = run(state.merchandiser, M + "moderate#Review", {
            decision: "approve",
            reviews: [{productReviewId: state.reviewId, expectedLastUpdatedStamp: revision}],
            changeReason: "Checked"
        })
        const reply = run(state.merchandiser, M + "reply#Review", {productReviewId: state.reviewId, replyText: "Thanks, Rita!"})
        const found = run(state.reader, M + "find#Reviews", {productStoreId: ids.store, statusId: "PrvwApproved"})
        const publicView = op(null, K + "get#Reviews", {productId: ids.product})
        const image = op(null, K + "get#ReviewImage", {reviewImage: "strv0000000000000000000000000001"})
        return {pendingImage, readerDecision, stale, approved, reply, found, publicView, image}
    },
    then(r) {
        code(r.pendingImage.error) == "NOT_AVAILABLE"
        code(r.readerDecision.error) == "PERMISSION_DENIED"
        r.stale.results[0].ok == false
        r.stale.results[0].reasonCode == "STALE_REVISION"
        r.approved.results[0].ok == true
        r.approved.results[0].statusId == "PrvwApproved"
        r.reply.replied == true
        r.found.reviews.map(row => row.productReviewId).includes(state.reviewId)
        r.found.canModerate == false
        r.publicView.result.summary.count == 1
        r.publicView.result.summary.average == "4.0"
        r.publicView.result.reviews[0].authorLabel == "Rita R."
        r.publicView.result.reviews[0].verifiedPurchase == true
        r.publicView.result.reviews[0].reply.text == "Thanks, Rita!"
        r.publicView.result.reviews[0].images[0].url.includes("reviewImage=strv0000000000000000000000000001")
        !JSON.stringify(r.publicView.result).includes(ids.buyer)
        !JSON.stringify(r.publicView.result).includes("strv.example.test")
        r.image.result.location == "runtime://tmp/strv/mug.png"
    }
})

feature("the author's edit returns the review to pending, out of the average and its image no longer served", {
    when() {
        const view = op(ids.buyer, K + "get#Reviews", {productId: ids.product}).result
        const edited = op(ids.buyer, K + "submit#Review", {
            productId: ids.product,
            productReviewId: state.reviewId,
            expectedRevision: view.own.revision,
            rating: "2",
            body: "It chipped.",
            displayChoice: "anonymous"
        })
        const staleEdit = op(ids.buyer, K + "submit#Review", {
            productId: ids.product,
            productReviewId: state.reviewId,
            expectedRevision: view.own.revision,
            rating: "3",
            body: "Again."
        })
        const after = op(null, K + "get#Reviews", {productId: ids.product})
        const image = op(null, K + "get#ReviewImage", {reviewImage: "strv0000000000000000000000000001"})
        return {edited, staleEdit, after, image, row: one("mantle.product.ProductReview", {productReviewId: state.reviewId})}
    },
    then(r) {
        r.edited.result.review.statusText == "Waiting for approval"
        code(r.staleEdit.error) == "STALE_REVISION"
        r.row.statusId == "PrvwPending"
        r.row.displayName == null
        r.row.replyText == "Thanks, Rita!"
        r.after.result.summary.count == 0
        r.after.result.summary.average == null
        r.after.result.reviews.length == 0
        code(r.image.error) == "NOT_AVAILABLE"
    }
})

feature(
    "the review request is queued once per delivered Shop order line, needs the store's review requests topic (not marketing email) and stops once reviewed; another order none",
    {
        when() {
            const theirs = order(ids.other, true)
            deliver(theirs.shipmentId)
            const again = run("john.doe", M + "queue#ReviewRequests", {orderId: theirs.orderId, orderItemSeqId: "01"})
            const deliveries = list("mantle.party.MessageDelivery", {eventKey: "reviewRequest:" + theirs.orderId + ":01"})
            const built = run("john.doe", M + "build#ReviewRequest", {eventKey: "reviewRequest:" + theirs.orderId + ":01"})
            // marketing email consent is not the topic: still suppressed
            system(() =>
                call("mantle.party.ConsentServices.store#PartyConsent", {
                    partyId: ids.other,
                    purposeEnumId: "PcpMarketingEmail",
                    statusId: "PconGranted"
                })
            )
            const attempted = run("john.doe", "mantle.party.MessageServices.attempt#Delivery", {
                deliveryId: deliveries[0]?.deliveryId
            })
            const suppressed = one("mantle.party.MessageDelivery", {deliveryId: deliveries[0]?.deliveryId})
            // the store's review requests topic turned on: the next attempt is no longer suppressed
            const topicListId = one(S + "ProductStoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstReviewRequestList"
            })?.settingValue
            system(() => {
                call("mantle.party.ConsentServices.store#PartyConsent", {
                    partyId: ids.other,
                    purposeEnumId: "PcpReviewRequest",
                    statusId: "PconGranted",
                    contactListId: topicListId
                })
                call("update#mantle.party.MessageDelivery", {deliveryId: deliveries[0]?.deliveryId, stateEnumId: "MdsQueued"})
            })
            const consented = system(
                () =>
                    call("mantle.public.AccountHubServices.check#ReviewRequestConsent", {
                        partyId: ids.other,
                        productStoreId: ids.store
                    }).consented
            )
            run("john.doe", "mantle.party.MessageServices.attempt#Delivery", {deliveryId: deliveries[0]?.deliveryId})
            const reviewed = run("john.doe", M + "build#ReviewRequest", {
                eventKey: "reviewRequest:" + state.bought.orderId + ":01",
                recipientPartyId: ids.buyer
            })
            const notShop = order(ids.other, false)
            const plain = run("john.doe", M + "queue#ReviewRequests", {shipmentId: notShop.shipmentId})
            return {
                again,
                deliveries,
                built,
                attempted,
                suppressed,
                topicListId,
                consented,
                reviewed,
                plain,
                buyerRequests: list("mantle.party.MessageDelivery", {eventKey: "reviewRequest:" + state.bought.orderId + ":01"}),
                notShopRequests: list("mantle.party.MessageDelivery", {eventKey: "reviewRequest:" + notShop.orderId + ":01"}),
                delivery: one("mantle.party.MessageDelivery", {deliveryId: deliveries[0]?.deliveryId})
            }
        },
        then(r) {
            r.deliveries.length == 1
            r.deliveries[0].transactional == "N"
            r.deliveries[0].templateKey == ids.template
            r.again.queued == 0
            r.built.bodyParameters.reviewUrl == "https://" + ids.host + "/shop/Review?productId=" + ids.product
            r.built.bodyParameters.productName == "Review mug"
            r.suppressed.stateEnumId == "MdsSuppressed"
            JSON.parse(r.suppressed.consentJson).purposeEnumId == "PcpReviewRequest"
            JSON.parse(r.suppressed.consentJson).contactListId == r.topicListId
            JSON.parse(r.suppressed.consentJson).granted == false
            r.consented == true
            r.delivery.stateEnumId != "MdsSuppressed"
            JSON.parse(r.delivery.consentJson).granted == true
            r.buyerRequests.length == 1
            r.reviewed.suppress == "Already reviewed"
            r.plain.queued == 0
            r.notShopRequests.length == 0
        }
    }
)
