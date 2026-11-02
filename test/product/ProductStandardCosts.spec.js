// Standalone Mantle fixtures define their own roles and grant only shared Moqui permissions.
function nativeTestRoles() {
    const roles = {
        NATIVE_COST_VIEW: ["PRODUCT_COST_VIEW"],
        NATIVE_COST_ESTIMATE: ["PRODUCT_COST_VIEW", "PRODUCT_COST_ESTIMATE"],
        NATIVE_COST_APPROVE: ["PRODUCT_COST_VIEW", "PRODUCT_COST_APPROVE"],
        NATIVE_CATALOG_ADMIN: [
            "PRODUCT_CATALOG_ADMIN",
            "PRODUCT_COST_VIEW",
            "PRODUCT_COST_ESTIMATE",
            "PRODUCT_COST_APPROVE",
            "PRICE_VIEW",
            "PRICE_EDIT",
            "SUPPLIER_PRICE_VIEW",
            "SUPPLIER_PRICE_EDIT"
        ],
        NATIVE_CATALOG_EDITOR: [],
        NATIVE_PRICE_VIEW: ["PRICE_VIEW"],
        NATIVE_PRICE_EDIT: ["PRICE_VIEW", "PRICE_EDIT"],
        NATIVE_SUPPLIER_VIEW: ["SUPPLIER_PRICE_VIEW"],
        NATIVE_GL_POST: ["ACCOUNTING_VIEW", "ACCOUNTING_GL_POST", "PRODUCT_COST_VIEW"],
        NATIVE_METHOD_VIEW: ["METHOD_VIEW"]
    }
    for (const [group, permissions] of Object.entries(roles)) {
        if (!one("moqui.security.UserGroup", {userGroupId: group})) call("create#moqui.security.UserGroup", {userGroupId: group})
        for (const permission of permissions)
            if (
                !one("moqui.security.UserGroupPermission", {
                    userGroupId: group,
                    userPermissionId: permission,
                    fromDate: "2000-01-01T00:00:00Z"
                })
            )
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId: group,
                    userPermissionId: permission,
                    fromDate: "2000-01-01T00:00:00Z"
                })
    }
}
const S = "mantle.product.CostServices.",
    H = "mantle.product.cost.ProductStandardCost"
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one()
function as(user, fn) {
    login(user)
    ec.artifactExecution.disableAuthz()
    try {
        return fn()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
function invoke(n, p) {
    try {
        const out = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
let estimateId, approvedDate
spec({
    setupSpec() {
        try {
            ec.resource.xslFoTransform("<html><body>Cost approval integration</body></html>", null, null, "application/pdf")
        } catch (e) {
            if (String(e).includes("PDF is not available"))
                skip("Cost approval integration needs Chromium: configure pdf_chromium_path")
            throw e
        }
        as("john.doe", () => {
            nativeTestRoles()
            for (const id of ["CST_ORG", "CST_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, group] of [
                ["CST_WRITER", "NATIVE_COST_ESTIMATE"],
                ["CST_APPROVER", "NATIVE_COST_APPROVE"],
                ["CST_READER", "NATIVE_COST_VIEW"],
                ["CST_ADMIN", "NATIVE_CATALOG_ADMIN"],
                ["CST_CATALOG", "NATIVE_CATALOG_EDITOR"]
            ]) {
                if (!one("moqui.security.UserGroup", {userGroupId: group}))
                    call("create#moqui.security.UserGroup", {userGroupId: group})
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: group, fromDate: "2000-01-01T00:00:00Z"})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "CST_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const id of ["CST_WRITER", "CST_APPROVER"])
                call("create#moqui.security.UserGroupMember", {
                    userId: id,
                    userGroupId: "NATIVE_METHOD_VIEW",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            for (const [productId, ownerPartyId] of [
                ["CST_FIN", "CST_ORG"],
                ["CST_OTHER_PRODUCT", "CST_OTHER"]
            ])
                call("create#mantle.product.Product", {
                    productId,
                    ownerPartyId,
                    productName: productId,
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.facility.Facility", {
                facilityId: "CST_FAC",
                ownerPartyId: "CST_ORG",
                facilityTypeEnumId: "FcTpWarehouse"
            })
            call("create#mantle.product.asset.Asset", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                ownerPartyId: "CST_ORG",
                facilityId: "CST_FAC",
                assetTypeEnumId: "AstTpInventory",
                statusId: "AstAvailable",
                hasQuantity: "Y",
                quantityOnHandTotal: 0,
                availableToPromiseTotal: 0,
                acquireCost: 10,
                acquireCostUomId: "USD"
            })
            call("create#mantle.product.asset.AssetDetail", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                effectiveDate: "2000-01-01T00:00:00Z",
                quantityOnHandDiff: 5,
                availableToPromiseDiff: 5
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("manual drafts require cost-estimator authority and derive totals from explicit components", {
    when() {
        const saved = as("cst_writer", () =>
            invoke(S + "store#ProductStandardCost", {
                productId: "CST_FIN",
                organizationPartyId: "CST_ORG",
                quantity: 10,
                quantityUomId: "OTH_ea",
                priceUomId: "USD",
                changeReason: "Manual standard draft"
            })
        )
        estimateId = saved.standardCost?.productStandardCostId
        const component = as("cst_writer", () =>
            invoke(S + "store#StandardCostComponent", {
                productStandardCostId: estimateId,
                componentTypeEnumId: "PccMaterial",
                description: "Planned material",
                quantity: 10,
                quantityUomId: "OTH_ea",
                rateAmount: 2,
                expectedRevision: saved.estimateRevision,
                changeReason: "Material basis"
            })
        )
        const denied = as("cst_catalog", () => invoke(S + "get#ProductStandardCost", {productStandardCostId: estimateId})),
            foreign = as("cst_writer", () =>
                invoke(S + "store#ProductStandardCost", {
                    productId: "CST_OTHER_PRODUCT",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Foreign refused"
                })
            )
        return {saved, component, denied, foreign}
    },
    then({saved, component, denied, foreign}) {
        saved.error == ""
        component.error == ""
        component.standardCost.totalCost == 20
        component.standardCost.unitCost == 2
        component.standardCost.complete == "Y"
        denied.error.includes("authority")
        foreign.error.includes("not available")
    }
})
feature("a different approver freezes a dated estimate and PDF without revaluing stock or writing the ledger", {
    when() {
        const ledgerBefore = as("john.doe", () => find("mantle.ledger.transaction.AcctgTrans").count()),
            approved = as("cst_approver", () => {
                const d = call(S + "get#ProductStandardCost", {productStandardCostId: estimateId})
                return invoke(S + "approve#ProductStandardCost", {
                    productStandardCostId: estimateId,
                    expectedRevision: d.estimateRevision,
                    changeReason: "Independent standard approval"
                })
            })
        approvedDate = approved.standardCost?.fromDate
        const changed = as("cst_writer", () =>
                invoke(S + "store#StandardCostComponent", {
                    productStandardCostComponentId: approved.componentRows?.[0]?.productStandardCostComponentId,
                    rateAmount: 999,
                    changeReason: "Immutable refused"
                })
            ),
            current = as("cst_reader", () =>
                call(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"})
            )
        return {
            approved,
            changed,
            current,
            ledgerBefore,
            ledgerAfter: as("john.doe", () => find("mantle.ledger.transaction.AcctgTrans").count()),
            stock: one("mantle.product.asset.Asset", {assetId: "CST_STOCK"})?.getMap()
        }
    },
    then({approved, changed, current, ledgerBefore, ledgerAfter, stock}) {
        approved.error == ""
        approved.standardCost.state == "approved"
        approved.standardCost.approvedByUserId == "CST_APPROVER"
        approved.standardCost.approvedPdfLocation.endsWith("/approved.pdf")
        ec.resource.getLocationReference(approved.standardCost.approvedPdfLocation).exists == true
        changed.error.includes("immutable")
        current.standardCost.productStandardCostId == estimateId
        stock.acquireCost == 10
        stock.quantityOnHandTotal == 5
        ledgerAfter == ledgerBefore
    }
})
feature("Products administration grants estimation and approval but does not bypass the dated self-approval policy", {
    when() {
        return as("cst_admin", () => {
            const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Administrator draft"
                }),
                id = d.standardCost.productStandardCostId,
                c = call(S + "store#StandardCostComponent", {
                    productStandardCostId: id,
                    componentTypeEnumId: "PccMaterial",
                    quantity: 1,
                    quantityUomId: "OTH_ea",
                    rateAmount: 3,
                    changeReason: "Administrator component"
                })
            return invoke(S + "approve#ProductStandardCost", {
                productStandardCostId: id,
                expectedRevision: c.estimateRevision,
                changeReason: "Self approval refused"
            })
        })
    },
    then({error}) {
        error.includes("drafter cannot approve")
    }
})
feature("a reviewed roll-up refuses changed source inputs, and a saved calculation is idempotent", {
    when() {
        const old = as("cst_writer", () =>
            call(S + "preview#ProductCostRollup", {
                productId: "CST_FIN",
                organizationPartyId: "CST_ORG",
                quantity: 5,
                materialBasis: "standard"
            })
        )
        const replacement = as("cst_writer", () => {
            const d = call(S + "store#ProductStandardCost", {
                productId: "CST_FIN",
                organizationPartyId: "CST_ORG",
                changeReason: "Changed source draft"
            })
            return call(S + "store#StandardCostComponent", {
                productStandardCostId: d.standardCost.productStandardCostId,
                componentTypeEnumId: "PccMaterial",
                quantity: 1,
                quantityUomId: "OTH_ea",
                rateAmount: 3,
                changeReason: "Changed source material"
            })
        })
        as("cst_approver", () =>
            call(S + "approve#ProductStandardCost", {
                productStandardCostId: replacement.standardCost.productStandardCostId,
                expectedRevision: replacement.estimateRevision,
                changeReason: "Changed source approval"
            })
        )
        const stale = as("cst_writer", () =>
            invoke(S + "save#ProductCostRollup", {
                calculationId: old.calculationId,
                inputFingerprint: old.inputFingerprint,
                changeReason: "Stale save refused"
            })
        )
        const fresh = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 5,
                    materialBasis: "standard"
                })
            ),
            saved = as("cst_writer", () =>
                call(S + "save#ProductCostRollup", {
                    calculationId: fresh.calculationId,
                    inputFingerprint: fresh.inputFingerprint,
                    changeReason: "Reviewed standard basis"
                })
            ),
            again = as("cst_writer", () =>
                call(S + "save#ProductCostRollup", {
                    calculationId: fresh.calculationId,
                    inputFingerprint: fresh.inputFingerprint,
                    changeReason: "Retry reviewed save"
                })
            )
        return {old, stale, fresh, saved, again}
    },
    then({old, stale, fresh, saved, again}) {
        old.complete == true
        old.standardCost.totalCost == 10
        stale.error.includes("changed")
        fresh.complete == true
        fresh.standardCost.totalCost == 15
        saved.standardCost.state == "draft"
        again.standardCost.productStandardCostId == saved.standardCost.productStandardCostId
    }
})
feature("missing material inputs remain unvalued and incomplete estimates cannot be approved", {
    when() {
        const preview = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    materialBasis: "average"
                })
            ),
            saved = as("cst_writer", () =>
                call(S + "save#ProductCostRollup", {
                    calculationId: preview.calculationId,
                    inputFingerprint: preview.inputFingerprint,
                    changeReason: "Incomplete review draft"
                })
            ),
            approval = as("cst_approver", () =>
                invoke(S + "approve#ProductStandardCost", {
                    productStandardCostId: saved.standardCost.productStandardCostId,
                    expectedRevision: saved.estimateRevision,
                    changeReason: "Incomplete approval refused"
                })
            )
        return {preview, saved, approval}
    },
    then({preview, saved, approval}) {
        preview.complete == false
        preview.standardCost.unitCost == null
        preview.findings.length > 0
        saved.standardCost.complete == "N"
        approval.error.includes("incomplete")
    }
})
feature("the single calculator rolls up scrap, setup and batch times and separates hourly from percentage overhead", {
    when() {
        as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "CST_RM",
                productName: "Cost material",
                ownerPartyId: "CST_ORG",
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
            call("mantle.work.RoutingServices.store#WorkCenter", {
                organizationPartyId: "CST_ORG",
                facilityId: "CST_FAC",
                changeReason: "Cost fixture center"
            })
            for (const [component, rate] of [
                ["PccLabor", 20],
                ["PccMachine", 10],
                ["PccOverhead", 5]
            ])
                call("mantle.work.RoutingServices.store#WorkCenterRate", {
                    organizationPartyId: "CST_ORG",
                    facilityId: "CST_FAC",
                    componentTypeEnumId: component,
                    rateAmount: rate,
                    priceUomId: "USD",
                    approve: true,
                    changeReason: "Cost fixture rate"
                })
            const route = call("mantle.work.RoutingServices.store#Routing", {
                    organizationPartyId: "CST_ORG",
                    workEffortName: "Cost fixture routing",
                    changeReason: "Cost route"
                }),
                routeId = route.routing.workEffortId,
                op = call("mantle.work.RoutingServices.store#RoutingOperation", {
                    workEffortId: routeId,
                    workEffortName: "Cost assembly",
                    estimatedSetupTime: 0.5,
                    estimatedWorkTime: 0.1,
                    methodMachineRunTime: 0.2,
                    methodBatchQuantity: 1,
                    methodQuantityUomId: "OTH_ea",
                    methodWorkCenterId: "CST_FAC",
                    changeReason: "Cost standards"
                })
            call("mantle.work.RoutingServices.release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: op.expectedRevision,
                changeReason: "Approved cost routing"
            })
            const bom = call("mantle.product.BomServices.store#Bom", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    routingWorkEffortId: routeId,
                    baseQuantity: 10,
                    changeReason: "Cost method"
                }),
                bomId = bom.productBom.productBomId,
                line = call("mantle.product.BomServices.store#BomItem", {
                    productBomId: bomId,
                    productId: "CST_RM",
                    quantity: 20,
                    scrapFactor: 0.1,
                    changeReason: "Cost scrap allowance"
                })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: bomId,
                expectedRevision: line.expectedRevision,
                changeReason: "Approved cost method"
            })
        })
        const material = as("cst_writer", () => {
            const d = call(S + "store#ProductStandardCost", {
                productId: "CST_RM",
                organizationPartyId: "CST_ORG",
                changeReason: "Material standard"
            })
            return call(S + "store#StandardCostComponent", {
                productStandardCostId: d.standardCost.productStandardCostId,
                quantity: 1,
                quantityUomId: "OTH_ea",
                rateAmount: 4,
                changeReason: "Material standard rate"
            })
        })
        as("cst_approver", () =>
            call(S + "approve#ProductStandardCost", {
                productStandardCostId: material.standardCost.productStandardCostId,
                expectedRevision: material.estimateRevision,
                changeReason: "Approve material standard"
            })
        )
        const hourly = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 10,
                    materialBasis: "standard",
                    overheadBasis: "work-center"
                })
            ),
            percentage = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 10,
                    materialBasis: "standard",
                    overheadBasis: "percent",
                    overheadPercent: 20
                })
            )
        return {hourly, percentage}
    },
    then({hourly, percentage}) {
        hourly.complete == true
        hourly.standardCost.materialCost == 88
        hourly.standardCost.laborCost == 30
        hourly.standardCost.machineCost == 20
        hourly.standardCost.overheadCost == 10
        hourly.standardCost.totalCost == 148
        percentage.complete == true
        percentage.standardCost.overheadCost == 27.6
        percentage.standardCost.totalCost == 165.6
    }
})
feature("material basis permissions and missing conversions are findings and never implicit zero prices", {
    when() {
        as("john.doe", () => {
            call("create#mantle.party.Party", {
                partyId: "CST_SUPPLIER",
                ownerPartyId: "CST_ORG",
                partyTypeEnumId: "PtyOrganization"
            })
            call("create#mantle.party.Organization", {partyId: "CST_SUPPLIER", organizationName: "Cost supplier"})
            call("create#mantle.party.PartyRole", {partyId: "CST_SUPPLIER", roleTypeId: "Supplier"})
            call("create#mantle.product.ProductPrice", {
                productPriceId: "CST_SUP_PRICE",
                productId: "CST_RM",
                vendorPartyId: "CST_SUPPLIER",
                customerPartyId: "CST_ORG",
                priceTypeEnumId: "PptCurrent",
                pricePurposeEnumId: "PppPurchase",
                preferredOrderEnumId: "SpoMain",
                quantityUomId: "OTH_ea",
                priceUomId: "USD",
                price: 99.91,
                minQuantity: 0,
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#mantle.product.ProductPrice", {
                productPriceId: "CST_AVG_PRICE",
                productId: "CST_FIN",
                vendorPartyId: "CST_ORG",
                priceTypeEnumId: "PptAverage",
                pricePurposeEnumId: "PppPurchase",
                quantityUomId: "OTH_ea",
                priceUomId: "USD",
                price: 7,
                minQuantity: 0,
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#mantle.product.receipt.AssetReceipt", {
                assetReceiptId: "CST_RECEIPT",
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                quantityAccepted: 5,
                receivedDate: "2000-01-01T00:00:00Z"
            })
        })
        const denied = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 10,
                    materialBasis: "supplier"
                })
            ),
            average = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 2,
                    materialBasis: "average",
                    methodMode: "purchased"
                })
            ),
            receipt = as("cst_writer", () =>
                call(S + "preview#ProductCostRollup", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    quantity: 2,
                    materialBasis: "last-receipt",
                    methodMode: "purchased"
                })
            )
        as("john.doe", () =>
            call("create#moqui.security.UserGroupMember", {
                userId: "CST_WRITER",
                userGroupId: "NATIVE_SUPPLIER_VIEW",
                fromDate: "2000-01-01T00:00:00Z"
            })
        )
        const supplier = as("cst_writer", () =>
            call(S + "preview#ProductCostRollup", {
                productId: "CST_FIN",
                organizationPartyId: "CST_ORG",
                quantity: 10,
                materialBasis: "supplier"
            })
        )
        return {denied, average, receipt, supplier}
    },
    then({denied, average, receipt, supplier}) {
        denied.complete == false
        denied.standardCost.unitCost == null
        denied.findings.some(r => r.message.includes("Supplier-price read"))
        !JSON.stringify(denied).includes("99.91")
        average.complete == true
        average.standardCost.totalCost == 14
        receipt.complete == true
        receipt.standardCost.totalCost == 20
        supplier.complete == true
        toDecimal(supplier.standardCost.materialCost).compare("2198.02") == 0
    }
})
feature("approved standards are a private pricing base and sales snapshots do not replace purchase accounting semantics", {
    when() {
        as("john.doe", () => {
            for (const [id, group] of [
                ["CST_PRICE_READER", "NATIVE_PRICE_VIEW"],
                ["CST_PRICE_AUTHOR", "NATIVE_PRICE_EDIT"]
            ]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: group, fromDate: "2000-01-01T00:00:00Z"})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "CST_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            call("create#mantle.order.OrderHeader", {orderId: "CST_ORDER", currencyUomId: "USD", statusId: "OrderOpen"})
            call("create#mantle.order.OrderPart", {
                orderId: "CST_ORDER",
                orderPartSeqId: "01",
                vendorPartyId: "CST_ORG",
                customerPartyId: "CST_SUPPLIER"
            })
            call("create#mantle.order.OrderPart", {
                orderId: "CST_ORDER",
                orderPartSeqId: "02",
                vendorPartyId: "CST_SUPPLIER",
                customerPartyId: "CST_ORG"
            })
        })
        const published = as("john.doe", () => {
            const list = call("mantle.product.PriceServices.store#ProductPriceList", {
                    listName: "Approved standard base",
                    organizationPartyId: "CST_ORG",
                    direction: "sales",
                    priceUomId: "USD",
                    changeReason: "Standard-price fixture"
                }),
                id = list.priceListId
            call("mantle.product.PriceServices.store#ProductPriceRule", {
                priceListId: id,
                selector: "product",
                productId: "CST_FIN",
                baseType: "standard",
                percentChange: 10,
                changeReason: "Approved standard plus margin"
            })
            const reviewed = call("mantle.product.PriceServices.get#ProductPriceListPublication", {priceListId: id})
            call("mantle.product.PriceServices.publish#ProductPriceList", {
                priceListId: id,
                publicationToken: reviewed.publicationToken,
                changeReason: "Publish standard basis"
            })
            return id
        })
        const price = as("cst_price_reader", () =>
                call("mantle.product.PriceServices.get#ProductPrice", {
                    productId: "CST_FIN",
                    vendorPartyId: "CST_ORG",
                    organizationPartyId: "CST_ORG",
                    priceUomId: "USD",
                    priceListId: published,
                    explain: true
                })
            ),
            costRead = as("cst_price_reader", () =>
                invoke(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"})
            ),
            deniedRule = as("cst_price_author", () =>
                invoke("mantle.product.PriceServices.store#ProductPriceRule", {
                    priceListId: published,
                    selector: "product",
                    productId: "CST_RM",
                    baseType: "standard",
                    sequenceNum: 20,
                    changeReason: "Hidden base refused"
                })
            )
        const sale = as("cst_catalog", () =>
                call("mantle.order.OrderServices.create#OrderItem", {
                    orderId: "CST_ORDER",
                    orderPartSeqId: "01",
                    productId: "CST_FIN",
                    unitAmount: 20,
                    quantity: 2,
                    standardCost: 999,
                    requireInventory: false
                })
            ),
            purchase = as("cst_catalog", () =>
                call("mantle.order.OrderServices.create#OrderItem", {
                    orderId: "CST_ORDER",
                    orderPartSeqId: "02",
                    productId: "CST_FIN",
                    unitAmount: 9,
                    quantity: 2,
                    standardCost: 7,
                    requireInventory: false
                })
            )
        as("cst_catalog", () =>
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: "CST_ORDER",
                orderItemSeqId: sale.orderItemSeqId,
                quantity: 3,
                standardCost: 888,
                productStandardCostId: "forged",
                requireInventory: false
            })
        )
        const facts = as("john.doe", () => ({
            sale: one("mantle.order.OrderItem", {orderId: "CST_ORDER", orderItemSeqId: sale.orderItemSeqId}).getMap(),
            purchase: one("mantle.order.OrderItem", {orderId: "CST_ORDER", orderItemSeqId: purchase.orderItemSeqId}).getMap()
        }))
        return {price, costRead, deniedRule, sale, facts}
    },
    then({price, costRead, deniedRule, sale, facts}) {
        toDecimal(price.price).compare("3.3") == 0
        price.priceTrace.some(r => r.kind === "restricted-standard-base")
        !price.priceTrace.some(r => r.kind === "rule-base" || r.kind === "percentage")
        costRead.error.includes("authority")
        deniedRule.error.includes("Cost-read")
        !Object.keys(sale).includes("standardCost")
        facts.sale.standardCost == 3
        facts.sale.productStandardCostId != null
        facts.purchase.standardCost == 7
        facts.purchase.productStandardCostId == null
    }
})

