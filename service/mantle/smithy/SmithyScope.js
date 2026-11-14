/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * What the forum asks of Smithy (mr-pass plan/design-smithy.md §12.1): the conversation of an issue is a ForumTopic of
 * kind record, and its access is the issue's, not a category's. ForumCore.js loads this module by PublicApps'
 * apps.smithy.scope and asks it who reads, replies and moderates a record topic and one post of it, who owns the group or
 * repository a category is bound to, where a record's page is, and how a post's references are linked for a reader.
 * Each answer is null (or false) for a topic that is not an issue's, so another app's records are its own module's.
 * The rules are SmithyCore.js's (issueAccess). Entity access is privileged here: the forum has checked who asks.
 */
const core = ec.resource.script("component://mr-mantle/service/mantle/smithy/SmithyCore.js")
const {M, forum, RANK} = core
const {S, me, one, rows, find, update, plainText} = forum
const F = "mantle.forum."
const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
function privileged(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return core.withMemo(work)
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
/* The issue or the merge request of a record topic with what a party holds on it, or null: the party on a page when it
   is the caller. authorPartyId is who filed it, whose own it is while its first post is held. */
function held(rootCommEventId, actorPartyId) {
    const issue = one(M + "SmithyIssue", {rootCommEventId})
    const request = issue ? null : one(M + "SmithyMergeRequest", {rootCommEventId})
    const record = issue || request
    const repo = record ? one(M + "SmithyRepository", {repositoryId: record.repositoryId}) : null
    if (!repo) return null
    const a = core.actorOfParty(actorPartyId)
    const r = core.repositoryRights(repo, a)
    const topic = one(F + "ForumTopic", {rootCommEventId})
    // a site that no longer mounts Smithy has no pages: nobody reads a conversation there
    const access = issue
        ? core.issueAccess(r, issue, a, topic?.contactListId || null)
        : core.mergeRequestAccess(r, request, a, topic?.contactListId || null)
    if (!core.mounted(repo.siteId)) access.canRead = access.writable = access.canModerate = false
    return {
        issue,
        request,
        rootCommEventId,
        authorPartyId: issue ? issue.reporterPartyId : request.authorPartyId,
        repo,
        r,
        a,
        topic,
        access
    }
}
/* recordAccess: the evaluator's shape for the conversation of an issue, or null for a topic that is no issue's. */
function recordAccess(rootCommEventId, actorPartyId = me()) {
    return privileged(() => {
        const h = held(rootCommEventId, actorPartyId)
        if (!h) return null
        const {access, repo, r} = h
        const write = access.canRead && access.writable
        return {
            record: true,
            confidential: access.confidential,
            category: {
                contactListId: h.topic?.contactListId || null,
                siteId: repo.siteId,
                visibility: "record",
                mode: "discussion",
                policyRevision: 0
            },
            site: r.access.site,
            isOwner: access.canRead && access.owner,
            canDiscover: access.canRead,
            canRead: access.canRead,
            canReadOwn: false,
            canStartTopic: false,
            canReply: write,
            canEdit: write,
            canUpload: write,
            canFlag: write,
            canReact: write,
            canVote: false,
            canModerate: access.canModerate,
            canInvite: false,
            // a staff post ("Owners only") is read by the record's Owners, and by nobody else who moderates the scope
            canReadStaff: access.canRead && access.owner,
            writeRefusal: access.writeRefusal
        }
    })
}
/* postAccess: whether a party may read one post of an issue's conversation; false for a post of anything else. */
function postAccess(postId, actorPartyId = me()) {
    return privileged(() => {
        const state = one(F + "ForumPostState", {communicationEventId: postId})
        const h = state ? held(state.rootCommEventId, actorPartyId) : null
        if (!h || !h.access.canRead || !rootReadable(h, actorPartyId)) return false
        if (state.visibility === "staff") return h.access.owner
        if (state.visibility === "approved") return true
        const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: postId})
        return h.access.canModerate || (!!actorPartyId && event?.fromPartyId === actorPartyId)
    })
}
/* While an issue's first post is held, or was removed, the issue is its author's and its moderators': nobody else reads
   a post of it or is told of one, whatever they watch or are mentioned in. */
function rootReadable(h, actorPartyId) {
    const root = one(F + "ForumPostState", {communicationEventId: h.rootCommEventId})
    return root?.visibility === "approved" || (!!actorPartyId && h.authorPartyId === actorPartyId) || h.access.canModerate
}
/* ownedScopes: the scope categories of the repositories of a site that a party is an Owner of by a repository's own
   row or as its namespace's account: where the review items of the records it moderates are, when it is no staff of
   those categories. */
