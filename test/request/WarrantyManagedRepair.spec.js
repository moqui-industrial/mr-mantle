// A warranty repair as managed maintenance work (impl-maintenance P12; design-maintenance §3's customer repair, §12's intervention
// report; mantle.request.WarrantyServices, Warranty.js; MaintenanceWork.js adoptRepair, MaintenanceRepairs.js): with the
// organization's MaintenancePolicy off link#WarrantyWork makes no work order (as before); with it on a claim's repair linked twice,
// or retried under its key, has one root (its task), corrective, of the claim's organization, and the customer's asset keeps its
// owner while the technician reads it through the work order; Start and a parts issue are refused once the customer's consent is
// withdrawn (a new decision without it) and open again with it; completing the work tells the agent and leaves the case open, an
// agent with no maintenance permission cannot move the work order through update#WarrantyWork; the intervention report is stored
// by the technician (no parts and labor for a reader without the cost view) and Customer Service sends only a stored one, to the
// customer's addresses. Standalone: spec-local organization, customer, product, sold serials and users, the services called as
// each user with the artifact check aside (their own permission and scope checks decide).
// Run: ./moq test mr-mantle --spec WarrantyManagedRepair
const prefix = "WMR"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    facility = prefix + "_WH",
    product = prefix + "_HEATER",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    W = "mantle.request.WarrantyServices.",
    M = "mantle.work.MaintenanceServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}
const dayMs = 86400000
const nowMs = () => Number(ec.user.nowTimestamp.getTime ? ec.user.nowTimestamp.getTime() : Date.now())

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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Managed repair " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Managed repair " + kind, null, organizationPartyId, "PtyPerson")
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
// a serial the organization sold to the customer ten days ago, now at the customer's site (no facility)
function soldSerial(key) {
    const assetId = prefix + "_ASSET_" + key,
        orderId = prefix + "_SO_" + key
    call("create#mantle.order.OrderHeader", {
        orderId,
        statusId: "OrderCompleted",
        currencyUomId: "USD",
        entryDate: new Date(nowMs())
    })
    call("create#mantle.order.OrderPart", {
        orderId,
        orderPartSeqId: "01",
        vendorPartyId: org,
        customerPartyId: customer,
        statusId: "OrderCompleted"
    })
    call("create#mantle.order.OrderItem", {
        orderId,
        orderItemSeqId: "01",
        orderPartSeqId: "01",
        itemTypeEnumId: "ItemProduct",
        productId: product,
        quantity: 1,
        unitAmount: 100
    })
    call("create#mantle.product.asset.Asset", {
        assetId,
        productId: product,
        assetTypeEnumId: "AstTpInventory",
        serialNumber: prefix + "-" + key,
        statusId: "AstDelivered",
        ownerPartyId: customer
    })
    call("create#mantle.product.issuance.AssetIssuance", {
        assetId,
        orderId,
        orderItemSeqId: "01",
        productId: product,
        issuedDate: new Date(nowMs() - 10 * dayMs),
        quantity: 1
    })
    return assetId
}
const claim = (key, name) =>
    run(state.agent, W + "save#WarrantyClaim", {
        organizationPartyId: org,
        customerPartyId: customer,
        assigneePartyId: state.agent,
        requestName: name,
        assetId: soldSerial(key)
    }).requestId
const revisionOf = requestId => Number(one("mantle.request.Request", {requestId}).claimRevision || 0)
const decide = (requestId, fields) =>
    run(state.agent, W + "decide#WarrantyClaim", Object.assign({requestId, claimRevision: revisionOf(requestId)}, fields))
