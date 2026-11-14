// A quote's issue and send (impl-sales P10; design-sales §5 OrderDetail's quote context, §14.3 scenario 6;
// mantle.order.SalesQuoteIssueServices over SalesQuoteIssues.js): propose's issue checks and its tax refresh (F151); a send issues
// the quote at its commercial revision with its PDF stored, and storing the PDF, a note, a file and an owner or team change leave
// that revision (F166); a send to two with one failure retries only that one and keeps one issue; a seller that does not count
// commercial changes only, a rep without SALES_QUOTE_SEND and another organization's rep are refused; revise ends the issue and keeps
// its PDF, and a line change ends it too. Standalone: spec-local organizations, users, accounts, contacts, a mail server and a
// template; sends through the mail capture.
// Run: ./moq test mr-mantle --spec SalesQuoteIssue
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {system, as, make, one, revision, status, proposedQuote, attempt, deliveries, key, quoteService} = fx
const capture = ec.factory.getTool("MailCapture")
let f
const shared = {}

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SQI")
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("propose checks the validity and refreshes a storeless quote's tax at the customer's address before it is offered", {
    when() {
        // a quote of A with no validity left: refused; with it set again, proposed
        const orderId = as(f.users.rep, quoteService + "create#Quote", {
            organizationPartyId: f.orgA,
            customerPartyId: f.accounts.a
        }).orderId
        as(f.users.rep, quoteService + "store#QuoteLine", {orderId, orderRevision: revision(orderId), productId: f.product})
        system(() => fx.call("update#mantle.order.OrderPart", {orderId, orderPartSeqId: "01", validThruDate: null}))
        const noValidity = as(f.users.rep, quoteService + "propose#Quote", {orderId, orderRevision: revision(orderId)}).refused
        // C names a tax gateway: its quote for an account with an address that was added after the quote is taxed there first
        const taxed = as(f.users.rep, quoteService + "create#Quote", {
            organizationPartyId: f.orgC,
            customerPartyId: f.accounts.c
        }).orderId
        system(() => fx.call("update#mantle.order.OrderPart", {orderId: taxed, orderPartSeqId: "01", postalContactMechId: null}))
        as(f.users.rep, quoteService + "store#QuoteLine", {orderId: taxed, orderRevision: revision(taxed), productId: f.product})
        const before = revision(taxed)
        const refreshed = as(f.users.rep, quoteService + "propose#Quote", {orderId: taxed, orderRevision: before}).refused
        const address = one("mantle.order.OrderPart", {orderId: taxed, orderPartSeqId: "01"}).postalContactMechId
        const second = as(f.users.rep, quoteService + "propose#Quote", {orderId: taxed, orderRevision: revision(taxed)})
        // an account with no address at all: refused
        const bare = as(f.users.rep, quoteService + "create#Quote", {
            organizationPartyId: f.orgC,
            customerPartyId: f.accounts.cNoAddress
        }).orderId
        as(f.users.rep, quoteService + "store#QuoteLine", {orderId: bare, orderRevision: revision(bare), productId: f.product})
        const noAddress = as(f.users.rep, quoteService + "propose#Quote", {orderId: bare, orderRevision: revision(bare)}).refused
        return {noValidity, refreshed, address, before, after: revision(taxed), second, noAddress}
    },
    then({noValidity, refreshed, address, before, after, second, noAddress}) {
        noValidity.includes("VALIDITY_REQUIRED")
        refreshed.includes("TAX_UPDATED")
        address != null
        after > before
        second.refused == "" && second.statusId == "OrderProposed"
        noAddress.includes("ADDRESS_REQUIRED")
    }
})

