// The clocking kiosk's identity (mantle.humanres.AttendanceServices issue#KioskBadge, print#KioskBadge, revoke#KioskBadge,
// reset#KioskPin, get#KioskBadge, get#MyKioskBadges, set#MyKioskPin, resolve#KioskBadge and prune#KioskAttempts, and the proof
// record#KioskPunch asks of a worker; IronStone People design §6 ClockingKiosk, §15 the badge, PE-05; impl-people P30).
//
// A kiosk is a registered shared device (the framework's device credential, mr-moqui docs/security/Shared-Devices.md): its
// requests run as its display account, a UserAccount nothing signs in, whose party is a member of the employer it serves. The
// worker is never the request's user: each punch names them by a badge and a PIN.
// - A badge (KioskBadge) belongs to an employment. An HR editor of the employer issues it, which revokes the employment's badge
//   before it, with a one-time PIN (4 to 8 digits, kept only as its argon2 hash) or none. Its number (20 random digits, about 66
//   bits) is made when its issuer prints it, once, within fifteen minutes of the issue, and kept only as its single-use hash, so no
//   one can read it again: a lost or misprinted badge is revoked and another issued (issuing again is the reprint; the user's
//   call of Nov 12, 2026). The number is printed as a Code 128 barcode with the digits beside it, for a scanner or for typing.
// - The PIN is the worker's own (the user's call of Nov 12, 2026): the badge works at no kiosk until the worker sets their PIN in
//   self-service (set#MyKioskPin, the caller's own badge), typing the one-time PIN HR gave them, if any; they change it any time with
//   the PIN they have, and HR resets a forgotten one (reset#KioskPin: a new one-time PIN or none), which stops the badge until the
//   worker sets theirs again. HR never learns the worker's PIN: it is never the one-time PIN.
// - At a kiosk the proof is checked in this order: the request is a registered device's whose display account is the user, and
//   holds PEOPLE_KIOSK_PUNCH; the device is not pausing (KIOSK_WAIT: after many refusals at it lately each next proof waits a
//   growing pause, at most a few seconds, after the last refusal, and is not checked or counted sooner; nobody is ever shut out for
//   longer); the badge's number is known (BADGE_UNKNOWN), and then, under the badge's row lock so attempts at once are counted one
//   by one: not revoked (BADGE_REVOKED), not locked (PIN_LIMITED), its PIN set by the worker (PIN_NOT_SET), the PIN right
//   (PIN_WRONG: counted on the badge, and the fifth in a row locks it for fifteen minutes); the employment is current
//   (EMPLOYMENT_ENDED) and with an organization of the display account's (ORGANIZATION_DENIED). Every refusal of a proof is a
//   KioskAttempt of the device, written in a transaction of its own, so it counts although nothing else is kept; a burst of them
//   at a device tells the HR editors of its organizations, at most hourly, naming the device and the count, no badge or person
//   (PeopleKioskRefusals, to them alone). Attempts are kept 90 days (prune#KioskAttempts, a daily job).
// - The scan resolver answers the scanned text as the badge read, looking nothing up, so a scan learns nothing of whom a number
//   belongs to: the worker is named only once badge and PIN prove them.
// Who: an HR editor of the employer (PEOPLE_HR_VIEW and PEOPLE_HR_EDIT) issues, revokes, resets and reads a badge's state; only its
// issuer prints it; the worker (PEOPLE_SELF_SERVICE) sets their own badge's PIN; a device's display account with PEOPLE_KIOSK_PUNCH
// proves a worker. Missing and unauthorized records are refused alike (RECORD_UNAVAILABLE).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied, call} = lib

const BADGE = "mantle.humanres.attendance.KioskBadge"
const ATTEMPT = "mantle.humanres.attendance.KioskAttempt"
const RELATIONSHIP = "mantle.party.PartyRelationship"
const DEVICE = "moqui.security.DeviceCredential"
const NOTICE = "mantle.humanres.attendance.KioskDeviceNotice"

