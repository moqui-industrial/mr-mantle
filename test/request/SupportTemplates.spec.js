// Case templates (impl-customer-service P7: CS-TEMPLATES, F69-F71; mantle.request.SupportCaseServices, CaseTemplates.js): a
// template's fields, options and conditions with the typed allowlist's refusals (permission, another organization's,
// a type, an expression, a reserved name, a choice with no option, a customer field on an internal one, a value its source
// does not offer, a text field compared by value, a cycle), Publish and a queue's use of it (kept by save#ServiceQueue);
// validate#TemplateValues re-evaluating hidden and required fields, a choice's options and the customer's audience; create#Case
// refusing a submit without a required value and keeping the values as a FormResponse, the customer's projection leaving out the
// internal field, and a queue with no template unchanged; a change from a date leaving an earlier case's values readable as
// submitted, with the form as it was. Standalone: spec-local organizations, customer, queue, groups and users, artifact
// authorization disabled (the rules are the services' own checks). Run: ./moq test mr-mantle --spec SupportTemplates
const prefix = "SCT"
const org = prefix + "_ORG",
    otherOrg = prefix + "_OTHER_ORG",
    customer = prefix + "_CUST",
    since = "2000-01-01T00:00:00Z"
const S = "mantle.request.SupportCaseServices."
const FIELD = "moqui.screen.form.DbFormField",
    OPTION = "moqui.screen.form.DbFormFieldOption",
    DEPENDENCY = "moqui.screen.form.DbFormFieldDependency",
    PROFILE = "mantle.request.support.CaseProfile"
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
function user(kind, permissions, organizationPartyId = org) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Case template " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    party(id, "Template " + kind, null, organizationPartyId, "PtyPerson")
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// the template's rows started a day ago, as if published yesterday (a response reads the form as of its date)
function startedYesterday(formId) {
    const day = new Date(Number(ec.user.nowTimestamp.getTime ? ec.user.nowTimestamp.getTime() : Date.now()) - 86400000)
    for (const entity of [FIELD, OPTION, DEPENDENCY])
        for (const row of rows(entity, {formId}))
            if (row.fromDate != null && !row.thruDate) {
                row.set("fromDate", day)
                row.update()
            }
}
const field = (formId, fields) => run(state.admin, S + "save#CaseTemplateField", Object.assign({formId}, fields))
const condition = (formId, fields) => run(state.admin, S + "save#CaseTemplateCondition", Object.assign({formId}, fields))
const values = (formId, given, audience) =>
    run(state.agent, S + "validate#TemplateValues", {formId, values: given, audience: audience || "internal"})
