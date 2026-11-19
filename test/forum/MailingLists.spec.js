// Mailing lists (plans/Dogfood.md §6.3, §6.4, D17; ForumLists.js, Forum.js processInbound, DeliveryWorker.js): a category in
// list mode has its own List-Id, List-Post and List-Archive by its address; an mbox archive is imported once, threaded by
// its references (a reply before its parent in the file, a subject that answers one), an encoded subject and a flowed
// text read, a file left out, a duplicate Message-ID and a second run adding nothing, each author a profile with no
// account that shows a name and never an address (even where an account has that address), claimed by the account that
// verifies the address; a message over the byte cap is passed, and an archive goes only into a list; an invitation
// subscribes only when it is redeemed, and an inviter who is not the site's owner invites a day's allowance; mail to a
// list from an address that is no account's is held and answered once, and posted as the account once the address is
// verified, its sender's address kept no longer than its time; only the trusted gateway's Authentication-Results
// authenticate a sender (RFC 8601: quoted strings, comments, the first result of a method); and mail the gateway marked as
// spam is held for review, read only in the forum's own inbound account; a reply by a member's reply address or by
// In-Reply-To to a notice it was mailed is a post in that topic.
// Spec-local site, category and accounts; the fixture is test/forum/fixtures/list.mbox. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec MailingLists
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "MLS_SITE"
const LISTS = "lists.mls.test"
const ids = {}
const forum = () => ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
const sys = work => {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const list = (entity, fields) => Array.from(ec.entity.find(entity).condition(fields).disableAuthz().list())
/* A published public category that any member posts in, made as rows; mode list gives it a list's address. */
function category(name, mode, address) {
    const contactListId = lib.make("mantle.marketing.contact.ContactList", {
        contactListTypeEnumId: "MAILBOX",
        contactListName: name,
        isPublic: "N",
        postingEnumId: "ClpAnyUser"
    }).contactListId
    lib.make("mantle.forum.ForumCategory", {
        contactListId,
        siteId: SITE,
        slug: contactListId,
        sequenceNum: 0,
        publicationState: "published",
        visibility: "public",
        mode,
        policyRevision: 1
    })
    if (address)
        lib.make("mantle.forum.ForumMailRoute", {
            routeId: "MLS_" + name.toUpperCase(),
            siteId: SITE,
            address,
            contactListId,
            enabled: "Y",
            revision: 1,
            createdAt: ec.user.nowTimestamp
        })
    return contactListId
}
/* A message to an address as the mail gateway hands it over, its sender's domain authenticated. */
const mail = (from, to, subject, text, more = {}) =>
    lib.run("mantle.forum.DeliveryServices.process#Inbound", {
        emailMessageId: null,
        headers: {
            "delivered-to": to,
            "message-id": "<" + ec.user.randomString(16) + "@mls.test>",
            "authentication-results": "gw.example.test; dmarc=pass header.from=" + from.replace(/^.*@|>.*$/g, ""),
            from
        },
        fields: {from, subject, toList: [to]},
        bodyPartList: [{contentType: "text/plain; charset=utf-8", contentText: text}],
        ...more
    }).result
const posts = contactListId =>
    list("mantle.forum.ForumPostSearch", {siteId: SITE, contactListId}).sort((left, right) =>
        String(left.body).localeCompare(String(right.body))
    )
const held = sender => list("mantle.forum.ForumHeldMail", {siteId: SITE, senderAddress: sender})

spec({
    setupSpec() {
        login(lib.OPERATOR)
        setConf("pass@import-dir", "runtime://tmp/mantle-mbox-import")
        setConf("smtp-server@authserv-id", "gw.example.test")
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {siteId: SITE, hostname: "mls.example.test", canonical: "Y"})
        ids.list = category("Dev", "list", "dev@" + LISTS)
        ids.plain = category("Talk", "discussion", null)
        lib.account(SITE, "MLS_MEMBER", {handle: "mlsmember"})
        lib.settled(SITE, "MLS_MEMBER")
        lib.account(SITE, "MLS_OTHER", {handle: "mlsother"})
        lib.account(SITE, "MLS_OWNER", {member: true, siteRole: "owner"})
        // an account that has an archive author's address, verified before the import: the import does not give it the
        // author's posts by the From field
        lib.account(SITE, "MLS_BOB", {unconfirmed: true})
        lib.set("moqui.security.UserAccount", {userId: "MLS_BOB"}, {emailAddress: "bob@list-archive.test"})
        lib.make("moqui.security.public.VerifiedAddress", {
            userId: "MLS_BOB",
            emailAddress: "bob@list-archive.test",
            verifiedAt: ec.user.nowTimestamp
        })
        // the forum's own inbound account of the list's address (shared, fed by the mail listener), and a user's synced one
        lib.make("moqui.basic.email.EmailAccount", {
            emailAccountId: "MLS_FORUM_ACCOUNT",
            accountKindEnumId: "EakShared",
            emailAddress: "dev@" + LISTS
        })
        lib.make("moqui.basic.email.EmailServer", {emailServerId: "MLS_IMAP", storeHost: "imap.mls.test"})
        lib.make("moqui.basic.email.EmailAccount", {
            emailAccountId: "MLS_USER_ACCOUNT",
            accountKindEnumId: "EakExternal",
            ownerUserId: "MLS_MEMBER",
            emailServerId: "MLS_IMAP",
            emailAddress: "mls_member@smithy.test"
        })
    }
})

