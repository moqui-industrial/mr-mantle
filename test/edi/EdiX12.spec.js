// X12 EDI (plan/payments-shipping-edi.md E1; EdiServices.xml, X12.js and X12Documents.js) on the sample X12 4010 profile,
// with a REST transport answered by the HTTP fixtures: an 850 received as one placed sales order and acknowledged by a
// 997, the 855, 856 and 810 sent after the order's approval, its shipment and its invoice and accepted by the partner's
// 997s (never acknowledged back), duplicate deliveries, a conflicting purchase order, rejected and malformed input,
// several groups and sets with a bad one among good ones, an unsupported version, refusals instead of dropped data,
// and the outbound lifecycle across a rollback, a crash after the commit and a failed send. The parser's structure checks
// and the SFTP poller's per-file isolation have Rust tests in crates/moqui-core. New spec; mantle-edi had none.
const S = "mantle.edi.EdiServices."
const org = "EDI_ORG",
    partner = "EDI_CUST",
    store = "EDI_STORE",
    facility = "EDI_FAC",
    remote = "EDI_PARTNER_T",
    profile = "X12_4010_SAMPLE"
const SENDER = "EDIRETAILER",
    RECEIVER = "EDISUPPLIER"
const URL = "https://edi.example.test/x12/in"
const UPC_B = "012345678905"
const SSCC = "000123456789012343"
const http = ec.factory.getTool("HttpFixtures")
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const since = "2000-01-01T00:00:00Z"

// ---- X12 text as the partner sends it ----

let interchangeSeq = 700
const pad = (value, width) => String(value).padEnd(width, " ")
function isa(control, o = {}) {
    return [
        "ISA",
        "00",
        pad("", 10),
        "00",
        pad("", 10),
        "ZZ",
        pad(o.sender || SENDER, 15),
        "ZZ",
        pad(RECEIVER, 15),
        "261102",
        "1200",
        "U",
        o.isaVersion || "00401",
        control,
        "0",
        o.usage || "T",
        ">"
    ].join("*")
}
// An interchange of groups ({fid, sets, version, control, count, noTrailer}), each set a list of segments.
function interchange(groups, o = {}) {
    const control = o.control || String(++interchangeSeq).padStart(9, "0")
    const segments = [isa(control, o)]
    groups.forEach((group, index) => {
        const gc = group.control || String(interchangeSeq) + (index + 1)
        segments.push(
            ["GS", group.fid || "PO", SENDER, RECEIVER, "20261102", "1200", gc, "X", group.version || "004010"].join("*")
        )
        for (const set of group.sets) segments.push(...set)
        if (!group.noTrailer) segments.push(["GE", group.count ?? group.sets.length, gc].join("*"))
    })
    segments.push(["IEA", o.groupCount ?? groups.length, o.ieaControl || control].join("*"))
    return segments.map(segment => segment + "~").join("\n") + "\n"
}
function txSet(set, control, body) {
    const segments = ["ST*" + set + "*" + control, ...body]
    segments.push("SE*" + (segments.length + 1) + "*" + control)
    return segments
}
// An 850: lines {id, qty, price, ids: [qualifier, id, ...], sac}, header SACs, a ship-to code; CTT and AMT*TT computed
// unless given.
function po(control, poNumber, lines, o = {}) {
    const body = ["BEG*00*" + (o.type || "SA") + "*" + poNumber + "**20261101"]
    if (o.cur !== false) body.push("CUR*BY*" + (o.currency || "USD"))
    let total = 0
    for (const sac of o.sacs || []) {
        body.push(sac)
        const parts = sac.split("*")
        total += ((parts[1] === "A" ? -1 : 1) * Number(parts[5] || 0)) / 100
    }
    body.push("DTM*002*20261115")
    body.push("N1*ST*Store 42*92*" + (o.shipTo || "0042"))
    let quantity = 0
    for (const line of lines) {
        body.push(["PO1", line.id, line.qty, line.uom || "EA", line.price, "PE", ...line.ids].join("*"))
        if (line.sac) body.push(line.sac)
        quantity += line.qty
        total += line.qty * line.price
    }
    for (const extra of o.extra || []) body.push(extra)
    body.push("CTT*" + (o.ctt ?? lines.length) + "*" + quantity)
    body.push("AMT*TT*" + (o.amount ?? Math.round(total * 100) / 100))
    return txSet("850", control, body)
}
const lineA = qty => ({id: "1", qty, price: 10, ids: ["VN", "EDI_A", "BP", "BUYER-A"]})
const lineB = qty => ({id: "2", qty, price: 25.5, ids: ["UP", UPC_B]})
// A 997 the partner sends for groups this side sent: [{fid, control, sets: [[set, control, code]]}].
function ack(groups) {
    return interchange(
        groups.map(group => ({
            fid: "FA",
            sets: [
                txSet("997", "0001", [
                    "AK1*" + group.fid + "*" + group.control,
                    ...group.sets.flatMap(([set, control, code]) => ["AK2*" + set + "*" + control, "AK5*" + code]),
                    "AK9*" + (group.code || "A") + "*" + group.sets.length + "*" + group.sets.length + "*" + group.sets.length
                ])
            ]
        }))
    )
}

// ---- receiving and sending ----

