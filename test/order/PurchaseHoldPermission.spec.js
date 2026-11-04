// A Purchase hold reason (OrderHoldType OhtPurchase) is placed and released with PURCHASE_HOLD_RELEASE, Purchasing's
// approver's permission (impl-purchasing P1, X4), not the sales order approver's ORDER_APPROVE; a Change hold keeps
// ORDER_APPROVE. hold#Order checks the permission its type names before it reads the order, so a missing order shows that a
// call got past the check. The service runs without artifact authorization: the rule is its own permission check.
// Standalone: spec-local groups and users.
const prefix = "PUR_HOLD_SPEC"
const call = (name, parameters) => ec.service.sync().name(name).parameters(parameters).disableAuthz().call()
// a user in a spec-local group holding only the given permission
function user(kind, permission) {
    const id = prefix + "_" + kind
    call("create#moqui.security.UserGroup", {userGroupId: id, description: "Purchase hold " + kind})
    call("create#moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    call("create#mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
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
// the message hold#Order answers the user for a hold of the type on a missing order
function hold(username, holdTypeEnumId) {
    login(username)
    ec.message.pushErrors()
    try {
        ec.service
            .sync()
            .name("mantle.order.OrderServices.hold#Order")
            .parameters({orderId: prefix + "_NO_ORDER", holdTypeEnumId})
            .requireNewTransaction(true)
            .disableAuthz()
            .call()
        return ec.message.getErrorsString()
    } catch (error) {
        return String(error.message)
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
let purchasing, sales

spec({
    setupSpec() {
        purchasing = user("PURCHASING", "PURCHASE_HOLD_RELEASE")
        sales = user("SALES", "ORDER_APPROVE")
    }
})

feature("a Purchase hold takes PURCHASE_HOLD_RELEASE, and a Change hold still takes ORDER_APPROVE", {
    when() {
        return {
            code: ec.entity.find("moqui.basic.Enumeration").condition("enumId", "OhtPurchase").disableAuthz().one().enumCode,
            purchasingPurchase: hold(purchasing, "OhtPurchase"),
            salesPurchase: hold(sales, "OhtPurchase"),
            purchasingChange: hold(purchasing, "OhtChange"),
            salesChange: hold(sales, "OhtChange")
        }
    },
    then({code, purchasingPurchase, salesPurchase, purchasingChange, salesChange}) {
        code == "PURCHASE_HOLD_RELEASE"
        purchasingPurchase.includes("ORDER_UNAVAILABLE")
        salesPurchase.includes("PERMISSION_DENIED: PURCHASE_HOLD_RELEASE")
        purchasingChange.includes("PERMISSION_DENIED: ORDER_APPROVE")
        salesChange.includes("ORDER_UNAVAILABLE")
    }
})
