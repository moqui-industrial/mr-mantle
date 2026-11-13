// People's pay inputs and hours for pay (mantle.humanres.PayrollInputServices get#Reconciliation, prepare#Inputs,
// store#Adjustment, find#Adjustments, decide#Adjustment, check#SourceUse, release#Sources, and the guards in Mantle's time and
// invoice writers; IronStone People design §6 HoursForPay, §8.1 PayrollInput and PayrollInputSource, §8 PayAdjustments; PE-09,
// PE-07, PE-05; impl-people P24, F44): preparing twice makes each input once, and an unapproved week blocks its employee only;
// the group's time basis decides which stream pays a day and a day's entitlement is paid once (attendance, timesheets or a
// payroll resolution); a time entry on a worker invoice is refused as a pay source and a worker invoice refuses a consumed one;
// an authorized rate change voids an input not finalized, and a finalized one refuses the change and the week's reopening; an
// adjustment waits for a payroll approver, never its maker, recurs one input a period, is refused with a reason, and a
// recovery never passes the advance's outstanding amount, when made or approved. The reconciliation carries no amount; a manager
// reads their reports' time inputs alone. P24 review: pieces are payroll's on any basis; Projects' bulk rate reset keeps a paid
// worker rate and voids an input it changes.
// Standalone: spec-local organizations, people, employments, pay configuration, time, attendance, leave, a claim and users, made
// as data (the time, leave and configuration flows are their own specs'). Run: ./moq test mr-mantle --spec PayInputs
const prefix = "PAY_IN_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2001-01-01T00:00:00Z"
const S = "mantle.humanres.PayrollInputServices."
const INPUT = "mantle.humanres.payroll.PayrollInput"
const state = {}

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
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const rows = (entity, conditions) => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list())
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const live = partyRelationshipId =>
    rows(INPUT, {partyRelationshipId}).filter(row => ["PinProposed", "PinApproved", "PinFinalized"].includes(row.statusId))
// the live inputs of an employment as "type day quantity", sorted
const summary = partyRelationshipId =>
    live(partyRelationshipId)
        .map(row =>
            [
                row.inputTypeEnumId,
                ec.l10n.format(new Date(Number(row.inputDate)), "MM-dd", null, "UTC"),
                row.quantity == null ? String(Number(String(row.amount))) : String(Number(String(row.quantity)))
            ].join(" ")
        )
        .sort()
const unique = values => Array.from(new Set(values))
const outcomes = out =>
    out.error
        ? code(out)
        : Object.fromEntries(
              Array.from(out.rows || []).map(row => [row.partyId.replace(prefix + "_", ""), row.reasonCode || row.outcome])
          )
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function person(kind) {
    const partyId = prefix + "_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Pay", lastName: kind})
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
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Pay inputs " + kind})
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
function component(organizationPartyId, componentCode, componentKindEnumId) {
    const payrollComponentId = prefix + "_C_" + componentCode
    call("create#mantle.humanres.payroll.PayrollComponent", {
        payrollComponentId,
        organizationPartyId,
        componentCode,
        componentName: componentCode,
        componentKindEnumId
    })
    call("create#mantle.humanres.payroll.PayrollComponentTerm", {
        payrollComponentId,
        statusId: "PtsPublished",
        fromDate: "2000-01-01T00:00:00Z",
        basisEnumId: "PcbAmount",
        amount: "0",
        currencyUomId: "USD"
    })
    return payrollComponentId
}
function group(id, organizationPartyId, timeBasisEnumId) {
    call("create#mantle.humanres.payroll.PayrollGroup", {
        payrollGroupId: id,
        organizationPartyId,
        groupName: id,
        currencyUomId: "USD",
        timePeriodTypeId: "PayrollMonth",
        firstPeriodFromDate: "2026-03-01",
        periodsPerYear: 12,
        payDateOffsetDays: 0,
        prorationEnumId: "PprCalendarDays",
        timeBasisEnumId,
        payrollLocalizationId: "PlzDemonstration",
        liveEnabled: "N",
        fromDate: since
    })
    return id
}
function period(organizationPartyId, fromDate, thruDate, groupIds) {
    const timePeriodId = call("mantle.party.TimeServices.create#TimePeriod", {
        partyId: organizationPartyId,
        timePeriodTypeId: "PayrollMonth",
        fromDate,
        thruDate
    }).timePeriodId
    for (const payrollGroupId of groupIds)
        call("create#mantle.humanres.payroll.PayrollGroupPeriod", {payrollGroupId, timePeriodId, payDate: thruDate})
    return timePeriodId
}
const assign = (partyRelationshipId, partyId, payrollGroupId) =>
    call("create#mantle.humanres.payroll.PayrollAssignment", {
        partyRelationshipId,
        partyId,
        organizationPartyId: orgA,
        payrollStructureId: null,
        payrollGroupId,
        isPrimary: "Y",
        fromDate: "2026-01-01T00:00:00"
    })
