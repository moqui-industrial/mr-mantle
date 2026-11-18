// PASS Marketing's public subscription (impl-marketing P7, F43; design-marketing §13 Subscribe and VerifySubscription;
// mantle.marketing.MarketingPortalServices over MarketingPortal.js, filing through MarketingAudiences.js fileOne): a request answers
// the same receipt for a known and a new address and echoes neither; its verification message carries a link whose GET changes
// nothing; the confirmation grants only the requested topic for that address; a replay answers the first result and, after a
// withdrawal, regrants nothing, and a withdrawal before the confirmation is not undone by it; a forged, expired or another site's
// token, a site without the mount and a list it does not offer disclose nothing. Standalone: spec-local organizations, sites,
// lists, relay, profile and confirmation template.
// Run: ./moq test mr-mantle --spec MarketingSubscriptions (Subscriptions is Shop's subscriptions spec)
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization} = lib
const capture = ec.factory.getTool("MailCapture")
const P = "mantle.marketing.MarketingPortalServices."
const CLP = "mantle.marketing.contact.ContactListParty"
const prefix = "MKP"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const site = prefix + "_SITE",
    siteNone = prefix + "_SITE_NONE",
    siteB = prefix + "_SITE_B"
const list = {garden: prefix + "_GARDEN", kitchen: prefix + "_KITCHEN", hidden: prefix + "_HIDDEN", closed: prefix + "_CLOSED"}
const maya = {partyId: prefix + "_MAYA", address: "maya.mkp@example.test", mechId: prefix + "_MAYA_EM"}
const run = Date.now().toString(36)
const fresh = name => name + "." + run + "@example.test"
const dayMs = 86400000
const shared = {}

// a PASS operation as a visitor, as pass.Facade calls it: its result, or the error's kind and message
function page(verb, input, siteId = site) {
    logout()
    ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        return ec.service
            .sync()
            .throwOnError(true)
            .name(P + verb)
            .parameters({input: Object.assign({siteId}, input)})
            .requireNewTransaction(true)
            .call().result
    } catch (error) {
        return {kind: error.moquiErrorKind || "Error", error: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        login("john.doe")
    }
}
const key = () => "mkp" + ec.user.randomString(16).replace(/[^A-Za-z0-9]/g, "")
const requestOf = (emailAddress, contactListIds) =>
    page("request#Subscription", {emailAddress, contactListIds, consent: "Y", operationId: key()})
// the verification is attempted on a service worker once the request commits (P7 review): wait for it
const settle = () => ec.factory.waitWorkerPoolEmpty(50)
const mailsTo = address => (
    settle(), Array.from(capture.getMessages()).filter(m => Array.from(m.toList || []).includes(address)).length
)
// the link of the newest captured message to an address
function tokenTo(address) {
    settle()
    const message = Array.from(capture.getMessages())
        .reverse()
        .find(m => Array.from(m.toList || []).includes(address))
    const found = /VerifySubscription\?token=([A-Za-z0-9_-]+)/.exec(String(message?.body || ""))
    return found ? found[1] : null
}
const statusOf = (contactListId, partyId) =>
    rows(CLP, {contactListId, partyId}).sort((a, b) => Number(b.fromDate) - Number(a.fromDate))[0]?.statusId ?? null
const grants = (contactListId, partyId) =>
    rows("mantle.party.PartyConsent", {contactListId, partyId}).filter(r => r.statusId === "PconGranted")
const partyOf = address =>
    rows("mantle.party.contact.PartyContactMechInfo", {contactMechTypeEnumId: "CmtEmailAddress"}).find(
        info => String(info.infoString).toLowerCase() === address
    )?.partyId || null

