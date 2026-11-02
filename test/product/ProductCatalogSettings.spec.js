// The organization catalog and variant policies (mantle.product.ProductServices get# and store#CatalogSettings and
// VariantSettings): dated rows read and changed by Moqui permission in the user's organization. Spec-local groups hold
// the permissions, so no application's groups are needed. New spec, no Groovy original.
const S = "mantle.product.ProductServices.",
    ORG = "PCS_ORG",
    OTHER = "PCS_OTHER"
const find = (n, p = {}) => ec.entity.find(n).condition(p).disableAuthz(),
    one = (n, p) => find(n, p).one()
function as(user, fn) {
    login(user)
    ec.artifactExecution.disableAuthz()
    try {
        return fn()
    } finally {
        ec.message.clearErrors()
        login("john.doe")
    }
}
function invoke(n, p) {
    try {
        const out = call(n, p) || {},
            error = ec.message.getErrorsString()
        ec.message.clearErrors()
        return Object.assign({}, out, {error})
    } catch (e) {
        ec.message.clearErrors()
        return {error: String(e.message || e)}
    }
}
spec({
    setupSpec() {
        as("john.doe", () => {
            const groups = {PCS_CATALOG_ADMIN: ["PRODUCT_CATALOG_ADMIN"], PCS_CATALOG_READER: ["PRODUCT_CATALOG_VIEW"]}
            for (const [group, permissions] of Object.entries(groups)) {
                call("create#moqui.security.UserGroup", {userGroupId: group})
                for (const userPermissionId of permissions)
                    call("create#moqui.security.UserGroupPermission", {
                        userGroupId: group,
                        userPermissionId,
                        fromDate: "2000-01-01T00:00:00Z"
                    })
            }
            for (const id of [ORG, OTHER]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyOrganization"})
                call("create#mantle.party.Organization", {partyId: id, organizationName: id})
                call("create#mantle.party.PartyRole", {partyId: id, roleTypeId: "OrgInternal"})
            }
            call("create#mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: ORG, baseCurrencyUomId: "EUR"})
            for (const [id, group] of [
                ["PCS_ADMIN", "PCS_CATALOG_ADMIN"],
                ["PCS_READER", "PCS_CATALOG_READER"]
            ]) {
                call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
                call("create#mantle.party.Person", {partyId: id, firstName: id})
                call("create#moqui.security.UserAccount", {
                    userId: id,
                    username: id.toLowerCase(),
                    partyId: id,
                    currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
                    passwordHashType: "SHA"
                })
                call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: group, fromDate: "2000-01-01T00:00:00Z"})
                call("create#mantle.party.PartyRelationship", {
                    fromPartyId: id,
                    toPartyId: ORG,
                    relationshipTypeEnumId: "PrtAgent",
                    toRoleTypeId: "OrgInternal",
                    fromDate: "2000-01-01T00:00:00Z"
                })
            }
        })
    }
})

feature("an organization without a policy reads the defaults, with its base currency", {
    when() {
        return as("pcs_reader", () => invoke(S + "get#CatalogSettings", {organizationPartyId: ORG}))
    },
    then(read) {
        read.error == ""
        read.versionSeqId == 0
        read.settings.defaultCurrencyUomId == "EUR"
        read.settings.requiredFields.includes("productName")
    }
})
feature("an administrator starts a dated catalog policy; a stale token, a reader and another organization are refused", {
    when() {
        const saved = as("pcs_admin", () =>
            invoke(S + "store#CatalogSettings", {
                organizationPartyId: ORG,
                expectedVersion: 0,
                settings: {defaultCurrencyUomId: "USD", requiredFields: "productName,amountUomId", idPolicy: "manual"},
                changeReason: "Spec policy"
            })
        )
        const read = as("pcs_reader", () => invoke(S + "get#CatalogSettings", {organizationPartyId: ORG})),
            stale = as("pcs_admin", () =>
                invoke(S + "store#CatalogSettings", {
                    organizationPartyId: ORG,
                    expectedVersion: 0,
                    settings: {idPolicy: "internal"}
                })
            ),
            reader = as("pcs_reader", () =>
                invoke(S + "store#CatalogSettings", {organizationPartyId: ORG, expectedVersion: read.versionSeqId, settings: {}})
            ),
            other = as("pcs_admin", () => invoke(S + "get#CatalogSettings", {organizationPartyId: OTHER}))
        return {saved, read, stale, reader, other}
    },
    then({saved, read, stale, reader, other}) {
        saved.error == ""
        read.settings.idPolicy == "manual"
        read.settings.requiredFields == ["productName", "amountUomId"]
        read.history.length == 1
        stale.error.includes("reload")
        reader.error.includes("authority")
        other.error.includes("not available")
    }
})
feature("a variant policy limits its batch size and copies only safe fields", {
    when() {
        const initial = as("pcs_admin", () => invoke(S + "get#VariantSettings", {organizationPartyId: ORG})),
            unsafe = as("pcs_admin", () =>
                invoke(S + "store#VariantSettings", {organizationPartyId: ORG, settings: {copyFields: "productName"}})
            ),
            saved = as("pcs_admin", () =>
                invoke(S + "store#VariantSettings", {
                    organizationPartyId: ORG,
                    expectedFromDate: initial.fromDate,
                    settings: {batchLimit: 50, copyFields: "description,taxable"},
                    changeReason: "Spec variants"
                })
            )
        return {initial, unsafe, saved}
    },
    then({initial, unsafe, saved}) {
        initial.settings.batchLimit == 1000
        unsafe.error.includes("never copyable")
        saved.error == ""
        saved.settings.batchLimit == 50
        saved.settings.copyFields == ["description", "taxable"]
    }
})

feature("an explicit backdated variant policy refuses without changing issued policy rows", {
    when() {
        const snapshot = () =>
            JSON.stringify(
                Array.from(
                    find("mantle.product.ProductVariantSetting", {organizationPartyId: ORG}).orderBy("fromDate").list()
                ).map(row => row.getMap())
            )
        const before = snapshot()
        const refused = as("pcs_admin", () => {
            const initial = invoke(S + "get#VariantSettings", {organizationPartyId: ORG})
            return invoke(S + "store#VariantSettings", {
                organizationPartyId: ORG,
                expectedFromDate: initial.fromDate,
                fromDate: Number(ec.user.nowTimestamp) - 60000,
                settings: {batchLimit: 40, copyFields: "description,taxable"},
                changeReason: "Refused backdated policy"
            })
        })
        return {before, after: snapshot(), refused}
    },
    then({before, after, refused}) {
        refused.error.includes("now or later")
        after == before
    }
})
