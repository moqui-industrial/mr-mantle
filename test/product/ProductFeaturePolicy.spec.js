const PS = "mantle.product.ProductServices."
function safe(name, p) {
    try {
        const out = call(name, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
spec({
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("one feature pair has one scope and reverse duplicates are refused", {
    when() {
        for (const id of ["POL_A", "POL_B"])
            call("create#mantle.product.feature.ProductFeature", {
                productFeatureId: id,
                productFeatureTypeEnumId: "PftColor",
                description: id
            })
        const first = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_A",
            toProductFeatureId: "POL_B",
            iactnTypeEnumId: "PfitCompatible"
        })
        const other = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_A",
            toProductFeatureId: "POL_B",
            iactnTypeEnumId: "PfitCompatible",
            productId: "DEMO_VAR"
        })
        const reverse = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_B",
            toProductFeatureId: "POL_A",
            iactnTypeEnumId: "PfitIncompatible"
        })
        return {first, other, reverse}
    },
    then({first, other, reverse}) {
        first.error == ""
        other.error.includes("another product scope")
        reverse.error.includes("reverse direction")
    }
})
feature("a new global dependency is checked against the entire chain and product-specific incompatible rules", {
    when() {
        for (const id of ["POL_X", "POL_Y", "POL_Z"])
            call("create#mantle.product.feature.ProductFeature", {
                productFeatureId: id,
                productFeatureTypeEnumId: "PftColor",
                description: id
            })
        const scoped = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_X",
            toProductFeatureId: "POL_Z",
            iactnTypeEnumId: "PfitIncompatible",
            productId: "DEMO_VAR"
        })
        const dependency = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_X",
            toProductFeatureId: "POL_Y",
            iactnTypeEnumId: "PfitDependency"
        })
        const conflict = safe(PS + "store#FeatureInteraction", {
            productFeatureId: "POL_Y",
            toProductFeatureId: "POL_Z",
            iactnTypeEnumId: "PfitDependency"
        })
        const missing = call(PS + "preview#FeatureInteractions", {productId: "DEMO_VAR", productFeatureIds: ["POL_X"]})
        const valid = call(PS + "preview#FeatureInteractions", {productId: "DEMO_VAR", productFeatureIds: ["POL_X", "POL_Y"]})
        return {scoped, dependency, conflict, missing, valid}
    },
    then({scoped, dependency, conflict, missing, valid}) {
        scoped.error == ""
        dependency.error == ""
        conflict.error.includes("conflicts")
        missing.valid == false
        missing.issues[0].toProductFeatureId == "POL_Y"
        valid.valid == true
    }
})
