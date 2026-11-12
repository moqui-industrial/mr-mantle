// People's skills and qualifications (mantle.humanres.DevelopmentServices: store#Skill, store#Qualification, verify#Qualification,
// find#Qualifications, check#Qualifications, get#SkillsMatrix, get#PersonDevelopment, check#QualificationAccess,
// send#ExpiryReminders; PositionServices.store#JobRequirement's levels and dates; impl-people P18, design-people §10, PE-14, PE-01):
// a self-declared skill and an unverified or expired certificate meet no requirement, an evaluation and a verified certificate
// do (expiring inside thirty days), and the staffing answer holds no number, issuer or file; the person never verifies their
// own, and a reader who may not verify is refused with the same parameters a verifier is answered with; an identity document or
// work permit needs an expiry, its number is the person's and HR's (never development's or a manager's), only HR verifies it,
// its files are the person's and HR's, and another employer's HR reads nothing; a job class's requirement carries a level, a
// certificate and required or desired, is changed at its revision and ended (not deleted) when removed, each period its own row
// read at its date (the user's call of Nov 12, 2026), and the skills matrix shows the person against it; a work effort's skill
// standard is checked at its level; an HR editor never verifies their own qualification, nor a development editor evaluates
// their own skill; a manager evaluates a report's skill without PEOPLE_DEVELOP_EDIT, as the manager's evaluation, and is refused
// another person's (the user's call of Nov 12, 2026); an expiry is reminded once, and a renewed qualification is no longer due.
// Standalone: spec-local organizations, people, employments, a job class and seat, groups and users, with artifact authorization
// disabled (the rules are the services' own checks).
// Run: ./moq test mr-mantle --spec Qualifications
const prefix = "PEOPLE_QUAL_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z",
    zone = "America/Chicago",
    day = 24 * 60 * 60 * 1000
const D = "mantle.humanres.DevelopmentServices."
const P = "mantle.humanres.PositionServices."
const QUALIFICATION = "mantle.humanres.ability.PartyQualification"
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
const stamp = offsetDays => new Date(state.now + offsetDays * day)
const dayText = offsetDays => ec.l10n.format(stamp(offsetDays), "yyyy-MM-dd", null, zone)
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Qual", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    }).partyRelationshipId
function user(kind, permissions, partyId) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People qualifications " + kind})
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
const check = (username, parameters) => run(username, D + "check#Qualifications", Object.assign({partyId: state.ana}, parameters))
const requirementOf = (out, skillTypeEnumId) =>
    out.results?.[0]?.requirements?.find(row => row.skillTypeEnumId === skillTypeEnumId)
