// The forum's staff and member limits (plans/Security-Review-Low.md, the SEC-PFS and SEC-PSF entries named in each feature):
// ending a sanction asks a rank above its member's, as setting one does (ForumModeration.js endSanction); a category's own
// staff read a member's scope, not the member's site-wide state (getMember); a join request is asked once, by a member in
// good standing (Forum.js joinCategory); an owner's membership is changed only after a recent sign-in (setMembership,
// require#RecentAuth); the author or staff hide a post's earlier versions from readers as they edit or later, and show
// them again (updatePost, setPostHistory); drafts and previews are held to the post's limits, a member's draft count and
// an expiry (storeDraft, previewPost, cleanup#Drafts); a member asks one export at a time, a staff member makes a bounded
// number of report files a day, a site runs one operation of a kind at a time, and the dispatcher takes each site's oldest
// run in turn (ForumOperations.js); a site's owners invite a bounded number of addresses a day (ForumLists.js
// inviteListMembers); a site sends only as a sender of its own host name or one the operator names for it, checked again
// at send time (storeMailSettings, ForumCore.js mailSettings); a list's archive is named only in the site's own import
// directory, with one answer for a missing file and a wrong checksum, read once for its size and time and a bounded number
// of times a day (importMbox); a topic links and shows only what is the site's (linkDiscussion, getTopicLinks); and a
// member's HTML keeps an image only of the site's attachment downloads under its forum mount, in mail none (ForumCore.js
// memberHtml). Spec-local site, categories and accounts, through the PASS authority as a page's call arrives. Regression
// suite: these are rules. Run: ./moq test mr-mantle --spec ForumStaffRules
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "FSR_SITE"
const HOST = "fsr.example.test"
const ids = {}
const op = (username, operation, input = {}) => lib.op(username, SITE, operation, input)
const kind = out => out.kind || null
const operationId = () => "fsr-" + ec.user.randomString(16)
const count = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().count()
const revisions = out => (out.revisionList || []).map(row => Number(row.revision))
/* A published public category, made as rows; more adds ForumCategory fields. */
function category(name, mode, more = {}) {
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
        policyRevision: 1,
        ...more
    })
    return contactListId
}
/* An operation as a user signed in by an internal login, which is no recent sign-in (require#RecentAuth): as the user of
   a session whose sign-in is older than five minutes. */
function internalOp(username, operation, input = {}) {
    ec.user.logoutUser()
    ec.user.internalLoginUser(username)
    try {
        const out = ec.resource
            .script("component://mr-mantle/script/PassAuthority.js")
            .handle({siteId: SITE, operation, input, sessionChecked: true})
        return out.error ? {kind: out.error.code, reason: out.error.reason, message: out.error.message} : out.result
    } finally {
        ec.message.clearErrors()
        ec.user.loginUser(lib.OPERATOR, "moqui")
    }
}
const forum = () => ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
const core = () => ec.resource.script("component://mr-mantle/service/mantle/forum/ForumCore.js")
const membershipRevision = partyId => Number(lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId}).revision)

spec({
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {siteId: SITE, hostname: HOST, canonical: "Y"})
        lib.account(SITE, "FSR_OWNER", {member: true, siteRole: "owner", handle: "fsrowner"})
        lib.account(SITE, "FSR_OWNER2", {member: true, siteRole: "owner", handle: "fsrowner2"})
        lib.account(SITE, "FSR_MOD", {member: true, siteRole: "moderator", handle: "fsrmod"})
        lib.account(SITE, "FSR_MOD2", {member: true, siteRole: "moderator", handle: "fsrmod2"})
        lib.account(SITE, "FSR_LMOD", {member: true, handle: "fsrlmod"})
        lib.account(SITE, "FSR_ANN", {member: true, handle: "fsrann"})
        lib.account(SITE, "FSR_BEN", {member: true, handle: "fsrben"})
        lib.account(SITE, "FSR_SUS", {member: true, handle: "fsrsus"})
        // an account of the deployment that is no member of the site
        lib.account(SITE, "FSR_OUT")
        for (const partyId of ["FSR_OWNER", "FSR_OWNER2", "FSR_MOD", "FSR_MOD2", "FSR_LMOD", "FSR_ANN", "FSR_BEN", "FSR_SUS"])
            lib.settled(SITE, partyId)
        ids.general = category("FSR general", "discussion")
        ids.approval = category("FSR approval", "discussion", {joinApprovalRequired: "Y"})
        ids.list = category("FSR list", "list")
        lib.make("mantle.marketing.contact.ContactListParty", {
            contactListId: ids.general,
            partyId: "FSR_LMOD",
            roleTypeId: "ListModerator",
            statusId: "CLPT_ACCEPTED",
            fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000
        })
        // for the whole spec, and put back after it (setConf)
        setConf("pass@media-root", "runtime://tmp/fsr-media")
    }
})

