/* Item-isolated durable delivery. Workers are internal-only. CC0 plus patent grant. */
const F = 'mantle.forum.',
    S = 'mantle.public.',
    E = 'mantle.party.communication.'
const find = (n, p) => ec.entity.find(n).condition(p || {})
const one = (n, p) => find(n, p).one()
const write = (n, p) => {
    const v = ec.entity.makeValue(n)
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.create()
    return v
}
const set = (v, p) => {
    if (v.deliveryId) p = { ...p, revision: Number(v.revision || 0) + 1 }
    for (const [k, x] of Object.entries(p)) v.set(k, x)
    v.update()
}
const now = () => ec.user.nowTimestamp
const time = () => ec.user.timestampMillis(now())
const firstLine = (error) =>
    String(error?.message || error || '')
        .split('\n')[0]
        .slice(0, 200)
const policy = () =>
    ec.resource.script('component://mr-mantle/service/mantle/forum/Forum.js')
/* The effective preference of a member for a post: topic, then category, then site, for watch level and email mode
   separately. An opt-out suppression on a scope stops email there until the member chooses a mode again. */
function effective(siteId, partyId, scopes) {
    let watch = null,
        watchScope = null,
        email = null,
        emailScope = null,
        includeOwn = false
    for (const [scopeType, scopeId] of scopes) {
        if (!scopeId) continue
        const key = { siteId, partyId, scopeType, scopeId }
        const level = one(F + 'ForumPreference', key)?.watchLevel
        if (!watch && level) {
            watch = level
            watchScope = { scopeType, scopeId }
        }
        const pref = one(F + 'ForumDeliveryPreference', key)
        if (!email && pref) {
            email = pref.suppressed === 'Y' ? 'None' : pref.emailMode
            emailScope = { scopeType, scopeId }
            includeOwn = pref.includeOwn === 'Y'
        }
    }
    // A site-wide stop (an unsubscribe for the whole site or a hard bounce) wins over every narrower mode.
    if (
        one(F + 'ForumDeliveryPreference', {
            siteId,
            partyId,
            scopeType: 'site',
            scopeId: '_SITE_',
        })?.suppressed === 'Y'
    ) {
        email = 'None'
        emailScope = { scopeType: 'site', scopeId: '_SITE_' }
    }
    return {
        watch: watch || 'Normal',
        watchScope,
        email: email || 'Notifications',
        emailScope,
        includeOwn,
    }
}
const mentioned = (box, event) => {
    const handles = policy()
        .mentionHandles(event.body || '')
        .slice(0, 20)
    const out = new Set()
    for (const handle of handles) {
        const v = Array.from(
            find(S + 'PublicSiteProfile', { siteId: box.siteId })
                .condition('handle', 'equals', handle)
                .limit(1)
                .list(),
        )[0]
        if (v) out.add(v.partyId)
    }
    return out
}
/* Whether and how one member hears about one post, decided again at send time. The answer names the reason, whether
   an in-app notice is due, whether email is due, and the scope an opt-out link stops. */
