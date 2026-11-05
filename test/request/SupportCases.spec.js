// Support cases (impl-customer-service P2: CS-QUEUE, CS-SETTINGS, CX-REQUEST; F48, F62, F63, F64, F68, F74;
// mantle.request.SupportCaseServices, SupportCases.js): with no service policy a customer's request is no case (Mantle's
// default); the settings saves (team, members, queues, defaults, types) and their refusals; the case rule after the commit on
// every path (made submitted, a draft submitted, a Customer party added, a move into a queue, a project's request, a shared
// customer, a customer contact's own request) and the requests it leaves alone (an employee's, a non-queue category); create#Case with its refusals;
// update#Case's assignee and queue rules, another agent's case and a stale revision; transition#Case's workflow (resolution,
// reason, reopen); tags; update#Request refusing a case's close and due date (CASE_MANAGED) and not a plain request's; a case's
// work leaving it open (complete#RequestFromWork); Today leaving cases out; a client never seeing a case; a restricted queue's
// case seen only by its team. Standalone: spec-local organizations, customers, groups and users, artifact authorization
// disabled (the rules are the services' own checks). Run: ./moq test mr-mantle --spec SupportCases
const prefix = "SCS"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    shared = prefix + "_SHARED",
    otherCustomer = prefix + "_OTHER_CUST",
    employee = prefix + "_EMP",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices.",
    R = "mantle.request.RequestServices."
const REQUEST = "mantle.request.Request",
    PROFILE = "mantle.request.support.CaseProfile"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const current = (entity, conditions) => rows(entity, conditions).filter(row => !row.thruDate)
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
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
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
// the case rule runs after the commit, on the service pool: wait for its profile (or that it did not come)
function profileOf(requestId, wait = true) {
    const end = Date.now() + (wait ? 4000 : 250)
    let profile = one(PROFILE, {requestId})
    while (!profile && Date.now() < end) profile = one(PROFILE, {requestId})
    return profile
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Support case " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Case", lastName: kind})
    // a staff user works for the organization; a customer's own user (organizationPartyId null) does not
    if (organizationPartyId)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: id,
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
function party(partyId, name, roleTypeId, ownerPartyId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId: ownerPartyId || "_NA_"})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
// a request as a user would file it through create#Request (Comms, Chat, Commons, Projects): its id
const request = (username, fields) =>
    run(username, R + "create#Request", Object.assign({requestName: "Spec request", statusId: "ReqSubmitted"}, fields)).requestId

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Support Spec Org", "OrgInternal")
        party(otherOrg, "Support Spec Other Org", "OrgInternal")
        party(customer, "Support Spec Customer", "Customer", org)
        party(shared, "Support Spec Shared Customer", "Customer", "_NA_")
        party(otherCustomer, "Support Spec Other Customer", "Customer", otherOrg)
        party(employee, "Support Spec Employee", null, org, "PtyPerson")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtEmployee",
            fromPartyId: employee,
            toPartyId: org,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.agent2 = user("AGENT2", ["SUPPORT_CASE_EDIT"])
        state.outsider = user("OUTSIDER", ["SUPPORT_CASE_EDIT"])
        state.reader = user("READER", [])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_MANAGE", "SUPPORT_CASE_EDIT"], otherOrg)
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("with no service policy a customer's submitted request is no case (Mantle's default)", {
    when() {
        const requestId = request(state.agent, {customerPartyId: customer})
        return {ensured: call(S + "ensure#CaseProfile", {requestId}), profile: profileOf(requestId, false)}
    },
    then({ensured, profile}) {
        ensured.isCase == false
        ensured.reason == "NOT_A_CASE"
        profile == null
    }
})

