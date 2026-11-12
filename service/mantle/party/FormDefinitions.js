// The survey builder's form definitions (design-drawers-commons §19, crosscut X16; impl-people P16, F51, F62: the builder of
// Customer Service's case templates, CaseTemplates.js, moved here so a second app's forms are built by the same rules). A form
// is a dated DbForm (isDated) owned by an organization (DbForm.ownerPartyId) for a purpose (DbForm.purposeEnumId); its fields,
// options and conditions (DbFormFieldDependency: show or require a field by another's value) are effective-dated rows of the
// framework (docs/ui/Db-Forms.md, org.moqui.impl.ScreenServices), each field with its audience (DbFormField.audienceEnumId:
// customer-visible or internal). A draft has no from date and Publish starts it; a published field's label, help, required
// flag, order and options change in place from now (the framework audit-logs them); a new type or audience, or a change from
// a later date, is a successor field from that date, so an answered field is never redefined and an internal answer never
// becomes customer-visible. The checks are a typed allowlist: the field types below, the four operators, show or require, a
// value that is one of the source field's options, no expression (${) in a label, help, option or value, no cycle (the
// framework's), and no customer field shown or required by an internal one; values are re-evaluated on the server (hidden
// fields dropped, required ones present, each of its type). No script of an administrator's runs.
//
// Who builds a form is its purpose's registration (mantle.party.FormPurpose): the permission that edits it and the one that
// reads it, the service that answers the organizations the user acts for (empty: the user's own internal organizations, as
// Customer Service's are), the publication access kinds a publication of it may take (none: it is answered only by the
// respondents an app's service assigns, with no public or invitation link) and the word the messages use for it. Customer
// Service's case templates and case feedback, and People's purposes (the interview scorecard, the review, the training
// assessment and the exit interview) are registered; Marketing registers its own. A form of a purpose with no registration is
// no form here. Refusals carry reason codes (EntityLib.denied); a missing form, one of another organization and one of an
// unregistered purpose are refused alike (RECORD_UNAVAILABLE), a purpose's permission not held is PERMISSION_DENIED.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const {find, one, rows, call, denied, access, ms} = lib

const FORM = "moqui.screen.form.DbForm",
    FIELD = "moqui.screen.form.DbFormField",
    OPTION = "moqui.screen.form.DbFormFieldOption",
    ATTRIBUTE = "moqui.screen.form.DbFormFieldAttribute",
    DEPENDENCY = "moqui.screen.form.DbFormFieldDependency",
    PURPOSE = "mantle.party.FormPurpose",
    INVITATION = "mantle.party.FormInvitation"
const S = "org.moqui.impl.ScreenServices."
const CUSTOMER = "CfaCustomer",
    INTERNAL = "CfaInternal"

// The field types a form offers, with what a value of each may be.
const TYPES = {
    "DBFFT_text-line": {label: "Short text", maxLength: 255},
    "DBFFT_text-area": {label: "Long text", maxLength: 4000},
    "DBFFT_drop-down": {label: "Choice list", choice: true},
    DBFFT_radio: {label: "Choice buttons", choice: true},
    DBFFT_check: {label: "Checkboxes", choice: true, multiple: true},
    "DBFFT_date-time": {label: "Date", date: true}
}
const OPERATORS = {equals: "is", "not-equals": "is not", empty: "is empty", "not-empty": "is filled in"}
const EFFECTS = {show: "Show", require: "Require"}
// a field never takes the name of a record field its app keeps beside the form (a case's own fields stay the Request's,
// design CS-TEMPLATES), nor of a screen parameter the builder or an answering page reads
const RESERVED = new Set([
    "requestId",
    "requestName",
    "description",
    "priority",
    "statusId",
    "requestTypeEnumId",
    "requestCategoryId",
    "salesChannelEnumId",
    "organizationPartyId",
    "customerPartyId",
    "contactPartyId",
    "assigneePartyId",
    "records",
    "communicationEventId",
    "emailMessageId",
    "templateFormId",
    "templateValues",
    "formId",
    "fieldName",
    "orderId",
    "subject",
    "tab",
    "appRoot",
    "invitationId",
    "employmentApplicationId",
    "workEffortId"
])

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const yn = value => (value === true || value === "Y" || value === "true" ? "Y" : "N")
const now = () => ec.user.nowTimestamp
const nowMs = () => Number(ms(now()))
const L = message => ec.l10n.localize(message)
const dateText = value => (value == null ? "" : ec.l10n.format(new Date(ms(value)), "d MMM yyyy HH:mm"))
// a submitted value as an array: a JS array or a host List (a multiple select's), else a comma-separated text
const asArray = value =>
    Array.isArray(value)
        ? value
        : value != null && typeof value === "object" && typeof value[Symbol.iterator] === "function"
          ? Array.from(value)
          : null
const valueList = value =>
    (asArray(value) ?? (value == null ? [] : String(value).split(",")))
        .map(part => String(part).trim())
        .filter(part => part !== "")
const hasExpression = value => String(value ?? "").includes("${")
function noExpression(value, what) {
    if (hasExpression(value)) denied("NO_EXPRESSIONS", what + " is text, not an expression (${...})")
}
const listOf = value =>
    (asArray(value) ?? (blank(value) ? [] : String(value).split(","))).map(part => String(part).trim()).filter(Boolean)

// ===== the purposes' registrations =====
// A purpose's registration, or null.
const registrationOf = purposeEnumId => (blank(purposeEnumId) ? null : one(PURPOSE, {purposeEnumId}))
// The word the messages use for a form of the purpose ("template" for a case template, else "form").
const nounOf = registration => registration?.formNoun || "form"
const canEdit = registration => !!registration && !blank(registration.editPermission) && access.has(registration.editPermission)
const canView = registration =>
    canEdit(registration) || (!!registration && !blank(registration.viewPermission) && access.has(registration.viewPermission))
