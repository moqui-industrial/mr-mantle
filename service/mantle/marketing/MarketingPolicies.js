// Marketing's settings (mantle.marketing.CampaignServices; IronStone Marketing design §12 CampaignDefaults and Vocabularies,
// §14.1; impl-marketing P2): an organization's MarketingPolicy, dated (a change starts a row and ends the one in effect; the history
// stays readable), its preview, and the vocabulary an organization offers.
//
// - get#MarketingPolicy, store#MarketingPolicy and preview#MarketingPolicy need MARKETING_CONFIGURE and an organization of the
//   caller's scope (PERMISSION_DENIED, ORGANIZATION_DENIED); a store names the revision of the policy it read (expectedPolicyId,
//   the one in effect, or none for the first: STALE_REVISION otherwise).
// - The one-person-team flag (selfApprovalAllowed) is off by default (§4 Nov 11): with it on an author may approve their own campaign
//   and their own send to fewer than 500 recipients, recorded as a self-approval (MarketingApprovals.js). The 500 is the user's call,
//   not a setting.
// - store#Vocabulary adds or ends a dated binding of a ContactListType or TrackingCodeType value, or a UTM source, medium or content
//   code with its label; one current binding per organization, kind and value (VALUE_TAKEN). find#Vocabulary answers a Marketing
//   reader. Writes need MARKETING_CONFIGURE.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const approvals = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingApprovals.js")
const {find, one, rows, denied, call} = lib

const POLICY = "mantle.marketing.campaign.MarketingPolicy"
const VOCABULARY = "mantle.marketing.campaign.MarketingVocabulary"
const DECISION = "mantle.marketing.campaign.MarketingDecision"
const CAMPAIGN = "mantle.marketing.campaign.MarketingCampaign"
const text = value => (value == null ? "" : String(value).trim())
const blank = value => value == null || value === ""
// The policy's settings: indicators and whole numbers of at least zero.
const indicatorFields = ["selfApprovalAllowed", "managerRequired"]
const countFields = [
    "audienceLimit",
    "frequencyCapCount",
    "frequencyCapDays",
    "recipientRetentionDays",
    "statisticsRetentionDays"
]

function configurer(organizationPartyId) {
    const userScope = marketingAccess.scope()
    marketingAccess.requireCapability(userScope, "configure")
    marketingAccess.requireOrganization(userScope, text(organizationPartyId))
    return userScope
}
const policyRow = row =>
    row
        ? {
              marketingPolicyId: row.marketingPolicyId,
              organizationPartyId: row.organizationPartyId,
              currencyUomId: row.currencyUomId || null,
              selfApprovalAllowed: row.selfApprovalAllowed === "Y" ? "Y" : "N",
              managerRequired: row.managerRequired === "N" ? "N" : "Y",
              audienceLimit: row.audienceLimit,
              frequencyCapCount: row.frequencyCapCount,
              frequencyCapDays: row.frequencyCapDays,
              recipientRetentionDays: row.recipientRetentionDays,
              statisticsRetentionDays: row.statisticsRetentionDays,
              explanation: row.explanation || "",
              testAddresses: row.testAddresses || "",
              fromDateText: lib.dateText(row.fromDate),
              thruDateText: lib.dateText(row.thruDate)
          }
        : null
// The values a store would write, checked.
function settingsOf(p) {
    const values = {currencyUomId: text(p.currencyUomId) || null}
    if (values.currencyUomId && !one("moqui.basic.Uom", {uomId: values.currencyUomId, uomTypeEnumId: "UT_CURRENCY_MEASURE"}))
        denied("CURRENCY_INVALID", "Currency " + values.currencyUomId + " is not a currency")
    for (const field of indicatorFields) values[field] = p[field] === "Y" || p[field] === true ? "Y" : "N"
    if (blank(p.managerRequired)) values.managerRequired = "Y"
    for (const field of countFields) {
        if (blank(p[field])) {
            values[field] = null
            continue
        }
        const number = Number(p[field])
        if (!Number.isInteger(number) || number < 0) denied("NUMBER_INVALID", field + " is a whole number of at least zero")
        values[field] = number
    }
    values.explanation = text(p.explanation) || null
    // P8: the test allowlist, a line an address, at most testAddressLimit, each one address
    const addresses = Array.from(
        new Set(
            String(p.testAddresses || "")
                .split(/[\s,;]+/)
                .map(address => address.trim().toLowerCase())
                .filter(Boolean)
        )
    )
    if (addresses.length > testAddressLimit)
        denied("VALUE_INVALID", "The test list holds at most " + testAddressLimit + " addresses")
    for (const address of addresses)
        if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(address) || address.length > 254)
            denied("VALUE_INVALID", "The test list takes addresses only: " + address.slice(0, 60))
    values.testAddresses = addresses.length ? addresses.join("\n") : null
    return values
}
const testAddressLimit = 10