const rowOf = (out, partyQualificationId) => out.qualifications?.find(row => row.partyQualificationId === partyQualificationId)

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "People Qualifications Spec A")
        organization(orgB, "People Qualifications Spec B")
        // Ana works for A, managed by Max; HR, a development administrator and a directory reader of A; B's HR
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA)
        state.max = person("MAX")
        employ(state.max, orgA)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.max,
            toPartyId: state.ana,
            fromDate: since
        })
        for (const kind of ["HR", "DEV", "DIR"]) employ((state[kind] = person(kind)), orgA)
        employ((state.HRB = person("HRB")), orgB)
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE"], state.ana)
        state.uMax = user("MAX", ["PEOPLE_SELF_SERVICE", "PEOPLE_TEAM_VIEW"], state.max)
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.HR)
        state.dev = user("DEV", ["PEOPLE_DEVELOP_VIEW", "PEOPLE_DEVELOP_EDIT"], state.DEV)
        state.dir = user("DIR", ["PEOPLE_DIRECTORY_VIEW"], state.DIR)
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], state.HRB)
        // a welding skill proved by a welding certificate (a certification), and a safety skill
        state.weld = prefix + "_SK_WELD"
        state.safety = prefix + "_SK_SAFETY"
        state.weldCert = prefix + "_QT_WELD"
        call("create#moqui.basic.Enumeration", {enumId: state.weld, enumTypeId: "SkillType", description: "Qual spec welding"})
        call("create#moqui.basic.Enumeration", {enumId: state.safety, enumTypeId: "SkillType", description: "Qual spec safety"})
        call("create#moqui.basic.Enumeration", {
            enumId: state.weldCert,
            enumTypeId: "QualificationType",
            parentEnumId: "QualCertification",
            description: "Qual spec welding certificate"
        })
        // the welder class and Ana's seat of it
        state.classId = call("create#mantle.humanres.position.EmplPositionClass", {title: "Qual spec welder"}).emplPositionClassId
        state.positionId = call("create#mantle.humanres.position.EmplPosition", {
            organizationPartyId: orgA,
            emplPositionClassId: state.classId,
            description: "Qual spec welder seat",
            statusId: "EmpsActive",
            fromDate: since
        }).emplPositionId
        call("create#mantle.humanres.position.EmplPositionParty", {
            emplPositionId: state.positionId,
            partyId: state.ana,
            roleTypeId: "Employee",
            fromDate: since
        })
        // a work effort whose welding needs level 4
        state.workEffortId = call("create#mantle.work.effort.WorkEffort", {
            workEffortTypeEnumId: "WetTask",
            workEffortName: "Qual spec weld job",
            statusId: "WeInPlanning"
        }).workEffortId
        call("create#mantle.work.effort.WorkEffortSkillStandard", {
            workEffortId: state.workEffortId,
            skillTypeEnumId: state.weld,
            minimumSkillLevel: 4
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a job class's requirement has a level, a certificate and required or desired; it is changed at its revision and ended", {
    when() {
        const requirement = (parameters, username = state.hr) =>
            run(username, P + "store#JobRequirement", Object.assign({emplPositionClassId: state.classId}, parameters))
        const out = {
            added: code(requirement({skillTypeEnumId: state.weld, minimumLevel: "3", qualificationTypeEnumId: state.weldCert})),
            badLevel: code(requirement({skillTypeEnumId: state.safety, minimumLevel: "9"})),
            badType: code(requirement({skillTypeEnumId: state.safety, qualificationTypeEnumId: state.weld})),
            reader: code(requirement({skillTypeEnumId: state.safety, minimumLevel: "2"}, state.dev)),
            desired: code(requirement({skillTypeEnumId: state.safety, minimumLevel: "2", requiredFlag: "N"}))
        }
        const read = () => run(state.dev, P + "get#JobClass", {emplPositionClassId: state.classId})
        const before = read()
        const safety = before.skills.find(row => row.skillTypeEnumId === state.safety)
        out.stale = code(requirement({skillTypeEnumId: state.safety, change: true, minimumLevel: "1", expectedRevision: "0"}))
        out.changed = code(
            requirement({skillTypeEnumId: state.safety, change: true, minimumLevel: "1", expectedRevision: safety.revision})
        )
        out.removed = code(requirement({skillTypeEnumId: state.safety, remove: true}))
        const after = read()
        // each period its own row: the first (level 2) ended by the change, the changed one (level 1) ended by the removal
        const periods = () =>
            Array.from(
                ec.entity
                    .find("mantle.humanres.position.EmplPositionClassSkill")
                    .condition({emplPositionClassId: state.classId, skillTypeEnumId: state.safety})
                    .orderBy("fromDate")
                    .disableAuthz()
                    .list()
            ).map(row => [row.minimumLevel, row.thruDate != null])
        out.kept = periods()
        out.again = code(requirement({skillTypeEnumId: state.safety, minimumLevel: "2", requiredFlag: "N"}))
        // a change from a later date: the period in effect ends then, and readers take the period of their date
        const again = read().skills.find(row => row.skillTypeEnumId === state.safety)
        out.later = code(
            requirement({
                skillTypeEnumId: state.safety,
                change: true,
                minimumLevel: "3",
                fromDate: stamp(30),
                expectedRevision: again.revision
            })
        )
        out.periods = periods()
        out.levels = [null, dayText(40)].map(
            asOfDate =>
                requirementOf(check(state.uMax, {emplPositionClassId: state.classId, asOfDate}), state.safety)?.minimumLevel
        )
        out.weld = before.skills.find(row => row.skillTypeEnumId === state.weld)
        out.safety = safety
        out.afterSkills = after.skills.map(row => row.skillTypeEnumId)
        out.skillCount = read().jobClass.skillCount
        return out
    },
    then(out) {
        out.added == "" && out.desired == ""
        out.badLevel == "LEVEL_INVALID" && out.badType == "TYPE_INVALID" && out.reader == "PERMISSION_DENIED"
        out.weld.minimumLevel == 3 && out.weld.minimumLevelText == "3 Proficient" && out.weld.requiredText == "Required"
        out.weld.qualificationTypeName == "Qual spec welding certificate"
        out.safety.requiredText == "Desired" && out.safety.minimumLevel == 2
        out.stale == "REVISION_CHANGED" && out.changed == "" && out.removed == ""
        out.afterSkills == [state.weld]
        out.kept ==
            [
                [2, true],
                [1, true]
            ]
        out.again == "" && out.skillCount == 2 && out.later == ""
        out.periods ==
            [
                [2, true],
                [1, true],
                [2, true],
                [3, false]
            ]
        out.levels == [2, 3]
    }
})

