// Customer invoice print, send#Invoice (the frozen PDF, the supporting files sent with it, one message per address),
// process#InvoiceBatch, the store notice beside it, and customer statements.
const helper = () => ec.resource.script("component://mr-mantle/test/ledger/AccountingReceivablesFixtures.js")
const native = (name, p) => helper().call("mantle.account.InvoiceServices." + name, p)
const capture = ec.factory.getTool("MailCapture")
let f, first, sendParameters, invoiceId, issued, selectedContent, extraContent
function file(invoiceId, id, name, bytes) {
    const location = "dbresource://mantle/content/invoice/" + invoiceId + "/content_" + id + "/" + name
    ec.resource.getLocationReference(location).putBytes(bytes)
    helper().call("create#mantle.account.invoice.InvoiceContent", {
        invoiceContentId: id,
        invoiceId,
        contentLocation: location,
        contentTypeEnumId: "IctNote",
        description: name
    })
    return {id, location}
}
function sendRequest(invoice, key, ids = [], versions = {}) {
    return {
        invoiceId: invoice.invoiceId,
        organizationPartyId: f.org,
        operationKey: key,
        sourceVersion: helper().lib.fingerprint(invoice),
        emailTemplateId: f.emailTemplateId,
        toAddresses: "attachments@example.com",
        attachmentContentIdList: ids,
        attachmentVersions: versions
    }
}
function choices(invoiceId, ids = null) {
    return native("get#InvoiceDeliveryAttachments", {invoiceId, organizationPartyId: f.org, attachmentContentIdList: ids})
}
const issuedRows = invoiceId =>
    helper()
        .lib.rows("mantle.account.invoice.InvoiceContent", {invoiceId})
        .filter(row => row.isImmutable == "Y")
