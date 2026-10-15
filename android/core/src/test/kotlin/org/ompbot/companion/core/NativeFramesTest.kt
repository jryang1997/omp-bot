package org.ompbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NativeFramesTest {
    private fun json(raw: String) = CompanionJson.parseToJsonElement(raw)

    @Test
    fun `text and thinking deltas come from the assistant message event`() {
        assertEquals(
            NativeFrame.Text("你好"),
            NativeFrames.parse(json("""{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"你好"}}""")),
        )
        assertEquals(
            NativeFrame.Thinking("想想"),
            NativeFrames.parse(json("""{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"想想"}}""")),
        )
        assertEquals(
            NativeFrame.Text("回退字段"),
            NativeFrames.parse(json("""{"type":"message_update","assistantMessageEvent":{"type":"text_delta","textDelta":"回退字段"}}""")),
        )
    }

    @Test
    fun `block ends close the current part`() {
        assertEquals(
            NativeFrame.BlockEnd("text"),
            NativeFrames.parse(json("""{"type":"message_update","assistantMessageEvent":{"type":"text_end"}}""")),
        )
        assertEquals(
            NativeFrame.BlockEnd("thinking"),
            NativeFrames.parse(json("""{"type":"message_update","assistantMessageEvent":{"type":"thinking_end"}}""")),
        )
    }

    @Test
    fun `tool frames carry phase, error and child task progress`() {
        val frame = NativeFrames.parse(
            json(
                """{"type":"tool_execution_update","toolCallId":"call_1","toolName":"task","args":{"cmd":"ls"},""" +
                    """"partialResult":{"details":{"progress":[{"id":"job_1","label":"子任务","agent":"explorer",""" +
                    """"status":"running","progress":0.4,"recentOutput":"正在读文件"}]}}}""",
            ),
        ) as NativeFrame.Tool
        assertEquals("update", frame.phase)
        assertEquals("call_1", frame.id)
        assertEquals("task", frame.name)
        assertEquals("job_1", frame.children.single().id)
        assertEquals(0.4, frame.children.single().progress)
        assertEquals("正在读文件", frame.children.single().detail)
    }

    @Test
    fun `a tool error is an error even when the frame says nothing`() {
        val frame = NativeFrames.parse(
            json("""{"type":"tool_execution_end","toolCallId":"c9","toolName":"shell","error":"exit 1"}"""),
        ) as NativeFrame.Tool
        assertEquals("end", frame.phase)
        assertTrue(frame.isError)
        assertEquals("exit 1", frame.error)
    }

    @Test
    fun `todo frames render items and honour the auto clear`() {
        val frame = NativeFrames.parse(
            json("""{"type":"todo_reminder","todos":[{"text":"读代码","status":"completed"},{"title":"写测试"}]}"""),
        ) as NativeFrame.Todo
        assertEquals(listOf("[x] 读代码", "[ ] 写测试"), frame.items)
        val cleared = NativeFrames.parse(json("""{"type":"todo_auto_clear"}""")) as NativeFrame.Todo
        assertTrue(cleared.cleared)
    }

    @Test
    fun `goal frames pick the first human field`() {
        val frame = NativeFrames.parse(json("""{"type":"goal_updated","goal":{"objective":"交付安卓端"}}""")) as NativeFrame.Goal
        assertEquals("交付安卓端", frame.text)
    }

    @Test
    fun `frames the phone has nothing to draw decode to null`() {
        assertNull(NativeFrames.parse(json("""{"type":"rpc_chunk"}""")))
        assertNull(NativeFrames.parse(json("""{"type":"set_title","title":"x"}""")))
        assertNull(NativeFrames.parse(json("""{"no":"type"}""")))
        assertNull(NativeFrames.parse(null))
    }
}
