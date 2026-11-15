// The BOSS demo's Utah nexus of Ziziwork Retail (impl-marketing follow-up 1, the user's call) taxes the ZIZI_RETAIL store's orders and
// Retail's storeless ones in Utah, and its LOCAL tax gateway on ORG_ZIZI_CORP (Marketing P17 review), inherited by Retail, retaxes a
// Retail storeless order at each line change. Mantle's own flows over that store and seller keep the figures they were written with,
// as Mantle stands without BOSS: each suspends Retail's nexus (and, asked, the inherited gateway) for its run and puts them back after.
// With neither (Mantle alone) both do nothing. CC0 1.0 Universal plus Grant of Patent License.
const ENTITY = "mantle.other.tax.TaxAuthorityParty"
function withAuthzOff(work) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
const PREFERENCE = "mantle.ledger.config.PartyAcctgPreference"
const update = (entityName, values) =>
    ec.service
        .sync()
        .name("update#" + entityName)
        .parameters(values)
        .call()
// Retail's nexus rows turned off and, with gateway, the LOCAL gateway named on ORG_ZIZI_CORP's preference taken off; answers what
// was changed, for restore.
function suspend(options = {}) {
    return withAuthzOff(() => {
        const nexus = Array.from(ec.entity.find(ENTITY).condition({partyId: "ORG_ZIZI_RETAIL", isNexus: "Y"}).list()).map(
            row => ({
                taxAuthorityId: row.taxAuthorityId,
                partyId: row.partyId,
                fromDate: row.fromDate
            })
        )
        for (const key of nexus) update(ENTITY, Object.assign({isNexus: "N"}, key))
        const corp = options.gateway ? ec.entity.find(PREFERENCE).condition({organizationPartyId: "ORG_ZIZI_CORP"}).one() : null
        const gateway = corp?.taxGatewayConfigId || null
        if (gateway) update(PREFERENCE, {organizationPartyId: "ORG_ZIZI_CORP", taxGatewayConfigId: null})
        return {nexus, gateway}
    })
}
function restore(suspended) {
    withAuthzOff(() => {
        for (const key of suspended?.nexus || []) update(ENTITY, Object.assign({isNexus: "Y"}, key))
        if (suspended?.gateway) update(PREFERENCE, {organizationPartyId: "ORG_ZIZI_CORP", taxGatewayConfigId: suspended.gateway})
    })
}
;({suspend, restore})
