// Configured fiscal calendars are anchored to the requested month/day; unset settings retain the legacy generator.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
function ensure(p) {
    const pref = lib.preference(p.organizationPartyId),
        month = Number(pref.fiscalYearStartMonth || 1),
        day = Number(pref.fiscalYearStartDay || 1)
    if (month === 1 && day === 1) return false
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31)
        throw new Error("Invalid fiscal start")
    const basis = new Date(lib.ms(p.basisDate || ec.user.nowTimestamp)),
        text = date => date.toISOString().slice(0, 10)
    const anchor = (year, offset) => {
        const first = new Date(Date.UTC(year, month - 1 + offset, 1))
        return new Date(
            Date.UTC(
                first.getUTCFullYear(),
                first.getUTCMonth(),
                Math.min(day, new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate())
            )
        )
    }
    let year = basis.getUTCFullYear()
    if (basis < anchor(year, 0)) year--
    lib.find("mantle.party.Party", {partyId: p.organizationPartyId}).forNoKeyUpdate(true).one()
    function period(type, from, to, parent, num) {
        const existing = lib
            .rows("mantle.party.time.TimePeriod", {
                partyId: p.organizationPartyId,
                timePeriodTypeId: type
            })
            .filter(r => lib.ms(r.fromDate) <= to.getTime() && lib.ms(r.thruDate) >= from.getTime())
        if (existing.length) {
            if (
                existing.length !== 1 ||
                lib.ms(existing[0].fromDate) !== from.getTime() ||
                lib.ms(existing[0].thruDate) !== to.getTime()
            )
                throw new Error("Existing fiscal periods overlap the configured calendar; reconcile before generating")
            return existing[0].timePeriodId
        }
        return lib.call("mantle.party.TimeServices.create#TimePeriod", {
            partyId: p.organizationPartyId,
            timePeriodTypeId: type,
            fromDate: text(from),
            thruDate: text(to),
            parentPeriodId: parent,
            periodNum: num
        }).timePeriodId
    }
    for (const y of [year, year + 1]) {
        const end = offset => new Date(anchor(y, offset).getTime() - 86400000)
        const yearId = period("FiscalYear", anchor(y, 0), end(12), null, y)
        for (let q = 0; q < 4; q++) {
            const quarterId = period("FiscalQuarter", anchor(y, q * 3), end(q * 3 + 3), yearId, q + 1)
            for (let m = q * 3; m < q * 3 + 3; m++) period("FiscalMonth", anchor(y, m), end(m + 1), quarterId, m + 1)
        }
    }
    return true
}
;({ensure})
