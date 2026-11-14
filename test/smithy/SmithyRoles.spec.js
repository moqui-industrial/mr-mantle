// Smithy's effective role and the one check (mr-pass plan/design-smithy.md §5.2 to §5.5; SmithyCore.js and
// mantle.work.GitServices.check#GitRepositoryAuthz): a role on a group is held on its subgroups and their repositories,
// and the highest of a party's rows counts; a row past its end date and a suspended party hold nothing; a personal
// namespace's party is its Owner; a role below a private group tells nothing of that group but its path; a group's
// members are shown to an Owner, and to another viewer by their profiles; the check answers view, update and delete by
// the role and the confirmed address (an internal account's address is confirmed), view alone for no user on a public
// repository, Smithy's answer alone for a repository with a Smithy row and the project roles' for one without; and the
// framework asks it for no user. Spec-local site, accounts, groups, db repositories and a project. Regression suite:
// these are rules. Run: ./moq test mr-mantle --spec SmithyRoles
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMR_SITE"
const PROJECT = "SMRP"
const ids = {}
const view = (username, repositoryId) => lib.op(username, SITE, "getRepository", {repositoryId})
const allows = (userId, repositoryId, action) => lib.authz(userId, repositoryId, action) == "AUTHZT_ALLOW"

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const id of [
            "SMR_MIXED",
            "SMR_OLD",
            "SMR_SUSPENDED",
            "SMR_PLAIN",
            "SMR_REPORTER",
            "SMR_REPO_GUEST",
            "SMR_SUB_GUEST"
        ])
            lib.account(SITE, id)
        lib.account(SITE, "SMR_DEV", {handle: "smrdev"})
        lib.account(SITE, "SMR_OWNER", {handle: "smrowner", siteRole: "owner"})
        lib.account(SITE, "SMR_UNCONFIRMED", {unconfirmed: true})
        lib.account(SITE, "SMR_INTERNAL", {unconfirmed: true, internal: true})
        const group = (pathSegment, more) => lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment, ...more}).groupId
        const repository = (groupId, slug, visibility) =>
            lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId, slug, visibility}).repositoryId
        ids.group = group("smrgroup", {visibility: "public"})
        ids.subgroup = group("sub", {parentGroupId: ids.group})
        ids.code = repository(ids.subgroup, "code", "private")
        ids.open = repository(ids.group, "open", "public")
        ids.secretGroup = group("smrsecret", {name: "Secret Parent", visibility: "private"})
        ids.secretSubgroup = group("inner", {parentGroupId: ids.secretGroup, name: "Inner"})
        ids.secretCode = repository(ids.secretSubgroup, "code", "private")
        for (const [target, partyId, roleEnumId, more] of [
            [{groupId: ids.group}, "SMR_DEV", "SmrDeveloper"],
            [{groupId: ids.group}, "SMR_OWNER", "SmrOwner"],
            [{groupId: ids.group}, "SMR_REPORTER", "SmrReporter"],
            [{groupId: ids.subgroup}, "SMR_MIXED", "SmrGuest"],
            [{repositoryId: ids.code}, "SMR_MIXED", "SmrMaintainer"],
            [{groupId: ids.group}, "SMR_OLD", "SmrOwner", {thruDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 500}],
            [{groupId: ids.group}, "SMR_SUSPENDED", "SmrDeveloper"],
            [{groupId: ids.group}, "SMR_UNCONFIRMED", "SmrMaintainer"],
            [{groupId: ids.group}, "SMR_INTERNAL", "SmrDeveloper"],
            [{repositoryId: ids.secretCode}, "SMR_REPO_GUEST", "SmrGuest"],
            [{groupId: ids.secretSubgroup}, "SMR_SUB_GUEST", "SmrGuest"]
        ])
            lib.role(SITE, target, partyId, roleEnumId, more)
        lib.make("mantle.forum.ForumSanction", {
            sanctionId: "SMR_SANCTION",
            siteId: SITE,
            partyId: "SMR_SUSPENDED",
            kind: "suspend",
            fromDate: ec.user.timestampMillis(ec.user.nowTimestamp) - 1000,
            revision: 1
        })
    }
})

