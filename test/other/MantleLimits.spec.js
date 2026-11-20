// Mantle's count limits (service/mantle/other/Limits.js): a setting that is not a whole number is refused when read, and
// the readiness provider mantle.limits (LimitsServices.check#Limits) names it as a failed check, so an operator sees it
// before the calls it bounds fail; with every limit a count it is one ready check. Regression suite: these are rules.
// Run: ./moq test mr-mantle --spec MantleLimits
const limits = () => ec.resource.script("component://mr-mantle/service/mantle/other/Limits.js")
const check = () =>
    ec.service.sync().name("mantle.other.LimitsServices.check#Limits").parameters({providerKey: "mantle.limits"}).call().checks

spec({
    setupSpec() {
        login("john.doe")
    }
})

feature("a malformed count limit is a failed readiness check naming it, and refused when read; 0 is no limit", {
    when() {
        const ready = check()
        const broken = withConf("mantle@shop-payment-calls", "ten", () => {
            let refused = ""
            try {
                limits().limit("shop-payment-calls")
            } catch (error) {
                refused = String(error.message)
            }
            return {checks: check(), refused}
        })
        const none = withConf("mantle@forum-draft-days", "0", () => limits().limit("forum-draft-days"))
        const provider = ec.entity.find("moqui.server.ReadinessProvider").condition("providerKey", "mantle.limits").disableAuthz().one()
        return {ready, broken, none, provider: provider?.serviceName}
    },
    then({ready, broken, none, provider}) {
        provider == "mantle.other.LimitsServices.check#Limits"
        ready.map(row => row.state) == ["ready"]
        broken.checks.map(row => [row.checkKey, row.state, row.reasonCode]) == [["mantle.limits.shop-payment-calls", "failed", "LIMIT_INVALID"]]
        broken.checks[0].message.includes("mantle@shop-payment-calls")
        broken.refused.includes("mantle@shop-payment-calls is not a count")
        none == Infinity
    }
})
