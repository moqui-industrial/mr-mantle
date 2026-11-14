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
/* The issue of a record topic with what a party holds on it, or null: the party on a page when it is the caller. */
function held(rootCommEventId, actorPartyId) {
    const issue = one(M + "SmithyIssue", {rootCommEventId})
    const repo = issue ? one(M + "SmithyRepository", {repositoryId: issue.repositoryId}) : null
    if (!repo) return null
    const a = core.actorOfParty(actorPartyId)
    const r = core.repositoryRights(repo, a)
    const topic = one(F + "ForumTopic", {rootCommEventId})
    // a site that no longer mounts Smithy has no pages: nobody reads a conversation there
    const access = core.issueAccess(r, issue, a, topic?.contactListId || null)
    if (!core.mounted(repo.siteId)) access.canRead = access.writable = access.canModerate = false
    return {issue, repo, r, a, topic, access}
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
    const root = one(F + "ForumPostState", {communicationEventId: h.issue.rootCommEventId})
    return root?.visibility === "approved" || (!!actorPartyId && h.issue.reporterPartyId === actorPartyId) || h.access.canModerate
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
        const repo = issue ? one(M + "SmithyRepository", {repositoryId: issue.repositoryId}) : null
        const mount = repo ? base(repo.siteId) : null
        if (mount == null) return null
        const task = one("mantle.work.effort.WorkEffort", {workEffortId: issue.workEffortId})
        return {
            path: mount + "/" + repo.repositoryPath + "/-/issues/" + Number(issue.issueNumber),
            title:
                issue.confidential === "Y"
                    ? "Confidential issue #" + Number(issue.issueNumber)
                    : (task?.workEffortName || "Issue") + " (#" + Number(issue.issueNumber) + ")",
            listId: String(repo.repositoryPath).replace(/\//g, ".")
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
        if (mount == null || !/[#@]/.test(html)) return html
        const issueLinks = new Map()
        const issueLink = number => {
            if (!issueLinks.has(number)) {
                const other = one(M + "SmithyIssue", {repositoryId: h.repo.repositoryId, issueNumber: number})
                const state = other ? one(F + "ForumPostState", {communicationEventId: other.rootCommEventId}) : null
                const readable =
                    !!other &&
                    core.issueAccess(h.r, other, h.a, null).canRead &&
                    (state?.visibility === "approved" || other.reporterPartyId === h.a.partyId || h.access.canModerate)
                issueLinks.set(number, readable ? mount + "/" + h.repo.repositoryPath + "/-/issues/" + number : null)
            }
            return issueLinks.get(number)
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
                    if (depth || !/[#@]/.test(part)) return part
                    return part.replace(
                        /(^|[^A-Za-z0-9_\/&#@.-])(#([1-9][0-9]{0,8})|@([A-Za-z0-9][A-Za-z0-9_-]{2,31}))(?![A-Za-z0-9_])/g,
                        (whole, before, reference, number, handle) => {
                            if (links >= 100) return whole
                            const href = number ? issueLink(Number(number)) : handleLink(handle)
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
/* postChanged: the first post of an issue was edited: the task's description is a plain-text copy of it (§8.1). */
function postChanged(rootCommEventId) {
    privileged(() => {
        const issue = one(M + "SmithyIssue", {rootCommEventId})
        if (!issue) return
        const event = one("mantle.party.communication.CommunicationEvent", {communicationEventId: rootCommEventId})
        const task = one("mantle.work.effort.WorkEffort", {workEffortId: issue.workEffortId})
        if (event && task) update(task, {description: plainText(event.body || "").slice(0, 30000)})
    })
}
;({ownedScopes, recordAccess, postAccess, categoryOwner, confidential, recordOwners, recordPage, linkText, postChanged})
