package io.github.sejoung.ai.backend.chat

data class ChatRequest(
    val message: String,
    val count: Int = 10,
    val delayMs: Long = 200,
    /** Failure injection for error-propagation scenarios (T09). */
    val failMode: FailMode = FailMode.NONE,
)

enum class FailMode {
    NONE,

    /** Respond with HTTP 500 before any SSE byte (and before response headers) is written. */
    BEFORE_HEADERS,

    /** Emit half of the tokens, then terminate the already committed 200 stream with an error. */
    MID_STREAM,
}

data class TokenEvent(
    val index: Int,
    val content: String,
    /** Backend epoch millis when this event was produced; lets clients compute per-event proxy lag. */
    val emittedAt: Long,
)

data class DoneEvent(
    val total: Int,
    val elapsedMs: Long,
)
