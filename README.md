# MR Mantle - Mantle Business Artifacts for MR Moqui

[![license](http://img.shields.io/badge/license-CC0%201.0%20Universal-blue.svg)](https://github.com/moqui/mr-mantle/blob/master/LICENSE.md)

[![Discourse Forum](https://img.shields.io/badge/moqui%20forum-discourse-blue.svg)](https://forum.moqui.org)

Mantle Business Artifacts for [MR Moqui](https://github.com/moqui/mr-moqui), in one component named `mr-mantle`:

- **Universal Data Model** (`entity/`, the seed, install and demo data in `data/`), from the Java Moqui component
  [mantle-udm](https://github.com/moqui/mantle-udm).
- **Universal Service Library** (`service/`, its data and `test/` specs), from the Java Moqui component
  [mantle-usl](https://github.com/moqui/mantle-usl).

The two were ported in the forks `mr-mantle-udm` and `mr-mantle-usl` (Groovy to JavaScript, Spock flows to JavaScript
specs run by `moqui test`), then merged into this repository with the commit history of both. Other components depend on
it with `<depends-on name="mr-mantle"/>`; the renames from the Java names are in the MR Moqui
`docs/dev/Moqui-Java-Migration.md`.

Services are in `service/mantle/<package>/`. Integrations with particular external systems are apart, by the same
package, in `service/mantle/ext/`: bank files (NACHA, Positive Pay, BAI, OFX) in `ext/account/`, payment processors
(Authorize.Net, PayTrace) in `ext/account/gateway/`, Shippo in `ext/shipment/`, Google Maps in `ext/party/`. The
interfaces they implement and the payment, shipment and message handling around them stay in the package. X12 EDI is
in `service/mantle/edi/`.

```sh
./moq component-get mr-mantle
./moq test mr-mantle                              # the regression suite (test/), while working
./moq test mr-mantle --spec OrderToCashBasicFlow
./moq test-apps                                   # every app component's regression suite, before a commit
./moq accept mr-mantle                            # the acceptance suite (test/acceptance/), when asked
```

The two suites are described in `docs/Build-Test.md` (The two suites) in the mr-moqui repository.

A database made before an entity's key changed needs its table rebuilt once: see [docs/Upgrading.md](docs/Upgrading.md)
(ProductStoreProduct, dated store publication; PublicSitePage, pages by mount and route).

Fixes made here to behaviour carried over from mantle-udm and mantle-usl, candidates to take upstream, are in
[docs/Upstream-Fixes.md](docs/Upstream-Fixes.md).

For details about Mantle see its page on moqui.org:

<http://www.moqui.org/mantle.html>

There is an overview of the Universal Data Model and of Mantle Business Artifacts in the **Making Apps with Moqui** book.
Download the PDF here:

<http://www.moqui.org/MakingAppsWithMoqui-1.0.pdf>

## License and Contributing

[CC0 1.0 Universal with a Grant of Patent License](LICENSE.md). To contribute code, sign
[AUTHORS.md](AUTHORS.md) in a commit from the account that submits the pull request; its Contributing
section has the details.
