// An account's lifecycle (service/mantle/party/IdentityServices.xml, Lifecycle.js; mr-boss impl-admin P6, design-admin §4.1
// Offboarding): a global disable revokes access at once (sessions, app passwords, SSH keys) and disables the account for good,
// refused for a shared identity without ADMIN_IDENTITY_GLOBAL; a future end date is the account's terminateDate, with no job; one
// organization's removal ends that organization's relationships and keeps the other's access, memberships and resources, the
// operation still read in the organization it was requested for; a failing participant step (a service without the owned-resource
// contract, a transfer the owner refuses) does not undo the revocation and is retried, a transfer to a new owner through the
// owner's service (Mantle's calendar owner change); restoration enables the account and reactivates no key, and a retry with the
// same operation key answers the first operation. The operators hold the framework's ADMIN_IDENTITY_* and Mantle's
// CALENDAR_OWNER_CHANGE through spec groups, never an app group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/UserLifecycle
const S = "mantle.party.IdentityServices."
const dayMillis = 86400000
const effectiveTime = Date.now()
const run = String(effectiveTime).slice(-7)
const users = {}
const parties = {}
const operations = {}
let orgId
let otherOrgId
let calendarId

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
// as username with artifact authorization on, as a screen calls the services
function as(username, action) {
    ec.user.internalLoginUser(username)
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())
const one = (entityName, conditions) => rows(entityName, conditions)[0]
const operator = () => "ulc.operator." + run
const steps = operationId =>
    rows("mantle.party.UserLifecycleOperationStep", {operationId}).sort((a, b) => a.stepSeqId.localeCompare(b.stepSeqId))
