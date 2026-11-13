// The clocking kiosk's identity (mantle.humanres.AttendanceServices record#KioskPunch and the badges, KioskIdentity.js; impl-people
// P30, design-people §6 ClockingKiosk, §15 the badge, PE-05): HR of the employer issues a badge with a one-time PIN or none, its
// issuer prints it once, and the worker sets their own PIN in self-service (the one-time PIN asked, never kept as theirs; HR resets a
// forgotten one), only hashes kept; a punch outside a registered device's request is refused, and at the device the worker is the
// one badge and PIN prove, of an organization of the display account's and with clocking on; a badge whose PIN the worker has not
// set is refused; a retry with the event key records once; a wrong PIN is refused and counted, and the fifth locks the badge, each
// lockout after twice as long, and the twentieth in a day stops it until HR resets its PIN, telling HR; a revoked badge is refused; a device with many refusals checks its next proof only after a pause, never shutting a worker out, and a
// burst tells the employer's HR editors once; attempts older than 90 days are pruned.
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
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
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
// the device's refusals so far moved out of the pacing window, so a feature's proofs are checked at once
const rest = () =>
    ec.entity
        .find(ATTEMPT)
        .condition("deviceId", state.deviceId)
        .disableAuthz()
        .updateAll({attemptDate: new Date(Date.now() - 11 * 60 * 1000)})
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
// a badge issued with no one-time PIN and printed by HR of A, and its worker's own PIN set in self-service: its number
function badgeOf(partyRelationshipId, worker, pin, hr = state.hr) {
    const issued = run(hr, A + "issue#KioskBadge", {partyRelationshipId})
    const number = run(hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}).numberText
    const set = run(worker, A + "set#MyKioskPin", {kioskBadgeId: issued.kioskBadgeId, newPin: pin})
    return {kioskBadgeId: issued.kioskBadgeId, number, set: set.error || "set"}
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
        // the workers' own accounts, with self-service alone
        state.anaUser = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        state.bobUser = user("BOB", ["PEOPLE_SELF_SERVICE"], state.bob)
        state.cleoUser = user("CLEO", ["PEOPLE_SELF_SERVICE"], state.cleo)
        state.benUser = user("BEN", ["PEOPLE_SELF_SERVICE"], state.ben)
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

