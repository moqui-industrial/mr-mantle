// People's payroll configuration (mantle.humanres.PayrollSetupServices; IronStone People design §8.1, §8.4, PayComponents,
// PayComponentDetail, PayStructures, PayStructureDetail, PayGroups; PE-08, PE-09, PE-12; impl-people P22): an employer's pay
// components and their dated terms, examples and account mappings; structures and their dated components; pay groups and their
// periods. Pay grades are PayrollSetup.js's (P4).
//
// Pay never leaves its lane (design §1.1, §2): every answer here is configuration a holder of PAYROLL_VIEW reads for an employer
// in their People scope; changing it needs PAYROLL_VIEW, PAYROLL_EDIT and PAYROLL_CONFIGURE (design §1.1; the P22 review's call
// of Nov 12, 2026 put PAYROLL_CONFIGURE in place of PEOPLE_CONFIGURE). Another employer's record is a missing one
// (RECORD_UNAVAILABLE).
//
// Publishing takes effect on approval (the P22 review's call of Nov 12, 2026): publish#Component and publish#Structure check the
// draft as it would be published and ask for a People approval of kind PakPayrollConfig (Approvals.js: the employer's payroll
// approvers and HR editors who read payroll, unless a rule says otherwise; never one who drafted it or asked); decide#Publication
// and the PeoplePayrollConfigApproval topic's services decide it, and the last approval publishes the draft, checked again. A
// change of the draft (its term, examples or lines) supersedes the waiting request.
//
// A formula is the framework's decimal expression (org.moqui.impl.ExpressionServices, PE-09): named decimal inputs, the codes of
// other components, comparisons, conditions and an allowlist of functions, checked and computed by the framework's own parser,
// never by a script. A term declares its inputs; every other name its formula reads is a dependency on a component of the
// employer, whose code it is. Publishing a term needs its examples to give their expected amounts, its dependencies published
// and without a cycle, its account mapping, and no published term of the component from that date or later; a published term is
// only ended. Nothing is implicit: no currency, no annual divisor, no rounding (a term's rounding stage is its own), no proration.
// A statistical component enters no total and maps no account. Nothing here creates money: previews read and compute only.
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, denied, call, dateText, calendarDateText} = lib

const COMPONENT = "mantle.humanres.payroll.PayrollComponent"
const TERM = "mantle.humanres.payroll.PayrollComponentTerm"
const EXAMPLE = "mantle.humanres.payroll.PayrollComponentExample"
const STRUCTURE = "mantle.humanres.payroll.PayrollStructure"
const LINE = "mantle.humanres.payroll.PayrollStructureComponent"
const GROUP = "mantle.humanres.payroll.PayrollGroup"
const GROUP_PERIOD = "mantle.humanres.payroll.PayrollGroupPeriod"
const LOCALIZATION = "mantle.humanres.payroll.PayrollLocalization"
const EXPRESSIONS = "org.moqui.impl.ExpressionServices."
const approvals = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/Approvals.js")
const KIND = "PakPayrollConfig"
const listCap = 2000
const periodCap = 24
const day = 24 * 60 * 60 * 1000

const kinds = {
    PckEarning: "Earning",
    PckDeduction: "Deduction",
    PckContribution: "Employer contribution",
    PckStatistical: "Statistical"
}
const bases = {PcbAmount: "Fixed amount", PcbFormula: "Formula"}
const roundings = {PrdNearest: ["round", "nearest"], PrdDown: ["floor", "down"], PrdUp: ["ceil", "up"]}
const payBases = {PpbSalaried: "Salaried", PpbHourly: "Hourly", PpbMixed: "Salaried and hourly"}
// P23: a line's eligibility: every assignment of the structure, or one that elects it
const eligibilities = {PleAll: "Every assignment", PleElected: "When elected"}
const prorations = {PprCalendarDays: "Calendar days", PprWorkingDays: "Working days", PprHours: "Hours"}
const timeBases = {PtbTimesheets: "Approved timesheets", PtbAttendance: "Attendance", PtbSchedule: "Working schedule"}
const frequencies = ["PayrollMonth", "PayrollSemiMonth", "PayrollBiWeek", "PayrollWeek"]
// the names a formula's grammar keeps for itself, which no input or component code may take
const reserved = new Set(["and", "or", "not", "if", "min", "max", "abs", "round", "floor", "ceil"])
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

const text = value => String(value ?? "").trim()
const given = value => value != null
const blank = value => value == null || String(value).trim() === ""
const when = value => (blank(value) ? null : ec.user.timestampMillis(value))
const stamp = millis => (millis == null ? null : new Date(Number(millis)))
const ms = lib.ms
const nowMs = () => ec.user.timestampMillis(ec.user.nowTimestamp)
const flag = value => value === true || value === "true" || value === "Y"
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const revisionOf = list => String(Math.max(0, ...list.filter(Boolean).map(stampOf)))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const likeText = value => "%" + String(value).replace(/[\\%_]/g, character => "\\" + character) + "%"
const listText = list => (list.length ? list.join(", ") : "")
const splitNames = value =>
    blank(value)
        ? []
        : people.unique((Array.isArray(value) ? value : String(value).split(/[\s,;]+/)).map(name => text(name)).filter(Boolean))

