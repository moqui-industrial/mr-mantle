// Sales' requests for quote (impl-sales P8; design-sales §5 QuoteRequests and QuoteRequestDetail, §6 the chargeable repair;
// mantle.order.SalesQuoteServices over SalesQuoteRequests.js, SalesAccess.js quoteRequestOf): a mail to the RFQ address delivered
// twice (two rows of one Message-ID) makes one request in the plus-tag team's queue, its sender matched to the account's contact and
// the message on it, never triaged, and a rule owner who makes no quotes files nothing; the team's rep sees it, another team's rep and
// another organization's do not; a quote from two of its three lines with each line linked, the request In progress and not
// completed, the same operation key answering the same quote, a stale revision refused and a second quote later from the third
// line; a decline tells the requester only at the previewed address, with its reason noted; a warranty claim whose decision is a
// chargeable repair becomes a quote carrying none of its diagnosis or fault text, which Customer Service reads back, and a covered
// claim is no source. Standalone: spec-local organizations, teams, users, accounts, products, mail and a claim; the users' services
// run with artifact authorization on under a spec grant of the services, as an app root's grant gives them.
// Run: ./moq test mr-mantle --spec SalesQuoteRequests
const prefix = "SQR"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.order.SalesQuoteServices."
const REQUEST = "mantle.request.Request"
const users = {}
const teams = {}
const ids = {}
const state = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const rowsOf = (entity, values) => Array.from(ec.entity.find(entity).condition(values).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function run(username, verb, parameters, authz) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    if (authz) ec.artifactExecution.enableAuthz()
    else ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(verb.includes(".") ? verb : service + verb)
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
        else ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
// a user's call, authorization on; a mail rule's or job's, authorization off
const as = (username, verb, parameters = {}) => run(username, verb, parameters, true)
const asSystem = (verb, parameters = {}) => run("john.doe", verb, parameters, false)
const code = out => (/^([A-Z][A-Z0-9_]+):/.exec(String(out.refused || "").replace(/^\s*Error:\s*/, "")) || [])[1] || ""

function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: "USD"})
}
function team(kind, organizationPartyId) {
    const partyId = prefix + "_TEAM_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesTeam",
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    return partyId
}
function member(partyId, teamPartyId) {
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    })
}
// a user, agent of the organization, in a spec group holding the permissions and the spec's service grant
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Requests", lastName: kind})
    make("mantle.party.PartyRelationship", {
        fromPartyId: id,
        toPartyId: organizationPartyId,
        relationshipTypeEnumId: "PrtAgent",
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Requests " + kind})
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
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
function email(partyId, address) {
    const contactMechId = prefix + "_EM_" + partyId
    make("mantle.party.contact.ContactMech", {contactMechId, contactMechTypeEnumId: "CmtEmailAddress", infoString: address})
    make("mantle.party.contact.PartyContactMech", {partyId, contactMechId, contactMechPurposeId: "EmailPrimary", fromDate: 0})
}
function mail(emailMessageId, messageId) {
    make("moqui.basic.email.EmailMessage", {
        emailMessageId,
        emailAccountId: prefix + "_MAIL",
        statusId: "ES_RECEIVED",
        subject: "Fwd: Quote for 12 bays and 2 counters",
        bodyText: "Please quote 12 bays, 2 checkout counters and installation, needed by March.",
        fromAddress: "buyer@acme.example",
        fromName: "Avery Buyer",
        toAddresses: "Sales <sales+rfq@quotes-a.example>",
        messageId,
        receivedDate: ec.user.nowTimestamp
    })
}
const listIds = found => Array.from(found.quoteRequestList || []).map(row => row.requestId)
const detail = (username, requestId) => as(username, "get#QuoteRequest", {requestId})
const linkVisible = (username, recordEntityName, recordId) =>
    as(username, "mantle.party.CommunicationServices.get#RecordLinkInfo", {recordEntityName, recordId, checkOnly: true})
        .recordVisible === true

spec({
    stepwise: true,
    setupSpec() {
        system(() => {
            organization(orgA, "Requests A")
            organization(orgB, "Requests B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Requests spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Requests spec services"})
            const grant = (artifactName, nameIsPattern) =>
                make("moqui.security.ArtifactGroupMember", {
                    artifactGroupId: prefix + "_SERVICES",
                    artifactName,
                    artifactTypeEnumId: "AT_SERVICE",
                    nameIsPattern,
                    inheritAuthz: "Y"
                })
            grant("mantle\\.order\\.SalesQuoteServices\\..*", "Y")
            // the record link host, whose RFQ rule (check#QuoteRequestAccess) is Sales' scope
            grant("mantle.party.CommunicationServices.get#RecordLinkInfo", "N")
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            const rep = ["SALES_VIEW", "SALES_QUOTE_EDIT"]
            users.rep = user("rep", orgA, rep)
            users.other = user("other", orgA, rep)
            users.manager = user("manager", orgA, rep.concat(["SALES_TEAM_VIEW", "SALES_TEAM_MANAGE"]))
            users.reader = user("reader", orgA, ["SALES_VIEW"])
            users.repB = user("repb", orgB, rep.concat(["SALES_TEAM_VIEW"]))
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.rep, teams.east)
            member(users.reader, teams.east)
            member(users.other, teams.west)
            make("mantle.party.PartySetting", {
                partyId: teams.east,
                partySettingTypeId: "SalesIntakePlusTag",
                settingValue: "rfq"
            })
            // the account and its contact, whose address the mail comes from
            ids.account = prefix + "_ACC"
            make("mantle.party.Party", {partyId: ids.account, partyTypeEnumId: "PtyOrganization", ownerPartyId: orgA})
            make("mantle.party.Organization", {partyId: ids.account, organizationName: "Acme Stores"})
            make("mantle.party.PartyRole", {partyId: ids.account, roleTypeId: "Customer"})
            ids.contact = prefix + "_CON"
            make("mantle.party.Party", {partyId: ids.contact, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.contact, firstName: "Avery", lastName: "Buyer"})
            make("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtContact",
                fromPartyId: ids.contact,
                toPartyId: ids.account,
                fromDate: 0
            })
            email(ids.contact, "buyer@acme.example")
            // products with the seller's prices
            for (const [key, price] of [
                ["bay", "250"],
                ["counter", "900"],
                ["install", "400"]
            ]) {
                ids[key] = prefix + "_" + key.toUpperCase()
                make("mantle.product.Product", {
                    productId: ids[key],
                    productName: "Product " + key,
                    productTypeEnumId: "PtAsset",
                    ownerPartyId: orgA
                })
                make("mantle.product.ProductPrice", {
                    productId: ids[key],
                    vendorPartyId: orgA,
                    pricePurposeEnumId: "PppPurchase",
                    priceTypeEnumId: "PptCurrent",
                    fromDate: 0,
                    minQuantity: 1,
                    priceUomId: "USD",
                    price
                })
            }
            // the RFQ mailbox (a server that sends nothing) and one mail delivered twice
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: 9,
                smtpStartTls: "N",
                smtpSsl: "N"
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_MAIL",
                ownerPartyId: orgA,
                accountKindEnumId: "EakShared",
                emailServerId: prefix + "_SMTP",
                emailAddress: "sales@quotes-a.example",
                accountName: "Quotes A sales",
                statusId: "EasActive",
                recordFilingEnumId: "ErfLinkedOnly"
            })
            mail(prefix + "_M1", "<rfq-12bays@acme.example>")
            mail(prefix + "_M2", "<RFQ-12BAYS@acme.example>")
            // Projects' triage of organization A takes quote and support requests with no project to the manager
            make("mantle.party.PartySetting", {
                partyId: orgA,
                partySettingTypeId: "ProjIntake",
                settingValue: JSON.stringify({triagePartyId: users.manager, triaged: "RqtQuote,RqtSupport"})
            })
        })
    }
})

