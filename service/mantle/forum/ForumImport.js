/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Discourse migration (design §18.1, Migration screen): an operator-supplied backup archive is staged row by row from
 * its pg_dump COPY blocks into ForumImportMap, preflighted for identity, privacy and plugin decisions, imported in
 * dependency order into a disabled staging site through checkpointed runs, reconciled, and activated only after the
 * operator and a site owner approve the same reconciliation. No browser path, SQL connection or source password is
 * used; imported text is rendered and sanitized anew; nothing sends mail. Forum.js calls this with the shared core,
 * its methods map, the operations module (run dispatcher) and the moderation module.
 */
;(core, methods, operations, moderation) => {
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
        isOperator,
        member,
        active,
        site,
        revision,
        bump,
        audit,
        topic,
        category,
        plainText,
    } = core
    const M = F + 'ForumImportMap'
    const firstLine = (error) =>
        String(error?.message || error || '')
            .split('\n')[0]
            .slice(0, 200)
    /* A deterministic 53-bit hash of a staged row, to see when a replayed snapshot changed it. */
    function rowHash(text) {
        let h1 = 0xdeadbeef,
            h2 = 0x41c6ce57
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i)
            h1 = Math.imul(h1 ^ ch, 2654435761)
            h2 = Math.imul(h2 ^ ch, 1597334677)
        }
        h1 =
            Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
            Math.imul(h2 ^ (h2 >>> 13), 3266489909)
        h2 =
            Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
            Math.imul(h1 ^ (h1 >>> 13), 3266489909)
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
    }

    /* ---- Staging: the COPY rows the importer reads, keyed so related rows are found by prefix ---- */
    const KEYS = {
        users: (r) => r.id,
        user_emails: (r) => r.user_id,
        user_profiles: (r) => r.user_id,
        groups: (r) => r.id,
        group_users: (r) => r.group_id + ':' + r.user_id,
        categories: (r) => r.id,
        category_groups: (r) => r.category_id + ':' + r.group_id,
        topics: (r) => r.id,
        posts: (r) => r.topic_id + ':' + r.post_number,
        topic_allowed_users: (r) => r.topic_id + ':' + r.user_id,
        topic_allowed_groups: (r) => r.topic_id + ':' + r.group_id,
        uploads: (r) => r.id,
        upload_references: (r) => r.target_id + ':' + r.upload_id,
        post_uploads: (r) => r.post_id + ':' + r.upload_id,
        post_actions: (r) => r.id,
        tags: (r) => r.id,
        topic_tags: (r) => r.topic_id + ':' + r.tag_id,
        topic_users: (r) => r.topic_id + ':' + r.user_id,
        bookmarks: (r) => r.id,
        polls: (r) => r.id,
        poll_options: (r) => r.poll_id + ':' + r.id,
        poll_votes: (r) => r.poll_id + ':' + r.poll_option_id + ':' + r.user_id,
        discourse_solved_solved_topics: (r) => r.topic_id,
        topic_custom_fields: (r) => r.topic_id,
        permalinks: (r) => r.id,
    }
    /* Rows of a table the importer does not need are not staged. */
    const KEEP = {
        user_emails: (r) => r.primary === 't',
        post_actions: (r) => r.post_action_type_id === '2' && !r.deleted_at,
        topic_custom_fields: (r) => r.name === 'accepted_answer_post_id',
        upload_references: (r) => r.target_type === 'Post',
    }
    /* Plugin tables with no mapping here: listed for an explicit preserve-as-content or defer decision. */
    const pluginTable = (name) =>
        /^(discourse_|chat_|calendar_|assignments|reactions?_|post_voting)/.test(
            name,
        ) && name !== 'discourse_solved_solved_topics'
    function decodeCopy(field) {
        if (field === '\\N') return null
        return field.replace(
            /\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g,
            (all, code) => {
                if (code[0] === 'x')
                    return String.fromCharCode(parseInt(code.slice(1), 16))
                if (/^[0-7]/.test(code))
                    return String.fromCharCode(parseInt(code, 8))
                return (
                    { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[
                        code
                    ] ?? code
                )
            },
        )
    }
    function stageRow(siteId, importId, table, row) {
        if (KEEP[table] && !KEEP[table](row)) return
        const sourceType =
            table === 'post_uploads' ? 'upload_references' : table
        const sourceId = String(KEYS[table](row)).slice(0, 40)
        const payload = JSON.stringify(row),
            checksum = rowHash(payload)
        const old = one(M, { siteId, sourceType, sourceId }, true)
        if (!old)
            create(M, {
                siteId,
                sourceType,
                sourceId,
                importId,
                payload,
                checksum,
                state: 'staged',
            })
        else if (['staged', 'failed'].includes(old.state))
            update(old, { importId, payload, checksum })
        else if (old.checksum !== checksum)
            update(old, { importId, changedPayload: payload, state: 'changed' })
        // A row seen again carries this import, so one no longer in the source can be found after staging.
        else if (old.importId !== importId) update(old, { importId })
        // Indexes the importer looks up: a post by its id, an upload by its SHA-1.
        if (table === 'posts') stageIndex(siteId, 'post_ids', row.id, sourceId)
        if (table === 'uploads' && row.sha1)
            stageIndex(siteId, 'upload_sha1', row.sha1, row.id)
    }
    function stageIndex(siteId, sourceType, sourceId, targetId) {
        const old = one(M, { siteId, sourceType, sourceId })
        if (!old)
            create(M, {
                siteId,
                sourceType,
                sourceId,
                targetId,
                state: 'index',
            })
        else if (old.targetId !== targetId) update(old, { targetId })
    }
    function stageItem(run, config) {
        const read = ec.resource.readLines(
            config.dump,
            config.offset || 0,
            1000,
            8 * 1024 * 1024,
        )
        let table = config.table,
            columns = config.columns
        const seen = new Set(config.seen || [])
        let staged = 0
        for (const line of read.lines) {
            if (!table) {
                const m =
                    /^COPY public\.([a-z_0-9]+) \(([^)]*)\) FROM stdin;$/.exec(
                        line,
                    )
                if (m) {
                    seen.add(m[1])
                    table = KEYS[m[1]] ? m[1] : '__skip__'
                    columns = m[2]
                        .split(', ')
                        .map((c) => c.replace(/^"|"$/g, ''))
                }
                continue
            }
            if (line === '\\.') {
                table = null
                columns = null
                continue
            }
            if (table === '__skip__') continue
            const values = line.split('\t').map(decodeCopy)
            const row = {}
            columns.forEach((c, i) => (row[c] = values[i] ?? null))
            stageRow(run.siteId, config.importId, table, row)
            staged++
        }
        return {
            offset: read.nextOffset,
            table,
            columns,
            done: read.done,
            seen: [...seen],
            staged: Number(config.staged || 0) + staged,
        }
    }

    /* The operator's latest decision for a source item across this site's imports, so a replay or final delta keeps
       the decisions already made. */
    function decision(siteId, mappingType, sourceId) {
        const imports = rows(F + 'ForumImportRun', { siteId }, 200).map(
            (v) => v.importId,
        )
        if (!imports.length) return null
        return (
            Array.from(
                find(F + 'ForumImportMapping', {
                    mappingType,
                    sourceId: String(sourceId),
                })
                    .condition('importId', 'in', imports)
                    .orderBy('-decidedAt')
                    .limit(1)
                    .list(),
            )[0] || null
        )
    }
    /* The account holding an address, whatever its case. */
    function accountByEmail(email) {
        if (!email) return null
        return find('moqui.security.UserAccount', {})
            .condition(
                ec.entity.conditionFactory
                    .makeCondition('emailAddress', 'equals', String(email))
                    .ignoreCase(),
            )
            .one()
    }
    /* Source system users (ids at or below zero) and deleted authors (null) become one placeholder member, so their
       posts keep their place without an account anyone could recover. */
    function placeholder(siteId) {
        const key = { siteId, sourceType: 'placeholder', sourceId: 'former' }
        const old = one(M, key)
        if (old?.targetId) return old.targetId
        const partyId = ec.service
            .sync()
            .throwOnError(true)
            .name('mantle.party.PartyServices.create#Person')
            .parameters({ firstName: 'Former', lastName: 'member' })
            .call().partyId
        create(S + 'PublicSiteParty', {
            siteId,
            partyId,
            state: 'active',
            role: 'member',
            joinedAt: now(),
            revision: 1,
        })
        create(S + 'PublicSiteProfile', {
            siteId,
            partyId,
            handle: uniqueHandle(siteId, 'former-member', 'x'),
            displayName: 'Former member',
            discoverability: 'hidden',
            revision: 1,
        })
        old
            ? update(old, { targetId: partyId, state: 'index' })
            : create(M, { ...key, targetId: partyId, state: 'index' })
        return partyId
    }
    const authorOf = (siteId, userId) =>
        userId == null || Number(userId) <= 0
            ? placeholder(siteId)
            : imported(siteId, 'users', userId)
    /* ---- Registration and preflight ---- */
    function operatorOnly(siteId) {
        site(siteId, true)
        if (!isOperator()) fail('Unauthorized', 'An operator runs imports')
    }
    function ownerOrOperator(siteId) {
        site(siteId, true)
    }
    const importRow = (siteId, importId, lock) => {
        const v = one(F + 'ForumImportRun', { importId }, lock)
        if (!v || v.siteId !== siteId || String(v.stage).startsWith('mbox-'))
            missing()
        return v
    }
    const payloadOf = (siteId, sourceType, sourceId) => {
        const v = one(M, { siteId, sourceType, sourceId: String(sourceId) })
        return v?.payload ? JSON.parse(v.payload) : null
    }
    const mapsOf = (siteId, sourceType, prefix, limit = 10000) =>
        Array.from(
            (prefix
                ? find(M, { siteId, sourceType }).condition(
                      'sourceId',
                      'like',
                      prefix + '%',
                  )
                : find(M, { siteId, sourceType })
            )
                .orderBy('sourceId')
                .limit(limit)
                .list(),
        )
    /* Link rows still in the source: a row a later snapshot dropped grants nothing. */
    const liveMaps = (siteId, sourceType, prefix, limit) =>
        mapsOf(siteId, sourceType, prefix, limit).filter(
            (v) => !['removed', 'skipped'].includes(v.state),
        )
    methods.registerImport = (p) => {
        operatorOnly(p.siteId)
        const s = one(S + 'PublicSite', { siteId: p.siteId })
        if (s.state !== 'disabled')
            fail('Conflict', 'Import into a disabled staging site')
        const name = String(p.archiveName || '')
        if (
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) ||
            name.includes('..')
        )
            invalid('Name an archive file in the import directory')
        const dir = System.getProperty('pass_import_dir')
        if (!dir) fail('Unavailable', 'The import directory is not configured')
        const location = String(dir).replace(/\/$/, '') + '/' + name
        if (!ec.resource.getLocationReference(location).exists) missing()
        const digest = ec.resource.digest(location, 'sha256')
        if (digest !== String(p.checksum || '').toLowerCase())
            fail('Conflict', 'The archive checksum does not match')
        const version =
            /-v([0-9][0-9a-z.-]*?)-(\d{14})\.(?:tar\.gz|tgz|sql\.gz|sql)$/.exec(
                name,
            )
        const importId = id()
        create(F + 'ForumImportRun', {
            importId,
            siteId: p.siteId,
            sourceName: p.sourceName || name,
            archiveName: name,
            checksum: digest,
            discourseVersion: version?.[1] || null,
            schemaVersion: version?.[2] || null,
            stage: 'registered',
            stagingLocation: operations.storageRoot() + '/imports/' + importId,
            reconciliationRevision: 0,
            createdAt: now(),
            revision: 1,
        })
        audit(
            p.siteId,
            null,
            'import',
            importId,
            'register-import',
            name,
            null,
            1,
        )
        return {
            importId,
            discourseVersion: version?.[1] || null,
            schemaVersion: version?.[2] || null,
        }
    }
    /* Expands the archive into private staging and stages its dump in checkpointed pieces. */
    methods.stageImport = (p) => {
        operatorOnly(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (!['registered', 'staged'].includes(imp.stage))
            fail('Conflict', 'This import was already imported or cancelled')
        const source =
            String(System.getProperty('pass_import_dir')).replace(/\/$/, '') +
            '/' +
            imp.archiveName
        const staging = imp.stagingLocation
        let skipped = []
        if (/\.sql\.gz$/.test(imp.archiveName))
            ec.resource.gunzip(source, staging + '/dump.sql')
        else if (/\.sql$/.test(imp.archiveName))
            ec.resource
                .getLocationReference(staging + '/dump.sql')
                .putText(ec.resource.getLocationText(source))
        else {
            const out = ec.resource.extractArchive(source, staging, {})
            skipped = out.skipped
            const dump = out.entries.find((e) =>
                /(^|\/)dump\.sql(\.gz)?$/.test(e.path),
            )
            if (!dump) fail('Unprocessable', 'The archive has no dump.sql.gz')
            if (dump.path.endsWith('.gz'))
                ec.resource.gunzip(
                    staging + '/' + dump.path,
                    staging + '/dump.sql',
                )
            else if (dump.path !== 'dump.sql')
                ec.resource
                    .getLocationReference(staging + '/dump.sql')
                    .putText(
                        ec.resource.getLocationText(staging + '/' + dump.path),
                    )
        }
        const runId = operations.startRun(p.siteId, 'op-import-stage', {
            importId: imp.importId,
            dump: staging + '/dump.sql',
            offset: 0,
            table: null,
            columns: null,
            done: false,
            seen: [],
            skipped,
        })
        update(imp, {
            stage: 'staging',
            stageRunId: runId,
            revision: Number(imp.revision) + 1,
        })
        return { runId }
    }
    /* What blocks activation and what needs a decision, from the staged rows and the operator's mappings. */
    function preflight(imp, config) {
        const siteId = imp.siteId
        const decided = (mappingType, sourceId) =>
            decision(siteId, mappingType, sourceId)
        const blockers = [],
            warnings = []
        const counts = {}
        for (const t of Object.keys(KEYS))
            if (t !== 'post_uploads')
                counts[t] = find(M, { siteId, sourceType: t }).count()
        for (const v of mapsOf(siteId, 'users', null, 100000)) {
            const u = JSON.parse(v.payload)
            if (
                (u.admin === 't' || u.moderator === 't') &&
                !decided('staff', u.id)
            )
                blockers.push({
                    type: 'staff',
                    sourceId: u.id,
                    detail:
                        u.username +
                        ' was staff: choose owner, moderator or member',
                })
            const email = payloadOf(siteId, 'user_emails', u.id)?.email
            if (email && !decided('identity', u.id)) {
                const existing = accountByEmail(email)
                // The account this import already made for the member is not a conflict.
                if (
                    existing &&
                    existing.partyId !== target(siteId, 'users', u.id)
                )
                    blockers.push({
                        type: 'identity',
                        sourceId: u.id,
                        detail:
                            u.username +
                            ' matches an existing account by address: map, create or inactive',
                    })
            }
        }
        for (const v of mapsOf(siteId, 'categories')) {
            const c = JSON.parse(v.payload)
            if (c.read_restricted !== 't') continue
            for (const cg of liveMaps(siteId, 'category_groups', c.id + ':')) {
                const groupId = JSON.parse(cg.payload).group_id
                if (groupId !== '0' && !decided('group', groupId))
                    blockers.push({
                        type: 'group',
                        sourceId: groupId,
                        detail:
                            'Restricted category ' +
                            c.name +
                            ' admits group ' +
                            (payloadOf(siteId, 'groups', groupId)?.name ||
                                groupId) +
                            ': grant, snapshot or deny',
                    })
            }
        }
        for (const v of mapsOf(siteId, 'topic_allowed_groups')) {
            const groupId = JSON.parse(v.payload).group_id
            if (!decided('group', groupId))
                blockers.push({
                    type: 'group',
                    sourceId: groupId,
                    detail:
                        'Private messages admit group ' +
                        (payloadOf(siteId, 'groups', groupId)?.name ||
                            groupId) +
                        ': snapshot or deny',
                })
        }
        const features = (config?.seen || []).filter(pluginTable)
        for (const table of features)
            if (!decided('feature', table))
                blockers.push({
                    type: 'feature',
                    sourceId: table,
                    detail: 'Plugin data ' + table + ': preserve or defer',
                })
        const uploadRoot = uploadsRoot(imp)
        let missingUploads = 0
        for (const v of mapsOf(siteId, 'uploads', null, 100000))
            if (!uploadLocation(uploadRoot, JSON.parse(v.payload)))
                missingUploads++
        if (missingUploads)
            warnings.push(
                missingUploads +
                    ' uploads are referenced but not in the archive',
            )
        if (counts.post_actions == null) counts.post_actions = 0
        // Deduplicate by type and source.
        const seenKeys = new Set()
        return {
            counts,
            features,
            missingUploads,
            archiveSkipped: config?.skipped || [],
            blockers: blockers.filter((b) => {
                const k = b.type + ':' + b.sourceId
                if (seenKeys.has(k)) return false
                seenKeys.add(k)
                return true
            }),
            warnings,
        }
    }
    function uploadsRoot(imp) {
        const ref = ec.resource.getLocationReference(
            imp.stagingLocation + '/uploads',
        )
        if (!ref.exists) return null
        const db = ref.getDirectoryEntries().find((e) => e.directory)
        return db ? db.location : null
    }
    function uploadLocation(root, upload) {
        if (!root) return null
        // The archive path from the dump's URL: plain names under original/ only, nothing that could leave the tree.
        const m = /\/(original\/\d+X\/[A-Za-z0-9._\/-]+)$/.exec(
            upload.url || '',
        )
        if (
            !m ||
            m[1]
                .split('/')
                .some((part) => part === '..' || part === '.' || !part)
        )
            return null
        const location = root + '/' + m[1]
        return ec.resource.getLocationReference(location).exists
            ? location
            : null
    }
    const DECISIONS = {
        identity: ['map', 'create', 'inactive'],
        staff: ['owner', 'moderator', 'member'],
        group: ['grant', 'snapshot', 'deny'],
        feature: ['preserve', 'defer'],
        change: ['keep', 'apply'],
    }
    methods.storeImportMappings = (p) => {
        operatorOnly(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (['active', 'cancelled'].includes(imp.stage))
            fail('Conflict', 'This import is closed')
        for (const m of p.mappings || []) {
            if (!DECISIONS[m.mappingType]?.includes(m.decision) || !m.sourceId)
                invalid(
                    'Each mapping needs a type, a source and an allowed decision',
                )
            if (m.mappingType === 'identity' && m.decision === 'map') {
                // A source identity joins only the account that holds the same verified address; never by display name.
                const email = payloadOf(
                    p.siteId,
                    'user_emails',
                    m.sourceId,
                )?.email
                const account = accountByEmail(email)
                if (
                    !account ||
                    account.partyId !== m.targetId ||
                    !ec.resource
                        .script(
                            'component://mr-mantle/service/mantle/public/ConfirmedAddress.js',
                        )
                        .verified(account.userId)
                )
                    invalid(
                        'A source identity maps only to the account with the same verified address',
                    )
            }
            const key = {
                importId: imp.importId,
                mappingType: m.mappingType,
                sourceId: String(m.sourceId),
            }
            const fields = {
                decision: m.decision,
                targetId: m.targetId || null,
                reason: m.reason || null,
                decidedByPartyId: me(),
                decidedAt: now(),
            }
            const old = one(F + 'ForumImportMapping', key, true)
            old
                ? update(old, fields)
                : create(F + 'ForumImportMapping', { ...key, ...fields })
            if (m.mappingType === 'change')
                resolveChange(p.siteId, m.sourceId, m.decision)
        }
        const stageRun = imp.stageRunId
            ? one(F + 'ForumJobRun', { runId: imp.stageRunId })
            : null
        const report = preflight(
            imp,
            stageRun ? JSON.parse(stageRun.checkpoint || '{}') : null,
        )
        // A decision after reconciliation changes what was approved: reconcile and approve again.
        update(imp, {
            preflightJson: JSON.stringify(report),
            ...(imp.stage === 'reconciled'
                ? {
                      stage: 'imported',
                      operatorRevision: null,
                      ownerRevision: null,
                  }
                : {}),
            revision: Number(imp.revision) + 1,
        })
        audit(
            p.siteId,
            null,
            'import',
            imp.importId,
            'import-mappings',
            p.reason || 'Mappings stored',
            null,
            null,
        )
        return { blockers: report.blockers.length }
    }
    /* Rows a re-staged snapshot no longer has: access they granted, and records they made, wait for a decision. */
    const REMOVABLE = [
        'group_users',
        'category_groups',
        'topic_allowed_users',
        'topic_allowed_groups',
        'categories',
        'topics',
        'posts',
    ]
    function markRemoved(siteId, importId) {
        for (const sourceType of REMOVABLE)
            for (const v of Array.from(
                find(M, { siteId, sourceType })
                    .condition('importId', 'not-equals', importId)
                    .condition('state', 'in', [
                        'staged',
                        'failed',
                        'imported',
                        'changed',
                    ])
                    .limit(100000)
                    .list(),
            )) {
                const link = !['categories', 'topics', 'posts'].includes(
                    sourceType,
                )
                if (v.state === 'imported' || v.state === 'changed' || link)
                    update(v, { state: 'removed' })
                else
                    find(M, {
                        siteId,
                        sourceType,
                        sourceId: v.sourceId,
                    }).deleteAll()
            }
    }
    /* Revokes the grants an imported group gave, for one member or for one category. */
    function revokeGroupGrants(siteId, groupId, fields) {
        for (const g of rows(
            S + 'PublicAccessGrant',
            { siteId, sourceType: 'manual', sourceId: 'import', ...fields },
            10000,
        ))
            if (g.reason === 'Imported group ' + groupId && !g.revokedAt)
                update(g, {
                    revokedAt: now(),
                    revision: Number(g.revision || 1) + 1,
                })
    }
    /* A source row that changed or disappeared after it was imported: keep the imported version, or apply the source.
       Applying carries what decides who sees what (deletion, hiding, listing, category, restriction, membership),
       not just the text. */
    function resolveChange(siteId, key, choice) {
        const at = key.indexOf(':')
        const map = one(
            M,
            {
                siteId,
                sourceType: key.slice(0, at),
                sourceId: key.slice(at + 1),
            },
            true,
        )
        if (!map || !['changed', 'removed'].includes(map.state))
            invalid('Choose a source row that changed or was removed: table:id')
        if (choice === 'keep') {
            update(map, { state: 'imported', changedPayload: null })
            return
        }
        if (map.state === 'removed') {
            const row = map.payload ? JSON.parse(map.payload) : {}
            if (map.sourceType === 'group_users')
                revokeGroupGrants(siteId, row.group_id, {
                    partyId: imported(siteId, 'users', row.user_id) || '_NONE_',
                })
            else if (map.sourceType === 'category_groups')
                revokeGroupGrants(siteId, row.group_id, {
                    targetType: 'category',
                    targetId:
                        imported(siteId, 'categories', row.category_id) ||
                        '_NONE_',
                })
            else if (map.sourceType === 'topic_allowed_users') {
                const root = imported(siteId, 'topics', row.topic_id)
                const partyId = imported(siteId, 'users', row.user_id)
                const pt =
                    root && partyId
                        ? one(
                              F + 'ForumParticipant',
                              { rootCommEventId: root, partyId },
                              true,
                          )
                        : null
                if (pt && !pt.endedAt) update(pt, { endedAt: now() })
            } else if (map.sourceType === 'topic_allowed_groups')
                invalid(
                    'A group removed from a private message needs a participant review: keep it, then edit the participants',
                )
            else if (map.sourceType === 'categories') {
                const c = map.targetId
                    ? one(
                          F + 'ForumCategory',
                          { contactListId: map.targetId },
                          true,
                      )
                    : null
                if (c)
                    update(c, {
                        publicationState: 'disabled',
                        policyRevision: Number(c.policyRevision || 0) + 1,
                    })
            } else if (map.targetId) {
                const st = one(
                    F + 'ForumPostState',
                    { communicationEventId: map.targetId },
                    true,
                )
                if (st && st.visibility !== 'deleted')
                    update(st, {
                        visibility: 'deleted',
                        deletedAt: now(),
                        deleteReason: 'Removed from the source before cutover',
                    })
            }
            bump(siteId)
            update(map, { state: 'skipped' })
            return
        }
        const row = JSON.parse(map.changedPayload)
        if (map.sourceType === 'posts' && map.targetId) {
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: map.targetId },
                true,
            )
            const next = Number(st.revision || 1) + 1
            const body = render(siteId, row.raw)
            const event = one(
                E + 'CommunicationEvent',
                { communicationEventId: map.targetId },
                true,
            )
            create(F + 'ForumPostRevision', {
                communicationEventId: map.targetId,
                revision: next,
                sourceFormat: 'markdown',
                sourceText: row.raw || '',
                sanitizedBody: body,
                editorPartyId: event.fromPartyId,
                editedAt: now(),
                reason: 'Changed in the source before cutover',
                publicHistoryAllowed: 'N',
            })
            update(event, { body })
            const visibility = visibilityOf(row)
            update(st, {
                revision: next,
                visibility,
                approvedRevision:
                    visibility === 'approved' ? next : st.approvedRevision,
                ...(visibility === 'deleted' && !st.deletedAt
                    ? {
                          deletedAt: now(),
                          deleteReason: 'Deleted in the source before cutover',
                      }
                    : {}),
            })
        } else if (map.sourceType === 'topics' && map.targetId) {
            const old = JSON.parse(map.payload)
            if (old.archetype !== row.archetype)
                invalid(
                    'A topic that became or stopped being a private message needs a fresh import',
                )
            const t = one(
                F + 'ForumTopic',
                { rootCommEventId: map.targetId },
                true,
            )
            const fields = {
                unlisted: row.visible === 'f' ? 'Y' : 'N',
                revision: Number(t.revision) + 1,
            }
            if (
                row.category_id !== old.category_id &&
                row.archetype !== 'private_message'
            ) {
                const contactListId = imported(
                    siteId,
                    'categories',
                    row.category_id,
                )
                if (!contactListId)
                    invalid(
                        'The topic moved to a category that was not imported',
                    )
                fields.contactListId = contactListId
                const cf = ec.entity.conditionFactory
                for (const e of Array.from(
                    find(E + 'CommunicationEvent', {})
                        .condition(
                            cf.makeCondition(
                                [
                                    cf.makeCondition(
                                        'communicationEventId',
                                        'equals',
                                        map.targetId,
                                    ),
                                    cf.makeCondition(
                                        'rootCommEventId',
                                        'equals',
                                        map.targetId,
                                    ),
                                ],
                                'or',
                            ),
                        )
                        .limit(20000)
                        .list(),
                ))
                    update(e, { contactListId })
            }
            update(t, fields)
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: map.targetId },
                true,
            )
            if (row.deleted_at && st.visibility !== 'deleted')
                update(st, {
                    visibility: 'deleted',
                    deletedAt: now(),
                    deleteReason: 'Deleted in the source before cutover',
                })
            bump(siteId)
        } else if (map.sourceType === 'categories' && map.targetId) {
            const c = one(
                F + 'ForumCategory',
                { contactListId: map.targetId },
                true,
            )
            const restricted = row.read_restricted === 't'
            update(c, {
                visibility: restricted ? 'category' : 'public',
                policyRevision: Number(c.policyRevision || 0) + 1,
            })
            update(
                one('mantle.marketing.contact.ContactList', {
                    contactListId: map.targetId,
                }),
                {
                    postingEnumId: restricted ? 'ClpMembers' : 'ClpAnyUser',
                },
            )
            bump(siteId)
        }
        update(map, {
            state: 'imported',
            payload: map.changedPayload,
            checksum: rowHash(map.changedPayload),
            changedPayload: null,
        })
    }
    methods.findImports = (p) => {
        ownerOrOperator(p.siteId)
        return {
            // a mailing list's archive (an mbox import, ForumLists.js) is not a migration: it is read by getMboxImport
            importList: rows(
                F + 'ForumImportRun',
                { siteId: p.siteId },
                100,
            )
                .filter((v) => !String(v.stage).startsWith('mbox-'))
                .map((v) =>
                pick(
                    v,
                    'importId sourceName archiveName discourseVersion schemaVersion stage reconciliationRevision operatorRevision ownerRevision createdAt revision',
                ),
            ),
        }
    }
    methods.getImport = (p) => {
        ownerOrOperator(p.siteId)
        const imp = importRow(p.siteId, p.importId)
        return {
            import: pick(
                imp,
                'importId sourceName archiveName checksum discourseVersion schemaVersion stage stageRunId importRunId reconciliationRevision operatorRevision ownerRevision reportExportId createdAt revision',
            ),
            preflight: imp.preflightJson ? JSON.parse(imp.preflightJson) : null,
            reconciliation: imp.reconciliationJson
                ? JSON.parse(imp.reconciliationJson)
                : null,
            mappingList: rows(
                F + 'ForumImportMapping',
                { importId: imp.importId },
                1000,
            ).map((m) =>
                pick(
                    m,
                    'mappingType sourceId decision targetId reason decidedAt',
                ),
            ),
        }
    }

    /* ---- Import: phases in dependency order, each item one source row ---- */
    const PHASES = [
        ['u', 'users'],
        ['c0', 'categories'],
        ['c1', 'categories'],
        ['c2', 'categories'],
        ['t', 'topics'],
        ['p', 'posts'],
        ['q', 'posts', 'imported'],
        ['f', 'uploads'],
        ['g', 'upload_references'],
        ['r', 'post_actions'],
        ['x', 'topic_tags'],
        ['a', 'discourse_solved_solved_topics'],
        ['b', 'topic_custom_fields'],
        ['l', 'polls'],
        ['m', 'topic_users'],
        ['k', 'bookmarks'],
        ['h', 'permalinks'],
        ['n', 'topics', 'imported'],
    ]
    methods.runImport = (p) => {
        operatorOnly(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (!['staged', 'imported', 'reconciled'].includes(imp.stage))
            fail('Conflict', 'Stage the archive before importing')
        const runId = operations.startRun(p.siteId, 'op-import', {
            importId: imp.importId,
            phase: 0,
            after: null,
        })
        update(imp, {
            stage: 'importing',
            importRunId: runId,
            revision: Number(imp.revision) + 1,
        })
        audit(
            p.siteId,
            null,
            'import',
            imp.importId,
            'run-import',
            p.reason || 'Import started',
            null,
            null,
        )
        return { runId }
    }
    function importNext(run, config) {
        // A cancelled, reconciled or active import takes no more rows; run the import again to continue.
        const imp = one(F + 'ForumImportRun', { importId: config.importId })
        if (!imp || !['importing', 'imported'].includes(imp.stage)) return null
        // A retry (which clears the checkpoint) starts the phases again; finished rows are skipped by their state.
        if (config.after === undefined && config.phase >= PHASES.length)
            config.phase = 0
        while (config.phase < PHASES.length) {
            const [code, sourceType, state] = PHASES[config.phase]
            let q = find(M, { siteId: run.siteId, sourceType }).condition(
                'state',
                'in',
                state ? [state] : ['staged', 'failed'],
            )
            // A first post is imported with its topic.
            if (sourceType === 'posts' && code === 'p')
                q = q.condition('sourceId', 'not-like', '%:1')
            const next = Array.from(
                (config.after
                    ? q.condition('sourceId', 'greater', config.after)
                    : q
                )
                    .orderBy('sourceId')
                    .limit(1)
                    .list(),
            )[0]
            if (next) return code + '|' + next.sourceId
            config.phase++
            config.after = null
        }
        return null
    }
    function importItem(run, config, itemId) {
        const at = itemId.indexOf('|'),
            code = itemId.slice(0, at),
            sourceId = itemId.slice(at + 1)
        const phase = PHASES.find((ph) => ph[0] === code)
        const map = one(
            M,
            { siteId: run.siteId, sourceType: phase[1], sourceId },
            true,
        )
        const ctx = {
            siteId: run.siteId,
            imp: one(F + 'ForumImportRun', { importId: config.importId }),
            config,
        }
        const patch = { after: sourceId, phase: PHASES.indexOf(phase) }
        const row = map.payload ? JSON.parse(map.payload) : {}
        const target = IMPORTERS[code](ctx, row, map)
        if (target === undefined) return patch
        update(map, {
            state: target === null ? 'skipped' : 'imported',
            targetId: target || map.targetId,
            errorText: null,
        })
        return patch
    }
    /* Imported identities, by source id. */
    const target = (siteId, sourceType, sourceId) =>
        sourceId == null
            ? null
            : one(M, { siteId, sourceType, sourceId: String(sourceId) })
                  ?.targetId || null
    const imported = (siteId, sourceType, sourceId) => {
        const v =
            sourceId == null
                ? null
                : one(M, { siteId, sourceType, sourceId: String(sourceId) })
        return v?.state === 'imported' ? v.targetId : null
    }
    const postTarget = (siteId, postId) => {
        const key = target(siteId, 'post_ids', postId)
        return key ? imported(siteId, 'posts', key) : null
    }
    const decisionOf = (ctx, mappingType, sourceId) =>
        decision(ctx.siteId, mappingType, sourceId)
    /* A dump timestamp (UTC, microseconds) as a time stamp; an unreadable one is the import time. */
    function when(text) {
        if (!text) return now()
        const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(?:\.(\d+))?/.exec(
            String(text),
        )
        const ms = m
            ? Date.parse(
                  m[1] +
                      'T' +
                      m[2] +
                      '.' +
                      (m[3] || '0').padEnd(3, '0').slice(0, 3) +
                      'Z',
              )
            : NaN
        return Number.isNaN(ms) ? now() : stamp(ms)
    }
    /* Source Markdown rendered and sanitized anew; links to uploads that were mapped become their file names. */
    function render(siteId, raw) {
        const text = String(raw || '')
            .replace(
                /!?\[([^\]]*)\]\(upload:\/\/([a-zA-Z0-9]+)(\.\w+)?\)/g,
                (all, alt, short) => {
                    const upload = uploadByShort(siteId, short)
                    return upload
                        ? '[attachment: ' +
                              (upload.original_filename || alt) +
                              ']'
                        : all
                },
            )
            .replace(
                /\/uploads\/[^\s)"]*\/original\/\d+X\/(?:[0-9a-f]\/)*([0-9a-f]{40})\.\w+/g,
                (all, sha1) => {
                    const upload = uploadBySha1(siteId, sha1)
                    return upload
                        ? 'attachment: ' + upload.original_filename
                        : all
                },
            )
        return StringUtilities.cleanHtml(ec.resource.markdownHtml(text))
    }
    function uploadBySha1(siteId, sha1) {
        const uploadId = target(siteId, 'upload_sha1', sha1)
        return uploadId ? payloadOf(siteId, 'uploads', uploadId) : null
    }
    /* Discourse short upload URLs are the SHA-1 in base 62. */
    function uploadByShort(siteId, short) {
        const digits =
            '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
        let n = 0n
        for (const ch of short) {
            const d = digits.indexOf(ch)
            if (d < 0) return null
            n = n * 62n + BigInt(d)
        }
        return uploadBySha1(siteId, n.toString(16).padStart(40, '0'))
    }
    const TRUST = ['new', 'basic', 'member', 'regular', 'regular']
    const WATCH = [
        'Muted',
        'Normal',
        'Tracking',
        'Watching',
        'WatchingFirstPost',
    ]
    function uniqueHandle(siteId, wanted, sourceId) {
        const base =
            String(wanted || 'member')
                .toLowerCase()
                .replace(/[^a-z0-9_.-]+/g, '-')
                .slice(0, 30) || 'member'
        if (!one(S + 'PublicSiteProfile', { siteId, handle: base })) return base
        return (base.slice(0, 24) + '-' + sourceId).slice(0, 40)
    }
    /* A post with its first revision; beforeState creates rows the state depends on, such as a new topic. */
    function createPost(ctx, fields, beforeState) {
        const postId = id()
        create(E + 'CommunicationEvent', {
            communicationEventId: postId,
            communicationEventTypeId: 'Message',
            contactListId: fields.contactListId,
            fromPartyId: fields.author,
            rootCommEventId: fields.root || null,
            parentCommEventId: fields.parent || null,
            subject: fields.subject,
            body: fields.body,
            statusId: fields.closed ? 'CeResolved' : 'CeReceived',
            entryDate: fields.entryDate,
        })
        if (beforeState) beforeState(postId)
        create(F + 'ForumPostState', {
            communicationEventId: postId,
            rootCommEventId: fields.root || postId,
            ordinal: fields.ordinal,
            revision: 1,
            approvedRevision: fields.visibility === 'approved' ? 1 : null,
            visibility: fields.visibility,
            wiki: fields.wiki ? 'Y' : 'N',
            reactionCount: 0,
            ...(fields.visibility === 'deleted'
                ? {
                      deletedAt: fields.entryDate,
                      deleteReason: 'Deleted before import',
                  }
                : {}),
        })
        create(F + 'ForumPostRevision', {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: 'markdown',
            sourceText: fields.raw || '',
            sanitizedBody: fields.body,
            editorPartyId: fields.author,
            editedAt: fields.entryDate,
            publicHistoryAllowed: 'N',
        })
        return postId
    }
    /* Deleted posts stay deleted; whispers and posts the source hid for flags stay hidden from readers. */
    const visibilityOf = (row) =>
        row.deleted_at
            ? 'deleted'
            : row.post_type === '4' || row.hidden === 't'
              ? 'hidden'
              : 'approved'
    const legacy = (ctx, path, targetType, targetId) => {
        const key = { siteId: ctx.siteId, sourcePath: path }
        const old = one(F + 'ForumLegacyUrl', key)
        const fields = { targetType, targetId, importId: ctx.imp.importId }
        old
            ? update(old, fields)
            : create(F + 'ForumLegacyUrl', { ...key, ...fields })
    }
    const IMPORTERS = {
        /* An identity: an existing account only by the operator's verified-address mapping; otherwise a new party with
           a site profile, an account to recover by email when there is an address, and no internal group. */
        u(ctx, u) {
            const siteId = ctx.siteId
            const email = payloadOf(siteId, 'user_emails', u.id)?.email || null
            const decision = decisionOf(ctx, 'identity', u.id)?.decision
            // System users and bots share the placeholder; they get no account.
            if (Number(u.id) <= 0) return placeholder(siteId)
            const existing = accountByEmail(email)
            let partyId
            if (decision === 'map')
                partyId = decisionOf(ctx, 'identity', u.id).targetId
            else {
                partyId = ec.service
                    .sync()
                    .throwOnError(true)
                    .name('mantle.party.PartyServices.create#Person')
                    .parameters({
                        firstName: u.name || u.username,
                        lastName: u.username,
                    })
                    .call().partyId
                // An address an existing account holds stays with that account until the operator decides.
                // Unconfirmed and staged source accounts get no login anyone could recover.
                if (
                    email &&
                    !existing &&
                    decision !== 'inactive' &&
                    u.active !== 'f' &&
                    u.staged !== 't'
                )
                    create('moqui.security.UserAccount', {
                        userId: id(),
                        username: email,
                        emailAddress: email,
                        partyId,
                        userFullName: u.name || u.username,
                        disabled: 'N',
                    })
            }
            const role = decisionOf(ctx, 'staff', u.id)?.decision
            if (!member(siteId, partyId))
                create(S + 'PublicSiteParty', {
                    siteId,
                    partyId,
                    state: 'active',
                    role:
                        role === 'owner' || role === 'moderator'
                            ? role
                            : 'member',
                    joinedAt: when(u.created_at),
                    revision: 1,
                })
            if (!one(S + 'PublicSiteProfile', { siteId, partyId })) {
                const profile = payloadOf(siteId, 'user_profiles', u.id)
                create(S + 'PublicSiteProfile', {
                    siteId,
                    partyId,
                    handle: uniqueHandle(siteId, u.username, u.id),
                    displayName: u.name || u.username,
                    bio: profile?.bio_raw
                        ? render(siteId, profile.bio_raw)
                        : null,
                    discoverability: 'members',
                    revision: 1,
                })
            }
            if (!one(F + 'ForumMemberState', { siteId, partyId }))
                create(F + 'ForumMemberState', {
                    siteId,
                    partyId,
                    trustLevel: TRUST[Number(u.trust_level || 0)] || 'new',
                    approvedContributions: 10,
                    dailyTopics: 0,
                    dailyReplies: 0,
                    revision: 1,
                })
            // Imported members receive no bulk mail until they choose a mode.
            if (
                !one(F + 'ForumDeliveryPreference', {
                    siteId,
                    partyId,
                    scopeType: 'site',
                    scopeId: '_SITE_',
                })
            )
                create(F + 'ForumDeliveryPreference', {
                    siteId,
                    partyId,
                    scopeType: 'site',
                    scopeId: '_SITE_',
                    emailMode: 'None',
                    revision: 1,
                })
            if (
                u.suspended_till &&
                millis(when(u.suspended_till)) > millis(now())
            )
                create(F + 'ForumSanction', {
                    sanctionId: id(),
                    revision: 1,
                    siteId,
                    partyId,
                    kind: 'suspend',
                    fromDate: now(),
                    thruDate: when(u.suspended_till),
                    reason: 'Suspension carried over from the previous community',
                })
            return partyId
        },
        /* Categories by depth: a child waits for its parent; restricted categories admit only mapped groups. */
        c0(ctx, c) {
            return importCategory(ctx, c, 0)
        },
        c1(ctx, c) {
            return importCategory(ctx, c, 1)
        },
        c2(ctx, c) {
            return importCategory(ctx, c, 2)
        },
        t(ctx, t) {
            const siteId = ctx.siteId
            const first = one(
                M,
                { siteId, sourceType: 'posts', sourceId: t.id + ':1' },
                true,
            )
            if (!first)
                throw new Error(
                    'The first post of topic ' + t.id + ' is missing',
                )
            const post = JSON.parse(first.payload)
            const author = authorOf(siteId, t.user_id)
            if (!author)
                throw new Error(
                    'The author of topic ' + t.id + ' was not imported',
                )
            const isPrivate = t.archetype === 'private_message'
            const contactListId = isPrivate
                ? null
                : imported(siteId, 'categories', t.category_id)
            if (!isPrivate && !contactListId)
                throw new Error(
                    'The category of topic ' + t.id + ' was not imported',
                )
            const body = render(siteId, post.raw)
            const root = createPost(
                ctx,
                {
                    contactListId,
                    author,
                    subject: t.title,
                    body,
                    raw: post.raw,
                    entryDate: when(post.created_at || t.created_at),
                    ordinal: 1,
                    visibility: t.deleted_at ? 'deleted' : visibilityOf(post),
                    closed: t.closed === 't',
                    wiki: post.wiki === 't',
                },
                (rootCommEventId) =>
                    create(F + 'ForumTopic', {
                        rootCommEventId,
                        siteId,
                        kind: isPrivate ? 'private' : 'category',
                        contactListId,
                        revision: 1,
                        nextOrdinal: Number(t.highest_post_number || 1) + 1,
                        pinned: t.pinned_at ? 'Y' : 'N',
                        unlisted: t.visible === 'f' ? 'Y' : 'N',
                        visiblePostCount: 0,
                        reactionCount: 0,
                        lastActivity: when(t.bumped_at || t.created_at),
                    }),
            )
            update(first, { state: 'imported', targetId: root })
            if (isPrivate) {
                const added = new Set()
                const add = (partyId) => {
                    if (!partyId || added.has(partyId)) return
                    added.add(partyId)
                    create(F + 'ForumParticipant', {
                        rootCommEventId: root,
                        partyId,
                        role: partyId === author ? 'owner' : 'member',
                        addedByPartyId: author,
                        addedAt: when(t.created_at),
                    })
                }
                add(author)
                for (const v of liveMaps(
                    siteId,
                    'topic_allowed_users',
                    t.id + ':',
                ))
                    add(
                        imported(
                            siteId,
                            'users',
                            JSON.parse(v.payload).user_id,
                        ),
                    )
                // A group's members join only from a reviewed snapshot of its membership; otherwise nobody is added.
                for (const v of liveMaps(
                    siteId,
                    'topic_allowed_groups',
                    t.id + ':',
                )) {
                    const groupId = JSON.parse(v.payload).group_id
                    if (
                        decisionOf(ctx, 'group', groupId)?.decision !==
                        'snapshot'
                    )
                        continue
                    for (const g of liveMaps(
                        siteId,
                        'group_users',
                        groupId + ':',
                    ))
                        add(
                            imported(
                                siteId,
                                'users',
                                JSON.parse(g.payload).user_id,
                            ),
                        )
                }
            }
            if (t.slug) legacy(ctx, '/t/' + t.slug + '/' + t.id, 'topic', root)
            legacy(ctx, '/t/' + t.id, 'topic', root)
            return root
        },
        p(ctx, post) {
            const siteId = ctx.siteId
            if (post.post_type === '3') return null
            const root = imported(siteId, 'topics', post.topic_id)
            if (!root)
                throw new Error(
                    'Topic ' +
                        post.topic_id +
                        ' of post ' +
                        post.id +
                        ' was not imported',
                )
            const author = authorOf(siteId, post.user_id)
            if (!author)
                throw new Error(
                    'The author of post ' + post.id + ' was not imported',
                )
            const t = one(F + 'ForumTopic', { rootCommEventId: root })
            const parentKey = post.reply_to_post_number
                ? post.topic_id + ':' + post.reply_to_post_number
                : null
            return createPost(ctx, {
                contactListId: t.contactListId || null,
                author,
                root,
                parent:
                    (parentKey && imported(siteId, 'posts', parentKey)) || root,
                subject: one(E + 'CommunicationEvent', {
                    communicationEventId: root,
                })?.subject,
                body: render(siteId, post.raw),
                raw: post.raw,
                entryDate: when(post.created_at),
                ordinal: Number(post.post_number),
                visibility: visibilityOf(post),
                wiki: post.wiki === 't',
            })
        },
        /* A reply whose parent came later in the source order gets its parent now. */
        q(ctx, post, map) {
            if (!post.reply_to_post_number || !map.targetId) return undefined
            const parent = imported(
                ctx.siteId,
                'posts',
                post.topic_id + ':' + post.reply_to_post_number,
            )
            const event = one(
                E + 'CommunicationEvent',
                { communicationEventId: map.targetId },
                true,
            )
            if (
                parent &&
                event &&
                event.parentCommEventId !== parent &&
                parent !== map.targetId
            )
                update(event, { parentCommEventId: parent })
            return undefined
        },
        /* An upload copied into private storage only when its archive file matches its SHA-1. */
        f(ctx, upload) {
            const location = uploadLocation(uploadsRoot(ctx.imp), upload)
            if (!location)
                throw new Error(
                    'Upload ' + upload.id + ' is not in the archive',
                )
            if (
                !/^[0-9a-f]{40}$/.test(upload.sha1 || '') ||
                ec.resource.digest(location, 'sha1') !== upload.sha1
            )
                throw new Error(
                    'Upload ' + upload.id + ' does not match its SHA-1',
                )
            const fileId = id()
            const stored =
                String(System.getProperty('pass_media_root')).replace(
                    /\/$/,
                    '',
                ) +
                '/' +
                fileId
            const stream = ec.resource
                .getLocationReference(location)
                .openStream()
            try {
                ec.resource.getLocationReference(stored).putStream(stream)
            } finally {
                stream.close()
            }
            return fileId
        },
        /* An attachment of a post, scanned like any upload. */
        g(ctx, ref) {
            const siteId = ctx.siteId
            const postId = postTarget(siteId, ref.target_id || ref.post_id)
            const fileId = imported(siteId, 'uploads', ref.upload_id)
            if (!postId || !fileId)
                throw new Error(
                    'Upload ' + ref.upload_id + ' or its post was not imported',
                )
            const upload = payloadOf(siteId, 'uploads', ref.upload_id)
            const location =
                String(System.getProperty('pass_media_root')).replace(
                    /\/$/,
                    '',
                ) +
                '/' +
                fileId
            const mimeType =
                ec.resource.contentTypeOf(upload?.original_filename || '') ||
                'application/octet-stream'
            const attachmentId = id()
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: postId,
            })
            create(F + 'ForumAttachment', {
                attachmentId,
                siteId,
                purpose: 'post',
                ownerPartyId: event?.fromPartyId,
                communicationEventId: postId,
                location,
                filename: upload?.original_filename || fileId,
                mimeType,
                byteSize: Number(upload?.filesize || 0),
                scanState: 'pending',
            })
            let clean = false
            const scanner = System.getProperty('pass_scanner_service')
            if (scanner)
                try {
                    clean =
                        ec.service
                            .sync()
                            .name(scanner)
                            .parameters({ location, mimeType })
                            .call()?.clean === true
                } catch (error) {
                    ec.message.clearErrors()
                }
            update(one(F + 'ForumAttachment', { attachmentId }), {
                scanState: clean ? 'clean' : 'quarantined',
            })
            return attachmentId
        },
        /* A like becomes the like reaction; a self-like is dropped. */
        r(ctx, action) {
            const siteId = ctx.siteId
            const postId = postTarget(siteId, action.post_id)
            const partyId = imported(siteId, 'users', action.user_id)
            if (!postId || !partyId)
                throw new Error(
                    'Like ' + action.id + ' has no imported post or member',
                )
            const event = one(E + 'CommunicationEvent', {
                communicationEventId: postId,
            })
            if (event.fromPartyId === partyId) return null
            if (
                one(F + 'ForumReaction', {
                    communicationEventId: postId,
                    partyId,
                    reactionKey: 'like',
                })
            )
                return 'like'
            const st = one(
                F + 'ForumPostState',
                { communicationEventId: postId },
                true,
            )
            create(F + 'ForumReaction', {
                communicationEventId: postId,
                partyId,
                reactionKey: 'like',
                rootCommEventId: st.rootCommEventId,
                createdAt: when(action.created_at),
            })
            const counts = JSON.parse(st.reactionCounts || '{}')
            counts.like = (counts.like || 0) + 1
            update(st, {
                reactionCount: Number(st.reactionCount || 0) + 1,
                reactionCounts: JSON.stringify(counts),
            })
            return 'like'
        },
        x(ctx, tt) {
            const siteId = ctx.siteId
            const root = imported(siteId, 'topics', tt.topic_id)
            const tag = payloadOf(siteId, 'tags', tt.tag_id)
            if (!root || !tag)
                throw new Error(
                    'Tag ' + tt.tag_id + ' or its topic was not imported',
                )
            const normalizedName = String(tag.name).trim().toLowerCase()
            let row = one(F + 'ForumTag', { siteId, normalizedName })
            if (!row)
                row = create(F + 'ForumTag', {
                    tagId: id(),
                    siteId,
                    name: tag.name,
                    normalizedName,
                    description: tag.description || null,
                    revision: 1,
                    createdAt: now(),
                })
            if (
                !one(F + 'ForumTopicTag', {
                    rootCommEventId: root,
                    tagId: row.tagId,
                })
            )
                create(F + 'ForumTopicTag', {
                    rootCommEventId: root,
                    tagId: row.tagId,
                    siteId,
                })
            return row.tagId
        },
        a(ctx, solved) {
            return acceptAnswer(ctx, solved.topic_id, solved.answer_post_id)
        },
        b(ctx, field) {
            return acceptAnswer(ctx, field.topic_id, field.value)
        },
        l(ctx, poll) {
            const siteId = ctx.siteId
            const postId = postTarget(siteId, poll.post_id)
            if (!postId)
                throw new Error(
                    'The post of poll ' + poll.id + ' was not imported',
                )
            const st = one(F + 'ForumPostState', {
                communicationEventId: postId,
            })
            const options = mapsOf(siteId, 'poll_options', poll.id + ':')
            const pollId = id()
            create(F + 'ForumPoll', {
                pollId,
                siteId,
                communicationEventId: postId,
                rootCommEventId: st.rootCommEventId,
                question: poll.title || poll.name || 'Poll',
                // Discourse poll enums: type 1 multiple; results 0 always, 1 on vote, 2 on close, 3 staff only;
                // visibility 1 everyone. Staff-only results show only when the poll closes.
                maxChoices:
                    String(poll.type) === '1'
                        ? Number(poll.max || options.length || 1)
                        : 1,
                closesAt: poll.close_at ? when(poll.close_at) : null,
                resultsPolicy:
                    String(poll.results) === '0'
                        ? 'always'
                        : String(poll.results) === '1'
                          ? 'voted'
                          : 'closed',
                revealVoters: String(poll.visibility) === '1' ? 'Y' : 'N',
                allowChange: 'N',
                voterCount: 0,
                revision: 1,
            })
            const voters = new Set()
            options.forEach((o, i) => {
                const option = JSON.parse(o.payload)
                const votes = mapsOf(
                    siteId,
                    'poll_votes',
                    poll.id + ':' + option.id + ':',
                )
                let count = 0
                for (const v of votes) {
                    const partyId = imported(
                        siteId,
                        'users',
                        JSON.parse(v.payload).user_id,
                    )
                    if (!partyId) continue
                    create(F + 'ForumPollVote', {
                        pollId,
                        partyId,
                        optionId: option.id,
                        votedAt: now(),
                    })
                    voters.add(partyId)
                    count++
                }
                create(F + 'ForumPollOption', {
                    pollId,
                    optionId: option.id,
                    sequenceNum: i + 1,
                    label: plainText(option.html || '').slice(0, 255),
                    voteCount: count,
                })
            })
            update(one(F + 'ForumPoll', { pollId }), {
                voterCount: voters.size,
            })
            return pollId
        },
        /* Reading positions and watch levels; never email modes. */
        m(ctx, tu) {
            const siteId = ctx.siteId
            const root = imported(siteId, 'topics', tu.topic_id)
            const partyId = imported(siteId, 'users', tu.user_id)
            if (!root || !partyId)
                throw new Error(
                    'Reading position ' +
                        tu.topic_id +
                        ':' +
                        tu.user_id +
                        ' has no imported topic or member',
                )
            const read = Number(tu.last_read_post_number || 0)
            if (
                read &&
                !one(F + 'ForumTopicUser', { rootCommEventId: root, partyId })
            )
                create(F + 'ForumTopicUser', {
                    rootCommEventId: root,
                    partyId,
                    consumedOrdinal: read,
                    highestSeenOrdinal: read,
                    markerRevision: 1,
                })
            const level = WATCH[Number(tu.notification_level ?? 1)]
            if (
                level &&
                level !== 'Normal' &&
                !one(F + 'ForumPreference', {
                    siteId,
                    partyId,
                    scopeType: 'topic',
                    scopeId: root,
                })
            )
                create(F + 'ForumPreference', {
                    siteId,
                    partyId,
                    scopeType: 'topic',
                    scopeId: root,
                    watchLevel: level,
                    revision: 1,
                })
            return root
        },
        k(ctx, b) {
            const siteId = ctx.siteId
            const partyId = imported(siteId, 'users', b.user_id)
            const postId =
                b.bookmarkable_type === 'Topic'
                    ? imported(siteId, 'topics', b.bookmarkable_id)
                    : postTarget(siteId, b.bookmarkable_id || b.post_id)
            if (!partyId || !postId)
                throw new Error(
                    'Bookmark ' + b.id + ' has no imported member or post',
                )
            const st = one(F + 'ForumPostState', {
                communicationEventId: postId,
            })
            const bookmarkId = id()
            create(F + 'ForumBookmark', {
                bookmarkId,
                siteId,
                partyId,
                rootCommEventId: st.rootCommEventId,
                communicationEventId: postId,
                note: b.name || null,
                remindAt: b.reminder_at ? when(b.reminder_at) : null,
                createdAt: when(b.created_at),
                revision: 1,
            })
            return bookmarkId
        },
        h(ctx, link) {
            const siteId = ctx.siteId
            const path =
                '/' +
                String(link.url || '')
                    .replace(/^\/+/, '')
                    .replace(/\/+$/, '')
            if (link.post_id) {
                const postId = postTarget(siteId, link.post_id)
                if (postId) return (legacy(ctx, path, 'post', postId), postId)
            }
            if (link.topic_id) {
                const root = imported(siteId, 'topics', link.topic_id)
                if (root) return (legacy(ctx, path, 'topic', root), root)
            }
            if (link.category_id) {
                const c = imported(siteId, 'categories', link.category_id)
                if (c) return (legacy(ctx, path, 'category', c), c)
            }
            return null
        },
        n(ctx, t, map) {
            const row = one(
                F + 'ForumTopic',
                { rootCommEventId: map.targetId },
                true,
            )
            if (row) moderation.recount(row)
            return undefined
        },
    }
    function importCategory(ctx, c, depth) {
        const siteId = ctx.siteId
        let parent = null
        if (c.parent_category_id) {
            parent = imported(siteId, 'categories', c.parent_category_id)
            if (!parent) {
                if (depth < 2) return undefined
                throw new Error(
                    'The parent of category ' + c.id + ' was not imported',
                )
            }
        } else if (depth > 0) return undefined
        if (parent && depth === 0) return undefined
        const out = ec.service
            .sync()
            .throwOnError(true)
            .name('mantle.marketing.ContactListServices.create#ContactList')
            .parameters({
                contactListTypeEnumId: 'MAILBOX',
                contactListName: c.name,
                isPublic: 'N',
                postingEnumId: 'ClpMembers',
            })
            .call()
        const contactListId = out.contactListId
        const restricted = c.read_restricted === 't'
        create(F + 'ForumCategory', {
            contactListId,
            siteId,
            parentContactListId: parent,
            sequenceNum: Number(c.position || 0),
            slug: c.slug || contactListId,
            publicationState: 'published',
            // A restricted category admits only mapped groups; with no mapping nobody but staff reads it.
            visibility: restricted ? 'category' : 'public',
            mode: 'discussion',
            rules: c.description
                ? StringUtilities.cleanHtml(c.description)
                : '',
            policyRevision: 1,
        })
        // Open categories let any member post, as their open posting did.
        if (!restricted)
            update(
                one('mantle.marketing.contact.ContactList', { contactListId }),
                { postingEnumId: 'ClpAnyUser' },
            )
        if (restricted)
            for (const cg of liveMaps(siteId, 'category_groups', c.id + ':')) {
                const groupId = JSON.parse(cg.payload).group_id
                if (
                    !['grant', 'snapshot'].includes(
                        decisionOf(ctx, 'group', groupId)?.decision,
                    )
                )
                    continue
                for (const g of liveMaps(
                    siteId,
                    'group_users',
                    groupId + ':',
                )) {
                    const partyId = imported(
                        siteId,
                        'users',
                        JSON.parse(g.payload).user_id,
                    )
                    if (!partyId) continue
                    const key = {
                        partyId,
                        siteId,
                        targetType: 'category',
                        targetId: contactListId,
                        sourceType: 'manual',
                        sourceId: 'import',
                    }
                    if (!one(S + 'PublicAccessGrant', key))
                        create(S + 'PublicAccessGrant', {
                            grantId: id(),
                            ...key,
                            fromDate: now(),
                            reason: 'Imported group ' + groupId,
                            createdAt: now(),
                            revision: 1,
                        })
                }
            }
        if (c.slug) {
            legacy(ctx, '/c/' + c.slug + '/' + c.id, 'category', contactListId)
            legacy(ctx, '/c/' + c.slug, 'category', contactListId)
        }
        return contactListId
    }
    function acceptAnswer(ctx, topicId, answerPostId) {
        const siteId = ctx.siteId
        const root = imported(siteId, 'topics', topicId)
        const postId = postTarget(siteId, answerPostId)
        if (!root || !postId)
            throw new Error(
                'Accepted answer of topic ' + topicId + ' has no imported post',
            )
        const st = one(F + 'ForumPostState', { communicationEventId: postId })
        if (postId === root || st?.visibility !== 'approved') return null
        update(one(F + 'ForumTopic', { rootCommEventId: root }, true), {
            acceptedAnswerId: postId,
        })
        return postId
    }
    operations.registerJob('op-import-stage', {
        next(run, config) {
            // A retry (which clears the failure count) resumes at the piece that failed.
            if (
                config.done &&
                config.failedOffset != null &&
                Number(run.failedCount || 0) === 0
            ) {
                config.done = false
                config.offset = config.failedOffset
                config.failedOffset = null
            }
            const imp = one(F + 'ForumImportRun', { importId: config.importId })
            if (
                !imp ||
                !['staging', 'registered', 'staged'].includes(imp.stage)
            )
                return null
            return config.done ? null : 'o' + (config.offset || 0)
        },
        item: stageItem,
        // A piece that cannot be staged stops the run as failed; a retry starts again from it.
        onFailure: (config) => ({
            done: true,
            failedOffset: config.offset || 0,
        }),
        finish(run, config, failed) {
            const imp = one(
                F + 'ForumImportRun',
                { importId: config.importId },
                true,
            )
            if (
                !imp ||
                !['staging', 'registered', 'staged'].includes(imp.stage)
            )
                return
            if (!failed) markRemoved(imp.siteId, imp.importId)
            const report = preflight(imp, config)
            update(imp, {
                stage: failed ? 'registered' : 'staged',
                preflightJson: JSON.stringify(report),
                revision: Number(imp.revision) + 1,
            })
        },
    })
    operations.registerJob('op-import', {
        next: importNext,
        item: importItem,
        // A failed row is marked and named in the run's own transaction (the item's rolled back), skipped for this pass;
        // its dependants wait on it, and a retry starts the phases again.
        onFailure(config, itemId, error, run) {
            const at = itemId.indexOf('|'),
                phase = PHASES.find((ph) => ph[0] === itemId.slice(0, at))
            const map = phase
                ? one(
                      M,
                      {
                          siteId: run.siteId,
                          sourceType: phase[1],
                          sourceId: itemId.slice(at + 1),
                      },
                      true,
                  )
                : null
            if (map) update(map, { state: 'failed', errorText: error })
            return { after: itemId.slice(at + 1) }
        },
        finish(run, config, failed) {
            const imp = one(
                F + 'ForumImportRun',
                { importId: config.importId },
                true,
            )
            if (imp && ['importing', 'imported'].includes(imp.stage))
                update(imp, {
                    stage: 'imported',
                    revision: Number(imp.revision) + 1,
                })
        },
    })

    /* ---- Reconciliation, approval and cutover ---- */
    function normalized(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim()
    }
    methods.reconcileImport = (p) => {
        ownerOrOperator(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (!['imported', 'reconciled'].includes(imp.stage))
            fail('Conflict', 'Import before reconciling')
        const siteId = p.siteId
        const byState = (sourceType) => {
            const out = {
                staged: 0,
                imported: 0,
                failed: 0,
                skipped: 0,
                changed: 0,
            }
            for (const state of Object.keys(out))
                out[state] = find(M, { siteId, sourceType, state }).count()
            return out
        }
        const types = {}
        for (const t of Object.keys(KEYS))
            if (t !== 'post_uploads') types[t] = byState(t)
        let sourcePrivate = 0,
            sourceRegular = 0,
            importedPrivate = 0,
            importedRegular = 0
        for (const v of mapsOf(siteId, 'topics', null, 100000)) {
            const t = JSON.parse(v.payload)
            t.archetype === 'private_message'
                ? sourcePrivate++
                : sourceRegular++
            if (v.state === 'imported') {
                const row = one(F + 'ForumTopic', {
                    rootCommEventId: v.targetId,
                })
                row?.kind === 'private'
                    ? importedPrivate++
                    : row && importedRegular++
            }
        }
        let sourceDeleted = 0,
            importedDeleted = 0,
            fingerprintMismatches = 0,
            sampled = 0
        for (const v of mapsOf(siteId, 'posts', null, 200000)) {
            const post = JSON.parse(v.payload)
            if (post.deleted_at) sourceDeleted++
            if (v.state !== 'imported') continue
            const st = one(F + 'ForumPostState', {
                communicationEventId: v.targetId,
            })
            if (st?.visibility === 'deleted') importedDeleted++
            if (sampled < 50) {
                sampled++
                const rev = one(F + 'ForumPostRevision', {
                    communicationEventId: v.targetId,
                    revision: 1,
                })
                if (normalized(rev?.sourceText) !== normalized(post.raw))
                    fingerprintMismatches++
            }
        }
        let sourceAnswers =
            types.discourse_solved_solved_topics.staged +
            types.discourse_solved_solved_topics.imported +
            types.discourse_solved_solved_topics.failed
        if (!sourceAnswers)
            sourceAnswers =
                types.topic_custom_fields.staged +
                types.topic_custom_fields.imported +
                types.topic_custom_fields.failed
        const importedAnswers = mapsOf(siteId, 'topics', null, 100000).filter(
            (v) =>
                v.state === 'imported' &&
                one(F + 'ForumTopic', { rootCommEventId: v.targetId })
                    ?.acceptedAnswerId,
        ).length
        const participants = mapsOf(siteId, 'topics', null, 100000)
            .filter((v) => v.state === 'imported')
            .reduce(
                (n, v) =>
                    n +
                    find(F + 'ForumParticipant', {
                        rootCommEventId: v.targetId,
                    }).count(),
                0,
            )
        const stageRun = imp.stageRunId
            ? one(F + 'ForumJobRun', { runId: imp.stageRunId })
            : null
        const pre = preflight(
            imp,
            stageRun ? JSON.parse(stageRun.checkpoint || '{}') : null,
        )
        const blockers = [...pre.blockers]
        for (const t of [
            'users',
            'categories',
            'topics',
            'posts',
            'topic_allowed_users',
        ])
            for (const v of mapsOf(siteId, t).filter(
                (v) => v.state === 'failed',
            ))
                blockers.push({
                    type: 'failed',
                    sourceId: t + ':' + v.sourceId,
                    detail: v.errorText,
                })
        for (const t of Object.keys(types))
            for (const v of types[t].changed
                ? mapsOf(siteId, t).filter((v) => v.state === 'changed')
                : [])
                blockers.push({
                    type: 'changed',
                    sourceId: t + ':' + v.sourceId,
                    detail: 'Changed in the source after import: keep or apply',
                })
        for (const t of REMOVABLE)
            for (const v of mapsOf(siteId, t).filter(
                (v) => v.state === 'removed',
            ))
                blockers.push({
                    type: 'removed',
                    sourceId: t + ':' + v.sourceId,
                    detail: 'No longer in the source: keep or apply (apply revokes the access or removes the record)',
                })
        if (sourcePrivate !== importedPrivate)
            blockers.push({
                type: 'private',
                sourceId: 'topics',
                detail:
                    'Private message counts differ: ' +
                    sourcePrivate +
                    ' in the source, ' +
                    importedPrivate +
                    ' imported',
            })
        const report = {
            revision: Number(imp.reconciliationRevision || 0) + 1,
            createdAt: millis(now()),
            types,
            topics: {
                sourceRegular,
                sourcePrivate,
                importedRegular,
                importedPrivate,
            },
            posts: {
                sourceDeleted,
                importedDeleted,
                sampled,
                fingerprintMismatches,
            },
            acceptedAnswers: {
                source: sourceAnswers,
                imported: importedAnswers,
            },
            participants,
            uploads: {
                missing: pre.missingUploads,
                failed: types.uploads.failed,
                imported: types.uploads.imported,
            },
            legacyUrls: find(F + 'ForumLegacyUrl', {
                siteId,
                importId: imp.importId,
            }).count(),
            features: pre.features,
            warnings: pre.warnings,
            blockers,
        }
        // The readable report, an expiring staff download.
        const exportId = id()
        const location =
            operations.storageRoot() + '/exports/' + exportId + '.csv'
        const lines = [['section', 'item', 'value']]
        for (const [t, counts] of Object.entries(types))
            for (const [state, n] of Object.entries(counts))
                lines.push(['rows', t + '.' + state, n])
        for (const b of blockers)
            lines.push(['blocker', b.type + ':' + b.sourceId, b.detail])
        ec.resource.getLocationReference(location).putText(
            lines
                .map((l) =>
                    l
                        .map(
                            (c) =>
                                '"' +
                                String(c ?? '')
                                    .replace(/"/g, '""')
                                    .replace(/^([=+\-@])/, "'$1") +
                                '"',
                        )
                        .join(','),
                )
                .join('\r\n') + '\r\n',
        )
        create(F + 'ForumExport', {
            exportId,
            siteId,
            partyId: me(),
            kind: 'report-import',
            location,
            filename: 'import-reconciliation-' + imp.importId + '.csv',
            mimeType: 'text/csv',
            checksum: ec.resource.digest(location, 'sha256'),
            byteSize: lines.length,
            schemaVersion: 1,
            state: 'complete',
            createdAt: now(),
            expiresAt: stamp(millis(now()) + 7 * 86400000),
        })
        update(imp, {
            stage: 'reconciled',
            reconciliationJson: JSON.stringify(report),
            reconciliationRevision: report.revision,
            reportExportId: exportId,
            operatorRevision: null,
            ownerRevision: null,
            revision: Number(imp.revision) + 1,
        })
        audit(
            siteId,
            null,
            'import',
            imp.importId,
            'reconcile-import',
            'Reconciliation ' + report.revision,
            null,
            report.revision,
        )
        return {
            reconciliationRevision: report.revision,
            blockers: blockers.length,
            exportId,
        }
    }
    methods.approveImport = (p) => {
        site(p.siteId, true)
        const imp = importRow(p.siteId, p.importId, true)
        if (imp.stage !== 'reconciled')
            fail('Conflict', 'Reconcile before approving')
        revision(
            { revision: Number(imp.reconciliationRevision || 0) },
            p.expectedRevision,
        )
        // The operator and the site owner are two people.
        const other =
            p.role === 'operator' ? imp.ownerPartyId : imp.operatorPartyId
        if (
            other &&
            other === me() &&
            Number(
                p.role === 'operator'
                    ? imp.ownerRevision
                    : imp.operatorRevision,
            ) === Number(imp.reconciliationRevision)
        )
            fail(
                'Conflict',
                'The operator and the site owner approvals come from two people',
            )
        if (p.role === 'operator') {
            if (!isOperator())
                fail('Unauthorized', 'An operator approves for operations')
            update(imp, {
                operatorPartyId: me(),
                operatorRevision: imp.reconciliationRevision,
            })
        } else if (p.role === 'owner') {
            const m = member(p.siteId)
            if (!(active(m) && m.state === 'active' && m.role === 'owner'))
                fail('Unauthorized', 'A site owner approves for the community')
            update(imp, {
                ownerPartyId: me(),
                ownerRevision: imp.reconciliationRevision,
            })
        } else invalid('Approve as operator or owner')
        audit(
            p.siteId,
            null,
            'import',
            imp.importId,
            'approve-import-' + p.role,
            p.reason || 'Approved',
            null,
            imp.reconciliationRevision,
        )
        return {
            stage: imp.stage,
            reconciliationRevision: Number(imp.reconciliationRevision),
        }
    }
    /* Cutover: both approvals of this reconciliation, no blockers, the source frozen and the target backed up. Mail stays
       off for imported members until they choose a mode. */
    methods.activateImport = (p) => {
        operatorOnly(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (imp.stage !== 'reconciled')
            fail('Conflict', 'Reconcile before activating')
        const report = JSON.parse(imp.reconciliationJson || '{}')
        const rev = Number(imp.reconciliationRevision || 0)
        if (
            Number(imp.operatorRevision) !== rev ||
            Number(imp.ownerRevision) !== rev
        )
            fail(
                'Conflict',
                'Both the operator and a site owner must approve this reconciliation',
            )
        if (report.blockers?.length)
            fail('Conflict', 'Resolve the blockers before activation')
        if (p.sourceFrozen !== true || !p.backupReference || p.confirm !== true)
            invalid('Confirm the source is frozen and name the target backup')
        update(imp, {
            stage: 'active',
            backupReference: p.backupReference,
            revision: Number(imp.revision) + 1,
        })
        const s = one(S + 'PublicSite', { siteId: p.siteId }, true)
        update(s, {
            state: 'published',
            generation: Number(s.generation || 0) + 1,
        })
        audit(
            p.siteId,
            null,
            'import',
            imp.importId,
            'activate-import',
            'Backup ' + p.backupReference,
            null,
            rev,
        )
        return { stage: 'active' }
    }
    methods.cancelImport = (p) => {
        operatorOnly(p.siteId)
        const imp = importRow(p.siteId, p.importId, true)
        if (imp.stage === 'active')
            fail(
                'Conflict',
                'An activated import is not cancelled; freeze writes and reconcile instead',
            )
        for (const runId of [imp.stageRunId, imp.importRunId].filter(Boolean)) {
            const run = one(F + 'ForumJobRun', { runId }, true)
            if (run?.state === 'pending') update(run, { state: 'cancelled' })
        }
        update(imp, { stage: 'cancelled', revision: Number(imp.revision) + 1 })
        audit(
            p.siteId,
            null,
            'import',
            imp.importId,
            'cancel-import',
            p.reason || 'Cancelled',
            null,
            null,
        )
        return { stage: 'cancelled' }
    }
    /* An old URL of the imported community, resolved to what it names now, after the reader's current access. */
    methods.resolvePermalink = (p) => {
        site(p.siteId)
        const path =
            '/' +
            String(p.path || '')
                .split(/[?#]/)[0]
                .replace(/^\/+/, '')
                .replace(/\/+$/, '')
        let found = one(F + 'ForumLegacyUrl', {
            siteId: p.siteId,
            sourcePath: path,
        })
        let ordinal = null
        const post = /^(\/t\/(?:[^/]+\/)?\d+)\/(\d+)$/.exec(path)
        if (!found && post) {
            found = one(F + 'ForumLegacyUrl', {
                siteId: p.siteId,
                sourcePath: post[1],
            })
            ordinal = Number(post[2])
        }
        if (!found) missing()
        if (found.targetType === 'category') {
            category(found.targetId, p.siteId)
            return { kind: 'category', contactListId: found.targetId }
        }
        const st =
            found.targetType === 'post'
                ? one(F + 'ForumPostState', {
                      communicationEventId: found.targetId,
                  })
                : null
        const root = st ? st.rootCommEventId : found.targetId
        const { t } = topic(root, p.siteId)
        let postId =
            st?.visibility === 'approved' ? st.communicationEventId : null
        if (ordinal && ordinal > 1) {
            const target = one(F + 'ForumPostState', {
                rootCommEventId: t.rootCommEventId,
                ordinal,
            })
            if (target && target.visibility === 'approved')
                postId = target.communicationEventId
        }
        return {
            kind: postId ? 'post' : 'topic',
            rootCommEventId: t.rootCommEventId,
            postId,
        }
    }
    return {}
}
