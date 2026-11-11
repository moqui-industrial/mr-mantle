// Bank statements and their reconciliation, for mantle.account.ReconciliationServices: the bank's scope and authority,
// statement files read into bank lines with each line's identity (BAI2, OFX, CSV), the book candidates of a bank line,
// match rules, and the figures of a statement session. The services keep the writes.
const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
const lib = policy.lib
const {find, one, rows, denied} = lib
const TRANS = "mantle.account.method.PaymentMethodTrans"
const PAYMENT = "mantle.account.payment.Payment"
const DAY = 86400000
const LOOK_BACK_DAYS = 30
const LOOK_AHEAD_DAYS = 5
const MAX_ROWS = 5000

// ---------- scope ----------

// The bank account's organization and the user's authority over it. Reading bank lines needs bank reconciliation,
// accounting view or administration authority; changing them needs BANK_RECONCILE; a deposit of receipts needs payment
// edit and view authority. A method of a party that is not an internal organization the user works in is refused.
function bank(p) {
    const need = p.need || "read"
    const method = p.paymentMethodId ? one("mantle.account.method.PaymentMethod", {paymentMethodId: p.paymentMethodId}) : null
    if (p.paymentMethodId && !method) denied("BANK_UNAVAILABLE", "The bank account is not available")
    const organizationPartyId = method ? method.ownerPartyId : p.organizationPartyId
    if (method && p.organizationPartyId && p.organizationPartyId !== organizationPartyId)
        denied("BANK_UNAVAILABLE", "The bank account is not one of the organization's")
    if (!organizationPartyId) denied("ORGANIZATION_REQUIRED", "Choose an internal organization")
    if (!one("mantle.party.PartyRole", {partyId: organizationPartyId, roleTypeId: "OrgInternal"}))
        denied("BANK_UNAVAILABLE", "The bank account is not an internal organization's")
    if (!["read", "reconcile", "deposit"].includes(need)) denied("PERMISSION_DENIED", "Unknown bank authority " + need)
    // a user who holds only BANK_RECONCILE reads the bank, not the rest of Accounting (bankReconcile is no general read)
    const c = policy.capabilities()
    const scope = policy.organization({organizationPartyId}, c.read ? "read" : c.bankReconcile ? "bankReconcile" : "read")
    const canReconcile = !!(c.bankReconcile || c.systemAdmin)
    const canRead = canReconcile || c.reportRead || c.admin
    const canDeposit = !!(c.paymentEdit && c.paymentRead) || c.systemAdmin
    if (need === "deposit" && !canDeposit) denied("PERMISSION_DENIED", "Payment edit and payment view authority are required")
    if (need === "reconcile" ? !canReconcile : need === "read" && !canRead)
        denied("PERMISSION_DENIED", "Bank reconciliation authority is required")
    return {organizationPartyId, method, canReconcile, canDeposit, label: method ? methodLabel(method) : null}
}
// A bank account as people see it: its name and the last digits of its number, never the whole number.
function methodLabel(method) {
    return ec.resource
        .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
        .execute("maskedMethods", {paymentMethodList: [method]}).methodRows[0].label
}

// ---------- days ----------

const dayText = value => lib.bookDay(null, value)
const dayStart = day => lib.ms(ec.l10n.parseTimestamp(lib.calendarDateText(day) + " 00:00:00", "yyyy-MM-dd HH:mm:ss"))
const millisText = value => String(value)
// The query condition of bank lines posted on the days from fromDay through thruDay in the user's zone.
function postedBetween(query, fromDay, thruDay) {
    if (fromDay) query = query.condition("postedDate", "greater-equals", millisText(dayStart(fromDay)))
    if (thruDay) query = query.condition("postedDate", "less", millisText(dayStart(thruDay) + DAY))
    return query
}

// ---------- statement files ----------

// A deterministic key of a source row: the same row of the same file always gets the same key, so a file imported again
// adds nothing; occurrence tells identical rows of one file apart.
function rowKey(prefix, parts) {
    return (
        prefix +
        lib
            .hash(parts)
            .replace(/[^A-Za-z0-9]/g, "")
            .slice(0, 32)
    )
}
function occurrence(seen, parts) {
    const text = JSON.stringify(parts)
    const n = seen.get(text) || 0
    seen.set(text, n + 1)
    return n
}
const decimalText = value => String(value)