function sheet(partyId, fromDay, statusId) {
    const timesheetId = prefix + "_TS_" + partyId.replace(prefix + "_", "") + "_" + fromDay.slice(5).replace("-", "")
    call("create#mantle.work.time.Timesheet", {
        timesheetId,
        partyId,
        fromDate: fromDay + " 00:00:00",
        thruDate: fromDay + " 23:59:59",
        statusId
    })
    return timesheetId
}
function entry(partyId, timesheetId, dayText, hours, extra = {}) {
    const timeEntryId = prefix + "_TE_" + partyId.replace(prefix + "_", "") + "_" + dayText.slice(5).replace("-", "")
    call(
        "create#mantle.work.time.TimeEntry",
        Object.assign(
            {
                timeEntryId,
                partyId,
                timesheetId,
                fromDate: dayText + " 09:00:00",
                thruDate: dayText + " 17:00:00",
                hours: String(hours),
                vendorHourRate: "20"
            },
            extra
        )
    )
    return timeEntryId
}
const attendance = (partyRelationshipId, partyId, dayText, minutes, statusEnumId, flagsText = null) =>
    call("create#mantle.humanres.attendance.AttendanceDay", {
        partyRelationshipId,
        partyId,
        organizationPartyId: orgA,
        attendanceDate: dayText,
        workedMinutes: minutes,
        punchedMinutes: minutes,
        punchCount: 2,
        statusEnumId,
        flagsText
    })
