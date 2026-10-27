plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "io.pinr.app"
    compileSdk = 37

    defaultConfig {
        applicationId = "io.pinr.app"
        minSdk = 26 // Android 8.0 (PLAN.md)
        targetSdk = 37
        versionCode = 1
        versionName = "0.1"
    }

    buildTypes {
        debug {
            // Test builds read the feed server on this Mac: the emulator reaches the Mac at 10.0.2.2.
            buildConfigField("String", "FEED_URL", "\"http://10.0.2.2:8787\"")
            buildConfigField("boolean", "HTTPS_ONLY", "false")
        }
        release {
            // Release builds read the server over HTTPS only; FeedLink refuses any other scheme.
            buildConfigField("String", "FEED_URL", "\"https://pinr.io\"")
            buildConfigField("boolean", "HTTPS_ONLY", "true")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
        // Test only: the release build's speed (optimised, not debuggable) against this Mac's feed, to measure the
        // screens as a phone will run them. Signed with this Mac's own debug key; never published.
        create("bench") {
            initWith(getByName("release"))
            buildConfigField("String", "FEED_URL", "\"http://10.0.2.2:8787\"")
            buildConfigField("boolean", "HTTPS_ONLY", "false")
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks += "release"
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.activity.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
}