// The receipt as the endpoint or the SFTP poll makes it, consumed as consume#ReceivedSystemMessage does.
function receive(messageText, remoteId = remote) {
    const out = call(S + "receive#X12Interchange", {systemMessageTypeId: "EdiX12", systemMessageRemoteId: remoteId, messageText})
    for (const systemMessageId of out.systemMessageIdList || [])
        call("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {systemMessageId})
    return {systemMessageId: (out.systemMessageIdList || [])[0], duplicateOfId: out.duplicateOfId}
}
const interchangesOf = systemMessageId => rows("mantle.edi.EdiInterchange", {systemMessageId, directionEnumId: "EdiDirIn"})
const documentsOf = systemMessageId =>
    rows("mantle.edi.EdiDocument", {systemMessageId, directionEnumId: "EdiDirIn"}).sort((a, b) =>
        a.ediDocumentId.localeCompare(b.ediDocumentId)
    )
const outbound = (conditions = {}) =>
    rows("mantle.edi.EdiDocument", Object.assign({directionEnumId: "EdiDirOut"}, conditions)).sort((a, b) =>
        a.ediDocumentId.localeCompare(b.ediDocumentId)
    )
// Send what is pending, and the X12 posted for it.
function sendAll() {
    const before = http.count()
    const out = call(S + "send#PendingDocuments", {})
    return {
        out,
        posted: http
            .requests()
            .slice(before)
            .map(request => request.body)
    }
}
const messageOf = systemMessageId => one("moqui.service.message.SystemMessage", {systemMessageId})
const ackOfGroup = doc => outbound({ackedInterchangeId: doc.ediInterchangeId, ackedGroupSeqId: doc.groupSeqId})
const orderOf = doc => (doc.orderId ? one("mantle.order.OrderHeader", {orderId: doc.orderId}) : null)
const itemsOf = orderId =>
    rows("mantle.order.OrderItem", {orderId}).sort((a, b) => a.orderItemSeqId.localeCompare(b.orderItemSeqId))
// An order part's products packed in one box with an SSCC and shipped; the invoice is finalized at ship.
function shipOrder(orderId, sscc = SSCC) {
    const part = rows("mantle.order.OrderPart", {orderId})[0]
    const shipmentId = call("mantle.shipment.ShipmentServices.create#OrderPartShipment", {
        orderId,
        orderPartSeqId: part.orderPartSeqId
    }).shipmentId
    const shipmentPackageSeqId = call("mantle.shipment.ShipmentServices.create#ShipmentPackage", {
        shipmentId,
        weight: 3,
        weightUomId: "WT_lb"
    }).shipmentPackageSeqId
    for (const item of itemsOf(orderId).filter(row => row.itemTypeEnumId === "ItemProduct"))
        call("mantle.shipment.ShipmentServices.pack#ShipmentProduct", {
            productId: item.productId,
            quantity: item.quantity,
            shipmentId,
            shipmentPackageSeqId
        })
    call("update#mantle.shipment.ShipmentPackage", {shipmentId, shipmentPackageSeqId, weight: 3, weightUomId: "WT_lb", sscc})
    call("mantle.shipment.ShipmentServices.complete#ShipmentPack", {shipmentId, getLabels: false})
    call("mantle.shipment.ShipmentServices.ship#Shipment", {shipmentId})
    return shipmentId
}
// The error of a service call expected to fail, in a transaction of its own.
function refusal(service, parameters) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// The control numbers of an X12 text sent: ISA13, GS06, ST02.
function controlsOf(textSent) {
    const segments = textSent.split("~")
    const element = (id, position) => (segments.find(segment => segment.startsWith(id + "*")) || "").split("*")[position]
    return {isa: element("ISA", 13), gs: element("GS", 6), st: element("ST", 2)}
}

// The interchange settings of a remote to the spec's partner (its transport the fixtures' URL).
const remoteSettings = usageCode => ({
    sendUrl: URL,
    sendServiceName: "org.moqui.impl.SystemMessageServices.send#SystemMessageRest",
    messageAuthEnumId: "SmatNone",
    usageCode,
    internalIdType: "ZZ",
    internalId: RECEIVER,
    remoteIdType: "ZZ",
    remoteId: SENDER,
    ackRequested: "0",
    segmentTerminator: "~",
    elementSeparator: "*",
    componentDelimiter: ">"
})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const [partyId, roleTypeId] of [
            [org, "OrgInternal"],
            [partner, "Customer"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {
                partyId,
                organizationName: partyId === org ? "EDI Supplier" : "EDI Retailer"
            })
            call("create#mantle.party.PartyRole", {partyId, roleTypeId})
        }
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            organizationPartyId: org,
            sourcePartyId: "DefaultSettings",
            baseCurrencyUomId: "USD"
        })
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId: org,
            filterDate: ec.user.nowTimestamp
        })
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: org, salesInvoiceFinalizedAtShip: "Y"})
        call("create#mantle.facility.Facility", {facilityId: facility, facilityTypeEnumId: "FcTpWarehouse", ownerPartyId: org})
        call("create#mantle.facility.FacilityLocation", {
            facilityId: facility,
            locationSeqId: "PICK1",
            locationTypeEnumId: "FltPick"
        })
        call("create#mantle.party.contact.ContactMech", {contactMechId: "EDI_STORE42", contactMechTypeEnumId: "CmtPostalAddress"})
        call("create#mantle.party.contact.PostalAddress", {
            contactMechId: "EDI_STORE42",
            toName: "Store 42",
            address1: "42 Retail Way",
            city: "Testville",
            postalCode: "84101",
            countryGeoId: "USA"
        })
        call("create#mantle.party.contact.PartyContactMech", {
            partyId: partner,
            contactMechId: "EDI_STORE42",
            contactMechPurposeId: "PostalShippingDest",
            fromDate: since
        })
        call("create#mantle.edi.EdiLocation", {
            partnerPartyId: partner,
            idQualifier: "92",
            idValue: "0042",
            partyId: partner,
            contactMechId: "EDI_STORE42"
        })
        for (const productId of ["EDI_A", "EDI_B"]) {
            call("create#mantle.product.Product", {
                productId,
                productName: productId,
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpInventory",
                amountUomId: "OTH_ea",
                ownerPartyId: org
            })
            call("mantle.product.AssetServices.receive#Asset", {
                productId,
                quantity: 500,
                facilityId: facility,
                locationSeqId: "PICK1",
                ownerPartyId: org,
                assetTypeEnumId: "AstTpInventory",
                acquireCost: 4,
                acquireCostUomId: "USD"
            })
        }
        call("create#mantle.product.ProductIdentification", {productId: "EDI_B", productIdTypeEnumId: "PidtUpca", idValue: UPC_B})
        call("create#mantle.product.store.ProductStore", {
            productStoreId: store,
            storeName: "EDI store",
            organizationPartyId: org,
            inventoryFacilityId: facility,
            defaultCurrencyUomId: "USD"
        })
        call("create#moqui.service.message.SystemMessageRemote", {
            systemMessageRemoteId: remote,
            description: "EDI spec partner, test environment",
            systemMessageTypeId: "EdiX12",
            sendUrl: URL,
            sendServiceName: "org.moqui.impl.SystemMessageServices.send#SystemMessageRest",
            messageAuthEnumId: "SmatNone",
            usageCode: "T",
            internalIdType: "ZZ",
            internalId: RECEIVER,
            remoteIdType: "ZZ",
            remoteId: SENDER,
            internalAppCode: RECEIVER,
            remoteAppCode: SENDER,
            ackRequested: "0",
            segmentTerminator: "~",
            elementSeparator: "*",
            componentDelimiter: ">"
        })
        // an authenticated remote that is not an EDI connection
        call("create#moqui.service.message.SystemMessageRemote", {
            systemMessageRemoteId: "EDI_NOT_CONNECTED",
            description: "EDI spec remote with no connection",
            systemMessageTypeId: "EdiX12"
        })
        // the production environment of the same partner: a control number scope of its own
        call(
            "create#moqui.service.message.SystemMessageRemote",
            Object.assign(
                {
                    systemMessageRemoteId: "EDI_PARTNER_P",
                    description: "EDI spec partner, production",
                    systemMessageTypeId: "EdiX12"
                },
                remoteSettings("P")
            )
        )
        call("create#mantle.edi.EdiConnection", {
            systemMessageRemoteId: "EDI_PARTNER_P",
            ediProfileId: profile,
            productStoreId: store,
            partnerPartyId: partner,
            sendOnCommit: "N"
        })
        // a user who may not retry EDI documents
        call("create#mantle.party.Party", {partyId: "EDI_CLERK", partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: "EDI_CLERK", firstName: "EDI", lastName: "Clerk"})
        call("create#moqui.security.UserAccount", {
            userId: "EDI_CLERK",
            username: "edi.clerk",
            partyId: "EDI_CLERK",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        // batched: the spec sends with send#PendingDocuments, as the job does, except where a feature turns it on
        call("create#mantle.edi.EdiConnection", {
            systemMessageRemoteId: remote,
            ediProfileId: profile,
            productStoreId: store,
            partnerPartyId: partner,
            sendOnCommit: "N"
        })
        http.enable()
        ec.artifactExecution.enableAuthz()
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        http.add({method: "POST", url: URL, status: 200, contentType: "application/json", body: "{}"})
        // what an earlier feature left pending goes now, so each feature sees its own documents
        call(S + "send#PendingDocuments", {})
    },
    cleanup() {
        http.clear()
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    },
    cleanupSpec() {
        // the spec's documents stay; with no endpoint a later job over them sends nothing
        ec.artifactExecution.disableAuthz()
        for (const systemMessageRemoteId of [remote, "EDI_NOT_CONNECTED", "EDI_PARTNER_P"])
            call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId, sendUrl: null})
        ec.artifactExecution.enableAuthz()
        http.reset()
    }
})

