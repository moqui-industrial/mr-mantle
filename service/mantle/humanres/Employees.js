// The employee record (mantle.humanres.PeopleServices find#Employees, get#Employee360, get#EmploymentHistory, store#PersonalInfo,
// check#EmploymentAccess and create#EmploymentContent; IronStone People design §4 Employees and Employee360, §1.1, §13, §15;
// impl-people P2). Every answer is a projection of the caller's People scope (People.js scopeOf and partyAccess), read with
// authorization off after that check, and answered by employment: a reader of one employer sees that employment and the
// person's public work identity, nothing of another employer's (F59).
//
// The projections, by field category:
// - the public work identity (any reader the scope admits): name and preferred name, employer, job title, manager, the work
//   email, phone and address (the contact purposes of workPurposes) and the employment's state;
// - HR columns (an HR reader of the employer): the employment's id and dates, ended employments, the termination reason;
// - private person data (the person themselves, or an HR reader of an employer of theirs): the private contacts of
//   privatePurposes, birth date and gender, and for HR the identifications other than tax ones, their values masked. Tax and
//   bank fields are reviewed payroll setup (P23) and are neither read nor written here.
// Pay, review, case and leave data is never part of any answer. Missing and unauthorized people are refused alike
// (RECORD_UNAVAILABLE, from partyAccess).
const people = ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {find, one, denied, call, dateText, hash} = lib

const EMPLOYMENT = "mantle.humanres.employment.Employment"
// the contact purposes of the public work identity, and of the private contacts
const workPurposes = {workEmail: "EmailPrimary", workPhone: "PhoneWork", workAddress: "PostalWork"}
const privatePurposes = {homePhone: "PhoneHome", mobilePhone: "PhoneMobile", homeAddress: "PostalHome"}
// identifications that are tax fields: payroll's reviewed setup, never shown or written here
const taxIdTypes = ["PtidSsn", "PtidFein", "PtidFuid"]
// what a person may correct themselves; an HR editor of their employer may change these and the rest
const selfFields = ["preferredName", "homePhone", "mobilePhone"]
const hrFields = ["firstName", "middleName", "lastName", "suffix", "birthDate", "gender", "homeAddress"]
const addressFields = ["address1", "address2", "city", "postalCode", "stateProvinceGeoId", "countryGeoId"]
// the most rows a directory export (pageNoLimit) answers
const exportCap = 2000

const likeText = text => "%" + String(text).replace(/[\\%_]/g, character => "\\" + character) + "%"
const truthy = value => value === true || value === "true" || value === "Y"
const given = value => value != null
const blank = value => value == null || String(value).trim() === ""
const nameOf = row => [row?.firstName, row?.lastName].filter(Boolean).join(" ")

