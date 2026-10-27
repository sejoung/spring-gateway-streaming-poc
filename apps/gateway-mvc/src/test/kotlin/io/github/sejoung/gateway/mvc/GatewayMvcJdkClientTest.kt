package io.github.sejoung.gateway.mvc

import org.junit.jupiter.api.Test
import org.springframework.boot.test.context.SpringBootTest
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Default configuration: Gateway MVC with the JDK HttpClient. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class GatewayMvcJdkClientTest : GatewayStreamingTestSupport() {
    /**
     * Characterises current behaviour (Spring Framework 6.2.11 / Gateway 4.3.5): after the client goes away,
     * `JdkClientHttpResponse.close()` drains the remaining upstream body, so the upstream is never cancelled and the
     * request thread stays busy until the upstream stream ends. If this starts failing, the drain was fixed upstream.
     */
    @Test
    fun `client disconnect does not cancel the upstream, the rest of the stream is drained`() {
        val id = UUID.randomUUID().toString()
        val abortedAt = abortAfterFirstEvent(id, events = 20, delayMs = 50)

        val (outcome, finishedAt) = FakeSseUpstream.awaitOutcome(id)

        assertEquals(FakeSseUpstream.Outcome.COMPLETED, outcome)
        assertTrue(finishedAt - abortedAt >= 500, "upstream finished ${finishedAt - abortedAt}ms after abort")
    }
}
