# PayTrace payment gateway

Mantle's PayTrace gateway: `service/mantle/account/PayTraceServices.xml` and `PayTrace.js`, on the gateway interfaces
of `PaymentServices.xml` (authorize, capture, release, refund, details), with what it shares with the Authorize.Net
gateway in `GatewayLib.js`. It uses the PayTrace JSON API v3 (the OpenAPI schema at `https://api.paytrace.com/v3/openapi.json`,
3.5.1 when ported) with the framework HTTP client, no SDK. It was ported from the Java Moqui
[mantle-paytrace](https://github.com/moqui/mantle-paytrace/tree/5dbe616) component (1.0.3, `5dbe616`), which used API
v1. The plan and its implementation record are [plan/payments-shipping-edi.md](../plan/payments-shipping-edi.md) (P2).

## Configuration

| Record | What goes there |
| --- | --- |
| `PaymentGatewayConfig` | `paymentGatewayTypeEnumId` `PgtPayTrace`, the service names (`mantle.account.PayTraceServices.authorize#Payment`, `capture#`, `release#`, `refund#Payment`, `get#PaymentGatewayDetails`; for a sale `authorizeAndCapture#Payment` with no capture service), and `systemMessageRemoteId` |
| `SystemMessageRemote` | `sendUrl` the API base (`https://api.sandbox.paytrace.com` sandbox, `https://api.paytrace.com` production), `usageCode` `T` or `P` (it picks the Protect.js host), `username` the PayTrace API user, `password` its password. The password is an encrypted field |
| `PaymentGatewayPayTrace` | Non-secret options: `merchantId`, `integratorId` (issued by PayTrace for the integration, sent as `X-Integrator-Id`, at most 12 characters), `currencyUomId` (the merchant account's currency; a payment in another is refused), `lookupGraceSeconds`, `sendEnhancedData`, `commodityCode` and `defaultUnitOfMeasure` for level 3 lines, `customerLabelPrefix` (for instances sharing one account) |

`data/PayTraceDemoData.xml` names a sandbox gateway `PayTraceDemo` and remote `PayTraceSandbox` without credentials,
merchant id or integrator id. Enter them in the System Message Remote screen or a deployment's own data file, never in
seed data. The API user's password expires every 90 days at PayTrace (error 979): change it on the remote too.

**Authentication.** OAuth client credentials (`POST /v3/token`, form encoded, the API user as `client_id` and its
password as `client_secret`). The access token is kept in the process cache `mantle.account.PayTrace.accessToken` until
a minute before `expires_in`, by remote, endpoint and user, sealed: XORed with a keystream of the conf's single-use hash
(SHA-256 by default) of the remote's password, a random nonce and a block counter, so the Tools cache screen shows only
hex. A request answered 401 (expired or revoked) gets a new token and is sent once more; a second 401 is an error, not
sent again. Credentials or a fresh token PayTrace refuses are not sent again for a minute. The token is never recorded
or logged.

## Payments

- **Card data.** The server never sends a card number or a security code (v3 takes a CSC only encrypted by PayTrace's
  browser library). An authorization uses a single-use Protect.js token (`hpf_token`, `enc_key`: the `paymentToken`
  input) or the payment method's vault customer (`gatewayCimId`). A method with neither is refused (`NO_PAYMENT_PROFILE`).
  Requests and answers are not logged; a response keeps the transaction id, codes and AVS/CSC results, and a method only
  the masked card and expiry.
- **Operation identity.** PayTrace card transactions take no idempotency key. Mantle's idempotency key goes in
  `invoice_number` and at the start of `description`. A lost answer (timeout, reset, 408, a 5xx, an unreadable answer,
  a 2xx answer with neither a response code nor an error, response code 1, or the duplicate block 777) is recorded as
  unknown, and `get#PaymentGatewayDetails` looks it up: the export by date (`POST /v3/transactions/export/by-date` with
  the key as `including_text`; error 180 is none found), each candidate whose description starts with the key read by id
  (`GET /v3/card/transaction/{id}`). Not found answers "not done" only once the lost request is older than
  `lookupGraceSeconds` (300 by default). A lost capture or void reads the authorization's transaction.
- **Outcomes.** Response codes 101, 112, 109, 106, 108 and 167 are successes; 102 and 103 (approved, then voided by
  PayTrace for an AVS or CSC mismatch) declines; error 35 a bad card number, 43/44 a bad expiry, 778/779/790 blocks
  (declines); other errors are refusals before acting. A capture or void refused for the transaction's state (816, 818)
  whose transaction is already in that state is a success (`ALREADY_CAPTURED`, `ALREADY_VOIDED`). An approval whose
  `total_amount` differs from `requested_amount` (surcharging) is kept with `transactionStatus` `AMOUNT_MISMATCH` and a
  warning.
- **Refunds** are linked; unlinked credits are not used. A settled transaction is refunded with the refund authorization
  by transaction id (any amount up to what is left; a transaction of its own, with the reference); a captured, unsettled
  one can only be voided whole, recorded as the refund (`VOID_BEFORE_SETTLEMENT`); a partial refund before settlement is
  refused (`REFUND_BEFORE_SETTLEMENT`).
- **Vault customers.** `store#CustomerPaymentProfile` makes a vault customer from a token
  (`/v3/customer/create/pt-protect`, `customer_label` `mantle-` and the method id); PayTrace keeps one card per vault
  customer, so its `customer_id` is the method's `gatewayCimId` and the label its `gatewayCustomerId`. Deleting the method
  (`delete#PaymentMethod`) deletes the vault customer (`service/PayTrace.secas.xml`).
- **Transaction status** (`GET /v3/card/transaction/{id}`): `A` with action exactly `auth_only` authorized; another `A`,
  or `L`, captured and waiting for settlement (Delivered); `S` settled (Confirmed); `V` or `R` voided; `D` or `F`
  declined. PayTrace's status after a capture is not documented, so a payment Mantle captured (Delivered, or with an
  approved capture) is never taken back to Authorized, nor a Confirmed one back to Delivered. When the record still reads
  `A`/`auth_only`, whether it was captured is read from the capturable list (`GET
  /v3/card/transactions/capturable/{merchant_id}`, searched by its id): a lost capture, or a capture refused with 816,
  whose transaction PayTrace no longer lists is captured.

## Enhanced (level 2/3) data

After an approved capture or sale of a payment with an invoice (`forInvoiceId`) or an order, its lines go to the unified
Enhanced Data endpoint (`PUT /v3/invoice/by-transaction-id/{id}`, which PayTrace accepts for unsettled sale or capture
transactions). The capture or sale registers `send#EnhancedData` to run once its transaction commits, on a service
thread in a transaction of its own: enhanced data never fails, rolls back or holds the charge.

| Field | From |
| --- | --- |
| `customer_reference_id` | the customer's PO: `Invoice.otherPartyOrderId`, else the order part's; else the invoice or order id (required for level 2 and 3) |
| `invoice_number` | the invoice id, else the order id |
| `tax_amount` | the sales tax lines and children (`-1`, tax exempt, when there is none, as the source sent) |
| `freight_amount` | shipping lines and their children |
| `discount_amount` | order discounts (top-level discount lines, negative lines) |
| `shipping_address` | the order part's postal code and ISO country |
| `line_items` | each other line: `product_label` (description or product name, 35), `product_code` (pseudo id, 12), `commodity_code` (the product's `PidtCommodityCode` identification, else the gateway's `commodityCode`), `quantity`, `unit_of_measure` (the source's UoM table, else `defaultUnitOfMeasure`), `unit_cost`, `item_total_amount` (quantity times unit, rounded to the currency, less the line's discounts), `item_tax_amount`, `discount_amount`. Quantity times unit cost is always the line's amount: a unit amount finer than the currency is sent rounded when that still holds, else as one unit of the line's amount |

Amounts round to the payment's currency. Level 3 is sent when the lines balance with the captured amount (line totals
less the discount, plus freight and tax, as PayTrace's Enhanced Data guide states); otherwise (a partial payment) only
level 2, the customer reference and invoice number. VAT lines, not added to totals, are left out. The tax ids
(`merchant_tax_id`, `customer_tax_id`) need PayTrace's e2ee encryption and are not sent: PayTrace uses the merchant setup
and the data on file.

The outcome is its own `PgoLevel3Data` gateway response (`transactionStatus` `level3` or `level2`): accepted (response
code 170 or 171), or `resultError` with `ENHANCED_DATA_REJECTED` (PayTrace's error ids in `responseCode`),
`ENHANCED_DATA_UNCONFIRMED` (another answer), `ENHANCED_DATA_NO_ANSWER`, `ENHANCED_DATA_NOT_SENT` or
`ENHANCED_DATA_FAILED` (the data could not be built). It never changes, undoes or repeats the charge, and is never an
unknown outcome (that would block the payment). `send#EnhancedData` sends it again (the PUT is a full overwrite); the
paused job `retry_PayTraceEnhancedData` (`retry#EnhancedData`) does that for every captured, unsettled payment whose
latest enhanced data was not accepted or that has none (a capture whose after-commit send did not run), up to
`maxAttempts` (5) sends a payment, and never for a capture voided before settlement (`TRANSACTION_VOIDED`). Enable the
job where enhanced data matters.

## In the browser

The example [examples/PayTraceProtect.html](examples/PayTraceProtect.html) uses Protect.js hosted fields: the card is
typed into PayTrace's iframe, and the page posts only the `hpf_token` and `enc_key` to Mantle.

| Endpoint | Service |
| --- | --- |
| `GET /rest/s1/mantle/my/payments/{paymentId}/payTrace` | `get#BrowserPaymentConfig`: the Protect.js script address, a client key (`/v3/payment-fields/token`, valid 20 minutes), the amount |
| `POST /rest/s1/mantle/my/payments/{paymentId}/payTrace` | `submit#BrowserPaymentToken`: `hpfToken`, `encKey`, `savePaymentMethod`, `operationId`; answers `state` (approved, pending, declined, unknown, error) |

The endpoints share the Authorize.Net ones' rules (`GatewayLib.js`): the payment decides the organization, gateway,
amount and currency; only its payer, or a user with treasury authority over the organization paid, may use them; the
payment is locked and checked again, and `begin#PaymentGatewayOperation` answers a replay or a pending or unknown earlier
authorization before any vault customer is made; `savePaymentMethod` is the payer's consent to keep the card, ignored for
anyone else, and a declined card is not kept. A browser's "paid" is not proof of payment.

PayTrace has no card transaction webhooks (its `silent_post` is for Trace AR invoices); the poll job
(`poll#PaymentGatewayDetails`) is the path for status changes after the call.

## Tests

`test/PayTraceGateway.spec.js` runs the gateway against sanitized v3-shaped answers with the framework's HTTP fixtures
([Build-Test](../../../../docs/Build-Test.md#http-fixtures)):

```sh
./moq test mr-mantle --spec PayTraceGateway
```

Sandbox and live calls are deployment exercises, not regression tests.
