// A reusable WorkEffort process (mantle.work.ProcessServices store#ProcessStep, instantiate#WorkProcess and check#ManagedWork;
// IronStone Maintenance design §4.1 and §4.2, MT-03, the first part built by impl-people P7): a template instantiated once per key,
// each step copied fresh with its due date and its assignee by role, its dependency remapped inside the new tree and each node
// linked to its template node; a tree that fails part way leaves nothing; a task of a process whose policy guards execution refused
// by the generic task services while a People checklist task is completed by set#TaskStatus; a hire starting its checklist after
// commit, a failing template leaving the hire; a separation's return task completed when the holding ends. It must pass unchanged
// after Maintenance's P6 (which extends these records and services and sets the flag for its procedures).
// Standalone: spec-local organization, people, groups and users, with artifact authorization disabled (the rules are the services'
// own checks). Run: ./moq test mr-mantle --spec WorkProcess
const prefix = "WORK_PROC_SPEC"
const org = prefix + "_ORG"
const since = "2001-01-01T00:00:00Z"
const W = "mantle.work.ProcessServices."
const P = "mantle.humanres.PeopleServices."
const state = {}
const day = 24 * 60 * 60 * 1000

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
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const ms = value => (value == null ? null : ec.user.timestampMillis(value))
function waitFor(read, millis = 5000) {
    const end = Date.now() + millis
    let value = read()
    while (!value && Date.now() < end) value = read()
    return value
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Proc", lastName: kind})
    return partyId
}
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Work process " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
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
// a template root of a policy (People's checklist policy unless named), guarding execution or not
function templateRoot(name, guards = "N") {
    const workEffortId = call("create#mantle.work.effort.WorkEffort", {
        workEffortTypeEnumId: "WetTask",
        purposeEnumId: "WepPrOrgMgmt",
        isTemplate: "Y",
        statusId: "WeInPlanning",
        workEffortName: name,
        ownerPartyId: org
    }).workEffortId
    call("create#mantle.work.effort.WorkEffortProcessPolicy", {
        workEffortId,
        fromDate: since,
        processPolicyEnumId: "WppPeopleChecklist",
        guardsExecution: guards
    })
    return workEffortId
}
const basedOn = templateId =>
    rows("mantle.work.effort.WorkEffortAssoc", {toWorkEffortId: templateId, workEffortAssocTypeEnumId: "WeatBasedOn"})

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Work Process Spec Org"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        state.hrParty = person("HR")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: state.hrParty,
            toPartyId: org,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.readerParty = person("READER")
        state.reader = user("READER", ["PEOPLE_HR_VIEW"], state.readerParty)
        state.worker = person("WORKER")
        state.mgr = person("MGR")
        call("mantle.humanres.EmploymentServices.create#Employment", {fromPartyId: state.mgr, toPartyId: org, fromDate: since})
        state.uMgr = user("MGR", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], state.mgr)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a template is instantiated once per key: each step in effect copied fresh with its due date and its assignee by role, its dependency remapped inside the new tree, each node linked to its template node, the template left as it was",
    {
        when() {
            const out = {}
            const templateId = templateRoot("Onboarding template")
            state.templateId = templateId
            const step = parameters =>
                run(state.hr, W + "store#ProcessStep", Object.assign({rootWorkEffortId: templateId}, parameters))
            const a = step({workEffortName: "Sign the handbook", roleTypeId: "Employee", dueOffsetDays: 2, sequenceNum: 1})
            const b = step({
                workEffortName: "Set up the laptop",
                roleTypeId: "HumanResourcesManager",
                dueOffsetDays: 5,
                sequenceNum: 2
            })
            const c = step({workEffortName: "Old step", roleTypeId: "Employee", dueOffsetDays: 1, sequenceNum: 3})
            out.made = [a.error, b.error, c.error]
            out.depends = step({workEffortId: b.workEffortId, dependsOnIds: [a.workEffortId]}).error
            out.cycle = code(step({workEffortId: a.workEffortId, dependsOnIds: [b.workEffortId]}))
            out.ended = step({workEffortId: c.workEffortId, end: true}).ended
            out.reader = code(run(state.reader, W + "store#ProcessStep", {rootWorkEffortId: templateId, workEffortName: "No"}))
            const startDate = new Date(Date.now() + 10 * day)
            const parameters = {
                templateWorkEffortId: templateId,
                operationKey: "WORK-PROC-1",
                startDate,
                roleParties: {Employee: state.worker, HumanResourcesManager: state.hrParty},
                rootFields: {workEffortName: "Onboarding: Proc Worker"}
            }
            out.readerInstantiate = code(run(state.reader, W + "instantiate#WorkProcess", parameters))
            const first = run(state.hr, W + "instantiate#WorkProcess", parameters)
            const again = run(state.hr, W + "instantiate#WorkProcess", parameters)
            out.once = [first.error, first.repeated, again.repeated, again.workEffortId === first.workEffortId]
            const root = one("mantle.work.effort.WorkEffort", {workEffortId: first.workEffortId})
            out.root = [root.workEffortName, root.isTemplate, root.rootWorkEffortId || ""]
            const tasks = rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: first.workEffortId})
            out.taskCount = tasks.length
            const newA = first.idMap[a.workEffortId]
            const newB = first.idMap[b.workEffortId]
            out.leftOut = first.idMap[c.workEffortId] == null
            const taskA = one("mantle.work.effort.WorkEffort", {workEffortId: newA})
            out.fresh = [taskA.isTemplate, taskA.statusId, taskA.workEffortName, taskA.parentWorkEffortId === first.workEffortId]
            out.due = Math.round((ms(taskA.estimatedCompletionDate) - startDate.getTime()) / day)
            out.dependency = rows("mantle.work.effort.WorkEffortAssoc", {
                workEffortId: newB,
                workEffortAssocTypeEnumId: "WeatDependsOn"
            })
                .map(row => row.toWorkEffortId === newA)
                .join(",")
            out.links =
                [first.workEffortId, newA, newB]
                    .map(
                        id =>
                            rows("mantle.work.effort.WorkEffortAssoc", {
                                workEffortId: id,
                                workEffortAssocTypeEnumId: "WeatBasedOn"
                            }).map(row => row.toWorkEffortId)[0]
                    )
                    .join(",") === [templateId, a.workEffortId, b.workEffortId].join(",")
            out.assignees = [newA, newB]
                .map(id =>
                    rows("mantle.work.effort.WorkEffortParty", {workEffortId: id, roleTypeId: "Assignee"})
                        .map(row => row.partyId)
                        .join("")
                )
                .join(",")
            out.policies = [
                rows("mantle.work.effort.WorkEffortStepPolicy", {workEffortId: newB})
                    .map(row => row.roleTypeId + "/" + row.dueOffsetDays)
                    .join(""),
                rows("mantle.work.effort.WorkEffortProcessPolicy", {workEffortId: first.workEffortId})
                    .map(row => row.processPolicyEnumId + "/" + row.guardsExecution + "/" + row.operationKey)
                    .join("")
            ]
            out.templateSteps = rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: templateId}).filter(
                row => row.isTemplate === "Y"
            ).length
            state.taskA = newA
            return out
        },
        then(out) {
            out.made.join("") === ""
            out.depends === ""
            out.cycle === "DEPENDENCY_INVALID"
            out.ended === true
            out.reader === "PERMISSION_DENIED"
            out.readerInstantiate === "PERMISSION_DENIED"
            out.once.join("|") === "|false|true|true"
            out.root.join("|") === "Onboarding: Proc Worker|N|"
            out.taskCount === 2
            out.leftOut === true
            out.fresh.join("|") === "N|WeInPlanning|Sign the handbook|true"
            out.due === 2
            out.dependency === "true"
            out.links === true
            out.assignees === state.worker + "," + state.hrParty
            out.policies.join("|") === "HumanResourcesManager/5|WppPeopleChecklist/N/WORK-PROC-1"
            out.templateSteps === 3
        }
    }
)

