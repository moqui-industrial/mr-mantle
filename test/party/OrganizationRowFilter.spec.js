// The organization row filter of business datasets (mantle.party.PartyServices.get#OrganizationRowFilter, the report engine's
// ReportScopePolicy MantleOrganization; BOSS impl-insights P3, F11): the viewer's organizations on the field the dataset names,
// the active one alone when set, a child organization with its parent, nothing for a viewer of no organization, every
// organization for a system administrator. A finance administrator (ACCOUNTING_ADMIN) is bound to their own organizations
// in Accounting's scope and active organization; every internal one takes ACCOUNTING_ALL_ORGANIZATIONS (SEC-BOS-02). New spec,
// no Groovy original.
const FILTER = "mantle.party.PartyServices.get#OrganizationRowFilter"
const dayMillis = 86400000
const users = {}

spec({
    stepwise: true,
    setupSpec() {
        login("john.doe")
    },
    setup() {
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
})

// the filter as a user would get it from the report engine, with their own userId
function filterAs(username, parameters) {
    login(username, "moqui1!!")
    ec.artifactExecution.disableAuthz()
    try {
        return call(FILTER, Object.assign({userId: ec.user.userId, datasetId: "orf-dataset"}, parameters || {})).filter
    } finally {
        login("john.doe")
    }
}
function errorOf(username, parameters) {
    login(username, "moqui1!!")
    ec.artifactExecution.disableAuthz()
    try {
        call(FILTER, parameters)
    } catch (error) {
        ec.message.clearErrors()
        return String(error.message)
    } finally {
        login("john.doe")
    }
    return null
}
const valuesOf = filter => Array.from(filter?.field?.values || []).sort()

feature("two internal organizations, a child of the first, and a user of both and one of none", {
    when() {
        const past = Date.now() - dayMillis
        for (const [partyId, name] of [
            ["ORF_A", "Row Filter A"],
            ["ORF_B", "Row Filter B"],
            ["ORF_C", "Row Filter A Child"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: "_NA_"})
            call("create#mantle.party.Organization", {partyId, organizationName: name})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
        }
        // ORF_C rolls up to ORF_A, so A's people see its rows
        call("create#mantle.party.PartyRelationship", {
            relationshipTypeEnumId: "PrtOrgRollup",
            fromPartyId: "ORF_C",
            fromRoleTypeId: "OrgInternal",
            toPartyId: "ORF_A",
            toRoleTypeId: "OrgInternal",
            fromDate: past
        })
        for (const [username, orgIds] of [
            ["orf.both", ["ORF_A", "ORF_B"]],
            ["orf.none", []]
        ]) {
            const partyId = call("mantle.party.PartyServices.create#Person", {firstName: username, lastName: "RowFilter"}).partyId
            users[username] = call("mantle.party.PartyServices.create#PartyUserAccount", {
                partyId,
                emailAddress: username + "@example.com",
                username,
                newPassword: "moqui1!!",
                newPasswordVerify: "moqui1!!"
            }).userId
            for (const toPartyId of orgIds)
                call("create#mantle.party.PartyRelationship", {
                    relationshipTypeEnumId: "PrtEmployee",
                    fromPartyId: partyId,
                    fromRoleTypeId: "Employee",
                    toPartyId,
                    toRoleTypeId: "OrgInternal",
                    fromDate: past
                })
        }
        return {created: Object.keys(users).length}
    },
    then({created}) {
        created == 2
    }
})

feature("the user's organizations and the child on the dataset's field, or organizationPartyId by default", {
    when() {
        return {
            named: filterAs("orf.both", {rowFilterParameters: {organizationField: "vendorPartyId"}}),
            plain: filterAs("orf.both")
        }
    },
    then({named, plain}) {
        named.field.name == "vendorPartyId"
        named.field.op == "in"
        valuesOf(named).join(",") == "ORF_A,ORF_B,ORF_C"
        plain.field.name == "organizationPartyId"
        valuesOf(plain).join(",") == "ORF_A,ORF_B,ORF_C"
    }
})

feature("the active organization alone when the user has set one", {
    when() {
        login("orf.both", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", "ORF_B")
        login("john.doe")
        const active = filterAs("orf.both", {rowFilterParameters: {organizationField: "vendorPartyId"}})
        login("orf.both", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
        login("john.doe")
        return {active}
    },
    then({active}) {
        valuesOf(active).join(",") == "ORF_B"
    }
})

feature("nothing for a user of no organization, everything for a system administrator, and refusals", {
    when() {
        ec.artifactExecution.disableAuthz()
        const admin = call(FILTER, {userId: ec.user.userId}).filter
        return {
            none: filterAs("orf.none"),
            admin,
            otherUser: errorOf("orf.both", {userId: users["orf.none"]}),
            expression: errorOf("orf.both", {rowFilterParameters: {organizationField: "a) || (b"}})
        }
    },
    then({none, admin, otherUser, expression}) {
        none.bool.none.length == 1
        none.field == null
        admin.match_all != null
        otherUser.includes("signed-in user only")
        expression.includes("is not a field name")
    }
})

feature("a finance administrator's active organization outside their own widens nothing", {
    when() {
        // with ACCOUNTING_ALL_ORGANIZATIONS a finance administrator selects any internal organization (get#PartyOrganizationInfo);
        // the dataset
        // filter keeps to the user's own organizations, here none
        const past = Date.now() - dayMillis
        call("create#moqui.security.UserGroup", {userGroupId: "ORF_FINANCE", description: "Row filter finance"})
        call("create#moqui.security.UserGroupPermission", {
            userGroupId: "ORF_FINANCE",
            userPermissionId: "ACCOUNTING_ADMIN",
            fromDate: past
        })
        call("create#moqui.security.UserGroupMember", {userGroupId: "ORF_FINANCE", userId: users["orf.none"], fromDate: past})
        login("orf.none", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", "ORF_A")
        login("john.doe")
        const selected = filterAs("orf.none")
        login("orf.none", "moqui1!!")
        ec.user.setPreference("ACTIVE_ORGANIZATION", null)
        login("john.doe")
        return {selected}
    },
    then({selected}) {
        selected.field == null
        selected.bool.none.length == 1
    }
})

// SEC-BOS-02: ACCOUNTING_ADMIN works in the holder's own organizations, and an active organization outside them is dropped;
// ACCOUNTING_ALL_ORGANIZATIONS (ADMIN's in the seed) opens every internal organization and lets one be selected
feature("a finance administrator is bound to their own organizations; every organization takes ACCOUNTING_ALL_ORGANIZATIONS", {
    when() {
        const past = Date.now() - dayMillis
        const partyId = call("mantle.party.PartyServices.create#Person", {firstName: "orf.finance", lastName: "RowFilter"}).partyId
        const userId = call("mantle.party.PartyServices.create#PartyUserAccount", {
            partyId,
            emailAddress: "orf.finance@example.com",
            username: "orf.finance",
            newPassword: "moqui1!!",
            newPasswordVerify: "moqui1!!"
        }).userId
        call("create#mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId,
            fromRoleTypeId: "Employee", toPartyId: "ORF_A", toRoleTypeId: "OrgInternal", fromDate: past})
        call("create#moqui.security.UserGroupMember", {userGroupId: "ORF_FINANCE", userId, fromDate: past})
        const scopeAs = () => {
            login("orf.finance", "moqui1!!")
            ec.user.setPreference("ACTIVE_ORGANIZATION", "ORF_B")
            const policy = ec.resource.script("component://mr-mantle/service/mantle/ledger/AccountingPolicy.js")
            const a = policy.access("admin")
            const out = {ids: Array.from(a.organizationPartyIds).sort(), active: a.activeOrganizationPartyId,
                info: call("mantle.party.PartyServices.get#PartyOrganizationInfo", {}).activeOrgId || null}
            ec.user.setPreference("ACTIVE_ORGANIZATION", null)
            login("john.doe")
            ec.artifactExecution.disableAuthz()
            return out
        }
        const own = scopeAs()
        call("create#moqui.security.UserGroupPermission", {userGroupId: "ORF_FINANCE", userPermissionId: "ACCOUNTING_ALL_ORGANIZATIONS",
            fromDate: past})
        const every = scopeAs()
        const seeded = ec.entity.find("moqui.security.UserGroupPermission").condition("userPermissionId", "ACCOUNTING_ALL_ORGANIZATIONS")
            .condition("userGroupId", "ADMIN").count()
        return {own, every, seeded}
    },
    then({own, every, seeded}) {
        own.ids.join() == "ORF_A,ORF_C"
        own.active == null
        own.info == null
        every.ids.includes("ORF_A") && every.ids.includes("ORF_B")
        every.active == "ORF_B"
        every.info == "ORF_B"
        seeded == 1
    }
})

// SEC-BOS-94: a chart account is one row for the instance. A finance administrator of ORF_A (with GL posting) changes an
// account ORF_A alone is assigned, not one ORF_B uses too, assigns no account of ORF_B's own, does not change from the child
// ORF_C an account of the parent's, and changes no currency unit, which every organization shares
feature("a finance administrator of one organization changes only its own chart accounts, and no currency (SEC-BOS-94)", {
    when() {
        const past = Date.now() - dayMillis
        const partyId = call("mantle.party.PartyServices.create#Person", {firstName: "orf.chart", lastName: "RowFilter"}).partyId
        call("mantle.party.PartyServices.create#PartyUserAccount", {partyId, emailAddress: "orf.chart@example.com", username: "orf.chart",
            newPassword: "moqui1!!", newPasswordVerify: "moqui1!!"})
        call("create#mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtEmployee", fromPartyId: partyId,
            fromRoleTypeId: "Employee", toPartyId: "ORF_A", toRoleTypeId: "OrgInternal", fromDate: past})
        call("create#moqui.security.UserGroup", {userGroupId: "ORF_CHART", description: "Row filter chart"})
        for (const userPermissionId of ["ACCOUNTING_ADMIN", "ACCOUNTING_GL_POST"])
            call("create#moqui.security.UserGroupPermission", {userGroupId: "ORF_CHART", userPermissionId, fromDate: past})
        call("create#moqui.security.UserGroupMember", {userGroupId: "ORF_CHART", userId: ec.entity.find("moqui.security.UserAccount")
            .condition("username", "orf.chart").one().userId, fromDate: past})
        const like = ec.entity.find("mantle.ledger.account.GlAccount").condition("glAccountId", "111100000").one()
        const account = (glAccountId, accountCode, orgIds) => {
            call("create#mantle.ledger.account.GlAccount", {glAccountId, accountCode, accountName: glAccountId,
                glAccountClassEnumId: like.glAccountClassEnumId, glAccountTypeEnumId: like.glAccountTypeEnumId})
            for (const organizationPartyId of orgIds)
                call("create#mantle.ledger.account.GlAccountOrganization", {glAccountId, organizationPartyId, fromDate: past})
        }
        account("ORF_ACCT_SHARED", "1999401", ["ORF_A", "ORF_B"])
        account("ORF_ACCT_OWN", "1999402", ["ORF_A"])
        account("ORF_ACCT_B", "1999403", ["ORF_B"])
        const rename = (glAccountId, organizationPartyId) => {
            const row = ec.entity.find("mantle.ledger.account.GlAccount").condition("glAccountId", glAccountId).one()
            return {glAccountId, organizationPartyId, accountCode: row.accountCode, accountName: glAccountId + " renamed",
                glAccountClassEnumId: row.glAccountClassEnumId, glAccountTypeEnumId: row.glAccountTypeEnumId,
                lastUpdatedStamp: row.lastUpdatedStamp, changeReason: "Spec rename"}
        }
        const attempt = (name, parameters) => {
            ec.message.pushErrors()
            try {
                ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).call()
                return ec.message.hasError() ? ec.message.getErrorsString() : ""
            } catch (error) {
                return String(error.message)
            } finally {
                ec.message.clearErrors()
                ec.message.popErrors()
            }
        }
        login("orf.chart", "moqui1!!")
        ec.artifactExecution.disableAuthz()
        const out = {
            shared: attempt("mantle.ledger.AccountServices.store#Account", rename("ORF_ACCT_SHARED", "ORF_A")),
            own: attempt("mantle.ledger.AccountServices.store#Account", rename("ORF_ACCT_OWN", "ORF_A")),
            fromChild: attempt("mantle.ledger.AccountServices.store#Account", rename("ORF_ACCT_OWN", "ORF_C")),
            assignOthers: attempt("mantle.ledger.AccountServices.store#Assignment", {organizationPartyId: "ORF_A", glAccountId: "ORF_ACCT_B",
                changeReason: "Spec assign"}),
            classify: attempt("mantle.ledger.AccountServices.store#Classification", {organizationPartyId: "ORF_A", glAccountId: "ORF_ACCT_SHARED",
                glAccountGroupId: "ORF_NO_GROUP", changeReason: "Spec group"}),
            currency: attempt("mantle.ledger.CurrencyServices.store#Currency", {organizationPartyId: "ORF_A", uomId: "USD",
                description: "Dollar renamed", fractionDigits: 2, changeReason: "Spec currency"})
        }
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        out.sharedName = ec.entity.find("mantle.ledger.account.GlAccount").condition("glAccountId", "ORF_ACCT_SHARED").one().accountName
        // a finance administrator of both organizations changes the account they share
        const bothParty = call("mantle.party.PartyServices.create#Person", {firstName: "orf.chartboth", lastName: "RowFilter"}).partyId
        const bothUserId = call("mantle.party.PartyServices.create#PartyUserAccount", {partyId: bothParty, emailAddress: "orf.chartboth@example.com",
            username: "orf.chartboth", newPassword: "moqui1!!", newPasswordVerify: "moqui1!!"}).userId
        for (const toPartyId of ["ORF_A", "ORF_B"])
            call("create#mantle.party.PartyRelationship", {relationshipTypeEnumId: "PrtEmployee", fromPartyId: bothParty,
                fromRoleTypeId: "Employee", toPartyId, toRoleTypeId: "OrgInternal", fromDate: past})
        call("create#moqui.security.UserGroupMember", {userGroupId: "ORF_CHART", userId: bothUserId, fromDate: past})
        login("orf.chartboth", "moqui1!!")
        ec.artifactExecution.disableAuthz()
        out.both = attempt("mantle.ledger.AccountServices.store#Account", rename("ORF_ACCT_SHARED", "ORF_A"))
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        out.bothName = ec.entity.find("mantle.ledger.account.GlAccount").condition("glAccountId", "ORF_ACCT_SHARED").one().accountName
        out.assigned = ec.entity.find("mantle.ledger.account.GlAccountOrganization").condition({glAccountId: "ORF_ACCT_B", organizationPartyId: "ORF_A"}).count()
        return out
    },
    then(out) {
        out.shared.includes("ACCOUNT_SHARED")
        out.sharedName == "ORF_ACCT_SHARED"
        out.own == ""
        out.fromChild.includes("ACCOUNT_SHARED")
        out.assignOthers.includes("ACCOUNT_UNAVAILABLE")
        out.assigned == 0
        out.classify.includes("ACCOUNT_SHARED")
        out.currency.includes("PERMISSION_DENIED")
        out.both == ""
        out.bothName == "ORF_ACCT_SHARED renamed"
    }
})