feature("a list category's mail carries the list's own List-Id, List-Post and List-Archive; another category's does not", {
    when() {
        const base = "https://mls.example.test/forum"
        return {
            list: sys(() => forum().listHeaders(SITE, ids.list, base)),
            plain: sys(() => forum().listHeaders(SITE, ids.plain, base))
        }
    },
    then({list: headers, plain}) {
        headers["List-Id"] == '"Dev" <dev.' + LISTS + ">"
        headers["List-Post"] == "<mailto:dev@" + LISTS + ">"
        headers["List-Archive"] == "<https://mls.example.test/forum/Categories/CategoryDetail?contactListId=" + ids.list + ">"
        plain == null
    }
})

feature("an mbox archive is imported once: threaded, its text read, a duplicate and a second run adding nothing", {
    when() {
        const location = "runtime://tmp/mantle-mbox-import/mls-list.mbox"
        ec.resource
            .getLocationReference(location)
            .putText(ec.resource.getLocationText("component://mr-mantle/test/forum/fixtures/list.mbox", false))
        const checksum = ec.resource.digest(location, "sha256")
        const input = {contactListId: ids.list, archiveName: "mls-list.mbox", checksum}
        const runAll = () => {
            const started = lib.op("MLS_OWNER", SITE, "importMbox", input)
            for (let turn = 0; turn < 20; turn++) {
                lib.run("mantle.forum.OperationServices.advance#Run", {runId: started.runId, budget: 50})
                if (lib.row("mantle.forum.ForumJobRun", {runId: started.runId}).state !== "pending") break
            }
            return lib.op("MLS_OWNER", SITE, "getMboxImport", {importId: started.importId}).import
        }
        const first = runAll()
        const topics = lib.op(null, SITE, "findTopics", {contactListId: ids.list}).topicList
        const thread = list("mantle.forum.ForumPostSearch", {
            rootCommEventId: topics.find(topic => /cache/.test(topic.title)).rootCommEventId
        }).sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
        const second = runAll()
        const authors = list("mantle.forum.ForumImportMap", {siteId: SITE, sourceType: "mbox-author"})
        const alice = thread[0].fromPartyId
        const names = authors
            .map(map => lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: map.targetId})?.displayName)
            .filter(name => !!name)
            .sort()
        // the account that verifies the address of an author gets the author's posts
        lib.account(SITE, "MLS_ALICE", {unconfirmed: true})
        lib.set("moqui.security.UserAccount", {userId: "MLS_ALICE"}, {emailAddress: "Alice@list-archive.test"})
        lib.make("moqui.security.public.VerifiedAddress", {
            userId: "MLS_ALICE",
            emailAddress: "Alice@list-archive.test",
            verifiedAt: ec.user.nowTimestamp
        })
        lib.run("mantle.forum.ImportServices.claim#VerifiedAddress", {userId: "MLS_ALICE"})
        return {
            stranger: lib.op("MLS_MEMBER", SITE, "importMbox", input),
            first: first.report,
            stage: first.stage,
            titles: topics.map(topic => topic.title + " " + topic.visiblePostCount).sort(),
            thread: thread.map(
                post =>
                    post.ordinal +
                    " " +
                    ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js").plainText(post.body)
            ),
            parents: thread.map(post => thread.findIndex(other => other.communicationEventId === post.parentCommEventId)),
            dates: thread.map(post => new Date(ec.user.timestampMillis(post.entryDate)).toISOString().slice(0, 13)),
            release: list("mantle.forum.ForumPostSearch", {siteId: SITE, contactListId: ids.list})
                .map(post => String(post.body))
                .filter(body => /plan|answer by subject/.test(body))
                .sort(),
            second: second.report,
            postCount: list("mantle.forum.ForumPostSearch", {siteId: SITE, contactListId: ids.list}).length,
            authorCount: authors.length,
            accounts: authors.filter(map => list("moqui.security.UserAccount", {partyId: map.targetId}).length > 0).length,
            names,
            // nothing the import kept has an address in it
            kept:
                JSON.stringify(
                    list("mantle.forum.ForumImportMap", {siteId: SITE}).map(map => [map.sourceId, map.payload, map.targetId])
                ) +
                JSON.stringify(
                    list("mantle.public.PublicSiteProfile", {siteId: SITE}).map(profile => [profile.handle, profile.displayName])
                ),
            claimedBy: lib.row("mantle.party.communication.CommunicationEvent", {
                communicationEventId: thread[0].communicationEventId
            }).fromPartyId,
            placeholderGone: lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: alice}) == null
        }
    },
    then({
        stranger,
        first,
        stage,
        titles,
        thread,
        parents,
        dates,
        release,
        second,
        postCount,
        authorCount,
        accounts,
        names,
        kept,
        claimedBy,
        placeholderGone
    }) {
        stranger.kind == "Unauthorized"
        stage == "imported"
        first.messages == 5
        first.topics == 2
        first.replies == 3
        first.duplicates == 1
        first.attachments == 1
        // the encoded subject is the topic's title, and each topic has its replies
        titles == ["Größe of the cache 3", "Release plans 2"]
        // flowed text joined, ">From " read back, the plain part of an alternative taken with its quoted-printable text
        thread ==
            [
                "1 How large should the cache be? This first paragraph is wrapped by the sender's client with soft line breaks, which the archive joins again. From what I measured, MBOXFIRST is the word to search for.",
                "2 The plain part is taken: café and a soft break.",
                "3 A reply to the reply, which comes before it in the file."
            ]
        // the reply that came first in the file is under its parent, which was made before it
        parents == [-1, 0, 1]
        dates == ["2024-01-01T10", "2024-01-02T10", "2024-01-02T09"]
        // html cleaned, and the answer by subject in its topic
        release == ["<p>An answer by subject alone: this client sent no In-Reply-To.</p>", "<p>The plan in <b>html</b> only.</p>"]
        second.duplicates == 6
        second.messages == null
        postCount == 5
        authorCount == 4
        accounts == 0
        names == ["Alice Example", "Bob Builder", "Carol Müller", "Dave"]
        kept.includes("list-archive.test") == false
        kept.includes("@") == false
        claimedBy == "MLS_ALICE"
        placeholderGone == true
    }
})

