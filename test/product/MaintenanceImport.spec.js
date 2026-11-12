// The equipment import (mantle.product.MaintenanceImportServices validate#, apply#EquipmentImportRow and
// find#EquipmentImportScopes, MaintenanceImport.js; the framework's import target `equipment` through
// org.moqui.admin.DataTransferServices; IronStone Maintenance design §6 EquipmentImport, §12; impl-maintenance P18, F36, F51):
// a holder of MAINTENANCE_RESOURCE_EDIT without MAINTENANCE_IMPORT is refused, and a user with no maintenance permission gets no
// organization and no row checked (the row services are every user's to call); a row naming another organization's equipment
// or location is refused while the next rows are applied, and another organization's source key is not this one's (P18 review
// R1); a row that fails at apply does not stop the next; equipment whose source key is another is refused; the same file
// applied twice makes one asset with one starting reading; a starting reading below the last one of a counting meter is refused.
// Standalone: spec-local organizations, facilities, a model with a counting hour meter, groups and users; artifact
// authorization on, as the wizard calls the steps.
// Run: ./moq test mr-mantle --spec MaintenanceImport
const prefix = "MNT_IMP_SPEC"
const T = "org.moqui.admin.DataTransferServices."
const TARGET = "equipment"
const since = "2000-01-01T00:00:00Z"
const run = String(Date.now()).slice(-7)
const state = {}
const orgA = prefix + "_A",
    orgB = prefix + "_B"

