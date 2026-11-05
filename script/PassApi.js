/* Restricted public API. No generic service or entity dispatch. CC0 plus patent grant.
   The REST transport of the PASS authority: the client and browser-session checks of HTTP, the SSO front channel's
   redirects, the route to its operation, then PassAuthority.js, which the host's gRPC transport calls too. */
const routes = ec.resource.script('component://mr-mantle/script/PassRoutes.js')
/* Operations a bearer link's token authorizes without a signed-in session; their services check the token. */
const TOKEN_WRITES = [
    'startInvoicePayment',
    'submitSupplierBill',
    // Purchasing P16: a quote's and a purchase order's link
    'saveQuoteResponse',
    'submitQuoteResponse',
    'acknowledgePurchaseOrder',
    'reportDropShipDelivery',
    // Customer Service P13: a feedback invitation's link
    'submitCaseFeedback',
    // Customer Service P15: a queue's form token, a case's CaseView link, an article view's rating nonce and an RMA link
    'createCustomerCase',
    'replyCustomerCase',
    'requestCaseReopen',
    'cancelCustomerCase',
    'rateArticle',
    'addReturnEvidence',
    'withdrawCustomerReturn',
]
const fail = (kind, message) => {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
/* An answer of PassAuthority.handle as HTTP: the error envelope with its status, a file, or JSON. */
function respond(response, answer) {
    if (answer.error) {
        const { status, ...body } = answer.error
        response.setStatus(status)
        response.setContentType('application/json')
        response.setHeader('Cache-Control', 'no-store')
        if (status === 429) response.setHeader('Retry-After', '10')
        response.write(JSON.stringify(body))
        return
    }
    if (answer.download) {
        const file = answer.download
        // the authority checked the asker; the file is read as the authority (a record's content may sit in the database
        // resource store, which the delegated public account may not read itself), before anything is written
        const wasDisabled = ec.artifactExecution.disableAuthz()
        let bytes
        try {
            const stream = ec.resource
                .getLocationReference(file.location)
                .openStream()
            try {
                bytes = stream.readAllBytes()
            } finally {
                stream.close()
            }
        } finally {
            if (!wasDisabled) ec.artifactExecution.enableAuthz()
        }
        response.setContentType(file.contentType)
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader(
            'Content-Disposition',
            file.disposition +
                '; filename="' +
                String(file.filename).replace(/["\\\r\n]/g, '_') +
                '"',
        )
        response.write(bytes)
        return
    }
    response.setContentType('application/json')
    response.write(JSON.stringify(answer.result))
}
;({
    service(request, response) {
        const authority = ec.resource.script(
            'component://mr-mantle/script/PassAuthority.js',
        )
        try {
            const parts = request.requestURI.split('/').filter(Boolean)
            if (
                parts.slice(0, 6).join('/') !==
                'rest/s1/pass/v1/sites/' + parts[5]
            ) {
                fail('NotFound', 'Resource not found')
            }
            const siteId = parts[5],
                path = parts.slice(6),
                method = request.method.toUpperCase()
            // the delegated credential: one token after "Bearer "; an empty or malformed one is none, so it skips no check
            const bearer =
                    (/^Bearer (\S+)$/.exec(
                        request.getHeader('authorization') || '',
                    ) || [])[1] || '',
                clientId = request.getHeader('x-pass-client') || '',
                clientSecret = request.getHeader('x-pass-client-secret') || ''
            const account = ec.resource.script(
                'component://framework/service/org/moqui/public/Account.js',
            )
            const registeredClient = account.clientRegistered(
                clientId,
                clientSecret,
                siteId,
            )
            // A credential is only good from the deployment it was issued to; PassAuthority checks the credential.
            if (bearer && !registeredClient)
                fail('AuthenticationRequired', 'Registered client required')
            // A write a bearer link's token authorizes (a payment, a supplier's bill) comes from the registered
            // deployment that served the link's page, with no session of its own.
            const tokenWrite =
                registeredClient &&
                routes.some(
                    ([verb, pattern, op]) =>
                        TOKEN_WRITES.includes(op) &&
                        verb === method &&
                        pattern.split('/').length === path.length &&
                        pattern
                            .split('/')
                            .every(
                                (part, i) =>
                                    part.startsWith('{') || part === path[i],
                            ),
                )
            if (
                !['GET', 'HEAD'].includes(method) &&
                !(path[0] === 'account' && registeredClient) &&
                !(path.join('/') === 'opt-out' && method === 'POST') &&
                !tokenWrite &&
                !bearer &&
                request.getHeader('x-csrf-token') !== ec.web.sessionToken
            )
                fail('Unauthorized', 'Invalid session token')
            response.setHeader('Cache-Control', 'no-store')
            response.setHeader('X-Content-Type-Options', 'nosniff')
            const raw = { ...request.getParameterMap() }
            if (raw._requestBodyJsonParseError || raw._requestBodyJsonList)
                fail('Unprocessable', 'JSON object required')
            delete raw.moquiSessionToken
            delete raw._requestBodyText
            delete raw._fileUploadList
            const call = {
                siteId,
                delegation: bearer,
                clientId,
                clientSecret,
                visitorAddress: request.getHeader('x-pass-client-ip') || '',
                sessionChecked: true,
            }
            if (path[0] === 'account') {
                if (['sso', 'sso-complete'].includes(path[1])) {
                    // The SSO front channel: the browser is redirected to the provider and back here.
                    if (method !== 'GET')
                        fail(
                            'Unauthorized',
                            'Registered sign-in client required',
                        )
                    if (Object.keys(raw).some((k) => k !== 'handoffId'))
                        fail('Unprocessable', 'Unsupported sign-in field')
                    const action = path[1] === 'sso' ? 'start' : 'complete'
                    if (
                        action === 'complete' &&
                        !ec.user.userId &&
                        ec.web.sessionAttributes.moquiPreAuthcUsername
                    ) {
                        response.sendRedirect(
                            '/Login?returnTo=' +
                                encodeURIComponent(
                                    request.requestURI +
                                        '?handoffId=' +
                                        encodeURIComponent(raw.handoffId),
                                ),
                        )
                        return
                    }
                    const result = ec.service
                        .sync()
                        .throwOnError(true)
                        .name(
                            'org.moqui.public.AccountServices.' +
                                action +
                                '#Sso',
                        )
                        .parameters({
                            input: { ...raw, siteId, clientId, clientSecret },
                        })
                        .call().result
                    if (result.redirectUrl)
                        response.sendRedirect(result.redirectUrl)
                    return
                }
                if (authority.SSO_ACTIONS[path[1]]) {
                    if (method !== 'POST' || !registeredClient)
                        fail(
                            'Unauthorized',
                            'Registered sign-in client required',
                        )
                } else if (
                    method !== 'POST' ||
                    !authority.ACCOUNT_ACTIONS[path[1]]
                ) {
                    fail('NotFound', 'Resource not found')
                }
                respond(
                    response,
                    authority.handle({
                        ...call,
                        operation: 'account.' + path[1],
                        input: raw,
                    }),
                )
                return
            }
            for (const [verb, pattern, op] of routes) {
                const expected = pattern.split('/')
                if (verb !== method || expected.length !== path.length) continue
                const ids = {}
                let matches = true
                for (let i = 0; i < expected.length; i++) {
                    if (expected[i].startsWith('{'))
                        try {
                            ids[expected[i].slice(1, -1)] = decodeURIComponent(
                                path[i],
                            )
                        } catch (e) {
                            fail('NotFound', 'Resource not found')
                        }
                    else if (expected[i] !== path[i]) matches = false
                }
                if (!matches) continue
                respond(
                    response,
                    authority.handle({
                        ...call,
                        operation: op,
                        input: { ...raw, ...ids },
                        file: ec.web.multiPartParameters.file,
                    }),
                )
                return
            }
            fail('NotFound', 'Resource not found')
        } catch (error) {
            respond(response, { error: authority.envelope(error) })
        }
    },
})