// ===== get#MarketingPolicy =====
function get(p) {
    configurer(p.organizationPartyId)
    const organizationPartyId = text(p.organizationPartyId)
    const current = approvals.policyOf(organizationPartyId)
    const history = rows(POLICY, {organizationPartyId})
        .sort((a, b) => (lib.ms(b.fromDate) ?? 0) - (lib.ms(a.fromDate) ?? 0))
        .slice(0, 50)
        .map(policyRow)
    return {policy: policyRow(current), history, selfApprovalLimit: approvals.selfApprovalLimit}
}

// ===== preview#MarketingPolicy =====
// What the values would change, bounded: the campaigns awaiting approval whose authors could then approve their own (or could no
// longer), the planned campaigns that would then miss a manager, and what is missing (a currency); nothing written.
function preview(p) {
    configurer(p.organizationPartyId)
    const organizationPartyId = text(p.organizationPartyId)
    const values = settingsOf(p)
    const current = approvals.policyOf(organizationPartyId)
    const findings = []
    const was = current?.selfApprovalAllowed === "Y"
    const pending = approvals.pendingRows([organizationPartyId]).slice(0, 200)
    if (values.selfApprovalAllowed === "Y" && !was)
        findings.push({
            kind: "selfApproval",
            text: pending.length
                ? pending.length +
                  " awaiting approval could then be approved by their own authors, each recorded as a self-approval"
                : "An author could approve their own campaign, and their own send to fewer than 500 recipients, recorded as a self-approval"
        })
    if (values.selfApprovalAllowed !== "Y" && was)
        findings.push({
            kind: "selfApproval",
            text: "Authors could no longer approve their own; " + pending.length + " await another approver"
        })
    if (values.managerRequired === "Y" && current?.managerRequired === "N") {
        const planned = rows(CAMPAIGN, {organizationPartyId, statusId: "MKTG_CAMP_PLANNED"}).filter(campaign =>
            approvals.campaignProblems(campaign, {managerRequired: "Y"}).includes("it needs a manager")
        ).length
        if (planned) findings.push({kind: "manager", text: planned + " planned campaigns would need a manager before approval"})
    }
    if (!values.currencyUomId)
        findings.push({kind: "missing", text: "No currency: a new campaign takes the organization's accounting currency"})
    return {
        findings,
        effectiveText:
            "From " +
            lib.dateText(ec.user.nowTimestamp) +
            (current ? ", ending the policy in effect since " + lib.dateText(current.fromDate) : ""),
        pendingCount: pending.length
    }
}

// ===== store#MarketingPolicy =====
function store(p) {
    configurer(p.organizationPartyId)
    const organizationPartyId = text(p.organizationPartyId)
    const current = approvals.policyOf(organizationPartyId)
    const expected = text(p.expectedPolicyId)
    if ((current?.marketingPolicyId || "") !== expected)
        denied(
            "STALE_REVISION",
            "The policy changed since it was read" + (current ? "; the one in effect is " + current.marketingPolicyId : "")
        )
    const values = settingsOf(p)
    const now = ec.user.nowTimestamp
    if (current) call("update#" + POLICY, {marketingPolicyId: current.marketingPolicyId, thruDate: now})
    const marketingPolicyId = call(
        "create#" + POLICY,
        Object.assign({organizationPartyId, fromDate: now, createdByUserId: ec.user.userId}, values)
    ).marketingPolicyId
    return {marketingPolicyId}
}