feature("a tree that fails part way leaves nothing of itself: its one transaction rolls back", {
    when() {
        const before = basedOn(state.templateId).length
        const failed = run(state.hr, W + "instantiate#WorkProcess", {
            templateWorkEffortId: state.templateId,
            operationKey: "WORK-PROC-FAIL",
            roleParties: {Employee: prefix + "_NO_SUCH_PARTY"}
        })
        return {
            failed: !!failed.error,
            after: basedOn(state.templateId).length - before,
            policy: rows("mantle.work.effort.WorkEffortProcessPolicy", {operationKey: "WORK-PROC-FAIL"}).length
        }
    },
    then(out) {
        out.failed === true
        out.after === 0
        out.policy === 0
    }
})

feature(
    "managed work: the generic task services refuse a task of a process whose policy guards execution; a People checklist task is an ordinary task, completed by set#TaskStatus",
    {
        when() {
            const out = {}
            out.complete = run(state.hr, "mantle.work.TaskServices.set#TaskStatus", {
                workEffortId: state.taskA,
                statusId: "WeComplete"
            }).error
            out.status = one("mantle.work.effort.WorkEffort", {workEffortId: state.taskA}).statusId
            out.check = code(run(state.hr, W + "check#ManagedWork", {workEffortId: state.taskA}))
            // a guarded process's execution: its root carries the policy that guards
            const guarded = templateRoot("Guarded procedure", "Y")
            run(state.hr, W + "store#ProcessStep", {rootWorkEffortId: guarded, workEffortName: "Torque the bolts"})
            const made = run(state.hr, W + "instantiate#WorkProcess", {
                templateWorkEffortId: guarded,
                operationKey: "WORK-PROC-GUARD"
            })
            const task = Object.values(made.idMap).find(id => id !== made.workEffortId)
            out.update = code(
                run(state.hr, "mantle.work.TaskServices.update#Task", {workEffortId: task, workEffortName: "Changed"})
            )
            out.status2 = code(
                run(state.hr, "mantle.work.TaskServices.set#TaskStatus", {workEffortId: task, statusId: "WeComplete"})
            )
            out.party = code(
                run(state.hr, "mantle.work.WorkEffortServices.add#WorkEffortParty", {
                    workEffortId: task,
                    partyId: state.worker,
                    roleTypeId: "Assignee"
                })
            )
            out.name = one("mantle.work.effort.WorkEffort", {workEffortId: task}).workEffortName
            // nor is a task added under it
            out.added = code(
                run(state.hr, "mantle.work.TaskServices.create#Task", {
                    workEffortName: "Extra step",
                    parentWorkEffortId: task,
                    rootWorkEffortId: made.workEffortId
                })
            )
            out.children = rows("mantle.work.effort.WorkEffort", {parentWorkEffortId: task}).length
            return out
        },
        then(out) {
            out.added === "MANAGED_WORK"
            out.children === 0
            out.complete === ""
            out.status === "WeComplete"
            out.check === ""
            out.update === "MANAGED_WORK"
            out.status2 === "MANAGED_WORK"
            out.party === "MANAGED_WORK"
            out.name === "Torque the bolts"
        }
    }
)

