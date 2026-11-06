/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The Shop app's trusted context (mr-pass impl-shop P1; design-shop §1, §4.1, §13.1): the published site, its one enabled
 * `shop` mount (PublicSiteApp) and the ProductStore an operator set as the mount's target, which every Shop service reads
 * from the site the facade resolved and never from the browser. A site that is not published, a disabled or missing mount
 * and a store that is gone or no longer an internal organization's are all "not available" (NOT_AVAILABLE, NotFound), so a
 * visitor cannot tell them apart. Reads are the authority's own (authorization disabled); nothing here writes.
 */
const S = "mantle.public."
const one = (entity, fields) => ec.entity.find(entity).condition(fields).disableAuthz().one()
function notAvailable() {
    const e = new Error("NOT_AVAILABLE: This store is not available")
    e.moquiErrorKind = "NotFound"
    throw e
}
/* The published site, its Shop mount and its store: {site, mount, store}, or NOT_AVAILABLE. */
function shopOf(siteId) {
    const site = siteId ? one(S + "PublicSite", {siteId}) : null
    if (!site || site.state !== "published") notAvailable()
    const mount = ec.entity
        .find(S + "PublicSiteApp")
        .condition({siteId, app: "shop", enabled: "Y"})
        .disableAuthz()
        .list()[0]
    if (!mount?.targetId) notAvailable()
    const registry = ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    if (!registry.targets.productStore(mount.targetId)) notAvailable()
    const store = one("mantle.product.store.ProductStore", {productStoreId: mount.targetId})
    return {site, mount, store}
}
/* getShopContext: the site, mount, store, locale, currency, active theme release and capabilities a Shop page needs. The
 * active release is the mount's PublicThemeBinding (P2: {releaseId, manifestDigest, engine, viewApiVersion}, null when
 * none is published); purchase opens with P4 and P5. */
function getShopContext(p) {
    const {site, mount, store} = shopOf(p.siteId)
    return {
        site: {
            siteId: site.siteId,
            name: site.name,
            locale: site.locale || "en",
            timeZone: site.timeZone || "UTC",
            generation: Number(site.generation || 0)
        },
        mount: {pathPrefix: mount.pathPrefix, base: mount.pathPrefix === "/" ? "" : mount.pathPrefix},
        store: {productStoreId: store.productStoreId, name: store.storeName || store.productStoreId},
        locale: store.defaultLocale || site.locale || "en",
        currency: store.defaultCurrencyUomId || null,
        release: (() => {
            const active = ec.resource
                .script("component://mr-mantle/service/mantle/public/Themes.js")
                .activeRelease(site.siteId, mount.appMountId)
            return active
                ? {
                      releaseId: active.releaseId,
                      manifestDigest: active.manifestDigest,
                      engine: active.engine,
                      viewApiVersion: active.viewApiVersion
                  }
                : null
        })(),
        // P4: a cart (canUseCart); purchase opens with P5's checkout
        capabilities: {canBrowse: true, canUseCart: true, canPurchase: false, signedIn: !!ec.user.userId}
    }
}
;({shopOf, getShopContext, execute: (op, p) => ({getShopContext})[op](p || {})})
