# mr-mantle tests

The regression suite: JavaScript spec files that `moqui test` runs, ported from Mantle's Spock specs, plus specs without a Groovy original
that run the services the flows never reach. They run in the same script engine as the services, on a database loaded
with every data type. Each `*.spec.js` file is one specification; `suite.js` gives the order. The specs are grouped
in subdirectories named for the `service/mantle` directory whose services they mostly call (`account`, `ledger`,
`order`, `product`, `shipment`, `work`, ...); a spec's name is its file name wherever it is.

```sh
moqui test mr-mantle                                  # every spec, fresh database (about 20s to load)
moqui test mr-mantle --db snapshot                    # load once, restore the saved dump on later runs
moqui test mr-mantle --spec OrderToCashBasicFlow      # one spec and the specs its dependsOn names
moqui test mr-mantle --spec OrderToCashBasicFlow --feature "ship Sales Order"
moqui test mr-mantle --junit build/test-results       # JUnit XML for CI
moqui test mr-mantle --coverage                       # list the services no spec called, per service file
moqui test mr-mantle --keep --log-level info          # keep the scratch runtime, more on the console
```

They run while working (the specs of what changed) and in `./moq test-apps` before a commit. Acceptance specs (a
scenario, a provider sandbox call) go in `../acceptance/` and run with `./moq accept mr-mantle`: on a schedule, before
a release, when asked, or after adding or changing one.

The spec format, conditions, helpers, pitfalls and a Spock-to-spec table are in `docs/Build-Test.md` in the mr-moqui
repository. Notes for this suite:

- A spec that calls a data-dependent service on a product the flows also use (DEMO_1_1, DEMO_2_1, DEMO_3_1) can see
  their inventory and reservations when it runs after them, so newer specs receive their own stock or use DEMO_1_2.
- A spec that needs its own books creates an organization and calls `init#PartyAccountingConfiguration` with
  `sourcePartyId: "DefaultSettings"`.
- REST output is JSON written as Java's Jackson writes it, `"key" : value`, so the Groovy originals' expected text
  holds.
