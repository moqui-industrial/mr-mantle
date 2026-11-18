/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Forum operations (design §11 Operations, ActivityReports, AccountSettings privacy, §17 outputs): previewed and
 * checkpointed operation runs (counter rebuild, delivery retry, retention, site export), personal data export and
 * reviewed erasure, expiring downloads rechecked at download time, CSV reports and activity aggregates. Each run item
 * has its own transaction; a failed item is named and its peers continue. Forum.js calls this with the shared core,
 * its methods map and the moderation module's exports.
 */
;(core, methods, moderation) => {
    const {
        F,
        S,
        E,
        now,
        millis,
        stamp,
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
        requireUser,
        active,
        member,
        site,
        revision,
        staff,
        page,
        audit,
        categoryAccess,
        protectOwner,
    } = core
    const DAY = 86400000
    const SCHEMA_VERSION = 1
    const EXPORT_DAYS = 7
    /* The operations a site owner may preview and start. */
    const OPERATIONS = {
        'rebuild-counters': 'op-rebuild-counters',
        'retry-deliveries': 'op-retry-deliveries',
        retention: 'op-retention',
        'export-site': 'op-export-site',
    }
    /* Retention classes: the policy field, the rows it covers and what applying it does. */
    const RETENTION = {
        deliveryDays: 'Delivery ledger rows (deleted)',
        inboundDays: 'Inbound mail receipts (deleted)',
        deletedPostDays:
            'Text of deleted and rejected posts (replaced by a tombstone; revisions and audit kept)',
        jobDays: 'Finished operation runs and their items (deleted)',
        invitationDays: 'Expired invitations (deleted)',
    }
    /* Short codes keep a retention item ID (code:key) within an ID column. */
    const RETENTION_CODES = {
        deliveryDays: 'd',
        inboundDays: 'i',
        deletedPostDays: 'p',
        jobDays: 'j',
        invitationDays: 'v',
    }
    const RETENTION_KEYS = {
        deliveryDays: 'deliveryId',
        inboundDays: 'receiptId',
        deletedPostDays: 'communicationEventId',
        jobDays: 'runId',
        invitationDays: 'invitationId',
    }
    const PERSONAL_SECTIONS = [
        'profile',
        'memberships',
        'posts',
        'drafts',
        'bookmarks',
        'preferences',
    ]
    const ERASURE_STEPS = [
        'profile',
        'delivery',
        'drafts',
        'bookmarks',
        'memberships',
    ]
    const firstLine = (error) =>
        String(error?.message || error || '')
            .split('\n')[0]
            .slice(0, 200)
    function storageRoot() {
        const root = ec.factory.getConfValue('pass@media-root')
        if (!root)
            fail(
                'Unavailable',
                'Private storage must be configured for exports',
            )
        return String(root).replace(/\/$/, '')
    }
    const writeJson = (location, value) =>
        ec.resource
            .getLocationReference(location)
            .putText(JSON.stringify(value, null, 1))

    /* ---- Retention policy ---- */
    const retentionPolicy = (siteId) =>
        one(F + 'ForumRetentionPolicy', { siteId }) || { revision: 0 }
    methods.getRetentionPolicy = (p) => {
        site(p.siteId, true)
        const r = retentionPolicy(p.siteId)
        return {
            policy: Object.fromEntries(
                Object.keys(RETENTION).map((k) => [k, Number(r[k] || 0)]),
            ),
            classes: RETENTION,
            revision: Number(r.revision || 0),
        }
    }
    methods.storeRetentionPolicy = (p) => {
        site(p.siteId, true)
        const old = one(F + 'ForumRetentionPolicy', { siteId: p.siteId }, true)
        revision({ revision: Number(old?.revision || 0) }, p.expectedRevision)
        if (!p.reason) invalid('A reason is required')
        const fields = {}
        for (const k of Object.keys(RETENTION)) {
            const days = p[k] == null ? Number(old?.[k] || 0) : Number(p[k])
            if (
                !Number.isInteger(days) ||
                days < 0 ||
                (days > 0 && days < 30) ||
                days > 36500
            )
                invalid('Keep each class 0 days (always) or 30 to 36500 days')
            fields[k] = days
        }
        const next = Number(old?.revision || 0) + 1
        if (old) update(old, { ...fields, revision: next, updatedAt: now() })
        else
            create(F + 'ForumRetentionPolicy', {
                siteId: p.siteId,
                ...fields,
                revision: next,
                updatedAt: now(),
            })
        audit(
            p.siteId,
            null,
            'site',
            p.siteId,
            'retention-policy',
            p.reason,
            next - 1,
            next,
        )
        return { revision: next }
    }
    /* The rows of one retention class past its period, as a find. */
    function retentionFind(siteId, cls, days) {
        const cutoff = stamp(millis(now()) - days * DAY)
        switch (cls) {
            case 'deliveryDays':
                return find(F + 'ForumDelivery', { siteId })
                    .condition('state', 'in', ['sent', 'suppressed', 'failed'])
                    .condition('dueAt', 'less', cutoff)
            case 'inboundDays':
                return find(F + 'ForumInboundReceipt', { siteId }).condition(
                    'createdAt',
                    'less',
                    cutoff,
                )
            case 'deletedPostDays': {
                // A deleted post counts from its deletion, a rejected one from when it was written.
                const cf = ec.entity.conditionFactory
                return find(F + 'ForumPostSearch', { siteId })
                    .condition('textRemovedAt', null)
                    .condition(
                        cf.makeCondition(
                            [
                                cf.makeCondition(
                                    [
                                        cf.makeCondition('visibility', 'equals', 'deleted'),
                                        cf.makeCondition('deletedAt', 'less', cutoff),
                                    ],
                                    'and',
                                ),
                                cf.makeCondition(
                                    [
                                        cf.makeCondition('visibility', 'equals', 'rejected'),
                                        cf.makeCondition('entryDate', 'less', cutoff),
                                    ],
                                    'and',
                                ),
                            ],
                            'or',
                        ),
                    )
            }
            case 'jobDays':
                return find(F + 'ForumJobRun', { siteId })
                    .condition('jobType', 'in', [
                        'op-rebuild-counters',
                        'op-retry-deliveries',
                        'op-retention',
                        'op-export-site',
                        'op-export-personal',
                        'op-erasure',
                    ])
                    .condition('state', 'in', [
                        'complete',
                        'failed',
                        'cancelled',
                    ])
                    .condition('createdAt', 'less', cutoff)
            case 'invitationDays':
                return find(S + 'PublicSiteInvitation', { siteId }).condition(
                    'expiresAt',
                    'less',
                    cutoff,
                )
        }
        invalid('Unknown retention class')
    }
    function retentionCounts(siteId) {
        const policy = retentionPolicy(siteId)
        return Object.fromEntries(
            Object.keys(RETENTION).map((cls) => {
                const days = Number(policy[cls] || 0)
                return [
                    cls,
                    {
                        label: RETENTION[cls],
                        days,
                        count: days
                            ? retentionFind(siteId, cls, days).count()
                            : null,
                    },
                ]
            }),
        )
    }

    /* Job types other modules add (registerJob): {next(run, config), item(run, config, itemId), finish(run, config,
       failed)}. An item may return a patch for the run's checkpoint, such as the byte offset an import reached. */
    const handlers = {}
    const registerJob = (jobType, handler) => {
        handlers[jobType] = handler
    }
    /* ---- Operation preview and runs ---- */
    function startRun(siteId, jobType, config) {
        const runId = id()
        create(F + 'ForumJobRun', {
            runId,
            siteId,
            partyId: me(),
            jobType,
            state: 'pending',
            checkpoint: JSON.stringify(config),
            createdAt: now(),
            successCount: 0,
            failedCount: 0,
        })
        return runId
    }
    const topicFind = (siteId, contactListId) =>
        find(F + 'ForumTopic', {
            siteId,
            kind: 'category',
            ...(contactListId ? { contactListId } : {}),
        })
    methods.previewOperation = (p) => {
        site(p.siteId, true)
        if (!OPERATIONS[p.operation]) invalid('Unknown operation')
        const out = { operation: p.operation }
        if (p.operation === 'rebuild-counters' || p.operation === 'export-site')
            out.topicCount = topicFind(p.siteId, p.contactListId).count()
        if (p.operation === 'retry-deliveries')
            out.deliveryCount = find(F + 'ForumDelivery', {
                siteId: p.siteId,
                state: 'failed',
            }).count()
        if (p.operation === 'retention') {
            out.retention = retentionCounts(p.siteId)
            out.policyRevision = Number(retentionPolicy(p.siteId).revision || 0)
        }
        return out
    }
    /* Retention is a dry run unless the owner turns it off and names the policy revision the preview showed. */
    methods.startOperation = (p) => {
        site(p.siteId, true)
        const jobType = OPERATIONS[p.operation]
        if (!jobType) invalid('Unknown operation')
        if (!p.reason) invalid('A reason is required')
        const config = { contactListId: p.contactListId || null, after: null }
        if (p.operation === 'retention') {
            const policy = retentionPolicy(p.siteId)
            const counts = retentionCounts(p.siteId)
            if (p.dryRun !== false) {
                const runId = startRun(p.siteId, jobType, {
                    dryRun: true,
                    counts,
                })
                update(one(F + 'ForumJobRun', { runId }), { state: 'complete' })
                audit(
                    p.siteId,
                    null,
                    'run',
                    runId,
                    'retention-dry-run',
                    p.reason,
                    null,
                    null,
                )
                return { runId, dryRun: true, retention: counts }
            }
            revision(
                { revision: Number(policy.revision || 0) },
                p.expectedRevision,
            )
            config.classes = Object.keys(RETENTION).filter(
                (cls) => Number(policy[cls] || 0) > 0,
            )
            if (!config.classes.length)
                invalid('The retention policy keeps everything')
            config.days = Object.fromEntries(
                config.classes.map((cls) => [cls, Number(policy[cls])]),
            )
            config.classIndex = 0
        }
        if (p.operation === 'export-site') {
            config.exportId = pendingExport(p.siteId, 'site', p.contactListId)
        }
        const runId = startRun(p.siteId, jobType, config)
        audit(
            p.siteId,
            p.contactListId || null,
            'run',
            runId,
            'start-' + p.operation,
            p.reason,
            null,
            null,
        )
        return { runId, dryRun: false }
    }
    /* The next item of a run after its checkpoint, or null when the run has no more; may move a retention run to its
       next class. */
    function nextItem(run, config) {
        if (handlers[run.jobType])
            return handlers[run.jobType].next(run, config)
        const after = (q, key) =>
            Array.from(
                (config.after ? q.condition(key, 'greater', config.after) : q)
                    .orderBy(key)
                    .limit(1)
                    .list(),
            )[0]?.[key] ?? null
        switch (run.jobType) {
            case 'op-rebuild-counters':
            case 'op-export-site':
                return after(
                    topicFind(run.siteId, config.contactListId),
                    'rootCommEventId',
                )
            case 'op-retry-deliveries':
                return after(
                    find(F + 'ForumDelivery', {
                        siteId: run.siteId,
                        state: 'failed',
                    }),
                    'deliveryId',
                )
            case 'op-retention':
                while (config.classIndex < config.classes.length) {
                    const cls = config.classes[config.classIndex]
                    const key = RETENTION_KEYS[cls]
                    const next = after(
                        retentionFind(run.siteId, cls, config.days[cls]),
                        key,
                    )
                    if (next) return RETENTION_CODES[cls] + ':' + next
                    config.classIndex++
                    config.after = null
                }
                return null
            case 'op-export-personal':
            case 'op-erasure': {
                const list =
                    run.jobType === 'op-erasure'
                        ? ERASURE_STEPS
                        : PERSONAL_SECTIONS
                const at = config.after ? list.indexOf(config.after) + 1 : 0
                return at < list.length ? list[at] : null
            }
        }
        return null
    }
    /* One item, in its own transaction (OperationServices.run#JobItem). */
    function runItem(runId, itemId) {
        const was = ec.artifactExecution.disableAuthz()
        try {
            const run = one(F + 'ForumJobRun', { runId })
            if (!run) missing()
            const config = JSON.parse(run.checkpoint || '{}')
            if (handlers[run.jobType])
                return handlers[run.jobType].item(run, config, itemId) || null
            switch (run.jobType) {
                case 'op-rebuild-counters': {
                    const t = one(
                        F + 'ForumTopic',
                        { rootCommEventId: itemId },
                        true,
                    )
                    if (t) moderation.recount(t)
                    return
                }
                case 'op-retry-deliveries': {
                    const d = one(
                        F + 'ForumDelivery',
                        { deliveryId: itemId },
                        true,
                    )
                    if (d?.state === 'failed')
                        update(d, {
                            state: 'retry',
                            dueAt: now(),
                            revision: Number(d.revision || 0) + 1,
                        })
                    return
                }
                case 'op-retention':
                    return applyRetention(run.siteId, itemId)
                case 'op-export-site':
                    return exportTopic(run.siteId, config, itemId)
                case 'op-export-personal':
                    return exportPersonal(run.siteId, config, itemId)
                case 'op-erasure':
                    return eraseStep(run.siteId, config, itemId)
            }
            invalid('Unknown operation run')
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    function applyRetention(siteId, itemId) {
        const at = itemId.indexOf(':'),
            cls = Object.keys(RETENTION_CODES).find(
                (k) => RETENTION_CODES[k] === itemId.slice(0, at),
            ),
            key = itemId.slice(at + 1)
        if (cls === 'deliveryDays')
            find(F + 'ForumDelivery', { siteId, deliveryId: key }).deleteAll()
        else if (cls === 'inboundDays')
            find(F + 'ForumInboundReceipt', {
                siteId,
                receiptId: key,
            }).deleteAll()
        else if (cls === 'invitationDays')
            find(S + 'PublicSiteInvitation', {
                siteId,
                invitationId: key,
            }).deleteAll()
        else if (cls === 'jobDays') {
            find(F + 'ForumJobItem', { runId: key }).deleteAll()
            find(F + 'ForumJobRun', { siteId, runId: key }).deleteAll()
        } else if (cls === 'deletedPostDays') {
            // The text goes; the post, its revision numbers, reply structure and the audit stay.
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: key },
                true,
            )
            if (!st || !['deleted', 'rejected'].includes(st.visibility)) return
            if (
                find(F + 'ForumReviewItem', { siteId, targetType: 'post', targetId: key })
                    .condition('state', 'in', ['pending', 'claimed'])
                    .count()
            )
                throw new Error('Post ' + key + ' has an open review or appeal')
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: key,
            })
            if (event) update(event, { body: '' })
            for (const r of rows(
                F + 'ForumPostRevision',
                { communicationEventId: key },
                1000,
            ))
                update(r, {
                    sourceText: '',
                    sanitizedBody: '',
                    publicHistoryAllowed: 'N',
                })
            update(st, { textRemovedAt: now() })
        }
    }

    /* The export row exists from the start, pending and expiring, so the cleanup removes the files of an export that
       failed or was cancelled; only a finished archive becomes downloadable. */
    function pendingExport(siteId, kind, contactListId) {
        const exportId = id()
        create(F + 'ForumExport', {
            exportId,
            siteId,
            partyId: requireUser(),
            kind,
            contactListId: contactListId || null,
            location: storageRoot() + '/exports/' + exportId + '.zip',
            schemaVersion: SCHEMA_VERSION,
            state: 'pending',
            createdAt: now(),
            expiresAt: stamp(millis(now()) + EXPORT_DAYS * DAY),
        })
        return exportId
    }
    /* ---- Site export ---- */
    const exportDir = (exportId) => storageRoot() + '/exports/' + exportId
    const handleOf = (siteId, partyId) =>
        partyId
            ? one(S + 'PublicSiteProfile', { siteId, partyId })?.handle || null
            : null
    function exportTopic(siteId, config, rootCommEventId) {
        const t = one(F + 'ForumTopic', { rootCommEventId })
        if (!t || t.siteId !== siteId || t.kind !== 'category') return
        const root = one(E + 'CommunicationEvent', {
            communicationEventId: rootCommEventId,
        })
        // Every post of the topic: a topic past the cap fails, named, rather than exporting in part.
        const posts = pagedRows(
            () => find(F + 'ForumPostState', { rootCommEventId }),
            'ordinal',
            100000,
        ).map((st) => {
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: st.communicationEventId,
            })
            return {
                postId: st.communicationEventId,
                ordinal: Number(st.ordinal),
                parentPostId: event?.parentCommEventId || null,
                authorPartyId: event?.fromPartyId || null,
                authorHandle: handleOf(siteId, event?.fromPartyId),
                entryDate: event?.entryDate ? millis(event.entryDate) : null,
                visibility: st.visibility,
                revision: Number(st.revision || 1),
                wiki: st.wiki === 'Y',
                body: event?.body || '',
                revisions: Array.from(
                    find(F + 'ForumPostRevision', {
                        communicationEventId: st.communicationEventId,
                    })
                        .orderBy('revision')
                        .list(),
                ).map((r) => ({
                    revision: Number(r.revision),
                    editorPartyId: r.editorPartyId || null,
                    editedAt: r.editedAt ? millis(r.editedAt) : null,
                    sourceFormat: r.sourceFormat || null,
                    sourceText: r.sourceText || '',
                    reason: r.reason || null,
                })),
                attachments: Array.from(
                    find(F + 'ForumAttachment', {
                        communicationEventId: st.communicationEventId,
                    }).list(),
                ).map((a) =>
                    pick(a, 'attachmentId filename mimeType byteSize altText'),
                ),
            }
        })
        writeJson(
            exportDir(config.exportId) + '/topics/' + rootCommEventId + '.json',
            {
                ...pick(
                    t,
                    'rootCommEventId contactListId revision acceptedAnswerId pinned unlisted visiblePostCount',
                ),
                title: root?.subject || '',
                closed: root?.statusId === 'CeResolved',
                tags: Array.from(find(F + 'ForumTopicTag', { rootCommEventId }).list()).map(
                    (v) => v.tagId,
                ),
                posts,
            },
        )
    }
    /* Settings without credentials, tokens or secrets; private conversations are not part of a site export. */
    function exportSettings(siteId, dir) {
        const s = one(S + 'PublicSite', { siteId })
        writeJson(dir + '/site.json', {
            ...pick(
                s,
                'siteId name state locale timeZone registrationMode approvalRequired',
            ),
            hosts: rows(S + 'PublicSiteHost', { siteId }).map((h) =>
                pick(h, 'hostname canonical'),
            ),
            mounts: rows(S + 'PublicSiteApp', { siteId }).map((m) =>
                pick(m, 'appMountId app pathPrefix enabled'),
            ),
        })
        writeJson(
            dir + '/categories.json',
            rows(F + 'ForumCategory', { siteId }, 1000).map((c) => ({
                ...pick(
                    c,
                    'contactListId parentContactListId sequenceNum slug publicationState visibility mode rules qualifyingSources',
                ),
                name:
                    one('mantle.marketing.contact.ContactList', {
                        contactListId: c.contactListId,
                    })?.contactListName || '',
            })),
        )
        writeJson(
            dir + '/tags.json',
            rows(F + 'ForumTag', { siteId }, 5000).map((t) =>
                pick(
                    t,
                    'tagId name normalizedName description allowedCategories',
                ),
            ),
        )
        writeJson(
            dir + '/mail-routes.json',
            rows(F + 'ForumMailRoute', { siteId }, 1000).map((r) =>
                pick(r, 'routeId address contactListId enabled'),
            ),
        )
        // The effective policy, without credentials: policy sections hold limits and rules only.
        writeJson(dir + '/policy.json', core.policy(siteId))
    }
    /* The manifest names each file with its SHA-256; the archive and its own checksum make the download. */
    function finishArchive(run, config, kind, exportId, dir, filename) {
        const files = []
        const walk = (location, prefix) => {
            for (const child of ec.resource
                .getLocationReference(location)
                .getDirectoryEntries()) {
                const path = prefix + child.fileName
                if (child.directory) walk(child.location, path + '/')
                else files.push({ path, location: child.location })
            }
        }
        walk(dir, '')
        files.sort((a, b) => (a.path < b.path ? -1 : 1))
        writeJson(dir + '/manifest.json', {
            schemaVersion: SCHEMA_VERSION,
            kind,
            siteId: run.siteId,
            authority: ec.factory.getConfValue('pass@authority-name') || 'local',
            createdAt: millis(now()),
            files: files.map((f) => ({
                path: f.path,
                sha256: ec.resource.digest(f.location, 'sha256'),
            })),
        })
        files.push({ path: 'manifest.json', location: dir + '/manifest.json' })
        const location = storageRoot() + '/exports/' + exportId + '.zip'
        ec.resource.writeZip(location, files)
        const ref = ec.resource.getLocationReference(location)
        const fields = {
            runId: run.runId,
            location,
            filename,
            mimeType: 'application/zip',
            checksum: ec.resource.digest(location, 'sha256'),
            byteSize: Number(ref.size ?? 0),
            schemaVersion: SCHEMA_VERSION,
            state: 'complete',
            expiresAt: stamp(millis(now()) + EXPORT_DAYS * DAY),
        }
        const pending = one(F + 'ForumExport', { exportId }, true)
        if (pending) update(pending, fields)
        else
            create(F + 'ForumExport', {
                exportId,
                siteId: run.siteId,
                partyId: run.partyId,
                kind,
                contactListId: config.contactListId || null,
                createdAt: now(),
                ...fields,
            })
    }

    /* Every row of a find, a page at a time; past the cap the export names what it left out rather than hiding it. */
    function pagedRows(makeFind, orderBy, cap = 200000) {
        const out = []
        for (let offset = 0; ; offset += 1000) {
            const page = Array.from(makeFind().orderBy(orderBy).offset(offset).limit(1000).list())
            out.push(...page)
            if (page.length < 1000) return out
            if (out.length >= cap) throw new Error('More than ' + cap + ' rows; export them in parts')
        }
    }
    /* ---- Personal data ---- */
    function exportPersonal(siteId, config, section) {
        const partyId = config.partyId,
            dir = exportDir(config.exportId)
        let value
        if (section === 'profile')
            value = pick(
                one(S + 'PublicSiteProfile', { siteId, partyId }),
                'handle displayName bio locale timeZone discoverability',
            )
        else if (section === 'memberships')
            value = {
                site: pick(member(siteId, partyId), 'state role joinedAt'),
                categories: rows(
                    'mantle.marketing.contact.ContactListParty',
                    { partyId },
                    500,
                )
                    .filter((lp) =>
                        one(F + 'ForumCategory', {
                            contactListId: lp.contactListId,
                            siteId,
                        }),
                    )
                    .map((lp) =>
                        pick(
                            lp,
                            'contactListId roleTypeId statusId fromDate thruDate',
                        ),
                    ),
                grants: rows(
                    S + 'PublicAccessGrant',
                    { siteId, partyId },
                    200,
                ).map((g) =>
                    pick(
                        g,
                        'targetType targetId sourceType fromDate thruDate revokedAt',
                    ),
                ),
            }
        else if (section === 'posts')
            // The member's own posts; other members' posts and staff evidence are not personal data of this member.
            value = pagedRows(
                () =>
                    find(F + 'ForumPostSearch', { siteId, fromPartyId: partyId }),
                'entryDate,communicationEventId',
            ).map((v) => ({
                postId: v.communicationEventId,
                rootCommEventId: v.rootCommEventId,
                ordinal: Number(v.ordinal),
                visibility: v.visibility,
                entryDate: v.entryDate ? millis(v.entryDate) : null,
                subject: Number(v.ordinal) === 1 ? v.subject : null,
                body: v.body || '',
            }))
        else if (section === 'drafts')
            value = pagedRows(() => find(F + 'ForumDraft', { siteId, partyId }), 'draftId').map((d) =>
                pick(
                    d,
                    'draftId mode rootCommEventId contactListId title sourceFormat sourceText',
                ),
            )
        else if (section === 'bookmarks')
            value = pagedRows(() => find(F + 'ForumBookmark', { siteId, partyId }), 'bookmarkId').map(
                (b) =>
                    pick(
                        b,
                        'bookmarkId rootCommEventId communicationEventId note remindAt createdAt',
                    ),
            )
        else if (section === 'preferences')
            value = {
                watch: rows(
                    F + 'ForumPreference',
                    { siteId, partyId },
                    2000,
                ).map((v) => pick(v, 'scopeType scopeId watchLevel')),
                delivery: rows(
                    F + 'ForumDeliveryPreference',
                    { siteId, partyId },
                    2000,
                ).map((v) =>
                    pick(
                        v,
                        'scopeType scopeId emailMode digestPeriod includeOwn suppressed',
                    ),
                ),
            }
        else invalid('Unknown export section')
        writeJson(dir + '/' + section + '.json', value)
    }
    /* Erasure anonymizes: the Party, posts, revisions, transactions and the audit stay, attribution goes. */
    function eraseStep(siteId, config, step) {
        const partyId = config.partyId
        if (step === 'profile') {
            const profile = one(
                S + 'PublicSiteProfile',
                { siteId, partyId },
                true,
            )
            if (profile)
                update(profile, {
                    handle:
                        'former-' +
                        String(config.requestId).slice(0, 12).toLowerCase(),
                    displayName: 'Former member',
                    bio: null,
                    avatarId: null,
                    discoverability: 'hidden',
                    revision: Number(profile.revision || 0) + 1,
                })
        } else if (step === 'delivery') {
            const old = one(
                F + 'ForumDeliveryPreference',
                {
                    siteId,
                    partyId,
                    scopeType: 'site',
                    scopeId: '_SITE_',
                },
                true,
            )
            const fields = {
                emailMode: 'None',
                suppressed: 'Y',
                optOutAt: now(),
            }
            if (old)
                update(old, {
                    ...fields,
                    revision: Number(old.revision || 0) + 1,
                })
            else
                create(F + 'ForumDeliveryPreference', {
                    siteId,
                    partyId,
                    scopeType: 'site',
                    scopeId: '_SITE_',
                    ...fields,
                    revision: 1,
                })
            find(F + 'ForumDelivery', { siteId, partyId })
                .condition('state', 'in', ['pending', 'retry'])
                .updateAll({ state: 'suppressed', reason: 'erasure' })
        } else if (step === 'drafts')
            find(F + 'ForumDraft', { siteId, partyId }).deleteAll()
        else if (step === 'bookmarks')
            find(F + 'ForumBookmark', { siteId, partyId }).deleteAll()
        else if (step === 'memberships') {
            // The last owner check runs again here with the site's owner rows locked, so two owners erased at once
            // leave one.
            find(S + 'PublicSiteParty', { siteId, role: 'owner', state: 'active' }).forUpdate(true).list()
            const m = member(siteId, partyId)
            if (m?.role === 'owner' && m.state === 'active') protectOwner(siteId, partyId)
            if (m)
                update(m, {
                    state: 'ended',
                    thruDate: now(),
                    revision: Number(m.revision || 0) + 1,
                })
            for (const lp of Array.from(
                find('mantle.marketing.contact.ContactListParty', {
                    partyId,
                }).list(),
            ))
                if (
                    active(lp) &&
                    one(F + 'ForumCategory', {
                        contactListId: lp.contactListId,
                        siteId,
                    })
                )
                    update(lp, { thruDate: now() })
        } else invalid('Unknown erasure step')
    }
    methods.requestPersonalDataAction = (p) => {
        site(p.siteId)
        const partyId = requireUser()
        if (!member(p.siteId, partyId)) missing()
        if (!['export', 'erasure'].includes(p.kind))
            invalid('Request an export or an erasure')
        if (p.kind === 'erasure') {
            if (p.confirm !== true)
                invalid(
                    'Confirm that your profile will be anonymized and your memberships ended',
                )
            if (
                find(F + 'ForumDataRequest', {
                    siteId: p.siteId,
                    partyId,
                    kind: 'erasure',
                })
                    .condition('state', 'in', ['requested', 'running'])
                    .count()
            )
                fail('Conflict', 'An erasure request is already open')
        }
        const requestId = id()
        const fields = {
            requestId,
            siteId: p.siteId,
            partyId,
            kind: p.kind,
            reason: p.reason || null,
            createdAt: now(),
            revision: 1,
        }
        if (p.kind === 'export') {
            const exportId = pendingExport(p.siteId, 'personal', null)
            const runId = startRun(p.siteId, 'op-export-personal', {
                requestId,
                partyId,
                exportId,
                after: null,
            })
            create(F + 'ForumDataRequest', {
                ...fields,
                state: 'running',
                runId,
                exportId,
            })
            return { requestId, runId, state: 'running' }
        }
        create(F + 'ForumDataRequest', { ...fields, state: 'requested' })
        return { requestId, state: 'requested' }
    }
    methods.findDataRequests = (p) => {
        site(p.siteId)
        const partyId = requireUser()
        let owner = false
        if (!p.mine)
            try {
                site(p.siteId, true)
                owner = true
            } catch (e) {
                ec.message.clearErrors()
            }
        const pg = page(
            p,
            'data-requests:' + p.siteId + ':' + (owner ? 'all' : partyId),
        )
        const list = Array.from(
            find(F + 'ForumDataRequest', {
                siteId: p.siteId,
                ...(owner ? {} : { partyId }),
            })
                .orderBy('-createdAt,requestId')
                .offset(pg.offset)
                .limit(pg.limit + 1)
                .list(),
        )
        return {
            requestList: list.slice(0, pg.limit).map((r) => ({
                ...pick(
                    r,
                    'requestId kind state reason decisionReason createdAt decidedAt exportId revision',
                ),
                handle: handleOf(p.siteId, r.partyId),
                mine: r.partyId === partyId,
            })),
            nextCursor:
                list.length > pg.limit ? pg.next(pg.offset + pg.limit) : null,
        }
    }
    methods.decideDataRequest = (p) => {
        site(p.siteId, true)
        const r = one(
            F + 'ForumDataRequest',
            { siteId: p.siteId, requestId: p.requestId },
            true,
        )
        if (!r || r.kind !== 'erasure') missing()
        revision({ revision: Number(r.revision || 1) }, p.expectedRevision)
        if (r.state !== 'requested')
            fail('Conflict', 'This request was already decided')
        if (!['approved', 'rejected'].includes(p.decision) || !p.reason)
            invalid('Approve or reject with a reason')
        const fields = {
            decisionReason: p.reason,
            decidedByPartyId: me(),
            decidedAt: now(),
            revision: Number(r.revision || 1) + 1,
        }
        if (p.decision === 'approved') {
            const m = member(p.siteId, r.partyId)
            if (m?.role === 'owner') protectOwner(p.siteId, r.partyId)
            const runId = startRun(p.siteId, 'op-erasure', {
                requestId: r.requestId,
                partyId: r.partyId,
                after: null,
            })
            update(r, { ...fields, state: 'running', runId })
        } else update(r, { ...fields, state: 'rejected' })
        audit(
            p.siteId,
            null,
            'member',
            r.partyId,
            'erasure-' + p.decision,
            p.reason,
            null,
            null,
        )
        return { state: r.state, revision: fields.revision }
    }

    /* ---- The run dispatcher (OperationServices.dispatch#Jobs) ---- */
    /* A run with a failed item stays failed, with no archive, until a retry finishes every item. */
    function finishRun(run, config) {
        const failed = Number(run.failedCount || 0) > 0
        if (handlers[run.jobType]?.finish)
            handlers[run.jobType].finish(run, config, failed)
        if (!failed && run.jobType === 'op-export-site')
            exportSettings(run.siteId, exportDir(config.exportId))
        if (!failed && run.jobType === 'op-export-site')
            finishArchive(
                run,
                config,
                'site',
                config.exportId,
                exportDir(config.exportId),
                'forum-export-' + run.siteId + '.zip',
            )
        if (!failed && run.jobType === 'op-export-personal')
            finishArchive(
                run,
                config,
                'personal',
                config.exportId,
                exportDir(config.exportId),
                'my-forum-data.zip',
            )
        if (['op-export-personal', 'op-erasure'].includes(run.jobType)) {
            const r = one(
                F + 'ForumDataRequest',
                { requestId: config.requestId },
                true,
            )
            if (r)
                update(r, {
                    state: failed ? 'failed' : 'complete',
                    revision: Number(r.revision || 1) + 1,
                })
        }
        update(run, { state: failed ? 'failed' : 'complete' })
    }
    function advance(runId, budget) {
        let done = 0
        while (done < budget) {
            const run = one(F + 'ForumJobRun', { runId }, true)
            // A cancel between items stops the run where it is; it can be resumed.
            if (!run || run.state !== 'pending') break
            const config = JSON.parse(run.checkpoint || '{}')
            const next = nextItem(run, config)
            if (next == null) {
                try {
                    finishRun(run, config)
                } catch (error) {
                    ec.message.clearErrors()
                    ec.logger.error(
                        'Forum operation run ' +
                            runId +
                            ' could not finish: ' +
                            firstLine(error),
                    )
                    update(run, { state: 'failed' })
                    for (const r of rows(F + 'ForumDataRequest', { runId }))
                        update(r, { state: 'failed', revision: Number(r.revision || 1) + 1 })
                }
                break
            }
            let error = null,
                patch = null
            try {
                patch = ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.forum.OperationServices.run#JobItem')
                    .parameters({ runId, itemId: next })
                    .requireNewTransaction(true)
                    .call()?.patch
            } catch (e) {
                error = firstLine(e)
                ec.message.clearErrors()
                ec.logger.error(
                    'Forum operation ' +
                        run.jobType +
                        ' item ' +
                        next +
                        ' of run ' +
                        runId +
                        ' failed: ' +
                        error,
                )
            }
            const item = one(F + 'ForumJobItem', { runId, itemId: next })
            const itemFields = {
                state: error ? 'failed' : 'complete',
                errorText: error,
                attempts: Number(item?.attempts || 0) + 1,
            }
            if (item) update(item, itemFields)
            else
                create(F + 'ForumJobItem', {
                    runId,
                    itemId: next,
                    ...itemFields,
                })
            // A handler's job keeps its own checkpoint: the item's patch on success, its onFailure patch otherwise.
            if (handlers[run.jobType])
                Object.assign(
                    config,
                    (error
                        ? handlers[run.jobType].onFailure?.(
                              config,
                              next,
                              error,
                              run,
                          )
                        : patch) || {},
                )
            else
                config.after =
                    run.jobType === 'op-retention'
                        ? next.slice(next.indexOf(':') + 1)
                        : next
            update(run, {
                checkpoint: JSON.stringify(config),
                successCount: Number(run.successCount || 0) + (error ? 0 : 1),
                failedCount: Number(run.failedCount || 0) + (error ? 1 : 0),
            })
            done++
        }
        return done
    }
    function dispatchJobs(p) {
        const was = ec.artifactExecution.disableAuthz()
        try {
            let processed = 0
            for (const run of Array.from(
                find(F + 'ForumJobRun', { state: 'pending' })
                    .condition('jobType', 'like', 'op-%')
                    .orderBy('createdAt,runId')
                    .limit(50)
                    .list(),
            )) {
                try {
                    // Small transactions, so a cancel waits for at most one chunk of items.
                    const budget = Number(p?.budget || 50)
                    for (let done = 0; done < budget; ) {
                        const chunk = Math.min(10, budget - done)
                        const n =
                            ec.service
                                .sync()
                                .throwOnError(true)
                                .name('mantle.forum.OperationServices.advance#Run')
                                .parameters({ runId: run.runId, budget: chunk })
                                .requireNewTransaction(true)
                                .call().processed || 0
                        processed += n
                        done += chunk
                        if (n < chunk) break
                    }
                } catch (error) {
                    ec.message.clearErrors()
                    ec.logger.error(
                        'Forum operation run ' +
                            run.runId +
                            ' failed: ' +
                            firstLine(error) +
                            (error?.stack ? '\n' + error.stack : ''),
                    )
                }
            }
            return { processed }
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    /* Expired export files and their rows, one at a time. */
    function cleanupExports() {
        const was = ec.artifactExecution.disableAuthz()
        try {
            for (const x of Array.from(
                find(F + 'ForumExport', {})
                    .condition('expiresAt', 'less', now())
                    .orderBy('expiresAt,exportId')
                    .limit(200)
                    .list(),
            )) {
                try {
                    if (x.location)
                        ec.resource.getLocationReference(x.location).delete()
                    const dir = x.location?.replace(/\.(zip|csv)$/, '')
                    if (dir && dir !== x.location) {
                        const ref = ec.resource.getLocationReference(dir)
                        if (ref.exists) deleteTree(ref)
                    }
                    find(F + 'ForumExport', {
                        exportId: x.exportId,
                    }).deleteAll()
                } catch (error) {
                    ec.message.clearErrors()
                    ec.logger.error(
                        'Forum export cleanup failed for ' +
                            x.exportId +
                            ': ' +
                            firstLine(error),
                    )
                }
            }
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    function deleteTree(ref) {
        for (const child of ref.getDirectoryEntries()) {
            if (child.directory)
                deleteTree(ec.resource.getLocationReference(child.location))
            else ec.resource.getLocationReference(child.location).delete()
        }
        ref.delete()
    }

    /* ---- Downloads ---- */
    methods.findExports = (p) => {
        site(p.siteId)
        const partyId = requireUser()
        return {
            exportList: Array.from(
                find(F + 'ForumExport', {
                    siteId: p.siteId,
                    partyId,
                    state: 'complete',
                })
                    .condition('expiresAt', 'greater', now())
                    .orderBy('-createdAt')
                    .limit(50)
                    .list(),
            ).map((x) =>
                pick(
                    x,
                    'exportId kind filename byteSize checksum createdAt expiresAt',
                ),
            ),
        }
    }
    /* A download rechecks who may have it now: the requester, still holding the authority it needed. */
    methods.getExport = (p) => {
        site(p.siteId)
        const x = one(F + 'ForumExport', {
            siteId: p.siteId,
            exportId: p.exportId,
        })
        if (!x || x.partyId !== requireUser() || x.state !== 'complete')
            missing()
        if (millis(x.expiresAt) <= millis(now())) missing()
        if (x.kind === 'site') site(p.siteId, true)
        else if (x.kind !== 'personal') staff(p.siteId, x.contactListId || null)
        return {
            export: pick(x, 'exportId filename mimeType byteSize checksum'),
            location: x.location,
        }
    }

    /* ---- Reports ---- */
    /* A CSV cell: quoted when needed, and a leading formula character neutralized for spreadsheets. */
    function csvCell(value) {
        let text = value == null ? '' : String(value)
        if (/^[=+\-@\t\r]/.test(text)) text = "'" + text
        return /[",\r\n]/.test(text)
            ? '"' + text.replace(/"/g, '""') + '"'
            : text
    }
    const csv = (header, lines) =>
        [header, ...lines]
            .map((cells) => cells.map(csvCell).join(','))
            .join('\r\n') + '\r\n'
    /* The report period: thru defaults to now, from to 30 days earlier; at most 366 days. */
    function period(p) {
        const thru = p.thruDate != null ? millis(p.thruDate) : millis(now())
        const from = p.fromDate != null ? millis(p.fromDate) : thru - 30 * DAY
        if (!(from < thru) || thru - from > 366 * DAY)
            invalid('A report covers from 1 day to 366 days')
        return { from, thru }
    }
    /* The categories a report may count for this actor: one category, or every category for site staff. */
    function reportScope(p) {
        staff(p.siteId, p.contactListId || null)
        const categories = p.contactListId
            ? [p.contactListId]
            : rows(F + 'ForumCategory', { siteId: p.siteId }, 1000).map(
                  (c) => c.contactListId,
              )
        return { siteStaff: isSiteStaff(p.siteId), categories }
    }
    function isSiteStaff(siteId) {
        try {
            staff(siteId, null)
            return true
        } catch (e) {
            ec.message.clearErrors()
            return false
        }
    }
    const ranged = (q, field, from, thru) =>
        q
            .condition(field, 'greater-equals', stamp(from))
            .condition(field, 'less', stamp(thru))
    methods.getActivity = (p) => {
        site(p.siteId)
        const { siteStaff, categories } = reportScope(p)
        const { from, thru } = period(p)
        const interval = p.interval || 'week'
        if (!['day', 'week'].includes(interval))
            invalid('Report by day or by week')
        const step = interval === 'day' ? DAY : 7 * DAY
        if ((thru - from) / step > 120)
            invalid('Choose a longer interval for this period')
        const posts = () =>
            find(F + 'ForumPostSearch', {
                siteId: p.siteId,
                visibility: 'approved',
            }).condition('contactListId', 'in', categories)
        const notes = []
        const contributors = new Set()
        let truncated = false
        const authored = Array.from(
            ranged(posts(), 'entryDate', from, thru).limit(50001).list(),
        )
        if (authored.length > 50000) truncated = true
        for (const v of authored.slice(0, 50000))
            contributors.add(v.fromPartyId)
        if (truncated)
            notes.push(
                'More than 50,000 posts: contributor count is a lower bound',
            )
        const buckets = []
        for (let start = from; start < thru; start += step) {
            const end = Math.min(start + step, thru)
            buckets.push({
                start,
                topics: ranged(posts(), 'entryDate', start, end)
                    .condition('ordinal', 1)
                    .count(),
                posts: ranged(posts(), 'entryDate', start, end).count(),
            })
        }
        const scoped = p.contactListId ? { contactListId: p.contactListId } : {}
        const reviews = () =>
            find(F + 'ForumReviewItem', { siteId: p.siteId, ...scoped })
        const pending = Array.from(
            reviews()
                .condition('state', 'in', ['pending', 'claimed'])
                .orderBy('createdAt')
                .limit(1)
                .list(),
        )[0]
        const out = {
            period: { from, thru, interval },
            incompletePeriod: thru > millis(now()) - 60000,
            participation: {
                topics: ranged(posts(), 'entryDate', from, thru)
                    .condition('ordinal', 1)
                    .count(),
                posts: ranged(posts(), 'entryDate', from, thru).count(),
                contributors: contributors.size,
            },
            moderation: {
                reviewsOpened: ranged(
                    reviews(),
                    'createdAt',
                    from,
                    thru,
                ).count(),
                pendingNow: reviews()
                    .condition('state', 'in', ['pending', 'claimed'])
                    .count(),
                oldestPendingHours: pending
                    ? Math.floor(
                          (millis(now()) - millis(pending.createdAt)) / 3600000,
                      )
                    : null,
                staffActions: ranged(
                    find(F + 'ForumModerationAction', {
                        siteId: p.siteId,
                        ...(p.contactListId
                            ? { contactListId: p.contactListId }
                            : {}),
                    }),
                    'createdAt',
                    from,
                    thru,
                ).count(),
            },
            privateConversations: null,
            delivery: null,
            capacity: null,
            failedRuns: ranged(
                find(F + 'ForumJobRun', { siteId: p.siteId, state: 'failed' }),
                'createdAt',
                from,
                thru,
            ).count(),
            buckets,
            notes,
        }
        if (out.failedRuns)
            notes.push(
                'Some operation runs in this period failed; their counts may be incomplete',
            )
        if (siteStaff && !p.contactListId) {
            out.privateConversations = {
                posts: ranged(
                    find(F + 'ForumPostSearch', {
                        siteId: p.siteId,
                        kind: 'private',
                        visibility: 'approved',
                    }),
                    'entryDate',
                    from,
                    thru,
                ).count(),
            }
            const deliveries = Array.from(
                ranged(
                    find(F + 'ForumDelivery', { siteId: p.siteId }),
                    'dueAt',
                    from,
                    thru,
                )
                    .limit(100001)
                    .list(),
            )
            const byState = {}
            for (const d of deliveries.slice(0, 100000))
                byState[d.state] = (byState[d.state] || 0) + 1
            out.delivery = {
                byState,
                total: Math.min(deliveries.length, 100000),
            }
            if (deliveries.length > 100000)
                notes.push(
                    'More than 100,000 deliveries: counts cover the first 100,000',
                )
            out.capacity = {
                attachments: find(F + 'ForumAttachment', {
                    siteId: p.siteId,
                }).count(),
                outboxPending: find(F + 'ForumOutbox', {
                    siteId: p.siteId,
                    state: 'pending',
                }).count(),
            }
        } else
            notes.push(
                'Private conversations, delivery and capacity are shown to site staff for the whole site only',
            )
        return out
    }
    /* A CSV report as an expiring download for the staff member who made it. */
    methods.exportReport = (p) => {
        site(p.siteId)
        const { siteStaff } = reportScope(p)
        const { from, thru } = period(p)
        let header, lines
        if (p.report === 'activity') {
            const a = methods.getActivity(p)
            header = ['periodStart', 'topics', 'posts']
            lines = a.buckets.map((b) => [
                new Date(b.start).toISOString(),
                b.topics,
                b.posts,
            ])
        } else if (p.report === 'moderation') {
            header = [
                'createdAt',
                'action',
                'targetType',
                'targetId',
                'staff',
                'reason',
            ]
            lines = Array.from(
                ranged(
                    find(F + 'ForumModerationAction', {
                        siteId: p.siteId,
                        ...(p.contactListId
                            ? { contactListId: p.contactListId }
                            : {}),
                    }),
                    'createdAt',
                    from,
                    thru,
                )
                    .orderBy('createdAt')
                    .limit(10000)
                    .list(),
            ).map((v) => [
                new Date(millis(v.createdAt)).toISOString(),
                v.action,
                v.targetType,
                v.targetId,
                handleOf(p.siteId, v.staffPartyId) ||
                    (v.staffPartyId ? 'staff' : 'system'),
                v.reason,
            ])
        } else if (p.report === 'deliveries') {
            if (!siteStaff || p.contactListId)
                fail('Unauthorized', 'Site staff export deliveries')
            header = [
                'dueAt',
                'deliveryId',
                'channel',
                'state',
                'reason',
                'attempts',
            ]
            lines = Array.from(
                ranged(
                    find(F + 'ForumDelivery', { siteId: p.siteId }),
                    'dueAt',
                    from,
                    thru,
                )
                    .orderBy('dueAt')
                    .limit(10000)
                    .list(),
            ).map((d) => [
                d.dueAt ? new Date(millis(d.dueAt)).toISOString() : '',
                d.deliveryId,
                d.channel,
                d.state,
                d.reason,
                d.attempts,
            ])
        } else invalid('Choose the activity, moderation or deliveries report')
        const exportId = id()
        const location = storageRoot() + '/exports/' + exportId + '.csv'
        ec.resource.getLocationReference(location).putText(csv(header, lines))
        const byteSize = Number(ec.resource.getLocationReference(location).size ?? 0)
        create(F + 'ForumExport', {
            exportId,
            siteId: p.siteId,
            partyId: requireUser(),
            kind: 'report-' + p.report,
            contactListId: p.contactListId || null,
            location,
            filename: p.report + '-' + p.siteId + '.csv',
            mimeType: 'text/csv',
            checksum: ec.resource.digest(location, 'sha256'),
            byteSize,
            schemaVersion: SCHEMA_VERSION,
            state: 'complete',
            createdAt: now(),
            expiresAt: stamp(millis(now()) + EXPORT_DAYS * DAY),
        })
        return { exportId, rowCount: lines.length }
    }
    /* One run's page of items in its own transaction (OperationServices.advance#Run), so a run that cannot record its
       progress does not undo another run's. */
    function advanceRun(runId, budget) {
        const was = ec.artifactExecution.disableAuthz()
        try {
            return { processed: advance(runId, Number(budget || 50)) }
        } finally {
            if (!was) ec.artifactExecution.enableAuthz()
        }
    }
    return {
        dispatchJobs,
        advanceRun,
        runItem,
        cleanupExports,
        registerJob,
        startRun,
        storageRoot,
    }
}
