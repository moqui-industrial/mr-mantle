// The sales access profile of CalcGrid (data/CalcGridProfileData.xml; mr-moqui plans/IronCalc-DB.md, Access and row scope,
// crates/moqui-calc/src/profile.rs), through org.moqui.calc.CalcServices as a screen would call them, with authorization on:
// a holder of the profile reads the orders of the organizations they work in and none of another's, on a data sheet over a
// view; an entity the profile does not offer, and an offered one no organization filter applies to, are refused; a user
// with no organization reads no row; a document saved by an author and shared with the group shows each reader their own
// rows; only an author makes and saves one; and without the profile there is no access. New spec, no Groovy original.
const CALC = "org.moqui.calc.CalcServices"
const effectiveTime = Date.now()
const dayMillis = 86400000
const users = {}
const parties = {}
const ORDERS = "mantle.order.OrderHeaderAndPart"

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
        ec.user.setEffectiveTime(effectiveTime)
    },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
})

// run as a user with authorization on, the user's organizations in the user context as an app's root screen sets them
function as(username, run) {
    login(username, "moqui1!!")
    call("mantle.party.PartyServices.setup#UserOrganizationInfo", {})
    ec.artifactExecution.enableAuthz()
    try { return run() } finally {
        ec.artifactExecution.disableAuthz()
        for (const name of ["userOrgIds", "filterOrgIds", "activeOrgId"]) delete ec.user.context[name]
        login("john.doe")
    }
}
// a CalcServices call: its out-parameters and its error text
function calc(verbNoun, parameters) {
    const out = ec.service.sync().name(`${CALC}.${verbNoun}`).parameters(parameters).call() || {}
    const errors = ec.message.hasError() ? ec.message.getErrorsString() : ""
    ec.message.clearErrors()
    return { out, errors }
}
// the texts of a room's first sheet: rows by columns, from the cells the service answers
function sheetTexts(roomId) {
    const answer = calc("get#CalcCells", { roomId, profileId: "sales", sheet: 0, row: 1, column: 1, width: 40, height: 30 })
    if (answer.errors) return { errors: answer.errors, texts: [] }
    return { errors: "", texts: Array.from(JSON.parse(String(answer.out.blockJson)).texts || []).map((text) => String(text.text)) }
}
// open a new document over an entity under the sales profile, read its texts, and close it
function readEntity(entityName) {
    const opened = calc("open#CalcDocument", { profileId: "sales", source: { type: "entity", entityName } })
    if (opened.errors || !opened.out.roomId) return { errors: opened.errors, texts: [], dataRows: null }
    const read = sheetTexts(opened.out.roomId)
    calc("close#CalcDocument", { roomId: opened.out.roomId })
    return { errors: read.errors, texts: read.texts, dataRows: (opened.out.sheets || [])[0].dataRows }
}

