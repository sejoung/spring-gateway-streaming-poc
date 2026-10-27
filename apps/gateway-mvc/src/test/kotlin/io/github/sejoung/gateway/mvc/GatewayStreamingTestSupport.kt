package io.github.sejoung.gateway.mvc

import org.junit.jupiter.api.Test
import org.springframework.boot.test.web.server.LocalServerPort
import org.springframework.test.context.DynamicPropertyRegistry
import org.springframework.test.context.DynamicPropertySource
import java.net.Socket
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.util.UUID
import kotlin.test.assertEquals
import kotlin.test.assertTrue

abstract class GatewayStreamingTestSupport {
    @LocalServerPort
    protected var port: Int = 0

    private val http = HttpClient.newHttpClient()

    @Test
    fun `forwards each event before the upstream finishes`() {
        val id = UUID.randomUUID().toString()
        val start = System.currentTimeMillis()
        val response =
            http.send(
                HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/chat/stream?id=$id&events=$EVENTS&delayMs=$DELAY_MS"))
                    .header("Content-Type", "application/json")
                    .header("Accept", "text/event-stream")
                    .POST(HttpRequest.BodyPublishers.ofString("""{"message":"hi"}"""))
                    .build(),
                HttpResponse.BodyHandlers.ofLines(),
            )

        assertEquals(200, response.statusCode())
        assertTrue(response.headers().firstValue("Content-Type").get().startsWith("text/event-stream"))
        assertEquals("no-cache", response.headers().firstValue("Cache-Control").get())

        val dataLines = mutableListOf<Pair<String, Long>>()
        response.body().use { lines ->
            lines.filter { it.startsWith("data:") }.forEach { dataLines += it to System.currentTimeMillis() }
        }

        assertEquals(EVENTS + 1, dataLines.size)
        dataLines.take(EVENTS).forEachIndexed { i, (line, _) -> assertTrue(line.contains("\"index\":$i"), line) }
        val firstEventAt = dataLines.first().second
        val (_, upstreamFinishedAt) = FakeSseUpstream.awaitOutcome(id)
        // Upstream needs EVENTS * DELAY_MS in total; a buffering proxy would deliver the first event only at the end.
        assertTrue(firstEventAt - start < DELAY_MS * 3, "first event after ${firstEventAt - start}ms")
        assertTrue(firstEventAt < upstreamFinishedAt, "first event arrived only after the upstream finished")
    }

    @Test
    fun `answers CORS preflight for the local React origin`() {
        val response =
            http.send(
                HttpRequest.newBuilder(URI("http://127.0.0.1:$port/api/chat/stream"))
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .header("Origin", "http://localhost:5173")
                    .header("Access-Control-Request-Method", "POST")
                    .header("Access-Control-Request-Headers", "content-type,x-request-id")
                    .build(),
                HttpResponse.BodyHandlers.discarding(),
            )

        assertEquals(200, response.statusCode())
        assertEquals("http://localhost:5173", response.headers().firstValue("Access-Control-Allow-Origin").get())
        assertTrue(response.headers().firstValue("Access-Control-Allow-Headers").get().contains("x-request-id", ignoreCase = true))
    }

    /** Reads the first proxied event over a raw socket, closes the socket and returns the close time. */
    protected fun abortAfterFirstEvent(id: String, events: Int, delayMs: Long): Long {
        Socket("127.0.0.1", port).use { socket ->
            val body = """{"message":"hi"}"""
            socket.getOutputStream().write(
                ("POST /api/chat/stream?id=$id&events=$events&delayMs=$delayMs HTTP/1.1\r\nHost: localhost\r\n" +
                    "Content-Type: application/json\r\nAccept: text/event-stream\r\n" +
                    "Content-Length: ${body.length}\r\n\r\n$body").toByteArray(),
            )
            val reader = socket.getInputStream().bufferedReader()
            while (reader.readLine()?.startsWith("data:") == false) {
                // read until the first event has been proxied
            }
        }
        return System.currentTimeMillis()
    }

    companion object {
        private const val EVENTS = 5
        private const val DELAY_MS = 300L

        @JvmStatic
        @DynamicPropertySource
        fun upstreamProperties(registry: DynamicPropertyRegistry) {
            registry.add("poc.backend-url") { FakeSseUpstream.url }
        }
    }
}
