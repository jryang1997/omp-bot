// Api.kt — omp_bot 设备 API 客户端。
//
// 只走设备 Bearer，只调用契约里列出的入口；带 Origin 的浏览器请求由桌面入口拒绝，
// 手机原生请求不发 Origin（OkHttp 默认不发）。
//
// GET 可以在响应交付前恢复断开的连接。POST 保持 retryOnConnectionFailure=false：
// 派活和兑换没有幂等键，响应丢失时服务端可能已接受请求，不能自动再提交一次。
// 两种客户端共享连接池，凭据仍只由 request() 附加。

package org.ompbot.companion.core

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import okhttp3.Call
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

sealed class ApiError(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Status(val code: Int, val errorCode: String?, message: String) : ApiError(message)

    class Transport(message: String, cause: Throwable? = null) : ApiError(message, cause)

    /** 解码失败：服务端形状变了。不猜，直接报出来。 */
    class Decode(message: String, cause: Throwable? = null) : ApiError(message, cause)

    val isUnauthorized: Boolean get() = this is Status && code == 401
}

data class HealthInfo(val name: String, val protocol: String)

data class RunDetail(val run: Run, val approvals: List<Approval>, val artifacts: List<Artifact>)

data class HistoryPage(val events: List<RuntimeEvent>, val lastSeq: Long)

private const val JSON_MEDIA = "application/json; charset=utf-8"

/** 单次响应能读到内存里的硬上限；调用方给的上限再大也不会越过它。 */
private const val MAX_READABLE_BYTES = Int.MAX_VALUE - 1L

