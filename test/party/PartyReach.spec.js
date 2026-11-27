// Whom a user reaches as people to message or look up (mantle.party.PartyServices.filter#VisibleParties, and
// mantle.party.CommunicationServices.create#Message for an internal message; plans/Security-Review-Medium.md SEC-BOS-98,
// SEC-BOS-99, SEC-BOS-100, the owner's decision of 2026-11-19): with authorization on, under the calling app's
// MANTLE_USER_ORG filter, a party shared by every organization (_NA_) is reached unless it is staff of an internal
// organization the user may not see; a colleague of the user's own organization is reached, a staff member of another
// organization is not, by the filter or by an internal message, which answers it as a party that does not exist. Internal
// work with authorization off is not asked. A reply keeps its thread's people: a reply all reaches a participant the replier
// could not message anew, and still not a party the replier adds. A department reaches its parent's and its sibling
// departments' staff (they share a top-level organization), never another top-level organization's. New spec, no Groovy
// original.
// Run: ./moq test mr-mantle --spec PartyReach
const dayMillis = 86400000
const effectiveTime = Date.now()
const run = String(effectiveTime).slice(-7)
const P = "mantle.party.PartyServices."
const C = "mantle.party.CommunicationServices."
const made = {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

function result(name, params) {
    try {
        const out =
            ec.service
                .sync()
                .name(name)
                .parameters(params || {})
                .call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message)}
    }
}
// as the sender with authorization on, as an app screen would call: the user's organizations in the user context, the
// services authorized by PRCH_FILTERED and its MANTLE_USER_ORG filter set
function filteredAs(username, action) {
    login(username, "moqui1!!")
    call(P + "setup#UserOrganizationInfo", {})
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.artifactExecution.disableAuthz()
        for (const name of ["userOrgIds", "filterOrgIds", "activeOrgId"]) delete ec.user.context[name]
        login("john.doe")
    }
}

feature("two internal organizations owning themselves, a sender and a colleague of one, a shared staff member of the other, a shared outsider", {
    when() {
        const org = name => {
            const partyId = call(P + "create#Organization", {organizationName: name + " " + run, roleTypeId: "OrgInternal"}).partyId
            call("update#mantle.party.Party", {partyId, ownerPartyId: partyId})
            return partyId
        }
        made.own = org("Reach Own")
        made.other = org("Reach Other")
        // the authz rows once: a run after another finds them
        const once = (entityName, fields) => {
            if (ec.entity.find(entityName).condition(fields).count() == 0) call("create#" + entityName, fields)
        }
        once("moqui.security.UserGroup", {userGroupId: "PRCH_FILTERED", description: "Party reach spec"})
        once("moqui.security.ArtifactGroup", {artifactGroupId: "PRCH_FILTERED", description: "Party reach spec"})
        for (const artifactName of [P + "filter#VisibleParties", C + "create#Message", C + "reply#CommunicationEvent"])
            once("moqui.security.ArtifactGroupMember", {
                artifactGroupId: "PRCH_FILTERED",
                artifactTypeEnumId: "AT_SERVICE",
                artifactName,
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
        once("moqui.security.ArtifactAuthz", {
            artifactAuthzId: "PRCH_FILTERED",
            userGroupId: "PRCH_FILTERED",
            artifactGroupId: "PRCH_FILTERED",
            authzTypeEnumId: "AUTHZT_ALLOW",
            authzActionEnumId: "AUTHZA_ALL"
        })
        once("moqui.security.ArtifactAuthzFilter", {artifactAuthzId: "PRCH_FILTERED", entityFilterSetId: "MANTLE_USER_ORG"})
        // every person's party is shared (_NA_, the default): only employment tells the staff apart
        const person = (key, employer) => {
            made[key] = call(P + "create#Person", {firstName: key, lastName: "Reach"}).partyId
            if (employer)
                call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: made[key],
                    toPartyId: employer,
                    toRoleTypeId: "OrgInternal",
                    fromDate: effectiveTime - dayMillis
                })
        }
        person("Sender", made.own)
        person("Colleague", made.own)
        person("Staff", made.other)
        person("Staff2", made.other)
        person("Outsider", null)
        // a top-level organization with two departments (PrtOrgRollup, child to parent), and another top-level one
        made.top = org("Reach Top")
        made.another = org("Reach Another")
        const department = (name) => {
            const partyId = call(P + "create#Organization", {organizationName: name + " " + run, roleTypeId: "OrgDepartment"}).partyId
            call("update#mantle.party.Party", {partyId, ownerPartyId: made.top})
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtOrgRollup",
                fromPartyId: partyId,
                toPartyId: made.top,
                fromDate: effectiveTime - dayMillis
            })
            return partyId
        }
        made.deptOne = department("Reach Dept One")
        made.deptTwo = department("Reach Dept Two")
        person("DeptSender", made.deptOne)
        person("Sibling", made.deptTwo)
        person("TopStaff", made.top)
        person("AnotherStaff", made.another)
        const account = (key) => {
            const userId = call(P + "create#PartyUserAccount", {
                partyId: made[key],
                emailAddress: "prch." + key.toLowerCase() + "." + run + "@example.com",
                username: "prch." + key.toLowerCase() + "." + run,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            call("create#moqui.security.UserGroupMember", {userGroupId: "PRCH_FILTERED", userId, fromDate: effectiveTime - dayMillis})
            return userId
        }
        made.senderUserId = account("Sender")
        account("DeptSender")
        return {owner: ec.entity.find("mantle.party.Party").condition("partyId", made.Staff).one().ownerPartyId}
    },
    then({owner}) {
        owner == "_NA_"
    }
})