feature(
    "an 850 is one placed order, its 997 goes out, the 855, 856 and 810 follow its decision, shipment and invoice and the partner's 997s accept them",
    {
        when() {
            const text = interchange([{sets: [po("0001", "PO-1001", [lineA(5), lineB(2)], {sacs: ["SAC*C*D240***750"]})]}])
            const receipt = receive(text)
            const doc = documentsOf(receipt.systemMessageId)[0]
            const order = orderOf(doc)
            const items = itemsOf(doc.orderId)
            const sent997 = sendAll()

            call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
            const ack855 = outbound({orderId: doc.orderId, transactionSetId: "855"})
            const sent855 = sendAll()

            const shipmentId = shipOrder(doc.orderId)
            const invoiceId = rows("mantle.order.OrderItemBilling", {orderId: doc.orderId})[0]?.invoiceId
            const sentOthers = sendAll()
            const docs = [
                outbound({orderId: doc.orderId, transactionSetId: "855"})[0],
                outbound({shipmentId})[0],
                outbound({invoiceId})[0]
            ]
            const groupsSent = docs.map(row =>
                one("mantle.edi.EdiGroup", {ediInterchangeId: row.ediInterchangeId, groupSeqId: "01"})
            )
            // the partner's 997: one interchange with a group for each document sent
            const reply = receive(
                ack(
                    groupsSent.map((group, index) => ({
                        fid: group.functionalIdCode,
                        control: group.controlNumber,
                        sets: [[docs[index].transactionSetId, docs[index].controlNumber, "A"]]
                    }))
                )
            )
            return {
                receipt,
                doc,
                order,
                items,
                sent997,
                ack855,
                sent855,
                shipmentId,
                invoiceId,
                sentOthers,
                order: orderOf(doc),
                docs: docs.map(row => one("mantle.edi.EdiDocument", {ediDocumentId: row.ediDocumentId})),
                messages: docs.map(row => messageOf(row.systemMessageId)),
                reply: documentsOf(reply.systemMessageId),
                replyAcks: rows("mantle.edi.EdiDocument", {directionEnumId: "EdiDirOut", transactionSetId: "997"}).filter(row =>
                    interchangesOf(reply.systemMessageId).some(ic => ic.ediInterchangeId === row.ackedInterchangeId)
                )
            }
        },
        then(r) {
            messageOf(r.receipt.systemMessageId).statusId == "SmsgConsumed"
            interchangesOf(r.receipt.systemMessageId)[0].statusId == "EdinAccepted"
            r.doc.statusId == "EdocApplied"
            r.doc.businessKey == "PO PO-1001"
            // approved, then completed by its shipment
            r.order.approvedDate != null
            r.order.statusId == "OrderCompleted"
            r.order.salesChannelEnumId == "ScEdi"
            r.order.systemMessageRemoteId == remote
            rows("mantle.order.OrderPart", {orderId: r.doc.orderId})[0].customerPartyId == partner
            rows("mantle.order.OrderPart", {orderId: r.doc.orderId})[0].postalContactMechId == "EDI_STORE42"
            rows("mantle.order.OrderPart", {orderId: r.doc.orderId})[0].otherPartyOrderId == "PO-1001"
            r.items
                .map(item => [item.productId, String(item.quantity), item.externalItemSeqId, item.itemTypeEnumId].join(" "))
                .join(", ") == "EDI_A 5 1 ItemProduct, EDI_B 2 2 ItemProduct,  1  ItemShipping"
            r.items[0].otherPartyProductId == "BUYER-A"
            toDecimal(r.items[2].unitAmount).eq(toDecimal("7.5"))
            r.sent997.posted.length == 1
            r.sent997.posted[0].includes("GS*FA*EDISUPPLIER*EDIRETAILER*")
            r.sent997.posted[0].includes("AK1*PO*")
            r.sent997.posted[0].includes("AK2*850*0001~AK5*A~AK9*A*1*1*1~")
            r.ack855.length == 1
            r.sent855.posted[0].includes("BAK*00*AD*PO-1001*20261101****" + r.doc.orderId + "*")
            r.sent855.posted[0].includes(
                "PO1*1*5*EA*10*PE*VN*EDI_A*BP*BUYER-A~ACK*IA*5*EA~PO1*2*2*EA*25.5*PE*UP*" + UPC_B + "~ACK*IA*2*EA~CTT*2~"
            )
            r.sentOthers.posted.length == 2
            r.sentOthers.posted.some(
                body =>
                    body.includes("BSN*00*" + r.shipmentId + "*") &&
                    body.includes("*0001~HL*1**S~TD1*CTN*1****G*3*LB~") &&
                    body.includes(
                        "N1*ST*EDI Retailer*92*0042~N1*SF*EDI Supplier~HL*2*1*O~PRF*PO-1001***20261101~HL*3*2*P~MAN*GM*" +
                            SSCC +
                            "~HL*4*3*I~LIN*1*VN*EDI_A*BP*BUYER-A~SN1**5*EA~HL*5*3*I~LIN*2*UP*" +
                            UPC_B +
                            "~SN1**2*EA~CTT*5~"
                    )
            )
            r.sentOthers.posted.some(
                body =>
                    body.includes("BIG*") &&
                    body.includes("*" + r.invoiceId + "*20261101*PO-1001~N1*RE*EDI Supplier~N1*ST*EDI Retailer*92*0042~") &&
                    body.includes(
                        "IT1*1*5*EA*10*PE*VN*EDI_A*BP*BUYER-A~IT1*2*2*EA*25.5*PE*UP*" +
                            UPC_B +
                            "~TDS*10850~SAC*C*D240***750~CTT*2~"
                    )
            )
            r.docs.map(row => row.transactionSetId + " " + row.statusId + " " + row.ackCode).join(", ") ==
                "855 EdocAccepted A, 856 EdocAccepted A, 810 EdocAccepted A"
            r.messages.every(message => message.statusId == "SmsgConfirmed")
            r.reply.length == 3
            r.reply.every(row => row.statusId == "EdocApplied")
            // acknowledgments are never acknowledged
            r.replyAcks.length == 0
        }
    }
)