feature("a self-declared skill and an unverified or expired certificate meet nothing; an evaluation and a verified one do", {
    when() {
        const out = {}
        out.declared = run(state.uAna, D + "store#Skill", {skillTypeEnumId: state.weld, skillLevel: "4"})
        out.selfOnly = requirementOf(check(state.uMax, {emplPositionClassId: state.classId}), state.weld)
        out.notEvaluator = code(
            run(state.dir, D + "store#Skill", {partyId: state.ana, skillTypeEnumId: state.weld, skillLevel: "3"})
        )
        out.badLevel = code(run(state.dev, D + "store#Skill", {partyId: state.ana, skillTypeEnumId: state.weld, skillLevel: "7"}))
        out.evaluated = run(state.dev, D + "store#Skill", {
            partyId: state.ana,
            skillTypeEnumId: state.weld,
            skillLevel: "3",
            evidence: "Observed on the line"
        })
        // a later self-declaration is kept as history and does not replace the evaluation
        out.redeclared = run(state.uAna, D + "store#Skill", {skillTypeEnumId: state.weld, skillLevel: "5"})
        out.evaluations = ec.entity
            .find("mantle.humanres.ability.PartySkillEvaluation")
            .condition({partyId: state.ana, skillTypeEnumId: state.weld})
            .disableAuthz()
            .count()
        out.noCertificate = requirementOf(check(state.uMax, {emplPositionClassId: state.classId}), state.weld)
        const submitted = run(state.uAna, D + "store#Qualification", {
            qualificationTypeEnumId: state.weldCert,
            title: "Welding level 2",
            issuerName: "Qual Spec Institute",
            referenceNumber: "WELD-778899",
            fromDate: stamp(-10),
            thruDate: stamp(200)
        })
        state.cert = submitted.partyQualificationId
        out.waiting = requirementOf(check(state.uMax, {emplPositionClassId: state.classId}), state.weld)
        const revision = submitted.revision
        out.own = code(
            run(state.uAna, D + "verify#Qualification", {partyQualificationId: state.cert, expectedRevision: revision})
        )
        out.reader = code(
            run(state.dir, D + "verify#Qualification", {partyQualificationId: state.cert, expectedRevision: revision})
        )
        out.verified = code(
            run(state.dev, D + "verify#Qualification", {partyQualificationId: state.cert, expectedRevision: revision})
        )
        out.changeDecided = code(
            run(state.uAna, D + "store#Qualification", {partyQualificationId: state.cert, title: "X", expectedRevision: revision})
        )
        out.staffing = check(state.uMax, {emplPositionClassId: state.classId})
        out.expiring = requirementOf(check(state.uMax, {emplPositionClassId: state.classId, asOfDate: dayText(185)}), state.weld)
        out.expired = requirementOf(check(state.uMax, {emplPositionClassId: state.classId, asOfDate: dayText(220)}), state.weld)
        // the person's own job class's requirements when none is named, and a work effort's standard at its level
        out.own = [out.own, check(state.uMax, {}).results[0].state]
        out.job = requirementOf(check(state.uMax, {workEffortId: state.workEffortId}), state.weld)
        out.outside = check(state.hrB, {emplPositionClassId: state.classId}).results[0]
        // an HR editor's own qualification (admitted by their own employment at A, with no PEOPLE_SELF_SERVICE) is verified by
        // someone else; a development editor's own skill is a self-declaration
        const hrOwn = run(state.hr, D + "store#Qualification", {qualificationTypeEnumId: "QualDegree", title: "HR spec degree"})
        out.hrOwn = code(
            run(state.hr, D + "verify#Qualification", {
                partyQualificationId: hrOwn.partyQualificationId,
                expectedRevision: hrOwn.revision
            })
        )
        run(state.dev, D + "store#Skill", {partyId: state.DEV, skillTypeEnumId: state.weld, skillLevel: "5"})
        out.devOwn = ec.entity
            .find("mantle.humanres.ability.PartySkill")
            .condition({partyId: state.DEV, skillTypeEnumId: state.weld})
            .disableAuthz()
            .one()?.sourceEnumId
        return out
    },
    then(out) {
        out.declared.accepted && out.selfOnly.state == "missing" && out.selfOnly.explanation.startsWith("Self-declared only")
        out.notEvaluator == "PERMISSION_DENIED" && out.badLevel == "LEVEL_INVALID"
        out.evaluated.accepted && !out.redeclared.accepted && out.evaluations == 3
        out.noCertificate.state == "missing" && out.noCertificate.explanation == "No verified qualification"
        out.waiting.state == "missing" && out.waiting.explanation == "Waiting for verification"
        out.own == ["SELF_APPROVAL", "qualified"]
        // a reader who sees no waiting qualification is answered as for a missing one
        out.reader == "RECORD_UNAVAILABLE" && out.verified == "" && out.changeDecided == "QUALIFICATION_DECIDED"
        out.staffing.results[0].state == "qualified" && requirementOf(out.staffing, state.weld).validThruText != ""
        // the staffing answer: no number, issuer, title or file
        const answer = JSON.stringify(out.staffing)
        !answer.includes("WELD-778899") && !answer.includes("Qual Spec Institute") && !answer.includes("Welding level 2")
        !answer.includes("contentLocation") && !answer.includes("referenceNumber")
        out.expiring.state == "expiring" && out.expiring.explanation.startsWith("Expires ")
        out.expired.state == "expired" && out.expired.explanation.startsWith("Expired ")
        out.job.state == "missing" && out.job.explanation == "Level 3 Proficient of 4 Advanced"
        out.outside.state == "unavailable" && out.outside.requirements.length == 0 && out.outside.personName == null
        out.hrOwn == "SELF_APPROVAL" && out.devOwn == "SksSelfDeclared"
    }
})

