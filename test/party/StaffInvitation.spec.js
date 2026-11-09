// Staff invitations (service/mantle/party/IdentityServices.xml, Invitations.js; mr-boss impl-admin P5, design-admin §4.1): with
// no mail server the acceptance link comes back once and no row keeps the token; an invitation never carries ADMIN or a sealed
// right, and a retry with the same key answers the same invitation; acceptance makes exactly one account, in the invitation's
// organization with its bundles whatever the request says, and the token is single use; a resend invalidates the earlier
// token, and revoked, expired and wrong-address tokens are refused; an existing account is linked, not duplicated; a proposal
// changed after it was sent (ADMIN put into it) is refused with nothing written; another organization's staff or a site
// identity needs ADMIN_IDENTITY_GLOBAL to invite, and the inviter's again at acceptance; a bundle requiring a factor leaves
// the acceptance at the factor step, its key for the accepting session or the account only. The operators hold the framework's ADMIN_IDENTITY_* permissions through spec groups, never
// an app group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/StaffInvitation
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
const run = String(effectiveTime).slice(-7)
const users = {}
const parties = {}
const tokens = {}
const invitations = {}
let orgId
let otherOrgId

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
// as username (null: no one signed in) with artifact authorization on, as a screen calls the services
function as(username, action) {
    if (username) ec.user.internalLoginUser(username)
    else logout()
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())
const invitation = invitationId => rows("mantle.party.UserInvitation", {invitationId})[0]
const tokenOf = acceptUrl => String(acceptUrl || "").split("/i/")[1] || ""
const email = key => "sinv." + key + "." + run + "@example.com"
// an invitation by the operator (or another inviter) and its link, shown once (no mail server)
function invite(key, params, inviter = "sinv.operator." + run) {
    return as(inviter, () => {
        const sent = result(S + "invite#User", Object.assign({emailAddress: email(key), organizationPartyId: orgId}, params))
        const shown = sent.invitationId ? result(S + "reveal#InvitationLink", {invitationId: sent.invitationId}) : {}
        invitations[key] = sent.invitationId
        tokens[key] = tokenOf(shown.acceptUrl)
        return {sent, shown}
    })
}

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

feature(
    "an internal organization, its operator, registered bundles (one requiring a factor) and a sealed one, and no mail server",
    {
        when() {
            orgId = call("mantle.party.PartyServices.create#Organization", {
                organizationName: "Invite One Co",
                roleTypeId: "OrgInternal"
            }).partyId
            otherOrgId = call("mantle.party.PartyServices.create#Organization", {
                organizationName: "Invite Two Co",
                roleTypeId: "OrgInternal"
            }).partyId
            const group = (userGroupId, extra) =>
                rows("moqui.security.UserGroup", {userGroupId}).length ||
                call("create#moqui.security.UserGroup", Object.assign({userGroupId, description: "Spec " + userGroupId}, extra))
            const grant = (userGroupId, userPermissionId) =>
                rows("moqui.security.UserGroupPermission", {userGroupId, userPermissionId}).length ||
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId,
                    userPermissionId,
                    fromDate: effectiveTime - dayMillis
                })
            const bundle = userGroupId =>
                rows("moqui.security.CapabilityBundle", {userGroupId}).length ||
                call("create#moqui.security.CapabilityBundle", {userGroupId, appName: "Spec", description: "Spec " + userGroupId})
            group("SINV_OPERATORS")
            grant("SINV_OPERATORS", "ADMIN_IDENTITY_VIEW")
            grant("SINV_OPERATORS", "ADMIN_IDENTITY_MANAGE")
            group("SINV_GLOBAL")
            grant("SINV_GLOBAL", "ADMIN_IDENTITY_GLOBAL")
            group("SINV_BUNDLE")
            bundle("SINV_BUNDLE")
            group("SINV_FACTOR", {requireAuthcFactor: "Y"})
            bundle("SINV_FACTOR")
            // a registered bundle granting a sealed permission: never in an invitation
            group("SINV_SEALED")
            grant("SINV_SEALED", "ADMIN_IDENTITY_GLOBAL")
            bundle("SINV_SEALED")
            const person = (key, username, orgs) => {
                parties[key] = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Invite"}).partyId
                users[key] = call("mantle.party.PartyServices.create#PartyUserAccount", {
                    partyId: parties[key],
                    emailAddress: username + "@example.com",
                    username,
                    newPassword: "moqui1!!",
                    newPasswordVerify: "moqui1!!"
                }).userId
                for (const org of orgs)
                    call("create#mantle.party.PartyRelationship", {
                        relationshipTypeEnumId: "PrtEmployee",
                        fromPartyId: parties[key],
                        toPartyId: org,
                        toRoleTypeId: "OrgInternal",
                        fromDate: effectiveTime - dayMillis
                    })
            }
            person("Operator", "sinv.operator." + run, [orgId])
            // a person of the other organization with an account, invited to this one later
            person("Existing", "sinv.existing." + run, [otherOrgId])
            // a site identity: an account of no internal organization
            person("Site", "sinv.site." + run, [])
            // an operator of this organization who also holds ADMIN_IDENTITY_GLOBAL
            person("Global", "sinv.global." + run, [orgId])
            const member = (userGroupId, userId) =>
                call("create#moqui.security.UserGroupMember", {userGroupId, userId, fromDate: effectiveTime - dayMillis})
            member("SINV_OPERATORS", users.Operator)
            member("SINV_OPERATORS", users.Global)
            member("SINV_GLOBAL", users.Global)
            const server = rows("moqui.basic.email.EmailServer", {emailServerId: "SYSTEM"})[0]
            return {smtpHost: server?.smtpHost || ""}
        },
        then({smtpHost}) {
            orgId && users.Operator
            smtpHost == ""
        }
    }
)

