package io.github.sejoung.gateway.mvc

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.web.servlet.FilterRegistrationBean
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.Ordered
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import org.springframework.web.filter.CorsFilter

/** Local-development CORS only (React dev server → gateway). No authentication is involved. */
@ConfigurationProperties("poc.cors")
data class CorsProperties(
    val allowedOrigins: List<String> = listOf("http://localhost:5173"),
)

@Configuration(proxyBeanMethods = false)
class CorsConfig {
    @Bean
    fun corsFilter(properties: CorsProperties): FilterRegistrationBean<CorsFilter> {
        val config =
            CorsConfiguration().apply {
                allowedOrigins = properties.allowedOrigins
                allowedMethods = listOf("POST", "OPTIONS")
                allowedHeaders = listOf("Content-Type", "Accept", "X-Request-Id")
                exposedHeaders = listOf("X-Request-Id")
                maxAge = 600
            }
        val source = UrlBasedCorsConfigurationSource().apply { registerCorsConfiguration("/api/chat/**", config) }
        return FilterRegistrationBean(CorsFilter(source)).apply { order = Ordered.HIGHEST_PRECEDENCE }
    }
}