// BAI2 (Cash Management Balance Reporting Specification 2): the groups (02) of the bank's routing number and the
// accounts (03) of its account number; each transaction detail (16) and its continuations (88) is a line, keyed by
// its source row since the format has no transaction id. A control total that does not match is a warning.
const baiTypes = {
    108: "PMTT_CREDIT",
    409: "PMTT_DEBIT",
    475: "PMTT_CHECK",
    354: "PMTT_INT",
    654: "PMTT_INT",
    295: "PMTT_ATM",
    595: "PMTT_ATM",
    142: "PMTT_PAYMENT",
    451: "PMTT_PAYMENT",
    174: "PMTT_OTHER",
    277: "PMTT_ZBA_CRTR",
    577: "PMTT_ZBA_DBTR"
}
function parseBai2(text, method, bankAccount) {
    const result = {rows: [], fileErrors: [], warnings: [], balance: {}, currencyUomId: null}
    const splitFields = line => {
        const parts = line.replace(/\/\s*$/, "").split(",")
        while (parts.length > 1 && parts[parts.length - 1] === "") parts.pop()
        return parts
    }
    const statusCodes = {}
    const parseStatusCodes = fields => {
        for (let i = 0; i < fields.length; i += 4) {
            if (fields[i + 1] && /^-?\d+$/.test(fields[i + 1])) statusCodes[fields[i]] = toDecimal(fields[i + 1]).divide(100)
        }
    }
    const seen = new Map()
    let routingNumber = null,
        accountNumber = null,
        postedDate = null,
        asOfDay = null,
        lastCode = null,
        pending = null,
        total = toDecimal(0)
    const flush = () => {
        if (!pending) return
        const row = pending
        pending = null
        if (!row.error && row.transAmount) {
            const amount = toDecimal(row.transAmount)
            total = total.add(amount.compare(0) < 0 ? amount.multiply(-1) : amount)
        }
        // the as-of day and the bank's reference identify a line; without a reference, its whole record does
        const parts = [asOfDay, row.transCode, row.transAmount ?? null, row.refNumber || null, row.checkNumber || null]
        if (!row.refNumber) parts.push(row.raw)
        row.fitId = rowKey("B2", parts.concat([occurrence(seen, parts)]))
        delete row.raw
        result.rows.push(row)
    }
    const lines = String(text || "").split(/\r\n|\r|\n/)
    lines.forEach((line, index) => {
        const fields = splitFields(line)
        const code = fields[0] ?? ""
        if (code !== "88") lastCode = code
        if (code === "02") {
            routingNumber = fields[1]
            if (bankAccount && routingNumber !== bankAccount.routingNumber) {
                result.fileErrors.push(
                    `BAI originator ID ${routingNumber} does not match the routing number of ${methodLabel(method)}`
                )
                routingNumber = null
            }
            if (fields[3] !== "1") result.fileErrors.push("Only groups of type Update can be processed")
            if (fields[6]) result.currencyUomId = fields[6]
            asOfDay = fields[4]
            postedDate = ec.l10n.parseTimestamp(fields[4] + " " + (fields[5] === "9999" ? "2359" : fields[5]), "yyMMdd HHmm")
        }
        if (routingNumber && code === "03") {
            accountNumber = fields[1]
            if (bankAccount && accountNumber !== bankAccount.accountNumber) {
                result.fileErrors.push(
                    `Customer account number ${accountNumber} does not match the account number of ${methodLabel(method)}`
                )
                accountNumber = null
            }
            if (fields[2]) result.currencyUomId = fields[2]
            parseStatusCodes(fields.slice(3))
        }
        if (result.fileErrors.length) return
        if (code === "16" || code === "49") flush()
        if (routingNumber && accountNumber && code === "16") {
            const type = fields[1] || ""
            const row = {sourceRow: index + 1, raw: line, paymentMethodId: method.paymentMethodId, postedDate}
            row.transCode = type
            row.transType = baiTypes[type] || type
            const amountText = fields[2] || "0"
            if (!/^\d{3}$/.test(type)) row.error = "The type code " + type + " is not a BAI2 detail type"
            else if (!/^\d+$/.test(amountText)) row.error = "The amount " + amountText + " is not a number"
            else {
                let amount = toDecimal(amountText).divide(100).setScale(2, "HALF_UP")
                if (/^[456]/.test(type)) amount = amount.multiply(-1)
                row.transAmount = decimalText(amount)
            }
            const fundType = fields[3]
            let reference
            if (fundType === "S") reference = fields[7]
            else if (fundType === "V") reference = fields[6]
            else if (fundType === "D") reference = fields[5 + parseInt(fields[4], 10) * 2]
            else reference = fields[4]
            if (reference) row.refNumber = reference
            if (["474", "475", "395"].includes(type)) row.checkNumber = fields[5]
            const memo = fields[6]
            if (memo && memo !== "/") row.transMemo = memo
            pending = row
        } else if (code === "88" && routingNumber && accountNumber) {
            if (lastCode === "16" && pending) {
                pending.raw += "\n" + line
                const words = fields.slice(1).join(" ")
                pending.transMemo = [pending.transMemo, words].filter(Boolean).join(" ")
            } else if (lastCode === "03") parseStatusCodes(fields.slice(1))
        }
        if (code === "49") {
            accountNumber = null
            let sum = total
            for (const value of Object.values(statusCodes)) sum = sum.add(value)
            const control = fields[1] && /^-?\d+$/.test(fields[1]) ? toDecimal(fields[1]).divide(100) : toDecimal(0)
            if (!sum.eq(control))
                result.warnings.push(
                    `Control sum ${decimalText(control)} did not match total ${decimalText(sum)} in the BAI file dated ${
                        postedDate ? ec.l10n.format(postedDate, "yyyy-MM-dd HH:mm") : ""
                    } for bank account ${method.paymentMethodId}`
                )
        }
        if (code === "98") routingNumber = null
    })
    flush()
    if (postedDate) {
        result.balance = {ledgerBalance: statusCodes["015"] ?? null, availableBalance: statusCodes["045"] ?? null}
        result.balance.balanceDate = postedDate
    }
    return result
}

// OFX 1 (SGML) and OFX 2 (XML): the statement (STMTRS) of the bank account, each STMTTRN a line keyed by its FITID.
function parseOfxDateTime(ofxStr) {
    // a day without a time is that calendar day in the user's zone
    if (/^\d{8}$/.test(ofxStr)) return String(lib.ms(ec.l10n.parseTimestamp(ofxStr, "yyyyMMdd")))
    let dtStr = ofxStr
    let tzStr = "+00"
    if (ofxStr.length > 18) {
        const openBraceIndex = ofxStr.indexOf("[")
        tzStr = ofxStr.substring(openBraceIndex + 1, ofxStr.indexOf(":", openBraceIndex))
        if (/^\d/.test(tzStr)) tzStr = "+" + tzStr
        if (tzStr.length === 2) tzStr = tzStr[0] + "0" + tzStr[1]
        dtStr = ofxStr.substring(0, openBraceIndex)
    }
    while (dtStr.length < 14) dtStr += "0"
    if (dtStr.length < 15) dtStr += "."
    while (dtStr.length < 18) dtStr += "0"
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})$/.exec(dtStr)
    const tzMatch = /^([+-])(\d{2})$/.exec(tzStr)
    if (!match || !tzMatch) return null
    const part = match.slice(1).map(digits => parseInt(digits, 10))
    const offsetMinutes = (tzMatch[1] === "-" ? -1 : 1) * parseInt(tzMatch[2], 10) * 60
    return String(Date.UTC(part[0], part[1] - 1, part[2], part[3], part[4], part[5], part[6]) - offsetMinutes * 60000)
}
const decodeFromXml = text =>
    text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&")
