/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The PASS apps a public site may mount (PublicSiteApp.app), the one list the authority keeps. An app with a target is
 * bound to a record of its own type (PublicSiteApp.targetId), which only an operator sets, since the app's pages read
 * that record's business data; its readiness service adds the app's checks to the site's. A new app registers here, in
 * PASS's Apps.js and the PASS runtime's <public-site> mounts (mr-pass docs/Deployment.md).
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
}
/* Whether a target id names a record of the target type. */
const targets = {
    organization: (targetId) =>
        !!ec.entity
            .find('mantle.party.PartyRole')
            .condition({ partyId: targetId, roleTypeId: 'OrgInternal' })
            .disableAuthz()
            .one(),
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
;({ apps, targets, mount, pageUrl, sitesFor })
