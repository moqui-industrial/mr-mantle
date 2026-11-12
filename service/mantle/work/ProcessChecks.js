// Executing a process's steps (mantle.work.ProcessServices; IronStone Maintenance design §4.3, §3 ProcedureSteps, StepResponse and
// ExecutionAmendment, §12 the completed checklist; impl-maintenance P7). An execution is a work order's root and its steps, made of
// a procedure (instantiate#WorkProcess); each step carries its own copy of the step policy (required, response kind, reading and
// bounds, evidence, comment, waiver). The facts are records of their own (entity/WorkProcessEntities.xml): a check per response
// (WorkEffortCheck, its evidence WorkEffortCheckEvidence), a waiver (WorkEffortWaiver) and an amendment
// (WorkEffortExecutionAmendment). The step guard: a step's status moves only here, by its response, a waiver, a skip with a reason,
// or the root's close or cancel (closeExecution), as the generic task services refuse managed work (check#ManagedWork).
//
// - get#ProcessExecution: the tree for a reader of the work order (MaintenanceAccess requireWork), each step with its state, policy,
//   blockers, current check, history, waiver and instruction, what the caller may do, the next actionable step and the gate.
// - record#ProcessStep: start a leaf, skip an optional one with a reason, or respond (design §4.3's input; the policy, bounds and
//   organization are the execution's, never the caller's). A missing file, a missing comment, a wrong unit, an out-of-range reading
//   or a failure is saved as an unresolved check and leaves the step open; a recheck appends; a correction supersedes a check. An
//   accepted check completes the step. A reading is a Measurement; a counter reading (a measurement type of a meter type) also goes
//   through record#MaintenanceMeter, the one meter writer, with the Measurement linked. An unmet dependency (of the step or of a
//   group above it) is refused (DEPENDENCY_OPEN); independent leaves run together.
// - waive#ProcessStep: a supervisor (MAINTENANCE_SUPERVISE) completes a step its policy lets be waived, with a reason; the failure
//   stays. A technician and a step whose policy forbids it are refused.
// - amend#ProcessExecution: a supervisor's reasoned change of an open execution's step policies or dependencies, with a preview of
//   the acceptances it invalidates; applying it invalidates them (the step back in progress, the check and waiver kept).
// - Groups derive their state from their children and take no response. The root's Complete is gated by the required leaves
//   (complete or waived) (gateOf, MaintenanceWork.js); Close moves complete nodes to Closed and stores the completed checklist as
//   a PDF (WectCompletedChecklist); Cancel cancels the open nodes.
// - Evidence a check names is protected (get#EvidencePolicy for RecordFiles' get#ContentType, check#EvidenceChange for
//   update#WorkEffortContent): not removed, replaced or given a new version; files are not added to closed or cancelled work.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const maintenanceAccess = ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceAccess.js")
const workProcesses = ec.resource.script("component://mr-mantle/service/mantle/work/WorkProcesses.js")
const procedures = () => ec.resource.script("component://mr-mantle/service/mantle/work/MaintenanceProcedures.js")
const {find, one, rows, denied, call, ms} = lib

const WORK = "mantle.work.effort.WorkEffort"
const ASSOC = "mantle.work.effort.WorkEffortAssoc"
const STEP = "mantle.work.effort.WorkEffortStepPolicy"
const PARTY = "mantle.work.effort.WorkEffortParty"
const CONTENT = "mantle.work.effort.WorkEffortContent"
const CHECK = "mantle.work.effort.WorkEffortCheck"
const EVIDENCE = "mantle.work.effort.WorkEffortCheckEvidence"
const WAIVER = "mantle.work.effort.WorkEffortWaiver"
const AMENDMENT = "mantle.work.effort.WorkEffortExecutionAmendment"
const MEASUREMENT = "mantle.work.measurement.Measurement"
const ORDER = "mantle.work.maintenance.MaintenanceWorkOrder"
const METER = "mantle.product.maintenance.AssetMeter"

const doneStatuses = ["WeComplete", "WeClosed", "WeCancelled"]
const completeStatuses = ["WeComplete", "WeClosed"]
const workingRoot = ["WeInProgress"]
const waivingRoot = ["WeInProgress", "WeOnHold"]
const closedRoot = ["WeComplete", "WeClosed", "WeCancelled"]
// the step policy fields an amendment changes
const policyFields = [
    "isRequired",
    "responseKindEnumId",
    "measurementTypeId",
    "measurementUomId",
    "minimumValue",
    "maximumValue",
    "evidenceRequired",
    "commentRequired",
    "waiverAllowed"
]
const minuteMs = 60 * 1000

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const flag = value => value === true || value === "true" || value === "Y"
const nowMs = () => ms(ec.user.nowTimestamp)
const stamp = millis => (millis == null ? null : new Date(millis))
const dateText = value => (value == null || value === "" ? "" : lib.dateText(value))
const number = value => (value == null || value === "" ? null : Number(String(value)))
const unique = list => Array.from(new Set(list.filter(Boolean)))
const openAt = (row, at) => (ms(row.fromDate) ?? -Infinity) <= at && (ms(row.thruDate) ?? Infinity) > at
const enumText = enumId => (enumId ? one("moqui.basic.Enumeration", {enumId})?.description || enumId : "")
const statusText = statusId => (statusId ? one("moqui.basic.StatusItem", {statusId})?.description || statusId : "")
const uomText = uomId => (uomId ? one("moqui.basic.Uom", {uomId})?.abbreviation || uomId : "")
const numberText = value => (value == null ? "" : String(Number(String(value))))
const asList = value => (value == null || value === "" ? [] : Array.isArray(value) ? value : value.toArray ? Array.from(value.toArray()) : [value])

// ===== the caller and the execution =====
function scopeWithAny(capabilities) {
    if (!ec.user.userId) denied("PERMISSION_DENIED", "Sign in to work a checklist")
    const userScope = maintenanceAccess.scope()
    if (!capabilities.some(name => userScope.capabilities[name]))
        denied("PERMISSION_DENIED", "Maintenance " + capabilities.join(" or ") + " is required")
    return userScope
}
// A work order's root or step the caller reads (requireWork), with its root and work order row: {node, root, order,
// organizationPartyId}. A template or a work effort of no work order is not available.
function executionNode(userScope, workEffortId, lock = false) {
    const id = text(workEffortId)
    if (!id) denied("RECORD_UNAVAILABLE", "Work is not available")
    const found = maintenanceAccess.requireWork(userScope, id)
    const order = one(ORDER, {workEffortId: found.rootWorkEffortId})
    const root = one(WORK, {workEffortId: found.rootWorkEffortId})
    if (!order || !root || root.isTemplate === "Y") denied("RECORD_UNAVAILABLE", "Work " + id + " is not available")
    const node = lock ? find(WORK, {workEffortId: id}).forUpdate(true).one() : one(WORK, {workEffortId: id})
    return {node, root, order, organizationPartyId: found.organizationPartyId}
}
// The tree of a root: its nodes (root first, then each node followed by its children by sequence), each node's children and depth.
function executionOf(rootId) {
    const root = one(WORK, {workEffortId: rootId})
    const all = [root].concat(rows(WORK, {rootWorkEffortId: rootId}).filter(row => row.workEffortId !== rootId))
    const byId = Object.fromEntries(all.map(row => [row.workEffortId, row]))
    const children = {}
    for (const row of all)
        if (row.workEffortId !== rootId) {
            const parentId = row.parentWorkEffortId && byId[row.parentWorkEffortId] ? row.parentWorkEffortId : rootId
            ;(children[parentId] || (children[parentId] = [])).push(row.workEffortId)
        }
    const ordered = []
    const depth = {}
    const walk = (id, level) => {
        ordered.push(byId[id])
        depth[id] = level
        const kids = (children[id] || [])
            .map(childId => byId[childId])
            .sort(
                (a, b) =>
                    (number(a.sequenceNum) ?? 0) - (number(b.sequenceNum) ?? 0) || a.workEffortId.localeCompare(b.workEffortId)
            )
        for (const kid of kids) walk(kid.workEffortId, level + 1)
    }
    walk(rootId, 0)
    return {rootId, root, nodes: ordered, byId, children, depth}
}
const isGroup = (ex, id) => !!(ex.children[id] || []).length
const leavesOf = ex => ex.nodes.filter(node => node.workEffortId !== ex.rootId && !isGroup(ex, node.workEffortId))
const policyOf = id => workProcesses.stepPolicyOf(id) || {}
const requiredStep = policy => policy.isRequired !== "N"
// The ancestors of a node below the root, nearest first.
function ancestorsOf(ex, id) {
    const out = []
    let parentId = ex.byId[id]?.parentWorkEffortId
    while (parentId && parentId !== ex.rootId && ex.byId[parentId] && !out.includes(parentId)) {
        out.push(parentId)
        parentId = ex.byId[parentId].parentWorkEffortId
    }
    return out
}
// The dependencies a node waits for that are not done: its own and its groups' (WeatDependsOn in effect), each {workEffortId, name}.
function openDependencies(ex, id, at = nowMs()) {
    const ids = [id].concat(ancestorsOf(ex, id))
    const edges = Array.from(
        find(ASSOC).condition("workEffortId", "in", ids).condition("workEffortAssocTypeEnumId", "WeatDependsOn").list()
    ).filter(row => openAt(row, at))
    return edges
        .map(row => one(WORK, {workEffortId: row.toWorkEffortId}))
        .filter(target => target && !doneStatuses.includes(target.statusId))
        .map(target => ({workEffortId: target.workEffortId, name: target.workEffortName || target.workEffortId}))
}
// The caller works the step: MAINTENANCE_EXECUTE and assigned to it or its root, or a supervisor.
function requireExecuting(userScope, node) {
    const caps = userScope.capabilities
    if (caps.supervise) return
    if (!caps.execute) denied("PERMISSION_DENIED", "A technician or a supervisor works a checklist")
    if (!maintenanceAccess.assignment(userScope, node.workEffortId).step)
        denied("NOT_ASSIGNED", "Step " + node.workEffortId + " is not assigned to you")
}
function setStatus(workEffortId, statusId) {
    const row = one(WORK, {workEffortId})
    if (row && row.statusId !== statusId) call("update#" + WORK, {workEffortId, statusId})
}
// A group's state from its children: complete when each child is done (and one is complete), in progress when one has started.
function rollUp(rootId, fromId) {
    const ex = executionOf(rootId)
    for (const groupId of ancestorsOf(ex, fromId)) {
        const kids = (ex.children[groupId] || []).map(id => one(WORK, {workEffortId: id}))
        const group = one(WORK, {workEffortId: groupId})
        let wanted = group.statusId
        if (kids.every(kid => doneStatuses.includes(kid.statusId)))
            wanted = kids.some(kid => completeStatuses.includes(kid.statusId)) ? "WeComplete" : "WeCancelled"
        else if (kids.some(kid => kid.statusId !== "WeInPlanning" && kid.statusId !== "WeApproved")) wanted = "WeInProgress"
        else wanted = group.statusId === "WeComplete" ? "WeInProgress" : group.statusId
        if (wanted !== group.statusId) setStatus(groupId, wanted)
    }
}