function audience(box, partyId) {
    const membership = one(S + 'PublicSiteParty', {
        siteId: box.siteId,
        partyId,
    })
    if (
        !membership ||
        membership.state !== 'active' ||
        (membership.thruDate &&
            ec.user.timestampMillis(membership.thruDate) <= time())
    )
        return null
    const event = one(E + 'CommunicationEvent', {
            communicationEventId: box.communicationEventId,
        }),
        st = one(F + 'ForumPostState', {
            communicationEventId: box.communicationEventId,
        })
    if (!event || !st || st.visibility !== 'approved') return null
    const own = event.fromPartyId === partyId
    // A member who muted or blocked the author hears nothing of that author's posts.
    if (!own && policy().memberMutes(box.siteId, partyId, event.fromPartyId))
        return null
    const topicRow = one(F + 'ForumTopic', {
        rootCommEventId: st.rootCommEventId,
    })
    const isPrivate = topicRow?.kind === 'private'
    if (isPrivate) {
        if (!policy().conversationAccess(topicRow, partyId).canRead) return null
    } else {
        const a = policy().categoryAccess(event.contactListId, partyId)
        if (
            !a ||
            !(
                a.canRead ||
                (a.canReadOwn &&
                    (own ||
                        find(E + 'CommunicationEvent', {
                            rootCommEventId: st.rootCommEventId,
                            fromPartyId: partyId,
                        }).count() > 0))
            )
        )
            return null
        // A discussion gated by its source (a withdrawn article) sends nothing while the source is unreadable.
        if (!policy().sourceGate(st.rootCommEventId, partyId)) return null
        const rootState = one(F + 'ForumPostState', {
                communicationEventId: st.rootCommEventId,
            }),
            rootEvent = one(E + 'CommunicationEvent', {
                communicationEventId: st.rootCommEventId,
            })
        if (
            rootState?.visibility !== 'approved' &&
            rootEvent?.fromPartyId !== partyId &&
            !a.canModerate
        )
            return null
    }
    const pref = effective(
        box.siteId,
        partyId,
        isPrivate
            ? [
                  ['topic', st.rootCommEventId],
                  ['site', '_SITE_'],
              ]
            : [
                  ['topic', st.rootCommEventId],
                  ['category', event.contactListId],
                  ['site', '_SITE_'],
              ],
    )
    // Explicit Muted silences ordinary forum notices, mentions included.
    if (pref.watch === 'Muted') return null
    const isRoot = st.communicationEventId === st.rootCommEventId
    const parent = event.parentCommEventId
        ? one(E + 'CommunicationEvent', {
              communicationEventId: event.parentCommEventId,
          })
        : null
    const reason = own
        ? null
        : isPrivate
          ? 'private'
          : parent?.fromPartyId === partyId && !isRoot
            ? 'reply'
            : mentioned(box, event).has(partyId)
              ? 'mention'
              : pref.watch === 'Watching'
                ? 'watching'
                : pref.watch === 'WatchingFirstPost' &&
                    isRoot &&
                    pref.watchScope?.scopeType !== 'topic'
                  ? 'first-post'
                  : null
    // Mailing-list mode sends every visible post in its scope, and the member's own only when asked.
    const everyPost =
        pref.email === 'EveryPost' &&
        !isPrivate &&
        pref.emailScope?.scopeType !== 'topic' &&
        (!own || pref.includeOwn)
    if (!reason && !everyPost) return null
    const inApp = !!reason
    const email =
        (pref.email === 'Notifications' && inApp) ||
        (pref.email === 'EveryPost' && (everyPost || inApp))
    // An opt-out link stops the delivery that caused this mail: the mailing-list or watched scope, else the topic.
    const scope = everyPost
        ? pref.emailScope
        : pref.watch.startsWith('Watching') &&
            pref.watchScope &&
            pref.watchScope.scopeType !== 'site'
          ? pref.watchScope
          : { scopeType: 'topic', scopeId: st.rootCommEventId }
    return {
        event,
        st,
        private: isPrivate,
        reason: reason || 'every-post',
        inApp,
        email,
        everyPost,
        scope,
    }
}
/* Who can be notified at all: the parent post's author and mentioned members, then the topic, category and site
   watchers and mailing-list subscribers, each paged by party. Private conversations notify their participants only. */
