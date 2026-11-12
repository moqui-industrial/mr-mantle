// People's leave policies, allocations and balances (mantle.humanres.LeaveServices; impl-people P11, design-people §7, PE-07): HR
// defines a monthly-accrual policy with two service steps, a cap and a carry-over limit, assigns it (a second policy of the type
// refused), blocks a week; an allocation posts once per key (a retry repeats, a second grant for the period is refused, an
// employee not under the policy is refused and named while the rest are granted); the accrual run twice posts once, one failing
// employment logged while the others post; a year's carry-over and a grant's expiry post once; a policy change keeps posted entries;
// a balance as of a date; the person reads their movements, a manager their report's balance and not its movements, and a legacy
// EmploymentLeave row is listed as historical, outside the balance, without its reason. A reader, another employer's HR and a stale
// revision are refused. Standalone: spec-local organizations, people, employments, groups and users, with artifact authorization
// disabled (the rules are the services' own checks). Periods of 2025 and 2026 in America/Chicago.
// Run: ./moq test mr-mantle --spec LeaveLedger
const prefix = "PEOPLE_LEAVE_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const L = "mantle.humanres.LeaveServices."
const ENTRY = "mantle.humanres.leave.LeaveLedgerEntry"
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
const entries = conditions => Array.from(ec.entity.find(ENTRY).condition(conditions).disableAuthz().list())
const total = list => Math.round(list.reduce((sum, row) => sum + Number(String(row.amount)), 0) * 10000) / 10000
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Leave", lastName: kind})
    return partyId
}
const employ = (partyId, organizationPartyId, fromDate = since) =>
    call("mantle.humanres.EmploymentServices.create#Employment", {fromPartyId: partyId, toPartyId: organizationPartyId, fromDate})
        .partyRelationshipId
function user(kind, permissions, organizationPartyIds, partyId = null) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "People leave " + kind})
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
        timeZone: "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