feature("an invitation to a list subscribes when it is redeemed, and nobody without it", {
    when() {
        lib.make("mantle.forum.ForumMailSettings", {
            siteId: SITE,
            senderAddress: "lists@mls.test",
            templateId: "MLS_NO_TEMPLATE",
            revision: 1
        })
        const invited = lib.op("MLS_OWNER", SITE, "inviteListMembers", {
            contactListId: ids.list,
            addresses: ["MLS_OTHER@smithy.test", "new.person@elsewhere.test", "not an address", "new.person@elsewhere.test"],
            operationId: "mls-invite-1"
        })
        const again = lib.op("MLS_OWNER", SITE, "inviteListMembers", {
            contactListId: ids.list,
            addresses: ["mls_other@smithy.test"],
            operationId: "mls-invite-2"
        })
        const subscribed = () =>
            list("mantle.forum.ForumDeliveryPreference", {siteId: SITE, scopeType: "category", scopeId: ids.list}).map(
                row => row.partyId + " " + row.emailMode
            )
        const before = subscribed()
        // the link of the mail, redeemed by the account whose verified address was invited
        lib.make("mantle.public.PublicSiteInvitation", {
            invitationId: "MLS_INVITATION",
            siteId: SITE,
            tokenHash: ec.user.singleUseCodeHash("mls-known-token"),
            emailHash: ec.user.singleUseCodeHash("mls_other@smithy.test"),
            scopes: JSON.stringify([{list: ids.list}]),
            expiresAt: ec.user.timestampMillis(ec.user.nowTimestamp) + 3600000
        })
        return {
            invited,
            again,
            notOwner: lib.op("MLS_MEMBER", SITE, "inviteListMembers", {
                contactListId: ids.list,
                addresses: ["a@b.test"],
                operationId: "mls-invite-3"
            }),
            notList: lib.op("MLS_OWNER", SITE, "inviteListMembers", {
                contactListId: ids.plain,
                addresses: ["a@b.test"],
                operationId: "mls-invite-4"
            }),
            // the list's own owner, new on the site, invites twenty addresses a day
            limited: (() => {
                lib.account(SITE, "MLS_LISTOWNER", {handle: "mlslistowner"})
                lib.make("mantle.marketing.contact.ContactListParty", {
                    contactListId: ids.list,
                    partyId: "MLS_LISTOWNER",
                    roleTypeId: "ListOwner",
                    statusId: "CLPT_ACCEPTED",
                    fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
                })
                return lib.op("MLS_LISTOWNER", SITE, "inviteListMembers", {
                    contactListId: ids.list,
                    addresses: Array.from({length: 22}, (unused, index) => "limit" + index + "@many.test"),
                    operationId: "mls-invite-5"
                })
            })(),
            before,
            wrong: lib.op("MLS_MEMBER", SITE, "redeemInvitation", {token: "mls-known-token"}),
            redeemed: lib.op("MLS_OTHER", SITE, "redeemInvitation", {token: "mls-known-token"}),
            after: subscribed(),
            member: list("mantle.marketing.contact.ContactListParty", {contactListId: ids.list})
                .filter(row => row.roleTypeId !== "ListOwner")
                .map(row => row.partyId + " " + row.statusId)
        }
    },
    then({invited, again, notOwner, notList, limited, before, wrong, redeemed, after, member}) {
        limited.invited + limited.unsent == 20
        limited.limitedCount == 2
        // two addresses invited (mail is not sent here: the site's template is not there), one not an address
        invited.invited + invited.unsent == 2
        invited.invalidCount == 1
        invited.limitedCount == 0
        again.alreadyInvited == 1
        notOwner.kind == "Unauthorized"
        notList.kind == "Unprocessable"
        before == []
        wrong.kind == "Unauthorized"
        redeemed.state == "active"
        after == ["MLS_OTHER EveryPost"]
        member == ["MLS_OTHER CLPT_ACCEPTED"]
    }
})

