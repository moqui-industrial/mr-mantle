// Fixed asset books (AssetBookServices, impl-accounting P12): a finance administrator's class versions; an asset
// capitalized from its class; a month's depreciation run with one asset failing to calculate and one to post and the rest
// posted, each asset-month once and no depreciation row for a posting that failed (F38); a book adjustment; a sale at a
// gain and a scrap at a loss; a disposal reversed in an open period; a closed month refusing depreciation, capitalization
// and an acquire cost repair (F39). Spec-local organization, assets and users.
const fixtures = () => ec.resource.script("component://mr-mantle/test/account/AccountingSettlementFixtures.js")
const books = "mantle.ledger.AssetBookServices."
let f
function asUser(userId, run) {
    login(userId)
    try {
        return run()
    } finally {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
}
const rejected = (name, p) => fixtures().rejected(books + name, p)
const one = (entity, conditions) => ec.entity.find(entity).condition(conditions).disableAuthz().one()
const asset = assetId => one("mantle.product.asset.Asset", {assetId})
// A transaction's lines as "D account amount", sorted.
function lines(acctgTransId) {
    return Array.from(
        ec.entity.find("mantle.ledger.transaction.AcctgTransEntry").condition({acctgTransId}).disableAuthz().list()
    )
        .map(r => r.debitCreditFlag + " " + r.glAccountId + " " + toDecimal(r.amount).toNumber())
        .sort()
        .join(", ")
}
function monthOf(day) {
    return ec.entity
        .find("mantle.party.time.TimePeriod")
        .condition({partyId: f.org, timePeriodTypeId: "FiscalMonth"})
        .condition("fromDate", "less-equals", day)
        .condition("thruDate", "greater-equals", day)
        .disableAuthz()
        .one().timePeriodId
}
function newAsset(assetId, values = {}) {
    call(
        "create#mantle.product.asset.Asset",
        Object.assign(
            {assetId, assetTypeEnumId: "AstTpEquipment", ownerPartyId: f.org, statusId: "AstAvailable", assetName: assetId},
            values
        )
    )
}
const yearsLater = (day, years) => String(Number(day.slice(0, 4)) + years) + day.slice(4)
// A date field's calendar day.
const calendar = value => {
    if (/^\d{4}-\d{2}-\d{2}/.test(String(value))) return String(value).slice(0, 10)
    const date = new Date(Number(value))
    const pad = n => String(n).padStart(2, "0")
    return date.getUTCFullYear() + "-" + pad(date.getUTCMonth() + 1) + "-" + pad(date.getUTCDate())
}

spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        const h = fixtures()
        f = h.fixtures("ACCT_P12_FA")
        f.users.gl = h.user(f, "GLPOST", ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST"])
        f.monthId = monthOf(f.day)
        // the last day of last month, in a fiscal month closed after an asset was capitalized in it
        const [year, month] = f.day.split("-").map(Number)
        const lastYear = month === 1 ? year - 1 : year,
            lastMonth = String(month === 1 ? 12 : month - 1).padStart(2, "0")
        f.lastMonthDay = [lastYear, lastMonth, new Date(Date.UTC(year, month - 1, 0)).getUTCDate()].join("-")
        f.lastMonthId = "P12_LAST_MONTH"
        call("create#mantle.party.time.TimePeriod", {
            timePeriodId: f.lastMonthId,
            partyId: f.org,
            timePeriodTypeId: "FiscalMonth",
            periodName: "Last month",
            fromDate: [lastYear, lastMonth, "01"].join("-"),
            thruDate: f.lastMonthDay,
            isClosed: "N"
        })
        for (const id of ["TRUCK", "VAN", "PRESS", "OLD", "RCV", "LAPTOP", "SOLD", "UNPOSTED"]) newAsset("P12_" + id)
        // a receipt of the unposted asset whose transaction has not posted
        call("create#mantle.product.receipt.AssetReceipt", {
            assetReceiptId: "P12_RCPT",
            assetId: "P12_UNPOSTED",
            quantityAccepted: 1,
            receivedDate: f.timestamp
        })
        newAsset("P12_PRINTER", {depreciationTypeEnumId: "DtpStraightLine", assetName: "Printer without a cost"})
        call(books + "capitalize#Asset", {
            assetId: "P12_OLD",
            inServiceDate: f.lastMonthDay,
            acquireCost: "2000",
            usefulLifeYears: 4,
            depreciationTypeEnumId: "DtpStraightLine",
            operationKey: "p12-cap-old"
        })
        // a posting of the not capitalized asset in last month (as its receipt's would be)
        call("create#mantle.ledger.transaction.AcctgTrans", {
            acctgTransId: "P12_RCV_TX",
            organizationPartyId: f.org,
            acctgTransTypeEnumId: "AttAssetReceipt",
            transactionDate: ec.l10n.parseTimestamp(f.lastMonthDay + " 12:00:00", "yyyy-MM-dd HH:mm:ss"),
            accountingDate: f.lastMonthDay,
            assetId: "P12_RCV",
            isPosted: "Y"
        })
        call("update#mantle.party.time.TimePeriod", {timePeriodId: f.lastMonthId, isClosed: "Y"})
        f.twoYearsAgo = ec.l10n.parseTimestamp(yearsLater(f.day, -2) + " 00:00:00", "yyyy-MM-dd HH:mm:ss")
        f.classId = asUser(f.users.financeadmin, () =>
            call(books + "store#Class", {
                organizationPartyId: f.org,
                classEnumId: "AsClsTruck",
                assetTypeEnumId: "AstTpEquipment",
                usefulLifeYears: 5,
                salvagePercent: "10",
                depreciationTypeEnumId: "DtpStraightLine",
                fromDate: f.twoYearsAgo,
                changeReason: "Trucks over five years"
            })
        ).fixedAssetClassId
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    }
})

