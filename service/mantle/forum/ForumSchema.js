/* CC0 plus patent grant. */
;({
    findSites: {
        service: 'mantle.public.SiteServices.find#Sites',
        fields: ['siteId', 'limit', 'cursor'],
    },
    createSite: {
        service: 'mantle.public.SiteServices.create#Site',
        fields: ['name', 'ownerPartyId', 'locale', 'timeZone'],
    },
    updateSite: {
        service: 'mantle.public.SiteServices.update#Site',
        fields: [
            'siteId',
            'expectedRevision',
            'name',
            'locale',
            'timeZone',
            'state',
            'subscriptionUrl',
            'publishingWikiSpaceId',
        ],
    },
    getMembership: {
        service: 'mantle.public.SiteServices.get#Membership',
        fields: ['siteId'],
    },
    joinSite: {
        service: 'mantle.public.SiteServices.join#Site',
        fields: ['siteId'],
    },
    leaveSite: {
        service: 'mantle.public.SiteServices.leave#Site',
        fields: ['siteId', 'expectedRevision'],
    },
    setMembership: {
        service: 'mantle.public.SiteServices.set#Membership',
        fields: [
            'siteId',
            'targetPartyId',
            'state',
            'expectedRevision',
            'reason',
        ],
    },
    setSiteRole: {
        service: 'mantle.public.SiteServices.set#SiteRole',
        fields: [
            'siteId',
            'targetPartyId',
            'role',
            'expectedRevision',
            'password',
            'code',
            'reason',
        ],
    },
    findMembers: {
        service: 'mantle.public.SiteServices.find#Members',
        fields: ['siteId', 'limit', 'cursor'],
    },
    storeProfile: {
        service: 'mantle.public.SiteServices.store#Profile',
        fields: [
            'siteId',
            'handle',
            'displayName',
            'avatarId',
            'bio',
            'discoverability',
            'locale',
            'timeZone',
            'expectedRevision',
        ],
    },
    getProfile: {
        service: 'mantle.public.SiteServices.get#Profile',
        fields: ['siteId', 'handle'],
    },
    getSitePage: {
        service: 'mantle.public.SiteServices.get#SitePage',
        fields: ['siteId', 'pageRole'],
    },
    checkReadiness: {
        service: 'mantle.public.SiteServices.check#Readiness',
        fields: ['siteId'],
    },
    storeMounts: {
        service: 'mantle.public.SiteServices.store#Mounts',
        fields: ['siteId', 'mounts', 'hosts', 'expectedRevision'],
    },
    updateMembershipPolicy: {
        service: 'mantle.public.SiteServices.update#MembershipPolicy',
        fields: [
            'siteId',
            'registrationMode',
            'approvalRequired',
            'expectedRevision',
        ],
    },
    createInvitation: {
        service: 'mantle.public.SiteServices.create#Invitation',
        fields: ['siteId', 'emailAddress', 'expiresAt', 'operationId'],
    },
    inspectInvitation: {
        service: 'mantle.public.SiteServices.inspect#Invitation',
        fields: ['siteId', 'token', 'emailAddress'],
    },
    redeemInvitation: {
        service: 'mantle.public.SiteServices.redeem#Invitation',
        fields: ['siteId', 'token'],
    },
    revokeInvitation: {
        service: 'mantle.public.SiteServices.revoke#Invitation',
        fields: ['siteId', 'invitationId'],
    },
    findCategories: {
        service: 'mantle.forum.ForumServices.find#Categories',
        fields: ['siteId', 'limit', 'cursor'],
    },
    getCategory: {
        service: 'mantle.forum.ForumServices.get#Category',
        fields: ['siteId', 'contactListId'],
    },
    storeCategory: {
        service: 'mantle.forum.ForumServices.store#Category',
        fields: [
            'siteId',
            'contactListId',
            'parentContactListId',
            'name',
            'slug',
            'sequenceNum',
            'rules',
            'expectedRevision',
            'confirmAudience',
            'operationId',
            'mode',
        ],
    },
    previewCategoryAccess: {
        service: 'mantle.forum.ForumServices.preview#CategoryAccess',
        fields: ['siteId', 'contactListId', 'visibility', 'qualifyingSources'],
    },
    setCategoryAccess: {
        service: 'mantle.forum.ForumServices.set#CategoryAccess',
        fields: [
            'siteId',
            'contactListId',
            'visibility',
            'publicationState',
            'expectedRevision',
            'confirm',
            'qualifyingSources',
        ],
    },
    findTopics: {
        service: 'mantle.forum.ForumServices.find#Topics',
        fields: [
            'siteId',
            'contactListId',
            'query',
            'limit',
            'cursor',
            'view',
            'authorHandle',
            'tag',
            'solved',
            'period',
        ],
    },
    getTopic: {
        service: 'mantle.forum.ForumServices.get#Topic',
        fields: ['siteId', 'rootCommEventId'],
    },
    getPosts: {
        service: 'mantle.forum.ForumServices.get#Posts',
        fields: [
            'siteId',
            'rootCommEventId',
            'limit',
            'cursor',
            'before',
            'after',
            'around',
        ],
    },
    searchForum: {
        service: 'mantle.forum.ForumServices.search#Forum',
        fields: [
            'siteId',
            'contactListId',
            'query',
            'limit',
            'cursor',
            'scope',
        ],
    },
    storeDraft: {
        service: 'mantle.forum.ForumServices.store#Draft',
        fields: [
            'siteId',
            'draftId',
            'mode',
            'contactListId',
            'rootCommEventId',
            'parentCommEventId',
            'title',
            'body',
            'expectedRevision',
            'postId',
            'postRevision',
            'tags',
            'poll',
        ],
    },
    findDrafts: {
        service: 'mantle.forum.ForumServices.find#Drafts',
        fields: ['siteId', 'limit', 'cursor'],
    },
    discardDraft: {
        service: 'mantle.forum.ForumServices.discard#Draft',
        fields: ['siteId', 'draftId', 'expectedRevision'],
    },
    previewPost: {
        service: 'mantle.forum.ForumServices.preview#Post',
        fields: ['siteId', 'body'],
    },
    publishPost: {
        service: 'mantle.forum.ForumServices.publish#Post',
        fields: [
            'siteId',
            'contactListId',
            'rootCommEventId',
            'parentCommEventId',
            'title',
            'body',
            'operationId',
            'attachmentIds',
            'draftId',
            'tags',
            'poll',
        ],
    },
    updatePost: {
        service: 'mantle.forum.ForumServices.update#Post',
        fields: [
            'siteId',
            'postId',
            'body',
            'expectedRevision',
            'reason',
            'draftId',
            'attachmentIds',
        ],
    },
    markRead: {
        service: 'mantle.forum.ForumServices.mark#Read',
        fields: [
            'siteId',
            'rootCommEventId',
            'ordinal',
            'expectedRevision',
            'markUnread',
            'renderedPostIds',
            'jump',
        ],
    },
    flagPost: {
        service: 'mantle.forum.ModerationServices.flag#Post',
        fields: ['siteId', 'postId', 'reason', 'operationId'],
    },
    findReviews: {
        service: 'mantle.forum.ModerationServices.find#Reviews',
        fields: ['siteId', 'contactListId', 'limit', 'cursor'],
    },
    getReview: {
        service: 'mantle.forum.ModerationServices.get#Review',
        fields: ['siteId', 'reviewId'],
    },
    claimReview: {
        service: 'mantle.forum.ModerationServices.claim#Review',
        fields: ['siteId', 'reviewId', 'expectedRevision'],
    },
    decideReview: {
        service: 'mantle.forum.ModerationServices.decide#Review',
        fields: [
            'siteId',
            'reviewId',
            'expectedRevision',
            'decision',
            'reason',
        ],
    },
    applyTopicAction: {
        service: 'mantle.forum.ModerationServices.apply#TopicAction',
        fields: [
            'siteId',
            'rootCommEventId',
            'action',
            'title',
            'expectedRevision',
            'reason',
            'targetContactListId',
            'confirmAudience',
            'expectedGeneration',
            'postId',
            'active',
            'postIds',
            'targetRootCommEventId',
            'slowIntervalSeconds',
            'timerAction',
            'dueAt',
        ],
    },
    findActions: {
        service: 'mantle.forum.ModerationServices.find#Actions',
        fields: ['siteId', 'contactListId', 'limit', 'cursor'],
    },
    setSanction: {
        service: 'mantle.forum.ModerationServices.set#Sanction',
        fields: [
            'siteId',
            'contactListId',
            'targetPartyId',
            'kind',
            'thruDate',
            'reason',
            'operationId',
        ],
    },
    getMember: {
        service: 'mantle.forum.ModerationServices.get#Member',
        fields: ['siteId', 'contactListId', 'targetPartyId'],
    },
    getPreferences: {
        service: 'mantle.forum.DeliveryServices.get#Preferences',
        fields: ['siteId', 'scopeType', 'scopeId'],
    },
    setPreferences: {
        service: 'mantle.forum.DeliveryServices.set#Preferences',
        fields: [
            'siteId',
            'scopeType',
            'scopeId',
            'watchLevel',
            'emailMode',
            'expectedRevision',
            'digestPeriod',
            'includeOwn',
        ],
    },
    findDeliveries: {
        service: 'mantle.forum.DeliveryServices.find#Deliveries',
        fields: ['siteId', 'limit', 'cursor'],
    },
    storeMailSettings: {
        service: 'mantle.forum.DeliveryServices.store#MailSettings',
        fields: [
            'siteId',
            'senderAddress',
            'senderName',
            'templateId',
            'expectedRevision',
        ],
    },
    inspectOptOut: {
        service: 'mantle.forum.DeliveryServices.inspect#OptOut',
        fields: ['siteId', 'token'],
    },
    applyOptOut: {
        service: 'mantle.forum.DeliveryServices.apply#OptOut',
        fields: ['siteId', 'token', 'scopeType'],
    },
    getHealth: {
        service: 'mantle.forum.OperationServices.get#Health',
        fields: ['siteId', 'cursor', 'limit'],
    },
    stageAttachment: {
        service: 'mantle.forum.ForumServices.stage#Attachment',
        fields: [
            'siteId',
            'contactListId',
            'draftId',
            'file',
            'altText',
            'purpose',
            'rootCommEventId',
        ],
    },
    removeStagedAttachment: {
        service: 'mantle.forum.ForumServices.remove#StagedAttachment',
        fields: ['siteId', 'attachmentId'],
    },
    getAttachment: {
        service: 'mantle.forum.ForumServices.get#Attachment',
        fields: ['siteId', 'attachmentId', 'variant'],
    },
    findNotifications: {
        service: 'mantle.forum.DeliveryServices.find#Notifications',
        fields: ['siteId', 'cursor', 'limit', 'view'],
    },
    markNotifications: {
        service: 'mantle.forum.DeliveryServices.mark#Notifications',
        fields: ['siteId', 'deliveryIds', 'all'],
    },
    storePolicy: {
        service: 'mantle.forum.ModerationServices.store#Policy',
        fields: ['siteId', 'config', 'expectedRevision', 'reason'],
    },
    getPolicy: {
        service: 'mantle.forum.ModerationServices.get#Policy',
        fields: ['siteId'],
    },
    getSiteInfo: {
        service: 'mantle.public.SiteServices.get#SiteInfo',
        fields: ['siteId', 'hostname'],
    },
    getDraft: {
        service: 'mantle.forum.ForumServices.get#Draft',
        fields: ['siteId', 'draftId'],
    },
    joinCategory: {
        service: 'mantle.forum.ForumServices.join#Category',
        fields: ['siteId', 'contactListId'],
    },
    leaveCategory: {
        service: 'mantle.forum.ForumServices.leave#Category',
        fields: ['siteId', 'contactListId'],
    },
    findCategoryMembers: {
        service: 'mantle.forum.ForumServices.find#CategoryMembers',
        fields: ['siteId', 'contactListId', 'cursor', 'limit'],
    },
    setCategoryMember: {
        service: 'mantle.forum.ForumServices.set#CategoryMember',
        fields: [
            'siteId',
            'contactListId',
            'targetPartyId',
            'state',
            'roleTypeId',
            'expectedRevision',
            'reason',
            'password',
            'code',
        ],
    },
    bindMailbox: {
        service: 'mantle.forum.ForumServices.bind#Mailbox',
        fields: ['siteId', 'contactListId', 'operationId', 'confirm'],
    },
    findRuns: {
        service: 'mantle.forum.OperationServices.find#Runs',
        fields: ['siteId', 'cursor', 'limit'],
    },
    publishSitePage: {
        service: 'mantle.public.SiteServices.publish#SitePage',
        fields: [
            'siteId',
            'pageRole',
            'wikiPageId',
            'versionName',
            'expectedRevision',
        ],
    },
    getFeed: {
        service: 'mantle.forum.ForumServices.get#Feed',
        fields: ['siteId', 'format'],
    },
    getPostLocation: {
        service: 'mantle.forum.ForumServices.get#PostLocation',
        fields: ['siteId', 'postId'],
    },
    getEditablePost: {
        service: 'mantle.forum.ForumServices.get#EditablePost',
        fields: ['siteId', 'postId'],
    },
    previewTopicAction: {
        service: 'mantle.forum.ModerationServices.preview#TopicAction',
        fields: [
            'siteId',
            'rootCommEventId',
            'targetContactListId',
            'action',
            'postIds',
            'targetRootCommEventId',
        ],
    },
    resolveDelivery: {
        service: 'mantle.forum.DeliveryServices.resolve#Delivery',
        fields: [
            'siteId',
            'deliveryId',
            'expectedRevision',
            'decision',
            'reason',
        ],
    },
    addReviewNote: {
        service: 'mantle.forum.ModerationServices.add#ReviewNote',
        fields: ['siteId', 'reviewId', 'body', 'operationId'],
    },
    manageRun: {
        service: 'mantle.forum.OperationServices.manage#Run',
        fields: ['siteId', 'runId', 'action', 'reason'],
    },
    endSanction: {
        service: 'mantle.forum.ModerationServices.end#Sanction',
        fields: ['siteId', 'sanctionId', 'expectedRevision', 'reason'],
    },
    findTags: {
        service: 'mantle.forum.ForumServices.find#Tags',
        fields: ['siteId', 'query', 'limit', 'cursor'],
    },
    storeTag: {
        service: 'mantle.forum.ForumServices.store#Tag',
        fields: [
            'siteId',
            'tagId',
            'name',
            'description',
            'allowedCategories',
            'expectedRevision',
            'reason',
            'operationId',
        ],
    },
    mergeTag: {
        service: 'mantle.forum.ForumServices.merge#Tag',
        fields: [
            'siteId',
            'tagId',
            'targetTagId',
            'expectedRevision',
            'reason',
            'operationId',
        ],
    },
    setReaction: {
        service: 'mantle.forum.ForumServices.set#Reaction',
        fields: ['siteId', 'postId', 'reactionKey', 'active'],
    },
    acceptAnswer: {
        service: 'mantle.forum.ForumServices.accept#Answer',
        fields: [
            'siteId',
            'rootCommEventId',
            'postId',
            'expectedRevision',
            'reason',
        ],
    },
    getPoll: {
        service: 'mantle.forum.ForumServices.get#Poll',
        fields: ['siteId', 'pollId'],
    },
    votePoll: {
        service: 'mantle.forum.ForumServices.vote#Poll',
        fields: ['siteId', 'pollId', 'optionIds'],
    },
    storeBookmark: {
        service: 'mantle.forum.ForumServices.store#Bookmark',
        fields: [
            'siteId',
            'bookmarkId',
            'postId',
            'note',
            'remindAt',
            'expectedRevision',
        ],
    },
    removeBookmark: {
        service: 'mantle.forum.ForumServices.remove#Bookmark',
        fields: ['siteId', 'bookmarkId'],
    },
    findBookmarks: {
        service: 'mantle.forum.ForumServices.find#Bookmarks',
        fields: ['siteId', 'limit', 'cursor'],
    },
    getPostHistory: {
        service: 'mantle.forum.ForumServices.get#PostHistory',
        fields: ['siteId', 'postId'],
    },
    comparePostRevisions: {
        service: 'mantle.forum.ForumServices.compare#PostRevisions',
        fields: ['siteId', 'postId', 'fromRevision', 'toRevision'],
    },
    restorePostRevision: {
        service: 'mantle.forum.ForumServices.restore#PostRevision',
        fields: ['siteId', 'postId', 'revision', 'expectedRevision', 'reason'],
    },
    deletePost: {
        service: 'mantle.forum.ForumServices.delete#Post',
        fields: ['siteId', 'postId', 'expectedRevision', 'reason'],
    },
    storeRule: {
        service: 'mantle.forum.ModerationServices.store#Rule',
        fields: [
            'siteId',
            'ruleId',
            'contactListId',
            'ruleType',
            'pattern',
            'action',
            'active',
            'sequenceNum',
            'expectedRevision',
            'reason',
            'operationId',
        ],
    },
    findRules: {
        service: 'mantle.forum.ModerationServices.find#Rules',
        fields: ['siteId'],
    },
    testRule: {
        service: 'mantle.forum.ModerationServices.test#Rule',
        fields: ['siteId', 'ruleType', 'pattern', 'body'],
    },
    setTrust: {
        service: 'mantle.forum.ModerationServices.set#Trust',
        fields: [
            'siteId',
            'targetPartyId',
            'trustLevel',
            'locked',
            'reason',
            'expectedRevision',
        ],
    },
    decideReviews: {
        service: 'mantle.forum.ModerationServices.decide#Reviews',
        fields: ['siteId', 'reviewIds', 'decision', 'reason'],
    },
    appealReview: {
        service: 'mantle.forum.ModerationServices.appeal#Review',
        fields: ['siteId', 'reviewId', 'reason', 'operationId'],
    },
    findMyReviews: {
        service: 'mantle.forum.ModerationServices.find#MyReviews',
        fields: ['siteId'],
    },
    createConversation: {
        service: 'mantle.forum.ForumServices.create#Conversation',
        fields: [
            'siteId',
            'participantHandles',
            'title',
            'body',
            'attachmentIds',
            'operationId',
        ],
    },
    findConversations: {
        service: 'mantle.forum.ForumServices.find#Conversations',
        fields: ['siteId', 'view', 'limit', 'cursor'],
    },
    updateParticipants: {
        service: 'mantle.forum.ForumServices.update#Participants',
        fields: [
            'siteId',
            'rootCommEventId',
            'participantHandles',
            'targetHandles',
            'ownerHandles',
            'confirm',
            'expectedRevision',
        ],
    },
    setConversationState: {
        service: 'mantle.forum.ForumServices.set#ConversationState',
        fields: ['siteId', 'rootCommEventId', 'action'],
    },
    setMemberPreference: {
        service: 'mantle.forum.ForumServices.set#MemberPreference',
        fields: ['siteId', 'targetHandle', 'preference', 'expiresAt'],
    },
    escalateReview: {
        service: 'mantle.forum.ModerationServices.escalate#Review',
        fields: ['siteId', 'reviewId', 'reason', 'active'],
    },
    storeRoute: {
        service: 'mantle.forum.DeliveryServices.store#Route',
        fields: [
            'siteId',
            'routeId',
            'address',
            'contactListId',
            'active',
            'expectedRevision',
            'operationId',
        ],
    },
    findRoutes: {
        service: 'mantle.forum.DeliveryServices.find#Routes',
        fields: ['siteId'],
    },
    findInboundReceipts: {
        service: 'mantle.forum.DeliveryServices.find#InboundReceipts',
        fields: ['siteId', 'limit', 'cursor'],
    },
    testRoute: {
        service: 'mantle.forum.DeliveryServices.test#Route',
        fields: ['siteId', 'routeId'],
    },
    retryInbound: {
        service: 'mantle.forum.DeliveryServices.retry#Inbound',
        fields: ['siteId', 'receiptId'],
    },
    setAccessGrant: {
        service: 'mantle.public.SiteServices.set#AccessGrant',
        fields: [
            'siteId',
            'handle',
            'targetType',
            'contactListId',
            'fromDate',
            'thruDate',
            'reason',
            'operationId',
            'wikiPageId',
        ],
    },
    endAccessGrant: {
        service: 'mantle.public.SiteServices.end#AccessGrant',
        fields: ['siteId', 'grantId', 'expectedRevision', 'reason'],
    },
    findAccessGrants: {
        service: 'mantle.public.SiteServices.find#AccessGrants',
        fields: ['siteId', 'contactListId', 'handle', 'limit', 'cursor'],
    },
    storeSubscriptionBinding: {
        service: 'mantle.public.SiteServices.store#SubscriptionBinding',
        fields: [
            'siteId',
            'subscriptionResourceId',
            'targetType',
            'contactListId',
            'reason',
            'wikiPageId',
        ],
    },
    findSubscriptionBindings: {
        service: 'mantle.public.SiteServices.find#SubscriptionBindings',
        fields: ['siteId'],
    },
    getTopicLinks: {
        service: 'mantle.forum.ForumServices.get#TopicLinks',
        fields: ['siteId', 'rootCommEventId'],
    },
    createCaseFromTopic: {
        service: 'mantle.forum.ForumServices.create#CaseFromTopic',
        fields: [
            'siteId',
            'rootCommEventId',
            'postIds',
            'requestCategoryId',
            'reason',
            'operationId',
        ],
    },
    previewCaseReply: {
        service: 'mantle.forum.ForumServices.preview#CaseReply',
        fields: ['siteId', 'rootCommEventId', 'requestId', 'body'],
    },
    publishCaseReply: {
        service: 'mantle.forum.ForumServices.publish#CaseReply',
        fields: [
            'siteId',
            'rootCommEventId',
            'requestId',
            'body',
            'previewHash',
            'operationId',
        ],
    },
    linkDiscussion: {
        service: 'mantle.forum.ForumServices.link#Discussion',
        fields: [
            'siteId',
            'rootCommEventId',
            'sourceType',
            'sourceId',
            'gate',
            'reason',
            'operationId',
        ],
    },
    detachDiscussion: {
        service: 'mantle.forum.ForumServices.detach#Discussion',
        fields: ['siteId', 'linkId', 'confirmAudience', 'reason'],
    },
    draftArticleFromTopic: {
        service: 'mantle.forum.ForumServices.draft#ArticleFromTopic',
        fields: [
            'siteId',
            'rootCommEventId',
            'postIds',
            'title',
            'reviewerUsername',
            'reason',
            'operationId',
        ],
    },
    findModerationScopes: {
        service: 'mantle.forum.ModerationServices.find#ModerationScopes',
        fields: [],
    },
    getRetentionPolicy: {
        service: 'mantle.forum.OperationServices.get#RetentionPolicy',
        fields: ['siteId'],
    },
    storeRetentionPolicy: {
        service: 'mantle.forum.OperationServices.store#RetentionPolicy',
        fields: [
            'siteId',
            'deliveryDays',
            'inboundDays',
            'deletedPostDays',
            'jobDays',
            'invitationDays',
            'expectedRevision',
            'reason',
        ],
    },
    previewOperation: {
        service: 'mantle.forum.OperationServices.preview#Operation',
        fields: ['siteId', 'operation', 'contactListId'],
    },
    startOperation: {
        service: 'mantle.forum.OperationServices.start#Operation',
        fields: [
            'siteId',
            'operation',
            'contactListId',
            'dryRun',
            'expectedRevision',
            'reason',
        ],
    },
    requestPersonalDataAction: {
        service: 'mantle.forum.OperationServices.request#PersonalDataAction',
        fields: ['siteId', 'kind', 'reason', 'confirm'],
    },
    findDataRequests: {
        service: 'mantle.forum.OperationServices.find#DataRequests',
        fields: ['siteId', 'mine', 'limit', 'cursor'],
    },
    decideDataRequest: {
        service: 'mantle.forum.OperationServices.decide#DataRequest',
        fields: [
            'siteId',
            'requestId',
            'decision',
            'reason',
            'expectedRevision',
        ],
    },
    findExports: {
        service: 'mantle.forum.OperationServices.find#Exports',
        fields: ['siteId'],
    },
    getExport: {
        service: 'mantle.forum.OperationServices.get#Export',
        fields: ['siteId', 'exportId'],
    },
    getActivity: {
        service: 'mantle.forum.OperationServices.get#Activity',
        fields: ['siteId', 'contactListId', 'fromDate', 'thruDate', 'interval'],
    },
    exportReport: {
        service: 'mantle.forum.OperationServices.export#Report',
        fields: ['siteId', 'report', 'contactListId', 'fromDate', 'thruDate'],
    },
    registerImport: {
        service: 'mantle.forum.ImportServices.register#Import',
        fields: ['siteId', 'archiveName', 'checksum', 'sourceName'],
    },
    stageImport: {
        service: 'mantle.forum.ImportServices.stage#Import',
        fields: ['siteId', 'importId'],
    },
    storeImportMappings: {
        service: 'mantle.forum.ImportServices.store#ImportMappings',
        fields: ['siteId', 'importId', 'mappings', 'reason'],
    },
    findImports: {
        service: 'mantle.forum.ImportServices.find#Imports',
        fields: ['siteId'],
    },
    getImport: {
        service: 'mantle.forum.ImportServices.get#Import',
        fields: ['siteId', 'importId'],
    },
    runImport: {
        service: 'mantle.forum.ImportServices.run#Import',
        fields: ['siteId', 'importId', 'reason'],
    },
    reconcileImport: {
        service: 'mantle.forum.ImportServices.reconcile#Import',
        fields: ['siteId', 'importId'],
    },
    approveImport: {
        service: 'mantle.forum.ImportServices.approve#Import',
        fields: ['siteId', 'importId', 'role', 'expectedRevision', 'reason'],
    },
    activateImport: {
        service: 'mantle.forum.ImportServices.activate#Import',
        fields: [
            'siteId',
            'importId',
            'sourceFrozen',
            'backupReference',
            'confirm',
        ],
    },
    cancelImport: {
        service: 'mantle.forum.ImportServices.cancel#Import',
        fields: ['siteId', 'importId', 'reason'],
    },
    resolvePermalink: {
        service: 'mantle.forum.ImportServices.resolve#Permalink',
        fields: ['siteId', 'path'],
    },
    issueInvoiceAccess: {
        service: 'mantle.account.PortalServices.issue#InvoiceAccess',
        fields: ['siteId', 'invoiceId'],
    },
    findInvoices: {
        service: 'mantle.account.PortalServices.find#Invoices',
        fields: ['siteId'],
    },
    getInvoice: {
        service: 'mantle.account.PortalServices.get#Invoice',
        fields: ['siteId', 'invoiceId', 'token'],
    },
    startInvoicePayment: {
        service: 'mantle.account.PortalServices.start#InvoicePayment',
        fields: ['siteId', 'invoiceId', 'token', 'operationId', 'confirm'],
    },
    getPaymentResult: {
        service: 'mantle.account.PortalServices.get#PaymentResult',
        fields: ['siteId', 'attemptId', 'token', 'returnKey'],
    },
    getSubmission: {
        service: 'mantle.account.PortalServices.get#Submission',
        fields: ['siteId', 'orderId', 'token', 'submissionId'],
    },
    submitSupplierBill: {
        service: 'mantle.account.PortalServices.submit#SupplierBill',
        fields: [
            'siteId',
            'orderId',
            'token',
            'referenceNumber',
            'invoiceDate',
            'amount',
            'file',
            'operationId',
        ],
    },
    // Purchasing P16: the Supplier app's home, QuoteResponse and OrderAcknowledgement (mantle.order.SupplierPortalServices)
    getSupplierHome: {
        service: 'mantle.order.SupplierPortalServices.get#SupplierHome',
        fields: ['siteId', 'token'],
    },
    getQuoteInvitation: {
        service: 'mantle.order.SupplierPortalServices.get#QuoteInvitation',
        fields: ['siteId', 'orderId', 'token'],
    },
    saveQuoteResponse: {
        service: 'mantle.order.SupplierPortalServices.save#QuoteResponse',
        fields: [
            'siteId',
            'orderId',
            'token',
            'rfqRevision',
            'otherPartyOrderId',
            'validThruDate',
            'estimatedDeliveryDate',
            'note',
            'lines',
        ],
    },
    submitQuoteResponse: {
        service: 'mantle.order.SupplierPortalServices.submit#QuoteResponse',
        fields: [
            'siteId',
            'orderId',
            'token',
            'rfqRevision',
            'otherPartyOrderId',
            'validThruDate',
            'estimatedDeliveryDate',
            'note',
            'lines',
            'confirm',
            'file',
            'operationId',
        ],
    },
    getPublishedPurchaseOrder: {
        service:
            'mantle.order.SupplierPortalServices.get#PublishedPurchaseOrder',
        fields: ['siteId', 'orderId', 'token'],
    },
    acknowledgePurchaseOrder: {
        service:
            'mantle.order.SupplierPortalServices.acknowledge#PurchaseOrder',
        fields: [
            'siteId',
            'orderId',
            'token',
            'orderRevision',
            'outcome',
            'otherPartyOrderId',
            'note',
            'lines',
            'file',
            'operationId',
        ],
    },
    reportDropShipDelivery: {
        service: 'mantle.order.SupplierPortalServices.report#DropShipDelivery',
        fields: [
            'siteId',
            'orderId',
            'token',
            'trackingCode',
            'shippedDate',
            'note',
            'lines',
            'operationId',
        ],
    },
    // Customer Service P13: the Support app's Feedback page (mantle.request.CaseFeedbackServices)
    getCaseFeedbackInvitation: {
        service: 'mantle.request.CaseFeedbackServices.get#Invitation',
        fields: ['siteId', 'token'],
    },
    submitCaseFeedback: {
        service: 'mantle.request.CaseFeedbackServices.submit#CaseFeedback',
        fields: ['siteId', 'token', 'values', 'operationId'],
    },
    // Customer Service P15: the Support app's help, cases, returns and order cancel (mantle.request.SupportCaseServices,
    // KnowledgeServices, mantle.order.ReturnPolicyServices, OrderChangeServices)
    getSupportHome: {
        service: 'mantle.request.SupportCaseServices.get#SupportHome',
        fields: ['siteId', 'query'],
    },
    findCustomerCases: {
        service: 'mantle.request.SupportCaseServices.find#CustomerCases',
        fields: [
            'siteId',
            'query',
            'statusCategory',
            'customerPartyId',
            'cursor',
            'limit',
        ],
    },
    getCaseIntake: {
        service: 'mantle.request.SupportCaseServices.get#CaseIntake',
        fields: ['siteId', 'token', 'orderId', 'wikiPageId', 'query'],
    },
    createCustomerCase: {
        service: 'mantle.request.SupportCaseServices.create#CustomerCase',
        fields: [
            'siteId',
            'token',
            'customerPartyId',
            'requestCategoryId',
            'requestTypeEnumId',
            'requestName',
            'description',
            'templateValues',
            'orderId',
            'wikiPageId',
            'firstName',
            'lastName',
            'emailAddress',
            'website',
            'file',
            'operationId',
        ],
    },
    getCustomerCase: {
        service: 'mantle.request.SupportCaseServices.get#CustomerCase',
        fields: ['siteId', 'requestId', 'token'],
    },
    replyCustomerCase: {
        service: 'mantle.request.SupportCaseServices.reply#CustomerCase',
        fields: ['siteId', 'requestId', 'token', 'body', 'file', 'operationId'],
    },
    requestCaseReopen: {
        service: 'mantle.request.SupportCaseServices.request#CaseReopen',
        fields: ['siteId', 'requestId', 'token', 'reason', 'operationId'],
    },
    cancelCustomerCase: {
        service: 'mantle.request.SupportCaseServices.cancel#CustomerCase',
        fields: ['siteId', 'requestId', 'token', 'expectedRevision', 'reason'],
    },
    getCaseFile: {
        service: 'mantle.request.SupportCaseServices.get#CaseFile',
        fields: ['siteId', 'requestId', 'token', 'fileId'],
    },
    getCustomerArticle: {
        service: 'mantle.request.KnowledgeServices.get#CustomerArticle',
        fields: ['siteId', 'wikiPageId'],
    },
    rateArticle: {
        service: 'mantle.request.KnowledgeServices.rate#Article',
        fields: ['siteId', 'wikiPageId', 'token', 'helpful', 'comment'],
    },
    findCustomerReturns: {
        service: 'mantle.order.ReturnPolicyServices.find#CustomerReturns',
        fields: ['siteId', 'query', 'customerPartyId', 'cursor', 'limit'],
    },
    getReturnableOrder: {
        service: 'mantle.order.ReturnPolicyServices.get#ReturnableOrder',
        fields: ['siteId', 'orderId'],
    },
    requestCustomerReturn: {
        service: 'mantle.order.ReturnPolicyServices.request#CustomerReturn',
        fields: [
            'siteId',
            'orderId',
            'lines',
            'customerReference',
            'note',
            'file',
            'operationId',
        ],
    },
    getCustomerReturn: {
        service: 'mantle.order.ReturnPolicyServices.get#CustomerReturn',
        fields: ['siteId', 'returnId', 'token'],
    },
    addReturnEvidence: {
        service: 'mantle.order.ReturnPolicyServices.add#ReturnEvidence',
        fields: ['siteId', 'returnId', 'token', 'note', 'file', 'operationId'],
    },
    withdrawCustomerReturn: {
        service: 'mantle.order.ReturnPolicyServices.withdraw#CustomerReturn',
        fields: [
            'siteId',
            'returnId',
            'token',
            'expectedRevision',
            'reason',
            'operationId',
        ],
    },
    getReturnLabel: {
        service: 'mantle.order.ReturnPolicyServices.get#ReturnLabel',
        fields: ['siteId', 'returnId', 'token'],
    },
    requestOrderCancel: {
        service: 'mantle.order.OrderChangeServices.request#CustomerCancel',
        fields: [
            'siteId',
            'orderId',
            'lines',
            'reason',
            'consent',
            'operationId',
        ],
    },
    getOrderCancelRequest: {
        service: 'mantle.order.OrderChangeServices.get#CustomerCancel',
        fields: ['siteId', 'requestId'],
    },
    withdrawOrderCancel: {
        service: 'mantle.order.OrderChangeServices.withdraw#CustomerCancel',
        fields: ['siteId', 'requestId', 'expectedRevision', 'reason'],
    },
    // Shop P1: the Shop app's trusted context
    getShopContext: {
        service: 'mantle.product.ShopCatalogServices.get#ShopContext',
        fields: ['siteId'],
    },
    // Shop P2: the themed page's view, the active release a frontend verifies and renders, the site's generation
    getShopPage: {
        service: 'mantle.public.ThemeServices.get#ShopPage',
        // P3: the catalog kinds' inputs
        fields: [
            'siteId',
            'pageKind',
            'productId',
            'variantId',
            'quantity',
            'productCategoryId',
            'query',
            'sort',
            'cursor',
            'routePath',
        ],
    },
    getShopThemeRelease: {
        service: 'mantle.public.ThemeServices.get#ShopThemeRelease',
        fields: ['siteId', 'releaseId'],
    },
    getShopThemeFiles: {
        service: 'mantle.public.ThemeServices.get#ShopThemeFiles',
        fields: ['siteId', 'releaseId', 'paths'],
    },
    getSiteGeneration: {
        service: 'mantle.public.SiteServices.get#SiteGeneration',
        fields: ['siteId'],
    },
    // Shop P3: the catalog reads (each answers the site's generation and active releaseId)
    getShopHome: {
        service: 'mantle.product.ShopCatalogServices.get#Home',
        fields: ['siteId'],
    },
    getStoreCategories: {
        service: 'mantle.product.ShopCatalogServices.get#Categories',
        fields: ['siteId'],
    },
    getStoreCategory: {
        service: 'mantle.product.ShopCatalogServices.get#Category',
        fields: ['siteId', 'productCategoryId', 'sort', 'cursor', 'limit'],
    },
    findProducts: {
        service: 'mantle.product.ShopCatalogServices.find#Products',
        fields: [
            'siteId',
            'productCategoryId',
            'query',
            'sort',
            'cursor',
            'limit',
        ],
    },
    searchShop: {
        service: 'mantle.product.ShopCatalogServices.search#Shop',
        fields: ['siteId', 'query', 'sort', 'cursor', 'limit'],
    },
    getProduct: {
        service: 'mantle.product.ShopCatalogServices.get#Product',
        fields: ['siteId', 'productId', 'variantId', 'quantity'],
    },
    quoteSelection: {
        service: 'mantle.product.ShopCatalogServices.quote#Selection',
        fields: ['siteId', 'productId', 'variantId', 'quantity'],
    },
    getStorePage: {
        service: 'mantle.product.ShopCatalogServices.get#Page',
        fields: ['siteId', 'routePath'],
    },
    getShopSitemap: {
        service: 'mantle.product.ShopCatalogServices.get#Sitemap',
        fields: ['siteId'],
    },
    // Shop P3 (impl-commerce F75): Commerce P4's live navigation and redirects of a site's Shop mount
    getSiteNavigation: {
        service: 'mantle.public.SiteServices.get#SiteNavigation',
        fields: ['siteId', 'menuKey', 'locale'],
    },
    resolveSiteRedirect: {
        service: 'mantle.public.SiteServices.resolve#SiteRedirect',
        fields: ['siteId', 'path'],
    },
    // Shop P4: the cart (input.token is the presentation session's cart capability; no operation takes an order id)
    getCart: {
        service: 'mantle.order.ShopCartServices.get#Cart',
        fields: ['siteId', 'token'],
    },
    addCartItem: {
        service: 'mantle.order.ShopCartServices.add#CartItem',
        fields: [
            'siteId',
            'token',
            'productId',
            'variantId',
            'quantity',
            'expectedRevision',
            'operationId',
        ],
    },
    updateCartItem: {
        service: 'mantle.order.ShopCartServices.update#CartItem',
        fields: [
            'siteId',
            'token',
            'orderItemSeqId',
            'quantity',
            'expectedRevision',
            'operationId',
        ],
    },
    removeCartItem: {
        service: 'mantle.order.ShopCartServices.remove#CartItem',
        fields: [
            'siteId',
            'token',
            'orderItemSeqId',
            'expectedRevision',
            'operationId',
        ],
    },
    applyPromoCode: {
        service: 'mantle.order.ShopCartServices.apply#PromoCode',
        fields: [
            'siteId',
            'token',
            'promoCode',
            'expectedRevision',
            'operationId',
        ],
    },
    removePromoCode: {
        service: 'mantle.order.ShopCartServices.remove#PromoCode',
        fields: [
            'siteId',
            'token',
            'promoCode',
            'expectedRevision',
            'operationId',
        ],
    },
    attachCart: {
        service: 'mantle.order.ShopCartServices.attach#Cart',
        fields: ['siteId', 'token'],
    },
    releaseCart: {
        service: 'mantle.order.ShopCartServices.release#Cart',
        fields: ['siteId', 'token'],
    },
    // Shop P4 (F61): a product image of a public product, streamed by the frontend
    getShopProductImage: {
        service: 'mantle.product.ShopCatalogServices.get#ProductImage',
        fields: ['siteId', 'productContentId'],
    },
})