feature(
    "mail to a list from an address that is no account's is held and answered once, then posted as the account that verifies it",
    {
        when() {
            const to = "dev@" + LISTS
            const first = mail("Newcomer <newcomer@held.test>", to, "First words", "MLS-HELD-ONE")
            const second = mail("newcomer@held.test", to, "More words", "MLS-HELD-TWO")
            const waiting = held("newcomer@held.test")
            const queue = lib.op("MLS_OWNER", SITE, "findReviews", {contactListId: ids.list}).reviewList
            const item = lib.op("MLS_OWNER", SITE, "getReview", {
                reviewId: queue.find(review => review.targetType === "mail").reviewId
            })
            // a category that is no list keeps nothing for a non-account, as before
            const plainRoute = lib.make("mantle.forum.ForumMailRoute", {
                routeId: "MLS_TALK",
                siteId: SITE,
                address: "talk@" + LISTS,
                contactListId: ids.plain,
                enabled: "Y",
                revision: 1,
                createdAt: ec.user.nowTimestamp
            })
            const elsewhere = mail("newcomer@held.test", "talk@" + LISTS, "Other words", "MLS-HELD-PLAIN")
            // the link's token, known here; another account's address does not claim it
            lib.set(
                "mantle.forum.ForumHeldMail",
                {heldId: first.heldId},
                {tokenHash: ec.user.singleUseCodeHash("mls-held-token")}
            )
            const wrong = lib.op("MLS_MEMBER", SITE, "claimHeldMail", {token: "mls-held-token", operationId: "mls-claim-1"})
            const unknown = lib.op("MLS_MEMBER", SITE, "claimHeldMail", {token: "mls-no-token", operationId: "mls-claim-2"})
            const postedBefore = posts(ids.list).filter(post => /MLS-HELD/.test(post.body)).length
            // the sender makes an account, joins and verifies the address: what waited is posted as that account
            lib.account(SITE, "MLS_NEWCOMER", {handle: "mlsnewcomer", unconfirmed: true})
            lib.settled(SITE, "MLS_NEWCOMER")
            lib.set("moqui.security.UserAccount", {userId: "MLS_NEWCOMER"}, {emailAddress: "newcomer@held.test"})
            lib.make("moqui.security.public.VerifiedAddress", {
                userId: "MLS_NEWCOMER",
                emailAddress: "newcomer@held.test",
                verifiedAt: ec.user.nowTimestamp
            })
            lib.run("mantle.forum.ImportServices.claim#VerifiedAddress", {userId: "MLS_NEWCOMER"})
            // the first message is posted; the second waits out the time between two posts and is claimed by its link
            lib.settled(SITE, "MLS_NEWCOMER")
            const rest = held("newcomer@held.test").find(row => row.state === "held")
            if (rest) {
                lib.set(
                    "mantle.forum.ForumHeldMail",
                    {heldId: rest.heldId},
                    {tokenHash: ec.user.singleUseCodeHash("mls-held-rest")}
                )
                lib.op("MLS_NEWCOMER", SITE, "claimHeldMail", {token: "mls-held-rest", operationId: "mls-claim-3"})
            }
            // past its time a claimed message loses its sender's address and subject
            for (const row of held("newcomer@held.test"))
                lib.set("mantle.forum.ForumHeldMail", {heldId: row.heldId}, {expiresAt: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000})
            const ids0 = held("newcomer@held.test").map(row => row.heldId)
            const expired = lib.run("mantle.forum.DeliveryServices.expire#HeldMail", {})
            return {
                cleared: [
                    expired.cleared >= 2,
                    ids0.map(heldId => lib.row("mantle.forum.ForumHeldMail", {heldId})).every(row => !row.senderAddress && !row.subject)
                ],
                first,
                second,
                waiting: waiting.map(row => row.state + " " + row.targetType).sort(),
                item,
                plainRoute: !!plainRoute,
                elsewhere,
                wrong,
                unknown,
                postedBefore,
                posted: posts(ids.list)
                    .filter(post => /MLS-HELD/.test(post.body))
                    .map(post => post.fromPartyId + " " + post.visibility + " " + post.subject),
                after: ids0.map(heldId => lib.row("mantle.forum.ForumHeldMail", {heldId})).map(row => row.state + " " + (row.body == null)),
                queueAfter: lib
                    .op("MLS_OWNER", SITE, "findReviews", {contactListId: ids.list})
                    .reviewList.filter(review => review.targetType === "mail").length
            }
        },
        then({cleared, first, second, waiting, item, elsewhere, wrong, unknown, postedBefore, posted, after, queueAfter}) {
            cleared == [true, true]
            first.result == "held"
            first.notice == true
            // one reply an address a day
            second.result == "held"
            second.notice == false
            waiting == ["held category", "held category"]
            item.review.reasonFamily == "mail-held"
            item.review.detail.includes("MLS-HELD") == true
            item.held.senderAddress == "newcomer@held.test"
            elsewhere.result == "held"
            elsewhere.heldId == null
            wrong.kind == "Unauthorized"
            unknown.kind == "NotFound"
            postedBefore == 0
            posted == ["MLS_NEWCOMER approved First words", "MLS_NEWCOMER approved More words"]
            after == ["claimed true", "claimed true"]
            queueAfter == 0
        }
    }
)

feature("mail the gateway marked as spam is held for review: not posted, not dropped, and its sender is not answered", {
    when() {
        const to = "dev@" + LISTS
        lib.settled(SITE, "MLS_MEMBER")
        const byVerdict = mail("mls_member@smithy.test", to, "Buy now", "MLS-SPAM-ONE", {
            spamVerdict: {spam: true, reason: "score 9.1"}
        })
        lib.settled(SITE, "MLS_MEMBER")
        // the verdict fields the gateway left on the message say the same
        const byHeader = lib.run("mantle.forum.DeliveryServices.process#Inbound", {
            emailMessageId: null,
            headers: {
                "delivered-to": to,
                "message-id": "<mls-spam-2@mls.test>",
                "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test",
                "x-spam-flag": "YES",
                from: "mls_member@smithy.test"
            },
            fields: {from: "mls_member@smithy.test", subject: "Buy more", toList: [to]},
            bodyPartList: [{contentType: "text/plain", contentText: "MLS-SPAM-TWO"}]
        }).result
        lib.settled(SITE, "MLS_MEMBER")
        const clean = mail("mls_member@smithy.test", to, "A real question", "MLS-CLEAN")
        // spam from an address that is no account's is kept as a receipt alone: no held message, no reply
        const stranger = mail("spammer@spam.test", to, "Buy", "MLS-SPAM-THREE", {spamVerdict: {spam: true}})
        const found = posts(ids.list).filter(post => /MLS-(SPAM|CLEAN)/.test(post.body))
        return {
            byVerdict,
            byHeader,
            clean,
            stranger,
            found: found.map(post => post.subject + " " + post.visibility),
            families: found
                .map(
                    post =>
                        lib.row("mantle.forum.ForumReviewItem", {
                            siteId: SITE,
                            targetType: "post",
                            targetId: post.communicationEventId
                        })?.reasonFamily || "none"
                )
                .sort(),
            listed: lib
                .op(null, SITE, "findTopics", {contactListId: ids.list})
                .topicList.map(topic => topic.title)
                .filter(title => /Buy/.test(title)),
            strangerHeld: held("spammer@spam.test").length
        }
    },
    then({byVerdict, byHeader, clean, stranger, found, families, listed, strangerHeld}) {
        byVerdict.result == "pending"
        byHeader.result == "pending"
        clean.result == "posted"
        found == ["A real question approved", "Buy now pending", "Buy more pending"]
        families == ["mail-verdict", "mail-verdict", "none"]
        listed == []
        stranger.result == "held"
        stranger.heldId == null
        strangerHeld == 0
    }
})

