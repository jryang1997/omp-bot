package org.ompbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RunStreamTest {
    @Test
    fun `consecutive text deltas stay in one part`() {
        val stream = RunStream()
            .fold(NativeFrame.Text("你好"))
            .fold(NativeFrame.Text("，世界"))
        assertEquals(1, stream.parts.size)
        assertEquals("你好，世界", stream.text)
    }

    @Test
    fun `a block end starts a fresh part for the next delta`() {
        val stream = RunStream()
            .fold(NativeFrame.Text("第一段"))
            .fold(NativeFrame.BlockEnd("text"))
            .fold(NativeFrame.Text("第二段"))
        assertEquals(2, stream.parts.filterIsInstance<StreamPart.Text>().size)
        assertEquals("第一段\n\n第二段", stream.text)
    }

    @Test
    fun `thinking is kept apart from the reply`() {
        val stream = RunStream()
            .fold(NativeFrame.Thinking("先看代码"))
            .fold(NativeFrame.BlockEnd("thinking"))
            .fold(NativeFrame.Text("改好了"))
        assertEquals("先看代码", stream.thinking)
        assertEquals("改好了", stream.text)
    }

    @Test
    fun `a tool frame keyed by name is replaced once the call id arrives`() {
        val stream = RunStream()
            .fold(NativeFrame.Tool(phase = "update", id = null, name = "read", isError = false, error = null, result = null, children = emptyList()))
            .fold(NativeFrame.Tool(phase = "end", id = "call_7", name = "read", isError = false, error = null, result = "内容", children = emptyList()))
        assertEquals(1, stream.tools.size)
        assertEquals("call_7", stream.tools.single().key)
        assertEquals("end", stream.tools.single().phase)
        assertEquals("内容", stream.tools.single().detail)
    }

    @Test
    fun `child stats from a later snapshot do not erase what the phone already knows`() {
        val stream = RunStream()
            .fold(
                NativeFrame.Tool(
                    phase = "update", id = "c1", name = "task", isError = false, error = null, result = null,
                    children = listOf(ChildTask("job_1", "子任务", "explorer", "running", 0.3, "在跑")),
                ),
            )
            .fold(
                NativeFrame.Tool(
                    phase = "end", id = "c1", name = "task", isError = false, error = null, result = "完成", children = emptyList(),
                ),
            )
        val child = stream.children.single()
        assertEquals(0.3, child.progress)
        assertEquals("explorer", child.agent)
    }

    @Test
    fun `todos and goal survive unrelated frames`() {
        val stream = RunStream()
            .fold(NativeFrame.Todo(cleared = false, items = listOf("[ ] 写代码")))
            .fold(NativeFrame.Goal("交付"))
            .fold(NativeFrame.Text("好"))
        assertEquals(listOf("[ ] 写代码"), stream.todos)
        assertEquals("交付", stream.goal)
    }

    @Test
    fun `replaying a run history rebuilds the streamed reply`() {
        val events = listOf(
            event(1, "run_created", "run_1"),
            event(2, "native_event", "run_1", """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"结果"}}"""),
            event(3, "native_event", "run_1", """{"type":"tool_execution_start","toolCallId":"c1","toolName":"shell"}"""),
            event(4, "native_event", "run_2", """{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"别的"}}"""),
            event(5, "run_finished", "run_1"),
        )
        val stream = replayRunStream(events, "run_1")
        assertEquals("结果", stream.text)
        assertEquals(1, stream.tools.size)
    }

    private fun event(seq: Long, type: String, runId: String, native: String? = null): RuntimeEvent {
        val payload = if (native == null) {
            """{"v":1,"seq":$seq,"type":"$type","runId":"$runId","botId":"bot_1"}"""
        } else {
            """{"v":1,"seq":$seq,"type":"$type","runId":"$runId","botId":"bot_1","event":$native}"""
        }
        val frame = StreamFrames.decode(payload)
        assertTrue(frame is StreamFrame.Event, "解码失败：$payload")
        return (frame as StreamFrame.Event).payload
    }
}
