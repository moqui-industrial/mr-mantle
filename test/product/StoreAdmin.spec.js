// Store administration (impl-commerce P2, COM-STORE; mantle.product.StoreAdminServices, StoreAdmin.js): a new store's
// defaults from its organization and no site; the permission and organization checks (a reader cannot save, another
// organization's manager is refused, a store-limited staff member works only their stores); dated replacement of a child
// row and the refusals of each save (another organization's facility, a non-staff role, an outsider, an unregistered order
// check, template or document, a private space, a location setting); a policy change's reason in History and a stale
// revision refused; the clone's exclusions, approval and retry; readiness findings; store groups.
// Standalone: spec-local organizations, people, users and stores, artifact authorization disabled (the rules are the
// services' own checks). Run: ./moq test mr-mantle --spec StoreAdmin
const A = "mantle.product.StoreAdminServices."
const S = "mantle.product.store."
const prefix = "STADM"
const orgA = prefix + "_ORG_A",
    orgB = prefix + "_ORG_B"
const ids = {}

function system(action) {
    login("john.doe")
    const was = ec.artifactExecution.disableAuthz()
    try {
        return action()
    } finally {
        if (!was) ec.artifactExecution.enableAuthz()
    }
}
const make = (entity, values) => call("create#" + entity, values)
const list = (entity, conditions) =>
    system(() => Array.from(ec.entity.find(entity).condition(conditions).disableAuthz().list()).map(row => row.getMap()))
function organization(partyId, name, currency) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyOrganization"})
    make("mantle.party.Organization", {partyId, organizationName: name})
    make("mantle.party.PartyRole", {partyId, roleTypeId: "OrgInternal"})
    make("mantle.ledger.config.PartyAcctgPreference", {organizationPartyId: partyId, baseCurrencyUomId: currency})
}
function person(partyId, organizationPartyId) {
    make("mantle.party.Party", {partyId, partyTypeEnumId: "PtyPerson"})
    make("mantle.party.Person", {partyId, firstName: "Store", lastName: partyId})
    if (organizationPartyId)
        make("mantle.party.PartyRelationship", {
            partyRelationshipId: partyId,
            fromPartyId: partyId,
            toPartyId: organizationPartyId,
            relationshipTypeEnumId: "PrtAgent",
            fromDate: 0
        })
}
function user(kind, organizationPartyId, permissions) {
    const id = prefix + "_" + kind.toUpperCase()
    person(id, organizationPartyId)
    make("moqui.security.UserGroup", {userGroupId: id, description: "Store admin " + kind})
    for (const permission of permissions)
        make("moqui.security.UserGroupPermission", {userGroupId: id, userPermissionId: permission, fromDate: 0})
    make("moqui.security.UserAccount", {
        userId: id,
        username: id,
        partyId: id,
        currentPassword: "16ac58bbfa332c1c55bd98b53e60720bfa90d394",
        passwordHashType: "SHA",
        timeZone: "America/Chicago",
        locale: "en_US"
    })
    make("moqui.security.UserGroupMember", {userId: id, userGroupId: id, fromDate: 0})
    return id
}
const users = {}
// a call as a user, in its own transaction: its result and its refusal code ("" when it succeeds)
function run(username, service, parameters = {}) {
    login(username)
    const was = ec.artifactExecution.disableAuthz()
    ec.message.pushErrors()
    try {
        const out = ec.service.sync().name(service).parameters(parameters).requireNewTransaction(true).call() || {}
        return Object.assign({}, out, {error: ec.message.hasError() ? ec.message.getErrorsString() : ""})
    } catch (error) {
        return {error: String(error.message || error)}
    } finally {
        ec.message.clearErrors()
        ec.message.popErrors()
        if (!was) ec.artifactExecution.enableAuthz()
        login("john.doe")
    }
}
const code = out => (/([A-Z][A-Z0-9_]+):/.exec(out.error || "") || [])[1] || (out.error ? "ERROR" : "")
const current = rowsFound => rowsFound.filter(row => row.thruDate == null || Number(row.thruDate) > Date.now())

