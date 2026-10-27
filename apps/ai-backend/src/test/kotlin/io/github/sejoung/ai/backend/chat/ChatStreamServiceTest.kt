package io.github.sejoung.ai.backend.chat

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.springframework.http.HttpStatus
import org.springframework.web.server.ResponseStatusException
import reactor.test.StepVerifier
import java.time.Clock
import java.time.Duration
import kotlin.test.assertEquals

class ChatStreamServiceTest {
    private val properties = ChatStreamProperties(maxCount = 100, maxDelayMs = 1_000, logEachEvent = false)
    private val clock = Clock.systemUTC()
    private val registry = StreamRegistry(properties, clock)
    private val service = ChatStreamService(properties, registry, clock)

    @Test
    fun `emits count tokens at delay interval then done`() {
        StepVerifier.withVirtualTime { service.stream("r1", ChatRequest("hi", count = 3, delayMs = 200)) }
            .expectSubscription()
            .expectNoEvent(Duration.ofMillis(199))
            .thenAwait(Duration.ofMillis(1))
            .assertNext { assertToken(it.event(), it.data(), 0) }
            .expectNoEvent(Duration.ofMillis(199))
            .thenAwait(Duration.ofMillis(1))
            .assertNext { assertToken(it.event(), it.data(), 1) }
            .thenAwait(Duration.ofMillis(200))
            .assertNext { assertToken(it.event(), it.data(), 2) }
            .assertNext {
                assertEquals("done", it.event())
                assertEquals(3, (it.data() as DoneEvent).total)
            }
            .verifyComplete()

        assertEquals(StreamOutcome.COMPLETED, registry.find("r1")!!.outcome)
        assertEquals(3, registry.find("r1")!!.emittedEvents)
    }

    @Test
    fun `records cancellation`() {
        StepVerifier.withVirtualTime { service.stream("r2", ChatRequest("hi", count = 10, delayMs = 100)) }
            .thenAwait(Duration.ofMillis(100))
            .expectNextCount(1)
            .thenCancel()
            .verify()

        val record = registry.find("r2")!!
        assertEquals(StreamOutcome.CANCELLED, record.outcome)
        assertEquals(1, record.emittedEvents)
        assertEquals(0, registry.activeCount())
    }

    @Test
    fun `mid stream failure errors after half of the tokens`() {
        StepVerifier.withVirtualTime { service.stream("r3", ChatRequest("hi", count = 4, delayMs = 10, failMode = FailMode.MID_STREAM)) }
            .thenAwait(Duration.ofMillis(40))
            .expectNextCount(2)
            .expectError(SimulatedStreamFailure::class.java)
            .verify()

        assertEquals(StreamOutcome.FAILED, registry.find("r3")!!.outcome)
    }

    @Test
    fun `failure before headers is thrown synchronously`() {
        val e = assertThrows<ResponseStatusException> {
            service.stream("r4", ChatRequest("hi", failMode = FailMode.BEFORE_HEADERS))
        }
        assertEquals(HttpStatus.INTERNAL_SERVER_ERROR, e.statusCode)
    }

    @Test
    fun `rejects requests above limits`() {
        listOf(
            ChatRequest("hi", count = 0),
            ChatRequest("hi", count = 101),
            ChatRequest("hi", delayMs = -1),
            ChatRequest("hi", delayMs = 1_001),
        ).forEach { request ->
            val e = assertThrows<ResponseStatusException> { service.stream("r5", request) }
            assertEquals(HttpStatus.BAD_REQUEST, e.statusCode)
        }
    }

    private fun assertToken(event: String?, data: Any?, index: Int) {
        assertEquals("token", event)
        val token = data as TokenEvent
        assertEquals(index, token.index)
        assertEquals("token-$index", token.content)
    }
}
