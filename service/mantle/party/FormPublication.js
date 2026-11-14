// Commons form publication and invitations (design-drawers-commons §19, crosscut X16; impl-customer-service P13 builds them
// under the owner-contract rule): the publication of a dated DbForm by an organization for a purpose, and the guard that keeps
// a response that answers a FormInvitation as submitted. An app's own services (Customer Service's CaseFeedback.js; later
// Marketing's, Sales' and People's) make the invitations, send them and take their answers; the link is an
// ExternalAccessCapability of the FormInvitation record kind (ExternalAccess.js). Refusals carry reason codes.
// impl-people P16 (F51): a publication takes only the access kinds its form's purpose registration lists (mantle.party.FormPurpose
// accessEnumIds); a purpose that lists none (People's: the interview scorecard, the review, the training assessment, the exit
// interview) is answered only by the respondents an app's service assigns, so it has no publication and no link at all.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, rows, call, denied} = lib

const PUBLICATION = "mantle.party.FormPublication",
    INVITATION = "mantle.party.FormInvitation",
    SUBMISSION = "mantle.party.FormSubmission"
const forms = () => ec.resource.script("component://mr-mantle/service/mantle/party/FormDefinitions.js")

// Whether a form's purpose admits a publication of the access kind (FpaInvited, FpaAnonymous, FpaAccount): refused
// (PUBLICATION_NOT_OFFERED) for a purpose whose registration lists it not, or none.
function requireAccess(formId, accessEnumId) {
    const form = formId ? one("moqui.screen.form.DbForm", {formId}) : null
    const registration = form ? forms().registrationOf(form.purposeEnumId) : null
    if (!registration || !forms().accessKinds(registration).includes(accessEnumId))
        denied("PUBLICATION_NOT_OFFERED", "This form is answered only by the people assigned to it, never by a link")
}
// Whether an invitation of the form may carry a link (an invited recipient's): its purpose admits invited recipients.
function linkAllowed(formId) {
    const form = formId ? one("moqui.screen.form.DbForm", {formId}) : null
    const registration = form ? forms().registrationOf(form.purposeEnumId) : null
    return !!registration && forms().accessKinds(registration).includes("FpaInvited")
}

// The organization's open publication of a form for a purpose, made once (invited recipients, one response each, from now).
function publicationFor(organizationPartyId, formId, purposeEnumId, description = null) {
    requireAccess(formId, "FpaInvited")
    const open = rows(PUBLICATION, {organizationPartyId, formId, purposeEnumId}).find(
        row => row.thruDate == null || Number(lib.ms(row.thruDate)) > Number(lib.ms(ec.user.nowTimestamp))
    )
    if (open) return open.publicationId
    return call("create#" + PUBLICATION, {
        organizationPartyId,
        formId,
        purposeEnumId,
        accessEnumId: "FpaInvited",
        repeatEnumId: "FprOnce",
        description,
        fromDate: ec.user.nowTimestamp,
        createdDate: ec.user.nowTimestamp,
        createdByUserId: ec.user.userId || null
    }).publicationId
}
// open#Publication: the editor of a published form (its purpose's edit permission and organization) offers it from now with an
// access kind its purpose admits (PUBLICATION_NOT_OFFERED otherwise: a private purpose takes no publication), for its
// registered publication purpose, once per form and access kind while open.
function openPublication(p) {
    const definitions = forms()
    const form = definitions.formOf(p.formId)
    const accessEnumId = String(p.accessEnumId || "FpaInvited")
    requireAccess(form.formId, accessEnumId)
    const registration = definitions.registrationOf(form.purposeEnumId)
    if (!definitions.formAt(form.formId, null, false).length) denied("FORM_NOT_PUBLISHED", "Publish the form's questions first")
    const purposeEnumId = registration.publicationPurposeEnumId || null
    const nowMs = Number(lib.ms(ec.user.nowTimestamp))
    const open = rows(PUBLICATION, {organizationPartyId: form.ownerPartyId, formId: form.formId, accessEnumId}).find(
        row => row.thruDate == null || Number(lib.ms(row.thruDate)) > nowMs
    )
    if (open) return {publicationId: open.publicationId}
    return {
        publicationId: call("create#" + PUBLICATION, {
            organizationPartyId: form.ownerPartyId,
            formId: form.formId,
            purposeEnumId,
            accessEnumId,
            repeatEnumId: "FprOnce",
            description: p.description || form.description || null,
            fromDate: ec.user.nowTimestamp,
            createdDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId || null
        }).publicationId
    }
}
// The invitation a response answers, or null.
const invitationOf = formResponseId => (formResponseId ? find(INVITATION, {formResponseId}).one() : null)
// The public submission a response came from, or null (impl-marketing P12).
const submissionOf = formResponseId => (formResponseId ? find(SUBMISSION, {formResponseId}).one() : null)
// The guard (FormPublication.eecas.xml): a write of a response, or of its answers, that answers an invitation is refused;
// impl-marketing P12: a published anonymous response (a FormSubmission's) is kept as submitted the same way.
function guardResponse(formResponseId) {
    if (invitationOf(formResponseId))
        denied("RESPONSE_LOCKED", "Response " + formResponseId + " answers an invitation and is kept as it was submitted")
    if (submissionOf(formResponseId))
        denied(
            "RESPONSE_LOCKED",
            "Response " + formResponseId + " was submitted to a publication and is kept as it was submitted"
        )
}