feature(
    "a message the listener stored in Junk that is to a list is given to the forum with the verdict; one in another folder is left alone",
    {
        when() {
            const folder = (emailFolderId, folderKindEnumId) =>
                lib.make("moqui.basic.email.EmailFolder", {
                    emailFolderId,
                    folderName: emailFolderId,
                    folderPath: emailFolderId,
                    folderKindEnumId
                })
            // stored as viewed, so the rule of a received message (which runs after its commit) does not also take it
            const stored = (emailMessageId, emailFolderId, subject, emailAccountId = "MLS_FORUM_ACCOUNT") =>
                lib.make("moqui.basic.email.EmailMessage", {
                    emailMessageId,
                    emailAccountId,
                    statusId: "ES_VIEWED",
                    emailFolderId,
                    fromAddress: "mls_member@smithy.test",
                    toAddresses: "dev@" + LISTS,
                    subject,
                    bodyText: "MLS-JUNK " + subject,
                    messageId: "<" + emailMessageId + "@mls.test>",
                    headersString:
                        "From: mls_member@smithy.test\nDelivered-To: dev@" +
                        LISTS +
                        "\nAuthentication-Results: gw.example.test;\n dmarc=pass header.from=smithy.test\nX-Spam-Status: Yes, score=9.4"
                })
            folder("MLS_JUNK", "EfkJunk")
            folder("MLS_INBOX", "EfkInbox")
            stored("MLS_JUNK_MESSAGE", "MLS_JUNK", "Junk offer")
            stored("MLS_INBOX_MESSAGE", "MLS_INBOX", "Inbox words")
            // the same message in a user's own synced mailbox, whose header fields its owner writes, is not the forum's
            stored("MLS_USER_MESSAGE", "MLS_JUNK", "Mine", "MLS_USER_ACCOUNT")
            lib.settled(SITE, "MLS_MEMBER")
            const junk = lib.run("mantle.forum.DeliveryServices.process#JunkInbound", {emailMessageId: "MLS_JUNK_MESSAGE"}).result
            const post = posts(ids.list).find(row => /MLS-JUNK/.test(row.body))
            return {
                junk,
                user: lib.run("mantle.forum.DeliveryServices.process#JunkInbound", {emailMessageId: "MLS_USER_MESSAGE"}).result,
                // and so for the email rule of an Inbox message in it
                userRule: lib.run("mantle.forum.DeliveryServices.process#Inbound", {
                    emailAccountId: "MLS_USER_ACCOUNT",
                    emailMessageId: null,
                    headers: {
                        "delivered-to": "dev@" + LISTS,
                        "message-id": "<mls-user-rule@mls.test>",
                        "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test"
                    },
                    fields: {from: "mls_member@smithy.test", subject: "Mine too", toList: ["dev@" + LISTS]},
                    bodyPartList: [{contentType: "text/plain", contentText: "MLS-USER-RULE"}]
                }).result,
                inbox: lib.run("mantle.forum.DeliveryServices.process#JunkInbound", {emailMessageId: "MLS_INBOX_MESSAGE"}).result,
                rule: lib.run("mantle.forum.DeliveryServices.handle#StoredEmail", {
                    emailMessageId: "MLS_INBOX_MESSAGE",
                    emailFolderId: "MLS_INBOX"
                }).junk,
                post: post.subject + " " + post.visibility,
                family: lib.row("mantle.forum.ForumReviewItem", {
                    siteId: SITE,
                    targetType: "post",
                    targetId: post.communicationEventId
                }).reasonFamily
            }
        },
        then({junk, user, userRule, inbox, rule, post, family}) {
            junk.result == "pending"
            user.handled == false
            userRule.handled == false
            inbox.handled == false
            rule == false
            post == "Junk offer pending"
            family == "mail-verdict"
        }
    }
)

feature("only the trusted gateway's Authentication-Results authenticate a sender: quoted strings, comments and a method's first result", {
    when() {
        const check = value => sys(() => forum().gatewayAuthenticated([value], "bob@sender.test"))
        return {
            plain: check("gw.example.test; dmarc=pass header.from=sender.test"),
            spaced: check("gw.example.test; dkim=pass header . d=sender.test"),
            quotedId: check('"gw.example.test" 1; dkim=pass header.i=@sender.test'),
            otherServer: check("mx.elsewhere.test; dmarc=pass header.from=sender.test"),
            inQuotes: check('gw.example.test; dkim=fail reason="x; dmarc=pass header.from=sender.test" header.d=sender.test'),
            inComment: check("gw.example.test (wrapped; dmarc=pass header.from=sender.test); spf=pass smtp.mailfrom=sender.test"),
            second: check("gw.example.test; dmarc=fail header.from=sender.test; dmarc=pass header.from=sender.test"),
            otherDomain: check("gw.example.test; dmarc=pass header.from=evil.test"),
            // SEC-PFS-64: a parent's DKIM signature is not the sender's; its domain's DMARC pass is
            parentDkim: sys(() => forum().gatewayAuthenticated(["gw.example.test; dkim=pass header.d=sender.test"], "bob@team.sender.test")),
            subDmarc: sys(() =>
                forum().gatewayAuthenticated(["gw.example.test; dmarc=pass header.from=team.sender.test"], "bob@team.sender.test")
            ),
            unset: withConf("smtp-server@authserv-id", null, () => check("gw.example.test; dmarc=pass header.from=sender.test"))
        }
    },
    then(out) {
        out == {
            plain: true,
            spaced: true,
            quotedId: true,
            otherServer: false,
            inQuotes: false,
            inComment: false,
            second: false,
            otherDomain: false,
            parentDkim: false,
            subDmarc: true,
            unset: false
        }
    }
})

