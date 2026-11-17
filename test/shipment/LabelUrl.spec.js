// SEC-BAP-06: a label or document file at a route segment's stored URL is fetched only from an https URL, and on a
// production instance only from a host a registered shipping gateway type names for its label files
// (mantle.account.GatewayConnectionServices.check#LabelUrl), which the label print service, Shippo's download and
// mr-marble's getShipmentLabel ask before they fetch. Run: ./moq test mr-mantle --spec LabelUrl
const CHECK = "mantle.account.GatewayConnectionServices.check#LabelUrl"
const refusal = (url) => call(CHECK, {url}).refusal || ""

feature("a label URL is https, and on a production instance at a carrier's label host only", {
    when() {
        const other = {
            plain: refusal("http://shippo-delivery.s3.amazonaws.com/l.pdf"),
            elsewhere: refusal("https://files.example.com/l.pdf"),
            internal: refusal("https://10.0.0.5/l.pdf")
        }
        const production = withProperty("instance_purpose", "production", () => ({
            shippo: refusal("https://shippo-delivery.s3.amazonaws.com/abc.pdf?Expires=1"),
            elsewhere: refusal("https://files.example.com/l.pdf"),
            disguised: refusal("https://shippo-delivery.s3.amazonaws.com@files.example.com/l.pdf"),
            plain: refusal("http://shippo-delivery.s3.amazonaws.com/l.pdf")
        }))
        return {other, production}
    },
    then({other, production}) {
        other.plain.includes("https")
        other.elsewhere == ""
        other.internal == ""
        production.shippo == ""
        production.elsewhere.includes("label host")
        production.disguised.includes("files.example.com")
        production.plain.includes("https")
    }
})