// ===== access =====
function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Payroll configuration is not available")
    return userScope
}
const edits = userScope => {
    const caps = userScope.capabilities
    return !!(caps.payrollView && caps.payrollEdit && caps.payrollConfigure)
}
function editorScope() {
    const userScope = people.scopeOf()
    if (!edits(userScope)) denied("PERMISSION_DENIED", "Changing payroll configuration needs PAYROLL_EDIT and PAYROLL_CONFIGURE")
    return userScope
}
// A dated row is ended from today on, never in the past, so what was in effect stays as it was (P22 review)
function checkEnd(endMs) {
    if (endMs < nowMs() - day) denied("EFFECTIVE_DATE_PAST", "A configuration in effect is ended from today on, not in the past")
}
// P23: a structure or a group still paying an employment from a date is not ended then (STILL_ASSIGNED): its assignments are
// ended or replaced first, so no employment is left on a structure or group that has ended
function checkUnassigned(field, id, endMs, label) {
    const paid = rows("mantle.humanres.payroll.PayrollAssignment", {[field]: id}).filter(
        row => (ms(row.thruDate) ?? Infinity) > endMs && (ms(row.thruDate) ?? Infinity) > (ms(row.fromDate) ?? -Infinity)
    ).length
    if (paid)
        denied(
            "STILL_ASSIGNED",
            paid +
                (paid === 1 ? " pay assignment uses" : " pay assignments use") +
                " this " +
                label +
                " then; end or replace them first"
        )
}
// The users who drafted a term or a structure, the caller added: none of them decides its publishing (P22 review)
function withDrafter(draftedByUserIds) {
    const userIds = splitNames(draftedByUserIds)
    if (ec.user.userId && !userIds.includes(ec.user.userId)) userIds.push(ec.user.userId)
    return userIds.join(",") || null
}
function requireEmployer(userScope, organizationPartyId) {
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose the employer")
    people.requireOrganization(userScope, organizationPartyId)
}
// a record of an employer outside the scope is a missing one
function readable(userScope, entityName, key, id, label) {
    const row = id ? one(entityName, {[key]: id}) : null
    if (!row || !userScope.organizationPartyIds.includes(row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", label + " " + (id || "") + " is not available")
    return row
}
function checkRevision(expectedRevision, revision, label) {
    if (text(expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This " + label + " changed since you read it; open it again (revision " + revision + ")")
}

// ===== the evaluator (PE-09) =====
function validateFormula(formula) {
    return call(EXPRESSIONS + "validate#DecimalExpression", {expression: formula})
}
function evaluate(formula, inputs) {
    return call(EXPRESSIONS + "evaluate#DecimalExpression", {expression: formula, inputs})
}
// a decimal rounded by a rounding stage, through the evaluator, so the rounding is the formula language's own
function rounded(value, places, roundingEnumId) {
    const [fn] = roundings[roundingEnumId]
    const out = evaluate(fn + "(x, " + places + ")", {x: value})
    if (!out.valid) throw new Error(out.errorCode + ": " + out.errorMessage)
    return out.result
}

// ===== values =====
function decimalOf(value, code, label) {
    if (blank(value)) return null
    try {
        const decimal = toDecimal(String(value).trim())
        if (decimal != null) return decimal
    } catch (_) {
        // refused below
    }
    denied(code, "The " + label + " is not a number")
}
// Named decimal values (an example's inputs, a structure's parameter values): a map, a JSON object or "name = value" pairs
// separated by commas, semicolons or lines. Each name a formula name, each value a decimal.
function valuesOf(value, label) {
    if (value == null || value === "") return {}
    let entries
    if (typeof value === "object") entries = Object.entries(value)
    else {
        const source = String(value).trim()
        if (!source) return {}
        if (source.startsWith("{")) {
            try {
                entries = Object.entries(JSON.parse(source))
            } catch (_) {
                denied("VALUE_INVALID", "The " + label + " are not readable")
            }
        } else
            entries = source
                .split(/[,;\n]+/)
                .map(part => part.trim())
                .filter(Boolean)
                .map(part => {
                    const at = part.indexOf("=")
                    if (at < 0) denied("VALUE_INVALID", "Write the " + label + " as name = value: " + part)
                    return [part.slice(0, at), part.slice(at + 1)]
                })
    }
    const out = {}
    for (const [rawName, rawValue] of entries) {
        const name = text(rawName)
        if (!identifier.test(name) || reserved.has(name)) denied("VALUE_INVALID", name + " is not a name a formula may use")
        const decimal = decimalOf(rawValue, "VALUE_INVALID", "value of " + name)
        if (decimal == null) denied("VALUE_INVALID", "Give " + name + " a value")
        out[name] = String(decimal)
    }
    return out
}
const storedValues = textValue => lib.json(textValue, {}) || {}
const valuesText = values =>
    Object.entries(values)
        .map(([name, value]) => name + " = " + value)
        .join(", ")
function currencyOf(currencyUomId) {
    const currency = one("moqui.basic.Uom", {uomId: currencyUomId})
    if (!currency || currency.uomTypeEnumId !== "UT_CURRENCY_MEASURE")
        denied("CURRENCY_INVALID", currencyUomId + " is not a currency")
    return currencyUomId
}
const userName = userId => (userId ? one("moqui.security.UserAccount", {userId})?.userFullName || userId : "")
function accountText(glAccountId) {
    if (!glAccountId) return ""
    const account = one("mantle.ledger.account.GlAccount", {glAccountId})
    return account ? [account.accountCode, account.accountName].filter(Boolean).join(" ") : glAccountId
}

// ===== components =====
function componentRevision(payrollComponentId) {
    const terms = rows(TERM, {payrollComponentId})
    const termIds = terms.map(row => row.payrollComponentTermId)
    const examples = termIds.length ? Array.from(find(EXAMPLE).condition("payrollComponentTermId", "in", termIds).list()) : []
    return revisionOf([one(COMPONENT, {payrollComponentId})].concat(terms, examples))
}
// A term's state on a date: a draft (waiting for approval when a request to publish it waits), in effect, from a later date, or
// ended
function termState(term, at, waiting) {
    if (term.statusId !== "PtsPublished")
        return waiting?.has(term.payrollComponentTermId)
            ? {state: "waiting", stateText: "Waiting for approval"}
            : {state: "draft", stateText: "Draft"}
    if ((ms(term.thruDate) ?? Infinity) <= at) return {state: "ended", stateText: "Ended"}
    if ((ms(term.fromDate) ?? -Infinity) > at) return {state: "future", stateText: "From " + dateText(term.fromDate)}
    return {state: "current", stateText: "In effect"}
}
const publishedTerms = payrollComponentId =>
    Array.from(find(TERM, {payrollComponentId, statusId: "PtsPublished"}).orderBy("fromDate").list())
const draftTerm = payrollComponentId => find(TERM, {payrollComponentId, statusId: "PtsDraft"}).orderBy("-fromDate").one()
// the published term in effect at a date
const termAt = (payrollComponentId, at) => publishedTerms(payrollComponentId).find(term => openAt(term, at)) || null
function unitText(term) {
    if (term.currencyUomId) return term.currencyUomId
    if (term.quantityUomId) return one("moqui.basic.Uom", {uomId: term.quantityUomId})?.description || term.quantityUomId
    return ""
}
function calculationText(term) {
    if (term.basisEnumId === "PcbAmount") return term.amount == null ? "" : "Fixed " + String(term.amount)
    return text(term.formula)
}
function roundingText(term) {
    if (term.roundingPlaces == null || !term.roundingEnumId) return "Not rounded"
    const places = Number(term.roundingPlaces)
    return "Rounded " + roundings[term.roundingEnumId][1] + " to " + places + (places === 1 ? " place" : " places")
}
function termRow(term, at, exampleCounts, waiting) {
    return Object.assign(
        {
            payrollComponentTermId: term.payrollComponentTermId,
            fromDate: term.fromDate,
            fromDateText: dateText(term.fromDate),
            thruDateText: dateText(term.thruDate),
            statusId: term.statusId,
            basisEnumId: term.basisEnumId,
            basisText: bases[term.basisEnumId] || "",
            amount: term.amount ?? null,
            formula: term.formula || "",
            calculationText: calculationText(term),
            inputNames: splitNames(term.inputNames),
            inputNamesText: listText(splitNames(term.inputNames)),
            dependencyCodes: splitNames(term.dependencyCodes),
            dependencyText: listText(splitNames(term.dependencyCodes)),
            currencyUomId: term.currencyUomId || null,
            quantityUomId: term.quantityUomId || null,
            unitText: unitText(term),
            roundingPlaces: term.roundingPlaces ?? null,
            roundingEnumId: term.roundingEnumId || null,
            roundingText: roundingText(term),
            payslipVisible: term.payslipVisible === "Y",
            expenseGlAccountId: term.expenseGlAccountId || null,
            expenseAccountText: accountText(term.expenseGlAccountId),
            liabilityGlAccountId: term.liabilityGlAccountId || null,
            liabilityAccountText: accountText(term.liabilityGlAccountId),
            publishedDateText: dateText(term.publishedDate),
            publishedByName: userName(term.publishedByUserId),
            exampleCount: exampleCounts?.[term.payrollComponentTermId] || 0
        },
        termState(term, at, waiting)
    )
}
// the term a list shows: the published one in effect, else the next one, else the draft, else the last one
function shownTerm(terms, at) {
    const published = terms.filter(term => term.statusId === "PtsPublished")
    return (
        published.find(term => openAt(term, at)) ||
        published.filter(term => (ms(term.fromDate) ?? 0) > at).sort((a, b) => ms(a.fromDate) - ms(b.fromDate))[0] ||
        terms.find(term => term.statusId === "PtsDraft") ||
        published[published.length - 1] ||
        null
    )
}
function componentState(component, terms, at, waiting) {
    if ((ms(component.thruDate) ?? Infinity) <= at) return {state: "ended", stateText: "Ended"}
    const shown = shownTerm(terms, at)
    if (!shown) return {state: "new", stateText: "No terms"}
    return termState(shown, at, waiting)
}
const draftIdsOf = terms => terms.filter(term => term.statusId === "PtsDraft").map(term => term.payrollComponentTermId)

// ===== find#Components =====
// The components of the employers the caller reads (or the one asked for), searched by code or name ignoring case, of a kind,
// in a state on asOfDate, paged: each its code, name, kind, employer and the term in effect (else the next, else the draft);
// with payrollComponentId, its terms (newest first) and the examples of the term asked for (payrollComponentTermId, else the
// draft, else the one in effect).
function findComponents(p) {
    const userScope = readerScope()
    const at = people.asOfMillis(p.asOfDate)
    const organizationPartyIds = text(p.organizationPartyId)
        ? (people.requireOrganization(userScope, text(p.organizationPartyId)), [text(p.organizationPartyId)])
        : userScope.organizationPartyIds
    const out = {asOfDate: at, canEdit: edits(userScope), components: [], component: null, terms: [], examples: []}
    if (text(p.payrollComponentId)) {
        const component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
        const terms = Array.from(
            find(TERM, {payrollComponentId: component.payrollComponentId})
                .orderBy(["-fromDate", "-payrollComponentTermId"])
                .list()
        )
        const examples = terms.length
            ? Array.from(
                  find(EXAMPLE)
                      .condition(
                          "payrollComponentTermId",
                          "in",
                          terms.map(term => term.payrollComponentTermId)
                      )
                      .orderBy("payrollComponentExampleId")
                      .list()
              )
            : []
        const counts = {}
        for (const example of examples) counts[example.payrollComponentTermId] = (counts[example.payrollComponentTermId] || 0) + 1
        const opened =
            terms.find(term => term.payrollComponentTermId === text(p.payrollComponentTermId)) ||
            terms.find(term => term.statusId === "PtsDraft") ||
            shownTerm(terms, at)
        const waiting = waitingIds(TERM, draftIdsOf(terms))
        const draftTermId = terms.find(term => term.statusId === "PtsDraft")?.payrollComponentTermId || null
        out.component = Object.assign(componentRow(component, terms, at, userScope, null, waiting), {
            revision: componentRevision(component.payrollComponentId),
            openTermId: opened?.payrollComponentTermId || null,
            draftTermId,
            waitingApproval: !!draftTermId && waiting.has(draftTermId),
            // the request to publish the term opened (its steps, decisions and whether the caller decides it)
            approval: approvalOf(TERM, opened?.payrollComponentTermId)
        })
        out.terms = terms.map(term => termRow(term, at, counts, waiting))
        out.examples = examples
            .filter(example => example.payrollComponentTermId === opened?.payrollComponentTermId)
            .map(example => exampleRow(example))
        out.components = [out.component]
        out.componentsCount = 1
        return out
    }
    if (!organizationPartyIds.length) return Object.assign(out, lib.pageList([], p, "components"))
    let query = find(COMPONENT).condition("organizationPartyId", "in", organizationPartyIds)
    if (text(p.componentKindEnumId)) query = query.condition("componentKindEnumId", text(p.componentKindEnumId))
    if (text(p.term)) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                ["componentCode", "componentName"].map(field =>
                    factory.makeCondition(field, "like", likeText(text(p.term))).ignoreCase()
                ),
                "or"
            )
        )
    }
    const components = Array.from(query.orderBy(["componentCode"]).limit(listCap).list())
    const termsOf = {}
    if (components.length)
        for (const term of Array.from(
            find(TERM)
                .condition(
                    "payrollComponentId",
                    "in",
                    components.map(row => row.payrollComponentId)
                )
                .orderBy("-fromDate")
                .list()
        ))
            (termsOf[term.payrollComponentId] = termsOf[term.payrollComponentId] || []).push(term)
    const names = people.organizationNames(people.unique(components.map(row => row.organizationPartyId)))
    const waiting = waitingIds(TERM, draftIdsOf(Object.values(termsOf).flat()))
    let list = components.map(row => componentRow(row, termsOf[row.payrollComponentId] || [], at, userScope, names, waiting))
    // ended components only when asked for; waiting: a request to publish its draft waits (P22 review)
    if (text(p.state) === "waiting") list = list.filter(row => row.waitingApproval)
    else if (text(p.state)) list = list.filter(row => row.state === text(p.state))
    else list = list.filter(row => row.state !== "ended")
    return Object.assign(out, lib.pageList(list, p, "components", {noLimitCap: listCap}))
}
function componentRow(component, terms, at, userScope, names, waiting) {
    const shown = shownTerm(terms, at)
    return Object.assign(
        {
            payrollComponentId: component.payrollComponentId,
            componentCode: component.componentCode,
            componentName: component.componentName || component.componentCode,
            componentKindEnumId: component.componentKindEnumId,
            kindText: kinds[component.componentKindEnumId] || "",
            statistical: component.componentKindEnumId === "PckStatistical",
            description: component.description || "",
            organizationPartyId: component.organizationPartyId,
            organizationName:
                (names || people.organizationNames([component.organizationPartyId]))[component.organizationPartyId] || "",
            thruDateText: dateText(component.thruDate),
            basisText: shown ? bases[shown.basisEnumId] || "" : "",
            unitText: shown ? unitText(shown) : "",
            calculationText: shown ? calculationText(shown) : "",
            fromDateText: shown ? dateText(shown.fromDate) : "",
            termThruDateText: shown ? dateText(shown.thruDate) : "",
            hasDraft: terms.some(term => term.statusId === "PtsDraft"),
            waitingApproval: terms.some(term => term.statusId === "PtsDraft" && waiting?.has(term.payrollComponentTermId)),
            canEdit: edits(userScope) && (ms(component.thruDate) ?? Infinity) > nowMs()
        },
        componentState(component, terms, at, waiting)
    )
}
function exampleRow(example) {
    const values = storedValues(example.inputValues)
    return {
        payrollComponentExampleId: example.payrollComponentExampleId,
        exampleName: example.exampleName || "",
        inputValues: values,
        inputValuesText: valuesText(values),
        expectedAmount: example.expectedAmount ?? null
    }
}

// ===== store#Component =====
// A new component (employer, code, name, kind), a component's new name, description or end at the revision read, and its draft
// term: created (from fromDate, now when empty) when it has none, else changed. A published term is never changed here.
const termFields = [
    "basisEnumId",
    "amount",
    "formula",
    "inputNames",
    "currencyUomId",
    "quantityUomId",
    "roundingPlaces",
    "roundingEnumId",
    "payslipVisible",
    "expenseGlAccountId",
    "liabilityGlAccountId",
    "fromDate",
    "thruDate"
]
function checkCode(code) {
    if (!identifier.test(code) || reserved.has(code))
        denied(
            "CODE_INVALID",
            "A component's code starts with a letter or underscore and has only letters, digits and underscores, and is not a word formulas keep"
        )
}
function storeComponent(p) {
    const userScope = editorScope()
    let component
    if (!text(p.payrollComponentId)) {
        const organizationPartyId = text(p.organizationPartyId)
        requireEmployer(userScope, organizationPartyId)
        const componentCode = text(p.componentCode)
        if (!componentCode) denied("CODE_REQUIRED", "A component has a code")
        checkCode(componentCode)
        if (one(COMPONENT, {organizationPartyId, componentCode}))
            denied("CODE_TAKEN", "The employer has a component " + componentCode + " already")
        if (!text(p.componentName)) denied("NAME_REQUIRED", "A component has a name")
        if (!kinds[text(p.componentKindEnumId)]) denied("KIND_INVALID", "Choose the kind of component")
        const created = call("create#" + COMPONENT, {
            organizationPartyId,
            componentCode,
            componentName: text(p.componentName),
            componentKindEnumId: text(p.componentKindEnumId),
            description: text(p.description) || null,
            createdDate: ec.user.nowTimestamp
        })
        component = one(COMPONENT, {payrollComponentId: created.payrollComponentId})
    } else {
        component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
        checkRevision(p.expectedRevision, componentRevision(component.payrollComponentId), "pay component")
        if ((ms(component.thruDate) ?? Infinity) <= nowMs()) denied("COMPONENT_ENDED", "This component has ended")
        const changes = {payrollComponentId: component.payrollComponentId}
        if (given(p.componentName)) {
            if (!text(p.componentName)) denied("NAME_REQUIRED", "A component has a name")
            if (text(p.componentName) !== component.componentName) changes.componentName = text(p.componentName)
        }
        if (given(p.description) && (text(p.description) || null) !== (component.description || null))
            changes.description = text(p.description) || null
        if (flag(p.end)) {
            const endMs = when(p.componentThruDate) ?? nowMs()
            checkEnd(endMs)
            const inUse = Array.from(find(LINE, {payrollComponentId: component.payrollComponentId}).list()).some(
                line => (ms(line.thruDate) ?? Infinity) > endMs
            )
            if (inUse) denied("COMPONENT_IN_USE", "A structure uses this component after that date; end its line there first")
            changes.thruDate = new Date(endMs)
            // an ended component publishes nothing: the request waiting for its draft is superseded
            const draft = draftTerm(component.payrollComponentId)
            if (draft) approvals().sourceChanged(KIND, draft.payrollComponentTermId, TERM, true)
        }
        if (Object.keys(changes).length > 1) call("update#" + COMPONENT, changes)
    }
    let payrollComponentTermId = null
    if (termFields.some(field => given(p[field]) && p[field] !== "") || text(p.payrollComponentTermId))
        payrollComponentTermId = storeDraftTerm(component, p)
    return {
        payrollComponentId: component.payrollComponentId,
        payrollComponentTermId,
        revision: componentRevision(component.payrollComponentId)
    }
}
// The draft term: the one named, else the component's draft, else a new one (a copy of the latest published term, without its
// dates). Every field given replaces the draft's; the term as merged is then checked whole.
function storeDraftTerm(component, p) {
    let draft = text(p.payrollComponentTermId)
        ? one(TERM, {payrollComponentTermId: text(p.payrollComponentTermId)})
        : draftTerm(component.payrollComponentId)
    if (text(p.payrollComponentTermId) && (!draft || draft.payrollComponentId !== component.payrollComponentId))
        denied("RECORD_UNAVAILABLE", "That term is not this component's")
    if (draft && draft.statusId !== "PtsDraft")
        denied("TERM_PUBLISHED", "A published term is not changed; start a draft from a later date and publish it")
    // a new draft starts as a copy of the component's latest published term, without its dates
    const published = publishedTerms(component.payrollComponentId)
    const base = draft || published[published.length - 1] || null
    const merged = {}
    for (const field of termFields)
        merged[field] = base && (draft || !["fromDate", "thruDate"].includes(field)) ? (base[field] ?? null) : null
    for (const field of termFields) if (given(p[field])) merged[field] = p[field] === "" ? null : p[field]
    if (!draft && merged.fromDate == null) merged.fromDate = ec.user.nowTimestamp
    const checked = checkTerm(component, merged)
    checked.draftedByUserIds = withDrafter(draft?.draftedByUserIds)
    if (draft) {
        call("update#" + TERM, Object.assign({payrollComponentTermId: draft.payrollComponentTermId}, checked))
        // a changed draft supersedes the request waiting to publish it
        approvals().sourceChanged(KIND, draft.payrollComponentTermId, TERM)
        return draft.payrollComponentTermId
    }
    return call(
        "create#" + TERM,
        Object.assign({payrollComponentId: component.payrollComponentId, statusId: "PtsDraft"}, checked)
    ).payrollComponentTermId
}
// A term checked whole: its basis and amount or formula (the evaluator's grammar; every name it reads that is not a declared
// input is a dependency, never the component itself), the currency of a money component or the unit of a statistical one, the
// rounding stage, the account mapping the kind takes (none for a statistical one) and its dates.
function checkTerm(component, term) {
    const kind = component.componentKindEnumId
    const statistical = kind === "PckStatistical"
    const basisEnumId = text(term.basisEnumId)
    if (!basisEnumId) denied("BASIS_REQUIRED", "Choose a fixed amount or a formula")
    if (!bases[basisEnumId]) denied("BASIS_INVALID", basisEnumId + " is not a basis")
    const out = {basisEnumId, amount: null, formula: null, inputNames: null, dependencyCodes: null}
    const inputs = splitNames(term.inputNames)
    for (const name of inputs) {
        if (!identifier.test(name) || reserved.has(name)) denied("INPUT_INVALID", name + " is not a name a formula may use")
        if (name === component.componentCode) denied("INPUT_INVALID", "An input is not the component's own code")
    }
    if (basisEnumId === "PcbAmount") {
        out.amount = decimalOf(term.amount, "AMOUNT_INVALID", "amount")
        if (out.amount == null) denied("AMOUNT_REQUIRED", "Enter the amount")
    } else {
        const formula = text(term.formula)
        if (!formula) denied("FORMULA_REQUIRED", "Write the formula")
        const checked = validateFormula(formula)
        if (!checked.valid)
            denied(
                "FORMULA_INVALID",
                (checked.errorMessage || "The formula is not valid") +
                    (checked.errorPosition ? " (at character " + checked.errorPosition + ")" : "") +
                    " [" +
                    checked.errorCode +
                    "]"
            )
        const names = Array.from(checked.names || [])
        const dependencies = names.filter(name => !inputs.includes(name))
        if (dependencies.includes(component.componentCode))
            denied("CYCLIC_DEPENDENCY", "The formula reads " + component.componentCode + ", the component itself")
        out.formula = formula
        out.dependencyCodes = dependencies.join(",") || null
    }
    out.inputNames = inputs.join(",") || null
    out.currencyUomId = text(term.currencyUomId) ? currencyOf(text(term.currencyUomId)) : null
    out.quantityUomId = text(term.quantityUomId) || null
    if (out.quantityUomId && !one("moqui.basic.Uom", {uomId: out.quantityUomId}))
        denied("UNIT_INVALID", out.quantityUomId + " is not a unit")
    // no implicit currency: a money component names its currency; a statistical one its currency or its unit
    if (!statistical && !out.currencyUomId) denied("CURRENCY_REQUIRED", "Choose the component's currency")
    if (!statistical && out.quantityUomId) denied("UNIT_INVALID", "A money component is in its currency, not a unit")
    if (statistical && !out.currencyUomId && !out.quantityUomId)
        denied("UNIT_REQUIRED", "Choose the statistical value's currency or unit")
    if (out.amount != null && out.currencyUomId && !out.amount.eq(ec.l10n.roundCurrency(out.amount, out.currencyUomId)))
        denied("CURRENCY_PRECISION", "The amount exceeds the currency's precision")
    // the rounding stage: places and a direction together, or neither
    const places = blank(term.roundingPlaces) ? null : Number(term.roundingPlaces)
    const roundingEnumId = text(term.roundingEnumId) || null
    if (places != null && (!Number.isInteger(places) || places < 0 || places > 10))
        denied("ROUNDING_INVALID", "Round to between 0 and 10 places")
    if ((places == null) !== (roundingEnumId == null))
        denied("ROUNDING_INVALID", "A rounding stage has both its places and its direction")
    if (roundingEnumId && !roundings[roundingEnumId]) denied("ROUNDING_INVALID", roundingEnumId + " is not a rounding")
    out.roundingPlaces = places
    out.roundingEnumId = roundingEnumId
    out.payslipVisible = blank(term.payslipVisible) ? (statistical ? "N" : "Y") : flag(term.payslipVisible) ? "Y" : "N"
    // the account mapping the kind takes: an expense account for an earning or contribution, a liability account for a
    // deduction or contribution, none for a statistical value (it posts nothing)
    out.expenseGlAccountId = text(term.expenseGlAccountId) || null
    out.liabilityGlAccountId = text(term.liabilityGlAccountId) || null
    if (statistical && (out.expenseGlAccountId || out.liabilityGlAccountId))
        denied("STATISTICAL_NO_POSTING", "A statistical component posts nothing and maps no account")
    if (kind === "PckEarning" && out.liabilityGlAccountId) denied("ACCOUNT_NOT_FOR_KIND", "An earning maps an expense account")
    if (kind === "PckDeduction" && out.expenseGlAccountId) denied("ACCOUNT_NOT_FOR_KIND", "A deduction maps a liability account")
    for (const glAccountId of [out.expenseGlAccountId, out.liabilityGlAccountId].filter(Boolean))
        if (
            !one("mantle.ledger.account.GlAccountOrganization", {glAccountId, organizationPartyId: component.organizationPartyId})
        )
            denied("ACCOUNT_INVALID", "Account " + glAccountId + " is not one of the employer's")
    const fromMs = when(term.fromDate)
    const thruMs = when(term.thruDate)
    if (fromMs == null) denied("DATES_INVALID", "A term starts on a date")
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A term ends after it starts")
    out.fromDate = new Date(fromMs)
    out.thruDate = thruMs == null ? null : new Date(thruMs)
    return out
}

// ===== store#ComponentExample =====
// A named example of a draft term (the draft when no term is named): added, changed or removed. Its values are the names the
// formula reads; its expected amount is what the term must give.
function storeComponentExample(p) {
    const userScope = editorScope()
    const component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
    checkRevision(p.expectedRevision, componentRevision(component.payrollComponentId), "pay component")
    const term = text(p.payrollComponentTermId)
        ? one(TERM, {payrollComponentTermId: text(p.payrollComponentTermId)})
        : draftTerm(component.payrollComponentId)
    if (!term || term.payrollComponentId !== component.payrollComponentId)
        denied("NO_DRAFT", "This component has no draft term to give examples")
    if (term.statusId !== "PtsDraft") denied("TERM_PUBLISHED", "A published term's examples are kept as they were")
    let example = null
    if (text(p.payrollComponentExampleId)) {
        example = one(EXAMPLE, {payrollComponentExampleId: text(p.payrollComponentExampleId)})
        if (!example || example.payrollComponentTermId !== term.payrollComponentTermId)
            denied("RECORD_UNAVAILABLE", "That example is not this term's")
        if (flag(p.remove)) {
            call("delete#" + EXAMPLE, {payrollComponentExampleId: example.payrollComponentExampleId})
            exampleChanged(term)
            return {payrollComponentExampleId: null, revision: componentRevision(component.payrollComponentId)}
        }
    }
    const exampleName = given(p.exampleName) ? text(p.exampleName) : example?.exampleName || ""
    if (!exampleName) denied("NAME_REQUIRED", "An example has a name")
    const inputValues = given(p.inputValues) ? valuesOf(p.inputValues, "example's values") : storedValues(example?.inputValues)
    const expectedAmount = given(p.expectedAmount)
        ? decimalOf(p.expectedAmount, "AMOUNT_INVALID", "expected amount")
        : (example?.expectedAmount ?? null)
    if (expectedAmount == null) denied("AMOUNT_REQUIRED", "Enter the amount the example should give")
    const fields = {exampleName, inputValues: JSON.stringify(inputValues), expectedAmount}
    let payrollComponentExampleId
    if (example) {
        call("update#" + EXAMPLE, Object.assign({payrollComponentExampleId: example.payrollComponentExampleId}, fields))
        payrollComponentExampleId = example.payrollComponentExampleId
    } else
        payrollComponentExampleId = call(
            "create#" + EXAMPLE,
            Object.assign({payrollComponentTermId: term.payrollComponentTermId}, fields)
        ).payrollComponentExampleId
    exampleChanged(term)
    return {payrollComponentExampleId, revision: componentRevision(component.payrollComponentId)}
}
// An example changed is the draft changed: its drafter recorded, the request waiting to publish it superseded
function exampleChanged(term) {
    call("update#" + TERM, {
        payrollComponentTermId: term.payrollComponentTermId,
        draftedByUserIds: withDrafter(term.draftedByUserIds)
    })
    approvals().sourceChanged(KIND, term.payrollComponentTermId, TERM)
}

// ===== a term computed =====
// A term's amount for the values given: the fixed amount, or the formula through the evaluator, then its rounding stage. A
// refusal (a missing input, a division by zero) is answered with its code, never thrown.
function computeTerm(term, values) {
    let raw
    let explanation
    if (term.basisEnumId === "PcbAmount") {
        raw = toDecimal(term.amount)
        explanation = "Fixed amount " + String(raw)
    } else {
        const out = evaluate(term.formula, values)
        if (!out.valid)
            return {
                ok: false,
                errorCode: out.errorCode,
                message: out.errorMessage,
                missingNames: Array.from(out.missingNames || [])
            }
        raw = out.result
        const used = Array.from(out.names || []).filter(name => values[name] != null)
        explanation = term.formula + (used.length ? " with " + used.map(name => name + " = " + values[name]).join(", ") : "")
        explanation += " = " + String(raw)
    }
    let amount = raw
    if (term.roundingPlaces != null && term.roundingEnumId) {
        amount = rounded(raw, term.roundingPlaces, term.roundingEnumId)
        if (!amount.eq(raw)) explanation += ", " + roundingText(term).toLowerCase() + ": " + String(amount)
    }
    return {ok: true, amount, explanation, errorCode: null, message: null, missingNames: []}
}
function runExample(term, example) {
    const values = storedValues(example.inputValues)
    const result = computeTerm(term, values)
    const row = Object.assign(exampleRow(example), {
        actualAmount: result.ok ? result.amount : null,
        explanation: result.ok ? result.explanation : result.message,
        errorCode: result.errorCode,
        missingNames: result.missingNames
    })
    row.matches = result.ok && example.expectedAmount != null && result.amount.compare(toDecimal(example.expectedAmount)) === 0
    row.state = !result.ok ? "error" : row.matches ? "passed" : "failed"
    row.stateText = !result.ok
        ? result.errorCode === "MISSING_INPUT"
            ? "Missing " + result.missingNames.join(", ")
            : "Error"
        : row.matches
          ? "Passed"
          : "Gives " + String(result.amount)
    return row
}
// the term a preview or publish works on: the one named, else the draft, else the one in effect
function workingTerm(component, payrollComponentTermId, at) {
    const term = text(payrollComponentTermId)
        ? one(TERM, {payrollComponentTermId: text(payrollComponentTermId)})
        : draftTerm(component.payrollComponentId) || termAt(component.payrollComponentId, at)
    if (!term || term.payrollComponentId !== component.payrollComponentId)
        denied("NO_TERM", "This component has no term to preview")
    return term
}

// ===== preview#Component =====
// Each example of the term computed beside its expected amount, and, with inputValues, the amount those values give; a
// statistical component is shown with no total it enters. Reads and computes only.
function previewComponent(p) {
    const userScope = readerScope()
    const component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
    const term = workingTerm(component, p.payrollComponentTermId, nowMs())
    const examples = rows(EXAMPLE, {payrollComponentTermId: term.payrollComponentTermId})
        .sort((a, b) => String(a.payrollComponentExampleId).localeCompare(String(b.payrollComponentExampleId)))
        .map(example => runExample(term, example))
    const out = {
        payrollComponentTermId: term.payrollComponentTermId,
        examples,
        allPassed: examples.length > 0 && examples.every(row => row.matches),
        inTotals: component.componentKindEnumId !== "PckStatistical",
        totalsText:
            component.componentKindEnumId === "PckStatistical"
                ? "A statistical value: shown, entering no gross, net or employer cost, and posting nothing"
                : kinds[component.componentKindEnumId] + ": enters the " + totalWord(component.componentKindEnumId),
        sample: null
    }
    if (given(p.inputValues) && p.inputValues !== "") {
        const values = valuesOf(p.inputValues, "values")
        const result = computeTerm(term, values)
        out.sample = {
            ok: result.ok,
            amount: result.ok ? result.amount : null,
            explanation: result.ok ? result.explanation : result.message,
            errorCode: result.errorCode,
            missingNames: result.missingNames
        }
    }
    return out
}
const totalWord = kind =>
    ({PckEarning: "gross and net", PckDeduction: "deductions and net", PckContribution: "employer cost"})[kind] || ""

// ===== dependencies =====
// The dependency graph of an employer's components at a date: each code's dependencies, from the term given for a code (a
// draft being published, a structure's working terms), else its published term in effect; a code with no such term is
// missing. Answers the codes missing and the first cycle through a code, if any.
function dependencyCheck(organizationPartyId, startCode, at, termsByCode) {
    const graph = {}
    const missing = []
    const termFor = code => {
        if (Object.hasOwn(termsByCode, code)) return termsByCode[code]
        const component = one(COMPONENT, {organizationPartyId, componentCode: code})
        if (!component || (ms(component.thruDate) ?? Infinity) <= at) return null
        return termAt(component.payrollComponentId, at)
    }
    const visit = (code, path) => {
        if (path.includes(code)) return path.slice(path.indexOf(code)).concat(code)
        if (!Object.hasOwn(graph, code)) {
            const term = termFor(code)
            if (!term) {
                missing.push(code)
                graph[code] = []
                return null
            }
            graph[code] = splitNames(term.dependencyCodes)
        }
        for (const dependency of graph[code]) {
            const cycle = visit(dependency, path.concat(code))
            if (cycle) return cycle
        }
        return null
    }
    const cycle = visit(startCode, [])
    return {missing: people.unique(missing.filter(code => code !== startCode)), cycle}
}

// ===== publish#Component =====
// The dates at which an employer's published configuration changes from fromMs (exclusive) until thruMs: each published term's
// start and end and each component's end. The dependency rules are checked at fromMs and at each of these, so a dependency that
// ends later, or a term of a dependency that starts later and reads this component, is found now (P22 review).
function changePoints(organizationPartyId, fromMs, thruMs) {
    const components = rows(COMPONENT, {organizationPartyId})
    const points = new Set()
    const add = millis => {
        if (millis != null && millis > fromMs && (thruMs == null || millis < thruMs)) points.add(millis)
    }
    for (const component of components) add(ms(component.thruDate))
    const ids = components.map(component => component.payrollComponentId)
    if (ids.length)
        for (const term of Array.from(
            find(TERM).condition("payrollComponentId", "in", ids).condition("statusId", "PtsPublished").list()
        )) {
            add(ms(term.fromDate))
            add(ms(term.thruDate))
        }
    return Array.from(points).sort((a, b) => a - b)
}
// A draft term checked as it would be published from fromMs: refused without examples, with an example not giving its amount,
// without the account mapping its kind takes, with a dependency missing or in a cycle on that date or on any later date the
// employer's configuration changes before the term ends, with a published term of the component starting on or after the date
// (TERMS_OVERLAP), or ending the term in effect then in the past (EFFECTIVE_DATE_PAST). Answers the published terms.
function componentPublication(component, term, fromMs) {
    const thruMs = ms(term.thruDate)
    if (thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A term ends after it starts")
    // the term as it will be published, checked whole again
    checkTerm(component, Object.assign(lib.map(term), {fromDate: new Date(fromMs)}))
    const examples = rows(EXAMPLE, {payrollComponentTermId: term.payrollComponentTermId}).map(example =>
        runExample(term, example)
    )
    if (!examples.length) denied("EXAMPLES_REQUIRED", "Add an example that shows what the term gives before publishing it")
    const failed = examples.filter(row => !row.matches)
    if (failed.length)
        denied(
            "EXAMPLE_FAILED",
            failed
                .map(row =>
                    row.state === "error"
                        ? row.exampleName + ": " + row.explanation
                        : row.exampleName + " gives " + String(row.actualAmount) + ", not " + String(row.expectedAmount)
                )
                .join("; ")
        )
    for (const at of [fromMs].concat(changePoints(component.organizationPartyId, fromMs, thruMs))) {
        const checked = dependencyCheck(component.organizationPartyId, component.componentCode, at, {
            [component.componentCode]: term
        })
        const onDate = at === fromMs ? "" : " from " + dateText(stamp(at))
        if (checked.cycle)
            denied("CYCLIC_DEPENDENCY", "The components depend on each other" + onDate + ": " + checked.cycle.join(" → "))
        if (checked.missing.length)
            denied(
                "MISSING_DEPENDENCY",
                "The formula reads " +
                    checked.missing.join(", ") +
                    ", with no published component of that code " +
                    (onDate ? onDate.trim() : "on that date")
            )
    }
    const kind = component.componentKindEnumId
    if ((kind === "PckEarning" || kind === "PckContribution") && !term.expenseGlAccountId)
        denied("MAPPING_REQUIRED", "Map the expense account the component posts to")
    if ((kind === "PckDeduction" || kind === "PckContribution") && !term.liabilityGlAccountId)
        denied("MAPPING_REQUIRED", "Map the liability account the component posts to")
    // published intervals do not overlap: one starting on or after the date refuses it; the one in effect then ends there
    const published = publishedTerms(component.payrollComponentId)
    if (published.some(row => (ms(row.fromDate) ?? -Infinity) >= fromMs || (thruMs != null && openAt(row, thruMs - 1))))
        denied("TERMS_OVERLAP", "A published term of this component starts on or after that date; choose a later date")
    if (fromMs < nowMs() - day && published.some(row => openAt(row, fromMs)))
        denied("EFFECTIVE_DATE_PAST", "A published term is not ended in the past; publish from today on")
    return published
}
// The draft term asked to be published from its date (or the date given), with a reason, at the revision read: checked as it
// would be published (componentPublication), its date set, and a People approval of kind PakPayrollConfig asked for it; it is
// published when that is approved (decide#Publication). Refused without a reason, for an ended component or with no draft, and
// while a request for the draft as it is waits (APPROVAL_PENDING).
function publishComponent(p) {
    const userScope = editorScope()
    const component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
    checkRevision(p.expectedRevision, componentRevision(component.payrollComponentId), "pay component")
    if ((ms(component.thruDate) ?? Infinity) <= nowMs()) denied("COMPONENT_ENDED", "This component has ended")
    let term = text(p.payrollComponentTermId)
        ? one(TERM, {payrollComponentTermId: text(p.payrollComponentTermId)})
        : draftTerm(component.payrollComponentId)
    if (!term || term.payrollComponentId !== component.payrollComponentId)
        denied("NO_DRAFT", "This component has no draft term to publish")
    if (term.statusId !== "PtsDraft") denied("TERM_PUBLISHED", "This term is published already")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for publishing")
    const fromMs = when(p.fromDate) ?? ms(term.fromDate) ?? nowMs()
    componentPublication(component, term, fromMs)
    if (ms(term.fromDate) !== fromMs) {
        call("update#" + TERM, {payrollComponentTermId: term.payrollComponentTermId, fromDate: new Date(fromMs)})
        term = one(TERM, {payrollComponentTermId: term.payrollComponentTermId})
    }
    const approval = approvals().request({
        approvalKindEnumId: KIND,
        sourceEntityName: TERM,
        sourceId: term.payrollComponentTermId,
        organizationPartyId: component.organizationPartyId,
        effectiveDate: new Date(fromMs),
        justification: reason,
        operationKey: text(p.operationKey) || null
    })
    return {
        payrollComponentTermId: term.payrollComponentTermId,
        revision: componentRevision(component.payrollComponentId),
        peopleApprovalId: approval.peopleApprovalId,
        approvalStatusId: approval.statusId,
        published: false
    }
}
// The approved term published: from its date, or from now when that date has passed and a published term is in effect then (the
// past stays as it was), checked again; the term in effect then ends there; the publisher, the approval's reason and time kept.
function applyComponentPublication(component, term, approval) {
    let fromMs = ms(term.fromDate) ?? nowMs()
    const now = nowMs()
    if (fromMs < now - day && publishedTerms(component.payrollComponentId).some(row => openAt(row, fromMs))) fromMs = now
    const published = componentPublication(component, term, fromMs)
    const reason = approval.justification || "Approved"
    for (const row of published.filter(row => openAt(row, fromMs)))
        call("update#" + TERM, {
            payrollComponentTermId: row.payrollComponentTermId,
            thruDate: new Date(fromMs),
            thruDate_changeReason: reason
        })
    call("update#" + TERM, {
        payrollComponentTermId: term.payrollComponentTermId,
        fromDate: new Date(fromMs),
        statusId: "PtsPublished",
        statusId_changeReason: reason,
        publishedDate: ec.user.nowTimestamp,
        publishedByUserId: approval.requestedByUserId || null
    })
}

// ===== decide#Publication =====
// A decision of a waiting request to publish a component's draft term (payrollComponentId) or a structure's draft lines
// (payrollStructureId), by an approver of its step who reads the employer's payroll configuration: approve, or refuse with a
// reason (PeopleApprovalServices.record#Decision: never one who drafted it or asked, at the revision asked). The last approval
// publishes the draft, checked again (a check failing then refuses the decision, which is not recorded); a refusal leaves the
// draft as it is. The topic's approve#Publication and refuse#Publication decide a notice the same way.
function decidePublication(p) {
    const userScope = readerScope()
    const decision = text(p.decision) || "approve"
    let source
    if (text(p.payrollStructureId)) {
        const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
        source = {entityName: STRUCTURE, sourceId: structure.payrollStructureId, structure}
    } else {
        const component = readable(userScope, COMPONENT, "payrollComponentId", text(p.payrollComponentId), "Pay component")
        const term = text(p.payrollComponentTermId)
            ? one(TERM, {payrollComponentTermId: text(p.payrollComponentTermId)})
            : draftTerm(component.payrollComponentId)
        if (!term || term.payrollComponentId !== component.payrollComponentId)
            denied("NO_DRAFT", "This component has no draft term waiting to be published")
        source = {entityName: TERM, sourceId: term.payrollComponentTermId, component, term}
    }
    const decided = call("mantle.humanres.PeopleApprovalServices.record#Decision", {
        approvalKindEnumId: KIND,
        sourceEntityName: source.entityName,
        peopleApprovalId: text(p.peopleApprovalId) || null,
        sourceId: source.sourceId,
        decision,
        reason: text(p.reason) || null,
        sourceRevision: text(p.sourceRevision) || null,
        operationKey: text(p.operationKey) || null
    })
    if (decided.complete && !decided.repeated) {
        const approval = one("mantle.humanres.approval.PeopleApproval", {peopleApprovalId: decided.peopleApprovalId})
        if (source.entityName === STRUCTURE) applyStructurePublication(source.structure, approval)
        else {
            if (source.term.statusId !== "PtsDraft") denied("TERM_PUBLISHED", "This term is published already")
            applyComponentPublication(source.component, source.term, approval)
        }
    }
    return {
        peopleApprovalId: decided.peopleApprovalId,
        statusId: decided.statusId,
        published: !!decided.complete,
        repeated: !!decided.repeated
    }
}
// The PeoplePayrollConfigApproval topic's services: the notice's term or structure at the revision in its message.
function decideNotice(p, decision) {
    const message = p.message || {}
    const recordId = text(p.recordId)
    const base = {
        decision,
        reason: p.reason,
        peopleApprovalId: message.peopleApprovalId,
        sourceRevision: message.sourceRevision
    }
    if (p.recordEntityName === STRUCTURE) return decidePublication(Object.assign(base, {payrollStructureId: recordId}))
    if (p.recordEntityName && p.recordEntityName !== TERM) denied("SOURCE_INVALID", "Not a payroll configuration approval")
    const term = one(TERM, {payrollComponentTermId: recordId})
    if (!term) denied("RECORD_UNAVAILABLE", "This pay component term is not available")
    return decidePublication(
        Object.assign(base, {payrollComponentId: term.payrollComponentId, payrollComponentTermId: term.payrollComponentTermId})
    )
}
// The approval of a draft as its record shows it (Approvals.js sourceSummary): state, requester, steps, decisions and whether
// the caller decides it; null with none.
function approvalOf(entityName, sourceId) {
    try {
        return sourceId ? approvals().sourceSummary(KIND, sourceId, entityName) : null
    } catch (error) {
        ec.logger.error("The approval of " + entityName + " " + sourceId + " could not be read: " + error.message)
        return null
    }
}
// The drafts among sourceIds with a request waiting to publish them
function waitingIds(entityName, sourceIds) {
    if (!sourceIds.length) return new Set()
    return new Set(
        Array.from(
            find("mantle.humanres.approval.PeopleApproval")
                .condition({approvalKindEnumId: KIND, sourceEntityName: entityName, statusId: "PapPending"})
                .condition("sourceId", "in", sourceIds)
                .selectField("sourceId")
                .list()
        ).map(row => row.sourceId)
    )
}

// ===== structures =====
function structureRevision(payrollStructureId) {
    return revisionOf([one(STRUCTURE, {payrollStructureId})].concat(rows(LINE, {payrollStructureId})))
}
function structureState(structure, at, waiting) {
    if ((ms(structure.thruDate) ?? Infinity) <= at) return {state: "ended", stateText: "Ended"}
    if (waiting?.has(structure.payrollStructureId)) return {state: "waiting", stateText: "Waiting for approval"}
    if (structure.statusId !== "PtsPublished") return {state: "draft", stateText: "Draft"}
    if ((ms(structure.fromDate) ?? -Infinity) > at) return {state: "future", stateText: "From " + dateText(structure.fromDate)}
    return {state: "current", stateText: "Published"}
}
// a line in effect at a date: a published line by its dates, a draft from its date (or always, with none)
const lineAt = (line, at) =>
    line.statusId === "PtsPublished"
        ? openAt(line, at)
        : (ms(line.fromDate) ?? -Infinity) <= at && (ms(line.thruDate) ?? Infinity) > at
// P23: the pay assignments in effect on the date of each structure ({payrollStructureId: count}), in one query
function assignmentCounts(payrollStructureIds, at) {
    const counts = {}
    if (!payrollStructureIds.length) return counts
    const query = find("mantle.humanres.payroll.PayrollAssignment")
        .condition("payrollStructureId", "in", payrollStructureIds)
        .conditionDate("fromDate", "thruDate", stamp(at))
        .selectField(["payrollAssignmentId", "payrollStructureId"])
    for (const row of Array.from(query.list())) counts[row.payrollStructureId] = (counts[row.payrollStructureId] || 0) + 1
    return counts
}
function structureRow(structure, at, userScope, names, lines, waiting, counts) {
    return Object.assign(
        {
            payrollStructureId: structure.payrollStructureId,
            structureName: structure.structureName || structure.payrollStructureId,
            organizationPartyId: structure.organizationPartyId,
            organizationName:
                (names || people.organizationNames([structure.organizationPartyId]))[structure.organizationPartyId] || "",
            currencyUomId: structure.currencyUomId,
            payBasisEnumId: structure.payBasisEnumId || null,
            payBasisText: payBases[structure.payBasisEnumId] || "",
            description: structure.description || "",
            fromDateText: dateText(structure.fromDate),
            thruDateText: dateText(structure.thruDate),
            publishedDateText: dateText(structure.publishedDate),
            publishedByName: userName(structure.publishedByUserId),
            componentCount: (lines || []).filter(line => lineAt(line, at)).length,
            draftCount: (lines || []).filter(line => line.statusId !== "PtsPublished").length,
            assignmentCount: (counts || assignmentCounts([structure.payrollStructureId], at))[structure.payrollStructureId] || 0,
            waitingApproval: !!waiting?.has(structure.payrollStructureId),
            canEdit: edits(userScope) && (ms(structure.thruDate) ?? Infinity) > nowMs()
        },
        structureState(structure, at, waiting)
    )
}
function lineRow(line, component, at) {
    const values = storedValues(line.parameterValues)
    const term = component ? termAt(component.payrollComponentId, Math.max(at, ms(line.fromDate) ?? at)) : null
    const draft = component ? draftTerm(component.payrollComponentId) : null
    const state =
        line.statusId !== "PtsPublished"
            ? {state: "draft", stateText: "Draft"}
            : (ms(line.thruDate) ?? Infinity) <= at
              ? {state: "ended", stateText: "Ended"}
              : (ms(line.fromDate) ?? -Infinity) > at
                ? {state: "future", stateText: "From " + dateText(line.fromDate)}
                : {state: "current", stateText: "In effect"}
    return Object.assign(
        {
            payrollStructureComponentId: line.payrollStructureComponentId,
            payrollComponentId: line.payrollComponentId,
            componentCode: component?.componentCode || "",
            componentName: component?.componentName || "",
            componentKindEnumId: component?.componentKindEnumId || null,
            kindText: kinds[component?.componentKindEnumId] || "",
            fromDateText: dateText(line.fromDate),
            thruDateText: dateText(line.thruDate),
            sequenceNum: line.sequenceNum ?? null,
            eligibilityEnumId: line.eligibilityEnumId || "PleAll",
            eligibilityText: eligibilities[line.eligibilityEnumId || "PleAll"],
            parameterValues: values,
            parameterValuesText: valuesText(values),
            termText: term ? calculationText(term) : draft ? calculationText(draft) + " (draft)" : "",
            termState: term ? "published" : draft ? "draft" : "none",
            termStateText: term ? "Published" : draft ? "Draft only" : "No terms",
            dependencyText: listText(splitNames((term || draft)?.dependencyCodes))
        },
        state
    )
}

// ===== find#Structures =====
// The structures of the employers the caller reads (or the one asked for), searched by name ignoring case, in a state, paged:
// each its employer, currency, pay basis, state, dates and the count of its components on asOfDate; with payrollStructureId,
// its lines (payslip order) and the calculation order and findings of its components on that date.
function findStructures(p) {
    const userScope = readerScope()
    const at = people.asOfMillis(p.asOfDate)
    const out = {
        asOfDate: at,
        canEdit: edits(userScope),
        structures: [],
        structure: null,
        lines: [],
        calculationOrder: [],
        findings: []
    }
    if (text(p.payrollStructureId)) {
        const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
        const lines = Array.from(
            find(LINE, {payrollStructureId: structure.payrollStructureId}).orderBy(["sequenceNum", "fromDate"]).list()
        )
        const components = componentsById(lines.map(line => line.payrollComponentId))
        const waiting = waitingIds(STRUCTURE, [structure.payrollStructureId])
        out.structure = Object.assign(structureRow(structure, at, userScope, null, lines, waiting), {
            revision: structureRevision(structure.payrollStructureId),
            // the latest request to publish its draft lines (its steps, decisions and whether the caller decides it)
            approval: approvalOf(STRUCTURE, structure.payrollStructureId)
        })
        out.lines = lines.map(line => lineRow(line, components[line.payrollComponentId], at))
        const working = workingLines(structure, lines, components, at)
        const ordered = calculationOrder(working)
        out.calculationOrder = ordered.order
        out.findings = ordered.findings
        out.structures = [out.structure]
        out.structuresCount = 1
        return out
    }
    const organizationPartyIds = text(p.organizationPartyId)
        ? (people.requireOrganization(userScope, text(p.organizationPartyId)), [text(p.organizationPartyId)])
        : userScope.organizationPartyIds
    if (!organizationPartyIds.length) return Object.assign(out, lib.pageList([], p, "structures"))
    let query = find(STRUCTURE).condition("organizationPartyId", "in", organizationPartyIds)
    if (text(p.term))
        query = query.condition(
            ec.entity.conditionFactory.makeCondition("structureName", "like", likeText(text(p.term))).ignoreCase()
        )
    const structures = Array.from(query.orderBy("^structureName").limit(listCap).list())
    const linesOf = {}
    if (structures.length)
        for (const line of Array.from(
            find(LINE)
                .condition(
                    "payrollStructureId",
                    "in",
                    structures.map(row => row.payrollStructureId)
                )
                .list()
        ))
            (linesOf[line.payrollStructureId] = linesOf[line.payrollStructureId] || []).push(line)
    const names = people.organizationNames(people.unique(structures.map(row => row.organizationPartyId)))
    const waiting = waitingIds(
        STRUCTURE,
        structures.map(row => row.payrollStructureId)
    )
    const counts = assignmentCounts(
        structures.map(row => row.payrollStructureId),
        at
    )
    let list = structures.map(row =>
        structureRow(row, at, userScope, names, linesOf[row.payrollStructureId] || [], waiting, counts)
    )
    if (text(p.state)) list = list.filter(row => row.state === text(p.state))
    else list = list.filter(row => row.state !== "ended")
    return Object.assign(out, lib.pageList(list, p, "structures", {noLimitCap: listCap}))
}
function componentsById(payrollComponentIds) {
    const ids = people.unique(payrollComponentIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find(COMPONENT).condition("payrollComponentId", "in", ids).list()).map(row => [row.payrollComponentId, row])
    )
}
// The lines of a structure in effect at a date, each with its component and the term it calculates with: the published term in
// effect then, else (for a preview before publishing) the component's draft.
function workingLines(structure, lines, components, at) {
    return lines
        .filter(line => lineAt(line, at))
        .map(line => {
            const component = components[line.payrollComponentId]
            const published = component ? termAt(component.payrollComponentId, at) : null
            const term = published || (component ? draftTerm(component.payrollComponentId) : null)
            return {line, component, term, draftTerm: !published && !!term}
        })
}
// The calculation order of working lines by their dependencies (a dependency first; ties in payslip order), and the findings
// that block a component: a dependency on a code not in the structure (MISSING_DEPENDENCY), a cycle (CYCLIC_DEPENDENCY), no
// term (NO_TERM).
function calculationOrder(working) {
    const byCode = {}
    for (const item of working) if (item.component) byCode[item.component.componentCode] = item
    const findings = []
    const blocked = {}
    for (const item of working) {
        if (!item.component) continue
        const code = item.component.componentCode
        if (!item.term) {
            blocked[code] = "NO_TERM"
            findings.push({code: "NO_TERM", componentCode: code, blocking: true, message: code + " has no terms"})
            continue
        }
        const missing = splitNames(item.term.dependencyCodes).filter(dependency => !byCode[dependency])
        if (missing.length) {
            blocked[code] = "MISSING_DEPENDENCY"
            findings.push({
                code: "MISSING_DEPENDENCY",
                componentCode: code,
                blocking: true,
                message: code + " reads " + missing.join(", ") + ", which the structure does not have"
            })
        }
    }
    // Kahn's order: a component once every component it reads is placed, the earliest in payslip order first; what is left is in
    // a cycle or reads one, and is blocked
    const payslipOrder = (a, b) =>
        (Number(byCode[a].line.sequenceNum) || 0) - (Number(byCode[b].line.sequenceNum) || 0) || a.localeCompare(b)
    const readsOf = code => splitNames(byCode[code]?.term?.dependencyCodes).filter(dependency => byCode[dependency])
    const order = []
    const placed = new Set()
    let ready = Object.keys(byCode).filter(code => !readsOf(code).length)
    while (ready.length) {
        ready.sort(payslipOrder)
        const code = ready.shift()
        order.push(code)
        placed.add(code)
        for (const next of Object.keys(byCode))
            if (!placed.has(next) && !ready.includes(next) && readsOf(next).every(dependency => placed.has(dependency)))
                ready.push(next)
    }
    const inCycle = Object.keys(byCode)
        .filter(code => !placed.has(code))
        .sort(payslipOrder)
    if (inCycle.length) {
        for (const code of inCycle) {
            blocked[code] = blocked[code] || "CYCLIC_DEPENDENCY"
            order.push(code)
        }
        findings.push({
            code: "CYCLIC_DEPENDENCY",
            componentCode: inCycle[0],
            blocking: true,
            message: "These components depend on each other, or on such a pair: " + inCycle.join(", ")
        })
    }
    return {order, findings, blocked, byCode}
}

// ===== store#Structure =====
// A new structure (employer, name, currency: required, never assumed, pay basis), a copy of one (a new structure with the
// source's lines as drafts and no assignments), or a structure's new name, basis or description, or its end, at the revision
// read. A published structure keeps its currency.
function storeStructure(p) {
    const userScope = editorScope()
    if (!text(p.payrollStructureId)) {
        let source = null
        if (text(p.copyFromStructureId))
            source = readable(userScope, STRUCTURE, "payrollStructureId", text(p.copyFromStructureId), "Pay structure")
        const organizationPartyId = text(p.organizationPartyId) || source?.organizationPartyId || ""
        requireEmployer(userScope, organizationPartyId)
        if (source && source.organizationPartyId !== organizationPartyId)
            denied("EMPLOYER_CHANGE", "A copy stays with the employer of the structure it copies")
        const structureName = text(p.structureName)
        if (!structureName) denied("NAME_REQUIRED", "A structure has a name")
        const currencyUomId = text(p.currencyUomId) || source?.currencyUomId || ""
        if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the structure's currency")
        currencyOf(currencyUomId)
        const payBasisEnumId = text(p.payBasisEnumId) || source?.payBasisEnumId || ""
        if (!payBases[payBasisEnumId]) denied("BASIS_INVALID", "Choose the pay basis")
        const created = call("create#" + STRUCTURE, {
            organizationPartyId,
            structureName,
            currencyUomId,
            payBasisEnumId,
            description: text(p.description) || source?.description || null,
            statusId: "PtsDraft",
            copiedFromStructureId: source?.payrollStructureId || null,
            createdDate: ec.user.nowTimestamp,
            draftedByUserIds: withDrafter(null)
        })
        if (source) {
            const now = nowMs()
            for (const line of rows(LINE, {payrollStructureId: source.payrollStructureId}).filter(
                line => (ms(line.thruDate) ?? Infinity) > now
            ))
                call("create#" + LINE, {
                    payrollStructureId: created.payrollStructureId,
                    payrollComponentId: line.payrollComponentId,
                    sequenceNum: line.sequenceNum,
                    parameterValues: line.parameterValues,
                    eligibilityEnumId: line.eligibilityEnumId || null,
                    statusId: "PtsDraft"
                })
        }
        return {payrollStructureId: created.payrollStructureId, revision: structureRevision(created.payrollStructureId)}
    }
    const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
    checkRevision(p.expectedRevision, structureRevision(structure.payrollStructureId), "pay structure")
    if ((ms(structure.thruDate) ?? Infinity) <= nowMs()) denied("STRUCTURE_ENDED", "This structure has ended")
    const changes = {payrollStructureId: structure.payrollStructureId}
    if (given(p.structureName)) {
        if (!text(p.structureName)) denied("NAME_REQUIRED", "A structure has a name")
        if (text(p.structureName) !== structure.structureName) changes.structureName = text(p.structureName)
    }
    if (text(p.currencyUomId) && text(p.currencyUomId) !== structure.currencyUomId) {
        if (structure.statusId === "PtsPublished") denied("CURRENCY_LOCKED", "A published structure keeps its currency; copy it")
        changes.currencyUomId = currencyOf(text(p.currencyUomId))
    }
    if (text(p.payBasisEnumId) && text(p.payBasisEnumId) !== structure.payBasisEnumId) {
        if (!payBases[text(p.payBasisEnumId)]) denied("BASIS_INVALID", "Choose the pay basis")
        changes.payBasisEnumId = text(p.payBasisEnumId)
    }
    if (given(p.description) && (text(p.description) || null) !== (structure.description || null))
        changes.description = text(p.description) || null
    if (flag(p.end)) {
        const endMs = when(p.thruDate) ?? nowMs()
        checkEnd(endMs)
        checkUnassigned("payrollStructureId", structure.payrollStructureId, endMs, "structure")
        changes.thruDate = new Date(endMs)
        if (text(p.reason)) changes.thruDate_changeReason = text(p.reason)
    }
    if (Object.keys(changes).length > 1) {
        changes.draftedByUserIds = withDrafter(structure.draftedByUserIds)
        call("update#" + STRUCTURE, changes)
        // a changed structure supersedes the request waiting to publish it; an ended one publishes nothing
        approvals().sourceChanged(KIND, structure.payrollStructureId, STRUCTURE, flag(p.end))
    }
    return {payrollStructureId: structure.payrollStructureId, revision: structureRevision(structure.payrollStructureId)}
}
// A structure's line changed is its draft changed: its drafter recorded, the request waiting to publish it superseded
function structureChanged(structure) {
    call("update#" + STRUCTURE, {
        payrollStructureId: structure.payrollStructureId,
        draftedByUserIds: withDrafter(structure.draftedByUserIds)
    })
    approvals().sourceChanged(KIND, structure.payrollStructureId, STRUCTURE)
}

// ===== store#StructureComponent =====
// A component added to a structure as a draft line (one of the employer's, not ended; one draft line of a component at a time),
// a draft line's dates, payslip order or parameter values changed, a draft line removed, or a published line ended (its only
// change), at the structure's revision.
function storeStructureComponent(p) {
    const userScope = editorScope()
    const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
    checkRevision(p.expectedRevision, structureRevision(structure.payrollStructureId), "pay structure")
    if ((ms(structure.thruDate) ?? Infinity) <= nowMs()) denied("STRUCTURE_ENDED", "This structure has ended")
    let line = null
    if (text(p.payrollStructureComponentId)) {
        line = one(LINE, {payrollStructureComponentId: text(p.payrollStructureComponentId)})
        if (!line || line.payrollStructureId !== structure.payrollStructureId)
            denied("RECORD_UNAVAILABLE", "That line is not this structure's")
    }
    if (line && line.statusId === "PtsPublished") {
        // a published line is only ended
        if (!flag(p.end))
            denied("LINE_PUBLISHED", "A published line is only ended; add the component again from a date to change it")
        const endMs = when(p.thruDate) ?? nowMs()
        if (endMs <= (ms(line.fromDate) ?? -Infinity)) denied("DATES_INVALID", "A line ends after it starts")
        checkEnd(endMs)
        call("update#" + LINE, {
            payrollStructureComponentId: line.payrollStructureComponentId,
            thruDate: new Date(endMs),
            thruDate_changeReason: text(p.reason) || null
        })
        structureChanged(structure)
        return {
            payrollStructureComponentId: line.payrollStructureComponentId,
            revision: structureRevision(structure.payrollStructureId)
        }
    }
    if (line && flag(p.remove)) {
        call("delete#" + LINE, {payrollStructureComponentId: line.payrollStructureComponentId})
        structureChanged(structure)
        return {payrollStructureComponentId: null, revision: structureRevision(structure.payrollStructureId)}
    }
    const payrollComponentId = line ? line.payrollComponentId : text(p.payrollComponentId)
    if (!payrollComponentId) denied("COMPONENT_REQUIRED", "Choose the component")
    const component = one(COMPONENT, {payrollComponentId})
    if (
        !component ||
        component.organizationPartyId !== structure.organizationPartyId ||
        (ms(component.thruDate) ?? Infinity) <= nowMs()
    )
        denied("COMPONENT_UNAVAILABLE", "Component " + payrollComponentId + " is not one of the employer's in use")
    if (
        !line &&
        rows(LINE, {payrollStructureId: structure.payrollStructureId, payrollComponentId}).some(
            row => row.statusId !== "PtsPublished"
        )
    )
        denied("LINE_EXISTS", "The structure has a draft line of " + component.componentCode + " already")
    const fields = {}
    const fromMs = given(p.fromDate) ? when(p.fromDate) : line ? ms(line.fromDate) : null
    const thruMs = given(p.thruDate) ? when(p.thruDate) : line ? ms(line.thruDate) : null
    if (fromMs != null && thruMs != null && thruMs <= fromMs) denied("DATES_INVALID", "A line ends after it starts")
    fields.fromDate = stamp(fromMs)
    fields.thruDate = stamp(thruMs)
    if (given(p.sequenceNum) && p.sequenceNum !== "") {
        const sequenceNum = Number(p.sequenceNum)
        if (!Number.isInteger(sequenceNum) || sequenceNum < 0) denied("ORDER_INVALID", "The payslip order is a whole number")
        fields.sequenceNum = sequenceNum
    } else if (!line)
        fields.sequenceNum =
            Math.max(
                0,
                ...rows(LINE, {payrollStructureId: structure.payrollStructureId}).map(row => Number(row.sequenceNum) || 0)
            ) + 10
    if (given(p.parameterValues)) fields.parameterValues = JSON.stringify(valuesOf(p.parameterValues, "parameter values"))
    // P23: who the line applies to: every assignment, or one that elects it
    if (given(p.eligibilityEnumId)) {
        const eligibilityEnumId = text(p.eligibilityEnumId) || "PleAll"
        if (!eligibilities[eligibilityEnumId]) denied("VALUE_INVALID", "Choose who the line applies to")
        fields.eligibilityEnumId = eligibilityEnumId
    }
    if (line) {
        call("update#" + LINE, Object.assign({payrollStructureComponentId: line.payrollStructureComponentId}, fields))
        structureChanged(structure)
        return {
            payrollStructureComponentId: line.payrollStructureComponentId,
            revision: structureRevision(structure.payrollStructureId)
        }
    }
    const created = call(
        "create#" + LINE,
        Object.assign({payrollStructureId: structure.payrollStructureId, payrollComponentId, statusId: "PtsDraft"}, fields)
    )
    structureChanged(structure)
    return {
        payrollStructureComponentId: created.payrollStructureComponentId,
        revision: structureRevision(structure.payrollStructureId)
    }
}

// ===== preview#Structure =====
// A sample gross to net of the structure on a date (its draft lines and components' draft terms too, so it is seen before it is
// published): each component computed in dependency order from the sample values, the structure's parameter values and the
// results it reads, rounded by its own stage; the totals by kind (a statistical value enters none); the localization's items
// when one is chosen (or the group's), computed by its registered service; the findings that block a result; and the net
// rounded to the currency, with the difference named. With payrollGroupId, the group's periods a year are the input
// periodsPerYear and its currency must be the structure's. Reads and computes only: no record is written.
function previewStructure(p) {
    const userScope = readerScope()
    const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
    const at = people.asOfMillis(p.asOfDate)
    const findings = []
    const values = valuesOf(p.inputValues, "sample values")
    let group = null
    if (text(p.payrollGroupId)) {
        group = readable(userScope, GROUP, "payrollGroupId", text(p.payrollGroupId), "Pay group")
        if (group.organizationPartyId !== structure.organizationPartyId)
            denied("EMPLOYER_CHANGE", "The group and the structure are different employers'")
        if (group.currencyUomId !== structure.currencyUomId)
            findings.push({
                code: "CURRENCY_MISMATCH",
                blocking: true,
                message: "The group pays in " + group.currencyUomId + ", the structure is in " + structure.currencyUomId
            })
        values.periodsPerYear = String(group.periodsPerYear)
    }
    const lines = rows(LINE, {payrollStructureId: structure.payrollStructureId})
    const components = componentsById(lines.map(line => line.payrollComponentId))
    const working = workingLines(structure, lines, components, at)
    const ordered = calculationOrder(working)
    findings.push(...ordered.findings)
    const computed = {}
    const results = {}
    for (const code of ordered.order) {
        const item = ordered.byCode[code]
        const row = {
            componentCode: code,
            componentName: item.component.componentName || code,
            componentKindEnumId: item.component.componentKindEnumId,
            kindText: kinds[item.component.componentKindEnumId],
            sequenceNum: item.line.sequenceNum ?? null,
            inTotals: item.component.componentKindEnumId !== "PckStatistical",
            draftTerm: item.draftTerm,
            amount: null,
            explanation: "",
            state: "ok",
            errorCode: null
        }
        results[code] = row
        const fail = (errorCode, message) => Object.assign(row, {state: "error", errorCode, explanation: message})
        if (ordered.blocked[code]) {
            fail(ordered.blocked[code], ordered.findings.find(finding => finding.componentCode === code)?.message || "Blocked")
            continue
        }
        const term = item.term
        if (item.component.componentKindEnumId !== "PckStatistical" && term.currencyUomId !== structure.currencyUomId) {
            fail("CURRENCY_MISMATCH", code + " is in " + term.currencyUomId + ", the structure in " + structure.currencyUomId)
            findings.push({code: "CURRENCY_MISMATCH", componentCode: code, blocking: true, message: row.explanation})
            continue
        }
        const blockedBy = splitNames(term.dependencyCodes).filter(dependency => computed[dependency] == null)
        if (blockedBy.length) {
            fail("DEPENDENCY_BLOCKED", code + " reads " + blockedBy.join(", ") + ", which could not be computed")
            continue
        }
        const inputs = Object.assign({}, values, storedValues(item.line.parameterValues))
        for (const dependency of splitNames(term.dependencyCodes)) inputs[dependency] = String(computed[dependency])
        const result = computeTerm(term, inputs)
        if (!result.ok) {
            fail(
                result.errorCode,
                result.errorCode === "MISSING_INPUT" ? code + " needs " + result.missingNames.join(", ") : result.message
            )
            findings.push({code: result.errorCode, componentCode: code, blocking: true, message: row.explanation})
            continue
        }
        computed[code] = result.amount
        Object.assign(row, {amount: result.amount, explanation: result.explanation + (item.draftTerm ? " (draft term)" : "")})
    }
    const zero = toDecimal("0")
    const sum = kind =>
        Object.values(results)
            .filter(row => row.componentKindEnumId === kind && row.amount != null)
            .reduce((total, row) => total.add(row.amount), zero)
    const gross = sum("PckEarning")
    const deductions = sum("PckDeduction")
    const contributions = sum("PckContribution")
    // the localization: the one chosen, else the group's
    const payrollLocalizationId = text(p.payrollLocalizationId) || group?.payrollLocalizationId || null
    let localizationItems = []
    let localizationName = ""
    if (payrollLocalizationId) {
        const localization = one(LOCALIZATION, {payrollLocalizationId})
        if (!localization) denied("LOCALIZATION_INVALID", payrollLocalizationId + " is not a registered localization")
        localizationName = localization.localizationName || payrollLocalizationId
        const payFacts = Object.values(results)
            .filter(row => row.amount != null && row.inTotals)
            .map(row => ({componentCode: row.componentCode, componentKindEnumId: row.componentKindEnumId, amount: row.amount}))
        const out = call(localization.calculationServiceName, {
            payrollLocalizationId,
            organizationPartyId: structure.organizationPartyId,
            currencyUomId: structure.currencyUomId,
            asOfDate: stamp(at),
            payFacts
        })
        localizationItems = Array.from(out.items || []).map(item => Object.assign({}, item))
        for (const finding of Array.from(out.findings || [])) findings.push(Object.assign({}, finding))
    }
    const localSum = party =>
        localizationItems.filter(item => item.party === party).reduce((total, item) => total.add(toDecimal(item.amount)), zero)
    const net = gross.subtract(deductions).subtract(localSum("employee"))
    const employerCost = gross.add(contributions).add(localSum("employer"))
    const netPayable = ec.l10n.roundCurrency(net, structure.currencyUomId)
    if (net.compare(0) < 0)
        findings.push({code: "NEGATIVE_NET", blocking: true, message: "The net is negative: it needs a recovery, not a payment"})
    const resultList = Object.values(results).sort(
        (a, b) => (Number(a.sequenceNum) || 0) - (Number(b.sequenceNum) || 0) || a.componentCode.localeCompare(b.componentCode)
    )
    return {
        results: resultList,
        calculationOrder: ordered.order,
        localizationName,
        localizationItems,
        findings,
        complete: !findings.some(finding => finding.blocking),
        currencyUomId: structure.currencyUomId,
        totals: {
            gross,
            deductions,
            contributions,
            localizationEmployee: localSum("employee"),
            localizationEmployer: localSum("employer"),
            net,
            netPayable,
            roundingAdjustment: netPayable.subtract(net),
            employerCost
        }
    }
}

// ===== publish#Structure =====
// The structure's lines checked as they would be published with drafts starting at effectiveMs (each draft from its own date,
// else effectiveMs): refused with no draft line (once published), two lines of one component overlapping, or no line on that
// date; then on that date and on every later date a line, or a term of a line's component, starts or ends: a line's component
// without a published term then (COMPONENT_NOT_PUBLISHED), a money component in another currency, a dependency the structure
// does not have then (MISSING_DEPENDENCY), or a cycle (CYCLIC_DEPENDENCY). Answers the draft lines.
function structurePublication(structure, effectiveMs) {
    const lines = rows(LINE, {payrollStructureId: structure.payrollStructureId})
    const drafts = lines.filter(line => line.statusId !== "PtsPublished")
    if (!drafts.length && structure.statusId === "PtsPublished") denied("NO_DRAFT", "The structure has no draft line to publish")
    // the lines as they will be: each draft from its own date or the publishing date
    const planned = lines.map(line =>
        Object.assign(
            lib.map(line),
            line.statusId === "PtsPublished" ? {} : {fromDate: line.fromDate ?? new Date(effectiveMs), statusId: "PtsPublished"}
        )
    )
    const components = componentsById(lines.map(line => line.payrollComponentId))
    // two lines of one component do not overlap
    for (const line of planned)
        for (const other of planned)
            if (
                other !== line &&
                other.payrollComponentId === line.payrollComponentId &&
                other.payrollStructureComponentId > line.payrollStructureComponentId &&
                (ms(line.fromDate) ?? -Infinity) < (ms(other.thruDate) ?? Infinity) &&
                (ms(other.fromDate) ?? -Infinity) < (ms(line.thruDate) ?? Infinity)
            )
                denied(
                    "TERMS_OVERLAP",
                    (components[line.payrollComponentId]?.componentCode || "A component") + " is in the structure twice at once"
                )
    if (!planned.some(line => openAt(line, effectiveMs))) denied("LINES_REQUIRED", "The structure has no component on that date")
    // the dates to check: the publishing date, each draft's own start, and every later start or end of a line or of a term of a
    // line's component
    const points = new Set([effectiveMs])
    const add = millis => {
        if (millis != null && millis > effectiveMs) points.add(millis)
    }
    for (const line of planned) {
        if (drafts.some(draft => draft.payrollStructureComponentId === line.payrollStructureComponentId))
            points.add(ms(line.fromDate))
        add(ms(line.fromDate))
        add(ms(line.thruDate))
    }
    const componentIds = Object.keys(components)
    if (componentIds.length)
        for (const term of Array.from(
            find(TERM).condition("payrollComponentId", "in", componentIds).condition("statusId", "PtsPublished").list()
        )) {
            add(ms(term.fromDate))
            add(ms(term.thruDate))
        }
    for (const at of Array.from(points).sort((a, b) => a - b)) {
        const onDate = dateText(stamp(at))
        const working = planned
            .filter(line => openAt(line, at))
            .map(line => {
                const component = components[line.payrollComponentId]
                return {line, component, term: component ? termAt(component.payrollComponentId, at) : null}
            })
        for (const {line, component, term} of working) {
            if (!term)
                denied(
                    "COMPONENT_NOT_PUBLISHED",
                    (component?.componentCode || line.payrollComponentId) + " has no published term on " + onDate
                )
            if (component.componentKindEnumId !== "PckStatistical" && term.currencyUomId !== structure.currencyUomId)
                denied(
                    "CURRENCY_MISMATCH",
                    component.componentCode + " is in " + term.currencyUomId + ", the structure in " + structure.currencyUomId
                )
        }
        const blocking = calculationOrder(working).findings.filter(finding => finding.blocking)
        const cycle = blocking.find(finding => finding.code === "CYCLIC_DEPENDENCY")
        if (cycle) denied("CYCLIC_DEPENDENCY", cycle.message + " (on " + onDate + ")")
        const missing = blocking.find(finding => finding.code === "MISSING_DEPENDENCY" || finding.code === "NO_TERM")
        if (missing) denied("MISSING_DEPENDENCY", missing.message + " (on " + onDate + ")")
    }
    return drafts
}
// The structure's draft lines asked to be published, each from its own date or the publishing date (fromDate, now when empty),
// with a reason, at the revision read: checked as they would be published (structurePublication), and a People approval of kind
// PakPayrollConfig asked for them; they are published when that is approved (decide#Publication). Publishing reassigns no
// employee and rewrites no payslip.
function publishStructure(p) {
    const userScope = editorScope()
    const structure = readable(userScope, STRUCTURE, "payrollStructureId", text(p.payrollStructureId), "Pay structure")
    checkRevision(p.expectedRevision, structureRevision(structure.payrollStructureId), "pay structure")
    if ((ms(structure.thruDate) ?? Infinity) <= nowMs()) denied("STRUCTURE_ENDED", "This structure has ended")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for publishing")
    const effectiveMs = when(p.fromDate) ?? nowMs()
    structurePublication(structure, effectiveMs)
    const approval = approvals().request({
        approvalKindEnumId: KIND,
        sourceEntityName: STRUCTURE,
        sourceId: structure.payrollStructureId,
        organizationPartyId: structure.organizationPartyId,
        effectiveDate: new Date(effectiveMs),
        justification: reason,
        operationKey: text(p.operationKey) || null
    })
    return {
        payrollStructureId: structure.payrollStructureId,
        revision: structureRevision(structure.payrollStructureId),
        peopleApprovalId: approval.peopleApprovalId,
        approvalStatusId: approval.statusId,
        published: false
    }
}
// The approved draft lines published from the date asked (from now when that has passed), checked again; the first publish
// starts the structure; the publisher, the approval's reason and time kept, and the drafters cleared for the next draft.
function applyStructurePublication(structure, approval) {
    const now = nowMs()
    let effectiveMs = ms(approval.effectiveDate) ?? now
    if (effectiveMs < now - day) effectiveMs = now
    const drafts = structurePublication(structure, effectiveMs)
    const reason = approval.justification || "Approved"
    for (const draft of drafts)
        call("update#" + LINE, {
            payrollStructureComponentId: draft.payrollStructureComponentId,
            fromDate: draft.fromDate ?? new Date(effectiveMs),
            statusId: "PtsPublished",
            statusId_changeReason: reason
        })
    const changes = {
        payrollStructureId: structure.payrollStructureId,
        publishedDate: ec.user.nowTimestamp,
        publishedByUserId: approval.requestedByUserId || null,
        draftedByUserIds: null
    }
    if (structure.statusId !== "PtsPublished")
        Object.assign(changes, {statusId: "PtsPublished", statusId_changeReason: reason, fromDate: new Date(effectiveMs)})
    call("update#" + STRUCTURE, changes)
}

// ===== groups =====
const groupRevision = payrollGroupId => revisionOf([one(GROUP, {payrollGroupId})])
// A group's readiness: preview only in this build, and why (no localization, the synthetic one, coverage missing, or the
// payroll-origin projection still to come); liveAllowed is never true here (design §8 Release 1, §8.4).
function groupReadiness(group, localization, at) {
    const out = state => Object.assign({liveAllowed: false}, state)
    if (!localization)
        return out({
            state: "warning",
            reasonCode: "NO_LOCALIZATION",
            message: "Preview only: no localization covers this group, so its runs cannot be finalized"
        })
    if (localization.isDemonstration === "Y")
        return out({
            state: "warning",
            reasonCode: "PREVIEW_ONLY",
            message: "Preview only: the demonstration localization is synthetic and is never live"
        })
    if ((ms(localization.coverageFromDate) ?? -Infinity) > at || (ms(localization.coverageThruDate) ?? Infinity) <= at)
        return out({state: "failed", reasonCode: "COVERAGE_MISSING", message: "The localization does not cover today"})
    return out({
        state: "warning",
        reasonCode: "PROJECTION_PENDING",
        message: "Preview only: live finalization waits on Accounting's payroll-origin projection"
    })
}
function frequencyName(timePeriodTypeId) {
    const type = timePeriodTypeId ? one("mantle.party.time.TimePeriodType", {timePeriodTypeId}) : null
    return type ? String(type.description || timePeriodTypeId).replace(/^Payroll /, "") : ""
}
function groupPeriods(payrollGroupId) {
    const links = rows(GROUP_PERIOD, {payrollGroupId})
    if (!links.length) return []
    const periods = Object.fromEntries(
        Array.from(
            find("mantle.party.time.TimePeriod")
                .condition(
                    "timePeriodId",
                    "in",
                    links.map(link => link.timePeriodId)
                )
                .list()
        ).map(row => [row.timePeriodId, row])
    )
    return links
        .filter(link => periods[link.timePeriodId])
        .map(link => ({link, period: periods[link.timePeriodId]}))
        .sort((a, b) => calendarDateText(a.period.fromDate).localeCompare(calendarDateText(b.period.fromDate)))
}
const periodRow = ({link, period}) => ({
    timePeriodId: period.timePeriodId,
    periodName: period.periodName || "",
    fromDateText: calendarDateText(period.fromDate),
    thruDateText: calendarDateText(period.thruDate),
    payDateText: calendarDateText(link.payDate),
    stateText: "Open"
})
function groupRow(group, at, userScope, names, localizations) {
    const localization = group.payrollLocalizationId
        ? (localizations || {})[group.payrollLocalizationId] ||
          one(LOCALIZATION, {payrollLocalizationId: group.payrollLocalizationId})
        : null
    const offset = Number(group.payDateOffsetDays)
    return {
        payrollGroupId: group.payrollGroupId,
        groupName: group.groupName || group.payrollGroupId,
        organizationPartyId: group.organizationPartyId,
        organizationName: (names || people.organizationNames([group.organizationPartyId]))[group.organizationPartyId] || "",
        currencyUomId: group.currencyUomId,
        timePeriodTypeId: group.timePeriodTypeId,
        frequencyText: frequencyName(group.timePeriodTypeId),
        firstPeriodFromDateText: calendarDateText(group.firstPeriodFromDate),
        periodsPerYear: group.periodsPerYear ?? null,
        payDateOffsetDays: group.payDateOffsetDays ?? null,
        payDateText:
            offset === 0
                ? "On the period's last day"
                : Math.abs(offset) +
                  (Math.abs(offset) === 1 ? " day " : " days ") +
                  (offset > 0 ? "after" : "before") +
                  " the period ends",
        prorationEnumId: group.prorationEnumId,
        prorationText: prorations[group.prorationEnumId] || "",
        timeBasisEnumId: group.timeBasisEnumId,
        timeBasisText: timeBases[group.timeBasisEnumId] || "",
        workweekTimeZone: group.workweekTimeZone || "",
        payrollLocalizationId: group.payrollLocalizationId || null,
        localizationName: localization?.localizationName || "",
        description: group.description || "",
        fromDateText: dateText(group.fromDate),
        thruDateText: dateText(group.thruDate),
        ended: (ms(group.thruDate) ?? Infinity) <= at,
        liveEnabled: false,
        readiness: groupReadiness(group, localization, at),
        canEdit: edits(userScope) && (ms(group.thruDate) ?? Infinity) > nowMs(),
        revision: groupRevision(group.payrollGroupId)
    }
}

// ===== find#Groups =====
// The pay groups of the employers the caller reads (or the one asked for), by name, paged: each its currency, frequency,
// periods a year, pay-date and proration policy, time basis, localization and readiness (preview only, with why); with
// payrollGroupId, its prepared periods.
function findGroups(p) {
    const userScope = readerScope()
    const at = nowMs()
    const out = {canEdit: edits(userScope), groups: [], group: null, periods: []}
    if (text(p.payrollGroupId)) {
        const group = readable(userScope, GROUP, "payrollGroupId", text(p.payrollGroupId), "Pay group")
        out.group = groupRow(group, at, userScope)
        out.periods = groupPeriods(group.payrollGroupId).map(periodRow)
        out.groups = [out.group]
        out.groupsCount = 1
        return out
    }
    const organizationPartyIds = text(p.organizationPartyId)
        ? (people.requireOrganization(userScope, text(p.organizationPartyId)), [text(p.organizationPartyId)])
        : userScope.organizationPartyIds
    if (!organizationPartyIds.length) return Object.assign(out, lib.pageList([], p, "groups"))
    let query = find(GROUP).condition("organizationPartyId", "in", organizationPartyIds)
    if (text(p.term))
        query = query.condition(
            ec.entity.conditionFactory.makeCondition("groupName", "like", likeText(text(p.term))).ignoreCase()
        )
    const groups = Array.from(query.orderBy("^groupName").limit(listCap).list())
    const names = people.organizationNames(people.unique(groups.map(row => row.organizationPartyId)))
    const localizations = Object.fromEntries(rows(LOCALIZATION, {}).map(row => [row.payrollLocalizationId, row]))
    const list = groups
        .map(row => groupRow(row, at, userScope, names, localizations))
        .filter(row => flag(p.includeEnded) || !row.ended)
    return Object.assign(out, lib.pageList(list, p, "groups", {noLimitCap: listCap}))
}

// ===== store#Group =====
// A new pay group of an employer in scope, or a group's changes at the revision read (its policy fields audited with the reason).
// Nothing is assumed: the currency, the frequency (a Payroll month, semi-month, bi-week or week), the first period's start, the
// periods a year (the annual divisor), the pay date's place, the proration and the time basis are required. Live finalization
// is refused (LIVE_NOT_AVAILABLE): no group can be live in this build. Once periods are prepared the currency, frequency and
// first period stay.
function storeGroup(p) {
    const userScope = editorScope()
    if (flag(p.liveEnabled))
        denied(
            "LIVE_NOT_AVAILABLE",
            "A pay group is preview only: no localization covers it and the payroll-origin projection is not built"
        )
    const existing = text(p.payrollGroupId)
        ? readable(userScope, GROUP, "payrollGroupId", text(p.payrollGroupId), "Pay group")
        : null
    if (existing) {
        checkRevision(p.expectedRevision, groupRevision(existing.payrollGroupId), "pay group")
        if ((ms(existing.thruDate) ?? Infinity) <= nowMs()) denied("GROUP_ENDED", "This pay group has ended")
    }
    const pick = field => (given(p[field]) ? p[field] : existing ? existing[field] : null)
    const organizationPartyId = existing ? existing.organizationPartyId : text(p.organizationPartyId)
    if (!existing) requireEmployer(userScope, organizationPartyId)
    const groupName = text(pick("groupName"))
    if (!groupName) denied("NAME_REQUIRED", "A pay group has a name")
    const currencyUomId = text(pick("currencyUomId"))
    if (!currencyUomId) denied("CURRENCY_REQUIRED", "Choose the group's currency")
    currencyOf(currencyUomId)
    const timePeriodTypeId = text(pick("timePeriodTypeId"))
    if (!timePeriodTypeId) denied("FREQUENCY_REQUIRED", "Choose the pay frequency")
    if (!frequencies.includes(timePeriodTypeId)) denied("FREQUENCY_INVALID", timePeriodTypeId + " is not a pay frequency")
    const firstPeriodFromDate = blank(pick("firstPeriodFromDate")) ? "" : calendarDateText(pick("firstPeriodFromDate"))
    if (!firstPeriodFromDate) denied("FIRST_PERIOD_REQUIRED", "Give the first day of the first period")
    const periodsPerYear = decimalOf(pick("periodsPerYear"), "DIVISOR_INVALID", "periods a year")
    if (periodsPerYear == null) denied("DIVISOR_REQUIRED", "Give the periods a year: no divisor is assumed")
    if (periodsPerYear.compare(0) <= 0) denied("DIVISOR_INVALID", "The periods a year are more than zero")
    if (blank(pick("payDateOffsetDays"))) denied("PAY_DATE_REQUIRED", "Say when a period is paid: days after its last day")
    const payDateOffsetDays = Number(pick("payDateOffsetDays"))
    if (!Number.isInteger(payDateOffsetDays) || payDateOffsetDays < -31 || payDateOffsetDays > 62)
        denied("PAY_DATE_INVALID", "A pay date is from 31 days before to 62 days after a period's last day")
    const prorationEnumId = text(pick("prorationEnumId"))
    if (!prorations[prorationEnumId]) denied("PRORATION_REQUIRED", "Choose how a part period is prorated")
    const timeBasisEnumId = text(pick("timeBasisEnumId"))
    if (!timeBases[timeBasisEnumId]) denied("TIME_BASIS_REQUIRED", "Choose where the group's hours come from")
    const payrollLocalizationId = text(pick("payrollLocalizationId")) || null
    if (payrollLocalizationId && !one(LOCALIZATION, {payrollLocalizationId}))
        denied("LOCALIZATION_INVALID", payrollLocalizationId + " is not a registered localization")
    const workweekTimeZone = text(pick("workweekTimeZone")) || null
    if (workweekTimeZone && workweekTimeZone.length > 60) denied("ZONE_INVALID", "That is not a time zone")
    const fields = {
        groupName,
        currencyUomId,
        timePeriodTypeId,
        firstPeriodFromDate,
        periodsPerYear,
        payDateOffsetDays,
        prorationEnumId,
        timeBasisEnumId,
        payrollLocalizationId,
        workweekTimeZone,
        description: text(pick("description")) || null,
        liveEnabled: "N"
    }
    if (!existing) {
        const created = call("create#" + GROUP, Object.assign({organizationPartyId, fromDate: ec.user.nowTimestamp}, fields))
        return {payrollGroupId: created.payrollGroupId, revision: groupRevision(created.payrollGroupId)}
    }
    if (rows(GROUP_PERIOD, {payrollGroupId: existing.payrollGroupId}).length) {
        const locked = ["currencyUomId", "timePeriodTypeId"].filter(field => fields[field] !== existing[field])
        if (locked.length || firstPeriodFromDate !== calendarDateText(existing.firstPeriodFromDate))
            denied("POLICY_LOCKED", "The group has periods: its currency, frequency and first period stay; start another group")
    }
    const changes = {payrollGroupId: existing.payrollGroupId}
    for (const [field, value] of Object.entries(fields)) {
        const before = existing[field]
        const same =
            value != null && typeof value === "object" && value.eq
                ? before != null && value.eq(toDecimal(before))
                : String(value ?? "") === String(before ?? "")
        if (field === "firstPeriodFromDate" ? value !== calendarDateText(before) : !same) changes[field] = value
    }
    if (flag(p.end)) {
        const endMs = when(p.thruDate) ?? nowMs()
        checkEnd(endMs)
        checkUnassigned("payrollGroupId", existing.payrollGroupId, endMs, "pay group")
        changes.thruDate = new Date(endMs)
    }
    if (text(p.reason))
        for (const field of Object.keys(changes))
            if (field !== "payrollGroupId") changes[field + "_changeReason"] = text(p.reason)
    if (Object.keys(changes).length > 1) call("update#" + GROUP, changes)
    return {payrollGroupId: existing.payrollGroupId, revision: groupRevision(existing.payrollGroupId)}
}

// ===== prepare#Periods =====
// The group's next periodCount periods (1 to 24), after the last prepared one or from its first period's start, each Mantle's
// TimePeriod of the employer and frequency (made once, shared by the employer's groups of that frequency) with the group's pay
// date; with preview, the same periods answered and nothing written. Idempotent: a period prepared already is answered as it
// is. The dates are calendar arithmetic in the frequency's own terms (create#TimePeriod's: a month, half a month, two weeks or
// one), never a fixed number of days a month.
const pad = number => String(number).padStart(2, "0")
const utcDay = textValue => {
    const [year, month, date] = String(textValue).slice(0, 10).split("-").map(Number)
    return new Date(Date.UTC(year, month - 1, date))
}
const dayText = date => date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate())
const plusDays = (date, count) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + count))
const daysInMonth = date => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
function plusMonths(date, count) {
    const first = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1))
    return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date.getUTCDate(), daysInMonth(first))))
}
function periodThru(from, timePeriodTypeId) {
    switch (timePeriodTypeId) {
        case "PayrollMonth":
            return plusDays(plusMonths(from, 1), -1)
        case "PayrollSemiMonth": {
            const maxDays = daysInMonth(from)
            const days = Math.floor(maxDays * 0.5)
            return plusDays(from, (from.getUTCDate() < days ? days : maxDays - days) - 1)
        }
        case "PayrollBiWeek":
            return plusDays(from, 13)
        case "PayrollWeek":
            return plusDays(from, 6)
    }
    throw new Error("No period length for " + timePeriodTypeId)
}
function preparePeriods(p) {
    const preview = flag(p.preview)
    const userScope = preview ? readerScope() : editorScope()
    const group = readable(userScope, GROUP, "payrollGroupId", text(p.payrollGroupId), "Pay group")
    if ((ms(group.thruDate) ?? Infinity) <= nowMs()) denied("GROUP_ENDED", "This pay group has ended")
    const periodCount = Number(p.periodCount)
    if (!Number.isInteger(periodCount) || periodCount < 1 || periodCount > periodCap)
        denied("COUNT_INVALID", "Prepare from 1 to " + periodCap + " periods")
    const prepared = groupPeriods(group.payrollGroupId)
    const last = prepared[prepared.length - 1]?.period || null
    let previousPeriodId = last?.timePeriodId || null
    let from = last ? plusDays(utcDay(calendarDateText(last.thruDate)), 1) : utcDay(calendarDateText(group.firstPeriodFromDate))
    const offset = Number(group.payDateOffsetDays) || 0
    const periods = []
    for (let index = 0; index < periodCount; index++) {
        const thru = periodThru(from, group.timePeriodTypeId)
        let fromText = dayText(from)
        let thruText = dayText(thru)
        let timePeriodId = null
        let created = false
        if (!preview) {
            timePeriodId = call("mantle.party.TimeServices.create#TimePeriod", {
                partyId: group.organizationPartyId,
                timePeriodTypeId: group.timePeriodTypeId,
                fromDate: fromText,
                thruDate: thruText,
                previousPeriodId
            }).timePeriodId
            // an existing period of the employer and frequency from that day is the one used, with its own end
            const period = one("mantle.party.time.TimePeriod", {timePeriodId})
            fromText = calendarDateText(period.fromDate)
            thruText = calendarDateText(period.thruDate)
        }
        const payDateText = dayText(plusDays(utcDay(thruText), offset))
        if (!preview && !one(GROUP_PERIOD, {payrollGroupId: group.payrollGroupId, timePeriodId})) {
            call("create#" + GROUP_PERIOD, {
                payrollGroupId: group.payrollGroupId,
                timePeriodId,
                payDate: payDateText,
                createdDate: ec.user.nowTimestamp
            })
            created = true
        }
        periods.push({timePeriodId, fromDateText: fromText, thruDateText: thruText, payDateText, created})
        previousPeriodId = timePeriodId
        from = plusDays(utcDay(thruText), 1)
    }
    return {periods, createdCount: periods.filter(row => row.created).length}
}

const operations = {
    findComponents,
    storeComponent,
    storeComponentExample,
    previewComponent,
    publishComponent,
    decidePublication,
    approveNotice: p => decideNotice(p, "approve"),
    refuseNotice: p => decideNotice(p, "refuse"),
    findStructures,
    storeStructure,
    storeStructureComponent,
    previewStructure,
    publishStructure,
    findGroups,
    storeGroup,
    preparePeriods
}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payroll configuration operation " + op)
    return operations[op](p || {})
}
;({
    execute: run,
    groupReadiness,
    // P23 (PayrollAssignments.js): an assignment's input values are read as a structure's parameter values are
    valuesOf,
    // P25 (PayrollRuns.js): a run calculates a structure's lines as a preview does, from published terms alone
    computeTerm,
    calculationOrder,
    componentsById,
    storedValues,
    termAt,
    splitNames
})