// ===== the gate (the root's Complete) =====
// The required leaves of a root that are neither complete nor waived, each {workEffortId, name}; none for work without steps. A
// cancelled leaf is no longer the work's (an optional one skipped, or one an amendment removed; a required one is not skipped).
function gateOf(rootId) {
    const ex = executionOf(rootId)
    return leavesOf(ex)
        .filter(node => !doneStatuses.includes(node.statusId) && requiredStep(policyOf(node.workEffortId)))
        .map(node => ({workEffortId: node.workEffortId, name: node.workEffortName || node.workEffortId}))
}
// The root's close or cancel (MaintenanceWork.js transition, after its own update): Close moves complete nodes to Closed, cancels
// the open ones and stores the completed checklist; Cancel cancels the open nodes. Checks, waivers and evidence stay.
function closeExecution(rootId, statusId) {
    const ex = executionOf(rootId)
    if (ex.nodes.length < 2) return {checklistContentId: null}
    for (const node of ex.nodes.slice(1).reverse()) {
        const current = one(WORK, {workEffortId: node.workEffortId}).statusId
        if (statusId === "WeClosed" && current === "WeComplete") setStatus(node.workEffortId, "WeClosed")
        else if (!doneStatuses.includes(current)) setStatus(node.workEffortId, "WeCancelled")
    }
    return {checklistContentId: statusId === "WeClosed" ? storeChecklist(rootId) : null}
}

// ===== operation keys =====
function requestHash(values) {
    return lib.hash(
        values.map(value => {
            if (value == null) return ""
            if (Array.isArray(value)) return value.map(String).join(",")
            if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
            const millis = ms(value)
            return Number.isFinite(millis) ? String(millis) : String(value)
        })
    )
}
function earlierUnderKey(entity, operationKey, hash) {
    if (!operationKey) return null
    if (operationKey.length > 60) denied("OPERATION_KEY_INVALID", "An operation key has at most 60 characters")
    const earlier = Array.from(find(entity, {operationKey}).limit(1).list())[0]
    if (!earlier) return null
    if (earlier.operationHash !== hash) denied("OPERATION_KEY_CONFLICT", "The operation key was used for another change")
    return earlier
}

