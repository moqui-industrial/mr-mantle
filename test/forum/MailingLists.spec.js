// Mailing lists (plans/Dogfood.md §6.3, §6.4, D17; ForumLists.js, Forum.js processInbound, DeliveryWorker.js): a category in
// list mode has its own List-Id, List-Post and List-Archive by its address; an mbox archive is imported once, threaded by
// its references (a reply before its parent in the file, a subject that answers one), an encoded subject and a flowed
// text read, a file left out, a duplicate Message-ID and a second run adding nothing, each author a profile with no
// account that shows a name and never an address, claimed by the account that verifies the address; an invitation
// subscribes only when it is redeemed; mail to a list from an address that is no account's is held and answered once,
// and posted as the account once the address is verified; and mail the gateway marked as spam is held for review.
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
            "authentication-results": "gw.example.test; dmarc=pass header.from=" + from.replace(/^.*@|>.*$/g, "")
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
        setProperty("pass_import_dir", "runtime://tmp/mantle-mbox-import")
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {siteId: SITE, hostname: "mls.example.test", canonical: "Y"})
        ids.list = category("Dev", "list", "dev@" + LISTS)
        ids.plain = category("Talk", "discussion", null)
        lib.account(SITE, "MLS_MEMBER", {handle: "mlsmember"})
        lib.settled(SITE, "MLS_MEMBER")
        lib.account(SITE, "MLS_OTHER", {handle: "mlsother"})
        lib.account(SITE, "MLS_OWNER", {member: true, siteRole: "owner"})
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
            before,
            wrong: lib.op("MLS_MEMBER", SITE, "redeemInvitation", {token: "mls-known-token"}),
            redeemed: lib.op("MLS_OTHER", SITE, "redeemInvitation", {token: "mls-known-token"}),
            after: subscribed(),
            member: list("mantle.marketing.contact.ContactListParty", {contactListId: ids.list}).map(
                row => row.partyId + " " + row.statusId
            )
        }
    },
    then({invited, again, notOwner, notList, before, wrong, redeemed, after, member}) {
        // two addresses invited (mail is not sent here: the site's template is not there), one not an address
        invited.invited + invited.unsent == 2
        invited.invalidCount == 1
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
            return {
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
                after: held("newcomer@held.test").map(row => row.state + " " + (row.body == null)),
                queueAfter: lib
                    .op("MLS_OWNER", SITE, "findReviews", {contactListId: ids.list})
                    .reviewList.filter(review => review.targetType === "mail").length
            }
        },
        then({first, second, waiting, item, elsewhere, wrong, unknown, postedBefore, posted, after, queueAfter}) {
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
                "x-spam-flag": "YES"
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
            const stored = (emailMessageId, emailFolderId, subject) =>
                lib.make("moqui.basic.email.EmailMessage", {
                    emailMessageId,
                    statusId: "ES_VIEWED",
                    emailFolderId,
                    fromAddress: "mls_member@smithy.test",
                    toAddresses: "dev@" + LISTS,
                    subject,
                    bodyText: "MLS-JUNK " + subject,
                    messageId: "<" + emailMessageId + "@mls.test>",
                    headersString:
                        "Delivered-To: dev@" +
                        LISTS +
                        "\nAuthentication-Results: gw.example.test;\n dmarc=pass header.from=smithy.test\nX-Spam-Status: Yes, score=9.4"
                })
            folder("MLS_JUNK", "EfkJunk")
            folder("MLS_INBOX", "EfkInbox")
            stored("MLS_JUNK_MESSAGE", "MLS_JUNK", "Junk offer")
            stored("MLS_INBOX_MESSAGE", "MLS_INBOX", "Inbox words")
            lib.settled(SITE, "MLS_MEMBER")
            const junk = lib.run("mantle.forum.DeliveryServices.process#JunkInbound", {emailMessageId: "MLS_JUNK_MESSAGE"}).result
            const post = posts(ids.list).find(row => /MLS-JUNK/.test(row.body))
            return {
                junk,
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
        then({junk, inbox, rule, post, family}) {
            junk.result == "pending"
            inbox.handled == false
            rule == false
            post == "Junk offer pending"
            family == "mail-verdict"
        }
    }
)
