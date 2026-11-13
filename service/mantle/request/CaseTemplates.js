// Case templates (design-customer-service §3 NewCase CaseDescription, §9 CaseTemplates; impl-customer-service P7,
// CS-TEMPLATES, CS-FORM-ELEMENTS, F69-F71; SupportTemplateEntities.xml). A template is a dated DbForm (isDated, purpose
// DbfpCaseTemplate) owned by an organization (DbForm.ownerPartyId); its fields, options and conditions
// (DbFormFieldDependency: show or require a field by another's value) are effective-dated rows of the framework
// (docs/ui/Db-Forms.md, org.moqui.impl.ScreenServices), each field with its audience (DbFormField.audienceEnumId:
// customer-visible or internal). A draft has no from date and Publish starts it; a published field's label, help, required
// flag, order and options change in place from now (the framework audit-logs them); a new type or audience, or a change from
// a later date, is a successor field from that date, so an answered field is never redefined and an internal answer never
// becomes customer-visible. A case's values are a FormResponse of the template, linked from its CaseProfile and read as of
// the response date. The checks are a typed allowlist: the field types below, the four operators, show or require, a value
// that is one of the source field's options, no expression (${) in a label, help, option or value, no cycle (the
// framework's), and no customer field shown or required by an internal one; values are re-evaluated on the server (hidden
// fields dropped, required ones present, each of its type). No script of an administrator's runs. Refusals carry reason
// codes (EntityLib.denied).
// impl-people P16 (F51, F62): the builder itself (the dated fields, options and conditions, their checks and the values'
// check) is mantle.party.FormDefinitions (FormDefinitions.js), which a second app's forms use too; a template is a form of the
// registered purpose DbfpCaseTemplate (mantle.party.FormPurpose: SUPPORT_POLICY_EDIT edits it, SUPPORT_CASE_EDIT reads it, the
// user's own organizations), and this module keeps what is a case's: the queue and type that use a template, a case's values
// and their reads.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const forms = ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")
const {one, rows, call, denied, access, ms} = lib

const FORM = "moqui.screen.form.DbForm",
    PROFILE = "mantle.request.support.CaseProfile",
    QUEUE = "mantle.request.support.ServiceQueue"
const S = "org.moqui.impl.ScreenServices."
const PURPOSE = "DbfpCaseTemplate"
const {TYPES, OPERATORS, EFFECTS, CUSTOMER} = forms
const NOUN = "template"

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
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

// ===== access =====
function requirePermission(...permissions) {
    if (!permissions.some(permission => access.has(permission)))
        denied("PERMISSION_DENIED", permissions.join(" or ") + " is required")
}
// One of the user's organizations for case templates (the user's own internal organizations).
const requireOrganization = organizationPartyId => forms.requireOrganization(forms.registrationOf(PURPOSE), organizationPartyId)
// A case template of one of the user's organizations; a missing form, a form that is no template and another
// organization's are refused alike (RECORD_UNAVAILABLE). The caller checks the permission.
// P13: a case feedback form (CaseFeedback.js) is edited by the same rules, every field customer-visible
const templateOf = formId => forms.formOf(formId, {purposes: [PURPOSE, "DbfpCaseFeedback"], noun: NOUN, permission: false})
const formAt = (formId, asOfDate, drafts) => forms.formAt(formId, asOfDate, drafts)
const checkValues = (formId, values, audience, asOfDate, drafts) => forms.checkValues(formId, values, audience, asOfDate, drafts)
const problemsOf = (formId, asOfDate = null, drafts = true) => forms.problemsOf(formId, asOfDate, drafts, NOUN)

// ===== values (validate#TemplateValues) =====
// validate#TemplateValues. Either audience needs the template's organization (P15 adds the customer contact's path).
function validateValues(p) {
    const audience = p.audience === "customer" ? "customer" : "internal"
    templateOf(p.formId)
    const out = checkValues(p.formId, p.values, audience, p.asOfDate || null, false)
    if ((p.refuse === true || p.refuse === "true") && !out.valid)
        denied("TEMPLATE_VALUES_INVALID", out.errors.map(error => error.message).join("; "))
    return out
}

