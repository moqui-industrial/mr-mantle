// Marketing's audiences (impl-marketing P3; design-marketing §4 Lists, ListDetail, MemberDetail, §14.1; mantle.marketing.AudienceServices
// over MarketingAudiences.js, and the list and consent services' P3 extensions): a list made by an audience editor subscribes no one
// and a list with named members is refused, while a mailbox behaves as before; a request is pending without confirmation; an
// acceptance needs the consent permission and evidence; a later withdrawal is not regranted by a retry of older evidence, and a
// withdrawn purpose not by staff at all; another organization's list answers as missing and another person's consent is changed only
// for an organization of the editor's scope; the policy and template bindings are dated; a single-use list is held by one send.
// Standalone: spec-local organizations, users, parties and lists.
// Run: ./moq test mr-mantle --spec Audiences
const lib = ec.resource.script("component://mr-mantle/test/marketing/MarketingSpecLib.js")
const {make, row, rows, system, organization, user, as} = lib
const prefix = "MKU"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const L = "mantle.marketing.AudienceServices."
const CONSENT = "mantle.party.ConsentServices."
const CLP = "mantle.marketing.contact.ContactListParty"
const users = {}
const party = {}
const audience = ["MARKETING_AUDIENCE_VIEW", "MARKETING_AUDIENCE_EDIT"]
const consent = audience.concat(["MARKETING_CONSENT_EDIT"])
const dayMs = 24 * 60 * 60 * 1000
const ago = days => new Date(Date.now() - days * dayMs)
let listId, mailboxId
const status = (contactListId, partyId) =>
    rows(CLP, {contactListId, partyId}).sort((a, b) => Number(b.fromDate) - Number(a.fromDate))[0]?.statusId ?? null
const outcomes = out => Array.from(out.results || []).map(result => result.outcome + ":" + (result.reasonCode || ""))

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Audiences A")
            organization(orgB, "Audiences B")
            users.editor = user(prefix, "editor", [orgA], audience)
            users.consent = user(prefix, "consent", [orgA], consent)
            users.editorB = user(prefix, "editorB", [orgB], consent)
            users.reader = user(prefix, "reader", [orgA], ["MARKETING_VIEW"])
            for (const name of ["Ana", "Ben", "Cyd", "Dee", "Eve"]) {
                party[name] = prefix + "_" + name.toUpperCase()
                make("mantle.party.Party", {partyId: party[name], partyTypeEnumId: "PtyPerson"})
                make("mantle.party.Person", {partyId: party[name], firstName: name, lastName: "Audiencespec"})
                if (name === "Eve") continue
                make("mantle.party.contact.ContactMech", {
                    contactMechId: party[name] + "_EM",
                    contactMechTypeEnumId: "CmtEmailAddress",
                    infoString: name.toLowerCase() + ".audiencespec@example.com"
                })
                make("mantle.party.contact.PartyContactMech", {
                    partyId: party[name],
                    contactMechId: party[name] + "_EM",
                    contactMechPurposeId: "EmailPrimary",
                    fromDate: ago(30)
                })
            }
        })
    }
})