feature("SEC-PFS-88: a sanction is ended only by staff of a higher rank than its member, never by the member", {
    when() {
        const silence = op("FSR_OWNER", "setSanction", {
            targetPartyId: "FSR_MOD",
            kind: "silence",
            reason: "Cool off",
            operationId: operationId()
        })
        const end = (username, reason) =>
            op(username, "endSanction", {sanctionId: silence.sanctionId, expectedRevision: 1, reason})
        return {silence, own: end("FSR_MOD", "Mine to end"), owner: end("FSR_OWNER", "Done")}
    },
    then({silence, own, owner}) {
        silence.sanctionId != null
        own.kind == "Unprocessable"
        owner.revision == 2
    }
})

feature("SEC-PFS-89: a category's own moderator reads a member's scope there, not the membership or the site's statistics", {
    when() {
        const ask = username => op(username, "getMember", {contactListId: ids.general, targetPartyId: "FSR_ANN"})
        return {listModerator: ask("FSR_LMOD"), siteModerator: ask("FSR_MOD")}
    },
    then({listModerator, siteModerator}) {
        listModerator.kind == null
        listModerator.membership == null
        listModerator.memberState == null
        listModerator.scopeActivity.postCount == 0
        siteModerator.membership.state == "active"
        siteModerator.memberState.trustLevel == "basic"
    }
})

feature("SEC-PFS-97: a join request is asked once, and a member suspended from the site asks none", {
    when() {
        const join = username => op(username, "joinCategory", {contactListId: ids.approval})
        const first = join("FSR_BEN")
        const second = join("FSR_BEN")
        lib.sanction(SITE, "FSR_SUS", "suspend")
        return {
            first,
            second,
            requests: count("mantle.marketing.contact.ContactListParty", {contactListId: ids.approval, partyId: "FSR_BEN"}),
            suspended: join("FSR_SUS"),
            suspendedRows: count("mantle.marketing.contact.ContactListParty", {contactListId: ids.approval, partyId: "FSR_SUS"})
        }
    },
    then({first, second, requests, suspended, suspendedRows}) {
        first.state == "pending"
        second.state == "pending"
        requests == 1
        suspended.kind == "Unauthorized"
        suspendedRows == 0
    }
})

feature("SEC-PFS-96: an owner's membership is changed only after a recent sign-in, with no password asked", {
    when() {
        const change = (call, state) =>
            call("FSR_OWNER", "setMembership", {
                targetPartyId: "FSR_OWNER2",
                state,
                expectedRevision: membershipRevision("FSR_OWNER2"),
                reason: "Owner review"
            })
        const stale = change(internalOp, "suspended")
        // lib.op signs in with the password: a sign-in a moment ago
        const recent = change(op, "suspended")
        const after = lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId: "FSR_OWNER2"}).state
        const restored = change(op, "active")
        // a member who is no owner is changed with no sign-in asked
        const member = internalOp("FSR_OWNER", "setMembership", {
            targetPartyId: "FSR_ANN",
            state: "active",
            expectedRevision: membershipRevision("FSR_ANN"),
            reason: "No change"
        })
        // a password is no field of the operation any more
        const password = op("FSR_OWNER", "setMembership", {
            targetPartyId: "FSR_ANN",
            state: "active",
            expectedRevision: membershipRevision("FSR_ANN"),
            reason: "No change",
            password: "moqui"
        })
        return {stale, recent, after, restored, member, password}
    },
    then({stale, recent, after, restored, member, password}) {
        stale.kind == "AuthenticationRequired"
        stale.reason == "reauthRequired"
        recent.kind == null
        after == "suspended"
        restored.kind == null
        member.kind == null
        password.kind == "Unprocessable"
    }
})

