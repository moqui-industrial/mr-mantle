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

Run relevant fast specs with `./moq test mr-mantle --spec <spec-name>` and targeted framework tests when framework code
changes. JavaScript specs run in Moqui, not Node. Keep individual cases well under 15 seconds. Slow tests require
explicit user permission under repository rules; mark cases over 30 seconds as slow and never run `--slow` implicitly.
Provider sandbox/certification and live financial or shipping calls are explicit deployment exercises, not ordinary
regression tests. This document revision itself requires no build or application test run.

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