spec({
    stepwise: true,
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Subscriptions A")
            organization(orgB, "Subscriptions B")
            for (const [siteId, target] of [
                [site, orgA],
                [siteNone, null],
                [siteB, orgB]
            ]) {
                make("mantle.public.PublicSite", {
                    siteId,
                    name: "Subscriptions " + siteId,
                    state: "published",
                    registrationMode: "closed",
                    locale: "en",
                    timeZone: "UTC",
                    policyRevision: 1,
                    generation: 1
                })
                make("mantle.public.PublicSiteHost", {hostname: siteId.toLowerCase() + ".example.test", siteId, canonical: "Y"})
                if (target)
                    make("mantle.public.PublicSiteApp", {
                        siteId,
                        appMountId: "marketing",
                        app: "marketing",
                        pathPrefix: "/marketing",
                        enabled: "Y",
                        targetId: target
                    })
            }
            // the confirmation template (Comms') and a ready transactional profile of A
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_RELAY",
                smtpHost: "relay.mkp.example.test",
                smtpPort: "9"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: prefix + "_CONFIRM",
                emailServerId: prefix + "_RELAY",
                fromAddress: "hello@mkp.example.test",
                subject: ""
            })
            make("mantle.party.MessageTemplate", {
                messageTemplateId: prefix + "_CONFIRM",
                organizationPartyId: orgA,
                templateName: "Subscription confirmation",
                channelEnumId: "MdcEmail",
                purposeEnumId: "MtpTransactional",
                localeId: "en",
                emailTemplateId: prefix + "_CONFIRM",
                fromDate: new Date(Date.now() - 30 * dayMs)
            })
            make("mantle.party.MessageTemplateContent", {
                messageTemplateId: prefix + "_CONFIRM",
                contentSeqId: "001",
                subject: "Please confirm your subscription",
                bodyLocation: "component://mr-mantle/test/marketing/SubscriptionConfirmation.html.fancy-locked",
                variablesJson: JSON.stringify([
                    {name: "firstName", label: "First name", fallback: "there", required: false},
                    {name: "listName", label: "List", fallback: "our news", required: false}
                ]),
                fromDate: new Date(Date.now() - 20 * dayMs)
            })
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_BOUNCES",
                accountKindEnumId: "EakHosted",
                emailAddress: "bounces@bounce.mkp.example.test",
                statusId: "EasActive"
            })
            make("mantle.party.MessageSendingProfile", {
                sendingProfileId: prefix + "_PROFILE",
                organizationPartyId: orgA,
                profileName: "A notices",
                channelEnumId: "MdcEmail",
                emailServerId: prefix + "_RELAY",
                fromAddress: "hello@mkp.example.test",
                purposeEnumId: "MtpTransactional",
                trackingPolicyEnumId: "MtrNone",
                bounceDomain: "bounce.mkp.example.test",
                fromDate: new Date(Date.now() - 30 * dayMs)
            })
            // two offered lists, one public by the legacy flag only, one whose offer closed
            const lists = [
                [list.garden, "Garden news", {publicOffer: "Y", publicSiteId: site}],
                [list.kitchen, "Kitchen news", {publicOffer: "Y", publicSiteId: site}],
                [list.hidden, "Hidden news", {publicOffer: "N"}],
                [list.closed, "Closed news", {publicOffer: "Y", publicSiteId: site, offerThruDate: new Date(Date.now() - dayMs)}]
            ]
            for (const [contactListId, contactListName, offer] of lists) {
                make("mantle.marketing.contact.ContactList", {
                    contactListId,
                    contactListName,
                    contactListTypeEnumId: "NEWSLETTER",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    ownerPartyId: orgA,
                    isPublic: "Y"
                })
                make(
                    "mantle.marketing.contact.ContactListPolicy",
                    Object.assign(
                        {
                            contactListId,
                            fromDate: new Date(Date.now() - 10 * dayMs),
                            confirmationRequired: "Y",
                            purposeEnumId: "PcpMarketingEmail",
                            evidenceText: "Yes, send me " + contactListName,
                            confirmEmailTemplateId: prefix + "_CONFIRM"
                        },
                        offer
                    )
                )
            }
            // a known person with the address
            make("mantle.party.Party", {partyId: maya.partyId, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: maya.partyId, firstName: "Maya", lastName: "Subscriptions"})
            make("mantle.party.contact.ContactMech", {
                contactMechId: maya.mechId,
                contactMechTypeEnumId: "CmtEmailAddress",
                infoString: maya.address
            })
            make("mantle.party.contact.PartyContactMech", {
                partyId: maya.partyId,
                contactMechId: maya.mechId,
                contactMechPurposeId: "EmailPrimary",
                fromDate: new Date(Date.now() - 30 * dayMs)
            })
        })
    },
    cleanupSpec() {
        capture.reset()
        login("john.doe")
    }
})