feature("an archive goes only into a list, and a message over the byte cap is passed and counted; an author's handle is no reserved word", {
    when() {
        const location = "runtime://tmp/mantle-mbox-import/mls-cap.mbox"
        const message = (from, id, subject, body) =>
            "From " + from + " Mon Jan  1 10:00:00 2024\nFrom: Git <" + from + ">\nMessage-ID: <" + id + "@cap.test>\nSubject: " +
            subject + "\nDate: Mon, 1 Jan 2024 10:00:00 +0000\n\n" + body + "\n\n"
        ec.resource
            .getLocationReference(location)
            .putText(
                message("git@cap.test", "c1", "MLS cap one", "A short one.") +
                    message("git@cap.test", "c2", "MLS cap two", "Long text. ".repeat(200)) +
                    message("git@cap.test", "c3", "MLS cap three", "Another short one.")
            )
        const input = {contactListId: ids.list, archiveName: "mls-cap.mbox", checksum: ec.resource.digest(location, "sha256")}
        return withConf("pass@mbox-max-message-bytes", "1000", () => {
            const notList = lib.op("MLS_OWNER", SITE, "importMbox", {...input, contactListId: ids.plain})
            const started = lib.op("MLS_OWNER", SITE, "importMbox", input)
            for (let turn = 0; turn < 10; turn++) {
                lib.run("mantle.forum.OperationServices.advance#Run", {runId: started.runId, budget: 50})
                if (lib.row("mantle.forum.ForumJobRun", {runId: started.runId}).state !== "pending") break
            }
            const report = lib.op("MLS_OWNER", SITE, "getMboxImport", {importId: started.importId}).import.report
            const author = list("mantle.forum.ForumPostSearch", {siteId: SITE, contactListId: ids.list}).find(post =>
                /A short one/.test(post.body)
            )
            return {
                notList: notList.kind,
                report: [report.messages, report.oversize],
                handle: lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: author.fromPartyId}).handle
            }
        })
    },
    then({notList, report, handle}) {
        notList == "Unprocessable"
        report == [2, 1]
        handle != "git"
        handle.startsWith("git-") == true
    }
})

feature("an archived From that names a member's address in its name, or two addresses, is no one's: the member never claims it (SEC-PFS-81)", {
    when() {
        const location = "runtime://tmp/mantle-mbox-import/mls-spoof.mbox"
        const message = (from, id, subject) =>
            "From x@spoof.test Mon Jan  1 10:00:00 2024\nFrom: " + from + "\nMessage-ID: <" + id + "@spoof.test>\nSubject: " +
            subject + "\nDate: Mon, 1 Jan 2024 10:00:00 +0000\n\nMLS-MBOX-" + id + "\n\n"
        ec.resource
            .getLocationReference(location)
            .putText(
                message('"<mls_member@smithy.test>" <mbox.spoof@spoof.test>', "s1", "MLS mbox spoofed name") +
                    message("mls_member@smithy.test, mbox.spoof@spoof.test", "s2", "MLS mbox two authors") +
                    message('"Spoof Er" <mbox.spoof@spoof.test>', "s3", "MLS mbox plain")
            )
        const input = {contactListId: ids.list, archiveName: "mls-spoof.mbox", checksum: ec.resource.digest(location, "sha256")}
        const started = lib.op("MLS_OWNER", SITE, "importMbox", input)
        for (let turn = 0; turn < 10; turn++) {
            lib.run("mantle.forum.OperationServices.advance#Run", {runId: started.runId, budget: 50})
            if (lib.row("mantle.forum.ForumJobRun", {runId: started.runId}).state !== "pending") break
        }
        const report = lib.op("MLS_OWNER", SITE, "getMboxImport", {importId: started.importId}).import.report
        // the member's address is verified: a claim moves only an author of that very address
        lib.run("mantle.forum.ImportServices.claim#VerifiedAddress", {userId: "MLS_MEMBER"})
        const authorOf = marker =>
            list("mantle.forum.ForumPostSearch", {siteId: SITE, contactListId: ids.list}).find(post =>
                String(post.body).includes(marker)
            )?.fromPartyId
        const authorKey = address => String(ec.resource.digestText("mbox-author|" + address, "sha256")).slice(0, 32)
        return {
            counts: [report.messages, report.suspectFrom],
            authors: ["MLS-MBOX-s1", "MLS-MBOX-s2", "MLS-MBOX-s3"].map(authorOf),
            memberAuthor: list("mantle.forum.ForumImportMap", {
                siteId: SITE,
                sourceType: "mbox-author",
                sourceId: authorKey("mls_member@smithy.test")
            }).length,
            spoofAuthor: list("mantle.forum.ForumImportMap", {
                siteId: SITE,
                sourceType: "mbox-author",
                sourceId: authorKey("mbox.spoof@spoof.test")
            })[0]?.targetId
        }
    },
    then({counts, authors, memberAuthor, spoofAuthor}) {
        counts == [3, 2]
        authors.includes("MLS_MEMBER") == false
        authors[0] == authors[1]
        authors[2] == spoofAuthor
        authors[0] != spoofAuthor
        memberAuthor == 0
    }
})

