// The BOSS demo's Utah nexus of Ziziwork Retail (impl-marketing follow-up 1, the user's call) taxes the POPC_DEFAULT and ZIZI_RETAIL
// stores' orders and Retail's storeless ones in Utah. Mantle's classic chain over that store and seller (OrderProcureToPayBasicFlow's
// stock and ledger, OrderToCashBasicFlow, ReturnToResponseBasicFlow) keeps the figures it was written with, as Mantle stands without
// BOSS: each of the two sales flows suspends Retail's nexus for its run and puts it back in cleanupSpec (which runs even when
// setupSpec or a feature fails; a run's specs share one database serially, each worker its own copy). OrderBulk and PayTraceGateway
// sell as spec-local organizations instead (follow-up 1 review, the user's call); moving this chain to a Mantle-owned seller is
// left (its store, warehouse stock, ledger and four dependent specs). With no such nexus (Mantle alone) both do nothing.
// CC0 1.0 Universal plus Grant of Patent License.
const ENTITY = "mantle.other.tax.TaxAuthorityParty"
function withAuthzOff(work) {
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
}
const update = values =>
    ec.service
        .sync()
        .name("update#" + ENTITY)
        .parameters(values)
        .call()
// Retail's nexus rows turned off; answers what was changed, for restore.
function suspend() {
    return withAuthzOff(() => {
        const nexus = Array.from(ec.entity.find(ENTITY).condition({partyId: "ORG_ZIZI_RETAIL", isNexus: "Y"}).list()).map(
            row => ({taxAuthorityId: row.taxAuthorityId, partyId: row.partyId, fromDate: row.fromDate})
        )
        for (const key of nexus) update(Object.assign({isNexus: "N"}, key))
        return {nexus}
    })
}
function restore(suspended) {
    withAuthzOff(() => {
        for (const key of suspended?.nexus || []) update(Object.assign({isNexus: "Y"}, key))
    })
}
;({suspend, restore})
