/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The PASS apps a public site may mount (PublicSiteApp.app), the one list the authority keeps. An app with a target is
 * bound to a record of its own type (PublicSiteApp.targetId), which only an operator sets, since the app's pages read
 * that record's business data; its readiness service adds the app's checks to the site's. A new app registers here, in
 * PASS's Apps.js and the PASS runtime's <public-site> mounts (mr-pass docs/Deployment.md). root: the app may mount at
 * '/', a site's one root app; onePerSite: a site has at most one mount of it.
 */
const apps = {
    forum: { root: true },
    account: {},
    members: {},
    sites: {},
    billing: {
        target: 'organization',
        readiness: 'mantle.account.PortalServices.check#AppReadiness',
    },
    supplier: {
        target: 'organization',
        readiness: 'mantle.account.PortalServices.check#AppReadiness',
    },
    // Customer Service's Support app (impl-customer-service P13, F56): its target the service organization
    support: {
        target: 'organization',
        readiness: 'mantle.request.CaseFeedbackServices.check#SupportAppReadiness',
    },
    // Shop (mr-pass impl-shop P1, F2, F34): its target the ProductStore it sells from; it may be a site's one root app in
    // place of Forum; a site has one Shop mount; its readiness is Commerce's store readiness (read only)
    shop: {
        target: 'productStore',
        root: true,
        onePerSite: true,
        readiness: 'mantle.product.StoreAdminServices.check#StoreReadiness',
    },
}
/* The first path segments no app mount, site page route or redirect may take: the BOSS apps, REST and RPC, the framework's
 * routes (public_site.rs FRAMEWORK_ROUTES, so a root app never shadows them; Shop P1, F2) and its sign-in, token and
 * asset paths. Forum.js storeMounts checks mounts against it, SitePages.js redirects and navigation paths. */
const reservedPaths = [
    'apps',
    'qapps',
    'rest',
    'rpc',
    'status',
    'error',
    'health',
    'metrics',
    'fop',
    'js',
    'css',
    'libs',
    'images',
    // the framework's routes (public_site.rs FRAMEWORK_ROUTES), so a root app never shadows them (Shop P1, F2)
    'static',
    'assets',
    'Login',
    'SecondFactor',
    'PasswordReset',
    'sso',
    'notws',
    'termws',
    'PublicShell',
    's',
    'u',
    'cal',
    'r',
    'sw.js',
    'manifest.webmanifest',
    'WebPush',
]
/* Whether a target id names a record of the target type. */
const targets = {
    organization: (targetId) =>
        !!ec.entity
            .find('mantle.party.PartyRole')
            .condition({ partyId: targetId, roleTypeId: 'OrgInternal' })
            .disableAuthz()
            .one(),
    // a real store whose organization is internal (Shop)
    productStore: (targetId) => {
        const store = ec.entity
            .find('mantle.product.store.ProductStore')
            .condition({ productStoreId: targetId })
            .disableAuthz()
            .one()
        return !!store?.organizationPartyId && targets.organization(store.organizationPartyId)
    },
}
/* The enabled mount of an app on a site, with its base path ('' for '/'), or null. */
function mount(siteId, app) {
    const m = ec.entity
        .find('mantle.public.PublicSiteApp')
        .condition({ siteId, app, enabled: 'Y' })
        .disableAuthz()
        .list()[0]
    return m
        ? {
              app,
              pathPrefix: m.pathPrefix,
              base: m.pathPrefix === '/' ? '' : m.pathPrefix,
              targetId: m.targetId || null,
          }
        : null
}
/* The absolute address of an app's page on a site: its canonical host and the app's mount; null when either is missing. */
function pageUrl(siteId, app, path) {
    const host = ec.entity
        .find('mantle.public.PublicSiteHost')
        .condition({ siteId, canonical: 'Y' })
        .disableAuthz()
        .one()
    const m = mount(siteId, app)
    if (!host || !m) return null
    return 'https://' + host.hostname + m.base + path
}
/* The published sites with a canonical host whose enabled mount of an app targets a record, first by site id: the sites
 * a link to the record can be built on. */
function sitesFor(app, targetId) {
    return Array.from(
        ec.entity
            .find('mantle.public.PublicSiteApp')
            .condition({ app, targetId, enabled: 'Y' })
            .orderBy('siteId')
            .disableAuthz()
            .list(),
    )
        .map((m) => m.siteId)
        .filter(
            (siteId) =>
                ec.entity
                    .find('mantle.public.PublicSite')
                    .condition({ siteId, state: 'published' })
                    .disableAuthz()
                    .count() > 0 &&
                ec.entity
                    .find('mantle.public.PublicSiteHost')
                    .condition({ siteId, canonical: 'Y' })
                    .disableAuthz()
                    .count() > 0,
        )
}
;({ apps, targets, mount, pageUrl, sitesFor, reservedPaths })
