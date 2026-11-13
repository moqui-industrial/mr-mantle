// Sales' lead intake (impl-sales P5; design-sales §3 Leads, §9 LeadSources UtmSourceMap; mantle/sales/SalesIntake.js): a mail to a
// team's plus-tag address delivered twice (two rows of one Message-ID) makes one lead in that team's queue, which the team's rep
// reads and another organization's does not; a mapped UTM source and medium wins over the source alone and an unmapped pair keeps
// the default; a repeated operation key answers the first result and another request under it is refused; a campaign and tracking
// code reach the lead; a second inquiry from the same email joins the open lead; a rep without the edit permission and another
// organization are refused; an unverified intake whose lead never qualified is purged after its days, a qualified and a verified
// one kept; a call is logged on the lead by its team's rep and refused to another team's. Standalone: spec-local organizations, teams, users and records, users' services run with artifact authorization on
// under a spec grant of the sales services.
// Run: ./moq test mr-mantle --spec SalesLeadIntake
const prefix = "SLI"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const service = "mantle.sales.OpportunityServices."
const INTAKE = "mantle.sales.opportunity.SalesLeadIntake"
const OPPORTUNITY = "mantle.sales.opportunity.SalesOpportunity"
const users = {}
const teams = {}
const ids = {}

const make = (entity, values) => call("create#" + entity, values)
const one = (entity, values) => ec.entity.find(entity).condition(values).disableAuthz().one()
const rowsOf = (entity, values) => Array.from(ec.entity.find(entity).condition(values).disableAuthz().list())
function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
// A call as the job or a mail rule makes it: authorization disabled, in a transaction and error frame of its own.
function asSystem(verb, parameters = {}) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
function organization(partyId, name) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: partyId})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
}
function team(kind, organizationPartyId) {
    const partyId = prefix + "_TEAM_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization", ownerPartyId: organizationPartyId})
    make("mantle.party.Organization", {partyId, organizationName: "Team " + kind})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "SalesTeam"})
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamOf",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesTeam",
        toPartyId: organizationPartyId,
        toRoleTypeId: "OrgInternal",
        fromDate: 0
    })
    return partyId
}
function member(partyId, teamPartyId) {
    make("mantle.party.PartyRelationship", {
        relationshipTypeEnumId: "PrtSalesTeamMember",
        fromPartyId: partyId,
        fromRoleTypeId: "SalesRepresentative",
        toPartyId: teamPartyId,
        toRoleTypeId: "SalesTeam",
        fromDate: 0
    })
}
function user(kind, organizationPartyIds, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    make("mantle.party.Party", {partyId: id, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId: id, firstName: "Intake", lastName: kind})
    for (const toPartyId of organizationPartyIds)
        make("mantle.party.PartyRelationship", {
            fromPartyId: id,
            toPartyId,
            relationshipTypeEnumId: "PrtAgent",
            toRoleTypeId: "OrgInternal",
            fromDate: 0
        })
    make("moqui.security.UserGroup", {userGroupId: id, description: "Intake " + kind})
    for (const userPermissionId of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: prefix + "_GRANT", fromDate: 0})
    return id
}
function as(username, verb, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.authzDisabled()
    ec.artifactExecution.enableAuthz()
    ec.message.pushErrors()
    try {
        const out =
            ec.service
                .sync()
                .name(service + verb)
                .parameters(parameters)
                .requireNewTransaction(true)
                .call() || {}
        return ec.message.hasError() ? {refused: ec.message.getErrorsString()} : Object.assign({refused: ""}, out)
    } catch (error) {
        return {refused: String(error.message)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (was) ec.artifactExecution.disableAuthz()
        login("john.doe")
    }
}
function source(kind) {
    const dataSourceId = prefix + "_SRC_" + kind
    make("moqui.basic.DataSource", {dataSourceId, dataSourceTypeEnumId: "WEB_SITE", description: "Intake " + kind})
    make("mantle.sales.opportunity.SalesLeadSourceBinding", {dataSourceId, organizationPartyId: orgA, fromDate: 0})
    return dataSourceId
}
function mail(emailMessageId, messageId) {
    make("moqui.basic.email.EmailMessage", {
        emailMessageId,
        statusId: "ES_RECEIVED",
        subject: "Re: Racking for our new warehouse",
        bodyText: "We need 40 bays. Call me.",
        fromAddress: "buyer@prospect.example",
        fromName: "Bay Buyer",
        toAddresses: "Sales <sales+leads@ironstone.example>",
        messageId,
        receivedDate: ec.user.nowTimestamp
    })
}
const idsOf = found => Array.from(found.opportunityList || []).map(row => row.salesOpportunityId)

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Intake A")
            organization(orgB, "Intake B")
            make("moqui.security.UserGroup", {userGroupId: prefix + "_GRANT", description: "Intake spec grant"})
            make("moqui.security.ArtifactGroup", {artifactGroupId: prefix + "_SERVICES", description: "Intake spec services"})
            make("moqui.security.ArtifactGroupMember", {
                artifactGroupId: prefix + "_SERVICES",
                artifactName: "mantle\\.sales\\..*",
                artifactTypeEnumId: "AT_SERVICE",
                nameIsPattern: "Y",
                inheritAuthz: "Y"
            })
            make("moqui.security.ArtifactAuthz", {
                artifactAuthzId: prefix + "_GRANT",
                userGroupId: prefix + "_GRANT",
                artifactGroupId: prefix + "_SERVICES",
                authzTypeEnumId: "AUTHZT_ALLOW",
                authzActionEnumId: "AUTHZA_ALL"
            })
            users.rep = user("rep", [orgA], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_ACCOUNT_EDIT"])
            users.reader = user("reader", [orgA], ["SALES_VIEW"])
            users.westRep = user("west", [orgA], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT"])
            users.outsider = user("outsider", [orgB], ["SALES_VIEW", "SALES_OPPORTUNITY_EDIT", "SALES_TEAM_VIEW"])
            users.admin = user("admin", [orgA], ["SALES_VIEW", "SALES_CONFIGURE"])
            teams.east = team("east", orgA)
            teams.west = team("west", orgA)
            member(users.rep, teams.east)
            member(users.westRep, teams.west)
            make("mantle.party.PartySetting", {
                partyId: teams.east,
                partySettingTypeId: "SalesIntakePlusTag",
                settingValue: "leads"
            })
            ids.web = source("WEB")
            ids.news = source("NEWS")
            ids.newsMail = source("NEWSMAIL")
            make("mantle.party.PartySetting", {
                partyId: teams.east,
                partySettingTypeId: "SalesIntakeSource",
                settingValue: ids.web
            })
            make("mantle.marketing.campaign.MarketingCampaign", {
                marketingCampaignId: prefix + "_CAMP",
                campaignName: "Spring racking"
            })
            make("mantle.marketing.tracking.TrackingCode", {
                trackingCodeId: prefix + "_TC",
                marketingCampaignId: prefix + "_CAMP"
            })
            mail(prefix + "_M1", "<racking-123@prospect.example>")
            mail(prefix + "_M2", "<RACKING-123@prospect.example>")
        })
    }
})

