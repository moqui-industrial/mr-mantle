// mantle.party.PartyServices.update#Account changes the caller's own account, or any account for a holder of
// ADMIN_IDENTITY_MANAGE (plans/archive/Security-Review.md SEC-RTE-81: a screen that passed a posted userId reached another
// account's email address). A user without the permission changes their own name and is refused another account, by its
// userId or its partyId; an administrator (john.doe, ADMIN) changes another's. Authorization stays on for the calls.
// Run: ./moq test mr-mantle --spec AccountOwner
const PLAIN = "SPEC_ACCOWN_PLAIN"
const OTHER = "SPEC_ACCOWN_OTHER"

function sys(run) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return run()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
const account = userId => sys(() => ec.entity.find("moqui.security.UserAccount").condition("userId", userId).useCache(false).one())
const person = partyId => sys(() => ec.entity.find("mantle.party.Person").condition("partyId", partyId).useCache(false).one())
// update#Account as the signed-in user, authorization on: the error text, or "" when it ran
function update(parameters, service = "mantle.party.PartyServices.update#Account") {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message || error)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
function makeUser(partyId, username, email) {
    if (account(partyId)) return
    sys(() => {
        call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId, firstName: "Spec", lastName: username})
        call("create#moqui.security.UserAccount", {userId: partyId, username, partyId, emailAddress: email, userFullName: "Spec " + username,
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394", passwordHashType: "SHA"})
    })
}

spec({
    setupSpec() {
        login("john.doe")
        makeUser(PLAIN, "spec.accown.plain", "spec.accown.plain@example.com")
        makeUser(OTHER, "spec.accown.other", "spec.accown.other@example.com")
        // the service as an app's screen grants it (an inheritable allow), to both callers: the rule is the service's own
        sys(() => {
            if (ec.entity.find("moqui.security.ArtifactGroup").condition("artifactGroupId", "SPEC_ACCOWN").one()) return
            call("create#moqui.security.ArtifactGroup", {artifactGroupId: "SPEC_ACCOWN", description: "Spec update#Account"})
            call("create#moqui.security.ArtifactGroupMember", {artifactGroupId: "SPEC_ACCOWN", artifactTypeEnumId: "AT_SERVICE",
                artifactName: "mantle.party.PartyServices.update#Account", nameIsPattern: "N", inheritAuthz: "Y"})
            call("create#moqui.security.ArtifactGroupMember", {artifactGroupId: "SPEC_ACCOWN", artifactTypeEnumId: "AT_SERVICE",
                artifactName: "mantle.party.PartyServices.update#PartyUserAccount", nameIsPattern: "N", inheritAuthz: "Y"})
            call("create#moqui.security.UserGroup", {userGroupId: "SPEC_ACCOWN", description: "Spec update#Account"})
            call("create#moqui.security.ArtifactAuthz", {artifactAuthzId: "SPEC_ACCOWN", userGroupId: "SPEC_ACCOWN",
                artifactGroupId: "SPEC_ACCOWN", authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL"})
            for (const userId of [PLAIN, "EX_JOHN_DOE"])
                call("create#moqui.security.UserGroupMember", {userGroupId: "SPEC_ACCOWN", userId, fromDate: ec.user.nowTimestamp})
        })
    },
    cleanup() {
        login("john.doe")
    }
})

feature("a user without ADMIN_IDENTITY_MANAGE changes their own account and no other", {
    when() {
        login("spec.accown.plain")
        const own = update({userId: PLAIN, middleName: "Own"})
        const byUserId = update({userId: OTHER, middleName: "Stolen", emailAddress: "stolen@example.com"})
        const byPartyId = update({partyId: OTHER, middleName: "Stolen"})
        const mixed = update({userId: PLAIN, partyId: OTHER, middleName: "Stolen"})
        return {own, byUserId, byPartyId, mixed, mine: person(PLAIN), theirs: person(OTHER), theirAccount: account(OTHER)}
    },
    then({own, byUserId, byPartyId, mixed, mine, theirs, theirAccount}) {
        own == ""
        mine.middleName == "Own"
        byUserId.includes("That account is not yours")
        byPartyId.includes("That account is not yours")
        mixed.includes("That account is not yours")
        theirs.middleName == null
        theirAccount.emailAddress == "spec.accown.other@example.com"
    }
})

feature("an account administrator changes another user's account", {
    when() {
        login("john.doe")
        const error = update({userId: OTHER, middleName: "ByAdmin"})
        return {error, theirs: person(OTHER)}
    },
    then({error, theirs}) {
        error == ""
        theirs.middleName == "ByAdmin"
    }
})

// update#PartyUserAccount (Marble's Party and Customer screens) takes only partyId's own account, the caller's own unless they
// hold ADMIN_IDENTITY_MANAGE (SEC-ADM-89)
feature("update#PartyUserAccount changes only the party's own account, and another's only for an account administrator", {
    when() {
        const partyUpdate = parameters => update(parameters, "mantle.party.PartyServices.update#PartyUserAccount")
        login("spec.accown.plain")
        const own = partyUpdate({partyId: PLAIN, userId: PLAIN, requirePasswordChange: "N"})
        const other = partyUpdate({partyId: OTHER, emailAddress: "stolen@example.com"})
        const mixed = partyUpdate({partyId: PLAIN, userId: OTHER, emailAddress: "stolen@example.com"})
        login("john.doe")
        const adminMixed = partyUpdate({partyId: OTHER, userId: PLAIN, requirePasswordChange: "Y"})
        const admin = partyUpdate({partyId: OTHER, requirePasswordChange: "Y"})
        return {own, other, mixed, adminMixed, admin, theirs: account(OTHER), mine: account(PLAIN)}
    },
    then({own, other, mixed, adminMixed, admin, theirs, mine}) {
        own == ""
        other.includes("That account is not yours")
        mixed.includes("not the party's")
        adminMixed.includes("not the party's")
        admin == ""
        theirs.emailAddress == "spec.accown.other@example.com"
        theirs.requirePasswordChange == "Y"
        mine.requirePasswordChange != "Y"
    }
})
