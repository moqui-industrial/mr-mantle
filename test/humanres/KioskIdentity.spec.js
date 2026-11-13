// The clocking kiosk's identity (mantle.humanres.AttendanceServices record#KioskPunch and the badges, KioskIdentity.js; impl-people
// P30, design-people §6 ClockingKiosk, §15 the badge, PE-05): HR of the employer issues a badge with the worker's PIN, its issuer
// prints it once and only hashes are kept; a punch outside a registered device's request is refused, and at the device the worker is
// the one badge and PIN prove, of an organization of the display account's and with clocking on; a retry with the event key records
// once; a wrong PIN is refused and counted, and the fifth locks the badge; a revoked badge is refused; a device with many refusals
// refuses every proof for a while.
// Standalone: spec-local organizations, people, employments, users, a display account and its group, a route group admitting the
// spec's own screen (KioskSpecScreen.xml) and a device registered and redeemed for it; the device's requests are screen renders with
// its cookie. Artifact authorization is off: the rules are the services' own checks.
// Run: ./moq test mr-mantle --spec KioskIdentity
const prefix = "PPL_KIOSK_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const A = "mantle.humanres.AttendanceServices."
const BADGE = "mantle.humanres.attendance.KioskBadge"
const ATTEMPT = "mantle.humanres.attendance.KioskAttempt"
const PUNCH = "mantle.humanres.attendance.AttendancePunch"
const screen = "component://mr-mantle/test/humanres/KioskSpecScreen.xml"
const state = {}

function run(username, service, parameters = {}) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
// a punch at the device: its request, with its cookie, to the spec's screen the route group admits
function punch(badgeText, pin, extra = {}) {
    const rendered = ec.screen
        .makeTest()
        .rootScreen(screen)
        .header("cookie", "moqui.device=" + state.cookie)
        .render("punch", Object.assign({badgeText, pin}, extra), "post")
    ec.message.clearErrors()
    const answer = JSON.parse(String(rendered.output || "{}"))
    return Object.assign({}, answer.out, {error: answer.error || "", userId: answer.userId})
}
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    call("create#mantle.party.PartySetting", {partyId, partySettingTypeId: "PeopleClocking", settingValue: "Y"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Kiosk", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function group(id, permissions) {
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Kiosk spec " + id})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
}
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    group(id, permissions)
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// a badge issued with its PIN and printed by HR of A: its number
function badgeOf(partyRelationshipId, pin, hr = state.hr) {
    const issued = run(hr, A + "issue#KioskBadge", {partyRelationshipId, pin})
    return {
        kioskBadgeId: issued.kioskBadgeId,
        number: run(hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}).numberText
    }
}
const badgeRow = kioskBadgeId => ec.entity.find(BADGE).condition("kioskBadgeId", kioskBadgeId).disableAuthz().one()
const attempts = conditions => ec.entity.find(ATTEMPT).condition(conditions).disableAuthz().count()

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        // A and B both clock by default; Ana, Bob and Cleo work for A (Cleo set apart: she does not clock), Ben for B
        organization(orgA, "Kiosk Spec A")
        organization(orgB, "Kiosk Spec B")
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.bob = person("BOB")
        state.bobEmp = employ(state.bob, orgA)
        state.cleo = person("CLEO")
        state.cleoEmp = employ(state.cleo, orgA)
        call("update#mantle.humanres.employment.Employment", {partyRelationshipId: state.cleoEmp, clockingEnabled: "N"})
        state.ben = person("BEN")
        state.benEmp = employ(state.ben, orgB)
        state.hrParty = person("HR")
        employ(state.hrParty, orgA)
        state.hrBParty = person("HRB")
        employ(state.hrBParty, orgB)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.hr2 = user("HR2", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrBParty)
        // the clocking device's display account: a member of A, in a registered bundle holding PEOPLE_KIOSK_PUNCH alone
        state.displayParty = person("DISPLAY")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtMember",
            fromPartyId: state.displayParty,
            toPartyId: orgA,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        state.display = prefix + "_DISPLAY"
        group(state.display, ["PEOPLE_KIOSK_PUNCH"])
        call("create#moqui.security.CapabilityBundle", {
            userGroupId: state.display,
            appName: "People",
            description: "Kiosk spec clock"
        })
        call("create#moqui.security.UserAccount", {
            userId: state.display,
            username: "kiosk.spec.display",
            userFullName: "Kiosk spec clock",
            partyId: state.displayParty,
            displayAccount: "Y"
        })
        call("create#moqui.security.UserGroupMember", {userId: state.display, userGroupId: state.display, fromDate: since})
        // its route group: the spec's screen and its punch transition
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: prefix, description: "Kiosk spec clock"})
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: prefix,
            artifactTypeEnumId: "AT_XML_SCREEN",
            artifactName: screen,
            inheritAuthz: "N",
            nameIsPattern: "N"
        })
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: prefix,
            artifactTypeEnumId: "AT_XML_SCREEN_TRANS",
            artifactName: screen + "/punch",
            inheritAuthz: "N",
            nameIsPattern: "N"
        })
        call("create#moqui.security.DeviceRouteGroup", {
            routeGroupId: prefix,
            description: "Kiosk spec clocks",
            artifactGroupId: prefix,
            homePath: "/apps/AppList"
        })
        const registered = ec.service
            .sync()
            .name("org.moqui.admin.DeviceServices.register#Device")
            .parameters({deviceName: "Kiosk spec door", routeGroupId: prefix, displayUserId: state.display})
            .call()
        ec.message.clearErrors()
        state.deviceId = registered?.deviceId
        const redeemed = ec.screen
            .makeTest()
            .rootScreen("component://webroot/screen/webroot.xml")
            .render("Device/redeem", {code: registered?.registrationCode}, "post")
        state.cookie = String(redeemed.header("Set-Cookie") || "")
            .split(";")[0]
            .replace("moqui.device=", "")
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        ec.entity.find("moqui.security.DeviceCredential").condition("displayUserId", state.display).disableAuthz().deleteAll()
        ec.entity.find("moqui.security.DeviceRouteGroup").condition("routeGroupId", prefix).disableAuthz().deleteAll()
    }
})