feature("an identity document or work permit needs an expiry; its number is the person's and HR's, and only HR verifies it", {
    when() {
        const permit = parameters =>
            run(
                state.uAna,
                D + "store#Qualification",
                Object.assign(
                    {qualificationTypeEnumId: "QualWorkPermit", referenceNumber: "WP-1234", title: "Seasonal permit"},
                    parameters
                )
            )
        const out = {
            noExpiry: code(permit({})),
            devSubmits: code(
                run(state.dev, D + "store#Qualification", {
                    partyId: state.ana,
                    qualificationTypeEnumId: "QualWorkPermit",
                    thruDate: stamp(90)
                })
            )
        }
        const stored = permit({thruDate: stamp(90)})
        state.permit = stored.partyQualificationId
        const list = username => run(username, D + "find#Qualifications", {partyId: state.ana})
        const mine = run(state.uAna, D + "find#Qualifications", {mine: true})
        out.ownNumber = rowOf(mine, state.permit)?.referenceNumber
        out.hrNumber = rowOf(list(state.hr), state.permit)?.referenceNumber
        const developRow = rowOf(list(state.dev), state.permit)
        out.devNumber = developRow ? developRow.referenceNumber : "absent"
        out.devCertNumber = rowOf(list(state.dev), state.cert)?.referenceNumber
        out.managerBefore = rowOf(list(state.uMax), state.permit) ? "shown" : "absent"
        out.devVerifies = code(
            run(state.dev, D + "verify#Qualification", {partyQualificationId: state.permit, expectedRevision: stored.revision})
        )
        out.hrVerifies = code(
            run(state.hr, D + "verify#Qualification", {partyQualificationId: state.permit, expectedRevision: stored.revision})
        )
        out.managerRow = rowOf(list(state.uMax), state.permit)
        out.managerKeys = Object.keys(out.managerRow || {})
        out.otherEmployer = code(list(state.hrB))
        // the files: the person's and HR's, not development's or another employer's
        const files = username => run(username, D + "check#QualificationAccess", {partyQualificationId: state.permit})
        out.files = [files(state.uAna), files(state.hr), files(state.dev), files(state.hrB)].map(found => [
            !!found.recordVisible,
            !!found.canEdit
        ])
        out.linkInfo = run(state.dev, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
            recordEntityName: QUALIFICATION,
            recordId: state.permit,
            checkOnly: true
        }).recordVisible
        out.hrLinkInfo = run(state.hr, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
            recordEntityName: QUALIFICATION,
            recordId: state.permit,
            checkOnly: true
        })
        return out
    },
    then(out) {
        out.noExpiry == "EXPIRY_REQUIRED" && out.devSubmits == "PERMISSION_DENIED"
        out.ownNumber == "WP-1234" && out.hrNumber == "WP-1234" && out.devNumber == null && out.devCertNumber == "WELD-778899"
        out.managerBefore == "absent"
        out.devVerifies == "PERMISSION_DENIED" && out.hrVerifies == ""
        out.managerRow.validity == "valid" || out.managerRow.validity == "expiring"
        !out.managerKeys.includes("referenceNumber") &&
            !out.managerKeys.includes("title") &&
            !out.managerKeys.includes("issuerName")
        out.otherEmployer == "RECORD_UNAVAILABLE"
        out.files ==
            [
                [true, false],
                [true, true],
                [false, false],
                [false, false]
            ]
        out.linkInfo == false && out.hrLinkInfo.recordVisible
        out.hrLinkInfo.contentEntity.entityName == "mantle.humanres.ability.PartyQualificationContent"
    }
})