// The publication access kinds a publication of a form of the purpose may take; none: assigned respondents only, no link.
const accessKinds = registration => listOf(registration?.accessEnumIds)
// The organizations the user builds and reads the purpose's forms for: the registered scope service's organizationPartyIds,
// else the user's own internal organizations (FacilityScope: every one for a system administrator); null is every one.
function organizationsFor(registration) {
    if (!blank(registration?.scopeServiceName)) {
        const out = call(registration.scopeServiceName, {})
        return Array.from(out.organizationPartyIds || []).map(String)
    }
    return facilityScope.scope().organizationPartyIds
}
const isInternal = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
function requireOrganization(registration, organizationPartyId) {
    const organizations = organizationsFor(registration)
    if (
        !organizationPartyId ||
        !isInternal(organizationPartyId) ||
        !(organizations == null || organizations.includes(String(organizationPartyId)))
    )
        denied("RECORD_UNAVAILABLE", "Organization " + (organizationPartyId || "") + " is not available")
    return String(organizationPartyId)
}
function requireEdit(registration) {
    if (!registration) denied("PURPOSE_UNAVAILABLE", "This kind of form is not built here")
    if (!canEdit(registration)) denied("PERMISSION_DENIED", registration.editPermission + " is required")
    return registration
}
// A form of a registered purpose (of purposes, when given) of one of the user's organizations for it, which the user may edit
// (view: or read; permission false: the caller checked); a missing form, one of an unregistered or another purpose and another
// organization's are refused alike.
function formOf(formId, options = {}) {
    const form = blank(formId) ? null : one(FORM, {formId})
    const registration = form ? registrationOf(form.purposeEnumId) : null
    const noun = options.noun || nounOf(registration)
    const label = noun.charAt(0).toUpperCase() + noun.substring(1)
    const unavailable = () => denied("RECORD_UNAVAILABLE", label + " " + (formId || "") + " is not available")
    if (!form || !registration || !form.ownerPartyId) unavailable()
    if (options.purposes && !options.purposes.includes(form.purposeEnumId)) unavailable()
    // permission false: the caller checks it (a case template's readers and its customer projection, CaseTemplates.js)
    if (options.permission !== false && (options.view ? !canView(registration) : !canEdit(registration)))
        denied("PERMISSION_DENIED", (options.view ? "Reading" : "Changing") + " this " + noun + " is not permitted")
    try {
        requireOrganization(registration, form.ownerPartyId)
    } catch (error) {
        unavailable()
    }
    return form
}

// ===== the form's rows =====
const fieldsOf = formId => rows(FIELD, {formId}).sort((a, b) => (a.layoutSequenceNum ?? 0) - (b.layoutSequenceNum ?? 0))
const optionsOf = (formId, fieldName) =>
    rows(OPTION, {formId, fieldName}).sort((a, b) => Number(a.sequenceNum) - Number(b.sequenceNum))
const dependenciesOf = formId => rows(DEPENDENCY, {formId})
// Whether a row is in effect at a time: started (or a draft, when drafts count) and not ended.
function inEffectAt(row, at, drafts) {
    const thru = ms(row.thruDate)
    if (thru != null && thru <= at) return false
    const from = ms(row.fromDate)
    return from == null ? !!drafts : from <= at
}
const ended = row => row.thruDate != null && ms(row.thruDate) <= nowMs()
const isDraft = row => row.fromDate == null
const audienceOf = row => (row?.audienceEnumId === CUSTOMER ? CUSTOMER : INTERNAL)

// The form as of a date, as the framework renders it (ec.screen.getFormNode: the rows in effect, a draft in place of the
// field it replaces when drafts count): its fields in order, each with its row's type and audience, its options and its show
// and require rules.
function formAt(formId, asOfDate, drafts) {
    const node = ec.screen.getFormNode("DbForm#" + formId, asOfDate ?? null, !!drafts)
    const byName = new Map(fieldsOf(formId).map(row => [row.fieldName, row]))
    const rule = node =>
        node
            ? {
                  field: node.attribute("field"),
                  operator: node.attribute("operator") || "equals",
                  value: node.attribute("value") ?? ""
              }
            : null
    return node
        .children("field")
        .map(fieldNode => {
            const name = fieldNode.attribute("name")
            const row = byName.get(name)
            const sub = fieldNode.first("default-field") || fieldNode.first("conditional-field")
            if (!row || !sub) return null
            const widget = sub.children().find(kid => kid.name !== "visible-when" && kid.name !== "require-when") || null
            return {
                fieldName: name,
                title: sub.attribute("title") || row.title || name,
                tooltip: sub.attribute("tooltip") || "",
                fieldTypeEnumId: row.fieldTypeEnumId,
                required: sub.attribute("required") === "true",
                audienceEnumId: audienceOf(row),
                options: widget
                    ? widget.children("option").map(option => ({key: option.attribute("key"), text: option.attribute("text")}))
                    : [],
                show: rule(sub.first("visible-when")),
                require: rule(sub.first("require-when")),
                row
            }
        })
        .filter(Boolean)
}
// The fields a customer sees of a form as of a date: the customer-visible ones, with the rules among them (a rule on an
// internal field is never a customer field's; the checks refuse one).
function customerProjection(fields) {
    const names = new Set(fields.filter(field => field.audienceEnumId === CUSTOMER).map(field => field.fieldName))
    return fields
        .filter(field => names.has(field.fieldName))
        .map(field =>
            Object.assign({}, field, {
                show: field.show && names.has(field.show.field) ? field.show : null,
                require: field.require && names.has(field.require.field) ? field.require : null
            })
        )
}

