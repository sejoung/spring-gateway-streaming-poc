package io.github.sejoung.gateway.mvc

import com.sun.net.httpserver.HttpServer
import java.io.IOException
import java.net.InetSocketAddress
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Minimal SSE upstream on the JDK HTTP server. It writes and flushes one event per `delayMs`
 * (query parameters `id`, `events`, `delayMs`), so a buffering proxy shows up as a late first event,
 * and records per request whether the stream completed or the downstream (the gateway) went away.
 */
object FakeSseUpstream {
    enum class Outcome { COMPLETED, DISCONNECTED }

    private val outcomes = ConcurrentHashMap<String, CompletableFuture<Pair<Outcome, Long>>>()

    private val server =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            executor = Executors.newCachedThreadPool { r -> Thread(r).apply { isDaemon = true } }
            createContext("/api/chat/stream") { exchange ->
                exchange.requestBody.readAllBytes()
                val query = exchange.requestURI.query.orEmpty().split("&").associate { it.substringBefore("=") to it.substringAfter("=") }
                val outcome = outcome(query["id"] ?: "default")
                val events = query["events"]?.toInt() ?: 5
                val delayMs = query["delayMs"]?.toLong() ?: 300
                exchange.responseHeaders.add("Content-Type", "text/event-stream")
                exchange.responseHeaders.add("Cache-Control", "no-cache")
                exchange.sendResponseHeaders(200, 0)
                try {
                    exchange.responseBody.use { out ->
                        repeat(events) { i ->
                            Thread.sleep(delayMs)
                            out.write("event: token\ndata: {\"index\":$i,\"content\":\"token-$i\"}\n\n".toByteArray())
                            out.flush()
                        }
                        out.write("event: done\ndata: {\"total\":$events}\n\n".toByteArray())
                        out.flush()
                    }
                    outcome.complete(Outcome.COMPLETED to System.currentTimeMillis())
                } catch (e: IOException) {
                    outcome.complete(Outcome.DISCONNECTED to System.currentTimeMillis())
                }
            }
            start()
        }

    val url: String get() = "http://127.0.0.1:${server.address.port}"

    private fun outcome(id: String) = outcomes.computeIfAbsent(id) { CompletableFuture() }

    /** Returns how the upstream stream `id` ended and when (epoch millis). */
    fun awaitOutcome(id: String, timeoutSeconds: Long = 10): Pair<Outcome, Long> = outcome(id).get(timeoutSeconds, TimeUnit.SECONDS)
}