feature("a badge is issued by HR of the employer with the worker's PIN, printed once by its issuer, and kept only as hashes", {
    when() {
        const out = {
            otherEmployer: code(run(state.hrB, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, pin: "2468"})),
            shortPin: code(run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, pin: "12"}))
        }
        const issued = run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, pin: "2468"})
        out.issued = issued
        out.notIssuer = code(run(state.hr2, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}))
        out.unprinted = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp})
        out.printed = run(state.hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId})
        out.again = code(run(state.hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}))
        out.read = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp})
        out.otherReads = code(run(state.hrB, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp}))
        out.row = badgeRow(issued.kioskBadgeId)
        state.ana1 = {kioskBadgeId: issued.kioskBadgeId, number: out.printed.numberText}
        // the other workers' badges
        state.bobBadge = badgeOf(state.bobEmp, "1357")
        state.cleoBadge = badgeOf(state.cleoEmp, "1111")
        state.benBadge = badgeOf(state.benEmp, "2222", state.hrB)
        return out
    },
    then({otherEmployer, shortPin, issued, notIssuer, unprinted, printed, again, read, otherReads, row}) {
        otherEmployer == "RECORD_UNAVAILABLE" && shortPin == "PIN_INVALID" && otherReads == "RECORD_UNAVAILABLE"
        issued.error == "" && issued.kioskBadgeId != null
        notIssuer == "NOT_ISSUER" && again == "PRINTED"
        unprinted.badge.state == "issued" && unprinted.badge.canPrint === true && unprinted.canIssue === true
        printed.error == "" && /^\d{4}( \d{4}){4}$/.test(printed.numberText) && printed.barcodeSvg.includes("<svg")
        printed.personName == "Kiosk ANA" && printed.organizationName == "Kiosk Spec A"
        read.badge.state == "active" && read.badge.canPrint === false && read.canRevoke === true
        // only hashes: no number, no PIN
        const digits = printed.numberText.replace(/ /g, "")
        row.tokenHash != null && !String(row.tokenHash).includes(digits) && String(row.pinHash).startsWith("$argon2")
        !JSON.stringify(row.getMap()).includes(digits) && !JSON.stringify(read).includes(digits)
        state.bobBadge.number != null && state.cleoBadge.number != null && state.benBadge.number != null
    }
})

