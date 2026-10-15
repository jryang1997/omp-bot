package org.ompbot.companion.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PairingLinkTest {
    private fun parsed(raw: String): PairingInvite {
        val result = PairingLinks.parse(raw)
        assertTrue(result is PairingLinkResult.Parsed, "应解析成功：$raw -> $result")
        return (result as PairingLinkResult.Parsed).invite
    }

    private fun reject(raw: String): String {
        val result = PairingLinks.parse(raw)
        assertTrue(result is PairingLinkResult.Rejected, "应被拒绝：$raw -> $result")
        return (result as PairingLinkResult.Rejected).message
    }

    @Test
    fun `parses the invitation the desktop prints`() {
        val invite = parsed(
            "ompbot://pair?v=1&address=http%3A%2F%2F192.168.1.20%3A3100&code=ompcode_9Xk2mQ4tR7vB1nL5wZ8cH3jF6pD0sA2e&name=Jerry%20PC",
        )
        assertEquals("http", invite.address.scheme)
        assertEquals("192.168.1.20", invite.address.host)
        assertEquals(3100, invite.address.port)
        assertEquals("ompcode_9Xk2mQ4tR7vB1nL5wZ8cH3jF6pD0sA2e", invite.code)
        assertEquals("Jerry PC", invite.name)
    }

    @Test
    fun `base64url codes survive decoding untouched`() {
        // '+' 不当空格：base64url 与 encodeURIComponent 都不产生空格语义。
        val invite = parsed("ompbot://pair?v=1&address=http%3A%2F%2F10.0.0.5%3A3100&code=ompcode_a-b_c-d_efghijkl+mnop")
        assertEquals("ompcode_a-b_c-d_efghijkl+mnop", invite.code)
    }

    @Test
    fun `rejects a link for another product`() {
        assertTrue(reject("openmausbot://pair?v=1&address=http%3A%2F%2F10.0.0.5&code=abcdefghijklmnopq").isNotEmpty())
    }

    @Test
    fun `rejects an unknown protocol version`() {
        assertTrue(
            reject("ompbot://pair?v=2&address=http%3A%2F%2F10.0.0.5%3A3100&code=abcdefghijklmnopq")
                .contains("版本"),
        )
    }

    @Test
    fun `rejects duplicate parameters`() {
        assertTrue(
            reject("ompbot://pair?v=1&code=abcdefghijklmnopq&code=abcdefghijklmnopq&address=http%3A%2F%2F10.0.0.5")
                .contains("重复"),
        )
    }

    @Test
    fun `rejects a missing or short code`() {
        assertTrue(reject("ompbot://pair?v=1&address=http%3A%2F%2F10.0.0.5%3A3100").contains("配对码"))
        assertTrue(reject("ompbot://pair?v=1&address=http%3A%2F%2F10.0.0.5%3A3100&code=abc").contains("形状"))
    }

    @Test
    fun `rejects addresses with a path or credentials`() {
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F10.0.0.5%2Fadmin").contains("不合法"))
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2Fuser%3Apass%4010.0.0.5").contains("不合法"))
    }

    @Test
    fun `refuses cleartext HTTP for a public name but allows HTTPS`() {
        assertTrue(
            reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2Fexample.com%3A3100")
                .contains("HTTPS"),
        )
        val invite = parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2Fexample.com")
        assertEquals("example.com", invite.address.host)
        assertNull(invite.address.port)
    }

    @Test
    fun `allows the local and tailnet cleartext routes the desktop advertises`() {
        assertTrue(parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2Flocalhost%3A3100").address.transportAllowed)
        assertTrue(parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2Fdesk.ts.net%3A3100").address.transportAllowed)
        assertTrue(parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F100.101.102.103%3A3100").address.transportAllowed)
        assertTrue(parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F192.168.0.10%3A3100").address.transportAllowed)
        assertTrue(PairingLinks.parse("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F8.8.8.8%3A3100") is PairingLinkResult.Rejected)
    }

    @Test
    fun `manual entry accepts host port and full urls`() {
        val bare = assertNotNull(ServerAddress.parseManual("192.168.1.9:3100"))
        assertEquals("192.168.1.9", bare.host)
        assertEquals(3100, bare.port)
        val url = assertNotNull(ServerAddress.parseManual("https://desk.tailnet.ts.net:3100"))
        assertEquals("https", url.scheme)
        assertNull(ServerAddress.parseManual("192.168.1.9:3100/api"))
        assertNull(ServerAddress.parseManual(""))
    }

    @Test
    fun `sanitizes control characters out of the advertised name`() {
        val invite = parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F10.0.0.5%3A3100&name=Desk%0A%0Dtop")
        assertEquals("Desktop", invite.name)
    }

    @Test
    fun `rejects hosts that could not become a url`() {
        // OkHttp 对控制字符、超长标签、下划线、畸形 IPv6 一律抛 IllegalArgumentException：
        // 这些必须在解析这一层拒掉，否则伪造的邀请链接会把异常抛到配对的按钮上。
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2Fbad%00host").contains("不合法"))
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2F%09").contains("不合法"))
        assertTrue(
            reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2F${"a".repeat(64)}.com")
                .contains("不合法"),
        )
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2Fmy_nas.local").contains("不合法"))
        assertTrue(reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2Fa..b").contains("不合法"))
        assertTrue(
            reject("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2F%5Bfd7a%3A%3A1%3A%3A2%5D")
                .contains("不合法"),
        )
    }

    @Test
    fun `keeps the addresses the desktop really advertises`() {
        assertEquals("192.168.1.20", parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F192.168.1.20%3A3100").address.host)
        assertEquals("desk.tailnet.ts.net", parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2Fdesk.tailnet.ts.net%3A3100").address.host)
        assertEquals("localhost", parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2Flocalhost%3A3100").address.host)
        assertEquals("fd7a:115c:a1e0::1", parsed("ompbot://pair?v=1&code=abcdefghijklmnopq&address=http%3A%2F%2F%5Bfd7a%3A115c%3Aa1e0%3A%3A1%5D%3A3100").address.host)
    }

    @Test
    fun `international names become punycode instead of being refused`() {
        val invite = parsed(
            "ompbot://pair?v=1&code=abcdefghijklmnopq&address=https%3A%2F%2F%E4%BE%8B%E5%AD%90.%E6%B5%8B%E8%AF%95",
        )
        assertTrue(invite.address.host.startsWith("xn--"), "应转成 punycode：${invite.address.host}")
        assertTrue(invite.address.host.all { it.code < 128 })
        assertTrue(invite.address.transportAllowed)
    }

    @Test
    fun `bracketed IPv6 addresses keep their display form`() {
        val address = assertNotNull(ServerAddress.parseUrl("http://[fd7a:115c:a1e0::1]:3100"))
        assertEquals("fd7a:115c:a1e0::1", address.host)
        assertEquals("[fd7a:115c:a1e0::1]:3100", address.displayAddress)
        assertTrue(address.baseUrl.startsWith("http://[fd7a:115c:a1e0::1]"))
    }
}
