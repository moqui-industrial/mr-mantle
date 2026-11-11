// The import of staff invitations (service/mantle/party/IdentityServices.xml validate#InvitationImportRow,
// apply#InvitationImportRow and find#InvitationImportScopes, Invitations.js; the framework's import target staffInvitations
// through org.moqui.admin.DataTransferServices; mr-boss impl-admin P15, design-admin §4 Invitations' bulk invite, §11.1): a
// bulk invitation is invite#User once per accepted row, as the importer. A file with a password, group or permission column
// is refused whole; the import is for one organization the importer administers; a row is refused, with its reason, for what
// the single invitation refuses (a privileged or sealed-granting bundle, an unregistered one, another organization's staff
// without ADMIN_IDENTITY_GLOBAL, a pending invitation, a repeated address) while the other rows go on; an applied row is not
// invited again when the apply is repeated. The operators hold the framework's permissions through spec groups, never an app
// group. New spec, no Groovy original.
// Run: ./moq test mr-mantle --spec party/StaffInvitationImport
const T = "org.moqui.admin.DataTransferServices."
const TARGET = "staffInvitations"
const dayMillis = 86400000
const effectiveTime = Date.now()
const run = String(effectiveTime).slice(-7)
const users = {}
const parties = {}
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
const has = (value, pattern) => pattern.test(String(value ?? ""))
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())
const step = (verb, params) => result(T + verb, Object.assign({targetId: TARGET}, params))
const email = key => "sinvi." + key + "." + run + "@example.com"
const invitationsOf = key => rows("mantle.party.UserInvitation", {emailAddress: email(key)})
const rowOf = (out, itemSeqId) => Array.from(out.importRows || []).find(row => Number(row.itemSeqId) === itemSeqId)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature(
    "a file with a password or a group column is refused whole, and an import is for an organization the importer administers",
    {
        when() {
            orgId = call("mantle.party.PartyServices.create#Organization", {
                organizationName: "Import One Co",
                roleTypeId: "OrgInternal"
            }).partyId
            otherOrgId = call("mantle.party.PartyServices.create#Organization", {
                organizationName: "Import Two Co",
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
            const bundle = userGroupId =>
                rows("moqui.security.CapabilityBundle", {userGroupId}).length ||
                call("create#moqui.security.CapabilityBundle", {userGroupId, appName: "Spec", description: "Spec " + userGroupId})
            group("SINVI_IMPORTERS")
            for (const permission of [
                "ADMIN_IDENTITY_VIEW",
                "ADMIN_IDENTITY_MANAGE",
                "ADMIN_TRANSFER_VIEW",
                "ADMIN_TRANSFER_RUN"
            ])
                grant("SINVI_IMPORTERS", permission)
            // the identity operator without the transfer permission the registration asks for besides
            group("SINVI_OPERATORS")
            for (const permission of ["ADMIN_IDENTITY_VIEW", "ADMIN_IDENTITY_MANAGE"]) grant("SINVI_OPERATORS", permission)
            group("SINVI_BUNDLE")
            bundle("SINVI_BUNDLE")
            // a registered bundle granting a sealed permission: never in an invitation
            group("SINVI_SEALED")
            grant("SINVI_SEALED", "ADMIN_IDENTITY_GLOBAL")
            bundle("SINVI_SEALED")
            const person = (key, username, orgs, groups) => {
                parties[key] = call("mantle.party.PartyServices.create#Person", {firstName: key, lastName: "Import"}).partyId
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
                for (const userGroupId of groups)
                    call("create#moqui.security.UserGroupMember", {
                        userGroupId,
                        userId: users[key],
                        fromDate: effectiveTime - dayMillis
                    })
            }
            person("Importer", "sinvi.importer." + run, [orgId], ["SINVI_IMPORTERS"])
            person("Operator", "sinvi.operator." + run, [orgId], ["SINVI_OPERATORS"])
            person("Outsider", "sinvi.outsider." + run, [otherOrgId], ["SINVI_IMPORTERS"])
            // a person of the other organization with an account
            person("Existing", "sinvi.existing." + run, [otherOrgId], [])
            const good = "Email,Name,Access bundles\n" + email("probe") + ",Pat Probe,SINVI_BUNDLE\n"
            return as("sinvi.importer." + run, () => ({
                target: result(T + "get#ImportTarget", {targetId: TARGET}),
                password: step("stage#Import", {
                    organizationPartyId: orgId,
                    sourceText: "Email,Name,Access bundles,Password\n" + email("pw") + ",Pat,SINVI_BUNDLE,hunter2\n"
                }),
                group: step("stage#Import", {
                    organizationPartyId: orgId,
                    sourceText: "Email,Access bundles,userGroupId\n" + email("grp") + ",SINVI_BUNDLE,ADMIN\n"
                }),
                permission: step("stage#Import", {
                    organizationPartyId: orgId,
                    sourceText: "Email,Access bundles,Permission ID\n" + email("perm") + ",SINVI_BUNDLE,ADMIN_IDENTITY_GLOBAL\n"
                }),
                otherOrg: step("stage#Import", {organizationPartyId: otherOrgId, sourceText: good}),
                noOrg: step("stage#Import", {sourceText: good}),
                badOption: step("stage#Import", {organizationPartyId: orgId, sourceText: good, batchOptions: {expireDays: 90}}),
                operator: null
            }))
        },
        then(out) {
            const operator = as("sinvi.operator." + run, () =>
                step("stage#Import", {
                    organizationPartyId: orgId,
                    sourceText: "Email,Access bundles\n" + email("op") + ",SINVI_BUNDLE\n"
                })
            )
            // the wizard's target: exactly the designed fields, the importer's organizations, no service name
            Array.from(out.target.target.columnList)
                .map(column => column.name)
                .join(",") == "emailAddress,partyId,displayName,organizationPartyId,bundleGroupIds"
            Array.from(out.target.target.scopeList)
                .map(scope => scope.scopeKey)
                .join(",") == orgId
            !JSON.stringify(out.target.target).includes("Services")
            out.password.reasonCode == "COLUMN_REFUSED"
            out.password.reason.includes("Password")
            out.group.reasonCode == "COLUMN_REFUSED"
            out.permission.reasonCode == "COLUMN_REFUSED"
            has(out.otherOrg.error, /you may import into/)
            has(out.noOrg.error, /you may import into/)
            has(out.badOption.error, /whole number from 1 to 30/)
            has(operator.error, /ADMIN_TRANSFER_RUN is required/)
            invitationsOf("pw").length == 0
            rows("moqui.server.TransferBatch", {targetId: TARGET}).length == 0
        }
    }
)

feature(
    "each row is invited by invite#User's own rules as the importer: the refused rows are named and the others are sent once",
    {
        when() {
            const content = [
                "Email,Name,Access bundles,Organization ID,Existing person ID",
                email("ana") + ",Ana María López,SINVI_BUNDLE,,",
                email("ben") + ",Ben Import,SINVI_BUNDLE," + orgId + ",",
                email("ANA") + ",Ana Again,SINVI_BUNDLE,,",
                email("sealed") + ",Sam Sealed,SINVI_BUNDLE;SINVI_SEALED,,",
                email("admin") + ",Ada Admin,ADMIN,,",
                email("unknown") + ",Uma Unknown,SINVI_NOT_A_BUNDLE,,",
                email("other") + ",Otto Other,SINVI_BUNDLE," + otherOrgId + ",",
                "sinvi.existing." + run + "@example.com,,SINVI_BUNDLE,,",
                email("expr") + ",${ec.user.userId},SINVI_BUNDLE,,",
                "not-an-address,No Address,SINVI_BUNDLE,,"
            ].join("\n")
            const out = {}
            as("sinvi.importer." + run, () => {
                out.staged = step("stage#Import", {
                    organizationPartyId: orgId,
                    sourceText: content,
                    batchOptions: {expireDays: 3, message: "Welcome\naboard"}
                })
                out.validated = step("validate#Import", {
                    operationKey: out.staged.operationKey,
                    mappingRevision: out.staged.mappingRevision
                })
                out.madeByPreview = invitationsOf("ana").length
                out.applied = step("apply#Import", {
                    operationKey: out.staged.operationKey,
                    inputFingerprint: out.validated.inputFingerprint
                })
            })
            // an apply that stopped before a row's result was kept: the row reads valid again, and its invitation is there
            const item = ec.entity.makeValue("moqui.server.TransferItem")
            item.setFields({transferId: out.staged.operationKey, itemSeqId: 1, result: "valid"}, true, null, null)
            item.update()
            as("sinvi.importer." + run, () => {
                const current = step("get#Transfer", {operationKey: out.staged.operationKey})
                out.resumed = step("apply#Import", {
                    operationKey: out.staged.operationKey,
                    inputFingerprint: current.inputFingerprint
                })
            })
            // another organization's importer, who holds every permission, does not read this organization's import
            out.outsider = as("sinvi.outsider." + run, () => ({
                read: step("get#Transfer", {operationKey: out.staged.operationKey}),
                report: step("get#ImportReport", {operationKey: out.staged.operationKey}),
                list: result(T + "find#Transfers", {targetId: TARGET})
            }))
            out.operator = as("sinvi.operator." + run, () => step("get#Transfer", {operationKey: out.staged.operationKey}))
            return out
        },
        then(out) {
            const v = out.validated
            v.validCount == 2
            // nothing is invited by a preview
            out.madeByPreview == 0
            rowOf(v, 1).result == "valid"
            rowOf(v, 2).result == "valid"
            has(rowOf(v, 3).errorMessage, /Repeats row 2/)
            has(rowOf(v, 4).errorMessage, /sealed permission/)
            has(rowOf(v, 5).errorMessage, /privileged group/)
            rowOf(v, 6).result == "invalid"
            has(rowOf(v, 7).errorMessage, /This import is for Import One Co/)
            has(rowOf(v, 8).errorMessage, /ADMIN_IDENTITY_GLOBAL/)
            has(rowOf(v, 9).errorMessage, /plain text/)
            rowOf(v, 10).result == "invalid"
            out.applied.appliedCount == 2
            out.applied.errorCount == 8
            out.applied.state == "partial"
            // the invitations: the importer's, in the batch's organization, with the row's bundles and the batch's options
            const ana = invitationsOf("ana")
            ana.length == 1
            ana[0].inviterUserId == users.Importer
            ana[0].organizationPartyId == orgId
            // the row's bundle, after whatever an app's registration always includes (mr-boss: its users' root group)
            ana[0].bundleGroupIds.split(",").at(-1) == "SINVI_BUNDLE"
            !ana[0].bundleGroupIds.includes("SINVI_SEALED")
            ana[0].firstName == "Ana María"
            ana[0].lastName == "López"
            ana[0].message == "Welcome\naboard"
            Math.round((Number(ana[0].expiresDate) - Number(ana[0].lastUpdatedStamp ?? Date.now())) / dayMillis) <= 3
            rowOf(out.applied, 1).resultRecordId == ana[0].invitationId
            invitationsOf("ben").length == 1
            ;["sealed", "admin", "unknown", "other", "expr"].every(key => invitationsOf(key).length === 0)
            rows("mantle.party.UserInvitation", {emailAddress: "sinvi.existing." + run + "@example.com"}).length == 0
            // the resumed row answers the invitation it made: applied, and not invited again
            out.resumed.appliedCount == 2
            rowOf(out.resumed, 1).result == "applied"
            rowOf(out.resumed, 1).resultRecordId == ana[0].invitationId
            invitationsOf("ana").length == 1
            has(out.outsider.read.error, /not available/)
            has(out.outsider.report.error, /not available/)
            !Array.from(out.outsider.list.transferList || []).some(found => found.runId === out.staged.operationKey)
            // the organization's identity operator holds the owner's view permission, not the transfer's: not available either
            has(out.operator.error, /not available/)
        }
    }
)