spec({
    stepwise: true,
    setupSpec() {
        // the later features build on the frozen PDF: with no Chromium the error skips the spec with its reason
        ec.resource.xslFoTransform("<html><body>Invoice delivery</body></html>", null, null, "application/pdf")
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("NATIVE_SEND")
        capture.enable()
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        capture.reset()
    }
})
feature("the print is Mantle's template over get#InvoicePrintInfo, with the lines and total", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "42")
        const printed = native("get#InvoiceOutput", {invoiceId: invoice.invoiceId, organizationPartyId: f.org})
        login(f.users.ap)
        const denied = helper().rejected("mantle.account.InvoiceServices.get#InvoiceOutput", {invoiceId: invoice.invoiceId})
        return {printed, denied, invoiceId: invoice.invoiceId}
    },
    then({printed, denied, invoiceId}) {
        printed.printHtml.includes("<h1>Invoice " + invoiceId + "</h1>")
        printed.printHtml.includes("Approved consulting")
        printed.printHtml.includes("$42.00")
        printed.printHtml.includes("NATIVE_SEND finance organization")
        printed.summaryText.includes("Total $42.00")
        !!printed.sourceVersion
        denied.includes("PERMISSION_DENIED")
    }
})
feature("send#Invoice finalizes, freezes its PDF and sends each valid address past a bad one", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f)
        invoiceId = invoice.invoiceId
        capture.clear()
        sendParameters = {
            invoiceId,
            organizationPartyId: f.org,
            operationKey: "native-send-first",
            emailTemplateId: f.emailTemplateId,
            toAddresses: "customer@example.com,bad-address",
            note: "Thank you",
            lastUpdatedStamp: invoice.lastUpdatedStamp
        }
        first = native("send#Invoice", sendParameters)
        const stored = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: first.invoiceContentId})
        const pdf = ec.resource.getLocationReference(stored.contentLocation)
        const emails = helper().lib.rows("mantle.account.invoice.InvoiceEmailMessage", {invoiceId})
        return {first, stored, size: pdf.getSize(), message: capture.last(), count: capture.count(), emails}
    },
    then({first, stored, size, message, count, emails}) {
        first.successCount == 1
        first.failureCount == 1
        first.statusId == "InvoiceSent"
        first.recipientResults.some(row => row.recipient == "bad-address" && row.reasonCode == "RECIPIENT_INVALID")
        count == 1
        message.toList.join() == "customer@example.com"
        message.fromAddress == "accounts@native.example"
        message.subject.includes(invoiceId)
        message.body.includes("Thank you")
        message.attachmentNames.join() == "Invoice-" + invoiceId + ".pdf"
        stored.isImmutable == "Y"
        stored.contentLocation.startsWith("dbresource://mantle/content/invoice-issued/" + invoiceId + "/")
        size > 100
        emails.length == 1
        emails[0].emailMessageId == first.recipientResults.find(row => row.status != "failed").emailMessageId
    }
})
feature("the same key and request answer the first result without sending, another request with it is refused", {
    when() {
        login(f.users.ar)
        const before = capture.count()
        const repeated = native("send#Invoice", sendParameters)
        const conflict = helper().rejected(
            "mantle.account.InvoiceServices.send#Invoice",
            Object.assign({}, sendParameters, {toAddresses: "other@example.com"})
        )
        const detail = native("get#InvoiceFinanceDetail", {invoiceId})
        return {before, after: capture.count(), repeated, conflict, detail}
    },
    then({before, after, repeated, conflict, detail}) {
        repeated.alreadyApplied == true
        repeated.statusId == first.statusId
        repeated.invoiceContentId == first.invoiceContentId
        repeated.recipientResults.length == 2
        before == after
        conflict.includes("OPERATION_KEY_CONFLICT")
        detail.deliveryRows.some(row => row.toAddresses == "customer@example.com" && row.emailMessageId)
        detail.contentRows.some(row => row.invoiceContentId == first.invoiceContentId && row.issued && !row.attachable)
    }
})
feature("a stale or unreviewed version is refused before anything is issued or sent", {
    when() {
        login(f.users.ar)
        const results = []
        for (const change of ["header", "line", "stamp", "missing"]) {
            const invoice = helper().draft(f, "20")
            const parameters = sendRequest(invoice, "native-stale-" + change)
            if (change === "header")
                native("store#InvoiceDraft", {
                    invoiceId: invoice.invoiceId,
                    lastUpdatedStamp: invoice.lastUpdatedStamp,
                    referenceNumber: "Changed after review"
                })
            else if (change === "line") {
                const line = helper().lib.rows("mantle.account.invoice.InvoiceItem", {invoiceId: invoice.invoiceId})[0]
                native("store#InvoiceDraftItem", {
                    invoiceId: invoice.invoiceId,
                    invoiceItemSeqId: line.invoiceItemSeqId,
                    lastUpdatedStamp: line.lastUpdatedStamp,
                    amount: "21"
                })
            } else {
                delete parameters.sourceVersion
                if (change === "stamp") parameters.lastUpdatedStamp = 0
            }
            const before = capture.count()
            const refused = helper().rejected("mantle.account.InvoiceServices.send#Invoice", parameters)
            const state = helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId}).statusId
            results.push({refused, sent: capture.count() - before, state, issued: issuedRows(invoice.invoiceId).length})
        }
        return {results}
    },
    then({results}) {
        results[0].refused.includes("STALE_PREVIEW")
        results[1].refused.includes("STALE_PREVIEW")
        results[2].refused.includes("STALE_REVISION")
        results[3].refused.includes("STALE_REVISION")
        results.every(row => row.sent == 0 && row.state == "InvoiceInProcess" && row.issued == 0)
    }
})
feature("an address the mail server does not take stays queued and a retry keeps the one message", {
    when() {
        capture.disable()
        login(f.users.ar)
        const invoice = helper().draft(f)
        const parameters = Object.assign(sendRequest(invoice, "native-queued"), {toAddresses: "outbox@example.com"})
        const queued = native("send#Invoice", parameters)
        const replay = native("send#Invoice", parameters)
        capture.enable()
        return {queued, replay}
    },
    then({queued, replay}) {
        queued.successCount == 1
        queued.statusId == "InvoiceSent"
        queued.recipientResults[0].status == "queued"
        replay.recipientResults[0].emailMessageId == queued.recipientResults[0].emailMessageId
    }
})
feature("supporting file choices carry versions for a sender only", {
    when() {
        const invoice = helper().draft(f, "12")
        file(invoice.invoiceId, "NATIVE_SEND_CHOICE", "Scope.txt", new Uint8Array([83, 99, 111, 112, 101]))
        login(f.users.ar)
        const options = choices(invoice.invoiceId)
        const detail = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        login(f.users.read)
        const denied = helper().rejected("mantle.account.InvoiceServices.get#InvoiceDeliveryAttachments", {
            invoiceId: invoice.invoiceId
        })
        const read = native("get#InvoiceFinanceDetail", {invoiceId: invoice.invoiceId})
        return {options, detail, denied, read}
    },
    then({options, detail, denied, read}) {
        options.attachmentRows.length == 1
        options.attachmentRows[0].fileName == "Scope.txt"
        !!options.attachmentRows[0].attachmentVersion
        options.maxAttachmentCount == 10
        options.maxTotalAttachmentBytes == 20971520
        options.attachmentRows.every(row => row.contentLocation == null)
        detail.contentRows.some(row => row.attachable && row.attachmentVersion)
        denied.includes("PERMISSION_DENIED")
        read.contentRows.every(row => !row.attachmentVersion)
    }
})
feature("the files sent are the bytes reviewed, frozen as immutable copies the source changes do not reach", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "14")
        selectedContent = file(invoice.invoiceId, "NATIVE_SEND_FROZEN", "Evidence.bin", new Uint8Array([0, 255, 128, 10]))
        extraContent = file(invoice.invoiceId, "NATIVE_SEND_EXTRA", "Unselected.txt", new Uint8Array([78, 111]))
        const chosen = choices(invoice.invoiceId).attachmentRows.find(row => row.invoiceContentId == selectedContent.id)
        const parameters = sendRequest(invoice, "native-send-frozen", [chosen.invoiceContentId], {
            [chosen.invoiceContentId]: chosen.attachmentVersion
        })
        parameters.toAddresses = "first@example.com,second@example.com"
        capture.clear()
        issued = native("send#Invoice", parameters)
        const names = capture.getMessages().map(message => message.attachmentNames.join())
        ec.resource.getLocationReference(selectedContent.location).putBytes(new Uint8Array([67, 104, 97, 110, 103, 101]))
        const copy = helper().lib.one("mantle.account.invoice.InvoiceContent", {
            invoiceContentId: issued.attachmentRows[0].invoiceContentId
        })
        const stream = ec.resource.getLocationReference(copy.contentLocation).getInputStream()
        let bytes
        try {
            bytes = StringUtilities.base64Encode(stream.readAllBytes())
        } finally {
            stream.close()
        }
        return {names, copy, bytes, invoiceId: invoice.invoiceId}
    },
    then({names, copy, bytes, invoiceId}) {
        issued.successCount == 2
        names.length == 2
        names.every(text => text == "Invoice-" + invoiceId + ".pdf,Evidence.bin")
        issued.attachmentRows.length == 1
        issued.attachmentRows[0].sourceInvoiceContentId == selectedContent.id
        copy.isImmutable == "Y"
        copy.contentLocation.startsWith("dbresource://mantle/content/invoice-issued/" + invoiceId + "/")
        bytes == StringUtilities.base64Encode(new Uint8Array([0, 255, 128, 10]))
    }
})
feature("a foreign, stale, missing or remote file and the count and size limits refuse before issue", {
    when() {
        login(f.users.ar)
        const invoice = helper().draft(f, "16")
        const other = helper().draft(f, "17")
        const foreign = file(other.invoiceId, "NATIVE_SEND_FOREIGN", "Other.txt", new Uint8Array([79]))
        const local = file(invoice.invoiceId, "NATIVE_SEND_LOCAL", "Local.txt", new Uint8Array([76]))
        const version = choices(invoice.invoiceId, [local.id]).attachmentRows[0].attachmentVersion
        const refuse = (key, ids, versions) =>
            helper().rejected("mantle.account.InvoiceServices.send#Invoice", sendRequest(invoice, key, ids, versions))
        const failures = [refuse("native-attach-foreign", [foreign.id], {[foreign.id]: "reviewed"})]
        ec.resource.getLocationReference(local.location).putBytes(new Uint8Array([76, 50]))
        failures.push(refuse("native-attach-stale", [local.id], {[local.id]: version}))
        ec.resource.getLocationReference(local.location).delete()
        failures.push(refuse("native-attach-missing", [local.id], {[local.id]: version}))
        helper().call("create#mantle.account.invoice.InvoiceContent", {
            invoiceContentId: "NATIVE_SEND_URL",
            invoiceId: invoice.invoiceId,
            contentLocation: "https://example.com/private.pdf"
        })
        failures.push(refuse("native-attach-url", ["NATIVE_SEND_URL"], {NATIVE_SEND_URL: "reviewed"}))
        const ids = Array.from({length: 11}, (_, i) => "NATIVE_SEND_COUNT_" + i)
        failures.push(refuse("native-attach-count", ids, Object.fromEntries(ids.map(id => [id, "reviewed"]))))
        const large = file(invoice.invoiceId, "NATIVE_SEND_LARGE", "Large.bin", new Uint8Array(10485761))
        failures.push(refuse("native-attach-size", [large.id], {[large.id]: "reviewed"}))
        return {failures, stored: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: invoice.invoiceId})}
    },
    then({failures, stored}) {
        failures[0].includes("ATTACHMENT_UNAVAILABLE")
        failures[1].includes("STALE_ATTACHMENT")
        failures[2].includes("ATTACHMENT_UNAVAILABLE")
        failures[3].includes("ATTACHMENT_LOCATION_INVALID")
        failures[4].includes("ATTACHMENT_COUNT_LIMIT")
        failures[5].includes("ATTACHMENT_SIZE_LIMIT")
        stored.statusId == "InvoiceInProcess"
        issuedRows(stored.invoiceId).length == 0
    }
})
feature("an issued file cannot be removed, changed, replaced or aliased, while a supporting file stays editable", {
    when() {
        login(f.users.ar)
        const content = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: issued.invoiceContentId})
        const sentCopy = helper().lib.one("mantle.account.invoice.InvoiceContent", {
            invoiceContentId: issued.attachmentRows[0].invoiceContentId
        })
        const before = ec.resource.digest(content.contentLocation, "sha256")
        const key = {invoiceContentId: content.invoiceContentId}
        const failures = [
            helper().rejected("delete#mantle.account.invoice.InvoiceContent", key),
            helper().rejected("delete#mantle.account.invoice.InvoiceContent", {invoiceContentId: sentCopy.invoiceContentId}),
            helper().rejected(
                "update#mantle.account.invoice.InvoiceContent",
                Object.assign({}, key, {contentLocation: "dbresource://mantle/content/replaced.pdf"})
            ),
            helper().rejected("update#mantle.account.invoice.InvoiceContent", Object.assign({}, key, {isImmutable: "N"})),
            helper().rejected(
                "mantle.account.InvoiceServices.update#InvoiceContent",
                Object.assign({}, key, {contentFile: uploadedFile("Overwrite.txt", "Changed issued file")})
            )
        ]
        for (const [id, location] of [
            ["NATIVE_ALIAS_PDF", content.contentLocation],
            ["NATIVE_ALIAS_COPY", sentCopy.contentLocation.replace("mantle/content/", "mantle//content//")],
            ["NATIVE_ALIAS_PREFIX", "dbresource:" + content.contentLocation.slice("dbresource://".length)]
        ])
            failures.push(
                helper().rejected("create#mantle.account.invoice.InvoiceContent", {
                    invoiceContentId: id,
                    invoiceId: content.invoiceId,
                    contentLocation: location,
                    isImmutable: "N"
                })
            )
        native("update#InvoiceContent", Object.assign({}, key, {description: "Issued PDF as sent"}))
        native("update#InvoiceContent", {
            invoiceContentId: extraContent.id,
            contentFile: uploadedFile("Editable.txt", "Updated supporting file")
        })
        const live = helper().lib.one("mantle.account.invoice.InvoiceContent", {invoiceContentId: extraContent.id})
        const after = helper().lib.one("mantle.account.invoice.InvoiceContent", key)
        return {
            failures,
            same: before == ec.resource.digest(after.contentLocation, "sha256"),
            after,
            updated: ec.resource.getLocationReference(live.contentLocation).getText()
        }
    },
    then({failures, same, after, updated}) {
        failures.length == 8
        failures.every(message => message.includes("ISSUED_INVOICE_IMMUTABLE"))
        same == true
        after.description == "Issued PDF as sent"
        updated == "Updated supporting file"
    }
})
feature("a batch does each invoice on its own, names the stale one and keeps its result", {
    when() {
        login(f.users.ar)
        const good = helper().draft(f),
            stale = helper().draft(f)
        const parameters = {
            organizationPartyId: f.org,
            invoiceIdList: [good.invoiceId, stale.invoiceId],
            action: "finalize",
            operationKey: "native-invoice-batch",
            sourceVersions: {[good.invoiceId]: good.lastUpdatedStamp, [stale.invoiceId]: 0}
        }
        const result = native("process#InvoiceBatch", parameters)
        const replay = native("process#InvoiceBatch", parameters)
        const kept = native("get#InvoiceBatchResult", {organizationPartyId: f.org, operationKey: parameters.operationKey})
        const printed = native("process#InvoiceBatch", {
            organizationPartyId: f.org,
            invoiceIdList: [good.invoiceId],
            action: "print",
            operationKey: "native-invoice-print"
        })
        login(f.users.edit)
        const other = native("get#InvoiceBatchResult", {organizationPartyId: f.org, operationKey: parameters.operationKey})
        return {result, replay, kept, printed, other}
    },
    then({result, replay, kept, printed, other}) {
        result.successCount == 1
        result.failureCount == 1
        result.results.some(row => !row.success && row.reasonCode == "STALE_REVISION")
        replay.alreadyApplied == true
        kept.found == true
        kept.results.length == 2
        printed.results[0].result.contentLocation.endsWith(".pdf")
        other.found == false
    }
})
feature("a store's finalized notice is sent, and not for an invoice send#Invoice issued", {
    when() {
        helper().call("create#mantle.product.store.ProductStore", {
            productStoreId: "NATIVE_SEND_STORE",
            storeName: "Native invoice notice store",
            organizationPartyId: f.org
        })
        helper().call("create#moqui.basic.email.EmailTemplate", {
            emailTemplateId: "NATIVE_SEND_STORE_NOTICE",
            emailServerId: "NATIVE_SEND_SMTP",
            fromAddress: "accounts@native.example",
            subject: "Store invoice finalized",
            bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
        })
        helper().call("create#mantle.product.store.ProductStoreEmail", {
            productStoreId: "NATIVE_SEND_STORE",
            emailTypeEnumId: "PsetInvoiceFinalized",
            fromDate: 0,
            emailTemplateId: "NATIVE_SEND_STORE_NOTICE"
        })
        helper().call("mantle.party.ContactServices.create#EmailAddress", {
            partyId: f.customer,
            emailAddress: "store@example.com",
            contactMechPurposeId: "EmailBilling"
        })
        const notice = helper().draft(f, "11")
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        capture.clear()
        native("change#InvoiceState", {
            invoiceId: notice.invoiceId,
            action: "finalize",
            lastUpdatedStamp: helper().lib.one(helper().lib.invoiceEntity, {invoiceId: notice.invoiceId}).lastUpdatedStamp
        })
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        const noticeCount = capture.count()
        const manual = helper().draft(f, "13")
        capture.clear()
        const sent = native("send#Invoice", Object.assign(sendRequest(manual, "native-store-manual"), {toAddresses: null}))
        assert(ec.factory.waitWorkerPoolEmpty(50), "Invoice mail worker pool did not drain")
        return {noticeCount, manualCount: capture.count(), sent}
    },
    then({noticeCount, manualCount, sent}) {
        noticeCount == 1
        manualCount == 1
        sent.recipientResults[0].recipient == "store@example.com"
    }
})
feature("statements are by customer and currency, for a receivables editor", {
    when() {
        const statementFixture = helper().fixtures("NATIVE_STMT")
        helper().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: statementFixture.org,
            postingGuardEnabled: "N"
        })
        for (const [amount, currency] of [
            ["31", "USD"],
            ["24", "EUR"]
        ]) {
            let invoice = helper().draft(statementFixture, amount, currency)
            // the euro invoice carries its rate, so it posts in the base currency whatever rates other specs left
            if (currency == "EUR")
                helper().call("update#mantle.account.invoice.Invoice", {
                    invoiceId: invoice.invoiceId,
                    exchangeRate: "1.1",
                    exchangeRateToUomId: "USD",
                    exchangeRateSource: "Spec rate"
                })
            invoice = helper().lib.one("mantle.account.invoice.Invoice", {invoiceId: invoice.invoiceId})
            native("change#InvoiceState", {
                invoiceId: invoice.invoiceId,
                action: "finalize",
                lastUpdatedStamp: invoice.lastUpdatedStamp
            })
        }
        const selection = {organizationPartyId: statementFixture.org, customerPartyIdList: [statementFixture.customer]}
        login(statementFixture.users.ar)
        const statements = helper().call("mantle.account.CollectionServices.get#Statements", selection)
        const parameters = Object.assign({}, selection, {
            operationKey: "native-statement-send",
            emailTemplateId: statementFixture.emailTemplateId,
            toAddresses: "statement@example.com,bad-address"
        })
        const before = capture.count()
        const sent = helper().call("mantle.account.CollectionServices.send#Statements", parameters)
        const repeated = helper().call("mantle.account.CollectionServices.send#Statements", parameters)
        const conflict = helper().rejected(
            "mantle.account.CollectionServices.send#Statements",
            Object.assign({}, parameters, {toAddresses: "other@example.com"})
        )
        const sentCount = capture.count() - before
        login(statementFixture.users.read)
        const denied = helper().rejected("mantle.account.CollectionServices.get#Statements", selection)
        return {statements, sent, repeated, conflict, sentCount, denied}
    },
    then({statements, sent, repeated, conflict, sentCount, denied}) {
        statements.statementRows.length == 2
        statements.statementRows.some(row => row.currencyUomId == "EUR" && row.closingBalance.eq(24))
        statements.statementRows.every(row => row.printHtml.includes("NATIVE_STMT customer") && row.agingSummaryList.length == 2)
        sent.successCount == 2
        sent.failureCount == 2
        sent.results
            .filter(row => row.status == "failed")
            .every(row => row.currencyUomId && row.reasonCode == "RECIPIENT_INVALID")
        repeated.alreadyApplied == true
        repeated.results.length == sent.results.length
        conflict.includes("OPERATION_KEY_CONFLICT")
        sentCount == 2
        denied.includes("PERMISSION_DENIED")
    }
})