spec({
    setupSpec() {
        system(() => {
            organization(orgA, "Store admin organization A", "EUR")
            organization(orgB, "Store admin organization B", "USD")
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH_A",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: orgA
            })
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH_A2",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: orgA
            })
            make("mantle.facility.Facility", {
                facilityId: prefix + "_WH_B",
                facilityTypeEnumId: "FcTpWarehouse",
                ownerPartyId: orgB
            })
            person(prefix + "_CLERK", orgA)
            person(prefix + "_OUTSIDER", orgB)
            make("mantle.party.Party", {partyId: prefix + "_CUST", partyTypeEnumId: "PtyPerson"})
            make("mantle.party.Person", {partyId: prefix + "_CUST", firstName: "Store", lastName: "Customer"})
            make("mantle.product.category.ProductCategory", {
                productCategoryId: prefix + "_CAT",
                categoryName: "Store admin root"
            })
            make("mantle.other.tax.TaxGatewayConfig", {
                taxGatewayConfigId: prefix + "_TAX",
                description: "Store admin tax",
                taxGatewayTypeEnumId: "TaxGtwyLocal"
            })
            make("moqui.basic.email.EmailTemplate", {emailTemplateId: prefix + "_MAIL", description: "Store admin notice"})
            make("moqui.resource.wiki.WikiSpace", {wikiSpaceId: prefix + "_PRIVATE", description: "Private", restrictView: "Y"})
            make("moqui.resource.wiki.WikiSpace", {wikiSpaceId: prefix + "_PUBLIC", description: "Public pages"})
            users.reader = user("reader", orgA, ["COMMERCE_VIEW"])
            users.manager = user("manager", orgA, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            users.other = user("other", orgB, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            users.limited = user("limited", orgA, ["COMMERCE_VIEW", "COMMERCE_STORE_EDIT"])
            users.editor = user("editor", orgA, ["COMMERCE_STORE_EDIT"])
        })
        // two stores of organization A; the store-limited member is staff of the first only
        ids.store = run(users.manager, A + "store#Store", {
            storeName: "Store admin one",
            organizationPartyId: orgA
        }).productStoreId
        ids.second = run(users.manager, A + "store#Store", {
            storeName: "Store admin two",
            organizationPartyId: orgA
        }).productStoreId
        run(users.manager, A + "store#StoreParty", {productStoreId: ids.store, partyId: users.limited})
    }
})

feature(
    "a manager starts a store with its organization's currency and no site; a reader cannot, another organization's manager is refused it",
    {
        when() {
            const params = {storeName: "Store admin three", organizationPartyId: orgA, facilityId: prefix + "_WH_A"}
            const reader = run(users.reader, A + "store#Store", params)
            const editOnly = run(users.editor, A + "store#Store", params)
            const created = run(users.manager, A + "store#Store", params)
            ids.third = created.productStoreId
            const store = run(users.manager, A + "get#Store", {productStoreId: ids.third, include: ["facilities"]})
            const sites = run(users.manager, A + "get#StoreSites", {productStoreId: ids.third})
            const other = run(users.other, A + "get#Store", {productStoreId: ids.third})
            const otherOrg = run(users.other, A + "store#Store", Object.assign({}, params, {facilityId: null}))
            const foreignFacility = run(
                users.manager,
                A + "store#Store",
                Object.assign({}, params, {facilityId: prefix + "_WH_B"})
            )
            const otherList = run(users.other, A + "find#Stores", {term: "store admin"})
            return {reader, editOnly, created, store, sites, other, otherOrg, foreignFacility, otherList}
        },
        then({reader, editOnly, created, store, sites, other, otherOrg, foreignFacility, otherList}) {
            code(reader) == "PERMISSION_DENIED"
            code(editOnly) == "PERMISSION_DENIED"
            created.error == ""
            created.created == true
            store.store.defaultCurrencyUomId == "EUR"
            store.store.organizationPartyId == orgA
            store.canEdit == true
            store.facilities.map(row => row.facilityId) == [prefix + "_WH_A"]
            sites.sites == []
            code(other) == "RECORD_UNAVAILABLE"
            code(otherOrg) == "ORGANIZATION_UNAVAILABLE"
            code(foreignFacility) == "FACILITY_UNAVAILABLE"
            otherList.stores == []
        }
    }
)