feature("a finance administrator starts a class version that ends the one before; GL posting cannot", {
    when() {
        const version = {
            organizationPartyId: f.org,
            fixedAssetClassId: f.classId,
            usefulLifeYears: 6,
            fromDate: ec.l10n.parseTimestamp(yearsLater(f.day, -1) + " 00:00:00", "yyyy-MM-dd HH:mm:ss"),
            changeReason: "Trucks last six years"
        }
        const glRefusal = asUser(f.users.gl, () => rejected("store#Class", version))
        const stored = asUser(f.users.financeadmin, () => call(books + "store#Class", version))
        const overlap = asUser(f.users.financeadmin, () =>
            rejected("store#Class", {
                organizationPartyId: f.org,
                classEnumId: "AsClsTruck",
                usefulLifeYears: 4,
                depreciationTypeEnumId: "DtpStraightLine",
                changeReason: "A second current version"
            })
        )
        const old = one("mantle.product.asset.FixedAssetClass", {fixedAssetClassId: f.classId})
        const audit = Array.from(
            ec.entity
                .find("moqui.entity.EntityAuditLog")
                .condition({changedEntityName: "mantle.product.asset.FixedAssetClass", changedFieldName: "thruDate"})
                .disableAuthz()
                .list()
        ).map(row => row.pkPrimaryValue + " " + row.changeReason)
        f.classId = stored.fixedAssetClassId
        return {glRefusal, old, version, overlap, audit, current: one("mantle.product.asset.FixedAssetClass", stored)}
    },
    then({glRefusal, old, version, overlap, audit, current}) {
        glRefusal.includes("PERMISSION_DENIED")
        Number(old.thruDate) == Number(version.fromDate)
        current.usefulLifeYears == 6 && toDecimal(current.salvagePercent).toNumber() == 10
        overlap.includes("CLASS_OVERLAP")
        audit.includes(old.fixedAssetClassId + " Trucks last six years")
    }
})

