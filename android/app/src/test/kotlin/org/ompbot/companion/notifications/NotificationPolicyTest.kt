package org.ompbot.companion.notifications

import org.ompbot.companion.core.Approval
import org.ompbot.companion.core.Run
import org.ompbot.companion.core.RunStates
import org.ompbot.companion.core.SessionNotice
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NotificationPolicyTest {
    private val pending = Approval(id = "ui_1", runId = "run_1", botId = "bot_1", method = "confirm", title = "允许执行？", status = "pending")

    @Test
    fun `an approval that the device may answer becomes a high-priority notification`() {
        val spec = NotificationPolicy.spec(SessionNotice.ApprovalAsked(pending), canApprove = true, botName = "小助手")
        assertEquals(NotificationPolicy.CHANNEL_APPROVAL, spec?.channelId)
        assertEquals("ompbot.approval.ui_1", spec?.dedupeId)
        assertEquals("bot_1", spec?.botId)
        assertTrue(spec!!.title.contains("小助手"))
        assertTrue(spec.text.contains("允许执行？"))
    }

    @Test
    fun `a device without the approve permission is never told to approve`() {
        assertNull(NotificationPolicy.spec(SessionNotice.ApprovalAsked(pending), canApprove = false))
    }

    @Test
    fun `an approval that is no longer pending is not announced again`() {
        val answered = pending.copy(status = "answered")
        assertNull(NotificationPolicy.spec(SessionNotice.ApprovalAsked(answered), canApprove = true))
    }

    @Test
    fun `finished and failed runs notify, a cancelled one does not`() {
        val done = Run(id = "run_1", botId = "bot_1", state = RunStates.COMPLETED, reply = "结果在这里", createdAt = 1)
        val spec = NotificationPolicy.spec(SessionNotice.RunSettled(done), canApprove = true, botName = "小助手")
        assertEquals(NotificationPolicy.CHANNEL_RUNS, spec?.channelId)
        assertEquals("ompbot.run.run_1.completed", spec?.dedupeId)
        assertTrue(spec!!.text.contains("结果在这里"))

        val failed = done.copy(state = RunStates.FAILED, error = "模型进程崩了")
        assertTrue(NotificationPolicy.spec(SessionNotice.RunSettled(failed), true)!!.text.contains("模型进程崩了"))

        assertNull(NotificationPolicy.spec(SessionNotice.RunSettled(done.copy(state = RunStates.CANCELLED)), true))
        assertNull(NotificationPolicy.spec(SessionNotice.RunSettled(done.copy(state = RunStates.RUNNING)), true))
    }

    @Test
    fun `a revoked credential tells the user to pair again`() {
        val spec = NotificationPolicy.spec(SessionNotice.Revoked("设备凭证已撤销"), canApprove = false)
        assertEquals("ompbot.revoked", spec?.dedupeId)
        assertTrue(spec!!.text.contains("重新配对"))
    }


    @Test
    fun `notification bodies never carry a raw device token`() {
        val leaked = "失败：Bearer ompd_abcdefghijklmnopqrstuvwxyz0123456789"
        assertTrue(NotificationPolicy.redact(leaked).contains("ompd_***"))
        assertTrue(!NotificationPolicy.redact(leaked).contains("abcdefghijklmnop"))
    }

    @Test
    fun `long bodies are clipped so a notification stays readable`() {
        val text = "错".repeat(500)
        assertTrue(NotificationPolicy.redact(text).length <= 140)
    }
}