feature("the same receipt for a known and a new address; a GET changes nothing; a confirm grants only the requested topic", {
    when() {
        capture.clear()
        const newcomer = fresh("newcomer")
        const known = requestOf(maya.address, [list.garden])
        const unknown = requestOf(newcomer, [list.garden, list.kitchen])
        const token = tokenTo(maya.address)
        shared.token = token
        shared.newcomer = newcomer
        const view = page("get#SubscriptionRequest", {token})
        const viewAgain = page("get#SubscriptionRequest", {token})
        const afterGet = {status: statusOf(list.garden, maya.partyId), grants: grants(list.garden, maya.partyId).length}
        const confirmed = page("verify#Subscription", {token, operationId: key()})
        const grant = grants(list.garden, maya.partyId)[0] || {}
        settle()
        return {
            known,
            unknown,
            mails: capture.count(),
            token,
            view,
            viewAgain,
            afterGet,
            confirmed,
            garden: statusOf(list.garden, maya.partyId),
            kitchen: statusOf(list.kitchen, maya.partyId),
            grant,
            newParty: partyOf(newcomer),
            json: JSON.stringify([known, unknown, view, confirmed])
        }
    },
    then(r) {
        r.known.receipt.message === r.unknown.receipt.message
        r.known.receipt.message.length > 20
        r.mails === 2
        r.token != null
        r.view.maskedAddress === "m***@example.test"
        r.view.topics.map(t => t.name).join() === "Garden news"
        r.view.state === "pending"
        r.viewAgain.state === "pending"
        r.afterGet.status === "CLPT_PENDING"
        r.afterGet.grants === 0
        r.confirmed.state === "confirmed"
        r.garden === "CLPT_ACCEPTED"
        r.kitchen === null
        r.grant.contactMechId === maya.mechId
        r.grant.sourceEnumId === "PcsEmailLink"
        r.newParty != null && r.newParty !== maya.partyId
        statusOf(list.garden, r.newParty) === "CLPT_PENDING"
        statusOf(list.kitchen, r.newParty) === "CLPT_PENDING"
        !r.json.includes(maya.address) && !r.json.includes(shared.newcomer)
    }
})

