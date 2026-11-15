// A campaign's store promotions (impl-marketing P19; design-marketing §7, crosscut §3.28; mantle.marketing.CampaignServices
// store#CampaignAssociation and find#CampaignAssociations): a campaign editor who also holds Commerce's promotion permission links and
// ends a store promotion of the campaign's organization; an editor without it, with the same parameters, is refused and sees the link
// read only; another organization's promotion answers as a missing one; the links of a promotion leave out another organization's
// campaigns.
// Standalone: spec-local organizations, stores, promotions and users, made as the system.
// Run: ./moq test mr-mantle --spec CampaignPromotions
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, system, organization, user, as, campaign, C} = lib
const prefix = "MKCP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const users = {}
const ids = {}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.refusal || "") || [])[1] || (out.refusal ? "ERROR" : "")

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Promotions A")
            organization(orgB, "Promotions B")
            const author = ["MARKETING_VIEW", "MARKETING_CAMPAIGN_EDIT"]
            users.linker = user(prefix, "linker", [orgA], author.concat(["COMMERCE_VIEW", "COMMERCE_PROMOTION_EDIT"]))
            users.author = user(prefix, "author", [orgA], author.concat(["COMMERCE_VIEW"]))
            users.other = user(prefix, "other", [orgB], author.concat(["COMMERCE_VIEW", "COMMERCE_PROMOTION_EDIT"]))
            for (const [org, suffix] of [
                [orgA, "A"],
                [orgB, "B"]
            ]) {
                make("mantle.product.store.ProductStore", {
                    productStoreId: prefix + "_STORE_" + suffix,
                    organizationPartyId: org,
                    storeName: "Store " + suffix
                })
                make("mantle.product.store.ProductStorePromotion", {
                    storePromotionId: prefix + "_PROMO_" + suffix,
                    productStoreId: prefix + "_STORE_" + suffix,
                    itemDescription: "Spring sale " + suffix,
                    serviceRegisterId: "FlatDiscount"
                })
            }
        })
        ids.campaignA = campaign(users.linker, orgA, {campaignName: "Spring A"})
        ids.campaignB = campaign(users.other, orgB, {campaignName: "Spring B"})
    }
})

feature(
    "a promotion is linked and ended by an editor with Commerce's promotion permission; one without it is refused and reads it only",
    {
        when() {
            const link = {
                marketingCampaignId: ids.campaignA,
                associationKindEnumId: "CakPromotion",
                sourceId: prefix + "_PROMO_A"
            }
            const refused = as(users.author, C + "store#CampaignAssociation", link)
            const linked = as(users.linker, C + "store#CampaignAssociation", link)
            const foreign = as(
                users.linker,
                C + "store#CampaignAssociation",
                Object.assign({}, link, {sourceId: prefix + "_PROMO_B"})
            )
            // the other organization links the same promotion id to its own campaign: refused as missing
            const crossed = as(
                users.other,
                C + "store#CampaignAssociation",
                Object.assign({}, link, {marketingCampaignId: ids.campaignB})
            )
            const lookup = {associationKindEnumId: "CakPromotion", sourceId: prefix + "_PROMO_A"}
            const linkerView = as(users.linker, C + "find#CampaignAssociations", lookup)
            const authorView = as(users.author, C + "find#CampaignAssociations", lookup)
            const otherView = as(users.other, C + "find#CampaignAssociations", lookup)
            const end = {marketingCampaignId: ids.campaignA, action: "end", campaignAssociationId: linked.campaignAssociationId}
            const authorEnd = as(users.author, C + "store#CampaignAssociation", end)
            const linkerEnd = as(users.linker, C + "store#CampaignAssociation", end)
            const after = as(users.linker, C + "find#CampaignAssociations", lookup)
            return {refused, linked, foreign, crossed, linkerView, authorView, otherView, authorEnd, linkerEnd, after}
        },
        then(r) {
            code(r.refused) == "PERMISSION_DENIED"
            r.linked.refusal == "" && !!r.linked.campaignAssociationId
            code(r.foreign) == "RECORD_UNAVAILABLE"
            code(r.crossed) == "RECORD_UNAVAILABLE"
            r.linkerView.refusal == ""
            r.linkerView.links.map(row => row.campaignName + ":" + row.canEnd) == ["Spring A:true"]
            r.linkerView.canLink == true
            r.authorView.links.map(row => row.campaignName + ":" + row.canEnd) == ["Spring A:false"]
            r.authorView.canLink == false
            r.otherView.links == []
            code(r.authorEnd) == "PERMISSION_DENIED"
            r.linkerEnd.refusal == ""
            r.after.links == []
        }
    }
)
