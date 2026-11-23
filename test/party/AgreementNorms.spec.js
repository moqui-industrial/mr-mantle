// Norms as agreements (entity/party/AgreementEntities.xml): a regulation in two language editions with its identifiers,
// its partitions as a tree of items in printed order with their provision types, a citation from one item to an item of
// the other edition's act, and an amending act whose association to the item it replaces takes effect on a date, with
// the replaced item no longer applying from then.
// Run: ./moq test mr-mantle --spec AgreementNorms
const created = []
const make = (entity, fields) => {
    const v = ec.entity.makeValue(entity).setAll(fields).create()
    created.push(v)
    return v
}
const item = (agreementId, agreementItemSeqId, fields) => make("mantle.party.agreement.AgreementItem",
    Object.assign({agreementId, agreementItemSeqId}, fields))
const TS = text => ec.user.timestampMillis(text)

spec({
    setupSpec() {
        ec.artifactExecution.disableAuthz()
        make("mantle.party.agreement.Agreement", {agreementId: "AGN_REG_EN", agreementTypeEnumId: "AgrLegislation",
            documentTypeEnumId: "AdtRegulation", description: "Regulation on spec machinery", locale: "en", versionName: "2026",
            jurisdictionGeoId: "EUR", agreementDate: "2026-01-10 00:00:00", publicationDate: "2026-01-20 00:00:00",
            fromDate: "2026-02-09 00:00:00", applicableDate: "2028-02-09 00:00:00"})
        make("mantle.party.agreement.Agreement", {agreementId: "AGN_REG_IT", agreementTypeEnumId: "AgrLegislation",
            documentTypeEnumId: "AdtRegulation", description: "Regolamento sulle macchine di prova", locale: "it"})
        make("mantle.party.agreement.Agreement", {agreementId: "AGN_AMD_EN", agreementTypeEnumId: "AgrLegislation",
            documentTypeEnumId: "AdtAmendment", description: "Amendment of the spec regulation", locale: "en"})
        make("mantle.party.agreement.AgreementIdentification", {agreementId: "AGN_REG_EN", agreementIdTypeEnumId: "AgidCelex", idValue: "32026R9999"})
        make("mantle.party.agreement.AgreementIdentification", {agreementId: "AGN_REG_EN", agreementIdTypeEnumId: "AgidEli",
            idValue: "http://data.europa.eu/eli/reg/2026/9999/oj"})
        item("AGN_REG_EN", "ART1", {agreementItemTypeEnumId: "AitArticle", itemNumber: "1", itemTitle: "Subject matter", sequenceNum: 1})
        item("AGN_REG_EN", "ART2", {agreementItemTypeEnumId: "AitArticle", itemNumber: "2", itemTitle: "Obligations", sequenceNum: 2})
        item("AGN_REG_EN", "ART2.p2", {agreementItemTypeEnumId: "AitParagraph", parentItemSeqId: "ART2", itemNumber: "2",
            sequenceNum: 2, provisionTypeEnumId: "AptRecommendation", itemText: "Manufacturers should keep records."})
        item("AGN_REG_EN", "ART2.p1", {agreementItemTypeEnumId: "AitParagraph", parentItemSeqId: "ART2", itemNumber: "1",
            sequenceNum: 1, provisionTypeEnumId: "AptRequirement", itemText: "Manufacturers shall assess the risks referred to in Article 1.",
            sourceLocation: "page 4", thruDate: "2029-01-01 00:00:00"})
        item("AGN_REG_EN", "ANXI", {agreementItemTypeEnumId: "AitAnnex", itemNumber: "I", itemTitle: "Guidance", sequenceNum: 3, informative: "Y"})
        item("AGN_REG_IT", "ART2.p1", {agreementItemTypeEnumId: "AitParagraph", itemText: "I fabbricanti valutano i rischi."})
        item("AGN_AMD_EN", "ART1", {agreementItemTypeEnumId: "AitArticle", itemNumber: "1", itemText: "Article 2(1) is replaced by the following."})
        make("mantle.party.agreement.AgreementAssoc", {agreementAssocId: "AGN_A1", agreementId: "AGN_REG_IT", toAgreementId: "AGN_REG_EN",
            agreementAssocTypeEnumId: "AatTranslation"})
        make("mantle.party.agreement.AgreementAssoc", {agreementAssocId: "AGN_A2", agreementId: "AGN_REG_EN", agreementItemSeqId: "ART2.p1",
            toAgreementId: "AGN_REG_EN", toAgreementItemSeqId: "ART1", agreementAssocTypeEnumId: "AatReference",
            assocText: "Article 1", sequenceNum: 1})
        make("mantle.party.agreement.AgreementAssoc", {agreementAssocId: "AGN_A3", agreementId: "AGN_AMD_EN", agreementItemSeqId: "ART1",
            toAgreementId: "AGN_REG_EN", toAgreementItemSeqId: "ART2.p1", agreementAssocTypeEnumId: "AatAmendment",
            assocText: "Article 2(1) is replaced", fromDate: "2029-01-01 00:00:00"})
        make("moqui.basic.Enumeration", {enumId: "AGN_ROLE_IN", enumTypeId: "DevicePurpose", description: "Input of a function"})
        make("mantle.product.Product", {productId: "AGN_SF1", productTypeEnumId: "PtFunction", productName: "Guard interlock", purposeEnumId: "DepProtectionControl"})
        make("mantle.product.Product", {productId: "AGN_SW1", productTypeEnumId: "PtAsset", productName: "Interlock switch"})
        make("mantle.product.ProductAssoc", {productId: "AGN_SF1", toProductId: "AGN_SW1", productAssocTypeEnumId: "PatFunctionMember",
            fromDate: "2026-01-01 00:00:00", purposeEnumId: "AGN_ROLE_IN"})
        make("mantle.request.requirement.Requirement", {requirementId: "AGN_RQ1", productId: "AGN_SF1", agreementId: "AGN_REG_EN",
            agreementItemSeqId: "ART2.p1", description: "Assess the risks of the guard interlock"})
    },
    cleanupSpec() {
        try {
            while (created.length) created.pop().delete()
        } finally {
            ec.artifactExecution.enableAuthz()
        }
    }
})