feature("a replay answers the first result; after a withdrawal it regrants nothing; a withdrawal before the confirm is kept", {
    when() {
        const replay = page("verify#Subscription", {token: shared.token, operationId: key()})
        const grantsAfterReplay = grants(list.garden, maya.partyId).length
        system(() =>
            lib.run("mantle.party.ConsentServices.unsubscribe#ContactListParty", {
                contactListId: list.garden,
                partyId: maya.partyId,
                confirmed: true,
                reasonText: "Too frequent"
            })
        )
        const afterWithdrawal = page("verify#Subscription", {token: shared.token, operationId: key()})
        // the newcomer withdraws Kitchen before confirming: the confirmation leaves it withdrawn and accepts Garden
        const newParty = partyOf(shared.newcomer)
        system(() =>
            lib.run("mantle.party.ConsentServices.set#ContactListPartySubscription", {
                contactListId: list.kitchen,
                partyId: newParty,
                subscribe: false,
                sourceEnumId: "PcsStaff",
                evidenceText: "Asked not to get it",
                confirmed: true
            })
        )
        const newToken = tokenTo(shared.newcomer)
        const newConfirm = page("verify#Subscription", {token: newToken, operationId: key()})
        return {
            replay,
            grantsAfterReplay,
            afterWithdrawal,
            gardenAfter: statusOf(list.garden, maya.partyId),
            grantsAfter: grants(list.garden, maya.partyId).length,
            newParty,
            newConfirm
        }
    },
    then(r) {
        r.replay.state === "confirmed"
        r.grantsAfterReplay === 1
        r.afterWithdrawal.state === "confirmed"
        r.gardenAfter === "CLPT_UNSUBSCRIBED"
        r.grantsAfter === 1
        statusOf(list.garden, r.newParty) === "CLPT_ACCEPTED"
        statusOf(list.kitchen, r.newParty) === "CLPT_UNSUBSCRIBED"
        grants(list.kitchen, r.newParty).length === 0
    }
})

feature("a forged, expired or another site's token, a site without the mount and a list not offered disclose nothing", {
    when() {
        capture.clear()
        const address = fresh("expiring")
        requestOf(address, [list.kitchen])
        const token = tokenTo(address)
        const otherSite = page("get#SubscriptionRequest", {token}, siteB)
        const group = rows("mantle.marketing.contact.SubscriptionRequest", {partyId: partyOf(address)})[0]?.requestGroupId
        system(() => {
            for (const r of rows("mantle.marketing.contact.SubscriptionRequest", {requestGroupId: group}))
                lib.run("update#mantle.marketing.contact.SubscriptionRequest", {
                    subscriptionRequestId: r.subscriptionRequestId,
                    expireDate: new Date(Date.now() - 1000)
                })
        })
        return {
            forged: page("get#SubscriptionRequest", {token: "x".repeat(40)}),
            forgedVerify: page("verify#Subscription", {token: "y".repeat(40), operationId: key()}),
            otherSite,
            expired: page("get#SubscriptionRequest", {token}),
            expiredVerify: page("verify#Subscription", {token, operationId: key()}),
            noMount: page("get#Publication", {}, siteNone),
            noMountRequest: page(
                "request#Subscription",
                {
                    emailAddress: fresh("nomount"),
                    contactListIds: [list.garden],
                    consent: "Y",
                    operationId: key()
                },
                siteNone
            ),
            published: page("get#Publication", {}),
            hidden: requestOf(fresh("hidden"), [list.hidden]),
            closed: requestOf(fresh("closed"), [list.closed]),
            closedRead: page("get#Publication", {contactListId: list.closed}),
            otherOrgList: page("get#Publication", {contactListId: list.garden}, siteB),
            noBox: page("request#Subscription", {
                emailAddress: fresh("nobox"),
                contactListIds: [list.garden],
                operationId: key()
            }),
            // P7 review: a verification is transactional; with only a promotional profile ready the request is kept, nothing is
            // sent and the readiness names the missing profile
            promotional: (() => {
                const profile = purposeEnumId =>
                    system(() =>
                        lib.run("update#mantle.party.MessageSendingProfile", {
                            sendingProfileId: prefix + "_PROFILE",
                            purposeEnumId
                        })
                    )
                profile("MtpPromotional")
                try {
                    const address = fresh("promotional")
                    const receipt = requestOf(address, [list.garden])
                    const readiness = system(
                        () =>
                            lib.run(P + "check#MarketingAppReadiness", {input: {siteId: site, targetId: orgA, app: "marketing"}})
                                .result
                    )
                    return {
                        receipt,
                        mails: mailsTo(address),
                        requests: rows("mantle.marketing.contact.SubscriptionRequest", {partyId: partyOf(address)}),
                        profileReady: readiness.checks.find(c => c.name === "transactional sending profile")?.ready
                    }
                } finally {
                    profile("MtpTransactional")
                }
            })()
        }
    },
    then(r) {
        r.forged.kind === "NotFound"
        r.forgedVerify.kind === "NotFound"
        r.otherSite.kind === "NotFound"
        r.expired.kind === "NotFound"
        r.expiredVerify.kind === "NotFound"
        r.noMount.kind === "NotFound"
        r.noMountRequest.kind === "NotFound"
        r.published.topics.map(t => t.name).join() === "Garden news,Kitchen news"
        r.hidden.kind === "NotFound"
        r.closed.kind === "NotFound"
        r.closedRead.kind === "NotFound"
        r.otherOrgList.kind === "NotFound"
        r.noBox.kind === "Unprocessable"
        r.forged.error.split("\n")[0] === r.expired.error.split("\n")[0]
        r.promotional.receipt.receipt.message.length > 20
        r.promotional.mails === 0
        r.promotional.requests.length === 1
        r.promotional.requests[0].statusEnumId === "SrsPending" && r.promotional.requests[0].verificationDeliveryId == null
        r.promotional.profileReady === false
    }
})