const newCase = (requestName, fields) =>
    run(
        state.agent,
        S + "create#Case",
        Object.assign({organizationPartyId: org, customerPartyId: customer, requestCategoryId: state.queue, requestName}, fields)
    )

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        party(org, "Template Spec Org", "OrgInternal")
        party(otherOrg, "Template Spec Other Org", "OrgInternal")
        party(customer, "Template Spec Customer", "Customer", org)
        state.admin = user("ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"])
        state.agent = user("AGENT", ["SUPPORT_CASE_EDIT"])
        state.otherAdmin = user("OTHER_ADMIN", ["SUPPORT_POLICY_EDIT", "SUPPORT_CASE_EDIT"], otherOrg)
        state.queue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Template spec queue"
        }).requestCategoryId
        state.plainQueue = run(state.admin, S + "save#ServiceQueue", {
            organizationPartyId: org,
            description: "Template spec plain queue"
        }).requestCategoryId
        run(state.admin, S + "save#ServiceDefaults", {organizationPartyId: org, defaultCategoryId: state.queue})
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature("a template's fields, options and conditions, the allowlist's refusals, Publish and a queue's use of it", {
    when() {
        const created = run(state.admin, S + "save#CaseTemplate", {organizationPartyId: org, description: "Defective product"})
        const formId = (state.formId = created.formId)
        const refused = {
            agent: code(run(state.agent, S + "save#CaseTemplate", {organizationPartyId: org, description: "Not mine"})),
            otherOrganization: code(run(state.otherAdmin, S + "save#CaseTemplateField", {formId, title: "Theirs"})),
            type: code(field(formId, {title: "Secret", fieldTypeEnumId: "DBFFT_password"})),
            expression: code(field(formId, {title: "${ec.user.userId}"})),
            reserved: code(field(formId, {title: "Priority", newFieldName: "priority"})),
            noOptions: code(field(formId, {title: "Kind", fieldTypeEnumId: "DBFFT_radio", optionText: ""}))
        }
        const kind = field(formId, {
            title: "Product kind",
            fieldTypeEnumId: "DBFFT_radio",
            audienceEnumId: "CfaCustomer",
            optionText: "equipment | Equipment (a thermostat)\nsupply | Filter or supply\nother | Something else"
        })
        const serial = field(formId, {title: "Serial number", audienceEnumId: "CfaCustomer"})
        const assessment = field(formId, {
            title: "Agent assessment",
            fieldTypeEnumId: "DBFFT_text-area",
            audienceEnumId: "CfaInternal"
        })
        const show = condition(formId, {
            sourceFieldName: kind.fieldName,
            operator: "equals",
            value: "equipment",
            targetFieldName: serial.fieldName,
            effect: "show"
        })
        const require = condition(formId, {
            sourceFieldName: kind.fieldName,
            operator: "equals",
            value: "equipment",
            targetFieldName: serial.fieldName,
            effect: "require"
        })
        const conditionRefused = {
            audience: code(
                condition(formId, {
                    sourceFieldName: assessment.fieldName,
                    operator: "not-empty",
                    targetFieldName: kind.fieldName,
                    effect: "show"
                })
            ),
            value: code(
                condition(formId, {
                    sourceFieldName: kind.fieldName,
                    operator: "equals",
                    value: "laptop",
                    targetFieldName: assessment.fieldName,
                    effect: "show"
                })
            ),
            textByValue: code(
                condition(formId, {
                    sourceFieldName: serial.fieldName,
                    operator: "equals",
                    value: "X",
                    targetFieldName: assessment.fieldName,
                    effect: "show"
                })
            ),
            cycle: code(
                condition(formId, {
                    sourceFieldName: serial.fieldName,
                    operator: "not-empty",
                    targetFieldName: kind.fieldName,
                    effect: "show"
                })
            )
        }
        const draftCustomer = run(state.agent, S + "get#CaseTemplate", {formId, audience: "customer"}).template
        const beforePublish = code(run(state.admin, S + "save#CaseTemplate", {formId, requestCategoryId: state.queue}))
        const published = run(state.admin, S + "save#CaseTemplate", {formId, publish: true})
        startedYesterday(formId)
        const used = run(state.admin, S + "save#CaseTemplate", {formId, requestCategoryId: state.queue})
        // a later queue save keeps the template
        run(state.admin, S + "save#ServiceQueue", {requestCategoryId: state.queue, description: "Template spec queue"})
        const queueRow = rows("mantle.request.support.ServiceQueue", {requestCategoryId: state.queue}).find(row => !row.thruDate)
        const agentView = run(state.agent, S + "get#CaseTemplate", {formId}).template
        const customerView = run(state.agent, S + "get#CaseTemplate", {formId, audience: "customer"}).template
        const otherView = code(run(state.otherAdmin, S + "get#CaseTemplate", {formId}))
        Object.assign(state, {kind: kind.fieldName, serial: serial.fieldName, assessment: assessment.fieldName})
        return {
            created,
            refused,
            kind,
            serial,
            assessment,
            show,
            require,
            conditionRefused,
            draftCustomer,
            beforePublish,
            published,
            used,
            queueRow,
            agentView,
            customerView,
            otherView
        }
    },
    then(r) {
        r.created.error == ""
        r.refused ==
            {
                agent: "PERMISSION_DENIED",
                otherOrganization: "RECORD_UNAVAILABLE",
                type: "FIELD_TYPE",
                expression: "NO_EXPRESSIONS",
                reserved: "FIELD_NAME_INVALID",
                noOptions: "OPTIONS_REQUIRED"
            }
        r.kind.fieldName == "productKind"
        r.serial.fieldName == "serialNumber"
        r.show.error == ""
        r.require.error == ""
        r.conditionRefused ==
            {audience: "CONDITION_AUDIENCE", value: "CONDITION_VALUE", textByValue: "OPERATOR_INVALID", cycle: "CONDITION_CYCLE"}
        // drafts are no one's form yet
        r.draftCustomer.fields == []
        r.beforePublish == "TEMPLATE_NOT_PUBLISHED"
        r.published.publishedFieldNames.length == 3
        r.used.error == ""
        r.queueRow.templateFormId == state.formId
        r.agentView.fields.map(field => field.fieldName) == ["productKind", "serialNumber", "agentAssessment"]
        r.agentView.stateText == "Published"
        r.customerView.fields.map(field => field.fieldName) == ["productKind", "serialNumber"]
        r.customerView.fields[1].require.value == "equipment"
        r.otherView == "RECORD_UNAVAILABLE"
    }
})

