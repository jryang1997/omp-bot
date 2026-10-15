// KeystoreTokenStore.kt — 设备 token 的加密存储（Android Keystore）。
//
// 结构移植自 OpenMausBot 的 app/.../storage/KeystoreTokenStore.kt（Apache-2.0，见
// android/PROVENANCE.md）。两条性质是承重的：
//
// - **不在调用方线程上做任何事**：openPrefs 要经 Keystore 派生 MasterKey、打开加密
//   文件并解密索引，是 IPC 加磁盘 IO。所有读写都跳到 [io]。
// - **返回前必须落盘**：写入用 commit() 而不是 apply()。配对时先存 token 再登记连接，
//   进程在这两步之间被杀只会留下「有 token 无配对」（无害），而不是「有配对无 token」
//   （手机连不上，还说不清为什么）。
//
// 文件本身不进 Auto Backup / 设备迁移（见 res/xml/backup_rules.xml、
// data_extraction_rules.xml）：token 跟着备份到新机，等于把设备凭证一起搬走。

package org.ompbot.companion.storage

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import org.ompbot.companion.core.TokenReadResult
import org.ompbot.companion.core.TokenStore
import java.security.KeyStoreException
import javax.crypto.AEADBadTagException
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class KeystoreTokenStore(
    private val prefsProvider: () -> SharedPreferences,
    private val io: CoroutineContext = Dispatchers.IO,
) : TokenStore {
    constructor(context: Context) : this({ openPrefs(context.applicationContext) })

    private val prefs: SharedPreferences by lazy(prefsProvider)

    override suspend fun save(connectionId: String, token: String) {
        try {
            withContext(io) {
                check(prefs.edit().putString(key(connectionId), token).commit()) {
                    "设备凭证没有写进加密存储"
                }
            }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (error: Exception) {
            throw TokenStoreUnavailable(locked = isLocked(error), cause = error)
        }
    }

    override suspend fun read(connectionId: String): TokenReadResult = try {
        val value = withContext(io) { prefs.getString(key(connectionId), null) }
        if (value == null) TokenReadResult.Missing else TokenReadResult.Found(value)
    } catch (cancellation: CancellationException) {
        throw cancellation
    } catch (error: Exception) {
        TokenReadResult.Unavailable(
            message = error.message ?: "无法访问本机的加密存储",
            locked = isLocked(error),
        )
    }

    override suspend fun remove(connectionId: String) {
        try {
            withContext(io) { prefs.edit().remove(key(connectionId)).commit() }
        } catch (cancellation: CancellationException) {
            throw cancellation
        } catch (_: Exception) {
            // 解除配对继续走完：一个删不掉的 token 在这条连接被删掉之后也没有用了。
        }
    }

    private fun key(connectionId: String): String = "token.$connectionId"

    companion object {
        const val PREFS_NAME = "companion_device_token"

        fun openPrefs(context: Context): SharedPreferences {
            val masterKey = MasterKey.Builder(context)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build()
            return EncryptedSharedPreferences.create(
                context,
                PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            )
        }

        private fun isLocked(error: Throwable): Boolean {
            val chain = generateSequence(error) { it.cause }.toList()
            return chain.any {
                it is KeyStoreException ||
                    it is AEADBadTagException ||
                    "User not authenticated" in it.message.orEmpty() ||
                    ("keystore" in it.message.orEmpty().lowercase() && "locked" in it.message.orEmpty().lowercase())
            }
        }
    }
}

class TokenStoreUnavailable(val locked: Boolean, cause: Throwable) :
    Exception(cause.message ?: "无法访问本机的加密存储", cause)
