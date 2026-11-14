// Smithy's name set (mr-pass plan/design-smithy.md §4.2; SmithyCore.js nameFree, nameHeld and siblingFree, through
// mantle.smithy.SmithyServices.create#Group and create#Repository, Forum's storeProfile and storeMounts): the segment
// rules; a top-level group takes no word of Smithy's, default base of an app, mount of the site or reserved path; a
// handle takes no group path and a group path no handle; a mount takes no group path or handle; a refused group's path
// is free; a group's subgroups and repositories are one set of names; and who may make a group. Spec-local site,
// accounts, groups and db repositories. Regression suite: these are rules. Run: ./moq test mr-mantle --spec SmithyNames
const lib = ec.resource.script("component://mr-mantle/test/smithy/SmithySpecLib.js")
const SITE = "SMN_SITE"
const ids = {}
const group = (pathSegment, more = {}) =>
    lib.createGroup(lib.OPERATOR, {siteId: SITE, pathSegment, visibility: "public", ...more})
const repository = (slug, more = {}) => lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: ids.group, slug, ...more})

spec({
    requires: ["git"],
    setupSpec() {
        login(lib.OPERATOR)
        lib.site(SITE)
        lib.account(SITE, "SMN_MEMBER", {handle: "smnhandle"})
        lib.account(SITE, "SMN_MODERATOR", {member: true, siteRole: "moderator"})
        lib.account(SITE, "SMN_OWNER", {member: true, siteRole: "owner"})
        lib.account(SITE, "SMN_UNCONFIRMED", {member: true, siteRole: "owner", unconfirmed: true})
        ids.group = group("smngroup").groupId
    }
})

feature("a group's segment and a repository's slug follow their rules, and a slug is stored lower case", {
    when() {
        return {
            groups: ["a", "Upper", "has.dot", "-dash"].map(name => group(name).reason),
            slugs: ["x.git", "a..b", ".hidden", "end."].map(name => repository(name).reason),
            kept: repository("Pop.Commerce", {name: "PopCommerce"})
        }
    },
    then({groups, slugs, kept}) {
        groups == ["nameInvalid", "nameInvalid", "nameInvalid", "nameInvalid"]
        slugs == ["nameInvalid", "nameInvalid", "nameInvalid", "nameInvalid"]
        kept.repositoryPath == "smngroup/pop.commerce"
        lib.row("mantle.smithy.SmithyRepository", {repositoryId: kept.repositoryId}).name == "PopCommerce"
        lib.row("moqui.resource.GitRepository", {repositoryId: kept.repositoryId}).repositoryPath == "smngroup/pop.commerce"
    }
})

feature("a top-level group takes no word of Smithy's, base of an app, mount of the site, reserved path or group path", {
    when() {
        // Smithy's own word, an app's default base that this site does not mount, a mount of the site that is no app's
        // base, a reserved path of PublicApps.js, the group that is there
        lib.make("mantle.public.PublicSiteApp", {
            siteId: SITE,
            appMountId: SITE + "_M",
            app: "members",
            pathPrefix: "/people",
            enabled: "N"
        })
        return {
            taken: ["explore", "billing", "people", "qapps", "smngroup"].map(name => group(name).reason),
            free: group("smnfree")
        }
    },
    then({taken, free}) {
        taken == ["nameTaken", "nameTaken", "nameTaken", "nameTaken", "nameTaken"]
        free.groupPath == "smnfree"
    }
})

feature("a handle takes no group path or reserved word, a group path no handle, and a mount neither", {
    when() {
        const profile = handle => lib.op("SMN_MEMBER", SITE, "storeProfile", {handle, expectedRevision: 1})
        const mount = pathPrefix =>
            lib.op(lib.OPERATOR, SITE, "storeMounts", {
                expectedRevision: 1,
                hosts: [],
                mounts: [
                    {app: "smithy", pathPrefix: "/code"},
                    {app: "forum", pathPrefix}
                ]
            })
        return {
            group: group("smnhandle"),
            asGroup: profile("smngroup"),
            asWord: profile("explore"),
            own: profile("smnhandle"),
            mounts: [mount("/smngroup"), mount("/smnhandle")]
        }
    },
    then({group, asGroup, asWord, own, mounts}) {
        group.reason == "nameTaken"
        asGroup.kind == "Conflict"
        asWord.kind == "Conflict"
        // the party's own handle stays its own
        own.kind == null
        mounts.map(out => out.kind + " " + out.reason) == ["Unprocessable nameTaken", "Unprocessable nameTaken"]
    }
})

feature("a refused group's path is free, and the next group of that path takes over its row", {
    when() {
        const first = group("smnagain")
        lib.set("mantle.smithy.SmithyGroup", {groupId: first.groupId}, {statusId: "SmgRefused", decisionReason: "No"})
        const second = lib.createGroup("SMN_OWNER", {siteId: SITE, pathSegment: "smnagain", name: "Again", visibility: "public"})
        return {first, second, row: lib.row("mantle.smithy.SmithyGroup", {groupId: first.groupId}), third: group("smnagain")}
    },
    then({first, second, row, third}) {
        second.groupId == first.groupId
        row.statusId == "SmgActive"
        row.name == "Again"
        row.decisionReason == null
        // its one Owner is who made it now
        lib.row("mantle.smithy.SmithyGroupParty", {groupId: first.groupId, partyId: "SMN_OWNER"}).roleEnumId == "SmrOwner"
        lib.row("mantle.smithy.SmithyGroupParty", {groupId: first.groupId, partyId: "EX_JOHN_DOE"}) == null
        third.reason == "nameTaken"
    }
})

feature("a group's subgroups and repositories are one set of names", {
    when() {
        const subgroup = group("shared", {parentGroupId: ids.group})
        const other = group("smnother")
        return {
            subgroup,
            repositoryAsSubgroup: repository("shared").reason,
            again: [repository("pop.commerce").reason, group("shared", {parentGroupId: ids.group}).reason],
            // the same name in another group is free
            elsewhere: lib.createRepository(lib.OPERATOR, {siteId: SITE, groupId: other.groupId, slug: "shared"}).repositoryPath
        }
    },
    then({subgroup, repositoryAsSubgroup, again, elsewhere}) {
        subgroup.groupPath == "smngroup/shared"
        repositoryAsSubgroup == "nameTaken"
        again == ["nameTaken", "nameTaken"]
        elsewhere == "smnother/shared"
    }
})

feature("a top-level group is made by the site's owner with a confirmed address, a subgroup by an Owner", {
    when() {
        const input = {siteId: SITE, pathSegment: "smnmine", visibility: "public"}
        return {
            moderator: lib.createGroup("SMN_MODERATOR", input),
            unconfirmed: lib.createGroup("SMN_UNCONFIRMED", input),
            owner: lib.createGroup("SMN_OWNER", input),
            subgroup: lib.createGroup("SMN_MEMBER", {...input, parentGroupId: ids.group}),
            bind: lib.service("SMN_OWNER", "mantle.smithy.SmithyServices.bind#Repository", {
                siteId: SITE,
                repositoryId: "x",
                groupId: ids.group
            })
        }
    },
    then({moderator, unconfirmed, owner, subgroup, bind}) {
        moderator.reason == "accessDenied"
        unconfirmed.reason == "addressUnconfirmed"
        owner.groupPath == "smnmine"
        subgroup.reason == "accessDenied"
        // only an operator binds a repository that is there
        bind.reason == "accessDenied"
    }
})