// ===== the template's checks (validate#CaseTemplate) =====
// The problems of a template are FormDefinitions.problemsOf's (drafts too, by default: what Publish would start).
function validateTemplate(p) {
    requirePermission("SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT")
    templateOf(p.formId)
    const drafts = p.includeDrafts !== false && p.includeDrafts !== "false"
    const problems = problemsOf(p.formId, p.asOfDate || null, drafts)
    const sample = p.values || {}
    const agent = checkValues(p.formId, sample, "internal", p.asOfDate || null, drafts)
    const customer = checkValues(p.formId, sample, "customer", p.asOfDate || null, drafts)
    return {problems, valid: problems.length === 0, agent, customer}
}

// ===== reads (get#CaseTemplate, get#CaseTemplateValues) =====
// The queues whose current row takes the template.
function queuesUsing(formId) {
    return rows(QUEUE, {templateFormId: formId})
        .filter(row => row.fromDate != null && lib.active(row))
        .map(row => ({
            requestCategoryId: row.requestCategoryId,
            queueName:
                one("mantle.request.RequestCategory", {requestCategoryId: row.requestCategoryId})?.description ||
                row.requestCategoryId
        }))
}
// A template's summary (FormDefinitions.summaryOf) with the queues that use it.
const summaryOf = form => Object.assign(forms.summaryOf(form), {queues: queuesUsing(form.formId)})
// get#CaseTemplate: the template as of a date for an audience. The customer's projection has only the customer-visible
// fields and the rules among them, never a draft; the agent's (SUPPORT_POLICY_EDIT or SUPPORT_CASE_EDIT and the template's
// organization) has every field, and with includeDrafts (SUPPORT_POLICY_EDIT) the rows an editor works on: every field,
// option and condition not ended, with its state.
function getTemplate(p) {
    const customer = p.audience === "customer"
    if (!customer) requirePermission("SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT")
    // the customer's projection too is the template's organization's (P15 adds the customer contact's path)
    const form = templateOf(p.formId)
    const drafts = !customer && (p.includeDrafts === true || p.includeDrafts === "true") && access.has("SUPPORT_POLICY_EDIT")
    const asOf = drafts ? null : p.asOfDate || null
    const all = formAt(form.formId, asOf, drafts)
    const shown = customer ? forms.customerProjection(all) : all
    const template = Object.assign(
        customer ? {formId: form.formId, description: form.description || form.formId} : summaryOf(form),
        {fields: forms.fieldRows(shown)}
    )
    if (drafts) Object.assign(template, forms.editRows(form, NOUN))
    return {template}
}
// The case a template value read is of: one of the user's organizations' (RECORD_UNAVAILABLE otherwise, a missing one alike).
function caseOf(requestId) {
    const unavailable = () => denied("RECORD_UNAVAILABLE", "Case " + (requestId || "") + " is not available")
    const profile = blank(requestId) ? null : one(PROFILE, {requestId})
    if (!profile) unavailable()
    const organization = rows("mantle.request.RequestParty", {requestId, roleTypeId: "OrgInternal"}).find(row => lib.active(row))
    if (!organization || !facilityScope.owns(facilityScope.scope(), organization.partyId)) unavailable()
    return profile
}
// get#CaseTemplateValues: a case's values as submitted, with the form as it was at the response date (its labels and
// option texts then); the customer's audience leaves out every internal field.
function getValues(p) {
    const profile = caseOf(p.requestId)
    const customer = p.audience === "customer"
    if (!profile.formResponseId) return {templateFormId: profile.templateFormId || null, values: []}
    const response = call(S + "get#FormResponse", {formResponseId: profile.formResponseId})
    const form = one(FORM, {formId: response.formId})
    const fields = formAt(response.formId, response.responseDate, false)
    const answers = response.responseMap || {}
    const values = fields
        .filter(field => !customer || field.audienceEnumId === CUSTOMER)
        .filter(field => Object.prototype.hasOwnProperty.call(answers, field.fieldName) && !blank(answers[field.fieldName]))
        .map(field => {
            const raw = answers[field.fieldName]
            const parts = valueList(raw)
            const displayText = TYPES[field.fieldTypeEnumId]?.choice
                ? parts.map(part => field.options.find(option => option.key === part)?.text || part).join(", ")
                : String(raw)
            return {
                fieldName: field.fieldName,
                title: field.title,
                valueText: String(raw),
                displayText,
                audienceEnumId: field.audienceEnumId,
                audienceText: forms.audienceText(field.audienceEnumId)
            }
        })
    return {
        templateFormId: response.formId,
        templateName: form?.description || response.formId,
        formResponseId: profile.formResponseId,
        responseDate: response.responseDate,
        responseDateText: dateText(response.responseDate),
        values
    }
}