feature(
    "a hire starts its employer's onboarding checklist after commit; a template that fails is logged and leaves the hire and the other checklist",
    {
        when() {
            const out = {}
            // two onboarding checklists of the employer; the second's process is no longer in use, so its start fails
            const good = run(state.hr, P + "store#Checklist", {
                organizationPartyId: org,
                lifecycleKindEnumId: "ClkOnboarding",
                workEffortName: "Welcome"
            })
            run(state.hr, P + "store#ChecklistStep", {
                templateWorkEffortId: good.workEffortId,
                workEffortName: "Read the welcome pack",
                roleTypeId: "Employee",
                dueOffsetDays: 1
            })
            const bad = run(state.hr, P + "store#Checklist", {
                organizationPartyId: org,
                lifecycleKindEnumId: "ClkOnboarding",
                workEffortName: "Broken"
            })
            run(state.hr, P + "store#ChecklistStep", {
                templateWorkEffortId: bad.workEffortId,
                workEffortName: "Never",
                roleTypeId: "Employee"
            })
            const policy = rows("mantle.work.effort.WorkEffortProcessPolicy", {workEffortId: bad.workEffortId})[0]
            call("update#mantle.work.effort.WorkEffortProcessPolicy", {
                workEffortId: bad.workEffortId,
                fromDate: policy.fromDate,
                thruDate: since
            })
            const hired = run(state.hr, P + "hire#Employee", {
                organizationPartyId: org,
                firstName: "Newly",
                lastName: "Hired",
                workEmail: "newly.hired@workproc.example",
                confirmNewPerson: true,
                managerPartyId: state.mgr,
                operationKey: "WORK-PROC-HIRE"
            })
            out.hired = hired.error
            const checklist = waitFor(
                () => rows("mantle.humanres.checklist.EmploymentChecklist", {employmentChangeId: hired.employmentChangeId})[0]
            )
            out.started = !!checklist && checklist.templateWorkEffortId === good.workEffortId
            out.count = rows("mantle.humanres.checklist.EmploymentChecklist", {
                employmentChangeId: hired.employmentChangeId
            }).length
            out.badTree = basedOn(bad.workEffortId).length
            out.employed = rows("mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtEmployee",
                fromPartyId: hired.partyId,
                toPartyId: org
            }).length
            out.assigned = checklist
                ? rows("mantle.work.effort.WorkEffort", {rootWorkEffortId: checklist.workEffortId})
                      .map(
                          task =>
                              rows("mantle.work.effort.WorkEffortParty", {
                                  workEffortId: task.workEffortId,
                                  roleTypeId: "Assignee"
                              })[0]?.partyId
                      )
                      .join(",")
                : ""
            state.hired = hired
            return out
        },
        then(out) {
            out.hired === ""
            out.started === true
            out.count === 1
            out.badTree === 0
            out.employed === 1
            out.assigned === state.hired.partyId
        }
    }
)