feature("the sender reaches the colleague and the outsider, not the other organization's staff; an internal message to it is not found", {
    when() {
        const ids = [made.Colleague, made.Staff, made.Outsider]
        const filtered = filteredAs("prch.sender." + run, () => ({
            visible: result(P + "filter#VisibleParties", {partyIdList: ids}).visiblePartyIdList || [],
            toStaff: result(C + "create#Message", {toPartyId: made.Staff, subject: "Reach " + run, body: "<p>x</p>"}),
            toColleague: result(C + "create#Message", {toPartyId: made.Colleague, subject: "Reach " + run, body: "<p>x</p>"})
        }))
        const internal = result(P + "filter#VisibleParties", {partyIdList: ids}).visiblePartyIdList || []
        const staffRows = ec.entity.find("mantle.party.communication.CommunicationEventParty").condition("partyId", made.Staff).count()
        return Object.assign(filtered, {internal, staffRows})
    },
    then({visible, toStaff, toColleague, internal, staffRows}) {
        visible == [made.Colleague, made.Outsider]
        toStaff.error.includes("not found")
        toColleague.error == "" && toColleague.communicationEventId != null
        staffRows == 0
        // internal work, authorization off, is not asked
        internal == [made.Colleague, made.Staff, made.Outsider]
    }
})

feature("a reply all reaches the thread's participant outside the replier's reach; a party the replier adds is still asked", {
    when() {
        // the other organization's staff member wrote to the sender and the colleague (internal work, authorization off)
        const parent = call(C + "create#Message", {fromPartyId: made.Staff, toPartyIdList: [made.Sender, made.Colleague], subject: "Thread " + run,
            body: "<p>x</p>"}).communicationEventId
        return filteredAs("prch.sender." + run, () => {
            const replyAll = result(C + "reply#CommunicationEvent", {parentCommEventId: parent, subject: "Re: Thread " + run, body: "<p>y</p>"})
            const added = result(C + "reply#CommunicationEvent", {parentCommEventId: parent, subject: "Re: Thread " + run, body: "<p>z</p>",
                toPartyIdList: [made.Staff2]})
            const rows = replyAll.communicationEventId ? Array.from(ec.entity.find("mantle.party.communication.CommunicationEventParty")
                .condition("communicationEventId", replyAll.communicationEventId).disableAuthz().list()).map(row => row.partyId) : []
            return {replyAll, added, rows}
        })
    },
    then({replyAll, added, rows}) {
        replyAll.error == "" && replyAll.communicationEventId != null
        rows.includes(made.Staff) && rows.includes(made.Colleague)
        added.error.includes("not found")
    }
})

feature("a department's employee reaches its parent's and a sibling department's staff, not another top-level organization's", {
    when() {
        return filteredAs("prch.deptsender." + run, () => ({
            visible: result(P + "filter#VisibleParties", {partyIdList: [made.Sibling, made.TopStaff, made.AnotherStaff]}).visiblePartyIdList || []
        }))
    },
    then({visible}) {
        visible == [made.Sibling, made.TopStaff]
    }
})

// SEC-DAT-88: with filterOrgIds unset a filter map's equality on it is IS NULL, which shows the rows of no organization; every
// organization filter map names it as filterOrgIds || [] (an empty list matches none), and setup#UserOrganizationInfo sets
// an empty list for an account with no party
feature("an organization filter with no organizations matches no rows, and an account with no party has none", {
    when() {
        const bare = Array.from(
            ec.entity.find("moqui.security.EntityFilter").condition("entityFilterSetId", "in", ["MANTLE_USER_ORG", "MANTLE_ACTIVE_ORG"]).list()
        )
            .filter(row => /(^|[^\w.])filterOrgIds(?!\s*\|\|)/.test(String(row.filterMap || "")))
            .map(row => row.entityFilterId)
        const username = "reach.noparty." + run
        ec.service
            .sync()
            .name("create#moqui.security.UserAccount")
            .parameters({userId: "REACH_NOPARTY_" + run, username, currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA"})
            .call()
        login(username)
        ec.user.context.filterOrgIds = null
        ec.service.sync().name(P + "setup#UserOrganizationInfo").call()
        const filterOrgIds = ec.user.context.filterOrgIds
        login("john.doe")
        return {bare, filterOrgIds}
    },
    then({bare, filterOrgIds}) {
        bare == []
        Array.isArray(filterOrgIds) && filterOrgIds.length == 0
    }
})