// ===== impl-marketing P12: the publication services (design-drawers-commons §19; design-marketing §10 SurveyDistribution, §13
// SubmitForm) =====
// store#Publication, preview#Publication, close#Publication, create#Invitations and accept#Submission, beside open#Publication: a
// publication is stored by its form's editor (its purpose's edit permission and organization) with an access kind its purpose
// admits, a site, an opening interval and its context record; it opens at fromDate (a draft has none) and closes at thruDate. An
// answer is accepted only while it is open, against the form as of now: an unknown field, an internal one and a value for a field
// its rules hide are refused, never trusted; each value of its type. A page's request key makes one submission: the same key with
// the same answers answers the first, with other answers it is refused. An invited publication answers once per invitation; an
// account's once per party when its repeat policy is once; an anonymous one cannot tell people apart and takes each new key.
const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const nowMs = () => Number(lib.ms(ec.user.nowTimestamp))
const L = words => ec.l10n.localize(words)
const ACCESS = ["FpaInvited", "FpaAnonymous", "FpaAccount"]
const REPEAT = ["FprOnce", "FprMany"]
const textLimits = {titleText: 255, description: 255, completionMessage: 500, introText: 4000}
const LIMITS = {fields: 100, valueChars: 4000, requestKey: 64}
function noExpression(value, what) {
    if (String(value ?? "").includes("${")) denied("NO_EXPRESSIONS", what + " is text, not an expression (${...})")
}
// The state of a publication now: draft (no opening), scheduled (opens later), open, closed.
function stateOf(row, at = nowMs()) {
    const from = lib.ms(row.fromDate)
    const thru = lib.ms(row.thruDate)
    if (thru != null && Number(thru) <= at) return "closed"
    if (from == null) return "draft"
    return Number(from) > at ? "scheduled" : "open"
}
const stateTexts = {draft: "Draft", scheduled: "Scheduled", open: "Open", closed: "Closed"}
// A publication its form's editor (view: or reader) may reach: a missing one, one of a form not theirs and one of another
// organization are RECORD_UNAVAILABLE alike.
function publicationOf(publicationId, options = {}) {
    const row = blank(publicationId) ? null : one(PUBLICATION, {publicationId: String(publicationId)})
    if (!row) denied("RECORD_UNAVAILABLE", "Publication " + (publicationId || "") + " is not available")
    let form
    try {
        form = forms().formOf(row.formId, {view: !!options.view, noun: "form"})
    } catch (error) {
        if (lib.reasonCode(error) === "PERMISSION_DENIED") throw error
        denied("RECORD_UNAVAILABLE", "Publication " + publicationId + " is not available")
    }
    if (form.ownerPartyId !== row.organizationPartyId)
        denied("RECORD_UNAVAILABLE", "Publication " + publicationId + " is not available")
    if (options.lock) return {row: find(PUBLICATION, {publicationId: row.publicationId}).forUpdate(true).one(), form}
    return {row, form}
}
const revisionOf = row => Number(lib.ms(row.lastUpdatedStamp) || 0)
function requireRevision(row, expectedRevision) {
    if (blank(expectedRevision)) return
    if (Number(expectedRevision) !== revisionOf(row))
        denied("REVISION_CHANGED", "The publication changed since you read it (now revision " + revisionOf(row) + "); reload it")
}
const submissionCount = publicationId => find(SUBMISSION, {publicationId}).count()
// store#Publication: a new publication of a form (formId) or a change of one (publicationId, at the revision read). A publication with
// submissions keeps its form and access kind.
function storePublication(p) {
    const definitions = forms()
    let row = null,
        form
    if (!blank(p.publicationId)) {
        const found = publicationOf(p.publicationId, {lock: true})
        row = found.row
        form = found.form
        requireRevision(row, p.expectedRevision)
        if (stateOf(row) === "closed") denied("PUBLICATION_CLOSED", "A closed publication is not changed; make a new one")
    } else form = definitions.formOf(p.formId)
    const registration = definitions.registrationOf(form.purposeEnumId)
    const accessEnumId = text(p.accessEnumId) || row?.accessEnumId || "FpaInvited"
    if (!ACCESS.includes(accessEnumId)) denied("ACCESS_INVALID", "Choose who answers")
    requireAccess(form.formId, accessEnumId)
    const repeatEnumId = text(p.repeatEnumId) || row?.repeatEnumId || "FprOnce"
    if (!REPEAT.includes(repeatEnumId)) denied("REPEAT_INVALID", "Choose once or several times")
    if (row && submissionCount(row.publicationId) && accessEnumId !== row.accessEnumId)
        denied("PUBLICATION_ANSWERED", "A publication with answers keeps who answers it")
    const values = {}
    for (const [name, limit] of Object.entries(textLimits)) {
        if (p[name] === undefined) continue
        const value = text(p[name])
        noExpression(value, name === "introText" ? "The introduction" : "Its text")
        if (value && value.length > limit) denied("TEXT_TOO_LONG", "At most " + limit + " characters")
        values[name] = value
    }
    if (p.siteId !== undefined) {
        const siteId = text(p.siteId)
        if (siteId && !one("mantle.public.PublicSite", {siteId})) denied("SITE_INVALID", "Choose a site")
        values.siteId = siteId
    }
    if (p.contextEntityName !== undefined) values.contextEntityName = text(p.contextEntityName)
    if (p.contextId !== undefined) values.contextId = text(p.contextId)
    const fromDate = p.fromDate !== undefined ? (blank(p.fromDate) ? null : p.fromDate) : (row?.fromDate ?? null)
    const thruDate = p.thruDate !== undefined ? (blank(p.thruDate) ? null : p.thruDate) : (row?.thruDate ?? null)
    if (fromDate != null && thruDate != null && Number(lib.ms(thruDate)) <= Number(lib.ms(fromDate)))
        denied("INTERVAL_INVALID", "It closes after it opens")
    if (thruDate != null && Number(lib.ms(thruDate)) <= nowMs() - 5000) denied("INTERVAL_INVALID", "It closes later than now")
    if (fromDate != null && !definitions.formAt(form.formId, null, false).length)
        denied("FORM_NOT_PUBLISHED", "Publish the form's questions first")
    if (fromDate != null && !row?.fromDate)
        Object.assign(values, {publishedDate: ec.user.nowTimestamp, publishedByUserId: ec.user.userId || null})
    Object.assign(values, {accessEnumId, repeatEnumId, fromDate, thruDate})
    if (row) {
        call("update#" + PUBLICATION, Object.assign({publicationId: row.publicationId}, values))
        return {publicationId: row.publicationId, created: false}
    }
    const publicationId = call(
        "create#" + PUBLICATION,
        Object.assign(
            {
                formId: form.formId,
                organizationPartyId: form.ownerPartyId,
                purposeEnumId: registration.publicationPurposeEnumId || null,
                description: values.description || form.description || null,
                createdDate: ec.user.nowTimestamp,
                createdByUserId: ec.user.userId || null
            },
            values
        )
    ).publicationId
    return {publicationId, created: true}
}
// The fields a respondent answers on a page as of a date: the customer-visible ones with their rules (FormDefinitions.js), each with
// its kind, label, help, required flag and options; never an internal field or a score.
const kinds = {
    DBFFT_radio: "radio",
    "DBFFT_drop-down": "select",
    DBFFT_check: "checks",
    "DBFFT_text-line": "text",
    "DBFFT_text-area": "textarea",
    "DBFFT_date-time": "date"
}
const ruleView = rule =>
    rule
        ? {
              field: rule.field,
              operator: rule.operator,
              values: String(rule.value ?? "")
                  .split(",")
                  .filter(Boolean)
          }
        : null
