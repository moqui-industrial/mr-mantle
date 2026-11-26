// Mantle's map adapters (mantle.other.MapPlaceServices, MapPlaces.js; mr-moqui plans/Maps.md §9 P3): a facility editor sees
// a facility's place with Choose location and a reader of the organization without it, and another organization's facility is
// refused, also through the framework's get#EffectiveConfig with authorization on; a reader's save is refused, a stale version
// is refused, and a save makes a new point with its provenance; an estimate does not replace a recorded point; an address with
// no point answers its postal code (approximate through the framework) and nothing is written to its geoPointId; its
// postalCodeGeoId is the code's Geo, or null; a coworker reads a person's work address and not their home address, which the
// person reads and may locate; an internal organization's own address is located only by a settings manager of it
// (ADMIN_SETTINGS_MANAGE beside PARTY_LOCATION_EDIT); a changed address does not show the point chosen for the old one; the facility and asset
// layers answer only the viewport and the caller's organizations, at most the limit. The users are in spec-local groups.
// Beyond these: only the caller's organizations reach other parties (a user of none and an outside user, EXTERNAL_USER, are
// refused, and so are a disabled party and another organization's customer; a personal contact is its owner's), a room with no
// owner of its own is its building's organization's; an asset's, an organization's own and an address's point are saved; and
// postalCodeGeoId follows a change of the code in place, keeps a value the caller gave, and stays empty for a refused code.
// A point with no provenance says its precision is unknown. A transaction's address (an order's ship-to, a shipment's
// destination and origin, an invoice's billing address) is read view only by a reader of the document (an assigned Sales
// representative, a shipper at its facility, a receivables reader), linked to its party, and refused to a member of the
// organization who reads none, an unassigned representative (a consumer's home ship-to), another organization and an outside
// user. A Sales account editor (SALES_ACCOUNT_EDIT) locates an account of their scope and its contact, not a shared one,
// another organization's, an internal organization, an address row the organization shares, nor without a Sales read, and a
// reader without it does not; an HR reader (PEOPLE_HR_VIEW) reads an employee's home address, never locates it, not a person
// People does not admit, and a party's map without a purpose still opens on the work address.
// Run: ./moq test mr-mantle --spec MapPlaces
const S = "mantle.other.MapPlaceServices."
const find = (entity, conditions = {}) => ec.entity.find(entity).condition(conditions).disableAuthz()
const one = (entity, conditions) => find(entity, conditions).one()
const since = "2000-01-01T00:00:00Z"
const POSTAL_GEO = "USA_Z_99951"

