// People's entry into the account lifecycle (mantle.party.IdentityServices request#Provisioning and request#AccessEnd; mr-boss
// design-admin §4.1 Provisioning from People, impl-people P7): one operation per key, its steps waiting for an identity operator
// when the HR officer who hired could not run them, and the operator's retry sending the invitation; an access end for one
// employer keeping the account's access for the other, and the last employer's ending its memberships.
// Standalone: spec-local organizations, people, groups, a registered bundle and accounts; the calls run with authorization on, as
// the services' own checks and the identity scope read it. Run: ./moq test mr-mantle --spec UserProvisioning
const S = "mantle.party.IdentityServices."
const P = "mantle.humanres.PeopleServices."
const prefix = "UPROV_SPEC"
const since = "2001-01-01T00:00:00Z"
const day = 86400000
const state = {}

function as(username, service, parameters = {}) {
    ec.user.internalLoginUser(username)
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const code = out => out.reasonCode || (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const steps = operationId =>
    rows("mantle.party.UserLifecycleOperationStep", {operationId})
        .sort((a, b) => a.stepSeqId.localeCompare(b.stepSeqId))
        .map(
            step =>
                step.stepKind +
                ":" +
                step.statusId.replace("Ulst", "") +
                (step.reasonCode === "OPERATOR_REQUIRED" ? "(operator)" : "")
        )
        .join(",")
function organization(key, name) {
    const partyId = prefix + "_" + key
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    return partyId
}
function group(userGroupId, permissions) {
    call("create#moqui.security.UserGroup", {userGroupId, description: "Spec " + userGroupId})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId: permission, fromDate: since})
}
// a person (with an account, when username is given) related to the organizations
function person(key, organizations, username = null, relationshipTypeEnumId = "PrtEmployee") {
    const partyId = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Provision"}).partyId
    call("mantle.party.ContactServices.create#EmailAddress", {
        emailAddress: key.toLowerCase() + ".uprov@example.com",
        partyId,
        contactMechPurposeId: "EmailWork"
    })
    for (const toPartyId of organizations)
        if (relationshipTypeEnumId === "PrtEmployee")
            call("mantle.humanres.EmploymentServices.create#Employment", {fromPartyId: partyId, toPartyId, fromDate: since})
        else
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId,
                fromPartyId: partyId,
                toPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
    const userId = username
        ? call("mantle.party.PartyServices.create#PartyUserAccount", {
              partyId,
              emailAddress: username + "@example.com",
              username,
              newPassword: "moqui1!!",
              newPasswordVerify: "moqui1!!"
          }).userId
        : null
    return {partyId, userId, username}
}
const member = (userGroupId, userId) => call("create#moqui.security.UserGroupMember", {userGroupId, userId, fromDate: since})
// an applied People change of the person at the organization, asked for by the user (the People fact the requests are made from)
function change(partyId, organizationPartyId, kind, requestedByUserId, extra = {}) {
    const relationship = rows("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtEmployee",
        fromPartyId: partyId,
        toPartyId: organizationPartyId
    })[0]
    return call(
        "create#mantle.humanres.employment.EmploymentChange",
        Object.assign(
            {
                partyRelationshipId: relationship?.partyRelationshipId || null,
                partyId,
                organizationPartyId,
                changeKindEnumId: kind,
                statusId: "EchApplied",
                effectiveDate: ec.user.nowTimestamp,
                requestedByUserId,
                requestedDate: ec.user.nowTimestamp,
                appliedDate: ec.user.nowTimestamp
            },
            extra
        )
    ).employmentChangeId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.orgA = organization("A", "Provision Spec A")
        state.orgB = organization("B", "Provision Spec B")
        group(prefix + "_OPERATORS", ["ADMIN_IDENTITY_VIEW", "ADMIN_IDENTITY_MANAGE"])
        group(prefix + "_HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"])
        group(prefix + "_STAFF", [])
        call("create#moqui.security.CapabilityBundle", {
            userGroupId: prefix + "_STAFF",
            appName: "Spec",
            description: "Spec staff"
        })
        // a bundle only an identity operator may give (its delegable permission)
        group(prefix + "_KEYS", [])
        call("create#moqui.security.CapabilityBundle", {
            userGroupId: prefix + "_KEYS",
            appName: "Spec",
            description: "Spec keys",
            delegablePermissionId: "ADMIN_IDENTITY_MANAGE"
        })
        state.operator = person("Operator", [state.orgA, state.orgB], "uprov.operator", "PrtAgent")
        member(prefix + "_OPERATORS", state.operator.userId)
        state.hr = person("Hr", [state.orgA], "uprov.hr", "PrtAgent")
        member(prefix + "_HR", state.hr.userId)
        state.reader = person("Reader", [state.orgA], "uprov.reader", "PrtAgent")
    },
    cleanupSpec() {
        ec.message.clearErrors()
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
})

