// Marketing's segments (impl-marketing P5; design-marketing §4 Segments, SegmentDetail; mantle.marketing.SegmentServices over
// MarketingSegments.js): a child segment is its parent's match intersected with its own, and a cycle of parents is refused; an
// explicit exclusion wins over every match and an inclusion joins the rule match within the parent; dimension bounds are inclusive
// after a unit conversion; a filter on Sales' leads is refused to an editor without a Sales read, at store and at evaluation, while one
// who reads Sales matches the contacts of the leads they see, and a missing value never matches through a negation; an evaluation
// subscribes no one, another organization's segment answers as missing and a reader without the audience permission is refused.
// Standalone: spec-local organizations, users, parties and segments.
// Run: ./moq test mr-mantle --spec Segments
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const entityLib = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js")
const {make, row, rows, system, organization, user, as} = lib
const prefix = "MKG"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const Q = "mantle.marketing.SegmentServices."
const users = {}
const party = {}
const audience = ["MARKETING_VIEW", "MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT"]
const segment = {}
const revision = marketSegmentId =>
    entityLib.ms(row("mantle.marketing.segment.MarketSegment", {marketSegmentId}).lastUpdatedStamp)
const matched = out =>
    Array.from(out.evaluationList || [])
        .filter(item => item.matched)
        .map(item => item.partyId)
        .sort()
const leftOut = out =>
    Object.fromEntries(
        Array.from(out.evaluationList || [])
            .filter(item => !item.matched)
            .map(item => [item.partyId, item.reason])
    )
// a segment made by the editor with its rules applied one change at a time
function made(name, fields, rules = []) {
    const out = as(users.editor, Q + "store#Segment", Object.assign({organizationPartyId: orgA, segmentName: name}, fields))
    if (out.refusal) throw new Error("segment " + name + ": " + out.refusal)
    for (const rule of rules) {
        const change = as(
            users.editor,
            Q + "store#SegmentRules",
            Object.assign({marketSegmentId: out.marketSegmentId, expectedRevision: revision(out.marketSegmentId)}, rule)
        )
        if (change.refusal) throw new Error("rule of " + name + ": " + change.refusal)
    }
    return out.marketSegmentId
}

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Segments A")
            organization(orgB, "Segments B")
            users.editor = user(prefix, "editor", [orgA], audience)
            users.sales = user(prefix, "sales", [orgA], audience.concat(["SALES_VIEW", "SALES_TEAM_VIEW"]))
            users.editorB = user(prefix, "editorB", [orgB], audience)
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            make("mantle.party.PartyClassification", {partyClassificationId: prefix + "_GARDENER", description: "Gardener"})
            // Ann, Ben, Cyd, Dee, Eve and Fay, people of A; Gil a person of B
            for (const name of ["Ann", "Ben", "Cyd", "Dee", "Eve", "Fay", "Gil"]) {
                party[name] = prefix + "_" + name.toUpperCase()
                make("mantle.party.Party", {
                    partyId: party[name],
                    partyTypeEnumId: "PtyPerson",
                    ownerPartyId: name === "Gil" ? orgB : orgA
                })
                make("mantle.party.Person", {partyId: party[name], firstName: name, lastName: "Segmentspec"})
            }
            // gardeners: Ann, Ben, Cyd; in California: Ben, Cyd, Dee (Dee in a county of a group too)
            for (const name of ["Ann", "Ben", "Cyd"])
                make("mantle.party.PartyClassificationAppl", {
                    partyId: party[name],
                    partyClassificationId: prefix + "_GARDENER",
                    fromDate: 0
                })
            for (const name of ["Ben", "Cyd", "Dee"]) {
                make("mantle.party.contact.ContactMech", {
                    contactMechId: party[name] + "_PA",
                    contactMechTypeEnumId: "CmtPostalAddress"
                })
                make("mantle.party.contact.PostalAddress", {
                    contactMechId: party[name] + "_PA",
                    address1: "1 Spec Way",
                    city: "Sacramento",
                    countryGeoId: "USA",
                    stateProvinceGeoId: "USA_CA"
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId: party[name],
                    contactMechId: party[name] + "_PA",
                    contactMechPurposeId: "PostalPrimary",
                    fromDate: 0
                })
            }
            // heights: Ann 1 m, Ben 2 m, Cyd 2.5 m, Dee 99 cm (the rule in centimetres)
            for (const [name, value, uomId] of [
                ["Ann", 1, "LEN_m"],
                ["Ben", 2, "LEN_m"],
                ["Cyd", 2.5, "LEN_m"],
                ["Dee", 99, "LEN_cm"]
            ])
                make("mantle.party.PartyDimension", {
                    partyId: party[name],
                    uomDimensionTypeId: "Height",
                    dimensionDate: new Date(Date.now() - 86400000),
                    value,
                    uomId
                })
            // a lead of A whose contact is Eve, seen by a Sales reader of A's whole pipeline
            make("mantle.sales.opportunity.SalesOpportunity", {
                salesOpportunityId: prefix + "_LEAD",
                opportunityName: "Spec lead",
                typeEnumId: "SotLead",
                organizationPartyId: orgA,
                statusId: "SalesOppOpen"
            })
            make("mantle.sales.opportunity.SalesOpportunityParty", {
                salesOpportunityId: prefix + "_LEAD",
                partyId: party.Eve,
                roleTypeId: "Contact",
                fromDate: 0
            })
        })
        segment.parent = made("Gardeners", {}, [{action: "addClassification", partyClassificationId: prefix + "_GARDENER"}])
        segment.child = made("Californian gardeners", {parentMarketSegmentId: segment.parent}, [
            {action: "addGeo", geoId: "USA_CA"}
        ])
    }
})

