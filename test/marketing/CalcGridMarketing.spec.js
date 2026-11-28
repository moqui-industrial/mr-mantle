// The marketing access profile of CalcGrid (data/10-seed/MarketingAndCommerce.xml; mr-moqui plans/IronCalc-DB2.md CG5,
// docs/tools/Database.md CalcGrid and access profiles), through org.moqui.calc.CalcServices as a screen would call them, with
// authorization on, as test/order/CalcGridSales.spec.js holds the sales profile: a holder reads the campaigns and contact lists of
// the organization they work in and none of another's; another organization's mailbox list, which the organization filters let
// through, is not on the sheet (CALC_NO_MAILBOX); an entity the profile does not offer is refused. New spec, no Groovy original.
const CALC = "org.moqui.calc.CalcServices"
const effectiveTime = Date.now()
const dayMillis = 86400000
const users = {}

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
function calc(verbNoun, parameters) {
    const out = ec.service.sync().name(`${CALC}.${verbNoun}`).parameters(parameters).call() || {}
    const errors = ec.message.hasError() ? ec.message.getErrorsString() : ""
    ec.message.clearErrors()
    return { out, errors }
}
// open a new document over an entity under the marketing profile, read its texts, and close it
function readEntity(entityName) {
    const opened = calc("open#CalcDocument", { profileId: "marketing", source: { type: "entity", entityName } })
    if (opened.errors || !opened.out.roomId) return { errors: opened.errors, texts: [] }
    const cells = calc("get#CalcCells", { roomId: opened.out.roomId, profileId: "marketing", sheet: 0, row: 1, column: 1, width: 40, height: 30 })
    calc("close#CalcDocument", { roomId: opened.out.roomId })
    const texts = cells.errors ? [] : Array.from(JSON.parse(String(cells.out.blockJson)).texts || []).map((text) => String(text.text))
    return { errors: cells.errors, texts }
}

feature("two organizations with a campaign and a contact list each, a mailbox of the second, and a reader of each", {
    when() {
        const past = effectiveTime - dayMillis
        for (const [orgId, name] of [["CGM_ORG", "CalcGrid Promotions"], ["CGM_ORG2", "CalcGrid Outreach"]]) {
            call("create#mantle.party.Party", { partyId: orgId, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_" })
            call("create#mantle.party.Organization", { partyId: orgId, organizationName: name })
            call("create#mantle.party.PartyRole", { partyId: orgId, roleTypeId: "OrgInternal" })
        }
        // the grants an application makes: CalcGrid itself, authoring, and the marketing profile, always for view, with the user
        // organization filters and no mailbox as its row scope
        call("create#moqui.security.UserGroup", { userGroupId: "CGM_READERS", description: "CalcGrid marketing readers" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGM_READERS_GRID", userGroupId: "CGM_READERS", artifactGroupId: "CALC_GRID",
                authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        // authors: a new document over an entity is an author's to open (CALC_GRID_AUTHOR)
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGM_READERS_AUTHOR", userGroupId: "CGM_READERS", artifactGroupId: "CALC_GRID_AUTHOR",
                authzTypeEnumId: "AUTHZT_ALLOW", authzActionEnumId: "AUTHZA_ALL" })
        call("create#moqui.security.ArtifactAuthz", { artifactAuthzId: "CGM_READERS_MARKETING", userGroupId: "CGM_READERS", artifactGroupId: "CALC_PROFILE_MARKETING",
                authzTypeEnumId: "AUTHZT_ALWAYS", authzActionEnumId: "AUTHZA_VIEW" })
        for (const entityFilterSetId of ["MANTLE_USER_ORG", "CALC_NO_MAILBOX"])
            call("create#moqui.security.ArtifactAuthzFilter", { artifactAuthzId: "CGM_READERS_MARKETING", entityFilterSetId })
        for (const [first, username, orgId] of [["Ann", "cgm.ann", "CGM_ORG"], ["Otto", "cgm.otto", "CGM_ORG2"]]) {
            const partyId = call("mantle.party.PartyServices.create#Person", { firstName: first, lastName: "CalcGrid" }).partyId
            users[first] = call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, emailAddress: `${username}@example.com`, username,
                    newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" }).userId
            call("create#moqui.security.UserGroupMember", { userGroupId: "CGM_READERS", userId: users[first], fromDate: past })
            call("create#mantle.party.PartyRelationship", { relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId,
                    fromRoleTypeId: "Employee", toPartyId: orgId, toRoleTypeId: "OrgInternal", fromDate: past })
        }
        for (const [marketingCampaignId, organizationPartyId] of [["CGM-C1", "CGM_ORG"], ["CGM-C2", "CGM_ORG2"]])
            call("create#mantle.marketing.campaign.MarketingCampaign", { marketingCampaignId, organizationPartyId, campaignName: `Campaign ${marketingCampaignId}` })
        for (const [contactListId, ownerPartyId, contactListTypeEnumId] of [["CGM-L1", "CGM_ORG", "NEWSLETTER"], ["CGM-L2", "CGM_ORG2", "NEWSLETTER"],
            ["CGM-BOX2", "CGM_ORG2", "MAILBOX"]])
            call("create#mantle.marketing.contact.ContactList", { contactListId, ownerPartyId, contactListTypeEnumId, contactListName: `List ${contactListId}` })
        return { users }
    },
    then({ users }) {
        Object.keys(users).length == 2
    },
})

feature("a holder reads their own organization's campaigns and lists, no other organization's mailbox; an entity not offered is refused", {
    when() {
        const annCampaigns = as("cgm.ann", () => readEntity("mantle.marketing.campaign.MarketingCampaign"))
        const ottoCampaigns = as("cgm.otto", () => readEntity("mantle.marketing.campaign.MarketingCampaign"))
        const annLists = as("cgm.ann", () => readEntity("mantle.marketing.contact.ContactList"))
        const ottoLists = as("cgm.otto", () => readEntity("mantle.marketing.contact.ContactList"))
        const members = as("cgm.ann", () => readEntity("mantle.marketing.contact.ContactListParty"))
        return { annCampaigns, ottoCampaigns, annLists, ottoLists, members }
    },
    then({ annCampaigns, ottoCampaigns, annLists, ottoLists, members }) {
        annCampaigns.errors == ""
        annCampaigns.texts.includes("CGM-C1")
        !annCampaigns.texts.includes("CGM-C2")
        ottoCampaigns.errors == ""
        ottoCampaigns.texts.includes("CGM-C2")
        !ottoCampaigns.texts.includes("CGM-C1")
        annLists.errors == ""
        annLists.texts.includes("CGM-L1")
        !annLists.texts.includes("CGM-L2")
        !annLists.texts.includes("CGM-BOX2")
        // a mailbox is the Inbox's, not a list on a sheet, even its own organization's
        ottoLists.errors == ""
        ottoLists.texts.includes("CGM-L2")
        !ottoLists.texts.includes("CGM-BOX2")
        members.errors.includes("Not available")
        members.texts.length == 0
    },
})
