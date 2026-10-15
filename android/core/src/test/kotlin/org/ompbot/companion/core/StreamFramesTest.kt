package org.ompbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class StreamFramesTest {
    @Test
    fun `decodes the hello frame the server sends first`() {
        val frame = StreamFrames.decode("""{"v":1,"type":"hello","lastSeq":412}""")
        assertEquals(StreamFrame.Hello(lastSeq = 412), frame)
    }

    @Test
    fun `decodes a gap frame so the caller can re-hydrate`() {
        val frame = StreamFrames.decode("""{"v":1,"type":"gap","from":3,"to":900,"lastSeq":1000}""")
        assertEquals(StreamFrame.Gap(from = 3, to = 900, lastSeq = 1000), frame)
    }

    @Test
    fun `decodes a run_updated event with its nested run`() {
        val frame = StreamFrames.decode(
            """{"v":1,"seq":7,"at":1700000000000,"type":"run_updated","runId":"run_1","botId":"bot_1",""" +
                """"scope":"private","run":{"id":"run_1","botId":"bot_1","state":"running","text":"你好","createdAt":1}}""",
        )
        val event = (frame as StreamFrame.Event).payload
        assertEquals("run_updated", event.type)
        assertEquals(7, event.seq)
        assertEquals("bot_1", event.botId)
        assertEquals(RunStates.RUNNING, event.run?.state)
        assertTrue(event.run?.isActive == true)
    }

    @Test
    fun `decodes ui_request approvals including native options`() {
        val frame = StreamFrames.decode(
            """{"v":1,"seq":9,"type":"ui_request","runId":"run_2","botId":"bot_1","approval":{""" +
                """"id":"ui_1","runId":"run_2","botId":"bot_1","method":"select","title":"Allow tool: shell",""" +
                """"options":["Approve","Deny"],"optionDetails":[{"label":"Approve","description":"这一次"},{"label":"Deny"}],""" +
                """"status":"pending","createdAt":5,"expiresAt":99}}""",
        )
        val approval = (frame as StreamFrame.Event).payload.approval
        assertEquals("select", approval?.method)
        assertEquals(listOf("Approve", "Deny"), approval?.optionValues)
        assertEquals("这一次", approval?.optionLabel(0)?.description)
        assertTrue(approval?.isToolApproval == true)
    }

    @Test
    fun `keeps the raw native frame for later folding`() {
        val frame = StreamFrames.decode(
            """{"v":1,"seq":10,"type":"native_event","runId":"run_2","botId":"bot_1",""" +
                """"event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"写"}}}""",
        )
        val event = (frame as StreamFrame.Event).payload
        val native = NativeFrames.parse(event.event)
        assertEquals(NativeFrame.Text("写"), native)
    }

    @Test
    fun `an unknown frame type does not kill the stream`() {
        val frame = StreamFrames.decode("""{"v":1,"seq":11,"type":"something_new","botId":"bot_1"}""")
        val state = CompanionState(initialCursor = 10)
        when (frame) {
            is StreamFrame.Event -> state.applyEvent(frame.payload)
            is StreamFrame.Unknown -> state.advanceTo(frame.seq)
            else -> error("新事件类型不能中断事件流")
        }
        assertEquals(11L, state.cursor.value)
    }

    @Test
    fun `malformed data decodes to null instead of throwing`() {
        assertNull(StreamFrames.decode("{not json"))
        assertNull(StreamFrames.decode("[]"))
        assertNull(StreamFrames.decode("""{"v":1}"""))
    }

    @Test
    fun `survives records with fields this client does not know yet`() {
        val frame = StreamFrames.decode(
            """{"v":1,"seq":12,"type":"run_finished","botId":"bot_1","futureField":{"deep":[1,2,3]},""" +
                """"run":{"id":"run_9","botId":"bot_1","state":"completed","text":"done","unknown":true,"stats":{"tokens":12}}}""",
        )
        val run = (frame as StreamFrame.Event).payload.run
        assertEquals(RunStates.COMPLETED, run?.state)
        assertTrue(run?.isTerminal == true)
        assertEquals(12, (run?.stats?.get("tokens") as? kotlinx.serialization.json.JsonPrimitive)?.content?.toInt())
    }

    @Test
    fun `the plain parser keeps its line semantics`() {
        val parser = SSEParser()
        assertNull(parser.line(":hb"))
        assertNull(parser.line("id: 5"))
        assertNull(parser.line("data: {\"type\":\"hello\"}"))
        val event = parser.line("")
        assertEquals("5", event?.id)
        assertEquals("""{"type":"hello"}""", event?.data)
        // 没有空行收尾的残事件在 reset 后不复活。
        assertNull(parser.line("data: half"))
        parser.reset()
        assertNull(parser.line(""))
    }
}