class OmpBotApi(
    private val address: ServerAddress,
    private val token: String?,
    private val client: OkHttpClient = defaultClient(),
) {
    private val readClient = client.newBuilder().retryOnConnectionFailure(true).build()
    suspend fun health(): HealthInfo = get("/api/health") { obj ->
        HealthInfo(name = obj.string("name").orEmpty(), protocol = obj.string("protocol").orEmpty())
    }

    suspend fun state(): Snapshot = get("/api/state") { obj ->
        CompanionJson.decodeFromJsonElement(Snapshot.serializer(), obj)
    }

    suspend fun chat(botId: String): List<ChatMessage> = get("/api/chat/${encode(botId)}") { obj ->
        obj.jsonArray("messages").mapNotNull { decodeOrNull(ChatMessage.serializer(), it) }
    }

    suspend fun runs(botId: String? = null): List<Run> {
        val path = if (botId == null) "/api/runs" else "/api/runs?botId=${encode(botId)}"
        return get(path) { obj -> obj.jsonArray("runs").mapNotNull { decodeOrNull(Run.serializer(), it) } }
    }

    suspend fun run(id: String): RunDetail = get("/api/runs/${encode(id)}") { obj ->
        RunDetail(
            run = decodeOrNull(Run.serializer(), obj["run"]) ?: throw ApiError.Decode("运行记录缺失"),
            approvals = obj.jsonArray("approvals").mapNotNull { decodeOrNull(Approval.serializer(), it) },
            artifacts = obj.jsonArray("artifacts").mapNotNull { decodeOrNull(Artifact.serializer(), it) },
        )
    }

    suspend fun startRun(botId: String, text: String, attachmentIds: List<String> = emptyList()): Run {
        val body = buildJsonObject {
            put("botId", JsonPrimitive(botId))
            put("text", JsonPrimitive(text))
            if (attachmentIds.isNotEmpty()) {
                put("attachmentIds", JsonArray(attachmentIds.map { JsonPrimitive(it) }))
            }
        }
        return post("/api/runs", body) { obj ->
            decodeOrNull(Run.serializer(), obj["run"]) ?: throw ApiError.Decode("服务端没有返回 Run")
        }
    }

    suspend fun cancelRun(runId: String, reason: String = "user"): Run? =
        post("/api/runs/${encode(runId)}/cancel", buildJsonObject { put("reason", JsonPrimitive(reason)) }) { obj ->
            decodeOrNull(Run.serializer(), obj["run"])
        }

    suspend fun steerRun(runId: String, text: String, behavior: String = "steer"): Run? {
        val body = buildJsonObject {
            put("text", JsonPrimitive(text))
            put("behavior", JsonPrimitive(behavior))
        }
        return post("/api/runs/${encode(runId)}/steer", body) { obj -> decodeOrNull(Run.serializer(), obj["run"]) }
    }

    suspend fun approvals(): List<Approval> = get("/api/approvals") { obj ->
        obj.jsonArray("approvals").mapNotNull { decodeOrNull(Approval.serializer(), it) }
    }

    suspend fun respond(approvalId: String, answer: ApprovalAnswer): Approval? =
        post("/api/approvals/${encode(approvalId)}/respond", answer.toJson()) { obj ->
            decodeOrNull(Approval.serializer(), obj["approval"])
        }

    suspend fun uploadAttachment(botId: String, filename: String, mime: String, base64: String): Attachment {
        val body = buildJsonObject {
            put("botId", JsonPrimitive(botId))
            put("filename", JsonPrimitive(filename))
            put("mime", JsonPrimitive(mime))
            put("dataBase64", JsonPrimitive(base64))
        }
        return post("/api/attachments", body) { obj ->
            decodeOrNull(Attachment.serializer(), obj["attachment"]) ?: throw ApiError.Decode("服务端没有返回附件记录")
        }
    }

    suspend fun attachments(botId: String): List<Attachment> =
        get("/api/attachments?botId=${encode(botId)}") { obj ->
            obj.jsonArray("attachments").mapNotNull { decodeOrNull(Attachment.serializer(), it) }
        }

    suspend fun artifacts(botId: String): List<Artifact> =
        get("/api/artifacts?botId=${encode(botId)}") { obj ->
            obj.jsonArray("artifacts").mapNotNull { decodeOrNull(Artifact.serializer(), it) }
        }

    suspend fun history(since: Long, runId: String? = null, limit: Int = 1000): HistoryPage {
        val path = buildString {
            append("/api/events/history?since=").append(since).append("&limit=").append(limit)
            if (runId != null) append("&runId=").append(encode(runId))
        }
        return get(path) { obj ->
            HistoryPage(
                events = obj.jsonArray("events").mapNotNull { decodeOrNull(RuntimeEvent.serializer(), it) },
                lastSeq = obj.long("lastSeq") ?: 0,
            )
        }
    }

    /** SSE 请求；由 [eventStream] 执行。 */
    fun eventRequest(since: Long): Request =
        request("/api/events?since=$since").header("Accept", "text/event-stream").build()

    /** 带 Bearer 的事件流；401 与瞬时断线分别以 ApiError.Status / ApiError.Transport 关闭。 */
    fun events(since: Long): kotlinx.coroutines.flow.Flow<StreamFrame> = eventStream(eventRequest(since), readClient)


    /**
     * 附件/成果的原生字节。调用方自己决定落到 SAF 还是分享出去。
     *
     * 上限在**读取过程中**生效：声明了 Content-Length 的响应先按它拒，分块或无长度声明的响应
     * 也只会读到上限 +1 字节，不会先把整个响应体读进内存。
     */
    suspend fun bytes(path: String, maxBytes: Long = 64L * 1024 * 1024): Pair<ByteArray, String?> = withContext(Dispatchers.IO) {
        val call = readClient.newCall(request(path).build())
        try {
            call.execute().use { response ->
                if (!response.isSuccessful) throw failure(response)
                val body = response.body ?: throw ApiError.Transport("响应没有正文")
                val limit = maxBytes.coerceIn(0L, MAX_READABLE_BYTES).toInt()
                if (body.contentLength() > limit.toLong()) throw tooLarge(maxBytes)
                val bytes = body.byteStream().use { stream -> stream.readBoundedBytes(limit) }
                if (bytes.size.toLong() > maxBytes) throw tooLarge(maxBytes)
                bytes to response.header("Content-Type")
            }
        } catch (error: IOException) {
            throw ApiError.Transport(error.message ?: "无法连接到电脑", error)
        }
    }

    suspend fun attachmentPreview(attachmentId: String, botId: String, maxBytes: Long = 24L * 1024 * 1024): Pair<ByteArray, String?> =
        bytes("/api/attachments/${encode(attachmentId)}/preview?botId=${encode(botId)}", maxBytes)

    suspend fun artifactBytes(artifactId: String, preview: Boolean = false, maxBytes: Long = 64L * 1024 * 1024): Pair<ByteArray, String?> =
        bytes("/api/artifacts/${encode(artifactId)}/${if (preview) "preview" else "download"}", maxBytes)

    // ---- 内部 ----

    private fun request(path: String): Request.Builder = try {
        Request.Builder().url(address.baseUrl + path).apply {
            token?.let { header("Authorization", "Bearer $it") }
        }
    } catch (error: IllegalArgumentException) {
        throw ApiError.Transport("服务器地址不合法：${address.displayAddress}", error)
    }

    private suspend fun <T> get(path: String, decode: (JsonObject) -> T): T {
        val request = request(path).get().build()
        return decode(withContext(Dispatchers.IO) { execute(readClient.newCall(request)) })
    }

    private suspend fun <T> post(path: String, body: JsonObject, decode: (JsonObject) -> T): T {
        val payload = CompanionJson.encodeToString(JsonObject.serializer(), body).toRequestBody(JSON_MEDIA.toMediaType())
        val decoded = withContext(Dispatchers.IO) {
            val request = request(path).post(payload).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) throw failure(response)
                bodyObject(response)
            }
        }
        // 服务端对 cancel/steer/respond 的回答可以是 {ok:true}（没有记录可回），所以这里**不**做
        // 非空断言：调用方按自己的返回类型决定（Run? / Approval? 可以没有，Run / Attachment 在
        // 各自的解码器里自己抛 Decode）。
        return decode(decoded)
    }

    private fun execute(call: Call): JsonObject = try {
        call.execute().use { response ->
            if (!response.isSuccessful) throw failure(response)
            bodyObject(response)
        }
    } catch (error: IOException) {
        throw ApiError.Transport(error.message ?: "无法连接到电脑", error)
    }

    private fun bodyObject(response: Response): JsonObject {
        val text = response.body?.string().orEmpty()
        if (text.isBlank()) return JsonObject(emptyMap())
        val element = runCatching { CompanionJson.parseToJsonElement(text) }.getOrNull()
        return element as? JsonObject ?: throw ApiError.Decode("服务端响应不是 JSON")
    }

    private fun tooLarge(maxBytes: Long): ApiError = ApiError.Transport("文件超过 ${formatBytes(maxBytes)}")

    private fun failure(response: Response): ApiError {
        val text = runCatching { response.peekBody(8192).string() }.getOrNull().orEmpty()
        val obj = runCatching { CompanionJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
        val code = obj?.string("code")
        val message = obj?.string("error")
            ?: obj?.string("message")
            ?: when (response.code) {
                401 -> "设备凭证已失效，请重新配对"
                403 -> "该设备没有这个权限或不在授权范围内"
                404 -> "服务端没有这条记录"
                else -> "请求失败（HTTP ${response.code}）"
            }
        return ApiError.Status(response.code, code, message)
    }

    companion object {
        private fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .writeTimeout(90, TimeUnit.SECONDS)
            .callTimeout(0, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()

        /** 兑换是一次性未认证入口；失败要区分「码不对」与「服务不对」。 */
        suspend fun redeem(
            address: ServerAddress,
            code: String,
            deviceName: String?,
            client: OkHttpClient = defaultClient(),
        ): RedeemResult = withContext(Dispatchers.IO) {
            val name = deviceName?.trim()?.takeIf { it.isNotEmpty() }
            val body = buildJsonObject {
                put("code", JsonPrimitive(code))
                // 空名字不发 name：电脑上 `req.name ?? ticket.label` 才能保住配对码自己的备注。
                if (name != null) put("name", JsonPrimitive(name))
            }
            val request = try {
                Request.Builder()
                    .url("${address.baseUrl}/api/pairing/redeem")
                    .post(CompanionJson.encodeToString(JsonObject.serializer(), body).toRequestBody(JSON_MEDIA.toMediaType()))
                    .build()
            } catch (error: IllegalArgumentException) {
                // 地址是邀请链接带来的外部输入：拼不进 URL 就是「这次配对不行」，
                // 不是把 IllegalArgumentException 抛进 UI 的协程里。
                throw ApiError.Transport("服务器地址不合法：${address.displayAddress}", error)
            }
            try {
                client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) throw redeemFailure(response)
                    val obj = runCatching {
                        CompanionJson.parseToJsonElement(response.body?.string().orEmpty()) as? JsonObject
                    }.getOrNull() ?: throw ApiError.Decode("兑换响应不是 JSON")
                    val token = obj.string("token") ?: throw ApiError.Decode("兑换响应没有 token")
                    val device = decodeOrNull(DeviceView.serializer(), obj["device"])
                        ?: throw ApiError.Decode("兑换响应没有设备信息")
                    RedeemResult(token = token, device = device)
                }
            } catch (error: IOException) {
                throw ApiError.Transport(error.message ?: "无法连接到电脑", error)
            }
        }

        private fun redeemFailure(response: Response): ApiError {
            val text = runCatching { response.peekBody(8192).string() }.getOrNull().orEmpty()
            val obj = runCatching { CompanionJson.parseToJsonElement(text) as? JsonObject }.getOrNull()
            val code = obj?.string("code")
            val message = when (code) {
                "PAIRING_INVALID_CODE" -> "配对码无效、已使用或已过期"
                "PAIRING_USED" -> "这个配对码已经被使用过（一次性）"
                "PAIRING_EXPIRED" -> "配对码已过期，请在电脑上重新生成"
                "PAIRING_REVOKED" -> "配对码已被撤销"
                else -> obj?.string("error") ?: "兑换失败（HTTP ${response.code}）"
            }
            return ApiError.Status(response.code, code, message)
        }
    }
}

internal fun JsonObject.jsonArray(key: String): List<JsonElement> = (this[key] as? JsonArray)?.toList() ?: emptyList()


internal fun <T> decodeOrNull(serializer: KSerializer<T>, element: JsonElement?): T? {
    if (element == null) return null
    return runCatching { CompanionJson.decodeFromJsonElement(serializer, element) }.getOrNull()
}