feature("the service settings: a team and its members, queues, the defaults and a service-enabled type; their refusals", {
    when() {
        const team = run(state.admin, S + "save#ServiceTeam", {organizationPartyId: org, teamName: "Spec support team"})
        state.team = team.teamPartyId
        const members = [state.agent, state.agent2].map(partyId =>
            run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId})
        )
        const managerByAgent = run(state.agent, S + "save#ServiceTeamMember", {teamPartyId: state.team, partyId: state.reader})
        const queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec Support",
            responsibleTeamPartyId: state.team,
            visibilityEnumId: "SqvTeam"
        })
        state.queue = queue.requestCategoryId
        state.billing = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec Billing",
            responsibleTeamPartyId: state.team
        }).requestCategoryId
        const restrictedNoTeam = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec Private",
            visibilityEnumId: "SqvRestricted"
        })
        state.privacyTeam = run(state.admin, S + "save#ServiceTeam", {
            organizationPartyId: org,
            teamName: "Spec privacy team"
        }).teamPartyId
        run(state.admin, S + "save#ServiceTeamMember", {teamPartyId: state.privacyTeam, partyId: state.agent2})
        state.privacy = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Spec Privacy",
            responsibleTeamPartyId: state.privacyTeam,
            visibilityEnumId: "SqvRestricted",
            offeredTypeEnumIds: "RqtPrivacy"
        }).requestCategoryId
        const otherTeamQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            organizationPartyId: otherOrg,
            description: "Other",
            responsibleTeamPartyId: state.team
        })
        const otherOrgQueue = run(state.otherAdmin, S + "save#ServiceQueue", {
            requestCategoryId: state.queue,
            description: "Taken"
        })
        const agentQueue = run(state.agent, S + "save#ServiceQueue", {organizationPartyId: org, description: "Not mine"})
        const defaults = run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
        const supportType = run(state.admin, S + "save#ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtSupport",
            serviceEnabled: "Y",
            defaultCategoryId: state.queue,
            defaultPriority: 4,
            customerLabel: "Help request"
        })
        run(state.admin, S + "save#ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtPrivacy",
            serviceEnabled: "Y",
            defaultCategoryId: state.privacy
        })
        const enabledNoQueue = run(state.admin, S + "save#ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtInformation",
            serviceEnabled: "Y"
        })
        const endDefault = run(state.admin, S + "save#ServiceQueue", {requestCategoryId: state.queue, end: true})
        // a second save of the type ends the first row by its date, so history stays
        run(state.admin, S + "save#ServiceRequestType", {
            organizationPartyId: org,
            requestTypeEnumId: "RqtSupport",
            serviceEnabled: "Y",
            defaultCategoryId: state.queue,
            defaultPriority: 4,
            customerLabel: "Help"
        })
        return {
            team,
            members,
            managerByAgent,
            queue,
            restrictedNoTeam,
            otherTeamQueue,
            otherOrgQueue,
            agentQueue,
            defaults,
            supportType,
            enabledNoQueue,
            endDefault,
            typeRows: rows("mantle.request.support.ServiceRequestType", {
                organizationPartyId: org,
                requestTypeEnumId: "RqtSupport"
            }),
            category: one("mantle.request.RequestCategory", {requestCategoryId: state.queue})
        }
    },
    then(r) {
        r.team.error == ""
        r.members.every(member => member.error == "" && member.partyRelationshipId)
        code(r.managerByAgent) == "PERMISSION_DENIED"
        r.queue.error == ""
        r.category.ownerPartyId == org
        code(r.restrictedNoTeam) == "TEAM_REQUIRED"
        code(r.otherTeamQueue) == "TEAM_UNAVAILABLE"
        code(r.otherOrgQueue) == "RECORD_UNAVAILABLE"
        code(r.agentQueue) == "PERMISSION_DENIED"
        r.defaults.error == ""
        r.supportType.error == ""
        code(r.enabledNoQueue) == "QUEUE_REQUIRED"
        code(r.endDefault) == "QUEUE_IN_USE"
        r.typeRows.length == 2
        r.typeRows.filter(row => !row.thruDate).length == 1
    }
})

feature("the case rule after the commit: a customer's submitted request moves into the type's queue with its organization", {
    when() {
        const requestId = request(state.agent, {customerPartyId: customer})
        const profile = profileOf(requestId)
        return {
            profile,
            request: one(REQUEST, {requestId}),
            orgParty: current("mantle.request.RequestParty", {requestId, roleTypeId: "OrgInternal"})[0]
        }
    },
    then({profile, request, orgParty}) {
        profile != null
        profile.caseWorkflowId == "CwfDefault"
        profile.intakeCategoryId == state.queue
        request.requestCategoryId == state.queue
        orgParty.partyId == org
    }
})

