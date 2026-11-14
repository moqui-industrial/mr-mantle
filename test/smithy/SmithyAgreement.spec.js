// The contributor agreement (mr-pass plan/design-smithy.md §9.4, §15.5; Dogfood §10; SmithyAgreements.js): off by default;
// where an Owner requires it the branch rule requires the status agreement/authors, and a merge request is signed when
// its author and each commit's author has a line in both lists of AUTHORS.md, at the target or in the merge request
// itself, added by a commit of that account. A line in a fenced block or outside the lists is none; a line somebody else's
// commit added does not count; one list is not enough; an unsigned one does not merge; a signature made on the page in
// the merge request signs it; a squash that would fold a signature into another person's commit is refused; a squash of
// two refs is asked about its source's authors; a mirror's fetch is not asked. Spec-local site, accounts and a db repository. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyAgreement
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMA_SITE"
const ids = {}
const signed = {copyright: ["Other Person - smadev2"], patent: ["Other Person - smadev2"]}
const authors = () =>
    [
        "# Authors",
        "",
        "## Contributing",
        "",
        "- Written in <years> by <legal name> - <GitHub username>",
        "",
        "```",
        "- Written in 2020 by In A Fence - smadev",
        "```",
        "",
        "## Copyright Waiver",
        "",
        "The waiver.",
        "",
        ...signed.copyright.map(who => "- Written in 2026 by " + who),
        "",
        "## Grant of Patent License",
        "",
        "The grant.",
        "",
        ...signed.patent.map(who => "- Written in 2026 by " + who),
        ""
    ].join("\n")
const op = (username, operation, input) => lib.op(username, SITE, operation, {repositoryId: ids.repositoryId, ...input})
const request = (username, mergeRequestNum) => op(username, "getMergeRequest", {mergeRequestNum})
const save = (username, input) => op(username, "commitFile", {operationId: "sma-save-" + ec.user.randomString(10), ...input})
/* A merge request of one commit by an account, on a new branch. */
const propose = (username, path) => {
    lib.settled(SITE, username)
    return save(username, {branch: "main", action: "create", path, content: "By " + username + "\n", destination: "newBranch"})
}
const state = mergeRequestNum => {
    const read = request(lib.OPERATOR, mergeRequestNum)
    return {
        state: read.agreement.state,
        missing: read.agreement.missingList.map(entry => [entry.handle, entry.missing.join(" ")]),
        check: read.checkList.filter(check => check.context == "agreement/authors").map(check => [check.state, check.required])
    }
}
/* An account adds its own line to the file on main, in the lists named, by a commit of its own. */
const signOnMain = (username, lists) => {
    for (const list of lists) signed[list].push(username + " - " + username.toLowerCase().replace("_", ""))
    const blobId = op(username, "getEditContext", {refPath: "main/AUTHORS.md"}).blobId
    lib.settled(SITE, username)
    return save(username, {
        branch: "main",
        action: "update",
        path: "AUTHORS.md",
        content: authors(),
        baseBlobId: blobId,
        destination: "branch"
    })
}

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const name of ["SMA_OWNER", "SMA_MAINT", "SMA_DEV", "SMA_DEV2", "SMA_HALF"])
            lib.account(SITE, name, {handle: name.toLowerCase().replace("_", "")})
        ids.groupId = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smagroup", visibility: "public"}).groupId
        ids.repositoryId = lib.createRepository(lib.OPERATOR, {
            siteId: SITE,
            groupId: ids.groupId,
            slug: "code",
            visibility: "public"
        }).repositoryId
        lib.role(SITE, {groupId: ids.groupId}, "SMA_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.groupId}, "SMA_MAINT", "SmrMaintainer")
        for (const name of ["SMA_DEV", "SMA_DEV2", "SMA_HALF"])
            lib.role(SITE, {repositoryId: ids.repositoryId}, name, "SmrDeveloper")
        // the file as the operator wrote it: smadev2's lines are there, by a commit that is not smadev2's
        lib.commit(ids.repositoryId, "Start", {"AUTHORS.md": authors(), "README.md": "# Code\n"})
        // a Maintainer signs both lists and another Developer one of them, each by a commit of their own
        signOnMain("SMA_MAINT", ["copyright", "patent"])
        signOnMain("SMA_HALF", ["copyright"])
    }
})

