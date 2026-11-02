// PaymentValidation notifications: sent to the topic's subscribers, approved or refused by a recipient.
const helper = () => ec.resource.script("component://mr-mantle/test/account/AccountingPaymentLifecycleFixtures.js")
let f
spec({
    setupSpec() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
        f = helper().fixtures("ACCT_P5_NOTICE")
        helper().call("create#moqui.security.user.NotificationTopicUser", {
            topic: "PaymentValidation",
            userId: f.users.treasury,
            allNotifications: "Y",
            receiveNotifications: "Y"
        })
    },
    setup() {
        login("john.doe")
        ec.artifactExecution.disableAuthz()
    },
    cleanup() {
        login("john.doe")
    },
    cleanupSpec() {
        login("john.doe")
        helper().lib.probe("delete#moqui.security.user.NotificationTopicUser", {
            topic: "PaymentValidation",
            userId: f.users.treasury
        })
    }
})
// A proposed draft and its notice, sent as send#PaymentValidationNotice is after the draft commits.
function noticed(h, extra = {}) {
    const created = h.native("create#PaymentDraft", h.request(f, extra)),
        sent = h.call("mantle.account.PaymentNotificationServices.send#PaymentValidationNotice", {
            paymentId: created.paymentId,
            validationEventId: created.validationEventId,
            sourceVersion: created.validationSourceVersion
        }),
        notification = h.lib.one("moqui.security.user.NotificationMessage", {notificationMessageId: sent.notificationMessageId})
    return {created, notification, message: JSON.parse(notification.messageJson)}
}
function decision(notice, extra = {}) {
    return Object.assign(
        {
            recordEntityName: "mantle.account.payment.Payment",
            recordId: notice.created.paymentId,
            message: notice.message,
            notificationMessageId: notice.notification.notificationMessageId
        },
        extra
    )
}
feature("a proposed draft's notice goes to the topic's subscribers with the revision to validate", {
    when() {
        const h = helper(),
            notice = noticed(h),
            recipients = h.lib.rows("moqui.security.user.NotificationMessageUser", {
                notificationMessageId: notice.notification.notificationMessageId
            })
        return {notice, recipients}
    },
    then({notice, recipients}) {
        notice.created.validationRequired == true
        notice.notification.topic == "PaymentValidation"
        notice.notification.recordId == notice.created.paymentId
        notice.message.sourceVersion == notice.created.sourceVersion
        notice.message.validationEventId == notice.created.validationEventId
        recipients.map(row => row.userId).includes(f.users.treasury)
        recipients.map(row => row.userId).includes(f.users.paymentView) == false
    }
})
feature("a recipient approves the current revision under their own payment authority, once", {
    when() {
        const h = helper(),
            notice = noticed(h)
        login(f.users.treasury)
        const approved = h.native("approve#PaymentValidationNotice", decision(notice)),
            again = h.rejected("approve#PaymentValidationNotice", decision(notice))
        login("john.doe")
        return {approved, again, payment: h.lib.one("mantle.account.payment.Payment", {paymentId: notice.created.paymentId})}
    },
    then({approved, again, payment}) {
        approved.decision == "approved"
        approved.reasonCode == "PAYMENT_VALIDATION_APPROVED"
        payment.statusId == "PmntPromised"
        again.includes("STALE_REVISION")
    }
})
feature("a refusal needs a reason and keeps the payment proposed, and a notice of an edited draft cannot validate", {
    when() {
        const h = helper(),
            notice = noticed(h)
        login(f.users.treasury)
        const noReason = h.rejected("refuse#PaymentValidationNotice", decision(notice)),
            refused = h.native("refuse#PaymentValidationNotice", decision(notice, {reason: "Wrong bank details"}))
        login("john.doe")
        const view = h.detail(f, notice.created.paymentId)
        h.native(
            "store#PaymentDraft",
            Object.assign(h.request(f, {amount: "61"}), {paymentId: notice.created.paymentId, sourceVersion: view.sourceVersion})
        )
        login(f.users.treasury)
        const stale = h.rejected("approve#PaymentValidationNotice", decision(notice))
        login("john.doe")
        return {
            noReason,
            refused,
            stale,
            event: h.lib.one("mantle.account.payment.PaymentLifecycleEvent", {
                paymentLifecycleEventId: refused.paymentLifecycleEventId
            }),
            payment: h.lib.one("mantle.account.payment.Payment", {paymentId: notice.created.paymentId})
        }
    },
    then({noReason, refused, stale, event, payment}) {
        noReason.includes("PAYMENT_REASON_REQUIRED")
        refused.decision == "refused"
        event.action == "validationRejected"
        event.reason == "Wrong bank details"
        stale.includes("STALE_REVISION")
        payment.statusId == "PmntProposed"
    }
})
feature("a notice cannot be used by a user it was not sent to, nor for another payment", {
    when() {
        const h = helper(),
            notice = noticed(h),
            other = h.draft(f)
        login(f.users.paymentView)
        const notRecipient = h.rejected("approve#PaymentValidationNotice", decision(notice))
        login(f.users.treasury)
        const otherRecord = h.rejected("approve#PaymentValidationNotice", decision(notice, {recordId: other}))
        login("john.doe")
        return {notRecipient, otherRecord}
    },
    then({notRecipient, otherRecord}) {
        notRecipient.includes("PAYMENT_VALIDATION_NOTICE_UNAVAILABLE")
        otherRecord.includes("PAYMENT_VALIDATION_NOTICE_UNAVAILABLE")
    }
})
