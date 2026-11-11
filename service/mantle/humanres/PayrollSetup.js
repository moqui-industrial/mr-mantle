// People's payroll setup (mantle.humanres.PayrollSetupServices; IronStone People design §5 PayGrades, §8, PE-08; impl-people
// P4, F4): pay grades and their dated bands. Later phases add components, structures, assignments and groups (P22, P23).
//
// A pay grade is a PayGrade (its name is the description) with dated PayGradeSalary bands: a minimum (minAmount), a reference
// (amount, F4) and a maximum (maxAmount), in a currency and a pay frequency (a Payroll time period type). A new band starts on
// a date and ends the band in effect then; bands are kept, never deleted, and changing one rewrites no employment salary.
//
// Pay never leaves its lane (design §1.1, §2): a band's amounts, currency and frequency are answered only to a holder of
// PAYROLL_VIEW; any other staff reader (an HR officer among them) is answered the grade's name, and nothing of its bands, on
// every path (this find, the position's grade, the choices). Changing a grade or a band needs PAYROLL_VIEW and PAYROLL_EDIT.
//
// A grade is owned by an employer (PayGrade.organizationPartyId) or shared by every employer (no owner; impl-people §4, the
// user's call of Nov 11, 2026): an owned grade is read by that employer's staff readers and changed by its payroll editors, and
// is another employer's to no one else (a missing grade); a shared grade is read by every staff reader and changed only by a
// payroll editor who also holds PEOPLE_ALL_ORGANIZATIONS (ADMIN holds it). A position takes its employer's grades and the
// shared ones (Positions.js). Job classes stay shared by every employer.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText} = lib

const GRADE = "mantle.humanres.rate.PayGrade"
const BAND = "mantle.humanres.rate.PayGradeSalary"
const gradeCap = 2000

const ms = lib.ms
const nowMs = () => ms(ec.user.nowTimestamp)
const text = value => String(value ?? "").trim()
// a parameter given: null (as an unpassed one) leaves a field as it is, an empty text clears it
const given = value => value != null
const effective = value => (value == null || value === "" ? nowMs() : ec.user.timestampMillis(value))
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at

function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.staff) denied("PERMISSION_DENIED", "Pay grades are not available")
    return userScope
}
function editorScope() {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.payrollView || !caps.payrollEdit)
        denied("PERMISSION_DENIED", "Changing a pay grade needs PAYROLL_VIEW and PAYROLL_EDIT")
    return userScope
}
// The grades the caller reads: the shared ones and those owned by an employer in scope.
function readableCondition(userScope) {
    const factory = ec.entity.conditionFactory
    const conditions = [factory.makeCondition("organizationPartyId", "is-null", null)]
    if (userScope.organizationPartyIds.length)
        conditions.push(factory.makeCondition("organizationPartyId", "in", Array.from(userScope.organizationPartyIds)))
    return factory.makeCondition(conditions, "or")
}
const readsGrade = (userScope, grade) =>
    !grade.organizationPartyId || userScope.organizationPartyIds.includes(grade.organizationPartyId)
// Whether the caller changes a grade of the owner (null for a shared one): a payroll editor of that employer, or for a shared
// grade one who also holds PEOPLE_ALL_ORGANIZATIONS.
function editsGrade(userScope, organizationPartyId) {
    const caps = userScope.capabilities
    if (!caps.payrollView || !caps.payrollEdit) return false
    return organizationPartyId ? userScope.organizationPartyIds.includes(organizationPartyId) : !!caps.allOrganizations
}
function gradeRevision(payGradeId) {
    return String(Math.max(stampOf(one(GRADE, {payGradeId})), ...rows(BAND, {payGradeId}).map(stampOf)))
}
function frequencyNames(timePeriodTypeIds) {
    const ids = people.unique(timePeriodTypeIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("mantle.party.time.TimePeriodType").condition("timePeriodTypeId", "in", ids).list()).map(row => [
            row.timePeriodTypeId,
            String(row.description || row.timePeriodTypeId).replace(/^Payroll /, "")
        ])
    )
}
// A band as payroll reads it: its dates, currency, frequency and amounts, and its state on the date.
function bandRow(row, at, frequencies) {
    const fromMs = ms(row.fromDate)
    const thruMs = ms(row.thruDate)
    const state =
        (thruMs ?? Infinity) <= at
            ? {state: "ended", stateText: "Ended"}
            : (fromMs ?? -Infinity) > at
              ? {state: "future", stateText: "From " + dateText(row.fromDate)}
              : {state: "current", stateText: "Current"}
    return Object.assign(
        {
            fromDate: row.fromDate,
            fromDateText: dateText(row.fromDate),
            thruDateText: dateText(row.thruDate),
            currencyUomId: row.currencyUomId || null,
            timePeriodTypeId: row.timePeriodTypeId || null,
            frequencyText: frequencies[row.timePeriodTypeId] || row.timePeriodTypeId || "",
            minAmount: row.minAmount ?? null,
            amount: row.amount ?? null,
            maxAmount: row.maxAmount ?? null
        },
        state
    )
}

