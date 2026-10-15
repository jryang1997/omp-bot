// AlwaysOnPreferences.kt — 用户显式打开的「常驻连接」开关。
//
// 用普通 SharedPreferences 而不是 DataStore：开机广播要在进程刚起来、协程还没跑起来的
// 时候同步读到这个值，DataStore 是异步的，读它就得在这里编造一个「大概读到了」的状态。

package org.ompbot.companion.storage

import android.content.Context
import android.content.SharedPreferences

class AlwaysOnPreferences(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    val enabled: Boolean get() = prefs.getBoolean(KEY_ENABLED, false)

    fun setEnabled(value: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, value).apply()
    }

    companion object {
        private const val PREFS_NAME = "companion_always_on"
        private const val KEY_ENABLED = "enabled"
    }
}
