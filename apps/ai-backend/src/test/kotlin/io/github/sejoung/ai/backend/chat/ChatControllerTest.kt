package io.github.sejoung.ai.backend.chat

import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.boot.test.context.SpringBootTest
import org.springframework.http.MediaType
import org.springframework.test.web.reactive.server.WebTestClient
import org.springframework.test.web.reactive.server.expectBody
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

@SpringBootTest(
    webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
    properties = ["chat.stream.log-each-event=false"],
)
class ChatControllerTest(
    @Autowired private val client: WebTestClient,
) {
    @Test
    fun `streams token and done events as text event stream`() {
        val body =
            client.post().uri("/api/chat/stream")
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .header(REQUEST_ID_HEADER, "test-1")
                .bodyValue("""{"message":"hello","count":3,"delayMs":10}""")
                .exchange()
                .expectStatus().isOk
                .expectHeader().contentTypeCompatibleWith(MediaType.TEXT_EVENT_STREAM)
                .expectHeader().valueEquals("Cache-Control", "no-cache")
                .expectHeader().valueEquals(REQUEST_ID_HEADER, "test-1")
                .expectBody<String>()
                .returnResult()
                .responseBody!!

        val events = body.split("\n\n").filter { it.isNotBlank() }
        assertEquals(4, events.size)
        events.take(3).forEachIndexed { i, event ->
            assertTrue(event.startsWith("event:token\ndata:{\"index\":$i,\"content\":\"token-$i\""), event)
        }
        assertTrue(events.last().startsWith("event:done\ndata:{\"total\":3"), events.last())
    }

    @Test
    fun `generates request id when missing`() {
        val result =
            client.post().uri("/api/chat/stream")
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .bodyValue("""{"message":"hello","count":1,"delayMs":0}""")
                .exchange()
                .expectStatus().isOk
                .returnResult(String::class.java)
        assertNotNull(result.responseHeaders.getFirst(REQUEST_ID_HEADER))
    }

    @Test
    fun `rejects too many tokens with 400`() {
        client.post().uri("/api/chat/stream")
            .contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.TEXT_EVENT_STREAM)
            .bodyValue("""{"message":"hello","count":100000}""")
            .exchange()
            .expectStatus().isBadRequest
    }

    @Test
    fun `failure before headers returns 500`() {
        client.post().uri("/api/chat/stream")
            .contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.TEXT_EVENT_STREAM)
            .bodyValue("""{"message":"hello","failMode":"BEFORE_HEADERS"}""")
            .exchange()
            .expectStatus().is5xxServerError
    }
}
