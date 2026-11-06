/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Shared authority implementation. Only allow-listed service wrappers invoke execute().
 * Shared primitives and access live in ForumCore.js, staff areas in ForumModeration.js.
 * Entity access is privileged here; every object projection passes current domain policy first.
 */
const core = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumCore.js',
)
const {
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
    withAccessMemo,
    categoryAccess,
    category,
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
    refreshReviews,
    staff,
    allocateInternal,
    internalParty,
    plainText,
    softDelete,
    trustRank,
    policy,
    ruleRegex,
    censor,
    memberStateFor,
    queueClassification,
    memberBlocks,
    conversationAccess,
} = core
const capabilities = (a) =>
    pick(
        a,
        'canDiscover canRead canStartTopic canReply canEdit canUpload canFlag canReact canVote canModerate canInvite',
    )
/* The decorative part of a topic URL; the ID before it is what resolves. */
const slugify = (title) =>
    String(title || 'topic')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'topic'
/* Authors edit for a day; a wiki post is open to basic-or-higher members who may write in the category. */
function canEditPost(state, event, a) {
    if (a.canModerate) return true
    if (!a.canEdit || state.visibility === 'deleted') return false
    if (
        event.fromPartyId === me() &&
        millis(now()) - millis(event.entryDate) <=
            editWindowMs(a.category.siteId)
    )
        return true
    return (
        state.wiki === 'Y' &&
        state.visibility === 'approved' &&
        trustLevel(a.category.siteId) !== 'new'
    )
}
function postProjection(state, event, a, t) {
    if (!postVisible(state, event, a)) return null
    const profile = one(S + 'PublicSiteProfile', {
        siteId: a.category.siteId,
        partyId: event.fromPartyId,
    })
    const deleted = state.visibility === 'deleted'
    return {
        postId: event.communicationEventId,
        rootCommEventId: state.rootCommEventId,
        ordinal: Number(state.ordinal),
        revision: Number(state.revision),
        author: pick(profile, 'handle displayName avatarId'),
        entryDate: event.entryDate,
        body: deleted ? '' : StringUtilities.cleanHtml(event.body || ''),
        visibility: state.visibility,
        parentCommEventId: event.parentCommEventId || null,
        wiki: state.wiki === 'Y',
        accepted: !!t && t.acceptedAnswerId === event.communicationEventId,
        hasHistory: Number(state.revision) > 1,
        reactions: deleted ? {} : json(state.reactionCounts, {}),
        myReactions:
            deleted || !me()
                ? []
                : rows(
                      F + 'ForumReaction',
                      {
                          communicationEventId: event.communicationEventId,
                          partyId: me(),
                      },
                      20,
                  ).map((v) => v.reactionKey),
        pollId: deleted
            ? null
            : one(F + 'ForumPoll', {
                  communicationEventId: event.communicationEventId,
              })?.pollId || null,
        capabilities: {
            ...capabilities(a),
            canEdit: canEditPost(state, event, a),
            canReact:
                a.canReact &&
                !deleted &&
                state.visibility === 'approved' &&
                event.fromPartyId !== me(),
            canDelete:
                !deleted &&
                state.rootCommEventId !== event.communicationEventId &&
                (a.canModerate ||
                    (event.fromPartyId === me() &&
                        millis(now()) - millis(event.entryDate) <=
                            editWindowMs(a.category.siteId))),
        },
        attachments: deleted
            ? []
            : rows(
                  F + 'ForumAttachment',
                  {
                      communicationEventId: event.communicationEventId,
                      scanState: 'clean',
                  },
                  100,
              ).map((v) =>
                  pick(v, 'attachmentId filename mimeType byteSize altText'),
              ),
    }
}
function ensureParty() {
    const ua = ec.user.userAccount
    if (!ua) fail('AuthenticationRequired', 'Sign in to join')
    if (ua.partyId) return ua.partyId
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        fail('Unauthorized', 'Verify your email before joining')
    const account = one(
        'moqui.security.UserAccount',
        { userId: ua.userId },
        true,
    )
    if (account.partyId) return account.partyId
    const person = ec.service
        .sync()
        .throwOnError(true)
        .name('mantle.party.PartyServices.create#Person')
        .parameters({ firstName: 'Community member' })
        .call()
    if (!person.partyId)
        fail('Unavailable', 'Account membership is not available')
    update(account, { partyId: person.partyId })
    return person.partyId
}
function readingBoundary(root, siteId, contactListId) {
    const partyId = me()
    if (!partyId) return null
    const marker = one(F + 'ForumTopicUser', { rootCommEventId: root, partyId })
    if (marker)
        return pick(
            marker,
            'consumedOrdinal highestSeenOrdinal markerRevision unreadBoundary',
        )
    const joined =
        listMember(contactListId, partyId)?.fromDate ||
        member(siteId, partyId)?.joinedAt
    const boundary = joined
        ? Array.from(
              find(F + 'ForumPostSearch', {
                  rootCommEventId: root,
                  visibility: 'approved',
              })
                  .condition('entryDate', 'less-equals', joined)
                  .orderBy('-ordinal')
                  .limit(1)
                  .list(),
          )[0]
        : null
    return {
        consumedOrdinal: Number(boundary?.ordinal || 0),
        highestSeenOrdinal: 0,
        markerRevision: 0,
        unreadBoundary: null,
    }
}

const methods = {}
const moderation = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumModeration.js',
)(core, methods)
// The word rules, for the integration module's exact case-reply preview.
core.applyRules = applyRules
const integration = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumIntegration.js',
)(core, methods)
const operations = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumOperations.js',
)(core, methods, moderation)
ec.resource.script('component://mr-mantle/service/mantle/forum/ForumImport.js')(
    core,
    methods,
    operations,
    moderation,
)
methods.findSites = (p) => {
    if (p.siteId) site(p.siteId, true)
    const pg = page(p, 'sites:' + (p.siteId || 'operator')),
        list = []
    let offset = pg.offset,
        more = false
    for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
        const rows = Array.from(
            find(S + 'PublicSite', p.siteId ? { siteId: p.siteId } : {})
                .orderBy('siteId')
                .offset(offset)
                .limit(100)
                .list(),
        )
        for (const s of rows) {
            offset++
            const m = member(s.siteId)
            if (
                !isOperator() &&
                !(active(m) && m.state === 'active' && m.role === 'owner')
            )
                continue
            if (list.length === pg.limit) {
                more = true
                offset--
                break
            }
            list.push(
                pick(
                    s,
                    'siteId name state locale timeZone policyRevision generation',
                ),
            )
        }
        if (more || rows.length < 100) break
        if (batch === 9) more = true
    }
    return { siteList: list, nextCursor: more ? pg.next(offset) : null }
}
methods.createSite = (p) => {
    if (!isOperator()) fail('Unauthorized', 'Operator access required')
    if (
        !p.name ||
        !p.ownerPartyId ||
        !one('mantle.party.Party', { partyId: p.ownerPartyId })
    )
        invalid('Name and an existing owner party are required')
    const siteId = id()
    create(S + 'PublicSite', {
        siteId,
        name: p.name,
        state: 'disabled',
        locale: p.locale || 'en',
        timeZone: p.timeZone || 'UTC',
        registrationMode: 'closed',
        approvalRequired: 'N',
        policyRevision: 1,
        generation: 1,
    })
    create(S + 'PublicSiteParty', {
        siteId,
        partyId: p.ownerPartyId,
        state: 'active',
        role: 'owner',
        joinedAt: now(),
        revision: 1,
    })
    return { siteId, state: 'disabled', revision: 1 }
}
methods.updateSite = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    if (p.state && !['disabled', 'published'].includes(p.state))
        invalid('Invalid publication state')
    if (
        p.subscriptionUrl &&
        !/^(https:\/\/[^\s<>"]+|\/(?!\/)[^\s<>"]*)$/.test(p.subscriptionUrl)
    )
        invalid(
            'The subscription page must be an https address or a local path',
        )
    if (
        p.publishingWikiSpaceId &&
        !one('moqui.resource.wiki.WikiSpace', {
            wikiSpaceId: p.publishingWikiSpaceId,
        })
    )
        missing()
    update(s, {
        ...Object.fromEntries(
            [
                'name',
                'locale',
                'timeZone',
                'subscriptionUrl',
                'publishingWikiSpaceId',
            ]
                .filter((k) => p[k] != null)
                .map((k) => [k, p[k]]),
        ),
        ...(p.state ? { state: p.state } : {}),
        policyRevision: Number(s.policyRevision) + 1,
        generation: Number(s.generation) + 1,
    })
    return pick(s, 'siteId name state policyRevision generation')
}
methods.getMembership = (p) => {
    site(p.siteId)
    if (!ec.user.userId) fail('AuthenticationRequired', 'Sign in to continue')
    return {
        membership: pick(
            member(p.siteId),
            'state role joinedAt fromDate thruDate revision',
        ),
        entitlements: integration.memberEntitlements(p.siteId, me()),
        subscriptionUrl:
            one(S + 'PublicSite', { siteId: p.siteId })?.subscriptionUrl ||
            null,
    }
}
methods.joinSite = (p) => {
    const s = site(p.siteId)
    ensureParty()
    const partyId = requireUser()
    // A current access grant, such as a paid subscription, qualifies the party to join a site with closed registration.
    if (
        s.registrationMode !== 'open' &&
        !integration.hasSiteGrant(p.siteId, partyId)
    )
        fail('Unauthorized', 'An invitation is required')
    const ua = ec.user.userAccount
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        fail('Unauthorized', 'Verify your email before joining')
    const old = member(p.siteId)
    if (old && old.state === 'active')
        return { state: old.state, revision: Number(old.revision) }
    // Staff suspensions and removals stand until staff change them.
    if (
        old &&
        (old.state === 'suspended' ||
            (old.state === 'ended' &&
                old.stateSetByPartyId &&
                old.stateSetByPartyId !== partyId))
    )
        fail('Unauthorized', 'Joining is not permitted')
    const fields = {
        siteId: p.siteId,
        partyId,
        state: s.approvalRequired === 'Y' ? 'pending' : 'active',
        role: 'member',
        joinedAt: now(),
        stateSetByPartyId: partyId,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, fields) : create(S + 'PublicSiteParty', fields)
    if (fields.state === 'pending')
        review(p.siteId, null, 'account', partyId, fields.revision, 'account')
    return { state: fields.state, revision: fields.revision }
}
methods.leaveSite = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    site(p.siteId)
    const m = member(p.siteId, requireUser())
    if (!m) missing()
    if (m.role === 'owner') protectOwner(p.siteId, m.partyId)
    revision(m, p.expectedRevision)
    update(m, {
        state: 'ended',
        thruDate: now(),
        stateSetByPartyId: m.partyId,
        revision: Number(m.revision) + 1,
    })
    bump(p.siteId)
    return { state: 'ended' }
}
function protectListOwner(contactListId, partyId) {
    const binding = one(F + 'ForumCategory', { contactListId })
    if (!binding) return // Preserve unbound legacy mailbox ownership rules.
    one(S + 'PublicSite', { siteId: binding.siteId }, true)
    const current = listMember(contactListId, partyId)
    if (current?.roleTypeId !== 'ListOwner') return
    const replacements = rows(
        'mantle.marketing.contact.ContactListParty',
        { contactListId, statusId: 'CLPT_ACCEPTED', roleTypeId: 'ListOwner' },
        1000,
    ).some(
        (owner) =>
            owner.partyId !== partyId &&
            active(owner) &&
            active(member(binding.siteId, owner.partyId)) &&
            member(binding.siteId, owner.partyId).state === 'active' &&
            !sanctioned(
                binding.siteId,
                owner.partyId,
                contactListId,
                'suspend',
            ),
    )
    if (!replacements) invalid('Assign another active category owner first')
}
methods.setMembership = (p) => {
    site(p.siteId, true)
    const m = member(p.siteId, p.targetPartyId)
    if (!m) missing()
    revision(m, p.expectedRevision)
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (!['active', 'pending', 'suspended', 'ended'].includes(p.state))
        invalid('Invalid member state')
    if (m.role === 'owner' && p.state !== 'active')
        protectOwner(p.siteId, m.partyId)
    audit(
        p.siteId,
        null,
        'member',
        m.partyId,
        'membership',
        p.reason,
        m.revision,
        Number(m.revision) + 1,
    )
    update(m, {
        state: p.state,
        stateSetByPartyId: me(),
        revision: Number(m.revision) + 1,
    })
    bump(p.siteId)
    return { revision: Number(m.revision) }
}
methods.setSiteRole = (p) => {
    site(p.siteId, true)
    const auth = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.UserServices.login#UserAccount')
        .parameters({
            username: ec.user.userAccount.username,
            password: p.password,
            code: p.code,
        })
        .call()
    if (!auth.loggedIn)
        fail(
            'AuthenticationRequired',
            'Reauthenticate before changing site roles',
        )
    if (!['member', 'moderator', 'owner'].includes(p.role))
        invalid('Invalid role')
    const m = member(p.siteId, p.targetPartyId)
    if (!m) missing()
    revision(m, p.expectedRevision)
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (m.role === 'owner' && p.role !== 'owner')
        protectOwner(p.siteId, m.partyId)
    audit(
        p.siteId,
        null,
        'member',
        m.partyId,
        'role',
        p.reason,
        m.revision,
        Number(m.revision) + 1,
    )
    update(m, { role: p.role, revision: Number(m.revision) + 1 })
    bump(p.siteId)
    return { revision: Number(m.revision) }
}
methods.findMembers = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'members:' + p.siteId)
    const list = Array.from(
        find(S + 'PublicSiteParty', { siteId: p.siteId })
            .orderBy('partyId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        memberList: list.slice(0, pg.limit).map((m) => ({
            ...pick(m, 'partyId state role revision'),
            profile: pick(
                one(S + 'PublicSiteProfile', {
                    siteId: p.siteId,
                    partyId: m.partyId,
                }),
                'handle displayName',
            ),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.storeProfile = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    site(p.siteId)
    const partyId = requireUser()
    const membership = member(p.siteId, partyId)
    if (!membership || !['active', 'pending'].includes(membership.state))
        fail('Unauthorized', 'Join this site before setting a profile')
    if (!/^[a-z0-9][a-z0-9_-]{2,31}$/.test(p.handle || ''))
        invalid(
            'Handle must be 3–32 lowercase letters, numbers, underscores or hyphens',
        )
    if (
        !['public', 'members', 'hidden'].includes(
            p.discoverability || 'members',
        )
    )
        invalid('Invalid profile discovery')
    const old = one(
        S + 'PublicSiteProfile',
        { siteId: p.siteId, partyId },
        true,
    )
    revision({ revision: Number(old?.revision || 0) }, p.expectedRevision)
    const dup = one(S + 'PublicSiteProfile', {
        siteId: p.siteId,
        handle: p.handle,
    })
    if (dup && dup.partyId !== partyId)
        fail('Conflict', 'Handle is unavailable')
    const avatarId =
        p.avatarId === undefined ? old?.avatarId || null : p.avatarId || null
    if (avatarId && avatarId !== old?.avatarId) {
        const attachment = one(
            F + 'ForumAttachment',
            { attachmentId: avatarId },
            true,
        )
        if (
            !attachment ||
            attachment.siteId !== p.siteId ||
            attachment.ownerPartyId !== partyId ||
            attachment.purpose !== 'avatar' ||
            attachment.communicationEventId ||
            attachment.scanState !== 'clean' ||
            !String(attachment.mimeType).startsWith('image/') ||
            !attachment.expiresAt ||
            millis(attachment.expiresAt) <= millis(now())
        )
            invalid('Avatar is unavailable or has not passed scanning')
        update(attachment, { expiresAt: null, draftId: null })
    }
    if (old?.avatarId && old.avatarId !== avatarId) {
        const abandoned = one(
            F + 'ForumAttachment',
            { attachmentId: old.avatarId },
            true,
        )
        if (abandoned)
            update(abandoned, { expiresAt: millis(now()) + 7 * 86400000 })
    }
    const fields = {
        siteId: p.siteId,
        partyId,
        avatarId,
        handle: p.handle,
        displayName: String(p.displayName || p.handle).slice(0, 100),
        bio: StringUtilities.cleanHtml(p.bio || ''),
        discoverability: p.discoverability || 'members',
        locale: p.locale,
        timeZone: p.timeZone,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, fields) : create(S + 'PublicSiteProfile', fields)
    return {
        profile: pick(
            fields,
            'handle displayName avatarId bio discoverability locale timeZone revision',
        ),
    }
}
methods.getProfile = (p) => {
    site(p.siteId)
    const v = one(S + 'PublicSiteProfile', {
        siteId: p.siteId,
        handle: p.handle,
    })
    if (
        !v ||
        (v.partyId !== me() && member(p.siteId, v.partyId)?.state !== 'active')
    )
        missing()
    if (
        v.partyId !== me() &&
        v.discoverability !== 'public' &&
        !(
            v.discoverability === 'members' &&
            member(p.siteId)?.state === 'active'
        )
    )
        missing()
    return {
        profile: {
            ...pick(
                v,
                'handle displayName avatarId bio locale timeZone revision',
            ),
            ...(v.partyId === me()
                ? { discoverability: v.discoverability }
                : {}),
        },
        viewerPreference:
            me() && v.partyId !== me()
                ? one(F + 'ForumMemberPreference', {
                      siteId: p.siteId,
                      partyId: me(),
                      targetPartyId: v.partyId,
                  })?.preference || 'none'
                : null,
    }
}
methods.findCategories = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const pg = page(p, 'categories:' + p.siteId)
        const list = []
        let offset = pg.offset,
            more = false
        for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
            const candidates = Array.from(
                find(F + 'ForumCategory', { siteId: p.siteId })
                    .orderBy('sequenceNum,contactListId')
                    .offset(offset)
                    .limit(100)
                    .list(),
            )
            if (!candidates.length) break
            for (const c of candidates) {
                const a = categoryAccess(c.contactListId)
                offset++
                if (a?.canDiscover || a?.canReadOwn || a?.canModerate) {
                    if (list.length === pg.limit) {
                        more = true
                        offset--
                        break
                    }
                    list.push(categoryProjection(a))
                }
            }
            if (more || candidates.length < 100) break
        }
        return { categoryList: list, nextCursor: more ? pg.next(offset) : null }
    })
function categoryProjection(a) {
    const l = one('mantle.marketing.contact.ContactList', {
        contactListId: a.category.contactListId,
    })
    return {
        ...pick(
            a.category,
            'contactListId parentContactListId sequenceNum slug rules visibility publicationState policyRevision mode qualifyingSources',
        ),
        name: l?.contactListName || '',
        description: l?.description || '',
        capabilities: capabilities(a),
    }
}
methods.getCategory = (p) => ({
    category: categoryProjection(category(p.contactListId, p.siteId)),
})
methods.storeCategory = (p) =>
    p.contactListId
        ? storeCategory(p)
        : receipt(p, 'storeCategory', () => storeCategory(p))