feature("a checkout's store-news choice is a request of the audience: pending at placement, accepted by its confirmation", {
    when() {
        const buyer = prefix + "_BUYER"
        system(() => {
            make("mantle.product.store.ProductStore", {
                productStoreId: prefix + "_STORE",
                storeName: "Subscriptions store",
                organizationPartyId: orgA
            })
            make("mantle.product.store.ProductStoreSetting", {
                productStoreId: prefix + "_STORE",
                settingTypeEnumId: "PsstNewsList",
                fromDate: new Date(Date.now() - dayMs),
                settingValue: list.kitchen
            })
            make("mantle.party.Party", {partyId: buyer, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.contact.ContactMech", {
                contactMechId: buyer + "_EM",
                contactMechTypeEnumId: "CmtEmailAddress",
                infoString: fresh("buyer")
            })
            make("mantle.party.contact.PartyContactMech", {
                partyId: buyer,
                contactMechId: buyer + "_EM",
                contactMechPurposeId: "EmailPrimary",
                fromDate: new Date(Date.now() - dayMs)
            })
        })
        const apply = mode =>
            system(
                () =>
                    lib.run("mantle.public.AccountHubServices.apply#CheckoutOptIn", {
                        optInId: "news",
                        mode,
                        partyId: buyer,
                        productStoreId: prefix + "_STORE",
                        contactMechId: buyer + "_EM",
                        sourceEnumId: "PcsForm",
                        evidenceText: "Checkout of order X: news",
                        requirePending: mode === "grant"
                    }).outcome
            )
        const pend = apply("pend")
        const pendingStatus = statusOf(list.kitchen, buyer)
        const grant = apply("grant")
        const requests = rows("mantle.marketing.contact.SubscriptionRequest", {partyId: buyer, contactListId: list.kitchen})
        return {
            pend,
            pendingStatus,
            grant,
            status: statusOf(list.kitchen, buyer),
            requests,
            grant0: grants(list.kitchen, buyer)[0] || {}
        }
    },
    then(r) {
        r.pend === "pending"
        r.pendingStatus === "CLPT_PENDING"
        r.grant === "granted"
        r.status === "CLPT_ACCEPTED"
        r.requests.length === 2
        r.requests.every(q => q.requestKindEnumId === "SrkCheckout" && q.sourceEnumId === "PcsCheckout")
        r.requests
            .map(q => q.statusEnumId)
            .sort()
            .join() === "SrsAccepted,SrsPending"
        r.grant0.sourceEnumId === "PcsCheckout"
    }
})

