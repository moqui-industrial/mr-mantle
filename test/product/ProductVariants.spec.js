const PS = "mantle.product.ProductServices.",
    P = "mantle.product.",
    F = P + "feature.",
    time = Date.now()
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
function source(id) {
    call("create#" + P + "Product", {
        productId: id,
        productName: id,
        pseudoId: id,
        productTypeEnumId: "PtVirtual",
        ownerPartyId: "ORG_ZIZI_SERVICES",
        amountUomId: "OTH_ea"
    })
    for (const f of ["V4_BLUE", "V4_RED", "V4_S", "V4_L"])
        call("create#" + F + "ProductFeatureAppl", {
            productId: id,
            productFeatureId: f,
            applTypeEnumId: "PfatSelectable",
            fromDate: time - 1000
        })
}
spec({
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(time)
        ec.artifactExecution.disableAuthz()
        for (const [id, type, abbrev] of [
            ["V4_BLUE", "PftColor", "BL"],
            ["V4_RED", "PftColor", "RD"],
            ["V4_S", "PftSize", "S"],
            ["V4_L", "PftSize", "L"]
        ])
            call("create#" + F + "ProductFeature", {
                productFeatureId: id,
                description: id,
                abbrev,
                productFeatureTypeEnumId: type
            })
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("preview is paged, selected creation is canonical and repeatable, and empty selections never invoke all combinations", {
    when() {
        source("V4_BASE")
        const preview = call(PS + "preview#VariantProducts", {productId: "V4_BASE", pageSize: 2, pageIndex: 1})
        const args = {productId: "V4_BASE", selectedFeatureSets: [["V4_BLUE", "V4_S"]], previewRevision: preview.previewRevision}
        const first = invoke(PS + "create#VariantProducts", args),
            again = invoke(
                PS + "create#VariantProducts",
                Object.assign({}, args, {
                    selectedFeatureSets: [
                        ["V4_S", "V4_BLUE"],
                        ["V4_BLUE", "V4_S"]
                    ]
                })
            ),
            empty = invoke(PS + "create#VariantProducts", {productId: "V4_BASE", selectedFeatureSets: []})
        const info = call(PS + "get#VariantProductsInfo", {productId: "V4_BASE", includePrices: false})
        return {preview, first, again, empty, info}
    },
    then({preview, first, again, empty, info}) {
        preview.totalCount == 4
        preview.rows.length == 2
        preview.pageIndex == 1
        first.createdCount == 1
        again.existingCount == 1
        again.results.length == 1
        empty.results.length == 0
        info.featureTypeInfoList.length == 2
        info.productInfoList.length == 1
        info.productInfoList[0].productFeatureIdByTypeId.PftColor == "V4_BLUE"
        info.productInfoList[0].price == null
    }
})
feature("collision and incompatibility fail independently without partially creating identity links", {
    when() {
        source("V4_MIX")
        call("create#" + P + "Product", {
            productId: "V4_MIX_BL_S",
            productName: "Unrelated collision",
            productTypeEnumId: "PtAsset"
        })
        call("create#" + F + "ProductFeatureIactn", {
            productFeatureId: "V4_RED",
            toProductFeatureId: "V4_L",
            productId: "V4_MIX",
            iactnTypeEnumId: "PfitIncompatible"
        })
        const out = call(PS + "create#VariantProducts", {
            productId: "V4_MIX",
            selectedFeatureSets: [
                ["V4_BLUE", "V4_S"],
                ["V4_RED", "V4_L"],
                ["V4_BLUE", "V4_L"]
            ]
        })
        return {
            out,
            identities: ec.entity
                .find(P + "ProductVariantIdentity")
                .condition({baseProductId: "V4_MIX"})
                .count()
        }
    },
    then({out, identities}) {
        out.failedCount == 2
        out.createdCount == 1
        out.results[0].error.includes("already used")
        out.results[1].error.includes("incompatible")
        identities == 1
    }
})
feature("changes to selectable features invalidate the preview and cannot silently create a partial feature set", {
    when() {
        source("V4_STALE")
        const before = call(PS + "preview#VariantProducts", {productId: "V4_STALE"})
        call("update#" + F + "ProductFeatureAppl", {
            productId: "V4_STALE",
            productFeatureId: "V4_BLUE",
            fromDate: new Date(time - 1000).toISOString(),
            thruDate: new Date(time).toISOString()
        })
        const out = invoke(PS + "create#VariantProducts", {
            productId: "V4_STALE",
            previewRevision: before.previewRevision,
            selectedFeatureSets: [["V4_BLUE", "V4_S"]]
        })
        return {
            out,
            count: ec.entity
                .find(P + "ProductAssoc")
                .condition({productId: "V4_STALE", productAssocTypeEnumId: "PatVariant"})
                .count()
        }
    },
    then({out, count}) {
        out.error.includes("preview changed")
        count == 0
    }
})
feature("legacy exact identity ignores expired features and standard supersets, and all-combination callers still work", {
    when() {
        source("V4_LEG")
        call("create#" + P + "Product", {productId: "V4_LEGACY", productName: "Legacy variant", productTypeEnumId: "PtAsset"})
        call("create#" + P + "ProductAssoc", {
            productId: "V4_LEG",
            toProductId: "V4_LEGACY",
            productAssocTypeEnumId: "PatVariant",
            fromDate: time - 1000
        })
        for (const id of ["V4_BLUE", "V4_S"])
            call("create#" + F + "ProductFeatureAppl", {
                productId: "V4_LEGACY",
                productFeatureId: id,
                applTypeEnumId: "PfatDistinguishing",
                fromDate: time - 1000
            })
        call("create#" + F + "ProductFeatureAppl", {
            productId: "V4_LEGACY",
            productFeatureId: "V4_RED",
            applTypeEnumId: "PfatDistinguishing",
            fromDate: time - 2000,
            thruDate: time - 1000
        })
        const all = invoke(PS + "create#VariantProducts", {productId: "V4_LEG"})
        return {
            all,
            identity: ec.entity
                .find(P + "ProductVariantIdentity")
                .condition({baseProductId: "V4_LEG", featureKey: JSON.stringify(["V4_BLUE", "V4_S"])})
                .one()
        }
    },
    then({all, identity}) {
        all.error == ""
        all.createdCount == 3
        all.existingCount == 1
        identity.productId == "V4_LEGACY"
    }
})
feature("concurrent submissions serialize on the virtual product and create one canonical identity", {
    when() {
        source("V4_RACE")
        const preview = call(PS + "preview#VariantProducts", {productId: "V4_RACE"})
        const results = parallel(
            2,
            (threadNum, args) => {
                login("john.doe")
                ec.artifactExecution.disableAuthz()
                const out = call("mantle.product.ProductServices.create#VariantProducts", args)
                return {createdCount: out.createdCount, existingCount: out.existingCount, failedCount: out.failedCount}
            },
            {productId: "V4_RACE", selectedFeatureSets: [["V4_RED", "V4_S"]], previewRevision: preview.previewRevision},
            {transaction: false}
        )
        return {
            results,
            identities: ec.entity
                .find(P + "ProductVariantIdentity")
                .condition({baseProductId: "V4_RACE"})
                .count()
        }
    },
    then({results, identities}) {
        results.reduce((s, r) => s + r.createdCount, 0) == 1
        results.reduce((s, r) => s + r.existingCount, 0) == 1
        results.every(r => r.failedCount === 0)
        identities == 1
    }
})
feature("three-axis previews page without expanding the full matrix and deduplicate repeated category groups", {
    when() {
        source("V4_THREE")
        for (const [id, abbrev] of [
            ["V4_COTTON", "C"],
            ["V4_WOOL", "W"]
        ]) {
            call("create#" + F + "ProductFeature", {
                productFeatureId: id,
                productFeatureTypeEnumId: "PftFabric",
                description: id,
                abbrev
            })
            call("create#" + F + "ProductFeatureAppl", {
                productId: "V4_THREE",
                productFeatureId: id,
                applTypeEnumId: "PfatSelectable",
                fromDate: time - 1000
            })
        }
        call("create#" + F + "ProductFeatureGroup", {productFeatureGroupId: "V4_GROUP", description: "Repeated defaults"})
        call("create#" + F + "ProductFeatureGroupAppl", {
            productFeatureGroupId: "V4_GROUP",
            productFeatureId: "V4_BLUE",
            fromDate: time - 1000
        })
        for (const productCategoryId of ["V4_CAT_A", "V4_CAT_B"]) {
            call("create#" + P + "category.ProductCategory", {
                productCategoryId,
                productCategoryTypeEnumId: "PctCatalog",
                categoryName: productCategoryId
            })
            call("create#" + P + "category.ProductCategoryMember", {
                productCategoryId,
                productId: "V4_THREE",
                fromDate: time - 1000
            })
            call("create#" + F + "ProductCategoryFeatGrpAppl", {
                productCategoryId,
                productFeatureGroupId: "V4_GROUP",
                fromDate: time - 1000,
                applTypeEnumId: "PfatSelectable"
            })
        }
        const page = call(PS + "preview#VariantProducts", {productId: "V4_THREE", pageSize: 3, pageIndex: 1}),
            filtered = call(PS + "preview#VariantProducts", {productId: "V4_THREE", filterFeatureIds: ["V4_COTTON"]}),
            groups = call(PS + "find#ProductFeatureGroups", {productId: "V4_THREE", applTypeEnumId: "PfatSelectable"})
        return {page, filtered, groups}
    },
    then({page, filtered, groups}) {
        page.totalCount == 8
        page.rows.length == 3
        page.rows.every(r => r.productFeatureIds.length === 3)
        filtered.totalCount == 4
        filtered.rows.every(r => r.productFeatureIds.includes("V4_COTTON"))
        filtered.featureTypeInfoList.find(a => a.enumId === "PftFabric").featureInfoList.length == 2
        groups.productFeatureGroupList.length == 1
    }
})