const make = (entityName, fields) => {
    const row = ec.entity.makeValue(entityName)
    row.setFields(fields, true, null, null)
    row.create()
}
// a live browser session, an app password and an SSH key of the account
function credentials(key) {
    const userId = users[key]
    make("moqui.server.Visit", {
        visitId: "ULC_" + key + run,
        userId,
        fromDate: ec.user.nowTimestamp,
        clientIpAddress: "192.0.2.7"
    })
    make("moqui.server.HttpSession", {sessionId: "ULC_S_" + key + run, userId, visitId: "ULC_" + key + run})
    make("moqui.security.UserAppPassword", {
        appPasswordId: "ULC_APP_" + key + run,
        userId,
        name: "Phone mail",
        passwordHash: "ulc-" + key + run,
        createdDate: ec.user.nowTimestamp
    })
    make("moqui.security.UserSshKey", {
        sshKeyId: "ULC_SSH_" + key + run,
        userId,
        fingerprint: "SHA256:ulc" + key + run,
        publicKey: "ssh-ed25519 AAAA ulc",
        fromDate: ec.user.nowTimestamp
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

feature("two internal organizations, their operators, staff with sessions and keys, and a shared identity", {
    when() {
        orgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Lifecycle One Co",
            roleTypeId: "OrgInternal"
        }).partyId
        otherOrgId = call("mantle.party.PartyServices.create#Organization", {
            organizationName: "Lifecycle Two Co",
            roleTypeId: "OrgInternal"
        }).partyId
        const group = userGroupId =>
            rows("moqui.security.UserGroup", {userGroupId}).length ||
            call("create#moqui.security.UserGroup", {userGroupId, description: "Spec " + userGroupId})
        const grant = (userGroupId, userPermissionId) =>
            rows("moqui.security.UserGroupPermission", {userGroupId, userPermissionId}).length ||
            call("create#moqui.security.UserGroupPermission", {
                userGroupId,
                userPermissionId,
                fromDate: effectiveTime - dayMillis
            })
        group("ULC_OPERATORS")
        for (const permission of ["ADMIN_IDENTITY_VIEW", "ADMIN_IDENTITY_MANAGE", "CALENDAR_OWNER_CHANGE"])
            grant("ULC_OPERATORS", permission)
        group("ULC_STAFF")
        const member = (userGroupId, userId) =>
            call("create#moqui.security.UserGroupMember", {userGroupId, userId, fromDate: effectiveTime - dayMillis})
        const person = (key, orgs) => {
            const username = "ulc." + key.toLowerCase() + "." + run
            parties[key] = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Lifecycle"}).partyId
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
        person("Operator", [orgId])
        member("ULC_OPERATORS", users.Operator)
        person("Heir", [orgId])
        for (const key of ["Leaver", "Later", "Broken"]) {
            person(key, [orgId])
            member("ULC_STAFF", users[key])
        }
        person("Shared", [orgId, otherOrgId])
        member("ULC_STAFF", users.Shared)
        credentials("Leaver")
        credentials("Broken")
        // a shared calendar of Broken's, which offboarding hands to a new owner
        calendarId = call("create#mantle.work.calendar.Calendar", {
            calendarName: "Lifecycle team " + run,
            ownerPartyId: parties.Broken,
            calendarKindEnumId: "CalkShared",
            isDefault: "N"
        }).calendarId
    },
    then() {
        users.Operator && users.Shared && calendarId
    }
})

feature(
    "a global disable revokes access at once and disables the account for good; a shared identity needs ADMIN_IDENTITY_GLOBAL",
    {
        when() {
            return as(operator(), () => {
                const preview = result(S + "preview#Lifecycle", {userId: users.Leaver, kind: "disable"})
                const shared = result(S + "preview#Lifecycle", {userId: users.Shared, kind: "disable"})
                const self = result(S + "preview#Lifecycle", {userId: users.Operator, kind: "disable"})
                const started = result(S + "start#Lifecycle", {
                    userId: users.Leaver,
                    kind: "disable",
                    reason: "Left the company",
                    expectedRevision: preview.account?.revision,
                    operationKey: "ULC-LEAVER-" + run
                })
                operations.leaver = started.operationId
                return {preview, shared, self, started}
            })
        },
        then({preview, shared, self, started}) {
            preview.allowed == true && preview.activeSessionCount == 1 && preview.credentialCount >= 2
            preview.movesResources == true
            shared.allowed == false && shared.reasonCode == "IDENTITY_GLOBAL"
            self.allowed == false && self.reasonCode == "SELF"
            started.applied == true && started.statusId == "UlopCompleted"
            const account = one("moqui.security.UserAccount", {userId: users.Leaver})
            account.disabled == "Y" && account.disabledDateTime == null
            one("moqui.server.HttpSession", {visitId: "ULC_Leaver" + run}) == null
            one("moqui.security.UserAppPassword", {appPasswordId: "ULC_APP_Leaver" + run}).revokedDate != null
            one("moqui.security.UserSshKey", {sshKeyId: "ULC_SSH_Leaver" + run}).thruDate != null
            steps(operations.leaver)
                .map(step => step.stepKind + ":" + step.statusId)
                .join() == "revokeAccess:UlstDone,disableAccount:UlstDone"
            // memberships stay on record, unchanged
            rows("moqui.security.UserGroupMember", {userId: users.Leaver, userGroupId: "ULC_STAFF"})[0].thruDate == null
            rows("moqui.entity.EntityAuditLog", {
                changedEntityName: "moqui.security.UserAccount",
                pkPrimaryValue: users.Leaver,
                changedFieldName: "disabled"
            }).some(row => row.changeReason == "Left the company")
        }
    }
)

feature("a future end date is the account's terminateDate, so sign-in stops at that date with no job", {
    when() {
        const jobsBefore = rows("moqui.service.job.ServiceJob", {}).length
        const ending = effectiveTime + 2 * dayMillis
        const started = as(operator(), () =>
            result(S + "start#Lifecycle", {userId: users.Later, kind: "disable", effectiveDate: ending, reason: "Contract ends"})
        )
        return {started, ending, jobsAfter: rows("moqui.service.job.ServiceJob", {}).length, jobsBefore}
    },
    then({started, ending, jobsAfter, jobsBefore}) {
        started.applied == true && started.statusId == "UlopScheduled"
        const account = one("moqui.security.UserAccount", {userId: users.Later})
        account.disabled != "Y" && Math.abs(Number(account.terminateDate) - ending) < 1000
        steps(started.operationId)
            .map(step => step.stepKind + ":" + step.statusId)
            .join() == "endDate:UlstDone"
        jobsAfter == jobsBefore
    }
})

feature("one organization's removal ends its relationships and keeps the other's access; the operation stays readable there", {
    when() {
        return as(operator(), () => {
            const preview = result(S + "preview#Lifecycle", {
                userId: users.Shared,
                kind: "removeOrganization",
                organizationPartyId: orgId
            })
            const started = result(S + "start#Lifecycle", {
                userId: users.Shared,
                kind: "removeOrganization",
                organizationPartyId: orgId,
                reason: "Moved to Two",
                participantSteps: [
                    {
                        providerKey: "spec.calendars",
                        action: "transfer",
                        actionService: "mantle.work.CalendarServices.transfer#CalendarOwner",
                        resourceParameter: "calendarId",
                        resourceId: calendarId
                    }
                ]
            })
            operations.shared = started.operationId
            return {
                preview,
                started,
                read: result(S + "get#Lifecycle", {operationId: started.operationId}),
                account: result(S + "get#Account", {userId: users.Shared})
            }
        })
    },
    then({preview, started, read, account}) {
        preview.allowed == true && preview.endsMemberships == false && preview.movesResources == false
        started.applied == true && started.statusId == "UlopCompleted"
        const relationships = rows("mantle.party.PartyRelationship", {fromPartyId: parties.Shared})
        relationships.find(row => row.toPartyId == orgId).thruDate != null
        relationships.find(row => row.toPartyId == otherOrgId).thruDate == null
        one("moqui.security.UserAccount", {userId: users.Shared}).disabled != "Y"
        rows("moqui.security.UserGroupMember", {userId: users.Shared, userGroupId: "ULC_STAFF"})[0].thruDate == null
        // no participant step: it still works for the other organization
        steps(operations.shared)
            .map(step => step.stepKind)
            .join() == "endRelationships"
        read.error == "" && read.operation.scopeText == "Lifecycle One Co"
        // the identity has left the operator's organization
        account.error.includes("not available")
    }
})

feature(
    "a failing participant step does not undo the revocation; a transfer is retried to a new owner through the owner's service",
    {
        when() {
            return as(operator(), () => {
                const started = result(S + "start#Lifecycle", {
                    userId: users.Broken,
                    kind: "disable",
                    participantSteps: [
                        // a service without the owned-resource contract is never called
                        {
                            providerKey: "spec.bad",
                            action: "pause",
                            actionService: "mantle.party.IdentityServices.store#Account"
                        },
                        {
                            providerKey: "spec.calendars",
                            title: "Shared calendars",
                            action: "transfer",
                            actionService: "mantle.work.CalendarServices.transfer#CalendarOwner",
                            resourceParameter: "calendarId",
                            resourceId: calendarId,
                            resourceName: "Lifecycle team"
                        }
                    ]
                })
                operations.broken = started.operationId
                const list = steps(started.operationId)
                const transfer = list.find(step => step.stepKind == "transfer")
                const pause = list.find(step => step.stepKind == "pause")
                // the owner refuses an ended account as the new owner; then a colleague takes it
                const refusedRetry = result(S + "retry#LifecycleStep", {
                    operationId: started.operationId,
                    stepSeqId: transfer.stepSeqId,
                    toUserId: users.Leaver
                })
                const pauseRetry = result(S + "retry#LifecycleStep", {
                    operationId: started.operationId,
                    stepSeqId: pause.stepSeqId
                })
                const afterRefusal = one("mantle.party.UserLifecycleOperation", {operationId: started.operationId}).statusId
                const moved = result(S + "retry#LifecycleStep", {
                    operationId: started.operationId,
                    stepSeqId: transfer.stepSeqId,
                    toUserId: users.Heir,
                    reason: "Team lead"
                })
                return {
                    started,
                    pauseStep: pause,
                    refusedRetry,
                    pauseRetry,
                    afterRefusal,
                    moved,
                    list: result(S + "find#LifecycleOperations", {userId: users.Broken})
                }
            })
        },
        then({started, pauseStep, refusedRetry, pauseRetry, afterRefusal, moved, list}) {
            started.applied == true && started.statusId == "UlopAttention"
            pauseStep.statusId == "UlstFailed" && pauseStep.reasonCode == "NOT_A_PARTICIPANT"
            refusedRetry.applied == false && refusedRetry.reason.includes("not enabled")
            pauseRetry.applied == false && afterRefusal == "UlopAttention"
            // the revocation stayed in place through the failures
            const account = one("moqui.security.UserAccount", {userId: users.Broken})
            account.disabled == "Y" && account.disabledDateTime == null
            one("moqui.server.HttpSession", {visitId: "ULC_Broken" + run}) == null
            one("moqui.security.UserAppPassword", {appPasswordId: "ULC_APP_Broken" + run}).revokedDate != null
            moved.applied == true && moved.stepStatusId == "UlstDone"
            one("mantle.work.calendar.Calendar", {calendarId}).ownerPartyId == parties.Heir
            const transfer = steps(operations.broken).find(step => step.stepKind == "transfer")
            transfer.toUserId == users.Heir && Number(transfer.attemptCount) == 2
            list.operationList.length == 1 && list.operationList[0].failedCount == 1
        }
    }
)

feature("restoration enables the account and reactivates no key; a retry with the same key answers the first operation", {
    when() {
        return as(operator(), () => ({
            again: result(S + "start#Lifecycle", {
                userId: users.Leaver,
                kind: "disable",
                operationKey: "ULC-LEAVER-" + run
            }),
            restored: result(S + "start#Lifecycle", {userId: users.Leaver, kind: "restore", reason: "Rehired"}),
            twice: result(S + "preview#Lifecycle", {userId: users.Leaver, kind: "restore"})
        }))
    },
    then({again, restored, twice}) {
        again.retried == true && again.operationId == operations.leaver
        restored.applied == true && restored.statusId == "UlopCompleted"
        const account = one("moqui.security.UserAccount", {userId: users.Leaver})
        account.disabled == "N" && account.terminateDate == null
        one("moqui.security.UserAppPassword", {appPasswordId: "ULC_APP_Leaver" + run}).revokedDate != null
        one("moqui.security.UserSshKey", {sshKeyId: "ULC_SSH_Leaver" + run}).thruDate != null
        steps(restored.operationId)
            .map(step => step.stepKind)
            .join() == "enableAccount"
        twice.allowed == false && twice.reasonCode == "NOTHING_TO_RESTORE"
    }
})