feature("the agreement is off by default; an Owner requires it, and the branch rule then requires its status", {
    when() {
        const before = op(null, "getAgreement", {})
        const opened = propose("SMA_DEV", "dev.txt")
        const offState = state(opened.mergeRequestNum)
        const set = (username, more = {}) =>
            op(username, "setAgreement", {
                setting: "required",
                expectedRevision: op(lib.OPERATOR, "getAgreement", {}).revision,
                ...more
            })
        const byMaintainer = set("SMA_MAINT")
        const noFile = set("SMA_OWNER", {agreementPath: "docs/NONE.md"})
        const required = set("SMA_OWNER")
        const signedBy = input =>
            lib.run("mantle.smithy.SmithyAgreementServices.get#AuthorSigned", {repositoryId: ids.repositoryId, ...input})
        return {
            before,
            opened,
            offState,
            byMaintainer,
            noFile,
            required,
            after: op("SMA_DEV", "getAgreement", {}),
            maintainer: op("SMA_MAINT", "getAgreement", {}),
            other: op("SMA_MAINT", "getAgreement", {handle: "smahalf"}),
            notMine: op("SMA_DEV", "getAgreement", {handle: "smahalf"}).signed,
            asked: op(null, "getAgreement", {handle: "smahalf"}),
            rules: lib.run("org.moqui.git.GitServices.get#GitBranchRules", {
                repositoryId: ids.repositoryId,
                refName: "refs/heads/main"
            }),
            byAddress: signedBy({emailAddress: "SMA_DEV2@smithy.test"}),
            byUser: signedBy({userId: "SMA_MAINT"}),
            nobody: signedBy({emailAddress: "nobody@elsewhere.test"}),
            unsigned: state(opened.mergeRequestNum),
            signPaths: [request("SMA_DEV", 1), request("SMA_MAINT", 1)].map(read => read.agreement.signPath),
            merge: op("SMA_MAINT", "mergeMergeRequest", {
                mergeRequestNum: opened.mergeRequestNum,
                expectedRevision: request(lib.OPERATOR, opened.mergeRequestNum).mergeRequest.revision
            })
        }
    },
    then({
        before,
        opened,
        offState,
        byMaintainer,
        noFile,
        required,
        after,
        maintainer,
        other,
        notMine,
        asked,
        rules,
        byAddress,
        byUser,
        nobody,
        unsigned,
        signPaths,
        merge
    }) {
        before.setting == "inherit"
        before.effective == "off"
        before.agreementPath == "AUTHORS.md"
        opened.mergeRequestNum == 1
        offState == {state: "off", missing: [], check: []}
        byMaintainer.reason == "accessDenied"
        noFile.kind == "Unprocessable"
        required.effective == "required"
        // the default branch had no rule: one is made that requires the status
        required.changedRuleCount == 1
        Array.from(rules.requiredStatusContexts) == ["agreement/authors"]
        after.effective == "required"
        after.signed == false
        after.missing == ["copyright", "patent"]
        maintainer.signed == true
        // another account's signature is a Developer's to ask
        other.missing == ["patent"]
        notMine == false
        asked.kind == "AuthenticationRequired"
        // a line that another person's commit added is not the account's own
        byAddress.signed == false
        byAddress.missing == ["copyrightNotOwn", "patentNotOwn"]
        byUser.signed == true
        nobody.missing == ["account"]
        // the open merge request is checked under the new setting: a line in a fenced block is no signature
        unsigned == {state: "unsigned", missing: [["smadev", "copyright patent"]], check: [["failure", true]]}
        // its author signs in the merge request, on its source branch; anyone else on the target
        signPaths == ["smagroup/code/-/edit/smadev-patch-1/AUTHORS.md", "smagroup/code/-/edit/main/AUTHORS.md"]
        merge.reason == "agreementUnsigned"
    }
})

