// PairingLinkActivity.kt — ompbot:// 深链的入口层。
//
// 它只做一件事：解析链接，把邀请放进进程内存，然后用一个**不带 data、不带 extras**
// 的 Intent 启动 MainActivity 并结束自己。理由与上游一致：系统会保留 Activity 的
// 启动 Intent（重启时交回、按 persistRootOnly 还会跨重启写入），而一次性配对码
// 不该出现在那里。这个 Activity 不是任务根、不进历史、不进最近任务、不持久化。

package org.ompbot.companion

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import org.ompbot.companion.core.PairingLinks
import org.ompbot.companion.platform.PendingNavigation

class PairingLinkActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PendingNavigation.postInvite(PairingLinks.parse(intent?.data?.toString()))
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
        finish()
    }
}
