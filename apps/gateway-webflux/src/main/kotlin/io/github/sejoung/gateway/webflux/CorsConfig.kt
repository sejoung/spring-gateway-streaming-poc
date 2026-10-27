package io.github.sejoung.gateway.webflux

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.reactive.CorsWebFilter
import org.springframework.web.cors.reactive.UrlBasedCorsConfigurationSource

/** Local-development CORS only (React dev server → gateway). No authentication is involved. */
@ConfigurationProperties("poc.cors")
data class CorsProperties(
    val allowedOrigins: List<String> = listOf("http://localhost:5173"),
)

@Configuration(proxyBeanMethods = false)
class CorsConfig {
    @Bean
    fun corsWebFilter(properties: CorsProperties): CorsWebFilter {
        val config =
            CorsConfiguration().apply {
                allowedOrigins = properties.allowedOrigins
                allowedMethods = listOf("POST", "OPTIONS")
                allowedHeaders = listOf("Content-Type", "Accept", "X-Request-Id")
                exposedHeaders = listOf("X-Request-Id")
                maxAge = 600
            }
        val source = UrlBasedCorsConfigurationSource().apply { registerCorsConfiguration("/api/chat/**", config) }
        return CorsWebFilter(source)
    }
}