feature(
    "a badge is issued by HR of the employer with a one-time PIN, printed once by its issuer, its PIN set by the worker alone, and kept only as hashes",
    {
        when() {
            const out = {
                otherEmployer: code(
                    run(state.hrB, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, oneTimePin: "2468"})
                ),
                shortPin: code(run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, oneTimePin: "12"}))
            }
            const issued = run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp, oneTimePin: "2468"})
            const kioskBadgeId = issued.kioskBadgeId
            out.issued = issued
            out.notIssuer = code(run(state.hr2, A + "print#KioskBadge", {kioskBadgeId}))
            out.unprinted = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp})
            out.printed = run(state.hr, A + "print#KioskBadge", {kioskBadgeId})
            out.again = code(run(state.hr, A + "print#KioskBadge", {kioskBadgeId}))
            out.pinNeeded = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp})
            out.mine = run(state.anaUser, A + "get#MyKioskBadges")
            // the PIN is Ana's to set: not HR's, not Bob's; the one-time PIN asked and never taken as hers
            out.hrSets = code(run(state.hr, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "4321"}))
            out.bobSets = code(run(state.bobUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "4321"}))
            out.bobReads = run(state.bobUser, A + "get#MyKioskBadges").badges.length
            out.noCurrent = code(run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, newPin: "4321"}))
            out.reused = code(run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "2468"}))
            out.shortNew = code(run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "1"}))
            out.set = run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "4321"})
            out.oneTimeAfter = code(run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "2468", newPin: "1234"}))
            // changed with the PIN she has
            out.changed = run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId, currentPin: "4321", newPin: "2468"})
            out.read = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp})
            out.otherReads = code(run(state.hrB, A + "get#KioskBadge", {partyRelationshipId: state.anaEmp}))
            out.row = badgeRow(kioskBadgeId)
            state.ana1 = {kioskBadgeId, number: out.printed.numberText}
            // the other workers' badges, issued with no one-time PIN
            state.bobBadge = badgeOf(state.bobEmp, state.bobUser, "1357")
            state.cleoBadge = badgeOf(state.cleoEmp, state.cleoUser, "1111")
            state.benBadge = badgeOf(state.benEmp, state.benUser, "2222", state.hrB)
            return out
        },
        then(out) {
            const {
                otherEmployer,
                shortPin,
                issued,
                notIssuer,
                unprinted,
                printed,
                again,
                pinNeeded,
                mine,
                read,
                otherReads,
                row
            } = out
            otherEmployer == "RECORD_UNAVAILABLE" && shortPin == "PIN_INVALID" && otherReads == "RECORD_UNAVAILABLE"
            issued.error == "" && issued.kioskBadgeId != null
            notIssuer == "NOT_ISSUER" && again == "PRINTED"
            unprinted.badge.state == "issued" && unprinted.badge.canPrint === true && unprinted.canIssue === true
            printed.error == "" && /^\d{4}( \d{4}){4}$/.test(printed.numberText) && printed.barcodeSvg.includes("<svg")
            printed.personName == "Kiosk ANA" && printed.organizationName == "Kiosk Spec A"
            pinNeeded.badge.state == "pinNeeded" && pinNeeded.canResetPin === true
            mine.badges.length == 1 && mine.badges[0].pinSet === false && mine.badges[0].currentPinAsked === true
            mine.badges[0].organizationName == "Kiosk Spec A"
            out.hrSets == "RECORD_UNAVAILABLE" && out.bobSets == "RECORD_UNAVAILABLE" && out.bobReads == 0
            out.noCurrent == "PIN_WRONG" && out.reused == "PIN_REUSED" && out.shortNew == "PIN_INVALID"
            out.set.error == "" && out.set.pinSet === true && out.oneTimeAfter == "PIN_WRONG"
            out.changed.error == "" && out.changed.pinSet === true
            read.badge.state == "active" && read.badge.canPrint === false && read.canRevoke === true
            // only hashes: no number, no PIN; the one-time PIN gone once hers is set
            const digits = printed.numberText.replace(/ /g, "")
            row.tokenHash != null && !String(row.tokenHash).includes(digits) && String(row.pinHash).startsWith("$argon2")
            row.oneTimePinHash == null && row.pinSetDate != null && Number(row.failedCount) == 0
            !JSON.stringify(row.getMap()).includes(digits) && !JSON.stringify(read).includes(digits)
            !JSON.stringify(mine).includes(digits)
            state.bobBadge.set == "set" && state.cleoBadge.set == "set" && state.benBadge.set == "set"
            state.bobBadge.number != null && state.cleoBadge.number != null && state.benBadge.number != null
        }
    }
)

feature("a punch outside a device's request is refused; at the device the worker is the one badge and PIN prove", {
    when() {
        return {
            // the instance administrator holds PEOPLE_KIOSK_PUNCH (ADMIN's), and no display account signs in to call it outside one
            rested: rest(),
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
        for (let i = 0; i < 4; i++) {
            rest()
            wrong.push(punch(state.bobBadge.number, "0000"))
        }
        rest()
        const fifth = punch(state.bobBadge.number, "9999")
        rest()
        const right = code(punch(state.bobBadge.number, "1357"))
        // locked, the badge's PIN cannot be guessed in self-service either
        const selfGuess = code(
            run(state.bobUser, A + "set#MyKioskPin", {
                kioskBadgeId: state.bobBadge.kioskBadgeId,
                currentPin: "1357",
                newPin: "7531"
            })
        )
        const read = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.bobEmp})
        return {wrong: wrong.map(code), fifth, right, selfGuess, read, row: badgeRow(state.bobBadge.kioskBadgeId)}
    },
    then({wrong, fifth, right, selfGuess, read, row}) {
        wrong.join(",") == "PIN_WRONG,PIN_WRONG,PIN_WRONG,PIN_WRONG"
        code(fifth) == "PIN_WRONG" && fifth.error.includes("locked for 15 minutes")
        right == "PIN_LIMITED" && selfGuess == "PIN_LIMITED"
        row.lockedUntilDate != null && read.badge.state == "locked"
        attempts({kioskBadgeId: state.bobBadge.kioskBadgeId, reasonCode: "PIN_WRONG"}) == 5
        attempts({kioskBadgeId: state.bobBadge.kioskBadgeId, reasonCode: "PIN_LIMITED"}) == 1
        ec.entity.find(PUNCH).condition("partyRelationshipId", state.bobEmp).disableAuthz().count() == 0
    }
})

