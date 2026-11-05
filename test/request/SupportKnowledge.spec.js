// Service knowledge (impl-customer-service P12: CS-KNOWLEDGE, F15, F59; mantle.request.KnowledgeServices, Knowledge.js): the
// sources' dated save and its refusals; suggestions in the requester's language first, an agent's surface with drafts and
// internal articles flagged and a restricted page left out, a customer-visible surface with neither drafts nor internal
// articles; the published article by its exact published version; the public link refusing a draft and an internal article;
// feedback recorded and reviewed in a batch that names each failure, making one task and leaving the article unchanged; a
// suggested edit's task; an article drafted from a case, redacted, unpublished and linked, refusing an internal note.
// Standalone: spec-local organizations, customer, case, wiki spaces, groups and users, artifact authorization disabled (the
// rules are the services' own checks and the wiki's). Run: ./moq test mr-mantle --spec SupportKnowledge
const prefix = "KNS"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    contact = prefix + "_CONTACT",
    since = "2000-01-01T00:00:00Z"
const K = "mantle.request.KnowledgeServices."
const W = "org.moqui.impl.WikiServices."
const PAGE = "moqui.resource.wiki.WikiPage",
    SOURCE = "mantle.request.support.ServiceKnowledgeSource",
    FEEDBACK = "mantle.request.support.ArticleFeedback"
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const rows = (entity, conditions) => Array.from(find(entity, conditions).list())
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters) {
    login(username)
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
function party(partyId, name, roleTypeId, ownerPartyId, typeId = "PtyOrganization") {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: typeId, ownerPartyId: ownerPartyId || "_NA_"})
    if (typeId === "PtyOrganization") call("create#mantle.party.Organization", {partyId, organizationName: name})
    else call("create#mantle.party.Person", {partyId, firstName: name, lastName: "Spec"})
    if (roleTypeId) call("create#mantle.party.PartyRole", {partyId, roleTypeId})
}
function account(id, locale) {
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        locale: locale || null,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
}
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Knowledge " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Knowledge " + kind, null, organizationPartyId, "PtyPerson")
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    account(id)
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// a page with its text as one version, published when asked: its id and version
function page(wikiSpaceId, parentPath, pageName, pageText, publish = true) {
    const out = call(W + "update#WikiPage", {wikiSpaceId, parentPath, pageName, pageText})
    if (publish) call(W + "set#PublishedVersion", {wikiPageId: out.wikiPageId, publishedVersionName: out.versionName})
    return {wikiPageId: out.wikiPageId, versionName: out.versionName}
}
// a case of the organization for the customer and its contact, as create#Case leaves it (the profile made directly: the case
// rule is SupportCases' spec)
function supportCase(requestId, organizationPartyId, requestName) {
    call("create#mantle.request.Request", {requestId, requestName, requestTypeEnumId: "RqtSupport", statusId: "ReqSubmitted"})
    for (const [partyId, roleTypeId] of [
        [organizationPartyId, "OrgInternal"],
        [customer, "Customer"],
        [contact, "Reporter"]
    ])
        call("create#mantle.request.RequestParty", {requestId, partyId, roleTypeId, fromDate: since})
    call("create#mantle.request.support.CaseProfile", {requestId, caseWorkflowId: "CwfDefault", intakeDate: since})
}
function message(requestId, typeId, fromPartyId, body) {
    const out = call("create#mantle.party.communication.CommunicationEvent", {
        communicationEventTypeId: typeId,
        fromPartyId,
        toPartyId: fromPartyId === customer ? org : customer,
        subject: "Re: pairing",
        contentType: "text/html",
        body,
        entryDate: ec.user.nowTimestamp
    })
    call("create#mantle.request.RequestCommEvent", {requestId, communicationEventId: out.communicationEventId})
    return out.communicationEventId
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Knowledge Spec Org", "OrgInternal")
        party(otherOrg, "Knowledge Spec Other Org", "OrgInternal")
        party(customer, "Knowledge Spec Customer", "Customer", org)
        party(contact, "Ana", "Customer", org, "PtyPerson")
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtContact",
            fromPartyId: contact,
            toPartyId: customer,
            fromDate: since
        })
        // the contact reads Spanish
        account(contact, "es_MX")
        state.team = prefix + "_TEAM"
        party(state.team, "Knowledge review team", "OrgTeam", org)
        state.otherTeam = prefix + "_OTHER_TEAM"
        party(state.otherTeam, "Other review team", "OrgTeam", otherOrg)
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.author = user("AUTHOR", ["SUPPORT_KNOWLEDGE_EDIT", "SUPPORT_CASE_EDIT"])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_KNOWLEDGE_EDIT", "SUPPORT_CASE_EDIT"], otherOrg)
        // the help center (customers, English and Spanish parts), the internal notes and the draft space
        call(W + "create#WikiSpace", {
            wikiSpaceId: "KNSHELP",
            description: "Spec help center",
            publicPageUrl: "https://help.example.com/${pagePath}?v=${versionName}"
        })
        call(W + "create#WikiSpace", {wikiSpaceId: "KNSINT", description: "Spec service notes"})
        call(W + "create#WikiSpace", {wikiSpaceId: "KNSDRFT", description: "Spec drafts"})
        state.english = page("KNSHELP", "help", "Z100 thermostat pairing", "Hold the button for five seconds to pair.")
        state.spanish = page("KNSHELP", "help/es", "Z100 termostato emparejar", "Mantenga el botón cinco segundos.")
        state.draft = page("KNSHELP", "help", "Z100 thermostat battery", "Not finished.", false)
        state.restricted = page("KNSHELP", "help", "Z100 thermostat recall plan", "Restricted.")
        call("update#" + PAGE, {wikiPageId: state.restricted.wikiPageId, restrictView: "Y"})
        state.internal = page("KNSINT", "", "Z100 thermostat known faults", "Swap the board under warranty.")
        state.other = page("KNSINT", "", "Other organization note", "Theirs.")
        supportCase("KNS_CASE", org, "Z100 thermostat will not pair")
        supportCase("KNS_OTHER_CASE", otherOrg, "Z100 thermostat will not pair")
        call("create#mantle.request.RequestRecord", {
            requestId: "KNS_CASE",
            recordEntityName: "mantle.order.OrderHeader",
            recordId: "KNSORD77"
        })
        state.outward = message(
            "KNS_CASE",
            "Email",
            state.agent,
            "<p>Hello Ana Spec, hold the pair button for five seconds.</p><p>Write to ana@example.com or call 555-123-4567 about order KNSORD77.</p>"
        )
        state.note = message("KNS_CASE", "Comment", state.agent, "<p>Internal: the customer was rude.</p>")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("the knowledge sources: a dated save of each part of a space, and its refusals", {
    when() {
        const save = (username, values) =>
            run(username, K + "save#ServiceKnowledgeSource", Object.assign({organizationPartyId: org}, values))
        const english = save(state.admin, {
            wikiSpaceId: "KNSHELP",
            pagePathPrefix: "help",
            audienceEnumId: "SkaCustomer",
            localeLanguage: "en",
            reviewTeamPartyId: state.team,
            draftWikiSpaceId: "KNSDRFT",
            draftParentPath: "drafts",
            sequenceNum: 1
        })
        state.englishSource = english.serviceKnowledgeSourceId
        const spanish = save(state.admin, {
            wikiSpaceId: "KNSHELP",
            pagePathPrefix: "help/es",
            audienceEnumId: "SkaCustomer",
            localeLanguage: "es"
        })
        const internal = save(state.admin, {
            wikiSpaceId: "KNSINT",
            audienceEnumId: "SkaInternal",
            localeLanguage: "en",
            sequenceNum: 5
        })
        // another organization's source of the internal space: its pages are not this organization's
        const others = run(state.otherAdmin, K + "save#ServiceKnowledgeSource", {
            organizationPartyId: otherOrg,
            wikiSpaceId: "KNSINT",
            pagePathPrefix: "Other organization note",
            audienceEnumId: "SkaInternal",
            localeLanguage: "en"
        })
        // a second save of the English source ends its first row, so history stays
        const edited = save(state.admin, {serviceKnowledgeSourceId: state.englishSource, sequenceNum: 2})
        state.englishSource = edited.serviceKnowledgeSourceId
        return {
            english,
            spanish,
            internal,
            others,
            edited,
            byAgent: save(state.agent, {wikiSpaceId: "KNSHELP", localeLanguage: "en"}),
            otherOrganization: save(state.otherAdmin, {wikiSpaceId: "KNSHELP", localeLanguage: "en"}),
            badAudience: save(state.admin, {wikiSpaceId: "KNSHELP", audienceEnumId: "SkaEveryone", localeLanguage: "en"}),
            noLanguage: save(state.admin, {wikiSpaceId: "KNSHELP", audienceEnumId: "SkaCustomer"}),
            noSpace: save(state.admin, {wikiSpaceId: "KNSNONE", localeLanguage: "en"}),
            internalPublic: save(state.admin, {wikiSpaceId: "KNSHELP", audienceEnumId: "SkaInternal", localeLanguage: "en"}),
            otherTeam: save(state.admin, {
                wikiSpaceId: "KNSHELP",
                audienceEnumId: "SkaCustomer",
                localeLanguage: "en",
                reviewTeamPartyId: state.otherTeam
            }),
            englishRows: rows(SOURCE, {organizationPartyId: org, wikiSpaceId: "KNSHELP", pagePathPrefix: "help"})
        }
    },
    then(r) {
        r.english.error == ""
        r.spanish.error == ""
        r.internal.error == ""
        r.others.error == ""
        r.edited.error == ""
        code(r.byAgent) == "PERMISSION_DENIED"
        code(r.otherOrganization) == "RECORD_UNAVAILABLE"
        code(r.badAudience) == "AUDIENCE_INVALID"
        code(r.noLanguage) == "LANGUAGE_REQUIRED"
        code(r.noSpace) == "SPACE_UNAVAILABLE"
        code(r.internalPublic) == "INTERNAL_PUBLIC_SPACE"
        code(r.otherTeam) == "TEAM_UNAVAILABLE"
        r.englishRows.length == 2
        r.englishRows.filter(row => !row.thruDate).length == 1
        r.englishRows.find(row => !row.thruDate).sequenceNum == 2
        r.englishRows.find(row => !row.thruDate).draftWikiSpaceId == "KNSDRFT"
    }
})

