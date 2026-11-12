// Maintenance's lookups and setup readiness (mantle.work.MaintenanceSettingsServices find#MaintenanceLookups,
// store#MaintenanceLookup and check#MaintenanceReadiness; IronStone Maintenance design §9 Settings Readiness and Lookups, MT-02,
// MT-04, MT-06, MT-10, MT-11; impl-maintenance P18). The work policy itself is MaintenanceWork.js's (get# and store#MaintenancePolicy).
//
// - Lookups: the Enumeration families Maintenance maintains, a whitelist. A vocabulary (work types, severities, hold and cancel
//   reasons, outcomes, failure modes) takes new values and ends them (Enumeration.thruDate, now or from a later date, People's
//   field); a fixed kind (the kinds, sources and dispositions, whose values the services act on) is renamed and reordered only:
//   renaming a label changes no meaning. A value is never deleted: the records that hold it keep it and no new choice offers it
//   once ended. A failure mode applies to every piece of equipment, or, with applicability rows in effect, to the equipment of
//   those asset classes and models alone (MaintenanceLookupApplicability, dated). The values are the instance's, as People's
//   vocabularies are: read by any maintenance reader, changed by a holder of MAINTENANCE_SETTINGS_EDIT.
// - Readiness: for each organization that uses Maintenance (or the one asked), the checks of what work needs before it is
//   planned, each a named finding with its owner's place as a route key (fixRoute, with fixId where it names a record) that the
//   application showing it resolves (the framework's readiness contract, moqui.server.ReadinessProvider maintenance.readiness):
//   approved procedures (templates), an approver for each resource whose bookings need one, a technician who may issue stock
//   (STOCK_ISSUE), the maintenance expense mapping (MaintenanceCostPolicy, Accounting's posting defaults), a labor costing rate
//   for each technician (People's get#CostingRate, the one RaprCost purpose) and the preventive generation job's last result
//   (generate_MaintenanceWorkOrders, impl-maintenance P14; "not configured" while it is not there). One check that fails is shown
//   unavailable by name and the others go on.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const {find, one, denied, call, ms} = lib

const ENUM = "moqui.basic.Enumeration"
const APPLICABILITY = "mantle.work.maintenance.MaintenanceLookupApplicability"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const minuteMs = 60 * 1000
const valueCap = 500

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const enumText = enumId => (enumId ? one(ENUM, {enumId})?.description || enumId : "")
const organizationName = partyId => one("mantle.party.Organization", {partyId})?.organizationName || partyId

function signedInScope() {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to use Maintenance's settings")
    return maintenanceAccess.scope()
}

