// People's confidential cases (mantle.request.RequestServices' case services over PeopleCases.js, and the rule every other reader
// applies; impl-people P21, design-people §4 Grievances, §13 RequestDetail, PE-01, PE-21, F20): an employee files a case with the
// employer's intake handler; the case's people (the employee and its handlers) read it, and the employee's manager, an HR officer
// without the case, another employer's handler, the instance administrator and the assignee of a task on it are each refused with
// its valid id, through the case services and the record rule (get#RecordLinkInfo, authorization disabled too), its files and its
// notes; no triage notice, case profile or completion from work follows, and no other request path makes or changes one; a note
// on it tells its people on PeopleCaseUpdate (a fixed title, no push) and nobody follows it but its people; a task linked to it is
// protected (out of CalDAV, out of every list but its assignee's) and its assignee reads nothing of the case; its search documents
// are marked out of the index and its notes are on no party's timeline; the handlers' moves name their revision, a case keeps a
// handler, the employee withdraws their own.
// Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization disabled (the rules are
// the services' own checks, which hold with authorization disabled).
// Run: ./moq test mr-mantle --spec PeopleCases
const prefix = "PEOPLE_CASE_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    zone = "America/Chicago"
const R = "mantle.request.RequestServices."
const C = "mantle.party.CommunicationServices."
const state = {}

function run(username, service, parameters = {}) {
    if (username) login(username)
    else logout()
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
const sees = (username, recordEntityName, recordId) =>
    run(username, C + "get#RecordLinkInfo", {recordEntityName, recordId, checkOnly: true}).recordVisible === true
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind, organizationPartyId) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Case", lastName: kind})
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    return partyId
}
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People cases " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: zone
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const file = (username, extra = {}) =>
    run(
        username,
        R + "create#PeopleCase",
        Object.assign(
            {subject: "Case spec: shouted at in the stockroom", details: "On the late shift", incidentDate: "2026-11-02"},
            extra
        )
    )
const revisionOf = requestId => run(state.handler, R + "get#PeopleCase", {requestId}).peopleCase?.revision

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Case Spec A")
        organization(orgB, "People Case Spec B")
        // Ana files; Max is her manager; HR of A without the case; Hal and Hope handle A's cases (Hal its intake handler), Bea B's;
        // Ivan in IT is asked for work on the case
        state.ana = person("ANA", orgA)
        state.max = person("MAX", orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.max,
            toPartyId: state.ana,
            fromDate: since
        })
        state.hrParty = person("HR", orgA)
        state.hal = person("HAL", orgA)
        state.hope = person("HOPE", orgA)
        state.bea = person("BEA", orgB)
        state.ivan = person("IVAN", orgA)
        state.filer = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        state.manager = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.hrParty)
        state.handler = user("HAL", ["PEOPLE_CASE_HANDLE"], state.hal)
        state.handler2 = user("HOPE", ["PEOPLE_CASE_HANDLE"], state.hope)
        state.otherHandler = user("BEA", ["PEOPLE_CASE_HANDLE"], state.bea)
        state.it = user("IVAN", ["PEOPLE_SELF_SERVICE"], state.ivan)
        // A's intake handler is Hal (and Bea, who works for B and is skipped); B has none
        call("create#mantle.party.PartySetting", {
            partyId: orgA,
            partySettingTypeId: "PeopleCaseIntake",
            settingValue: state.hal + "," + state.bea
        })
    }
})

