// A group's report address, a security address (mr-pass plan/design-smithy.md §12.4, §15.7; plans/Dogfood.md §5.5, §6.4, D17;
// SmithyForum.js storeIssueMailRoute, fileMailReport and claimHeldReport, Forum.js processInbound, ForumLists.js hold): its
// Owner names the address and the site's staff turn it on; mail to it from a confirmed address files a confidential issue
// as that account, held for review when the gateway marked it as spam; from an address that is no account's it is not
// posted: it waits as a held item its Owners read and nobody else, its sender is answered once, and the account that
// confirms that address files it with the link's token; an unclaimed one is dropped after its time. Spec-local site, group,
// db repository and accounts. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyHeldReports
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SHR_SITE"
const ADDRESS = "security@reports.shr.test"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const kind = out => out.kind || null
const store = (username, more) =>
    op(username, "storeIssueMailRoute", {groupId: ids.groupId, repositoryId: ids.repositoryId, address: ADDRESS, ...more})
const mail = (from, subject, text, more = {}) =>
    lib.run("mantle.forum.DeliveryServices.process#Inbound", {
        emailMessageId: null,
        headers: {
            "delivered-to": ADDRESS,
            "message-id": "<" + ec.user.randomString(16) + "@shr.test>",
            "authentication-results": "gw.example.test; dmarc=pass header.from=" + from.replace(/^.*@|>.*$/g, "")
        },
        fields: {from, subject, toList: [ADDRESS]},
        bodyPartList: [{contentType: "text/plain; charset=utf-8", contentText: text}],
        ...more
    }).result
const issues = () =>
    Array.from(
        ec.entity
            .find("mantle.smithy.SmithyIssueTask")
            .condition({repositoryId: ids.repositoryId})
            .orderBy("issueNumber")
            .disableAuthz()
            .list()
    )
const queue = (username, input) =>
    (op(username, "findReviews", input).reviewList || []).filter(item => item.targetType === "mail")

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        setProperty("pass_route_domains", "reports.shr.test")
        lib.site(SITE)
        Object.assign(ids, lib.tracker(SITE, "SHR", "shrgroup"))
        lib.account(SITE, "SHR_MOD", {member: true, siteRole: "moderator"})
    }
})

feature("a group's Owner names its report address, and the site's staff turn it on", {
    when() {
        const named = store("SHR_OWNER", {enabled: false})
        return {
            named,
            maintainer: store("SHR_MAINT", {enabled: false, expectedRevision: named.revision}),
            turnedOnByOwner: store("SHR_OWNER", {enabled: true, expectedRevision: named.revision}),
            elsewhere: op("SHR_OWNER", "storeIssueMailRoute", {
                groupId: ids.groupId,
                repositoryId: ids.repositoryId,
                address: "security@elsewhere.test",
                expectedRevision: named.revision
            }),
            // while it is off its mail is not the forum's
            off: mail("shr_author@smithy.test", "Too early", "SHR-EARLY"),
            on: store(lib.OPERATOR, {enabled: true, expectedRevision: named.revision}),
            stale: store(lib.OPERATOR, {enabled: true, expectedRevision: named.revision}),
            // the Owner saves it again as it is, and it stays on
            kept: store("SHR_OWNER", {enabled: true, expectedRevision: Number(named.revision) + 1}),
            owner: op("SHR_OWNER", "getGroup", {groupId: ids.groupId}).forum.issueMailRoute,
            stranger: op("SHR_STRANGER", "getGroup", {groupId: ids.groupId}).forum.issueMailRoute,
            route: lib.row("mantle.forum.ForumMailRoute", {routeId: named.routeId})
        }
    },
    then({named, maintainer, turnedOnByOwner, elsewhere, off, on, stale, kept, owner, stranger, route}) {
        named.revision == 1
        maintainer.reason == "accessDenied"
        turnedOnByOwner.reason == "accessDenied"
        elsewhere.kind == "Unprocessable"
        off.handled == false
        on.revision == 2
        stale.reason == "staleRevision"
        kept.revision == 3
        owner.address == ADDRESS
        owner.enabled == true
        owner.repositoryPath == "shrgroup/code"
        stranger == null
        route.targetType == "issue"
        route.targetId == ids.repositoryId
    }
})

