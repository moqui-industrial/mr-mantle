const S = "mantle.product.ProductServices.",
    I = "mantle.product.IdentifierServices.",
    A = "mantle.product.ProductAssoc"
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
let firstDate, secondDate, firstRevision
spec({
    setupSpec() {
        as("john.doe", () => {
            for (const id of ["P11_ORG", "P11_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, permission] of [
                ["P11_EDITOR", "PRODUCT_CATALOG_EDIT"],
                ["P11_READER", "PRODUCT_CATALOG_VIEW"],
                ["P11_ADMIN", "PRODUCT_CATALOG_ADMIN"]
            ]) {
                call("create#moqui.security.UserGroup", {userGroupId: id})
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
                    toPartyId: "P11_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const id of ["P11_BASE", "P11_CASE", "P11_OUTER", "P11_FREE", "P11_FOREIGN"])
                call("create#mantle.product.Product", {
                    productId: id,
                    ownerPartyId: id === "P11_FOREIGN" ? "P11_OTHER" : "P11_ORG",
                    productName: id,
                    productTypeEnumId: "PtAsset",
                    assetTypeEnumId: "AstTpInventory",
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.product.asset.Asset", {
                assetId: "P11_STOCK",
                productId: "P11_BASE",
                ownerPartyId: "P11_ORG",
                assetTypeEnumId: "AstTpInventory",
                quantityOnHandTotal: 10,
                availableToPromiseTotal: 10,
                acquireCost: 2,
                acquireCostUomId: "USD"
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("identifier checks are shared by the writer, validate GTIN digits and reject equivalent product and pack codes", {
    when() {
        return as("p11_editor", () => {
            const base = call(S + "store#ProductIdentifier", {
                    productId: "P11_BASE",
                    productIdTypeEnumId: "PidtEan",
                    idValue: "4006381333931"
                }),
                invalid = invoke(S + "store#ProductIdentifier", {
                    productId: "P11_CASE",
                    productIdTypeEnumId: "PidtGtin",
                    idValue: "04006381333930"
                }),
                collision = invoke(S + "store#ProductIdentifier", {
                    productId: "P11_CASE",
                    productIdTypeEnumId: "PidtGtin",
                    idValue: "04006381333931"
                })
            call(S + "store#ProductIdentifier", {productId: "P11_CASE", productIdTypeEnumId: "PidtSku", idValue: "CASE-12"})
            return {base, invalid, collision}
        })
    },
    then({base, invalid, collision}) {
        base.idValue == "4006381333931"
        invalid.error.includes("check digit")
        collision.error.includes("already assigned")
    }
})
feature("a dated packaging relationship changes no stock and scan normalization follows its quantity and unit", {
    when() {
        return as("p11_editor", () => {
            const before = one("mantle.product.asset.Asset", {assetId: "P11_STOCK"}).getMap(),
                stored = call(S + "store#ProductPackaging", {
                    packProductId: "P11_CASE",
                    baseProductId: "P11_BASE",
                    quantity: 12,
                    quantityUomId: "OTH_ea",
                    changeReason: "Twelve-unit case"
                })
            firstDate = stored.fromDate
            firstRevision = stored.expectedRevision
            return {
                before,
                stored,
                scan: call(S + "resolve#ScannedProduct", {scanId: "CASE-12"}),
                after: one("mantle.product.asset.Asset", {assetId: "P11_STOCK"}).getMap()
            }
        })
    },
    then({before, stored, scan, after}) {
        stored.packProductId == "P11_CASE"
        scan.found == true
        scan.productId == "P11_BASE"
        scan.packProductId == "P11_CASE"
        scan.containedQuantity == 12
        scan.quantityUomId == "OTH_ea"
        scan.appliedConversionFactor == 12
        after.quantityOnHandTotal == before.quantityOnHandTotal
        after.acquireCost == before.acquireCost
    }
})
feature("a packaging successor retains the earlier size and stale reviews cannot overwrite it", {
    when() {
        return as("p11_editor", () => {
            secondDate = new Date(Number(String(ec.user.nowTimestamp)) + 86400000).toISOString()
            const next = call(S + "store#ProductPackaging", {
                packProductId: "P11_CASE",
                baseProductId: "P11_BASE",
                quantity: 18,
                quantityUomId: "OTH_ea",
                fromDate: secondDate,
                expectedRevision: firstRevision,
                changeReason: "Future eighteen-unit case"
            })
            return {
                next,
                prior: call(S + "resolve#ScannedProduct", {scanId: "CASE-12", asOfDate: firstDate}),
                future: call(S + "resolve#ScannedProduct", {scanId: "CASE-12", asOfDate: secondDate}),
                stale: invoke(S + "store#ProductPackaging", {
                    packProductId: "P11_CASE",
                    baseProductId: "P11_BASE",
                    quantity: 99,
                    expectedRevision: firstRevision,
                    changeReason: "Stale definition refused"
                }),
                history: Array.from(find(A, {productId: "P11_CASE", productAssocTypeEnumId: "PatPackagingFor"}).list()).map(r =>
                    r.getMap()
                )
            }
        })
    },
    then({next, prior, future, stale, history}) {
        prior.containedQuantity == 12
        future.containedQuantity == 18
        history.length == 2
        history.find(r => toDecimal(r.quantity).compare(12) === 0).thruDate != null
        stale.error.includes("changed")
    }
})
feature("nested packs normalize through every level and cyclic or nonpositive relationships are refused", {
    when() {
        return as("p11_editor", () => {
            call(S + "store#ProductPackaging", {
                packProductId: "P11_OUTER",
                baseProductId: "P11_CASE",
                quantity: 3,
                quantityUomId: "OTH_ea",
                idValue: "OUTER-3",
                changeReason: "Three cases per outer pack"
            })
            const scan = call(S + "resolve#ScannedProduct", {scanId: "OUTER-3", asOfDate: secondDate}),
                cycle = invoke(S + "store#ProductPackaging", {
                    packProductId: "P11_BASE",
                    baseProductId: "P11_OUTER",
                    quantity: 1,
                    changeReason: "Cycle refused"
                }),
                zero = invoke(S + "store#ProductPackaging", {
                    packProductId: "P11_FREE",
                    baseProductId: "P11_BASE",
                    quantity: 0,
                    changeReason: "Zero quantity refused"
                })
            return {scan, cycle, zero}
        })
    },
    then({scan, cycle, zero}) {
        scan.productId == "P11_BASE"
        scan.containedQuantity == 54
        scan.packPath.length == 2
        cycle.error.includes("cycle")
        zero.error.includes("positive")
    }
})
feature("a GS1 product lookup and Warehouse scan share the resolver while ambiguous identities are never guessed", {
    when() {
        as("john.doe", () =>
            call("create#mantle.product.ProductIdentification", {
                productId: "P11_FOREIGN",
                productIdTypeEnumId: "PidtEan",
                idValue: "4006381333931"
            })
        )
        const own = as("p11_reader", () => call(S + "resolve#ScannedProduct", {scanId: "]C101040063813339311726123110BATCH-7"})),
            warehouse = as("p11_reader", () =>
                call("mantle.facility.FacilityServices.get#ScannedIdGeneral", {scanId: "CASE-12"})
            ),
            all = as("john.doe", () => call(S + "resolve#ScannedProduct", {scanId: "4006381333931"}))
        return {own, warehouse, all}
    },
    then({own, warehouse, all}) {
        own.found == true
        own.productId == "P11_BASE"
        own.gs1.applicationIdentifiers["10"] == "BATCH-7"
        !JSON.stringify(own).includes("P11_FOREIGN")
        warehouse.productId == "P11_BASE"
        warehouse.packProductId == "P11_CASE"
        warehouse.containedQuantity == 12
        all.found == false
        all.ambiguous == true
        all.ambiguityList.length == 2
    }
})
feature("catalog administration configures dated assignment policy while generation remains a preview until confirmed", {
    when() {
        return as("p11_admin", () => {
            const cfg = call(I + "get#IdentifierContext", {organizationPartyId: "P11_ORG"}).identifierPolicyRows.find(
                r => r.productIdTypeEnumId === "PidtSku"
            )
            call(I + "store#IdentifierPolicy", {
                organizationPartyId: "P11_ORG",
                productIdTypeEnumId: "PidtSku",
                expectedRevision: cfg.expectedRevision,
                enabled: "Y",
                format: "Code128",
                uniquenessScope: "global",
                generationRule: "internal",
                prefix: "IN-",
                changeReason: "Internal product identifiers"
            })
            const preview = call(S + "validate#ProductIdentifier", {
                    productId: "P11_FREE",
                    productIdTypeEnumId: "PidtSku",
                    generate: true,
                    forAssignment: true
                }),
                before = one("mantle.product.ProductIdentification", {productId: "P11_FREE", productIdTypeEnumId: "PidtSku"})
            call(S + "store#ProductIdentifier", {
                productId: "P11_FREE",
                productIdTypeEnumId: "PidtSku",
                idValue: preview.generatedValue
            })
            return {
                preview,
                before,
                after: one("mantle.product.ProductIdentification", {productId: "P11_FREE", productIdTypeEnumId: "PidtSku"})
            }
        })
    },
    then({preview, before, after}) {
        preview.valid == true
        preview.generatedValue == "IN-P11_FREE"
        before == null
        after.idValue == "IN-P11_FREE"
    }
})
feature("changing an identifier retains its previous scan alias and disabling assignment does not hide existing codes", {
    when() {
        return as("p11_admin", () => {
            call(S + "store#ProductIdentifier", {productId: "P11_FREE", productIdTypeEnumId: "PidtSku", idValue: "IN-FREE-NEW"})
            const cfg = call(I + "get#IdentifierContext", {organizationPartyId: "P11_ORG"}).identifierPolicyRows.find(
                r => r.productIdTypeEnumId === "PidtSku"
            )
            call(I + "store#IdentifierPolicy", {
                organizationPartyId: "P11_ORG",
                productIdTypeEnumId: "PidtSku",
                expectedRevision: cfg.expectedRevision,
                enabled: "N",
                changeReason: "Retire new SKU assignments"
            })
            return {
                old: call(S + "resolve#ScannedProduct", {scanId: "IN-P11_FREE"}),
                current: call(S + "resolve#ScannedProduct", {scanId: "IN-FREE-NEW"}),
                denied: invoke(S + "store#ProductIdentifier", {
                    productId: "P11_BASE",
                    productIdTypeEnumId: "PidtSku",
                    idValue: "NEW-DISABLED"
                })
            }
        })
    },
    then({old, current, denied}) {
        old.productId == "P11_FREE"
        current.productId == "P11_FREE"
        denied.error.includes("disabled")
    }
})
feature(
    "ownership and catalog edit authority hold with artifact authorization disabled and used stock units cannot be reinterpreted",
    {
        when() {
            return {
                reader: as("p11_reader", () =>
                    invoke(S + "store#ProductPackaging", {
                        packProductId: "P11_FREE",
                        baseProductId: "P11_BASE",
                        quantity: 1,
                        changeReason: "Read role refused"
                    })
                ),
                foreign: as("p11_editor", () =>
                    invoke(S + "store#ProductIdentifier", {
                        productId: "P11_FOREIGN",
                        productIdTypeEnumId: "PidtSku",
                        idValue: "HIDDEN"
                    })
                ),
                used: as("john.doe", () =>
                    invoke("update#mantle.product.Product", {productId: "P11_BASE", amountUomId: "LEN_m"})
                ),
                unchanged: one("mantle.product.Product", {productId: "P11_BASE"}).amountUomId
            }
        },
        then({reader, foreign, used, unchanged}) {
            reader.error.includes("authority")
            foreign.error.includes("not available")
            used.error.includes("stock unit")
            unchanged == "OTH_ea"
        }
    }
)
feature("plain retail scans use the same canonical GTIN as GS1", {
    expect() {
        as("john.doe", () => {
            call("create#mantle.product.Product", {
                productId: "PKG_CANONICAL_SCAN",
                ownerPartyId: "P11_ORG",
                productName: "Canonical retail scan",
                amountUomId: "OTH_ea"
            })
            call("create#mantle.product.ProductIdentification", {
                productId: "PKG_CANONICAL_SCAN",
                productIdTypeEnumId: "PidtEan",
                idValue: "8398765432108"
            })
        })
        const scan = as("john.doe", () => call(S + "resolve#ScannedProduct", {scanId: "08398765432108"}))
        scan.productId == "PKG_CANONICAL_SCAN"
        scan.found == true
    }
})