const roots = assetMaintenanceId => rows("mantle.work.maintenance.MaintenanceWorkOrder", {assetMaintenanceId})
const work = workEffortId => one("mantle.work.effort.WorkEffort", {workEffortId})
const notices = requestId =>
    rows("moqui.security.user.NotificationMessage", {topic: "WarrantyRepairFinished", recordId: requestId}).length

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Managed Repair Org", "OrgInternal")
        party(otherOrg, "Managed Repair Other Org", "OrgInternal")
        party(customer, "Managed Repair Customer", "Customer", org)
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.otherAgent = user("OTHER_AGENT", ["SUPPORT_CASE_EDIT"], otherOrg)
        state.tech = user("TECH", ["MAINTENANCE_ASSIGNED_VIEW", "MAINTENANCE_EXECUTE", "STOCK_ISSUE"])
        state.supervisor = user("SUPERVISOR", ["MAINTENANCE_VIEW", "MAINTENANCE_SUPERVISE"])
        // review: the customer's address and the agent's mail account, for a send that goes (the mail capture keeps it)
        const contactMechId = call("create#mantle.party.contact.ContactMech", {
            contactMechTypeEnumId: "CmtEmailAddress",
            infoString: "service@managed-repair-customer.example"
        }).contactMechId
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: customer,
            contactMechId,
            contactMechPurposeId: "EmailPrimary",
            fromDate: since
        })
        call("create#moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_MAIL",
            smtpHost: "127.0.0.1",
            smtpPort: 9,
            smtpStartTls: "N",
            smtpSsl: "N"
        })
        call("create#moqui.basic.email.EmailAccount", {
            emailAccountId: prefix + "_ACCOUNT",
            ownerPartyId: org,
            accountKindEnumId: "EakShared",
            emailServerId: prefix + "_MAIL",
            emailAddress: "service@managed-repair-org.example",
            accountName: "Managed repair service mail",
            statusId: "EasActive",
            recordFilingEnumId: "ErfLinkedOnly"
        })
        call("create#moqui.basic.email.EmailAccountUser", {
            emailAccountId: prefix + "_ACCOUNT",
            userId: state.agent,
            fromDate: since,
            permissionEnumId: "EapSend"
        })
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Managed repair queue"
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        call("create#mantle.request.support.ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtWarranty",
            serviceEnabled: "Y",
            defaultCategoryId: state.queue,
            fromDate: since
        })
        // the heater under a 12-month warranty
        call("create#mantle.product.feature.ProductFeature", {
            productFeatureId: prefix + "_WARRANTY_12",
            productFeatureTypeEnumId: "PftWarranty",
            description: "12-month warranty",
            numberSpecified: 12,
            numberUomId: "TF_mon"
        })
        call("create#mantle.product.Product", {
            productId: product,
            productTypeEnumId: "PtAsset",
            productName: "Managed repair heater",
            ownerPartyId: org
        })
        call("create#mantle.product.feature.ProductFeatureAppl", {
            productId: product,
            productFeatureId: prefix + "_WARRANTY_12",
            applTypeEnumId: "PfatStandard",
            fromDate: since
        })
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})
const capture = ec.factory.getTool("MailCapture")

feature(
    "with the policy off a repair is no work order; with it on a claim's repair linked twice has one root, the customer's asset",
    {
        when() {
            const offClaim = claim("1001", "Heater trips off")
            decide(offClaim, {decisionEnumId: "WdCovered"})
            const off = run(state.agent, W + "link#WarrantyWork", {requestId: offClaim, comments: "Replace the thermostat"})
            // the organization's policy manages warranty repairs from now
            call("create#mantle.work.maintenance.MaintenancePolicy", {
                organizationPartyId: org,
                fromDate: since,
                approvalThresholdHours: 0,
                warrantyRepairsManaged: "Y"
            })
            const requestId = claim("1002", "Heater rattles")
            decide(requestId, {decisionEnumId: "WdCovered"})
            const parameters = {
                requestId,
                comments: "Replace the fan bearing",
                assigneePartyId: state.tech,
                operationKey: prefix + "-link"
            }
            const first = run(state.agent, W + "link#WarrantyWork", parameters)
            const retried = run(state.agent, W + "link#WarrantyWork", parameters)
            const again = run(state.agent, W + "link#WarrantyWork", {requestId, assetMaintenanceId: first.assetMaintenanceId})
            state.covered = {requestId, assetMaintenanceId: first.assetMaintenanceId, workEffortId: first.workEffortId}
            const order = one("mantle.work.maintenance.MaintenanceWorkOrder", {workEffortId: first.workEffortId}) || {}
            const asset = one("mantle.product.asset.Asset", {assetId: prefix + "_ASSET_1002"})
            // the technician reads the work order and the customer's asset through it, which no Maintenance scope covers
            const read = run(state.tech, M + "get#MaintenanceWorkOrder", {workEffortId: first.workEffortId})
            return {off, offRoots: roots(off.assetMaintenanceId).length, first, retried, again, order, asset, read}
        },
        then({off, offRoots, first, retried, again, order, asset, read}) {
            off.error == ""
            off.workEffortId == null
            offRoots == 0
            first.error == ""
            first.workEffortId == first.taskWorkEffortId
            retried.workEffortId == first.workEffortId
            again.workEffortId == first.workEffortId
            roots(first.assetMaintenanceId).length == 1
            order.sourceEnumId == "MsrcWarranty"
            order.maintenanceKindEnumId == "MkCorrective"
            work(first.workEffortId).statusFlowId == "WorkEffortMaintenance"
            work(first.workEffortId).statusId == "WeApproved"
            work(first.workEffortId).ownerPartyId == org
            asset.ownerPartyId == customer
            read.error == ""
            read.workOrder.repair.requestId == state.covered.requestId
            read.workOrder.repair.customerName == "Managed Repair Customer"
            read.workOrder.repair.allowed == true
            read.workOrder.repair.assetInScope == false
            read.workOrder.assetId == prefix + "_ASSET_1002"
            // review R3: Start asks no offline intent for the customer's unit away
            read.actionList.find(row => row.action === "start").needsOffline === false
        }
    }
)

