// The fiscal periods of a day in the user's zone at a month boundary (LedgerServices.get#OrganizationFiscalTimePeriods
// and check#NextFiscalTimePeriods): periods made for November 1 in UTC, as data loaded on the evening of October 31 in
// the Americas makes them, have the year and quarter of October 31 but not its month. A Chicago user's lookup on October
// 31 at 23:30 still finds October: by type, for all types (a posting's lookup) and for an organization that rolls up to a
// parent. The clock is pinned, so this holds at any time of day.
const at = Date.UTC(2030, 10, 1, 4, 30) // October 31, 23:30 in Chicago; November 1 in UTC
const parent = "FPD_PARENT",
    other = "FPD_OTHER",
    child = "FPD_CHILD"
const day = value => (value == null ? null : new Date(Number(String(value))).toISOString().slice(0, 10))
const lookup = (organizationPartyId, timePeriodTypeId) =>
    Array.from(
        call("mantle.ledger.LedgerServices.get#OrganizationFiscalTimePeriods", {
            organizationPartyId,
            filterDate: ec.user.nowTimestamp,
            timePeriodTypeId
        }).timePeriodList || []
    ).map(row => ({type: row.timePeriodTypeId, from: day(row.fromDate), thru: day(row.thruDate), partyId: row.partyId}))
const month = list => list.filter(row => row.type === "FiscalMonth")

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        for (const partyId of [parent, other, child]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: child,
            fromRoleTypeId: "OrgInternal",
            toPartyId: parent,
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
        // the periods data loaded in UTC makes on November 1: the year, the fourth quarter and November, and the next ones
        for (const organizationPartyId of [parent, other])
            call("mantle.ledger.LedgerServices.check#NextFiscalTimePeriods", {organizationPartyId, basisDate: "2030-11-01"})
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
        ec.artifactExecution.disableAuthz()
        ec.user.setEffectiveTime(at)
    }
})

feature("periods made for November 1 in UTC: a Chicago lookup on October 31 at 23:30 finds October", {
    when() {
        const before = month(lookupRows(parent))
        const byType = lookup(parent, "FiscalMonth")
        const allTypes = lookup(other, null)
        const rolledUp = lookup(child, "FiscalMonth")
        const childAll = lookup(child, null)
        return {today: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"), before, byType, allTypes, rolledUp, childAll}
    },
    then({today, before, byType, allTypes, rolledUp, childAll}) {
        today == "2030-10-31"
        // before the lookups the parent has November and December, not October
        before.map(row => row.from) == ["2030-11-01", "2030-12-01"]
        byType.length == 1
        byType[0].from == "2030-10-01"
        byType[0].thru == "2030-10-31"
        // a posting's lookup: the year, the quarter and the month of October 31
        allTypes.map(row => row.type).sort() == ["FiscalMonth", "FiscalQuarter", "FiscalYear"]
        month(allTypes)[0].from == "2030-10-01"
        rolledUp.length == 1
        rolledUp[0].partyId == child
        rolledUp[0].from == "2030-10-01"
        month(childAll).length == 1
        month(childAll)[0].from == "2030-10-01"
    }
})

function lookupRows(partyId) {
    return Array.from(
        ec.entity.find("mantle.party.time.TimePeriod").condition({partyId}).orderBy("fromDate").disableAuthz().list()
    ).map(row => ({type: row.timePeriodTypeId, from: day(row.fromDate), thru: day(row.thruDate)}))
}