// ===== find#PayGrades =====
// The pay grades the caller reads (the shared ones and those of an employer in scope; with organizationPartyId, the ones that
// employer's positions take), by name, searched ignoring case, paged: each its name, owner and comments for any staff reader; for a holder of
// PAYROLL_VIEW also the band in effect on the date (else the next one), the count of bands and, for the grade asked for
// (payGradeId), every band, newest first. amountsShown says which answer it is.
function findPayGrades(p) {
    const userScope = readerScope()
    const caps = userScope.capabilities
    const amountsShown = !!caps.payrollView
    const at = people.asOfMillis(p.asOfDate)
    // the grades one employer's positions take (its own and the shared ones), else every grade the caller reads
    if (text(p.organizationPartyId)) people.requireOrganization(userScope, text(p.organizationPartyId))
    let query = find(GRADE).condition(
        readableCondition(text(p.organizationPartyId) ? {organizationPartyIds: [text(p.organizationPartyId)]} : userScope)
    )
    if (text(p.term)) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                ["payGradeId", "description"].map(field =>
                    factory.makeCondition(field, "like", likeText(text(p.term))).ignoreCase()
                ),
                "or"
            )
        )
    }
    if (text(p.payGradeId)) query = query.condition("payGradeId", text(p.payGradeId))
    const recordCount = query.count()
    const paged = lib.page(query.orderBy(["^description", "payGradeId"]), p, "payGrades", recordCount, {noLimitCap: gradeCap})
    const grades = paged.rows
    const bandsOf = {}
    if (amountsShown && grades.length)
        for (const row of Array.from(
            find(BAND)
                .condition(
                    "payGradeId",
                    "in",
                    grades.map(row => row.payGradeId)
                )
                .orderBy("-fromDate")
                .list()
        ))
            (bandsOf[row.payGradeId] = bandsOf[row.payGradeId] || []).push(row)
    const frequencies = frequencyNames(
        Object.values(bandsOf)
            .flat()
            .map(row => row.timePeriodTypeId)
    )
    const owners = people.organizationNames(people.unique(grades.map(row => row.organizationPartyId).filter(Boolean)))
    const payGrades = grades.map(row => {
        const out = {
            payGradeId: row.payGradeId,
            gradeName: row.description || row.payGradeId,
            comments: row.comments || "",
            organizationPartyId: row.organizationPartyId || null,
            organizationName: row.organizationPartyId ? owners[row.organizationPartyId] || row.organizationPartyId : "",
            amountsShown,
            canEdit: editsGrade(userScope, row.organizationPartyId || null)
        }
        if (!amountsShown) return out
        const bands = bandsOf[row.payGradeId] || []
        const shown =
            bands.find(band => openAt(band, at)) ||
            bands.filter(band => (ms(band.fromDate) ?? 0) > at).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0] ||
            null
        return Object.assign(out, {
            bandCount: bands.length,
            band: shown ? bandRow(shown, at, frequencies) : null,
            revision: gradeRevision(row.payGradeId)
        })
    })
    const out = {payGrades, amountsShown, asOfDate: at, bands: []}
    for (const key of Object.keys(paged)) if (key.startsWith("payGrades") && key !== "payGrades") out[key] = paged[key]
    if (amountsShown && text(p.payGradeId) && grades.length)
        out.bands = (bandsOf[grades[0].payGradeId] || []).map(row => bandRow(row, at, frequencies))
    return out
}