feature("on every path: a draft submitted, a Customer party added, a move into a queue, a project's request, a shared customer", {
    when() {
        const draft = request(state.agent, {customerPartyId: customer, statusId: "ReqDraft"})
        const draftProfile = profileOf(draft, false)
        run(state.agent, R + "update#Request", {requestId: draft, statusId: "ReqSubmitted"})
        const noCustomer = request(state.agent, {})
        const beforeCustomer = profileOf(noCustomer, false)
        run(state.agent, R + "update#Request", {requestId: noCustomer, customerPartyId: customer})
        const plainCategory = call("create#mantle.request.RequestCategory", {description: "Spec plain"}).requestCategoryId
        const moved = request(state.agent, {
            customerPartyId: customer,
            requestTypeEnumId: "RqtInformation",
            requestCategoryId: plainCategory
        })
        const plainProfile = profileOf(moved, false)
        run(state.agent, R + "update#Request", {requestId: moved, requestCategoryId: state.billing})
        call("mantle.work.ProjectServices.create#Project", {
            workEffortId: "SCSPRJ",
            workEffortName: "Support spec project",
            assignToPartyId: "EX_JOHN_DOE",
            assignRoleTypeId: "ProjectManager"
        })
        call("mantle.work.ProjectServices.store#ProjectSetting", {
            workEffortId: "SCSPRJ",
            settingTypeEnumId: "WstRequestFromWork",
            settingValue: "Y"
        })
        state.projectCase = request(state.agent, {customerPartyId: customer, rootWorkEffortId: "SCSPRJ"})
        const sharedCase = request(state.agent, {customerPartyId: shared})
        const employeeRequest = request(state.agent, {customerPartyId: employee})
        // a customer contact's own request with no Customer party (as Chat files one): the contact is the customer
        const contact = user("CONTACT", [], null)
        call("create#mantle.party.PartyRole", {partyId: contact, roleTypeId: "Customer"})
        call("update#mantle.party.Party", {partyId: contact, ownerPartyId: org})
        const contactRequest = request(contact, {})
        const otherRequest = request(state.agent, {customerPartyId: otherCustomer})
        // staff who are customers too, and a customer's contacts, file their own requests as staff: never a case (Nov 5)
        call("create#mantle.party.PartyRole", {partyId: state.reader, roleTypeId: "Customer"})
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: state.reader,
            toPartyId: customer,
            fromDate: since
        })
        const staffRequest = request(state.reader, {})
        // a request already in progress given a Customer party is not made a case (only a Submitted one, or a move into a queue)
        const inProgress = request(state.agent, {statusId: "ReqInProgress"})
        run(state.agent, R + "update#Request", {requestId: inProgress, customerPartyId: customer})
        return {
            draftProfile,
            draftCase: profileOf(draft),
            beforeCustomer,
            customerCase: profileOf(noCustomer),
            plainProfile,
            movedCase: profileOf(moved),
            contactCase: profileOf(contactRequest),
            contactCustomer: current("mantle.request.RequestParty", {requestId: contactRequest, roleTypeId: "Customer"})[0],
            projectCase: profileOf(state.projectCase),
            sharedCase: profileOf(sharedCase),
            employee: call(S + "ensure#CaseProfile", {requestId: employeeRequest}),
            other: call(S + "ensure#CaseProfile", {requestId: otherRequest}),
            staff: call(S + "ensure#CaseProfile", {requestId: staffRequest}),
            inProgress: call(S + "ensure#CaseProfile", {requestId: inProgress})
        }
    },
    then(r) {
        r.draftProfile == null
        r.draftCase != null
        r.beforeCustomer == null
        r.customerCase != null
        r.plainProfile == null
        r.movedCase.intakeCategoryId == state.billing
        r.contactCase != null
        r.contactCustomer.partyId == prefix + "_CONTACT"
        r.projectCase != null
        r.sharedCase != null
        r.employee.isCase == false
        r.other.isCase == false
        r.staff.isCase == false
        r.inProgress.isCase == false
    }
})