// ===== names, contacts, managers and titles, each read for a whole list in one query =====
function phoneText(row) {
    return [row.countryCode ? "+" + row.countryCode : null, row.areaCode, row.contactNumber].filter(Boolean).join(" ")
}
function addressText(row) {
    return [row.address1, row.address2, [row.postalCode, row.city].filter(Boolean).join(" "), row.countryGeoId]
        .filter(Boolean)
        .join(", ")
}
// The current contacts of the people for the purposes ({key: purposeId}): {partyId: {key: text}}, and with withValues the
// address fields of a postal one ({key + "Fields": {...}}).
function contactsOf(partyIds, purposes, withValues = false) {
    const found = {}
    if (!partyIds.length) return found
    const keyOf = Object.fromEntries(Object.entries(purposes).map(([key, purposeId]) => [purposeId, key]))
    const links = Array.from(
        people
            .current(
                find("mantle.party.contact.PartyContactMech")
                    .condition("partyId", "in", partyIds)
                    .condition("contactMechPurposeId", "in", Object.values(purposes)),
                null
            )
            .orderBy("-fromDate")
            .list()
    )
    if (!links.length) return found
    const mechIds = people.unique(links.map(row => row.contactMechId))
    const byId = (entity, fields) =>
        new Map(
            Array.from(
                find(entity).condition("contactMechId", "in", mechIds).selectField(["contactMechId"].concat(fields)).list()
            ).map(row => [row.contactMechId, row])
        )
    const mechs = byId("mantle.party.contact.ContactMech", ["contactMechTypeEnumId", "infoString"])
    const phones = byId("mantle.party.contact.TelecomNumber", ["countryCode", "areaCode", "contactNumber"])
    const addresses = byId("mantle.party.contact.PostalAddress", addressFields)
    for (const link of links) {
        const key = keyOf[link.contactMechPurposeId]
        const contacts = found[link.partyId] || (found[link.partyId] = {})
        // the newest of a purpose
        if (contacts[key] != null) continue
        const mech = mechs.get(link.contactMechId)
        if (!mech) continue
        if (mech.contactMechTypeEnumId === "CmtTelecomNumber") {
            const phone = phones.get(link.contactMechId)
            contacts[key] = phone ? phoneText(phone) : ""
        } else if (mech.contactMechTypeEnumId === "CmtPostalAddress") {
            const address = addresses.get(link.contactMechId)
            contacts[key] = address ? addressText(address) : ""
            if (withValues && address)
                contacts[key + "Fields"] = Object.fromEntries(addressFields.map(f => [f, address[f] || null]))
            if (address) contacts[key + "City"] = address.city || ""
        } else contacts[key] = mech.infoString || ""
    }
    return found
}
// The live managers of the people (PrtManager from the manager to the report, F50): {partyId: [managerPartyId]}.
function managersOf(partyIds) {
    const found = {}
    if (!partyIds.length) return found
    const query = find("mantle.party.PartyRelationship")
        .condition("relationshipTypeEnumId", "PrtManager")
        .condition("toPartyId", "in", partyIds)
        .selectField(["fromPartyId", "toPartyId"])
    for (const row of Array.from(people.current(query, null).list()))
        (found[row.toPartyId] = found[row.toPartyId] || []).push(row.fromPartyId)
    return found
}
// The job title of each employment: its position's class title, else the position's description (positions are P4's).
function titlesOf(employmentIds) {
    const found = {}
    if (!employmentIds.length) return found
    const employments = Array.from(
        find(EMPLOYMENT)
            .condition("partyRelationshipId", "in", employmentIds)
            .selectField(["partyRelationshipId", "emplPositionId", "terminationReasonEnumId"])
            .list()
    )
    const positionIds = people.unique(employments.map(row => row.emplPositionId).filter(Boolean))
    const positions = positionIds.length
        ? new Map(
              Array.from(find("mantle.humanres.position.EmplPosition").condition("emplPositionId", "in", positionIds).list()).map(
                  row => [row.emplPositionId, row]
              )
          )
        : new Map()
    const classIds = people.unique(
        Array.from(positions.values())
            .map(row => row.emplPositionClassId)
            .filter(Boolean)
    )
    const classes = classIds.length
        ? new Map(
              Array.from(
                  find("mantle.humanres.position.EmplPositionClass").condition("emplPositionClassId", "in", classIds).list()
              ).map(row => [row.emplPositionClassId, row])
          )
        : new Map()
    for (const row of employments) {
        const position = row.emplPositionId ? positions.get(row.emplPositionId) : null
        const positionClass = position?.emplPositionClassId ? classes.get(position.emplPositionClassId) : null
        found[row.partyRelationshipId] = {
            jobTitle: positionClass?.title || position?.description || "",
            terminationReasonEnumId: row.terminationReasonEnumId || null
        }
    }
    return found
}
function enumNames(enumIds) {
    const ids = people.unique(enumIds.filter(Boolean))
    if (!ids.length) return {}
    return Object.fromEntries(
        Array.from(find("moqui.basic.Enumeration").condition("enumId", "in", ids).list()).map(row => [
            row.enumId,
            row.description
        ])
    )
}
// The state of an employment on the as-of time: Current, Ended or Starts <day>.
function stateOf(row, asOf) {
    const from = lib.ms(row.fromDate)
    const thru = lib.ms(row.thruDate)
    if (thru != null && thru <= asOf) return {state: "ended", stateText: "Ended"}
    if (from != null && from > asOf) return {state: "future", stateText: "Starts " + dateText(row.fromDate)}
    return {state: "current", stateText: "Current"}
}
// Employments as the answer shows them: the employer's name, the job title, the state, and for an HR reader the dates.
function employmentRows(rows, asOf, withDates) {
    const titles = titlesOf(rows.map(row => row.partyRelationshipId))
    const organizations = people.organizationNames(people.unique(rows.map(row => row.organizationPartyId)))
    const reasons = withDates ? enumNames(Object.values(titles).map(row => row.terminationReasonEnumId)) : {}
    return rows.map(row => {
        const title = titles[row.partyRelationshipId] || {}
        const out = Object.assign(
            {
                partyRelationshipId: row.partyRelationshipId,
                organizationPartyId: row.organizationPartyId,
                organizationName: organizations[row.organizationPartyId] || row.organizationPartyId,
                jobTitle: title.jobTitle || ""
            },
            stateOf(row, asOf)
        )
        if (withDates)
            Object.assign(out, {
                fromDate: row.fromDate,
                thruDate: row.thruDate || null,
                fromDateText: dateText(row.fromDate),
                thruDateText: dateText(row.thruDate),
                terminationReason: reasons[title.terminationReasonEnumId] || ""
            })
        return out
    })
}

