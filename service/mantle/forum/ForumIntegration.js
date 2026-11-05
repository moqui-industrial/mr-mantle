/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Forum integrations: source-bound access grants, the subscription resource handlers that keep them in step with
 * the subscription lifecycle, and their staff and member views. Forum.js calls this with the shared core and its
 * methods map.
 */
;(core, methods) => {
    const {
        F,
        S,
        E,
        now,
        millis,
        id,
        find,
        one,
        rows,
        create,
        update,
        pick,
        fail,
        missing,
        invalid,
        me,
        isOperator,
        site,
        revision,
        bump,
        staff,
        page,
        receipt,
        audit,
        systemAudit,
        grantActive,
        hash,
        topic,
        internalParty,
        articleReadable,
        plainText,
    } = core
    const SUB = 'mantle.product.subscription.'
    const HANDLERS = {
        initServiceName: 'mantle.forum.EntitlementServices.init#ForumAccess',
        renewServiceName: 'mantle.forum.EntitlementServices.renew#ForumAccess',
        revokeAccessServiceName:
            'mantle.forum.EntitlementServices.revoke#ForumAccess',
        restoreAccessServiceName:
            'mantle.forum.EntitlementServices.restore#ForumAccess',
        destroyServiceName:
            'mantle.forum.EntitlementServices.destroy#ForumAccess',
    }
    /* The scope a grant or binding names: the whole site, one of its categories, or an article. */
    function grantTarget(siteId, targetType, contactListId, wikiPageId) {
        if (targetType === 'site') return { targetType, targetId: siteId }
        if (targetType === 'article') {
            if (
                !wikiPageId ||
                !one('moqui.resource.wiki.WikiPage', { wikiPageId })
            )
                missing()
            return { targetType, targetId: wikiPageId }
        }
        if (targetType !== 'category' || !contactListId)
            invalid('Choose the site or one of its categories')
        const c = one(F + 'ForumCategory', { contactListId })
        if (!c || c.siteId !== siteId) missing()
        return { targetType, targetId: contactListId }
    }
    const scopeList = (target) =>
        target.targetType === 'category' ? target.targetId : null
    function partyByHandle(siteId, handle) {
        const profile = handle
            ? one(S + 'PublicSiteProfile', { siteId, handle })
            : null
        if (!profile) missing()
        return profile.partyId
    }
    /* Staff see the source kind and period, never the subscription or order behind it. */
    const grantProjection = (g) => ({
        ...pick(
            g,
            'grantId targetType targetId sourceType fromDate thruDate revokedAt reason revision',
        ),
        active: grantActive(g),
        handle:
            one(S + 'PublicSiteProfile', {
                siteId: g.siteId,
                partyId: g.partyId,
            })?.handle ?? null,
    })
    methods.setAccessGrant = (p) =>
        receipt(p, 'setAccessGrant', () => {
            site(p.siteId)
            const target = grantTarget(
                p.siteId,
                p.targetType,
                p.contactListId,
                p.wikiPageId,
            )
            staff(p.siteId, scopeList(target))
            if (!p.reason) invalid('A reason is required')
            if (p.thruDate != null && millis(p.thruDate) <= millis(now()))
                invalid('The grant must end in the future')
            const partyId = partyByHandle(p.siteId, p.handle)
            if (partyId === me())
                invalid('Staff cannot grant themselves access')
            const key = {
                partyId,
                siteId: p.siteId,
                ...target,
                sourceType: 'manual',
                sourceId: 'manual',
            }
            const old = one(S + 'PublicAccessGrant', key, true),
                before = old ? Number(old.revision || 1) : null
            const fields = {
                fromDate: p.fromDate ?? now(),
                thruDate: p.thruDate ?? null,
                revokedAt: null,
                reason: p.reason,
                grantedByPartyId: me(),
                revision: (before || 0) + 1,
            }
            const g = old
                ? update(old, fields)
                : create(S + 'PublicAccessGrant', {
                      grantId: id(),
                      createdAt: now(),
                      ...key,
                      ...fields,
                  })
            audit(
                p.siteId,
                scopeList(target),
                'grant',
                g.grantId,
                'grant',
                p.reason,
                before,
                fields.revision,
            )
            bump(p.siteId)
            return { grantId: g.grantId, revision: fields.revision }
        })
    methods.endAccessGrant = (p) => {
        site(p.siteId)
        const g = one(
            S + 'PublicAccessGrant',
            { siteId: p.siteId, grantId: p.grantId },
            true,
        )
        if (!g) missing()
        staff(p.siteId, g.targetType === 'category' ? g.targetId : null)
        if ((g.sourceType || 'manual') !== 'manual')
            fail(
                'Conflict',
                'A subscription grant follows its subscription and cannot be ended here',
            )
        revision({ revision: Number(g.revision || 1) }, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        const next = Number(g.revision || 1) + 1
        update(g, { thruDate: now(), revision: next })
        audit(
            p.siteId,
            g.targetType === 'category' ? g.targetId : null,
            'grant',
            g.grantId,
            'end-grant',
            p.reason,
            next - 1,
            next,
        )
        bump(p.siteId)
        return { revision: next }
    }
    methods.findAccessGrants = (p) => {
        site(p.siteId)
        staff(p.siteId, p.contactListId)
        const fields = { siteId: p.siteId }
        if (p.contactListId) {
            fields.targetType = 'category'
            fields.targetId = p.contactListId
        }
        if (p.handle) fields.partyId = partyByHandle(p.siteId, p.handle)
        const pg = page(
                p,
                'grants:' +
                    p.siteId +
                    ':' +
                    (p.contactListId || '') +
                    ':' +
                    (p.handle || ''),
            ),
            list = Array.from(
                find(S + 'PublicAccessGrant', fields)
                    .orderBy('-createdAt,grantId')
                    .offset(pg.offset)
                    .limit(pg.limit + 1)
                    .list(),
            )
        return {
            grantList: list.slice(0, pg.limit).map(grantProjection),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    }
    /* Binding a subscription resource sets its lifecycle services, so only an operator changes it, and a bound
       resource keeps its scope: existing subscribers' grants were written for that scope. */
    methods.storeSubscriptionBinding = (p) => {
        site(p.siteId, true)
        if (!isOperator())
            fail('Unauthorized', 'An operator binds subscription resources')
        const resource = one(
            SUB + 'SubscriptionResource',
            { subscriptionResourceId: p.subscriptionResourceId },
            true,
        )
        if (!resource) missing()
        const target = grantTarget(
            p.siteId,
            p.targetType,
            p.contactListId,
            p.wikiPageId,
        )
        for (const [field, name] of Object.entries(HANDLERS))
            if (resource[field] && resource[field] !== name)
                fail(
                    'Conflict',
                    'This subscription resource already has other access services',
                )
        const old = one(S + 'PublicSubscriptionBinding', {
            subscriptionResourceId: p.subscriptionResourceId,
        })
        if (
            old &&
            (old.siteId !== p.siteId ||
                old.targetType !== target.targetType ||
                old.targetId !== target.targetId)
        )
            fail('Conflict', 'A bound subscription resource keeps its scope')
        if (!old)
            create(S + 'PublicSubscriptionBinding', {
                subscriptionResourceId: p.subscriptionResourceId,
                siteId: p.siteId,
                ...target,
                createdAt: now(),
                revision: 1,
            })
        update(resource, HANDLERS)
        audit(
            p.siteId,
            scopeList(target),
            'subscription-resource',
            p.subscriptionResourceId,
            'bind-subscription',
            p.reason || 'Subscription resource bound',
            null,
            1,
        )
        return { subscriptionResourceId: p.subscriptionResourceId }
    }
    methods.findSubscriptionBindings = (p) => {
        site(p.siteId, true)
        return {
            bindingList: rows(S + 'PublicSubscriptionBinding', {
                siteId: p.siteId,
            }).map((b) => ({
                ...pick(
                    b,
                    'subscriptionResourceId targetType targetId createdAt',
                ),
                description:
                    one(SUB + 'SubscriptionResource', {
                        subscriptionResourceId: b.subscriptionResourceId,
                    })?.description || '',
            })),
        }
    }
    /* The member's own grants on a site, for the memberships view. */
    function memberEntitlements(siteId, partyId) {
        if (!partyId) return []
        return Array.from(
            find(S + 'PublicAccessGrant', { siteId, partyId })
                .orderBy('-thruDate,grantId')
                .limit(50)
                .list(),
        ).map((g) => ({
            ...pick(g, 'targetType targetId sourceType fromDate thruDate'),
            active: grantActive(g),
            name:
                g.targetType === 'category'
                    ? one('mantle.marketing.contact.ContactList', {
                          contactListId: g.targetId,
                      })?.contactListName || ''
                    : one(S + 'PublicSite', { siteId })?.name || '',
        }))
    }
    /* The subscription resource handlers (EntitlementServices.xml). Each subscription period has its own grant, so
       renewal adds the next period and revoking one never touches a manual grant or another period. A replayed
       init or renew updates the same row and leaves a revocation in place; only restore lifts it. A resource with
       these handlers but no binding is logged and skipped, so order fulfillment does not fail. */
    function applySubscription(action, subscriptionId) {
        const was = ec.artifactExecution.disableAuthz()
        try {
            const sub = one(SUB + 'Subscription', { subscriptionId })
            if (!sub) missing()
            const binding = one(S + 'PublicSubscriptionBinding', {
                subscriptionResourceId: sub.subscriptionResourceId,
            })
            if (!binding) {
                ec.logger.error(
                    'Forum access handler ' +
                        action +
                        ' found no site binding for subscription ' +
                        subscriptionId,
                )
                return
            }
            const key = {
                partyId: sub.subscriberPartyId,
                siteId: binding.siteId,
                targetType: binding.targetType,
                targetId: binding.targetId,
                sourceType: 'subscription',
                sourceId: subscriptionId,
            }
            const old = one(S + 'PublicAccessGrant', key, true)
            let g = old
            if (['init', 'renew', 'restore'].includes(action)) {
                const fields = {
                    fromDate: sub.fromDate,
                    thruDate: sub.thruDate,
                    ...(action === 'restore' ? { revokedAt: null } : {}),
                    revision: Number(old?.revision || 0) + 1,
                }
                g = old
                    ? update(old, fields)
                    : create(S + 'PublicAccessGrant', {
                          grantId: id(),
                          createdAt: now(),
                          reason: 'Subscription',
                          ...key,
                          ...fields,
                      })
            } else if (old && !old.revokedAt)
                update(old, {
                    revokedAt: now(),
                    revision: Number(old.revision || 1) + 1,
                })
            if (!g) return
            systemAudit(
                binding.siteId,
                binding.targetType === 'category' ? binding.targetId : null,
                'grant',
                g.grantId,
                'subscription-' + action,
                'Subscription ' + action,
                null,
            )
            bump(binding.siteId)
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    /* ---- Support and discussion links (design §13.2-13.4) ---- */
    const activeLinks = (fields) =>
        rows(S + 'PublicDiscussionLink', { ...fields, detachedAt: null })
    /* A product is public on a site only while a store mounted on the site carries it within its sales dates. */
    function productPublic(siteId, productId) {
        const product = one('mantle.product.Product', { productId })
        if (!product) return false
        const t = millis(now())
        if (
            (product.salesIntroductionDate &&
                millis(product.salesIntroductionDate) > t) ||
            (product.salesDiscontinuationDate &&
                millis(product.salesDiscontinuationDate) <= t)
        )
            return false
        return rows(S + 'PublicSiteApp', { siteId, app: 'store' }).some(
            (mount) =>
                mount.enabled !== 'N' &&
                !!mount.targetId &&
                !!one('mantle.product.store.ProductStoreProduct', {
                    productStoreId: mount.targetId,
                    productId,
                }),
        )
    }
    /* Internal staff who moderate the topic: the only people who see or make case links. */
    const caseStaff = (a) => a.canModerate && internalParty(me())
    methods.getTopicLinks = (p) => {
        const { a } = topic(p.rootCommEventId, p.siteId)
        const staffView = caseStaff(a)
        const cards = []
        for (const link of activeLinks({
            siteId: p.siteId,
            rootCommEventId: p.rootCommEventId,
        })) {
            if (link.sourceType === 'product') {
                const published = productPublic(p.siteId, link.sourceId)
                if (!published && !a.canModerate) continue
                cards.push({
                    linkId: link.linkId,
                    sourceType: 'product',
                    sourceId: link.sourceId,
                    title:
                        one('mantle.product.Product', {
                            productId: link.sourceId,
                        })?.productName || '',
                    published,
                })
            } else if (
                link.sourceType === 'article' ||
                link.sourceType === 'article-source'
            ) {
                const page = one('moqui.resource.wiki.WikiPage', {
                    wikiPageId: link.sourceId,
                })
                const published = articleReadable(p.siteId, link.sourceId, me())
                if (!page || (!published && !a.canModerate)) continue
                cards.push({
                    linkId: link.linkId,
                    sourceType: 'article',
                    sourceId: link.sourceId,
                    title: page.pagePath || '',
                    published,
                })
            } else if (link.sourceType === 'case' && staffView) {
                const request = one('mantle.request.Request', {
                    requestId: link.sourceId,
                })
                if (request)
                    cards.push({
                        linkId: link.linkId,
                        sourceType: 'case',
                        sourceId: link.sourceId,
                        title: request.requestName || '',
                        statusId: request.statusId,
                    })
            }
        }
        const s = one(S + 'PublicSite', { siteId: p.siteId })
        return {
            linkList: cards,
            capabilities: {
                canCreateCase: staffView,
                canReplyFromCase: staffView && a.canReply,
                canLinkDiscussion: a.isOwner || isOperator(),
                canDraftArticle: staffView && !!s?.publishingWikiSpaceId,
            },
        }
    }
    /* The selected posts with author and post number: plain text for a private case comment, sanitized HTML for
       an article draft. */
    function selectedText(t, postIds, html) {
        if (!postIds?.length) invalid('Select at least one post')
        const parts = []
        for (const postId of postIds) {
            const st = one(F + 'ForumPostState', {
                communicationEventId: postId,
            })
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: postId,
            })
            if (
                !st ||
                !event ||
                st.rootCommEventId !== t.rootCommEventId ||
                st.visibility !== 'approved'
            )
                invalid('Only visible posts of this topic can be selected')
            const author =
                one(S + 'PublicSiteProfile', {
                    siteId: t.siteId,
                    partyId: event.fromPartyId,
                })?.handle || 'member'
            parts.push(
                html
                    ? '<blockquote><p>' +
                          author +
                          ' · post ' +
                          st.ordinal +
                          '</p>' +
                          StringUtilities.cleanHtml(event.body || '') +
                          '</blockquote>'
                    : author +
                          ' · post ' +
                          st.ordinal +
                          ':\n' +
                          plainText(event.body || ''),
            )
        }
        return parts.join(html ? '\n' : '\n\n')
    }
    /* A service call that turns message errors into a refusal naming the first error. */
    function serviceCall(name, input, kind = 'Conflict') {
        const out = ec.service.sync().name(name).parameters(input).call()
        if (ec.message.hasError()) {
            const message = ec.message.getErrorsString()
            ec.message.clearErrors()
            fail(kind, message.split('\n')[0])
        }
        return out
    }
    methods.createCaseFromTopic = (p) =>
        receipt(p, 'createCaseFromTopic', () => {
            const { t, event, a } = topic(p.rootCommEventId, p.siteId)
            if (!caseStaff(a))
                fail(
                    'Unauthorized',
                    'Internal staff who moderate this topic create cases',
                )
            if (!p.reason) invalid('A reason is required')
            const body = selectedText(t, p.postIds)
            // Customer Service's forum route (impl-customer-service P6, F12): the site and category's queue, type and
            // priority, a Submitted case on channel ScForum; with no route the request is as before.
            const routed = ec.resource
                .script(
                    'component://mr-mantle/service/mantle/request/Channels.js',
                )
                .forumIntake({
                    siteId: p.siteId,
                    forumContactListId: event.contactListId,
                    posterPartyId: event.fromPartyId,
                })
            const created = serviceCall(
                'mantle.request.RequestServices.create#Request',
                Object.assign(
                    {
                        requestTypeEnumId: 'RqtSupport',
                        requestName: String(
                            event.subject || 'Forum topic',
                        ).slice(0, 255),
                        description: p.reason,
                        requestCategoryId: p.requestCategoryId || null,
                        customerPartyId: event.fromPartyId,
                    },
                    routed.routed
                        ? {
                              requestTypeEnumId: routed.requestTypeEnumId,
                              requestCategoryId: routed.requestCategoryId,
                              priority: routed.priority,
                              statusId: routed.statusId,
                              salesChannelEnumId: routed.salesChannelEnumId,
                              customerPartyId:
                                  routed.customerPartyId || event.fromPartyId,
                          }
                        : {},
                ),
            )
            // The selected public posts become one private comment; nothing of the case returns to the forum.
            serviceCall('mantle.request.RequestServices.add#RequestComment', {
                requestId: created.requestId,
                subject: 'From forum topic ' + t.rootCommEventId,
                body,
            })
            create('mantle.request.RequestCommEvent', {
                requestId: created.requestId,
                communicationEventId: t.rootCommEventId,
            })
            const linkId = id()
            create(S + 'PublicDiscussionLink', {
                linkId,
                siteId: p.siteId,
                sourceType: 'case',
                sourceId: created.requestId,
                rootCommEventId: t.rootCommEventId,
                gate: 'none',
                createdByPartyId: me(),
                createdAt: now(),
                revision: 1,
            })
            audit(
                p.siteId,
                event.contactListId,
                'topic',
                t.rootCommEventId,
                'create-case',
                p.reason,
                null,
                null,
            )
            return { requestId: created.requestId, linkId }
        })
    /* A public reply from a case: the CSR's own posting rights, the exact sanitized body and audience, and a hash
       binding the publish to what the preview showed. */
    function caseReply(p) {
        const { t, event, a } = topic(p.rootCommEventId, p.siteId)
        if (!caseStaff(a) || !a.canReply)
            fail(
                'Unauthorized',
                'Internal staff with posting rights reply from a case',
            )
        if (
            !activeLinks({
                siteId: p.siteId,
                rootCommEventId: t.rootCommEventId,
                sourceType: 'case',
                sourceId: p.requestId,
            }).length
        )
            missing()
        // Exactly what publishing produces: sanitized, then the community's word rules.
        const ruled = core.applyRules(
            p.siteId,
            event.contactListId,
            StringUtilities.cleanHtml(p.body || ''),
        )
        if (ruled.block)
            invalid('This reply contains content the community does not allow')
        const body = ruled.body
        if (!body.trim()) invalid('The reply is empty')
        const c = one(F + 'ForumCategory', {
            contactListId: event.contactListId,
        })
        const list = one('mantle.marketing.contact.ContactList', {
            contactListId: event.contactListId,
        })
        return {
            body,
            audience:
                (list?.contactListName || 'Category') + ' · ' + c.visibility,
            previewHash: hash(
                [body, t.rootCommEventId, c.visibility, c.policyRevision].join(
                    '|',
                ),
            ),
        }
    }
    methods.previewCaseReply = (p) => caseReply(p)
    methods.publishCaseReply = (p) => {
        const r = caseReply(p)
        if (p.previewHash !== r.previewHash)
            fail(
                'Conflict',
                'The reply or its audience changed; preview it again',
            )
        const published = methods.publishPost({
            siteId: p.siteId,
            rootCommEventId: p.rootCommEventId,
            body: p.body,
            operationId: p.operationId,
        })
        // The public reply joins the case timeline; the case's private comments never join the topic.
        if (
            published.postId &&
            !one('mantle.request.RequestCommEvent', {
                requestId: p.requestId,
                communicationEventId: published.postId,
            })
        )
            create('mantle.request.RequestCommEvent', {
                requestId: p.requestId,
                communicationEventId: published.postId,
            })
        return published
    }
    methods.linkDiscussion = (p) =>
        receipt(p, 'linkDiscussion', () => {
            site(p.siteId, true)
            const { t, event } = topic(p.rootCommEventId, p.siteId)
            if (t.kind !== 'category') invalid('Link a category topic')
            if (!['product', 'article'].includes(p.sourceType))
                invalid('Link a product or an article')
            if (
                p.sourceType === 'product' &&
                !one('mantle.product.Product', { productId: p.sourceId })
            )
                missing()
            if (
                p.sourceType === 'article' &&
                !one('moqui.resource.wiki.WikiPage', { wikiPageId: p.sourceId })
            )
                missing()
            // An article's comments follow the article unless the owner links it without a gate.
            const bound =
                p.sourceType === 'article' &&
                !!one(S + 'PublicSubscriptionBinding', {
                    siteId: p.siteId,
                    targetType: 'article',
                    targetId: p.sourceId,
                })
            // An article's comments follow the article unless the owner links a free one without a gate.
            const gate =
                p.sourceType === 'article' && (p.gate !== 'none' || bound)
                    ? 'narrow'
                    : 'none'
            const c = one(F + 'ForumCategory', {
                contactListId: event.contactListId,
            })
            // A paid article's discussion must not show its title in a public listing.
            if (
                p.sourceType === 'article' &&
                c.visibility === 'public' &&
                one(S + 'PublicSubscriptionBinding', {
                    siteId: p.siteId,
                    targetType: 'article',
                    targetId: p.sourceId,
                })
            )
                fail(
                    'Conflict',
                    'Discuss a paid article in a restricted category',
                )
            const existing = activeLinks({
                siteId: p.siteId,
                sourceType: p.sourceType,
                sourceId: p.sourceId,
            })[0]
            if (existing) {
                if (existing.rootCommEventId !== t.rootCommEventId)
                    fail('Conflict', 'This source already has a discussion')
                return { linkId: existing.linkId }
            }
            const linkId = id()
            create(S + 'PublicDiscussionLink', {
                linkId,
                siteId: p.siteId,
                sourceType: p.sourceType,
                sourceId: p.sourceId,
                rootCommEventId: t.rootCommEventId,
                gate,
                createdByPartyId: me(),
                createdAt: now(),
                revision: 1,
            })
            if (
                p.sourceType === 'product' &&
                !one(E + 'CommunicationEventProduct', {
                    communicationEventId: t.rootCommEventId,
                    productId: p.sourceId,
                })
            )
                create(E + 'CommunicationEventProduct', {
                    communicationEventId: t.rootCommEventId,
                    productId: p.sourceId,
                })
            audit(
                p.siteId,
                event.contactListId,
                'topic',
                t.rootCommEventId,
                'link-' + p.sourceType,
                p.reason || 'Discussion linked',
                null,
                1,
            )
            bump(p.siteId)
            return { linkId }
        })
    methods.detachDiscussion = (p) => {
        site(p.siteId, true)
        const link = one(
            S + 'PublicDiscussionLink',
            { siteId: p.siteId, linkId: p.linkId },
            true,
        )
        if (!link || link.detachedAt) missing()
        if (p.confirmAudience !== true)
            invalid(
                'Detaching opens the discussion to its category audience: confirm the audience',
            )
        if (!p.reason) invalid('A reason is required')
        update(link, {
            detachedAt: now(),
            revision: Number(link.revision || 1) + 1,
        })
        audit(
            p.siteId,
            null,
            'topic',
            link.rootCommEventId,
            'detach-' + link.sourceType,
            p.reason,
            null,
            null,
        )
        bump(p.siteId)
        return { linkId: link.linkId }
    }
    /* An editorial draft in the site's publishing wiki space: the wiki checks the staff member's own space access,
       the page has no published version, and a named internal reviewer is asked to review it. */
    methods.draftArticleFromTopic = (p) =>
        receipt(p, 'draftArticleFromTopic', () => {
            const s = one(S + 'PublicSite', { siteId: p.siteId })
            const { t, event, a } = topic(p.rootCommEventId, p.siteId)
            if (!caseStaff(a))
                fail(
                    'Unauthorized',
                    'Internal staff who moderate this topic draft articles',
                )
            if (!s?.publishingWikiSpaceId)
                fail('Conflict', 'This site has no publishing space')
            const reviewer = p.reviewerUsername
                ? one('moqui.security.UserAccount', {
                      username: p.reviewerUsername,
                  })
                : null
            if (!reviewer || !internalParty(reviewer.partyId))
                invalid('Name an internal reviewer')
            const title = String(p.title || event.subject || 'Article')
                .replace(/[^\w.\-,':()!? ]+/g, ' ')
                .trim()
                .slice(0, 120)
            if (!title) invalid('A title is required')
            // A draft is a new page: a page of that title (perhaps a published article) is never overwritten.
            if (
                one('moqui.resource.wiki.WikiPage', {
                    wikiSpaceId: s.publishingWikiSpaceId,
                    pagePath: title,
                })
            )
                fail(
                    'Conflict',
                    'A page with that title already exists; choose another title',
                )
            const page = serviceCall(
                'org.moqui.impl.WikiServices.update#WikiPage',
                {
                    wikiSpaceId: s.publishingWikiSpaceId,
                    pageName: title,
                    wikiType: 'html',
                    pageText:
                        '<p>Drafted from a community discussion.</p>\n' +
                        selectedText(t, p.postIds, true),
                    versionNote: 'Draft from forum topic ' + t.rootCommEventId,
                },
                'Unauthorized',
            )
            serviceCall(
                'org.moqui.impl.WikiServices.request#WikiPageReview',
                {
                    wikiPageId: page.wikiPageId,
                    reviewerUserId: reviewer.userId,
                    note: p.reason || 'Article drafted from a forum discussion',
                },
                'Unauthorized',
            )
            const linkId = id()
            // The topic is the article's source, not its comment thread: a provenance link, no gate, and the article
            // can still get its own discussion.
            create(S + 'PublicDiscussionLink', {
                linkId,
                siteId: p.siteId,
                sourceType: 'article-source',
                sourceId: page.wikiPageId,
                rootCommEventId: t.rootCommEventId,
                gate: 'none',
                createdByPartyId: me(),
                createdAt: now(),
                revision: 1,
            })
            audit(
                p.siteId,
                event.contactListId,
                'topic',
                t.rootCommEventId,
                'draft-article',
                p.reason || 'Article drafted',
                null,
                null,
            )
            return { wikiPageId: page.wikiPageId, linkId }
        })
    /* Whether a party holds a current grant for the site, or for a category that qualifies its source, which lets them
       join a site whose registration is closed. */
    const hasSiteGrant = (siteId, partyId) =>
        !!partyId &&
        rows(S + 'PublicAccessGrant', { siteId, partyId }).some(
            (g) =>
                grantActive(g) &&
                (g.targetType === 'site' ||
                    (g.targetType === 'category' &&
                        String(
                            one(F + 'ForumCategory', {
                                contactListId: g.targetId,
                            })?.qualifyingSources || 'manual',
                        )
                            .split(',')
                            .includes(g.sourceType || 'manual'))),
        )
    return { applySubscription, memberEntitlements, hasSiteGrant }
}