feature(
    "create#Case: the case with its parties and profile in one call; a customer, organization or user it may not have refused",
    {
        when() {
            const made = run(state.agent, S + "create#Case", {
                organizationPartyId: org,
                customerPartyId: customer,
                requestName: "Broken thermostat",
                requestCategoryId: state.queue,
                contactPartyId: employee,
                assigneePartyId: state.agent
            })
            state.case = made.requestId
            return {
                made,
                profile: one(PROFILE, {requestId: made.requestId}),
                request: one(REQUEST, {requestId: made.requestId}),
                parties: current("mantle.request.RequestParty", {requestId: made.requestId})
                    .map(row => row.roleTypeId + ":" + row.partyId)
                    .sort(),
                otherCustomer: run(state.agent, S + "create#Case", {
                    organizationPartyId: org,
                    customerPartyId: otherCustomer,
                    requestName: "x"
                }),
                outsider: run(state.outsider, S + "create#Case", {
                    organizationPartyId: otherOrg,
                    customerPartyId: otherCustomer,
                    requestName: "x"
                }),
                reader: run(state.reader, S + "create#Case", {
                    organizationPartyId: org,
                    customerPartyId: customer,
                    requestName: "x"
                }),
                wrongType: run(state.agent, S + "create#Case", {
                    organizationPartyId: org,
                    customerPartyId: customer,
                    requestName: "x",
                    requestCategoryId: state.privacy
                })
            }
        },
        then(r) {
            r.made.error == ""
            r.profile != null
            r.request.statusId == "ReqSubmitted"
            r.request.priority == 4
            r.parties.includes("OrgInternal:" + org)
            r.parties.includes("Customer:" + customer)
            r.parties.includes("Reporter:" + employee)
            r.parties.includes("Assignee:" + state.agent)
            code(r.otherCustomer) == "CUSTOMER_UNAVAILABLE"
            code(r.outsider) == "RECORD_UNAVAILABLE"
            code(r.reader) == "PERMISSION_DENIED"
            code(r.wrongType) == "TYPE_NOT_OFFERED"
        }
    }
)

feature("update#Case: an assignee of the queue's team, another agent's case for a manager only, a stale revision refused", {
    when() {
        const outsideTeam = run(state.agent, S + "update#Case", {requestId: state.case, assigneePartyId: state.reader})
        const toAgent2 = run(state.agent, S + "update#Case", {requestId: state.case, assigneePartyId: state.agent2, priority: 2})
        const notMine = run(state.agent, S + "update#Case", {requestId: state.case, priority: 3})
        const stale = run(state.admin, S + "update#Case", {requestId: state.case, priority: 3, caseRevision: 1})
        const otherQueue = run(state.admin, S + "update#Case", {requestId: state.case, requestCategoryId: "SCS_NO_SUCH"})
        const byManager = run(state.admin, S + "update#Case", {
            requestId: state.case,
            requestCategoryId: state.billing,
            caseRevision: toAgent2.revision
        })
        return {
            outsideTeam,
            toAgent2,
            notMine,
            stale,
            otherQueue,
            byManager,
            request: one(REQUEST, {requestId: state.case}),
            assignee: current("mantle.request.RequestParty", {requestId: state.case, roleTypeId: "Assignee"})[0]
        }
    },
    then(r) {
        code(r.outsideTeam) == "ASSIGNEE_UNAVAILABLE"
        r.toAgent2.error == ""
        code(r.notMine) == "PERMISSION_DENIED"
        code(r.stale) == "STALE_CASE"
        code(r.otherQueue) == "QUEUE_UNAVAILABLE"
        r.byManager.error == ""
        r.request.priority == 2
        r.request.requestCategoryId == state.billing
        r.assignee.partyId == state.agent2
    }
})

