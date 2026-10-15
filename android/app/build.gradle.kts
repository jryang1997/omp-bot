import java.util.Properties

plugins {
    id("com.android.application")
    kotlin("android")
    kotlin("plugin.compose")
    kotlin("plugin.serialization")
}

// 版本只有这一处：versionCode 由 versionName 派生（MAJOR*10000+MINOR*100+PATCH），
// 升级时改一行，不会出现两个数字不同步。
private val appVersionName = "0.1.0"

private val appVersionCode = run {
    val parts = appVersionName.split(".").map { it.toIntOrNull() ?: -1 }
    check(parts.size == 3 && parts.all { it in 0..99 }) {
        "versionName 必须是 MAJOR.MINOR.PATCH（每段 0..99），当前是 \"$appVersionName\""
    }
    parts[0] * 10_000 + parts[1] * 100 + parts[2]
}

// Release 签名材料是可选的，而且只从**仓库外**来：
//   - android/keystore.properties（gitignore）：storeFile/storePassword/keyAlias[keyPassword]
//   - 或环境变量 OMPBOT_KEYSTORE_FILE / _PASSWORD / _ALIAS / _KEY_PASSWORD
// 都没有时 assembleRelease 产出 app-release-unsigned.apk，交给 build 脚本用 per-user
// keystore 签名 —— 这是受支持的默认路径，不是降级。
private val keystoreProperties = Properties().apply {
    val file = rootProject.file("keystore.properties")
    if (file.isFile) file.inputStream().use(::load)
}

private fun signingMaterial(property: String, environment: String): String? =
    (System.getenv(environment) ?: keystoreProperties.getProperty(property))?.takeIf(String::isNotBlank)

private val storeFilePath = signingMaterial("storeFile", "OMPBOT_KEYSTORE_FILE")
private val storePasswordValue = signingMaterial("storePassword", "OMPBOT_KEYSTORE_PASSWORD")
private val keyAliasValue = signingMaterial("keyAlias", "OMPBOT_KEYSTORE_ALIAS")
private val keyPasswordValue = signingMaterial("keyPassword", "OMPBOT_KEYSTORE_KEY_PASSWORD") ?: storePasswordValue

private val releaseKeystore: java.io.File? = when {
    storeFilePath == null && storePasswordValue == null && keyAliasValue == null -> null
    storeFilePath == null || storePasswordValue == null || keyAliasValue == null -> error(
        "签名材料只配了一半：需要 storeFile/storePassword/keyAlias 三项齐全，或者一项都不给。",
    )
    else -> rootProject.file(storeFilePath).also { check(it.isFile) { "找不到 keystore：${it.absolutePath}" } }
}

android {
    namespace = "org.ompbot.companion"
    compileSdk = 36

    defaultConfig {
        applicationId = "org.ompbot.companion"
        minSdk = 26
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        if (releaseKeystore != null) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = storePasswordValue
                keyAlias = keyAliasValue
                keyPassword = keyPasswordValue
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            // 没有签名材料时留空 → app-release-unsigned.apk，文件名自己说明发生了什么。
            signingConfig = signingConfigs.findByName("release")

            isMinifyEnabled = false
            isShrinkResources = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core"))

    val composeBom = platform("androidx.compose:compose-bom:2025.10.01")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.activity:activity-compose:1.11.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.9.4")
    implementation("androidx.lifecycle:lifecycle-process:2.9.4")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.9.4")
    implementation("androidx.datastore:datastore-preferences:1.1.7")
    implementation("androidx.security:security-crypto:1.1.0-alpha07")
    implementation("androidx.core:core-ktx:1.17.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.10.2")

    // 配对二维码：CameraX 给预览与取帧，ML Kit 的**内置**条码模型读码。
    // 用内置而不是 Play services 版：配对常发生在没有 GMS 的手机上，而两分钟窗口内
    // 现下模型是最容易失败的一种设计。
    implementation("androidx.camera:camera-core:1.5.0")
    implementation("androidx.camera:camera-camera2:1.5.0")
    implementation("androidx.camera:camera-lifecycle:1.5.0")
    implementation("androidx.camera:camera-view:1.5.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlin:kotlin-test-junit:2.2.21")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.10.2")
}