function candidateSources(box) {
    const event = one(E + 'CommunicationEvent', {
            communicationEventId: box.communicationEventId,
        }),
        st = one(F + 'ForumPostState', {
            communicationEventId: box.communicationEventId,
        })
    if (!event || !st) return []
    if (
        one(F + 'ForumTopic', { rootCommEventId: st.rootCommEventId })?.kind ===
        'private'
    )
        return [
            (after, limit) =>
                Array.from(
                    find(F + 'ForumParticipant', {
                        rootCommEventId: st.rootCommEventId,
                        endedAt: null,
                    })
                        .condition('partyId', 'greater', after || '')
                        .orderBy('partyId')
                        .limit(limit)
                        .list(),
                ).map((row) => row.partyId),
        ]
    const parent = event.parentCommEventId
        ? one(E + 'CommunicationEvent', {
              communicationEventId: event.parentCommEventId,
          })
        : null
    const isRoot = st.communicationEventId === st.rootCommEventId
    const paged = (entity, fields) => (after, limit) =>
        Array.from(
            find(F + entity, { siteId: box.siteId, ...fields })
                .condition('partyId', 'greater', after || '')
                .orderBy('partyId')
                .limit(limit)
                .list(),
        ).map((row) => row.partyId)
    const watchers = (scopeType, scopeId, watchLevel) =>
        paged('ForumPreference', { scopeType, scopeId, watchLevel })
    const subscribers = (scopeType, scopeId) =>
        paged('ForumDeliveryPreference', {
            scopeType,
            scopeId,
            emailMode: 'EveryPost',
        })
    return [
        (after) =>
            after
                ? []
                : [
                      ...new Set([
                          ...(parent?.fromPartyId ? [parent.fromPartyId] : []),
                          ...mentioned(box, event),
                          // The author's own mailing-list copy, when asked for, is decided per member.
                          event.fromPartyId,
                      ]),
                  ].sort(),
        watchers('topic', st.rootCommEventId, 'Watching'),
        watchers('category', event.contactListId, 'Watching'),
        watchers('site', '_SITE_', 'Watching'),
        ...(isRoot
            ? [
                  watchers(
                      'category',
                      event.contactListId,
                      'WatchingFirstPost',
                  ),
                  watchers('site', '_SITE_', 'WatchingFirstPost'),
              ]
            : []),
        subscribers('category', event.contactListId),
        subscribers('site', '_SITE_'),
    ]
}
function prepare(p) {
    const box = find(F + 'ForumOutbox', { outboxId: p.outboxId })
        .forUpdate(true)
        .one()
    if (!box || box.state !== 'pending') return { done: true }
    const sources = candidateSources(box)
    let position = { source: 0, after: null }
    try {
        if (box.cursor) position = JSON.parse(box.cursor)
    } catch (e) {
        // A cursor from before candidate sources restarts; existing deliveries are not duplicated.
    }
    let examined = 0
    while (position.source < sources.length && examined < 100) {
        const want = 100 - examined
        const partyIds = sources[position.source](position.after, want)
        for (const partyId of partyIds) {
            examined++
            position.after = partyId
            const allowed = audience(box, partyId)
            if (!allowed) continue
            for (const channel of [
                ...(allowed.inApp ? ['in-app'] : []),
                ...(allowed.email ? ['email'] : []),
            ]) {
                if (
                    one(F + 'ForumDelivery', {
                        outboxId: box.outboxId,
                        partyId,
                        channel,
                    })
                )
                    continue
                write(F + 'ForumDelivery', {
                    deliveryId: ec.user.randomString(32),
                    siteId: box.siteId,
                    outboxId: box.outboxId,
                    partyId,
                    channel,
                    reason: allowed.reason,
                    state: 'pending',
                    attempts: 0,
                    revision: 1,
                    dueAt: now(),
                })
            }
        }
        // A source that returned less than asked for is exhausted.
        if (partyIds.length < want)
            position = { source: position.source + 1, after: null }
    }
    const done = position.source >= sources.length
    set(box, {
        cursor: JSON.stringify(position),
        state: done ? 'prepared' : 'pending',
    })
    return { prepared: examined, done }
}
function claim(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (
        !v ||
        !['pending', 'retry'].includes(v.state) ||
        ec.user.timestampMillis(v.dueAt) > time()
    )
        return { claimed: false }
    set(v, {
        state: 'sending',
        startedAt: now(),
        attempts: Number(v.attempts) + 1,
    })
    return { claimed: true }
}
function deliver(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (!v || v.state !== 'sending') return {}
    const box = one(F + 'ForumOutbox', { outboxId: v.outboxId })
    if (v.channel === 'digest') return deliverDigest(v, box)
    const allowed = box ? audience(box, v.partyId) : null
    if (
        !allowed ||
        (v.channel === 'in-app' && !allowed.inApp) ||
        (v.channel === 'email' && !allowed.email)
    ) {
        set(v, { state: 'suppressed' })
        return { state: 'suppressed' }
    }
    if (v.channel === 'in-app') {
        set(v, { state: 'sent' })
        return { state: 'sent' }
    }
    const event = allowed.event,
        st = allowed.st,
        // Replies thread under the earlier mail this member received for the topic and the parent post.
        sentId = (postId) => {
            for (const ob of Array.from(
                find(F + 'ForumOutbox', {
                    communicationEventId: postId,
                    eventType: 'post',
                })
                    .limit(5)
                    .list(),
            )) {
                const d = one(F + 'ForumDelivery', {
                    outboxId: ob.outboxId,
                    partyId: v.partyId,
                    channel: 'email',
                })
                if (d?.providerId) return d.providerId
            }
            return null
        },
        rootRef =
            st.communicationEventId !== st.rootCommEventId
                ? sentId(st.rootCommEventId)
                : null,
        parentRef =
            event.parentCommEventId &&
            event.parentCommEventId !== st.rootCommEventId
                ? sentId(event.parentCommEventId)
                : null
    return mail(v, allowed.scope, (urls) => ({
        // A scoped reply address, when the site routes mail: replying posts as this member in this thread.
        replyTo: policy().replyAddress(
            v.siteId,
            st.rootCommEventId,
            event.contactListId,
            v.partyId,
        ),
        inReplyTo: parentRef || rootRef,
        references: [rootRef, parentRef].filter(Boolean).join(' '),
        bodyParameters: {
            unsubscribeUrl: urls.unsubscribeUrl,
            postUrl:
                urls.origin +
                urls.forumBase +
                '/p/' +
                encodeURIComponent(st.communicationEventId),
            // Private conversation mail is a minimal notice: no subject or text leaves the site.
            title: allowed.private ? 'New private message' : event.subject,
            // Mailing-list mode carries the sanitized post; other notices link to it.
            body: allowed.everyPost
                ? StringUtilities.cleanHtml(event.body || '')
                : null,
            reason: allowed.reason,
            siteId: v.siteId,
            rootCommEventId: st.rootCommEventId,
            postId: st.communicationEventId,
        },
    }))
}
/* One email to the member of delivery v through the site's registered settings and verified address, with an opt-out
   token for scope. build(urls) supplies the template parameters and thread references. The provider outcome is kept:
   sent, retry with backoff, failed, or uncertain when acceptance is unknown. */