const BOOK = "mantle.ledger.AssetBookServices."
let reval
feature("Accounting reviews owned quantities separately from estimates and refuses non-GL actors", {
    when() {
        as("john.doe", () => {
            call("create#moqui.security.UserGroupMember", {
                userId: "CST_APPROVER",
                userGroupId: "NATIVE_GL_POST",
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: "CST_ORG",
                baseCurrencyUomId: "USD",
                realTimeGlSummary: "N"
            })
            call("create#mantle.party.time.TimePeriod", {
                timePeriodId: "CST_YEAR",
                partyId: "CST_ORG",
                timePeriodTypeId: "FiscalYear",
                fromDate: new Date().getUTCFullYear() + "-01-01",
                thruDate: new Date().getUTCFullYear() + "-12-31",
                isClosed: "N"
            })
            for (const [id, type] of [
                ["CST_INV", "GatInventory"],
                ["CST_REVAL", "GatInventoryRevaluation"]
            ]) {
                call("create#mantle.ledger.account.GlAccount", {
                    glAccountId: id,
                    accountName: id,
                    glAccountTypeEnumId: type,
                    glAccountClassEnumId: type === "GatInventory" ? "ASSET" : "EXPENSE",
                    glResourceTypeEnumId: "GlrtMoney"
                })
                call("create#mantle.ledger.config.GlAccountTypeDefault", {
                    organizationPartyId: "CST_ORG",
                    glAccountTypeEnumId: type,
                    glAccountId: id
                })
            }
            call("create#mantle.product.asset.Asset", {
                assetId: "CST_FOREIGN_STOCK",
                productId: "CST_FIN",
                ownerPartyId: "CST_OTHER",
                facilityId: "CST_FAC",
                assetTypeEnumId: "AstTpInventory",
                hasQuantity: "Y",
                quantityOnHandTotal: 999,
                acquireCost: 800,
                acquireCostUomId: "USD"
            })
        })
        const current = as("cst_reader", () =>
                call(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"})
            ),
            denied = as("cst_reader", () =>
                invoke(BOOK + "preview#Revaluation", {
                    productStandardCostId: current.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Denied actor"
                })
            )
        const disabled = as("cst_approver", () =>
            invoke(BOOK + "preview#Revaluation", {
                productStandardCostId: current.standardCost.productStandardCostId,
                organizationPartyId: "CST_ORG",
                changeReason: "Disabled by default"
            })
        )
        as("john.doe", () =>
            call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: "CST_ORG",
                inventoryRevaluationEnabled: "Y",
                inventoryRevaluationEnabled_changeReason: "Enable reviewed test revaluation"
            })
        )
        reval = as("cst_approver", () =>
            invoke(BOOK + "preview#Revaluation", {
                productStandardCostId: current.standardCost.productStandardCostId,
                organizationPartyId: "CST_ORG",
                facilityId: "CST_FAC",
                changeReason: "Review approved standard"
            })
        )
        return {denied, reval, disabled}
    },
    then({denied, reval, disabled}) {
        disabled.error.includes("disabled")
        denied.error.includes("glPost")
        reval.error == ""
        reval.complete == true
        reval.quantity == 5
        reval.totalAmount == -35
        reval.bookRows.length == 1
        reval.bookRows[0].assetId == "CST_STOCK"
    }
})
feature("the reviewed Accounting posting is balanced, value-only, atomic and idempotent", {
    when() {
        return as("cst_approver", () => {
            const args = {previewId: reval.previewId, inputFingerprint: reval.inputFingerprint, operationKey: "CST_REVAL_ONCE"},
                posted = invoke(BOOK + "post#Revaluation", args),
                again = invoke(BOOK + "post#Revaluation", args),
                conflict = invoke(BOOK + "post#Revaluation", Object.assign({}, args, {changeReason: "A changed request"})),
                entries = posted.acctgTransId
                    ? find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: posted.acctgTransId})
                          .list()
                          .map(r => r.getMap())
                    : []
            return {
                posted,
                again,
                conflict,
                entries,
                transaction: posted.acctgTransId
                    ? one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: posted.acctgTransId}).getMap()
                    : null,
                stock: one("mantle.product.asset.Asset", {assetId: "CST_STOCK"}).getMap(),
                events: find("mantle.product.asset.AssetBookEvent", {operationKey: "CST_REVAL_ONCE"}).count()
            }
        })
    },
    then({posted, again, conflict, entries, transaction, stock, events}) {
        posted.error == ""
        again.error == ""
        again.acctgTransId == posted.acctgTransId
        again.alreadyPosted == true
        conflict.error.includes("different request")
        transaction.isPosted == "Y"
        entries.length == 2
        entries[0].amount == 35
        entries[1].amount == 35
        entries[0].debitCreditFlag != entries[1].debitCreditFlag
        stock.quantityOnHandTotal == 5
        stock.acquireCost == 3
        events == 1
    }
})
feature("closed periods and changed stock block revaluation before ledger or book facts are created", {
    when() {
        return as("cst_approver", () => {
            const current = call(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"}),
                p = call(BOOK + "preview#Revaluation", {
                    productStandardCostId: current.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Stale inventory review"
                })
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: 6})
            const stale = invoke(BOOK + "post#Revaluation", {
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "CST_REVAL_STALE"
            })
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: 5})
            call("update#mantle.party.time.TimePeriod", {timePeriodId: "CST_YEAR", isClosed: "Y"})
            const closed = invoke(BOOK + "preview#Revaluation", {
                productStandardCostId: current.standardCost.productStandardCostId,
                organizationPartyId: "CST_ORG",
                changeReason: "Closed period refused"
            })
            call("update#mantle.party.time.TimePeriod", {timePeriodId: "CST_YEAR", isClosed: "N"})
            return {
                stale,
                closed,
                operation: one("mantle.ledger.transaction.PostingOperation", {operationKey: "CST_REVAL_STALE"})
            }
        })
    },
    then({stale, closed, operation}) {
        stale.error.includes("changed")
        closed.error.includes("closed")
        operation == null
    }
})