function leave(partyRelationshipId, partyId, leavePolicyId, fromDay, thruDay) {
    const leaveRequestId = prefix + "_LR_" + fromDay.slice(5).replace("-", "")
    call("create#mantle.humanres.leave.LeaveRequest", {
        leaveRequestId,
        partyRelationshipId,
        partyId,
        organizationPartyId: orgA,
        leaveTypeEnumId: "PltAnnual",
        leavePolicyId,
        unitEnumId: "LuDays",
        statusEnumId: "LrsApproved",
        fromDay,
        thruDay,
        decidedDate: fromDay + " 08:00:00"
    })
    call("create#mantle.humanres.leave.LeaveRequestSegment", {
        leaveRequestId,
        segmentSeqId: "01",
        fromDay,
        thruDay,
        dayPartEnumId: "LdpFull"
    })
}
function invoice(invoiceId, fromPartyId, statusId, total) {
    call("create#mantle.account.invoice.Invoice", {
        invoiceId,
        invoiceTypeEnumId: "InvoiceSales",
        fromPartyId,
        toPartyId: orgA,
        statusId,
        currencyUomId: "USD",
        invoiceDate: "2026-03-20 10:00:00",
        invoiceTotal: total
    })
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        organization(orgA, "Pay Inputs Spec A")
        organization(orgB, "Pay Inputs Spec B")
        for (const kind of ["ANA", "BEN", "CY", "DEE", "MIA"]) state[kind.toLowerCase()] = person(kind)
        for (const kind of ["ana", "ben", "cy", "dee", "mia"]) state[kind + "Emp"] = employ(state[kind], orgA)
        // Mia manages Ana: a manager reads her report's hours and no one else's
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtManager",
            fromPartyId: state.mia,
            toPartyId: state.ana,
            fromDate: since
        })
        state.payroll = user("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgA])
        state.maker = user("MAKER", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_APPROVE"], [orgA])
        state.approver = user("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"], [orgA])
        state.payrollB = user("PAYROLLB", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgB])
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.manager = user("MANAGER", ["PEOPLE_TEAM_VIEW", "PEOPLE_REQUEST_APPROVE"], [], state.mia)
        state.bonus = component(orgA, "BONUS", "PckEarning")
        state.recover = component(orgA, "RECOVER", "PckDeduction")
        state.sheets = group(prefix + "_G_SHEETS", orgA, "PtbTimesheets")
        state.attendanceGroup = group(prefix + "_G_ATT", orgA, "PtbAttendance")
        state.march = period(orgA, "2026-03-01", "2026-03-31", [state.sheets, state.attendanceGroup])
        state.april = period(orgA, "2026-04-01", "2026-04-30", [state.sheets])
        for (const kind of ["ana", "ben", "dee"]) assign(state[kind + "Emp"], state[kind], state.sheets)
        assign(state.cyEmp, state.cy, state.attendanceGroup)
        // Ana: an approved week (8 h on Monday, 7.5 h and 10 pieces on Tuesday); Ben: one approved week and one submitted;
        // Dee: an approved week whose entry is on a worker invoice; Cy (attendance): an approved week too, comparison only
        state.anaWeek = sheet(state.ana, "2026-03-02", "TmshApproved")
        state.anaMon = entry(state.ana, state.anaWeek, "2026-03-02", 8)
        state.anaTue = entry(state.ana, state.anaWeek, "2026-03-03", 7.5, {pieceCount: "10", vendorPieceRate: "0.5"})
        entry(state.ben, sheet(state.ben, "2026-03-02", "TmshApproved"), "2026-03-02", 8)
        entry(state.ben, sheet(state.ben, "2026-03-09", "TmshCompleted"), "2026-03-10", 8)
        invoice(prefix + "_WINV", state.dee, "InvoiceIncoming", "160")
        state.deeEntry = entry(state.dee, sheet(state.dee, "2026-03-02", "TmshApproved"), "2026-03-04", 8, {
            vendorInvoiceId: prefix + "_WINV"
        })
        state.cyEntry = entry(state.cy, sheet(state.cy, "2026-03-02", "TmshApproved"), "2026-03-02", 9)
        // Cy's attendance: Monday recorded, Tuesday corrected, Wednesday missing its out-punch
        attendance(state.cyEmp, state.cy, "2026-03-02", 480, "AdsRecorded")
        attendance(state.cyEmp, state.cy, "2026-03-03", 450, "AdsCorrected")
        attendance(state.cyEmp, state.cy, "2026-03-04", 240, "AdsRecorded", "MISSING_OUT")
        // Ana's leave: paid Thursday and Friday, unpaid the next Monday (no schedule: a standard 8-hour day)
        for (const [id, isPaid] of [
            ["PAID", "Y"],
            ["UNPAID", "N"]
        ])
            call("create#mantle.humanres.leave.LeavePolicy", {
                leavePolicyId: prefix + "_LP_" + id,
                policyName: id,
                organizationPartyId: orgA,
                leaveTypeEnumId: "PltAnnual",
                unitEnumId: "LuDays",
                isPaid,
                fromDate: since
            })
        leave(state.anaEmp, state.ana, prefix + "_LP_PAID", "2026-03-05", "2026-03-06")
        leave(state.anaEmp, state.ana, prefix + "_LP_UNPAID", "2026-03-09", "2026-03-09")
        // Ana's approved claim reserved for payroll
        invoice(prefix + "_CLAIM", state.ana, "InvoiceReceived", "45")
        call("create#mantle.humanres.expense.ExpenseClaim", {
            invoiceId: prefix + "_CLAIM",
            partyRelationshipId: state.anaEmp,
            partyId: state.ana,
            organizationPartyId: orgA,
            statusEnumId: "EcsApproved",
            routeEnumId: "EcrPayroll",
            reservedRouteEnumId: "EcrPayroll",
            reservedDate: "2026-03-20 10:00:00"
        })
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("preparing twice makes each input once; an unapproved week, or time on a worker invoice, blocks its employee only", {
    when() {
        const prepare = (username, extra = {}) =>
            run(username, S + "prepare#Inputs", Object.assign({payrollGroupId: state.sheets, timePeriodId: state.march}, extra))
        const preview = prepare(state.payroll, {preview: true})
        const previewWrote = live(state.anaEmp).length
        const first = prepare(state.payroll)
        const anaFirst = summary(state.anaEmp)
        const again = prepare(state.payroll)
        const reconciled = run(state.payroll, S + "get#Reconciliation", {payrollGroupId: state.sheets, timePeriodId: state.march})
        const rowOf = partyId => Array.from(reconciled.employments || []).find(row => row.partyId === partyId) || {}
        const managers = run(state.manager, S + "get#Reconciliation", {payrollGroupId: state.sheets, timePeriodId: state.march})
        return {
            codes: {
                preview: outcomes(preview),
                previewWrote,
                first: outcomes(first),
                again: outcomes(again),
                hr: outcomes(prepare(state.hr)),
                reader: outcomes(prepare(state.approver)),
                otherEmployer: outcomes(prepare(state.payrollB)),
                period: outcomes(prepare(state.payroll, {timePeriodId: "NOT_A_PERIOD"}))
            },
            anaFirst,
            anaAgain: summary(state.anaEmp),
            benInputs: live(state.benEmp).length,
            deeInputs: live(state.deeEmp).length,
            ana: [
                rowOf(state.ana).state,
                rowOf(state.ana).approvedText,
                rowOf(state.ana).paidLeaveText,
                rowOf(state.ana).claimCount
            ],
            ben: [rowOf(state.ben).state, rowOf(state.ben).problems?.[0]?.code],
            // no amount reaches the reconciliation, whoever reads it
            amounts: /"amount|currency/i.test(JSON.stringify(reconciled.employments || [])),
            managerSees: Array.from(managers.employments || []).map(row => row.partyId),
            hrReconciles: code(run(state.hr, S + "get#Reconciliation", {payrollGroupId: state.sheets, timePeriodId: state.march}))
        }
    },
    then({codes, anaFirst, anaAgain, benInputs, deeInputs, ana, ben, amounts, managerSees, hrReconciles}) {
        codes ==
            {
                preview: {ANA: "ready", BEN: "WEEK_NOT_APPROVED", DEE: "WORKER_INVOICED"},
                previewWrote: 0,
                first: {ANA: "done", BEN: "WEEK_NOT_APPROVED", DEE: "WORKER_INVOICED"},
                again: {ANA: "repeated", BEN: "WEEK_NOT_APPROVED", DEE: "WORKER_INVOICED"},
                hr: "PERMISSION_DENIED",
                reader: "PERMISSION_DENIED",
                otherEmployer: "RECORD_UNAVAILABLE",
                period: "PERIOD_UNAVAILABLE"
            }
        anaFirst ==
            [
                "PitPaidLeave 03-05 8",
                "PitPaidLeave 03-06 8",
                "PitPieces 03-03 10",
                "PitReimbursement 03-20 45",
                "PitUnpaidLeave 03-09 8",
                "PitWorked 03-02 8",
                "PitWorked 03-03 7.5"
            ]
        anaAgain == anaFirst
        benInputs == 0
        deeInputs == 0
        ana == ["prepared", "15.5", "16", 1]
        ben == ["blocked", "WEEK_NOT_APPROVED"]
        !amounts
        managerSees == [state.ana]
        hrReconciles == "PERMISSION_DENIED"
    }
})

