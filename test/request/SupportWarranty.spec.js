// Warranty claims (impl-customer-service P11: CS-WARRANTY, F45, F50, F67; mantle.request.WarrantyServices, Warranty.js): a claim
// on a delivered serial covered from its ship date plus the product's 12-month warranty term, with its source, and a service
// agreement covering first; the claim's checks (another customer's serial, a serial of another product, another
// organization's claim, no permission); an expired claim refused as covered, rejected, or approved as goodwill by a
// WARRANTY_APPROVE holder who is recorded, a stale or missing revision refused, a manual coverage end needing its reason, a
// change of evidence superseding the decision, a chargeable repair needing the customer's consent; a repair linked as an
// AssetMaintenance with its WepMaintenance task, its completion telling the claim's agent and leaving the case open, and a
// maintenance no claim links telling no one (the rule's default). Standalone: spec-local organizations, customers, products,
// serials, sales and users, artifact authorization disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec SupportWarranty
const prefix = "SWY"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    otherCustomer = prefix + "_CUST2",
    facility = prefix + "_WH",
    product = prefix + "_THERMO",
    plainProduct = prefix + "_PLAIN",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    W = "mantle.request.WarrantyServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
const dayMs = 86400000
const nowMs = () => Number(ec.user.nowTimestamp.getTime ? ec.user.nowTimestamp.getTime() : Date.now())
// the organization's time zone (its working-hours calendar's), far from the user's so a day in the wrong zone shows
const zone = "Pacific/Kiritimati"
const time = ec.resource.script("component://mr-mantle/service/mantle/work/BusinessTime.js")
const dayText = millis => ec.l10n.format(new Date(millis), "yyyy-MM-dd", null, zone)
// the day a number of calendar months after a time's day in the zone (the month's last day when it is shorter)
const plusMonths = (millis, months) => {
    const [y, m, d] = dayText(millis).split("-").map(Number)
    const last = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate()
    return new Date(Date.UTC(y, m - 1 + months, Math.min(d, last))).toISOString().slice(0, 10)
}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
function party(partyId, name, roleTypeId, ownerPartyId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId: ownerPartyId || "_NA_"})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Warranty " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Warranty " + kind, null, organizationPartyId, "PtyPerson")
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// a serial of a product sold by the organization (or another vendor) to a customer and shipped some days ago (its
// AssetIssuance), or at a given time; a serial number of an earlier asset is that serial sold again
function soldSerial(key, productId, customerPartyId, daysAgo, options = {}) {
    const assetId = prefix + "_ASSET_" + key,
        orderId = prefix + "_SO_" + key,
        serialNumber = options.serialNumber || prefix + "-" + key
    call("create#mantle.order.OrderHeader", {
        orderId,
        statusId: "OrderCompleted",
        currencyUomId: "USD",
        entryDate: new Date(nowMs())
    })
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: options.vendorPartyId || org,
        customerPartyId,
        statusId: "OrderCompleted"
    })
    call("create#mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemProduct",
        productId,
        quantity: 1,
        unitAmount: 100
    })
    call("create#mantle.product.asset.Asset", {
        assetId,
        productId,
        assetTypeEnumId: "AstTpInventory",
        serialNumber,
        statusId: "AstDelivered",
        facilityId: options.facilityId === undefined ? facility : options.facilityId,
        ownerPartyId: options.ownerPartyId || customerPartyId
    })
    const shipMs = options.shipMs ?? nowMs() - daysAgo * dayMs
    call("create#mantle.product.issuance.AssetIssuance", {
        assetId,
        orderId,
        orderItemSeqId: "01",
        productId,
        issuedDate: new Date(shipMs),
        quantity: 1
    })
    return {assetId, orderId, serialNumber, shipMs}
}
const claim = (username, fields) =>
    run(
        username,
        W + "save#WarrantyClaim",
        Object.assign({organizationPartyId: org, customerPartyId: customer, assigneePartyId: state.agent}, fields)
    )
