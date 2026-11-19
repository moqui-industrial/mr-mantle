/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The record type registrations (mantle.party.communication.RecordLinkType, SEC-BOS-87): which types get#RecordLinkInfo
 * rules in its own code, so a registration of one may say codeRule Y, and what is wrong with a registration as loaded.
 */
// the types get#RecordLinkInfo's joins and rules cover (Mantle's seed rows in entity/PartyEntities.xml): only these may claim
// codeRule; any other registration names its own rule
const codeRuled = new Set([
    "mantle.order.OrderHeader",
    "mantle.request.Request",
    "mantle.work.effort.WorkEffort",
    "moqui.resource.wiki.WikiPage",
    "mantle.sales.opportunity.SalesOpportunity",
    "mantle.party.Party",
    "mantle.facility.Facility",
    "mantle.ledger.transaction.AcctgTrans",
    "mantle.product.bom.ProductBom",
    "mantle.party.agreement.Agreement",
    "mantle.product.maintenance.AssetMaintenance",
    "mantle.party.communication.CommunicationEvent",
    "mantle.account.invoice.Invoice",
    "mantle.account.payment.Payment",
    "mantle.account.method.PaymentMethod",
    "mantle.product.Product",
    "mantle.product.category.ProductCategory",
    "mantle.shipment.Shipment",
    "mantle.product.asset.Asset",
    "mantle.product.quality.QualityInspection",
    "mantle.order.return.ReturnHeader",
    "mantle.humanres.employment.Employment",
    "mantle.humanres.employment.EmploymentApplication",
    "mantle.humanres.ability.PartyQualification",
    "mantle.humanres.ability.PerformanceReview",
    "mantle.humanres.payroll.Payslip",
    "mantle.marketing.campaign.MarketingCampaign",
    "mantle.marketing.campaign.CampaignSend",
    "mantle.work.registration.EventRegistration",
    "moqui.resource.GitMergeRequest",
    "moqui.resource.GitRepository",
    "mantle.work.time.Timesheet",
    "moqui.security.UserAccount",
    "moqui.security.UserGroup",
    "moqui.entity.EntityAuditLog",
    "mantle.ledger.transaction.AcctgTransContent",
    "mantle.account.invoice.InvoiceContent",
    "mantle.account.payment.PaymentContent",
    "mantle.account.method.PaymentMethodContent",
    "mantle.product.asset.AssetContent",
    "mantle.order.return.ReturnContent",
    "mantle.product.quality.QualityInspectionContent",
    "mantle.sales.opportunity.SalesOpportunityContent",
    "mantle.marketing.campaign.CampaignSendContent",
    "mantle.work.registration.EventRegistrationContent",
    "mantle.order.OrderContent",
    "mantle.request.RequestContent",
    "mantle.humanres.employment.EmploymentContent",
    "mantle.humanres.employment.EmploymentApplicationContent",
    "mantle.humanres.ability.PartyQualificationContent",
    "mantle.humanres.ability.PerformanceReviewContent",
    "mantle.humanres.payroll.PayslipContent",
    "mantle.product.feature.ProductFeature",
    "mantle.product.feature.ProductFeatureGroup",
    "mantle.product.ProductIdentifierPolicy",
    "mantle.product.ProductOtherIdentification",
    "mantle.product.ProductCatalogOperation",
    "mantle.product.ProductContent",
    "mantle.product.category.ProductCategoryContent",
    "mantle.product.ContentEditConflict",
    "mantle.product.receipt.AssetReceipt",
    "mantle.product.issuance.AssetIssuance",
    "mantle.product.asset.AssetDetail",
    "mantle.product.asset.AssetBookEvent",
    "mantle.product.asset.AssetRevaluationPreview",
    "mantle.ledger.transaction.PostingOperation",
    "mantle.product.cost.ProductStandardCost",
    "mantle.product.cost.ProductStandardCostComponent",
    "mantle.product.cost.ProductCostCalculation",
    "mantle.product.bom.ProductBomItem",
    "mantle.product.bom.ProductBomContent",
    "mantle.work.method.MethodReleaseDecision",
    "mantle.work.production.WorkCenter",
    "mantle.work.production.WorkCenterRate"
])
const ruled = row => !!row.visibleService || !!(row.parentEntityName && row.parentField) || !!row.organizationField
// Whether a registration's codeRule stands: Y on a type of the fixed list only.
const codeRuleHolds = row => row.codeRule === "Y" && codeRuled.has(String(row.recordEntityName))
// What is wrong with a registration as loaded (the RecordLinkTypeRuleless EECA logs it), or null.
function problemOf(row) {
    if (row.disabled === "Y") return null
    if (row.codeRule === "Y" && !codeRuled.has(String(row.recordEntityName)))
        return "claims codeRule, but get#RecordLinkInfo has no rule of its own for it; only a system administrator sees its records until it names its rule"
    if (ruled(row) || codeRuleHolds(row) || row.publicRead === "Y") return null
    return "has no visibility rule: only a system administrator sees its records until it names visibleService, parentEntityName and parentField, or organizationField, or says publicRead"
}
;({codeRuled, codeRuleHolds, problemOf})