feature("a store-limited staff member works only their stores: the others of the organization are refused and left out", {
    when() {
        return {
            found: run(users.limited, A + "find#Stores", {term: "store admin"}),
            own: run(users.limited, A + "get#Store", {productStoreId: ids.store}),
            second: run(users.limited, A + "get#Store", {productStoreId: ids.second}),
            save: run(users.limited, A + "store#StoreSetting", {
                productStoreId: ids.second,
                settingTypeEnumId: "PsstShipLabelName",
                settingValue: "Two"
            }),
            start: run(users.limited, A + "store#Store", {storeName: "Limited", organizationPartyId: orgA}),
            // ending their own staff row would widen them to every store of the organization
            endOwn: run(users.limited, A + "store#StoreParty", {productStoreId: ids.store, partyId: users.limited, end: true}),
            manager: run(users.manager, A + "find#Stores", {term: "store admin"})
        }
    },
    then({found, own, second, save, start, endOwn, manager}) {
        found.stores.map(row => row.productStoreId) == [ids.store]
        own.error == ""
        code(second) == "RECORD_UNAVAILABLE"
        code(save) == "RECORD_UNAVAILABLE"
        code(start) == "STORE_LIMITED"
        code(endOwn) == "STORE_LIMITED"
        manager.stores.length == 3
    }
})

