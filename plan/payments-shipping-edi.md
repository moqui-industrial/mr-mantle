# Payments, shipping, and EDI implementation plan

Research baseline: 2026-10-31. This is the high-level plan for external business integrations in `mr-mantle`.
The migration work is scoped here; larger additions get a focused design and implementation plan when scheduled.
Provider references describe the researched contracts, not a guarantee that an account has those capabilities.
Recheck the relevant contract and changelog when starting each adapter.

## 1. Scope and decisions

- **First ports:** Authorize.Net, PayTrace, Shippo, and the `mantle-edi` X12 transaction services. Reuse the business
  mappings and Mantle interfaces, updating the wire protocol and filling the identified gaps as part of each port.
- **First EDI provider:** plan for **SPS Commerce**, with one supplier-to-retailer order-to-cash connection. This is
  the recommended implementation target, subject to confirming account access and the document contract before
  coding the SPS adapter. Orderful and the other providers are future candidates, not initial deliverables.
- **Next new payment integration:** Stripe. Its checkout/session and asynchronous lifecycle design gets a separate
  plan. PayPal follows when public checkout needs it; other processors and direct carriers are demand-driven.
- **Ownership:** provider configuration, mappings, services, message processing and specs belong in `mr-mantle`;
  reusable HTTP, SFTP, cryptography and EDI parsing belong in the framework. BOSS, PASS and Marble use those services
  for their workflows. Mantle must remain usable without any of those apps.
- **Dependencies:** no provider server SDKs. Use the framework HTTP client for JSON, XML, form data or GraphQL over
  HTTPS, and the existing SFTP services for files. Provider-hosted browser libraries/fields are allowed and are part
  of tokenization or checkout, not a server dependency.
- **Boundaries:** retain the local financial-account gateway, NACHA, positive-pay and bank-return flows. Subscriptions,
  marketplace payouts, automated dispute management, tax services, freight/TMS and general EDI mapping software are
  outside the initial scope. Provider settlement/fee reconciliation is a later accounting integration, distinct from
  checking the status of a payment transaction.

## 2. Starting point and migration sources

### Existing MR Moqui functionality

| Area | Reuse | Gaps relevant to this plan |
| --- | --- | --- |
| Payments | [`PaymentServices.xml`](../service/mantle/account/PaymentServices.xml): gateway interfaces, `*#SinglePayment`, reviewed actions, response history, refund limits and details polling. [`AccountingAccountEntities.xml`](../entity/AccountingAccountEntities.xml) defines the gateway and response entities. | No external processor implementation. `operationKey` is checked by the outer services and attached after the provider call; it is not passed through the gateway interfaces. Local response replay alone cannot recover a remote success followed by a timeout or local rollback. |
| Payment methods and hosted payment | [`PaymentMethodServices.xml`](../service/mantle/account/PaymentMethodServices.xml), organization bindings and portal records in [`AccountingPortalEntities.xml`](../entity/AccountingPortalEntities.xml); authorization already accepts `returnUrl`, and responses can contain `redirectUrl`. [`PaymentTestServices.xml`](../service/mantle/account/PaymentTestServices.xml) exercises pending and hosted outcomes. | Reuse these pending/lookup paths. Define token/session inputs and provider object references; extend only where the real provider lifecycle needs more information. A browser return is not proof of payment. |
| Shipping | [`CarrierServices.xml`](../service/mantle/shipment/CarrierServices.xml) and [`ShipmentEntities.xml`](../entity/ShipmentEntities.xml): gateway routing, rates, labels, refunds, tracking, address validation, carrier/service/box mappings and the local rate gateway. | No external carrier adapter. Define durable purchase/refund attempts and pending label completion. Review `get#AutoPackageInfo` separately; a rate adapter does not supply a packing algorithm. |
| EDI parsing | Framework [`edi.rs`](../../../../crates/moqui-core/src/edi.rs), the [`EdiHandler` script binding](../../../../crates/moqui-core/src/script/runtime/edi.rs), and converted X12 grammar fixtures in `crates/moqui-core/src/edi/testdata/mantle`. X12 and EDIFACT parsing/writing are available. | Mantle transaction services are missing. The grammar loader currently ignores `MIN`/`MAX`; successful parsing is not full X12 or partner-guide validation. EDIFACT business mappings are not supplied by having an EDIFACT parser. |
| Messaging and transport | Framework [`SystemMessageServices.xml`](../../../base-component/framework/service/org/moqui/impl/SystemMessageServices.xml), message types/remotes, error history and jobs; [`SftpMessageServices.xml`](../../../base-component/framework/service/org/moqui/sftp/SftpMessageServices.xml) already sends and polls files. | Configure and harden these paths rather than build a second queue or SFTP client. The current [SFTP poller](../../../../crates/moqui-core/src/service/system_sync/sftp.rs) stops on a receive error and propagates some file errors out of its loop. Per-file isolation and recovery need attention. |

The framework already has System Message administration screens. Start there for inspection/retry; add business-facing
exception views only where operators need order, invoice, shipment or payment context.

### Sources actually inspected

Versions below are from each checked-out `component.xml`, with the inspected commit. These are migration baselines,
not assertions about the latest upstream release. Preserve attribution/license headers and record the source commit
in the implementation record.