feature("SEC-PFS-86: the author or staff hide a post's earlier versions from readers, as they edit or later, and show them again", {
    when() {
        lib.settled(SITE, "FSR_ANN")
        const topic = op("FSR_ANN", "publishPost", {
            contactListId: ids.general,
            title: "FSR history",
            body: "<p>Call me at 555-0100</p>",
            operationId: operationId()
        })
        const postId = topic.rootCommEventId
        const edited = op("FSR_ANN", "updatePost", {postId, body: "<p>Call me</p>", expectedRevision: 1, hideHistory: true})
        const reader = revisions(op("FSR_BEN", "getPostHistory", {postId}))
        const compare = kind(op("FSR_BEN", "comparePostRevisions", {postId, fromRevision: 1, toRevision: 2}))
        const author = revisions(op("FSR_ANN", "getPostHistory", {postId}))
        // the author shows them again
        const shown = op("FSR_ANN", "setPostHistory", {postId, history: "shown"})
        const readerAgain = revisions(op("FSR_BEN", "getPostHistory", {postId}))
        // a staff edit of another member's post keeps its history readable unless the editor asks
        lib.settled(SITE, "FSR_BEN")
        const reply = op("FSR_BEN", "publishPost", {rootCommEventId: postId, body: "<p>FSR abuse</p>", operationId: operationId()})
        const moderated = op("FSR_MOD", "updatePost", {
            postId: reply.postId,
            body: "<p>Removed by a moderator</p>",
            expectedRevision: 1,
            reason: "Abuse"
        })
        const keptByDefault = revisions(op("FSR_ANN", "getPostHistory", {postId: reply.postId}))
        const staffHides = op("FSR_MOD", "setPostHistory", {postId: reply.postId, history: "hidden", reason: "Abuse"})
        const hiddenByStaff = revisions(op("FSR_ANN", "getPostHistory", {postId: reply.postId}))
        // a reader who is neither the author nor staff does not
        const stranger = op("FSR_ANN", "setPostHistory", {postId: reply.postId, history: "shown"})
        return {edited, reader, compare, author, shown, readerAgain, moderated, keptByDefault, staffHides, hiddenByStaff, stranger}
    },
    then({edited, reader, compare, author, shown, readerAgain, moderated, keptByDefault, staffHides, hiddenByStaff, stranger}) {
        edited.kind == null
        reader == [2]
        compare == "NotFound"
        author == [2, 1]
        shown.history == "shown"
        readerAgain == [2, 1]
        moderated.kind == null
        keptByDefault == [2, 1]
        staffHides.history == "hidden"
        hiddenByStaff == [2]
        stranger.kind == "Unauthorized"
    }
})

feature("SEC-PFS-92: a draft is a member's, within the post's length and the member's count, and an untouched one expires", {
    when() {
        const draft = (username, body, title = "FSR draft") =>
            kind(op(username, "storeDraft", {contactListId: ids.general, title, body, expectedRevision: 0}))
        const tooLong = "x".repeat(100001)
        const out = withConf("mantle@forum-drafts-per-member", "2", () => ({
            outsider: draft("FSR_OUT", "Not a member"),
            long: draft("FSR_BEN", tooLong),
            longTitle: draft("FSR_BEN", "Text", "t".repeat(251)),
            preview: kind(op("FSR_BEN", "previewPost", {body: tooLong})),
            made: [1, 2, 3].map(n => draft("FSR_BEN", "Draft " + n))
        }))
        // one draft untouched for two days, past forum-draft-days
        const old = Array.from(
            ec.entity.find("mantle.forum.ForumDraft").condition({siteId: SITE, partyId: "FSR_BEN"}).disableAuthz().list()
        )[0]
        lib.set("mantle.forum.ForumDraft", {draftId: old.draftId}, {
            updatedAt: new Date(ec.user.timestampMillis(ec.user.nowTimestamp) - 2 * 86400000)
        })
        // 0 keeps every draft; 1 removes the one untouched for two days
        withConf("mantle@forum-draft-days", "0", () => lib.run("mantle.forum.OperationServices.cleanup#Drafts", {}))
        out.kept = count("mantle.forum.ForumDraft", {siteId: SITE, partyId: "FSR_BEN"})
        withConf("mantle@forum-draft-days", "1", () => lib.run("mantle.forum.OperationServices.cleanup#Drafts", {}))
        out.left = count("mantle.forum.ForumDraft", {siteId: SITE, partyId: "FSR_BEN"})
        return out
    },
    then({outsider, long, longTitle, preview, made, kept, left}) {
        outsider == "Unauthorized"
        long == "Unprocessable"
        longTitle == "Unprocessable"
        preview == "Unprocessable"
        made == [null, null, "Unprocessable"]
        kept == 2
        left == 1
    }
})