// ===== record#ProcessStep =====
function recordStep(p) {
    const userScope = scopeWithAny(["execute", "supervise"])
    const ctx = executionNode(userScope, p.workEffortId, true)
    const {node, root, order} = ctx
    if (node.workEffortId === root.workEffortId) denied("STEP_REQUIRED", "Respond to a step of the work order, not the work order")
    requireExecuting(userScope, node)
    const action = text(p.action) || "respond"
    if (!["start", "respond", "skip"].includes(action)) denied("ACTION_INVALID", "Unknown step action " + action)
    if (!workingRoot.includes(root.statusId))
        denied("STATUS_INVALID", "Start work order " + root.workEffortId + " first; it is " + statusText(root.statusId))
    const ex = executionOf(root.workEffortId)
    if (isGroup(ex, node.workEffortId)) denied("GROUP_NO_RESPONSE", "A group takes no response; its steps do")
    const policy = policyOf(node.workEffortId)
    const operationKey = text(p.operationKey)
    const hash = requestHash([
        node.workEffortId,
        action,
        text(p.outcome),
        text(p.measurementValue),
        text(p.measurementUomId),
        text(p.comments),
        unique(asList(p.evidenceContentIds).map(text)).sort(),
        text(p.supersededCheckId)
    ])
    const earlier = earlierUnderKey(CHECK, operationKey, hash)
    if (earlier) return answerOf(earlier, true)

    if (action === "start") {
        if (doneStatuses.includes(node.statusId)) denied("STEP_DONE", "Step " + node.workEffortId + " is " + statusText(node.statusId))
        const waiting = openDependencies(ex, node.workEffortId)
        if (waiting.length) denied("DEPENDENCY_OPEN", "Step " + node.workEffortId + " waits for " + waiting.map(w => w.name).join(", "))
        setStatus(node.workEffortId, "WeInProgress")
        rollUp(root.workEffortId, node.workEffortId)
        return {workEffortId: node.workEffortId, statusId: "WeInProgress", accepted: false, findingList: []}
    }
    if (action === "skip") {
        if (doneStatuses.includes(node.statusId)) denied("STEP_DONE", "Step " + node.workEffortId + " is " + statusText(node.statusId))
        if (requiredStep(policy)) denied("SKIP_NOT_ALLOWED", "A required step is done or waived, not skipped")
        const reason = text(p.comments)
        if (!reason) denied("REASON_REQUIRED", "Say why the step is skipped")
        const checkId = writeCheck(node, root, {
            responseKindEnumId: policy.responseKindEnumId || null,
            outcomeEnumId: "WcoSkipped",
            checkStatusEnumId: "WcsAccepted",
            comments: reason,
            observedDate: ec.user.nowTimestamp,
            operationKey,
            operationHash: operationKey ? hash : null
        })
        setStatus(node.workEffortId, "WeCancelled")
        rollUp(root.workEffortId, node.workEffortId)
        return answerOf(one(CHECK, {workEffortCheckId: checkId}), false)
    }

    // respond
    const supersededId = text(p.supersededCheckId)
    let superseded = null
    if (supersededId) {
        superseded = one(CHECK, {workEffortCheckId: supersededId})
        if (!superseded || superseded.workEffortId !== node.workEffortId || ["WcsSuperseded", "WcsInvalidated"].includes(superseded.checkStatusEnumId))
            denied("VALUE_INVALID", "Check " + supersededId + " is not a current check of this step")
        if (!text(p.correctionReason)) denied("REASON_REQUIRED", "Say why the check is corrected")
    }
    if (node.statusId === "WeClosed" || node.statusId === "WeCancelled" || (node.statusId === "WeComplete" && !superseded))
        denied("STEP_DONE", "Step " + node.workEffortId + " is " + statusText(node.statusId) + "; a correction names the check it replaces")
    const waiting = openDependencies(ex, node.workEffortId)
    if (waiting.length) denied("DEPENDENCY_OPEN", "Step " + node.workEffortId + " waits for " + waiting.map(w => w.name).join(", "))
    const observed = p.observedDate == null || p.observedDate === "" ? ec.user.nowTimestamp : p.observedDate
    if (ms(observed) > nowMs() + minuteMs) denied("DATE_FUTURE", "An observation is made now or earlier")

    const kind = policy.responseKindEnumId || "WsrCheckOff"
    const findings = []
    let outcome = "WcoDone"
    let value = null
    let uomId = null
    if (kind === "WsrPassFail") {
        const given = (text(p.outcome) || "").toLowerCase()
        if (!["pass", "fail", "wcopass", "wcofail"].includes(given)) denied("OUTCOME_REQUIRED", "Say whether the check passed or failed")
        outcome = given.endsWith("pass") ? "WcoPass" : "WcoFail"
        if (outcome === "WcoFail") findings.push("The check failed")
    } else if (kind === "WsrReading") {
        if (blank(p.measurementValue)) denied("VALUE_REQUIRED", "Enter the reading")
        value = Number(String(p.measurementValue))
        if (!Number.isFinite(value)) denied("VALUE_INVALID", "A reading is a number")
        uomId = text(p.measurementUomId) || policy.measurementUomId || null
        const wantedUom = policy.measurementUomId || null
        if (wantedUom && uomId !== wantedUom) {
            findings.push("The reading is in " + uomText(uomId) + "; this step reads in " + uomText(wantedUom))
            outcome = null
        } else {
            const low = number(policy.minimumValue)
            const high = number(policy.maximumValue)
            const out = (low != null && value < low) || (high != null && value > high)
            outcome = out ? "WcoFail" : "WcoPass"
            if (out)
                findings.push(
                    "The reading " + numberText(value) + " " + uomText(uomId) + " is outside " + numberText(low) + "–" + numberText(high)
                )
        }
    }
    if (policy.commentRequired === "Y" && blank(p.comments)) findings.push("A comment is required")

    // the evidence: files of the work order (its root or this step) named, and files uploaded with the response (on the root,
    // named for the step), and a voice note
    const evidence = []
    for (const contentId of unique(asList(p.evidenceContentIds).map(text))) {
        const row = one(CONTENT, {workEffortContentId: contentId})
        if (!row || ![root.workEffortId, node.workEffortId].includes(row.workEffortId))
            denied("VALUE_INVALID", "File " + contentId + " is not a file of this work order")
        evidence.push({workEffortContentId: contentId, evidenceKindEnumId: "WceFile"})
    }
    const stepName = node.workEffortName || node.workEffortId
    for (const file of asList(p.contentFile).filter(file => file && (file.size == null || Number(file.size) > 0)))
        evidence.push({
            workEffortContentId: call("mantle.work.WorkEffortServices.create#WorkEffortContent", {
                workEffortId: root.workEffortId,
                contentTypeEnumId: "WectCheckEvidence",
                description: "Evidence of " + stepName,
                contentFile: file
            }).workEffortContentId,
            evidenceKindEnumId: "WceFile"
        })
    let voiceContentId = null
    const voice = asList(p.voiceFile).find(file => file && (file.size == null || Number(file.size) > 0))
    if (voice) {
        voiceContentId = call("mantle.work.WorkEffortServices.create#WorkEffortContent", {
            workEffortId: root.workEffortId,
            contentTypeEnumId: "WectVoiceNote",
            description: "Voice note on " + stepName,
            contentFile: voice
        }).workEffortContentId
        evidence.push({workEffortContentId: voiceContentId, evidenceKindEnumId: "WceVoiceNote"})
    }
    if (policy.evidenceRequired === "Y" && !evidence.length) findings.push("Evidence is required: attach a file")

    // a reading is a Measurement; a counter reading also goes through the one meter writer, linked
    let measurementId = null
    if (kind === "WsrReading") {
        const type = policy.measurementTypeId
            ? one("mantle.work.measurement.MeasurementType", {measurementTypeId: policy.measurementTypeId})
            : null
        let productMeterId = null
        if (type?.productMeterTypeId && order.assetId && !findings.some(finding => finding.startsWith("The reading is in"))) {
            const meter = call("mantle.product.MaintenanceResourceServices.record#MaintenanceMeter", {
                assetId: order.assetId,
                productMeterTypeId: type.productMeterTypeId,
                meterValue: value,
                readingDate: observed,
                workEffortId: node.workEffortId,
                assetMaintenanceId: order.assetMaintenanceId || null
            })
            productMeterId = one(METER, {assetId: order.assetId, readingDate: meter.readingDate})?.productMeterId || null
        }
        measurementId = call("create#" + MEASUREMENT, {
            measurementTypeId: policy.measurementTypeId || null,
            measurementDate: observed,
            measurementValue: value,
            measurementUomId: uomId,
            workEffortId: node.workEffortId,
            assetId: order.assetId || null,
            facilityId: root.facilityId || null,
            productMeterId,
            assetMaintenanceId: order.assetMaintenanceId || null
        }).measurementId
    }
    const accepted = !findings.length
    const checkId = writeCheck(node, root, {
        responseKindEnumId: kind,
        outcomeEnumId: outcome,
        checkStatusEnumId: accepted ? "WcsAccepted" : "WcsUnresolved",
        findings: findings.join("\n") || null,
        measurementId,
        measurementValue: value,
        measurementUomId: uomId,
        observedDate: observed,
        comments: text(p.comments),
        supersededCheckId: supersededId,
        correctionReason: text(p.correctionReason),
        operationKey,
        operationHash: operationKey ? hash : null
    })
    for (const row of evidence)
        call("create#" + EVIDENCE, Object.assign({workEffortCheckId: checkId, fromDate: ec.user.nowTimestamp}, row))
    if (superseded) call("update#" + CHECK, {workEffortCheckId: superseded.workEffortCheckId, checkStatusEnumId: "WcsSuperseded"})
    // an accepted check completes the step; anything else leaves it open (a correction that fails reopens it)
    setStatus(node.workEffortId, accepted ? "WeComplete" : "WeInProgress")
    rollUp(root.workEffortId, node.workEffortId)
    return Object.assign(answerOf(one(CHECK, {workEffortCheckId: checkId}), false), {voiceContentId})
}
function writeCheck(node, root, fields) {
    return call(
        "create#" + CHECK,
        Object.assign(
            {
                workEffortId: node.workEffortId,
                rootWorkEffortId: root.workEffortId,
                recordedDate: ec.user.nowTimestamp,
                userId: ec.user.userId,
                partyId: ec.user.userAccount?.partyId || null
            },
            fields
        )
    ).workEffortCheckId
}
function answerOf(check, repeated) {
    const step = one(WORK, {workEffortId: check.workEffortId})
    return {
        workEffortCheckId: check.workEffortCheckId,
        workEffortId: check.workEffortId,
        statusId: step?.statusId || null,
        accepted: check.checkStatusEnumId === "WcsAccepted",
        findingList: check.findings ? String(check.findings).split("\n") : [],
        measurementId: check.measurementId || null,
        voiceContentId: null,
        repeated
    }
}

// ===== transcribe#CheckVoiceNote =====
// A check's voice note as text (SpeechServices.transcribe#Audio), appended to its transcript; the recorder of the check or a
// supervisor. Only when the organization's MaintenancePolicy turns transcription on (voiceNoteTranscription, off by default: the
// user's call of Nov 12, P7 review); off, nothing is sent to the speech model (TRANSCRIPTION_OFF). A transcription that does not
// work is an answer (reasonCode); the audio stays the evidence either way.
function transcriptionOn(organizationPartyId) {
    const row = organizationPartyId
        ? Array.from(
              find("mantle.work.maintenance.MaintenancePolicy", {organizationPartyId})
                  .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                  .orderBy("-fromDate")
                  .limit(1)
                  .list()
          )[0]
        : null
    return flag(row?.voiceNoteTranscription)
}
function transcribeVoiceNote(p) {
    const userScope = scopeWithAny(["execute", "supervise"])
    const check = one(CHECK, {workEffortCheckId: text(p.workEffortCheckId)})
    if (!check) denied("RECORD_UNAVAILABLE", "Check " + (p.workEffortCheckId || "") + " is not available")
    const ctx = executionNode(userScope, check.workEffortId)
    if (check.userId !== ec.user.userId && !userScope.capabilities.supervise)
        denied("PERMISSION_DENIED", "The technician who recorded the check transcribes its voice note")
    if (!transcriptionOn(ctx.organizationPartyId)) return {transcribed: false, reasonCode: "TRANSCRIPTION_OFF"}
    const link = rows(EVIDENCE, {workEffortCheckId: check.workEffortCheckId, evidenceKindEnumId: "WceVoiceNote"})[0]
    const content = link ? one(CONTENT, {workEffortContentId: link.workEffortContentId}) : null
    if (!content?.contentLocation) return {transcribed: false, reasonCode: "NO_VOICE_NOTE"}
    const location = String(content.contentLocation)
    const extension = location.slice(location.lastIndexOf(".") + 1).toLowerCase()
    const mediaType =
        {wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm", mp3: "audio/mpeg", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac"}[
            extension
        ] || "audio/mpeg"
    let out = {}
    try {
        out =
            ec.service
                .sync()
                .name("org.moqui.call.SpeechServices.transcribe#Audio")
                .parameters({audioLocation: location, mediaType, purpose: "maintenanceCheck:" + check.workEffortCheckId, timeoutSeconds: 60})
                .disableAuthz()
                .call() || {}
    } catch (error) {
        ec.logger.error("Check " + check.workEffortCheckId + ": the voice note was not transcribed: " + error.message)
        return {transcribed: false, reasonCode: "failed"}
    }
    if (!text(out.text)) return {transcribed: false, reasonCode: out.reasonCode || "failed"}
    const transcript = [check.transcript, String(out.text).trim()].filter(Boolean).join("\n")
    call("update#" + CHECK, {workEffortCheckId: check.workEffortCheckId, transcript})
    return {transcribed: true, reasonCode: null, transcript}
}

