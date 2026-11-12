// Payroll localization (mantle.humanres.PayrollLocalizationServices; IronStone People design §8.4, PE-12; impl-people P22): the
// registered localizations a pay group binds to, and the one shipped calculation, the synthetic, non-statutory demonstration.
//
// A localization's calculation implements calculate#Localization: declared pay facts (each component's kind and amount) and
// bases in, itemized employee and employer amounts with their explanations and findings out. It reads nothing and writes nothing:
// no invoice, payment or employee record. The build is generic (impl-people §4, Nov 11, 2026): the demonstration is no country's
// law, previews only and can never make a pay group live (PayrollConfiguration.js groupReadiness).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {rows, denied, dateText} = lib

function readerScope() {
    const userScope = people.scopeOf()
    if (!userScope.capabilities.payrollView) denied("PERMISSION_DENIED", "Payroll localizations are not available")
    return userScope
}

// ===== find#Localizations =====
// The registered localizations, by name: each its jurisdictions, coverage, release, outputs and whether it is a demonstration.
function findLocalizations() {
    readerScope()
    const localizations = rows("mantle.humanres.payroll.PayrollLocalization", {})
        .map(row => ({
            payrollLocalizationId: row.payrollLocalizationId,
            localizationName: row.localizationName || row.payrollLocalizationId,
            jurisdictionText: row.jurisdictionText || "",
            coverageFromDateText: dateText(row.coverageFromDate),
            coverageThruDateText: dateText(row.coverageThruDate),
            releaseVersion: row.releaseVersion || "",
            isDemonstration: row.isDemonstration === "Y",
            requiredSetup: row.requiredSetup || "",
            supportedOutputs: row.supportedOutputs || "",
            description: row.description || ""
        }))
        .sort((a, b) => a.localizationName.localeCompare(b.localizationName))
    return {localizations}
}

// ===== calculate#Demonstration =====
// The demonstration localization: a flat levy on the earnings among the pay facts, 2% from the employee and 1% from the
// employer, each rounded to the currency, and the finding that says it is synthetic. Not any jurisdiction's rule.
const employeeRate = "0.02"
const employerRate = "0.01"
function calculateDemonstration(p) {
    readerScope()
    if (!p.currencyUomId) denied("CURRENCY_REQUIRED", "A localization calculates in the pay's currency")
    const zero = toDecimal("0")
    const earnings = Array.from(p.payFacts || [])
        .filter(fact => fact.componentKindEnumId === "PckEarning" && fact.amount != null)
        .reduce((total, fact) => total.add(toDecimal(fact.amount)), zero)
    const item = (itemCode, itemName, party, rate) => {
        const amount = ec.l10n.roundCurrency(earnings.multiply(toDecimal(rate)), p.currencyUomId)
        return {
            itemCode,
            itemName,
            party,
            base: earnings,
            rate: toDecimal(rate),
            amount,
            explanation:
                Number(rate) * 100 +
                "% of the earnings " +
                String(earnings) +
                ", rounded to the currency: " +
                String(amount) +
                " (synthetic)"
        }
    }
    return {
        items: [
            item("DEMO_LEVY_EMPLOYEE", "Demonstration levy, employee", "employee", employeeRate),
            item("DEMO_LEVY_EMPLOYER", "Demonstration levy, employer", "employer", employerRate)
        ],
        findings: [
            {
                code: "DEMONSTRATION_ONLY",
                blocking: false,
                message: "A synthetic demonstration, not any jurisdiction's law: these amounts are for preview only"
            }
        ]
    }
}

const operations = {findLocalizations, calculateDemonstration}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown payroll localization operation " + op)
    return operations[op](p || {})
}
;({execute: run})