feature("a mail delivered twice makes one lead in the plus-tag team's queue, read by that team and not another organization", {
    when() {
        const rule = {ruleOwnerUserId: users.rep}
        const first = asSystem("create#LeadFromEmail", Object.assign({emailMessageId: prefix + "_M1"}, rule))
        const second = asSystem("create#LeadFromEmail", Object.assign({emailMessageId: prefix + "_M2"}, rule))
        // a rule of a user who works for no team's organization files nothing
        const stranger = asSystem("create#LeadFromEmail", {
            emailMessageId: prefix + "_M1",
            ruleOwnerUserId: users.outsider,
            value: teams.east
        })
        const lead = system(() => one(OPPORTUNITY, {salesOpportunityId: first.salesOpportunityId}))
        const intakes = system(() => rowsOf(INTAKE, {salesOpportunityId: first.salesOpportunityId}))
        const teamRows = system(() =>
            rowsOf("mantle.sales.opportunity.SalesOpportunityParty", {
                salesOpportunityId: first.salesOpportunityId,
                roleTypeId: "SalesTeam"
            })
        )
        const filed = system(
            () =>
                rowsOf("mantle.party.communication.CommunicationEventRecord", {
                    recordEntityName: OPPORTUNITY,
                    recordId: first.salesOpportunityId
                }).length
        )
        const repLeads = idsOf(as(users.rep, "find#Opportunities", {typeEnumId: "SotLead", pageSize: 50}))
        const westLeads = idsOf(as(users.westRep, "find#Opportunities", {typeEnumId: "SotLead", pageSize: 50}))
        const outsiderLeads = idsOf(as(users.outsider, "find#Opportunities", {typeEnumId: "SotLead", pageSize: 50}))
        const detail = as(users.rep, "get#Opportunity", {salesOpportunityId: first.salesOpportunityId})
        ids.mailLead = first.salesOpportunityId
        // a call logged on the lead by its team's rep, refused to the west rep, who does not see it
        const logged = as(users.rep, "log#OpportunityCall", {
            salesOpportunityId: first.salesOpportunityId,
            summary: "Called back: 40 bays",
            direction: "out"
        })
        const westLog = as(users.westRep, "log#OpportunityCall", {salesOpportunityId: first.salesOpportunityId, summary: "x"})
        const filedAfter = system(
            () =>
                rowsOf("mantle.party.communication.CommunicationEventRecord", {
                    recordEntityName: OPPORTUNITY,
                    recordId: first.salesOpportunityId
                }).length
        )
        return {
            first,
            second,
            stranger,
            lead,
            intakes,
            teamRows,
            filed,
            repLeads,
            westLeads,
            outsiderLeads,
            detail,
            logged,
            westLog,
            filedAfter
        }
    },
    then(r) {
        r.first.refused == ""
        r.first.alreadyApplied == false
        r.second.refused == ""
        r.second.alreadyApplied == true
        r.second.salesOpportunityId == r.first.salesOpportunityId
        r.stranger.refused.includes("TEAM_UNAVAILABLE")
        r.intakes.length == 1
        r.intakes[0].submittedEmail == "buyer@prospect.example"
        r.intakes[0].dataSourceId == ids.web
        r.lead.typeEnumId == "SotLead"
        r.lead.organizationPartyId == orgA
        r.lead.opportunityName == "Racking for our new warehouse"
        r.lead.dataSourceId == ids.web
        r.teamRows.map(row => row.partyId).includes(teams.east)
        r.filed == 1
        r.repLeads.includes(r.first.salesOpportunityId)
        !r.westLeads.includes(r.first.salesOpportunityId)
        !r.outsiderLeads.includes(r.first.salesOpportunityId)
        r.detail.intakes.length == 1
        r.detail.intakes[0].submittedName == "Bay Buyer"
        r.detail.intakes[0].verified == false
        r.logged.refused == ""
        r.westLog.refused.includes("RECORD_UNAVAILABLE")
        r.filedAfter == 2
    }
})

