// People's HR vocabularies (mantle.humanres.PeopleServices find#Lookups and store#Lookup; IronStone People design §12 Lookups,
// PE-03; impl-people P5): the Enumeration families People maintains, a whitelist, never an arbitrary enumeration, status or
// service. A value is added, renamed, reordered or ended (Enumeration.thruDate), never deleted: the records that hold it keep it,
// and no new record takes it. Each family names where its values are used, so the list shows a value's use. Read by the People
// administrator and an HR reader, changed by the People administrator (PEOPLE_CONFIGURE). Later phases add their families (leave
// types, applicant stages, qualification types) to the table.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied, call, dateText} = lib
const ms = lib.ms

const ENUM = "moqui.basic.Enumeration"
// the families: their name, and the fields of the records that hold a value (counted as its use)
const families = {
    TerminationReason: {
        title: "Termination reasons",
        uses: [["mantle.humanres.employment.Employment", "terminationReasonEnumId"]]
    },
    TerminationType: {
        title: "Termination types",
        uses: [["mantle.humanres.employment.Employment", "terminationTypeEnumId"]]
    },
    SkillType: {
        title: "Skill types",
        uses: [
            ["mantle.humanres.ability.PartySkill", "skillTypeEnumId"],
            ["mantle.humanres.position.EmplPositionClassSkill", "skillTypeEnumId"]
        ]
    },
    SkillLevel: {title: "Skill levels", uses: []}
}
// the most values a family lists
const valueCap = 500

const text = value => String(value ?? "").trim()
const nowMs = () => ms(ec.user.nowTimestamp)
const stampOf = row => ms(row?.lastUpdatedStamp) ?? 0
function reader() {
    if (!lib.access.has("PEOPLE_CONFIGURE") && !lib.access.has("PEOPLE_HR_VIEW"))
        denied("PERMISSION_DENIED", "HR vocabularies need PEOPLE_CONFIGURE or PEOPLE_HR_VIEW")
}
function family(enumTypeId) {
    const id = text(enumTypeId)
    if (!Object.hasOwn(families, id)) denied("FAMILY_INVALID", "Choose one of People's vocabularies")
    return id
}
// How many records hold each value of a family.
function usesOf(enumTypeId, enumIds) {
    const counts = Object.fromEntries(enumIds.map(enumId => [enumId, 0]))
    if (!enumIds.length) return counts
    for (const [entityName, field] of families[enumTypeId].uses) {
        try {
            for (const enumId of enumIds) counts[enumId] += find(entityName).condition(field, enumId).count()
        } catch (error) {
            ec.logger.error("The use of " + enumTypeId + " values in " + entityName + " could not be counted: " + error.message)
        }
    }
    return counts
}

// find#Lookups: the families (each with its value count), and the values of one family asked for, current unless ended ones
// are asked for, in their order, each with its use and whether the caller may change it.
function findLookups(p) {
    reader()
    const canEdit = lib.access.has("PEOPLE_CONFIGURE")
    const familyRows = Object.entries(families).map(([enumTypeId, definition]) => ({
        enumTypeId,
        title: definition.title,
        valueCount: find(ENUM).condition("enumTypeId", enumTypeId).count()
    }))
    if (!text(p.enumTypeId)) return {families: familyRows, values: [], enumTypeId: null, canEdit}
    const enumTypeId = family(p.enumTypeId)
    let query = find(ENUM).condition("enumTypeId", enumTypeId).orderBy(["sequenceNum", "description"])
    if (!(p.includeEnded === true || p.includeEnded === "true")) {
        const factory = ec.entity.conditionFactory
        query = query.condition(
            factory.makeCondition(
                factory.makeCondition("thruDate", "is-null", null),
                "or",
                factory.makeCondition("thruDate", "greater", ec.user.nowTimestamp)
            )
        )
    }
    const found = Array.from(query.limit(valueCap).list())
    const uses = usesOf(
        enumTypeId,
        found.map(row => row.enumId)
    )
    const now = nowMs()
    const values = found.map(row => {
        const ended = (ms(row.thruDate) ?? Infinity) <= now
        return {
            enumId: row.enumId,
            enumTypeId,
            description: row.description || row.enumId,
            enumCode: row.enumCode || "",
            sequenceNum: row.sequenceNum ?? null,
            useCount: uses[row.enumId] || 0,
            ended,
            stateText: ended ? "Ended " + dateText(row.thruDate) : "In use",
            canEdit: canEdit && !ended,
            revision: String(stampOf(row))
        }
    })
    return {families: familyRows, values, enumTypeId, canEdit}
}

// store#Lookup: a new value of a family (its description, code and order), a value's new description, code or order, or its end
// (end: true, from now). Refused: a caller without PEOPLE_CONFIGURE (PERMISSION_DENIED); a family not People's (FAMILY_INVALID);
// a value not of the family (RECORD_UNAVAILABLE); no description (DESCRIPTION_REQUIRED); a description another current value of
// the family has (DUPLICATE_VALUE); an order that is not a whole number (SEQUENCE_INVALID); an ended value (VALUE_ENDED); a
// revision other than the one read (REVISION_CHANGED). Nothing is deleted.
function storeLookup(p) {
    if (!lib.access.has("PEOPLE_CONFIGURE")) denied("PERMISSION_DENIED", "Changing HR vocabularies needs PEOPLE_CONFIGURE")
    const enumTypeId = family(p.enumTypeId)
    const sequenceNum = p.sequenceNum == null || text(p.sequenceNum) === "" ? null : Number(text(p.sequenceNum))
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
        const description = text(p.description)
        if (!description) denied("DESCRIPTION_REQUIRED", "Give the value's name")
        if (duplicate(description, null)) denied("DUPLICATE_VALUE", description + " is already a value of this vocabulary")
        const created = call("create#" + ENUM, {
            enumTypeId,
            description,
            enumCode: text(p.enumCode) || null,
            sequenceNum
        })
        const row = one(ENUM, {enumId: created.enumId})
        return {enumId: row.enumId, revision: String(stampOf(row))}
    }
    const row = one(ENUM, {enumId: text(p.enumId)})
    if (!row || row.enumTypeId !== enumTypeId) denied("RECORD_UNAVAILABLE", "This value is not available")
    if ((ms(row.thruDate) ?? Infinity) <= now) denied("VALUE_ENDED", (row.description || row.enumId) + " has ended")
    const revision = String(stampOf(row))
    if (text(p.expectedRevision) !== revision)
        denied("REVISION_CHANGED", "This value changed since you read it; open it again (revision " + revision + ")")
    const changes = {enumId: row.enumId}
    if (p.end === true || p.end === "true" || p.end === "Y") changes.thruDate = ec.user.nowTimestamp
    if (p.description != null) {
        const description = text(p.description)
        if (!description) denied("DESCRIPTION_REQUIRED", "Give the value's name")
        if (description !== row.description && duplicate(description, row.enumId))
            denied("DUPLICATE_VALUE", description + " is already a value of this vocabulary")
        changes.description = description
    }
    if (p.enumCode != null) changes.enumCode = text(p.enumCode) || null
    if (p.sequenceNum != null) changes.sequenceNum = sequenceNum
    if (Object.keys(changes).length > 1) call("update#" + ENUM, changes)
    const stored = one(ENUM, {enumId: row.enumId})
    return {enumId: stored.enumId, revision: String(stampOf(stored))}
}

const operations = {findLookups, storeLookup}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown lookup operation " + op)
    return operations[op](p || {})
}
;({execute: run})
