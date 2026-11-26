// Mantle's map adapters (mantle.other.MapPlaceServices; mr-moqui plans/Maps.md §3.2, §6.1, §6.3, §8, docs/tools/Maps.md "Record
// adapters"): the place of a postal address, a party, a facility and an asset for the framework's local-map dialog, the save of a
// point a user chose for one, and the facilities and assets of a viewport for a record layer. The framework resolves an adapter
// by its key (moqui.maps.MapAdapter, data/10-seed/MapPlaces.xml) and calls these services as the user; nothing of the
// registration authorizes, so every call checks the caller here first, from permissions and organization scope, and reads and
// writes with authorization off after that check.
//
// Who reads and who writes:
// - A party's addresses: the party themselves and the owner of a personal contact read and write all of them. Anyone else reads
//   only with organizations of their own, and then a party within their reach (not disabled, not another user's personal
//   contact; as Mantle's party filter, one of their organizations or a party owned by _NA_ or by one of them; an internal
//   organization, a unit under one and their staff only under one of the caller's top-level organizations; every party for a
//   system administrator) and of it only its business addresses: an organization's, but its home
//   address, and a person's work address alone (readable party identity is not a readable home address). Writing those needs
//   PARTY_LOCATION_EDIT and a party of their organizations (one of them, owned by one, or its staff), or Sales' account
//   editor's (SALES_ACCOUNT_EDIT) for an account of their sales scope that is not shared and a current contact of one
//   (SalesAccess.js accountOf, contactAccounts), as they change those addresses in Sales. A person's home address is also
//   read, never written, by an HR reader People admits them to (PEOPLE_HR_VIEW and an employment by an employer of their People
//   scope, People.js partyAccess, as Employee360's private region). A party's own point (PartyGeoPoint) is an organization's
//   business place, and a person's private one.
// - A facility: in the caller's facility scope (FacilityScope.js) to read; FACILITY_EDIT there to write, as store#Facility.
// - An asset: in the stock scope (StockScope.js: its owner's or its facility's owner's organization) to read;
//   MAINTENANCE_RESOURCE_EDIT or FACILITY_EDIT there to write.
// - A transaction's address (an order's, a shipment's or an invoice's own contact mechanism, kept by the document when the
//   party's address changes): read only by a reader of the document by Mantle's rules of its kind (Sales' order scope,
//   Customer Service's, Commerce's store orders, a purchasing read, receivables or payables, fulfillment at its facility;
//   transactionDocument below), within the caller's organizations as the organization filter (MANTLE_USER_ORG) has them;
//   never written here (its location is the party's address's, which the answer links).
// - An outside user (EXTERNAL_USER, PROJECT_CLIENT) reads only its own and its personal contacts' places.
// A record that is not there and one the caller may not read are refused alike (RECORD_UNAVAILABLE).
//
// A record's place is its own confirmed point first; else, for an address with none, its postal code and country, from which
// the framework shows the code's local postal-area position, labeled approximate (get#PostalLocation): that position is never
// written to the address's geoPointId. An address's point chosen for a different address (Mantle's address update keeps the
// geoPointId on the new address) is stale and not shown. A save makes a new GeoPoint (GPT_RECORD_LOCATION, data source
// MANTLE_MAP_CHOICE) with its provenance (GeoPointProvenance: precision, user, date, the address's fingerprint) and points
// the record at it through the domain's own entity services, so a point another record shares is never changed. A
// postal-area or place estimate is never saved as an address's point, nor over a facility's or asset's recorded point.
// recordVersion names the record and the point it shows (and an address's fingerprint): a save of an older version is
// refused (STALE_VERSION), checked again with the record's row locked before the write. A refusal is answered by its code;
// any other failure is logged and fails the call with no text of its own.
const lib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const facilityScope = ec.resource.script("component://mr-mantle/service/mantle/facility/FacilityScope.js")
const stockScope = ec.resource.script("component://mr-mantle/service/mantle/product/StockScope.js")
// read only when a rule needs them: Sales' account scope and People's
const salesAccess = () => ec.resource.script("component://mr-mantle/service/mantle/sales/SalesAccess.js")
const peopleAccess = () => ec.resource.script("component://mr-mantle/service/mantle/humanres/People.js")
const {find, one, call, denied, hash, dateText, partyNames} = lib
const access = lib.access

const PROVENANCE = "mantle.party.contact.GeoPointProvenance"
const GEO_POINT = "moqui.basic.GeoPoint"
const DATA_SOURCE = "MANTLE_MAP_CHOICE"
const PRIVATE_PURPOSES = ["PostalHome"]
// a person's address another user reads: the public work identity's (as People's Employees.js workPurposes)
const PERSON_BUSINESS_PURPOSES = ["PostalWork"]
// the address a party's map opens on when no purpose is asked for, before its other addresses
const DEFAULT_PURPOSES = ["PostalPrimary", "PostalGeneral", "PostalWork", "PostalBilling", "PostalShippingDest"]
const ADDRESS_FIELDS = ["address1", "address2", "unitNumber", "city", "stateProvinceGeoId", "countryGeoId", "postalCode"]
const ESTIMATES = ["GPP_POSTAL_AREA", "GPP_PLACE_ESTIMATE"]
// the refusals store#RecordLocation answers; any other failure is logged and fails the call
const REFUSALS = [
    "RECORD_UNAVAILABLE",
    "PERMISSION_DENIED",
    "STALE_VERSION",
    "POINT_INVALID",
    "PRECISION_INVALID",
    "PRECISION_REFUSED",
    "POINT_RECORDED"
]
const LEFT_ASSET_STATUSES = ["AstDelivered", "AstDeactivated"]
const STAFF_RELATIONSHIPS = ["PrtAgent", "PrtEmployee", "PrtMember"]
// the most features one viewport answers whatever limit is passed (the framework bounds it by maps@max-features first)
const FEATURE_CAP = 2000
// pages of ownerless facilities a viewport scans for those in scope, and the depth of a facility tree
const OWNERLESS_PAGES = 4
const FACILITY_DEPTH = 12
// route keys the application showing the map resolves (never a path)
const ROUTES = {party: "partyDetail", facility: "facilityDetail", asset: "assetDetail"}
// a point recorded before these adapters, with no provenance row: its precision is not known (one wording, every answer)
const LEGACY_PRECISION = "precision unknown — recorded before provenance"
// the address a transaction's map opens on when no purpose is asked for, before its other addresses
const TRANSACTION_PURPOSES = {
    order: ["PostalShippingDest", "PostalBilling"],
    shipment: ["PostalShippingDest", "PostalShippingOrigin"],
    invoice: ["PostalBilling", "PostalPayment"]
}

const blank = value => value == null || String(value).trim() === ""
const text = value => (blank(value) ? null : String(value).trim())
const L = message => ec.l10n.localize(message)
const unavailable = () => denied("RECORD_UNAVAILABLE", L("This record's place is not available"))
const now = () => ec.user.nowTimestamp
const current = query => query.conditionDate("fromDate", "thruDate", now())
// the contact mechanism purposes of a postal address (PostalPrimary, PostalHome, ...)
const postalPurposes = () =>
    Array.from(
        ec.entity
            .find("mantle.party.contact.ContactMechPurpose")
            .condition("contactMechTypeEnumId", "CmtPostalAddress")
            .selectField("contactMechPurposeId")
            .useCache(true)
            .disableAuthz()
            .list()
    ).map(row => row.contactMechPurposeId)

