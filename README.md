# MR Mantle - Mantle Business Artifacts for MR Moqui

> **Not ready for production (before 0.1.0).** Like [MR Moqui](https://github.com/moqui/mr-moqui#readme), which it
> runs on, MR Mantle is in early development. Its data model and stored data change without migrations, and a
> security review is under way with its findings recorded openly in the mr-moqui repository. Run it only on
> development machines, with no real business data or credentials, and not exposed to the internet. The full notice
> is at the top of the [mr-moqui README](https://github.com/moqui/mr-moqui#readme).

Mantle is the business layer under the [MR Moqui](https://github.com/moqui/mr-moqui) applications: one data model
and one library of services for parties, products, orders, inventory, shipments, work, accounting and the rest of
what a business records. The applications are screens over it, so an order taken in
[IronStone BOSS](https://github.com/moqui/mr-boss), paid on an [IronStone PASS](https://github.com/moqui/mr-pass)
page and shown in [Marble ERP](https://github.com/moqui/mr-marble) is the same order, and an application of your own
can start from the same ground.

It has no screens of its own. To see it at work, run one of those applications.

## What is in it

- **The Universal Data Model** (`entity/`): business entities grouped by package domain, with separate
  `*Entities.xml`, `*Views.xml` and `*Extensions.xml` files. Entity ECA rules live directly under `entity/`.
  Seed records usually live in `<seed-data>` blocks with their definitions. Seed-only `*Data.xml` extensions
  place records that need a different load order. Root entity files load first, then each domain's files,
  in name order.
- **Additional data** (`data/`), grouped by domain within four load phases:
  - `10-seed/` holds required reference records and repeatable migrations.
  - `15-seed-initial/` holds initial settings that a deployment can change. Omit this type on routine seed reloads.
  - `20-install/` holds installation defaults to review or customize before loading, including regional geography,
    the chart of accounts and its posting mappings.
  - `30-demo/` holds Ziziwork Industries and example integrations for demo, development and tests.
  The loader reads a directory's files in name order, then visits each subdirectory in name order, depth first.
  The XML root's `type` selects which records load. Seed grants need the `MANTLE_USER_ORG` and `MANTLE_ACTIVE_ORG`
  filter sets. Their definitions load first in `10-seed/`, and their customizable filter rules load in `15-seed-initial/`.
- **The Universal Service Library** (`service/mantle/<package>/`): the business logic, in service XML with
  JavaScript, by package: `account`, `ledger`, `order`, `party`, `product`, `facility`, `shipment`, `work`,
  `humanres`, `request`, `sales`, `marketing`, `forum`, `smithy`, `public`, `pass`, `search` and `other`. The ECA
  rules that tie them together (an invoice posting to the ledger, for one) are in `service/`,
  with the REST API in `mantle.rest.xml`.
- **Integrations**, apart from the packages whose interfaces they implement:
  - bank files (NACHA, Positive Pay, BAI, OFX) in `service/mantle/ext/account/`;
  - payment processors in `ext/account/gateway/`: [Authorize.Net](docs/AuthorizeNet.md), [PayTrace](docs/PayTrace.md);
  - [Shippo](docs/Shippo.md) for shipping rates and labels in `ext/shipment/`, and Google Maps in `ext/party/`;
  - [X12 EDI](docs/EdiX12.md) in `service/mantle/edi/`.
- **Agreements for every kind of norm** (`entity/party/AgreementEntities.xml`): a law, a standard, a guideline or
  a company policy is an Agreement per language edition, with its kind (`AgreementDocumentType`), version, locale,
  jurisdiction, adoption, publication, entry-into-force and application dates, and its identifiers (ELI, CELEX,
  publisher reference, DOI: `AgreementIdentification`), whether it is prescriptive (not a technical report) and
  official, and its sources (the PDF, the Formex XML) as AgreementContent with their SHA-256. Its partitions (part,
  chapter, article, paragraph, point, sentence, annex, table row and cell, footnote) are AgreementItems in a tree, in
  printed order, with their page and region, each with its provision type in families (constitutive, regulative with
  the ISO verbal forms, procedural, sanction, on other provisions, informative), what the list it introduces is (all
  apply, one or more, conditions, contents) and whether it is informative. Citations, defined terms, efficacy,
  exclusions from and extensions of scope, derogations, normative references, harmonisation, translations,
  amendments, repeals and transpositions are AgreementAssocs between acts or single items, effective from a date. A
  Requirement can come from an item (`Requirement.agreementId`, `agreementItemSeqId`).
- **Functions in the bill of materials**: a `PtFunction` product (a safety function, a security zone, a conduit)
  with its purpose (`Product.purposeEnumId`, DevicePurpose), whose members are `PatFunctionMember` associations
  with their role (`ProductAssoc.purposeEnumId`). The installation is a moqui-device `Device` with its Asset
  (`Device.assetId`, `entity/product/DeviceExtensions.xml`); a Requirement can be of a Device (`deviceId`).
- **Report definitions** (`report/`) and email and print templates (`template/`).

## Get it

In an [mr-moqui](https://github.com/moqui/mr-moqui#quick-start) checkout, `./moq component-get mr-mantle` gets it
alone, and getting an application gets it too. It depends on [moqui-device](https://github.com/moqui-industrial/moqui-device),
which depends on [moqui-math](https://github.com/moqui/moqui-math): put both in `runtime/components/addon`, or
Moqui leaves mr-mantle out, and every application with it. Another component depends on it with:

```xml
<depends-on name="mr-mantle"/>
```

## Developing

Read mr-moqui's [AGENTS.md](https://github.com/moqui/mr-moqui/blob/master/AGENTS.md) and
[application practices](https://github.com/moqui/mr-moqui/blob/master/docs/dev/Practices-App-Dev.md) first.

```sh
./moq test mr-mantle                              # The regression suite (test/), while working
./moq test mr-mantle --spec OrderToCashBasicFlow  # One spec
./moq test-apps                                   # Every app component's regression suite, before a commit
./moq accept mr-mantle                            # The acceptance suite (test/acceptance/), when asked
```

- [test/README.md](test/README.md) has the suite's layout and notes; the two suites are described in mr-moqui's
  [Build-Test](https://github.com/moqui/mr-moqui/blob/master/docs/Build-Test.md#the-two-suites).
- [docs/](docs/) has the integration guides above, the record of the
  [accounting implementation](docs/AccountingImplementation.md), and
  [Upgrading](docs/Upgrading.md): the tables to rebuild in a database kept across a change to an entity's key. Until
  0.1.0 the simpler way is to empty the database and load it again.
- [plan/payments-shipping-edi.md](plan/payments-shipping-edi.md) is the plan the payment, shipping and EDI
  integrations follow.

## Coming from Moqui Java

This is the Java Moqui components [mantle-udm](https://github.com/moqui/mantle-udm) (the data model) and
[mantle-usl](https://github.com/moqui/mantle-usl) (the services) in one component named `mr-mantle`. The two were
ported in forks (Groovy to JavaScript, Spock flows to JavaScript specs run by `moqui test`), then merged into this
repository with the commit history of both. A component that depended on either now depends on `mr-mantle`; the
renames are in mr-moqui's
[Moqui Java migration notes](https://github.com/moqui/mr-moqui/blob/master/docs/dev/Moqui-Java-Migration.md).

Fixes made here to behaviour carried over from the Java components, candidates to take upstream, are in
[docs/Upstream-Fixes.md](docs/Upstream-Fixes.md).

The Universal Data Model and the Mantle Business Artifacts are introduced on
[Mantle's page on moqui.org](https://moqui.org/mantle.html) and in the book *Making Apps with Moqui*, both written
for Moqui Java; the model they describe is the one here. Questions are welcome on the
[Moqui forum](https://forum.moqui.org).

## License and Contributing

[CC0 1.0 Universal with a Grant of Patent License](LICENSE.md). To contribute code, sign
[AUTHORS.md](AUTHORS.md) in a commit from the account that submits the pull request; its Contributing
section has the details.
