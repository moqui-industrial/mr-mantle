// An internal organization's own Constitution (service/mantle/party/ConstitutionServices.xml; mr-moqui
// docs/ai/Constitution.md): one PartyContent per organization, the framework's provider answering for a user's active
// organization, saves and resets checked by ORG_CONSTITUTION_EDIT and the organization's scope, a stale hash or an invalid
// document refused with the previous document kept. New spec, no Groovy original.
const MANTLE = "mantle.party.ConstitutionServices"
const ADMIN = "org.moqui.admin.ConstitutionServices"
const dayMillis = 86400000
const effectiveTime = Date.now()
const users = {}
let orgId
let otherOrgId

function errorOf(name, params) {
    try { call(name, params) } catch (e) { ec.message.clearErrors(); return String(e.message) }
    if (ec.message.hasError()) { const text = ec.message.getErrorsString(); ec.message.clearErrors(); return text }
    return null
}
function as(username, run) {
    login(username, "moqui1!!")
    try { return run() } finally { login("john.doe") }
}
const rows = (partyId) => ec.entity.find("mantle.party.PartyContent").condition("partyId", partyId)
    .condition("partyContentTypeEnumId", "PcntConstitution").disableAuthz().count()
const retitled = (documentText, title) => call(`${ADMIN}.edit#ConstitutionDocument`,
    { documentText, operation: "setDocumentText", locale: "en", title }).documentText

spec({
    stepwise: true,
    setupSpec() { login("john.doe") },
    setup() { ec.artifactExecution.disableAuthz() },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    },
})

feature("two internal organizations, an editor working in one and an editor working in the other", {
    when() {
        orgId = call("mantle.party.PartyServices.create#Organization", { organizationName: "Rules Co", roleTypeId: "OrgInternal" }).partyId
        otherOrgId = call("mantle.party.PartyServices.create#Organization", { organizationName: "Elsewhere Co", roleTypeId: "OrgInternal" }).partyId
        call("create#moqui.security.UserGroup", { userGroupId: "CNS_EDITORS", description: "Constitution editors" })
        call("create#moqui.security.UserGroupPermission", { userGroupId: "CNS_EDITORS", userPermissionId: "ORG_CONSTITUTION_EDIT",
                fromDate: effectiveTime - dayMillis })
        for (const [first, username, org] of [["Mia", "cns.mia", orgId], ["Noa", "cns.noa", otherOrgId]]) {
            const partyId = call("mantle.party.PartyServices.create#Person", { firstName: first, lastName: "Ruler" }).partyId
            users[first] = call("mantle.party.PartyServices.create#PartyUserAccount", { partyId, emailAddress: `${username}@example.com`,
                    username, newPassword: "moqui1!!", newPasswordVerify: "moqui1!!" }).userId
            call("create#mantle.party.PartyRelationship", { relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId, fromRoleTypeId: "Employee",
                    toPartyId: org, toRoleTypeId: "OrgInternal", fromDate: effectiveTime - dayMillis })
            call("create#moqui.security.UserGroupMember", { userGroupId: "CNS_EDITORS", userId: users[first], fromDate: effectiveTime - dayMillis })
            call("create#moqui.security.UserPreference", { userId: users[first], preferenceKey: "ACTIVE_ORGANIZATION", preferenceValue: org })
        }
    },
    then() { orgId && otherOrgId && users.Mia && users.Noa }
})