function pageFields(formId, asOfDate = null) {
    const definitions = forms()
    return definitions
        .customerProjection(definitions.formAt(formId, asOfDate, false))
        .filter(field => kinds[field.fieldTypeEnumId])
        .map(field => ({
            fieldName: field.fieldName,
            kind: kinds[field.fieldTypeEnumId],
            title: field.title,
            tooltip: field.tooltip || "",
            required: !!field.required,
            maxLength: definitions.TYPES[field.fieldTypeEnumId]?.maxLength || null,
            options: field.options.map(option => ({key: option.key, text: option.text})),
            show: ruleView(field.show),
            require: ruleView(field.require)
        }))
}
// A publication's view for its editors and readers.
function publicationView(row, form) {
    const state = stateOf(row)
    return {
        publicationId: row.publicationId,
        formId: row.formId,
        formName: form?.description || row.formId,
        organizationPartyId: row.organizationPartyId,
        purposeEnumId: row.purposeEnumId,
        accessEnumId: row.accessEnumId,
        repeatEnumId: row.repeatEnumId,
        siteId: row.siteId || null,
        contextEntityName: row.contextEntityName || null,
        contextId: row.contextId || null,
        description: row.description || "",
        titleText: row.titleText || "",
        introText: row.introText || "",
        completionMessage: row.completionMessage || "",
        fromDate: row.fromDate || null,
        thruDate: row.thruDate || null,
        fromText: lib.dateText(row.fromDate),
        thruText: lib.dateText(row.thruDate),
        state,
        stateText: L(stateTexts[state]),
        revision: revisionOf(row),
        submissionCount: submissionCount(row.publicationId),
        invitationCount: find(INVITATION, {publicationId: row.publicationId}).count()
    }
}
// preview#Publication: what a respondent sees (the heading, introduction, the fields as of its opening or now and the completion
// words), for the form's editor or reader; changes nothing.
function previewPublication(p) {
    const {row, form} = publicationOf(p.publicationId, {view: true})
    const asOf = row.fromDate != null && Number(lib.ms(row.fromDate)) > nowMs() ? row.fromDate : null
    return {
        publication: publicationView(row, form),
        page: {
            title: row.titleText || form.description || "",
            intro: row.introText || "",
            fields: pageFields(row.formId, asOf),
            completionMessage: row.completionMessage || L("Thank you. Your answer is recorded.")
        }
    }
}
// close#Publication: it stops taking answers at thruDate (now, or later), by its form's editor; answers kept.
function closePublication(p) {
    const {row} = publicationOf(p.publicationId, {lock: true})
    requireRevision(row, p.expectedRevision)
    if (stateOf(row) === "closed") return {publicationId: row.publicationId, closed: false}
    const thruDate = blank(p.thruDate) ? ec.user.nowTimestamp : p.thruDate
    if (Number(lib.ms(thruDate)) < nowMs() - 5000) denied("INTERVAL_INVALID", "It closes now or later")
    call("update#" + PUBLICATION, {publicationId: row.publicationId, thruDate, closedByUserId: ec.user.userId || null})
    return {publicationId: row.publicationId, closed: true}
}
// One recipient's invitation of a publication of invited recipients, made once by its key (an app's caller checked who may send
// it); {invitationId, created}.
function invite(row, recipient) {
    if (row.accessEnumId !== "FpaInvited") denied("PUBLICATION_NOT_OFFERED", "This publication takes no invitations")
    const invitationKey = text(recipient.invitationKey)
    if (!invitationKey || !recipient.partyId) denied("VALUE_INVALID", "An invitation names its recipient and its key")
    const earlier = one(INVITATION, {invitationKey})
    if (earlier) return {invitationId: earlier.invitationId, created: false}
    const invitationId = call("create#" + INVITATION, {
        publicationId: row.publicationId,
        formId: row.formId,
        organizationPartyId: row.organizationPartyId,
        partyId: recipient.partyId,
        contactPartyId: recipient.contactPartyId || recipient.partyId,
        emailAddress: text(recipient.emailAddress),
        contextEntityName: text(recipient.contextEntityName) || row.contextEntityName || null,
        contextId: text(recipient.contextId) || row.contextId || null,
        recordEntityName: text(recipient.recordEntityName),
        recordId: text(recipient.recordId),
        invitationKey,
        statusEnumId: recipient.statusEnumId || "FinScheduled",
        scheduledDate: ec.user.nowTimestamp,
        expireDate: recipient.expireDate || row.thruDate || null,
        reminderCount: 0,
        attemptCount: 0,
        createdDate: ec.user.nowTimestamp
    }).invitationId
    return {invitationId, created: true}
}
// create#Invitations: the form's editor invites recipients ([{partyId, contactPartyId, emailAddress, invitationKey}]) to an open or
// draft publication of invited recipients, each once by its key; the app's own service sends them. {invitationIds, createdCount}.
function createInvitations(p) {
    const {row} = publicationOf(p.publicationId, {lock: true})
    if (stateOf(row) === "closed") denied("PUBLICATION_CLOSED", "The publication is closed")
    const out = {invitationIds: [], createdCount: 0}
    for (const recipient of Array.from(p.recipients || [])) {
        const made = invite(row, Object.assign({}, recipient))
        out.invitationIds.push(made.invitationId)
        if (made.created) out.createdCount++
    }
    return out
}
// A canonical digest of submitted values: the keys in order, each value as text (a list joined).
function payloadDigest(values) {
    const entries = Object.keys(values || {})
        .sort()
        .map(key => {
            const value = values[key]
            const list = Array.isArray(value)
                ? value
                : value != null && typeof value === "object" && value.length != null
                  ? Array.from(value)
                  : null
            return [key, list ? list.map(String).join("\u001f") : value == null ? "" : String(value)]
        })
    return ec.user.singleUseCodeHash("form-payload:" + JSON.stringify(entries))
}
// accept#Submission: an answer to a publication (its app's page checked the site, the visitor's limits and, for an invitation, its
// link; invitationId and partyId are what it verified): {formSubmissionId, formResponseId, alreadyApplied}.
function acceptSubmission(p) {
    const publication = one(PUBLICATION, {publicationId: text(p.publicationId)})
    if (!publication) denied("PUBLICATION_UNAVAILABLE", "This form is not available")
    const requestKeyText = text(p.requestKey)
    if (!requestKeyText || !/^[A-Za-z0-9_-]{8,64}$/.test(requestKeyText))
        denied("REQUEST_KEY_INVALID", "Reload the page and try again")
    const values = Object.assign({}, p.values || {})
    const requestKey = ec.user.singleUseCodeHash("form-submission:" + publication.publicationId + ":" + requestKeyText)
    const digest = payloadDigest(values)
    // a repeat of the request key: the same answers answer the first; others are refused
    const repeat = () => {
        const earlier = one(SUBMISSION, {requestKey})
        if (!earlier) return null
        if (earlier.payloadDigest !== digest)
            denied("REQUEST_KEY_REUSED", "This page was already sent with other answers; reload it")
        return {formSubmissionId: earlier.formSubmissionId, formResponseId: earlier.formResponseId, alreadyApplied: true}
    }
    const first = repeat()
    if (first) return first
    if (stateOf(publication) !== "open") denied("PUBLICATION_CLOSED", "This form is not taking answers")
    const access = publication.accessEnumId
    let invitation = null
    if (access === "FpaInvited") {
        invitation = blank(p.invitationId)
            ? null
            : find(INVITATION, {invitationId: String(p.invitationId)})
                  .forUpdate(true)
                  .one()
        if (!invitation || invitation.publicationId !== publication.publicationId)
            denied("INVITATION_REQUIRED", "This form is answered from its invitation")
        // under the invitation's lock: a concurrent post with the same key finds the first here
        const again = repeat()
        if (again) return again
        if (invitation.formResponseId) denied("ALREADY_ANSWERED", "This invitation has its answer")
    } else if (access === "FpaAccount") {
        if (blank(p.partyId)) denied("ACCOUNT_REQUIRED", "Sign in to answer this form")
        if (
            publication.repeatEnumId === "FprOnce" &&
            find(SUBMISSION, {publicationId: publication.publicationId, partyId: String(p.partyId)}).count() > 0
        )
            denied("ALREADY_ANSWERED", "You have answered this form")
    }
    // the answers: only the respondent's fields as of now, never an unknown or internal one, nor a hidden one's value
    const definitions = forms()
    const keys = Object.keys(values)
    if (keys.length > LIMITS.fields) denied("FIELD_UNKNOWN", "The page sent fields this form does not have")
    const customer = new Set(
        definitions
            .formAt(publication.formId, null, false)
            .filter(field => field.audienceEnumId === definitions.CUSTOMER)
            .map(field => field.fieldName)
    )
    const unknown = keys.filter(key => !customer.has(key))
    if (unknown.length) denied("FIELD_UNKNOWN", "The page sent fields this form does not have")
    for (const key of keys) {
        const value = values[key]
        const parts = Array.isArray(value)
            ? value
            : value != null && typeof value === "object" && value.length != null
              ? Array.from(value)
              : [value]
        if (parts.some(part => String(part ?? "").length > LIMITS.valueChars)) denied("VALUE_TOO_LONG", "An answer is too long")
    }
    const checked = definitions.checkValues(publication.formId, values, "customer", null, false)
    const hidden = checked.hiddenFieldNames.filter(name => {
        const value = values[name]
        return value != null && String(Array.isArray(value) ? value.join("") : value).trim() !== ""
    })
    if (hidden.length) denied("FIELD_HIDDEN", "The page sent an answer to a question that is not asked")
    if (!checked.valid) denied("FORM_VALUES_INVALID", checked.errors.map(error => error.message).join("; "))
    const submittedDate = ec.user.nowTimestamp
    const formResponseId = call("org.moqui.impl.ScreenServices.create#FormResponse", {
        formId: publication.formId,
        formLocation: "DbForm#" + publication.formId,
        userId: ec.user.userId || null,
        responseDate: submittedDate,
        responseMap: checked.values
    }).formResponseId
    const formSubmissionId = call("create#" + SUBMISSION, {
        publicationId: publication.publicationId,
        formId: publication.formId,
        organizationPartyId: publication.organizationPartyId,
        formResponseId,
        invitationId: invitation?.invitationId || null,
        partyId: invitation?.partyId || text(p.partyId),
        siteId: text(p.siteId),
        requestKey,
        payloadDigest: digest,
        submittedDate,
        statusEnumId: "FsbAccepted"
    }).formSubmissionId
    if (invitation) {
        invitation.set("formResponseId", formResponseId)
        invitation.set("responseDate", submittedDate)
        invitation.set("statusEnumId", "FinResponded")
        invitation.set("nextReminderDate", null)
        invitation.update()
    }
    return {formSubmissionId, formResponseId, alreadyApplied: false}
}
// A submission's effects recorded (an app's after-acceptance work): applied, or failed with why (no answer text).
function recordEffects(formSubmissionId, failed, effectsText) {
    call("update#" + SUBMISSION, {
        formSubmissionId,
        statusEnumId: failed ? "FsbEffectFailed" : "FsbApplied",
        effectsText: text(effectsText) ? String(effectsText).substring(0, 255) : null
    })
}
// The invitation's guard (FormPublication.eecas.xml): once an invitation has its response, the link is kept, so unlinking it
// (a change of formResponseId) or deleting the invitation cannot take its response past guardResponse.
function guardInvitation(invitationId, formResponseId, originalFormResponseId, deleting = false) {
    if (originalFormResponseId && (deleting || formResponseId !== originalFormResponseId))
        denied(
            "RESPONSE_LOCKED",
            "Invitation " + invitationId + " has its response " + originalFormResponseId + " and is kept with it"
        )
}
const operations = {openPublication, storePublication, previewPublication, closePublication, createInvitations, acceptSubmission}
;({
    publicationFor,
    invitationOf,
    submissionOf,
    guardResponse,
    guardInvitation,
    requireAccess,
    linkAllowed,
    // impl-marketing P12: for the apps' own modules (Marketing's MarketingForms.js and MarketingPortal.js)
    stateOf,
    publicationOf,
    publicationView,
    pageFields,
    invite,
    acceptSubmission,
    recordEffects,
    payloadDigest,
    execute(op, parameters) {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown form publication operation " + op)
        const wasDisabled = ec.artifactExecution.disableAuthz()
        try {
            return operations[op](parameters || {})
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
    }
})