| Source | Baseline | Useful migration material | Required change |
| --- | --- | --- | --- |
| [AuthorizeDotNet](https://github.com/moqui/AuthorizeDotNet/tree/eaa351c) | 1.2.5 / `eaa351c` | AIM/CIM payment operations, profiles, configuration and response mapping | Replace AIM name/value requests; retain useful profile mapping on the current API. Replace raw-card submission with browser tokenization or hosted checkout. |
| [mantle-paytrace](https://github.com/moqui/mantle-paytrace/tree/5dbe616) | 1.0.3 / `5dbe616` | Vault operations, authorize/capture/void/refund/details, level 2/3 data | The source defaults to v1; current documentation specifies v3. Reconcile schemas, authentication and hosted-field tokens instead of only translating Groovy. |
| [mantle-shippo](https://github.com/moqui/mantle-shippo/tree/2356f07) | 1.2.1 / `2356f07` | Rate/address/parcel mappings, labels, refunds and tracking webhook | Retain useful mappings; add authenticated callbacks, durable attempts and current response handling. Remove full webhook/context logging. |
| [mantle-edi](https://github.com/moqui/mantle-edi/tree/134acb6) | 1.1.5 / `134acb6` | X12 4010 envelope and 850/855/856/810/997 structures and business services | Port XML/Groovy to XML/JavaScript, update component locations, and address batching, validation and partner-mapping gaps below. |

The old Braintree integration is SDK-based; its supported HTTP GraphQL API provides a future rewrite path (section 4).
Other old or third-party adapters remain reference material unless a specific migration needs them.

## 3. Common implementation contract

Apply this checklist to each port. It does not call for a new generic integration platform.

1. **Configuration and capabilities.** Use the existing gateway/type/remote records. Separate test and production,
   merchant/organization ownership, endpoints, version, supported operations and carrier/partner identifiers. Credentials
   use protected configuration or encrypted credential fields (as `SystemMessageRemote` already does), never seed-data
   secrets or an unencrypted shipping option. Do not advertise an operation the account cannot perform.
2. **Durable operation identity.** Assign an operation key before an external mutation, bind it to the organization,
   gateway, operation and input fingerprint, and pass it to the adapter. Use provider idempotency where available;
   otherwise retain a searchable provider reference and a reconciliation path. A lost response means **unknown outcome**,
   not a fresh charge, refund, label purchase or EDI submission. Reject changed inputs under the same key and cover
   concurrent calls and success followed by local failure. Separate durable attempt recording from long database locks.
3. **Business state.** Keep payment, order, invoice and shipment changes in existing Mantle services so validation,
   applications and accounting SECAs still run. Distinguish accepted requests, pending work and completed effects.
   Authorization, capture, processor settlement and merchant payout are separate events.
   Use decimal/currency-aware conversions; provider minor-unit integers are not universally two decimal places.
4. **Inbound delivery.** Authenticate the provider-specific endpoint before accepting data. Verify signatures over the
   original body where required; bind the endpoint to its configured account rather than trusting a payload account id.
   Persist a deduplicated receipt before returning success, then consume through SystemMessage. Duplicate, delayed and
   out-of-order events must converge on provider state without repeating business effects. Keep a details lookup or
   poll path for missed events.
5. **Failure handling.** Bound timeouts and retries, respect rate limits, and separate retryable transport failures from
   business refusals. Record the affected operation/file/document and continue with independent items. Stop when the
   connection or input cannot be trusted, or continuing could corrupt data. Provide an operator retry/reconcile action
   that preserves identity; do not turn a pending result into success to clear the queue.
6. **Evidence and retention.** Retain sanitized request/response facts, external ids, timestamps, attempts and errors.
   Payment logs/messages must exclude PAN, CVV, secrets and browser client secrets. Restrict access and retention for
   EDI payloads, addresses and labels; retain exact EDI bytes where needed for diagnosis and replay. Configuration and
   retry actions need the existing organization/permission checks.

Before the first payment adapter, make the small common changes needed for operation identity and token input.
If durable recovery or new asynchronous states require a substantial redesign, write a focused payment-lifecycle plan
then; do not hide it in a processor port or rebuild the existing pending/details services.

## 4. Payments

### P1 — Authorize.Net: port and modernize

Use the current JSON or XML API for transactions and customer profiles. AIM's `x_` name/value protocol is deprecated;
the former AIM XML methods are part of the current API. See the [upgrade guide](https://developer.authorize.net/api/upgrade_guide.html)
and [API reference](https://developer.authorize.net/api/reference/index.html).

Deliver authorization, capture, sale/auth-and-capture, release/void, linked full/partial refund, details lookup and
customer/payment-profile create/use/delete. Map settlement-dependent void/refund behavior explicitly. Do not treat
duplicate-window checks as durable idempotency or enable unlinked credits as the default refund path.

Add a reusable browser example using [Accept.js hosted payment UI](https://developer.authorize.net/api/reference/features/acceptjs.html)
to submit opaque payment data; document [Accept Hosted](https://developer.authorize.net/api/reference/features/accept-hosted.html)
as the hosted-checkout alternative. Persist reusable profile references and safe display metadata, not a single-use
opaque value as a permanent payment method. Authenticate [webhooks](https://developer.authorize.net/api/reference/features/webhooks.html)
and reconcile transaction details through the common receipt/lookup path.

**Done when:** fixtures cover approval, decline, held/pending outcome, capture, void, settled refund, profile use,
duplicate callback and an uncertain response; status and refund accounting stay correct through the existing services.
The example proves no card details reach Mantle's request, entity, message or log paths.

### P2 — PayTrace: port with API-version upgrade

The [current North/PayTrace B2B guide](https://developer.north.com/b2b/integration-guide) specifies JSON API v3,
OAuth authentication, distinct sandbox/production endpoints, an integrator id and Protect.js hosted fields.
Treat the inspected v1 services as business-mapping input to a v3 port. Obtain its OpenAPI schema and verify the
supported authentication grant and account permissions during implementation.

Deliver vaulted payment methods, authorize/capture/sale/void/refund/details and a Protect.js tokenization example.
Preserve the source's B2B level 2/3 mapping: customer/PO references, tax, freight, discounts, quantities, units and
commodity/item data. Match submission timing and validation to v3; a card approval and acceptance of enhanced data
are separate outcomes. Use supported response codes, and preserve a successful payment if later enhanced-data
submission fails.

**Done when:** gateway lifecycle fixtures pass, expired credentials recover safely, and invoice/order lines map to
enhanced-data requests with correct totals. Rejected enhanced data is visible and recoverable without charging again.
Sandbox/integrator access is an external prerequisite, not evidence that the port is already certified.

### P3 — Stripe: next new adapter, separate plan

Design the relationship between Mantle Payment, the browser session, PaymentIntent, reusable PaymentMethod and any
SetupIntent before coding. Stripe's current [PaymentIntents guide](https://docs.stripe.com/payments/payment-intents)
recommends Checkout Sessions with Payment Element for most checkout integrations, while PaymentIntents support custom
lifecycles. Compare those browser flows against Mantle-owned order totals and invoice payments; do not assume that
“Payment Element” selects the server API or transfers pricing ownership to Stripe.

Initial scope: cards, one-time payments, authorization/capture, cancellation, partial/full refunds, optional saved
methods, details lookup and authenticated callbacks. Plan for customer authentication/3DS, abandonment, pending results
and authorization expiry. Limit partial/multiple capture to the capability enabled for the account; see [capture](https://docs.stripe.com/api/payment_intents/capture).
Pin a supported stable API version and webhook payload contract, use [idempotent requests](https://docs.stripe.com/api/idempotent_requests),
and handle duplicates and ordering per the [webhook guide](https://docs.stripe.com/webhooks).

The separate plan must include restart/timeout reconciliation and the browser-to-server completion contract. Connect,
subscriptions, broad local-payment-method support and payout reconciliation are later work.
The adapter goes beside the others in `service/mantle/ext/account/gateway/` (`mantle.ext.account.gateway.StripeServices`).

### Browser examples and application adoption

Keep small reusable tokenization/hosted-payment examples in Mantle, with only public browser configuration and scoped
session/token endpoints. The server chooses organization, gateway, amount, currency, allowed return URL and payment
ownership; a browser cannot select arbitrary payments or trust its own “paid” result. Use provider-hosted scripts from
their documented origin. A saved method needs an explicit consent/use policy.

Extend the existing internal payment actions and hosted invoice-payment hooks when connecting BOSS/Marble/PASS.
Public checkout, saved-method management and CSR collection screens get their own app plan where needed; do not postpone
provider completion endpoints until that UI work. TUI can support lookup, capture/refund and a hosted-payment link;
it must not introduce raw card entry to imitate an embedded browser form.

### Later payment candidates

| Candidate | Reason to schedule it | Integration direction |
| --- | --- | --- |
| PayPal | Public checkout needs a PayPal wallet option | [Orders v2](https://developer.paypal.com/api/orders/v2), buyer approval and the Payments API for subsequent capture/refund operations; reuse the asynchronous receipt model. |
| NMI | A deployment's merchant/processor relationship | Current docs direct new integrations to the REST API and Payment Component; do not default to classic Direct Post/Collect.js. See the [migration guidance](https://docs.nmi.com/docs/quick-start-tutorial). |
| Square | A merchant wants to share its Square payment environment | [Payments API](https://developer.squareup.com/docs/payments-api/take-payments) and browser tokenization. Terminal/POS device integration is separate. |
| Adyen | Additional regions/payment methods required by a merchant | [Checkout integration](https://docs.adyen.com/online-payments/), browser components and asynchronous results. Availability is account/method-specific, not simply “cards outside the US.” |
| GoCardless | API-managed bank debit | [Mandates, collection and events](https://support.gocardless.com/hc/en-us/articles/360000830829-Introduction-to-the-GoCardless-API). Requires a separate mandate/return lifecycle plan; it does not replace the NACHA file adapter. |
| Braintree | An existing merchant or required capability | [HTTP GraphQL API](https://developer.paypal.com/braintree/graphql/guides/making_api_calls/) with browser tokenization. Reuse old mappings after checking feature availability; no Java SDK port. |

Cybersource, Worldpay Access, Elavon Converge and Heartland remain an unprioritized backlog. Re-research their contracts
if a deployment requests one; this plan makes no implementation commitment for them.

## 5. Shipping

### S1 — Shippo: first external shipping gateway

Port the existing adapter against the [current API reference](https://docs.goshippo.com/api-reference/overview), which
still identifies the `2018-02-08` contract. Set the version explicitly; its age does not imply that the API is retired.
Check [versioning](https://docs.goshippo.com/api-concepts/api-versioning) and release notes for additive changes.

Initial scope is the existing carrier interface: address validation, order and shipment rates, carrier/service/parcel
mapping, label purchase, label refund and tracking. Preserve supported multi-package and return-label behavior from
the source where exercised by the selected carrier. Record the provider shipment/rate/transaction ids, label format
and location, tracking number, actual charge/currency and per-package result.

Shippo can return rates and labels asynchronously; an HTTP success is not a finished label. Prefer bounded synchronous
requests for interactive operations, then retrieve pending objects instead of buying again. See [asynchronous responses](https://docs.goshippo.com/api-concepts/asynchronus-api-call).
Refund requests also need a resolved outcome. Handle stale rates, unavailable services, rejected addresses, partial
package failures, expired label links and duplicate tracking events without losing successful package results.

Replace the legacy webhook's full-context logging and add authenticated receipt processing. Shippo documents HMAC,
URL tokens and IP restrictions, with HMAC setup involving its team; provision the chosen mechanism explicitly and keep
polling available. Do not assume every account's callbacks are already signed. See [webhook security](https://docs.goshippo.com/tracking/webhook-security).

**Done when:** offline fixtures demonstrate rate-to-label-to-tracking, refund completion, duplicate/uncertain purchases
and independent package failure. A deployment can configure carrier accounts and retrieve/print a test label through
the existing Mantle shipment flow. Production capability and required carrier approval remain a go-live gate.

**Extensions after the basic port:** customs/international documents, manifests, pickups and batch purchasing. Scope
each to an actual shipping lane and carrier using current [customs guidance](https://docs.goshippo.com/international-shipping/international-shipping).
Larger customs and warehouse workflows get separate plans.

### S2 — Direct carriers: new adapters, only when needed

Shippo supplies the initial multi-carrier path. Schedule a direct adapter for a concrete account, service, cost or
capability requirement that the aggregator cannot meet. Suggested evaluation order remains UPS, USPS, FedEx, DHL
Express, but deployment requirements take precedence. Each gets a focused plan, with a capability matrix for rates,
purchase/void, tracking, validation, packages and returns; not every carrier supports identical semantics.

| Carrier | Current direction and material prerequisites |
| --- | --- |
| UPS | REST and OAuth. Own-account client credentials and delegated merchant authorization are different deployment models. Start with rating/shipping/tracking and applicable address validation using [UPS's API examples](https://www.postman.com/ups-api/ups-apis/overview). Do not resurrect access-key XML. |
| USPS | REST/OAuth; [Web Tools retired January 25, 2026](https://www.usps.com/webtools/). Labels need additional approval, USPS Ship enrollment and payment-account setup; the [label API](https://developers.usps.com/domesticlabelsv3) also uses a payment-authorization token. Start domestic; international is an extension. See [onboarding](https://devs.usps.com/getting-started). |
| FedEx | REST/OAuth for rate/ship/track and supported address validation. Verify project/account and label-validation requirements. Legacy WS retirement is staged: the [current guide](https://developer.fedex.com/api/en-us/guides.html) describes maintenance-only support from July 1, 2026, and the [October 30 notice](https://developer.fedex.com/api/en-jo/announcements/webservices_test_environment_retirement.html) schedules WS test-environment shutdown for December 31, 2026. |
| DHL Express | [MyDHL REST API](https://developer.dhl.com/api-reference/dhl-express-mydhl-api), with **Basic authentication**. Requires an active DHL Express account. Rate/ship/track are initial targets; its address capability check is not general postal-address correction. |

Do not port obsolete OFBiz carrier wire formats; historical business mappings may still be useful. Avoid treating every
carrier's approval process as the same label certification. Canada Post, Purolator, Royal Mail, Australia Post, Sendcloud
and Rock Solid/`mantle-rsis` stay future candidates, assessed against a deployment's actual coverage needs.

## 6. EDI

### E1 — Port the common X12 business services

The initial role is a supplier receiving retail purchase orders. Keep the following directional scope from
[`mantle-edi`](https://github.com/moqui/mantle-edi/tree/134acb6); this is not a complete procure-to-pay implementation.

| Document | Direction relative to Mantle | Business contract |
| --- | --- | --- |
| 850 purchase order | Inbound | Resolve the configured customer, ship-to, item identifiers, quantities/UOM, prices and requested dates; create a sales order through Mantle services. Unknown mappings or conflicting duplicate POs become exceptions, not invented master data. |
| 855 PO acknowledgment | Outbound | Report the actual order decision and supported line outcomes. Do not automatically accept a business order because its syntax parsed. |
| 856 advance ship notice | Outbound | Use actual shipment/package contents, customer PO/line references, carrier/tracking and the partner's hierarchy. Packing and label requirements must be satisfied before production. |
| 810 invoice | Outbound | Use the actual invoice and order/shipment references, totals, taxes and applicable charges/allowances. Produce at the agreed billing event; sending a document is not a new accounting posting. |
| 997 functional acknowledgment | Both, as agreed | Report/correlate syntactic/functional receipt and rejection. It is distinct from the 855 business response and does not prove delivery, payment or acceptance of commercial terms. |

Use XML Actions for orchestration and JavaScript for mapping logic/grammar expressions; use `new EdiHandler(ec)` and
the existing bindings. Reuse the converted grammar work as source material, putting production structures in Mantle
rather than loading framework test files at runtime. Keep partner rules in versioned profiles/mapping services, with
transport separate from document semantics and existing Mantle services owning business mutations.

The port includes these corrections to the old implementation:

- **Receipt before parsing:** retain original bytes and receipt id even when the envelope is malformed. Route by the
  authenticated connection and configured sender/receiver; payload ids must not select an arbitrary organization or
  mapping service.
- **Batch boundaries:** the Java receiver splits on ISA but then selects the first GS and ST. Process every supported
  group/transaction with traceable parent-envelope controls and independent outcomes; validate trailer counts and
  ISA/IEA, GS/GE and ST/SE control matches. A malformed envelope can quarantine the envelope; one bad independent
  transaction must not silently drop its siblings.
- **Validation:** explicitly validate required elements, cardinality, codes and business totals for the supported
  version/profile. Do not claim full standards or retailer compliance from `EdiHandler.segmentErrors` alone. Use X12
  4010 as the baseline, rejecting unsupported versions visibly; add another version only for a real partner.
- **Identity:** scope envelope/group/transaction controls by organization, partner, environment and direction. Allocate
  outgoing controls durably; preserve identity on retry. Detect the same business PO under new interchange controls,
  as well as transport duplicates. Same identity with changed content is a conflict requiring review.
- **Acknowledgments and lifecycle:** distinguish stored, validated, applied, sent and acknowledged outcomes; correlate
  returned acknowledgments and surface overdue/rejected documents. Generate only acknowledgments this side owns,
  on the agreed validation timeline, and never acknowledge acknowledgments in a loop. Record an outbound event and
  stable document revision with the business transaction; produce/send after commit, with recovery for interrupted
  processing. A rollback must not send a document, and a crash after commit must not lose it.
- **Known mapping gaps:** the source leaves SAC charges/allowances, detailed 855 ACK outcomes and parts of 856
  packing/SSCC handling unfinished. Make supported cases explicit, test them, and refuse unsupported data rather than
  quietly dropping financial amounts or shipment contents.

**Done when:** a self-contained Mantle fixture receives an 850, creates one order, emits the intended 855/856/810 and
correlates 997s; duplicate delivery, conflicting PO, rejected document, malformed input, multiple GS/ST sets and a bad
transaction among good ones have verified outcomes. The parser's limits and the profile's supported subset are
documented. This proves the common port, not certification for every retailer.

### E2 — SPS Commerce: the only initial provider

**Why this target:** SPS's retail network and file-exchange options fit the supplier-to-retailer flow and the existing
X12/SystemMessage assets. This is an implementation-fit recommendation; coverage, commercial terms and onboarding
effort must be checked for the first retailer. SPS's [developer overview](https://www.spscommerce.com/partners/developers/dev-center/)
describes Transaction API file exchange, usually RSX XML with other formats supported, as an alternative to FTP/AS2.
It does not establish that every account exposes a common business-document JSON schema.

**Planned first connection:** X12 pass-through over SPS-hosted SFTP, if available for the selected account and partner.
This maximizes reuse of E1. Confirm that format before implementing the SPS-specific mapping: SFTP describes transport,
not whether files contain X12, RSX XML or another agreed format. If the selected SPS product requires a normalized
format or Transaction API, write the corresponding mapping/transport plan and use that one path; do not implement both
SFTP and REST merely to hedge. This connection choice remains provisional: research further and finalize the format,
transport and document contract immediately before implementation.

**Public SPS documentation found (2026-10-31):** the Dev Center exposes technical documentation without signing in
when rendered in a JavaScript-enabled browser; search results and text-only retrieval do not expose all of it.

- [Transaction API](https://developercenter.spscommerce.com/#/docs/transaction-api): public reference for HTTPS file
  exchange, authentication, create/filter/get/delete operations and interaction history. The navigation includes v5
  documentation and [migration from older versions](https://developercenter.spscommerce.com/#/docs/transaction-api/v5-migrating).
  No revision date was shown; treat this as a live reference to recheck, not a dated specification. Public documentation
  access does not establish production account access or the contracted document format.
- [RSX overview](https://developercenter.spscommerce.com/#/rsx/docs/rsx-overview): describes SPS's standardized XML
  business-document format and partner mapping role. RSX is distinct from retailer-specific X12 specifications.
  A current complete XSD/data-dictionary bundle was **not verified**: the advertised
  [schema-download route](https://developercenter.spscommerce.com/#/rsx/docs/schema-download) rendered the overview
  during this review. This does not establish whether the schemas require an account or whether the route is stale.
- [SPS-hosted SFTP/FTP information](https://help.fulfillment.spscommerce.com/en/articles/12640807-sps-hosted-sftp-ftp-information),
  dated December 15, 2025: directory directions, filenames, polling, deletion and batching guidance. This describes
  transport operations, not the payload schema.
- Indigo publishes public SPS/former InterTrade partner specifications for
  [850](https://indigohub.zendesk.com/hc/en-us/articles/9176519462292-EDI-850-PO-Purchase-Order-Guidelines-and-Specs),
  [855](https://indigohub.zendesk.com/hc/en-us/articles/9154745629972-EDI-855-POA-Purchase-Order-Acknowledgement-Guidelines-and-Specs),
  [856](https://indigohub.zendesk.com/hc/en-us/articles/9176593450260-EDI-856-ASN-Advance-Ship-Notice-Guidelines-and-Specs) and
  [810](https://indigohub.zendesk.com/hc/en-us/articles/9176645456660-EDI-810-Invoice-Guidelines-and-Specs), with downloadable
  PDFs. The pages were updated November 12, 2024, but the inspected 850 PDF was last modified April 30, 2021. Page or
  upload dates must not be treated as specification revisions. These are useful mapping examples, not a universal SPS
  contract or the first retailer's requirements unless Indigo is selected.

Before implementation, obtain the applicable current schema/data dictionary, sample documents and revision history
from SPS or the selected partner, and record their versions in the connection worksheet. The approximately eight-year-old
SPS reference already available can support comparison, but its format and continued applicability must be checked.
If RSX is selected, obtain the current XSDs and mapping requirements; if X12 pass-through is selected, obtain the
partner's implementation guides and confirm SPS's pass-through and acknowledgment behavior. Finalize one path after
this research rather than treating the public examples or the historical reference as the implementation contract.

Before E2 begins, record a first-connection worksheet:

1. Supplier organization, SPS product/account, named retailer, test/live access, document format/version and samples;
   confirm commercial access, retailer coverage, onboarding lead time, recurring charges and support ownership.
2. Required document types/directions and deadlines, acknowledgments generated by SPS versus Mantle, error/status
   feedback, and whether changes/cancellations (860/865), TA1, 999 or 824 are required. These are not implied by the
   five-document port. Any mandatory extra document becomes a scoped prerequisite to this partner's go-live.
3. Identifiers and crosswalks: ISA/GS ids and qualifiers, customer/store/location codes, vendor number, SKU/UPC/GTIN,
   UOM and pack conversions, original PO/line references, charges/allowances and agreed invoice rounding.
4. The 856 hierarchy, carton/pallet contents, SSCC allocation and GS1-128 label/packing-slip requirements, if any.
   A parcel carrier label does not satisfy a retailer's carton label. Use existing shipment/package data where it fits;
   missing warehouse/label workflows require the ASN plan below and cannot be deferred past certification.
5. Endpoint, explicit port, host-key fingerprint, credential storage, directory directions, polling limits, filename
   rules, completion/deletion rules, certification cases and the evidence required to enable production.

For the file path, SPS documents `out`/`testout` for files coming **from SPS** and `in`/`testin` for files going **to SPS**,
unique filenames, customer cleanup of retrieved files and batching rules. Configure polling to the agreed cadence;
its guidance says polling more often than every 30 minutes is usually unhelpful. See [SPS-hosted SFTP information](https://help.fulfillment.spscommerce.com/en/articles/12640807-sps-hosted-sftp-ftp-information).

Reuse `org.moqui.sftp.SftpMessageServices.send#SystemMessageSftp` and `poll#SystemMessageSftp`. Specify the supplied port
explicitly (normally 22); the compatibility default is 115. Pin the verified host key. Complete the per-file failure
isolation noted in section 2, use safe completed-file upload/pickup conventions agreed with SPS, and delete or move a
download only after durable local receipt. Test a crash between receipt and remote cleanup, and between upload and
local status recording. Filename deduplication supplements document/business deduplication; it does not replace it.

**E2 deliverables:** one provider connection profile, one named partner's versioned mappings and sanitized fixtures,
scheduled send/poll/status jobs, documented acknowledgment ownership, and an operator procedure for exceptions,
reconciliation and replay. Do not describe a sample profile as universally retailer-compliant.

**Production gate:** complete the partner/SPS cases for the required document cycle, exceptions and labels; confirm
acknowledgment monitoring and a controlled cutover with no duplicate open orders/documents. A fixture-tested adapter
and a certified live connection are separate milestones. Account provisioning and certification are joint deployment/
integration work, not a reason to omit required handling from the reusable adapter.

### Future EDI candidates — document now, implement later

| Candidate | Fit and evidence | Condition for a later plan |
| --- | --- | --- |
| Orderful | Developer-oriented JSON transactions and partner guidelines. Its [transaction guide](https://docs.orderful.com/reference/orderful-transactions) specifies the v4 version header; [inbound delivery](https://docs.orderful.com/reference/inbound) supports webhooks or inbox polling with explicit delivery/acknowledgment handling. | First alternative to evaluate if a deployment wants JSON or already uses Orderful. Map to the same Mantle business operations; do not just wrap the SPS transport. No implementation in E2. |
| TrueCommerce, including DiCentral | [API integration offering](https://www.truecommerce.com/integrations/api/); [DiCentral was acquired by TrueCommerce](https://www.truecommerce.com/press-release/truecommerce-acquires-dicentral/), so do not list it as an unrelated independent provider. | Existing customer/network requirement; obtain the applicable product's schema, account access and acknowledgment contract first. |
| Cleo Integration Cloud | [EDI, API and managed file integration](https://support.cleo.com/hc/en-us/articles/360044671294-Overview-of-CIC-Cloud-Edition). | A deployment already operates Cleo or needs its broader tooling. Scope the ERP boundary and mapping/transport ownership explicitly. |
| Stedi | Its current [EDI platform](https://www.stedi.com/edi-platform) and [developer docs](https://www.stedi.com/docs/healthcare) emphasize healthcare/HIPAA. | Conditional research candidate: verify current retail-X12 availability and onboarding before treating it as an Orderful substitute. Healthcare EDI is a different project. |

AS2 is a future transport only if a direct partner/contract requires Mantle to terminate it. It needs a plan for
certificates, signing/encryption, MDNs, retries and operations. Broker-to-retailer AS2 does not by itself require an AS2
client in Mantle. EDIFACT business flows, procurement documents, inventory/warehouse sets (such as 846/940/945),
remittance advice and a graphical mapping editor are also outside the initial retail supplier implementation.

## 7. Work sequence, validation and follow-up plans

| Step | Deliverable and dependency | Completion boundary |
| --- | --- | --- |
| 0 | Audit gateway/message contracts; make the small changes in section 3. Obtain SPS samples and the first-connection worksheet alongside development planning. | Operation identity, credential ownership, callback receipt and capability contracts are explicit. Large lifecycle changes have a focused plan before coding. |
| 1 | P1 Authorize.Net, then P2 PayTrace; each includes its tokenization example, configuration and specs. | Each adapter passes shared payment scenarios; current API contracts replace old wire code. |
| 2 | S1 Shippo basic port; independent of payment ports once its common requirements are settled. | Existing shipping services can rate, buy, recover, refund and track without duplicate charges or lost package results. |
| 3 | E1 X12 service port and targeted framework validation/SFTP fixes. | Offline business cycle, batching, malformed input and replay checks pass. |
| 4 | E2 SPS connection and one partner; depends on E1 and confirmed account/format requirements. | Reusable adapter complete, followed by deployment certification/cutover. Other EDI providers remain candidates. |
| 5 | P3 Stripe under its own plan; can be brought forward independently when checkout requirements are known. | Browser/server lifecycle and recovery verified before app adoption. |
| 6 | App adoption and demand-driven PayPal, direct carriers, other processors or EDI providers. | Each has a named use case, account capabilities and a scoped plan; no automatic expansion to the whole candidate list. |

For each adapter, use deterministic HTTP/SFTP fixtures or a local fake transport, sanitized provider examples and
self-contained Mantle specs. Cover successful business effects, refusal, pending completion, duplicate and concurrent
requests, timeout after remote success, retries after restart, wrong-account input and failed callback authentication.
Use the framework's test seams; production services must not load specs or contain special test branches.

Run relevant regression specs with `./moq test mr-mantle --spec <spec-name>` and targeted framework tests when framework
code changes. JavaScript specs run in Moqui, not Node. Keep individual cases well under a second; a regression spec over
15 seconds fails the run. Provider sandbox/certification and live financial or shipping calls are acceptance tests, in
`acceptance/`, run only when the user asks or when one is added or changed. This document revision itself requires no
build or application test run.

Create separate plans only when scheduling these larger efforts:

- **Payment lifecycle/Stripe checkout:** substantial attempt-recovery/state changes, browser sessions, 3DS,
  completion endpoints and app adoption beyond the basic ports.
- **Retail ASN and labeling:** missing pack hierarchy, SSCC allocation, GS1-128 labels, packing slips and warehouse
  actions required by the first retailer; mandatory parts gate E2.
- **Direct carrier or advanced shipping:** each carrier's authorization/capabilities/approval, customs and shipment
  documents, manifests, pickups or batch workflows beyond the Shippo port.
- **Additional EDI provider, format, document family or AS2:** contracted schema, mapping ownership, acknowledgments,
  operations and migration; do not reopen the initial one-provider scope just to add options.

Keep the per-phase implementation record here until a separate plan owns that effort: changed artifacts, source/API
baseline, fast checks run, known limits and the deployment gate still outstanding. Commit in the repository that owns
each change; update this plan's completion record without turning component READMEs into status logs.

### Phase 0 — common contracts (implementation record, 2026-11-02)

Step 0's small common changes, so P1 Authorize.Net, P2 PayTrace, S1 Shippo and E1 build on explicit contracts. The SPS
worksheet, E2 and Stripe are not part of it. Nothing is committed yet; the record names the artifacts per repository.

**Changed artifacts.**

- mr-mantle: `entity/PaymentGatewayEntities.xml` (PaymentGatewayResponse `idempotencyKey`, `resultUnknown`,
  `outcomeResolvedDate`, `outcomeFound`; PaymentMethod `gatewayCustomerId`), `entity/ShippingGatewayEntities.xml` (ShippingGatewayConfig
  `systemMessageRemoteId`), `service/mantle/account/PaymentServices.xml` (the gateway interfaces, `begin#PaymentGatewayOperation`,
  `make#GatewayIdempotencyKey`, `record#PaymentAuthorized`, the four `*#SinglePayment` services, `get#SinglePaymentGatewayDetails`,
  `poll#PaymentGatewayDetails`, `get#PaymentGatewayActions`, `execute#PaymentGatewayAction`,
  `find#PaymentGatewayTransactions`), `PaymentTestServices.xml` (keys recorded; `alwaysUnknown#PaymentAuthorization`,
  `alwaysUnknown#PaymentRefund`, `notFound#PaymentDetails`), `PaymentMethodServices.xml` (`update#PaymentMethodMutable`
  takes `gatewayCustomerId`), `service/mantle/order/ReturnSettlement.js` (an unknown refund stays pending), `Portal.js` (an unknown answer stays
  pending and is looked up),
  `service/mantle/shipment/CarrierServices.xml` and `Shipping.js` (`pending`), the test carrier (`TestCarrier.js`,
  `TestGatewayServices.xml`: postal codes 99904, 99905), specs `test/account/GatewayContracts.spec.js` (new),
  `AccountingPaymentGateway.spec.js`, `AccountingPortals.spec.js` and `WarehouseShipping.spec.js` (a feature each).
- mr-moqui: `crates/moqui-core/src/service/http_fixtures.rs` and `http_fixtures_tests.rs` (new), `outbound.rs` (the
  fixtures answer before any transport), `service/mod.rs`, `native.rs`, `crates/moqui-host/src/test_cmd/mod.rs` (the test
  runner allows the fixtures), `framework/conf/MoquiDefaultConf.xml` (the `HttpFixtures` tool),
  `framework/service/org/moqui/impl/SystemMessageServices.xml` (`store#ReceivedSystemMessage`), `docs/Build-Test.md`
  ("HTTP fixtures").

**Payment operation identity (§3.2).** The lifecycle is unchanged; the identity now reaches the adapter.

- Every `authorize#`, `capture#`, `release#` and `refund#Payment` interface takes `operationKey` (the caller's, when it gave
  one) and `idempotencyKey`, always given. `make#GatewayIdempotencyKey` makes it: `mq` and 30 hex characters of a hash of
  the gateway, the operation name, the payment and its two parties, the amount and currency, and the operation key (a random
  nonce without one). The same keyed input gives the same key after a crash or rollback; another payment, gateway,
  operation or amount gives another. The hash is `ec.user.singleUseCodeHash`, whose digest follows the conf's password
  hash type (SHA-256 by default): changing that type changes the keys of operations retried across the change. Scripts
  have no plain SHA-256 of a text yet; an `ec.user` digest is a small framework addition when it matters. The adapter sends it as the provider's idempotency key (PayTrace and Stripe where
  supported) or, where there is none, as a searchable reference (Authorize.Net `refId`, limited to 20 characters: send its
  first 20, and the `order.invoiceNumber` the adapter can search by), and records it on its PaymentGatewayResponse.
  `refund#Payment` also gets `refundPaymentId`.
- `begin#PaymentGatewayOperation` replaces the four copies of the keyed replay check. It always locks the payment. With a
  key, the key's latest response replays; one of another operation, amount or refund payment is `OPERATION_KEY_CONFLICT`
  (`refund#SinglePayment` compares the amount given, else its refund payment's, before defaulting it); an unknown
  response a lookup resolved as not done (`outcomeFound` N) does not replay, so the operation runs again with the same
  idempotency key. Then a payment with an unresolved unknown outcome (its own, or one of its refund payments) is
  **blocked without an error**: `blocked`, `reasonCode` `GATEWAY_OUTCOME_UNKNOWN`, and each `*#SinglePayment` returns a
  message and that `reasonCode`, so `apply#OrderPaymentsToInvoice`, `capture#InvoicePayments` and other loops go on with
  their other payments and roll nothing back. A reviewed action is refused before that: `get#PaymentGatewayActions`
  offers only `lookup`, so `execute#PaymentGatewayAction` answers `STALE_PREVIEW`.
- The response contract (the description of `authorize#Payment`): the adapter records one PaymentGatewayResponse per call
  and changes no Payment. `resultSuccess` approved; `resultDeclined` (or NSF, expiry, card number) refused; `resultError`
  not done (refused before the provider acted: validation, a connect failure), safe to send again; **`resultUnknown`** the
  answer was lost after the request may have gone (a timeout, a reset, an unreadable body); none of them, pending (with its
  `referenceNum`, and `redirectUrl` for a hosted page). A transport failure is recorded as `resultUnknown`, not thrown: a
  throw rolls the evidence back with the caller's transaction. When the transport cannot tell connect from timeout, record
  unknown.
- Resolution: `get#PaymentGatewayDetails` takes `operationKey`, `idempotencyKey` and `paymentOperationEnumId` of the
  latest unresolved unknown response of the payment (for a refund payment, the response whose `refundPaymentId` it is) and
  answers **`operationFound`**: true when the provider did it (`gatewayStatusId` the status it led to, with
  `referenceNum` and `approvalCode`), false when the provider has no such operation (`gatewayStatusId` the payment's own
  status, `PmntCancelled` for a refund payment it never received), absent when it still cannot tell. Only
  `operationFound` resolves the unknown response (`outcomeResolvedDate`, `outcomeFound` Y or N); a status alone does not.
  The reference becomes the payment's `paymentRefNum`. A found authorization goes through `record#PaymentAuthorized`,
  shared with `authorize#SinglePayment`'s approved answer: Authorized with the approval code and reference, Delivered for
  an authorization and capture, and the card's security code cleared. `get#SinglePaymentGatewayDetails` no longer
  needs a `paymentRefNum` when an unknown response is open, and `poll#PaymentGatewayDetails` also polls the open unknowns,
  however old and newest first up to `checkLimit` (each in its own transaction, an error logged and the rest going on). `get#PaymentGatewayActions` offers only `lookup`
  while one is open (`outcomeUnknown`, `GATEWAY_OUTCOME_UNKNOWN`); `execute#PaymentGatewayAction` and
  `find#PaymentGatewayTransactions` have the outcome `unknown`.
- A refund whose answer is unknown, or pending with a reference to look up, and that has no refund payment yet (a direct
  `refund#SinglePayment`) now gets a promised one, so it counts against the refundable amount and the lookup completes
  it; a refusal (declined, error, NSF, expiry, card number) or a pending answer with no reference gets none. A return's
  gateway refund with an unknown answer stays pending instead of being declined.
- The invoice pay pages (`Portal.js`) keep an attempt with an unresolved unknown answer pending (never cancelled as
  "nothing to ask") and look it up even with no `paymentRefNum`; a found authorization is then captured.

**Token input and provider references.** `authorize#Payment` (and `authorize#SinglePayment`) take `paymentToken`, a Map of
the provider's single-use tokenization output (Accept.js `opaqueData`, Protect.js `hpf_token`/`enc_key`), passed for that
call only, never stored or logged. Reusable references are on the PaymentMethod: `gatewayCimId` the provider payment
profile, the new `gatewayCustomerId` its customer profile, with `paymentGatewayConfigId` the gateway they belong to.
`Party.gatewayCimId` is not used by the new adapters (two gateways' customers of one party would collide). A tokenized card's
CreditCard keeps display metadata only: the masked number the provider returns, type and expiry; never the PAN or CVV.

**Shipping.** The durable attempts already exist: ShippingGatewayRequest, recorded and committed before the call,
`claim#ShippingGatewayRequest`, Unknown after a lost answer, and `find#ShippingLabels` asked before any retry (warehouse
P13; `WarehouseTaskServices.request#PackageLabels` / `refund#PackageLabels`). The gap was pending label completion:
`request#` and `refund#ShippingLabels` now answer `pending` (an accepted purchase whose label is not finished, Shippo
QUEUED), and `find#ShippingLabels` answers `pending` too; `Shipping.js` keeps such a request Unknown with `LABEL_PENDING`
and asks again on the next request, never buying again. S1 adapters: send `requestReference` to Shippo (transaction
`metadata`) so `find#ShippingLabels` can search for it; a refusal throws its reason code (`LABEL_REFUSED`,
`ADDRESS_INVALID`, ...), anything else thrown is a lost answer; leave `gatewayRefundStatus` empty until a refund is
decided. Drive labels through the WarehouseTaskServices entry points; `CarrierServices.request#ShipmentLabels` alone
records no attempt. Nothing finishes a pending label by itself yet: today it completes when a person requests the labels
again. S1 adds the driver, a ServiceJob that re-runs `request#PackageLabels` / `refund#PackageLabels` (by the recorded
ShippingGatewayRequest) for requests Unknown with `LABEL_PENDING`, and its Shippo transaction webhook consumer, which
does the same for the event's request; both go through `find#ShippingLabels`, never a new purchase.

**Credentials and configuration.** A provider connection is a SystemMessageRemote, one per environment:
`PaymentGatewayConfig.systemMessageRemoteId` (existing) and the new `ShippingGatewayConfig.systemMessageRemoteId`, and for
EDI the remote itself. `sendUrl` is the API base (the sandbox or the production host), `usageCode` `T` or `P`, `username`
the API login or client id, and the secrets in the remote's encrypted fields: `password` (transaction key, client secret,
API token), `sharedSecret` (the webhook signature key), `sendSharedSecret`, `privateKey`. The provider's own gateway entity
(shared PK with the config) holds only non-secret options. Seed and demo data name the configs and remotes without
credentials; credentials are entered in the System Message Remote screen or a deployment's own data file. Never a
ShippingGatewayOption or any unencrypted field.

**Callback receipt.** A provider webhook posts to the framework endpoint `/rest/sm/{systemMessageTypeId}/{systemMessageRemoteId}`,
whose remote's `messageAuthEnumId` authenticates the body before anything is kept (`SmatHmacSha256`,
`SmatHmacSha256Timestamp` with its replay window, or `SmatLogin`). The type's `receiveServiceName` is the provider's own
receive service: it parses the event id from the authenticated body and calls the new
`org.moqui.impl.SystemMessageServices.store#ReceivedSystemMessage` (`systemMessageTypeId`, `systemMessageRemoteId`,
`messageId` the provider event id, `messageText`, ...), which locks the remote and keeps the event once per remote, type and
event id; a duplicate answers an empty `systemMessageIdList` and `duplicateOfId`, so the endpoint answers success and
nothing is consumed twice. The type's `consumeServiceName` applies it through the existing Mantle services and converges
on provider state by lookup (details service, `find#ShippingLabels`), not on the payload's order. The remote, so the
organization and gateway, comes from the endpoint path, never from the payload. Authorize.Net signs with HMAC-SHA512 in
`X-ANET-Signature` (`sha512=` and hex), which no `messageAuthEnumId` checks yet: P1 adds that scheme to
`crates/moqui-core/src/service/system_sync/message.rs` with a Rust test. S1 checks whether Shippo's signature matches
`SmatHmacSha256Timestamp` and otherwise adds its scheme the same way.

**HTTP test seam.** The framework's HTTP fixtures (`ec.factory.getTool("HttpFixtures")`, docs/Build-Test.md "HTTP
fixtures"): while a spec has them enabled, every outbound request of the process is answered by the first matching
fixture (method, exact or `*` prefix URL, body text) and recorded, credentials redacted (Authorization,
Proxy-Authorization, Cookie, `*Api-Key`); `error` simulates a lost answer after the request was sent; an unmatched
request fails and never reaches the network. The switch is process-wide, so a request with no execution context fails
closed too, and `enable()` is refused unless the `moqui test` runner allowed it (`http_fixtures::allow()` before boot). An adapter keeps its sandbox URL from its remote and has no test
branch; its spec adds the provider's sanitized answers, calls the Mantle service, and checks `requests()` (the
idempotency key header, no card data in the body). Production services load no spec files.

**Fast checks run** (after the review fixes). `cargo test -p moqui-core --lib http_fixtures` (2 passed); `cargo clippy
-p moqui-core -p moqui-host --all-targets -- -D warnings` (clean); `./moq test mr-mantle --spec
GatewayContracts,PaymentGateway,AccountingPaymentGateway,AccountingPaymentRefunds,AccountingReturns,AccountingPortals,AccountingPaymentLifecycle,FinancialAccountServices,PaymentMethodServices,CarrierServices,WarehouseShipping,OrderToCashBasicFlow,ReturnToResponseBasicFlow,InvoicePaymentMisc`
(17 specs with their dependencies, 172 features passed); `./moq test mr-boss --spec AccountingPaymentGateway,AccountingPaymentRefunds`
(8 passed). No slow test was run.

**Known limits, for the ports and the payment-lifecycle plan.**

- The adapter writes its response in the caller's transaction. A remote success followed by a local rollback loses that
  response; a keyed retry sends the same idempotency key, which a provider with idempotency answers with the first result,
  but a provider without it (Authorize.Net) gets a second request, which only its duplicate window or a reference search
  can catch. Writing the response in its own transaction would need a replay that re-applies the payment status: that is
  the durable attempt record of the payment-lifecycle plan, not a processor port.
- Callers without an operation key (`authorize#OrderPayments`, order and invoice flows) get a random key per call, so
  they have no rollback recovery; they are protected by the unknown-outcome guard only.
- There is no operator action to close an unknown outcome the provider cannot be asked about (a details service that
  never answers a status); such a payment waits for a lookup. A reviewed "resolve as not done / done" action belongs to the
  payment-lifecycle plan.
- A return settlement's gateway refund that is blocked by an open unknown outcome sends nothing, so its refund payment
  is declined as one with no answer; the return is settled again after the lookup.
- An unknown refund is resolved by looking up the refund payment, not the original (the original shows only `lookup` of
  its own status meanwhile).
- XML files were edited in their existing layout; they were not passed through `xmllint --format`, which would reformat
  their unrelated content (none of them were in that form at HEAD).

**Amended by P1 (the common contracts).**

- `begin#PaymentGatewayOperation` also blocks an authorization (`blocked`, reasonCode **`GATEWAY_OUTCOME_PENDING`**,
  without an error) of a promised payment whose latest authorization answer is pending (no result flag: held for review,
  a hosted page), after the keyed replay; `authorize#SinglePayment` answers that reasonCode. The details lookup or the
  provider's callback finishes it.
- `authorize#SinglePayment` puts a pending answer's reference on the payment, replacing an older one (a re-authorization).
- `get#SinglePaymentGatewayDetails`: a promised or declined (non-refund) payment the gateway reports authorized, captured
  or settled goes through `record#PaymentAuthorized` (captured for the last two), so it gets its approval code and the
  security code is cleared; a lost void found done makes the payment promised without its references, as
  `release#SinglePayment` does.
- `refund#SinglePayment` puts a successful refund's `referenceNum` on the refund payment (so its settlement is polled
  and its callbacks find it); an adapter that has no transaction of the refund's own leaves `referenceNum` empty.
- `poll#PaymentGatewayDetails` no longer needs a `paymentMethodId`: a reference and a gateway, so token-only payments are
  polled.

**Amended by P2 (the HTTP test seam).** A `moqui test` run is closed to the network while the fixtures are off too:
`moqui_core::service::http_fixtures::network_refusal`, checked in `outbound::send_inner` and `open_inner` after the
fixtures and before any installed sender or the built-in transport, fails a request to anything but a loopback address
(localhost, `*.localhost`, 127.0.0.0/8, ::1) with a transport error naming its redacted URL and a warning. Outside a test
run (`allowed()` false) nothing changes. A spec that needs a real host opens URL prefixes with
`HttpFixtures.allowNetwork([...])`; `reset()` is now off, no fixtures, no requests and nothing opened, so a run stays
closed. Found when a later spec's poll job sent the gateway specs' leftover payments to the real sandboxes. Rust test
`a_closed_test_run_refuses_all_but_loopback_and_opened_prefixes`; `./moq test mr-mantle` (1421 passed) and the mr-boss,
mr-pass and basic-comms specs with outbound HTTP (see the P2 record) logged no refusal.

### P1 — Authorize.Net (implementation record, 2026-11-02)

The Authorize.Net gateway on the Phase 0 contracts. Nothing is committed yet; the record names the artifacts per
repository.

**Source and API baseline.** Ported from [AuthorizeDotNet](https://github.com/moqui/AuthorizeDotNet/tree/eaa351c) 1.2.5,
commit `eaa351c` (CC0 with the patent grant, the license of Mantle; its authors are in Mantle's `AUTHORS.md`): the CIM
payment operations, the profile mapping (`billTo`, customer type, `merchantCustomerId`), the configuration fields, the
AIM reason-code mapping (6/37 card number, 7/8 expiry) and the transaction-status map. Not ported: AIM `x_` requests,
raw-card CIM requests, the `create#`/`update#CreditCard` SECAs that sent card numbers, the user-preference gateway
selection and the request/response logging. Wire protocol: the Authorize.Net JSON API at `/xml/v1/request.api`
(`createTransactionRequest` with `authOnlyTransaction`, `authCaptureTransaction`, `priorAuthCaptureTransaction`,
`voidTransaction`, `refundTransaction`; `createCustomerProfileRequest`, `createCustomerPaymentProfileRequest`,
`getCustomerPaymentProfileRequest`, `deleteCustomerPaymentProfileRequest`; `getTransactionDetailsRequest` by `transId` or
`transrefId`, `getUnsettledTransactionListRequest`, `getSettledBatchListRequest`, `getTransactionListRequest`), with field
order from `AnetApiSchema.xsd` as read on 2026-11-02 (the JSON API is checked as XML, so order matters; answers start
with a byte order mark). References checked 2026-11-02: the [API reference](https://developer.authorize.net/api/reference/index.html),
the [webhooks guide](https://developer.authorize.net/api/reference/features/webhooks.html) (HMAC-SHA512 of the body with
the signature key in `X-ANET-Signature`, up to 10 retries, no ordering or duplicate guarantee), Accept.js/AcceptUI
(`jstest.authorize.net` / `js.authorize.net`, `v1/Accept.js`, `v3/AcceptUI.js`) and Accept Hosted.

**Changed artifacts.**

- mr-mantle: `service/mantle/ext/account/gateway/AuthorizeNetServices.xml` and `AuthorizeNet.js` (new: the five gateway services and
  `authorizeAndCapture#Payment`, `store#`/`delete#CustomerPaymentProfile`, `receive#`/`consume#Webhook`,
  `get#BrowserPaymentConfig`, `submit#BrowserPaymentToken`), `service/AuthorizeNet.secas.xml` (new: a deleted method's
  profile), `entity/PaymentGatewayEntities.xml` (`PaymentGatewayAuthorizeNet`, non-secret options, and the `PgtAuthorizeNet`
  seed), `data/AuthorizeNetSetupData.xml` (seed: SystemMessageType `AuthorizeNetWebhook`), `data/AuthorizeNetDemoData.xml`
  (demo: gateway `AuthorizeNetDemo` and remote `AuthorizeNetSandbox`, no credentials), `service/mantle.rest.xml`
  (`my/payments/{paymentId}/authorizeNet` GET and POST), `service/mantle/account/PaymentServices.xml` (the common
  contract amendments listed at the end of the Phase 0 record: `GATEWAY_OUTCOME_PENDING`, a pending answer's reference,
  `record#PaymentAuthorized` for a pending authorization the lookup finds approved, a found void, the refund payment's
  reference, the poll), `docs/AuthorizeNet.md` and `docs/examples/AuthorizeNetAcceptUI.html` (new), and
  `test/ext/AuthorizeNetGateway.spec.js` (new).
- mr-moqui: `crates/moqui-core/src/service/system_sync/message.rs` (`SmatHmacSha512`: hex HMAC-SHA512 of the body, either
  case, an optional `sha512=` prefix, on receive and send) and `tests.rs` (its test and the HMAC-SHA512 vector),
  `framework/entity/ServiceEntities.xml` (the `SmatHmacSha512` enumeration), `SystemMessageServices.xml` (description),
  `docs/security/Attack-Surface.md` (the receive table).

**Design.**

- *Card data.* The server sends no card number: an authorization uses the call's `paymentToken` (Accept.js opaqueData)
  or the method's customer payment profile (`gatewayCustomerId` + `gatewayCimId` at this gateway), otherwise it is
  refused (`NO_PAYMENT_PROFILE`, resultError). A tokenized method keeps the profile references and the masked card
  (`XXXX1111`, type) only; a one-time token makes no method. Requests and answers are never logged; the module logs fixed
  text and reason codes.
- *Identity.* `refId` and `order.invoiceNumber` carry the first 20 characters of the idempotency key. A transport
  failure, a non-200 server answer, unreadable JSON and the duplicate refusal (reason 11) are `resultUnknown`. The lookup
  for a lost authorization, sale or refund tries `transrefId`, then the unsettled list's invoice numbers (the held ones,
  `status` `pendingApproval`, and the others, which leave held ones out), then those of batches settled since the request
  (bounded to 31 days, 5 pages of 1000 per list); a lost capture or void reads the authorization's transaction status.
  Not found answers `operationFound` false only once the lost request is older than `lookupGraceSeconds` (default 300,
  and never less than `duplicateWindow` plus 60, the provider's default window being 120); a failed search leaves it
  unknown. A details lookup records a PgoTxDetails response only for a change (a status that differs from the payment's,
  or a transaction status other than the last recorded). "Already captured" (311) and "already voided"
  (310) on a retry are successes.
- *Outcomes.* Response code 1 approved, 2 declined, 3 error (card number and expiry codes flagged), 4 held for review:
  pending with its transaction id, and not authorized again while pending (`GATEWAY_OUTCOME_PENDING`), finished by the
  details lookup or the fraud webhook through `record#PaymentAuthorized`. `expired` maps to Promised (the
  capture re-authorizes), `failedReview` to Declined, a voided authorization to Void.
- *Void versus refund.* Refunds are always linked (`refTransId`, to the profile or the card's last four digits; no
  unlinked credit). The original's settlement state is read first: settled, refund; captured and unsettled, a whole
  refund is a void recorded as the refund (`VOID_BEFORE_SETTLEMENT`, the void's transaction id, the original's, in
  `altReference`, so the refund payment gets no reference; the refund payment is Delivered and applied, the
  original stays Delivered and is never Confirmed, and a details lookup of the voided original changes nothing), a partial
  one is refused (`REFUND_BEFORE_SETTLEMENT`, nothing sent, no refund payment).
- *Webhooks.* `/rest/sm/AuthorizeNetWebhook/{remote}` with the remote's `SmatHmacSha512`; `receive#Webhook` keeps each
  `notificationId` once (`store#ReceivedSystemMessage`); `consume#Webhook` finds the payment among the payments of the
  gateways on that remote (by transaction id, else by the lost operation's refId, used only when it has the key's form)
  and runs `get#SinglePaymentGatewayDetails` for each in its own transaction: one that fails is logged and the others go
  on, and the message is then failed so it is retried. The payload's status is never applied. A settled refund's
  `refund.created` event finds its refund payment by the reference it now keeps.
- *Browser.* `get#BrowserPaymentConfig` / `submit#BrowserPaymentToken` under `/rest/s1/mantle/my`: the payment picks the
  organization, gateway, amount and currency; only its payer, or a user with treasury authority over the organization paid
  (`check#PaymentGatewayAccess`), may use them; `savePaymentMethod` is the payer's explicit consent and is ignored for
  anyone else; the browser's `operationId` becomes the operation key, and the page makes a new one after a decline or an
  error. The submit locks the payment and checks it again, then asks `begin#PaymentGatewayOperation` first: a replay, or
  a pending or unknown earlier authorization, sends nothing and makes no profile. A profile made for a card that is then
  declined is deleted and its method expired. A payment method of another gateway is refused (`METHOD_OTHER_GATEWAY`), so
  the token cannot be sent elsewhere. The example is a static page (AcceptUI hosted form), not a screen, so it adds no
  qvt/tui surface; Accept Hosted is documented as the alternative and not built.

**Fast checks run** (after the review fixes). `cargo test -p moqui-core --lib system_sync` (10 passed, the new
`an_hmac_sha512_receive_checks_the_hex_signature_in_either_case_with_or_without_its_prefix` included) and `cargo test -p
moqui-core` (1301 + 16 passed, 5 ignored); `cargo clippy -p moqui-core --all-targets -- -D warnings` (clean); `./moq
build`; `./moq test mr-mantle --spec AuthorizeNetGateway` (15 features passed, each 0.02–0.11 s: approval and capture,
decline, bad card and held, release, settled refund, void before settlement and the refused partial refund, profile
create/use/delete, a lost authorization found in the unsettled list, a duplicate refusal (11) found by `transrefId`, 311
and 310 on a retry, a lost sale found in a settled batch and a lost authorization found nowhere (not done, sent again
with the same key), a lost capture and a lost void, a lost refund found through the voided original, the webhook kept
once and reconciled with its approval code, the browser endpoints (REST path, payer, refused customer), a held
authorization resubmitted with a new operation id sending nothing, a treasury user's save ignored, a declined kept card
deleted, and a self-contained check that no token, card number or secret is in a gateway response, system message or
card record; the last two features also pass alone with `--feature`); `./moq test mr-mantle --spec
GatewayContracts,PaymentGateway,AccountingPaymentGateway,AccountingPaymentRefunds,AccountingPortals,AuthorizeNetGateway,PaymentMethodServices,AccountingReturns,AccountingPaymentLifecycle,OrderToCashBasicFlow,ReturnToResponseBasicFlow,InvoicePaymentMisc,FinancialAccountServices,AccountingSettlement`
(17 specs with their dependencies, 185 features passed); `./moq test mr-boss --spec
AccountingPaymentGateway,AccountingPaymentRefunds` (8 passed). The spec's console at `--log-level debug` contains none of
the browser tokens or the spec's transaction or signature key. `moqui lint` of the changed service files: clean.
Prettier with the repository's `.prettierrc.json` on the module and spec (run with `--ignore-path=`: Prettier 3 skips
files the mr-moqui `.gitignore` lists, which includes `runtime/component/`, so the first pass formatted nothing; the one
line left over 130 is a string). `xmllint --format` on the new XML files with a canonical comparison. No slow test was
run.

**Known limits.**

- The webhook signature key is used as its text (as the published examples do), not hex-decoded; confirm against a
  sandbox delivery before production. `SmatHmacSha512` has no timestamp, so no replay window: a replayed signed body is a
  duplicate notification, kept once.
- `transrefId` lookups are in the schema but reported unreliable; the list searches back them up.
- Two tabs submitting at once are serialized by the payment lock; that is not exercised by a spec (one thread).
- A pending authorization the provider never finishes (an abandoned hosted page) keeps its payment blocked for a new
  authorization until a lookup or an operator changes the payment's status.
- The response is written in the caller's transaction (Phase 0 limit); Authorize.Net's duplicate window is the only
  provider guard against a second request after a local rollback, and a lookup by reference finds the first.
- A legacy method with a full card number and no profile is refused rather than migrated; migration needs the payer
  to tokenize again.
- No eCheck/ACH, Level 2/3 data, split tender, or Accept Hosted page; Customer Information Manager updates (a new expiry)
  go through a new token. Not ported from the source's mapping: `poNumber` (the buyer's purchase order, not Mantle's
  order id, which goes in `order.description`) and the customer email and `billTo` on token transactions (a payment made
  from a token has no method to take them from; a stored profile carries `billTo`).
- No operator screen; the existing gateway actions (lookup, capture, refund) and System Message screens cover it.

**Deployment gate.** Sandbox credentials and a public client key on the remote and options; a webhook pointed at the
endpoint with the signature key, and one real signed delivery verified; a sandbox run of authorize, capture, void,
settled refund (after the nightly batch), a held transaction and profile use; the production remote (`usageCode` P,
production endpoint) entered by an administrator; PCI scope review of the page serving AcceptUI.

### P2 — PayTrace (implementation record, 2026-11-02)

The PayTrace gateway on the Phase 0 contracts and P1's patterns, revised after an independent review (the fixes are
folded into the design below). Nothing is committed yet. The gateway is in mr-mantle; the review's network guard for
test runs is in mr-moqui (amending Phase 0, see its record).

**Source and API baseline.** Ported from [mantle-paytrace](https://github.com/moqui/mantle-paytrace/tree/5dbe616) 1.0.3,
commit `5dbe616` (CC0 with the patent grant, written by David E. Jones, Anderson Urrego Restrepo and Michael Jones; the
new files' headers keep the dedication and name them, and Mantle's `AUTHORS.md` is left to its signers): the vault payment
operations, the response code mapping (101..125 success and decline sets, errors 35/43/44), the level 3 mapping from the
order lines (customer PO, tax, freight, discounts, quantities, the UoM table, item data) and the transaction status map.
Not ported: the v1 paths and password grant, raw-card vault requests and the `create#`/`update#CreditCard` SECAs that sent
card numbers, the user-preference gateway selection, the brand-split level 3 endpoints and the request/response logging.
Wire protocol: PayTrace JSON API v3, from the OpenAPI schema published at `https://api.paytrace.com/v3/openapi.json`
(info.version 3.5.1, SHA-256 `7a41ee2f…b5c3`; the sandbox's is 3.5.2 with the same card, vault, export and enhanced data
paths, the production one adding four PAX terminal paths), read 2026-11-02, with the
[B2B integration guide](https://developer.north.com/b2b/integration-guide) and the
[Enhanced Data guide](https://paytrace.atlassian.net/wiki/spaces/HD/pages/4941905959/Integration+Guide). Used:
`POST /v3/token` (form encoded `grant_type=client_credentials`, `client_id` the API user, `client_secret` its password;
the answer `access_token`, `expires_in`), the `X-Integrator-Id` header (max 12), the `data` wrapper of every answer,
`/v3/card/authorize|sale/pt-protect` and `/customer/{id}`, `/v3/card/batch/capture` and `/batch/void`,
`/v3/card/refund-auth/by-transaction/{id}`, `GET /v3/card/transaction/{id}?merchant_id=`,
`GET /v3/card/transactions/capturable/{merchant_id}`, `/v3/transactions/export/by-date` (`including_text`; error 180
none found), `/v3/customer/create/pt-protect`, `GET`/`DELETE /v3/customer/{id}`, `/v3/payment-fields/token` (the
Protect.js client key) and `PUT /v3/invoice/by-transaction-id/{id}` (Enhanced Data; 170 and 171 accepted).

**Changed artifacts.**

- mr-mantle, new: `service/mantle/ext/account/gateway/PayTrace.js` and `PayTraceServices.xml` (the five gateway services and
  `authorizeAndCapture#Payment`, `send#`/`retry#EnhancedData`, `store#`/`delete#CustomerPaymentProfile`,
  `get#BrowserPaymentConfig`, `submit#BrowserPaymentToken`), `service/PayTrace.secas.xml` (a deleted method's vault
  customer), `service/mantle/ext/account/gateway/GatewayLib.js` (shared with P1, below), `data/PayTraceSeedData.xml` (seed:
  `PidtCommodityCode`), `data/PayTraceSetupData.xml` (seed-initial: the paused job `retry_PayTraceEnhancedData`),
  `data/PayTraceDemoData.xml` (demo: gateway `PayTraceDemo`, remote `PayTraceSandbox`, no credentials, merchant or
  integrator id), `docs/PayTrace.md`, `docs/examples/PayTraceProtect.html`, `test/ext/PayTraceGateway.spec.js`.
- mr-mantle, changed: `entity/PaymentGatewayEntities.xml` (`PaymentGatewayPayTrace`: `merchantId`, `integratorId`,
  `currencyUomId`, `lookupGraceSeconds`, `sendEnhancedData`, `commodityCode`, `defaultUnitOfMeasure`,
  `customerLabelPrefix`; seed `PgtPayTrace`), `service/mantle.rest.xml` (`my/payments/{paymentId}/payTrace` GET and
  POST), `service/mantle/ext/account/gateway/AuthorizeNet.js` (onto `GatewayLib.js`, behavior unchanged), `docs/AuthorizeNet.md`
  (one line), `test/ext/AuthorizeNetGateway.spec.js` (the cleanup below). `PaymentServices.xml` is unchanged.
- mr-moqui: `crates/moqui-core/src/service/http_fixtures.rs` (the closed test run, `allowNetwork`, `reset`),
  `http_fixtures_tests.rs` (its test), `crates/moqui-core/src/outbound.rs` (the check in `send_inner` and `open_inner`),
  `docs/Build-Test.md` ("HTTP fixtures").

**Design.**

- *Shared code.* `GatewayLib.js` holds what both adapters use, moved out of `AuthorizeNet.js`: the response record with
  every flag and the refusal, the operation start, amounts in the provider's form, the original transaction, other refunds,
  the last details status, the lost response and its grace, the billing contact of a method, the new card method, the
  browser endpoint checks (`browserPayment`: payer or treasury, gateway, method of the same gateway, open status), the
  page state, the operation id check, and `submitBrowserToken` (lock and recheck, `begin#PaymentGatewayOperation` before any
  profile, the payer's consent, a declined new card's profile deleted) and `dispatch`. P1's 15 features pass unchanged.
- *Authentication.* The token is cached in the process cache `mantle.ext.account.gateway.PayTrace.accessToken` by remote, endpoint
  and user until a minute before `expires_in` (900 when absent, the documentation's smallest), sealed: XORed with a
  keystream of `ec.user.singleUseCodeHash` (the conf's hash type, SHA-256 by default) of the remote's password, a random
  nonce and a block counter, so the Tools cache screen (which lists values) shows hex no one can use without the
  password. A token that does not unseal (another password or hash type since) is asked for again. It is never recorded
  or logged. A 401 on a request takes a new token and sends that request once more (a 401 is refused before processing,
  so it cannot charge twice); a second 401 is resultError. Credentials the token endpoint refuses, and a second 401 with
  a fresh token, are not sent again for 60 seconds. The integrator id is an option (at most 12 characters, checked), not
  a secret; the API user's password is the remote's encrypted `password`. The cipher is this module's construction from
  the framework's hash, chosen as the least invasive store the Tools screen cannot read; a framework store for
  short-lived secrets would replace it.
- *Card data.* Protect.js `hpf_token`/`enc_key` (the `paymentToken` input) or the vault customer; no card number and no
  security code (v3 takes a CSC only e2ee-encrypted, so `cardSecurityCode` is not sent). PayTrace keeps one card per vault
  customer: `customer_id` is `gatewayCimId`, the `customer_label` Mantle gives (`customerLabelPrefix`, `mantle-` and the
  method id, the method made first so its id names it) is `gatewayCustomerId`. The card record keeps the masked number
  and expiry from `GET /v3/customer/{id}`; the type is not given there and stays empty.
- *Identity.* No idempotency key for card transactions in v3 (the schema has one only for ACH): the 32-character key goes
  in `invoice_number` and starts `description`. A transport failure, 408, a 5xx, an unreadable answer, a 2xx answer with
  neither a response code nor an ErrorSchema error (the capture batch has no 200 schema), response code 1 and the
  duplicate block 777 are resultUnknown: never resultError, which the contract treats as safe to send again. The lookup
  of a lost authorization, sale or refund is the export by date (from a day before the lost request to a day after now,
  `MM/DD/YYYY` in the user's zone) with the key as `including_text`; error 180 is none found. Each candidate whose
  `description` starts with the key (up to five) is read by id; `invoice_number` is not compared, as an enhanced data PUT
  overwrites it. The export's `approval_code` is the found authorization's. Not found answers `operationFound` false
  after `lookupGraceSeconds` (default 300); a failed search leaves it unknown. A lost capture or void reads the
  authorization's transaction. A capture or void refused for its state (816, 818) whose transaction is already there is a
  success (`ALREADY_CAPTURED`, `ALREADY_VOIDED`).
- *Outcomes and status.* 101/106/108/109/112/167 success, 102 and 103 declined, errors 35 bad card, 43/44 bad expiry,
  778/779/790 declined, other errors resultError, wherever the HTTP status (a refusal may come as 4xx with the error
  list, or `{detail: [...]}` from request validation). An approval whose `total_amount` differs from `requested_amount`
  (surcharging) keeps its success with `transactionStatus` `AMOUNT_MISMATCH` and a warning. The record's `status` and
  `action`: `A` with `action` exactly `auth_only` authorized, any other `A` and `L` Delivered, `S` Confirmed, `V`/`R`
  voided (Void for an authorization), `D`/`F` Declined; P, I, Z, N leave the payment. Because PayTrace's status after a
  capture is not documented, a payment that is Delivered, Confirmed or has an approved capture is never taken back to
  Authorized (nor Confirmed to Delivered); and when the record still reads `A`/`auth_only`, the capturable list decides
  whether it was captured, for a lost capture's lookup and for a capture refused with 816 (a list that cannot be read
  leaves the outcome unknown, never an error). Settlement time only when `status_changed_at` carries its zone.
- *Refunds.* As P1: settled, the refund authorization by transaction id (a transaction of its own with the reference,
  so a lost refund is found by its key); captured and unsettled, a whole-amount void recorded as the refund
  (`VOID_BEFORE_SETTLEMENT`, `altReference` the original), "whole" compared with Mantle's own approved capture amount; a
  part before settlement refused (`REFUND_BEFORE_SETTLEMENT`). No unlinked credit.
- *Currency.* PayTrace amounts carry no currency: `currencyUomId` is the account's, and another currency is refused
  (`CURRENCY_NOT_SUPPORTED`). Amounts must round to the currency and have at most two places, else `AMOUNT_INVALID`.
- *Enhanced data, a separate outcome.* An approved capture or sale (and a lookup that finds a lost one captured)
  registers `send#EnhancedData` to run after its transaction commits (`ec.service.special().registerOnCommit()`, on a
  service thread): the PUT and its recording are in a transaction of their own, so they never fail, roll back or hold the
  lock of the charge, and a keyed retry of the charge replays it. The invoice (`forInvoiceId`) or order part lines become
  one Enhanced Data PUT. Each line's amount is quantity times unit (unit amount times selected amount for an order)
  rounded to the currency; its tax and discount children are its `item_tax_amount` and `discount_amount`
  (`item_total_amount` = amount less discount); shipping lines and their children are freight; tax lines are tax;
  top-level discounts and negative lines are the summary discount; other children are their own lines; VAT (not in
  totals) and cancelled quantities are left out. Quantity times `unit_cost` is always the line's amount: the unit amount,
  else rounded to the currency, else one unit of the line's amount. Level 3 is sent when the line totals less the
  discount plus freight and tax equal the captured amount (the guide's balancing rule), else level 2 (customer reference
  and invoice number, as a partial payment's lines do not describe it). `customer_reference_id`, required for both, is
  the customer PO, else the invoice or order id. Tax 0 is sent as `-1` (tax exempt) as the source did. The outcome is its
  own `PgoLevel3Data` response (`transactionStatus` level3/level2): accepted only for 170 or 171; else resultError with
  `ENHANCED_DATA_REJECTED` (PayTrace's error ids in `responseCode`), `ENHANCED_DATA_UNCONFIRMED`,
  `ENHANCED_DATA_NO_ANSWER`, `ENHANCED_DATA_NOT_SENT` or `ENHANCED_DATA_FAILED` (building the data threw). Never
  resultUnknown, which would block the payment. `send#EnhancedData` sends it again (a full overwrite, which the schema
  calls idempotent) for a Delivered payment, refusing one voided before settlement (`TRANSACTION_VOIDED`).
  `retry#EnhancedData` (job `retry_PayTraceEnhancedData`, paused) sends it for each captured, unsettled payment with an
  order or invoice whose latest one was not accepted, or that has none (an after-commit send that did not run), at most
  `maxAttempts` (5) sends a payment and never for a capture voided before settlement, each in its own transaction.
- *Browser.* `get#BrowserPaymentConfig` makes a Protect.js client key per page (valid 20 minutes, a browser key never
  kept or logged) and gives the script of the remote's environment (`protect.sandbox.paytrace.com` /
  `protect.paytrace.com`); `submit#BrowserPaymentToken` takes `hpfToken`, `encKey`, `savePaymentMethod`, `operationId`.
  The example page is static (no qvt/tui surface), as P1's.
- *No webhooks.* PayTrace has no card transaction webhook in v3 (`silent_post` is for Trace AR invoices); the poll job
  is the path after the call.

**Review findings rejected or partly taken.** None of the must-fix items was rejected. Not done: limiting
`get#BrowserPaymentConfig`'s client key creation per payment against error 790 (one key per page load is PayTrace's
documented flow; a deployment that hits the limit can cache keys per payment for their 20 minutes); limiting
PaymentGateway's poll feature to its own gateway (the closed test run makes it unnecessary).

**Not verifiable from public documentation** (built on the best documented shape, to confirm in the sandbox):

- The schema's 200 answers show no examples for single transactions; the shape used is the documented
  `TransactionResExternal` in the data wrapper. Whether a decline comes with HTTP 200 or 4xx is not stated; both are read.
- The transaction record's `action` values other than `auth_only`, and which `status` a captured authorization has (the
  guards above keep a captured payment captured either way); what the capturable list's `search_term` matches (the id
  is compared on each row it returns, and a list that cannot be read leaves the outcome unknown).
- Whether a refund authorization works for every brand (the tag text says Visa, Mastercard and Discover for now), and
  whether the batch capture answers the original's transaction id (the example does).
- What `including_text` searches, and the export's time zone for `start_date`/`end_date` (hence a day's margin).
- Level 3 balancing: the guide's formula (line totals less discount plus freight and tax equal the amount) is used,
  while the schema's `item_total_amount` text says the line totals alone must equal the transaction amount; and how line
  `item_tax_amount` relates to the summary `tax_amount`. Also the rules that quantity and unit cost be below the
  transaction amount, which PayTrace checks and a rejection records.
- Whether auth-only transactions take enhanced data (the API text says sale or auth-only, the guide sale or capture only:
  Mantle sends after the capture).
- The token answer's `expires_in` (the example shows 900; the guide says two hours).

**Fast checks run** (after the review fixes). `./moq test mr-mantle --spec PayTraceGateway` (13 features passed, each
0.03–0.54 s): approval and capture with the reference, integrator id and redacted bearer token, and a poll still reading
A/auth_only leaving it Delivered; decline, fraud block and bad card; a 2xx answer with no response code unknown (and
blocking), a `{detail: [...]}` validation refusal, 816 on a no-longer-capturable authorization ALREADY_CAPTURED and on a
capturable one an error; release and "already voided"; settled refund, void before settlement and the refused part;
vault customer create/use/delete; a lost authorization found by the export, and one with error 180 not done and sent
again with the same key; the duplicate block, and a lost capture found through the capturable list; the token cached
and sealed, a 401 renewed once with one approval, a second 401 not sent a third time and then nothing sent for a
minute, an expired cached token replaced; order lines to level 3 with the balance checked, invoice lines with the
invoice id as customer reference and a 3 × 0.125 line sent as 1 × 0.38, and level 2 for a partial payment, all after the
charge's commit; rejected enhanced data recorded apart from the capture and accepted on `send#EnhancedData`, a lost one
and a never-sent one found by `retry#EnhancedData` within `maxAttempts`, a sale voided before settlement refused and
left by the job, seven charge requests in all; the browser endpoints with the REST path, the payer keeping the card and a
refused customer; no token, card number or secret in a response, method, card or system message. `./moq test mr-mantle
--spec
GatewayContracts,PaymentGateway,AccountingPaymentGateway,AccountingPaymentRefunds,AccountingPortals,AuthorizeNetGateway,PaymentMethodServices,AccountingReturns,AccountingPaymentLifecycle,PayTraceGateway`
(10 specs, 107 features passed); `./moq test mr-mantle` (156 specs, 1421 features passed, no request refused by the
closed test run); `./moq test mr-boss --spec
MailSignIn,CalendarSettings,Unsubscribe,MailAccounts,Calendar,Inbox,Chat,AccountingPaymentGateway,AccountingPaymentRefunds`
(86 passed, 3 skipped for imap in the Dev package) and `./moq test --debug mr-boss --spec
MailSignIn,MailAccounts,Inbox,CalendarSettings` (45 passed); `./moq test mr-pass --spec Transport,SsoHandoff,Operations,Forum`
(25 passed); `./moq test basic-comms` (40 passed); none of these logged a refused request. `cargo test -p moqui-core`
(1302 + 16 passed, 5 ignored; `a_closed_test_run_refuses_all_but_loopback_and_opened_prefixes` new); `cargo clippy -p
moqui-core -p moqui-host --all-targets -- -D warnings` (clean); `./moq build`. The PayTrace and Authorize.Net specs'
console at `--log-level debug` contains none of the tokens, client keys, access tokens or secrets. `moqui lint` of
`PayTraceServices.xml`: clean. Prettier (with `--ignore-path=`) on the three modules and both specs; `xmllint --format`
with a canonical comparison on the new XML files. No slow test was run.

**Found on the way.** In one run of several specs, the PayTrace and Authorize.Net specs' payments stayed Authorized or
Delivered with references, and PaymentGateway's poll job, after the fixtures were reset, sent their lookups to the real
sandboxes with spec credentials (the PayTrace one 401'd once per payment, 9 s). The framework now closes a test run to
the network (Phase 0 amendment), and both specs also clear their remote's `sendUrl` in `cleanupSpec` as defense in depth.

**Known limits.**

- The response is written in the caller's transaction (Phase 0 limit); PayTrace has no card idempotency, so after a local
  rollback a keyed retry sends again, and only its duplicate block (777, the merchant's setting) or the reference lookup
  catches it.
- The token cache is per process; the sealing protects it from the cache screen, not from code that reads the remote's
  password.
- `merchant_tax_id` and `customer_tax_id` (the source sent FEINs in v1) need PayTrace's e2ee encryption and are not
  sent; PayTrace uses its merchant setup and data on file. `source_address` is left to PayTrace's merchant default.
  Commodity codes come from `PidtCommodityCode` identifications or one gateway default; national tax, duty and the
  other processor-managed fields are PayTrace's.
- The level 2/3 decision is all or nothing per capture; a partial capture of a multi-part order sends level 2.
- Enhanced data that PayTrace never accepts stays a visible error after `maxAttempts`; there is no operator screen
  beyond the gateway response lists, and the retry job is paused by default.
- No ACH, recurring, Trace AR invoices, terminal/EMV, adjust or the e2ee library; a legacy method with a full card
  number and no vault customer is refused, as in P1.
- One card per vault customer: a party's cards are separate vault customers.

**Deployment gate.** Sandbox access and an integrator id from PayTrace (an external prerequisite: the sandbox request
form, about five business days) and the account's security settings matched to production (required fields such as
billing ZIP or invoice). A sandbox run of authorize, capture, void, settled refund, vault use, a decline, a lost answer
looked up, a Protect.js page and an enhanced data submission accepted and one rejected, checking the unverified points
above (decline HTTP status, `action` values and the status after a capture, the capturable list search, export search,
refund authorization brands, the level 3 balancing rule, token lifetime). The production remote (`usageCode` P,
`https://api.paytrace.com`) entered by an administrator; enable `retry_PayTraceEnhancedData`; PCI scope review of the
page serving Protect.js. Passing these specs is not PayTrace certification.

### S1 — Shippo (implementation record, 2026-11-02)

The Shippo shipping gateway on the Phase 0 shipping contract and the P1/P2 patterns. Nothing is committed yet; the
record names the artifacts per repository.

**Source and API baseline.** Ported from [mantle-shippo](https://github.com/moqui/mantle-shippo/tree/2356f07) 1.2.1,
commit `2356f07` (CC0 with the patent grant, written by David E. Jones and Michael Jones; the new files keep the
dedication and name them): the address map (name and company from attnName/toName or the party, street1 with the unit,
ISO alpha-2 state and country, ZIP+4, the address's or the party's shipping phone and email, the shipper's phone for a
destination with none), the parcel (box dimensions and their unit, the gateway's box template override, the package's
weight else the box's default), carrier accounts (`ShippingGatewayCarrier.gatewayAccountId`) and service levels
(`ShippingGatewayMethod` over `CarrierShipmentMethod.gatewayServiceCode`), one Shippo shipment per package with the
cheapest rate of the service level, the store's label name and company, the return address (`address_return`, and
`is_return` from it for a return label), `reference_1`/`reference_2`, signature confirmation, third-party billing,
insurance and its estimate, and the tracking status map. Not ported: the `SgoApiToken` option (the token is the remote's
encrypted password), the hard-coded `api.goshippo.com` host, the FedEx-only rate path (every label is now bought by a
fresh rate), the anonymous `/rest/s1/shippo/track` endpoint and its full-context logging, request and response logging,
the `'USD'` insurance default, the reuse of `PostalAddress.shipGatewayAddressId` as the shipment's address (not scoped to
an account or mode) and the rewrite of a validated address. Wire protocol: the Shippo REST API with
`Shippo-API-Version: 2018-02-08` on every request and `Authorization: ShippoToken <token>`: `POST /shipments`
(`async: false`, read again once with `GET /shipments/{id}` while QUEUED/WAITING), `POST /transactions` (`rate`,
`label_file_type`, `metadata`, `async: false`), `GET /transactions/{id}`, `GET /transactions?rate=` and
`?object_created_gte=` (UTC, no offset; `results` 100, `next` followed up to five pages and only on the configured
base), `GET /rates/{id}`, `POST /refunds` (`async: false`) and `GET /refunds/{id}`, `POST /addresses` (`validate: true`).
References read 2026-11-02: the [API reference](https://docs.goshippo.com/api-reference/overview) (transactions,
refunds, tracking status, shipments), [versioning](https://docs.goshippo.com/api-concepts/api-versioning) (the header
sets the API and webhook behavior; the account default otherwise), [asynchronous calls](https://docs.goshippo.com/api-concepts/asynchronus-api-call),
[webhooks](https://docs.goshippo.com/docs/tracking/webhooks) (`event`, `test`, `data`; no event id; two retries on 408,
429 or 5xx; a 2xx within three seconds) and [webhook security](https://docs.goshippo.com/tracking/webhook-security).
The versioning page carried "agent instructions" naming MCP servers; they were not followed.

**Changed artifacts.**

- mr-mantle, new: `service/mantle/ext/shipment/Shippo.js` and `ShippoServices.xml` (the eight carrier interfaces and
  `receive#`/`consume#Webhook`), `data/ShippoSetupData.xml` (seed: the options group and SystemMessageType
  `ShippoWebhook`), `data/ShippoDemoData.xml` (demo: gateway `SHIPPO_DEMO` in test mode, remote `ShippoSandbox`, USPS,
  UPS, FedEx and DHL Express with empty carrier accounts, the USPS ground override `usps_ground_advantage`, three USPS
  flat-rate box templates; no token, secret or account id), `docs/Shippo.md`, `test/ext/ShippoGateway.spec.js`.
- mr-mantle, changed: `entity/ShippingGatewayEntities.xml` (seed `ShGtwyShippo`, `SgoLookupGraceSeconds`; on
  ShipmentPackageRouteSeg `gatewayShipmentId`, `gatewayAmountUomId`, `labelFileType` and their `return*` fields),
  `service/mantle/shipment/Shipping.js` (`finishPending`; the refusals `CONFIG_INVALID`, `PARCEL_INVALID`,
  `RATE_EXPIRED`, `REFUND_REFUSED`, `RATE_LIMITED`, `RATES_NO_ANSWER`; a succeeded request's `amountUomId`),
  `WarehouseTaskServices.xml` (`finish#PendingLabelRequests`), `CarrierServices.xml` (`remove#ShipmentLabelInfo` and
  `remove#ShipmentReturnLabelInfo` clear the new fields), `data/ShippingSetupData.xml` (the paused ServiceJob
  `finish_PendingLabelRequests`, every ten minutes).
- mr-moqui: `crates/moqui-core/src/service/system_sync/message.rs` (`SmatUrlToken`: exactly one query parameter,
  `authHeaderName` else `token`, equal to `sharedSecret` in constant time; refused with an empty secret; and, after the
  review, a timestamped HMAC's replay key given back when the message is not kept) and `tests.rs` (their tests), `runtime/base-component/framework/entity/ServiceEntities.xml` (the enumeration),
  `docs/security/Attack-Surface.md` (the receive table).

**Design.**

- *Webhook authentication.* Shippo's HMAC (`Shippo-Auth-Signature: t=<seconds>,v1=<hex>`, lower-case hex HMAC-SHA256 of
  `<t>.<raw body>` with the shared secret) is exactly `SmatHmacSha256Timestamp`, which adds the five minute window and
  replay cache Shippo's own script leaves out; no new HMAC scheme. Because HMAC is set up through Shippo's team (up to ten
  business days) and not every account has it, the self-serve URL token got the small generic scheme `SmatUrlToken`.
  IP allowlisting is a network-edge setting, not checked by Mantle. `receive#Webhook` refuses a remote that has neither
  scheme or no secret (`WEBHOOK_UNAUTHENTICATED`), so the endpoint cannot be left open; polling works without webhooks.
- *Receipt.* Shippo sends no event id: each event is kept once per remote and body (`messageId` `shippo-` and the
  conf's single-use hash of the body, `store#ReceivedSystemMessage`). `consume#Webhook` finds the packages among the
  shipments of the Shippo gateways on the message's remote (the transaction id, the rate, the request id in the
  metadata, else the tracking number), finishes a package's open request through `finish#PendingLabelRequests` (any
  reason, so a lost purchase the event proves is resolved too) and otherwise tracks the package from its transaction.
  The payload is never applied: a `track_updated` event of the status read adds only its substatus and date. An event
  whose `test` flag differs from the remote's `usageCode` is ignored. One package that fails is logged and the message
  fails, to be retried.
- *Identity.* Shippo has no idempotency key for transactions (the transaction reference lists none; only the
  Automations label endpoint takes `Idempotency-Key`). The request id is sent in the transaction's (and shipment's)
  `metadata` with the package; the rate is recorded on the package before the purchase in its own transaction. A lost
  purchase (timeout, reset, 408, 5xx, unreadable answer) throws `CARRIER_TIMEOUT`, which Shipping.js keeps Unknown; the
  lookup searches by the recorded rate, then by creation date from 15 minutes before the request was first sent,
  matching the metadata. Not found within `SgoLookupGraceSeconds` (300) of the first attempt (`firstSentDate`, new on
  ShippingGatewayRequest, set at the first claim and never moved by later asks) is pending; after it, found false, and a
  person's next request buys (the driver never does). A send that finds the
  package RATED or QUEUED at a rate with a transaction takes that transaction instead of buying (also for `sendAgain`).
  A rate request that gets no answer bought nothing: `RATES_NO_ANSWER`, a refusal.
- *Outcomes.* SUCCESS fills the label in its own transaction (Shipping.js reads it after); QUEUED/WAITING is pending
  (`gatewayStatus` QUEUED); ERROR is `ADDRESS_INVALID` when Shippo's messages are about the address, `RATE_EXPIRED` for a
  stale rate, else `LABEL_REFUSED`; 400 the same codes, 429 `RATE_LIMITED`. A service with no rate is
  `METHOD_UNAVAILABLE`, a missing carrier account `CONFIG_INVALID`, a parcel with no weight, dimensions or unit
  `PARCEL_INVALID`. Several packages in one call (the direct `CarrierServices` path) each run on their own, the first
  refusal thrown after the others; Shipping.js calls one package at a time.
- *Charge and currency.* The bought rate's `amount` is the estimated, base and actual amount and its `currency` is
  `gatewayAmountUomId` (and the request's `amountUomId`); a currency other than the segment's or shipment's cost currency
  is noted (`CURRENCY_DIFFERS`) on the package, not converted. An order rate in another currency than the order's is
  refused (`CURRENCY_MISMATCH`). Insurance is stated in the shipment's cost currency, else left out with a warning.
- *Label files.* The label is downloaded from `label_url` with no Shippo credentials (the token goes only to the
  remote's base, also when following `next`); a link that fails is asked for again from the transaction; a label not
  downloaded keeps its link and `LABEL_IMAGE_MISSING`, and tracking downloads it later.
- *Pending driver.* `finish#PendingLabelRequests` (Shipping.js `finishPending`) runs each request Unknown with
  `LABEL_PENDING`, `CARRIER_TIMEOUT` or `CARRIER_NO_ANSWER` (answered more than `minAgeSeconds` ago, first sent within
  `maxAgeDays`) again through `request#`/`refund#PackageLabels` with the new `lookupOnly`: only a request without an
  answer is asked about, no request is made and nothing is sent, and a label the gateway has no record of ends Unknown
  with `NOT_FOUND` (not one of the job's reasons) for a person to request again. It runs as the request's own user
  (`internalLoginUser`; `USER_UNAVAILABLE` unless that sign-in succeeds and is that user), with an operation key per
  attempt (`pending-<request>-<attempt>`), so the user's permission and facility scope apply. The framework's `as_user`
  (a context of its own) is Rust-only, so the run signs in and out on the caller's context: the service refuses a web
  request (`NOT_ALLOWED`) and is meant for the job and the webhook's consume, both on worker threads with no session.
  The job is paused by default, as the payment polls are.
- *Rates.* `get#ShippingRatesBulk` (Warehouse's RateOptions), `get#OrderShippingRate` and `get#ShippingRate`: one
  shipment per package, a method kept only when every package has a rate for it in one currency (the source summed
  partial rates).
- *Addresses.* `validate#ShippingPostalAddress` sets the trust level (valid, invalid, incomplete), the validation
  messages and `shipGatewayAddressId`; a provider failure is a warning, so order entry does not depend on Shippo.

**Not verifiable from public documentation** (built on the documented shape, to confirm in test mode):

- The 400 error body's shape (the schema is an open object); refusal text is read from it and from `messages`.
- Whether `async: false` can still answer QUEUED/WAITING (handled), and how long a synchronous purchase may take
  (the client timeout is 40 seconds; a longer one is a lost answer, looked up).
- Rate expiry and its message (the refusal code comes from the text), and whether a refund of a refunded label is a
  400 (the label's transaction status is read then).
- Whether a parcel with only a `template` needs dimensions too; the transaction list's ordering and how soon a new
  transaction is listed (hence the grace); whether Shippo's webhook retries are signed again with a new timestamp (a
  retry older than five minutes with the first signature would be refused and need the poll).
- Service level tokens of the demo data (`usps_ground_advantage` replaces the retired `usps_first`).

**Fast checks run.** `cargo test -p moqui-core --lib system_sync` (11 passed, the new
`a_url_token_receive_needs_the_one_query_token_equal_to_the_shared_secret` included); `./moq build`; `./moq test mr-mantle
--spec ShippoGateway` (9 features passed, each 0.03–0.34 s): address validation (valid with Shippo's id, rejected with
its message; the version header and the redacted token); a two-package rate with a service one package lacks left out,
and an order part's rate; two labels bought with every id, the label file, charge and currency and the metadata,
tracked to transit by the poll and to delivered by a `track_updated` webhook kept once; one package's refused label
(`ADDRESS_INVALID`) beside the other's label (PARTIAL); a queued label retrieved by the job with an expired label link
asked again, one purchase; a waiting label finished by the transaction webhook, the duplicate delivery kept once, a
`SmatNone` remote refused and an event of the other mode ignored; a lost purchase found by its rate and metadata (one
purchase) and one not listed yet pending within the grace; a queued refund finished by the job and an immediate one; no
token or secret in a package, request or message. `./moq test mr-mantle --spec
ShippoGateway,CarrierServices,WarehouseShipping,WarehousePacking,ShipmentReturnMisc,WarehouseReturns,ShipmentPick` (10
specs with their dependencies, 97 features passed); `./moq test mr-mantle` (157 specs, 1430 features passed, no data
file skipped, no request refused by the closed test run). `cargo test -p moqui-core` (1303 + 4 + 12 passed, 3 + 2
ignored; two earlier runs under load each failed one unrelated timing-sensitive test, `chat_tests` and
`load_feed_tests`, which pass alone and in the third run); `cargo clippy -p moqui-core --all-targets -- -D warnings`
(clean). `moqui lint` of `ShippoServices.xml`, `WarehouseTaskServices.xml` and `CarrierServices.xml`: clean. Prettier (with
`--ignore-path=`) on `Shippo.js`, `Shipping.js` and the spec; `xmllint --format` with a canonical comparison on the new
XML files. No slow test was run.

**Known limits.**

- No customs declarations, manifests, pickups, batches or multi-piece shipments (one Shippo shipment per package); these
  are the plan's extensions.
- No idempotency at Shippo: two Mantle requests with different references for one package (a person's `sendAgain` after
  a failed lookup) can buy twice; the rate guard catches the common case only.
- The lookup's date search covers five pages of 100 transactions from 15 minutes before the request; a busier account
  needs the rate search (always tried first) to find it.
- The dedup key is a hash of the body, so a delivery whose body differs (a re-sent event with a new `object_updated`)
  is a new message; consuming converges by lookup, so it repeats no effect.
- The URL token is in the URL, so it can reach a proxy's access log; HMAC is preferred where Shippo enables it.
- Webhook bodies are kept as SystemMessages (addresses and tracking); their retention is the deployment's SystemMessage
  schedule (docs/Shippo.md).
- Tracking reads the transaction's status, not the Track object (`GET /tracks/{carrier}/{number}` needs Shippo's carrier
  token, which Mantle does not keep); substatus and details come only from a matching webhook.
- A validated address is not rewritten with Shippo's corrections (the source cloned it); only its trust level and message
  change.
- The pending-label job is paused by default; a request whose user cannot sign in or lost the permission stays without
  an answer and is named in the job's result each run until `maxAgeDays`.
- The driver's web refusal reads `ec.web.request`: a script calling it on a thread that holds a web request is refused,
  others are trusted to be the job or the consume (the service is `allow-remote="false"`).

**Review fixes (after an independent review, 2026-11-02).** All must-fix and should-fix findings were taken:

1. The lookup's grace and date window, and the driver's `maxAgeDays`, run from the new `firstSentDate` (the first claim),
   not from `requestDate`/`sentDate`, which every ask moved: a lost purchase Shippo never made no longer stays pending
   forever. Spec: a lost purchase past a grace of 0 (`SgoLookupGraceSeconds`), its `firstSentDate` unchanged by the asks.
2. The webhook consume finds a package's gateway as the label flow does: the gateway of its latest label, return label or
   refund request, else Shipping.js `gatewayOf` (the store's ProductStoreShippingGateway first), not the segment's field
   alone. Spec: a store-bound shipment whose segment names no gateway is tracked by its webhook.
3. `finishOne` refuses (`USER_UNAVAILABLE`) unless `internalLoginUser` succeeds and the user is the request's (a disabled
   account no longer runs as the caller), inside its own error frame; the run restores the caller's user. Spec: a disabled
   user's request is left alone and the caller stays signed in.
4. The driver and the webhook are lookup only (`lookupOnly`): no purchase without a person; not found is `NOT_FOUND`.
5. `finish#PendingLabelRequests` refuses a web request (`NOT_ALLOWED`); with `allow-remote="false"` that leaves the job and
   the consume.
6. Only `ERROR` is a refusal; another status of a 2xx transaction answer is `CARRIER_NO_ANSWER`, looked up.
7. `remove#ShipmentLabelInfo` also clears the charge, insurance, label date, substatus and estimates, and both removes the
   return equivalents (no caller relies on them: Shipping.js replaces a refunded label, Marble's screens remove one).
8. Every spec feature makes its own shipments (the refund and secrets features no longer use earlier features' state;
   the job features run on gateways of their own); each passes alone with `--feature`.
9. `SmatUrlToken`'s parameter is `authHeaderName` (else `token`): the demo comment, docs/Shippo.md and Attack-Surface.md
   say to set it to `token` (or clear it) and to use a URL-safe token.
10. An order rate in another currency than the order's is refused (`CURRENCY_MISMATCH`) whether or not an item is made.
11. The driver's default reasons are `LABEL_PENDING`, `CARRIER_TIMEOUT` and `CARRIER_NO_ANSWER`.
12. The direct several-package path throws a lost answer before a refusal, and `LABEL_PENDING` when a package is pending
   beside a failure (labels and refunds).
13. Framework: a timestamped HMAC delivery whose receive fails gives its replay key back (`message.rs`), so the
   provider's retry is taken; Rust test
   `a_timestamp_hmac_message_not_kept_gives_its_replay_key_back_so_the_retry_is_taken` (a Shippo-shaped
   `Shippo-Auth-Signature`).
14. A lookup whose `GET /rates` fails keeps the recorded charge and currency (the amounts are written only when the rate
   was read); insurance values are untouched there.
15. The insurance estimate is rounded to its currency (`lib.money`).
16. `object_created_gte` is sent with `Z`.
17. `ShippoServices.xml` lost the runs of spaces that `xmllint --format` had left in the `from` attributes.
18. An event with no boolean `test` flag is consumed (authenticated, and consuming only reads the account's own state);
   documented, with the retention note.

Checks after the fixes: `cargo test -p moqui-core --lib system_sync` (12 passed); `cargo fmt -p moqui-core --check` shows
nothing in `system_sync` (P1's two leftover hunks in `tests.rs` fixed); `cargo clippy -p moqui-core --all-targets -- -D
warnings` (clean); `./moq test mr-mantle --spec ShippoGateway` (12 features passed, each under 0.35 s; the refund, secrets
and grace features also pass alone with `--feature`); `./moq test mr-mantle --spec
ShippoGateway,CarrierServices,WarehouseShipping,WarehousePacking,ShipmentReturnMisc,WarehouseReturns,ShipmentPick` (10
specs, 100 features passed); `./moq test mr-mantle` (157 specs, 1433 features passed, no data file skipped); `cargo test
-p moqui-core` (1304 + 4 + 12 passed, 5 ignored); `moqui lint` of the three service files and Prettier (with
`--ignore-path=`): clean. No slow test was run.

**Deployment gate (go-live).** A Shippo account with production capability (billing set up) and the carriers' approval
on Shippo for each carrier account used (UPS, FedEx and others need the shipper's own account connected and approved;
USPS needs its terms accepted); the live token on a production remote (`usageCode` P) entered by an administrator and
the gateway's `testMode` N; the carrier accounts' `object_id`s on `ShippingGatewayCarrier`; the webhook pointed at the
endpoint with HMAC enabled by Shippo (or a URL token) and one real delivery of each event verified; a test-mode run of
rate, label, return label, print, track, refund and a lost answer looked up, checking the points above; enable
`finish_PendingLabelRequests`. Passing these specs is not carrier certification.

### E1 — X12 business services (implementation record, 2026-11-02)

The common X12 port on the Phase 0 contracts (SystemMessageRemote connections, `store#ReceivedSystemMessage`, the HTTP
fixtures) and the P1/P2/S1 module patterns. Nothing is committed yet; the record names the artifacts per repository.
E2 (SPS Commerce), its worksheet and any partner mapping are not part of it.

**Source baseline.** Ported from [mantle-edi](https://github.com/moqui/mantle-edi/tree/134acb6) 1.1.5, commit `134acb6`
(CC0 with the patent grant, written by David E. Jones; the new files keep the dedication and name the source):
`EdiServices.xml` (receive, consume, 997 produce/consume, the X12 envelope), `order/X12OrderServices.xml` (850 consume,
855 produce, N1 segments), `shipment/X12ShipmentServices.xml` (856), `account/X12InvoiceServices.xml` (810),
`data/MantleEdiSetupData.xml` (the message type) and the `X12V4010TS{850,855,856,810,997}.groovy` grammars (as the
framework's converted fixtures in `crates/moqui-core/src/edi/testdata/mantle`, copied into Mantle; the framework test
files are not loaded at run time). Kept: the element positions, N1 roles and qualifiers, DTM qualifiers, the BAK/BSN/BIG
layouts and the 997 codes. Not ported: the receive's split that took the first GS and ST, `OrderBulkServices.store#Order`
for EDI (it creates parties and addresses from the payload), the remote chosen by `ISA06`, the framework ack per message
(`produceAckOnConsumed`), the tare-per-line 856 without SSCCs, the 855/810 `CA` unit and `PE` constants, and the
full-message logging. `X12Envelope.groovy` is not used: the envelope pass is X12.js's (below).

**Changed artifacts.**

- mr-mantle, new: `entity/EdiEntities.xml` (`EdiProfile`, `EdiProfileDocument`, `EdiProfileCode`, `EdiConnection`,
  `EdiLocation`, `EdiControlSequence`, `EdiInterchange`, `EdiGroup`, `EdiDocument` with their statuses, transitions and
  enumerations; `ShipmentPackage.sscc`), `service/mantle/edi/EdiServices.xml`, `X12.js`, `X12Lib.js`, `X12Documents.js`,
  `order/X12OrderServices.xml`, `shipment/X12ShipmentServices.xml`, `account/X12InvoiceServices.xml`,
  `x12/X12V4010TS{850,855,856,810,997}.js`, `service/Edi.secas.xml`, `data/EdiSetupData.xml` (seed: type `EdiX12`,
  permission `EDI_ADMIN`), `data/EdiSampleProfileData.xml` (seed-initial: the generic profile `X12_4010_SAMPLE`, the
  job `send_EdiPendingDocuments`, on), `docs/EdiX12.md`, `test/edi/EdiX12.spec.js`.
- mr-moqui: `crates/moqui-core/src/edi.rs` (MIN/MAX, order and leftover checks, positions per set, AK4's AK403) and
  `edi/tests.rs`, `crates/moqui-core/src/script/runtime/edi.rs` (`setSegmentSuffix`, `setPaddingChar`),
  `crates/moqui-core/src/service/system_sync/sftp.rs` and the new `sftp_tests.rs` (per-file poll), `tests.rs` (the
  re-received file), `framework/service/org/moqui/sftp/SftpMessageServices.xml` (`failedFileList`, the description),
  `framework/service/org/moqui/impl/SystemMessageServices.xml` (`duplicateOfId` on the `receive#SystemMessage`
  interface), `plans/Parity-Diffs.md` (the rows of these differences), and after the review
  `crates/moqui-core/src/service/pool.rs` (work counted active under the queue's lock, with its test).

**Design.**

- *Receipt before parsing.* `receive#X12Interchange` (the `EdiX12` type's receive service, behind `/rest/sm` or the SFTP
  poll) keeps the exact text, once per remote and content hash (`x12-` and the conf's single-use hash). Consuming it
  records every interchange; one that fails its envelope checks (ISA form and separators, ISA12 `00401`, ISA13, IEA01 and
  IEA02, segments outside a group, sender/receiver/application codes/usage other than the connection's, a remote with
  no `EdiConnection`) is quarantined with its text and reason, the receipt goes to SmsgError with a SystemMessageError,
  and the trusted interchanges of the same receipt are still processed. The connection (the authenticated remote) gives
  the organization (its store's), partner, profile and environment; payload IDs are only checked against it.
- *Batches.* The envelope pass (X12.js `tokenize`) splits ISA/GS/ST itself and keeps each set's exact text, because the
  handler's envelope-only parse puts body segments in the group's `originalList` with no set boundary. Each group and set
  is recorded with its parent controls; group errors (AK905 1-6) reject that group, set errors (AK502 1-4, 6, 7, 23) that
  set. Validation, the 997 and application then run per document or group, each in its own transaction, so one bad set
  or failed mapping does not touch its siblings, and a second consume resumes from the statuses.
- *Validation.* Each set is parsed on its Mantle grammar with `new EdiHandler(ec)` (the grammar as envelope and body,
  `\u0000` as the escape character since X12 has none), whose segment errors now include order and `MIN`/`MAX`; then the
  profile's element rules (required, type, length, code subset: AK4 codes 1-8), the N103/N104 and PO1 ID pairs, and the
  850's CTT01/CTT02/AMT*TT totals (reported as AK3/AK4 on the total, code 7). X12 4010 only: another GS08 rejects the
  group with AK905 2 (`UNSUPPORTED_VERSION`), another ISA12 quarantines the interchange.
- *Identity.* Controls sent come from `EdiControlSequence` (organization, partner, usage, direction, level), locked and
  incremented in the transaction that writes the outgoing SystemMessage, envelope and group; ST02 is `0001` (one set per
  group). An 850's `businessKey` (PO and release) and `contentHash` (segments without ST/SE) in the same scope make a
  resend a Duplicate (no order, linked) and changed content a Conflict (`PO_CONFLICT`, no change). The connection row is
  locked while a document is applied, so concurrent deliveries serialize.
- *Lifecycle.* Received: Stored, Validated/Rejected, Applied/Duplicate/Conflict/Exception. Sent: Pending (recorded by the
  SECAs on `update#OrderHeader` approved/cancelled/rejected, `update#Shipment` shipped and `update#Invoice` at the
  profile's `invoiceStatusId`, in the business transaction, with the record's next revision and older pending ones
  superseded), then Produced (body by the mapping service in its own transaction and checked on its grammar; envelope,
  controls and SystemMessage in one transaction) or Refused, Sent, and Accepted/AckRejected from the partner's 997 (which
  also confirms or rejects the SystemMessage). `send#PendingDocuments` runs after the commit (`registerOnCommit`, unless
  `sendOnCommit` is N) and as the job; it never queues through `queue#SystemMessage`, whose force-new create would
  outlive a rollback. 997s: generated for each received group except FA groups (an acknowledgment is never acknowledged)
  when `generateFunctionalAck` is Y, after validation, reporting syntax only (a business exception is still accepted);
  `find#OverdueAcknowledgments` lists sent documents past `ackOverdueMinutes`; `retry#Document` (EDI_ADMIN) re-applies an
  exception or re-produces a refusal with the same ID and revision.
- *Mappings.* 850: one placed order through `create#Order`/`create#OrderItem`/`place#Order` (approval is the seller's
  decision), the store's currency (CUR must match), ship-to by `EdiLocation`, products by the profile's `EdctProductId`
  crosswalk (all IDs one product), units by `EdctUom`, SAC by `EdctCharge` with stated amounts, notes, and the applied
  lines kept for the documents sent back; anything else is refused, never invented. 855: BAK AD/AC/RD and ACK
  IA/IQ/IP/IC/IR per line from the order's current quantities and prices. 856: S/O/P/I from the actual packages and
  contents, SSCC in MAN*GM (validated, required when the profile says), tracking in MAN*CP otherwise. 810: IT1 lines,
  item and summary SAC, TXI, TDS, with the total checked against `get#InvoiceTotal`. The units and codes sent are the
  purchase order's own or the profile's; no currency or unit is hard-coded.
- *Framework.* The grammar loader reads `MIN`/`MAX`; a parse reports missing and excess segments and loops, segments out
  of their level's order and the first segment left after the root (Java dropped it), with positions from each set's ST;
  `makeAk4` puts the code in AK403 (Java put it in AK402); scripts can generate without a newline suffix and with space
  padding. The SFTP poll isolates each file (a read, receive or removal failure is logged by name, left on the server, in
  `failedFileList`, and the poll goes on), removes a file only after a durable receipt (a message kept, or
  `duplicateOfId`, now on the receive interface), cleans up a file whose text a message already holds (a crash between
  receipt and cleanup), and receives a reused file name with new text as a new file.

**Parser limits and the supported subset** are in [docs/EdiX12.md](../docs/EdiX12.md) ("The sample profile's subset",
"Parser limits"): element values are Mantle's rules for the segments the profile reads, not X12's data dictionary; no
release character; separators from the first ISA; X12 4010 only; no TA1/999/824/860/865; one set per interchange sent.

**Fast checks run.** `cargo test -p moqui-core --lib edi` (33 passed, the new `min_and_max_are_checked_on_each_level`,
`segments_out_of_order_and_left_after_the_root_are_errors`, `positions_count_from_each_transaction_set` included) and
`--lib system_sync` (14 passed, the new `each_file_is_on_its_own_and_removed_only_after_a_durable_receipt` and
`a_file_left_on_the_server_is_not_received_twice_and_a_listing_failure_stops_the_poll`); `./moq build`; `./moq test
mr-mantle --spec EdiX12` (12 features passed, each 0.03–0.43 s): the full cycle (850 to one placed order with its
freight SAC, its 997, the 855 after approval, the 856 and 810 after the shipment and invoice, the partner's 997 in one
interchange of three FA groups accepting them, no 997 back); the same bytes again kept once, a consume resumed, the
same PO under new controls a Duplicate; a Conflict; a bad code and wrong totals Rejected with AK3/AK4; not X12, another
sender, IEA control and count mismatches and an unconnected remote quarantined; two groups with a bad set and an unknown
item (P and A 997s); an unsupported version (AK905 2); a rollback after the 855 was recorded leaving nothing, a batched
document sent by the job, a failed send resent with the same bytes and controls, overdue acknowledgments; a SAC
percentage, unknown ship-to, unsupported segment, missing SSCC (refused, then retried with its identity) and unmapped
invoice charge refused; IQ/IR (AC) and RD; the on-commit send; a 997 rejecting a set and one for an unknown group.
`./moq test mr-mantle --spec
EdiX12,OrderToCashBasicFlow,OrderBulk,OrderLifecycle,OrderToCashTime,WarehouseShipping,WarehousePacking,ShipmentPick,ShipmentLoads,InvoicePaymentMisc,InvoiceOrderApply,InvoicePostOrder,AccountingReceivables,ReturnToResponseBasicFlow`
(16 specs with their dependencies, 158 features passed); `./moq test mr-mantle` (158 specs, 1445 features passed; a first
run failed PayTraceGateway's "rejected enhanced data" feature once, whose after-commit send runs on a worker thread; it
passed with EdiX12 twice and in the second whole run). `cargo test -p moqui-core` (1309 + 4 + 12 passed, 5 ignored);
`cargo clippy -p moqui-core --all-targets -- -D warnings` (clean); `rustfmt --check` on the changed Rust files.
`moqui lint` of the four service files and `moqui lint --groovy`
of `service/mantle/edi`: clean. Prettier (with `--ignore-path=`) on the three modules, the spec and the grammar files
(each grammar literal under `// prettier-ignore`, keeping the converter's one-segment-per-line layout); `--list-different`
clean after the review fixes. `xmllint --format` with a canonical comparison on the new XML files.
No slow test was run.

**Known limits.**

- One set per interchange sent; no batching of sets or groups, which E2's SPS rules may need.
- The element rules cover the segments the sample reads; a partner guide's other mandatory elements need its profile's
  rules (today in X12.js `rulesFor`, keyed by set, not yet data).
- The 997 reports syntax and the profile's code subset; business refusals are exceptions for an operator, with no
  automatic 855 rejection (the order is never made, so there is nothing to acknowledge until a person acts).
- The 855 does not acknowledge SAC lines or lines the seller added; the 856 supports one package level (no pallets or
  tares), no package of two orders and no product of two order lines; the 810 one order per invoice and N2 amounts with
  at most two decimals.
- SSCCs are entered on the package; allocation and GS1-128 labels are the "Retail ASN and labeling" plan.
- A consume interrupted by a crash leaves the receipt SmsgConsuming (the framework's state); an operator's reset and
  consume resumes it without repeating anything.
- The `EdiX12` type holds the SFTP paths, so two partners on SFTP need a type each (with the same services).
- The poll's file name and content check runs on every poll for each remaining file (a download per file; the text is
  compared in the query, newest 20).

**What E2 still needs.** The SPS connection worksheet (account, retailer, format and transport decided); a partner profile
(its own ID and revision) with the retailer's codes, element rules, location crosswalk and acknowledgment ownership
(whether SPS or Mantle sends 997s); the SFTP remote and type (`receivePath`/`testout`, `sendPath`/`testin`, file name
pattern, `MsgRrDelete` or move, pinned host key and explicit port) and the enabled poll and `send_EdiPendingDocuments`
jobs; batching rules; the 856 packing, SSCC allocation and label workflow the retailer requires; any 860/865/824/TA1 the
partner mandates; sanitized partner fixtures; and the certification cases.

**Review fixes (after an independent review, 2026-11-02).**

1. A quarantined interchange is recoverable: `retry#Receipt` (EDI_ADMIN, new) consumes a receipt in error again, and
   `store#ReceivedInterchanges` on a stored receipt checks its quarantined interchanges again from the kept text; one now
   trusted is stored and its quarantine becomes `EdinSuperseded` (new status), one still failing is updated. A resend of
   the same bytes stays a duplicate receipt. Spec: CONNECTION_UNKNOWN, connection added, resend kept once, retry applies
   the order, a second retry NOT_RETRYABLE.
2. `find#OverdueAcknowledgments` filters in the query, per connection whose profile expects 997s (`EdocSent`, not 997,
   `sentDate` before the connection's cutoff, newest-first limit per connection), so 997s and no-ack documents never fill
   its window. Kept as Sent rather than a new terminal status: the query already leaves them out.
3. A consume ends SmsgError with a SystemMessageError and `noStatusUpdate` when any document is left Stored or
   Validated or a group owed a 997 has none, as for a quarantine; `retry#Receipt` resumes it.
4. `recordEvent` locks and reads an earlier revision again before superseding it, and supersedes only one still Pending
   or Refused (a Produced one is sent as it is). Not taken: catching every failure of the record services so the
   business transaction never fails. With the race fixed no expected path fails, and committing a business change
   whose document could not be recorded would lose the document silently, which the lifecycle exists to prevent.
5. Framework: a service worker counts work active under the lock that takes it off the queue (`pool.rs` `next_work`),
   so `waitWorkerPoolEmpty` no longer returns between the two; Rust test
   `work_taken_off_the_queue_is_counted_active_under_the_same_lock`. PayTraceGateway's "rejected enhanced data" feature
   then passed 10 runs out of 10.
6. Identifiers sent are never altered (`ident`, not `clean`); an element holding a separator, terminator or NUL is
   refused (`SEPARATOR_IN_DATA`) before controls are allocated; the remote's ISA/GS values are checked against their
   widths (CONFIG_INVALID) and the generated ISA must be 106 characters. Spec: a buyer's part number holding the
   connection's component separator refused, nothing sent.
7. `send_EdiPendingDocuments` is on by default; `find#OverdueAcknowledgments` also returns `stuckList` (Pending or
   Produced past `stuckMinutes`, a message in error, Refused); `retry#Document` resets a message in error and sends the
   same bytes. The job does not resend messages the framework put in error.
8. The PO release (BEG04) is kept with the applied lines and sent in BAK05, PRF02 and BIG05.
9. Spec: `retry#Document` by a user without EDI_ADMIN is PERMISSION_DENIED with the parameters that then apply for
   john.doe.
10. Prettier: see the fast checks above.
11. SFTP: `existing_messages` compares the text in the query and reads the newest 20 IDs and statuses only.
12. Segments outside any interchange are a receipt-level quarantine row (receipt sequence 0), not interchange 1's.
13. IT105 echoes the purchase order's basis (no `PE` default); TD101 is the profile's new `asnPackagingCode` (TD101/102
    left out when empty).
14. The invoice SECA takes every status change; the record service compares with the profile's `invoiceStatusId`.
15. `EDI_GROUP_CONTROL` index; the 997's group is found with one `in` query of its candidates' interchanges; control
    numbers and counts compare as numbers everywhere (IEA, GE, SE, AK1, AK2).
16. Hash: no stable digest is available to scripts; documented in docs/EdiX12.md (as the Phase 0 record does).
17. A receipt's 997s are sent after its consume commits (`registerOnCommit`).
18. Only a refusal with a reason code makes a document Refused; another mapping failure leaves it Pending.
19. `setSegmentSuffix` documented as one character (no CRLF); AK303 and the missing-segment position documented as
    limits.
21. Specs: two first control allocations of a new scope (the production remote of the partner) at once get 1 and 2
    (the scope's row is made in a transaction of its own, then locked); two deliveries of one PO at once make one order and
    a Duplicate.

Checks after the fixes: `./moq test mr-mantle --spec EdiX12` (17 features passed, each under 0.5 s); the related set
with PayTraceGateway (17 specs, 176 features passed); `./moq test mr-mantle` (158 specs, 1450 features passed); the
PayTrace feature alone 10 times (10 passed); `cargo test -p moqui-core` (1310 + 4 + 12 passed, 5 ignored); `cargo clippy
-p moqui-core --all-targets -- -D warnings` (clean); `./moq build`; rustfmt on the changed Rust files; `moqui lint` of
`EdiServices.xml`; `xmllint --format` with a canonical comparison; Prettier `--list-different` clean. No slow test was
run.
