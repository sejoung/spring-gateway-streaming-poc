package io.github.sejoung.gateway.mvc

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.boot.http.client.ClientHttpRequestFactoryBuilder
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration

@ConfigurationProperties("poc.jetty-client")
data class JettyClientProperties(
    /**
     * Jetty's default is 64. Every proxied SSE stream holds one upstream connection for its whole lifetime,
     * so with the default the 65th concurrent stream waits in Jetty's queue until another stream ends.
     */
    val maxConnectionsPerDestination: Int = 2048,
)

/** Only active with spring.http.client.factory=jetty; replaces Boot's default builder to size the connection pool. */
@Configuration(proxyBeanMethods = false)
@ConditionalOnProperty("spring.http.client.factory", havingValue = "jetty")
class JettyClientConfig {
    @Bean
    fun jettyClientHttpRequestFactoryBuilder(properties: JettyClientProperties): ClientHttpRequestFactoryBuilder<*> =
        ClientHttpRequestFactoryBuilder.jetty()
            .withHttpClientCustomizer { it.maxConnectionsPerDestination = properties.maxConnectionsPerDestination }
}
