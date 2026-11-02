// Native finance controls use spec-local permissions and organizations; no application component is required.
const libLocation =
    "component://mr-mantle/service/mantle/ledger/AccountingPolicy.js"
const lib = () => ec.resource.script(libLocation)
const native = (name, p = {}) => lib().call("mantle.ledger." + name, p)
const org = "FIN_CONTROL_ORG"
let cash, expense, txId, preview, batchFixture, staleFixture, hardFixture
function rejected(name, p) {
    ec.message.pushErrors()
    let message = ""
    try {
        ec.service
            .sync()
            .name("mantle.ledger." + name)
            .parameters(p)
            .disableAuthz()
            .requireNewTransaction(true)
            .call()
        message = ec.message.getErrorsString() || ""
    } catch (error) {
        message = error.message
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
    return message
}
spec({
    stepwise: true,
    setup() {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    },
})
feature("native finance fixtures with an adopted posting guard", {
    when() {
        lib().call("create#mantle.party.Party", {
            partyId: org,
            partyTypeEnumId: "PtyOrganization",
        })
        lib().call("create#mantle.party.Organization", {
            partyId: org,
            organizationName: "Native finance control organization",
        })
        lib().call("create#mantle.party.PartyRole", {
            partyId: org,
            roleTypeId: "OrgInternal",
        })
        native("LedgerServices.init#PartyAccountingConfiguration", {
            sourcePartyId: "DefaultSettings",
            organizationPartyId: org,
            baseCurrencyUomId: "USD",
        })
        lib().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: org,
            postingGuardEnabled: "Y",
        })
        const accounts = lib()
            .rows("mantle.ledger.account.GlAccountAndOrganization", {
                organizationPartyId: org,
            })
            .filter((r) => r.disallowPosting !== "Y")
        cash = accounts[0].glAccountId
        expense = accounts[1].glAccountId
        txId = native("JournalServices.store#DraftEntry", {
            organizationPartyId: org,
            description: "Guarded manual journal",
        }).acctgTransId
        native("JournalServices.store#DraftLine", {
            acctgTransId: txId,
            glAccountId: cash,
            debitCreditFlag: "D",
            amount: "100",
        })
        native("JournalServices.store#DraftLine", {
            acctgTransId: txId,
            glAccountId: expense,
            debitCreditFlag: "C",
            amount: "100",
        })
        return { txId }
    },
    then({ txId }) {
        !!txId
    },
})
feature(
    "verification leaves journal, summaries and operation records unchanged",
    {
        when() {
            const before = JSON.stringify(
                lib().map(
                    lib().one("mantle.ledger.transaction.AcctgTrans", {
                        acctgTransId: txId,
                    }),
                ),
            )
            const operations = lib()
                .find("mantle.ledger.transaction.PostingOperation")
                .count()
            const out = native("LedgerServices.post#AcctgTrans", {
                acctgTransId: txId,
                verifyOnly: true,
            })
            const after = JSON.stringify(
                lib().map(
                    lib().one("mantle.ledger.transaction.AcctgTrans", {
                        acctgTransId: txId,
                    }),
                ),
            )
            return {
                before,
                after,
                operations,
                count: lib()
                    .find("mantle.ledger.transaction.PostingOperation")
                    .count(),
                out,
            }
        },
        then({ before, after, operations, count, out }) {
            before == after
            operations == count
            out.valid == true
        },
    },
)
feature("soft locks refuse posting and named expiring exceptions permit it", {
    when() {
        const lock = native("CloseServices.store#Lock", {
            organizationPartyId: org,
            lockScope: "all",
            lockThroughDate: ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd"),
            changeReason: "Month review",
        })
        const blocked = native("JournalServices.preview#Entry", {
            acctgTransId: txId,
        })
        native("CloseServices.grant#Exception", {
            organizationPartyId: org,
            accountingLockId: lock.accountingLockId,
            userId: ec.user.userId,
            thruDate: new Date(
                Number(ec.user.nowTimestamp) + 600000,
            ).toISOString(),
            changeReason: "Reviewed correction",
        })
        preview = native("JournalServices.preview#Entry", {
            acctgTransId: txId,
        })
        return { blocked, preview }
    },
    then({ blocked, preview }) {
        blocked.valid == false
        blocked.findings.some((f) => f.code == "SOFT_LOCK")
        preview.valid == true
    },
})
feature(
    "reviewed posting is idempotent and changed operation requests are refused",
    {
        when() {
            const params = Object.assign({}, preview, {
                acctgTransId: txId,
                operationKey: "native-control-post",
                changeReason: "Reviewed entry",
            })
            const first = native("JournalServices.post#Entry", params)
            const again = native("JournalServices.post#Entry", params)
            return { first, again, params }
        },
        then({ first, again }) {
            first.acctgTransId == txId
            again.alreadyPosted == true
        },
    },
)
feature(
    "posted lines are immutable and a dated reversal retains the original",
    {
        when() {
            const refused = rejected("JournalServices.store#DraftLine", {
                acctgTransId: txId,
                glAccountId: cash,
                debitCreditFlag: "D",
                amount: 2,
            })
            const reversal = native("JournalServices.reverse#Entry", {
                acctgTransId: txId,
                reversalDate: new Date(
                    Number(ec.user.nowTimestamp) + 86400000,
                ).toISOString(),
                operationKey: "native-control-reversal",
                changeReason: "Reverse reviewed journal",
            })
            const original = lib().one("mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: txId,
            })
            return { refused, reversal, original }
        },
        then({ refused, reversal, original }) {
            refused.length > 0
            original.isPosted == "Y"
            original.reversedByAcctgTransId == reversal.acctgTransId
        },
    },
)
feature("changed operation requests and stale previews are refused", {
    when() {
        const changed = rejected(
            "JournalServices.post#Entry",
            Object.assign({}, preview, {
                acctgTransId: txId,
                operationKey: "native-control-post",
                changeReason: "Changed request",
            }),
        )
        const draft = native("JournalServices.store#DraftEntry", {
            organizationPartyId: org,
            description: "Stale preview test",
        }).acctgTransId
        native("JournalServices.store#DraftLine", {
            acctgTransId: draft,
            glAccountId: cash,
            debitCreditFlag: "D",
            amount: 5,
        })
        native("JournalServices.store#DraftLine", {
            acctgTransId: draft,
            glAccountId: expense,
            debitCreditFlag: "C",
            amount: 5,
        })
        const before = native("JournalServices.preview#Entry", {
            acctgTransId: draft,
        })
        const header = lib().one("mantle.ledger.transaction.AcctgTrans", {
            acctgTransId: draft,
        })
        native("JournalServices.store#DraftEntry", {
            organizationPartyId: org,
            acctgTransId: draft,
            lastUpdatedStamp: header.lastUpdatedStamp,
            description: "Changed after review",
        })
        staleFixture = {
            acctgTransId: draft,
            previewId: before.previewId,
            inputFingerprint: before.inputFingerprint,
            operationKey: "native-stale-post",
            changeReason: "Stale request",
        }
        return { changed, draft, before }
    },
    then({ changed, draft, before }) {
        changed.length > 0
        lib().one("mantle.ledger.transaction.AcctgTrans", {
            acctgTransId: draft,
        }).isPosted != "Y"
    },
})
feature(
    "a mixed batch posts its balanced entry and leaves its invalid entry open",
    {
        when() {
            const journal = native("JournalServices.store#Batch", {
                organizationPartyId: org,
                glJournalName: "Mixed native batch",
            }).glJournalId
            const ids = []
            for (const credit of [10, 9]) {
                const id = native("JournalServices.store#DraftEntry", {
                    organizationPartyId: org,
                    glJournalId: journal,
                    description: "Batch item",
                }).acctgTransId
                native("JournalServices.store#DraftLine", {
                    acctgTransId: id,
                    glAccountId: cash,
                    debitCreditFlag: "D",
                    amount: 10,
                })
                native("JournalServices.store#DraftLine", {
                    acctgTransId: id,
                    glAccountId: expense,
                    debitCreditFlag: "C",
                    amount: credit,
                })
                ids.push(id)
            }
            // The soft lock applies to all entries; grant this actor a scope-wide, expiring exception.
            const lock = lib().rows("mantle.ledger.config.AccountingLock", {
                organizationPartyId: org,
            })[0]
            native("CloseServices.grant#Exception", {
                organizationPartyId: org,
                accountingLockId: lock.accountingLockId,
                userId: ec.user.userId,
                thruDate: new Date(
                    Number(ec.user.nowTimestamp) + 600000,
                ).toISOString(),
                changeReason: "Batch review",
            })
            const review = native("JournalServices.validate#Batch", {
                organizationPartyId: org,
                glJournalId: journal,
            })
            batchFixture = { journal, ids, review }
            return { journal, ids, review }
        },
        then({ review }) {
            review.results.length == 2
        },
    },
)
feature(
    "native configuration writers require explicit permissions without the app",
    {
        when() {
            for (const [suffix, permissions] of [
                ["READ", ["ACCOUNTING_VIEW"]],
                ["GL", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"]],
                ["AR_EDIT", ["RECEIVABLE_EDIT"]],
                ["AR_VIEW", ["RECEIVABLE_VIEW"]],
            ]) {
                const id = "FIN_NATIVE_" + suffix
                lib().call("create#moqui.security.UserGroup", {
                    userGroupId: id,
                    description: "Native finance test " + suffix,
                })
                for (const permission of permissions)
                    lib().call("create#moqui.security.UserGroupPermission", {
                        userGroupId: id,
                        userPermissionId: permission,
                        fromDate: 0,
                    })
                lib().call("create#mantle.party.Party", {
                    partyId: id,
                    partyTypeEnumId: "PtyPerson",
                })
                lib().call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id,
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA",
                })
                lib().call("create#moqui.security.UserGroupMember", {
                    userId: id,
                    userGroupId: id,
                    fromDate: 0,
                })
                lib().call("create#mantle.party.PartyRelationship", {
                    partyRelationshipId: id,
                    fromPartyId: id,
                    toPartyId: org,
                    relationshipTypeEnumId: "PrtAgent",
                    fromDate: 0,
                })
            }
            return { complete: true }
        },
        then({ complete }) {
            complete == true
        },
    },
)
feature("native permission checks survive disabled artifact authorization", {
    when() {
        login("FIN_NATIVE_READ")
        const a = native("AccountingServices.get#Access")
        const refused = rejected("JournalServices.store#DraftEntry", {
            organizationPartyId: org,
        })
        const settings = rejected("SetupServices.store#Preferences", {
            organizationPartyId: org,
            settings: { invoiceIdPrefix: "BAD" },
            changeReason: "Denied",
        })
        login("john.doe")
        return { a, refused, settings }
    },
    then({ a, refused, settings }) {
        a.capabilities.reportRead == true
        a.capabilities.glPost == false
        refused.length > 0
        settings.length > 0
    },
})
feature("an edit permission alone opens no finance reads; a view permission reads its kind only", {
    when() {
        const reach = (user) => {
            login(user)
            const capabilities = lib().capabilities()
            const invoices = rejected("AccountingServices.find#Records", {
                kind: "invoices",
                organizationPartyId: org,
            })
            const journals = rejected("AccountingServices.find#Records", {
                kind: "journals",
                organizationPartyId: org,
            })
            login("john.doe")
            return { read: capabilities.read, invoices, journals }
        }
        return { edit: reach("FIN_NATIVE_AR_EDIT"), view: reach("FIN_NATIVE_AR_VIEW") }
    },
    then({ edit, view }) {
        edit.read == false
        edit.invoices.includes("Accounting access is required")
        view.read == true
        view.invoices == ""
        view.journals.includes("Accounting record is not available")
    },
})
feature("a hard lock cannot be relaxed or excepted", {
    when() {
        const lock = native("CloseServices.store#Lock", {
            organizationPartyId: org,
            lockScope: "sales",
            lockThroughDate: "2000-01-01",
            isHard: "Y",
            changeReason: "Hard accounting boundary",
        })
        hardFixture = lock.accountingLockId
        return { lock }
    },
    then({ lock }) {
        lock.accountingLockId != null
    },
})
feature("settings save terms and dated rates and preserve source metadata", {
    when() {
        const term = native("SetupServices.store#SettlementTerm", {
            organizationPartyId: org,
            description: "Native net 37",
            termValue: 37,
            termValueUomId: "TF_day",
            changeReason: "Due term test",
        })
        const rate = native("CurrencyServices.store#Rate", {
            organizationPartyId: org,
            uomId: "USD",
            toUomId: "EUR",
            fromDate: "2026-01-01T00:00:00Z",
            conversionFactor: "0.91",
            rateSource: "Native test",
            changeReason: "Rate test",
        })
        const result = lib().one("moqui.basic.UomConversion", {
            uomConversionId: rate.uomConversionId,
        })
        return { term, result }
    },
    then({ term, result }) {
        term.settlementTermId != null
        result.rateSource == "Native test"
        toDecimal(result.conversionFactor).eq("0.91")
    },
})
feature("currency CSV continues after an independent invalid row", {
    when() {
        const result = native("CurrencyServices.import#Rates", {
            organizationPartyId: org,
            changeReason: "CSV rate test",
            csvText: [
                "uomId,toUomId,fromDate,conversionFactor,rateSource",
                "USD,EUR,2026-02-01T00:00:00Z,0.92,CSV",
                "USD,EUR,2026-03-01T00:00:00Z,-1,CSV",
                "USD,EUR,2026-04-01T00:00:00Z,0.93,CSV",
                "",
            ].join("\n"),
        })
        return { result }
    },
    then({ result }) {
        result.results.map((r) => r.success) == [true, false, true]
        result.complete == false
    },
})

