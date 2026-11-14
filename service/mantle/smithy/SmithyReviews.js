/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Smithy's merge requests, forks and page edits (mr-pass plan/design-smithy.md §9, §15.5, DG4). A merge request is the git
 * host's (moqui.resource.GitMergeRequest: its number, branches, reviewers, checks and merge) with a SmithyMergeRequest row:
 * the site, the agreement's result and its conversation, a ForumTopic of kind record whose first post is its text.
 * Smithy.js calls this with its kit; each operation is a method of its map, run through execute().
 * - Who reads one is SmithyCore.mergeRequestAccess: a viewer of a repository whose merge requests are on. While its first
 *   post is held it is its author's and its moderators': Not Found to anyone else, and hidden in the git host
 *   (GitMergeRequest.hiddenDate), so its head is fetched by nobody else.
 * - Every text an account writes (the title, the first post, a review's summary, a line comment, a commit message of a
 *   page edit) passes the post gate (ForumCore.gate). A comment and a line comment are posts of the topic, written by
 *   the forum's publishPost; a line comment has a CommunicationEventGitAnchor row on the same event.
 * - The roles are Smithy's (§5.3), checked here before the git host is called, which is called with authorization
 *   disabled: a review's decision is a Developer's, a merge into a protected branch a Maintainer's and into any other a
 *   Developer's, whatever the host itself would allow.
 * - ensure() is the one place a SmithyMergeRequest and its topic are made, from the host's opened event, for a merge
 *   request made on a page, by a push to refs/for/<branch>, by a page's proposal and by Projects alike.
 * Entity access is privileged here; every projection passes the evaluator first.
 */
