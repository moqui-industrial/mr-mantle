// Purchasing's buying policy and supplier rules (impl-purchasing P2, F25, F34): PurchasePolicy as dated rows with the
// approval gate off by default (store#PurchasePolicy under PURCHASE_POLICY_EDIT, get#PurchasePolicy); the SupplierProfile's
// buying fields under SUPPLIER_PROFILE_EDIT beside the finance fields under SUPPLIER_TERMS_EDIT, with an approval decision
// under PURCHASE_APPROVE; a new supplier starting Pending where the policy requires approval; the buyer as a dated
// Buyer-to-Supplier relationship; and check#SupplierUsable's Warn and Stop. Standalone: a spec-local organization, suppliers,
// groups and users, with artifact authorization disabled (the rules are the services' own permission checks).
// Run: ./moq test mr-mantle --spec PurchasePolicy
const prefix = "PUR_POLICY_SPEC"
const org = prefix + "_ORG"
const supplier = prefix + "_SUPPLIER",
    blocked = prefix + "_BLOCKED"
const users = {}
const call = (name, parameters) => ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
const one = (entity, key) => ec.entity.find(entity).condition(key).disableAuthz().one()
const rows = (entity, key) => Array.from(ec.entity.find(entity).condition(key).disableAuthz().list())
const svc = (name, parameters = {}) => {
    const out = ec.service.sync().name(name).parameters(parameters).disableAuthz().call() || {}
    if (ec.message.hasError()) {
        const errors = ec.message.getErrorsString()
        ec.message.clearErrors()
        throw new Error(errors)
    }
    return out
}
// the message a call is refused with, or "" when it succeeds, in its own transaction
function refused(name, parameters) {
    ec.message.pushErrors()
    try {
        ec.service.sync().name(name).parameters(parameters).requireNewTransaction(true).disableAuthz().call()
        return ec.message.hasError() ? ec.message.getErrorsString() : ""
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
    }
}
// a user of the organization in a spec-local group holding the permissions
function user(kind, permissions) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase policy " + kind})
    for (const permission of permissions)
        call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    call("create#mantle.party.Person", {partyId: id, firstName: "Policy", lastName: kind})
    call("create#mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtAgent",
        fromPartyId: id,
        toPartyId: org,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    call("create#moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    call("create#moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
const policyService = "mantle.order.PurchaseServices.",
    supplierService = "mantle.party.SupplierServices."
const minutes = count => new Date(Number(ec.user.nowTimestamp) + count * 60000)

spec({
    setupSpec() {
        call("create#mantle.party.Party", {partyId: org, partyTypeEnumId: "PtyOrganization"})
        call("create#mantle.party.Organization", {partyId: org, organizationName: "Purchase Policy Spec Org"})
        call("create#mantle.party.PartyRole", {partyId: org, roleTypeId: "OrgInternal"})
        for (const [partyId, name] of [
            [supplier, "Policy Spec Supplier"],
            [blocked, "Policy Spec Blocked"]
        ]) {
            call("create#mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: org})
            call("create#mantle.party.Organization", {partyId, organizationName: name})
            call("create#mantle.party.PartyRole", {partyId, roleTypeId: "Supplier"})
        }
        call("create#mantle.party.PartyClassification", {
            partyClassificationId: prefix + "_CAT",
            classificationTypeEnumId: "PcltSupplierCategory",
            description: "Packaging"
        })
        users.admin = user("ADMIN", ["PURCHASE_POLICY_EDIT"])
        users.buyer = user("BUYER", ["SUPPLIER_PROFILE_EDIT", "PURCHASE_ORDER_EDIT"])
        users.finance = user("FINANCE", ["SUPPLIER_TERMS_EDIT"])
        users.approver = user("APPROVER", ["SUPPLIER_PROFILE_EDIT", "PURCHASE_APPROVE"])
        users.none = user("NONE", [])
    },
    cleanupSpec() {
        ec.message.clearErrors()
        login("john.doe")
    }
})

feature("with no policy row the approval gate and supplier approval are off, and a supplier without a profile is usable", {
    when() {
        login(users.buyer)
        const read = svc(policyService + "get#PurchasePolicy", {organizationPartyId: org})
        const usable = svc(policyService + "check#SupplierUsable", {organizationPartyId: org, supplierPartyId: supplier})
        const none = (login(users.none), refused(policyService + "get#PurchasePolicy", {organizationPartyId: org}))
        login("john.doe")
        return {read, usable, none}
    },
    then({read, usable, none}) {
        read.policy.approvalGateEnabled == "N"
        read.policy.supplierApprovalRequired == "N"
        read.policy.unapprovedSupplierEnumId == "PusWarn"
        read.policy.selfApprovalAllowed == "N"
        read.policyFromDate == null
        read.canEdit == false
        usable.result == "OK"
        usable.usable == true
        none.includes("PERMISSION_DENIED")
    }
})

feature("an administrator starts a dated policy row; a later row ends it and both stay; a buyer and a stale form are refused", {
    when() {
        const request = {
            organizationPartyId: org,
            policyGroup: "controls",
            supplierApprovalRequired: "Y",
            rfqResponseDays: 10,
            changeReason: "Onboarding control"
        }
        login(users.buyer)
        const buyerRefused = refused(policyService + "store#PurchasePolicy", request)
        login(users.admin)
        const first = svc(policyService + "store#PurchasePolicy", request)
        const stale = refused(policyService + "store#PurchasePolicy", Object.assign({}, request, {expectedFromDate: null}))
        const invalid = refused(
            policyService + "store#PurchasePolicy",
            Object.assign({}, request, {expectedFromDate: first.fromDate, unapprovedSupplierEnumId: "PcmManual"})
        )
        const later = svc(policyService + "store#PurchasePolicy", {
            organizationPartyId: org,
            policyGroup: "controls",
            expectedFromDate: first.fromDate,
            fromDate: minutes(60),
            unapprovedSupplierEnumId: "PusStop",
            changeReason: "Stop unapproved suppliers"
        })
        const now = svc(policyService + "get#PurchasePolicy", {organizationPartyId: org})
        const then = svc(policyService + "get#PurchasePolicy", {organizationPartyId: org, asOfDate: minutes(90)})
        login("john.doe")
        return {buyerRefused, first, stale, invalid, later, now, then}
    },
    then({buyerRefused, first, stale, invalid, now, then}) {
        buyerRefused.includes("PERMISSION_DENIED")
        first.policy.supplierApprovalRequired == "Y"
        String(first.policy.rfqResponseDays) == "10"
        stale.includes("POLICY_CHANGED")
        invalid.includes("POLICY_INVALID")
        now.history.length == 2
        now.policy.unapprovedSupplierEnumId == "PusWarn"
        now.history[1].thruDate != null
        then.policy.unapprovedSupplierEnumId == "PusStop"
        then.policy.supplierApprovalRequired == "Y"
        then.policy.approvalGateEnabled == "N"
    }
})

feature(
    "a buyer sets the profile's buying fields and is refused its terms; finance sets the terms and is refused the buying fields",
    {
        when() {
            const terms = {organizationPartyId: org, supplierPartyId: supplier, selfBillingIndicator: "Y", changeReason: "Terms"}
            const buying = {
                organizationPartyId: org,
                supplierPartyId: supplier,
                currencyUomId: "USD",
                incotermEnumId: "TtFOB",
                changeReason: "Buying terms"
            }
            login(users.buyer)
            const buyerTerms = refused(supplierService + "store#SupplierProfile", terms)
            const stored = svc(supplierService + "store#SupplierProfile", buying)
            const same = svc(supplierService + "store#SupplierProfile", buying)
            const decision = refused(
                supplierService + "store#SupplierProfile",
                Object.assign({}, buying, {approvalStatusId: "SupaApproved"})
            )
            const badIncoterm = refused(
                supplierService + "store#SupplierProfile",
                Object.assign({}, buying, {incotermEnumId: "PusWarn"})
            )
            login(users.finance)
            const financeBuying = refused(supplierService + "store#SupplierProfile", buying)
            const financeTerms = svc(supplierService + "store#SupplierProfile", Object.assign({}, terms, {fromDate: minutes(1)}))
            login("john.doe")
            const profile = rows("mantle.party.supplier.SupplierProfile", {
                organizationPartyId: org,
                supplierPartyId: supplier
            }).sort((a, b) => Number(b.fromDate) - Number(a.fromDate))[0]
            return {buyerTerms, stored, same, decision, badIncoterm, financeBuying, financeTerms, profile}
        },
        then({buyerTerms, stored, same, decision, badIncoterm, financeBuying, financeTerms, profile}) {
            buyerTerms.includes("PERMISSION_DENIED: SUPPLIER_TERMS_EDIT")
            stored.changed == true
            same.changed == false
            decision.includes("PERMISSION_DENIED: PURCHASE_APPROVE")
            badIncoterm.includes("PROFILE_INVALID")
            financeBuying.includes("PERMISSION_DENIED: SUPPLIER_PROFILE_EDIT")
            financeTerms.changed == true
            // the finance change carried the buying fields over
            profile.currencyUomId == "USD"
            profile.incotermEnumId == "TtFOB"
            profile.selfBillingIndicator == "Y"
        }
    }
)

feature(
    "a dated purchase block stops the supplier and cancels nothing; an unapproved supplier gets the policy's Warn, then its Stop",
    {
        when() {
            login(users.buyer)
            const noReason = refused(supplierService + "store#SupplierProfile", {
                organizationPartyId: org,
                supplierPartyId: blocked,
                purchaseBlockFromDate: minutes(-5)
            })
            svc(supplierService + "store#SupplierProfile", {
                organizationPartyId: org,
                supplierPartyId: blocked,
                purchaseBlockFromDate: minutes(-5),
                purchaseBlockReason: "Quality hold",
                fromDate: minutes(-10)
            })
            const check = (supplierPartyId, asOfDate) =>
                svc(policyService + "check#SupplierUsable", {organizationPartyId: org, supplierPartyId, asOfDate})
            const blockedNow = check(blocked)
            // the policy requires approval from the second feature, so a supplier with no status is unapproved: Warn now, Stop
            // under the later row
            const warn = check(supplier)
            const stop = check(supplier, minutes(90))
            login(users.approver)
            svc(supplierService + "store#SupplierProfile", {
                organizationPartyId: org,
                supplierPartyId: supplier,
                approvalStatusId: "SupaApproved",
                fromDate: minutes(2),
                changeReason: "Approved"
            })
            const approved = (login(users.buyer), check(supplier, minutes(90)))
            login("john.doe")
            return {noReason, blockedNow, warn, stop, approved}
        },
        then({noReason, blockedNow, warn, stop, approved}) {
            noReason.includes("BLOCK_INVALID")
            blockedNow.result == "STOP"
            blockedNow.reasonCode == "SUPPLIER_BLOCKED"
            blockedNow.message.includes("Quality hold")
            warn.result == "WARN"
            warn.usable == true
            warn.reasonCode == "SUPPLIER_UNAPPROVED"
            stop.result == "STOP"
            stop.usable == false
            approved.result == "OK"
        }
    }
)

feature("a new supplier starts Pending where the policy requires approval, and the buyer is a dated relationship", {
    when() {
        login(users.none)
        const noneRefused = refused(supplierService + "create#Supplier", {organizationPartyId: org, organizationName: "Nope"})
        login(users.buyer)
        const created = svc(supplierService + "create#Supplier", {
            organizationPartyId: org,
            organizationName: "Policy Spec New Supplier",
            emailAddress: "orders@policy-spec.example.com",
            partyClassificationId: prefix + "_CAT"
        })
        const first = svc(supplierService + "store#SupplierBuyer", {
            organizationPartyId: org,
            supplierPartyId: created.partyId,
            buyerPartyId: users.buyer
        })
        const outsider = refused(supplierService + "store#SupplierBuyer", {
            organizationPartyId: org,
            supplierPartyId: created.partyId,
            buyerPartyId: "john.doe"
        })
        const second = svc(supplierService + "store#SupplierBuyer", {
            organizationPartyId: org,
            supplierPartyId: created.partyId,
            buyerPartyId: users.approver,
            fromDate: minutes(5)
        })
        login("john.doe")
        const party = one("mantle.party.Party", {partyId: created.partyId})
        const relationships = rows("mantle.party.PartyRelationship", {
            toPartyId: created.partyId,
            relationshipTypeEnumId: "PrtSupplier"
        }).sort((a, b) => Number(a.fromDate) - Number(b.fromDate))
        const category = rows("mantle.party.PartyClassificationAppl", {partyId: created.partyId})
        return {noneRefused, created, first, outsider, second, party, relationships, category}
    },
    then({noneRefused, created, first, outsider, second, party, relationships, category}) {
        noneRefused.includes("PERMISSION_DENIED")
        created.approvalStatusId == "SupaPending"
        party.ownerPartyId == org
        category.length == 1
        first.changed == true
        outsider.includes("BUYER_INVALID")
        second.changed == true
        relationships.length == 2
        relationships[0].fromPartyId == users.buyer
        relationships[0].thruDate != null
        relationships[1].fromPartyId == users.approver
        relationships[1].fromRoleTypeId == "Buyer"
    }
})
