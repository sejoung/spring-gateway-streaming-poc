package io.github.sejoung.ai.backend.chat

import org.springframework.http.HttpStatus
import org.springframework.http.MediaType
import org.springframework.http.codec.ServerSentEvent
import org.springframework.http.server.reactive.ServerHttpResponse
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RestController
import org.springframework.web.server.ResponseStatusException
import reactor.core.publisher.Flux
import java.util.UUID

const val REQUEST_ID_HEADER = "X-Request-Id"

private val REQUEST_ID_PATTERN = Regex("[A-Za-z0-9._-]{1,64}")

@RestController
class ChatController(
    private val chatStreamService: ChatStreamService,
    private val registry: StreamRegistry,
) {
    @PostMapping(
        "/api/chat/stream",
        consumes = [MediaType.APPLICATION_JSON_VALUE],
        produces = [MediaType.TEXT_EVENT_STREAM_VALUE],
    )
    fun stream(
        @RequestBody request: ChatRequest,
        @RequestHeader(REQUEST_ID_HEADER, required = false) requestId: String?,
        response: ServerHttpResponse,
    ): Flux<ServerSentEvent<Any>> {
        val id = requestId?.takeIf { REQUEST_ID_PATTERN.matches(it) } ?: UUID.randomUUID().toString()
        response.headers.set(REQUEST_ID_HEADER, id)
        response.headers.cacheControl = "no-cache"
        // Hint for nginx-style front proxies; Spring Cloud Gateway ignores it.
        response.headers.set("X-Accel-Buffering", "no")
        return chatStreamService.stream(id, request)
    }

    /** Not routed by the gateways: test scripts call the backend directly to read stream timestamps. */
    @GetMapping("/internal/streams/{requestId}")
    fun streamRecord(@PathVariable requestId: String): StreamRecordView =
        registry.find(requestId)?.let(StreamRecordView::of)
            ?: throw ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown requestId $requestId")

    @GetMapping("/internal/streams")
    fun activeStreams(): Map<String, Int> = mapOf("active" to registry.activeCount())
}

data class StreamRecordView(
    val requestId: String,
    val count: Int,
    val delayMs: Long,
    val startedAt: Long,
    val emittedEvents: Int,
    val lastEmittedAt: Long?,
    val outcome: StreamOutcome,
    val finishedAt: Long?,
) {
    companion object {
        fun of(r: StreamRecord) =
            StreamRecordView(r.requestId, r.count, r.delayMs, r.startedAt, r.emittedEvents, r.lastEmittedAt, r.outcome, r.finishedAt)
    }
}
