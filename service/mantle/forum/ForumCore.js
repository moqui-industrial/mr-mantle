/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shared forum authority core: entity and identity primitives, the site/category/topic/conversation access
 * evaluator, idempotent write support, audit and shared policy. Forum.js and ForumModeration.js use one evaluation.
 * Entity access is privileged here; every object projection passes current domain policy first.
 */
const F = 'mantle.forum.',
    S = 'mantle.public.',
    E = 'mantle.party.communication.'
const now = () => ec.user.nowTimestamp
const millis = (value) => (value == null ? 0 : ec.user.timestampMillis(value))
/* A time stamp for an entity condition from epoch milliseconds. */
const stamp = (ms) => new Date(ms)
const id = () => ec.user.randomString(32)
const hash = (text) => ec.user.singleUseCodeHash(String(text))
const me = () =>
    ec.user.userAccount?.partyId ||
    (ec.user.userId
        ? ec.entity
              .find('moqui.security.UserAccount')
              .condition('userId', ec.user.userId)
              .disableAuthz()
              .one()?.partyId
        : null) ||
    null
const find = (entity, fields) => ec.entity.find(entity).condition(fields || {})
const one = (entity, fields, lock) =>
    (lock ? find(entity, fields).forUpdate(true) : find(entity, fields)).one()
const rows = (entity, fields, limit = 100) =>
    Array.from(find(entity, fields).limit(limit).list())
const create = (entity, fields) => {
    const v = ec.entity.makeValue(entity)
    for (const [k, x] of Object.entries(fields)) v.set(k, x)
    v.create()
    return v
}
const update = (v, fields) => {
    for (const [k, x] of Object.entries(fields)) v.set(k, x)
    v.update()
    return v
}
const pick = (v, names) =>
    Object.fromEntries(names.split(' ').map((k) => [k, v?.[k] ?? null]))
function fail(kind, message) {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
const missing = () => fail('NotFound', 'Resource not found')
const invalid = (text) => fail('Unprocessable', text)
const requireUser = () => {
    const party = me()
    if (!party) fail('AuthenticationRequired', 'Sign in to continue')
    return party
}
const active = (row) =>
    row &&
    (!row.fromDate || millis(row.fromDate) <= millis(now())) &&
    (!row.thruDate || millis(row.thruDate) > millis(now()))
/* A source grant in its effective dates and not revoked. */
const grantActive = (g) => active(g) && !g.revokedAt
const member = (siteId, partyId = me()) =>
    partyId ? one(S + 'PublicSiteParty', { siteId, partyId }) : null
const isOperator = () => ec.user.isInGroup('ADMIN')
function site(id, staff = false) {
    const v = one(S + 'PublicSite', { siteId: id }, staff)
    if (!v) missing()
    const m = member(id),
        owner =
            active(m) &&
            m.state === 'active' &&
            m.role === 'owner' &&
            !sanctioned(id, m.partyId, null, 'suspend')
    if (staff && !owner && !isOperator())
        fail('Unauthorized', 'Site owner access required')
    // Internal staff keep using bound mailboxes through Comms before publication; category access still decides
    // what they can read there.
    if (
        v.state !== 'published' &&
        !owner &&
        !isOperator() &&
        !internalParty(me())
    )
        missing()
    return v
}
function revision(row, expected) {
    if (
        expected == null ||
        Number(expected) !== Number(row.revision ?? row.policyRevision)
    )
        fail('Conflict', 'State changed; reload and compare before saving')
}
function bump(siteId) {
    const s = one(S + 'PublicSite', { siteId }, true)
    update(s, { generation: Number(s.generation || 0) + 1 })
}
function sanctioned(siteId, partyId, contactListId, kind) {
    if (!partyId) return false
    const cf = ec.entity.conditionFactory
    return (
        find(F + 'ForumSanction', { siteId, partyId, kind })
            .conditionDate('fromDate', 'thruDate', now())
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('contactListId', 'equals', null),
                        cf.makeCondition(
                            'contactListId',
                            'equals',
                            contactListId || null,
                        ),
                    ],
                    'or',
                ),
            )
            .count() > 0
    )
}

