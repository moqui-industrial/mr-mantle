/* The PASS authority's operations after the transport's own checks (mr-moqui plans/Edge-Node.md §5.5): one function
   for the REST servlet (PassApi.js) and the host's PassAuthority gRPC service (PassAuthorityServices.handle#Call).
   Restricted public API: no generic service or entity dispatch. CC0 plus patent grant. */
const routes = ec.resource.script('component://mr-mantle/script/PassRoutes.js')
const schema = ec.resource.script(
    'component://mr-mantle/service/mantle/forum/ForumSchema.js',
)
/* Operations a bearer link's token authorizes without a signed-in session; their services check the token. */
const TOKEN_WRITES = [
    'startInvoicePayment',
    'submitSupplierBill',
    // Purchasing P16: a quote's and a purchase order's link
    'saveQuoteResponse',
    'submitQuoteResponse',
    'acknowledgePurchaseOrder',
    'reportDropShipDelivery',
]
/* account.<action>: the framework's account service verb of each. */
const ACCOUNT_ACTIONS = {
    session: 'start',
    challenge: 'complete',
    registration: 'begin',
    verification: 'verify',
    recovery: 'request',
    logout: 'end',
    security: 'manage',
}
const ACCOUNT_FIELDS = [
    'username',
    'password',
    'code',
    'emailAddress',
    'token',
    'action',
    'oldPassword',
    'newPassword',
    'newPasswordVerify',
    'visitId',
    'invitationToken',
]
/* The SSO back channel; its front channel (sso, sso-complete) is browser redirects, which only the servlet serves. */
const SSO_ACTIONS = { 'sso-prepare': 'prepare', 'sso-exchange': 'exchange' }
const SSO_FIELDS = ['handoffId', 'authFlowId', 'state', 'code', 'verifier']
const STATUS = {
    AuthenticationRequired: 401,
    Unauthorized: 403,
    NotFound: 404,
    Conflict: 409,
    Unprocessable: 422,
    Tarpit: 429,
    MethodNotAllowed: 405,
}
const MESSAGES = {
    401: 'Sign in to continue',
    403: 'Action is not permitted',
    404: 'Resource not found',
    409: 'State changed; reload and compare',
    422: 'Invalid request fields',
    429: 'Too many requests',
}
const fail = (kind, message) => {
    const e = new Error(message)
    e.moquiErrorKind = kind
    throw e
}
const account = () =>
    ec.resource.script(
        'component://framework/service/org/moqui/public/Account.js',
    )