feature("SEC-PFS-93: one open export per member, a day's report files per staff member, one pending operation per site", {
    when() {
        return withConf("mantle@forum-report-exports-per-day", "1", () => ({
            firstExport: op("FSR_BEN", "requestPersonalDataAction", {kind: "export"}),
            secondExport: op("FSR_BEN", "requestPersonalDataAction", {kind: "export"}),
            firstReport: op("FSR_MOD", "exportReport", {report: "activity"}),
            secondReport: op("FSR_MOD", "exportReport", {report: "activity"}),
            firstRun: op("FSR_OWNER", "startOperation", {operation: "rebuild-counters", reason: "Check"}),
            secondRun: op("FSR_OWNER", "startOperation", {operation: "rebuild-counters", reason: "Again"})
        }))
    },
    then({firstExport, secondExport, firstReport, secondReport, firstRun, secondRun}) {
        firstExport.state == "running"
        secondExport.kind == "Conflict"
        firstReport.exportId != null
        secondReport.kind == "Tarpit"
        firstRun.runId != null
        secondRun.kind == "Conflict"
    }
})

feature("SEC-PFS-93: the dispatcher takes each site's oldest pending run in turn, whatever another site has waiting", {
    when() {
        // a busy site with 60 runs waiting since an hour ago, and a quiet one with one run made now
        const at = ec.user.timestampMillis(ec.user.nowTimestamp)
        const run = (siteId, n, createdAt) =>
            lib.make("mantle.forum.ForumJobRun", {
                runId: siteId + "_" + n,
                siteId,
                jobType: "op-rebuild-counters",
                state: "pending",
                checkpoint: "{}",
                createdAt,
                successCount: 0,
                failedCount: 0
            })
        lib.site("FSR_BUSY")
        lib.site("FSR_QUIET")
        for (let n = 0; n < 60; n++) run("FSR_BUSY", n, new Date(at - 3600000 + n))
        run("FSR_QUIET", 0, new Date(at))
        const taken = lib.privileged(() => forum().fairRuns(50)).map(row => row.siteId)
        for (const row of Array.from(
            ec.entity.find("mantle.forum.ForumJobRun").condition("runId", "like", "FSR_%").disableAuthz().list()
        ))
            lib.set("mantle.forum.ForumJobRun", {runId: row.runId}, {state: "complete"})
        return {taken}
    },
    then({taken}) {
        taken.length == 50
        taken.includes("FSR_QUIET")
        taken.filter(siteId => siteId === "FSR_BUSY").length >= 25
    }
})

