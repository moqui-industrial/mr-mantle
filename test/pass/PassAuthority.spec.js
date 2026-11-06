// The PASS authority's one function after the transport's checks (script/PassAuthority.js, mr-moqui plans/Edge-Node.md
// §5.5), which the REST servlet (script/PassApi.js) and the host's gRPC PassAuthority (PassAuthorityServices.handle#Call)
// both call: an operation runs its schema service, a field the schema does not list and a delegation that is missing or
// not good are refused with the REST API's error envelope, an account action runs the framework's account service and
// a registered client's sign-in gets a delegation; and the servlet still answers a route through it. The site and the
// registered client are spec-local.
const SITE = "PASS_AUTHORITY_SPEC"
const CLIENT = "paspec"
const authority = () => ec.resource.script("component://mr-mantle/script/PassAuthority.js")
const handle = p => authority().handle({siteId: SITE, input: {}, ...p})
function sys(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// A request and response as the servlet API gives them to PassApi.js: the response keeps its status, headers and body.
function servlet(method, path, headers = {}) {
    const request = {
        requestURI: "/rest/s1/pass/v1/sites/" + SITE + "/" + path,
        method,
        getHeader: name => headers[String(name).toLowerCase()] ?? null,
        getParameterMap: () => ({})
    }
    const response = {
        status: 200,
        headers: {},
        body: "",
        setStatus(status) {
            this.status = status
        },
        setHeader(name, value) {
            this.headers[name.toLowerCase()] = value
        },
        setContentType(type) {
            this.headers["content-type"] = type
        },
        write(text) {
            this.body += text
        },
        sendRedirect(url) {
            this.redirect = url
        }
    }
    ec.resource.script("component://mr-mantle/script/PassApi.js").service(request, response)
    return {status: response.status, headers: response.headers, body: JSON.parse(response.body || "null")}
}
spec({
    setupSpec() {
        setProperty("pass_client_" + CLIENT + "_secret", "pass-authority-spec-secret")
        setProperty("pass_client_" + CLIENT + "_sites", SITE)
        login("john.doe")
        sys(() =>
            call("create#mantle.public.PublicSite", {
                siteId: SITE,
                name: SITE,
                state: "published",
                registrationMode: "closed",
                locale: "en",
                timeZone: "UTC",
                policyRevision: 1,
                generation: 1
            })
        )
        logout()
    },
    cleanupSpec() {
        login("john.doe")
    }
})
feature("an operation runs its schema service and a field the schema does not list is the envelope's 422", {
    when() {
        return {
            info: handle({operation: "getSiteInfo"}),
            client: handle({operation: "getSiteInfo", clientId: CLIENT, clientVerified: true, visitorAddress: "203.0.113.9"}),
            extra: handle({operation: "getSiteInfo", input: {bogus: "x"}}),
            otherSite: handle({operation: "getSiteInfo", input: {siteId: "ANOTHER_SITE"}}),
            unrouted: handle({operation: "createSite", input: {name: "No"}}),
            noSite: handle({operation: "getSiteInfo", siteId: ""})
        }
    },
    then({info, client, extra, otherSite, unrouted, noSite}) {
        info.result.site.siteId == SITE
        !info.result.capabilities.canManageSite
        !info.error
        client.result.capabilities != null
        extra.error.code == "Unprocessable"
        extra.error.status == 422
        // the request's own fault names itself (impl-shop P1, F4)
        extra.error.message == "Unsupported request field: bogus"
        extra.error.correlationId.length == 24
        extra.error.fieldErrors.length == 0
        !extra.result
        otherSite.error.status == 422
        // an operator's operation has no route, so no transport reaches it
        unrouted.error.code == "NotFound"
        noSite.error.status == 404
    }
})
feature("a delegation needs a registered client and a good credential, and a write needs a session or a delegation", {
    when() {
        return {
            noClient: handle({operation: "getSiteInfo", delegation: "not-a-credential"}),
            wrongSecret: handle({operation: "getSiteInfo", delegation: "x", clientId: CLIENT, clientSecret: "wrong"}),
            otherSite: handle({
                operation: "getSiteInfo",
                siteId: "ANOTHER_SITE",
                delegation: "x",
                clientId: CLIENT,
                clientVerified: true
            }),
            badCredential: handle({
                operation: "getSiteInfo",
                delegation: "not-a-credential",
                clientId: CLIENT,
                clientVerified: true
            }),
            write: handle({operation: "joinCategory", input: {contactListId: "NONE"}, clientId: CLIENT, clientVerified: true}),
            optOut: handle({operation: "applyOptOut", input: {token: "not-a-token"}})
        }
    },
    then({noClient, wrongSecret, otherSite, badCredential, write, optOut}) {
        noClient.error.code == "AuthenticationRequired"
        noClient.error.status == 401
        wrongSecret.error.status == 401
        // the client is registered for its own sites only
        otherSite.error.status == 401
        badCredential.error.code == "AuthenticationRequired"
        write.error.code == "Unauthorized"
        write.error.status == 403
        // an opt-out takes no session: its service checks the token
        optOut.error.code != "Unauthorized"
    }
})
feature("an account action runs the account service, and a registered client's sign-in gets a working delegation", {
    when() {
        const session = handle({
            operation: "account.session",
            input: {username: "john.doe", password: "moqui"},
            clientId: CLIENT,
            clientVerified: true,
            visitorAddress: "203.0.113.9"
        })
        const credential = session.result?.credential
        const signedIn = handle({operation: "getSiteInfo", delegation: credential, clientId: CLIENT, clientVerified: true})
        const out = handle({operation: "account.logout", delegation: credential, clientId: CLIENT, clientVerified: true})
        const revoked = handle({operation: "getSiteInfo", delegation: credential, clientId: CLIENT, clientVerified: true})
        logout()
        return {
            session,
            credential,
            signedIn,
            out,
            revoked,
            recovery: handle({
                operation: "account.recovery",
                input: {emailAddress: "nobody@example.test"},
                clientId: CLIENT,
                clientVerified: true
            }),
            extraField: handle({
                operation: "account.session",
                input: {username: "x", role: "admin"},
                clientId: CLIENT,
                clientVerified: true
            }),
            unknown: handle({operation: "account.everything", clientId: CLIENT, clientVerified: true}),
            ssoUnregistered: handle({operation: "account.sso-prepare", input: {authFlowId: "X"}, sessionChecked: true}),
            frontChannel: handle({operation: "account.sso", input: {handoffId: "x"}, clientId: CLIENT, clientVerified: true})
        }
    },
    then({session, credential, signedIn, out, revoked, recovery, extraField, unknown, ssoUnregistered, frontChannel}) {
        session.result.authenticated == true
        credential.length == 64
        session.result.subject.handle == "john.doe"
        !signedIn.error
        out.result.authenticated == false
        revoked.error.code == "AuthenticationRequired"
        recovery.result.message.includes("recovery instructions")
        extraField.error.code == "Unprocessable"
        unknown.error.code == "NotFound"
        ssoUnregistered.error.code == "Unauthorized"
        // the SSO front channel is the servlet's redirects only
        frontChannel.error.code == "NotFound"
    }
})
feature("only the authority's call marks its client verified: a flag in an account service's input is not trusted", {
    when() {
        const account = ec.resource.script("component://framework/service/org/moqui/public/Account.js")
        const refusal = input => {
            try {
                account.execute("issueDelegation", {siteId: SITE, clientId: CLIENT, ...input})
                return ""
            } catch (error) {
                return String(error.message)
            } finally {
                ec.message.clearErrors()
            }
        }
        login("john.doe")
        const flagged = refusal({clientVerified: true})
        const secret = refusal({clientSecret: "pass-authority-spec-secret"})
        logout()
        const session = handle({
            operation: "account.session",
            input: {username: "john.doe", password: "moqui"},
            clientId: CLIENT,
            clientVerified: true
        })
        const left = {
            verified: ec.user.context.passVerifiedClient ?? null,
            requester: ec.user.context.passRequester ?? null
        }
        logout()
        return {flagged, secret, session, left}
    },
    then({flagged, secret, session, left}) {
        flagged.includes("Unregistered deployment or site")
        secret == ""
        // in the authority's call the transport's verification is the client's
        session.result.credential.length == 64
        // and nothing of it is left after the call
        left.verified == null
        left.requester == null
    }
})
feature("the servlet answers a route through the authority, and a failure with the envelope and its status", {
    when() {
        return {
            info: servlet("GET", "site"),
            missing: servlet("GET", "no/such/route"),
            unregistered: servlet("GET", "site", {authorization: "Bearer x"}),
            // an empty or malformed bearer is no credential: a write still needs the session token
            emptyBearer: servlet("POST", "categories/NONE/membership", {authorization: "Bearer "}),
            spacedBearer: servlet("POST", "categories/NONE/membership", {authorization: "Bearer a b"})
        }
    },
    then({info, missing, unregistered, emptyBearer, spacedBearer}) {
        info.status == 200
        info.headers["cache-control"] == "no-store"
        info.body.capabilities != null
        missing.status == 404
        missing.body.code == "NotFound"
        missing.body.correlationId.length == 24
        !("status" in missing.body)
        // a credential from no registered deployment
        unregistered.status == 401
        unregistered.body.code == "AuthenticationRequired"
        emptyBearer.status == 403
        emptyBearer.body.code == "Unauthorized"
        spacedBearer.status == 403
    }
})
feature("a refusal's listed reason, its field and the text of a request's own fault go through the envelope; nothing else does", {
    when() {
        const refused = (kind, message) => {
            const e = new Error(message)
            e.moquiErrorKind = kind
            return authority().envelope(e)
        }
        return {
            // a Shop read of a site with no Shop mount, through the authority as a remote frontend calls it
            concealed: handle({operation: "getShopContext", clientId: CLIENT, clientVerified: true}),
            stale: refused("Conflict", "Error: Error: STALE_REVISION: This changed; reload"),
            field: refused("Unprocessable", "TARGET_INVALID[targetId]: Choose the store the shop app serves"),
            unlisted: refused("Unprocessable", "STORE_LIMITED: A store-limited staff member does not start stores"),
            hidden: refused("NotFound", "NOT_AVAILABLE: Store PASS_X of ORG_Y is closed"),
            plain: refused("Unauthorized", "secret detail"),
            // a nested call's failure in the message facade is an Unprocessable too; its text stays in the log
            internal: refused("Unprocessable", "Error creating mantle.order.OrderItem: error returned from database: duplicate key"),
            script: refused("Conflict", "TypeError: cannot read property 'x' of undefined")
        }
    },
    then({concealed, stale, field, unlisted, hidden, plain, internal, script}) {
        concealed.error.code == "NotFound"
        concealed.error.reason == "notAvailable"
        concealed.error.message == "Resource not found"
        stale.reason == "staleRevision"
        stale.message == "This changed; reload"
        field.reason == "targetInvalid"
        field.fieldErrors[0].field == "targetId"
        field.fieldErrors[0].message == "Choose the store the shop app serves"
        unlisted.reason == null
        unlisted.message == "A store-limited staff member does not start stores"
        // a NotFound says nothing beyond its reason
        hidden.reason == "notAvailable"
        !hidden.message.includes("PASS_X")
        plain.reason == null
        plain.message == "Action is not permitted"
        internal.message == "Invalid request fields"
        script.message == "State changed; reload and compare"
    }
})