feature("a punch outside a device's request is refused; at the device the worker is the one badge and PIN prove", {
    when() {
        return {
            // the instance administrator holds PEOPLE_KIOSK_PUNCH (ADMIN's), and no display account signs in to call it outside one
            adminDirect: code(run("john.doe", A + "record#KioskPunch", {badgeText: state.ana1.number, pin: "2468"})),
            hrDirect: code(run(state.hr, A + "record#KioskPunch", {badgeText: state.ana1.number, pin: "2468"})),
            anaIn: punch(state.ana1.number, "2468", {operationKey: "ana-1"}),
            unknown: code(punch("1234 5678 9012 3456 7890", "2468")),
            otherEmployer: code(punch(state.benBadge.number, "2222")),
            clockingOff: code(punch(state.cleoBadge.number, "1111")),
            anaInAgain: code(punch(state.ana1.number, "2468", {directionEnumId: "AtdIn"}))
        }
    },
    then({adminDirect, hrDirect, anaIn, unknown, otherEmployer, clockingOff, anaInAgain}) {
        adminDirect == "DEVICE_REQUIRED" && hrDirect == "DEVICE_REQUIRED"
        anaIn.error == "" && anaIn.directionEnumId == "AtdIn" && anaIn.personName == "Kiosk ANA" && anaIn.repeated === false
        // the device's request ran as its display account
        anaIn.userId == state.display
        const row = ec.entity.find(PUNCH).condition("attendancePunchId", anaIn.attendancePunchId).disableAuthz().one()
        row.sourceEnumId == "AtsKiosk" && row.deviceId == state.deviceId && row.kioskBadgeId == state.ana1.kioskBadgeId
        row.partyRelationshipId == state.anaEmp && row.recordedByUserId == state.display && row.sourceSystem == "Kiosk spec door"
        unknown == "BADGE_UNKNOWN" && otherEmployer == "ORGANIZATION_DENIED" && clockingOff == "CLOCKING_OFF"
        anaInAgain == "ALREADY_IN"
        attempts({deviceId: state.deviceId, reasonCode: "BADGE_UNKNOWN"}) == 1
        attempts({deviceId: state.deviceId, reasonCode: "ORGANIZATION_DENIED"}) == 1
    }
})

feature("a retry with the event key records once", {
    when() {
        const out = punch(state.ana1.number, "2468", {operationKey: "ana-2"})
        const retry = punch(state.ana1.number, "2468", {operationKey: "ana-2"})
        // the same key with another worker's proof records nothing for them
        const bobWithKey = code(punch(state.bobBadge.number, "1357", {operationKey: "ana-2"}))
        return {out, retry, bobWithKey}
    },
    then({out, retry, bobWithKey}) {
        out.error == "" && out.directionEnumId == "AtdOut" && out.repeated === false
        retry.error == "" && retry.repeated === true && retry.attendancePunchId == out.attendancePunchId
        bobWithKey == "OPERATION_KEY_USED"
        ec.entity.find(PUNCH).condition("partyRelationshipId", state.anaEmp).disableAuthz().count() == 2
        ec.entity.find(PUNCH).condition("partyRelationshipId", state.bobEmp).disableAuthz().count() == 0
    }
})

feature("a wrong PIN is refused and counted, and the fifth in a row locks the badge", {
    when() {
        const wrong = []
        for (let i = 0; i < 4; i++) wrong.push(punch(state.bobBadge.number, "0000"))
        const fifth = punch(state.bobBadge.number, "9999")
        const right = code(punch(state.bobBadge.number, "1357"))
        const read = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.bobEmp})
        return {wrong: wrong.map(code), fifth, right, read, row: badgeRow(state.bobBadge.kioskBadgeId)}
    },
    then({wrong, fifth, right, read, row}) {
        wrong.join(",") == "PIN_WRONG,PIN_WRONG,PIN_WRONG,PIN_WRONG"
        code(fifth) == "PIN_WRONG" && fifth.error.includes("locked for 15 minutes")
        right == "PIN_LIMITED"
        row.lockedUntilDate != null && read.badge.state == "locked"
        attempts({kioskBadgeId: state.bobBadge.kioskBadgeId, reasonCode: "PIN_WRONG"}) == 5
        attempts({kioskBadgeId: state.bobBadge.kioskBadgeId, reasonCode: "PIN_LIMITED"}) == 1
        ec.entity.find(PUNCH).condition("partyRelationshipId", state.bobEmp).disableAuthz().count() == 0
    }
})

feature("a revoked badge is refused, and a device with many refusals refuses every proof for a while", {
    when() {
        const out = {
            otherRevokes: code(run(state.hrB, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId, reason: "Lost"}))
        }
        out.revoked = run(state.hr, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId, reason: "Lost"})
        out.again = run(state.hr, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId})
        out.refused = code(punch(state.ana1.number, "2468"))
        // a new badge replaces Ana's (the one before it revoked) and works
        const issued = run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, pin: "8642"})
        out.replaced = issued.replacedCount
        const number = run(state.hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}).numberText
        out.newBadge = punch(number, "8642")
        // enough refusals at the device within ten minutes: the right proof is refused too
        for (let i = 0; i < 20; i++)
            call("create#" + ATTEMPT, {deviceId: state.deviceId, attemptDate: ec.user.nowTimestamp, reasonCode: "BADGE_UNKNOWN"})
        out.limited = code(punch(number, "8642"))
        return out
    },
    then({otherRevokes, revoked, again, refused, replaced, newBadge, limited}) {
        otherRevokes == "RECORD_UNAVAILABLE"
        revoked.error == "" && revoked.revoked === true && revoked.repeated === false && again.repeated === true
        refused == "BADGE_REVOKED"
        replaced == 0
        newBadge.error == "" && newBadge.directionEnumId == "AtdIn"
        limited == "KIOSK_LIMITED"
    }
})