feature(
    "the same bytes again are one receipt; the same purchase order under new controls is a Duplicate and makes no second order",
    {
        when() {
            const text = interchange([{sets: [po("0001", "PO-2001", [lineA(1)])]}])
            const first = receive(text)
            const again = receive(text)
            const resent = receive(interchange([{sets: [po("0007", "PO-2001", [lineA(1)])]}]))
            const firstDoc = documentsOf(first.systemMessageId)[0]
            // consuming the receipt again (an operator's reset after a crash) resumes from its records and repeats nothing
            call(S + "consume#X12Interchange", {systemMessageId: first.systemMessageId})
            const resumed = {
                interchanges: interchangesOf(first.systemMessageId).length,
                documents: documentsOf(first.systemMessageId).length
            }
            return {first, again, firstDoc, resumed, resentDoc: documentsOf(resent.systemMessageId)[0], acks: sendAll()}
        },
        then({first, again, firstDoc, resumed, resentDoc, acks}) {
            resumed.interchanges == 1
            resumed.documents == 1
            again.systemMessageId == null
            again.duplicateOfId == first.systemMessageId
            firstDoc.statusId == "EdocApplied"
            resentDoc.statusId == "EdocDuplicate"
            resentDoc.orderId == firstDoc.orderId
            resentDoc.duplicateOfDocumentId == firstDoc.ediDocumentId
            rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-2001"}).length == 1
            // both deliveries are acknowledged as received
            acks.posted.length == 2
        }
    }
)

feature("the same purchase order with changed content is a Conflict for review; the order stays as it was", {
    when() {
        const first = documentsOf(receive(interchange([{sets: [po("0001", "PO-3001", [lineA(4)])]}])).systemMessageId)[0]
        const changed = documentsOf(receive(interchange([{sets: [po("0002", "PO-3001", [lineA(9)])]}])).systemMessageId)[0]
        return {first, changed, items: itemsOf(first.orderId)}
    },
    then({first, changed, items}) {
        first.statusId == "EdocApplied"
        changed.statusId == "EdocConflict"
        changed.reasonCode == "PO_CONFLICT"
        changed.duplicateOfDocumentId == first.ediDocumentId
        changed.errorText.includes("review")
        items.length == 1
        String(items[0].quantity) == "4"
    }
})