function ownedScopes(siteId, actorPartyId) {
    if (!actorPartyId) return []
    return privileged(() => {
        const repos = rows(M + "SmithyRepository", {siteId, ownerPartyId: actorPartyId}, 500)
        for (const row of find(M + "SmithyRepositoryParty", {siteId, partyId: actorPartyId, roleEnumId: "SmrOwner"})
            .conditionDate("fromDate", "thruDate", null)
            .limit(500)
            .list()) {
            const repo = one(M + "SmithyRepository", {repositoryId: row.repositoryId})
            if (repo) repos.push(repo)
        }
        const account = () => one(M + "SmithySite", {siteId})?.accountContactListId || null
        // a group's Owner is one of every repository below it: the group's own category and its subgroups'
        const lists = []
        for (const row of find(M + "SmithyGroupParty", {siteId, partyId: actorPartyId, roleEnumId: "SmrOwner"})
            .conditionDate("fromDate", "thruDate", null)
            .limit(500)
            .list()) {
            const group = one(M + "SmithyGroup", {groupId: row.groupId})
            if (!group) continue
            if (group.contactListId) lists.push(group.contactListId)
            for (const below of find(M + "SmithyGroup", {siteId})
                .condition("groupPath", "like", group.groupPath + "/%")
                .limit(500)
                .list())
                if (String(below.groupPath).startsWith(group.groupPath + "/") && below.contactListId)
                    lists.push(below.contactListId)
        }
        return Array.from(
            new Set(
                lists.concat(
                    repos
                        .map(
                            repo =>
                                repo.contactListId ||
                                (repo.groupId ? one(M + "SmithyGroup", {groupId: repo.groupId})?.contactListId : account())
                        )
                        .filter(id => !!id)
                )
            )
        )
    })
}
/* categoryOwner: whether a party is an Owner of the group or the repository a category is bound to. */
function categoryOwner(contactListId, actorPartyId) {
    if (!contactListId || !actorPartyId) return false
    return privileged(() => {
        const a = core.actorOfParty(actorPartyId)
        const group = find(M + "SmithyGroup", {contactListId}).list()[0]
        if (group && core.mounted(group.siteId)) {
            const r = core.groupRights(group, a)
            if (r.canView && r.rank >= RANK.SmrOwner) return true
        }
        const repo = find(M + "SmithyRepository", {contactListId}).list()[0]
        if (repo && core.mounted(repo.siteId)) {
            const r = core.repositoryRights(repo, a)
            if (r.canView && r.rank >= RANK.SmrOwner) return true
        }
        return false
    })
}
/* Whether a record topic is a confidential issue's: its text never goes to the classifier. */
const confidential = rootCommEventId => privileged(() => one(M + "SmithyIssue", {rootCommEventId})?.confidential === "Y")
/* The Owners of a confidential issue's repository and of the groups above it, who are told of what is filed. */
function recordOwners(rootCommEventId) {
    return privileged(() => {
        const issue = one(M + "SmithyIssue", {rootCommEventId})
        const repo = issue?.confidential === "Y" ? one(M + "SmithyRepository", {repositoryId: issue.repositoryId}) : null
        if (!repo) return []
        const owners = new Set(repo.ownerPartyId ? [repo.ownerPartyId] : [])
        const current = (entity, fields) =>
            Array.from(
                find(entity, {...fields, roleEnumId: "SmrOwner"})
                    .conditionDate("fromDate", "thruDate", null)
                    .limit(200)
                    .list()
            )
        for (const row of current(M + "SmithyRepositoryParty", {repositoryId: repo.repositoryId})) owners.add(row.partyId)
        for (const group of (repo.groupId && core.groupChain(repo.groupId)) || [])
            for (const row of current(M + "SmithyGroupParty", {groupId: group.groupId})) owners.add(row.partyId)
        return Array.from(owners).sort()
    })
}
const base = siteId => publicApps().mount(siteId, "smithy")?.base
/* recordPage: an issue's page under the site's Smithy mount (its path from the host), its title for a notice (a
   confidential issue's names its number only) and the list id of its repository's mail; null for no issue. */
