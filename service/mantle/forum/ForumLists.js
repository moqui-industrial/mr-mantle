/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * Mailing lists (plans/Dogfood.md §6.3, D17; mr-pass plan/design-smithy.md §12.4). A list is a category in list mode with
 * its own address (a ForumMailRoute of the category). Forum.js calls this with the shared core, its methods map and the
 * operations module (the run dispatcher).
 * - listHeaders: a list category's own List-Id, List-Post and List-Archive, by its address.
 * - importMbox: a list's archive (an mbox file the operator put in the import directory) becomes topics and posts with
 *   their dates, threaded by Message-ID, In-Reply-To and References; a checkpointed run, resumable and safe to run
 *   twice (ForumImportMap rows keyed by the category and the Message-ID). An author is a profile with no account, by
 *   the hash of the address (the address is never stored); the person's posts become theirs when an account verifies
 *   that address (claimVerified). Nothing sends mail.
 * - inviteListMembers: each address is invited by mail; redeeming the invitation (redeemInvitation, by the account
 *   with that address verified) subscribes it to every post of the list. Nobody is subscribed without it.
 * - Held mail: a message from an address that is no account's is never posted. It is kept (ForumHeldMail) with a review
 *   item of the family mail-held for the scope's moderators, the sender is answered once a day with a link, and the
 *   message is posted as the account that confirms the address (claimHeldMail, or at once when the address is verified),
 *   or dropped after 30 days.
 * Entity access is privileged here; every operation checks who asks first.
 */