feature("an asset is capitalized from its class's version on its in-service day, once per asset", {
    when() {
        const capitalize = {assetId: "P12_TRUCK", classEnumId: "AsClsTruck", acquireCost: "12000", operationKey: "p12-cap-truck"}
        const readRefusal = asUser(f.users.read, () => rejected("capitalize#Asset", capitalize))
        const first = asUser(f.users.gl, () => call(books + "capitalize#Asset", capitalize))
        const retry = asUser(f.users.gl, () => call(books + "capitalize#Asset", capitalize))
        const again = asUser(f.users.gl, () =>
            rejected("capitalize#Asset", Object.assign({}, capitalize, {operationKey: "p12-cap-truck-2"}))
        )
        asUser(f.users.gl, () => {
            for (const [id, cost, life] of [
                ["VAN", "3600", 3],
                ["PRESS", "5000", 5]
            ])
                call(books + "capitalize#Asset", {
                    assetId: "P12_" + id,
                    acquireCost: cost,
                    usefulLifeYears: life,
                    depreciationTypeEnumId: "DtpStraightLine",
                    operationKey: "p12-cap-" + id
                })
        })
        const event = one("mantle.product.asset.AssetBookEvent", {assetBookEventId: first.assetBookEventId})
        return {readRefusal, first, retry, again, truck: asset("P12_TRUCK"), event}
    },
    then({readRefusal, first, retry, again, truck, event}) {
        readRefusal.includes("PERMISSION_DENIED")
        lines(first.acctgTransId) == "C 139100000 12000, D 131100000 12000"
        retry.alreadyApplied == true && retry.assetBookEventId == first.assetBookEventId
        again.includes("ALREADY_CAPITALIZED")
        truck.classEnumId == "AsClsTruck" && toDecimal(truck.salvageValue).toNumber() == 1200
        truck.depreciationTypeEnumId == "DtpStraightLine"
        calendar(truck.expectedEndOfLife) == yearsLater(f.day, 6)
        event.eventTypeEnumId == "AbeCapitalize" && event.fixedAssetClassId == f.classId
    }
})

feature("a month's depreciation posts each asset once; one fails to calculate, one to post, and the rest post", {
    when() {
        // the press's expense account takes no postings: its depreciation is refused by the posting guard
        const own = one("mantle.ledger.config.AssetTypeGlAccount", {assetId: "P12_PRESS"})
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: own.assetTypeGlAccountId,
            depreciationGlAccountId: "131000000"
        })
        return asUser(f.users.gl, () => {
            const preview = call(books + "preview#Depreciation", {organizationPartyId: f.org, timePeriodId: f.monthId})
            const shown = call(books + "get#DepreciationPreview", {periodRunId: preview.periodRunId})
            const posted = call(books + "post#Depreciation", {
                periodRunId: preview.periodRunId,
                calculationVersion: preview.calculationVersion,
                operationKey: "p12-dep-" + preview.periodRunId
            })
            const again = call(books + "preview#Depreciation", {organizationPartyId: f.org, timePeriodId: f.monthId})
            const results = Array.from(
                ec.entity
                    .find("mantle.ledger.transaction.AccountingPeriodRunResult")
                    .condition({periodRunId: preview.periodRunId})
                    .disableAuthz()
                    .list()
            )
            const status = Object.fromEntries(results.map(r => [r.sourceId, r.statusId]))
            const truckRow = one("mantle.product.asset.AssetDepreciation", {assetId: "P12_TRUCK", timePeriodId: f.monthId})
            return {preview, shown, posted, again, status, results, truckRow}
        })
    },
    then({preview, shown, posted, again, status, results, truckRow}) {
        preview.resultCount == 5 && preview.failedCount == 1
        shown.results.find(r => r.sourceId == "P12_TRUCK").endingNetBook.toNumber() == 11850
        posted.statusId == "PrnPartial" && posted.postedCount == 3 && posted.failedCount == 1
        status["P12_TRUCK"] == "PrrPosted" && status["P12_VAN"] == "PrrPosted" && status["P12_OLD"] == "PrrPosted"
        status["P12_PRESS"] == "PrrFailed" && status["P12_PRINTER"] == "PrrFailed"
        results.find(r => r.sourceId == "P12_PRESS").failureCode == "ENTRY_INVALID"
        toDecimal(truckRow.monthlyDepreciation).toNumber() == 150 && lines(truckRow.acctgTransId) == "C 182000000 150, D 672000000 150"
        toDecimal(asset("P12_VAN").depreciation).toNumber() == 100
        one("mantle.product.asset.AssetDepreciation", {assetId: "P12_PRESS", timePeriodId: f.monthId}) == null
        asset("P12_PRESS").depreciation == null
        // each asset-month once: only the two that did not post are left
        again.resultCount == 2
    }
})