feature("transition#Case by its workflow: a pause, a resolution required, a reopen with a reason; a move it has not refused", {
    when() {
        const A = state.agent2
        const waiting = run(A, S + "transition#Case", {requestId: state.case, toStatusId: "ReqWaitingCustomer"})
        const toDraft = run(A, S + "transition#Case", {requestId: state.case, toStatusId: "ReqDraft"})
        const noResolution = run(A, S + "transition#Case", {requestId: state.case, toStatusId: "ReqCompleted"})
        const resolved = run(A, S + "transition#Case", {
            requestId: state.case,
            toStatusId: "ReqCompleted",
            resolutionEnumId: "RrFixed"
        })
        const resolvedRequest = one(REQUEST, {requestId: state.case})
        const noReason = run(A, S + "transition#Case", {requestId: state.case, toStatusId: "ReqInProgress"})
        const reopened = run(A, S + "transition#Case", {
            requestId: state.case,
            toStatusId: "ReqInProgress",
            reason: "Still broken"
        })
        return {
            waiting,
            toDraft,
            noResolution,
            resolved,
            resolvedRequest,
            noReason,
            reopened,
            request: one(REQUEST, {requestId: state.case})
        }
    },
    then(r) {
        r.waiting.statusLabel == "Waiting for customer"
        code(r.toDraft) == "TRANSITION_NOT_ALLOWED"
        code(r.noResolution) == "RESOLUTION_REQUIRED"
        r.resolved.error == ""
        r.resolvedRequest.requestResolutionEnumId == "RrFixed"
        code(r.noReason) == "REASON_REQUIRED"
        r.reopened.error == ""
        r.request.statusId == "ReqInProgress"
        r.request.requestResolutionEnumId == "RrUnresolved"
    }
})

feature("tags on a case: added, replaced (the old one ended), an unknown tag refused", {
    when() {
        const added = run(state.agent2, S + "set#CaseTags", {requestId: state.case, tagEnumIds: ["RtgBilling", "RtgVip"]})
        const replaced = run(state.agent2, S + "set#CaseTags", {
            requestId: state.case,
            tagEnumIds: ["RtgShipping"],
            mode: "replace"
        })
        const unknown = run(state.agent2, S + "set#CaseTags", {requestId: state.case, tagEnumIds: ["RrFixed"]})
        return {added, replaced, unknown, rows: rows("mantle.request.RequestTag", {requestId: state.case})}
    },
    then(r) {
        r.added.tagEnumIds.length == 2
        r.replaced.tagEnumIds.join() == "RtgShipping"
        code(r.unknown) == "TAG_UNKNOWN"
        r.rows.length == 3
        r.rows.filter(row => !row.thruDate).length == 1
    }
})

feature("update#Request refuses a case's close and due date from any other path (CASE_MANAGED), not a plain request's", {
    when() {
        const plain = request(state.agent, {})
        return {
            close: run(state.admin, R + "update#Request", {
                requestId: state.case,
                statusId: "ReqCancelled",
                requestResolutionEnumId: "RrRejected"
            }),
            due: run(state.admin, R + "update#Request", {requestId: state.case, responseRequiredDate: ec.user.nowTimestamp}),
            // another change of a case with a due date (its service level's) is not refused
            name:
                (call("update#" + REQUEST, {requestId: state.case, responseRequiredDate: new Date(Date.now() + 7200000)}),
                run(state.admin, R + "update#Request", {requestId: state.case, requestName: "Broken thermostat, again"})),
            plainClose: run(state.admin, R + "update#Request", {
                requestId: plain,
                statusId: "ReqCompleted",
                requestResolutionEnumId: "RrCompleted",
                responseRequiredDate: ec.user.nowTimestamp
            }),
            caseRequest: one(REQUEST, {requestId: state.case}),
            audit: rows("moqui.entity.EntityAuditLog", {
                changedEntityName: REQUEST,
                pkPrimaryValue: state.case,
                changedFieldName: "requestCategoryId"
            })
        }
    },
    then(r) {
        code(r.close) == "CASE_MANAGED"
        code(r.due) == "CASE_MANAGED"
        r.name.error == ""
        r.plainClose.error == ""
        r.caseRequest.statusId == "ReqInProgress"
        r.audit.length >= 1
    }
})

