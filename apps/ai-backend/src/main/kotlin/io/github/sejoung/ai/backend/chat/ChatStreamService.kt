package io.github.sejoung.ai.backend.chat

import org.slf4j.LoggerFactory
import org.springframework.http.HttpStatus
import org.springframework.http.codec.ServerSentEvent
import org.springframework.stereotype.Service
import org.springframework.web.server.ResponseStatusException
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import java.time.Clock
import java.time.Duration

/**
 * Deterministic mock of an LLM token stream: `count` token events at a fixed `delayMs`
 * interval followed by a single `done` event.
 */
@Service
class ChatStreamService(
    private val properties: ChatStreamProperties,
    private val registry: StreamRegistry,
    private val clock: Clock,
) {
    private val log = LoggerFactory.getLogger(javaClass)

    fun stream(requestId: String, request: ChatRequest): Flux<ServerSentEvent<Any>> {
        validate(request)
        if (request.failMode == FailMode.BEFORE_HEADERS) {
            log.warn("stream rejected requestId={} reason=simulated-failure-before-headers", requestId)
            throw ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Simulated failure before headers")
        }

        return Flux.defer {
            val record = registry.start(requestId, request)
            log.info(
                "stream started requestId={} count={} delayMs={} failMode={}",
                requestId, request.count, request.delayMs, request.failMode,
            )
            tokens(requestId, request, record)
                .concatWith(Mono.fromCallable { done(record) })
                .doOnComplete {
                    registry.finish(record, StreamOutcome.COMPLETED)
                    log.info("stream completed requestId={} events={} elapsedMs={}", requestId, record.emittedEvents, elapsed(record))
                }
                .doOnCancel {
                    registry.finish(record, StreamOutcome.CANCELLED)
                    log.info(
                        "stream cancelled requestId={} events={} elapsedMs={} sinceLastEventMs={}",
                        requestId, record.emittedEvents, elapsed(record), record.lastEmittedAt?.let { clock.millis() - it },
                    )
                }
                .doOnError { e ->
                    registry.finish(record, StreamOutcome.FAILED)
                    log.warn("stream failed requestId={} events={} error={}", requestId, record.emittedEvents, e.message)
                }
        }
    }

    private fun tokens(requestId: String, request: ChatRequest, record: StreamRecord): Flux<ServerSentEvent<Any>> =
        Flux.range(0, request.count)
            .delayElements(Duration.ofMillis(request.delayMs))
            .map { index ->
                if (request.failMode == FailMode.MID_STREAM && index == request.count / 2) {
                    throw SimulatedStreamFailure("Simulated failure after $index events")
                }
                val now = clock.millis()
                record.emitted(now)
                if (properties.logEachEvent) {
                    log.info("token emitted requestId={} index={} emittedAt={}", requestId, index, now)
                }
                ServerSentEvent.builder<Any>(TokenEvent(index, "token-$index", now)).event("token").build()
            }

    private fun done(record: StreamRecord): ServerSentEvent<Any> =
        ServerSentEvent.builder<Any>(DoneEvent(record.count, elapsed(record))).event("done").build()

    private fun elapsed(record: StreamRecord) = clock.millis() - record.startedAt

    private fun validate(request: ChatRequest) {
        fun reject(reason: String): Nothing = throw ResponseStatusException(HttpStatus.BAD_REQUEST, reason)

        if (request.count !in 1..properties.maxCount) reject("count must be between 1 and ${properties.maxCount}")
        if (request.delayMs !in 0..properties.maxDelayMs) reject("delayMs must be between 0 and ${properties.maxDelayMs}")
        if (request.count * request.delayMs > properties.maxDuration.toMillis()) {
            reject("count * delayMs must not exceed ${properties.maxDuration.toMillis()}ms")
        }
    }
}

class SimulatedStreamFailure(message: String) : RuntimeException(message)
