// PairingLink.kt — ompbot:// 邀请链接的解析与地址规则。
//
// 链接形状由桌面端签发（contract: Owner POST /api/mobile/invitation）：
//   ompbot://pair?v=1&address=<encoded-base-url>&code=<encoded-once-code>[&name=<encoded>]
// 一次性 code 只出现在链接里，兑换前必须先向用户展示目标地址与权限（见 PairingScreen）。

package org.ompbot.companion.core

import java.net.IDN
import java.net.InetAddress
import java.net.URLDecoder
import java.nio.charset.StandardCharsets
import kotlinx.serialization.Serializable

/** 服务器可达地址。路径/查询/凭据一律不允许：设备入口只有一个源。 */
@Serializable
data class ServerAddress(
    val scheme: String,
    val host: String,
    val port: Int? = null,
) {
    val baseUrl: String
        get() {
            val normalizedHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return if (port == null) "$scheme://$normalizedHost" else "$scheme://$normalizedHost:$port"
        }

    val displayAddress: String
        get() {
            val normalizedHost = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
            return if (port == null) normalizedHost else "$normalizedHost:$port"
        }

    val isSecure: Boolean get() = scheme == "https"

    /**
     * 明文 HTTP 只允许本机、局域网与 tailnet 字面地址；域名一律要求 HTTPS，
     * 且绝不为判定安全性做 DNS 解析（与上游 ServerTransport.kt 同一取舍）。
     */
    val transportAllowed: Boolean
        get() {
            if (isSecure) return true
            val lower = host.lowercase().removeSurrounding("[", "]").trimEnd('.')
            if (lower == "localhost" || lower.endsWith(".local") || lower.endsWith(".ts.net")) return true
            val literal = lower.substringBefore('%')
            val looksLikeV4 = literal.matches(Regex("[0-9]+(?:\\.[0-9]+){3}"))
            if (':' !in literal && !looksLikeV4) return false
            val address = runCatching { InetAddress.getByName(literal) }.getOrNull() ?: return false
            if (address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress) return true
            val bytes = address.address
            if (bytes.size == 16 && (bytes[0].toInt() and 0xfe) == 0xfc) return true // IPv6 ULA
            // Tailscale CGNAT 100.64.0.0/10：平台把它当公网，实际是私网隧道。
            return bytes.size == 4 && (bytes[0].toInt() and 0xff) == 100 && (bytes[1].toInt() and 0xc0) == 64
        }

    companion object {
        /** 手工输入的地址：`host[:port]` 或带 scheme 的完整 base URL。 */
        fun parseManual(raw: String, defaultScheme: String = "http"): ServerAddress? {
            val text = raw.trim()
            if (text.isEmpty()) return null
            val withScheme = if (text.contains("://")) text else "$defaultScheme://$text"
            return parseUrl(withScheme)
        }

        fun parseUrl(raw: String): ServerAddress? {
            val text = raw.trim()
            val schemeEnd = text.indexOf("://")
            if (schemeEnd <= 0) return null
            val scheme = text.substring(0, schemeEnd).lowercase()
            if (scheme != "http" && scheme != "https") return null
            val rest = text.substring(schemeEnd + 3)
            if (rest.isEmpty()) return null
            // 路径/查询/片段/凭据都不接受：地址是设备入口本身，不是某个页面。
            if (rest.any { it in "/?#" }) return null
            if (rest.contains('@')) return null
            var hostPart = rest
            var port: Int? = null
            if (hostPart.startsWith("[")) {
                val close = hostPart.indexOf(']')
                if (close < 0) return null
                val host = hostPart.substring(1, close)
                val tail = hostPart.substring(close + 1)
                if (tail.isNotEmpty()) {
                    if (!tail.startsWith(":")) return null
                    port = tail.substring(1).toIntOrNull() ?: return null
                }
                if (host.isEmpty() || host.any { it.isWhitespace() }) return null
                return finish(scheme, host, port)
            }
            val colon = hostPart.lastIndexOf(':')
            if (colon >= 0) {
                port = hostPart.substring(colon + 1).toIntOrNull() ?: return null
                hostPart = hostPart.substring(0, colon)
            }
            if (hostPart.isEmpty() || hostPart.any { it.isWhitespace() || it in "[]" }) return null
            return finish(scheme, hostPart, port)
        }

        private fun finish(scheme: String, host: String, port: Int?): ServerAddress? {
            if (port != null && port !in 1..65535) return null
            val normalized = host.lowercase().trimEnd('.')
            if (normalized.isEmpty()) return null
            // 非 ASCII 域名先按 IDN 转成 punycode：进 URL 的必须是 ASCII 形式，
            // 转不动就直接拒（地址是外部输入，不能带着未验证的形状往后走）。
            val ascii = if (normalized.all { it.code < 128 }) normalized
            else runCatching { IDN.toASCII(normalized) }.getOrNull() ?: return null
            if (!isUrlSafeHost(ascii)) return null
            return ServerAddress(scheme = scheme, host = ascii, port = port)
        }

        /**
         * host 必须能直接拼进 URL 交给 OkHttp：字母数字与连字符的标签（IPv4 字面量天然符合），
         * 或 IPv6 字面量（方括号已被 parseUrl 去掉，这里只剩冒号分隔的十六进制组）。
         * 控制字符、引号、下划线、空标签、超长标签都会让 OkHttp 抛 IllegalArgumentException，
         * 所以在这一层就拒 —— 伪造的 QR / 深链不该把异常抛到配对的按钮上。
         */
        private fun isUrlSafeHost(host: String): Boolean {
            if (host.isEmpty() || host.length > 253) return false
            if (host.contains(':')) return isIpv6Literal(host)
            return host.split('.').all { label ->
                label.length in 1..63 &&
                    label.all { it in 'a'..'z' || it in '0'..'9' || it == '-' }
            }
        }

        /** `::` 最多一处、每组 1..4 位十六进制、含 `::` 时不足 8 组，否则恰好 8 组。 */
        private fun isIpv6Literal(host: String): Boolean {
            if (host.length > 45) return false
            if (host.startsWith(':') && !host.startsWith("::")) return false
            if (host.endsWith(':') && !host.endsWith("::")) return false
            if (host.any { it !in '0'..'9' && it !in 'a'..'f' && it != ':' }) return false
            val compressed = (0..host.length - 2).count { host[it] == ':' && host[it + 1] == ':' }
            if (compressed > 1) return false
            val groups = host.split(':').filter { it.isNotEmpty() }
            if (groups.size > 8 || groups.any { it.length > 4 }) return false
            return if (compressed == 1) groups.size < 8 else groups.size == 8
        }
    }
}