feature("Start and a parts issue are refused once the customer's consent is withdrawn, and open again with it", {
    when() {
        const requestId = claim("1003", "Heater element burnt")
        const charge = {
            decisionEnumId: "WdRejected",
            reason: "Burnt by a power surge: repair at cost",
            chargeEstimate: "80",
            chargeCurrencyUomId: "USD"
        }
        decide(requestId, Object.assign({customerConsentRef: "Phone call"}, charge))
        const linked = run(state.agent, W + "link#WarrantyWork", {
            requestId,
            comments: "Replace the element",
            assigneePartyId: state.tech
        })
        state.charged = {requestId, assetMaintenanceId: linked.assetMaintenanceId, workEffortId: linked.workEffortId}
        // the customer withdraws: a new decision with the estimate and no consent supersedes the agreed one
        decide(requestId, charge)
        const start = () =>
            run(state.tech, M + "transition#MaintenanceWorkOrder", {workEffortId: linked.workEffortId, action: "start"})
        const refusedStart = start()
        const blockers = run(state.tech, M + "get#MaintenanceWorkOrder", {workEffortId: linked.workEffortId}).blockerList || []
        const refusedIssue = run(state.tech, "mantle.work.MaintenanceExecutionServices.issue#MaintenanceMaterial", {
            operationKey: prefix + "-issue",
            workEffortId: linked.workEffortId,
            productId: product,
            assetId: prefix + "_NO_STOCK",
            quantity: 1
        })
        decide(requestId, Object.assign({customerConsentRef: "Email of Nov 12"}, charge))
        return {linked, refusedStart, blockers, refusedIssue, started: start()}
    },
    then({linked, refusedStart, blockers, refusedIssue, started}) {
        linked.error == ""
        code(refusedStart) == "CONSENT_REQUIRED"
        blockers.some(row => row.detail.includes("consent"))
        code(refusedIssue) == "CONSENT_REQUIRED"
        started.error == ""
        work(linked.workEffortId).statusId == "WeInProgress"
    }
})

feature("completing the work tells the agent and leaves the case open; the agent cannot move the work order", {
    when() {
        const {requestId, assetMaintenanceId, workEffortId} = state.charged
        const before = notices(requestId)
        const agentMove = run(state.agent, W + "update#WarrantyWork", {
            requestId,
            assetMaintenanceId,
            statusId: "AsMntCompleted",
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable"
        })
        const completed = run(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId,
            action: "complete",
            outcomeEnumId: "MoutRepaired",
            dispositionEnumId: "MdispAvailable"
        })
        return {
            before,
            after: notices(requestId),
            agentMove,
            completed,
            maintenance: one("mantle.product.maintenance.AssetMaintenance", {assetMaintenanceId}).statusId,
            caseStatus: one("mantle.request.Request", {requestId}).statusId
        }
    },
    then({before, after, agentMove, completed, maintenance, caseStatus}) {
        code(agentMove) == "PERMISSION_DENIED"
        completed.error == ""
        maintenance == "AsMntCompleted"
        after == before + 1
        !["ReqCompleted", "ReqCancelled"].includes(caseStatus)
    }
})