feature("an organization without its own document inherits the global one", {
    when() {
        const current = as("cns.mia", () => call(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        const global = call(`${ADMIN}.get#Constitution`, { scope: "global" })
        const scoped = call(`${MANTLE}.get#ScopedConstitution`, { userId: users.Mia })
        return { current, global, scoped }
    },
    then({ current, global, scoped }) {
        current.customized == false && current.canEdit == true
        current.contentHash == global.contentHash
        scoped.scopeStatus == "inherit" && scoped.organizationPartyId == orgId && scoped.organizationName == "Rules Co"
        rows(orgId) == 0
    }
})

feature("its editor saves its own document, which then applies to its members", {
    when() {
        const current = as("cns.mia", () => call(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        const documentText = retitled(current.documentText, "Rules Co Constitution")
        const stored = as("cns.mia", () => call(`${MANTLE}.store#OrganizationConstitution`,
                { organizationPartyId: orgId, documentText, expectedHash: current.contentHash }))
        const scoped = call(`${MANTLE}.get#ScopedConstitution`, { userId: users.Mia })
        const read = as("cns.mia", () => call(`${ADMIN}.get#Constitution`, { locale: "en" }))
        const elsewhere = as("cns.noa", () => call(`${ADMIN}.get#Constitution`, { locale: "en" }))
        return { stored, scoped, read, elsewhere }
    },
    then({ stored, scoped, read, elsewhere }) {
        stored.contentHash != null
        scoped.scopeStatus == "override" && JSON.parse(scoped.documentText).title.en == "Rules Co Constitution"
        read.source == "organization" && read.organizationPartyId == orgId && read.title == "Rules Co Constitution"
        read.contentHash == stored.contentHash
        elsewhere.source != "organization" && elsewhere.title == "Constitution"
        rows(orgId) == 1
    }
})

feature("a stale hash, an invalid document and another organization's editor are refused; the document stays", {
    when() {
        const current = as("cns.mia", () => call(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        const global = call(`${ADMIN}.get#Constitution`, { scope: "global" })
        const stale = as("cns.mia", () => errorOf(`${MANTLE}.store#OrganizationConstitution`,
                { organizationPartyId: orgId, documentText: retitled(current.documentText, "Stale"), expectedHash: global.contentHash }))
        const broken = JSON.parse(current.documentText)
        broken.rules[1].id = broken.rules[0].id
        const invalid = as("cns.mia", () => errorOf(`${MANTLE}.store#OrganizationConstitution`,
                { organizationPartyId: orgId, documentText: JSON.stringify(broken), expectedHash: current.contentHash }))
        const outsider = as("cns.noa", () => errorOf(`${MANTLE}.store#OrganizationConstitution`,
                { organizationPartyId: orgId, documentText: retitled(current.documentText, "Taken"), expectedHash: current.contentHash }))
        const outsiderRead = as("cns.noa", () => errorOf(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        const outsiderScoped = as("cns.noa", () => call(`${MANTLE}.get#ScopedConstitution`, { userId: users.Noa, organizationPartyId: orgId }))
        const after = as("cns.mia", () => call(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        return { current, stale, invalid, outsider, outsiderRead, outsiderScoped, after }
    },
    then({ current, stale, invalid, outsider, outsiderRead, outsiderScoped, after }) {
        stale != null && stale.includes("changed since it was read")
        invalid != null && invalid.includes("is used twice")
        outsider != null && outsider.includes("ORG_CONSTITUTION_EDIT")
        outsiderRead != null && outsiderRead.includes("may not read")
        outsiderScoped.scopeStatus == "none"
        after.contentHash == current.contentHash
        rows(orgId) == 1
    }
})

feature("a reset returns the organization to the global document", {
    when() {
        const current = as("cns.mia", () => call(`${MANTLE}.get#OrganizationConstitution`, { organizationPartyId: orgId }))
        as("cns.mia", () => call(`${MANTLE}.reset#OrganizationConstitution`, { organizationPartyId: orgId, expectedHash: current.contentHash }))
        const scoped = call(`${MANTLE}.get#ScopedConstitution`, { userId: users.Mia })
        const again = as("cns.mia", () => errorOf(`${MANTLE}.reset#OrganizationConstitution`,
                { organizationPartyId: orgId, expectedHash: current.contentHash }))
        return { scoped, again }
    },
    then({ scoped, again }) {
        scoped.scopeStatus == "inherit"
        again != null && again.includes("uses the global Constitution already")
        rows(orgId) == 0
    }
})