feature(
    "a dated child row from a date ends the one it replaces; each save refuses what is not the store organization's or registered",
    {
        when() {
            const at = Date.now()
            const facility = p =>
                run(
                    users.manager,
                    A + "store#StoreFacility",
                    Object.assign({productStoreId: ids.store, facilityId: prefix + "_WH_A"}, p)
                )
            const first = facility({fromDate: at - 86400000, sequenceNum: 1})
            const replaced = facility({fromDate: at + 60000, sequenceNum: 2})
            const later = facility({fromDate: at, sequenceNum: 3})
            const rowsFound = list(S + "ProductStoreFacility", {productStoreId: ids.store, facilityId: prefix + "_WH_A"})
            const foreign = run(users.manager, A + "store#StoreFacility", {
                productStoreId: ids.store,
                facilityId: prefix + "_WH_B"
            })
            const staff = run(users.manager, A + "store#StoreParty", {productStoreId: ids.store, partyId: prefix + "_CLERK"})
            const customerRole = run(users.manager, A + "store#StoreParty", {
                productStoreId: ids.store,
                partyId: prefix + "_CLERK",
                roleTypeId: "CustomerBillTo"
            })
            const outsider = run(users.manager, A + "store#StoreParty", {
                productStoreId: ids.store,
                partyId: prefix + "_OUTSIDER"
            })
            const setting = run(users.manager, A + "store#StoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstShipLabelMarkup",
                settingValue: "12.5"
            })
            const badPercent = run(users.manager, A + "store#StoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstShipLabelMarkup",
                settingValue: "120"
            })
            const location = run(users.manager, A + "store#StoreSetting", {
                productStoreId: ids.store,
                settingTypeEnumId: "PsstTemplateOrderPrint",
                settingValue: "component://x.ftl"
            })
            const email = run(users.manager, A + "store#StoreEmail", {
                productStoreId: ids.store,
                emailTypeEnumId: "PsetOrderPlaced",
                emailTemplateId: prefix + "_MAIL",
                detailLinkPath: "/order"
            })
            const unknownTemplate = run(users.manager, A + "store#StoreEmail", {
                productStoreId: ids.store,
                emailTypeEnumId: "PsetOrderPlaced",
                emailTemplateId: prefix + "_NONE"
            })
            const offSite = run(users.manager, A + "store#StoreEmail", {
                productStoreId: ids.store,
                emailTypeEnumId: "PsetCartRecovery",
                emailTemplateId: prefix + "_MAIL",
                detailLinkPath: "https://elsewhere.example.com/x"
            })
            const check = run(users.manager, A + "store#StoreApproval", {
                productStoreId: ids.store,
                serviceRegisterId: "OrderManualApprove"
            })
            const promotion = run(users.manager, A + "store#StoreApproval", {
                productStoreId: ids.store,
                serviceRegisterId: "FlatDiscount"
            })
            const extraParameter = run(users.manager, A + "store#StoreApproval", {
                productStoreId: ids.store,
                serviceRegisterId: "OrderManualApprove",
                parameters: {serviceName: "x"}
            })
            const document = run(users.manager, A + "store#StoreContentBinding", {
                productStoreId: ids.store,
                typeEnumId: "PsdtProduct",
                dataDocumentId: "MantleProduct"
            })
            const wrongDocument = run(users.manager, A + "store#StoreContentBinding", {
                productStoreId: ids.store,
                typeEnumId: "PsdtCategory",
                dataDocumentId: "MantleProduct"
            })
            const privateSpace = run(users.manager, A + "store#StoreContentBinding", {
                productStoreId: ids.store,
                spaceTypeEnumId: "PstFull",
                wikiSpaceId: prefix + "_PRIVATE"
            })
            const space = run(users.manager, A + "store#StoreContentBinding", {
                productStoreId: ids.store,
                spaceTypeEnumId: "PstFull",
                wikiSpaceId: prefix + "_PUBLIC"
            })
            const reader = run(users.reader, A + "store#StoreFacility", {
                productStoreId: ids.store,
                facilityId: prefix + "_WH_A2"
            })
            const read = run(users.reader, A + "get#Store", {
                productStoreId: ids.store,
                include: ["staff", "settings", "emails", "approvals", "content"]
            })
            return {
                first,
                replaced,
                later,
                rowsFound,
                foreign,
                staff,
                customerRole,
                outsider,
                setting,
                badPercent,
                location,
                email,
                unknownTemplate,
                offSite,
                check,
                promotion,
                extraParameter,
                document,
                wrongDocument,
                privateSpace,
                space,
                reader,
                read,
                at
            }
        },
        then(r) {
            r.first.error == ""
            r.replaced.error == ""
            code(r.later) == "DATED_OVERLAP"
            r.rowsFound.length == 2
            Number(r.rowsFound.find(row => row.sequenceNum == 1).thruDate) == r.at + 60000
            r.rowsFound.find(row => row.sequenceNum == 2).thruDate == null
            code(r.foreign) == "FACILITY_UNAVAILABLE"
            r.staff.error == ""
            code(r.customerRole) == "ROLE_NOT_STAFF"
            code(r.outsider) == "PARTY_UNAVAILABLE"
            r.setting.error == ""
            code(r.badPercent) == "VALUE_INVALID"
            code(r.location) == "SETTING_NOT_EDITABLE"
            r.email.error == ""
            code(r.unknownTemplate) == "VALUE_INVALID"
            code(r.offSite) == "VALUE_INVALID"
            r.check.error == ""
            code(r.promotion) == "CHECK_NOT_REGISTERED"
            code(r.extraParameter) == "VALUE_INVALID"
            r.document.error == ""
            code(r.wrongDocument) == "DOCUMENT_NOT_REGISTERED"
            code(r.privateSpace) == "SPACE_PRIVATE"
            r.space.error == ""
            code(r.reader) == "PERMISSION_DENIED"
            r.read.staff.map(row => row.partyId).sort() == [prefix + "_CLERK", users.limited].sort()
            r.read.settings.map(row => row.settingValue) == ["12.5"]
            r.read.emails.map(row => row.templateText) == ["Store admin notice"]
            r.read.approvals.length == 1
            r.read.content.documents.map(row => row.dataDocumentId) == ["MantleProduct"]
            r.read.content.spaces.map(row => row.wikiSpaceId) == [prefix + "_PUBLIC"]
            r.read.canEdit == false
        }
    }
)

feature("a policy change needs its reason and is in History with the user and reason; a stale revision is refused", {
    when() {
        const before = run(users.manager, A + "get#Store", {productStoreId: ids.second}).store
        const noReason = run(users.manager, A + "store#Store", {productStoreId: ids.second, taxGatewayConfigId: prefix + "_TAX"})
        const changed = run(users.manager, A + "store#Store", {
            productStoreId: ids.second,
            taxGatewayConfigId: prefix + "_TAX",
            changeReason: "Moved to the regional tax service",
            expectedLastUpdatedStamp: before.lastUpdatedStamp
        })
        const stale = run(users.manager, A + "store#Store", {
            productStoreId: ids.second,
            storeName: "Renamed",
            expectedLastUpdatedStamp: before.lastUpdatedStamp
        })
        const renamed = run(users.manager, A + "store#Store", {productStoreId: ids.second, storeName: "Store admin two, renamed"})
        const history = run(users.reader, A + "get#Store", {productStoreId: ids.second, include: ["history"]}).history
        return {noReason, changed, stale, renamed, history}
    },
    then({noReason, changed, stale, renamed, history}) {
        code(noReason) == "REASON_REQUIRED"
        changed.error == ""
        code(stale) == "STALE_REVISION"
        renamed.error == ""
        history.some(
            row =>
                row.fieldText == "Tax gateway" &&
                row.newValueText == prefix + "_TAX" &&
                row.changeReason == "Moved to the regional tax service" &&
                row.userText != ""
        )
        history.some(row => row.fieldText == "Currency" && row.newValueText == "EUR")
    }
})