// ===== saves (SUPPORT_POLICY_EDIT) =====
// save#CaseTemplate: a template's name and notes (a new one is a dated DbForm of the organization), the queue it is used
// for (a new queue row from now with the template, or without it), and Publish: the drafts start at fromDate (now or later),
// refused while the template has a problem (TEMPLATE_INVALID).
function saveTemplate(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    let form
    if (blank(p.formId)) {
        const organizationPartyId = requireOrganization(p.organizationPartyId)
        form = one(FORM, {formId: forms.makeForm(PURPOSE, organizationPartyId, p.description, p.comments, NOUN)})
    } else {
        form = templateOf(p.formId)
        if (p.organizationPartyId && p.organizationPartyId !== form.ownerPartyId)
            denied("TEMPLATE_ORGANIZATION", "A template stays its organization's")
        const changes = {}
        if (p.description != null) {
            const description = text(p.description)
            if (!description) denied("NAME_REQUIRED", "A template needs a name")
            if (String(description).includes("${"))
                denied("NO_EXPRESSIONS", "A template's name is text, not an expression (${...})")
            changes.description = description.substring(0, 255)
        }
        if (p.comments != null) changes.comments = text(p.comments)
        if (Object.keys(changes).length) call("update#" + FORM, Object.assign({formId: form.formId}, changes))
    }
    let publishedFieldNames = []
    if (p.publish === true || p.publish === "true" || p.publish === "Y") {
        publishedFieldNames = forms.publishOf(form, p.fromDate, NOUN, "TEMPLATE_INVALID").publishedFieldNames
    }
    if (!blank(p.requestCategoryId))
        useForQueue(
            form,
            String(p.requestCategoryId),
            p.useForQueue !== false && p.useForQueue !== "N" && p.useForQueue !== "false"
        )
    return {formId: form.formId, publishedFieldNames}
}
// The queue's template from now: a new ServiceQueue row like the current one with templateFormId set (or cleared), the
// current one ended, so a case keeps the row it was opened under.
function useForQueue(form, requestCategoryId, use) {
    const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
    // P13: a feedback form (templateOf takes it for its edits) is never a queue's case template
    if (form.purposeEnumId !== PURPOSE) denied("TEMPLATE_UNAVAILABLE", "Template " + form.formId + " is not a case template")
    const queue = cases.queueOf(requestCategoryId)
    if (!queue || queue.organizationPartyId !== form.ownerPartyId)
        denied("QUEUE_UNAVAILABLE", "Choose a service queue of the template's organization")
    if (use && !formAt(form.formId, null, false).length)
        denied("TEMPLATE_NOT_PUBLISHED", "Publish the template before a queue uses it")
    const current = queue.queue
    const templateFormId = use ? form.formId : current.templateFormId === form.formId ? null : current.templateFormId
    if ((current.templateFormId || null) === templateFormId) return
    const values = {}
    for (const name of [
        "offeredTypeEnumIds",
        "visibilityEnumId",
        "responsibleTeamPartyId",
        "assignmentRuleId",
        "serviceLevelPolicyId",
        "fallbackAssigneePartyId"
    ])
        values[name] = current[name] ?? null
    values.templateFormId = templateFormId
    values.changeReason = use ? L("Uses the template") + " " + (form.description || form.formId) : L("No template")
    cases.startRow(QUEUE, "serviceQueueId", {requestCategoryId}, values, {})
}
// save#CaseTemplateField, save#CaseTemplateCondition and end#CaseTemplatePart: FormDefinitions' rules on a template (or a
// case feedback form) of one of the user's organizations, with SUPPORT_POLICY_EDIT.
function saveField(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    return forms.saveFieldOf(templateOf(p.formId), p, NOUN)
}
function saveCondition(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    return forms.saveConditionOf(templateOf(p.formId), p, NOUN)
}
function endPart(p) {
    requirePermission("SUPPORT_POLICY_EDIT")
    return forms.endPartOf(templateOf(p.formId), p, NOUN)
}

