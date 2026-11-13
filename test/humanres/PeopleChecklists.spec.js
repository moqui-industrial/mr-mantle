// People's lifecycle checklists and equipment return (mantle.humanres.PeopleServices find#Checklists, store#Checklist,
// store#ChecklistStep, get#ChecklistTask, get#AssignedEquipment, get#EquipmentCustody, return#Equipment; CalendarDavServices
// get#TaskObjectTags; IronStone People design §4, §12 ChecklistTemplates, §13, F22, F52; impl-people P7): an HR editor keeps their
// employer's templates and another employer's HR neither reads nor changes them; an onboarding task is on the new employee's phone
// and an offboarding task is not; the person and HR read the equipment held and HR returns it to a receiving custodian of the
// employer, completing the return task, as a dated custody change does (Maintenance's, replace#AssetPartyAssignment's
// effectiveDate; the Maintenance merge review). The instantiation itself is WorkProcess's. P16 review: a step linking an exit interview
// is recorded once on its task, by one of its people, on the employer's published exit interview form, with no link; its answers
// read by the task's people and the employer's HR, never by the leaver.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules
// are the services' own checks). Run: ./moq test mr-mantle --spec PeopleChecklists
const prefix = "PEOPLE_CHKL_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const P = "mantle.humanres.PeopleServices."
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
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
}
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Chkl", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People checklist " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    if (!partyId) {
        partyId = person("USER_" + kind)
        for (const organizationPartyId of organizationPartyIds)
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtAgent",
                fromPartyId: partyId,
                toPartyId: organizationPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: since
            })
    }
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// the tasks on a user's phone (CalDAV's Tasks collection)
function phoneTasks(username) {
    login(username)
    ec.artifactExecution.disableAuthz()
    try {
        return Array.from(
            ec.service.sync().name("mantle.work.CalendarDavServices.get#TaskObjectTags").call().objectList || []
        ).map(row => row.workEffortId)
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}

// whether the user sees the task through get#RecordLinkInfo, with authorization on (the record rule under MANTLE_USER_ORG)
function sees(username, workEffortId) {
    login(username)
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name("mantle.party.CommunicationServices.get#RecordLinkInfo")
                .parameters({recordEntityName: "mantle.work.effort.WorkEffort", recordId: workEffortId, checkOnly: true})
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? "error: " + ec.message.getErrorsString() : out.recordVisible === true
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
// the record rule's service opened to the spec's users, filtered by their organizations
function linkInfoFor(userGroupIds) {
    const groupId = prefix + "_RLI"
    call("create#moqui.security.ArtifactGroup", {artifactGroupId: groupId, description: "People checklist record links"})
    call("create#moqui.security.ArtifactGroupMember", {
        artifactGroupId: groupId,
        artifactTypeEnumId: "AT_SERVICE",
        artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
        nameIsPattern: "N",
        inheritAuthz: "Y"
    })
    for (const userGroupId of userGroupIds) {
        const artifactAuthzId = prefix + "_RLI_" + userGroupId.slice(-8)
        call("create#moqui.security.ArtifactAuthz", {
            artifactAuthzId,
            userGroupId,
            artifactGroupId: groupId,
            authzTypeEnumId: "AUTHZT_ALLOW",
            authzActionEnumId: "AUTHZA_ALL"
        })
        call("create#moqui.security.ArtifactAuthzFilter", {artifactAuthzId, entityFilterSetId: "MANTLE_USER_ORG"})
    }
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Checklist Spec A")
        organization(orgB, "People Checklist Spec B")
        state.mgr = person("MGR")
        employ(state.mgr, orgA)
        state.it = person("IT")
        employ(state.it, orgA)
        state.outsider = person("OUTSIDER")
        employ(state.outsider, orgB)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.uMgr = user("MGR", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], [], state.mgr)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "an HR editor keeps their employer's checklist templates: steps with who does them, their offsets and People's facts; a reader and another employer's HR officer neither read nor change them",
    {
        when() {
            const out = {}
            const onboarding = run(state.hr, P + "store#Checklist", {
                organizationPartyId: orgA,
                lifecycleKindEnumId: "ClkOnboarding",
                workEffortName: "Onboarding"
            })
            out.made = onboarding.error
            state.onboarding = onboarding.workEffortId
            const step = parameters =>
                run(
                    state.hr,
                    P + "store#ChecklistStep",
                    Object.assign({templateWorkEffortId: onboarding.workEffortId}, parameters)
                )
            out.handbook = step({
                workEffortName: "Sign the handbook",
                roleTypeId: "Employee",
                dueOffsetDays: 1,
                visibilityEnumId: "ChvEmployee",
                sequenceNum: 1
            }).error
            out.noAssignee = code(step({workEffortName: "Make the account", roleTypeId: "SysAdmin"}))
            out.outsider = code(
                step({workEffortName: "Make the account", roleTypeId: "SysAdmin", assigneePartyId: state.outsider})
            )
            out.it = step({
                workEffortName: "Make the account",
                roleTypeId: "SysAdmin",
                assigneePartyId: state.it,
                sourceLinkEnumId: "ClsItAccess",
                dueOffsetDays: -2,
                sequenceNum: 2
            }).error
            const old = step({workEffortName: "Fax the forms", roleTypeId: "Employee"})
            out.ended = step({workEffortId: old.workEffortId, end: true}).ended
            out.badKind = code(
                run(state.hr, P + "store#Checklist", {
                    organizationPartyId: orgA,
                    lifecycleKindEnumId: "ClkNope",
                    workEffortName: "X"
                })
            )
            out.otherOrg = code(
                run(state.hr, P + "store#Checklist", {
                    organizationPartyId: orgB,
                    lifecycleKindEnumId: "ClkOnboarding",
                    workEffortName: "X"
                })
            )
            const found = run(state.hr, P + "find#Checklists", {organizationPartyId: orgA})
            const template = found.checklists.find(row => row.workEffortId === onboarding.workEffortId)
            out.found = [
                found.canEdit,
                template.kindText,
                template.stepCount,
                template.steps.map(row => row.workEffortName + "/" + row.roleText + "/" + row.dueText).join(";")
            ]
            out.facts = template.steps
                .map(row => [row.sourceLinkEnumId, row.visibilityEnumId, row.assigneePartyId].join("/"))
                .join(";")
            out.reader = code(run(state.reader, P + "find#Checklists", {}))
            out.hrB = run(state.hrB, P + "find#Checklists", {}).checklists.length
            out.hrBStep = code(
                run(state.hrB, P + "store#ChecklistStep", {templateWorkEffortId: onboarding.workEffortId, workEffortName: "No"})
            )
            // an offboarding checklist the employee does; its tasks are protected
            const offboarding = run(state.hr, P + "store#Checklist", {
                organizationPartyId: orgA,
                lifecycleKindEnumId: "ClkOffboarding",
                workEffortName: "Leaving"
            })
            run(state.hr, P + "store#ChecklistStep", {
                templateWorkEffortId: offboarding.workEffortId,
                workEffortName: "Hand over the keys",
                roleTypeId: "Employee"
            })
            return out
        },
        then(out) {
            out.made === ""
            out.handbook === ""
            out.noAssignee === "ASSIGNEE_REQUIRED"
            out.outsider === "ASSIGNEE_OUTSIDE"
            out.it === ""
            out.ended === true
            out.badKind === "KIND_INVALID"
            out.otherOrg === "ORGANIZATION_DENIED"
            out.found.join("|") ===
                "true|Onboarding|2|Sign the handbook/The employee/1 day after;Make the account/IT (a named person)/2 days before"
            out.facts === "/ChvEmployee/;ClsItAccess/ChvStaff/" + state.it
            out.reader === "PERMISSION_DENIED"
            out.hrB === 0
            out.hrBStep === "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "a hire's onboarding task is on the new employee's phone and opened under People by them and HR; the separation's offboarding task is protected, left off the phone",
    {
        when() {
            const out = {}
            const hired = run(state.hr, P + "hire#Employee", {
                organizationPartyId: orgA,
                firstName: "Nova",
                lastName: "Hire",
                workEmail: "nova.hire@chkl.example",
                confirmNewPerson: true,
                managerPartyId: state.mgr,
                operationKey: "CHKL-HIRE"
            })
            out.hired = hired.error
            state.employee = hired.partyId
            state.employment = hired.partyRelationshipId
            state.uEmployee = user("EMP", ["PEOPLE_SELF_SERVICE"], [], hired.partyId)
            const checklist = waitFor(
                () => rows("mantle.humanres.checklist.EmploymentChecklist", {employmentChangeId: hired.employmentChangeId})[0]
            )
            const tasks = checklist ? rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: checklist.workEffortId}) : []
            const handbook = tasks.find(task => task.workEffortName === "Sign the handbook")
            const account = tasks.find(task => task.workEffortName === "Make the account")
            out.assigned = [handbook, account]
                .map(
                    task =>
                        rows("mantle.work.effort.WorkEffortParty", {workEffortId: task?.workEffortId, roleTypeId: "Assignee"})[0]
                            ?.partyId
                )
                .join(",")
            out.onPhone = phoneTasks(state.uEmployee).includes(handbook?.workEffortId)
            const asEmployee = run(state.uEmployee, P + "get#ChecklistTask", {workEffortId: handbook?.workEffortId})
            out.employee = [asEmployee.error, asEmployee.kindText, asEmployee.partyId || ""]
            out.asHr = run(state.hr, P + "get#ChecklistTask", {workEffortId: account?.workEffortId})
            out.hr = [out.asHr.error, out.asHr.partyId === hired.partyId, out.asHr.sourceLinkEnumId, out.asHr.access?.statusText]
            out.reader = code(run(state.reader, P + "get#ChecklistTask", {workEffortId: handbook?.workEffortId}))
            // the separation, approved by the manager: its offboarding task is the employee's, protected
            const revision = run(state.hr, P + "preview#EmploymentChange", {
                partyRelationshipId: state.employment,
                changeKind: "separation"
            }).revision
            const asked = run(state.hr, P + "apply#EmploymentChange", {
                partyRelationshipId: state.employment,
                changeKind: "separation",
                reason: "Moving away",
                expectedRevision: revision
            })
            const decided = run(state.uMgr, P + "decide#EmploymentChange", {employmentChangeId: asked.employmentChangeId})
            out.separated = [asked.error, decided.error, decided.applied]
            const offboarding = waitFor(() =>
                rows("mantle.humanres.checklist.EmploymentChecklist", {employmentChangeId: asked.employmentChangeId}).find(
                    row => row.templateWorkEffortId
                )
            )
            const keys = offboarding
                ? rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: offboarding.workEffortId})[0]
                : null
            out.keys = [
                !!keys,
                rows("mantle.humanres.checklist.ChecklistStep", {workEffortId: keys?.workEffortId})[0]?.isProtected
            ]
            const phone = phoneTasks(state.uEmployee)
            out.phone = [phone.includes(keys?.workEffortId), phone.includes(handbook?.workEffortId)]
            // P8: the offboarding task's assignee is told on PeopleTaskAssigned, whose title names neither the task nor the person,
            // and not on the generic WorkItemAssigned, whose title would
            const notices = topic =>
                rows("moqui.security.user.NotificationMessageByUser", {userId: state.uEmployee, topic}).filter(
                    row => row.recordId === keys?.workEffortId
                )
            const told = waitFor(() => notices("PeopleTaskAssigned")[0])
            // P8: the leaver's own due work and self-service leave out the protected task assigned to them (P7's rule); HR of the
            // employer reads it among the employer's lifecycle tasks
            const dueIds = (user, kinds) =>
                (run(user, P + "find#DueWork", {kinds, pageSize: 100}).dueWork || []).map(row => row.workEffortId)
            const mine = dueIds(state.uEmployee, "myTask")
            out.due = [
                mine.includes(handbook?.workEffortId),
                mine.includes(keys?.workEffortId),
                run(state.uEmployee, P + "get#SelfService").openTaskCount,
                dueIds(state.hr, "checklistTask").includes(keys?.workEffortId)
            ]
            out.notice = [
                !!told,
                notices("WorkItemAssigned").length,
                /Nova|Offboarding|keys/i.test(String(told?.titleText || "")) ? told.titleText : ""
            ]
            return out
        },
        then(out) {
            out.hired === ""
            out.assigned === state.employee + "," + state.it
            out.onPhone === true
            out.employee.join("|") === "|Onboarding|"
            out.hr.join("|") === "|true|ClsItAccess|No account was asked for"
            out.reader === "RECORD_UNAVAILABLE"
            out.separated.join("|") === "||true"
            out.keys.join("|") === "true|Y"
            out.phone.join("|") === "false|true"
            out.notice.join("|") === "true|0|"
            out.due.join("|") === "true|false|1|true"
        }
    }
)

