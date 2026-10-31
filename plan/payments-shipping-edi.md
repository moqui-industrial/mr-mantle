# Payments, shipping, and EDI

Initial summary, to expand later. Business integrations live in `mr-mantle`. Each one implements the existing Mantle service interfaces and is written to the provider's current spec. Certification, the first live account, and any carrier or processor validation before go-live stay with the deployment.

`mr-mantle` integrations do not depend on client SDKs. Calls are XML or JSON over HTTP, or EDI over SFTP, using the framework HTTP client and the SFTP tooling.

## What is already in place

`mr-mantle` has the extension points and the in-house money and shipment flows. It does not yet call an outside processor, carrier, or EDI broker.

- **Payments.** `PaymentGatewayConfig` names the authorize, capture, release, refund, and details services. `authorize#SinglePayment`, `capture#SinglePayment`, `release#SinglePayment`, and `refund#SinglePayment` call those services and record `PaymentGatewayResponse`, including the reviewed-action path and its operation key. The only configured gateway is the test one (`PaymentTestServices`). ACH files (NACHA), positive pay, and bank returns are separate from card gateways and stay as they are.
- **Shipping.** `ShippingGatewayConfig` names the rate, label, track, refund-label, and address-validation services on `mantle.shipment.CarrierServices`. The local gateway (`ShGtwyLocal`) is the one that ships with Mantle.
- **EDI parse and build.** Framework `EdiHandler` (`crates/moqui-core/src/edi.rs`) reads and writes X12 and EDIFACT, including the 997 functional-acknowledgement segments. The Java `mantle-edi` transaction services are not in `mr-mantle` yet.
- **Message bus.** SystemMessage produce, queue, send, and consume is the path for outbound documents and inbound webhooks, the same way the Java components did.

## Moqui group

Checked out under `~/work/moquiwork/moqui/runtime/component/` unless noted. Versions are the ones in the Java runtime `addons.xml`. The GitHub `moqui` org has no other payment, carrier, or EDI repository.

| Repo | Version | Wire | For mr-mantle |
| --- | --- | --- | --- |
| AuthorizeDotNet | 1.2.5 | AIM name/value posts to `transact.dll`; CIM is XML to `api.authorize.net/xml/v1/request.api` | Bring over, on the current API |
| mantle-paytrace | 1.0.3 | JSON REST to `api.paytrace.com`, including level 2/3 | Bring over |
| mantle-braintree | 2.0.0, at `~/work/moquiwork/mantle-braintree` | Official Java SDK (`com.braintreegateway`) | Leave until a text HTTP port exists |
| mantle-shippo | 1.2.0 | JSON to `api.goshippo.com`, header `Shippo-API-Version: 2018-02-08` | Bring over and catch up to the current reference |
| mantle-rsis | no release | Rock Solid Internet Shipping Core REST. Three commits, same gateway shape as Shippo | Note only |
| mantle-edi | 1.1.5 | X12 through SystemMessage. The component itself has no SFTP or AS2 client | Bring the transaction services into mr-mantle |
| mantle-oagis | no release | Planning only | Out of this pass |
| mantle-yotpo | | Reviews | Out of this pass |

`coarchy/stripe` is on the Java `all-working` set and is not a moqui-org repo. An older third-party `mantle-stripe` talks to Stripe through the Java SDK. Neither is a source to copy.

Apache OFBiz had direct UPS, USPS, FedEx, and DHL shipment services as XML or SOAP posts. OFBiz removed them in 2026 (OFBIZ-7935) because those carrier APIs are retired. Moqui never had the direct carrier services. A new port uses each carrier's current REST API.

## Payments

Each processor is a `PaymentGatewayConfig` type: an enumeration, a config entity keyed by `paymentGatewayConfigId`, and services that implement `authorize#Payment`, `capture#Payment`, `release#Payment`, `refund#Payment`, and `get#PaymentGatewayDetails`. Card numbers stay in the browser. The server receives a token or a customer-profile id. Server code posts XML or JSON.

**Bring over first**

- **Authorize.Net**, on the current API (`https://api.authorize.net/xml/v1/request.api`, JSON or XML). AIM name/value (`x_` fields to `transact.dll`) is deprecated and gets no new features. The old AIM XML transaction requests were folded into this API. CIM customer profiles map to the same API's customer-profile methods. Browser card entry uses Accept.js (a hosted script in the template library) or Accept Hosted. Operations: auth, capture, auth-and-capture, void, refund, and profile create and delete.
- **PayTrace.** The Java component is already JSON (`v1` on `api.paytrace.com`), with vaulted methods and level 2/3 line data. That level 2/3 data matters for B2B card acceptance. Port the services and re-check the current developer reference before calling it done.

**Add next**

In the order a new store usually asks:

1. **Stripe.** Form posts to `api.stripe.com`. PaymentIntents (auth and capture), customers and payment methods, refunds, and signed webhooks. The browser side is Stripe.js / Payment Element, as a template. This is the processor new deployments ask for. There is no moqui-org implementation to migrate.
2. **PayPal Orders v2.** JSON REST for checkout and capture. Covers the PayPal button. Braintree waits; the Java add-on depends on the Braintree SDK.
3. **NMI (Network Merchants).** Direct Post / Payment API, name-value or JSON. A common ISO gateway in front of many processors, for merchants who are not on Stripe or Authorize.Net.
4. **Square Payments API.** JSON REST. Useful when the same merchant also sells in person.
5. **Adyen Checkout API.** JSON REST. The one to add when a deployment needs cards outside the US.
6. **GoCardless.** JSON REST for bank debit (ACH, SEPA, Bacs). Sits beside the NACHA file path for merchants who want an API debit.

