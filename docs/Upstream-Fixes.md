# Fixes to upstream behaviour

Defects found here in behaviour that Mantle carries over from the Java components
[mantle-udm](https://github.com/moqui/mantle-udm) and [mantle-usl](https://github.com/moqui/mantle-usl), with what was
changed here. Each is a candidate to take back upstream. Add one entry per fix, newest first.

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