feature(
    "the technician stores the intervention report with no costs; Customer Service sends only a stored one, to the customer",
    {
        when() {
            const {requestId, assetMaintenanceId, workEffortId} = state.charged
            const send = (username, fields) =>
                run(
                    username,
                    W + "send#InterventionReport",
                    Object.assign(
                        {requestId, assetMaintenanceId, operationKey: prefix + "-send-" + username + (fields.key || "")},
                        fields
                    )
                )
            const beforeStore = send(state.agent, {toAddress: "someone@example.com", key: "1"})
            const notDone = run(state.tech, M + "store#InterventionReport", {workEffortId: state.covered.workEffortId})
            const stored = run(state.tech, M + "store#InterventionReport", {workEffortId, operationKey: prefix + "-store"})
            const report = run(state.tech, M + "get#InterventionReport", {workEffortId})
            return {
                beforeStore,
                notDone,
                stored,
                report,
                content: one("mantle.work.effort.WorkEffortContent", {workEffortContentId: stored.workEffortContentId}) || {},
                stranger: send(state.agent, {toAddress: "someone@example.com", key: "2"}),
                otherAgent: send(state.otherAgent, {toAddress: "someone@example.com"})
            }
        },
        then({beforeStore, notDone, stored, report, content, stranger, otherAgent}) {
            code(beforeStore) == "REPORT_REQUIRED"
            code(notDone) == "WORK_NOT_DONE"
            stored.error == ""
            content.contentTypeEnumId == "WectInterventionReport"
            report.costsShown == false
            report.printHtml.includes("Managed Repair Customer")
            report.printHtml.includes("Repaired")
            !report.printHtml.includes("Labor")
            report.stored.workEffortContentId == stored.workEffortContentId
            code(stranger) == "RECIPIENT_UNCHECKED"
            code(otherAgent) == "RECORD_UNAVAILABLE"
        }
    }
)

// review R5 and the narrow guard: the stored report and acknowledgment are never changed or removed, no other path stores a report,
// and closed work takes a new report through the store alone; the agent's send goes to the customer and is filed on the case
feature("the stored report is kept; closed work takes a report only through the store; the agent's send is filed on the case", {
    when() {
        const {requestId, assetMaintenanceId, workEffortId} = state.charged
        const stored = rows("mantle.work.effort.WorkEffortContent", {
            workEffortId,
            contentTypeEnumId: "WectInterventionReport"
        })[0]
        const W2 = "mantle.work.WorkEffortServices."
        const changed = run(state.supervisor, W2 + "update#WorkEffortContent", {
            workEffortContentId: stored.workEffortContentId,
            description: "Changed"
        })
        const removed = run(state.supervisor, "delete#mantle.work.effort.WorkEffortContent", {
            workEffortContentId: stored.workEffortContentId
        })
        const forged = run(state.supervisor, "create#mantle.work.effort.WorkEffortContent", {
            workEffortId,
            contentTypeEnumId: "WectInterventionReport",
            contentLocation: "dbresource://spec/forged.html"
        })
        const closed = run(state.supervisor, M + "transition#MaintenanceWorkOrder", {workEffortId, action: "close"})
        const plainFile = run(state.supervisor, "create#mantle.work.effort.WorkEffortContent", {
            workEffortId,
            contentTypeEnumId: "WectAttachment",
            contentLocation: "dbresource://spec/late.txt"
        })
        const storedAgain = run(state.tech, M + "store#InterventionReport", {workEffortId})
        capture.enable()
        capture.clear()
        const sent = run(state.agent, W + "send#InterventionReport", {
            requestId,
            assetMaintenanceId,
            toAddress: "Service@Managed-Repair-Customer.example",
            operationKey: prefix + "-send-ok"
        })
        // filed once the send commits, on a service worker
        const end = Date.now() + 5000
        let filed = 0
        while (sent.emailMessageId && !filed && Date.now() < end)
            filed = rows("mantle.request.RequestCommEvent", {requestId}).length
        const mail = capture.getMessages().find(row => row.toList.includes("service@managed-repair-customer.example")) || null
        return {stored, changed, removed, forged, closed, plainFile, storedAgain, sent, filed, mail, workEffortId}
    },
    then({stored, changed, removed, forged, closed, plainFile, storedAgain, sent, filed, mail, workEffortId}) {
        code(changed) == "EVIDENCE_PROTECTED"
        code(removed) == "EVIDENCE_PROTECTED"
        one("mantle.work.effort.WorkEffortContent", {workEffortContentId: stored.workEffortContentId}) != null
        code(forged) == "EVIDENCE_PROTECTED"
        closed.error == ""
        code(plainFile) == "WORK_CLOSED"
        storedAgain.error == ""
        sent.error == ""
        sent.workEffortContentId == storedAgain.workEffortContentId
        filed > 0
        mail != null
        mail.attachmentNames.some(name => name.startsWith("InterventionReport-" + workEffortId))
    }
})

