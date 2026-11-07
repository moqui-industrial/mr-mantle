/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * A store's readiness and configuration summary (impl-commerce P15; design-commerce §13 "Store readiness/configuration
 * summary", StoreDetail's CSV and print): the store's readiness findings and its grouped settings, as the store's own
 * reads give them, with every credential redacted, as of the time it is made.
 *
 * - Read through the store services, each checking COMMERCE_VIEW and the store's scope again (StoreAdmin.js: the user's
 *   organizations; a store-limited staff member's own stores): get#Store with its sections, get#StoreSites,
 *   check#StoreReadiness and get#CheckoutSettings. A section that cannot be read is named as not read and the rest are made.
 * - Redacted: gateway configuration and credentials never come into it (a gateway is its description, instrument and
 *   capabilities), a carrier's billing account is "set, redacted", and any setting, check parameter or field whose name
 *   reads as a credential (password, secret, token, key, account number) shows "[redacted]".
 * - Out: the sections ({key, title, rows: [{item, value, state}]}), the CSV text (Section, Item, Value, State; a cell a
 *   spreadsheet would read as a formula behind an apostrophe) and a printable HTML page, each escaped.
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {call, dateText, ms} = lib
const ADMIN = "mantle.product.StoreAdminServices."

// ===== values =====
const text = value => (value == null ? "" : String(value).trim())
const REDACTED = "[redacted]"
const credentialName = /pass(word|phrase)?|secret|token|api.?key|private.?key|credential|account.?(number|no)|signature/i
const redact = (name, value) => (credentialName.test(text(name)) ? REDACTED : text(value))
const yesNo = value => (value === "Y" || value === true ? "Yes" : value === "N" || value === false ? "No" : text(value))
// "name = value, ..." with each value whose name reads as a credential redacted
const redactPairs = pairs =>
    text(pairs)
        .split(", ")
        .filter(Boolean)
        .map(pair => {
            const at = pair.indexOf(" = ")
            return at < 0 ? pair : pair.slice(0, at) + " = " + redact(pair.slice(0, at), pair.slice(at + 3))
        })
        .join(", ")
const row = (item, value, state) => ({item: text(item), value: text(value), state: text(state)})

// ===== the export =====
function csvCell(value) {
    let cell = value == null ? "" : String(value)
    if (/^[=+\-@\t\r]/.test(cell)) cell = "'" + cell
    return /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell
}
function csvOf(summary) {
    const lines = [
        ["Store configuration summary", summary.store.storeName + " (" + summary.store.productStoreId + ")"],
        ["As of", summary.asOfText],
        ["Readiness", summary.readinessText],
        [],
        ["Section", "Item", "Value", "State"]
    ]
    for (const section of summary.sections)
        for (const entry of section.rows) lines.push([section.title, entry.item, entry.value, entry.state])
    return lines.map(cells => cells.map(csvCell).join(",")).join("\r\n") + "\r\n"
}
const html = value =>
    text(value).replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch])
function printOf(summary) {
    const sections = summary.sections
        .map(
            section =>
                "<h2>" +
                html(section.title) +
                "</h2>" +
                (section.rows.length
                    ? "<table><thead><tr><th>Item</th><th>Value</th><th>State</th></tr></thead><tbody>" +
                      section.rows
                          .map(
                              entry =>
                                  "<tr><td>" +
                                  html(entry.item) +
                                  "</td><td>" +
                                  html(entry.value) +
                                  "</td><td>" +
                                  html(entry.state) +
                                  "</td></tr>"
                          )
                          .join("") +
                      "</tbody></table>"
                    : "<p>None.</p>")
        )
        .join("")
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>' +
        html("Store configuration: " + summary.store.storeName) +
        "</title><style>body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#111}h1{font-size:18px;margin:0 0 4px}" +
        "h2{font-size:14px;margin:18px 0 6px}p.meta{color:#555;margin:0 0 12px}table{border-collapse:collapse;width:100%}" +
        "th,td{border:1px solid #ccc;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f3f3f3}" +
        "@media print{h2{break-after:avoid}tr{break-inside:avoid}}</style></head><body><h1>" +
        html(summary.store.storeName + " (" + summary.store.productStoreId + ")") +
        '</h1><p class="meta">' +
        html(summary.store.organizationName + " · as of " + summary.asOfText + " · " + summary.readinessText) +
        "</p>" +
        sections +
        "</body></html>"
    )
}