const revisionOf = leavePolicyId => run(state.hr, L + "get#Policy", {leavePolicyId}).policy?.revision
const balanceOf = (partyRelationshipId, asOfDate, username = state.hr) =>
    (run(username, L + "get#Balances", {partyRelationshipId, asOfDate}).balances || [])[0] || {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "People Leave Spec A")
        organization(orgB, "People Leave Spec B")
        // Ana joined in March 2025 (the second step from her twelfth month); Ben, Cal and Dan long before
        state.ana = person("ANA")
        state.anaEmp = employ(state.ana, orgA, "2025-03-15T12:00:00Z")
        state.ben = person("BEN")
        state.benEmp = employ(state.ben, orgA)
        state.cal = person("CAL")
        state.calEmp = employ(state.cal, orgA)
        state.dan = person("DAN")
        state.danEmp = employ(state.dan, orgA)
        state.mgr = person("MGR")
        employ(state.mgr, orgA)
        // Eve works for B: Retail's HR names her employment and is answered as for one that does not exist
        state.eve = person("EVE")
        state.eveEmp = employ(state.eve, orgB)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.mgr,
            toPartyId: state.ana,
            fromDate: since
        })
        // Ana's legacy leave (before People): read as historical, never in a balance
        call("create#mantle.humanres.employment.EmploymentLeave", {
            partyRelationshipId: state.anaEmp,
            fromDate: "2025-08-04",
            thruDate: "2025-08-08",
            leaveTypeEnumId: "EltEarned",
            leaveReasonEnumId: "ElrMedical",
            leaveApproved: "Y"
        })
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgA])
        state.hrB = user("HRB", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT"], [orgB])
        state.reader = user("READER", ["PEOPLE_DIRECTORY_VIEW"], [orgA])
        state.uMgr = user("MGR", ["PEOPLE_TEAM_VIEW"], [], state.mgr)
        state.uAna = user("ANA", ["PEOPLE_SELF_SERVICE"], [], state.ana)
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature(
    "HR defines a monthly policy with two service steps, assigns it and blocks a week; a second policy of the type, a reader, another employer's HR and a stale revision are refused",
    {
        when() {
            const out = {}
            const newPolicy = (username, policyName, organizationPartyId = orgA) =>
                run(username, L + "store#Policy", {
                    organizationPartyId,
                    policyName,
                    leaveTypeEnumId: "PltAnnual",
                    unitEnumId: "LuDays",
                    accrualFrequencyEnumId: "LafMonthly",
                    fromDate: "2025-01-01"
                })
            out.reader = code(newPolicy(state.reader, "Reader leave"))
            out.hrB = code(newPolicy(state.hrB, "B's leave"))
            out.type = code(run(state.hr, L + "store#Policy", {organizationPartyId: orgA, policyName: "No type"}))
            const policy = newPolicy(state.hr, "Annual leave")
            state.policy = policy.leavePolicyId
            out.policy = policy.error
            state.other = newPolicy(state.hr, "Annual leave (head office)").leavePolicyId
            state.policyB = newPolicy(state.hrB, "B's leave", orgB).leavePolicyId
            const step = (values, revision = revisionOf(state.policy)) =>
                run(
                    state.hr,
                    L + "store#AccrualRule",
                    Object.assign({leavePolicyId: state.policy, expectedRevision: revision, fromDate: "2025-01-01"}, values)
                )
            // 1.5 days a month, 2 from twelve months of service; at most 10 days; 2.5 days carried into a new year
            out.first = step({
                serviceMonthsFrom: 0,
                amount: "1.5",
                capAmount: "10",
                carryLimit: "2.5",
                roundingIncrement: "0.5"
            }).error
            out.second = step({serviceMonthsFrom: 12, amount: "2", capAmount: "10", carryLimit: "2.5"}).error
            out.overlap = code(step({serviceMonthsFrom: 12, amount: "3"}))
            out.stale = code(step({serviceMonthsFrom: 24, amount: "3"}, "1"))
            out.amount = code(step({serviceMonthsFrom: 24, amount: "0"}))
            const assign = (partyRelationshipIds, fromDate, leavePolicyId = state.policy, username = state.hr) =>
                run(username, L + "assign#Policy", {leavePolicyId, partyRelationshipIds, fromDate, reason: "Spec"})
            const assigned = assign([state.anaEmp, state.benEmp], "2026-01-01")
            out.assigned = [assigned.assignedCount, assigned.refusedCount].join("/")
            out.cal = assign([state.calEmp], "2025-11-16").assignedCount
            const second = assign([state.anaEmp, state.danEmp], "2026-01-01", state.other)
            out.otherPolicy = second.rows.map(row => row.personName + ":" + (row.reasonCode || row.outcome)).join(",")
            out.hrBAssign = code(assign([state.danEmp], "2026-01-01", state.policy, state.hrB))
            // another employer's employment and a missing one are refused alike, neither person named
            out.outside = assign([state.eveEmp, "NO_SUCH_EMPLOYMENT"], "2026-01-01")
                .rows.map(row => row.personName + ":" + row.reasonCode)
                .join(",")
            // an assignment ends at the revision read
            const anaAssignment = assigned.rows.find(row => row.partyRelationshipId === state.anaEmp)?.leavePolicyAssignmentId
            out.endStale = code(run(state.hr, L + "assign#Policy", {end: true, leavePolicyAssignmentId: anaAssignment}))
            const block = run(state.hr, L + "store#BlockedInterval", {
                leavePolicyId: state.policy,
                blockKindEnumId: "LbkBlocked",
                leaveTypeEnumId: "PltAnnual",
                fromDate: "2026-11-23",
                thruDate: "2026-11-27",
                reason: "Stocktake"
            })
            out.block = block.error
            out.blockDates = code(
                run(state.hr, L + "store#BlockedInterval", {
                    leavePolicyId: state.policy,
                    fromDate: "2026-11-27",
                    thruDate: "2026-11-23"
                })
            )
            const read = run(state.hr, L + "get#Policy", {leavePolicyId: state.policy})
            out.read = [
                read.policy?.accrualText,
                read.policy?.assignedCount,
                read.rules?.length,
                read.blockedIntervals?.[0]?.scopeText
            ].join(" | ")
            out.readerFind = code(run(state.reader, L + "find#Policies", {}))
            out.hrBRead = code(run(state.hrB, L + "get#Policy", {leavePolicyId: state.policy}))
            out.hrFinds = (run(state.hr, L + "find#Policies", {term: "annual"}).policies || [])
                .map(row => row.policyName)
                .join(",")
            return out
        },
        then(out) {
            out.reader === "PERMISSION_DENIED"
            out.hrB === "ORGANIZATION_DENIED"
            out.type === "TYPE_INVALID"
            out.policy === ""
            out.first === ""
            out.second === ""
            out.overlap === "OVERLAP"
            out.stale === "REVISION_CHANGED"
            out.amount === "AMOUNT_INVALID"
            out.assigned === "2/0"
            out.cal === 1
            out.otherPolicy === "Leave ANA:ASSIGNMENT_OVERLAP,Leave DAN:done"
            out.hrBAssign === "RECORD_UNAVAILABLE"
            out.outside === state.eveEmp + ":EMPLOYMENT_OUTSIDE,NO_SUCH_EMPLOYMENT:EMPLOYMENT_OUTSIDE"
            out.endStale === "REVISION_CHANGED"
            out.block === ""
            out.blockDates === "DATES_INVALID"
            out.read === "1.5 days a month; 2 days a month from 12 months of service | 3 | 2 | Every department, Annual leave"
            out.readerFind === "PERMISSION_DENIED"
            out.hrBRead === "RECORD_UNAVAILABLE"
            out.hrFinds === "Annual leave,Annual leave (head office)"
        }
    }
)

feature(
    "An allocation posts once per key: Dan, not under the policy, is refused and named while Ana and Ben are granted; a retry repeats; a second grant for the period is refused; an adjustment needs a reason",
    {
        when() {
            const out = {}
            const terms = {
                leavePolicyId: state.policy,
                partyRelationshipIds: [state.anaEmp, state.benEmp, state.danEmp],
                amount: "2",
                periodFromDate: "2026-01-01",
                periodThruDate: "2026-03-31",
                expiryDate: "2026-03-31",
                reason: "First quarter"
            }
            const preview = run(state.hr, L + "preview#Allocation", terms)
            out.preview = preview.rows.map(row => row.personName + ":" + (row.reasonCode || row.outcome)).join(",")
            out.counts = [preview.readyCount, preview.refusedCount, Number(String(preview.total)), preview.unitText].join("/")
            out.noKey = code(run(state.hr, L + "allocate#Leave", terms))
            const key = preview.operationKey
            const done = run(state.hr, L + "allocate#Leave", Object.assign({operationKey: key}, terms))
            out.done = [done.allocatedCount, done.repeatedCount, done.refusedCount].join("/")
            const retry = run(state.hr, L + "allocate#Leave", Object.assign({operationKey: key}, terms))
            out.retry = [retry.allocatedCount, retry.repeatedCount, retry.refusedCount].join("/")
            const again = run(state.hr, L + "allocate#Leave", Object.assign({}, terms, {operationKey: key + "X"}))
            out.again = again.rows.map(row => row.personName + ":" + (row.reasonCode || row.outcome)).join(",")
            out.grants = entries({partyRelationshipId: state.anaEmp, entryTypeEnumId: "LletGrant"}).length
            out.noReason = code(
                run(state.hr, L + "preview#Allocation", {
                    leavePolicyId: state.policy,
                    partyRelationshipIds: [state.calEmp],
                    amount: "-1",
                    adjustment: true
                })
            )
            out.hrB = code(run(state.hrB, L + "preview#Allocation", terms))
            return out
        },
        then(out) {
            out.preview === "Leave ANA:ready,Leave BEN:ready,Leave DAN:NOT_ASSIGNED"
            out.counts === "2/1/4/Days"
            out.noKey === "OPERATION_REQUIRED"
            out.done === "2/0/1"
            out.retry === "0/2/1"
            out.again === "Leave ANA:DUPLICATE_PERIOD,Leave BEN:DUPLICATE_PERIOD,Leave DAN:NOT_ASSIGNED"
            out.grants === 1
            out.noReason === "REASON_REQUIRED"
            out.hrB === "RECORD_UNAVAILABLE"
        }
    }
)

feature(
    "The accrual run twice posts once: one employment that fails is logged while the others post; a year's carry-over and a grant's expiry post once; the steps by service, the part rounding and the cap",
    {
        when() {
            const out = {}
            // a fault of the spec's own: an entry of another employment holding the key of Ben's January accrual
            const fault = call("create#" + ENTRY, {
                partyRelationshipId: state.danEmp,
                leaveTypeEnumId: "PltSick",
                entryTypeEnumId: "LletAdjustment",
                unitEnumId: "LuDays",
                amount: "0",
                effectiveDate: "2020-01-01T00:00:00Z",
                sourceKey: "accrual:" + state.benEmp + ":" + state.policy + ":2026-01-01"
            }).leaveLedgerEntryId
            const accrue = () => run(state.hr, L + "run#Accrual", {leavePolicyId: state.policy, asOfDate: "2026-07-01"})
            const first = accrue()
            out.first = [first.posted, first.assignmentCount, first.failed, first.failedList?.[0]?.partyRelationshipId].join("/")
            ec.entity.find(ENTRY).condition("leaveLedgerEntryId", fault).disableAuthz().deleteAll()
            const second = accrue()
            out.second = [second.posted, second.failed].join("/")
            const third = accrue()
            out.third = [third.posted, third.failed].join("/")
            const amounts = partyRelationshipId =>
                entries({partyRelationshipId, leaveTypeEnumId: "PltAnnual"})
                    .sort((a, b) => String(a.sourceKey).localeCompare(String(b.sourceKey)))
                    .map(row => String(row.sourceKey).split(":")[0] + " " + Number(String(row.amount)))
                    .join(",")
            out.ana = amounts(state.anaEmp)
            out.ben = amounts(state.benEmp)
            out.cal = amounts(state.calEmp)
            out.capped = entries({partyRelationshipId: state.anaEmp, periodFromDay: "2026-06-01"})[0]?.description
            out.part = entries({partyRelationshipId: state.calEmp, periodFromDay: "2025-11-01"})[0]?.description
            out.carry = entries({partyRelationshipId: state.calEmp, entryTypeEnumId: "LletExpiry"})[0]?.description
            out.reader = code(run(state.reader, L + "run#Accrual", {leavePolicyId: state.policy}))
            return out
        },
        then(out) {
            out.first === "16/3/1/" + state.benEmp
            out.second === "7/0"
            out.third === "0/0"
            // Ana: 1.5 a month until her twelfth month (March), then 2; her grant of 2 expired after March; June capped at 10
            out.ana === "accrual 1.5,accrual 1.5,accrual 2,accrual 2,accrual 2,accrual 1,allocation 2,expire -2"
            out.ben === "accrual 2,accrual 2,accrual 2,accrual 2,accrual 2,accrual 0,allocation 2,expire -2"
            // Cal from the middle of November 2025: half of November, 3 at the year's end, 0.5 over the carry-over limit expired
            out.cal === "accrual 1,accrual 2,accrual 2,accrual 2,accrual 2,accrual 1.5,accrual 0,accrual 0,carry -0.5"
            out.capped === "Capped at 10 days"
            out.part === "Part period: 15 of 30 days"
            out.carry === "Over the carry-over limit of 2.5 days at the end of 2025"
            out.reader === "PERMISSION_DENIED"
        }
    }
)

feature(
    "A policy change keeps posted entries: a step changes from today, never from a posted past; the unit and frequency stay once posted",
    {
        when() {
            const out = {}
            const before = total(entries({leavePolicyId: state.policy}))
            const read = run(state.hr, L + "get#Policy", {leavePolicyId: state.policy})
            const firstStep = read.rules.find(rule => rule.serviceMonthsFrom === 0).leaveAccrualRuleId
            const change = fromDate =>
                run(state.hr, L + "store#AccrualRule", {
                    leavePolicyId: state.policy,
                    expectedRevision: revisionOf(state.policy),
                    leaveAccrualRuleId: firstStep,
                    amount: "3",
                    fromDate
                })
            out.past = code(change("2026-02-01"))
            out.today = change(null).error
            const terms = values =>
                run(
                    state.hr,
                    L + "store#Policy",
                    Object.assign({leavePolicyId: state.policy, expectedRevision: revisionOf(state.policy)}, values)
                )
            out.limit = terms({negativeLimit: "2", changeReason: "Spec"}).error
            out.unit = code(terms({unitEnumId: "LuHours"}))
            out.frequency = code(terms({accrualFrequencyEnumId: "LafQuarterly"}))
            out.typeChange = code(terms({leaveTypeEnumId: "PltSick"}))
            out.after = total(entries({leavePolicyId: state.policy}))
            out.before = before
            const rules = run(state.hr, L + "get#Policy", {leavePolicyId: state.policy}).rules
            out.steps = rules
                .filter(rule => rule.serviceMonthsFrom === 0)
                .map(rule => rule.amount + ":" + rule.state)
                .join(",")
            return out
        },
        then(out) {
            out.past === "DATE_PAST"
            out.today === ""
            out.limit === ""
            out.unit === "UNIT_IN_USE"
            out.frequency === "FREQUENCY_IN_USE"
            out.typeChange === "TYPE_CHANGE"
            out.after === out.before
            out.steps === "3:current,1.5:ended"
        }
    }
)

feature(
    "A balance as of a date; the person reads their movements, a manager their report's balance and not its movements, a reader nothing; the legacy leave is historical and outside the balance",
    {
        when() {
            const out = {}
            const march = balanceOf(state.anaEmp, "2026-03-31")
            const june = balanceOf(state.anaEmp, "2026-06-30")
            out.march = march.balance
            out.june = [
                june.opening,
                june.granted,
                june.accrued,
                june.expired,
                june.balance,
                june.available,
                june.policyName
            ].join("/")
            // a supplied employment or person widens nothing: get#MyBalances declares neither
            const mine = run(state.uAna, L + "get#MyBalances", {
                asOfDate: "2026-06-30",
                partyRelationshipId: state.benEmp,
                partyId: state.ben
            })
            out.mine = (mine.balances || [])
                .map(row => row.partyRelationshipId + ":" + row.balance + ":" + row.canSeeLedger)
                .join(",")
            const ledger = run(state.uAna, L + "find#Ledger", {partyRelationshipId: state.anaEmp, asOfDate: "2026-06-30"})
            out.ledgerCount = ledger.entriesCount
            out.latest = [ledger.entries?.[0]?.entryTypeText, ledger.entries?.[0]?.balanceAfter].join("/")
            out.historical = JSON.stringify(ledger.historical || [])
            // an allocation's reason is HR's working note (F202, the user's call of Nov 11, 2026): HR reads it, the person does not
            out.ownReason = JSON.stringify(ledger.entries || []).includes("First quarter")
            out.hrReason = JSON.stringify(
                run(state.hr, L + "find#Ledger", {partyRelationshipId: state.anaEmp, asOfDate: "2026-06-30"}).entries || []
            ).includes("First quarter")
            const team = run(state.uMgr, L + "get#Balances", {asOfDate: "2026-06-30"})
            out.team = (team.balances || []).map(row => row.personName + ":" + row.balance + ":" + row.canSeeLedger).join(",")
            out.teamLedger = code(run(state.uMgr, L + "find#Ledger", {partyRelationshipId: state.anaEmp}))
            out.otherSelf = code(run(state.uAna, L + "find#Ledger", {partyRelationshipId: state.benEmp}))
            out.reader = code(run(state.reader, L + "get#Balances", {}))
            out.hrB = code(run(state.hrB, L + "get#Balances", {partyRelationshipId: state.anaEmp}))
            return out
        },
        then(out) {
            out.march === 7
            out.june === "0/2/10/-2/10/10/Annual leave"
            out.mine === state.anaEmp + ":10:true"
            out.ledgerCount === 8
            out.latest === "Accrual/10"
            out.historical.includes("Historical (recorded before People; not in the balance)")
            !out.ownReason && out.hrReason
            out.historical.includes("2025-08-04")
            !out.historical.includes("Medical")
            !out.historical.includes("ElrMedical")
            out.team === "Leave ANA:10:false"
            out.teamLedger === "RECORD_UNAVAILABLE"
            out.otherSelf === "RECORD_UNAVAILABLE"
            out.reader === "PERMISSION_DENIED"
            out.hrB === "RECORD_UNAVAILABLE"
        }
    }
)