// ===== waive#ProcessStep =====
function waiveStep(p) {
    const userScope = scopeWithAny(["execute", "supervise"])
    const ctx = executionNode(userScope, p.workEffortId, true)
    const {node, root} = ctx
    if (!userScope.capabilities.supervise) denied("PERMISSION_DENIED", "A supervisor waives a step")
    if (node.workEffortId === root.workEffortId) denied("STEP_REQUIRED", "A waiver is of a step")
    if (!waivingRoot.includes(root.statusId))
        denied("STATUS_INVALID", "A step is waived while the work is in progress or held; it is " + statusText(root.statusId))
    const ex = executionOf(root.workEffortId)
    if (isGroup(ex, node.workEffortId)) denied("GROUP_NO_RESPONSE", "A group is not waived; its steps are")
    if (doneStatuses.includes(node.statusId)) denied("STEP_DONE", "Step " + node.workEffortId + " is " + statusText(node.statusId))
    const policy = policyOf(node.workEffortId)
    if (policy.waiverAllowed !== "Y") denied("WAIVER_NOT_ALLOWED", "This step's policy does not let it be waived")
    // a waiver completes the step, so it waits for the step's dependencies as a response does (design §4.3; P7 review)
    const waiting = openDependencies(ex, node.workEffortId)
    if (waiting.length) denied("DEPENDENCY_OPEN", "Step " + node.workEffortId + " waits for " + waiting.map(w => w.name).join(", "))
    const reason = text(p.reason)
    if (!reason) denied("REASON_REQUIRED", "Say why the step is waived")
    let checkId = text(p.workEffortCheckId)
    if (checkId) {
        const named = one(CHECK, {workEffortCheckId: checkId})
        if (!named || named.workEffortId !== node.workEffortId) denied("VALUE_INVALID", "Check " + checkId + " is not of this step")
    } else
        checkId =
            Array.from(find(CHECK, {workEffortId: node.workEffortId, checkStatusEnumId: "WcsUnresolved"}).orderBy("-recordedDate").limit(1).list())[0]
                ?.workEffortCheckId || null
    const waiverId = call("create#" + WAIVER, {
        workEffortId: node.workEffortId,
        rootWorkEffortId: root.workEffortId,
        workEffortCheckId: checkId,
        reason,
        userId: ec.user.userId,
        partyId: ec.user.userAccount?.partyId || null,
        waivedDate: ec.user.nowTimestamp
    }).workEffortWaiverId
    setStatus(node.workEffortId, "WeComplete")
    rollUp(root.workEffortId, node.workEffortId)
    return {workEffortWaiverId: waiverId, workEffortId: node.workEffortId, statusId: "WeComplete"}
}