;(core, methods, operations) => {
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
        fail,
        missing,
        invalid,
        requireUser,
        isOperator,
        site,
        category,
        categoryAccess,
        audit,
        systemAudit,
        receipt,
        plainText,
        json
    } = core
    const MAP = F + "ForumImportMap"
    const HELD = F + "ForumHeldMail"
    const LIST = "mantle.marketing.contact."
    const publicApps = () => ec.resource.script("component://mr-mantle/service/mantle/public/PublicApps.js")
    const confirmed = () => ec.resource.script("component://mr-mantle/service/mantle/public/ConfirmedAddress.js")
    const digest = text => String(ec.resource.digestText(String(text), "sha256"))
    const firstLine = error =>
        String(error?.message || error || "")
            .split("\n")[0]
            .slice(0, 200)
    const lower = value =>
        String(value || "")
            .trim()
            .toLowerCase()

    // ===== a list's address and its mail headers =====
    /* The address of a list: the oldest enabled route of a category in list mode that is a category's own. */
    function listRoute(siteId, contactListId) {
        const c = contactListId ? one(F + "ForumCategory", {contactListId}) : null
        if (!c || c.siteId !== siteId || c.mode !== "list") return null
        return (
            Array.from(
                find(F + "ForumMailRoute", {siteId, contactListId, enabled: "Y"})
                    .orderBy("createdAt,routeId")
                    .limit(20)
                    .list()
            ).find(route => !route.targetType || route.targetType === "category") || null
        )
    }
    /* The headers of a list category's mail (RFC 2919, RFC 2369), by its address; null for a category that is no list.
       forumUrl is the forum's base address, where the archive is the category's page. */
    function listHeaders(siteId, contactListId, forumUrl) {
        const route = listRoute(siteId, contactListId)
        if (!route) return null
        const name = String(one(LIST + "ContactList", {contactListId})?.contactListName || "").replace(
            /[^\x20-\x7e]|["<>\\]/g,
            ""
        )
        return {
            "List-Id": (name ? '"' + name + '" ' : "") + "<" + route.address.replace("@", ".") + ">",
            "List-Post": "<mailto:" + route.address + ">",
            "List-Archive": "<" + forumUrl + "/Categories/CategoryDetail?contactListId=" + encodeURIComponent(contactListId) + ">"
        }
    }
    /* Who runs a list: the site's owners and operators, the category's own staff, and an Owner of the group or
       repository it is bound to. The category as the caller holds it, or Unauthorized. */
    function listStaff(p) {
        const a = category(p.contactListId, p.siteId)
        if (!(isOperator() || a.isOwner || a.canInvite || core.scopeOwner(p.contactListId, me())))
            fail("Unauthorized", "The owners of this list do this")
        return a
    }

    // ===== reading a message (RFC 5322, MIME, RFC 2047, RFC 3676) =====
    const CP1252 = "€�‚ƒ„…†‡ˆ‰Š‹Œ�Ž��‘’“”•–—˜™š›œ�žŸ"
    const fromCodes = codes => {
        let out = ""
        for (let i = 0; i < codes.length; i += 4096) out += String.fromCodePoint(...codes.slice(i, i + 4096))
        return out
    }
    /* Bytes as text in a charset: UTF-8 and ASCII, Latin-1 and Windows-1252; any other is read as Latin-1 (known: false). */
    function decodeBytes(bytes, charset) {
        const name = lower(charset).replace(/[^a-z0-9]/g, "")
        const codes = []
        if (!name || name === "utf8" || name === "usascii" || name === "ascii") {
            for (let i = 0; i < bytes.length;) {
                const b = bytes[i++]
                const more = b < 0x80 ? 0 : b >= 0xc2 && b < 0xe0 ? 1 : b >= 0xe0 && b < 0xf0 ? 2 : b >= 0xf0 && b < 0xf5 ? 3 : -1
                if (more <= 0) {
                    codes.push(more === 0 ? b : 0xfffd)
                    continue
                }
                let code = b & (0xff >> (more + 2))
                let ok = i + more <= bytes.length
                for (let k = 0; ok && k < more; k++) {
                    const next = bytes[i + k]
                    if ((next & 0xc0) !== 0x80) ok = false
                    else code = (code << 6) | (next & 0x3f)
                }
                if (ok) i += more
                codes.push(ok && code <= 0x10ffff && !(code >= 0xd800 && code < 0xe000) ? code : 0xfffd)
            }
            return {text: fromCodes(codes), known: true}
        }
        const windows = name === "windows1252" || name === "cp1252"
        for (const b of bytes) codes.push(windows && b >= 0x80 && b < 0xa0 ? CP1252.codePointAt(b - 0x80) : b)
        return {text: fromCodes(codes), known: windows || ["iso88591", "latin1", "iso885915"].includes(name)}
    }
    /* Text that was read as it came (8 bits a character at most, or UTF-8 already) as bytes for a decoder. */
    const textBytes = text => {
        const out = []
        for (const ch of text) {
            const code = ch.codePointAt(0)
            if (code < 0x100) out.push(code)
            else out.push(0x3f)
        }
        return out
    }
    function quotedPrintable(text, header) {
        const out = []
        const source = header ? text.replace(/_/g, " ") : text.replace(/=\r?\n/g, "")
        for (let i = 0; i < source.length; i++) {
            const hex = source[i] === "=" ? /^[0-9A-Fa-f]{2}/.exec(source.slice(i + 1, i + 3)) : null
            if (hex) {
                out.push(parseInt(hex[0], 16))
                i += 2
            } else {
                const code = source.charCodeAt(i)
                if (code < 0x100) out.push(code)
                else for (const b of textBytes(source[i])) out.push(b)
            }
        }
        return out
    }
    const base64Bytes = text => {
        try {
            return Array.from(StringUtilities.base64Decode(String(text).replace(/[^A-Za-z0-9+/=]/g, "")))
        } catch (error) {
            return []
        }
    }
    /* A header's value with its encoded words read (=?charset?B|Q?text?=); white space between two of them is dropped. */
    function decodeWords(value) {
        return String(value || "")
            .replace(/(\?=)\s+(=\?)/g, "$1$2")
            .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (whole, charset, encoding, text) => {
                const bytes = /b/i.test(encoding) ? base64Bytes(text) : quotedPrintable(text, true)
                return decodeBytes(bytes, charset.split("*")[0]).text
            })
            .replace(/\s+/g, " ")
            .trim()
    }
    /* The header fields of some lines (to the first empty one), unfolded: {fields: name in lower case -> values, bodyAt}. */
    function headerFields(lines, from) {
        const fields = {}
        let last = null
        let at = from
        for (; at < lines.length; at++) {
            const line = lines[at]
            if (line === "") {
                at++
                break
            }
            if (/^[ \t]/.test(line) && last) {
                fields[last][fields[last].length - 1] += " " + line.trim()
                continue
            }
            const m = /^([!-9;-~]+)[ \t]*:[ \t]?(.*)$/.exec(line)
            if (!m) continue
            last = m[1].toLowerCase()
            ;(fields[last] = fields[last] || []).push(m[2])
        }
        return {fields, bodyAt: at}
    }
    /* A structured value: its first word in lower case and its parameters (boundary, charset, format, filename). */
    function typeOf(value) {
        const parts = String(value || "").split(";")
        const parameters = {}
        for (const part of parts.slice(1)) {
            const m = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s;]*))/.exec(part)
            if (m) parameters[m[1].toLowerCase().replace(/\*.*$/, "")] = m[2] != null ? m[2].replace(/\\(.)/g, "$1") : m[3]
        }
        return {type: lower(parts[0]), parameters}
    }
    const address = value =>
        lower(/<([^<>@\s]+@[^<>\s]+)>/.exec(value)?.[1] || /([^<>"\s,;()]+@[^<>"\s,;()]+)/.exec(value)?.[1] || "")
    /* The name a From field shows, never its address: the phrase before the address, or the comment after it. */
    function displayName(value) {
        const decoded = decodeWords(value)
        const phrase = /^\s*"?((?:[^"<\\]|\\.)*?)"?\s*<[^<>]*>/.exec(decoded)?.[1] || /\(([^()]*)\)\s*$/.exec(decoded)?.[1] || ""
        const name = phrase.replace(/\\(.)/g, "$1").replace(/\s+/g, " ").trim()
        return name.includes("@") ? "" : name.slice(0, 100)
    }
    const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
    const ZONES = {
        ut: 0,
        gmt: 0,
        utc: 0,
        z: 0,
        est: -300,
        edt: -240,
        cst: -360,
        cdt: -300,
        mst: -420,
        mdt: -360,
        pst: -480,
        pdt: -420
    }
    /* A date field (RFC 5322) as epoch milliseconds, or null. */
    function mailDate(value) {
        const m =
            /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(
                String(value || "")
            )
        const month = m ? MONTHS.indexOf(m[2].toLowerCase()) : -1
        if (month < 0) return null
        let year = Number(m[3])
        if (year < 100) year += year < 50 ? 2000 : 1900
        const zone = m[7] || "+0000"
        const offset = /^[+-]\d{4}$/.test(zone)
            ? (zone[0] === "-" ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)))
            : ZONES[zone.toLowerCase()] || 0
        const ms = Date.UTC(year, month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0)) - offset * 60000
        return Number.isFinite(ms) && ms > 0 && ms < 4102444800000 ? ms : null
    }
    /* format=flowed text (RFC 3676) with its soft line breaks joined, each quote depth kept as its '>' marks. */
    function unflow(text, delsp) {
        const out = []
        let open = null
        for (const raw of text.split("\n")) {
            const depth = /^>*/.exec(raw)[0].length
            let line = raw.slice(depth)
            if (line.startsWith(" ")) line = line.slice(1)
            const signature = line === "-- "
            const soft = !signature && line.endsWith(" ")
            if (soft && delsp) line = line.slice(0, -1)
            if (open && open.depth === depth && !signature) open.text += line
            else {
                open = {depth, text: line}
                out.push(open)
            }
            if (!soft) open = null
        }
        return out.map(line => (line.depth ? ">".repeat(line.depth) + " " : "") + line.text).join("\n")
    }
    const textHtml = text =>
        text
            .replace(/\r\n?/g, "\n")
            .replace(/[ \t]+\n/g, "\n")
            .trim()
            .split(/\n{2,}/)
            .map(paragraph => "<p>" + WebUtilities.encodeHtml(paragraph).replace(/\n/g, "<br>") + "</p>")
            .join("")
    const MAX_PARTS = 50
    /* The text of a message's body: the first text/plain part that is no attachment, else the first text/html one, cleaned.
       found collects {plain, html, attachments, unknownCharset}. */
    function readPart(fields, lines, found, depth) {
        const content = typeOf(fields["content-type"]?.[0] || "text/plain")
        if (content.type.startsWith("multipart/") && content.parameters.boundary && depth < 6) {
            const open = "--" + content.parameters.boundary
            let start = -1
            for (let i = 0; i <= lines.length; i++) {
                const line = i < lines.length ? lines[i].replace(/[ \t]+$/, "") : open + "--"
                if (line !== open && line !== open + "--") continue
                if (start >= 0 && found.parts++ < MAX_PARTS) {
                    const part = headerFields(lines.slice(start, i), 0)
                    readPart(part.fields, lines.slice(start + part.bodyAt, i), found, depth + 1)
                }
                start = i + 1
                if (line === open + "--") break
            }
            return
        }
        const disposition = typeOf(fields["content-disposition"]?.[0] || "")
        const attached = disposition.type === "attachment" || !!disposition.parameters.filename || !!content.parameters.name
        const kind = content.type === "text/plain" ? "plain" : content.type === "text/html" ? "html" : null
        if (!kind || attached || found[kind] != null) {
            // a file, or a second text beside the one taken: not carried
            if (!kind || attached) found.attachments++
            return
        }
        const encoding = lower(fields["content-transfer-encoding"]?.[0])
        const raw = lines.join("\n")
        const bytes =
            encoding === "base64" ? base64Bytes(raw) : encoding === "quoted-printable" ? quotedPrintable(raw, false) : null
        const charset = content.parameters.charset
        let text
        if (bytes) {
            const decoded = decodeBytes(bytes, charset)
            if (!decoded.known) found.unknownCharset = true
            text = decoded.text
        } else text = raw
        text = text.replace(/\r\n?/g, "\n")
        if (kind === "plain" && lower(content.parameters.format) === "flowed")
            text = unflow(text, lower(content.parameters.delsp) === "yes")
        found[kind] = text
    }
    const MAX_BODY = 200000
    /* One message of an mbox (its lines after the "From " line) as what the import keeps of it. */
    function readMessage(lines) {
        const head = headerFields(lines, 0)
        const field = name => head.fields[name]?.[0] || ""
        const found = {plain: null, html: null, attachments: 0, parts: 0, unknownCharset: false}
        // a line of a body that began with "From " was written ">From "
        readPart(
            head.fields,
            lines.slice(head.bodyAt).map(line => line.replace(/^>(>*From )/, "$1")),
            found,
            0
        )
        const ids = text => String(text || "").match(/<[^<>\s]+@[^<>\s]+>/g) || []
        let html = found.plain != null ? textHtml(found.plain) : found.html != null ? StringUtilities.cleanHtml(found.html) : ""
        const tooLong = html.length > MAX_BODY
        if (tooLong) html = StringUtilities.cleanHtml(html.slice(0, MAX_BODY))
        const from = field("from")
        return {
            messageId: ids(field("message-id"))[0] || "",
            parents: [...ids(field("in-reply-to")), ...ids(field("references")).reverse()],
            subject: decodeWords(field("subject")).slice(0, 250),
            date: mailDate(field("date")),
            address: address(decodeWords(from)),
            name: displayName(from),
            html,
            attachments: found.attachments,
            tooLong,
            unknownCharset: found.unknownCharset,
            empty: !plainText(html)
        }
    }

    // ===== the mbox importer =====
    const SEPARATOR = /^From \S.*\b\d{4}\s*$/
    const WINDOW = 2000
    const WINDOW_BYTES = 8 * 1024 * 1024
    const MAX_MESSAGE_LINES = 40000
    const keyOf = (contactListId, messageId) => digest(contactListId + "|" + messageId).slice(0, 22)
    const authorKey = emailAddress => digest("mbox-author|" + lower(emailAddress)).slice(0, 32)
    const subjectKey = (contactListId, subject) =>
        digest(
            contactListId +
                "|subject|" +
                lower(subject)
                    .replace(/^((re|aw|sv|antw|fwd?)\s*(\[\d+\])?:\s*)+/i, "")
                    .replace(/\s+/g, " ")
        ).slice(0, 32)
    const isReply = subject => /^\s*(re|aw|sv|antw)\s*(\[\d+\])?:/i.test(subject || "")
    const importDir = () => {
        const dir = System.getProperty("pass_import_dir")
        if (!dir) fail("Unavailable", "The import directory is not configured")
        return String(dir).replace(/\/$/, "")
    }
    function uniqueHandle(siteId, wanted, key) {
        const base =
            String(wanted || "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 24) || "list-member"
        const handle = base.length >= 3 ? base : "list-member"
        if (!one(S + "PublicSiteProfile", {siteId, handle})) return handle
        return (handle.slice(0, 22) + "-" + key.slice(0, 8)).slice(0, 32)
    }
    /* The author of an address in a site: the account that has verified it, else a profile with no account, made once
       for the address and found again by the address's hash. The address itself is not kept. */
    function authorOf(siteId, emailAddress, name) {
        const sourceId = authorKey(emailAddress || "unknown")
        const old = one(MAP, {siteId, sourceType: "mbox-author", sourceId}, true)
        if (old?.targetId) return old.targetId
        const account = emailAddress
            ? Array.from(
                  find("moqui.security.UserAccount", {})
                      .condition(ec.entity.conditionFactory.makeCondition("emailAddress", "equals", emailAddress).ignoreCase())
                      .limit(2)
                      .list()
              ).filter(row => row.disabled !== "Y")
            : []
        if (account.length === 1 && account[0].partyId && confirmed().verified(account[0].userId)) {
            create(MAP, {siteId, sourceType: "mbox-author", sourceId, targetId: account[0].partyId, state: "claimed"})
            return account[0].partyId
        }
        const shown = name || "List member"
        const partyId = ec.service
            .sync()
            .throwOnError(true)
            .name("mantle.party.PartyServices.create#Person")
            .parameters({firstName: shown.replace(/[<>]/g, "").slice(0, 60) || "List", lastName: "(list archive)"})
            .call().partyId
        create(S + "PublicSiteParty", {siteId, partyId, state: "active", role: "member", joinedAt: now(), revision: 1})
        create(S + "PublicSiteProfile", {
            siteId,
            partyId,
            handle: uniqueHandle(siteId, name, sourceId),
            displayName: shown,
            discoverability: "public",
            revision: 1
        })
        create(MAP, {siteId, sourceType: "mbox-author", sourceId, targetId: partyId, state: "index"})
        return partyId
    }
    const mboxImport = (siteId, importId, lock) => {
        const imp = one(F + "ForumImportRun", {importId}, lock)
        if (!imp || imp.siteId !== siteId || !String(imp.stage).startsWith("mbox-")) missing()
        return imp
    }
    methods.importMbox = p => {
        site(p.siteId)
        listStaff(p)
        const name = String(p.archiveName || "")
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) || name.includes(".."))
            invalid("Name an mbox file in the import directory")
        const location = importDir() + "/" + name
        if (!ec.resource.getLocationReference(location).exists) missing()
        const checksum = ec.resource.digest(location, "sha256")
        if (checksum !== lower(p.checksum)) fail("Conflict", "The archive checksum does not match")
        // the same archive into the same category again is the same import, run again: what it has is not made twice
        one(S + "PublicSite", {siteId: p.siteId}, true)
        let imp =
            rows(F + "ForumImportRun", {siteId: p.siteId, checksum}, 50).find(
                row => String(row.stage).startsWith("mbox-") && json(row.preflightJson, {}).contactListId === p.contactListId
            ) || null
        if (imp?.stage === "mbox-importing") {
            const run = one(F + "ForumJobRun", {runId: imp.importRunId})
            if (run?.state === "pending") fail("Conflict", "This archive is being imported")
        }
        const importId = imp?.importId || id()
        const runId = operations.startRun(p.siteId, "op-mbox", {
            importId,
            location,
            contactListId: p.contactListId,
            phase: "read",
            offset: 0
        })
        const fields = {stage: "mbox-importing", importRunId: runId, operatorPartyId: me()}
        if (imp) update(imp, {...fields, revision: Number(imp.revision || 1) + 1})
        else
            imp = create(F + "ForumImportRun", {
                importId,
                siteId: p.siteId,
                sourceName: String(p.sourceName || name).slice(0, 250),
                archiveName: name,
                checksum,
                preflightJson: JSON.stringify({contactListId: p.contactListId}),
                reconciliationRevision: 0,
                createdAt: now(),
                revision: 1,
                ...fields
            })
        audit(p.siteId, p.contactListId, "import", importId, "import-mbox", name, null, Number(imp.revision))
        return {importId, runId}
    }
    methods.getMboxImport = p => {
        site(p.siteId)
        const imp = mboxImport(p.siteId, p.importId)
        const contactListId = json(imp.preflightJson, {}).contactListId
        listStaff({siteId: p.siteId, contactListId})
        const run = imp.importRunId ? one(F + "ForumJobRun", {runId: imp.importRunId}) : null
        const live = run ? countsOf({siteId: imp.siteId, runId: run.runId}) : null
        return {
            import: {
                importId: imp.importId,
                sourceName: imp.sourceName,
                archiveName: imp.archiveName,
                contactListId,
                stage: String(imp.stage).slice(5),
                runId: imp.importRunId || null,
                runState: run?.state || null,
                // what was made and what could not be carried: messages, topics, replies, duplicates, attachments
                // (files left out), unknownCharset, tooLong, empty, unreadable, failed
                report: json(imp.reconciliationJson, null) || live || {}
            }
        }
    }
    /* What a run has counted, kept in a row of its own (by the run's id) that each item adds to in its own transaction:
       an item does not see the checkpoint of the items before it in the same pass, and what a failed item counted is
       rolled back with it. */
    const countKey = run => ({siteId: run.siteId, sourceType: "mbox-count", sourceId: run.runId})
    const countsOf = run => json(one(MAP, countKey(run))?.payload, {})
    function addCounts(run, counts) {
        if (!Object.keys(counts).length) return
        const row = one(MAP, countKey(run), true)
        const total = json(row?.payload, {})
        for (const [name, by] of Object.entries(counts)) total[name] = Number(total[name] || 0) + by
        row
            ? update(row, {payload: JSON.stringify(total)})
            : create(MAP, {...countKey(run), state: "index", payload: JSON.stringify(total)})
    }
    const bump = (counts, name, by = 1) => {
        if (by) counts[name] = Number(counts[name] || 0) + by
    }
    /* One message of the file kept for the second pass (its parents may come later in the file): a map row by the
       category and the Message-ID, and a row that orders it by its date. A Message-ID that is there is not taken again. */
    function stageMessage(run, config, lines, counts) {
        let message
        try {
            message = readMessage(lines)
        } catch (error) {
            ec.logger.error("Mbox import " + config.importId + ": a message could not be read: " + firstLine(error))
            bump(counts, "unreadable")
            return
        }
        const identity =
            message.messageId || "<" + digest(message.address + "|" + message.date + "|" + message.subject) + "@no-id>"
        const sourceId = keyOf(config.contactListId, identity)
        if (one(MAP, {siteId: run.siteId, sourceType: "mbox", sourceId})) {
            bump(counts, "duplicates")
            return
        }
        if (message.empty) {
            bump(counts, "empty")
            return
        }
        bump(counts, "attachments", message.attachments)
        bump(counts, "tooLong", message.tooLong ? 1 : 0)
        bump(counts, "unknownCharset", message.unknownCharset ? 1 : 0)
        const date = message.date || millis(now())
        create(MAP, {
            siteId: run.siteId,
            sourceType: "mbox",
            sourceId,
            importId: config.importId,
            state: "staged",
            payload: JSON.stringify({
                contactListId: config.contactListId,
                parents: message.parents.slice(0, 30).map(parent => keyOf(config.contactListId, parent)),
                subject: message.subject || "(no subject)",
                date,
                author: authorOf(run.siteId, message.address, message.name),
                html: message.html
            })
        })
        create(MAP, {
            siteId: run.siteId,
            sourceType: "mbox-order",
            sourceId: String(date).padStart(13, "0") + "-" + sourceId,
            importId: config.importId,
            targetId: sourceId,
            state: "staged"
        })
        bump(counts, "messages")
    }
    /* A piece of the file from the run's offset, which is always the start of a message: every whole message in it is
       staged, and the offset moves to the start of the last one that is not whole yet. A message longer than
       MAX_MESSAGE_LINES is cut there. */
    function readPiece(run, config, from) {
        const counts = {}
        let lines = []
        let done = false
        let windowAt = from
        let read
        const starts = []
        // windows are read until the piece holds a whole message, or the file ends
        for (;;) {
            read = ec.resource.readLines(config.location, windowAt, WINDOW, WINDOW_BYTES)
            const base = lines.length
            read.lines.forEach((line, index) => {
                const text = line.endsWith("\r") ? line.slice(0, -1) : line
                const at = base + index
                if (
                    SEPARATOR.test(text) &&
                    (at === 0 || lines[at - 1] === "" || (index > 0 && read.lines[index - 1].trim() === ""))
                )
                    starts.push({at, windowAt, index})
                lines.push(text)
            })
            // a read that gives nothing more ends the file
            done = !!read.done || !read.lines.length
            if (done || starts.length > (starts[0]?.at === 0 ? 1 : 0) || lines.length >= MAX_MESSAGE_LINES) break
            windowAt = read.nextOffset
        }
        // what is before the first "From " line of a piece is no message (the file's own start, or the rest of a cut one)
        const whole = done ? starts.length : starts.length - 1
        for (let k = 0; k < whole; k++) {
            const from = starts[k].at + 1
            const to = k + 1 < starts.length ? starts[k + 1].at : lines.length
            stageMessage(run, config, lines.slice(from, Math.min(to, from + MAX_MESSAGE_LINES)), counts)
        }
        addCounts(run, counts)
        if (done) return {offset: read.nextOffset, phase: "thread", after: null}
        const last = starts[starts.length - 1]
        if (!last || (whole <= 0 && lines.length >= MAX_MESSAGE_LINES)) {
            // one message that is too long, or lines that are no message: what was read of it is staged, the rest is passed
            const cut = {}
            if (last) stageMessage(run, config, lines.slice(last.at + 1, last.at + 1 + MAX_MESSAGE_LINES), cut)
            bump(cut, "tooLong", last ? 1 : 0)
            addCounts(run, cut)
            return {offset: read.nextOffset}
        }
        // the byte offset of the last message's "From " line: where the lines before it in its window end
        const offset =
            last.index === 0
                ? last.windowAt
                : ec.resource.readLines(config.location, last.windowAt, last.index, WINDOW_BYTES).nextOffset
        return {offset}
    }
    function writePost(fields, topic) {
        const postId = id()
        create(E + "CommunicationEvent", {
            communicationEventId: postId,
            communicationEventTypeId: "Message",
            contactListId: fields.contactListId,
            fromPartyId: fields.author,
            rootCommEventId: fields.root || null,
            parentCommEventId: fields.parent || null,
            subject: fields.subject,
            body: fields.html,
            statusId: "CeReceived",
            entryDate: stamp(fields.date)
        })
        if (topic) topic(postId)
        create(F + "ForumPostState", {
            communicationEventId: postId,
            rootCommEventId: fields.root || postId,
            ordinal: fields.ordinal,
            revision: 1,
            approvedRevision: 1,
            visibility: "approved",
            wiki: "N",
            reactionCount: 0
        })
        create(F + "ForumPostRevision", {
            communicationEventId: postId,
            revision: 1,
            sourceFormat: "html",
            sourceText: fields.html,
            sanitizedBody: fields.html,
            editorPartyId: fields.author,
            editedAt: stamp(fields.date),
            publicHistoryAllowed: "N"
        })
        return postId
    }
    /* A staged message becomes a post: a reply in the topic of the first parent the archive has (In-Reply-To, then
       References from the nearest), which is imported first when it comes later in the file; else, for a subject that
       answers one ("Re:"), in the topic of that subject; else a new topic. */
    function importMessage(siteId, sourceId, counts, depth) {
        const map = one(MAP, {siteId, sourceType: "mbox", sourceId}, true)
        if (!map || !map.payload) return null
        if (map.state === "imported") return map.targetId
        const message = JSON.parse(map.payload)
        let parentPostId = null
        for (const parentKey of message.parents) {
            if (parentKey === sourceId) continue
            const parent = one(MAP, {siteId, sourceType: "mbox", sourceId: parentKey})
            if (!parent) continue
            parentPostId =
                parent.state === "imported"
                    ? parent.targetId
                    : depth < 30
                      ? importMessage(siteId, parentKey, counts, depth + 1)
                      : null
            if (parentPostId) break
        }
        const bySubject = {siteId, sourceType: "mbox-subject", sourceId: subjectKey(message.contactListId, message.subject)}
        let root = parentPostId ? one(F + "ForumPostState", {communicationEventId: parentPostId})?.rootCommEventId : null
        if (!root && isReply(message.subject)) root = one(MAP, bySubject)?.targetId || null
        const topic = root ? one(F + "ForumTopic", {rootCommEventId: root}, true) : null
        let postId
        if (topic) {
            const rootEvent = one(E + "CommunicationEvent", {communicationEventId: root})
            postId = writePost({
                ...message,
                root,
                parent: parentPostId || root,
                subject: rootEvent?.subject || message.subject,
                ordinal: Number(topic.nextOrdinal || 2)
            })
            update(topic, {
                nextOrdinal: Number(topic.nextOrdinal || 2) + 1,
                visiblePostCount: Number(topic.visiblePostCount || 0) + 1,
                lastActivity: millis(topic.lastActivity) > message.date ? topic.lastActivity : stamp(message.date),
                revision: Number(topic.revision || 1) + 1
            })
            bump(counts, "replies")
        } else {
            postId = writePost({...message, ordinal: 1}, rootCommEventId =>
                create(F + "ForumTopic", {
                    rootCommEventId,
                    siteId,
                    kind: "category",
                    contactListId: message.contactListId,
                    revision: 1,
                    nextOrdinal: 2,
                    pinned: "N",
                    unlisted: "N",
                    visiblePostCount: 1,
                    reactionCount: 0,
                    lastActivity: stamp(message.date)
                })
            )
            if (!one(MAP, bySubject)) create(MAP, {...bySubject, importId: map.importId, targetId: postId, state: "index"})
            bump(counts, "topics")
        }
        update(map, {state: "imported", targetId: postId, errorText: null})
        return postId
    }
    const orderRows = (run, config) =>
        find(MAP, {siteId: run.siteId, sourceType: "mbox-order", importId: config.importId}).condition("state", "in", [
            "staged",
            "failed"
        ])
    operations.registerJob("op-mbox", {
        next(run, config) {
            const imp = one(F + "ForumImportRun", {importId: config.importId})
            if (!imp || imp.stage !== "mbox-importing") return null
            if (config.phase === "read") return "r" + (config.offset || 0)
            // a retry (which clears the checkpoint's place) takes the rows that failed again
            const query = orderRows(run, config)
            const next = Array.from(
                (config.after ? query.condition("sourceId", "greater", config.after) : query).orderBy("sourceId").limit(1).list()
            )[0]
            return next ? "t" + next.sourceId : null
        },
        item(run, config, itemId) {
            // the item's id says where it is: an item does not see the checkpoint of the items before it in the same pass
            if (itemId.startsWith("r")) return readPiece(run, config, Number(itemId.slice(1)) || 0)
            const order = one(MAP, {siteId: run.siteId, sourceType: "mbox-order", sourceId: itemId.slice(1)}, true)
            const counts = {}
            if (order) {
                importMessage(run.siteId, order.targetId, counts, 0)
                update(order, {state: "imported", errorText: null})
            }
            addCounts(run, counts)
            return {after: itemId.slice(1)}
        },
        onFailure(config, itemId, error, run) {
            addCounts(run, {failed: 1})
            // a piece that cannot be read ends the reading (a retry starts from it); a message that cannot be made is
            // named on its row and passed
            if (itemId.startsWith("r")) return {phase: "thread", after: null, readFailedAt: Number(itemId.slice(1)) || 0}
            const order = one(MAP, {siteId: run.siteId, sourceType: "mbox-order", sourceId: itemId.slice(1)}, true)
            if (order) update(order, {state: "failed", errorText: error})
            return {after: itemId.slice(1)}
        },
        finish(run, config, failed) {
            const imp = one(F + "ForumImportRun", {importId: config.importId}, true)
            if (!imp || imp.stage !== "mbox-importing") return
            update(imp, {
                stage: failed ? "mbox-failed" : "mbox-imported",
                reconciliationJson: JSON.stringify({
                    ...countsOf(run),
                    ...(config.readFailedAt != null ? {readFailedAt: config.readFailedAt} : {})
                }),
                revision: Number(imp.revision || 1) + 1
            })
        }
    })
    /* An account verified an address: the posts of the archives' author of that address become the account's, in every
       site, and the profile with no account ends. Bounded a call; what is left is taken by the next. */
    function claimAuthors(account) {
        const sourceId = authorKey(account.emailAddress)
        let moved = 0
        for (const map of Array.from(
            find(MAP, {sourceType: "mbox-author", sourceId, state: "index"}).limit(50).forUpdate(true).list()
        )) {
            const placeholder = map.targetId
            if (!placeholder || placeholder === account.partyId) continue
            let left = false
            for (const [entity, field] of [
                [E + "CommunicationEvent", "fromPartyId"],
                [F + "ForumPostRevision", "editorPartyId"]
            ])
                for (let batch = 0; batch < 20; batch++) {
                    const list = Array.from(
                        find(entity, {[field]: placeholder})
                            .limit(500)
                            .list()
                    )
                    for (const row of list) update(row, {[field]: account.partyId})
                    moved += entity.endsWith("Event") ? list.length : 0
                    left = list.length === 500 && batch === 19
                    if (list.length < 500) break
                }
            if (left) continue
            for (const entity of [S + "PublicSiteProfile", S + "PublicSiteParty"]) {
                const row = one(entity, {siteId: map.siteId, partyId: placeholder})
                if (row) row.delete()
            }
            update(map, {targetId: account.partyId, state: "claimed"})
            systemAudit(
                map.siteId,
                null,
                "member",
                account.partyId,
                "claim-archive-author",
                "Posts of a list archive claimed by a verified address"
            )
        }
        return moved
    }

    // ===== invitations of a list's members =====
    /* A plain notice by the site's mail settings: {sent}; never throws, and never fails the caller's work. */
    function notify(siteId, toAddress, title, url) {
        const settings = one(F + "ForumMailSettings", {siteId})
        if (!settings) return false
        try {
            const out = ec.service
                .sync()
                .requireNewTransaction(true)
                .throwOnError(true)
                .name("org.moqui.mail.EmailServices.send#EmailTemplate")
                .parameters({
                    emailTemplateId: settings.templateId,
                    toAddresses: toAddress,
                    extraHeaders: {"Auto-Submitted": "auto-replied"},
                    bodyParameters: {title, siteId, unsubscribeUrl: "", postUrl: url || ""}
                })
                .call()
            return !!out?.messageId
        } catch (error) {
            ec.message.clearErrors()
            ec.logger.warn("A list notice could not be sent: " + firstLine(error))
            return false
        }
    }
    const INVITE_DAYS = 14
    methods.inviteListMembers = p =>
        receipt(p, "inviteListMembers", () => {
            site(p.siteId)
            listStaff(p)
            const c = one(F + "ForumCategory", {contactListId: p.contactListId})
            if (c.mode !== "list") invalid("Only a mailing list's members are invited by their addresses")
            if (!Array.isArray(p.addresses) || !p.addresses.length || p.addresses.length > 500)
                invalid("addresses is a list of 1 to 500 email addresses")
            if (!one(F + "ForumMailSettings", {siteId: p.siteId})) fail("Conflict", "Configure outbound mail first")
            const listName = one(LIST + "ContactList", {contactListId: p.contactListId})?.contactListName || "the list"
            const counts = {invited: 0, alreadyInvited: 0, invalidCount: 0, unsent: 0}
            const seen = new Set()
            for (const given of p.addresses) {
                const emailAddress = lower(given)
                if (
                    typeof given !== "string" ||
                    emailAddress.length > 254 ||
                    !/^[^@\s<>,;]+@[^@\s<>,;]+\.[^@\s<>,;]+$/.test(emailAddress)
                ) {
                    counts.invalidCount++
                    continue
                }
                if (seen.has(emailAddress)) continue
                seen.add(emailAddress)
                const emailHash = hash(emailAddress)
                // one invitation of an address to a list at a time; nothing tells the caller whose address has an account
                const open = rows(S + "PublicSiteInvitation", {siteId: p.siteId, emailHash}, 50).some(
                    row =>
                        !row.redeemedAt &&
                        !row.revokedAt &&
                        millis(row.expiresAt) > millis(now()) &&
                        json(row.scopes, []).some(scope => scope?.list === p.contactListId)
                )
                if (open) {
                    counts.alreadyInvited++
                    continue
                }
                const token = id() + id()
                create(S + "PublicSiteInvitation", {
                    invitationId: id(),
                    siteId: p.siteId,
                    tokenHash: hash(token),
                    emailHash,
                    scopes: JSON.stringify([{list: p.contactListId}]),
                    inviterPartyId: requireUser(),
                    expiresAt: millis(now()) + INVITE_DAYS * 86400000
                })
                const url = publicApps().pageUrl(p.siteId, "account", "/Invitation?token=" + encodeURIComponent(token))
                if (
                    notify(
                        p.siteId,
                        emailAddress,
                        "You are invited to the " + listName + " list: confirm to receive its mail",
                        url
                    )
                )
                    counts.invited++
                else counts.unsent++
            }
            audit(
                p.siteId,
                p.contactListId,
                "category",
                p.contactListId,
                "invite-list-members",
                counts.invited + counts.unsent + " addresses",
                null,
                null
            )
            return counts
        })
    /* A redeemed invitation's lists: the account is a member of each list and gets every post of it by mail. */
    function subscribeLists(siteId, partyId, scopes) {
        for (const scope of Array.isArray(scopes) ? scopes : []) {
            const contactListId = typeof scope?.list === "string" ? scope.list : null
            const c = contactListId ? one(F + "ForumCategory", {contactListId}) : null
            if (!c || c.siteId !== siteId) continue
            if (!core.listMember(contactListId, partyId))
                create(LIST + "ContactListParty", {contactListId, partyId, fromDate: now(), statusId: "CLPT_ACCEPTED"})
            const key = {siteId, partyId, scopeType: "category", scopeId: contactListId}
            const old = one(F + "ForumDeliveryPreference", key, true)
            const values = {...key, emailMode: "EveryPost", suppressed: "N", revision: Number(old?.revision || 0) + 1}
            old ? update(old, values) : create(F + "ForumDeliveryPreference", {digestPeriod: "daily", includeOwn: "N", ...values})
        }
    }

    // ===== held mail =====
    const HELD_DAYS = 30
    const HELD_PER_ADDRESS = 20
    const HELD_PER_ROUTE_DAY = 200
    /* Whether mail to a route from an address that is no account's is kept for its sender to claim: a report address,
       and a list's address. */
    const holds = route =>
        route.targetType === "issue" ||
        (!!route.contactListId && one(F + "ForumCategory", {contactListId: route.contactListId})?.mode === "list")
    /* Keeps a message for its sender to claim, files its review item and answers the sender, once a day an address:
       {heldId, notice}; null when the sender has as many waiting as one may, or the address took its day's count. m: siteId, route, sender, senderName,
       subject, html, messageId. */
    function hold(m) {
        const {siteId, route} = m
        const waiting = find(HELD, {senderAddress: m.sender, state: "held"}).count()
        if (waiting >= HELD_PER_ADDRESS) return null
        // and an address takes no more a day than its moderators could read, whoever sends
        const today = find(HELD, {routeId: route.routeId})
            .condition("createdAt", "greater-equals", stamp(millis(now()) - 86400000))
            .count()
        if (today >= HELD_PER_ROUTE_DAY) return null
        const issue = route.targetType === "issue"
        const contactListId = (issue ? core.scopeAnswer("heldScope", route) : null) || route.contactListId || null
        const heldId = id()
        const token = id() + id()
        const reviewId = id()
        create(F + "ForumReviewItem", {
            reviewId,
            siteId,
            contactListId,
            targetType: "mail",
            targetId: heldId,
            targetRevision: 1,
            reasonFamily: "mail-held",
            state: "pending",
            revision: 1,
            createdAt: now(),
            // the text for those who read the item: the scope's moderators, and for a report its Owners alone
            detail: (
                "From: " +
                (m.senderName ? m.senderName + " " : "") +
                "<" +
                m.sender +
                ">\nSubject: " +
                m.subject +
                "\n\n" +
                plainText(m.html)
            ).slice(0, 3500)
        })
        const answered =
            find(HELD, {senderAddress: m.sender})
                .condition("noticeSentAt", "greater-equals", stamp(millis(now()) - 86400000))
                .count() > 0
        create(HELD, {
            heldId,
            siteId,
            routeId: route.routeId,
            contactListId,
            targetType: issue ? "issue" : "category",
            targetId: issue ? route.targetId : route.contactListId,
            senderAddress: m.sender,
            senderName: String(m.senderName || "").slice(0, 100),
            subject: m.subject,
            body: m.html,
            messageId: String(m.messageId || "").slice(0, 250),
            tokenHash: hash(token),
            reviewId,
            state: "held",
            noticeSentAt: answered ? null : now(),
            createdAt: now(),
            expiresAt: millis(now()) + HELD_DAYS * 86400000
        })
        if (!answered) {
            const url = issue
                ? core.scopeAnswer("heldLink", siteId, token)
                : publicApps().pageUrl(siteId, "forum", "/held-mail/" + encodeURIComponent(token))
            notify(
                siteId,
                m.sender,
                issue
                    ? "Your report was received and waits: confirm your address to file it"
                    : "Your message was not posted: make an account with this address, or confirm it, to post it",
                url
            )
        }
        return {heldId, notice: !answered}
    }
    /* A held message by the token of its sender's link, in a site, while it waits; Not Found otherwise. */
    function heldByToken(siteId, token, lock) {
        const held = typeof token === "string" && token ? one(HELD, {tokenHash: hash(token)}, lock) : null
        if (!held || held.siteId !== siteId || held.state !== "held" || millis(held.expiresAt) <= millis(now())) missing()
        return held
    }
    /* The signed-in account may claim a held message when its verified address is the sender's. */
    function requireSender(held) {
        const account = ec.user.userAccount
        if (!account || !confirmed().verified(account.userId) || lower(account.emailAddress) !== held.senderAddress)
            fail("Unauthorized", "accessDenied: Sign in with the confirmed address that sent this message")
        return account
    }
    /* A held message is done: claimed with what it became, or dropped; its text goes, and its review item ends. */
    function settle(held, state, resultId, reason) {
        update(held, {state, resultId: resultId || null, body: null})
        const r = held.reviewId ? one(F + "ForumReviewItem", {reviewId: held.reviewId}, true) : null
        if (r && ["pending", "claimed"].includes(r.state))
            update(r, {
                state: "dismissed",
                decisionReason: reason,
                detail: null,
                revision: Number(r.revision || 1) + 1,
                claimedByPartyId: null,
                claimExpiresAt: null
            })
    }
    /* Posts a held list message as the signed-in account, through the forum's own gate. */
    function postHeld(held) {
        const out = methods.publishPost({
            siteId: held.siteId,
            contactListId: held.targetId,
            title: String(held.subject || "").replace(/^((re|fwd?|aw):\s*)+/i, "") || "Message by email",
            body: held.body,
            operationId: ("held-" + held.heldId).slice(0, 60)
        })
        settle(held, "claimed", out.postId, "Posted by its sender")
        return out
    }
    methods.claimHeldMail = p => {
        requireUser()
        site(p.siteId)
        return receipt(p, "claimHeldMail", () => {
            const held = heldByToken(p.siteId, p.token, true)
            if (held.targetType !== "category") missing()
            requireSender(held)
            const out = postHeld(held)
            return {postId: out.postId, rootCommEventId: out.rootCommEventId, state: out.state}
        })
    }
    /* An account verified its address: the list messages held for that address are posted as the account. One that the
       forum refuses (the account may not post there yet) stays held until it is claimed or dropped. */
    function releaseHeld(account) {
        let posted = 0
        const sender = lower(account.emailAddress)
        const waiting = Array.from(
            find(HELD, {senderAddress: sender, state: "held", targetType: "category"})
                .orderBy("createdAt,heldId")
                .limit(HELD_PER_ADDRESS)
                .list()
        ).filter(held => millis(held.expiresAt) > millis(now()))
        if (!waiting.length) return 0
        const previous = ec.user.username
        ec.user.internalLoginUser(account.username)
        try {
            for (const held of waiting)
                try {
                    ec.service
                        .sync()
                        .requireNewTransaction(true)
                        .throwOnError(true)
                        .name("mantle.forum.DeliveryServices.release#HeldMail")
                        .parameters({heldId: held.heldId})
                        .call()
                    posted++
                } catch (error) {
                    ec.message.clearErrors()
                    ec.logger.info("Held mail " + held.heldId + " stays held: " + firstLine(error))
                }
        } finally {
            ec.user.logoutUser()
            if (previous) ec.user.internalLoginUser(previous)
        }
        return posted
    }
    /* release#HeldMail: one held list message posted as the signed-in sender, in a transaction of its own. */
    function releaseOne(heldId) {
        const held = one(HELD, {heldId}, true)
        if (!held || held.state !== "held" || held.targetType !== "category") return {}
        requireSender(held)
        return {postId: postHeld(held).postId}
    }
    /* claim#VerifiedAddress (the VerifiedAddress rule): what waited for the address of an account. */
    function claimVerified(userId) {
        const account = userId ? one("moqui.security.UserAccount", {userId}) : null
        if (!account || account.disabled === "Y" || !account.partyId || !confirmed().verified(userId))
            return {posted: 0, claimed: 0}
        return {claimed: claimAuthors(account), posted: releaseHeld(account)}
    }
    /* expire#HeldMail (a job): held messages past their time are dropped, text and review item with them. */
    function expireHeld() {
        let dropped = 0
        for (const held of Array.from(
            find(HELD, {state: "held"}).condition("expiresAt", "less-equals", now()).limit(500).forUpdate(true).list()
        )) {
            settle(held, "dropped", null, "Not claimed in " + HELD_DAYS + " days")
            dropped++
        }
        return {dropped}
    }
    /* A moderator's decision on a held message: nothing is posted for an address that is no account's, so the only
       decisions are to leave it or to drop it. */
    function decideHeld(r, decision) {
        const held = one(HELD, {heldId: r.targetId}, true)
        if (decision === "approved") invalid("A held message is posted by its sender, with an account; reject it to drop it")
        if (held && held.state === "held") update(held, {state: "dropped", body: null})
        update(r, {detail: null})
    }
    return {
        listRoute,
        listHeaders,
        holds,
        hold,
        heldByToken,
        requireSender,
        settle,
        releaseOne,
        claimVerified,
        expireHeld,
        decideHeld,
        subscribeLists,
        readMessage
    }
}