// ===== lookups =====
// The families: their name, whether their values are fixed (renamed and reordered only), whether a value has applicability, and
// the fields of the records that hold a value (counted as its use).
const families = {
    MaintenanceType: {
        title: "Work types",
        uses: [
            [ORDER, "maintenanceTypeEnumId"],
            ["mantle.product.maintenance.AssetMaintenance", "maintenanceTypeEnumId"]
        ]
    },
    MaintenanceSeverity: {title: "Severities", uses: [[ORDER, "severityEnumId"]]},
    MaintenanceHoldReason: {title: "Hold reasons", uses: [[ORDER, "holdReasonEnumId"]]},
    MaintenanceCancelReason: {title: "Cancel reasons", uses: [[ORDER, "cancelReasonEnumId"]]},
    MaintenanceOutcome: {title: "Outcomes", uses: [[ORDER, "outcomeEnumId"]]},
    MaintenanceFailureMode: {title: "Failure modes", applicability: true, uses: [[ORDER, "failureModeEnumId"]]},
    MaintenanceKind: {title: "Kinds", fixed: true, uses: [[ORDER, "maintenanceKindEnumId"]]},
    MaintenanceSource: {title: "Sources", fixed: true, uses: [[ORDER, "sourceEnumId"]]},
    MaintenanceDisposition: {title: "Resource dispositions", fixed: true, uses: [[ORDER, "dispositionEnumId"]]}
}
function family(enumTypeId) {
    const id = text(enumTypeId)
    if (!id || !Object.hasOwn(families, id)) denied("FAMILY_INVALID", "Choose one of Maintenance's lookups")
    return id
}
// How many records hold each value of a family; a count that cannot be read is logged by name and the others go on.
function usesOf(enumTypeId, enumIds) {
    const counts = Object.fromEntries(enumIds.map(enumId => [enumId, 0]))
    if (!enumIds.length) return counts
    for (const [entityName, field] of families[enumTypeId].uses) {
        try {
            for (const row of Array.from(find(entityName).condition(field, "in", enumIds).selectField(field).list()))
                counts[row[field]] = (counts[row[field]] || 0) + 1
        } catch (error) {
            ec.logger.error("The use of " + enumTypeId + " values in " + entityName + " could not be counted: " + error.message)
        }
    }
    return counts
}
// The applicability rows of values in effect now (or every one with includeEnded), by value.
function applicabilityOf(enumIds, includeEnded = false) {
    const byValue = Object.fromEntries(enumIds.map(enumId => [enumId, []]))
    if (!enumIds.length) return byValue
    let query = find(APPLICABILITY).condition("enumId", "in", enumIds).orderBy("fromDate")
    if (!includeEnded) query = query.conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
    for (const row of Array.from(query.list())) byValue[row.enumId]?.push(row)
    return byValue
}
function applicabilityRow(row) {
    const product = row.productId ? one("mantle.product.Product", {productId: row.productId}) : null
    return {
        applicabilityId: row.applicabilityId,
        classEnumId: row.classEnumId || null,
        productId: row.productId || null,
        appliesText: row.classEnumId
            ? "Class: " + enumText(row.classEnumId)
            : "Model: " + (product?.productName || row.productId),
        fromDateText: dateText(row.fromDate),
        thruDateText: dateText(row.thruDate),
        current: lib.active(row)
    }
}
// Whether a value's current applicability admits a piece of equipment (no row in effect: every one).
function admits(rows, asset) {
    if (!rows.length) return true
    if (!asset) return false
    return rows.some(
        row => (row.classEnumId && row.classEnumId === asset.classEnumId) || (row.productId && row.productId === asset.productId)
    )
}
// The failure modes that apply to a piece of equipment, of those given (for a choice; no asset: all of them).
function applicableFailureModes(enumIds, assetId) {
    const ids = Array.from(enumIds || [])
    if (!assetId || !ids.length) return ids
    const asset = one("mantle.product.asset.Asset", {assetId})
    const rows = applicabilityOf(ids)
    return ids.filter(enumId => admits(rows[enumId] || [], asset))
}
function reader() {
    const userScope = signedInScope()
    if (!userScope.capabilities.settingsEdit && !userScope.capabilities.anyRead)
        denied("PERMISSION_DENIED", "Maintenance's lookups are read by a maintenance reader")
    return userScope
}
// find#MaintenanceLookups: the families with their value counts, and one family's values asked for (current unless ended ones
// are asked for, in their order), each with its use, its end, its applicability and whether the caller may change and end it.
// With assetId, a family with applicability lists only the values that apply to that equipment.
function findLookups(p) {
    const userScope = reader()
    const canEdit = !!userScope.capabilities.settingsEdit
    const familyRows = Object.entries(families).map(([enumTypeId, definition]) => ({
        enumTypeId,
        title: definition.title,
        fixed: !!definition.fixed,
        kindText: definition.fixed ? "Fixed: renamed and reordered only" : "Values added and ended",
        valueCount: find(ENUM).condition("enumTypeId", enumTypeId).count()
    }))
    if (!text(p.enumTypeId))
        return {families: familyRows, values: [], enumTypeId: null, fixed: false, applicability: false, canEdit}
    const enumTypeId = family(p.enumTypeId)
    const definition = families[enumTypeId]
    const includeEnded = flag(p.includeEnded)
    let query = find(ENUM).condition("enumTypeId", enumTypeId).orderBy(["sequenceNum", "description"]).limit(valueCap)
    if (!includeEnded) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
            )
        )
    }
    let found = Array.from(query.list())
    const applicability = definition.applicability
        ? applicabilityOf(
              found.map(row => row.enumId),
              includeEnded
          )
        : {}
    if (definition.applicability && text(p.assetId)) {
        maintenanceAccess.requireAsset(userScope, text(p.assetId))
        const asset = one("mantle.product.asset.Asset", {assetId: text(p.assetId)})
        found = found.filter(row =>
            admits(
                (applicability[row.enumId] || []).filter(a => lib.active(a)),
                asset
            )
        )
    }
    const uses = usesOf(
        enumTypeId,
        found.map(row => row.enumId)
    )
    const now = nowMs()
    const values = found.map(row => {
        const ends = ms(row.thruDate)
        const ended = ends != null && ends <= now
        const rows = (applicability[row.enumId] || []).map(applicabilityRow)
        const current = rows.filter(a => a.current)
        return {
            enumId: row.enumId,
            enumTypeId,
            description: row.description || row.enumId,
            enumCode: row.enumCode || "",
            sequenceNum: row.sequenceNum ?? null,
            useCount: uses[row.enumId] || 0,
            ended,
            thruDateText: dateText(row.thruDate),
            stateText: ended ? "Ended " + dateText(row.thruDate) : ends != null ? "Ends " + dateText(row.thruDate) : "In use",
            applicability: rows,
            appliesText: definition.applicability
                ? current.length
                    ? current.map(a => a.appliesText).join("; ")
                    : "All equipment"
                : "",
            canEdit: canEdit && !ended,
            canEnd: canEdit && !ended && !definition.fixed,
            revision: String(stampOf(row))
        }
    })
    return {
        families: familyRows,
        values,
        enumTypeId,
        fixed: !!definition.fixed,
        applicability: !!definition.applicability,
        canEdit
    }
}
// store#MaintenanceLookup: a new value of a vocabulary, a value's new name, code or order, its end (end true: now; or thruDate,
// now or later), and for a failure mode an applicability row added (an asset class or a model) or one ended. Nothing is deleted.
function storeLookup(p) {
    const userScope = signedInScope()
    if (!userScope.capabilities.settingsEdit)
        denied("PERMISSION_DENIED", "Changing Maintenance's lookups needs MAINTENANCE_SETTINGS_EDIT")
    const enumTypeId = family(p.enumTypeId)
    const definition = families[enumTypeId]
    const sequenceNum = blank(p.sequenceNum) ? null : Number(text(p.sequenceNum))
    if (sequenceNum != null && (!Number.isInteger(sequenceNum) || sequenceNum < 0 || sequenceNum > 9999))
        denied("SEQUENCE_INVALID", "The order is a whole number from 0 to 9999")
    const now = nowMs()
    const duplicate = (description, exceptId) =>
        Array.from(find(ENUM).condition("enumTypeId", enumTypeId).list()).some(
            row =>
                row.enumId !== exceptId &&
                (ms(row.thruDate) ?? Infinity) > now &&
                String(row.description || "").toLowerCase() === description.toLowerCase()
        )
    if (!text(p.enumId)) {
        if (definition.fixed) denied("FAMILY_FIXED", definition.title + " are fixed: rename or reorder them")
        const description = text(p.description)
        if (!description) denied("DESCRIPTION_REQUIRED", "Give the value's name")
        if (duplicate(description, null)) denied("DUPLICATE_VALUE", description + " is already a value of this lookup")
        const created = call("create#" + ENUM, {enumTypeId, description, enumCode: text(p.enumCode), sequenceNum})
        const row = one(ENUM, {enumId: created.enumId})
        return {enumId: row.enumId, revision: String(stampOf(row))}
    }
    const row = one(ENUM, {enumId: text(p.enumId)})
    if (!row || row.enumTypeId !== enumTypeId) denied("RECORD_UNAVAILABLE", "This value is not available")
    if ((ms(row.thruDate) ?? Infinity) <= now) denied("VALUE_ENDED", (row.description || row.enumId) + " has ended")
    const changes = {enumId: row.enumId}
    const ending = flag(p.end) || !blank(p.thruDate)
    if (ending) {
        if (definition.fixed) denied("FAMILY_FIXED", definition.title + " are fixed: their values are not ended")
        const thruDate = flag(p.end) || blank(p.thruDate) ? ec.user.nowTimestamp : p.thruDate
        if (ms(thruDate) < now - minuteMs) denied("DATE_INVALID", "A value ends now or later")
        changes.thruDate = thruDate
    }
    if (p.description != null) {
        const description = text(p.description)
        if (!description) denied("DESCRIPTION_REQUIRED", "Give the value's name")
        if (description !== row.description && duplicate(description, row.enumId))
            denied("DUPLICATE_VALUE", description + " is already a value of this lookup")
        changes.description = description
    }
    if (p.enumCode != null) changes.enumCode = text(p.enumCode)
    if (p.sequenceNum != null) changes.sequenceNum = sequenceNum
    if (Object.keys(changes).length > 1) {
        const revision = String(stampOf(row))
        if (text(p.expectedRevision) !== revision)
            denied("REVISION_CHANGED", "This value changed since you read it; open it again (revision " + revision + ")")
        call("update#" + ENUM, changes)
    }
    // a failure mode's applicability: a row added (a class or a model, one of the two) or one ended
    const classEnumId = text(p.addClassEnumId)
    const productId = text(p.addProductId)
    const endId = text(p.endApplicabilityId)
    if ((classEnumId || productId || endId) && !definition.applicability)
        denied("VALUE_INVALID", definition.title + " have no applicability")
    if (classEnumId || productId) {
        if (classEnumId && productId)
            denied("APPLICABILITY_INVALID", "A row applies to an asset class or a model, one of the two")
        if (classEnumId && !one(ENUM, {enumId: classEnumId, enumTypeId: "AssetClass"}))
            denied("VALUE_INVALID", "Asset class " + classEnumId + " is not known")
        if (productId && !one("mantle.product.Product", {productId}))
            denied("VALUE_INVALID", "Model " + productId + " is not known")
        const existing = Array.from(applicabilityOf([row.enumId])[row.enumId] || []).some(
            a => (classEnumId && a.classEnumId === classEnumId) || (productId && a.productId === productId)
        )
        if (existing) denied("APPLICABILITY_EXISTS", "This value already applies there")
        call("create#" + APPLICABILITY, {
            enumId: row.enumId,
            classEnumId,
            productId,
            fromDate: ec.user.nowTimestamp,
            createdByUserId: ec.user.userId
        })
    }
    if (endId) {
        const applicability = one(APPLICABILITY, {applicabilityId: endId})
        if (!applicability || applicability.enumId !== row.enumId || !lib.active(applicability))
            denied("RECORD_UNAVAILABLE", "This applicability is not available")
        call("update#" + APPLICABILITY, {applicabilityId: endId, thruDate: ec.user.nowTimestamp})
    }
    const stored = one(ENUM, {enumId: row.enumId})
    return {enumId: stored.enumId, revision: String(stampOf(stored))}
}

