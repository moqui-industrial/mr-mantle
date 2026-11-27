// A site export holds only the topics of the categories its starter moderates (plans/archive/Security-Review-Medium.md SEC-PFS-84;
// ForumOperations.js exportTopic): a site owner with no role in a private Smithy group reads and moderates nothing in the
// group's category, so its topics are not exported, while a public category's are; the moderation report leaves out
// that category's actions the same way. Spec-local site, accounts, group and topics (rows, as a post leaves them), the
// export under a spec-local private storage. Run: ./moq test mr-mantle --spec SiteExportScope
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SXS_SITE"
const O = "mantle.forum.OperationServices."
const STORAGE = "dbresource://spec-sxs-media"
const ids = {}
const sys = work => lib.privileged(work)
function category(name) {
    const contactListId = lib.make("mantle.marketing.contact.ContactList", {
        contactListTypeEnumId: "MAILBOX",
        contactListName: name,
        isPublic: "N",
        postingEnumId: "ClpAnyUser"
    }).contactListId
    lib.make("mantle.forum.ForumCategory", {
        contactListId,
        siteId: SITE,
        slug: name.toLowerCase(),
        sequenceNum: 0,
        publicationState: "published",
        visibility: "public",
        mode: "discussion",
        policyRevision: 1
    })
    return contactListId
}
// a topic of one post, as publishPost leaves its rows
function topic(contactListId, subject, body) {
    const rootCommEventId = lib.make("mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: "Message",
        fromPartyId: "SXS_AUTHOR",
        subject,
        body,
        contentType: "text/html",
        entryDate: ec.user.nowTimestamp
    }).communicationEventId
    lib.make("mantle.forum.ForumTopic", {rootCommEventId, siteId: SITE, kind: "category", contactListId, revision: 1, nextOrdinal: 2})
    lib.make("mantle.forum.ForumPostState", {
        communicationEventId: rootCommEventId,
        rootCommEventId,
        ordinal: 1,
        revision: 1,
        visibility: "visible"
    })
    lib.make("mantle.forum.ForumModerationAction", {
        actionId: rootCommEventId + "_A",
        siteId: SITE,
        contactListId,
        targetType: "topic",
        targetId: rootCommEventId,
        action: "pin",
        reason: subject + " pinned",
        createdAt: ec.user.nowTimestamp
    })
    return rootCommEventId
}

spec({
    setupSpec() {
        login(lib.OPERATOR)
        setConf("pass@media-root", STORAGE)
        lib.site(SITE)
        lib.account(SITE, "SXS_OWNER", {member: true, siteRole: "owner", handle: "sxsowner"})
        lib.account(SITE, "SXS_AUTHOR", {member: true, handle: "sxsauthor"})
        // a private group the owner has no role in, whose category its topic is in
        ids.groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "sxsprivate", visibility: "private"}).groupId
        ids.publicCategory = category("SXS public")
        ids.privateCategory = category("SXS private")
        lib.set("mantle.smithy.SmithyGroup", {groupId: ids.groupId}, {contactListId: ids.privateCategory})
        ids.publicTopic = topic(ids.publicCategory, "SXS public topic", "<p>For everyone</p>")
        ids.privateTopic = topic(ids.privateCategory, "SXS group secret", "<p>The group's own words</p>")
    }
})

feature("a site owner's export and moderation report leave out a private group's category they may not view", {
    when() {
        const started = lib.op("SXS_OWNER", SITE, "startOperation", {operation: "export-site", reason: "Portability"})
        const run = lib.row("mantle.forum.ForumJobRun", {runId: started.runId})
        const exportId = JSON.parse(run.checkpoint).exportId
        sys(() => lib.run(O + "dispatch#Jobs", {}))
        const dir = STORAGE + "/exports/" + exportId + "/topics/"
        const exists = rootCommEventId => sys(() => ec.resource.getLocationReference(dir + rootCommEventId + ".json").exists)
        const categories = sys(() => ec.resource.getLocationText(STORAGE + "/exports/" + exportId + "/categories.json", false))
        const reported = lib.op("SXS_OWNER", SITE, "exportReport", {report: "moderation"})
        const reportRow = lib.row("mantle.forum.ForumExport", {exportId: reported.exportId})
        const report = reportRow ? sys(() => ec.resource.getLocationText(reportRow.location, false)) : JSON.stringify(reported)
        return {
            started,
            finished: lib.row("mantle.forum.ForumJobRun", {runId: started.runId}),
            publicExported: exists(ids.publicTopic),
            privateExported: exists(ids.privateTopic),
            categories: String(categories || ""),
            report: String(report || "")
        }
    },
    then({started, finished, publicExported, privateExported, categories, report}) {
        started.runId != null
        finished.state == "complete"
        publicExported == true
        privateExported == false
        categories.includes("SXS public")
        !categories.includes("SXS private")
        report.includes("SXS public topic pinned")
        !report.includes("SXS group secret")
    }
})