feature("with no mail server the link comes back once, its showing is audited, and no row keeps the token", {
    when() {
        const first = invite("new", {
            firstName: "Nell",
            lastName: "New",
            bundleGroupIdList: ["SINV_BUNDLE"],
            operationKey: "SINV-" + run
        })
        const again = as("sinv.operator." + run, () => result(S + "reveal#InvitationLink", {invitationId: invitations.new}))
        const retry = as("sinv.operator." + run, () =>
            result(S + "invite#User", {
                emailAddress: email("new"),
                organizationPartyId: orgId,
                bundleGroupIdList: ["SINV_BUNDLE"],
                operationKey: "SINV-" + run
            })
        )
        const audits = rows("moqui.entity.EntityAuditLog", {
            changedEntityName: "mantle.party.UserInvitation",
            pkPrimaryValue: invitations.new
        })
        return {first, again, retry, row: invitation(invitations.new), audits}
    },
    then({first, again, retry, row, audits}) {
        first.sent.applied == true && first.sent.mailSent == false && first.sent.linkPending == true
        first.shown.applied == true && tokens.new.length == 43
        first.shown.acceptUrl.endsWith("/i/" + tokens.new)
        again.applied == false && again.reasonCode == "LINK_SHOWN" && !again.acceptUrl
        retry.retried == true && retry.invitationId == invitations.new
        rows("mantle.party.UserInvitation", {emailAddress: email("new")}).length == 1
        row.linkShownDate != null && row.tokenHash != tokens.new
        !JSON.stringify(row).includes(tokens.new)
        audits.some(audit => audit.changedFieldName == "linkShownDate")
        !JSON.stringify(audits).includes(tokens.new)
    }
})

