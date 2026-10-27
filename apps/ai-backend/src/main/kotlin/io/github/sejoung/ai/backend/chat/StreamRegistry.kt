package io.github.sejoung.ai.backend.chat

import org.springframework.stereotype.Component
import java.time.Clock
import java.util.concurrent.atomic.AtomicInteger

/**
 * Keeps per-request stream timestamps so scripts can measure cancel propagation
 * (client abort time vs. [StreamRecord.cancelledAt]) without parsing logs.
 */
@Component
class StreamRegistry(
    private val properties: ChatStreamProperties,
    private val clock: Clock,
) {
    private val active = AtomicInteger()

    private val records =
        object : LinkedHashMap<String, StreamRecord>() {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StreamRecord>) =
                size > properties.registryCapacity
        }

    fun start(requestId: String, request: ChatRequest): StreamRecord {
        val record = StreamRecord(requestId, request.count, request.delayMs, startedAt = clock.millis())
        synchronized(records) { records[requestId] = record }
        active.incrementAndGet()
        return record
    }

    fun finish(record: StreamRecord, outcome: StreamOutcome) {
        if (record.finish(outcome, clock.millis())) {
            active.decrementAndGet()
        }
    }

    fun find(requestId: String): StreamRecord? = synchronized(records) { records[requestId] }

    fun activeCount(): Int = active.get()
}

enum class StreamOutcome { RUNNING, COMPLETED, CANCELLED, FAILED }

class StreamRecord(
    val requestId: String,
    val count: Int,
    val delayMs: Long,
    val startedAt: Long,
) {
    @Volatile var emittedEvents: Int = 0
        private set

    @Volatile var lastEmittedAt: Long? = null
        private set

    @Volatile var outcome: StreamOutcome = StreamOutcome.RUNNING
        private set

    @Volatile var finishedAt: Long? = null
        private set

    fun emitted(at: Long) {
        emittedEvents++
        lastEmittedAt = at
    }

    @Synchronized
    fun finish(outcome: StreamOutcome, at: Long): Boolean {
        if (this.outcome != StreamOutcome.RUNNING) return false
        this.outcome = outcome
        this.finishedAt = at
        return true
    }
}
