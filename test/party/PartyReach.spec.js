// Whom a user reaches as people to message or look up (mantle.party.PartyServices.filter#VisibleParties, and
// mantle.party.CommunicationServices.create#Message for an internal message; plans/Security-Review-Medium.md SEC-BOS-98,
// SEC-BOS-99, SEC-BOS-100, the owner's decision of 2026-11-19): with authorization on, under the calling app's
// MANTLE_USER_ORG filter, a party shared by every organization (_NA_) is reached unless it is staff of an internal
// organization the user may not see; a colleague of the user's own organization is reached, a staff member of another
// organization is not, by the filter or by an internal message, which answers it as a party that does not exist. Internal
// work with authorization off is not asked. New spec, no Groovy original.
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
        call("create#moqui.security.UserGroup", {userGroupId: "PRCH_FILTERED", description: "Party reach spec"})
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: "PRCH_FILTERED", description: "Party reach spec"})
        for (const artifactName of [P + "filter#VisibleParties", C + "create#Message"])
            call("create#moqui.security.ArtifactGroupMember", {
                artifactGroupId: "PRCH_FILTERED",
                artifactTypeEnumId: "AT_SERVICE",
                artifactName,
                nameIsPattern: "N",
                inheritAuthz: "Y"
            })
        call("create#moqui.security.ArtifactAuthz", {
            artifactAuthzId: "PRCH_FILTERED",
            userGroupId: "PRCH_FILTERED",
            artifactGroupId: "PRCH_FILTERED",
            authzTypeEnumId: "AUTHZT_ALLOW",
            authzActionEnumId: "AUTHZA_ALL"
        })
        call("create#moqui.security.ArtifactAuthzFilter", {artifactAuthzId: "PRCH_FILTERED", entityFilterSetId: "MANTLE_USER_ORG"})
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
        person("Outsider", null)
        made.senderUserId = call(P + "create#PartyUserAccount", {
            partyId: made.Sender,
            emailAddress: "prch.sender." + run + "@example.com",
            username: "prch.sender." + run,
            newPassword: "moqui1!!",
            newPasswordVerify: "moqui1!!"
        }).userId
        call("create#moqui.security.UserGroupMember", {userGroupId: "PRCH_FILTERED", userId: made.senderUserId, fromDate: effectiveTime - dayMillis})
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