feature("a reply to a list's message, by its reply address or by In-Reply-To, is a post in that topic", {
    when() {
        const to = "dev@" + LISTS
        const from = "mls_member@smithy.test"
        const sent = (address, subject, text, more = {}) =>
            lib.run("mantle.forum.DeliveryServices.process#Inbound", {
                emailMessageId: null,
                headers: {
                    "delivered-to": address,
                    "message-id": "<" + ec.user.randomString(16) + "@mls.test>",
                    "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test",
                    from,
                    ...more
                },
                fields: {from, subject, toList: [address]},
                bodyPartList: [{contentType: "text/plain; charset=utf-8", contentText: text}]
            }).result
        lib.settled(SITE, "MLS_MEMBER")
        const started = sent(to, "Replies by mail", "MLS-REPLY-ROOT")
        const root = posts(ids.list).find(post => String(post.body).includes("MLS-REPLY-ROOT")).rootCommEventId
        // the reply address a notice of the topic carries for this member
        const address = sys(() => forum().replyAddress(SITE, root, ids.list, "MLS_MEMBER", root))
        lib.settled(SITE, "MLS_MEMBER")
        const byToken = sent(address, "Re: Replies by mail", "MLS-REPLY-TOKEN")
        // a notice of the topic mailed to this member, its Message-ID the provider's, answered by In-Reply-To
        const outboxId = lib.make("mantle.forum.ForumOutbox", {
            siteId: SITE,
            communicationEventId: root,
            eventType: "post",
            state: "done",
            createdAt: ec.user.nowTimestamp
        }).outboxId
        lib.make("mantle.forum.ForumDelivery", {
            outboxId,
            siteId: SITE,
            partyId: "MLS_MEMBER",
            channel: "email",
            state: "sent",
            attempts: 1,
            revision: 1,
            providerId: "<mls-notice-1@mls.test>"
        })
        lib.settled(SITE, "MLS_MEMBER")
        const byReference = sent(to, "Re: Replies by mail", "MLS-REPLY-REFERENCE", {"in-reply-to": "<mls-notice-1@mls.test>"})
        const reply = marker => posts(ids.list).find(post => String(post.body).includes(marker))
        return {started, byToken, byReference, root, viaToken: reply("MLS-REPLY-TOKEN"), viaReference: reply("MLS-REPLY-REFERENCE")}
    },
    then({started, byToken, byReference, root, viaToken, viaReference}) {
        started.result == "posted"
        byToken.result == "posted"
        byReference.result == "posted"
        root != null
        viaToken.rootCommEventId == root
        viaToken.communicationEventId != root
        viaToken.fromPartyId == "MLS_MEMBER"
        viaReference.rootCommEventId == root
        viaReference.communicationEventId != root
    }
})