// ===== find#Employees =====
// The directory (design §4 Employees, §15): the employments the caller's scope reaches as of the date, each a row of the public
// work identity, with the HR columns for an HR reader. Reach: an employment by an employer a staff reader sees (current on the
// date, or any for an HR reader asking for ended ones too), a live report's and the caller's own current one. Searched by name or
// id in the query ignoring case; filtered by employer (refused outside the scope) and manager; paged, or for an export every row
// up to exportCap.
function findEmployees(p) {
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    people.requireOrganization(userScope, p.organizationPartyId)
    const asOf = people.asOfMillis(p.asOfDate)
    const hr = !!caps.hrView
    const includeEnded = hr && truthy(p.includeEnded)
    const factory = ec.entity.conditionFactory
    const all = list => factory.makeCondition(list.filter(Boolean), "and")
    const dated = factory.makeConditionDate("fromDate", "thruDate", people.stamp(asOf))
    const reach = []
    const employerIds = p.organizationPartyId ? [p.organizationPartyId] : Array.from(userScope.organizationPartyIds || [])
    if (caps.staff && employerIds.length)
        reach.push(all([factory.makeCondition("toPartyId", "in", employerIds), includeEnded ? null : dated]))
    const own = Array.from(userScope.reportPartyIds || []).concat(caps.self && userScope.partyId ? [userScope.partyId] : [])
    if (own.length && !p.organizationPartyId) reach.push(all([factory.makeCondition("fromPartyId", "in", own), dated]))
    if (!reach.length) denied("PERMISSION_DENIED", "The employee directory is not available")

    let query = find("mantle.party.PartyFromAndRelationship")
        .condition("relationshipTypeEnumId", "PrtEmployee")
        .condition(factory.makeCondition(reach, "or"))
    if (p.managerPartyId) {
        const reports = Array.from(
            people
                .current(
                    find("mantle.party.PartyRelationship")
                        .condition("relationshipTypeEnumId", "PrtManager")
                        .condition("fromPartyId", p.managerPartyId),
                    null
                )
                .selectField("toPartyId")
                .list()
        ).map(row => row.toPartyId)
        query = query.condition("fromPartyId", "in", reports.length ? reports : ["_NA_"])
    }
    const term = String(p.term || "").trim()
    if (term)
        query = query.condition(
            factory.makeCondition(
                ["fromPartyId", "firstName", "lastName", "nickname"].map(field =>
                    factory.makeCondition(field, "like", likeText(term)).ignoreCase()
                ),
                "or"
            )
        )
    query = query
        .selectField([
            "partyRelationshipId",
            "fromPartyId",
            "toPartyId",
            "fromDate",
            "thruDate",
            "firstName",
            "lastName",
            "nickname"
        ])
        .orderBy(["^firstName", "^lastName", "toPartyId"])
    const paged = lib.page(query, p, "employees", query.count(), {noLimitCap: exportCap})
    const found = paged.rows.map(row => ({
        partyRelationshipId: row.partyRelationshipId,
        partyId: row.fromPartyId,
        organizationPartyId: row.toPartyId,
        fromDate: row.fromDate,
        thruDate: row.thruDate,
        personName: nameOf(row) || row.fromPartyId,
        preferredName: row.nickname || ""
    }))
    const partyIds = people.unique(found.map(row => row.partyId))
    const contacts = contactsOf(partyIds, workPurposes)
    const managers = managersOf(partyIds)
    const managerNames = people.personNames(people.unique([].concat(...Object.values(managers))))
    const shown = employmentRows(found, asOf, hr)
    const employees = found.map((row, index) => {
        const contact = contacts[row.partyId] || {}
        const managerIds = managers[row.partyId] || []
        const out = Object.assign({}, shown[index], {
            partyId: row.partyId,
            personName: row.personName,
            preferredName: row.preferredName,
            managerPartyId: managerIds[0] || null,
            managerName: managerIds.map(partyId => managerNames[partyId] || partyId).join(", "),
            workEmail: contact.workEmail || "",
            workPhone: contact.workPhone || "",
            workLocation: contact.workAddressCity || ""
        })
        // the employment's id is an HR host's: a directory reader gets the person only
        if (!hr) delete out.partyRelationshipId
        return out
    })
    const out = {employees, hrColumns: hr, asOfDate: asOf}
    for (const key of ["Count", "PageIndex", "PageSize", "PageMaxIndex", "PageRangeLow", "PageRangeHigh"])
        out["employees" + key] = paged["employees" + key]
    return out
}