function storeCategory(p) {
    site(p.siteId, true)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    let c = p.contactListId
        ? one(F + 'ForumCategory', { contactListId: p.contactListId })
        : null
    if (c && c.siteId !== p.siteId) missing()
    if (c) revision(c, p.expectedRevision)
    if (p.mode !== undefined && !['discussion', 'qa'].includes(p.mode))
        invalid('Category mode must be discussion or qa')
    if (
        c?.publicationState === 'published' &&
        p.parentContactListId !== undefined &&
        (c.parentContactListId || null) !== (p.parentContactListId || null) &&
        p.confirmAudience !== true
    )
        invalid('Confirm the parent audience preview')
    if (p.parentContactListId) {
        let parent = category(p.parentContactListId, p.siteId),
            seen = new Set([p.contactListId])
        while (parent) {
            if (seen.has(parent.category.contactListId))
                invalid('Category hierarchy cannot contain cycles')
            seen.add(parent.category.contactListId)
            parent = parent.category.parentContactListId
                ? category(parent.category.parentContactListId, p.siteId)
                : null
        }
    }
    let contactListId = p.contactListId
    if (!c) {
        const out = ec.service
            .sync()
            .throwOnError(true)
            .name('mantle.marketing.ContactListServices.create#ContactList')
            .parameters({
                contactListTypeEnumId: 'MAILBOX',
                contactListName: p.name,
                isPublic: 'N',
                postingEnumId: 'ClpMembers',
            })
            .call()
        contactListId = out.contactListId
        if (!contactListId || ec.message.hasError())
            fail('Unprocessable', 'Category could not be created')
        c = create(F + 'ForumCategory', {
            contactListId,
            siteId: p.siteId,
            publicationState: 'disabled',
            visibility: 'members',
            mode: 'discussion',
            policyRevision: 0,
        })
    }
    const l = one('mantle.marketing.contact.ContactList', { contactListId })
    if (p.name) update(l, { contactListName: p.name })
    // An omitted field keeps its value, so a rename cannot drop the parent (and its access ceiling).
    const given = (k) => p[k] !== undefined
    update(c, {
        parentContactListId: given('parentContactListId')
            ? p.parentContactListId || null
            : (c.parentContactListId ?? null),
        slug: given('slug') ? p.slug || contactListId : c.slug || contactListId,
        sequenceNum: given('sequenceNum')
            ? Number(p.sequenceNum || 0)
            : Number(c.sequenceNum || 0),
        rules: given('rules')
            ? StringUtilities.cleanHtml(p.rules || '')
            : (c.rules ?? ''),
        mode: given('mode') ? p.mode : c.mode || 'discussion',
        policyRevision: Number(c.policyRevision) + 1,
    })
    bump(p.siteId)
    return { contactListId, revision: Number(c.policyRevision) }
}
methods.previewCategoryAccess = (p) => {
    site(p.siteId, true)
    const a = category(p.contactListId, p.siteId)
    return {
        category: categoryProjection(a),
        proposedVisibility: p.visibility,
        proposedQualifyingSources: p.qualifyingSources ?? null,
        // The grants that would admit readers with the proposed sources; site grants count once sources are chosen.
        activeGrantCount: (() => {
            const chosen =
                p.qualifyingSources ??
                (a.category.qualifyingSources
                    ? String(a.category.qualifyingSources).split(',')
                    : null)
            const sources = chosen || ['manual']
            const counts = (fields) =>
                rows(S + 'PublicAccessGrant', { siteId: p.siteId, ...fields }, 10000).filter(
                    (g) => grantActive(g) && sources.includes(g.sourceType || 'manual'),
                ).length
            return (
                counts({ targetType: 'category', targetId: p.contactListId }) +
                (chosen ? counts({ targetType: 'site' }) : 0)
            )
        })(),
        topicCount: find(E + 'CommunicationEvent', {
            contactListId: p.contactListId,
        })
            .condition('rootCommEventId', null)
            .count(),
        expectedRevision: Number(a.category.policyRevision),
    }
}
methods.setCategoryAccess = (p) => {
    site(p.siteId, true)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const c = one(F + 'ForumCategory', { contactListId: p.contactListId }, true)
    if (!c || c.siteId !== p.siteId) missing()
    revision(c, p.expectedRevision)
    if (
        p.publicationState === 'published' &&
        find(F + 'ForumJobRun', { siteId: p.siteId, jobType: 'bootstrap' })
            .condition('state', 'not-equals', 'complete')
            .count() > 0
    )
        fail(
            'Conflict',
            'Reconcile mailbox tracking conversion before publication',
        )
    if (
        !['public', 'members', 'category', 'help'].includes(p.visibility) ||
        !['disabled', 'published'].includes(p.publicationState)
    )
        invalid('Invalid category access')
    if (
        p.qualifyingSources != null &&
        (!p.qualifyingSources.length ||
            p.qualifyingSources.some(
                (source) => !['manual', 'subscription'].includes(source),
            ))
    )
        invalid('Qualifying sources are manual and subscription')
    if (p.confirm !== true) invalid('Confirm the audience preview')
    update(c, {
        visibility: p.visibility,
        publicationState: p.publicationState,
        ...(p.qualifyingSources != null
            ? { qualifyingSources: [...new Set(p.qualifyingSources)].join(',') }
            : {}),
        policyRevision: Number(c.policyRevision) + 1,
    })
    bump(p.siteId)
    return { revision: Number(c.policyRevision) }
}
methods.findTopics = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        if (p.contactListId) category(p.contactListId, p.siteId)
        if (p.view && !['latest', 'new', 'unread', 'top'].includes(p.view))
            invalid('Invalid topic view')
        if (p.period && !TOP_PERIODS[p.period]) invalid('Invalid period')
        if (p.solved && !['Y', 'N'].includes(p.solved))
            invalid('Invalid solved filter')
        const tag = p.tag ? resolveTag(p.siteId, p.tag) : null
        // A member's activity: only when their profile is visible to this reader (getProfile conceals otherwise).
        const authorPartyId = p.authorHandle
            ? (methods.getProfile({ siteId: p.siteId, handle: p.authorHandle }),
              one(S + 'PublicSiteProfile', {
                  siteId: p.siteId,
                  handle: p.authorHandle,
              }).partyId)
            : null
        if (['new', 'unread'].includes(p.view)) requireUser()
        const pg = page(
                p,
                'topics:' +
                    p.siteId +
                    ':' +
                    (p.contactListId || '') +
                    ':' +
                    (p.query || '') +
                    ':' +
                    (p.view || 'latest') +
                    ':' +
                    (p.authorHandle || '') +
                    ':' +
                    (tag?.tagId || '') +
                    ':' +
                    (p.solved || '') +
                    ':' +
                    (p.period || ''),
            ),
            list = []
        let offset = pg.offset,
            more = false
        // Work is capped even when most candidates are concealed. Cursor advances over the inspected window.
        for (let batch = 0; batch < 10 && list.length <= pg.limit; batch++) {
            let q = find(tag ? F + 'ForumTaggedTopic' : F + 'ForumTopic', {
                siteId: p.siteId,
                kind: 'category',
                ...(p.contactListId ? { contactListId: p.contactListId } : {}),
                ...(tag ? { tagId: tag.tagId } : {}),
            })
            if (p.solved)
                q = q.condition(
                    'acceptedAnswerId',
                    p.solved === 'Y' ? 'not-equals' : 'equals',
                    null,
                )
            if (p.view === 'top' && p.period && p.period !== 'all')
                q = q.condition(
                    'lastActivity',
                    'greater-equals',
                    stamp(millis(now()) - TOP_PERIODS[p.period]),
                )
            const candidates = Array.from(
                q
                    .orderBy(
                        p.view === 'top'
                            ? '-reactionCount,-visiblePostCount,rootCommEventId'
                            : '-lastActivity,rootCommEventId',
                    )
                    .offset(offset)
                    .limit(100)
                    .list(),
            )
            if (!candidates.length) break
            for (const t of candidates) {
                offset++
                let out
                try {
                    out = topic(t.rootCommEventId, p.siteId)
                } catch (e) {
                    if (e.moquiErrorKind === 'NotFound') continue
                    throw e
                }
                const { event, a } = out
                if (
                    (p.contactListId &&
                        event.contactListId !== p.contactListId) ||
                    (authorPartyId && event.fromPartyId !== authorPartyId) ||
                    (t.unlisted === 'Y' && !a.canModerate) ||
                    (p.query &&
                        !String(event.subject || '')
                            .toLowerCase()
                            .includes(String(p.query).toLowerCase()))
                )
                    continue
                const marker = readingBoundary(
                    t.rootCommEventId,
                    p.siteId,
                    event.contactListId,
                )
                const unreadCount = marker
                    ? find(F + 'ForumPostSearch', {
                          rootCommEventId: t.rootCommEventId,
                          visibility: 'approved',
                      })
                          .condition(
                              'ordinal',
                              'greater',
                              Number(marker.consumedOrdinal || 0),
                          )
                          .condition('fromPartyId', 'not-equals', me())
                          .count()
                    : null
                if (
                    (p.view === 'unread' && !unreadCount) ||
                    (p.view === 'new' &&
                        (one(F + 'ForumTopicUser', {
                            rootCommEventId: t.rootCommEventId,
                            partyId: me(),
                        }) ||
                            millis(event.entryDate) <=
                                millis(member(p.siteId)?.joinedAt)))
                )
                    continue
                if (list.length === pg.limit) {
                    more = true
                    offset--
                    break
                }
                list.push({
                    unreadCount,
                    ...pick(
                        t,
                        'rootCommEventId revision pinned lastActivity visiblePostCount reactionCount',
                    ),
                    solved: !!visibleAnswer(t, a),
                    tags: topicTags(t.rootCommEventId),
                    title: event.subject,
                    category: categoryProjection(a),
                    capabilities: capabilities(a),
                })
            }
            if (more || candidates.length < 100) break
            if (batch === 9) more = true
        }
        return { topicList: list, nextCursor: more ? pg.next(offset) : null }
    })