// ===== amend#ProcessExecution =====
// changeList: each a change of the execution, by its action:
// - change (the default): {workEffortId, isRequired, responseKindEnumId, measurementTypeId, measurementUomId, minimumValue,
//   maximumValue, evidenceRequired, commentRequired, waiverAllowed, dependsOnIds}, a step of the execution; a field given (empty
//   clears it) replaces the policy's. A changed policy of a complete step, or a dependency of it that is not done, invalidates its
//   acceptance.
// - add (the user's call of Nov 12, P7 review): {workEffortName, parentWorkEffortId (the work order's root, the default, or a group
//   of it), sequenceNum, description, estimatedWorkTime, the policy fields (required by default, a check off by default),
//   dependsOnIds}: a new step, not started; a complete group it is added to reopens (its completion is invalidated).
// - remove (the user's call of Nov 12): {workEffortId}: a step not yet started (planned or approved, no check recorded), with the
//   steps under it when it is a group; started or completed steps are refused (STEP_STARTED). A removed step is cancelled and named
//   in the amendment (its history kept), and what waited for it no longer does.
const notStarted = ["WeInPlanning", "WeApproved"]
// The steps an amendment removed from a root (the amendments' removedList), a Set of workEffortIds.
function removedIdsOf(rootId) {
    const out = new Set()
    for (const row of rows(AMENDMENT, {rootWorkEffortId: rootId}))
        for (const removed of lib.json(row.changeText, {}).removedList || []) out.add(removed.workEffortId)
    return out
}
function subtreeOf(ex, id) {
    const out = [id]
    for (const childId of ex.children[id] || []) out.push(...subtreeOf(ex, childId))
    return out
}
// The policy fields of a change, each normalized ("" clears it; the indicators Y or N); {after, changed} against before.
function policyChange(change, before) {
    const after = Object.assign({}, before)
    const changed = []
    for (const field of policyFields)
        if (change[field] !== undefined) {
            let next = change[field] === "" ? null : change[field]
            if (["isRequired", "evidenceRequired", "commentRequired", "waiverAllowed"].includes(field) && next != null)
                next = flag(next) ? "Y" : "N"
            if (String(before[field] ?? "") !== String(next ?? "")) {
                after[field] = next
                changed.push(field)
            }
        }
    if (changed.includes("responseKindEnumId") && after.responseKindEnumId &&
            !one("moqui.basic.Enumeration", {enumId: after.responseKindEnumId, enumTypeId: "WorkStepResponseKind"}))
        denied("VALUE_INVALID", "Response kind " + after.responseKindEnumId + " is not known")
    for (const field of ["minimumValue", "maximumValue"])
        if (changed.includes(field) && after[field] != null && !Number.isFinite(Number(String(after[field]))))
            denied("VALUE_INVALID", "A bound is a number")
    return {after, changed}
}
function amendExecution(p) {
    const userScope = scopeWithAny(["supervise"])
    const ctx = executionNode(userScope, p.rootWorkEffortId || p.workEffortId)
    const {root} = ctx
    if (closedRoot.includes(root.statusId))
        denied("WORK_CLOSED", "Work order " + root.workEffortId + " is " + statusText(root.statusId) + "; it is corrected, not amended")
    const preview = flag(p.preview)
    const reason = text(p.reason)
    if (!preview && !reason) denied("REASON_REQUIRED", "Say why the execution is amended")
    const changes = asList(p.changeList).map(change => (change?.getMap ? change.getMap() : Object.assign({}, change || {})))
    if (!changes.length) denied("CHANGE_REQUIRED", "Name the steps and what changes")
    const operationKey = text(p.operationKey)
    const hash = requestHash([root.workEffortId, reason, JSON.stringify(changes)])
    if (!preview) {
        const earlier = earlierUnderKey(AMENDMENT, operationKey, hash)
        if (earlier) return Object.assign(lib.json(earlier.changeText, {}), {executionAmendmentId: earlier.executionAmendmentId, repeated: true})
    }
    const ex = executionOf(root.workEffortId)
    const treeIds = new Set(ex.nodes.map(node => node.workEffortId))
    const at = nowMs()
    const dependsOnOf = (change, stepId) => {
        if (change.dependsOnIds === undefined) return null
        const ids = unique(asList(change.dependsOnIds).map(text))
        for (const id of ids) {
            if (id === stepId || !treeIds.has(id) || id === root.workEffortId)
                denied("DEPENDENCY_INVALID", "A step waits only for another step of its work order")
            if (stepId && workProcesses.dependsOn(id, stepId, treeIds)) denied("DEPENDENCY_INVALID", "A step cannot wait for a step that waits for it")
        }
        return ids
    }
    const planned = []
    const added = []
    const removed = []
    for (const change of changes) {
        const action = text(change.action) || "change"
        if (action === "add") {
            const name = text(change.workEffortName)
            if (!name) denied("NAME_REQUIRED", "Name the step that is added")
            const parentId = text(change.parentWorkEffortId) || root.workEffortId
            if (!treeIds.has(parentId)) denied("RECORD_UNAVAILABLE", "Step " + parentId + " is not a step of this work order")
            const parent = ex.byId[parentId]
            if (parentId !== root.workEffortId && !isGroup(ex, parentId))
                denied("GROUP_REQUIRED", "A step is added to the work order or to a group of it, not under a step")
            if (parentId !== root.workEffortId && parent.statusId === "WeCancelled")
                denied("STEP_DONE", "Group " + parentId + " is cancelled")
            const {after} = policyChange(change, {isRequired: "Y", responseKindEnumId: "WsrCheckOff"})
            const siblings = (ex.children[parentId] || []).map(id => number(ex.byId[id].sequenceNum) ?? 0)
            const sequenceNum = number(change.sequenceNum) ?? (siblings.length ? Math.max(...siblings) : 0) + 10
            const estimate = number(change.estimatedWorkTime)
            if (estimate != null && !(estimate >= 0)) denied("VALUE_INVALID", "An estimate is zero or more hours")
            added.push({
                name,
                parentId,
                parentName: parentId === root.workEffortId ? null : parent.workEffortName || parentId,
                parentComplete: parentId !== root.workEffortId && parent.statusId === "WeComplete",
                sequenceNum,
                description: text(change.description),
                estimate,
                policy: after,
                dependsOn: dependsOnOf(change, null) || []
            })
            continue
        }
        const stepId = text(change.workEffortId)
        if (!stepId || stepId === root.workEffortId || !treeIds.has(stepId))
            denied("RECORD_UNAVAILABLE", "Step " + (stepId || "") + " is not a step of this work order")
        const node = ex.byId[stepId]
        if (action === "remove") {
            const ids = subtreeOf(ex, stepId)
            const started = ids.filter(id => !notStarted.includes(ex.byId[id].statusId) || find(CHECK, {workEffortId: id}).count() > 0)
            if (started.length)
                denied("STEP_STARTED", "Step " + (ex.byId[started[0]].workEffortName || started[0]) + " has started; only a step not yet started is removed")
            removed.push({stepId, name: node.workEffortName || stepId, ids})
            continue
        }
        if (action !== "change") denied("ACTION_INVALID", "Unknown amendment action " + action)
        const before = policyOf(stepId)
        const {after, changed} = policyChange(change, before)
        if (isGroup(ex, stepId) && changed.some(field => field !== "isRequired"))
            denied("GROUP_NO_RESPONSE", "A group takes no response; amend its steps")
        planned.push({stepId, node, before, after, changed, dependsOn: dependsOnOf(change, stepId)})
    }
    const removedIds = new Set(removed.flatMap(row => row.ids))
    if (planned.some(plan => removedIds.has(plan.stepId) || (plan.dependsOn || []).some(id => removedIds.has(id))) ||
            added.some(row => removedIds.has(row.parentId) || row.dependsOn.some(id => removedIds.has(id))))
        denied("DEPENDENCY_INVALID", "A step that is removed is neither changed, a parent nor waited for")
    // what each change invalidates: a complete step whose policy changed, or that now waits for work not done; a complete group a
    // step is added to
    const invalidated = []
    const findings = []
    const reopened = new Set()
    for (const plan of planned) {
        const current = one(WORK, {workEffortId: plan.stepId})
        const waitsOpen = (plan.dependsOn || []).filter(id => !doneStatuses.includes(one(WORK, {workEffortId: id})?.statusId))
        if (current.statusId === "WeComplete" && !isGroup(ex, plan.stepId) && (plan.changed.length || waitsOpen.length)) {
            const accepted = rows(CHECK, {workEffortId: plan.stepId, checkStatusEnumId: "WcsAccepted"})
            const waivers = rows(WAIVER, {workEffortId: plan.stepId}).filter(row => !row.thruDate)
            invalidated.push({
                workEffortId: plan.stepId,
                name: plan.node.workEffortName || plan.stepId,
                checkIds: accepted.map(row => row.workEffortCheckId),
                waiverIds: waivers.map(row => row.workEffortWaiverId),
                why: plan.changed.length ? "its requirement changed (" + plan.changed.join(", ") + ")" : "it now waits for work not done"
            })
            reopened.add(plan.stepId)
        }
    }
    for (const row of added)
        if (row.parentComplete && !invalidated.some(item => item.workEffortId === row.parentId))
            invalidated.push({workEffortId: row.parentId, name: row.parentName, checkIds: [], waiverIds: [], why: "a step is added to it"})
    // the complete steps waiting for a reopened one are findings, not reopened
    for (const id of reopened)
        for (const edge of rows(ASSOC, {toWorkEffortId: id, workEffortAssocTypeEnumId: "WeatDependsOn"}).filter(row => openAt(row, at))) {
            const waiting = one(WORK, {workEffortId: edge.workEffortId})
            if (waiting && completeStatuses.includes(waiting.statusId) && !reopened.has(waiting.workEffortId))
                findings.push({
                    workEffortId: waiting.workEffortId,
                    message: (waiting.workEffortName || waiting.workEffortId) + " is complete and waits for " +
                        (ex.byId[id]?.workEffortName || id) + ", which is reopened"
                })
        }
    // the steps that waited for a removed one no longer do
    for (const row of removed)
        for (const edge of Array.from(find(ASSOC).condition("toWorkEffortId", "in", row.ids).condition("workEffortAssocTypeEnumId", "WeatDependsOn").list())
                .filter(edge => openAt(edge, at) && !removedIds.has(edge.workEffortId)))
            findings.push({
                workEffortId: edge.workEffortId,
                message: (ex.byId[edge.workEffortId]?.workEffortName || edge.workEffortId) + " no longer waits for " + row.name + ", which is removed"
            })
    const answer = {
        changeList: planned
            .map(plan => ({
                action: "change",
                workEffortId: plan.stepId,
                name: plan.node.workEffortName || plan.stepId,
                changedFields: plan.changed,
                dependsOnIds: plan.dependsOn
            }))
            .concat(added.map(row => ({action: "add", workEffortId: null, name: row.name, parentWorkEffortId: row.parentId, changedFields: [],
                dependsOnIds: row.dependsOn.length ? row.dependsOn : null})))
            .concat(removed.map(row => ({action: "remove", workEffortId: row.stepId, name: row.name, changedFields: [], dependsOnIds: null}))),
        invalidatedList: invalidated.map(row => ({workEffortId: row.workEffortId, name: row.name, why: row.why,
            checkCount: row.checkIds.length, waiverCount: row.waiverIds.length})),
        findingList: findings,
        addedList: added.map(row => ({name: row.name, parentWorkEffortId: row.parentId})),
        removedList: removed.flatMap(row => row.ids.map(id => ({workEffortId: id, name: ex.byId[id].workEffortName || id})))
    }
    if (preview) return Object.assign(answer, {preview: true})

    const amendmentId = call("create#" + AMENDMENT, {
        rootWorkEffortId: root.workEffortId,
        reason,
        effectiveDate: stamp(at),
        userId: ec.user.userId,
        amendedDate: stamp(at),
        changeText: JSON.stringify(answer),
        operationKey,
        operationHash: operationKey ? hash : null
    }).executionAmendmentId
    for (const plan of planned) {
        if (plan.changed.length) {
            const before = workProcesses.stepPolicyOf(plan.stepId)
            if (before) call("update#" + STEP, {workEffortId: plan.stepId, fromDate: before.fromDate, thruDate: stamp(at)})
            const next = {workEffortId: plan.stepId, fromDate: stamp(at), changeReason: reason}
            for (const field of ["isRequired", "roleTypeId", "dueOffsetDays"].concat(policyFields)) next[field] = plan.after[field] ?? null
            if (next.isRequired == null) next.isRequired = "Y"
            call("create#" + STEP, next)
        }
        if (plan.dependsOn) {
            const current = rows(ASSOC, {workEffortId: plan.stepId, workEffortAssocTypeEnumId: "WeatDependsOn"}).filter(row => openAt(row, at))
            for (const row of current)
                if (!plan.dependsOn.includes(row.toWorkEffortId))
                    call("update#" + ASSOC, {
                        workEffortId: row.workEffortId,
                        toWorkEffortId: row.toWorkEffortId,
                        workEffortAssocTypeEnumId: row.workEffortAssocTypeEnumId,
                        fromDate: row.fromDate,
                        thruDate: stamp(at)
                    })
            for (const id of plan.dependsOn)
                if (!current.some(row => row.toWorkEffortId === id))
                    call("create#" + ASSOC, {workEffortId: plan.stepId, toWorkEffortId: id, workEffortAssocTypeEnumId: "WeatDependsOn", fromDate: stamp(at)})
        }
    }
    for (const row of invalidated) {
        for (const checkId of row.checkIds)
            call("update#" + CHECK, {workEffortCheckId: checkId, checkStatusEnumId: "WcsInvalidated", invalidatedDate: stamp(at),
                executionAmendmentId: amendmentId})
        for (const waiverId of row.waiverIds)
            call("update#" + WAIVER, {workEffortWaiverId: waiverId, thruDate: stamp(at), executionAmendmentId: amendmentId})
        if (!added.some(item => item.parentId === row.workEffortId)) {
            setStatus(row.workEffortId, "WeInProgress")
            rollUp(root.workEffortId, row.workEffortId)
        }
    }
    // the added steps: a task of the work order, not started, with its policy from now and what it waits for
    const sample = ex.nodes.find(node => node.workEffortId !== root.workEffortId) || root
    const addedIds = []
    for (const row of added) {
        const id = call("create#" + WORK, {
            workEffortTypeEnumId: "WetTask",
            purposeEnumId: sample.purposeEnumId || root.purposeEnumId || null,
            ownerPartyId: root.ownerPartyId || null,
            timeUomId: root.timeUomId || "TF_hr",
            facilityId: root.facilityId || null,
            isTemplate: "N",
            statusId: "WeInPlanning",
            resolutionEnumId: "WerUnresolved",
            parentWorkEffortId: row.parentId,
            rootWorkEffortId: root.workEffortId,
            workEffortName: row.name,
            description: row.description,
            sequenceNum: row.sequenceNum,
            estimatedWorkTime: row.estimate,
            remainingWorkTime: row.estimate
        }).workEffortId
        const policy = {workEffortId: id, fromDate: stamp(at), changeReason: reason}
        for (const field of policyFields) policy[field] = row.policy[field] ?? null
        if (policy.isRequired == null) policy.isRequired = "Y"
        call("create#" + STEP, policy)
        for (const dependsOnId of row.dependsOn)
            call("create#" + ASSOC, {workEffortId: id, toWorkEffortId: dependsOnId, workEffortAssocTypeEnumId: "WeatDependsOn", fromDate: stamp(at)})
        rollUp(root.workEffortId, id)
        addedIds.push(id)
    }
    // the removed steps: cancelled (their rows and history kept), what they wait for and what waits for them ended
    for (const row of removed) {
        for (const edge of Array.from(
            find(ASSOC)
                .condition("workEffortAssocTypeEnumId", "WeatDependsOn")
                .condition(ec.entity.conditionFactory.makeCondition(
                    ec.entity.conditionFactory.makeCondition("workEffortId", "in", row.ids),
                    "or",
                    ec.entity.conditionFactory.makeCondition("toWorkEffortId", "in", row.ids)
                ))
                .list()
        ).filter(edge => openAt(edge, at)))
            call("update#" + ASSOC, {
                workEffortId: edge.workEffortId,
                toWorkEffortId: edge.toWorkEffortId,
                workEffortAssocTypeEnumId: edge.workEffortAssocTypeEnumId,
                fromDate: edge.fromDate,
                thruDate: stamp(at)
            })
        for (const id of row.ids.slice().reverse()) setStatus(id, "WeCancelled")
        rollUp(root.workEffortId, row.stepId)
    }
    return Object.assign(answer, {executionAmendmentId: amendmentId, addedIds, preview: false, repeated: false})
}

