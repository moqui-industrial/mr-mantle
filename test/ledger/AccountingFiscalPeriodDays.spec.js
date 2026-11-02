// The fiscal periods of a day in the user's zone at a period boundary (LedgerServices.get#OrganizationFiscalTimePeriods
// and check#NextFiscalTimePeriods). Periods made for November 1 in UTC, as data loaded on the evening of October 31 in
// the Americas makes them, have the year and quarter of October 31 but not its month; a Chicago user's lookup on October
// 31 at 23:30 still finds October, linked into the chain, by type, for all types (a posting's lookup) and for an
// organization that rolls up to a parent, and a second lookup creates nothing. On December 31 the year and quarter are
// made the same way. The step back is one period only, and never next to or inside a closed period: a back-dated or
// mistyped day before a closed earliest year gets no periods and its posting is refused, and a closed quarter gets no
// months. A term (a drop-down's current value, a period id) finds that period of a rolled-up organization and makes
// none. Each feature pins the clock, so this holds at any time of day.
const DAY_MS = 86400000
const parent = "FPD_PARENT",
    other = "FPD_OTHER",
    child = "FPD_CHILD",
    newYear = "FPD_NEWYEAR",
    closedYear = "FPD_CLOSED",
    closedQuarter = "FPD_QUARTER",
    termParent = "FPD_TERM_PARENT",
    termChild = "FPD_TERM_CHILD"
const day = value => (value == null ? null : new Date(Number(String(value))).toISOString().slice(0, 10))
const shape = row => ({
    id: row.timePeriodId,
    type: row.timePeriodTypeId,
    from: day(row.fromDate),
    thru: day(row.thruDate),
    partyId: row.partyId,
    parentPeriodId: row.parentPeriodId || null,
    previousPeriodId: row.previousPeriodId || null,
    name: row.periodName,
    periodNum: row.periodNum == null ? null : Number(row.periodNum)
})
const lookup = (organizationPartyId, timePeriodTypeId, filterDate = ec.user.nowTimestamp, term = null) =>
    Array.from(
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId,
            filterDate,
            timePeriodTypeId,
            term
        }).timePeriodList || []
    ).map(shape)
const periods = partyId =>
    Array.from(ec.entity.find("mantle.party.time.TimePeriod").condition({partyId}).orderBy("fromDate").disableAuthz().list()).map(
        shape
    )
const ofType = (list, type) => list.filter(row => row.type === type)
const find = (list, type, from) => list.find(row => row.type === type && row.from === from) || {}
const types = list => list.map(row => row.type).sort()
// a feature's clock, pinned while it runs
function pinned(at, action) {
    ec.user.setEffectiveTime(at)
    try {
        return action()
    } finally {
        ec.user.setEffectiveTime(null)
    }
}
function organization(partyId) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    call("create#mantle.party.Organization", {partyId, organizationName: partyId})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
const period = (partyId, timePeriodTypeId, fromDate, extra = {}) =>
    call("mantle.party.TimeServices.create#TimePeriod", Object.assign({partyId, timePeriodTypeId, fromDate}, extra)).timePeriodId

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [parent, other, child, newYear, closedQuarter, termParent, termChild]) organization(partyId)
        for (const [fromPartyId, toPartyId] of [
            [child, parent],
            [termChild, termParent]
        ])
            call("create#mantle.party.PartyRelationship", {
                relationshipTypeEnumId: "PrtOrgRollup",
                fromPartyId,
                fromRoleTypeId: "OrgInternal",
                toPartyId,
                toRoleTypeId: "OrgInternal",
                fromDate: 0
            })
        // the periods data loaded in UTC makes on the first day of a month: the year, the quarter and the month, and the
        // next ones
        for (const organizationPartyId of [parent, other])
            call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {organizationPartyId, basisDate: "2030-11-01"})
        call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {organizationPartyId: newYear, basisDate: "2031-01-01"})
        // a rolled-up organization with November and December of its own, as its parent has
        for (const organizationPartyId of [termParent, termChild])
            call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {organizationPartyId, basisDate: "2030-11-15"})
        // books from 2024 whose first year is closed
        organization(closedYear)
        call("mantle.ledger.LedgerServices.init#PartyAccountingConfiguration", {
            sourcePartyId: "DefaultSettings",
            organizationPartyId: closedYear,
            startYear: "2024"
        })
        const firstYear = periods(closedYear).find(row => row.type === "FiscalYear" && row.from === "2024-01-01")
        const inFirstYear = periods(closedYear).filter(row => row.from >= "2024-01-01" && row.thru <= "2024-12-31")
        for (const row of inFirstYear) call("update#mantle.party.time.TimePeriod", {timePeriodId: row.id, isClosed: "Y"})
        if (!firstYear) throw new Error("The closed-year fixture needs FY2024")
        // a 2022 year whose closed fourth quarter has only December
        const year2022 = period(closedQuarter, "FiscalYear", "2022-01-01")
        const q4 = period(closedQuarter, "FiscalQuarter", "2022-10-01", {parentPeriodId: year2022, isClosed: "Y"})
        period(closedQuarter, "FiscalMonth", "2022-12-01", {parentPeriodId: q4, isClosed: "Y"})
        call("create#mantle.party.Party", {partyId: "FPD_CHICAGO", partyTypeEnumId: "PtyPerson"})
        call("create#moqui.security.UserAccount", {
            userId: "FPD_CHICAGO",
            username: "fpd_chicago",
            partyId: "FPD_CHICAGO",
            timeZone: "America/Chicago",
            currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
            passwordHashType: "SHA"
        })
        login("fpd_chicago")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    }
})