feature(
    "a clone copies categories, facilities and staff, never the customers' party rows or products, starts unpublished and needs approval",
    {
        when() {
            system(() => {
                make(S + "ProductStoreCategory", {
                    productStoreId: ids.store,
                    productCategoryId: prefix + "_CAT",
                    storeCategoryTypeEnumId: "PsctBrowseRoot",
                    fromDate: 0
                })
                make(S + "ProductStoreParty", {
                    productStoreId: ids.store,
                    partyId: prefix + "_CUST",
                    roleTypeId: "CustomerBillTo",
                    fromDate: 0
                })
                make(S + "ProductStoreProduct", {productStoreId: ids.store, productId: "DEMO_1_1"})
                make(S + "ProductStoreFacility", {productStoreId: ids.store, facilityId: prefix + "_WH_B", fromDate: 0})
            })
            const base = run(users.manager, A + "get#Store", {productStoreId: ids.store}).store
            const preview = run(users.manager, A + "clone#Store", {baseProductStoreId: ids.store, preview: true})
            const params = {
                baseProductStoreId: ids.store,
                storeName: "Store admin clone",
                expectedLastUpdatedStamp: base.lastUpdatedStamp
            }
            const unapproved = run(users.manager, A + "clone#Store", Object.assign({operationKey: prefix + "-clone-1"}, params))
            const cloned = run(
                users.manager,
                A + "clone#Store",
                Object.assign({operationKey: prefix + "-clone-2", approveReferences: true}, params)
            )
            const retried = run(
                users.manager,
                A + "clone#Store",
                Object.assign({operationKey: prefix + "-clone-2", approveReferences: true}, params)
            )
            const clone = cloned.productStoreId
            return {
                preview,
                unapproved,
                cloned,
                retried,
                categories: list(S + "ProductStoreCategory", {productStoreId: clone}).map(row => row.productCategoryId),
                // the base's two dated rows of its own facility (the one ending and its replacement), never the other organization's
                facilities: Array.from(
                    new Set(current(list(S + "ProductStoreFacility", {productStoreId: clone})).map(row => row.facilityId))
                ),
                parties: list(S + "ProductStoreParty", {productStoreId: clone})
                    .map(row => row.partyId + ":" + row.roleTypeId)
                    .sort(),
                products: list(S + "ProductStoreProduct", {productStoreId: clone}),
                mounts: list("mantle.public.PublicSiteApp", {app: "shop", targetId: clone}),
                limited: run(
                    users.limited,
                    A + "clone#Store",
                    Object.assign({operationKey: prefix + "-clone-3", approveReferences: true}, params)
                )
            }
        },
        then({preview, unapproved, cloned, retried, categories, facilities, parties, products, mounts, limited}) {
            preview.error == ""
            preview.productStoreId == null
            preview.sections.find(row => row.section == "customers").leftOut == 1
            preview.sections.find(row => row.section == "products").leftOut == 1
            preview.sections.find(row => row.section == "facilities").leftOut == 1
            preview.references.some(row => row.kind == "Staff member" && row.id == prefix + "_CLERK")
            code(unapproved) == "CLONE_APPROVAL_REQUIRED"
            cloned.error == ""
            retried.productStoreId == cloned.productStoreId
            retried.alreadyApplied == true
            categories == [prefix + "_CAT"]
            facilities == [prefix + "_WH_A"]
            parties == [prefix + "_CLERK:StoreStaff", users.limited + ":StoreStaff"].sort()
            products == []
            mounts == []
            code(limited) == "STORE_LIMITED"
        }
    }
)

