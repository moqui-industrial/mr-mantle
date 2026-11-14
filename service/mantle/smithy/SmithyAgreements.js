/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The contributor agreement check (mr-pass plan/design-smithy.md §9.4, Dogfood §10; the rule is the mr-moqui repository's
 * docs/dev/Contributions.md). A setting of a group or a repository, off by default: where it is required, a merge request's
 * author and the author of each of its commits must have a line in both lists of the agreement file (AUTHORS.md) at the
 * target branch or in the merge request itself, each added by a commit of that account. The result is the commit status
 * agreement/authors of the merge request's head, a context only the system writes (MoquiConf.xml
 * reserved-status-contexts), which the branch rules of the repository are made to require; Smithy's own merge refuses
 * an unsigned one too. Smithy.js calls this with its kit; the operations are methods of its map.
 * - An account is known by its confirmed addresses, and for history from GitHub by its linked login
 *   (SmithyAccount.githubLogin, in a users.noreply.github.com address). The committer is not looked at.
 * - SmithyAgreementSignature caches, by branch, which commit added each line; it is read again when the file's blob at
 *   the branch is another.
 * Entity access is privileged here.
 */
kit => {
    const {core, methods, flag, text, writer, handleOf} = kit
    const {M, GIT, forum, RANK} = core
    const {S, now, me, find, one, rows, create, update, fail, missing, invalid, receipt, audit} = forum
    const GMR = "moqui.resource.GitMergeRequest"
    const SMR = M + "SmithyMergeRequest"
    const SIGNATURE = M + "SmithyAgreementSignature"
    const RULE = "moqui.resource.GitBranchRule"
    const CONTEXT = "agreement/authors"
    const DEFAULT_PATH = "AUTHORS.md"
    const SETTINGS = {SmaInherit: "inherit", SmaOff: "off", SmaRequired: "required"}
    const STATE_CODES = {SmasOff: "off", SmasSigned: "signed", SmasUnsigned: "unsigned", SmasPending: "pending"}
    const LISTS = {copyright: "SalCopyright", patent: "SalPatent"}
    const TITLES = {"copyright waiver": "copyright", "grant of patent license": "patent"}
    const reviews = () => kit.reviews
    const confirmedAddress = () => ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js")
    const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const given = value => value !== undefined && value !== null
    const cf = () => ec.entity.conditionFactory

    // ===== the setting =====
    /* The setting in effect for a repository (§9.4): its own, else the nearest group's above it that is not inherit, else
       off; the file's path is that row's. */
    function effective(repo, changed) {
        const of = (row, inheritedFromPath) => ({
            required: row.agreementEnumId === "SmaRequired",
            path: row.agreementPath || DEFAULT_PATH,
            inheritedFromPath
        })
        if (repo.agreementEnumId && repo.agreementEnumId !== "SmaInherit") return of(repo, null)
        // changed: a group's row as it was just written, which the chain read before does not have
        for (const read of (repo.groupId && core.groupChain(repo.groupId)) || []) {
            const group = changed && changed.groupId === read.groupId ? changed : read
            if (group.agreementEnumId && group.agreementEnumId !== "SmaInherit") return of(group, group.groupPath)
        }
        return {required: false, path: DEFAULT_PATH, inheritedFromPath: null}
    }

    // ===== the file =====
    const SIGNATURE_LINE = /^\s{0,3}[-*]\s+Written in (.+?) by (.+) - (\S+)\s*$/
    /* An agreement file's text read line by line: for each list (copyright, patent) the logins, in lower case, with
       their lines; and each line with the list and login it signs, if any. A list starts after an ATX heading named
       Copyright Waiver or Grant of Patent License and ends at any other heading. Not read: fenced code, indented code
       and HTML comments (a heading or a line inside one is nothing), and the template line under Contributing, which is
       in no list. A file that has one of the two headings twice is invalid: which list is the list cannot be said, so
       nobody is signed by it. */
    function scan(source) {
        const lists = {copyright: new Map(), patent: new Map()}
        const lines = []
        const seen = new Set()
        let invalid = false
        let current = null
        let fence = null
        let comment = false
        for (const raw of text(source).replace(/\r\n?/g, "\n").split("\n")) {
            const entry = {text: raw, list: null, login: null}
            lines.push(entry)
            // what is left of the line outside HTML comments
            let line = ""
            let rest = raw
            while (rest) {
                if (comment) {
                    const end = rest.indexOf("-->")
                    if (end < 0) break
                    comment = false
                    rest = rest.slice(end + 3)
                } else {
                    const start = rest.indexOf("<!--")
                    if (start < 0) {
                        line += rest
                        break
                    }
                    line += rest.slice(0, start)
                    comment = true
                    rest = rest.slice(start + 4)
                }
            }
            if (line !== raw && !line.trim()) continue
            const fenced = /^\s{0,3}(```|~~~)/.exec(line)
            if (fenced) {
                fence = fence ? (fenced[1] === fence ? null : fence) : fenced[1]
                continue
            }
            if (fence || /^(?: {4}|\t)/.test(line)) continue
            const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
            if (heading) {
                current = TITLES[heading[2].trim().toLowerCase()] || null
                if (current) {
                    if (seen.has(current)) invalid = true
                    seen.add(current)
                }
                continue
            }
            if (!current) continue
            const signature = SIGNATURE_LINE.exec(line)
            if (!signature) continue
            const login = signature[3].toLowerCase()
            entry.list = current
            entry.login = login
            if (!lists[current].has(login)) lists[current].set(login, line.trim())
        }
        return {...lists, lines, invalid}
    }
    const parse = scan
    const EMPTY = scan("")
    /* What a change of the file adds, when it does nothing else (§9.4): the keys (list|login) of the signature lines the
       new text has in the two lists and the old has not, or null when the change is anything more: a reworded waiver,
       a moved heading, a line taken out. Blank lines are not compared. A signature made in a merge request counts only
       in such a change. */
    function onlyAdds(before, after) {
        const old = scan(before)
        const now = scan(after)
        if (old.invalid || now.invalid) return null
        const added = new Set()
        const kept = []
        for (const line of now.lines) {
            const key = line.list ? line.list + "|" + line.login : null
            if (key && !old[line.list].has(line.login) && !added.has(key)) added.add(key)
            else if (line.text.trim()) kept.push(line.text)
        }
        const was = old.lines.filter(line => line.text.trim()).map(line => line.text)
        return kept.length === was.length && kept.every((line, index) => line === was[index]) ? added : null
    }
    /* A file's text at a commit, or null: a hidden merge request's head is read for the check. */
    const blobText = (repositoryId, commitId, path) =>
        reviews().soft("get#GitBlob", {repositoryId, revision: commitId, path, includeHidden: true}).text ?? null
    /* The file before it was renamed: AUTHORS, for AUTHORS.md. */
    const oldPath = path => (/\.md$/i.test(path) ? path.replace(/\.md$/i, "") : null)
    function textAt(repositoryId, commitId, path) {
        if (!commitId) return null
        const source = blobText(repositoryId, commitId, path)
        return source == null && oldPath(path) ? blobText(repositoryId, commitId, oldPath(path)) : source
    }
    function reader(repositoryId, path) {
        const parsed = new Map()
        return commitId => {
            if (!commitId) return EMPTY
            if (!parsed.has(commitId)) {
                const source = textAt(repositoryId, commitId, path)
                parsed.set(commitId, source == null ? EMPTY : scan(source))
            }
            return parsed.get(commitId)
        }
    }
    /* Which commit added each wanted signature (a key is list|login), among commits newest first: the latest commit that
       is no merge, has the line in that list and whose parent has not. */
    function addedBy(listsAt, commits, wanted) {
        const found = new Map()
        const remaining = new Set(wanted)
        for (const commit of commits) {
            if (!remaining.size) break
            const parents = Array.from(commit.parentIds || [])
            if (parents.length > 1) continue
            const here = listsAt(commit.commitId)
            const before = listsAt(parents[0] || null)
            for (const key of Array.from(remaining)) {
                const [list, login] = key.split("|")
                if (here[list].has(login) && !before[list].has(login)) {
                    found.set(key, commit)
                    remaining.delete(key)
                }
            }
        }
        return found
    }
    /* The commits that change a path, from a tip back, newest first: at most HISTORY_BOUND, and whether that cut it. */
    const HISTORY_BOUND = 500
    function logOf(repositoryId, tip, path) {
        const commits = []
        let after = null
        let more = false
        while (commits.length < HISTORY_BOUND) {
            const log = reviews().soft("get#GitLog", {repositoryId, revision: tip, path, afterCommitId: after, limit: 100})
            const batch = Array.from(log.commitList || [])
            commits.push(...batch)
            more = !!log.hasMore && batch.length > 0
            if (!more) break
            after = batch[batch.length - 1].commitId
        }
        return {commits, bounded: more}
    }

    // ===== accounts and whose a commit is =====
    /* How many commits of a merge request, and of one write, are checked: past it the answer is unsigned, never a guess.
       The git host's compare gives at most 250 commits; the property lowers the bound. */
    const maxCommits = () => {
        const set = Number(System.getProperty("smithy_agreement_max_commits") || 0)
        return set > 0 ? Math.min(set, 250) : 250
    }
    const partyOfUser = userId => (userId ? one("moqui.security.UserAccount", {userId})?.partyId || null : null)
    /* Who decides whose a commit is, for one repository (§9.4). The author's address is what whoever made the commit
       typed, so it is never enough: a commit is an account's own only when its author address is a confirmed address of
       that account, an account of this site, AND that account brought the commit to this server: a push or a write of
       its own (moqui.resource.GitCommitPush, the git host's record of who first brought a commit to a repository; the
       new value of a ref it wrote, while that record is still being made; the write in progress, pending). A commit
       authored as one account and brought by another is nobody's own (authorNotPusher), and one nobody is known to
       have brought cannot be said (pusherUnknown) unless the repository's history was imported
       (SmithyRepository.importedHistory, which the GitHub import sets): only then is a commit no push brought taken by
       its author's address, or by the linked GitHub login of a users.noreply.github.com address. */
    function checker(repo, pending) {
        const siteId = repo.siteId
        const imported = repo.importedHistory === "Y"
        const addresses = new Map()
        const inSite = partyId => {
            const membership = forum.member(siteId, partyId)
            return (forum.active(membership) && membership.state === "active") || forum.internalParty(partyId)
        }
        function addressParty(email) {
            const address = text(email).trim().toLowerCase()
            if (!address) return null
            if (addresses.has(address)) return addresses.get(address)
            const userIds = new Set()
            for (const row of find("moqui.security.public.VerifiedAddress")
                .condition(cf().makeCondition("emailAddress", "equals", address).ignoreCase())
                .limit(20)
                .list())
                if (row.verifiedAt) userIds.add(row.userId)
            // an internal account's address is confirmed by who made the account (ConfirmedAddress.js)
            for (const account of find("moqui.security.UserAccount")
                .condition(cf().makeCondition("emailAddress", "equals", address).ignoreCase())
                .limit(20)
                .list())
                if (confirmedAddress().confirmed(account.userId)) userIds.add(account.userId)
            let partyId = null
            for (const userId of Array.from(userIds).sort()) {
                const account = one("moqui.security.UserAccount", {userId})
                // the address is the account's own now, and the account is one of this site
                if (
                    account?.partyId &&
                    account.disabled !== "Y" &&
                    text(account.emailAddress).toLowerCase() === address &&
                    inSite(account.partyId)
                ) {
                    partyId = account.partyId
                    break
                }
            }
            addresses.set(address, partyId)
            return partyId
        }
        function loginParty(email) {
            const github = /^(?:[0-9]+\+)?([^@+]+)@users\.noreply\.github\.com$/.exec(text(email).trim().toLowerCase())
            return github ? one(M + "SmithyAccount", {siteId, githubLogin: github[1]})?.partyId || null : null
        }
        const brought = new Map()
        function pushersOf(commitId) {
            if (!brought.has(commitId)) {
                const userIds = new Set()
                for (const row of rows("moqui.resource.GitCommitPush", {commitId}, 50)) if (row.userId) userIds.add(row.userId)
                if (!userIds.size)
                    for (const ref of rows("moqui.resource.GitUpdateRef", {newObjectId: commitId}, 20)) {
                        const update = ["ok", "pending"].includes(ref.result)
                            ? one("moqui.resource.GitUpdate", {updateId: ref.updateId})
                            : null
                        if (update?.userId) userIds.add(update.userId)
                    }
                if (pending?.userId && pending.commitIds.has(commitId)) userIds.add(pending.userId)
                brought.set(commitId, userIds)
            }
            return brought.get(commitId)
        }
        /* {partyId (the account the author's address is, or null), own, word (why it is not its own)}. */
        function authorOf(commit) {
            let partyId = addressParty(commit.authorEmail)
            const pushers = pushersOf(commit.commitId)
            if (!pushers.size) {
                if (!imported) return {partyId, own: false, word: partyId ? "pusherUnknown" : "account"}
                partyId = partyId || loginParty(commit.authorEmail)
                return {partyId, own: !!partyId, word: partyId ? null : "account"}
            }
            if (!partyId) return {partyId: null, own: false, word: "account"}
            const own = Array.from(pushers).some(userId => partyOfUser(userId) === partyId)
            return {partyId, own, word: own ? null : "authorNotPusher"}
        }
        /* Whether a cached signature's author still stands: the address it was read with is that account's now. */
        const stands = (authorEmail, authorPartyId) =>
            !!authorPartyId &&
            (addressParty(authorEmail) === authorPartyId || (imported && loginParty(authorEmail) === authorPartyId))
        return {authorOf, stands, addressParty}
    }
    /* An account's logins: its handle on the site and its linked GitHub login, in lower case. */
    function loginsOf(siteId, partyId) {
        const out = new Set()
        const handle = handleOf(siteId, partyId)
        if (handle) out.add(text(handle).toLowerCase())
        const login = one(M + "SmithyAccount", {siteId, partyId})?.githubLogin
        if (login) out.add(text(login).toLowerCase())
        return Array.from(out)
    }

    // ===== the signatures of a branch, cached =====
    /* The signatures of the agreement file at a branch: {map, invalid, present}. map: list|login to {commitId,
       authorPartyId (the account whose own commit added the line, else null), unverified (the history read was cut
       before the commit was found)}. Read from SmithyAgreementSignature while the file's blob at the branch is the one
       the rows were read from, each row counted only while its author's address is still that account's; else made
       again from the file and its history. o.force reads anew; o.readOnly writes nothing (a check that runs in a
       transaction of its own). */
    function branchSignatures(repo, branch, path, check, o = {}) {
        const repositoryId = repo.repositoryId
        const head = Array.from(reviews().soft("get#GitRefs", {repositoryId, refType: "branch"}).refList || []).find(
            ref => ref.shortName === branch
        )
        const map = new Map()
        const cached = rows(SIGNATURE, {repositoryId, refName: branch}, 5000)
        const drop = () => {
            if (!o.readOnly) for (const row of cached) row.delete()
        }
        const cut = path.lastIndexOf("/")
        const tree = head
            ? reviews().soft("get#GitTree", {repositoryId, revision: head.commitId, path: cut < 0 ? "" : path.slice(0, cut)})
            : {}
        const blobId = Array.from(tree.entryList || []).find(entry => entry.path === path)?.objectId || null
        if (!blobId) {
            drop()
            return {map, invalid: false, present: false}
        }
        if (!o.force && cached.length && cached.every(row => row.blobId === blobId)) {
            for (const row of cached) {
                let authorPartyId = check.stands(row.authorEmail, row.authorPartyId) ? row.authorPartyId : null
                // a commit that was nobody's own when the row was written may be its author's now (an address confirmed
                // since, the record of who brought it made since)
                if (!authorPartyId && row.commitId && row.unverified !== "Y") {
                    const commit = reviews().soft("get#GitCommit", {repositoryId, commitId: row.commitId, stats: false}).commit
                    const author = commit ? check.authorOf(commit) : null
                    authorPartyId = author?.own ? author.partyId : null
                    if (!o.readOnly && (row.authorPartyId || null) !== authorPartyId)
                        update(row, {
                            authorPartyId,
                            authorEmail: text(commit?.authorEmail).toLowerCase() || null,
                            checkedAt: now()
                        })
                }
                const list = Object.keys(LISTS).find(name => LISTS[name] === row.listEnumId)
                map.set(list + "|" + row.login, {
                    commitId: row.commitId || null,
                    authorPartyId,
                    unverified: row.unverified === "Y"
                })
            }
            return {map, invalid: false, present: true}
        }
        drop()
        const listsAt = reader(repositoryId, path)
        const here = listsAt(head.commitId)
        if (here.invalid) return {map, invalid: true, present: true}
        const wanted = []
        for (const list of Object.keys(LISTS)) for (const login of here[list].keys()) wanted.push(list + "|" + login)
        if (!wanted.length) return {map, invalid: false, present: true}
        const history = logOf(repositoryId, head.commitId, path)
        let bounded = history.bounded
        const commits = history.commits
        if (oldPath(path)) {
            const older = logOf(repositoryId, head.commitId, oldPath(path))
            commits.push(...older.commits)
            bounded = bounded || older.bounded
        }
        commits.sort((left, right) => Number(right.committerDate || 0) - Number(left.committerDate || 0))
        const found = addedBy(listsAt, commits, wanted)
        for (const key of wanted) {
            const [list, login] = key.split("|")
            const commit = found.get(key) || null
            const author = commit ? check.authorOf(commit) : null
            const authorPartyId = author?.own ? author.partyId : null
            // a line whose commit the bounded history did not reach: whose it is cannot be said
            const unverified = !commit && bounded
            if (!o.readOnly)
                create(SIGNATURE, {
                    repositoryId,
                    refName: branch,
                    listEnumId: LISTS[list],
                    login,
                    siteId: repo.siteId,
                    lineText: text(here[list].get(login)).slice(0, 255),
                    commitId: commit?.commitId || null,
                    authorPartyId,
                    authorEmail: text(commit?.authorEmail).toLowerCase() || null,
                    unverified: unverified ? "Y" : "N",
                    blobId,
                    checkedAt: now()
                })
            map.set(key, {commitId: commit?.commitId || null, authorPartyId, unverified})
        }
        return {map, invalid: false, present: true}
    }
    /* What an account is missing of the two lists: nothing when it has a line of its own in both. Else, for each list:
       its name when no line names one of its logins; with NotOwn when a line does and no commit of the account's own
       added it; with Unverified when the history was cut before the line's commit. And notOnlySignatures when its line
       is in the merge request, in a change of the file that does more than add signature lines. sources: what
       branchSignatures and requestSignatures give (the target branch's, the merge request's own). */
    function missingOf(siteId, partyId, sources) {
        const logins = loginsOf(siteId, partyId)
        const out = []
        let mixed = false
        for (const list of Object.keys(LISTS)) {
            let listed = false
            let own = false
            let unverified = false
            for (const source of sources)
                for (const login of logins) {
                    const key = list + "|" + login
                    if (source.mixed?.has(key)) mixed = true
                    const signature = source.map.get(key)
                    if (!signature) continue
                    listed = true
                    if (signature.authorPartyId === partyId) own = true
                    if (signature.unverified) unverified = true
                }
            if (!own) out.push(listed ? list + (unverified ? "Unverified" : "NotOwn") : list)
        }
        if (mixed && out.length) out.push("notOnlySignatures")
        return out
    }

    // ===== the check of a merge request =====
    /* The signatures a merge request's own commits add (§9.4): {map, mixed}. They count only when the file's change
       from the merge base to the head is nothing but added signature lines in the two lists; else none counts, and
       mixed has the lines it adds, so the box can say "sign in a change that only adds your line". commits: oldest
       first. */
    function requestSignatures(repositoryId, path, mergeBaseId, headCommitId, commits, check) {
        const out = {map: new Map(), mixed: new Set()}
        const after = textAt(repositoryId, headCommitId, path)
        if (after == null) return out
        const before = textAt(repositoryId, mergeBaseId, path) || ""
        if (before === after) return out
        const added = onlyAdds(before, after)
        if (!added) {
            const old = scan(before)
            const now = scan(after)
            for (const list of Object.keys(LISTS))
                for (const login of now[list].keys()) if (!old[list].has(login)) out.mixed.add(list + "|" + login)
            return out
        }
        const listsAt = reader(repositoryId, path)
        for (const [key, commit] of addedBy(listsAt, Array.from(commits).reverse(), added)) {
            const author = check.authorOf(commit)
            out.map.set(key, {commitId: commit.commitId, authorPartyId: author.own ? author.partyId : null, unverified: false})
        }
        return out
    }
    const WORDS = {
        copyright: "the Copyright Waiver",
        patent: "the Grant of Patent License",
        copyrightNotOwn: "the Copyright Waiver (not their own commit)",
        patentNotOwn: "the Grant of Patent License (not their own commit)",
        copyrightUnverified: "the Copyright Waiver (its commit is too far back to verify)",
        patentUnverified: "the Grant of Patent License (its commit is too far back to verify)",
        notOnlySignatures: "a change that only adds their line",
        account: "is not an account of this site",
        authorNotPusher: "a commit in their name that another account brought",
        pusherUnknown: "a commit in their name that no account is known to have brought",
        tooManyCommits: "too many commits to check",
        fileInvalid: "the agreement file has a list heading twice",
        botOperator: "its operator's word, confirmed by a Maintainer"
    }
    /* The words of a list of who is missing what, for a status and a refusal: up to five people. */
    const told = (siteId, missingList) =>
        missingList
            .slice(0, 5)
            .map(
                entry =>
                    (entry.partyId ? handleOf(siteId, entry.partyId) || "an account" : entry.name || "the merge request") +
                    ": " +
                    entry.missing.map(word => WORDS[word] || word).join(", ")
            )
            .join("; ")
    /* The check itself (§9.4), for a merge request's head as the git host has it, storing nothing but the cache of the
       target branch's signatures (and not that with readOnly): {required, state, missingList, headCommitId, path}.
       Each entry of missingList is {partyId or name, commitId, missing}. */
    function evaluate(mr, row, repo, o = {}) {
        const setting = effective(repo, o.changed)
        if (!setting.required)
            return {required: false, state: "off", missingList: [], headCommitId: mr.headCommitId, path: setting.path}
        const siteId = repo.siteId
        const check = checker(repo, null)
        const diff = reviews().diffOf(mr, false)
        const commits = Array.from(diff.commitList || [])
        const missingList = []
        // every commit of the range is read, or the answer is unsigned
        if (commits.length > maxCommits() || Number(diff.aheadBy || 0) > commits.length) {
            commits.length = Math.min(commits.length, maxCommits())
            missingList.push({name: "", commitId: null, missing: ["tooManyCommits"]})
        }
        const target = branchSignatures(repo, mr.targetRef, setting.path, check, {force: o.force, readOnly: o.readOnly})
        const own = requestSignatures(
            repo.repositoryId,
            setting.path,
            diff.mergeBaseId || mr.baseCommitId,
            diff.headCommitId || mr.headCommitId,
            commits,
            check
        )
        const sources = [target, own]
        if (target.invalid) missingList.push({name: "", commitId: null, missing: ["fileInvalid"]})
        const people = new Map([[row.authorPartyId, null]])
        for (const commit of commits) {
            const author = check.authorOf(commit)
            if (!author.partyId)
                missingList.push({name: commit.authorName || "", commitId: commit.commitId, missing: ["account"]})
            else {
                // a commit in an account's name that the account did not bring is not its work to sign for
                if (!author.own) missingList.push({partyId: author.partyId, commitId: commit.commitId, missing: [author.word]})
                if (!people.has(author.partyId)) people.set(author.partyId, commit.commitId)
            }
        }
        let waiting = false
        for (const [partyId, commitId] of people) {
            const account = one(M + "SmithyAccount", {siteId, partyId})
            if (account?.bot === "Y") {
                // a bot counts as signed when its operator has signed, has said so here and a Maintainer confirmed it
                const operator = account.botOperatorPartyId || null
                const vouched = !!operator && row.botOperatorPartyId === operator && !!row.botConfirmedByPartyId
                if (!vouched) {
                    waiting = true
                    missingList.push({partyId, commitId, missing: ["botOperator"]})
                    continue
                }
                const lacks = missingOf(siteId, operator, sources)
                if (lacks.length) missingList.push({partyId: operator, commitId, missing: lacks})
                continue
            }
            const lacks = missingOf(siteId, partyId, sources)
            if (lacks.length) missingList.push({partyId, commitId, missing: lacks})
        }
        const unsigned = missingList.some(entry => !entry.missing.includes("botOperator"))
        return {
            required: true,
            state: unsigned ? "unsigned" : waiting ? "pending" : "signed",
            missingList,
            headCommitId: mr.headCommitId,
            path: setting.path
        }
    }
    /* compute#Agreement (§9.4): the check of an open merge request for its head, kept on its SmithyMergeRequest row and
       written as the status agreement/authors of the head: success when everyone has signed, pending for a bot whose
       operator is not confirmed, else failure, naming up to five people and what each is missing. Where the agreement is
       not required the state is off and no status is written. Gives {required, state}. o: force (the target branch's
       signatures are read anew), changed (a group's row as just written). */
    function compute(mergeRequestId, o = {}) {
        const row = mergeRequestId ? one(SMR, {mergeRequestId}, true) : null
        const mr = row ? one(GMR, {mergeRequestId}) : null
        const repo = mr ? one(M + "SmithyRepository", {repositoryId: mr.repositoryId}) : null
        if (!repo) return {required: false, state: "off"}
        if (!effective(repo, o.changed).required) {
            if (row.agreementStateEnumId !== "SmasOff" || row.agreementDetail)
                update(row, {agreementStateEnumId: "SmasOff", agreementDetail: null, agreementCommitId: null})
            return {required: false, state: "off"}
        }
        // a merged or closed one keeps the result of its last head
        if (!reviews().OPEN.includes(mr.statusId) || !mr.headCommitId) return {required: true, state: stateCode(row, mr)}
        const result = evaluate(mr, row, repo, o)
        const {state, missingList} = result
        const siteId = repo.siteId
        const stateId = Object.keys(STATE_CODES).find(id => STATE_CODES[id] === state)
        const detail = missingList.length ? JSON.stringify({missingList: missingList.slice(0, 100)}) : null
        if (
            row.agreementStateEnumId === stateId &&
            row.agreementCommitId === mr.headCommitId &&
            (row.agreementDetail || null) === detail
        )
            return {required: true, state}
        // while the merge request is hidden (its text is held) no status is written, and none is tried: a refused call
        // would spoil the transaction of the save that opened it. The result is kept without the head it is of, so it
        // reads as unsigned, and the check runs again and writes the status when the merge request is shown (syncHidden)
        if (mr.hiddenDate) {
            update(row, {agreementStateEnumId: stateId, agreementDetail: detail, agreementCommitId: null})
            return {required: true, state}
        }
        update(row, {agreementStateEnumId: stateId, agreementDetail: detail, agreementCommitId: mr.headCommitId})
        const written = reviews().hosted(GIT + "create#GitCommitStatus", {
            repositoryId: repo.repositoryId,
            commitId: mr.headCommitId,
            state: state === "signed" ? "success" : state === "pending" ? "pending" : "failure",
            context: CONTEXT,
            includeHidden: true,
            description: (state === "signed"
                ? "Everyone who wrote this has signed " + result.path
                : told(siteId, missingList)
            ).slice(0, 250),
            targetUrl:
                publicApps().pageUrl(
                    siteId,
                    "smithy",
                    "/" + repo.repositoryPath + "/-/merge-requests/" + Number(mr.mergeRequestNum)
                ) || null
        })
        if (written.problem != null)
            ec.logger.warn("The agreement status of merge request " + mergeRequestId + " was not written: " + written.problem)
        return {required: true, state}
    }
    /* The state as it stands for the merge request's head (§15.5): a result computed for another head (the source moved
       since, or the merge request is hidden) is not this head's, and reads as unsigned until the check has run. */
    function stateCode(row, mr) {
        const stored = STATE_CODES[row?.agreementStateEnumId] || "off"
        if (stored === "off" || !mr) return stored
        const open = reviews().OPEN.includes(mr.statusId)
        return open && row.agreementCommitId !== mr.headCommitId ? "unsigned" : stored
    }
    const detailOf = row => forum.json(row.agreementDetail, {}).missingList || []
    /* The agreement panel of a merge request (§15.5, 2): whether it is required, the state, who is missing what (an
       account by its handle, an author who is no account by the commit's name), the head it is of, the file and the
       page it is signed on. */
    function view(r, held) {
        const {mr, row} = held
        const setting = effective(r.repo)
        const siteId = r.repo.siteId
        return {
            required: setting.required,
            state: setting.required ? stateCode(row, mr) : "off",
            missingList: setting.required
                ? detailOf(row).map(entry => ({
                      handle: entry.partyId ? reviews().profileView(siteId, entry.partyId)?.handle || null : null,
                      name: entry.partyId ? null : entry.name || "",
                      commitId: entry.commitId || null,
                      missing: entry.missing
                  }))
                : [],
            commitId: row.agreementCommitId || null,
            file: setting.path,
            signPath: signPath(r, held, setting),
            botOperatorDeclared: !!row.botOperatorPartyId,
            botOperatorConfirmed: !!row.botConfirmedByPartyId
        }
    }
    /* Where a signature is made on a page (§9.4): for the merge request's author, the file on the merge request's own
       source branch (a fork's too) when the author may commit there, so the signature is in the merge request; for
       anyone else, and for one pushed for review, the file on the target branch, whose save opens a merge request of
       its own. A path under the Smithy mount. */
    function signPath(r, held, setting) {
        const {mr} = held
        // each segment of a branch's name and of the path is encoded, so a '#' or a '?' in one stays in the path
        const encoded = value => text(value).split("/").map(encodeURIComponent).join("/")
        const onTarget = r.repo.repositoryPath + "/-/edit/" + encoded(mr.targetRef) + "/" + encoded(setting.path)
        if (!held.access.author || mr.pushedForReview === "Y" || !reviews().OPEN.includes(mr.statusId)) return onTarget
        const sourceId = mr.sourceRepositoryId || mr.repositoryId
        const source = sourceId === r.repo.repositoryId ? r : sourceOf(sourceId, r.repo.siteId)
        if (!source || source.rank < RANK.SmrDeveloper || !reviews().rulesOf(sourceId, mr.sourceRef).mayPushDirectly)
            return onTarget
        return source.repo.repositoryPath + "/-/edit/" + encoded(mr.sourceRef) + "/" + encoded(setting.path)
    }
    const canSign = (r, held) => effective(r.repo).required && !!me() && detailOf(held.row).some(entry => entry.partyId === me())
    const botDeclared = row => !!row.botOperatorPartyId && !row.botConfirmedByPartyId
    /* Whether each commit's author has signed, by the stored result: null where the agreement is not required. */
    function commitsSigned(r, held, commits) {
        const out = new Map()
        if (!effective(r.repo).required) return out
        const check = checker(r.repo, null)
        const missingList = detailOf(held.row)
        const current = held.row.agreementCommitId === held.mr.headCommitId || !reviews().OPEN.includes(held.mr.statusId)
        for (const commit of commits) {
            const partyId = check.addressParty(commit.authorEmail)
            out.set(
                commit.commitId,
                current &&
                    !!partyId &&
                    !missingList.some(entry => entry.partyId === partyId || entry.commitId === commit.commitId)
            )
        }
        return out
    }
    /* Whether a squash would fold a signature into another person's commit (§9.4): the squash is one commit by one
       account (the merge request's author; the merging user for a merge of two refs), so when that account and the
       squashed commits' authors are more than one person, and one of the commits adds a signature, a signature would
       end in a commit that is not its signer's. commits: the squashed ones. */
    function folds(repo, commits, authorPartyId) {
        const setting = effective(repo)
        const check = checker(repo, null)
        const authors = new Set(
            commits.map(commit => check.addressParty(commit.authorEmail) || text(commit.authorEmail).toLowerCase())
        )
        authors.add(authorPartyId)
        if (authors.size < 2) return false
        const listsAt = reader(repo.repositoryId, setting.path)
        return commits.some(commit => {
            const parents = Array.from(commit.parentIds || [])
            if (parents.length > 1) return false
            const here = listsAt(commit.commitId)
            const before = listsAt(parents[0] || null)
            return Object.keys(LISTS).some(list => Array.from(here[list].keys()).some(login => !before[list].has(login)))
        })
    }
    const squashFolds = (repo, mr, row) =>
        folds(repo, Array.from(reviews().diffOf(mr, false).commitList || []), row.authorPartyId)
    const isAgreementFile = (r, path) => {
        const setting = effective(r.repo)
        return setting.required && !!path && path === setting.path
    }

    // ===== the one enforcement point: what lands on a guarded branch =====
    const SQUASH = "GmmSquash"
    const REBASE = "GmmRebase"
    const FOLDS =
        "squashFoldsSignature: A squash would put one person's signature of the agreement in another's commit; " +
        "merge with a merge commit or a rebase"
    /* Whether a branch of a repository is guarded: its default branch, and any branch a rule makes change through a
       merge request. */
    const guarded = (repositoryId, ref) =>
        ref.refType === "branch" &&
        !flag(ref.forReview) &&
        ref.changeType !== "delete" &&
        (flag(ref.isDefaultBranch) || reviews().rulesOf(repositoryId, ref.shortName).requireMergeRequest)
    /* The merge of a merge request (the git host's merge#MergeRequest, whoever calls it: Smithy's page, Projects, a REST
       client), as the gate sees it: the merge request's head as it is now, which must be the commit that merges, must be
       signed by everyone who wrote it, and a squash must fold no signature. A squash's one new commit is by the merge
       request's author, so it is the merge request's own commits (the source's, from the head) whose authors are asked.
       Nothing is stored. */
    function mergeRequestProblems(repo, mr, c) {
        const row = one(SMR, {mergeRequestId: mr.mergeRequestId})
        if (!row)
            return [
                "agreementUnsigned: The contributor agreement of this merge request has not been checked; open its page first"
            ]
        if (!c.mergeSourceCommitId || c.mergeSourceCommitId !== mr.headCommitId)
            return [
                "agreementUnsigned: The merge request's head is not the commit that was checked for the contributor agreement; reload and try again"
            ]
        const result = evaluate(mr, row, repo, {readOnly: true})
        if (result.state !== "signed")
            return [
                "agreementUnsigned: " +
                    result.path +
                    " is not signed by everyone who wrote this (" +
                    told(repo.siteId, result.missingList) +
                    ")"
            ]
        return c.mergeMethodEnumId === SQUASH && squashFolds(repo, mr, row) ? [FOLDS] : []
    }
    /* The commits a merge of two refs (merge#GitRefs) takes from its source: those the source's head reaches and the
       target does not, oldest first; null when they cannot all be read. */
    function sourceCommits(repo, c) {
        if (!c.mergeSourceCommitId || !c.oldId) return null
        const compare = reviews().soft("get#GitCompare", {
            repositoryId: repo.repositoryId,
            base: c.oldId,
            head: c.mergeSourceCommitId,
            includeHidden: true
        })
        const commits = Array.from(compare.commitList || [])
        if (
            compare.headCommitId !== c.mergeSourceCommitId ||
            flag(compare.commitsTruncated) ||
            Number(compare.aheadBy || 0) !== commits.length
        )
            return null
        return commits
    }
    /* check#Write (pre-ref-update, for a push and for every write through the git host: a page's commit, a merge by
       Smithy or by Projects, a merge of two refs, create#GitRef, the release notes, a write through a git:// location):
       the one place unsigned code is kept off a guarded branch of a repository whose agreement is required (§9.4,
       N-WRITE-ECA). The problems that refuse the ref, none to let it change. The commits are the event's own
       (newCommits), and a merge is known by the event's merge context.
       - The merge of a merge request (mergeRequestId) is checked as that merge request (mergeRequestProblems).
       - A merge with no merge request (merge#GitRefs) is checked by the commits of its source: a squash's one commit is
         the merging user's and a rebase's copies are brought by the merging user, so neither says who wrote the work.
         A squash must fold no signature, as a merge request's.
       - Every commit asked about that is no merge must be its author's own (checker: the address and who brings it,
         the user of this change for a commit it brings) by an account that has signed at the branch as it is, or be a
         commit of an open merge request into the branch whose check is signed for its head. So a signature is first
         made in a merge request, where it is seen.
       - A branch that has no agreement file yet takes its first commits: there is nothing to sign.
       Not asked (Smithy.gitecas.xml): a mirror's fetch and an operator's import.
       It fails closed: a list of commits the git host cut or could not read, more commits than are checked, and its
       own error refuse. */
    function checkWrite(c) {
        const repo = c.repositoryId ? one(M + "SmithyRepository", {repositoryId: c.repositoryId}) : null
        if (!repo) return []
        const setting = effective(repo)
        if (!setting.required || !guarded(repo.repositoryId, c)) return []
        const refuse = why => [
            "agreementUnsigned: " + setting.path + " must be signed by everyone whose commits come to " + c.shortName + ": " + why
        ]
        const unread = "a commit of this change cannot be read to check it"
        if (c.newCommitsTruncated !== false && c.newCommitsTruncated != null)
            return refuse("too many commits to check; bring them in a merge request")
        const ids = Array.from(c.newCommitIds || [])
        const brought = Array.from(c.newCommits || [])
        if (brought.length !== ids.length || brought.some(commit => !commit?.commitId)) return refuse(unread)
        if (ids.length > 2000) return refuse("too many commits to check; bring them in a merge request")
        let commits = brought
        if (flag(c.isMerge)) {
            if (c.mergeRequestId) {
                const mr = one(GMR, {mergeRequestId: c.mergeRequestId})
                if (!mr || mr.repositoryId !== repo.repositoryId || mr.targetRef !== c.shortName)
                    return refuse("the merge request of this merge is not one into " + c.shortName)
                return mergeRequestProblems(repo, mr, c)
            }
            const sources = sourceCommits(repo, c)
            if (!sources) return refuse(unread)
            if (c.mergeMethodEnumId === SQUASH && folds(repo, sources, partyOfUser(c.userId))) return [FOLDS]
            // the source's commits; and what the merge makes beside them, but for a rebase, whose copies are the same work
            const seen = new Set(sources.map(commit => commit.commitId))
            commits =
                c.mergeMethodEnumId === REBASE ? sources : sources.concat(brought.filter(commit => !seen.has(commit.commitId)))
        }
        const plain = commits.filter(commit => Array.from(commit.parentIds || []).length < 2)
        if (!plain.length) return []
        const check = checker(repo, {userId: c.userId || null, commitIds: new Set(ids)})
        const target = branchSignatures(repo, c.shortName, setting.path, check, {})
        if (!target.present) return []
        if (target.invalid) return refuse(WORDS.fileInvalid)
        // the commits of the open merge requests into the branch that are signed for their heads
        let covered = null
        const inSignedRequest = commitId => {
            if (!covered) {
                covered = new Set()
                for (const mr of find(GMR, {repositoryId: repo.repositoryId, targetRef: c.shortName, statusId: "GmrOpen"})
                    .limit(100)
                    .list()) {
                    const row = one(SMR, {mergeRequestId: mr.mergeRequestId})
                    if (row?.agreementStateEnumId !== "SmasSigned" || row.agreementCommitId !== mr.headCommitId || mr.hiddenDate)
                        continue
                    for (const commit of Array.from(reviews().diffOf(mr, false).commitList || [])) covered.add(commit.commitId)
                }
            }
            return covered.has(commitId)
        }
        const missingList = []
        for (const commit of plain) {
            const author = check.authorOf(commit)
            const lacks = !author.partyId
                ? ["account"]
                : !author.own
                  ? [author.word]
                  : missingOf(repo.siteId, author.partyId, [target])
            if (lacks.length && !inSignedRequest(commit.commitId))
                missingList.push(
                    author.partyId
                        ? {partyId: author.partyId, commitId: commit.commitId, missing: lacks}
                        : {name: commit.authorName || "", commitId: commit.commitId, missing: lacks}
                )
        }
        return missingList.length
            ? refuse(told(repo.siteId, missingList) + ". Sign in a merge request, which shows who is missing what")
            : []
    }
    /* check#TargetBranch: a branch of a repository moved. When the agreement is required there and the file at the branch
       is not the one the cache was read from, every open merge request into the branch is checked again; and the
       default branch, when it is made, gets its rule. */
    function targetMoved(c) {
        const repo = c.repositoryId ? one(M + "SmithyRepository", {repositoryId: c.repositoryId}) : null
        const branch = text(c.refName).replace(/^refs\/heads\//, "")
        if (!repo || !branch || !text(c.refName).startsWith("refs/heads/") || !effective(repo).required) return
        if (c.changeType === "create") syncRules(repo, true)
        const requests = Array.from(
            find(GMR, {repositoryId: repo.repositoryId, targetRef: branch})
                .condition("statusId", "in", reviews().OPEN)
                .limit(200)
                .list()
        )
        if (!requests.length) return
        const before = rows(SIGNATURE, {repositoryId: repo.repositoryId, refName: branch}, 1)[0]?.blobId || null
        branchSignatures(repo, branch, effective(repo).path, checker(repo, null), {})
        const after = rows(SIGNATURE, {repositoryId: repo.repositoryId, refName: branch}, 1)[0]?.blobId || null
        if (before === after) return
        for (const mr of requests) if (one(SMR, {mergeRequestId: mr.mergeRequestId})) compute(mr.mergeRequestId)
    }
    /* check#Brought (post-receive): the git host has now recorded who brought the commits of a push or a write. The open
       merge requests of the repository, and those whose source it is, that are not signed are checked again: a commit
       that was nobody's known own a moment ago may be its author's now. */
    function brought(c) {
        if (!c.repositoryId) return
        const requests = new Map()
        for (const field of ["repositoryId", "sourceRepositoryId"])
            for (const mr of find(GMR, {[field]: c.repositoryId})
                .condition("statusId", "in", reviews().OPEN)
                .limit(100)
                .list())
                requests.set(mr.mergeRequestId, mr)
        for (const mr of requests.values()) {
            const row = one(SMR, {mergeRequestId: mr.mergeRequestId})
            if (row && row.agreementStateEnumId === "SmasUnsigned" && /pusherUnknown/.test(text(row.agreementDetail)))
                compute(mr.mergeRequestId)
        }
    }
    /* get#AuthorSigned (the Dev AIDE's "has this author signed", design F18): for an account (userId) or an author's
       address, whether it has a line of its own in both lists at the repository's default branch. known is false for a
       repository Smithy does not keep. */
    function authorSigned(p) {
        const repo = p.repositoryId ? one(M + "SmithyRepository", {repositoryId: p.repositoryId}) : null
        if (!repo) return {known: false, required: false, signed: false, missing: [], agreementPath: null}
        const setting = effective(repo)
        const check = checker(repo, null)
        const partyId = p.userId ? partyOfUser(p.userId) : check.addressParty(p.emailAddress)
        const branch = one("moqui.resource.GitRepository", {repositoryId: repo.repositoryId})?.branch || "main"
        let lacks = ["account"]
        if (partyId) {
            const target = branchSignatures(repo, branch, setting.path, check, {})
            lacks = target.invalid ? ["fileInvalid"] : missingOf(repo.siteId, partyId, [target])
        }
        return {known: true, required: setting.required, signed: !lacks.length, missing: lacks, agreementPath: setting.path}
    }

    // ===== the branch rules =====
    /* Keeps the branch rules of a repository in step with the agreement (§9.4): where it is required, the rule of the
       default branch (made when there is none, once the branch is there) requires a merge request and the status
       agreement/authors, and so does every other rule that requires a merge request; where it is not, the status is
       no longer required (a rule keeps its merge request). Gives the number of rules changed. Run when the setting
       changes, and when a repository is made, bound, forked or transferred, its default branch changes or one of its
       rules is stored. */
    function syncRules(repo, required) {
        const repositoryId = repo.repositoryId
        const hosted = one("moqui.resource.GitRepository", {repositoryId})
        if (!hosted) return 0
        const branch = hosted.branch || "main"
        const rules = rows(RULE, {repositoryId}, 500)
        const ofDefault = rule => [branch, "refs/heads/" + branch].includes(rule.refPattern)
        let changed = 0
        if (required && !rules.some(ofDefault)) {
            // a repository with no commit yet takes its first ones; its rule is made when the branch is (targetMoved)
            const there = Array.from(reviews().soft("get#GitRefs", {repositoryId, refType: "branch"}).refList || []).some(
                ref => ref.shortName === branch
            )
            if (there) {
                const made = reviews().hosted(GIT + "store#GitBranchRule", {
                    repositoryId,
                    refPattern: branch,
                    allowForcePush: "N",
                    allowDelete: "N",
                    requireMergeRequest: "Y",
                    dismissStaleApprovals: "N",
                    requiredApprovals: 0,
                    requiredStatusContexts: CONTEXT
                })
                if (made.problem != null) invalid(made.problem.slice(0, 200))
                changed++
            }
        }
        for (const rule of rules) {
            if (!ofDefault(rule) && rule.requireMergeRequest !== "Y") continue
            const contexts = text(rule.requiredStatusContexts)
                .split(",")
                .map(word => word.trim())
                .filter(word => !!word)
            const fields = {}
            if (contexts.includes(CONTEXT) !== required)
                fields.requiredStatusContexts =
                    (required ? contexts.concat([CONTEXT]) : contexts.filter(word => word !== CONTEXT)).join(",") || null
            if (required && rule.requireMergeRequest !== "Y") fields.requireMergeRequest = "Y"
            if (!Object.keys(fields).length) continue
            update(rule, fields)
            changed++
        }
        return changed
    }
    /* keepRules: the same for a repository as it is now, after something that may have left its rules behind. */
    function keepRules(repositoryId) {
        const repo = repositoryId ? one(M + "SmithyRepository", {repositoryId}) : null
        if (!repo) return 0
        const required = effective(repo).required
        return required || ruleCount(repositoryId) > 0 ? syncRules(repo, required) : 0
    }
    const ruleCount = repositoryId =>
        rows(RULE, {repositoryId}, 500).filter(rule =>
            text(rule.requiredStatusContexts)
                .split(",")
                .map(word => word.trim())
                .includes(CONTEXT)
        ).length
    /* The repositories a group's setting reaches: those below it, at most 2,000. */
    const repositoriesBelow = group =>
        Array.from(
            find(M + "SmithyRepository", {siteId: group.siteId})
                .condition("repositoryPath", "like", group.groupPath + "/%")
                .limit(2000)
                .list()
        ).filter(repo => text(repo.repositoryPath).startsWith(group.groupPath + "/"))
    /* Whose setting an input names: a repository's or a group's, as the caller views it. */
    function settingOf(p) {
        if (p.repositoryId) {
            const r = core.repository(p.repositoryId, p.siteId)
            return {r, row: r.repo, entity: M + "SmithyRepository", key: {repositoryId: r.repo.repositoryId}}
        }
        const r = core.group(p.groupId, p.siteId)
        return {r, row: r.group, entity: M + "SmithyGroup", key: {groupId: r.group.groupId}}
    }
    methods.getAgreement = p => {
        const {r, row} = settingOf(p)
        const isRepository = !!p.repositoryId
        const setting = isRepository ? effective(row) : null
        // another account's signature is a Developer's to ask; one's own anyone's
        let partyId = me()
        if (p.handle && text(p.handle).toLowerCase() !== text(handleOf(p.siteId, me())).toLowerCase()) {
            core.requireRole(r, "SmrDeveloper")
            partyId = one(S + "PublicSiteProfile", {siteId: p.siteId, handle: text(p.handle).toLowerCase()})?.partyId || missing()
        }
        const required = isRepository ? setting.required : effectiveOfGroup(r.chain).required
        let lacks = null
        if (isRepository && partyId) {
            const target = branchSignatures(row, r.git.branch || "main", setting.path, checker(row, null), {})
            lacks = target.invalid ? ["fileInvalid"] : missingOf(p.siteId, partyId, [target])
        }
        // the design has a repository's own setting win over its group's (§9.4): a group's Owner is told which of the
        // repositories below a group that requires the agreement have turned it off
        const optedOut =
            !isRepository && required && r.rank >= RANK.SmrOwner
                ? repositoriesBelow(row)
                      .filter(repo => repo.agreementEnumId === "SmaOff")
                      .map(repo => repo.repositoryPath)
                      .sort()
                : []
        return {
            setting: SETTINGS[row.agreementEnumId] || "inherit",
            effective: required ? "required" : "off",
            inheritedFromPath: isRepository ? setting.inheritedFromPath : effectiveOfGroup(r.chain).inheritedFromPath,
            agreementPath: isRepository ? setting.path : effectiveOfGroup(r.chain).path,
            signed: lacks ? !lacks.length : null,
            missing: lacks || [],
            // the branch rules that require the status now (a repository), or the repositories the group's setting reaches
            changedRuleCount: isRepository ? ruleCount(row.repositoryId) : repositoriesBelow(row).length,
            optedOutList: optedOut,
            revision: Number(row.revision || 1)
        }
    }
    /* A group's own setting in effect: its own, else the nearest above it. chain: the group first. */
    function effectiveOfGroup(chain) {
        for (const [index, group] of chain.entries())
            if (group.agreementEnumId && group.agreementEnumId !== "SmaInherit")
                return {
                    required: group.agreementEnumId === "SmaRequired",
                    path: group.agreementPath || DEFAULT_PATH,
                    inheritedFromPath: index ? group.groupPath : null
                }
        return {required: false, path: DEFAULT_PATH, inheritedFromPath: null}
    }
    methods.setAgreement = p => {
        const {r, entity, key} = settingOf(p)
        writer(p.siteId)
        core.requireRole(r, "SmrOwner")
        const row = one(entity, key, true)
        const before = Number(row.revision || 1)
        if (p.expectedRevision == null || p.expectedRevision === "" || Number(p.expectedRevision) !== before)
            fail("Conflict", "staleRevision: This changed since you read it; reload and try again")
        const fields = {}
        if (given(p.setting) && p.setting !== "")
            fields.agreementEnumId = core.idOfCode(SETTINGS, p.setting) || invalid("setting must be inherit, off or required")
        if (given(p.agreementPath)) {
            const path = text(p.agreementPath).trim().replace(/^\/+/, "")
            if (path && (path.length > 255 || path.split("/").some(segment => ["", ".", "..", ".git"].includes(segment))))
                invalid("agreementPath is the path of a file in the repository")
            fields.agreementPath = path || null
        }
        update(row, {...fields, revision: before + 1})
        const repositories = p.repositoryId ? [row] : repositoriesBelow(row)
        // a repository whose own setting is asked for must have the file, at its default branch
        if (p.repositoryId && effective(row).required) {
            const path = effective(row).path
            const cut = path.lastIndexOf("/")
            const tree = reviews().soft("get#GitTree", {repositoryId: row.repositoryId, path: cut < 0 ? "" : path.slice(0, cut)})
            if (!Array.from(tree.entryList || []).some(entry => entry.path === path))
                invalid("notAvailable[agreementPath]: " + path + " is not in the repository's default branch")
        }
        let changedRuleCount = 0
        const changed = p.repositoryId ? null : row
        for (const repo of repositories) changedRuleCount += syncRules(repo, effective(repo, changed).required)
        // the open merge requests are checked under the new setting
        for (const repo of repositories.slice(0, 200))
            for (const mr of find(GMR, {repositoryId: repo.repositoryId})
                .condition("statusId", "in", reviews().OPEN)
                .limit(200)
                .list())
                if (one(SMR, {mergeRequestId: mr.mergeRequestId})) compute(mr.mergeRequestId, {changed})
        audit(
            p.siteId,
            null,
            p.repositoryId ? "repository" : "group",
            p.repositoryId || p.groupId,
            "setAgreement",
            (SETTINGS[row.agreementEnumId] || "inherit") + " " + (row.agreementPath || ""),
            before,
            before + 1
        )
        const required = p.repositoryId
            ? effective(row).required
            : effectiveOfGroup([row].concat((core.groupChain(row.groupId) || []).slice(1))).required
        return {effective: required ? "required" : "off", changedRuleCount, revision: before + 1}
    }

    // ===== signing on the page =====
    /* The file's text with a line added at the end of a list: after the list's last signature, else at the end of its
       section. */
    function withLine(source, list, line) {
        // the file keeps its line endings: the commit changes the added lines and no other
        const ending = /\r\n/.test(text(source)) ? "\r\n" : "\n"
        const lines = text(source).split(/\r\n|\n/)
        let start = -1
        let end = lines.length
        let level = 0
        let fence = null
        for (const [index, value] of lines.entries()) {
            const fenced = /^\s*(```|~~~)/.exec(value)
            if (fenced) {
                fence = fence ? (fenced[1] === fence ? null : fence) : fenced[1]
                continue
            }
            if (fence) continue
            const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(value)
            if (!heading) continue
            if (start < 0) {
                if (TITLES[heading[2].trim().toLowerCase()] === list) {
                    start = index
                    level = heading[1].length
                }
            } else if (heading[1].length <= level) {
                end = index
                break
            }
        }
        if (start < 0) invalid("notEditable: The agreement file has no list to sign under")
        let at = -1
        for (let index = start + 1; index < end; index++)
            if (/^\s*[-*]\s+Written in .+ by .+ - \S+\s*$/.test(lines[index])) at = index
        if (at >= 0) lines.splice(at + 1, 0, line)
        else {
            let last = end
            while (last > start + 1 && !lines[last - 1].trim()) last--
            lines.splice(last, 0, "", line)
        }
        return lines.join(ending)
    }
    methods.signAgreement = p => {
        const r = core.repository(p.repositoryId, p.siteId)
        const {partyId} = writer(p.siteId)
        return receipt(p, "signAgreement", () => {
            const setting = effective(r.repo)
            const handle = handleOf(p.siteId, partyId) || invalid("policyRefused: Choose a handle before signing")
            const legalName = text(p.legalName).trim()
            if (!legalName || legalName.length > 200 || /[<>\n\r]/.test(legalName) || / - \S+$/.test(legalName))
                invalid("legalName is your legal name, on one line")
            const years = text(p.years).trim() || String(now()).slice(0, 4)
            if (!/^[0-9]{4}(?:\s*[-,]\s*[0-9]{4})*$/.test(years)) invalid("years is a year, or years")
            // where the signature goes: the merge request's own source branch when the account may push there, else a
            // merge request of its own into the default branch
            let target = {r, branch: r.git.branch || "main", destination: null}
            if (p.mergeRequestNum != null && p.mergeRequestNum !== "") {
                const held = reviews().requestFor(reviews().reviewed(p), p.mergeRequestNum)
                const mr = held.mr
                if (mr.pushedForReview !== "Y" && reviews().OPEN.includes(mr.statusId)) {
                    const sourceId = mr.sourceRepositoryId || mr.repositoryId
                    const source = sourceId === r.repo.repositoryId ? r : sourceOf(sourceId, p.siteId)
                    if (source && source.rank >= RANK.SmrDeveloper && reviews().rulesOf(sourceId, mr.sourceRef).mayPushDirectly)
                        target = {r: source, branch: mr.sourceRef, destination: "branch"}
                }
            }
            const repositoryId = target.r.repo.repositoryId
            const head = Array.from(reviews().soft("get#GitRefs", {repositoryId, refType: "branch"}).refList || []).find(
                ref => ref.shortName === target.branch
            )
            if (!head) missing()
            const cut = setting.path.lastIndexOf("/")
            const tree = reviews().soft("get#GitTree", {
                repositoryId,
                revision: head.commitId,
                path: cut < 0 ? "" : setting.path.slice(0, cut)
            })
            const entry = Array.from(tree.entryList || []).find(one => one.path === setting.path)
            const source = entry ? blobText(repositoryId, head.commitId, setting.path) : null
            if (source == null) invalid("notAvailable: " + setting.path + " is not in the repository")
            const lists = parse(source)
            const login = text(handle).toLowerCase()
            if (lists.copyright.has(login) && lists.patent.has(login))
                fail("Conflict", "You have signed " + setting.path + " there already")
            const line = "- Written in " + years + " by " + legalName + " - " + handle
            let signed = source
            for (const list of Object.keys(LISTS)) if (!lists[list].has(login)) signed = withLine(signed, list, line)
            const saved = reviews().save({
                r: target.r,
                siteId: p.siteId,
                branch: target.branch,
                // a Developer signs on a new branch, anyone else by a proposal: never straight on the default branch
                destination: target.destination || (target.r.rank >= RANK.SmrDeveloper ? "newBranch" : "proposal"),
                files: {fileMap: {[setting.path]: signed}, expectedBlobIds: {[setting.path]: entry.objectId}},
                message: "Sign " + setting.path + " (" + handle + ")",
                title: "Sign " + setting.path + " (" + handle + ")",
                topic: "agreement"
            })
            return {
                commitId: saved.commitId,
                mergeRequestNum: saved.mergeRequestNum ?? (target.destination ? Number(p.mergeRequestNum) : null)
            }
        })
    }
    /* A merge request's source repository as the caller holds it, or null when the caller may not view it. */
    function sourceOf(repositoryId, siteId) {
        const repo = one(M + "SmithyRepository", {repositoryId})
        const rights = repo && repo.siteId === siteId ? core.repositoryRights(repo, core.actor()) : null
        const git = rights?.canView ? one("moqui.resource.GitRepository", {repositoryId}) : null
        return git ? {...rights, git} : null
    }
    methods.recheckAgreement = p => {
        const {r, held, mr, row} = reviews().requestWrite(p, false)
        if (!held.access.author) core.requireRole(r, "SmrDeveloper")
        return receipt(p, "recheckAgreement", () => {
            // the history of the file is read anew: once a minute for a merge request
            if (row.agreementCheckedAt && forum.millis(now()) - forum.millis(row.agreementCheckedAt) < 60000)
                fail("Tarpit", "rateLimited: The agreement of this merge request was checked a moment ago; wait a minute")
            update(row, {agreementCheckedAt: now()})
            compute(mr.mergeRequestId, {force: true})
            return {agreement: view(r, {...held, row: one(SMR, {mergeRequestId: mr.mergeRequestId})})}
        })
    }
    methods.declareBotOperator = p => {
        const {r, partyId, held, mr, row} = reviews().requestWrite(p, false)
        return receipt(p, "declareBotOperator", () => {
            const account = one(M + "SmithyAccount", {siteId: p.siteId, partyId: row.authorPartyId})
            if (account?.bot !== "Y") invalid("The merge request's author is not marked as a bot")
            if (account.botOperatorPartyId !== partyId) invalid("You are not the operator of the bot that opened this")
            update(row, {botOperatorPartyId: partyId, botConfirmedByPartyId: null, revision: Number(row.revision || 1) + 1})
            compute(mr.mergeRequestId)
            return {agreement: view(r, {...held, row: one(SMR, {mergeRequestId: mr.mergeRequestId})})}
        })
    }
    methods.confirmBotOperator = p => {
        const {r, partyId, held, mr, row} = reviews().requestWrite(p, true)
        core.requireRole(r, "SmrMaintainer")
        if (!row.botOperatorPartyId) fail("Conflict", "Nobody has said they run the bot that opened this")
        // the operator's word is confirmed by somebody else
        if (row.botOperatorPartyId === partyId)
            fail("Unauthorized", "accessDenied: Another Maintainer confirms what you declared")
        update(row, {botConfirmedByPartyId: partyId, revision: Number(row.revision || 1) + 1})
        compute(mr.mergeRequestId)
        return {agreement: view(r, {...held, row: one(SMR, {mergeRequestId: mr.mergeRequestId})})}
    }
    return {
        effective,
        parse,
        compute,
        stateCode,
        view,
        canSign,
        botDeclared,
        commitsSigned,
        squashFolds,
        isAgreementFile,
        targetMoved,
        brought,
        authorSigned,
        syncRules,
        keepRules,
        checkWrite
    }
}