feature("a mail to the RFQ address delivered twice makes one request in the team's queue, never triaged", {
    when() {
        const rule = {ruleOwnerUserId: users.manager}
        const first = asSystem("create#QuoteRequestFromEmail", Object.assign({emailMessageId: prefix + "_M1"}, rule))
        const second = asSystem("create#QuoteRequestFromEmail", Object.assign({emailMessageId: prefix + "_M2"}, rule))
        // a rule of an owner who makes no quotes files nothing
        const reader = asSystem("create#QuoteRequestFromEmail", {emailMessageId: prefix + "_M2", ruleOwnerUserId: users.reader})
        state.mailRequest = first.requestId
        const request = one(REQUEST, {requestId: first.requestId})
        const parties = rowsOf("mantle.request.RequestParty", {requestId: first.requestId})
        const roleOf = roleTypeId => parties.find(row => row.roleTypeId === roleTypeId)?.partyId || null
        // Projects' triage would take a support request of A, but not the request for quote
        const support = system(() =>
            call("mantle.request.RequestServices.create#Request", {
                requestName: "Support of A",
                requestTypeEnumId: "RqtSupport",
                statusId: "ReqSubmitted"
            })
        )
        const triaged = requestId =>
            Array.from(asSystem("mantle.request.RequestServices.notify#RequestTriage", {requestId, force: true}).userIdList || [])
        return {
            first,
            second,
            reader,
            request,
            organization: roleOf("OrgInternal"),
            team: roleOf("SalesTeam"),
            customer: roleOf("Customer"),
            contact: roleOf("Contact"),
            filed: rowsOf("mantle.request.RequestEmailMessage", {requestId: first.requestId}).map(row => row.emailMessageId),
            rfqTriaged: triaged(first.requestId),
            supportTriaged: triaged(support.requestId),
            repList: listIds(as(users.rep, "find#QuoteRequests", {})),
            otherList: listIds(as(users.other, "find#QuoteRequests", {})),
            managerList: listIds(as(users.manager, "find#QuoteRequests", {state: "awaiting"})),
            repBList: listIds(as(users.repB, "find#QuoteRequests", {})),
            otherDetail: detail(users.other, first.requestId),
            repDetail: detail(users.rep, first.requestId),
            repLink: linkVisible(users.rep, REQUEST, first.requestId),
            otherLink: linkVisible(users.other, REQUEST, first.requestId)
        }
    },
    then(r) {
        r.first.refused == ""
        r.first.requestId
        r.first.alreadyApplied == false
        r.first.stopProcessing == true
        r.second.requestId == r.first.requestId
        r.second.alreadyApplied == true
        code(r.reader) == "RULE_NOT_ALLOWED"
        r.request.requestTypeEnumId == "RqtQuote"
        r.request.statusId == "ReqSubmitted"
        r.request.requestName == "Quote for 12 bays and 2 counters"
        r.request.salesChannelEnumId == "ScEmail"
        r.organization == orgA
        r.team == teams.east
        // the sender is the account's contact: no party made
        r.customer == ids.account
        r.contact == ids.contact
        r.filed.includes(prefix + "_M1")
        r.rfqTriaged.length == 0
        r.supportTriaged.includes(users.manager)
        r.repList.includes(r.first.requestId)
        !r.otherList.includes(r.first.requestId)
        r.managerList.includes(r.first.requestId)
        !r.repBList.includes(r.first.requestId)
        r.otherDetail.requestFound == false
        r.repDetail.requestFound == true
        r.repDetail.quoteRequest.customerName == "Acme Stores"
        r.repDetail.quoteRequest.sourceText == "Mail"
        r.repLink == true
        r.otherLink == false
    }
})