feature("readiness names what a new store is missing, a facility only warns, and the PASS form answers the checks by name", {
    when() {
        const created = run(users.manager, A + "store#Store", {storeName: "Store admin ready", organizationPartyId: orgA})
        const before = run(users.reader, A + "check#StoreReadiness", {productStoreId: created.productStoreId})
        run(users.manager, A + "store#StoreFacility", {productStoreId: created.productStoreId, facilityId: prefix + "_WH_A"})
        const after = run(users.reader, A + "check#StoreReadiness", {productStoreId: created.productStoreId})
        const pass = run(users.reader, A + "check#StoreReadiness", {
            input: {siteId: "NONE", app: "shop", targetId: created.productStoreId}
        })
        const other = run(users.other, A + "check#StoreReadiness", {productStoreId: created.productStoreId})
        const state = finding => before.findings.find(row => row.key == finding)
        return {before, after, pass, other, state}
    },
    then({before, after, pass, other, state}) {
        before.ready == false
        state("site").ready == false
        state("site").fix == "sites"
        state("tax").ready == false
        state("orderNotice").ready == false
        state("currency").ready == true
        state("facility").severity == "warning"
        after.findings.find(row => row.key == "facility").ready == true
        pass.findings == []
        pass.result.checks.some(row => row.name == "site" && row.ready == false)
        !pass.result.checks.some(row => row.name == "fulfillment")
        code(other) == "RECORD_UNAVAILABLE"
    }
})

feature(
    "a store group holds its organization's stores from a date, refuses another organization's, and is scoped like its stores",
    {
        when() {
            const otherStore = run(users.other, A + "store#Store", {
                storeName: "Store admin B",
                organizationPartyId: orgB
            }).productStoreId
            const group = run(users.manager, A + "store#StoreGroup", {
                organizationPartyId: orgA,
                description: "Store admin region",
                storeGroupTypeEnumId: "PsgtRegion"
            })
            const groupId = group.productStoreGroupId
            const member = run(users.manager, A + "store#StoreGroup", {productStoreGroupId: groupId, memberStoreId: ids.store})
            const second = run(users.manager, A + "store#StoreGroup", {productStoreGroupId: groupId, memberStoreId: ids.second})
            const foreign = run(users.other, A + "store#StoreGroup", {productStoreGroupId: groupId, memberStoreId: otherStore})
            const party = run(users.manager, A + "store#StoreGroup", {productStoreGroupId: groupId, partyId: prefix + "_CLERK"})
            const badType = run(users.manager, A + "store#StoreGroup", {
                organizationPartyId: orgA,
                description: "Bad",
                storeGroupTypeEnumId: "PsetOrderPlaced"
            })
            const read = run(users.reader, A + "find#StoreGroups", {productStoreGroupId: groupId})
            const limitedRead = run(users.limited, A + "find#StoreGroups", {productStoreGroupId: groupId})
            const limitedEdit = run(users.limited, A + "store#StoreGroup", {productStoreGroupId: groupId, description: "Mine"})
            const other = run(users.other, A + "find#StoreGroups", {})
            const byGroup = run(users.reader, A + "find#Stores", {productStoreGroupId: groupId})
            return {group, member, second, foreign, party, badType, read, limitedRead, limitedEdit, other, byGroup, groupId}
        },
        then(r) {
            r.group.created == true
            r.member.error == ""
            r.second.error == ""
            code(r.foreign) == "RECORD_UNAVAILABLE"
            r.party.error == ""
            code(r.badType) == "VALUE_INVALID"
            r.read.group.typeText == "Region"
            r.read.group.organizationPartyId == orgA
            r.read.group.memberCount == 2
            r.read.group.parties.map(row => row.partyId) == [prefix + "_CLERK"]
            r.read.groups.some(row => row.productStoreGroupId == r.groupId)
            r.limitedRead.group.members.map(row => row.productStoreId) == [ids.store]
            code(r.limitedEdit) == "RECORD_UNAVAILABLE"
            !r.other.groups.some(row => row.productStoreGroupId == r.groupId)
            r.byGroup.stores.map(row => row.productStoreId).sort() == [ids.store, ids.second].sort()
        }
    }
)