// ===== readiness =====
// A check's owner places are route keys (impl-maintenance F117): Maintenance's own, Accounting's, and Admin's for a group or a job.
const routes = {
    settings: "maintenanceSettings",
    procedures: "maintenanceProcedures",
    resources: "maintenanceResources",
    groups: "adminGroups",
    postingDefaults: "accountingPostingDefaults",
    costingRates: "accountingCostingPolicies",
    job: "adminJob"
}
// impl-maintenance P14's job (MaintenancePlans.js names it): read by name, so the check answers before and after it is seeded
const generationJob = "generate_MaintenanceWorkOrders"
const plural = (count, one, many) => count + " " + (count === 1 ? one : many)

// The users who hold a permission now through a group (the system administrator's group, which holds every one, left out: an
// administrator is no technician).
function permissionHolders(permission) {
    const now = ec.user.nowTimestamp
    const groupIds = Array.from(
        find("moqui.security.UserGroupPermission", {userPermissionId: permission})
            .conditionDate("fromDate", "thruDate", now)
            .list()
    )
        .map(row => row.userGroupId)
        .filter(id => id !== "ADMIN")
    if (!groupIds.length) return new Set()
    return new Set(
        Array.from(
            find("moqui.security.UserGroupMember")
                .condition("userGroupId", "in", groupIds)
                .conditionDate("fromDate", "thruDate", now)
                .selectField("userId")
                .list()
        ).map(row => row.userId)
    )
}
// The organization's technicians: the people who work for it now (an employee or an agent) and hold MAINTENANCE_EXECUTE, each
// with their user ids.
function techniciansOf(organizationPartyId) {
    const holders = permissionHolders("MAINTENANCE_EXECUTE")
    if (!holders.size) return []
    const accounts = Array.from(find("moqui.security.UserAccount").condition("userId", "in", Array.from(holders)).list()).filter(
        row => row.partyId && row.disabled !== "Y"
    )
    if (!accounts.length) return []
    const members = new Set(
        Array.from(
            find("mantle.party.PartyRelationship")
                .condition("toPartyId", organizationPartyId)
                .condition("relationshipTypeEnumId", "in", ["PrtEmployee", "PrtAgent"])
                .condition(
                    "fromPartyId",
                    "in",
                    accounts.map(row => row.partyId)
                )
                .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                .list()
        ).map(row => row.fromPartyId)
    )
    const byParty = {}
    for (const account of accounts) if (members.has(account.partyId)) (byParty[account.partyId] ||= []).push(account.userId)
    return Object.entries(byParty).map(([partyId, userIds]) => ({partyId, userIds}))
}
const readinessChecks = [
    {
        checkKey: "maintenance.templates",
        title: "Procedures",
        run(organizationPartyId) {
            const approved = find("mantle.work.effort.WorkEffort")
                .condition({
                    isTemplate: "Y",
                    workEffortTypeEnumId: "WetTask",
                    purposeEnumId: "WepMaintenance",
                    ownerPartyId: organizationPartyId
                })
                .condition("rootWorkEffortId", "is-null", null)
                .condition("statusId", "WeApproved")
                .count()
            return approved
                ? {state: "ready", message: plural(approved, "procedure is", "procedures are") + " approved"}
                : {
                      state: "warning",
                      reasonCode: "NO_PROCEDURE",
                      message: "No procedure is approved: work is planned without a checklist",
                      fixRoute: routes.procedures
                  }
        }
    },
    {
        checkKey: "maintenance.approvers",
        title: "Resource approvers",
        run(organizationPartyId) {
            const now = ec.user.nowTimestamp
            const policies = Array.from(
                find("mantle.work.effort.ResourceBookingPolicy", {organizationPartyId, approvalModeEnumId: "RbamApprovers"})
                    .conditionDate("fromDate", "thruDate", now)
                    .limit(valueCap)
                    .list()
            )
            const missing = policies.filter(policy => {
                const query = policy.assetId
                    ? find("mantle.product.asset.AssetPartyAssignment", {assetId: policy.assetId, roleTypeId: "BookingApprover"})
                    : find("mantle.facility.FacilityParty", {facilityId: policy.facilityId, roleTypeId: "BookingApprover"})
                return query.conditionDate("fromDate", "thruDate", now).count() === 0
            })
            if (missing.length)
                return {
                    state: "failed",
                    reasonCode: "APPROVER_MISSING",
                    message:
                        plural(missing.length, "resource needs", "resources need") + " an approver: their bookings are refused",
                    fixRoute: routes.resources
                }
            return {
                state: "ready",
                message: policies.length
                    ? "Each of " + plural(policies.length, "resource", "resources") + " approved by people has an approver"
                    : "No resource's bookings need an approver"
            }
        }
    },
    {
        checkKey: "maintenance.stockGrants",
        title: "Parts issue",
        run(organizationPartyId) {
            const technicians = techniciansOf(organizationPartyId)
            if (!technicians.length)
                return {
                    state: "warning",
                    reasonCode: "NO_TECHNICIAN",
                    message: "No technician works for the organization",
                    fixRoute: routes.groups
                }
            const issuers = permissionHolders("STOCK_ISSUE")
            const can = technicians.filter(row => row.userIds.some(userId => issuers.has(userId))).length
            return can
                ? {
                      state: "ready",
                      message: can + " of " + plural(technicians.length, "technician", "technicians") + " may issue parts"
                  }
                : {
                      state: "warning",
                      reasonCode: "NO_STOCK_GRANT",
                      message: "No technician may issue parts (STOCK_ISSUE): parts are issued by the storeroom",
                      fixRoute: routes.groups
                  }
        }
    },
    {
        checkKey: "maintenance.costPolicy",
        title: "Maintenance expense",
        run(organizationPartyId) {
            const rows = Array.from(
                find("mantle.ledger.config.MaintenanceCostPolicy", {organizationPartyId})
                    .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                    .list()
            ).filter(row => row.glAccountId)
            if (!rows.length)
                return {
                    state: "failed",
                    reasonCode: "MAINTENANCE_COST_UNMAPPED",
                    message: "No maintenance expense account is mapped: parts cannot be issued to work",
                    fixRoute: routes.postingDefaults
                }
            const kinds = new Set(rows.map(row => row.maintenanceKindEnumId || "any"))
            const unmapped = kinds.has("any") ? [] : ["MkCorrective", "MkPreventive"].filter(kind => !kinds.has(kind))
            return unmapped.length
                ? {
                      state: "warning",
                      reasonCode: "MAINTENANCE_COST_UNMAPPED",
                      message: "No expense account for " + unmapped.map(enumText).join(" or ") + " work",
                      fixRoute: routes.postingDefaults
                  }
                : {state: "ready", message: plural(rows.length, "expense mapping is", "expense mappings are") + " in effect"}
        }
    },
    {
        checkKey: "maintenance.costingRates",
        title: "Labor costing rates",
        run(organizationPartyId) {
            const technicians = techniciansOf(organizationPartyId)
            if (!technicians.length) return {state: "ready", message: "No technician's time to price"}
            const unpriced = technicians.filter(
                row => !call("mantle.humanres.RateServices.get#CostingRate", {partyId: row.partyId, organizationPartyId}).priced
            ).length
            return unpriced
                ? {
                      state: "warning",
                      reasonCode: "RATE_MISSING",
                      message:
                          plural(unpriced, "technician has", "technicians have") +
                          " no labor costing rate: their time is unpriced",
                      fixRoute: routes.costingRates
                  }
                : {state: "ready", message: "Every technician's time is priced"}
        }
    },
    {
        checkKey: "maintenance.generationJob",
        title: "Preventive generation job",
        run(organizationPartyId) {
            const plans = find("mantle.work.maintenance.MaintenanceSchedule", {
                organizationPartyId,
                statusId: "MschActive"
            }).count()
            if (!plans) return {state: "ready", message: "No preventive plan is active"}
            const job = one("moqui.service.job.ServiceJob", {jobName: generationJob})
            if (!job)
                return {
                    state: "warning",
                    reasonCode: "JOB_NOT_CONFIGURED",
                    message: "The preventive generation job is not configured: due work is generated by hand"
                }
            const atJob = {fixRoute: routes.job, fixId: generationJob}
            if (job.paused === "Y")
                return Object.assign(
                    {
                        state: "warning",
                        reasonCode: "JOB_PAUSED",
                        message: "The preventive generation job is paused: due work is generated by hand"
                    },
                    atJob
                )
            const last = find("moqui.service.job.ServiceJobRun", {jobName: generationJob}).orderBy("-startTime").limit(1).one()
            if (!last)
                return Object.assign(
                    {state: "warning", reasonCode: "JOB_NOT_RUN", message: "The preventive generation job has not run yet"},
                    atJob
                )
            if (last.hasError === "Y")
                return Object.assign(
                    {
                        state: "failed",
                        reasonCode: "JOB_FAILED",
                        message: "The last run, " + dateText(last.startTime) + ", failed"
                    },
                    atJob
                )
            return {state: "ready", message: "Last run " + dateText(last.endTime || last.startTime)}
        }
    }
]
// The organizations that use Maintenance: a work policy, a procedure, a maintenance work order or a preventive plan of theirs.
function usesMaintenance(organizationPartyId) {
    return (
        find("mantle.work.maintenance.MaintenancePolicy", {organizationPartyId}).count() > 0 ||
        find("mantle.work.effort.WorkEffort", {ownerPartyId: organizationPartyId, purposeEnumId: "WepMaintenance"}).count() > 0 ||
        find("mantle.work.maintenance.MaintenanceSchedule", {organizationPartyId}).count() > 0
    )
}
// check#MaintenanceReadiness: the checks of the organization asked, or of each organization of the caller's scope that uses
// Maintenance, for a holder of MAINTENANCE_SETTINGS_EDIT.
function readiness(p) {
    const userScope = signedInScope()
    if (!userScope.capabilities.settingsEdit)
        denied("PERMISSION_DENIED", "Maintenance's setup readiness is the Maintenance administrator's")
    let organizationPartyIds
    if (text(p.organizationPartyId))
        organizationPartyIds = [maintenanceAccess.requireOrganization(userScope, text(p.organizationPartyId))]
    else {
        const internal = Array.from(
            find("mantle.party.PartyRole", {roleTypeId: "OrgInternal"}).selectField("partyId").list()
        ).map(row => row.partyId)
        const scoped =
            userScope.organizationPartyIds == null ? internal : userScope.organizationPartyIds.filter(id => internal.includes(id))
        organizationPartyIds = scoped.filter(organizationPartyId => {
            // an organization whose use cannot be read is logged by name and the others go on
            try {
                return usesMaintenance(organizationPartyId)
            } catch (error) {
                ec.logger.error("Maintenance readiness for " + organizationPartyId + " failed: " + error.message)
                return false
            }
        })
    }
    const checks = []
    for (const organizationPartyId of organizationPartyIds) {
        const subject = organizationName(organizationPartyId)
        for (const check of readinessChecks) {
            let found
            // one check that fails is shown unavailable, by name, and the others go on
            try {
                found = check.run(organizationPartyId)
            } catch (error) {
                ec.logger.error(
                    "Maintenance readiness " + check.checkKey + " for " + organizationPartyId + " failed: " + error.message
                )
                found = {state: "unavailable", reasonCode: "CHECK_FAILED", message: check.title + " could not be checked"}
            }
            checks.push({
                checkKey: check.checkKey,
                title: check.title,
                state: found.state,
                reasonCode: found.reasonCode || null,
                message: found.message,
                // the owner's place, as a key; a check that names none takes the provider's (Maintenance's settings)
                fixRoute: found.state === "ready" ? null : found.fixRoute || routes.settings,
                fixId: found.state === "ready" ? null : found.fixId || null,
                subject,
                scope: {organizationPartyId},
                organizationPartyId,
                organizationName: subject
            })
        }
    }
    return {checks}
}

const operations = {findLookups, storeLookup, readiness}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown maintenance settings operation " + op)
        return operations[op](parameters || {})
    },
    // for Maintenance's choices (the failure modes that apply to a piece of equipment), never a service's parameters
    applicableFailureModes
})