feature("SEC-PFS-99: a site sends only as a sender of its own host name or one the operator names for it, checked at send time", {
    when() {
        for (const [emailTemplateId, fromAddress] of [
            ["FSR_OWN", "forum@" + HOST],
            ["FSR_PARENT", "forum@example.test"],
            ["FSR_OTHER", "forum@other.test"]
        ])
            lib.make("moqui.basic.email.EmailTemplate", {
                emailTemplateId,
                description: emailTemplateId,
                fromAddress,
                subject: "${title}",
                bodyScreenLocation: "component://mr-mantle/screen/NoScreen.xml"
            })
        const store = (username, senderAddress, templateId, expectedRevision) =>
            op(username, "storeMailSettings", {senderAddress, senderName: "FSR", templateId, expectedRevision})
        const senders = "forum@" + HOST + ",forum@example.test,forum@other.test"
        return withConf("pass@sender-addresses", senders, () =>
            withConf("pass@mail-template-ids", "FSR_OWN,FSR_PARENT,FSR_OTHER", () => {
                // a parent domain is a sibling site's too (another.example.test), and another domain is another site's
                const parent = store("FSR_OWNER", "forum@example.test", "FSR_PARENT", 0)
                const other = store(lib.OPERATOR, "forum@other.test", "FSR_OTHER", 0)
                const own = store("FSR_OWNER", "forum@" + HOST, "FSR_OWN", 0)
                // the operator names the site for a sender of a custom domain
                const named = withConf("mantle@forum-sender-sites", "forum@other.test=" + SITE + ";FSR_ELSEWHERE", () =>
                    store("FSR_OWNER", "forum@other.test", "FSR_OTHER", 1)
                )
                // sent with what is stored only while the operator's registration still holds it
                const atSend = lib.privileged(() => core().mailSettings(SITE))
                const back = store("FSR_OWNER", "forum@" + HOST, "FSR_OWN", 2)
                return {parent, other, own, named, atSend, back}
            })
        )
    },
    then({parent, other, own, named, atSend, back}) {
        parent.kind == "Unprocessable"
        parent.message.includes("ask the operator")
        other.kind == "Unprocessable"
        own.revision == 1
        named.revision == 2
        atSend == null
        back.revision == 3
    }
})

feature("SEC-PFS-94: a site's owners invite at most a day's count of addresses, all lists together", {
    when() {
        setConf("mantle@forum-owner-invitations-per-day", "2")
        // outbound mail through a template the deployment does not have: the invitation is made and its mail not sent
        const settings = {senderAddress: "forum@" + HOST, senderName: "FSR", templateId: "FSR_NO_TEMPLATE"}
        if (lib.row("mantle.forum.ForumMailSettings", {siteId: SITE})) lib.set("mantle.forum.ForumMailSettings", {siteId: SITE}, settings)
        else lib.make("mantle.forum.ForumMailSettings", {siteId: SITE, revision: 1, ...settings})
        const invite = (username, addresses) =>
            op(username, "inviteListMembers", {contactListId: ids.list, addresses, operationId: operationId()})
        const out = {
            first: invite("FSR_OWNER", ["fsr1@invite.test", "fsr2@invite.test", "fsr3@invite.test"]),
            second: invite("FSR_OWNER2", ["fsr4@invite.test"])
        }
        setConf("mantle@forum-owner-invitations-per-day", "")
        return out
    },
    then({first, second}) {
        first.invited + first.unsent == 2
        first.limitedCount == 1
        second.limitedCount == 1
    }
})

