// NotificationPolicy.kt — 通知映射（纯逻辑，可 JVM 单测）。
//
// 手机没有推送服务：通知只可能来自**正在连接的**事件流，所以这里只做「这条事件值不值得
// 打扰用户」的判断，不假装有离线推送。用户自己能做的事（取消）不通知；他不知道的事
// （任务完成、失败、待审批、凭证被撤销）才通知。

package org.ompbot.companion.notifications

import org.ompbot.companion.core.Approval
import org.ompbot.companion.core.Run
import org.ompbot.companion.core.RunStates
import org.ompbot.companion.core.SessionNotice

data class NotificationSpec(
    val channelId: String,
    val title: String,
    val text: String,
    /** 同一条审批/同一次运行的同一状态只留一条通知。 */
    val dedupeId: String,
    val botId: String?,
    val runId: String?,
)

object NotificationPolicy {
    const val CHANNEL_APPROVAL = "approval_question"
    const val CHANNEL_RUNS = "bot_messages"
    const val CHANNEL_ALWAYS_ON = "always_on_status"

    private const val MAX_TEXT = 140

    fun spec(notice: SessionNotice, canApprove: Boolean, botName: String? = null): NotificationSpec? = when (notice) {
        is SessionNotice.ApprovalAsked -> approvalSpec(notice.approval, canApprove, botName)
        is SessionNotice.ApprovalSettled -> null
        is SessionNotice.RunSettled -> runSpec(notice.run, botName)
        is SessionNotice.Revoked -> NotificationSpec(
            channelId = CHANNEL_RUNS,
            title = "设备凭证已失效",
            text = "${notice.reason}，请重新配对",
            dedupeId = "ompbot.revoked",
            botId = null,
            runId = null,
        )
    }

    private fun approvalSpec(approval: Approval, canApprove: Boolean, botName: String?): NotificationSpec? {
        if (!canApprove) return null
        if (!approval.isPending) return null
        val who = botName?.takeIf { it.isNotBlank() }?.let { "$it · " }.orEmpty()
        val title = who + "需要你确认"
        val text = listOfNotNull(approval.title, approval.message)
            .joinToString(" · ")
            .replace('\n', ' ')
            .take(MAX_TEXT)
            .ifBlank { "有一步在等你回答，点开查看" }
        return NotificationSpec(
            channelId = CHANNEL_APPROVAL,
            title = title,
            text = text,
            dedupeId = "ompbot.approval.${approval.id}",
            botId = approval.botId.ifBlank { null },
            runId = approval.runId,
        )
    }

    private fun runSpec(run: Run, botName: String?): NotificationSpec? {
        val title = when (run.state) {
            RunStates.COMPLETED -> "任务完成"
            RunStates.FAILED -> "任务失败"
            RunStates.INTERRUPTED -> "任务被中断"
            RunStates.RECONCILIATION_REQUIRED -> "任务需要人工核对"
            // 取消是用户自己按的，不用再告诉他一次。
            RunStates.CANCELLED -> return null
            else -> return null
        }
        val who = botName?.takeIf { it.isNotBlank() }?.let { "$it · " }.orEmpty()
        val detail = run.error?.replace('\n', ' ')?.take(MAX_TEXT)
            ?: run.reply?.replace('\n', ' ')?.take(MAX_TEXT)
            ?: run.text.replace('\n', ' ').take(MAX_TEXT)
        return NotificationSpec(
            channelId = CHANNEL_RUNS,
            title = who + title,
            text = detail.ifBlank { "点开查看详情" },
            dedupeId = "ompbot.run.${run.id}.${run.state}",
            botId = run.botId,
            runId = run.id,
        )
    }

    /** 审批通知的唯一标识：应答后按这个 id 撤掉。 */
    fun approvalDedupeId(approvalId: String): String = "ompbot.approval.$approvalId"

    /** 通知正文里只放能公开的短摘要，不放凭据、不放整段 transcript。 */
    fun redact(text: String): String = text.replace(Regex("ompd_[A-Za-z0-9_-]{8,}"), "ompd_***").take(MAX_TEXT)
}