feature("a send issues the quote at its revision with its PDF; a file, a note and an owner change leave that revision", {
    when() {
        const {orderId, proposed} = proposedQuote(f, f.users.rep, f.orgA, f.accounts.a, f.contacts.mailed)
        shared.orderId = orderId
        const preview = as(f.users.rep, "send#Quote", {
            orderId,
            orderRevision: revision(orderId),
            recipientPartyIds: [f.contacts.mailed, f.contacts.unmailed],
            previewOnly: "Y"
        })
        const issuesBefore = system(() =>
            ec.entity.find("mantle.sales.quote.SalesQuoteIssue").condition("orderId", orderId).count()
        )
        capture.clear()
        const sent = as(f.users.rep, "send#Quote", {
            orderId,
            orderRevision: revision(orderId),
            recipientPartyIds: [f.contacts.mailed, f.contacts.unmailed],
            note: "As discussed",
            operationKey: key("send")
        })
        attempt(sent.issueId)
        const issue = one("mantle.sales.quote.SalesQuoteIssue", {issueId: sent.issueId})
        const content = one("mantle.order.OrderContent", {orderContentId: issue.orderContentId})
        const pdf = system(() => ec.resource.getLocationReference(issue.contentLocation).getExists())
        const states = Object.fromEntries(deliveries(sent.issueId).map(row => [row.recipientPartyId, row.stateEnumId]))
        const mails = capture.getMessages()
        // a note, a file and a new owner row: the revision the issue binds stays
        system(() => {
            make("mantle.order.OrderNote", {orderId, noteDate: ec.user.nowTimestamp, noteText: "Called the buyer"})
            make("mantle.order.OrderContent", {
                orderId,
                contentLocation: "dbresource://spec/sqi/notes.txt",
                contentDate: ec.user.nowTimestamp
            })
            make("mantle.order.OrderPartParty", {
                orderId,
                orderPartSeqId: "01",
                partyId: f.users.drafter,
                roleTypeId: "SalesTeam"
            })
        })
        const view = as(f.users.rep, "get#QuoteIssues", {orderId})
        return {proposed, preview, issuesBefore, sent, issue, content, pdf, states, mails, view, orderId}
    },
    then({proposed, preview, issuesBefore, sent, issue, content, pdf, states, mails, view, orderId}) {
        proposed.refused == ""
        preview.newIssue == true && preview.fileName == "Quote-" + orderId + "-r" + proposed.orderRevision + ".pdf"
        issuesBefore == 0
        sent.refused == "" && sent.newIssue == true
        issue.orderRevision == proposed.orderRevision
        content.orderContentTypeEnumId == "OctSalesQuoteIssued"
        pdf == true
        states[f.contacts.mailed] == "MdsSent"
        states[f.contacts.unmailed] == "MdsFailed"
        mails.length == 1
        mails[0].toList.includes("sqi_mailed@issue.example.test")
        mails[0].body.includes("As discussed")
        Array.from(mails[0].attachmentNames).includes("Quote-" + orderId + "-r" + proposed.orderRevision + ".pdf")
        revision(orderId) == proposed.orderRevision
        view.issues.length == 1 && view.issues[0].state == "current" && view.standingIssueId == sent.issueId
        view.issues[0].failedCount == 1
    }
})

feature("a second send retries only the failed recipient and keeps the one issue", {
    when() {
        const orderId = shared.orderId
        capture.clear()
        const again = as(f.users.rep, "send#Quote", {
            orderId,
            orderRevision: revision(orderId),
            recipientPartyIds: [f.contacts.mailed, f.contacts.unmailed],
            operationKey: key("again")
        })
        attempt(again.issueId)
        const stillFailed = deliveries(again.issueId).find(row => row.recipientPartyId == f.contacts.unmailed).stateEnumId
        // the contact gets an email; the next send reaches them alone
        system(() => fx.email(f.contacts.unmailed, "sqi_unmailed@issue.example.test"))
        const third = as(f.users.rep, "send#Quote", {
            orderId,
            orderRevision: revision(orderId),
            recipientPartyIds: [f.contacts.mailed, f.contacts.unmailed],
            operationKey: key("third")
        })
        attempt(third.issueId)
        return {
            again,
            stillFailed,
            third,
            mails: capture.getMessages(),
            states: deliveries(third.issueId).map(row => row.stateEnumId),
            issues: system(() => ec.entity.find("mantle.sales.quote.SalesQuoteIssue").condition("orderId", orderId).count())
        }
    },
    then({again, stillFailed, third, mails, states, issues}) {
        again.newIssue == false
        again.recipients.find(row => row.partyId == f.contacts.mailed).skipped == true
        again.recipients.find(row => row.partyId == f.contacts.unmailed).retried == true
        stillFailed == "MdsFailed"
        third.issueId == again.issueId
        mails.length == 1
        mails[0].toList.includes("sqi_unmailed@issue.example.test")
        states.every(state => state == "MdsSent")
        issues == 1
    }
})

