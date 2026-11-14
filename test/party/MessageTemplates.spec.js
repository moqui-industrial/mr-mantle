// Comms' template library (impl-marketing P6, F78; design-marketing §5 MessageTemplates and MessageTemplateDetail; mantle.party.
// MessageServices over MessageTemplates.js): a template editor makes a template with its EmailTemplate and writes its content with
// declared variables and fallbacks; an undeclared variable, an expression, a template tag, a script or unsafe HTML and a variable in
// a link are refused when stored; a reader cannot write and another organization's template answers as missing; the preview renders
// through the locked renderer with the fallbacks, escaping what it is given; a published content is never changed: a change is a new
// draft, whose publication ends the one before; the ledger's template source sends the content in effect with the delivery's values.
// Standalone: spec-local organizations, users and parties. Run: ./moq test mr-mantle --spec MessageTemplates
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const M = "mantle.party.MessageServices."
const T = "mantle.party.MessageTemplateContent"
const capture = ec.factory.getTool("MailCapture")
const prefix = "MTP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const ids = {buyer: prefix + "_BUYER"}
let templateId, emailTemplateId
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const revisionOf = (entity, fields) => entityLib.ms(row(entity, fields).lastUpdatedStamp)
const variables = [
    {name: "firstName", label: "First name", fallback: "friend"},
    {name: "offer", label: "Offer", required: true}
]

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Templates A")
            organization(orgB, "Templates B")
            users.editor = user(prefix, "editor", [orgA], ["MESSAGE_TEMPLATE_VIEW", "MESSAGE_TEMPLATE_EDIT"])
            users.reader = user(prefix, "reader", [orgA], ["MESSAGE_TEMPLATE_VIEW"])
            users.editorB = user(prefix, "editorB", [orgB], ["MESSAGE_TEMPLATE_VIEW", "MESSAGE_TEMPLATE_EDIT"])
            make("mantle.party.Party", {partyId: ids.buyer, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.buyer, firstName: "Template", lastName: "Buyer"})
        })
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("an editor writes a template's content with declared variables; what the parse refuses is refused when stored", {
    when() {
        const made = as(users.editor, M + "create#Template", {
            organizationPartyId: orgA,
            templateName: "Spring offer",
            purposeEnumId: "MtpPromotional"
        })
        templateId = made.messageTemplateId
        emailTemplateId = made.emailTemplateId
        const store = (parameters, username = users.editor) =>
            as(
                username,
                M + "store#TemplateContent",
                Object.assign(
                    {
                        messageTemplateId: templateId,
                        expectedRevision: revisionOf("mantle.party.MessageTemplate", {messageTemplateId: templateId}),
                        subject: "Hello ${firstName}",
                        body: "<p>Dear ${firstName}, ${offer}</p>",
                        bodyText: "Dear ${firstName}, ${offer}",
                        variables
                    },
                    parameters
                )
            )
        return {
            made,
            undeclared: store({body: "<p>Dear ${lastName}</p>"}),
            expression: store({subject: "Hello ${firstName.toUpperCase()}"}),
            directive: store({body: "<#if offer>${offer}</#if>"}),
            script: store({body: "<p>Hi</p><script>alert(1)</script>"}),
            handler: store({body: '<img src="x.png" onerror="alert(1)">'}),
            scriptLink: store({body: '<a href="javascript:alert(1)">x</a>'}),
            // P6 review: an attribute after a slash, and a script link written with character references
            slashHandler: store({body: "<img/src=x.png/onerror=alert(1)>"}),
            encodedLink: store({body: '<a href="&#106;ava&#x09;script&colon;alert(1)">x</a>'}),
            inLink: store({body: '<a href="https://shop.example/${offer}">Shop</a>'}),
            reserved: store({variables: [{name: "raw"}]}),
            reader: store({}, users.reader),
            readerCreate: as(users.reader, M + "create#Template", {
                organizationPartyId: orgA,
                templateName: "No",
                purposeEnumId: "MtpPromotional"
            }),
            otherOrg: as(users.editorB, M + "get#Template", {messageTemplateId: templateId}),
            otherCreate: as(users.editorB, M + "create#Template", {
                organizationPartyId: orgA,
                templateName: "No",
                purposeEnumId: "MtpPromotional"
            }),
            stored: store({}),
            stale: store({expectedRevision: 1})
        }
    },
    then({
        made,
        undeclared,
        expression,
        directive,
        script,
        handler,
        scriptLink,
        slashHandler,
        encodedLink,
        inLink,
        reserved,
        reader,
        readerCreate,
        otherOrg,
        otherCreate,
        stored,
        stale
    }) {
        made.refusal == ""
        row("moqui.basic.email.EmailTemplate", {emailTemplateId}).description == "Spring offer"
        undeclared.refusal.includes("UNDECLARED_VARIABLE") && undeclared.refusal.includes("lastName")
        expression.refusal.includes("VARIABLE_EXPRESSION")
        directive.refusal.includes("TEMPLATE_DIRECTIVE")
        script.refusal.includes("UNSAFE_HTML") &&
            handler.refusal.includes("UNSAFE_HTML") &&
            scriptLink.refusal.includes("UNSAFE_HTML") &&
            slashHandler.refusal.includes("UNSAFE_HTML") &&
            encodedLink.refusal.includes("UNSAFE_HTML")
        inLink.refusal.includes("VARIABLE_IN_LINK")
        reserved.refusal.includes("VARIABLE_INVALID")
        reader.refusal.includes("PERMISSION_DENIED") && readerCreate.refusal.includes("PERMISSION_DENIED")
        otherOrg.refusal.includes("RECORD_UNAVAILABLE") && otherCreate.refusal.includes("ORGANIZATION_DENIED")
        stored.refusal == "" && stored.contentSeqId == "001"
        stale.refusal.includes("STALE_RECORD")
        // the body is a .html.fancy-locked resource of its own; nothing refused was written
        const content = row(T, {messageTemplateId: templateId, contentSeqId: "001"})
        content.bodyLocation.startsWith("dbresource://") && content.bodyLocation.endsWith(".html.fancy-locked")
        content.fromDate == null
        rows(T, {messageTemplateId: templateId}).length == 1
    }
})