// ===== values =====
// Submitted values against the form as of a date for an audience (internal: every field; customer: the customer-visible
// fields, and a value for another field is refused): which fields show and which are required, by the framework's
// evaluate#DbFormDependencies; a hidden field's value is dropped; each value of its type (a choice one of the field's options
// as of the date, a date a date, a text within its length). Values for names not on the form are left out.
function checkValues(formId, values, audience = "internal", asOfDate = null, drafts = false) {
    const all = formAt(formId, asOfDate, drafts)
    const customer = audience === "customer"
    const fields = customer ? all.filter(field => field.audienceEnumId === CUSTOMER) : all
    const submitted = {}
    const errors = []
    const given = Object.assign({}, values || {})
    for (const field of all) {
        if (!Object.prototype.hasOwnProperty.call(given, field.fieldName)) continue
        const raw = given[field.fieldName]
        if (customer && field.audienceEnumId !== CUSTOMER) {
            if (valueList(raw).length)
                errors.push({
                    fieldName: field.fieldName,
                    code: "FIELD_NOT_OFFERED",
                    message: L("This field is not on the customer's form")
                })
            continue
        }
        submitted[field.fieldName] = asArray(raw) ? asArray(raw).map(String) : raw == null ? null : String(raw)
    }
    const evaluated = call(S + "evaluate#DbFormDependencies", {
        formId,
        values: submitted,
        asOfDate: asOfDate || null,
        includeDrafts: !!drafts
    })
    const own = new Set(fields.map(field => field.fieldName))
    const visible = Array.from(evaluated.visibleFieldNames || []).filter(name => own.has(name))
    const hidden = Array.from(evaluated.hiddenFieldNames || []).filter(name => own.has(name))
    const required = Array.from(evaluated.requiredFieldNames || []).filter(name => own.has(name))
    const missing = Array.from(evaluated.missingFieldNames || []).filter(name => own.has(name))
    const cleaned = {}
    for (const field of fields) {
        if (!visible.includes(field.fieldName)) continue
        const parts = valueList(submitted[field.fieldName])
        if (missing.includes(field.fieldName)) {
            errors.push({fieldName: field.fieldName, code: "REQUIRED", message: field.title + " " + L("is required")})
            continue
        }
        if (!parts.length) continue
        const type = TYPES[field.fieldTypeEnumId]
        const fail = (code, message) => errors.push({fieldName: field.fieldName, code, message: field.title + ": " + L(message)})
        if (!type) {
            fail("FIELD_TYPE", "this kind of field is not taken")
            continue
        }
        if (type.choice) {
            const keys = field.options.map(option => option.key)
            if (!type.multiple && parts.length > 1) fail("ONE_CHOICE", "choose one")
            else if (parts.some(part => !keys.includes(part))) fail("CHOICE_UNKNOWN", "choose one of its options")
            else cleaned[field.fieldName] = parts.join(",")
        } else if (type.date) {
            const value = String(submitted[field.fieldName]).trim()
            if (!/^\d{4}-\d{2}-\d{2}/.test(value) || Number.isNaN(Date.parse(value.substring(0, 10))))
                fail("DATE_INVALID", "enter a date")
            else cleaned[field.fieldName] = value.substring(0, 10)
        } else {
            const value = String(submitted[field.fieldName]).trim()
            if (value.length > type.maxLength) fail("TOO_LONG", "at most " + type.maxLength + " characters")
            else if (hasExpression(value)) fail("NO_EXPRESSIONS", "the text holds ${, which a value may not")
            else cleaned[field.fieldName] = value
        }
    }
    return {
        values: cleaned,
        visibleFieldNames: visible,
        hiddenFieldNames: hidden,
        requiredFieldNames: required,
        missingFieldNames: missing,
        errors,
        valid: errors.length === 0
    }
}
// A response's answers with the form as of the response's date (its labels and option texts then): each answered field's
// name, title, value and display text, in the form's order.
function answersOf(formId, responseDate, responseMap) {
    const answers = responseMap || {}
    return formAt(formId, responseDate, false)
        .filter(field => Object.prototype.hasOwnProperty.call(answers, field.fieldName) && !blank(answers[field.fieldName]))
        .map(field => {
            const raw = answers[field.fieldName]
            const parts = valueList(raw)
            return {
                fieldName: field.fieldName,
                title: field.title,
                fieldTypeEnumId: field.fieldTypeEnumId,
                valueText: String(raw),
                displayText: TYPES[field.fieldTypeEnumId]?.choice
                    ? parts.map(part => field.options.find(option => option.key === part)?.text || part).join(", ")
                    : String(raw)
            }
        })
}

// ===== the form's checks =====
// The problems of a form as of a date (drafts too, by default: what Publish would start): no field, a field of a type outside
// the allowlist or a choice with no option, an expression in its text, a rule on a field not in the form, a value not among
// its source field's options, a customer field shown or required by an internal one, and a cycle.
function problemsOf(formId, asOfDate = null, drafts = true, noun = "form") {
    const fields = formAt(formId, asOfDate, drafts)
    const problems = []
    const problem = (code, message, fieldName = null) => problems.push({code, message: L(message), fieldName})
    if (!fields.length) problem("TEMPLATE_EMPTY", "The " + noun + " has no field")
    const byName = new Map(fields.map(field => [field.fieldName, field]))
    const edges = new Map()
    for (const field of fields) {
        const type = TYPES[field.fieldTypeEnumId]
        if (!type) problem("FIELD_TYPE", field.title + ": this kind of field is not offered on a " + noun, field.fieldName)
        else if (type.choice && !field.options.length)
            problem("OPTIONS_REQUIRED", field.title + ": add its options", field.fieldName)
        if ([field.title, field.tooltip].concat(field.options.map(option => option.text)).some(hasExpression))
            problem("NO_EXPRESSIONS", field.title + ": its text holds an expression", field.fieldName)
        for (const rule of [field.show, field.require].filter(Boolean)) {
            const source = byName.get(rule.field)
            if (!source) continue
            if (!edges.has(source.fieldName)) edges.set(source.fieldName, [])
            edges.get(source.fieldName).push(field.fieldName)
            if (field.audienceEnumId === CUSTOMER && source.audienceEnumId !== CUSTOMER)
                problem(
                    "CONDITION_AUDIENCE",
                    field.title + " is customer-visible, so it cannot depend on the internal field " + source.title,
                    field.fieldName
                )
            if ((rule.operator === "equals" || rule.operator === "not-equals") && !TYPES[source.fieldTypeEnumId]?.choice)
                problem(
                    "CONDITION_OPERATOR",
                    field.title + ": its condition compares " + source.title + ", which is not a choice, with a value",
                    field.fieldName
                )
            else if ((rule.operator === "equals" || rule.operator === "not-equals") && TYPES[source.fieldTypeEnumId]?.choice) {
                const keys = source.options.map(option => option.key)
                if (valueList(rule.value).some(part => !keys.includes(part)))
                    problem(
                        "CONDITION_VALUE",
                        field.title + ": its condition names a value " + source.title + " does not offer",
                        field.fieldName
                    )
            }
        }
    }
    const state = new Map()
    const visit = name => {
        if (state.get(name) === "done") return false
        if (state.get(name) === "open") return true
        state.set(name, "open")
        const cycle = (edges.get(name) || []).some(visit)
        state.set(name, "done")
        return cycle
    }
    if (Array.from(edges.keys()).some(visit)) problem("CONDITION_CYCLE", "The conditions make a cycle")
    return problems
}
// A change of published rows (in place from now, or a successor from a date) leaves the form as of then with no problem it
// did not have, else nothing is changed (TEMPLATE_INVALID): create#DbFormFieldSuccessor copies the old field's conditions, and
// an ended option can leave a condition naming it, so a customer field could come to depend on an internal one, or a condition
// compare a value its source no longer offers or a field that is no longer a choice.
function keepValid(formId, at, change) {
    const key = problem => problem.code + "|" + (problem.fieldName || "")
    const before = new Set(problemsOf(formId, at, false).map(key))
    const out = change()
    const added = problemsOf(formId, at, false).filter(problem => !before.has(key(problem)))
    if (added.length) denied("TEMPLATE_INVALID", Array.from(new Set(added.map(problem => problem.message))).join("; "))
    return out
}

