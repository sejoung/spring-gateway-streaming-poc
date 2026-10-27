package io.github.sejoung.ai.backend

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication
@ConfigurationPropertiesScan
class AiBackendApplication

fun main(args: Array<String>) {
    runApplication<AiBackendApplication>(*args)
}