// A small SGML reader (no attributes, no validation), after the Java SimpleSgmlReader. Each node is {name, text, kids},
// where kids maps a child name to its children of that name, and a DT* node also has millis.
function parseSgml(sgml) {
    if (!sgml) return null
    const length = sgml.length
    let pos = sgml.indexOf("<")
    if (pos < 0) return null
    const startNode = parent => {
        pos++
        const gtIndex = sgml.indexOf(">", pos)
        if (gtIndex === -1) {
            pos = length
            return
        }
        const node = {name: sgml.substring(pos, gtIndex).trim(), value: null, children: []}
        parent.children.push(node)
        pos = gtIndex + 1
        while (pos < length && /\s/.test(sgml.charAt(pos))) pos++
        if (pos === length) return
        let ltIndex = sgml.indexOf("<", pos)
        if (ltIndex === -1) ltIndex = length
        let value = null
        if (ltIndex > pos) {
            value = sgml.substring(pos, ltIndex).trim()
            if (value) node.value = decodeFromXml(value)
            pos = ltIndex
        }
        if (pos === length) return
        if (!value) handleChildren(node)
        else if (sgml.startsWith("</" + node.name + ">", pos)) pos = sgml.indexOf(">", pos) + 1
        while (pos < length && /\s/.test(sgml.charAt(pos))) pos++
    }
    const handleChildren = parent => {
        while (pos < length && sgml.charAt(pos) === "<" && sgml.charAt(pos + 1) !== "/") startNode(parent)
        if (pos < length && sgml.charAt(pos) === "<" && sgml.charAt(pos + 1) === "/") {
            const closeGtIndex = sgml.indexOf(">", pos + 2)
            if (closeGtIndex > pos) pos = closeGtIndex + 1
            const nextLtIndex = sgml.indexOf("<", pos)
            pos = nextLtIndex === -1 ? length : nextLtIndex
        }
    }
    // the root element (OFX), after any header and processing instructions
    let rootStart = sgml.indexOf("<OFX>")
    if (rootStart < 0) rootStart = pos
    pos = rootStart + 1
    const rootGtIndex = sgml.indexOf(">", pos)
    if (rootGtIndex === -1) return null
    const root = {name: sgml.substring(pos, rootGtIndex).trim(), value: null, children: []}
    pos = rootGtIndex + 1
    const firstChildLt = sgml.indexOf("<", pos)
    if (firstChildLt === -1) return null
    pos = firstChildLt
    handleChildren(root)
    const finish = node => {
        const kids = {}
        for (const child of node.children) (kids[child.name] ??= []).push(finish(child))
        const text = node.value ?? node.children.map(child => child.text).join("")
        const result = {name: node.name, text, kids}
        if (/^DT/.test(node.name) && text) result.millis = parseOfxDateTime(text)
        return result
    }
    return finish(root)
}
function ofxAmount(text) {
    const value = String(text || "")
        .trim()
        .replace(/,/g, ".")
    return /^[+-]?\d*\.?\d+$/.test(value) ? value : null
}
function parseOfx(text, method, bankAccount) {
    const result = {rows: [], fileErrors: [], warnings: [], balance: {}, currencyUomId: null}
    const node = parseSgml(String(text || ""))
    const stmtrs = node?.kids.BANKMSGSRSV1?.[0].kids.STMTTRNRS?.[0].kids.STMTRS?.[0]
    if (!stmtrs) {
        result.fileErrors.push("Invalid OFX file, could not find STMTRS element")
        return result
    }
    const kid = (n, name) => n?.kids[name]?.[0]
    if (bankAccount) {
        const from = kid(stmtrs, "BANKACCTFROM")
        if (from) {
            const bankId = kid(from, "BANKID")?.text
            if (bankAccount.routingNumber !== bankId)
                result.fileErrors.push(`OFX BANKID [${bankId}] does not match routing number of ${methodLabel(method)}`)
            const acctId = kid(from, "ACCTID")?.text || ""
            if (!acctId.includes(bankAccount.accountNumber))
                result.fileErrors.push(
                    `OFX ACCTID [${acctId}] does not match (or contain) the account number of ${methodLabel(method)}`
                )
        }
        const curDef = kid(stmtrs, "CURDEF")?.text
        if (curDef && method.currencyUomId && curDef !== method.currencyUomId)
            result.fileErrors.push(
                `OFX currency (CURDEF) [${curDef}] does not match the currency ${method.currencyUomId} of ${methodLabel(method)}`
            )
    }
    result.currencyUomId = kid(stmtrs, "CURDEF")?.text || null
    const seen = new Set()
    let index = 0
    for (const stmttrn of kid(stmtrs, "BANKTRANLIST")?.kids.STMTTRN || []) {
        index++
        const row = {sourceRow: index, paymentMethodId: method.paymentMethodId}
        row.fitId = kid(stmttrn, "FITID")?.text || null
        row.postedDate = kid(stmttrn, "DTPOSTED")?.millis ?? null
        row.transAmount = ofxAmount(kid(stmttrn, "TRNAMT")?.text)
        row.transName = kid(stmttrn, "NAME")?.text || kid(stmttrn, "PAYEE")?.text || null
        row.transCode = kid(stmttrn, "TRNTYPE")?.text || null
        row.transType = row.transCode
        const typeEnum = row.transCode
            ? find("moqui.basic.Enumeration", {enumTypeId: "PaymentMethodTransType", enumCode: row.transCode}).one()
            : null
        if (typeEnum) row.transType = typeEnum.enumId
        row.transMemo = kid(stmttrn, "MEMO")?.text ?? null
        row.checkNumber = kid(stmttrn, "CHECKNUM")?.text ?? null
        row.refNumber = kid(stmttrn, "REFNUM")?.text ?? null
        if (!row.fitId) row.error = "The transaction has no FITID"
        else if (row.fitId.length > 60) row.error = "The FITID is longer than 60 characters"
        else if (!row.postedDate) row.error = "The transaction has no posted date (DTPOSTED)"
        else if (row.transAmount == null) row.error = "The amount (TRNAMT) is not a number"
        else if (seen.has(row.fitId)) row.duplicateInFile = true
        if (row.fitId) seen.add(row.fitId)
        result.rows.push(row)
    }
    const balanceOf = name => {
        const n = kid(stmtrs, name)
        return n ? {amount: ofxAmount(kid(n, "BALAMT")?.text), date: kid(n, "DTASOF")?.millis ?? null} : null
    }
    const ledger = balanceOf("LEDGERBAL"),
        available = balanceOf("AVAILBAL")
    const balanceDate = ledger?.date || available?.date || null
    if (balanceDate)
        result.balance = {
            ledgerBalance: ledger?.amount ?? null,
            availableBalance: available?.amount ?? null,
            balanceDate
        }
    return result
}

// CSV: one line a row, the columns named by the mapping (a header name or a 1-based column number), or found by the
// header names date, amount, debit, credit, description, memo and reference.
function csvRecords(text, delimiter = ",") {
    const records = []
    let record = [],
        field = "",
        quoted = false
    const s = String(text || "")
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]
        if (quoted) {
            if (ch === '"' && s[i + 1] === '"') {
                field += '"'
                i++
            } else if (ch === '"') quoted = false
            else field += ch
        } else if (ch === '"') quoted = true
        else if (ch === delimiter) {
            record.push(field)
            field = ""
        } else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && s[i + 1] === "\n") i++
            record.push(field)
            records.push(record)
            record = []
            field = ""
        } else field += ch
    }
    if (field !== "" || record.length) {
        record.push(field)
        records.push(record)
    }
    return records.filter(r => r.some(value => String(value).trim() !== ""))
}
function csvMapping(header, mapping) {
    const names = header.map(name =>
        String(name || "")
            .trim()
            .toLowerCase()
    )
    const column = (value, guesses) => {
        const text = String(value || "").trim()
        if (/^\d+$/.test(text)) return parseInt(text, 10) - 1
        if (text) {
            const at = names.indexOf(text.toLowerCase())
            if (at < 0) throw new Error("The CSV has no column " + text)
            return at
        }
        for (const guess of guesses) {
            const at = names.findIndex(name => name === guess || name.includes(guess))
            if (at >= 0) return at
        }
        return -1
    }
    const columns = {
        date: column(mapping.dateColumn, ["date", "posted"]),
        amount: column(mapping.amountColumn, ["amount"]),
        debit: column(mapping.debitColumn, ["debit", "withdrawal"]),
        credit: column(mapping.creditColumn, ["credit", "deposit"]),
        description: column(mapping.descriptionColumn, ["description", "name", "payee"]),
        memo: column(mapping.memoColumn, ["memo"]),
        reference: column(mapping.referenceColumn, ["reference", "ref", "check"])
    }
    if (columns.date < 0) throw new Error("Name the CSV column of the date")
    if (columns.amount < 0 && columns.debit < 0 && columns.credit < 0)
        throw new Error("Name the CSV column of the amount, or of the debit and credit")
    return columns
}
// An amount as the bank wrote it: a currency sign, thousands separators, a minus or parentheses for money out.
function csvAmount(text) {
    let value = String(text || "")
        .trim()
        .replace(/[$€£¥\s]/g, "")
    if (!value) return null
    let negative = false
    if (/^\(.*\)$/.test(value)) {
        negative = true
        value = value.slice(1, -1)
    }
    if (value.endsWith("-")) {
        negative = !negative
        value = value.slice(0, -1)
    }
    value = value.replace(/,(?=\d{3}(\D|$))/g, "")
    if (!/^[+-]?\d*\.?\d+$/.test(value)) return undefined
    let amount = toDecimal(value)
    if (negative) amount = amount.multiply(-1)
    return amount
}
function parseCsv(text, method, mapping = {}) {
    const result = {
        rows: [],
        fileErrors: [],
        warnings: [],
        balance: {},
        currencyUomId: method?.currencyUomId || null,
        columns: []
    }
    const records = csvRecords(text, mapping.delimiter || ",")
    if (!records.length) {
        result.fileErrors.push("The CSV file has no rows")
        return result
    }
    const hasHeader = mapping.hasHeader !== "N" && mapping.hasHeader !== false
    const header = hasHeader ? records[0] : records[0].map((value, index) => String(index + 1))
    result.columns = header.map(String)
    let columns
    try {
        columns = csvMapping(header, mapping)
    } catch (error) {
        result.fileErrors.push(error.message)
        return result
    }
    const format = mapping.dateFormat || "yyyy-MM-dd"
    const seen = new Map()
    const cell = (record, at) => (at >= 0 ? String(record[at] ?? "").trim() : "")
    records.slice(hasHeader ? 1 : 0).forEach((record, index) => {
        const row = {sourceRow: index + (hasHeader ? 2 : 1), paymentMethodId: method?.paymentMethodId}
        const dateText = cell(record, columns.date)
        row.transName = cell(record, columns.description) || null
        row.transMemo = cell(record, columns.memo) || null
        row.refNumber = cell(record, columns.reference) || null
        const posted = dateText ? ec.l10n.parseTimestamp(dateText, format) : null
        let amount
        if (columns.amount >= 0) amount = csvAmount(cell(record, columns.amount))
        else {
            const debit = csvAmount(cell(record, columns.debit)),
                credit = csvAmount(cell(record, columns.credit))
            if (debit === undefined || credit === undefined) amount = undefined
            else if (debit == null && credit == null) amount = null
            else
                amount = (credit || toDecimal(0)).subtract(
                    debit ? (debit.compare(0) < 0 ? debit.multiply(-1) : debit) : toDecimal(0)
                )
        }
        if (!posted) row.error = "The date " + (dateText || "(empty)") + " is not a date of the form " + format
        else if (amount === undefined) row.error = "The amount is not a number"
        else if (amount == null) row.error = "The row has no amount"
        else {
            row.postedDate = posted
            row.transAmount = decimalText(amount)
            row.transType = amount.compare(0) < 0 ? "PMTT_DEBIT" : "PMTT_CREDIT"
            const parts = [dayText(posted), row.transAmount, row.transName, row.transMemo, row.refNumber]
            row.fitId = rowKey("CS", parts.concat([occurrence(seen, parts)]))
        }
        result.rows.push(row)
    })
    return result
}

