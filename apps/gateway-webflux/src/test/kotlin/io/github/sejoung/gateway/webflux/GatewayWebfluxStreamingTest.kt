package io.github.sejoung.gateway.webflux

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Gateway WebFlux (Reactor Netty client); cancelling the downstream disposes the upstream connection. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class GatewayWebfluxStreamingTest : GatewayStreamingTestSupport() {
    @Test
    fun `client disconnect cancels the upstream`() {
        val id = UUID.randomUUID().toString()
        val abortedAt = abortAfterFirstEvent(id, events = 1_000, delayMs = 100)

        val (outcome, finishedAt) = FakeSseUpstream.awaitOutcome(id)

        assertEquals(FakeSseUpstream.Outcome.DISCONNECTED, outcome)
        assertTrue(finishedAt - abortedAt < 2_000, "upstream noticed the abort after ${finishedAt - abortedAt}ms")
    }
}
