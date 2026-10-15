package org.ompbot.companion.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CompanionStateTest {
    /** 用 JSON 构造器写帧，避免手写字符串在引号上出错。 */
    private fun event(seq: Long, type: String, botId: String? = "bot_1", nested: JsonObject = JsonObject(emptyMap())): RuntimeEvent {
        val payload = buildJsonObject {
            put("v", JsonPrimitive(1))
            put("seq", JsonPrimitive(seq))
            put("type", JsonPrimitive(type))
            if (botId != null) put("botId", JsonPrimitive(botId))
            nested.forEach { (key, value) -> put(key, value) }
        }.toString()
        val frame = StreamFrames.decode(payload)
        assertTrue(frame is StreamFrame.Event, "解码失败：$payload")
        return (frame as StreamFrame.Event).payload
    }

    private fun run(id: String, state: String, createdAt: Long = 0, botId: String = "bot_1"): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(id))
        put("botId", JsonPrimitive(botId))
        put("state", JsonPrimitive(state))
        put("createdAt", JsonPrimitive(createdAt))
    }

    private fun approval(id: String, runId: String?, status: String = "pending"): JsonObject = buildJsonObject {
        put("id", JsonPrimitive(id))
        if (runId != null) put("runId", JsonPrimitive(runId))
        put("botId", JsonPrimitive("bot_1"))
        put("method", JsonPrimitive("confirm"))
        put("status", JsonPrimitive(status))
    }

    @Test
    fun `cursor only moves for consumed events`() {
        val state = CompanionState()
        assertEquals(CursorOutcome.APPLIED, state.applyEvent(event(1, "bot_updated")))
        assertEquals(1, state.cursor.value)
        assertEquals(CursorOutcome.DUPLICATE, state.applyEvent(event(1, "bot_updated")))
        assertEquals(1, state.cursor.value)
        assertEquals(CursorOutcome.APPLIED, state.applyEvent(event(2, "bot_updated")))
        assertEquals(2, state.cursor.value)
    }

    @Test
    fun `a sequence jump is a consumed event, not a stall`() {
        val state = CompanionState()
        state.applyEvent(event(1, "bot_updated"))
        // 设备的事件流按 bot 过滤（src/server.mjs pushFrame）：2..4 属于别的 bot，不会推来。
        val outcome = state.applyEvent(
            event(5, "run_updated", nested = buildJsonObject { put("run", run("run_5", RunStates.RUNNING)) }),
        )
        assertEquals(CursorOutcome.APPLIED, outcome)
        assertEquals(RunStates.RUNNING, state.runs.value["run_5"]?.state)
        assertEquals(5L, state.cursor.value)
        // 补历史时拿到的旧帧仍然是重复帧：既不重复应用，也不把游标拉回去。
        assertEquals(CursorOutcome.DUPLICATE, state.applyEvent(event(3, "bot_updated")))
        assertEquals(5L, state.cursor.value)
    }

    @Test
    fun `a snapshot replaces the roster without moving the cursor`() {
        val state = CompanionState(initialCursor = 40)
        state.applySnapshot(
            Snapshot(
                bots = listOf(Bot("bot_1", "小助手")),
                activeRuns = listOf(Run("run_1", botId = "bot_1", state = RunStates.RUNNING)),
                pendingApprovals = listOf(Approval(id = "ui_1", botId = "bot_1", method = "confirm", status = "pending")),
                lastSeq = 120,
            ),
        )
        // 快照里没有终态 Run、没有成果、也没有提醒：游标停在 40，41..120 仍要由 SSE 重放。
        assertEquals(40L, state.cursor.value)
        assertEquals("小助手", state.bots.value.single().name)
        assertEquals("run_1", state.activeRunsFor("bot_1").single().id)
        assertEquals("ui_1", state.pendingApprovalsFor("bot_1").single().id)
        // 快照是权威：已经解掉的审批不会再从快照里出现。
        state.applySnapshot(Snapshot(lastSeq = 130))
        assertTrue(state.pendingApprovalsFor("bot_1").isEmpty())
        assertEquals(40L, state.cursor.value)
        // 快照之后推来的事件照常应用并推进。
        state.applyEvent(
            event(41, "run_finished", nested = buildJsonObject { put("run", run("run_1", RunStates.COMPLETED)) }),
        )
        assertEquals(RunStates.COMPLETED, state.runs.value["run_1"]?.state)
        assertEquals(41L, state.cursor.value)
    }

    @Test
    fun `adopting a truncated boundary only moves the cursor forward`() {
        val state = CompanionState(initialCursor = 7)
        state.advanceTo(3)
        assertEquals(7L, state.cursor.value)
        state.advanceTo(9)
        assertEquals(9L, state.cursor.value)
    }

    @Test
    fun `ui_resolved replaces the pending approval in place`() {
        val state = CompanionState()
        state.applyEvent(
            event(1, "ui_request", nested = buildJsonObject { put("approval", approval("ui_7", "run_1")) }),
        )
        assertEquals("ui_7", state.pendingApprovalsFor("bot_1").single().id)
        state.applyEvent(
            event(2, "ui_resolved", nested = buildJsonObject { put("approval", approval("ui_7", "run_1", "answered")) }),
        )
        assertTrue(state.pendingApprovalsFor("bot_1").isEmpty())
        assertEquals("answered", state.approvals.value["ui_7"]?.status)
    }

    @Test
    fun `artifact events attach themselves to their run`() {
        val state = CompanionState()
        state.applyEvent(event(1, "run_created", nested = buildJsonObject { put("run", run("run_9", RunStates.RUNNING)) }))
        val artifact = buildJsonObject {
            put("id", JsonPrimitive("art_1"))
            put("botId", JsonPrimitive("bot_1"))
            put("runId", JsonPrimitive("run_9"))
            put("name", JsonPrimitive("report.md"))
            put("mime", JsonPrimitive("text/markdown"))
            put("size", JsonPrimitive(10))
        }
        state.applyEvent(
            event(
                2, "artifact_added",
                nested = buildJsonObject {
                    put("runId", JsonPrimitive("run_9"))
                    put("artifact", artifact)
                },
            ),
        )
        assertEquals("report.md", state.artifactsFor("bot_1").single().name)
        assertEquals(listOf("art_1"), state.runs.value["run_9"]?.artifactIds)
        assertEquals(2, state.cursor.value)
    }

    @Test
    fun `native frames fold into the run stream they belong to`() {
        val state = CompanionState()
        fun native(delta: String) = buildJsonObject {
            put("runId", JsonPrimitive("run_3"))
            put(
                "event",
                buildJsonObject {
                    put("type", JsonPrimitive("message_update"))
                    put(
                        "assistantMessageEvent",
                        buildJsonObject {
                            put("type", JsonPrimitive("text_delta"))
                            put("delta", JsonPrimitive(delta))
                        },
                    )
                },
            )
        }
        state.applyEvent(event(1, "native_event", nested = native("分")))
        state.applyEvent(event(2, "native_event", nested = native("析")))
        assertEquals("分析", state.stream("run_3")?.text)
    }

}
