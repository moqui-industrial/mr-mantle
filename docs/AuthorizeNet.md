# Authorize.Net payment gateway

Mantle's Authorize.Net gateway: `service/mantle/account/AuthorizeNetServices.xml` and `AuthorizeNet.js`, on the gateway
interfaces of `PaymentServices.xml` (authorize, capture, release, refund, details), with what it shares with the
[PayTrace](PayTrace.md) gateway (the response record, the browser endpoints' checks) in `GatewayLib.js`. It uses the
current Authorize.Net JSON API (`createTransactionRequest`, customer profiles, transaction reporting) with the framework
HTTP client, no SDK.
It was ported from the Java Moqui [AuthorizeDotNet](https://github.com/moqui/AuthorizeDotNet/tree/eaa351c) component
(1.2.5, `eaa351c`); the AIM `x_` name/value protocol it also used is deprecated and not ported. The plan and its
implementation record are [plan/payments-shipping-edi.md](../plan/payments-shipping-edi.md) (P1).

## Configuration

| Record | What goes there |
| --- | --- |
| `PaymentGatewayConfig` | `paymentGatewayTypeEnumId` `PgtAuthorizeNet`, the service names (`mantle.account.AuthorizeNetServices.authorize#Payment`, `capture#`, `release#`, `refund#Payment`, `get#PaymentGatewayDetails`; for a sale `authorizeAndCapture#Payment` with no capture service), and `systemMessageRemoteId` |
| `SystemMessageRemote` | `sendUrl` the API endpoint (`https://apitest.authorize.net/xml/v1/request.api` sandbox, `https://api.authorize.net/xml/v1/request.api` production), `usageCode` `T` or `P` (it picks the Accept.js host), `username` the API login id, `password` the transaction key, `sharedSecret` the webhook signature key, `messageAuthEnumId` `SmatHmacSha512`, `authHeaderName` `X-ANET-Signature`. The secrets are encrypted fields |
| `PaymentGatewayAuthorizeNet` | Non-secret options: `publicClientKey` (Accept.js), `validationMode` for new payment profiles, `duplicateWindow`, `lookupGraceSeconds` |

`data/AuthorizeNetDemoData.xml` names a sandbox gateway `AuthorizeNetDemo` and remote `AuthorizeNetSandbox` without
credentials. Enter them in the System Message Remote screen or a deployment's own data file, never in seed data. A
product store takes cards with it through a `ProductStorePaymentGateway`.

## Payments

- **Card data.** The server never sends a card number. An authorization uses a single-use browser token (Accept.js
  `opaqueData`, the `paymentToken` input) or the payment method's customer payment profile (`gatewayCustomerId`,
  `gatewayCimId`). A method with neither is refused (`NO_PAYMENT_PROFILE`). Requests and answers are not logged; a
  response keeps the transaction id, codes and AVS/CVV results, and a method only the masked card.
- **Operation identity.** Authorize.Net has no idempotency key. The first 20 characters of Mantle's idempotency key go in
  `refId` and `order.invoiceNumber`. A lost answer (timeout, reset, unreadable answer, or the duplicate refusal 11) is
  recorded as unknown, and `get#PaymentGatewayDetails` looks the transaction up: by `transrefId`, then the invoice
  numbers of the unsettled transactions (those held for review, `pendingApproval`, and the others), then those of the
  batches settled since. Not found answers "not done" only once the lost request is older than `lookupGraceSeconds`
  (300 by default, and always the duplicate window plus 60).
- **Held for review** (response code 4) is pending with its transaction id on the payment, and the payment is not
  authorized again meanwhile (`GATEWAY_OUTCOME_PENDING`); the details lookup or the fraud webhook finishes it, as an
  approved answer would (approval code, security code cleared).
- **Refunds** are linked (`refTransId`); unlinked credits are not used. The settlement state decides: a settled
  transaction is refunded (any amount up to what is left); a captured, unsettled one can only be voided whole, recorded as
  the refund (`VOID_BEFORE_SETTLEMENT`; the original stays Delivered with its refund applied); a partial refund before
  settlement is refused (`REFUND_BEFORE_SETTLEMENT`) and can be sent after settlement.
- **Profiles.** `store#CustomerPaymentProfile` makes a payment profile from a token (on the party's customer profile at
  that gateway, made when it has none) and keeps the references on the payment method. Deleting the method
  (`delete#PaymentMethod`) deletes its profile (`delete#CustomerPaymentProfile`, through `service/AuthorizeNet.secas.xml`).

## Webhooks

Point an Authorize.Net webhook at `/rest/sm/AuthorizeNetWebhook/{systemMessageRemoteId}`. The framework checks
`X-ANET-Signature` (HMAC-SHA512 of the body with the signature key, `SmatHmacSha512`) before anything is kept;
`receive#Webhook` keeps each notification once per remote (`store#ReceivedSystemMessage`), and `consume#Webhook` looks up
the payment it is about through `get#SinglePaymentGatewayDetails`, among the payments of the gateways on that remote. The
payload's status is not applied, so repeated, late and out-of-order events converge on the provider's state. The poll
job (`poll#PaymentGatewayDetails`) stays the path for missed events.

## In the browser

The example [examples/AuthorizeNetAcceptUI.html](examples/AuthorizeNetAcceptUI.html) uses the Accept.js hosted payment
form (AcceptUI): the card is typed into Authorize.Net's form, and the page posts only the opaque data to Mantle.

| Endpoint | Service |
| --- | --- |
| `GET /rest/s1/mantle/my/payments/{paymentId}/authorizeNet` | `get#BrowserPaymentConfig`: API login id, public client key, the script addresses, the amount |
| `POST /rest/s1/mantle/my/payments/{paymentId}/authorizeNet` | `submit#BrowserPaymentToken`: `dataDescriptor`, `dataValue`, `savePaymentMethod`, `operationId`; answers `state` (approved, pending, declined, unknown, error) |

The payment, made by the order or invoice flow, decides the organization, gateway, amount and currency; only its payer,
or a user with treasury authority over the organization paid, may use the endpoints. `savePaymentMethod` is the payer's
consent to keep the card; the page asks for it explicitly, it is ignored for anyone else, and a declined card is not
kept. The page makes a new `operationId` for each attempt (after a decline or an error), so a repeated submit of one
attempt is answered from its first response and sends nothing; so does a submit while an earlier one is pending. A browser's "paid" is not proof of payment: the state comes
from the gateway response, and an unknown one is looked up.

**Accept Hosted** is the alternative when the merchant wants Authorize.Net to host the whole payment page:
`getHostedPaymentPageRequest` gives a form token for the payment's amount, the browser goes to Authorize.Net's page, and
the result comes back by webhook and lookup, never from the return URL. It is not built here; it would be a hosted
gateway (`returnUrl`, a pending response with `redirectUrl`) on the same details and webhook paths.

## Tests

`test/AuthorizeNetGateway.spec.js` runs the gateway against sanitized provider-shaped answers with the framework's HTTP
fixtures ([Build-Test](../../../../docs/Build-Test.md#http-fixtures)):

```sh
./moq test mr-mantle --spec AuthorizeNetGateway
```

Sandbox and live calls are deployment exercises, not regression tests.