feature(
    "the UTM map decides the source, a key answers its first result, a campaign and code reach the lead, an email joins its lead",
    {
        when() {
            const map = (utmSource, utmMedium, dataSourceId) =>
                as(users.admin, "store#LeadSourceMapping", {organizationPartyId: orgA, utmSource, utmMedium, dataSourceId})
            const mapped = [map("Newsletter", null, ids.news), map("newsletter", "email", ids.newsMail)]
            const clash = map("newsletter", "email", ids.web)
            const notConfigurer = as(users.rep, "store#LeadSourceMapping", {
                organizationPartyId: orgA,
                utmSource: "ads",
                dataSourceId: ids.web
            })
            // as Marketing's capture job hands a lead over: the queue named, a key, the published fields
            const intake = (key, extra) =>
                asSystem(
                    "store#LeadIntake",
                    Object.assign(
                        {
                            organizationPartyId: orgA,
                            sourceKind: "formResponse",
                            sourceId: prefix + "-resp-" + key,
                            operationKey: prefix + "-cap-" + key,
                            teamPartyId: teams.east,
                            defaultDataSourceId: ids.web
                        },
                        extra
                    )
                )
            const both = intake("1", {
                utmSource: "newsletter",
                utmMedium: "email",
                submittedEmail: "a@one.example",
                submittedOrganization: "One Co"
            })
            const alone = intake("2", {utmSource: "NEWSLETTER", utmMedium: "social", submittedEmail: "b@two.example"})
            const unmapped = intake("3", {
                utmSource: "fair",
                utmMedium: "print",
                submittedEmail: "c@three.example",
                trackingCodeId: prefix + "_TC"
            })
            const repeated = intake("3", {
                utmSource: "fair",
                utmMedium: "print",
                submittedEmail: "c@three.example",
                trackingCodeId: prefix + "_TC"
            })
            const conflict = intake("3", {utmSource: "fair", submittedEmail: "other@three.example"})
            const joined = intake("4", {submittedEmail: "A@One.example", submittedName: "Second note"})
            const lead = id => system(() => one(OPPORTUNITY, {salesOpportunityId: id}))
            const tracking = system(
                () =>
                    rowsOf("mantle.sales.opportunity.SalesOpportunityTracking", {salesOpportunityId: unmapped.salesOpportunityId})
                        .length
            )
            // the user callers: a reader without the edit permission, and an editor of another organization
            const staff = {
                organizationPartyId: orgA,
                sourceKind: "staff",
                operationKey: prefix + "-staff-1",
                submittedEmail: "d@four.example"
            }
            const reader = as(users.reader, "store#LeadIntake", staff)
            const outsider = as(users.outsider, "store#LeadIntake", staff)
            const byRep = as(users.rep, "store#LeadIntake", staff)
            const repOwner = system(() =>
                rowsOf("mantle.sales.opportunity.SalesOpportunityParty", {
                    salesOpportunityId: byRep.salesOpportunityId,
                    roleTypeId: "SalesRepresentative"
                })
            )
            const list = as(users.admin, "find#LeadSourceMappings", {organizationPartyId: orgA})
            // a team's intake address: one team's tag, set by the configurer
            const tagTaken = as(users.admin, "store#TeamIntake", {teamPartyId: teams.west, intakePlusTag: "Leads"})
            const tagSet = as(users.admin, "store#TeamIntake", {
                teamPartyId: teams.west,
                intakePlusTag: "west-leads",
                intakeDataSourceId: ids.news
            })
            const tagByRep = as(users.rep, "store#TeamIntake", {teamPartyId: teams.west, intakePlusTag: "mine"})
            const teamIntakes = as(users.admin, "find#TeamIntakes", {organizationPartyId: orgA}).teamList || []
            return {
                mapped,
                clash,
                notConfigurer,
                both: Object.assign(both, {lead: lead(both.salesOpportunityId)}),
                alone: Object.assign(alone, {lead: lead(alone.salesOpportunityId)}),
                unmapped: Object.assign(unmapped, {lead: lead(unmapped.salesOpportunityId)}),
                repeated,
                conflict,
                joined,
                tracking,
                reader,
                outsider,
                byRep,
                repOwner,
                list,
                tagTaken,
                tagSet,
                tagByRep,
                teamIntakes
            }
        },
        then(r) {
            r.mapped.every(row => row.refused == "")
            r.clash.refused.includes("MAPPING_EXISTS")
            r.notConfigurer.refused.includes("PERMISSION_DENIED")
            r.list.mappingList.length == 2
            r.both.lead.dataSourceId == ids.newsMail
            r.both.lead.opportunityName == "One Co"
            r.alone.lead.dataSourceId == ids.news
            r.unmapped.lead.dataSourceId == ids.web
            r.unmapped.lead.marketingCampaignId == prefix + "_CAMP"
            r.tracking == 1
            r.repeated.refused == ""
            r.repeated.alreadyApplied == true
            r.repeated.salesOpportunityId == r.unmapped.salesOpportunityId
            r.conflict.refused.includes("OPERATION_KEY_CONFLICT")
            r.joined.duplicate == true
            r.joined.salesOpportunityId == r.both.salesOpportunityId
            r.reader.refused.includes("PERMISSION_DENIED")
            r.outsider.refused.includes("ORGANIZATION_DENIED")
            r.byRep.refused == ""
            r.repOwner.map(row => row.partyId).includes(users.rep)
            r.tagTaken.refused.includes("TAG_TAKEN")
            r.tagSet.refused == ""
            r.tagByRep.refused.includes("PERMISSION_DENIED")
            r.teamIntakes.find(row => row.teamPartyId === teams.west).addressText.startsWith("sales+west-leads@")
            r.teamIntakes.find(row => row.teamPartyId === teams.west).intakeDataSourceId == ids.news
        }
    }
)

