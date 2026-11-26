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
//   PARTY_LOCATION_EDIT and a party of their organizations (one of them, owned by one, or its staff). A party's own point
//   (PartyGeoPoint) is an organization's business place, and a person's private one.
// - A facility: in the caller's facility scope (FacilityScope.js) to read; FACILITY_EDIT there to write, as store#Facility.
// - An asset: in the stock scope (StockScope.js: its owner's or its facility's owner's organization) to read;
//   MAINTENANCE_RESOURCE_EDIT or FACILITY_EDIT there to write.
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
// What the caller may do with a party: {read, write, self, owner, person}; write is the PARTY_LOCATION_EDIT scope, which a
// purpose narrows (purposeAllowed). Beyond the party themselves and a personal contact's owner, a caller reaches only with
// organizations of their own, as Mantle's party filter (MANTLE_USER_ORG): one of their organizations, a party owned by _NA_
// or by one of them; the staff of an internal organization (or of a unit under an internal top-level one, a department)
// and such an organization itself only under one of the caller's top-level organizations, and write only within theirs.
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
    if (organizations.includes(party.partyId)) return reach(true, true)
    const tenantOf = orgId => {
        const root = rootOf(orgId, who.roots)
        return internalParty(orgId) || internalParty(root) ? root : null
    }
    // staff of internal organizations (their units included)
    const staffOf = employersOf(party.partyId).filter(orgId => tenantOf(orgId))
    if (staffOf.length)
        return reach(
            staffOf.some(orgId => organizations.includes(orgId) || who.organizationRoots().has(tenantOf(orgId))),
            staffOf.some(orgId => organizations.includes(orgId))
        )
    // an internal organization, or a unit under one: its tenant's
    const tenant = tenantOf(party.partyId)
    if (tenant) return reach(who.organizationRoots().has(tenant), organizations.includes(tenant))
    const owner = party.ownerPartyId
    return reach(owner === "_NA_" || organizations.includes(owner), organizations.includes(owner))
}
// Whether the access reaches an address of a purpose: all of them for the party or its personal contact's owner, else its
// business addresses (no home address; a person's work address alone).
function purposeAllowed(found, purposeId) {
    if (found.self || found.owner) return true
    if (!found.read || PRIVATE_PURPOSES.includes(purposeId)) return false
    return found.person ? PERSON_BUSINESS_PURPOSES.includes(purposeId) : true
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
// A recorded point as a place: {geometry, precisionEnumId, sourceText}, or null; with fingerprint (an address's point) null
// when its provenance names another address.
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
            : L("Recorded location")
    }
}
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
// What the caller may do with an address, through any party or facility it is current for: {read, write}.
function addressAccess(who, contactMechId, purposeId) {
    let read = false
    let write = false
    for (const link of partyLinks(contactMechId, purposeId)) {
        const found = partyAccess(who, one("mantle.party.Party", {partyId: link.partyId}))
        if (!purposeAllowed(found, link.contactMechPurposeId)) continue
        read = true
        if (found.write) write = true
    }
    for (const link of facilityLinks(contactMechId, purposeId)) {
        const facility = one("mantle.facility.Facility", {facilityId: link.facilityId})
        if (!facilityRead(who, facility)) continue
        read = true
        if (facilityWrite(who, facility)) write = true
    }
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
    ).filter(link => purposeAllowed(found, link.contactMechPurposeId))
    const addressOf = link => {
        const address = one("mantle.party.contact.PostalAddress", {contactMechId: link.contactMechId})
        if (!address) return null
        return Object.assign(addressTarget(who, address.contactMechId, link.contactMechPurposeId), {label, links})
    }
    if (purposeId) {
        // a purpose the caller may not read is as one the party does not have
        if (!purposeAllowed(found, purposeId)) unavailable()
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
            place = Object.assign(facilityPoint, {sourceText: L("Where its facility is") + ": " + facilityLabel(facility)})
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
const targets = {
    postalAddress: (who, key, purposeId) => addressTarget(who, text(key.contactMechId), purposeId),
    party: (who, key, purposeId) => partyTarget(who, text(key.partyId), purposeId),
    facility: (who, key, purposeId) => facilityTarget(who, text(key.facilityId), purposeId),
    asset: (who, key) => assetTarget(who, text(key.assetId))
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
    assetFeatures
}
function execute(op, p) {
    if (!operations[op]) throw new Error("Unknown map place operation " + op)
    return operations[op](p)
}
;({execute, resolvePostalCodeGeo})
