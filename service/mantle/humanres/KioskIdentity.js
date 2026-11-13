// The clocking kiosk's identity (mantle.humanres.AttendanceServices issue#KioskBadge, print#KioskBadge, revoke#KioskBadge,
// get#KioskBadge and resolve#KioskBadge, and the proof record#KioskPunch asks of a worker; IronStone People design §6 ClockingKiosk,
// §15 the badge, PE-05; impl-people P30).
//
// A kiosk is a registered shared device (the framework's device credential, mr-moqui docs/security/Shared-Devices.md): its
// requests run as its display account, a UserAccount nothing signs in, whose party is a member of the employer it serves. The
// worker is never the request's user: each punch names them by a badge and a PIN.
// - A badge (KioskBadge) belongs to an employment. An HR editor of the employer issues it with the worker's PIN (4 to 8 digits,
//   kept only as its argon2 hash), which revokes the employment's badge before it. Its number (20 random digits, about 66 bits) is
//   made when its issuer prints it, once, within fifteen minutes of the issue, and kept only as its single-use hash, so no one can
//   read it again: a lost badge is revoked and another issued. The number is printed as a Code 128 barcode with the digits beside
//   it, for a scanner or for typing.
// - At a kiosk the proof is checked in this order: the request is a registered device's whose display account is the user, and
//   holds PEOPLE_KIOSK_PUNCH; the device has not had too many refusals lately (KIOSK_LIMITED); the badge's number is known
//   (BADGE_UNKNOWN), not revoked (BADGE_REVOKED) and not locked (PIN_LIMITED); the PIN is right (PIN_WRONG: counted on the badge,
//   and the fifth in a row locks it for fifteen minutes); the employment is current (EMPLOYMENT_ENDED) and with an organization of
//   the display account's (ORGANIZATION_DENIED). Every refusal of a proof is a KioskAttempt of the device, written in a
//   transaction of its own, so it counts although nothing else is kept; a right PIN clears the badge's count the same way.
// - The scan resolver answers the scanned text as the badge read, looking nothing up, so a scan learns nothing of whom a number
//   belongs to: the worker is named only once badge and PIN prove them.
// Who: an HR editor of the employer (PEOPLE_HR_VIEW and PEOPLE_HR_EDIT) issues, revokes and reads a badge's state; only its issuer
// prints it; a device's display account with PEOPLE_KIOSK_PUNCH proves a worker. Missing and unauthorized records are refused alike
// (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied, call} = lib

const BADGE = "mantle.humanres.attendance.KioskBadge"
const ATTEMPT = "mantle.humanres.attendance.KioskAttempt"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const DEVICE = "moqui.security.DeviceCredential"

const minuteMs = 60 * 1000
// a badge is printed by its issuer within this long of its issue
const printMs = 15 * minuteMs
// wrong PINs in a row that lock a badge, and for how long
const maxWrongPins = 5
const lockMs = 15 * minuteMs
// refusals at one device within the window that make it refuse every proof until the window passes
const deviceWindowMs = 10 * minuteMs
const deviceMaxRefusals = 20

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const text = value => String(value ?? "").trim()
const first = query => Array.from(query.limit(1).list())[0] || null
const timeText = millis => ec.l10n.format(new Date(Number(millis)), "HH:mm")
const dateTimeText = value => (value ? ec.l10n.format(value, "yyyy-MM-dd HH:mm") : "")

// ===== the badge's number and PIN =====
// 20 random digits; a typed number may be grouped with spaces or dashes
const newNumber = () => ec.user.randomCode(8) + ec.user.randomCode(8) + ec.user.randomCode(4)
const digitsOf = value => text(value).replace(/[\s-]/g, "")
const numberText = digits => digits.replace(/(\d{4})(?=\d)/g, "$1 ")
const tokenHash = digits => ec.user.singleUseCodeHash(digits)
const validPin = pin => /^\d{4,8}$/.test(text(pin))

// ===== HR =====
const employmentRow = partyRelationshipId =>
    partyRelationshipId ? one(RELATIONSHIP, {partyRelationshipId, relationshipTypeEnumId: "PrtEmployee"}) : null
const currentAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
// The employment as an HR reader of its employer reads it (edit: an HR editor), else refused as missing.
function hrEmployment(partyRelationshipId, edit) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    const employment = employmentRow(text(partyRelationshipId))
    const admitted =
        employment && caps.hrView && (!edit || caps.hrEdit) && userScope.organizationPartyIds.includes(employment.toPartyId)
    if (!admitted) denied("RECORD_UNAVAILABLE", "Employment " + text(partyRelationshipId) + " is not available")
    return {employment, canEdit: !!caps.hrEdit}
}
function hrBadge(kioskBadgeId, edit) {
    const badge = text(kioskBadgeId) ? one(BADGE, {kioskBadgeId: text(kioskBadgeId)}) : null
    if (!badge) denied("RECORD_UNAVAILABLE", "Badge " + text(kioskBadgeId) + " is not available")
    hrEmployment(badge.partyRelationshipId, edit)
    return badge
}
const printable = (badge, at) =>
    !badge.revokedDate && !badge.tokenHash && badge.issuedByUserId === ec.user.userId && at - ms(badge.issuedDate) <= printMs
function badgeState(badge, at) {
    if (badge.revokedDate) return {state: "revoked", stateText: "Revoked " + dateTimeText(badge.revokedDate)}
    if (!badge.tokenHash)
        return at - ms(badge.issuedDate) <= printMs
            ? {state: "issued", stateText: "Issued, not printed yet"}
            : {state: "unprinted", stateText: "Not printed in time: issue a new badge"}
    if (ms(badge.lockedUntilDate) > at)
        return {state: "locked", stateText: "Locked after wrong PINs until " + timeText(ms(badge.lockedUntilDate))}
    return {state: "active", stateText: "Active"}
}
const badgeLine = (badge, at) =>
    Object.assign(
        {
            kioskBadgeId: badge.kioskBadgeId,
            partyRelationshipId: badge.partyRelationshipId,
            issuedDateText: dateTimeText(badge.issuedDate),
            printedDateText: dateTimeText(badge.printedDate),
            lastUsedText: dateTimeText(badge.lastUsedDate),
            canPrint: printable(badge, at)
        },
        badgeState(badge, at)
    )