feature("signed in the target is signed; one list, and a line somebody else's commit added, are not", {
    when() {
        const byMaintainer = propose("SMA_MAINT", "maint.txt")
        const byOther = propose("SMA_DEV2", "dev2.txt")
        const byHalf = propose("SMA_HALF", "half.txt")
        return {
            maintainer: state(byMaintainer.mergeRequestNum),
            other: state(byOther.mergeRequestNum),
            half: state(byHalf.mergeRequestNum),
            list: op(null, "findMergeRequests", {}).mergeRequestList.map(row => [row.mergeRequestNum, row.agreementState]),
            agent: op(null, "getMergeRequestChanges", {mergeRequestNum: byHalf.mergeRequestNum, withDiffs: true, agent: true}),
            agentSigned: op(null, "getMergeRequestChanges", {
                mergeRequestNum: byMaintainer.mergeRequestNum,
                withDiffs: true,
                agent: true
            }),
            person: op(null, "getMergeRequestChanges", {mergeRequestNum: byHalf.mergeRequestNum, withDiffs: true})
        }
    },
    then({maintainer, other, half, list, agent, agentSigned, person}) {
        maintainer == {state: "signed", missing: [], check: [["success", true]]}
        other == {state: "unsigned", missing: [["smadev2", "copyrightNotOwn patentNotOwn"]], check: [["failure", true]]}
        half == {state: "unsigned", missing: [["smahalf", "patent"]], check: [["failure", true]]}
        list ==
            [
                [4, "unsigned"],
                [3, "unsigned"],
                [2, "signed"],
                [1, "unsigned"]
            ]
        // an agent's tool gets no diff of an unsigned merge request: its title and description only
        agent.diffRefused == true
        agent.reason == "agreementUnsigned"
        agent.title == "Add half.txt"
        agent.fileDiffList == []
        agent.commitList == []
        agentSigned.diffRefused == false
        agentSigned.fileDiffList.length == 1
        person.fileDiffList.length == 1
        person.commitList.map(commit => commit.signed) == [false]
    }
})