feature(
    "each further lockout of a badge lasts twice as long, and the twentieth wrong PIN in a day stops it until HR resets its PIN, telling HR alone",
    {
        when() {
            const badge = state.bobBadge
            const unlock = () =>
                ec.entity
                    .find(BADGE)
                    .condition("kioskBadgeId", badge.kioskBadgeId)
                    .disableAuthz()
                    .updateAll({lockedUntilDate: new Date(Date.now() - 1000)})
            const wrong = pin => {
                rest()
                return punch(badge.number, pin)
            }
            const lockMinutes = () => Math.round((lib.ms(badgeRow(badge.kioskBadgeId).lockedUntilDate) - Date.now()) / 60000)
            const out = {}
            // the lock of the lock feature (the first, 15 minutes) passed: five more lock it for 30 minutes
            unlock()
            const second = [0, 1, 2, 3, 4].map(() => wrong("0000"))
            out.second = {codes: second.map(code).join(","), message: second[4].error, minutes: lockMinutes()}
            // passed again: four at the kiosk and one in self-service lock it for an hour
            unlock()
            const third = [0, 1, 2, 3].map(() => code(wrong("0000")))
            const selfWrong = run(state.bobUser, A + "set#MyKioskPin", {
                kioskBadgeId: badge.kioskBadgeId,
                currentPin: "0000",
                newPin: "7531"
            })
            out.third = {codes: third.join(","), self: code(selfWrong), message: selfWrong.error, minutes: lockMinutes()}
            // passed again: four more (nineteen today) leave it unlocked, and the twentieth stops it
            unlock()
            out.fourth = [0, 1, 2, 3].map(() => wrong("0000").error)
            out.twentieth = wrong("0000")
            rest()
            out.right = code(punch(badge.number, "1357"))
            out.selfRight = code(
                run(state.bobUser, A + "set#MyKioskPin", {kioskBadgeId: badge.kioskBadgeId, currentPin: "1357", newPin: "7531"})
            )
            out.read = run(state.hr, A + "get#KioskBadge", {partyRelationshipId: state.bobEmp})
            out.wrongToday = attempts({kioskBadgeId: badge.kioskBadgeId, reasonCode: "PIN_WRONG"})
            const notices = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessage")
                    .condition({topic: "PeopleKioskBadgeDisabled", recordId: state.bobEmp})
                    .disableAuthz()
                    .list()
            )
            out.notices = notices.length
            out.message = notices.length ? String(notices[0].messageJson || "") + String(notices[0].titleText || "") : ""
            out.recipients = notices.length
                ? Array.from(
                      ec.entity
                          .find("moqui.security.user.NotificationMessageUser")
                          .condition("notificationMessageId", notices[0].notificationMessageId)
                          .disableAuthz()
                          .list()
                  ).map(row => row.userId)
                : []
            // HR resets the PIN: Bob sets his again, and the wrong PINs before the reset no longer count toward the day's limit
            out.reset = run(state.hr, A + "reset#KioskPin", {kioskBadgeId: badge.kioskBadgeId})
            out.setAgain = run(state.bobUser, A + "set#MyKioskPin", {kioskBadgeId: badge.kioskBadgeId, newPin: "1357"})
            out.afterReset = wrong("0000").error
            rest()
            out.back = punch(badge.number, "1357")
            out.row = badgeRow(badge.kioskBadgeId)
            return out
        },
        then(out) {
            out.second.codes == "PIN_WRONG,PIN_WRONG,PIN_WRONG,PIN_WRONG,PIN_WRONG"
            out.second.message.includes("locked for 30 minutes") && out.second.minutes >= 29 && out.second.minutes <= 30
            out.third.codes == "PIN_WRONG,PIN_WRONG,PIN_WRONG,PIN_WRONG" && out.third.self == "PIN_WRONG"
            out.third.message.includes("locked for 1 hour") && out.third.minutes >= 59 && out.third.minutes <= 60
            out.fourth.every(error => error.includes("The PIN is not right") && !error.includes("locked"))
            code(out.twentieth) == "PIN_WRONG" && out.twentieth.error.includes("stopped until HR resets its PIN")
            out.right == "BADGE_DISABLED" && out.selfRight == "BADGE_DISABLED"
            out.read.badge.state == "disabled" && out.read.canResetPin === true && out.wrongToday == 20
            // to HR of A alone, once, naming Bob and never his number or PIN
            out.notices == 1 && out.recipients.slice().sort().join(",") == [state.hr, state.hr2].sort().join(",")
            out.message.includes("Kiosk BOB") && !out.message.includes(state.bobBadge.number.replace(/ /g, ""))
            !out.message.includes(state.bobBadge.number) && !out.message.includes("1357")
            out.reset.error == "" && out.setAgain.error == ""
            out.afterReset.includes("The PIN is not right") && !out.afterReset.includes("stopped")
            out.back.error == "" && out.back.directionEnumId == "AtdIn"
            out.row.disabledDate == null && Number(out.row.lockCount) == 0 && Number(out.row.failedCount) == 0
            out.row.pinResetDate != null
        }
    }
)

