const S = "mantle.product.ProductImportServices.",
    P = "mantle.product.",
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
        const out = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
let mixed, atomic, staleRun, mapped
spec({
    setupSpec() {
        as("john.doe", () => {
            for (const org of ["IMP_ORG", "IMP_FOREIGN"]) {
                call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: org, organizationName: org})
                call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
            }
            for (const [id, permissions] of [
                ["IMP_EDITOR", ["PRODUCT_CATALOG_EDIT"]],
                ["IMP_READER", ["PRODUCT_CATALOG_VIEW"]],
                ["IMP_PRICE", ["PRODUCT_CATALOG_VIEW", "PRICE_EDIT"]],
                ["IMP_SUPPLIER", ["PRODUCT_CATALOG_VIEW", "SUPPLIER_PRICE_EDIT"]]
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
                    toPartyId: "IMP_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            call("create#mantle.party.Party", {
                partyId: "IMP_VENDOR",
                partyTypeEnumId: "PtyOrganization",
                ownerPartyId: "IMP_ORG"
            })
            call("create#mantle.party.PartyRole", {partyId: "IMP_VENDOR", roleTypeId: "Supplier"})
            for (const id of ["IMP_BASE", "IMP_HIDDEN"])
                call("create#" + P + "Product", {
                    productId: id,
                    productName: id === "IMP_HIDDEN" ? "IMPORT_FOREIGN_SENTINEL" : id,
                    ownerPartyId: id === "IMP_HIDDEN" ? "IMP_FOREIGN" : "IMP_ORG",
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea",
                    statusId: "PrdDraft"
                })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("mixed valid and invalid product rows validate without writes and a resumed apply writes each good row once", {
    when() {
        return as("imp_editor", () => {
            const staged = call(S + "stage#CatalogImport", {
                kindId: "products",
                organizationPartyId: "IMP_ORG",
                sourceText:
                    "productId,productName,amountUomId,productIdTypeEnumId,idValue\nIMP_CREATED,Imported product,OTH_ea,PidtSku,IMP-CREATED-CODE\nIMP_BAD,,OTH_ea,,\nIMP_CREATED_TWO,Second product,OTH_ea,,\n"
            })
            mixed = staged.operationKey
            const validated = call(S + "validate#CatalogImport", {operationKey: mixed, mappingRevision: staged.mappingRevision}),
                before = one(P + "Product", {productId: "IMP_CREATED"}),
                applied = call(S + "apply#CatalogImport", {operationKey: mixed, inputFingerprint: validated.inputFingerprint}),
                resumed = call(S + "apply#CatalogImport", {operationKey: mixed, inputFingerprint: validated.inputFingerprint}),
                identifier = one(P + "ProductIdentification", {productId: "IMP_CREATED", productIdTypeEnumId: "PidtSku"}),
                report = call(S + "get#CatalogImportReport", {operationKey: mixed, errorsOnly: true})
            return {validated, before, applied, resumed, identifier, report}
        })
    },
    then({validated, before, applied, resumed, identifier, report}) {
        validated.validCount == 2
        validated.errorCount == 1
        before == null
        applied.appliedCount == 2
        applied.changedRows == 2
        resumed.changedRows == 0
        resumed.appliedCount == 2
        identifier.idValue == "IMP-CREATED-CODE"
        one(P + "Product", {productId: "IMP_BAD"}) == null
        report.reportCsv.includes("IMP_BAD")
        report.reportCsv.includes("Product name is required")
    }
})
feature("explicit value mappings, number and date formats are retained with a mapping revision guard", {
    when() {
        return as("imp_editor", () => {
            const staged = call(S + "stage#CatalogImport", {
                kindId: "products",
                organizationPartyId: "IMP_ORG",
                delimiter: ";",
                sourceText: "Code;Name;Unit\nIMP_MAPPED;Mapped product;each\n"
            })
            mapped = staged.operationKey
            const changed = call(S + "configure#CatalogImport", {
                    operationKey: mapped,
                    mappingRevision: staged.mappingRevision,
                    mapping: {Code: "productId", Name: "productName", Unit: "amountUomId"},
                    valueMappings: {amountUomId: {each: "OTH_ea"}}
                }),
                stale = invoke(S + "configure#CatalogImport", {
                    operationKey: mapped,
                    mappingRevision: staged.mappingRevision,
                    mapping: staged.mapping
                }),
                valid = call(S + "validate#CatalogImport", {operationKey: mapped, mappingRevision: changed.mappingRevision})
            return {changed, stale, valid}
        })
    },
    then({changed, stale, valid}) {
        changed.mapping.Code == "productId"
        changed.valueMappings.amountUomId.each == "OTH_ea"
        stale.error.includes("mapping changed")
        valid.validCount == 1
        valid.importRows[0].values.amountUomId == "OTH_ea"
    }
})
feature("actual role and organization checks protect staging, existing rows, reports and another operators run", {
    when() {
        return {
            reader: as("imp_reader", () =>
                invoke(S + "stage#CatalogImport", {
                    kindId: "products",
                    organizationPartyId: "IMP_ORG",
                    sourceText: "productId,productName\nNO,No\n"
                })
            ),
            other: as("imp_price", () => invoke(S + "get#CatalogImport", {operationKey: mixed})),
            foreign: as("imp_editor", () => {
                const staged = call(S + "stage#CatalogImport", {
                    kindId: "products",
                    organizationPartyId: "IMP_ORG",
                    sourceText: "productId,productName\nIMP_HIDDEN,FORGED\n"
                })
                return call(S + "validate#CatalogImport", {
                    operationKey: staged.operationKey,
                    mappingRevision: staged.mappingRevision
                })
            })
        }
    },
    then({reader, other, foreign}) {
        reader.error.includes("authority")
        other.error.includes("own catalog import")
        foreign.validCount == 0
        foreign.errorCount == 1
        !JSON.stringify(foreign).includes("IMPORT_FOREIGN_SENTINEL")
    }
})
feature("a changed product becomes stale while an independent row applies, and a reviewed retry completes once", {
    when() {
        return as("imp_editor", () => {
            const staged = call(S + "stage#CatalogImport", {
                kindId: "products",
                organizationPartyId: "IMP_ORG",
                sourceText: "productId,productName\nIMP_BASE,Imported new name\nIMP_INDEPENDENT,Independent row\n"
            })
            staleRun = staged.operationKey
            const valid = call(S + "validate#CatalogImport", {operationKey: staleRun, mappingRevision: staged.mappingRevision})
            call("mantle.product.CatalogRecordServices.store#Product", {
                productId: "IMP_BASE",
                productName: "Concurrent product name"
            })
            const partial = call(S + "apply#CatalogImport", {operationKey: staleRun, inputFingerprint: valid.inputFingerprint}),
                preserved = one(P + "Product", {productId: "IMP_BASE"}).productName,
                review = call(S + "validate#CatalogImport", {operationKey: staleRun, mappingRevision: partial.mappingRevision}),
                completed = call(S + "apply#CatalogImport", {operationKey: staleRun, inputFingerprint: review.inputFingerprint})
            return {partial, preserved, completed}
        })
    },
    then({partial, preserved, completed}) {
        partial.appliedCount == 1
        partial.importRows.find(r => r.values?.productId === "IMP_BASE").result == "stale"
        preserved == "Concurrent product name"
        completed.appliedCount == 2
        completed.changedRows == 1
        one(P + "Product", {productId: "IMP_BASE"}).productName == "Imported new name"
    }
})
feature("a failed dependent write rolls back its new product and the same run resumes after repair", {
    when() {
        const original = one(P + "ProductCatalogImportKind", {kindId: "products"}).afterStoreService
        as("john.doe", () =>
            call("update#" + P + "ProductCatalogImportKind", {
                kindId: "products",
                afterStoreService: "mantle.product.CostServices.approve#ProductStandardCost"
            })
        )
        let staged, valid, failed, missing
        try {
            as("imp_editor", () => {
                staged = call(S + "stage#CatalogImport", {
                    kindId: "products",
                    organizationPartyId: "IMP_ORG",
                    sourceText:
                        "productId,productName,productIdTypeEnumId,idValue\nIMP_ATOMIC,Atomic product,PidtSku,IMP-ATOMIC-CODE\n"
                })
                atomic = staged.operationKey
                valid = call(S + "validate#CatalogImport", {operationKey: atomic, mappingRevision: staged.mappingRevision})
                failed = call(S + "apply#CatalogImport", {operationKey: atomic, inputFingerprint: valid.inputFingerprint})
                missing = one(P + "Product", {productId: "IMP_ATOMIC"})
            })
        } finally {
            as("john.doe", () =>
                call("update#" + P + "ProductCatalogImportKind", {kindId: "products", afterStoreService: original})
            )
        }
        return as("imp_editor", () => {
            const reviewed = call(S + "validate#CatalogImport", {operationKey: atomic, mappingRevision: failed.mappingRevision}),
                retried = call(S + "apply#CatalogImport", {operationKey: atomic, inputFingerprint: reviewed.inputFingerprint}),
                again = call(S + "apply#CatalogImport", {operationKey: atomic, inputFingerprint: reviewed.inputFingerprint})
            return {failed, missing, retried, again}
        })
    },
    then({failed, missing, retried, again}) {
        failed.errorCount == 1
        failed.appliedCount == 0
        missing == null
        retried.appliedCount == 1
        again.changedRows == 0
        one(P + "ProductIdentification", {productId: "IMP_ATOMIC", productIdTypeEnumId: "PidtSku"}).idValue == "IMP-ATOMIC-CODE"
    }
})
feature("empty cells preserve existing values and only reviewed optional text clears delete a value", {
    when() {
        return as("imp_editor", () => {
            call("mantle.product.CatalogRecordServices.store#Product", {
                productId: "IMP_BASE",
                description: "Keep this description"
            })
            const sourceText = "productId,description\nIMP_BASE,\n",
                staged = call(S + "stage#CatalogImport", {kindId: "products", organizationPartyId: "IMP_ORG", sourceText}),
                valid = call(S + "validate#CatalogImport", {
                    operationKey: staged.operationKey,
                    mappingRevision: staged.mappingRevision
                })
            call(S + "apply#CatalogImport", {operationKey: staged.operationKey, inputFingerprint: valid.inputFingerprint})
            const preserved = one(P + "Product", {productId: "IMP_BASE"}).description,
                next = call(S + "stage#CatalogImport", {
                    kindId: "products",
                    organizationPartyId: "IMP_ORG",
                    sourceText,
                    forceNew: true
                }),
                mapped = call(S + "configure#CatalogImport", {
                    operationKey: next.operationKey,
                    mappingRevision: next.mappingRevision,
                    clearFields: ["description"]
                }),
                reviewed = call(S + "validate#CatalogImport", {
                    operationKey: next.operationKey,
                    mappingRevision: mapped.mappingRevision
                })
            call(S + "apply#CatalogImport", {operationKey: next.operationKey, inputFingerprint: reviewed.inputFingerprint})
            return {preserved, reviewed, after: one(P + "Product", {productId: "IMP_BASE"}).description}
        })
    },
    then({preserved, reviewed, after}) {
        preserved == "Keep this description"
        reviewed.importRows[0].changes.some(r => r.field === "description" && r.after == null)
        after == null
    }
})
feature("sales and supplier price adapters use their own grants, selected party roles and explicit number/date mappings", {
    when() {
        const sale = as("imp_price", () => {
                const staged = call(S + "stage#CatalogImport", {
                        kindId: "prices",
                        organizationPartyId: "IMP_ORG",
                        delimiter: ";",
                        sourceText: "productId;price;priceUomId;fromDate\nIMP_BASE;1.234,50;USD;03/11/2027\n"
                    }),
                    mapped = call(S + "configure#CatalogImport", {
                        operationKey: staged.operationKey,
                        mappingRevision: staged.mappingRevision,
                        numberFormat: {decimal: ",", group: "."},
                        dateFormat: "dd/MM/yyyy"
                    }),
                    valid = call(S + "validate#CatalogImport", {
                        operationKey: staged.operationKey,
                        mappingRevision: mapped.mappingRevision
                    }),
                    applied = call(S + "apply#CatalogImport", {
                        operationKey: staged.operationKey,
                        inputFingerprint: valid.inputFingerprint
                    })
                return {valid, applied}
            }),
            purchase = as("imp_supplier", () => {
                const staged = call(S + "stage#CatalogImport", {
                        kindId: "supplierPrices",
                        organizationPartyId: "IMP_ORG",
                        sourceText:
                            "productId,vendorPartyId,price,priceUomId\nIMP_BASE,IMP_VENDOR,9.50,USD\nIMP_BASE,IMP_ORG,99,USD\n"
                    }),
                    valid = call(S + "validate#CatalogImport", {
                        operationKey: staged.operationKey,
                        mappingRevision: staged.mappingRevision
                    }),
                    applied = call(S + "apply#CatalogImport", {
                        operationKey: staged.operationKey,
                        inputFingerprint: valid.inputFingerprint
                    })
                return {valid, applied}
            })
        return {sale, purchase}
    },
    then({sale, purchase}) {
        sale.valid.validCount == 1
        sale.applied.appliedCount == 1
        toDecimal(sale.valid.importRows[0].values.price).compare("1234.50") === 0
        sale.valid.importRows[0].values.fromDate.includes("2027-11-03")
        purchase.valid.validCount == 1
        purchase.valid.errorCount == 1
        purchase.applied.appliedCount == 1
        const price = one(P + "ProductPrice", {
            productPriceId: purchase.applied.importRows.find(r => r.result === "applied").resultRecordId
        })
        price.vendorPartyId == "IMP_VENDOR"
        price.customerPartyId == "IMP_ORG"
        price.pricePurposeEnumId == "PppPurchase"
    }
})
feature("price conflicts within a staged file are excluded while independent tiers for the same product apply together", {
    when() {
        return as("imp_price", () => {
            const staged = call(S + "stage#CatalogImport", {
                    kindId: "prices",
                    organizationPartyId: "IMP_ORG",
                    sourceText:
                        "productId,price,priceUomId,minQuantity,fromDate,thruDate\nIMP_BASE,20,USD,1,2028-01-01,2028-12-31\nIMP_BASE,21,USD,1,2028-06-01,2029-06-01\nIMP_BASE,15,USD,10,2028-01-01,2028-12-31\nIMP_BASE,10,USD,20,2028-01-01,2028-12-31\n"
                }),
                valid = call(S + "validate#CatalogImport", {
                    operationKey: staged.operationKey,
                    mappingRevision: staged.mappingRevision
                }),
                applied = call(S + "apply#CatalogImport", {
                    operationKey: staged.operationKey,
                    inputFingerprint: valid.inputFingerprint
                })
            return {valid, applied}
        })
    },
    then({valid, applied}) {
        valid.validCount == 2
        valid.errorCount == 2
        valid.importRows.filter(r => r.result === "invalid").every(r => r.errorMessage.includes("overlapping"))
        applied.appliedCount == 2
        applied.changedRows == 2
        applied.importRows.filter(r => r.result === "applied").length == 2
    }
})
feature("category and feature assignment rows for one product remain independent and reject overlapping dated duplicates", {
    when() {
        as("john.doe", () => {
            for (const id of ["IMP_CATEGORY_A", "IMP_CATEGORY_B"])
                call("create#mantle.product.category.ProductCategory", {
                    productCategoryId: id,
                    categoryName: id,
                    ownerPartyId: "IMP_ORG",
                    productCategoryTypeEnumId: "PctCatalog"
                })
            for (const id of ["IMP_FEATURE_A", "IMP_FEATURE_B"])
                call("create#mantle.product.feature.ProductFeature", {
                    productFeatureId: id,
                    description: id,
                    ownerPartyId: "IMP_ORG",
                    productFeatureTypeEnumId: "PftColor"
                })
        })
        return as("imp_editor", () => {
            const category = call(S + "stage#CatalogImport", {
                    kindId: "categories",
                    organizationPartyId: "IMP_ORG",
                    sourceText: "productId,productCategoryId\nIMP_BASE,IMP_CATEGORY_A\nIMP_BASE,IMP_CATEGORY_B\n"
                }),
                checked = call(S + "validate#CatalogImport", {
                    operationKey: category.operationKey,
                    mappingRevision: category.mappingRevision
                }),
                categories = call(S + "apply#CatalogImport", {
                    operationKey: category.operationKey,
                    inputFingerprint: checked.inputFingerprint
                }),
                feature = call(S + "stage#CatalogImport", {
                    kindId: "features",
                    organizationPartyId: "IMP_ORG",
                    sourceText:
                        "productId,productFeatureId,applTypeEnumId\nIMP_BASE,IMP_FEATURE_A,PfatStandard\nIMP_BASE,IMP_FEATURE_B,PfatStandard\n"
                }),
                valid = call(S + "validate#CatalogImport", {
                    operationKey: feature.operationKey,
                    mappingRevision: feature.mappingRevision
                }),
                features = call(S + "apply#CatalogImport", {
                    operationKey: feature.operationKey,
                    inputFingerprint: valid.inputFingerprint
                }),
                overlap = invoke("mantle.product.CatalogRecordServices.store#CatalogRow", {
                    kind: "category",
                    productId: "IMP_BASE",
                    productCategoryId: "IMP_CATEGORY_A",
                    fromDate: "2030-01-01T00:00:00Z"
                })
            return {categories, features, overlap}
        })
    },
    then({categories, features, overlap}) {
        categories.appliedCount == 2
        features.appliedCount == 2
        overlap.error.includes("overlaps")
    }
})
feature("permissions are rechecked before apply and an old validation token cannot bypass a changed mapping", {
    when() {
        let run, valid
        as("imp_editor", () => {
            run = call(S + "stage#CatalogImport", {
                kindId: "products",
                organizationPartyId: "IMP_ORG",
                sourceText: "productId,productName\nIMP_ROLE_RECHECK,Role checked row\n"
            })
            valid = call(S + "validate#CatalogImport", {operationKey: run.operationKey, mappingRevision: run.mappingRevision})
        })
        as("john.doe", () =>
            ec.entity
                .find("moqui.security.UserGroupPermission")
                .condition({userGroupId: "IMP_EDITOR", userPermissionId: "PRODUCT_CATALOG_EDIT"})
                .disableAuthz()
                .deleteAll()
        )
        let denied
        try {
            denied = as("imp_editor", () =>
                invoke(S + "apply#CatalogImport", {operationKey: run.operationKey, inputFingerprint: valid.inputFingerprint})
            )
        } finally {
            as("john.doe", () =>
                call("create#moqui.security.UserGroupPermission", {
                    userGroupId: "IMP_EDITOR",
                    userPermissionId: "PRODUCT_CATALOG_EDIT",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            )
        }
        return as("imp_editor", () => {
            const mapped = call(S + "configure#CatalogImport", {
                    operationKey: run.operationKey,
                    mappingRevision: valid.mappingRevision,
                    defaults: {amountUomId: "OTH_ea"}
                }),
                stale = invoke(S + "apply#CatalogImport", {
                    operationKey: run.operationKey,
                    inputFingerprint: valid.inputFingerprint
                })
            return {denied, stale, mapped, missing: one(P + "Product", {productId: "IMP_ROLE_RECHECK"})}
        })
    },
    then({denied, stale, mapped, missing}) {
        denied.error.includes("authority")
        stale.error.includes("Validate")
        mapped.inputFingerprint == null
        missing == null
    }
})