feature("an unverified intake whose lead never qualified is purged after its days; a qualified and a verified one are kept", {
    when() {
        const intake = (key, extra) =>
            asSystem(
                "store#LeadIntake",
                Object.assign(
                    {
                        organizationPartyId: orgA,
                        sourceKind: "formResponse",
                        sourceId: prefix + "-old-" + key,
                        teamPartyId: teams.east,
                        submittedName: "Old " + key,
                        submittedEmail: key + "@old.example",
                        submittedPhone: "+1 555 0100"
                    },
                    extra
                )
            )
        const stale = intake("stale")
        const qualified = intake("qualified")
        const verified = intake("verified", {verified: true})
        // received forty days ago
        system(() => {
            for (const made of [stale, qualified, verified])
                call("update#" + INTAKE, {
                    salesLeadIntakeId: made.salesLeadIntakeId,
                    receivedDate: new Date(Date.now() - 40 * 86400000)
                })
            call("update#" + OPPORTUNITY, {salesOpportunityId: qualified.salesOpportunityId, convertedDate: ec.user.nowTimestamp})
        })
        const notConfigurer = as(users.rep, "purge#LeadIntakes", {})
        const purge = asSystem("purge#LeadIntakes", {retentionDays: 30})
        const read = made => system(() => one(INTAKE, {salesLeadIntakeId: made.salesLeadIntakeId}))
        const again = intake("stale")
        return {
            notConfigurer,
            purge,
            stale: read(stale),
            qualified: read(qualified),
            verified: read(verified),
            again,
            staleLead: stale.salesOpportunityId
        }
    },
    then(r) {
        r.notConfigurer.refused.includes("PERMISSION_DENIED")
        r.purge.refused == ""
        r.purge.purgedCount >= 1
        r.stale.purgedDate != null
        r.stale.submittedName == null
        r.stale.submittedEmail == null
        r.stale.submittedPhone == null
        r.qualified.purgedDate == null
        r.qualified.submittedEmail == "qualified@old.example"
        r.verified.purgedDate == null
        r.verified.submittedName == "Old verified"
        r.again.alreadyApplied == true
        r.again.salesOpportunityId == r.staleLead
    }
})