// review R3, R4: a customer's unit away from the organization's facilities records no outage and takes no follow-up here (named
// refusals, the completion itself not refused), a customer's unit is not issued as a spare, a held repair resumes only while its
// claim allows it, and a closed case stops Start
feature("a customer's unit away records no outage and is no spare; a resume and a Start recheck the claim", {
    when() {
        const {workEffortId} = state.covered
        const transition = (fields, username = state.tech) =>
            run(username, M + "transition#MaintenanceWorkOrder", Object.assign({workEffortId}, fields))
        const offline = transition({action: "start", offlineIntent: "Y"})
        const spare = run(state.tech, "mantle.work.MaintenanceExecutionServices.issue#MaintenanceMaterial", {
            operationKey: prefix + "-spare",
            workEffortId,
            productId: product,
            assetId: prefix + "_ASSET_1002",
            quantity: 1
        })
        const started = transition({action: "start"})
        const held = transition({action: "hold", holdReasonEnumId: "MhrParts"}, state.supervisor)
        // Customer Service rejects the claim on a new look: the held repair does not resume
        decide(state.covered.requestId, {decisionEnumId: "WdRejected", reason: "Misuse"})
        const resumeRefused = transition({action: "resume"})
        decide(state.covered.requestId, {decisionEnumId: "WdCovered"})
        const resumed = transition({action: "resume"})
        const finish = {action: "complete", outcomeEnumId: "MoutNotRepaired", dispositionEnumId: "MdispUnavailable"}
        const followUp = transition(Object.assign({followUpName: "Order the board"}, finish))
        const completed = transition(finish)
        const outages = rows("mantle.work.effort.ResourceUnavailability", {assetId: prefix + "_ASSET_1002"}).length
        // a repair of a case closed before its work started
        const requestId = claim("1004", "Heater fan stops")
        decide(requestId, {decisionEnumId: "WdCovered"})
        const linked = run(state.agent, W + "link#WarrantyWork", {requestId, comments: "Fan", assigneePartyId: state.tech})
        const caseClosed = run(state.agent, "mantle.request.SupportCaseServices.transition#Case", {
            requestId,
            toStatusId: "ReqCompleted",
            resolutionEnumId: "RrFixed"
        })
        const startClosed = run(state.tech, M + "transition#MaintenanceWorkOrder", {
            workEffortId: linked.workEffortId,
            action: "start"
        })
        return {offline, spare, started, held, resumeRefused, resumed, followUp, completed, outages, caseClosed, startClosed}
    },
    then({offline, spare, started, held, resumeRefused, resumed, followUp, completed, outages, caseClosed, startClosed}) {
        code(offline) == "CUSTOMER_EQUIPMENT"
        code(spare) == "NOT_STOCK" || code(spare) == "OWNER_MISMATCH"
        started.error == ""
        held.error == ""
        code(resumeRefused) == "NOT_APPROVED"
        resumed.error == ""
        code(followUp) == "CUSTOMER_EQUIPMENT"
        completed.error == ""
        work(state.covered.workEffortId).statusId != "WeInProgress"
        outages == 0
        caseClosed.error == ""
        code(startClosed) == "CASE_CLOSED"
    }
})