feature("a case's work done leaves it open (a project's case too); Today leaves cases out; a client never sees a case", {
    when() {
        const workEffortId = call(R + "make#RequestWorkItem", {requestId: state.projectCase}).workEffortId
        call("mantle.work.TaskServices.set#TaskStatus", {workEffortId, statusId: "WeInProgress"})
        call("mantle.work.TaskServices.set#TaskStatus", {workEffortId, statusId: "WeComplete"})
        // Today: the assignee's due case is left out, a plain assigned request with a due date stays
        const plain = request(state.agent, {assignToPartyId: state.agent2, responseRequiredDate: new Date(Date.now() + 3600000)})
        call("update#" + REQUEST, {requestId: state.case, responseRequiredDate: new Date(Date.now() + 3600000)})
        const today = call(R + "get#UserTodayRequests", {partyId: state.agent2}).items.map(item => item.requestId)
        // a client contact who filed a case does not see it, and does see a plain request it filed
        const client = user("CLIENT", ["PROJECT_CLIENT"])
        const clientCase = request(client, {customerPartyId: customer})
        const clientPlain = request(client, {})
        profileOf(clientCase)
        const visible = run(client, "mantle.party.CommunicationServices.get#ClientRecordVisibility", {
            requestIds: [clientCase, clientPlain]
        })
        return {projectCase: one(REQUEST, {requestId: state.projectCase}), today, plain, visible, clientCase, clientPlain}
    },
    then(r) {
        r.projectCase.statusId == "ReqReviewed"
        r.today.includes(r.plain)
        !r.today.includes(state.case)
        r.visible.isClient == true
        r.visible.visibleRequestIds.includes(r.clientPlain)
        !r.visible.visibleRequestIds.includes(r.clientCase)
    }
})

feature("a privacy case lands in the restricted Privacy queue and only its team sees it (record visibility)", {
    when() {
        const requestId = request(state.agent, {customerPartyId: customer, requestTypeEnumId: "RqtPrivacy"})
        const profile = profileOf(requestId)
        // the record link service for the two users, under the organization filter an app's groups have (MANTLE_USER_ORG)
        call("create#moqui.security.UserGroup", {userGroupId: "SCS_RLI", description: "Support case record links"})
        call("create#moqui.security.ArtifactGroup", {artifactGroupId: "SCS_RLI", description: "Support case record links"})
        call("create#moqui.security.ArtifactGroupMember", {
            artifactGroupId: "SCS_RLI",
            artifactTypeEnumId: "AT_SERVICE",
            artifactName: "mantle.party.CommunicationServices.get#RecordLinkInfo",
            nameIsPattern: "N",
            inheritAuthz: "Y"
        })
        call("create#moqui.security.ArtifactAuthz", {
            artifactAuthzId: "SCS_RLI",
            userGroupId: "SCS_RLI",
            artifactGroupId: "SCS_RLI",
            authzTypeEnumId: "AUTHZT_ALLOW",
            authzActionEnumId: "AUTHZA_ALL"
        })
        call("create#moqui.security.ArtifactAuthzFilter", {artifactAuthzId: "SCS_RLI", entityFilterSetId: "MANTLE_USER_ORG"})
        for (const userId of [state.agent2, state.admin])
            call("create#moqui.security.UserGroupMember", {userGroupId: "SCS_RLI", userId, fromDate: since})
        const seen = username => {
            login(username)
            ec.artifactExecution.enableAuthz()
            ec.message.pushErrors()
            try {
                return (
                    ec.service
                        .sync()
                        .name("mantle.party.CommunicationServices.get#RecordLinkInfo")
                        .parameters({
                            recordEntityName: REQUEST,
                            recordId: requestId,
                            checkOnly: true
                        })
                        .call()?.recordVisible === true
                )
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
                ec.artifactExecution.disableAuthz()
                login("john.doe")
            }
        }
        return {profile, team: seen(state.agent2), notTeam: seen(state.admin)}
    },
    then(r) {
        r.profile.intakeCategoryId == state.privacy
        r.team == true
        r.notTeam == false
    }
})
