// Labor costing rates (mantle.humanres.RateServices get#CostingRate, find#CostingRates, store#CostingRate, end#CostingRate and
// migrate#ProductionCostRates; IronStone People design PE-23, impl-people P10, F34, F61): the one costing purpose RaprCost resolved
// by position class and work type, the most specific dated row first, a class taken from the person's position; no row answers
// unpriced, and a person's own pay rate (RaprVendor) is never read; finance administration starts a rate (ending the one in
// effect), a stale form and a coming rate refused, others refused by reason code; payroll reads them; Manufacturing's production
// costing rows of before moved to RaprCost by the data update. A production labor event priced from a RaprCost row is
// test/work/ProductionShopFloor's labor features (their rates are RaprCost rows since P10).
// Standalone: spec-local classes, work types, a person and users, with artifact authorization disabled (the rules are the
// services' own permission checks).
// Run: ./moq test mr-mantle --spec LaborCostingRate
const prefix = "LCR_SPEC"
const S = "mantle.humanres.RateServices."
const RATE = "mantle.humanres.rate.RateAmount"
const since = "2000-01-01T00:00:00Z"
const day = 24 * 60 * 60 * 1000
const classA = prefix + "_CLASS_A",
    classB = prefix + "_CLASS_B",
    runType = prefix + "_RUN",
    setupType = prefix + "_SETUP",
    idleType = prefix + "_IDLE"
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
function user(kind, permissions) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Labor costing " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Costing", lastName: kind})
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
function rate(id, values) {
    call(
        "create#" + RATE,
        Object.assign(
            {
                rateAmountId: id,
                rateTypeEnumId: "RatpStandard",
                ratePurposeEnumId: "RaprCost",
                rateCurrencyUomId: "USD",
                timePeriodUomId: "TF_hr",
                fromDate: since
            },
            values
        )
    )
}
const costing = parameters => call(S + "get#CostingRate", parameters)

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const now = ec.user.timestampMillis(ec.user.nowTimestamp)
        for (const [enumId, description] of [
            [runType, "Spec run"],
            [setupType, "Spec setup"],
            [idleType, "Spec idle"]
        ])
            call("create#moqui.basic.Enumeration", {enumId, enumTypeId: "WorkType", description})
        for (const [id, title] of [
            [classA, "Spec welder"],
            [classB, "Spec helper"]
        ])
            call("create#mantle.humanres.position.EmplPositionClass", {emplPositionClassId: id, title})
        // a person holding a position of class A, with a pay rate of their own that costing never reads
        state.person = prefix + "_PERSON"
        call("create#mantle.party.Party", {partyId: state.person, partyTypeEnumId: "PtyPerson"})
        call("create#mantle.party.Person", {partyId: state.person, firstName: "Costing", lastName: "Worker"})
        call("create#mantle.humanres.position.EmplPosition", {
            emplPositionId: prefix + "_POS",
            emplPositionClassId: classA,
            statusId: "EmpsActive"
        })
        call("create#mantle.humanres.position.EmplPositionParty", {
            emplPositionId: prefix + "_POS",
            partyId: state.person,
            roleTypeId: "Employee",
            fromDate: since
        })
        rate(prefix + "_PAY", {ratePurposeEnumId: "RaprVendor", partyId: state.person, workTypeEnumId: runType, rateAmount: 99})
        // the run type alone, class A alone, class A and run (older and newer), an ended one and one on a person or work effort
        rate(prefix + "_TYPE", {workTypeEnumId: runType, rateAmount: 20})
        rate(prefix + "_CLASS", {emplPositionClassId: classA, rateAmount: 25})
        rate(prefix + "_BOTH_OLD", {emplPositionClassId: classA, workTypeEnumId: runType, rateAmount: 28})
        rate(prefix + "_BOTH", {emplPositionClassId: classA, workTypeEnumId: runType, rateAmount: 30, fromDate: now - 30 * day})
        rate(prefix + "_ENDED", {emplPositionClassId: classB, workTypeEnumId: setupType, rateAmount: 50, thruDate: now - day})
        rate(prefix + "_PARTY", {emplPositionClassId: classB, workTypeEnumId: setupType, partyId: state.person, rateAmount: 60})
        state.finance = user("FINANCE", ["ACCOUNTING_ADMIN"])
        state.payroll = user("PAYROLL", ["PAYROLL_VIEW", "PAYROLL_EDIT"])
        state.nobody = user("NOBODY", ["PEOPLE_HR_VIEW"])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("get#CostingRate: the most specific dated row, the person's class, unpriced without one, never a person's rate", {
    when() {
        const now = ec.user.timestampMillis(ec.user.nowTimestamp)
        return {
            both: costing({emplPositionClassId: classA, workTypeEnumId: runType}),
            bothLastYear: costing({emplPositionClassId: classA, workTypeEnumId: runType, onDate: new Date(now - 365 * day)}),
            classOnly: costing({emplPositionClassId: classA, workTypeEnumId: setupType}),
            typeOnly: costing({emplPositionClassId: classB, workTypeEnumId: runType}),
            byPerson: costing({partyId: state.person, workTypeEnumId: runType}),
            ended: costing({emplPositionClassId: classB, workTypeEnumId: setupType}),
            unpriced: costing({emplPositionClassId: classB, workTypeEnumId: idleType})
        }
    },
    then({both, bothLastYear, classOnly, typeOnly, byPerson, ended, unpriced}) {
        both.priced == true
        both.rateAmountId == prefix + "_BOTH"
        String(both.rateAmount) == "30"
        both.rateCurrencyUomId == "USD"
        bothLastYear.rateAmountId == prefix + "_BOTH_OLD"
        classOnly.rateAmountId == prefix + "_CLASS"
        typeOnly.rateAmountId == prefix + "_TYPE"
        // the person's position class (A), never their own RaprVendor rate of 99
        byPerson.emplPositionClassId == classA
        byPerson.rateAmountId == prefix + "_BOTH"
        // the ended row and the row on a person leave the setup work of class B unpriced
        ended.priced == false
        ended.rateAmountId == null
        unpriced.priced == false
        unpriced.rateAmount == null
    }
})

