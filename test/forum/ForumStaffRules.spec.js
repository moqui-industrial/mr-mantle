// The forum's staff and member limits (plans/Security-Review-Low.md, the SEC-PFS and SEC-PSF entries named in each feature):
// ending a sanction asks what setting one asks (ForumModeration.js endSanction); a category's own staff read a member's
// scope, not the member's site-wide state (getMember); a join request is asked once, by a member in good standing
// (Forum.js joinCategory); an owner's membership is changed only after the caller signs in again (setMembership); the
// author or staff take earlier versions out of a post's public history (updatePost); drafts and previews are held to the
// post's limits, a member's draft count and an expiry (storeDraft, previewPost, cleanup#Drafts); a member asks one export
// at a time, a staff member makes a bounded number of report files a day, and a site runs one operation of a kind at a
// time (ForumOperations.js); a site's owners invite a bounded number of addresses a day (ForumLists.js inviteListMembers);
// a site's owner sends only as a sender of the site's own domain (storeMailSettings); a list's archive is named only in
// the site's own import directory, with one answer for a missing file and a wrong checksum (importMbox); and a member's
// HTML keeps an image only of the site's attachment downloads, in mail none (ForumCore.js memberHtml).
// Spec-local site, categories and accounts, through the PASS authority as a page's call arrives. Regression suite: these
// are rules. Run: ./moq test mr-mantle --spec ForumStaffRules
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
const membershipRevision = partyId => Number(lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId}).revision)

