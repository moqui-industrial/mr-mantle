/* CC0 1.0 Universal plus Grant of Patent License. See LICENSE.md.
 * The posts of record conversations (ForumTopic.kind record: an issue's, mr-pass plan/design-smithy.md §12.1), for the
 * readers of CommunicationEvent that know nothing of the forum: a record post has no contactListId, so nothing else
 * tells them it is not a party's own message. Such a reader leaves these out: the search document, a party's
 * communication list, a record's timeline. Entity access is privileged here.
 */
/* Of some communication event ids, those that are posts of a record topic: {communicationEventId: true}. */
function recordPostIds(communicationEventIds) {
    const ids = Array.from(communicationEventIds || []).filter(id => !!id)
    const out = {}
    if (!ids.length) return out
    const states = Array.from(
        ec.entity
            .find("mantle.forum.ForumPostState")
            .condition("communicationEventId", "in", ids)
            .selectField("communicationEventId,rootCommEventId")
            .disableAuthz()
            .list()
    )
    if (!states.length) return out
    const records = new Set(
        Array.from(
            ec.entity
                .find("mantle.forum.ForumTopic")
                .condition("rootCommEventId", "in", Array.from(new Set(states.map(state => state.rootCommEventId))))
                .condition("kind", "record")
                .selectField("rootCommEventId")
                .disableAuthz()
                .list()
        ).map(topic => topic.rootCommEventId)
    )
    for (const state of states) if (records.has(state.rootCommEventId)) out[state.communicationEventId] = true
    return out
}
;({recordPostIds})