feature(
    "an invitation never carries ADMIN or a sealed right, and another organization is not the operator's; the email links /i/<token>",
    {
        when() {
            const mail = ec.screen
                .makeTest()
                .rootScreen("component://mr-mantle/template/party/StaffInvitation.xml")
                .renderMode("html")
                .render(
                    "",
                    {
                        organizationName: "Invite One Co",
                        inviterName: "Olive",
                        bundleSummary: "Spec",
                        expiresText: "2026-11-14",
                        acceptUrl: "https://boss.example.com/i/TokenForTheMailOnly0000"
                    },
                    null
                )
            return as("sinv.operator." + run, () => ({
                mail: String(mail.output || ""),
                admin: result(S + "invite#User", {
                    emailAddress: email("admin"),
                    firstName: "A",
                    lastName: "Dmin",
                    organizationPartyId: orgId,
                    bundleGroupIdList: ["ADMIN"]
                }),
                sealed: result(S + "invite#User", {
                    emailAddress: email("sealed"),
                    firstName: "S",
                    lastName: "Ealed",
                    organizationPartyId: orgId,
                    bundleGroupIdList: ["SINV_SEALED"]
                }),
                other: result(S + "invite#User", {
                    emailAddress: email("other"),
                    firstName: "O",
                    lastName: "Ther",
                    organizationPartyId: otherOrgId,
                    bundleGroupIdList: ["SINV_BUNDLE"]
                })
            }))
        },
        then({mail, admin, sealed, other}) {
            mail.includes("Olive invited you to join Invite One Co") &&
                mail.includes('href="https://boss.example.com/i/TokenForTheMailOnly0000"')
            admin.applied == false && admin.reasonCode == "PRIVILEGED_GROUP"
            sealed.applied == false && sealed.reasonCode == "SEALED_PERMISSION"
            other.error.includes("RECORD_UNAVAILABLE")
            rows("mantle.party.UserInvitation", {emailAddress: email("admin")}).length == 0
        }
    }
)

feature("acceptance makes exactly one account, in the invitation's organization with its bundles, and the token is single use", {
    when() {
        return as(null, () => {
            const summary = result(S + "get#InvitationSummary", {token: tokens.new})
            const accepted = result(S + "accept#Invitation", {
                token: tokens.new,
                username: "sinv.new." + run,
                userFullName: "Nell New",
                newPassword: "Sinv-pass-" + run,
                newPasswordVerify: "Sinv-pass-" + run,
                // not parameters of the redemption: ignored
                organizationPartyId: otherOrgId,
                bundleGroupIdList: ["ADMIN"]
            })
            const again = result(S + "accept#Invitation", {
                token: tokens.new,
                username: "sinv.new2." + run,
                newPassword: "Sinv-pass-" + run,
                newPasswordVerify: "Sinv-pass-" + run
            })
            const spent = result(S + "get#InvitationSummary", {token: tokens.new})
            const unknown = result(S + "check#InvitationToken", {token: "NoSuchInvitationToken0000", routeName: "i"})
            return {summary, accepted, again, spent, unknown}
        })
    },
    then({summary, accepted, again, spent, unknown}) {
        summary.step == "invitation" && summary.accountMode == "create" && summary.organizationName == "Invite One Co"
        summary.bundleList[0].description == "Spec SINV_BUNDLE" && !JSON.stringify(summary).includes('"SINV_BUNDLE"')
        accepted.applied == true && accepted.accountCreated == true && accepted.step == "done"
        const accounts = rows("moqui.security.UserAccount", {emailAddress: email("new")})
        accounts.length == 1 && accounts[0].userId == accepted.userId && accounts[0].currentPassword != null
        rows("mantle.party.PartyRelationship", {fromPartyId: accounts[0].partyId, toPartyId: orgId}).length == 1
        rows("mantle.party.PartyRelationship", {fromPartyId: accounts[0].partyId, toPartyId: otherOrgId}).length == 0
        const groups = rows("moqui.security.UserGroupMember", {userId: accepted.userId}).map(row => row.userGroupId)
        groups.includes("SINV_BUNDLE") && !groups.includes("ADMIN")
        invitation(invitations.new).statusId == "UinvAccepted"
        again.applied == false && again.reasonCode == "INVITATION_SPENT"
        rows("moqui.security.UserAccount", {username: "sinv.new2." + run}).length == 0
        // within fifteen minutes the holder sees the done step; nothing more of the invitation
        spent.step == "done" && spent.emailAddress == null
        unknown.valid == true && unknown.routeContext.open == false
    }
})