feature(
    "an employee files a case with the employer's intake handler; its people read it, the manager, HR without it, another employer's handler and the administrator are refused its valid id; a retry answers the case filed",
    {
        when() {
            // the instance administrator subscribed to every message of the topic, as Tools offers: a case notice is its people's
            // alone (directOnly; the user's call of Nov 12, 2026, People follow-up 1)
            const subscription = {topic: "PeopleCaseUpdate", userId: "EX_JOHN_DOE"}
            ec.entity
                .makeValue("moqui.security.user.NotificationTopicUser")
                .setAll(subscription)
                .set("allNotifications", "Y")
                .create()
            const filed = file(state.filer, {operationKey: prefix + "-1"})
            ec.entity.find("moqui.security.user.NotificationTopicUser").condition(subscription).deleteAll()
            state.requestId = filed.requestId
            const retry = file(state.filer, {operationKey: prefix + "-1"})
            const get = username => code(run(username, R + "get#PeopleCase", {requestId: state.requestId})) || "read"
            const listed = username =>
                (run(username, R + "find#PeopleCases", {}).cases || []).map(row => row.requestId === state.requestId)
            const handlerRow = (run(state.handler, R + "find#PeopleCases", {}).cases || []).find(
                row => row.requestId === state.requestId
            )
            const request = ec.entity.find("mantle.request.Request").condition("requestId", state.requestId).one()
            const parties = Array.from(
                ec.entity.find("mantle.request.RequestParty").condition("requestId", state.requestId).orderBy("roleTypeId").list()
            ).map(row => row.roleTypeId + ":" + row.partyId)
            const noticeRows = Array.from(
                ec.entity.find("moqui.security.user.NotificationMessage").condition("topic", "PeopleCaseUpdate").list()
            )
            const notices = noticeRows.map(row => JSON.parse(row.messageJson || "{}"))
            const filedIds = noticeRows
                .filter(row => JSON.parse(row.messageJson || "{}").requestId === state.requestId)
                .map(row => row.notificationMessageId)
            const told = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessageUser")
                    .condition("notificationMessageId", "in", filedIds)
                    .list()
            ).map(row => row.userId)
            const topic = ec.entity.find("moqui.security.user.NotificationTopic").condition("topic", "PeopleCaseUpdate").one()
            return {
                told,
                filed,
                retry,
                request,
                parties,
                gets: [state.filer, state.handler, state.manager, state.hr, state.otherHandler, "john.doe", state.it].map(get),
                listed: [state.filer, state.handler, state.manager, state.hr].map(listed),
                handlerRow,
                findOne: code(run(state.hr, R + "find#PeopleCases", {requestId: state.requestId})),
                notices,
                topic,
                noEmployment: code(run("john.doe", R + "create#PeopleCase", {subject: "x"})),
                noHandler: code(file(state.otherHandler))
            }
        },
        then({filed, retry, request, parties, gets, listed, handlerRow, findOne, notices, told, topic, noEmployment, noHandler}) {
            filed.error == ""
            filed.created == true
            retry.requestId == filed.requestId && retry.created == false
            // the Request row says nothing of the case; the employee reports it and the intake handler (not Bea of B) handles it
            request.requestTypeEnumId == "RqtHrCase" && request.requestName == "Confidential case" && request.description == null
            parties == ["Assignee:" + state.hal, "Reporter:" + state.ana]
            gets ==
                [
                    "read",
                    "read",
                    "RECORD_UNAVAILABLE",
                    "RECORD_UNAVAILABLE",
                    "RECORD_UNAVAILABLE",
                    "RECORD_UNAVAILABLE",
                    "RECORD_UNAVAILABLE"
                ]
            listed == [[true], [true], [], []]
            handlerRow.subject == "Case spec: shouted at in the stockroom" &&
                handlerRow.filedByText == "Case ANA" &&
                handlerRow.role == "handler"
            findOne == "RECORD_UNAVAILABLE"
            // the handler is told on PeopleCaseUpdate, whose title names nothing, with no push
            notices.some(
                message => message.requestId == state.requestId && message.noticeText == "A confidential case was filed with you"
            )
            topic.pushNotifications == "N" && topic.titleTemplate == "${noticeText}"
            // the handler's users alone: the subscriber to every message of the topic is not told
            told.length > 0 && told.every(userId => userId == state.handler) && !told.includes("EX_JOHN_DOE")
            noEmployment == "NOT_EMPLOYED"
            noHandler == "NO_CASE_HANDLER"
        }
    }
)

