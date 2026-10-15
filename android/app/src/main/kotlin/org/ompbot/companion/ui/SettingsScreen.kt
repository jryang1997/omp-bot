// SettingsScreen.kt — 连接与后台行为的唯一真相页。
//
// 这里刻意把三件事说清楚，而不是藏起来：
// - 这个设备在电脑上拥有哪些权限（配对时由电脑决定，手机不能扩权）；
// - 应用关掉之后没有推送服务，只有用户打开的常驻连接才收得到提醒；
// - 本机「解除配对」只是忘掉凭证，电脑上的设备记录仍要在电脑侧撤销。

package org.ompbot.companion.ui

import android.content.Intent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import org.ompbot.companion.OmpBotApp
import org.ompbot.companion.core.formatClock
import org.ompbot.companion.lifecycle.AlwaysOnConnectionService
import org.ompbot.companion.lifecycle.AlwaysOnConnectionState
import org.ompbot.companion.platform.CompanionPermissions
import kotlinx.coroutines.launch

@Composable
fun SettingsScreen(app: OmpBotApp, onBack: () -> Unit) {
    val session = app.session
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val connection by session.connection.collectAsStateWithLifecycle()
    val status by session.status.collectAsStateWithLifecycle()
    val serviceError by AlwaysOnConnectionState.failure.collectAsStateWithLifecycle()
    var alwaysOn by remember { mutableStateOf(app.alwaysOn.enabled) }
    var confirmForget by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    val version = remember {
        runCatching {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        }.getOrNull() ?: "未知"
    }

    Column(modifier = Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
        ScreenHeader(title = "设置", subtitle = connection?.displayName ?: "未配对", onBack = onBack)
        StatusPill(status)

        error?.let { NoticeBar(text = it, tone = MaterialTheme.colorScheme.error) }
        serviceError?.let { NoticeBar(text = it, tone = MaterialTheme.colorScheme.error) }

        SectionLabel("连接")
        Column(modifier = Modifier.padding(horizontal = Sizes.gutter), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            InfoRow("电脑", connection?.name ?: "—")
            InfoRow("地址", connection?.address?.baseUrl ?: "—")
            InfoRow("设备名", connection?.device?.label?.ifBlank { "（未命名）" } ?: "—")
            InfoRow("权限", connection?.device?.describePermissions() ?: "—")
            InfoRow("可用的 Bot", connection?.device?.botIds?.size?.toString() ?: "0")
            InfoRow("配对时间", connection?.pairedAt?.takeIf { it > 0 }?.let { formatClock(it) } ?: "—")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { session.connect() }) { Text("重新连接") }
                TextButton(onClick = { confirmForget = true }) { Text("解除本机配对") }
            }
        }

        SectionLabel("后台与通知")
        Column(modifier = Modifier.padding(horizontal = Sizes.gutter), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("常驻连接", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                    Text(
                        "开着时用一个常驻通知保持与电脑的连接，应用退到后台也能收到审批与任务提醒。代价是电耗与那条通知。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = alwaysOn,
                    onCheckedChange = { enabled ->
                        alwaysOn = enabled
                        app.alwaysOn.setEnabled(enabled)
                        if (enabled) AlwaysOnConnectionService.start(context) else AlwaysOnConnectionService.stop(context)
                    },
                )
            }
            Text(
                "不开启常驻连接时，只有应用在前台（或刚退到后台的 25 秒宽限内）才收得到提醒；" +
                    "本项目没有推送服务，所以关闭状态下的推送不做保证。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(
                if (CompanionPermissions.hasNotifications(context)) {
                    "通知权限：已允许"
                } else {
                    "通知权限：未允许（提醒不会出现）"
                },
                style = MaterialTheme.typography.bodySmall,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextButton(onClick = {
                    context.startActivity(CompanionPermissions.notificationSettingsIntent(context))
                }) { Text("通知设置") }
                if (!CompanionPermissions.hasCamera(context)) {
                    TextButton(onClick = {
                        context.startActivity(CompanionPermissions.appSettingsIntent(context))
                    }) { Text("相机权限设置") }
                }
            }
        }

        SectionLabel("本机")
        Column(modifier = Modifier.padding(horizontal = Sizes.gutter), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            InfoRow("应用版本", version.toString())
            Text(
                "解除本机配对只会删掉这台手机上的设备凭证；电脑上的设备记录请用电脑侧的撤销功能处理，" +
                    "否则电脑上还会留着一条已经连不上的记录。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Column(modifier = Modifier.padding(Sizes.gutter)) {
            TextButton(onClick = {
                runCatching { context.startActivity(Intent(android.provider.Settings.ACTION_SETTINGS)) }
            }) { Text("系统设置") }
        }
    }

    if (confirmForget) {
        AlertDialog(
            onDismissRequest = { confirmForget = false },
            title = { Text("解除本机配对？") },
            text = { Text("这台手机会删掉设备凭证，之后需要重新扫码或输入配对码才能再连上。") },
            confirmButton = {
                TextButton(onClick = {
                    confirmForget = false
                    scope.launch {
                        runCatching { session.forgetActive() }.onFailure { error = it.message }
                    }
                }) { Text("解除") }
            },
            dismissButton = { TextButton(onClick = { confirmForget = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}
