// Manufacturing P2's method services (impl-manufacturing P2): operation templates and their dated instructions, copying
// them into a routing, the release request and its notices, a BOM consuming at the routing's second operation, the
// validation's cycle and overlapping window, the clone, and the BOM and routing CSV imports. Its own organization, users in
// spec-local groups holding the Moqui permissions, products and work center; nothing from BOSS.
const S = "mantle.product.BomServices.",
    R = "mantle.work.RoutingServices."
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one(),
    list = (n, p) => Array.from(find(n, p).list())
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
const ORG = "MTT_ORG"
let cutId, weldId, routeId, bomId
spec({
    setupSpec() {
        as("john.doe", () => {
            const groups = {
                MTT_METHOD_VIEW: ["METHOD_VIEW"],
                MTT_METHOD_EDIT: ["METHOD_VIEW", "METHOD_EDIT"],
                MTT_METHOD_APPROVE: ["METHOD_VIEW", "METHOD_APPROVE"]
            }
            for (const [group, permissions] of Object.entries(groups)) {
                call("create#moqui.security.UserGroup", {userGroupId: group})
                for (const permission of permissions)
                    call("create#moqui.security.UserGroupPermission", {
                        userGroupId: group,
                        userPermissionId: permission,
                        fromDate: "2000-01-01T00:00:00Z"
                    })
            }
            for (const id of [ORG, "MTT_OTHER"]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            for (const [id, group] of [
                ["MTT_ENGINEER", "MTT_METHOD_EDIT"],
                ["MTT_APPROVER", "MTT_METHOD_APPROVE"],
                ["MTT_READER", "MTT_METHOD_VIEW"]
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
                    toPartyId: ORG,
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
            for (const [id, owner, type] of [
                ["MTT_FIN", ORG, "PtAsset"],
                ["MTT_FIN2", ORG, "PtAsset"],
                ["MTT_SUB", ORG, "PtAsset"],
                ["MTT_RAW", ORG, "PtAsset"],
                ["MTT_KIT", ORG, "PtPickAssembly"]
            ])
                call("create#mantle.product.Product", {
                    productId: id,
                    productName: id,
                    ownerPartyId: owner,
                    productTypeEnumId: type,
                    amountUomId: "OTH_ea"
                })
            call("create#mantle.facility.Facility", {
                facilityId: "MTT_CENTER",
                facilityName: "Template line",
                ownerPartyId: ORG,
                facilityTypeEnumId: "FcTpWarehouse"
            })
            call("create#mantle.work.production.WorkCenter", {facilityId: "MTT_CENTER", changeReason: "Spec line"})
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
    }
})
const template = name => ({
    organizationPartyId: ORG,
    workEffortName: name,
    estimatedSetupTime: 0.5,
    estimatedWorkTime: 0.1,
    timeUomId: "TF_hr",
    methodBatchQuantity: 1,
    methodQuantityUomId: "OTH_ea",
    methodWorkCenterId: "MTT_CENTER",
    methodRequiredEvidence: "Photo of the joint",
    changeReason: "Operation catalogue"
})
feature("an engineer keeps operation templates and publishes dated instructions; a reader reads them without times", {
    when() {
        return as("mtt_engineer", () => {
            const cut = invoke(R + "store#OperationTemplate", template("Cut")),
                weld = invoke(R + "store#OperationTemplate", template("Weld"))
            cutId = cut.template?.workEffortId
            weldId = weld.template?.workEffortId
            const first = invoke(R + "store#OperationInstruction", {
                workEffortId: weldId,
                contentText: "# Weld\nClamp, tack, weld.",
                filename: "weld.md",
                changeReason: "First instruction"
            })
            const second = invoke(R + "store#OperationInstruction", {
                workEffortId: weldId,
                contentText: "# Weld\nClamp, tack, weld, inspect.",
                filename: "weld.md",
                fromDate: Date.now() + 60000,
                changeReason: "Second instruction"
            })
            const noUnit = invoke(R + "store#OperationTemplate", Object.assign(template("No unit"), {methodQuantityUomId: null}))
            const reader = as("mtt_reader", () => ({
                found: invoke(R + "find#OperationTemplates", {organizationPartyId: ORG, text: "WELD"}),
                store: invoke(R + "store#OperationTemplate", template("Refused"))
            }))
            return {cut, weld, first, second, noUnit, reader}
        })
    },
    then({cut, weld, first, second, noUnit, reader}) {
        cut.error == ""
        weld.error == ""
        weld.template.methodRequiredEvidence == "Photo of the joint"
        first.error == ""
        first.instructionRows[0].contentChecksum.length == 64
        second.error == ""
        second.instructionRows.length == 2
        // the first is in effect until the second starts
        second.instructionRows[1].thruDate != null
        second.template.instruction.workEffortContentId == first.workEffortContentId
        noUnit.error.includes("unit")
        reader.found.error == ""
        reader.found.templateRows.length == 1
        reader.found.templateRows[0].estimatedSetupTime === undefined
        reader.found.templateRows[0].instruction != null
        reader.store.error.includes("edit authority")
    }
})
feature("a routing is built from two templates; archive blocks new copies; only the approver releases, on request", {
    when() {
        const built = as("mtt_engineer", () => {
            const route = invoke(R + "store#Routing", {organizationPartyId: ORG, workEffortName: "Frame", changeReason: "New"})
            routeId = route.routing?.workEffortId
            const copied = invoke(R + "copy#RoutingOperations", {
                workEffortId: routeId,
                sourceWorkEffortIds: [cutId, weldId],
                changeReason: "From the catalogue"
            })
            const archived = invoke(R + "store#OperationTemplate", {
                workEffortId: cutId,
                methodArchived: "Y",
                changeReason: "Retired cut"
            })
            const blocked = invoke(R + "copy#RoutingOperations", {
                workEffortId: routeId,
                sourceWorkEffortIds: [cutId],
                changeReason: "Refused"
            })
            const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
            const release = invoke(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Refused"
            })
            const requested = invoke(R + "request#RoutingRelease", {workEffortId: routeId, changeReason: "Ready"})
            return {route, copied, archived, blocked, release, requested}
        })
        const inbox = () =>
            list("moqui.security.user.NotificationMessage", {topic: "RoutingRelease", recordId: routeId}).flatMap(message =>
                list("moqui.security.user.NotificationMessageUser", {notificationMessageId: message.notificationMessageId})
            )
        const before = inbox().map(row => ({userId: row.userId, viewed: !!row.viewedDate}))
        const released = as("mtt_approver", () => {
            const detail = call(R + "get#RoutingDetail", {workEffortId: routeId})
            return invoke(R + "release#RoutingDraft", {
                workEffortId: routeId,
                expectedRevision: detail.expectedRevision,
                changeReason: "Frame routing approved"
            })
        })
        return Object.assign(built, {before, after: inbox().map(row => !!row.viewedDate), released})
    },
    then({copied, archived, blocked, release, requested, before, after, released}) {
        copied.error == ""
        copied.copiedOperationIds.length == 2
        copied.operationRows.length == 2
        copied.operationRows.map(o => o.workEffortName).join(",") == "Cut,Weld"
        one("mantle.work.effort.WorkEffort", {workEffortId: copied.copiedOperationIds[1]}).methodSourceWorkEffortId == weldId
        archived.error == ""
        blocked.error.includes("archived")
        release.error.includes("approve authority")
        requested.error == ""
        requested.notified == true
        before.some(row => row.userId === "MTT_APPROVER" && !row.viewed)
        !before.some(row => row.userId === "MTT_ENGINEER")
        released.error == ""
        released.releasedOperationRows.length == 2
        after.length > 0 && after.every(Boolean)
    }
})
feature("a BOM consumes at the second operation; validation names a cycle and an overlapping window", {
    when() {
        const ops = as("mtt_reader", () => call(R + "get#RoutingDetail", {workEffortId: routeId})).releasedOperationRows
        const engineer = as("mtt_engineer", () => {
            const bom = invoke(S + "store#Bom", {
                productId: "MTT_FIN",
                organizationPartyId: ORG,
                routingWorkEffortId: routeId,
                changeReason: "Frame method"
            })
            bomId = bom.productBom?.productBomId
            const line = invoke(S + "store#BomItem", {
                productBomId: bomId,
                productId: "MTT_RAW",
                quantity: 2,
                operationWorkEffortId: ops[1].workEffortId,
                changeReason: "Consumed at welding"
            })
            const sub = call(S + "store#Bom", {productId: "MTT_SUB", organizationPartyId: ORG, changeReason: "Sub"}).productBom
            call(S + "store#BomItem", {productBomId: sub.productBomId, productId: "MTT_FIN", quantity: 1, changeReason: "Loop"})
            return {bom, line, sub}
        })
        const approve = id =>
            as("mtt_approver", () => {
                const d = call(S + "get#BomDetail", {productBomId: id})
                return invoke(S + "release#BomDraft", {
                    productBomId: id,
                    expectedRevision: d.expectedRevision,
                    changeReason: "Ok"
                })
            })
        const first = approve(bomId),
            sub = approve(engineer.sub.productBomId)
        const cycle = as("mtt_engineer", () => {
            call(S + "store#BomItem", {productBomId: bomId, productId: "MTT_SUB", quantity: 1, changeReason: "Makes a loop"})
            return invoke(S + "validate#BomDraft", {productBomId: bomId})
        })
        // a release scheduled ahead: a draft validated for before it overlaps its window
        const later = Date.now() + 3600000
        const scheduled = as("mtt_approver", () => {
            const d = call(S + "get#BomDetail", {productBomId: engineer.sub.productBomId})
            return invoke(S + "release#BomDraft", {
                productBomId: engineer.sub.productBomId,
                expectedRevision: d.expectedRevision,
                fromDate: later,
                changeReason: "Scheduled"
            })
        })
        const overlap = as("mtt_engineer", () => {
            call(S + "store#BomItem", {
                productBomId: engineer.sub.productBomId,
                productId: "MTT_RAW",
                quantity: 1,
                changeReason: "Another draft"
            })
            return invoke(S + "validate#BomDraft", {productBomId: engineer.sub.productBomId})
        })
        const lineRow = one("mantle.product.bom.ProductBomItem", {bomItemId: engineer.line.bomItemId})
        return {engineer, first, sub, cycle, scheduled, overlap, lineRow, secondOp: ops[1].workEffortId}
    },
    then({engineer, first, sub, cycle, scheduled, overlap, lineRow, secondOp}) {
        engineer.bom.error == ""
        engineer.line.error == ""
        first.error == ""
        first.bomItemRows[0].operationWorkEffortId == secondOp
        sub.error == ""
        cycle.valid == false
        cycle.findings.some(f => f.message.includes("BOM cycle"))
        scheduled.error == ""
        overlap.valid == false
        overlap.findings.some(f => f.message.includes("Overlapping effective window"))
        lineRow.state == "released"
    }
})
feature("a clone copies the released method as drafts; CSV imports apply the good version and name the bad one", {
    when() {
        return as("mtt_engineer", () => {
            const clone = invoke(S + "clone#Bom", {
                productBomId: bomId,
                methodCode: "ALT",
                asOfDate: ec.user.nowTimestamp,
                changeReason: "Alternative"
            })
            const bomCsv = [
                "productId,methodCode,componentProductId,quantity,quantityUomId",
                "MTT_FIN2,MAIN,MTT_RAW,3,OTH_ea",
                "MTT_SUB,CSV,MTT_RAW,1,NOT_A_UNIT",
                "MTT_KIT,MAIN,MTT_RAW,1,OTH_ea"
            ].join("\n")
            const preview = invoke(S + "import#BomCsv", {organizationPartyId: ORG, csvText: bomCsv, changeReason: "Import"})
            const applied = invoke(S + "import#BomCsv", {
                organizationPartyId: ORG,
                csvText: bomCsv,
                preview: false,
                changeReason: "Import"
            })
            const routingCsv = [
                "routingName,operationName,setupTime,runTime,quantityUomId,workCenterId",
                "Paint,Prime,0.2,0.05,OTH_ea,MTT_CENTER",
                "Paint,Coat,0.2,0.05,OTH_ea,MTT_CENTER",
                "Pack,Box,0,0.01,OTH_ea,NO_CENTER"
            ].join("\n")
            const routes = invoke(R + "import#RoutingCsv", {
                organizationPartyId: ORG,
                csvText: routingCsv,
                preview: false,
                changeReason: "Import"
            })
            const reader = as("mtt_reader", () =>
                invoke(S + "import#BomCsv", {organizationPartyId: ORG, csvText: bomCsv, changeReason: "Refused"})
            )
            return {clone, preview, applied, routes, reader}
        })
    },
    then({clone, preview, applied, routes, reader}) {
        clone.error == ""
        clone.productBom.methodCode == "ALT"
        clone.draftItemRows.length == 1
        preview.error == ""
        preview.preview == true
        preview.readyCount == 1
        preview.versionRows.find(v => v.productId === "MTT_SUB").status == "failed"
        preview.versionRows.find(v => v.productId === "MTT_KIT").status == "skipped"
        applied.importedCount == 1
        applied.failedCount == 1
        applied.versionRows.find(v => v.productId === "MTT_SUB").messages[0].includes("Line 3")
        list("mantle.product.bom.ProductBom", {productId: "MTT_FIN2"}).length == 1
        list("mantle.product.bom.ProductBomItem", {productBomId: applied.versionRows[0].recordId, state: "draft"}).length == 1
        list("mantle.product.bom.ProductBom", {productId: "MTT_SUB", methodCode: "CSV"}).length == 0
        routes.importedCount == 1
        routes.failedCount == 1
        list("mantle.work.effort.WorkEffort", {parentWorkEffortId: routes.versionRows[0].recordId}).length == 2
        reader.error.includes("edit authority")
    }
})