feature(
    "a stale preview cannot post, and a mixed batch commits only independent successes",
    {
        when() {
            const stale = rejected("JournalServices.post#Entry", staleFixture)
            const currentReview = native("JournalServices.validate#Batch", {
                organizationPartyId: org,
                glJournalId: batchFixture.journal,
            })
            const result = native("JournalServices.post#Batch", {
                organizationPartyId: org,
                glJournalId: batchFixture.journal,
                previewId: currentReview.previewId,
                operationKey: "native-mixed-batch",
                changeReason: "Reviewed batch",
            })
            const states = batchFixture.ids.map(
                (id) =>
                    lib().one("mantle.ledger.transaction.AcctgTrans", {
                        acctgTransId: id,
                    }).isPosted,
            )
            return { stale, result, states }
        },
        then({ stale, result, states }) {
            stale.length > 0
            result.results.map((r) => r.success) == [true, false]
            states == ["Y", "N"]
            result.complete == false
        },
    },
)
feature("a hard lock rejects an exception and refuses backward movement", {
    when() {
        const lock = lib().one("mantle.ledger.config.AccountingLock", {
            accountingLockId: hardFixture,
        })
        const exception = rejected("CloseServices.grant#Exception", {
            organizationPartyId: org,
            accountingLockId: hardFixture,
            userId: ec.user.userId,
            thruDate: new Date(
                Number(ec.user.nowTimestamp) + 600000,
            ).toISOString(),
            changeReason: "Forbidden exception",
        })
        const backwards = rejected("CloseServices.store#Lock", {
            organizationPartyId: org,
            accountingLockId: hardFixture,
            lastUpdatedStamp: lock.lastUpdatedStamp,
            lockScope: "sales",
            lockThroughDate: "1999-01-01",
            isHard: "Y",
            changeReason: "Forbidden relaxation",
        })
        return { exception, backwards }
    },
    then({ exception, backwards }) {
        exception.length > 0
        backwards.length > 0
    },
})
feature("concurrent retries post exactly one reviewed journal", {
    when() {
        const id = native("JournalServices.store#DraftEntry", {
            organizationPartyId: org,
            description: "Concurrent reviewed posting",
        }).acctgTransId
        for (const side of ["D", "C"])
            native("JournalServices.store#DraftLine", {
                acctgTransId: id,
                glAccountId: cash,
                debitCreditFlag: side,
                amount: 3,
            })
        const view = native("JournalServices.preview#Entry", {
            acctgTransId: id,
        })
        const parameters = {
            acctgTransId: id,
            organizationPartyId: org,
            previewId: view.previewId,
            inputFingerprint: view.inputFingerprint,
            operationKey: "native-concurrent-post",
            changeReason: "Concurrent retry",
        }
        const results = parallel(
            2,
            (thread, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                return call("mantle.ledger.JournalServices.post#Entry", args)
            },
            parameters,
            { transaction: false },
        )
        return {
            results,
            count: lib()
                .find("mantle.ledger.transaction.PostingOperation", {
                    operationKey: parameters.operationKey,
                })
                .count(),
        }
    },
    then({ results, count }) {
        results.length == 2
        results.filter((r) => r.alreadyPosted).length == 1
        count == 1
    },
})
feature("configured fiscal years generate anchored months and quarters", {
    when() {
        const id = "FIN_JULY_ORG"
        lib().call("create#mantle.party.Party", {
            partyId: id,
            partyTypeEnumId: "PtyOrganization",
        })
        lib().call("create#mantle.party.Organization", {
            partyId: id,
            organizationName: "July fiscal organization",
        })
        lib().call("create#mantle.party.PartyRole", {
            partyId: id,
            roleTypeId: "OrgInternal",
        })
        lib().call("create#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: id,
            baseCurrencyUomId: "USD",
            fiscalYearStartMonth: 7,
            fiscalYearStartDay: 1,
        })
        native("LedgerServices.check#NextFiscalTimePeriods", {
            organizationPartyId: id,
            basisDate: "2026-10-29",
        })
        const year = lib().rows("mantle.party.time.TimePeriod", {
            partyId: id,
            timePeriodTypeId: "FiscalYear",
        })
        const months = lib().rows("mantle.party.time.TimePeriod", {
            partyId: id,
            timePeriodTypeId: "FiscalMonth",
        })
        return { year, months }
    },
    then({ year, months }) {
        year.length == 2
        months.length == 24
        new Date(lib().ms(year[0].fromDate)).getUTCMonth() == 6
    },
})
feature(
    "journal attachments are native scoped files and readers cannot add them",
    {
        when() {
            const file = native("JournalContentServices.create#Content", {
                acctgTransId: txId,
                contentTypeEnumId: "AtctEvidence",
                description: "Native supporting evidence",
                contentFile: uploadedFile(
                    "evidence.txt",
                    "Journal supporting evidence",
                ),
            })
            const content = lib().one(
                "mantle.ledger.transaction.AcctgTransContent",
                {
                    acctgTransContentId: file.acctgTransContentId,
                },
            )
            login("FIN_NATIVE_READ")
            const blocked = rejected("JournalContentServices.create#Content", {
                acctgTransId: txId,
                description: "Forbidden attachment",
            })
            login("john.doe")
            return { content, blocked }
        },
        then({ content, blocked }) {
            content.contentLocation.includes("/journal/")
            blocked.length > 0
        },
    },
)
feature(
    "published template versions retain the original and instantiate independent drafts",
    {
        when() {
            const first = native("JournalServices.store#Template", {
                organizationPartyId: org,
                templateName: "Native allocation",
                amountUomId: "USD",
                acctgTransTypeEnumId: "AttInternal",
            }).acctgTransTemplateId
            for (const side of ["D", "C"])
                native("JournalServices.store#TemplateLine", {
                    organizationPartyId: org,
                    acctgTransTemplateId: first,
                    glAccountId: cash,
                    debitCreditFlag: side,
                    amount: 5,
                })
            native("JournalServices.publish#Template", {
                organizationPartyId: org,
                acctgTransTemplateId: first,
                lastUpdatedStamp: lib().one(
                    "mantle.ledger.transaction.AcctgTransTemplate",
                    { acctgTransTemplateId: first },
                ).lastUpdatedStamp,
            })
            const header = lib().one(
                "mantle.ledger.transaction.AcctgTransTemplate",
                {
                    acctgTransTemplateId: first,
                },
            )
            const draft = native("JournalServices.create#FromTemplate", {
                organizationPartyId: org,
                acctgTransTemplateId: first,
            }).acctgTransId
            const second = native("JournalServices.store#Template", {
                organizationPartyId: org,
                acctgTransTemplateId: first,
                lastUpdatedStamp: header.lastUpdatedStamp,
                templateName: "Native allocation v2",
            }).acctgTransTemplateId
            const original = lib().one(
                "mantle.ledger.transaction.AcctgTransTemplate",
                { acctgTransTemplateId: first },
            )
            const copy = lib().rows(
                "mantle.ledger.transaction.AcctgTransTemplateEntry",
                { acctgTransTemplateId: second },
            )
            const entry = lib().one("mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: draft,
            })
            return { first, second, original, copy, entry }
        },
        then({ first, second, original, copy, entry }) {
            first != second
            original.isPublished == "Y"
            copy.length == 2
            entry.isPosted == "N"
            entry.acctgTransTemplateId == first
            entry.templateVersion == 1
        },
    },
)
function balanced(description, extra = {}) {
    const id = native(
        "JournalServices.store#DraftEntry",
        Object.assign({ organizationPartyId: org, description }, extra),
    ).acctgTransId
    for (const side of ["D", "C"])
        native("JournalServices.store#DraftLine", {
            acctgTransId: id,
            glAccountId: cash,
            debitCreditFlag: side,
            amount: 7,
        })
    return id
}
feature(
    "source scopes, transaction-specific exceptions and expiry cannot cross locks",
    {
        when() {
            const sales = balanced("Sales lock source"),
                purchase = balanced("Purchase lock source"),
                plain = balanced("All-only journal")
            for (const [id, fromPartyId, toPartyId] of [
                ["FIN_SALES", org, "ORG_ZIZI_CORP"],
                ["FIN_PURCHASE", "ORG_ZIZI_CORP", org],
            ])
                lib().call("create#mantle.account.invoice.Invoice", {
                    invoiceId: id,
                    invoiceTypeEnumId: "InvoiceSales",
                    statusId: "InvoiceInProcess",
                    fromPartyId,
                    toPartyId,
                    currencyUomId: "USD",
                })
            lib().call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: sales,
                invoiceId: "FIN_SALES",
            })
            lib().call("update#mantle.ledger.transaction.AcctgTrans", {
                acctgTransId: purchase,
                invoiceId: "FIN_PURCHASE",
            })
            const lock = native("CloseServices.store#Lock", {
                organizationPartyId: org,
                lockScope: "sales",
                lockThroughDate: ec.l10n.format(
                    ec.user.nowTimestamp,
                    "yyyy-MM-dd",
                ),
                changeReason: "Sales source review",
            }).accountingLockId
            const before = native("JournalServices.preview#Entry", {
                acctgTransId: sales,
            })
            const other = native("JournalServices.preview#Entry", {
                acctgTransId: purchase,
            })
            const noSource = native("JournalServices.preview#Entry", {
                acctgTransId: plain,
            })
            const exception = native("CloseServices.grant#Exception", {
                organizationPartyId: org,
                accountingLockId: lock,
                userId: ec.user.userId,
                acctgTransId: sales,
                thruDate: new Date(
                    Number(ec.user.nowTimestamp) + 600000,
                ).toISOString(),
                changeReason: "Named sales correction",
            })
            const allowed = native("JournalServices.preview#Entry", {
                acctgTransId: sales,
            })
            lib().call("update#mantle.ledger.config.AccountingLockException", {
                accountingLockExceptionId: exception.accountingLockExceptionId,
                thruDate: new Date(
                    Number(ec.user.nowTimestamp) - 1000,
                ).toISOString(),
            })
            const expired = native("JournalServices.preview#Entry", {
                acctgTransId: sales,
            })
            const purchaseLock = native("CloseServices.store#Lock", {
                organizationPartyId: org,
                lockScope: "purchases",
                lockThroughDate: ec.l10n.format(
                    ec.user.nowTimestamp,
                    "yyyy-MM-dd",
                ),
                changeReason: "Purchase review",
            })
            const purchaseBlocked = native("JournalServices.preview#Entry", {
                acctgTransId: purchase,
            })
            const taxAccount = lib()
                .rows("mantle.ledger.account.GlAccountAndOrganization", {
                    organizationPartyId: org,
                    glAccountTypeEnumId: "GatTax",
                })
                .find((r) => r.disallowPosting !== "Y")
            const tax = balanced("Tax lock source")
            if (taxAccount)
                lib().call("update#mantle.ledger.transaction.AcctgTransEntry", {
                    acctgTransId: tax,
                    acctgTransEntrySeqId: lib().rows(
                        "mantle.ledger.transaction.AcctgTransEntry",
                        { acctgTransId: tax },
                    )[0].acctgTransEntrySeqId,
                    glAccountId: taxAccount.glAccountId,
                })
            else
                lib().call("update#mantle.ledger.transaction.AcctgTrans", {
                    acctgTransId: tax,
                    acctgTransTypeEnumId: "AttTaxDue",
                })
            native("CloseServices.store#Lock", {
                organizationPartyId: org,
                lockScope: "tax",
                lockThroughDate: ec.l10n.format(
                    ec.user.nowTimestamp,
                    "yyyy-MM-dd",
                ),
                changeReason: "Tax review",
            })
            const taxBlocked = native("JournalServices.preview#Entry", {
                acctgTransId: tax,
            })
            return {
                before,
                other,
                noSource,
                allowed,
                expired,
                purchaseBlocked,
                taxBlocked,
            }
        },
        then({
            before,
            other,
            noSource,
            allowed,
            expired,
            purchaseBlocked,
            taxBlocked,
        }) {
            before.valid == false
            other.valid == true
            noSource.valid == true
            allowed.valid == true
            expired.valid == false
            purchaseBlocked.findings.some((r) => r.code == "SOFT_LOCK")
            taxBlocked.findings.some((r) => r.code == "SOFT_LOCK")
        },
    },
)
feature(
    "required dimensions and supplied cross-organization dimensions are refused",
    {
        when() {
            const id = balanced("Required dimensions")
            lib().call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: org,
                requiredLedgerDimensionsEnabled: "Y",
            })
            lib().call("update#mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: org,
                glAccountId: cash,
                facilityRequired: "Y",
                costCenterRequired: "Y",
            })
            const missing = native("JournalServices.preview#Entry", {
                acctgTransId: id,
            })
            const outside = rejected("JournalServices.store#DraftLine", {
                acctgTransId: id,
                glAccountId: cash,
                debitCreditFlag: "D",
                amount: 7,
                costCenterId: "FIN_JULY_ORG",
            })
            lib().call("update#mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: org,
                glAccountId: cash,
                facilityRequired: "N",
                costCenterRequired: "N",
            })
            return { missing, outside }
        },
        then({ missing, outside }) {
            missing.findings.filter((r) => r.code == "DIMENSION_REQUIRED")
                .length == 4
            outside.includes("DIMENSION_SCOPE")
        },
    },
)
feature(
    "clone preview detects conflicts and rejects stale source configuration",
    {
        when() {
            const p = {
                organizationPartyId: "FIN_JULY_ORG",
                sourceOrganizationPartyId: org,
                mappingKinds: ["type"],
            }
            const view = native("SetupServices.clone#Preferences", p)
            lib().call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: org,
                invoiceIdPrefix: "NATIVE-CHANGED-",
            })
            const refused = rejected(
                "SetupServices.clone#Preferences",
                Object.assign({}, p, {
                    apply: true,
                    inputFingerprint: view.inputFingerprint,
                    changeReason: "Stale clone",
                }),
            )
            const pref = lib().one(
                "mantle.ledger.config.PartyAcctgPreference",
                {
                    organizationPartyId: org,
                },
            )
            const currency = rejected("SetupServices.store#Preferences", {
                organizationPartyId: org,
                lastUpdatedStamp: pref.lastUpdatedStamp,
                settings: { baseCurrencyUomId: "EUR" },
                changeReason: "Forbidden migration",
            })
            return { view, refused, currency }
        },
        then({ view, refused, currency }) {
            view.conflicts.some((c) => c.kind == "preferences")
            refused.includes("preview again")
            currency.includes("migration")
        },
    },
)
feature(
    "mapping repair is validated and payment method responses omit secrets",
    {
        when() {
            const key = {
                organizationPartyId: org,
                glAccountTypeEnumId: "GatInventoryRevaluation",
            }
            const existing = lib().one(
                "mantle.ledger.config.GlAccountTypeDefault",
                key,
            )
            if (existing)
                lib().call(
                    "delete#mantle.ledger.config.GlAccountTypeDefault",
                    key,
                )
            native("SetupServices.store#PostingDefault", {
                organizationPartyId: org,
                mappingKind: "type",
                mapping: {
                    glAccountTypeEnumId: "GatInventoryRevaluation",
                    glAccountId: cash,
                },
                changeReason: "Repair revaluation mapping",
            })
            const found = native(
                "LedgerServices.get#DefaultGlAccountByType",
                key,
            )
            const bad = rejected("SetupServices.store#PostingDefault", {
                organizationPartyId: org,
                mappingKind: "assignment",
                mapping: { glAccountId: "NO_FIN_ACCOUNT" },
                changeReason: "Bad mapping",
            })
            const id = lib().call(
                "create#mantle.account.method.PaymentMethod",
                {
                    ownerPartyId: org,
                    paymentMethodTypeEnumId: "PmtBankAccount",
                    description: "Masked native bank",
                },
            ).paymentMethodId
            lib().call("create#mantle.account.method.BankAccount", {
                paymentMethodId: id,
                accountNumber: "123456789123",
                routingNumber: "012345678",
            })
            const response = native("SetupServices.get#PaymentMethods", {
                organizationPartyId: org,
            })
            return { found, bad, response, id }
        },
        then({ found, bad, response, id }) {
            found.glAccountId == cash
            bad.length > 0
            response.methods.find((m) => m.paymentMethodId == id)
                .maskedIdentifier == "•••• 9123"
            !JSON.stringify(response).includes("123456789123")
            !JSON.stringify(response).includes("routingNumber")
        },
    },
)
feature(
    "a closed fiscal parent refuses a reversal atomically despite a soft exception",
    {
        when() {
            const original = batchFixture.ids[0],
                before = lib()
                    .find("mantle.ledger.transaction.AcctgTrans")
                    .count()
            const periods = lib().rows("mantle.party.time.TimePeriod", {
                partyId: org,
                timePeriodTypeId: "FiscalYear",
            })
            const year = periods.find(
                (p) =>
                    lib().ms(p.fromDate) <= Number(ec.user.nowTimestamp) &&
                    lib().ms(p.thruDate) >= Number(ec.user.nowTimestamp),
            )
            lib().call("update#mantle.party.time.TimePeriod", {
                timePeriodId: year.timePeriodId,
                isClosed: "Y",
            })
            const refused = rejected("JournalServices.reverse#Entry", {
                acctgTransId: original,
                reversalDate: ec.user.nowTimestamp,
                operationKey: "native-closed-reversal",
                changeReason: "Refused closed parent",
            })
            const after = lib()
                    .find("mantle.ledger.transaction.AcctgTrans")
                    .count(),
                tx = lib().one("mantle.ledger.transaction.AcctgTrans", {
                    acctgTransId: original,
                })
            lib().call("update#mantle.party.time.TimePeriod", {
                timePeriodId: year.timePeriodId,
                isClosed: "N",
            })
            return { refused, before, after, tx }
        },
        then({ refused, before, after, tx }) {
            refused.includes("PERIOD_CLOSED")
            before == after
            !tx.reversedByAcctgTransId
        },
    },
)
feature("opt-in issuance adjustments preserve posted history and retry once", {
    when() {
        for (const type of ["GatInventory", "GatCogs"]) {
            const key = { organizationPartyId: org, glAccountTypeEnumId: type },
                old = lib().one(
                    "mantle.ledger.config.GlAccountTypeDefault",
                    key,
                )
            native("SetupServices.store#PostingDefault", {
                organizationPartyId: org,
                mappingKind: "type",
                mapping: Object.assign({}, key, {
                    glAccountId: type === "GatInventory" ? cash : expense,
                }),
                lastUpdatedStamp: old?.lastUpdatedStamp,
                changeReason: "Issuance test mapping",
            })
        }
        for (const row of lib().rows(
            "mantle.ledger.account.GlAccountOrganization",
            { organizationPartyId: org },
        ))
            lib().call("update#mantle.ledger.account.GlAccountOrganization", {
                organizationPartyId: org,
                glAccountId: row.glAccountId,
                fromDate: 0,
            })
        for (const glAccountId of ["141000000", "512000000"]) {
            const row = lib().one(
                "mantle.ledger.account.GlAccountOrganization",
                {
                    organizationPartyId: org,
                    glAccountId,
                },
            )
            native("AccountServices.store#Assignment", {
                organizationPartyId: org,
                glAccountId,
                lastUpdatedStamp: row?.lastUpdatedStamp,
                fromDate: 0,
                changeReason: "Historical issuance account fixture",
            })
        }
        const assetId = "FIN_DELTA_ASSET",
            assetIssuanceId = "FIN_DELTA_ISSUE",
            yesterday = new Date(
                Number(ec.user.nowTimestamp) - 86400000,
            ).toISOString()
        lib().call("update#mantle.ledger.config.PartyAcctgPreference", {
            organizationPartyId: org,
            forwardIssuanceRepostEnabled: "Y",
        })
        lib().call("create#mantle.product.asset.Asset", {
            assetId,
            ownerPartyId: org,
            assetTypeEnumId: "AstTpInventory",
            productId: "DEMO_1_1",
            acquireCost: 10,
            acquireCostUomId: "USD",
        })
        lib().call("create#mantle.product.issuance.AssetIssuance", {
            assetIssuanceId,
            assetId,
            quantity: 1,
            issuedDate: yesterday,
        })
        native("AssetAutoPostServices.post#AssetIssuance", { assetIssuanceId })
        const first = lib().rows("mantle.ledger.transaction.AcctgTrans", {
            assetIssuanceId,
            isPosted: "Y",
        })
        if (!first.length)
            throw new Error(
                "Issuance fixture did not post: " +
                    JSON.stringify(
                        lib()
                            .rows("mantle.ledger.transaction.AcctgTrans", {
                                assetIssuanceId,
                            })
                            .map(lib().map),
                    ) +
                    " source=" +
                    JSON.stringify(
                        lib().map(
                            lib().one("mantle.product.issuance.AssetIssuance", {
                                assetIssuanceId,
                            }),
                        ),
                    ),
            )
        native("CloseServices.store#Lock", {
            organizationPartyId: org,
            lockScope: "all",
            // the day in the user's zone; toISOString's UTC day is already today from evening on
            lockThroughDate: ec.l10n.format(new Date(Number(ec.user.nowTimestamp) - 86400000), "yyyy-MM-dd"),
            isHard: "Y",
            changeReason: "Protect issuance history",
        })
        lib().call("update#mantle.product.issuance.AssetIssuance", {
            assetIssuanceId,
            quantity: 2,
        })
        native("AssetAutoPostServices.repost#AssetIssuance", {
            assetIssuanceId,
        })
        native("AssetAutoPostServices.repost#AssetIssuance", {
            assetIssuanceId,
        })
        const all = lib().rows("mantle.ledger.transaction.AcctgTrans", {
            assetIssuanceId,
            isPosted: "Y",
        })
        return { first, all }
    },
    then({ first, all }) {
        first.length == 1
        all.length == 2
        all.some(
            (r) =>
                r.acctgTransId == first[0].acctgTransId &&
                lib().ms(r.transactionDate) ==
                    lib().ms(first[0].transactionDate),
        )
    },
})
feature(
    "an operational lock failure retains an unposted error journal and never reports success",
    {
        when() {
            const assetIssuanceId = "FIN_BLOCKED_ISSUE"
            lib().call("create#mantle.product.issuance.AssetIssuance", {
                assetIssuanceId,
                assetId: "FIN_DELTA_ASSET",
                quantity: 1,
                issuedDate: new Date(
                    Number(ec.user.nowTimestamp) - 86400000,
                ).toISOString(),
            })
            native("AssetAutoPostServices.post#AssetIssuance", {
                assetIssuanceId,
            })
            const tx = lib().rows("mantle.ledger.transaction.AcctgTrans", {
                assetIssuanceId,
            })[0]
            const source = lib().one("mantle.product.issuance.AssetIssuance", {
                assetIssuanceId,
            })
            return { tx, source }
        },
        then({ tx, source }) {
            tx.isPosted == "N"
            tx.postingFailureCode == "HARD_LOCK"
            tx.glJournalId == lib().preference(org).errorGlJournalId
            source.acctgTransResultEnumId == "AtrPostingFailed"
        },
    },
)
feature(
    "an adopted financial post with missing mappings is refused atomically",
    {
        when() {
            const invoiceId = "FIN_UNMAPPED_INVOICE",
                itemTypeEnumId = "FIN_UNMAPPED_ITEM"
            lib().call("create#moqui.basic.Enumeration", {
                enumId: itemTypeEnumId,
                enumTypeId: "ItemType",
                description: "Unmapped finance test item",
            })
            lib().call("create#mantle.account.invoice.Invoice", {
                invoiceId,
                invoiceTypeEnumId: "InvoiceSales",
                statusId: "InvoiceFinalized",
                fromPartyId: org,
                toPartyId: "ORG_ACME",
                currencyUomId: "USD",
                invoiceDate: ec.user.nowTimestamp,
            })
            lib().call("create#mantle.account.invoice.InvoiceItem", {
                invoiceId,
                invoiceItemSeqId: "01",
                itemTypeEnumId,
                amount: 7,
                quantity: 1,
            })
            const refused = rejected("InvoiceAutoPostServices.post#Invoice", {
                invoiceId,
            })
            const rows = lib().rows("mantle.ledger.transaction.AcctgTrans", {
                invoiceId,
            })
            lib().call("update#mantle.account.invoice.Invoice", {
                invoiceId,
                statusId: "InvoiceInProcess",
            })
            return { refused, rows }
        },
        then({ refused, rows }) {
            refused.includes("MAPPING_MISSING")
            rows.length == 0
        },
    },
)
feature(
    "payment methods can bind only an active organization-approved gateway",
    {
        when() {
            lib().call(
                "create#mantle.account.method.PaymentGatewayOrganization",
                {
                    organizationPartyId: org,
                    paymentGatewayConfigId: "TEST_APPROVE",
                    fromDate: 0,
                    isEnabled: "Y",
                },
            )
            const saved = native("SetupServices.store#PaymentMethod", {
                organizationPartyId: org,
                description: "Approved organization gateway",
                paymentGatewayConfigId: "TEST_APPROVE",
                changeReason: "Permitted gateway test",
            })
            const denied = rejected("SetupServices.store#PaymentMethod", {
                organizationPartyId: org,
                description: "Unapproved gateway",
                paymentGatewayConfigId: "TEST_DECLINE",
                changeReason: "Refused binding",
            })
            const response = native("SetupServices.get#PaymentMethods", {
                organizationPartyId: org,
            })
            return { saved, denied, response }
        },
        then({ saved, denied, response }) {
            saved.complete == true
            denied.includes("permitted")
            response.gateways.map((row) => row.paymentGatewayConfigId) ==
                ["TEST_APPROVE"]
            !JSON.stringify(response).includes("authorizeServiceName")
        },
    },
)
feature(
    "the missing-mapping queue identifies and clears an invoice item default",
    {
        when() {
            const itemTypeEnumId = "FIN_SETUP_ITEM"
            lib().call("create#moqui.basic.Enumeration", {
                enumId: itemTypeEnumId,
                enumTypeId: "ItemType",
                description: "Native setup repair item",
            })
            const before = native("SetupServices.get#PostingDefaults", {
                organizationPartyId: org,
            })
            native("SetupServices.store#PostingDefault", {
                organizationPartyId: org,
                mappingKind: "item",
                mapping: { itemTypeEnumId, direction: "O", glAccountId: cash },
                changeReason: "Repair missing item default",
            })
            const after = native("SetupServices.get#PostingDefaults", {
                organizationPartyId: org,
            })
            return { before, after, itemTypeEnumId }
        },
        then({ before, after, itemTypeEnumId }) {
            before.missingMappings.some(
                (row) =>
                    row.mappingKind == "item" &&
                    row.itemTypeEnumId == itemTypeEnumId &&
                    row.direction == "O",
            )
            !after.missingMappings.some(
                (row) =>
                    row.mappingKind == "item" &&
                    row.itemTypeEnumId == itemTypeEnumId &&
                    row.direction == "O",
            )
        },
    },
)