const coverage = (username, requestId) => run(username, W + "get#WarrantyCoverage", {requestId}).coverage || {}
const revisionOf = requestId => Number(one("mantle.request.Request", {requestId}).claimRevision || 0)
const decide = (username, requestId, fields) =>
    run(username, W + "decide#WarrantyClaim", Object.assign({requestId, claimRevision: revisionOf(requestId)}, fields))
const finishedNotices = requestId =>
    rows("moqui.security.user.NotificationMessage", {topic: "WarrantyRepairFinished", recordId: requestId}).length

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Warranty Spec Org", "OrgInternal")
        party(otherOrg, "Warranty Spec Other Org", "OrgInternal")
        party(customer, "Warranty Spec Customer", "Customer", org)
        party(otherCustomer, "Warranty Spec Other Customer", "Customer", org)
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.work.calendar.Calendar", {
            calendarId: prefix + "_HOURS",
            ownerPartyId: org,
            calendarKindEnumId: "CalkResource",
            timeZone: zone
        })
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.manager = user("MANAGER", ["SUPPORT_CASE_EDIT", "WARRANTY_APPROVE"])
        state.reader = user("READER", [])
        state.otherAgent = user("OTHER_AGENT", ["SUPPORT_CASE_EDIT"], otherOrg)
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Warranty spec queue"
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        // the warranty claim type's own template, which a claim's case takes before the queue's (P11)
        call("create#moqui.screen.form.DbForm", {
            formId: prefix + "_TPL",
            purposeEnumId: "DbfpCaseTemplate",
            isDated: "Y",
            ownerPartyId: org,
            description: "Warranty spec claim"
        })
        call("create#moqui.screen.form.DbFormField", {
            formId: prefix + "_TPL",
            fieldName: "serialNumber",
            title: "Serial number",
            fieldTypeEnumId: "DBFFT_text-line",
            layoutSequenceNum: 10,
            audienceEnumId: "CfaCustomer",
            fromDate: since
        })
        call("create#mantle.request.support.ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtWarranty",
            serviceEnabled: "Y",
            defaultCategoryId: state.queue,
            templateFormId: prefix + "_TPL",
            fromDate: since
        })
        // the thermostat under a 12-month warranty; a product with none
        call("create#mantle.product.feature.ProductFeature", {
            productFeatureId: prefix + "_WARRANTY_12",
            productFeatureTypeEnumId: "PftWarranty",
            description: "12-month warranty",
            numberSpecified: 12,
            numberUomId: "TF_mon"
        })
        for (const [productId, productName] of [
            [product, "Warranty spec thermostat"],
            [plainProduct, "Warranty spec controller"]
        ])
            call("create#mantle.product.Product", {productId, productTypeEnumId: "PtAsset", productName, ownerPartyId: org})
        call("create#mantle.product.feature.ProductFeatureAppl", {
            productId: product,
            productFeatureId: prefix + "_WARRANTY_12",
            applTypeEnumId: "PfatStandard",
            fromDate: since
        })
        // shipped half an hour into a day in the organization's zone (the day before in the user's)
        const shipDay = dayText(nowMs() - 10 * dayMs)
        state.recent = soldSerial("1001", product, customer, 10, {shipMs: time.dayStartIn(shipDay, zone) + 30 * 60000})
        state.old = soldSerial("1002", product, customer, 730)
        state.plain = soldSerial("1003", plainProduct, customer, 30)
        state.theirs = soldSerial("9001", product, otherCustomer, 10)
        // another organization's sale of a serial to the customer
        state.otherSale = soldSerial("9002", product, customer, 10, {vendorPartyId: otherOrg, facilityId: null})
        // a serial sold to the customer, returned (received as a new asset) and sold again to the other customer
        state.resold = soldSerial("1004", product, customer, 200, {ownerPartyId: org})
        state.resoldAgain = soldSerial("1005", product, otherCustomer, 5, {
            serialNumber: state.resold.serialNumber,
            ownerPartyId: org
        })
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature(
    "a claim on a delivered serial is covered from its ship date plus the product's 12-month term; an agreement covers first",
    {
        when() {
            const made = claim(state.agent, {requestName: "Thermostat reads high", serialNumber: state.recent.serialNumber})
            state.recentClaim = made.requestId
            const recent = coverage(state.agent, made.requestId)
            const items = rows("mantle.request.RequestItem", {requestId: made.requestId})
            const links = rows("mantle.request.RequestRecord", {requestId: made.requestId}).map(
                row => row.recordEntityName + ":" + row.recordId
            )
            const request = one("mantle.request.Request", {requestId: made.requestId})
            const profile = one("mantle.request.support.CaseProfile", {requestId: made.requestId})
            // a resave of the type keeps its template (as save#ServiceQueue keeps a queue's)
            const resaved = run(state.admin, S + "save#ServiceRequestType", {
                organizationPartyId: org,
                requestTypeEnumId: "RqtWarranty",
                serviceEnabled: "Y",
                defaultCategoryId: state.queue,
                customerLabel: "A warranty claim"
            })
            const typeTemplate = one("mantle.request.support.ServiceRequestType", {
                serviceRequestTypeId: resaved.serviceRequestTypeId
            })?.templateFormId
            const refused = {
                theirSerial: code(claim(state.agent, {requestId: made.requestId, assetId: state.theirs.assetId})),
                otherOrganizationSerial: code(claim(state.agent, {requestId: made.requestId, assetId: state.otherSale.assetId})),
                resoldSerial: code(claim(state.agent, {requestId: made.requestId, serialNumber: state.resold.serialNumber})),
                resoldAsset: code(claim(state.agent, {requestId: made.requestId, assetId: state.resold.assetId})),
                otherProduct: code(
                    claim(state.agent, {requestId: made.requestId, assetId: state.recent.assetId, productId: plainProduct})
                ),
                otherOrganization: code(run(state.otherAgent, W + "get#WarrantyCoverage", {requestId: made.requestId})),
                reader: code(run(state.reader, W + "get#WarrantyCoverage", {requestId: made.requestId})),
                stale: code(claim(state.agent, {requestId: made.requestId, claimRevision: 7, faultText: "Stale"})),
                agentAgreement: code(
                    run(state.agent, W + "store#ServiceAgreement", {
                        organizationPartyId: org,
                        customerPartyId: customer,
                        warrantyTermsText: "Parts and labour"
                    })
                )
            }
            // a product with no warranty: not covered until the customer's service agreement covers it
            const plainClaim = claim(state.agent, {requestName: "Controller dead", assetId: state.plain.assetId}).requestId
            const before = coverage(state.agent, plainClaim)
            const agreement = run(state.admin, W + "store#ServiceAgreement", {
                organizationPartyId: org,
                customerPartyId: customer,
                description: "Controller care plan",
                fromDate: new Date(nowMs() - 60 * dayMs),
                thruDate: new Date(nowMs() + 365 * dayMs),
                warrantyTermsText: "Parts and labour on the controller",
                productId: plainProduct
            })
            const after = coverage(state.agent, plainClaim)
            const thermostatAfter = coverage(state.agent, made.requestId)
            // the serial sold again is the other customer's, covered from its own sale on its own asset
            const resoldClaim = claim(state.agent, {
                customerPartyId: otherCustomer,
                requestName: "Resold thermostat",
                assetId: state.resold.assetId
            })
            const resold = coverage(state.agent, resoldClaim.requestId)
            const delivered = run(state.agent, W + "find#DeliveredItems", {customerPartyId: customer}).deliveredList || []
            const listed = run(state.agent, W + "find#WarrantyClaims", {customerPartyId: customer}).claimList || []
            return {
                made,
                recent,
                items,
                links,
                request,
                profile,
                typeTemplate,
                refused,
                before,
                agreement,
                after,
                thermostatAfter,
                delivered,
                listed,
                resold
            }
        },
        then({
            made,
            recent,
            items,
            links,
            request,
            profile,
            typeTemplate,
            refused,
            before,
            agreement,
            after,
            thermostatAfter,
            delivered,
            listed,
            resold
        }) {
            made.error == ""
            profile.templateFormId == prefix + "_TPL"
            typeTemplate == prefix + "_TPL"
            made.claimRevision == 1
            request.requestTypeEnumId == "RqtWarranty"
            items.length == 1
            items[0].productId == product
            links.includes("mantle.product.asset.Asset:" + state.recent.assetId)
            links.includes("mantle.order.OrderHeader:" + state.recent.orderId)
            recent.basisEnumId == "WcbProductWarranty"
            recent.covered == true
            recent.saleOrderId == state.recent.orderId
            recent.shipText == dayText(state.recent.shipMs)
            recent.shipText != ec.l10n.format(new Date(state.recent.shipMs), "yyyy-MM-dd")
            recent.coverageEndText == plusMonths(state.recent.shipMs, 12)
            recent.coverageEndSourceText.includes("plus 12 months of 12-month warranty")
            recent.termsSourceText.includes(prefix + "_WARRANTY_12")
            refused.theirSerial == "ASSET_UNAVAILABLE"
            refused.otherOrganizationSerial == "ASSET_UNAVAILABLE"
            refused.resoldSerial == "ASSET_UNAVAILABLE"
            refused.resoldAsset == "ASSET_UNAVAILABLE"
            resold.assetId == state.resoldAgain.assetId
            resold.saleOrderId == state.resoldAgain.orderId
            resold.covered == true
            refused.otherProduct == "ASSET_PRODUCT_MISMATCH"
            refused.otherOrganization == "RECORD_UNAVAILABLE"
            refused.reader == "PERMISSION_DENIED"
            refused.stale == "STALE_REVISION"
            refused.agentAgreement == "PERMISSION_DENIED"
            before.basisEnumId == "WcbNone"
            before.covered == false
            agreement.error == ""
            after.basisEnumId == "WcbAgreement"
            after.covered == true
            after.agreementId == agreement.agreementId
            after.coverageEndText == dayText(nowMs() + 365 * dayMs)
            thermostatAfter.basisEnumId == "WcbProductWarranty"
            delivered.some(row => row.assetId === state.recent.assetId && row.covered && row.claimRequestId === made.requestId)
            delivered.some(row => row.assetId === state.old.assetId && !row.covered)
            !delivered.some(row => row.assetId === state.theirs.assetId)
            !delivered.some(row => row.assetId === state.resold.assetId || row.assetId === state.otherSale.assetId)
            listed.some(row => row.requestId === made.requestId && row.state === "assessment")
        }
    }
)