feature(
    "the equipment a person holds is read by them and by HR of their employer, never a reader; HR returns it to a receiving custodian of the employer, completing its return task, and is refused one outside it",
    {
        when() {
            const out = {}
            const holder = person("HOLDER")
            const employment = employ(holder, orgA)
            const uHolder = user("HOLDER", ["PEOPLE_SELF_SERVICE"], [], holder)
            const assetId = call("create#mantle.product.asset.Asset", {
                assetTypeEnumId: "AstTpEquipment",
                assetName: "Chkl phone",
                serialNumber: "SN-77",
                ownerPartyId: orgA
            }).assetId
            call("create#mantle.product.asset.AssetPartyAssignment", {
                assetId,
                partyId: holder,
                roleTypeId: "Custodian",
                fromDate: since
            })
            const asHr = run(state.hr, P + "get#AssignedEquipment", {partyId: holder})
            out.hr = [
                asHr.error,
                asHr.canReturn,
                asHr.equipmentList.map(row => row.assetName + "/" + row.serialNumber + "/" + row.roleText).join(";")
            ]
            out.self = run(uHolder, P + "get#AssignedEquipment", {partyId: holder}).equipmentList?.length
            out.reader = code(run(state.reader, P + "get#AssignedEquipment", {partyId: holder}))
            out.hrB = code(run(state.hrB, P + "get#AssignedEquipment", {partyId: holder}))
            // P23 review (F10): with checkOnly, as Employee360 asks for every viewer, one who reads none is answered none, not refused
            const checked = run(state.reader, P + "get#AssignedEquipment", {partyId: holder, checkOnly: true})
            out.readerChecked = [checked.error, checked.equipmentList == null]
            // a return task of the holding (as a separation raises one)
            const rootId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Equipment return: Chkl HOLDER"
            }).workEffortId
            call("create#mantle.humanres.checklist.EmploymentChecklist", {
                workEffortId: rootId,
                partyRelationshipId: employment,
                partyId: holder,
                organizationPartyId: orgA,
                lifecycleKindEnumId: "ClkOffboarding",
                startedDate: ec.user.nowTimestamp
            })
            const taskId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Return Chkl phone",
                parentWorkEffortId: rootId,
                rootWorkEffortId: rootId
            }).workEffortId
            call("create#mantle.work.effort.WorkEffortAssetAssign", {
                workEffortId: taskId,
                assetId,
                fromDate: since,
                statusId: "WeaaAssigned"
            })
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: taskId,
                partyId: holder,
                roleTypeId: "Custodian",
                fromDate: since
            })
            call("create#mantle.humanres.checklist.ChecklistStep", {
                workEffortId: taskId,
                sourceLinkEnumId: "ClsEquipmentReturn",
                isProtected: "Y"
            })
            // the manager does it: the protected task is theirs to reach, never its holder's or a colleague's (P7 review, F22)
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: taskId,
                partyId: state.mgr,
                roleTypeId: "Assignee",
                fromDate: since,
                statusId: "WeptAssigned"
            })
            linkInfoFor([state.uMgr, uHolder, state.reader])
            out.reach = [sees(state.uMgr, taskId), sees(uHolder, taskId), sees(state.reader, taskId)]
            const myTasks = username =>
                Array.from(run(username, "mantle.work.TaskServices.get#MyTasks", {}).taskList || []).map(row => row.workEffortId)
            out.myTasks = [myTasks(state.uMgr).includes(taskId), myTasks(uHolder).includes(taskId)]
            out.context = [
                code(run(state.uMgr, P + "get#ChecklistTask", {workEffortId: taskId})),
                code(run(uHolder, P + "get#ChecklistTask", {workEffortId: taskId}))
            ]
            out.listed = run(state.hr, P + "get#AssignedEquipment", {partyId: holder}).equipmentList[0].returnTaskId === taskId
            const returning = {assetId, partyId: holder, roleTypeId: "Custodian"}
            out.outside = code(run(state.hr, P + "return#Equipment", Object.assign({newPartyId: state.outsider}, returning)))
            out.readerReturn = code(run(state.reader, P + "return#Equipment", Object.assign({newPartyId: state.mgr}, returning)))
            const returned = run(state.hr, P + "return#Equipment", Object.assign({newPartyId: state.mgr}, returning))
            out.returned = [returned.error, returned.completed]
            out.task = rows("mantle.work.effort.WorkEffort", {workEffortId: taskId})[0].statusId
            const custody = run(state.hr, P + "get#EquipmentCustody", {assetId})
            out.custody = [
                custody.error,
                custody.asset.serialNumber,
                custody.custodyList.map(row => row.holderName + "/" + row.current).join(";")
            ]
            out.custodyB = code(run(state.hrB, P + "get#EquipmentCustody", {assetId}))
            out.employment = !!employment
            return out
        },
        then(out) {
            out.hr.join("|") === "|true|Chkl phone/SN-77/Custodian"
            out.reach.join("|") === "true|false|false"
            out.myTasks.join("|") === "false|false"
            out.context.join("|") === "|RECORD_UNAVAILABLE"
            out.self === 1
            out.reader === "RECORD_UNAVAILABLE"
            out.hrB === "RECORD_UNAVAILABLE"
            out.readerChecked == ["", true]
            out.listed === true
            out.outside === "CUSTODIAN_INVALID"
            out.readerReturn === "PERMISSION_DENIED"
            out.returned.join("|") === "|true"
            out.task === "WeComplete"
            out.custody.join("|") === "|SN-77|Chkl MGR/true;Chkl HOLDER/false"
            out.custodyB === "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "a dated custody change (Maintenance's change#MaintenanceCustody passes replace#AssetPartyAssignment an effectiveDate) ends the holding on that date and completes its return task; a later date is refused and changes nothing",
    {
        when() {
            // the Maintenance merge review (Nov 12): P7's rule on the holding's end holds for an end dated earlier than now
            const holder = person("DATED")
            const employment = employ(holder, orgA)
            const assetId = call("create#mantle.product.asset.Asset", {
                assetTypeEnumId: "AstTpEquipment",
                assetName: "Chkl drill",
                ownerPartyId: orgA
            }).assetId
            call("create#mantle.product.asset.AssetPartyAssignment", {
                assetId,
                partyId: holder,
                roleTypeId: "Custodian",
                fromDate: since
            })
            const rootId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Equipment return: Chkl DATED"
            }).workEffortId
            call("create#mantle.humanres.checklist.EmploymentChecklist", {
                workEffortId: rootId,
                partyRelationshipId: employment,
                partyId: holder,
                organizationPartyId: orgA,
                lifecycleKindEnumId: "ClkOffboarding",
                startedDate: ec.user.nowTimestamp
            })
            const taskId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Return Chkl drill",
                parentWorkEffortId: rootId,
                rootWorkEffortId: rootId
            }).workEffortId
            call("create#mantle.work.effort.WorkEffortAssetAssign", {
                workEffortId: taskId,
                assetId,
                fromDate: since,
                statusId: "WeaaAssigned"
            })
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: taskId,
                partyId: holder,
                roleTypeId: "Custodian",
                fromDate: since
            })
            call("create#mantle.humanres.checklist.ChecklistStep", {
                workEffortId: taskId,
                sourceLinkEnumId: "ClsEquipmentReturn",
                isProtected: "Y"
            })
            const nowMs = Number(ec.user.nowTimestamp)
            const replace = effectiveDate =>
                run("john.doe", "mantle.product.AssetServices.replace#AssetPartyAssignment", {
                    assetId,
                    roleTypeId: "Custodian",
                    newPartyId: state.mgr,
                    effectiveDate
                })
            const holding = () =>
                rows("mantle.product.asset.AssetPartyAssignment", {assetId, partyId: holder, roleTypeId: "Custodian"})[0]
            const taskStatus = () => rows("mantle.work.effort.WorkEffort", {workEffortId: taskId})[0].statusId
            const later = code(replace(new Date(nowMs + 2 * 86400000).toISOString()))
            const afterLater = [holding().thruDate == null, taskStatus()]
            const effective = Math.floor((nowMs - 2 * 86400000) / 1000) * 1000
            const dated = replace(new Date(effective).toISOString())
            const received = rows("mantle.product.asset.AssetPartyAssignment", {
                assetId,
                partyId: state.mgr,
                roleTypeId: "Custodian"
            })
            return {
                later,
                afterLater,
                dated: dated.error,
                endedAt: Number(holding().thruDate) === effective,
                receivedFrom: received.length === 1 && Number(received[0].fromDate) === effective,
                task: taskStatus()
            }
        },
        then(out) {
            out.later === "DATE_FUTURE"
            out.afterLater.join("|") === "true|WeInPlanning"
            out.dated === ""
            out.endedAt === true
            out.receivedFrom === true
            out.task === "WeComplete"
        }
    }
)