kit => {
    const {core, methods, flag, text, writer, handleOf, MERGE_METHODS, GIT_REPOSITORY} = kit
    const {M, GIT, forum, RANK, VISIBILITY_IDS} = core
    const {S, F, E, now, millis, me, find, one, rows, create, update, fail, missing, invalid, page, receipt, review, plainText} =
        forum
    const REVIEW = "org.moqui.git.GitReviewServices."
    const GMR = "moqui.resource.GitMergeRequest"
    const SMR = M + "SmithyMergeRequest"
    const ANCHOR = "mantle.party.communication.CommunicationEventGitAnchor"
    const STATES = {GmrDraft: "draft", GmrOpen: "open", GmrMerged: "merged", GmrClosed: "closed"}
    const OPEN = ["GmrDraft", "GmrOpen"]
    const REVIEWER_STATES = {
        GmrrRequested: "requested",
        GmrrApproved: "approved",
        GmrrChangesRequested: "changes",
        GmrrCommented: "commented"
    }
    /* What a page's call hands to ensure() through the execution context (the host's opened event carries the merge
       request's id alone): the text of the first post as typed and its format. */
    const TEXT_KEY = "mantle.smithy.mergeRequestText"
    const cf = () => ec.entity.conditionFactory
    const cond = (field, operator, value) => cf().makeCondition(field, operator, value)
    const all = conditions => cf().makeCondition(conditions, "and")
    const any = conditions => cf().makeCondition(conditions, "or")
    const given = value => value !== undefined && value !== null
    const denied = message => fail("Unauthorized", "accessDenied: " + message)
    const archived = () => fail("Conflict", "repositoryArchived: This repository is archived")
    const codeOf = problem => (/^([A-Za-z]+): /.exec(text(problem)) || [])[1] || ""
    const headRef = number => "refs/merge-requests/" + Number(number) + "/head"
    const agreement = () => kit.agreement
    function fresh(current, expected) {
        if (expected == null || expected === "" || Number(expected) !== Number(current))
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
    }
    /* A service of the git host after Smithy's own check: {out, problem}, the problem its first error line. */
    function hosted(name, parameters) {
        ec.message.pushErrors()
        try {
            const out = ec.service.sync().name(name).parameters(parameters).call()
            if (!ec.message.hasError()) return {out: out || {}, problem: null}
            const problem = text(ec.message.getErrorsString()).split("\n")[0]
            ec.logger.warn("Smithy call of " + name + " refused: " + problem)
            return {out: out || {}, problem}
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
    }
    /* A read of the git host that may have nothing to say (a commit no ref reaches now): its answer, or {}. */
    const soft = (name, parameters) => hosted(GIT + name, parameters).out
    const forumOps = () => ec.resource.script("component://mr-mantle/service/mantle/forum/Forum.js")
    /* An account by its profile, when the caller is shown that profile. */
    function profileView(siteId, partyId) {
        const profile = partyId ? one(S + "PublicSiteProfile", {siteId, partyId}) : null
        return profile && core.profileShown(profile, core.actor())
            ? {handle: profile.handle, displayName: profile.displayName || "", avatarUrl: null}
            : null
    }
    const partyOfUser = userId => (userId ? one("moqui.security.UserAccount", {userId})?.partyId || null : null)
    /* The party of a handle whose profile the caller is shown; a handle it is not shown names nobody. */
    function partyOfHandle(siteId, handle) {
        const profile = one(S + "PublicSiteProfile", {siteId, handle: text(handle).toLowerCase()})
        return profile && core.profileShown(profile, core.actor()) ? profile.partyId : null
    }

    // ===== a merge request as the caller holds it =====
    /* A repository whose merge requests are on, as the caller views it; Not Found for any other. */
    function reviewed(p) {
        const r = core.repository(p.repositoryId, p.siteId)
        if (r.repo.mergeRequestsEnabled === "N") missing()
        return r
    }
    function hostedByNumber(repositoryId, mergeRequestNum, lock) {
        const number = Number(mergeRequestNum)
        if (!Number.isInteger(number) || number < 1) missing()
        const found = Array.from(find(GMR, {repositoryId, mergeRequestNum: number}).limit(1).list())[0]
        if (!found) missing()
        return lock ? one(GMR, {mergeRequestId: found.mergeRequestId}, true) : found
    }
    /* A merge request with what the caller holds on it, or null: one the caller may not read, and one whose first post
       is held (or was removed) for anyone but its author and those who moderate it. One the host made that has no
       Smithy row yet (made before DG4, or its event was lost) gets it here. */
    function heldRequest(r, mr, a) {
        const row = one(SMR, {mergeRequestId: mr.mergeRequestId}) || ensure(mr.mergeRequestId)
        if (!row) return null
        const topic = one(F + "ForumTopic", {rootCommEventId: row.rootCommEventId})
        const access = core.mergeRequestAccess(r, row, a, topic?.contactListId || null)
        if (!access.canRead) return null
        const root = one(F + "ForumPostState", {communicationEventId: row.rootCommEventId})
        const pending = !root || root.visibility !== "approved"
        if (pending && !access.author && !access.canModerate) return null
        return {mr, row, topic, access, root, pending}
    }
    function requestFor(r, mergeRequestNum, lock) {
        return heldRequest(r, hostedByNumber(r.repo.repositoryId, mergeRequestNum, lock), core.actor()) || missing()
    }
    function writable(held) {
        if (held.access.writable) return
        const reason = held.access.writeRefusal || "accessDenied: Posting is not permitted"
        fail(reason.startsWith("repositoryArchived") ? "Conflict" : "Unauthorized", reason)
    }
    /* A writer on a merge request: the repository as viewed, the caller as one who may write, the row locked and (with
       expected) current. */
    function requestWrite(p, expected) {
        const r = reviewed(p)
        const {partyId} = writer(p.siteId)
        const held = requestFor(r, p.mergeRequestNum, true)
        held.row = one(SMR, {mergeRequestId: held.mr.mergeRequestId}, true)
        if (expected) fresh(Number(held.row.revision || 1), p.expectedRevision)
        writable(held)
        return {r, partyId, held, mr: held.mr, row: held.row}
    }
    const bump = row => update(row, {revision: Number(row.revision || 1) + 1}) && Number(row.revision)
    /* What the branch rules ask of a branch of a repository, with the methods as an operation's words. */
    function rulesOf(repositoryId, branch) {
        const rules = core.git("get#GitBranchRules", {repositoryId, refName: "refs/heads/" + branch, refType: "branch"})
        return {
            protected: !!rules.protected,
            requireMergeRequest: !!rules.requireMergeRequest,
            requiredApprovals: Number(rules.requiredApprovals || 0),
            dismissStaleApprovals: !!rules.dismissStaleApprovals,
            requiredStatusContexts: Array.from(rules.requiredStatusContexts || []),
            allowedMergeMethodIds: Array.from(rules.allowedMergeMethods || []),
            allowedMergeMethods: Array.from(rules.allowedMergeMethods || []).map(method => MERGE_METHODS[method] || method),
            mayPushDirectly: rules.mayPushDirectly !== false && !rules.requireMergeRequest
        }
    }
    /* The role a merge into a branch needs (§5.3, §9.1): a Maintainer for a protected branch, a Developer for any other,
       as they could push to it. Smithy's own rule: the host asks only for update. */
    const mergeRole = rules => (rules.protected ? "SmrMaintainer" : "SmrDeveloper")

    // ===== the projection =====
    function requestView(r, held, extra = {}) {
        const {mr, row, topic, root} = held
        const siteId = r.repo.siteId
        const author = profileView(siteId, row.authorPartyId)
        const source = mr.sourceRepositoryId ? one(M + "SmithyRepository", {repositoryId: mr.sourceRepositoryId}) : null
        const mergedBy = mr.mergedByUserId ? profileView(siteId, partyOfUser(mr.mergedByUserId)) : null
        return {
            mergeRequestNum: Number(mr.mergeRequestNum),
            repositoryPath: r.repo.repositoryPath,
            title: mr.title || "",
            state: STATES[mr.statusId] || "closed",
            author: author ? {...author, imported: false} : null,
            // a fork's path when the caller may view the fork; the target's own for a branch of it
            sourceRepositoryPath: mr.sourceRepositoryId
                ? source && source.siteId === siteId && core.repositoryViewable(source, core.actor())
                    ? source.repositoryPath
                    : null
                : r.repo.repositoryPath,
            sourceRef: mr.pushedForReview === "Y" ? null : mr.sourceRef,
            targetRef: mr.targetRef,
            pushedForReview: mr.pushedForReview === "Y",
            fetchRef: headRef(mr.mergeRequestNum),
            headCommitId: mr.headCommitId || null,
            baseCommitId: mr.baseCommitId || null,
            mergeable: mr.mergeableEnumId === "GmaMergeable" ? true : mr.mergeableEnumId === "GmaConflict" ? false : null,
            conflictPaths: text(mr.conflictPaths)
                .split("\n")
                .filter(path => !!path),
            mergeMethod: MERGE_METHODS[mr.mergeMethodEnumId || r.git?.defaultMergeMethodEnumId] || "merge",
            deleteSourceBranch: mr.deleteSourceBranch === "Y",
            approvalCount: extra.approvalCount ?? null,
            checkState: extra.checkState ?? null,
            agreementState: agreement().stateCode(row, mr),
            // the comments are the topic's visible posts after the first
            commentCount: Math.max(0, Number(topic?.visiblePostCount || 0) - (root?.visibility === "approved" ? 1 : 0)),
            createdAt: mr.createdDate || row.createdAt || null,
            updatedAt: mr.lastUpdatedDate || null,
            mergedAt: mr.mergedDate || null,
            mergedBy: mergedBy?.handle || null,
            closedAt: mr.closedDate || null,
            topic: {rootCommEventId: row.rootCommEventId, revision: Number(topic?.revision || 1)},
            revision: Number(row.revision || 1)
        }
    }
    const approvalsOf = mergeRequestId =>
        Number(hosted(REVIEW + "get#MergeRequestApprovals", {mergeRequestId}).out.approvalCount || 0)
    function reviewerViews(siteId, reviewerList) {
        return Array.from(reviewerList || []).map(reviewer => {
            const profile = profileView(siteId, partyOfUser(reviewer.userId))
            return {
                handle: profile?.handle || null,
                displayName: profile?.displayName || "",
                state: REVIEWER_STATES[reviewer.statusId] || "requested",
                reviewedCommitId: reviewer.reviewedCommitId || null
            }
        })
    }
    function capabilities(r, held, rules) {
        const {mr, access} = held
        const open = OPEN.includes(mr.statusId)
        const developer = r.rank >= RANK.SmrDeveloper
        return {
            canEdit: access.writable && open && (access.author || developer),
            canComment: access.writable,
            canReview: access.writable && open,
            canApprove: access.writable && open && developer && !access.author,
            canSetState: access.writable && mr.statusId !== "GmrMerged" && (access.author || r.rank >= RANK.SmrReporter),
            canMerge: access.writable && mr.statusId === "GmrOpen" && !held.pending && r.rank >= RANK[mergeRole(rules)],
            canSign: access.writable && agreement().canSign(r, held),
            canConfirmBot: access.writable && r.rank >= RANK.SmrMaintainer && agreement().botDeclared(held.row),
            canModerate: access.canModerate
        }
    }

    // ===== reads =====
    methods.getMergeRequest = p => {
        const r = reviewed(p)
        const held = requestFor(r, p.mergeRequestNum)
        const {mr} = held
        const {out, problem} = hosted(REVIEW + "get#MergeRequest", {mergeRequestId: mr.mergeRequestId})
        if (problem != null || !out.mergeRequest) missing()
        const rules = rulesOf(r.repo.repositoryId, mr.targetRef)
        const linked = kit.issues.issueSummaries(
            r,
            rows("mantle.work.effort.WorkEffortGitMergeRequest", {mergeRequestId: mr.mergeRequestId}, 200),
            core.actor()
        )
        const view = agreement().view(r, held)
        // what keeps it from merging: the host's reasons, and Smithy's own
        const missingList = Array.from(out.missingList || [])
        if (view.required && view.state !== "signed") missingList.push("The contributor agreement is not signed")
        return {
            mergeRequest: requestView(r, held, {
                approvalCount: Number(out.approvalCount || 0),
                checkState: out.checkState || null
            }),
            reviewerList: reviewerViews(p.siteId, out.reviewerList),
            checkList: Array.from(out.checkList || []).map(check => ({
                context: check.context,
                state: check.state,
                description: check.description || "",
                targetUrl: check.targetUrl || null,
                required: rules.requiredStatusContexts.includes(check.context)
            })),
            missingList,
            branchRules: {
                protected: rules.protected,
                requireMergeRequest: rules.requireMergeRequest,
                requiredApprovals: rules.requiredApprovals,
                dismissStaleApprovals: rules.dismissStaleApprovals,
                requiredStatusContexts: rules.requiredStatusContexts,
                allowedMergeMethods: rules.allowedMergeMethods,
                mergeRole: core.ROLE_CODES[mergeRole(rules)]
            },
            agreement: view,
            linkedIssues: linked,
            capabilities: capabilities(r, held, rules),
            pending: held.pending
        }
    }
    /* What a caller sees of one repository's merge requests, as a condition on GitMergeRequest: its moderators all of
       them; anyone else those that are not hidden (a held first post hides one) and their own. */
    function listCondition(r, a) {
        const ofRepository = cond("repositoryId", "equals", r.repo.repositoryId)
        if (r.rank >= RANK.SmrOwner || r.access.staff) return ofRepository
        const shown = cond("hiddenDate", "equals", null)
        return all([ofRepository, a.userId ? any([shown, cond("authorUserId", "equals", a.userId)]) : shown])
    }
    function reviewedOf(p, a) {
        if (!p.groupId) return [reviewed(p)]
        const g = core.group(p.groupId, p.siteId)
        return Array.from(
            find(M + "SmithyRepository", {siteId: p.siteId})
                .condition("repositoryPath", "like", g.group.groupPath + "/%")
                .orderBy("repositoryPath")
                .limit(200)
                .list()
        )
            .filter(repo => text(repo.repositoryPath).startsWith(g.group.groupPath + "/") && repo.mergeRequestsEnabled !== "N")
            .map(repo => ({...core.repositoryRights(repo, a), git: one(GIT_REPOSITORY, {repositoryId: repo.repositoryId})}))
            .filter(rights => rights.canView && !!rights.git)
    }
    methods.findMergeRequests = p => {
        const a = core.actor()
        const repositories = reviewedOf(p, a)
        const state = p.state || "open"
        const statuses = {open: OPEN, draft: ["GmrDraft"], merged: ["GmrMerged"], closed: ["GmrClosed"], all: null}
        if (!(state in statuses)) invalid("state must be open, draft, merged, closed or all")
        const pg = page(
            p,
            "smithyMergeRequests:" +
                JSON.stringify([
                    p.siteId,
                    p.repositoryId,
                    p.groupId,
                    state,
                    p.authorHandle,
                    p.reviewerHandle,
                    p.targetRef,
                    p.query
                ])
        )
        const empty = {mergeRequestList: [], counts: {open: 0, merged: 0, closed: 0}, nextCursor: null}
        if (!repositories.length) return empty
        const filters = []
        const userOf = handle => core.actorOfParty(partyOfHandle(p.siteId, handle)).userId || "_NONE_"
        if (p.authorHandle) filters.push(cond("authorUserId", "equals", userOf(p.authorHandle)))
        if (p.reviewerHandle) {
            const ids = rows("moqui.resource.GitMergeRequestReviewer", {userId: userOf(p.reviewerHandle)}, 5000).map(
                row => row.mergeRequestId
            )
            filters.push(cond("mergeRequestId", "in", ids.length ? ids : ["_NONE_"]))
        }
        if (p.targetRef) filters.push(cond("targetRef", "equals", text(p.targetRef).replace(/^refs\/heads\//, "")))
        if (p.query)
            filters.push(cf().makeCondition("title", "like", "%" + text(p.query).replace(/[%_\\]/g, "_") + "%", false, true))
        const byRepository = new Map(repositories.map(r => [r.repo.repositoryId, r]))
        const base = () => {
            let query = find(GMR).condition(any(repositories.map(r => listCondition(r, a))))
            for (const filter of filters) query = query.condition(filter)
            return query
        }
        const counts = {
            open: base().condition("statusId", "in", OPEN).count(),
            merged: base().condition("statusId", "equals", "GmrMerged").count(),
            closed: base().condition("statusId", "equals", "GmrClosed").count()
        }
        let query = base()
        if (statuses[state]) query = query.condition("statusId", "in", statuses[state])
        const found = Array.from(
            query
                .orderBy("-createdDate,-mergeRequestNum")
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list()
        )
        const shown = found.slice(0, pg.limit)
        // the combined check state of each head, one call a repository
        const states = new Map()
        for (const r of repositories) {
            const heads = shown
                .filter(mr => mr.repositoryId === r.repo.repositoryId && mr.headCommitId)
                .map(mr => mr.headCommitId)
            if (heads.length)
                states.set(
                    r.repo.repositoryId,
                    soft("get#GitCommitStatuses", {repositoryId: r.repo.repositoryId, commitIdList: heads, includeHidden: true})
                        .stateByCommit || {}
                )
        }
        const mergeRequestList = []
        for (const mr of shown) {
            const r = byRepository.get(mr.repositoryId)
            const held = heldRequest(r, mr, a)
            if (held)
                mergeRequestList.push(
                    requestView(r, held, {
                        approvalCount: OPEN.includes(mr.statusId) ? approvalsOf(mr.mergeRequestId) : null,
                        checkState: (states.get(mr.repositoryId) || {})[mr.headCommitId] || null
                    })
                )
        }
        return {mergeRequestList, counts, nextCursor: found.length > pg.limit ? pg.next(pg.offset + pg.limit) : null}
    }
    /* The line threads of a merge request as the caller reads them, of both shapes (§9.1): a post of the record topic with
       an anchor, whose replies are the posts that answer it, each read as a post is (a held one by its author and the
       moderators); and a Comment event filed on the merge request, as Projects wrote them before the merge request had a
       conversation, which are the team's notes and are a Developer's to read. */
    function threadsOf(r, held, path) {
        const {mr, row, access} = held
        let anchors = find(ANCHOR, {mergeRequestId: mr.mergeRequestId})
        if (path) anchors = anchors.condition("path", path)
        const out = []
        const readable = (state, event) =>
            state.visibility === "approved" ||
            (state.visibility === "pending" && (access.canModerate || (!!me() && event.fromPartyId === me()))) ||
            (state.visibility === "staff" && access.owner)
        const view = (event, state) => ({
            postId: event.communicationEventId,
            author: profileView(r.repo.siteId, event.fromPartyId),
            createdAt: event.entryDate || null,
            // a post's text is cleaned HTML; an older Comment is Markdown as typed
            body: state
                ? forum.recordText(event.body || "", row.rootCommEventId)
                : forum.renderSource("markdown", event.body || ""),
            state: state && state.visibility !== "approved" ? state.visibility : "published"
        })
        for (const anchor of Array.from(anchors.orderBy("path,newLine,oldLine,communicationEventId").limit(2000).list())) {
            const first = one(E + "CommunicationEvent", {communicationEventId: anchor.communicationEventId})
            if (!first) continue
            const state = one(F + "ForumPostState", {communicationEventId: first.communicationEventId})
            let postList
            if (state) {
                if (state.rootCommEventId !== row.rootCommEventId || !readable(state, first)) continue
                postList = [view(first, state)]
                for (const reply of Array.from(
                    find(E + "CommunicationEvent", {parentCommEventId: first.communicationEventId})
                        .orderBy("entryDate,communicationEventId")
                        .limit(500)
                        .list()
                )) {
                    const replyState = one(F + "ForumPostState", {communicationEventId: reply.communicationEventId})
                    if (replyState && readable(replyState, reply)) postList.push(view(reply, replyState))
                }
            } else {
                if (r.rank < RANK.SmrDeveloper) continue
                postList = [view(first, null)].concat(
                    Array.from(
                        find(E + "CommunicationEvent", {rootCommEventId: first.communicationEventId})
                            .condition("communicationEventId", "not-equals", first.communicationEventId)
                            .orderBy("entryDate")
                            .limit(500)
                            .list()
                    ).map(reply => view(reply, null))
                )
            }
            out.push({
                threadId: first.communicationEventId,
                path: anchor.path,
                oldLine: anchor.oldLine == null ? null : Number(anchor.oldLine),
                newLine: anchor.newLine == null ? null : Number(anchor.newLine),
                commitId: anchor.commitId || null,
                lineText: anchor.lineText || "",
                outdated: anchor.outdated === "Y",
                resolved: first.statusId === "CeResolved",
                postList
            })
        }
        return out
    }
    /* What a merge request changes, as the host compares it (a hidden one's head is read for those who see it). */
    function diffOf(mr, withDiffs) {
        const {out, problem} = hosted(REVIEW + "get#MergeRequestDiff", {mergeRequestId: mr.mergeRequestId, withDiffs})
        if (problem != null) missing()
        return out
    }
    methods.getMergeRequestChanges = p => {
        const r = reviewed(p)
        const held = requestFor(r, p.mergeRequestNum)
        const {mr, row} = held
        // an agent's tool is given no diff of a merge request whose agreement is required and not signed (§9.4, Dogfood
        // §10: "work from its description, never from its diff"): the title and the text only
        const state = agreement().stateCode(row, mr)
        if (flag(p.agent) && ["unsigned", "pending"].includes(state)) {
            const first = one(E + "CommunicationEvent", {communicationEventId: row.rootCommEventId})
            return {
                diffRefused: true,
                reason: "agreementUnsigned",
                agreementState: state,
                title: mr.title || "",
                description: plainText(first?.body || ""),
                baseCommitId: null,
                headCommitId: null,
                mergeBaseId: null,
                commitList: [],
                fileList: [],
                fileDiffList: [],
                insertions: 0,
                deletions: 0,
                truncated: false,
                threadList: []
            }
        }
        const withDiffs = flag(p.withDiffs)
        const diff = diffOf(mr, withDiffs)
        const files = Array.from(diff.fileList || [])
        if (p.path && !files.some(file => file.path === p.path)) missing()
        const diffs = kit.boundedDiffs(withDiffs ? files.filter(file => !p.path || file.path === p.path) : [])
        const signed = agreement().commitsSigned(r, held, Array.from(diff.commitList || []))
        return {
            diffRefused: false,
            baseCommitId: diff.baseCommitId || null,
            headCommitId: diff.headCommitId || null,
            mergeBaseId: diff.mergeBaseId || null,
            commitList: kit
                .commitViews(r.repo.repositoryId, diff.commitList)
                .map(commit => ({...commit, signed: signed.get(commit.commitId) ?? null})),
            fileList: kit.fileViews(files),
            fileDiffList: diffs.shown,
            insertions: Number(diff.insertions || 0),
            deletions: Number(diff.deletions || 0),
            truncated: diffs.truncated,
            threadList: threadsOf(r, held, p.path || null)
        }
    }

    // ===== opening: the Smithy row and the conversation =====
    /* The first post and the topic of a record, as fileIssue writes an issue's. */
    function openTopic(o) {
        const {siteId, scopeContactListId, partyId, gated, format, source, pending} = o
        const postId = forum.id()
        const body = o.hasText ? gated.body : ""
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            // a record's post has no category of its own: its topic names the scope
            contactListId: null,
            fromPartyId: partyId,
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
            editorPartyId: partyId,
            editedAt: now(),
            publicHistoryAllowed: "Y"
        })
        return postId
    }
    /* The gate for a merge request's title and text by its author. A Developer of the repository could push the branch
       itself, so the limits and holds of a first poster are not theirs. */
    function requestGate(siteId, scopeContactListId, partyId, r, o) {
        const source = text(o.source)
        const format = forum.sourceFormatOf(o.format || "markdown")
        const hasText = !!source.trim()
        const gated = forum.gate({
            siteId,
            actorPartyId: partyId,
            contactListId: scopeContactListId,
            kind: "mergeRequest",
            ...(o.confirmed ? {confirmed: true} : {}),
            title: text(o.title).trim().slice(0, 250),
            ...(hasText ? {body: forum.renderSource(format, source), source} : {}),
            sourceFormat: format,
            canModerate: r.rank >= RANK.SmrDeveloper || r.access.staff
        })
        return {gated, source, format, hasText}
    }
    /* Hides a merge request in the git host, or shows it. It fails closed: a merge request that could not be hidden
       fails what asked for it (the text is not left held with its commits readable); one that could not be shown stays
       hidden, which is logged, and false is answered. */
    function setHidden(mergeRequestId, hidden) {
        const {problem} = hosted(REVIEW + "set#MergeRequestHidden", {mergeRequestId, hidden})
        if (problem == null) return true
        if (hidden) fail("Unavailable", "The merge request could not be hidden while its text is held; try again")
        ec.logger.error("Merge request " + mergeRequestId + " could not be shown and stays hidden: " + problem)
        return false
    }
    /* ensure#MergeRequest (§9.1 "Made outside the pages", §9.3): the SmithyMergeRequest row and the record topic of a merge
       request of a repository Smithy keeps, when it has none; null for any other. The text is what the page handed over
       (TEXT_KEY), else the host's title and description (a push's -o title and first commit, Projects' form), as
       Markdown, through the gate as its author. A held text keeps the merge request hidden in the host; an allowed one
       shows it (the host starts a pushed, proposed or fork's one hidden: MoquiConf.xml review-start-hidden). A text
       the gate refuses outright closes the merge request and leaves it hidden, and its author is told by the page's
       own refusal or sees nothing opened; too soon after another post, it is held. */
    function ensure(mergeRequestId) {
        const mr = mergeRequestId ? one(GMR, {mergeRequestId}, true) : null
        if (!mr) return null
        const had = one(SMR, {mergeRequestId})
        if (had) return had
        const repo = one(M + "SmithyRepository", {repositoryId: mr.repositoryId}, true)
        if (!repo || !core.mounted(repo.siteId)) return null
        // one the gate refused: closed, and hidden for good
        if (mr.hiddenDate && mr.statusId === "GmrClosed") return null
        const partyId = partyOfUser(mr.authorUserId)
        if (!partyId) return null
        const handed = ec.context.sharedMap[TEXT_KEY]
        const own = handed && handed.userId === mr.authorUserId ? handed : null
        const typed = own || {title: mr.title, source: mr.description || "", format: "markdown"}
        const siteId = repo.siteId
        const r = core.repositoryRights(repo, core.actorOfParty(partyId))
        const scopeContactListId = core.scopeCategory(repo)
        const {gated, source, format, hasText} = requestGate(siteId, scopeContactListId, partyId, r, typed)
        // refused outright (the address, a sanction, a rule, the day's limit of merge requests): closed and hidden. Only
        // the interval between two posts, which says nothing of the text, holds it for a moderator instead
        const tooSoon = gated.decision === "refuse" && gated.refusal.kind === "Tarpit" && gated.refusal.reason !== "limitReached"
        if (gated.decision === "refuse" && !tooSoon) {
            ec.logger.warn("Merge request " + mergeRequestId + " refused by the gate: " + gated.refusal.message)
            if (!mr.hiddenDate) setHidden(mergeRequestId, true)
            if (OPEN.includes(mr.statusId)) hosted(REVIEW + "close#MergeRequest", {mergeRequestId})
            return null
        }
        // too soon after the author's last post: its text waits for a moderator rather than being lost with its commits
        const kept = tooSoon
            ? {title: text(typed.title).trim().slice(0, 250), body: hasText ? forum.renderSource(format, source) : undefined}
            : gated
        const pending = tooSoon || gated.decision === "hold"
        const postId = openTopic({siteId, scopeContactListId, partyId, gated: kept, format, source, hasText, pending})
        const row = create(SMR, {
            mergeRequestId,
            siteId,
            repositoryId: repo.repositoryId,
            rootCommEventId: postId,
            authorPartyId: partyId,
            agreementStateEnumId: "SmasOff",
            createdAt: now(),
            revision: 1
        })
        if (!tooSoon) forum.gateCommit(gated, {pending})
        if (pending) review(siteId, scopeContactListId, "post", postId, 1, tooSoon ? "rule" : gated.reasonFamily)
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
        forum.queueClassification(siteId, postId)
        const tracking = {siteId, partyId, scopeType: "topic", scopeId: postId}
        if (!one(F + "ForumPreference", tracking))
            create(F + "ForumPreference", {...tracking, watchLevel: "Tracking", revision: 1})
        // the host's copy is plain text, and what a rule censored is not kept there either
        const copy = plainText(kept.body || "").slice(0, 30000) || null
        const title = text(kept.title).replace(/[<>]/g, "").trim() || mr.title
        if (mr.title !== title || (mr.description || null) !== copy) update(mr, {title, description: copy})
        if (pending !== !!mr.hiddenDate) setHidden(mergeRequestId, pending)
        agreement().compute(mergeRequestId)
        return one(SMR, {mergeRequestId}) || row
    }
    /* A state change as a line of the conversation: a post of kind event, with no text of an account's to moderate. A
       line that the last post already says is not written again (a merge is told by two rules of the host). */
    function eventLine(row, line, partyId) {
        const topic = one(F + "ForumTopic", {rootCommEventId: row.rootCommEventId}, true)
        const first = one(E + "CommunicationEvent", {communicationEventId: row.rootCommEventId})
        if (!topic || !first) return
        const last = Array.from(
            find(F + "ForumPostState", {rootCommEventId: row.rootCommEventId})
                .orderBy("-ordinal")
                .limit(1)
                .list()
        )[0]
        if (
            last?.postKind === "event" &&
            one(E + "CommunicationEvent", {communicationEventId: last.communicationEventId})?.body === line
        )
            return
        const postId = forum.id()
        const ordinal = Number(topic.nextOrdinal)
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            contactListId: null,
            fromPartyId: partyId || null,
            rootCommEventId: row.rootCommEventId,
            parentCommEventId: row.rootCommEventId,
            subject: first.subject,
            body: line,
            statusId: "CeReceived",
            entryDate: now()
        })
        update(topic, {nextOrdinal: ordinal + 1, revision: Number(topic.revision) + 1, lastActivity: now()})
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId: row.rootCommEventId,
            ordinal,
            revision: 1,
            visibility: "approved",
            approvedRevision: 1,
            wiki: "N",
            reactionCount: 0,
            postKind: "event"
        })
    }
    /* handle#MergeRequestEvent: the host's events of a merge request, for a repository Smithy keeps (Smithy.secas.xml).
       opened (and any event of one that has no row yet) makes the row and the conversation; a new head, a new target
       and a reopening compute the agreement again; closed, reopened and merged are lines of the conversation. */
    function handleEvent(p) {
        const mr = p.mergeRequestId ? one(GMR, {mergeRequestId: p.mergeRequestId}) : null
        if (!mr || !one(M + "SmithyRepository", {repositoryId: mr.repositoryId})) return {}
        const had = one(SMR, {mergeRequestId: mr.mergeRequestId})
        const row = had || ensure(mr.mergeRequestId)
        if (!row) return {}
        const lines = {closed: "closed", reopened: "reopened", merged: "merged"}
        // the rule after the host's merge runs whether it merged or was refused: the line is of one that is merged
        const happened = {closed: "GmrClosed", merged: "GmrMerged"}[p.action]
        if (lines[p.action] && (!happened || mr.statusId === happened)) eventLine(row, lines[p.action], me())
        if (had && ["synchronize", "updated", "reopened", "ready"].includes(p.action)) agreement().compute(mr.mergeRequestId)
        return {rootCommEventId: row.rootCommEventId}
    }
    /* sync#MergeRequestHidden: the visibility of a post changed (a moderator approved it, hid it, removed it). When it
       is the first post of a merge request, the host hides the merge request while the post is not approved and shows
       it once it is, when its agreement is computed for the head its readers now see. */
    function syncHidden(communicationEventId) {
        const row = communicationEventId ? one(SMR, {rootCommEventId: communicationEventId}) : null
        const mr = row ? one(GMR, {mergeRequestId: row.mergeRequestId}) : null
        if (!mr) return
        const state = one(F + "ForumPostState", {communicationEventId})
        const hidden = state?.visibility !== "approved"
        if (hidden === !!mr.hiddenDate) return
        setHidden(mr.mergeRequestId, hidden)
        if (!hidden) agreement().compute(mr.mergeRequestId)
    }
    /* Opens a merge request in the host after the caller's checks, with the text handed to ensure(), which the host's
       opened event runs: {mergeRequestId, mergeRequestNum, row}. o: r (the target's rights), sourceRepositoryId,
       sourceRef, targetRef, title, source, format, draft, reviewerUserIds. The gate's refusal is asked first, so nothing
       is opened that it refuses. */
    function openRequest(o) {
        const repo = o.r.repo
        const partyId = me()
        const scopeContactListId = core.scopeCategory(one(M + "SmithyRepository", {repositoryId: repo.repositoryId}, true))
        const asked = requestGate(repo.siteId, scopeContactListId, partyId, o.r, {...o, confirmed: true})
        forum.gateRefuse(asked.gated)
        const pending = asked.gated.decision === "hold"
        const shared = ec.context.sharedMap
        shared[TEXT_KEY] = {userId: ec.user.userId, title: text(o.title), source: asked.source, format: asked.format}
        let made
        try {
            made = hosted(REVIEW + "create#MergeRequest", {
                repositoryId: repo.repositoryId,
                sourceRepositoryId: o.sourceRepositoryId || null,
                sourceRef: o.sourceRef,
                targetRef: o.targetRef,
                // plain text: the conversation has the text as typed
                title: text(asked.gated.title).replace(/[<>]/g, "").trim() || "Merge request",
                description: asked.hasText ? plainText(asked.gated.body).slice(0, 30000) : null,
                draft: !!o.draft,
                reviewerUserIdList: o.reviewerUserIds || [],
                hidden: pending
            })
        } finally {
            shared[TEXT_KEY] = null
        }
        if (made.problem != null) refuseOpen(made.problem)
        const row = one(SMR, {mergeRequestId: made.out.mergeRequestId}) || ensure(made.out.mergeRequestId)
        if (!row) fail("Unprocessable", "The merge request could not be opened")
        return {mergeRequestId: made.out.mergeRequestId, mergeRequestNum: Number(made.out.mergeRequestNum), row}
    }
    function refuseOpen(problem) {
        const code = codeOf(problem)
        if (code === "GitMergeRequestExists") fail("Conflict", problem.replace(/^[A-Za-z]+: /, ""))
        if (code === "GitArchived") archived()
        if (code === "GitNoSuchRef") invalid("sourceRef and targetRef name branches that are there")
        if (code === "GitNotInNetwork") invalid("The source is no fork of this repository, nor it of the source")
        invalid(problem.slice(0, 200))
    }
    const postState = row =>
        one(F + "ForumPostState", {communicationEventId: row.rootCommEventId})?.visibility === "approved"
            ? "published"
            : "pending"
    /* The accounts of some handles as reviewers: each one whose profile the caller is shown and who may view the
       repository; any other is Unprocessable. */
    function reviewerUsers(r, handles) {
        if (!Array.isArray(handles) || handles.length > 50) invalid("reviewerHandles is a list of at most 50 handles")
        return Array.from(new Set(handles)).map(handle => {
            const reviewer = core.actorOfParty(partyOfHandle(r.repo.siteId, handle))
            if (!reviewer.userId || !core.repositoryRights(r.repo, reviewer).canView)
                invalid("reviewerHandles names an account that may not view this repository")
            return reviewer.userId
        })
    }
    methods.createMergeRequest = p => {
        const r = reviewed(p)
        writer(p.siteId)
        return receipt(p, "createMergeRequest", () => {
            if (r.git.archivedDate) archived()
            const short = name =>
                text(name)
                    .trim()
                    .replace(/^refs\/heads\//, "")
            const sourceRef = short(p.sourceRef)
            const targetRef = short(p.targetRef) || r.git.branch || "main"
            if (!sourceRef) invalid("sourceRef is required")
            // the source: a branch of this repository, or of a fork the caller may push to (§9.2)
            const fromFork = !!p.sourceRepositoryId && p.sourceRepositoryId !== r.repo.repositoryId
            const source = fromFork ? core.repository(p.sourceRepositoryId, p.siteId) : r
            if (source.rank < RANK.SmrDeveloper) denied("Opening a merge request needs push to its source")
            if (!fromFork && sourceRef === targetRef) invalid("The source and the target are the same branch")
            const reviewerUserIds =
                given(p.reviewerHandles) && p.reviewerHandles.length ? reviewerUsers(r, p.reviewerHandles) : []
            if (reviewerUserIds.length) core.requireRole(r, "SmrDeveloper")
            const compared = hosted(GIT + "get#GitCompare", {
                repositoryId: r.repo.repositoryId,
                base: "refs/heads/" + targetRef,
                head: "refs/heads/" + sourceRef,
                ...(fromFork ? {headRepositoryId: source.repo.repositoryId} : {})
            })
            if (compared.problem != null) refuseOpen(compared.problem)
            if (!compared.out.headCommitId || !compared.out.baseCommitId)
                invalid("sourceRef and targetRef name branches that are there")
            if (Number(compared.out.aheadBy || 0) === 0) invalid("The source has no commit the target lacks")
            const made = openRequest({
                r,
                sourceRepositoryId: fromFork ? source.repo.repositoryId : null,
                sourceRef,
                targetRef,
                title: p.title,
                source: p.body,
                format: p.sourceFormat,
                draft: flag(p.draft),
                reviewerUserIds
            })
            return {mergeRequestNum: made.mergeRequestNum, rootCommEventId: made.row.rootCommEventId, state: postState(made.row)}
        })
    }

    // ===== changes of a merge request =====
    methods.updateMergeRequest = p => {
        const {r, partyId, held, mr, row} = requestWrite(p, true)
        if (!held.access.author) core.requireRole(r, "SmrDeveloper")
        if (!OPEN.includes(mr.statusId)) fail("Conflict", "A merged or closed merge request does not change")
        const fields = {}
        let gated = null
        if (given(p.title)) {
            gated = forum.gateRefuse(
                forum.gate({
                    siteId: p.siteId,
                    actorPartyId: partyId,
                    contactListId: held.topic?.contactListId || null,
                    kind: "mergeRequest",
                    confirmed: true,
                    title: text(p.title).trim(),
                    canModerate: held.access.canModerate || r.rank >= RANK.SmrDeveloper,
                    edit: true
                })
            )
            fields.title = text(gated.title).replace(/[<>]/g, "").trim()
            if (!fields.title) invalid("title is required")
        }
        if (given(p.targetRef) && p.targetRef !== "") fields.targetRef = text(p.targetRef).replace(/^refs\/heads\//, "")
        if (given(p.draft) && p.draft !== "") fields.draft = flag(p.draft)
        if (given(p.mergeMethod) && p.mergeMethod !== "")
            fields.mergeMethodEnumId =
                core.idOfCode(MERGE_METHODS, p.mergeMethod) || invalid("mergeMethod must be merge, squash, fastForward or rebase")
        if (given(p.deleteSourceBranch) && p.deleteSourceBranch !== "") {
            // a fork's branch is its owner's: only the merge request's author says it goes after the merge
            if (mr.sourceRepositoryId && !held.access.author) denied("Only its author says whether a fork's branch is deleted")
            fields.deleteSourceBranch = flag(p.deleteSourceBranch)
        }
        if (Object.keys(fields).length) {
            const {problem} = hosted(REVIEW + "update#MergeRequest", {mergeRequestId: mr.mergeRequestId, ...fields})
            if (problem != null) invalid(problem.slice(0, 200))
        }
        if (gated) {
            const first = one(E + "CommunicationEvent", {communicationEventId: row.rootCommEventId})
            if (first) update(first, {subject: gated.title})
            if (gated.flag)
                review(
                    p.siteId,
                    held.topic?.contactListId || null,
                    "post",
                    row.rootCommEventId,
                    Number(held.root?.revision || 1),
                    "rule"
                )
        }
        return {revision: bump(row)}
    }
    methods.setMergeRequestReviewers = p => {
        const {r, mr, row} = requestWrite(p, true)
        core.requireRole(r, "SmrDeveloper")
        const userIdList = reviewerUsers(r, p.reviewerHandles || [])
        const {problem} = hosted(REVIEW + "set#MergeRequestReviewers", {mergeRequestId: mr.mergeRequestId, userIdList})
        if (problem != null) invalid(problem.slice(0, 200))
        return {
            reviewerList: reviewerViews(
                p.siteId,
                Array.from(
                    find("moqui.resource.GitMergeRequestReviewer", {mergeRequestId: mr.mergeRequestId})
                        .orderBy("requestedDate")
                        .list()
                )
            ),
            revision: bump(row)
        }
    }
    methods.setMergeRequestState = p => {
        const {r, held, mr, row} = requestWrite(p, true)
        if (!["open", "closed"].includes(p.state)) invalid("state must be open or closed")
        if (!held.access.author) core.requireRole(r, "SmrReporter")
        if (mr.statusId === "GmrMerged") fail("Conflict", "The merge request is merged")
        const isClosed = mr.statusId === "GmrClosed"
        if ((p.state === "closed") !== isClosed) {
            // the line of the conversation is the host's event's (handleEvent)
            const {problem} = hosted(REVIEW + (p.state === "closed" ? "close#MergeRequest" : "reopen#MergeRequest"), {
                mergeRequestId: mr.mergeRequestId
            })
            if (problem != null) fail("Conflict", problem.slice(0, 200))
        }
        return {state: STATES[one(GMR, {mergeRequestId: mr.mergeRequestId}).statusId], revision: bump(row)}
    }

    // ===== reviews and line comments =====
    /* A post of the merge request's conversation by the caller, through the forum's publishPost (the gate, the revision,
       the review item of a held one, the mail): {postId, state}. */
    function post(siteId, row, body, sourceFormat, operationId, parentCommEventId) {
        return forumOps().execute("publishPost", {
            siteId,
            rootCommEventId: row.rootCommEventId,
            ...(parentCommEventId ? {parentCommEventId} : {}),
            body,
            sourceFormat: sourceFormat || "markdown",
            operationId
        })
    }
    /* A line comment (§9.1): a reply to a thread (threadId, the thread's first post), or a new thread on a line of the
       merge request's diff, as a post with its anchor. c: threadId, or path with oldLine or newLine (and commitId, the
       head the line was read at); body, sourceFormat; lineText when the caller has read the line (Projects). */
    function lineComment(siteId, held, c, operationId) {
        const {mr, row} = held
        if (c.threadId) {
            const anchor = typeof c.threadId === "string" ? one(ANCHOR, {communicationEventId: c.threadId}) : null
            if (!anchor || anchor.mergeRequestId !== mr.mergeRequestId) missing()
            // a thread Projects wrote before the merge request had a conversation is answered there
            if (!one(F + "ForumPostState", {communicationEventId: c.threadId})) invalid("That thread is answered in Projects")
            const made = post(siteId, row, c.body, c.sourceFormat, operationId, c.threadId)
            return {postId: made.postId, threadId: c.threadId, state: made.state}
        }
        const path = text(c.path)
        const line = side => (c[side] == null || c[side] === "" ? null : Number(c[side]))
        const oldLine = line("oldLine")
        const newLine = line("newLine")
        if (!path || (oldLine == null && newLine == null)) invalid("A line comment names a path and an old or a new line")
        let lineText = c.lineText ? text(c.lineText) : null
        if (lineText == null) {
            // the line is one of the diff's
            const file = Array.from(diffOf(mr, true).fileList || []).find(entry => entry.path === path)
            const found = Array.from(file?.hunks || [])
                .flatMap(hunk => Array.from(hunk.lines || []))
                .find(entry => (newLine != null ? Number(entry.newNo) === newLine : Number(entry.oldNo) === oldLine))
            if (!found) invalid("That line is not in the merge request's diff")
            lineText = text(found.text)
        }
        const made = post(siteId, row, c.body, c.sourceFormat, operationId, null)
        create(ANCHOR, {
            communicationEventId: made.postId,
            mergeRequestId: mr.mergeRequestId,
            repositoryId: mr.repositoryId,
            commitId: (core.HEX.test(text(c.commitId)) && c.commitId) || mr.headCommitId || null,
            path,
            oldLine,
            newLine,
            lineText: lineText.slice(0, 255) || null,
            outdated: "N"
        })
        return {postId: made.postId, threadId: made.postId, state: made.state}
    }
    methods.createReviewComment = p => {
        const {held} = requestWrite(p, false)
        return receipt(p, "createReviewComment", () => lineComment(p.siteId, held, p, p.operationId))
    }
    methods.submitReview = p => {
        const {r, partyId, held, mr, row} = requestWrite(p, false)
        if (!["approve", "request_changes", "comment"].includes(p.decision))
            invalid("decision must be approve, request_changes or comment")
        // a viewer's review is a comment; a decision is a Developer's, and nobody approves their own (§5.3)
        if (p.decision !== "comment") core.requireRole(r, "SmrDeveloper")
        if (p.decision === "approve" && held.access.author) denied("You do not approve your own merge request")
        if (!OPEN.includes(mr.statusId)) fail("Conflict", "A merged or closed merge request takes no review")
        const comments = given(p.commentList) ? p.commentList : []
        if (!Array.isArray(comments) || comments.length > 50) invalid("commentList is a list of at most 50 line comments")
        const summary = text(p.body)
        if (p.decision === "comment" && !summary.trim() && !comments.length)
            invalid("A review that only comments needs some text")
        if (text(p.operationId).length > 56) invalid("operationId is at most 56 characters here")
        return receipt(p, "submitReview", () => {
            comments.forEach((comment, index) => lineComment(p.siteId, held, comment || {}, p.operationId + "-" + index))
            const made = summary.trim() ? post(p.siteId, row, summary, p.sourceFormat, p.operationId, null) : null
            const {out, problem} = hosted(REVIEW + "submit#MergeRequestReview", {
                mergeRequestId: mr.mergeRequestId,
                decision: p.decision
            })
            if (problem != null) invalid(problem.slice(0, 200))
            if (p.decision !== "comment") eventLine(row, p.decision === "approve" ? "approved" : "requested changes", partyId)
            return {
                postId: made?.postId || null,
                reviewerState: REVIEWER_STATES[out.statusId] || "commented",
                approvalCount: approvalsOf(mr.mergeRequestId),
                state: made?.state || "published"
            }
        })
    }
    methods.resolveReviewThread = p => {
        const {r, partyId, held, mr} = requestWrite(p, false)
        const anchor = typeof p.threadId === "string" && p.threadId ? one(ANCHOR, {communicationEventId: p.threadId}) : null
        const first =
            anchor?.mergeRequestId === mr.mergeRequestId
                ? one(E + "CommunicationEvent", {communicationEventId: p.threadId})
                : null
        if (!first) missing()
        const isPost = !!one(F + "ForumPostState", {communicationEventId: p.threadId})
        if (!isPost && r.rank < RANK.SmrDeveloper) missing()
        if (first.fromPartyId !== partyId && !held.access.author) core.requireRole(r, "SmrDeveloper")
        const resolved = !given(p.resolved) || p.resolved === "" || flag(p.resolved)
        const statusId = resolved ? "CeResolved" : isPost ? "CeReceived" : "CeSent"
        if (first.statusId !== statusId) update(first, {statusId})
        return {resolved}
    }
    /* A comment Projects' Code writes on a merge request that has a conversation (mantle.work.GitServices
       create#ReviewComment): the same post, by the same rule, so both pages show one set of threads. Null for a merge
       request Smithy does not keep. */
    function reviewCommentPost(c) {
        const mr = c.mergeRequestId ? one(GMR, {mergeRequestId: c.mergeRequestId}) : null
        const repo = mr ? one(M + "SmithyRepository", {repositoryId: mr.repositoryId}) : null
        if (!repo || !core.mounted(repo.siteId)) return null
        const row = one(SMR, {mergeRequestId: mr.mergeRequestId}) || ensure(mr.mergeRequestId)
        if (!row) return null
        const r = {...core.repositoryRights(repo, core.actor()), git: one(GIT_REPOSITORY, {repositoryId: repo.repositoryId})}
        const held = heldRequest(r, mr, core.actor()) || missing()
        writer(repo.siteId)
        writable(held)
        const operationId = "review-" + forum.id().slice(-24)
        if (!c.path && !c.parentCommEventId) {
            const made = post(repo.siteId, row, c.body, "markdown", operationId, null)
            return {communicationEventId: made.postId, held: made.state === "pending"}
        }
        // a reply to a thread Projects wrote before the merge request had a conversation (a Comment event) is written
        // the old way, by the caller: not handled here
        if (c.parentCommEventId && !one(F + "ForumPostState", {communicationEventId: c.parentCommEventId})) return null
        // a reply names any comment of its thread: the thread is its first post
        let threadId = null
        if (c.parentCommEventId) {
            const parent = one(E + "CommunicationEvent", {communicationEventId: c.parentCommEventId})
            threadId = one(ANCHOR, {communicationEventId: c.parentCommEventId}) ? c.parentCommEventId : parent?.parentCommEventId
        }
        const made = lineComment(
            repo.siteId,
            held,
            {
                threadId,
                path: c.path,
                oldLine: c.oldLine,
                newLine: c.newLine,
                lineText: c.lineText || "",
                body: c.body,
                sourceFormat: "markdown"
            },
            operationId
        )
        return {communicationEventId: made.postId, held: made.state === "pending"}
    }

    // ===== merging =====
    methods.mergeMergeRequest = p => {
        const {r, held, mr, row} = requestWrite(p, true)
        const rules = rulesOf(r.repo.repositoryId, mr.targetRef)
        core.requireRole(r, mergeRole(rules))
        if (mr.statusId === "GmrMerged") fail("Conflict", "The merge request is merged")
        if (mr.statusId !== "GmrOpen") fail("Conflict", "Only an open merge request merges; a draft is marked ready first")
        if (held.pending || mr.hiddenDate) fail("Conflict", "The merge request waits for review of its text")
        if (p.expectedHeadCommitId && p.expectedHeadCommitId !== mr.headCommitId)
            fail("Conflict", "The source has new commits since you read it; reload and look at them")
        const methodId = p.mergeMethod
            ? core.idOfCode(MERGE_METHODS, p.mergeMethod) || invalid("mergeMethod must be merge, squash, fastForward or rebase")
            : mr.mergeMethodEnumId || r.git.defaultMergeMethodEnumId || "GmmMerge"
        if (rules.allowedMergeMethodIds.length && !rules.allowedMergeMethodIds.includes(methodId))
            invalid("The branch rules allow " + rules.allowedMergeMethods.join(", "))
        // the agreement, for the head that merges: Smithy's own refusal, beside the branch rule's required context
        const signed = agreement().compute(mr.mergeRequestId)
        if (signed.required && signed.state !== "signed")
            invalid("agreementUnsigned: The contributor agreement is not signed by everyone who wrote this")
        if (methodId === "GmmSquash" && signed.required && agreement().squashFolds(r.repo, mr, row))
            invalid(
                "squashFoldsSignature: A squash would put one person's signature of the agreement in another's commit; " +
                    "merge with a merge commit or a rebase"
            )
        const checks = soft("get#GitCommitStatuses", {repositoryId: mr.repositoryId, commitId: mr.headCommitId})
        const passed = Array.from(checks.statusList || [])
            .filter(check => check.state === "success")
            .map(check => check.context)
        const failing = rules.requiredStatusContexts.filter(context => !passed.includes(context))
        if (failing.length) invalid("checksRequired: Checks not passed: " + failing.join(", "))
        if (approvalsOf(mr.mergeRequestId) < rules.requiredApprovals)
            invalid("The branch rules ask for " + rules.requiredApprovals + " approvals")
        // the source branch goes only when the caller could delete it: a Developer of the source repository (a fork's
        // too), where its rules allow. That is decided here, by Smithy's roles: the git host deletes a fork's branch
        // only for a user with its own delete right there, which an account of a public site does not hold, so it is
        // told that the application decided (forceDeleteSourceBranch), and only then
        const wanted =
            given(p.deleteSourceBranch) && p.deleteSourceBranch !== ""
                ? flag(p.deleteSourceBranch)
                : mr.deleteSourceBranch === "Y"
        const sourceId = mr.sourceRepositoryId || mr.repositoryId
        let deleteSourceBranch = false
        if (wanted && mr.pushedForReview !== "Y") {
            const sourceRepo = one(M + "SmithyRepository", {repositoryId: sourceId})
            const sourceRank =
                sourceId === mr.repositoryId ? r.rank : sourceRepo ? core.repositoryRights(sourceRepo, core.actor()).rank : 0
            const sourceRules = Array.from(
                soft("get#GitBranchRules", {repositoryId: sourceId, refName: "refs/heads/" + mr.sourceRef, refType: "branch"})
                    .ruleList || []
            )
            deleteSourceBranch =
                sourceRank >= RANK.SmrDeveloper &&
                sourceRules.every(rule => rule.allowDelete === "Y" || rule.allowDelete === true)
        }
        // what was checked is what merges: the head read above, by its id (GitStaleRef when it is another by then)
        const {out, problem: refusal} = hosted(REVIEW + "merge#MergeRequest", {
            mergeRequestId: mr.mergeRequestId,
            mergeMethodEnumId: methodId,
            message: text(p.message) || null,
            expectedHeadCommitId: mr.headCommitId,
            deleteSourceBranch,
            forceDeleteSourceBranch: deleteSourceBranch && sourceId !== mr.repositoryId
        })
        // a rule's refusal (the agreement's gate) is the git host's error with "declined: " before it
        const problem = refusal == null ? null : refusal.replace(/^declined: /, "")
        const conflicts = Array.from(out.conflictPaths || [])
        if (conflicts.length) fail("Conflict", "It does not merge cleanly: conflicts in " + conflicts.join(", "))
        if (problem != null) {
            if (codeOf(problem) === "GitProtectedBranch") denied("A branch rule does not allow that")
            if (codeOf(problem) === "GitArchived") archived()
            if (codeOf(problem) === "GitStaleRef")
                fail("Conflict", "The source has new commits since you read it; reload and look at them")
            if (["agreementUnsigned", "squashFoldsSignature"].includes(codeOf(problem))) invalid(problem.slice(0, 400))
            if (/conflict|moved|new head/i.test(problem)) fail("Conflict", problem.slice(0, 200))
            invalid(problem.slice(0, 200))
        }
        bump(row)
        return {
            commitId: out.commitId || null,
            mergeMethod: MERGE_METHODS[out.mergeMethodEnumId || methodId] || "merge",
            state: "merged"
        }
    }

    // ===== forks (§9.2) =====
    methods.forkRepository = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const {partyId, access} = writer(p.siteId)
        const parent = p.targetGroupId ? core.group(p.targetGroupId, p.siteId) : null
        if (parent) core.requireRole(parent, "SmrMaintainer")
        kit.lockNames(p.siteId)
        return receipt(p, "forkRepository", () => {
            const s = core.settings(p.siteId)
            if (r.git.archivedDate) archived()
            if (r.git.repositoryKind === "remote") invalid("policyRefused: A mirror of another server is not forked")
            // a repository that is not public is forked by who works in it: a copy of its code is theirs to keep in step
            if (r.visibility !== 1) core.requireRole(r, "SmrDeveloper")
            // who may fork is the site's policy; its owners always may
            if (!access.owner && s.forkCreateEnumId !== "ScpVerified")
                invalid("policyRefused: Only the site's operators fork here")
            if (
                !parent &&
                find(M + "SmithyRepository", {siteId: p.siteId, ownerPartyId: partyId}).count() >=
                    kit.quota.accountLimits(p.siteId, partyId, s).repositories
            )
                invalid("quotaExceeded: You have as many personal repositories as this site allows")
            const slug = text(p.slug || r.repo.slug).toLowerCase()
            const name = text(p.name).trim() || r.repo.name
            // the fork's name passes the gate as a name does (the day's limit for forks is DG6's)
            forum.gateRefuse(
                forum.gate({
                    siteId: p.siteId,
                    actorPartyId: partyId,
                    contactListId: parent?.group.contactListId || null,
                    kind: "fork",
                    confirmed: true,
                    body: name + "\n" + slug
                })
            )
            // no wider than its parent, its namespace's ceiling, or what was asked: the narrowest of the three
            const asked = p.visibility ? core.visibilityRank(kit.visibilityId(p.visibility, null)) : 1
            const visibility = Math.max(asked, r.visibility, parent ? parent.visibility : 1)
            const made = kit.makeRepository({
                siteId: p.siteId,
                partyId,
                access,
                parent,
                slug,
                name,
                description: r.git.description || "",
                visibility: core.VISIBILITY_CODES[VISIBILITY_IDS[visibility]],
                forkOfRepositoryId: r.repo.repositoryId
            })
            forum.audit(p.siteId, null, "repository", made.repositoryId, "forkRepository", r.repo.repositoryPath, null, 1)
            return made
        })
    }
    methods.findForks = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const a = core.actor()
        const pg = page(p, "smithy-forks:" + p.repositoryId)
        const shown = []
        for (const fork of Array.from(
            find(GIT_REPOSITORY, {forkOfRepositoryId: r.repo.repositoryId}).orderBy("repositoryId").limit(2000).list()
        )) {
            const repo = one(M + "SmithyRepository", {repositoryId: fork.repositoryId})
            const rights = repo && repo.siteId === p.siteId ? core.repositoryRights(repo, a) : null
            if (rights?.canView) shown.push({...rights, git: fork})
        }
        return {
            repositoryList: shown.slice(pg.offset, pg.offset + pg.limit).map(kit.repositoryView),
            nextCursor: shown.length > pg.offset + pg.limit ? pg.next(pg.offset + pg.limit) : null
        }
    }

    // ===== editing a file on its page (§9.5) =====
    const ACTIONS = ["create", "update", "rename", "delete", "upload"]
    const DESTINATIONS = ["branch", "newBranch", "proposal"]
    function cleanPath(value, name) {
        const path = text(value).replace(/^\/+/, "")
        const segments = path.split("/")
        if (
            !path ||
            path.length > 1024 ||
            /[\u0000-\u001f\\]/.test(path) ||
            segments.some(segment => ["", ".", "..", ".git"].includes(segment))
        )
            invalid("notEditable[" + name + "]: That is no path of a file in the repository")
        return path
    }
    /* Whether a path of a branch is kept in Git LFS: its entry says so, or a pattern of the root .gitattributes with
       filter=lfs names it (a new file's). */
    function lfsTracked(repositoryId, commitId, path, entry) {
        if (entry?.lfs) return true
        const attributes = soft("get#GitBlob", {repositoryId, revision: commitId, path: ".gitattributes"}).text
        if (!attributes) return false
        const name = path.slice(path.lastIndexOf("/") + 1)
        return text(attributes)
            .split("\n")
            .map(line => line.trim().split(/\s+/))
            .filter(words => words.length > 1 && !words[0].startsWith("#") && words.slice(1).includes("filter=lfs"))
            .some(words => {
                const pattern = words[0].replace(/^\//, "")
                const expression = new RegExp(
                    "^" +
                        pattern
                            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                            .replace(/\*\*\/?/g, "\u0000")
                            .replace(/\*/g, "[^/]*")
                            .replace(/\?/g, "[^/]")
                            .replace(/\u0000/g, ".*") +
                        "(/.*)?$"
                )
                return expression.test(pattern.includes("/") ? path : name)
            })
    }
    const entryAt = (repositoryId, commitId, path) => {
        const cut = path.lastIndexOf("/")
        const parent = soft("get#GitTree", {repositoryId, revision: commitId, path: cut < 0 ? "" : path.slice(0, cut)})
        return Array.from(parent.entryList || []).find(entry => entry.path === path) || null
    }
    /* Where an edit of a branch may be saved by the caller, the default first (§9.5): the branch, for a Developer when
       the rules allow a direct push; a new branch with a merge request, for a Developer; a proposal, for a confirmed
       viewer without push. The last two need the repository's merge requests on. */
    function destinationsOf(r, rules, branchNames) {
        const confirmed = !!me() && (core.confirmedNow() || r.access.operator) && !r.access.suspended
        const developer = confirmed && r.rank >= RANK.SmrDeveloper
        const requests = r.repo.mergeRequestsEnabled !== "N"
        const list = []
        if (developer && rules.mayPushDirectly) list.push("branch")
        if (developer && requests) list.push("newBranch")
        if (confirmed && !developer && requests) list.push("proposal")
        const handle = handleOf(r.repo.siteId, me()) || "edit"
        let k = 1
        while (branchNames.includes(handle + "-patch-" + k)) k++
        const suggestedBranch = handle + "-patch-" + k
        return {
            suggestedBranch,
            destinationList: list.map((destination, index) => ({
                destination,
                default: index === 0,
                branchName: destination === "newBranch" ? suggestedBranch : null
            }))
        }
    }
    methods.getEditContext = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const editAction = p.editAction || "update"
        if (!ACTIONS.includes(editAction)) invalid("editAction must be create, update, rename, delete or upload")
        const refs = core.git("get#GitRefs", {repositoryId: p.repositoryId})
        const ref = core.splitRefPath(p.repositoryId, p.refPath, refs)
        const maxEditBytes = core.settings(p.siteId).maxEditBytes
        const adds = ["create", "upload"].includes(editAction)
        const entry = !ref.empty && ref.path ? entryAt(p.repositoryId, ref.commitId, ref.path) : null
        // an edit is of a file that is there; a new file's path is a directory, or a path nothing has yet
        if (!adds && (!entry || ["dir", "submodule"].includes(entry.type))) missing()
        const size = entry && !adds ? Number(entry.size || 0) : 0
        let reason = null
        let blob = {}
        if (ref.kind !== "branch") reason = "notBranch"
        else if (r.git.archivedDate) reason = "archived"
        else if (r.git.repositoryKind === "remote") reason = "mirror"
        else if (!adds) {
            if (entry.lfs) reason = "lfs"
            else if (size > maxEditBytes) reason = "tooLarge"
            else {
                blob = core.git("get#GitBlob", {repositoryId: p.repositoryId, revision: ref.commitId, path: ref.path})
                if (blob.binary || blob.text == null) reason = editAction === "update" ? "binary" : null
            }
        }
        const rules = ref.kind === "branch" ? rulesOf(p.repositoryId, ref.name) : {protected: false, mayPushDirectly: false}
        const where = destinationsOf(
            r,
            rules,
            Array.from(refs.refList || [])
                .filter(one => one.refType === "branch")
                .map(one => one.shortName)
        )
        const editable = reason == null
        return {
            ref: {kind: ref.kind, name: ref.name, fullName: ref.fullName, commitId: ref.commitId},
            path: ref.path,
            blobId: !adds && entry ? entry.objectId || null : null,
            text: editable && !adds && blob.text != null ? blob.text : null,
            size,
            maxEditBytes,
            editable,
            reason,
            destinationList: editable ? where.destinationList : [],
            protected: !!rules.protected,
            agreementFile: agreement().isAgreementFile(r, ref.path),
            suggestedBranch: where.suggestedBranch
        }
    }
    /* The author of a page's commit: the account by its display name and its address (§9.5); the committer is the
       server. */
    function authorOf(siteId) {
        const account = one("moqui.security.UserAccount", {userId: ec.user.userId})
        const profile = one(S + "PublicSiteProfile", {siteId, partyId: me()})
        return {
            authorName: text(profile?.displayName || account?.userFullName || profile?.handle || account?.username).replace(
                /[<>\n]/g,
                ""
            ),
            authorEmail: account?.emailAddress || null
        }
    }
    /* Saves one commit of a page's edit after its caller's checks (§9.5): on the branch, on a new branch with a merge
       request, or as a proposal. o: r, siteId, branch, destination (the caller's default when empty), files (fileMap,
       removePaths, renameMap, fileLocationMap, expectedBlobIds), message, newBranchName, title (of the merge request),
       topic (a proposal's). The destination is checked against what the caller holds; the message passes the gate, as
       a merge request's text when the save opens one. Gives {commitId, branch, mergeRequestNum, destination}. */
    function save(o) {
        const {r, siteId, branch} = o
        const partyId = me()
        const refs = core.git("get#GitRefs", {repositoryId: r.repo.repositoryId, refType: "branch"})
        const branchNames = Array.from(refs.refList || []).map(ref => ref.shortName)
        if (!branchNames.includes(branch)) missing()
        if (r.git.archivedDate) archived()
        if (r.git.repositoryKind === "remote") invalid("notEditable: A mirror of another server is not edited here")
        const where = destinationsOf(r, rulesOf(r.repo.repositoryId, branch), branchNames)
        const allowed = where.destinationList.map(entry => entry.destination)
        const destination = o.destination || allowed[0]
        if (!DESTINATIONS.includes(destination)) invalid("destination must be branch, newBranch or proposal")
        if (!allowed.includes(destination)) denied("You may not save there; choose another destination")
        const message = text(o.message).trim()
        if (!message || message.length > 4000) invalid("message is 1 to 4000 characters")
        const lines = message.split("\n")
        const scopeContactListId = core.scopeCategory(one(M + "SmithyRepository", {repositoryId: r.repo.repositoryId}, true))
        const title = text(o.title).trim() || lines[0].slice(0, 250)
        const body = lines.slice(1).join("\n").trim()
        let commitMessage = message
        if (destination === "branch") {
            // a commit message is text an account writes: the address, the sanctions and the rules, and nothing held
            const gated = forum.gateRefuse(
                forum.gate({
                    siteId,
                    actorPartyId: partyId,
                    contactListId: scopeContactListId,
                    kind: "repository",
                    confirmed: true,
                    body: message
                })
            )
            commitMessage = gated.body
        } else
            forum.gateRefuse(
                requestGate(siteId, scopeContactListId, partyId, r, {title, source: body, format: "markdown", confirmed: true})
                    .gated
            )
        const newBranch = destination === "newBranch" ? text(o.newBranchName).trim() || where.suggestedBranch : null
        if (newBranch && branchNames.includes(newBranch)) invalid("nameTaken[newBranchName]: There is a branch of that name")
        const shared = ec.context.sharedMap
        if (destination === "proposal") shared[TEXT_KEY] = {userId: ec.user.userId, title, source: body, format: "markdown"}
        let committed
        try {
            committed = hosted(GIT + "commit#GitFiles", {
                repositoryId: r.repo.repositoryId,
                message: commitMessage,
                branch,
                ...o.files,
                ...(newBranch ? {newBranch} : {}),
                ...(destination === "proposal"
                    ? {
                          asProposal: true,
                          topic: o.topic || "edit-" + forum.id().slice(-12),
                          title: title.replace(/[<>]/g, ""),
                          description: body || null
                      }
                    : {}),
                ...authorOf(siteId)
            })
        } finally {
            shared[TEXT_KEY] = null
        }
        const {out, problem} = committed
        if (problem != null) {
            const code = codeOf(problem)
            if (["GitReviewPushTooLarge", "GitReviewQuota"].includes(code))
                invalid("quotaExceeded: " + problem.replace(/^[A-Za-z]+: /, ""))
            if (code === "GitRefExists") invalid("nameTaken[newBranchName]: There is a branch of that name")
            kit.refuseWrite(problem)
        }
        if (out.conflict || out.errorCode === "GitFileChanged")
            fail("Conflict", "fileChanged: The file changed since you opened it; look at what is there now beside your text")
        if (!out.commitId) invalid("Nothing changed, so nothing was saved")
        let mergeRequestNum = out.mergeRequestNum == null ? null : Number(out.mergeRequestNum)
        if (destination === "newBranch")
            mergeRequestNum = openRequest({
                r,
                sourceRef: newBranch,
                targetRef: branch,
                title,
                source: body,
                format: "markdown"
            }).mergeRequestNum
        if (destination === "proposal" && out.mergeRequestId && !one(SMR, {mergeRequestId: out.mergeRequestId}))
            ensure(out.mergeRequestId)
        return {commitId: out.commitId, branch: newBranch || branch, mergeRequestNum, destination}
    }
    methods.commitFile = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const {partyId} = writer(p.siteId)
        if (!ACTIONS.includes(p.action)) invalid("action must be create, update, rename, delete or upload")
        return receipt(p, "commitFile", () => {
            const branch = text(p.branch).replace(/^refs\/heads\//, "") || r.git.branch || "main"
            const head = Array.from(
                core.git("get#GitRefs", {repositoryId: p.repositoryId, refType: "branch"}).refList || []
            ).find(ref => ref.shortName === branch)
            if (!head) missing()
            const path = cleanPath(p.path, "path")
            const maxEditBytes = core.settings(p.siteId).maxEditBytes
            const entry = entryAt(p.repositoryId, head.commitId, path)
            const tracked = target => lfsTracked(p.repositoryId, head.commitId, target, target === path ? entry : null)
            const adds = ["create", "upload"].includes(p.action)
            if (!adds && (!entry || ["dir", "submodule"].includes(entry.type))) missing()
            if (!adds && !p.baseBlobId) invalid("baseBlobId is the blob the edit began from")
            // a new file where a file is: a name that is taken, unless the caller names the blob it means to replace
            const taken = target => invalid("nameTaken[newPath]: A file is at " + target + " already")
            if (adds && entry && (!p.baseBlobId || p.baseBlobId !== entry.objectId)) taken(path)
            const files = {}
            let staged = null
            /* A page's text in the file's own line endings: a browser sends a textarea's lines with CR LF, which would
               rewrite every line of the file. LF, unless the file that is there uses CR LF; LF for a new file. */
            const content = () => {
                const was =
                    entry && !entry.lfs && !adds
                        ? soft("get#GitBlob", {repositoryId: p.repositoryId, revision: head.commitId, path}).text
                        : null
                const lines = text(p.content).replace(/\r\n?/g, "\n")
                const typed = /\r\n/.test(text(was)) ? lines.replace(/\n/g, "\r\n") : lines
                // the size in bytes, as the file is stored
                let bytes = 0
                for (const character of typed.length > maxEditBytes ? "" : typed) {
                    const point = character.codePointAt(0)
                    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
                }
                if (typed.length > maxEditBytes || bytes > maxEditBytes)
                    invalid("notEditable: A file of more than " + maxEditBytes + " bytes is pushed with git")
                return typed
            }
            if (p.action === "delete") {
                files.removePaths = [path]
                files.expectedBlobIds = {[path]: p.baseBlobId}
            } else if (p.action === "rename") {
                const newPath = cleanPath(p.newPath, "newPath")
                if (newPath === path) invalid("newPath is another path")
                if (tracked(path) || tracked(newPath)) invalid("notEditable: A file kept in Git LFS is changed with git")
                if (entryAt(p.repositoryId, head.commitId, newPath)) taken(newPath)
                files.renameMap = {[path]: newPath}
                if (given(p.content) && p.content !== "") files.fileMap = {[newPath]: content()}
                files.expectedBlobIds = {[path]: p.baseBlobId, [newPath]: ""}
            } else if (p.action === "upload") {
                if (tracked(path)) invalid("notEditable: A file kept in Git LFS is pushed with git")
                // a staged upload of the caller's that passed scanning (the forum's stageAttachment)
                const attachment = p.attachmentId ? one(F + "ForumAttachment", {attachmentId: p.attachmentId}, true) : null
                const usable =
                    attachment &&
                    attachment.siteId === p.siteId &&
                    attachment.ownerPartyId === partyId &&
                    attachment.purpose === "repositoryFile" &&
                    !attachment.communicationEventId &&
                    attachment.scanState === "clean" &&
                    !(attachment.expiresAt && millis(attachment.expiresAt) <= millis(now()))
                if (!usable) invalid("Attachment is unavailable or has not passed scanning")
                if (Number(attachment.byteSize || 0) > maxEditBytes)
                    invalid("notEditable: A file of more than " + maxEditBytes + " bytes is pushed with git and Git LFS")
                files.fileLocationMap = {[path]: attachment.location}
                files.expectedBlobIds = {[path]: p.baseBlobId || ""}
                staged = attachment
            } else {
                if (tracked(path)) invalid("notEditable: A file kept in Git LFS is changed with git")
                if (p.action === "update" && Number(entry.size || 0) > maxEditBytes)
                    invalid("notEditable: A file of more than " + maxEditBytes + " bytes is changed with git")
                files.fileMap = {[path]: content()}
                files.expectedBlobIds = {[path]: p.action === "create" ? (entry ? p.baseBlobId : "") : p.baseBlobId}
            }
            const defaults = {create: "Add ", update: "Update ", rename: "Rename ", delete: "Delete ", upload: "Upload "}
            const saved = save({
                r,
                siteId: p.siteId,
                branch,
                destination: p.destination || null,
                files,
                message: text(p.message).trim() || defaults[p.action] + path,
                newBranchName: p.newBranchName,
                title: p.mergeRequestTitle
            })
            // the staged upload is committed: it is released
            if (staged) {
                try {
                    ec.resource.getLocationReference(staged.location).delete()
                } catch (error) {
                    ec.logger.warn("The staged upload " + staged.attachmentId + " was not removed: " + error)
                }
                staged.delete()
            }
            return saved
        })
    }

    // ===== what a commit names (§8.4) =====
    /* The merge requests of a repository that a commit names (!n, or #n where no issue has that number) or whose head or
       merge it is, for the commit's page: those the caller may read. */
    function commitRequests(r, commit, a) {
        if (r.repo.mergeRequestsEnabled === "N") return []
        const numbers = new Set()
        const pattern = /(^|[^A-Za-z0-9_\/&#!.-])([#!])([1-9][0-9]{0,8})(?![A-Za-z0-9_])/g
        let match
        let read = 0
        while ((match = pattern.exec(text(commit.message))) !== null && read < 50) {
            read++
            const number = Number(match[3])
            if (
                match[2] === "!" ||
                r.repo.issuesEnabled !== "Y" ||
                !one(M + "SmithyIssue", {repositoryId: r.repo.repositoryId, issueNumber: number})
            )
                numbers.add(number)
        }
        const found = new Map()
        const take = mr => found.set(mr.mergeRequestId, mr)
        for (const number of numbers)
            for (const mr of find(GMR, {repositoryId: r.repo.repositoryId, mergeRequestNum: number}).limit(1).list()) take(mr)
        for (const field of ["headCommitId", "mergeCommitId"])
            for (const mr of find(GMR, {repositoryId: r.repo.repositoryId, [field]: commit.commitId})
                .limit(20)
                .list())
                take(mr)
        return Array.from(found.values())
            .filter(mr => !!heldRequest(r, mr, a))
            .sort((left, right) => Number(left.mergeRequestNum) - Number(right.mergeRequestNum))
            .map(mr => ({
                mergeRequestNum: Number(mr.mergeRequestNum),
                title: mr.title || "",
                state: STATES[mr.statusId] || "closed"
            }))
    }
    /* A repository's record topics follow it to its new scope category (§12.1) after a transfer: the topics of its issues
       and merge requests, and the review items of their posts that wait. */
    function moveScope(repo, oldContactListId) {
        const contactListId = core.scopeCategory(repo)
        if (!contactListId || contactListId === oldContactListId) return
        for (const entity of ["SmithyIssue", "SmithyMergeRequest"]) {
            let offset = 0
            for (;;) {
                const batch = Array.from(
                    find(M + entity, {repositoryId: repo.repositoryId})
                        .orderBy(entity === "SmithyIssue" ? "issueNumber" : "mergeRequestId")
                        .offset(offset)
                        .limit(500)
                        .list()
                )
                for (const record of batch) {
                    const topic = one(F + "ForumTopic", {rootCommEventId: record.rootCommEventId}, true)
                    if (topic && topic.contactListId !== contactListId) update(topic, {contactListId})
                }
                if (batch.length < 500) break
                offset += 500
            }
        }
        if (!oldContactListId) return
        for (const item of find(F + "ForumReviewItem", {siteId: repo.siteId, contactListId: oldContactListId, targetType: "post"})
            .condition("state", "in", ["pending", "claimed"])
            .limit(2000)
            .list()) {
            const rootCommEventId = one(F + "ForumPostState", {communicationEventId: item.targetId})?.rootCommEventId
            const record = rootCommEventId
                ? one(M + "SmithyIssue", {rootCommEventId}) || one(M + "SmithyMergeRequest", {rootCommEventId})
                : null
            if (record?.repositoryId === repo.repositoryId) update(item, {contactListId})
        }
    }
    return {
        reviewed,
        requestFor,
        requestWrite,
        heldRequest,
        hosted,
        soft,
        ensure,
        handleEvent,
        syncHidden,
        save,
        diffOf,
        rulesOf,
        bump,
        reviewCommentPost,
        commitRequests,
        moveScope,
        partyOfUser,
        profileView,
        OPEN
    }
}
