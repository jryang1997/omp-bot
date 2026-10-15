// Json.kt — 协议边界上的 JSON 约定。
//
// 服务端每条记录都可能增加字段（Ledger 记录是「至少这些字段」），所以解码一律
// 未知键忽略、缺省值兜底；解析外部文本（SSE 数据、原生帧）时不允许抛异常穿透，
// 坏帧只丢掉它自己。

package org.ompbot.companion.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonPrimitive

val CompanionJson: Json = Json {
    ignoreUnknownKeys = true
    isLenient = true
    explicitNulls = false
    encodeDefaults = true
    coerceInputValues = true
}

/** 取 JSON 对象的某个键，非对象一律 null。 */
fun JsonElement?.objectOrNull(): JsonObject? = this as? JsonObject

/**
 * 按顺序取第一个「有值」的键，值语义与 web/workbench-native.js 的 pick 一致：
 * null 与缺失都跳过。原生帧的字段名在不同 OMP 版本间有出入，这是唯一的容错点。
 */
fun JsonObject.pick(vararg keys: String): JsonElement? {
    for (key in keys) {
        val value = this[key]
        if (value != null && value !is JsonNull) return value
    }
    return null
}

fun JsonObject.string(vararg keys: String): String? = pick(*keys)?.asPlainString()

fun JsonObject.long(vararg keys: String): Long? = pick(*keys)?.asPlainLong()

fun JsonObject.bool(vararg keys: String): Boolean? = (pick(*keys) as? JsonPrimitive)?.booleanOrNull

fun JsonObject.text(vararg keys: String): String? = pick(*keys)?.let { element ->
    when (element) {
        is JsonPrimitive -> element.content
        is JsonObject -> element["text"]?.asPlainString() ?: element["content"]?.asPlainString()
        else -> null
    }
}

/** 字符串叶子：字符串原样，其他标量取其内容，对象/数组给 null（调用方自己序列化）。 */
fun JsonElement.asPlainString(): String? = when (this) {
    is JsonPrimitive -> if (this is JsonNull) null else content
    else -> null
}

fun JsonElement.asPlainLong(): Long? = (this as? JsonPrimitive)?.content?.toLongOrNull()

/** 展示用文本：字符串直取，其他结构紧凑序列化，永不抛。 */
fun JsonElement.displayText(): String? = when (this) {
    is JsonNull -> null
    is JsonPrimitive -> jsonPrimitive.content
    else -> runCatching { CompanionJson.encodeToString(JsonElement.serializer(), this) }.getOrNull()
}