feature("the group's time basis decides which stream pays a day, and a day's entitlement is paid once", {
    when() {
        const prepare = () =>
            run(state.payroll, S + "prepare#Inputs", {payrollGroupId: state.attendanceGroup, timePeriodId: state.march})
        const blocked = outcomes(prepare())
        // payroll resolves Wednesday's unresolved attendance as a day of 8 hours, approved by a payroll approver
        const resolved = run(state.payroll, S + "store#Adjustment", {
            partyRelationshipId: state.cyEmp,
            inputTypeEnumId: "PitWorked",
            inputDate: "2026-03-04",
            quantity: "8",
            reason: "Badge reader down; confirmed by the shift lead"
        })
        const approved = run(state.approver, S + "decide#Adjustment", {payrollInputId: resolved.payrollInputId})
        const prepared = outcomes(prepare())
        return {
            blocked,
            resolved: resolved.error || resolved.statusId,
            approved: approved.error || approved.statusId,
            prepared,
            cy: summary(state.cyEmp),
            // the timesheet stream is comparison evidence on the attendance basis: Cy's 9 hours are not consumed
            cyTimeConsumed: Array.from(
                run(state.payroll, S + "check#SourceUse", {
                    sourceEntityName: "mantle.work.time.TimeEntry",
                    sourceIdList: [state.cyEntry]
                }).consumedIdList || []
            ).length,
            // Monday is paid by attendance already: a second payment of the day is refused
            twice: code(
                run(state.payroll, S + "store#Adjustment", {
                    partyRelationshipId: state.cyEmp,
                    inputTypeEnumId: "PitWorked",
                    inputDate: "2026-03-02",
                    quantity: "8",
                    reason: "Again"
                })
            )
        }
    },
    then({blocked, resolved, approved, prepared, cy, cyTimeConsumed, twice}) {
        blocked == {CY: "ATTENDANCE_UNRESOLVED"}
        resolved == "PinProposed"
        approved == "PinApproved"
        prepared == {CY: "done"}
        cy == ["PitWorked 03-02 8", "PitWorked 03-03 7.5", "PitWorked 03-04 8"]
        cyTimeConsumed == 0
        twice == "ENTITLEMENT_PAID"
    }
})