feature("a depreciation that goes to the error journal leaves no depreciation row or amount (F38)", {
    when() {
        call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "N"})
        try {
            const out = call("mantle.ledger.AssetAutoPostServices.calculateAndPost#FixedAssetDepreciation", {
                assetId: "P12_PRESS",
                timePeriodId: f.monthId
            })
            return {
                out,
                unposted: ec.entity
                    .find("mantle.ledger.transaction.AcctgTrans")
                    .condition({assetId: "P12_PRESS", acctgTransTypeEnumId: "AttDepreciation", isPosted: "N"})
                    .disableAuthz()
                    .count(),
                row: one("mantle.product.asset.AssetDepreciation", {assetId: "P12_PRESS", timePeriodId: f.monthId}),
                press: asset("P12_PRESS")
            }
        } finally {
            call("update#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: f.org, postingGuardEnabled: "Y"})
        }
    },
    then({out, unposted, row, press}) {
        // its unposted transaction is removed too (F260)
        out.acctgTransId == null && unposted == 0
        row == null && press.depreciation == null
    }
})

feature("a run whose only failure is at calculation is posted with failures (F259)", {
    when() {
        const own = one("mantle.ledger.config.AssetTypeGlAccount", {assetId: "P12_PRESS"})
        call("update#mantle.ledger.config.AssetTypeGlAccount", {
            assetTypeGlAccountId: own.assetTypeGlAccountId,
            depreciationGlAccountId: "672000000"
        })
        return asUser(f.users.gl, () => {
            const preview = call(books + "preview#Depreciation", {
                organizationPartyId: f.org,
                timePeriodId: f.monthId,
                assetIdList: ["P12_PRESS", "P12_PRINTER"]
            })
            const posted = call(books + "post#Depreciation", {
                periodRunId: preview.periodRunId,
                calculationVersion: preview.calculationVersion,
                operationKey: "p12-dep2-" + preview.periodRunId
            })
            const run = one("mantle.ledger.transaction.AccountingPeriodRun", {periodRunId: preview.periodRunId})
            return {preview, posted, run}
        })
    },
    then({preview, posted, run}) {
        preview.resultCount == 2 && preview.failedCount == 1
        posted.statusId == "PrnPartial" && posted.postedCount == 1 && posted.failedCount == 0
        run.failedCount == 1
        toDecimal(asset("P12_PRESS").depreciation).toNumber() == 83.33
    }
})

feature("an adjustment changes the book from its day; a read user cannot", {
    when() {
        const adjust = {
            assetId: "P12_PRESS",
            costChange: "500",
            usefulLifeChange: 1,
            changeReason: "Rebuilt motor",
            operationKey: "p12-adj-press"
        }
        const before = asset("P12_PRESS")
        const readRefusal = asUser(f.users.read, () => rejected("adjust#AssetBook", adjust))
        const adjusted = asUser(f.users.gl, () => call(books + "adjust#AssetBook", adjust))
        return {readRefusal, adjusted, before, after: asset("P12_PRESS")}
    },
    then({readRefusal, adjusted, before, after}) {
        readRefusal.includes("PERMISSION_DENIED")
        lines(adjusted.acctgTransId) == "C 139100000 500, D 131100000 500"
        adjusted.netBookBefore.toNumber() == 4916.67 && adjusted.netBookAfter.toNumber() == 5416.67
        calendar(after.expectedEndOfLife) ==
            yearsLater(calendar(before.expectedEndOfLife), 1)
    }
})