feature("an audience editor's list subscribes no one; a list with named members is refused; a mailbox behaves as before", {
    when() {
        const made = as(users.editor, L + "create#List", {
            organizationPartyId: orgA,
            contactListName: "Spec newsletter",
            contactListTypeEnumId: "NEWSLETTER"
        })
        listId = made.contactListId
        return {
            made,
            otherOrg: as(users.editor, L + "create#List", {organizationPartyId: orgB, contactListName: "Not mine"}),
            reader: as(users.reader, L + "create#List", {organizationPartyId: orgA, contactListName: "Reader's"}),
            mailboxType: as(users.editor, L + "create#List", {
                organizationPartyId: orgA,
                contactListName: "A mailbox",
                contactListTypeEnumId: "MAILBOX"
            }),
            named: as(users.editor, "mantle.marketing.ContactListServices.create#ContactList", {
                contactListTypeEnumId: "MARKETING",
                contactListName: "With staff",
                ownerPartyId: orgA,
                memberPartyIdList: [party.Ana]
            }),
            mailbox: as(users.editor, "mantle.marketing.ContactListServices.create#ContactList", {
                contactListTypeEnumId: "MAILBOX",
                contactListName: "Spec team room",
                memberPartyIdList: [party.Ana]
            })
        }
    },
    then({made, otherOrg, reader, mailboxType, named, mailbox}) {
        made.refusal == "" && !!listId
        rows(CLP, {contactListId: listId}).length == 0
        row("mantle.marketing.contact.ContactList", {contactListId: listId}).ownerPartyId == orgA
        otherOrg.refusal.includes("ORGANIZATION_DENIED")
        reader.refusal.includes("PERMISSION_DENIED")
        mailboxType.refusal.includes("LIST_TYPE_INVALID")
        named.refusal.includes("MEMBERS_NEED_EVIDENCE")
        // a mailbox: its creator its owner, the named members accepted, as before P3
        mailbox.refusal == ""
        rows(CLP, {contactListId: mailbox.contactListId}).length == 2
        status(mailbox.contactListId, party.Ana) == "CLPT_ACCEPTED"
    }
})

feature("a request is pending without confirmation; one without an address is refused; the members list them", {
    when() {
        const out = as(users.editor, L + "request#Subscriptions", {
            contactListId: listId,
            partyIdList: [party.Ana, party.Ben, party.Eve],
            sourceEnumId: "PcsForm",
            evidenceDate: ago(2),
            evidenceText: "Signed up at the spring fair"
        })
        return {
            out,
            again: as(users.editor, L + "request#Subscriptions", {
                contactListId: listId,
                partyIdList: [party.Ana],
                evidenceText: "Asked again"
            }),
            noEvidence: as(users.editor, L + "request#Subscriptions", {contactListId: listId, partyIdList: [party.Cyd]}),
            members: as(users.editor, L + "find#Members", {contactListId: listId, memberStatus: "pending"})
        }
    },
    then({out, again, noEvidence, members}) {
        out.refusal == ""
        outcomes(out) == ["pending:", "pending:", "refused:MISSING_DESTINATION"]
        status(listId, party.Ana) == "CLPT_PENDING" && status(listId, party.Ben) == "CLPT_PENDING"
        // each request recorded, the repeated one too (ALREADY_PENDING)
        rows("mantle.marketing.contact.SubscriptionRequest", {contactListId: listId}).length == 4
        // nothing is consent until accepted
        rows("mantle.party.PartyConsent", {partyId: party.Ana}).length == 0
        outcomes(again) == ["existing:ALREADY_PENDING"]
        noEvidence.refusal.includes("EVIDENCE_REQUIRED")
        members.memberListCount == 2
        Array.from(members.memberList).every(member => member.addressText.includes("***@example.com"))
    }
})

feature("an acceptance needs the consent permission and evidence; it records the list's grant", {
    when() {
        const parameters = {contactListId: listId, partyIdList: [party.Ana], accept: true, evidenceText: "Confirmed by phone"}
        return {
            editor: as(users.editor, L + "request#Subscriptions", parameters),
            noEvidence: as(users.consent, L + "request#Subscriptions", Object.assign({}, parameters, {evidenceText: ""})),
            accepted: as(users.consent, L + "request#Subscriptions", parameters)
        }
    },
    then({editor, noEvidence, accepted}) {
        editor.refusal.includes("PERMISSION_DENIED")
        noEvidence.refusal.includes("EVIDENCE_REQUIRED")
        accepted.refusal == ""
        outcomes(accepted) == ["accepted:"]
        status(listId, party.Ana) == "CLPT_ACCEPTED"
        rows("mantle.party.PartyConsent", {partyId: party.Ana, contactListId: listId, statusId: "PconGranted"}).length == 1
    }
})