feature("a document with an invalid code and wrong totals is Rejected with its AK3 and AK4 in the 997, and no order is made", {
    when() {
        const bad = po("0001", "PO-4001", [lineA(2)], {ctt: 5, amount: 99}).map(segment =>
            segment.startsWith("BEG*") ? segment.replace("BEG*00*", "BEG*05*") : segment
        )
        const receipt = receive(interchange([{sets: [bad]}]))
        const doc = documentsOf(receipt.systemMessageId)[0]
        return {doc, acks: sendAll(), orders: rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-4001"})}
    },
    then({doc, acks, orders}) {
        doc.statusId == "EdocRejected"
        doc.reasonCode == "SYNTAX_ERRORS"
        orders.length == 0
        acks.posted.length == 1
        acks.posted[0].includes("AK2*850*0001~AK3*BEG*2**8~AK4*1**7*05~AK3*CTT*7**8~AK4*1**7*5~AK3*AMT*8**8~AK4*2**7*99~")
        acks.posted[0].includes("AK5*R*5~AK9*R*1*1*0~")
    }
})

feature("malformed input is kept and quarantined: not X12, another sender, an IEA control or count that does not match", {
    when() {
        const out = {}
        for (const [name, text] of [
            ["notX12", "this is not an interchange"],
            ["sender", interchange([{sets: [po("0001", "PO-5001", [lineA(1)])]}], {sender: "SOMEONEELSE"})],
            ["iea", interchange([{sets: [po("0001", "PO-5002", [lineA(1)])]}], {ieaControl: "000000001"})],
            ["count", interchange([{sets: [po("0001", "PO-5003", [lineA(1)])]}], {groupCount: 3})],
            ["unconnected", interchange([{sets: [po("0001", "PO-5004", [lineA(1)])]}])]
        ]) {
            const receipt = receive(text, name === "unconnected" ? "EDI_NOT_CONNECTED" : remote)
            out[name] = {
                message: messageOf(receipt.systemMessageId),
                interchanges: interchangesOf(receipt.systemMessageId),
                documents: documentsOf(receipt.systemMessageId)
            }
        }
        out.errors = rows("moqui.service.message.SystemMessageError", {systemMessageId: out.sender.message.systemMessageId})
        out.orders = rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-5001"})
        return out
    },
    then(r) {
        r.notX12.message.messageText == "this is not an interchange"
        r.notX12.message.statusId == "SmsgError"
        r.notX12.interchanges[0].statusId == "EdinQuarantined"
        r.notX12.interchanges[0].reasonCode == "NOT_X12"
        r.sender.interchanges[0].reasonCode == "SENDER_UNKNOWN"
        r.sender.interchanges[0].interchangeText.startsWith("ISA*00*")
        r.sender.documents.length == 0
        r.iea.interchanges[0].reasonCode == "CONTROL_MISMATCH"
        r.count.interchanges[0].reasonCode == "COUNT_MISMATCH"
        // routed by the connection it came on: the payload's IDs do not pick an organization
        r.unconnected.interchanges[0].reasonCode == "CONNECTION_UNKNOWN"
        rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-5004"}).length == 0
        r.errors[0].errorText.includes("SENDER_UNKNOWN")
        r.orders.length == 0
    }
})

feature(
    "two groups with several sets: a bad set among good ones is rejected alone, an unknown item is an exception, and each group gets its 997",
    {
        when() {
            const text = interchange([
                {
                    sets: [
                        po("0001", "PO-6001", [lineA(1)]),
                        po("0002", "PO-6002", [lineB(3)]).map(segment => (segment.startsWith("SE*") ? "SE*99*0002" : segment))
                    ]
                },
                {
                    sets: [
                        po("0001", "PO-6003", [lineA(2)]),
                        po("0002", "PO-6004", [{id: "1", qty: 1, price: 1, ids: ["VN", "NO_SUCH"]}])
                    ]
                }
            ])
            const receipt = receive(text)
            return {
                docs: documentsOf(receipt.systemMessageId),
                groups: rows("mantle.edi.EdiGroup", {
                    ediInterchangeId: interchangesOf(receipt.systemMessageId)[0].ediInterchangeId
                }),
                acks: sendAll()
            }
        },
        then({docs, groups, acks}) {
            docs.map(doc => doc.statusId + " " + (doc.reasonCode || "")).join(", ") ==
                "EdocApplied , EdocRejected COUNT_MISMATCH, EdocApplied , EdocException ITEM_UNKNOWN"
            groups.map(group => group.ackCode + group.acceptedCount).join(",") == "P1,A2"
            acks.posted.length == 2
            acks.posted.some(body => body.includes("AK2*850*0001~AK5*A~AK2*850*0002~AK5*R*4~AK9*P*2*2*1~"))
            // a business refusal is not a syntax error: the 997 accepts it, the exception is for an operator
            acks.posted.some(body => body.includes("AK2*850*0001~AK5*A~AK2*850*0002~AK5*A~AK9*A*2*2*2~"))
            docs[3].errorText.includes("NO_SUCH")
        }
    }
)

feature("an unsupported version is rejected visibly: the group's 997 says AK905 2 and nothing is applied", {
    when() {
        const receipt = receive(interchange([{version: "005010", sets: [po("0001", "PO-7001", [lineA(1)])]}]))
        return {
            docs: documentsOf(receipt.systemMessageId),
            acks: sendAll(),
            orders: rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-7001"})
        }
    },
    then({docs, acks, orders}) {
        docs[0].statusId == "EdocRejected"
        docs[0].reasonCode == "UNSUPPORTED_VERSION"
        orders.length == 0
        acks.posted[0].includes("~AK1*PO*")
        acks.posted[0].includes("~AK9*R*1*1*0*2~")
        !acks.posted[0].includes("AK2*")
    }
})

feature(
    "a rollback records nothing to send; a document recorded and not sent is sent by the job; a failed send is sent again with the same controls",
    {
        when() {
            const doc = documentsOf(receive(interchange([{sets: [po("0001", "PO-8001", [lineA(1)])]}])).systemMessageId)[0]
            sendAll()
            // the approval's transaction rolls back after its 855 was recorded: nothing is left to send
            let rolledBack = ""
            try {
                parallel(
                    1,
                    (thread, a) => {
                        login("john.doe")
                        ec.artifactExecution.disableAuthz()
                        call("mantle.order.OrderServices.approve#Order", {orderId: a.orderId})
                        throw new Error("the business transaction fails after the approval")
                    },
                    {orderId: doc.orderId}
                )
            } catch (error) {
                rolledBack = String(error.message || error)
            }
            const afterRollback = {
                order: orderOf(doc),
                documents: outbound({orderId: doc.orderId}),
                messages: rows("moqui.service.message.SystemMessage", {orderId: doc.orderId, isOutgoing: "Y"})
            }
            // committed with the connection batching: as after a crash right after the commit, the job sends it
            call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
            const recorded = outbound({orderId: doc.orderId})
            // the transport fails: the document stays Produced with its controls and message, and the next run sends the same bytes
            http.clear()
            http.add({method: "POST", url: URL, error: "connection reset"})
            const failed = sendAll()
            const produced = outbound({orderId: doc.orderId})[0]
            const firstText = messageOf(produced.systemMessageId).messageText
            http.clear()
            http.add({method: "POST", url: URL, status: 200, contentType: "application/json", body: "{}"})
            const resent = sendAll()
            const interchangeControl = one("mantle.edi.EdiInterchange", {
                ediInterchangeId: produced.ediInterchangeId
            }).controlNumber
            const final = outbound({orderId: doc.orderId})
            const notDue = call(S + "find#OverdueAcknowledgments", {systemMessageRemoteId: remote}).overdueList
            call("update#mantle.edi.EdiProfile", {ediProfileId: profile, ackOverdueMinutes: 0})
            let overdue
            try {
                overdue = call(S + "find#OverdueAcknowledgments", {systemMessageRemoteId: remote}).overdueList
            } finally {
                call("update#mantle.edi.EdiProfile", {ediProfileId: profile, ackOverdueMinutes: 1440})
            }
            return {
                rolledBack,
                afterRollback,
                recorded,
                failed,
                produced,
                firstText,
                resent,
                interchangeControl,
                final,
                notDue,
                overdue
            }
        },
        then(r) {
            r.rolledBack.includes("fails after the approval")
            r.afterRollback.order.statusId == "OrderPlaced"
            r.afterRollback.documents.length == 0
            r.afterRollback.messages.length == 0
            r.recorded.length == 1
            r.recorded[0].statusId == "EdocPending"
            r.recorded[0].documentRevision == 1
            r.failed.out.sentCount == 0
            r.produced.statusId == "EdocProduced"
            r.resent.posted.length == 1
            r.resent.posted[0] == r.firstText
            controlsOf(r.resent.posted[0]).isa == r.interchangeControl
            controlsOf(r.resent.posted[0]).st == r.produced.controlNumber
            r.final[0].statusId == "EdocSent"
            r.final.length == 1
            // not answered yet: due only after the profile's day, overdue once its time is past
            !r.notDue.some(row => row.ediDocumentId == r.final[0].ediDocumentId)
            r.overdue.some(row => row.ediDocumentId == r.final[0].ediDocumentId)
        }
    }
)

feature("unsupported data is refused, not dropped; a refused document is retried with its identity after the fix", {
    when() {
        const out = {}
        out.percent = documentsOf(
            receive(interchange([{sets: [po("0001", "PO-9001", [lineA(1)], {sacs: ["SAC*A*C310***0*3*10*****02"]})]}]))
                .systemMessageId
        )[0]
        out.shipTo = documentsOf(
            receive(interchange([{sets: [po("0002", "PO-9002", [lineA(1)], {shipTo: "9999"})]}])).systemMessageId
        )[0]
        out.segment = documentsOf(
            receive(interchange([{sets: [po("0003", "PO-9003", [lineA(1)], {extra: ["SCH*1*EA****002*20261120"]}).map(s => s)]}]))
                .systemMessageId
        )[0]
        // an 856 for a package with no SSCC under a profile that requires them, then the SSCC added and retried
        const doc = documentsOf(receive(interchange([{sets: [po("0004", "PO-9004", [lineA(2)])]}])).systemMessageId)[0]
        call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
        const shipmentId = shipOrder(doc.orderId, null)
        call("update#mantle.edi.EdiProfile", {ediProfileId: profile, requireSscc: "Y"})
        try {
            sendAll()
            out.refused = outbound({shipmentId})[0]
            const pkg = rows("mantle.shipment.ShipmentPackage", {shipmentId})[0]
            call("update#mantle.shipment.ShipmentPackage", {
                shipmentId,
                shipmentPackageSeqId: pkg.shipmentPackageSeqId,
                sscc: SSCC
            })
            out.retried = call(S + "retry#Document", {ediDocumentId: out.refused.ediDocumentId})
            out.afterRetry = one("mantle.edi.EdiDocument", {ediDocumentId: out.refused.ediDocumentId})
        } finally {
            call("update#mantle.edi.EdiProfile", {ediProfileId: profile, requireSscc: "N"})
        }
        // an invoice charge the profile has no SAC code for is refused, so its amount is not dropped
        const invoiceId = rows("mantle.order.OrderItemBilling", {orderId: doc.orderId})[0].invoiceId
        const invoiceDoc = outbound({invoiceId})[0]
        call("delete#mantle.edi.EdiProfileCode", {ediProfileId: profile, codeTypeEnumId: "EdctCharge", ediCode: "D240"})
        try {
            call("create#mantle.account.invoice.InvoiceItem", {
                invoiceId,
                invoiceItemSeqId: "90",
                itemTypeEnumId: "ItemShipping",
                quantity: 1,
                amount: 4,
                description: "Freight"
            })
            out.unmapped = refusal("mantle.edi.account.X12InvoiceServices.produce#Invoice", {
                ediDocumentId: invoiceDoc.ediDocumentId
            })
        } finally {
            call("create#mantle.edi.EdiProfileCode", {
                ediProfileId: profile,
                codeTypeEnumId: "EdctCharge",
                ediCode: "D240",
                ediQualifier: "C",
                internalValue: "ItemShipping",
                description: "Freight"
            })
        }
        return out
    },
    then(r) {
        r.percent.statusId == "EdocException"
        r.percent.reasonCode == "SAC_UNSUPPORTED"
        r.shipTo.reasonCode == "SHIP_TO_UNKNOWN"
        r.segment.reasonCode == "UNSUPPORTED_SEGMENT"
        r.refused.statusId == "EdocRefused"
        r.refused.reasonCode == "SSCC_MISSING"
        r.refused.systemMessageId == null
        r.retried.statusId == "EdocSent"
        r.afterRetry.ediDocumentId == r.refused.ediDocumentId
        r.afterRetry.documentRevision == r.refused.documentRevision
        r.unmapped.includes("CHARGE_UNSUPPORTED")
    }
})

feature("an 855 reports a changed quantity and a cancelled line (AC with IQ and IR); a cancelled order is RD", {
    when() {
        const doc = documentsOf(receive(interchange([{sets: [po("0001", "PO-9101", [lineA(6), lineB(2)])]}])).systemMessageId)[0]
        const items = itemsOf(doc.orderId)
        call("mantle.order.OrderServices.update#OrderItem", {
            orderId: doc.orderId,
            orderItemSeqId: items[0].orderItemSeqId,
            quantity: 4,
            unitAmount: 10
        })
        call("mantle.order.OrderServices.cancel#OrderItem", {orderId: doc.orderId, orderItemSeqId: items[1].orderItemSeqId})
        call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
        const changed = sendAll().posted.find(body => body.includes("BAK*"))
        const other = documentsOf(receive(interchange([{sets: [po("0002", "PO-9102", [lineA(1)])]}])).systemMessageId)[0]
        call("mantle.order.OrderServices.cancel#Order", {orderId: other.orderId})
        const cancelled = sendAll().posted.find(body => body.includes("BAK*"))
        return {changed, cancelled}
    },
    then({changed, cancelled}) {
        changed.includes("BAK*00*AC*PO-9101*")
        changed.includes("PO1*1*6*EA*10*PE*VN*EDI_A*BP*BUYER-A~ACK*IQ*4*EA~PO1*2*2*EA*25.5*PE*UP*" + UPC_B + "~ACK*IR*0*EA~")
        cancelled.includes("BAK*00*RD*PO-9102*")
        cancelled.includes("ACK*IR*0*EA~")
    }
})

feature("a connection that sends on commit sends the 855 once the approval commits", {
    when() {
        const doc = documentsOf(receive(interchange([{sets: [po("0001", "PO-9201", [lineA(1)])]}])).systemMessageId)[0]
        sendAll()
        call("update#mantle.edi.EdiConnection", {systemMessageRemoteId: remote, sendOnCommit: "Y"})
        try {
            const before = http.count()
            ec.service
                .sync()
                .name("mantle.order.OrderServices.approve#Order")
                .parameters({orderId: doc.orderId})
                .requireNewTransaction(true)
                .call()
            ec.factory.waitWorkerPoolEmpty(100)
            return {
                posted: http
                    .requests()
                    .slice(before)
                    .map(request => request.body),
                docs: outbound({orderId: doc.orderId})
            }
        } finally {
            call("update#mantle.edi.EdiConnection", {systemMessageRemoteId: remote, sendOnCommit: "N"})
        }
    },
    then({posted, docs}) {
        docs.length == 1
        docs[0].statusId == "EdocSent"
        posted.length == 1
        posted[0].includes("BAK*00*AD*PO-9201*")
    }
})

feature("a partner's 997 rejecting a set marks it AckRejected; a 997 of a group never sent is an exception", {
    when() {
        const doc = documentsOf(receive(interchange([{sets: [po("0001", "PO-9301", [lineA(1)])]}])).systemMessageId)[0]
        call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
        sendAll()
        const sent = outbound({orderId: doc.orderId})[0]
        const group = one("mantle.edi.EdiGroup", {ediInterchangeId: sent.ediInterchangeId, groupSeqId: "01"})
        const rejecting = documentsOf(
            receive(ack([{fid: "PR", control: group.controlNumber, code: "R", sets: [["855", sent.controlNumber, "R*5"]]}]))
                .systemMessageId
        )
        const unknown = documentsOf(
            receive(ack([{fid: "PR", control: "987654321", sets: [["855", "0001", "A"]]}])).systemMessageId
        )
        return {
            sent: one("mantle.edi.EdiDocument", {ediDocumentId: sent.ediDocumentId}),
            message: messageOf(sent.systemMessageId),
            rejecting,
            unknown,
            pending: outbound({statusId: "EdocPending"})
        }
    },
    then({sent, message, rejecting, unknown, pending}) {
        sent.statusId == "EdocAckRejected"
        sent.reasonCode == "ACK_REJECTED"
        sent.errorText.includes("AK5 5")
        message.statusId == "SmsgRejected"
        rejecting[0].statusId == "EdocApplied"
        unknown[0].statusId == "EdocException"
        unknown[0].reasonCode == "ACK_UNMATCHED"
        // no 997 answers a 997
        pending.length == 0
    }
})

feature(
    "a quarantined interchange is checked again by retry#Receipt once its connection is fixed; the same bytes resent stay one receipt",
    {
        when() {
            const text = interchange([{sets: [po("0001", "PO-5104", [lineA(1)])]}])
            const first = receive(text, "EDI_NOT_CONNECTED")
            const before = interchangesOf(first.systemMessageId)
            call(
                "update#moqui.service.message.SystemMessageRemote",
                Object.assign({systemMessageRemoteId: "EDI_NOT_CONNECTED"}, remoteSettings("T"))
            )
            call("create#mantle.edi.EdiConnection", {
                systemMessageRemoteId: "EDI_NOT_CONNECTED",
                ediProfileId: profile,
                productStoreId: store,
                partnerPartyId: partner,
                sendOnCommit: "N"
            })
            const resent = receive(text, "EDI_NOT_CONNECTED")
            const retried = call(S + "retry#Receipt", {systemMessageId: first.systemMessageId})
            const again = refusal(S + "retry#Receipt", {systemMessageId: first.systemMessageId})
            return {
                first,
                before,
                resent,
                retried,
                again,
                after: interchangesOf(first.systemMessageId).sort((a, b) => a.ediInterchangeId.localeCompare(b.ediInterchangeId)),
                docs: documentsOf(first.systemMessageId),
                message: messageOf(first.systemMessageId)
            }
        },
        then({first, before, resent, retried, again, after, docs, message}) {
            before.length == 1
            before[0].reasonCode == "CONNECTION_UNKNOWN"
            resent.duplicateOfId == first.systemMessageId
            retried.statusId == "SmsgConsumed"
            after.map(row => row.statusId).join(",") == "EdinSuperseded,EdinAccepted"
            docs.length == 1
            docs[0].statusId == "EdocApplied"
            message.statusId == "SmsgConsumed"
            again.includes("NOT_RETRYABLE")
        }
    }
)

feature("retry#Document needs EDI_ADMIN: refused without it, with the parameters that pass for an administrator", {
    when() {
        const doc = documentsOf(
            receive(interchange([{sets: [po("0001", "PO-9401", [lineA(1)], {shipTo: "0077"})]}])).systemMessageId
        )[0]
        call("create#mantle.edi.EdiLocation", {
            partnerPartyId: partner,
            idQualifier: "92",
            idValue: "0077",
            partyId: partner,
            contactMechId: "EDI_STORE42"
        })
        login("edi.clerk")
        ec.artifactExecution.disableAuthz()
        let denied
        try {
            denied = refusal(S + "retry#Document", {ediDocumentId: doc.ediDocumentId})
        } finally {
            login("john.doe")
            ec.artifactExecution.disableAuthz()
        }
        const afterDenied = one("mantle.edi.EdiDocument", {ediDocumentId: doc.ediDocumentId})
        const allowed = call(S + "retry#Document", {ediDocumentId: doc.ediDocumentId})
        return {doc, denied, afterDenied, allowed, applied: one("mantle.edi.EdiDocument", {ediDocumentId: doc.ediDocumentId})}
    },
    then({doc, denied, afterDenied, allowed, applied}) {
        doc.reasonCode == "SHIP_TO_UNKNOWN"
        denied.includes("PERMISSION_DENIED")
        afterDenied.statusId == "EdocException"
        allowed.statusId == "EdocApplied"
        applied.orderId != null
    }
})

feature("two deliveries of one purchase order at once make one order and a Duplicate", {
    when() {
        const texts = [
            interchange([{sets: [po("0001", "PO-9501", [lineA(3)])]}]),
            interchange([{sets: [po("0002", "PO-9501", [lineA(3)])]}])
        ]
        const ran = parallel(
            2,
            (thread, a) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const out = call("mantle.edi.EdiServices.receive#X12Interchange", {
                    systemMessageTypeId: "EdiX12",
                    systemMessageRemoteId: a.remote,
                    messageText: a.texts[thread]
                })
                for (const systemMessageId of out.systemMessageIdList || [])
                    call("org.moqui.impl.SystemMessageServices.consume#ReceivedSystemMessage", {systemMessageId})
                return (out.systemMessageIdList || [])[0]
            },
            {texts, remote},
            {transaction: false}
        )
        const docs = ran.flatMap(id => documentsOf(id))
        return {
            ran,
            statuses: docs.map(doc => doc.statusId).sort(),
            orderIds: [...new Set(docs.map(doc => doc.orderId))],
            parts: rows("mantle.order.OrderPart", {otherPartyOrderId: "PO-9501"})
        }
    },
    then({ran, statuses, orderIds, parts}) {
        ran.length == 2
        statuses.join(",") == "EdocApplied,EdocDuplicate"
        orderIds.length == 1
        parts.length == 1
    }
})

