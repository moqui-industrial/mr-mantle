// Issued payment documents: payment content written at delivery from the PaymentDocument template.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_OUTPUT")
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    }
})
function contentRows(h, paymentId) {
    return h.lib.rows("mantle.account.payment.PaymentContent", {paymentId})
}
function bytesOf(location) {
    const stream = ec.resource.getLocationReference(location).getInputStream()
    try {
        return stream.readAllBytes()
    } finally {
        stream.close()
    }
}
feature("delivery issues a receipt and a detail as payment content and reading one changes nothing", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {amount: "40"}),
            before = contentRows(h, paymentId),
            receipt = h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "receipt"}),
            again = h.native("get#PaymentOutput", {organizationPartyId: f.org, outputId: receipt.outputId}),
            content = h.lib.one("mantle.account.payment.PaymentContent", {paymentContentId: receipt.outputId})
        return {before, after: contentRows(h, paymentId), receipt, again, content, pdf: bytesOf(content.contentLocation)}
    },
    then({before, after, receipt, again, content, pdf}) {
        before
            .map(row => row.contentTypeEnumId)
            .sort()
            .join(",") == "PctPaymentDocument,PctReceipt"
        after.length == before.length
        again.outputId == receipt.outputId
        again.outputType == "receipt"
        receipt.fileName == "Payment-" + content.paymentId + "-receipt.pdf"
        content.contentLocation.includes("/payment/" + content.paymentId + "/content_" + content.paymentContentId + "/")
        String.fromCharCode(pdf[0], pdf[1], pdf[2], pdf[3]) == "%PDF"
        toDecimal(receipt.summary.amount).eq(40)
        receipt.summary.currencyUomId == "USD"
        receipt.summary.methodLabel.includes("6789")
        receipt.documentHtml.includes("Payment receipt")
        receipt.documentHtml.includes("123456789") == false
    }
})
feature("an outgoing check is numbered at delivery and its document needs treasury authority", {
    when() {
        const h = helper()
        login(f.users.treasury)
        const paymentId = h.delivered(f, {cashDirection: "outgoing", paymentInstrumentEnumId: "PiCompanyCheck", amount: "15"}),
            check = h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "check"}),
            treasuryView = h.detail(f, paymentId)
        login(f.users.paymentView)
        const readerView = h.detail(f, paymentId),
            refused = h.rejected("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "check"}),
            receipt = h.native("get#PaymentOutput", {organizationPartyId: f.org, paymentId, outputType: "receipt"})
        login("john.doe")
        return {
            check,
            treasuryView,
            readerView,
            refused,
            receipt,
            number: h.lib.one("mantle.account.method.BankAccountCheck", {paymentMethodId: f.methodId, paymentId: paymentId})
        }
    },
    then({check, treasuryView, readerView, refused, receipt, number}) {
        check.outputType == "check"
        check.summary.checkNumber == String(number.checkNumber)
        treasuryView.capabilities.canPrintCheck == true
        treasuryView.contentRows.some(row => row.contentTypeEnumId === "PctCheckImage")
        readerView.capabilities.canPrintCheck == false
        readerView.contentRows.some(row => row.contentTypeEnumId === "PctCheckImage") == false
        refused.includes("Treasury authority")
        receipt.outputType == "receipt"
    }
})
feature("a posted payment's files are kept as issued while new files can still be added", {
    when() {
        const h = helper(),
            draftId = h.draft(f),
            draftFile = h.native("create#PaymentContent", {
                paymentId: draftId,
                contentTypeEnumId: "PctPaymentDocument",
                contentFile: uploadedFile("Instruction.txt", "First instruction")
            }).paymentContentId
        h.native("update#PaymentContent", {
            paymentContentId: draftFile,
            contentFile: uploadedFile("Instruction.txt", "Corrected instruction")
        })
        const paymentId = h.delivered(f),
            issued = contentRows(h, paymentId).find(row => row.contentTypeEnumId === "PctReceipt"),
            replaced = h.rejected("update#PaymentContent", {
                paymentContentId: issued.paymentContentId,
                contentFile: uploadedFile("Receipt.pdf", "Forged receipt")
            }),
            added = h.native("create#PaymentContent", {
                paymentId,
                contentTypeEnumId: "PctPaymentDocument",
                contentFile: uploadedFile("Bank advice.txt", "Bank advice")
            }).paymentContentId,
            access = h.native("get#PaymentAccess", {organizationPartyId: f.org, paymentId}),
            draftAccess = h.native("get#PaymentAccess", {organizationPartyId: f.org, paymentId: draftId})
        return {replaced, added, access, draftAccess}
    },
    then({replaced, added, access, draftAccess}) {
        replaced.includes("cannot be replaced")
        added != null
        access.contentLocked == true
        access.canChange == true
        draftAccess.contentLocked == false
    }
})
feature(
    "payment access infers an authoritative organization only with no selection and still denies another selected organization",
    {
        when() {
            const h = helper(),
                paymentId = h.draft(f),
                other = h.settlement.fixtures("ACCT_P5_OUTOTHER")
            login(f.users.paymentView)
            const saved = ec.user.getPreference("ACTIVE_ORGANIZATION")
            let positive,
                negative,
                linked = false
            try {
                ec.user.setPreference("ACTIVE_ORGANIZATION", "")
                login(f.users.paymentView)
                positive = h.native("get#PaymentAccess", {paymentId}).organizationPartyId
                login("john.doe")
                h.call("create#mantle.party.PartyRelationship", {
                    partyRelationshipId: "OUT_OTHER_VIEW_REL",
                    fromPartyId: f.users.paymentView,
                    toPartyId: other.org,
                    relationshipTypeEnumId: "PrtAgent",
                    fromDate: 0
                })
                linked = true
                login(f.users.paymentView)
                ec.user.setPreference("ACTIVE_ORGANIZATION", other.org)
                login(f.users.paymentView)
                negative = h.rejected("get#PaymentAccess", {paymentId})
            } finally {
                login(f.users.paymentView)
                ec.user.setPreference("ACTIVE_ORGANIZATION", saved || "")
                login("john.doe")
                if (linked) h.call("delete#mantle.party.PartyRelationship", {partyRelationshipId: "OUT_OTHER_VIEW_REL"})
            }
            return {positive, negative}
        },
        then({positive, negative}) {
            positive == f.org
            negative.includes("PAYMENT_UNAVAILABLE") || negative.includes("ORGANIZATION_DENIED")
        }
    }
)
feature("legacy foreign and private application links are omitted while valid same-scope money remains readable", {
    when() {
        const h = helper(),
            other = h.settlement.fixtures("ACCT_P5_LINKORG"),
            privateParty = "ACCT_P5_OUT_PRIVATE"
        h.call("create#mantle.party.Party", {
            partyId: privateParty,
            partyTypeEnumId: "PtyOrganization",
            privateOwnerUserId: f.users.ap
        })
        h.call("create#mantle.party.Organization", {partyId: privateParty, organizationName: "Secret counterparty"})
        const visibleInvoice = h.settlement.invoice(f, "20"),
            privateInvoice = h.settlement.invoice(f, "20", "receivable", {
                invoiceId: "ACCT_P5_SECRET_INVOICE",
                toPartyId: privateParty
            }),
            foreignInvoice = h.settlement.invoice(other, "20", "receivable", {
                invoiceId: "ACCT_P5_FOREIGN_INVOICE",
                toPartyId: f.customer
            }),
            paymentId = h.call("create#mantle.account.payment.Payment", {
                fromPartyId: f.customer,
                toPartyId: f.org,
                paymentTypeEnumId: "PtInvoicePayment",
                paymentInstrumentEnumId: "PiOther",
                statusId: "PmntProposed",
                amount: "25",
                amountUomId: "USD",
                effectiveDate: f.timestamp
            }).paymentId,
            ids = []
        let view
        try {
            for (const invoiceId of [visibleInvoice, privateInvoice, foreignInvoice])
                ids.push(
                    h.rawApplication({paymentId, invoiceId, amountApplied: "5", appliedDate: f.timestamp}).paymentApplicationId
                )
            login(f.users.paymentView)
            view = h.detail(f, paymentId)
        } finally {
            login("john.doe")
            for (const id of ids) h.settlement.clearImportedApplication(id)
        }
        return {view, visibleInvoice, privateInvoice, foreignInvoice}
    },
    then({view, visibleInvoice, privateInvoice, foreignInvoice}) {
        view.applicationRows.length == 1
        view.applicationRows[0].invoiceId == visibleInvoice
        toDecimal(view.applicationRows[0].amountApplied).eq(5)
        view.complete == false
        view.errors.some(row => row.reasonCode === "APPLICATIONS_RESTRICTED")
        JSON.stringify(view).includes(privateInvoice) == false
        JSON.stringify(view).includes(foreignInvoice) == false
        toDecimal(view.totals.appliedTotal).eq(15)
        toDecimal(view.totals.unappliedTotal).eq(10)
    }
})