// ===== the caller =====
// Made for one call: who the caller is, and their organizations, each read once when first asked.
function caller() {
    const userId = ec.user.userId || null
    const systemAdmin = access.systemAdmin()
    const who = {
        userId,
        partyId: ec.user.userAccount?.partyId || null,
        systemAdmin,
        // an outside user (the framework's EXTERNAL_USER, a project client) reaches no organization's records
        external: !!userId && !systemAdmin && (ec.user.hasPermission("PROJECT_CLIENT") || ec.user.hasPermission("EXTERNAL_USER")),
        roots: new Map()
    }
    let facility
    // the facility and stock scope (FacilityScope.js): organizationPartyIds null for every organization
    who.facilityScope = () =>
        facility || (facility = userId && !who.external ? facilityScope.scope() : {organizationPartyIds: []})
    // the organizations whose parties the caller reaches: their own (the active one when it is theirs); null for every one
    who.organizations = () => (systemAdmin ? null : Array.from(who.facilityScope().ownPartyIds || []))
    let organizationRoots
    // the top-level organizations of theirs
    who.organizationRoots = () =>
        organizationRoots || (organizationRoots = new Set((who.organizations() || []).map(partyId => rootOf(partyId, who.roots))))
    let sales
    // Sales' scope (SalesAccess.js), for an account editor's write
    who.salesScope = () => sales || (sales = salesAccess().scope())
    let people
    // People's scope (People.js), for an HR reader's read of a home address
    who.peopleScope = () => people || (people = peopleAccess().scopeOf())
    // the parties whose home address People admits the caller to as an HR reader, as they are asked
    who.hrReads = new Map()
    return who
}