feature("no triage notice, case profile or completion from work follows a case, and no other request path makes or changes one", {
    when() {
        const profile = run("john.doe", "mantle.request.SupportCaseServices.ensure#CaseProfile", {requestId: state.requestId})
        // a Customer party added through the generic path runs the case rule, which leaves the type alone
        run("john.doe", R + "replace#RequestParty", {requestId: state.requestId, roleTypeId: "Customer", newPartyId: orgB})
        const profiles = ec.entity.find("mantle.request.support.CaseProfile").condition("requestId", state.requestId).count()
        const triage = run("john.doe", R + "notify#RequestTriage", {requestId: state.requestId, force: true})
        // Hal asks Ivan for work on the case; the work done does not resolve it
        const task = run(state.handler, R + "add#PeopleCaseTask", {
            requestId: state.requestId,
            workEffortName: "Pull the stockroom camera footage",
            assigneePartyId: state.ivan
        })
        state.taskId = task.workEffortId
        call("update#mantle.work.effort.WorkEffort", {workEffortId: state.taskId, statusId: "WeComplete"})
        const fromWork = run("john.doe", R + "complete#RequestFromWork", {workEffortId: state.taskId})
        const statusId = ec.entity.find("mantle.request.Request").condition("requestId", state.requestId).one().statusId
        return {
            profile,
            profiles,
            triaged: Array.from(triage.userIdList || []).length,
            task,
            changed: Array.from(fromWork.changedList || []).length,
            statusId,
            createType: code(run("john.doe", R + "create#Request", {requestName: "x", requestTypeEnumId: "RqtHrCase"})),
            update: run("john.doe", R + "update#Request", {requestId: state.requestId, requestName: "Renamed"}).error,
            becomeCase: code(
                run("john.doe", R + "update#Request", {
                    requestId: call(R + "create#Request", {requestName: "Case spec request"}).requestId,
                    requestTypeEnumId: "RqtHrCase"
                })
            )
        }
    },
    then({profile, profiles, triaged, task, changed, statusId, createType, update, becomeCase}) {
        profile.isCase == false && profile.reason == "CONFIDENTIAL_CASE"
        profiles == 0
        triaged == 0
        task.error == ""
        changed == 0
        statusId == "ReqSubmitted"
        createType == "CASE_TYPE_RESERVED"
        update == "Request " + state.requestId + " not found"
        becomeCase == "CASE_TYPE_RESERVED"
    }
})

feature(
    "a case's files and notes are its people's: the record rule refuses the manager, HR, the administrator and a call with no user, authorization disabled; a note tells its people alone and is on no timeline; nobody else follows it; its search documents are left out",
    {
        when() {
            const R0 = "mantle.request.Request"
            const users = [state.filer, state.handler, state.manager, state.hr, "john.doe", null]
            const record = users.map(username => sees(username, R0, state.requestId))
            // Ana adds a note on her case
            const note = run(state.filer, R + "add#RequestComment", {requestId: state.requestId, body: "Case spec: my note"})
            const eventId = note.communicationEventId
            const content = call("create#mantle.request.RequestContent", {
                requestId: state.requestId,
                description: "Case spec file"
            })
            const event = users.map(username => sees(username, "mantle.party.communication.CommunicationEvent", eventId))
            const file = [state.handler, state.hr].map(username =>
                sees(username, "mantle.request.RequestContent", content.requestContentId)
            )
            const notified = run(state.filer, C + "notify#RecordFollowers", {
                recordEntityName: R0,
                recordId: state.requestId,
                kind: "notes",
                communicationEventId: eventId,
                body: "Case spec: my note"
            }).notifiedUserIds
            const timeline = (run("john.doe", C + "find#PartyCommunicationEvents", {partyId: state.ana}).commEventList || []).map(
                row => row.communicationEventId
            )
            const followHr = run(state.handler, C + "follow#Record", {
                recordEntityName: R0,
                recordId: state.requestId,
                userId: state.hr
            })
            const followers = Array.from(
                ec.entity
                    .find("mantle.party.communication.RecordFollower")
                    .condition({recordEntityName: R0, recordId: state.requestId})
                    .list()
            )
                .map(row => row.userId)
                .sort()
            // the search documents, as the feed assembles them: none of the case or its note, one of a plain request
            const plainId = call(R + "create#Request", {requestName: "Case spec plain request"}).requestId
            const documentsOf = (dataDocumentId, conditions) =>
                Array.from(ec.entity.getDataDocuments(dataDocumentId, conditions, null, null) || []).length
            return {
                record,
                event,
                file,
                notified: Array.from(notified || []),
                onTimeline: timeline.includes(eventId),
                followHr: followHr.error,
                followers,
                documents: [
                    documentsOf("MantleRequest", {requestId: state.requestId}),
                    documentsOf("MantleRequest", {requestId: plainId}),
                    documentsOf("MantleCommunicationEvent", {communicationEventId: eventId})
                ]
            }
        },
        then({record, event, file, notified, onTimeline, followHr, followers, documents}) {
            record == [true, true, false, false, false, false]
            event == [true, true, false, false, false, false]
            file == [true, false]
            notified == [state.handler]
            onTimeline == false
            followHr == "Request " + state.requestId + " not found"
            followers == [state.filer, state.handler].sort()
            documents == [0, 1, 0]
        }
    }
)