feature("a rep's request becomes a quote from two of its three lines, linked line by line; the same key makes no second quote", {
    when() {
        const made = as(users.rep, "create#QuoteRequest", {
            customerPartyId: ids.account,
            requestName: "Store refit",
            items: [
                {productId: ids.bay, quantity: "12", description: "Bays, grey"},
                {productId: ids.counter, quantity: "2"},
                {productId: ids.install, quantity: "1"}
            ]
        })
        state.requestId = made.requestId
        const revision = () => detail(users.rep, made.requestId).quoteRequest?.requestRevision
        const before = revision()
        const operationKey = prefix + "-quote-1"
        const quote = as(users.rep, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: before,
            operationKey,
            requestItemSeqIdList: ["01", "02"]
        })
        const again = as(users.rep, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: before,
            operationKey,
            requestItemSeqIdList: ["01", "02"]
        })
        const stale = as(users.rep, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: before,
            operationKey: prefix + "-quote-stale",
            requestItemSeqIdList: ["03"]
        })
        const later = as(users.rep, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: revision(),
            operationKey: prefix + "-quote-2",
            requestItemSeqIdList: ["03"]
        })
        const reader = as(users.reader, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: revision(),
            operationKey: prefix + "-quote-reader",
            requestItemSeqIdList: ["03"]
        })
        const outsider = as(users.repB, "create#QuoteFromRequest", {
            requestId: made.requestId,
            requestRevision: revision(),
            operationKey: prefix + "-quote-outsider",
            requestItemSeqIdList: ["03"]
        })
        const shown = detail(users.rep, made.requestId)
        return {
            made,
            quote,
            again,
            stale,
            later,
            reader,
            outsider,
            links: rowsOf("mantle.request.RequestItemOrder", {requestId: made.requestId}),
            lines: rowsOf("mantle.order.OrderItem", {orderId: quote.orderId}),
            order: one("mantle.order.OrderHeader", {orderId: quote.orderId}),
            statusId: one(REQUEST, {requestId: made.requestId}).statusId,
            shown
        }
    },
    then(r) {
        r.made.refused == ""
        r.quote.refused == ""
        r.quote.orderId
        r.again.orderId == r.quote.orderId
        r.again.alreadyApplied == true
        code(r.stale) == "REVISION_CHANGED"
        r.later.refused == ""
        r.later.orderId != r.quote.orderId
        code(r.reader) == "PERMISSION_DENIED"
        code(r.outsider) == "RECORD_UNAVAILABLE"
        r.order.orderPurposeEnumId == "OrpSalesQuote"
        r.order.orderName == "Store refit"
        r.lines.filter(line => line.itemTypeEnumId === "ItemProduct").length == 2
        r.lines.some(
            line => line.productId === ids.bay && Number(String(line.quantity)) === 12 && line.itemDescription === "Bays, grey"
        )
        r.links
            .filter(link => link.orderId === r.quote.orderId)
            .map(link => link.requestItemSeqId)
            .sort()
            .join() == "01,02"
        r.links
            .filter(link => link.orderId === r.later.orderId)
            .map(link => link.requestItemSeqId)
            .join() == "03"
        // a quote puts it in progress and never completes it
        r.statusId == "ReqInProgress"
        r.shown.quotes.length == 2
        r.shown.items.find(item => item.requestItemSeqId === "01").statusText == "Quoted"
    }
})