// ===== parties =====
const internalParty = partyId => !!partyId && !!one("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
// An organization's top-level organization: up its current PrtOrgRollup parents (child to parent), at most ten levels, as
// PartyReach.js reads it; memo is the call's.
function rootOf(orgId, memo) {
    if (memo.has(orgId)) return memo.get(orgId)
    let at = orgId
    const seen = new Set([at])
    for (let depth = 0; depth < 10; depth++) {
        const parent = Array.from(
            current(find("mantle.party.PartyRelationship", {fromPartyId: at, relationshipTypeEnumId: "PrtOrgRollup"}))
                .selectField("toPartyId")
                .limit(1)
                .list()
        )[0]?.toPartyId
        if (!parent || seen.has(parent)) break
        seen.add(parent)
        at = parent
    }
    memo.set(orgId, at)
    return at
}
// The organizations a party works for now (agent, employee or member).
function employersOf(partyId) {
    return Array.from(
        current(find("mantle.party.PartyRelationship", {fromPartyId: partyId}))
            .condition("relationshipTypeEnumId", "in", STAFF_RELATIONSHIPS)
            .selectField("toPartyId")
            .list()
    ).map(row => row.toPartyId)
}
// Whether Sales' account editor may locate a party's addresses (SALES_ACCOUNT_EDIT in their sales scope, as they change them in
// Sales, SalesAccess.js): an account of the scope that is not shared, or a person who is a current contact of one.
function salesAccountEditor(who, partyId) {
    if (!access.has("SALES_ACCOUNT_EDIT")) return false
    const userScope = who.salesScope()
    if (!userScope.capabilities.accountEdit) return false
    const sales = salesAccess()
    const account = sales.accountOf(userScope, partyId)
    if (account) return !account.shared
    return sales.contactAccounts(userScope, partyId).some(found => !found.shared)
}
// Whether People admits the caller to a person's private contacts as an HR reader: PEOPLE_HR_VIEW and an employment of theirs
// by an employer of the caller's People scope (People.js partyAccess staff, as Employee360's private region). A failure is
// logged and admits nobody.
function hrReader(who, partyId) {
    if (!partyId || !access.has("PEOPLE_HR_VIEW")) return false
    if (who.hrReads.has(partyId)) return who.hrReads.get(partyId)
    let admitted = false
    try {
        const userScope = who.peopleScope()
        admitted =
            !!userScope.capabilities.hrView &&
            peopleAccess().checkedAccess(userScope, partyId, null, true).kinds.includes("staff")
    } catch (error) {
        ec.logger.error("People's HR access to " + partyId + " was not read for a map: " + (error?.message ?? error))
    }
    who.hrReads.set(partyId, admitted)
    return admitted
}
// What the caller may do with a party: {read, write, self, owner, person}; write is the PARTY_LOCATION_EDIT scope (or Sales'
// account editor's), which a purpose narrows (purposeAccess). Beyond the party themselves and a personal contact's owner, a
// caller reaches only with organizations of their own, as Mantle's party filter (MANTLE_USER_ORG): one of their organizations, a party owned by _NA_
// or by one of them; the staff of an internal organization (or of a unit under an internal top-level one, a department)
// and such an organization itself only under one of the caller's top-level organizations, and write only within theirs. An
// internal organization's own places, and a unit's under one, are its configuration's (SEC-BOS-89, as BOSS's contact record):
// written only with ADMIN_SETTINGS_MANAGE too, by a caller who works in it (or in the unit's top-level organization). A shared
// party (owned by _NA_) is read, never written.
function partyAccess(who, party) {
    const none = {read: false, write: false}
    if (!party || !who.userId) return none
    const person = party.partyTypeEnumId === "PtyPerson"
    if (who.partyId && party.partyId === who.partyId) return {read: true, write: true, self: true, person}
    if (party.privateOwnerUserId)
        return party.privateOwnerUserId === who.userId ? {read: true, write: true, owner: true, person} : none
    if (party.disabled === "Y" || who.external) return none
    const organizations = who.organizations()
    const editor = access.has("PARTY_LOCATION_EDIT")
    if (organizations == null) return {read: true, write: editor, person}
    if (!organizations.length) return none
    const reach = (read, write) => ({read, write: read && write && editor, person})
    const tenantOf = orgId => {
        const root = rootOf(orgId, who.roots)
        return internalParty(orgId) || internalParty(root) ? root : null
    }
    // an internal organization or a unit under one: its settings manager's to write
    const settings = () => access.has("ADMIN_SETTINGS_MANAGE")
    if (organizations.includes(party.partyId))
        return reach(true, !tenantOf(party.partyId) || settings())
    // staff of internal organizations (their units included)
    const staffOf = employersOf(party.partyId).filter(orgId => tenantOf(orgId))
    if (staffOf.length)
        return reach(
            staffOf.some(orgId => organizations.includes(orgId) || who.organizationRoots().has(tenantOf(orgId))),
            staffOf.some(orgId => organizations.includes(orgId))
        )
    // an internal organization, or a unit under one: its tenant's
    const tenant = tenantOf(party.partyId)
    if (tenant) return reach(who.organizationRoots().has(tenant), organizations.includes(tenant) && settings())
    const owner = party.ownerPartyId
    const ours = organizations.includes(owner)
    // a party of theirs: PARTY_LOCATION_EDIT, or Sales' account editor for an account of their sales scope or its contact
    return {
        read: owner === "_NA_" || ours,
        write: ours && (editor || salesAccountEditor(who, party.partyId)),
        person
    }
}
// What the access reaches of a party's address of a purpose: {read, write}. The party themselves and its personal contact's
// owner reach all of them; anyone else who reads the party, its business addresses (no home address; a person's work address
// alone) with the party's write. A person's home address is read, never written, by an HR reader People admits them to
// (hrReader), when hr is not false (a map opened on that purpose, not a party's fallback).
const NO_ACCESS = {read: false, write: false}
function purposeAccess(who, found, partyId, purposeId, hr = true) {
    if (found.self || found.owner) return {read: true, write: !!found.write}
    if (!found.read) return NO_ACCESS
    if (PRIVATE_PURPOSES.includes(purposeId))
        return found.person && hr && hrReader(who, partyId) ? {read: true, write: false} : NO_ACCESS
    if (found.person && !PERSON_BUSINESS_PURPOSES.includes(purposeId)) return NO_ACCESS
    return {read: true, write: !!found.write}
}
function partyLabel(partyId) {
    return partyNames([partyId])[partyId] || partyId
}

// ===== facilities and assets =====
function facilityRead(who, facility) {
    return !!facility && !!who.userId && !who.external && facilityScope.ownsFacility(who.facilityScope(), facility)
}
function facilityWrite(who, facility) {
    return facilityRead(who, facility) && access.has("FACILITY_EDIT")
}
function assetRead(who, asset) {
    return (
        !!asset &&
        !!who.userId &&
        !who.external &&
        stockScope.assetAllowed({organizationIds: who.facilityScope().organizationPartyIds}, asset)
    )
}
function assetWrite(who, asset) {
    return assetRead(who, asset) && (access.has("MAINTENANCE_RESOURCE_EDIT") || access.has("FACILITY_EDIT"))
}
function facilityLabel(facility) {
    return text(facility.facilityName) || facility.facilityId
}
function assetLabel(asset) {
    return text(asset.assetName) || asset.assetId
}

// ===== points and addresses =====
function addressFingerprint(address) {
    return hash(ADDRESS_FIELDS.map(field => text(address[field])))
}
function addressText(address) {
    return [
        address.address1,
        address.address2,
        [address.postalCode, address.city].filter(Boolean).join(" "),
        address.countryGeoId
    ]
        .map(text)
        .filter(Boolean)
        .join(", ")
}
const validPoint = point =>
    !!point &&
    Number.isFinite(Number(point.latitude)) &&
    Number.isFinite(Number(point.longitude)) &&
    Math.abs(Number(point.latitude)) <= 90 &&
    Math.abs(Number(point.longitude)) <= 180
// A recorded point as a place: {geometry, precisionEnumId, sourceText, legacy}, or null; with fingerprint (an address's point)
// null when its provenance names another address. A point with no provenance (recorded before these adapters) is shown as
// recorded, its precision unknown (LEGACY_PRECISION); no provenance is made up for it.
function pointPlace(geoPointId, fingerprint) {
    const point = geoPointId ? one(GEO_POINT, {geoPointId}) : null
    if (!validPoint(point)) return null
    const provenance = one(PROVENANCE, {geoPointId})
    if (fingerprint && provenance?.addressFingerprint && provenance.addressFingerprint !== fingerprint) return null
    const confirmed = provenance?.confirmedDate ? dateText(provenance.confirmedDate) : ""
    return {
        geometry: {type: "Point", coordinates: [Number(point.longitude), Number(point.latitude)]},
        precisionEnumId: provenance?.precisionEnumId || null,
        sourceText: provenance
            ? (provenance.precisionEnumId === "GPP_USER_CONFIRMED" ? L("Chosen on a map") : L("Recorded location")) +
              (confirmed ? " " + confirmed : "")
            : legacySource(),
        legacy: !provenance
    }
}
const legacySource = () => L("Recorded location") + "; " + L(LEGACY_PRECISION)
// An address's place: its own point when it is still this address's, else its postal code and country for the framework's
// approximate postal-area position (never written to the address).
function addressPlace(address) {
    const own = pointPlace(address.geoPointId, addressFingerprint(address))
    if (own) return own
    return {postalCode: text(address.postalCode), countryGeoId: text(address.countryGeoId)}
}
function addressVersion(address) {
    return "address:" + address.contactMechId + ":" + addressFingerprint(address).slice(0, 16) + ":" + (address.geoPointId || "-")
}
// The current postal address links of a contact mechanism, optionally of one purpose.
function partyLinks(contactMechId, purposeId) {
    let query = current(find("mantle.party.contact.PartyContactMech", {contactMechId}))
    if (purposeId) query = query.condition("contactMechPurposeId", purposeId)
    return Array.from(query.list())
}
function facilityLinks(contactMechId, purposeId) {
    let query = current(find("mantle.facility.FacilityContactMech", {contactMechId}))
    if (purposeId) query = query.condition("contactMechPurposeId", purposeId)
    return Array.from(query.list())
}
// What the caller may do with an address: read through any party or facility it is current for (of the purpose, when given);
// write only when every party and facility it is current for, of any purpose, grants the write, so an address row shared with a
// record the caller may not locate (an internal organization's, another party's) is not located through the one they may.
function addressAccess(who, contactMechId, purposeId) {
    let read = false
    for (const link of partyLinks(contactMechId, purposeId)) {
        const found = partyAccess(who, one("mantle.party.Party", {partyId: link.partyId}))
        if (purposeAccess(who, found, link.partyId, link.contactMechPurposeId).read) {
            read = true
            break
        }
    }
    if (!read)
        for (const link of facilityLinks(contactMechId, purposeId))
            if (facilityRead(who, one("mantle.facility.Facility", {facilityId: link.facilityId}))) {
                read = true
                break
            }
    if (!read) return {read, write: false}
    const partyRows = partyLinks(contactMechId, null)
    const facilityRows = facilityLinks(contactMechId, null)
    const write =
        partyRows.length + facilityRows.length > 0 &&
        partyRows.every(link => {
            const found = partyAccess(who, one("mantle.party.Party", {partyId: link.partyId}))
            return purposeAccess(who, found, link.partyId, link.contactMechPurposeId).write
        }) &&
        facilityRows.every(link => facilityWrite(who, one("mantle.facility.Facility", {facilityId: link.facilityId})))
    return {read, write}
}
// The current postal address of a facility: of the purpose, else its primary one, else its latest.
function facilityAddress(facilityId, purposeId) {
    const links = Array.from(
        current(find("mantle.facility.FacilityContactMech", {facilityId}))
            .condition("contactMechPurposeId", "in", postalPurposes())
            .orderBy("-fromDate")
            .list()
    )
    const pick = purposeId
        ? links.find(link => link.contactMechPurposeId === purposeId)
        : links.find(link => link.contactMechPurposeId === "PostalPrimary") || links[0]
    return pick ? one("mantle.party.contact.PostalAddress", {contactMechId: pick.contactMechId}) : null
}

// ===== the targets: a record's place, what the caller may do and where a save goes =====
// Each answers {label, place, version, write, address (an address target), ownPoint, apply(geoPointId), links} or refuses
// with RECORD_UNAVAILABLE.
function addressTarget(who, contactMechId, purposeId) {
    const address = blank(contactMechId) ? null : one("mantle.party.contact.PostalAddress", {contactMechId})
    if (!address) unavailable()
    const found = addressAccess(who, address.contactMechId, text(purposeId))
    if (!found.read) unavailable()
    return {
        label: addressText(address) || address.contactMechId,
        place: addressPlace(address),
        version: addressVersion(address),
        write: found.write,
        address,
        // the address row locked and still the one read
        lock: () =>
            addressVersion(
                find("mantle.party.contact.PostalAddress", {contactMechId: address.contactMechId}).forUpdate(true).one()
            ) === addressVersion(address),
        apply: geoPointId =>
            call("update#mantle.party.contact.PostalAddress", {contactMechId: address.contactMechId, geoPointId}),
        links: []
    }
}
function partyPoint(partyId) {
    return current(find("mantle.party.PartyGeoPoint", {partyId})).orderBy("-fromDate").list()[0] || null
}
function partyTarget(who, partyId, purposeId) {
    const party = blank(partyId) ? null : one("mantle.party.Party", {partyId})
    const found = partyAccess(who, party)
    if (!found.read) unavailable()
    const label = partyLabel(party.partyId)
    const links = [{label, route: ROUTES.party, parameters: {partyId: party.partyId}}]
    const addresses = Array.from(
        current(find("mantle.party.contact.PartyContactMech", {partyId: party.partyId}))
            .condition("contactMechPurposeId", "in", postalPurposes())
            .orderBy("-fromDate")
            .list()
    ).filter(link => purposeAccess(who, found, party.partyId, link.contactMechPurposeId, !!purposeId).read)
    const addressOf = link => {
        const address = one("mantle.party.contact.PostalAddress", {contactMechId: link.contactMechId})
        if (!address) return null
        return Object.assign(addressTarget(who, address.contactMechId, link.contactMechPurposeId), {label, links})
    }
    if (purposeId) {
        // a purpose the caller may not read is as one the party does not have
        if (!purposeAccess(who, found, party.partyId, purposeId).read) unavailable()
        const link = addresses.find(row => row.contactMechPurposeId === purposeId)
        const target = link ? addressOf(link) : null
        return target || {label, place: null, version: "party:" + party.partyId + ":" + purposeId + ":none", write: false, links}
    }
    // a party's own point: an organization's business place, a person's private one
    const pointAllowed = found.self || found.owner || !found.person
    const point = pointAllowed ? partyPoint(party.partyId) : null
    if (!point) {
        const ordered = DEFAULT_PURPOSES.map(purpose => addresses.find(row => row.contactMechPurposeId === purpose))
            .concat(addresses)
            .filter(Boolean)
        for (const link of ordered) {
            const target = addressOf(link)
            if (target) return target
        }
    }
    return {
        label,
        place: point ? pointPlace(point.geoPointId) : null,
        version: "party:" + party.partyId + ":" + (point?.geoPointId || "-"),
        write: pointAllowed && found.write,
        ownPoint: !!point,
        lock: () => {
            find("mantle.party.Party", {partyId: party.partyId}).forUpdate(true).one()
            return (partyPoint(party.partyId)?.geoPointId || null) === (point?.geoPointId || null)
        },
        apply: geoPointId => {
            for (const row of current(find("mantle.party.PartyGeoPoint", {partyId: party.partyId})).list())
                call("update#mantle.party.PartyGeoPoint", {
                    partyId: row.partyId,
                    geoPointId: row.geoPointId,
                    fromDate: row.fromDate,
                    thruDate: now()
                })
            call("create#mantle.party.PartyGeoPoint", {partyId: party.partyId, geoPointId, fromDate: now()})
        },
        links
    }
}
function facilityTarget(who, facilityId, purposeId) {
    const facility = blank(facilityId) ? null : one("mantle.facility.Facility", {facilityId})
    if (!facilityRead(who, facility)) unavailable()
    const own = pointPlace(facility.geoPointId)
    let place = own
    if (!place) {
        const address = facilityAddress(facility.facilityId, text(purposeId))
        place = address ? addressPlace(address) : null
    }
    return {
        label: facilityLabel(facility),
        place,
        version: "facility:" + facility.facilityId + ":" + (facility.geoPointId || "-"),
        write: facilityWrite(who, facility),
        ownPoint: !!own,
        lock: () =>
            (find("mantle.facility.Facility", {facilityId: facility.facilityId}).forUpdate(true).one()?.geoPointId || null) ===
            (facility.geoPointId || null),
        apply: geoPointId => call("update#mantle.facility.Facility", {facilityId: facility.facilityId, geoPointId}),
        links: [{label: facilityLabel(facility), route: ROUTES.facility, parameters: {facilityId: facility.facilityId}}]
    }
}
function assetTarget(who, assetId) {
    const asset = blank(assetId) ? null : one("mantle.product.asset.Asset", {assetId})
    if (!assetRead(who, asset)) unavailable()
    const own = pointPlace(asset.geoPointId)
    let place = own
    // with no point of its own, where its facility is: the facility's point, else its address's
    if (!place && asset.facilityId) {
        const found = one("mantle.facility.Facility", {facilityId: asset.facilityId})
        // only a facility the caller may read themselves
        const facility = facilityRead(who, found) ? found : null
        const facilityPoint = facility ? pointPlace(facility.geoPointId) : null
        if (facilityPoint)
            place = Object.assign(facilityPoint, {
                sourceText:
                    L("Where its facility is") +
                    ": " +
                    facilityLabel(facility) +
                    (facilityPoint.legacy ? "; " + L(LEGACY_PRECISION) : "")
            })
        else {
            const address = facility ? facilityAddress(facility.facilityId, null) : null
            place = address ? addressPlace(address) : null
        }
    }
    const links = [{label: assetLabel(asset), route: ROUTES.asset, parameters: {assetId: asset.assetId}}]
    if (asset.facilityId) links.push({label: L("Facility"), route: ROUTES.facility, parameters: {facilityId: asset.facilityId}})
    return {
        label: assetLabel(asset),
        place,
        version: "asset:" + asset.assetId + ":" + (asset.geoPointId || "-"),
        write: assetWrite(who, asset),
        ownPoint: !!own,
        lock: () =>
            (find("mantle.product.asset.Asset", {assetId: asset.assetId}).forUpdate(true).one()?.geoPointId || null) ===
            (asset.geoPointId || null),
        apply: geoPointId => call("update#mantle.product.asset.Asset", {assetId: asset.assetId, geoPointId}),
        links
    }
}
// ===== transaction addresses =====
// Who reads a transaction's document, beyond its organization scope, by Mantle's own rules of each kind; reading the document is
// what reads its address (a consumer's ship-to is their home), so a member of the organization who reads none of them reads
// nothing here.
// - A sales part (an internal vendor, an outside customer): Sales' order scope (SalesAccess.js orderOf: an order assigned to the
//   caller or a team of theirs, the organization's every one for SALES_TEAM_VIEW, an approver's or a change operator's own
//   reach); Customer Service's (SUPPORT_CASE_EDIT or ORDER_APPROVE in the selling organization, as OrderConfirmations.js);
//   Commerce's (COMMERCE_ORDER_VIEW for an order of the caller's stores, StoreOperations.js storeOrder); receivables
//   (RECEIVABLE_VIEW or ACCOUNTING_ADMIN in the vendor, AccountingPolicy.js access).
// - A purchase part (an internal customer, an outside vendor): a purchasing read (PurchasePolicy.js readPermissions) in the
//   buying organization; payables (PAYABLE_VIEW or ACCOUNTING_ADMIN in the customer).
// - Fulfillment, either kind: a picking, packing, shipping or stock permission (FULFILLMENT_READ) with the part's facility in the
//   caller's facility scope.
// - A shipment: fulfillment at a route segment's origin or destination facility; Customer Service's in its from or to party;
//   or a reader of an order it ships (its ShipmentItemSource orders, at most TRANSACTION_ORDERS of them).
// - An invoice: receivables in its from party, payables in its to party (or ACCOUNTING_ADMIN in either); a purchasing read with
//   INVOICE_MATCH in its to party (a bill); Customer Service's in its from party.
const PURCHASE_READ = [
    "PURCHASE_POLICY_EDIT",
    "PURCHASE_ORDER_EDIT",
    "PURCHASE_APPROVE",
    "PURCHASE_ORDER_APPROVE",
    "SUPPLIER_PROFILE_EDIT"
]
const SERVICE_READ = ["SUPPORT_CASE_EDIT", "ORDER_APPROVE"]
const FULFILLMENT_READ = ["SHIPMENT_PICK", "SHIPMENT_PACK", "SHIPMENT_SHIP", "SHIPMENT_LOAD_EDIT", "STOCK_ISSUE", "STOCK_RECEIVE"]
const SALES_READ = ["SALES_VIEW", "SALES_TEAM_VIEW", "SALES_REPORT_VIEW"]
const TRANSACTION_ORDERS = 5
const anyOf = permissions => permissions.some(permission => access.has(permission))
// The organizations of the caller's receivables and payables reads (AccountingPolicy.js), read once a call: {ar, ap} each a list
// (null: every one), empty without the read.
function accountingReads(who) {
    if (who.accounting) return who.accounting
    let found = {ar: [], ap: []}
    if (who.userId && !who.external && anyOf(["RECEIVABLE_VIEW", "PAYABLE_VIEW", "ACCOUNTING_ADMIN"])) {
        try {
            const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
            const reads = policy.access("read")
            const ids = who.systemAdmin ? null : Array.from(reads.allowedOrganizationPartyIds || [])
            const c = reads.capabilities
            found = {ar: c.arRead || c.admin ? ids : [], ap: c.apRead || c.admin ? ids : []}
        } catch (error) {
            if (lib.reasonCode(error) == null)
                ec.logger.error("Accounting reads were not read for a map: " + (error?.message ?? error))
        }
    }
    return (who.accounting = found)
}
const inList = (list, partyId) => !!partyId && (list == null || list.includes(partyId))
// Whether the caller's organizations hold a party (every one for a system administrator).
const ourParty = (who, partyId) => {
    const organizations = who.organizations()
    return !!partyId && (organizations == null || organizations.includes(partyId))
}
function fulfillsAt(who, facilityId) {
    if (!facilityId || !anyOf(FULFILLMENT_READ)) return false
    return facilityRead(who, one("mantle.facility.Facility", {facilityId}))
}
// Whether the caller reads an order (its parts in scope given) by one of the rules above.
function orderReader(who, order, parts) {
    for (const part of parts) {
        const sale = internalParty(part.vendorPartyId) && !internalParty(part.customerPartyId)
        const purchase = internalParty(part.customerPartyId) && !internalParty(part.vendorPartyId)
        if (sale) {
            if (anyOf(SALES_READ) && salesAccess().orderOf(who.salesScope(), order.orderId)) return true
            if (anyOf(SERVICE_READ) && ourParty(who, part.vendorPartyId)) return true
            if (inList(accountingReads(who).ar, part.vendorPartyId)) return true
            if (order.productStoreId && access.has("COMMERCE_ORDER_VIEW")) {
                try {
                    const operations = ec.resource.script("component://mr-mantle/service/mantle/order/StoreOperations.js")
                    if (operations.storeOrder(operations.scope("orders"), order.orderId, false)) return true
                } catch (error) {
                    if (lib.reasonCode(error) == null)
                        ec.logger.error("Commerce's order scope was not read for a map: " + (error?.message ?? error))
                }
            }
        }
        if (purchase) {
            if (anyOf(PURCHASE_READ) && ourParty(who, part.customerPartyId)) return true
            if (inList(accountingReads(who).ap, part.customerPartyId)) return true
        }
        if (fulfillsAt(who, part.facilityId)) return true
    }
    return false
}
// The parts of an order in the caller's organizations (one, with orderPartSeqId).
function orderParts(who, orderId, orderPartSeqId) {
    const organizations = who.organizations()
    let query = find("mantle.order.OrderPart", {orderId}).orderBy("orderPartSeqId")
    if (!blank(orderPartSeqId)) query = query.condition("orderPartSeqId", text(orderPartSeqId))
    return Array.from(query.list()).filter(
        part =>
            organizations == null || [part.vendorPartyId, part.customerPartyId].some(partyId => organizations.includes(partyId))
    )
}
function shipmentReader(who, shipment, segments) {
    if (segments.some(segment => fulfillsAt(who, segment.originFacilityId) || fulfillsAt(who, segment.destinationFacilityId)))
        return true
    if (
        anyOf(SERVICE_READ) &&
        [shipment.fromPartyId, shipment.toPartyId].some(partyId => internalParty(partyId) && ourParty(who, partyId))
    )
        return true
    const orderIds = Array.from(
        new Set(
            Array.from(
                find("mantle.shipment.ShipmentItemSource", {shipmentId: shipment.shipmentId})
                    .condition("orderId", "is-not-null", null)
                    .selectField("orderId")
                    .limit(50)
                    .list()
            ).map(row => row.orderId)
        )
    ).slice(0, TRANSACTION_ORDERS)
    for (const orderId of orderIds) {
        const order = one("mantle.order.OrderHeader", {orderId})
        const parts = order ? orderParts(who, orderId, null) : []
        if (parts.length && orderReader(who, order, parts)) return true
    }
    return false
}
function invoiceReader(who, invoice) {
    const reads = accountingReads(who)
    if (inList(reads.ar, invoice.fromPartyId) || inList(reads.ap, invoice.toPartyId)) return true
    if (anyOf(PURCHASE_READ) && access.has("INVOICE_MATCH") && ourParty(who, invoice.toPartyId)) return true
    return anyOf(SERVICE_READ) && internalParty(invoice.fromPartyId) && ourParty(who, invoice.fromPartyId)
}
// The document of a transaction address key the caller reads: {kind, id, parties, addresses: [{purposeId, contactMechId}]}, or a
// refusal (RECORD_UNAVAILABLE) for a document that is not there, one of no organization of theirs, one they read by none of the
// rules above, an outside user and a user of no organization. An order's are the parts of it in scope (orderPartSeqId narrows to
// one): each part's ship-to (postalContactMechId, as PostalShippingDest) and its postal OrderPartContactMech rows; a shipment's
// its postal ShipmentContactMech rows, then its route segments' origin and destination; an invoice's its postal
// InvoiceContactMech rows.
function transactionDocument(who, key) {
    const given = ["orderId", "shipmentId", "invoiceId"].filter(field => !blank(key[field]))
    if (given.length !== 1 || !who.userId || who.external) unavailable()
    const organizations = who.organizations()
    if (organizations != null && !organizations.length) unavailable()
    const ours = partyIds => organizations == null || partyIds.some(partyId => !!partyId && organizations.includes(partyId))
    const postal = new Set(postalPurposes())
    const addresses = []
    const add = (purposeId, contactMechId) => {
        if (contactMechId && !addresses.some(row => row.purposeId === purposeId && row.contactMechId === contactMechId))
            addresses.push({purposeId, contactMechId})
    }
    if (given[0] === "orderId") {
        const orderId = text(key.orderId)
        const order = one("mantle.order.OrderHeader", {orderId})
        const parts = order ? orderParts(who, orderId, key.orderPartSeqId) : []
        if (!parts.length || !orderReader(who, order, parts)) unavailable()
        for (const part of parts) {
            add("PostalShippingDest", part.postalContactMechId)
            for (const row of find("mantle.order.OrderPartContactMech", {orderId, orderPartSeqId: part.orderPartSeqId})
                .orderBy("contactMechPurposeId")
                .list())
                if (postal.has(row.contactMechPurposeId)) add(row.contactMechPurposeId, row.contactMechId)
        }
        const parties = parts.flatMap(part => [part.customerPartyId, part.vendorPartyId])
        return {kind: "order", id: orderId, label: L("Order") + " " + orderId, parties, addresses}
    }
    if (given[0] === "shipmentId") {
        const shipment = one("mantle.shipment.Shipment", {shipmentId: text(key.shipmentId)})
        if (!shipment || !ours([shipment.fromPartyId, shipment.toPartyId])) unavailable()
        const segments = Array.from(
            find("mantle.shipment.ShipmentRouteSegment", {shipmentId: shipment.shipmentId})
                .orderBy("shipmentRouteSegmentSeqId")
                .list()
        )
        if (!shipmentReader(who, shipment, segments)) unavailable()
        for (const row of find("mantle.shipment.ShipmentContactMech", {shipmentId: shipment.shipmentId})
            .orderBy("contactMechPurposeId")
            .list())
            if (postal.has(row.contactMechPurposeId)) add(row.contactMechPurposeId, row.contactMechId)
        for (const segment of segments) {
            if (!addresses.some(row => row.purposeId === "PostalShippingDest"))
                add("PostalShippingDest", segment.destPostalContactMechId)
            if (!addresses.some(row => row.purposeId === "PostalShippingOrigin"))
                add("PostalShippingOrigin", segment.originPostalContactMechId)
        }
        return {
            kind: "shipment",
            id: shipment.shipmentId,
            label: L("Shipment") + " " + shipment.shipmentId,
            parties: [shipment.toPartyId, shipment.fromPartyId],
            addresses
        }
    }
    const invoice = one("mantle.account.invoice.Invoice", {invoiceId: text(key.invoiceId)})
    if (!invoice || !ours([invoice.fromPartyId, invoice.toPartyId]) || !invoiceReader(who, invoice)) unavailable()
    for (const row of find("mantle.account.invoice.InvoiceContactMech", {invoiceId: invoice.invoiceId})
        .orderBy("contactMechPurposeId")
        .list())
        if (postal.has(row.contactMechPurposeId)) add(row.contactMechPurposeId, row.contactMechId)
    return {
        kind: "invoice",
        id: invoice.invoiceId,
        label: L("Invoice") + " " + invoice.invoiceId,
        parties: [invoice.toPartyId, invoice.fromPartyId],
        addresses
    }
}
// The party of a transaction whose address a contact mechanism is (or was: an address since changed is ended there), when the
// caller reads that party: the link to where its location is chosen.
function addressParty(who, parties, contactMechId) {
    const partyIds = Array.from(new Set(parties.filter(Boolean)))
    if (!partyIds.length) return null
    const links = Array.from(
        find("mantle.party.contact.PartyContactMech", {contactMechId})
            .condition("partyId", "in", partyIds)
            .orderBy("-fromDate")
            .list()
    )
    const ordered = links.filter(link => !link.thruDate || lib.ms(link.thruDate) > lib.ms(now())).concat(links)
    for (const link of ordered) {
        const party = one("mantle.party.Party", {partyId: link.partyId})
        if (partyAccess(who, party).read) return party.partyId
    }
    return null
}
// An order's, a shipment's or an invoice's address (adapter transactionAddress; recordKey {orderId, orderPartSeqId} |
// {shipmentId} | {invoiceId}; addressPurpose its purpose, else the document's first of TRANSACTION_PURPOSES, else its first
// address): the address's own point while it is this address's, else its postal code and country. Read only: no save reaches
// it (a document keeps the address it was made with), and its link is the party whose address it is.
function transactionTarget(who, key, purposeId) {
    const document = transactionDocument(who, key)
    const ordered = purposeId
        ? document.addresses.filter(row => row.purposeId === purposeId)
        : TRANSACTION_PURPOSES[document.kind]
              .map(purpose => document.addresses.find(row => row.purposeId === purpose))
              .concat(document.addresses)
              .filter(Boolean)
    const chosen = ordered[0] || null
    const address = chosen ? one("mantle.party.contact.PostalAddress", {contactMechId: chosen.contactMechId}) : null
    const partyId = address ? addressParty(who, document.parties, address.contactMechId) : null
    return {
        label: (address && addressText(address)) || document.label,
        place: address ? addressPlace(address) : null,
        version:
            "transaction:" +
            document.kind +
            ":" +
            document.id +
            ":" +
            (chosen?.purposeId || "-") +
            ":" +
            (address ? addressVersion(address) : "none"),
        write: false,
        links: partyId ? [{label: partyLabel(partyId), route: ROUTES.party, parameters: {partyId}}] : []
    }
}

const targets = {
    postalAddress: (who, key, purposeId) => addressTarget(who, text(key.contactMechId), purposeId),
    party: (who, key, purposeId) => partyTarget(who, text(key.partyId), purposeId),
    facility: (who, key, purposeId) => facilityTarget(who, text(key.facilityId), purposeId),
    asset: (who, key) => assetTarget(who, text(key.assetId)),
    transactionAddress: (who, key, purposeId) => transactionTarget(who, key, purposeId)
}
function targetOf(kind, who, p) {
    if (!targets[kind]) throw new Error("Unknown map place kind " + kind)
    const key = p.recordKey && typeof p.recordKey === "object" ? p.recordKey : {}
    return targets[kind](who, key, text(p.addressPurpose))
}

// ===== get#RecordMapContext =====
function context(kind, p) {
    const who = caller()
    let target
    try {
        target = targetOf(kind, who, p)
    } catch (error) {
        if (lib.reasonCode(error) === "RECORD_UNAVAILABLE") return {reasonCode: "RECORD_UNAVAILABLE"}
        ec.logger.error("Map place " + kind + " could not be read: " + (error?.message ?? error))
        throw new Error(L("This record's place could not be read"))
    }
    const place = target.place || {}
    // a target a save can reach: an address, or a record's own point
    const storable = !!target.apply
    return {
        label: target.label,
        geometry: place.geometry || null,
        extent: null,
        precisionEnumId: place.precisionEnumId || null,
        sourceText: place.sourceText || null,
        recordVersion: target.version,
        permittedActions: storable && target.write ? ["view", "chooseLocation"] : ["view"],
        links: target.links || [],
        postalCode: place.geometry ? null : place.postalCode || null,
        countryGeoId: place.geometry ? null : place.countryGeoId || null,
        reasonCode: null
    }
}

// ===== store#RecordLocation =====
function pointOf(value) {
    const point = value && typeof value === "object" ? value : {}
    const longitude = Number(point.longitude)
    const latitude = Number(point.latitude)
    if (blank(point.longitude) || blank(point.latitude) || !validPoint({longitude, latitude}))
        denied("POINT_INVALID", L("Choose a point with a latitude from -90 to 90 and a longitude from -180 to 180"))
    return {longitude, latitude}
}
function store(kind, p) {
    const who = caller()
    try {
        if (!who.userId) unavailable()
        const point = pointOf(p.point)
        const precisionEnumId = text(p.precisionEnumId) || "GPP_USER_CONFIRMED"
        // a point a user chose, or (where allowed below) a postal-area or place estimate; no other kind is a user's to claim
        if (precisionEnumId !== "GPP_USER_CONFIRMED" && !ESTIMATES.includes(precisionEnumId))
            denied("PRECISION_INVALID", L("A chosen location is saved as user-confirmed"))
        const target = targetOf(kind, who, p)
        if (!target.apply || !target.write) denied("PERMISSION_DENIED", L("You may not change this record's location"))
        if (String(p.recordVersion ?? "") !== target.version)
            denied("STALE_VERSION", L("The record changed since its map was opened: open it again"))
        if (ESTIMATES.includes(precisionEnumId) && target.address)
            denied("PRECISION_REFUSED", L("An approximate position is not saved as an address's location"))
        if (ESTIMATES.includes(precisionEnumId) && target.ownPoint)
            denied("POINT_RECORDED", L("An approximate position does not replace a recorded location"))
        // locked from here to the write: a save between the read above and this one is a changed record
        if (!target.lock()) denied("STALE_VERSION", L("The record changed since its map was opened: open it again"))
        const created = call("create#moqui.basic.GeoPoint", {
            geoPointTypeEnumId: "GPT_RECORD_LOCATION",
            dataSourceId: DATA_SOURCE,
            latitude: point.latitude,
            longitude: point.longitude
        })
        call("create#" + PROVENANCE, {
            geoPointId: created.geoPointId,
            precisionEnumId,
            confirmedByUserId: who.userId,
            confirmedDate: now(),
            addressFingerprint: target.address ? addressFingerprint(target.address) : null
        })
        target.apply(created.geoPointId)
        return {applied: true, reasonCode: null, reason: null, recordVersion: targetOf(kind, who, p).version}
    } catch (error) {
        const reasonCode = lib.reasonCode(error)
        if (!REFUSALS.includes(reasonCode)) {
            // not a refusal: logged, and failed with no text of its own (the transaction rolls back)
            ec.logger.error("Map place " + kind + " location was not saved: " + (error?.message ?? error))
            throw new Error(L("The location was not saved"))
        }
        return {
            applied: false,
            reasonCode,
            reason: String(error.message || error).replace(/^[A-Z][A-Z0-9_]+: /, ""),
            recordVersion: null
        }
    }
}

// ===== find#LayerFeatures =====
function extentOf(value) {
    const extent = value && typeof value === "object" ? value : {}
    const [west, south, east, north] = ["west", "south", "east", "north"].map(side => Number(extent[side]))
    const valid =
        [west, south, east, north].every(Number.isFinite) &&
        Math.abs(west) <= 180 &&
        Math.abs(east) <= 180 &&
        Math.abs(south) <= 90 &&
        Math.abs(north) <= 90 &&
        south <= north
    if (!valid) throw new Error("The map extent is not west, south, east and north in degrees")
    return {west, south, east, north}
}
// The viewport as a condition on latitude and longitude; west greater than east crosses the antimeridian.
function boxCondition(box) {
    const cf = ec.entity.conditionFactory
    const latitude = cf.makeCondition([
        cf.makeCondition("latitude", "greater-equals", box.south),
        cf.makeCondition("latitude", "less-equals", box.north)
    ])
    const longitude =
        box.west <= box.east
            ? cf.makeCondition([
                  cf.makeCondition("longitude", "greater-equals", box.west),
                  cf.makeCondition("longitude", "less-equals", box.east)
              ])
            : cf.makeCondition(
                  [
                      cf.makeCondition("longitude", "greater-equals", box.west),
                      cf.makeCondition("longitude", "less-equals", box.east)
                  ],
                  "or"
              )
    return cf.makeCondition(latitude, "and", longitude)
}
function limitOf(value) {
    const limit = Math.floor(Number(value) || 0)
    return Math.max(0, Math.min(limit, FEATURE_CAP))
}
// The precision of each point of a page, in one query.
function precisions(geoPointIds) {
    const found = {}
    if (!geoPointIds.length) return found
    for (const row of find(PROVENANCE)
        .condition("geoPointId", "in", geoPointIds)
        .selectField("geoPointId,precisionEnumId")
        .list())
        found[row.geoPointId] = row.precisionEnumId || null
    return found
}
function feature(featureId, label, row, precision, links) {
    return {
        featureId,
        label,
        geometry: {type: "Point", coordinates: [Number(row.longitude), Number(row.latitude)]},
        precisionEnumId: precision || null,
        links
    }
}
// The organization of each facility of rows that names no owner: its nearest owning ancestor's, the parents of the whole
// page read a level at a time (one query a level, at most FACILITY_DEPTH levels; deeper is taken to be a cycle).
function ancestorOrganizations(rows) {
    const found = {}
    let pending = new Map()
    for (const row of rows) if (!row.ownerPartyId && row.parentFacilityId) pending.set(row.facilityId, row.parentFacilityId)
    for (let depth = 0; depth < FACILITY_DEPTH && pending.size; depth++) {
        const parents = new Map(
            Array.from(
                find("mantle.facility.Facility")
                    .condition("facilityId", "in", Array.from(new Set(pending.values())))
                    .selectField("facilityId,ownerPartyId,parentFacilityId")
                    .list()
            ).map(row => [row.facilityId, row])
        )
        const next = new Map()
        for (const [facilityId, at] of pending) {
            const parent = parents.get(at)
            if (!parent) continue
            if (parent.ownerPartyId) found[facilityId] = parent.ownerPartyId
            else if (parent.parentFacilityId) next.set(facilityId, parent.parentFacilityId)
        }
        pending = next
    }
    return found
}
// The facilities of the caller's facility scope with their own point within the viewport, open ones only, at most limit.
// A facility with no owner of its own is its nearest owning ancestor's: those of the viewport are read apart, a page of
// limit + 1 at a time and each page scope-checked before it counts, at most OWNERLESS_PAGES pages; stopping there says
// truncated.
function facilityFeatures(p) {
    const who = caller()
    const box = extentOf(p.extent)
    const limit = limitOf(p.limit)
    if (!who.userId || who.external || !limit) return {features: [], truncated: false}
    const userScope = who.facilityScope()
    const organizations = userScope.organizationPartyIds
    if (organizations != null && !organizations.length) return {features: [], truncated: false}
    const cf = ec.entity.conditionFactory
    const open = cf.makeCondition(
        [cf.makeCondition("closedDate", "equals", null), cf.makeCondition("closedDate", "greater", now())],
        "or"
    )
    const base = () =>
        find("mantle.facility.FacilityGeoPoint").condition(boxCondition(box)).condition(open).orderBy("facilityName,facilityId")
    let truncated = false
    let rows
    if (organizations == null) {
        rows = Array.from(
            base()
                .limit(limit + 1)
                .list()
        )
    } else {
        const owned = Array.from(
            base()
                .condition("ownerPartyId", "in", organizations)
                .limit(limit + 1)
                .list()
        )
        const ownerless = []
        let exhausted = false
        for (let page = 0; page < OWNERLESS_PAGES && ownerless.length <= limit; page++) {
            const batch = Array.from(
                base()
                    .condition("ownerPartyId", "equals", null)
                    .offset(page * (limit + 1))
                    .limit(limit + 1)
                    .list()
            )
            const organizationOf = ancestorOrganizations(batch)
            ownerless.push(...batch.filter(row => organizations.includes(organizationOf[row.facilityId])))
            if (batch.length <= limit) {
                exhausted = true
                break
            }
        }
        if (!exhausted && ownerless.length <= limit) truncated = true
        rows = owned.concat(ownerless)
        rows.sort(
            (a, b) =>
                String(a.facilityName || "").localeCompare(String(b.facilityName || "")) ||
                String(a.facilityId).localeCompare(b.facilityId)
        )
    }
    if (rows.length > limit) truncated = true
    rows = rows.slice(0, limit)
    const precision = precisions(rows.map(row => row.geoPointId))
    return {
        features: rows.map(row =>
            feature(row.facilityId, text(row.facilityName) || row.facilityId, row, precision[row.geoPointId], [
                {
                    label: text(row.facilityName) || row.facilityId,
                    route: ROUTES.facility,
                    parameters: {facilityId: row.facilityId}
                }
            ])
        ),
        truncated
    }
}
// The assets of the caller's stock scope (their owner's or their facility's owner's organization) with their own point within
// the viewport, but those that have left (delivered, deactivated), at most limit.
function assetFeatures(p) {
    const who = caller()
    const box = extentOf(p.extent)
    const limit = limitOf(p.limit)
    if (!who.userId || who.external || !limit) return {features: [], truncated: false}
    const organizations = who.facilityScope().organizationPartyIds
    if (organizations != null && !organizations.length) return {features: [], truncated: false}
    const cf = ec.entity.conditionFactory
    let query = find("mantle.product.asset.AssetGeoPoint")
        .condition(boxCondition(box))
        .condition(cf.makeCondition("statusId", "not-in", LEFT_ASSET_STATUSES, true))
        .orderBy("assetName,assetId")
    if (organizations != null)
        query = query.condition(
            cf.makeCondition(
                [
                    cf.makeCondition("ownerPartyId", "in", organizations),
                    cf.makeCondition("facilityOwnerPartyId", "in", organizations)
                ],
                "or"
            )
        )
    const found = Array.from(query.limit(limit + 1).list())
    const rows = found.slice(0, limit)
    const precision = precisions(rows.map(row => row.geoPointId))
    return {
        features: rows.map(row =>
            feature(row.assetId, text(row.assetName) || row.assetId, row, precision[row.geoPointId], [
                {label: text(row.assetName) || row.assetId, route: ROUTES.asset, parameters: {assetId: row.assetId}}
            ])
        ),
        truncated: found.length > limit
    }
}

// ===== postalCodeGeoId (entity/PostalAddressGeo.eecas.xml) =====
// The postal code's Geo of an address (address: the value being written; original: the stored one on an update), from the
// local Geo data: the code read by the framework's own rules (normalize#PostalCode: a pure function, no transaction, reads
// nothing) and the in-date GeoPostalCode of the country and that code, read directly, so no lookup service runs inside the
// address's transaction. A value the caller gave is kept unless it is a postal code's Geo of another code or country (a
// copied or stale one, as update#PartyPostalAddress's clone carries): then it is the code's Geo, or cleared when there is
// none. With the code or country removed, a postal code's Geo is cleared. A failure is logged and changes nothing.
function postalGeoRow(geoId) {
    return geoId ? one("moqui.basic.GeoPostalCode", {geoId}) : null
}
function resolvePostalCodeGeo(address) {
    const supplied = text(address.postalCodeGeoId)
    ec.message.pushErrors()
    try {
        const suppliedPostal = postalGeoRow(supplied)
        if (blank(address.postalCode) || blank(address.countryGeoId)) {
            if (suppliedPostal) address.postalCodeGeoId = null
            return
        }
        const country = one("moqui.basic.Geo", {geoId: text(address.countryGeoId)})
        const countryCode = text(country?.geoCodeAlpha2) || text(country?.geoCodeAlpha3)
        const read = countryCode
            ? ec.service
                  .sync()
                  .name("org.moqui.maps.GeoDataServices.normalize#PostalCode")
                  .parameters({country: countryCode, postalCode: String(address.postalCode).trim().slice(0, 40)})
                  .disableAuthz()
                  .call() || {}
            : {}
        if (ec.message.hasError()) {
            ec.logger.error(
                "The postal code Geo of address " +
                    (address.contactMechId || "") +
                    " was not looked up: " +
                    ec.message.getErrorsString()
            )
            return
        }
        const code = text(read.normalizedCode)
        const matches =
            suppliedPostal && code && suppliedPostal.countryGeoId === country.geoId && suppliedPostal.normalizedCode === code
        if (supplied && (!suppliedPostal || matches)) return
        const found = code
            ? Array.from(
                  find("moqui.basic.GeoPostalCode", {countryGeoId: country.geoId, normalizedCode: code})
                      .condition(
                          ec.entity.conditionFactory.makeCondition(
                              [
                                  ec.entity.conditionFactory.makeCondition("thruDate", "equals", null),
                                  ec.entity.conditionFactory.makeCondition("thruDate", "greater", now())
                              ],
                              "or"
                          )
                      )
                      .condition("granularityEnumId", read.granularityEnumId || "GPG_FULL")
                      .selectField("geoId")
                      .limit(2)
                      .list()
              )
            : []
        if (found.length === 1) address.postalCodeGeoId = found[0].geoId
        else if (suppliedPostal) address.postalCodeGeoId = null
    } catch (error) {
        ec.logger.error(
            "The postal code Geo of address " + (address.contactMechId || "") + " was not looked up: " + (error?.message ?? error)
        )
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}

const operations = {
    postalAddressContext: p => context("postalAddress", p),
    postalAddressStore: p => store("postalAddress", p),
    partyContext: p => context("party", p),
    partyStore: p => store("party", p),
    facilityContext: p => context("facility", p),
    facilityStore: p => store("facility", p),
    facilityFeatures,
    assetContext: p => context("asset", p),
    assetStore: p => store("asset", p),
    assetFeatures,
    transactionAddressContext: p => context("transactionAddress", p)
}
function execute(op, p) {
    if (!operations[op]) throw new Error("Unknown map place operation " + op)
    return operations[op](p)
}
;({execute, resolvePostalCodeGeo})
