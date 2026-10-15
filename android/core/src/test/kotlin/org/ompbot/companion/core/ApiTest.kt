package org.ompbot.companion.core

import java.util.concurrent.TimeUnit
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import okio.Buffer
import org.junit.After
import org.junit.Before
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 这些测试把客户端接到真实 HTTP 上（MockWebServer），断言的是**线上字节**：
 * 路径、请求体字段、凭证头、以及撤销后不重试。形状猜错会在这里失败，而不是在真机上。
 */
class ApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: OmpBotApi

    @Before
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = OmpBotApi(ServerAddress("http", "127.0.0.1", server.port), token = "ompd_test-token")
    }

    @After
    fun tearDown() {
        server.shutdown()
    }

    private fun body(request: RecordedRequest): JsonObject =
        CompanionJson.parseToJsonElement(request.body.readUtf8()) as JsonObject

    private fun text(body: JsonObject, key: String): String? = (body[key] as? JsonPrimitive)?.content

    @Test
    fun `redeem posts the one-time code and decodes the device`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"token":"ompd_abc","device":{"id":"dev_1","botIds":["bot_1","bot_2"],""" +
                    """"permissions":["read","run","approve"],"label":"Jerry 的手机"}}""",
            ),
        )
        val result = OmpBotApi.redeem(ServerAddress("http", "127.0.0.1", server.port), "ompcode_one", "Pixel 8")
        val request = server.takeRequest()
        assertEquals("/api/pairing/redeem", request.path)
        assertEquals("POST", request.method)
        val payload = body(request)
        assertEquals("ompcode_one", text(payload, "code"))
        assertEquals("Pixel 8", text(payload, "name"))
        assertEquals("ompd_abc", result.token)
        assertEquals(listOf("bot_1", "bot_2"), result.device.botIds)
        assertTrue(result.device.canApprove)
        assertNull(request.getHeader("Origin"))
    }

    @Test
    fun `a phone that leaves its name blank lets the desktop keep the ticket label`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(201).setBody(
                """{"token":"ompd_xyz","device":{"id":"dev_2","botIds":["bot_1"],"permissions":["read"]}}""",
            ),
        )
        OmpBotApi.redeem(ServerAddress("http", "127.0.0.1", server.port), "ompcode_two", "   ")
        val payload = body(server.takeRequest())
        assertEquals("ompcode_two", text(payload, "code"))
        assertNull(payload["name"])
    }

    @Test
    fun `every authenticated call carries the device bearer and no browser origin`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"bots":[],"activeRuns":[],"pendingApprovals":[],"lastSeq":42}"""))
        val snapshot = api.state()
        val request = server.takeRequest()
        assertEquals("Bearer ompd_test-token", request.getHeader("Authorization"))
        assertNull(request.getHeader("Origin"))
        assertEquals(42, snapshot.lastSeq)
    }

    @Test
    fun `run submission sends exactly the fields the server accepts`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(202).setBody(
                """{"run":{"id":"run_1","botId":"bot_1","kind":"chat","state":"queued","text":"整理周报"}}""",
            ),
        )
        val run = api.startRun("bot_1", "整理周报", listOf("att_1", "att_2"))
        val request = server.takeRequest()
        assertEquals("/api/runs", request.path)
        val payload = body(request)
        assertEquals("bot_1", text(payload, "botId"))
        assertEquals("整理周报", text(payload, "text"))
        assertEquals(listOf("att_1", "att_2"), (payload["attachmentIds"] as kotlinx.serialization.json.JsonArray).map { it.toString().trim('"') })
        assertEquals("queued", run.state)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a failed submission is reported, never silently retried`() = runTest {
        server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"模型进程启动失败"}"""))
        val error = runCatching { api.startRun("bot_1", "再来一次") }.exceptionOrNull()
        assertTrue(error is ApiError.Status, "应为状态错误：$error")
        assertEquals(500, (error as ApiError.Status).code)
        assertEquals("模型进程启动失败", error.message)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a revoked device is a 401 the session can stop on`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"设备凭证已撤销","code":"DEVICE_REVOKED"}"""))
        val error = runCatching { api.state() }.exceptionOrNull()
        assertTrue(error is ApiError.Status)
        assertTrue((error as ApiError.Status).isUnauthorized)
        assertEquals("DEVICE_REVOKED", error.errorCode)
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `approval answers keep the exact json shapes the native side validates`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"approval":{"id":"ui_1","botId":"bot_1","method":"select","status":"answered"}}"""))
        api.respond("ui_1", ApprovalAnswer.Value("Approve"))
        assertEquals("""{"value":"Approve"}""", server.takeRequest().body.readUtf8())

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        api.respond("ui_2", ApprovalAnswer.Confirmed(false))
        assertEquals("""{"confirmed":false}""", server.takeRequest().body.readUtf8())

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        api.respond("ui_3", ApprovalAnswer.Cancelled)
        assertEquals("""{"cancelled":true}""", server.takeRequest().body.readUtf8())
    }

    @Test
    fun `attachments upload with the keys the server reads`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"attachment":{"id":"att_9","botId":"bot_1","filename":"周报.md","mime":"text/markdown","kind":"document","size":12,"hash":"ab"}}""",
            ),
        )
        val attachment = api.uploadAttachment("bot_1", "周报.md", "text/markdown", "6ZmE5pel")
        val payload = body(server.takeRequest())
        assertEquals("bot_1", text(payload, "botId"))
        assertEquals("周报.md", text(payload, "filename"))
        assertEquals("text/markdown", text(payload, "mime"))
        assertEquals("6ZmE5pel", text(payload, "dataBase64"))
        assertEquals("att_9", attachment.id)
    }

    @Test
    fun `steering names the behaviour so a follow-up is not mistaken for a steer`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"run":{"id":"run_1","botId":"bot_1","state":"running"}}"""))
        api.steerRun("run_1", "顺便看下日志", behavior = "follow_up")
        val request = server.takeRequest()
        assertEquals("/api/runs/run_1/steer", request.path)
        val payload = body(request)
        assertEquals("顺便看下日志", text(payload, "text"))
        assertEquals("follow_up", text(payload, "behavior"))
    }

    @Test
    fun `the event stream decodes frames and reports the stream end`() = runTest {
        server.enqueue(
            MockResponse()
                .setHeader("Content-Type", "text/event-stream")
                .setBody(
                    "data: {\"v\":1,\"type\":\"hello\",\"lastSeq\":5}\n\n" +
                        ":hb\n\n" +
                        "id: 6\ndata: {\"v\":1,\"seq\":6,\"type\":\"run_updated\",\"botId\":\"bot_1\",\"run\":{\"id\":\"run_1\",\"botId\":\"bot_1\",\"state\":\"running\"}}\n\n" +
                        "id: 7\ndata: {\"v\":1,\"seq\":7,\"type\":\"run_finished\",\"botId\":\"bot_1\",\"run\":{\"id\":\"run_1\",\"botId\":\"bot_1\",\"state\":\"completed\"}}\n\n",
                )
                .setBodyDelay(0, TimeUnit.MILLISECONDS),
        )
        val frames = api.events(since = 5).toList()
        val request = server.takeRequest()
        assertEquals("/api/events?since=5", request.path)
        assertEquals("Bearer ompd_test-token", request.getHeader("Authorization"))
        assertEquals("text/event-stream", request.getHeader("Accept"))
        assertEquals(3, frames.size)
        assertEquals(StreamFrame.Hello(lastSeq = 5), frames[0])
        assertEquals(RunStates.RUNNING, (frames[1] as StreamFrame.Event).payload.run?.state)
        assertEquals(RunStates.COMPLETED, (frames[2] as StreamFrame.Event).payload.run?.state)
    }

    @Test
    fun `a 401 on the event stream surfaces as an unauthorized status`() = runTest {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":"设备凭证已撤销","code":"DEVICE_REVOKED"}"""))
        val error = runCatching { api.events(since = 0).toList() }.exceptionOrNull()
        assertTrue(error is ApiError.Status, "应为状态错误：$error")
        assertTrue((error as ApiError.Status).isUnauthorized)
    }

    @Test
    fun `artifact metadata and download bytes are fetched over the authenticated client`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"artifacts":[{"id":"art_1","botId":"bot_1","runId":"run_1","name":"报告.md","mime":"text/markdown","size":4,"version":1}]}""",
            ),
        )
        val artifacts = api.artifacts("bot_1")
        assertEquals("/api/artifacts?botId=bot_1", server.takeRequest().path)
        assertEquals("报告.md", artifacts.single().name)

        server.enqueue(MockResponse().setResponseCode(200).setBody("abcd"))
        val (bytes, _) = api.artifactBytes("art_1")
        assertEquals("abcd", String(bytes))
        assertEquals("Bearer ompd_test-token", server.takeRequest().getHeader("Authorization"))
    }

    @Test
    fun `history pages are read with the run filter the phone uses to rebuild a stream`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"events":[{"v":1,"seq":9,"type":"native_event","botId":"bot_1","runId":"run_1","event":{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"好"}}}],"lastSeq":9}""",
            ),
        )
        val page = api.history(since = 0, runId = "run_1")
        assertEquals("/api/events/history?since=0&limit=1000&runId=run_1", server.takeRequest().path)
        assertEquals("好", replayRunStream(page.events, "run_1").text)
        assertEquals(9, page.lastSeq)
    }

    @Test
    fun `the health probe identifies the device entrance`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"name":"omp-bot","protocol":"ompbot-mobile-v1"}"""))
        val health = OmpBotApi(ServerAddress("http", "127.0.0.1", server.port), token = null).health()
        assertEquals("omp-bot", health.name)
        assertEquals(MOBILE_PROTOCOL, health.protocol)
    }

    @Test
    fun `chat history decodes both the desktop log shape and the device projection`() = runTest {
        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"messages":[{"kind":"user","from":"user","fromName":"用户","text":"派个活","at":1},""" +
                    """{"kind":"bot","from":"bot_1","fromName":"小助手","text":"好的","at":2}]}""",
            ),
        )
        val desktopShape = api.chat("bot_1")
        assertEquals(listOf("派个活", "好的"), desktopShape.map { it.text })
        assertTrue(desktopShape[0].isUser)
        assertTrue(desktopShape[1].isBot)
        assertEquals("小助手", desktopShape[1].displayName)

        server.enqueue(
            MockResponse().setResponseCode(200).setBody(
                """{"messages":[{"role":"user","text":"派个活","at":1},{"role":"assistant","text":"好的","at":2}]}""",
            ),
        )
        val deviceShape = api.chat("bot_1")
        assertEquals(listOf("派个活", "好的"), deviceShape.map { it.text })
        assertTrue(deviceShape[0].isUser)
        assertTrue(deviceShape[1].isBot)
        assertEquals("你", deviceShape[0].displayName)
    }

    @Test
    fun `an unreachable host is a transport error, not a crash`() = runTest {
        val dead = OmpBotApi(ServerAddress("http", "127.0.0.1", 1), token = "ompd_x")
        val error = runCatching { dead.state() }.exceptionOrNull()
        assertTrue(error is ApiError.Transport, "应为传输错误：$error")
    }

    @Test
    fun `an address that cannot become a url is a transport error, not an IllegalArgumentException`() = runTest {
        // 地址可能来自 QR / 深链 / 手输 / 落盘状态：拼不进 URL 必须是可处理的错误，
        // 不能把 IllegalArgumentException 抛到调用方的协程里（真机上是配对页崩掉）。
        val bad = OmpBotApi(ServerAddress("https", "exa mple.com", null), token = "ompd_x")
        val error = runCatching { bad.state() }.exceptionOrNull()
        assertTrue(error is ApiError.Transport, "应为传输错误：$error")
        assertTrue(error.message.orEmpty().contains("地址不合法"), "应说明地址问题：${error.message}")

        val redeemError = runCatching {
            OmpBotApi.redeem(ServerAddress("https", "exa mple.com", null), "ompcode_one", null)
        }.exceptionOrNull()
        assertTrue(redeemError is ApiError.Transport, "兑换同样要变成传输错误：$redeemError")
    }

    @Test
    fun `an action without a record is a success, not a decode error`() = runTest {
        // 服务端对 cancel/steer/respond 的回答可以是 {ok:true}（没有记录可回）。
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        assertNull(api.respond("ui_2", ApprovalAnswer.Confirmed(true)))
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"ok":true}"""))
        assertNull(api.cancelRun("run_1"))
        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        assertNull(api.steerRun("run_1", "再补一句"))
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `an endpoint that promises a record still rejects a payload without one`() = runTest {
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"ok":true}"""))
        val runError = runCatching { api.startRun("bot_1", "没有 run 的 202") }.exceptionOrNull()
        assertTrue(runError is ApiError.Decode, "应为解码错误：$runError")

        server.enqueue(MockResponse().setResponseCode(200).setBody("""{"ok":true}"""))
        val attachmentError = runCatching {
            api.uploadAttachment("bot_1", "周报.md", "text/markdown", "6ZmE5pel")
        }.exceptionOrNull()
        assertTrue(attachmentError is ApiError.Decode, "应为解码错误：$attachmentError")

        server.enqueue(MockResponse().setResponseCode(201).setBody("""{"ok":true}"""))
        val redeemError = runCatching {
            OmpBotApi.redeem(ServerAddress("http", "127.0.0.1", server.port), "ompcode_one", null)
        }.exceptionOrNull()
        assertTrue(redeemError is ApiError.Decode, "应为解码错误：$redeemError")
    }

    @Test
    fun `an oversized chunked download is rejected while reading, not after`() = runTest {
        // 没有 Content-Length：只能靠有界读取挡住，读完再判大小等于先让进程 OOM。
        val body = Buffer().writeUtf8("x".repeat(4 * 1024 * 1024))
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody(body, 64 * 1024))
        val error = runCatching { api.artifactBytes("art_1", maxBytes = 1L * 1024 * 1024) }.exceptionOrNull()
        assertTrue(error is ApiError.Transport, "应为传输错误：$error")
        assertTrue(error.message.orEmpty().contains("超过"), "应说明超出上限：${error.message}")
        assertEquals(1, server.requestCount)
    }

    @Test
    fun `a read recovers when a reused connection closes before its response`() = runTest {
        val health = """{"name":"omp-bot","protocol":"ompbot-mobile-v1"}"""
        server.enqueue(MockResponse().setBody(health))
        api.health()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setBody(health))
        assertEquals("ompbot-mobile-v1", api.health().protocol)
        assertEquals(3, server.requestCount)
    }

    @Test
    fun `a write with an unknown result is never submitted again`() = runTest {
        server.enqueue(MockResponse().setBody("""{"name":"omp-bot","protocol":"ompbot-mobile-v1"}"""))
        api.health()
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
        server.enqueue(MockResponse().setResponseCode(202).setBody("""{"run":{"id":"duplicate","botId":"bot_1","state":"queued"}}"""))
        val result = runCatching { api.startRun("bot_1", "only once") }
        assertTrue(result.isFailure)
        assertEquals(2, server.requestCount)
        assertEquals("GET", server.takeRequest().method)
        assertEquals("POST", server.takeRequest().method)
    }

    @Test
    fun `a chunked download under the cap still arrives whole`() = runTest {
        server.enqueue(MockResponse().setResponseCode(200).setChunkedBody(Buffer().writeUtf8("abcd"), 3))
        val (bytes, _) = api.artifactBytes("art_1")
        assertEquals("abcd", String(bytes))
    }
}