feature("a seller not counting commercial changes only, a rep who may not send and another organization's rep are refused", {
    when() {
        const b = proposedQuote(f, f.users.rep, f.orgB, f.accounts.b, null)
        const offB = as(f.users.rep, "send#Quote", {
            orderId: b.orderId,
            orderRevision: revision(b.orderId),
            operationKey: key("b")
        }).refused
        const orderId = shared.orderId
        const drafter = as(f.users.drafter, "send#Quote", {
            orderId,
            orderRevision: revision(orderId),
            operationKey: key("d")
        }).refused
        const other = as(f.users.repB, "send#Quote", {orderId, orderRevision: revision(orderId), operationKey: key("o")}).refused
        const stale = as(f.users.rep, "send#Quote", {
            orderId,
            orderRevision: revision(orderId) - 1,
            operationKey: key("s")
        }).refused
        return {proposedB: b.proposed, offB, drafter, other, stale}
    },
    then({proposedB, offB, drafter, other, stale}) {
        proposedB.refused == ""
        offB.includes("COMMERCIAL_REVISION_OFF")
        drafter.includes("PERMISSION_DENIED")
        other.includes("RECORD_UNAVAILABLE")
        stale.includes("REVISION_CHANGED")
    }
})

feature("revise ends the issue and keeps its PDF; the revised quote is issued anew; a line change ends an issue too", {
    when() {
        const orderId = shared.orderId
        const issued = revision(orderId)
        const firstIssue = as(f.users.rep, "get#QuoteIssues", {orderId}).standingIssueId
        const revised = as(f.users.rep, "revise#Quote", {orderId, orderRevision: issued, reason: "Customer asked for three"})
        const line = one("mantle.order.OrderItem", {orderId, itemTypeEnumId: "ItemProduct"})
        const changed = as(f.users.rep, quoteService + "store#QuoteLine", {
            orderId,
            orderRevision: revision(orderId),
            orderItemSeqId: line.orderItemSeqId,
            quantity: 3
        })
        const reproposed = as(f.users.rep, quoteService + "propose#Quote", {orderId, orderRevision: revision(orderId)})
        const resent = as(f.users.rep, "send#Quote", {orderId, orderRevision: revision(orderId), operationKey: key("resent")})
        const ended = one("mantle.sales.quote.SalesQuoteIssue", {issueId: firstIssue})
        const pdfKept = system(() => ec.resource.getLocationReference(ended.contentLocation).getExists())
        // a line changed under the issue (the native order entry, outside Sales) ends it: a later revision
        const item = one("mantle.order.OrderItem", {orderId, itemTypeEnumId: "ItemProduct"})
        system(() => fx.call("update#mantle.order.OrderItem", {orderId, orderItemSeqId: item.orderItemSeqId, quantity: 4}))
        const view = as(f.users.rep, "get#QuoteIssues", {orderId})
        return {issued, revised, changed, reproposed, resent, ended, pdfKept, view, firstIssue}
    },
    then({issued, revised, changed, reproposed, resent, ended, pdfKept, view, firstIssue}) {
        revised.refused == "" && revised.statusId == "OrderBeingChanged" && revised.orderRevision > issued
        changed.refused == ""
        reproposed.refused == "" && reproposed.statusId == "OrderProposed"
        resent.refused == "" && resent.newIssue == true && resent.issueId != firstIssue
        ended.endReasonEnumId == "SqeRevised"
        pdfKept == true
        view.issues.length == 2
        view.issues.find(row => row.issueId == resent.issueId).state == "superseded"
        view.standingIssueId == null
        view.canSend == true
    }
})