function listMember(contactListId, partyId) {
    if (!partyId) return null
    return (
        Array.from(
            find('mantle.marketing.contact.ContactListParty', {
                contactListId,
                partyId,
                statusId: 'CLPT_ACCEPTED',
            })
                .conditionDate('fromDate', 'thruDate', now())
                .orderBy('-fromDate')
                .limit(1)
                .list(),
        )[0] || null
    )
}
/* Read-heavy loops (topic lists, search, summaries) evaluate the same category for the same actor many times.
   Inside withAccessMemo those answers are kept for the rest of that one call; writes never run inside it. */
let accessMemo = null
function withAccessMemo(work) {
    const outer = accessMemo
    accessMemo = outer || new Map()
    try {
        return work()
    } finally {
        accessMemo = outer
    }
}
function categoryAccess(contactListId, actor = me(), seen = new Set()) {
    if (accessMemo && seen.size === 0) {
        const key = contactListId + '|' + (actor || '')
        if (!accessMemo.has(key))
            accessMemo.set(
                key,
                evaluateCategoryAccess(contactListId, actor, seen),
            )
        return accessMemo.get(key)
    }
    return evaluateCategoryAccess(contactListId, actor, seen)
}
function evaluateCategoryAccess(contactListId, actor, seen) {
    const c = one(F + 'ForumCategory', { contactListId })
    if (!c || seen.has(contactListId)) return null
    seen.add(contactListId)
    const s = one(S + 'PublicSite', { siteId: c.siteId }),
        m = member(c.siteId, actor),
        lm = listMember(contactListId, actor)
    const joined =
        active(m) &&
        m.state === 'active' &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    const owner = joined && m.role === 'owner',
        staff = joined && ['owner', 'moderator'].includes(m.role)
    // Internal list members keep their mailbox through Comms whether or not they ever join the public site.
    const internalMember =
        !!lm &&
        internalParty(actor) &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    const participant = joined || internalMember
    const categoryStaff =
        participant &&
        !!lm &&
        ['ListOwner', 'ListModerator'].includes(lm.roleTypeId) &&
        !sanctioned(c.siteId, actor, contactListId, 'suspend')
    let moderate = staff || categoryStaff || (actor === me() && isOperator())
    // Source grants for this category or the whole site count only from the sources the category qualifies.
    const qualifying = String(c.qualifyingSources || 'manual').split(',')
    const grant = actor
        ? [
              ...rows(S + 'PublicAccessGrant', {
                  siteId: c.siteId,
                  partyId: actor,
                  targetType: 'category',
                  targetId: contactListId,
              }),
              ...rows(S + 'PublicAccessGrant', {
                  siteId: c.siteId,
                  partyId: actor,
                  targetType: 'site',
              }),
          ].find(
              (g) =>
                  grantActive(g) &&
                  qualifying.includes(g.sourceType || 'manual') &&
                  // A grant for the whole site opens only categories that chose their qualifying sources.
                  (g.targetType === 'category' || !!c.qualifyingSources),
          )
        : null
    const granted = !!grant
    const published =
        s?.state === 'published' && c.publicationState === 'published'
    let read =
        moderate ||
        internalMember ||
        (published &&
            (c.visibility === 'public' ||
                (joined && (c.visibility === 'members' || !!lm || granted))))
    if (c.visibility === 'help' && !moderate && !lm) read = false
    let own = !read && published && joined && c.visibility === 'help'
    if (c.parentContactListId) {
        const parent = categoryAccess(c.parentContactListId, actor, seen)
        if (!parent || parent.category.siteId !== c.siteId) return null
        read = read && parent.canRead
        own = own && parent.canRead
        moderate = moderate && parent.canRead
    }
    const list = one('mantle.marketing.contact.ContactList', { contactListId })
    const archived =
        list?.archivedDate && millis(list.archivedDate) <= millis(now())
    const post =
        participant &&
        !archived &&
        !sanctioned(c.siteId, actor, contactListId, 'silence') &&
        (read || own) &&
        (list?.postingEnumId === 'ClpAnyUser' ||
            (list?.postingEnumId === 'ClpModerators'
                ? moderate
                : !!lm || granted))
    return {
        category: c,
        site: s,
        isOwner: owner,
        entitlement: grant
            ? pick(grant, 'grantId targetType sourceType fromDate thruDate')
            : null,
        canDiscover: read,
        canRead: read,
        canReadOwn: own,
        canStartTopic: !!post,
        canReply: !!post,
        canEdit: !!post,
        canUpload: !!post,
        canFlag: participant && !!(read || own),
        canReact: !!post,
        canVote: !!post,
        canModerate: moderate,
        canInvite: owner || categoryStaff,
    }
}
function category(id, siteId) {
    const a = categoryAccess(id)
    if (
        !a ||
        a.category.siteId !== siteId ||
        !(a.canRead || a.canReadOwn || a.canModerate)
    )
        missing()
    return a
}
/* An article is readable when it has a published version and, if a subscription resource is bound to it, the
   party holds a current grant for it. Paid articles arrive with Publishing; the rule is fixed now. */