feature("an expired claim is rejected or approved as goodwill with its approver; revisions, overrides and charges are checked", {
    when() {
        const requestId = (state.oldClaim = claim(state.agent, {
            requestName: "Old thermostat failed",
            serialNumber: state.old.serialNumber
        }).requestId)
        const found = coverage(state.agent, requestId)
        const refused = {
            noRevision: code(
                run(state.agent, W + "decide#WarrantyClaim", {requestId, decisionEnumId: "WdRejected", reason: "x"})
            ),
            stale: code(decide(state.agent, requestId, {claimRevision: 9, decisionEnumId: "WdRejected", reason: "x"})),
            covered: code(decide(state.agent, requestId, {decisionEnumId: "WdCovered"})),
            agentGoodwill: code(decide(state.agent, requestId, {decisionEnumId: "WdGoodwill", reason: "A loyal customer"})),
            overrideNoReason: code(
                decide(state.manager, requestId, {
                    decisionEnumId: "WdCovered",
                    overrideCoverageEndDate: new Date(nowMs() + dayMs)
                })
            ),
            agentOverride: code(
                decide(state.agent, requestId, {
                    decisionEnumId: "WdCovered",
                    overrideCoverageEndDate: new Date(nowMs() + dayMs),
                    overrideReason: "Shipped late"
                })
            ),
            chargeOnCovered: code(
                decide(state.manager, requestId, {
                    decisionEnumId: "WdGoodwill",
                    reason: "x",
                    chargeEstimate: 10,
                    chargeCurrencyUomId: "USD"
                })
            )
        }
        const rejected = decide(state.agent, requestId, {decisionEnumId: "WdRejected", reason: "The warranty ended a year ago"})
        const rejectedState = run(state.agent, W + "get#WarrantyClaim", {requestId}).claim?.state
        const workOnRejected = code(run(state.agent, W + "link#WarrantyWork", {requestId, comments: "Replace the sensor"}))
        const goodwill = decide(state.manager, requestId, {decisionEnumId: "WdGoodwill", reason: "A loyal customer, one-off"})
        const read = run(state.agent, W + "get#WarrantyClaim", {requestId})
        const decisions = rows("mantle.request.support.WarrantyDecision", {requestId})
        // a change of evidence moves the revision: the goodwill no longer counts
        const changed = claim(state.agent, {requestId, faultText: "Display blank after a power cut"})
        const afterChange = run(state.agent, W + "get#WarrantyClaim", {requestId})
        // a decision at the earlier revision is refused; one after the evidence changed (a serial still covered) sees it
        const staleAfterChange = code(
            decide(state.agent, requestId, {claimRevision: 1, decisionEnumId: "WdRejected", reason: "x"})
        )
        const switched = claim(state.agent, {requestId, assetId: state.recent.assetId})
        const coveredNow = decide(state.agent, requestId, {decisionEnumId: "WdCovered"})
        // a chargeable repair: the estimate, then the consent before the repair
        const charged = decide(state.agent, requestId, {
            decisionEnumId: "WdRejected",
            reason: "Out of warranty: repair at cost",
            chargeEstimate: 45,
            chargeCurrencyUomId: "USD"
        })
        const noConsent = code(run(state.agent, W + "link#WarrantyWork", {requestId, comments: "Replace the display"}))
        return {
            found,
            refused,
            rejected,
            rejectedState,
            workOnRejected,
            goodwill,
            read,
            decisions,
            changed,
            afterChange,
            staleAfterChange,
            switched,
            coveredNow,
            charged,
            noConsent
        }
    },
    then({
        found,
        refused,
        rejected,
        rejectedState,
        workOnRejected,
        goodwill,
        read,
        decisions,
        changed,
        afterChange,
        staleAfterChange,
        switched,
        coveredNow,
        charged,
        noConsent
    }) {
        found.basisEnumId == "WcbProductWarranty"
        found.covered == false
        found.coverageEndText == plusMonths(state.old.shipMs, 12)
        refused.noRevision == "REVISION_REQUIRED"
        refused.stale == "STALE_REVISION"
        refused.covered == "NOT_COVERED"
        refused.agentGoodwill == "PERMISSION_DENIED"
        refused.overrideNoReason == "OVERRIDE_REASON_REQUIRED"
        refused.agentOverride == "PERMISSION_DENIED"
        refused.chargeOnCovered == "CHARGE_NOT_ALLOWED"
        rejected.error == ""
        rejectedState == "rejected"
        workOnRejected == "NOT_APPROVED"
        goodwill.error == ""
        read.currentDecision.decisionEnumId == "WdGoodwill"
        read.currentDecision.approverName == "Warranty MANAGER Spec"
        read.claim.state == "approved"
        decisions.length == 2
        decisions.filter(row => row.supersededDate).length == 1
        changed.claimRevision == 2
        afterChange.currentDecision == null
        afterChange.claim.state == "assessment"
        staleAfterChange == "STALE_REVISION"
        switched.claimRevision == 3
        coveredNow.error == ""
        charged.error == ""
        noConsent == "CONSENT_REQUIRED"
    }
})

