// Sse.kt — SSE 行解析与事件流。
//
// 解析器与流实现移植自 OpenMausBot 的 android/core/.../Sse.kt（Apache-2.0，见
// android/PROVENANCE.md），保持两点：空行才是事件终止符；坏 JSON 只丢一帧。

package org.ompbot.companion.core

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

data class SSEEvent(val id: String? = null, val data: String)

/** 面向行的解析器；空输入行是事件终止符。 */
class SSEParser {
    private val fields = mutableListOf<Pair<String, String>>()

    fun line(raw: String): SSEEvent? {
        val line = raw.removeSuffix("\r")
        if (line.isEmpty()) {
            val event = event(fields)
            fields.clear()
            return event
        }
        if (line.startsWith(':')) return null
        val colon = line.indexOf(':')
        if (colon < 0) return null
        var value = line.substring(colon + 1)
        if (value.startsWith(' ')) value = value.drop(1)
        fields += line.substring(0, colon) to value
        return null
    }

    /** 丢掉一个始终没有等到空行的残事件。 */
    fun reset() {
        fields.clear()
    }

    companion object {
        internal fun event(fields: List<Pair<String, String>>): SSEEvent? {
            var id: String? = null
            val data = mutableListOf<String>()
            fields.forEach { (name, value) ->
                when (name) {
                    "id" -> id = value
                    "data" -> data += value
                }
            }
            return data.takeIf { it.isNotEmpty() }?.let { SSEEvent(id, it.joinToString("\n")) }
        }
    }
}

/**
 * 带 Bearer 的事件流。非 200 一律以 [ApiError.Status] 关闭，让调用方能按
 * 401（凭证撤销）与瞬时网络错误分别处理；坏帧与未知帧在这里就被丢掉。
 */
fun eventStream(request: Request, client: OkHttpClient): Flow<StreamFrame> = callbackFlow {
    val call = client.newCall(request)
    val reader = launch(Dispatchers.IO) {
        try {
            call.execute().use { response ->
                if (response.code != 200) throw ApiError.Status(response.code, errorCode(response), "事件流被拒绝")
                val body = response.body ?: throw ApiError.Transport("服务器返回了空的事件流")
                val source = body.source()
                val parser = SSEParser()
                while (isActive) {
                    val line = source.readUtf8Line() ?: break
                    val event = parser.line(line) ?: continue
                    val frame = StreamFrames.decode(event.data) ?: continue
                    send(frame)
                }
                parser.reset()
            }
            close()
        } catch (_: CancellationException) {
        } catch (error: ApiError) {
            close(error)
        } catch (error: IOException) {
            close(ApiError.Transport(error.message ?: "无法连接到电脑", error))
        }
    }
    awaitClose {
        call.cancel()
        reader.cancel()
    }
}

internal fun errorCode(response: Response): String? = runCatching {
    val text = response.peekBody(8 * 1024).string()
    val obj = CompanionJson.parseToJsonElement(text) as? kotlinx.serialization.json.JsonObject
    obj?.string("code")
}.getOrNull()