feature("a declined request tells its requester only at the address the preview showed, with its reason noted", {
    when() {
        const requestId = state.mailRequest
        const revision = () => detail(users.rep, requestId).quoteRequest?.requestRevision
        const preview = as(users.rep, "preview#QuoteRequestDecline", {requestId})
        const changed = as(users.rep, "decline#QuoteRequest", {
            requestId,
            requestRevision: revision(),
            reason: "Outside our region",
            notify: "Y",
            toAddress: "someone@else.example"
        })
        const reasonless = as(users.rep, "decline#QuoteRequest", {requestId, requestRevision: revision()})
        const declined = as(users.rep, "decline#QuoteRequest", {
            requestId,
            requestRevision: revision(),
            reason: "Outside our region",
            notify: "Y",
            toAddress: preview.toAddress,
            messageText: "Thank you; we cannot quote this one."
        })
        const sent = declined.emailMessageId
            ? one("moqui.basic.email.EmailMessage", {emailMessageId: declined.emailMessageId})
            : null
        return {
            preview,
            changed,
            reasonless,
            declined,
            sent,
            request: one(REQUEST, {requestId}),
            notes: rowsOf("mantle.request.RequestNote", {requestId}).map(row => row.noteText),
            filed: rowsOf("mantle.request.RequestEmailMessage", {requestId}).map(row => row.emailMessageId),
            again: as(users.rep, "decline#QuoteRequest", {requestId, requestRevision: revision(), reason: "Again"})
        }
    },
    then(r) {
        r.preview.canNotify == true
        r.preview.toAddress == "buyer@acme.example"
        r.preview.fromAddress == "sales@quotes-a.example"
        code(r.changed) == "RECIPIENT_CHANGED"
        code(r.reasonless) == "REASON_REQUIRED"
        r.declined.refused == ""
        r.declined.notified == true
        r.sent.toAddresses == "buyer@acme.example"
        r.sent.inReplyTo == "<rfq-12bays@acme.example>"
        r.sent.bodyText == "Thank you; we cannot quote this one."
        r.filed.includes(r.declined.emailMessageId)
        r.request.statusId == "ReqCancelled"
        r.request.requestResolutionEnumId == "RrRejected"
        r.notes.some(note => note.includes("Outside our region"))
        code(r.again) == "REQUEST_CLOSED"
    }
})