function recordPage(rootCommEventId) {
    return privileged(() => {
        const issue = one(M + "SmithyIssue", {rootCommEventId})
        const request = issue ? null : one(M + "SmithyMergeRequest", {rootCommEventId})
        const record = issue || request
        const repo = record ? one(M + "SmithyRepository", {repositoryId: record.repositoryId}) : null
        const mount = repo ? base(repo.siteId) : null
        if (mount == null) return null
        const listId = String(repo.repositoryPath).replace(/\//g, ".")
        if (request) {
            const hosted = one("moqui.resource.GitMergeRequest", {mergeRequestId: request.mergeRequestId})
            const number = Number(hosted?.mergeRequestNum || 0)
            return {
                path: mount + "/" + repo.repositoryPath + "/-/merge-requests/" + number,
                title: (hosted?.title || "Merge request") + " (!" + number + ")",
                listId
            }
        }
        const task = one("mantle.work.effort.WorkEffort", {workEffortId: issue.workEffortId})
        return {
            path: mount + "/" + repo.repositoryPath + "/-/issues/" + Number(issue.issueNumber),
            title:
                issue.confidential === "Y"
                    ? "Confidential issue #" + Number(issue.issueNumber)
                    : (task?.workEffortName || "Issue") + " (#" + Number(issue.issueNumber) + ")",
            listId
        }
    })
}
const escapeHtml = value =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
/* linkText: a post's cleaned HTML with what it names linked for the caller (§8.4): #n, an issue of the record's
   repository the caller may read, and @handle, an account whose page the caller is shown. Anything else stays text, so
   a number or a handle tells nothing of what the caller may not see. Text inside a link, code or pre is left as it is.
   null for a topic that is no issue's. */
function linkText(html, rootCommEventId) {
    return privileged(() => {
        const h = held(rootCommEventId, me())
        if (!h) return null
        const mount = base(h.repo.siteId)
        if (mount == null || !/[#@!]/.test(html)) return html
        const issueLinks = new Map()
        const issueLink = number => {
            if (!issueLinks.has(number)) {
                const other =
                    h.repo.issuesEnabled === "Y"
                        ? one(M + "SmithyIssue", {repositoryId: h.repo.repositoryId, issueNumber: number})
                        : null
                const state = other ? one(F + "ForumPostState", {communicationEventId: other.rootCommEventId}) : null
                const readable =
                    !!other &&
                    core.issueAccess(h.r, other, h.a, null).canRead &&
                    (state?.visibility === "approved" || other.reporterPartyId === h.a.partyId || h.access.canModerate)
                // a number that is no issue's names the merge request of that number (§8.4)
                issueLinks.set(
                    number,
                    readable
                        ? mount + "/" + h.repo.repositoryPath + "/-/issues/" + number
                        : other
                          ? null
                          : requestLink(number)
                )
            }
            return issueLinks.get(number)
        }
        const requestLinks = new Map()
        const requestLink = number => {
            if (!requestLinks.has(number)) {
                const hosted = Array.from(
                    find("moqui.resource.GitMergeRequest", {repositoryId: h.repo.repositoryId, mergeRequestNum: number})
                        .limit(1)
                        .list()
                )[0]
                const other = hosted ? one(M + "SmithyMergeRequest", {mergeRequestId: hosted.mergeRequestId}) : null
                const state = other ? one(F + "ForumPostState", {communicationEventId: other.rootCommEventId}) : null
                const readable =
                    !!other &&
                    core.mergeRequestAccess(h.r, other, h.a, null).canRead &&
                    (state?.visibility === "approved" || other.authorPartyId === h.a.partyId || h.access.canModerate)
                requestLinks.set(number, readable ? mount + "/" + h.repo.repositoryPath + "/-/merge-requests/" + number : null)
            }
            return requestLinks.get(number)
        }
        const handles = new Map()
        const handleLink = handle => {
            const key = handle.toLowerCase()
            if (!handles.has(key)) {
                const profile = one(S + "PublicSiteProfile", {siteId: h.repo.siteId, handle: key})
                handles.set(key, core.accountShown(profile, h.a) ? mount + "/" + profile.handle : null)
            }
            return handles.get(key)
        }
        let depth = 0
        let links = 0
        return (
            String(html)
                // a tag, with a '>' inside a quoted attribute value kept in it
                .split(/(<(?:[^>"']|"[^"]*"|'[^']*')*>)/)
                .map(part => {
                    if (part.startsWith("<")) {
                        if (/^<(a|code|pre)\b/i.test(part)) depth++
                        else if (/^<\/(a|code|pre)\s*>/i.test(part)) depth = Math.max(0, depth - 1)
                        return part
                    }
                    if (depth || !/[#@!]/.test(part)) return part
                    return part.replace(
                        /(^|[^A-Za-z0-9_\/&#@!.-])(#([1-9][0-9]{0,8})|!([1-9][0-9]{0,8})|@([A-Za-z0-9][A-Za-z0-9_-]{2,31}))(?![A-Za-z0-9_])/g,
                        (whole, before, reference, number, request, handle) => {
                            if (links >= 100) return whole
                            const href = number
                                ? issueLink(Number(number))
                                : request
                                  ? requestLink(Number(request))
                                  : handleLink(handle)
                            if (!href) return whole
                            links++
                            return before + '<a href="' + escapeHtml(href) + '">' + reference + "</a>"
                        }
                    )
                })
                .join("")
        )
    })
}
/* postChanged: the first post of an issue or a merge request was edited: the task's description, or the hosted merge
   request's, is a plain-text copy of it (§8.1, §9.1). */
function postChanged(rootCommEventId) {
    privileged(() => {
        const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: rootCommEventId})
        if (!event) return
        const copy = plainText(event.body || "").slice(0, 30000)
        const issue = one(M + "SmithyIssue", {rootCommEventId})
        if (issue) {
            const task = one("mantle.work.effort.WorkEffort", {workEffortId: issue.workEffortId})
            if (task) update(task, {description: copy})
            return
        }
        const request = one(M + "SmithyMergeRequest", {rootCommEventId})
        const hosted = request ? one("moqui.resource.GitMergeRequest", {mergeRequestId: request.mergeRequestId}) : null
        if (hosted) update(hosted, {description: copy || null})
    })
}
/* fileUpload: whether a party may stage a file for commitFile's upload to a repository (§9.5), and how large: a viewer
   with a confirmed address who is not suspended, of a repository that is not archived; the site's maxEditBytes. Null
   for a repository the party may not view, or that Smithy does not keep on that site. */
function fileUpload(siteId, repositoryId, actorPartyId = me()) {
    return privileged(() => {
        const repo = typeof repositoryId === "string" && repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
        if (!repo || repo.siteId !== siteId || !core.mounted(siteId)) return null
        const a = core.actorOfParty(actorPartyId)
        const r = core.repositoryRights(repo, a)
        if (!r.canView) return null
        if (!a.userId || !core.confirmed(a.userId)) return {refusal: "addressUnconfirmed: Confirm your email address to continue"}
        if (r.access.suspended) return {refusal: "accessDenied: Your account is suspended on this site"}
        if (one("moqui.resource.GitRepository", {repositoryId})?.archivedDate)
            return {refusal: "repositoryArchived: This repository is archived"}
        return {maxBytes: core.settings(siteId).maxEditBytes}
    })
}
// ===== DG6: the forum inside Smithy, Report and Hide, the report address (§12.3 to §12.5) =====
/* The group or the repository a category is bound to, or null. */
function boundTo(contactListId) {
    const group = find(M + "SmithyGroup", {contactListId}).list()[0]
    if (group) return {kind: "group", row: group}
    const repo = find(M + "SmithyRepository", {contactListId}).list()[0]
    return repo ? {kind: "repository", row: repo} : null
}
/* categoryView: how a party (null: no user) views the group or repository a category is bound to, which is the
   category's ceiling: {canView, restricted (a private scope: its readers and posters are those with a role in it),
   member (a Guest role or higher)}; null for a category bound to none. */
function categoryView(contactListId, actorPartyId) {
    return privileged(() => {
        const bound = boundTo(contactListId)
        if (!bound) return null
        const a = core.actorOfParty(actorPartyId)
        const r = bound.kind === "group" ? core.groupRights(bound.row, a) : core.repositoryRights(bound.row, a)
        return {canView: r.canView, restricted: r.visibility === 3, member: r.canView && r.rank >= RANK.SmrGuest}
    })
}
/* forumBase: the path of the forum's pages of the group or repository a category is bound to, under the site's Smithy
   mount; null for a category bound to none, and for a site with no Smithy. */
function forumBase(contactListId) {
    return privileged(() => {
        const bound = boundTo(contactListId)
        const mount = bound ? base(bound.row.siteId) : null
        if (mount == null) return null
        return mount + "/" + (bound.kind === "group" ? bound.row.groupPath : bound.row.repositoryPath) + "/-/forum"
    })
}
/* targetModerator: whether a party decides a report on a repository or a group: the site's staff who may view it, and an
   Owner of a group above it; null for a target type that is not Smithy's. */
function targetModerator(targetType, targetId, actorPartyId) {
    if (!["repository", "group"].includes(targetType)) return null
    return privileged(() => {
        const a = core.actorOfParty(actorPartyId)
        const held = core.targetRights(null, targetType, targetId, a)
        return !!held && core.mounted(held.row.siteId) && core.mayHide(targetType, held.r, a)
    })
}
/* targetInfo: what a review item's page shows of a reported repository or group. */
function targetInfo(targetType, targetId) {
    if (!["repository", "group"].includes(targetType)) return null
    return privileged(() => {
        const held = core.targetRights(null, targetType, targetId, core.actorOfParty(me()))
        if (!held || !held.r.canView) return null
        const row = held.row
        return {
            targetType,
            path: targetType === "group" ? row.groupPath : row.repositoryPath,
            name: row.name || "",
            visibility: core.VISIBILITY_CODES[core.VISIBILITY_IDS[held.r.visibility]] || "private",
            hidden: !!row.hiddenAt,
            hideReason: row.hideReason || null,
            revision: Number(row.revision || 1)
        }
    })
}
/* decideTarget: a review of a report decided by one who may (the forum has asked targetModerator): rejected hides the
   target, as the decider; dismissed and approved leave it. True for a target that is Smithy's. */
function decideTarget(targetType, targetId, decision, reason) {
    if (!["repository", "group"].includes(targetType)) return null
    return privileged(() => {
        const a = core.actorOfParty(me())
        const entity = targetType === "group" ? "SmithyGroup" : "SmithyRepository"
        const row = one(M + entity, {[targetType + "Id"]: targetId}, true)
        if (!row) return true
        const r = targetType === "group" ? core.groupRights(row, a) : core.repositoryRights(row, a)
        if (!core.mayHide(targetType, r, a)) forum.fail("Unauthorized", "accessDenied: Hiding this is not yours to do")
        if (decision === "rejected" && !row.hiddenAt) core.setHidden(targetType, row, true, a, r.access.staff, reason)
        return true
    })
}
/* A held report (mail to a report address from an address that is no account's) is read and decided by the Owners of
   its repository alone, and by an operator on a page: never the site's moderators. Null for a held message that is no
   report of Smithy's. */
function heldReadable(held, actorPartyId) {
    if (held.targetType !== "issue") return null
    return privileged(() => {
        const repo = one(M + "SmithyRepository", {repositoryId: held.targetId})
        if (!repo || !core.mounted(repo.siteId)) return false
        const r = core.repositoryRights(repo, core.actorOfParty(actorPartyId))
        return r.canView && r.rank >= RANK.SmrOwner
    })
}
/* The scope category of a report address's repository: where its held reports wait. */
function heldScope(route) {
    if (route.targetType !== "issue") return null
    return privileged(() => {
        const repo = one(M + "SmithyRepository", {repositoryId: route.targetId})
        return repo ? core.scopeCategory(repo) : null
    })
}
/* The page a held report's reply links to (§4.4): it leads to Register or Sign in and back, and files the report. */
const heldLink = (siteId, token) => publicApps().pageUrl(siteId, "smithy", "/-/held-report/" + encodeURIComponent(token))
/* The service that files a message to a report address as its confirmed sender. */
const mailReportService = route => (route.targetType === "issue" ? "mantle.smithy.SmithyIssueServices.file#MailReport" : null)
/* linkCard: an issue or a merge request a forum topic is linked to (PublicDiscussionLink of the source types issue and
   mergeRequest), when the caller may read it: its number, title and page. A release's (DG7) has none yet. */
function linkCard(link) {
    if (!["issue", "mergeRequest"].includes(link.sourceType)) return null
    return privileged(() => {
        const record =
            link.sourceType === "issue"
                ? one(M + "SmithyIssue", {workEffortId: link.sourceId})
                : one(M + "SmithyMergeRequest", {mergeRequestId: link.sourceId})
        const h = record ? held(record.rootCommEventId, me()) : null
        const page = h && h.access.canRead && rootReadable(h, me()) ? recordPage(record.rootCommEventId) : null
        if (!page) return false
        return {sourceType: link.sourceType, title: page.title, path: page.path}
    })
}
;({
    fileUpload,
    ownedScopes,
    recordAccess,
    postAccess,
    categoryOwner,
    confidential,
    recordOwners,
    recordPage,
    linkText,
    postChanged,
    categoryView,
    forumBase,
    targetModerator,
    targetInfo,
    decideTarget,
    heldReadable,
    heldScope,
    heldLink,
    mailReportService,
    linkCard
})