feature(
    "the preview renders with the fallbacks and escapes values; a published content is never changed; a change is a new draft",
    {
        when() {
            const preview = as(users.reader, M + "preview#Template", {
                messageTemplateId: templateId,
                sampleValues: {offer: "<b>20% off</b>"}
            })
            const missing = as(users.reader, M + "preview#Template", {messageTemplateId: templateId})
            const draftRevision = () => revisionOf(T, {messageTemplateId: templateId, contentSeqId: "001"})
            const noReason = as(users.editor, M + "publish#Template", {
                messageTemplateId: templateId,
                expectedRevision: draftRevision()
            })
            const published = as(users.editor, M + "publish#Template", {
                messageTemplateId: templateId,
                expectedRevision: draftRevision(),
                reason: "Spring campaign"
            })
            const first = row(T, {messageTemplateId: templateId, contentSeqId: "001"})
            const changed = as(users.editor, M + "store#TemplateContent", {
                messageTemplateId: templateId,
                expectedRevision: revisionOf("mantle.party.MessageTemplate", {messageTemplateId: templateId}),
                subject: "Last days, ${firstName}"
            })
            const firstAfterChange = row(T, {messageTemplateId: templateId, contentSeqId: "001"})
            const second = as(users.editor, M + "publish#Template", {
                messageTemplateId: templateId,
                expectedRevision: revisionOf(T, {messageTemplateId: templateId, contentSeqId: "002"}),
                reason: "Last days"
            })
            return {
                preview,
                missing,
                noReason,
                published,
                first,
                changed,
                firstAfterChange,
                second,
                found: as(users.reader, M + "get#Template", {messageTemplateId: templateId})
            }
        },
        then({preview, missing, noReason, published, first, changed, firstAfterChange, second, found}) {
            preview.refusal == ""
            preview.renderedSubject == "Hello friend"
            preview.renderedBody.includes("Dear friend") && preview.renderedBody.includes("&lt;b&gt;20% off&lt;/b&gt;")
            !preview.renderedBody.includes("<b>")
            Array.from(missing.missingVariables) == ["offer"]
            noReason.refusal.includes("REASON_REQUIRED")
            published.refusal == "" && first.fromDate != null
            // the change made a draft of its own; the published content kept its texts
            changed.refusal == "" && changed.contentSeqId == "002"
            firstAfterChange.subject == "Hello ${firstName}" && firstAfterChange.bodyLocation == first.bodyLocation
            second.refusal == ""
            row(T, {messageTemplateId: templateId, contentSeqId: "001"}).thruDate != null
            found.template.state == "published" && found.current.subject == "Last days, ${firstName}"
            found.contentList.length == 2 && found.draft == null
        }
    }
)

feature("the ledger's template source sends the content in effect with the delivery's values; an ended template sends nothing", {
    when() {
        make("moqui.basic.email.EmailServer", {
            emailServerId: prefix + "_SMTP",
            smtpHost: "127.0.0.1",
            smtpPort: "9",
            smtpStartTls: "N"
        })
        system(() =>
            lib.run("update#moqui.basic.email.EmailTemplate", {
                emailTemplateId,
                emailServerId: prefix + "_SMTP",
                fromAddress: "news@templates.example.test"
            })
        )
        const queue = (eventKey, bodyParameters, organizationPartyId = orgA) =>
            system(() =>
                lib.run(M + "queue#Delivery", {
                    eventKey,
                    sourceEnumId: "MdsrcMessageTemplate",
                    recipientPartyId: ids.buyer,
                    toAddress: "buyer@templates.example.test",
                    templateKey: emailTemplateId,
                    organizationPartyId,
                    bodyParameters,
                    sendNow: true
                })
            )
        capture.clear()
        const sent = queue("spec:template-1", {firstName: "Ana", offer: "Free <shipping>", password: "never"})
        const mail = capture.last()
        const needs = queue("spec:template-2", {firstName: "Ben"})
        // P6 review: another organization's delivery never sends this organization's template
        const otherOrg = queue("spec:template-other", {firstName: "Di", offer: "x"}, orgB)
        const ended = as(users.editor, M + "end#Template", {
            messageTemplateId: templateId,
            expectedRevision: revisionOf("mantle.party.MessageTemplate", {messageTemplateId: templateId}),
            reason: "Season over"
        })
        const after = queue("spec:template-3", {firstName: "Cy", offer: "x"})
        return {sent, mail, needs, otherOrg, ended, after}
    },
    then({sent, mail, needs, otherOrg, ended, after}) {
        sent.stateEnumId == "MdsSent"
        mail.subject == "Last days, Ana"
        mail.body.includes("Free &lt;shipping&gt;") && !mail.body.includes("never")
        mail.bodyText.includes("Dear Ana")
        needs.stateEnumId == "MdsSuppressed"
        otherOrg.stateEnumId == "MdsSuppressed"
        ended.refusal == ""
        after.stateEnumId == "MdsSuppressed"
    }
})
