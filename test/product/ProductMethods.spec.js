// Standalone Mantle fixtures define their own roles and grant only shared Moqui permissions.
function nativeTestRoles() {
    const roles = {
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
        NATIVE_METHOD_VIEW: ["METHOD_VIEW"],
        NATIVE_METHOD_EDIT: ["METHOD_VIEW", "METHOD_EDIT"],
        NATIVE_METHOD_APPROVE: ["METHOD_VIEW", "METHOD_APPROVE"],
        NATIVE_METHOD_RESOURCES: ["METHOD_VIEW", "METHOD_RESOURCES"]
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
const S = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
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
let bomId, firstDate, secondDate, firstLine, routeId, opId
spec({
    setupSpec() {
        as("john.doe", () => {
            nativeTestRoles()
            for (const id of ["MTH_ORG", "MTH_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, groups] of [
                ["MTH_ENGINEER", ["NATIVE_METHOD_EDIT"]],
                ["MTH_APPROVER", ["NATIVE_METHOD_APPROVE"]],
                ["MTH_RESOURCE", ["NATIVE_METHOD_RESOURCES", "NATIVE_COST_ESTIMATE", "NATIVE_COST_APPROVE"]],
                ["MTH_READER", ["NATIVE_METHOD_VIEW"]],
                ["MTH_PRODUCT_ADMIN", ["NATIVE_CATALOG_ADMIN"]]
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
                for (const group of groups) {
                    if (!one("moqui.security.UserGroup", {userGroupId: group}))
                        call("create#moqui.security.UserGroup", {userGroupId: group})
                    call("create#moqui.security.UserGroupMember", {
                        userId: id,
                        userGroupId: group,
                        fromDate: "2000-01-01T00:00:00Z"
                    })
                }
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: "MTH_ORG",
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const [id, owner, type] of [
                ["MTH_FIN", "MTH_ORG", "PtAsset"],
                ["MTH_SUB", "MTH_ORG", "PtAsset"],
                ["MTH_RAW", "MTH_ORG", "PtAsset"],
                ["MTH_KIT", "MTH_ORG", "PtPickAssembly"],
                ["MTH_HIDDEN", "MTH_OTHER", "PtAsset"]
            ])
                call("create#mantle.product.Product", {
                    productId: id,
                    productName: id,
                    ownerPartyId: owner,
                    productTypeEnumId: type,
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.product.ProductAssoc", {
                productId: "MTH_KIT",
                toProductId: "MTH_RAW",
                productAssocTypeEnumId: "PatMfgBom",
                fromDate: "2000-01-01T00:00:00Z",
                quantity: 2
            })
            call("create#mantle.facility.Facility", {
                facilityId: "MTH_CENTER",
                facilityName: "Method center",
                ownerPartyId: "MTH_ORG",
                facilityTypeEnumId: "FcTpWarehouse"
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
feature(
    "engineers stage components with immutable identity and Products administrators cannot substitute for Manufacturing roles",
    {
        when() {
            return as("mth_engineer", () => {
                const created = invoke(S + "store#Bom", {
                    productId: "MTH_FIN",
                    organizationPartyId: "MTH_ORG",
                    changeReason: "Initial method"
                })
                bomId = created.productBom?.productBomId
                const line = invoke(S + "store#BomItem", {
                    productBomId: bomId,
                    productId: "MTH_RAW",
                    quantity: 2,
                    scrapFactor: 0.1,
                    changeReason: "Material requirement"
                })
                firstLine = line.bomItemId
                const invalid = invoke(S + "store#BomItem", {
                        productBomId: bomId,
                        productId: "MTH_RAW",
                        quantity: 0,
                        changeReason: "Refused"
                    }),
                    hidden = invoke(S + "store#BomItem", {
                        productBomId: bomId,
                        productId: "MTH_HIDDEN",
                        quantity: 1,
                        changeReason: "Refused"
                    })
                return {
                    created,
                    line,
                    invalid,
                    hidden,
                    admin: as("mth_product_admin", () => invoke(S + "get#BomDetail", {productBomId: bomId}))
                }
            })
        },
        then({created, line, invalid, hidden, admin}) {
            created.error == ""
            line.error == ""
            line.draftItemRows.length == 1
            line.draftItemRows[0].bomItemId == firstLine
            invalid.error.includes("positive")
            hidden.error.includes("not available")
            admin.error.includes("Manufacturing")
        }
    }
)
feature("approval stamps lines and audit references preserve the approved header despite a later draft edit", {
    when() {
        const approved = as("mth_approver", () => {
            const reviewed = call(S + "get#BomDetail", {productBomId: bomId})
            const out = invoke(S + "release#BomDraft", {
                productBomId: bomId,
                expectedRevision: reviewed.expectedRevision,
                changeReason: "First approved method"
            })
            firstDate = out.releaseHistory?.[0]?.fromDate
            return out
        })
        const edited = as("mth_engineer", () =>
            invoke(S + "store#Bom", {
                productBomId: bomId,
                bomName: "Next draft header",
                baseQuantity: 10,
                changeReason: "Future header draft"
            })
        )
        const historical = as("mth_reader", () => invoke(S + "get#BomDetail", {productBomId: bomId, asOfDate: firstDate}))
        return {approved, edited, historical}
    },
    then({approved, edited, historical}) {
        approved.error == ""
        approved.bomItemRows[0].bomItemId == firstLine
        approved.draftItemRows.length == 0
        edited.error == ""
        historical.approvedHeader.baseQuantity == "1"
        historical.productBom.baseQuantity == 10
        historical.approvedHeader.bomName == "MTH_FIN"
    }
})
feature("dated replacements preserve old requirements, reject stale approvals and compare by lineage", {
    when() {
        const before = as("mth_reader", () =>
            invoke(S + "get#BomExplosion", {productBomId: bomId, asOfDate: firstDate, quantity: 3})
        )
        const staged = as("mth_engineer", () =>
            invoke(S + "store#BomItem", {bomItemId: firstLine, quantity: 4, changeReason: "More raw material"})
        )
        const stale = as("mth_approver", () =>
            invoke(S + "release#BomDraft", {productBomId: bomId, expectedRevision: "stale", changeReason: "Refused"})
        )
        const approved = as("mth_approver", () => {
            const d = call(S + "get#BomDetail", {productBomId: bomId})
            return invoke(S + "release#BomDraft", {
                productBomId: bomId,
                expectedRevision: d.expectedRevision,
                changeReason: "Second approved method"
            })
        })
        secondDate = approved.releaseHistory?.[0]?.fromDate
        const compared = as("mth_reader", () =>
                invoke(S + "compare#BomDates", {productBomId: bomId, leftDate: firstDate, rightDate: secondDate})
            ),
            after = as("mth_reader", () =>
                invoke(S + "get#BomExplosion", {productBomId: bomId, asOfDate: secondDate, quantity: 3})
            )
        return {
            before,
            staged,
            stale,
            approved,
            compared,
            after,
            old: one("mantle.product.bom.ProductBomItem", {bomItemId: firstLine})?.getMap()
        }
    },
    then({before, staged, stale, approved, compared, after, old}) {
        before.error == ""
        before.explosionRows[0].grossQuantity == "6.6"
        staged.error == ""
        staged.bomItemId != firstLine
        stale.error.includes("changed")
        approved.error == ""
        compared.comparisonRows.length == 1
        compared.comparisonRows[0].changeType == "Changed"
        compared.headerChanges.some(r => r.field === "baseQuantity")
        toDecimal(after.explosionRows[0].grossQuantity).compare("1.32") == 0
        old.quantity == 2
        old.thruDate != null
    }
})
feature("kits stay read only in where-used and never become manufacturing BOMs", {
    when() {
        return as("mth_engineer", () => ({
            used: invoke(S + "get#BomWhereUsed", {productId: "MTH_RAW", organizationPartyId: "MTH_ORG"}),
            kit: invoke(S + "store#Bom", {productId: "MTH_KIT", organizationPartyId: "MTH_ORG", changeReason: "Refused"}),
            imported: invoke(S + "import#LegacyBom", {
                productId: "MTH_KIT",
                organizationPartyId: "MTH_ORG",
                changeReason: "Skip kit"
            })
        }))
    },
    then({used, kit, imported}) {
        used.error == ""
        used.whereUsedRows.some(r => r.productId === "MTH_KIT" && r.readOnly)
        used.whereUsedRows.some(r => r.productBomId === bomId)
        kit.error.includes("never")
        imported.skipped == true
    }
})
feature("resources and hourly rates require separate roles and released operation standards stay unchanged by draft edits", {
    when() {
        const center = as("mth_resource", () =>
            invoke(R + "store#WorkCenter", {
                organizationPartyId: "MTH_ORG",
                facilityId: "MTH_CENTER",
                efficiencyPercent: 90,
                changeReason: "Production center"
            })
        )
        const rate = as("mth_resource", () =>
            invoke(R + "store#WorkCenterRate", {
                organizationPartyId: "MTH_ORG",
                facilityId: "MTH_CENTER",
                componentTypeEnumId: "PccLabor",
                rateAmount: 30,
                priceUomId: "USD",
                approve: true,
                changeReason: "Approved labor hourly rate"
            })
        )
        const route = as("mth_engineer", () =>
            invoke(R + "store#Routing", {
                organizationPartyId: "MTH_ORG",
                workEffortName: "Method routing",
                changeReason: "Initial routing"
            })
        )
        routeId = route.routing?.workEffortId
        const op = as("mth_engineer", () =>
            invoke(R + "store#RoutingOperation", {
                workEffortId: routeId,
                workEffortName: "Assemble",
                estimatedSetupTime: 30,
                estimatedWorkTime: 12,
                timeUomId: "TF_min",
                methodBatchQuantity: 2,
                methodQuantityUomId: "OTH_ea",
                methodWorkCenterId: "MTH_CENTER",
                changeReason: "Operation standards"
            })
        )
        opId = op.operationWorkEffortId
        const approval = as("mth_approver", () => {
                const d = call(R + "get#RoutingDetail", {workEffortId: routeId})
                return invoke(R + "release#RoutingDraft", {
                    workEffortId: routeId,
                    expectedRevision: d.expectedRevision,
                    changeReason: "Routing approval"
                })
            }),
            date = approval.releaseHistory?.[0]?.fromDate
        const draft = as("mth_engineer", () =>
            invoke(R + "store#RoutingOperation", {
                operationWorkEffortId: opId,
                estimatedWorkTime: 120,
                changeReason: "Next standards draft"
            })
        )
        const historical = as("mth_engineer", () => invoke(R + "get#RoutingDetail", {workEffortId: routeId, asOfDate: date})),
            timesHidden = as("mth_reader", () => invoke(R + "get#RoutingDetail", {workEffortId: routeId, asOfDate: date})),
            noMoney = as("mth_reader", () =>
                invoke(R + "get#OperationCostBasis", {workEffortId: routeId, asOfDate: date, quantity: 4, priceUomId: "USD"})
            ),
            valued = as("mth_resource", () =>
                invoke(R + "get#OperationCostBasis", {workEffortId: routeId, asOfDate: date, quantity: 4, priceUomId: "USD"})
            )
        const denied = as("mth_engineer", () =>
            invoke(R + "store#WorkCenterRate", {
                organizationPartyId: "MTH_ORG",
                facilityId: "MTH_CENTER",
                rateAmount: 999,
                changeReason: "Refused"
            })
        )
        return {center, rate, route, op, approval, draft, historical, timesHidden, noMoney, valued, denied}
    },
    then({center, rate, route, op, approval, draft, historical, timesHidden, noMoney, valued, denied}) {
        center.error == ""
        rate.error == ""
        route.error == ""
        op.error == ""
        approval.error == ""
        draft.error == ""
        historical.releasedOperationRows[0].runTime == 12
        historical.operationRows[0].estimatedWorkTime == 120
        historical.standardTimesShown == true
        timesHidden.standardTimesShown == false
        timesHidden.releasedOperationRows[0].runTime == null
        timesHidden.operationRows[0].estimatedWorkTime == null
        timesHidden.releasedOperationRows[0].workEffortName == "Assemble"
        noMoney.error.includes("cost-read")
        valued.error == ""
        toDecimal(valued.operationCostRows.find(r => r.componentTypeEnumId === "PccLabor").amount).compare(27) == 0
        valued.operationCostRows.find(r => r.componentTypeEnumId === "PccOverhead").amount == null
        valued.complete == false
        denied.error.includes("resources")
    }
})
feature("recursive methods apply feature conditions, add scrap and reject cycles at approval", {
    when() {
        const sub = as("mth_engineer", () =>
            call(S + "store#Bom", {productId: "MTH_SUB", organizationPartyId: "MTH_ORG", changeReason: "Subassembly method"})
        ).productBom.productBomId
        as("mth_engineer", () =>
            call(S + "store#BomItem", {
                productBomId: sub,
                productId: "MTH_RAW",
                quantity: 3,
                scrapFactor: 0.2,
                changeReason: "Subassembly requirement"
            })
        )
        as("mth_approver", () => {
            const d = call(S + "get#BomDetail", {productBomId: sub})
            call(S + "release#BomDraft", {
                productBomId: sub,
                expectedRevision: d.expectedRevision,
                changeReason: "Subassembly release"
            })
        })
        as("mth_engineer", () => {
            call(S + "store#BomItem", {
                productBomId: bomId,
                productId: "MTH_SUB",
                quantity: 2,
                changeReason: "Nested subassembly"
            })
            call(S + "store#BomItem", {
                productBomId: sub,
                productId: "MTH_FIN",
                quantity: 1,
                changeReason: "Proposed circular material"
            })
        })
        const invalid = as("mth_approver", () => {
            const d = call(S + "get#BomDetail", {productBomId: bomId})
            return invoke(S + "release#BomDraft", {
                productBomId: bomId,
                expectedRevision: d.expectedRevision,
                changeReason: "No cycle yet because child draft is not released"
            })
        })
        const cycle = as("mth_approver", () => {
            const d = call(S + "get#BomDetail", {productBomId: sub})
            return invoke(S + "release#BomDraft", {
                productBomId: sub,
                expectedRevision: d.expectedRevision,
                changeReason: "Cycle refused"
            })
        })
        const explosion = as("mth_reader", () => invoke(S + "get#BomExplosion", {productBomId: bomId, quantity: 10}))
        return {invalid, cycle, explosion}
    },
    then({invalid, cycle, explosion}) {
        invalid.error == ""
        cycle.error.includes("cycle")
        explosion.error == ""
        explosion.complete == true
        explosion.explosionRows.some(
            r => r.productId === "MTH_RAW" && r.depth == 2 && toDecimal(r.grossQuantity).compare("7.2") == 0
        )
    }
})
feature("method files and native record visibility retain role guards with authorization disabled", {
    when() {
        const file = as("mth_engineer", () =>
            invoke(S + "create#ProductBomContent", {
                productBomId: bomId,
                contentText: "Approved procedure evidence",
                filename: "method.txt"
            })
        )
        const reader = as("mth_reader", () =>
            invoke(S + "create#ProductBomContent", {productBomId: bomId, contentText: "Refused"})
        )
        const hidden = as("mth_product_admin", () =>
            call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                recordEntityName: "mantle.product.bom.ProductBom",
                recordId: bomId,
                checkOnly: true
            })
        )
        const visible = as("mth_reader", () =>
            call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                recordEntityName: "mantle.product.bom.ProductBom",
                recordId: bomId,
                checkOnly: true
            })
        )
        return {file, reader, hidden, visible}
    },
    then({file, reader, hidden, visible}) {
        file.error == ""
        file.contentLocation.startsWith("dbresource://mantle/content/bom/")
        reader.error.includes("edit")
        hidden.recordVisible == false
        visible.recordVisible == true
        visible.contentEntity.entityName == "mantle.product.bom.ProductBomContent"
    }
})
feature("routing dependency and resource changes retain dated evidence and cannot remove an operation referenced by a BOM", {
    when() {
        const equipment = as("mth_engineer", () =>
            invoke(R + "store#RoutingResource", {
                operationWorkEffortId: opId,
                assetProductId: "MTH_RAW",
                estimatedQuantity: 2,
                estimatedDuration: 1,
                changeReason: "Equipment requirement"
            })
        )
        const cycle = as("mth_engineer", () =>
                invoke(R + "store#RoutingOperation", {
                    operationWorkEffortId: opId,
                    methodPredecessorIds: opId,
                    changeReason: "Dependency cycle draft"
                })
            ),
            refused = as("mth_approver", () => {
                const d = call(R + "get#RoutingDetail", {workEffortId: routeId})
                return invoke(R + "release#RoutingDraft", {
                    workEffortId: routeId,
                    expectedRevision: d.expectedRevision,
                    changeReason: "Dependency refused"
                })
            })
        as("mth_engineer", () =>
            call(R + "store#RoutingOperation", {
                operationWorkEffortId: opId,
                methodPredecessorIds: "",
                changeReason: "Remove dependency cycle"
            })
        )
        const approved = as("mth_approver", () => {
                const d = call(R + "get#RoutingDetail", {workEffortId: routeId})
                return invoke(R + "release#RoutingDraft", {
                    workEffortId: routeId,
                    expectedRevision: d.expectedRevision,
                    changeReason: "Equipment and standards approval"
                })
            }),
            date = approved.releaseHistory?.[0]?.fromDate
        as("mth_engineer", () =>
            call(R + "store#RoutingResource", {
                operationWorkEffortId: opId,
                assetProductId: "MTH_RAW",
                estimatedQuantity: 5,
                estimatedDuration: 2,
                changeReason: "Future equipment draft"
            })
        )
        const historical = as("mth_reader", () => invoke(R + "get#RoutingDetail", {workEffortId: routeId, asOfDate: date}))
        return {equipment, cycle, refused, approved, historical}
    },
    then({equipment, cycle, refused, approved, historical}) {
        equipment.error == ""
        cycle.error == ""
        refused.error.includes("cycle")
        approved.error == ""
        historical.error == ""
        historical.releasedOperationRows[0].resources[0].estimatedQuantity == "2"
        historical.operationRows[0].resources[0].estimatedQuantity == 5
    }
})
feature(
    "feature applicability uses a complete feature set and missing explicit units refuse invalid legacy branches independently",
    {
        when() {
            as("john.doe", () =>
                call("create#mantle.product.feature.ProductFeature", {
                    productFeatureId: "MTH_BLUE",
                    description: "Blue",
                    ownerPartyId: "MTH_ORG",
                    productFeatureTypeEnumId: "PftColor"
                })
            )
            const conditional = as("mth_engineer", () => {
                const b = call(S + "find#Boms", {organizationPartyId: "MTH_ORG", productId: "MTH_SUB"}).bomRows[0].productBomId,
                    d = call(S + "get#BomDetail", {productBomId: b})
                call(S + "store#BomItem", {
                    bomItemId: d.draftItemRows[0].bomItemId,
                    applicabilityFeatureIds: "MTH_BLUE",
                    changeReason: "Conditional circular requirement"
                })
                return b
            })
            const check = as("mth_approver", () => invoke(S + "validate#BomDraft", {productBomId: conditional}))
            const id = as("mth_engineer", () => {
                const b = call(S + "store#Bom", {
                    productId: "MTH_FIN",
                    organizationPartyId: "MTH_ORG",
                    methodCode: "FEATURES",
                    changeReason: "Feature method"
                }).productBom.productBomId
                call(S + "store#BomItem", {
                    productBomId: b,
                    productId: "MTH_RAW",
                    componentProductBomId: null,
                    quantity: 1,
                    applicabilityFeatureIds: "MTH_BLUE",
                    changeReason: "Blue requirement"
                })
                return b
            })
            const approval = as("mth_approver", () => {
                const d = call(S + "get#BomDetail", {productBomId: id})
                return invoke(S + "release#BomDraft", {
                    productBomId: id,
                    expectedRevision: d.expectedRevision,
                    changeReason: "Feature approval"
                })
            })
            const absent = as("mth_reader", () => invoke(S + "get#BomExplosion", {productBomId: id})),
                present = as("mth_reader", () =>
                    invoke(S + "get#BomExplosion", {productBomId: id, productFeatureIds: ["MTH_BLUE"]})
                )
            return {check, approval, absent, present}
        },
        then({check, approval, absent, present}) {
            check.valid == false
            check.findings.some(r => r.message.includes("cycle"))
            approval.error == ""
            absent.explosionRows[0].applicable == false
            absent.requirements.length == 0
            present.explosionRows[0].applicable == true
            present.requirements.length == 1
        }
    }
)
feature("release validates the output unit against stock and every routed batch unit", {
    when() {
        const route = as("mth_engineer", () => {
            const r = call(R + "store#Routing", {
                    organizationPartyId: "MTH_ORG",
                    workEffortName: "Mass-based route",
                    changeReason: "Unit validation fixture"
                }),
                id = r.routing.workEffortId
            call(R + "store#RoutingOperation", {
                workEffortId: id,
                workEffortName: "Mass batch",
                methodBatchQuantity: 1,
                methodQuantityUomId: "WT_kg",
                changeReason: "Mass standards"
            })
            return id
        })
        as("mth_approver", () => {
            const r = call(R + "get#RoutingDetail", {workEffortId: route})
            call(R + "release#RoutingDraft", {
                workEffortId: route,
                expectedRevision: r.expectedRevision,
                changeReason: "Approve unit fixture"
            })
        })
        const findings = []
        for (const [code, unit, routing] of [
            ["BAD_STOCK_UNIT", "LEN_m", null],
            ["BAD_BATCH_UNIT", "OTH_ea", route]
        ]) {
            const id = as("mth_engineer", () => {
                const b = call(S + "store#Bom", {
                    productId: "MTH_FIN",
                    organizationPartyId: "MTH_ORG",
                    methodCode: code,
                    quantityUomId: unit,
                    routingWorkEffortId: routing,
                    changeReason: "Invalid conversion draft"
                }).productBom.productBomId
                call(S + "store#BomItem", {productBomId: b, productId: "MTH_RAW", quantity: 1, changeReason: "Material fixture"})
                return b
            })
            findings.push(
                as("mth_approver", () => {
                    const d = call(S + "get#BomDetail", {productBomId: id})
                    return invoke(S + "release#BomDraft", {
                        productBomId: id,
                        expectedRevision: d.expectedRevision,
                        changeReason: "Unit mismatch refused"
                    })
                })
            )
        }
        return {findings}
    },
    then({findings}) {
        findings.length == 2
        findings.every(r => r.error.includes("Incompatible units"))
    }
})
feature("generic record callbacks guard method child rows, decisions, financial rates and the raw audit source", {
    when() {
        const ids = as("john.doe", () => ({
            line: firstLine,
            decision: one("mantle.work.method.MethodReleaseDecision", {
                methodEntityName: "mantle.product.bom.ProductBom",
                methodId: bomId
            }).methodReleaseDecisionId,
            rate: one("mantle.work.production.WorkCenterRate", {facilityId: "MTH_CENTER"}).workCenterRateId,
            audit: one("moqui.entity.EntityAuditLog", {
                changedEntityName: "mantle.work.production.WorkCenterRate",
                changedFieldName: "rateAmount"
            }).auditHistorySeqId
        }))
        const pairs = [
            ["mantle.product.bom.ProductBomItem", ids.line],
            ["mantle.work.method.MethodReleaseDecision", ids.decision],
            ["mantle.work.production.WorkCenterRate", ids.rate],
            ["moqui.entity.EntityAuditLog", ids.audit]
        ]
        const probe = user =>
            as(user, () =>
                pairs.map(
                    ([entity, id]) =>
                        call("mantle.party.CommunicationServices.get#RecordLinkInfo", {
                            recordEntityName: entity,
                            recordId: id,
                            checkOnly: true
                        }).recordVisible
                )
            )
        return {admin: probe("mth_product_admin"), reader: probe("mth_reader"), finance: probe("mth_resource")}
    },
    then({admin, reader, finance}) {
        admin.every(v => v === false)
        reader[0] == true
        reader[1] == true
        reader[2] == false
        reader[3] == false
        finance.every(v => v === true)
    }
})
