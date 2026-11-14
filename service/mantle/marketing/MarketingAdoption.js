// Adoption (IronStone Marketing design §15.4; impl-marketing P1, X12): the campaigns, lists and segments that belong to no
// organization (a campaign with no organizationPartyId, a list that is not a mailbox and a segment whose ownerPartyId is empty
// or _NA_), each assigned by a Marketing administrator to an organization they may work in, one result per record. Until then
// nothing reads, edits or sends an unowned record through a Marketing service (MarketingAccess.js: no scope covers it), and the
// organization filters leave it to an administrator's grant. Unknown historical consent stays unknown: adoption assigns the
// owner and nothing else.
//
// - preview: the unowned records of each kind, at most recordLimit each, with their counts and revisions.
// - apply: each assignment on its own (its own transaction and error frame), refused by reason code and the others applied: an
//   unknown kind UNKNOWN_KIND, a record that is missing or a mailbox RECORD_UNAVAILABLE, a record already owned ALREADY_OWNED
//   (an adoption applies once: a second apply of the same record changes nothing), a revision that is not the one read
//   REVISION_CHANGED (naming the current one), an organization outside the administrator's scope ORGANIZATION_DENIED.
// - unownedCounts: the counts the readiness check and Home's attention read.
//
// Every operation needs MARKETING_CONFIGURE (PERMISSION_DENIED).
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const marketingAccess = ec.resource.script("component://mr-mantle/service/mantle/marketing/MarketingAccess.js")
const {find, one, denied, reasonCode} = lib

const recordLimit = 200
const unownedValues = ["_NA_"]
// Each kind of record adoption assigns: its entity, key, name, owner field and how its unowned rows are found.
const kinds = {
    campaign: {
        name: "Campaign",
        entity: "mantle.marketing.campaign.MarketingCampaign",
        key: "marketingCampaignId",
        label: row => row.campaignName || row.marketingCampaignId,
        detail: row => row.statusId || "",
        ownerField: "organizationPartyId"
    },
    list: {
        name: "List",
        entity: "mantle.marketing.contact.ContactList",
        key: "contactListId",
        label: row => row.contactListName || row.contactListId,
        detail: row => row.contactListTypeEnumId || "",
        ownerField: "ownerPartyId",
        // a mailbox is the internal Inbox's, never Marketing's
        narrow: (query, cf) => query.condition(cf.makeCondition("contactListTypeEnumId", "not-equals", "MAILBOX", true)),
        excluded: row => row.contactListTypeEnumId === "MAILBOX"
    },
    segment: {
        name: "Segment",
        entity: "mantle.marketing.segment.MarketSegment",
        key: "marketSegmentId",
        label: row => row.description || row.marketSegmentId,
        detail: row => row.marketSegmentTypeEnumId || "",
        ownerField: "ownerPartyId"
    }
}

function configurer() {
    const userScope = marketingAccess.scope()
    if (!userScope.capabilities.configure) denied("PERMISSION_DENIED", "Marketing configure is required")
    return userScope
}
// The unowned rows of a kind: its owner field empty or _NA_.
function unownedQuery(kind) {
    const cf = ec.entity.conditionFactory
    let query = find(kind.entity).condition(cf.makeCondition(kind.ownerField, "in", unownedValues, true))
    if (kind.narrow) query = kind.narrow(query, cf)
    return query
}
// The counts of unowned records by kind (no permission: for the readiness check and Home, which check theirs).
function unownedCounts() {
    const counts = {}
    for (const [kindKey, kind] of Object.entries(kinds)) counts[kindKey] = unownedQuery(kind).count()
    return counts
}

