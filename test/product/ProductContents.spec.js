const S = "mantle.product.ContentServices.",
    L = "mantle.product.ProductServices."
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
let textId, categoryId, sourceId, targetId
spec({
    setupSpec() {
        as("john.doe", () => {
            for (const id of ["CND_ORG", "CND_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, owner] of [
                ["CND_PROD", "CND_ORG"],
                ["CND_HIDDEN", "CND_OTHER"]
            ])
                call("create#mantle.product.Product", {
                    productId: id,
                    productName: id,
                    ownerPartyId: owner,
                    productTypeEnumId: "PtAsset",
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.product.category.ProductCategory", {
                productCategoryId: "CND_CAT",
                categoryName: "Documents",
                ownerPartyId: "CND_ORG",
                productCategoryTypeEnumId: "PctCatalog"
            })
            for (const [id, permissions] of [
                ["CND_EDITOR", ["PRODUCT_CATALOG_VIEW", "PRODUCT_CATALOG_EDIT"]],
                ["CND_READER", ["PRODUCT_CATALOG_VIEW"]]
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
                    toPartyId: "CND_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature("same-name text documents have independent resources and category references are preserved without fetching", {
    when() {
        return as("john.doe", () => {
            textId = call(L + "create#ProductContent", {
                productId: "CND_PROD",
                productContentTypeEnumId: "PcntDescription",
                locale: "en",
                filename: "description.html",
                contentText: "First"
            }).productContentId
            const second = call(L + "create#ProductContent", {
                productId: "CND_PROD",
                productContentTypeEnumId: "PcntDescription",
                filename: "description.html",
                contentText: "Second"
            }).productContentId
            categoryId = call(L + "create#ProductCategoryContent", {
                productCategoryId: "CND_CAT",
                categoryContentTypeEnumId: "PcctDescription",
                contentLocation: "https://example.invalid/do-not-fetch.html"
            }).productCategoryContentId
            return {
                a: one("mantle.product.ProductContent", {productContentId: textId}),
                b: one("mantle.product.ProductContent", {productContentId: second}),
                category: one("mantle.product.category.ProductCategoryContent", {productCategoryContentId: categoryId})
            }
        })
    },
    then({a, b, category}) {
        a.contentLocation != b.contentLocation
        ec.resource.getLocationText(a.contentLocation, false) == "First"
        ec.resource.getLocationText(b.contentLocation, false) == "Second"
        category.contentLocation == "https://example.invalid/do-not-fetch.html"
    }
})
feature("a stale text edit retains its submission without replacing the current version, including empty text writes", {
    when() {
        return as("cnd_editor", () => {
            const before = call(S + "get#CatalogContent", {productContentId: textId})
            const first = call(S + "store#CatalogContent", {
                productContentId: textId,
                expectedRevision: before.expectedRevision,
                contentText: "Winner"
            })
            const second = call(S + "store#CatalogContent", {
                productContentId: textId,
                expectedRevision: before.expectedRevision,
                contentText: "Concurrent draft"
            })
            const after = call(S + "get#CatalogContent", {productContentId: textId})
            const retained = call(S + "get#CatalogContentResource", {
                productContentId: textId,
                contentEditConflictId: second.contentEditConflictId
            })
            const empty = call(S + "store#CatalogContent", {
                productContentId: textId,
                expectedRevision: after.expectedRevision,
                contentText: ""
            })
            return {
                first,
                second,
                after,
                retainedText: ec.resource.getLocationText(retained.contentLocation, false),
                empty,
                final: call(S + "get#CatalogContent", {productContentId: textId})
            }
        })
    },
    then({first, second, after, retainedText, empty, final}) {
        first.conflict == false
        second.conflict == true
        after.contentText == "Winner"
        retainedText == "Concurrent draft"
        after.versionRows.length >= 2
        after.conflictRows.length == 1
        empty.conflict == false
        final.contentText == ""
    }
})
feature("metadata conflicts use the same guard and restoration writes a new version", {
    when() {
        return as("cnd_editor", () => {
            const before = call(S + "get#CatalogContent", {productContentId: textId}),
                first = call(S + "store#CatalogContent", {
                    productContentId: textId,
                    expectedRevision: before.expectedRevision,
                    description: "Reviewed metadata"
                }),
                stale = call(S + "store#CatalogContent", {
                    productContentId: textId,
                    expectedRevision: before.expectedRevision,
                    description: "Stale metadata"
                }),
                current = call(S + "get#CatalogContent", {productContentId: textId}),
                version = current.versionRows.at(-1).versionName,
                restored = call(S + "restore#CatalogContent", {
                    productContentId: textId,
                    expectedRevision: current.expectedRevision,
                    versionName: version
                })
            return {first, stale, current, after: call(S + "get#CatalogContent", {productContentId: textId}), restored}
        })
    },
    then({first, stale, current, after, restored}) {
        first.conflict == false
        stale.conflict == true
        current.document.description == "Reviewed metadata"
        after.contentText == "First"
        after.versionRows.length > current.versionRows.length
        restored.contentId == textId
    }
})
feature("native content permissions and ownership hold without application groups or artifact authorization", {
    when() {
        return {
            read: as("cnd_reader", () => call(S + "find#CatalogContents", {productId: "CND_PROD"})),
            denied: as("cnd_reader", () => invoke(S + "store#CatalogContent", {productId: "CND_PROD", contentText: "Denied"})),
            hidden: as("cnd_editor", () => invoke(S + "find#CatalogContents", {productId: "CND_HIDDEN"})),
            reference: as("cnd_editor", () =>
                invoke(S + "get#CatalogContentResource", {recordKind: "category", productCategoryContentId: categoryId})
            ),
            forged: as("cnd_editor", () =>
                invoke(S + "store#CatalogContent", {productId: "CND_PROD", contentLocation: "file:///etc/passwd"})
            )
        }
    },
    then({read, denied, hidden, reference, forged}) {
        read.contentRows.length >= 2
        read.canEdit == false
        denied.error.includes("authority")
        hidden.error.includes("not available")
        reference.error.includes("not available")
        forged.error.includes("authorized drive")
    }
})
feature("multi-file uploads retain successful independent files and name each failed file", {
    when() {
        return as("cnd_editor", () =>
            call(S + "upload#CatalogContents", {
                productId: "CND_PROD",
                productContentTypeEnumId: "PcntDescription",
                contentFiles: [uploadedFile("ok.txt", "One"), uploadedFile("empty.txt", ""), uploadedFile("also.txt", "Two")]
            })
        )
    },
    then({uploadResults}) {
        uploadResults.length == 3
        uploadResults.filter(r => r.success).length == 2
        uploadResults.find(r => r.filename === "empty.txt").success == false
        uploadResults.filter(r => r.success).every(r => r.contentId != null)
    }
})
feature("source changes flag translations for review, preserve target text and refuse stale source approvals", {
    when() {
        return as("cnd_editor", () => {
            sourceId = call(S + "store#CatalogContent", {
                productId: "CND_PROD",
                productContentTypeEnumId: "PcntProductName",
                locale: "en",
                contentText: "Original name"
            }).contentId
            const source = call(S + "get#CatalogContent", {productContentId: sourceId})
            targetId = call(S + "store#CatalogTranslation", {
                sourceContentId: sourceId,
                targetLocale: "es",
                targetText: "Nombre original",
                sourceRevision: source.expectedRevision,
                markReviewed: true
            }).contentId
            const reviewed = call(S + "find#CatalogTranslations", {productId: "CND_PROD", sourceLocale: "en", targetLocale: "es"})
            call(S + "store#CatalogContent", {
                productContentId: sourceId,
                expectedRevision: source.expectedRevision,
                contentText: "Changed name"
            })
            const changed = call(S + "find#CatalogTranslations", {productId: "CND_PROD", sourceLocale: "en", targetLocale: "es"}),
                denied = invoke(S + "store#CatalogTranslation", {
                    sourceContentId: sourceId,
                    targetContentId: targetId,
                    targetLocale: "es",
                    sourceRevision: source.expectedRevision,
                    targetText: "Stale review",
                    markReviewed: true
                })
            return {reviewed, changed, denied}
        })
    },
    then({reviewed, changed, denied}) {
        reviewed.translationRows.find(r => r.contentId == sourceId).reviewState == "Reviewed"
        changed.translationRows.find(r => r.contentId == sourceId).reviewState == "Needs review"
        changed.translationRows.find(r => r.contentId == sourceId).targetText == "Nombre original"
        denied.error.includes("source changed")
    }
})
feature("category text has the same concurrency and translation review behavior", {
    when() {
        return as("cnd_editor", () => {
            const id = call(S + "store#CatalogContent", {
                recordKind: "category",
                productCategoryId: "CND_CAT",
                categoryContentTypeEnumId: "PcctDescription",
                locale: "en",
                contentText: "Category source"
            }).contentId
            const source = call(S + "get#CatalogContent", {recordKind: "category", contentId: id}),
                target = call(S + "store#CatalogTranslation", {
                    recordKind: "category",
                    sourceContentId: id,
                    targetLocale: "es",
                    targetText: "Categoria",
                    sourceRevision: source.expectedRevision,
                    markReviewed: true
                })
            const changed = call(S + "store#CatalogContent", {
                    recordKind: "category",
                    contentId: id,
                    productCategoryContentId: id,
                    expectedRevision: source.expectedRevision,
                    contentText: "Changed category"
                }),
                conflict = call(S + "store#CatalogContent", {
                    recordKind: "category",
                    productCategoryContentId: id,
                    expectedRevision: source.expectedRevision,
                    contentText: "Other editor"
                })
            return {
                target,
                changed,
                conflict,
                rows: call(S + "find#CatalogTranslations", {
                    recordKind: "category",
                    productCategoryId: "CND_CAT",
                    sourceLocale: "en",
                    targetLocale: "es"
                })
            }
        })
    },
    then({target, changed, conflict, rows}) {
        target.contentId != null
        changed.conflict == false
        conflict.conflict == true
        rows.translationRows.some(r => r.reviewState === "Needs review")
    }
})
feature("past versions can be compared and the datasheet escapes typed text", {
    when() {
        return as("cnd_editor", () => {
            const d = call(S + "get#CatalogContent", {productContentId: textId}),
                comparison = call(S + "get#CatalogContent", {
                    productContentId: textId,
                    fromVersion: d.versionRows.at(-1).versionName
                })
            call(S + "store#CatalogContent", {
                productId: "CND_PROD",
                productContentTypeEnumId: "PcntDescription",
                contentText: "<script>unsafe()</script>"
            })
            return {comparison, print: call(S + "get#ProductDatasheet", {productId: "CND_PROD"})}
        })
    },
    then({comparison, print}) {
        comparison.diff != null
        print.printHtml.includes("&lt;script&gt;")
        !print.printHtml.includes("<script>unsafe()")
    }
})
feature("an external category reference can be replaced by an uploaded owned resource without fetching its old location", {
    when() {
        return as("cnd_editor", () => {
            const before = call(S + "get#CatalogContent", {recordKind: "category", productCategoryContentId: categoryId})
            const saved = call(S + "store#CatalogContent", {
                recordKind: "category",
                productCategoryContentId: categoryId,
                expectedRevision: before.expectedRevision,
                contentFile: uploadedFile("../../safe.txt", "Owned replacement")
            })
            const after = call(S + "get#CatalogContent", {recordKind: "category", productCategoryContentId: categoryId})
            return {saved, after}
        })
    },
    then({saved, after}) {
        saved.conflict == false
        after.document.managed == true
        after.document.filename == "safe.txt"
        after.contentText == "Owned replacement"
        !after.document.contentLocation.includes("..")
    }
})
feature("translations need a chosen target language; none is assumed", {
    when() {
        return as("john.doe", () => call(S + "find#CatalogTranslations", {productId: "CND_PROD", sourceLocale: "en"}))
    },
    then(found) {
        found.translationRows.length == 0
        found.directLocalizationRows.length == 0
    }
})