feature("a child is its parent's match intersected with its own; a cycle of parents is refused", {
    when() {
        return {
            parent: as(users.editor, Q + "evaluate#Segment", {marketSegmentId: segment.parent}),
            child: as(users.editor, Q + "evaluate#Segment", {marketSegmentId: segment.child, show: "all"}),
            cycle: as(users.editor, Q + "store#Segment", {
                marketSegmentId: segment.parent,
                expectedRevision: revision(segment.parent),
                parentMarketSegmentId: segment.child
            }),
            self: as(users.editor, Q + "store#Segment", {
                marketSegmentId: segment.child,
                expectedRevision: revision(segment.child),
                parentMarketSegmentId: segment.child
            }),
            stale: as(users.editor, Q + "store#Segment", {
                marketSegmentId: segment.child,
                expectedRevision: revision(segment.child) - 1000,
                segmentName: "Renamed"
            })
        }
    },
    then({parent, child, cycle, self, stale}) {
        parent.refusal == ""
        matched(parent) == [party.Ann, party.Ben, party.Cyd].sort()
        child.refusal == ""
        matched(child) == [party.Ben, party.Cyd].sort()
        // Dee is in California but no gardener: left out by the parent, with the reason
        leftOut(child)[party.Dee].includes("Outside the parent segment")
        child.matchedCount == 2 && child.excludedCount == 1
        cycle.refusal.includes("PARENT_CYCLE")
        self.refusal.includes("PARENT_CYCLE")
        stale.refusal.includes("STALE_REVISION")
    }
})

feature("an explicit exclusion wins over every match; an inclusion joins the rule match within the parent", {
    when() {
        const member = (partyId, memberKindEnumId) =>
            as(users.editor, Q + "store#SegmentMember", {marketSegmentId: segment.child, partyId, memberKindEnumId})
        const out = {
            excludeBen: member(party.Ben, "MspExclude"),
            includeAnn: member(party.Ann, "MspInclude"),
            includeFay: member(party.Fay, "MspInclude"),
            otherParty: member(party.Gil + "_NONE", "MspInclude")
        }
        out.child = as(users.editor, Q + "evaluate#Segment", {marketSegmentId: segment.child, show: "all"})
        // an ended exclusion no longer applies; a second add of the same row names its revision
        const benRow = row("mantle.marketing.segment.MarketSegmentParty", {
            marketSegmentId: segment.child,
            partyId: party.Ben,
            roleTypeId: "_NA_"
        })
        out.endUnnamed = as(users.editor, Q + "store#SegmentMember", {
            marketSegmentId: segment.child,
            partyId: party.Ben,
            action: "end"
        })
        out.end = as(users.editor, Q + "store#SegmentMember", {
            marketSegmentId: segment.child,
            partyId: party.Ben,
            action: "end",
            expectedRevision: entityLib.ms(benRow.lastUpdatedStamp)
        })
        out.after = as(users.editor, Q + "evaluate#Segment", {marketSegmentId: segment.child})
        return out
    },
    then({excludeBen, includeAnn, includeFay, otherParty, child, endUnnamed, end, after}) {
        excludeBen.refusal == "" && includeAnn.refusal == "" && includeFay.refusal == ""
        otherParty.refusal.includes("RECORD_UNAVAILABLE")
        // Ann (a gardener outside California) is included; Ben excluded though his rules match; Fay included but no gardener
        matched(child) == [party.Ann, party.Cyd].sort()
        leftOut(child)[party.Ben] == "Excluded explicitly"
        leftOut(child)[party.Fay].includes("Outside the parent segment")
        Array.from(child.evaluationList)
            .find(item => item.partyId == party.Ann)
            .reason.includes("Included")
        endUnnamed.refusal.includes("REVISION_REQUIRED")
        end.refusal == ""
        matched(after) == [party.Ann, party.Ben, party.Cyd].sort()
        // the ended row kept, never deleted
        row("mantle.marketing.segment.MarketSegmentParty", {
            marketSegmentId: segment.child,
            partyId: party.Ben,
            roleTypeId: "_NA_"
        }).thruDate != null
    }
})