feature("store#CostingRate ends the rate in effect and starts the next; refusals by reason code; payroll reads them", {
    when() {
        const now = ec.user.timestampMillis(ec.user.nowTimestamp)
        const started = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: idleType,
            rateAmount: "40",
            rateCurrencyUomId: "USD"
        })
        const changed = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: idleType,
            rateAmount: "42.5",
            rateCurrencyUomId: "USD",
            expectedRateAmountId: started.rateAmountId
        })
        const stale = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: idleType,
            rateAmount: "45",
            rateCurrencyUomId: "USD",
            expectedRateAmountId: started.rateAmountId
        })
        const coming = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: setupType,
            rateAmount: "55",
            rateCurrencyUomId: "USD",
            fromDate: new Date(now + 10 * day)
        })
        const beforeComing = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: setupType,
            rateAmount: "52",
            rateCurrencyUomId: "USD"
        })
        const noCurrency = run(state.finance, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: idleType,
            rateAmount: "45"
        })
        const payrollStore = run(state.payroll, S + "store#CostingRate", {
            emplPositionClassId: classB,
            workTypeEnumId: idleType,
            rateAmount: "45",
            rateCurrencyUomId: "USD"
        })
        const payrollCreate = run(state.payroll, S + "create#RateAmount", {
            ratePurposeEnumId: "RaprCost",
            emplPositionClassId: classB,
            rateAmount: "45",
            rateCurrencyUomId: "USD"
        })
        const payrollRead = run(state.payroll, S + "find#CostingRates", {emplPositionClassId: classB})
        const nobodyRead = run(state.nobody, S + "find#CostingRates", {emplPositionClassId: classB})
        const endedComing = run(state.finance, S + "end#CostingRate", {rateAmountId: coming.rateAmountId})
        const endPay = run(state.finance, S + "end#CostingRate", {rateAmountId: prefix + "_PAY"})
        return {
            started,
            changed,
            stale,
            coming,
            beforeComing,
            noCurrency,
            payrollStore,
            payrollCreate,
            payrollRead,
            nobodyRead,
            endedComing,
            endPay,
            first: ec.entity.find(RATE).condition("rateAmountId", started.rateAmountId).disableAuthz().one(),
            now: costing({emplPositionClassId: classB, workTypeEnumId: idleType}),
            comingRow: ec.entity.find(RATE).condition("rateAmountId", coming.rateAmountId).disableAuthz().one()
        }
    },
    then(x) {
        x.started.error == ""
        x.changed.error == ""
        x.changed.endedRateAmountId == x.started.rateAmountId
        x.first.thruDate != null
        x.now.rateAmountId == x.changed.rateAmountId
        String(x.now.rateAmount) == "42.5"
        x.stale.error.includes("REVISION_CHANGED")
        x.coming.error == ""
        x.beforeComing.error.includes("RATE_COMING")
        x.noCurrency.error.includes("RATE_INVALID")
        x.payrollStore.error.includes("PERMISSION_DENIED")
        x.payrollCreate.error.includes("PERMISSION_DENIED")
        x.payrollRead.error == ""
        x.payrollRead.canEdit == false
        x.payrollRead.rateList.some(row => row.rateAmountId == x.changed.rateAmountId && row.amountText.includes("42.50"))
        x.payrollRead.rateList.every(row => row.canChange == false)
        // ended rows only with showEnded; a row on a person is no costing rate
        !x.payrollRead.rateList.some(row => row.rateAmountId == prefix + "_ENDED" || row.rateAmountId == prefix + "_PARTY")
        x.nobodyRead.error.includes("PERMISSION_DENIED")
        // a coming rate ended at its start never applies
        x.endedComing.error == ""
        String(x.comingRow.thruDate) == String(x.comingRow.fromDate)
        x.endPay.error.includes("RECORD_UNAVAILABLE")
    }
})

feature("migrate#ProductionCostRates moves Manufacturing's production costing rows to RaprCost and removes the old value", {
    when() {
        call("create#moqui.basic.Enumeration", {
            enumId: "RaprProductionCost",
            enumTypeId: "RatePurpose",
            description: "Production costing"
        })
        rate(prefix + "_OLD", {
            ratePurposeEnumId: "RaprProductionCost",
            emplPositionClassId: classB,
            workTypeEnumId: runType,
            rateAmount: 33
        })
        const first = call(S + "migrate#ProductionCostRates", {})
        const again = call(S + "migrate#ProductionCostRates", {})
        return {
            first,
            again,
            moved: ec.entity
                .find(RATE)
                .condition("rateAmountId", prefix + "_OLD")
                .disableAuthz()
                .one(),
            oldValue: ec.entity.find("moqui.basic.Enumeration").condition("enumId", "RaprProductionCost").disableAuthz().one(),
            found: costing({emplPositionClassId: classB, workTypeEnumId: runType})
        }
    },
    then({first, again, moved, oldValue, found}) {
        first.movedCount >= 1
        first.failedCount == 0
        again.movedCount == 0
        moved.ratePurposeEnumId == "RaprCost"
        oldValue == null
        found.rateAmountId == prefix + "_OLD"
    }
})