function articleReadable(siteId, wikiPageId, partyId) {
    const page = one('moqui.resource.wiki.WikiPage', { wikiPageId })
    if (!page?.publishedVersionName) return false
    if (
        !one(S + 'PublicSubscriptionBinding', {
            siteId,
            targetType: 'article',
            targetId: wikiPageId,
        })
    )
        return true
    return rows(S + 'PublicAccessGrant', {
        siteId,
        partyId,
        targetType: 'article',
        targetId: wikiPageId,
    }).some(grantActive)
}
/* A discussion linked with a narrowing gate is readable only while its source is: an article's comments close
   when the article is withdrawn. Every reader path (topic reads, lists, search, feeds, email) applies this. */
function sourceGate(rootCommEventId, partyId = me()) {
    for (const link of rows(S + 'PublicDiscussionLink', {
        rootCommEventId,
        sourceType: 'article',
        detachedAt: null,
    }))
        // A paid article's discussion is always gated by the article, whatever gate the link was given.
        if (
            (link.gate === 'narrow' ||
                one(S + 'PublicSubscriptionBinding', {
                    siteId: link.siteId,
                    targetType: 'article',
                    targetId: link.sourceId,
                })) &&
            !articleReadable(link.siteId, link.sourceId, partyId)
        )
            return false
    return true
}
function topic(root, siteId, lock = false) {
    const t = one(F + 'ForumTopic', { rootCommEventId: root }, lock)
    if (!t || t.siteId !== siteId) missing()
    if (t.kind === 'private') return privateTopic(t)
    if (t.kind !== 'category') missing()
    const event = one(E + 'CommunicationEvent', { communicationEventId: root })
    if (!event) missing()
    const a = category(event.contactListId, siteId)
    // Help access follows authored participation, never a stale recipient row.
    if (
        !a.canRead &&
        !a.canModerate &&
        !find(E + 'CommunicationEvent', {
            rootCommEventId: root,
            fromPartyId: me(),
        }).count() &&
        event.fromPartyId !== me()
    )
        missing()
    if (!a.canModerate && !sourceGate(root)) missing()
    const state = one(F + 'ForumPostState', { communicationEventId: root })
    if (
        state &&
        state.visibility !== 'approved' &&
        event.fromPartyId !== me() &&
        !a.canModerate
    )
        missing()
    return { t, event, a }
}
function postVisible(state, event, a) {
    return (
        state.visibility === 'approved' ||
        event.fromPartyId === me() ||
        a.canModerate
    )
}
const trustLevel = (siteId, partyId = me()) =>
    (partyId && one(F + 'ForumMemberState', { siteId, partyId })?.trustLevel) ||
    'new'
