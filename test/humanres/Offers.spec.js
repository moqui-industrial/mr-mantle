// People's offers of employment (mantle.humanres.RecruitingServices, Offers.js; PeopleServices hire#Employee from an offer and the
// lifecycle letters, Letters.js; impl-people P17, design-people §5 OfferDetail, §15, PE-04, PE-02): a recruiter drafts an offer of
// an interviewed application on a seat of its opening and sets no pay; the pay terms are set by payroll alone and absent without
// PAYROLL_VIEW on every path (the offer, the list, the letter's preview, the stored letter, the approval's notice); an offer waits
// for the employer's HR officers, never its recruiter, and changed terms make it a draft again and supersede its approval; the
// letter of an issued offer is stored once and read from storage, never rendered again; an accepted offer is hired from once by
// HR (a second hire from it refused, a retry answering the first) and grants no account or pay record; the lifecycle letter of an
// applied change is issued once by HR on the same template.
// Standalone: spec-local organizations, people, employments, seats, an opening, groups and users, artifact authorization disabled
// (the rules are the services' own checks). The approval routing is PeopleApprovals', the hire's PeopleEmployment.
// Run: ./moq test mr-mantle --spec Offers
const prefix = "PEOPLE_OFFER_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const R = "mantle.humanres.RecruitingServices."
const P = "mantle.humanres.PeopleServices."
const OFFER = "mantle.humanres.recruitment.EmploymentOffer"
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
const read = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const count = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().count()
const day = days => ec.l10n.format(new Date(Date.now() + days * 24 * 60 * 60 * 1000), "yyyy-MM-dd")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
// a person employed by the organization, with an account holding the permissions
function user(kind, organizationPartyId, permissions) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Offer", lastName: kind})
    call("mantle.humanres.EmploymentServices.create#Employment", {
        fromPartyId: partyId,
        toPartyId: organizationPartyId,
        fromDate: since
    })
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Offers " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return {userId: id, partyId}
}
function seat(id, organizationPartyId) {
    call("create#mantle.humanres.position.EmplPosition", {
        emplPositionId: prefix + "_" + id,
        organizationPartyId,
        statusId: "EmpsActive",
        description: "Seat " + id,
        fromDate: since
    })
    return prefix + "_" + id
}
// the latest approval notice of an offer: its message as the tray passes it
function notice(employmentOfferId) {
    const row = Array.from(
        ec.entity
            .find("moqui.security.user.NotificationMessage")
            .condition({topic: "PeopleOfferApproval", recordId: employmentOfferId})
            .orderBy("-sentDate")
            .limit(1)
            .disableAuthz()
            .list()
    )[0]
    return row ? {messageJson: row.messageJson, message: JSON.parse(row.messageJson)} : null
}
const noPay = value => !/52[,.]?000/.test(JSON.stringify(value))

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Offers Spec A")
        organization(orgB, "Offers Spec B")
        state.recruiter = user("RECRUITER", orgA, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT", "PEOPLE_REQUEST_APPROVE"])
        state.hr = user("HR", orgA, ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"])
        state.payroll = user("PAYROLL", orgA, ["PAYROLL_VIEW", "PAYROLL_EDIT"])
        state.reader = user("READER", orgA, ["PEOPLE_DIRECTORY_VIEW"])
        state.recruiterB = user("RECRUITER_B", orgB, ["PEOPLE_RECRUIT_VIEW", "PEOPLE_RECRUIT_EDIT"])
        state.seat = seat("ASSOC", orgA)
        state.otherSeat = seat("OTHER", orgA)
        // the employer's working week, which the offer names and the hire's first assignment follows
        state.scheduleId = prefix + "_WEEK"
        call("create#mantle.humanres.schedule.WorkingSchedule", {
            workingScheduleId: state.scheduleId,
            scheduleName: "Spec week",
            organizationPartyId: orgA,
            timeZone: "UTC",
            fromDate: since
        })
        const opening = run(state.recruiter.userId, R + "store#Opening", {
            organizationPartyId: orgA,
            title: "Spec associate",
            emplPositionIds: state.seat,
            action: "open"
        })
        state.openingId = opening.jobOpeningId
        const made = run(state.recruiter.userId, R + "create#Application", {
            jobOpeningId: opening.jobOpeningId,
            firstName: "Olivia",
            lastName: "Offered",
            emailAddress: "olivia.offer.spec@example.test"
        })
        state.applicationId = made.employmentApplicationId
        state.applicantPartyId = made.applicantPartyId
        // interviewed (the interview itself is Recruiting's)
        call("update#mantle.humanres.employment.EmploymentApplication", {
            employmentApplicationId: made.employmentApplicationId,
            statusId: "EaScreening"
        })
        call("update#mantle.humanres.employment.EmploymentApplication", {
            employmentApplicationId: made.employmentApplicationId,
            statusId: "EaInterview"
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
        ec.artifactExecution.enableAuthz()
    }
})

feature("a recruiter drafts an offer and sets no pay; payroll alone sets and reads the pay, absent on every other path", {
    when() {
        const store = (who, values) => run(who.userId, R + "store#Offer", values)
        const terms = {
            employmentApplicationId: state.applicationId,
            emplPositionId: state.seat,
            workingScheduleId: state.scheduleId,
            fromDate: day(21),
            expireDate: day(10),
            note: "We look forward to working with you."
        }
        const reader = code(store(state.reader, terms))
        const otherEmployer = code(store(state.recruiterB, terms))
        const notOfOpening = code(store(state.recruiter, Object.assign({}, terms, {emplPositionId: state.otherSeat})))
        const withPay = code(store(state.recruiter, Object.assign({}, terms, {payAmount: "52000", currencyUomId: "USD"})))
        const drafted = store(state.recruiter, terms)
        state.offerId = drafted.employmentOfferId
        const second = code(store(state.recruiter, terms))
        const recruiterPay = code(
            store(state.recruiter, {
                employmentOfferId: state.offerId,
                payAmount: "52000",
                currencyUomId: "USD",
                timePeriodTypeId: "PayrollYear"
            })
        )
        const incomplete = code(store(state.payroll, {employmentOfferId: state.offerId, payAmount: "52000"}))
        const paid = store(state.payroll, {
            employmentOfferId: state.offerId,
            payAmount: "52000",
            currencyUomId: "USD",
            timePeriodTypeId: "PayrollYear"
        })
        const get = who => run(who.userId, R + "get#Offer", {employmentOfferId: state.offerId})
        const letter = who => run(who.userId, R + "get#OfferLetter", {employmentOfferId: state.offerId})
        return {
            reader,
            otherEmployer,
            notOfOpening,
            withPay,
            drafted,
            second,
            recruiterPay,
            incomplete,
            paid,
            stage: read("mantle.humanres.employment.EmploymentApplication", {employmentApplicationId: state.applicationId})
                .statusId,
            recruiterView: get(state.recruiter),
            hrView: get(state.hr),
            payrollView: get(state.payroll),
            readerView: code(get(state.reader)),
            otherView: code(get(state.recruiterB)),
            list: run(state.recruiter.userId, R + "find#Offers", {employmentApplicationId: state.applicationId}),
            recruiterLetter: letter(state.recruiter),
            payrollLetter: letter(state.payroll)
        }
    },
    then(r) {
        r.reader == "RECORD_UNAVAILABLE"
        r.otherEmployer == "RECORD_UNAVAILABLE"
        r.notOfOpening == "POSITION_NOT_OF_OPENING"
        r.withPay == "PERMISSION_DENIED"
        r.drafted.error == ""
        r.drafted.statusId == "OfrDraft"
        r.stage == "EaOffer"
        r.second == "OFFER_OPEN"
        r.recruiterPay == "PERMISSION_DENIED"
        r.incomplete == "PAY_INCOMPLETE"
        r.paid.changed == true
        r.recruiterView.offer.positionName == "Seat ASSOC"
        r.recruiterView.offer.hasPayTerms == true
        r.recruiterView.offer.payAmount == null
        r.recruiterView.offer.canEdit == true
        r.recruiterView.offer.canEditPay == false
        noPay(r.recruiterView)
        noPay(r.hrView)
        noPay(r.list)
        r.list.offers.length == 1
        r.payrollView.offer.payText.includes("52,000")
        r.payrollView.offer.canEdit == false
        r.payrollView.offer.canEditPay == true
        r.readerView == "RECORD_UNAVAILABLE"
        r.otherView == "RECORD_UNAVAILABLE"
        r.recruiterLetter.letterHtml.includes("Offer of employment")
        r.recruiterLetter.letterHtml.includes("Draft")
        r.recruiterLetter.letterHtml.includes("Olivia Offered")
        noPay(r.recruiterLetter)
        r.payrollLetter.letterHtml.includes("52,000")
    }
})

feature(
    "an offer waits for the employer's HR, never its recruiter; changed terms make it a draft again and supersede the approval",
    {
        when() {
            const move = (who, action, extra = {}) =>
                run(who.userId, R + "change#OfferState", Object.assign({employmentOfferId: state.offerId, action}, extra))
            const byPayroll = code(move(state.payroll, "submit"))
            const submitted = move(state.recruiter, "submit")
            const again = move(state.recruiter, "submit")
            const first = notice(state.offerId)
            const own = code(move(state.recruiter, "approve"))
            // new terms while it waits: a draft again, the waiting approval superseded and its notice no longer decided
            const changed = run(state.recruiter.userId, R + "store#Offer", {employmentOfferId: state.offerId, thruDate: day(400)})
            const stale = code(
                run(state.hr.userId, R + "approve#Offer", {
                    recordEntityName: OFFER,
                    recordId: state.offerId,
                    message: first.message
                })
            )
            move(state.recruiter, "submit")
            const second = notice(state.offerId)
            const refused = run(state.hr.userId, R + "refuse#Offer", {
                recordEntityName: OFFER,
                recordId: state.offerId,
                message: second.message,
                reason: "Start a week later"
            })
            const afterRefusal = read(OFFER, {employmentOfferId: state.offerId})
            run(state.recruiter.userId, R + "store#Offer", {employmentOfferId: state.offerId, fromDate: day(28)})
            move(state.recruiter, "submit")
            const third = notice(state.offerId)
            const approved = run(state.hr.userId, R + "approve#Offer", {
                recordEntityName: OFFER,
                recordId: state.offerId,
                message: third.message
            })
            const view = run(state.hr.userId, R + "get#Offer", {employmentOfferId: state.offerId})
            return {byPayroll, submitted, again, first, own, changed, stale, refused, afterRefusal, third, approved, view}
        },
        then(r) {
            r.byPayroll == "PERMISSION_DENIED"
            r.submitted.statusId == "OfrSubmitted"
            r.again.repeated == true
            r.first != null
            r.first.message.employmentOfferId == state.offerId
            noPay(r.first.messageJson)
            r.own == "SELF_APPROVAL"
            r.changed.statusId == "OfrDraft"
            r.stale == "NOT_PENDING" || r.stale == "SOURCE_CHANGED" || r.stale == "REVISION_CHANGED"
            r.refused.statusId == "OfrDraft"
            r.afterRefusal.decisionReason == "Start a week later"
            r.approved.statusId == "OfrApproved"
            r.view.offer.approval.statusId == "PapApproved"
            r.view.offer.canIssue == true
        }
    }
)

feature(
    "an issued offer's letter is stored once and read from storage, its pay payroll's; accepted, HR hires from it once and it grants no account or pay",
    {
        when() {
            const move = (who, action, extra = {}) =>
                run(who.userId, R + "change#OfferState", Object.assign({employmentOfferId: state.offerId, action}, extra))
            const early = code(move(state.recruiter, "accept"))
            const issued = move(state.recruiter, "issue")
            const reissued = move(state.recruiter, "issue")
            const recruiterLetter = code(run(state.recruiter.userId, R + "get#OfferLetter", {employmentOfferId: state.offerId}))
            const payrollLetter = run(state.payroll.userId, R + "get#OfferLetter", {employmentOfferId: state.offerId})
            // the stored file's bytes (a digest) and its text (a PDF's, or the html-print page where there is no PDF engine)
            const digestOf = out => ec.resource.digest(out.letter.location)
            const textOf = (out, key) => ec.resource.extractText(out.letter.location, prefix + "-" + key) || ""
            const before = digestOf(payrollLetter)
            const beforeText = textOf(payrollLetter, "before")
            // the record changes after the letter is issued; the letter stays the statement it made
            call("update#mantle.humanres.recruitment.JobOpening", {jobOpeningId: state.openingId, title: "Renamed after issue"})
            call("update#mantle.party.Person", {partyId: state.applicantPartyId, nickname: "Liv"})
            const later = run(state.payroll.userId, R + "get#OfferLetter", {employmentOfferId: state.offerId})
            const locked = code(run(state.recruiter.userId, R + "store#Offer", {employmentOfferId: state.offerId, thruDate: ""}))
            const accepted = move(state.recruiter, "accept", {responseNote: "Signed and returned"})
            const hire = (who, key, extra = {}) =>
                run(who.userId, P + "hire#Employee", Object.assign({employmentOfferId: state.offerId, operationKey: key}, extra))
            const byRecruiter = code(hire(state.recruiter, "OFFER-SPEC-0"))
            const otherPerson = code(hire(state.hr, "OFFER-SPEC-X", {partyId: state.reader.partyId}))
            const preview = run(state.hr.userId, P + "preview#Hire", {employmentOfferId: state.offerId})
            const hired = hire(state.hr, "OFFER-SPEC-1")
            const retried = hire(state.hr, "OFFER-SPEC-1")
            const secondHire = code(hire(state.hr, "OFFER-SPEC-2"))
            state.hireChangeId = hired.employmentChangeId
            return {
                early,
                issued,
                reissued,
                recruiterLetter,
                payrollLetter,
                before,
                later,
                after: digestOf(later),
                beforeText,
                afterText: textOf(later, "after"),
                letters: count("mantle.humanres.employment.EmploymentLetter", {employmentOfferId: state.offerId}),
                locked,
                accepted,
                byRecruiter,
                otherPerson,
                preview,
                hired,
                retried,
                secondHire,
                offer: read(OFFER, {employmentOfferId: state.offerId}),
                stage: read("mantle.humanres.employment.EmploymentApplication", {employmentApplicationId: state.applicationId})
                    .statusId,
                accounts: count("moqui.security.UserAccount", {partyId: state.applicantPartyId}),
                salaries: count("mantle.humanres.employment.EmploymentSalary", {partyRelationshipId: hired.partyRelationshipId}),
                change: read("mantle.humanres.employment.EmploymentChange", {employmentChangeId: hired.employmentChangeId}),
                scheduled: count("mantle.humanres.employment.EmploymentAssignment", {
                    partyRelationshipId: hired.partyRelationshipId,
                    workingScheduleId: state.scheduleId
                }),
                employments: count("mantle.party.PartyRelationship", {
                    fromPartyId: state.applicantPartyId,
                    toPartyId: orgA,
                    relationshipTypeEnumId: "PrtEmployee"
                })
            }
        },
        then(r) {
            r.early == "NOT_ISSUED"
            r.issued.statusId == "OfrIssued"
            r.reissued.repeated == true
            r.recruiterLetter == "PERMISSION_DENIED"
            r.payrollLetter.issued == true
            r.payrollLetter.letter.includesPay == true
            r.beforeText.includes("Offer of employment")
            r.beforeText.includes("52,000")
            r.later.letter.location == r.payrollLetter.letter.location
            r.after == r.before
            !r.afterText.includes("Renamed after issue")
            r.letters == 1
            r.locked == "OFFER_LOCKED"
            r.accepted.statusId == "OfrAccepted"
            r.byRecruiter == "PERMISSION_DENIED"
            r.otherPerson == "OFFER_PERSON"
            r.preview.person.partyId == state.applicantPartyId
            r.preview.canHire == true
            r.preview.terms.emplPositionId == state.seat
            r.preview.findings.some(finding => finding.code == "FROM_OFFER")
            r.hired.error == ""
            r.hired.partyId == state.applicantPartyId
            r.retried.repeated == true
            r.retried.partyRelationshipId == r.hired.partyRelationshipId
            r.secondHire == "OFFER_USED"
            r.offer.statusId == "OfrHired"
            r.offer.partyRelationshipId == r.hired.partyRelationshipId
            r.stage == "EaHired"
            r.employments == 1
            r.accounts == 0
            r.salaries == 0
            r.change.accessRequested == "N"
            r.scheduled >= 1
        }
    }
)

feature("a lifecycle letter of an applied change is issued once by HR on the offer letter's template and read from storage", {
    when() {
        const get = who => run(who.userId, P + "get#EmploymentLetter", {employmentChangeId: state.hireChangeId})
        const preview = get(state.hr)
        const byRecruiter = code(get(state.recruiter))
        const issued = run(state.hr.userId, P + "issue#EmploymentLetter", {employmentChangeId: state.hireChangeId})
        const again = run(state.hr.userId, P + "issue#EmploymentLetter", {employmentChangeId: state.hireChangeId})
        const stored = get(state.hr)
        const changes = run(state.hr.userId, P + "find#EmploymentChanges", {partyId: state.applicantPartyId, includeDone: true})
        return {preview, byRecruiter, issued, again, stored, changes}
    },
    then(r) {
        r.preview.offered == true
        r.preview.canIssue == true
        r.preview.letterHtml.includes("Confirmation of employment")
        r.preview.letterHtml.includes("Seat ASSOC")
        r.preview.letterHtml.includes("Draft")
        r.byRecruiter == "PERMISSION_DENIED"
        r.issued.error == ""
        r.issued.repeated == false
        r.again.repeated == true
        r.again.employmentLetterId == r.issued.employmentLetterId
        r.stored.issued == true
        r.stored.letterHtml == ""
        r.stored.letter.location == r.issued.location
        ec.resource.extractText(r.issued.location, prefix + "-hire").includes("Confirmation of employment")
        r.changes.changes.find(row => row.employmentChangeId == state.hireChangeId).letterIssued == true
    }
})