feature("a revoked badge is refused, a new one works once its PIN is set, and HR resets a forgotten PIN without learning it", {
    when() {
        rest()
        const out = {
            otherRevokes: code(run(state.hrB, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId, reason: "Lost"}))
        }
        out.revoked = run(state.hr, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId, reason: "Lost"})
        out.again = run(state.hr, A + "revoke#KioskBadge", {kioskBadgeId: state.ana1.kioskBadgeId})
        out.refused = code(punch(state.ana1.number, "2468"))
        out.revokedSet = code(
            run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId: state.ana1.kioskBadgeId, currentPin: "2468", newPin: "1111"})
        )
        // a new badge replaces Ana's (the one before it revoked): no kiosk takes it before she sets her PIN
        const issued = run(state.hr, A + "issue#KioskBadge", {partyRelationshipId: state.anaEmp})
        out.replaced = issued.replacedCount
        const number = run(state.hr, A + "print#KioskBadge", {kioskBadgeId: issued.kioskBadgeId}).numberText
        rest()
        out.notSet = code(punch(number, "8642"))
        out.set = run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId: issued.kioskBadgeId, newPin: "8642"})
        rest()
        out.newBadge = punch(number, "8642")
        // she forgets it: HR resets it with no one-time PIN, the badge stops until she sets one again, with no PIN asked
        out.otherResets = code(run(state.hrB, A + "reset#KioskPin", {kioskBadgeId: issued.kioskBadgeId}))
        out.reset = run(state.hr, A + "reset#KioskPin", {kioskBadgeId: issued.kioskBadgeId})
        rest()
        out.afterReset = code(punch(number, "8642"))
        out.setAgain = run(state.anaUser, A + "set#MyKioskPin", {kioskBadgeId: issued.kioskBadgeId, newPin: "9753"})
        rest()
        out.oldPin = code(punch(number, "8642"))
        rest()
        out.newPin = punch(number, "9753")
        state.ana2 = {kioskBadgeId: issued.kioskBadgeId, number, pin: "9753"}
        return out
    },
    then(out) {
        out.otherRevokes == "RECORD_UNAVAILABLE"
        out.revoked.error == "" && out.revoked.revoked === true && out.revoked.repeated === false && out.again.repeated === true
        out.refused == "BADGE_REVOKED" && out.revokedSet == "RECORD_UNAVAILABLE"
        out.replaced == 0
        out.notSet == "PIN_NOT_SET" && out.set.error == "" && out.newBadge.error == "" && out.newBadge.directionEnumId == "AtdIn"
        out.otherResets == "RECORD_UNAVAILABLE" && out.reset.error == "" && out.reset.reset === true
        out.afterReset == "PIN_NOT_SET" && out.setAgain.error == ""
        out.oldPin == "PIN_WRONG" && out.newPin.error == "" && out.newPin.directionEnumId == "AtdOut"
        attempts({kioskBadgeId: state.ana2.kioskBadgeId, reasonCode: "PIN_NOT_SET"}) == 2
    }
})