feature(
    "an HR officer's hire with an account asked records one provisioning operation per key, its account steps waiting for an identity operator; the operator's retry sends the invitation of the work address with the proposal",
    {
        when() {
            const out = {}
            const hired = person("Hired", [state.orgA])
            const changeId = change(hired.partyId, state.orgA, "EckHire", state.hr.userId, {accessRequested: "Y"})
            const plain = change(person("Plain", [state.orgA]).partyId, state.orgA, "EckHire", state.hr.userId, {
                accessRequested: "N"
            })
            const proposal = {bundleGroupIdList: [prefix + "_STAFF"]}
            out.reader = code(
                as(state.reader.username, S + "request#Provisioning", Object.assign({employmentChangeId: changeId}, proposal))
            )
            out.notAsked = code(
                as(state.hr.username, S + "request#Provisioning", Object.assign({employmentChangeId: plain}, proposal))
            )
            out.unregistered = code(
                as(state.hr.username, S + "request#Provisioning", {employmentChangeId: changeId, bundleGroupIdList: ["ADMIN"]})
            )
            // a bundle the HR officer may not give, even by Mantle's service directly (P7 review)
            out.notYours = code(
                as(state.hr.username, S + "request#Provisioning", {
                    employmentChangeId: changeId,
                    bundleGroupIdList: [prefix + "_STAFF", prefix + "_KEYS"]
                })
            )
            const first = as(
                state.hr.username,
                S + "request#Provisioning",
                Object.assign({employmentChangeId: changeId}, proposal)
            )
            const again = as(
                state.hr.username,
                S + "request#Provisioning",
                Object.assign({employmentChangeId: changeId}, proposal)
            )
            out.once = [first.error, first.retried, again.retried, again.operationId === first.operationId]
            const operation = one("mantle.party.UserLifecycleOperation", {operationId: first.operationId})
            out.operation = [
                operation.kindEnumId,
                operation.organizationPartyId === state.orgA,
                operation.userId || "",
                operation.statusId
            ]
            out.steps = steps(first.operationId)
            // the employer's identity operators are told, on the IdentityOperatorRequest topic (the user's call, Nov 11): the
            // operator of A, not the HR officer who asked; the title names the person and employer only
            const told = userId =>
                Array.from(
                    ec.entity
                        .find("moqui.security.user.NotificationMessageUser")
                        .condition("userId", userId)
                        .disableAuthz()
                        .list()
                )
                    .map(row =>
                        one("moqui.security.user.NotificationMessage", {notificationMessageId: row.notificationMessageId})
                    )
                    .filter(
                        message =>
                            message?.topic === "IdentityOperatorRequest" &&
                            String(message.messageJson || "").includes(first.operationId)
                    )
            const notices = told(state.operator.userId)
            out.told = [notices.length, notices[0]?.titleText || "", told(state.hr.userId).length]
            out.recorded =
                one("mantle.humanres.employment.EmploymentChange", {employmentChangeId: changeId}).accessOperationId ===
                first.operationId
            out.operations = rows("mantle.party.UserLifecycleOperation", {sourceReference: "EmploymentChange:" + changeId}).length
            // the identity operator runs the invitation as themselves, under Admin's delegation rules
            const invite = rows("mantle.party.UserLifecycleOperationStep", {
                operationId: first.operationId,
                stepKind: "invite"
            })[0]
            const retried = as(state.operator.username, S + "retry#LifecycleStep", {
                operationId: first.operationId,
                stepSeqId: invite.stepSeqId
            })
            out.retried = [retried.error, retried.applied]
            out.after = steps(first.operationId)
            const invitation = rows("mantle.party.UserInvitation", {partyId: hired.partyId})[0]
            out.invitation = invitation
                ? [
                      invitation.emailAddress,
                      invitation.organizationPartyId === state.orgA,
                      invitation.bundleGroupIds,
                      invitation.inviterUserId === state.operator.userId
                  ]
                : []
            out.again =
                as(state.hr.username, S + "request#Provisioning", Object.assign({employmentChangeId: changeId}, proposal))
                    .operationId === first.operationId
            out.invitations = rows("mantle.party.UserInvitation", {partyId: hired.partyId}).length
            return out
        },
        then(out) {
            out.reader === "RECORD_UNAVAILABLE"
            out.notAsked === "NOT_REQUESTED"
            out.unregistered === "GRANT_INVALID"
            out.notYours === "GRANT_NOT_YOURS"
            out.told.join("|") === "1|An account to set up: Hired Provision (Provision Spec A)|0"
            out.once.join("|") === "|false|true|true"
            out.operation.join("|") === "UlkProvision|true||UlopAttention"
            out.steps === "membership:Done,invite:Waiting(operator),grants:Skipped,notify:Waiting"
            out.recorded === true
            out.operations === 1
            out.retried.join("|") === "|true"
            out.after.startsWith("membership:Done,invite:Done,grants:Skipped,notify:")
            out.invitation.join("|") === "hired.uprov@example.com|true|" + prefix + "_STAFF|true"
            out.again === true
            out.invitations === 1
        }
    }
)