feature(
    "a group's role is held on its subgroups and repositories, the highest row counts, and an ended row or a suspension holds nothing",
    {
        when() {
            return {
                dev: view("SMR_DEV", ids.code),
                mixed: view("SMR_MIXED", ids.code),
                old: view("SMR_OLD", ids.code),
                suspended: view("SMR_SUSPENDED", ids.code),
                plain: view("SMR_PLAIN", ids.code)
            }
        },
        then({dev, mixed, old, suspended, plain}) {
            dev.myRole == "developer"
            dev.capabilities.canPush == true
            dev.capabilities.canMerge == false
            mixed.myRole == "maintainer"
            mixed.capabilities.canMerge == true
            old.kind == "NotFound"
            suspended.kind == "NotFound"
            plain.kind == "NotFound"
        }
    }
)

feature("a role below a private group tells its path and nothing else of it", {
    when() {
        return {
            repository: view("SMR_REPO_GUEST", ids.secretCode),
            subgroup: lib.op("SMR_SUB_GUEST", SITE, "getGroup", {groupId: ids.secretSubgroup}),
            parent: lib.op("SMR_SUB_GUEST", SITE, "getGroup", {groupId: ids.secretGroup}),
            operator: view(lib.OPERATOR, ids.secretCode).group.name
        }
    },
    then({repository, subgroup, parent, operator}) {
        repository.myRole == "guest"
        // a Guest of the repository alone: its group's id and path, as the repository's own path tells
        repository.group == {groupId: ids.secretSubgroup, groupPath: "smrsecret/inner"}
        // a Guest of the subgroup views it, and reads no name of the private group above
        subgroup.group.name == "Inner"
        subgroup.ancestorList == [{groupId: ids.secretGroup, groupPath: "smrsecret", name: null}]
        parent.kind == "NotFound"
        operator == "Inner"
    }
})

feature("a group's Owner sees every member, another viewer those whose profile is shown", {
    when() {
        const members = username => lib.op(username, SITE, "findGroupMembers", {groupId: ids.subgroup}).memberList
        return {owner: members("SMR_OWNER"), viewer: members("SMR_DEV")}
    },
    then({owner, viewer}) {
        // the rows on the group and the subgroup that have not ended, the operator who made the group among them
        owner.length == 8
        owner.filter(m => m.role == "owner").map(m => m.handle) == [null, "smrowner"]
        owner.find(m => m.handle == "smrdev").fromPath == "smrgroup"
        owner.every(m => m.partyId == null)
        viewer.map(m => m.handle + " " + m.role) == ["smrowner owner", "smrdev developer"]
    }
})

feature("the check allows view, a push from Developer and a forced push from Maintainer, each push with a confirmed address", {
    when() {
        return {
            // each action for one who holds it and one who does not
            view: [allows("", ids.open, "VIEW"), allows("", ids.code, "VIEW")],
            update: [allows("SMR_DEV", ids.code, "UPDATE"), allows("SMR_REPORTER", ids.code, "UPDATE")],
            remove: [allows("SMR_MIXED", ids.code, "DELETE"), allows("SMR_DEV", ids.code, "DELETE")],
            // a Maintainer with no confirmed address reads and does not push; an internal account's address is confirmed
            unconfirmed: [allows("SMR_UNCONFIRMED", ids.code, "VIEW"), allows("SMR_UNCONFIRMED", ids.code, "UPDATE")],
            internal: allows("SMR_INTERNAL", ids.code, "UPDATE"),
            anonymousPush: allows("", ids.open, "UPDATE")
        }
    },
    then({view, update, remove, unconfirmed, internal, anonymousPush}) {
        view == [true, false]
        update == [true, false]
        remove == [true, false]
        unconfirmed == [true, false]
        internal == true
        anonymousPush == false
    }
})