feature(
    "a device with many refusals checks its next proof only after a short pause, never shutting a worker out, and a burst tells the employer's HR editors once",
    {
        when() {
            rest()
            const before = attempts({deviceId: state.deviceId})
            const notices = () =>
                Array.from(
                    ec.entity
                        .find("moqui.security.user.NotificationMessage")
                        .condition({topic: "PeopleKioskRefusals", recordId: state.deviceId})
                        .disableAuthz()
                        .list()
                )
            // twenty refusals at the device this moment: the right proof waits, and is neither checked nor counted
            const refusedAt = millis => {
                for (let i = 0; i < 20; i++)
                    call("create#" + ATTEMPT, {
                        deviceId: state.deviceId,
                        attemptDate: new Date(millis),
                        reasonCode: "BADGE_UNKNOWN"
                    })
            }
            refusedAt(Date.now())
            const waited = punch(state.ana2.number, state.ana2.pin)
            const counted = attempts({deviceId: state.deviceId}) - before
            // the pause passed (the twenty a few seconds back, still within the window): the same proof is checked and recorded
            ec.entity
                .find(ATTEMPT)
                .condition("deviceId", state.deviceId)
                .disableAuthz()
                .updateAll({attemptDate: new Date(Date.now() - 6000)})
            const recorded = punch(state.ana2.number, state.ana2.pin)
            // a refusal now, in the burst, tells HR of A; another after the pause tells no one again within the hour
            const unknown = code(punch("1111 2222 3333 4444 5555", "0000"))
            const firstNotices = notices()
            ec.entity
                .find(ATTEMPT)
                .condition("deviceId", state.deviceId)
                .disableAuthz()
                .updateAll({attemptDate: new Date(Date.now() - 6000)})
            const unknownAgain = code(punch("1111 2222 3333 4444 5555", "0000"))
            const recipients = firstNotices.flatMap(notice =>
                Array.from(
                    ec.entity
                        .find("moqui.security.user.NotificationMessageUser")
                        .condition("notificationMessageId", notice.notificationMessageId)
                        .disableAuthz()
                        .list()
                ).map(row => row.userId)
            )
            return {waited, counted, recorded, unknown, unknownAgain, firstNotices, recipients, laterNotices: notices().length}
        },
        then({waited, counted, recorded, unknown, unknownAgain, firstNotices, recipients, laterNotices}) {
            code(waited) == "KIOSK_WAIT" && /try again in [1-5] seconds?/.test(waited.error) && counted == 20
            recorded.error == "" && recorded.directionEnumId == "AtdIn"
            unknown == "BADGE_UNKNOWN" && unknownAgain == "BADGE_UNKNOWN"
            firstNotices.length == 1 && laterNotices == 1
            // to HR of A alone: not B's HR, not the display account; naming the device and the count, no badge or person
            recipients.slice().sort().join(",") == [state.hr, state.hr2].sort().join(",")
            const message = String(firstNotices[0].messageJson || "") + String(firstNotices[0].titleText || "")
            message.includes("Kiosk spec door") && !message.includes("ANA") && !message.includes(state.ana2.number)
        }
    }
)

feature("refused attempts older than 90 days are pruned, newer ones kept", {
    when() {
        const day = 24 * 60 * 60 * 1000
        const old = call("create#" + ATTEMPT, {
            deviceId: state.deviceId,
            attemptDate: new Date(Date.now() - 91 * day),
            reasonCode: "BADGE_UNKNOWN"
        }).kioskAttemptId
        const kept = call("create#" + ATTEMPT, {
            deviceId: state.deviceId,
            attemptDate: new Date(Date.now() - 89 * day),
            reasonCode: "BADGE_UNKNOWN"
        }).kioskAttemptId
        const pruned = run("john.doe", A + "prune#KioskAttempts")
        return {pruned, old: attempts({kioskAttemptId: old}), kept: attempts({kioskAttemptId: kept})}
    },
    then({pruned, old, kept}) {
        pruned.error == "" && pruned.deletedCount >= 1 && pruned.failedCount == 0
        old == 0 && kept == 1
    }
})