// ===== store#PayGrade =====
// A new grade, a grade's new name or comments, and a new band from a date (design §5 GradeBand): the band in effect then ends
// on that date and the new one starts, both kept. Refused: a caller without PAYROLL_VIEW and PAYROLL_EDIT (PERMISSION_DENIED);
// an owner outside the scope (ORGANIZATION_DENIED); a new or changed shared grade without PEOPLE_ALL_ORGANIZATIONS
// (PERMISSION_DENIED); no name (NAME_REQUIRED); a missing grade or another employer's (RECORD_UNAVAILABLE); another owner
// (OWNER_CHANGE); a revision other than the one read (REVISION_CHANGED); a band
// with no currency (CURRENCY_REQUIRED) or an unknown one (CURRENCY_INVALID), no frequency (FREQUENCY_REQUIRED) or one that is
// not a payroll period (FREQUENCY_INVALID), a missing minimum, reference or maximum (AMOUNT_REQUIRED), a negative amount
// (AMOUNT_INVALID) or one finer than the currency (CURRENCY_PRECISION), amounts out of order, the minimum above the reference
// or the reference above the maximum (BAND_ORDER), an end on or before its start (DATES_INVALID), a band from that date or later
// already set (BAND_SCHEDULED).
function decimalOf(value, currencyUomId, label) {
    if (value == null || String(value).trim() === "") denied("AMOUNT_REQUIRED", "Enter the " + label)
    let decimal
    try {
        decimal = toDecimal(String(value).trim())
    } catch (_) {
        denied("AMOUNT_INVALID", "The " + label + " is not an amount")
    }
    if (decimal == null || decimal.compare(0) < 0) denied("AMOUNT_INVALID", "The " + label + " is not an amount")
    if (!decimal.eq(ec.l10n.roundCurrency(decimal, currencyUomId)))
        denied("CURRENCY_PRECISION", "The " + label + " exceeds the currency's precision")
    return decimal
}
const bandFields = ["currencyUomId", "timePeriodTypeId", "minAmount", "amount", "maxAmount"]
function addBand(payGradeId, p) {
    const currencyUomId = text(p.currencyUomId)
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the currency")
    const currency = one("moqui.basic.Uom", {uomId: currencyUomId})
    if (!currency || currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", currencyUomId + " is not a currency")
    const timePeriodTypeId = text(p.timePeriodTypeId)
    if (!timePeriodTypeId) denied("FREQUENCY_REQUIRED", "Choose the pay frequency")
    if (!timePeriodTypeId.startsWith("Payroll") || !one("mantle.party.time.TimePeriodType", {timePeriodTypeId}))
        denied("FREQUENCY_INVALID", timePeriodTypeId + " is not a pay frequency")
    const minAmount = decimalOf(p.minAmount, currencyUomId, "minimum")
    const amount = decimalOf(p.amount, currencyUomId, "reference")
    const maxAmount = decimalOf(p.maxAmount, currencyUomId, "maximum")
    if (minAmount.compare(amount) > 0 || amount.compare(maxAmount) > 0)
        denied("BAND_ORDER", "A band's minimum is at most its reference, and its reference at most its maximum")
    const fromMs = effective(p.fromDate)
    const thruMs = text(p.thruDate) ? effective(p.thruDate) : null
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A band ends after it starts")
    const bands = rows(BAND, {payGradeId})
    if (bands.some(band => (ms(band.fromDate) ?? -Infinity) >= fromMs))
        denied("BAND_SCHEDULED", "This grade has a band from that date or later; change the dates")
    // the band in effect ends on the date; the new band's amounts rewrite no employment salary
    for (const band of bands.filter(band => openAt(band, fromMs)))
        call("update#" + BAND, {payGradeId, fromDate: band.fromDate, thruDate: new Date(fromMs)})
    call("create#" + BAND, {
        payGradeId,
        fromDate: new Date(fromMs),
        thruDate: thruMs == null ? null : new Date(thruMs),
        currencyUomId,
        timePeriodTypeId,
        minAmount,
        amount,
        maxAmount
    })
}
const sharedDenied = () =>
    denied("PERMISSION_DENIED", "A pay grade shared by every employer is changed only with PEOPLE_ALL_ORGANIZATIONS")
function storePayGrade(p) {
    const userScope = editorScope()
    const withBand = bandFields.some(field => text(p[field]))
    if (!text(p.payGradeId)) {
        // the owner: an employer the caller edits the grades of, or none (shared) for a holder of PEOPLE_ALL_ORGANIZATIONS
        const organizationPartyId = text(p.organizationPartyId) || null
        if (organizationPartyId) people.requireOrganization(userScope, organizationPartyId)
        else if (!editsGrade(userScope, null)) sharedDenied()
        if (!text(p.gradeName)) denied("NAME_REQUIRED", "A pay grade has a name")
        const created = call("create#" + GRADE, {
            description: text(p.gradeName),
            comments: text(p.comments) || null,
            organizationPartyId
        })
        if (withBand) addBand(created.payGradeId, p)
        return {payGradeId: created.payGradeId, revision: gradeRevision(created.payGradeId)}
    }
    const payGradeId = text(p.payGradeId)
    const grade = one(GRADE, {payGradeId})
    // another employer's grade is a missing one; a shared one is changed with PEOPLE_ALL_ORGANIZATIONS alone
    if (!grade || !readsGrade(userScope, grade)) denied("RECORD_UNAVAILABLE", "Pay grade " + payGradeId + " is not available")
    if (!editsGrade(userScope, grade.organizationPartyId || null)) sharedDenied()
    if (text(p.organizationPartyId) && text(p.organizationPartyId) !== (grade.organizationPartyId || ""))
        denied("OWNER_CHANGE", "A pay grade stays with its owner; create a grade of the other employer instead")
    const revision = gradeRevision(payGradeId)
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This pay grade changed since you read it; open it again (revision " + revision + ")")
    const changes = {payGradeId}
    if (given(p.gradeName)) {
        if (!text(p.gradeName)) denied("NAME_REQUIRED", "A pay grade has a name")
        if (text(p.gradeName) !== (grade.description || "")) changes.description = text(p.gradeName)
    }
    if (given(p.comments) && (text(p.comments) || null) !== (grade.comments || null)) changes.comments = text(p.comments) || null
    if (Object.keys(changes).length > 1) call("update#" + GRADE, changes)
    if (withBand) addBand(payGradeId, p)
    return {payGradeId, revision: gradeRevision(payGradeId)}
}

const operations = {findPayGrades, storePayGrade}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payroll setup operation " + op)
    return operations[op](p || {})
}
;({execute: run})