// A statement file of the format, read for the bank account: its rows, each new, a duplicate or rejected (status),
// the file's errors, which refuse the whole file, and its warnings.
function statement(p) {
    const method = p.method || one("mantle.account.method.PaymentMethod", {paymentMethodId: p.paymentMethodId})
    const bankAccount = one("mantle.account.method.BankAccount", {paymentMethodId: method.paymentMethodId})
    const parsers = {
        SifBai2: () => parseBai2(p.text, method, bankAccount),
        SifOfx: () => parseOfx(p.text, method, bankAccount),
        SifCsv: () => parseCsv(p.text, method, p.mapping || {})
    }
    if (!parsers[p.formatEnumId]) denied("FORMAT_UNKNOWN", "Choose the format of the statement file")
    const result = parsers[p.formatEnumId]()
    if (result.rows.length > MAX_ROWS) denied("STATEMENT_TOO_LARGE", "A statement file may have at most " + MAX_ROWS + " lines")
    const ids = [...new Set(result.rows.filter(row => row.fitId && !row.error).map(row => row.fitId))]
    const known = new Set()
    for (let i = 0; i < ids.length; i += 500) {
        for (const row of find(TRANS, {paymentMethodId: method.paymentMethodId})
            .condition("fitId", "in", ids.slice(i, i + 500))
            .selectField("fitId")
            .list())
            known.add(row.fitId)
    }
    const finished = finishedPeriods(method.paymentMethodId)
    for (const row of result.rows) {
        if (row.postedDate != null) row.postedDate = String(lib.ms(row.postedDate))
        row.postedDateText = row.postedDate ? dayText(row.postedDate) : ""
        const closedBy = !row.error && row.postedDateText ? finishedOn(finished, row.postedDateText) : null
        if (closedBy && !known.has(row.fitId))
            row.error = "The day " + row.postedDateText + " is in finished statement " + closedBy.bankReconciliationId
        row.status = row.error ? "rejected" : known.has(row.fitId) || row.duplicateInFile ? "duplicate" : "new"
        delete row.duplicateInFile
    }
    const days = result.rows
        .map(row => row.postedDateText)
        .filter(Boolean)
        .sort()
    result.statementFromDate = days[0] || null
    result.statementThruDate = days[days.length - 1] || null
    if (result.balance.balanceDate != null) result.balance.balanceDate = String(lib.ms(result.balance.balanceDate))
    return result
}
// The finished statement periods of a bank, and the one a day is in: no line is added or moved into it.
function finishedPeriods(paymentMethodId) {
    return rows("mantle.account.method.BankReconciliation", {paymentMethodId, statusId: "BrecFinished"}).map(rec => ({
        bankReconciliationId: rec.bankReconciliationId,
        fromDay: lib.calendarDateText(rec.statementFromDate),
        thruDay: lib.calendarDateText(rec.statementThruDate)
    }))
}
function finishedOn(periods, day) {
    return periods.find(period => day >= period.fromDay && day <= period.thruDay) || null
}
// The calendar day after a day (yyyy-MM-dd).
function dayAfter(p) {
    const [year, month, date] = lib.calendarDateText(p.day).split("-").map(Number)
    const next = new Date(Date.UTC(year, month - 1, date + 1))
    const two = n => String(n).padStart(2, "0")
    return {day: next.getUTCFullYear() + "-" + two(next.getUTCMonth() + 1) + "-" + two(next.getUTCDate())}
}
// check#BankLineDay: refuses a bank line posted on a day a finished statement of its bank covers.
function lineDay(p) {
    if (!p.postedDate) return {}
    const day = dayText(p.postedDate)
    const closedBy = finishedOn(finishedPeriods(p.paymentMethodId), day)
    if (closedBy) denied("BANK_PERIOD_FINISHED", "The day " + day + " is in finished statement " + closedBy.bankReconciliationId)
    return {}
}
// The fields of a bank line from a statement row.
const lineFields = [
    "fitId",
    "transType",
    "transCode",
    "postedDate",
    "transAmount",
    "transName",
    "transMemo",
    "checkNumber",
    "refNumber"
]
function lineOf(p) {
    const line = {paymentMethodId: p.paymentMethodId, statementImportId: p.statementImportId || null}
    for (const field of lineFields) if (p.row[field] != null && p.row[field] !== "") line[field] = p.row[field]
    return line
}

// ---------- bank lines and their candidates ----------