// issue#KioskBadge: a new badge of an employment, by an HR editor of the employer, with the worker's PIN; the employment's badge
// before it is revoked. Its number is made when it is printed.
function issueBadge(p) {
    const {employment} = hrEmployment(p.partyRelationshipId, true)
    const at = nowMs()
    if (!currentAt(employment, at)) denied("EMPLOYMENT_ENDED", "A badge is issued only for a current employment")
    if (!validPin(p.pin)) denied("PIN_INVALID", "The PIN is 4 to 8 digits")
    const replaced = Array.from(
        find(BADGE)
            .condition("partyRelationshipId", employment.partyRelationshipId)
            .condition("revokedDate", "is-null", null)
            .list()
    )
    for (const badge of replaced)
        call("update#" + BADGE, {
            kioskBadgeId: badge.kioskBadgeId,
            revokedDate: ec.user.nowTimestamp,
            revokedByUserId: ec.user.userId,
            revokeReason: "Replaced by a new badge"
        })
    const created = call("create#" + BADGE, {
        partyRelationshipId: employment.partyRelationshipId,
        partyId: employment.fromPartyId,
        organizationPartyId: employment.toPartyId,
        pinHash: ec.user.hashPassword(text(p.pin)),
        issuedByUserId: ec.user.userId,
        issuedDate: ec.user.nowTimestamp,
        failedCount: 0
    })
    return {kioskBadgeId: created.kioskBadgeId, replacedCount: replaced.length}
}
// print#KioskBadge: the badge's number made now and printed, once, by its issuer within fifteen minutes of the issue: its barcode
// and the digits, the person and the employer. Kept only as its hash, so a later print is refused (PRINTED) and a lost badge is
// replaced.
function printBadge(p) {
    const badge = hrBadge(p.kioskBadgeId, true)
    const at = nowMs()
    if (badge.revokedDate) denied("BADGE_REVOKED", "This badge was revoked")
    if (badge.tokenHash) denied("PRINTED", "This badge was printed already: issue a new one to print another")
    if (badge.issuedByUserId !== ec.user.userId) denied("NOT_ISSUER", "Only who issued a badge prints it")
    if (at - ms(badge.issuedDate) > printMs)
        denied("PRINT_EXPIRED", "A badge is printed within 15 minutes of its issue: issue a new one")
    let digits = newNumber()
    // a number another badge has (about one in 10^20) is made again
    for (let tries = 0; find(BADGE, {tokenHash: tokenHash(digits)}).count() > 0 && tries < 3; tries++) digits = newNumber()
    // the write holds only while the badge is unprinted, so two prints at once print one number
    const written = find(BADGE, {kioskBadgeId: badge.kioskBadgeId})
        .condition("tokenHash", "is-null", null)
        .updateAll({tokenHash: tokenHash(digits), printedDate: ec.user.nowTimestamp})
    if (!written) denied("PRINTED", "This badge was printed already: issue a new one to print another")
    const personName = people.personNames([badge.partyId])[badge.partyId] || badge.partyId
    const organizationName =
        people.organizationNames([badge.organizationPartyId])[badge.organizationPartyId] || badge.organizationPartyId
    return {
        personName,
        organizationName,
        numberText: numberText(digits),
        barcodeSvg: ec.resource.barcodeSvg("Code128", digits, {height: "12mm", moduleWidth: "0.3mm", humanReadable: false}),
        issuedDateText: dateTimeText(badge.issuedDate)
    }
}
// revoke#KioskBadge: an HR editor of the employer revokes a badge, with a reason; a revoked one answers as it is.
function revokeBadge(p) {
    const badge = hrBadge(p.kioskBadgeId, true)
    if (badge.revokedDate) return {revoked: true, repeated: true}
    call("update#" + BADGE, {
        kioskBadgeId: badge.kioskBadgeId,
        revokedDate: ec.user.nowTimestamp,
        revokedByUserId: ec.user.userId,
        revokeReason: text(p.reason).slice(0, 255) || null
    })
    return {revoked: true, repeated: false}
}
// get#KioskBadge: an employment's badge as an HR reader of the employer reads it (never its number or PIN): the one in use (else the
// last revoked) with its state, whether the reader prints it now, and whether they issue and revoke badges.
function getBadge(p) {
    const {employment, canEdit} = hrEmployment(p.partyRelationshipId, false)
    const at = nowMs()
    const latest = first(find(BADGE, {partyRelationshipId: employment.partyRelationshipId}).orderBy("-issuedDate"))
    return {
        badge: latest ? badgeLine(latest, at) : null,
        canIssue: canEdit && currentAt(employment, at),
        canRevoke: canEdit && !!latest && !latest.revokedDate
    }
}

// ===== at a kiosk =====
// The registered device of this request, whose display account is the user, with PEOPLE_KIOSK_PUNCH; else refused.
function deviceOfRequest() {
    const current = UserSecurityChecks.currentDevice()
    const device = current?.deviceId ? one(DEVICE, {deviceId: current.deviceId}) : null
    if (!device || !ec.user.userId || device.displayUserId !== ec.user.userId)
        denied("DEVICE_REQUIRED", "A kiosk punch is recorded only at a registered clocking device")
    if (!ec.user.hasPermission("PEOPLE_KIOSK_PUNCH")) denied("PERMISSION_DENIED", "This device does not record punches")
    return device
}
// The organizations the device serves: those of its display account's party.
function deviceEmployers() {
    const partyId = ec.user.userAccount?.partyId
    return partyId ? Array.from(call("mantle.party.PartyServices.get#PartyInternalOrgIds", {partyId}).userOrgIds || []) : []
}
const recordAttempt = (device, reasonCode, kioskBadgeId) =>
    call("create#" + ATTEMPT, {
        deviceId: device.deviceId,
        kioskBadgeId: kioskBadgeId || null,
        attemptDate: ec.user.nowTimestamp,
        reasonCode
    })