feature("a time entry on a worker invoice is refused as a pay source, and a worker invoice refuses time payroll consumed", {
    when() {
        invoice(prefix + "_WINV2", state.ana, "InvoiceIncoming", "0")
        const named = run("john.doe", "mantle.account.InvoiceServices.create#TimeEntryInvoiceItems", {
            invoiceId: prefix + "_WINV2",
            ratePurposeEnumId: "RaprVendor",
            timeEntryIdList: [state.anaMon]
        })
        const found = run("john.doe", "mantle.account.InvoiceServices.create#TimeEntryInvoiceItems", {
            invoiceId: prefix + "_WINV2",
            ratePurposeEnumId: "RaprVendor",
            workerPartyId: state.ana,
            timesheetId: state.anaWeek
        })
        // P24 review: an entry's pieces are payroll's on any basis: on the attendance basis a week of pieces not approved blocks
        // Cy, and an approved one whose entry is on a worker invoice blocks him rather than paying its pieces
        const cySheet = sheet(state.cy, "2026-03-05", "TmshCompleted")
        const cyPieces = entry(state.cy, cySheet, "2026-03-05", 2, {pieceCount: "5", vendorPieceRate: "1"})
        const prepareCy = () =>
            outcomes(run(state.payroll, S + "prepare#Inputs", {payrollGroupId: state.attendanceGroup, timePeriodId: state.march}))
        const piecesUnapproved = prepareCy()
        call("update#mantle.work.time.Timesheet", {timesheetId: cySheet, statusId: "TmshApproved"})
        invoice(prefix + "_WINV3", state.cy, "InvoiceIncoming", "5")
        call("update#mantle.work.time.TimeEntry", {timeEntryId: cyPieces, vendorInvoiceId: prefix + "_WINV3"})
        const piecesInvoiced = prepareCy()
        return {
            dee: outcomes(
                run(state.payroll, S + "prepare#Inputs", {
                    payrollGroupId: state.sheets,
                    timePeriodId: state.march,
                    partyRelationshipIds: state.deeEmp
                })
            ),
            named: code(named),
            found: found.error || Number(found.invoiceItemCreatedCount),
            vendorInvoiced: rows("mantle.work.time.TimeEntry", {vendorInvoiceId: prefix + "_WINV2"}).length,
            cyPieces: [
                piecesUnapproved,
                piecesInvoiced,
                live(state.cyEmp).filter(row => row.inputTypeEnumId === "PitPieces").length
            ]
        }
    },
    then({dee, named, found, vendorInvoiced, cyPieces}) {
        dee == {DEE: "WORKER_INVOICED"}
        named == "PAY_SOURCE_CONSUMED"
        found == 0
        vendorInvoiced == 0
        cyPieces == [{CY: "WEEK_NOT_APPROVED"}, {CY: "WORKER_INVOICED"}, 0]
    }
})

