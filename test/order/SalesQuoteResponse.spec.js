// The customer's response to an issued quote, recorded by staff (impl-sales P10; design-sales §5 Record acceptance and decline,
// §14.3 scenario 7; mantle.order.SalesQuoteIssueServices respond#Quote, withdraw#Quote): two acceptances under one key and under
// two give one response and one placed order (through place#Order), the customer's purchase order on the part without moving the
// revision; a decline after it is refused; a decline needs its reason and cancels the quote through Cancel Quote, ending its issue;
// an expired issue and a withdrawn one are refused; another organization's rep is refused. Standalone: SalesQuoteIssueFixtures.
// Run: ./moq test mr-mantle --spec SalesQuoteResponse
const fx = ec.resource.script("component://mr-mantle/test/order/SalesQuoteIssueFixtures.js")
const {system, as, one, revision, status, proposedQuote, key} = fx
const capture = ec.factory.getTool("MailCapture")
let f

// a proposed quote of A, issued to the mailed contact: {orderId, issueId}
function issuedQuote() {
    const {orderId} = proposedQuote(f, f.users.rep, f.orgA, f.accounts.a, f.contacts.mailed)
    const sent = as(f.users.rep, "send#Quote", {orderId, orderRevision: revision(orderId), operationKey: key("send")})
    return {orderId, issueId: sent.issueId, revision: revision(orderId)}
}

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        f = fx.setup("SQS")
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("two acceptances under one key and under two give one response and one placed order; a decline after it is refused", {
    when() {
        const quote = issuedQuote()
        const accept = {
            orderId: quote.orderId,
            responseType: "accept",
            contactPartyId: f.contacts.mailed,
            otherPartyOrderId: "PO-778"
        }
        const firstKey = key("accept")
        const first = as(f.users.rep, "respond#Quote", Object.assign({operationKey: firstKey}, accept))
        const sameKey = as(f.users.rep, "respond#Quote", Object.assign({operationKey: firstKey}, accept))
        const otherKey = as(f.users.rep, "respond#Quote", Object.assign({operationKey: key("again")}, accept))
        const decline = as(f.users.rep, "respond#Quote", {
            orderId: quote.orderId,
            responseType: "decline",
            reason: "Changed our mind",
            operationKey: key("decline")
        }).refused
        const part = one("mantle.order.OrderPart", {orderId: quote.orderId, orderPartSeqId: "01"})
        const responses = system(() =>
            ec.entity.find("mantle.sales.quote.SalesQuoteResponse").condition("orderId", quote.orderId).count()
        )
        const view = as(f.users.rep, "get#QuoteIssues", {orderId: quote.orderId})
        return {
            quote,
            first,
            sameKey,
            otherKey,
            decline,
            part,
            responses,
            view,
            statusId: status(quote.orderId),
            now: revision(quote.orderId)
        }
    },
    then({quote, first, sameKey, otherKey, decline, part, responses, view, statusId, now}) {
        first.refused == "" && first.outcome == "placed" && first.statusId == "OrderPlaced"
        sameKey.alreadyApplied == true && sameKey.responseId == first.responseId
        otherKey.alreadyApplied == true && otherKey.responseId == first.responseId
        decline.includes("RESPONSE_EXISTS")
        responses == 1
        statusId == "OrderPlaced"
        part.otherPartyOrderId == "PO-778"
        // the customer's reference and the placement are not commercial changes: the issue's revision stands
        now == quote.revision
        view.issues[0].state == "accepted" && view.issues[0].response.otherPartyOrderId == "PO-778"
    }
})

feature("a decline needs its reason and cancels the quote through Cancel Quote, ending its issue", {
    when() {
        const quote = issuedQuote()
        const noReason = as(f.users.rep, "respond#Quote", {
            orderId: quote.orderId,
            responseType: "decline",
            operationKey: key("d0")
        }).refused
        const declined = as(f.users.rep, "respond#Quote", {
            orderId: quote.orderId,
            responseType: "decline",
            reason: "Too expensive",
            operationKey: key("d1")
        })
        const issue = one("mantle.sales.quote.SalesQuoteIssue", {issueId: quote.issueId})
        const response = one("mantle.sales.quote.SalesQuoteResponse", {responseId: declined.responseId})
        return {noReason, declined, issue, response, statusId: status(quote.orderId)}
    },
    then({noReason, declined, issue, response, statusId}) {
        noReason.includes("REASON_REQUIRED")
        declined.refused == "" && declined.outcome == "declined"
        statusId == "OrderCancelled"
        issue.endReasonEnumId == "SqeDeclined"
        response.reasonText == "Too expensive" && response.resultStatusId == "OrderCancelled"
    }
})

feature("an expired issue and a withdrawn one are refused, and so is another organization's rep", {
    when() {
        const expiring = issuedQuote()
        // the issue's validity passed (the part's own validity is a commercial term; the issue keeps what it offered)
        system(() =>
            fx.call("update#mantle.sales.quote.SalesQuoteIssue", {
                issueId: expiring.issueId,
                validThruDate: new Date(Date.now() - 60 * 60 * 1000)
            })
        )
        const expired = as(f.users.rep, "respond#Quote", {
            orderId: expiring.orderId,
            responseType: "accept",
            operationKey: key("x")
        }).refused
        const other = as(f.users.repB, "respond#Quote", {
            orderId: expiring.orderId,
            responseType: "accept",
            operationKey: key("o")
        }).refused
        const withdrawing = issuedQuote()
        const noReason = as(f.users.rep, "withdraw#Quote", {
            orderId: withdrawing.orderId,
            orderRevision: withdrawing.revision
        }).refused
        const withdrawn = as(f.users.rep, "withdraw#Quote", {
            orderId: withdrawing.orderId,
            orderRevision: withdrawing.revision,
            reason: "Superseded by a new offer"
        })
        const revoked = as(f.users.rep, "respond#Quote", {
            orderId: withdrawing.orderId,
            responseType: "accept",
            operationKey: key("r")
        }).refused
        return {
            expired,
            other,
            noReason,
            withdrawn,
            revoked,
            issue: one("mantle.sales.quote.SalesQuoteIssue", {issueId: withdrawing.issueId})
        }
    },
    then({expired, other, noReason, withdrawn, revoked, issue}) {
        expired.includes("ISSUE_EXPIRED")
        other.includes("RECORD_UNAVAILABLE")
        noReason.includes("REASON_REQUIRED")
        withdrawn.refused == "" && withdrawn.statusId == "OrderCancelled" && withdrawn.endedCount == 1
        issue.endReasonEnumId == "SqeWithdrawn"
        revoked.includes("ISSUE_ENDED")
    }
})