feature("mail from a confirmed address files a confidential issue as that account; what the gateway marked as spam is held", {
    when() {
        lib.settled(SITE, "SHR_AUTHOR")
        const filed = mail("Author <shr_author@smithy.test>", "A hole in the wall", "SHR-REPORT the details")
        lib.settled(SITE, "SHR_AUTHOR")
        const spam = mail("shr_author@smithy.test", "Cheap things", "SHR-SPAM", {spamVerdict: {spam: true, reason: "score 12"}})
        const rows = issues()
        const number = Number(rows[0].issueNumber)
        return {
            filed,
            spam,
            rows: rows.map(row => [row.confidential, row.reporterPartyId, row.workEffortName, row.rootVisibility].join(" ")),
            reporter: op("SHR_AUTHOR", "getIssue", {repositoryId: ids.repositoryId, issueNumber: number}).issue?.confidential,
            owner: kind(op("SHR_OWNER", "getIssue", {repositoryId: ids.repositoryId, issueNumber: number})),
            stranger: kind(op("SHR_STRANGER", "getIssue", {repositoryId: ids.repositoryId, issueNumber: number})),
            moderator: kind(op("SHR_MOD", "getIssue", {repositoryId: ids.repositoryId, issueNumber: number})),
            family: lib.row("mantle.forum.ForumReviewItem", {siteId: SITE, targetType: "post", targetId: rows[1].rootCommEventId})
                ?.reasonFamily
        }
    },
    then({filed, spam, rows, reporter, owner, stranger, moderator, family}) {
        filed.result == "posted"
        spam.result == "pending"
        rows == ["Y SHR_AUTHOR A hole in the wall approved", "Y SHR_AUTHOR Cheap things pending"]
        reporter == true
        owner == null
        stranger == "NotFound"
        moderator == "NotFound"
        family == "mail-verdict"
    }
})

feature(
    "from an address that is no account's a report waits for its Owners alone, is answered once, and is filed by the account that confirms the address",
    {
        when() {
            const first = mail("Finder <finder@world.test>", "A way in", "SHR-HELD the way in")
            const second = mail("finder@world.test", "And another", "SHR-HELD-TWO")
            const before = issues().length
            const scope = lib.row("mantle.smithy.SmithyGroup", {groupId: ids.groupId}).contactListId
            const ownerQueue = queue("SHR_OWNER", {scopeContactListId: scope})
            const item = op("SHR_OWNER", "getReview", {reviewId: ownerQueue[0].reviewId})
            const staff = {
                queue: queue("SHR_MOD", {}).length,
                item: kind(op("SHR_MOD", "getReview", {reviewId: ownerQueue[0].reviewId})),
                maintainer: kind(op("SHR_MAINT", "getReview", {reviewId: ownerQueue[0].reviewId}))
            }
            // the link's token, known here
            lib.set(
                "mantle.forum.ForumHeldMail",
                {heldId: first.heldId},
                {tokenHash: ec.user.singleUseCodeHash("shr-held-token")}
            )
            lib.account(SITE, "SHR_FINDER", {handle: "shrfinder", unconfirmed: true})
            lib.set("moqui.security.UserAccount", {userId: "SHR_FINDER"}, {emailAddress: "finder@world.test"})
            const unconfirmed = op("SHR_FINDER", "claimHeldReport", {token: "shr-held-token", operationId: "shr-claim-1"})
            lib.make("moqui.security.public.VerifiedAddress", {
                userId: "SHR_FINDER",
                emailAddress: "finder@world.test",
                verifiedAt: ec.user.nowTimestamp
            })
            const claimed = op("SHR_FINDER", "claimHeldReport", {token: "shr-held-token", operationId: "shr-claim-2"})
            // the other one is past its time
            lib.set(
                "mantle.forum.ForumHeldMail",
                {heldId: second.heldId},
                {expiresAt: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000}
            )
            const expired = lib.run("mantle.forum.DeliveryServices.expire#HeldMail", {})
            const last = issues().pop()
            return {
                first,
                second,
                before,
                ownerQueue: ownerQueue.length,
                item,
                staff,
                wrong: op("SHR_AUTHOR", "claimHeldReport", {token: "shr-held-token", operationId: "shr-claim-3"}),
                unknown: op("SHR_AUTHOR", "claimHeldReport", {token: "shr-no-token", operationId: "shr-claim-4"}),
                unconfirmed,
                claimed,
                again: op("SHR_FINDER", "claimHeldReport", {token: "shr-held-token", operationId: "shr-claim-5"}),
                last: [last.confidential, last.reporterPartyId, last.workEffortName].join(" "),
                held: [first.heldId, second.heldId].map(heldId => {
                    const row = lib.row("mantle.forum.ForumHeldMail", {heldId})
                    return row.state + " " + (row.body == null)
                }),
                expired: expired.dropped >= 1,
                after: queue("SHR_OWNER", {scopeContactListId: scope}).length
            }
        },
        then({
            first,
            second,
            before,
            ownerQueue,
            item,
            staff,
            wrong,
            unknown,
            unconfirmed,
            claimed,
            again,
            last,
            held,
            expired,
            after
        }) {
            first.result == "held"
            first.notice == true
            second.notice == false
            // nothing is filed for an address that is no account's
            before == 2
            ownerQueue == 2
            item.review.reasonFamily == "mail-held"
            item.review.detail.includes("SHR-HELD the way in") == true
            item.held.senderAddress == "finder@world.test"
            // a held report is its Owners' alone
            staff == {queue: 0, item: "Unauthorized", maintainer: "Unauthorized"}
            unconfirmed.reason == "addressUnconfirmed"
            claimed.repositoryPath == "shrgroup/code"
            claimed.issueNumber == 3
            wrong.kind == "NotFound"
            unknown.kind == "NotFound"
            again.kind == "NotFound"
            last == "Y SHR_FINDER A way in"
            held == ["claimed true", "dropped true"]
            expired == true
            after == 0
        }
    }
)
