// Members and roles on a group and on a repository (mr-pass plan/design-smithy.md §5.2, §5.3, §15.3; SmithyManage.js
// setGroupMember, leaveGroup, findRepositoryMembers, setRepositoryMember): only an Owner sets a role, and a role given
// is held at once; a Maintainer reads a repository's members and a Developer does not; a group keeps an Owner, by a
// change of role, an end date and a leave alike; an end date ends the role; a role on one repository is its own row;
// and an edit names the revision it read. Spec-local site, accounts, a group and a db repository. Regression suite:
// these are rules. Run: ./moq test mr-mantle --spec SmithyMembers
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMM_SITE"
const ids = {}
const op = (username, operation, input) => lib.op(username, SITE, operation, input)
const setGroup = (username, handle, role, more = {}) =>
    op(username, "setGroupMember", {groupId: ids.group, handle, role, ...more})
const setRepository = (username, handle, role, more = {}) =>
    op(username, "setRepositoryMember", {repositoryId: ids.code, handle, role, ...more})
const roleOf = username => op(username, "getRepository", {repositoryId: ids.code}).myRole

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        for (const id of ["OWNER", "SECOND", "MAINTAINER", "DEVELOPER", "NEW", "ENDING", "GUEST"])
            lib.account(SITE, "SMM_" + id, {handle: "smm" + id.toLowerCase()})
        ids.group = lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment: "smmgroup", visibility: "private"}).groupId
        ids.code = lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.group, slug: "code"}).repositoryId
        // the operator made the group and is its first Owner: SMM_OWNER takes its place, so the group has one
        lib.role(SITE, {groupId: ids.group}, "SMM_OWNER", "SmrOwner")
        lib.role(SITE, {groupId: ids.group}, "SMM_MAINTAINER", "SmrMaintainer")
        lib.role(SITE, {groupId: ids.group}, "SMM_DEVELOPER", "SmrDeveloper")
        const first = lib.row("mantle.smithy.SmithyGroupParty", {groupId: ids.group, partyId: ec.user.userAccount.partyId})
        lib.run("delete#mantle.smithy.SmithyGroupParty", {groupId: first.groupId, partyId: first.partyId})
    }
})

feature("only an Owner sets a role on a group, and the role is held at once", {
    when() {
        return {
            before: roleOf("SMM_NEW"),
            maintainer: setGroup("SMM_MAINTAINER", "smmnew", "developer"),
            owner: setGroup("SMM_OWNER", "smmnew", "reporter"),
            after: roleOf("SMM_NEW"),
            unknown: setGroup("SMM_OWNER", "smmnobody", "guest"),
            noRole: setGroup("SMM_OWNER", "smmnew", "admin", {expectedRevision: 1}),
            stale: setGroup("SMM_OWNER", "smmnew", "developer", {expectedRevision: 7}),
            changed: setGroup("SMM_OWNER", "smmnew", "developer", {expectedRevision: 1})
        }
    },
    then({before, maintainer, owner, after, unknown, noRole, stale, changed}) {
        before == null
        maintainer.kind == "Unauthorized"
        maintainer.reason == "accessDenied"
        owner.member.handle == "smmnew"
        owner.member.role == "reporter"
        owner.member.fromPath == "smmgroup"
        owner.member.revision == 1
        after == "reporter"
        unknown.kind == "Unprocessable"
        noRole.kind == "Unprocessable"
        stale.reason == "staleRevision"
        changed.member.role == "developer"
        changed.member.revision == 2
        // no party id leaves in a member
        Object.keys(owner.member).includes("partyId") == false
    }
})

feature("a group keeps an Owner: the last one is not lowered, ended or removed, and does not leave", {
    when() {
        const last = {
            lowered: setGroup("SMM_OWNER", "smmowner", "maintainer", {expectedRevision: 1}),
            ended: setGroup("SMM_OWNER", "smmowner", "owner", {expectedRevision: 1, thruDate: "2099-01-01"}),
            removed: setGroup("SMM_OWNER", "smmowner", "", {expectedRevision: 1}),
            leave: op("SMM_OWNER", "leaveGroup", {groupId: ids.group})
        }
        // an Owner whose role has an end date is not one the group can be left to
        const dated = setGroup("SMM_OWNER", "smmguest", "owner", {thruDate: "2099-01-01"})
        const withDated = op("SMM_OWNER", "leaveGroup", {groupId: ids.group})
        setGroup("SMM_OWNER", "smmguest", "", {expectedRevision: 1})
        // with a second Owner the first may go
        const second = setGroup("SMM_OWNER", "smmsecond", "owner")
        return {
            last,
            dated,
            withDated,
            second,
            leave: op("SMM_OWNER", "leaveGroup", {groupId: ids.group}),
            gone: roleOf("SMM_OWNER"),
            again: op("SMM_SECOND", "leaveGroup", {groupId: ids.group})
        }
    },
    then({last, dated, withDated, second, leave, gone, again}) {
        dated.member.role == "owner"
        withDated.kind == "Conflict"
        last.lowered.kind == "Conflict"
        last.ended.kind == "Conflict"
        last.removed.kind == "Conflict"
        last.leave.kind == "Conflict"
        second.member.role == "owner"
        leave.left == true
        // the group is private: with no role it is Not Found
        gone == null
        again.kind == "Conflict"
    }
})

feature("an end date ends the role", {
    when() {
        const past = ec.l10n.format(new Date(ec.user.timestampMillis(ec.user.nowTimestamp) - 3600000), "yyyy-MM-dd HH:mm:ss")
        const given = setGroup("SMM_SECOND", "smmending", "developer")
        const held = roleOf("SMM_ENDING")
        const ended = setGroup("SMM_SECOND", "smmending", "developer", {expectedRevision: 1, thruDate: past})
        return {given, held, ended, after: roleOf("SMM_ENDING")}
    },
    then({given, held, ended, after}) {
        given.member.thruDate == null
        held == "developer"
        ended.member.thruDate != null
        after == null
    }
})

feature("a Maintainer reads a repository's members, an Owner sets a role on it, and a Developer does neither", {
    when() {
        const members = username => op(username, "findRepositoryMembers", {repositoryId: ids.code})
        const set = {
            developer: setRepository("SMM_DEVELOPER", "smmguest", "guest"),
            maintainer: setRepository("SMM_MAINTAINER", "smmguest", "guest"),
            owner: setRepository("SMM_SECOND", "smmguest", "guest")
        }
        return {
            set,
            held: roleOf("SMM_GUEST"),
            maintainer: members("SMM_MAINTAINER"),
            developer: members("SMM_DEVELOPER"),
            removed: setRepository("SMM_SECOND", "smmguest", "", {expectedRevision: 1}),
            after: roleOf("SMM_GUEST")
        }
    },
    then({set, held, maintainer, developer, removed, after}) {
        set.developer.reason == "accessDenied"
        set.maintainer.reason == "accessDenied"
        set.owner.member.fromPath == "smmgroup/code"
        held == "guest"
        // the repository's own rows and what its group gives, each with where the row is
        maintainer.memberList.map(member => member.handle + " " + member.role + " " + member.fromPath) ==
            [
                "smmsecond owner smmgroup",
                "smmmaintainer maintainer smmgroup",
                "smmdeveloper developer smmgroup",
                "smmnew developer smmgroup",
                "smmguest guest smmgroup/code"
            ]
        developer.kind == "Unauthorized"
        developer.reason == "accessDenied"
        removed.member.role == null
        after == null
    }
})
