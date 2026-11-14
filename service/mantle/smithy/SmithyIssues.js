/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's issues (mr-pass plan/design-smithy.md §8, §15.4, DG3). An issue is a task of the repository's (or its group's)
 * project with a SmithyIssue row: its number in the repository, its confidential mark and its conversation, a ForumTopic
 * of kind record whose first post is the issue's text. Smithy.js calls this with its kit; each operation is a method of
 * its map, run through execute().
 * - Who reads an issue is SmithyCore.issueAccess: a viewer of the repository for a public task; a confidential one only
 *   its Owners and its reporter, for whom every other answer is Not Found and every list, count and notice leaves it out.
 * - What leaves a task is mantle.work.PublicProjectionServices.get#PublicItems (§8.2) and nothing else of it.
 * - Every text an account writes (a title, the first post, a label's and a milestone's name) passes the post gate
 *   (ForumCore.gate): a refusal is the gate's, and a held first post makes the issue pending, shown to its author and to
 *   those who moderate it.
 * - A number comes from SmithyRepository.nextIssueNumber under a lock of that row.
 * Entity access is privileged here; every projection passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer} = kit
    const {M, forum, RANK} = core
    const {
        S,
        F,
        E,
        now,
        millis,
        me,
        find,
        one,
        rows,
        create,
        update,
        fail,
        missing,
        invalid,
        page,
        receipt,
        review,
        plainText,
        json
    } = forum
    const WORK = "mantle.work.effort."
    const CLOSED = ["WeComplete", "WeClosed", "WeCancelled"]
    const LABEL_COLORS = ["grey", "blue", "indigo", "purple", "pink", "red", "orange", "amber", "green", "teal", "cyan", "brown"]
    const cf = () => ec.entity.conditionFactory
    const cond = (field, operator, value) => cf().makeCondition(field, operator, value)
    const all = conditions => cf().makeCondition(conditions, "and")
    const any = conditions => cf().makeCondition(conditions, "or")
    const given = value => value !== undefined && value !== null
    const denied = message => fail("Unauthorized", "accessDenied: " + message)
    /* A Mantle service after Smithy's own check: what it refuses is the request's fault, with its text. */
    function call(name, parameters) {
        const out = ec.service.sync().name(name).parameters(parameters).call()
        if (!ec.message.hasError()) return out || {}
        const problem = text(ec.message.getErrorsString()).split("\n")[0]
        ec.message.clearErrors()
        return invalid(problem)
    }
    function fresh(current, expected) {
        if (expected == null || expected === "" || Number(expected) !== Number(current))
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    }
    const listOf = (value, name) => {
        if (!given(value)) return []
        if (
            !Array.isArray(value) ||
            value.length > 50 ||
            value.some(item => typeof item !== "string" || !item || item.length > 64)
        )
            invalid(name + " is a list of at most 50 ids")
        return Array.from(new Set(value))
    }

    // ===== the tracker, its project and an issue as the caller holds it =====
    /* A repository whose issues are on, as the caller views it; Not Found for any other. */
    function tracker(p) {
        const r = core.repository(p.repositoryId, p.siteId)
        if (r.repo.issuesEnabled !== "Y") missing()
        return r
    }
    /* The project of a repository's issues (§8.1): its own, else its group's, else one made for it, with a current
       WorkEffortGitRepository link, which is what a commit's references and its completion read. The project is made as
       rows: the project service would make the caller its manager, which is a role in Projects and in Smithy. */
    function issueProject(repo) {
        let projectId = repo.workEffortId || (repo.groupId ? one(M + "SmithyGroup", {groupId: repo.groupId})?.workEffortId : null)
        if (!projectId) {
            projectId = call("create#" + WORK + "WorkEffort", {
                workEffortTypeEnumId: "WetProject",
                workEffortName: repo.repositoryPath,
                statusId: "WeInProgress",
                visibilityEnumId: "WevWorkGroup"
            }).workEffortId
            call("mantle.work.ProjectServices.init#ProjectSequence", {workEffortId: projectId})
        }
        call("mantle.work.GitServices.add#ProjectRepository", {workEffortId: projectId, repositoryId: repo.repositoryId})
        if (repo.workEffortId !== projectId) update(repo, {workEffortId: projectId})
        return projectId
    }
    /* The Owners of a repository by their rows: its namespace's account, and the parties with a current SmrOwner row on
       it or on a group above it. */
    function ownerParties(repo) {
        const owners = new Set(repo.ownerPartyId ? [repo.ownerPartyId] : [])
        const current = (entity, fields) =>
            Array.from(
                find(entity, {...fields, roleEnumId: "SmrOwner"})
                    .conditionDate("fromDate", "thruDate", null)
                    .limit(1000)
                    .list()
            )
        for (const row of current(M + "SmithyRepositoryParty", {repositoryId: repo.repositoryId})) owners.add(row.partyId)
        for (const group of (repo.groupId && core.groupChain(repo.groupId)) || [])
            for (const row of current(M + "SmithyGroupParty", {groupId: group.groupId})) owners.add(row.partyId)
        return owners
    }
    /* The companion project of a repository's confidential issues (§8.3), made on first need. A confidential issue's
       task is a task of this project, and only its members see a project's tasks in Projects and everywhere that reads
       them: so the members are kept exactly the internal accounts that are Owners of the repository or its groups, as
       managers. It is never linked to the repository, so no key in a commit resolves into it. */
    function confidentialProject(repo) {
        if (repo.confidentialWorkEffortId) return repo.confidentialWorkEffortId
        const projectId = call("create#" + WORK + "WorkEffort", {
            workEffortTypeEnumId: "WetProject",
            workEffortName: repo.repositoryPath + " (confidential)",
            statusId: "WeInProgress",
            visibilityEnumId: "WevRestricted"
        }).workEffortId
        call("mantle.work.ProjectServices.init#ProjectSequence", {workEffortId: projectId})
        update(repo, {confidentialWorkEffortId: projectId})
        syncConfidentialMembers(repo)
        return projectId
    }
    /* Keeps the companion project's members in step with the Owners: a Manager row for each internal Owner, an ended
       row for anyone else on the project, and on its tasks no party who is no Owner. */
    function syncConfidentialMembers(repo) {
        const projectId = repo.confidentialWorkEffortId
        if (!projectId) return
        const owners = ownerParties(repo)
        const wanted = new Set(Array.from(owners).filter(partyId => forum.internalParty(partyId)))
        const current = Array.from(
            find(WORK + "WorkEffortParty", {workEffortId: projectId})
                .conditionDate("fromDate", "thruDate", null)
                .list()
        )
        for (const row of current) if (!wanted.has(row.partyId) || row.roleTypeId !== "Manager") update(row, {thruDate: now()})
        for (const partyId of wanted)
            if (!current.some(row => row.partyId === partyId && row.roleTypeId === "Manager"))
                create(WORK + "WorkEffortParty", {
                    workEffortId: projectId,
                    partyId,
                    roleTypeId: "Manager",
                    fromDate: now(),
                    statusId: "WeptAssigned"
                })
        let after = ""
        for (;;) {
            const tasks = Array.from(
                find(WORK + "WorkEffort", {rootWorkEffortId: projectId})
                    .condition("workEffortId", "greater", after)
                    .orderBy("workEffortId")
                    .limit(500)
                    .list()
            )
            for (const task of tasks) {
                if (task.ownerPartyId && !owners.has(task.ownerPartyId)) update(task, {ownerPartyId: null})
                for (const row of find(WORK + "WorkEffortParty", {workEffortId: task.workEffortId})
                    .conditionDate("fromDate", "thruDate", null)
                    .list())
                    if (!owners.has(row.partyId)) update(row, {thruDate: now()})
            }
            if (tasks.length < 500) break
            after = tasks[tasks.length - 1].workEffortId
        }
    }
    /* After a change of roles in a site: every repository that has a companion project is put in step. */
    function syncSite(siteId) {
        for (const repo of find(M + "SmithyRepository", {siteId})
            .condition("confidentialWorkEffortId", "not-equals", null)
            .limit(2000)
            .list())
            syncConfidentialMembers(repo)
    }
    /* Moves an issue's task between the tracker's project and its companion, as Projects moves a task to another
       project (move#TaskSubtreeProject): its sub-tasks go with it, it leaves its parent, and its milestone, release,
       sprint and component end, since they are the other project's; time entries and notes stay with the task, whose id
       does not change. Refused when a sub-task is an issue of its own, which would change that issue's audience. */
    function moveTask(repo, issue, confidential) {
        const target = confidential ? confidentialProject(repo) : issueProject(repo)
        const subtree = [issue.workEffortId]
        for (let index = 0; index < subtree.length && index < 10000; index++)
            for (const child of find(WORK + "WorkEffort", {parentWorkEffortId: subtree[index]})
                .limit(1000)
                .list())
                if (!subtree.includes(child.workEffortId)) subtree.push(child.workEffortId)
        if (subtree.slice(1).some(workEffortId => one(M + "SmithyIssue", {workEffortId})))
            invalid("This issue's task has a sub-task that is an issue of its own; move that out in Projects first")
        call("update#" + WORK + "WorkEffort", {
            workEffortId: issue.workEffortId,
            rootWorkEffortId: target,
            visibilityEnumId: confidential ? "WevConfidential" : "WevGeneral"
        })
        call("mantle.work.TaskServices.move#TaskSubtreeProject", {
            workEffortId: issue.workEffortId,
            rootWorkEffortId: target,
            clearParent: true
        })
        if (confidential) {
            // nothing internal follows the sub-tasks in as public, and nobody but an Owner stays a party of the task
            for (const workEffortId of subtree.slice(1))
                update(one(WORK + "WorkEffort", {workEffortId}), {visibilityEnumId: "WevConfidential"})
            syncConfidentialMembers(one(M + "SmithyRepository", {repositoryId: repo.repositoryId}))
        }
    }
    /* An issue of a tracker as the caller holds it, or Not Found: one the caller may not read, and one whose first post
       is held (or was removed) for anyone but its author and those who moderate it. */
    function issueFor(r, issueNumber, lock) {
        const number = Number(issueNumber)
        if (!Number.isInteger(number) || number < 1) missing()
        const issue = one(M + "SmithyIssue", {repositoryId: r.repo.repositoryId, issueNumber: number}, !!lock)
        if (!issue) missing()
        return heldIssue(r, issue, core.actor()) || missing()
    }
    function heldIssue(r, issue, a) {
        const topic = one(F + "ForumTopic", {rootCommEventId: issue.rootCommEventId})
        const access = core.issueAccess(r, issue, a, topic?.contactListId || null)
        if (!access.canRead) return null
        const root = one(F + "ForumPostState", {communicationEventId: issue.rootCommEventId})
        const pending = !root || root.visibility !== "approved"
        if (pending && !(a.partyId && issue.reporterPartyId === a.partyId) && !access.canModerate) return null
        return {issue, topic, access, root, pending}
    }
    /* Refuses a reader who may not write in the issue's repository, as the access says why. */
    function writable(held) {
        if (held.access.writable) return
        const reason = held.access.writeRefusal || "accessDenied: Posting is not permitted"
        fail(reason.startsWith("repositoryArchived") ? "Conflict" : "Unauthorized", reason)
    }
    /* Triage is a Reporter's, and never the reporter's own on a confidential issue they do not own. */
    function triage(r, held) {
        core.requireRole(r, "SmrReporter")
        if (held.access.limited) denied("This needs the owner role")
    }

    // ===== the projection (§8.2) =====
    /* An account by its profile, when the caller is shown that profile (SmithyCore.profileShown, as a member is). */
    function profileView(siteId, partyId) {
        const profile = partyId ? one(S + "PublicSiteProfile", {siteId, partyId}) : null
        return profile && core.profileShown(profile, core.actor())
            ? {handle: profile.handle, displayName: profile.displayName || "", avatarUrl: null}
            : null
    }
    /* The work side of the projection, for tasks the caller has been found to read. */
    const publicItems = (workEffortIds, includeLinks) =>
        !workEffortIds.length
            ? new Map()
            : new Map(
                  Array.from(
                      call("mantle.work.PublicProjectionServices.get#PublicItems", {
                          workEffortIdList: workEffortIds,
                          vouchedIdList: workEffortIds,
                          includeLinks
                      }).itemList || []
                  ).map(item => [item.workEffortId, item])
              )
    /* A repository's path when the caller may view it (a link to one it may not is left out). */
    function shownPath(siteId, repositoryId, a, paths) {
        if (!paths.has(repositoryId)) {
            const repo = one(M + "SmithyRepository", {repositoryId})
            paths.set(
                repositoryId,
                repo && repo.siteId === siteId && core.repositoryViewable(repo, a) ? repo.repositoryPath : null
            )
        }
        return paths.get(repositoryId)
    }
    function issueView(r, held, item, a, paths) {
        const {issue, topic, access, root} = held
        const siteId = r.repo.siteId
        const author = profileView(siteId, issue.reporterPartyId)
        const view = {
            issueNumber: Number(issue.issueNumber),
            repositoryPath: r.repo.repositoryPath,
            title: item.title,
            state: item.state,
            stateReason: item.stateReason,
            confidential: access.confidential,
            author: author ? {...author, imported: false} : null,
            createdAt: issue.createdAt || null,
            updatedAt: topic?.lastActivity || issue.createdAt || null,
            closedAt: item.closedAt || null,
            // the comments are the topic's visible posts after the first; a staff post and a state change are none
            commentCount: Math.max(0, Number(topic?.visiblePostCount || 0) - (root?.visibility === "approved" ? 1 : 0)),
            topic: {rootCommEventId: issue.rootCommEventId, revision: Number(topic?.revision || 1)},
            revision: Number(issue.revision || 1)
        }
        // the reporter of a confidential issue who is no Owner gets exactly the fields above
        if (access.limited) return view
        const duplicate = item.duplicateOfWorkEffortId
            ? one(M + "SmithyIssue", {workEffortId: item.duplicateOfWorkEffortId})
            : null
        Object.assign(view, {
            duplicateOfNumber:
                duplicate && duplicate.repositoryId === issue.repositoryId && heldIssue(r, duplicate, a)
                    ? Number(duplicate.issueNumber)
                    : null,
            labels: item.labels,
            milestone: item.milestone,
            assignees: Array.from(item.assigneePartyIds || [])
                .map(partyId => profileView(siteId, partyId))
                .filter(profile => !!profile),
            reactionCounts: json(root?.reactionCounts, {})
        })
        if (item.linkedCommits) {
            const shown = repositoryId => shownPath(siteId, repositoryId, a, paths)
            view.linkedCommits = item.linkedCommits
                .filter(link => shown(link.repositoryId))
                .map(link => ({
                    repositoryPath: shown(link.repositoryId),
                    commitId: link.commitId,
                    summary: link.summary,
                    date: link.date
                }))
            view.linkedMergeRequests = item.linkedMergeRequests
                .filter(link => shown(link.repositoryId))
                .map(link => ({
                    repositoryPath: shown(link.repositoryId),
                    mergeRequestNum: link.mergeRequestNum,
                    title: link.title,
                    state: link.state
                }))
            view.linkedRefs = item.linkedRefs
                .filter(link => link.repositoryId === issue.repositoryId)
                .map(link => ({refName: link.refName, refType: link.refType}))
            view.discussion = discussionOf(siteId, issue)
        }
        if (r.rank >= RANK.SmrReporter) Object.assign(view, {workItemKey: issue.workEffortId, statusId: item.statusId})
        return view
    }
    /* The forum topic that discusses an issue (a PublicDiscussionLink of source type issue), when the caller reads it. */
    function discussionOf(siteId, issue) {
        for (const link of rows(
            S + "PublicDiscussionLink",
            {siteId, sourceType: "issue", sourceId: issue.workEffortId, detachedAt: null},
            5
        ))
            try {
                const {event} = forum.topic(link.rootCommEventId, siteId)
                return {rootCommEventId: link.rootCommEventId, title: event.subject || ""}
            } catch (error) {
                if (!["NotFound", "Unprocessable"].includes(error.moquiErrorKind)) throw error
            }
        return null
    }
    function capabilities(r, held) {
        const {issue, access} = held
        const author = !!me() && issue.reporterPartyId === me()
        const triager = r.rank >= RANK.SmrReporter && !access.limited
        const inWindow = millis(now()) - millis(issue.createdAt) <= forum.policy(r.repo.siteId).editWindowHours * 3600000
        return {
            canEdit: access.writable && (triager || (author && inWindow)),
            canComment: access.writable,
            canSetState: access.writable && (triager || author),
            canTriage: access.writable && triager,
            canSetConfidential: access.writable && access.owner,
            canModerate: access.canModerate
        }
    }

    // ===== reads =====
    methods.getIssue = p => {
        const r = tracker(p)
        const a = core.actor()
        const held = issueFor(r, p.issueNumber)
        const item = publicItems([held.issue.workEffortId], !held.access.limited).get(held.issue.workEffortId) || missing()
        return {issue: issueView(r, held, item, a, new Map()), capabilities: capabilities(r, held), pending: held.pending}
    }
    /* What a caller sees of one tracker's issues, as a condition on SmithyIssueTask: an Owner all of them; anyone else the
       issues that are not confidential (only public tasks below a Reporter) and whose first post is approved, their own
       held ones, and the confidential ones they filed. So a count and a page are of what the caller may read. */
    function listCondition(r, a) {
        const ofRepository = cond("repositoryId", "equals", r.repo.repositoryId)
        if (r.rank >= RANK.SmrOwner) return ofRepository
        const mine = a.partyId ? cond("reporterPartyId", "equals", a.partyId) : null
        const open = [cond("confidential", "not-equals", "Y")]
        if (r.rank < RANK.SmrReporter) open.push(cond("visibilityEnumId", "equals", "WevGeneral"))
        const approved = cond("rootVisibility", "equals", "approved")
        if (!r.access.staff) open.push(mine ? any([approved, mine]) : approved)
        return all([ofRepository, any(mine ? [all(open), all([cond("confidential", "equals", "Y"), mine])] : [all(open)])])
    }
    /* The trackers a list is of: one repository's, or those of a group and its subgroups that the caller may view. */
    function trackersOf(p, a) {
        if (!p.groupId) return [tracker(p)]
        const g = core.group(p.groupId, p.siteId)
        return Array.from(
            find(M + "SmithyRepository", {siteId: p.siteId, issuesEnabled: "Y"})
                .condition("repositoryPath", "like", g.group.groupPath + "/%")
                .orderBy("repositoryPath")
                .limit(200)
                .list()
        )
            .filter(repo => text(repo.repositoryPath).startsWith(g.group.groupPath + "/"))
            .map(repo => core.repositoryRights(repo, a))
            .filter(rights => rights.canView)
    }
    /* The party of a handle whose profile the caller is shown; a handle it is not shown names nobody. */
    function partyOfHandle(siteId, handle) {
        const profile = one(S + "PublicSiteProfile", {siteId, handle: text(handle).toLowerCase()})
        return profile && core.profileShown(profile, core.actor()) ? profile.partyId : null
    }
    methods.findIssues = p => {
        const a = core.actor()
        const trackers = trackersOf(p, a)
        const state = p.state || "open"
        if (!["open", "closed", "all"].includes(state)) invalid("state must be open, closed or all")
        const sort = p.sort || "created"
        if (!["created", "activity"].includes(sort)) invalid("sort must be created or activity")
        if (given(p.confidential) && p.confidential !== "" && p.confidential !== "only") invalid("confidential must be only")
        // the Confidential filter is an Owner's; nobody else learns that it is there
        if (p.confidential === "only" && !trackers.some(r => r.rank >= RANK.SmrOwner)) denied("This needs the owner role")
        const pg = page(
            p,
            "smithyIssues:" +
                JSON.stringify([
                    p.siteId,
                    p.repositoryId,
                    p.groupId,
                    state,
                    p.labelIds,
                    p.milestoneId,
                    p.assigneeHandle,
                    p.authorHandle,
                    p.query,
                    p.confidential,
                    sort
                ])
        )
        const empty = {issueList: [], counts: {open: 0, closed: 0}, nextCursor: null}
        if (!trackers.length) return empty
        const filters = []
        const among = ids => filters.push(cond("workEffortId", "in", ids.length ? ids : ["_NONE_"]))
        for (const labelId of listOf(p.labelIds, "labelIds"))
            among(rows(WORK + "WorkEffortCategoryAppl", {workEffortCategoryId: labelId}, 5000).map(row => row.workEffortId))
        if (p.milestoneId)
            among(
                Array.from(
                    find(WORK + "WorkEffortAssoc", {workEffortId: p.milestoneId, workEffortAssocTypeEnumId: "WeatMilestone"})
                        .conditionDate("fromDate", "thruDate", null)
                        .limit(5000)
                        .list()
                ).map(row => row.toWorkEffortId)
            )
        if (p.assigneeHandle) {
            const partyId = partyOfHandle(p.siteId, p.assigneeHandle)
            among(
                partyId
                    ? Array.from(
                          find(WORK + "WorkEffortParty", {partyId, roleTypeId: "Assignee"})
                              .conditionDate("fromDate", "thruDate", null)
                              .limit(5000)
                              .list()
                      ).map(row => row.workEffortId)
                    : []
            )
        }
        if (p.authorHandle) filters.push(cond("reporterPartyId", "equals", partyOfHandle(p.siteId, p.authorHandle) || "_NONE_"))
        if (p.query)
            filters.push(
                cf().makeCondition("workEffortName", "like", "%" + text(p.query).replace(/[%_\\]/g, "_") + "%", false, true)
            )
        if (p.confidential === "only") filters.push(cond("confidential", "equals", "Y"))
        const byRepository = new Map(trackers.map(r => [r.repo.repositoryId, r]))
        const base = () => {
            let query = find(M + "SmithyIssueTask", {siteId: p.siteId}).condition(any(trackers.map(r => listCondition(r, a))))
            for (const filter of filters) query = query.condition(filter)
            return query
        }
        const counts = {
            open: base().condition("statusId", "not-in", CLOSED).count(),
            closed: base().condition("statusId", "in", CLOSED).count()
        }
        let query = base()
        if (state !== "all") query = query.condition("statusId", state === "open" ? "not-in" : "in", CLOSED)
        const found = Array.from(
            query
                .orderBy(sort === "activity" ? "-lastActivity,-createdAt,-issueNumber" : "-createdAt,-issueNumber")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        const shown = found.slice(0, pg.limit)
        const items = publicItems(
            shown.map(row => row.workEffortId),
            false
        )
        const paths = new Map()
        const issueList = []
        for (const row of shown) {
            const r = byRepository.get(row.repositoryId)
            const held = heldIssue(r, row, a)
            const item = items.get(row.workEffortId)
            if (held && item) issueList.push(issueView(r, held, item, a, paths))
        }
        return {issueList, counts, nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null}
    }

    // ===== filing =====
    /* The staged uploads of the actor that passed scanning become the post's, as a forum post takes them. */
    function attach(siteId, postId, attachmentIds, partyId) {
        const ids = listOf(attachmentIds, "attachmentIds")
        if (ids.length > forum.policy(siteId).mediaFilesPerPost)
            invalid("A post has at most " + forum.policy(siteId).mediaFilesPerPost + " attachments")
        for (const attachmentId of ids) {
            const attachment = one(F + "ForumAttachment", {attachmentId}, true)
            const usable =
                attachment &&
                attachment.siteId === siteId &&
                attachment.ownerPartyId === partyId &&
                !attachment.communicationEventId &&
                attachment.purpose !== "avatar" &&
                attachment.scanState === "clean" &&
                !(attachment.expiresAt && millis(attachment.expiresAt) <= millis(now()))
            if (!usable) invalid("Attachment is unavailable or has not passed scanning")
            update(attachment, {communicationEventId: postId, draftId: null, expiresAt: null})
        }
    }
    /* Files an issue after its caller's own checks. o: r (the repository's rights), partyId (the author), title, source
       and format (the first post as typed), confidential, canModerate (limits and holds do not apply), workEffortId (a
       task that is there: ensure#Issue), attachmentIds, draftId. The title and the text pass the gate; a held first post
       makes the issue pending. The number is taken under the lock of the repository's row. */
    function fileIssue(o) {
        const siteId = o.r.repo.siteId
        const repositoryId = o.r.repo.repositoryId
        const format = forum.sourceFormatOf(o.format || "markdown")
        const source = text(o.source)
        const hasText = !!source.trim()
        const locked = one(M + "SmithyRepository", {repositoryId}, true)
        const scopeContactListId = core.scopeCategory(locked)
        const gated = forum.gateRefuse(
            forum.gate({
                siteId,
                actorPartyId: o.partyId,
                contactListId: scopeContactListId,
                kind: "issue",
                confirmed: o.confirmed === true,
                title: text(o.title).trim(),
                ...(hasText ? {body: forum.renderSource(format, source), source} : {}),
                sourceFormat: format,
                canModerate: !!o.canModerate
            })
        )
        const pending = gated.decision === "hold"
        const body = hasText ? gated.body : ""
        const issueNumber = Number(locked.nextIssueNumber || 1)
        update(locked, {nextIssueNumber: issueNumber + 1})
        const projectId = issueProject(locked)
        const postId = forum.id()
        // the row first: the task's own rule (ensure#Issue, on a public task's create) then finds its issue there
        // a confidential issue's task is made in the companion project, whose members are the Owners alone
        const taskProjectId = o.confidential ? confidentialProject(locked) : projectId
        const workEffortId =
            o.workEffortId || taskProjectId + "-" + ec.entity.sequencedIdPrimary("Project_" + taskProjectId, null, 1)
        create(M + "SmithyIssue", {
            repositoryId,
            issueNumber,
            siteId,
            workEffortId,
            rootCommEventId: postId,
            confidential: o.confidential ? "Y" : "N",
            reporterPartyId: o.partyId,
            createdAt: now(),
            revision: 1
        })
        if (!o.workEffortId) {
            call("mantle.work.TaskServices.create#Task", {
                workEffortId,
                rootWorkEffortId: taskProjectId,
                workEffortName: "Issue #" + issueNumber,
                visibilityEnumId: o.confidential ? "WevConfidential" : "WevGeneral",
                ownerPartyId: o.partyId
            })
            // the title and the text's copy are plain text with any characters (a '<' among them), which a page escapes:
            // written as the row's values, since a service parameter takes no '<'
            // the reporter is on the issue's row only: a confidential task has no owner party for an "own task" rule to find
            update(one(WORK + "WorkEffort", {workEffortId}), {
                workEffortName: gated.title,
                description: plainText(body).slice(0, 30000) || null,
                ...(o.confidential ? {ownerPartyId: null} : {})
            })
        }
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            // a record's post has no category of its own: its topic names the scope
            contactListId: null,
            fromPartyId: o.partyId,
            subject: gated.title,
            body,
            statusId: "CeReceived",
            entryDate: now()
        })
        create(F + "ForumTopic", {
            rootCommEventId: postId,
            siteId,
            contactListId: scopeContactListId,
            kind: "record",
            revision: 1,
            nextOrdinal: 2,
            visiblePostCount: pending ? 0 : 1,
            reactionCount: 0,
            lastActivity: now(),
            pinned: "N",
            unlisted: "N"
        })
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId: postId,
            ordinal: 1,
            revision: 1,
            visibility: pending ? "pending" : "approved",
            approvedRevision: pending ? null : 1,
            wiki: "N",
            reactionCount: 0
        })
        create(F + "ForumPostRevision", {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: format,
            sourceText: source,
            sanitizedBody: body,
            editorPartyId: o.partyId,
            editedAt: now(),
            publicHistoryAllowed: "Y"
        })
        attach(siteId, postId, o.attachmentIds, o.partyId)
        forum.gateCommit(gated, {pending})
        if (pending) review(siteId, scopeContactListId, "post", postId, 1, gated.reasonFamily)
        else {
            if (gated.flag) review(siteId, scopeContactListId, "post", postId, 1, "rule")
            create(F + "ForumOutbox", {
                outboxId: forum.id(),
                siteId,
                communicationEventId: postId,
                eventType: "post",
                state: "pending",
                createdAt: now()
            })
        }
        // never for a confidential issue: the classifier is not sent its text
        forum.queueClassification(siteId, postId)
        const tracking = {siteId, partyId: o.partyId, scopeType: "topic", scopeId: postId}
        if (!one(F + "ForumPreference", tracking))
            create(F + "ForumPreference", {...tracking, watchLevel: "Tracking", revision: 1})
        if (o.draftId) {
            const draft = one(F + "ForumDraft", {draftId: o.draftId, siteId, partyId: o.partyId})
            if (draft) draft.delete()
        }
        return {issueNumber, rootCommEventId: postId, workEffortId, state: pending ? "pending" : "published"}
    }
    /* Who moderates a new issue of a repository: its Owners, and for one that is not confidential the site's staff. */
    const moderates = (r, confidential) => r.rank >= RANK.SmrOwner || (!confidential && r.access.staff)
    methods.createIssue = p => {
        const r = tracker(p)
        const {partyId} = writer(p.siteId)
        return receipt(p, "createIssue", () => {
            if (r.git.archivedDate) fail("Conflict", "repositoryArchived: This repository is archived")
            const labelIds = listOf(p.labelIds, "labelIds")
            const handles = listOf(p.assigneeHandles, "assigneeHandles")
            if (labelIds.length || handles.length || p.milestoneId) core.requireRole(r, "SmrReporter")
            const confidential = flag(p.confidential)
            const filed = fileIssue({
                r,
                partyId,
                title: p.title,
                source: p.body,
                format: p.sourceFormat,
                confidential,
                confirmed: true,
                canModerate: moderates(r, confidential),
                attachmentIds: p.attachmentIds,
                draftId: p.draftId
            })
            const issue = one(M + "SmithyIssue", {repositoryId: r.repo.repositoryId, issueNumber: filed.issueNumber})
            if (labelIds.length) applyLabels(r, issue, labelIds)
            if (handles.length) applyAssignees(r, issue, handles)
            if (p.milestoneId) applyMilestone(r, issue, p.milestoneId)
            return {issueNumber: filed.issueNumber, rootCommEventId: filed.rootCommEventId, state: filed.state}
        })
    }
    /* A writer on an issue: the repository as viewed, the caller as one who may write, the issue locked and current. */
    function issueWrite(p, expected = true) {
        const r = tracker(p)
        const {partyId} = writer(p.siteId)
        const held = issueFor(r, p.issueNumber, true)
        if (expected) fresh(Number(held.issue.revision || 1), p.expectedRevision)
        writable(held)
        return {r, partyId, held, issue: held.issue}
    }
    const bump = issue => update(issue, {revision: Number(issue.revision || 1) + 1}) && Number(issue.revision)
    methods.updateIssue = p => {
        const {r, partyId, held, issue} = issueWrite(p)
        if (!capabilities(r, held).canEdit) {
            if (issue.reporterPartyId === partyId) denied("The time to edit this has passed")
            triage(r, held)
        }
        const gated = forum.gateRefuse(
            forum.gate({
                siteId: p.siteId,
                actorPartyId: partyId,
                contactListId: held.topic?.contactListId || null,
                kind: "issue",
                confirmed: true,
                title: text(p.title).trim(),
                canModerate: held.access.canModerate,
                edit: true
            })
        )
        // plain text with any characters, as the row's value (a service parameter takes no '<')
        update(one(WORK + "WorkEffort", {workEffortId: issue.workEffortId}), {workEffortName: gated.title})
        const event = one(E + "CommunicationEvent", {communicationEventId: issue.rootCommEventId})
        if (event) update(event, {subject: gated.title})
        if (gated.flag)
            review(
                p.siteId,
                held.topic?.contactListId || null,
                "post",
                issue.rootCommEventId,
                Number(held.root?.revision || 1),
                "rule"
            )
        return {revision: bump(issue)}
    }

    // ===== state (§8.5) =====
    const REASONS = {
        completed: ["WeComplete", "WerCompleted"],
        notPlanned: ["WeCancelled", "WerWontComplete"],
        duplicate: ["WeCancelled", "WerDuplicate"]
    }
    methods.setIssueState = p => {
        const {r, partyId, held, issue} = issueWrite(p)
        if (!["open", "closed"].includes(p.state)) invalid("state must be open or closed")
        const reason = p.state === "closed" ? p.reason || "completed" : null
        if (reason && !REASONS[reason]) invalid("reason must be completed, notPlanned or duplicate")
        // the author closes and reopens their own; marking a duplicate, and anyone else's issue, is a Reporter's
        const triager = r.rank >= RANK.SmrReporter && !held.access.limited
        if (!triager && !(issue.reporterPartyId === partyId && reason !== "duplicate")) triage(r, held)
        const flow = call("mantle.work.TaskServices.get#TaskStatusFlow", {workEffortId: issue.workEffortId})
        const transitions = Array.from(flow.transitionList || [])
        let other = null
        if (reason === "duplicate") {
            other = issueFor(r, p.duplicateOfNumber).issue
            if (Number(other.issueNumber) === Number(issue.issueNumber)) invalid("An issue is not a duplicate of itself")
        }
        // open: the first open status the task's flow allows from where it is
        const target = reason
            ? REASONS[reason]
            : [transitions.find(transition => !CLOSED.includes(transition.toStatusId))?.toStatusId, "WerUnresolved"]
        const closedNow = CLOSED.includes(flow.statusId)
        if (!reason && !closedNow) return {state: "open", stateReason: null, revision: Number(issue.revision || 1)}
        const moves = flow.statusId === target[0] || transitions.some(transition => transition.toStatusId === target[0])
        if (!target[0] || !moves)
            invalid(
                "The item's status flow has no way to " +
                    (reason ? "close it as " + reason : "reopen it") +
                    (r.rank >= RANK.SmrReporter
                        ? "; from here it goes to " +
                          (transitions.map(transition => transition.description).join(", ") || "nothing")
                        : "")
            )
        // the change is a line in the conversation, which the task's status rule writes (note#TaskStatus)
        call("mantle.work.TaskServices.set#TaskStatus", {
            workEffortId: issue.workEffortId,
            statusId: target[0],
            resolutionEnumId: target[1]
        })
        for (const assoc of find(WORK + "WorkEffortAssoc", {
            workEffortId: issue.workEffortId,
            workEffortAssocTypeEnumId: "WeatDuplicates"
        })
            .conditionDate("fromDate", "thruDate", null)
            .list())
            update(assoc, {thruDate: now()})
        if (other)
            create(WORK + "WorkEffortAssoc", {
                workEffortId: issue.workEffortId,
                toWorkEffortId: other.workEffortId,
                workEffortAssocTypeEnumId: "WeatDuplicates",
                fromDate: now()
            })
        return {state: p.state, stateReason: reason, revision: bump(issue)}
    }
    /* A state change as a line of the conversation: a post of kind event, with no text of an account's to moderate. */
    function eventLine(issue, line, partyId, visibility = "approved") {
        const topic = one(F + "ForumTopic", {rootCommEventId: issue.rootCommEventId}, true)
        const rootEvent = one(E + "CommunicationEvent", {communicationEventId: issue.rootCommEventId})
        if (!topic || !rootEvent) return
        const postId = forum.id()
        const ordinal = Number(topic.nextOrdinal)
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            contactListId: null,
            fromPartyId: partyId || null,
            rootCommEventId: issue.rootCommEventId,
            parentCommEventId: issue.rootCommEventId,
            subject: rootEvent.subject,
            body: line,
            statusId: "CeReceived",
            entryDate: now()
        })
        update(topic, {nextOrdinal: ordinal + 1, revision: Number(topic.revision) + 1, lastActivity: now()})
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId: issue.rootCommEventId,
            ordinal,
            revision: 1,
            visibility,
            approvedRevision: 1,
            wiki: "N",
            reactionCount: 0,
            postKind: "event"
        })
    }
    /* note#TaskStatus: the status of a task changed, in Smithy, in Projects or by a commit. When the task is an issue and
       the change opens or closes it, the conversation gets its line. */
    function noteTaskStatus(p) {
        const issue = p.workEffortId ? one(M + "SmithyIssue", {workEffortId: p.workEffortId}) : null
        if (!issue) return
        const item = publicItems([issue.workEffortId], false).get(issue.workEffortId)
        if (!item) return
        const wasClosed = CLOSED.includes(p.oldStatusId)
        if (wasClosed === (item.state === "closed")) return
        const words = {completed: "completed", notPlanned: "not planned", duplicate: "a duplicate"}
        eventLine(issue, item.state === "closed" ? "closed as " + (words[item.stateReason] || "completed") : "reopened", me())
    }

    // ===== labels, assignees, milestone =====
    const projectOf = r => (r.repo.workEffortId ? one(WORK + "WorkEffort", {workEffortId: r.repo.workEffortId}) : null)
    /* The labels of a tracker: those made in this repository (a SmithyLabel row; a project may be shared by the group's
       repositories, and one repository's labels are not another's), and its project's organization's, which no repository
       made, all of that organization's projects share and Projects edits. Each {label, own (the SmithyLabel row)}. */
    function labelRows(r) {
        const project = projectOf(r)
        if (!project) return []
        const out = []
        for (const own of rows(M + "SmithyLabel", {repositoryId: r.repo.repositoryId}, 500)) {
            const label = one(WORK + "WorkEffortCategory", {workEffortCategoryId: own.workEffortCategoryId})
            if (label?.categoryTypeEnumId === "WcatLabel") out.push({label, own})
        }
        if (project.ownerPartyId)
            for (const label of rows(
                WORK + "WorkEffortCategory",
                {categoryTypeEnumId: "WcatLabel", ownerPartyId: project.ownerPartyId},
                500
            ))
                if (find(M + "SmithyLabel", {workEffortCategoryId: label.workEffortCategoryId}).count() === 0)
                    out.push({label, own: null})
        return out.sort((left, right) => text(left.label.description).localeCompare(text(right.label.description)))
    }
    const labelRevision = label => millis(label.lastUpdatedStamp)
    const labelView = label => ({
        labelId: label.workEffortCategoryId,
        name: label.description || "",
        color: label.colorName || "grey"
    })
    function applyLabels(r, issue, labelIds) {
        const known = new Set(labelRows(r).map(row => row.label.workEffortCategoryId))
        for (const labelId of labelIds) if (!known.has(labelId)) invalid("labelIds names a label this repository does not have")
        const key = {workEffortId: issue.workEffortId}
        const had = rows(WORK + "WorkEffortCategoryAppl", key, 200)
        for (const appl of had)
            if (known.has(appl.workEffortCategoryId) && !labelIds.includes(appl.workEffortCategoryId)) appl.delete()
        for (const labelId of labelIds)
            if (!had.some(appl => appl.workEffortCategoryId === labelId))
                create(WORK + "WorkEffortCategoryAppl", {...key, workEffortCategoryId: labelId})
    }
    function applyAssignees(r, issue, handles) {
        const repo = r.repo
        const partyIds = handles.map(handle => {
            const partyId = partyOfHandle(repo.siteId, handle)
            const a = partyId ? core.actorOfParty(partyId) : null
            const access = a?.partyId ? core.issueAccess(core.repositoryRights(repo, {...a, pages: false}), issue, a, null) : null
            // an assignee reads the issue; a confidential one is assigned to an Owner only
            if (!access?.canRead || (access.confidential && !access.owner))
                invalid("assigneeHandles names an account that may not view this issue")
            return partyId
        })
        const current = Array.from(
            find(WORK + "WorkEffortParty", {workEffortId: issue.workEffortId, roleTypeId: "Assignee"})
                .conditionDate("fromDate", "thruDate", null)
                .list()
        )
        for (const row of current) if (!partyIds.includes(row.partyId)) update(row, {thruDate: now()})
        for (const partyId of partyIds)
            if (!current.some(row => row.partyId === partyId))
                call("create#" + WORK + "WorkEffortParty", {
                    workEffortId: issue.workEffortId,
                    partyId,
                    roleTypeId: "Assignee",
                    fromDate: now(),
                    statusId: "WeptAssigned"
                })
    }
    /* The milestones made in this repository's tracker (a SmithyMilestone row), never a sibling's of the same project. */
    const milestoneRows = r =>
        rows(M + "SmithyMilestone", {repositoryId: r.repo.repositoryId}, 500)
            .map(own => one(WORK + "WorkEffort", {workEffortId: own.workEffortId}))
            .filter(row => row?.workEffortTypeEnumId === "WetMilestone")
    function applyMilestone(r, issue, milestoneId) {
        // a milestone is the tracker project's, and a confidential issue's task is not in that project
        if (milestoneId && issue.confidential === "Y") invalid("A confidential issue has no milestone")
        if (milestoneId) {
            if (!milestoneRows(r).some(row => row.workEffortId === milestoneId))
                invalid("milestoneId names no milestone of this repository")
            call("mantle.work.TaskServices.set#TaskMilestone", {
                workEffortId: issue.workEffortId,
                milestoneWorkEffortId: milestoneId
            })
        } else
            for (const assoc of find(WORK + "WorkEffortAssoc", {
                toWorkEffortId: issue.workEffortId,
                workEffortAssocTypeEnumId: "WeatMilestone"
            })
                .conditionDate("fromDate", "thruDate", null)
                .list())
                update(assoc, {thruDate: now()})
    }
    const itemOf = issue => publicItems([issue.workEffortId], false).get(issue.workEffortId) || missing()
    methods.setIssueLabels = p => {
        const {r, held, issue} = issueWrite(p)
        triage(r, held)
        applyLabels(r, issue, listOf(p.labelIds, "labelIds"))
        return {labels: itemOf(issue).labels, revision: bump(issue)}
    }
    methods.setIssueAssignees = p => {
        const {r, held, issue} = issueWrite(p)
        triage(r, held)
        applyAssignees(r, issue, listOf(p.assigneeHandles, "assigneeHandles"))
        return {
            assignees: Array.from(itemOf(issue).assigneePartyIds)
                .map(partyId => profileView(p.siteId, partyId))
                .filter(profile => !!profile),
            revision: bump(issue)
        }
    }
    methods.setIssueMilestone = p => {
        const {r, held, issue} = issueWrite(p)
        triage(r, held)
        applyMilestone(r, issue, p.milestoneId || null)
        return {milestone: itemOf(issue).milestone, revision: bump(issue)}
    }
    methods.setIssueConfidential = p => {
        const r = tracker(p)
        const {partyId} = writer(p.siteId)
        const change = () => {
            const held = issueFor(r, p.issueNumber, true)
            const issue = held.issue
            fresh(Number(issue.revision || 1), p.expectedRevision)
            writable(held)
            if (!held.access.owner) core.requireRole(r, "SmrOwner")
            const confidential = flag(p.confidential)
            if (flag(p.asNewIssue)) {
                // made public as a new issue, with a title and a text its Owner writes; this one stays confidential
                if (confidential || issue.confidential !== "Y")
                    invalid("asNewIssue makes a confidential issue public as a new one")
                const filed = fileIssue({
                    r,
                    partyId,
                    title: p.title,
                    source: p.body,
                    format: p.sourceFormat,
                    confidential: false,
                    confirmed: true,
                    canModerate: true
                })
                // the link is a line its Owners alone read: no association of the public task names the hidden one
                eventLine(issue, "made public as #" + filed.issueNumber, partyId, "staff")
                return {confidential: true, newIssueNumber: filed.issueNumber, revision: bump(issue)}
            }
            if ((issue.confidential === "Y") !== confidential) {
                // as it is: the task's visibility follows, the approved posts become public and a staff post stays staff
                update(issue, {confidential: confidential ? "Y" : "N"})
                // the task moves to the companion project, or back to the tracker's
                moveTask(one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true), issue, confidential)
                forum.audit(
                    p.siteId,
                    held.topic?.contactListId || null,
                    "topic",
                    issue.rootCommEventId,
                    confidential ? "confidential" : "public",
                    "",
                    Number(issue.revision || 1),
                    Number(issue.revision || 1) + 1
                )
            }
            return {confidential, newIssueNumber: null, revision: bump(issue)}
        }
        return flag(p.asNewIssue) ? receipt(p, "setIssueConfidential", change) : change()
    }
    /* Whether a tracker's caller may read its labels and milestones: any viewer of a repository with issues on. */
    methods.findLabels = p => {
        const r = tracker(p)
        const a = core.actor()
        const openWith = labelId => {
            const ids = rows(WORK + "WorkEffortCategoryAppl", {workEffortCategoryId: labelId}, 5000).map(row => row.workEffortId)
            return ids.length
                ? find(M + "SmithyIssueTask", {siteId: p.siteId})
                      .condition(listCondition(r, a))
                      .condition("workEffortId", "in", ids)
                      .condition("statusId", "not-in", CLOSED)
                      .count()
                : 0
        }
        return {
            labelList: labelRows(r).map(({label, own}) => ({
                ...labelView(label),
                description: own?.description || "",
                openIssueCount: openWith(label.workEffortCategoryId),
                // a label of the organization's is edited in Projects
                editable: !!own,
                revision: labelRevision(label)
            }))
        }
    }
    /* A name a Maintainer writes (a label's, a milestone's) and its description pass the gate as a name does, in the
       repository's scope (a silence there and the scope's rules apply): it is not kept pending, and what the rules
       censor is what is stored. A name has no markup characters, which the task services refuse. */
    function nameGate(p, partyId, scopeContactListId, name, description) {
        if (/[<>]/.test(name)) invalid("nameInvalid[name]: A name has no '<' or '>'")
        if (description && /[<>]/.test(description)) invalid("nameInvalid[description]: A description has no '<' or '>'")
        const gated = forum.gateRefuse(
            forum.gate({
                siteId: p.siteId,
                actorPartyId: partyId,
                contactListId: scopeContactListId,
                kind: "repository",
                confirmed: true,
                title: name,
                ...(description ? {body: description} : {})
            })
        )
        return {name: gated.title, description: description ? gated.body : description}
    }
    function manage(p) {
        const r = tracker(p)
        const {partyId} = writer(p.siteId)
        core.requireRole(r, "SmrMaintainer")
        if (r.git.archivedDate) fail("Conflict", "repositoryArchived: This repository is archived")
        const repo = one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true)
        const projectId = issueProject(repo)
        r.repo = repo
        return {r, partyId, projectId, scopeContactListId: core.scopeCategory(repo)}
    }
    /* A label this repository made, locked; an organization's is changed in Projects, and any other is Not Found. */
    function ownLabel(r, labelId) {
        const found = labelId ? labelRows(r).find(row => row.label.workEffortCategoryId === labelId) : null
        if (!found) missing()
        if (!found.own) denied("An organization's label is changed in Projects")
        return {label: one(WORK + "WorkEffortCategory", {workEffortCategoryId: labelId}, true), own: found.own}
    }
    methods.storeLabel = p => {
        const store = () => {
            const {r, partyId, projectId, scopeContactListId} = manage(p)
            const current = p.labelId ? ownLabel(r, p.labelId) : null
            if (current) fresh(labelRevision(current.label), p.expectedRevision)
            const typed = given(p.name) ? text(p.name).trim() : current?.label.description
            if (!typed || typed.length > 100) invalid("name is 1 to 100 characters")
            const typedDescription = given(p.description) ? text(p.description).trim() : current?.own.description || ""
            if (typedDescription.length > 255) invalid("description is at most 255 characters")
            const {name, description} = nameGate(p, partyId, scopeContactListId, typed, typedDescription)
            const color = given(p.color) && p.color !== "" ? p.color : current?.label.colorName || "grey"
            if (!LABEL_COLORS.includes(color)) invalid("color must be one of " + LABEL_COLORS.join(", "))
            if (
                labelRows(r).some(
                    row =>
                        row.label.workEffortCategoryId !== p.labelId &&
                        text(row.label.description).toLowerCase() === name.toLowerCase()
                )
            )
                invalid("nameTaken[name]: There is a label of that name")
            let labelId = p.labelId
            if (current) {
                update(current.label, {description: name, colorName: color})
                update(current.own, {description: description || null})
            } else {
                labelId = call("create#" + WORK + "WorkEffortCategory", {
                    categoryTypeEnumId: "WcatLabel",
                    description: name,
                    colorName: color,
                    ownerPartyId: one(WORK + "WorkEffort", {workEffortId: projectId})?.ownerPartyId || null
                }).workEffortCategoryId
                create(M + "SmithyLabel", {
                    repositoryId: r.repo.repositoryId,
                    workEffortCategoryId: labelId,
                    siteId: p.siteId,
                    description: description || null
                })
            }
            return {labelId, revision: labelRevision(one(WORK + "WorkEffortCategory", {workEffortCategoryId: labelId}))}
        }
        return p.labelId ? store() : receipt(p, "storeLabel", store)
    }
    /* The label comes off this repository's issues, a page at a time, and is this repository's no more; the category
       itself goes when nothing else has it (Projects may have put it on other items). */
    methods.deleteLabel = p => {
        const {r} = manage(p)
        const {label, own} = ownLabel(r, p.labelId)
        const labelId = label.workEffortCategoryId
        let after = ""
        for (;;) {
            const batch = Array.from(
                find(M + "SmithyIssue", {repositoryId: r.repo.repositoryId})
                    .condition("workEffortId", "greater", after)
                    .orderBy("workEffortId")
                    .limit(500)
                    .list()
            )
            if (!batch.length) break
            find(WORK + "WorkEffortCategoryAppl", {workEffortCategoryId: labelId})
                .condition(
                    "workEffortId",
                    "in",
                    batch.map(issue => issue.workEffortId)
                )
                .deleteAll()
            after = batch[batch.length - 1].workEffortId
            if (batch.length < 500) break
        }
        own.delete()
        if (find(WORK + "WorkEffortCategoryAppl", {workEffortCategoryId: labelId}).count() === 0) label.delete()
        return {deleted: true}
    }
    const milestoneRevision = row => millis(row.lastUpdatedStamp)
    methods.findMilestones = p => {
        const r = tracker(p)
        const a = core.actor()
        const state = p.state || "open"
        if (!["open", "closed", "all"].includes(state)) invalid("state must be open, closed or all")
        const countOf = (milestoneId, closed) => {
            const ids = Array.from(
                find(WORK + "WorkEffortAssoc", {workEffortId: milestoneId, workEffortAssocTypeEnumId: "WeatMilestone"})
                    .conditionDate("fromDate", "thruDate", null)
                    .limit(5000)
                    .list()
            ).map(row => row.toWorkEffortId)
            return ids.length
                ? find(M + "SmithyIssueTask", {siteId: p.siteId})
                      .condition(listCondition(r, a))
                      .condition("workEffortId", "in", ids)
                      .condition("statusId", closed ? "in" : "not-in", CLOSED)
                      .count()
                : 0
        }
        return {
            milestoneList: milestoneRows(r)
                .map(row => ({row, closed: CLOSED.includes(row.statusId)}))
                .filter(({closed}) => state === "all" || closed === (state === "closed"))
                .sort((left, right) => millis(left.row.estimatedCompletionDate) - millis(right.row.estimatedCompletionDate))
                .map(({row, closed}) => ({
                    milestoneId: row.workEffortId,
                    name: row.workEffortName || "",
                    description: row.description || "",
                    dueDate: row.estimatedCompletionDate || null,
                    state: closed ? "closed" : "open",
                    openIssueCount: countOf(row.workEffortId, false),
                    closedIssueCount: countOf(row.workEffortId, true),
                    revision: milestoneRevision(row)
                }))
        }
    }
    methods.storeMilestone = p => {
        const store = () => {
            const {r, partyId, projectId, scopeContactListId} = manage(p)
            const current = p.milestoneId ? milestoneRows(r).find(row => row.workEffortId === p.milestoneId) || missing() : null
            if (current) fresh(milestoneRevision(current), p.expectedRevision)
            const typed = given(p.name) ? text(p.name).trim() : current?.workEffortName
            if (!typed || typed.length > 255) invalid("name is 1 to 255 characters")
            // the whole description is read by the gate, as a text is
            const gated = nameGate(p, partyId, scopeContactListId, typed, given(p.description) ? text(p.description) : "")
            const name = gated.name
            const description = given(p.description) ? gated.description || null : null
            let dueDate = null
            if (given(p.dueDate) && p.dueDate !== "")
                dueDate = ec.l10n.parseTimestamp(text(p.dueDate), null) || invalid("dueDate must be a date")
            if (given(p.state) && p.state !== "" && !["open", "closed"].includes(p.state)) invalid("state must be open or closed")
            let milestoneId = p.milestoneId
            if (!current) {
                milestoneId = call("mantle.work.ProjectServices.create#Milestone", {
                    rootWorkEffortId: projectId,
                    workEffortName: name,
                    description,
                    estimatedCompletionDate: dueDate
                }).workEffortId
                create(M + "SmithyMilestone", {repositoryId: r.repo.repositoryId, workEffortId: milestoneId, siteId: p.siteId})
            } else
                call("mantle.work.ProjectServices.update#Milestone", {
                    workEffortId: milestoneId,
                    workEffortName: name,
                    ...(description ? {description} : {}),
                    ...(dueDate ? {estimatedCompletionDate: dueDate} : {}),
                    clearFields: [
                        given(p.description) && !description ? "description" : null,
                        p.dueDate === "" ? "estimatedCompletionDate" : null
                    ]
                        .filter(name => !!name)
                        .join(",")
                })
            const closed = CLOSED.includes(one(WORK + "WorkEffort", {workEffortId: milestoneId}).statusId)
            if (p.state && (p.state === "closed") !== closed)
                call("mantle.work.ProjectServices.update#Milestone", {
                    workEffortId: milestoneId,
                    statusId: closed ? "WeInProgress" : "WeComplete"
                })
            return {milestoneId, revision: milestoneRevision(one(WORK + "WorkEffort", {workEffortId: milestoneId}))}
        }
        return p.milestoneId ? store() : receipt(p, "storeMilestone", store)
    }
    /* The accounts with a role on the repository (its own rows, its groups' and its namespace's), by their profiles. */
    methods.findAssignees = p => {
        const r = tracker(p)
        if (!me()) fail("AuthenticationRequired", "Sign in to continue")
        core.requireRole(r, "SmrReporter")
        const limit = Math.min(Math.max(Number(p.limit || 20), 1), 100)
        const partyIds = new Set(r.repo.ownerPartyId ? [r.repo.ownerPartyId] : [])
        const current = (entity, fields) =>
            Array.from(find(entity, fields).conditionDate("fromDate", "thruDate", null).limit(500).list())
        for (const row of current(M + "SmithyRepositoryParty", {repositoryId: r.repo.repositoryId})) partyIds.add(row.partyId)
        for (const group of r.chain)
            for (const row of current(M + "SmithyGroupParty", {groupId: group.groupId})) partyIds.add(row.partyId)
        const query = text(p.query).toLowerCase()
        return {
            handleList: Array.from(partyIds)
                .map(partyId => profileView(p.siteId, partyId))
                .filter(
                    profile =>
                        !!profile &&
                        (!query || profile.handle.includes(query) || profile.displayName.toLowerCase().includes(query))
                )
                .sort((left, right) => left.handle.localeCompare(right.handle))
                .slice(0, limit)
        }
    }

    // ===== what the rules call (not operations) =====
    /* ensure#Issue (§8.1): a public task (WevGeneral) of a Smithy project with issues on that has no issue gets one, in
       the project's one repository with issues on, else in its group's issue repository; with neither it stays without a
       number. Never a task of a project that is only linked to a repository. The first post is the task's description,
       through the gate as the caller; a refusal leaves the task without an issue and is logged. */
    function ensureIssue(p) {
        const task = p.workEffortId ? one(WORK + "WorkEffort", {workEffortId: p.workEffortId}) : null
        if (!task || task.workEffortTypeEnumId !== "WetTask" || task.visibilityEnumId !== "WevGeneral" || !task.rootWorkEffortId)
            return {}
        if (one(M + "SmithyIssue", {workEffortId: task.workEffortId})) return {}
        const projectId = task.rootWorkEffortId
        const on = repo => !!repo && repo.issuesEnabled === "Y" && core.mounted(repo.siteId)
        const own = rows(M + "SmithyRepository", {workEffortId: projectId}, 50).filter(on)
        let repo = own.length === 1 ? own[0] : null
        if (!repo)
            for (const group of rows(M + "SmithyGroup", {workEffortId: projectId}, 10)) {
                const named = group.issueRepositoryId
                    ? one(M + "SmithyRepository", {repositoryId: group.issueRepositoryId})
                    : null
                if (on(named) && named.siteId === group.siteId) repo = named
            }
        if (!repo) return {}
        // the author is the task's creator (its owner party) when that party has an account on the site, else the caller
        const creator = task.ownerPartyId && forum.member(repo.siteId, task.ownerPartyId) ? task.ownerPartyId : null
        const partyId = creator || me()
        if (!partyId) {
            ec.logger.warn(
                "Task " +
                    task.workEffortId +
                    " got no issue in " +
                    repo.repositoryPath +
                    ": no user and no creator with an account on the site"
            )
            return {}
        }
        const r = core.repositoryRights(repo, core.actorOfParty(partyId))
        try {
            const filed = fileIssue({
                r,
                partyId,
                title: task.workEffortName,
                source: task.description || "",
                format: "markdown",
                confidential: false,
                // a member of the project who triages its items is not held as a first poster is
                canModerate: r.rank >= RANK.SmrReporter,
                workEffortId: task.workEffortId
            })
            return {issueNumber: filed.issueNumber, repositoryId: repo.repositoryId}
        } catch (error) {
            if (!error.moquiErrorKind) throw error
            ec.message.clearErrors()
            ec.logger.warn(
                "Task " +
                    task.workEffortId +
                    " got no issue in " +
                    repo.repositoryPath +
                    ": " +
                    text(error.message).split("\n")[0]
            )
            return {}
        }
    }
    /* The tasks a user does not see in Projects (§8.3, N-BOSS-ISSUE): each confidential issue's task whose repository the
       user is no Owner of, by its own rows (a project role gives Maintainer at most). An operator sees them. */
    /* Whether a task is hidden from a user in Projects: a confidential issue's, when the user is no Owner of its
       repository by its Smithy rows and no operator. */
    function taskHidden(workEffortId, userId) {
        const issue = workEffortId ? one(M + "SmithyIssue", {workEffortId}) : null
        if (!issue || issue.confidential !== "Y") return false
        if (userId && userId === ec.user.userId && forum.isOperator()) return false
        const repo = one(M + "SmithyRepository", {repositoryId: issue.repositoryId})
        return !(userId && repo && core.repositoryRights(repo, core.actor(userId)).rank >= RANK.SmrOwner)
    }
    function hiddenTaskIds(userId, projectIds, workEffortIds) {
        const owns = new Map()
        const hidden = new Set()
        const a = core.actor(userId || null)
        const decide = issue => {
            if (!owns.has(issue.repositoryId)) {
                const repo = one(M + "SmithyRepository", {repositoryId: issue.repositoryId})
                owns.set(issue.repositoryId, !!userId && !!repo && core.repositoryRights(repo, a).rank >= RANK.SmrOwner)
            }
            if (!owns.get(issue.repositoryId)) hidden.add(issue.workEffortId)
        }
        // the confidential issues of the projects asked for, all of them, a page at a time in the task's order
        // with every companion project, where the confidential issues' tasks are, whatever the user sees
        const projects = Array.from(
            new Set(
                Array.from(projectIds || []).concat(
                    Array.from(
                        find(M + "SmithyRepository")
                            .condition("confidentialWorkEffortId", "not-equals", null)
                            .limit(5000)
                            .list()
                    ).map(repo => repo.confidentialWorkEffortId)
                )
            )
        )
        let after = ""
        while (projects.length) {
            const batch = Array.from(
                find(M + "SmithyIssueTask", {confidential: "Y"})
                    .condition("rootWorkEffortId", "in", projects)
                    .condition("workEffortId", "greater", after)
                    .orderBy("workEffortId")
                    .limit(500)
                    .list()
            )
            batch.forEach(decide)
            if (batch.length < 500) break
            after = batch[batch.length - 1].workEffortId
        }
        // and of the tasks named (those the user holds a role on, in any project)
        const named = Array.from(workEffortIds || [])
        for (let start = 0; start < named.length; start += 500)
            for (const issue of find(M + "SmithyIssue", {confidential: "Y"})
                .condition("workEffortId", "in", named.slice(start, start + 500))
                .list())
                decide(issue)
        return Array.from(hidden).sort()
    }
    /* Whether a commit pushed to a repository Smithy keeps may name a task by its key or a Task trailer (§8.4): a task
       that is an issue, only this repository's; any other task only of a project linked to the repository, and only when
       the pusher holds a role on that project that is not a client's. So a push to one repository neither closes nor
       attaches a commit to a sibling's issue or an internal task of somebody else's. */
    const CLIENT_ROLES = ["Customer", "CustomerBillTo", "ClientManager", "ClientBilling"]
    function referenceAllowed(repo, workEffortId, userId, projectIds) {
        const issue = one(M + "SmithyIssue", {workEffortId})
        if (issue) return issue.repositoryId === repo.repositoryId
        const task = one(WORK + "WorkEffort", {workEffortId})
        if (!task?.rootWorkEffortId || !projectIds.includes(task.rootWorkEffortId)) return false
        const partyId = userId ? one("moqui.security.UserAccount", {userId})?.partyId : null
        if (!partyId) return false
        return Array.from(
            find(WORK + "WorkEffortParty", {workEffortId: task.rootWorkEffortId, partyId})
                .conditionDate("fromDate", "thruDate", null)
                .list()
        ).some(row => !CLIENT_ROLES.includes(row.roleTypeId))
    }
    /* find#IssueReferences (§8.4): the issues a commit message pushed to a repository names. #n is the issue n of that
       repository; <repositoryPath>#n the issue n of another repository of the site, as a link only and only one that is
       public and that the pusher may view. A reference right after Fix, Close or Resolve (any form and case, an optional
       colon) marks its issue to complete, and only an issue of the pushed repository. At most 50 are read. */
    function issueReferences(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return {known: false, referenceList: []}
        // the keys and trailers the text names, kept only where this repository may name them
        const projectIds = Array.from(p.projectIdList || [])
        const referenceList = Array.from(p.keyReferenceList || []).filter(reference =>
            referenceAllowed(repo, reference.workEffortId, p.userId || null, projectIds)
        )
        if (repo.issuesEnabled !== "Y") return {known: true, referenceList}
        const message = text(p.text)
        const pattern = /(^|[^A-Za-z0-9_\/&#.-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)?#([1-9][0-9]{0,8})(?![A-Za-z0-9_])/g
        const closes = /\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s*$/i
        const found = new Map()
        let match
        let read = 0
        while ((match = pattern.exec(message)) !== null && read < 50) {
            read++
            const path = match[2] ? match[2].toLowerCase() : null
            const number = Number(match[3])
            let issue = null
            let complete = false
            if (!path || path === repo.repositoryPath) {
                issue = one(M + "SmithyIssue", {repositoryId: repo.repositoryId, issueNumber: number})
                complete = !!issue && closes.test(message.slice(0, match.index + match[1].length))
            } else {
                const other = one(M + "SmithyRepository", {siteId: repo.siteId, repositoryPath: path})
                const candidate =
                    other && other.issuesEnabled === "Y"
                        ? one(M + "SmithyIssue", {repositoryId: other.repositoryId, issueNumber: number})
                        : null
                const a = core.actor(p.userId || null)
                if (
                    candidate &&
                    candidate.confidential !== "Y" &&
                    core.issueAccess(core.repositoryRights(other, a), candidate, a, null).canRead
                )
                    issue = candidate
            }
            if (!issue) continue
            found.set(issue.workEffortId, found.get(issue.workEffortId) || false || complete)
        }
        for (const [workEffortId, complete] of found) {
            const task = one(WORK + "WorkEffort", {workEffortId})
            const had = referenceList.find(reference => reference.workEffortId === workEffortId)
            if (had) had.complete = !!had.complete || complete
            else if (task)
                referenceList.push({
                    workEffortId,
                    // the tracker's project, which the repository is linked to, wherever the task is: a confidential
                    // issue's task is in the companion project, and Fixes #n completes it all the same
                    rootWorkEffortId:
                        one(M + "SmithyIssue", {workEffortId})?.repositoryId === repo.repositoryId
                            ? repo.workEffortId
                            : task.rootWorkEffortId,
                    linkSourceEnumId: "WglsMessage",
                    complete
                })
        }
        return {known: true, referenceList}
    }
    /* check#TaskReference: the same rule for one task a branch or a tag names; known is false for a repository with no
       Smithy row, whose rule is the project's own. */
    function taskReference(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return {known: false, allowed: true}
        return {known: true, allowed: referenceAllowed(repo, p.workEffortId, p.userId || null, Array.from(p.projectIdList || []))}
    }
    /* The issues of a repository that its commits name, for a page of commits (§8.2): the numbers of those the caller may
       read, and a count of the other items a commit names, which are shown unnamed. */
    function commitIssues(r, commitIds, a) {
        const out = new Map()
        if (!commitIds.length) return out
        for (const link of find(WORK + "WorkEffortGitCommit", {repositoryId: r.repo.repositoryId})
            .condition("commitId", "in", commitIds)
            .limit(2000)
            .list()) {
            if (!out.has(link.commitId)) out.set(link.commitId, {issueNumbers: [], hiddenItemCount: 0})
            const entry = out.get(link.commitId)
            const issue = one(M + "SmithyIssue", {workEffortId: link.workEffortId})
            if (issue && issue.repositoryId === r.repo.repositoryId && r.repo.issuesEnabled === "Y" && heldIssue(r, issue, a))
                entry.issueNumbers.push(Number(issue.issueNumber))
            else entry.hiddenItemCount++
        }
        for (const entry of out.values()) entry.issueNumbers.sort((left, right) => left - right)
        return out
    }
    /* The same for one commit's page: each issue with its title and state. */
    function linkedIssues(r, commitId, a) {
        const named = commitIssues(r, [commitId], a).get(commitId) || {issueNumbers: [], hiddenItemCount: 0}
        const rowsOf = named.issueNumbers.map(issueNumber =>
            one(M + "SmithyIssue", {repositoryId: r.repo.repositoryId, issueNumber})
        )
        const items = publicItems(
            rowsOf.map(issue => issue.workEffortId),
            false
        )
        return {
            linkedIssues: rowsOf.map(issue => ({
                issueNumber: Number(issue.issueNumber),
                title: items.get(issue.workEffortId)?.title || "",
                state: items.get(issue.workEffortId)?.state || "open"
            })),
            hiddenItemCount: named.hiddenItemCount
        }
    }
    /* get#TaskIssue: the issue of a task, for Projects: nothing for a task that is no issue's, and nothing for a
       confidential issue's task when the user is no Owner of its repository by its Smithy rows (an operator sees it). */
    function taskIssue(workEffortId, userId) {
        const issue = workEffortId ? one(M + "SmithyIssue", {workEffortId}) : null
        const repo = issue ? one(M + "SmithyRepository", {repositoryId: issue.repositoryId}) : null
        if (!repo) return {}
        const confidential = issue.confidential === "Y"
        const operator = !!userId && userId === ec.user.userId && forum.isOperator()
        if (confidential && !operator && !(userId && core.repositoryRights(repo, core.actor(userId)).rank >= RANK.SmrOwner))
            return {}
        return {
            issueNumber: Number(issue.issueNumber),
            siteId: repo.siteId,
            repositoryId: repo.repositoryId,
            repositoryPath: repo.repositoryPath,
            confidential,
            rootCommEventId: issue.rootCommEventId,
            publicUrl: ec.resource
                .script("component://mr-mantle/service/mantle/public/PublicApps.js")
                .pageUrl(repo.siteId, "smithy", "/" + repo.repositoryPath + "/-/issues/" + Number(issue.issueNumber))
        }
    }
    return {
        syncSite,
        taskHidden,
        taskReference,
        taskIssue,
        issueProject,
        ensureIssue,
        noteTaskStatus,
        hiddenTaskIds,
        issueReferences,
        commitIssues,
        linkedIssues
    }
}