feature(
    "a task on a case is protected: out of CalDAV and every list but its assignee's, and its assignee reads nothing of the case",
    {
        when() {
            const W = "mantle.work.effort.WorkEffort"
            const checklists = ec.resource.script("component://mr-mantle/service/mantle/humanres/Checklists.js")
            const cases = ec.resource.script("component://mr-mantle/service/mantle/request/PeopleCases.js")
            const tags = (run(state.it, "mantle.work.CalendarDavServices.get#TaskObjectTags").objectList || []).map(
                row => row.workEffortId
            )
            return {
                task: [state.it, state.hr, state.manager].map(username => sees(username, W, state.taskId)),
                itCase: [
                    sees(state.it, "mantle.request.Request", state.requestId),
                    code(run(state.it, R + "get#PeopleCase", {requestId: state.requestId})),
                    code(
                        run(state.it, R + "add#PeopleCaseTask", {
                            requestId: state.requestId,
                            workEffortName: "x",
                            assigneePartyId: state.it
                        })
                    )
                ],
                protectedIds: cases.protectedTaskIds([state.taskId]),
                hidden: [state.ivan, state.hrParty].map(partyId => checklists.hiddenTaskIds([state.taskId], partyId).length),
                inCalDav: tags.includes(state.taskId),
                handlerTasks: (run(state.handler, R + "get#PeopleCase", {requestId: state.requestId}).tasks || []).map(
                    row => row.workEffortName
                ),
                filerTasks: (run(state.filer, R + "get#PeopleCase", {requestId: state.requestId}).tasks || []).length
            }
        },
        then({task, itCase, protectedIds, hidden, inCalDav, handlerTasks, filerTasks}) {
            task == [true, false, false]
            itCase == [false, "RECORD_UNAVAILABLE", "RECORD_UNAVAILABLE"]
            protectedIds == [state.taskId]
            hidden == [0, 1]
            inCalDav == false
            handlerTasks == ["Pull the stockroom camera footage"]
            filerTasks == 0
        }
    }
)

feature(
    "the handler's moves name the revision read; a case keeps a handler; the employee withdraws their own case, and moves no other way",
    {
        when() {
            const move = (username, action, extra = {}) =>
                code(run(username, R + "change#PeopleCase", Object.assign({requestId: state.requestId, action}, extra)))
            const stale = move(state.handler, "start", {expectedRevision: "1"})
            const filerStarts = move(state.filer, "start", {expectedRevision: revisionOf(state.requestId)})
            const start = move(state.handler, "start", {expectedRevision: revisionOf(state.requestId)})
            const lastHandler = code(
                run(state.handler, R + "assign#PeopleCaseHandler", {requestId: state.requestId, partyId: state.hal, remove: true})
            )
            const notEligible = code(
                run(state.handler, R + "assign#PeopleCaseHandler", {requestId: state.requestId, partyId: state.bea})
            )
            const add = run(state.handler, R + "assign#PeopleCaseHandler", {requestId: state.requestId, partyId: state.hope})
            const hopeReads = code(run(state.handler2, R + "get#PeopleCase", {requestId: state.requestId})) || "read"
            const resolve = move(state.handler2, "resolve", {
                outcomeNote: "Case spec: spoke with both",
                expectedRevision: revisionOf(state.requestId)
            })
            const filerView = run(state.filer, R + "get#PeopleCase", {requestId: state.requestId}).peopleCase || {}
            // a second case of Ana's, withdrawn by her
            const second = file(state.filer).requestId
            const withdraw = code(run(state.filer, R + "change#PeopleCase", {requestId: second, action: "withdraw"}))
            const withdrawn = ec.entity.find("mantle.request.Request").condition("requestId", second).one().statusId
            return {stale, filerStarts, start, lastHandler, notEligible, add, hopeReads, resolve, filerView, withdraw, withdrawn}
        },
        then({stale, filerStarts, start, lastHandler, notEligible, add, hopeReads, resolve, filerView, withdraw, withdrawn}) {
            stale == "REVISION_CHANGED"
            filerStarts == "PERMISSION_DENIED"
            start == ""
            lastHandler == "LAST_HANDLER"
            notEligible == "HANDLER_INVALID"
            add.added == true
            hopeReads == "read"
            resolve == ""
            filerView.stateText == "Resolved" && filerView.outcomeNote == "Case spec: spoke with both"
            filerView.handlersText == "Case HAL, Case HOPE"
            withdraw == ""
            withdrawn == "ReqCancelled"
        }
    }
)

