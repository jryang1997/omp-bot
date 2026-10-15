// CompanionTheme.kt — 主题与几处共享的视觉常量。
//
// 界面照 Material 3 的默认形状与排版走，只换色：手机端不做第二套设计语言，
// 用户看到的应该是「OMP Bot 的手机版」。

package org.ompbot.companion.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

private val BrandGreen = Color(0xFF3FA96A)
private val BrandGreenDark = Color(0xFF6EDD97)
private val Ink = Color(0xFF10151C)

private val LightColors = lightColorScheme(
    primary = BrandGreen,
    onPrimary = Color.White,
    surface = Color(0xFFF7F9F8),
    background = Color(0xFFF2F5F3),
    onSurface = Ink,
    surfaceVariant = Color(0xFFE4EAE6),
    error = Color(0xFFB3261E),
)

private val DarkColors = darkColorScheme(
    primary = BrandGreenDark,
    onPrimary = Ink,
    surface = Color(0xFF151A21),
    background = Color(0xFF0E1218),
    onSurface = Color(0xFFE6EAE7),
    surfaceVariant = Color(0xFF242B33),
    error = Color(0xFFF2B8B5),
)

@Composable
fun CompanionTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (isSystemInDarkTheme()) DarkColors else LightColors,
        content = content,
    )
}

object Sizes {
    val gutter = 16.dp
    val cardGap = 10.dp
    val corner = 14.dp
}