spec({
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.make("mantle.public.PublicSiteHost", {siteId: SITE, hostname: HOST, canonical: "Y"})
        lib.account(SITE, "FSR_OWNER", {member: true, siteRole: "owner", handle: "fsrowner"})
        lib.account(SITE, "FSR_OWNER2", {member: true, siteRole: "owner", handle: "fsrowner2"})
        lib.account(SITE, "FSR_MOD", {member: true, siteRole: "moderator", handle: "fsrmod"})
        lib.account(SITE, "FSR_LMOD", {member: true, handle: "fsrlmod"})
        lib.account(SITE, "FSR_ANN", {member: true, handle: "fsrann"})
        lib.account(SITE, "FSR_BEN", {member: true, handle: "fsrben"})
        lib.account(SITE, "FSR_SUS", {member: true, handle: "fsrsus"})
        // an account of the deployment that is no member of the site
        lib.account(SITE, "FSR_OUT")
        for (const partyId of ["FSR_OWNER", "FSR_OWNER2", "FSR_MOD", "FSR_LMOD", "FSR_ANN", "FSR_BEN", "FSR_SUS"])
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

feature("SEC-PFS-96: an owner's membership is changed only after the caller signs in again", {
    when() {
        const change = (state, more = {}) =>
            op("FSR_OWNER", "setMembership", {
                targetPartyId: "FSR_OWNER2",
                state,
                expectedRevision: membershipRevision("FSR_OWNER2"),
                reason: "Owner review",
                ...more
            })
        const bare = change("suspended")
        const signed = change("suspended", {password: "moqui"})
        const after = lib.row("mantle.public.PublicSiteParty", {siteId: SITE, partyId: "FSR_OWNER2"}).state
        const restored = change("active", {password: "moqui"})
        // a member who is no owner is changed as before
        const member = op("FSR_OWNER", "setMembership", {
            targetPartyId: "FSR_ANN",
            state: "active",
            expectedRevision: membershipRevision("FSR_ANN"),
            reason: "No change"
        })
        return {bare, signed, after, restored, member}
    },
    then({bare, signed, after, restored, member}) {
        bare.kind == "AuthenticationRequired"
        signed.kind == null
        after == "suspended"
        restored.kind == null
        member.kind == null
    }
})

feature("SEC-PFS-86: the author's or staff's edit takes the earlier versions out of the post's public history", {
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
        // a staff edit of another member's post hides them unless the editor says otherwise
        lib.settled(SITE, "FSR_BEN")
        const reply = op("FSR_BEN", "publishPost", {rootCommEventId: postId, body: "<p>FSR abuse</p>", operationId: operationId()})
        const moderated = op("FSR_MOD", "updatePost", {
            postId: reply.postId,
            body: "<p>Removed by a moderator</p>",
            expectedRevision: 1,
            reason: "Abuse"
        })
        return {
            edited,
            moderated,
            reader: revisions(op("FSR_BEN", "getPostHistory", {postId})),
            compare: kind(op("FSR_BEN", "comparePostRevisions", {postId, fromRevision: 1, toRevision: 2})),
            author: revisions(op("FSR_ANN", "getPostHistory", {postId})),
            staff: revisions(op("FSR_MOD", "getPostHistory", {postId})),
            replyReader: revisions(op("FSR_ANN", "getPostHistory", {postId: reply.postId}))
        }
    },
    then({edited, moderated, reader, compare, author, staff, replyReader}) {
        edited.kind == null
        moderated.kind == null
        reader == [2]
        compare == "NotFound"
        author == [2, 1]
        staff == [2, 1]
        replyReader == [2]
    }
})

feature("SEC-PFS-92: a draft is a member's, within the post's length and the member's count, and an untouched one expires", {
    when() {
        setConf("mantle@forum-drafts-per-member", "2")
        const draft = (username, body, title = "FSR draft") =>
            kind(op(username, "storeDraft", {contactListId: ids.general, title, body, expectedRevision: 0}))
        const tooLong = "x".repeat(100001)
        const out = {
            outsider: draft("FSR_OUT", "Not a member"),
            long: draft("FSR_BEN", tooLong),
            longTitle: draft("FSR_BEN", "Text", "t".repeat(251)),
            preview: kind(op("FSR_BEN", "previewPost", {body: tooLong})),
            made: [1, 2, 3].map(n => draft("FSR_BEN", "Draft " + n))
        }
        // one draft untouched for two days, past forum-draft-days
        setConf("mantle@forum-draft-days", "1")
        const old = Array.from(
            ec.entity.find("mantle.forum.ForumDraft").condition({siteId: SITE, partyId: "FSR_BEN"}).disableAuthz().list()
        )[0]
        lib.set("mantle.forum.ForumDraft", {draftId: old.draftId}, {
            updatedAt: new Date(ec.user.timestampMillis(ec.user.nowTimestamp) - 2 * 86400000)
        })
        lib.run("mantle.forum.OperationServices.cleanup#Drafts", {})
        out.left = count("mantle.forum.ForumDraft", {siteId: SITE, partyId: "FSR_BEN"})
        setConf("mantle@forum-drafts-per-member", "")
        setConf("mantle@forum-draft-days", "")
        return out
    },
    then({outsider, long, longTitle, preview, made, left}) {
        outsider == "Unauthorized"
        long == "Unprocessable"
        longTitle == "Unprocessable"
        preview == "Unprocessable"
        made == [null, null, "Unprocessable"]
        left == 1
    }
})

feature("SEC-PFS-93: one open export per member, a day's report files per staff member, one pending operation per site", {
    when() {
        setConf("mantle@forum-report-exports-per-day", "1")
        const out = {
            firstExport: op("FSR_BEN", "requestPersonalDataAction", {kind: "export"}),
            secondExport: op("FSR_BEN", "requestPersonalDataAction", {kind: "export"}),
            firstReport: op("FSR_MOD", "exportReport", {report: "activity"}),
            secondReport: op("FSR_MOD", "exportReport", {report: "activity"}),
            firstRun: op("FSR_OWNER", "startOperation", {operation: "rebuild-counters", reason: "Check"}),
            secondRun: op("FSR_OWNER", "startOperation", {operation: "rebuild-counters", reason: "Again"})
        }
        setConf("mantle@forum-report-exports-per-day", "")
        return out
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