feature("the skills matrix shows the person against their job class; an expiry is reminded once and a renewal ends it", {
    when() {
        const out = {}
        const matrix = run(state.dev, D + "get#SkillsMatrix", {organizationPartyId: orgA, emplPositionClassId: state.classId})
        const ana = matrix.rows?.find(row => row.partyId === state.ana)
        out.columns = matrix.columns?.map(column => column.skillTypeEnumId)
        out.cells = ana?.cells.map(cell => [cell.state, cell.levelText])
        out.gaps = ana?.gapCount
        out.canEvaluate = ana?.canEvaluate
        out.reader = code(run(state.dir, D + "get#SkillsMatrix", {}))
        out.manager = run(state.uMax, D + "get#SkillsMatrix", {}).rows?.map(row => row.partyId)
        // a verified certificate expiring in ten days, reminded once however often the job runs
        const soon = call("create#" + QUALIFICATION, {
            partyId: state.ana,
            qualificationTypeEnumId: "QualLicence",
            title: "Forklift",
            fromDate: stamp(-300),
            thruDate: stamp(10),
            verificationStatusId: "QlVerVerified"
        }).partyQualificationId
        out.attention = run(state.uAna, D + "find#Qualifications", {mine: true, show: "attention"}).qualifications.map(
            row => row.partyQualificationId
        )
        const first = run("john.doe", D + "send#ExpiryReminders")
        const second = run("john.doe", D + "send#ExpiryReminders")
        out.sent = [first.sentCount, second.sentCount]
        const ids = Array.from(
            ec.entity.find("moqui.security.user.NotificationMessageUser").condition("userId", state.uAna).disableAuthz().list()
        ).map(row => row.notificationMessageId)
        out.titles = ids.length
            ? Array.from(
                  ec.entity
                      .find("moqui.security.user.NotificationMessage")
                      .condition("notificationMessageId", "in", ids)
                      .condition("topic", "QualificationExpiring")
                      .disableAuthz()
                      .list()
              ).map(row => row.titleText)
            : []
        // its renewal, verified: the old one no longer needs attention
        const renewal = run(state.uAna, D + "store#Qualification", {
            qualificationTypeEnumId: "QualLicence",
            title: "Forklift",
            thruDate: stamp(700),
            renewsQualificationId: soon
        })
        out.badRenewal = code(
            run(state.uAna, D + "store#Qualification", {qualificationTypeEnumId: "QualDegree", renewsQualificationId: soon})
        )
        run(state.dev, D + "verify#Qualification", {
            partyQualificationId: renewal.partyQualificationId,
            expectedRevision: renewal.revision
        })
        out.after = run(state.uAna, D + "find#Qualifications", {mine: true, show: "attention"}).qualifications.length
        out.soon = soon
        const development = run(state.uMax, D + "get#PersonDevelopment", {partyId: state.ana})
        out.development = [development.showsSkills, development.showsResume, development.skills.length, development.canEvaluate]
        out.devDevelopment = run(state.dev, D + "get#PersonDevelopment", {partyId: state.ana}).canEvaluate
        out.hidden = run(state.hrB, D + "get#PersonDevelopment", {partyId: state.ana, checkOnly: true}).visible
        // the user's call of Nov 12, 2026: Max evaluates his report's safety skill without PEOPLE_DEVELOP_EDIT, recorded as his
        // evaluation, and it meets the requirement; he is refused a person who is not his report
        const managed = run(state.uMax, D + "store#Skill", {partyId: state.ana, skillTypeEnumId: state.safety, skillLevel: "2"})
        const evaluation = ec.entity
            .find("mantle.humanres.ability.PartySkillEvaluation")
            .condition("partySkillEvaluationId", managed.partySkillEvaluationId || "_NA_")
            .disableAuthz()
            .one()
        out.managed = [!!managed.accepted, evaluation?.sourceEnumId, evaluation?.assessorPartyId]
        out.managedSource = run(state.dev, D + "get#PersonDevelopment", {partyId: state.ana}).skills.find(
            row => row.skillTypeEnumId === state.safety
        )?.sourceText
        out.managedState = requirementOf(check(state.uMax, {emplPositionClassId: state.classId}), state.safety)?.state
        out.notReport = code(
            run(state.uMax, D + "store#Skill", {partyId: state.DIR, skillTypeEnumId: state.safety, skillLevel: "2"})
        )
        return out
    },
    then(out) {
        out.columns == [state.safety, state.weld]
        out.cells ==
            [
                ["gap", ""],
                ["met", "3 Proficient"]
            ] &&
            out.gaps == 0 &&
            out.canEvaluate
        out.reader == "PERMISSION_DENIED" && out.manager == [state.ana]
        out.attention == [out.soon]
        out.sent[0] >= 1 && out.sent[1] == 0
        out.titles.length == 1 && out.titles[0].startsWith("Your licence expires on ")
        out.badRenewal == "RENEWAL_INVALID" && out.after == 0
        out.development == [true, false, 1, true] && out.devDevelopment && out.hidden == false
        out.managed == [true, "SksManagerEvaluated", state.max] && out.managedSource == "Manager's evaluation"
        out.managedState == "qualified" && out.notReport == "RECORD_UNAVAILABLE"
    }
})