feature("two organizations with an order each, and users: an author and a viewer of the first, an author of the second, one of no organization, one without the profile", {
    when() {
        const past = effectiveTime - dayMillis
        for (const [orgId, name] of [["CGS_ORG", "CalcGrid Works"], ["CGS_ORG2", "CalcGrid Other"]]) {
            call("create#mantle.party.Party", { partyId: orgId, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_" })
            call("create#mantle.party.Organization", { partyId: orgId, organizationName: name })
            call("create#mantle.party.PartyRole", { partyId: orgId, roleTypeId: "OrgInternal" })
        }
        // the grants an application makes: CalcGrid itself, authoring for the authors, and the sales profile, always for
        // view, with the user organization filters as its row scope
        for (const [groupId, author] of [["CGS_AUTHORS", true], ["CGS_VIEWERS", false]]) {
            call("create#moqui.security.UserGroup", { userGroupId: groupId, description: `CalcGrid sales ${groupId}` })
            call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: `${groupId}_GRID`, userGroupId: groupId, artifactGroupId: "CALC_GRID",
                    authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
            if (author) call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: `${groupId}_AUTHOR`, userGroupId: groupId, artifactGroupId: "CALC_GRID_AUTHOR",
                    authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
            call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: `${groupId}_SALES`, userGroupId: groupId, artifactGroupId: "CALC_PROFILE_SALES",
                    authzTypeEnumId: "AUTHZT_ALWAYS", authzActionEnumId: "AUTHZA_VIEW" })
            call("create#moqui.security.ArtifactAuthzFilter", { artifactAuthzId: `${groupId}_SALES`, entityFilterSetId: "MANTLE_USER_ORG" })
        }
        // a group that holds CalcGrid and no profile
        call("create#moqui.security.UserGroup", { userGroupId: "CGS_NOPROFILE", description: "CalcGrid with no profile" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGS_NOPROFILE_GRID", userGroupId: "CGS_NOPROFILE", artifactGroupId: "CALC_GRID",
                authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        // a group all of them share a document with
        call("create#moqui.security.UserGroup", { userGroupId: "CGS_SHARED", description: "CalcGrid sales readers" })
        for (const [first, username, groups, orgId] of [["Ann", "cgs.ann", ["CGS_AUTHORS"], "CGS_ORG"], ["Vic", "cgs.vic", ["CGS_VIEWERS"], "CGS_ORG"],
            ["Otto", "cgs.otto", ["CGS_AUTHORS"], "CGS_ORG2"], ["Nell", "cgs.nell", ["CGS_AUTHORS"], null], ["Paul", "cgs.paul", ["CGS_NOPROFILE"], "CGS_ORG"]]) {
            const partyId = call("mantle.party.PartyServices.create#Person", { firstName: first, lastName: "CalcGrid" }).partyId
            users[first] = call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, emailAddress: `${username}@example.com`, username,
                    newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" }).userId
            parties[first] = partyId
            for (const userGroupId of groups.concat(["CGS_SHARED"])) call("create#moqui.security.UserGroupMember", { userGroupId, userId: users[first], fromDate: past })
            if (orgId) call("create#mantle.party.PartyRelationship", { relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId,
                    fromRoleTypeId: "Employee", toPartyId: orgId, toRoleTypeId: "OrgInternal", fromDate: past })
        }
        // an order sold by each organization
        for (const [orderId, vendorPartyId] of [["CGS-O1", "CGS_ORG"], ["CGS-O2", "CGS_ORG2"]]) {
            call("create#mantle.order.OrderHeader", { orderId, orderName: `Order of ${vendorPartyId}`, statusId: "OrderPlaced", currencyUomId: "USD",
                    placedDate: ec.user.nowTimestamp, grandTotal: orderId === "CGS-O1" ? 110 : 220 })
            call("create#mantle.order.OrderPart", { orderId, orderPartSeqId: "01", vendorPartyId, customerPartyId: parties.Paul, statusId: "OrderPlaced", partTotal: orderId === "CGS-O1" ? 110 : 220 })
        }
        return { users }
    },
    then({ users }) {
        Object.keys(users).length == 5
    },
})

feature("a holder reads the orders of their own organization on a data sheet, and none of another's", {
    when() {
        const ann = as("cgs.ann", () => readEntity(ORDERS))
        const otto = as("cgs.otto", () => readEntity(ORDERS))
        const profiles = as("cgs.ann", () => calc("get#CalcProfiles", {}).out)
        const offered = as("cgs.ann", () => Array.from(calc("find#CalcEntities", { profileId: "sales", term: "mantle.order" }).out.entityNames || []))
        return { ann, otto, profiles, profileIds: Array.from(profiles.profiles || []).map((profile) => profile.profileId), offered }
    },
    then({ ann, otto, profiles, profileIds, offered }) {
        ann.errors == ""
        ann.dataRows == 1
        ann.texts.includes("CGS-O1")
        !ann.texts.includes("CGS-O2")
        otto.errors == ""
        otto.dataRows == 1
        otto.texts.includes("CGS-O2")
        !otto.texts.includes("CGS-O1")
        profiles.tools === false
        profiles.canAuthor === true
        profileIds.join(",") == "sales"
        offered.includes(ORDERS)
        offered.includes("mantle.order.OrderPart")
        !offered.includes("mantle.order.OrderItemBilling")
    },
})

feature("an entity the profile does not offer, a member no organization filter applies to, SQL and a file are refused; no organization reads no row", {
    when() {
        const ledger = as("cgs.ann", () => readEntity("mantle.ledger.transaction.AcctgTrans"))
        const header = as("cgs.ann", () => readEntity("mantle.order.OrderHeader"))
        const sql = as("cgs.ann", () => calc("open#CalcDocument", { profileId: "sales", source: { type: "sql", sql: "select * from order_header" } }))
        const file = as("cgs.ann", () => calc("open#CalcDocument", { profileId: "sales", workbookLocation: "dbresource://moqui/etl/any.xlsx" }))
        const nell = as("cgs.nell", () => readEntity(ORDERS))
        return { ledger, header, sql, file, nell }
    },
    then({ ledger, header, sql, file, nell }) {
        ledger.errors.includes("Not available")
        ledger.texts.length == 0
        header.errors.includes("Not available")
        header.texts.length == 0
        sql.errors.includes("Not available")
        !sql.out.roomId
        file.errors.includes("Not available")
        !file.out.roomId
        nell.errors == ""
        nell.dataRows == 0
        !nell.texts.includes("CGS-O1")
        !nell.texts.includes("CGS-O2")
    },
})

feature("without the profile, with no profile named, and for a viewer making a document, there is no access", {
    when() {
        const paul = as("cgs.paul", () => readEntity(ORDERS))
        const paulProfiles = as("cgs.paul", () => calc("get#CalcProfiles", {}).out)
        const noProfile = as("cgs.ann", () => calc("open#CalcDocument", { source: { type: "entity", entityName: ORDERS } }))
        const unknown = as("cgs.ann", () => calc("open#CalcDocument", { profileId: "nosuch", source: { type: "entity", entityName: ORDERS } }))
        const viewerNew = as("cgs.vic", () => calc("open#CalcDocument", { profileId: "sales", source: { type: "entity", entityName: ORDERS } }))
        return { paul, paulProfileCount: Array.from(paulProfiles.profiles || []).length, noProfile, unknown, viewerNew }
    },
    then({ paul, paulProfileCount, noProfile, unknown, viewerNew }) {
        paul.errors.includes("Not available")
        paul.texts.length == 0
        paulProfileCount == 0
        noProfile.errors.includes("Not authorized for the Tools app")
        !noProfile.out.roomId
        unknown.errors.includes("Not available")
        viewerNew.errors.includes("Not available")
        !viewerNew.out.roomId
    },
})

feature("a document an author saves and shares shows each reader their own organization's rows, and stores none", {
    when() {
        const saved = as("cgs.ann", () => {
            const opened = calc("open#CalcDocument", { profileId: "sales", source: { type: "entity", entityName: ORDERS }, title: "Sales orders" })
            const save = calc("save#CalcDocument", { roomId: opened.out.roomId, profileId: "sales", definitionId: "cgs-sales-orders", userGroupId: "CGS_SHARED" })
            // a room is read only under the profile it was opened under
            const otherWay = calc("get#CalcCells", { roomId: opened.out.roomId, sheet: 0, row: 1, column: 1, width: 5, height: 5 })
            calc("close#CalcDocument", { roomId: opened.out.roomId })
            return { errors: opened.errors + save.errors, definitionId: save.out.definitionId, otherWay: otherWay.errors }
        })
        const stored = JSON.stringify(ec.entity.find("moqui.report.Definition").condition("definitionId", "cgs-sales-orders").one().getMap())
        const readAs = (username) => as(username, () => {
            const opened = calc("open#CalcDocument", { profileId: "sales", definitionId: "cgs-sales-orders" })
            if (opened.errors) return { errors: opened.errors, texts: [] }
            const read = sheetTexts(opened.out.roomId)
            const refreshed = calc("refresh#CalcDocument", { roomId: opened.out.roomId, profileId: "sales" })
            const exported = calc("export#CalcDocument", { roomId: opened.out.roomId, profileId: "sales" })
            const viewerSave = calc("save#CalcDocument", { roomId: opened.out.roomId, profileId: "sales", title: "Mine now" })
            calc("close#CalcDocument", { roomId: opened.out.roomId })
            return { errors: read.errors + refreshed.errors + exported.errors, texts: read.texts, exported: !!exported.out.contentBytes, viewerSave: viewerSave.errors }
        })
        const vic = readAs("cgs.vic")
        const otto = readAs("cgs.otto")
        const paul = as("cgs.paul", () => calc("open#CalcDocument", { profileId: "sales", definitionId: "cgs-sales-orders" }))
        // the document is its author's to delete; the spec takes its rows away
        for (const entityName of ["moqui.report.DefinitionVersion", "moqui.report.Definition"])
            ec.entity.find(entityName).condition("definitionId", "cgs-sales-orders").deleteAll()
        return { saved, stored, vic, otto, paul }
    },
    then({ saved, stored, vic, otto, paul }) {
        saved.errors == ""
        saved.definitionId == "cgs-sales-orders"
        saved.otherWay.includes("Not authorized for the Tools app")
        stored.includes("OrderHeaderAndPart")
        !stored.includes("CGS-O1")
        vic.errors == ""
        vic.texts.includes("CGS-O1")
        !vic.texts.includes("CGS-O2")
        vic.exported === true
        vic.viewerSave.includes("Not available")
        otto.errors == ""
        otto.texts.includes("CGS-O2")
        !otto.texts.includes("CGS-O1")
        paul.errors.includes("Not available")
        !paul.out.roomId
    },
})

feature("a range of a document read as a report's table is the caller's own rows, under the access they chose or the first profile they hold", {
    when() {
        as("cgs.ann", () => {
            const opened = calc("open#CalcDocument", { profileId: "sales", source: { type: "entity", entityName: ORDERS }, columns: ["orderId", "vendorPartyId"], title: "Frame orders" })
            calc("save#CalcDocument", { roomId: opened.out.roomId, profileId: "sales", definitionId: "cgs-frame-orders", userGroupId: "CGS_SHARED" })
            calc("close#CalcDocument", { roomId: opened.out.roomId })
        })
        // the first column of the range, below its header, as each reader gets it with no profile named
        const firstColumn = (username, parameters) => as(username, () => {
            const answer = calc("get#CalcFrame", Object.assign({ definitionId: "cgs-frame-orders", range: "OrderHeaderAndPart!A1:A20" }, parameters || {}))
            const field = Array.from((answer.out.frame || {}).fields || [])[0] || {}
            return { errors: answer.errors, name: field.name, values: Array.from(field.values || []).filter((value) => value != null) }
        })
        const vic = firstColumn("cgs.vic")
        const otto = firstColumn("cgs.otto")
        const paul = firstColumn("cgs.paul")
        const named = firstColumn("cgs.otto", { profileId: "sales" })
        const notHeld = firstColumn("cgs.paul", { profileId: "sales" })
        // a choice is kept only for a profile the user holds
        const choice = as("cgs.vic", () => calc("set#CalcProfile", { profileId: "sales" }).errors)
        const badChoice = as("cgs.paul", () => calc("set#CalcProfile", { profileId: "sales" }).errors)
        for (const entityName of ["moqui.report.DefinitionVersion", "moqui.report.Definition"])
            ec.entity.find(entityName).condition("definitionId", "cgs-frame-orders").deleteAll()
        return { vic, otto, paul, named, notHeld, choice, badChoice }
    },
    then({ vic, otto, paul, named, notHeld, choice, badChoice }) {
        vic.errors == ""
        vic.name == "orderId"
        vic.values.join(",") == "CGS-O1"
        otto.errors == ""
        otto.values.join(",") == "CGS-O2"
        named.values.join(",") == "CGS-O2"
        paul.errors.includes("Not available")
        paul.values.length == 0
        notHeld.errors.includes("Not available")
        choice == ""
        badChoice.includes("Not available")
    },
})
