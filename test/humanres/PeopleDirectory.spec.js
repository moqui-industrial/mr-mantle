// The employee record (mantle.humanres.PeopleServices find#Employees, get#Employee360, get#EmploymentHistory, store#PersonalInfo,
// check#EmploymentAccess, create#EmploymentContent; IronStone People design §4 Employees and Employee360, §1.1, §13; impl-people
// P2): a directory reader's answer holds the public work identity and no private contact, identification or pay field, in the
// list and in Employee360, whose other regions are absent for them; a second employer's HR sees its own employment of a person
// employed by both and nothing of the first's; the person corrects only the permitted fields and HR the rest, a stale revision
// refused; the history is HR's and the person's; and the employment content host opens to an HR reader of its employer only,
// through get#RecordLinkInfo too. Standalone: spec-local organizations, people, employments, groups and users, with artifact
// authorization disabled (the rules are the services' own permission and scope checks).
// Run: ./moq test mr-mantle --spec PeopleDirectory
const prefix = "PEOPLE_DIR_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.humanres.PeopleServices."
const day = 24 * 60 * 60 * 1000
const state = {}
// the fields of a directory row for a reader who is not HR: the public work identity
const publicFields = [
    "jobTitle",
    "managerName",
    "managerPartyId",
    "organizationName",
    "organizationPartyId",
    "partyId",
    "personName",
    "preferredName",
    "state",
    "stateText",
    "workEmail",
    "workLocation",
    "workPhone"
]

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
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
const code = out => (out.error ? /[A-Z][A-Z0-9_]+(?=:)/.exec(out.error)?.[0] || out.error : "")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind, nickname = null) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Directory", lastName: kind, nickname})
    return partyId
}
function employ(partyId, organizationPartyId, fromDate = since, thruDate = null) {
    return call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate,
        thruDate
    }).partyRelationshipId
}
function contact(partyId, purposeId, values) {
    call("mantle.party.ContactServices.store#PartyContactInfo", Object.assign({partyId}, values, purposeId))
}
// a user of a spec-local group with the permissions, an agent of the organizations (or the person given)
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People directory " + kind})
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

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "People Directory Spec A")
        organization(orgB, "People Directory Spec B")
        // A: a manager and their report (with a preferred name, private contacts and identifications), one ended ten days ago;
        // the report is employed by B too; B: its own employee
        state.MANAGER = person("MANAGER")
        state.REPORT = person("REPORT", "Rory")
        state.ENDED = person("ENDED")
        state.BETA = person("BETA")
        employ(state.MANAGER, orgA)
        state.reportA = employ(state.REPORT, orgA)
        state.reportB = employ(state.REPORT, orgB, now - 30 * day)
        state.endedEmployment = employ(state.ENDED, orgA, since, now - 10 * day)
        employ(state.BETA, orgB)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.MANAGER,
            fromRoleTypeId: "Manager",
            toPartyId: state.REPORT,
            toRoleTypeId: "Employee",
            fromDate: since
        })
        contact(state.REPORT, {emailContactMechPurposeId: "EmailPrimary"}, {emailAddress: "rory.work@directory.example"})
        contact(state.REPORT, {telecomContactMechPurposeId: "PhoneWork"}, {contactNumber: "555-0100"})
        contact(state.REPORT, {telecomContactMechPurposeId: "PhoneHome"}, {contactNumber: "555-0199"})
        contact(
            state.REPORT,
            {postalContactMechPurposeId: "PostalHome"},
            {address1: "1 Private Lane", city: "Hometown", postalCode: "84000", countryGeoId: "USA"}
        )
        call("create#mantle.party.PartyIdentification", {
            partyId: state.REPORT,
            partyIdTypeEnumId: "PtidPassport",
            idValue: "P12345678"
        })
        call("create#mantle.party.PartyIdentification", {
            partyId: state.REPORT,
            partyIdTypeEnumId: "PtidSsn",
            idValue: "123-45-6789"
        })
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrView = user("HRVIEW", ["PEOPLE_HR_VIEW"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.self = user("SELF", ["PEOPLE_SELF_SERVICE"], [], state.REPORT)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "a directory reader finds the public work identity only, current employments of their employers; HR gets the HR columns and the ended ones; another employer is refused",
    {
        when() {
            const reader = run(state.reader, S + "find#Employees", {includeEnded: true})
            const search = run(state.reader, S + "find#Employees", {term: "rORy"})
            const managed = run(state.reader, S + "find#Employees", {managerPartyId: state.MANAGER})
            const hr = run(state.hr, S + "find#Employees", {includeEnded: true})
            const other = run(state.reader, S + "find#Employees", {organizationPartyId: orgB})
            const report = (reader.employees || []).find(row => row.partyId == state.REPORT) || {}
            const hrReport = (hr.employees || []).find(row => row.partyId == state.REPORT) || {}
            return {reader, search, managed, hr, other, report, hrReport}
        },
        then({reader, search, managed, hr, other, report, hrReport}) {
            reader.error == ""
            reader.hrColumns == false
            reader.employees.map(row => row.partyId).sort() == [state.MANAGER, state.REPORT].sort()
            Object.keys(report).sort() == publicFields
            report.preferredName == "Rory"
            report.workEmail == "rory.work@directory.example"
            report.workPhone == "555-0100"
            report.managerName == "Directory MANAGER"
            report.organizationPartyId == orgA
            search.employees.map(row => row.partyId) == [state.REPORT]
            managed.employees.map(row => row.partyId) == [state.REPORT]
            hr.hrColumns == true
            hr.employees.map(row => row.partyId).includes(state.ENDED)
            hr.employees.find(row => row.partyId == state.ENDED).stateText == "Ended"
            hrReport.partyRelationshipId == state.reportA
            hrReport.fromDateText != ""
            !JSON.stringify(hr).includes("555-0199")
            !JSON.stringify(hr).includes("Private Lane")
            code(other) == "ORGANIZATION_DENIED"
        }
    }
)

feature(
    "Employee360 answers the regions a caller may read: a directory reader the Overview alone, HR and the person the private regions; a second employer's HR sees its own employment only",
    {
        when() {
            const reader = run(state.reader, S + "get#Employee360", {partyId: state.REPORT})
            const hr = run(state.hr, S + "get#Employee360", {partyId: state.REPORT})
            const hrB = run(state.hrB, S + "get#Employee360", {partyId: state.REPORT})
            const self = run(state.self, S + "get#Employee360", {partyId: state.REPORT})
            const forged = run(state.hr, S + "get#Employee360", {partyId: state.REPORT, partyRelationshipId: state.reportB})
            const outside = run(state.reader, S + "get#Employee360", {partyId: state.BETA})
            return {reader, hr, hrB, self, forged, outside}
        },
        then({reader, hr, hrB, self, forged, outside}) {
            reader.error == ""
            reader.regions == ["overview"]
            reader.personalInfo == null
            reader.partyRelationshipId == null
            reader.overview.employments.map(row => row.organizationPartyId) == [orgA]
            !JSON.stringify(reader).includes("555-0199")
            !JSON.stringify(reader).includes("P12345678")
            hr.regions == ["overview", "employmentHistory", "personalInfo", "filesAndActivity"]
            hr.hostEmploymentId == state.reportA
            hr.personalInfo.homePhone == "555-0199"
            hr.personalInfo.homeAddress.includes("1 Private Lane")
            hr.personalInfo.identifications.map(row => row.partyIdTypeEnumId) == ["PtidPassport"]
            hr.personalInfo.identifications[0].valueText == "•••• 5678"
            !JSON.stringify(hr).includes("6789")
            hrB.overview.employments.map(row => row.organizationPartyId) == [orgB]
            hrB.hostEmploymentId == state.reportB
            self.regions == ["overview", "employmentHistory", "personalInfo"]
            self.personalInfo.identifications == null
            self.capabilities.selfFields == ["preferredName", "homePhone", "mobilePhone"]
            code(forged) == "RECORD_UNAVAILABLE"
            code(outside) == "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "the person corrects their preferred name and not their legal name; HR corrects a home address by date; a stale revision and a reader are refused; the history is HR's and the person's",
    {
        when() {
            const revision = () => run(state.hr, S + "get#Employee360", {partyId: state.REPORT}).personalInfo.revision
            const first = revision()
            const selfName = run(state.self, S + "store#PersonalInfo", {
                partyId: state.REPORT,
                expectedRevision: first,
                preferredName: "Ror"
            })
            const stale = run(state.self, S + "store#PersonalInfo", {
                partyId: state.REPORT,
                expectedRevision: first,
                preferredName: "R"
            })
            const selfLegal = run(state.self, S + "store#PersonalInfo", {
                partyId: state.REPORT,
                expectedRevision: revision(),
                firstName: "Changed"
            })
            const reader = run(state.reader, S + "store#PersonalInfo", {
                partyId: state.REPORT,
                expectedRevision: revision(),
                preferredName: "X"
            })
            const hrAddress = run(state.hr, S + "store#PersonalInfo", {
                partyId: state.REPORT,
                expectedRevision: revision(),
                address1: "2 New Road",
                city: "Newtown"
            })
            const after = run(state.hr, S + "get#Employee360", {partyId: state.REPORT}).personalInfo
            const homeRows = ec.entity
                .find("mantle.party.contact.PartyContactMech")
                .condition({partyId: state.REPORT, contactMechPurposeId: "PostalHome"})
                .disableAuthz()
                .count()
            const history = run(state.hr, S + "get#EmploymentHistory", {partyId: state.ENDED})
            const selfHistory = run(state.self, S + "get#EmploymentHistory", {partyId: state.REPORT})
            const readerHistory = run(state.reader, S + "get#EmploymentHistory", {partyId: state.REPORT})
            return {selfName, stale, selfLegal, reader, hrAddress, after, homeRows, history, selfHistory, readerHistory}
        },
        then({selfName, stale, selfLegal, reader, hrAddress, after, homeRows, history, selfHistory, readerHistory}) {
            selfName.error == ""
            code(stale) == "REVISION_CHANGED"
            code(selfLegal) == "FIELD_NOT_PERMITTED"
            code(reader) == "PERMISSION_DENIED"
            hrAddress.error == ""
            after.preferredName == "Ror"
            after.firstName == "Directory"
            after.homeAddress.startsWith("2 New Road")
            after.homeAddress.includes("84000")
            homeRows == 2
            history.history.map(row => row.partyRelationshipId) == [state.endedEmployment]
            history.history[0].stateText == "Ended"
            selfHistory.history.map(row => row.organizationPartyId).sort() == [orgA, orgB].sort()
            code(readerHistory) == "PERMISSION_DENIED"
        }
    }
)

feature(
    "an employment's files and activity open to an HR reader of its employer, edited with PEOPLE_HR_EDIT; another employer's HR, a directory reader and the person are refused, through get#RecordLinkInfo too",
    {
        when() {
            const access = (user, partyRelationshipId) => {
                const out = run(user, S + "check#EmploymentAccess", {partyRelationshipId})
                return [out.recordVisible, out.canEdit].join(",")
            }
            const linked = (user, partyRelationshipId) =>
                run(user, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
                    recordEntityName: "mantle.humanres.employment.Employment",
                    recordId: partyRelationshipId,
                    checkOnly: true
                }).recordVisible
            const created = run(state.hr, S + "create#EmploymentContent", {
                partyRelationshipId: state.reportA,
                contentTypeEnumId: "EmcntContract",
                description: "Signed contract"
            })
            const viewOnly = run(state.hrView, S + "create#EmploymentContent", {
                partyRelationshipId: state.reportA,
                description: "Not added"
            })
            const otherEmployer = run(state.hrB, S + "create#EmploymentContent", {
                partyRelationshipId: state.reportA,
                description: "Not added"
            })
            const info = run(state.hr, "mantle.party.CommunicationServices.get#RecordLinkInfo", {
                recordEntityName: "mantle.humanres.employment.Employment",
                recordId: state.reportA,
                checkOnly: true
            })
            return {
                hr: access(state.hr, state.reportA),
                hrView: access(state.hrView, state.reportA),
                hrB: access(state.hrB, state.reportA),
                reader: access(state.reader, state.reportA),
                self: access(state.self, state.reportA),
                linkHr: linked(state.hr, state.reportA),
                linkReader: linked(state.reader, state.reportA),
                linkSelf: linked(state.self, state.reportA),
                created,
                viewOnly,
                otherEmployer,
                info
            }
        },
        then({hr, hrView, hrB, reader, self, linkHr, linkReader, linkSelf, created, viewOnly, otherEmployer, info}) {
            hr == "true,true"
            hrView == "true,false"
            hrB == "false,false"
            reader == "false,false"
            self == "false,false"
            linkHr == true
            linkReader == false
            linkSelf == false
            created.error == ""
            created.employmentContentId != null
            code(viewOnly) == "PERMISSION_DENIED"
            code(otherEmployer) == "RECORD_UNAVAILABLE"
            info.contentEntity.entityName == "mantle.humanres.employment.EmploymentContent"
            info.contentEntity.keyField == "partyRelationshipId"
        }
    }
)