feature(
    "suggestions: the requester's language first; drafts and internal articles only on an agent's surface; never a restricted page",
    {
        when() {
            const ids = out => (out.articleList || []).map(row => row.wikiPageId)
            const forCase = run(state.agent, K + "find#ArticleSuggestions", {requestId: "KNS_CASE"})
            const customerSurface = run(state.agent, K + "find#ArticleSuggestions", {
                organizationPartyId: org,
                text: "Z100 thermostat pairing",
                localeLanguage: "en",
                customerVisible: true
            })
            return {
                forCase,
                caseIds: ids(forCase),
                customerSurface,
                customerIds: ids(customerSurface),
                otherCase: run(state.agent, K + "find#ArticleSuggestions", {requestId: "KNS_OTHER_CASE"}),
                otherOrganization: run(state.agent, K + "find#ArticleSuggestions", {
                    organizationPartyId: otherOrg,
                    text: "thermostat"
                })
            }
        },
        then(r) {
            r.forCase.error == ""
            r.forCase.requesterLanguage == "es"
            r.caseIds[0] == state.spanish.wikiPageId
            r.caseIds.includes(state.english.wikiPageId)
            r.caseIds.includes(state.internal.wikiPageId)
            r.caseIds.includes(state.draft.wikiPageId)
            !r.caseIds.includes(state.restricted.wikiPageId)
            !r.caseIds.includes(state.other.wikiPageId)
            r.forCase.articleList.find(row => row.wikiPageId == state.internal.wikiPageId).internal == true
            r.forCase.articleList.find(row => row.wikiPageId == state.draft.wikiPageId).published == false
            r.customerSurface.error == ""
            r.customerIds[0] == state.english.wikiPageId
            !r.customerIds.includes(state.internal.wikiPageId)
            !r.customerIds.includes(state.draft.wikiPageId)
            !r.customerIds.includes(state.restricted.wikiPageId)
            code(r.otherCase) == "RECORD_UNAVAILABLE"
            code(r.otherOrganization) == "RECORD_UNAVAILABLE"
        }
    }
)