// P21 review: the paths that reach a note by another way than its case (its author's party, a reply's parent, a link to another
// record, the request comment services) and a party change of the case
feature(
    "a note on a case is missing on every other path: its author's party record (the administrator's delete), a reply, a link to another record, the request comment services; the case's parties change through its own services alone",
    {
        when() {
            const note = run(state.handler, R + "add#RequestComment", {
                requestId: state.requestId,
                body: "Case spec: handler note"
            })
            const eventId = note.communicationEventId
            const errorOf = (username, service, parameters) => run(username, service, parameters).error
            const refused = {
                adminDeleteByParty: errorOf("john.doe", C + "delete#RecordNote", {
                    recordEntityName: "mantle.party.Party",
                    recordId: state.hal,
                    communicationEventId: eventId
                }),
                managerReply: errorOf(state.manager, C + "reply#CommunicationEvent", {
                    parentCommEventId: eventId,
                    body: "Case spec: a reply from outside"
                }),
                managerLink: errorOf(state.manager, C + "link#CommunicationEventRecord", {
                    communicationEventId: eventId,
                    recordEntityName: "mantle.party.Party",
                    recordId: state.max
                }),
                adminDeleteComment: errorOf("john.doe", R + "delete#RequestComment", {
                    requestId: state.requestId,
                    communicationEventId: eventId
                }),
                hrComment: errorOf(state.hr, R + "add#RequestComment", {requestId: state.requestId, body: "Case spec: HR"}),
                adminParty: errorOf("john.doe", R + "replace#RequestParty", {
                    requestId: state.requestId,
                    roleTypeId: "Assignee",
                    newPartyId: state.max
                })
            }
            const handlerEdits = errorOf(state.handler, R + "update#RequestComment", {
                requestId: state.requestId,
                communicationEventId: eventId,
                body: "Case spec: handler note, edited"
            })
            const event = ec.entity
                .find("mantle.party.communication.CommunicationEvent")
                .condition("communicationEventId", eventId)
                .one()
            const links = ec.entity
                .find("mantle.party.communication.CommunicationEventRecord")
                .condition("communicationEventId", eventId)
                .count()
            const replies = ec.entity
                .find("mantle.party.communication.CommunicationEvent")
                .condition("parentCommEventId", eventId)
                .count()
            const assignees = Array.from(
                ec.entity
                    .find("mantle.request.RequestParty")
                    .condition({requestId: state.requestId, roleTypeId: "Assignee"})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            ).map(row => row.partyId)
            return {eventId, refused, handlerEdits, body: event?.body, links, replies, assignees}
        },
        then({eventId, refused, handlerEdits, body, links, replies, assignees}) {
            refused.adminDeleteByParty == "Note " + eventId + " not found on Party " + state.hal
            refused.managerReply == "Communication event " + eventId + " not found"
            refused.managerLink == "Communication event " + eventId + " not found"
            refused.adminDeleteComment == "Comment " + eventId + " not found on request " + state.requestId
            refused.hrComment == "Request " + state.requestId + " not found"
            refused.adminParty == "Request " + state.requestId + " not found"
            handlerEdits == ""
            body == "Case spec: handler note, edited"
            links == 0 && replies == 0
            !assignees.includes(state.max)
        }
    }
)

