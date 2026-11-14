/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Forum moderation: flags and review, sanctions, policies and rules, trust, the classifier queue, topic actions
 * and restructuring, timers and operational runs. Forum.js calls this with the shared core and its methods map.
 */
;(core, methods) => {
    const {
        F,
        S,
        E,
        now,
        millis,
        stamp,
        id,
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
        member,
        isOperator,
        site,
        revision,
        bump,
        listMember,
        categoryAccess,
        category,
        topic,
        postVisible,
        trustLevel,
        json,
        page,
        receipt,
        protectOwner,
        review,
        audit,
        systemAudit,
        staff,
        allocateInternal,
        plainText,
        clearAnswer,
        softDelete,
        POLICY_NUMBERS,
        POLICY_FLAGS,
        POLICY_CHOICES,
        TRUST_ORDER,
        trustRank,
        policy,
        ruleRegex,
        censor,
        memberStateFor,
        memberBlocks,
    } = core
    methods.flagPost = (p) =>
        receipt(p, 'flagPost', () => {
            const st = one(F + 'ForumPostState', {
                communicationEventId: p.postId,
            })
            if (!st) missing()
            const { a } = topic(st.rootCommEventId, p.siteId, false, true)
            if (!a.canFlag)
                fail(
                    'Unauthorized',
                    a.writeRefusal || 'Reporting is not permitted',
                )
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: p.postId,
            })
            if (!postVisible(st, event, a)) missing()
            if (!p.reason) invalid('A reason is required')
            if (event.fromPartyId === me())
                invalid('Edit or delete your own post instead of reporting it')
            one(S + 'PublicSite', { siteId: p.siteId }, true)
            const r = review(
                p.siteId,
                a.category.contactListId,
                'post',
                p.postId,
                st.revision,
                'flag',
            )
            if (
                !one(F + 'ForumReviewReport', {
                    reviewId: r.reviewId,
                    reporterPartyId: requireUser(),
                })
            )
                create(F + 'ForumReviewReport', {
                    reviewId: r.reviewId,
                    reporterPartyId: me(),
                    reason: p.reason,
                    evidence: event.body,
                    createdAt: now(),
                })
            const lockedState = one(
                F + 'ForumPostState',
                { communicationEventId: p.postId },
                true,
            )
            const hidden = hideIfFlagged(
                p.siteId,
                lockedState,
                event,
                r.reviewId,
            )
            return { reviewId: r.reviewId, state: r.state, hidden }
        })
    /* Where the signed-in internal user moderates, for the Comms moderation mount: sites where they are an active
       owner or moderator, and bound categories where they are a list owner or moderator. A public account has no
       BOSS mount, so it gets none. */
    methods.findModerationScopes = () => {
        const partyId = me()
        const internal = !!partyId && core.internalParty(partyId)
        if (!internal) return { internal: false, scopeList: [] }
        const out = []
        const siteName = (siteId) =>
            one(S + 'PublicSite', { siteId })?.name || siteId
        const siteIds = isOperator()
            ? rows(S + 'PublicSite', {}, 200).map((s) => s.siteId)
            : rows(S + 'PublicSiteParty', { partyId }, 200)
                  .filter(
                      (m) =>
                          active(m) &&
                          m.state === 'active' &&
                          ['owner', 'moderator'].includes(m.role),
                  )
                  .map((m) => m.siteId)
        for (const siteId of siteIds) {
            try {
                staff(siteId, null)
                out.push({
                    siteId,
                    siteName: siteName(siteId),
                    contactListId: null,
                    name: siteName(siteId),
                })
            } catch (e) {
                ec.message.clearErrors()
            }
        }
        for (const lp of rows(
            'mantle.marketing.contact.ContactListParty',
            { partyId },
            500,
        ).filter(
            (lp) =>
                active(lp) &&
                ['ListOwner', 'ListModerator'].includes(lp.roleTypeId),
        )) {
            const c = one(F + 'ForumCategory', {
                contactListId: lp.contactListId,
            })
            if (!c || siteIds.includes(c.siteId)) continue
            if (!categoryAccess(c.contactListId, partyId)?.canModerate) continue
            out.push({
                siteId: c.siteId,
                siteName: siteName(c.siteId),
                contactListId: c.contactListId,
                name:
                    one('mantle.marketing.contact.ContactList', {
                        contactListId: c.contactListId,
                    })?.contactListName || c.contactListId,
            })
        }
        return { internal: true, scopeList: out }
    }
    methods.findReviews = (p) => {
        site(p.siteId)
        // The queue is the scope's staff's. An Owner of a record who is not staff of the scope asked for (a personal
        // repository's, or a repository whose Owner is not its group's) has a queue of their own: the items of the
        // records they moderate, found before the page is cut.
        let own = null
        try {
            staff(p.siteId, p.contactListId)
        } catch (e) {
            if (!['Unauthorized', 'NotFound'].includes(e.moquiErrorKind) || !me())
                throw e
            own = core
                .recordScopes(p.siteId)
                .filter((id) => !p.contactListId || id === p.contactListId)
            if (!own.length) throw e
        }
        const pg = page(
            p,
            'reviews:' + p.siteId + ':' + (p.contactListId || ''),
        )
        // A post of a record is its moderators' by recordAccess who may read that post: the Owners alone for a
        // confidential issue and for a staff post, never the category's or the site's staff who may not view it.
        const shownTo = (r) => {
            const record = core.reviewRecord(r)
            if (record) return core.reviewReadable(r, record)
            return (
                !own &&
                (!r.contactListId ||
                    categoryAccess(r.contactListId)?.canModerate)
            )
        }
        const fields =
            'reviewId targetType targetId targetRevision reasonFamily state revision claimedByPartyId claimExpiresAt createdAt linkedReviewId'
        const query = () => {
            let q = find(F + 'ForumReviewItem', {
                siteId: p.siteId,
                ...(p.contactListId ? { contactListId: p.contactListId } : {}),
            }).condition('state', 'in', ['pending', 'claimed'])
            if (own) q = q.condition('contactListId', 'in', own)
            return q.orderBy('createdAt,reviewId')
        }
        if (own) {
            // each row is decided before it counts toward the page; the cursor is the place to go on from
            const shown = []
            let from = pg.offset,
                nextCursor = null
            scan: for (;;) {
                const batch = Array.from(query().offset(from).limit(100).list())
                for (const [index, r] of batch.entries()) {
                    if (!shownTo(r)) continue
                    if (shown.length === pg.limit) {
                        nextCursor = pg.next(from + index)
                        break scan
                    }
                    shown.push(r)
                }
                if (batch.length < 100) break
                from += 100
            }
            return {
                reviewList: shown.map((r) => pick(r, fields)),
                nextCursor,
            }
        }
        const list = Array.from(
            query()
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        return {
            reviewList: list
                .slice(0, pg.limit)
                .filter(shownTo)
                .map((r) => pick(r, fields)),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    }
    methods.getReview = (p) => {
        const r = one(F + 'ForumReviewItem', {
            reviewId: p.reviewId,
            siteId: p.siteId,
        })
        if (!r) missing()
        core.reviewStaff(p.siteId, r)
        return {
            review: pick(
                r,
                'reviewId targetType targetId targetRevision reasonFamily state revision claimedByPartyId claimExpiresAt createdAt decisionReason linkedReviewId detail',
            ),
            post:
                r.targetType === 'post'
                    ? (() => {
                          const st = one(F + 'ForumPostState', {
                                  communicationEventId: r.targetId,
                              }),
                              event = one(E + 'CommunicationEvent', {
                                  communicationEventId: r.targetId,
                              })
                          return st && event
                              ? {
                                    title: event.subject,
                                    body: StringUtilities.cleanHtml(
                                        event.body || '',
                                    ),
                                    revision: st.revision,
                                }
                              : null
                      })()
                    : null,
            context:
                r.targetType === 'post'
                    ? (() => {
                          const st = one(F + 'ForumPostState', {
                              communicationEventId: r.targetId,
                          })
                          const t = st
                              ? one(F + 'ForumTopic', {
                                    rootCommEventId: st.rootCommEventId,
                                })
                              : null
                          return t?.kind === 'private'
                              ? privateContext(r, st)
                              : null
                      })()
                    : null,
            notes: rows(
                F + 'ForumReviewNote',
                { reviewId: r.reviewId },
                30,
            ).map((v) => pick(v, 'noteId staffPartyId noteText createdAt')),
            reports: rows(F + 'ForumReviewReport', {
                reviewId: r.reviewId,
            }).map((v) => pick(v, 'reporterPartyId reason evidence createdAt')),
        }
    }
    methods.addReviewNote = (p) =>
        receipt(p, 'addReviewNote', () => {
            const r = one(F + 'ForumReviewItem', {
                siteId: p.siteId,
                reviewId: p.reviewId,
            })
            if (!r) missing()
            core.reviewStaff(p.siteId, r)
            if (!p.body || p.body.length > 10000)
                invalid('A note of at most 10000 characters is required')
            const noteId = id()
            create(F + 'ForumReviewNote', {
                noteId,
                reviewId: r.reviewId,
                staffPartyId: requireUser(),
                noteText: p.body,
                createdAt: now(),
            })
            audit(
                p.siteId,
                r.contactListId,
                'review',
                r.reviewId,
                'note',
                'Staff note recorded',
                r.revision,
                r.revision,
            )
            return { noteId }
        })
    methods.claimReview = (p) => {
        requireUser()
        site(p.siteId)
        one(S + 'PublicSite', { siteId: p.siteId }, true)
        const r = one(
            F + 'ForumReviewItem',
            { reviewId: p.reviewId, siteId: p.siteId },
            true,
        )
        if (!r) missing()
        core.reviewStaff(p.siteId, r)
        revision(r, p.expectedRevision)
        if (!['pending', 'claimed'].includes(r.state))
            fail('Conflict', 'Review has ended')
        if (
            r.claimedByPartyId &&
            r.claimedByPartyId !== me() &&
            millis(r.claimExpiresAt) > millis(now())
        )
            fail('Conflict', 'Another moderator holds this review')
        update(r, {
            state: 'claimed',
            claimedByPartyId: requireUser(),
            claimExpiresAt: millis(now()) + 1800000,
            revision: Number(r.revision) + 1,
        })
        return { revision: Number(r.revision) }
    }
    methods.decideReview = (p) => {
        requireUser()
        site(p.siteId)
        one(S + 'PublicSite', { siteId: p.siteId }, true)
        const r = one(
            F + 'ForumReviewItem',
            { reviewId: p.reviewId, siteId: p.siteId },
            true,
        )
        if (!r) missing()
        core.reviewStaff(p.siteId, r)
        revision(r, p.expectedRevision)
        if (!['pending', 'claimed'].includes(r.state))
            fail('Conflict', 'Review has ended')
        if (
            !['approved', 'rejected', 'dismissed'].includes(p.decision) ||
            !p.reason
        )
            invalid('Decision and reason required')
        if (
            r.claimedByPartyId &&
            r.claimedByPartyId !== me() &&
            millis(r.claimExpiresAt) > millis(now())
        )
            fail('Conflict', 'Another moderator holds this review')
        if (r.targetType === 'post') {
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: r.targetId },
                true,
            )
            if (!st || Number(st.revision) !== Number(r.targetRevision))
                fail('Conflict', 'Post changed; review current evidence')
            const event = one(E + 'CommunicationEvent', {
                    communicationEventId: r.targetId,
                }),
                t = one(
                    F + 'ForumTopic',
                    { rootCommEventId: st.rootCommEventId },
                    true,
                )
            if (st.visibility === 'hidden' && p.decision !== 'rejected') {
                // A post hidden by reports returns when staff dismiss the reports or approve the post.
                update(st, { visibility: 'approved' })
                if (st.communicationEventId !== t.rootCommEventId)
                    update(t, {
                        visiblePostCount: Number(t.visiblePostCount) + 1,
                        revision: Number(t.revision) + 1,
                    })
            } else if (
                p.decision === 'approved' &&
                st.visibility === 'pending'
            ) {
                update(st, {
                    visibility: 'approved',
                    approvedRevision: st.revision,
                })
                update(t, {
                    visiblePostCount: Number(t.visiblePostCount) + 1,
                    lastActivity: now(),
                    revision: Number(t.revision) + 1,
                })
                const m = one(
                    F + 'ForumMemberState',
                    { siteId: p.siteId, partyId: event.fromPartyId },
                    true,
                )
                if (m)
                    update(m, {
                        approvedContributions:
                            Number(m.approvedContributions) + 1,
                    })
                // A record's post has no category of its own and no internal mailbox.
                if (t.kind !== 'record')
                    allocateInternal(
                        r.targetId,
                        event.contactListId,
                        event.fromPartyId,
                    )
                create(F + 'ForumOutbox', {
                    outboxId: id(),
                    siteId: p.siteId,
                    communicationEventId: r.targetId,
                    eventType: 'post',
                    state: 'pending',
                    createdAt: now(),
                })
            } else if (p.decision === 'rejected') {
                if (st.visibility === 'approved')
                    update(t, {
                        visiblePostCount: Math.max(
                            0,
                            Number(t.visiblePostCount) - 1,
                        ),
                        revision: Number(t.revision) + 1,
                    })
                update(st, { visibility: 'rejected' })
                clearAnswer(
                    t,
                    { category: { contactListId: r.contactListId } },
                    r.targetId,
                    p.reason,
                )
            }
        } else if (r.targetType === 'account') {
            const m = member(p.siteId, r.targetId)
            if (!m || Number(m.revision) !== Number(r.targetRevision))
                fail('Conflict', 'Membership changed')
            // Dismissing the review item is not a decision about the membership.
            if (p.decision !== 'dismissed')
                update(m, {
                    state: p.decision === 'approved' ? 'active' : 'ended',
                    stateSetByPartyId: me(),
                    revision: Number(m.revision) + 1,
                })
        }
        audit(
            p.siteId,
            r.contactListId,
            r.targetType,
            r.targetId,
            p.decision,
            p.reason,
            r.revision,
            Number(r.revision) + 1,
        )
        update(r, {
            state: p.decision,
            decisionReason: p.reason,
            revision: Number(r.revision) + 1,
        })
        bump(p.siteId)
        return { state: r.state, revision: Number(r.revision) }
    }
    const TOPIC_ACTIONS = [
        'close',
        'reopen',
        'title',
        'category',
        'wiki',
        'pin',
        'unpin',
        'unlist',
        'list',
        'slow',
        'timer',
        'delete',
        'restore',
        'move-posts',
        'split',
        'merge',
    ]
    methods.applyTopicAction = (p) => {
        requireUser()
        site(p.siteId)
        one(S + 'PublicSite', { siteId: p.siteId }, true)
        const { t, event, a } = topic(p.rootCommEventId, p.siteId, true)
        if (!a.canModerate) fail('Unauthorized', 'Moderator access required')
        revision(t, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        if (!TOPIC_ACTIONS.includes(p.action))
            invalid('Unsupported topic action')
        if (['move-posts', 'split', 'merge'].includes(p.action)) {
            // Each root change is one transaction: a failure leaves both topics as they were.
            const before = Number(t.revision),
                out = restructure(p, t, event, a)
            audit(
                p.siteId,
                event.contactListId,
                'topic',
                t.rootCommEventId,
                p.action,
                p.reason + ' → ' + out.rootCommEventId,
                before,
                before + 1,
            )
            bump(p.siteId)
            return { revision: before + 1, ...out }
        }
        if (p.action === 'category') {
            const target = category(p.targetContactListId, p.siteId)
            if (!target.canModerate)
                fail('Unauthorized', 'Destination moderator access required')
            if (p.confirmAudience !== true)
                invalid('Review and confirm the destination audience')
            if (
                Number(p.expectedGeneration) !==
                audienceRevision(p.siteId, a, target)
            )
                fail('Conflict', 'Audience changed; preview the move again')
            const cf = ec.entity.conditionFactory
            let after = ''
            const sourceListId = event.contactListId
            for (;;) {
                let query = find(E + 'CommunicationEvent', {
                    contactListId: sourceListId,
                }).condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition(
                                'communicationEventId',
                                'equals',
                                t.rootCommEventId,
                            ),
                            cf.makeCondition(
                                'rootCommEventId',
                                'equals',
                                t.rootCommEventId,
                            ),
                        ],
                        'or',
                    ),
                )
                if (after)
                    query = query.condition(
                        'communicationEventId',
                        'greater',
                        after,
                    )
                const events = Array.from(
                    query.orderBy('communicationEventId').limit(100).list(),
                )
                for (const item of events) {
                    update(item, { contactListId: p.targetContactListId })
                    find(F + 'ForumReviewItem', {
                        siteId: p.siteId,
                        targetType: 'post',
                        targetId: item.communicationEventId,
                    }).updateAll({ contactListId: p.targetContactListId })
                    for (const review of rows(
                        F + 'ForumReviewItem',
                        {
                            siteId: p.siteId,
                            targetType: 'post',
                            targetId: item.communicationEventId,
                        },
                        100,
                    ))
                        if (['pending', 'claimed'].includes(review.state))
                            update(review, {
                                state: 'pending',
                                claimedByPartyId: null,
                                claimExpiresAt: null,
                                revision: Number(review.revision) + 1,
                            })
                }
                after = events[events.length - 1]?.communicationEventId || after
                if (events.length < 100) break
            }
        } else if (p.action === 'title') {
            if (!p.title) invalid('Title required')
            update(event, { subject: p.title })
        } else if (['pin', 'unpin', 'unlist', 'list'].includes(p.action)) {
            update(
                t,
                p.action === 'pin' || p.action === 'unpin'
                    ? { pinned: p.action === 'pin' ? 'Y' : 'N' }
                    : { unlisted: p.action === 'unlist' ? 'Y' : 'N' },
            )
        } else if (p.action === 'slow') {
            const seconds = Number(p.slowIntervalSeconds || 0)
            if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86400)
                invalid('Slow mode is 0–86400 seconds')
            update(t, { slowIntervalSeconds: seconds })
        } else if (p.action === 'timer') {
            if (p.timerAction === 'cancel')
                find(F + 'ForumTopicTimer', {
                    rootCommEventId: t.rootCommEventId,
                    state: 'pending',
                }).updateAll({ state: 'cancelled', lastError: p.reason })
            else {
                if (!TIMER_ACTIONS.includes(p.timerAction))
                    invalid('Invalid timer action')
                if (!(millis(p.dueAt) > millis(now())))
                    invalid('A timer is due in the future')
                create(F + 'ForumTopicTimer', {
                    timerId: id(),
                    siteId: p.siteId,
                    rootCommEventId: t.rootCommEventId,
                    contactListId: event.contactListId,
                    action: p.timerAction,
                    dueAt: millis(p.dueAt),
                    state: 'pending',
                    reason: p.reason,
                    createdByPartyId: me(),
                    revision: 1,
                })
            }
        } else if (p.action === 'delete' || p.action === 'restore') {
            const postId = p.postId || t.rootCommEventId,
                st = one(
                    F + 'ForumPostState',
                    { communicationEventId: postId },
                    true,
                )
            if (!st || st.rootCommEventId !== t.rootCommEventId) missing()
            const isRoot = postId === t.rootCommEventId
            if (p.action === 'delete') {
                if (st.visibility === 'deleted')
                    fail('Conflict', 'Already deleted')
                // Deleting the root hides the whole topic from readers; replies keep their state for a restore.
                if (isRoot)
                    update(st, {
                        visibility: 'deleted',
                        deletedAt: now(),
                        deletedByPartyId: me(),
                        deleteReason: p.reason,
                    })
                else
                    softDelete(
                        st,
                        one(E + 'CommunicationEvent', {
                            communicationEventId: postId,
                        }),
                        t,
                        a,
                        p.reason,
                    )
            } else {
                if (!['deleted', 'hidden', 'rejected'].includes(st.visibility))
                    fail('Conflict', 'Post is not removed')
                // Retention replaced its text with a tombstone: there is nothing left to restore.
                if (st.textRemovedAt)
                    fail('Conflict', 'Retention removed this post\'s text; it cannot be restored')
                update(st, {
                    visibility: 'approved',
                    approvedRevision: st.revision,
                    deletedAt: null,
                    deletedByPartyId: null,
                    deleteReason: null,
                })
                if (!isRoot) recount(t)
            }
        } else if (p.action === 'wiki') {
            // Wiki mode opens one post to versioned edits by eligible members; every edit stays in its history.
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: p.postId },
                true,
            )
            if (!st || st.rootCommEventId !== t.rootCommEventId) missing()
            if (typeof p.active !== 'boolean')
                invalid('active must be true or false')
            update(st, { wiki: p.active ? 'Y' : 'N' })
        } else
            update(event, {
                statusId: p.action === 'close' ? 'CeResolved' : 'CeReceived',
            })
        audit(
            p.siteId,
            p.action === 'category'
                ? p.targetContactListId
                : event.contactListId,
            'topic',
            t.rootCommEventId,
            p.action,
            p.action === 'category'
                ? 'Moved from ' +
                      event.contactListId +
                      ' to ' +
                      p.targetContactListId +
                      ': ' +
                      p.reason
                : p.reason,
            t.revision,
            Number(t.revision) + 1,
        )
        update(t, {
            revision: Number(t.revision) + 1,
            ...(p.action === 'category'
                ? { contactListId: p.targetContactListId }
                : {}),
        })
        bump(p.siteId)
        return { revision: Number(t.revision) }
    }
    methods.findActions = (p) => {
        staff(p.siteId, p.contactListId)
        const pg = page(p, 'actions:' + p.siteId)
        const candidates = Array.from(
            find(F + 'ForumModerationAction', {
                siteId: p.siteId,
                ...(p.contactListId ? { contactListId: p.contactListId } : {}),
            })
                .orderBy('-createdAt,actionId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        return {
            nextCursor:
                candidates.length > pg.limit
                    ? pg.next(pg.offset + pg.limit)
                    : null,
            actionList: candidates
                .slice(0, pg.limit)
                .filter((v) => {
                    if (!['post', 'topic', 'review'].includes(v.targetType))
                        return true
                    try {
                        const review =
                            v.targetType === 'review'
                                ? one(F + 'ForumReviewItem', {
                                      reviewId: v.targetId,
                                  })
                                : null
                        const state =
                            v.targetType === 'post'
                                ? one(F + 'ForumPostState', {
                                      communicationEventId: v.targetId,
                                  })
                                : review?.targetType === 'post'
                                  ? one(F + 'ForumPostState', {
                                        communicationEventId: review.targetId,
                                    })
                                  : null
                        const root =
                            state?.rootCommEventId ||
                            (v.targetType === 'topic' ? v.targetId : null)
                        return (
                            !root ||
                            topic(root, p.siteId, false, true).a.canModerate
                        )
                    } catch (error) {
                        if (error.moquiErrorKind === 'NotFound') return false
                        throw error
                    }
                })
                .map((v) =>
                    pick(
                        v,
                        'actionId contactListId staffPartyId targetType targetId action reason beforeRevision afterRevision createdAt',
                    ),
                ),
        }
    }
    /* Staff act only on lower-ranked parties: operator > site owner > site moderator > list owner > list moderator > member. */
    function rank(siteId, contactListId, partyId, actor) {
        if (actor && isOperator()) return 5
        const m = member(siteId, partyId)
        const siteRole =
            active(m) && m.state === 'active'
                ? { owner: 4, moderator: 3 }[m.role] || 0
                : 0
        const lm = contactListId ? listMember(contactListId, partyId) : null
        const listRole = { ListOwner: 2, ListModerator: 1 }[lm?.roleTypeId] || 0
        return Math.max(siteRole, listRole)
    }
    function requireHigherRank(siteId, contactListId, targetPartyId) {
        const self = me()
        if (targetPartyId === self) invalid('Staff cannot sanction themselves')
        if (
            rank(siteId, contactListId, self, true) <=
            rank(siteId, contactListId, targetPartyId, false)
        )
            fail(
                'Unauthorized',
                'Only higher-ranked staff can sanction this member',
            )
    }
    methods.setSanction = (p) =>
        receipt(p, 'setSanction', () => {
            staff(p.siteId, p.contactListId)
            const target = member(p.siteId, p.targetPartyId)
            if (!target) missing()
            requireHigherRank(p.siteId, p.contactListId, p.targetPartyId)
            if (p.thruDate && millis(p.thruDate) <= millis(now()))
                invalid('Sanction expiry must be in the future')
            if (
                target.role === 'owner' &&
                p.kind === 'suspend' &&
                !p.contactListId
            )
                protectOwner(p.siteId, p.targetPartyId)
            if (!['silence', 'suspend'].includes(p.kind) || !p.reason)
                invalid('Sanction kind and reason required')
            const sanctionId = id()
            create(F + 'ForumSanction', {
                sanctionId,
                revision: 1,
                siteId: p.siteId,
                contactListId: p.contactListId,
                partyId: p.targetPartyId,
                kind: p.kind,
                fromDate: now(),
                thruDate: p.thruDate,
                reason: p.reason,
                staffPartyId: me(),
            })
            audit(
                p.siteId,
                p.contactListId,
                'member',
                p.targetPartyId,
                p.kind,
                p.reason,
                null,
                null,
            )
            bump(p.siteId)
            return { sanctionId }
        })
    methods.endSanction = (p) => {
        site(p.siteId)
        one(S + 'PublicSite', { siteId: p.siteId }, true)
        const sanction = one(
            F + 'ForumSanction',
            { siteId: p.siteId, sanctionId: p.sanctionId },
            true,
        )
        if (!sanction) missing()
        staff(p.siteId, sanction.contactListId)
        revision(
            { revision: Number(sanction.revision || 1) },
            p.expectedRevision,
        )
        if (!p.reason) invalid('A reason is required')
        const next = Number(sanction.revision || 1) + 1
        update(sanction, { thruDate: now(), revision: next })
        audit(
            p.siteId,
            sanction.contactListId,
            'member',
            sanction.partyId,
            'end-sanction',
            p.reason,
            next - 1,
            next,
        )
        bump(p.siteId)
        return { revision: next }
    }
    methods.getMember = (p) => {
        staff(p.siteId, p.contactListId)
        return {
            membership: pick(
                member(p.siteId, p.targetPartyId),
                'state role joinedAt revision',
            ),
            memberState: pick(
                one(F + 'ForumMemberState', {
                    siteId: p.siteId,
                    partyId: p.targetPartyId,
                }),
                'trustLevel trustLocked trustReason approvedContributions lastPostedAt topicsEntered postsRead readingSeconds visitDays revision',
            ),
            sanctionList: rows(F + 'ForumSanction', {
                siteId: p.siteId,
                partyId: p.targetPartyId,
                ...(p.contactListId ? { contactListId: p.contactListId } : {}),
            }).map((s) =>
                pick(
                    s,
                    'sanctionId revision contactListId kind fromDate thruDate reason',
                ),
            ),
        }
    }
    methods.getHealth = (p) => {
        site(p.siteId, true)
        const runs = methods.findRuns(p)
        return {
            backend: 'local',
            search: 'database',
            runList: runs.runList,
            nextCursor: runs.nextCursor,
            outboxLagSeconds: (() => {
                const first = Array.from(
                    find(F + 'ForumOutbox', {
                        siteId: p.siteId,
                        state: 'pending',
                    })
                        .orderBy('createdAt')
                        .limit(1)
                        .list(),
                )[0]
                return first
                    ? Math.max(
                          0,
                          Math.floor(
                              (millis(now()) - millis(first.createdAt)) / 1000,
                          ),
                      )
                    : 0
            })(),
            pendingOutbox: find(F + 'ForumOutbox', {
                siteId: p.siteId,
                state: 'pending',
            }).count(),
            failedDeliveries: find(F + 'ForumDelivery', {
                siteId: p.siteId,
                state: 'failed',
            }).count(),
            uncertainDeliveries: find(F + 'ForumDelivery', { siteId: p.siteId })
                .condition('state', 'in', ['uncertain', 'sending'])
                .count(),
            conversionFailures: find(F + 'ForumJobRun', {
                siteId: p.siteId,
                state: 'failed',
            }).count(),
            scanFailures: find(F + 'ForumAttachment', {
                siteId: p.siteId,
                scanState: 'quarantined',
            }).count(),
            scanBacklog: find(F + 'ForumAttachment', {
                siteId: p.siteId,
                scanState: 'pending',
            }).count(),
            generation: Number(site(p.siteId).generation),
        }
    }
    methods.storePolicy = (p) => {
        const s = site(p.siteId, true)
        revision(s, p.expectedRevision)
        if (!p.config) invalid('A policy configuration is required')
        validPolicy(p.config)
        // A section saves only its own settings; the rest carry over from the current revision.
        const config = { ...policy(p.siteId), ...p.config }
        const rev = Number(s.policyRevision) + 1
        create(F + 'ForumPolicy', {
            siteId: p.siteId,
            policyRevision: rev,
            config: JSON.stringify(config),
            createdAt: now(),
        })
        update(s, { policyRevision: rev, generation: Number(s.generation) + 1 })
        if (p.reason)
            audit(
                p.siteId,
                null,
                'policy',
                p.siteId,
                'policy',
                p.reason,
                rev - 1,
                rev,
            )
        return { revision: rev }
    }
    methods.getPolicy = (p) => {
        const s = site(p.siteId, true)
        return { policy: policy(p.siteId), revision: Number(s.policyRevision) }
    }

    methods.findRuns = (p) => {
        site(p.siteId, true)
        const pg = page(p, 'runs:' + p.siteId),
            list = Array.from(
                find(F + 'ForumJobRun', { siteId: p.siteId })
                    .orderBy('-createdAt,runId')
                    .offset(pg.offset)
                    .limit(pg.limit + 1)
                    .list(),
            )
        return {
            runList: list
                .slice(0, pg.limit)
                .map((v) =>
                    pick(
                        v,
                        'runId jobType state checkpoint successCount failedCount createdAt',
                    ),
                ),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    }
    methods.manageRun = (p) => {
        site(p.siteId, true)
        const run = one(F + 'ForumJobRun', { runId: p.runId }, true)
        if (!run || (run.siteId !== p.siteId && !(isOperator() && !run.siteId)))
            missing()
        if (!p.reason) invalid('A recovery reason is required')
        if (p.action === 'cancel' && run.state === 'pending')
            update(run, { state: 'cancelled' })
        else if (
            ['retry', 'resume'].includes(p.action) &&
            ['failed', 'cancelled'].includes(run.state)
        ) {
            find(F + 'ForumJobItem', {
                runId: p.runId,
                state: 'failed',
            }).updateAll({ state: 'pending' })
            const config = JSON.parse(run.checkpoint)
            const op = String(run.jobType || '').startsWith('op-')
            // Import runs change a staging site's data: an operator recovers them.
            if (String(run.jobType).startsWith('op-import') && !isOperator())
                fail('Unauthorized', 'An operator recovers import runs')
            // A resumed operation run continues from its checkpoint; a retry, or any other job, starts its pass again.
            if (!(op && p.action === 'resume')) {
                delete config.after
                if (run.jobType === 'op-retention') config.classIndex = 0
            }
            if (run.jobType === 'tracking') {
                config.phase = 'markers'
                config.after = ''
            }
            update(run, {
                state: 'pending',
                checkpoint: JSON.stringify(config),
                failedCount: 0,
                ...(op && p.action === 'retry' ? { successCount: 0 } : {}),
            })
        } else fail('Conflict', 'Job state changed')
        // A member's export or erasure request follows its run, so a cancelled one can be asked for again.
        for (const r of rows(F + 'ForumDataRequest', { runId: p.runId }))
            update(r, {
                state: p.action === 'cancel' ? 'cancelled' : 'running',
                revision: Number(r.revision || 1) + 1,
            })
        audit(p.siteId, null, 'job', p.runId, p.action, p.reason, null, null)
        return { state: run.state }
    }
    methods.previewTopicAction = (p) => {
        const { t, event, a } = topic(p.rootCommEventId, p.siteId)
        if (!a.canModerate) fail('Unauthorized', 'Moderator access required')
        if (['move-posts', 'split', 'merge'].includes(p.action)) {
            const dest = destination(p, a)
            if (!dest.a.canModerate)
                fail('Unauthorized', 'Destination moderator access required')
            const states =
                p.action === 'merge'
                    ? Array.from(
                          find(F + 'ForumPostState', {
                              rootCommEventId: t.rootCommEventId,
                          })
                              .limit(20000)
                              .list(),
                      )
                    : selection(t, p.postIds)
            const ids = states.map((s) => s.communicationEventId)
            return {
                title: event.subject,
                action: p.action,
                sourceVisibility: a.category.visibility,
                targetVisibility: dest.a.category.visibility,
                targetRootCommEventId: dest.t?.rootCommEventId || null,
                selectedPostIds: ids.slice(0, 100),
                visiblePostCount: states.filter(
                    (s) => s.visibility === 'approved',
                ).length,
                replyCount: Math.max(0, ids.length - (p.postIds?.length || 0)),
                attachmentCount: ids.reduce(
                    (n, postId) =>
                        n +
                        find(F + 'ForumAttachment', {
                            communicationEventId: postId,
                        }).count(),
                    0,
                ),
                acceptedAnswerAffected:
                    !!t.acceptedAnswerId &&
                    (p.action === 'merge' || ids.includes(t.acceptedAnswerId)),
                watcherCount: find(F + 'ForumPreference', {
                    siteId: p.siteId,
                    scopeType: 'topic',
                    scopeId: t.rootCommEventId,
                    watchLevel: 'Watching',
                }).count(),
                expectedRevision: Number(t.revision),
                expectedGeneration: audienceRevision(p.siteId, a, dest.a),
            }
        }
        const target = p.targetContactListId
            ? category(p.targetContactListId, p.siteId)
            : a
        if (!target.canModerate)
            fail('Unauthorized', 'Destination moderator access required')
        return {
            title: event.subject,
            sourceVisibility: a.category.visibility,
            targetVisibility: target.category.visibility,
            visiblePostCount: t.visiblePostCount,
            expectedRevision: Number(t.revision),
            expectedGeneration: audienceRevision(p.siteId, a, target),
        }
    }
    function validPolicy(config) {
        for (const [k, v] of Object.entries(config)) {
            if (POLICY_NUMBERS[k]) {
                const [, min, max] = POLICY_NUMBERS[k]
                if (!Number.isInteger(v) || v < min || v > max)
                    invalid(k + ' must be ' + min + '–' + max)
            } else if (k in POLICY_FLAGS) {
                if (typeof v !== 'boolean')
                    invalid(k + ' must be true or false')
            } else if (POLICY_CHOICES[k]) {
                if (!POLICY_CHOICES[k][1].includes(v)) invalid('Invalid ' + k)
            } else invalid('Unsupported policy: ' + k)
        }
    }
    function validRule(type, pattern) {
        if (!['word', 'regex', 'link'].includes(type))
            invalid('Invalid rule type')
        if (!pattern || String(pattern).length > 200)
            invalid('A pattern of 1–200 characters is required')
        if (type === 'regex') {
            // Patterns run on every post: refuse nested quantifiers and back references that can backtrack badly.
            if (
                /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(
                    pattern,
                ) ||
                /\\[1-9]/.test(pattern)
            )
                invalid('Nested repetition and back references are not allowed')
            try {
                new RegExp(pattern, 'i')
            } catch (e) {
                invalid('Invalid pattern')
            }
        }
    }
    methods.storeRule = (p) =>
        receipt(p, 'storeRule', () => {
            site(p.siteId, true)
            validRule(p.ruleType, p.pattern)
            if (!['block', 'approve', 'flag', 'censor'].includes(p.action))
                invalid('Invalid rule action')
            if (p.contactListId) category(p.contactListId, p.siteId)
            let r = p.ruleId
                ? one(F + 'ForumRule', { ruleId: p.ruleId }, true)
                : null
            if (p.ruleId && (!r || r.siteId !== p.siteId)) missing()
            if (r) revision(r, p.expectedRevision)
            const fields = {
                contactListId: p.contactListId || null,
                ruleType: p.ruleType,
                pattern: p.pattern,
                action: p.action,
                enabled: p.active === false ? 'N' : 'Y',
                priority: Number(p.sequenceNum || 0),
                revision: Number(r?.revision || 0) + 1,
            }
            r = r
                ? update(r, fields)
                : create(F + 'ForumRule', {
                      ruleId: id(),
                      siteId: p.siteId,
                      createdAt: now(),
                      ...fields,
                  })
            audit(
                p.siteId,
                fields.contactListId,
                'rule',
                r.ruleId,
                'store',
                p.reason || '',
                fields.revision - 1,
                fields.revision,
            )
            return { ruleId: r.ruleId, revision: fields.revision }
        })
    methods.findRules = (p) => {
        site(p.siteId, true)
        return {
            ruleList: Array.from(
                find(F + 'ForumRule', { siteId: p.siteId })
                    .orderBy('priority,ruleId')
                    .limit(200)
                    .list(),
            ).map((r) =>
                pick(
                    r,
                    'ruleId contactListId ruleType pattern action enabled priority revision',
                ),
            ),
        }
    }
    /* A bounded test against sample text: what each action would do, with no post written. */
    methods.testRule = (p) => {
        site(p.siteId, true)
        validRule(p.ruleType, p.pattern)
        if (String(p.body || '').length > 10000)
            invalid('Sample text is limited to 10000 characters')
        const re = ruleRegex({ ruleType: p.ruleType, pattern: p.pattern })
        const sample = String(p.body || '')
        return {
            matched: re.test(sample),
            censored: censor(WebUtilities.encodeHtml(sample), re),
        }
    }
    function earnedTrust(m, pol) {
        const entered = Number(m.topicsEntered || 0),
            read = Number(m.postsRead || 0),
            minutes = Number(m.readingSeconds || 0) / 60,
            days = Number(m.visitDays || 0)
        if (!(
            entered >= pol.basicTopicsEntered &&
            read >= pol.basicPostsRead &&
            minutes >= pol.basicReadingMinutes &&
            days >= pol.basicVisitDays
        ))
            return 'new'
        if (!(
            days >= pol.memberVisitDays &&
            entered >= pol.memberTopicsEntered &&
            read >= pol.memberPostsRead &&
            minutes >= pol.memberReadingMinutes
        ))
            return 'basic'
        if (!(
            days >= pol.regularVisitDays &&
            entered >= pol.regularTopicsEntered &&
            read >= pol.regularPostsRead &&
            Number(m.approvedContributions || 0) >=
                pol.regularApprovedContributions
        ))
            return 'member'
        return 'regular'
    }
    /* Worker step: promotion only, never past an owner lock or a recent sanction. Trust grants no staff authority. */
    function recomputeMemberTrust(siteId, partyId) {
        const m = one(F + 'ForumMemberState', { siteId, partyId }, true)
        if (!m || m.trustLocked === 'Y') return { changed: false }
        const pol = policy(siteId)
        // Any sanction in force within the abuse-free window, however long ago it began, holds promotion.
        const cut = stamp(millis(now()) - pol.abuseFreeDays * 86400000),
            cf = ec.entity.conditionFactory
        if (
            find(F + 'ForumSanction', { siteId, partyId })
                .condition(
                    cf.makeCondition(
                        [
                            cf.makeCondition('thruDate', 'equals', null),
                            cf.makeCondition('thruDate', 'greater-equals', cut),
                        ],
                        'or',
                    ),
                )
                .count() > 0
        )
            return { changed: false }
        const earned = earnedTrust(m, pol)
        if (trustRank(earned) <= trustRank(m.trustLevel))
            return { changed: false }
        update(m, {
            trustLevel: earned,
            trustSetAt: now(),
            revision: Number(m.revision) + 1,
        })
        return { changed: true, trustLevel: earned }
    }
    function recomputeTrust() {
        const run =
            one(F + 'ForumJobRun', { runId: 'TRUST_SCAN' }, true) ||
            create(F + 'ForumJobRun', {
                runId: 'TRUST_SCAN',
                jobType: 'trust',
                state: 'running',
                checkpoint: '',
                createdAt: now(),
                successCount: 0,
                failedCount: 0,
            })
        const [afterSite, afterParty] = String(run.checkpoint || '|').split('|')
        const cf = ec.entity.conditionFactory
        let q = find(F + 'ForumMemberState', {})
        if (afterSite)
            q = q.condition(
                cf.makeCondition(
                    [
                        cf.makeCondition('siteId', 'greater', afterSite),
                        cf.makeCondition(
                            [
                                cf.makeCondition('siteId', 'equals', afterSite),
                                cf.makeCondition(
                                    'partyId',
                                    'greater',
                                    afterParty,
                                ),
                            ],
                            'and',
                        ),
                    ],
                    'or',
                ),
            )
        const batch = Array.from(q.orderBy('siteId,partyId').limit(500).list())
        let changed = 0,
            failed = 0
        for (const m of batch)
            try {
                if (
                    ec.service
                        .sync()
                        .requireNewTransaction(true)
                        .throwOnError(true)
                        .name(
                            'mantle.forum.ModerationWorkerServices.recompute#MemberTrust',
                        )
                        .parameters({ siteId: m.siteId, partyId: m.partyId })
                        .call().result.changed
                )
                    changed++
            } catch (e) {
                ec.message.clearErrors()
                failed++
                ec.logger.error(
                    'Trust recompute for ' +
                        m.siteId +
                        '/' +
                        m.partyId +
                        ' failed: ' +
                        String(e?.message || e).split('\n')[0],
                )
            }
        const last = batch[batch.length - 1]
        update(run, {
            checkpoint:
                batch.length < 500 ? '' : last.siteId + '|' + last.partyId,
            successCount: Number(run.successCount || 0) + batch.length - failed,
            failedCount: Number(run.failedCount || 0) + failed,
        })
        return { inspected: batch.length, changed, failed }
    }
    methods.setTrust = (p) => {
        site(p.siteId, true)
        if (!TRUST_ORDER.includes(p.trustLevel)) invalid('Invalid trust level')
        if (!p.reason) invalid('A reason is required')
        if (!member(p.siteId, p.targetPartyId)) missing()
        const m = memberStateFor(p.siteId, p.targetPartyId)
        revision(m, p.expectedRevision)
        const before = Number(m.revision)
        update(m, {
            trustLevel: p.trustLevel,
            trustLocked: p.locked === true ? 'Y' : 'N',
            trustReason: p.reason,
            trustSetAt: now(),
            revision: before + 1,
        })
        audit(
            p.siteId,
            null,
            'member',
            p.targetPartyId,
            'trust-' + p.trustLevel + (p.locked === true ? '-locked' : ''),
            p.reason,
            before,
            before + 1,
        )
        return { trustLevel: p.trustLevel, revision: before + 1 }
    }
    /* ---- Flag hiding and automatic review ---- */
    /* Enough distinct basic-or-higher reporters hide a post until staff decide; the author's own and repeat reports do not count. */
    function hideIfFlagged(siteId, st, event, reviewId) {
        if (st.visibility !== 'approved') return false
        const pol = policy(siteId)
        const reporters = rows(
            F + 'ForumReviewReport',
            { reviewId },
            100,
        ).filter(
            (r) =>
                r.reporterPartyId !== event.fromPartyId &&
                trustRank(trustLevel(siteId, r.reporterPartyId)) >= 1 &&
                !memberBlocks(siteId, event.fromPartyId, r.reporterPartyId),
        )
        if (reporters.length < pol.flagHideCount) return false
        const t = one(
            F + 'ForumTopic',
            { rootCommEventId: st.rootCommEventId },
            true,
        )
        update(st, { visibility: 'hidden' })
        if (st.communicationEventId !== t.rootCommEventId)
            update(t, {
                visiblePostCount: Math.max(0, Number(t.visiblePostCount) - 1),
                revision: Number(t.revision) + 1,
            })
        if (t.acceptedAnswerId === st.communicationEventId)
            update(t, { acceptedAnswerId: null })
        systemAudit(
            siteId,
            event.contactListId || t.contactListId,
            'post',
            st.communicationEventId,
            'auto-hide',
            reporters.length + ' community reports',
        )
        bump(siteId)
        return true
    }
    function classifyPost(outboxId) {
        const box = one(F + 'ForumOutbox', { outboxId }, true)
        if (!box || box.state !== 'classify') return { classified: false }
        const service = System.getProperty('pass_classifier_service')
        const st = one(F + 'ForumPostState', {
                communicationEventId: box.communicationEventId,
            }),
            event = one(E + 'CommunicationEvent', {
                communicationEventId: box.communicationEventId,
            })
        // A confidential record's text is never sent to the classifier, whenever its item was queued.
        if (
            !service ||
            !st ||
            !event ||
            st.visibility === 'deleted' ||
            st.visibility === 'staff' ||
            !core.classifiable(st.rootCommEventId)
        ) {
            update(box, { state: 'complete' })
            return { classified: false }
        }
        let result
        try {
            // Its own transaction, so a failing classifier cannot roll back this queue item's bookkeeping.
            result = ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name(service)
                .parameters({
                    siteId: box.siteId,
                    postId: box.communicationEventId,
                    revision: Number(st.revision),
                    text: plainText(event.body),
                })
                .call()
        } catch (e) {
            ec.message.clearErrors()
            const attempts = Number(box.cursor || 0) + 1
            update(box, {
                cursor: String(attempts),
                state: attempts >= 3 ? 'failed' : 'classify',
            })
            ec.logger.error(
                'Forum classifier for post ' +
                    box.communicationEventId +
                    ' failed (attempt ' +
                    attempts +
                    '): ' +
                    String(e?.message || e).split('\n')[0],
            )
            return { classified: false }
        }
        if (result?.decision === 'review') {
            const r = review(
                box.siteId,
                event.contactListId ||
                    one(F + 'ForumTopic', {
                        rootCommEventId: st.rootCommEventId,
                    })?.contactListId,
                'post',
                box.communicationEventId,
                Number(st.revision),
                'classifier',
            )
            update(r, {
                detail: JSON.stringify({
                    model: String(result.model || ''),
                    version: String(result.version || ''),
                    reason: String(result.reason || '').slice(0, 1000),
                }),
            })
        }
        update(box, { state: 'complete' })
        return { classified: true, decision: result?.decision || 'none' }
    }
    function classifyPosts() {
        let done = 0,
            failed = 0
        for (const box of Array.from(
            find(F + 'ForumOutbox', { state: 'classify' })
                .orderBy('createdAt,outboxId')
                .limit(100)
                .list(),
        ))
            try {
                ec.service
                    .sync()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .name('mantle.forum.ModerationWorkerServices.classify#Post')
                    .parameters({ outboxId: box.outboxId })
                    .call()
                done++
            } catch (e) {
                ec.message.clearErrors()
                failed++
                ec.logger.error(
                    'Forum classification ' +
                        box.outboxId +
                        ' failed: ' +
                        String(e?.message || e).split('\n')[0],
                )
            }
        return { done, failed }
    }
    /* ---- Bulk decisions and appeals ---- */
    methods.decideReviews = (p) => {
        requireUser()
        site(p.siteId)
        if (!Array.isArray(p.reviewIds) || !p.reviewIds.length)
            invalid('Select at least one review')
        const results = []
        for (const reviewId of p.reviewIds) {
            // Each decision is its own transaction with its own checks; one refusal does not undo the others.
            try {
                const r = one(F + 'ForumReviewItem', {
                    reviewId,
                    siteId: p.siteId,
                })
                if (!r) missing()
                const out = ec.service
                    .sync()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .name('mantle.forum.ModerationServices.decide#Review')
                    .parameters({
                        input: {
                            siteId: p.siteId,
                            reviewId,
                            decision: p.decision,
                            reason: p.reason,
                            expectedRevision: Number(r.revision),
                        },
                    })
                    .call().result
                results.push({ reviewId, ok: true, state: out.state })
            } catch (e) {
                ec.message.clearErrors()
                results.push({
                    reviewId,
                    ok: false,
                    error: String(e?.message || e)
                        .split('\n')[0]
                        .replace(/^(Error: )+/, ''),
                })
            }
        }
        return { results }
    }
    /* An author appeals a rejection with a new linked review item; the decision itself is never reopened. */
    methods.appealReview = (p) =>
        receipt(p, 'appealReview', () => {
            site(p.siteId)
            const r = one(F + 'ForumReviewItem', {
                reviewId: p.reviewId,
                siteId: p.siteId,
            })
            if (!r || r.targetType !== 'post') missing()
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: r.targetId,
            })
            if (!event || event.fromPartyId !== me()) missing()
            if (r.state !== 'rejected')
                fail('Conflict', 'Only a rejected decision can be appealed')
            if (!p.reason || p.reason.length > 2000)
                invalid(
                    'An appeal reason of at most 2000 characters is required',
                )
            const appeal = review(
                p.siteId,
                r.contactListId,
                'post',
                r.targetId,
                r.targetRevision,
                'appeal',
            )
            update(appeal, { linkedReviewId: r.reviewId, detail: p.reason })
            return { reviewId: appeal.reviewId, state: appeal.state }
        })
    /* The actor's own removed posts with the safe staff reason, so an author can understand and appeal a decision. */
    methods.findMyReviews = (p) => {
        site(p.siteId)
        const partyId = requireUser()
        const list = []
        for (const st of Array.from(
            find(F + 'ForumPostSearch', {
                siteId: p.siteId,
                fromPartyId: partyId,
                visibility: 'rejected',
            })
                .orderBy('-entryDate')
                .limit(50)
                .list(),
        )) {
            const decided = Array.from(
                find(F + 'ForumReviewItem', {
                    siteId: p.siteId,
                    targetType: 'post',
                    targetId: st.communicationEventId,
                })
                    .orderBy('-createdAt')
                    .limit(5)
                    .list(),
            )
            const rejected = decided.find((r) => r.state === 'rejected')
            if (!rejected) continue
            const appeal = decided.find(
                (r) =>
                    r.reasonFamily === 'appeal' &&
                    r.linkedReviewId === rejected.reviewId,
            )
            list.push({
                reviewId: rejected.reviewId,
                postId: st.communicationEventId,
                title: st.subject,
                decisionReason: rejected.decisionReason,
                appealState: appeal?.state || null,
            })
        }
        return { reviewList: list }
    }
    /* ---- Topic tools: selection, relocation and timers ---- */
    const TIMER_ACTIONS = ['close', 'reopen', 'unpin', 'list', 'unlist']
    /* A moved post takes its whole reply subtree, so no reply is left pointing into another thread. */
    function selection(t, postIds) {
        if (!Array.isArray(postIds) || !postIds.length || postIds.length > 100)
            invalid('Select 1–100 posts')
        const picked = new Set(),
            queue = [...postIds]
        while (queue.length) {
            const postId = queue.shift()
            if (picked.has(postId)) continue
            const st = one(F + 'ForumPostState', {
                communicationEventId: postId,
            })
            if (!st || st.rootCommEventId !== t.rootCommEventId)
                invalid('Selected posts must belong to this topic')
            if (postId === t.rootCommEventId)
                invalid('Move the whole topic with merge or a category change')
            picked.add(postId)
            if (picked.size > 1000) invalid('The selection is too large')
            for (const child of rows(
                F + 'ForumPostSearch',
                {
                    rootCommEventId: t.rootCommEventId,
                    parentCommEventId: postId,
                },
                1000,
            ))
                queue.push(child.communicationEventId)
        }
        return Array.from(picked)
            .map((postId) =>
                one(F + 'ForumPostState', { communicationEventId: postId }),
            )
            .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
    }
    function relocate(states, dest, destListId, newRootId) {
        const ids = new Set(states.map((s) => s.communicationEventId))
        let next = Number(dest.nextOrdinal || 1)
        const destRoot = dest.rootCommEventId,
            destEvent = one(E + 'CommunicationEvent', {
                communicationEventId: destRoot,
            })
        for (const st of states) {
            const postId = st.communicationEventId,
                ev = one(
                    E + 'CommunicationEvent',
                    { communicationEventId: postId },
                    true,
                ),
                isRoot = postId === newRootId
            update(ev, {
                rootCommEventId: isRoot ? null : destRoot,
                parentCommEventId: isRoot
                    ? null
                    : ids.has(ev.parentCommEventId)
                      ? ev.parentCommEventId
                      : destRoot,
                contactListId: destListId,
                subject: isRoot ? ev.subject : destEvent?.subject || ev.subject,
            })
            update(
                one(
                    F + 'ForumPostState',
                    { communicationEventId: postId },
                    true,
                ),
                {
                    rootCommEventId: destRoot,
                    ordinal: next++,
                },
            )
            for (const entity of [
                'ForumReaction',
                'ForumPoll',
                'ForumBookmark',
            ])
                find(F + entity, { communicationEventId: postId }).updateAll({
                    rootCommEventId: destRoot,
                })
            // Open reviews now sit in the destination audience; a claim made under the old one is released.
            for (const r of rows(
                F + 'ForumReviewItem',
                { siteId: dest.siteId, targetType: 'post', targetId: postId },
                100,
            ))
                update(
                    r,
                    ['pending', 'claimed'].includes(r.state)
                        ? {
                              contactListId: destListId,
                              state: 'pending',
                              claimedByPartyId: null,
                              claimExpiresAt: null,
                              revision: Number(r.revision) + 1,
                          }
                        : { contactListId: destListId },
                )
        }
        update(dest, { nextOrdinal: next })
    }
    /* Counters are derived again after a structural change; they never decide access. */
    function recount(t) {
        let visible = 0,
            reactions = 0,
            last = null
        for (const st of Array.from(
            find(F + 'ForumPostSearch', {
                rootCommEventId: t.rootCommEventId,
                visibility: 'approved',
            })
                .limit(20000)
                .list(),
        )) {
            visible++
            reactions += Number(st.reactionCount || 0)
            if (!last || millis(st.entryDate) > millis(last))
                last = st.entryDate
        }
        update(t, {
            visiblePostCount: visible,
            reactionCount: reactions,
            lastActivity: last || t.lastActivity,
            revision: Number(t.revision) + 1,
        })
    }
    function retireTopic(t, targetRoot) {
        for (const entity of [
            'ForumTopicTag',
            'ForumTopicUser',
            'ForumTopicTimer',
        ])
            find(F + entity, { rootCommEventId: t.rootCommEventId }).deleteAll()
        find(F + 'ForumDraft', {
            rootCommEventId: t.rootCommEventId,
        }).updateAll({
            rootCommEventId: targetRoot,
        })
        find(F + 'ForumPermalink', {
            targetRootCommEventId: t.rootCommEventId,
        }).updateAll({ targetRootCommEventId: targetRoot })
        // A root that was merged before and split out again has an old alias of its own; it is replaced.
        find(F + 'ForumPermalink', {
            oldRootCommEventId: t.rootCommEventId,
        }).deleteAll()
        find(F + 'ForumPermalink', {
            oldRootCommEventId: targetRoot,
        }).deleteAll()
        create(F + 'ForumPermalink', {
            oldRootCommEventId: t.rootCommEventId,
            siteId: t.siteId,
            targetRootCommEventId: targetRoot,
            createdAt: now(),
        })
        t.delete()
    }
    /* The destination of a move, split or merge, with the same audience confirmation a category move needs. */
    function destination(p, a) {
        if (p.action === 'split') {
            const target = p.targetContactListId
                ? category(p.targetContactListId, p.siteId)
                : a
            return { a: target, t: null }
        }
        if (
            !p.targetRootCommEventId ||
            p.targetRootCommEventId === p.rootCommEventId
        )
            invalid('Choose a different destination topic')
        const out = topic(p.targetRootCommEventId, p.siteId, true)
        return { a: out.a, t: out.t }
    }
    function checkAudience(p, a, target) {
        if (!target.canModerate)
            fail('Unauthorized', 'Destination moderator access required')
        if (target.category.contactListId === a.category.contactListId) return
        if (p.confirmAudience !== true)
            invalid('Review and confirm the destination audience')
        if (
            Number(p.expectedGeneration) !==
            audienceRevision(p.siteId, a, target)
        )
            fail('Conflict', 'Audience changed; preview the move again')
    }
    function restructure(p, t, event, a) {
        const dest = destination(p, a)
        checkAudience(p, a, dest.a)
        const destListId = dest.a.category.contactListId
        if (p.action === 'merge') {
            const states = Array.from(
                find(F + 'ForumPostState', {
                    rootCommEventId: t.rootCommEventId,
                })
                    .orderBy('ordinal')
                    .limit(20000)
                    .list(),
            )
            relocate(states, dest.t, destListId, null)
            recount(dest.t)
            retireTopic(t, dest.t.rootCommEventId)
            return {
                rootCommEventId: dest.t.rootCommEventId,
                moved: states.length,
            }
        }
        const states = selection(t, p.postIds)
        if (
            t.acceptedAnswerId &&
            states.some((s) => s.communicationEventId === t.acceptedAnswerId)
        )
            update(t, { acceptedAnswerId: null })
        let target = dest.t
        if (p.action === 'split') {
            if (!p.title || p.title.length > 250)
                invalid('A title of at most 250 characters is required')
            const newRoot = states[0].communicationEventId
            update(
                one(
                    E + 'CommunicationEvent',
                    { communicationEventId: newRoot },
                    true,
                ),
                {
                    subject: p.title,
                },
            )
            target = create(F + 'ForumTopic', {
                rootCommEventId: newRoot,
                siteId: p.siteId,
                contactListId: destListId,
                kind: 'category',
                revision: 0,
                nextOrdinal: 1,
                visiblePostCount: 0,
                reactionCount: 0,
                lastActivity: now(),
                pinned: 'N',
                unlisted: 'N',
                slowIntervalSeconds: 0,
            })
            relocate(states, target, destListId, newRoot)
        } else relocate(states, target, destListId, null)
        recount(target)
        recount(t)
        return { rootCommEventId: target.rootCommEventId, moved: states.length }
    }
    function fireTimer(timerId) {
        const timer = one(F + 'ForumTopicTimer', { timerId }, true)
        if (!timer || timer.state !== 'pending') return { fired: false }
        const t = one(
            F + 'ForumTopic',
            { rootCommEventId: timer.rootCommEventId },
            true,
        )
        const end = (state, error) => {
            update(timer, { state, lastError: error || null })
            return { fired: state === 'done', state }
        }
        // The scope is checked when the timer fires: a moved topic or a creator who lost moderation cancels it.
        if (!t || t.contactListId !== timer.contactListId)
            return end('cancelled', 'Topic moved or removed')
        if (t.kind === 'record')
            return end('cancelled', 'A record conversation has no timers')
        if (
            !categoryAccess(t.contactListId, timer.createdByPartyId)
                ?.canModerate
        )
            return end(
                'cancelled',
                'Timer creator no longer moderates this category',
            )
        const event = one(
            E + 'CommunicationEvent',
            { communicationEventId: t.rootCommEventId },
            true,
        )
        if (timer.action === 'close' || timer.action === 'reopen')
            update(event, {
                statusId:
                    timer.action === 'close' ? 'CeResolved' : 'CeReceived',
            })
        else if (timer.action === 'unpin') update(t, { pinned: 'N' })
        else update(t, { unlisted: timer.action === 'unlist' ? 'Y' : 'N' })
        update(t, { revision: Number(t.revision) + 1 })
        systemAudit(
            t.siteId,
            t.contactListId,
            'topic',
            t.rootCommEventId,
            'timer-' + timer.action,
            timer.reason,
            timer.createdByPartyId,
        )
        bump(t.siteId)
        return end('done')
    }
    function fireTimers() {
        let fired = 0,
            failed = 0
        for (const timer of Array.from(
            find(F + 'ForumTopicTimer', { state: 'pending' })
                .condition('dueAt', 'less-equals', now())
                .orderBy('dueAt,timerId')
                .limit(100)
                .list(),
        ))
            try {
                ec.service
                    .sync()
                    .requireNewTransaction(true)
                    .throwOnError(true)
                    .name(
                        'mantle.forum.ModerationWorkerServices.fire#TopicTimer',
                    )
                    .parameters({ timerId: timer.timerId })
                    .call()
                fired++
            } catch (e) {
                ec.message.clearErrors()
                failed++
                ec.logger.error(
                    'Forum topic timer ' +
                        timer.timerId +
                        ' failed: ' +
                        String(e?.message || e).split('\n')[0],
                )
            }
        return { fired, failed }
    }
    /* A report on a private post lets scoped staff see that post and one visible post on each side. Wider context needs a
       recorded escalation and a site owner's approval; every view of private evidence is audited. */
    function privateContext(r, st) {
        const detail = json(r.detail, {})
        const span = detail.escalation?.approvedBy ? 10 : 1
        const near = (op, order) =>
            Array.from(
                find(F + 'ForumPostSearch', {
                    rootCommEventId: st.rootCommEventId,
                    visibility: 'approved',
                })
                    .condition('ordinal', op, Number(st.ordinal))
                    .orderBy(order)
                    .limit(span)
                    .list(),
            )
        const context = [
            ...near('less', '-ordinal').reverse(),
            ...near('greater', 'ordinal'),
        ]
        systemAudit(
            r.siteId,
            null,
            'review',
            r.reviewId,
            'private-evidence-view',
            span > 1
                ? 'Escalated context'
                : 'Reported post with adjacent context',
            me(),
        )
        return context.map((v) => ({
            postId: v.communicationEventId,
            ordinal: Number(v.ordinal),
            body: StringUtilities.cleanHtml(v.body || ''),
        }))
    }
    methods.escalateReview = (p) => {
        requireUser()
        site(p.siteId)
        const r = one(
            F + 'ForumReviewItem',
            { reviewId: p.reviewId, siteId: p.siteId },
            true,
        )
        if (!r || r.targetType !== 'post') missing()
        core.reviewStaff(p.siteId, r)
        // Escalation shows a private conversation's context to the site's owner: a record has none to show.
        if (core.reviewRecord(r)) core.notForRecord()
        if (!p.reason) invalid('A reason is required')
        const detail = json(r.detail, {})
        if (p.active === true) {
            // Approval is the site owner's, recorded separately from the request.
            site(p.siteId, true)
            if (!detail.escalation)
                fail('Conflict', 'No escalation was requested')
            detail.escalation.approvedBy = me()
            detail.escalation.approvedAt = millis(now())
            detail.escalation.approvalReason = p.reason
        } else
            detail.escalation = {
                requestedBy: me(),
                requestedAt: millis(now()),
                reason: p.reason,
            }
        update(r, {
            detail: JSON.stringify(detail),
            revision: Number(r.revision) + 1,
        })
        audit(
            p.siteId,
            r.contactListId,
            'review',
            r.reviewId,
            p.active === true ? 'escalation-approved' : 'escalation-requested',
            p.reason,
            Number(r.revision) - 1,
            Number(r.revision),
        )
        return { revision: Number(r.revision), escalation: detail.escalation }
    }
    /* ---- Stage 2 email participation: routes, reply tokens and the inbound handler ---- */
    /* Policy revisions only grow, so their sum over the site and both category chains changes whenever either audience can. */
    function audienceRevision(siteId, source, target) {
        let total = Number(
            one(S + 'PublicSite', { siteId })?.policyRevision || 0,
        )
        for (const start of [source.category, target.category]) {
            const seen = new Set()
            for (let c = start; c && !seen.has(c.contactListId);) {
                seen.add(c.contactListId)
                total += Number(c.policyRevision || 0)
                c = c.parentContactListId
                    ? one(F + 'ForumCategory', {
                          contactListId: c.parentContactListId,
                      })
                    : null
            }
        }
        return total
    }
    return {
        recount,
        recomputeTrust,
        recomputeMemberTrust,
        classifyPosts,
        classifyPost,
        fireTimers,
        fireTimer,
    }
}