// ===== get#ProcessExecution =====
// The units a reading may be entered in: those of its measurement type's kind, the step's own first.
function unitOptions(policy) {
    const type = policy.measurementTypeId
        ? one("mantle.work.measurement.MeasurementType", {measurementTypeId: policy.measurementTypeId})
        : null
    const units = type?.uomTypeEnumId ? Array.from(find("moqui.basic.Uom", {uomTypeEnumId: type.uomTypeEnumId}).orderBy("description").limit(50).list()) : []
    const options = units.map(row => ({key: row.uomId, text: (row.description || row.uomId) + (row.abbreviation ? " (" + row.abbreviation + ")" : "")}))
    const own = options.findIndex(row => row.key === policy.measurementUomId)
    if (own > 0) options.unshift(options.splice(own, 1)[0])
    if (own < 0 && policy.measurementUomId) options.unshift({key: policy.measurementUomId, text: uomText(policy.measurementUomId)})
    return options
}
function responseTextOf(policy) {
    try {
        return procedures().responseText(policy)
    } catch (error) {
        return enumText(policy.responseKindEnumId)
    }
}
function checkRow(check, names, evidenceRows) {
    const valueText =
        check.measurementValue != null ? numberText(check.measurementValue) + " " + uomText(check.measurementUomId) : ""
    const files = evidenceRows
        .filter(row => row.workEffortCheckId === check.workEffortCheckId)
        .map(row => {
            const content = one(CONTENT, {workEffortContentId: row.workEffortContentId})
            const location = content?.contentLocation ? String(content.contentLocation) : ""
            return {
                workEffortContentId: row.workEffortContentId,
                fileName: location ? decodeURIComponent(location.slice(location.lastIndexOf("/") + 1)) : row.workEffortContentId,
                voiceNote: row.evidenceKindEnumId === "WceVoiceNote"
            }
        })
    return {
        workEffortCheckId: check.workEffortCheckId,
        workEffortId: check.workEffortId,
        outcomeEnumId: check.outcomeEnumId || null,
        outcomeText: check.outcomeEnumId ? enumText(check.outcomeEnumId) : "Not judged",
        checkStatusEnumId: check.checkStatusEnumId,
        stateText: enumText(check.checkStatusEnumId),
        accepted: check.checkStatusEnumId === "WcsAccepted",
        valueText,
        findingList: check.findings ? String(check.findings).split("\n") : [],
        comments: check.comments || "",
        transcript: check.transcript || "",
        byName: names[check.partyId] || check.userId || "",
        observedText: dateText(check.observedDate),
        recordedText: dateText(check.recordedDate),
        correctionReason: check.correctionReason || "",
        supersededCheckId: check.supersededCheckId || null,
        fileList: files,
        fileText: files.map(file => file.fileName).join(", ")
    }
}
function getExecution(p) {
    const userScope = scopeWithAny(["workRead"])
    const ctx = executionNode(userScope, p.workEffortId)
    const {root} = ctx
    const caps = userScope.capabilities
    const ex = executionOf(root.workEffortId)
    const stepIds = ex.nodes.slice(1).map(node => node.workEffortId)
    const checks = stepIds.length
        ? Array.from(find(CHECK).condition("workEffortId", "in", stepIds).orderBy("recordedDate").list())
        : []
    const waivers = stepIds.length ? Array.from(find(WAIVER).condition("workEffortId", "in", stepIds).orderBy("waivedDate").list()) : []
    const evidenceRows = checks.length
        ? Array.from(find(EVIDENCE).condition("workEffortCheckId", "in", checks.map(row => row.workEffortCheckId)).list())
        : []
    const assignees = stepIds.length
        ? Array.from(
              find(PARTY)
                  .condition("workEffortId", "in", stepIds.concat([root.workEffortId]))
                  .condition("roleTypeId", "Assignee")
                  .conditionDate("fromDate", "thruDate", ec.user.nowTimestamp)
                  .list()
          )
        : []
    const names = lib.partyNames(unique(checks.map(row => row.partyId).concat(waivers.map(row => row.partyId), assignees.map(row => row.partyId))))
    const rootAssignees = assignees.filter(row => row.workEffortId === root.workEffortId).map(row => names[row.partyId] || row.partyId)
    const working = workingRoot.includes(root.statusId)
    const rootAssigned = !!maintenanceAccess.assignment(userScope, root.workEffortId).root
    const removedIds = removedIdsOf(root.workEffortId)
    const stepList = []
    for (const node of ex.nodes.slice(1)) {
        const id = node.workEffortId
        const group = isGroup(ex, id)
        const policy = group ? {} : policyOf(id)
        const stepChecks = checks.filter(row => row.workEffortId === id)
        const current =
            stepChecks.filter(row => row.checkStatusEnumId === "WcsAccepted").slice(-1)[0] ||
            stepChecks.filter(row => row.checkStatusEnumId === "WcsUnresolved").slice(-1)[0] ||
            null
        const waiver = waivers.filter(row => row.workEffortId === id && !row.thruDate).slice(-1)[0] || null
        const waitingFor = group ? [] : openDependencies(ex, id)
        const assigned = rootAssigned || assignees.some(row => row.workEffortId === id && row.partyId === userScope.partyId)
        const executing = caps.supervise || (caps.execute && assigned)
        const done = doneStatuses.includes(node.statusId)
        const stepAssignees = assignees.filter(row => row.workEffortId === id).map(row => names[row.partyId] || row.partyId)
        const instruction = group ? null : procedures().executionInstruction(id)
        stepList.push({
            workEffortId: id,
            name: node.workEffortName || id,
            description: node.description || "",
            depth: ex.depth[id],
            indentPx: Math.max(0, ex.depth[id] - 1) * 20,
            isGroup: group,
            statusId: node.statusId,
            statusText: waiver && node.statusId === "WeComplete" ? "Waived" : node.statusId === "WeCancelled" && stepChecks.some(row => row.outcomeEnumId === "WcoSkipped") ? "Skipped" : removedIds.has(id) ? "Removed" : statusText(node.statusId),
            removed: removedIds.has(id),
            done,
            required: group ? null : requiredStep(policy),
            requiredText: group ? "" : requiredStep(policy) ? "Required" : "Optional",
            responseKindEnumId: policy.responseKindEnumId || (group ? null : "WsrCheckOff"),
            responseText: group ? "Group" : responseTextOf(policy) || "Check off",
            measurementTypeId: policy.measurementTypeId || null,
            measurementUomId: policy.measurementUomId || null,
            measurementUomText: uomText(policy.measurementUomId),
            unitOptions: policy.responseKindEnumId === "WsrReading" ? unitOptions(policy) : [],
            minimumValue: number(policy.minimumValue),
            maximumValue: number(policy.maximumValue),
            evidenceRequired: policy.evidenceRequired === "Y",
            commentRequired: policy.commentRequired === "Y",
            waiverAllowed: policy.waiverAllowed === "Y",
            blocked: waitingFor.length > 0,
            waitingText: waitingFor.length ? "Waits for " + waitingFor.map(row => row.name).join(", ") : "",
            assigneeText: (stepAssignees.length ? stepAssignees : rootAssignees).join(", "),
            instructionText: instruction?.text || "",
            instructionSummary: instruction?.summary || "",
            current: current ? checkRow(current, names, evidenceRows) : null,
            failureCount: stepChecks.filter(row => row.outcomeEnumId === "WcoFail" || row.checkStatusEnumId === "WcsUnresolved").length,
            checkCount: stepChecks.length,
            waiver: waiver
                ? {workEffortWaiverId: waiver.workEffortWaiverId, reason: waiver.reason || "", byName: names[waiver.partyId] || waiver.userId || "",
                      waivedText: dateText(waiver.waivedDate)}
                : null,
            canStart: !group && working && executing && ["WeInPlanning", "WeApproved"].includes(node.statusId) && !waitingFor.length,
            canRespond: !group && working && executing && !done && !waitingFor.length,
            canSkip: !group && working && executing && !done && !requiredStep(policy),
            canWaive: !group && waivingRoot.includes(root.statusId) && caps.supervise && !done && policy.waiverAllowed === "Y" && !waitingFor.length,
            canCorrect: !group && working && executing && node.statusId === "WeComplete" && !!current?.accepted
        })
    }
    const gate = gateOf(root.workEffortId)
    const leafRows = stepList.filter(row => !row.isGroup && !row.removed)
    const nextStep =
        leafRows.find(row => row.canRespond && row.statusId === "WeInProgress") || leafRows.find(row => row.canRespond || row.canStart) || null
    const amendments = rows(AMENDMENT, {rootWorkEffortId: root.workEffortId}).sort((a, b) => ms(b.amendedDate) - ms(a.amendedDate))
    return {
        execution: {
            rootWorkEffortId: root.workEffortId,
            workEffortName: root.workEffortName || root.workEffortId,
            statusId: root.statusId,
            statusText: statusText(root.statusId),
            hasSteps: stepList.length > 0,
            working,
            requiredCount: leafRows.filter(row => row.required).length,
            doneCount: leafRows.filter(row => row.required && completeStatuses.includes(row.statusId)).length,
            gateList: gate,
            gateText: gate.length ? "Open required steps: " + gate.map(row => row.name).join(", ") : "",
            nextStepId: nextStep?.workEffortId || null,
            nextStepName: nextStep?.name || "",
            canAmend: !!caps.supervise && !closedRoot.includes(root.statusId) && stepList.length > 0,
            checklistContentId:
                rows(CONTENT, {workEffortId: root.workEffortId, contentTypeEnumId: "WectCompletedChecklist"}).sort(
                    (a, b) => ms(b.contentDate) - ms(a.contentDate)
                )[0]?.workEffortContentId || null
        },
        stepList,
        checkList: checks
            .slice()
            .reverse()
            .map(row => Object.assign(checkRow(row, names, evidenceRows), {stepName: ex.byId[row.workEffortId]?.workEffortName || row.workEffortId})),
        waiverList: waivers.map(row => ({
            workEffortWaiverId: row.workEffortWaiverId,
            workEffortId: row.workEffortId,
            stepName: ex.byId[row.workEffortId]?.workEffortName || row.workEffortId,
            reason: row.reason || "",
            byName: names[row.partyId] || row.userId || "",
            waivedText: dateText(row.waivedDate),
            active: !row.thruDate
        })),
        amendmentList: amendments.map(row => ({
            executionAmendmentId: row.executionAmendmentId,
            reason: row.reason || "",
            amendedText: dateText(row.amendedDate),
            byName: row.userId || "",
            summary: (() => {
                const change = lib.json(row.changeText, {})
                return (change.addedList || [])
                    .map(item => "added " + item.name)
                    .concat((change.removedList || []).map(item => "removed " + item.name))
                    .concat((change.invalidatedList || []).map(item => item.name + ": " + item.why))
                    .join("; ")
            })()
        }))
    }
}