// The user's call of Nov 12, 2026: a handler who leaves is listed with their open cases in People's lifecycle participant by name
// alone, and, once they have left, is taken off each and a case left with no handler goes back to the employer's intake handlers,
// who are told on PeopleCaseUpdate (a title naming nothing)
feature(
    "a handler who leaves: their open cases in the lifecycle lookup by name alone; once they leave they read none, and a case left without a handler goes back to the intake handlers, who are told",
    {
        when() {
            // Ana's third case, handed from Hal (the intake handler) to Hope alone
            const requestId = file(state.filer).requestId
            run(state.handler, R + "assign#PeopleCaseHandler", {requestId, partyId: state.hope})
            run(state.handler2, R + "assign#PeopleCaseHandler", {requestId, partyId: state.hal, remove: true})
            const halBefore = code(run(state.handler, R + "get#PeopleCase", {requestId})) || "read"
            const owned = (
                run(state.handler2, "mantle.humanres.PeopleApprovalServices.find#OwnedApprovals", {userId: state.handler2})
                    .resourceList || []
            ).filter(row => row.resourceKind === "case")
            const transfer = code(
                run(state.handler2, "mantle.humanres.PeopleApprovalServices.transfer#ApprovalOwner", {
                    fromUserId: state.handler2,
                    toUserId: state.handler,
                    approvalResourceId: "case:" + requestId
                })
            )
            const assignedNotices = () =>
                Array.from(
                    ec.entity.find("moqui.security.user.NotificationMessage").condition("topic", "PeopleCaseUpdate").list()
                )
                    .map(row => JSON.parse(row.messageJson || "{}"))
                    .filter(
                        message =>
                            message.requestId == requestId && message.noticeText == "A confidential case was assigned to you"
                    ).length
            const before = assignedNotices()
            // Hope leaves A: her employment ends and the separation is in effect; the daily job routes the employer's work again
            const employment = ec.entity
                .find("mantle.party.PartyRelationship")
                .condition({fromPartyId: state.hope, toPartyId: orgA, relationshipTypeEnumId: "PrtEmployee"})
                .one()
            const left = new Date(Date.now() - 60 * 1000)
            call("update#mantle.party.PartyRelationship", {partyRelationshipId: employment.partyRelationshipId, thruDate: left})
            call("create#mantle.humanres.employment.EmploymentChange", {
                partyRelationshipId: employment.partyRelationshipId,
                partyId: state.hope,
                organizationPartyId: orgA,
                changeKindEnumId: "EckSeparation",
                statusId: "EchApplied",
                effectiveDate: left,
                appliedDate: left
            })
            const job = run(null, "mantle.humanres.PeopleServices.apply#DueAssignments", {
                partyRelationshipIds: [employment.partyRelationshipId]
            })
            const handlers = Array.from(
                ec.entity
                    .find("mantle.request.RequestParty")
                    .condition({requestId, roleTypeId: "Assignee"})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            ).map(row => row.partyId)
            const followers = Array.from(
                ec.entity
                    .find("mantle.party.communication.RecordFollower")
                    .condition({recordEntityName: "mantle.request.Request", recordId: requestId})
                    .list()
            )
                .map(row => row.userId)
                .sort()
            return {
                requestId,
                halBefore,
                owned,
                transfer,
                job: job.error,
                hope: code(run(state.handler2, R + "get#PeopleCase", {requestId})) || "read",
                hal: code(run(state.handler, R + "get#PeopleCase", {requestId})) || "read",
                handlers,
                followers,
                told: assignedNotices() - before
            }
        },
        then({requestId, halBefore, owned, transfer, job, hope, hal, handlers, followers, told}) {
            halBefore == "RECORD_UNAVAILABLE"
            owned.length == 1
            owned[0].resourceId == "case:" + requestId &&
                owned[0].resourceName == "Confidential case" &&
                owned[0].transferable == false
            !JSON.stringify(owned).includes("stockroom")
            transfer == "NOT_TRANSFERABLE"
            job == ""
            hope == "RECORD_UNAVAILABLE"
            hal == "read"
            handlers == [state.hal]
            followers == [state.filer, state.handler].sort()
            told == 1
        }
    }
)
