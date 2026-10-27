package io.github.sejoung.gateway.mvc

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Gateway MVC with the Jetty client, whose response close() aborts instead of draining. */
@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["spring.http.client.factory=jetty"],
)
class GatewayMvcJettyClientTest : GatewayStreamingTestSupport() {
    @Test
    fun `client disconnect cancels the upstream`() {
        val id = UUID.randomUUID().toString()
        val abortedAt = abortAfterFirstEvent(id, events = 1_000, delayMs = 100)

        val (outcome, finishedAt) = FakeSseUpstream.awaitOutcome(id)

        assertEquals(FakeSseUpstream.Outcome.DISCONNECTED, outcome)
        assertTrue(finishedAt - abortedAt < 2_000, "upstream noticed the abort after ${finishedAt - abortedAt}ms")
    }
}