const unmatched = query => {
    const cf = ec.entity.conditionFactory
    return query
        .condition("paymentId", "is-null", null)
        .condition("acctgTransId", "is-null", null)
        .condition("paymentDepositId", "is-null", null)
        .condition(
            cf.makeCondition(
                [cf.makeCondition("noReconcile", "is-null", null), cf.makeCondition("noReconcile", "not-equals", "Y")],
                "or"
            )
        )
}
// What a bank line is matched with: matched (a payment, a deposit or a ledger entry), excluded (no reconcile) or open.
function lineState(line) {
    if (line.paymentId || line.acctgTransId || line.paymentDepositId) return "matched"
    if (line.noReconcile === "Y") return "excluded"
    return "open"
}
const absOf = value => (value.compare(0) < 0 ? value.multiply(-1) : value)
function partyLabel(names, partyId) {
    return partyId ? names[partyId] || partyId : ""
}
// The payments, deposits and ledger entries a bank line could be reconciled with: same bank account, direction and
// amount, not yet reconciled, dated up to 30 days before and 5 days after the line. A payment whose reference is the
// line's check or reference number comes first, whatever its date. With partyId, only that party's payments.
function candidates(line, method, options = {}) {
    const amount = toDecimal(line.transAmount ?? 0)
    if (amount.isZero() || !line.postedDate) return []
    const incoming = amount.compare(0) > 0
    const absolute = absOf(amount)
    const posted = lib.ms(line.postedDate)
    const from = millisText(posted - LOOK_BACK_DAYS * DAY),
        thru = millisText(posted + LOOK_AHEAD_DAYS * DAY)
    const cf = ec.entity.conditionFactory
    const notReconciled = cf.makeCondition(
        [cf.makeCondition("reconcileStatusId", "is-null", null), cf.makeCondition("reconcileStatusId", "not-equals", "PmtrRec")],
        "or"
    )
    const paymentQuery = () => {
        let q = find(PAYMENT, incoming ? {toPaymentMethodId: method.paymentMethodId} : {paymentMethodId: method.paymentMethodId})
            .condition(incoming ? "toPartyId" : "fromPartyId", method.ownerPartyId)
            .condition("statusId", "in", ["PmntDelivered", "PmntConfirmed"])
            .condition("paymentDepositId", "is-null", null)
            .condition("amount", absolute)
            .condition(notReconciled)
        if (options.partyId) q = q.condition(incoming ? "fromPartyId" : "toPartyId", options.partyId)
        return q
    }
    const found = []
    const reference = line.checkNumber || line.refNumber
    if (reference) {
        for (const payment of paymentQuery().condition("paymentRefNum", reference).limit(5).list())
            found.push({payment, reason: "reference"})
    }
    for (const payment of paymentQuery()
        .condition("effectiveDate", "greater-equals", from)
        .condition("effectiveDate", "less-equals", thru)
        .orderBy("effectiveDate")
        .limit(20)
        .list())
        if (!found.some(row => row.payment.paymentId === payment.paymentId)) found.push({payment, reason: "amount"})
    const names = lib.partyNames(found.map(row => (incoming ? row.payment.fromPartyId : row.payment.toPartyId)))
    const out = found.map(({payment, reason}) => {
        const partyId = incoming ? payment.fromPartyId : payment.toPartyId
        return {
            value: "payment:" + payment.paymentId,
            kind: "payment",
            id: payment.paymentId,
            partyId,
            partyName: partyLabel(names, partyId),
            amount: decimalText(payment.amount),
            dateText: dayText(payment.effectiveDate),
            reference: payment.paymentRefNum || "",
            reason,
            label:
                "Payment " +
                payment.paymentId +
                " · " +
                [partyLabel(names, partyId), dayText(payment.effectiveDate), payment.paymentRefNum].filter(Boolean).join(" · ")
        }
    })
    if (options.partyId) return out
    if (incoming) {
        for (const deposit of find("mantle.account.payment.PaymentDeposit", {paymentMethodId: method.paymentMethodId})
            .condition("totalAmount", absolute)
            .condition("depositDate", "greater-equals", from)
            .condition("depositDate", "less-equals", thru)
            .limit(10)
            .list()) {
            if (find(TRANS, {paymentDepositId: deposit.paymentDepositId}).count()) continue
            out.push({
                value: "deposit:" + deposit.paymentDepositId,
                kind: "deposit",
                id: deposit.paymentDepositId,
                amount: decimalText(deposit.totalAmount),
                dateText: dayText(deposit.depositDate),
                reference: deposit.referenceNumber || "",
                reason: "amount",
                label:
                    "Deposit " +
                    deposit.paymentDepositId +
                    " · " +
                    [deposit.paymentCount + " receipts", dayText(deposit.depositDate), deposit.referenceNumber]
                        .filter(Boolean)
                        .join(" · ")
            })
        }
    }
    if (method.glAccountId) {
        for (const entry of find("mantle.ledger.transaction.AcctgTransAndEntry", {
            glAccountId: method.glAccountId,
            organizationPartyId: method.ownerPartyId,
            debitCreditFlag: incoming ? "D" : "C",
            isPosted: "Y"
        })
            .condition("paymentId", "is-null", null)
            .condition("amount", absolute)
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition("reconcileStatusId", "is-null", null),
                        cf.makeCondition("reconcileStatusId", "equals", "AterNot")
                    ],
                    "or"
                )
            )
            .condition("transactionDate", "greater-equals", from)
            .condition("transactionDate", "less-equals", thru)
            .limit(10)
            .list()) {
            out.push({
                value: "entry:" + entry.acctgTransId + ":" + entry.acctgTransEntrySeqId,
                kind: "entry",
                id: entry.acctgTransId,
                entrySeqId: entry.acctgTransEntrySeqId,
                amount: decimalText(entry.amount),
                dateText: dayText(entry.transactionDate),
                reference: entry.description || "",
                reason: "amount",
                label:
                    "Ledger entry " +
                    entry.acctgTransId +
                    " · " +
                    [dayText(entry.transactionDate), entry.description].filter(Boolean).join(" · ")
            })
        }
    }
    return out
}
// A candidate value (payment:ID, deposit:ID or entry:TRANS:SEQ) as the parameters of reconcile#PaymentMethodTrans.
function candidateParameters(p) {
    const value = String(p.candidate || "")
    const [kind, id, seq] = value.split(":")
    if (kind === "payment" && id) return {paymentId: id}
    if (kind === "deposit" && id) return {paymentDepositId: id}
    if (kind === "entry" && id && seq) return {acctgTransId: id, acctgTransEntrySeqId: seq}
    denied("CANDIDATE_REQUIRED", "Choose the payment, deposit or ledger entry the line reconciles with")
}
// The reconcile#PaymentMethodTrans parameters of a candidate the line (read under lock by the caller) may take: the line
// is open and the candidate is one of its candidates now (same organization, bank, direction and amount, not
// reconciled; a deposit of the same total that no line holds).
function checkedCandidate(p) {
    const line = p.line
    if (!line) denied("BANK_LINE_UNAVAILABLE", "The bank line is not available")
    if (lineState(line) !== "open") denied("BANK_LINE_NOT_OPEN", "Bank line " + line.fitId + " is already matched or excluded")
    const method = one("mantle.account.method.PaymentMethod", {paymentMethodId: line.paymentMethodId})
    const value = String(p.candidate || "")
    if (!candidates(line, method).some(row => row.value === value))
        denied("CANDIDATE_INVALID", "The chosen record is not a match for bank line " + line.fitId)
    return candidateParameters({candidate: value})
}
function lineCandidates(p) {
    const scope = bank(Object.assign({}, p, {need: "read"}))
    const line = one(TRANS, {paymentMethodId: p.paymentMethodId, fitId: p.fitId})
    if (!line) denied("BANK_LINE_UNAVAILABLE", "The bank line is not available")
    let rows = candidates(line, scope.method)
    const term = String(p.term || "")
        .trim()
        .toLowerCase()
    if (term) rows = rows.filter(row => row.label.toLowerCase().includes(term))
    return {candidateRows: rows}
}

