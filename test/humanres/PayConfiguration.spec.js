// People's payroll configuration (mantle.humanres.PayrollSetupServices: components, structures and groups; PayrollLocalizationServices;
// IronStone People design §8.1, §8.4, PE-08, PE-09, PE-12; impl-people P22): a component's term checked whole (a formula of the
// framework's decimal evaluator, its currency, rounding and account mapping) and published only with examples giving their
// amounts; a cyclic or missing dependency blocks publish; overlapping published terms are refused; a statistical component enters
// no total and posts nothing; no currency or annual divisor is assumed; a structure previews gross to net with the demonstration
// localization; a group is preview only and its periods are prepared once. Configuration needs PAYROLL_EDIT and PAYROLL_CONFIGURE
// (the P22 review's call of Nov 12, 2026); publishing takes effect on a People approval of kind PakPayrollConfig, decided by a
// payroll approver who did not draft or ask for it, and a changed draft supersedes the request (the P22 review's other call).
// Standalone: spec-local organizations, accounts, groups and users, with artifact authorization disabled (the rules are the
// services' own checks).
// Run: ./moq test mr-mantle --spec PayConfiguration
const prefix = "PAY_CFG_SPEC"
const orgA = prefix + "_A",
    orgB = prefix + "_B",
    since = "2000-01-01T00:00:00Z"
const G = "mantle.humanres.PayrollSetupServices."
const day = 24 * 60 * 60 * 1000
const state = {}

