# Map adapters

Mantle registers four record adapters with the framework's Maps
([docs/tools/Maps.md](https://github.com/moqui/mr-moqui/blob/master/docs/tools/Maps.md#record-adapters) in mr-moqui), so
the local-map dialog and record layers of any app show a postal address, a party, a facility or an asset where it is,
and let a user who may change the record choose its location. The services are `mantle.other.MapPlaceServices`
(`service/mantle/other/MapPlaceServices.xml`, logic in `MapPlaces.js`); the registrations are in
`data/10-seed/MapPlaces.xml`, their grants and `PARTY_LOCATION_EDIT` in `data/15-seed-initial/Access.xml`, the two record
layers in `data/15-seed-initial/MapLayers.xml`.

| Adapter key | recordKey | addressPurpose | Layer |
| --- | --- | --- | --- |
| `postalAddress` | `{contactMechId}` | narrows the parties and facilities it is read through | |
| `party` | `{partyId}` | a postal purpose (`PostalPrimary`, `PostalWork`, ...); empty for the party's own point, else its first readable address | |
| `facility` | `{facilityId}` | the address used when the facility has no point; empty for its primary one | `MANTLE_FACILITIES` |
| `asset` | `{assetId}` | | `MANTLE_ASSETS` |

An app opens the dialog with the key and the record's key fields as JSON, for example
`parameter-map="{adapterKey: 'facility', recordKey: JSON.stringify({facilityId})}"`, under its own route by the
thin-wrapper rule of Maps.md. A record layer is shown by asking for its layer ID (`layerIds`) or by adding it to a map
profile. Links in an answer are route keys the app resolves: `partyDetail`, `facilityDetail`, `assetDetail`.

## Who reads and who writes

Every service checks the caller itself, on every call; every user may call them (ALWAYS, not inherited), as the dialog's
own grants reach no service. A record that is not there and one the caller may not read are refused alike
(`RECORD_UNAVAILABLE`), with nothing of the record.

- **Party addresses and points.** The party and the owner of a personal contact read and write all of them. Anyone else
  needs organizations of their own (a user of none reaches no other party), and then reads a party within their reach, as
  Mantle's party filter (`MANTLE_USER_ORG`) has it: one of their organizations, or a party owned by `_NA_` or by one of
  theirs; an internal organization, a unit under one (a department) and their staff only under one of the user's
  top-level organizations (`PrtOrgRollup` roots, as `PartyReach.js` reads them); never a disabled party or another user's
  personal contact. Of such a party they read only its business addresses: an organization's but its home address, and a person's work address alone. A
  readable party is not a readable home address. A party's own point (`PartyGeoPoint`) is an organization's business
  place and a person's private one. Choosing those locations needs `PARTY_LOCATION_EDIT` and a party of the user's
  organizations.
- **Facilities:** read in the user's facility scope (`FacilityScope.js`); located with `FACILITY_EDIT` there.
- **Assets:** read in the stock scope (`StockScope.js`: its owner's or its facility's owner's organization); located with
  `MAINTENANCE_RESOURCE_EDIT` or `FACILITY_EDIT` there.
- An outside user (the framework's `EXTERNAL_USER`, or `PROJECT_CLIENT`) reads only its own and its personal contacts'
  places.
- `PARTY_LOCATION_EDIT` is granted to no group: a system administrator passes Mantle's permission checks without one.

## Places, saves and provenance

A place is the record's own point; an asset with none is where its facility is. An address with no point (or with a
point chosen for an earlier form of it) answers its postal code and country, from which the framework shows the code's
local postal-area position labeled approximate; that position is never written to the address. Choose location makes a
new `GeoPoint` (`GPT_RECORD_LOCATION`, data source `MANTLE_MAP_CHOICE`) with a `GeoPointProvenance` row (precision, who,
when, and for an address the fingerprint of the address it was chosen for), and points the record at it; a point another
record shares is never changed. Mantle's address update keeps the point on the new address, so a changed address no
longer matches its point's fingerprint and the point is not shown. `recordVersion` names the record, its point and an
address's fingerprint: a save of an older one is `STALE_VERSION`. A postal-area or place estimate is refused as an
address's point (`PRECISION_REFUSED`) and over a facility's or asset's recorded point (`POINT_RECORDED`); no other
precision than user-confirmed is a user's to claim (`PRECISION_INVALID`). The version is checked again with the record's
row locked before the write. Any failure that is not one of these refusals is logged and fails the call with no text of
its own.

The point a record had before a save is left as it was, since other records may share it (Mantle's address update copies
it to the new address): an unshared old point stays as an unreferenced `GeoPoint` row. A point recorded before these
adapters has no provenance row: it is shown as a recorded location of unknown precision.

A postal address's `postalCodeGeoId` (read by sales tax, checkout and segments) is set when the address is created with a
code and country, or its code or country changes in place (`entity/PostalAddressGeo.eecas.xml`): the code's Geo,
`GeoPostalCode` read directly by the country and the code as the framework's `normalize#PostalCode` reads it (a pure
function, no transaction), so no lookup service runs inside the address's write. A value the caller gave is kept unless it
is the postal-code Geo of another code (as the clone of `update#PartyPostalAddress` carries), which is replaced or cleared;
removing the code or country clears a postal-code Geo. A failure is logged and leaves the address as it was given. A code
of a US territory filed among the US codes is not looked up there, as `get#PostalLocation` does.

`service/mantle/ext/party/GooglePartyServices.xml` is superseded by the framework's geocoder provider interface and kept
only for an installation that called it.

## Tests

`test/other/MapPlaces.spec.js` (`./moq test mr-mantle --spec MapPlaces`): a holder's place and Choose location, a reader
and another organization's record, also through the framework's `get#EffectiveConfig`; a reader's save, a stale version
and a saved point's provenance; the postal fallback and `postalCodeGeoId`; home and work addresses; a changed address;
the bounded, organization-scoped layers (an ownerless room, the antimeridian); a user of no organization, an outside user,
a disabled party, another organization's customer and a personal contact; asset, party-point and address saves; and the
`postalCodeGeoId` update paths.
