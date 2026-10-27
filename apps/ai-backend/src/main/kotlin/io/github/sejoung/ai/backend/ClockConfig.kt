package io.github.sejoung.ai.backend

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import java.time.Clock

@Configuration(proxyBeanMethods = false)
class ClockConfig {
    @Bean
    fun clock(): Clock = Clock.systemUTC()
}
