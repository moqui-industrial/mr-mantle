# Fixes to upstream behaviour

Defects found here in behaviour that Mantle carries over from the Java components
[mantle-udm](https://github.com/moqui/mantle-udm) and [mantle-usl](https://github.com/moqui/mantle-usl), with what was
changed here. Each is a candidate to take back upstream. Add one entry per fix, newest first.

## Grouped invoices did not link manual-rate time sources (Nov 9, 2026)

- **Behavior:** `mantle.account.InvoiceServices.create#TimeEntryInvoiceItems` included manual hourly and piece
  amounts in worker/all totals, but linked sources only when they had an hourly RateAmount ID. Those entries
  remained unbilled and could be invoiced again.
- **Fixed here:** each aggregate retains the sources whose calculation resolved an hourly or piece rate,
  including explicit zero rates, and links them to the created item. Unresolved piece-only sources stay unbilled.
  Existing locking, amount calculation and transaction errors remain in place.
- **Verification:** standalone Mantle `WorkManualTimeBilling` covers both groupings, manual/zero/piece sources,
  a missing-piece-rate control, retry, item removal, recreation and invoice cancellation; `WorkProjectBilling`
  checks the ordinary referenced-rate flow.
- **Upstream candidate:** replace the hourly RateAmount-ID guard with resolved contributor tracking in both
  aggregate branches; no schema or service parameter change is needed.

## Manual hourly rates were missing from project actuals (Nov 9, 2026)

- **Behavior:** `mantle.work.TaskServices.update#TaskFromTime` summed only joined RateAmount values from
  `TimeEntryAndRates`. An explicit hourly rate on TimeEntry could correctly bill the client while task/project
  actual client value and worker cost used a different referenced rate or zero.
- **Fixed here:** the view exposes `clientHourRate` and `vendorHourRate`; actuals use each explicit value before
  the referenced rate, including an explicit zero. Existing time-entry EECAs propagate the corrected totals.
- **Verification:** standalone Mantle regression `WorkManualTimeRates` checks explicit rates, zero, referenced
  fallback and deletion at task and project level. `WorkTimeEntries` prepares its own visibility fixtures.
- **Upstream candidate:** apply the same precedence where the corresponding view/rollup uses only joined rates;
  no physical schema migration or service parameter change is needed.

## Two subscriptions to one resource share their terms (Nov 6, 2026)

- **Upstream:** `mantle.product.SubscriptionServices.fulfill#ProductSubscriptionResource` (mantle-usl) extends the
  person's latest subscription to the resource, with a TODO for the resource instance. Two independent subscriptions
  to the same resource (two contracts, or a purchase and a manual grant) therefore extend one shared term.
- **How it showed here:** Shop P7's recurring contracts each pay for their own term of the Forum's paid access; a
  second contract's renewal extended the first one's subscription.
- **Fixed here:** the service takes an optional `resourceInstanceId` and, when given, extends only that instance's
  subscription; Shop passes its contract's id (mr-mantle `33c9df55`). Called without it, the service behaves as before.
- **For upstream:** carry the resource instance on Subscription and match it in the fulfillment, as the TODO says.

## An organization's own accounting preferences lose what it inherited (Nov 6, 2026)

- **Upstream:** `mantle.ledger.LedgerServices.find#PartyAcctgPreference` (mantle-usl `LedgerServices.xml`) inherits
  the whole row. It returns the organization's own `PartyAcctgPreference` if there is one, and only otherwise the
  parent's through the `PrtOrgRollup` relationship. So an own row with only a few fields set (one flag, say) hides
  every inherited field: the base currency, the costing method and the fiscal year start.
- **How it showed here:** `SetupServices.store#Preferences` (mr-mantle's, Accounting P3) created an organization's
  first own row from only the settings passed. Customer Service's returns walk set one flag on ORG_ZIZI_RETAIL, which
  inherits from ORG_ZIZI_CORP. Retail then had no base currency, and Purchasing's plan conversion refused it with
  CURRENCY_REQUIRED.
- **Fixed here:** `store#Preferences` now starts an organization's first own row from the inherited preference fields
  (not the error journal), then applies the settings passed. AccountingSetup's rolled-up organization feature checks
  it (mr-mantle `a96bce5c`). `find#PartyAcctgPreference` is unchanged.
- **For upstream:** any code path that creates a partial own row has the same effect. Either copy the inherited fields
  when the first own row is created, as here, or have `find#PartyAcctgPreference` fall back to the parent field by
  field. Once an own row exists it is a snapshot: later changes at the parent no longer reach that organization.