feature(
    "an author's address is not enough: a commit in another's name, a change that does more than sign, a range too long to read and a write around the merge request are all unsigned",
    {
        when() {
            const hosted = number =>
                lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, mergeRequestNum: number})
            const write = (username, parameters) =>
                lib.as(username, () => {
                    try {
                        return lib.run("org.moqui.git.GitServices.commit#GitFiles", {
                            repositoryId: ids.repositoryId,
                            ...parameters
                        })
                    } catch (error) {
                        return {refused: String(error.message || error)}
                    }
                })
            const open = (username, sourceRef) => {
                lib.settled(SITE, username)
                return op(username, "createMergeRequest", {
                    sourceRef,
                    title: "Merge " + sourceRef,
                    operationId: "sma-open-" + sourceRef
                })
            }
            // 1. a Developer pushes a commit written as another account, which adds that account's missing line and some code
            signed.patent.push("SMA_HALF - smahalf")
            const forgedFile = authors()
            signed.patent.pop()
            write("SMA_DEV2", {
                branch: "main",
                newBranch: "forged",
                message: "Sign for someone else",
                fileMap: {"AUTHORS.md": forgedFile, "forged.txt": "Not theirs\n"},
                authorName: "SMA_HALF",
                authorEmail: "sma_half@smithy.test"
            })
            const forged = state(open("SMA_DEV2", "forged").mergeRequestNum)
            // 2. a signature in a change that also rewords the waiver, and a decoy list inside an HTML comment
            const mine = "- Written in 2026 by The Owner - smaowner"
            const sign = text =>
                text
                    .replace("\n\n## Grant of Patent License", "\n" + mine + "\n\n## Grant of Patent License")
                    .replace(/\n$/, "\n" + mine + "\n")
            write("SMA_OWNER", {
                branch: "main",
                newBranch: "reworded",
                message: "Sign, and more",
                fileMap: {"AUTHORS.md": sign(authors()).replace("The waiver.", "A weaker waiver.")}
            })
            write("SMA_OWNER", {
                branch: "main",
                newBranch: "decoy",
                message: "A decoy",
                fileMap: {
                    "AUTHORS.md": authors().replace(
                        "## Copyright Waiver",
                        "<!--\n## Copyright Waiver\n\n" +
                            mine +
                            "\n\n## Grant of Patent License\n\n" +
                            mine +
                            "\n-->\n\n## Copyright Waiver"
                    )
                }
            })
            write("SMA_OWNER", {branch: "main", newBranch: "alone", message: "Sign", fileMap: {"AUTHORS.md": sign(authors())}})
            const reworded = state(open("SMA_OWNER", "reworded").mergeRequestNum)
            const decoy = state(open("SMA_OWNER", "decoy").mergeRequestNum)
            const alone = state(open("SMA_OWNER", "alone").mergeRequestNum)
            // 3. a range longer than is read: unsigned, whoever wrote it (the bound is lowered here)
            const compute = () =>
                lib.run("mantle.smithy.SmithyAgreementServices.compute#Agreement", {mergeRequestId: hosted(2).mergeRequestId})
                    .state
            setProperty("smithy_agreement_max_commits", "1")
            let tooLong
            try {
                save("SMA_MAINT", {
                    branch: "smamaint-patch-1",
                    action: "create",
                    path: "maint2.txt",
                    content: "More\n",
                    destination: "branch"
                })
                lib.settle(ids.repositoryId)
                tooLong = state(2)
            } finally {
                setProperty("smithy_agreement_max_commits", "")
            }
            const readAll = compute()
            // 4. around the merge request: a write to the default branch (as the release notes are written), and the git
            // host's own merge as Projects calls it
            const around = write("SMA_DEV", {
                branch: "main",
                message: "Straight in",
                fileMap: {"direct.txt": "x\n"},
                bypassBranchRules: true
            })
            const bySigner = write("SMA_MAINT", {
                branch: "main",
                message: "Notes",
                fileMap: {"CHANGELOG.md": "# Changelog\n"},
                bypassBranchRules: true
            })
            lib.settle(ids.repositoryId)
            const hostMerge = lib.service("SMA_MAINT", "org.moqui.git.GitReviewServices.merge#MergeRequest", {
                mergeRequestId: hosted(4).mergeRequestId
            })
            // 5. a squash by the git host's merge of two refs, where the branch's rule no longer asks for a merge request: the
            // squash is one commit by who merges, who has signed, and it is the source's authors who are asked
            const mainRule = ec.entity
                .find("moqui.resource.GitBranchRule")
                .condition({repositoryId: ids.repositoryId})
                .disableAuthz()
                .list()[0]
            const ruleKey = {branchRuleId: mainRule.branchRuleId}
            lib.set("moqui.resource.GitBranchRule", ruleKey, {requireMergeRequest: "N", requiredStatusContexts: null})
            let squashAround
            try {
                squashAround = lib.service("SMA_MAINT", "org.moqui.git.GitServices.merge#GitRefs", {
                    repositoryId: ids.repositoryId,
                    source: "smadev-patch-1",
                    target: "main",
                    method: "GmmSquash"
                })
            } finally {
                lib.set("moqui.resource.GitBranchRule", ruleKey, {
                    requireMergeRequest: "Y",
                    requiredStatusContexts: "agreement/authors"
                })
            }
            return {
                squashAround,
                forged,
                reworded,
                decoy,
                alone,
                tooLong,
                readAll,
                around,
                bySigner,
                hostMerge,
                rule: lib.run("org.moqui.git.GitServices.get#GitBranchRules", {
                    repositoryId: ids.repositoryId,
                    refName: "refs/heads/main"
                }),
                page: save("SMA_MAINT", {
                    branch: "main",
                    action: "create",
                    path: "page.txt",
                    content: "x\n",
                    destination: "branch"
                })
            }
        },
        then({forged, reworded, decoy, alone, tooLong, readAll, around, bySigner, hostMerge, squashAround, rule, page}) {
            squashAround.refused == true
            squashAround.message.includes("agreementUnsigned")
            squashAround.message.includes("smadev: the Copyright Waiver")
            // the commit is in smahalf's name and smadev2 brought it: it signs nobody, and the line it adds is not smahalf's own
            forged.state == "unsigned"
            forged.check == [["failure", true]]
            forged.missing.some(entry => entry[0] == "smahalf" && entry[1] == "authorNotPusher")
            forged.missing.some(entry => entry[0] == "smahalf" && entry[1].includes("patentNotOwn"))
            forged.missing.some(entry => entry[0] == "smadev2")
            reworded ==
                {state: "unsigned", missing: [["smaowner", "copyright patent notOnlySignatures"]], check: [["failure", true]]}
            // what is inside a comment is neither a heading nor a signature
            decoy == {state: "unsigned", missing: [["smaowner", "copyright patent"]], check: [["failure", true]]}
            alone == {state: "signed", missing: [], check: [["success", true]]}
            tooLong.state == "unsigned"
            tooLong.missing == [[null, "tooManyCommits"]]
            readAll == "signed"
            // the gate's own words, for a write through the git host
            around.refused.includes("agreementUnsigned: AUTHORS.md must be signed by everyone whose commits come to main")
            around.refused.includes("smadev")
            bySigner.commitId.length == 40
            hostMerge.refused == true
            // the git host's own refusal: the branch rule requires the status, which is a failure
            hostMerge.message.includes("checks not passed: agreement/authors")
            // where the agreement is required the default branch changes through a merge request
            rule.requireMergeRequest == true
            page.reason == "accessDenied"
        }
    }
)