function as(username, action) {
    login(username)
    try {
        return action()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
// a call's result with its error text ("" when it succeeds), in its own transaction so a refusal rolls back only itself
function invoke(service, parameters) {
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
const sys = run => {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return run()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const place = (verb, noun, recordKey, extra) => invoke(S + verb + "#" + noun, Object.assign({recordKey}, extra || {}))
const save = (noun, recordKey, recordVersion, point, extra) =>
    invoke(
        S + "store#" + noun,
        Object.assign({recordKey, recordVersion, point: point || {longitude: 11, latitude: 12}}, extra || {})
    )
const point = (geoPointId, latitude, longitude) =>
    call("create#moqui.basic.GeoPoint", {geoPointId, geoPointTypeEnumId: "GPT_RECORD_LOCATION", latitude, longitude})
function ensureGroup(userGroupId, permissions) {
    if (!one("moqui.security.UserGroup", {userGroupId})) call("create#moqui.security.UserGroup", {userGroupId})
    for (const userPermissionId of permissions)
        if (!one("moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since}))
            call("create#moqui.security.UserGroupPermission", {userGroupId, userPermissionId, fromDate: since})
}
function address(parameters) {
    return call(
        "mantle.party.ContactServices.create#PostalAddress",
        Object.assign({address1: "1 Spec Way", city: "Spec City", countryGeoId: "USA"}, parameters)
    ).contactMechId
}
const facilityExtent = {west: 9, south: 9, east: 12, north: 12}

spec({
    setupSpec() {
        login("john.doe")
        sys(() => {
            ensureGroup("MPL_EDITORS", ["FACILITY_EDIT", "PARTY_LOCATION_EDIT"])
            ensureGroup("MPL_READERS", [])
            ensureGroup("MPL_EXTERNALS", ["EXTERNAL_USER"])
            // an internal organization's own places are its settings manager's (SEC-BOS-89)
            ensureGroup("MPL_SETTERS", ["PARTY_LOCATION_EDIT", "ADMIN_SETTINGS_MANAGE"])
            // Sales' account editors locate their accounts' addresses; People's HR readers read a home address
            ensureGroup("MPL_SALES", ["SALES_VIEW", "SALES_ACCOUNT_EDIT"])
            ensureGroup("MPL_HR", ["PEOPLE_HR_VIEW"])
            // an account editor with no Sales read, a receivables reader and a shipper (a transaction's readers)
            ensureGroup("MPL_SALES_BLIND", ["SALES_ACCOUNT_EDIT"])
            ensureGroup("MPL_FINANCE", ["RECEIVABLE_VIEW"])
            ensureGroup("MPL_SHIPPERS", ["SHIPMENT_SHIP"])
            for (const partyId of ["MPL_ORG", "MPL_OTHER"]) {
                call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId, organizationName: partyId})
                call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
            }
            for (const [partyId, userGroupId, orgId] of [
                ["MPL_EDITOR", "MPL_EDITORS", "MPL_ORG"],
                ["MPL_READER", "MPL_READERS", "MPL_ORG"],
                ["MPL_SETTER", "MPL_SETTERS", "MPL_ORG"],
                ["MPL_SALESREP", "MPL_SALES", "MPL_ORG"],
                ["MPL_HRREADER", "MPL_HR", "MPL_ORG"],
                ["MPL_SALESREP2", "MPL_SALES", "MPL_ORG"],
                ["MPL_SALESBLIND", "MPL_SALES_BLIND", "MPL_ORG"],
                ["MPL_AR", "MPL_FINANCE", "MPL_ORG"],
                ["MPL_SHIPPER", "MPL_SHIPPERS", "MPL_ORG"],
                ["MPL_OUTSIDER", "MPL_EDITORS", "MPL_OTHER"],
                // a user of no organization, and an outside user of the organization
                ["MPL_LONER", "MPL_EDITORS", null],
                ["MPL_CLIENT", "MPL_EXTERNALS", "MPL_ORG"]
            ]) {
                call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId, firstName: partyId})
                call("create#moqui.security.UserAccount", {
                    userId: partyId,
                    username: partyId.toLowerCase(),
                    partyId,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: partyId, userGroupId, fromDate: since})
                if (orgId)
                    call("create#mantle.party.PartyRelationship", {
                        fromPartyId: partyId,
                        toPartyId: orgId,
                        relationshipTypeEnumId: "PrtEmployee",
                        toRoleTypeId: "OrgInternal",
                        fromDate: since
                    })
            }
            // the postal code 99951 as the framework's Geo data import writes it, with its Census point
            ec.entity
                .makeValue("moqui.basic.Geo")
                .setAll({geoId: POSTAL_GEO, geoTypeEnumId: "GEOT_POSTAL_CODE", geoName: "99951"})
                .createOrUpdate()
            ec.entity
                .makeValue("moqui.basic.GeoPostalCode")
                .setAll({
                    geoId: POSTAL_GEO,
                    countryGeoId: "USA",
                    normalizedCode: "99951",
                    displayCode: "99951",
                    granularityEnumId: "GPG_FULL",
                    sourceKey: "CENSUS_ZCTA"
                })
                .createOrUpdate()
            ec.entity
                .makeValue("moqui.basic.GeoPoint")
                .setAll({
                    geoPointId: POSTAL_GEO + "_CENSUS_ZCTA",
                    geoPointTypeEnumId: "GPT_GEO_REFERENCE",
                    latitude: 40.5,
                    longitude: -75.5
                })
                .createOrUpdate()
            ec.entity
                .makeValue("moqui.basic.GeoPointAssoc")
                .setAll({
                    geoId: POSTAL_GEO,
                    geoPointId: POSTAL_GEO + "_CENSUS_ZCTA",
                    pointRoleEnumId: "GPR_REPRESENTATIVE",
                    precisionEnumId: "GPP_POSTAL_AREA",
                    dataSetId: "CENSUS_ZCTA",
                    edition: "2026",
                    priority: 10,
                    fromDate: since
                })
                .createOrUpdate()
            ec.cache.getCache("maps.postal.lookup").clear()

            // facilities: two of the organization's near (10, 10), one far, one of another organization in the same viewport,
            // and one with an address and no point
            point("MPL_GP_FAC", 10, 10)
            point("MPL_GP_FAC_B", 10.1, 10.1)
            point("MPL_GP_FAR", 50, 50)
            point("MPL_GP_OTHER", 10.5, 10.5)
            point("MPL_GP_ASSET", 10.2, 10.2)
            point("MPL_GP_OTHER_ASSET", 10.3, 10.3)
            const facility = (facilityId, ownerPartyId, geoPointId) =>
                call("create#mantle.facility.Facility", {facilityId, facilityName: facilityId, ownerPartyId, geoPointId})
            facility("MPL_FAC", "MPL_ORG", "MPL_GP_FAC")
            facility("MPL_FAC_B", "MPL_ORG", "MPL_GP_FAC_B")
            facility("MPL_FAC_FAR", "MPL_ORG", "MPL_GP_FAR")
            facility("MPL_OTHER_FAC", "MPL_OTHER", "MPL_GP_OTHER")
            facility("MPL_FAC_ADDR", "MPL_ORG", null)
            address({facilityId: "MPL_FAC_ADDR", contactMechPurposeId: "PostalPrimary", postalCode: "99951"})
            const asset = (assetId, ownerPartyId, geoPointId) =>
                call("create#mantle.product.asset.Asset", {
                    assetId,
                    assetName: assetId,
                    assetTypeEnumId: "AstTpEquipment",
                    statusId: "AstInUse",
                    ownerPartyId,
                    geoPointId,
                    hasQuantity: "N"
                })
            asset("MPL_ASSET", "MPL_ORG", "MPL_GP_ASSET")
            asset("MPL_OTHER_ASSET", "MPL_OTHER", "MPL_GP_OTHER_ASSET")
            // a person's home and work addresses, and their organization's primary address
            address({partyId: "MPL_READER", contactMechPurposeId: "PostalHome", postalCode: "99951", address1: "9 Home Lane"})
            address({partyId: "MPL_READER", contactMechPurposeId: "PostalWork", postalCode: "99951", address1: "2 Work Street"})
            address({partyId: "MPL_ORG", contactMechPurposeId: "PostalPrimary", postalCode: "00000", address1: "3 Office Road"})
            // parties around the reach rules: shared (_NA_), another organization's customer, disabled, a customer with no
            // address, and a personal contact of the reader's
            const organization = (partyId, extra) => {
                call("create#mantle.party.Party", Object.assign({partyId, partyTypeEnumId: "PtyOrganization"}, extra))
                call("create#mantle.party.Organization", {partyId, organizationName: partyId})
            }
            organization("MPL_SHARED", {ownerPartyId: "_NA_"})
            organization("MPL_OTHER_CUSTOMER", {ownerPartyId: "MPL_OTHER"})
            organization("MPL_DISABLED", {ownerPartyId: "MPL_ORG", disabled: "Y"})
            organization("MPL_CUSTOMER", {ownerPartyId: "MPL_ORG"})
            for (const partyId of ["MPL_SHARED", "MPL_OTHER_CUSTOMER", "MPL_DISABLED"])
                address({partyId, contactMechPurposeId: "PostalPrimary", postalCode: "99951"})
            call("create#mantle.party.Party", {
                partyId: "MPL_PRIVATE",
                partyTypeEnumId: "PtyPerson",
                privateOwnerUserId: "MPL_READER"
            })
            call("create#mantle.party.Person", {partyId: "MPL_PRIVATE", firstName: "Private"})
            address({partyId: "MPL_PRIVATE", contactMechPurposeId: "PostalHome", postalCode: "99951"})
            // a room with no owner of its own (its building's organization's), and a facility past the antimeridian
            point("MPL_GP_ROOM", 10.05, 10.05)
            point("MPL_GP_DATELINE", 10, 179.5)
            call("create#mantle.facility.Facility", {
                facilityId: "MPL_ROOM",
                facilityName: "MPL_ROOM",
                parentFacilityId: "MPL_FAC",
                geoPointId: "MPL_GP_ROOM"
            })
            facility("MPL_FAC_DATELINE", "MPL_ORG", "MPL_GP_DATELINE")
            // a Sales account of the organization with its address, and the order, shipment and invoice made with that address
            // (the shipment from the organization's office); another organization's order
            organization("MPL_ACCOUNT", {ownerPartyId: "MPL_ORG"})
            call("create#mantle.party.PartyRole", {partyId: "MPL_ACCOUNT", roleTypeId: "Customer"})
            const accountAddress = address({
                partyId: "MPL_ACCOUNT",
                contactMechPurposeId: "PostalPrimary",
                postalCode: "99951",
                address1: "8 Account Ave"
            })
            const officeAddress = find("mantle.party.contact.PartyContactMech", {
                partyId: "MPL_ORG",
                contactMechPurposeId: "PostalPrimary"
            }).one().contactMechId
            const create = (entity, fields) => ec.entity.makeValue(entity).setAll(fields).create()
            const addressOf = (partyId, contactMechPurposeId) =>
                find("mantle.party.contact.PartyContactMech", {partyId, contactMechPurposeId}).one().contactMechId
            // a consumer (a person customer of the organization) with only a home address, and a contact of the account
            call("create#mantle.party.Party", {partyId: "MPL_CONSUMER", partyTypeEnumId: "PtyPerson", ownerPartyId: "MPL_ORG"})
            call("create#mantle.party.Person", {partyId: "MPL_CONSUMER", firstName: "Consumer"})
            call("create#mantle.party.PartyRole", {partyId: "MPL_CONSUMER", roleTypeId: "Customer"})
            const consumerHome = address({
                partyId: "MPL_CONSUMER",
                contactMechPurposeId: "PostalHome",
                postalCode: "99951",
                address1: "5 Consumer Court"
            })
            call("create#mantle.party.Party", {partyId: "MPL_CONTACT", partyTypeEnumId: "PtyPerson", ownerPartyId: "MPL_ORG"})
            call("create#mantle.party.Person", {partyId: "MPL_CONTACT", firstName: "Contact"})
            call("create#mantle.party.PartyRelationship", {
                fromPartyId: "MPL_CONTACT",
                toPartyId: "MPL_ACCOUNT",
                relationshipTypeEnumId: "PrtContact",
                fromDate: since
            })
            address({partyId: "MPL_CONTACT", contactMechPurposeId: "PostalWork", postalCode: "99951", address1: "6 Contact Row"})
            // the account's billing address, shared with the organization's own (an internal organization's place)
            const sharedAddress = address({
                partyId: "MPL_ACCOUNT",
                contactMechPurposeId: "PostalBilling",
                postalCode: "99951",
                address1: "4 Shared Street"
            })
            call("create#mantle.party.contact.PartyContactMech", {
                partyId: "MPL_ORG",
                contactMechId: sharedAddress,
                contactMechPurposeId: "PostalGeneral",
                fromDate: since
            })
            // placed sales orders assigned to the first representative (the account's, the consumer's); another organization's
            // order to its own customer
            for (const [orderId, vendorPartyId, customerPartyId, postalContactMechId, assigned] of [
                ["MPL_ORDER", "MPL_ORG", "MPL_ACCOUNT", accountAddress, true],
                ["MPL_CONSUMER_ORDER", "MPL_ORG", "MPL_CONSUMER", consumerHome, true],
                ["MPL_OTHER_ORDER", "MPL_OTHER", "MPL_OTHER_CUSTOMER", addressOf("MPL_OTHER_CUSTOMER", "PostalPrimary"), false]
            ]) {
                create("mantle.order.OrderHeader", {orderId, statusId: "OrderPlaced", placedDate: ec.user.nowTimestamp})
                create("mantle.order.OrderPart", {
                    orderId,
                    orderPartSeqId: "01",
                    vendorPartyId,
                    customerPartyId,
                    postalContactMechId
                })
                if (assigned)
                    create("mantle.order.OrderPartParty", {
                        orderId,
                        orderPartSeqId: "01",
                        partyId: "MPL_SALESREP",
                        roleTypeId: "SalesRepresentative"
                    })
            }
            create("mantle.shipment.Shipment", {shipmentId: "MPL_SHIPMENT", fromPartyId: "MPL_ORG", toPartyId: "MPL_ACCOUNT"})
            create("mantle.shipment.ShipmentRouteSegment", {
                shipmentId: "MPL_SHIPMENT",
                shipmentRouteSegmentSeqId: "01",
                originFacilityId: "MPL_FAC",
                originPostalContactMechId: officeAddress,
                destPostalContactMechId: accountAddress
            })
            create("mantle.account.invoice.Invoice", {invoiceId: "MPL_INVOICE", fromPartyId: "MPL_ORG", toPartyId: "MPL_ACCOUNT"})
            create("mantle.account.invoice.InvoiceContactMech", {
                invoiceId: "MPL_INVOICE",
                contactMechPurposeId: "PostalBilling",
                contactMechId: accountAddress
            })
        })
    },
    cleanup() {
        ec.message.clearErrors()
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

feature(
    "a facility editor sees a facility's place with Choose location, a reader without it, and another organization's is refused",
    {
        when() {
            const key = {facilityId: "MPL_FAC"}
            const config = (username, facilityId) =>
                as(
                    username,
                    () =>
                        invoke("org.moqui.maps.MapServices.get#EffectiveConfig", {
                            adapterKey: "facility",
                            recordKey: JSON.stringify({facilityId}),
                            recordLayers: false
                        }).config || {}
                )
            return {
                editor: as("mpl_editor", () => place("get", "FacilityPlace", key)),
                reader: as("mpl_reader", () => place("get", "FacilityPlace", key)),
                outsider: as("mpl_outsider", () => place("get", "FacilityPlace", key)),
                framed: config("mpl_editor", "MPL_FAC"),
                refused: config("mpl_outsider", "MPL_FAC")
            }
        },
        then({editor, reader, outsider, framed, refused}) {
            editor.error == ""
            editor.label == "MPL_FAC"
            editor.geometry.coordinates[0] == 10
            editor.geometry.coordinates[1] == 10
            editor.recordVersion == "facility:MPL_FAC:MPL_GP_FAC"
            // a point recorded before provenance: shown as recorded, its precision unknown
            editor.precisionEnumId == null
            editor.sourceText == "Recorded location; precision unknown — recorded before provenance"
            editor.permittedActions.includes("chooseLocation")
            reader.geometry.coordinates[0] == 10
            !reader.permittedActions.includes("chooseLocation")
            reader.permittedActions.includes("view")
            outsider.reasonCode == "RECORD_UNAVAILABLE"
            outsider.label == null
            outsider.geometry == null
            // through the framework, with authorization on: the grant reaches the adapter, and the adapter refuses
            framed.record.label == "MPL_FAC"
            framed.record.permittedActions.includes("chooseLocation")
            refused.record == null
            refused.layerErrors.some(error => error.id == "record" && error.reasonCode == "RECORD_UNAVAILABLE")
        }
    }
)

feature("a reader cannot save a facility's location, a stale version is refused, and a save is a new point with its provenance", {
    when() {
        const key = {facilityId: "MPL_FAC_B"}
        const version = "facility:MPL_FAC_B:MPL_GP_FAC_B"
        const reader = as("mpl_reader", () => save("FacilityPlace", key, version))
        const outsider = as("mpl_outsider", () => save("FacilityPlace", key, version))
        const stale = as("mpl_editor", () => save("FacilityPlace", key, "facility:MPL_FAC_B:-"))
        const estimate = as("mpl_editor", () => save("FacilityPlace", key, version, null, {precisionEnumId: "GPP_POSTAL_AREA"}))
        const claimed = as("mpl_editor", () => save("FacilityPlace", key, version, null, {precisionEnumId: "GPP_ADDRESS_MATCH"}))
        const saved = as("mpl_editor", () => save("FacilityPlace", key, version, {longitude: 10.15, latitude: 10.05}))
        const facility = one("mantle.facility.Facility", {facilityId: "MPL_FAC_B"})
        const geoPoint = one("moqui.basic.GeoPoint", {geoPointId: facility.geoPointId})
        const provenance = one("mantle.party.contact.GeoPointProvenance", {geoPointId: facility.geoPointId})
        const again = as("mpl_editor", () => save("FacilityPlace", key, version))
        return {reader, outsider, stale, estimate, claimed, saved, facility, geoPoint, provenance, again}
    },
    then({reader, outsider, stale, estimate, claimed, saved, facility, geoPoint, provenance, again}) {
        reader.applied == false
        reader.reasonCode == "PERMISSION_DENIED"
        outsider.applied == false
        outsider.reasonCode == "RECORD_UNAVAILABLE"
        stale.reasonCode == "STALE_VERSION"
        estimate.reasonCode == "POINT_RECORDED"
        claimed.reasonCode == "PRECISION_INVALID"
        saved.error == ""
        saved.applied == true
        facility.geoPointId != "MPL_GP_FAC_B"
        saved.recordVersion == "facility:MPL_FAC_B:" + facility.geoPointId
        geoPoint.latitude == 10.05
        geoPoint.longitude == 10.15
        geoPoint.dataSourceId == "MANTLE_MAP_CHOICE"
        geoPoint.geoPointTypeEnumId == "GPT_RECORD_LOCATION"
        provenance.precisionEnumId == "GPP_USER_CONFIRMED"
        provenance.confirmedByUserId == "MPL_EDITOR"
        provenance.confirmedDate != null
        // the point the facility had is left as it was, for any record that shares it
        one("moqui.basic.GeoPoint", {geoPointId: "MPL_GP_FAC_B"}).latitude == 10.1
        again.reasonCode == "STALE_VERSION"
    }
})

feature(
    "an address with no point answers its postal code, approximate through the framework, and nothing is written to the address",
    {
        when() {
            const fcm = find("mantle.facility.FacilityContactMech", {facilityId: "MPL_FAC_ADDR"}).one()
            const before = one("mantle.party.contact.PostalAddress", {contactMechId: fcm.contactMechId})
            const direct = as("mpl_reader", () => place("get", "FacilityPlace", {facilityId: "MPL_FAC_ADDR"}))
            const framed = as(
                "mpl_reader",
                () =>
                    invoke("org.moqui.maps.MapServices.get#EffectiveConfig", {
                        adapterKey: "postalAddress",
                        recordKey: JSON.stringify({contactMechId: fcm.contactMechId}),
                        recordLayers: false
                    }).config || {}
            )
            const estimate = as("mpl_editor", () =>
                save("PostalAddressPlace", {contactMechId: fcm.contactMechId}, framed.record?.recordVersion, null, {
                    precisionEnumId: "GPP_POSTAL_AREA"
                })
            )
            const after = one("mantle.party.contact.PostalAddress", {contactMechId: fcm.contactMechId})
            const unknown = sys(() =>
                address({facilityId: "MPL_FAC_ADDR", contactMechPurposeId: "PostalGeneral", postalCode: "99952"})
            )
            return {
                before,
                direct,
                framed,
                estimate,
                after,
                unknown: one("mantle.party.contact.PostalAddress", {contactMechId: unknown})
            }
        },
        then({before, direct, framed, estimate, after, unknown}) {
            direct.error == ""
            direct.geometry == null
            direct.postalCode == "99951"
            direct.countryGeoId == "USA"
            framed.record.approximate == true
            framed.record.precisionEnumId == "GPP_POSTAL_AREA"
            framed.points.length == 1
            framed.points[0].lat == 40.5
            estimate.reasonCode == "PRECISION_REFUSED"
            after.geoPointId == null
            // postalCodeGeoId is the code's Geo when one is imported, null otherwise
            before.postalCodeGeoId == POSTAL_GEO
            unknown.postalCodeGeoId == null
        }
    }
)

feature("a coworker reads a person's work address and not their home address, which the person reads and may locate; an internal organization's own address is located by its settings manager alone", {
    when() {
        const home = as("mpl_editor", () => place("get", "PartyPlace", {partyId: "MPL_READER"}, {addressPurpose: "PostalHome"}))
        const work = as("mpl_editor", () => place("get", "PartyPlace", {partyId: "MPL_READER"}, {addressPurpose: "PostalWork"}))
        const fallback = as("mpl_editor", () => place("get", "PartyPlace", {partyId: "MPL_READER"}))
        const own = as("mpl_reader", () => place("get", "PartyPlace", {partyId: "MPL_READER"}, {addressPurpose: "PostalHome"}))
        const homeLink = find("mantle.party.contact.PartyContactMech", {
            partyId: "MPL_READER",
            contactMechPurposeId: "PostalHome"
        }).one()
        const byAddress = as("mpl_editor", () => place("get", "PostalAddressPlace", {contactMechId: homeLink.contactMechId}))
        const organization = as("mpl_reader", () => place("get", "PartyPlace", {partyId: "MPL_ORG"}))
        const editorOrganization = as("mpl_editor", () => place("get", "PartyPlace", {partyId: "MPL_ORG"}))
        const setterOrganization = as("mpl_setter", () => place("get", "PartyPlace", {partyId: "MPL_ORG"}))
        const outsider = as("mpl_outsider", () => place("get", "PartyPlace", {partyId: "MPL_ORG"}))
        return {home, work, fallback, own, byAddress, organization, editorOrganization, setterOrganization, outsider}
    },
    then({home, work, fallback, own, byAddress, organization, editorOrganization, setterOrganization, outsider}) {
        home.reasonCode == "RECORD_UNAVAILABLE"
        home.postalCode == null
        work.reasonCode == null
        work.postalCode == "99951"
        work.permittedActions.includes("chooseLocation")
        // with no purpose, the readable address: the work address, never the home one
        fallback.recordVersion == work.recordVersion
        own.postalCode == "99951"
        own.permittedActions.includes("chooseLocation")
        own.recordVersion != work.recordVersion
        byAddress.reasonCode == "RECORD_UNAVAILABLE"
        organization.postalCode == "00000"
        !organization.permittedActions.includes("chooseLocation")
        // the internal organization's own address: PARTY_LOCATION_EDIT alone does not locate it, its settings manager does
        editorOrganization.postalCode == "00000"
        !editorOrganization.permittedActions.includes("chooseLocation")
        setterOrganization.permittedActions.includes("chooseLocation")
        outsider.reasonCode == "RECORD_UNAVAILABLE"
    }
})

feature("a point chosen for an address is not shown once the address changes, and its old version is refused", {
    when() {
        const key = {partyId: "MPL_READER"}
        const purpose = {addressPurpose: "PostalHome"}
        const opened = as("mpl_reader", () => place("get", "PartyPlace", key, purpose))
        const saved = as("mpl_reader", () =>
            save("PartyPlace", key, opened.recordVersion, {longitude: -75.4, latitude: 40.6}, purpose)
        )
        const located = as("mpl_reader", () => place("get", "PartyPlace", key, purpose))
        const link = find("mantle.party.contact.PartyContactMech", {partyId: "MPL_READER", contactMechPurposeId: "PostalHome"})
            .conditionDate("fromDate", "thruDate", null)
            .one()
        // Mantle's address update: a new address that keeps the old one's point
        const changed = sys(() =>
            call("mantle.party.ContactServices.update#PartyPostalAddress", {
                partyId: "MPL_READER",
                contactMechId: link.contactMechId,
                contactMechPurposeId: "PostalHome",
                address1: "10 New Lane"
            })
        )
        const moved = one("mantle.party.contact.PostalAddress", {contactMechId: changed.contactMechId})
        const after = as("mpl_reader", () => place("get", "PartyPlace", key, purpose))
        const late = as("mpl_reader", () => save("PartyPlace", key, located.recordVersion, null, purpose))
        return {saved, located, moved, after, late}
    },
    then({saved, located, moved, after, late}) {
        saved.applied == true
        located.geometry.coordinates[1] == 40.6
        located.precisionEnumId == "GPP_USER_CONFIRMED"
        located.sourceText.startsWith("Chosen on a map")
        moved.geoPointId != null
        after.geometry == null
        after.postalCode == "99951"
        after.recordVersion != located.recordVersion
        late.reasonCode == "STALE_VERSION"
    }
})

feature("the facility and asset layers answer only the viewport and the caller's organizations, at most the limit", {
    when() {
        const layer = (service, limit, extent) => invoke(S + service, {extent: extent || facilityExtent, limit})
        const editor = as("mpl_editor", () => layer("find#FacilityPlaces", 10))
        const cut = as("mpl_editor", () => layer("find#FacilityPlaces", 1))
        const outsider = as("mpl_outsider", () => layer("find#FacilityPlaces", 10))
        const across = as("mpl_editor", () => layer("find#FacilityPlaces", 10, {west: 170, south: 9, east: -170, north: 12}))
        const assets = as("mpl_reader", () => layer("find#AssetPlaces", 10))
        const ids = out => Array.from(out.features || []).map(feature => feature.featureId)
        return {
            editor: ids(editor),
            cut,
            outsider: ids(outsider),
            across: ids(across),
            assets: ids(assets),
            first: editor.features?.[0]
        }
    },
    then({editor, cut, outsider, across, assets, first}) {
        editor.includes("MPL_FAC")
        editor.includes("MPL_FAC_B")
        !editor.includes("MPL_FAC_FAR")
        !editor.includes("MPL_OTHER_FAC")
        first.links[0].route == "facilityDetail"
        cut.features.length == 1
        cut.truncated == true
        outsider.includes("MPL_OTHER_FAC")
        !outsider.includes("MPL_FAC")
        !across.includes("MPL_FAC")
        across.includes("MPL_FAC_DATELINE")
        // a room with no owner of its own is its building's organization's
        editor.includes("MPL_ROOM")
        !outsider.includes("MPL_ROOM")
        assets.includes("MPL_ASSET")
        !assets.includes("MPL_OTHER_ASSET")
    }
})

feature(
    "only the caller's organizations reach other parties: a user of none, an outside user, a disabled or another organization's party are refused",
    {
        when() {
            const party = (username, partyId) => as(username, () => place("get", "PartyPlace", {partyId}))
            return {
                lonerShared: party("mpl_loner", "MPL_SHARED"),
                lonerOwn: as("mpl_loner", () => place("get", "PartyPlace", {partyId: "MPL_LONER"})),
                clientOrg: party("mpl_client", "MPL_ORG"),
                clientFacility: as("mpl_client", () => place("get", "FacilityPlace", {facilityId: "MPL_FAC"})),
                clientLayer: as("mpl_client", () => invoke(S + "find#FacilityPlaces", {extent: facilityExtent, limit: 10})),
                editorShared: party("mpl_editor", "MPL_SHARED"),
                otherCustomer: party("mpl_editor", "MPL_OTHER_CUSTOMER"),
                editorDisabled: party("mpl_editor", "MPL_DISABLED"),
                ownerPrivate: as("mpl_reader", () =>
                    place("get", "PartyPlace", {partyId: "MPL_PRIVATE"}, {addressPurpose: "PostalHome"})
                ),
                editorPrivate: party("mpl_editor", "MPL_PRIVATE"),
                room: as("mpl_reader", () => place("get", "FacilityPlace", {facilityId: "MPL_ROOM"})),
                outsiderRoom: as("mpl_outsider", () => place("get", "FacilityPlace", {facilityId: "MPL_ROOM"}))
            }
        },
        then(found) {
            found.lonerShared.reasonCode == "RECORD_UNAVAILABLE"
            found.lonerOwn.reasonCode == null
            found.clientOrg.reasonCode == "RECORD_UNAVAILABLE"
            found.clientFacility.reasonCode == "RECORD_UNAVAILABLE"
            found.clientLayer.features.length == 0
            found.editorShared.postalCode == "99951"
            !found.editorShared.permittedActions.includes("chooseLocation")
            found.otherCustomer.reasonCode == "RECORD_UNAVAILABLE"
            found.editorDisabled.reasonCode == "RECORD_UNAVAILABLE"
            found.ownerPrivate.postalCode == "99951"
            found.ownerPrivate.permittedActions.includes("chooseLocation")
            found.editorPrivate.reasonCode == "RECORD_UNAVAILABLE"
            found.room.error == ""
            found.room.geometry.coordinates[0] == 10.05
            found.outsiderRoom.reasonCode == "RECORD_UNAVAILABLE"
        }
    }
)

feature("an asset's point, an organization's own point and an address's point are saved with their provenance", {
    when() {
        const asset = as("mpl_editor", () =>
            save("AssetPlace", {assetId: "MPL_ASSET"}, "asset:MPL_ASSET:MPL_GP_ASSET", {longitude: 10.25, latitude: 10.25})
        )
        const customer = {partyId: "MPL_CUSTOMER"}
        const opened = as("mpl_editor", () => place("get", "PartyPlace", customer))
        const own = as("mpl_editor", () => save("PartyPlace", customer, opened.recordVersion, {longitude: 20, latitude: 30}))
        const located = as("mpl_editor", () => place("get", "PartyPlace", customer))
        const officeLink = find("mantle.party.contact.PartyContactMech", {
            partyId: "MPL_ORG",
            contactMechPurposeId: "PostalPrimary"
        }).one()
        const office = {contactMechId: officeLink.contactMechId}
        const before = as("mpl_setter", () => place("get", "PostalAddressPlace", office))
        const readerSave = as("mpl_reader", () => save("PostalAddressPlace", office, before.recordVersion))
        const addressSave = as("mpl_setter", () =>
            save("PostalAddressPlace", office, before.recordVersion, {longitude: -75, latitude: 40})
        )
        const officeRow = one("mantle.party.contact.PostalAddress", office)
        return {
            asset,
            assetRow: one("mantle.product.asset.Asset", {assetId: "MPL_ASSET"}),
            opened,
            own,
            located,
            points: find("mantle.party.PartyGeoPoint", customer).list().size(),
            readerSave,
            addressSave,
            officeRow,
            provenance: one("mantle.party.contact.GeoPointProvenance", {geoPointId: officeRow.geoPointId})
        }
    },
    then({asset, assetRow, opened, own, located, points, readerSave, addressSave, officeRow, provenance}) {
        asset.applied == true
        assetRow.geoPointId != "MPL_GP_ASSET"
        opened.geometry == null
        opened.permittedActions.includes("chooseLocation")
        own.applied == true
        located.geometry.coordinates[1] == 30
        located.precisionEnumId == "GPP_USER_CONFIRMED"
        points == 1
        readerSave.reasonCode == "PERMISSION_DENIED"
        addressSave.applied == true
        officeRow.geoPointId != null
        provenance.addressFingerprint != null
    }
})

feature(
    "postalCodeGeoId follows the code in place, keeps a value the caller gave, and a code the country refuses leaves it empty",
    {
        when() {
            return sys(() => {
                const id = address({facilityId: "MPL_FAC_ADDR", contactMechPurposeId: "PostalBilling", postalCode: "99952"})
                const row = () => one("mantle.party.contact.PostalAddress", {contactMechId: id})
                const unknown = row().postalCodeGeoId
                call("update#mantle.party.contact.PostalAddress", {contactMechId: id, postalCode: "99951"})
                const changed = row().postalCodeGeoId
                call("update#mantle.party.contact.PostalAddress", {contactMechId: id, postalCode: ""})
                const removed = row().postalCodeGeoId
                const given = address({
                    facilityId: "MPL_FAC_ADDR",
                    contactMechPurposeId: "PostalBilling",
                    postalCode: "99951",
                    postalCodeGeoId: "USA"
                })
                const refused = address({facilityId: "MPL_FAC_ADDR", contactMechPurposeId: "PostalBilling", postalCode: "ABC"})
                return {
                    unknown,
                    changed,
                    removed,
                    given: one("mantle.party.contact.PostalAddress", {contactMechId: given}).postalCodeGeoId,
                    refused: one("mantle.party.contact.PostalAddress", {contactMechId: refused})
                }
            })
        },
        then({unknown, changed, removed, given, refused}) {
            unknown == null
            changed == POSTAL_GEO
            removed == null
            given == "USA"
            refused.postalCode == "ABC"
            refused.postalCodeGeoId == null
        }
    }
)

feature(
    "a transaction's address is read only by a reader of the document, view only and linked to its party; a member who reads none, an unassigned representative, another organization's and an outside user are refused",
    {
        when() {
            const transaction = (username, recordKey, addressPurpose) =>
                as(username, () =>
                    place("get", "TransactionAddressPlace", recordKey, addressPurpose ? {addressPurpose} : {})
                )
            const order = {orderId: "MPL_ORDER"}
            const consumer = {orderId: "MPL_CONSUMER_ORDER"}
            return {
                order: transaction("mpl_salesrep", order),
                member: transaction("mpl_reader", order),
                outsider: transaction("mpl_outsider", order),
                client: transaction("mpl_client", order),
                otherOrder: transaction("mpl_salesrep", {orderId: "MPL_OTHER_ORDER"}),
                consumerAssigned: transaction("mpl_salesrep", consumer),
                consumerUnassigned: transaction("mpl_salesrep2", consumer),
                consumerMember: transaction("mpl_editor", consumer),
                destination: transaction("mpl_shipper", {shipmentId: "MPL_SHIPMENT"}),
                origin: transaction("mpl_shipper", {shipmentId: "MPL_SHIPMENT"}, "PostalShippingOrigin"),
                shipmentMember: transaction("mpl_reader", {shipmentId: "MPL_SHIPMENT"}),
                invoice: transaction("mpl_ar", {invoiceId: "MPL_INVOICE"}),
                invoiceMember: transaction("mpl_salesrep2", {invoiceId: "MPL_INVOICE"}),
                // through the framework: the adapter has no store service, so no Choose location
                framed: as(
                    "mpl_salesrep",
                    () =>
                        invoke("org.moqui.maps.MapServices.get#EffectiveConfig", {
                            adapterKey: "transactionAddress",
                            recordKey: JSON.stringify(order),
                            recordLayers: false
                        }).config || {}
                )
            }
        },
        then(r) {
            r.order.error == ""
            r.order.label == "8 Account Ave, 99951 Spec City, USA"
            r.order.postalCode == "99951"
            r.order.permittedActions.length == 1
            r.order.permittedActions[0] == "view"
            r.order.links.length == 1
            r.order.links[0].route == "partyDetail"
            r.order.links[0].parameters.partyId == "MPL_ACCOUNT"
            // a member of the organization with no read of the order: refused, with nothing of it
            r.member.reasonCode == "RECORD_UNAVAILABLE"
            r.member.label == null
            r.outsider.reasonCode == "RECORD_UNAVAILABLE"
            r.client.reasonCode == "RECORD_UNAVAILABLE"
            r.otherOrder.reasonCode == "RECORD_UNAVAILABLE"
            // a consumer's ship-to (their home): to the assigned representative, never to another or to a member
            r.consumerAssigned.label == "5 Consumer Court, 99951 Spec City, USA"
            r.consumerUnassigned.reasonCode == "RECORD_UNAVAILABLE"
            r.consumerMember.reasonCode == "RECORD_UNAVAILABLE"
            r.destination.postalCode == "99951"
            // the office's address (located by an earlier feature, so its point or its postal code)
            r.origin.label.startsWith("3 Office Road")
            r.shipmentMember.reasonCode == "RECORD_UNAVAILABLE"
            r.invoice.postalCode == "99951"
            !r.invoice.permittedActions.includes("chooseLocation")
            r.invoiceMember.reasonCode == "RECORD_UNAVAILABLE"
            r.framed.record.label == "8 Account Ave, 99951 Spec City, USA"
            !r.framed.record.permittedActions.includes("chooseLocation")
        }
    }
)

feature(
    "a Sales account editor may locate an account of their scope and its contact, not a shared one, another organization's or an address shared with an internal organization, nor without a Sales read; an HR reader reads, never locates, an employee's home address and not a person People does not admit",
    {
        when() {
            const party = (username, partyId, addressPurpose) =>
                as(username, () => place("get", "PartyPlace", {partyId}, addressPurpose ? {addressPurpose} : {}))
            return {
                holder: party("mpl_salesrep", "MPL_ACCOUNT"),
                contact: party("mpl_salesrep", "MPL_CONTACT", "PostalWork"),
                sharedRow: party("mpl_salesrep", "MPL_ACCOUNT", "PostalBilling"),
                nonHolder: party("mpl_reader", "MPL_ACCOUNT"),
                blind: party("mpl_salesblind", "MPL_ACCOUNT"),
                shared: party("mpl_salesrep", "MPL_SHARED"),
                otherAccount: party("mpl_salesrep", "MPL_OTHER_CUSTOMER"),
                internal: party("mpl_salesrep", "MPL_ORG"),
                hrHome: party("mpl_hrreader", "MPL_READER", "PostalHome"),
                hrFallback: party("mpl_hrreader", "MPL_READER"),
                hrWork: party("mpl_hrreader", "MPL_READER", "PostalWork"),
                hrConsumer: party("mpl_hrreader", "MPL_CONSUMER", "PostalHome"),
                salesHome: party("mpl_salesrep", "MPL_READER", "PostalHome")
            }
        },
        then(r) {
            r.holder.postalCode == "99951"
            r.holder.permittedActions.includes("chooseLocation")
            r.contact.postalCode == "99951"
            r.contact.permittedActions.includes("chooseLocation")
            // the billing address is also the organization's own: every party it is current for must allow the write
            r.sharedRow.postalCode == "99951"
            !r.sharedRow.permittedActions.includes("chooseLocation")
            r.nonHolder.postalCode == "99951"
            !r.nonHolder.permittedActions.includes("chooseLocation")
            !r.blind.permittedActions.includes("chooseLocation")
            r.shared.reasonCode == null
            !r.shared.permittedActions.includes("chooseLocation")
            r.otherAccount.reasonCode == "RECORD_UNAVAILABLE"
            !r.internal.permittedActions.includes("chooseLocation")
            r.hrHome.reasonCode == null
            r.hrHome.postalCode == "99951"
            !r.hrHome.permittedActions.includes("chooseLocation")
            // with no purpose asked for, the work address, never the home one
            r.hrFallback.recordVersion == r.hrWork.recordVersion
            r.hrFallback.recordVersion != r.hrHome.recordVersion
            // a person People's scope does not admit (a consumer, no employee): no home address for the HR reader
            r.hrConsumer.reasonCode == "RECORD_UNAVAILABLE"
            r.salesHome.reasonCode == "RECORD_UNAVAILABLE"
        }
    }
)
