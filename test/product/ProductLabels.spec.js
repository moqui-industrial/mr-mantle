const S = "mantle.product.LabelServices.",
    P = "mantle.product.ProductServices."
const one = (n, p) => ec.entity.find(n).condition(p).disableAuthz().one()
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
let key, token
spec({
    setupSpec() {
        as("john.doe", () => {
            call("create#mantle.party.Party", {partyId: "LBL_ORG", partyTypeEnumId: "PtyOrganization"})
            call("create#mantle.party.Organization", {partyId: "LBL_ORG", organizationName: "Label company"})
            call("create#mantle.party.PartyRole", {partyId: "LBL_ORG", roleTypeId: "OrgInternal"})
            for (const [id, perms] of [
                ["LBL_READER", ["PRODUCT_CATALOG_VIEW"]],
                ["LBL_EDITOR", ["PRODUCT_CATALOG_EDIT"]]
            ]) {
                call("create#moqui.security.UserGroup", {userGroupId: id})
                for (const permission of perms)
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
                    toPartyId: "LBL_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const id of ["LBL_BASE", "LBL_PACK"])
                call("create#mantle.product.Product", {
                    productId: id,
                    ownerPartyId: "LBL_ORG",
                    productName: id,
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea"
                })
            call(P + "store#ProductIdentifier", {productId: "LBL_BASE", productIdTypeEnumId: "PidtEan", idValue: "96385074"})
            call(P + "store#ProductIdentifier", {productId: "LBL_PACK", productIdTypeEnumId: "PidtSku", idValue: "LBL-12"})
            call(P + "store#ProductPackaging", {
                packProductId: "LBL_PACK",
                baseProductId: "LBL_BASE",
                quantity: 12,
                changeReason: "Label pack fixture"
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("labels use existing codes, decode packs and preserve independent selection failures", {
    when() {
        return as("lbl_reader", () => {
            const before = ec.entity.find("mantle.product.ProductIdentification").disableAuthz().count(),
                prepared = call(S + "prepare#ProductLabels", {productIds: ["LBL_PACK", "DOES_NOT_EXIST"], copies: 2})
            key = prepared.operationKey
            token = prepared.inputFingerprint
            return {
                prepared,
                before,
                after: ec.entity.find("mantle.product.ProductIdentification").disableAuthz().count(),
                reopened: call(S + "get#ProductLabels", {operationKey: key})
            }
        })
    },
    then({prepared, before, after, reopened}) {
        prepared.labelRows.length == 1
        prepared.findings.length == 1
        prepared.labelCount == 2
        prepared.labelRows[0].decodedProductId == "LBL_BASE"
        prepared.labelRows[0].containedQuantity == 12
        prepared.labelRows[0].encodedValue == "LBL-12"
        prepared.labelRows[0].svg.includes("<svg")
        before == after
        reopened.labelRows.length == 1
        reopened.stale == false
    }
})
feature("a catalog reader cannot request prices or another operators label job", {
    when() {
        return {
            priced: as("lbl_reader", () => invoke(S + "prepare#ProductLabels", {productIds: ["LBL_BASE"], includePrice: true})),
            other: as("lbl_editor", () => invoke(S + "get#ProductLabels", {operationKey: key}))
        }
    },
    then({priced, other}) {
        priced.error.includes("Selling-price")
        other.error.includes("own label")
    }
})
feature("all approved matrix and linear symbols preserve the selected code and print layout", {
    where: [
        {symbology: "QR", productId: "LBL_PACK"},
        {symbology: "DataMatrix", productId: "LBL_PACK"},
        {symbology: "EAN-8", productId: "LBL_BASE"},
        {symbology: "GS1-128", productId: "LBL_BASE"}
    ],
    expect({symbology, productId}) {
        const p = as("lbl_reader", () =>
            call(S + "prepare#ProductLabels", {productIds: [productId], symbology, templateId: "shipping-100x60"})
        )
        p.labelRows.length == 1
        p.labelRows[0].symbology == symbology
        p.findings.length == 0
        const printed = as("lbl_reader", () =>
            call(S + "get#ProductLabelPrint", {operationKey: p.operationKey, inputFingerprint: p.inputFingerprint})
        )
        printed.printHtml.includes("@page")
        printed.printHtml.includes(p.labelRows[0].idValue)
    }
})
feature("identifier changes invalidate a reviewed preview and do not silently replace its selected source", {
    when() {
        as("lbl_editor", () =>
            call(P + "store#ProductIdentifier", {productId: "LBL_PACK", productIdTypeEnumId: "PidtSku", idValue: "LBL-NEW"})
        )
        return as("lbl_reader", () => ({
            review: call(S + "get#ProductLabels", {operationKey: key}),
            stale: invoke(S + "render#ProductLabels", {operationKey: key, inputFingerprint: token})
        }))
    },
    then({review, stale}) {
        review.stale == true
        stale.error.includes("changed")
    }
})
feature("rendering freezes a PDF while a missing PDF renderer retains the selection and a named outcome", {
    when() {
        return as("lbl_reader", () => {
            const p = call(S + "prepare#ProductLabels", {productIds: ["LBL_PACK"], symbology: "QR"}),
                rendered = call(S + "render#ProductLabels", {operationKey: p.operationKey, inputFingerprint: p.inputFingerprint}),
                saved = one("mantle.product.ProductCatalogOperation", {operationKey: p.operationKey}),
                resource = rendered.rendered ? call(S + "get#ProductLabelResource", {operationKey: p.operationKey}) : null
            return {p, rendered, saved, resource}
        })
    },
    then({p, rendered, saved, resource}) {
        saved.requestJson.includes("LBL_PACK")
        if (rendered.rendered) {
            saved.state == "rendered"
            resource.contentLocation.startsWith("dbresource://mantle/labels/")
            ec.resource.getLocationReference(resource.contentLocation).exists == true
        } else {
            saved.state == "render-failed"
            rendered.lastError.includes("PDF")
            saved.lastError != null
        }
    }
})
feature("a refused local printer retains the exact rendered selection and reports a retryable job outcome", {
    when() {
        as("john.doe", () =>
            call("create#moqui.basic.print.NetworkPrinter", {
                networkPrinterId: "LBL_UNREACHABLE",
                serverHost: "127.0.0.1",
                serverPort: 1,
                printerName: "test-does-not-exist"
            })
        )
        return as("lbl_reader", () => {
            const p = call(S + "prepare#ProductLabels", {productIds: ["LBL_PACK"], symbology: "QR"}),
                rendered = call(S + "render#ProductLabels", {operationKey: p.operationKey, inputFingerprint: p.inputFingerprint})
            if (!rendered.rendered) skip("Printer failure integration requires the configured PDF renderer")
            const sent = call(S + "print#ProductLabels", {operationKey: p.operationKey, networkPrinterId: "LBL_UNREACHABLE"}),
                saved = one("mantle.product.ProductCatalogOperation", {operationKey: p.operationKey}),
                reopened = call(S + "get#ProductLabels", {operationKey: p.operationKey})
            return {p, sent, saved, reopened}
        })
    },
    then({p, sent, saved, reopened}) {
        sent.lastError != null
        saved.state == "print-failed"
        saved.outputContentLocation != null
        saved.requestJson.includes("LBL_PACK")
        reopened.labelCount == p.labelCount
        reopened.stale == false
        reopened.lastError != null
    }
})