// ===== reads =====
const typeText = fieldTypeEnumId => (TYPES[fieldTypeEnumId] ? L(TYPES[fieldTypeEnumId].label) : fieldTypeEnumId || "")
const audienceText = audienceEnumId => L(audienceEnumId === CUSTOMER ? "Customer-visible" : "Internal")
const stateOf = row =>
    isDraft(row)
        ? {state: "draft", stateText: L("Draft")}
        : ms(row.fromDate) > nowMs()
          ? {state: "later", stateText: L("From") + " " + dateText(row.fromDate)}
          : row.thruDate != null
            ? {state: "ending", stateText: L("Until") + " " + dateText(row.thruDate)}
            : {state: "current", stateText: L("Since") + " " + dateText(row.fromDate)}
const conditionText = (row, titles) =>
    (EFFECTS[row.effect] || row.effect) +
    " " +
    (titles.get(row.targetFieldName) || row.targetFieldName) +
    " " +
    L("when") +
    " " +
    (titles.get(row.sourceFieldName) || row.sourceFieldName) +
    " " +
    (OPERATORS[row.operator] || row.operator) +
    (row.operator === "equals" || row.operator === "not-equals" ? " " + row.value : "")
// A form's summary: its name, organization, state (draft, published, changes to publish), first published and last change.
function summaryOf(form) {
    const fields = fieldsOf(form.formId)
    const live = fields.filter(row => !ended(row))
    const drafts =
        live.filter(isDraft).length +
        rows(OPTION, {formId: form.formId}).filter(isDraft).length +
        dependenciesOf(form.formId).filter(isDraft).length
    const started = fields.filter(row => !isDraft(row)).map(row => Number(ms(row.fromDate)))
    const changed = fields
        .concat(dependenciesOf(form.formId))
        .map(row => Number(ms(row.lastUpdatedStamp) || 0))
        .concat([Number(ms(form.lastUpdatedStamp) || 0)])
    const published = live.some(row => !isDraft(row) && inEffectAt(row, nowMs(), false))
    return {
        formId: form.formId,
        description: form.description || form.formId,
        comments: form.comments || "",
        organizationPartyId: form.ownerPartyId,
        purposeEnumId: form.purposeEnumId,
        published,
        hasDrafts: drafts > 0,
        stateText: !published ? L("Draft") : drafts ? L("Changes to publish") : L("Published"),
        stateColor: !published ? "warning" : drafts ? "info" : "positive",
        publishedFromText: started.length ? dateText(Math.min(...started)) : "",
        lastChangeText: dateText(Math.max(...changed)),
        customerFieldCount: live.filter(row => !isDraft(row) && audienceOf(row) === CUSTOMER).length,
        internalFieldCount: live.filter(row => !isDraft(row) && audienceOf(row) !== CUSTOMER).length
    }
}
// The fields of a form as of a date for an audience, as a reader sees them.
const fieldRows = shown =>
    shown.map(field => ({
        fieldName: field.fieldName,
        title: field.title,
        tooltip: field.tooltip,
        fieldTypeEnumId: field.fieldTypeEnumId,
        typeText: typeText(field.fieldTypeEnumId),
        required: field.required,
        audienceEnumId: field.audienceEnumId,
        audienceText: audienceText(field.audienceEnumId),
        options: field.options,
        show: field.show,
        require: field.require
    }))
// The rows an editor works on: every field, option and condition not ended, each with its state, and the problems.
function editRows(form, noun = "form") {
    const live = fieldsOf(form.formId).filter(row => !ended(row))
    const titles = new Map(fieldsOf(form.formId).map(row => [row.fieldName, row.title || row.fieldName]))
    const editFields = live.map(row => {
        const options = optionsOf(form.formId, row.fieldName).filter(option => !ended(option))
        return Object.assign(
            {
                fieldName: row.fieldName,
                title: row.title || row.fieldName,
                tooltip: row.tooltip || "",
                fieldTypeEnumId: row.fieldTypeEnumId,
                typeText: typeText(row.fieldTypeEnumId),
                isRequired: row.isRequired === "Y" ? "Y" : "N",
                requiredText: row.isRequired === "Y" ? L("Required") : "",
                audienceEnumId: audienceOf(row),
                audienceText: audienceText(audienceOf(row)),
                audienceColor: audienceOf(row) === CUSTOMER ? "positive" : "warning",
                layoutSequenceNum: row.layoutSequenceNum ?? "",
                replacesFieldName: row.replacesFieldName || "",
                replacesText: row.replacesFieldName
                    ? L("Replaces") + " " + (titles.get(row.replacesFieldName) || row.replacesFieldName)
                    : "",
                options: options.map(option => ({
                    sequenceNum: option.sequenceNum,
                    keyValue: option.keyValue,
                    text: option.text,
                    draft: isDraft(option)
                })),
                optionText: options
                    .map(option => (option.keyValue === option.text ? option.text : option.keyValue + " | " + option.text))
                    .join("\n"),
                optionSummary: options.map(option => option.text).join(", "),
                choice: !!TYPES[row.fieldTypeEnumId]?.choice,
                draft: isDraft(row)
            },
            stateOf(row)
        )
    })
    const conditions = dependenciesOf(form.formId)
        .filter(row => !ended(row))
        .sort((a, b) => String(a.dependencySeqId).localeCompare(String(b.dependencySeqId)))
        .map(row =>
            Object.assign(
                {
                    dependencySeqId: row.dependencySeqId,
                    sourceFieldName: row.sourceFieldName,
                    operator: row.operator || "equals",
                    value: row.value || "",
                    targetFieldName: row.targetFieldName,
                    effect: row.effect,
                    conditionText: conditionText(row, titles),
                    draft: isDraft(row)
                },
                stateOf(row)
            )
        )
    return {editFields, conditions, problems: problemsOf(form.formId, null, true, noun)}
}