function mail(v, scope, build) {
    const settings = one(F + 'ForumMailSettings', { siteId: v.siteId }),
        ua = Array.from(
            find('moqui.security.UserAccount', { partyId: v.partyId })
                .orderBy('userId')
                .limit(100)
                .list(),
        ).find((u) => u.disabled !== 'Y')
    if (!settings || !ua?.emailAddress) {
        set(v, {
            state: 'failed',
            lastError: 'Mail settings or verified recipient are unavailable',
        })
        return { state: 'failed' }
    }
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    ) {
        set(v, { state: 'suppressed' })
        return { state: 'suppressed' }
    }
    const token = ec.user.randomString(64),
        host = one(S + 'PublicSiteHost', { siteId: v.siteId, canonical: 'Y' }),
        mountBase = (app) => {
            const m = one(S + 'PublicSiteApp', {
                siteId: v.siteId,
                app,
                enabled: 'Y',
            })
            return m ? (m.pathPrefix === '/' ? '' : m.pathPrefix) : null
        },
        accountBase = mountBase('account'),
        forumBase = mountBase('forum')
    if (!host || accountBase == null || forumBase == null) {
        set(v, {
            state: 'failed',
            lastError:
                'Canonical public host or account/forum mount is not configured',
        })
        return { state: 'failed' }
    }
    write(F + 'ForumOptOut', {
        tokenHash: ec.user.singleUseCodeHash(token),
        siteId: v.siteId,
        partyId: v.partyId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        expiresAt: time() + 365 * 86400000,
    })
    const origin = 'https://' + host.hostname,
        unsubscribeUrl =
            origin +
            accountBase +
            '/Unsubscribe?token=' +
            encodeURIComponent(token),
        oneClickUrl =
            origin +
            accountBase +
            '/Unsubscribe/oneClick?token=' +
            encodeURIComponent(token)
    const built = build({ origin, forumBase, unsubscribeUrl })
    const out = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.mail.EmailServices.send#EmailTemplate')
        .parameters({
            emailTemplateId: settings.templateId,
            toAddresses: ua.emailAddress,
            extraHeaders: {
                'List-Unsubscribe': '<' + oneClickUrl + '>',
                'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
                'List-Id': v.siteId + '.' + host.hostname,
            },
            ...(built.inReplyTo ? { inReplyTo: built.inReplyTo } : {}),
            ...(built.references ? { references: built.references } : {}),
            ...(built.replyTo ? { replyToAddresses: built.replyTo } : {}),
            bodyParameters: built.bodyParameters,
        })
        .call()
    // A provider result without confirmation is uncertain; never automatically resend an ambiguous send.
    const outcome = out.messageId
        ? 'sent'
        : out.deliveryOutcome === 'retryable'
          ? Number(v.attempts) >= 5
              ? 'failed'
              : 'retry'
          : out.deliveryOutcome === 'permanent'
            ? 'failed'
            : 'uncertain'
    set(v, {
        state: outcome,
        providerId: out.messageId || null,
        dueAt:
            outcome === 'retry'
                ? time() +
                  Math.min(3600, Math.pow(2, Number(v.attempts)) * 60) * 1000
                : v.dueAt,
        lastError: out.messageId
            ? null
            : outcome === 'uncertain'
              ? 'Provider acceptance is unknown'
              : 'Provider rejected delivery',
    })
    return { state: v.state }
}
/* ---- Digests ---- */
const slug = (title) =>
    String(title || 'topic')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'topic'