feature(
    "a signature made on the page in the merge request signs it; a squash that would fold it into another's commit is refused",
    {
        when() {
            const sign = operationId =>
                op("SMA_DEV", "signAgreement", {mergeRequestNum: 1, legalName: "Dev Eloper", years: "2026", operationId})
            lib.settled(SITE, "SMA_DEV")
            const made = sign("sma-sign-0001")
            lib.settle(ids.repositoryId)
            const after = state(1)
            lib.settled(SITE, "SMA_DEV")
            const again = sign("sma-sign-0002")
            const file = op(null, "getBlob", {refPath: "smadev-patch-1/AUTHORS.md"}).text
            // a second person's commit on the same branch
            lib.settled(SITE, "SMA_MAINT")
            const more = save("SMA_MAINT", {
                branch: "smadev-patch-1",
                action: "create",
                path: "more.txt",
                content: "And more\n",
                destination: "branch"
            })
            lib.settle(ids.repositoryId)
            const recheck = op("SMA_DEV", "recheckAgreement", {mergeRequestNum: 1, operationId: "sma-recheck-1"})
            const soon = op("SMA_DEV", "recheckAgreement", {mergeRequestNum: 1, operationId: "sma-recheck-2"})
            // a squash made outside Smithy, by the git host's own merge as Projects calls it, is refused by the same rule
            const outside = lib.service("SMA_MAINT", "org.moqui.git.GitReviewServices.merge#MergeRequest", {
                mergeRequestId: lib.row("moqui.resource.GitMergeRequest", {repositoryId: ids.repositoryId, mergeRequestNum: 1})
                    .mergeRequestId,
                mergeMethodEnumId: "GmmSquash"
            })
            const merge = mergeMethod =>
                op("SMA_MAINT", "mergeMergeRequest", {
                    mergeRequestNum: 1,
                    mergeMethod,
                    expectedRevision: request(lib.OPERATOR, 1).mergeRequest.revision
                })
            const squash = merge("squash")
            const merged = merge("merge")
            lib.settle(ids.repositoryId)
            return {
                made,
                after,
                again,
                file,
                more,
                recheck,
                soon,
                outside,
                squash,
                merged,
                onMain: op("SMA_DEV", "getAgreement", {})
            }
        },
        then({made, after, again, file, more, recheck, soon, outside, squash, merged, onMain}) {
            // once a minute for a merge request
            soon.kind == "Tarpit"
            outside.refused == true
            outside.message.includes("squashFoldsSignature")
            // on the merge request's own branch, which its author may push to
            made.mergeRequestNum == 1
            made.commitId.length == 40
            file.split("\n").filter(line => line == "- Written in 2026 by Dev Eloper - smadev").length == 2
            after == {state: "signed", missing: [], check: [["success", true]]}
            again.kind == "Conflict"
            more.destination == "branch"
            recheck.agreement.state == "signed"
            squash.reason == "squashFoldsSignature"
            merged.state == "merged"
            // the signature commit kept its author: on main it is the account's own
            onMain.signed == true
        }
    }
)