// ===== a case's template (create#Case) =====
// The template a new case of the organization in the queue takes: the one asked for (one of the organization's, in effect),
// else its type's (P11: ServiceRequestType.templateFormId, the warranty claim's), else the queue's current one; null when
// none.
function forCase(organizationPartyId, requestCategoryId, templateFormId, requestTypeEnumId) {
    if (!blank(templateFormId)) {
        const form = one(FORM, {formId: templateFormId})
        if (
            !form ||
            form.purposeEnumId !== PURPOSE ||
            form.ownerPartyId !== organizationPartyId ||
            !formAt(form.formId, null, false).length
        )
            denied("TEMPLATE_UNAVAILABLE", "Template " + templateFormId + " is not one of the organization's")
        return form.formId
    }
    return typeTemplate(organizationPartyId, requestTypeEnumId) || queueTemplate(requestCategoryId)
}
// P11: the type's current template for the organization, when it is the organization's and in effect.
function typeTemplate(organizationPartyId, requestTypeEnumId) {
    if (blank(organizationPartyId) || blank(requestTypeEnumId)) return null
    const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
    const formId = cases.typeOf(organizationPartyId, requestTypeEnumId)?.templateFormId
    if (!formId) return null
    const form = one(FORM, {formId})
    return form &&
        form.purposeEnumId === PURPOSE &&
        form.ownerPartyId === organizationPartyId &&
        formAt(formId, null, false).length
        ? formId
        : null
}
// The queue's current template, when it is in effect.
function queueTemplate(requestCategoryId) {
    if (blank(requestCategoryId)) return null
    const cases = ec.resource.script("component://mr-mantle/service/mantle/request/SupportCases.js")
    const queue = cases.queueOf(requestCategoryId)
    const formId = queue?.queue?.templateFormId
    if (!formId) return null
    const form = one(FORM, {formId})
    return form &&
        form.purposeEnumId === PURPOSE &&
        form.ownerPartyId === queue.organizationPartyId &&
        formAt(formId, null, false).length
        ? formId
        : null
}
// The case's values as a FormResponse of the template (as of now), linked from its profile.
function record(requestId, formId, values) {
    const out = call(S + "create#FormResponse", {
        formId,
        formLocation: "DbForm#" + formId,
        responseDate: ec.user.nowTimestamp,
        responseMap: values || {}
    })
    call("update#" + PROFILE, {requestId, templateFormId: formId, formResponseId: out.formResponseId})
    return out.formResponseId
}

// The organization's templates for TemplateList and NewCase (TemplateServices.find#Templates): their summaries, newest
// change first.
function templatesOf(organizationPartyId) {
    return rows(FORM, {purposeEnumId: PURPOSE, ownerPartyId: organizationPartyId})
        .map(summaryOf)
        .sort((a, b) => a.description.localeCompare(b.description))
}

const operations = {saveTemplate, saveField, saveCondition, endPart, validateTemplate, validateValues, getTemplate, getValues}
;({
    // for create#Case (SupportCases.js) and Customer Service's reads
    forCase,
    queueTemplate,
    checkValues,
    record,
    templatesOf,
    // P15: the customer projection, for the Support app's contact path (SupportPortal.js)
    customerProjection: forms.customerProjection,
    // P13: the feedback forms' reads and checks (CaseFeedback.js)
    formAt,
    problemsOf,
    TYPES,
    OPERATORS,
    EFFECTS,
    // each operation checks its own permission and organization, and reads and writes with artifact authorization off
    execute: (op, parameters) => {
        if (!operations[op]) throw new Error("Unknown case template operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