methods.getTopic = (p) => {
    // A merged topic's old ID resolves to its destination after the destination's own access check.
    if (!one(F + 'ForumTopic', { rootCommEventId: p.rootCommEventId })) {
        const alias = one(F + 'ForumPermalink', {
            oldRootCommEventId: p.rootCommEventId,
        })
        if (alias && alias.siteId === p.siteId)
            return {
                topic: {
                    ...methods.getTopic({
                        siteId: p.siteId,
                        rootCommEventId: alias.targetRootCommEventId,
                    }).topic,
                    movedFrom: p.rootCommEventId,
                },
            }
    }
    const { t, event, a } = topic(p.rootCommEventId, p.siteId)
    return {
        topic: {
            ...pick(
                t,
                'rootCommEventId revision pinned unlisted slowIntervalSeconds visiblePostCount lastActivity',
            ),
            timers: a.canModerate
                ? rows(
                      F + 'ForumTopicTimer',
                      { rootCommEventId: t.rootCommEventId, state: 'pending' },
                      10,
                  ).map((v) => pick(v, 'timerId action dueAt reason'))
                : [],
            marker: readingBoundary(
                t.rootCommEventId,
                p.siteId,
                event.contactListId,
            ),
            title: event.subject,
            slug: slugify(event.subject),
            closed: event.statusId === 'CeResolved',
            acceptedAnswerId: visibleAnswer(t, a),
            tags: topicTags(t.rootCommEventId),
            kind: t.kind,
            participants:
                t.kind === 'private'
                    ? participantProjection(p.siteId, t.rootCommEventId)
                    : null,
            category: t.kind === 'private' ? null : categoryProjection(a),
            capabilities: {
                ...capabilities(a),
                canReply: a.canReply && event.statusId !== 'CeResolved',
                canManageParticipants: t.kind === 'private' && a.isOwner,
                canAccept:
                    a.category.mode === 'qa' &&
                    (a.canModerate ||
                        (event.fromPartyId === me() && a.canReply)),
            },
        },
    }
}
methods.getPosts = (p) => {
    const { t, a } = topic(p.rootCommEventId, p.siteId)
    const scope =
            'posts:' +
            p.siteId +
            ':' +
            t.rootCommEventId +
            ':' +
            (p.around || '') +
            ':' +
            (p.before || '') +
            ':' +
            (p.after || ''),
        pg = page(p, scope)
    const visiblePosts = () => {
        const q = find(F + 'ForumPostSearch', {
            rootCommEventId: t.rootCommEventId,
        })
        if (a.canModerate) return q
        const cf = ec.entity.conditionFactory
        return q.condition(
            cf.makeCondition(
                [
                    cf.makeCondition('visibility', 'equals', 'approved'),
                    cf.makeCondition(
                        'fromPartyId',
                        'equals',
                        me() || '_ANONYMOUS_',
                    ),
                ],
                'or',
            ),
        )
    }
    let q = visiblePosts()
    if (p.around) {
        if (p.before != null || p.after != null)
            invalid('Use one post window locator')
        const target = one(F + 'ForumPostState', {
                communicationEventId: p.around,
                rootCommEventId: t.rootCommEventId,
            }),
            event = one(E + 'CommunicationEvent', {
                communicationEventId: p.around,
            })
        if (!target || !event || !postVisible(target, event, a)) missing()
        // Start a few visible posts before the target so it reads in context; stable ordinals make this one query.
        const earlier = Array.from(
            visiblePosts()
                .condition('ordinal', 'less', Number(target.ordinal))
                .orderBy('-ordinal')
                .limit(Math.min(5, Math.floor(pg.limit / 3)))
                .list(),
        )
        const start = earlier.length
            ? Number(earlier[earlier.length - 1].ordinal)
            : Number(target.ordinal)
        q = q.condition('ordinal', 'greater-equals', start)
    }
    for (const key of ['before', 'after'])
        if (p[key] != null) {
            if (!Number.isInteger(Number(p[key])) || Number(p[key]) < 1)
                invalid('Invalid ordinal')
            q = q.condition(
                'ordinal',
                key === 'after' ? 'greater' : 'less',
                Number(p[key]),
            )
        }
    if (pg.offset)
        q = q.condition(
            'ordinal',
            p.before != null ? 'less' : 'greater',
            pg.offset,
        )
    const list = [],
        candidates = Array.from(
            q
                .orderBy(p.before != null ? '-ordinal' : 'ordinal')
                .limit(pg.limit + 1)
                .list(),
        )
    const window = candidates.slice(0, pg.limit)
    if (p.before != null) window.reverse()
    for (const st of window) {
        const event = one(E + 'CommunicationEvent', {
            communicationEventId: st.communicationEventId,
        })
        if (event) {
            const out = postProjection(st, event, a, t)
            if (out) list.push(out)
        }
    }
    return {
        postList: list,
        nextCursor:
            candidates.length > pg.limit
                ? pg.next(Number(candidates[pg.limit - 1].ordinal))
                : null,
        revision: Number(t.revision),
        generation: Number(a.site.generation),
    }
}
methods.storeDraft = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        old = p.draftId ? one(F + 'ForumDraft', { draftId: p.draftId }) : null
    if (old && (old.siteId !== p.siteId || old.partyId !== partyId)) missing()
    if (p.draftId && !/^[A-Za-z0-9_-]{8,40}$/.test(p.draftId))
        invalid('Invalid draft ID')
    if (!old && Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Draft changed; reload and compare')
    if (p.poll && JSON.stringify(p.poll).length > 20000)
        invalid('The poll draft is too large')
    if (old) revision(old, p.expectedRevision)
    if (p.contactListId) category(p.contactListId, p.siteId)
    if (p.rootCommEventId) topic(p.rootCommEventId, p.siteId)
    const fields = {
        draftId: old?.draftId || p.draftId || id(),
        siteId: p.siteId,
        partyId,
        mode: p.mode || 'new',
        contactListId: p.contactListId,
        rootCommEventId: p.rootCommEventId,
        parentCommEventId: p.parentCommEventId,
        postId: p.postId || null,
        postRevision: p.postRevision || null,
        title: p.title || '',
        sourceText: p.body || '',
        sourceFormat: 'html',
        tagsJson: p.tags ? JSON.stringify(p.tags) : null,
        // A draft keeps an unfinished poll as typed; publishing validates it.
        pollJson: p.poll ? JSON.stringify(p.poll) : null,
        revision: Number(old?.revision || 0) + 1,
        updatedAt: now(),
    }
    old ? update(old, fields) : create(F + 'ForumDraft', fields)
    return { draftId: fields.draftId, revision: fields.revision }
}
methods.findDrafts = (p) => {
    site(p.siteId)
    const pg = page(p, 'drafts:' + p.siteId)
    const list = Array.from(
        find(F + 'ForumDraft', { siteId: p.siteId, partyId: requireUser() })
            .orderBy('-updatedAt,draftId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        draftList: list.slice(0, pg.limit).map((d) => ({
            ...pick(
                d,
                'draftId mode contactListId rootCommEventId parentCommEventId postId postRevision title revision updatedAt',
            ),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.discardDraft = (p) => {
    site(p.siteId)
    const d = one(F + 'ForumDraft', {
        draftId: p.draftId,
        siteId: p.siteId,
        partyId: requireUser(),
    })
    if (!d) missing()
    revision(d, p.expectedRevision)
    d.delete()
    return { discarded: true }
}
methods.previewPost = (p) => {
    site(p.siteId)
    requireUser()
    return { body: StringUtilities.cleanHtml(p.body || '') }
}
methods.publishPost = (p) => {
    requireUser()
    site(p.siteId)
    return receipt(p, 'publishPost', () => {
        if (
            find(F + 'ForumJobRun', { siteId: p.siteId, jobType: 'bootstrap' })
                .condition('state', 'not-equals', 'complete')
                .count() > 0
        )
            fail(
                'Conflict',
                'Mailbox conversion must reconcile before new posts',
            )
        const savedDraft = p.draftId
            ? one(F + 'ForumDraft', { draftId: p.draftId }, true)
            : null
        if (
            savedDraft &&
            (savedDraft.siteId !== p.siteId || savedDraft.partyId !== me())
        )
            missing()
        // A new private conversation names its participants instead of a category.
        const conversation =
            !p.rootCommEventId &&
            !p.contactListId &&
            Array.isArray(p.participantHandles)
        const existing = p.rootCommEventId
                ? topic(p.rootCommEventId, p.siteId, true)
                : null,
            a =
                existing?.a ||
                (conversation
                    ? startAccess(p.siteId)
                    : category(p.contactListId, p.siteId)),
            isPrivate = existing ? existing.t.kind === 'private' : conversation
        const invited = conversation
            ? recipients(p.siteId, p.participantHandles, [me()])
            : []
        if (
            conversation &&
            (!invited.length ||
                invited.length > policy(p.siteId).privateRecipientLimit)
        )
            invalid(
                'A conversation has 1–' +
                    policy(p.siteId).privateRecipientLimit +
                    ' recipients',
            )
        if (!(existing ? a.canReply : a.canStartTopic))
            fail('Unauthorized', 'Posting is not permitted')
        if (existing?.event.statusId === 'CeResolved')
            fail('Conflict', 'This topic is closed')
        const pol = policy(p.siteId)
        if (
            !String(p.body || '').trim() ||
            String(p.body).length > pol.maxPostLength
        )
            invalid('Body must contain 1–' + pol.maxPostLength + ' characters')
        if (!existing && (!p.title || String(p.title).length > 250))
            invalid('A title of at most 250 characters is required')
        if (p.parentCommEventId) {
            const parent = one(F + 'ForumPostState', {
                    communicationEventId: p.parentCommEventId,
                }),
                event = one(E + 'CommunicationEvent', {
                    communicationEventId: p.parentCommEventId,
                })
            if (
                !existing ||
                !parent ||
                parent.rootCommEventId !== existing.t.rootCommEventId ||
                !postVisible(parent, event, a)
            )
                missing()
        }
        const key = { siteId: p.siteId, partyId: me() }
        let memberState = one(F + 'ForumMemberState', key, true)
        if (!memberState)
            memberState = create(F + 'ForumMemberState', {
                ...key,
                trustLevel: 'new',
                approvedContributions: 0,
                dailyTopics: 0,
                dailyReplies: 0,
                revision: 1,
            })
        if (
            memberState.lastPostedAt &&
            millis(now()) - millis(memberState.lastPostedAt) <
                pol.postIntervalSeconds * 1000
        )
            fail(
                'Tarpit',
                'Wait ' + pol.postIntervalSeconds + ' seconds between posts',
            )
        // Slow mode spaces one member's replies in this topic; staff are not limited.
        const slow = Number(existing?.t.slowIntervalSeconds || 0)
        if (slow > 0 && !a.canModerate) {
            const last = Array.from(
                find(F + 'ForumPostSearch', {
                    rootCommEventId: existing.t.rootCommEventId,
                    fromPartyId: me(),
                })
                    .orderBy('-entryDate')
                    .limit(1)
                    .list(),
            )[0]
            if (last && millis(now()) - millis(last.entryDate) < slow * 1000)
                fail(
                    'Tarpit',
                    'This topic is in slow mode; wait ' +
                        slow +
                        ' seconds between replies',
                )
        }
        const day = String(now()).slice(0, 10),
            daily =
                memberState.dayKey === day
                    ? existing
                        ? Number(memberState.dailyReplies)
                        : Number(memberState.dailyTopics)
                    : 0
        const effects =
            TRUST_EFFECTS[memberState.trustLevel] || TRUST_EFFECTS.new
        if (
            !a.canModerate &&
            daily >= (existing ? effects.replies : effects.topics)
        )
            fail('Tarpit', 'Daily contribution limit reached')
        let body = StringUtilities.cleanHtml(p.body)
        const count = (pattern) => (body.match(pattern) || []).length
        if (
            !a.canModerate &&
            (count(/<a\b/gi) > effects.links ||
                count(/<img\b/gi) > effects.images ||
                mentionHandles(body).length > effects.mentions)
        )
            invalid(
                'Your trust level allows ' +
                    effects.links +
                    ' links, ' +
                    effects.images +
                    ' images and ' +
                    effects.mentions +
                    ' mentions per post',
            )
        const ruled = applyRules(p.siteId, a.category.contactListId, body)
        if (ruled.block && !a.canModerate)
            invalid('This post contains content the community does not allow')
        body = ruled.body
        const postId = id(),
            root = existing?.t.rootCommEventId || postId,
            ordinal = existing ? Number(existing.t.nextOrdinal) : 1
        // Private messages are not queued for staff by default; a held rule still files a scoped review.
        const firstPost =
                !isPrivate &&
                Number(memberState.approvedContributions || 0) <
                    pol.firstContributionCount &&
                !a.canModerate,
            pending =
                firstPost || (!isPrivate && ruled.approve && !a.canModerate)
        create(E + 'CommunicationEvent', {
            communicationEventId: postId,
            communicationEventTypeId: 'Message',
            contactListId: a.category.contactListId,
            fromPartyId: me(),
            rootCommEventId: existing ? root : null,
            parentCommEventId: p.parentCommEventId || (existing ? root : null),
            subject: existing ? existing.event.subject : p.title,
            body,
            statusId: 'CeReceived',
            entryDate: now(),
        })
        if (existing)
            update(existing.t, {
                nextOrdinal: ordinal + 1,
                revision: Number(existing.t.revision) + 1,
                ...(!pending
                    ? {
                          lastActivity: now(),
                          visiblePostCount:
                              Number(existing.t.visiblePostCount) + 1,
                      }
                    : {}),
            })
        else
            create(F + 'ForumTopic', {
                rootCommEventId: root,
                siteId: p.siteId,
                contactListId: a.category.contactListId,
                kind: isPrivate ? 'private' : 'category',
                revision: 1,
                nextOrdinal: 2,
                visiblePostCount: pending ? 0 : 1,
                reactionCount: 0,
                lastActivity: now(),
                pinned: 'N',
                unlisted: 'N',
            })
        create(F + 'ForumPostState', {
            communicationEventId: postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            visibility: pending ? 'pending' : 'approved',
            approvedRevision: pending ? null : 1,
            wiki: 'N',
            reactionCount: 0,
        })
        create(F + 'ForumPostRevision', {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: 'html',
            sourceText: p.body,
            sanitizedBody: body,
            editorPartyId: me(),
            editedAt: now(),
            publicHistoryAllowed: 'Y',
        })

        attachToPost(p.siteId, postId, p.attachmentIds)
        if (conversation) {
            addParticipant(root, me(), 'owner')
            for (const partyId of invited)
                addParticipant(root, partyId, 'member')
        }
        if (!existing && !isPrivate)
            setTopicTags(
                p.siteId,
                root,
                a,
                p.tags || json(savedDraft?.tagsJson, []),
            )
        const poll = p.poll || json(savedDraft?.pollJson, null)
        if (poll) createPoll(p.siteId, root, postId, poll)
        update(memberState, {
            lastPostedAt: now(),
            approvedContributions:
                Number(memberState.approvedContributions || 0) +
                (pending ? 0 : 1),
            dayKey: day,
            dailyTopics: existing
                ? memberState.dayKey === day
                    ? memberState.dailyTopics
                    : 0
                : daily + 1,
            dailyReplies: existing
                ? daily + 1
                : memberState.dayKey === day
                  ? memberState.dailyReplies
                  : 0,
            revision: Number(memberState.revision) + 1,
        })
        if (pending)
            review(
                p.siteId,
                a.category.contactListId,
                'post',
                postId,
                1,
                firstPost ? 'first-post' : 'rule',
            )
        else {
            if (ruled.flag || (isPrivate && ruled.approve))
                review(
                    p.siteId,
                    a.category.contactListId,
                    'post',
                    postId,
                    1,
                    'rule',
                )
            if (isPrivate) allocatePrivate(postId, root, me())
            else allocateInternal(postId, a.category.contactListId, me())
            create(F + 'ForumOutbox', {
                outboxId: id(),
                siteId: p.siteId,
                communicationEventId: postId,
                eventType: 'post',
                state: 'pending',
                createdAt: now(),
            })
        }
        queueClassification(p.siteId, postId)
        // Writing in a topic tracks it, unless the member already chose a level for that topic.
        const trackKey = {
            siteId: p.siteId,
            partyId: me(),
            scopeType: 'topic',
            scopeId: root,
        }
        const inherited = [
            ['category', a.category.contactListId],
            ['site', '_SITE_'],
        ].map(
            ([scopeType, scopeId]) =>
                scopeId &&
                one(F + 'ForumPreference', {
                    ...trackKey,
                    scopeType,
                    scopeId,
                })?.watchLevel,
        )
        if (
            !one(F + 'ForumPreference', trackKey) &&
            !inherited.includes('Watching')
        )
            create(F + 'ForumPreference', {
                ...trackKey,
                watchLevel: 'Tracking',
                revision: 1,
            })
        if (savedDraft) savedDraft.delete()
        return {
            postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            state: pending ? 'pending' : 'published',
        }
    })
}
/* A staged upload of the actor's, or one already on this post, that passed scanning and has not expired. */
function attachToPost(siteId, postId, attachmentIds) {
    if ((attachmentIds || []).length > policy(siteId).mediaFilesPerPost)
        invalid(
            'A post has at most ' +
                policy(siteId).mediaFilesPerPost +
                ' attachments',
        )
    for (const attachmentId of attachmentIds || []) {
        const att = one(F + 'ForumAttachment', { attachmentId }, true)
        const usable =
            att &&
            att.siteId === siteId &&
            ((att.ownerPartyId === me() && !att.communicationEventId) ||
                att.communicationEventId === postId) &&
            att.purpose !== 'avatar' &&
            att.scanState === 'clean' &&
            !(att.expiresAt && millis(att.expiresAt) <= millis(now()))
        if (!usable)
            invalid('Attachment is unavailable or has not passed scanning')
        update(att, {
            communicationEventId: postId,
            draftId: null,
            expiresAt: null,
        })
    }
}
methods.updatePost = (p) => {
    requireUser()
    site(p.siteId)
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    revision(st, p.expectedRevision)
    if (!canEditPost(st, event, a))
        fail('Unauthorized', 'Editing is not permitted')
    // A wiki editor changes the text; the author's attachments stay the author's.
    if (p.attachmentIds != null && !a.canModerate && event.fromPartyId !== me())
        invalid('Only the author changes attachments')
    if (a.canModerate && event.fromPartyId !== me() && !p.reason)
        invalid('Staff edits require a reason')
    const pol = policy(p.siteId)
    if (
        !String(p.body || '').trim() ||
        String(p.body).length > pol.maxPostLength
    )
        invalid('Body must contain 1–' + pol.maxPostLength + ' characters')
    const ruled = applyRules(
        p.siteId,
        a.category.contactListId,
        StringUtilities.cleanHtml(p.body),
    )
    if (ruled.block && !a.canModerate)
        invalid('This post contains content the community does not allow')
    const r = Number(st.revision) + 1,
        body = ruled.body
    create(F + 'ForumPostRevision', {
        communicationEventId: p.postId,
        revision: r,
        sourceFormat: 'html',
        sourceText: p.body,
        sanitizedBody: body,
        editorPartyId: me(),
        editedAt: now(),
        reason: p.reason,
        publicHistoryAllowed: 'Y',
    })
    update(event, { body, editedDate: now() })
    update(st, {
        revision: r,
        approvedRevision: st.visibility === 'approved' ? r : null,
    })
    update(t, { revision: Number(t.revision) + 1 })
    // An explicit attachment list is the desired set. Omission preserves legacy edits.
    if (p.attachmentIds != null)
        for (const existing of rows(
            F + 'ForumAttachment',
            { siteId: p.siteId, communicationEventId: p.postId },
            100,
        )) {
            if (!p.attachmentIds.includes(existing.attachmentId))
                update(existing, {
                    communicationEventId: null,
                    expiresAt: millis(now()) + 7 * 86400000,
                })
        }
    attachToPost(p.siteId, p.postId, p.attachmentIds)
    if (a.canModerate)
        audit(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            'edit',
            p.reason,
            r - 1,
            r,
        )
    if (st.visibility === 'pending')
        review(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            r,
            'first-post',
        )
    // Open reports now concern the edited text; decisions bind to that revision.
    refreshReviews(p.siteId, p.postId, r)
    if ((ruled.approve || ruled.flag) && !a.canModerate)
        review(p.siteId, a.category.contactListId, 'post', p.postId, r, 'rule')
    queueClassification(p.siteId, p.postId)
    bump(p.siteId)
    if (p.draftId) {
        const draft = one(F + 'ForumDraft', {
            draftId: p.draftId,
            siteId: p.siteId,
            partyId: me(),
        })
        if (draft) draft.delete()
    }
    return {
        postId: p.postId,
        rootCommEventId: st.rootCommEventId,
        revision: r,
    }
}
methods.markRead = (p) => {
    const { t, a } = topic(p.rootCommEventId, p.siteId),
        partyId = requireUser(),
        key = { rootCommEventId: t.rootCommEventId, partyId }
    lockActor()
    let marker = one(F + 'ForumTopicUser', key, true)
    if (marker)
        revision({ revision: marker.markerRevision }, p.expectedRevision)
    else if (Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Reading position changed')
    const ordinal = Number(p.ordinal)
    const st = one(F + 'ForumPostState', {
        rootCommEventId: t.rootCommEventId,
        ordinal,
    })
    if (
        !st ||
        !postVisible(
            st,
            one(E + 'CommunicationEvent', {
                communicationEventId: st.communicationEventId,
            }),
            a,
        )
    )
        missing()
    const initial = readingBoundary(
            t.rootCommEventId,
            p.siteId,
            a.category.contactListId,
        ),
        consumed = Number(
            marker?.consumedOrdinal ?? initial?.consumedOrdinal ?? 0,
        ),
        rendered = new Set(p.renderedPostIds || [])
    if (rendered.size > 100) invalid('Read window is too large')
    const between = Array.from(
        find(F + 'ForumPostSearch', {
            rootCommEventId: t.rootCommEventId,
            visibility: 'approved',
        })
            .condition('ordinal', 'greater', consumed)
            .condition('ordinal', 'less-equals', ordinal)
            .limit(101)
            .list(),
    )
    const continuous =
        between.length <= 100 &&
        between.every((post) => rendered.has(post.communicationEventId))
    const fields = {
        ...key,
        consumedOrdinal:
            p.markUnread === true
                ? Math.max(0, ordinal - 1)
                : p.jump === true || !continuous
                  ? consumed
                  : Math.max(consumed, ordinal),
        highestSeenOrdinal: Math.max(
            Number(marker?.highestSeenOrdinal || 0),
            ordinal,
        ),
        markerRevision: Number(marker?.markerRevision || 0) + 1,
        lastVisit: now(),
        unreadBoundary:
            p.markUnread === true
                ? ordinal
                : continuous &&
                    p.jump !== true &&
                    ordinal >= Number(marker?.unreadBoundary || 0)
                  ? null
                  : marker?.unreadBoundary,
    }
    marker ? update(marker, fields) : create(F + 'ForumTopicUser', fields)
    if (active(member(p.siteId, partyId)) && p.markUnread !== true)
        recordReading(
            p.siteId,
            partyId,
            Math.max(0, fields.consumedOrdinal - consumed),
            !marker,
        )
    if (internalParty(partyId) && p.markUnread !== true) {
        for (const postId of rendered) {
            const post = one(F + 'ForumPostState', {
                communicationEventId: postId,
                rootCommEventId: t.rootCommEventId,
            })
            if (
                !post ||
                !postVisible(
                    post,
                    one(E + 'CommunicationEvent', {
                        communicationEventId: postId,
                    }),
                    a,
                )
            )
                continue
            for (const receipt of rows(
                E + 'CommunicationEventParty',
                { communicationEventId: postId, partyId },
                10,
            ))
                if (!receipt.readDate) update(receipt, { readDate: now() })
        }
    }
    return {
        marker: pick(
            fields,
            'consumedOrdinal highestSeenOrdinal markerRevision unreadBoundary',
        ),
    }
}
methods.findDeliveries = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'deliveries:' + p.siteId),
        list = Array.from(
            find(F + 'ForumDelivery', { siteId: p.siteId })
                .orderBy('-dueAt,deliveryId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
    return {
        deliveryList: list
            .slice(0, pg.limit)
            .map((v) =>
                pick(
                    v,
                    'deliveryId outboxId channel state attempts revision dueAt lastError',
                ),
            ),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.getPreferences = (p) => {
    site(p.siteId)
    const key = {
        siteId: p.siteId,
        partyId: requireUser(),
        scopeType: p.scopeType || 'site',
        scopeId: p.scopeId || '_SITE_',
    }
    const preference = one(F + 'ForumPreference', key),
        delivery = one(F + 'ForumDeliveryPreference', key)
    return {
        preferences: pick(preference, 'watchLevel revision'),
        delivery: pick(
            delivery,
            'emailMode digestPeriod includeOwn suppressed revision',
        ),
        revision: Math.max(
            Number(preference?.revision || 0),
            Number(delivery?.revision || 0),
        ),
    }
}
methods.setPreferences = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    const key = {
        siteId: p.siteId,
        partyId,
        scopeType: p.scopeType || 'site',
        scopeId: p.scopeId || '_SITE_',
    }
    if (!['site', 'category', 'topic'].includes(key.scopeType))
        invalid('Invalid preference scope')
    if (key.scopeType === 'category') category(key.scopeId, p.siteId)
    if (key.scopeType === 'topic') topic(key.scopeId, p.siteId)
    const oldPreference = one(F + 'ForumPreference', key),
        oldDelivery = one(F + 'ForumDeliveryPreference', key),
        current = Math.max(
            Number(oldPreference?.revision || 0),
            Number(oldDelivery?.revision || 0),
        )
    if (Number(p.expectedRevision || 0) !== current)
        fail('Conflict', 'Preferences changed; reload and compare')
    if (p.watchLevel != null) {
        if (
            ![
                'Muted',
                'Normal',
                'Tracking',
                'Watching',
                'WatchingFirstPost',
            ].includes(p.watchLevel)
        )
            invalid('Invalid watch level')
        const values = {
            ...key,
            watchLevel: p.watchLevel,
            revision: current + 1,
        }
        oldPreference
            ? update(oldPreference, values)
            : create(F + 'ForumPreference', values)
    }
    if (p.emailMode != null || p.digestPeriod != null || p.includeOwn != null) {
        const emailMode =
            p.emailMode ?? oldDelivery?.emailMode ?? 'Notifications'
        if (
            !['None', 'Notifications', 'Digest', 'EveryPost'].includes(
                emailMode,
            )
        )
            invalid(
                'Email mode must be None, Notifications, Digest or EveryPost',
            )
        if (emailMode === 'EveryPost' && key.scopeType === 'topic')
            invalid('Every post is a category or site mailing-list mode')
        if (
            p.digestPeriod != null &&
            !['daily', 'weekly'].includes(p.digestPeriod)
        )
            invalid('Digest period must be daily or weekly')
        // Choosing a mode again is the explicit change that lifts an earlier opt-out.
        const values = {
            ...key,
            emailMode,
            digestPeriod:
                p.digestPeriod ?? oldDelivery?.digestPeriod ?? 'daily',
            includeOwn:
                p.includeOwn != null
                    ? p.includeOwn === true
                        ? 'Y'
                        : 'N'
                    : (oldDelivery?.includeOwn ?? 'N'),
            suppressed:
                p.emailMode != null ? 'N' : (oldDelivery?.suppressed ?? 'N'),
            revision: current + 1,
        }
        oldDelivery
            ? update(oldDelivery, values)
            : create(F + 'ForumDeliveryPreference', values)
        // A site-wide stop (an unsubscribe or a hard bounce) lasts until the member chooses a mode again.
        if (p.emailMode != null && key.scopeType !== 'site') {
            const siteRow = one(F + 'ForumDeliveryPreference', {
                ...key,
                scopeType: 'site',
                scopeId: '_SITE_',
            })
            if (siteRow?.suppressed === 'Y')
                update(siteRow, {
                    suppressed: 'N',
                    revision: Number(siteRow.revision || 0) + 1,
                })
        }
    }
    return methods.getPreferences(p)
}

methods.getSitePage = (p) => {
    site(p.siteId)
    if (!['guidelines', 'about'].includes(p.pageRole)) missing()
    const binding = one(S + 'PublicSitePage', {
        siteId: p.siteId,
        pageRole: p.pageRole,
    })
    if (!binding) missing()
    const page = one('moqui.resource.wiki.WikiPage', {
        wikiPageId: binding.wikiPageId,
    })
    if (!page || page.publishedVersionName !== binding.versionName) missing()
    const out = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.WikiServices.get#PublishedWikiPageText')
        .parameters({
            wikiSpaceId: page.wikiSpaceId,
            pagePath: page.pagePath,
            versionName: null,
        })
        .call()
    if (out.versionName && out.versionName !== binding.versionName) missing()
    return {
        page: {
            ...pick(binding, 'pageRole publicationRevision'),
            body: StringUtilities.cleanHtml(out.text || out.pageText || ''),
        },
    }
}
methods.checkReadiness = (p) => {
    site(p.siteId, true)
    let scannerReady = false
    try {
        scannerReady =
            !!System.getProperty('pass_scanner_service') &&
            !!ec.service.getServiceDefinition(
                System.getProperty('pass_scanner_service'),
            )
    } catch (error) {
        ec.message.clearErrors()
    }
    const checks = [
        { name: 'image derivatives', ready: ec.resource.imageAvailable },
        {
            name: 'SSO package',
            ready:
                !System.getProperty('pass_sso_flows') ||
                ec.service.ssoAvailable,
        },
        {
            name: 'hosts',
            ready: find(S + 'PublicSiteHost', { siteId: p.siteId }).count() > 0,
        },
        {
            name: 'mounts',
            ready:
                find(S + 'PublicSiteApp', {
                    siteId: p.siteId,
                    enabled: 'Y',
                }).count() > 0,
        },
        {
            name: 'mail',
            ready: !!one(F + 'ForumMailSettings', { siteId: p.siteId }),
        },
        { name: 'scanner', ready: scannerReady },
        {
            name: 'media storage',
            ready: !!System.getProperty('pass_media_root'),
        },
        {
            name: 'account verification',
            ready: !!System.getProperty('pass_verification_template'),
        },
        {
            name: 'mail conversion',
            ready:
                find(F + 'ForumJobRun', {
                    siteId: p.siteId,
                    jobType: 'bootstrap',
                })
                    .condition('state', 'not-equals', 'complete')
                    .count() === 0,
        },
    ]
    // Each mounted app with checks of its own adds them, named by app; one that fails to answer is not ready.
    const registry = ec.resource.script(
        'component://mr-mantle/service/mantle/public/PublicApps.js',
    )
    for (const m of rows(S + 'PublicSiteApp', {
        siteId: p.siteId,
        enabled: 'Y',
    })) {
        const service = registry.apps[m.app]?.readiness
        if (!service) continue
        try {
            const out = ec.service
                .sync()
                .throwOnError(true)
                .name(service)
                .parameters({
                    input: { siteId: p.siteId, app: m.app, targetId: m.targetId },
                })
                .call().result
            for (const c of out.checks || [])
                checks.push({ name: m.app + ' ' + c.name, ready: !!c.ready })
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.error(
                'Readiness of the ' + m.app + ' app on site ' + p.siteId + ' failed: ' +
                    String(error.message).split('\n')[0],
            )
            checks.push({ name: m.app + ' app', ready: false })
        }
    }
    return { ready: checks.every((c) => c.ready), checks }
}
/* Named internal recipients who can read the category: To beats Cc beats the plain mailbox receipt. */
function addNamedReceipts(postId, contactListId, author, toIds, ccIds) {
    const roles = new Map()
    for (const partyId of toIds || []) roles.set(partyId, 'MessageTo')
    for (const partyId of ccIds || [])
        if (!roles.has(partyId)) roles.set(partyId, 'MessageCc')
    for (const [partyId, roleTypeId] of roles) {
        if (partyId === author || !internalParty(partyId)) continue
        if (!categoryAccess(contactListId, partyId)?.canRead) continue
        for (const row of find(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
        }).list())
            row.delete()
        create(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId,
            roleTypeId,
            statusId: 'CepReceived',
        })
    }
}
methods.storeMounts = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    const mounts = p.mounts || [],
        hosts = p.hosts || [],
        reserved = [
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
    for (const h of hosts) {
        if (!isOperator())
            fail('Unauthorized', 'Host bindings require an operator')
        if (
            !/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(h.hostname || '') ||
            h.hostname.includes('..')
        )
            invalid('Invalid hostname')
        const old = one(S + 'PublicSiteHost', { hostname: h.hostname })
        if (old && old.siteId !== p.siteId)
            invalid('Hostname already belongs to another site')
    }
    // The core apps a request names replace the site's core mounts, as before. A targeted app's mount (Billing,
    // Supplier) is written only by an operator and only when named, so a site owner's save keeps it.
    const registry = ec.resource.script(
        'component://mr-mantle/service/mantle/public/PublicApps.js',
    )
    const existing = rows(S + 'PublicSiteApp', { siteId: p.siteId }, 100)
    const named = new Set(mounts.map((m) => m.app))
    const kept = existing.filter(
        (old) => registry.apps[old.app]?.target && !named.has(old.app),
    )
    for (let i = 0; i < mounts.length; i++) {
        const m = mounts[i],
            app = registry.apps[m.app]
        if (
            !app ||
            !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/.test(
                m.pathPrefix || '',
            ) ||
            reserved.includes(m.pathPrefix.split('/')[1])
        )
            invalid('Invalid or reserved mount')
        // one root app per site, Forum or Shop: two at '/' overlap below
        if (m.pathPrefix === '/' && !app.root)
            invalid('ROOT_NOT_ALLOWED[pathPrefix]: Only Forum or Shop may mount at root')
        if (
            app.onePerSite &&
            mounts.slice(0, i).concat(kept).some((other) => other.app === m.app)
        )
            invalid('MOUNT_TAKEN[app]: A site has one ' + m.app + ' mount')
        if (app.target) {
            if (!isOperator())
                fail('Unauthorized', 'App targets require an operator')
            if (!m.targetId || !registry.targets[app.target](m.targetId))
                invalid(
                    'TARGET_INVALID[targetId]: Choose the ' +
                        (app.target === 'productStore' ? 'store' : app.target) +
                        ' the ' +
                        m.app +
                        ' app serves',
                )
        } else if (m.targetId) invalid('The ' + m.app + ' app takes no target')
        for (const other of mounts.slice(0, i).concat(kept)) {
            if (
                m.pathPrefix === other.pathPrefix ||
                (m.pathPrefix !== '/' &&
                    other.pathPrefix !== '/' &&
                    (m.pathPrefix.startsWith(other.pathPrefix + '/') ||
                        other.pathPrefix.startsWith(m.pathPrefix + '/')))
            )
                invalid('Mounts overlap')
        }
    }
    for (const old of existing) if (!kept.includes(old)) old.delete()
    for (const [i, m] of mounts.entries())
        create(S + 'PublicSiteApp', {
            siteId: p.siteId,
            appMountId: m.appMountId || m.app + '-' + i,
            app: m.app,
            pathPrefix: m.pathPrefix,
            enabled: m.enabled === false ? 'N' : 'Y',
            targetId: m.targetId || null,
        })
    if (hosts.filter((h) => h.canonical).length > 1)
        invalid('Choose one canonical hostname')
    if (hosts.some((h) => h.canonical))
        for (const old of rows(
            S + 'PublicSiteHost',
            { siteId: p.siteId, canonical: 'Y' },
            100,
        ))
            update(old, { canonical: 'N' })
    for (const h of hosts) {
        const old = one(S + 'PublicSiteHost', { hostname: h.hostname })
        const fields = {
            hostname: h.hostname,
            siteId: p.siteId,
            canonical: h.canonical ? 'Y' : 'N',
        }
        old ? update(old, fields) : create(S + 'PublicSiteHost', fields)
    }
    update(s, {
        policyRevision: Number(s.policyRevision) + 1,
        generation: Number(s.generation) + 1,
    })
    return { revision: Number(s.policyRevision) }
}
methods.updateMembershipPolicy = (p) => {
    const s = site(p.siteId, true)
    revision(s, p.expectedRevision)
    if (!['closed', 'invitation', 'open'].includes(p.registrationMode))
        invalid('Invalid registration mode')
    update(s, {
        registrationMode: p.registrationMode,
        approvalRequired: p.approvalRequired === true ? 'Y' : 'N',
        policyRevision: Number(s.policyRevision) + 1,
    })
    return { revision: Number(s.policyRevision) }
}
methods.createInvitation = (p) => {
    site(p.siteId, true)
    return receipt(p, 'createInvitation', () => {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(p.emailAddress || ''))
            invalid('Email address required')
        const token = id() + id(),
            invitationId = id(),
            expiresAt = p.expiresAt || millis(now()) + 7 * 86400000
        if (millis(expiresAt) <= millis(now()))
            invalid('Expiry must be in the future')
        create(S + 'PublicSiteInvitation', {
            invitationId,
            siteId: p.siteId,
            tokenHash: hash(token),
            emailHash: hash(p.emailAddress.trim().toLowerCase()),
            scopes: '[]',
            inviterPartyId: requireUser(),
            expiresAt,
        })
        return { invitationId, token, expiresAt }
    })
}
function invitation(p, lock = false) {
    const v = one(
        S + 'PublicSiteInvitation',
        { siteId: p.siteId, tokenHash: hash(p.token || '') },
        lock,
    )
    if (
        !v ||
        v.revokedAt ||
        v.redeemedAt ||
        millis(v.expiresAt) <= millis(now())
    )
        missing()
    return v
}
methods.inspectInvitation = (p) => {
    site(p.siteId)
    const v = invitation(p)
    if (
        p.emailAddress &&
        hash(String(p.emailAddress).trim().toLowerCase()) !== v.emailHash
    )
        missing()
    return { invitation: pick(v, 'siteId expiresAt') }
}
methods.redeemInvitation = (p) => {
    site(p.siteId)
    ensureParty()
    const partyId = requireUser(),
        v = invitation(p, true),
        ua = ec.user.userAccount
    if (
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        }) ||
        hash(String(ua.emailAddress || '').toLowerCase()) !== v.emailHash
    )
        fail('Unauthorized', 'Sign in with the verified intended address')
    const old = member(p.siteId)
    if (old && old.role !== 'member')
        fail(
            'Conflict',
            'Existing staff membership must be managed by its owner',
        )
    const values = {
        siteId: p.siteId,
        partyId,
        state: 'active',
        role: 'member',
        joinedAt: now(),
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, values) : create(S + 'PublicSiteParty', values)
    update(v, { redeemedAt: now() })
    // An invitation bound to an app and an outside party (invite#Contact) makes this account's party its contact.
    ec.resource
        .script('component://mr-mantle/service/mantle/party/ExternalAccess.js')
        .bindContact(partyId, json(v.scopes, []))
    return { state: 'active', revision: values.revision }
}
methods.revokeInvitation = (p) => {
    site(p.siteId, true)
    const v = one(S + 'PublicSiteInvitation', {
        invitationId: p.invitationId,
        siteId: p.siteId,
    })
    if (!v) missing()
    update(v, { revokedAt: now() })
    return { revoked: true }
}
methods.resolveDelivery = (p) => {
    site(p.siteId, true)
    const delivery = one(
        F + 'ForumDelivery',
        { siteId: p.siteId, deliveryId: p.deliveryId },
        true,
    )
    if (!delivery) missing()
    revision(delivery, p.expectedRevision)
    if (!p.reason) invalid('A reconciliation reason is required')
    let state
    if (delivery.state === 'failed' && p.decision === 'retry') state = 'retry'
    else if (
        delivery.state === 'uncertain' &&
        ['confirmed-sent', 'confirmed-not-sent'].includes(p.decision)
    )
        state = p.decision === 'confirmed-sent' ? 'sent' : 'retry'
    else fail('Conflict', 'Reconcile only a failed or uncertain delivery')
    const next = Number(delivery.revision || 0) + 1
    update(delivery, {
        state,
        revision: next,
        attempts: state === 'retry' ? 0 : delivery.attempts,
        dueAt: now(),
    })
    audit(
        p.siteId,
        null,
        'delivery',
        p.deliveryId,
        p.decision,
        p.reason,
        Number(delivery.revision) - 1,
        next,
    )
    return { state, revision: next }
}
methods.storeMailSettings = (p) => {
    site(p.siteId, true)
    const allowed = String(System.getProperty('pass_sender_addresses') || '')
        .split(',')
        .map((x) => x.trim())
    if (!allowed.includes(p.senderAddress))
        invalid('Sender must be registered by the operator')
    const template = one('moqui.basic.email.EmailTemplate', {
        emailTemplateId: p.templateId,
    })
    const templates = String(System.getProperty('pass_mail_template_ids') || '')
        .split(',')
        .map((x) => x.trim())
    if (
        !template ||
        template.fromAddress !== p.senderAddress ||
        !templates.includes(p.templateId)
    )
        invalid('Template and sender must be registered together')
    const old = one(F + 'ForumMailSettings', { siteId: p.siteId }, true)
    if (old) revision(old, p.expectedRevision)
    const values = {
        siteId: p.siteId,
        senderAddress: p.senderAddress,
        senderName: p.senderName,
        templateId: p.templateId,
        revision: Number(old?.revision || 0) + 1,
    }
    old ? update(old, values) : create(F + 'ForumMailSettings', values)
    return { revision: values.revision }
}
function optOut(p) {
    const v = one(F + 'ForumOptOut', {
        tokenHash: hash(p.token || ''),
        siteId: p.siteId,
    })
    if (!v || millis(v.expiresAt) <= millis(now())) missing()
    return v
}
methods.inspectOptOut = (p) => {
    const v = optOut(p)
    // Name only what the recipient can still see; a scope they lost access to stays generic.
    let scope = 'this site'
    if (v.scopeType === 'category') {
        const a = categoryAccess(v.scopeId, v.partyId)
        scope = a?.canRead
            ? 'the ' +
              (one('mantle.marketing.contact.ContactList', {
                  contactListId: v.scopeId,
              })?.contactListName || 'selected') +
              ' category'
            : 'a category'
    } else if (v.scopeType === 'topic') scope = 'one discussion'
    return {
        valid: true,
        scopeType: v.scopeType,
        optOut: {
            'Stops email for': scope,
            'Or choose': 'all forum email from this site',
            Keeps: 'Your membership, your access and in-app notifications',
        },
    }
}
methods.applyOptOut = (p) => {
    const v = optOut(p)
    if (p.scopeType != null && !['site', v.scopeType].includes(p.scopeType))
        invalid('Choose this scope or the whole site')
    // The recipient may widen the stop to the whole site; the token never reaches another person's preferences.
    const key =
            p.scopeType === 'site'
                ? {
                      siteId: v.siteId,
                      partyId: v.partyId,
                      scopeType: 'site',
                      scopeId: '_SITE_',
                  }
                : pick(v, 'siteId partyId scopeType scopeId'),
        old = one(F + 'ForumDeliveryPreference', key, true),
        values = {
            ...key,
            emailMode: 'None',
            suppressed: 'Y',
            optOutAt: now(),
            revision: Number(old?.revision || 0) + 1,
        }
    old ? update(old, values) : create(F + 'ForumDeliveryPreference', values)
    return { suppressed: true }
}

