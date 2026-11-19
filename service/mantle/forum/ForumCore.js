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
/* The day (UTC) that the day's counters of a member are of: yyyy-MM-dd. A timestamp is text of epoch milliseconds, whose
   first ten characters are the second, not the day. */
const dayKey = () => new Date(millis(now())).toISOString().slice(0, 10)
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
/* A category and the categories above it, nearest first. */
function categoryChain(contactListId) {
    const chain = []
    let at = contactListId || null
    while (at && chain.length < 8 && !chain.includes(at)) {
        chain.push(at)
        at = one(F + 'ForumCategory', { contactListId: at })?.parentContactListId
    }
    return chain
}
/* A sanction of the whole site, or of the category or one above it: what is said of a group's category holds in the
   categories of its subgroups and repositories. */
function sanctioned(siteId, partyId, contactListId, kind) {
    if (!partyId) return false
    const cf = ec.entity.conditionFactory
    const chain = categoryChain(contactListId)
    return (
        find(F + 'ForumSanction', { siteId, partyId, kind })
            .conditionDate('fromDate', 'thruDate', now())
            .condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('contactListId', 'equals', null),
                        chain.length > 1
                            ? cf.makeCondition('contactListId', 'in', chain)
                            : cf.makeCondition(
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
/* A category and every category below it in its site (a scope), as a set of ids; at most 2000. */
function categorySubtree(siteId, contactListId) {
    const all = rows(F + 'ForumCategory', { siteId }, 2000)
    const inside = new Set([contactListId])
    for (let added = true; added; ) {
        added = false
        for (const c of all)
            if (
                c.parentContactListId &&
                inside.has(c.parentContactListId) &&
                !inside.has(c.contactListId)
            ) {
                inside.add(c.contactListId)
                added = true
            }
    }
    return inside
}
/* A route address is lower case with no plus tag; its domain must be one the operator registered. */
function routeAddress(address) {
    const value = String(address || '')
        .trim()
        .toLowerCase()
    const m = /^([a-z0-9._-]{1,64})@([a-z0-9.-]{1,190})$/.exec(value)
    if (!m) invalid('A route address is local@domain without a plus tag')
    const domains = String(ec.factory.getConfValue('pass@route-domains') || '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    if (!domains.includes(m[2]))
        invalid('The route domain is not registered for this deployment')
    if (ownedMailAddress(value))
        invalid("That address is a person's or an organization's mail address, not a route")
    return value
}
/* Whether an address is someone's own (SEC-PFS-85): a user account's address, or the address or an identity of a mail account
   a user or an organization owns (a person's hosted mailbox, an organization's shared one), unless the account is one of the
   forum's own inbound accounts (mantle@forum-inbound-accounts, Forum.js forumAccount). A route takes the mail of its address
   into the site's forum, so a site owner may name only an address of such an account. */
function ownedMailAddress(address) {
    const same = (field) =>
        ec.entity.conditionFactory
            .makeCondition(field, 'equals', address)
            .ignoreCase()
    if (find('moqui.security.UserAccount').condition(same('emailAddress')).count() > 0)
        return true
    // the forum's own inbound accounts (mantle@forum-inbound-accounts) hold route addresses whoever made them
    const forumAccounts = String(ec.factory.getConfValue('mantle@forum-inbound-accounts') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    const owned = (emailAccountId) => {
        if (forumAccounts.includes(String(emailAccountId))) return false
        const account = one('moqui.basic.email.EmailAccount', { emailAccountId })
        return !!account && !!(account.ownerUserId || account.ownerPartyId)
    }
    for (const account of Array.from(
        find('moqui.basic.email.EmailAccount').condition(same('emailAddress')).limit(20).list(),
    ))
        if (owned(account.emailAccountId)) return true
    for (const identity of Array.from(
        find('moqui.basic.email.EmailIdentity').condition(same('emailAddress')).limit(20).list(),
    ))
        if (owned(identity.emailAccountId)) return true
    return false
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
    // An Owner of the group or repository a category is bound to moderates the scope they own (the app's scope module).
    const staffModerate =
        staff || categoryStaff || (actor === me() && isOperator())
    let moderate =
        staffModerate ||
        (!!actor &&
            !sanctioned(c.siteId, actor, contactListId, 'suspend') &&
            scopeOwner(contactListId, actor))
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
    // A category bound to a group or a repository is no wider than it (the access ceiling): who may not view that
    // scope reads and moderates nothing here, and a private scope's readers and posters are the accounts with a role
    // in it, not the list's members.
    const bound = scopeView(contactListId, actor)
    const scopeMember = !!bound && bound.canView && bound.restricted && bound.member
    if (bound && !bound.canView) read = own = moderate = false
    else if (bound?.restricted) {
        read = moderate || (published && bound.member)
        own = false
    }
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
                : !!lm || granted || scopeMember))
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
        // moderates only as an Owner of the scope the category is bound to: not the site's or the category's staff,
        // so what is the site's (a member's activity across it) is not theirs to read
        scopeOwnerOnly: moderate && !staffModerate,
        // moderates as the site's staff (an owner or moderator of the site, or the operator), not only the category's
        siteStaff: moderate && (staff || (actor === me() && isOperator())),
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
    // an article of the site's own publishing space; a page of any other space is no reader's here
    if (
        page.wikiSpaceId !==
        one(S + 'PublicSite', { siteId })?.publishingWikiSpaceId
    )
        return false
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
/* records: the caller handles the conversation of a record (an issue), whose access is its app's (recordAccess).
   Every other caller refuses one, after the same Not Found for a reader who may not see it. */
function topic(root, siteId, lock = false, records = false) {
    const t = one(F + 'ForumTopic', { rootCommEventId: root }, lock)
    if (!t || t.siteId !== siteId) missing()
    if (t.kind === 'private') return privateTopic(t)
    if (t.kind === 'record') {
        const out = recordTopic(t)
        if (!records) notForRecord()
        return out
    }
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
    // A staff post of a record is its Owners' alone, checked for each reader.
    if (state.visibility === 'staff') return !!a.canReadStaff
    return (
        state.visibility === 'approved' ||
        event.fromPartyId === me() ||
        a.canModerate ||
        // a private conversation's message held as spam is its participants' to see and release (Forum.js)
        (state.visibility === 'pending' &&
            a.category?.visibility === 'private' &&
            !!a.canRead)
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
/* A member's HTML (a post, a bio) cleaned, with an image kept only when it is one of the site's own attachment downloads:
   a relative path under one of the site's forum mounts (its pathPrefix), of plain segments (no empty, '.' or '..' one, so
   no '//host' and no step out of the mount), ending in /download?attachmentId=<id>. A reader's browser then loads no
   other image, so no same-site route (a write transition, reached with the reader's cookie) and no outside tracker is
   fetched by showing it (SEC-PSF-81). Any other image is a link to its outside address, or its alt text for a relative
   one. In mail (mail true) every image is a link or its text: there no page policy applies, and a mail client that loads
   images tells the sender who read when. With no site every image goes. */
const ATTACHMENT_PATH =
    /^((?:\/[A-Za-z0-9_~-][A-Za-z0-9._~-]*)*)\/download\?attachmentId=[A-Za-z0-9_-]{1,64}(?:&amp;variant=thumbnail)?$/
const forumMounts = new Map()
function forumPrefixes(siteId) {
    if (!forumMounts.has(siteId))
        forumMounts.set(
            siteId,
            rows(S + 'PublicSiteApp', { siteId, app: 'forum' }, 20)
                .filter((row) => row.enabled === 'Y')
                .map((row) => String(row.pathPrefix || '').replace(/\/+$/, '')),
        )
    return forumMounts.get(siteId)
}
function siteAttachment(src, siteId) {
    const path = ATTACHMENT_PATH.exec(src)
    if (!siteId || !path) return false
    return forumPrefixes(siteId).some(
        (prefix) => path[1] === prefix || path[1].startsWith(prefix + '/'),
    )
}
function memberHtml(html, siteId, mail = false) {
    const cleaned = StringUtilities.cleanHtml(html || '')
    if (!/<img\b/i.test(cleaned)) return cleaned
    const attribute = (tag, name) =>
        (new RegExp('\\s' + name + '="([^"]*)"', 'i').exec(tag) || [])[1] || ''
    return StringUtilities.cleanHtml(
        cleaned.replace(/<img\b[^>]*>/gi, (tag) => {
            const src = attribute(tag, 'src'),
                alt = WebUtilities.encodeHtml(
                    attribute(tag, 'alt')
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&'),
                )
            if (!mail && siteAttachment(src, siteId)) return tag
            if (/^https?:\/\//i.test(src))
                return '<a href="' + src + '">' + (alt || 'image') + '</a>'
            return alt
        }),
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
/* Mail From and Sender fields (SEC-PFS-81). A field is `name <address>`, `"name" <address>`, `address (comment)` or an
   address alone; the address of its mailbox is the angle-bracketed address that ends it, or the bare address before a
   trailing comment, never an address written in the name. Quoted strings and comments are text, so only an address
   outside them is one of the field's (fieldAddressCount). */
const ADDRESS_TOKEN = /[^\s<>()\[\],;:"'@]+@[^\s<>()\[\],;:"'@]+/g
const QUOTED = /"(?:[^"\\]|\\.)*"/g
const COMMENT = /\((?:[^()\\]|\\.)*\)/g
/* An addr-spec as the store keeps it: a quoted local part unquoted ("john.doe"@x is john.doe@x). */
function plainAddress(local, domain) {
    const unquoted = /^"([\s\S]*)"$/.exec(local)
    return (unquoted ? unquoted[1].replace(/\\(.)/g, '$1') : local) + '@' + domain
}
const LOCAL = '("(?:[^"\\\\]|\\\\.)*"|[^<>"\\s(),;:@]+)'
const DOMAIN = '([^<>"\\s(),;:@]+)'
const TRAILING_COMMENTS = /\s*((?:\((?:[^()\\]|\\.)*\)\s*)*)$/
function fieldMailbox(text) {
    const value = String(text || '').trim()
    // a comment after an angle-bracketed address is no part of it: Bob <bob@x> (work)
    const comments = TRAILING_COMMENTS.exec(value)
    const body = value.slice(0, comments.index).trim()
    const commentText = comments[1].replace(/^\(|\)\s*$/g, '').replace(/\)\s*\(/g, ' ').trim()
    const bracketed = new RegExp('<' + LOCAL + '@' + DOMAIN + '>$').exec(body)
    if (bracketed)
        return {
            address: plainAddress(bracketed[1], bracketed[2]),
            name: body
                .slice(0, bracketed.index)
                .trim()
                .replace(/^"([\s\S]*)"$/, '$1')
                .replace(/\\(.)/g, '$1')
                .trim(),
        }
    const bare = new RegExp('^' + LOCAL + '@' + DOMAIN + '$').exec(body)
    if (bare) return { address: plainAddress(bare[1], bare[2]), name: commentText }
    return { address: '', name: value }
}
/* How many addresses a raw header field names outside its quoted strings and comments (an encoded word holds no @). */
function fieldAddressCount(text) {
    let rest = String(text || '').replace(QUOTED, ' ')
    for (let depth = 0, before = null; depth < 5 && before !== rest; depth++) {
        before = rest
        rest = rest.replace(COMMENT, ' ')
    }
    return (rest.match(ADDRESS_TOKEN) || []).length
}
/* Whether a display name shows an address other than the mailbox's own (in any width of @: NFKC). */
function nameShowsOtherAddress(name, address) {
    const own = String(address || '').trim().toLowerCase()
    return (String(name || '').normalize('NFKC').match(ADDRESS_TOKEN) || []).some(
        (token) => token.replace(/^[.]+|[.]+$/g, '').toLowerCase() !== own,
    )
}
/* The tokens of an Authentication-Results field (RFC 8601 section 2.2) in its parts between semicolons: comments
   (nested, with quoted pairs) are dropped, a quoted string is one token {quoted}, '=' is a token, and anything else up
   to white space, '=', ';' or a quote is a word ("header.from", "dkim"; a property's "header . d" is joined). */
function authResultParts(text) {
    const parts = [[]]
    const source = String(text || '')
    let word = ''
    const end = () => {
        if (word) parts[parts.length - 1].push(word)
        word = ''
    }
    for (let i = 0; i < source.length; i++) {
        const ch = source[i]
        if (ch === '(') {
            end()
            let depth = 1
            for (i++; i < source.length && depth; i++) {
                if (source[i] === '\\') i++
                else if (source[i] === '(') depth++
                else if (source[i] === ')') depth--
            }
            i--
        } else if (ch === '"') {
            end()
            let quoted = ''
            for (i++; i < source.length && source[i] !== '"'; i++)
                quoted += source[i] === '\\' ? source[++i] || '' : source[i]
            parts[parts.length - 1].push({ quoted })
        } else if (ch === ';') {
            end()
            parts.push([])
        } else if (ch === '=') {
            end()
            parts[parts.length - 1].push('=')
        } else if (/\s/.test(ch)) end()
        else word += ch
    }
    end()
    // a property's name may have white space around its dot
    return parts.map((tokens) => {
        const out = []
        for (const token of tokens) {
            const last = out[out.length - 1]
            if (
                typeof token === 'string' &&
                typeof last === 'string' &&
                token !== '=' &&
                last !== '=' &&
                (token.startsWith('.') || last.endsWith('.'))
            )
                out[out.length - 1] = last + token
            else out.push(token)
        }
        return out
    })
}
const tokenText = (token) =>
    token == null ? '' : typeof token === 'string' ? token : token.quoted
/* An Authentication-Results field read (RFC 8601): {authservId, results: method -> {result, props}}, the first result
   of each method only (a later one of the same method, which a sender can add, counts for nothing); null for no field. */
function readAuthResults(text) {
    const parts = authResultParts(text)
    const authservId = tokenText(parts[0][0]).toLowerCase()
    if (!authservId) return null
    const results = {}
    for (const tokens of parts.slice(1)) {
        if (tokens[1] !== '=' || typeof tokens[0] !== 'string') continue
        const method = tokens[0].toLowerCase().split('/')[0]
        if (!method || method === 'none' || results[method]) continue
        const props = {}
        for (let k = 3; k + 2 < tokens.length; k++) {
            if (tokens[k + 1] !== '=' || typeof tokens[k] !== 'string') continue
            const name = tokens[k].toLowerCase()
            if (!(name in props)) props[name] = tokenText(tokens[k + 2])
            k += 2
        }
        results[method] = {
            result: tokenText(tokens[2]).toLowerCase(),
            props,
        }
    }
    return { authservId, results }
}
/* The authserv-id the mail listener writes its Authentication-Results under, or keeps the gateway's under
   (crates/moqui-mail/src/delivery.rs listener_options): smtp-server@authserv-id, else, on a listener that verifies mail
   itself (smtp-server@internet, or an edge node), its hostname (smtp-server@hostname, else the webroot's http-host, else
   localhost, as crates/moqui-mail/src/mx.rs hostname). A listener behind a gateway with no id keeps every field as it came,
   so none is trusted. Lower case; empty for none. */
function listenerAuthservIds() {
    const conf = (selector) => String(ec.factory.getConfValue(selector) ?? '').trim()
    const named = conf('smtp-server@authserv-id').toLowerCase()
    if (named) return [named]
    const verifies =
        conf('smtp-server@internet').toLowerCase() === 'true' ||
        ['front', 'front_edge', 'edge'].includes(conf('instance@node-role').toLowerCase())
    if (!verifies) return []
    return [(conf('smtp-server@hostname') || conf('webapp-list/webapp[webroot]@http-host') || 'localhost').toLowerCase()]
}
/* The authserv-ids of the providers a synced (IMAP or POP) mailbox's mail comes from, whose topmost Authentication-Results
   field is trusted for that mail (mantle@mail-provider-authserv-ids, comma separated; SEC-BAP-84). */
const providerAuthservIds = () =>
    String(ec.factory.getConfValue('mantle@mail-provider-authserv-ids') || '')
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean)
const trustedAuthservIds = listenerAuthservIds
/* Whether the mail gateway authenticated a sender's domain: in the topmost Authentication-Results field, which the
   receiving server wrote last, under a trusted authserv-id (the listener's own by default; trusted, a list, for a synced
   mailbox's provider), DMARC passed for the From domain, or a DKIM signature passed for that very domain (strict
   alignment). A lower field of a trusted id is no proof: a sender can write one (SEC-BAP-84). A parent's signature is not
   the subdomain's (d=host.example for team.host.example, SEC-PFS-64): relaxed alignment needs the organizational domain,
   which the gateway's DMARC finds by the public suffix list and this code does not. Another domain's pass, another
   server's field and a later result of a method count for nothing. Every path that trusts "authenticated by the gateway"
   asks this: a post by mail, a held message's sender, a report filed as an account, a service queue's mail. */
function gatewayAuthenticated(values, sender, trusted = trustedAuthservIds()) {
    const domain = String(sender || '')
        .split('@')
        .pop()
        .toLowerCase()
    if (!trusted.length || !domain || !String(sender || '').includes('@'))
        return false
    const aligned = (d) => {
        const signer = String(d || '')
            .replace(/^.*@/, '')
            .toLowerCase()
        return !!signer && domain === signer
    }
    return Array.from(values || []).slice(0, 1).some((value) => {
        const read = readAuthResults(value)
        if (!read || !trusted.includes(read.authservId)) return false
        const dmarc = read.results.dmarc
        if (
            dmarc?.result === 'pass' &&
            String(dmarc.props['header.from'] || '').toLowerCase() === domain
        )
            return true
        const dkim = read.results.dkim
        return (
            dkim?.result === 'pass' &&
            aligned(dkim.props['header.d'] || dkim.props['header.i'])
        )
    })
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
    // The text of a confidential record, and of a staff post, never goes to the classifier.
    if (st && (st.visibility === 'staff' || !classifiable(st.rootCommEventId)))
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
/* ---- Record conversations: the topic kind 'record' (an issue), whose access its app's scope module answers ---- */
const publicApps = () =>
    ec.resource.script(
        'component://mr-mantle/service/mantle/public/PublicApps.js',
    )
/* The apps that keep records register a scope module (PublicApps.apps.<app>.scope) and the entities whose
   contactListId binds a category to a group or repository (scopeEntities). A module is loaded on first need. */
let scopeModules = null
function scopes() {
    if (!scopeModules)
        scopeModules = Object.values(publicApps().apps)
            .filter((app) => app.scope)
            .map((app) => ec.resource.script(app.scope))
    return scopeModules
}
/* What a party may do in the conversation of a record: the evaluator's shape, or null when no app knows the topic. */
function recordAccess(rootCommEventId, actor = me()) {
    for (const scope of scopes()) {
        const a = scope.recordAccess(rootCommEventId, actor)
        if (a) return a
    }
    return null
}
/* Whether a party may read one post of a record (a staff post: its Owners; a held one: its author and moderators). */
function postAccess(postId, actor = me()) {
    return scopes().some((scope) => scope.postAccess(postId, actor))
}
/* Whether a party owns the group or repository a category is bound to. The module is asked only for a bound one. */
const scopeBound = new Map()
function scopeOwner(contactListId, actor) {
    // whether the category is bound at all is asked once for the life of this module's value (one call's work)
    if (!scopeBound.has(contactListId))
        scopeBound.set(
            contactListId,
            Object.values(publicApps().apps).some((app) =>
                (app.scopeEntities || []).some(
                    (entity) => find(entity, { contactListId }).count() > 0,
                ),
            ),
        )
    if (!scopeBound.get(contactListId) || !actor) return false
    const key = contactListId + '|' + actor
    if (!scopeBound.has(key))
        scopeBound.set(
            key,
            scopes().some((scope) => scope.categoryOwner(contactListId, actor)),
        )
    return scopeBound.get(key)
}
/* A category was bound to a group or a repository, or its binding ended: what was kept of it is asked again. */
function scopeChanged(contactListId) {
    for (const key of Array.from(scopeBound.keys()))
        if (key === contactListId || String(key).startsWith(contactListId + '|'))
            scopeBound.delete(key)
    if (accessMemo) accessMemo.clear()
}
/* How the group or repository a category is bound to is viewed by a party (null: no user): {canView, restricted (a
   private scope), member (a role in it)}, or null for a category that is bound to none. */
function scopeView(contactListId, actor) {
    scopeOwner(contactListId, null)
    if (!scopeBound.get(contactListId)) return null
    for (const scope of scopes()) {
        const view = scope.categoryView
            ? scope.categoryView(contactListId, actor || null)
            : null
        if (view) return view
    }
    return null
}
/* Who reads a category, as a fact of the category and the categories above it, not of one party: {anonymous (a visitor
   who is signed out), members (any active member of the site with no role, list membership or grant of its own)}. A
   category bound to a group or a repository is read by no more than view that scope (scopeView with no user for the
   anonymous; its visibility for the members). Linking a category to a scope and making a topic an issue compare these. */
function audience(contactListId, seen = new Set()) {
    const none = { anonymous: false, members: false }
    const c = contactListId ? one(F + 'ForumCategory', { contactListId }) : null
    if (!c || seen.has(contactListId)) return none
    seen.add(contactListId)
    const s = one(S + 'PublicSite', { siteId: c.siteId })
    const published =
        s?.state === 'published' && c.publicationState === 'published'
    let anonymous = published && c.visibility === 'public'
    let members = published && ['public', 'members'].includes(c.visibility)
    const bound = scopeView(contactListId, null)
    if (bound) {
        anonymous = anonymous && bound.canView
        members = members && Number(bound.visibility || 3) <= 2 && !bound.hidden
    }
    if (c.parentContactListId) {
        const up = audience(c.parentContactListId, seen)
        anonymous = anonymous && up.anonymous
        members = members && up.members
    }
    return { anonymous, members }
}
/* The path of the forum pages a category is read on, from the site's host: the forum of the nearest group or repository
   above it (or itself) that an app binds it to, else the site's forum mount; null for neither. So a list of a group on a
   site with no forum mount still has its archive, its posts' links and its held-mail page. */
function forumPath(siteId, contactListId) {
    if (contactListId)
        for (const id of categoryChain(contactListId)) {
            const base = scopeAnswer('forumBase', id)
            if (base != null) return base
        }
    return publicApps().mount(siteId, 'forum')?.base ?? null
}
/* forumPath as an absolute address on the site's canonical host; null without one (a preview host is never one). */
function forumUrl(siteId, contactListId) {
    const host = one(S + 'PublicSiteHost', { siteId, canonical: 'Y' })
    const path = forumPath(siteId, contactListId)
    return !host || host.hostKindEnumId === 'PshkPreview' || path == null
        ? null
        : 'https://' + host.hostname + path
}
/* work() signed in as an account (by username), then who was signed in is put back: the request's or job's user again,
   or, when there was none, nobody; so a web request's own user is never signed out. Unauthorized when the account cannot
   sign in now (no such account, or disabled). The borrowed login ends with logoutLocal, which writes nothing to the
   account, so the person's own sessions go on (hasLoggedOut is left as it was). The pattern of SitePages.js asAuthor. */
function asUser(username, work) {
    const account = username
        ? one('moqui.security.UserAccount', { username })
        : null
    const previous = ec.user.username
    const signedIn =
        !!account &&
        ec.user.internalLoginUser(account.username) === true &&
        ec.user.userId === account.userId
    try {
        if (!signedIn) {
            ec.message.clearErrors()
            fail('Unauthorized', 'accessDenied: That account cannot sign in now')
        }
        return work()
    } finally {
        if (signedIn || ec.user.username !== previous) {
            // who was signed in again; when that account cannot sign in now, nobody (never the borrowed account)
            if (!previous) ec.user.logoutLocal()
            else if (previous !== ec.user.username) {
                // a refused sign-in's message is not the work's
                ec.message.pushErrors()
                let back = false
                try {
                    back = ec.user.internalLoginUser(previous) === true && ec.user.username === previous
                } finally {
                    ec.message.clearErrors()
                    ec.message.popErrors()
                }
                if (!back) ec.user.logoutLocal()
            }
        }
    }
}
/* Takes up to wanted of a party's day's allowance of a counter (a key of TRUST_EFFECTS and of dailyCounts) at its trust
   level in the site, and counts what it took: how many it may have now (0 when the day's allowance is spent). The
   member's row is locked. */
function takeDaily(siteId, partyId, counter, wanted) {
    const m = memberStateFor(siteId, partyId)
    const effects = TRUST_EFFECTS[m.trustLevel] || TRUST_EFFECTS.new
    const day = dayKey(),
        same = m.dayKey === day,
        counts = same ? json(m.dailyCounts, {}) : {}
    const taken = Math.max(
        0,
        Math.min(
            Number(wanted) || 0,
            Number(effects[counter] || 0) - Number(counts[counter] || 0),
        ),
    )
    if (!taken) return 0
    counts[counter] = Number(counts[counter] || 0) + taken
    update(m, {
        dayKey: day,
        dailyTopics: same ? Number(m.dailyTopics || 0) : 0,
        dailyReplies: same ? Number(m.dailyReplies || 0) : 0,
        dailyCounts: JSON.stringify(counts),
        revision: Number(m.revision) + 1,
    })
    return taken
}
/* What the apps that keep records answer for a review item that is theirs: a target of their own type (a repository, a
   group) or a held message. Each asks every scope module and takes the first answer that is not null. */
const TARGET_TYPES = ['repository', 'group']
function scopeAnswer(name, ...args) {
    for (const scope of scopes()) {
        const out = scope[name] ? scope[name](...args) : null
        if (out != null) return out
    }
    return null
}
const heldMail = (r) =>
    r.targetType === 'mail'
        ? one(F + 'ForumHeldMail', { heldId: r.targetId })
        : null
/* Whether the caller reads and decides a review item of an app's target or of a held message: true or false; null for an
   item that is the forum's own, whose staff decide it. A report on a repository or a group is its scope's Owners' above
   it and the site's staff's; a held report is the Owners' of its repository alone. */
function reviewScoped(r) {
    if (TARGET_TYPES.includes(r.targetType))
        return !!scopeAnswer('targetModerator', r.targetType, r.targetId, me())
    const held = heldMail(r)
    if (held && held.targetType !== 'category')
        return !!scopeAnswer('heldReadable', held, me())
    return null
}
/* The scope categories of the records a party owns without being staff of them as categories (a personal repository's,
   a repository whose Owner is not its group's): where its own review queue is. */
const recordScopes = (siteId, actor = me()) => [
    ...new Set(scopes().flatMap((scope) => scope.ownedScopes(siteId, actor))),
]
/* Whether a record's posts may be sent to the classifier: never a confidential one's. */
const classifiable = (rootCommEventId) =>
    one(F + 'ForumTopic', { rootCommEventId })?.kind !== 'record' ||
    !scopes().some((scope) => scope.confidential(rootCommEventId))
/* The Owners of a confidential record, who are told of each of its posts whatever they watch. */
const recordOwners = (rootCommEventId) =>
    scopes().flatMap((scope) => scope.recordOwners(rootCommEventId))
/* The page of a record (its path under the app's mount, its title and its mail's list id), for mail and notices. */
function recordPage(rootCommEventId, actor) {
    for (const scope of scopes()) {
        const page = scope.recordPage(rootCommEventId, actor)
        if (page) return page
    }
    return null
}
/* A record post's text as one reader sees it: its references linked where the reader may see their target. */
function recordText(html, rootCommEventId) {
    for (const scope of scopes()) {
        const out = scope.linkText(html, rootCommEventId)
        if (out != null) return out
    }
    return html
}
/* Whether a party may stage a file for a page's commit to a repository an app keeps, and how large: {maxBytes}, or
   {refusal} for one who views it and may not write; null when no app keeps the repository for that party to view. */
function recordUpload(siteId, repositoryId, actor = me()) {
    for (const scope of scopes()) {
        const out = scope.fileUpload ? scope.fileUpload(siteId, repositoryId, actor) : null
        if (out) return out
    }
    return null
}
/* The first post of a record changed: its app keeps what it copies of the text. */
function recordChanged(rootCommEventId) {
    for (const scope of scopes()) scope.postChanged(rootCommEventId)
}
const notForRecord = () =>
    invalid(
        'This is not available for the conversation of an issue or a merge request',
    )
function recordTopic(t) {
    const event = one(E + 'CommunicationEvent', {
        communicationEventId: t.rootCommEventId,
    })
    const a = recordAccess(t.rootCommEventId)
    if (!event || !a || !a.canRead) missing()
    const state = one(F + 'ForumPostState', {
        communicationEventId: t.rootCommEventId,
    })
    // A held first post is its author's and the record's moderators' until it is approved.
    if (
        state &&
        state.visibility !== 'approved' &&
        event.fromPartyId !== me() &&
        !a.canModerate
    )
        missing()
    return { t, event, a }
}
/* Who decides a review item: for a post of a record its moderators by recordAccess (the Owners alone for a confidential
   one), never the category's or the site's staff by that alone; for anything else staff(). */
function reviewRecord(r) {
    if (r.targetType !== 'post') return null
    const st = one(F + 'ForumPostState', { communicationEventId: r.targetId })
    const t = st
        ? one(F + 'ForumTopic', { rootCommEventId: st.rootCommEventId })
        : null
    return t?.kind === 'record' ? t : null
}
function reviewStaff(siteId, r) {
    const scoped = reviewScoped(r)
    if (scoped != null) {
        if (!scoped) fail('Unauthorized', 'Scoped moderator access required')
        return null
    }
    const t = reviewRecord(r)
    if (!t) return staff(siteId, r.contactListId)
    if (!reviewReadable(r, t))
        fail('Unauthorized', 'Scoped moderator access required')
    return null
}
/* A review item on a post of a record is its moderators' who may also read that post: a staff post's item, with its
   text and its reports' evidence, is its Owners' alone. */
const reviewReadable = (r, t) =>
    !!recordAccess(t.rootCommEventId)?.canModerate && postAccess(r.targetId)
/* ---- The post gate (mr-pass plan/design-smithy.md §12.2): who writes, the scope, the kind, the text -> allow, hold
   for review, or refuse. publishPost, updatePost, mail in (through publishPost) and every Smithy write of public text
   call it, and gateCommit after the write. ---- */
const TRUST_EFFECTS = {
    new: {
        topics: 3,
        replies: 10,
        links: 2,
        images: 1,
        mentions: 2,
        issue: 3,
        mergeRequest: 2,
        fork: 2,
        repository: 1,
        pipelineRun: 5,
        invitation: 20,
        listInvitation: 50,
        uploads: 10,
    },
    basic: {
        topics: 10,
        replies: 50,
        links: 10,
        images: 10,
        mentions: 5,
        issue: 10,
        mergeRequest: 10,
        fork: 5,
        repository: 3,
        pipelineRun: 20,
        invitation: 100,
        listInvitation: 200,
        uploads: 50,
    },
    member: {
        topics: 20,
        replies: 100,
        links: 20,
        images: 20,
        mentions: 10,
        issue: 20,
        mergeRequest: 20,
        fork: 20,
        repository: 10,
        pipelineRun: 50,
        invitation: 300,
        listInvitation: 500,
        uploads: 200,
    },
    regular: {
        topics: 20,
        replies: 100,
        links: 20,
        images: 20,
        mentions: 10,
        issue: 20,
        mergeRequest: 20,
        fork: 20,
        repository: 10,
        pipelineRun: 50,
        invitation: 500,
        listInvitation: 1000,
        uploads: 400,
    },
}
/* The day's counter of a kind. A name kind (a fork, a repository, a group, a pipeline run) is counted only when the
   gate is asked for a new one (create), never for an edit of a name or a description. */
const GATE_COUNTERS = {
    topic: 'topics',
    reply: 'replies',
    comment: 'replies',
    review: 'replies',
    reviewComment: 'replies',
    issue: 'issue',
    mergeRequest: 'mergeRequest',
    fork: 'fork',
    repository: 'repository',
    group: 'repository',
    pipelineRun: 'pipelineRun',
}
/* A name's text (a group's or repository's name and description, a label, a milestone) is not kept pending: it passes
   the address, the sanctions, the length and the rules, and a rule that would hold it refuses it. */
const NAME_KINDS = ['repository', 'group', 'fork', 'pipelineRun']
const mentionHandles = (html) => [
    ...new Set(
        Array.from(
            plainText(html).matchAll(/(?:^|[^\w@.])@([A-Za-z0-9_.-]{2,40})/g),
        ).map((m) => m[1].toLowerCase()),
    ),
]
function applyRules(siteId, contactListId, html) {
    const text = plainText(html) + ' ' + String(html),
        out = { block: null, approve: false, flag: false, body: html }
    for (const r of Array.from(
        find(F + 'ForumRule', { siteId, enabled: 'Y' })
            .orderBy('priority,ruleId')
            .limit(200)
            .list(),
    )) {
        if (r.contactListId && r.contactListId !== contactListId) continue
        let re
        try {
            re = ruleRegex(r)
        } catch (e) {
            ec.logger.error('Forum rule ' + r.ruleId + ' is invalid; skipped')
            continue
        }
        if (!re.test(r.action === 'censor' ? plainText(out.body) : text))
            continue
        if (r.action === 'block') out.block = r
        else if (r.action === 'approve') out.approve = true
        else if (r.action === 'flag') out.flag = true
        else if (r.action === 'censor') out.body = censor(out.body, re)
    }
    return out
}
const SOURCE_FORMATS = ['html', 'markdown']
/* The authoring format of a revision: rich text (html) unless Markdown is named. */
function sourceFormatOf(value) {
    if (value == null || value === '') return 'html'
    if (!SOURCE_FORMATS.includes(value))
        invalid('sourceFormat must be html or markdown')
    return value
}
/* A revision's source as the cleaned HTML that is stored and shown: Markdown is rendered (CommonMark, fenced code as
   code) and then cleaned exactly as rich text is. */
const renderSource = (format, text, siteId) =>
    memberHtml(
        format === 'markdown'
            ? ec.resource.markdownHtml(String(text || ''))
            : text,
        siteId,
    )
function confirmedParty(partyId) {
    const confirmed = ec.resource.script(
        'component://mr-mantle/service/mantle/public/ConfirmedAddress.js',
    )
    if (partyId && partyId === me()) return confirmed.currentConfirmed()
    return rows('moqui.security.UserAccount', { partyId }, 20).some(
        (account) =>
            account.disabled !== 'Y' && confirmed.confirmed(account.userId),
    )
}
/* g: siteId, actorPartyId, contactListId (the scope category), kind ('topic' | 'reply' | 'issue' | 'comment' |
   'mergeRequest' | 'review' | 'reviewComment' | 'fork' | 'repository' | 'group' | 'pipelineRun'), title and body (the
   cleaned text of the revision; either may be absent), source (the text as typed, for the length), sourceFormat,
   canModerate (the caller moderates the scope: limits and holds do not apply), isPrivate (no first-post hold; rules only
   block or censor, never hold or flag),
   confirmed (true: the caller has checked the address),
   slowIntervalSeconds and rootCommEventId (a reply in a topic in slow mode), mailVerdict ({spam, reason}), edit (a new
   revision of a post that is there: no interval, limit or first-post hold).
   Answers decision ('allow' | 'hold' | 'refuse'), reasonFamily (a hold's), refusal ({kind, reason, message}), body and
   title after censor rules, flag (a review item is due on an allowed post) and memberState (the locked row). */
function gate(g) {
    const actor = g.actorPartyId || me(),
        refuse = (kind, message, reason) => ({
            decision: 'refuse',
            refusal: { kind, reason: reason || null, message },
        }),
        forumKind = g.kind === 'topic' || g.kind === 'reply',
        nameKind = NAME_KINDS.includes(g.kind),
        mod = !!g.canModerate && !nameKind
    // 1. Every post needs an account with a confirmed email address (D17); confirmed: the caller has checked it. The
    // forum's own topics and replies are a member's, and the forum asks for the address when an account joins.
    if (!forumKind && g.confirmed !== true && !confirmedParty(actor))
        return refuse(
            'Unauthorized',
            'addressUnconfirmed: Confirm your email address to continue',
            'addressUnconfirmed',
        )
    // 2. A suspension in the site, or a silence in the site or the scope.
    if (sanctioned(g.siteId, actor, null, 'suspend'))
        return refuse(
            'Unauthorized',
            'accessDenied: Your account is suspended on this site',
            'accessDenied',
        )
    if (
        g.contactListId &&
        sanctioned(g.siteId, actor, g.contactListId, 'suspend')
    )
        return refuse(
            'Unauthorized',
            'accessDenied: Your account is suspended here',
            'accessDenied',
        )
    if (sanctioned(g.siteId, actor, g.contactListId || null, 'silence'))
        return refuse(
            'Unauthorized',
            'accessDenied: Your account may not post on this site',
            'accessDenied',
        )
    const pol = policy(g.siteId)
    // 5 (its first half comes first, as publishPost had it): the length of the text and of a title.
    if (g.body !== undefined) {
        const source = g.source !== undefined ? g.source : g.body
        if (
            !String(source || '').trim() ||
            String(source).length > pol.maxPostLength
        )
            return refuse(
                'Unprocessable',
                'Body must contain 1–' + pol.maxPostLength + ' characters',
            )
    }
    if (g.title !== undefined && (!g.title || String(g.title).length > 250))
        return refuse(
            'Unprocessable',
            'A title of at most 250 characters is required',
        )
    const counter = GATE_COUNTERS[g.kind] || null
    const limited = !nameKind && !g.edit
    // a new fork, repository, group or pipeline run: the day's limit of its kind, and nothing else of a post's
    const created = nameKind && g.create === true && !g.canModerate
    const memberState =
        limited || created ? memberStateFor(g.siteId, actor) : null
    const effects =
        TRUST_EFFECTS[memberState?.trustLevel || trustLevel(g.siteId, actor)] ||
        TRUST_EFFECTS.new
    if (limited) {
        // 3. The interval between posts, which the forum asks of its moderators too, and a topic's slow mode.
        if (
            (forumKind || !mod) &&
            memberState.lastPostedAt &&
            millis(now()) - millis(memberState.lastPostedAt) <
                pol.postIntervalSeconds * 1000
        )
            return refuse(
                'Tarpit',
                'Wait ' + pol.postIntervalSeconds + ' seconds between posts',
            )
        const slow = Number(g.slowIntervalSeconds || 0)
        if (slow > 0 && !mod && g.rootCommEventId) {
            const last = Array.from(
                find(F + 'ForumPostSearch', {
                    rootCommEventId: g.rootCommEventId,
                    fromPartyId: actor,
                })
                    .orderBy('-entryDate')
                    .limit(1)
                    .list(),
            )[0]
            if (last && millis(now()) - millis(last.entryDate) < slow * 1000)
                return refuse(
                    'Tarpit',
                    'This topic is in slow mode; wait ' +
                        slow +
                        ' seconds between replies',
                )
        }
        // 4. The day's limit for the kind at the actor's trust level.
        if (counter && !mod) {
            const day = dayKey(),
                same = memberState.dayKey === day,
                daily = !same
                    ? 0
                    : counter === 'topics'
                      ? Number(memberState.dailyTopics)
                      : counter === 'replies'
                        ? Number(memberState.dailyReplies)
                        : Number(json(memberState.dailyCounts, {})[counter] || 0)
            if (daily >= effects[counter])
                return refuse(
                    'Tarpit',
                    forumKind
                        ? 'Daily contribution limit reached'
                        : 'limitReached: Daily contribution limit reached',
                    forumKind ? null : 'limitReached',
                )
        }
    }
    if (created) {
        const daily =
            memberState.dayKey === dayKey()
                ? Number(json(memberState.dailyCounts, {})[counter] || 0)
                : 0
        if (daily >= effects[counter])
            return refuse(
                'Tarpit',
                'limitReached: Daily limit reached; try again tomorrow',
                'limitReached',
            )
    }
    // 5. The links, images and mentions the trust level allows.
    // An edit is counted as a new post is, so a post is not approved first and filled with links after.
    let body = g.body
    if (!nameKind && !mod && body != null) {
        const count = (pattern) => (body.match(pattern) || []).length
        if (
            count(/<a\b/gi) > effects.links ||
            count(/<img\b/gi) > effects.images ||
            mentionHandles(body).length > effects.mentions
        )
            return refuse(
                'Unprocessable',
                'Your trust level allows ' +
                    effects.links +
                    ' links, ' +
                    effects.images +
                    ' images and ' +
                    effects.mentions +
                    ' mentions per post',
            )
    }
    // 6. The rules, on the body and (but for the forum's own topics, whose titles they never read) on the title.
    let title = g.title,
        approve = false,
        flag = false
    const blocked = nameKind
        ? "The site's rules do not allow that text"
        : 'This post contains content the community does not allow'
    if (body != null) {
        const ruled = applyRules(g.siteId, g.contactListId || null, body)
        if (ruled.block && (!mod || nameKind))
            return refuse('Unprocessable', blocked)
        body = ruled.body
        approve = ruled.approve
        flag = ruled.flag
    }
    if (title != null && title !== '' && !forumKind) {
        const ruled = applyRules(g.siteId, g.contactListId || null, title)
        if (ruled.block && (!mod || nameKind))
            return refuse('Unprocessable', blocked)
        title = ruled.body
        approve = approve || ruled.approve
        flag = flag || ruled.flag
    }
    // A private message reaches staff only through a participant's report (SEC-PFS-83): on it a rule blocks or censors,
    // and one that would hold or flag it files no review item.
    if (g.isPrivate) {
        approve = false
        flag = false
    }
    if (nameKind) {
        if (approve)
            return refuse(
                'Unprocessable',
                "The site's rules do not allow that text",
            )
        return {
            decision: 'allow',
            body,
            title,
            flag: false,
            ...(created ? { memberState, counter, countOnly: true } : {}),
        }
    }
    // A new revision keeps the post's visibility. In the forum a rule that would hold or flag it files a review item,
    // as updatePost always did; anywhere else a rule that would hold the text refuses the edit, so nothing a rule holds
    // replaces what is published.
    if (g.edit && approve && !mod && !forumKind)
        return refuse(
            'Unprocessable',
            "The site's rules hold this text for review; it cannot replace what is published",
        )
    if (g.edit)
        return {
            decision: 'allow',
            body,
            title,
            flag: (approve || flag) && !mod,
        }
    // 7, 8. A rule's hold, the mail gateway's verdict, and the first contributions of an account in the site.
    const firstPost =
            !g.isPrivate &&
            !mod &&
            Number(memberState.approvedContributions || 0) <
                pol.firstContributionCount,
        ruleHold = !g.isPrivate && approve && !mod,
        // a private post is held for spam too, with no review item (publishPost, SEC-PFS-83)
        spam = !!g.mailVerdict?.spam && !mod
    if (firstPost || ruleHold || spam)
        return {
            decision: 'hold',
            // what mail the gateway marked as spam is held as that, whatever else would hold it
            reasonFamily: spam
                ? 'mail-verdict'
                : firstPost
                  ? 'first-post'
                  : 'rule',
            body,
            title,
            flag: false,
            memberState,
            counter,
        }
    return {
        decision: 'allow',
        body,
        title,
        flag,
        memberState,
        counter,
    }
}
/* After the write a gate allowed or held: the time of the post, the day's counter of its kind and, for one that is
   not pending, the approved contributions that trust and the first-post hold read. */
function gateCommit(result, { pending } = {}) {
    const m = result?.memberState
    if (!m) return
    const day = dayKey(),
        same = m.dayKey === day,
        counter = result.counter,
        counts = same ? json(m.dailyCounts, {}) : {}
    if (counter && !['topics', 'replies'].includes(counter))
        counts[counter] = Number(counts[counter] || 0) + 1
    // a new fork, repository or run is no post: its day's counter alone
    if (result.countOnly) {
        update(m, {
            dayKey: day,
            dailyTopics: same ? Number(m.dailyTopics || 0) : 0,
            dailyReplies: same ? Number(m.dailyReplies || 0) : 0,
            dailyCounts: JSON.stringify(counts),
            revision: Number(m.revision) + 1,
        })
        return
    }
    update(m, {
        lastPostedAt: now(),
        approvedContributions:
            Number(m.approvedContributions || 0) + (pending ? 0 : 1),
        dayKey: day,
        dailyTopics:
            (same ? Number(m.dailyTopics || 0) : 0) +
            (counter === 'topics' ? 1 : 0),
        dailyReplies:
            (same ? Number(m.dailyReplies || 0) : 0) +
            (counter === 'replies' ? 1 : 0),
        dailyCounts: Object.keys(counts).length ? JSON.stringify(counts) : null,
        revision: Number(m.revision) + 1,
    })
}
/* Refuses as a gate's refusal says. */
function gateRefuse(result) {
    if (result.decision === 'refuse')
        fail(result.refusal.kind, result.refusal.message)
    return result
}
/* The types a post's file may have, all inert (no script or style a page could load), and the name it is kept by: an
   upload's (stageAttachment) and an imported one's (ForumImport) alike, so no file is served as anything else. */
const ATTACHMENT_TYPES = [
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/pdf',
    'text/plain',
]
const attachmentName = (name) =>
    String(name || 'attachment')
        .replace(/[^a-zA-Z0-9._ -]/g, '_')
        .slice(0, 100)
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
    fieldMailbox,
    fieldAddressCount,
    nameShowsOtherAddress,
    readAuthResults,
    gatewayAuthenticated,
    listenerAuthservIds,
    providerAuthservIds,
    now,
    millis,
    dayKey,
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
    memberHtml,
    categoryChain,
    categorySubtree,
    routeAddress,
    scopeView,
    audience,
    forumPath,
    forumUrl,
    asUser,
    takeDaily,
    scopeChanged,
    scopeAnswer,
    heldMail,
    ATTACHMENT_TYPES,
    attachmentName,
    reviewScoped,
    TARGET_TYPES,
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
    recordAccess,
    postAccess,
    scopeOwner,
    classifiable,
    recordPage,
    recordOwners,
    recordText,
    recordUpload,
    recordTopic,
    recordChanged,
    notForRecord,
    reviewRecord,
    reviewStaff,
    reviewReadable,
    recordScopes,
    TRUST_EFFECTS,
    mentionHandles,
    applyRules,
    sourceFormatOf,
    renderSource,
    gate,
    gateCommit,
    gateRefuse,
})