feature(
    "an exit interview step is recorded once on its task by its interviewer, read by HR of the employer and never by the leaver",
    {
        when() {
            const out = {}
            const leaver = person("LEAVER")
            const employment = employ(leaver, orgA)
            const uLeaver = user("LEAVER", ["PEOPLE_SELF_SERVICE"], [], leaver)
            const uConfig = user("CONFIG", ["PEOPLE_CONFIGURE"], [orgA])
            // the employer's exit interview form (the form rules are FormDefinitions')
            const F = "mantle.party.FormDefinitionServices."
            const formId = run(uConfig, F + "create#Form", {
                purposeEnumId: "DbfpExitInterview",
                organizationPartyId: orgA,
                description: "Exit interview"
            }).formId
            run(uConfig, F + "save#FormField", {
                formId,
                newFieldName: "why",
                title: "Why are you leaving",
                fieldTypeEnumId: "DBFFT_text-area",
                isRequired: "Y"
            })
            run(uConfig, F + "publish#Form", {formId})
            const rootId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Offboarding: Chkl LEAVER"
            }).workEffortId
            call("create#mantle.humanres.checklist.EmploymentChecklist", {
                workEffortId: rootId,
                partyRelationshipId: employment,
                partyId: leaver,
                organizationPartyId: orgA,
                lifecycleKindEnumId: "ClkOffboarding",
                startedDate: ec.user.nowTimestamp
            })
            const taskId = call("create#mantle.work.effort.WorkEffort", {
                workEffortTypeEnumId: "WetTask",
                statusId: "WeInPlanning",
                workEffortName: "Hold the exit interview",
                parentWorkEffortId: rootId,
                rootWorkEffortId: rootId
            }).workEffortId
            call("create#mantle.humanres.checklist.ChecklistStep", {
                workEffortId: taskId,
                sourceLinkEnumId: "ClsExitInterview",
                visibilityEnumId: "ChvStaff",
                isProtected: "Y"
            })
            call("create#mantle.work.effort.WorkEffortParty", {
                workEffortId: taskId,
                partyId: state.mgr,
                roleTypeId: "Assignee",
                fromDate: since,
                statusId: "WeptAssigned"
            })
            const submit = (username, values) => run(username, P + "submit#ExitInterview", {workEffortId: taskId, values})
            const before = run(state.uMgr, P + "get#ChecklistTask", {workEffortId: taskId}).exitInterview
            out.before = [before.formId === formId, before.canAnswer, before.answered]
            out.byLeaver = code(submit(uLeaver, {why: "Moving"}))
            out.byReader = code(submit(state.reader, {why: "Moving"}))
            out.missing = code(submit(state.uMgr, {}))
            out.recorded = submit(state.uMgr, {why: "Moving to the coast"}).error
            out.again = code(submit(state.uMgr, {why: "Again"}))
            const asHr = run(state.hr, P + "get#ChecklistTask", {workEffortId: taskId}).exitInterview
            out.hr = [asHr.answered, asHr.canAnswer, asHr.answers.map(answer => answer.displayText).join()]
            out.hrB = code(run(state.hrB, P + "get#ChecklistTask", {workEffortId: taskId}))
            out.leaverRead = code(run(uLeaver, P + "get#ChecklistTask", {workEffortId: taskId}))
            const invitation = rows("mantle.party.FormInvitation", {invitationKey: "exit:" + taskId})[0]
            out.invitation = [invitation.partyId === leaver, invitation.recordId === taskId, invitation.statusEnumId]
            out.link = ec.resource.script("component://mr-mantle/service/mantle/party/FormPublication.js").linkAllowed(formId)
            return out
        },
        then(out) {
            out.before.join("|") === "true|true|false"
            out.byLeaver === "RECORD_UNAVAILABLE"
            out.byReader === "RECORD_UNAVAILABLE"
            out.missing === "FORM_VALUES_INVALID"
            out.recorded === ""
            out.again === "ALREADY_ANSWERED"
            out.hr.join("|") === "true|false|Moving to the coast"
            out.hrB === "RECORD_UNAVAILABLE"
            out.leaverRead === "RECORD_UNAVAILABLE"
            out.invitation.join("|") === "true|true|FinResponded"
            out.link === false
        }
    }
)