feature("periods made for November 1 in UTC: a Chicago lookup on October 31 at 23:30 finds October, linked, once", {
    when() {
        // October 31, 23:30 in Chicago; November 1 in UTC
        return pinned(Date.UTC(2030, 10, 1, 4, 30), () => {
            const before = ofType(periods(parent), "FiscalMonth")
            const byType = lookup(parent, "FiscalMonth")
            const allTypes = lookup(other, null)
            const rolledUp = lookup(child, "FiscalMonth")
            const childAll = lookup(child, null)
            const counts = () => [parent, other, child].map(partyId => periods(partyId).length)
            const countsAfter = counts()
            for (const [partyId, type] of [
                [parent, "FiscalMonth"],
                [parent, null],
                [other, null],
                [child, "FiscalMonth"],
                [child, null]
            ])
                lookup(partyId, type)
            return {
                today: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"),
                before,
                byType,
                allTypes,
                rolledUp,
                childAll,
                chain: periods(parent),
                countsAfter,
                countsAgain: counts()
            }
        })
    },
    then({today, before, byType, allTypes, rolledUp, childAll, chain, countsAfter, countsAgain}) {
        today == "2030-10-31"
        // before the lookups the parent has November and December, not October
        before.map(row => row.from) == ["2030-11-01", "2030-12-01"]
        byType.length == 1
        byType[0].from == "2030-10-01"
        byType[0].thru == "2030-10-31"
        // October is in the chain: November's previous period, in the fourth quarter, the tenth month
        find(chain, "FiscalMonth", "2030-11-01").previousPeriodId == byType[0].id
        byType[0].parentPeriodId == find(chain, "FiscalQuarter", "2030-10-01").id
        byType[0].periodNum == 10
        // a posting's lookup: the year, the quarter and the month of October 31
        types(allTypes) == ["FiscalMonth", "FiscalQuarter", "FiscalYear"]
        ofType(allTypes, "FiscalMonth")[0].from == "2030-10-01"
        // the rolled-up organization: its own October by type, and its year, quarter and month for all types
        rolledUp.length == 1
        rolledUp[0].partyId == child
        rolledUp[0].from == "2030-10-01"
        types(childAll) == ["FiscalMonth", "FiscalQuarter", "FiscalYear"]
        childAll.every(row => row.partyId == child)
        ofType(childAll, "FiscalMonth")[0].parentPeriodId == ofType(childAll, "FiscalQuarter")[0].id
        ofType(childAll, "FiscalQuarter")[0].parentPeriodId == ofType(childAll, "FiscalYear")[0].id
        // the lookups again create nothing
        countsAgain == countsAfter
    }
})