feature("a published article is its exact published version; the public link refuses a draft and an internal article", {
    when() {
        // a newer version saved, not published: customers still read the published one
        call(W + "update#WikiPage", {
            wikiPageId: state.english.wikiPageId,
            wikiSpaceId: "KNSHELP",
            parentPath: "help",
            pageName: "Z100 thermostat pairing",
            pageText: "A newer draft text <script>x()</script>"
        })
        return {
            published: run(state.agent, K + "get#PublishedArticle", {
                wikiPageId: state.english.wikiPageId,
                organizationPartyId: org
            }),
            internal: run(state.agent, K + "get#PublishedArticle", {wikiPageId: state.internal.wikiPageId}),
            draft: run(state.agent, K + "get#PublishedArticle", {wikiPageId: state.draft.wikiPageId}),
            link: run(state.agent, K + "get#ArticlePublicLink", {wikiPageId: state.english.wikiPageId, requestId: "KNS_CASE"}),
            draftLink: run(state.agent, K + "get#ArticlePublicLink", {wikiPageId: state.draft.wikiPageId}),
            internalLink: run(state.agent, K + "get#ArticlePublicLink", {wikiPageId: state.internal.wikiPageId}),
            otherCaseLink: run(state.agent, K + "get#ArticlePublicLink", {
                wikiPageId: state.english.wikiPageId,
                requestId: "KNS_OTHER_CASE"
            })
        }
    },
    then(r) {
        r.published.error == ""
        r.published.article.versionName == state.english.versionName
        r.published.article.body.includes("five seconds")
        !r.published.article.body.includes("newer")
        code(r.internal) == "ARTICLE_UNAVAILABLE"
        code(r.draft) == "ARTICLE_UNAVAILABLE"
        r.link.error == ""
        r.link.url == "https://help.example.com/help/Z100 thermostat pairing?v=" + state.english.versionName
        code(r.draftLink) == "ARTICLE_NOT_PUBLISHED"
        code(r.internalLink) == "ARTICLE_INTERNAL"
        code(r.otherCaseLink) == "RECORD_UNAVAILABLE"
    }
})