// ===== the completed checklist (design §12) =====
// The execution as printed: the steps with their outcomes, every failed observation and recheck, the waivers and evidence, the
// actors and times, and the closure decision. No cost.
function checklistHtml(rootId) {
    const ex = executionOf(rootId)
    const order = one(ORDER, {workEffortId: rootId})
    const root = ex.root
    const ids = ex.nodes.slice(1).map(node => node.workEffortId)
    const checks = ids.length ? Array.from(find(CHECK).condition("workEffortId", "in", ids).orderBy("recordedDate").list()) : []
    const waivers = ids.length ? Array.from(find(WAIVER).condition("workEffortId", "in", ids).orderBy("waivedDate").list()) : []
    const evidenceRows = checks.length
        ? Array.from(find(EVIDENCE).condition("workEffortCheckId", "in", checks.map(row => row.workEffortCheckId)).list())
        : []
    const names = lib.partyNames(unique(checks.map(row => row.partyId).concat(waivers.map(row => row.partyId))))
    const target = order?.assetId
        ? one("mantle.product.asset.Asset", {assetId: order.assetId})?.assetName || order.assetId
        : root.facilityId
          ? one("mantle.facility.Facility", {facilityId: root.facilityId})?.facilityName || root.facilityId
          : ""
    const removedIds = removedIdsOf(rootId)
    const steps = ex.nodes.slice(1).map(node => {
        const id = node.workEffortId
        const group = isGroup(ex, id)
        const policy = group ? {} : policyOf(id)
        const history = checks
            .filter(row => row.workEffortId === id)
            .map(row => {
                const shown = checkRow(row, names, evidenceRows)
                return [
                    shown.observedText,
                    shown.outcomeText + (shown.valueText ? " " + shown.valueText : ""),
                    shown.stateText,
                    shown.byName,
                    shown.findingList.join("; "),
                    shown.comments,
                    shown.correctionReason ? "correction: " + shown.correctionReason : "",
                    shown.fileText ? "evidence: " + shown.fileText : ""
                ]
                    .filter(Boolean)
                    .join(" · ")
            })
        const waived = waivers
            .filter(row => row.workEffortId === id)
            .map(row => "Waived " + dateText(row.waivedDate) + " by " + (names[row.partyId] || row.userId) + ": " + (row.reason || "") +
                (row.thruDate ? " (invalidated " + dateText(row.thruDate) + ")" : ""))
        return {
            name: node.workEffortName || id,
            indentMm: Math.max(0, ex.depth[id] - 1) * 5 + 2,
            required: group ? "Group" : requiredStep(policy) ? "Required" : "Optional",
            response: group ? "" : responseTextOf(policy),
            statusText: removedIds.has(id) ? "Removed by an amendment" : statusText(one(WORK, {workEffortId: id}).statusId),
            history,
            waivers: waived
        }
    })
    const exceptions = checks
        .filter(row => row.outcomeEnumId === "WcoFail" || row.checkStatusEnumId !== "WcsAccepted")
        .map(row => (ex.byId[row.workEffortId]?.workEffortName || row.workEffortId) + ": " + checkRow(row, names, evidenceRows).stateText +
            " " + (row.findings ? String(row.findings).replace(/\n/g, "; ") : enumText(row.outcomeEnumId)) + " (" + dateText(row.observedDate) + ")")
        .concat(waivers.map(row => (ex.byId[row.workEffortId]?.workEffortName || row.workEffortId) + ": waived, " + (row.reason || "")))
    return ec.resource.template("component://mr-mantle/template/work/Checklist.print.html.fancy", {
        workEffortId: root.workEffortId,
        workEffortName: root.workEffortName || root.workEffortId,
        targetName: target,
        organizationName: root.ownerPartyId ? lib.partyNames([root.ownerPartyId])[root.ownerPartyId] || root.ownerPartyId : "",
        procedureName: order?.procedureWorkEffortId
            ? one(WORK, {workEffortId: order.procedureWorkEffortId})?.workEffortName || order.procedureWorkEffortId
            : "",
        statusText: statusText(root.statusId),
        startedText: dateText(root.actualStartDate),
        finishedText: dateText(root.actualCompletionDate),
        outcomeText: enumText(order?.outcomeEnumId),
        dispositionText: enumText(order?.dispositionEnumId),
        asOfText: dateText(ec.user.nowTimestamp),
        printedBy: ec.user.userAccount?.userFullName || ec.user.username || "",
        steps,
        exceptions
    })
}
function checklistPdf(rootId) {
    return ec.resource.xslFoTransform(checklistHtml(rootId), null, null, "application/pdf")
}
// At close: the completed checklist stored as the root's WectCompletedChecklist content (the close's own pass through the evidence
// guard: closed work takes no other file); a PDF that cannot be made is logged and the close stands (the rows are the record), its
// error messages kept out of the close's.
function storeChecklist(rootId) {
    ec.message.pushErrors()
    try {
        const pdf = checklistPdf(rootId)
        const sequence = rows(CONTENT, {workEffortId: rootId, contentTypeEnumId: "WectCompletedChecklist"}).length + 1
        const location = "dbresource://mantle/content/workEffort/" + rootId + "/checklist_" + sequence + "/Checklist-" + rootId + ".pdf"
        ec.resource.getLocationReference(location).putBytes(pdf)
        return workProcesses.asManagedOwner(
            [rootId],
            () =>
                call("create#" + CONTENT, {
                    workEffortId: rootId,
                    contentTypeEnumId: "WectCompletedChecklist",
                    contentLocation: location,
                    contentChecksum: ec.resource.digest(location, "sha256"),
                    description: "Completed checklist of work order " + rootId,
                    contentDate: ec.user.nowTimestamp,
                    userId: ec.user.userId
                }).workEffortContentId
        )
    } catch (error) {
        ec.logger.error("Work order " + rootId + ": the completed checklist was not stored: " + error.message)
        return null
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// get#ProcessChecklist: the checklist of a work order the caller reads, as a PDF: the one stored at close, else made now.
function getChecklist(p) {
    const userScope = scopeWithAny(["workRead"])
    const {root} = executionNode(userScope, p.workEffortId)
    const stored = rows(CONTENT, {workEffortId: root.workEffortId, contentTypeEnumId: "WectCompletedChecklist"}).sort(
        (a, b) => ms(b.contentDate) - ms(a.contentDate)
    )[0]
    const fileName = "Checklist-" + root.workEffortId + ".pdf"
    if (stored?.contentLocation) {
        const ref = ec.resource.getLocationReference(String(stored.contentLocation))
        if (ref.getExists()) return {pdfBytes: null, contentLocation: String(stored.contentLocation), fileName, stored: true}
    }
    return {pdfBytes: checklistPdf(root.workEffortId), contentLocation: null, fileName, stored: false}
}

// ===== evidence =====
// get#EvidencePolicy: a work effort's files for RecordFiles. For managed work: whether files may be added or changed (not on
// closed or cancelled work) and the files checks name as evidence, which are never removed or replaced; ordinary work answers
// managed false and RecordFiles keeps its own rules.
function evidencePolicy(p) {
    const id = text(p.workEffortId)
    const node = id ? one(WORK, {workEffortId: id}) : null
    if (!node || !workProcesses.managedReason([id])) return {managed: false, canChange: true, protectedContentIds: []}
    const root = node.rootWorkEffortId ? one(WORK, {workEffortId: node.rootWorkEffortId}) : node
    if (root?.isTemplate === "Y") return {managed: true, canChange: true, protectedContentIds: []}
    const contentIds = rows(CONTENT, {workEffortId: id}).map(row => row.workEffortContentId)
    const protectedIds = contentIds.length
        ? unique(Array.from(find(EVIDENCE).condition("workEffortContentId", "in", contentIds).list()).map(row => row.workEffortContentId))
        : []
    return {
        managed: true,
        canChange: !["WeClosed", "WeCancelled"].includes(root?.statusId),
        protectedContentIds: protectedIds.concat(
            rows(CONTENT, {workEffortId: id, contentTypeEnumId: "WectCompletedChecklist"}).map(row => row.workEffortContentId)
        )
    }
}
// A file a check names, or a stored completed checklist: never changed, removed or given a new version.
function protectedContent(row) {
    if (!row) return false
    if (row.contentTypeEnumId === "WectCompletedChecklist") return true
    return find(EVIDENCE, {workEffortContentId: row.workEffortContentId}).count() > 0
}
// check#EvidenceChange: a file a check names, or the stored checklist, is not changed (EVIDENCE_PROTECTED).
function checkEvidenceChange(p) {
    const id = text(p.workEffortContentId)
    if (id && protectedContent(one(CONTENT, {workEffortContentId: id})))
        denied("EVIDENCE_PROTECTED", "File " + id + " is a check's evidence or a completed checklist; add a new file instead")
    return {}
}
// The entity's guard (Work.eecas.xml WorkEffortEvidenceProtected; impl-maintenance P7 review), whatever the path (the content
// services, RecordFiles, entity-auto, the entity REST): a check's evidence and a stored checklist are not updated or deleted; managed
// work that is closed or cancelled takes no new file; a completed checklist is stored only by the close (its owner's pass).
function guardEvidence(p) {
    const original = p.originalValue ? (p.originalValue.getMap ? p.originalValue.getMap() : p.originalValue) : null
    const value = Object.assign({}, original || {}, p.entityValue || {})
    if (p.eecaOperation === "update" || p.eecaOperation === "delete") {
        const stored = one(CONTENT, {workEffortContentId: value.workEffortContentId}) || value
        if (protectedContent(stored))
            throw new Error("EVIDENCE_PROTECTED: File " + value.workEffortContentId + " is a check's evidence or a completed checklist; add a new file instead")
        return {}
    }
    if (p.eecaOperation !== "create" || !value.workEffortId) return {}
    const node = one(WORK, {workEffortId: value.workEffortId})
    if (!node) return {}
    const rootId = node.rootWorkEffortId || node.workEffortId
    const passed = workProcesses.passedRoots().includes(rootId)
    if (value.contentTypeEnumId === "WectCompletedChecklist" && !passed)
        throw new Error("EVIDENCE_PROTECTED: A completed checklist is stored when its work order is closed")
    const root = rootId === node.workEffortId ? node : one(WORK, {workEffortId: rootId})
    if (["WeClosed", "WeCancelled"].includes(root?.statusId) && workProcesses.managedReason([node.workEffortId]))
        throw new Error("WORK_CLOSED: Work " + rootId + " is " + statusText(root.statusId) + "; it takes no new file")
    return {}
}
// The links of a check to its evidence are never changed or removed (the evidence would lose its protection).
function guardEvidenceLink(p) {
    throw new Error("EVIDENCE_PROTECTED: A check's evidence stays linked to it")
}

const operations = {
    getExecution,
    recordStep,
    waiveStep,
    amendExecution,
    transcribeVoiceNote,
    getChecklist,
    evidencePolicy,
    checkEvidenceChange,
    guardEvidence,
    guardEvidenceLink
}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown process check operation " + op)
        return operations[op](parameters || {})
    },
    // for MaintenanceWork.js: the root's Complete gate and its close or cancel
    gateOf,
    closeExecution
})
