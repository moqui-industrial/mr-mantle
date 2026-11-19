// The local test payment gateways (PaymentGatewayConfig of type PgtTest, data/AccountConfigData.xml), which approve without a
// charge (SEC-BOS-129): on a production instance (instance@purpose) a gateway operation through one is refused, and none is
// permitted for an organization, unless the operator allows them (mantle@allow-test-gateways, a public demo's conf). Mantle's
// gateway dispatch (PaymentServices.xml *#SinglePayment) and store#PaymentGatewayOrganization ask refusal.
// CC0 plus patent grant.
function refusal(config) {
    if (!config || config.paymentGatewayTypeEnumId !== "PgtTest") return null
    if (String(ec.factory.getConfValue("instance@purpose") || "") !== "production") return null
    if (String(ec.factory.getConfValue("mantle@allow-test-gateways") || "false") === "true") return null
    return (
        "TEST_GATEWAY_PRODUCTION: The test payment gateway " +
        config.paymentGatewayConfigId +
        " takes no payment on a production instance"
    )
}
;({refusal})