// ===== get#Employee360 =====
function sortEmployments(rows, asOf) {
    const rank = row => ({current: 0, future: 1, ended: 2})[stateOf(row, asOf).state]
    return rows.slice().sort((a, b) => rank(a) - rank(b) || (lib.ms(b.fromDate) || 0) - (lib.ms(a.fromDate) || 0))
}
// What the caller may do with the person: their access kinds, and whether they read or change the HR and private regions.
function personAccess(partyId, asOf) {
    const userScope = people.scopeOf()
    const admitted = people.partyAccess(userScope, partyId, asOf)
    const caps = userScope.capabilities
    const self = admitted.kinds.includes("self")
    const hr = admitted.kinds.includes("staff") && !!caps.hrView
    return {
        userScope,
        kinds: admitted.kinds,
        employments: admitted.employments,
        self,
        hr,
        hrEdit: hr && !!caps.hrEdit,
        // the employments HR reads (by the employers in scope), for the history and the employment host
        hrEmployments: hr
            ? admitted.employments.filter(row => userScope.organizationPartyIds.includes(row.organizationPartyId))
            : []
    }
}
// The private person data, for the person and an HR reader of an employer of theirs; identifications (not tax ones, values
// masked) for HR only. revision is what store#PersonalInfo checks.
function personalOf(partyId, hr) {
    const person = one("mantle.party.Person", {partyId}) || {}
    const contacts = contactsOf([partyId], privatePurposes, true)[partyId] || {}
    const info = {
        firstName: person.firstName || "",
        middleName: person.middleName || "",
        lastName: person.lastName || "",
        suffix: person.suffix || "",
        preferredName: person.nickname || "",
        birthDate: person.birthDate ? lib.calendarDateText(person.birthDate) : "",
        gender: person.gender || "",
        homePhone: contacts.homePhone || "",
        mobilePhone: contacts.mobilePhone || "",
        homeAddress: contacts.homeAddress || "",
        homeAddressFields: contacts.homeAddressFields || Object.fromEntries(addressFields.map(field => [field, null]))
    }
    info.revision = hash(info)
    if (hr) {
        const identifications = Array.from(
            find("mantle.party.PartyIdentification")
                .condition("partyId", partyId)
                .condition("partyIdTypeEnumId", "not-in", taxIdTypes)
                .list()
        )
        const types = enumNames(identifications.map(row => row.partyIdTypeEnumId))
        info.identifications = identifications.map(row => ({
            partyIdTypeEnumId: row.partyIdTypeEnumId,
            typeText: types[row.partyIdTypeEnumId] || row.partyIdTypeEnumId,
            valueText: row.idValue ? "•••• " + String(row.idValue).slice(-4) : "",
            issuedBy: row.issuedBy || "",
            expireDateText: row.expireDate ? lib.calendarDateText(row.expireDate) : ""
        }))
    }
    return info
}
// The person's record as the caller may read it (design §4 Employee360): the regions the caller's capabilities admit, each
// region they may not read absent from the answer, and the employment the record is opened on (one the scope shows; else the
// current one, then the newest).
function employee360(p) {
    const asOf = people.asOfMillis(p.asOfDate)
    const access = personAccess(p.partyId, asOf)
    const employments = sortEmployments(access.employments, asOf)
    if (p.partyRelationshipId && !employments.some(row => row.partyRelationshipId === p.partyRelationshipId))
        denied("RECORD_UNAVAILABLE", "Employment " + p.partyRelationshipId + " is not available")
    const selectedId = p.partyRelationshipId || employments[0]?.partyRelationshipId || null
    const person = one("mantle.party.Person", {partyId: p.partyId}) || {}
    const contacts = contactsOf([p.partyId], workPurposes)[p.partyId] || {}
    const managerIds = managersOf([p.partyId])[p.partyId] || []
    const managerNames = people.personNames(managerIds)
    const rows = employmentRows(employments, asOf, access.hr)
    // a directory or team reader sees the employment's work identity, not its id; the person and HR see the id the record
    // opens on
    const showIds = access.hr || access.self
    const overview = {
        personName: nameOf(person) || p.partyId,
        preferredName: person.nickname || "",
        employments: rows.map(row => {
            const out = Object.assign({}, row)
            if (!showIds) delete out.partyRelationshipId
            return out
        }),
        managers: managerIds.map(partyId => ({partyId, personName: managerNames[partyId] || partyId})),
        workEmail: contacts.workEmail || "",
        workPhone: contacts.workPhone || "",
        workAddress: contacts.workAddress || ""
    }
    const regions = ["overview"]
    const out = {partyId: p.partyId, access: access.kinds, overview}
    if (access.hr || access.self) {
        regions.push("employmentHistory", "personalInfo")
        out.personalInfo = personalOf(p.partyId, access.hr)
    }
    // the employment host's files and activity: an HR reader of its employer
    const hostId = access.hrEmployments.some(row => row.partyRelationshipId === selectedId) ? selectedId : null
    if (hostId) regions.push("filesAndActivity")
    out.regions = regions
    out.partyRelationshipId = showIds ? selectedId : null
    out.hostEmploymentId = hostId
    out.capabilities = {
        editPersonal: access.self || access.hrEdit,
        editHr: access.hrEdit,
        selfFields: access.self && !access.hrEdit ? selfFields : selfFields.concat(hrFields),
        files: !!hostId
    }
    return out
}

