/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Comms' template library (mantle.party.MessageServices find#Templates, get#Template, create#Template, store#Template,
 * store#TemplateContent, preview#Template, publish#Template, end#Template; design-marketing §5 MessageTemplates and
 * MessageTemplateDetail, §14.1; impl-marketing P6, F78; Comms' owner contract, design-drawers-commons' Mailboxes row).
 *
 * - Who: a holder of MESSAGE_TEMPLATE_VIEW or MESSAGE_TEMPLATE_EDIT reads the templates of the organizations they work for (every
 *   internal organization for a system administrator or a holder of MARKETING_ALL_ORGANIZATIONS); MESSAGE_TEMPLATE_EDIT writes them.
 *   Another organization's template answers as missing (RECORD_UNAVAILABLE). The permission is Comms' own, so the same rule holds
 *   under Marketing's mount and, later, Comms'.
 * - Content (F78): the author writes HTML and text with variables as ${name}. Each name must be one the content declares, with its
 *   label, fallback and whether it is required; an undeclared name, an expression, a template tag, a variable inside a link or a
 *   script or unsafe HTML is refused when the content is stored (this module's parse), never at render. Each store writes the body
 *   as a dbresource:// file named .html.fancy-locked (and the text as .fancy-locked) of its own, rendered by location through
 *   ec.resource.template with a map of the declared variables alone, each its value or else its fallback: the locked renderer
 *   escapes every value and sees nothing else, and a name the map lacks renders empty.
 * - Dated content: a template has at most one draft; a published content is never changed. Editing a published template makes a
 *   draft from it; publishing the draft gives it its date and ends the content in effect then. Publication authorizes no send and
 *   changes no prepared message.
 * Refusals carry reason codes (EntityLib.js denied).
 */
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, denied, call, ms} = lib
const access = lib.access
const T = "mantle.party.MessageTemplate"
const C = "mantle.party.MessageTemplateContent"
const channels = {MdcEmail: "Email"}
const limits = {name: 120, subject: 200, preheader: 200, body: 200000, variables: 30, fallback: 255, label: 80}
// the names the locked renderer gives its own helpers, and JavaScript's words, are never variables
const reservedNames = new Set(
    (
        "raw html cssString format localize t break case catch class const continue debugger default delete do else export " +
        "extends finally for function if import in instanceof new return super switch this throw try typeof var void while with " +
        "yield let static enum await implements package protected interface private public null true false undefined NaN " +
        "Infinity eval arguments"
    ).split(" ")
)
const unsafePatterns = [
    [
        /<\s*\/?\s*(script|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|meta|link|base|svg|math)\b/i,
        "a script, frame, form or embedded object"
    ],
    [/\son[a-z]+\s*=/i, "an event handler attribute"],
    [/(java|vb|live)script\s*:/i, "a script link"],
    [/data\s*:\s*text\/html/i, "an HTML data link"],
    [/expression\s*\(/i, "a style expression"]
]
const text = value => (value == null ? "" : String(value).trim())
const blank = value => text(value) === ""
const nowMs = () => ms(ec.user.nowTimestamp)

// ===== scope =====
function scopeOf() {
    const all = access.systemAdmin() || access.has("MARKETING_ALL_ORGANIZATIONS")
    const edit = access.has("MESSAGE_TEMPLATE_EDIT")
    const read = edit || access.has("MESSAGE_TEMPLATE_VIEW") || access.systemAdmin()
    const organizationPartyIds = !read
        ? []
        : all
          ? Array.from(find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()).map(
                row => row.partyId
            )
          : marketingAccess.memberOrganizations().memberPartyIds
    return {read, edit, organizationPartyIds}
}
function reader() {
    const scope = scopeOf()
    if (!scope.read) denied("PERMISSION_DENIED", "Reading message templates needs MESSAGE_TEMPLATE_VIEW")
    return scope
}
function editor() {
    const scope = scopeOf()
    if (!scope.edit) denied("PERMISSION_DENIED", "Changing message templates needs MESSAGE_TEMPLATE_EDIT")
    return scope
}
const covers = (scope, partyId) => !!partyId && scope.organizationPartyIds.includes(partyId)
function templateOf(scope, messageTemplateId, lock = false) {
    let query = find(T, {messageTemplateId: text(messageTemplateId)})
    if (lock) query = query.forUpdate(true)
    const row = blank(messageTemplateId) ? null : query.one()
    if (!row || !covers(scope, row.organizationPartyId))
        denied("RECORD_UNAVAILABLE", "Template " + text(messageTemplateId) + " is not available")
    return row
}
const ended = (row, at = nowMs()) => row.thruDate != null && ms(row.thruDate) <= at
function requireRevision(row, expected, what) {
    if (blank(expected)) denied("REVISION_REQUIRED", "Name the revision of the " + what + " you read")
    const current = ms(row.lastUpdatedStamp)
    if (Number(expected) !== current)
        denied("STALE_RECORD", "The " + what + " changed since you read it (now revision " + current + ")")
}
const organizationName = partyId => (partyId ? one("mantle.party.Organization", {partyId})?.organizationName || partyId : "")
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")

// ===== contents =====
const contentsOf = messageTemplateId => Array.from(find(C, {messageTemplateId}).orderBy("-contentSeqId").list())
const draftOf = contents => contents.find(row => row.fromDate == null) || null
// the content in effect at a time: published, begun by then and not ended
const currentOf = (contents, at = nowMs()) =>
    contents
        .filter(row => row.fromDate != null && ms(row.fromDate) <= at && (row.thruDate == null || ms(row.thruDate) > at))
        .sort((a, b) => ms(b.fromDate) - ms(a.fromDate))[0] || null
const scheduledOf = (contents, at = nowMs()) => contents.filter(row => row.fromDate != null && ms(row.fromDate) > at)
function readText(location) {
    if (blank(location)) return ""
    try {
        const reference = ec.resource.getLocationReference(location)
        return reference.getExists() ? String(reference.getText() || "") : ""
    } catch (error) {
        ec.logger.error("Template content at " + location + " was not read: " + error.message)
        return ""
    }
}
const variablesOf = content => (content ? lib.json(content.variablesJson, []) || [] : [])

// ===== the content's own parse (F78) =====
// The names a text uses as ${name}, refusing a tag, an expression and an unclosed ${. \${ is the literal text.
function namesIn(value, label) {
    const source = String(value || "")
        .replace(/\\\$\{/g, "")
        .replace(/\\<#/g, "")
    if (/<\s*\/?\s*[#@]|#\{/.test(source))
        denied("TEMPLATE_DIRECTIVE", label + " has a template tag: only ${name} variables are allowed")
    const names = []
    let rest = source
    for (;;) {
        const at = rest.indexOf("${")
        if (at < 0) break
        const end = rest.indexOf("}", at + 2)
        if (end < 0) denied("VARIABLE_EXPRESSION", label + " has a ${ that is not closed")
        const name = rest.slice(at + 2, end).trim()
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
            denied("VARIABLE_EXPRESSION", label + " has ${" + name.slice(0, 40) + "}: a variable is a name, not an expression")
        names.push(name)
        rest = rest.slice(end + 1)
    }
    return names
}
function checkHtml(value) {
    for (const [pattern, what] of unsafePatterns)
        if (pattern.test(value)) denied("UNSAFE_HTML", "The body has " + what + ", which a message may not carry")
    if (/(href|src|action|background)\s*=\s*["']?\s*[^"'\s>]*\$\{/i.test(value.replace(/\\\$\{/g, "")))
        denied("VARIABLE_IN_LINK", "A variable may not make a link's address: write the address in the body")
}
// The declared variables, checked: {name, label, fallback, required}.
function declaredVariables(value) {
    const list = Array.isArray(value) ? value : typeof value === "string" ? lib.json(value, null) : value ? Array.from(value) : []
    if (!Array.isArray(list)) denied("VALUE_INVALID", "The variables are a list")
    if (list.length > limits.variables) denied("VALUE_INVALID", "A template declares at most " + limits.variables + " variables")
    const seen = new Set()
    return list.map(item => {
        const name = text(item?.name)
        if (!/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name))
            denied("VARIABLE_INVALID", "A variable's name is a letter then letters, digits or _")
        if (reservedNames.has(name)) denied("VARIABLE_INVALID", name + " is a reserved word, not a variable name")
        if (seen.has(name)) denied("VARIABLE_INVALID", "The variable " + name + " is declared twice")
        seen.add(name)
        const fallback = item?.fallback == null ? "" : String(item.fallback)
        if (fallback.length > limits.fallback) denied("VALUE_INVALID", "The fallback of " + name + " is too long")
        if (/[<>]/.test(fallback) || /\$\{/.test(fallback)) denied("VALUE_INVALID", "A fallback is plain text")
        return {
            name,
            label: text(item?.label).slice(0, limits.label) || name,
            fallback,
            required: item?.required === true || item?.required === "true" || item?.required === "Y"
        }
    })
}
// The content checked as a whole: every name used is declared, the HTML is safe, the sizes hold.
function checkContent(content) {
    const declared = new Set(content.variables.map(variable => variable.name))
    if (content.subject.length > limits.subject) denied("VALUE_INVALID", "A subject is at most " + limits.subject + " characters")
    if (/[\r\n]/.test(content.subject)) denied("VALUE_INVALID", "A subject is one line")
    if (content.preheader.length > limits.preheader)
        denied("VALUE_INVALID", "A preheader is at most " + limits.preheader + " characters")
    if (content.body.length > limits.body || content.bodyText.length > limits.body)
        denied("VALUE_INVALID", "The content is too long")
    checkHtml(content.body)
    for (const [label, value] of [
        ["The subject", content.subject],
        ["The preheader", content.preheader],
        ["The body", content.body],
        ["The text", content.bodyText]
    ])
        for (const name of namesIn(value, label))
            if (!declared.has(name))
                denied("UNDECLARED_VARIABLE", label + " names ${" + name + "}, which the template does not declare")
}

// ===== render =====
// The map a content renders with: each declared variable, its value when given, else its fallback (null when it has none, which
// renders empty); nothing else. {map, missing: the required ones with neither}.
function renderMap(variables, values) {
    const map = {}
    const missing = []
    for (const variable of variables) {
        const given = values && values[variable.name] != null ? String(values[variable.name]) : ""
        const value = given !== "" ? given : variable.fallback !== "" ? variable.fallback : null
        if (value == null && variable.required) missing.push(variable.name)
        map[variable.name] = value
    }
    return {map, missing}
}
// A subject or preheader: its ${name}s from the map, one line.
const fill = (value, map) =>
    String(value || "")
        .replace(
            /(^|[^\\])\$\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}/g,
            (all, before, name) => before + (map[name] == null ? "" : map[name])
        )
        .replace(/\\\$\{/g, "${")
        .replace(/[\r\n]+/g, " ")
function renderLocation(location, map) {
    if (blank(location)) return ""
    if (!ec.resource.getLocationReference(location).getExists()) return ""
    return String(ec.resource.template(location, map) || "")
}
// A content rendered with values: {subject, preheader, body, bodyText, missing}.
function render(content, values) {
    const {map, missing} = renderMap(variablesOf(content), values)
    return {
        subject: fill(content.subject, map),
        preheader: fill(content.preheader, map),
        body: renderLocation(content.bodyLocation, map),
        bodyText: renderLocation(content.bodyTextLocation, map),
        missing
    }
}

// ===== projections =====
function stateOf(template, contents, at = nowMs()) {
    if (ended(template, at)) return {state: "ended", stateText: "Ended", stateColor: "grey-7"}
    const current = currentOf(contents, at)
    if (current) return {state: "published", stateText: "Published", stateColor: "positive"}
    if (scheduledOf(contents, at).length) return {state: "scheduled", stateText: "Scheduled", stateColor: "info"}
    return {state: "draft", stateText: "Draft", stateColor: "warning"}
}
function templateDisplay(row, scope, contents = contentsOf(row.messageTemplateId)) {
    const current = currentOf(contents)
    const draft = draftOf(contents)
    return Object.assign(
        {
            messageTemplateId: row.messageTemplateId,
            templateName: row.templateName || row.messageTemplateId,
            organizationPartyId: row.organizationPartyId,
            organizationName: organizationName(row.organizationPartyId),
            channelEnumId: row.channelEnumId,
            channelText: channels[row.channelEnumId] || enumText(row.channelEnumId),
            purposeEnumId: row.purposeEnumId,
            purposeText: enumText(row.purposeEnumId),
            localeId: row.localeId || null,
            emailTemplateId: row.emailTemplateId || null,
            fromDate: row.fromDate,
            thruDate: row.thruDate,
            effectiveText: current ? lib.dateText(current.fromDate) : "",
            subjectText: (current || draft)?.subject || "",
            hasDraft: !!draft,
            revision: ms(row.lastUpdatedStamp),
            canEdit: scope.edit && !ended(row)
        },
        stateOf(row, contents)
    )
}
function contentDisplay(row, withText) {
    const out = {
        contentSeqId: row.contentSeqId,
        subject: row.subject || "",
        preheader: row.preheader || "",
        variables: variablesOf(row),
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        publishReason: row.publishReason || "",
        publishedBy: row.publishedByUserId
            ? lib.partyNames([userParty(row.publishedByUserId)])[userParty(row.publishedByUserId)] || ""
            : "",
        stateText:
            row.fromDate == null
                ? "Draft"
                : row.thruDate != null && ms(row.thruDate) <= nowMs()
                  ? "Ended"
                  : ms(row.fromDate) > nowMs()
                    ? "Scheduled"
                    : "In effect",
        revision: ms(row.lastUpdatedStamp)
    }
    if (withText) {
        out.body = readText(row.bodyLocation)
        out.bodyText = readText(row.bodyTextLocation)
    }
    return out
}
const userParty = userId => one("moqui.security.UserAccount", {userId})?.partyId || userId

// find#Templates: the templates the caller reads, filtered in the query, by name, a page at a time.
function findTemplates(p) {
    const scope = reader()
    const factory = ec.entity.conditionFactory
    let ids = scope.organizationPartyIds
    if (text(p.organizationPartyId)) {
        if (!covers(scope, text(p.organizationPartyId))) denied("ORGANIZATION_DENIED", "That organization is not available")
        ids = [text(p.organizationPartyId)]
    }
    if (!ids.length) return Object.assign(lib.pageList([], p, "templateList"), {canCreate: false})
    let query = find(T).condition("organizationPartyId", "in", ids).orderBy("^templateName").orderBy("messageTemplateId")
    if (text(p.channelEnumId)) query = query.condition("channelEnumId", text(p.channelEnumId))
    if (text(p.purposeEnumId)) query = query.condition("purposeEnumId", text(p.purposeEnumId))
    if (text(p.localeId)) query = query.condition("localeId", text(p.localeId))
    if (text(p.text))
        query = query.condition(
            factory.makeCondition(
                ["messageTemplateId", "templateName"].map(field =>
                    factory
                        .makeCondition(field, "like", "%" + text(p.text).replace(/[\\%_]/g, ch => "\\" + ch) + "%")
                        .ignoreCase()
                ),
                "or"
            )
        )
    const state = text(p.state) || "active"
    const now = ec.user.nowTimestamp
    if (state === "active")
        query = query.condition(
            factory.makeCondition(
                [factory.makeCondition("thruDate", "equals", null), factory.makeCondition("thruDate", "greater", now)],
                "or"
            )
        )
    else if (state === "ended") query = query.condition(factory.makeCondition("thruDate", "less-equals", now))
    const found = lib.page(query, p, "templateList", query.count())
    found.templateList = found.rows.map(row => templateDisplay(row, scope))
    return Object.assign(found, {canCreate: scope.edit})
}
// get#Template: a template with its draft, the content in effect, the scheduled ones and the history, the texts of the draft and
// of the content in effect for an editor to start from.
function getTemplate(p) {
    const scope = reader()
    const row = templateOf(scope, p.messageTemplateId)
    const contents = contentsOf(row.messageTemplateId)
    const draft = draftOf(contents)
    const current = currentOf(contents)
    return {
        template: templateDisplay(row, scope, contents),
        draft: draft ? contentDisplay(draft, true) : null,
        current: current ? contentDisplay(current, true) : null,
        contentList: contents.filter(content => content.fromDate != null).map(content => contentDisplay(content, false))
    }
}
function nextContentSeqId(messageTemplateId) {
    const last = contentsOf(messageTemplateId)[0]
    return String(Number(last?.contentSeqId || 0) + 1).padStart(3, "0")
}
// The files of a content, each written apart (the renderer's cache is by location, so a change is a new location).
function writeFiles(messageTemplateId, contentSeqId, body, bodyText) {
    const key = ec.user.randomString(12).replace(/[^A-Za-z0-9]/g, "x")
    const base = "dbresource://mantle/message-template/" + messageTemplateId + "/" + contentSeqId + "-" + key + "/"
    const bodyLocation = base + "body.html.fancy-locked"
    ec.resource.getLocationReference(bodyLocation).putText(body)
    let bodyTextLocation = null
    if (bodyText) {
        bodyTextLocation = base + "text.fancy-locked"
        ec.resource.getLocationReference(bodyTextLocation).putText(bodyText)
    }
    return {bodyLocation, bodyTextLocation}
}
function purposeOf(value) {
    const purposeEnumId = text(value)
    if (!one("moqui.basic.Enumeration", {enumId: purposeEnumId, enumTypeId: "MessageTemplatePurpose"}))
        denied("VALUE_INVALID", "Choose the template's purpose: promotional or transactional")
    return purposeEnumId
}
function nameOf(value) {
    const name = text(value)
    if (!name) denied("NAME_REQUIRED", "Give the template a name")
    if (name.length > limits.name) denied("VALUE_INVALID", "A template's name is at most " + limits.name + " characters")
    return name
}
// create#Template: a template of an organization of the caller's, with its EmailTemplate (for email); copied from another the
// caller reads, it starts with that one's content as its draft (unpublished).
function createTemplate(p) {
    const scope = editor()
    const organizationPartyId = text(p.organizationPartyId)
    if (!covers(scope, organizationPartyId)) denied("ORGANIZATION_DENIED", "Choose an organization you work for")
    const channelEnumId = text(p.channelEnumId) || "MdcEmail"
    if (!channels[channelEnumId]) denied("CHANNEL_INVALID", "Templates are kept for email")
    const source = blank(p.copyFromTemplateId) ? null : templateOf(scope, p.copyFromTemplateId)
    const templateName = nameOf(p.templateName)
    const purposeEnumId = purposeOf(p.purposeEnumId || source?.purposeEnumId)
    const localeId = text(p.localeId || source?.localeId).slice(0, 10) || null
    const made = call("create#" + T, {
        organizationPartyId,
        templateName,
        channelEnumId,
        purposeEnumId,
        localeId,
        copiedFromTemplateId: source?.messageTemplateId || null,
        fromDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId || null,
        createdDate: ec.user.nowTimestamp
    })
    const messageTemplateId = made.messageTemplateId
    // its EmailTemplate: the framework's email definition, sent through SYSTEM unless a sending profile names its relay and sender;
    // its body and subject are the content's, given by each send
    const emailTemplateId = "MT_" + messageTemplateId
    call("create#moqui.basic.email.EmailTemplate", {
        emailTemplateId,
        description: templateName,
        emailServerId: "SYSTEM",
        subject: ""
    })
    call("update#" + T, {messageTemplateId, emailTemplateId})
    if (source) {
        const contents = contentsOf(source.messageTemplateId)
        const from = currentOf(contents) || draftOf(contents)
        if (from) {
            const files = writeFiles(messageTemplateId, "001", readText(from.bodyLocation), readText(from.bodyTextLocation))
            call("create#" + C, {
                messageTemplateId,
                contentSeqId: "001",
                subject: from.subject,
                preheader: from.preheader,
                bodyLocation: files.bodyLocation,
                bodyTextLocation: files.bodyTextLocation,
                variablesJson: from.variablesJson,
                createdByUserId: ec.user.userId || null,
                createdDate: ec.user.nowTimestamp
            })
        }
    }
    return {messageTemplateId, emailTemplateId}
}
// store#Template: the header (name, purpose, locale) at the revision read.
function storeTemplate(p) {
    const scope = editor()
    const row = templateOf(scope, p.messageTemplateId, true)
    if (ended(row)) denied("TEMPLATE_ENDED", "The template has ended")
    requireRevision(row, p.expectedRevision, "template")
    const values = {messageTemplateId: row.messageTemplateId}
    if (p.templateName != null) values.templateName = nameOf(p.templateName)
    if (p.purposeEnumId != null) values.purposeEnumId = purposeOf(p.purposeEnumId)
    if (p.localeId != null) values.localeId = text(p.localeId).slice(0, 10) || null
    call("update#" + T, values)
    if (values.templateName && row.emailTemplateId)
        call("update#moqui.basic.email.EmailTemplate", {emailTemplateId: row.emailTemplateId, description: values.templateName})
    return {messageTemplateId: row.messageTemplateId}
}
// store#TemplateContent: the draft written (made from the content in effect when there is none), its texts and variables checked
// first; a published content is never changed.
function storeContent(p) {
    const scope = editor()
    const template = templateOf(scope, p.messageTemplateId, true)
    if (ended(template)) denied("TEMPLATE_ENDED", "The template has ended")
    const contents = contentsOf(template.messageTemplateId)
    const draft = draftOf(contents)
    // the revision read: the draft's, else the template's (a first draft, or one made from the content in effect)
    requireRevision(draft || template, p.expectedRevision, draft ? "draft" : "template")
    const base = draft || currentOf(contents)
    const content = {
        subject: p.subject != null ? text(p.subject) : base?.subject || "",
        preheader: p.preheader != null ? text(p.preheader) : base?.preheader || "",
        body: p.body != null ? String(p.body) : readText(base?.bodyLocation),
        bodyText: p.bodyText != null ? String(p.bodyText) : readText(base?.bodyTextLocation),
        variables: p.variables != null ? declaredVariables(p.variables) : variablesOf(base)
    }
    checkContent(content)
    const contentSeqId = draft?.contentSeqId || nextContentSeqId(template.messageTemplateId)
    const files = writeFiles(template.messageTemplateId, contentSeqId, content.body, content.bodyText)
    const values = {
        messageTemplateId: template.messageTemplateId,
        contentSeqId,
        subject: content.subject || null,
        preheader: content.preheader || null,
        bodyLocation: files.bodyLocation,
        bodyTextLocation: files.bodyTextLocation,
        variablesJson: JSON.stringify(content.variables),
        changedByUserId: ec.user.userId || null
    }
    if (draft) call("update#" + C, values)
    else call("create#" + C, Object.assign(values, {createdByUserId: ec.user.userId || null, createdDate: ec.user.nowTimestamp}))
    // the template's revision moves with its content, so a header read before is stale
    call("update#" + T, {messageTemplateId: template.messageTemplateId, endReason: template.endReason || null})
    const stored = one(C, {messageTemplateId: template.messageTemplateId, contentSeqId})
    return {messageTemplateId: template.messageTemplateId, contentSeqId, revision: ms(stored.lastUpdatedStamp)}
}
// preview#Template: a content (the draft, else the one in effect, or the one named) rendered with sample values, the fallbacks
// filling the rest; the required variables with neither, and the channel's limits.
function previewTemplate(p) {
    const scope = reader()
    const template = templateOf(scope, p.messageTemplateId)
    const contents = contentsOf(template.messageTemplateId)
    const content = blank(p.contentSeqId)
        ? draftOf(contents) || currentOf(contents)
        : contents.find(row => row.contentSeqId === text(p.contentSeqId))
    if (!content) denied("NO_CONTENT", "The template has no content yet")
    const values = p.sampleValues && typeof p.sampleValues === "object" ? Object.assign({}, p.sampleValues) : {}
    const rendered = render(content, values)
    const findings = []
    if (!rendered.subject) findings.push("The subject is empty")
    if (rendered.subject.length > 78) findings.push("The subject is longer than 78 characters: many mail apps cut it")
    if (!rendered.body.trim() && !rendered.bodyText.trim()) findings.push("The message has no body")
    if (!rendered.bodyText.trim()) findings.push("No text alternative: mail apps that show text only get none")
    for (const name of rendered.missing) findings.push("${" + name + "} is required and has no value or fallback")
    return {
        contentSeqId: content.contentSeqId,
        renderedSubject: rendered.subject,
        renderedPreheader: rendered.preheader,
        renderedBody: rendered.body,
        // the body cleaned as an allow-html="safe" parameter is, for a screen to show (its HTML was refused unsafe when stored and
        // every value is escaped; this is a second guard)
        safeBody: StringUtilities.cleanHtml(rendered.body),
        renderedText: rendered.bodyText,
        missingVariables: rendered.missing,
        findings,
        variables: variablesOf(content)
    }
}
// publish#Template: the draft takes effect at its date (now, or later), ending the content in effect then; its texts are checked
// again. A reason and the draft's revision are required.
function publishTemplate(p) {
    const scope = editor()
    const template = templateOf(scope, p.messageTemplateId, true)
    if (ended(template)) denied("TEMPLATE_ENDED", "The template has ended")
    const contents = contentsOf(template.messageTemplateId)
    const draft = draftOf(contents)
    if (!draft) denied("NO_DRAFT", "There is no draft to publish")
    requireRevision(draft, p.expectedRevision, "draft")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason for the publication")
    const fromMs = blank(p.fromDate) ? nowMs() : ms(p.fromDate)
    if (fromMs == null || !Number.isFinite(fromMs) || fromMs < nowMs() - 60000)
        denied("DATE_INVALID", "A publication takes effect now or later")
    const content = {
        subject: draft.subject || "",
        preheader: draft.preheader || "",
        body: readText(draft.bodyLocation),
        bodyText: readText(draft.bodyTextLocation),
        variables: variablesOf(draft)
    }
    if (!content.subject) denied("SUBJECT_REQUIRED", "Give the subject before publishing")
    if (!content.body.trim() && !content.bodyText.trim()) denied("BODY_REQUIRED", "Write the body before publishing")
    checkContent(content)
    if (scheduledOf(contents).some(row => ms(row.fromDate) >= fromMs))
        denied("SCHEDULE_CONFLICT", "A content already takes effect on or after that date")
    // the content in effect at the new date ends there
    for (const row of contents)
        if (row.fromDate != null && ms(row.fromDate) < fromMs && (row.thruDate == null || ms(row.thruDate) > fromMs))
            call("update#" + C, {
                messageTemplateId: row.messageTemplateId,
                contentSeqId: row.contentSeqId,
                thruDate: new Date(fromMs)
            })
    call("update#" + C, {
        messageTemplateId: draft.messageTemplateId,
        contentSeqId: draft.contentSeqId,
        fromDate: new Date(fromMs),
        publishedByUserId: ec.user.userId || null,
        publishReason: reason.slice(0, 255)
    })
    call("update#" + T, {messageTemplateId: template.messageTemplateId, endReason: template.endReason || null})
    return {messageTemplateId: template.messageTemplateId, contentSeqId: draft.contentSeqId, fromDate: new Date(fromMs)}
}
// end#Template: no longer offered from now, with a reason; its content in effect ends, its contents stay.
function endTemplate(p) {
    const scope = editor()
    const template = templateOf(scope, p.messageTemplateId, true)
    if (ended(template)) denied("TEMPLATE_ENDED", "The template has ended")
    requireRevision(template, p.expectedRevision, "template")
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Give the reason the template ends")
    const now = ec.user.nowTimestamp
    for (const row of contentsOf(template.messageTemplateId))
        if (row.fromDate != null && (row.thruDate == null || ms(row.thruDate) > ms(now)))
            call("update#" + C, {
                messageTemplateId: row.messageTemplateId,
                contentSeqId: row.contentSeqId,
                thruDate: ms(row.fromDate) > ms(now) ? row.fromDate : now
            })
    call("update#" + T, {messageTemplateId: template.messageTemplateId, thruDate: now, endReason: reason.slice(0, 255)})
    return {messageTemplateId: template.messageTemplateId}
}

// ===== the ledger's template source (MdsrcMessageTemplate) =====
// build#TemplateDelivery: a delivery of a template's EmailTemplate rendered from the content in effect at the attempt, with the
// delivery's queued values for its declared variables (nothing else reaches the renderer); suppressed when the template has ended
// or has no content in effect, or a required variable has neither a value nor a fallback.
function buildDelivery(p) {
    const delivery = one("mantle.party.MessageDelivery", {deliveryId: text(p.deliveryId)})
    if (!delivery) return {suppress: "The delivery is gone"}
    const template = one(T, {emailTemplateId: delivery.templateKey})
    if (!template || ended(template)) return {suppress: "The template is not in use"}
    const content = currentOf(contentsOf(template.messageTemplateId))
    if (!content) return {suppress: "The template has no published content"}
    const rendered = render(content, lib.json(delivery.parametersJson, {}) || {})
    if (rendered.missing.length) return {suppress: "The message needs " + rendered.missing.join(", ")}
    return {
        bodyParameters: {},
        subject: rendered.subject,
        body: rendered.body || null,
        bodyText: rendered.bodyText || null
    }
}

const operations = {
    find: findTemplates,
    get: getTemplate,
    create: createTemplate,
    store: storeTemplate,
    storeContent,
    preview: previewTemplate,
    publish: publishTemplate,
    end: endTemplate,
    buildDelivery
}
;({
    scopeOf,
    namesIn,
    render,
    currentOf,
    contentsOf,
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown message template operation " + op)
        return operations[op](parameters || {})
    }
})