// ---------- match rules ----------

const byPriority = (a, b) =>
    (a.sequenceNum ?? 999) - (b.sequenceNum ?? 999) || String(a.bankMatchRuleId).localeCompare(String(b.bankMatchRuleId))
function activeRules(organizationPartyId, paymentMethodId = null) {
    const now = ec.user.nowTimestamp
    return rows("mantle.account.method.BankMatchRule", {organizationPartyId})
        .filter(rule => lib.active(rule, now))
        .filter(rule => !rule.paymentMethodId || !paymentMethodId || rule.paymentMethodId === paymentMethodId)
        .sort(byPriority)
}
// Whether a rule matches a bank line: its bank, the match text in the line's name, memo, check or reference number
// (ignoring case), its direction and its amount range (of the absolute amount).
function ruleMatches(rule, line) {
    if (rule.paymentMethodId && rule.paymentMethodId !== line.paymentMethodId) return false
    const amount = toDecimal(line.transAmount ?? 0)
    if (rule.directionEnumId === "BmdIncoming" && amount.compare(0) <= 0) return false
    if (rule.directionEnumId === "BmdOutgoing" && amount.compare(0) >= 0) return false
    const absolute = absOf(amount)
    if (rule.amountFrom != null && absolute.compare(toDecimal(rule.amountFrom)) < 0) return false
    if (rule.amountThru != null && absolute.compare(toDecimal(rule.amountThru)) > 0) return false
    const needle = String(rule.matchText || "")
        .trim()
        .toLowerCase()
    if (!needle) return false
    return [line.transName, line.transMemo, line.checkNumber, line.refNumber].some(text =>
        String(text || "")
            .toLowerCase()
            .includes(needle)
    )
}
// The open lines of the organization's bank accounts (one, with paymentMethodId), newest first.
function openLines(organizationPartyId, paymentMethodId, limit) {
    const methodIds = paymentMethodId
        ? [paymentMethodId]
        : Array.from(
              find("mantle.account.method.PaymentMethod", {ownerPartyId: organizationPartyId})
                  .selectField("paymentMethodId")
                  .list()
          ).map(row => row.paymentMethodId)
    if (!methodIds.length) return []
    return Array.from(
        unmatched(find(TRANS).condition("paymentMethodId", "in", methodIds))
            .orderBy("-postedDate,fitId")
            .limit(limit)
            .list()
    )
}
// For each line, what the rules suggest: the matching rules in priority order and the payments of the first rule's
// party. A line applies only when one rule with autoApply matches it, no other rule matches it, and that rule finds
// exactly one payment.
function ruleSuggestion(line, rules, method) {
    const matching = rules.filter(rule => ruleMatches(rule, line))
    if (!matching.length) return null
    const rule = matching[0]
    const found = rule.partyId ? candidates(line, method, {partyId: rule.partyId}) : []
    const conflicting = matching.length > 1 && matching.some(other => other.partyId !== rule.partyId)
    const ambiguous = conflicting || found.length !== 1
    return {
        bankMatchRuleId: rule.bankMatchRuleId,
        ruleDescription: rule.description || rule.matchText,
        matchingRuleIds: matching.map(other => other.bankMatchRuleId),
        candidateRows: found,
        ambiguous,
        reason: conflicting
            ? "More than one rule matches with different parties"
            : found.length === 0
              ? "No payment of the rule's party for this amount"
              : found.length > 1
                ? found.length + " payments of the rule's party for this amount"
                : "",
        wouldApply: rule.autoApply === "Y" && matching.length === 1 && found.length === 1
    }
}
// test#Rule: a stored rule, or one being written, against the open lines of the organization's banks: every line it
// matches with its candidates, whether the match is ambiguous and whether the rule would apply it.
function testRule(p) {
    const scope = bank({organizationPartyId: p.organizationPartyId, paymentMethodId: p.paymentMethodId, need: "read"})
    let rule = p.bankMatchRuleId ? one("mantle.account.method.BankMatchRule", {bankMatchRuleId: p.bankMatchRuleId}) : null
    if (p.bankMatchRuleId && (!rule || rule.organizationPartyId !== scope.organizationPartyId))
        denied("RULE_UNAVAILABLE", "The bank rule is not available")
    rule = Object.assign(
        {},
        rule ? lib.map(rule) : {},
        Object.fromEntries(
            ["matchText", "directionEnumId", "amountFrom", "amountThru", "partyId", "autoApply", "paymentMethodId"]
                .filter(field => p[field] != null && p[field] !== "")
                .map(field => [field, p[field]])
        )
    )
    if (!String(rule.matchText || "").trim()) denied("MATCH_TEXT_REQUIRED", "Give the text the rule matches")
    rule.bankMatchRuleId = rule.bankMatchRuleId || "_TEST_"
    if (p.sequenceNum != null && p.sequenceNum !== "") rule.sequenceNum = Number(p.sequenceNum)
    const others = activeRules(scope.organizationPartyId).filter(other => other.bankMatchRuleId !== rule.bankMatchRuleId)
    const methods = {}
    const methodOf = id => (methods[id] ??= one("mantle.account.method.PaymentMethod", {paymentMethodId: id}))
    const resultRows = []
    const claims = new Map()
    for (const line of openLines(scope.organizationPartyId, rule.paymentMethodId, 500)) {
        if (!ruleMatches(rule, line)) continue
        const matching = [rule].concat(others.filter(other => ruleMatches(other, line))).sort(byPriority)
        const suggestion = ruleSuggestion(line, matching, methodOf(line.paymentMethodId))
        const own = suggestion.bankMatchRuleId === rule.bankMatchRuleId
        resultRows.push(
            Object.assign(lineRow(line), {
                candidateRows: own ? suggestion.candidateRows : [],
                candidateCount: own ? suggestion.candidateRows.length : 0,
                ambiguous: suggestion.ambiguous || !own,
                reason: own ? suggestion.reason : "A rule with a higher priority matches the line first",
                wouldApply: own && suggestion.wouldApply
            })
        )
        if (own) for (const row of suggestion.candidateRows) claims.set(row.value, (claims.get(row.value) || 0) + 1)
        if (resultRows.length >= (Number(p.limit) || 50)) break
    }
    // a payment two lines would take is applied to neither: each stays a suggestion
    for (const row of resultRows) {
        if (row.candidateRows.length === 1 && claims.get(row.candidateRows[0].value) > 1) {
            row.ambiguous = true
            row.wouldApply = false
            row.reason = "Another line matches the same payment"
        }
    }
    return {
        resultRows,
        matchedCount: resultRows.length,
        applyCount: resultRows.filter(row => row.wouldApply).length,
        ambiguousCount: resultRows.filter(row => row.ambiguous).length
    }
}
// apply#Rules: the plan of what the organization's rules reconcile, line by line: only exact, unambiguous matches,
// and no payment twice. The service reconciles each planned line.
function ruleApplications(p) {
    const scope = bank({organizationPartyId: p.organizationPartyId, paymentMethodId: p.paymentMethodId, need: "reconcile"})
    const rules = activeRules(scope.organizationPartyId, p.paymentMethodId)
    const methods = {}
    const methodOf = id => (methods[id] ??= one("mantle.account.method.PaymentMethod", {paymentMethodId: id}))
    const planned = []
    const claims = new Map()
    let suggestedCount = 0
    for (const line of openLines(scope.organizationPartyId, p.paymentMethodId, 1000)) {
        const suggestion = ruleSuggestion(line, rules, methodOf(line.paymentMethodId))
        if (!suggestion) continue
        const candidate = suggestion.candidateRows[0]
        for (const row of suggestion.candidateRows) claims.set(row.value, (claims.get(row.value) || 0) + 1)
        if (suggestion.wouldApply)
            planned.push({
                paymentMethodId: line.paymentMethodId,
                fitId: line.fitId,
                candidate: candidate.value,
                paymentId: candidate.id,
                bankMatchRuleId: suggestion.bankMatchRuleId
            })
        else suggestedCount++
    }
    // a payment more than one line matches is applied to none of them
    const applications = planned.filter(row => claims.get(row.candidate) === 1)
    suggestedCount += planned.length - applications.length
    return {organizationPartyId: scope.organizationPartyId, applications, suggestedCount}
}