feature("the first control numbers of a new scope, allocated by two productions at once, are distinct", {
    when() {
        const ids = ["0001", "0002"].map((control, index) => {
            const receipt = receive(
                interchange([{sets: [po(control, "PO-P" + index, [lineA(1)])]}], {usage: "P"}),
                "EDI_PARTNER_P"
            )
            return ackOfGroup(documentsOf(receipt.systemMessageId)[0])[0].ediDocumentId
        })
        const ran = parallel(
            2,
            (thread, a) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                return call("mantle.edi.EdiServices.produce#Document", {ediDocumentId: a.ids[thread]}).statusId
            },
            {ids},
            {transaction: false}
        )
        const docs = ids.map(id => one("mantle.edi.EdiDocument", {ediDocumentId: id}))
        return {
            ran,
            docs,
            controls: docs
                .map(doc => one("mantle.edi.EdiInterchange", {ediInterchangeId: doc.ediInterchangeId}).controlNumber)
                .sort()
        }
    },
    then({ran, docs, controls}) {
        ran.length == 2
        docs.every(doc => doc.statusId == "EdocProduced")
        controls.join(",") == "000000001,000000002"
    }
})

feature("an identifier holding a separator is refused (SEPARATOR_IN_DATA), not altered or sent", {
    when() {
        const doc = documentsOf(
            receive(
                interchange([
                    {sets: [po("0001", "PO-9601", [{id: "1", qty: 1, price: 10, ids: ["VN", "EDI_A", "BP", "AB:12"]}])]}
                ])
            ).systemMessageId
        )[0]
        sendAll()
        call("mantle.order.OrderServices.approve#Order", {orderId: doc.orderId})
        // the connection's component separator is now the colon the buyer's part number holds
        call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: remote, componentDelimiter: ":"})
        try {
            return {sent: sendAll(), ack: outbound({orderId: doc.orderId})[0]}
        } finally {
            call("update#moqui.service.message.SystemMessageRemote", {systemMessageRemoteId: remote, componentDelimiter: ">"})
        }
    },
    then({sent, ack}) {
        ack.statusId == "EdocRefused"
        ack.reasonCode == "SEPARATOR_IN_DATA"
        ack.errorText.includes("AB:12")
        sent.posted.length == 0
    }
})