feature("a repair is an AssetMaintenance with its task; finishing it tells the agent and leaves the case open", {
    when() {
        const requestId = state.recentClaim
        const covered = decide(state.agent, requestId, {decisionEnumId: "WdCovered"})
        const noWork = code(run(state.agent, W + "link#WarrantyWork", {requestId}))
        const linked = run(state.agent, W + "link#WarrantyWork", {requestId, comments: "Replace the temperature sensor"})
        const maintenance = one("mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: linked.assetMaintenanceId})
        const task = one("mantle.work.effort.WorkEffort", {workEffortId: linked.taskWorkEffortId})
        const link = one("mantle.request.RequestRecord", {
            requestId,
            recordEntityName: "mantle.product.maintenance.AssetMaintenance",
            recordId: linked.assetMaintenanceId
        })
        const statusBefore = one("mantle.request.Request", {requestId}).statusId
        const noticesBefore = finishedNotices(requestId)
        const finished = run(state.agent, W + "update#WarrantyWork", {
            requestId,
            assetMaintenanceId: linked.assetMaintenanceId,
            statusId: "AsMntCompleted",
            comments: "Sensor replaced and calibrated"
        })
        const after = one("mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId: linked.assetMaintenanceId})
        const taskAfter = one("mantle.work.effort.WorkEffort", {workEffortId: linked.taskWorkEffortId})
        const notices = rows("moqui.security.user.NotificationMessage", {topic: "WarrantyRepairFinished", recordId: requestId})
        const noticeUsers = notices.length
            ? rows("moqui.security.user.NotificationMessageUser", {notificationMessageId: notices[0].notificationMessageId}).map(
                  row => row.userId
              )
            : []
        const request = one("mantle.request.Request", {requestId})
        const again = code(
            run(state.agent, W + "update#WarrantyWork", {
                requestId,
                assetMaintenanceId: linked.assetMaintenanceId,
                statusId: "AsMntCancelled"
            })
        )
        // the default: a maintenance no claim links tells no one
        const plain = run("john.doe", "mantle.product.EquipmentServices.create#AssetMaintenance", {
            assetId: state.plain.assetId,
            statusId: "AsMntCreated"
        })
        run("john.doe", "update#mantle.product.maintenance.AssetMaintenance", {
            assetMaintenanceId: plain.assetMaintenanceId,
            statusId: "AsMntInProcess"
        })
        const plainDone = run("john.doe", "update#mantle.product.maintenance.AssetMaintenance", {
            assetMaintenanceId: plain.assetMaintenanceId,
            statusId: "AsMntCompleted"
        })
        const plainNotices = rows("moqui.security.user.NotificationMessage", {topic: "WarrantyRepairFinished"}).filter(row =>
            String(row.messageJson || "").includes(plain.assetMaintenanceId)
        ).length
        return {
            covered,
            noWork,
            linked,
            maintenance,
            task,
            link,
            statusBefore,
            noticesBefore,
            finished,
            after,
            taskAfter,
            notices,
            noticeUsers,
            request,
            again,
            plainDone,
            plainNotices
        }
    },
    then({
        covered,
        noWork,
        linked,
        maintenance,
        task,
        link,
        statusBefore,
        noticesBefore,
        finished,
        after,
        taskAfter,
        notices,
        noticeUsers,
        request,
        again,
        plainDone,
        plainNotices
    }) {
        covered.error == ""
        noWork == "WORK_REQUIRED"
        linked.error == ""
        maintenance.assetId == state.recent.assetId
        maintenance.maintenanceTypeEnumId == "MntTpWarranty"
        maintenance.taskWorkEffortId == linked.taskWorkEffortId
        task.purposeEnumId == "WepMaintenance"
        link != null
        noticesBefore == 0
        finished.error == ""
        after.statusId == "AsMntCompleted"
        after.comments.includes("Sensor replaced and calibrated")
        taskAfter.statusId == "WeComplete"
        notices.length == 1
        noticeUsers.includes(state.agent)
        request.statusId == statusBefore
        again == "STATUS_INVALID"
        plainDone.error == ""
        plainNotices == 0
    }
})