// apply#Rules: reconcile each planned line in its own transaction; a line that fails is named and the others go on.
function applyRules(p) {
    const plan = ruleApplications(p)
    const appliedRows = [],
        errorRows = []
    for (const application of plan.applications) {
        try {
            // reconcile#BankLine reads the line under lock and checks it is still open and the payment still a match
            lib.probe("mantle.account.ReconciliationServices.reconcile#BankLine", {
                paymentMethodId: application.paymentMethodId,
                fitId: application.fitId,
                candidate: application.candidate
            })
            appliedRows.push(application)
        } catch (error) {
            ec.logger.error("Bank rule " + application.bankMatchRuleId + " line " + application.fitId + ": " + error.message)
            errorRows.push(Object.assign({message: error.message}, application))
        }
    }
    return {appliedCount: appliedRows.length, suggestedCount: plan.suggestedCount, appliedRows, errorRows}
}

// ---------- bank line rows ----------

const stateTexts = {matched: "Matched", excluded: "Not reconciled", open: "Open"}
const stateColors = {matched: "positive", excluded: "grey", open: "warning"}
function lineRow(line, extra = {}) {
    const row = lib.display(line)
    const state = lineState(line)
    return Object.assign(row, {
        state,
        stateText: stateTexts[state],
        stateColor: stateColors[state],
        postedDateText: line.postedDate ? dayText(line.postedDate) : "",
        transAmount: line.transAmount == null ? null : decimalText(line.transAmount),
        description: [line.transName, line.transMemo].filter(Boolean).join(" · "),
        matchText: line.paymentId
            ? "Payment " + line.paymentId
            : line.paymentDepositId
              ? "Deposit " + line.paymentDepositId
              : line.acctgTransId
                ? "Ledger entry " + line.acctgTransId
                : line.noReconcile === "Y"
                  ? line.noReconcileReason || "No reason given"
                  : "",
        ...extra
    })
}
// The bank lines of a find#BankLines request, in its order.
function linesQuery(p, methodIds) {
    let query = find(TRANS).condition("paymentMethodId", "in", methodIds)
    if (p.lineState === "open") query = unmatched(query)
    else if (p.lineState === "matched") {
        const cf = ec.entity.conditionFactory
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("paymentId", "is-not-null", null),
                    cf.makeCondition("acctgTransId", "is-not-null", null),
                    cf.makeCondition("paymentDepositId", "is-not-null", null)
                ],
                "or"
            )
        )
    } else if (p.lineState === "excluded") query = query.condition("noReconcile", "Y")
    query = postedBetween(query, p.fromDay, p.thruDay)
    const term = String(p.text || "").trim()
    if (term) {
        const cf = ec.entity.conditionFactory
        const like = "%" + term.slice(0, 200) + "%"
        query = query.condition(
            cf.makeCondition(
                ["fitId", "transName", "transMemo", "checkNumber", "refNumber"].map(field =>
                    cf.makeCondition(field, "like", like).ignoreCase()
                ),
                "or"
            )
        )
    }
    return query.orderBy(p.oldestFirst ? "postedDate,fitId" : "-postedDate,fitId")
}
// find#BankLines: a page of a bank's lines (or of all the organization's banks, for open lines), with their state, the
// session that cleared each, and on request what the rules and amounts suggest for an open line.
function bankLines(p) {
    const scope = bank(Object.assign({}, p, {need: "read"}))
    const methodIds = p.paymentMethodId
        ? [p.paymentMethodId]
        : Array.from(
              find("mantle.account.method.PaymentMethod", {ownerPartyId: scope.organizationPartyId})
                  .condition("paymentMethodTypeEnumId", "in", ["PmtBankAccount", "PmtOther"])
                  .selectField("paymentMethodId")
                  .list()
          ).map(row => row.paymentMethodId)
    if (!methodIds.length) return lib.page(find(TRANS).condition("paymentMethodId", "_NA_"), p, "lineRows", 0)
    // a find is used once: one for the count, one for the page
    const recordCount = linesQuery(p, methodIds).count()
    const page = lib.page(linesQuery(p, methodIds), p, "lineRows", recordCount)
    const lines = page.rows
    const cleared = {}
    if (lines.length) {
        const cf = ec.entity.conditionFactory
        for (const row of find("mantle.account.method.BankReconciliationLine")
            .condition(
                cf.makeCondition(
                    lines.map(line =>
                        cf.makeCondition(
                            [
                                cf.makeCondition("paymentMethodId", "equals", line.paymentMethodId),
                                cf.makeCondition("fitId", "equals", line.fitId)
                            ],
                            "and"
                        )
                    ),
                    "or"
                )
            )
            .list())
            cleared[row.paymentMethodId + "|" + row.fitId] = row.bankReconciliationId
    }
    const rules = p.withSuggestions ? activeRules(scope.organizationPartyId) : []
    const methods = {}
    const methodOf = id => (methods[id] ??= one("mantle.account.method.PaymentMethod", {paymentMethodId: id}))
    const labels = Object.fromEntries(
        methodIds.length <= 50
            ? ec.resource
                  .script("component://mr-mantle/service/mantle/account/PaymentWorkflow.js")
                  .execute("maskedMethods", {
                      paymentMethodList: Array.from(
                          find("mantle.account.method.PaymentMethod").condition("paymentMethodId", "in", methodIds).list()
                      )
                  })
                  .methodRows.map(row => [row.paymentMethodId, row.label])
            : []
    )
    const lineRows = lines.map(line => {
        const extra = {
            bankReconciliationId: cleared[line.paymentMethodId + "|" + line.fitId] || null,
            bankLabel: labels[line.paymentMethodId] || line.paymentMethodId,
            currencyUomId: methodOf(line.paymentMethodId)?.currencyUomId || null
        }
        if (p.withSuggestions && lineState(line) === "open") {
            const method = methodOf(line.paymentMethodId)
            const suggestion = ruleSuggestion(line, rules, method)
            const found = suggestion ? suggestion.candidateRows : candidates(line, method)
            extra.suggestionText = found.length === 1 ? found[0].label : found.length ? found.length + " possible matches" : ""
            extra.suggestionReason = suggestion
                ? "Rule " + suggestion.ruleDescription + (suggestion.reason ? ": " + suggestion.reason : "")
                : found.length === 1
                  ? found[0].reason === "reference"
                      ? "Same reference and amount"
                      : "Same amount"
                  : found.length
                    ? "Several records have this amount"
                    : "Nothing has this amount"
            extra.ambiguous = suggestion ? suggestion.ambiguous : found.length !== 1
        }
        return lineRow(line, extra)
    })
    return Object.assign(page, {lineRows, organizationPartyId: scope.organizationPartyId})
}