feature(
    "a separation raises a return task per asset the person holds on its date, naming the holding; ending the holding (replace#AssetPartyAssignment, as Warehouse does) completes it",
    {
        when() {
            const out = {}
            const partyId = state.hired.partyId
            const assetId = call("create#mantle.product.asset.Asset", {
                assetTypeEnumId: "AstTpEquipment",
                assetName: "Spec laptop",
                ownerPartyId: org
            }).assetId
            call("create#mantle.product.asset.AssetPartyAssignment", {assetId, partyId, roleTypeId: "Custodian", fromDate: since})
            const employment = state.hired.partyRelationshipId
            const revision = run(state.hr, P + "preview#EmploymentChange", {
                partyRelationshipId: employment,
                changeKind: "separation"
            }).revision
            const asked = run(state.hr, P + "apply#EmploymentChange", {
                partyRelationshipId: employment,
                changeKind: "separation",
                reason: "Leaving",
                expectedRevision: revision
            })
            out.asked = [asked.error, asked.statusId]
            // the manager approves; the last approval applies it and, after commit, raises the return task
            const decided = run(state.uMgr, P + "decide#EmploymentChange", {employmentChangeId: asked.employmentChangeId})
            out.decided = [decided.error, decided.applied]
            const task = waitFor(() => {
                const ids = rows("mantle.work.effort.WorkEffortAssetAssign", {assetId}).map(row => row.workEffortId)
                return ids.find(
                    id =>
                        rows("mantle.humanres.checklist.ChecklistStep", {
                            workEffortId: id,
                            sourceLinkEnumId: "ClsEquipmentReturn"
                        }).length
                )
            })
            out.task = !!task
            out.names = task
                ? [
                      rows("mantle.work.effort.WorkEffortParty", {workEffortId: task, partyId, roleTypeId: "Custodian"}).length,
                      // the leaver's manager does it (the user's call, Nov 11)
                      rows("mantle.work.effort.WorkEffortParty", {workEffortId: task, roleTypeId: "Assignee"})
                          .map(row => row.partyId === state.mgr)
                          .join(","),
                      rows("mantle.humanres.checklist.ChecklistStep", {workEffortId: task})[0].isProtected,
                      one("mantle.work.effort.WorkEffort", {workEffortId: task}).statusId
                  ].join("|")
                : ""
            // the holding returned to the HR officer as Warehouse ends a custody: the rule completes the task
            run("john.doe", "mantle.product.AssetServices.replace#AssetPartyAssignment", {
                assetId,
                roleTypeId: "Custodian",
                newPartyId: state.hrParty
            })
            out.done = task ? one("mantle.work.effort.WorkEffort", {workEffortId: task}).statusId : ""
            return out
        },
        then(out) {
            out.asked.join("|") === "|EchRequested"
            out.decided.join("|") === "|true"
            out.task === true
            out.names === "1|true|Y|WeInPlanning"
            out.done === "WeComplete"
        }
    }
)