feature("the sender is the From address, never its display name: a name holding a member's address is held (SEC-PFS-81)", {
    when() {
        const to = "dev@" + LISTS
        const spoof = '"<mls_member@smithy.test>" <mls_other@smithy.test>'
        lib.settled(SITE, "MLS_MEMBER")
        // a polled message (no stored row): the rule's from text alone, a display name holding the member's address
        const polled = mail(spoof, to, "Spoofed by name", "MLS-SPOOF-POLLED")
        // a stored message of the forum's own account: its parsed address and name are read
        lib.make("moqui.basic.email.EmailMessage", {
            emailMessageId: "MLS_SPOOF_MESSAGE",
            emailAccountId: "MLS_FORUM_ACCOUNT",
            statusId: "ES_VIEWED",
            fromAddress: "mls_other@smithy.test",
            fromName: "<mls_member@smithy.test>",
            toAddresses: to,
            subject: "Spoofed and stored",
            bodyText: "MLS-SPOOF-STORED",
            messageId: "<mls-spoof-stored@mls.test>"
        })
        const stored = lib.run("mantle.forum.DeliveryServices.process#Inbound", {
            emailAccountId: "MLS_FORUM_ACCOUNT",
            emailMessageId: "MLS_SPOOF_MESSAGE",
            headers: {
                "delivered-to": to,
                "message-id": "<mls-spoof-stored@mls.test>",
                "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test",
                from: spoof
            },
            fields: {from: spoof, subject: "Spoofed and stored", toList: [to]},
            bodyPartList: [{contentType: "text/plain", contentText: "MLS-SPOOF-STORED"}]
        }).result
        // the same name as an encoded word: the rule's from text is decoded, its raw From field is not
        const encoded = mail(spoof, to, "Spoofed in a word", "MLS-SPOOF-ENCODED", {
            headers: {
                "delivered-to": to,
                "message-id": "<mls-spoof-encoded@mls.test>",
                "authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test",
                from: "=?utf-8?q?=3Cmls=5Fmember=40smithy=2Etest=3E?= <mls_other@smithy.test>"
            }
        })
        // two From addresses (one with a quoted local part, which the count does not see), no From field, a Sender of another
        // address where the gateway authenticated nothing, and stored fields cut short where a second From could be
        const withHeaders = (more, authenticated = true) => ({
            headers: {
                "delivered-to": to,
                "message-id": "<" + ec.user.randomString(16) + "@mls.test>",
                ...(authenticated ? {"authentication-results": "gw.example.test; dmarc=pass header.from=smithy.test"} : {}),
                ...more
            }
        })
        const member = "mls_member@smithy.test"
        const twoFrom = mail(member, to, "Two authors", "MLS-SPOOF-TWO", withHeaders({from: member + ", mls_other@smithy.test"}))
        const quotedLocal = mail(member, to, "Quoted local part", "MLS-SPOOF-QUOTED",
            withHeaders({from: '"mls_member"@smithy.test, mls_other@smithy.test'}))
        const noFrom = mail(member, to, "No From field", "MLS-SPOOF-NOFROM", withHeaders({}))
        const otherSender = mail(member, to, "Sent by another", "MLS-SPOOF-SENDER",
            withHeaders({from: member, sender: "Other <mls_other@smithy.test>"}, false))
        lib.make("moqui.basic.email.EmailMessage", {
            emailMessageId: "MLS_CUT_MESSAGE",
            emailAccountId: "MLS_FORUM_ACCOUNT",
            statusId: "ES_VIEWED",
            emailFolderId: "MLS_JUNK",
            fromAddress: member,
            toAddresses: to,
            subject: "Cut fields",
            bodyText: "MLS-SPOOF-CUT",
            messageId: "<mls-cut@mls.test>",
            headersString:
                "From: " + member + "\nDelivered-To: " + to +
                "\nAuthentication-Results: gw.example.test; dmarc=pass header.from=smithy.test\nX-Pad: " + "x".repeat(66000)
        })
        const cut = lib.run("mantle.forum.DeliveryServices.process#JunkInbound", {emailMessageId: "MLS_CUT_MESSAGE"}).result
        // the member's own mail, by address alone, with a display name, with a name that shows the member's own address (as
        // some mail programs write it), and sent through another Sender where the gateway's DMARC passed, still posts
        const plain = mail(member, to, "Mine by mail", "MLS-SPOOF-PLAIN")
        lib.settled(SITE, "MLS_MEMBER")
        const named = mail('"Member, MLS" <mls_member@smithy.test>', to, "Mine with my name", "MLS-SPOOF-NAMED")
        lib.settled(SITE, "MLS_MEMBER")
        const ownName = '"Member (mls_member@smithy.test)" <mls_member@smithy.test>'
        const ownAddress = mail(ownName, to, "Mine with my address", "MLS-SPOOF-OWN", withHeaders({from: ownName}))
        lib.settled(SITE, "MLS_MEMBER")
        const sentFor = mail(member, to, "Mine through an assistant", "MLS-SPOOF-SENTFOR",
            withHeaders({from: member, sender: "Assistant <mls_other@smithy.test>"}))
        const receipt = id => lib.row("mantle.forum.ForumInboundReceipt", {receiptId: id})
        return {
            polled,
            stored,
            plain,
            named,
            ownAddress,
            sentFor,
            heldReasons: [encoded, twoFrom, quotedLocal, noFrom, otherSender, cut].map(out => out.result + ": " + out.reason),
            senders: [receipt(polled.receiptId).senderAddress, receipt(stored.receiptId).senderAddress],
            found: posts(ids.list)
                .filter(post => /MLS-SPOOF/.test(post.body))
                .map(post => post.subject + " " + post.fromPartyId)
                .sort(),
            kept: held("mls_member@smithy.test").length + held("mls_other@smithy.test").length
        }
    },
    then({polled, stored, plain, named, ownAddress, sentFor, heldReasons, senders, found, kept}) {
        polled.result == "held"
        stored.result == "held"
        senders == ["mls_other@smithy.test", "mls_other@smithy.test"]
        heldReasons ==
            [
                "held: The sender's display name shows another email address",
                "held: The message names more than one From address",
                "held: The message names more than one From address",
                "held: The message has no From field",
                "held: The Sender field names another address than From",
                "held: The stored header fields were cut short"
            ]
        plain.result == "posted"
        named.result == "posted"
        ownAddress.result == "posted"
        sentFor.result == "posted"
        found ==
            [
                "Mine by mail MLS_MEMBER",
                "Mine through an assistant MLS_MEMBER",
                "Mine with my address MLS_MEMBER",
                "Mine with my name MLS_MEMBER"
            ]
        kept == 0
    }
})

feature("an invitation does not bring back a member staff suspended or removed; one who left joins again (SEC-PSS-43)", {
    when() {
        const hash = text => ec.user.singleUseCodeHash(text)
        const member = (id, state, setBy) => {
            lib.account(SITE, id, {member: true})
            lib.set("mantle.public.PublicSiteParty", {siteId: SITE, partyId: id}, {state, stateSetByPartyId: setBy})
            lib.make("mantle.public.PublicSiteInvitation", {
                invitationId: id + "_INV",
                siteId: SITE,
                tokenHash: hash(id + "-token"),
                emailHash: hash(id.toLowerCase() + "@smithy.test"),
                scopes: "[]",
                expiresAt: ec.user.timestampMillis(ec.user.nowTimestamp) + 3600000
            })
            return lib.op(id, SITE, "redeemInvitation", {token: id + "-token"})
        }
        const suspended = member("MLS_SUSPENDED", "suspended", "MLS_OWNER")
        const removed = member("MLS_REMOVED", "ended", "MLS_OWNER")
        const left = member("MLS_LEFT", "ended", "MLS_LEFT")
        const state = id => lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId: id}).state
        return {
            suspended,
            removed,
            left,
            states: ["MLS_SUSPENDED", "MLS_REMOVED", "MLS_LEFT"].map(state),
            unredeemed: lib.row("mantle.public.PublicSiteInvitation", {invitationId: "MLS_SUSPENDED_INV"}).redeemedAt
        }
    },
    then({suspended, removed, left, states, unredeemed}) {
        suspended.kind == "Unauthorized"
        removed.kind == "Unauthorized"
        left.state == "active"
        states == ["suspended", "ended", "active"]
        unredeemed == null
    }
})