feature(
    "the preferences page's Marketing context: the offered lists with their state; off keeps the reason; a link turns on only its own undo, which asks to confirm (SEC-PSS-44)",
    {
        when() {
            // the turning on is evidence of now, later than feature two's withdrawal (the spec's clock moves on)
            ec.user.setEffectiveTime(Date.now() + 1000)
            const partyId = partyOf(shared.newcomer)
            const token = system(
                () =>
                    lib.run("mantle.party.ConsentServices.create#UnsubscribeToken", {
                        contactListId: list.garden,
                        partyId,
                        siteId: site
                    }).token
            )
            const H = "mantle.public.AccountHubServices."
            const hub = (verb, input) => {
                logout()
                try {
                    return lib.run(H + verb, {input: Object.assign({siteId: site, token}, input)}).result
                } finally {
                    login("john.doe")
                }
            }
            const shown = hub("get#EmailPreferences", {})
            capture.clear()
            const stored = hub("store#EmailPreferences", {
                choices: JSON.stringify({
                    marketing: {topics: {[list.garden]: false, [list.kitchen]: true}, reason: "tooFrequent"}
                })
            })
            const withdrawal = rows("mantle.party.PartyConsent", {partyId, contactListId: list.garden}).find(
                r => r.statusId === "PconWithdrawn"
            )
            const gardenAfter = statusOf(list.garden, partyId)
            const kitchenAfter = statusOf(list.kitchen, partyId)
            // the link's own unsubscribe of garden, undone within the day (a moment later, so the turning on is the newer evidence)
            ec.user.setEffectiveTime(Date.now() + 2000)
            const undoShown = hub("get#EmailPreferences", {})
            hub("store#EmailPreferences", {choices: JSON.stringify({marketing: {topics: {[list.garden]: true}}})})
            const gardenUndone = statusOf(list.garden, partyId)
            const leave = hub("store#EmailPreferences", {
                choices: JSON.stringify({marketing: {leaveOrganization: true, reason: "other", reasonText: "Moving away"}})
            })
            const scoped = rows("mantle.party.PartyConsent", {
                partyId,
                purposeEnumId: "PcpMarketingEmail",
                organizationPartyId: orgA
            })
            return {
                shown,
                stored,
                withdrawal: withdrawal || {},
                gardenAfter,
                kitchenAfter,
                undoShown,
                gardenUndone,
                kitchenLeft: statusOf(list.kitchen, partyId),
                mailed: tokenTo(shared.newcomer) != null,
                leave,
                scoped
            }
        },
        then(r) {
            r.shown.marketing.topics.map(t => t.name + ":" + t.state).join() ===
                "Garden news:subscribed,Kitchen news:unsubscribed"
            !r.shown.lists.some(l => l.contactListId === list.garden)
            r.withdrawal.comments === "Too frequent"
            r.gardenAfter === "CLPT_UNSUBSCRIBED"
            // a list the link did not leave is not turned on by it: that needs the page's sign-in
            r.kitchenAfter === "CLPT_UNSUBSCRIBED"
            r.shown.marketing.topics.find(t => t.contactListId === list.kitchen).canSubscribe === false
            r.undoShown.marketing.topics.find(t => t.contactListId === list.garden).canSubscribe === true
            r.gardenUndone === "CLPT_PENDING"
            r.mailed
            r.scoped.length === 1
            r.scoped[0].statusId === "PconWithdrawn"
            r.scoped[0].comments === "Other: Moving away"
            r.leave.marketing.topics.every(t => t.state === "unsubscribed")
            r.kitchenLeft === "CLPT_UNSUBSCRIBED"
        }
    }
)