function result(name, params) {
    try {
        const out =
            ec.service
                .sync()
                .name(name)
                .parameters(params || {})
                .call() || {}
        const error = ec.message.hasError() ? ec.message.getErrorsString() : ""
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message)}
    }
}
function as(username, action) {
    ec.user.internalLoginUser(username)
    ec.artifactExecution.enableAuthz()
    try {
        return action()
    } finally {
        ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
const step = (verb, params) => result(T + verb, Object.assign({targetId: TARGET}, params))
const rowOf = (out, itemSeqId) => Array.from(out.importRows || []).find(row => Number(row.itemSeqId) === itemSeqId)
const rows = (entityName, conditions) => Array.from(ec.entity.find(entityName).condition(conditions).disableAuthz().list())
// a file staged, validated and applied as the user (between, as the spec's administrator)
function importFile(username, organizationPartyId, content, between = null) {
    const checked = as(username, () => {
        const staged = step("stage#Import", {organizationPartyId, sourceText: content})
        if (!staged.operationKey) return {staged}
        const validated = step("validate#Import", {operationKey: staged.operationKey, mappingRevision: staged.mappingRevision})
        return {staged, validated}
    })
    if (!checked.validated) return checked
    if (between) between()
    const applied = as(username, () =>
        step("apply#Import", {operationKey: checked.staged.operationKey, inputFingerprint: checked.validated.inputFingerprint})
    )
    return Object.assign(checked, {applied})
}
const keyed = key =>
    rows("mantle.product.asset.AssetIdentification", {identificationTypeEnumId: "AitMntSourceKey", idValue: "CMMS / " + key})

function organization(partyId, name) {
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    call("create#mantle.party.Organization", {partyId, organizationName: name})
    call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function user(kind, permissions) {
    const id = prefix + "_U_" + kind + "_" + run
    const groupId = prefix + "_G_" + kind
    if (!rows("moqui.security.UserGroup", {userGroupId: groupId}).length) {
        call("create#moqui.security.UserGroup", {userGroupId: groupId, description: "Maintenance import " + kind})
        for (const permission of permissions)
            call("create#moqui.security.UserGroupPermission", {
                userGroupId: groupId,
                userPermissionId: permission,
                fromDate: since
            })
    }
    const partyId = prefix + "_P_" + kind + "_" + run
    call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId, firstName: "Maintenance import", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: partyId,
        toPartyId: orgA,
        toRoleTypeId: "OrgInternal",
        fromDate: since
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: groupId, fromDate: since})
    return id
}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        if (!rows("mantle.party.Party", {partyId: orgA}).length) {
            organization(orgA, "Maintenance Import Spec A")
            organization(orgB, "Maintenance Import Spec B")
            call("create#mantle.facility.Facility", {
                facilityId: prefix + "_SITE_A",
                facilityName: "Import site A",
                facilityTypeEnumId: "FcTpBuilding",
                ownerPartyId: orgA
            })
            call("create#mantle.facility.Facility", {
                facilityId: prefix + "_SITE_B",
                facilityName: "Import site B",
                facilityTypeEnumId: "FcTpBuilding",
                ownerPartyId: orgB
            })
            call("create#mantle.product.Product", {
                productId: prefix + "_MODEL",
                productName: "Import compressor model",
                productTypeEnumId: "PtAsset",
                assetTypeEnumId: "AstTpEquipment"
            })
            call("create#mantle.product.maintenance.ProductMeter", {
                productMeterId: prefix + "_HOURS",
                productId: prefix + "_MODEL",
                productMeterTypeId: "PdMtrMotorTime",
                meterName: "Hours",
                isCumulative: "Y"
            })
            // B's pump, with a source key of its own
            call("create#mantle.product.asset.Asset", {
                assetId: prefix + "_B_PUMP",
                assetTypeEnumId: "AstTpEquipment",
                assetName: "Import B pump",
                ownerPartyId: orgB,
                facilityId: prefix + "_SITE_B"
            })
            call("create#mantle.product.asset.AssetIdentification", {
                assetId: prefix + "_B_PUMP",
                identificationTypeEnumId: "AitMntSourceKey",
                idValue: "CMMS / B-PUMP"
            })
        }
        state.importer = user("IMPORTER", ["MAINTENANCE_IMPORT", "MAINTENANCE_RESOURCE_EDIT", "MAINTENANCE_RESOURCE_VIEW"])
        state.editor = user("EDITOR", ["MAINTENANCE_RESOURCE_EDIT", "MAINTENANCE_RESOURCE_VIEW"])
        state.none = user("NONE", [])
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature(
    "a holder of the resource edit permission without MAINTENANCE_IMPORT is refused; the importer's scopes are their organizations",
    {
        when() {
            const content =
                "Source system,Source key,Name,Location ID\nCMMS,EDIT-" + run + ",Edit only drill," + prefix + "_SITE_A\n"
            return {
                editor: as(state.editor, () => step("stage#Import", {organizationPartyId: orgA, sourceText: content})),
                target: as(state.importer, () => result(T + "get#ImportTarget", {targetId: TARGET, organizationPartyId: orgA})),
                otherOrg: as(state.importer, () => step("stage#Import", {organizationPartyId: orgB, sourceText: content})),
                // the row and scope services called directly by a user with no maintenance permission (P18 review)
                noneScopes: as(state.none, () =>
                    result("mantle.product.MaintenanceImportServices.find#EquipmentImportScopes", {targetId: TARGET})
                ),
                noneRow: as(state.none, () =>
                    result("mantle.product.MaintenanceImportServices.validate#EquipmentImportRow", {
                        targetId: TARGET,
                        scopeKey: orgA,
                        rowValues: {externalSource: "CMMS", externalKey: "B-PUMP", assetId: prefix + "_B_PUMP"}
                    })
                )
            }
        },
        then(r) {
            Array.from(r.noneScopes.scopeList || []).length == 0
            r.noneRow.error.includes("PERMISSION_DENIED")
            r.noneRow.valid !== true && !r.noneRow.displayText
            r.editor.error.includes("MAINTENANCE_IMPORT")
            !r.editor.operationKey
            Array.from(r.target.target.scopeList)
                .map(scope => scope.scopeKey)
                .join(",") == orgA
            r.target.target.importAllowed === true
            !!r.otherOrg.error
            keyed("EDIT-" + run).length == 0
        }
    }
)

feature("a row for another organization's equipment or location is refused and the other rows are applied; a source key is the organization's", {
    when() {
        const content = [
            "Source system,Source key,Existing equipment ID,Name,Location ID,Model ID,Meter type ID,Starting reading",
            "CMMS,C1-" + run + ",,Compressor C1," + prefix + "_SITE_A," + prefix + "_MODEL,PdMtrMotorTime,1200",
            "CMMS,B-OTHER-" + run + "," + prefix + "_B_PUMP,B's pump,,,,",
            "CMMS,B-PUMP,,A's pump keyed as B's,,,,",
            "CMMS,LOC-" + run + ",,Drill at B," + prefix + "_SITE_B,,,",
            "CMMS,C2-" + run + ",,Compressor C2," + prefix + "_SITE_A,,,"
        ].join("\n")
        return importFile(state.importer, orgA, content)
    },
    then(r) {
        r.validated.validCount == 3
        rowOf(r.validated, 2).errorMessage.includes("not available in this organization")
        rowOf(r.validated, 4).errorMessage.includes("not one of Maintenance Import Spec A")
        r.applied.appliedCount == 3
        r.applied.state == "partial"
        // B's source key names A's own new pump, and B's pump is untouched (R1)
        keyed("B-PUMP").filter(row => rows("mantle.product.asset.Asset", {assetId: row.assetId})[0].ownerPartyId == orgA).length == 1
        keyed("B-PUMP").some(row => row.assetId == prefix + "_B_PUMP")
        keyed("C1-" + run).length == 1
        keyed("C2-" + run).length == 1
        rows("mantle.product.asset.Asset", {assetId: prefix + "_B_PUMP"})[0].assetName == "Import B pump"
        rows("mantle.product.asset.Asset", {assetId: keyed("C1-" + run)[0].assetId})[0].ownerPartyId == orgA
        rows("mantle.product.maintenance.AssetMeter", {assetId: keyed("C1-" + run)[0].assetId}).length == 1
        String(rows("mantle.product.maintenance.AssetMeter", {assetId: keyed("C1-" + run)[0].assetId})[0].meterValue) == "1200"
    }
})

feature("the same file applied twice makes one asset and one starting reading; a lower starting reading is refused", {
    when() {
        const content = [
            "Source system,Source key,Name,Location ID,Model ID,Meter type ID,Starting reading",
            "CMMS,TWICE-" + run + ",Air handler," + prefix + "_SITE_A," + prefix + "_MODEL,PdMtrMotorTime,300"
        ].join("\n")
        const first = importFile(state.importer, orgA, content)
        const second = importFile(state.importer, orgA, content)
        const lower = importFile(state.importer, orgA, content.replace(",300", ",250"))
        return {first, second, lower}
    },
    then(r) {
        r.first.applied.appliedCount == 1
        r.second.applied.appliedCount == 1
        rowOf(r.second.applied, 1).result == "applied"
        keyed("TWICE-" + run).length == 1
        rows("mantle.product.asset.Asset", {assetName: "Air handler", ownerPartyId: orgA}).filter(
            asset => asset.assetId === keyed("TWICE-" + run)[0].assetId
        ).length == 1
        rows("mantle.product.maintenance.AssetMeter", {assetId: keyed("TWICE-" + run)[0].assetId}).length == 1
        r.lower.validated.validCount == 0
        rowOf(r.lower.validated, 1).errorMessage.includes("below the last one (300")
    }
})

feature("a row that fails at apply does not stop the next; equipment whose source key is another is refused", {
    when() {
        const siteX = prefix + "_SITE_X_" + run
        call("create#mantle.facility.Facility", {
            facilityId: siteX,
            facilityName: "Import site X",
            facilityTypeEnumId: "FcTpBuilding",
            ownerPartyId: orgA
        })
        const content = [
            "Source system,Source key,Name,Location ID",
            "CMMS,LATHE-" + run + ",Lathe," + siteX,
            "CMMS,MILL-" + run + ",Mill," + prefix + "_SITE_A"
        ].join("\n")
        // validated while site X is A's, applied after it became B's
        const moved = importFile(state.importer, orgA, content, () =>
            call("update#mantle.facility.Facility", {facilityId: siteX, ownerPartyId: orgB})
        )
        const millId = keyed("MILL-" + run)[0]?.assetId
        const rekeyed = importFile(state.importer, orgA, "Source system,Source key,Existing equipment ID,Name\nCMMS,MILL2-" + run + "," + millId + ",Mill")
        return {moved, millId, rekeyed}
    },
    then(r) {
        r.moved.validated.validCount == 2
        r.moved.applied.appliedCount == 1
        r.moved.applied.state == "partial"
        rowOf(r.moved.applied, 1).result != "applied"
        rowOf(r.moved.applied, 2).result == "applied"
        keyed("LATHE-" + run).length == 0
        !!r.millId
        r.rekeyed.validated.validCount == 0
        rowOf(r.rekeyed.validated, 1).errorMessage.includes("is source key CMMS / MILL-")
        keyed("MILL2-" + run).length == 0
    }
})