const minuteMs = 60 * 1000
const dayMs = 24 * 60 * minuteMs
// a badge is printed by its issuer within this long of its issue
const printMs = 15 * minuteMs
// wrong PINs in a row that lock a badge, and for how long
const maxWrongPins = 5
const lockMs = 15 * minuteMs
// a device's refusals within the window: from paceFrom of them each next proof waits a pause after the last refusal, a second
// doubling with each refusal and at most paceCapMs; at noticeAt of them the device's HR is told, at most once each noticeEveryMs
const deviceWindowMs = 10 * minuteMs
const paceFrom = 5
const paceStepMs = 1000
const paceCapMs = 5000
const noticeAt = 10
const noticeEveryMs = 60 * minuteMs
// refused attempts (and the notice marks) are kept this long
const keepAttemptsMs = 90 * dayMs
const pruneBatch = 500

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
    if (!badge.pinSetDate) return {state: "pinNeeded", stateText: "Waiting for the worker to set their PIN in self-service"}
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
            pinSetText: dateTimeText(badge.pinSetDate),
            canPrint: printable(badge, at)
        },
        badgeState(badge, at)
    )

// A one-time PIN given by HR: empty for none, else 4 to 8 digits.
function oneTimePinHash(oneTimePin) {
    if (!text(oneTimePin)) return null
    if (!validPin(oneTimePin)) denied("PIN_INVALID", "The one-time PIN is 4 to 8 digits")
    return ec.user.hashPassword(text(oneTimePin))
}
// issue#KioskBadge: a new badge of an employment, by an HR editor of the employer, with a one-time PIN or none; the employment's
// badge before it is revoked. Its number is made when it is printed; it works at a kiosk once the worker sets their own PIN.
function issueBadge(p) {
    const {employment} = hrEmployment(p.partyRelationshipId, true)
    const at = nowMs()
    if (!currentAt(employment, at)) denied("EMPLOYMENT_ENDED", "A badge is issued only for a current employment")
    const oneTimeHash = oneTimePinHash(p.oneTimePin)
    // two issues at once wait on the employment, so one badge is in use after both
    find(RELATIONSHIP, {partyRelationshipId: employment.partyRelationshipId}).forUpdate(true).one()
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
        oneTimePinHash: oneTimeHash,
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
// reset#KioskPin: an HR editor of the employer resets a badge's PIN the worker forgot, with a new one-time PIN or none: the
// worker's PIN is cleared, with its wrong count and lock, so the badge works at no kiosk until the worker sets theirs again.
function resetPin(p) {
    const badge = hrBadge(p.kioskBadgeId, true)
    if (badge.revokedDate) denied("BADGE_REVOKED", "This badge was revoked")
    call("update#" + BADGE, {
        kioskBadgeId: badge.kioskBadgeId,
        pinHash: null,
        pinSetDate: null,
        oneTimePinHash: oneTimePinHash(p.oneTimePin),
        failedCount: 0,
        lockedUntilDate: null
    })
    return {reset: true}
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
        canRevoke: canEdit && !!latest && !latest.revokedDate,
        canResetPin: canEdit && !!latest && !latest.revokedDate
    }
}

