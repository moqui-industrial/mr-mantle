/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's part of the forum and of the moderation layer (mr-pass plan/design-smithy.md §12.3 to §12.5, §15.7, DG6;
 * plans/Dogfood.md §6.1, §6.4). Smithy.js calls this with its kit; each operation is a method of its map.
 * - setScopeForum: a group's category (made with the group, unpublished) is published as the group's forum by its
 *   Owner, and a repository gets a subcategory under it. The category is no wider than the group or the repository:
 *   the forum asks SmithyScope.categoryView for every read. An existing category the caller owns may be linked instead.
 * - reportSmithyTarget, hideSmithyTarget: a report on a repository or a group is a review item (target type repository
 *   or group) in the queue of the scope above it; Hide makes it Not Found to all but its Owners and the site's staff.
 *   Smithy keeps no moderation rows of its own: the item, its reports and the log are the forum's.
 * - convertTopicToIssue: a topic of a group's or a repository's forum becomes an issue of a repository of that scope.
 * - storeIssueMailRoute, claimHeldReport, file#MailReport: a group's report address (a security address) files a
 *   confidential issue as the account whose confirmed address sent the mail; from any other address the message waits.
 * - count#PipelineRun: the day's limit of pipeline runs by trust level, for the CI's pre-queue hook.
 * Entity access is privileged here; every operation passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer} = kit
    const {M, forum, RANK} = core
    const {S, F, E, now, me, find, one, rows, create, update, fail, missing, invalid, receipt, review, audit, id} = forum
    const LIST = "mantle.marketing.contact.ContactList"
    const forumOps = () => ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
    const given = value => value !== undefined && value !== null && value !== ""
    const denied = message => fail("Unauthorized", "accessDenied: " + message)
    const revisionOf = row => Number(row?.revision || 1)
    function fresh(current, expected) {
        if (expected == null || expected === "" || Number(expected) !== Number(current))
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    }

    // ===== the forum of a group and of a repository (§12.5) =====
    /* A category's visibility for a scope's effective visibility (its order): a private scope's readers are those with
       a role in it, whom the forum asks Smithy for. */
    const CATEGORY_VISIBILITY = ["", "public", "members", "category"]
    const categoryRank = visibility => (visibility === "public" ? 1 : visibility === "members" ? 2 : 3)
    const published = contactListId =>
        !!contactListId && one(F + "ForumCategory", {contactListId})?.publicationState === "published"
    /* Publishes a scope's category as its forum, or takes it back: its name the scope's, its visibility the scope's (a
       linked category keeps its own where that is narrower), and posting open to the members who read it. */
    function publish(siteId, contactListId, name, visibility, enabled, linked) {
        const category = one(F + "ForumCategory", {contactListId}, true)
        if (!category || category.siteId !== siteId) missing()
        update(category, {
            publicationState: enabled ? "published" : "disabled",
            visibility: CATEGORY_VISIBILITY[linked ? Math.max(visibility, categoryRank(category.visibility)) : visibility],
            policyRevision: Number(category.policyRevision || 0) + 1
        })
        const list = one(LIST, {contactListId})
        if (list)
            update(list, {contactListName: text(name).slice(0, 100), postingEnumId: enabled ? "ClpAnyUser" : "ClpModerators"})
        forum.scopeChanged(contactListId)
        forum.bump(siteId)
    }
    /* A scope's category is no wider than the scope after its visibility narrows (the same transaction as the change). */
    function narrow(contactListId, visibility) {
        const category = contactListId ? one(F + "ForumCategory", {contactListId}, true) : null
        if (category && categoryRank(category.visibility) < visibility)
            update(category, {
                visibility: CATEGORY_VISIBILITY[visibility],
                policyRevision: Number(category.policyRevision || 0) + 1
            })
    }
    /* What was in a scope's category follows the scope to the category that takes its place: the conversations of its
       records, the review items that wait, and the categories below it. */
    function rescope(siteId, oldContactListId, contactListId) {
        if (!oldContactListId || oldContactListId === contactListId) return
        for (let batch = 0; batch < 40; batch++) {
            const topics = Array.from(
                find(F + "ForumTopic", {siteId, contactListId: oldContactListId, kind: "record"})
                    .limit(500)
                    .list()
            )
            for (const topic of topics) update(topic, {contactListId})
            if (topics.length < 500) break
        }
        for (const item of find(F + "ForumReviewItem", {siteId, contactListId: oldContactListId})
            .condition("state", "in", ["pending", "claimed"])
            .limit(2000)
            .list())
            update(item, {contactListId})
        for (const child of rows(F + "ForumCategory", {siteId, parentContactListId: oldContactListId}, 2000))
            if (child.contactListId !== contactListId) update(child, {parentContactListId: contactListId})
        forum.scopeChanged(oldContactListId)
    }
    /* A category of the site that the caller owns and that is bound to nothing, no wider than the scope: the one to link. */
    function linkable(siteId, contactListId, visibility, parentContactListId) {
        const category = one(F + "ForumCategory", {contactListId: text(contactListId)})
        if (!category || category.siteId !== siteId) invalid("contactListId names no category of this site")
        const access = forum.categoryAccess(category.contactListId)
        if (!(forum.isOperator() || access?.isOwner || access?.canInvite))
            invalid("contactListId names a category you do not own")
        if (
            find(M + "SmithyGroup", {contactListId: category.contactListId}).count() > 0 ||
            find(M + "SmithyRepository", {contactListId: category.contactListId}).count() > 0
        )
            invalid("contactListId names a category that is another group's or repository's")
        if (categoryRank(category.visibility) < visibility)
            invalid("policyRefused[contactListId]: That category is wider than this is")
        if (parentContactListId && forum.categoryChain(parentContactListId).includes(category.contactListId))
            invalid("contactListId names a category above this one")
        // the linked category takes the place of the scope's own in the tree, so the ceiling above it holds
        if (
            (category.parentContactListId || null) !== (parentContactListId || null) &&
            category.contactListId !== parentContactListId
        )
            update(category, {parentContactListId: parentContactListId || null})
        return category.contactListId
    }
    /* Turns the forum of a group or a repository (its row locked) on or off, or links a category in its place: gives
       {contactListId, enabled}. o: enabled (none: as it is), contactListId (a category to link). */
    function applyForum(siteId, r, row, isGroup, o) {
        // the category above: the parent group's, a repository's group's; none for a top-level group and a personal repository
        const aboveGroupId = isGroup ? row.parentGroupId : row.groupId
        const above = aboveGroupId ? core.ensureGroupCategory(aboveGroupId) : null
        // the scope's own category: a group always has one; a repository gets one when its forum is first turned on
        const own = isGroup ? core.ensureGroupCategory(row.groupId) : row.contactListId || null
        let contactListId = own
        let linked = false
        const was = isGroup ? published(own) : row.forumEnabled === "Y" && published(own)
        const enabled = o.enabled === undefined || o.enabled === null || o.enabled === "" ? was : flag(o.enabled)
        // a forum is read only where the one above it is: a subgroup's and a repository's are inside their group's
        if (enabled && above && !published(above)) invalid("policyRefused[enabled]: Turn the forum of the group above on first")
        // where the repository's conversations are now: its own category, else its group's or the site's
        const oldScope = isGroup ? own : core.scopeCategory(row)
        if (given(o.contactListId) && o.contactListId !== own) {
            contactListId = linkable(siteId, o.contactListId, r.visibility, above)
            linked = true
            update(row, {contactListId})
            // what was in the scope's own category follows it to the one that takes its place
            if (own) rescope(siteId, own, contactListId)
        } else if (!own && enabled) {
            contactListId = core.makeScopeCategory(siteId, row.repositoryPath, above)
            update(row, {contactListId})
        }
        // a repository with a category of its own from now: its issues' and merge requests' conversations move to it
        if (!isGroup && contactListId && contactListId !== oldScope) kit.reviews.moveScope(row, oldScope)
        if (contactListId)
            publish(
                siteId,
                contactListId,
                row.name || (isGroup ? row.groupPath : row.repositoryPath),
                r.visibility,
                enabled,
                linked
            )
        return {contactListId, enabled}
    }
    methods.setScopeForum = p => {
        if (given(p.groupId) === given(p.repositoryId)) invalid("Give a groupId or a repositoryId")
        const isGroup = given(p.groupId)
        const r = isGroup ? core.group(p.groupId, p.siteId) : core.repository(p.repositoryId, p.siteId)
        writer(p.siteId)
        core.requireRole(r, "SmrOwner")
        const row = isGroup
            ? one(M + "SmithyGroup", {groupId: r.group.groupId}, true)
            : one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true)
        const before = revisionOf(row)
        fresh(before, p.expectedRevision)
        const {contactListId, enabled} = applyForum(p.siteId, r, row, isGroup, p)
        update(row, {...(isGroup ? {} : {forumEnabled: enabled ? "Y" : "N"}), revision: before + 1})
        audit(
            p.siteId,
            contactListId,
            isGroup ? "group" : "repository",
            isGroup ? row.groupId : row.repositoryId,
            enabled ? "forumOn" : "forumOff",
            isGroup ? row.groupPath : row.repositoryPath,
            before,
            before + 1
        )
        return {contactListId, enabled, revision: before + 1}
    }
    /* What a group's or a repository's page needs of its forum and its moderation: whether the forum is on, its category
       (the scope of the forum's reads) when it is on or the caller owns the scope, and the scope of the review queue
       for one who moderates it. */
    function forumView(r, isGroup) {
        const row = isGroup ? r.group : r.repo
        const contactListId = row.contactListId || null
        const enabled = (isGroup || row.forumEnabled === "Y") && published(contactListId)
        const owner = r.rank >= RANK.SmrOwner
        const scope = isGroup ? contactListId : contactListId || r.chain[0]?.contactListId || null
        return {
            enabled,
            contactListId: enabled || owner ? contactListId : null,
            moderationContactListId: owner || r.access.staff ? scope : null
        }
    }
    /* A group's report address, for its Owners. */
    function mailRouteView(r) {
        const group = r.group
        if (r.rank < RANK.SmrOwner || !group.contactListId) return null
        const route = rows(
            F + "ForumMailRoute",
            {siteId: group.siteId, targetType: "issue", contactListId: group.contactListId},
            1
        )[0]
        const repo = route ? one(M + "SmithyRepository", {repositoryId: route.targetId}) : null
        return route
            ? {
                  routeId: route.routeId,
                  address: route.address,
                  enabled: route.enabled === "Y",
                  repositoryPath: repo?.repositoryPath || null,
                  revision: Number(route.revision || 1)
              }
            : null
    }

    // ===== Report and Hide (§12.3) =====
    const TARGETS = ["repository", "group"]
    /* A repository or a group as the caller views it (Not Found otherwise), its row locked. */
    function target(p) {
        if (!TARGETS.includes(p.targetType)) invalid("targetType must be repository or group")
        core.site(p.siteId)
        const a = core.actor()
        const held = core.targetRights(p.siteId, p.targetType, p.targetId, a)
        if (!held || !held.r.canView) missing()
        const entity = p.targetType === "group" ? "SmithyGroup" : "SmithyRepository"
        return {a, r: held.r, row: one(M + entity, {[p.targetType + "Id"]: p.targetId}, true)}
    }
    methods.reportSmithyTarget = p => {
        const {row} = target(p)
        const {partyId} = writer(p.siteId)
        return receipt(p, "reportSmithyTarget", () => {
            const reason = text(p.reason).trim()
            const note = text(p.note).trim()
            if (!reason || reason.length > 200) invalid("reason is 1 to 200 characters")
            if (note.length > 2000) invalid("note is at most 2000 characters")
            // a report is counted as a comment is: the day's limit and the time between two (the gate's refusals); it is
            // never held, and its text is read by moderators only
            const gated = forum.gate({
                siteId: p.siteId,
                actorPartyId: partyId,
                kind: "comment",
                confirmed: true,
                body: forum.renderSource("html", reason + (note ? "\n" + note : ""))
            })
            if (gated.decision === "refuse" && gated.refusal.kind !== "Unprocessable") forum.gateRefuse(gated)
            if (gated.memberState) forum.gateCommit(gated, {pending: true})
            one(S + "PublicSite", {siteId: p.siteId}, true)
            // one item waits for a target, whoever reports it; each report is kept
            const item = review(p.siteId, core.scopeAbove(p.targetType, row), p.targetType, p.targetId, 1, "flag")
            if (!one(F + "ForumReviewReport", {reviewId: item.reviewId, reporterPartyId: partyId}))
                create(F + "ForumReviewReport", {
                    reviewId: item.reviewId,
                    reporterPartyId: partyId,
                    reason,
                    evidence: (p.targetType === "group" ? row.groupPath : row.repositoryPath) + (note ? "\n\n" + note : ""),
                    createdAt: now()
                })
            return {reported: true}
        })
    }
    methods.hideSmithyTarget = p => {
        const {a, r, row} = target(p)
        writer(p.siteId)
        if (!core.mayHide(p.targetType, r, a)) denied("Hiding this needs the owner role on a group above it")
        fresh(revisionOf(row), p.expectedRevision)
        const hidden = flag(p.hidden)
        const reason = text(p.reason).trim()
        if (!reason || reason.length > 2000) invalid("reason is 1 to 2000 characters")
        if (hidden === !!row.hiddenAt) return {hidden, revision: revisionOf(row)}
        // what the site's staff hid, an Owner does not show again
        if (!hidden && !r.access.staff && core.hiddenByStaff(p.targetType, row))
            denied("The site's staff hid this; ask them to show it again")
        const revision = core.setHidden(p.targetType, row, hidden, a, r.access.staff, reason)
        return {hidden, revision}
    }

    // ===== a topic made an issue (§12.5) =====
    /* The categories whose topics may become issues of a repository: its own forum, and its top-level group's with what
       is below it. */
    function repositoryForum(r) {
        const inside = new Set()
        if (r.repo.contactListId)
            for (const contactListId of forum.categorySubtree(r.repo.siteId, r.repo.contactListId)) inside.add(contactListId)
        const top = r.chain[r.chain.length - 1]
        if (top?.contactListId)
            for (const contactListId of forum.categorySubtree(r.repo.siteId, top.contactListId)) inside.add(contactListId)
        return inside
    }
    methods.convertTopicToIssue = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        if (r.repo.issuesEnabled !== "Y") missing()
        const {partyId} = writer(p.siteId)
        core.requireRole(r, "SmrReporter")
        return receipt(p, "convertTopicToIssue", () => {
            if (r.git.archivedDate) fail("Conflict", "repositoryArchived: This repository is archived")
            // Not Found for a topic the caller may not read; Unprocessable for a record's conversation
            const {t, event, a} = forum.topic(p.rootCommEventId, p.siteId)
            if (t.kind !== "category") invalid("Only a topic of a forum category becomes an issue")
            if (!repositoryForum(r).has(event.contactListId))
                invalid("That topic is not in the forum of this repository or of its group")
            if (!Array.isArray(p.postIds) || !p.postIds.length || p.postIds.length > 50)
                invalid("postIds is a list of 1 to 50 posts of the topic")
            const quotes = []
            for (const postId of Array.from(new Set(p.postIds))) {
                const state = one(F + "ForumPostState", {communicationEventId: postId})
                const post = one(E + "CommunicationEvent", {communicationEventId: postId})
                if (
                    !state ||
                    !post ||
                    state.rootCommEventId !== t.rootCommEventId ||
                    state.visibility !== "approved" ||
                    !forum.postVisible(state, post, a)
                )
                    invalid("Only visible posts of this topic can be selected")
                const handle = one(S + "PublicSiteProfile", {siteId: p.siteId, partyId: post.fromPartyId})?.handle
                quotes.push(
                    "<blockquote><p>" +
                        (handle ? "@" + handle : "A member") +
                        ", post " +
                        Number(state.ordinal) +
                        ":</p>" +
                        StringUtilities.cleanHtml(post.body || "") +
                        "</blockquote>"
                )
            }
            const confidential = flag(p.confidential)
            const filed = kit.issues.fileIssue({
                r,
                partyId,
                title: text(p.title).trim() || event.subject,
                source:
                    "<p>From the forum topic <em>" +
                    WebUtilities.encodeHtml(event.subject || "") +
                    "</em>:</p>" +
                    quotes.join("\n"),
                format: "html",
                confidential,
                confirmed: true,
                canModerate: r.rank >= RANK.SmrOwner || (!confidential && r.access.staff)
            })
            // the topic stays, and shows its issue to who may read the issue (getTopicLinks); the issue shows its topic
            create(S + "PublicDiscussionLink", {
                linkId: id(),
                siteId: p.siteId,
                sourceType: "issue",
                sourceId: filed.workEffortId,
                rootCommEventId: t.rootCommEventId,
                gate: "none",
                createdByPartyId: partyId,
                createdAt: now(),
                revision: 1
            })
            audit(
                p.siteId,
                event.contactListId,
                "topic",
                t.rootCommEventId,
                "create-issue",
                confidential ? "A confidential issue" : r.repo.repositoryPath + "#" + filed.issueNumber,
                null,
                null
            )
            return {issueNumber: filed.issueNumber}
        })
    }

    // ===== the report address (§12.4) =====
    methods.storeIssueMailRoute = p => {
        const r = core.group(p.groupId, p.siteId)
        const {access} = writer(p.siteId)
        core.requireRole(r, "SmrOwner")
        const group = one(M + "SmithyGroup", {groupId: r.group.groupId}, true)
        const repositoryId = given(p.repositoryId) ? text(p.repositoryId) : group.issueRepositoryId
        const repo = repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
        if (
            !repo ||
            repo.siteId !== p.siteId ||
            !text(repo.repositoryPath).startsWith(group.groupPath + "/") ||
            repo.issuesEnabled !== "Y"
        )
            invalid("repositoryId names no repository of this group with issues on")
        const address = forum.routeAddress(p.address)
        const contactListId = core.ensureGroupCategory(group.groupId)
        const route = rows(F + "ForumMailRoute", {siteId: p.siteId, targetType: "issue", contactListId}, 1)[0] || null
        const before = Number(route?.revision || 0)
        fresh(before, given(p.expectedRevision) ? p.expectedRevision : route ? null : 0)
        const taken = one(F + "ForumMailRoute", {address})
        if (taken && taken.routeId !== route?.routeId) invalid("nameTaken[address]: That address is already routed")
        const enable = flag(p.enabled)
        // an Owner names the address; the site's staff turn it on, and on again when what it does changes
        const same = route?.enabled === "Y" && route.address === address && route.targetId === repositoryId
        if (enable && !access.staff && !same) denied("The site's staff turn a report address on")
        const fields = {
            address,
            contactListId,
            targetType: "issue",
            targetId: repositoryId,
            enabled: enable ? "Y" : "N",
            revision: before + 1
        }
        const routeId = route?.routeId || id()
        if (route) update(one(F + "ForumMailRoute", {routeId}, true), fields)
        else create(F + "ForumMailRoute", {routeId, siteId: p.siteId, createdAt: now(), ...fields})
        audit(p.siteId, contactListId, "route", routeId, "store", address + (enable ? "" : " (off)"), before, before + 1)
        return {routeId, revision: before + 1}
    }
    /* A report as a confidential issue of a route's repository, by the signed-in account. Viewing the repository is not
       asked: a report address is for anyone with a confirmed address. */
    function fileReport(repositoryId, o) {
        const repo = one(M + "SmithyRepository", {repositoryId})
        const git = repo ? one("moqui.resource.GitRepository", {repositoryId}) : null
        if (!repo || !git || repo.issuesEnabled !== "Y" || !core.mounted(repo.siteId))
            invalid("This address takes no reports now")
        if (git.archivedDate) fail("Conflict", "repositoryArchived: This repository is archived")
        const {partyId} = writer(repo.siteId)
        const r = core.repositoryRights(repo, core.actor())
        r.git = git
        const filed = kit.issues.fileIssue({
            r,
            partyId,
            title: text(o.title).trim().slice(0, 250) || "Report by email",
            source: o.body,
            format: "html",
            confidential: true,
            confirmed: true,
            canModerate: false,
            mailVerdict: o.mailVerdict
        })
        return {...filed, repositoryPath: repo.repositoryPath}
    }
    /* file#MailReport (the forum's mail in, for a report address): as the account whose confirmed address sent it. */
    function fileMailReport(p) {
        const route = one(F + "ForumMailRoute", {routeId: p.routeId})
        if (!route || route.targetType !== "issue" || route.enabled !== "Y") invalid("This address takes no reports now")
        const previous = ec.user.username
        ec.user.internalLoginUser(p.username)
        try {
            return receipt(
                {siteId: route.siteId, routeId: p.routeId, title: p.title, body: p.body, operationId: p.operationId},
                "fileMailReport",
                () => {
                    const filed = fileReport(route.targetId, {
                        title: p.title,
                        body: p.body,
                        mailVerdict: p.spam ? {spam: true, reason: text(p.spamReason)} : undefined
                    })
                    return {issueNumber: filed.issueNumber, rootCommEventId: filed.rootCommEventId, state: filed.state}
                }
            )
        } finally {
            ec.user.logoutUser()
            if (previous) ec.user.internalLoginUser(previous)
        }
    }
    methods.claimHeldReport = p => {
        core.site(p.siteId)
        writer(p.siteId)
        return receipt(p, "claimHeldReport", () => {
            const lists = forumOps().lists
            const held = lists.heldByToken(p.siteId, p.token, true)
            if (held.targetType !== "issue") missing()
            lists.requireSender(held)
            const filed = fileReport(held.targetId, {title: held.subject, body: held.body})
            lists.settle(held, "claimed", filed.rootCommEventId, "Filed by its sender")
            return {repositoryPath: filed.repositoryPath, issueNumber: filed.issueNumber}
        })
    }

    // ===== the day's limit of pipeline runs (§12.2) =====
    /* count#PipelineRun: whether an account may ask for one more pipeline run today (by hand, or an outside run), by its
       trust level in the site; one that may is counted. Maintainers of the repository and the site's staff have no
       limit. Gives {allowed, reason, message}. */
    function countPipelineRun(p) {
        const repo = one(M + "SmithyRepository", {repositoryId: p.repositoryId})
        if (!repo) return {allowed: false, reason: "notAvailable", message: "No such repository"}
        const a = core.actor(p.userId || null)
        if (!a.partyId) return {allowed: false, reason: "signInRequired", message: "An account is needed to ask for a run"}
        const r = core.repositoryRights(repo, a)
        const gated = forum.gate({
            siteId: repo.siteId,
            actorPartyId: a.partyId,
            contactListId: core.scopeCategory(repo),
            kind: "pipelineRun",
            create: true,
            canModerate: r.rank >= RANK.SmrMaintainer || r.access.staff
        })
        if (gated.decision === "refuse") return {allowed: false, reason: gated.refusal.reason, message: gated.refusal.message}
        forum.gateCommit(gated)
        return {allowed: true}
    }
    return {applyForum, narrow, forumView, mailRouteView, fileMailReport, countPipelineRun}
}