// ===== get#EmploymentHistory =====
// The person's employments, newest first (P6 adds their assignments): an HR reader's of the employers in scope, any dates; the
// person's own, all of them. Refused for anyone else (PERMISSION_DENIED), who reads the Overview only.
function employmentHistory(p) {
    const asOf = people.asOfMillis(null)
    const access = personAccess(p.partyId, asOf)
    if (!access.hr && !access.self) denied("PERMISSION_DENIED", "Employment history is not available")
    let query = find("mantle.party.PartyRelationship")
        .condition("relationshipTypeEnumId", "PrtEmployee")
        .condition("fromPartyId", p.partyId)
    if (!access.self) query = query.condition("toPartyId", "in", access.userScope.organizationPartyIds)
    const found = Array.from(query.orderBy("-fromDate").list()).map(row => ({
        partyRelationshipId: row.partyRelationshipId,
        organizationPartyId: row.toPartyId,
        fromDate: row.fromDate,
        thruDate: row.thruDate
    }))
    return {history: employmentRows(found, asOf, true)}
}

// ===== store#PersonalInfo =====
// A correction of the person's private data (design §4 PersonalInfo): the person themselves may change their preferred name
// and private phones; an HR editor of an employer of theirs these and their legal names, birth date, gender and home address.
// A field left out (null) is unchanged, an empty one is cleared (a legal name cannot be). Refused: a person outside the scope
// (RECORD_UNAVAILABLE), a caller who may change nothing of them (PERMISSION_DENIED), a field they may not change
// (FIELD_NOT_PERMITTED, naming it), and a revision other than the one read (REVISION_CHANGED). Contacts change by date: the
// one in effect ends and a new one starts (mantle.party.ContactServices store#PartyContactInfo).
function storePersonalInfo(p) {
    const access = personAccess(p.partyId, people.asOfMillis(null))
    if (!access.self && !access.hrEdit)
        denied("PERMISSION_DENIED", "Personal information of " + p.partyId + " may not be changed")
    const allowed = access.hrEdit ? selfFields.concat(hrFields) : selfFields
    const current = personalOf(p.partyId, false)
    if (String(p.expectedRevision || "") !== current.revision)
        denied(
            "REVISION_CHANGED",
            "This personal information changed since you read it; open it again (revision " + current.revision + ")"
        )
    const addressGiven = addressFields.some(field => given(p[field]))
    const asked = Object.fromEntries(
        selfFields.concat(hrFields).map(field => [field, field === "homeAddress" ? addressGiven : given(p[field])])
    )
    for (const field of selfFields.concat(hrFields)) {
        if (!asked[field] || allowed.includes(field)) continue
        // a value the caller may not change is refused unless it is what is there already
        const unchanged =
            field === "homeAddress"
                ? addressFields.every(
                      name => !given(p[name]) || String(p[name] || "") === String(current.homeAddressFields[name] || "")
                  )
                : field === "birthDate"
                  ? (blank(p.birthDate) ? "" : lib.calendarDateText(p.birthDate)) === current.birthDate
                  : String(p[field] || "").trim() === String(current[field] || "")
        if (!unchanged) denied("FIELD_NOT_PERMITTED", "You may not change " + field)
    }
    for (const field of ["firstName", "lastName"])
        if (asked[field] && allowed.includes(field) && blank(p[field])) denied("NAME_REQUIRED", "A " + field + " is required")

    const personChanges = {}
    const personFields = {
        firstName: "firstName",
        middleName: "middleName",
        lastName: "lastName",
        suffix: "suffix",
        preferredName: "nickname"
    }
    for (const [field, column] of Object.entries(personFields))
        if (asked[field] && allowed.includes(field)) personChanges[column] = blank(p[field]) ? null : String(p[field]).trim()
    if (asked.birthDate && allowed.includes("birthDate")) personChanges.birthDate = blank(p.birthDate) ? null : p.birthDate
    if (asked.gender && allowed.includes("gender")) personChanges.gender = blank(p.gender) ? null : p.gender
    if (Object.keys(personChanges).length) call("update#mantle.party.Person", Object.assign({partyId: p.partyId}, personChanges))

    const endPurpose = purposeId => {
        for (const row of Array.from(
            people
                .current(
                    find("mantle.party.contact.PartyContactMech").condition({
                        partyId: p.partyId,
                        contactMechPurposeId: purposeId
                    }),
                    null
                )
                .list()
        ))
            call("update#mantle.party.contact.PartyContactMech", {
                partyId: row.partyId,
                contactMechId: row.contactMechId,
                contactMechPurposeId: row.contactMechPurposeId,
                fromDate: row.fromDate,
                thruDate: ec.user.nowTimestamp
            })
    }
    for (const field of ["homePhone", "mobilePhone"]) {
        if (!asked[field] || !allowed.includes(field) || String(p[field] || "").trim() === current[field]) continue
        if (blank(p[field])) endPurpose(privatePurposes[field])
        else
            call("mantle.party.ContactServices.store#PartyContactInfo", {
                partyId: p.partyId,
                replaceByPurpose: true,
                telecomContactMechPurposeId: privatePurposes[field],
                contactNumber: String(p[field]).replace(/[()+]/g, "").trim()
            })
    }
    if (asked.homeAddress && allowed.includes("homeAddress")) {
        const address = Object.fromEntries(
            addressFields.map(field => [
                field,
                given(p[field]) ? String(p[field]).trim() || null : current.homeAddressFields[field] || null
            ])
        )
        const changed = addressFields.some(
            field => String(address[field] || "") !== String(current.homeAddressFields[field] || "")
        )
        if (changed) {
            if (!address.address1 && !address.city && !address.postalCode) endPurpose(privatePurposes.homeAddress)
            else
                call(
                    "mantle.party.ContactServices.store#PartyContactInfo",
                    Object.assign(
                        {partyId: p.partyId, replaceByPurpose: true, postalContactMechPurposeId: privatePurposes.homeAddress},
                        address
                    )
                )
        }
    }
    return {revision: personalOf(p.partyId, false).revision}
}

