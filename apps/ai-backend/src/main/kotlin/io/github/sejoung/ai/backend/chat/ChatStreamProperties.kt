package io.github.sejoung.ai.backend.chat

import org.springframework.boot.context.properties.ConfigurationProperties
import java.time.Duration

@ConfigurationProperties("chat.stream")
data class ChatStreamProperties(
    val maxCount: Int = 10_000,
    val maxDelayMs: Long = 60_000,
    val maxDuration: Duration = Duration.ofMinutes(10),
    /** Log every emitted token. Turn off for load tests to keep logging out of the measurement. */
    val logEachEvent: Boolean = true,
    /** How many finished streams [StreamRegistry] keeps for inspection. */
    val registryCapacity: Int = 10_000,
)