feature("SEC-PFS-100: a list's archive is named in the site's own import directory, read once and a bounded number of times a day", {
    when() {
        const put = (location, text) => {
            ec.resource.getLocationReference(location).putText(text)
            return ec.resource.digest(location, "sha256")
        }
        const mbox = "From a@fsr.test Mon Jan  1 00:00:00 2024\nFrom: a@fsr.test\nSubject: FSR\n\nText\n"
        return withConf("pass@import-dir", "runtime://tmp/fsr-import", () => {
            // another site's archive at the top of the shared directory, and two of this site's
            const otherSum = put("runtime://tmp/fsr-import/fsr-other.mbox", mbox + "other\n")
            const ownSum = put("runtime://tmp/fsr-import/" + SITE + "/fsr-own.mbox", mbox)
            put("runtime://tmp/fsr-import/" + SITE + "/fsr-second.mbox", mbox + "second\n")
            const start = (archiveName, checksum) => op("FSR_OWNER", "importMbox", {contactListId: ids.list, archiveName, checksum})
            const reads = () =>
                JSON.parse(
                    lib.row("mantle.forum.ForumImportMap", {
                        siteId: SITE,
                        sourceType: "mbox-read-day",
                        sourceId: (SITE + "|" + core().dayKey()).slice(0, 40)
                    })?.payload || "{}"
                ).count || 0
            return withConf("mantle@forum-archive-reads-per-day", "2", () => {
                const other = start("fsr-other.mbox", otherSum)
                const missing = start("fsr-none.mbox", otherSum)
                const wrong = start("fsr-own.mbox", otherSum)
                // the same file of the same size and time is not read again for another wrong checksum
                const wrongAgain = start("fsr-own.mbox", "0".repeat(64))
                const afterWrong = reads()
                const own = start("fsr-own.mbox", ownSum)
                // a second file is a second read; a third read in the day is refused
                const second = start("fsr-second.mbox", "0".repeat(64))
                put("runtime://tmp/fsr-import/" + SITE + "/fsr-own.mbox", mbox + "changed\n")
                const third = start("fsr-own.mbox", "0".repeat(64))
                return {
                    other: [other.kind, other.message],
                    missing: [missing.kind, missing.message],
                    wrong: [wrong.kind, wrong.message],
                    wrongAgain: [wrongAgain.kind, wrongAgain.message],
                    afterWrong,
                    own,
                    second: second.kind,
                    third: [third.kind, third.reason]
                }
            })
        })
    },
    then({other, missing, wrong, wrongAgain, afterWrong, own, second, third}) {
        other[0] == "Conflict"
        missing == wrong
        other == wrong
        wrongAgain == wrong
        afterWrong == 1
        own.runId != null
        second == "Conflict"
        third == ["Tarpit", "limitReached"]
    }
})

feature("SEC-PSF-81: a member's HTML keeps an image only of the site's attachment downloads under its forum mount, in mail none", {
    when() {
        lib.settled(SITE, "FSR_BEN")
        const html =
            '<p>FSR images<img src="/shop/Checkout/begin" alt="a cart"><img src="https://tracker.example/p.gif" alt="pixel">' +
            '<img src="/forum/t/1/a/download?attachmentId=FSRATT1" alt="photo">' +
            '<img src="//tracker.example/forum/download?attachmentId=FSRATT2" alt="host">' +
            '<img src="/forum/../shop/download?attachmentId=FSRATT3" alt="up">' +
            '<img src="/forum/./download?attachmentId=FSRATT4" alt="dot">' +
            '<img src="/shop/download?attachmentId=FSRATT5" alt="elsewhere"></p>'
        const topic = op("FSR_BEN", "publishPost", {contactListId: ids.general, title: "FSR images", body: html, operationId: operationId()})
        const revision = Number(lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: "FSR_BEN"}).revision)
        const profile = op("FSR_BEN", "storeProfile", {
            handle: "fsrben",
            displayName: "Ben",
            bio: '<p>Hi<img src="/shop/Checkout/begin"></p>',
            expectedRevision: revision
        })
        // a bio stored before the rule is cleaned when it is read
        lib.set("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: "FSR_BEN"}, {bio: '<p>Old<img src="/shop/Checkout/begin"></p>'})
        return {
            body: lib.row("mantle.party.communication.CommunicationEvent", {communicationEventId: topic.rootCommEventId}).body,
            bio: lib.row("mantle.public.PublicSiteProfile", {siteId: SITE, partyId: "FSR_BEN"}).bio,
            readBio: op("FSR_ANN", "getProfile", {handle: "fsrben"}).profile.bio,
            profile,
            mail: core().memberHtml(html, SITE, true)
        }
    },
    then({body, bio, readBio, profile, mail}) {
        profile.kind == null
        !body.includes('src="/shop')
        body.includes("a cart")
        !body.includes('src="https://tracker.example')
        body.includes('href="https://tracker.example/p.gif"')
        body.includes('src="/forum/t/1/a/download?attachmentId=FSRATT1"')
        !body.includes("FSRATT2")
        !body.includes("FSRATT3")
        !body.includes("FSRATT4")
        !body.includes("FSRATT5")
        bio.includes("<img")
        !readBio.includes("<img")
        readBio.includes("Old")
        !mail.includes("<img")
        mail.includes("photo")
    }
})