const json = (text, fallback) => {
    try {
        return text ? JSON.parse(text) : fallback
    } catch (e) {
        return fallback
    }
}
function page(p, scope) {
    const limit = p.limit == null ? 30 : Number(p.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        invalid('limit must be from 1 through 100')
    const actorKey = ec.user.userId || '_ANONYMOUS_',
        scopeHash = hash(scope)
    let offset = 0
    if (p.cursor) {
        if (
            typeof p.cursor !== 'string' ||
            !/^[A-Za-z0-9_-]{32}$/.test(p.cursor)
        )
            invalid('Invalid cursor')
        const cursor = one(F + 'ForumCursor', { cursorId: p.cursor })
        if (
            !cursor ||
            cursor.actorKey !== actorKey ||
            cursor.scopeHash !== scopeHash ||
            millis(cursor.expiresAt) <= millis(now())
        )
            invalid('Invalid cursor')
        offset = Number(cursor.position)
    }
    return {
        limit,
        offset,
        next: (position) => {
            const prior = Array.from(
                find(F + 'ForumCursor', { actorKey, scopeHash, position })
                    .orderBy('-expiresAt,cursorId')
                    .limit(1)
                    .list(),
            )[0]
            if (prior && millis(prior.expiresAt) > millis(now()))
                return prior.cursorId
            if (prior) prior.delete()
            const cursorId = id()
            create(F + 'ForumCursor', {
                cursorId,
                actorKey,
                scopeHash,
                position,
                expiresAt: millis(now()) + 15 * 60000,
            })
            return cursorId
        },
    }
}
/* The actor's own account row serializes that actor's retries and first inserts (receipts, reading markers)
   without making every other member on the site or topic wait. */
function lockActor() {
    if (ec.user.userId)
        ec.entity
            .find('moqui.security.UserAccount')
            .condition('userId', ec.user.userId)
            .forUpdate(true)
            .one()
}
/* lock: what serializes the actor's retries, the actor's account row unless the work writes, in a transaction of its
   own, a row that refers to it (a login key), which would wait for that lock. */
function receipt(p, action, work, lock = lockActor) {
    const actorPartyId = requireUser()
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.operationId || ''))
        invalid(
            'operationId must contain 8–64 letters, numbers, underscores or hyphens',
        )
    lock()
    const key = {
            siteId: p.siteId,
            actorPartyId,
            operationId: p.operationId,
            action,
        },
        payload = { ...p }
    delete payload.operationId
    const payloadHash = hash(
        JSON.stringify(
            Object.fromEntries(
                Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)),
            ),
        ),
    )
    const old = one(F + 'ForumOperationReceipt', key)
    if (old) {
        if (old.payloadHash !== payloadHash)
            fail('Conflict', 'Operation ID was used with different input')
        return JSON.parse(old.resultJson)
    }
    const result = work()
    create(F + 'ForumOperationReceipt', {
        ...key,
        payloadHash,
        resultJson: JSON.stringify(
            Object.fromEntries(
                Object.entries(result).filter(
                    ([key]) => key !== 'token' && key !== 'credential',
                ),
            ),
        ),
    })
    return result
}
function protectOwner(siteId, partyId) {
    const replacements = rows(
        S + 'PublicSiteParty',
        { siteId, role: 'owner', state: 'active' },
        1000,
    ).some(
        (owner) =>
            owner.partyId !== partyId &&
            active(owner) &&
            !sanctioned(siteId, owner.partyId, null, 'suspend'),
    )
    if (!replacements) invalid('Assign another active owner first')
}
function review(
    siteId,
    contactListId,
    targetType,
    targetId,
    targetRevision,
    reasonFamily,
) {
    let r = find(F + 'ForumReviewItem', {
        siteId,
        targetType,
        targetId,
        reasonFamily,
    })
        .condition('state', 'in', ['pending', 'claimed'])
        .forUpdate(true)
        .one()
    if (r && Number(r.targetRevision) !== Number(targetRevision))
        update(r, {
            targetRevision,
            revision: Number(r.revision) + 1,
            state: 'pending',
            claimedByPartyId: null,
            claimExpiresAt: null,
        })
    if (!r)
        r = create(F + 'ForumReviewItem', {
            reviewId: id(),
            siteId,
            contactListId,
            targetType,
            targetId,
            targetRevision,
            reasonFamily,
            state: 'pending',
            revision: 1,
            createdAt: now(),
        })
    return r
}
function audit(
    siteId,
    contactListId,
    targetType,
    targetId,
    action,
    reason,
    before,
    after,
) {
    create(F + 'ForumModerationAction', {
        actionId: id(),
        siteId,
        contactListId,
        staffPartyId: requireUser(),
        targetType,
        targetId,
        action,
        reason: reason || '',
        beforeRevision: before,
        afterRevision: after,
        createdAt: now(),
    })
}
/* An audit entry for automatic work, such as entitlement and trust changes, with no acting staff member. */
function systemAudit(
    siteId,
    contactListId,
    targetType,
    targetId,
    action,
    reason,
    staffPartyId,
) {
    create(F + 'ForumModerationAction', {
        actionId: id(),
        siteId,
        contactListId,
        staffPartyId: staffPartyId || null,
        targetType,
        targetId,
        action,
        reason: reason || '',
        createdAt: now(),
    })
}
function refreshReviews(siteId, postId, targetRevision) {
    for (const r of find(F + 'ForumReviewItem', {
        siteId,
        targetType: 'post',
        targetId: postId,
    })
        .condition('state', 'in', ['pending', 'claimed'])
        .forUpdate(true)
        .list())
        if (Number(r.targetRevision) !== Number(targetRevision))
            update(r, {
                targetRevision,
                revision: Number(r.revision) + 1,
                state: 'pending',
                claimedByPartyId: null,
                claimExpiresAt: null,
            })
}
function staff(siteId, contactListId) {
    if (contactListId) {
        const a = category(contactListId, siteId)
        if (a.canModerate) return a
        fail('Unauthorized', 'Scoped moderator access required')
    }
    const m = member(siteId)
    if (
        !isOperator() &&
        !(
            active(m) &&
            m.state === 'active' &&
            !sanctioned(siteId, me(), null, 'suspend') &&
            ['owner', 'moderator'].includes(m.role)
        )
    )
        fail('Unauthorized', 'Scoped moderator access required')
    return null
}
// Internal helpers are never routed by the public API.
function allocateInternal(postId, contactListId, author) {
    for (const partyId of internalMemberIds(contactListId)) {
        if (partyId === author) continue
        const a = categoryAccess(contactListId, partyId)
        if (a && !a.canRead) continue
        create(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
            roleTypeId: 'MessageMailbox',
            statusId: 'CepReceived',
        })
    }
}
function internalParty(partyId) {
    if (!partyId) return false
    const cf = ec.entity.conditionFactory
    return (
        find(F + 'ForumInternalAccount', { partyId })
            .conditionDate('fromDate', 'thruDate', now())
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('disabled', 'equals', null),
                        cf.makeCondition('disabled', 'not-equals', 'Y'),
                    ],
                    'or',
                ),
            )
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('terminateDate', 'equals', null),
                        cf.makeCondition('terminateDate', 'greater', now()),
                    ],
                    'or',
                ),
            )
            .limit(1)
            .list().length > 0
    )
}
function internalMemberIds(contactListId) {
    // A view joins only internal accounts/groups; no public membership scan at posting time.
    return new Set(
        Array.from(
            find(F + 'InternalMailboxMember', {
                contactListId,
                statusId: 'CLPT_ACCEPTED',
            })
                .conditionDate('fromDate', 'thruDate', now())
                .conditionDate('groupFromDate', 'groupThruDate', now())
                .condition(
                    ec.entity.conditionFactory.makeCondition(
                        'disabled',
                        'not-equals',
                        'Y',
                        true,
                    ),
                )
                .list(),
        )
            .filter(
                (v) =>
                    v.disabled !== 'Y' &&
                    (!v.terminateDate ||
                        millis(v.terminateDate) > millis(now())) &&
                    (!v.groupFromDate ||
                        millis(v.groupFromDate) <= millis(now())) &&
                    (!v.groupThruDate ||
                        millis(v.groupThruDate) > millis(now())),
            )
            .map((v) => v.partyId),
    )
}
/* Sanitized HTML as plain text; templates escape it once. */
function plainText(html) {
    return StringUtilities.cleanHtml(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
            String.fromCodePoint(parseInt(n, 16)),
        )
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim()
}
function clearAnswer(t, a, postId, reason) {
    if (!postId || t.acceptedAnswerId !== postId) return
    update(t, { acceptedAnswerId: null, revision: Number(t.revision) + 1 })
    audit(
        t.siteId,
        a.category.contactListId,
        'topic',
        t.rootCommEventId,
        'answer-cleared',
        reason,
        Number(t.revision) - 1,
        Number(t.revision),
    )
}
/* Soft delete keeps the post row and its ordinal; replies that depend on it keep the author from removing it. */
function softDelete(st, event, t, a, reason) {
    if (st.communicationEventId === t.rootCommEventId)
        invalid('Delete a whole topic through moderation')
    const wasVisible = st.visibility === 'approved'
    update(st, {
        visibility: 'deleted',
        deletedAt: now(),
        deletedByPartyId: me(),
        deleteReason: reason || '',
        revision: Number(st.revision) + 1,
        approvedRevision: null,
    })
    update(t, {
        visiblePostCount: wasVisible
            ? Math.max(0, Number(t.visiblePostCount) - 1)
            : Number(t.visiblePostCount),
        reactionCount: Math.max(
            0,
            Number(t.reactionCount || 0) - Number(st.reactionCount || 0),
        ),
        revision: Number(t.revision) + 1,
    })
    clearAnswer(t, a, st.communicationEventId, reason || 'Answer deleted')
    refreshReviews(t.siteId, st.communicationEventId, Number(st.revision))
}
/* Numeric settings are [default, minimum, maximum]. Owners may be stricter than a default, never laxer. */
const POLICY_NUMBERS = {
    firstContributionCount: [2, 2, 20],
    postIntervalSeconds: [10, 10, 86400],
    editWindowHours: [24, 0, 24],
    maxPostLength: [100000, 1000, 100000],
    slowModeSeconds: [0, 0, 86400],
    basicTopicsEntered: [5, 5, 10000],
    basicPostsRead: [20, 20, 100000],
    basicReadingMinutes: [10, 10, 100000],
    basicVisitDays: [2, 2, 1000],
    memberVisitDays: [15, 15, 1000],
    memberTopicsEntered: [20, 20, 10000],
    memberPostsRead: [100, 100, 100000],
    memberReadingMinutes: [60, 60, 100000],
    regularVisitDays: [50, 50, 1000],
    regularTopicsEntered: [100, 100, 10000],
    regularPostsRead: [500, 500, 100000],
    regularApprovedContributions: [10, 10, 10000],
    abuseFreeDays: [30, 30, 365],
    flagHideCount: [3, 2, 10],
    privateRecipientLimit: [10, 1, 10],
    mediaMaxBytes: [10485760, 1024, 10485760],
    mediaFilesPerPost: [10, 0, 10],
}
const POLICY_FLAGS = {
    classifierEnabled: false,
    privateEnabled: true,
    privateExistingReplies: true,
    privateFullBodyEmail: false,
}
const POLICY_CHOICES = {
    privateMinTrust: ['basic', ['new', 'basic', 'member', 'regular']],
}
const TRUST_ORDER = ['new', 'basic', 'member', 'regular']
const trustRank = (level) => Math.max(0, TRUST_ORDER.indexOf(level))
function policy(siteId) {
    const v = Array.from(
        find(F + 'ForumPolicy', { siteId })
            .orderBy('-policyRevision')
            .limit(1)
            .list(),
    )[0]
    const out = {
        ...Object.fromEntries(
            Object.entries(POLICY_NUMBERS).map(([k, [d]]) => [k, d]),
        ),
        ...POLICY_FLAGS,
        ...Object.fromEntries(
            Object.entries(POLICY_CHOICES).map(([k, [d]]) => [k, d]),
        ),
    }
    return Object.assign(out, json(v?.config, {}))
}
/* ---- Content rules ---- */
const escapeRegex = (text) =>
    String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function ruleRegex(r) {
    if (r.ruleType === 'regex') return new RegExp(r.pattern, 'i')
    if (r.ruleType === 'link')
        return new RegExp(
            '(?:https?://|www\\.)(?:[^\\s/"\'<>]*\\.)?' +
                escapeRegex(r.pattern),
            'i',
        )
    return new RegExp('\\b' + escapeRegex(r.pattern) + '\\b', 'i')
}
/* Censoring masks matched text outside tags; the author's original stays in the revision source for staff. */
function censor(html, re) {
    const global = new RegExp(re.source, re.flags.replace('g', '') + 'g')
    return String(html)
        .split(/(<[^>]*>)/)
        .map((part) =>
            part.startsWith('<')
                ? part
                : part.replace(global, (m) => '■'.repeat(m.length)),
        )
        .join('')
}
/* ---- Trust ---- */
function memberStateFor(siteId, partyId) {
    const key = { siteId, partyId }
    return (
        one(F + 'ForumMemberState', key, true) ||
        create(F + 'ForumMemberState', {
            ...key,
            trustLevel: 'new',
            approvedContributions: 0,
            dailyTopics: 0,
            dailyReplies: 0,
            revision: 1,
        })
    )
}
/* Classification is queued with the post and runs after commit; an unavailable classifier only delays review. */
function queueClassification(siteId, postId) {
    if (!policy(siteId).classifierEnabled) return
    // Private messages reach staff only through a member's report, never through a classifier.
    const st = one(F + 'ForumPostState', { communicationEventId: postId })
    if (
        st &&
        one(F + 'ForumTopic', { rootCommEventId: st.rootCommEventId })?.kind ===
            'private'
    )
        return
    create(F + 'ForumOutbox', {
        outboxId: id(),
        siteId,
        communicationEventId: postId,
        eventType: 'classify',
        state: 'classify',
        cursor: '0',
        createdAt: now(),
    })
}
/* A member's own mute or block of another member on one site. */
function memberBlocks(siteId, partyId, targetPartyId) {
    const v =
        partyId && targetPartyId
            ? one(F + 'ForumMemberPreference', {
                  siteId,
                  partyId,
                  targetPartyId,
              })
            : null
    return (
        v?.preference === 'block' &&
        (!v.expiresAt || millis(v.expiresAt) > millis(now()))
    )
}
/* ---- Stage 2 private conversations: explicit participants, no category, no staff browsing ---- */
/* Access to a private topic comes only from an active participant row and current site membership. */
function conversationAccess(t, actor = me()) {
    const s = one(S + 'PublicSite', { siteId: t.siteId }),
        m = member(t.siteId, actor),
        joined =
            active(m) &&
            m.state === 'active' &&
            !sanctioned(t.siteId, actor, null, 'suspend'),
        part = actor
            ? one(F + 'ForumParticipant', {
                  rootCommEventId: t.rootCommEventId,
                  partyId: actor,
              })
            : null,
        participant = !!(joined && part && !part.endedAt),
        pol = policy(t.siteId),
        write =
            participant &&
            !sanctioned(t.siteId, actor, null, 'silence') &&
            (pol.privateEnabled || pol.privateExistingReplies)
    return {
        category: {
            contactListId: null,
            siteId: t.siteId,
            visibility: 'private',
            mode: 'discussion',
            policyRevision: 0,
        },
        site: s,
        isOwner: participant && part.role === 'owner',
        canDiscover: participant,
        canRead: participant,
        canReadOwn: false,
        canStartTopic: false,
        canReply: write,
        canEdit: write,
        canUpload: write,
        canFlag: participant,
        canReact: write,
        canVote: write,
        canModerate: false,
        canInvite: participant && part.role === 'owner',
    }
}
function privateTopic(t) {
    const event = one(E + 'CommunicationEvent', {
        communicationEventId: t.rootCommEventId,
    })
    const a = conversationAccess(t)
    if (!event || !a.canRead) missing()
    return { t, event, a }
}
;({
    F,
    S,
    E,
    now,
    millis,
    stamp,
    id,
    hash,
    me,
    find,
    one,
    rows,
    create,
    update,
    pick,
    fail,
    missing,
    invalid,
    requireUser,
    active,
    grantActive,
    member,
    isOperator,
    site,
    revision,
    bump,
    sanctioned,
    listMember,
    accessMemo,
    withAccessMemo,
    categoryAccess,
    evaluateCategoryAccess,
    category,
    articleReadable,
    sourceGate,
    topic,
    postVisible,
    trustLevel,
    json,
    page,
    lockActor,
    receipt,
    protectOwner,
    review,
    audit,
    systemAudit,
    refreshReviews,
    staff,
    allocateInternal,
    internalParty,
    internalMemberIds,
    plainText,
    clearAnswer,
    softDelete,
    POLICY_NUMBERS,
    POLICY_FLAGS,
    POLICY_CHOICES,
    TRUST_ORDER,
    trustRank,
    policy,
    escapeRegex,
    ruleRegex,
    censor,
    memberStateFor,
    queueClassification,
    memberBlocks,
    conversationAccess,
    privateTopic,
})