/* The topics a digest may name for this member now: readable, approved, not muted, still in a Digest scope. */
function digestTopics(siteId, partyId, rootIds) {
    const out = []
    for (const rootCommEventId of rootIds) {
        const t = one(F + 'ForumTopic', { rootCommEventId })
        if (!t || t.siteId !== siteId || t.kind !== 'category') continue
        if (t.unlisted === 'Y') continue
        const a = policy().categoryAccess(t.contactListId, partyId)
        if (!a?.canRead) continue
        if (!policy().sourceGate(rootCommEventId, partyId)) continue
        const rootState = one(F + 'ForumPostState', {
            communicationEventId: rootCommEventId,
        })
        if (rootState?.visibility !== 'approved') continue
        const pref = effective(siteId, partyId, [
            ['topic', rootCommEventId],
            ['category', t.contactListId],
            ['site', '_SITE_'],
        ])
        if (pref.watch === 'Muted' || pref.email !== 'Digest') continue
        const event = one(E + 'CommunicationEvent', {
            communicationEventId: rootCommEventId,
        })
        out.push({ rootCommEventId, title: event?.subject || '' })
    }
    return out
}
/* One member's due digest becomes a pending delivery naming recently active topics; the send rechecks each one. */
function prepareDigest(p) {
    const key = { siteId: p.siteId, partyId: p.partyId }
    const state =
        find(F + 'ForumDigestState', key)
            .forUpdate(true)
            .one() ||
        write(F + 'ForumDigestState', { ...key, lastSentAt: null })
    const membership = one(S + 'PublicSiteParty', key)
    if (!membership || membership.state !== 'active') return { prepared: false }
    const sitePref = one(F + 'ForumDeliveryPreference', {
        ...key,
        scopeType: 'site',
        scopeId: '_SITE_',
    })
    const period =
        (sitePref?.digestPeriod ||
            Array.from(
                find(F + 'ForumDeliveryPreference', {
                    ...key,
                    emailMode: 'Digest',
                })
                    .limit(1)
                    .list(),
            )[0]?.digestPeriod) === 'weekly'
            ? 7 * 86400000
            : 86400000
    const last = state.lastSentAt
        ? ec.user.timestampMillis(state.lastSentAt)
        : 0
    if (last && time() - last < period) return { prepared: false }
    const since = last || time() - period
    const recent = Array.from(
        find(F + 'ForumTopic', { siteId: p.siteId, kind: 'category' })
            .condition('lastActivity', 'greater', new Date(since))
            .orderBy('-lastActivity,rootCommEventId')
            .limit(200)
            .list(),
    ).map((t) => t.rootCommEventId)
    const topics = digestTopics(p.siteId, p.partyId, recent).slice(0, 20)
    set(state, { lastSentAt: now() })
    if (!topics.length) return { prepared: false }
    const outboxId = ec.user.randomString(32)
    write(F + 'ForumOutbox', {
        outboxId,
        siteId: p.siteId,
        communicationEventId: topics[0].rootCommEventId,
        eventType: 'digest',
        state: 'complete',
        cursor: JSON.stringify(topics.map((t) => t.rootCommEventId)),
        createdAt: now(),
    })
    write(F + 'ForumDelivery', {
        deliveryId: ec.user.randomString(32),
        siteId: p.siteId,
        outboxId,
        partyId: p.partyId,
        channel: 'digest',
        reason: 'digest',
        state: 'pending',
        attempts: 0,
        revision: 1,
        dueAt: now(),
    })
    set(state, { lastOutboxId: outboxId })
    return { prepared: true, topics: topics.length }
}
function deliverDigest(v, box) {
    let ids = []
    try {
        ids = JSON.parse(box?.cursor || '[]')
    } catch (e) {
        ids = []
    }
    const topics = digestTopics(v.siteId, v.partyId, ids)
    if (!topics.length) {
        set(v, { state: 'suppressed' })
        return { state: 'suppressed' }
    }
    return mail(v, { scopeType: 'site', scopeId: '_SITE_' }, (urls) => ({
        bodyParameters: {
            unsubscribeUrl: urls.unsubscribeUrl,
            postUrl: urls.origin + (urls.forumBase || '/'),
            title:
                'Your forum digest: ' +
                topics.length +
                (topics.length === 1 ? ' active topic' : ' active topics'),
            topics: topics.map((t) => ({
                title: t.title,
                url:
                    urls.origin +
                    urls.forumBase +
                    '/t/' +
                    encodeURIComponent(t.rootCommEventId) +
                    '/' +
                    slug(t.title),
            })),
            reason: 'digest',
            siteId: v.siteId,
        },
    }))
}
/* The digest job: every member with a Digest scope, each prepared in its own transaction. */
function digests() {
    let prepared = 0,
        failed = 0,
        after = { siteId: '', partyId: '' }
    const seen = new Set(),
        deadline = time() + 20000
    for (;;) {
        const cf = ec.entity.conditionFactory
        const batch = Array.from(
            find(F + 'ForumDeliveryPreference', { emailMode: 'Digest' })
                .condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition('siteId', 'greater', after.siteId),
                            cf.makeCondition(
                                [
                                    cf.makeCondition(
                                        'siteId',
                                        'equals',
                                        after.siteId,
                                    ),
                                    cf.makeCondition(
                                        'partyId',
                                        'greater',
                                        after.partyId,
                                    ),
                                ],
                                'and',
                            ),
                        ],
                        'or',
                    ),
                )
                .orderBy('siteId,partyId,scopeType,scopeId')
                .limit(200)
                .list(),
        )
        for (const row of batch) {
            const key = row.siteId + '|' + row.partyId
            if (seen.has(key)) continue
            seen.add(key)
            try {
                if (
                    ec.service
                        .sync()
                        .throwOnError(true)
                        .name(
                            'mantle.forum.DeliveryWorkerServices.prepare#Digest',
                        )
                        .parameters({
                            siteId: row.siteId,
                            partyId: row.partyId,
                        })
                        .requireNewTransaction(true)
                        .call().result.prepared
                )
                    prepared++
            } catch (e) {
                ec.message.clearErrors()
                failed++
                ec.logger.error(
                    'Forum digest for ' + key + ' failed: ' + firstLine(e),
                )
            }
        }
        if (batch.length < 200 || time() > deadline) break
        const last = batch[batch.length - 1]
        // The next page starts after the last member seen; a member's remaining scope rows are skipped by key.
        after = { siteId: last.siteId, partyId: last.partyId }
    }
    return { prepared, failed }
}
function reconcile(p) {
    const v = find(F + 'ForumDelivery', { deliveryId: p.deliveryId })
        .forUpdate(true)
        .one()
    if (
        v?.state === 'sending' &&
        ec.user.timestampMillis(v.startedAt || v.dueAt) < time() - 300000
    )
        // An in-app notice has no outside effect, so it simply retries; only mail can be ambiguous.
        set(
            v,
            v.channel === 'in-app'
                ? { state: 'retry', dueAt: now() }
                : {
                      state: 'uncertain',
                      lastError:
                          'Worker ended before provider acceptance was recorded',
                  },
        )
    return { state: v?.state }
}
function dispatch() {
    const failures = []
    let processed = 0
    for (const item of Array.from(
        find(F + 'ForumDelivery', { state: 'sending' })
            .orderBy('dueAt,deliveryId')
            .limit(100)
            .list(),
    )) {
        try {
            ec.service
                .sync()
                .throwOnError(true)
                .name('mantle.forum.DeliveryWorkerServices.reconcile#Delivery')
                .parameters({ deliveryId: item.deliveryId })
                .requireNewTransaction(true)
                .call()
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum delivery reconciliation failed for ' +
                    item.deliveryId +
                    ': ' +
                    firstLine(error),
            )
            failures.push(item.deliveryId)
        }
    }
    const items = Array.from(
        find(F + 'ForumOutbox', { state: 'pending' })
            .orderBy('createdAt,outboxId')
            .limit(100)
            .list(),
    )
    // Each page is its own transaction; keep preparing until done or the run's time budget is spent.
    const deadline = time() + 20000
    for (const item of items) {
        try {
            for (;;) {
                const page = ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.DeliveryWorkerServices.prepare#Outbox')
                    .parameters({ outboxId: item.outboxId })
                    .requireNewTransaction(true)
                    .call().result
                processed++
                if (page.done || time() > deadline) break
            }
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum outbox ' + item.outboxId + ' failed: ' + firstLine(e),
            )
            failures.push(item.outboxId)
        }
        if (time() > deadline) break
    }
    for (const item of Array.from(
        find(F + 'ForumDelivery', {})
            .condition('state', 'in', ['pending', 'retry'])
            .orderBy('dueAt,deliveryId')
            .limit(100)
            .list(),
    )) {
        try {
            const c = ec.service
                .sync()
                .throwOnError(true)
                .name('mantle.forum.DeliveryWorkerServices.claim#Delivery')
                .parameters({ deliveryId: item.deliveryId })
                .requireNewTransaction(true)
                .call().result
            if (c.claimed)
                ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.DeliveryWorkerServices.send#Delivery')
                    .parameters({ deliveryId: item.deliveryId })
                    .requireNewTransaction(true)
                    .call()
            processed++
        } catch (e) {
            ec.message.clearErrors()
            ec.logger.error(
                'Forum delivery ' +
                    item.deliveryId +
                    ' failed; inspect uncertain attempt: ' +
                    firstLine(e),
            )
            failures.push(item.deliveryId)
        }
    }
    return { processed, failedItemIds: failures }
}
/* The framework's mail queue (org.moqui.admin.OperationServices, moqui.server.MailOutcomeOwner; mr-boss impl-admin P12 R1):
   this worker tries a failed notice again itself (retry, with backoff) and keeps no stored message's id, so every stored
   message of a site's notice template is answered as the forum's: none is sent again or settled beside the worker. */
function mailOutcomeOwners(p) {
    const ids = Array.from(p.emailMessageIdList || [])
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
        .slice(0, 500)
    const templates = new Set(
        Array.from(find(F + 'ForumMailSettings').list())
            .map((row) => row.templateId)
            .filter(Boolean),
    )
    if (!ids.length || !templates.size) return { ownerList: [] }
    return {
        ownerList: Array.from(
            find('moqui.basic.email.EmailMessage')
                .condition('emailMessageId', 'in', ids)
                .condition('emailTemplateId', 'in', Array.from(templates))
                .selectField('emailMessageId')
                .list(),
        ).map((row) => ({
            emailMessageId: row.emailMessageId,
            ownerRef: '',
            ownerStateText: 'A forum notice',
            retryEligible: false,
            reconcileEligible: false,
            selfRetrying: true,
        })),
    }
}
function execute(op, p) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return {
            prepare,
            claim,
            deliver,
            reconcile,
            dispatch,
            prepareDigest,
            digests,
            mailOutcomeOwners,
        }[op](p || {})
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({ execute })