feature("dimension bounds are inclusive after a unit conversion", {
    when() {
        const tall = made("Between one and two metres", {}, [
            {action: "storeDimension", uomDimensionTypeId: "Height", uomId: "LEN_cm", minValue: "100", maxValue: "200"}
        ])
        return {
            tall: as(users.editor, Q + "evaluate#Segment", {marketSegmentId: tall}),
            bad: as(users.editor, Q + "store#SegmentRules", {
                marketSegmentId: tall,
                expectedRevision: revision(tall),
                action: "storeDimension",
                uomDimensionTypeId: "Height",
                minValue: "300",
                maxValue: "200"
            })
        }
    },
    then({tall, bad}) {
        tall.refusal == ""
        // Ann's 1 m and Ben's 2 m are the bounds themselves; Cyd's 2.5 m and Dee's 99 cm are outside
        matched(tall) == [party.Ann, party.Ben].sort()
        bad.refusal.includes("RULE_INVALID")
    }
})

feature(
    "a Sales filter is refused to an editor without a Sales read, at store and at evaluation; a missing value never matches",
    {
        when() {
            const leads = made("Open leads", {})
            const condition = {action: "addCondition", fieldKey: "salesLead.openLead", operator: "is", value: "true"}
            const out = {
                refused: as(
                    users.editor,
                    Q + "store#SegmentFilter",
                    Object.assign({marketSegmentId: leads, expectedRevision: revision(leads)}, condition)
                )
            }
            out.stored = as(
                users.sales,
                Q + "store#SegmentFilter",
                Object.assign({marketSegmentId: leads, expectedRevision: revision(leads)}, condition)
            )
            out.salesEvaluation = as(users.sales, Q + "evaluate#Segment", {marketSegmentId: leads})
            out.editorEvaluation = as(users.editor, Q + "evaluate#Segment", {marketSegmentId: leads})
            out.editorSources = as(users.editor, Q + "get#Segment", {marketSegmentId: leads})
            // not in California: a party with no address has no state, so it is not matched by the negation
            const elsewhere = made("Not Californian", {})
            out.negation = as(users.editor, Q + "store#SegmentFilter", {
                marketSegmentId: elsewhere,
                expectedRevision: revision(elsewhere),
                action: "addCondition",
                fieldKey: "contact.stateProvince",
                operator: "not-equals",
                value: "USA_CA"
            })
            out.entity = as(users.editor, Q + "store#SegmentFilter", {
                marketSegmentId: elsewhere,
                expectedRevision: revision(elsewhere),
                action: "replace",
                filter: {
                    match: "all",
                    conditions: [{source: "mantle.party.Party", field: "partyId", operator: "equals", value: "X"}]
                }
            })
            out.notCalifornian = as(users.editor, Q + "evaluate#Segment", {marketSegmentId: elsewhere})
            return out
        },
        then({refused, stored, salesEvaluation, editorEvaluation, editorSources, negation, entity, notCalifornian}) {
            refused.refusal.includes("SOURCE_UNAVAILABLE")
            stored.refusal == ""
            salesEvaluation.refusal == ""
            matched(salesEvaluation) == [party.Eve]
            // the editor gets no count of a source they cannot read
            editorEvaluation.refusal.includes("SOURCE_UNAVAILABLE") && editorEvaluation.matchedCount == null
            !Array.from(editorSources.sources).some(source => source.source == "salesLead")
            editorSources.filter.readable == false
            negation.refusal == ""
            entity.refusal.includes("FILTER_INVALID")
            notCalifornian.refusal == ""
            // Ben, Cyd and Dee are Californians; the others have no address and are not matched
            matched(notCalifornian).length == 0
        }
    }
)

feature("an evaluation subscribes no one; another organization's segment is missing; a reader without audiences is refused", {
    when() {
        const counts = () => ({
            members: rows("mantle.marketing.contact.ContactListParty", {partyId: party.Ann}).length,
            consents: rows("mantle.party.PartyConsent", {partyId: party.Ann}).length,
            segmentRows: rows("mantle.marketing.segment.MarketSegmentParty", {partyId: party.Ann}).length
        })
        const before = counts()
        const evaluated = as(users.editor, Q + "evaluate#Segment", {marketSegmentId: segment.parent})
        return {
            before,
            after: counts(),
            evaluated,
            other: as(users.editorB, Q + "evaluate#Segment", {marketSegmentId: segment.parent}),
            otherGet: as(users.editorB, Q + "get#Segment", {marketSegmentId: segment.parent}),
            reader: as(users.reader, Q + "evaluate#Segment", {marketSegmentId: segment.parent}),
            readerStore: as(users.reader, Q + "store#Segment", {organizationPartyId: orgA, segmentName: "Reader's"}),
            found: as(users.editor, Q + "find#Segments", {text: "gardeners"}),
            foundB: as(users.editorB, Q + "find#Segments", {})
        }
    },
    then({before, after, evaluated, other, otherGet, reader, readerStore, found, foundB}) {
        evaluated.refusal == "" && evaluated.matchedCount == 3
        after == before
        other.refusal.includes("RECORD_UNAVAILABLE")
        otherGet.refusal.includes("RECORD_UNAVAILABLE")
        reader.refusal.includes("PERMISSION_DENIED")
        readerStore.refusal.includes("PERMISSION_DENIED")
        found.segmentListCount == 2
        Array.from(found.segmentList).find(item => item.marketSegmentId == segment.child).parentName == "Gardeners"
        foundB.segmentListCount == 0
    }
})