// ===== saves =====
function checkOptions(lines, fieldTitle) {
    const options = []
    for (const line of String(lines || "").split(/\r?\n/)) {
        if (blank(line)) continue
        const at = line.indexOf("|")
        const keyValue = (at >= 0 ? line.substring(0, at) : line).trim()
        const optionText = (at >= 0 ? line.substring(at + 1) : line).trim() || keyValue
        if (!keyValue) continue
        if (keyValue.includes(",") || keyValue.length > 60)
            denied("OPTION_INVALID", fieldTitle + ": an option's value has no comma and at most 60 characters")
        noExpression(keyValue + optionText, fieldTitle + ": an option")
        if (options.some(option => option.keyValue === keyValue))
            denied("OPTION_DUPLICATE", fieldTitle + ": " + keyValue + " is offered twice")
        options.push({keyValue, text: optionText.substring(0, 255)})
    }
    return options
}
// A field name from its title: lower camel case of its letters and digits, not a reserved name nor one the form has (ended
// ones too, since their answers keep the name).
function newFieldName(formId, title, given, noun = "form") {
    const taken = new Set(fieldsOf(formId).map(row => row.fieldName))
    if (!blank(given)) {
        const name = String(given).trim()
        if (!/^[a-z][A-Za-z0-9]{1,59}$/.test(name) || RESERVED.has(name))
            denied("FIELD_NAME_INVALID", name + " is not a field name a " + noun + " may use")
        if (taken.has(name)) denied("FIELD_NAME_TAKEN", "The " + noun + " has a field " + name)
        return name
    }
    const words = String(title)
        .normalize("NFD")
        .replace(/[^A-Za-z0-9 ]+/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    let base = words
        .map((word, index) => (index ? word[0].toUpperCase() + word.substring(1).toLowerCase() : word.toLowerCase()))
        .join("")
    if (!/^[a-z]/.test(base)) base = "field" + base
    base = base.substring(0, 50)
    if (base.length < 2) base = "field"
    for (let n = 1; ; n++) {
        const name = n === 1 ? base : base + n
        if (!taken.has(name) && !RESERVED.has(name)) return name
    }
}
// The options of a field as lines of "value | label": a draft field's are replaced; a published field's keep their value,
// a new label changed in place (audit-logged), a new value added and a removed one ended, all from now.
function storeOptions(formId, fieldName, options, published) {
    const existing = optionsOf(formId, fieldName).filter(option => !ended(option))
    let next = Math.max(0, ...rows(OPTION, {formId, fieldName}).map(option => Number(option.sequenceNum))) + 1
    for (const option of existing) {
        const wanted = options.find(item => item.keyValue === option.keyValue)
        if (!wanted) {
            if (isDraft(option)) call(S + "delete#DbFormFieldOption", {formId, fieldName, sequenceNum: option.sequenceNum})
            else call(S + "end#DbFormFieldOption", {formId, fieldName, sequenceNum: option.sequenceNum})
        } else if (wanted.text !== option.text) {
            call("update#" + OPTION, {formId, fieldName, sequenceNum: option.sequenceNum, text: wanted.text})
        }
    }
    for (const option of options) {
        if (existing.some(row => row.keyValue === option.keyValue)) continue
        call("create#" + OPTION, {
            formId,
            fieldName,
            sequenceNum: next++,
            keyValue: option.keyValue,
            text: option.text,
            fromDate: published ? now() : null
        })
    }
}
// A new field (a draft) or a change of one of a form the caller checked (formOf). A draft changes in place; a published
// field's label, help, required flag, order and options change in place from now; its type or audience, or any change from a
// later fromDate, makes a successor field (a draft, or started at fromDate with the old one ended then). An ended field is not
// changed (FIELD_ENDED). The audience is the one given (customer-visible or internal), internal when none.
function saveFieldOf(form, p, noun = "form") {
    const formId = form.formId
    const title = text(p.title)
    if (!title) denied("TITLE_REQUIRED", "A field needs a label")
    noExpression(title, "A label")
    noExpression(p.tooltip, "Help text")
    const fieldTypeEnumId = text(p.fieldTypeEnumId) || "DBFFT_text-line"
    if (!TYPES[fieldTypeEnumId]) denied("FIELD_TYPE", fieldTypeEnumId + " is not a kind of field a " + noun + " offers")
    const audienceEnumId =
        p.audienceEnumId === CUSTOMER ? CUSTOMER : blank(p.audienceEnumId) || p.audienceEnumId === INTERNAL ? INTERNAL : null
    if (!audienceEnumId) denied("AUDIENCE_INVALID", p.audienceEnumId + " is not an audience")
    const options = TYPES[fieldTypeEnumId].choice ? checkOptions(p.optionText, title) : []
    if (TYPES[fieldTypeEnumId].choice && !options.length) denied("OPTIONS_REQUIRED", title + ": add its options, one a line")
    const fields = {
        title: title.substring(0, 255),
        tooltip: text(p.tooltip),
        isRequired: yn(p.isRequired),
        layoutSequenceNum: blank(p.layoutSequenceNum) ? null : Number(p.layoutSequenceNum)
    }
    if (fields.layoutSequenceNum != null && !Number.isInteger(fields.layoutSequenceNum))
        denied("ORDER_INVALID", "The order is a whole number")
    const fromDate = blank(p.fromDate) ? null : p.fromDate
    if (fromDate != null && Number(ms(fromDate)) < nowMs() - 5000) denied("DATE_PAST", "A change starts now or later")
    const dateAttribute = name => {
        if (fieldTypeEnumId === "DBFFT_date-time")
            call("create#" + ATTRIBUTE, {formId, fieldName: name, attributeName: "type", value: "date"})
    }
    if (blank(p.fieldName)) {
        const fieldName = newFieldName(formId, title, p.newFieldName, noun)
        if (fields.layoutSequenceNum == null)
            fields.layoutSequenceNum = Math.max(0, ...fieldsOf(formId).map(row => Number(row.layoutSequenceNum || 0))) + 10
        call("create#" + FIELD, Object.assign({formId, fieldName, fieldTypeEnumId, audienceEnumId, fromDate: null}, fields))
        dateAttribute(fieldName)
        storeOptions(formId, fieldName, options, false)
        return {fieldName}
    }
    const row = one(FIELD, {formId, fieldName: p.fieldName})
    if (!row) denied("FIELD_UNAVAILABLE", "The " + noun + " has no field " + p.fieldName)
    if (ended(row)) denied("FIELD_ENDED", (row.title || row.fieldName) + " has ended; add a new field")
    if (isDraft(row) && fromDate == null) {
        call("update#" + FIELD, Object.assign({formId, fieldName: row.fieldName, fieldTypeEnumId, audienceEnumId}, fields))
        if (row.fieldTypeEnumId !== fieldTypeEnumId) {
            for (const attribute of rows(ATTRIBUTE, {formId, fieldName: row.fieldName})) attribute.delete()
            dateAttribute(row.fieldName)
        }
        storeOptions(formId, row.fieldName, options, false)
        return {fieldName: row.fieldName}
    }
    const redefines = row.fieldTypeEnumId !== fieldTypeEnumId || audienceOf(row) !== audienceEnumId
    if (redefines || fromDate != null) {
        // a new meaning, or a change from a later date: a successor field, the old one's answers keeping its name
        if (isDraft(row)) denied("FIELD_DRAFT", "Publish " + (row.title || row.fieldName) + " first, or change the draft itself")
        // with no date a draft that Publish starts (and checks); with one (now or later) it starts then and the old field
        // ends then, its conditions copied to the successor
        const makeSuccessor = () => {
            const out = call(S + "create#DbFormFieldSuccessor", {
                formId,
                fieldName: row.fieldName,
                fromDate,
                copyOptions: false,
                title: fields.title,
                tooltip: fields.tooltip,
                fieldTypeEnumId,
                isRequired: fields.isRequired,
                layoutSequenceNum: fields.layoutSequenceNum ?? row.layoutSequenceNum
            })
            const successor = out.newFieldName
            call("update#" + FIELD, {formId, fieldName: successor, audienceEnumId})
            for (const attribute of rows(ATTRIBUTE, {formId, fieldName: successor})) attribute.delete()
            dateAttribute(successor)
            for (const option of options)
                call("create#" + OPTION, {
                    formId,
                    fieldName: successor,
                    sequenceNum: options.indexOf(option) + 1,
                    keyValue: option.keyValue,
                    text: option.text,
                    fromDate
                })
            return {fieldName: successor, successor: true}
        }
        return fromDate == null ? makeSuccessor() : keepValid(formId, fromDate, makeSuccessor)
    }
    // in place from now (title and required audit-logged), through the entity: a published field's dates and audience stay
    return keepValid(formId, null, () => {
        call("update#" + FIELD, Object.assign({formId, fieldName: row.fieldName}, fields))
        storeOptions(formId, row.fieldName, options, true)
        return {fieldName: row.fieldName}
    })
}
// A condition row of a form the caller checked (the typed condition builder, F71): show or require the target field while the
// source field is (not) one of its options, or is empty or filled in. A choice field compares by its options; any other field
// only by empty or filled in. A customer-visible field never depends on an internal one (CONDITION_AUDIENCE). Between published
// fields it starts now (an edit of a published one ends it and starts its replacement now); with a draft field it is a draft.
// The framework refuses a cycle (CONDITION_CYCLE) and a second rule of one effect on a field (CONDITION_DUPLICATE).
function saveConditionOf(form, p, noun = "form") {
    const formId = form.formId
    const operator = text(p.operator) || "equals"
    if (!OPERATORS[operator]) denied("OPERATOR_INVALID", operator + " is not a condition")
    const effect = text(p.effect) || "show"
    if (!EFFECTS[effect]) denied("EFFECT_INVALID", effect + " is not show or require")
    const live = name => {
        const row = blank(name) ? null : one(FIELD, {formId, fieldName: name})
        if (!row || ended(row)) denied("FIELD_UNAVAILABLE", "The " + noun + " has no field " + (name || ""))
        return row
    }
    const source = live(p.sourceFieldName)
    const target = live(p.targetFieldName)
    if (source.fieldName === target.fieldName) denied("CONDITION_SELF", "A field does not depend on itself")
    if (audienceOf(target) === CUSTOMER && audienceOf(source) !== CUSTOMER)
        denied(
            "CONDITION_AUDIENCE",
            (target.title || target.fieldName) +
                " is customer-visible, so it cannot depend on the internal field " +
                (source.title || source.fieldName)
        )
    let value = null
    if (operator === "equals" || operator === "not-equals") {
        if (!TYPES[source.fieldTypeEnumId]?.choice)
            denied("OPERATOR_INVALID", (source.title || source.fieldName) + " is not a choice: use is empty or is filled in")
        const keys = optionsOf(formId, source.fieldName)
            .filter(option => !ended(option))
            .map(option => option.keyValue)
        const parts = valueList(p.value)
        if (!parts.length) denied("VALUE_REQUIRED", "Choose the value the condition compares with")
        if (parts.some(part => !keys.includes(part)))
            denied(
                "CONDITION_VALUE",
                (source.title || source.fieldName) + " does not offer " + parts.filter(part => !keys.includes(part)).join(", ")
            )
        value = parts.join(",")
    }
    const published = !isDraft(source) && !isDraft(target)
    const old = blank(p.dependencySeqId) ? null : one(DEPENDENCY, {formId, dependencySeqId: p.dependencySeqId})
    if (!blank(p.dependencySeqId) && (!old || ended(old)))
        denied("CONDITION_UNAVAILABLE", "The " + noun + " has no condition " + p.dependencySeqId)
    try {
        const out = call(S + "store#DbFormFieldDependency", {
            formId,
            dependencySeqId: old?.dependencySeqId || null,
            sourceFieldName: source.fieldName,
            operator,
            value,
            targetFieldName: target.fieldName,
            effect,
            // a new row between published fields starts now; an edit of a published one is replaced from now by the framework
            fromDate: !old && published ? now() : undefined
        })
        return {dependencySeqId: out.dependencySeqId}
    } catch (error) {
        const message = String(error.message || error)
        if (/cycle/i.test(message)) denied("CONDITION_CYCLE", message)
        if (/already has/i.test(message)) denied("CONDITION_DUPLICATE", message)
        throw error
    }
}
// A field (with its conditions), an option or a condition of a form the caller checked ends at thruDate (now or later); a
// draft one is deleted, never having been in effect.
function endPartOf(form, p, noun = "form") {
    const formId = form.formId
    const thruDate = blank(p.thruDate) ? null : p.thruDate
    if (p.part === "condition") {
        const row = one(DEPENDENCY, {formId, dependencySeqId: p.dependencySeqId || ""})
        if (!row || ended(row)) denied("CONDITION_UNAVAILABLE", "The " + noun + " has no condition " + (p.dependencySeqId || ""))
        if (isDraft(row)) row.delete()
        else call(S + "end#DbFormFieldDependency", {formId, dependencySeqId: row.dependencySeqId, thruDate})
        return {}
    }
    const field = one(FIELD, {formId, fieldName: p.fieldName || ""})
    if (!field || ended(field)) denied("FIELD_UNAVAILABLE", "The " + noun + " has no field " + (p.fieldName || ""))
    if (p.part === "option") {
        const option = one(OPTION, {formId, fieldName: field.fieldName, sequenceNum: p.sequenceNum})
        if (!option || ended(option)) denied("OPTION_UNAVAILABLE", "The field has no option " + (p.sequenceNum ?? ""))
        if (isDraft(option))
            call(S + "delete#DbFormFieldOption", {formId, fieldName: field.fieldName, sequenceNum: option.sequenceNum})
        else
            keepValid(formId, thruDate, () =>
                call(S + "end#DbFormFieldOption", {formId, fieldName: field.fieldName, sequenceNum: option.sequenceNum, thruDate})
            )
        return {}
    }
    if (isDraft(field)) {
        for (const attribute of rows(ATTRIBUTE, {formId, fieldName: field.fieldName})) attribute.delete()
        call(S + "delete#DbFormField", {formId, fieldName: field.fieldName})
    } else call(S + "end#DbFormField", {formId, fieldName: field.fieldName, thruDate})
    return {}
}
// The drafts of a form the caller checked start at fromDate (now or later), refused while it has a problem (FORM_INVALID).
function publishOf(form, fromDate, noun = "form", code = "FORM_INVALID") {
    const problems = problemsOf(form.formId, null, true, noun)
    if (problems.length) denied(code, problems.map(problem => problem.message).join("; "))
    const out = call(S + "publish#DbForm", {formId: form.formId, fromDate: fromDate || null})
    return {formId: form.formId, publishedFieldNames: Array.from(out.publishedFieldNames || [])}
}
// A new dated DbForm of a purpose and organization (the caller checked both), with no field.
function makeForm(purposeEnumId, organizationPartyId, description, comments, noun = "form") {
    const name = text(description)
    if (!name) denied("NAME_REQUIRED", "A " + noun + " needs a name")
    noExpression(name, "A " + noun + "'s name")
    noExpression(comments, "What it is for")
    return call("create#" + FORM, {
        purposeEnumId,
        isDated: "Y",
        ownerPartyId: organizationPartyId,
        description: name.substring(0, 255),
        comments: text(comments)
    }).formId
}

// ===== the services (mantle.party.FormDefinitionServices) =====
// create#Form: a new form of a registered purpose for one of the user's organizations for it (its edit permission), its
// fields drafts until published: none, or the published fields of another form of the same purpose and organization.
function createForm(p) {
    const registration = requireEdit(registrationOf(p.purposeEnumId))
    const noun = nounOf(registration)
    const organizationPartyId = requireOrganization(registration, p.organizationPartyId)
    let fields = []
    if (!blank(p.sourceFormId)) {
        const source = formOf(p.sourceFormId, {purposes: [registration.purposeEnumId]})
        if (source.ownerPartyId !== organizationPartyId)
            denied("RECORD_UNAVAILABLE", "Copy a " + noun + " of the same organization")
        fields = formAt(source.formId, null, false).map(field => ({
            newFieldName: field.fieldName,
            title: field.title,
            tooltip: field.tooltip || null,
            fieldTypeEnumId: field.fieldTypeEnumId,
            isRequired: field.required ? "Y" : "N",
            audienceEnumId: field.audienceEnumId,
            optionText: field.options.map(option => option.key + " | " + option.text).join("\n")
        }))
        if (!fields.length) denied("FORM_NOT_PUBLISHED", "The " + noun + " to copy has no published field")
    }
    const formId = makeForm(registration.purposeEnumId, organizationPartyId, p.description, p.comments, noun)
    const form = one(FORM, {formId})
    for (const field of fields) saveFieldOf(form, field, noun)
    return {formId}
}
const editForm = p => {
    const form = formOf(p.formId)
    return {form, noun: nounOf(registrationOf(form.purposeEnumId))}
}
function saveField(p) {
    const {form, noun} = editForm(p)
    return saveFieldOf(form, p, noun)
}
function saveCondition(p) {
    const {form, noun} = editForm(p)
    return saveConditionOf(form, p, noun)
}
function endPart(p) {
    const {form, noun} = editForm(p)
    return endPartOf(form, p, noun)
}
function publishForm(p) {
    const {form, noun} = editForm(p)
    return publishOf(form, p.fromDate, noun)
}
function renameForm(p) {
    const {form, noun} = editForm(p)
    const description = text(p.description)
    if (!description) denied("NAME_REQUIRED", "A " + noun + " needs a name")
    noExpression(description, "A " + noun + "'s name")
    noExpression(p.comments, "What it is for")
    call("update#" + FORM, {formId: form.formId, description: description.substring(0, 255), comments: text(p.comments)})
    return {formId: form.formId}
}
// get#Form: a form for its editor or reader (the purpose's permissions and organization): its summary and fields as of now,
// and with includeDrafts for its editor the rows an editor works on with their states, its rules and its problems.
function getForm(p) {
    const form = formOf(p.formId, {view: true})
    const registration = registrationOf(form.purposeEnumId)
    const noun = nounOf(registration)
    const drafts = (p.includeDrafts === true || p.includeDrafts === "true") && canEdit(registration)
    const out = Object.assign(summaryOf(form), {
        purposeText: purposeText(form.purposeEnumId),
        canEdit: canEdit(registration),
        fields: fieldRows(formAt(form.formId, null, false))
    })
    if (drafts) Object.assign(out, editRows(form, noun))
    return {form: out}
}
const purposeText = purposeEnumId => one("moqui.basic.Enumeration", {enumId: purposeEnumId})?.description || purposeEnumId || ""
// find#Forms: the forms of the purposes asked for (each registered one the user edits or reads) of one of the user's
// organizations for them (the one asked for, else the first by name), each with its summary, its purpose, its version and how
// many assigned respondents answered it; the organizations to choose from; the published forms of each purpose (sourceOptions:
// to copy). PERMISSION_DENIED when the user reads none of the purposes.
function findForms(p) {
    const registrations = listOf(p.purposeEnumIds)
        .map(registrationOf)
        .filter(registration => registration && canView(registration))
    if (!registrations.length) denied("PERMISSION_DENIED", "These forms are not available")
    let organizationPartyIds = null
    for (const registration of registrations) {
        const own = organizationsFor(registration)
        if (own == null) continue
        organizationPartyIds = organizationPartyIds == null ? own : organizationPartyIds.filter(partyId => own.includes(partyId))
    }
    if (organizationPartyIds == null)
        organizationPartyIds = rows("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).map(row => row.partyId)
    organizationPartyIds = organizationPartyIds.filter(isInternal)
    const organizations = organizationPartyIds
        .map(partyId => ({value: partyId, label: one("mantle.party.Organization", {partyId})?.organizationName || partyId}))
        .sort((a, b) => a.label.localeCompare(b.label))
    const organizationPartyId =
        !blank(p.organizationPartyId) && organizationPartyIds.includes(String(p.organizationPartyId))
            ? String(p.organizationPartyId)
            : organizations[0]?.value || null
    if (!blank(p.organizationPartyId) && organizationPartyId !== String(p.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Organization " + p.organizationPartyId + " is not available")
    const purposeIds = registrations.map(registration => registration.purposeEnumId)
    const formRows = organizationPartyId
        ? Array.from(
              find(FORM).condition("ownerPartyId", organizationPartyId).condition("purposeEnumId", "in", purposeIds).list()
          )
        : []
    const forms = formRows
        .map(form => {
            const summary = summaryOf(form)
            const answered = find(INVITATION).condition("formId", form.formId).condition("statusEnumId", "FinResponded").count()
            const versions = fieldsOf(form.formId)
                .filter(row => !isDraft(row))
                .map(row => Number(ms(row.fromDate)))
            return Object.assign(summary, {
                purposeText: purposeText(form.purposeEnumId),
                versionText: new Set(versions).size ? L("Version") + " " + new Set(versions).size : "",
                answeredCount: answered,
                answeredText: String(answered),
                canEdit: canEdit(registrationOf(form.purposeEnumId))
            })
        })
        .sort((a, b) => a.purposeText.localeCompare(b.purposeText) || a.description.localeCompare(b.description))
    const sourceOptions = forms
        .filter(form => form.published)
        .map(form => ({
            value: form.formId,
            label: form.description + " (" + form.purposeText + ")",
            purposeEnumId: form.purposeEnumId
        }))
    const purposes = registrations.map(registration => ({
        value: registration.purposeEnumId,
        label: purposeText(registration.purposeEnumId),
        canEdit: canEdit(registration)
    }))
    return {forms, organizations, organizationPartyId, sourceOptions, purposes}
}

// ===== answers of assigned respondents (an app's own service checks the respondent and the record first) =====
// The published form a purpose takes for an organization now: the one asked for (of that purpose and organization, with
// published fields), else the organization's only published one of the purpose; null when none or several.
function publishedFormFor(purposeEnumId, organizationPartyId, formId = null) {
    const usable = form =>
        !!form &&
        form.purposeEnumId === purposeEnumId &&
        form.ownerPartyId === organizationPartyId &&
        formAt(form.formId, null, false).length > 0
    if (!blank(formId)) {
        const form = one(FORM, {formId})
        if (!usable(form)) denied("FORM_UNAVAILABLE", "Choose a published form of the organization for this")
        return form.formId
    }
    const found = rows(FORM, {purposeEnumId, ownerPartyId: organizationPartyId}).filter(usable)
    return found.length === 1 ? found[0].formId : null
}
// The values of an assigned respondent checked against the form as of now (refused with the reasons, FORM_VALUES_INVALID)
// and kept as one FormResponse; its id.
function recordAnswer(formId, values) {
    const checked = checkValues(formId, values, "internal", null, false)
    if (!checked.valid) denied("FORM_VALUES_INVALID", checked.errors.map(error => error.message).join("; "))
    return call(S + "create#FormResponse", {
        formId,
        formLocation: "DbForm#" + formId,
        responseDate: now(),
        responseMap: checked.values
    }).formResponseId
}

const operations = {createForm, saveField, saveCondition, endPart, publishForm, renameForm, getForm, findForms}
;({
    // for the apps' own modules: CaseTemplates.js (case templates), CaseFeedback.js (case feedback) and People's
    TYPES,
    OPERATORS,
    EFFECTS,
    CUSTOMER,
    INTERNAL,
    registrationOf,
    accessKinds,
    canEdit,
    canView,
    requireOrganization,
    formOf,
    fieldsOf,
    formAt,
    customerProjection,
    checkValues,
    answersOf,
    problemsOf,
    typeText,
    audienceText,
    summaryOf,
    fieldRows,
    editRows,
    saveFieldOf,
    saveConditionOf,
    endPartOf,
    publishOf,
    makeForm,
    publishedFormFor,
    recordAnswer,
    // each operation checks the purpose's permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown form definition operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
