# Shippo shipping gateway

Mantle's Shippo gateway: `service/mantle/shipment/carrier/ShippoServices.xml` and `Shippo.js`, on the carrier interfaces
of `CarrierServices.xml` (rates, labels, label lookup, refunds, tracking, address validation). It uses the Shippo REST
API with the framework HTTP client, no SDK, and sends `Shippo-API-Version: 2018-02-08` on every request (the contract it
was written against; an account's default version may be newer). It was ported from the Java Moqui
[mantle-shippo](https://github.com/moqui/mantle-shippo/tree/2356f07) component (1.2.1, `2356f07`). The plan and its
implementation record are [plan/payments-shipping-edi.md](../plan/payments-shipping-edi.md) (S1).

## Configuration

| Record | What goes there |
| --- | --- |
| `ShippingGatewayConfig` | `shippingGatewayTypeEnumId` `ShGtwyShippo`, the `mantle.shipment.carrier.ShippoServices` service names (`get#ShippingRatesBulk`, `get#OrderShippingRate`, `get#ShippingRate`, `request#`, `find#`, `refund#`, `track#ShippingLabels`, `validate#ShippingPostalAddress`), `systemMessageRemoteId`, and `testMode` Y for a test token |
| `SystemMessageRemote` | `sendUrl` `https://api.goshippo.com`, `usageCode` `T` (test token) or `P` (live token), `password` the API token, `sharedSecret` the webhook secret, `messageAuthEnumId` `SmatHmacSha256Timestamp` with `authHeaderName` `Shippo-Auth-Signature`, or `SmatUrlToken` with `authHeaderName` `token` (or empty; see Webhooks). The secrets are encrypted fields |
| `ShippingGatewayCarrier` | Per carrier party, `gatewayAccountId` the Shippo carrier account `object_id` (`GET /carrier_accounts`) |
| `ShippingGatewayMethod`, `CarrierShipmentMethod` | `gatewayServiceCode` the Shippo service level token (the gateway's row overrides the carrier method's) |
| `ShippingGatewayBoxType`, `ShipmentBoxType` | `gatewayBoxId` a Shippo parcel template; box dimensions and their unit, or a template, are required |
| `ShippingGatewayOption` | `SgoLabelType` (Shippo `label_file_type`, `PDF_4x6` by default), `SgoLookupGraceSeconds` (300 by default). An `SgoApiToken` option is ignored with a warning: the token is never an option |

`data/ShippoDemoData.xml` names a test gateway `SHIPPO_DEMO` and remote `ShippoSandbox` without credentials, and
`data/ShippoSetupData.xml` the `ShippoWebhook` message type. Enter the token and secret in the System Message Remote
screen or a deployment's own data file, never in seed data.

## Labels

- **Durable attempts.** Labels are bought through `WarehouseTaskServices.request#PackageLabels` (and refunded through
  `refund#PackageLabels`), which record each package's `ShippingGatewayRequest` before calling the gateway, one
  package per transaction; `CarrierServices.request#ShipmentLabels` alone records nothing. A package that fails leaves
  the others' labels.
- **One purchase per package.** Each package is its own Shippo shipment (Shippo's multi-parcel shipments are multi-piece
  shipments only some carriers take): rated fresh, the rate of the method's service level and carrier account recorded on
  the package (`gatewayRateId`, `gatewayShipmentId`, `gatewayStatus` RATED), then bought synchronously with
  `metadata` `mantle <request id> <shipment>/<segment>/<package>` and the gateway's label type. Return labels use
  `extra.is_return` from the return address (the segment's, else the store's) and fill the `return*` fields.
- **Recorded.** `gatewayLabelId` (the transaction), `gatewayRateId`, `gatewayShipmentId`, `labelFileType`, `labelUrl`
  and the downloaded `labelImage`, `trackingCode`, `trackingUrl`, the charge in `estimatedAmount`, `baseAmount`,
  `actualAmount` and its currency in `gatewayAmountUomId` (also on the request). Insurance follows Mantle's insurance
  rules in the shipment's cost currency.
- **Asynchronous and lost answers.** A QUEUED or WAITING transaction answers pending: the request stays Unknown with
  `LABEL_PENDING`. Shippo has no idempotency key for transactions, so a purchase whose answer is lost (or a transaction
  status the adapter does not know) is Unknown too (`CARRIER_TIMEOUT`, `CARRIER_NO_ANSWER`). Either is resolved by
  `find#ShippingLabels`, never by buying again: the transaction is found by the package's rate
  (`GET /transactions?rate=`), else among those created since the request was first sent, by its metadata. One not found
  is pending while the request's first attempt (`firstSentDate`, which retries do not move) is younger than
  `SgoLookupGraceSeconds`; after that it is reported not found, and a person's next request buys.
- **Refusals** (nothing bought, the request Failed): `CONFIG_INVALID`, `PARCEL_INVALID`, `ADDRESS_INVALID`,
  `METHOD_UNAVAILABLE` (no rate for the service), `RATE_EXPIRED`, `LABEL_REFUSED`, `RATE_LIMITED`, `RATES_NO_ANSWER`.
- **Label files.** A label link that does not answer is asked for again (`GET /transactions/{id}` gives a fresh one);
  a label still not downloaded keeps its link, and tracking downloads it later. Printing uses `labelImage`
  (`mantle.facility.PrintServices.dispatch#Document`, `documentType` `shipmentLabel` or `returnLabel`).
- **Refunds.** `POST /refunds`: SUCCESS sets `gatewayRefundStatus` refunded; QUEUED or PENDING keeps `gatewayRefundId`
  and answers pending, read again later (`GET /refunds/{id}`); a refused refund is `REFUND_REFUSED` unless the label's
  transaction is already refunded.
- **Finishing pending requests.** The ServiceJob `finish_PendingLabelRequests` (paused by default) runs
  `WarehouseTaskServices.finish#PendingLabelRequests`: each request Unknown with `LABEL_PENDING`, `CARRIER_TIMEOUT` or
  `CARRIER_NO_ANSWER`, first sent within `maxAgeDays`, is run again as the user who made it (refused,
  `USER_UNAVAILABLE`, when that user cannot sign in), lookup only: it asks Shippo and never buys. A label Shippo has no
  record of ends Unknown with `NOT_FOUND`, which the job leaves for a person to request again. The transaction webhook
  does the same for its request. The service signs in as each request's user and out again, so it runs only outside a
  web request (the job and the webhook's consume, on a worker thread); a web caller is refused (`NOT_ALLOWED`).

## Tracking and webhooks

`track#ShippingLabels` reads each labelled package's transaction (`tracking_status`, `tracking_number`, `eta`) and maps
UNKNOWN and PRE_TRANSIT to `ShTsUnknown`, TRANSIT, DELIVERED, RETURNED and FAILURE to their `ShTs*`; Mantle's
`ShipmentPackageDeliveredCheckShipment` delivers a shipment whose packages are all delivered.

A Shippo webhook (`transaction_created`, `transaction_updated`, `track_updated`) posts to
`/rest/sm/ShippoWebhook/{systemMessageRemoteId}`. The remote authenticates it before anything is kept:

- **HMAC** (`SmatHmacSha256Timestamp`, header `Shippo-Auth-Signature: t=<seconds>,v1=<hex>`, HMAC-SHA256 of
  `<t>.<body>`, a five minute window and a replay cache). Shippo enables HMAC through its team (up to ten business days).
- **URL token** (`SmatUrlToken`, `authHeaderName` `token` or empty: it names the query parameter, so the HMAC header
  name left there refuses every delivery): the webhook URL Shippo is given ends in `?token=<sharedSecret>`. Use a
  URL-safe token (letters, digits, `-`, `_`; a `+` decodes to a space). The token travels in the URL, so keep it out of
  proxy logs.

Shippo's sending addresses can also be allowed at the network edge; that is a deployment setting, not checked here. A
remote with neither scheme is refused (`WEBHOOK_UNAUTHENTICATED`). A signed delivery whose message is not kept (a 500)
gives its replay key back, so Shippo's retry is taken. An event is kept once per remote and body (Shippo sends no event
id). Consuming it never applies the payload as it is: the package is found with the gateway the label flow used (its
latest gateway request's, else the store's or the segment's), its pending request is finished through
`find#ShippingLabels`, or its tracking is read from its transaction. An event whose `test` flag differs from the remote's
`usageCode` is ignored; one with no `test` flag is consumed, as consuming only reads the account's own state. Polling
(`track#PackageLabels`, the job) works without webhooks.

The events are SystemMessages: their bodies hold addresses and tracking (a `track_updated` event names the
destination's city and postal code). Remove consumed `ShippoWebhook` messages on the deployment's SystemMessage
retention schedule; Mantle keeps no copy of them elsewhere.
