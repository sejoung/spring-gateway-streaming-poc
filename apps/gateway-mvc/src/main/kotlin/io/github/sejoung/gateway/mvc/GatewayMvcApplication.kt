package io.github.sejoung.gateway.mvc

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication
@ConfigurationPropertiesScan
class GatewayMvcApplication

fun main(args: Array<String>) {
    runApplication<GatewayMvcApplication>(*args)
}