// A refusal of a proof, counted at the device in a transaction of its own.
function refuse(device, reasonCode, message, kioskBadgeId) {
    ec.transaction.runRequireNew(null, "Recording a refused kiosk attempt", () => recordAttempt(device, reasonCode, kioskBadgeId))
    denied(reasonCode, message)
}
// The badge a worker proves themselves by at the device: its number and PIN, checked in order, every refusal counted.
function identify(device, badgeText, pin) {
    const at = nowMs()
    const refusals = find(ATTEMPT)
        .condition("deviceId", device.deviceId)
        .condition("attemptDate", "greater-equals", stamp(at - deviceWindowMs))
        .count()
    if (refusals >= deviceMaxRefusals)
        denied("KIOSK_LIMITED", "Too many refused attempts at this clock: try again in a few minutes")
    const digits = digitsOf(badgeText)
    const badge = /^\d{12,32}$/.test(digits) ? first(find(BADGE, {tokenHash: tokenHash(digits)})) : null
    if (!badge) refuse(device, "BADGE_UNKNOWN", "This badge is not recognized")
    if (badge.revokedDate)
        refuse(device, "BADGE_REVOKED", "This badge is no longer valid: ask HR for a new one", badge.kioskBadgeId)
    if (ms(badge.lockedUntilDate) > at)
        refuse(
            device,
            "PIN_LIMITED",
            "Too many wrong PINs: this badge works again at " + timeText(ms(badge.lockedUntilDate)),
            badge.kioskBadgeId
        )
    if (!validPin(pin) || !ec.user.passwordsMatch(text(pin), badge.pinHash, null, null, false)) {
        let locked = false
        ec.transaction.runRequireNew(null, "Counting a wrong kiosk PIN", () => {
            const row = find(BADGE, {kioskBadgeId: badge.kioskBadgeId}).forUpdate(true).one()
            const count = (Number(row.failedCount) || 0) + 1
            locked = count >= maxWrongPins
            call("update#" + BADGE, {
                kioskBadgeId: badge.kioskBadgeId,
                failedCount: locked ? 0 : count,
                lockedUntilDate: locked ? stamp(at + lockMs) : row.lockedUntilDate
            })
            recordAttempt(device, "PIN_WRONG", badge.kioskBadgeId)
        })
        denied("PIN_WRONG", locked ? "The PIN is not right: this badge is locked for 15 minutes" : "The PIN is not right")
    }
    // a right PIN clears the count, whatever then becomes of the punch
    ec.transaction.runRequireNew(null, "Recording a kiosk badge's use", () =>
        call("update#" + BADGE, {
            kioskBadgeId: badge.kioskBadgeId,
            failedCount: 0,
            lastUsedDate: ec.user.nowTimestamp,
            lastDeviceId: device.deviceId
        })
    )
    const employment = employmentRow(badge.partyRelationshipId)
    if (!employment || !currentAt(employment, at))
        refuse(device, "EMPLOYMENT_ENDED", "This badge's employment has ended", badge.kioskBadgeId)
    if (!deviceEmployers().includes(employment.toPartyId))
        refuse(device, "ORGANIZATION_DENIED", "This badge is not for this clock's employer", badge.kioskBadgeId)
    return {badge, employment, personName: people.personNames([badge.partyId])[badge.partyId] || ""}
}
// resolve#KioskBadge: the scan-input's resolver at a kiosk. The scanned text is the badge read, answered as it is, with nothing
// looked up, so a scan tells nothing of whom a number belongs to; the punch checks it with the PIN.
function resolveBadge(p) {
    deviceOfRequest()
    const digits = digitsOf(p.scanText)
    if (!/^\d{12,32}$/.test(digits)) return {matches: [], parsed: {}}
    return {matches: [{identityType: "badge", id: digits, label: "Badge read", detail: "Enter your PIN"}], parsed: {}}
}

const operations = {issueBadge, printBadge, revokeBadge, getBadge, resolveBadge}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown kiosk identity operation " + op)
    return operations[op](p || {})
}
;({execute: run, deviceOfRequest, identify, refuse})