feature(
    "an access end for one employer keeps the account's access for the other; the last employer's ends its memberships, waiting for an identity operator when an HR officer asks",
    {
        when() {
            const out = {}
            const both = person("Both", [state.orgA, state.orgB], "uprov.both")
            member(prefix + "_STAFF", both.userId)
            // separated from A: the employment ends, the account still works for B
            const relationA = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: both.partyId,
                toPartyId: state.orgA
            })[0]
            call("update#mantle.party.PartyRelationship", {
                partyRelationshipId: relationA.partyRelationshipId,
                thruDate: ec.user.nowTimestamp
            })
            const fromA = change(both.partyId, state.orgA, "EckSeparation", state.operator.userId)
            const ended = as(state.operator.username, S + "request#AccessEnd", {employmentChangeId: fromA})
            out.fromA = [ended.error, steps(ended.operationId)]
            out.reason =
                rows("mantle.party.UserLifecycleOperationStep", {operationId: ended.operationId, stepKind: "endMemberships"})[0]
                    ?.reason || ""
            out.kept = rows("moqui.security.UserGroupMember", {userId: both.userId, userGroupId: prefix + "_STAFF"}).filter(
                row => row.thruDate == null
            ).length
            out.retry = as(state.operator.username, S + "request#AccessEnd", {employmentChangeId: fromA}).retried
            // separated from B too, asked by B's HR officer (no identity authority): the memberships' end waits for the operator
            const hrB = person("HrB", [state.orgB], "uprov.hrb", "PrtAgent")
            member(prefix + "_HR", hrB.userId)
            const relationB = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: both.partyId,
                toPartyId: state.orgB
            })[0]
            call("update#mantle.party.PartyRelationship", {
                partyRelationshipId: relationB.partyRelationshipId,
                thruDate: ec.user.nowTimestamp
            })
            const fromB = change(both.partyId, state.orgB, "EckSeparation", state.operator.userId)
            const waiting = as(hrB.username, S + "request#AccessEnd", {employmentChangeId: fromB})
            out.fromB = [waiting.error, steps(waiting.operationId)]
            out.stillMember = rows("moqui.security.UserGroupMember", {
                userId: both.userId,
                userGroupId: prefix + "_STAFF"
            }).filter(row => row.thruDate == null).length
            const memberships = rows("mantle.party.UserLifecycleOperationStep", {
                operationId: waiting.operationId,
                stepKind: "endMemberships"
            })[0]
            const done = as(state.operator.username, S + "retry#LifecycleStep", {
                operationId: waiting.operationId,
                stepSeqId: memberships.stepSeqId
            })
            out.done = [done.error, done.applied]
            out.endedMember = rows("moqui.security.UserGroupMember", {
                userId: both.userId,
                userGroupId: prefix + "_STAFF"
            }).filter(row => row.thruDate == null).length
            // a person with no account has nothing to end
            const noAccount = person("NoAccount", [state.orgA])
            out.none = code(
                as(state.operator.username, S + "request#AccessEnd", {
                    employmentChangeId: change(noAccount.partyId, state.orgA, "EckSeparation", state.operator.userId)
                })
            )
            return out
        },
        then(out) {
            out.fromA.join("|") === "|endRelationships:Done,endMemberships:Skipped"
            out.reason.includes("Provision Spec B")
            out.kept === 1
            out.retry === true
            out.fromB.join("|") === "|endRelationships:Done,revokeSessions:Waiting(operator),endMemberships:Waiting(operator)"
            out.stillMember === 1
            out.done.join("|") === "|true"
            out.endedMember === 0
            out.none === "NO_ACCOUNT"
        }
    }
)