// ---------- statement sessions ----------

// A session's figures: the cleared lines' inflow, outflow and total, the closing balance they give from the opening,
// the difference to the statement's closing balance, and the lines of the period that no session has cleared.
function figures(p) {
    const rec = p.reconciliation
    const lines = rows("mantle.account.method.BankReconciliationLine", {bankReconciliationId: rec.bankReconciliationId})
    let inflow = toDecimal(0),
        outflow = toDecimal(0)
    if (lines.length) {
        for (let i = 0; i < lines.length; i += 200) {
            const slice = lines.slice(i, i + 200)
            for (const line of find(TRANS, {paymentMethodId: rec.paymentMethodId})
                .condition(
                    "fitId",
                    "in",
                    slice.map(row => row.fitId)
                )
                .selectField("fitId,transAmount")
                .list()) {
                const amount = toDecimal(line.transAmount ?? 0)
                if (amount.compare(0) >= 0) inflow = inflow.add(amount)
                else outflow = outflow.add(amount.multiply(-1))
            }
        }
    }
    const opening = toDecimal(rec.openingBalance ?? 0)
    const closing = toDecimal(rec.closingBalance ?? 0)
    const computed = opening.add(inflow).subtract(outflow)
    const clearedIds = new Set(lines.map(row => row.fitId))
    let periodCount = 0,
        unclearedCount = 0
    for (const line of postedBetween(
        find(TRANS, {paymentMethodId: rec.paymentMethodId}),
        rec.statementFromDate,
        rec.statementThruDate
    )
        .selectField("fitId")
        .list()) {
        periodCount++
        if (!clearedIds.has(line.fitId)) unclearedCount++
    }
    return {
        clearedInflow: decimalText(inflow),
        clearedOutflow: decimalText(outflow),
        clearedTotal: decimalText(inflow.subtract(outflow)),
        clearedCount: lines.length,
        computedClosing: decimalText(computed),
        difference: decimalText(closing.subtract(computed)),
        periodCount,
        unclearedCount,
        rejectedImports: rejectedImports(rec)
    }
}
// The statement imports of the session's bank and period with rejected rows: a row the bank reported that is not a
// line yet, so a cause of the difference until it is added by hand or the closing balance corrected.
function rejectedImports(rec) {
    const from = lib.calendarDateText(rec.statementFromDate),
        thru = lib.calendarDateText(rec.statementThruDate)
    return rows("mantle.account.method.StatementImport", {paymentMethodId: rec.paymentMethodId})
        .filter(row => (row.rejectedCount || 0) > 0 && row.statementFromDate && row.statementThruDate)
        .filter(row => lib.calendarDateText(row.statementFromDate) <= thru && lib.calendarDateText(row.statementThruDate) >= from)
        .map(row => ({statementImportId: row.statementImportId, rejectedCount: row.rejectedCount, fileName: row.fileName || ""}))
}
// Whether a bank line may be cleared by the session: of its bank, posted in its period, and matched or excluded with a
// reason.
function clearable(p) {
    const rec = p.reconciliation,
        line = p.line
    if (!line || line.paymentMethodId !== rec.paymentMethodId) denied("BANK_LINE_UNAVAILABLE", "The bank line is not available")
    const day = dayText(line.postedDate)
    if (!day || day < lib.calendarDateText(rec.statementFromDate) || day > lib.calendarDateText(rec.statementThruDate))
        denied("BANK_LINE_OUTSIDE_PERIOD", "Bank line " + line.fitId + " is not in the statement period")
    const state = lineState(line)
    if (state === "open") denied("BANK_LINE_UNMATCHED", "Bank line " + line.fitId + " is not matched or excluded")
    if (state === "excluded" && !String(line.noReconcileReason || "").trim())
        denied("EXCLUSION_REASON_REQUIRED", "Bank line " + line.fitId + " is excluded without a reason")
    return {cleared: true}
}

// The statement imports the caller may read in Accounting (the framework's DataTransferServices.find#TargetRuns, for its
// list of every import target's runs): those of the organizations the caller's accounting scope covers, with the authority
// that reads a bank (bank reconciliation, accounting view or administration), newest first. Summaries only: no line, balance
// or account number.
function statementImportRuns(p) {
    let ids
    try {
        const c = policy.capabilities()
        if (!(c.bankReconcile || c.systemAdmin || c.reportRead || c.admin)) return {runList: []}
        ids = policy.access(c.read ? "read" : "bankReconcile").allowedOrganizationPartyIds
    } catch (error) {
        return {runList: []}
    }
    if (p.scopeKey) ids = ids.filter(id => id === p.scopeKey)
    if (!ids.length) return {runList: []}
    let query = find("mantle.account.method.StatementImport").condition("organizationPartyId", "in", ids)
    if (p.fromDate != null) query = query.condition("createdDate", "greater-equals", millisText(Number(p.fromDate)))
    if (p.thruDate != null) query = query.condition("createdDate", "less", millisText(Number(p.thruDate)))
    const states = {
        SimReview: ["open", "In review"],
        SimCommitting: ["running", "Committing"],
        SimCommitted: ["complete", "Committed"]
    }
    const names = new Map()
    const nameOf = (entityName, key, field) => {
        const id = Object.values(key)[0]
        if (id && !names.has(entityName + id)) names.set(entityName + id, one(entityName, key)?.[field] || id)
        return id ? names.get(entityName + id) : null
    }
    return {
        runList: Array.from(
            query
                .orderBy("-createdDate")
                .limit(Math.min(Number(p.maxRows) || 100, 200))
                .list()
        ).map(row => ({
            runId: row.statementImportId,
            fileLabel: row.fileName || "Bank statement",
            scopeKey: row.organizationPartyId,
            scopeTitle: nameOf("mantle.party.Organization", {partyId: row.organizationPartyId}, "organizationName"),
            state: (states[row.statusId] || ["open"])[0],
            stateText: (states[row.statusId] || [null, null])[1],
            startedDate: lib.ms(row.createdDate),
            userName: nameOf("moqui.security.UserAccount", {userId: row.createdByUserId}, "userFullName"),
            rowCount: row.totalCount,
            appliedCount: row.committedCount,
            errorCount: row.rejectedCount,
            skippedCount: row.duplicateCount,
            ownerParameters: {
                organizationPartyId: row.organizationPartyId,
                paymentMethodId: row.paymentMethodId,
                statementImportId: row.statementImportId
            }
        }))
    }
}

const operations = {
    statementImportRuns,
    bank,
    statement,
    lineOf,
    lineCandidates,
    candidateParameters,
    checkedCandidate,
    lineDay,
    dayAfter,
    methodLabel: p => ({label: methodLabel(p.method)}),
    testRule,
    applyRules,
    bankLines,
    figures,
    clearable
}
;({
    lineFields,
    execute: (op, p) => {
        if (!operations[op]) throw new Error("Unknown bank reconciliation operation " + op)
        return operations[op](p)
    }
})