feature(
    "a bot counts as signed when its operator has signed, says so on the merge request and a Maintainer confirms it; a group's setting reaches its repositories",
    {
        when() {
            lib.account(SITE, "SMA_BOT", {handle: "smabot"})
            lib.role(SITE, {repositoryId: ids.repositoryId}, "SMA_BOT", "SmrDeveloper")
            lib.make("mantle.smithy.SmithyAccount", {
                siteId: SITE,
                partyId: "SMA_BOT",
                bot: "Y",
                botOperatorPartyId: "SMA_MAINT",
                revision: 1
            })
            const number = propose("SMA_BOT", "bot.txt").mergeRequestNum
            const waiting = state(number)
            const declare = username =>
                op(username, "declareBotOperator", {mergeRequestNum: number, operationId: "sma-bot-" + username})
            const confirm = username =>
                op(username, "confirmBotOperator", {
                    mergeRequestNum: number,
                    expectedRevision: request(lib.OPERATOR, number).mergeRequest.revision
                })
            const early = confirm("SMA_OWNER")
            const byOther = declare("SMA_DEV")
            const declared = declare("SMA_MAINT")
            const bySelf = confirm("SMA_MAINT")
            const confirmed = confirm("SMA_OWNER")
            // a second repository of the group has no setting of its own: the group's is its
            const other = lib.createRepository(lib.OPERATOR, {
                siteId: SITE,
                groupId: ids.groupId,
                slug: "other",
                visibility: "public"
            }).repositoryId
            const group = lib.op("SMA_OWNER", SITE, "setAgreement", {
                groupId: ids.groupId,
                setting: "required",
                agreementPath: "SIGNERS.md",
                expectedRevision: lib.op(lib.OPERATOR, SITE, "getAgreement", {groupId: ids.groupId}).revision
            })
            // a mirror of another server in the group, so the agreement is required of it: its fetch is not asked who wrote
            // the commits (Smithy.gitecas.xml), once the branch has the file
            const suffix = ec.user.randomString(8)
            const from = "sma-src-" + suffix
            const mirrorId = "sma-mirror-" + suffix
            lib.make("moqui.resource.GitRepository", {
                repositoryId: from,
                repositoryKind: "local",
                branch: "main",
                localPath: "tmp/" + from + ".git"
            })
            lib.make("moqui.resource.GitRepository", {
                repositoryId: mirrorId,
                repositoryKind: "remote",
                branch: "main",
                localPath: "tmp/" + mirrorId + ".git",
                remoteUrl: "file://" + ec.factory.getRuntimePath() + "/tmp/" + from + ".git"
            })
            const mirror = {}
            try {
                lib.commit(from, "Start", {"SIGNERS.md": authors()})
                const fetch = () =>
                    lib.service(lib.OPERATOR, "org.moqui.git.GitServices.fetch#GitRepository", {repositoryId: mirrorId})
                mirror.first = fetch()
                lib.service(lib.OPERATOR, "mantle.smithy.SmithyServices.bind#Repository", {
                    siteId: SITE,
                    repositoryId: mirrorId,
                    groupId: ids.groupId,
                    slug: "mirror"
                })
                mirror.commitId = lib.commit(from, "By nobody who signed", {"more.txt": "x\n"})
                mirror.second = fetch()
                mirror.agreement = lib.op(lib.OPERATOR, SITE, "getAgreement", {repositoryId: mirrorId}).effective
            } finally {
                for (const repositoryId of [mirrorId, from])
                    lib.service(lib.OPERATOR, "org.moqui.git.GitServices.delete#GitRepository", {repositoryId})
            }
            return {
                mirror,
                waiting,
                early,
                byOther,
                declared,
                bySelf,
                confirmed,
                group,
                inherited: lib.op(null, SITE, "getAgreement", {repositoryId: other}),
                own: op(null, "getAgreement", {})
            }
        },
        then({mirror, waiting, early, byOther, declared, bySelf, confirmed, group, inherited, own}) {
            mirror.agreement == "required"
            mirror.first.headCommitId.length == 40
            mirror.second.headCommitId == mirror.commitId
            waiting == {state: "pending", missing: [["smabot", "botOperator"]], check: [["pending", true]]}
            early.kind == "Conflict"
            byOther.kind == "Unprocessable"
            declared.agreement.state == "pending"
            bySelf.reason == "accessDenied"
            confirmed.agreement.state == "signed"
            group.effective == "required"
            inherited.setting == "inherit"
            inherited.effective == "required"
            inherited.inheritedFromPath == "smagroup"
            inherited.agreementPath == "SIGNERS.md"
            // the repository's own setting stays its own
            own.inheritedFromPath == null
            own.agreementPath == "AUTHORS.md"
        }
    }
)
