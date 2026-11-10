// The RequestContent types a request's customer side may see: a client on a project request (BOSS record files) and the
// customer audience of a case's files (CaseRelations). Internal, unclassified and case summary files stay with the team:
// a case summary (RqCntCaseSummary) is the record of what was sent, never itself a shared file (SupportPortalEntities.xml).
const customerContentTypeIds = [
    "RqCntUserDefined",
    "RqCntDocumentation",
    "RqCntStory",
    "RqCntImage",
    "RqCntCustomerShared",
    "RqCntRfqPublished"
]
function customerVisibleContentType(contentTypeEnumId) {
    return !!contentTypeEnumId && customerContentTypeIds.includes(String(contentTypeEnumId))
}
;({customerContentTypeIds, customerVisibleContentType})
