package io.github.sejoung.gateway.webflux

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication

@SpringBootApplication
@ConfigurationPropertiesScan
class GatewayWebfluxApplication

fun main(args: Array<String>) {
    runApplication<GatewayWebfluxApplication>(*args)
}