// ===== the worker's own PIN (self-service) =====
// The caller's own badges in use: of their own current employments, not revoked.
function ownBadges(at) {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.self || !userScope.partyId) return []
    const current = (userScope.employments || []).filter(row => currentAt(row, at)).map(row => row.partyRelationshipId)
    if (!current.length) return []
    return Array.from(
        find(BADGE)
            .condition("partyId", userScope.partyId)
            .condition("partyRelationshipId", "in", current)
            .condition("revokedDate", "is-null", null)
            .orderBy("-issuedDate")
            .list()
    )
}
// get#MyKioskBadges: the caller's own badges in use, each with its employer, its state, whether its PIN is set and whether setting
// one asks the PIN they have (their own, or the one-time PIN HR gave). Never a number or a PIN. Nothing for a caller without
// self-service.
function myBadges() {
    const at = nowMs()
    const own = ownBadges(at)
    const names = people.organizationNames(Array.from(new Set(own.map(row => row.organizationPartyId))))
    return {
        badges: own.map(badge =>
            Object.assign(badgeLine(badge, at), {
                organizationPartyId: badge.organizationPartyId,
                organizationName: names[badge.organizationPartyId] || badge.organizationPartyId,
                pinSet: !!badge.pinSetDate,
                currentPinAsked: !!(badge.pinHash || badge.oneTimePinHash),
                canPrint: false
            })
        )
    }
}
// A wrong PIN counted on the badge row (locked for update by the caller): the fifth in a row locks it for fifteen minutes. Answers
// whether it locked.
function countWrongPin(row, at) {
    const count = (Number(row.failedCount) || 0) + 1
    const locked = count >= maxWrongPins
    call("update#" + BADGE, {
        kioskBadgeId: row.kioskBadgeId,
        failedCount: locked ? 0 : count,
        lockedUntilDate: locked ? stamp(at + lockMs) : row.lockedUntilDate
    })
    return locked
}
// set#MyKioskPin: the caller sets or changes the PIN of their own badge (else RECORD_UNAVAILABLE): the new PIN of 4 to 8 digits
// (PIN_INVALID), not the one-time PIN HR gave (PIN_REUSED); the PIN they have now (their own, else the one-time PIN, when HR gave
// one) is asked, a wrong one counted on the badge as at a kiosk (PIN_WRONG, PIN_LIMITED). The badge works at a kiosk from then on.
function setMyPin(p) {
    const at = nowMs()
    const own = ownBadges(at).find(row => row.kioskBadgeId === text(p.kioskBadgeId))
    if (!own) denied("RECORD_UNAVAILABLE", "Badge " + text(p.kioskBadgeId) + " is not available")
    if (!validPin(p.newPin)) denied("PIN_INVALID", "The PIN is 4 to 8 digits")
    let refusal = null
    ec.transaction.runRequireNew(null, "Setting a kiosk PIN", () => {
        const row = find(BADGE, {kioskBadgeId: own.kioskBadgeId}).forUpdate(true).one()
        if (row.revokedDate) return (refusal = ["RECORD_UNAVAILABLE", "Badge " + own.kioskBadgeId + " is not available"])
        if (ms(row.lockedUntilDate) > at)
            return (refusal = [
                "PIN_LIMITED",
                "Too many wrong PINs: this badge works again at " + timeText(ms(row.lockedUntilDate))
            ])
        const asked = row.pinHash || row.oneTimePinHash
        if (asked && !(validPin(p.currentPin) && ec.user.passwordsMatch(text(p.currentPin), asked, null, null, false))) {
            const locked = countWrongPin(row, at)
            return (refusal = [
                "PIN_WRONG",
                locked
                    ? "The current PIN is not right: this badge is locked for 15 minutes"
                    : row.pinHash
                      ? "The current PIN is not right"
                      : "The one-time PIN HR gave you is not right"
            ])
        }
        if (row.oneTimePinHash && ec.user.passwordsMatch(text(p.newPin), row.oneTimePinHash, null, null, false))
            return (refusal = ["PIN_REUSED", "Choose a PIN of your own, not the one HR gave you"])
        call("update#" + BADGE, {
            kioskBadgeId: row.kioskBadgeId,
            pinHash: ec.user.hashPassword(text(p.newPin)),
            pinSetDate: ec.user.nowTimestamp,
            oneTimePinHash: null,
            failedCount: 0,
            lockedUntilDate: null
        })
    })
    if (refusal) denied(refusal[0], refusal[1])
    return {pinSet: true}
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
// The device's refusals within the window ending at: how many, and when the last was.
function recentRefusals(device, at) {
    const recent = () =>
        find(ATTEMPT)
            .condition("deviceId", device.deviceId)
            .condition("attemptDate", "greater-equals", stamp(at - deviceWindowMs))
    const count = recent().count()
    const last = count ? first(recent().orderBy("-attemptDate")) : null
    return {count, lastMs: last ? ms(last.attemptDate) : null}
}
// The pause after a device's last refusal before its next proof is checked, by its refusals in the window.
const pauseMs = count => (count < paceFrom ? 0 : Math.min(paceCapMs, paceStepMs * 2 ** (count - paceFrom)))
// A device with many refusals lately checks its next proof only once the pause after the last has passed: sooner, it answers how
// long to wait, looking nothing up and counting nothing, so a run of bad scans slows the device and never shuts a worker out for
// longer than the pause.
function pace(device, at) {
    const {count, lastMs} = recentRefusals(device, at)
    const waitMs = lastMs == null ? 0 : lastMs + pauseMs(count) - at
    if (waitMs > 0) {
        const seconds = Math.ceil(waitMs / 1000)
        denied("KIOSK_WAIT", "One moment: try again in " + seconds + (seconds === 1 ? " second" : " seconds"))
    }
}
// The users who are HR editors (PEOPLE_HR_EDIT) on the staff of one of the organizations: an enabled, not display, account in an
// active group holding the permission, whose party is a current employee or agent of the organization.
function hrEditorUsers(organizationPartyIds, at) {
    if (!organizationPartyIds.length) return []
    const groupIds = Array.from(find("moqui.security.UserGroupPermission", {userPermissionId: "PEOPLE_HR_EDIT"}).list())
        .filter(row => lib.active(row))
        .map(row => row.userGroupId)
        .filter(groupId => groupId !== "ALL_USERS")
    if (!groupIds.length) return []
    const memberIds = Array.from(find("moqui.security.UserGroupMember").condition("userGroupId", "in", groupIds).list())
        .filter(row => lib.active(row))
        .map(row => row.userId)
    if (!memberIds.length) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", memberIds).list()).filter(
        row => row.partyId && row.disabled !== "Y" && row.displayAccount !== "Y"
    )
    if (!accounts.length) return []
    const staff = new Set(
        Array.from(
            people
                .current(
                    find(RELATIONSHIP)
                        .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                        .condition("toPartyId", "in", organizationPartyIds)
                        .condition(
                            "fromPartyId",
                            "in",
                            accounts.map(row => row.partyId)
                        ),
                    at
                )
                .list()
        ).map(row => row.fromPartyId)
    )
    return Array.from(new Set(accounts.filter(row => staff.has(row.partyId)).map(row => row.userId)))
}
// A burst of refusals at a device (noticeAt within the window) told to the HR editors of its organizations, at most once each
// noticeEveryMs, naming the device and the count, never a badge or a person, to them alone. The device's KioskDeviceNotice is
// claimed under its row lock and the notice sent in one transaction of its own, so two refusals at once send one and a notice that
// fails is tried again at the next refusal. A failure is logged and the refusal stands.
function noticeBurst(device, at) {
    try {
        const {count} = recentRefusals(device, at)
        if (count < noticeAt) return
        ec.transaction.runRequireNew(null, "Telling HR of a clocking kiosk's refused attempts", () => {
            const row = find(NOTICE, {deviceId: device.deviceId}).forUpdate(true).one()
            if (row && ms(row.lastNoticeDate) > at - noticeEveryMs) return
            call((row ? "update#" : "create#") + NOTICE, {
                deviceId: device.deviceId,
                lastNoticeDate: ec.user.nowTimestamp,
                lastRefusalCount: count
            })
            const userIds = hrEditorUsers(deviceEmployers(), at)
            if (!userIds.length) {
                ec.logger.warn("Clocking device " + device.deviceId + " had " + count + " refused attempts: no HR editor to tell")
                return
            }
            ec.makeNotificationMessage()
                .topic("PeopleKioskRefusals")
                .message({
                    deviceId: device.deviceId,
                    deviceName: device.deviceName || device.deviceId,
                    refusalCount: count,
                    windowMinutes: deviceWindowMs / minuteMs
                })
                .record(DEVICE, device.deviceId)
                .userIds(userIds)
                .directOnly()
                .send()
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
        })
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("The refused attempts notice of clocking device " + device.deviceId + " was not sent: " + error.message)
    }
}
// A refusal of a proof, counted at the device in a transaction of its own (with the badge's count, when the update is given), a
// burst told to HR.
function refuse(device, reasonCode, message, kioskBadgeId) {
    ec.transaction.runRequireNew(null, "Recording a refused kiosk attempt", () => recordAttempt(device, reasonCode, kioskBadgeId))
    noticeBurst(device, nowMs())
    denied(reasonCode, message)
}
// The badge a worker proves themselves by at the device: its number and PIN, checked in order, every refusal counted. The badge's
// state and PIN are read and its count written under its row lock, in a transaction of its own, so proofs at once are checked one
// after the other and none slips past the lock.
function identify(device, badgeText, pin) {
    const at = nowMs()
    pace(device, at)
    const digits = digitsOf(badgeText)
    const found = /^\d{12,32}$/.test(digits) ? first(find(BADGE, {tokenHash: tokenHash(digits)})) : null
    if (!found) refuse(device, "BADGE_UNKNOWN", "This badge is not recognized")
    let refusal = null
    let badge = found
    ec.transaction.runRequireNew(null, "Checking a kiosk badge and PIN", () => {
        badge = find(BADGE, {kioskBadgeId: found.kioskBadgeId}).forUpdate(true).one()
        const refused = (reasonCode, message) => {
            recordAttempt(device, reasonCode, badge.kioskBadgeId)
            refusal = [reasonCode, message]
        }
        if (badge.revokedDate) return refused("BADGE_REVOKED", "This badge is no longer valid: ask HR for a new one")
        if (ms(badge.lockedUntilDate) > at)
            return refused("PIN_LIMITED", "Too many wrong PINs: this badge works again at " + timeText(ms(badge.lockedUntilDate)))
        if (!badge.pinSetDate || !badge.pinHash)
            return refused("PIN_NOT_SET", "Set your PIN in self-service first: this badge works once you have")
        if (!validPin(pin) || !ec.user.passwordsMatch(text(pin), badge.pinHash, null, null, false)) {
            const locked = countWrongPin(badge, at)
            return refused(
                "PIN_WRONG",
                locked ? "The PIN is not right: this badge is locked for 15 minutes" : "The PIN is not right"
            )
        }
        // a right PIN clears the count, whatever then becomes of the punch
        call("update#" + BADGE, {
            kioskBadgeId: badge.kioskBadgeId,
            failedCount: 0,
            lastUsedDate: ec.user.nowTimestamp,
            lastDeviceId: device.deviceId
        })
    })
    if (refusal) {
        noticeBurst(device, nowMs())
        denied(refusal[0], refusal[1])
    }
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

// prune#KioskAttempts (a daily job): refused attempts and notice marks older than 90 days deleted, a batch at a time each in a
// transaction of its own; a batch that fails is deleted row by row, a row that fails logged by its id and left for the next run.
function pruneAttempts() {
    const cutoff = stamp(nowMs() - keepAttemptsMs)
    const skipped = []
    let deletedCount = 0
    let failedCount = 0
    for (let round = 0; round < 1000; round++) {
        let query = find(ATTEMPT).condition("attemptDate", "less", cutoff)
        if (skipped.length) query = query.condition("kioskAttemptId", "not-in", skipped)
        const ids = Array.from(query.selectField("kioskAttemptId").limit(pruneBatch).list()).map(row => row.kioskAttemptId)
        if (!ids.length) break
        try {
            deletedCount += ec.transaction.runRequireNew(null, "Pruning kiosk attempts", () =>
                find(ATTEMPT).condition("kioskAttemptId", "in", ids).deleteAll()
            )
        } catch (error) {
            ec.message.clearErrors()
            for (const kioskAttemptId of ids) {
                try {
                    deletedCount += ec.transaction.runRequireNew(null, "Pruning kiosk attempt " + kioskAttemptId, () =>
                        find(ATTEMPT, {kioskAttemptId}).deleteAll()
                    )
                } catch (rowError) {
                    ec.message.clearErrors()
                    failedCount++
                    skipped.push(kioskAttemptId)
                    ec.logger.error("Kiosk attempt " + kioskAttemptId + " was not pruned: " + rowError.message)
                }
            }
        }
        if (ids.length < pruneBatch) break
    }
    try {
        ec.transaction.runRequireNew(null, "Pruning kiosk notice marks", () =>
            find(NOTICE).condition("lastNoticeDate", "less", cutoff).deleteAll()
        )
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error("Kiosk notice marks were not pruned: " + error.message)
    }
    return {deletedCount, failedCount}
}

const operations = {issueBadge, printBadge, revokeBadge, resetPin, getBadge, myBadges, setMyPin, resolveBadge, pruneAttempts}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown kiosk identity operation " + op)
    return operations[op](p || {})
}
;({execute: run, deviceOfRequest, identify, refuse})
