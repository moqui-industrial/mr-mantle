# X12 EDI

Mantle's X12 business services for a supplier receiving retail purchase orders: `service/mantle/edi/EdiServices.xml`
with `X12.js` (envelopes, validation, 997s, the lifecycle of documents sent), the mapping services the profile names
(`order/X12OrderServices.xml`, `shipment/X12ShipmentServices.xml`, `account/X12InvoiceServices.xml`, on
`X12Documents.js`), the grammars in `service/mantle/edi/x12/`, and the records in `entity/EdiEntities.xml`. They run on
the framework's `EdiHandler` and System Messages. They were ported from the Java Moqui
[mantle-edi](https://github.com/moqui/mantle-edi/tree/134acb6) component (1.1.5, `134acb6`). The plan and its
implementation record are [plan/payments-shipping-edi.md](../plan/payments-shipping-edi.md) (E1).

| Document | Direction | Business contract |
| --- | --- | --- |
| 850 purchase order | In | One placed sales order of the connection's store and partner, through `OrderServices`; approving it is the seller's decision |
| 855 acknowledgment | Out | The order's decision (approved, cancelled, rejected) and each line's outcome |
| 856 ship notice | Out | The shipped shipment's actual packages and contents, Shipment/Order/Pack/Item |
| 810 invoice | Out | The sales invoice at the profile's billing status (`InvoiceFinalized` in the sample); not a new posting |
| 997 functional acknowledgment | Both | Sent for each received group after validation; a received one accepts or rejects the documents sent. A 997 is never acknowledged |

This is the common port, not any retailer's certification: a partner's guide is a profile of its own (below).

## Configuration

| Record | What goes there |
| --- | --- |
| `SystemMessageRemote` | The connection to one partner in one environment: the transport (`sendServiceName`, `sendUrl`, credentials in the encrypted fields), `internalIdType`/`internalId` and `remoteIdType`/`remoteId` (ISA05-08), `internalAppCode`/`remoteAppCode` (GS02/03), `usageCode` (ISA15, `T` or `P`), `ackRequested` (ISA14), and the separators (`segmentTerminator`, `elementSeparator`, `componentDelimiter`; `~`, `*`, `:` when empty). `systemMessageTypeId` `EdiX12` |
| `EdiConnection` | Shares the remote's key: `ediProfileId`, `productStoreId` (the organization, currency and facility of the orders), `partnerPartyId` (the customer), `sendOnCommit` (`N` to batch sends for the job) |
| `EdiProfile` | A versioned rule set: `x12Version` (`004010`), `profileRevision`, `generateFunctionalAck`, `expectFunctionalAck`, `ackOverdueMinutes`, `requireSscc`, `asnPackagingCode` (TD101 of the 856), `invoiceStatusId` (any invoice status: the SECA takes every status change) |
| `EdiProfileDocument` | Per transaction set and direction: functional ID, grammar location and mapping service |
| `EdiProfileCode` | The crosswalks: `EdctUom` (X12 unit to Uom), `EdctWeightUom`, `EdctProductId` (a qualifier to `productId`, a ProductIdentification type, or `buyer`), `EdctCharge` (SAC02 with `A`/`C` to an item type), `EdctTax` (TXI01 to an item type). A code not listed is not supported |
| `EdiLocation` | The partner's location codes (N103/N104, such as `92` store numbers or `UL` GLNs) for a party and its postal address: the 850's ship-to, and the code sent back in the 856 and 810 |
| `ShipmentPackage.sscc` | A package's 18-digit SSCC for MAN*GM (allocating SSCCs and GS1-128 labels is not in Mantle yet) |

`data/EdiSetupData.xml` has the `EdiX12` message type and the `EDI_ADMIN` permission; `data/EdiSampleProfileData.xml`
(seed-initial) the generic sample profile `X12_4010_SAMPLE` and the job `send_EdiPendingDocuments` (on, every 15
minutes; two indexed queries when there is nothing to send). Copy the
sample for a partner (a new ID or revision), never edit a profile a connection is using. Credentials go in the System
Message Remote screen or a deployment's own data file.

## Receiving

1. **Receipt before parsing.** The transport (`/rest/sm/EdiX12/{remote}` or `poll#SystemMessageSftp`) authenticates the
   connection; `receive#X12Interchange` keeps the bytes as they came, once per remote and content
   (`store#ReceivedSystemMessage`), before anything is parsed. A second delivery of the same bytes is a duplicate and is
   not consumed again.
2. **Envelope** (`store#ReceivedInterchanges`, one transaction). Every ISA of the receipt, every GS and every ST is
   recorded (`EdiInterchange`, `EdiGroup`, `EdiDocument` with its exact text). An interchange that cannot be trusted is
   quarantined with its text and the receipt is put in error after the others are processed: no ISA, its fixed form,
   ISA12 other than `00401`, ISA13, IEA01/IEA02, segments outside a group, a sender, receiver, application code or usage
   other than the connection's, or a remote that is no EDI connection. The connection routes; IDs in the payload never
   pick an organization or mapping. A group is rejected as a whole (AK905) for its trailer (3), GE02 (4), GE01 (5),
   GS06 (6), version (2, visible as `UNSUPPORTED_VERSION`) or a functional ID the profile does not take (1). A set is
   rejected (AK502) for its SE (2), SE02 (3), SE01 (4), ST02 (7, 23 when repeated) or ST01 (1, 6).
3. **Validation** (`validate#InboundDocument`, one transaction per document): the grammar (order, `MIN`/`MAX`,
   undefined segments), the profile's element rules (required, type, length, code subset) and the 850's totals (CTT01
   line count, CTT02 hash of PO102, AMT*TT). Validated, or Rejected with the AK3/AK4 the 997 reports.
4. **997** (`record#GroupAcknowledgment`): for each received group except a 997 group, when the profile sends them, with
   AK2/AK5 per set (AK1 and AK9 only for a group rejected as a whole) and AK9 A, P or R.
5. **Application** (`apply#InboundDocument`, one transaction per document, the connection locked): the profile's
   mapping service. A refusal rolls that back and the document becomes an Exception with its reason code, for an
   operator; it is not a syntax error, so the 997 still accepts it.

The receipt ends Consumed only when everything is finished. A quarantined interchange, a document left Stored or
Validated (its step could not be recorded) or a group owed a 997 that has none puts it in SmsgError with a
SystemMessageError naming each. `retry#Receipt` (EDI_ADMIN) consumes it again from its kept bytes and records: it
checks its quarantined interchanges again (one now trusted, after the connection was fixed, replaces its quarantine,
which becomes Superseded) and repeats nothing done. A resend of the same bytes is a duplicate receipt, so this is how a
quarantine is recovered. Control numbers and counts compare as numbers (`0001` and `1`); segments outside any
interchange are the receipt's own error (receipt sequence 0) and do not quarantine its interchanges.

## Identity

- The business identity of an 850 is its PO number and release (`businessKey`), scoped by organization, partner,
  environment (usage), direction and set. The same identity applied before with the same content (a hash of the
  segments without ST and SE) is a Duplicate, linked to the first order; with changed content a Conflict for review. No
  second order either way.
- An interchange's same bytes again under a new receipt is a Duplicate interchange; a control number reused with other
  content is processed (the business identity decides) and noted.
- Control numbers sent are allocated in `EdiControlSequence` per organization, partner, usage and direction (ISA13 and
  GS06; ST02 `0001`, one set per group), under the row's lock in the transaction that records the envelope with its
  SystemMessage; a scope's row is made first in a transaction of its own, so two first allocations at once get 1 and 2.
  A retry sends the recorded message again with the same controls.
- The content and receipt hashes are the framework's single-use code hash, whose digest follows the conf's password
  hash type (SHA-256 by default): after a change of that type an 850 resent is a Conflict instead of a Duplicate, and
  its bytes a new receipt, as the payment idempotency keys of the Phase 0 record are affected.

## Sending

- **Recorded with the business transaction.** SECAs (`service/Edi.secas.xml`) record a Pending document when an EDI
  order is approved, cancelled or rejected (855), its shipment ships (856) and its invoice reaches the profile's billing
  status (810), as the record's next `documentRevision` (`purposeCode` 00, then 05); an older one not produced yet is
  Superseded (locked and read again first: one the job is producing is sent as it is). A rollback leaves nothing.
- **Produced and sent after the commit** (`send#PendingDocuments`, registered on commit unless the connection batches,
  and the job). Each document's body comes from its mapping service in a transaction of its own, is checked on its
  grammar, and is kept with its envelope, controls and outgoing SystemMessage in one transaction (Produced); a refusal is
  recorded (Refused, with its reason) and nothing is sent; a failure with no reason code (a lock, a lost connection)
  leaves it Pending for the next run. An identifier is never altered to fit: an element holding a separator is refused
  (`SEPARATOR_IN_DATA`); names and descriptions are cleaned of separators instead. The ISA's values from the remote are
  checked against their widths, and the generated ISA must be 106 characters. Then the message is sent and the document
  recorded Sent. A crash after the commit leaves it Pending or Produced for the job; a failed send leaves it Produced
  with the same bytes. A receipt's 997s are sent after its consume commits, as the other documents are.
- **Acknowledged.** The partner's 997 accepts (Accepted) or rejects (AckRejected) each set sent and confirms or rejects
  its SystemMessage. `find#OverdueAcknowledgments` lists documents sent whose 997 is later than `ackOverdueMinutes`
  (overdueList, found in the query per connection), and documents stuck: Pending or Produced longer than
  `stuckMinutes`, or with their message in error, and Refused (stuckList).
- **Retry.** `retry#Document` (EDI_ADMIN) applies a received document in exception again, produces a refused one again,
  or sends a produced one whose message is in error again with the same bytes, keeping its ID and revision.

## The sample profile's subset

Codes are the profile's implementation subset: a code outside it is an invalid code (AK403 7) in the 997.

| Set | Taken or sent | Refused |
| --- | --- | --- |
| 850 | BEG (00; SA, NE), CUR (must be the store's currency), REF, PER and TD5 (read, not applied), DTM 001/002/010/037/038 (auto-cancel, delivery, ship, ship after, ship before), N9/MSG (an order note), N1 (ST required, by `EdiLocation`; BT, BY, VN, SF read), PO1 (quantity, an `EdctUom` unit, price basis PE, product IDs by `EdctProductId`, all naming one product), PID (description), SAC at header and line (A/C with an `EdctCharge` code, a stated amount in SAC05, handling 02 or 06), CTT/AMT*TT | Any other segment (`UNSUPPORTED_SEGMENT`, such as SCH, SDQ, ITD, TAX, line N1), a SAC percentage or rate (`SAC_UNSUPPORTED`), an unknown ship-to (`SHIP_TO_UNKNOWN`) or item (`ITEM_UNKNOWN`, `ITEM_MISMATCH`), another currency |
| 855 | BAK AD/AC/RD with the PO's release (BAK05) and the seller's order ID; PO1 with ACK IA, IQ (quantity), IP (price), IC (both), IR (cancelled line, or a rejected or cancelled order) | Lines the seller added (`LINE_ADDED_UNSUPPORTED`), an undecided order, several parts. SAC charges are not acknowledged |
| 856 | BSN (hierarchy 0001); HL S with TD1 (packages, gross weight), TD5 (the method's SCAC), REF*CN, DTM*011, N1 ST and SF; HL O with PRF (with the release); HL P with MAN*GM (SSCC) or MAN*CP (tracking); HL I with LIN and SN1; CTT the HL count | A product of two order lines, unpacked contents, a package of two orders, a missing (when required) or invalid SSCC, an unmapped weight unit |
| 810 | BIG (with the release in BIG05), N1 RE and ST, ITD (due date), IT1 per product line with its child SACs, TDS (N2), TXI for tax items, summary SAC, CTT | An unmapped item type (`CHARGE_UNSUPPORTED`), a charge with an allowance's sign, more than two decimals for N2, several orders, lines and charges that do not make the invoice total (`TOTAL_MISMATCH`) |
| 997 | AK1, AK2, AK3/AK4, AK5, AK9 | A 997 for a group or set not sent (`ACK_UNMATCHED`) |

## Parser limits

`EdiHandler` (framework `crates/moqui-core/src/edi.rs`) parses a set on a Bots grammar and reports undefined segments,
segments out of their level's order, `MIN`/`MAX` and a segment left after the root. It does not check element values:
the element rules above are Mantle's, for the segments the profile reads, not X12's full data dictionary or code lists.
X12 has no release character, so a separator inside a value cannot be received; values sent are cleaned of separators
and control characters. The envelope pass reads separators from the first ISA's fixed positions, which every ISA of the
receipt must share. Only X12 4010 (`00401`/`004010`) is taken; EDIFACT parses in the framework but has no Mantle
mappings. TA1, 999, 824, 860 and 865 are not supported. In an AK3, AK303 (the loop ID) is empty, and a missing
mandatory segment is reported at the position of the segment that holds its level (ST for a missing BEG).

## Transport

A connection's transport is its remote's send service: `org.moqui.sftp.SftpMessageServices.send#SystemMessageSftp`
and `poll#SystemMessageSftp` (with `receivePath`, `receiveFilePattern`, `receiveResponseEnumId` and `sendPath` on the
`EdiX12` type), or `send#SystemMessageRest` and the `/rest/sm` endpoint. The poll isolates each file and deletes or
moves one only after its receipt is durable. Each document goes in its own interchange; batching several sets per
interchange is a partner rule not in the sample.