feature("feedback reviewed in a batch: one task for the article, each failure named, the article unchanged", {
    when() {
        const record = (helpful, comment) =>
            run(state.agent, K + "record#ArticleFeedback", {
                wikiPageId: state.english.wikiPageId,
                helpful,
                comment,
                requestId: "KNS_CASE"
            })
        const first = record("N", "<b>Missing</b> the reset step")
        const second = record("N", "Pictures would help")
        const noAnswer = record("", "")
        const otherFeedback = call("create#" + FEEDBACK, {
            wikiPageId: state.other.wikiPageId,
            helpful: "N",
            organizationPartyId: otherOrg,
            statusId: "AfbSubmitted"
        }).articleFeedbackId
        const before = one(PAGE, {wikiPageId: state.english.wikiPageId})
        const ids = [first.articleFeedbackId, second.articleFeedbackId, otherFeedback, "KNS_NONE"]
        const review = run(state.author, K + "review#ArticleFeedback", {
            articleFeedbackIds: ids,
            decisionEnumId: "AfdImprove",
            reviewNote: "Add the reset step"
        })
        const again = run(state.author, K + "review#ArticleFeedback", {
            articleFeedbackIds: [first.articleFeedbackId],
            decisionEnumId: "AfdNoChange"
        })
        const byAgent = run(state.agent, K + "review#ArticleFeedback", {articleFeedbackIds: [second.articleFeedbackId]})
        const taskId = review.workEffortIds?.[0]
        return {
            first,
            noAnswer,
            review,
            again,
            byAgent,
            outcomes: Object.fromEntries((review.results || []).map(row => [row.articleFeedbackId, row.outcome])),
            stored: one(FEEDBACK, {articleFeedbackId: first.articleFeedbackId}),
            task: taskId ? one("mantle.work.effort.WorkEffort", {workEffortId: taskId}) : null,
            taskLink: taskId
                ? one("mantle.work.effort.WikiPageWorkEffort", {wikiPageId: state.english.wikiPageId, workEffortId: taskId})
                : null,
            assignee: taskId ? rows("mantle.work.effort.WorkEffortParty", {workEffortId: taskId})[0] : null,
            before,
            after: one(PAGE, {wikiPageId: state.english.wikiPageId})
        }
    },
    then(r) {
        r.first.error == ""
        code(r.noAnswer) == "HELPFUL_REQUIRED"
        r.review.doneCount == 2
        r.review.failedCount == 2
        r.review.workEffortIds.length == 1
        r.outcomes[r.first.articleFeedbackId] == "Done"
        Object.values(r.outcomes).filter(outcome => outcome == "Forbidden").length == 2
        r.stored.statusId == "AfbReviewed"
        r.stored.comment == "Missing the reset step"
        r.stored.versionName == state.english.versionName
        r.task.workEffortName == "Improve article: Z100 thermostat pairing"
        r.taskLink != null
        r.assignee.partyId == state.team
        r.again.results[0].outcome == "AlreadyReviewed"
        code(r.byAgent) == "PERMISSION_DENIED"
        r.after.publishedVersionName == r.before.publishedVersionName
    }
})

