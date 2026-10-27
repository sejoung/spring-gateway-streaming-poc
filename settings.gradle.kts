pluginManagement {
    val kotlinVersion: String by settings
    val springBootVersion: String by settings
    plugins {
        kotlin("jvm") version kotlinVersion
        kotlin("plugin.spring") version kotlinVersion
        id("org.springframework.boot") version springBootVersion
        id("io.spring.dependency-management") version "1.1.7"
    }
}

rootProject.name = "spring-gateway-streaming-poc"

include(":apps:ai-backend", ":apps:gateway-mvc", ":apps:gateway-webflux")