feature("a sale disposes at a gain, a scrap at a loss, and the sale is reversed in an open period", {
    when() {
        return asUser(f.users.gl, () => {
            const sale = call(books + "dispose#Asset", {
                assetId: "P12_VAN",
                disposalTypeEnumId: "AdtSale",
                proceedsAmount: "4000",
                buyerPartyId: f.customer,
                changeReason: "Sold to a customer",
                operationKey: "p12-sell-van"
            })
            const scrap = call(books + "dispose#Asset", {
                assetId: "P12_PRESS",
                disposalTypeEnumId: "AdtScrap",
                changeReason: "Scrapped",
                operationKey: "p12-scrap-press"
            })
            const twice = rejected("dispose#Asset", {
                assetId: "P12_PRESS",
                disposalTypeEnumId: "AdtScrap",
                changeReason: "Scrapped again",
                operationKey: "p12-scrap-press-2"
            })
            const disposedVan = asset("P12_VAN")
            const reversal = call(books + "reverse#AssetBookEvent", {
                assetBookEventId: sale.assetBookEventId,
                changeReason: "The buyer withdrew",
                operationKey: "p12-rev-van"
            })
            const reversedTwice = rejected("reverse#AssetBookEvent", {
                assetBookEventId: sale.assetBookEventId,
                changeReason: "Again",
                operationKey: "p12-rev-van-2"
            })
            const truckEvent = ec.entity
                .find("mantle.product.asset.AssetBookEvent")
                .condition({assetId: "P12_TRUCK", eventTypeEnumId: "AbeCapitalize"})
                .disableAuthz()
                .one()
            const depreciated = rejected("reverse#AssetBookEvent", {
                assetBookEventId: truckEvent.assetBookEventId,
                changeReason: "Undo",
                operationKey: "p12-rev-truck"
            })
            return {sale, scrap, twice, disposedVan, reversal, reversedTwice, depreciated}
        })
    },
    then({sale, scrap, twice, disposedVan, reversal, reversedTwice, depreciated}) {
        sale.gainLossAmount.toNumber() == 500
        lines(sale.acctgTransId) == "C 131100000 3600, C 814100000 500, D 182000000 100, D 253100000 4000"
        scrap.gainLossAmount.toNumber() == -5416.67
        lines(scrap.acctgTransId) == "C 131100000 5500, D 182000000 83.33, D 793100000 5416.67"
        twice.includes("ALREADY_DISPOSED")
        disposedVan.actualEndOfLife != null && asset("P12_VAN").actualEndOfLife == null
        lines(reversal.acctgTransId) == "C 182000000 100, C 253100000 4000, D 131100000 3600, D 814100000 500"
        one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: reversal.acctgTransId}).reverseOfAcctgTransId ==
            sale.acctgTransId
        reversedTwice.includes("EVENT_REVERSED")
        depreciated.includes("EVENT_DEPRECIATED")
    }
})

feature("a disposal waits for the months before it; disposed and capitalized assets refuse repair and runs (F257, F258)", {
    when() {
        return {
            due: asUser(f.users.gl, () =>
                rejected("dispose#Asset", {
                    assetId: "P12_OLD",
                    disposalTypeEnumId: "AdtScrap",
                    changeReason: "Scrapped",
                    operationKey: "p12-scrap-old"
                })
            ),
            disposedRun: asUser(f.users.gl, () =>
                call(books + "preview#Depreciation", {
                    organizationPartyId: f.org,
                    timePeriodId: f.monthId,
                    assetIdList: ["P12_PRESS"]
                })
            ),
            disposedRepair: asUser(f.users.financeadmin, () =>
                rejected("repair#AcquireCost", {
                    assetId: "P12_PRESS",
                    acquireCost: "6000",
                    changeReason: "Wrong cost",
                    operationKey: "p12-fix-press"
                })
            ),
            capitalizedRepair: asUser(f.users.financeadmin, () =>
                rejected("repair#AcquireCost", {
                    assetId: "P12_TRUCK",
                    acquireCost: "13000",
                    changeReason: "Wrong cost",
                    operationKey: "p12-fix-truck"
                })
            ),
            unpostedReceipt: asUser(f.users.gl, () =>
                rejected("capitalize#Asset", {
                    assetId: "P12_UNPOSTED",
                    acquireCost: "700",
                    usefulLifeYears: 3,
                    depreciationTypeEnumId: "DtpStraightLine",
                    operationKey: "p12-cap-unposted"
                })
            )
        }
    },
    then({due, disposedRun, disposedRepair, capitalizedRepair, unpostedReceipt}) {
        due.includes("DEPRECIATION_DUE") && due.includes("Last month")
        disposedRun.resultCount == 0
        disposedRepair.includes("ASSET_DISPOSED")
        capitalizedRepair.includes("ASSET_CAPITALIZED")
        unpostedReceipt.includes("RECEIPT_NOT_POSTED")
    }
})