feature("dated self-approval is explicit and historical cost readers cannot open financial book events", {
    when() {
        as("john.doe", () =>
            call("create#mantle.product.ProductCatalogSetting", {
                organizationPartyId: "CST_ORG",
                fromDate: "2000-01-01T00:00:00Z",
                allowCostSelfApproval: "Y",
                changeReason: "Explicit dated self-approval policy"
            })
        )
        const approved = as("cst_admin", () => {
            const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_RM",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Authorized self-approval draft"
                }),
                c = call(S + "store#StandardCostComponent", {
                    productStandardCostId: d.standardCost.productStandardCostId,
                    quantity: 1,
                    quantityUomId: "OTH_ea",
                    rateAmount: 5,
                    changeReason: "Self-approval component"
                })
            return call(S + "approve#ProductStandardCost", {
                productStandardCostId: c.standardCost.productStandardCostId,
                expectedRevision: c.estimateRevision,
                changeReason: "Explicit policy permits self-approval"
            })
        })
        const event = one("mantle.product.asset.AssetBookEvent", {operationKey: "CST_REVAL_ONCE"}),
            probe = user =>
                as(user, () =>
                    call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                        recordEntityName: "mantle.product.asset.AssetBookEvent",
                        recordId: event.assetBookEventId,
                        checkOnly: true
                    })
                ),
            history = as("cst_reader", () =>
                call(S + "get#ProductCostHistory", {productId: "CST_FIN", organizationPartyId: "CST_ORG"})
            )
        return {approved, hidden: probe("cst_reader"), visible: probe("cst_approver"), history}
    },
    then({approved, hidden, visible, history}) {
        approved.standardCost.approvedByUserId == "CST_ADMIN"
        hidden.recordVisible == false
        visible.recordVisible == true
        history.costHistoryRows.some(r => r.basis === "Standard estimate")
        history.costHistoryRows.some(r => r.basis === "Actual receipt acquisition cost")
        history.costHistoryRows.some(r => r.basis === "Valuation adjustment")
        !JSON.stringify(history.costHistoryRows).includes("acctgTransId")
    }
})
feature("the forward cost remains stable through quantity changes", {
    when() {
        return as("cst_approver", () => {
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: 4})
            const current = call(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"}),
                p = call(BOOK + "preview#Revaluation", {
                    productStandardCostId: current.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Review remaining inventory after movement"
                })
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: 5})
            return p
        })
    },
    then({quantity, totalAmount, bookRows}) {
        quantity == 4
        totalAmount == 0
        bookRows[0].previousUnitCost == 3
        bookRows[0].newUnitCost == 3
    }
})