data class PairingInvite(
    val address: ServerAddress,
    val code: String,
    val name: String?,
)

sealed interface PairingLinkResult {
    data class Parsed(val invite: PairingInvite) : PairingLinkResult
    data class Rejected(val message: String) : PairingLinkResult
}

object PairingLinks {
    const val SCHEME = "ompbot"
    const val HOST = "pair"
    const val VERSION = "1"
    private const val MAX_NAME = 80

    fun parse(raw: String?): PairingLinkResult {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return PairingLinkResult.Rejected("链接为空")
        val schemeEnd = text.indexOf("://")
        if (schemeEnd <= 0) return PairingLinkResult.Rejected("不是 ompbot:// 配对链接")
        val scheme = text.substring(0, schemeEnd).lowercase()
        if (scheme != SCHEME) return PairingLinkResult.Rejected("不是 OMP Bot 的配对链接")
        val rest = text.substring(schemeEnd + 3)
        val queryStart = rest.indexOf('?')
        if (queryStart < 0) return PairingLinkResult.Rejected("配对链接缺少参数")
        val authority = rest.substring(0, queryStart)
        if (!authority.equals(HOST, ignoreCase = true)) return PairingLinkResult.Rejected("这不是配对链接")
        val query = rest.substring(queryStart + 1)
        if (query.contains('#')) return PairingLinkResult.Rejected("配对链接格式不正确")

        val values = linkedMapOf<String, String>()
        if (query.isNotEmpty()) {
            for (item in query.split('&')) {
                if (item.isEmpty()) continue
                val equals = item.indexOf('=')
                if (equals <= 0) return PairingLinkResult.Rejected("配对链接参数不合法")
                val name = decode(item.substring(0, equals)) ?: return PairingLinkResult.Rejected("配对链接参数不合法")
                val value = decode(item.substring(equals + 1)) ?: return PairingLinkResult.Rejected("配对链接参数不合法")
                if (values.put(name, value) != null) return PairingLinkResult.Rejected("配对链接参数重复：$name")
            }
        }

        val version = values["v"]
        if (version != null && version != VERSION) {
            return PairingLinkResult.Rejected("不支持的配对协议版本 $version（本应用只认 v$VERSION）")
        }
        val code = values["code"]?.trim().orEmpty()
        if (code.isEmpty()) return PairingLinkResult.Rejected("配对链接里没有一次性配对码")
        if (code.length < 16 || code.length > 200 || code.any { it.isWhitespace() }) {
            return PairingLinkResult.Rejected("配对码形状不对，请重新生成二维码")
        }
        val addressText = values["address"]?.trim().orEmpty()
        if (addressText.isEmpty()) return PairingLinkResult.Rejected("配对链接里没有服务器地址")
        val address = ServerAddress.parseUrl(addressText)
            ?: return PairingLinkResult.Rejected("配对链接里的地址不合法：${printable(addressText)}")
        if (!address.transportAllowed) {
            return PairingLinkResult.Rejected("明文 HTTP 只支持本机或局域网地址，远程地址请用 HTTPS")
        }
        return PairingLinkResult.Parsed(
            PairingInvite(address = address, code = code, name = sanitizeName(values["name"])),
        )
    }

    /** 展示名只保留可打印字符，避免把控制字符带进界面或日志。 */
    private fun sanitizeName(raw: String?): String? {
        val clean = raw.orEmpty().filter { character ->
            character != '\n' && character != '\r' &&
                (character.code > 127 || (character.code >= 32 && character.code != 127))
        }.trim()
        return clean.take(MAX_NAME).ifEmpty { null }
    }

    /** 回显给用户的原文同样要去控制字符：坏链接不该把终端控制序列带进提示里。 */
    private fun printable(raw: String): String =
        raw.filter { it.code >= 32 && it.code != 127 }.take(MAX_NAME)

    /**
     * 百分号解码；'+' 不当空格（base64url 与 encodeURIComponent 都不会产生空格语义）。
     */
    private fun decode(raw: String): String? = runCatching {
        URLDecoder.decode(raw.replace("+", "%2B"), StandardCharsets.UTF_8)
    }.getOrNull()
}