feature(
    "new journal and template writers round amounts to the selected currency",
    {
        when() {
            const amounts = []
            for (const [currency, value] of [
                ["USD", "12.346"],
                ["JPY", "12.6"],
            ]) {
                const draft = native("JournalServices.store#DraftEntry", {
                    organizationPartyId: org,
                    amountUomId: currency,
                    description: "Currency rounding",
                })
                native("JournalServices.store#DraftLine", {
                    acctgTransId: draft.acctgTransId,
                    glAccountId: cash,
                    debitCreditFlag: "D",
                    amount: value,
                })
                amounts.push(
                    String(
                        lib().rows(
                            "mantle.ledger.transaction.AcctgTransEntry",
                            {
                                acctgTransId: draft.acctgTransId,
                            },
                        )[0].amount,
                    ),
                )
            }
            const template = native("JournalServices.store#Template", {
                organizationPartyId: org,
                amountUomId: "JPY",
                templateName: "Rounded yen",
            })
            native("JournalServices.store#TemplateLines", {
                organizationPartyId: org,
                acctgTransTemplateId: template.acctgTransTemplateId,
                lastUpdatedStamp: lib().one(
                    "mantle.ledger.transaction.AcctgTransTemplate",
                    { acctgTransTemplateId: template.acctgTransTemplateId },
                ).lastUpdatedStamp,
                lines: [
                    { glAccountId: cash, debitCreditFlag: "D", amount: "12.6" },
                    {
                        glAccountId: expense,
                        debitCreditFlag: "C",
                        amount: "12.6",
                    },
                ],
            })
            const lines = lib().rows(
                "mantle.ledger.transaction.AcctgTransTemplateEntry",
                { acctgTransTemplateId: template.acctgTransTemplateId },
            )
            return { amounts, lines }
        },
        then({ amounts, lines }) {
            toDecimal(amounts[0]).eq("12.35")
            toDecimal(amounts[1]).eq("13")
            lines.every((line) => line.amount.eq("13"))
        },
    },
)
feature("record reads give screens date text and the audit of header and lines", {
    when() {
        const read = native("AccountingServices.get#Record", {
            kind: "journals",
            recordId: txId,
            organizationPartyId: org,
        })
        return { read, expected: lib().display({ day: "2026-10-29", stampDate: ec.user.nowTimestamp }) }
    },
    then({ read, expected }) {
        read.record.lastUpdatedStampText.length >= 10
        read.lines.length == 2
        read.lines.every((line) => line.lastUpdatedStampText.length >= 10)
        read.auditRows.length > 0
        read.auditRows.every((row) => row.changedByName.length > 0 && row.changedDateText.length >= 10)
        read.auditRows.every((row) => row.lineText == "Entry" || row.lineText.startsWith("Line "))
        expected.dayText == undefined
        expected.stampDateText == ec.l10n.format(ec.user.nowTimestamp, "yyyy-MM-dd HH:mm").replace(/ 00:00$/, "")
    },
})
feature("chart accounts, assignments, classifications and periods are kept through the ledger services", {
    when() {
        const like = lib().one("mantle.ledger.account.GlAccount", { glAccountId: cash })
        // as the account form does, a change sends every field: one left out is cleared
        const fields = {
            organizationPartyId: org,
            accountCode: "199901",
            glAccountClassEnumId: like.glAccountClassEnumId,
            glAccountTypeEnumId: like.glAccountTypeEnumId,
        }
        const created = native("AccountServices.store#Account", {
            ...fields,
            accountName: "Native spec account",
            changeReason: "Spec account",
        }).glAccountId
        const stamp = () => lib().one("mantle.ledger.account.GlAccount", { glAccountId: created }).lastUpdatedStamp
        const renamed = native("AccountServices.store#Account", {
            ...fields,
            glAccountId: created,
            accountName: "Native spec account renamed",
            lastUpdatedStamp: stamp(),
            changeReason: "Spec rename",
        })
        const cycle = rejected("AccountServices.store#Account", {
            ...fields,
            glAccountId: created,
            accountName: "Native spec account renamed",
            parentGlAccountId: created,
            lastUpdatedStamp: stamp(),
            changeReason: "Spec cycle",
        })
        const badCode = rejected("AccountServices.store#Account", {
            organizationPartyId: org,
            accountCode: "19A",
            accountName: "Letters in code",
            changeReason: "Spec code",
        })
        const assignmentKey = { glAccountId: created, organizationPartyId: org }
        const assigned = native("AccountServices.store#Assignment", {
            organizationPartyId: org,
            glAccountId: created,
            facilityRequired: "N",
            costCenterRequired: "Y",
            lastUpdatedStamp: lib().one("mantle.ledger.account.GlAccountOrganization", assignmentKey).lastUpdatedStamp,
            changeReason: "Spec dimensions",
        })
        const backwards = rejected("AccountServices.store#Assignment", {
            organizationPartyId: org,
            glAccountId: created,
            fromDate: ec.user.nowTimestamp,
            thruDate: new Date(Number(ec.user.nowTimestamp) - 86400000),
            lastUpdatedStamp: lib().one("mantle.ledger.account.GlAccountOrganization", assignmentKey).lastUpdatedStamp,
            changeReason: "Spec backwards",
        })
        lib().call("create#mantle.ledger.account.GlAccountCategory", {
            glAccountCategoryId: "FIN_SPEC_CATEGORY",
            description: "Native spec category",
        })
        lib().call("create#moqui.basic.EnumerationType", {
            enumTypeId: "FinSpecGroupType",
            description: "Native spec report group type",
        })
        lib().call("create#moqui.basic.Enumeration", {
            enumId: "FIN_SPEC_GROUP_TYPE",
            enumTypeId: "FinSpecGroupType",
            description: "Native spec group type",
        })
        lib().call("create#mantle.ledger.account.GlAccountGroup", {
            glAccountGroupId: "FIN_SPEC_GROUP",
            groupTypeEnumId: "FIN_SPEC_GROUP_TYPE",
            description: "Native spec group",
        })
        const categoryStart = new Date(Number(ec.user.nowTimestamp) - 86400000)
        native("AccountServices.store#Classification", {
            organizationPartyId: org,
            glAccountId: created,
            glAccountCategoryId: "FIN_SPEC_CATEGORY",
            fromDate: categoryStart,
            changeReason: "Spec category",
        })
        native("AccountServices.store#Classification", {
            organizationPartyId: org,
            glAccountId: created,
            glAccountCategoryId: "FIN_SPEC_CATEGORY",
            changeReason: "Spec category again",
        })
        native("AccountServices.store#Classification", {
            organizationPartyId: org,
            glAccountId: created,
            glAccountGroupId: "FIN_SPEC_GROUP",
            changeReason: "Spec group",
        })
        const neither = rejected("AccountServices.store#Classification", {
            organizationPartyId: org,
            glAccountId: created,
            changeReason: "Spec neither",
        })
        const classes = native("AccountServices.get#Classifications", { organizationPartyId: org, glAccountId: created })
        const periods = native("AccountServices.ensure#Periods", { organizationPartyId: org })
        const read = native("AccountingServices.get#Record", { kind: "accounts", recordId: created, organizationPartyId: org })
        return { created, renamed, cycle, badCode, assigned, backwards, neither, classes, periods, read }
    },
    then({ created, renamed, cycle, badCode, assigned, backwards, neither, classes, periods, read }) {
        renamed.glAccountId == created
        assigned.glAccountId == created
        cycle.includes("cycle")
        badCode.includes("digits-only")
        backwards.includes("end must follow start")
        neither.includes("Choose a category or group")
        classes.categoryRows.length == 2
        classes.categoryRows.filter((row) => !row.thruDate).length == 1
        classes.groupRows.map((row) => row.glAccountGroupId) == ["FIN_SPEC_GROUP"]
        periods.complete == true
        read.record.accountName == "Native spec account renamed"
        read.record.costCenterRequired == "Y"
        read.record.assignmentOrganizationPartyId == org
    },
})
feature("currencies, rate imports and finance settings are read and kept through the ledger services", {
    when() {
        const currency = native("CurrencyServices.store#Currency", {
            organizationPartyId: org,
            uomId: "XQZ",
            description: "Native spec currency",
            fractionDigits: 3,
            changeReason: "Spec currency",
        })
        const precision = native("CurrencyServices.store#Currency", {
            organizationPartyId: org,
            uomId: "XQZ",
            description: "Native spec currency",
            fractionDigits: 2,
            lastUpdatedStamp: lib().one("moqui.basic.Uom", { uomId: "XQZ" }).lastUpdatedStamp,
            changeReason: "Spec precision",
        })
        const badCode = rejected("CurrencyServices.store#Currency", {
            organizationPartyId: org,
            uomId: "xq",
            description: "Lower case",
            fractionDigits: 2,
            changeReason: "Spec code",
        })
        const imported = native("CurrencyServices.import#Rates", {
            organizationPartyId: org,
            changeReason: "Spec import",
            csvText: "uomId,toUomId,fromDate,conversionFactor,rateSource\nXQZ,USD,2026-01-01,1.5,Spec\n",
        })
        const result = native("CurrencyServices.get#ImportResult", { organizationPartyId: org, importId: imported.importId })
        const preferences = native("SetupServices.get#Preferences", { organizationPartyId: org })
        const stored = native("SetupServices.store#Preferences", {
            organizationPartyId: org,
            settings: { invoiceIdPrefix: "NFC" },
            lastUpdatedStamp: preferences.settings.lastUpdatedStamp,
            changeReason: "Spec prefix",
        })
        const badFlag = rejected("SetupServices.store#Preferences", {
            organizationPartyId: org,
            settings: { realTimeGlSummary: "X" },
            lastUpdatedStamp: stored.settings.lastUpdatedStamp,
            changeReason: "Spec flag",
        })
        const setup = native("SetupServices.get#Context", { organizationPartyId: org })
        const term = native("SetupServices.store#SettlementTerm", {
            organizationPartyId: org,
            description: "Native spec 45 days",
            termValue: 45,
            termValueUomId: "TF_day",
            changeReason: "Spec term",
        })
        return { currency, precision, badCode, imported, result, preferences, stored, badFlag, setup, term }
    },
    then({ currency, precision, badCode, imported, result, preferences, stored, badFlag, setup, term }) {
        currency.complete == true
        precision.complete == true
        lib().one("moqui.basic.Uom", { uomId: "XQZ" }).fractionDigits == 2
        badCode.includes("three-letter")
        result.importId == imported.importId
        result.complete == true
        result.results.length == 1
        preferences.organizationPartyId == org
        preferences.inherited == false
        preferences.settings.baseCurrencyUomId == "USD"
        stored.settings.invoiceIdPrefix == "NFC"
        badFlag.includes("Enabled or Disabled")
        setup.currenciesCount > 0
        setup.currencies.length == Math.min(25, setup.currenciesCount)
        setup.currenciesPageMaxIndex == Math.ceil(setup.currenciesCount / 25) - 1
        setup.rates.some((row) => row.uomId == "XQZ" && row.rateSource == "Spec")
        !!term.settlementTermId
    },
})
feature("draft documents, journal previews, corrections and deletes go through the ledger services", {
    when() {
        lib().call("create#mantle.party.Party", { partyId: "FIN_CONTROL_CUSTOMER", partyTypeEnumId: "PtyOrganization" })
        lib().call("create#mantle.party.Organization", { partyId: "FIN_CONTROL_CUSTOMER", organizationName: "Spec customer" })
        const access = native("AccountingServices.get#Access")
        const invoiceId = native("AccountingServices.create#DraftDocument", {
            kind: "invoices",
            organizationPartyId: org,
            otherPartyId: "FIN_CONTROL_CUSTOMER",
            description: "Spec draft invoice",
        }).recordId
        const paymentId = native("AccountingServices.create#DraftDocument", {
            kind: "payments",
            organizationPartyId: org,
            otherPartyId: "FIN_CONTROL_CUSTOMER",
            amount: "10.005",
            description: "Spec proposed payment",
        }).recordId
        const unknownParty = rejected("AccountingServices.create#DraftDocument", {
            kind: "invoices",
            organizationPartyId: org,
            otherPartyId: "FIN_NO_SUCH_PARTY",
        })
        const read = (kind, recordId) => native("AccountingServices.get#Record", { kind, recordId, organizationPartyId: org })
        const invoice = read("invoices", invoiceId)
        const payment = read("payments", paymentId)

        const draftId = native("JournalServices.store#DraftEntry", { organizationPartyId: org, description: "Spec deletes" })
            .acctgTransId
        for (const side of ["D", "C"])
            native("JournalServices.store#DraftLine", {
                acctgTransId: draftId,
                glAccountId: side == "D" ? cash : expense,
                debitCreditFlag: side,
                amount: "7",
            })
        const reviewed = native("JournalServices.preview#Entry", { organizationPartyId: org, acctgTransId: draftId })
        const preview = native("JournalServices.get#Preview", {
            organizationPartyId: org,
            acctgTransId: draftId,
            previewId: reviewed.previewId,
        })
        const batch = native("JournalServices.validate#Batch", { organizationPartyId: org, acctgTransIds: [draftId] })
        const batchPreview = native("JournalServices.get#BatchPreview", { organizationPartyId: org, previewId: batch.previewId })
        const line = lib().rows("mantle.ledger.transaction.AcctgTransEntry", { acctgTransId: draftId })[0]
        native("JournalServices.delete#DraftLine", {
            organizationPartyId: org,
            acctgTransId: draftId,
            acctgTransEntrySeqId: line.acctgTransEntrySeqId,
            lastUpdatedStamp: line.lastUpdatedStamp,
        })
        const linesLeft = lib().rows("mantle.ledger.transaction.AcctgTransEntry", { acctgTransId: draftId }).length
        native("JournalServices.delete#DraftEntry", {
            organizationPartyId: org,
            acctgTransId: draftId,
            lastUpdatedStamp: lib().one("mantle.ledger.transaction.AcctgTrans", { acctgTransId: draftId }).lastUpdatedStamp,
        })
        const posted = lib().one("mantle.ledger.transaction.AcctgTrans", { acctgTransId: txId })
        const corrected = native("JournalServices.update#PostedMetadata", {
            organizationPartyId: org,
            acctgTransId: txId,
            description: "Guarded manual journal, corrected",
            lastUpdatedStamp: posted.lastUpdatedStamp,
            changeReason: "Spec description",
        })

        const templateId = native("JournalServices.store#Template", { organizationPartyId: org, templateName: "Spec deletes" })
            .acctgTransTemplateId
        native("JournalServices.store#TemplateLine", {
            organizationPartyId: org,
            acctgTransTemplateId: templateId,
            glAccountId: cash,
            debitCreditFlag: "D",
            amount: 3,
        })
        const templateLine = lib().rows("mantle.ledger.transaction.AcctgTransTemplateEntry", {
            acctgTransTemplateId: templateId,
        })[0]
        native("JournalServices.delete#TemplateLine", {
            organizationPartyId: org,
            acctgTransTemplateId: templateId,
            entrySeqId: templateLine.entrySeqId,
            lastUpdatedStamp: templateLine.lastUpdatedStamp,
        })
        const templateLinesLeft = lib().rows("mantle.ledger.transaction.AcctgTransTemplateEntry", {
            acctgTransTemplateId: templateId,
        }).length
        return {
            access,
            invoice,
            payment,
            unknownParty,
            preview,
            batchPreview,
            linesLeft,
            draftId,
            corrected,
            templateLinesLeft,
        }
    },
    then({ access, invoice, payment, unknownParty, preview, batchPreview, linesLeft, draftId, corrected, templateLinesLeft }) {
        access.capabilities.read == true
        access.organizationPartyIds.includes(org)
        invoice.record.statusId == "InvoiceInProcess"
        invoice.record.toPartyId == "FIN_CONTROL_CUSTOMER"
        invoice.record.counterpartyName == "Spec customer"
        payment.record.statusId == "PmntProposed"
        payment.record.documentAmount.eq("10.01")
        unknownParty.includes("counterparty")
        preview.valid == true
        preview.debitTotal.eq("7")
        batchPreview.results.map((row) => row.acctgTransId) == [draftId]
        linesLeft == 1
        lib().one("mantle.ledger.transaction.AcctgTrans", { acctgTransId: draftId }) == null
        corrected.acctgTransId == txId
        lib().one("mantle.ledger.transaction.AcctgTrans", { acctgTransId: txId }).description ==
            "Guarded manual journal, corrected"
        templateLinesLeft == 0
    },
})