// ===== get#StoreSummary =====
// A section read through its service: its rows, or a row saying it was not read (the rest are still made).
function section(key, title, read) {
    try {
        return {key, title, rows: read()}
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.warn("Store summary section " + key + " not read: " + String(error.message).split("\n")[0])
        return {
            key,
            title,
            rows: [
                row(
                    "Not read",
                    String(error.message)
                        .split("\n")[0]
                        .replace(/^Error: /, ""),
                    ""
                )
            ]
        }
    }
}
function getStoreSummary(p) {
    const productStoreId = text(p.productStoreId)
    // the store itself first: a store outside the user's scope (or no permission) is refused here, as get#Store refuses it
    const found = call(ADMIN + "get#Store", {
        productStoreId,
        include: ["facilities", "staff", "emails", "approvals", "content", "settings"]
    })
    const store = found.store
    let readiness = null
    const sections = [
        section("readiness", "Readiness", () => {
            readiness = call(ADMIN + "check#StoreReadiness", {productStoreId})
            return Array.from(readiness.findings || []).map(finding =>
                row(
                    finding.label,
                    finding.message,
                    finding.ready ? "Ready" : finding.severity === "warning" ? "Warning" : "To fix"
                )
            )
        }),
        section("general", "General", () => [
            row("Store", store.storeName + " (" + store.productStoreId + ")"),
            row("Organization", store.organizationName),
            row("Currency", store.currencyText || store.defaultCurrencyUomId),
            row("Locale", store.defaultLocale),
            row("Sales channel", store.channelText),
            row("Inventory facility", store.inventoryFacilityText),
            row("Requires inventory", yesNo(store.requireInventory)),
            row("Reservation order", store.reservationOrderText),
            row("Reservation", store.reservationAutoText),
            row("Tax gateway", store.taxGatewayText),
            row("Requires the customer role", yesNo(store.requireCustomerRole)),
            row("Promotions off by default", yesNo(store.defaultDisablePromotions)),
            row("Shipping calculation off by default", yesNo(store.defaultDisableShippingCalc)),
            row("Tax calculation off by default", yesNo(store.defaultDisableTaxCalc)),
            row("Approval delay (minutes)", store.autoApproveDelay),
            row("Store domain", store.storeDomain),
            row("Customer party rows", store.otherPartyCount),
            row("Changed", store.lastUpdatedText)
        ]),
        section("sites", "Sites", () =>
            Array.from(call(ADMIN + "get#StoreSites", {productStoreId}).sites || []).map(site =>
                row(
                    site.siteName + " (" + site.siteId + ")",
                    site.canonicalHost + site.pathPrefix,
                    site.state + ", " + site.readinessText
                )
            )
        ),
        section("facilities", "Facilities", () =>
            Array.from(found.facilities || []).map(facility =>
                row(facility.facilityName, facility.facilityId, facility.stateText)
            )
        ),
        section("staff", "Staff", () =>
            Array.from(found.staff || []).map(member => row(member.partyName, member.roleText, member.stateText))
        ),
        section("emails", "Emails", () =>
            Array.from(found.emails || []).map(email => row(email.emailTypeText, email.templateText, email.stateText))
        ),
        section("orderChecks", "Order checks", () =>
            Array.from(found.approvals || []).map(check =>
                row(check.checkText, redactPairs(check.parametersText), check.stateText)
            )
        ),
        section("content", "Search and content", () =>
            Array.from(found.content?.documents || [])
                .map(document => row(document.typeText, document.documentText, ""))
                .concat(
                    Array.from(found.content?.spaces || []).map(space =>
                        row(
                            space.spaceTypeText + (space.locale ? " (" + space.locale + ")" : ""),
                            space.spaceText,
                            space.stateText
                        )
                    )
                )
        ),
        section("settings", "Settings", () =>
            Array.from(found.settings || []).map(setting =>
                row(
                    setting.settingTypeText,
                    redact(setting.settingTypeEnumId + " " + setting.settingTypeText, setting.settingValue),
                    setting.stateText
                )
            )
        ),
        section("checkout", "Checkout", () => {
            const checkout = call(ADMIN + "get#CheckoutSettings", {productStoreId})
            const policy = checkout.policy || {}
            const rows = [
                row("Guest or account checkout", policy.accountModeText),
                row("Destinations", policy.destinationsText),
                row("Stock disclosure", policy.stockDisclosureText),
                row("Terms acceptance", policy.termsRequiredText),
                row("Purchase contact phone", policy.contactPhoneText),
                row("Support queue", policy.supportQueueIdText)
            ]
            for (const option of Array.from(checkout.shipOptions || []))
                rows.push(row("Ship option", option.carrierText + ", " + option.methodText, ""))
            // a carrier account is a credential of the store's: said to be set, never shown
            for (const gateway of Array.from(checkout.shippingGateways || []))
                rows.push(
                    row(
                        "Shipping gateway",
                        gateway.carrierText + " · " + gateway.gatewayText,
                        gateway.billingAccountText ? "Carrier account set (" + REDACTED + ")" : ""
                    )
                )
            // a payment gateway's configuration and credentials stay the administrator's: its description and capabilities
            for (const gateway of Array.from(checkout.paymentGateways || []))
                rows.push(
                    row(
                        "Payment gateway: " + gateway.instrumentText,
                        gateway.gatewayText + (gateway.capabilitiesText ? " · " + gateway.capabilitiesText : ""),
                        gateway.stateText
                    )
                )
            const tax = checkout.tax || {}
            rows.push(
                row("Tax gateway", tax.taxGatewayText),
                row("Tax display", tax.taxDisplayText),
                row("Tax origin", tax.taxOriginText)
            )
            return rows
        })
    ]
    const blocking = Array.from(readiness?.findings || []).filter(finding => !finding.ready && finding.severity !== "warning")
    const summary = {
        store: {productStoreId: store.productStoreId, storeName: store.storeName, organizationName: store.organizationName},
        asOfText: dateText(ec.user.nowTimestamp),
        ready: !!readiness && blocking.length === 0,
        readinessText: !readiness
            ? "Readiness not read"
            : blocking.length
              ? blocking.length + (blocking.length === 1 ? " thing" : " things") + " to fix"
              : "Ready to sell",
        sections
    }
    return Object.assign(summary, {
        csvText: csvOf(summary),
        printHtml: printOf(summary),
        fileName: "store-" + store.productStoreId + "-" + new Date(ms(ec.user.nowTimestamp)).toISOString().slice(0, 10) + ".csv"
    })
}

const operations = {getStoreSummary}
;({
    redact,
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown store summary operation " + op)
        return operations[op](parameters || {})
    }
})
