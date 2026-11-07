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
    // Shop P1: none yet; P4 adds the cart writes
    // Shop P4: a cart's writes, authorized by the session's cart capability (input.token); the first add makes the cart
    // with no capability yet (impl-shop F44: an anonymous write, as applyOptOut is), its creations rate limited by the
    // requester
    'addCartItem',
    'updateCartItem',
    'removeCartItem',
    'applyPromoCode',
    'removePromoCode',
    // Shop P5: the checkout's writes and its capability reads (POSTs, F75), authorized by the session's cart capability
    // (input.token), the checkout's reference and key (a provider's return, a refreshed frontend) or a guest's order link;
    // getCart with them
    'getCart',
    'beginCheckout',
    'getCheckout',
    'resumeCheckout',
    'setCheckoutContact',
    'setCheckoutAddresses',
    'getDeliveryOptions',
    'selectDelivery',
    'getPaymentOptions',
    'selectPayment',
    'submitCheckout',
    'getCheckoutPaymentResult',
    'getCheckoutPaymentForm',
    'getOrderConfirmation',
    // Shop P6: reads and writes a guest's order link (orderToken) or a list link's token (email preferences) authorizes,
    // and the Support operations an order link admits (F27); the Support reads with a capability are POSTs (F75)
    'findShopOrders',
    'getShopOrder',
    'getShopOrderDocument',
    'getDownloads',
    'issueDownload',
    'getEmailPreferences',
    'storeEmailPreferences',
    'applyOneClickUnsubscribe',
    'getCaseIntake',
    'getReturnableOrder',
    'requestCustomerReturn',
    'requestOrderCancel',
    // Commerce P10: a cart recovery link's one-time token (input.token); the authority asks a visitor to sign in first
    'recoverCart',
]
const fail = (kind, message) => {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
/* A ranged file (Shop P6, a granted download): Accept-Ranges, a 206 of the range asked or a 416 outside the file, the bytes
   read as the authority (the file may sit in the database resource store). */
function streamRanged(response, file) {
    const range = file.range
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader(
        'Content-Disposition',
        'attachment; filename="' + String(file.filename).replace(/["\\\r\n]/g, '_') + '"',
    )
    if (range && range.unsatisfiable) {
        response.setStatus(416)
        response.setHeader('Content-Range', 'bytes */' + file.size)
        return
    }
    const start = range ? range.start : 0
    const end = range ? range.end : file.size - 1
    if (range) {
        response.setStatus(206)
        response.setHeader('Content-Range', 'bytes ' + start + '-' + end + '/' + file.size)
    }
    response.setContentType(file.contentType)
    const wasDisabled = ec.artifactExecution.disableAuthz()
    try {
        // the framework's resource stream reads whole (no partial read, impl-shop F-SP6), so the range is cut from it
        const stream = ec.resource.getLocationReference(file.location).openStream()
        try {
            const bytes = stream.readAllBytes()
            response.write(start === 0 && end === file.size - 1 ? bytes : bytes.slice(start, end + 1))
        } finally {
            stream.close()
        }
    } finally {
        if (!wasDisabled) ec.artifactExecution.enableAuthz()
    }
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
    if (answer.download && answer.download.size != null) {
        // Shop P6: a granted download, streamed in pieces with its byte range (206, or 416 outside the file)
        streamRanged(response, answer.download)
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
        // Shop P8 (F75): a public product image of the current generation is the one file a shared cache may keep
        response.setHeader('Cache-Control', file.cacheControl || 'no-store')
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
    // Shop P4: the list PassAuthority.js and PASS's Transport.js keep equal
    TOKEN_WRITES,
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