feature("a resend invalidates the earlier token; revoked, expired and wrong-address tokens are refused", {
    when() {
        invite("resent", {firstName: "Rae", lastName: "Resent", bundleGroupIdList: ["SINV_BUNDLE"]})
        const firstToken = tokens.resent
        const resent = as("sinv.operator." + run, () => {
            const out = result(S + "resend#Invitation", {
                invitationId: invitations.resent,
                expectedRevision: result(S + "find#Invitations", {text: email("resent")}).invitationList[0].revision
            })
            tokens.resent = tokenOf(result(S + "reveal#InvitationLink", {invitationId: invitations.resent}).acceptUrl)
            return out
        })
        const afterResend = as(null, () => ({
            first: result(S + "get#InvitationSummary", {token: firstToken}),
            second: result(S + "get#InvitationSummary", {token: tokens.resent})
        }))
        // the wrong account: signed in with another address
        const wrong = as("sinv.operator." + run, () => result(S + "accept#Invitation", {token: tokens.resent}))
        const revoked = as("sinv.operator." + run, () =>
            result(S + "revoke#Invitation", {
                invitationId: invitations.resent,
                expectedRevision: result(S + "find#Invitations", {text: email("resent")}).invitationList[0].revision,
                reason: "Hired elsewhere"
            })
        )
        const afterRevoke = as(null, () =>
            result(S + "accept#Invitation", {
                token: tokens.resent,
                username: "sinv.rae." + run,
                newPassword: "x1!Sinvpass",
                newPasswordVerify: "x1!Sinvpass"
            })
        )
        invite("expired", {firstName: "Eve", lastName: "Expired", bundleGroupIdList: ["SINV_BUNDLE"]})
        {
            const v = ec.entity.makeValue("mantle.party.UserInvitation")
            v.setFields(
                {invitationId: invitations.expired, expiresDate: new Date(effectiveTime - 60000).toISOString()},
                true,
                null,
                null
            )
            v.update()
        }
        const expired = as(null, () => result(S + "get#InvitationSummary", {token: tokens.expired}))
        const listed = as("sinv.operator." + run, () => result(S + "find#Invitations", {state: "expired"}))
        return {resent, afterResend, wrong, revoked, afterRevoke, expired, listed}
    },
    then({resent, afterResend, wrong, revoked, afterRevoke, expired, listed}) {
        resent.applied == true && resent.linkPending == true
        afterResend.first.step == "spent" && afterResend.first.message == "This invitation is no longer valid"
        afterResend.second.step == "invitation"
        wrong.applied == false && wrong.reasonCode == "WRONG_ACCOUNT"
        revoked.applied == true
        afterRevoke.reasonCode == "INVITATION_SPENT"
        rows("moqui.security.UserAccount", {username: "sinv.rae." + run}).length == 0
        expired.step == "spent"
        listed.invitationList.some(row => row.invitationId == invitations.expired && row.stateText == "Expired")
        !JSON.stringify(listed).includes("tokenHash")
    }
})

feature("another organization's staff and a site identity need ADMIN_IDENTITY_GLOBAL, at invitation and acceptance", {
    when() {
        const plain = invite("staff", {emailAddress: "sinv.existing." + run + "@example.com", bundleGroupIdList: ["SINV_BUNDLE"]})
        const site = invite("site", {emailAddress: "sinv.site." + run + "@example.com", bundleGroupIdList: ["SINV_BUNDLE"]})
        invite(
            "siteGlobal",
            {emailAddress: "sinv.site." + run + "@example.com", bundleGroupIdList: ["SINV_BUNDLE"]},
            "sinv.global." + run
        )
        // the inviter's ADMIN_IDENTITY_GLOBAL ends before the site identity accepts
        const ended = ec.entity.makeValue("moqui.security.UserGroupMember")
        ended.setFields(
            {userGroupId: "SINV_GLOBAL", userId: users.Global, fromDate: effectiveTime - dayMillis, thruDate: Date.now() - 1000},
            true,
            null,
            null
        )
        ended.update()
        const accepted = as("sinv.site." + run, () => result(S + "accept#Invitation", {token: tokens.siteGlobal}))
        return {plain: plain.sent, site: site.sent, accepted}
    },
    then({plain, site, accepted}) {
        plain.applied == false && plain.reasonCode == "IDENTITY_GLOBAL"
        site.applied == false && site.reasonCode == "IDENTITY_GLOBAL"
        accepted.applied == false && accepted.reasonCode == "IDENTITY_GLOBAL"
        rows("mantle.party.PartyRelationship", {fromPartyId: parties.Site, toPartyId: orgId}).length == 0
        invitation(invitations.siteGlobal).statusId == "UinvPending"
    }
})