// ===== the employment host =====
// Whether the caller reads an employment's files and activity (an HR reader of its employer in scope) and may change them (with
// PEOPLE_HR_EDIT). Never refuses: an employment that is not one, or not the caller's to read, answers recordVisible false.
function employmentAccess(p) {
    const no = {recordVisible: false, canEdit: false, partyId: null, organizationPartyId: null}
    if (!ec.user.userId || !p.partyRelationshipId) return no
    const row = one("mantle.party.PartyRelationship", {partyRelationshipId: p.partyRelationshipId})
    if (!row || row.relationshipTypeEnumId !== "PrtEmployee") return no
    const userScope = people.scopeOf()
    const caps = userScope.capabilities
    if (!caps.hrView || !userScope.organizationPartyIds.includes(row.toPartyId)) return no
    return {recordVisible: true, canEdit: !!caps.hrEdit, partyId: row.fromPartyId, organizationPartyId: row.toPartyId}
}
// A file of an employment (EmploymentContent): an HR editor of its employer only.
function contentAccess(p) {
    const access = employmentAccess(p)
    if (!access.recordVisible) denied("RECORD_UNAVAILABLE", "Employment " + p.partyRelationshipId + " is not available")
    if (!access.canEdit) denied("PERMISSION_DENIED", "Adding an employment's files needs PEOPLE_HR_EDIT")
    return access
}

const operations = {findEmployees, employee360, employmentHistory, storePersonalInfo, employmentAccess, contentAccess}
function run(op, p) {
    if (!Object.hasOwn(operations, op)) throw new Error("Unknown employee operation " + op)
    return operations[op](p || {})
}
;({execute: run})
