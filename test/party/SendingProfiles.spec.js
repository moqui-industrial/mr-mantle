// Comms' sending profiles (impl-marketing P6, F13, F17, F76; design-marketing §12 SendingProfiles; mantle.party.MessageServices over
// MessageSendingProfiles.js and the ledger's attempt in MessageDeliveries.js): a profile is not ready without its bounce account and
// says why and where it is fixed, ready once the hosted account bounces@ its domain exists; no answer carries a host or credential;
// the relay is one Admin approved, never a mail account's server; a reader of Marketing's sending reads it, a holder of neither is
// refused and another organization's answers as missing; a delivery naming the profile goes out through its relay, from its sender
// and reply-to, with the bounce address bounces+(delivery)@ its domain, and one naming none as before; its quiet hours make a delivery
// wait, untried. Standalone: spec-local organizations, users, relays, template and source. Run: ./moq test mr-mantle --spec SendingProfiles
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const M = "mantle.party.MessageServices."
const ms = ec.resource.script("component://mr-mantle/service/mantle/ledger/EntityLib.js").ms
const capture = ec.factory.getTool("MailCapture")
const prefix = "MSF"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {
    source: "MdsrcSpecProfile",
    template: prefix + "_TPL",
    buyer: prefix + "_BUYER",
    relay: prefix + "_RELAY",
    owned: prefix + "_OWNED"
}
const domain = "bounce.profiles.example.test"
const users = {}
let profileId

spec({
    setupSpec() {
        capture.enable()
        system(() => {
            organization(orgA, "Profiles A")
            organization(orgB, "Profiles B")
            users.configurer = user(prefix, "configurer", [orgA], ["MESSAGE_SENDING_CONFIGURE"])
            users.author = user(prefix, "author", [orgA], ["MARKETING_VIEW", "MARKETING_SEND_EDIT"])
            users.nobody = user(prefix, "nobody", [orgA], ["MARKETING_VIEW"])
            users.configurerB = user(prefix, "configurerB", [orgB], ["MESSAGE_SENDING_CONFIGURE"])
            make("moqui.basic.Enumeration", {
                enumId: ids.source,
                enumTypeId: "MessageDeliverySource",
                description: "Spec profile source"
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: ids.relay,
                smtpHost: "relay-host.profiles.example.test",
                smtpPort: "9",
                smtpStartTls: "N",
                mailUsername: "relay-user",
                mailPassword: "relay-secret"
            })
            make("moqui.basic.email.EmailServer", {
                emailServerId: prefix + "_TEMPLATE_SMTP",
                smtpHost: "127.0.0.1",
                smtpPort: "9",
                smtpStartTls: "N"
            })
            make("moqui.basic.email.EmailServer", {emailServerId: ids.owned, smtpHost: "127.0.0.1", smtpPort: "9"})
            make("moqui.basic.email.EmailAccount", {
                emailAccountId: prefix + "_OWNER_ACCT",
                emailServerId: ids.owned,
                ownsEmailServer: "Y",
                accountKindEnumId: "EakExternal",
                emailAddress: "someone@profiles.example.test",
                statusId: "EasActive"
            })
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: ids.template,
                emailServerId: prefix + "_TEMPLATE_SMTP",
                fromAddress: "template@profiles.example.test",
                subject: "Profile spec",
                bodyScreenLocation: "component://framework/screen/ScreenRenderEmail.xml"
            })
            make("mantle.party.Party", {partyId: ids.buyer, partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: ids.buyer, firstName: "Profile", lastName: "Buyer"})
        })
    },
    cleanupSpec() {
        capture.reset()
    }
})

feature("a profile is not ready without its bounce account and says why; ready with it; no host or credential is told", {
    when() {
        const store = (username, fields = {}) =>
            as(
                username,
                M + "store#SendingProfile",
                Object.assign(
                    {
                        organizationPartyId: orgA,
                        profileName: "Retail news",
                        emailServerId: ids.relay,
                        fromAddress: "News@Profiles.example.test",
                        fromName: "Retail news",
                        replyToAddress: "reply@profiles.example.test",
                        bounceDomain: domain,
                        purposeEnumId: "MtpPromotional"
                    },
                    fields
                )
            )
        const made = store(users.configurer)
        profileId = made.sendingProfileId
        const notReady = as(users.configurer, M + "check#SendingProfile", {sendingProfileId: profileId, refresh: true})
        make("moqui.basic.email.EmailAccount", {
            emailAccountId: prefix + "_BOUNCES",
            accountKindEnumId: "EakHosted",
            emailAddress: "bounces@" + domain,
            statusId: "EasActive"
        })
        return {
            made,
            notReady,
            ready: as(users.author, M + "check#SendingProfile", {sendingProfileId: profileId}),
            found: as(users.author, M + "find#SendingProfiles", {organizationPartyId: orgA}),
            got: as(users.configurer, M + "get#SendingProfile", {sendingProfileId: profileId}),
            nobody: as(users.nobody, M + "find#SendingProfiles", {}),
            otherOrg: as(users.configurerB, M + "get#SendingProfile", {sendingProfileId: profileId}),
            authorStore: store(users.author, {profileName: "Not mine"}),
            ownedRelay: store(users.configurer, {emailServerId: ids.owned}),
            otherOrgStore: store(users.configurerB)
        }
    },
    then({made, notReady, ready, found, got, nobody, otherOrg, authorStore, ownedRelay, otherOrgStore}) {
        made.refusal == ""
        notReady.ready == false
        const bounce = Array.from(notReady.checkList).find(check => check.checkKey == "bounce")
        bounce.state == "blocked" && bounce.message.includes("bounces@" + domain) && bounce.fixRoute == "mailAccount"
        row("mantle.party.MessageSendingProfile", {sendingProfileId: profileId}).lastCheckReady == "N"
        ready.ready == true
        found.profileList.length == 1 && found.profileList[0].ready == true && found.profileList[0].relayId == ids.relay
        got.relayOptions.some(option => option.value == ids.relay) && !got.relayOptions.some(option => option.value == ids.owned)
        // no answer names the relay's host, user or password
        const told = JSON.stringify([notReady, ready, found, got])
        !told.includes("relay-host") && !told.includes("relay-user") && !told.includes("relay-secret")
        nobody.refusal.includes("PERMISSION_DENIED")
        otherOrg.refusal.includes("RECORD_UNAVAILABLE")
        authorStore.refusal.includes("PERMISSION_DENIED")
        ownedRelay.refusal.includes("RELAY_INVALID")
        otherOrgStore.refusal.includes("ORGANIZATION_DENIED")
    }
})