feature("periods made for January 1 in UTC: a Chicago lookup on December 31 at 23:30 finds the year, quarter and month", {
    when() {
        // December 31, 23:30 in Chicago (CST); January 1 in UTC
        return pinned(Date.UTC(2031, 0, 1, 5, 30), () => {
            const allTypes = lookup(newYear, null)
            const count = periods(newYear).length
            lookup(newYear, null)
            return {allTypes, chain: periods(newYear), count, countAgain: periods(newYear).length}
        })
    },
    then({allTypes, chain, count, countAgain}) {
        types(allTypes) == ["FiscalMonth", "FiscalQuarter", "FiscalYear"]
        const year = ofType(allTypes, "FiscalYear")[0],
            quarter = ofType(allTypes, "FiscalQuarter")[0],
            month = ofType(allTypes, "FiscalMonth")[0]
        year.from == "2030-01-01"
        year.thru == "2030-12-31"
        year.periodNum == 2030
        quarter.from == "2030-10-01"
        quarter.parentPeriodId == year.id
        quarter.periodNum == 4
        month.from == "2030-12-01"
        month.parentPeriodId == quarter.id
        month.periodNum == 12
        // each is the previous period of the one made for January 1
        find(chain, "FiscalYear", "2031-01-01").previousPeriodId == year.id
        find(chain, "FiscalQuarter", "2031-01-01").previousPeriodId == quarter.id
        find(chain, "FiscalMonth", "2031-01-01").previousPeriodId == month.id
        countAgain == count
    }
})

feature("before a closed earliest year a back-dated or mistyped day gets no periods and its posting is refused", {
    when() {
        return pinned(Date.UTC(2030, 5, 15, 17), () => {
            const count = periods(closedYear).length
            // a day within one year of the closed year, one further back, and a mistyped year
            const lookups = ["2023-12-31", "2023-06-15", "0202-06-15"].map(
                text => lookup(closedYear, null, ec.l10n.parseTimestamp(text + " 12:00:00", "yyyy-MM-dd HH:mm:ss")).length
            )
            const acctgTransId = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                acctgTransTypeEnumId: "AttInternal",
                organizationPartyId: closedYear,
                transactionDate: ec.l10n.parseTimestamp("2023-06-15 12:00:00", "yyyy-MM-dd HH:mm:ss"),
                amountUomId: "USD",
                description: "Back-dated"
            }).acctgTransId
            for (const [glAccountId, debitCreditFlag] of [
                ["111100000", "D"],
                ["412000000", "C"]
            ])
                call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                    acctgTransId,
                    glAccountId,
                    debitCreditFlag,
                    amount: "10"
                })
            ec.message.pushErrors()
            try {
                ec.service.sync().name("mantle.ledger.LedgerServices.post#AcctgTrans").parameters({acctgTransId}).call()
            } catch (error) {
                // refused
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
            const trans = ec.entity.find("mantle.ledger.transaction.AcctgTrans").condition({acctgTransId}).disableAuthz().one()
            return {count, lookups, posted: trans.isPosted, countAfter: periods(closedYear).length}
        })
    },
    then({count, lookups, posted, countAfter}) {
        lookups == [0, 0, 0]
        posted != "Y"
        countAfter == count
    }
})

feature("a closed quarter gets no months: a lookup and a check on a day without its month create none", {
    when() {
        return pinned(Date.UTC(2030, 5, 15, 17), () => {
            const at = ec.l10n.parseTimestamp("2022-10-15 12:00:00", "yyyy-MM-dd HH:mm:ss")
            const found = lookup(closedQuarter, null, at)
            const afterLookup = periods(closedQuarter).length
            call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {
                organizationPartyId: closedQuarter,
                basisDate: "2022-10-15"
            })
            return {found, afterLookup, months: ofType(periods(closedQuarter), "FiscalMonth").map(row => row.from)}
        })
    },
    then({found, afterLookup, months}) {
        types(found) == ["FiscalQuarter", "FiscalYear"]
        afterLookup == 3
        months == ["2022-12-01"]
    }
})

// getOrgFiscalPeriods (Budget's drop-downs) passes the current value, a period id, as the term. It matched only names, so a
// rolled-up organization's lookup found nothing and made the parent's first month (of whichever row the database read
// first) for it, and the drop-down showed that month for any value.
feature("a term finds a rolled-up organization's period by its id or name and makes none", {
    when() {
        return pinned(Date.UTC(2030, 10, 15, 17), () => {
            const december = find(periods(termChild), "FiscalMonth", "2030-12-01")
            const count = periods(termChild).length
            const term = term => lookup(termChild, "FiscalMonth", null, term)
            return {
                december,
                byId: term(december.id),
                byName: term(december.name),
                none: term("FPD no such period"),
                count,
                countAfter: periods(termChild).length
            }
        })
    },
    then({december, byId, byName, none, count, countAfter}) {
        december.id != null
        byId.map(row => row.id) == [december.id]
        byName.map(row => row.id) == [december.id]
        none == []
        countAfter == count
    }
})