Leave until a deployment asks: Braintree over its HTTP API, Cybersource REST, Worldpay Access, Elavon Converge, Heartland. Each has a text API. None is the next default.

## Website templates

`mr-mantle` holds a small library of front-end examples: one card form per processor that tokenizes in the browser and then calls the Mantle payment services with the token. They show the fields, the hosted script, and the service call.

Working screens are separate and come later:

- `mr-boss` for CSR and internal use (take a payment, capture, refund, store a method on an account).
- `mr-pass` for public checkout.

## Shipping

A `ShippingGatewayConfig` points at `get#OrderShippingRate`, `get#ShippingRatesBulk`, `get#ShippingRate`, `request#ShippingLabels`, `refund#ShippingLabels`, `track#ShippingLabels`, and `validate#ShippingPostalAddress`.

**Shippo.** Port `mantle-shippo`. It is JSON to `api.goshippo.com` with `Authorization: ShippoToken` and `Shippo-API-Version: 2018-02-08`. That version date is still the current API contract. Shippo adds fields and endpoints under it; the reference was still moving in 2026. The Java component covers addresses, shipments and rates, label purchase, refunds, and tracking, plus a tracking webhook added in 1.1.0. Catch up while porting: returns, batches, manifests, customs declarations, and the 2026 customs fields (EU product identifiers such as `manufacturer_code`). Carrier accounts stay configuration, as in the demo data.

`mantle-rsis` is a second multi-carrier REST gateway with the same shape and almost no history. It stays a note unless a deployment is already on Rock Solid.

**Direct carriers.** New work, against the current REST APIs. OAuth2 client-credentials, then JSON.

| Carrier | Current API | First operations |
| --- | --- | --- |
| USPS | REST JSON, OAuth2. Web Tools retired 2026-01-25 | Domestic prices, labels, tracking, address validation. International labels after domestic works |
| UPS | REST JSON, OAuth2. Legacy access-key XML is deprecated | Rating, shipping, tracking, address validation |
| FedEx | REST JSON, OAuth2. SOAP Web Services retired 2026-06-01 | Rate, ship, track, address validation |
| DHL Express | MyDHL API, REST JSON. ShipIT XML is obsolete | Rates, shipments, tracking. First international carrier |

Later, if a deployment needs them: Canada Post, Purolator, Royal Mail, Australia Post. An EU aggregator such as Sendcloud only if Shippo's EU coverage is not enough.

Each direct carrier needs the merchant's own account and the carrier's label approval. That validation stays with the deployment. Services are written to the published spec and covered by recorded HTTP fixtures. A live label call is a manual check.

## EDI

Bring `mantle-edi` into `mr-mantle`. The Java component is SystemMessage services over the EDI handler, X12 4010:

- Receive 850 purchase order, and create a sales order
- Send 855 purchase order acknowledgement
- Send 856 ship notice
- Send 810 invoice
- Receive and send 997 functional acknowledgement

Envelope and transaction-set structure files move with the services. Parsing uses the Rust `EdiHandler`. Transport is separate from the transaction services. Outbound files go by SFTP with the framework SFTP client. Inbound files are polled the same way, or posted to the SystemMessage receive endpoint. AS2 is a later transport when a partner requires it.

**SPS Commerce** is the vendored retail broker. It is the network smaller brand-manufacturers use to sell into retail chains, and the 850/855/856/810/997 set is the set those retailers require. The vendored piece is one connection profile: remote ids, that document set, SFTP as the transport, and a sample partner map. Retailers differ in segments and codes. The profile is the common path, and a deployment still maps the odd partner.

**Orderful** is the REST broker. It is the JSON API in front of X12 that showed up for developers who did not want a VAN, which matches the broker remembered from a few years back. The integration posts and receives the same four documents as JSON, and Orderful translates to the retailer's X12. Stedi is the other current REST-native option and is the fallback if Orderful's API is a poor fit when this is expanded. SPS also has a JSON transactions API; use that if a single vendor should cover both the file path and the API path. TrueCommerce, DiCentral, and Cleo stay off the list until a deployment is already on one of them.

## Order of work

1. Authorize.Net on the current JSON or XML API, plus the Accept.js example.
2. Stripe, plus the Payment Element example.
3. PayTrace, including level 2/3.
4. Shippo, caught up to the current `2018-02-08` reference.
5. `mantle-edi` transaction services inside `mr-mantle`, with SFTP send and receive.
6. SPS Commerce profile on that EDI path.
7. Orderful REST on the same documents.
8. Direct carriers: UPS, USPS, FedEx, then DHL Express.
9. PayPal, then NMI, Square, Adyen, or GoCardless as deployments ask.
10. `mr-boss` and `mr-pass` screens that call these services.

## Left for the expansion

Partner-specific X12 maps beyond the SPS sample, AS2, live certification scripts, tax services, and the `mr-boss` / `mr-pass` screen designs.