feature("a later withdrawal is not regranted by a retry of older evidence; a withdrawn purpose is not renewed by staff", {
    when() {
        const withdrawn = as(users.consent, L + "withdraw#Subscription", {
            contactListId: listId,
            partyId: party.Ana,
            evidenceText: "Asked us to stop, by email"
        })
        const retry = as(users.consent, L + "request#Subscriptions", {
            contactListId: listId,
            partyIdList: [party.Ana],
            accept: true,
            evidenceDate: ago(1),
            evidenceText: "Confirmed by phone"
        })
        const pendingRetry = as(users.editor, L + "request#Subscriptions", {
            contactListId: listId,
            partyIdList: [party.Ana],
            evidenceDate: ago(2),
            evidenceText: "Signed up at the spring fair"
        })
        // Cyd withdraws all marketing email for every organization (as a contact administrator records it)
        system(() =>
            lib.run(CONSENT + "store#PartyConsent", {
                partyId: party.Cyd,
                contactMechId: party.Cyd + "_EM",
                purposeEnumId: "PcpMarketingEmail",
                statusId: "PconWithdrawn",
                consentDate: ago(1)
            })
        )
        return {
            withdrawn,
            retry,
            pendingRetry,
            fresh: as(users.consent, L + "request#Subscriptions", {
                contactListId: listId,
                partyIdList: [party.Ana],
                accept: true,
                evidenceText: "Re-joined at the counter, signed form"
            }),
            cydAccept: as(users.consent, L + "request#Subscriptions", {
                contactListId: listId,
                partyIdList: [party.Cyd],
                accept: true,
                evidenceText: "Says yes now"
            }),
            cydPending: as(users.editor, L + "request#Subscriptions", {
                contactListId: listId,
                partyIdList: [party.Cyd],
                evidenceText: "Says yes now"
            })
        }
    },
    then({withdrawn, retry, pendingRetry, fresh, cydAccept, cydPending}) {
        withdrawn.refusal == "" && withdrawn.statusId == "CLPT_UNSUBSCRIBED"
        outcomes(retry) == ["refused:WITHDRAWN"]
        outcomes(pendingRetry) == ["refused:WITHDRAWN"]
        outcomes(fresh) == ["accepted:"]
        status(listId, party.Ana) == "CLPT_ACCEPTED"
        outcomes(cydAccept) == ["refused:CONSENT_WITHDRAWN"]
        // newer intent may wait for Cyd's own confirmation; the withdrawal stays
        outcomes(cydPending) == ["pending:"]
    }
})

feature(
    "another organization's list is missing; another person's consent is changed only for an organization of the editor's scope",
    {
        when() {
            const scoped = {
                partyId: party.Dee,
                purposeEnumId: "PcpMarketingEmail",
                statusId: "PconGranted",
                contactMechId: party.Dee + "_EM"
            }
            return {
                otherList: as(users.editorB, L + "request#Subscriptions", {
                    contactListId: listId,
                    partyIdList: [party.Dee],
                    evidenceText: "Not their list"
                }),
                otherRead: as(users.editorB, L + "get#List", {contactListId: listId}),
                global: as(users.consent, CONSENT + "store#PartyConsent", scoped),
                mine: as(users.consent, CONSENT + "store#PartyConsent", Object.assign({organizationPartyId: orgA}, scoped)),
                theirs: as(users.consent, CONSENT + "store#PartyConsent", Object.assign({organizationPartyId: orgB}, scoped)),
                editorOnly: as(users.editor, CONSENT + "store#PartyConsent", Object.assign({organizationPartyId: orgA}, scoped)),
                subscribe: as(users.editor, CONSENT + "subscribe#ContactListParty", {contactListId: listId, partyId: party.Dee}),
                stateA: system(() => lib.run(CONSENT + "get#PartyConsentState", {partyId: party.Dee, organizationPartyId: orgA})),
                stateGlobal: system(() => lib.run(CONSENT + "get#PartyConsentState", {partyId: party.Dee}))
            }
        },
        then({otherList, otherRead, global, mine, theirs, editorOnly, subscribe, stateA, stateGlobal}) {
            otherList.refusal.includes("RECORD_UNAVAILABLE")
            otherRead.refusal.includes("RECORD_UNAVAILABLE")
            global.refusal.includes("PERMISSION_DENIED")
            mine.refusal == ""
            theirs.refusal.includes("PERMISSION_DENIED")
            editorOnly.refusal.includes("PERMISSION_DENIED")
            subscribe.refusal.includes("PERMISSION_DENIED")
            // the scoped grant is A's: the global state has none, and the address's allowSolicitation is not touched
            Array.from(stateA.grantedPurposeEnumIds).includes("PcpMarketingEmail")
            !Array.from(stateGlobal.grantedPurposeEnumIds).includes("PcpMarketingEmail")
            row("mantle.party.contact.PartyContactMech", {partyId: party.Dee, contactMechId: party.Dee + "_EM"})
                .allowSolicitation == null
        }
    }
)