feature("Suggest edit files a task on the article for its review team", {
    when() {
        const suggested = run(state.agent, K + "suggest#ArticleEdit", {
            wikiPageId: state.english.wikiPageId,
            note: "Step 2 names the wrong button",
            requestId: "KNS_CASE"
        })
        return {
            suggested,
            noNote: run(state.agent, K + "suggest#ArticleEdit", {wikiPageId: state.english.wikiPageId}),
            outsideSources: run(state.otherAdmin, K + "suggest#ArticleEdit", {wikiPageId: state.english.wikiPageId, note: "x"}),
            task: suggested.workEffortId ? one("mantle.work.effort.WorkEffort", {workEffortId: suggested.workEffortId}) : null,
            caseLink: suggested.workEffortId
                ? one("mantle.request.RequestWorkEffort", {requestId: "KNS_CASE", workEffortId: suggested.workEffortId})
                : null
        }
    },
    then(r) {
        r.suggested.error == ""
        r.task.description == "Step 2 names the wrong button"
        r.caseLink != null
        code(r.noNote) == "NOTE_REQUIRED"
        code(r.outsideSources) == "ARTICLE_UNAVAILABLE"
    }
})

feature("an article from a case: redacted, unpublished, in the source's draft space and linked; never an internal note", {
    when() {
        const create = (username, values) =>
            run(username, K + "create#ArticleFromCase", Object.assign({requestId: "KNS_CASE"}, values))
        const preview = create(state.author, {communicationEventIds: [state.outward], preview: true})
        const made = create(state.author, {title: "Pairing a Z100 thermostat", communicationEventIds: [state.outward]})
        const madePage = made.wikiPageId ? one(PAGE, {wikiPageId: made.wikiPageId}) : null
        const text = madePage
            ? ec.service
                  .sync()
                  .name(W + "get#WikiPageReference")
                  .parameters({wikiPageId: made.wikiPageId})
                  .call()
                  .pageReference.getText()
            : ""
        return {
            preview,
            made,
            madePage,
            text,
            link: made.wikiPageId
                ? one("mantle.request.WikiPageRequest", {wikiPageId: made.wikiPageId, requestId: "KNS_CASE"})
                : null,
            again: create(state.author, {title: "Pairing a Z100 thermostat", communicationEventIds: [state.outward]}),
            internalNote: create(state.author, {title: "Notes", communicationEventIds: [state.note]}),
            byAgent: create(state.agent, {title: "By an agent", body: "text"}),
            otherOrganization: create(state.otherAdmin, {title: "Theirs", body: "text"}),
            notDraftSpace: create(state.author, {title: "Elsewhere", body: "text", wikiSpaceId: "KNSINT"})
        }
    },
    then(r) {
        r.preview.error == ""
        r.preview.text.includes("[customer]")
        !r.preview.text.includes("ana@example.com")
        !r.preview.text.includes("555-123-4567")
        !r.preview.text.includes("KNSORD77")
        r.made.error == ""
        r.made.wikiSpaceId == "KNSDRFT"
        r.made.pagePath == "drafts/Pairing a Z100 thermostat"
        r.madePage.publishedVersionName == null
        r.text.includes("five seconds")
        !r.text.includes("Ana Spec")
        !r.text.includes("rude")
        r.made.removedList.some(row => row.kind == "email")
        r.link != null
        code(r.again) == "PAGE_EXISTS"
        code(r.internalNote) == "INTERNAL_MESSAGE"
        code(r.byAgent) == "PERMISSION_DENIED"
        code(r.otherOrganization) == "RECORD_UNAVAILABLE"
        code(r.notDraftSpace) == "SPACE_UNAVAILABLE"
    }
})