// preview#Adoption: the unowned records of each kind.
function preview() {
    configurer()
    const records = []
    const counts = {}
    for (const [kindKey, kind] of Object.entries(kinds)) {
        counts[kindKey] = unownedQuery(kind).count()
        for (const row of Array.from(unownedQuery(kind).orderBy(kind.key).limit(recordLimit).list()))
            records.push({
                recordKind: kindKey,
                kindName: kind.name,
                recordId: row[kind.key],
                label: kind.label(row),
                detail: kind.detail(row),
                lastUpdatedStamp: row.lastUpdatedStamp,
                // the same revision as millis, for a form to post back
                revision: lib.ms(row.lastUpdatedStamp)
            })
    }
    return {records, counts}
}

// One assignment: checked, then written in its own transaction.
function adoptOne(userScope, assignment) {
    const kindKey = String(assignment.recordKind || "")
    const kind = Object.hasOwn(kinds, kindKey) ? kinds[kindKey] : null
    if (!kind) denied("UNKNOWN_KIND", "Unknown kind of record " + kindKey)
    const recordId = String(assignment.recordId || "")
    const organizationPartyId = String(assignment.organizationPartyId || "")
    marketingAccess.requireOrganization(userScope, organizationPartyId)
    const row = recordId ? one(kind.entity, {[kind.key]: recordId}) : null
    if (!row || (kind.excluded && kind.excluded(row)))
        denied("RECORD_UNAVAILABLE", kind.name + " " + recordId + " is not available")
    if (!marketingAccess.unowned(row[kind.ownerField]))
        denied("ALREADY_OWNED", kind.name + " " + recordId + " already belongs to an organization")
    const read = assignment.lastUpdatedStamp
    if (read != null && read !== "" && lib.ms(read) !== lib.ms(row.lastUpdatedStamp))
        denied(
            "REVISION_CHANGED",
            kind.name + " " + recordId + " changed since it was read; its revision is now " + row.lastUpdatedStamp
        )
    ec.transaction.runRequireNew(60, "Error adopting " + kind.name + " " + recordId, () => {
        lib.call("update#" + kind.entity, {
            [kind.key]: recordId,
            [kind.ownerField]: organizationPartyId,
            [kind.ownerField + "_changeReason"]: "Adopted by " + (ec.user.username || ec.user.userId)
        })
        // a campaign's organization is its dated MarketingOrganization row, which the field copies (design §1.1)
        if (kindKey === "campaign")
            lib.call("create#mantle.marketing.campaign.MarketingCampaignParty", {
                marketingCampaignId: recordId,
                partyId: organizationPartyId,
                roleTypeId: "MarketingOrganization",
                fromDate: ec.user.nowTimestamp
            })
    })
}
// apply#Adoption: each assignment on its own, one result each.
function apply(p) {
    const userScope = configurer()
    const assignments = Array.from(p.assignments || [])
    const results = []
    for (const assignment of assignments) {
        const result = {
            recordKind: assignment.recordKind || null,
            recordId: assignment.recordId || null,
            organizationPartyId: assignment.organizationPartyId || null,
            adopted: false,
            reasonCode: null,
            message: null
        }
        ec.message.pushErrors()
        try {
            adoptOne(userScope, assignment)
            if (ec.message.hasError()) throw new Error(ec.message.getErrorsString())
            result.adopted = true
        } catch (error) {
            result.reasonCode = reasonCode(error) || "ADOPTION_FAILED"
            result.message = String(error.message)
            if (!reasonCode(error))
                ec.logger.error(
                    "Marketing adoption of " + result.recordKind + " " + result.recordId + " failed: " + error.message
                )
        } finally {
            ec.message.clearErrors()
            ec.message.popErrors()
        }
        results.push(result)
    }
    return {
        results,
        adoptedCount: results.filter(result => result.adopted).length,
        failedCount: results.filter(result => !result.adopted).length
    }
}

const operations = {preview, apply}
;({
    execute: (op, parameters) => {
        if (!Object.hasOwn(operations, op)) throw new Error("Unknown marketing adoption operation " + op)
        return operations[op](parameters || {})
    },
    kinds,
    unownedCounts
})