// a call as a user: its result with its error text ("" when it succeeds), in its own transaction
function run(username, service, parameters = {}) {
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
// the reason code of a refusal, or "" when the call succeeds
const code = out => (out.error ? /[A-Z][A-Z0-9_]{3,}(?=:)/.exec(out.error)?.[0] || out.error : "")
const parsed = text => {
    try {
        return JSON.parse(String(text || "{}"))
    } catch (_) {
        return {}
    }
}
const dateOf = millis => ec.l10n.format(new Date(millis), "yyyy-MM-dd")
function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function account(glAccountId, glAccountClassEnumId, organizationPartyId) {
    call("create#mantle.ledger.account.GlAccount", {
        glAccountId,
        accountCode: glAccountId,
        accountName: glAccountId,
        glAccountClassEnumId
    })
    call("create#mantle.ledger.account.GlAccountOrganization", {glAccountId, organizationPartyId})
}
// a user of a spec-local group with the permissions, an agent of the organizations
function user(kind, permissions, organizationPartyIds) {
    const id = prefix + "_U_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Pay configuration " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: since})
    const partyId = prefix + "_P_" + kind
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Pay", lastName: kind})
    for (const organizationPartyId of organizationPartyIds)
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtAgent",
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            toRoleTypeId: "OrgInternal",
            fromDate: since
        })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: ec.user.userAccount?.timeZone || "America/Chicago"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: since})
    return id
}
// publishing asked by the configurer and approved by the payroll approver: the publish's refusal code, else the decision's ("" when
// both succeed)
function publishApproved(service, parameters) {
    const asked = run(state.config, G + service, Object.assign({reason: "Spec"}, parameters))
    if (asked.error) return code(asked)
    const key =
        service === "publish#Structure"
            ? {payrollStructureId: parameters.payrollStructureId}
            : {payrollComponentId: parameters.payrollComponentId}
    return code(run(state.approver, G + "decide#Publication", Object.assign({decision: "approve"}, key)))
}
// a component as the configurer: created with its draft term, its examples added, published on approval; answers its id
function component(fields, examples = [], publish = true) {
    const created = run(state.config, G + "store#Component", Object.assign({organizationPartyId: orgA}, fields))
    if (created.error) throw new Error(fields.componentCode + ": " + created.error)
    let revision = created.revision
    for (const example of examples) {
        const added = run(
            state.config,
            G + "store#ComponentExample",
            Object.assign({payrollComponentId: created.payrollComponentId, expectedRevision: revision}, example)
        )
        if (added.error) throw new Error(fields.componentCode + " example: " + added.error)
        revision = added.revision
    }
    if (publish) {
        const published = publishApproved("publish#Component", {
            payrollComponentId: created.payrollComponentId,
            expectedRevision: revision
        })
        if (published) throw new Error(fields.componentCode + " publish: " + published)
    }
    return created.payrollComponentId
}
const revisionOf = payrollComponentId => run(state.config, G + "find#Components", {payrollComponentId}).component?.revision

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        state.now = ec.user.timestampMillis(ec.user.nowTimestamp)
        organization(orgA, "Pay Config Spec A")
        organization(orgB, "Pay Config Spec B")
        account(prefix + "_WAGES", "COMPENSATION", orgA)
        account(prefix + "_WITHHELD", "ACCRUED_EXPENSES", orgA)
        account(prefix + "_WAGES_B", "COMPENSATION", orgB)
        state.config = user("CONFIG", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE"], [orgA])
        state.config2 = user("CONFIG2", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE", "PAYROLL_APPROVE"], [orgA])
        state.configB = user("CONFIGB", ["PAYROLL_VIEW", "PAYROLL_EDIT", "PAYROLL_CONFIGURE"], [orgB])
        state.operator = user("OPERATOR", ["PAYROLL_VIEW", "PAYROLL_EDIT"], [orgA])
        // the People administrator's configuration permission no longer configures pay; an HR approver who reads no payroll
        state.hr = user("HR", ["PEOPLE_HR_VIEW", "PEOPLE_HR_EDIT", "PEOPLE_CONFIGURE", "PEOPLE_REQUEST_APPROVE"], [orgA])
        state.approver = user("APPROVER", ["PAYROLL_VIEW", "PAYROLL_APPROVE"], [orgA])
        // the salary every later feature reads: a year's salary over the periods a year, both declared inputs
        state.salary = component(
            {
                componentCode: "SALARY",
                componentName: "Salary",
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbFormula",
                formula: "round(annualSalary / periodsPerYear, 2)",
                inputNames: "annualSalary, periodsPerYear",
                currencyUomId: "USD",
                expenseGlAccountId: prefix + "_WAGES"
            },
            [{exampleName: "Monthly", inputValues: "annualSalary = 60000, periodsPerYear = 12", expectedAmount: "5000.00"}]
        )
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("a component's term is checked whole and published only with examples giving their amounts and its mapping", {
    when() {
        const store = (fields, username = state.config) =>
            code(
                run(
                    username,
                    G + "store#Component",
                    Object.assign({organizationPartyId: orgA, componentKindEnumId: "PckEarning", componentName: "X"}, fields)
                )
            )
        const formula = {basisEnumId: "PcbFormula", currencyUomId: "USD"}
        state.refusals = {
            noCurrency: store({componentCode: "NOCUR", basisEnumId: "PcbAmount", amount: "10"}),
            reserved: store({componentCode: "if"}),
            taken: store({componentCode: "SALARY"}),
            script: store(Object.assign({componentCode: "SCRIPT", formula: "ec.user.userId"}, formula)),
            statement: store(Object.assign({componentCode: "STMT", formula: "a = 1; b"}, formula)),
            evalCall: store(Object.assign({componentCode: "EVAL", formula: "eval(1)"}, formula)),
            itself: store(Object.assign({componentCode: "SELF", formula: "SELF + 1"}, formula)),
            statisticalPosts: store({
                componentCode: "STATPOST",
                componentKindEnumId: "PckStatistical",
                basisEnumId: "PcbFormula",
                formula: "hours",
                inputNames: "hours",
                quantityUomId: "TF_hr",
                expenseGlAccountId: prefix + "_WAGES"
            }),
            otherEmployersAccount: store(
                Object.assign({componentCode: "ACCT", formula: "1", expenseGlAccountId: prefix + "_WAGES_B"}, formula)
            ),
            rounding: store(Object.assign({componentCode: "RND", formula: "1", roundingPlaces: "2"}, formula)),
            operator: store(
                {componentCode: "OPER", basisEnumId: "PcbAmount", amount: "10", currencyUomId: "USD"},
                state.operator
            ),
            hr: store({componentCode: "HRX", basisEnumId: "PcbAmount", amount: "10", currencyUomId: "USD"}, state.hr)
        }
        // hours at a rate, rounded to cents: no example, then a wrong one, then its mapping missing, then published
        const hourly = run(state.config, G + "store#Component", {
            organizationPartyId: orgA,
            componentCode: "HOURLY",
            componentName: "Hourly pay",
            componentKindEnumId: "PckEarning",
            basisEnumId: "PcbFormula",
            formula: "hours * hourlyRate",
            inputNames: "hours,hourlyRate",
            currencyUomId: "USD",
            roundingPlaces: "2",
            roundingEnumId: "PrdNearest"
        })
        state.hourly = hourly.payrollComponentId
        const publish = (extra = {}) =>
            code(
                run(
                    state.config,
                    G + "publish#Component",
                    Object.assign(
                        {payrollComponentId: state.hourly, expectedRevision: revisionOf(state.hourly), reason: "Spec"},
                        extra
                    )
                )
            )
        const example = fields =>
            run(
                state.config,
                G + "store#ComponentExample",
                Object.assign({payrollComponentId: state.hourly, expectedRevision: revisionOf(state.hourly)}, fields)
            )
        state.noReason = publish({reason: ""})
        state.noExample = publish()
        const wrong = example({
            exampleName: "Ten hours",
            inputValues: "hours = 10, hourlyRate = 20.555",
            expectedAmount: "205.00"
        })
        state.wrongExample = publish()
        example({payrollComponentExampleId: wrong.payrollComponentExampleId, expectedAmount: "205.55"})
        state.noMapping = publish()
        run(state.config, G + "store#Component", {
            payrollComponentId: state.hourly,
            expectedRevision: revisionOf(state.hourly),
            expenseGlAccountId: prefix + "_WAGES"
        })
        state.otherEmployer = code(
            run(state.configB, G + "publish#Component", {
                payrollComponentId: state.hourly,
                expectedRevision: revisionOf(state.hourly),
                reason: "Spec"
            })
        )
        state.operatorPublish = code(
            run(state.operator, G + "publish#Component", {
                payrollComponentId: state.hourly,
                expectedRevision: revisionOf(state.hourly),
                reason: "Spec"
            })
        )
        state.preview = run(state.operator, G + "preview#Component", {
            payrollComponentId: state.hourly,
            inputValues: "hours = 7.5"
        })
        state.published = publishApproved("publish#Component", {
            payrollComponentId: state.hourly,
            expectedRevision: revisionOf(state.hourly)
        })
        state.changePublished = code(
            run(state.config, G + "store#Component", {
                payrollComponentId: state.hourly,
                expectedRevision: revisionOf(state.hourly),
                payrollComponentTermId: state.preview.payrollComponentTermId,
                formula: "hours * hourlyRate * 2"
            })
        )
        state.stale = code(
            run(state.config, G + "store#Component", {
                payrollComponentId: state.hourly,
                expectedRevision: "1",
                componentName: "Hourly"
            })
        )
        // the salary without its divisor: nothing is assumed
        state.noDivisor = run(state.config, G + "preview#Component", {
            payrollComponentId: state.salary,
            inputValues: "annualSalary = 60000"
        }).sample
        state.found = run(state.operator, G + "find#Components", {payrollComponentId: state.hourly})
        state.hrFind = code(run(state.hr, G + "find#Components", {}))
    },
    then() {
        state.refusals.noCurrency === "CURRENCY_REQUIRED"
        state.refusals.reserved === "CODE_INVALID"
        state.refusals.taken === "CODE_TAKEN"
        state.refusals.script === "FORMULA_INVALID"
        state.refusals.statement === "FORMULA_INVALID"
        state.refusals.evalCall === "FORMULA_INVALID"
        state.refusals.itself === "CYCLIC_DEPENDENCY"
        state.refusals.statisticalPosts === "STATISTICAL_NO_POSTING"
        state.refusals.otherEmployersAccount === "ACCOUNT_INVALID"
        state.refusals.rounding === "ROUNDING_INVALID"
        state.refusals.operator === "PERMISSION_DENIED"
        state.refusals.hr === "PERMISSION_DENIED"
        state.noReason === "REASON_REQUIRED"
        state.noExample === "EXAMPLES_REQUIRED"
        state.wrongExample === "EXAMPLE_FAILED"
        state.noMapping === "MAPPING_REQUIRED"
        state.otherEmployer === "RECORD_UNAVAILABLE"
        state.operatorPublish === "PERMISSION_DENIED"
        // a payroll reader previews: the example's 10 * 20.555 = 205.550, rounded to the nearest cent
        state.preview.allPassed === true
        String(state.preview.examples[0].actualAmount) === "205.55"
        state.preview.sample.ok === false && state.preview.sample.errorCode === "MISSING_INPUT"
        state.preview.sample.missingNames.includes("hourlyRate")
        state.published === ""
        state.changePublished === "TERM_PUBLISHED"
        state.stale === "REVISION_CHANGED"
        state.noDivisor.errorCode === "MISSING_INPUT" && state.noDivisor.missingNames.join() === "periodsPerYear"
        state.found.terms[0].state === "current" && state.found.terms[0].roundingText === "Rounded nearest to 2 places"
        state.found.canEdit === false
        state.hrFind === "PERMISSION_DENIED"
    }
})

// P22 review (the user's call of Nov 12, 2026): publishing asks a People approval and takes effect when it is approved
feature(
    "publishing takes effect on approval by a payroll approver who did not draft it, and a changed draft supersedes the request",
    {
        when() {
            const created = run(state.config, G + "store#Component", {
                organizationPartyId: orgA,
                componentCode: "APPR",
                componentName: "Approved allowance",
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbAmount",
                amount: "12.34",
                currencyUomId: "USD",
                expenseGlAccountId: prefix + "_WAGES"
            })
            const id = created.payrollComponentId
            // a second configurer, who also approves pay, drafts its example: a drafter decides nothing of it
            const example = run(state.config2, G + "store#ComponentExample", {
                payrollComponentId: id,
                expectedRevision: revisionOf(id),
                exampleName: "Fixed",
                inputValues: "",
                expectedAmount: "12.34"
            })
            const ask = () =>
                run(state.config, G + "publish#Component", {
                    payrollComponentId: id,
                    expectedRevision: revisionOf(id),
                    reason: "Spec"
                })
            const decide = (username, decision = "approve", reason = null) =>
                code(run(username, G + "decide#Publication", {payrollComponentId: id, decision, reason}))
            const out = {}
            const asked = ask()
            out.asked = [code(asked), asked.published, asked.approvalStatusId].join()
            out.again = code(ask())
            const found = run(state.operator, G + "find#Components", {payrollComponentId: id})
            out.waiting = [found.component.state, found.component.waitingApproval, found.terms[0].statusId].join()
            out.route = found.component.approval?.steps?.[0]?.approverNames || ""
            const notices = username =>
                Array.from(
                    ec.entity
                        .find("moqui.security.user.NotificationMessageByUser")
                        .condition({userId: username, topic: "PeoplePayrollConfigApproval"})
                        .list()
                ).filter(row => parsed(row.messageJson).payrollComponentId === id)
            const approverNotices = notices(state.approver)
            out.noticed = [approverNotices.length, notices(state.config2).length, notices(state.hr).length].join()
            out.noticeText = approverNotices.map(row => String(row.titleText || "") + " " + String(row.messageJson || "")).join()
            out.drafter = decide(state.config2)
            out.requester = decide(state.config)
            out.hr = decide(state.hr)
            // the draft changed: the request is superseded and decides nothing
            run(state.config, G + "store#ComponentExample", {
                payrollComponentId: id,
                expectedRevision: revisionOf(id),
                payrollComponentExampleId: example.payrollComponentExampleId,
                exampleName: "Fixed amount"
            })
            out.superseded = decide(state.approver)
            out.afterChange = run(state.operator, G + "find#Components", {payrollComponentId: id}).component.state
            // asked again: a refusal needs a reason and leaves the draft
            ask()
            out.noReason = decide(state.approver, "refuse")
            out.refused = decide(state.approver, "refuse", "Not this month")
            out.afterRefusal = run(state.operator, G + "find#Components", {payrollComponentId: id}).terms[0].statusId
            // asked again and approved: published from its date, by who asked
            ask()
            out.approved = decide(state.approver)
            const term = run(state.operator, G + "find#Components", {payrollComponentId: id}).terms[0]
            out.published = [term.statusId, term.state].join()
            out.publishedBy = ec.entity
                .find("mantle.humanres.payroll.PayrollComponentTerm")
                .condition({payrollComponentTermId: term.payrollComponentTermId})
                .one().publishedByUserId
            // a structure's lines through the topic's approve service, at the notice's revision
            const structure = run(state.config, G + "store#Structure", {
                organizationPartyId: orgA,
                structureName: "Approved",
                currencyUomId: "USD",
                payBasisEnumId: "PpbSalaried"
            }).payrollStructureId
            const structureRevision = () =>
                run(state.config, G + "find#Structures", {payrollStructureId: structure}).structure.revision
            run(state.config, G + "store#StructureComponent", {
                payrollStructureId: structure,
                payrollComponentId: id,
                expectedRevision: structureRevision()
            })
            run(state.config, G + "publish#Structure", {
                payrollStructureId: structure,
                expectedRevision: structureRevision(),
                reason: "Spec"
            })
            const notice = Array.from(
                ec.entity
                    .find("moqui.security.user.NotificationMessageByUser")
                    .condition({userId: state.approver, topic: "PeoplePayrollConfigApproval"})
                    .list()
            ).find(row => parsed(row.messageJson).payrollStructureId === structure)
            out.structureNotice = !!notice
            out.structureApproved = code(
                run(state.approver, G + "approve#Publication", {
                    recordEntityName: "mantle.humanres.payroll.PayrollStructure",
                    recordId: structure,
                    message: parsed(notice?.messageJson)
                })
            )
            out.structureState = run(state.operator, G + "find#Structures", {payrollStructureId: structure}).structure.state
            return out
        },
        then(out) {
            out.asked === ",false,PapPending"
            out.again === "APPROVAL_PENDING"
            out.waiting === "waiting,true,PtsDraft"
            out.route.includes("APPROVER") && !out.route.includes("CONFIG2") && !out.route.includes("HR")
            out.noticed === "1,0,0"
            !out.noticeText.includes("12.34")
            out.drafter === "SELF_APPROVAL"
            out.requester === "PERMISSION_DENIED"
            out.hr === "PERMISSION_DENIED"
            out.superseded === "NOT_PENDING"
            out.afterChange === "draft"
            out.noReason === "REASON_REQUIRED"
            out.refused === ""
            out.afterRefusal === "PtsDraft"
            out.approved === ""
            out.published === "PtsPublished,current"
            out.publishedBy === state.config
            out.structureNotice === true
            out.structureApproved === ""
            out.structureState === "current"
        }
    }
)

feature("a cyclic or missing dependency blocks publish, of a component and of a structure", {
    when() {
        // a pension on salary and hours at the structure's rate: refused while the hourly pay it reads is unpublished
        state.lateHourly = component(
            {
                componentCode: "LATE",
                componentName: "Late",
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbAmount",
                amount: "1.00",
                currencyUomId: "USD",
                expenseGlAccountId: prefix + "_WAGES"
            },
            [{exampleName: "Fixed", inputValues: "", expectedAmount: "1.00"}],
            false
        )
        const pension = run(state.config, G + "store#Component", {
            organizationPartyId: orgA,
            componentCode: "PENSION",
            componentName: "Pension",
            componentKindEnumId: "PckDeduction",
            basisEnumId: "PcbFormula",
            formula: "round((SALARY + LATE) * pensionRate, 2)",
            inputNames: "pensionRate",
            currencyUomId: "USD",
            liabilityGlAccountId: prefix + "_WITHHELD"
        })
        state.pension = pension.payrollComponentId
        run(state.config, G + "store#ComponentExample", {
            payrollComponentId: state.pension,
            expectedRevision: revisionOf(state.pension),
            exampleName: "Five percent",
            inputValues: "SALARY = 5000, LATE = 1, pensionRate = 0.05",
            expectedAmount: "250.05"
        })
        const publishPension = () =>
            publishApproved("publish#Component", {payrollComponentId: state.pension, expectedRevision: revisionOf(state.pension)})
        state.missing = publishPension()
        publishApproved("publish#Component", {
            payrollComponentId: state.lateHourly,
            expectedRevision: revisionOf(state.lateHourly)
        })
        state.afterDependency = publishPension()
        // X reads nothing, Y reads X; X's next term reading Y is a cycle
        const x = component(
            {
                componentCode: "XC",
                componentName: "X",
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbAmount",
                amount: "2",
                currencyUomId: "USD",
                expenseGlAccountId: prefix + "_WAGES"
            },
            [{exampleName: "Two", inputValues: "", expectedAmount: "2"}]
        )
        component(
            {
                componentCode: "YC",
                componentName: "Y",
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbFormula",
                formula: "XC * 2",
                currencyUomId: "USD",
                expenseGlAccountId: prefix + "_WAGES"
            },
            [{exampleName: "Four", inputValues: "XC = 2", expectedAmount: "4"}]
        )
        const next = run(state.config, G + "store#Component", {
            payrollComponentId: x,
            expectedRevision: revisionOf(x),
            basisEnumId: "PcbFormula",
            formula: "YC + 1",
            fromDate: new Date(state.now + 2 * day)
        })
        run(state.config, G + "store#ComponentExample", {
            payrollComponentId: x,
            expectedRevision: revisionOf(x),
            exampleName: "Five",
            inputValues: "YC = 4",
            expectedAmount: "5"
        })
        state.cycle = run(state.config, G + "publish#Component", {
            payrollComponentId: x,
            expectedRevision: revisionOf(x),
            reason: "Spec"
        })
        state.nextTermId = next.payrollComponentTermId
        // P22 review: a cycle that starts later is found now. BB and AA are published; AA's term from day 5 reads BB; BB's term
        // from day 1 reading AA is no cycle on day 1, and one on day 5
        const fixed = (componentCode, amount) =>
            component(
                {
                    componentCode,
                    componentName: componentCode,
                    componentKindEnumId: "PckEarning",
                    basisEnumId: "PcbAmount",
                    amount,
                    currencyUomId: "USD",
                    expenseGlAccountId: prefix + "_WAGES"
                },
                [{exampleName: "Fixed", inputValues: "", expectedAmount: amount}]
            )
        const nextTerm = (id, formula, from, inputValues, expectedAmount) => {
            run(state.config, G + "store#Component", {
                payrollComponentId: id,
                expectedRevision: revisionOf(id),
                basisEnumId: "PcbFormula",
                formula,
                fromDate: new Date(from)
            })
            run(state.config, G + "store#ComponentExample", {
                payrollComponentId: id,
                expectedRevision: revisionOf(id),
                exampleName: "Next",
                inputValues,
                expectedAmount
            })
            return publishApproved("publish#Component", {payrollComponentId: id, expectedRevision: revisionOf(id)})
        }
        const bb = fixed("BB", "3")
        const aa = fixed("AA", "5")
        state.laterRead = nextTerm(aa, "BB + 1", state.now + 5 * day, "BB = 3", "4")
        run(state.config, G + "store#Component", {
            payrollComponentId: bb,
            expectedRevision: revisionOf(bb),
            basisEnumId: "PcbFormula",
            formula: "AA * 2",
            fromDate: new Date(state.now + day)
        })
        run(state.config, G + "store#ComponentExample", {
            payrollComponentId: bb,
            expectedRevision: revisionOf(bb),
            exampleName: "Next",
            inputValues: "AA = 5",
            expectedAmount: "10"
        })
        state.laterCycle = run(state.config, G + "publish#Component", {
            payrollComponentId: bb,
            expectedRevision: revisionOf(bb),
            reason: "Spec"
        })
        // a structure with the pension and not the earnings it reads
        const structure = run(state.config, G + "store#Structure", {
            organizationPartyId: orgA,
            structureName: "Missing",
            currencyUomId: "USD",
            payBasisEnumId: "PpbSalaried"
        })
        const line = (payrollStructureId, payrollComponentId, extra = {}) =>
            run(
                state.config,
                G + "store#StructureComponent",
                Object.assign(
                    {
                        payrollStructureId,
                        payrollComponentId,
                        expectedRevision: run(state.config, G + "find#Structures", {payrollStructureId}).structure.revision
                    },
                    extra
                )
            )
        line(structure.payrollStructureId, state.pension)
        const revision = run(state.config, G + "find#Structures", {payrollStructureId: structure.payrollStructureId}).structure
            .revision
        state.structureMissing = code(
            run(state.config, G + "publish#Structure", {
                payrollStructureId: structure.payrollStructureId,
                expectedRevision: revision,
                reason: "Spec"
            })
        )
        // two draft components reading each other: the preview names the cycle and blocks both; publishing refuses them
        const draftOnly = (componentCode, formula) =>
            run(state.config, G + "store#Component", {
                organizationPartyId: orgA,
                componentCode,
                componentName: componentCode,
                componentKindEnumId: "PckEarning",
                basisEnumId: "PcbFormula",
                formula,
                currencyUomId: "USD"
            }).payrollComponentId
        const loop = run(state.config, G + "store#Structure", {
            organizationPartyId: orgA,
            structureName: "Loop",
            currencyUomId: "USD",
            payBasisEnumId: "PpbSalaried"
        })
        line(loop.payrollStructureId, draftOnly("PC", "QC + 1"))
        line(loop.payrollStructureId, draftOnly("QC", "PC + 1"))
        state.loopPreview = run(state.operator, G + "preview#Structure", {payrollStructureId: loop.payrollStructureId})
        const loopRevision = run(state.config, G + "find#Structures", {payrollStructureId: loop.payrollStructureId}).structure
            .revision
        state.loopPublish = code(
            run(state.config, G + "publish#Structure", {
                payrollStructureId: loop.payrollStructureId,
                expectedRevision: loopRevision,
                reason: "Spec"
            })
        )
    },
    then() {
        state.missing === "MISSING_DEPENDENCY"
        state.afterDependency === ""
        code(state.cycle) === "CYCLIC_DEPENDENCY"
        state.cycle.error.includes("XC → YC → XC")
        state.laterRead === ""
        code(state.laterCycle) === "CYCLIC_DEPENDENCY"
        state.laterCycle.error.includes("BB → AA → BB")
        state.structureMissing === "MISSING_DEPENDENCY"
        state.loopPreview.complete === false
        state.loopPreview.findings.some(finding => finding.code === "CYCLIC_DEPENDENCY" && finding.blocking)
        state.loopPreview.results.every(row => row.state === "error" && row.errorCode === "CYCLIC_DEPENDENCY")
        state.loopPublish === "COMPONENT_NOT_PUBLISHED"
    }
})

feature("published terms do not overlap: a later term ends the one in effect, an earlier one is refused", {
    when() {
        const base = run(state.config, G + "store#Component", {
            organizationPartyId: orgA,
            componentCode: "BONUS",
            componentName: "Bonus",
            componentKindEnumId: "PckEarning",
            basisEnumId: "PcbAmount",
            amount: "100.00",
            currencyUomId: "USD",
            expenseGlAccountId: prefix + "_WAGES"
        })
        const id = base.payrollComponentId
        const term = (fields, expected) => {
            const stored = run(
                state.config,
                G + "store#Component",
                Object.assign({payrollComponentId: id, expectedRevision: revisionOf(id)}, fields)
            )
            run(state.config, G + "store#ComponentExample", {
                payrollComponentId: id,
                expectedRevision: revisionOf(id),
                exampleName: "Fixed",
                inputValues: "",
                expectedAmount: expected
            })
            return stored
        }
        const publish = () => publishApproved("publish#Component", {payrollComponentId: id, expectedRevision: revisionOf(id)})
        run(state.config, G + "store#ComponentExample", {
            payrollComponentId: id,
            expectedRevision: revisionOf(id),
            exampleName: "Fixed",
            inputValues: "",
            expectedAmount: "100"
        })
        state.first = publish()
        term({basisEnumId: "PcbAmount", amount: "150.00", fromDate: new Date(state.now + 31 * day)}, "150")
        state.raise = publish()
        term({basisEnumId: "PcbAmount", amount: "120.00", fromDate: new Date(state.now + 15 * day)}, "120")
        state.between = publish()
        state.terms = run(state.config, G + "find#Components", {payrollComponentId: id}).terms
        // a published line and a new draft line of the same component at once
        state.bonus = id
    },
    then() {
        state.first === ""
        state.raise === ""
        state.between === "TERMS_OVERLAP"
        const published = state.terms.filter(row => row.statusId === "PtsPublished")
        published.length === 2
        published.find(row => row.state === "current").thruDateText === published.find(row => row.state === "future").fromDateText
    }
})

feature(
    "a structure previews gross to net: a statistical value enters no total, the demonstration localization's items are synthetic",
    {
        when() {
            const hours = run(state.config, G + "store#Component", {
                organizationPartyId: orgA,
                componentCode: "HOURS",
                componentName: "Hours worked",
                componentKindEnumId: "PckStatistical",
                basisEnumId: "PcbFormula",
                formula: "hours",
                inputNames: "hours",
                quantityUomId: "TF_hr"
            })
            run(state.config, G + "store#ComponentExample", {
                payrollComponentId: hours.payrollComponentId,
                expectedRevision: revisionOf(hours.payrollComponentId),
                exampleName: "Ten",
                inputValues: "hours = 10",
                expectedAmount: "10"
            })
            state.hoursPublished = publishApproved("publish#Component", {
                payrollComponentId: hours.payrollComponentId,
                expectedRevision: revisionOf(hours.payrollComponentId)
            })
            state.statisticalPreview = run(state.config, G + "preview#Component", {payrollComponentId: hours.payrollComponentId})
            state.noCurrency = code(
                run(state.config, G + "store#Structure", {
                    organizationPartyId: orgA,
                    structureName: "No currency",
                    payBasisEnumId: "PpbMixed"
                })
            )
            const structure = run(state.config, G + "store#Structure", {
                organizationPartyId: orgA,
                structureName: "Store staff",
                currencyUomId: "USD",
                payBasisEnumId: "PpbMixed"
            })
            const id = structure.payrollStructureId
            const revision = () => run(state.config, G + "find#Structures", {payrollStructureId: id}).structure.revision
            const line = (payrollComponentId, extra = {}) =>
                run(
                    state.config,
                    G + "store#StructureComponent",
                    Object.assign({payrollStructureId: id, payrollComponentId, expectedRevision: revision()}, extra)
                )
            line(state.salary, {sequenceNum: "10"})
            line(state.hourly, {sequenceNum: "20"})
            line(state.lateHourly, {sequenceNum: "25"})
            line(state.pension, {sequenceNum: "30", parameterValues: "pensionRate = 0.05"})
            line(hours.payrollComponentId, {sequenceNum: "40"})
            const inputs = "annualSalary = 60000, periodsPerYear = 12, hours = 10, hourlyRate = 20.50"
            state.preview = run(state.operator, G + "preview#Structure", {payrollStructureId: id, inputValues: inputs})
            state.demo = run(state.operator, G + "preview#Structure", {
                payrollStructureId: id,
                inputValues: inputs,
                payrollLocalizationId: "PlzDemonstration"
            })
            state.publishedStructure = publishApproved("publish#Structure", {
                payrollStructureId: id,
                expectedRevision: revision()
            })
            state.lines = run(state.config, G + "find#Structures", {payrollStructureId: id})
            // a second line of the salary at once is refused on publish
            line(state.salary, {sequenceNum: "11"})
            state.twice = code(
                run(state.config, G + "publish#Structure", {payrollStructureId: id, expectedRevision: revision(), reason: "Spec"})
            )
            state.structureId = id
            state.list = run(state.config, G + "find#Structures", {organizationPartyId: orgA, term: "store STAFF"})
            state.otherEmployer = code(run(state.configB, G + "preview#Structure", {payrollStructureId: id}))
        },
        then() {
            state.hoursPublished === ""
            state.statisticalPreview.inTotals === false
            state.noCurrency === "CURRENCY_REQUIRED"
            const amount = (out, componentCode) => String(out.results.find(row => row.componentCode === componentCode)?.amount)
            amount(state.preview, "SALARY") === "5000.00"
            amount(state.preview, "HOURLY") === "205.00"
            amount(state.preview, "PENSION") === "250.05"
            amount(state.preview, "HOURS") === "10"
            state.preview.results.find(row => row.componentCode === "HOURS").inTotals === false
            state.preview.calculationOrder.indexOf("PENSION") > state.preview.calculationOrder.indexOf("LATE")
            state.preview.results.map(row => row.componentCode).join() === "SALARY,HOURLY,LATE,PENSION,HOURS"
            state.preview.totals.gross.compare(toDecimal("5206.00")) === 0
            state.preview.totals.deductions.compare(toDecimal("250.05")) === 0
            state.preview.totals.net.compare(toDecimal("4955.95")) === 0
            state.preview.totals.employerCost.compare(toDecimal("5206.00")) === 0
            state.preview.complete === true
            // the demonstration localization: 2% of the earnings from the employee and 1% from the employer, and its finding
            state.demo.localizationItems.map(item => item.itemCode + "=" + String(item.amount)).join() ===
                "DEMO_LEVY_EMPLOYEE=104.12,DEMO_LEVY_EMPLOYER=52.06"
            state.demo.totals.net.compare(toDecimal("4851.83")) === 0
            state.demo.totals.employerCost.compare(toDecimal("5258.06")) === 0
            state.demo.findings.some(finding => finding.code === "DEMONSTRATION_ONLY" && !finding.blocking)
            state.demo.complete === true
            state.publishedStructure === ""
            state.lines.lines.filter(line => line.state === "current").length === 5
            state.twice === "TERMS_OVERLAP"
            state.list.structures.length === 1 && state.list.structures[0].state === "current"
            state.otherEmployer === "RECORD_UNAVAILABLE"
        }
    }
)

feature("a pay group assumes no currency or divisor, is preview only, and its periods are prepared once", {
    when() {
        const fields = {
            organizationPartyId: orgA,
            groupName: "Monthly staff",
            currencyUomId: "USD",
            timePeriodTypeId: "PayrollMonth",
            firstPeriodFromDate: "2027-01-01",
            periodsPerYear: "12",
            payDateOffsetDays: "5",
            prorationEnumId: "PprCalendarDays",
            timeBasisEnumId: "PtbTimesheets",
            payrollLocalizationId: "PlzDemonstration"
        }
        const store = (changes, username = state.config) => run(username, G + "store#Group", Object.assign({}, fields, changes))
        state.groupRefusals = {
            currency: code(store({currencyUomId: ""})),
            divisor: code(store({periodsPerYear: ""})),
            payDate: code(store({payDateOffsetDays: ""})),
            frequency: code(store({timePeriodTypeId: "PayrollYear"})),
            live: code(store({liveEnabled: "Y"})),
            operator: code(store({}, state.operator)),
            otherEmployer: code(store({}, state.configB))
        }
        const group = store({})
        state.group = group.payrollGroupId
        const unbound = store({groupName: "Unbound", payrollLocalizationId: ""})
        state.groups = run(state.operator, G + "find#Groups", {organizationPartyId: orgA}).groups
        state.previewPeriods = run(state.operator, G + "prepare#Periods", {
            payrollGroupId: state.group,
            periodCount: 2,
            preview: true
        })
        state.operatorPrepare = code(run(state.operator, G + "prepare#Periods", {payrollGroupId: state.group, periodCount: 2}))
        state.prepared = run(state.config, G + "prepare#Periods", {payrollGroupId: state.group, periodCount: 3})
        state.next = run(state.config, G + "prepare#Periods", {payrollGroupId: state.group, periodCount: 1})
        // another group of the employer, frequency and start shares the periods
        state.shared = run(state.config, G + "prepare#Periods", {payrollGroupId: unbound.payrollGroupId, periodCount: 1})
        state.locked = code(
            store({
                payrollGroupId: state.group,
                expectedRevision: state.groups.find(row => row.payrollGroupId === state.group).revision,
                timePeriodTypeId: "PayrollWeek"
            })
        )
        state.periods = run(state.config, G + "find#Groups", {payrollGroupId: state.group}).periods
        // the group gives a structure's preview its periods a year
        state.withGroup = run(state.config, G + "preview#Structure", {
            payrollStructureId: state.structureId,
            payrollGroupId: state.group,
            inputValues: "annualSalary = 36000, hours = 0, hourlyRate = 0"
        })
    },
    then() {
        state.groupRefusals.currency === "CURRENCY_REQUIRED"
        state.groupRefusals.divisor === "DIVISOR_REQUIRED"
        state.groupRefusals.payDate === "PAY_DATE_REQUIRED"
        state.groupRefusals.frequency === "FREQUENCY_INVALID"
        state.groupRefusals.live === "LIVE_NOT_AVAILABLE"
        state.groupRefusals.operator === "PERMISSION_DENIED"
        state.groupRefusals.otherEmployer === "ORGANIZATION_DENIED"
        const monthly = state.groups.find(row => row.payrollGroupId === state.group)
        monthly.readiness.reasonCode === "PREVIEW_ONLY" &&
            monthly.readiness.liveAllowed === false &&
            monthly.liveEnabled === false
        state.groups.find(row => row.groupName === "Unbound").readiness.reasonCode === "NO_LOCALIZATION"
        state.previewPeriods.periods.map(row => row.fromDateText + ".." + row.thruDateText + ">" + row.payDateText).join() ===
            "2027-01-01..2027-01-31>2027-02-05,2027-02-01..2027-02-28>2027-03-05"
        state.previewPeriods.createdCount === 0
        state.operatorPrepare === "PERMISSION_DENIED"
        state.prepared.createdCount === 3
        state.next.periods[0].fromDateText === "2027-04-01" && state.next.periods[0].payDateText === "2027-05-05"
        state.shared.periods[0].timePeriodId === state.prepared.periods[0].timePeriodId
        state.locked === "POLICY_LOCKED"
        state.periods.length === 4
        String(state.withGroup.results.find(row => row.componentCode === "SALARY").amount) === "3000.00"
    }
})