feature("an authorized rate change voids an input not finalized; a finalized one refuses the change and the week's reopening", {
    when() {
        const workedOn = dayText =>
            live(state.anaEmp).find(
                row =>
                    row.inputTypeEnumId === "PitWorked" &&
                    ec.l10n.format(new Date(Number(row.inputDate)), "MM-dd", null, "UTC") === dayText
            )
        const mondayBefore = workedOn("03-02").payrollInputId
        const changed = run("john.doe", "mantle.work.TimeServices.store#TimeEntry", {
            timeEntryId: state.anaMon,
            vendorHourRate: "22"
        })
        const voided = one(INPUT, {payrollInputId: mondayBefore})
        const reconciled = run(state.payroll, S + "get#Reconciliation", {payrollGroupId: state.sheets, timePeriodId: state.march})
        const anaRow = Array.from(reconciled.employments || []).find(row => row.partyId === state.ana) || {}
        const again = outcomes(
            run(state.payroll, S + "prepare#Inputs", {
                payrollGroupId: state.sheets,
                timePeriodId: state.march,
                partyRelationshipIds: state.anaEmp
            })
        )
        const mondayAfter = workedOn("03-02")
        // Tuesday's hours are finalized (the pay run's finalization, made here as data)
        call("update#" + INPUT, {payrollInputId: workedOn("03-03").payrollInputId, statusId: "PinFinalized"})
        const access = run("john.doe", "mantle.work.TimesheetServices.get#TimesheetAccess", {timesheetId: state.anaWeek})
        // P24 review: Projects' bulk rate reset keeps the worker rates a finalized input paid (Tuesday's, set with no RateAmount, which
        // a reset cleared) and voids an input not finalized whose entry's worker rate it changes (Wednesday's)
        entry(state.ana, state.anaWeek, "2026-03-04", 6)
        run(state.payroll, S + "prepare#Inputs", {
            payrollGroupId: state.sheets,
            timePeriodId: state.march,
            partyRelationshipIds: state.anaEmp
        })
        const wednesday = workedOn("03-04")?.payrollInputId || "-"
        const reset = run("john.doe", "mantle.work.TimeServices.resetAndGet#TimeEntryRates", {partyId: state.ana})
        const tuesday = one("mantle.work.time.TimeEntry", {timeEntryId: state.anaTue})
        return {
            reset: [
                reset.error,
                String(tuesday.vendorHourRate),
                String(Number(String(tuesday.vendorPieceRate))),
                one(INPUT, {payrollInputId: wednesday})?.statusId
            ],
            changed: changed.error,
            voided: [voided.statusId, voided.activeEntitlementKey == null],
            ready: [anaRow.state, anaRow.toPrepareCount],
            again,
            mondayAfter: [mondayAfter?.payrollInputId !== mondayBefore, String(Number(String(mondayAfter?.rateAmount)))],
            rateOnPaid: code(
                run("john.doe", "mantle.work.TimeServices.store#TimeEntry", {timeEntryId: state.anaTue, vendorHourRate: "25"})
            ),
            canReopen: access.canReopen,
            payrollPaid: access.payrollPaid,
            reopen: run("john.doe", "mantle.work.TimesheetServices.reopen#Timesheet", {
                timesheetId: state.anaWeek
            }).error.includes("Payroll has paid"),
            removePaid: code(run("john.doe", "mantle.work.TimeServices.delete#TimeEntry", {timeEntryId: state.anaTue}))
        }
    },
    then({reset, changed, voided, ready, again, mondayAfter, rateOnPaid, canReopen, payrollPaid, reopen, removePaid}) {
        reset[0] == "" && Number(reset[1]) == 20 && reset[2] == "0.5" && reset[3] == "PinVoided"
        changed == ""
        voided == ["PinVoided", true]
        ready == ["ready", 1]
        again == {ANA: "done"}
        mondayAfter == [true, "22"]
        rateOnPaid == "PAY_FINALIZED"
        !canReopen
        payrollPaid
        reopen
        removePaid == "PAY_FINALIZED"
    }
})