feature("a closed month refuses depreciation, capitalization and an acquire cost repair of its postings", {
    when() {
        return {
            run: asUser(f.users.gl, () =>
                rejected("preview#Depreciation", {organizationPartyId: f.org, timePeriodId: f.lastMonthId})
            ),
            capitalize: asUser(f.users.gl, () =>
                rejected("capitalize#Asset", {
                    assetId: "P12_PRINTER",
                    inServiceDate: f.lastMonthDay,
                    acquireCost: "800",
                    usefulLifeYears: 3,
                    depreciationTypeEnumId: "DtpStraightLine",
                    operationKey: "p12-cap-printer"
                })
            ),
            glRepair: asUser(f.users.gl, () =>
                rejected("repair#AcquireCost", {
                    assetId: "P12_PRINTER",
                    acquireCost: "800",
                    changeReason: "Cost found",
                    operationKey: "p12-fix-printer"
                })
            ),
            closedRepair: asUser(f.users.financeadmin, () =>
                rejected("repair#AcquireCost", {
                    assetId: "P12_RCV",
                    acquireCost: "2100",
                    changeReason: "Freight left out",
                    operationKey: "p12-fix-old"
                })
            ),
            repaired: asUser(f.users.financeadmin, () =>
                call(books + "repair#AcquireCost", {
                    assetId: "P12_PRINTER",
                    acquireCost: "800",
                    changeReason: "Cost found",
                    operationKey: "p12-fix-printer"
                })
            )
        }
    },
    then({run, capitalize, glRepair, closedRepair, repaired}) {
        run.includes("PERIOD_CLOSED")
        capitalize.includes("PERIOD_CLOSED")
        glRepair.includes("PERMISSION_DENIED")
        closedRepair.includes("PERIOD_CLOSED")
        toDecimal(asset("P12_PRINTER").acquireCost).toNumber() == 800
        one("mantle.product.asset.AssetBookEvent", {assetBookEventId: repaired.assetBookEventId}).eventTypeEnumId ==
            "AbeCostRepair"
    }
})

feature("a class added today applies to an asset in service today (F261)", {
    when() {
        asUser(f.users.financeadmin, () =>
            call(books + "store#Class", {
                organizationPartyId: f.org,
                classEnumId: "AsClsLaptop",
                usefulLifeYears: 3,
                depreciationTypeEnumId: "DtpStraightLine",
                changeReason: "Laptops over three years"
            })
        )
        const capitalized = asUser(f.users.gl, () =>
            call(books + "capitalize#Asset", {
                assetId: "P12_LAPTOP",
                classEnumId: "AsClsLaptop",
                acquireCost: "1500",
                operationKey: "p12-cap-laptop"
            })
        )
        return {capitalized, laptop: asset("P12_LAPTOP")}
    },
    then({capitalized, laptop}) {
        capitalized.assetBookEventId != null
        calendar(laptop.expectedEndOfLife) == yearsLater(f.day, 3)
    }
})

feature("an asset sold on a posted invoice line ends its life and is not depreciated again (F262)", {
    when() {
        asUser(f.users.gl, () =>
            call(books + "capitalize#Asset", {
                assetId: "P12_SOLD",
                acquireCost: "1000",
                usefulLifeYears: 2,
                depreciationTypeEnumId: "DtpStraightLine",
                operationKey: "p12-cap-sold"
            })
        )
        const made = call("create#mantle.account.invoice.Invoice", {
            invoiceTypeEnumId: "InvoiceSales",
            fromPartyId: f.org,
            toPartyId: f.customer,
            statusId: "InvoiceInProcess",
            invoiceDate: f.timestamp,
            accountingDate: f.day,
            currencyUomId: "USD"
        })
        call("mantle.account.InvoiceServices.create#InvoiceItem", {
            invoiceId: made.invoiceId,
            itemTypeEnumId: "ItemAsset",
            assetId: "P12_SOLD",
            quantity: "1",
            amount: "900",
            description: "Sold asset"
        })
        call("update#mantle.account.invoice.Invoice", {invoiceId: made.invoiceId, statusId: "InvoiceFinalized"})
        const run = asUser(f.users.gl, () =>
            call(books + "preview#Depreciation", {
                organizationPartyId: f.org,
                timePeriodId: f.monthId,
                assetIdList: ["P12_SOLD"]
            })
        )
        return {sold: asset("P12_SOLD"), run}
    },
    then({sold, run}) {
        calendar(sold.actualEndOfLife) == f.day
        run.resultCount == 0
    }
})