feature("an existing account is linked after it signs in, not duplicated; a proposal changed to name ADMIN is refused", {
    when() {
        // the inviter of another organization's staff holds ADMIN_IDENTITY_GLOBAL
        call("create#moqui.security.UserGroupMember", {
            userGroupId: "SINV_GLOBAL",
            userId: users.Global,
            fromDate: Date.now() - 500
        })
        invite(
            "existing",
            {emailAddress: "sinv.existing." + run + "@example.com", bundleGroupIdList: ["SINV_BUNDLE"]},
            "sinv.global." + run
        )
        const anonymous = as(null, () => ({
            summary: result(S + "get#InvitationSummary", {token: tokens.existing}),
            accept: result(S + "accept#Invitation", {
                token: tokens.existing,
                username: "sinv.dup." + run,
                newPassword: "x1!Sinvpass",
                newPasswordVerify: "x1!Sinvpass"
            })
        }))
        const linked = as("sinv.existing." + run, () => result(S + "accept#Invitation", {token: tokens.existing}))
        invite("tampered", {firstName: "Tom", lastName: "Tampered", bundleGroupIdList: ["SINV_BUNDLE"]})
        {
            const v = ec.entity.makeValue("mantle.party.UserInvitation")
            v.setFields({invitationId: invitations.tampered, bundleGroupIds: "SINV_BUNDLE,ADMIN"}, true, null, null)
            v.update()
        }
        const tampered = as(null, () =>
            result(S + "accept#Invitation", {
                token: tokens.tampered,
                username: "sinv.tom." + run,
                newPassword: "x1!Sinvpass",
                newPasswordVerify: "x1!Sinvpass"
            })
        )
        return {anonymous, linked, tampered}
    },
    then({anonymous, linked, tampered}) {
        anonymous.summary.accountMode == "signIn"
        anonymous.accept.reasonCode == "ACCOUNT_EXISTS"
        linked.applied == true && linked.accountCreated == false && linked.userId == users.Existing
        rows("moqui.security.UserAccount", {emailAddress: "sinv.existing." + run + "@example.com"}).length == 1
        rows("mantle.party.PartyRelationship", {fromPartyId: parties.Existing, toPartyId: orgId}).length == 1
        tampered.applied == false && tampered.reasonCode == "GRANT_CHANGED"
        rows("moqui.security.UserAccount", {username: "sinv.tom." + run}).length == 0
        invitation(invitations.tampered).statusId == "UinvPending"
    }
})

feature("a bundle whose group requires a factor leaves the acceptance at the factor step, a wrong code refused", {
    when() {
        invite("factor", {firstName: "Fay", lastName: "Factor", bundleGroupIdList: ["SINV_FACTOR"]})
        const steps = as(null, () => {
            const before = result(S + "get#InvitationSummary", {token: tokens.factor})
            const accepted = result(S + "accept#Invitation", {
                token: tokens.factor,
                username: "sinv.fay." + run,
                newPassword: "Sinv-pass-" + run,
                newPasswordVerify: "Sinv-pass-" + run
            })
            // another holder of the link (no session of the acceptance here, no one signed in) never sees the key
            const elsewhere = result(S + "get#InvitationSummary", {token: tokens.factor})
            const refusedElsewhere = result(S + "confirm#InvitationFactor", {token: tokens.factor, code: "000000"})
            return {before, accepted, elsewhere, refusedElsewhere}
        })
        const own = as("sinv.fay." + run, () => ({
            step: result(S + "get#InvitationSummary", {token: tokens.factor}),
            wrong: result(S + "confirm#InvitationFactor", {token: tokens.factor, code: "000000"})
        }))
        return Object.assign(steps, own)
    },
    then({before, accepted, elsewhere, refusedElsewhere, step, wrong}) {
        before.factorRequired == true
        accepted.applied == true && accepted.step == "factor"
        elsewhere.step != "factor" && elsewhere.factor == null
        refusedElsewhere.reasonCode == "INVITATION_SPENT"
        step.step == "factor" && step.factor.qrUri.startsWith("otpauth://totp/")
        wrong.applied == false && wrong.reasonCode == "CODE_INVALID"
        rows("moqui.security.UserAuthcFactor", {userId: accepted.userId}).length == 1
    }
})