methods.stageAttachment = (p) => {
    if (p.purpose === 'avatar') {
        site(p.siteId)
        const membership = member(p.siteId, requireUser())
        if (
            !active(membership) ||
            membership.state !== 'active' ||
            sanctioned(p.siteId, me(), null, 'suspend')
        )
            fail(
                'Unauthorized',
                'Active membership is required for avatar uploads',
            )
    } else {
        if (p.purpose && p.purpose !== 'post') invalid('Unknown upload purpose')
        const a = p.rootCommEventId
            ? topic(p.rootCommEventId, p.siteId).a
            : category(p.contactListId, p.siteId)
        if (!a.canUpload) fail('Unauthorized', 'Uploads are not permitted')
    }
    const partyId = requireUser(),
        file = p.file
    if (p.draftId) {
        const draft = one(F + 'ForumDraft', { draftId: p.draftId })
        if (draft && (draft.partyId !== partyId || draft.siteId !== p.siteId))
            missing()
    }
    const maxBytes = Math.min(10485760, policy(p.siteId).mediaMaxBytes)
    if (!file || Number(file.size) > maxBytes || Number(file.size) < 1)
        invalid('Upload must contain 1 byte to ' + maxBytes + ' bytes')
    const type = String(file.contentType || 'application/octet-stream')
    if (
        ![
            'image/png',
            'image/jpeg',
            'image/webp',
            'image/gif',
            'application/pdf',
            'text/plain',
        ].includes(type)
    )
        invalid('Unsupported attachment type')
    if (p.purpose === 'avatar' && !type.startsWith('image/'))
        invalid('Avatars require a raster image')
    const scanner = System.getProperty('pass_scanner_service'),
        root = System.getProperty('pass_media_root')
    if (!scanner || !root)
        fail('Unavailable', 'Media scanning and storage must be configured')
    const attachmentId = id(),
        location = String(root).replace(/\/$/, '') + '/' + attachmentId
    file.write(location)
    create(F + 'ForumAttachment', {
        attachmentId,
        siteId: p.siteId,
        purpose: p.purpose || 'post',
        ownerPartyId: partyId,
        draftId: p.draftId,
        location,
        filename: String(file.name || 'attachment')
            .replace(/[^a-zA-Z0-9._ -]/g, '_')
            .slice(0, 100),
        mimeType: type,
        byteSize: Number(file.size),
        scanState: 'pending',
        expiresAt: millis(now()) + 7 * 86400000,
        altText: p.altText || '',
    })
    let result = { clean: false }
    try {
        result = ec.service
            .sync()
            .throwOnError(true)
            .name(scanner)
            .parameters({ location, mimeType: type })
            .call()
    } catch (error) {
        ec.message.clearErrors()
        ec.logger.error(
            'Forum attachment ' +
                attachmentId +
                ' could not be scanned; held in quarantine',
        )
    }
    const att = one(F + 'ForumAttachment', { attachmentId })
    update(att, { scanState: result.clean === true ? 'clean' : 'quarantined' })
    return {
        attachment: pick(
            att,
            'attachmentId filename mimeType byteSize scanState altText',
        ),
    }
}
methods.removeStagedAttachment = (p) => {
    site(p.siteId)
    const v = one(F + 'ForumAttachment', {
        attachmentId: p.attachmentId,
        siteId: p.siteId,
        ownerPartyId: requireUser(),
    })
    if (
        !v ||
        v.communicationEventId ||
        one(S + 'PublicSiteProfile', {
            siteId: p.siteId,
            avatarId: p.attachmentId,
        })
    )
        missing()
    ec.resource.getLocationReference(v.location).delete()
    v.delete()
    return { removed: true }
}
methods.getAttachment = (p) => {
    site(p.siteId)
    const v = one(F + 'ForumAttachment', {
        attachmentId: p.attachmentId,
        siteId: p.siteId,
    })
    if (!v || v.scanState !== 'clean') missing()
    if (v.purpose === 'avatar') {
        const profile = one(S + 'PublicSiteProfile', {
            siteId: p.siteId,
            avatarId: p.attachmentId,
        })
        if (!profile) missing()
        methods.getProfile({ siteId: p.siteId, handle: profile.handle })
    } else {
        if (!v.communicationEventId) missing()
        const st = one(F + 'ForumPostState', {
            communicationEventId: v.communicationEventId,
        })
        if (!st) missing()
        const { a } = topic(st.rootCommEventId, p.siteId)
        if (
            st.visibility === 'deleted' ||
            !postVisible(
                st,
                one(E + 'CommunicationEvent', {
                    communicationEventId: st.communicationEventId,
                }),
                a,
            ) ||
            (!a.canRead && !a.canReadOwn)
        )
            missing()
    }
    if (p.variant && p.variant !== 'thumbnail') invalid('Unknown media variant')
    if (p.variant === 'thumbnail') {
        if (!ec.resource.imageAvailable)
            fail(
                'Unavailable',
                'Image derivatives are unavailable in this framework package',
            )
        if (!String(v.mimeType).startsWith('image/')) missing()
        const location = v.location + '.thumbnail.png'
        if (!ec.resource.getLocationReference(location).exists) {
            const result = ec.resource.makeThumbnail(v.location, location, 256)
            if (!result) missing()
        }
        return {
            attachment: {
                attachmentId: v.attachmentId,
                filename: 'thumbnail.png',
                mimeType: 'image/png',
                variant: 'thumbnail',
            },
            location,
        }
    }
    return {
        attachment: pick(v, 'attachmentId filename mimeType byteSize'),
        location: v.location,
    }
}
methods.findNotifications = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        pg = page(p, 'notifications:' + p.siteId + ':' + (p.view || 'all'))
    if (p.view && !['all', 'unread'].includes(p.view))
        invalid('Invalid notification view')
    const list = Array.from(
            find(F + 'ForumDelivery', {
                siteId: p.siteId,
                partyId,
                channel: 'in-app',
            })
                .condition(
                    'state',
                    'in',
                    p.view === 'unread' ? ['sent'] : ['sent', 'read'],
                )
                .orderBy('-dueAt,deliveryId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        ),
        visible = []
    for (const item of list.slice(0, pg.limit)) {
        const box = one(F + 'ForumOutbox', { outboxId: item.outboxId }),
            st = box
                ? one(F + 'ForumPostState', {
                      communicationEventId: box.communicationEventId,
                  })
                : null
        if (!st || st.visibility !== 'approved') continue
        try {
            const { event } = topic(st.rootCommEventId, p.siteId)
            visible.push({
                deliveryId: item.deliveryId,
                reason: box.eventType === 'reminder' ? 'reminder' : item.reason,
                postId: st.communicationEventId,
                rootCommEventId: st.rootCommEventId,
                title: event.subject,
                createdAt: item.dueAt,
                read: item.state === 'read',
            })
        } catch (e) {
            if (e.moquiErrorKind !== 'NotFound') throw e
        }
    }
    return {
        notificationList: visible,
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.markNotifications = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    for (const deliveryId of p.deliveryIds || []) {
        const v = one(F + 'ForumDelivery', {
            siteId: p.siteId,
            partyId,
            deliveryId,
            channel: 'in-app',
        })
        if (v?.state === 'sent') update(v, { state: 'read' })
    }
    // Read all: the actor's own unread notices on this site, in bounded pages.
    if (p.all === true)
        for (let pageCount = 0; pageCount < 20; pageCount++) {
            const unread = Array.from(
                find(F + 'ForumDelivery', {
                    siteId: p.siteId,
                    partyId,
                    channel: 'in-app',
                    state: 'sent',
                })
                    .limit(500)
                    .list(),
            )
            for (const v of unread) update(v, { state: 'read' })
            if (unread.length < 500) break
        }
    return { marked: true }
}
/* The site's brand values from PublicSite.theme (a small JSON object; Shop P1, F7), which the PASS shell shows on a site's
   Account, Billing and Support pages: only six-digit hex colors and a local path or https logo, the rest left out. */
function siteBrand(theme) {
    let raw
    try {
        raw = theme ? JSON.parse(String(theme)) : null
    } catch (error) {
        return null
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const brand = {}
    for (const k of ['primaryColor', 'backgroundColor', 'textColor', 'surfaceColor'])
        if (/^#[0-9a-fA-F]{6}$/.test(String(raw[k] || ''))) brand[k] = raw[k]
    if (
        typeof raw.logoUrl === 'string' &&
        raw.logoUrl.length <= 500 &&
        /^(https:\/\/[^\s<>"'()\\]+|\/(?!\/)[^\s<>"'()\\]*)$/.test(raw.logoUrl)
    )
        brand.logoUrl = raw.logoUrl
    return Object.keys(brand).length ? brand : null
}
methods.getSiteInfo = (p) => {
    const s = site(p.siteId)
    if (
        p.hostname &&
        !one(S + 'PublicSiteHost', { siteId: p.siteId, hostname: p.hostname })
    )
        missing()
    const membership = member(p.siteId),
        joined =
            active(membership) &&
            membership.state === 'active' &&
            !sanctioned(p.siteId, me(), null, 'suspend')
    return {
        capabilities: {
            canManageSite:
                isOperator() || (joined && membership.role === 'owner'),
            canModerateSite:
                isOperator() ||
                (joined && ['owner', 'moderator'].includes(membership.role)),
        },
        ssoFlows: String(
            ec.service.ssoAvailable
                ? System.getProperty('pass_sso_flows') || ''
                : '',
        )
            .split(',')
            .filter(Boolean)
            .filter((flowId) => {
                const flow = one('moqui.security.sso.AuthFlow', {
                    authFlowId: flowId,
                })
                return (
                    flow &&
                    flow.disabled !== 'Y' &&
                    flow.inbound !== 'Y' &&
                    ['AftOidc', 'AftOauth'].includes(flow.authFlowTypeEnumId)
                )
            })
            .map((flowId) => ({ flowId })),
        site: pick(
            s,
            'siteId name state locale timeZone registrationMode generation policyRevision',
        ),
        mounts: rows(S + 'PublicSiteApp', {
            siteId: p.siteId,
            enabled: 'Y',
        }).map((v) => pick(v, 'app pathPrefix')),
        authenticated: !!ec.user.userId,
        membershipState: member(p.siteId)?.state || null,
        recoveryKey: ec.user.userId
            ? hash(p.siteId + ':' + ec.user.userId)
            : null,
        profile: me()
            ? pick(
                  one(S + 'PublicSiteProfile', {
                      siteId: p.siteId,
                      partyId: me(),
                  }),
                  'handle displayName',
              )
            : null,
        // Shop P1 (F7): the brand values and the page where members manage a paid subscription
        brand: siteBrand(s.theme),
        subscriptionUrl: s.subscriptionUrl || null,
    }
}
function recordMailboxPost(postId) {
    const event = one(E + 'CommunicationEvent', {
        communicationEventId: postId,
    })
    if (!event?.contactListId) return
    const list = one('mantle.marketing.contact.ContactList', {
        contactListId: event.contactListId,
    })
    if (list?.contactListTypeEnumId !== 'MAILBOX') return
    const root = event.rootCommEventId || postId
    let t = one(F + 'ForumTopic', { rootCommEventId: root }, true)
    if (!t) {
        t = create(F + 'ForumTopic', {
            rootCommEventId: root,
            siteId: null,
            contactListId: event.contactListId,
            kind: 'category',
            revision: 1,
            nextOrdinal: 1,
            visiblePostCount: 0,
            lastActivity: event.entryDate,
        })
    }
    if (!one(F + 'ForumPostState', { communicationEventId: postId })) {
        const ordinal = Number(t.nextOrdinal)
        create(F + 'ForumPostState', {
            communicationEventId: postId,
            rootCommEventId: root,
            ordinal,
            revision: 1,
            visibility: 'approved',
            approvedRevision: 1,
        })
        update(t, {
            nextOrdinal: ordinal + 1,
            visiblePostCount: Number(t.visiblePostCount) + 1,
            lastActivity: event.entryDate,
            revision: Number(t.revision) + 1,
        })
    }
}

function legacyReading(event, partyId) {
    if (!event.contactListId || internalParty(partyId)) return null
    const list = one('mantle.marketing.contact.ContactList', {
        contactListId: event.contactListId,
    })
    if (list?.contactListTypeEnumId !== 'MAILBOX') return null
    const root = event.rootCommEventId || event.communicationEventId,
        t = one(F + 'ForumTopic', { rootCommEventId: root }),
        state = one(F + 'ForumPostState', {
            communicationEventId: event.communicationEventId,
        }),
        marker = one(F + 'ForumTopicUser', { rootCommEventId: root, partyId }),
        boundary = readingBoundary(root, t?.siteId, event.contactListId)
    return {
        isUnread: state
            ? state.visibility === 'approved' &&
              Number(state.ordinal) > Number(boundary?.consumedOrdinal || 0)
            : true,
        markerRevision: Number(marker?.markerRevision || 0),
        consumedOrdinal: Number(boundary?.consumedOrdinal || 0),
        highestSeenOrdinal: Number(marker?.highestSeenOrdinal || 0),
        archivedAt: marker?.archivedAt || null,
    }
}
/* A public member's inbox summary of one mailbox. Only the most recently active topics are counted, so one
   inbox load stays bounded however many threads the mailbox has; beyond them the count is a lower bound. */
const SUMMARY_TOPIC_LIMIT = 200
function legacyMailboxSummary(contactListId) {
    const partyId = me()
    if (!partyId || internalParty(partyId)) return null
    return withAccessMemo(() => {
        let unreadCount = 0,
            lastPostDate = null
        const topics = Array.from(
            find(F + 'ForumTopic', { contactListId, kind: 'category' })
                .orderBy('-lastActivity,rootCommEventId')
                .limit(SUMMARY_TOPIC_LIMIT + 1)
                .list(),
        )
        for (const t of topics.slice(0, SUMMARY_TOPIC_LIMIT)) {
            if (t.siteId) {
                try {
                    topic(t.rootCommEventId, t.siteId)
                } catch (error) {
                    if (error.moquiErrorKind === 'NotFound') continue
                    throw error
                }
            }
            if (!lastPostDate) lastPostDate = t.lastActivity
            const marker = one(F + 'ForumTopicUser', {
                    rootCommEventId: t.rootCommEventId,
                    partyId,
                }),
                boundary = readingBoundary(
                    t.rootCommEventId,
                    t.siteId,
                    contactListId,
                )
            if (!marker?.archivedAt)
                unreadCount += find(F + 'ForumPostState', {
                    rootCommEventId: t.rootCommEventId,
                    visibility: 'approved',
                })
                    .condition(
                        'ordinal',
                        'greater',
                        Number(boundary?.consumedOrdinal || 0),
                    )
                    .count()
        }
        return {
            unreadCount,
            lastPostDate,
            unreadCapped: topics.length > SUMMARY_TOPIC_LIMIT,
        }
    })
}

function legacyMarker(event, partyId, change, expected) {
    const root = event.rootCommEventId || event.communicationEventId,
        key = { rootCommEventId: root, partyId }
    lockActor()
    let topicRow = one(F + 'ForumTopic', { rootCommEventId: root })
    if (!topicRow)
        fail('Unavailable', 'Mailbox tracking conversion is required')
    const state = one(F + 'ForumPostState', {
        communicationEventId: event.communicationEventId,
    })
    if (!state) fail('Unavailable', 'Mailbox tracking conversion is required')
    const old = one(F + 'ForumTopicUser', key, true)
    if (
        (expected != null &&
            Number(expected) !== Number(old?.markerRevision || 0)) ||
        (change.read === false && expected == null)
    )
        fail('Conflict', 'Reading position changed; reload and compare')
    const initial = readingBoundary(root, topicRow.siteId, event.contactListId),
        consumed = Number(old?.consumedOrdinal ?? initial?.consumedOrdinal ?? 0)
    const noGap =
        find(F + 'ForumPostState', {
            rootCommEventId: root,
            visibility: 'approved',
        })
            .condition('ordinal', 'greater', consumed)
            .condition('ordinal', 'less', Number(state.ordinal))
            .limit(1)
            .list().length === 0
    const canConsume =
        change.read === true &&
        state.visibility === 'approved' &&
        noGap &&
        (expected != null || !old?.unreadBoundary)
    const values = {
        ...key,
        consumedOrdinal:
            change.read === false
                ? Math.max(0, Number(state.ordinal) - 1)
                : canConsume
                  ? Math.max(consumed, Number(state.ordinal))
                  : consumed,
        highestSeenOrdinal:
            change.read === true
                ? Math.max(
                      Number(old?.highestSeenOrdinal || 0),
                      Number(state.ordinal),
                  )
                : Number(old?.highestSeenOrdinal || 0),
        unreadBoundary:
            change.read === false
                ? Number(state.ordinal)
                : canConsume
                  ? null
                  : old?.unreadBoundary,
        markerRevision: Number(old?.markerRevision || 0) + 1,
        lastVisit: now(),
        archivedAt:
            change.archived === true
                ? now()
                : change.archived === false
                  ? null
                  : old?.archivedAt,
    }
    old ? update(old, values) : create(F + 'ForumTopicUser', values)
    return values
}
methods.getDraft = (p) => {
    site(p.siteId)
    const d = one(F + 'ForumDraft', {
        siteId: p.siteId,
        draftId: p.draftId,
        partyId: requireUser(),
    })
    if (!d) missing()
    if (d.rootCommEventId) topic(d.rootCommEventId, p.siteId)
    else if (d.contactListId) category(d.contactListId, p.siteId)
    return {
        draft: {
            ...pick(
                d,
                'draftId mode rootCommEventId parentCommEventId contactListId postId postRevision title revision',
            ),
            tags: json(d.tagsJson, []),
            poll: json(d.pollJson, null),
            body: StringUtilities.cleanHtml(d.sourceText || ''),
            attachments: rows(
                F + 'ForumAttachment',
                {
                    siteId: p.siteId,
                    ownerPartyId: me(),
                    draftId: d.draftId,
                    communicationEventId: null,
                },
                100,
            )
                .filter(
                    (v) => !v.expiresAt || millis(v.expiresAt) > millis(now()),
                )
                .map((v) =>
                    pick(
                        v,
                        'attachmentId filename mimeType byteSize scanState altText',
                    ),
                ),
        },
    }
}
methods.joinCategory = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        a = category(p.contactListId, p.siteId)
    // Joining a help category would open every other member's thread; staff add help members.
    if (
        member(p.siteId)?.state !== 'active' ||
        !a.canRead ||
        a.category.visibility === 'help'
    )
        fail('Unauthorized', 'Joining is not permitted')
    const old = listMember(p.contactListId, partyId)
    if (old) return { state: 'active' }
    const values = {
        contactListId: p.contactListId,
        partyId,
        fromDate: now(),
        revision: 1,
        statusId:
            a.category.joinApprovalRequired === 'Y'
                ? 'CLPT_PENDING'
                : 'CLPT_ACCEPTED',
    }
    create('mantle.marketing.contact.ContactListParty', values)
    return { state: values.statusId === 'CLPT_PENDING' ? 'pending' : 'active' }
}
methods.leaveCategory = (p) => {
    category(p.contactListId, p.siteId)
    requireUser()
    ec.service
        .sync()
        .throwOnError(true)
        .name('mantle.marketing.ContactListServices.leave#ContactList')
        .parameters({ contactListId: p.contactListId })
        .call()
    return { state: 'ended' }
}
methods.findCategoryMembers = (p) => {
    const a = category(p.contactListId, p.siteId)
    if (!a.canModerate)
        fail('Unauthorized', 'Category moderator access required')
    const pg = page(p, 'category-members:' + p.contactListId),
        list = Array.from(
            find('mantle.marketing.contact.ContactListParty', {
                contactListId: p.contactListId,
            })
                .conditionDate('fromDate', 'thruDate', now())
                .orderBy('partyId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
    return {
        memberList: list.slice(0, pg.limit).map((v) => ({
            ...pick(v, 'partyId roleTypeId statusId fromDate thruDate'),
            revision: Number(v.revision || 0),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
methods.setCategoryMember = (p) => {
    one(S + 'PublicSite', { siteId: p.siteId }, true)
    // Serialize decisions, including first membership creation, with the category.
    one(F + 'ForumCategory', { contactListId: p.contactListId }, true)
    const a = category(p.contactListId, p.siteId)
    if (!a.canModerate)
        fail('Unauthorized', 'Category moderator access required')
    const target = member(p.siteId, p.targetPartyId)
    if (!active(target) || target.state !== 'active') missing()
    if (!p.reason?.trim()) invalid('A membership decision reason is required')
    if (!['active', 'ended'].includes(p.state))
        invalid('Membership must be active or ended')
    if (p.roleTypeId && !['ListOwner', 'ListModerator'].includes(p.roleTypeId))
        invalid('Invalid category role')
    const current = Array.from(
        find('mantle.marketing.contact.ContactListParty', {
            contactListId: p.contactListId,
            partyId: p.targetPartyId,
        })
            .conditionDate('fromDate', 'thruDate', now())
            .orderBy('-fromDate')
            .forUpdate(true)
            .limit(1)
            .list(),
    )[0]
    const before = Number(current?.revision || 0)
    revision({ revision: before }, p.expectedRevision)
    const roleChange =
        (current?.roleTypeId || null) !== (p.roleTypeId || null) ||
        (p.state === 'ended' && !!current?.roleTypeId)
    if (roleChange) {
        if (!a.isOwner && !isOperator())
            fail(
                'Unauthorized',
                'Site owner approval is required to delegate category roles',
            )
        const auth = ec.service
            .sync()
            .throwOnError(true)
            .name('org.moqui.impl.UserServices.login#UserAccount')
            .parameters({
                username: ec.user.userAccount.username,
                password: p.password,
                code: p.code,
            })
            .call()
        if (!auth.loggedIn)
            fail(
                'AuthenticationRequired',
                'Reauthenticate before changing category roles',
            )
    }
    ec.service
        .sync()
        .throwOnError(true)
        .name(
            'mantle.marketing.ContactListServices.' +
                (p.state === 'ended'
                    ? 'remove#ContactListParty'
                    : 'add#ContactListParty'),
        )
        .parameters({
            contactListId: p.contactListId,
            partyId: p.targetPartyId,
            ...(p.state === 'active'
                ? { roleTypeId: p.roleTypeId || null }
                : {}),
        })
        .call()
    audit(
        p.siteId,
        p.contactListId,
        'member',
        p.targetPartyId,
        'category-membership',
        p.reason,
        before,
        before + 1,
    )
    bump(p.siteId)
    return { state: p.state, revision: before + 1 }
}
methods.bindMailbox = (p) => {
    site(p.siteId, true)
    return receipt(p, 'bindMailbox', () => {
        if (p.confirm !== true) invalid('Confirm the mailbox and its audience')
        const list = one('mantle.marketing.contact.ContactList', {
            contactListId: p.contactListId,
        })
        if (!list || list.contactListTypeEnumId !== 'MAILBOX') missing()
        // Binding exposes a mailbox's history to the site's staff: an operator, or an internal owner of that list.
        if (
            !isOperator() &&
            !(
                listMember(p.contactListId, me())?.roleTypeId === 'ListOwner' &&
                internalParty(me())
            )
        )
            missing()
        if (one(F + 'ForumCategory', { contactListId: p.contactListId }))
            fail('Conflict', 'Mailbox is already bound')
        const category = create(F + 'ForumCategory', {
            contactListId: p.contactListId,
            siteId: p.siteId,
            publicationState: 'disabled',
            visibility: 'category',
            mode: 'discussion',
            slug: p.contactListId,
            policyRevision: 1,
        })
        const runId = id()
        create(F + 'ForumJobRun', {
            runId,
            siteId: p.siteId,
            jobType: 'bootstrap',
            state: 'pending',
            checkpoint: JSON.stringify({ contactListId: p.contactListId }),
            createdAt: now(),
            successCount: 0,
            failedCount: 0,
        })
        return {
            contactListId: category.contactListId,
            state: 'disabled',
            runId,
        }
    })
}
methods.publishSitePage = (p) => {
    site(p.siteId, true)
    if (!['guidelines', 'about'].includes(p.pageRole))
        invalid('Invalid page role')
    const access = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.WikiServices.get#WikiPageAccess')
        .parameters({ wikiPageId: p.wikiPageId })
        .call()
    if (!access.canUpdate)
        fail('Unauthorized', 'Wiki publication access required')
    const page = one('moqui.resource.wiki.WikiPage', {
        wikiPageId: p.wikiPageId,
    })
    if (!page || !p.versionName || page.publishedVersionName !== p.versionName)
        invalid('Select the exact currently published wiki revision')
    const old = one(
        S + 'PublicSitePage',
        { siteId: p.siteId, pageRole: p.pageRole },
        true,
    )
    if (
        p.expectedRevision == null ||
        Number(p.expectedRevision) !== Number(old?.publicationRevision || 0)
    )
        fail('Conflict', 'Published site page changed')
    const values = {
        siteId: p.siteId,
        pageRole: p.pageRole,
        wikiPageId: p.wikiPageId,
        versionName: p.versionName,
        publicationRevision: Number(old?.publicationRevision || 0) + 1,
    }
    old ? update(old, values) : create(S + 'PublicSitePage', values)
    bump(p.siteId)
    return { revision: values.publicationRevision }
}

methods.searchForum = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        if (
            !p.query ||
            String(p.query).length < 2 ||
            String(p.query).length > 200
        )
            invalid('Search needs 2–200 characters')
        if (p.scope && p.scope !== 'private') invalid('Invalid search scope')
        // Private search is opt-in and covers only the actor's own current conversations.
        const ownConversations =
            p.scope === 'private'
                ? rows(
                      F + 'ForumParticipant',
                      { partyId: requireUser(), endedAt: null },
                      500,
                  ).map((v) => v.rootCommEventId)
                : null
        const allowed = []
        for (const c of ownConversations
            ? []
            : rows(F + 'ForumCategory', { siteId: p.siteId }, 1000)) {
            const a = categoryAccess(c.contactListId)
            if (
                a &&
                (a.canRead || a.canReadOwn || a.canModerate) &&
                (!p.contactListId || p.contactListId === c.contactListId)
            )
                allowed.push(c.contactListId)
        }
        if (!(ownConversations || allowed).length)
            return { topicList: [], nextCursor: null }
        const pg = page(
                p,
                'search:' +
                    p.siteId +
                    ':' +
                    p.query +
                    ':' +
                    (p.contactListId || '') +
                    ':' +
                    (p.scope || ''),
            ),
            cf = ec.entity.conditionFactory
        const candidates = Array.from(
            find(F + 'ForumPostSearch', {
                siteId: p.siteId,
                visibility: 'approved',
            })
                .condition(
                    ownConversations ? 'rootCommEventId' : 'contactListId',
                    'in',
                    ownConversations || allowed,
                )
                .condition(
                    cf.makeCondition('unlisted', 'not-equals', 'Y', true),
                )
                .condition(
                    cf.makeCondition(
                        [
                            // Replies keep the subject from when they were posted; only the root carries the title.
                            cf.makeCondition(
                                [
                                    cf.makeCondition(
                                        'subject',
                                        'like',
                                        '%' + p.query + '%',
                                    ),
                                    cf.makeCondition('ordinal', 'equals', 1),
                                ],
                                'and',
                            ),
                            cf.makeCondition(
                                'body',
                                'like',
                                '%' + p.query + '%',
                            ),
                        ],
                        'or',
                    ),
                )
                .orderBy('-entryDate,communicationEventId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        const literal = /[%_]/.test(p.query)
            ? String(p.query).toLowerCase()
            : null
        const list = []
        for (const candidate of candidates.slice(0, pg.limit)) {
            let out
            try {
                out = topic(candidate.rootCommEventId, p.siteId)
            } catch (e) {
                if (e.moquiErrorKind === 'NotFound') continue
                throw e
            }
            if (!postVisible(candidate, candidate, out.a)) continue
            const text = plainText(candidate.body)
            // LIKE treats % and _ as wildcards; keep only literal matches.
            if (
                literal &&
                !(
                    (Number(candidate.ordinal) === 1 &&
                        String(out.event.subject || '')
                            .toLowerCase()
                            .includes(literal)) ||
                    text.toLowerCase().includes(literal)
                )
            )
                continue
            list.push({
                rootCommEventId: candidate.rootCommEventId,
                postId: candidate.communicationEventId,
                title: out.event.subject,
                snippet: text.slice(0, 240),
                entryDate: candidate.entryDate,
                capabilities: capabilities(out.a),
            })
        }
        return {
            topicList: list,
            nextCursor:
                candidates.length > pg.limit
                    ? pg.next(pg.offset + pg.limit)
                    : null,
        }
    })
methods.getFeed = (p) => {
    const s = one(S + 'PublicSite', { siteId: p.siteId })
    if (!s || s.state !== 'published') missing()
    const publicCategories = rows(
        F + 'ForumCategory',
        { siteId: p.siteId, publicationState: 'published' },
        1000,
    )
        .filter((c) => categoryAccess(c.contactListId, null)?.canRead)
        .map((c) => c.contactListId)
    const topics = []
    for (const t of Array.from(
        find(F + 'ForumTopic', {
            siteId: p.siteId,
            kind: 'category',
            ...(p.contactListId ? { contactListId: p.contactListId } : {}),
        })
            .orderBy('-lastActivity,rootCommEventId')
            .limit(100)
            .list(),
    )) {
        const event = one(E + 'CommunicationEvent', {
                communicationEventId: t.rootCommEventId,
            }),
            state = one(F + 'ForumPostState', {
                communicationEventId: t.rootCommEventId,
            })
        if (
            event &&
            state?.visibility === 'approved' &&
            t.unlisted !== 'Y' &&
            publicCategories.includes(event.contactListId) &&
            sourceGate(t.rootCommEventId, null)
        )
            topics.push({
                id: t.rootCommEventId,
                title: event.subject,
                date: event.entryDate,
            })
    }
    const host = one(S + 'PublicSiteHost', { siteId: p.siteId, canonical: 'Y' })
    if (!host) missing()
    const mount = one(S + 'PublicSiteApp', {
        siteId: p.siteId,
        app: 'forum',
        enabled: 'Y',
    })
    if (!mount) missing()
    const base =
        'https://' +
        host.hostname +
        (mount.pathPrefix === '/' ? '' : mount.pathPrefix)
    const escape = (t) =>
        String(t || '').replace(
            /[&<>"']/g,
            (c) =>
                ({
                    '&': '&amp;',
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&apos;',
                })[c],
        )
    const link = (t) =>
        base +
        '/t/' +
        encodeURIComponent(t.id) +
        '/' +
        encodeURIComponent(slugify(t.title))
    if (p.format === 'sitemap')
        return {
            contentType: 'application/xml',
            body:
                '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
                topics
                    .map((t) => '<url><loc>' + escape(link(t)) + '</loc></url>')
                    .join('') +
                '</urlset>',
        }
    if (p.format === 'atom')
        return {
            contentType: 'application/atom+xml',
            body:
                '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"><id>' +
                escape(base) +
                '</id><title>' +
                escape(s.name) +
                '</title><updated>' +
                new Date(topics[0]?.date || now()).toISOString() +
                '</updated>' +
                topics
                    .map(
                        (t) =>
                            '<entry><id>' +
                            escape(link(t)) +
                            '</id><title>' +
                            escape(t.title) +
                            '</title><link href="' +
                            escape(link(t)) +
                            '"/><updated>' +
                            new Date(t.date).toISOString() +
                            '</updated></entry>',
                    )
                    .join('') +
                '</feed>',
        }
    return {
        contentType: 'application/rss+xml',
        body:
            '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>' +
            escape(s.name) +
            '</title><link>' +
            escape(base) +
            '</link><description>Community topics</description>' +
            topics
                .map(
                    (t) =>
                        '<item><guid>' +
                        escape(link(t)) +
                        '</guid><title>' +
                        escape(t.title) +
                        '</title><link>' +
                        escape(link(t)) +
                        '</link></item>',
                )
                .join('') +
            '</channel></rss>',
    }
}

methods.getPostLocation = (p) => {
    const state = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!state) missing()
    const { event, a } = topic(state.rootCommEventId, p.siteId)
    const post = one(E + 'CommunicationEvent', {
        communicationEventId: p.postId,
    })
    if (!postVisible(state, post, a) || state.visibility === 'deleted')
        missing()
    return {
        rootCommEventId: state.rootCommEventId,
        slug: slugify(event.subject),
        postId: p.postId,
        kind: one(F + 'ForumTopic', { rootCommEventId: state.rootCommEventId })
            ?.kind,
    }
}
methods.getEditablePost = (p) => {
    requireUser()
    const state = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!state) missing()
    const { event: root, a } = topic(state.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!canEditPost(state, event, a))
        fail('Unauthorized', 'Editing is not permitted')
    return {
        draft: {
            postId: p.postId,
            wiki: state.wiki === 'Y',
            postRevision: Number(state.revision),
            rootCommEventId: state.rootCommEventId,
            contactListId: event.contactListId,
            title: root.subject,
            body: StringUtilities.cleanHtml(event.body || ''),
            mode: 'edit',
            attachments: rows(
                F + 'ForumAttachment',
                { siteId: p.siteId, communicationEventId: p.postId },
                100,
            ).map((value) => ({
                ...pick(
                    value,
                    'attachmentId filename mimeType byteSize scanState altText',
                ),
                finalized: true,
            })),
        },
    }
}
/* ---- Stage 2 participation: tags, reactions, accepted answers, polls, bookmarks, history ---- */
const TOP_PERIODS = {
    day: 86400000,
    week: 7 * 86400000,
    month: 30 * 86400000,
    year: 365 * 86400000,
    all: 0,
}
const REACTIONS = ['like', 'thanks', 'insightful', 'agree', 'laugh']
const tagKey = (name) =>
    String(name || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
function resolveTag(siteId, name) {
    const key = tagKey(name)
    const tag =
        one(F + 'ForumTag', { siteId, normalizedName: key }) ||
        (() => {
            const alias = one(F + 'ForumTagAlias', {
                siteId,
                normalizedName: key,
            })
            return alias ? one(F + 'ForumTag', { tagId: alias.tagId }) : null
        })()
    if (!tag || !tagDiscoverable(tag)) missing()
    return tag
}
/* A tag limited to categories the reader cannot discover stays hidden, so it reveals none of them. */
function tagDiscoverable(tag) {
    const allowed = json(tag.allowedCategories, [])
    return (
        !allowed.length ||
        allowed.some((id) => {
            const a = categoryAccess(id)
            return a && (a.canDiscover || a.canReadOwn || a.canModerate)
        })
    )
}
const topicTags = (root) =>
    rows(F + 'ForumTopicTag', { rootCommEventId: root }, 10)
        .map((v) => one(F + 'ForumTag', { tagId: v.tagId })?.name)
        .filter(Boolean)
        .sort()
function setTopicTags(siteId, root, a, names) {
    if (!Array.isArray(names) || names.length > 5)
        invalid('A topic may have at most five tags')
    for (const old of rows(F + 'ForumTopicTag', { rootCommEventId: root }, 10))
        old.delete()
    const seen = new Set()
    for (const name of names) {
        if (typeof name !== 'string') invalid('Invalid tag')
        const tag = resolveTag(siteId, name)
        const allowed = json(tag.allowedCategories, [])
        if (allowed.length && !allowed.includes(a.category.contactListId))
            invalid('Tag ' + tag.name + ' is not used in this category')
        if (seen.has(tag.tagId)) continue
        seen.add(tag.tagId)
        create(F + 'ForumTopicTag', {
            rootCommEventId: root,
            tagId: tag.tagId,
            siteId,
        })
    }
}
/* The accepted answer shows only while its reply is visible to this reader. */
function visibleAnswer(t, a) {
    if (!t.acceptedAnswerId) return null
    const st = one(F + 'ForumPostState', {
        communicationEventId: t.acceptedAnswerId,
    })
    return st?.visibility === 'approved' ? t.acceptedAnswerId : null
}
methods.findTags = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const pg = page(p, 'tags:' + p.siteId + ':' + (p.query || ''))
        let q = find(F + 'ForumTag', { siteId: p.siteId })
        if (p.query)
            q = q.condition(
                'normalizedName',
                'like',
                '%' + tagKey(p.query).replace(/[%_\\]/g, '\\$&') + '%',
            )
        const candidates = Array.from(
            q
                .orderBy('normalizedName,tagId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        const list = []
        for (const tag of candidates.slice(0, pg.limit)) {
            if (!tagDiscoverable(tag)) continue
            // Count only topics this reader may see; the inspected window is bounded.
            let count = 0
            for (const tt of rows(
                F + 'ForumTopicTag',
                { tagId: tag.tagId },
                1000,
            ))
                try {
                    const { t, a } = topic(tt.rootCommEventId, p.siteId)
                    if (t.unlisted !== 'Y' || a.canModerate) count++
                } catch (e) {
                    if (e.moquiErrorKind !== 'NotFound') throw e
                }
            list.push({
                ...pick(tag, 'tagId name description revision'),
                allowedCategories: json(tag.allowedCategories, []),
                topicCount: count,
            })
        }
        return {
            tagList: list,
            nextCursor:
                candidates.length > pg.limit
                    ? pg.next(pg.offset + pg.limit)
                    : null,
        }
    })
methods.storeTag = (p) =>
    receipt(p, 'storeTag', () => {
        site(p.siteId)
        staff(p.siteId)
        const key = tagKey(p.name)
        if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(key))
            invalid('A tag name has 1–40 letters, numbers or hyphens')
        const allowed = p.allowedCategories || []
        if (!Array.isArray(allowed) || allowed.length > 50)
            invalid('Invalid category list')
        for (const id of allowed) category(id, p.siteId)
        let tag = p.tagId ? one(F + 'ForumTag', { tagId: p.tagId }, true) : null
        if (p.tagId && (!tag || tag.siteId !== p.siteId)) missing()
        if (tag) revision(tag, p.expectedRevision)
        const clash =
            one(F + 'ForumTag', { siteId: p.siteId, normalizedName: key }) ||
            one(F + 'ForumTagAlias', { siteId: p.siteId, normalizedName: key })
        if (clash && clash.tagId !== tag?.tagId)
            fail('Conflict', 'That tag name is already used')
        const fields = {
            name: String(p.name).trim(),
            normalizedName: key,
            description: p.description || '',
            allowedCategories: JSON.stringify(allowed),
            revision: Number(tag?.revision || 0) + 1,
        }
        tag = tag
            ? update(tag, fields)
            : create(F + 'ForumTag', {
                  tagId: id(),
                  siteId: p.siteId,
                  createdAt: now(),
                  ...fields,
              })
        audit(
            p.siteId,
            null,
            'tag',
            tag.tagId,
            'store',
            p.reason || '',
            fields.revision - 1,
            fields.revision,
        )
        bump(p.siteId)
        return { tagId: tag.tagId, revision: fields.revision }
    })
/* Merging moves every topic to the target and keeps the old name as an alias, so old tag links still resolve. */
methods.mergeTag = (p) =>
    receipt(p, 'mergeTag', () => {
        site(p.siteId)
        staff(p.siteId)
        const source = one(F + 'ForumTag', { tagId: p.tagId }, true),
            target = one(F + 'ForumTag', { tagId: p.targetTagId }, true)
        if (
            !source ||
            !target ||
            source.siteId !== p.siteId ||
            target.siteId !== p.siteId ||
            source.tagId === target.tagId
        )
            missing()
        revision(source, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        let moved = 0
        for (;;) {
            const batch = rows(
                F + 'ForumTopicTag',
                { tagId: source.tagId },
                200,
            )
            for (const tt of batch) {
                if (
                    !one(F + 'ForumTopicTag', {
                        rootCommEventId: tt.rootCommEventId,
                        tagId: target.tagId,
                    })
                )
                    create(F + 'ForumTopicTag', {
                        rootCommEventId: tt.rootCommEventId,
                        tagId: target.tagId,
                        siteId: p.siteId,
                    })
                tt.delete()
                moved++
            }
            if (batch.length < 200) break
        }
        for (const alias of rows(
            F + 'ForumTagAlias',
            { tagId: source.tagId },
            1000,
        ))
            update(alias, { tagId: target.tagId })
        create(F + 'ForumTagAlias', {
            siteId: p.siteId,
            normalizedName: source.normalizedName,
            tagId: target.tagId,
            createdAt: now(),
        })
        source.delete()
        update(target, { revision: Number(target.revision) + 1 })
        audit(
            p.siteId,
            null,
            'tag',
            target.tagId,
            'merge',
            p.reason,
            null,
            Number(target.revision),
        )
        bump(p.siteId)
        return { tagId: target.tagId, movedTopics: moved }
    })
/* The desired state for one reaction: repeating it changes nothing. Counts are kept on the post under its lock. */
methods.setReaction = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    if (!REACTIONS.includes(p.reactionKey)) invalid('Unknown reaction')
    if (typeof p.active !== 'boolean') invalid('active must be true or false')
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a)) missing()
    if (!a.canReact || st.visibility !== 'approved')
        fail('Unauthorized', 'Reacting is not permitted')
    if (event.fromPartyId === partyId)
        fail('Unauthorized', 'You cannot react to your own post')
    const key = {
            communicationEventId: p.postId,
            partyId,
            reactionKey: p.reactionKey,
        },
        old = one(F + 'ForumReaction', key)
    if (!!old === p.active)
        return { reactions: json(st.reactionCounts, {}), active: p.active }
    const counts = json(st.reactionCounts, {}),
        delta = p.active ? 1 : -1
    if (p.active)
        create(F + 'ForumReaction', {
            ...key,
            rootCommEventId: st.rootCommEventId,
            createdAt: now(),
        })
    else old.delete()
    counts[p.reactionKey] = Math.max(
        0,
        Number(counts[p.reactionKey] || 0) + delta,
    )
    if (!counts[p.reactionKey]) delete counts[p.reactionKey]
    update(st, {
        reactionCounts: JSON.stringify(counts),
        reactionCount: Math.max(0, Number(st.reactionCount || 0) + delta),
    })
    update(t, {
        reactionCount: Math.max(0, Number(t.reactionCount || 0) + delta),
    })
    return { reactions: counts, active: p.active }
}
/* Q&A categories only. Accepting never closes the topic; closure stays the root's CeResolved status. */
methods.acceptAnswer = (p) => {
    requireUser()
    site(p.siteId)
    const { t, event: root, a } = topic(p.rootCommEventId, p.siteId, true)
    revision(t, p.expectedRevision)
    if (a.category.mode !== 'qa')
        invalid('Accepted answers are used in Q&A categories')
    if (!a.canModerate && !(root.fromPartyId === me() && a.canReply))
        fail(
            'Unauthorized',
            'Only the question author or a moderator accepts an answer',
        )
    if (p.postId) {
        const st = one(F + 'ForumPostState', { communicationEventId: p.postId })
        if (
            !st ||
            st.rootCommEventId !== t.rootCommEventId ||
            st.communicationEventId === t.rootCommEventId ||
            st.visibility !== 'approved'
        )
            invalid('The answer must be a visible reply in this topic')
    }
    const before = Number(t.revision)
    update(t, { acceptedAnswerId: p.postId || null, revision: before + 1 })
    audit(
        p.siteId,
        a.category.contactListId,
        'topic',
        t.rootCommEventId,
        p.postId ? 'answer-accepted' : 'answer-cleared',
        p.reason || '',
        before,
        before + 1,
    )
    bump(p.siteId)
    return { acceptedAnswerId: p.postId || null, revision: before + 1 }
}
function validPoll(poll) {
    if (!poll || typeof poll !== 'object' || Array.isArray(poll))
        invalid('Invalid poll')
    const options = poll.options
    if (
        !poll.question ||
        String(poll.question).length > 250 ||
        !Array.isArray(options) ||
        options.length < 2 ||
        options.length > 20 ||
        options.some(
            (o) => typeof o !== 'string' || !o.trim() || o.length > 200,
        ) ||
        new Set(options.map((o) => o.trim().toLowerCase())).size !==
            options.length
    )
        invalid('A poll needs a question and 2–20 distinct choices')
    const maxChoices = Number(poll.maxChoices || 1)
    if (
        !Number.isInteger(maxChoices) ||
        maxChoices < 1 ||
        maxChoices > options.length
    )
        invalid('Invalid number of choices')
    if (!['always', 'voted', 'closed'].includes(poll.resultsPolicy || 'voted'))
        invalid('Invalid results policy')
    if (poll.closesAt != null && !(millis(poll.closesAt) > millis(now())))
        invalid('A poll closes in the future')
    return {
        question: String(poll.question),
        options: options.map((o) => o.trim()),
        maxChoices,
        closesAt: poll.closesAt ?? null,
        resultsPolicy: poll.resultsPolicy || 'voted',
        revealVoters: poll.revealVoters === true,
        allowChange: poll.allowChange !== false,
    }
}
function createPoll(siteId, root, postId, input) {
    const poll = validPoll(input),
        pollId = id()
    create(F + 'ForumPoll', {
        pollId,
        siteId,
        communicationEventId: postId,
        rootCommEventId: root,
        question: poll.question,
        maxChoices: poll.maxChoices,
        closesAt: poll.closesAt,
        resultsPolicy: poll.resultsPolicy,
        revealVoters: poll.revealVoters ? 'Y' : 'N',
        allowChange: poll.allowChange ? 'Y' : 'N',
        voterCount: 0,
        revision: 1,
    })
    poll.options.forEach((label, index) =>
        create(F + 'ForumPollOption', {
            pollId,
            optionId: String(index + 1),
            sequenceNum: index + 1,
            label,
            voteCount: 0,
        }),
    )
    return pollId
}
function pollAccess(p, lock) {
    const poll = one(F + 'ForumPoll', { pollId: p.pollId }, lock)
    if (!poll || poll.siteId !== p.siteId) missing()
    const st = one(F + 'ForumPostState', {
            communicationEventId: poll.communicationEventId,
        }),
        { a } = topic(poll.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: poll.communicationEventId,
        })
    if (!st || !postVisible(st, event, a) || st.visibility === 'deleted')
        missing()
    return { poll, a, approved: st.visibility === 'approved' }
}
methods.getPoll = (p) => {
    const { poll, a, approved } = pollAccess(p)
    const partyId = me(),
        mine = partyId
            ? rows(
                  F + 'ForumPollVote',
                  { pollId: poll.pollId, partyId },
                  20,
              ).map((v) => v.optionId)
            : [],
        closed = !!poll.closesAt && millis(poll.closesAt) <= millis(now())
    const showResults =
        poll.resultsPolicy === 'always' ||
        closed ||
        (poll.resultsPolicy === 'voted' && mine.length > 0) ||
        a.canModerate
    const options = Array.from(
        find(F + 'ForumPollOption', { pollId: poll.pollId })
            .orderBy('sequenceNum')
            .list(),
    ).map((o) => ({
        optionId: o.optionId,
        label: o.label,
        voteCount: showResults ? Number(o.voteCount || 0) : null,
        voters:
            showResults && poll.revealVoters === 'Y'
                ? rows(
                      F + 'ForumPollVote',
                      { pollId: poll.pollId, optionId: o.optionId },
                      100,
                  )
                      .map(
                          (v) =>
                              one(S + 'PublicSiteProfile', {
                                  siteId: p.siteId,
                                  partyId: v.partyId,
                              })?.handle,
                      )
                      .filter(Boolean)
                : null,
    }))
    return {
        poll: {
            ...pick(
                poll,
                'pollId question maxChoices closesAt resultsPolicy revealVoters allowChange revision',
            ),
            postId: poll.communicationEventId,
            voterCount: showResults ? Number(poll.voterCount || 0) : null,
            closed,
            myChoices: mine,
            options,
            canVote:
                approved &&
                a.canVote &&
                !closed &&
                (!mine.length || poll.allowChange === 'Y'),
        },
    }
}
/* One ballot per party, replaced whole under the poll lock; choices are fixed once the poll exists. */
methods.votePoll = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    const { poll, a, approved } = pollAccess(p, true)
    if (!approved || !a.canVote) fail('Unauthorized', 'Voting is not permitted')
    if (poll.closesAt && millis(poll.closesAt) <= millis(now()))
        fail('Conflict', 'This poll is closed')
    const choices = [...new Set(p.optionIds || [])]
    if (!choices.length || choices.length > Number(poll.maxChoices))
        invalid('Choose from 1 to ' + poll.maxChoices + ' options')
    const options = new Map(
        rows(F + 'ForumPollOption', { pollId: poll.pollId }, 20).map((o) => [
            o.optionId,
            o,
        ]),
    )
    if (choices.some((c) => !options.has(c))) invalid('Unknown choice')
    const old = rows(F + 'ForumPollVote', { pollId: poll.pollId, partyId }, 20)
    if (old.length && poll.allowChange !== 'Y')
        fail('Conflict', 'Votes in this poll cannot be changed')
    for (const v of old) {
        const o = options.get(v.optionId)
        update(o, { voteCount: Math.max(0, Number(o.voteCount || 0) - 1) })
        v.delete()
    }
    for (const optionId of choices) {
        const o = options.get(optionId)
        update(o, { voteCount: Number(o.voteCount || 0) + 1 })
        create(F + 'ForumPollVote', {
            pollId: poll.pollId,
            partyId,
            optionId,
            votedAt: now(),
        })
    }
    update(poll, {
        voterCount: Number(poll.voterCount || 0) + (old.length ? 0 : 1),
        revision: Number(poll.revision) + 1,
    })
    return methods.getPoll({ siteId: p.siteId, pollId: poll.pollId })
}
/* Bookmarks are personal and never reveal a target the owner can no longer read. */
function bookmarkTarget(siteId, postId) {
    const st = one(F + 'ForumPostState', { communicationEventId: postId })
    if (!st) missing()
    const { event: root, a } = topic(st.rootCommEventId, siteId),
        event = one(E + 'CommunicationEvent', { communicationEventId: postId })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    return { st, root }
}
methods.storeBookmark = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    if (p.note != null && p.note.length > 1000)
        invalid('A note has at most 1000 characters')
    if (p.remindAt != null && !(millis(p.remindAt) > millis(now())))
        invalid('A reminder is in the future')
    let b = p.bookmarkId
        ? one(F + 'ForumBookmark', { bookmarkId: p.bookmarkId }, true)
        : one(
              F + 'ForumBookmark',
              { partyId, communicationEventId: p.postId },
              true,
          )
    if (b && (b.partyId !== partyId || b.siteId !== p.siteId)) missing()
    const postId = b?.communicationEventId || p.postId
    if (!postId) invalid('A post is required')
    const { st } = bookmarkTarget(p.siteId, postId)
    if (b) revision(b, p.expectedRevision)
    else if (Number(p.expectedRevision || 0) !== 0)
        fail('Conflict', 'Bookmark changed; reload')
    const fields = {
        note: p.note ?? b?.note ?? '',
        remindAt: p.remindAt ?? null,
        remindedAt: null,
        revision: Number(b?.revision || 0) + 1,
    }
    b = b
        ? update(b, fields)
        : create(F + 'ForumBookmark', {
              bookmarkId: id(),
              siteId: p.siteId,
              partyId,
              rootCommEventId: st.rootCommEventId,
              communicationEventId: postId,
              createdAt: now(),
              ...fields,
          })
    return { bookmarkId: b.bookmarkId, revision: fields.revision }
}
methods.removeBookmark = (p) => {
    const partyId = requireUser()
    site(p.siteId)
    const b = one(F + 'ForumBookmark', { bookmarkId: p.bookmarkId })
    if (!b || b.partyId !== partyId || b.siteId !== p.siteId) missing()
    b.delete()
    return { removed: true }
}
methods.findBookmarks = (p) =>
    withAccessMemo(() => {
        site(p.siteId)
        const partyId = requireUser(),
            pg = page(p, 'bookmarks:' + p.siteId)
        const list = Array.from(
            find(F + 'ForumBookmark', { siteId: p.siteId, partyId })
                .orderBy('-createdAt,bookmarkId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        return {
            bookmarkList: list.slice(0, pg.limit).map((b) => {
                const base = pick(
                    b,
                    'bookmarkId note remindAt createdAt revision',
                )
                try {
                    const { root } = bookmarkTarget(
                        p.siteId,
                        b.communicationEventId,
                    )
                    return {
                        ...base,
                        postId: b.communicationEventId,
                        rootCommEventId: b.rootCommEventId,
                        title: root.subject,
                    }
                } catch (e) {
                    if (e.moquiErrorKind !== 'NotFound') throw e
                    return {
                        ...base,
                        unavailable: true,
                        title: 'Unavailable post',
                    }
                }
            }),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    })
/* Worker: one in-app notice per due reminder, each in its own transaction so one bad row does not stop the rest. */
function remindBookmarks() {
    let sent = 0,
        failed = 0
    for (const b of Array.from(
        find(F + 'ForumBookmark', { remindedAt: null })
            .condition('remindAt', 'less-equals', now())
            .orderBy('remindAt')
            .limit(200)
            .list(),
    ))
        try {
            ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name('mantle.forum.ForumServices.remind#Bookmark')
                .parameters({ bookmarkId: b.bookmarkId })
                .call()
            sent++
        } catch (e) {
            failed++
            ec.logger.error(
                'Bookmark reminder ' +
                    b.bookmarkId +
                    ' failed: ' +
                    String(e?.message || e).split('\n')[0],
            )
        }
    return { sent, failed }
}
function remindBookmark(bookmarkId) {
    const b = one(F + 'ForumBookmark', { bookmarkId }, true)
    if (!b || b.remindedAt || !b.remindAt) return { sent: false }
    update(b, { remindedAt: now() })
    // The reminder notice resolves its post again when listed, so a lost permission hides it.
    const outboxId = id()
    create(F + 'ForumOutbox', {
        outboxId,
        siteId: b.siteId,
        communicationEventId: b.communicationEventId,
        eventType: 'reminder',
        state: 'complete',
        createdAt: now(),
    })
    create(F + 'ForumDelivery', {
        deliveryId: id(),
        revision: 1,
        outboxId,
        siteId: b.siteId,
        partyId: b.partyId,
        channel: 'in-app',
        state: 'sent',
        attempts: 1,
        dueAt: now(),
    })
    return { sent: true }
}
/* History follows current access: staff and the author see every revision, other readers the public ones. */
function historyAccess(p) {
    const st = one(F + 'ForumPostState', { communicationEventId: p.postId })
    if (!st) missing()
    const { a } = topic(st.rootCommEventId, p.siteId),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    const all = a.canModerate || event.fromPartyId === me()
    const permitted = (r) => all || r.publicHistoryAllowed === 'Y'
    return { st, event, a, permitted }
}
const revisionText = (html) =>
    String(html || '')
        .replace(/<\/(p|div|h[1-6]|li|blockquote|pre|tr)>|<br\s*\/?>/gi, '\n')
        .split('\n')
        .map(plainText)
        .filter((line) => line)
        .join('\n') + '\n'
methods.getPostHistory = (p) => {
    const { st, event, permitted } = historyAccess(p)
    const list = Array.from(
        find(F + 'ForumPostRevision', { communicationEventId: p.postId })
            .orderBy('-revision')
            .limit(200)
            .list(),
    )
        .filter(permitted)
        .map((r) => {
            const editor = one(S + 'PublicSiteProfile', {
                siteId: p.siteId,
                partyId: r.editorPartyId,
            })
            return {
                ...pick(r, 'revision editedAt reason'),
                editor: pick(editor, 'handle displayName'),
                current: Number(r.revision) === Number(st.revision),
            }
        })
    return {
        postId: p.postId,
        rootCommEventId: st.rootCommEventId,
        revision: Number(st.revision),
        canRestore: canEditPost(st, event, historyAccess(p).a),
        revisionList: list,
    }
}
methods.comparePostRevisions = (p) => {
    const { permitted } = historyAccess(p)
    const load = (n) => {
        const r = one(F + 'ForumPostRevision', {
            communicationEventId: p.postId,
            revision: Number(n),
        })
        if (!r || !permitted(r)) missing()
        return r
    }
    const from = load(p.fromRevision),
        to = load(p.toRevision)
    const diff = ec.resource.textDiff(
        revisionText(from.sanitizedBody),
        revisionText(to.sanitizedBody),
        'Revision ' + from.revision,
        'Revision ' + to.revision,
    )
    return {
        diff: {
            html: diff.html,
            unifiedDiff: diff.unifiedDiff,
            stats: diff.stats,
            fromRevision: Number(from.revision),
            toRevision: Number(to.revision),
        },
    }
}
/* Restoring writes a new revision through the normal edit path, so sanitizing, review and conflicts all apply. */
methods.restorePostRevision = (p) => {
    requireUser()
    const { permitted } = historyAccess(p)
    const r = one(F + 'ForumPostRevision', {
        communicationEventId: p.postId,
        revision: Number(p.revision),
    })
    if (!r || !permitted(r)) missing()
    return methods.updatePost({
        siteId: p.siteId,
        postId: p.postId,
        body: r.sourceText || r.sanitizedBody,
        expectedRevision: p.expectedRevision,
        reason: p.reason || 'Restored revision ' + r.revision,
    })
}
methods.deletePost = (p) => {
    requireUser()
    site(p.siteId)
    const st = one(
        F + 'ForumPostState',
        { communicationEventId: p.postId },
        true,
    )
    if (!st) missing()
    const { t, a } = topic(st.rootCommEventId, p.siteId, true),
        event = one(E + 'CommunicationEvent', {
            communicationEventId: p.postId,
        })
    if (!postVisible(st, event, a) || st.visibility === 'deleted') missing()
    revision(st, p.expectedRevision)
    const author =
        event.fromPartyId === me() &&
        millis(now()) - millis(event.entryDate) <= editWindowMs(p.siteId)
    if (!a.canModerate && !author)
        fail('Unauthorized', 'Ask a moderator to remove this post')
    if (a.canModerate && event.fromPartyId !== me() && !p.reason)
        invalid('Staff deletions require a reason')
    if (
        !a.canModerate &&
        find(F + 'ForumPostSearch', {
            rootCommEventId: st.rootCommEventId,
            parentCommEventId: p.postId,
        })
            .condition('visibility', 'in', ['approved', 'pending'])
            .count() > 0
    )
        fail(
            'Conflict',
            'Replies depend on this post; ask a moderator to remove it',
        )
    softDelete(st, event, t, a, p.reason)
    if (a.canModerate)
        audit(
            p.siteId,
            a.category.contactListId,
            'post',
            p.postId,
            'delete',
            p.reason || '',
            Number(st.revision) - 1,
            Number(st.revision),
        )
    bump(p.siteId)
    return { postId: p.postId, revision: Number(st.revision), state: 'deleted' }
}
/* ---- Stage 2 moderation: versioned policy, trust, content rules, flag hiding, classifier, topic tools, timers ---- */
const TRUST_EFFECTS = {
    new: { topics: 3, replies: 10, links: 2, images: 1, mentions: 2 },
    basic: { topics: 10, replies: 50, links: 10, images: 10, mentions: 5 },
    member: { topics: 20, replies: 100, links: 20, images: 20, mentions: 10 },
    regular: { topics: 20, replies: 100, links: 20, images: 20, mentions: 10 },
}
const editWindowMs = (siteId) => policy(siteId).editWindowHours * 3600000
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
/* Reading telemetry is measured on the server from the reader's own position updates, never from client counters. */
function recordReading(siteId, partyId, newlyRead, firstVisit) {
    const m = memberStateFor(siteId, partyId),
        day = String(now()).slice(0, 10),
        gap = m.lastReadAt ? millis(now()) - millis(m.lastReadAt) : 0
    update(m, {
        postsRead: Number(m.postsRead || 0) + Math.min(100, newlyRead),
        topicsEntered: Number(m.topicsEntered || 0) + (firstVisit ? 1 : 0),
        readingSeconds:
            Number(m.readingSeconds || 0) +
            (gap > 0 && gap < 300000
                ? Math.min(60, Math.floor(gap / 1000))
                : 0),
        visitDays: Number(m.visitDays || 0) + (m.lastVisitDay === day ? 0 : 1),
        lastVisitDay: day,
        lastReadAt: now(),
    })
}
/* Starting a conversation is a separate permission: site policy, minimum trust and current sanctions. */
function startAccess(siteId) {
    const m = member(siteId),
        pol = policy(siteId)
    if (
        !active(m) ||
        m.state !== 'active' ||
        sanctioned(siteId, me(), null, 'suspend') ||
        sanctioned(siteId, me(), null, 'silence')
    )
        fail('Unauthorized', 'Messaging is not permitted')
    if (!pol.privateEnabled)
        fail('Unauthorized', 'Private messages are turned off on this site')
    if (trustRank(trustLevel(siteId)) < trustRank(pol.privateMinTrust))
        fail(
            'Unauthorized',
            'Your trust level cannot start private messages yet',
        )
    return {
        ...conversationAccess({ siteId, rootCommEventId: '' }),
        canStartTopic: true,
        canReply: true,
        canEdit: true,
        canUpload: true,
    }
}
/* Recipients are active members of this site, named by handle. One generic error never reveals which name failed. */
function recipients(siteId, handles, exclude) {
    if (!Array.isArray(handles) || !handles.length)
        invalid('Name at least one recipient')
    const out = []
    for (const handle of [...new Set(handles.map((h) => String(h).trim()))]) {
        const v = handle
                ? one(S + 'PublicSiteProfile', { siteId, handle })
                : null,
            m = v ? member(siteId, v.partyId) : null
        if (
            !v ||
            !active(m) ||
            m.state !== 'active' ||
            sanctioned(siteId, v.partyId, null, 'suspend') ||
            memberBlocks(siteId, v.partyId, me()) ||
            memberBlocks(siteId, me(), v.partyId)
        )
            invalid('One or more recipients cannot receive private messages')
        if (!exclude.includes(v.partyId)) out.push(v.partyId)
    }
    return [...new Set(out)]
}
function addParticipant(root, partyId, role) {
    const old = one(
        F + 'ForumParticipant',
        { rootCommEventId: root, partyId },
        true,
    )
    if (old) {
        if (old.endedAt)
            update(old, {
                endedAt: null,
                role,
                addedByPartyId: me(),
                addedAt: now(),
            })
        return
    }
    create(F + 'ForumParticipant', {
        rootCommEventId: root,
        partyId,
        role,
        addedByPartyId: me(),
        addedAt: now(),
    })
}
const activeParticipants = (root) =>
    rows(F + 'ForumParticipant', { rootCommEventId: root, endedAt: null }, 100)
/* Internal participants keep per-message receipts in Comms; public participants use topic markers only. */
function allocatePrivate(postId, root, author) {
    for (const v of activeParticipants(root)) {
        if (v.partyId === author || !internalParty(v.partyId)) continue
        create(E + 'CommunicationEventParty', {
            communicationEventId: postId,
            partyId: v.partyId,
            roleTypeId: 'MessageTo',
            statusId: 'CepReceived',
        })
    }
}
function participantProjection(siteId, root) {
    return activeParticipants(root).map((v) => ({
        ...pick(
            one(S + 'PublicSiteProfile', { siteId, partyId: v.partyId }),
            'handle displayName',
        ),
        role: v.role,
        addedAt: v.addedAt,
    }))
}
methods.createConversation = (p) =>
    methods.publishPost({
        siteId: p.siteId,
        participantHandles: p.participantHandles,
        title: p.title,
        body: p.body,
        attachmentIds: p.attachmentIds,
        operationId: p.operationId,
    })
methods.findConversations = (p) => {
    site(p.siteId)
    const partyId = requireUser(),
        view = p.view || 'inbox'
    if (!['inbox', 'archived'].includes(view)) invalid('Invalid view')
    // Suspension or an ended membership removes private access, the list included.
    const m = member(p.siteId)
    if (
        !active(m) ||
        m.state !== 'active' ||
        sanctioned(p.siteId, partyId, null, 'suspend')
    )
        return { conversationList: [], nextCursor: null }
    const pg = page(p, 'conversations:' + p.siteId + ':' + view)
    let q = find(F + 'ForumConversationMember', {
        siteId: p.siteId,
        partyId,
        kind: 'private',
        endedAt: null,
    })
    q = q.condition(
        'archivedAt',
        view === 'inbox' ? 'equals' : 'not-equals',
        null,
    )
    const list = Array.from(
        q
            .orderBy('-lastActivity,rootCommEventId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        conversationList: list.slice(0, pg.limit).map((v) => {
            const event = one(E + 'CommunicationEvent', {
                    communicationEventId: v.rootCommEventId,
                }),
                marker = readingBoundary(v.rootCommEventId, p.siteId, null)
            return {
                rootCommEventId: v.rootCommEventId,
                title: event?.subject,
                lastActivity: v.lastActivity,
                visiblePostCount: v.visiblePostCount,
                participants: participantProjection(p.siteId, v.rootCommEventId)
                    .map((x) => x.displayName || x.handle)
                    .filter(Boolean)
                    .slice(0, 10),
                unreadCount: find(F + 'ForumPostSearch', {
                    rootCommEventId: v.rootCommEventId,
                    visibility: 'approved',
                })
                    .condition(
                        'ordinal',
                        'greater',
                        Number(marker?.consumedOrdinal || 0),
                    )
                    .condition('fromPartyId', 'not-equals', partyId)
                    .count(),
            }
        }),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
/* Owners add people (who then see the whole history, so it is confirmed), remove people and name other owners. */
methods.updateParticipants = (p) => {
    requireUser()
    site(p.siteId)
    const { t, a } = topic(p.rootCommEventId, p.siteId, true)
    if (t.kind !== 'private') missing()
    if (!a.isOwner)
        fail('Unauthorized', 'Only a conversation owner changes participants')
    revision(t, p.expectedRevision)
    const pol = policy(p.siteId),
        current = activeParticipants(t.rootCommEventId).map((v) => v.partyId)
    if (p.participantHandles?.length) {
        if (p.confirm !== true)
            invalid(
                'Confirm that new participants will see the whole conversation',
            )
        if (!pol.privateEnabled)
            fail('Unauthorized', 'Private messages are turned off on this site')
        const added = recipients(p.siteId, p.participantHandles, current)
        if (current.length + added.length > pol.privateRecipientLimit + 1)
            invalid(
                'A conversation has at most ' +
                    pol.privateRecipientLimit +
                    ' recipients',
            )
        for (const partyId of added)
            addParticipant(t.rootCommEventId, partyId, 'member')
    }
    const byHandle = (handle) => {
        const v = one(S + 'PublicSiteProfile', { siteId: p.siteId, handle })
        const row = v
            ? one(
                  F + 'ForumParticipant',
                  {
                      rootCommEventId: t.rootCommEventId,
                      partyId: v.partyId,
                  },
                  true,
              )
            : null
        if (!row || row.endedAt) invalid('Not a current participant: ' + handle)
        return row
    }
    for (const handle of p.ownerHandles || [])
        update(byHandle(handle), { role: 'owner' })
    for (const handle of p.targetHandles || [])
        update(byHandle(handle), { endedAt: now() })
    if (!activeParticipants(t.rootCommEventId).some((v) => v.role === 'owner'))
        fail('Conflict', 'A conversation keeps at least one owner')
    update(t, { revision: Number(t.revision) + 1 })
    bump(p.siteId)
    return {
        revision: Number(t.revision),
        participants: participantProjection(p.siteId, t.rootCommEventId),
    }
}
/* Archive is a personal list preference; leaving ends the participant's access, including old attachments. */
methods.setConversationState = (p) => {
    requireUser()
    site(p.siteId)
    const { t } = topic(p.rootCommEventId, p.siteId, true)
    if (t.kind !== 'private') missing()
    const row = one(
        F + 'ForumParticipant',
        { rootCommEventId: t.rootCommEventId, partyId: me() },
        true,
    )
    if (p.action === 'archive' || p.action === 'unarchive')
        update(row, { archivedAt: p.action === 'archive' ? now() : null })
    else if (p.action === 'leave') {
        const others = activeParticipants(t.rootCommEventId).filter(
            (v) => v.partyId !== me(),
        )
        if (
            row.role === 'owner' &&
            others.length &&
            !others.some((v) => v.role === 'owner')
        )
            fail('Conflict', 'Make another participant an owner before leaving')
        update(row, { endedAt: now() })
        bump(p.siteId)
    } else invalid('Invalid conversation action')
    return { state: p.action }
}
/* A member's own mute or block of another member; it is never shown to the other member. */
methods.setMemberPreference = (p) => {
    site(p.siteId)
    const partyId = requireUser()
    if (!active(member(p.siteId)) || member(p.siteId).state !== 'active')
        fail('Unauthorized', 'Active membership is required')
    const v = one(S + 'PublicSiteProfile', {
        siteId: p.siteId,
        handle: p.targetHandle,
    })
    if (!v || v.partyId === partyId) missing()
    if (!['mute', 'block', 'none'].includes(p.preference))
        invalid('Preference must be mute, block or none')
    if (p.expiresAt != null && !(millis(p.expiresAt) > millis(now())))
        invalid('An expiry is in the future')
    const key = { siteId: p.siteId, partyId, targetPartyId: v.partyId },
        old = one(F + 'ForumMemberPreference', key, true)
    if (p.preference === 'none') {
        if (old) old.delete()
    } else if (old)
        update(old, {
            preference: p.preference,
            expiresAt: p.expiresAt ?? null,
            revision: Number(old.revision || 0) + 1,
        })
    else
        create(F + 'ForumMemberPreference', {
            ...key,
            preference: p.preference,
            expiresAt: p.expiresAt ?? null,
            revision: 1,
        })
    return { preference: p.preference }
}
const memberMutes = (siteId, partyId, targetPartyId) => {
    const v =
        partyId && targetPartyId
            ? one(F + 'ForumMemberPreference', {
                  siteId,
                  partyId,
                  targetPartyId,
              })
            : null
    return (
        !!v &&
        ['mute', 'block'].includes(v.preference) &&
        (!v.expiresAt || millis(v.expiresAt) > millis(now()))
    )
}
/* A route address is lower case with no plus tag; its domain must be one the operator registered. */
function routeAddress(address) {
    const value = String(address || '')
        .trim()
        .toLowerCase()
    const m = /^([a-z0-9._-]{1,64})@([a-z0-9.-]{1,190})$/.exec(value)
    if (!m) invalid('A route address is local@domain without a plus tag')
    const domains = String(System.getProperty('pass_route_domains') || '')
        .split(',')
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean)
    if (!domains.includes(m[2]))
        invalid('The route domain is not registered for this deployment')
    return value
}
methods.storeRoute = (p) =>
    receipt(p, 'storeRoute', () => {
        site(p.siteId, true)
        const address = routeAddress(p.address)
        if (p.contactListId) {
            const c = one(F + 'ForumCategory', {
                contactListId: p.contactListId,
            })
            if (!c || c.siteId !== p.siteId) missing()
        }
        let r = p.routeId
            ? one(F + 'ForumMailRoute', { routeId: p.routeId }, true)
            : null
        if (p.routeId && (!r || r.siteId !== p.siteId)) missing()
        if (r) revision(r, p.expectedRevision)
        const clash = one(F + 'ForumMailRoute', { address })
        if (clash && clash.routeId !== r?.routeId)
            fail('Conflict', 'That address is already routed')
        const fields = {
            address,
            contactListId: p.contactListId || null,
            enabled: p.active === false ? 'N' : 'Y',
            revision: Number(r?.revision || 0) + 1,
        }
        r = r
            ? update(r, fields)
            : create(F + 'ForumMailRoute', {
                  routeId: id(),
                  siteId: p.siteId,
                  createdAt: now(),
                  ...fields,
              })
        audit(
            p.siteId,
            fields.contactListId,
            'route',
            r.routeId,
            'store',
            address,
            fields.revision - 1,
            fields.revision,
        )
        return { routeId: r.routeId, revision: fields.revision }
    })
methods.findRoutes = (p) => {
    site(p.siteId, true)
    return {
        routeList: rows(F + 'ForumMailRoute', { siteId: p.siteId }, 200).map(
            (r) => pick(r, 'routeId address contactListId enabled revision'),
        ),
    }
}
/* Inbound outcomes for staff: addresses masked, no message text. */
methods.findInboundReceipts = (p) => {
    site(p.siteId, true)
    const pg = page(p, 'inbound:' + p.siteId)
    const list = Array.from(
        find(F + 'ForumInboundReceipt', { siteId: p.siteId })
            .orderBy('-createdAt,receiptId')
            .offset(pg.offset)
            .limit(pg.limit + 1)
            .list(),
    )
    return {
        receiptList: list.slice(0, pg.limit).map((r) => ({
            ...pick(
                r,
                'receiptId routeId result reason postId attempts createdAt revision',
            ),
            sender: String(r.senderAddress || '').replace(
                /^(.).*(@.*)$/,
                '$1…$2',
            ),
        })),
        nextCursor:
            list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
    }
}
/* A bounded test: one notice to the actor's own verified address, replying to the route. */
methods.testRoute = (p) => {
    site(p.siteId, true)
    const r = one(F + 'ForumMailRoute', { routeId: p.routeId })
    if (!r || r.siteId !== p.siteId) missing()
    const settings = one(F + 'ForumMailSettings', { siteId: p.siteId }),
        ua = ec.user.userAccount
    if (!settings) fail('Conflict', 'Configure outbound mail first')
    if (
        !ua?.emailAddress ||
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        fail('Conflict', 'Your own address must be verified')
    const out = ec.service
        .sync()
        .throwOnError(true)
        .name('org.moqui.impl.EmailServices.send#EmailTemplate')
        .parameters({
            emailTemplateId: settings.templateId,
            toAddresses: ua.emailAddress,
            replyToAddresses: r.address,
            bodyParameters: {
                title: 'Forum mail route test: replies go to ' + r.address,
                siteId: p.siteId,
                unsubscribeUrl: '',
            },
        })
        .call()
    return { sent: !!out.messageId, messageId: out.messageId || null }
}
/* The scoped reply address for one recipient of one thread, minted when the notice is sent. */
function replyAddress(siteId, rootCommEventId, contactListId, partyId) {
    // The category's first route, else a site-wide route; the oldest wins so the address is stable.
    const first = (fields) =>
        Array.from(
            find(F + 'ForumMailRoute', { siteId, enabled: 'Y', ...fields })
                .orderBy('createdAt,routeId')
                .limit(1)
                .list(),
        )[0]
    const route =
        (contactListId && first({ contactListId })) ||
        first({ contactListId: null })
    if (!route) return null
    const token = ec.user.randomString(32)
    create(F + 'ForumReplyToken', {
        tokenHash: hash(token),
        siteId,
        routeId: route.routeId,
        rootCommEventId,
        partyId,
        expiresAt: millis(now()) + 90 * 86400000,
    })
    const [local, domain] = route.address.split('@')
    return local + '+' + token + '@' + domain
}
const headerValues = (headers, name) => {
    const v = headers?.[name]
    return v == null ? [] : Array.isArray(v) ? v.map(String) : [String(v)]
}
/* The address in a header value; a reply token in its plus tag keeps its case. */
const bareAddress = (text) =>
    (
        /<([^<>@\s]+@[^<>\s]+)>/.exec(String(text || ''))?.[1] ||
        /([^<>"\s,;]+@[^<>"\s,;]+)/.exec(String(text || ''))?.[1] ||
        ''
    ).trim()
const messageIds = (text) =>
    String(text || '').match(/<[^<>\s]+@[^<>\s]+>/g) || []
/* Conservative reply text: drop quoted lines, the attribution before them and anything after a signature marker. */
function replyText(text) {
    const out = []
    for (const line of String(text || '')
        .replace(/\r\n?/g, '\n')
        .split('\n')) {
        if (/^-- ?$/.test(line) || /^-{2,}\s*Original Message/i.test(line))
            break
        if (/^On .+wrote:\s*$/i.test(line)) break
        if (/^\s*>/.test(line)) continue
        out.push(line)
    }
    return out.join('\n').trim()
}
const textHtml = (text) =>
    text
        .split(/\n{2,}/)
        .map(
            (para) =>
                '<p>' +
                WebUtilities.encodeHtml(para).replace(/\n/g, '<br>') +
                '</p>',
        )
        .join('')
/* The handler for one stored inbound email (an email ECA). It never creates accounts, trusts only the gateway's kept
   Authentication-Results, posts through the same publish gate as the web as the verified sender, and records one
   receipt per message identity so alias copies and replays do not post twice. Not forum mail is left alone. */
function processInbound(ctx) {
    const headers = ctx.headers || {},
        fields = ctx.fields || {}
    const recipients = [
        ...headerValues(headers, 'delivered-to'),
        ...headerValues(headers, 'original-recipient').map((v) =>
            v.replace(/^rfc822;/i, ''),
        ),
    ]
        .map(bareAddress)
        .filter(Boolean)
    // Without envelope evidence (an IMAP-synced copy), the visible recipients identify the route only.
    if (!recipients.length)
        for (const v of [...(fields.toList || []), ...(fields.ccList || [])])
            recipients.push(bareAddress(v))
    let route = null,
        tag = null
    for (const address of recipients) {
        const m = /^([^@+]+)(?:\+([^@]+))?@(.+)$/.exec(address)
        if (!m) continue
        const r = one(F + 'ForumMailRoute', {
            address: (m[1] + '@' + m[3]).toLowerCase(),
        })
        if (r && r.enabled === 'Y') {
            route = r
            tag = m[2] || null
            break
        }
    }
    if (!route) return { handled: false }
    const siteId = route.siteId,
        sender = bareAddress(fields.from).toLowerCase(),
        messageId =
            headerValues(headers, 'message-id')[0] ||
            ctx.message?.messageId ||
            '',
        parts = ctx.bodyPartList || [],
        textPart = parts.find(
            (b) => /^text\/plain/i.test(b.contentType || '') && !b.filename,
        ),
        htmlPart = parts.find(
            (b) => /^text\/html/i.test(b.contentType || '') && !b.filename,
        ),
        rawText = textPart
            ? textPart.contentText
            : plainText(htmlPart?.contentText || ''),
        subject = String(fields.subject || '').trim(),
        fingerprint = hash(
            subject + '\n' + String(rawText || '').slice(0, 20000),
        )
    const receiptId = hash(
        siteId + '|' + (messageId || fingerprint) + '|' + sender,
    )
    const old = one(F + 'ForumInboundReceipt', { receiptId }, true)
    if (old && !['failed'].includes(old.result)) {
        if (old.fingerprint !== fingerprint)
            ec.logger.warn(
                'Forum inbound ' +
                    receiptId +
                    ' reused a message identity with different content; ignored',
            )
        return { handled: true, result: 'duplicate', receiptId }
    }
    const record = (result, reason, postId) => {
        const values = {
            siteId,
            routeId: route.routeId,
            messageId: String(messageId).slice(0, 250),
            senderAddress: sender.slice(0, 250),
            fingerprint,
            emailMessageId: ctx.emailMessageId || null,
            result,
            reason: reason || null,
            postId: postId || null,
            attempts: Number(old?.attempts || 0) + 1,
        }
        if (old)
            update(old, { ...values, revision: Number(old.revision || 1) + 1 })
        else
            create(F + 'ForumInboundReceipt', {
                receiptId,
                createdAt: now(),
                revision: 1,
                ...values,
            })
        return { handled: true, result, reason, postId, receiptId }
    }
    // Reports, auto-replies and our own mail are never posts.
    const contentType = headerValues(headers, 'content-type').join(' ')
    if (
        /multipart\/report/i.test(contentType) ||
        /^(mailer-daemon|postmaster)@/i.test(sender)
    )
        return record('bounce', bounce(siteId, parts) || 'Delivery report')
    const auto = headerValues(headers, 'auto-submitted')[0]
    if (
        (auto && !/^no$/i.test(auto.trim())) ||
        /^(bulk|junk|list|auto_reply)$/i.test(
            headerValues(headers, 'precedence')[0] || '',
        ) ||
        headerValues(headers, 'x-autoreply').length ||
        headerValues(headers, 'x-autorespond').length
    )
        return record('ignored', 'Automatic message')
    const settings = one(F + 'ForumMailSettings', { siteId })
    if (
        settings &&
        sender === String(settings.senderAddress || '').toLowerCase()
    )
        return record('ignored', 'Message from this forum')
    // The sender must be a verified account address, and the trusted gateway must have authenticated the domain.
    const account = Array.from(
        find('moqui.security.UserAccount', {})
            .condition('emailAddress', 'equals', sender)
            .limit(2)
            .list(),
    ).filter((u) => u.disabled !== 'Y')
    const ua = account.length === 1 ? account[0] : null
    if (
        !ua ||
        !ua.partyId ||
        !one('moqui.security.public.VerifiedAddress', {
            userId: ua.userId,
            emailAddress: ua.emailAddress,
        })
    )
        return record('held', 'Sender is not a verified account address')
    const domain = sender.split('@')[1]
    // Each method result is read with its own properties: DMARC must pass for this From domain, or one DKIM
    // signature must pass for this domain or a parent of it (relaxed alignment). Another domain's pass counts for nothing.
    const aligned = (d) => {
        const signer = String(d || '')
            .replace(/^@/, '')
            .toLowerCase()
        return !!signer && (domain === signer || domain.endsWith('.' + signer))
    }
    const authenticated = headerValues(headers, 'authentication-results').some(
        (value) =>
            String(value)
                .split(';')
                .slice(1)
                .some((result) => {
                    const r = result.trim()
                    const prop = (name) =>
                        new RegExp('\\b' + name + '=([^\\s;]+)', 'i').exec(
                            r,
                        )?.[1]
                    if (/^dmarc=pass\b/i.test(r))
                        return (
                            String(
                                prop('header\\.from') || '',
                            ).toLowerCase() === domain
                        )
                    if (/^dkim=pass\b/i.test(r))
                        return aligned(
                            prop('header\\.d') ||
                                prop('header\\.i')?.split('@').pop(),
                        )
                    return false
                }),
    )
    if (!authenticated)
        return record(
            'held',
            'Sender domain was not authenticated by the mail gateway',
        )
    // The target: a reply token issued to this sender, else a thread this sender was mailed, else a new topic.
    let root = null
    if (tag) {
        const t = one(F + 'ForumReplyToken', { tokenHash: hash(tag) })
        if (
            !t ||
            t.siteId !== siteId ||
            t.revokedAt ||
            millis(t.expiresAt) <= millis(now())
        )
            return record('rejected', 'The reply address has expired')
        if (t.partyId !== ua.partyId)
            return record(
                'held',
                'The reply address was issued to another member',
            )
        root = t.rootCommEventId
    } else {
        for (const ref of [
            ...messageIds(headerValues(headers, 'in-reply-to').join(' ')),
            ...messageIds(
                headerValues(headers, 'references').join(' '),
            ).reverse(),
        ]) {
            const d = Array.from(
                find(F + 'ForumDelivery', {
                    siteId,
                    partyId: ua.partyId,
                    channel: 'email',
                    providerId: ref,
                })
                    .limit(1)
                    .list(),
            )[0]
            const box = d
                ? one(F + 'ForumOutbox', { outboxId: d.outboxId })
                : null
            const st = box
                ? one(F + 'ForumPostState', {
                      communicationEventId: box.communicationEventId,
                  })
                : null
            if (st) {
                root = st.rootCommEventId
                break
            }
        }
        if (!root && !route.contactListId)
            return record(
                'rejected',
                'Reply to a forum email or write to a category address',
            )
    }
    const body = replyText(rawText)
    if (!body) return record('rejected', 'The message has no new text')
    const files = parts.filter((b) => b.filename && b.contentBytes).slice(0, 10)
    try {
        // Its own transaction: a refusal rolls back every write of the attempt, and this receipt still records it.
        const out = ec.service
            .sync()
            .requireNewTransaction(true)
            .throwOnError(true)
            .name('mantle.forum.DeliveryServices.post#Inbound')
            .parameters({
                input: {
                    siteId,
                    username: ua.username,
                    rootCommEventId: root,
                    contactListId: root ? null : route.contactListId,
                    title:
                        subject
                            .replace(/^((re|fwd?|aw):\s*)+/i, '')
                            .slice(0, 250) || 'Message by email',
                    body: textHtml(body),
                    files: files.map((b) => ({
                        filename: b.filename,
                        contentType: String(b.contentType || '')
                            .split(';')[0]
                            .trim(),
                        contentBytes: b.contentBytes,
                    })),
                    operationId: hash(receiptId)
                        .replace(/[^A-Za-z0-9_-]/g, '')
                        .slice(0, 60),
                },
            })
            .call().result
        const result = record(
            out.state === 'pending' ? 'pending' : 'posted',
            out.held ? 'Some attachments were held for scanning' : null,
            out.postId,
        )
        feedback(
            siteId,
            ua,
            out.state === 'pending'
                ? 'Your email was received and is waiting for review.'
                : null,
        )
        return result
    } catch (e) {
        ec.message.clearErrors()
        const kind = e?.moquiErrorKind
        const reason = String(e?.message || e)
            .split('\n')[0]
            .replace(/^(Error: )+/, '')
            .slice(0, 300)
        // Refusals by policy are final and told to the member; a posting interval or outage is kept for a retry.
        if (
            ['Unauthorized', 'Unprocessable', 'NotFound', 'Conflict'].includes(
                kind,
            )
        ) {
            feedback(
                siteId,
                ua,
                'Your email was not posted: ' +
                    (kind === 'NotFound'
                        ? 'the discussion is not available'
                        : reason),
            )
            return record('rejected', reason)
        }
        ec.logger.error('Forum inbound ' + receiptId + ' failed: ' + reason)
        return record('failed', reason)
    }
}
/* Worker step: post one inbound email as its verified sender through the web's own gate, staging its files first. */
function postInbound(p) {
    const previous = ec.user.username
    ec.user.internalLoginUser(p.username)
    try {
        const scope = p.rootCommEventId
            ? { rootCommEventId: p.rootCommEventId }
            : { contactListId: p.contactListId }
        const attachmentIds = []
        let held = false
        for (const b of p.files || []) {
            const bytes = b.contentBytes
            const staged = methods.stageAttachment({
                siteId: p.siteId,
                ...scope,
                file: {
                    name: b.filename,
                    size: bytes.length ?? bytes.byteLength ?? 0,
                    contentType: b.contentType,
                    write: (location) =>
                        ec.resource
                            .getLocationReference(location)
                            .putBytes(bytes),
                },
            }).attachment
            if (staged.scanState === 'clean')
                attachmentIds.push(staged.attachmentId)
            else held = true
        }
        const out = methods.publishPost({
            siteId: p.siteId,
            ...scope,
            ...(p.rootCommEventId ? {} : { title: p.title }),
            body: p.body,
            attachmentIds,
            operationId: p.operationId,
        })
        return { postId: out.postId, state: out.state, held }
    } finally {
        ec.user.logoutUser()
        if (previous) ec.user.internalLoginUser(previous)
    }
}
/* A safe outcome notice to a verified member: what happened, never another thread's content. */
function feedback(siteId, ua, text) {
    if (!text) return
    const settings = one(F + 'ForumMailSettings', { siteId })
    if (!settings) return
    try {
        ec.service
            .sync()
            .requireNewTransaction(true)
            .throwOnError(true)
            .name('org.moqui.impl.EmailServices.send#EmailTemplate')
            .parameters({
                emailTemplateId: settings.templateId,
                toAddresses: ua.emailAddress,
                bodyParameters: { title: text, siteId, unsubscribeUrl: '' },
            })
            .call()
    } catch (e) {
        ec.message.clearErrors()
        ec.logger.warn(
            'Forum inbound feedback to a member failed: ' +
                String(e?.message || e).split('\n')[0],
        )
    }
}
/* A delivery report for one of our messages: a permanent failure stops email to that member until they choose again. */
function bounce(siteId, parts) {
    const text = parts.map((b) => b.contentText || '').join('\n')
    const permanent = /^Status:\s*5\.\d+\.\d+/im.test(text)
    for (const ref of messageIds(text)) {
        const d = Array.from(
            find(F + 'ForumDelivery', {
                siteId,
                channel: 'email',
                providerId: ref,
            })
                .limit(1)
                .list(),
        )[0]
        if (!d) continue
        if (!permanent) return 'Temporary delivery report for ' + d.deliveryId
        update(d, {
            state: 'failed',
            lastError: 'Hard bounce reported',
            revision: Number(d.revision || 0) + 1,
        })
        const key = {
            siteId,
            partyId: d.partyId,
            scopeType: 'site',
            scopeId: '_SITE_',
        }
        const pref = one(F + 'ForumDeliveryPreference', key, true)
        const values = {
            ...key,
            emailMode: 'None',
            suppressed: 'Y',
            optOutAt: now(),
            revision: Number(pref?.revision || 0) + 1,
        }
        pref
            ? update(pref, values)
            : create(F + 'ForumDeliveryPreference', values)
        return 'Hard bounce for delivery ' + d.deliveryId
    }
    return null
}
/* Staff retry of a failed receipt from the stored email; the stored message is never deleted by the handler. */
methods.retryInbound = (p) => {
    site(p.siteId, true)
    const r = one(F + 'ForumInboundReceipt', { receiptId: p.receiptId })
    if (!r || r.siteId !== p.siteId) missing()
    if (r.result !== 'failed')
        fail('Conflict', 'Only a failed message is retried')
    const email = one('moqui.basic.email.EmailMessage', {
        emailMessageId: r.emailMessageId,
    })
    if (!email) fail('Conflict', 'The stored email is no longer available')
    const headers = {}
    for (const line of String(email.headersString || '').split(/\r?\n/)) {
        const m = /^([A-Za-z0-9-]+):\s*(.*)$/.exec(line)
        if (m) {
            const key = m[1].toLowerCase()
            headers[key] = headers[key] ? [].concat(headers[key], m[2]) : m[2]
        }
    }
    if (email.messageId && !headers['message-id'])
        headers['message-id'] = email.messageId
    if (email.inReplyTo && !headers['in-reply-to'])
        headers['in-reply-to'] = email.inReplyTo
    return processInbound({
        emailMessageId: email.emailMessageId,
        headers,
        fields: {
            from: email.fromAddress,
            subject: email.subject,
            toList: String(email.toAddresses || '').split(','),
        },
        bodyPartList: [
            {
                contentType: 'text/plain',
                contentText: email.bodyText || plainText(email.body || ''),
            },
        ],
    })
}
function execute(operation, p) {
    const schema = ec.resource.script(
        'component://mr-mantle/service/mantle/forum/ForumSchema.js',
    )[operation]
    if (!schema) missing()
    for (const field of Object.keys(p || {}))
        if (!schema.fields.includes(field))
            invalid('Unsupported field: ' + field)
    for (const key of [
        'siteId',
        'contactListId',
        'rootCommEventId',
        'postId',
        'draftId',
        'reviewId',
        'targetPartyId',
        'title',
        'body',
        'handle',
        'name',
        'reason',
        'token',
    ])
        if (p?.[key] != null && typeof p[key] !== 'string')
            invalid('Invalid field type: ' + key)
    for (const key of [
        'attachmentIds',
        'renderedPostIds',
        'deliveryIds',
        'tags',
        'optionIds',
        'allowedCategories',
        'postIds',
        'reviewIds',
        'participantHandles',
        'targetHandles',
        'ownerHandles',
        'qualifyingSources',
    ])
        if (
            p?.[key] != null &&
            (!Array.isArray(p[key]) ||
                p[key].length > 100 ||
                p[key].some(
                    (value) => typeof value !== 'string' || value.length > 40,
                ))
        )
            invalid('Invalid list field: ' + key)
    const numeric = new Set([
        'expectedRevision',
        'expectedGeneration',
        'sequenceNum',
        'limit',
        'ordinal',
        'before',
        'after',
        'postRevision',
        'fromRevision',
        'toRevision',
        'revision',
        'slowIntervalSeconds',
        'deliveryDays',
        'inboundDays',
        'deletedPostDays',
        'jobDays',
        'invitationDays',
    ])
    const booleans = new Set([
        'confirm',
        'confirmAudience',
        'approvalRequired',
        'markUnread',
        'jump',
        'all',
        'active',
        'locked',
        'includeOwn',
        'dryRun',
        'mine',
        'sourceFrozen',
    ])
    const listFields = new Set([
        'attachmentIds',
        'renderedPostIds',
        'deliveryIds',
        'tags',
        'optionIds',
        'allowedCategories',
        'postIds',
        'reviewIds',
        'participantHandles',
        'targetHandles',
        'ownerHandles',
        'qualifyingSources',
    ])
    for (const [key, value] of Object.entries(p || {})) {
        if (value == null) continue
        if (numeric.has(key)) {
            if (
                !['number', 'string'].includes(typeof value) ||
                !Number.isInteger(Number(value))
            )
                invalid('Invalid numeric field: ' + key)
        } else if (booleans.has(key)) {
            if (typeof value !== 'boolean')
                invalid('Invalid Boolean field: ' + key)
        } else if (listFields.has(key)) continue
        else if (
            ['expiresAt', 'fromDate', 'thruDate', 'remindAt', 'dueAt'].includes(
                key,
            )
        ) {
            if (!['number', 'string'].includes(typeof value))
                invalid('Invalid date field: ' + key)
        } else if (key === 'poll') {
            if (typeof value !== 'object' || Array.isArray(value))
                invalid('Invalid poll')
        } else if (key === 'mappings') {
            // Import decisions: a bounded list of plain objects of short strings.
            if (
                !Array.isArray(value) ||
                value.length > 1000 ||
                value.some(
                    (m) =>
                        !m ||
                        typeof m !== 'object' ||
                        Array.isArray(m) ||
                        Object.entries(m).some(
                            ([k, v]) =>
                                ![
                                    'mappingType',
                                    'sourceId',
                                    'decision',
                                    'targetId',
                                    'reason',
                                ].includes(k) ||
                                (v != null &&
                                    (typeof v !== 'string' || v.length > 200)),
                        ),
                )
            )
                invalid('Invalid import mappings')
        } else if (key === 'config') {
            if (typeof value !== 'object' || Array.isArray(value))
                invalid('Invalid policy configuration')
        } else if (key === 'file') {
            if (typeof value !== 'object') invalid('Invalid upload')
        } else if (['hosts', 'mounts'].includes(key)) {
            if (!Array.isArray(value) || value.length > 100)
                invalid('Invalid configuration list')
            const allowed =
                key === 'hosts'
                    ? ['hostname', 'canonical']
                    : ['appMountId', 'app', 'pathPrefix', 'enabled', 'targetId']
            for (const item of value) {
                if (
                    !item ||
                    typeof item !== 'object' ||
                    Array.isArray(item) ||
                    Object.keys(item).some((field) => !allowed.includes(field))
                )
                    invalid('Invalid configuration fields')
                for (const [field, data] of Object.entries(item))
                    if (
                        data != null &&
                        (['canonical', 'enabled'].includes(field)
                            ? typeof data !== 'boolean'
                            : typeof data !== 'string')
                    )
                        invalid('Invalid configuration field type')
            }
        } else if (typeof value !== 'string')
            invalid('Invalid field type: ' + key)
    }
    const fn = methods[operation]
    if (!fn) missing()
    const was = ec.artifactExecution.disableAuthz()
    try {
        return fn(p || {})
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
;({
    execute,
    categoryAccess,
    internalParty,
    internalMemberIds: core.internalMemberIds,
    capabilities,
    topic,
    postVisible,
    methods,
    legacyMarker,
    legacyReading,
    legacyMailboxSummary,
    protectListOwner,
    recordMailboxPost,
    addNamedReceipts,
    remindBookmarks,
    remindBookmark,
    recomputeTrust: moderation.recomputeTrust,
    recomputeMemberTrust: moderation.recomputeMemberTrust,
    classifyPosts: moderation.classifyPosts,
    classifyPost: moderation.classifyPost,
    fireTimers: moderation.fireTimers,
    fireTimer: moderation.fireTimer,
    conversationAccess,
    memberMutes,
    memberBlocks,
    policy,
    mentionHandles,
    plainText,
    processInbound,
    postInbound,
    replyAddress,
    applySubscription: integration.applySubscription,
    dispatchJobs: operations.dispatchJobs,
    advanceRun: operations.advanceRun,
    runJobItem: operations.runItem,
    cleanupExports: operations.cleanupExports,
    sourceGate,
})