feature("P22 review: a text message topic offered on the site is on the preferences page to leave, never to join", {
    when() {
        ec.user.setEffectiveTime(Date.now() + 5000)
        const texts = prefix + "_TEXTS"
        const partyId = partyOf(shared.newcomer)
        system(() => {
            make("mantle.marketing.contact.ContactList", {
                contactListId: texts,
                contactListName: "Text deals",
                contactListTypeEnumId: "MARKETING",
                contactMechTypeEnumId: "CmtTelecomNumber",
                ownerPartyId: orgA
            })
            make("mantle.marketing.contact.ContactListPolicy", {
                contactListId: texts,
                fromDate: new Date(Date.now() - 10 * dayMs),
                confirmationRequired: "Y",
                purposeEnumId: "PcpSms",
                publicOffer: "Y",
                publicSiteId: site
            })
        })
        const token = system(
            () =>
                lib.run("mantle.party.ConsentServices.create#UnsubscribeToken", {
                    contactListId: list.garden,
                    partyId,
                    siteId: site
                }).token
        )
        const hub = (verb, input) => {
            logout()
            try {
                return lib.run("mantle.public.AccountHubServices." + verb, {input: Object.assign({siteId: site, token}, input)})
                    .result
            } finally {
                login("john.doe")
            }
        }
        const store = on => hub("store#EmailPreferences", {choices: JSON.stringify({marketing: {topics: {[texts]: on}}})})
        const textTopic = shown => shown.marketing?.topics?.find(t => t.contactListId === texts) || null
        // not on it: shown as a text message topic, and turning it on joins nothing
        const before = textTopic(hub("get#EmailPreferences", {}))
        store(true)
        const joined = rows(CLP, {contactListId: texts, partyId}).length
        const requests = rows("mantle.marketing.contact.SubscriptionRequest", {partyId, contactListId: texts}).length
        // on it (an import's evidence): it may be left
        system(() =>
            make(CLP, {contactListId: texts, partyId, fromDate: new Date(Date.now() - dayMs), statusId: "CLPT_ACCEPTED"})
        )
        const member = textTopic(hub("get#EmailPreferences", {}))
        store(false)
        const left = statusOf(texts, partyId)
        store(true)
        return {
            before,
            joined,
            requests,
            member,
            left,
            again: statusOf(texts, partyId),
            published: page("get#Publication", {})
                .topics.map(t => t.name)
                .join()
        }
    },
    then(r) {
        r.before.channelEnumId === "MdcSms"
        r.before.state === "none"
        r.joined === 0
        r.requests === 0
        r.member.state === "subscribed"
        r.left === "CLPT_UNSUBSCRIBED"
        r.again === "CLPT_UNSUBSCRIBED"
        // the public subscription page offers lists of email only
        !r.published.includes("Text deals")
    }
})

feature("SEC-PSS-45: PASS's one-click unsubscribe confirms at once on a list that asks unsubscribe confirmation", {
    when() {
        ec.user.setEffectiveTime(Date.now() + 6000)
        const confirmed = prefix + "_UNSUB_CONFIRM"
        const partyId = partyOf(shared.newcomer)
        system(() => {
            make("mantle.marketing.contact.ContactList", {
                contactListId: confirmed,
                contactListName: "Confirmed leaving",
                contactListTypeEnumId: "NEWSLETTER",
                contactMechTypeEnumId: "CmtEmailAddress",
                ownerPartyId: orgA
            })
            make("mantle.marketing.contact.ContactListEmail", {
                contactListId: confirmed,
                emailTypeEnumId: "CONT_UNSUB_VER",
                fromDate: new Date(Date.now() - dayMs)
            })
            make(CLP, {contactListId: confirmed, partyId, fromDate: new Date(Date.now() - dayMs), statusId: "CLPT_ACCEPTED"})
        })
        const token = system(
            () =>
                lib.run("mantle.party.ConsentServices.create#UnsubscribeToken", {contactListId: confirmed, partyId, siteId: site})
                    .token
        )
        logout()
        let answer
        try {
            answer = lib.run("mantle.public.AccountHubServices.apply#OneClickUnsubscribe", {input: {siteId: site, token}})
        } finally {
            login("john.doe")
        }
        return {answer, status: statusOf(confirmed, partyId)}
    },
    then(r) {
        r.answer.result.unsubscribed === true
        r.status === "CLPT_UNSUBSCRIBED"
    }
})