feature("changing the product on a sales line snapshots its own estimate instead of retaining another product source", {
    when() {
        return as("cst_catalog", () => {
            const row = find("mantle.order.OrderItem", {orderId: "CST_ORDER", orderPartSeqId: "01", productId: "CST_FIN"}).one()
            call("mantle.order.OrderServices.update#OrderItem", {
                orderId: "CST_ORDER",
                orderItemSeqId: row.orderItemSeqId,
                productId: "CST_RM",
                quantityUomId: "OTH_ea",
                standardCost: 888
            })
            const changed = one("mantle.order.OrderItem", {orderId: "CST_ORDER", orderItemSeqId: row.orderItemSeqId})
            return {changed: changed.getMap(), source: one(H, {productStandardCostId: changed.productStandardCostId}).getMap()}
        })
    },
    then({changed, source}) {
        changed.standardCost == 5
        source.productId == "CST_RM"
        changed.productId == "CST_RM"
    }
})

feature("later issues use the forward acquisition cost and cancellation does not repost the revaluation", {
    when() {
        return as("cst_approver", () => {
            call("create#mantle.ledger.config.AssetTypeGlAccount", {
                organizationPartyId: "CST_ORG",
                assetTypeEnumId: "AstTpInventory",
                assetGlAccountId: "CST_INV",
                issuanceGlAccountId: "CST_REVAL",
                receiptGlAccountId: "CST_REVAL",
                transferGlAccountId: "CST_REVAL"
            })
            const out = call("create#mantle.product.issuance.AssetIssuance", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                quantity: 1,
                issuedDate: ec.user.nowTimestamp
            })
            call("create#mantle.product.asset.AssetDetail", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                assetIssuanceId: out.assetIssuanceId,
                effectiveDate: ec.user.nowTimestamp,
                quantityOnHandDiff: -1,
                availableToPromiseDiff: -1
            })
            const transaction = find("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: out.assetIssuanceId}).one(),
                entries = find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: transaction.acctgTransId})
                    .list()
                    .map(r => r.getMap())
            call("mantle.product.AssetServices.cancel#AssetIssuance", {assetIssuanceId: out.assetIssuanceId, quantityToCancel: 1})
            return {
                transaction: transaction.getMap(),
                entries,
                stock: one("mantle.product.asset.Asset", {assetId: "CST_STOCK"}).getMap(),
                revaluations: find("mantle.product.asset.AssetBookEvent", {operationKey: "CST_REVAL_ONCE"}).count()
            }
        })
    },
    then({transaction, entries, stock, revaluations}) {
        transaction.isPosted == "Y"
        entries.length == 2
        entries.every(r => toDecimal(r.amount).compare(3) === 0)
        stock.quantityOnHandTotal == 5
        stock.acquireCost == 3
        revaluations == 1
    }
})
feature("partly issued stock splits on revaluation while its earlier issue and original asset keep their cost", {
    when() {
        return as("john.doe", () => {
            const out = call("create#mantle.product.issuance.AssetIssuance", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                quantity: 2,
                issuedDate: ec.user.nowTimestamp
            })
            call("create#mantle.product.asset.AssetDetail", {
                assetId: "CST_STOCK",
                productId: "CST_FIN",
                assetIssuanceId: out.assetIssuanceId,
                effectiveDate: ec.user.nowTimestamp,
                quantityOnHandDiff: -2,
                availableToPromiseDiff: -2
            })
            const oldTx = find("mantle.ledger.transaction.AcctgTrans", {assetIssuanceId: out.assetIssuanceId}).one(),
                oldEntries = find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: oldTx.acctgTransId})
                    .list()
                    .map(r => r.getMap())
            const draft = as("cst_writer", () => {
                const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Next forward cost"
                })
                return call(S + "store#StandardCostComponent", {
                    productStandardCostId: d.standardCost.productStandardCostId,
                    quantity: 1,
                    quantityUomId: "OTH_ea",
                    rateAmount: 4,
                    changeReason: "Next material cost"
                })
            })
            as("cst_approver", () =>
                call(S + "approve#ProductStandardCost", {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    expectedRevision: draft.estimateRevision,
                    changeReason: "Approve next forward cost"
                })
            )
            const preview = call(BOOK + "preview#Revaluation", {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Revalue only remaining stock"
                }),
                posted = call(BOOK + "post#Revaluation", {
                    previewId: preview.previewId,
                    inputFingerprint: preview.inputFingerprint,
                    operationKey: "CST_REVAL_SPLIT"
                }),
                event = one("mantle.product.asset.AssetBookEvent", {operationKey: "CST_REVAL_SPLIT"})
            return {
                preview,
                posted,
                event: event.getMap(),
                original: one("mantle.product.asset.Asset", {assetId: "CST_STOCK"}).getMap(),
                target: one("mantle.product.asset.Asset", {assetId: event.assetId}).getMap(),
                oldEntries,
                unchanged: find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: oldTx.acctgTransId})
                    .list()
                    .map(r => r.getMap())
            }
        })
    },
    then({preview, posted, event, original, target, oldEntries, unchanged}) {
        preview.quantity == 3
        preview.totalAmount == 3
        event.assetId != "CST_STOCK"
        event.sourceAssetId == "CST_STOCK"
        original.quantityOnHandTotal == 0
        original.acquireCost == 3
        target.quantityOnHandTotal == 3
        target.acquireCost == 4
        target.ownerPartyId == original.ownerPartyId
        oldEntries == unchanged
    }
})
feature("by-product shares allocate the main estimate, quantity is the fallback and only the total is currency-rounded", {
    when() {
        return as("john.doe", () => {
            for (const id of ["CST_BY", "CST_BY_OUT"])
                call("create#mantle.product.Product", {
                    productId: id,
                    ownerPartyId: "CST_ORG",
                    productName: id,
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea"
                })
            const b = call("mantle.product.BomServices.store#Bom", {
                    productId: "CST_BY",
                    organizationPartyId: "CST_ORG",
                    baseQuantity: 2,
                    changeReason: "Co-product costing lot"
                }),
                id = b.productBom.productBomId
            call("mantle.product.BomServices.store#BomItem", {
                productBomId: id,
                productId: "CST_RM",
                quantity: 2,
                changeReason: "Co-product material"
            })
            const by = call("mantle.product.BomServices.store#BomItem", {
                productBomId: id,
                productId: "CST_BY_OUT",
                quantity: 1,
                roleEnumId: "BmirByproduct",
                allocationShare: "0.25",
                changeReason: "Fixed output allocation"
            })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: id,
                expectedRevision: by.expectedRevision,
                changeReason: "Co-product approval"
            })
            const fixed = call(S + "preview#ProductCostRollup", {
                    productId: "CST_BY",
                    organizationPartyId: "CST_ORG",
                    quantity: 2
                }),
                line = call("mantle.product.BomServices.get#BomDetail", {productBomId: id}).bomItemRows.find(
                    r => r.roleEnumId === "BmirByproduct"
                )
            const changed = call("mantle.product.BomServices.store#BomItem", {
                productBomId: id,
                bomItemId: line.bomItemId,
                productId: "CST_BY_OUT",
                quantity: 1,
                roleEnumId: "BmirByproduct",
                allocationShare: null,
                changeReason: "Normalized output quantities"
            })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: id,
                expectedRevision: changed.expectedRevision,
                changeReason: "Quantity allocation approval"
            })
            const proportional = call(S + "preview#ProductCostRollup", {
                productId: "CST_BY",
                organizationPartyId: "CST_ORG",
                quantity: 2
            })
            return {fixed, proportional}
        })
    },
    then({fixed, proportional}) {
        fixed.complete == true
        fixed.standardCost.totalCost == 7.5
        fixed.componentRows[0].costAllocationFactor == 0.75
        fixed.allocationRows.find(r => r.productId === "CST_BY_OUT").amount == 2.5
        proportional.complete == true
        proportional.standardCost.totalCost == 6.67
        toDecimal(proportional.componentRows[0].amount).compare("6.67") < 0
        proportional.allocationRows.every(r => r.allocationBasis === "Normalized quantity")
    }
})
feature("non-phantom requirements use stocked subassemblies and their approved cost while phantoms blow through", {
    when() {
        return as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "CST_PARENT",
                ownerPartyId: "CST_ORG",
                productName: "Cost parent",
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
            const b = call("mantle.product.BomServices.store#Bom", {
                    productId: "CST_PARENT",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Parent planning boundary"
                }),
                id = b.productBom.productBomId,
                l = call("mantle.product.BomServices.store#BomItem", {
                    productBomId: id,
                    productId: "CST_FIN",
                    quantity: 2,
                    changeReason: "Stocked subassembly"
                })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: id,
                expectedRevision: l.expectedRevision,
                changeReason: "Parent method release"
            })
            const full = call("mantle.product.BomServices.get#BomExplosion", {
                    productBomId: id,
                    quantity: 1,
                    fullBlowThrough: true
                }),
                boundary = call("mantle.product.BomServices.get#BomExplosion", {
                    productBomId: id,
                    quantity: 1,
                    facilityId: "CST_FAC"
                }),
                standard = call(S + "preview#ProductCostRollup", {
                    productId: "CST_PARENT",
                    organizationPartyId: "CST_ORG",
                    quantity: 1
                })
            const child = find("mantle.product.bom.ProductBom", {productId: "CST_FIN", organizationPartyId: "CST_ORG"}).one(),
                updated = call("mantle.product.BomServices.store#Bom", {
                    productBomId: child.productBomId,
                    isPhantom: "Y",
                    changeReason: "Blow through phantom"
                })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: child.productBomId,
                expectedRevision: updated.expectedRevision,
                changeReason: "Phantom method approval"
            })
            const phantom = call("mantle.product.BomServices.get#BomExplosion", {
                    productBomId: id,
                    quantity: 1,
                    facilityId: "CST_FAC"
                }),
                rolled = call(S + "preview#ProductCostRollup", {
                    productId: "CST_PARENT",
                    organizationPartyId: "CST_ORG",
                    quantity: 1
                })
            call("mantle.work.RoutingServices.store#WorkCenter", {
                organizationPartyId: "CST_ORG",
                facilityId: "CST_FAC",
                efficiencyPercent: 50,
                changeReason: "Explicit costing efficiency"
            })
            const stale = invoke(S + "save#ProductCostRollup", {
                    calculationId: rolled.calculationId,
                    inputFingerprint: rolled.inputFingerprint,
                    changeReason: "Changed efficiency refused"
                }),
                efficient = call(S + "preview#ProductCostRollup", {
                    productId: "CST_PARENT",
                    organizationPartyId: "CST_ORG",
                    quantity: 1
                })
            return {boundary, standard, phantom, rolled, stale, efficient, full}
        })
    },
    then({boundary, standard, phantom, rolled, stale, efficient, full}) {
        full.requirements[0].productId == "CST_RM"
        boundary.explosionRows.some(r => r.depth === 2)
        boundary.requirements.length == 1
        boundary.requirements[0].productId == "CST_FIN"
        boundary.requirements[0].quantity == 2
        boundary.buildableQuantity == 1.5
        standard.complete == true
        standard.standardCost.totalCost == 8
        standard.componentRows.length == 1
        phantom.requirements.length == 1
        phantom.requirements[0].productId == "CST_RM"
        phantom.requirements[0].quantity == 4.4
        phantom.buildableQuantity == 0
        rolled.complete == true
        rolled.standardCost.totalCost == 34
        stale.error.includes("changed")
        efficient.complete == true
        efficient.standardCost.totalCost == 46
    }
})
feature("intercompany sales leave receipt acquisition at the transfer price instead of the seller standard", {
    when() {
        return as("john.doe", () => {
            call("create#mantle.order.OrderHeader", {orderId: "CST_INTERCO", currencyUomId: "USD", statusId: "OrderOpen"})
            call("create#mantle.order.OrderPart", {
                orderId: "CST_INTERCO",
                orderPartSeqId: "01",
                vendorPartyId: "CST_ORG",
                customerPartyId: "CST_OTHER",
                statusId: "OrderOpen"
            })
            const created = call("mantle.order.OrderServices.create#OrderItem", {
                    orderId: "CST_INTERCO",
                    orderPartSeqId: "01",
                    productId: "CST_FIN",
                    quantity: 1,
                    quantityUomId: "OTH_ea",
                    unitAmount: 20
                }),
                item = one("mantle.order.OrderItem", {orderId: "CST_INTERCO", orderItemSeqId: created.orderItemSeqId})
            call("create#mantle.facility.Facility", {
                facilityId: "CST_OTHER_FAC",
                ownerPartyId: "CST_OTHER",
                facilityTypeEnumId: "FcTpWarehouse"
            })
            const receipt = call("mantle.product.AssetServices.receive#Asset", {
                productId: "CST_FIN",
                quantity: 1,
                assetTypeEnumId: "AstTpInventory",
                facilityId: "CST_OTHER_FAC",
                orderId: "CST_INTERCO",
                orderItemSeqId: created.orderItemSeqId
            })
            return {item: item.getMap(), asset: one("mantle.product.asset.Asset", {assetId: receipt.assetId}).getMap()}
        })
    },
    then({item, asset}) {
        item.standardCost == null
        item.productStandardCostId == null
        asset.acquireCost == 20
        asset.ownerPartyId == "CST_OTHER"
    }
})
feature("a custom role with shared permissions estimates costs without any application role", {
    when() {
        return as("john.doe", () => {
            call("create#moqui.security.UserGroup", {userGroupId: "CST_PERMISSION_ONLY"})
            for (const permission of ["PRODUCT_COST_VIEW", "PRODUCT_COST_ESTIMATE"])
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId: "CST_PERMISSION_ONLY",
                    userPermissionId: permission,
                    fromDate: "2000-01-01T00:00:00Z"
                })
            call("delete#moqui.security.UserGroupMember", {
                userId: "CST_WRITER",
                userGroupId: "NATIVE_COST_ESTIMATE",
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#moqui.security.UserGroupMember", {
                userId: "CST_WRITER",
                userGroupId: "CST_PERMISSION_ONLY",
                fromDate: "2000-01-01T00:00:00Z"
            })
            return as("cst_writer", () => {
                const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_RM",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Application-neutral permission proof"
                })
                return {
                    d,
                    permission: ec.user.hasPermission("PRODUCT_COST_ESTIMATE"),
                    originalRole: ec.user.isInGroup("NATIVE_COST_ESTIMATE")
                }
            })
        })
    },
    then({d, permission, originalRole}) {
        permission == true
        originalRole == false
        d.standardCost.state == "draft"
        d.costAccess.edit == true
    }
})
feature("revaluation refuses future and pre-movement dates, negative stock, and a flag disabled after preview", {
    when() {
        return as("john.doe", () => {
            const draft = as("cst_writer", () => {
                const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_FIN",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Guard review estimate"
                })
                return call(S + "store#StandardCostComponent", {
                    productStandardCostId: d.standardCost.productStandardCostId,
                    quantity: 1,
                    quantityUomId: "OTH_ea",
                    rateAmount: 5,
                    changeReason: "Guard review cost"
                })
            })
            as("cst_approver", () =>
                call(S + "approve#ProductStandardCost", {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    expectedRevision: draft.estimateRevision,
                    changeReason: "Independent guard review approval"
                })
            )
            const args = {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Guarded revaluation"
                },
                future = invoke(
                    BOOK + "preview#Revaluation",
                    Object.assign({}, args, {eventDate: new Date(Date.now() + 60000).toISOString()})
                )
            const ledger = call("mantle.ledger.LedgerServices.create#AcctgTrans", {
                organizationPartyId: "CST_ORG",
                acctgTransTypeEnumId: "AttInventoryIssuance",
                transactionDate: ec.user.nowTimestamp,
                amountUomId: "USD"
            })
            for (const [account, flag] of [
                ["CST_REVAL", "D"],
                ["CST_INV", "C"]
            ])
                call("mantle.ledger.LedgerServices.create#AcctgTransEntry", {
                    acctgTransId: ledger.acctgTransId,
                    productId: "CST_FIN",
                    amount: 1,
                    debitCreditFlag: flag,
                    glAccountId: account
                })
            call("mantle.ledger.LedgerServices.post#AcctgTrans", {acctgTransId: ledger.acctgTransId})
            const late = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: ledger.acctgTransId}),
                before = invoke(
                    BOOK + "preview#Revaluation",
                    Object.assign({}, args, {eventDate: new Date(Number(String(late.transactionDate)) - 1).toISOString()})
                )
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: -1})
            const negative = call(BOOK + "preview#Revaluation", args)
            call("update#mantle.product.asset.Asset", {assetId: "CST_STOCK", quantityOnHandTotal: 0})
            const p = call(BOOK + "preview#Revaluation", args),
                ledgerBefore = find("mantle.ledger.transaction.AcctgTrans").count()
            call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: "CST_ORG",
                inventoryRevaluationEnabled: "N"
            })
            const disabled = invoke(BOOK + "post#Revaluation", {
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "CST_DISABLED_POST"
            })
            call("update#mantle.ledger.config.PartyAcctgPreference", {
                organizationPartyId: "CST_ORG",
                inventoryRevaluationEnabled: "Y"
            })
            return {
                future,
                before,
                negative,
                disabled,
                ledgerBefore,
                ledgerAfter: find("mantle.ledger.transaction.AcctgTrans").count(),
                operation: one("mantle.ledger.transaction.PostingOperation", {operationKey: "CST_DISABLED_POST"})
            }
        })
    },
    then({future, before, negative, disabled, ledgerBefore, ledgerAfter, operation}) {
        future.error.includes("future")
        before.error.includes("last posted movement")
        negative.complete == false
        negative.findings.some(r => r.message.includes("Negative"))
        disabled.error.includes("disabled")
        ledgerAfter == ledgerBefore
        operation == null
    }
})
feature("a partly issued asset split carries outstanding reservations and preserves available quantity", {
    when() {
        return as("john.doe", () => {
            const previous = one("mantle.product.asset.AssetBookEvent", {operationKey: "CST_REVAL_SPLIT"}),
                assetId = previous.assetId
            call("create#mantle.order.OrderHeader", {orderId: "CST_RESERVE", currencyUomId: "USD", statusId: "OrderOpen"})
            call("create#mantle.order.OrderPart", {
                orderId: "CST_RESERVE",
                orderPartSeqId: "01",
                vendorPartyId: "CST_ORG",
                customerPartyId: "CST_SUPPLIER",
                statusId: "OrderOpen"
            })
            const item = call("mantle.order.OrderServices.create#OrderItem", {
                    orderId: "CST_RESERVE",
                    orderPartSeqId: "01",
                    productId: "CST_FIN",
                    quantity: 1,
                    unitAmount: 20,
                    quantityUomId: "OTH_ea"
                }),
                reservation = call("create#mantle.product.issuance.AssetReservation", {
                    assetId,
                    productId: "CST_FIN",
                    orderId: "CST_RESERVE",
                    orderItemSeqId: item.orderItemSeqId,
                    quantity: 1,
                    quantityNotIssued: 1,
                    quantityNotAvailable: 0
                })
            call("create#mantle.product.asset.AssetDetail", {
                assetId,
                productId: "CST_FIN",
                assetReservationId: reservation.assetReservationId,
                effectiveDate: ec.user.nowTimestamp,
                availableToPromiseDiff: -1,
                quantityOnHandDiff: 0
            })
            const issue = call("create#mantle.product.issuance.AssetIssuance", {
                assetId,
                productId: "CST_FIN",
                quantity: 1,
                issuedDate: ec.user.nowTimestamp
            })
            call("create#mantle.product.asset.AssetDetail", {
                assetId,
                productId: "CST_FIN",
                assetIssuanceId: issue.assetIssuanceId,
                effectiveDate: ec.user.nowTimestamp,
                quantityOnHandDiff: -1,
                availableToPromiseDiff: -1
            })
            const current = call(S + "get#ApprovedStandardCost", {productId: "CST_FIN", organizationPartyId: "CST_ORG"}),
                p = call(BOOK + "preview#Revaluation", {
                    productStandardCostId: current.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Carry reserved remaining stock"
                })
            call(BOOK + "post#Revaluation", {
                previewId: p.previewId,
                inputFingerprint: p.inputFingerprint,
                operationKey: "CST_RESERVED_SPLIT"
            })
            const event = one("mantle.product.asset.AssetBookEvent", {operationKey: "CST_RESERVED_SPLIT"}),
                target = one("mantle.product.asset.Asset", {assetId: event.assetId}),
                res = one("mantle.product.issuance.AssetReservation", {assetReservationId: reservation.assetReservationId})
            return {
                target: target.getMap(),
                source: one("mantle.product.asset.Asset", {assetId}).getMap(),
                res: res.getMap(),
                event: event.getMap()
            }
        })
    },
    then({target, source, res, event}) {
        source.quantityOnHandTotal == 0
        source.availableToPromiseTotal == 0
        source.acquireCost == 4
        target.quantityOnHandTotal == 2
        target.availableToPromiseTotal == 1
        target.acquireCost == 5
        res.assetId == target.assetId
        res.quantityNotIssued == 1
        event.sourceAssetId == source.assetId
    }
})
feature("an unpriced non-phantom subassembly is rolled first with its own routing and cannot hide missing inputs as zero", {
    when() {
        return as("john.doe", () => {
            for (const id of ["CST_ROLLED_SUB", "CST_ROLLED_ROOT"])
                call("create#mantle.product.Product", {
                    productId: id,
                    ownerPartyId: "CST_ORG",
                    productName: id,
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea"
                })
            const routing = find("mantle.product.bom.ProductBom", {productId: "CST_FIN", organizationPartyId: "CST_ORG"}).one()
                    .routingWorkEffortId,
                sub = call("mantle.product.BomServices.store#Bom", {
                    productId: "CST_ROLLED_SUB",
                    organizationPartyId: "CST_ORG",
                    baseQuantity: 10,
                    routingWorkEffortId: routing,
                    changeReason: "Unpriced assembly costing lot"
                }),
                line = call("mantle.product.BomServices.store#BomItem", {
                    productBomId: sub.productBom.productBomId,
                    productId: "CST_RM",
                    quantity: 10,
                    changeReason: "Assembly material"
                })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: sub.productBom.productBomId,
                expectedRevision: line.expectedRevision,
                changeReason: "Unpriced assembly release"
            })
            const parent = call("mantle.product.BomServices.store#Bom", {
                    productId: "CST_ROLLED_ROOT",
                    organizationPartyId: "CST_ORG",
                    changeReason: "Low-level roll-up root"
                }),
                required = call("mantle.product.BomServices.store#BomItem", {
                    productBomId: parent.productBom.productBomId,
                    productId: "CST_ROLLED_SUB",
                    quantity: 3,
                    changeReason: "Consume unpriced assembly"
                })
            call("mantle.product.BomServices.release#BomDraft", {
                productBomId: parent.productBom.productBomId,
                expectedRevision: required.expectedRevision,
                changeReason: "Low-level parent release"
            })
            const complete = call(S + "preview#ProductCostRollup", {
                    productId: "CST_ROLLED_ROOT",
                    organizationPartyId: "CST_ORG"
                }),
                missing = call(S + "preview#ProductCostRollup", {
                    productId: "CST_ROLLED_ROOT",
                    organizationPartyId: "CST_ORG",
                    materialBasis: "average",
                    overheadBasis: "percent",
                    overheadPercent: 10
                })
            return {complete, missing}
        })
    },
    then({complete, missing}) {
        complete.complete == true
        complete.standardCost.totalCost == 51
        complete.componentRows.length == 1
        complete.componentRows[0].sourceEntityName == "mantle.product.bom.ProductBom"
        complete.componentRows[0].amount == 51
        missing.complete == false
        missing.standardCost.unitCost == null
        missing.componentRows[0].amount == null
        missing.componentRows.filter(r => r.componentTypeEnumId === "PccOverheadPercent").every(r => r.amount == null)
    }
})
feature("a forward unit-cost change below one ledger currency unit still applies with one rounded ledger transaction", {
    when() {
        return as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "CST_TINY",
                ownerPartyId: "CST_ORG",
                productName: "Precise forward cost",
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
            call("create#mantle.product.asset.Asset", {
                assetId: "CST_TINY_STOCK",
                productId: "CST_TINY",
                ownerPartyId: "CST_ORG",
                assetTypeEnumId: "AstTpInventory",
                facilityId: "CST_FAC",
                quantityOnHandTotal: 1,
                availableToPromiseTotal: 1,
                acquireCost: 5,
                acquireCostUomId: "USD"
            })
            const draft = as("cst_writer", () => {
                const d = call(S + "store#ProductStandardCost", {
                    productId: "CST_TINY",
                    organizationPartyId: "CST_ORG",
                    quantity: 10,
                    changeReason: "Precise batch estimate"
                })
                return call(S + "store#StandardCostComponent", {
                    productStandardCostId: d.standardCost.productStandardCostId,
                    quantity: 10,
                    quantityUomId: "OTH_ea",
                    rateAmount: "5.001",
                    changeReason: "Precise unit input"
                })
            })
            as("cst_approver", () =>
                call(S + "approve#ProductStandardCost", {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    expectedRevision: draft.estimateRevision,
                    changeReason: "Precise batch approval"
                })
            )
            const p = call(BOOK + "preview#Revaluation", {
                    productStandardCostId: draft.standardCost.productStandardCostId,
                    organizationPartyId: "CST_ORG",
                    changeReason: "Apply precise forward unit cost"
                }),
                posted = call(BOOK + "post#Revaluation", {
                    previewId: p.previewId,
                    inputFingerprint: p.inputFingerprint,
                    operationKey: "CST_TINY_REVAL"
                }),
                transaction = one("mantle.ledger.transaction.AcctgTrans", {acctgTransId: posted.acctgTransId}),
                entries = find("mantle.ledger.transaction.AcctgTransEntry", {acctgTransId: posted.acctgTransId}).list()
            return {
                p,
                transaction: transaction.getMap(),
                entries: entries.map(r => r.getMap()),
                asset: one("mantle.product.asset.Asset", {assetId: "CST_TINY_STOCK"}).getMap()
            }
        })
    },
    then({p, transaction, entries, asset}) {
        p.totalAmount == 0
        p.bookRows[0].newUnitCost == 5.001
        asset.acquireCost == 5.001
        asset.quantityOnHandTotal == 1
        transaction.isPosted == "Y"
        entries.length == 2
        entries.every(r => toDecimal(r.amount).isZero())
    }
})
feature("operation cycles round up within the BOM costing lot before its cost is allocated to the estimate quantity", {
    when() {
        return as("john.doe", () => {
            const R = "mantle.work.RoutingServices.",
                r = call(R + "store#Routing", {
                    organizationPartyId: "CST_ORG",
                    workEffortName: "Three units per cycle",
                    changeReason: "Costing lot cycles"
                }),
                id = r.routing.workEffortId,
                op = call(R + "store#RoutingOperation", {
                    workEffortId: id,
                    workEffortName: "Three-unit cycle",
                    estimatedSetupTime: 1,
                    estimatedWorkTime: 1,
                    methodBatchQuantity: 3,
                    methodQuantityUomId: "OTH_ea",
                    timeUomId: "TF_hr",
                    methodWorkCenterId: "CST_FAC",
                    changeReason: "Explicit cycle capacity"
                })
            call(R + "release#RoutingDraft", {
                workEffortId: id,
                expectedRevision: op.expectedRevision,
                changeReason: "Release cycle standards"
            })
            const cost = q =>
                call(R + "get#OperationCostBasis", {
                    workEffortId: id,
                    quantity: q,
                    quantityUomId: "OTH_ea",
                    costingLotQuantity: 10,
                    costingLotUomId: "OTH_ea",
                    applyEfficiency: true,
                    componentTypeEnumIds: ["PccLabor"]
                })
            return {half: cost(5), whole: cost(10)}
        })
    },
    then({half, whole}) {
        half.complete == true
        whole.complete == true
        half.operationCostRows[0].hours == 5
        whole.operationCostRows[0].hours == 10
        toDecimal(half.operationCostRows[0].amount).multiply(2).compare(whole.operationCostRows[0].amount) == 0
    }
})