feature("a warranty claim's chargeable line becomes a quote without its diagnosis, which Customer Service reads back", {
    when() {
        const claim = (kind, decision) =>
            system(() => {
                const requestId = prefix + "_CLAIM_" + kind
                make(REQUEST, {
                    requestId,
                    requestTypeEnumId: "RqtWarranty",
                    statusId: "ReqSubmitted",
                    requestName: "Counter display dead: water damage",
                    description: "Diagnosis: liquid ingress, not covered",
                    claimRevision: 1
                })
                make("mantle.request.RequestParty", {requestId, partyId: orgA, roleTypeId: "OrgInternal", fromDate: 0})
                make("mantle.request.RequestParty", {requestId, partyId: ids.account, roleTypeId: "Customer", fromDate: 0})
                make("mantle.request.RequestItem", {
                    requestId,
                    requestItemSeqId: "01",
                    productId: ids.counter,
                    quantity: 1,
                    description: "Fault: water damage under the display"
                })
                make(
                    "mantle.request.support.WarrantyDecision",
                    Object.assign(
                        {warrantyDecisionId: requestId + "_D", requestId, sourceRevision: 1, organizationPartyId: orgA},
                        {decisionDate: ec.user.nowTimestamp, reason: "Customer damage"},
                        decision
                    )
                )
                return requestId
            })
        const chargeable = claim("CHARGE", {decisionEnumId: "WdRejected", chargeEstimate: 180, chargeCurrencyUomId: "USD"})
        const covered = claim("COVERED", {decisionEnumId: "WdCovered"})
        const shown = detail(users.rep, chargeable)
        const repairs = listIds(as(users.rep, "find#QuoteRequests", {kind: "repair"}))
        const quote = as(users.rep, "create#QuoteFromRequest", {
            requestId: chargeable,
            requestRevision: shown.quoteRequest?.requestRevision,
            operationKey: prefix + "-repair-1",
            items: [{requestItemSeqId: "01", unitAmount: "180", overrideReason: "Repair charge"}]
        })
        const refused = as(users.rep, "create#QuoteFromRequest", {
            requestId: covered,
            requestRevision: "0",
            operationKey: prefix + "-repair-2",
            requestItemSeqIdList: ["01"]
        })
        const order = one("mantle.order.OrderHeader", {orderId: quote.orderId})
        const lines = rowsOf("mantle.order.OrderItem", {orderId: quote.orderId})
        const quoteRead = as(users.rep, "get#Quote", {orderId: quote.orderId})
        const forService = ec.resource
            .script("component://mr-mantle/service/mantle/order/SalesQuoteRequests.js")
            .quotesOfRequest(chargeable)
        return {
            shown,
            repairs,
            chargeable,
            covered,
            quote,
            refused,
            order,
            lines,
            quoteText: JSON.stringify(quoteRead),
            claim: one(REQUEST, {requestId: chargeable}),
            decisions: rowsOf("mantle.request.support.WarrantyDecision", {requestId: chargeable}),
            forService,
            otherRepairs: listIds(as(users.repB, "find#QuoteRequests", {kind: "repair"}))
        }
    },
    then(r) {
        r.shown.requestFound == true
        r.shown.quoteRequest.repair == true
        r.shown.quoteRequest.description == ""
        r.shown.items[0].description == ""
        !JSON.stringify(r.shown).includes("water damage")
        !JSON.stringify(r.shown).includes("Diagnosis")
        r.repairs.includes(r.chargeable)
        !r.repairs.includes(r.covered)
        !r.otherRepairs.includes(r.chargeable)
        r.quote.refused == ""
        code(r.refused) == "RECORD_UNAVAILABLE"
        r.order.orderName == "Repair estimate"
        r.lines.some(line => line.productId === ids.counter && Number(String(line.unitAmount)) === 180)
        !r.quoteText.includes("water damage")
        !r.quoteText.includes("Diagnosis")
        !r.quoteText.includes("Customer damage")
        // the claim and its decision stay as Customer Service left them
        r.claim.statusId == "ReqSubmitted"
        r.decisions.length == 1
        !r.decisions[0].supersededDate
        r.forService.length == 1
        r.forService[0].orderId == r.quote.orderId
    }
})