function asSystem(work) {
    const was = ec.artifactExecution.disableAuthz()
    try {
        return work()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const callService = (name, input) =>
    ec.service.sync().throwOnError(true).name(name).parameters({ input }).call()
        .result
/* The error envelope of a failure, logged under a correlation id; the detail stays in the log. */
function envelope(error) {
    const kind = error?.moquiErrorKind || 'Unavailable'
    const status = STATUS[kind] || 503
    const correlationId = ec.user.randomString(24)
    ec.logger.warn(
        'PASS request ' +
            correlationId +
            ' failed (' +
            kind +
            '): ' +
            String(error?.message || 'Request failed').split('\n')[0],
    )
    ec.message.clearErrors()
    return {
        code: kind,
        message: MESSAGES[status] || 'Authority temporarily unavailable',
        fieldErrors: [],
        correlationId,
        status,
    }
}
/* One operation. p: {operation, siteId, input, delegation (the bearer credential), clientId, clientSecret,
   clientVerified (the transport authenticated the client: the gRPC listener's secret or the edge link), visitorAddress
   (rate limits only), file (an upload), sessionChecked (the servlet checked the browser session's CSRF token)}.
   Answers {result} (with download: {location, contentType, filename, disposition} for a file) or {error}. */
function handle(p) {
    // what the framework's Account.js reads of this call, set only here and only for its length: the requester's rate
    // limit key, and the client the transport authenticated (never a flag in a service's input)
    ec.user.context.remove('passRequester')
    ec.user.context.remove('passVerifiedClient')
    try {
        return run(p || {})
    } catch (error) {
        return { error: envelope(error) }
    } finally {
        ec.user.context.remove('passRequester')
        ec.user.context.remove('passVerifiedClient')
    }
}
function run(p) {
    const operation = String(p.operation || ''),
        siteId = String(p.siteId || ''),
        clientId = String(p.clientId || ''),
        input = { ...(p.input || {}) }
    if (!siteId) fail('NotFound', 'Resource not found')
    const registered =
        !!clientId &&
        account().clientRegistered(
            clientId,
            p.clientSecret || '',
            siteId,
            p.clientVerified === true,
        )
    if (registered && p.clientVerified === true)
        ec.user.context.passVerifiedClient = clientId
    // A registered deployment names its browser's address, for the account rate limits only.
    if (registered && (p.visitorAddress || !ec.web?.request))
        ec.user.context.passRequester =
            'client:' +
            clientId +
            ':' +
            String(p.visitorAddress || '').slice(0, 64)
    let delegation = null
    if (p.delegation) {
        // A credential is only good from the deployment it was issued to.
        if (!registered)
            fail('AuthenticationRequired', 'Registered client required')
        delegation = asSystem(() =>
            account().authenticateDelegation(p.delegation, clientId, siteId),
        )
    }
    const action = operation.startsWith('account.') ? operation.slice(8) : null
    const route =
        action == null ? routes.find(([, , op]) => op === operation) : null
    // A write needs the visitor's session: the servlet's CSRF check, a delegation, or a write a registered deployment
    // makes with none (an account action, an opt-out, a bearer link's token).
    if (!p.sessionChecked) {
        const write = action != null || (route && route[0] !== 'GET')
        if (
            write &&
            !(action != null && registered) &&
            operation !== 'applyOptOut' &&
            !(registered && TOKEN_WRITES.includes(operation)) &&
            !delegation
        )
            fail('Unauthorized', 'Invalid session token')
    }
    if (action != null)
        return accountAction(action, p, input, siteId, registered, delegation)
    if (!route || !schema[operation]) fail('NotFound', 'Resource not found')
    const def = schema[operation]
    // the file comes as p.file: the servlet's multipart part, or the gRPC upload
    if (def.fields.includes('file')) delete input.file
    if (input.siteId != null && input.siteId !== '' && input.siteId !== siteId)
        fail('Unprocessable', 'Unsupported request field: siteId')
    const full = { ...input, siteId }
    const unsupported = Object.keys(full).filter((k) => !def.fields.includes(k))
    if (unsupported.length)
        fail(
            'Unprocessable',
            'Unsupported request field: ' + unsupported.join(',').slice(0, 120),
        )
    if (def.fields.includes('file')) full.file = p.file
    const result = callService(def.service, full)
    if (operation === 'getAttachment' || operation === 'getExport') {
        const file = result.attachment || result.export
        // the file's place stays here; the transport streams it
        const { location, ...shown } = result
        return {
            result: shown,
            download: {
                location,
                contentType: file.mimeType,
                filename: String(file.filename),
                disposition:
                    file.variant === 'thumbnail' ? 'inline' : 'attachment',
            },
        }
    }
    return { result }
}
function accountAction(action, p, raw, siteId, registered, delegation) {
    if (SSO_ACTIONS[action]) {
        if (!registered)
            fail('Unauthorized', 'Registered sign-in client required')
        if (Object.keys(raw).some((k) => !SSO_FIELDS.includes(k)))
            fail('Unprocessable', 'Unsupported sign-in field')
        return {
            result: callService(
                'org.moqui.public.AccountServices.' +
                    SSO_ACTIONS[action] +
                    '#Sso',
                {
                    ...raw,
                    siteId,
                    clientId: p.clientId,
                    clientSecret: p.clientSecret,
                },
            ),
        }
    }
    if (!ACCOUNT_ACTIONS[action]) fail('NotFound', 'Resource not found')
    if (Object.keys(raw).some((k) => !ACCOUNT_FIELDS.includes(k)))
        fail('Unprocessable', 'Unsupported account field')
    return asSystem(() => {
        if (action === 'registration') {
            const s = ec.entity
                .find('mantle.public.PublicSite')
                .condition('siteId', siteId)
                .one()
            if (!s || s.state !== 'published')
                fail('Unauthorized', 'Registration is closed')
            if (s.registrationMode !== 'open') {
                if (s.registrationMode !== 'invitation' || !raw.invitationToken)
                    fail('Unauthorized', 'Registration is closed')
                callService('mantle.public.SiteServices.inspect#Invitation', {
                    siteId,
                    token: raw.invitationToken,
                    emailAddress: raw.emailAddress,
                })
            }
        }
        if (action === 'logout' && delegation) {
            delegation.set('revokedAt', ec.user.nowTimestamp)
            delegation.update()
        }
        const noun = ['registration', 'verification'].includes(action)
            ? 'Registration'
            : action === 'recovery'
              ? 'Recovery'
              : action === 'security'
                ? 'Account'
                : 'Session'
        let result = callService(
            'org.moqui.public.AccountServices.' +
                ACCOUNT_ACTIONS[action] +
                '#' +
                noun,
            raw,
        )
        if (result.authenticated && p.clientId)
            result = {
                ...result,
                ...callService(
                    'org.moqui.public.AccountServices.issue#Delegation',
                    {
                        siteId,
                        clientId: p.clientId,
                        clientSecret: p.clientSecret || '',
                    },
                ),
            }
        return { result }
    })
}
;({ handle, envelope, ACCOUNT_ACTIONS, SSO_ACTIONS })