feature(
    "an adjustment waits for a payroll approver, never its maker; it recurs one input a period, a refusal frees it; a recovery never passes the advance",
    {
        when() {
            const bonus = run(state.maker, S + "store#Adjustment", {
                partyRelationshipId: state.anaEmp,
                payrollComponentId: state.bonus,
                inputDate: "2026-03-15",
                amount: "200",
                recurThruDate: "2026-04-30",
                reason: "Quarterly target"
            })
            const series = rows(INPUT, {seriesInputId: bonus.payrollInputId})
                .sort((a, b) => Number(a.inputDate) - Number(b.inputDate))
                .map(row => [row.statusId, String(row.timePeriodId === state.april)])
            const notices = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessage")
                    .condition({topic: "PeoplePayAdjustmentApproval", recordId: bonus.payrollInputId})
                    .disableAuthz()
                    .list()
            )
            const noticeText = notices.map(row => String(row.titleText || "") + " " + String(row.messageJson || "")).join(" | ")
            const listed = run(state.approver, S + "find#Adjustments", {organizationPartyId: orgA, show: "decide"})
            const self = code(run(state.maker, S + "decide#Adjustment", {payrollInputId: bonus.payrollInputId}))
            const hr = code(run(state.hr, S + "decide#Adjustment", {payrollInputId: bonus.payrollInputId}))
            const approved = run(state.approver, S + "decide#Adjustment", {payrollInputId: bonus.payrollInputId})
            const once = run(state.maker, S + "store#Adjustment", {
                partyRelationshipId: state.anaEmp,
                payrollComponentId: state.bonus,
                inputDate: "2026-03-16",
                amount: "50",
                reason: "Spot award"
            })
            const noReason = code(
                run(state.approver, S + "decide#Adjustment", {payrollInputId: once.payrollInputId, decision: "refuse"})
            )
            const refused = run(state.approver, S + "decide#Adjustment", {
                payrollInputId: once.payrollInputId,
                decision: "refuse",
                reason: "Not in the budget"
            })
            const refusedRow = one(INPUT, {payrollInputId: once.payrollInputId})
            call("create#mantle.humanres.expense.EmployeeAdvance", {
                employeeAdvanceId: prefix + "_ADV",
                partyRelationshipId: state.anaEmp,
                partyId: state.ana,
                organizationPartyId: orgA,
                currencyUomId: "USD",
                amount: "300",
                statusEnumId: "EasApproved"
            })
            const recovery = (extra = {}) =>
                code(
                    run(
                        state.payroll,
                        S + "store#Adjustment",
                        Object.assign(
                            {
                                partyRelationshipId: state.anaEmp,
                                employeeAdvanceId: prefix + "_ADV",
                                payrollComponentId: state.recover,
                                inputDate: "2026-03-20",
                                amount: "100",
                                reason: "Recover the advance"
                            },
                            extra
                        )
                    )
                )
            return {
                series,
                noticeAmount: noticeText.includes("200"),
                noticeNamesPerson: noticeText.includes("Pay ANA"),
                noticeCount: notices.length,
                listed: Array.from(listed.adjustments || [])
                    .filter(row => row.leadInputId === bonus.payrollInputId)
                    .map(row => Number(String(row.amount))),
                self,
                hr,
                hrList: code(run(state.hr, S + "find#Adjustments", {})),
                approved: [
                    approved.statusId,
                    rows(INPUT, {seriesInputId: bonus.payrollInputId})
                        .map(row => row.statusId)
                        .join(",")
                ],
                noReason,
                refused: [refused.statusId, refusedRow.activeEntitlementKey == null],
                // the advance was approved but not paid: nothing is outstanding to recover
                recovery: recovery(),
                recoveryEarning: recovery({payrollComponentId: state.bonus}),
                otherEmployer: code(
                    run(state.payrollB, S + "store#Adjustment", {partyRelationshipId: state.anaEmp, reason: "x"})
                ),
                noPeriod: code(
                    run(state.payroll, S + "store#Adjustment", {
                        partyRelationshipId: state.anaEmp,
                        payrollComponentId: state.bonus,
                        inputDate: "2026-06-01",
                        amount: "10",
                        reason: "June"
                    })
                )
            }
        },
        then({
            series,
            noticeAmount,
            noticeNamesPerson,
            noticeCount,
            listed,
            self,
            hr,
            hrList,
            approved,
            noReason,
            refused,
            recovery,
            recoveryEarning,
            otherEmployer,
            noPeriod
        }) {
            series ==
                [
                    ["PinProposed", "false"],
                    ["PinProposed", "true"]
                ]
            noticeCount == 1
            !noticeAmount
            !noticeNamesPerson
            listed == [200, 200]
            self == "SELF_APPROVAL"
            hr == "PERMISSION_DENIED"
            hrList == "PERMISSION_DENIED"
            approved == ["PinApproved", "PinApproved,PinApproved"]
            noReason == "REASON_REQUIRED"
            refused == ["PinRefused", true]
            recovery == "AMOUNT_OVER_OUTSTANDING"
            recoveryEarning == "KIND_INVALID"
            otherEmployer == "RECORD_UNAVAILABLE"
            noPeriod == "PERIOD_NOT_PREPARED"
        }
    }
)