feature("a personal namespace's party is the Owner of its repositories", {
    when() {
        const made = lib.createRepository("SMR_OWNER", {siteId: SITE, slug: "Mine", visibility: "private"})
        return {
            made,
            own: view("SMR_OWNER", made.repositoryId),
            other: view("SMR_DEV", made.repositoryId),
            remove: allows("SMR_OWNER", made.repositoryId, "DELETE"),
            // only the site's owner makes one until DG2's policy
            refused: lib.createRepository("SMR_DEV", {siteId: SITE, slug: "theirs", visibility: "private"}).reason
        }
    },
    then({made, own, other, remove, refused}) {
        made.repositoryPath == "smrowner/mine"
        own.myRole == "owner"
        own.repository.ownerHandle == "smrowner"
        own.group == null
        other.kind == "NotFound"
        remove == true
        refused == "accessDenied"
    }
})

feature(
    "a project role is a source of the role, Smithy's answer stands alone for its repositories, and the project's for others",
    {
        when() {
            lib.run("mantle.work.ProjectServices.create#Project", {workEffortId: PROJECT, workEffortName: "Smithy Roles"})
            lib.run("mantle.work.GitServices.add#ProjectRepository", {workEffortId: PROJECT, repositoryId: ids.code})
            ids.projectOnly = lib.run("mantle.work.GitServices.create#ProjectRepository", {
                workEffortId: PROJECT,
                repositoryId: "smrp-only",
                repositoryKind: "db",
                applyDefaults: false
            }).repositoryId
            const before = allows("SMR_PLAIN", ids.code, "VIEW")
            lib.make("mantle.work.effort.WorkEffortParty", {
                workEffortId: PROJECT,
                partyId: "SMR_PLAIN",
                roleTypeId: "Assignee",
                fromDate: ec.user.nowTimestamp
            })
            lib.make("mantle.work.effort.WorkEffortParty", {
                workEffortId: PROJECT,
                partyId: "SMR_DEV",
                roleTypeId: "Manager",
                fromDate: ec.user.nowTimestamp
            })
            const member = {
                role: view("SMR_PLAIN", ids.code).myRole,
                listed: lib.op("SMR_PLAIN", SITE, "findRepositories", {groupId: ids.subgroup}).repositoryList.map(r => r.slug),
                push: allows("SMR_PLAIN", ids.code, "UPDATE"),
                projectOnly: allows("SMR_PLAIN", ids.projectOnly, "UPDATE")
            }
            const lead = allows("SMR_DEV", ids.code, "DELETE")
            // hidden: Smithy's rule refuses the project member too, whom the project roles alone would let in
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.code}, {hiddenAt: ec.user.nowTimestamp})
            const hidden = allows("SMR_PLAIN", ids.code, "VIEW")
            lib.set("mantle.smithy.SmithyRepository", {repositoryId: ids.code}, {hiddenAt: null})
            return {
                before,
                member,
                lead,
                hidden,
                others: [allows("SMR_MIXED", ids.projectOnly, "VIEW"), allows("", ids.projectOnly, "VIEW")]
            }
        },
        then({before, member, lead, hidden, others}) {
            before == false
            member.role == "developer"
            member.listed == ["code"]
            member.push == true
            member.projectOnly == true
            lead == true
            hidden == false
            // a repository with no Smithy row: a Smithy role and no user get nothing
            others == [false, false]
        }
    }
)

feature("the framework asks the check for no user and for a user: a public repository is viewed with no login", {
    when() {
        const own = (username, repositoryId, action) =>
            lib.as(username, () => ec.artifactExecution.isPermittedOwn(repositoryId, "AT_GIT_REPOSITORY", "AUTHZA_" + action))
        return {
            anonymous: [own(null, ids.open, "VIEW"), own(null, ids.open, "UPDATE"), own(null, ids.code, "VIEW")],
            reporter: [own("SMR_REPORTER", ids.code, "VIEW"), own("SMR_REPORTER", ids.code, "UPDATE")]
        }
    },
    then({anonymous, reporter}) {
        anonymous == [true, false, false]
        reporter == [true, false]
    }
})