feature("validate#TemplateValues re-evaluates hidden and required fields, a choice's options and the customer's audience", {
    when() {
        const formId = state.formId
        return {
            missing: values(formId, {productKind: "equipment"}),
            complete: values(formId, {productKind: "equipment", serialNumber: " CS-1001 ", agentAssessment: "Bad sensor"}),
            hidden: values(formId, {productKind: "other", serialNumber: "CS-1001"}),
            unknown: values(formId, {productKind: "laptop"}),
            internalFromCustomer: values(formId, {productKind: "supply", agentAssessment: "x"}, "customer"),
            customer: values(formId, {productKind: "supply", extra: "ignored"}, "customer"),
            refused: code(
                run(state.agent, S + "validate#TemplateValues", {formId, values: {productKind: "equipment"}, refuse: true})
            )
        }
    },
    then(r) {
        r.missing.valid == false
        r.missing.missingFieldNames == ["serialNumber"]
        r.missing.errors[0].code == "REQUIRED"
        r.complete.valid == true
        r.complete.values == {productKind: "equipment", serialNumber: "CS-1001", agentAssessment: "Bad sensor"}
        r.hidden.valid == true
        r.hidden.hiddenFieldNames == ["serialNumber"]
        r.hidden.values == {productKind: "other"}
        r.unknown.errors[0].code == "CHOICE_UNKNOWN"
        r.internalFromCustomer.errors[0].code == "FIELD_NOT_OFFERED"
        r.customer.valid == true
        r.customer.visibleFieldNames == ["productKind"]
        r.customer.values == {productKind: "supply"}
        r.refused == "TEMPLATE_VALUES_INVALID"
    }
})

feature(
    "create#Case refuses a submit without the serial, keeps the values, and the customer's projection has no internal field",
    {
        when() {
            const name = "Template spec thermostat"
            const refused = newCase(name, {templateValues: {productKind: "equipment"}})
            const madeAfterRefusal = rows("mantle.request.Request", {requestName: name}).length
            const made = newCase(name, {
                templateValues: {
                    productKind: "equipment",
                    serialNumber: "CS-1001",
                    agentAssessment: "Sensor drift",
                    requestName: "not a value"
                }
            })
            state.caseId = made.requestId
            const profile = one(PROFILE, {requestId: made.requestId})
            const agentValues = run(state.agent, S + "get#CaseTemplateValues", {requestId: made.requestId})
            const customerValues = run(state.agent, S + "get#CaseTemplateValues", {
                requestId: made.requestId,
                audience: "customer"
            })
            const otherValues = code(run(state.otherAdmin, S + "get#CaseTemplateValues", {requestId: made.requestId}))
            // a queue with no template: no values, as before
            const plain = newCase("Template spec plain", {
                requestCategoryId: state.plainQueue,
                templateValues: {productKind: "equipment"}
            })
            const plainProfile = one(PROFILE, {requestId: plain.requestId})
            return {refused, madeAfterRefusal, made, profile, agentValues, customerValues, otherValues, plain, plainProfile}
        },
        then(r) {
            code(r.refused) == "TEMPLATE_VALUES_INVALID"
            r.refused.error.includes("Serial number is required")
            r.madeAfterRefusal == 0
            r.made.error == ""
            r.profile.templateFormId == state.formId
            r.profile.formResponseId != null
            r.agentValues.values.map(value => value.fieldName) == ["productKind", "serialNumber", "agentAssessment"]
            r.agentValues.values[0].displayText == "Equipment (a thermostat)"
            r.customerValues.values.map(value => value.fieldName) == ["productKind", "serialNumber"]
            !JSON.stringify(r.customerValues).includes("Sensor drift")
            r.otherValues == "RECORD_UNAVAILABLE"
            r.plain.error == ""
            r.plainProfile.formResponseId == null
        }
    }
)

feature("a change from a date leaves an earlier case's values readable as submitted, with the form as it was", {
    when() {
        const formId = state.formId
        // the case was made a minute before the change
        const profile = one(PROFILE, {requestId: state.caseId})
        const response = one("moqui.screen.form.FormResponse", {formResponseId: profile.formResponseId})
        response.set("responseDate", new Date(Date.now() - 60000))
        response.update()
        const relabelled = field(formId, {
            fieldName: state.kind,
            title: "What kind of product",
            fieldTypeEnumId: "DBFFT_radio",
            audienceEnumId: "CfaCustomer",
            optionText: "equipment | A device\nsupply | A filter or supply",
            fromDate: ec.user.nowTimestamp
        })
        // an internal field ended now is left out from now
        const ended = run(state.admin, S + "end#CaseTemplatePart", {formId, part: "field", fieldName: state.assessment})
        const earlier = run(state.agent, S + "get#CaseTemplateValues", {requestId: state.caseId})
        const nowForm = run(state.agent, S + "get#CaseTemplate", {formId}).template
        const later = values(formId, {[relabelled.fieldName]: "equipment"})
        return {relabelled, ended, earlier, nowForm, later}
    },
    then(r) {
        r.relabelled.successor == true
        r.relabelled.fieldName == "productKind_2"
        r.ended.error == ""
        r.earlier.values.map(value => value.title) == ["Product kind", "Serial number", "Agent assessment"]
        r.earlier.values[0].displayText == "Equipment (a thermostat)"
        r.nowForm.fields.map(field => field.title) == ["What kind of product", "Serial number"]
        // the conditions moved to the successor
        r.later.missingFieldNames == ["serialNumber"]
    }
})