// ===== vocabulary =====
// Each kind: enumeration-backed (its EnumerationType) or a coded UTM value.
const vocabularyKinds = {
    MvkListType: {name: "List type", enumTypeId: "ContactListType"},
    MvkTrackingCodeType: {name: "Tracking code type", enumTypeId: "TrackingCodeType"},
    MvkUtmSource: {name: "UTM source"},
    MvkUtmMedium: {name: "UTM medium"},
    MvkUtmContent: {name: "UTM content"}
}
const kindOf = kindId => {
    if (!Object.hasOwn(vocabularyKinds, kindId)) denied("KIND_INVALID", "Unknown kind of value " + kindId)
    return vocabularyKinds[kindId]
}
function storeVocabulary(p) {
    const organizationPartyId = text(p.organizationPartyId)
    const action = text(p.action) || "add"
    if (action === "end") {
        const row = one(VOCABULARY, {marketingVocabularyId: text(p.marketingVocabularyId)})
        if (!row) denied("RECORD_UNAVAILABLE", "That value is not available")
        configurer(row.organizationPartyId)
        if (!lib.active(row)) denied("RECORD_UNAVAILABLE", "That value is no longer offered")
        call("update#" + VOCABULARY, {marketingVocabularyId: row.marketingVocabularyId, thruDate: ec.user.nowTimestamp})
        return {marketingVocabularyId: row.marketingVocabularyId}
    }
    if (action !== "add") denied("ACTION_INVALID", "Add or end")
    configurer(organizationPartyId)
    const kindId = text(p.vocabularyKindEnumId)
    const kind = kindOf(kindId)
    const fields = {organizationPartyId, vocabularyKindEnumId: kindId, fromDate: ec.user.nowTimestamp}
    let key
    if (kind.enumTypeId) {
        const enumId = text(p.enumId)
        const enumeration = enumId ? one("moqui.basic.Enumeration", {enumId, enumTypeId: kind.enumTypeId}) : null
        if (!enumeration) denied("VALUE_INVALID", kind.name + " " + enumId + " is not one of its values")
        Object.assign(fields, {enumId, label: text(p.label) || enumeration.description || enumId})
        key = {enumId}
    } else {
        const vocabularyCode = text(p.vocabularyCode).toLowerCase()
        if (!/^[a-z0-9][a-z0-9_.-]{0,59}$/.test(vocabularyCode))
            denied("CODE_INVALID", "A code is letters, digits, dots, dashes and underscores, as in a link")
        Object.assign(fields, {vocabularyCode, label: text(p.label) || vocabularyCode})
        key = {vocabularyCode}
    }
    fields.channelEnumId = text(p.channelEnumId) || null
    fields.sequenceNum = blank(p.sequenceNum) ? null : Number(p.sequenceNum)
    if (rows(VOCABULARY, Object.assign({organizationPartyId, vocabularyKindEnumId: kindId}, key)).some(row => lib.active(row)))
        denied("VALUE_TAKEN", "This value is already offered")
    return {marketingVocabularyId: call("create#" + VOCABULARY, fields).marketingVocabularyId}
}
function findVocabulary(p) {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.anyRead) denied("PERMISSION_DENIED", "Marketing is not open to you")
    const organizationPartyId = text(p.organizationPartyId)
    marketingAccess.requireOrganization(userScope, organizationPartyId)
    let query = find(VOCABULARY, {organizationPartyId})
    if (text(p.vocabularyKindEnumId)) query = query.condition("vocabularyKindEnumId", text(p.vocabularyKindEnumId))
    const all = p.includeEnded === "Y" || p.includeEnded === true
    const found = Array.from(query.orderBy("vocabularyKindEnumId").orderBy("sequenceNum").orderBy("label").list()).filter(
        row => all || lib.active(row)
    )
    return {
        vocabularyList: found.map(row => ({
            marketingVocabularyId: row.marketingVocabularyId,
            vocabularyKindEnumId: row.vocabularyKindEnumId,
            kindText: vocabularyKinds[row.vocabularyKindEnumId]?.name || row.vocabularyKindEnumId,
            value: row.enumId || row.vocabularyCode,
            label: row.label || "",
            sequenceNum: row.sequenceNum,
            fromDateText: lib.dateText(row.fromDate),
            thruDateText: lib.dateText(row.thruDate),
            current: lib.active(row)
        }))
    }
}

const operations = {get, preview, store, storeVocabulary, findVocabulary}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing policy operation " + op)
        return operations[op](parameters || {})
    },
    vocabularyKinds
})