feature("a delivery naming the profile goes out with its relay, sender and bounce address; one naming none as before", {
    when() {
        const queue = (eventKey, sendingProfileId) =>
            system(() =>
                lib.run(M + "queue#Delivery", {
                    eventKey,
                    sourceEnumId: ids.source,
                    recipientPartyId: ids.buyer,
                    toAddress: "buyer@profiles.example.test",
                    templateKey: ids.template,
                    bodyParameters: {title: "Spec"},
                    ...(sendingProfileId ? {sendingProfileId} : {}),
                    sendNow: true
                })
            )
        capture.clear()
        const profiled = queue("spec:profile-1", profileId)
        const viaProfile = capture.last()
        const plain = queue("spec:profile-2", null)
        const viaTemplate = capture.last()
        const attempt = row("mantle.party.MessageDeliveryAttempt", {deliveryId: profiled.deliveryId})
        return {profiled, viaProfile, plain, viaTemplate, attempt}
    },
    then({profiled, viaProfile, plain, viaTemplate, attempt}) {
        profiled.stateEnumId == "MdsSent"
        const delivery = row("mantle.party.MessageDelivery", {deliveryId: profiled.deliveryId})
        delivery.sendingProfileId == profileId && delivery.organizationPartyId == orgA
        viaProfile.fromAddress == "news@profiles.example.test" && viaProfile.fromName == "Retail news"
        Array.from(viaProfile.replyToList) == ["reply@profiles.example.test"]
        viaProfile.bounceAddress == "bounces+" + profiled.deliveryId + "@" + domain
        row("moqui.basic.email.EmailMessage", {emailMessageId: attempt.emailMessageId}).emailServerId == ids.relay
        plain.stateEnumId == "MdsSent"
        viaTemplate.fromAddress == "template@profiles.example.test" && viaTemplate.bounceAddress == ""
    }
})

feature("the profile's quiet hours make a delivery wait, untried; a stale change is refused", {
    when() {
        const hhmm = offsetMinutes => ec.l10n.format(new Date(Date.now() + offsetMinutes * 60000), "HH:mm", null, "UTC")
        const revision = () => ms(row("mantle.party.MessageSendingProfile", {sendingProfileId: profileId}).lastUpdatedStamp)
        const quiet = as(users.configurer, M + "store#SendingProfile", {
            sendingProfileId: profileId,
            expectedRevision: revision(),
            quietFrom: hhmm(-60),
            quietThru: hhmm(60),
            timeZone: "UTC"
        })
        capture.clear()
        const waiting = system(() =>
            lib.run(M + "queue#Delivery", {
                eventKey: "spec:profile-quiet",
                sourceEnumId: ids.source,
                recipientPartyId: ids.buyer,
                toAddress: "buyer@profiles.example.test",
                templateKey: ids.template,
                bodyParameters: {title: "Spec"},
                sendingProfileId: profileId,
                sendNow: true
            })
        )
        const stale = as(users.configurer, M + "store#SendingProfile", {
            sendingProfileId: profileId,
            expectedRevision: 1,
            profileName: "x"
        })
        return {quiet, waiting, sent: capture.count(), stale}
    },
    then({quiet, waiting, sent, stale}) {
        quiet.refusal == ""
        waiting.stateEnumId == "MdsQueued"
        sent == 0
        const delivery = row("mantle.party.MessageDelivery", {deliveryId: waiting.deliveryId})
        Number(delivery.attempts || 0) == 0 && ms(delivery.nextAttemptDate) > Date.now() + 30 * 60000
        rows("mantle.party.MessageDeliveryAttempt", {deliveryId: waiting.deliveryId}).length == 0
        stale.refusal.includes("STALE_RECORD")
    }
})