feature("the policy and template bindings are dated; a single-use list is held by one send at a time", {
    when() {
        const first = as(users.editor, L + "store#SubscriptionPolicy", {
            contactListId: listId,
            publicOffer: "Y",
            confirmationRequired: "Y",
            evidenceText: "Yes, send me the spring newsletter"
        })
        const stale = as(users.editor, L + "store#SubscriptionPolicy", {contactListId: listId, publicOffer: "N"})
        const detail = as(users.editor, L + "get#List", {contactListId: listId})
        const second = as(users.editor, L + "store#SubscriptionPolicy", {
            contactListId: listId,
            expectedRevision: detail.policy.revision,
            publicOffer: "N"
        })
        system(() =>
            make("moqui.basic.email.EmailTemplate", {
                emailTemplateId: prefix + "_TPL",
                description: "Spec template",
                fromAddress: "a@example.com"
            })
        )
        for (let index = 0; index < 2; index++)
            as(users.editor, L + "store#ContactListEmail", {
                contactListId: listId,
                emailTypeEnumId: "CONT_SUB_NOT",
                emailTemplateId: prefix + "_TPL"
            })
        const reserve = (sendId, parameters = {}) =>
            system(() => lib.run(L + "reserve#SingleUseList", Object.assign({contactListId: listId, sendId}, parameters)))
        const notSingle = reserve("S0")
        system(() =>
            make("mantle.marketing.contact.ContactList", {
                contactListId: prefix + "_SINGLE",
                contactListName: "Once",
                contactListTypeEnumId: "MARKETING",
                ownerPartyId: orgA,
                singleUse: "Y"
            })
        )
        const single = (op, sendId, extra = {}) =>
            system(() => lib.run(L + op, Object.assign({contactListId: prefix + "_SINGLE", sendId}, extra)))
        return {
            first,
            stale,
            second,
            after: as(users.editor, L + "get#List", {contactListId: listId}),
            notSingle,
            s1: single("reserve#SingleUseList", "S1"),
            s2: single("reserve#SingleUseList", "S2"),
            s1Again: single("reserve#SingleUseList", "S1"),
            released: single("release#SingleUseList", "S1"),
            s2After: single("reserve#SingleUseList", "S2"),
            consumed: single("release#SingleUseList", "S2", {consume: true}),
            s3: single("reserve#SingleUseList", "S3")
        }
    },
    then({first, stale, second, after, notSingle, s1, s2, s1Again, released, s2After, consumed, s3}) {
        first.refusal == "" && second.refusal == ""
        stale.refusal.includes("REVISION_REQUIRED")
        Array.from(after.policyHistory).length == 2
        Array.from(after.policyHistory).filter(policy => policy.current).length == 1
        after.policy.publicOffer == "N"
        Array.from(after.templates).filter(template => template.current).length == 1
        Array.from(after.templates).length == 2
        notSingle.reasonCode == "NOT_SINGLE_USE"
        s1.reserved && !s2.reserved && s2.reasonCode == "LIST_RESERVED" && s1Again.reserved
        released.released && s2After.reserved
        consumed.consumed && !s3.reserved && s3.reasonCode == "LIST_USED"
    }
})