feature("a recovery of a paid advance passes neither what it has left when made nor when it is approved", {
    when() {
        // P24 review: Ana's advance paid out (a delivered payment of 300 on its bill), then partly repaid while a recovery waits
        const ADV = prefix + "_ADV"
        invoice(prefix + "_ADVBILL", state.ana, "InvoiceReceived", "300")
        call("create#mantle.account.payment.Payment", {
            paymentId: prefix + "_ADVPAY",
            statusId: "PmntDelivered",
            fromPartyId: orgA,
            toPartyId: state.ana,
            amount: "300",
            amountUomId: "USD"
        })
        call("create#mantle.account.payment.PaymentApplication", {
            paymentApplicationId: prefix + "_ADVAPP",
            paymentId: prefix + "_ADVPAY",
            invoiceId: prefix + "_ADVBILL",
            amountApplied: "300"
        })
        call("update#mantle.humanres.expense.EmployeeAdvance", {employeeAdvanceId: ADV, invoiceId: prefix + "_ADVBILL"})
        const recover = amount =>
            run(state.payroll, S + "store#Adjustment", {
                partyRelationshipId: state.anaEmp,
                employeeAdvanceId: ADV,
                payrollComponentId: state.recover,
                inputDate: "2026-03-21",
                amount,
                reason: "Recover the advance"
            })
        const first = recover("100")
        const over = code(recover("250"))
        // 250 repaid by a credit applied to a claim: 50 left, less than the recovery waiting
        invoice(prefix + "_ADVCRED", state.ana, "InvoiceReceived", "250")
        call("create#mantle.humanres.expense.EmployeeAdvanceApplication", {
            employeeAdvanceId: ADV,
            creditInvoiceId: prefix + "_ADVCRED",
            invoiceId: prefix + "_CLAIM"
        })
        call("create#mantle.account.payment.Payment", {
            paymentId: prefix + "_ADVCREDPAY",
            statusId: "PmntDelivered",
            fromPartyId: state.ana,
            toPartyId: orgA,
            amount: "250",
            amountUomId: "USD"
        })
        call("create#mantle.account.payment.PaymentApplication", {
            paymentApplicationId: prefix + "_ADVCREDAPP",
            paymentId: prefix + "_ADVCREDPAY",
            invoiceId: prefix + "_ADVCRED",
            toInvoiceId: prefix + "_CLAIM",
            amountApplied: "250"
        })
        const approve = code(run(state.approver, S + "decide#Adjustment", {payrollInputId: first.payrollInputId}))
        // Ana's employment opened in hours for pay: payroll reads its pay inputs, her manager its time inputs alone
        const opened = username =>
            unique(
                Array.from(
                    run(username, S + "get#Reconciliation", {
                        payrollGroupId: state.sheets,
                        timePeriodId: state.march,
                        partyRelationshipId: state.anaEmp
                    }).employment?.inputs || []
                ).map(row => row.inputTypeEnumId)
            ).sort()
        return {
            first: first.error || first.statusId,
            over,
            approve,
            after: one(INPUT, {payrollInputId: first.payrollInputId}).statusId,
            payrollReads: opened(state.payroll),
            managerReads: opened(state.manager)
        }
    },
    then({first, over, approve, after, payrollReads, managerReads}) {
        first == "PinProposed"
        over == "AMOUNT_OVER_OUTSTANDING"
        approve == "AMOUNT_OVER_OUTSTANDING"
        after == "PinProposed"
        payrollReads.includes("PitAdvanceRecovery") &&
            payrollReads.includes("PitAdjustment") &&
            payrollReads.includes("PitReimbursement")
        managerReads == ["PitPaidLeave", "PitPieces", "PitUnpaidLeave", "PitWorked"]
    }
})
