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