feature("a regulation with its dates, kind and identifiers", {
    expect() {
        const reg = ec.entity.find("mantle.party.agreement.Agreement").condition("agreementId", "AGN_REG_EN").one()
        reg.locale == "en"
        reg.documentType.parentEnumId == "AgrLegislation"
        reg.jurisdictionGeoId == "EUR"
        TS(reg.applicableDate) > TS(reg.fromDate)
        TS(reg.fromDate) > TS(reg.publicationDate)
        Array.from(reg.identifications).map(i => i.agreementIdTypeEnumId).sort().join(",") == "AgidCelex,AgidEli"
        ec.entity.find("mantle.party.agreement.AgreementIdentification").condition("idValue", "32026R9999").one().agreementId == "AGN_REG_EN"
    }
})

feature("the partitions as a tree in printed order, with their provision types", {
    expect() {
        const art2 = ec.entity.find("mantle.party.agreement.AgreementItem").condition({agreementId: "AGN_REG_EN", agreementItemSeqId: "ART2"}).one()
        const children = Array.from(art2.findRelated("childItems", null, ["sequenceNum"], false, false))
        children.map(c => c.agreementItemSeqId).join(",") == "ART2.p1,ART2.p2"
        children[0].parentItem.itemTitle == "Obligations"
        children[0].provisionType.enumCode == "shall"
        children[1].provisionType.enumCode == "should"
        ec.entity.find("mantle.party.agreement.AgreementItem").condition({agreementId: "AGN_REG_EN", agreementItemSeqId: "ANXI"}).one().informative == "Y"
    }
})

feature("a citation and a translation between items", {
    expect() {
        const cites = ec.entity.find("mantle.party.agreement.AgreementAssoc").condition({agreementId: "AGN_REG_EN", agreementItemSeqId: "ART2.p1",
            agreementAssocTypeEnumId: "AatReference"}).list()
        cites.length == 1
        cites[0].toItem.itemTitle == "Subject matter"
        cites[0].item.sourceLocation == "page 4"
        const tr = ec.entity.find("mantle.party.agreement.AgreementAssoc").condition({agreementId: "AGN_REG_IT", agreementAssocTypeEnumId: "AatTranslation"}).one()
        ec.entity.find("mantle.party.agreement.AgreementItem").condition({agreementId: tr.toAgreementId, agreementItemSeqId: "ART2.p1"}).count() == 1
    }
})

feature("an amendment replaces an item from its date", {
    expect() {
        const before = "2028-06-01 00:00:00", after = "2029-06-01 00:00:00"
        const applying = moment => ec.entity.find("mantle.party.agreement.AgreementItem").condition({agreementId: "AGN_REG_EN", parentItemSeqId: "ART2"})
                .conditionDate("fromDate", "thruDate", moment).list().map(i => i.agreementItemSeqId).sort().join(",")
        applying(before) == "ART2.p1,ART2.p2"
        applying(after) == "ART2.p2"
        const amd = ec.entity.find("mantle.party.agreement.AgreementAssoc").condition({toAgreementId: "AGN_REG_EN", toAgreementItemSeqId: "ART2.p1",
            agreementAssocTypeEnumId: "AatAmendment"}).conditionDate("fromDate", "thruDate", after).list()
        amd.length == 1
        amd[0].agreement.documentTypeEnumId == "AdtAmendment"
        ec.entity.find("mantle.party.agreement.AgreementAssoc").condition({toAgreementId: "AGN_REG_EN", agreementAssocTypeEnumId: "AatAmendment"})
                .conditionDate("fromDate", "thruDate", before).count() == 0
    }
})

feature("a requirement of an item on a function product and its member", {
    expect() {
        const rq = ec.entity.find("mantle.request.requirement.Requirement").condition("requirementId", "AGN_RQ1").one()
        rq.agreementItem.provisionTypeEnumId == "AptRequirement"
        rq.product.productTypeEnumId == "PtFunction"
        rq.product.purpose.enumTypeId == "DevicePurpose"
        const members = ec.entity.find("mantle.product.ProductAssoc").condition({productId: "AGN_SF1", productAssocTypeEnumId: "PatFunctionMember"}).list()
        members.length == 1
        members[0].memberRole.enumId == "AGN_ROLE_IN"
        ec.entity.find("mantle.request.requirement.Requirement").condition({agreementId: "AGN_REG_EN", agreementItemSeqId: "ART2.p1"}).count() == 1
    }
})
