const S = "mantle.product.CatalogCheckServices.",
    one = (n, p) => ec.entity.find(n).condition(p).disableAuthz().one()
function as(user, fn) {
    login(user)
    const disabled = ec.artifactExecution.disableAuthz()
    try {
        return fn()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
function invoke(n, p) {
    try {
        const result = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, result, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
spec({
    setupSpec() {
        as("john.doe", () => {
            for (const org of ["CHK_ORG", "CHK_FOREIGN"]) {
                call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: org, organizationName: org})
                call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
            }
            for (const [id, permissions] of [
                ["CHK_READER", ["PRODUCT_CATALOG_VIEW"]],
                ["CHK_EDITOR", ["PRODUCT_CATALOG_EDIT"]],
                ["CHK_ALL", ["PRODUCT_CATALOG_VIEW", "PRICE_VIEW", "PRODUCT_COST_VIEW"]]
            ]) {
                call("create#moqui.security.UserGroup", {userGroupId: id})
                for (const permission of permissions)
                    call("create#moqui.security.UserGroupPermission", {
                        userGroupId: id,
                        userPermissionId: permission,
                        fromDate: "2000-01-01T00:00:00Z"
                    })
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: "2000-01-01T00:00:00Z"})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "CHK_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const id of ["CHK_EMPTY", "CHK_GOOD", "CHK_DUP", "CHK_KIT", "CHK_KIT_CHILD", "CHK_CURRENCY", "CHK_HIDDEN"])
                call("create#mantle.product.Product", {
                    productId: id,
                    productName: id === "CHK_EMPTY" ? null : id === "CHK_HIDDEN" ? "UNREADABLE_SENTINEL" : id,
                    ownerPartyId: id === "CHK_HIDDEN" ? "CHK_FOREIGN" : "CHK_ORG",
                    productTypeEnumId: id.includes("KIT") ? "PtPickAssembly" : "PtAsset",
                    amountUomId: id === "CHK_CURRENCY" ? "USD" : "OTH_ea",
                    statusId: "PrdDraft"
                })
            for (const id of ["CHK_GOOD", "CHK_DUP"])
                call("create#mantle.product.ProductIdentification", {
                    productId: id,
                    productIdTypeEnumId: "PidtSku",
                    idValue: "CHK-DUPLICATE"
                })
            for (const [from, to] of [
                ["CHK_KIT", "CHK_KIT_CHILD"],
                ["CHK_KIT_CHILD", "CHK_KIT"]
            ])
                call("create#mantle.product.ProductAssoc", {
                    productId: from,
                    toProductId: to,
                    productAssocTypeEnumId: "PatMfgBom",
                    quantity: 1,
                    fromDate: "2000-01-01T00:00:00Z"
                })
            for (const id of ["CHK_CAT_A", "CHK_CAT_B"])
                call("create#mantle.product.category.ProductCategory", {
                    productCategoryId: id,
                    categoryName: id,
                    ownerPartyId: "CHK_ORG",
                    productCategoryTypeEnumId: "PctCatalog"
                })
            for (const [a, b] of [
                ["CHK_CAT_A", "CHK_CAT_B"],
                ["CHK_CAT_B", "CHK_CAT_A"]
            ])
                call("create#mantle.product.category.ProductCategoryRollup", {
                    productCategoryId: a,
                    parentProductCategoryId: b,
                    fromDate: "2000-01-01T00:00:00Z"
                })
            call("create#mantle.product.category.ProductCategoryMember", {
                productCategoryId: "CHK_CAT_A",
                productId: "CHK_GOOD",
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#mantle.product.ProductDimension", {
                productId: "CHK_GOOD",
                dimensionTypeId: "QuantityIncluded",
                value: 12,
                uomId: "OTH_ea"
            })
            for (const id of ["CHK_PRICE_A", "CHK_PRICE_B"])
                call("create#mantle.product.ProductPrice", {
                    productPriceId: id,
                    productId: "CHK_GOOD",
                    vendorPartyId: "CHK_ORG",
                    priceTypeEnumId: "PptCurrent",
                    price: 5,
                    priceUomId: "USD",
                    quantityUomId: "OTH_ea",
                    fromDate: "2000-01-01T00:00:00Z"
                })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("independent checks report required data, identifiers, units, category and kit cycles with evidence and no writes", {
    when() {
        return as("chk_reader", () => {
            const before = ec.entity.find("moqui.entity.EntityAuditLog").disableAuthz().count(),
                report = call(S + "validate#Catalog", {
                    productIds: ["CHK_EMPTY", "CHK_GOOD", "CHK_KIT", "CHK_CURRENCY", "CHK_HIDDEN", "DOES_NOT_EXIST"]
                }),
                after = ec.entity.find("moqui.entity.EntityAuditLog").disableAuthz().count()
            return {report, before, after}
        })
    },
    then({report, before, after}) {
        report.checkedCount == 4
        report.valid == false
        report.issueRows.some(r => r.checkId === "requiredFields" && r.evidence.includes("productName"))
        report.issueRows.some(r => r.checkId === "identifiers" && r.evidence.includes("assigned"))
        report.issueRows.some(r => r.checkId === "conversions")
        report.issueRows.some(r => r.checkId === "categoryCycles" && r.evidence.includes("Cycle"))
        report.issueRows.some(r => r.checkId === "kitCycles" && r.evidence.includes("Cycle"))
        report.issueRows.some(r => r.checkId === "legacyPacks" && r.severity === "warning" && r.evidence.includes("12"))
        !JSON.stringify(report).includes("UNREADABLE_SENTINEL")
        before == after
    }
})
feature("price and cost checks require their own permissions and expose only readable source evidence", {
    when() {
        return {
            reader: as("chk_reader", () =>
                invoke(S + "validate#Catalog", {productIds: ["CHK_GOOD"], checkIds: ["prices", "estimates"]})
            ),
            all: as("chk_all", () =>
                call(S + "validate#Catalog", {productIds: ["CHK_GOOD", "CHK_EMPTY"], checkIds: ["prices", "estimates"]})
            )
        }
    },
    then({reader, all}) {
        reader.error.includes("authority")
        all.issueRows.some(r => r.checkId === "prices" && r.evidence.includes("CHK_PRICE_A"))
        all.issueRows.some(r => r.checkId === "prices" && r.evidence.includes("No effective"))
        all.issueRows.some(r => r.checkId === "estimates")
        !JSON.stringify(all).includes('price":5')
    }
})
feature("proposed rows use dated required fields without creating products and cannot override a foreign owner", {
    when() {
        return as("chk_editor", () => {
            const before = ec.entity.find("mantle.product.Product").disableAuthz().count(),
                report = call(S + "validate#Catalog", {
                    productIds: [],
                    candidateProducts: [
                        {productId: "CHK_NEW", ownerPartyId: "CHK_ORG", productTypeEnumId: "PtAsset", amountUomId: "OTH_ea"},
                        {productId: "CHK_HIDDEN", ownerPartyId: "CHK_ORG", productName: "FORGED"}
                    ],
                    checkIds: ["requiredFields"]
                }),
                after = ec.entity.find("mantle.product.Product").disableAuthz().count()
            return {report, before, after}
        })
    },
    then({report, before, after}) {
        report.checkedCount == 1
        report.issueRows.some(r => r.productId === "CHK_NEW" && r.evidence.includes("productName"))
        report.issueRows.some(r => r.productId === "CHK_HIDDEN" && r.checkId === "record")
        before == after
    }
})
feature("a single-record retry and an effective category selection leave independent checks available", {
    when() {
        return as("chk_reader", () => ({
            retry: call(S + "validate#Catalog", {productIds: ["CHK_GOOD"], checkIds: ["legacyPacks"]}),
            category: call(S + "validate#Catalog", {
                productCategoryId: "CHK_CAT_A",
                includeDescendants: true,
                checkIds: ["requiredFields"]
            }),
            denied: invoke(S + "validate#Catalog", {
                productIds: [],
                candidateProducts: [{productId: "CHK_NEW", ownerPartyId: "CHK_ORG"}]
            })
        }))
    },
    then({retry, category, denied}) {
        retry.checkedCount == 1
        retry.issueRows.every(r => r.checkId === "legacyPacks")
        category.checkedCount == 1
        denied.error.includes("edit authority")
    }
})
feature("legacy variants and case-priced offers are reported and dated catalog requirements use the requested date", {
    when() {
        as("john.doe", () => {
            for (const id of ["CHK_VIRTUAL", "CHK_VARIANT_A", "CHK_VARIANT_B"])
                call("create#mantle.product.Product", {
                    productId: id,
                    productName: id,
                    ownerPartyId: "CHK_ORG",
                    productTypeEnumId: id === "CHK_VIRTUAL" ? "PtVirtual" : "PtAsset",
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.product.feature.ProductFeature", {
                productFeatureId: "CHK_BLUE",
                description: "Blue",
                productFeatureTypeEnumId: "PftColor",
                ownerPartyId: "CHK_ORG"
            })
            for (const id of ["CHK_VARIANT_A", "CHK_VARIANT_B"]) {
                call("create#mantle.product.ProductAssoc", {
                    productId: "CHK_VIRTUAL",
                    toProductId: id,
                    productAssocTypeEnumId: "PatVariant",
                    fromDate: "2000-01-01T00:00:00Z"
                })
                call("create#mantle.product.feature.ProductFeatureAppl", {
                    productId: id,
                    productFeatureId: "CHK_BLUE",
                    applTypeEnumId: "PfatDistinguishing",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            call("create#moqui.basic.Uom", {
                uomId: "CHK_CASE_UNIT",
                uomTypeEnumId: "UT_OTHER_MEASURE",
                description: "Legacy case unit"
            })
            call("create#mantle.product.ProductPrice", {
                productPriceId: "CHK_CASE_PRICE",
                productId: "CHK_GOOD",
                vendorPartyId: "CHK_ORG",
                priceTypeEnumId: "PptList",
                price: 60,
                priceUomId: "USD",
                quantityUomId: "CHK_CASE_UNIT",
                fromDate: "2000-01-01T00:00:00Z"
            })
            call("create#mantle.product.ProductCatalogSetting", {
                organizationPartyId: "CHK_ORG",
                fromDate: "2027-01-01T00:00:00Z",
                requiredFields: "productName,description"
            })
        })
        return as("chk_all", () => ({
            variants: call(S + "validate#Catalog", {productIds: ["CHK_VARIANT_A"], checkIds: ["variants"]}),
            cases: call(S + "validate#Catalog", {productIds: ["CHK_GOOD"], checkIds: ["caseUnits"]}),
            before: call(S + "validate#Catalog", {
                productIds: ["CHK_GOOD"],
                checkIds: ["requiredFields"],
                asOfDate: "2026-01-01T00:00:00Z"
            }),
            future: call(S + "validate#Catalog", {
                productIds: ["CHK_GOOD"],
                checkIds: ["requiredFields"],
                asOfDate: "2027-01-01T00:00:00Z"
            })
        }))
    },
    then({variants, cases, before, future}) {
        variants.issueRows.some(r => r.evidence.includes("CHK_VARIANT_B"))
        cases.issueRows.some(r => r.evidence.includes("CHK_CASE_PRICE"))
        before.valid == true
        future.issueRows.some(r => r.evidence.includes("description"))
    }
})
feature("a published fixed price-list rule, including zero, satisfies selling-price readiness without a direct price row", {
    when() {
        as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "CHK_LIST_ONLY",
                productName: "Fixed-list product",
                ownerPartyId: "CHK_ORG",
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
            const made = call("mantle.product.PriceServices.store#ProductPriceList", {
                listName: "Check fixed-price readiness",
                organizationPartyId: "CHK_ORG",
                direction: "sales",
                priceUomId: "USD",
                priority: 1000,
                fromDate: "2000-01-01T00:00:00Z",
                changeReason: "Readiness fixture"
            })
            call("mantle.product.PriceServices.store#ProductPriceRule", {
                priceListId: made.priceListId,
                sequenceNum: 10,
                selector: "product",
                productId: "CHK_LIST_ONLY",
                fromDate: "2000-01-01T00:00:00Z",
                baseType: "fixed",
                fixedPrice: 0,
                changeReason: "Zero-price policy"
            })
            const preview = call("mantle.product.PriceServices.get#ProductPriceListPublication", {priceListId: made.priceListId})
            call("mantle.product.PriceServices.publish#ProductPriceList", {
                priceListId: made.priceListId,
                publicationToken: preview.publicationToken,
                changeReason: "Reviewed fixed zero price"
            })
        })
        return as("john.doe", () => call(S + "validate#Catalog", {productIds: ["CHK_LIST_ONLY"], checkIds: ["prices"]}))
    },
    then(report) {
        report.valid == true
        report.issueRows.length == 0
        report.missingPriceCount == 0
    }
})
feature("a broken price-list base is a named independent finding and does not poison later checks or the caller transaction", {
    when() {
        as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "CHK_BAD_RULE",
                productName: "Broken typed base",
                ownerPartyId: "CHK_ORG",
                productTypeEnumId: "PtAsset",
                amountUomId: "OTH_ea"
            })
            const made = call("mantle.product.PriceServices.store#ProductPriceList", {
                listName: "Broken readiness base",
                organizationPartyId: "CHK_ORG",
                direction: "sales",
                priceUomId: "USD",
                priority: 1100,
                fromDate: "2000-01-01T00:00:00Z",
                changeReason: "Legacy missing base"
            })
            call("mantle.product.PriceServices.store#ProductPriceRule", {
                priceListId: made.priceListId,
                sequenceNum: 10,
                selector: "product",
                productId: "CHK_BAD_RULE",
                fromDate: "2000-01-01T00:00:00Z",
                baseType: "typed",
                basePriceTypeEnumId: "PptWholesale",
                changeReason: "Missing base evidence"
            })
            const preview = call("mantle.product.PriceServices.get#ProductPriceListPublication", {priceListId: made.priceListId})
            call("mantle.product.PriceServices.publish#ProductPriceList", {
                priceListId: made.priceListId,
                publicationToken: preview.publicationToken,
                changeReason: "Legacy reviewed rule"
            })
        })
        return as("chk_all", () => {
            const report = call(S + "validate#Catalog", {
                    productIds: ["CHK_BAD_RULE", "CHK_EMPTY"],
                    checkIds: ["prices", "requiredFields"]
                }),
                next = call(S + "validate#Catalog", {productIds: ["CHK_GOOD"], checkIds: ["requiredFields"]})
            return {report, next}
        })
    },
    then({report, next}) {
        report.issueRows.some(r => r.productId === "CHK_BAD_RULE" && r.evidence.includes("base"))
        report.issueRows.some(r => r.productId === "CHK_EMPTY" && r.evidence.includes("productName"))
        next.valid == true
        next.checkedCount == 1
    }
})
feature("category cycles remain reportable when the selected category has no products", {
    when() {
        as("john.doe", () => {
            call("create#mantle.product.category.ProductCategory", {
                productCategoryId: "CHK_UNATTACHED",
                categoryName: "Category without products",
                ownerPartyId: "CHK_ORG",
                productCategoryTypeEnumId: "PctCatalog"
            })
            call("create#mantle.product.category.ProductCategoryRollup", {
                productCategoryId: "CHK_UNATTACHED",
                parentProductCategoryId: "CHK_UNATTACHED",
                fromDate: "2000-01-01T00:00:00Z"
            })
        })
        return as("chk_reader", () =>
            call(S + "validate#Catalog", {productCategoryId: "CHK_UNATTACHED", checkIds: ["categoryCycles"]})
        )
    },
    then(report) {
        report.checkedCount == 0
        report.issueRows.some(r => r.productCategoryId === "CHK_UNATTACHED" && r.evidence.includes("Cycle"))
        report.incompleteCount == 0
        report.valid == false
    }
})
