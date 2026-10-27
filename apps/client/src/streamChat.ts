import { SseParser, type SseEvent } from './sse'

export interface ChatStreamRequest {
  message: string
  count: number
  delayMs: number
}

export interface StreamCallbacks {
  onOpen?: (info: { status: number; requestId: string | null }) => void
  onEvent: (event: SseEvent, receivedAt: number) => void
}

/**
 * POSTs to the gateway and reads the SSE body with fetch + ReadableStream.
 * EventSource is not usable here: it only supports GET and cannot send a JSON body or custom headers.
 * Resolves when the stream ends; rejects with an AbortError when `signal` is aborted.
 */
export async function streamChat(
  baseUrl: string,
  request: ChatStreamRequest,
  requestId: string,
  signal: AbortSignal,
  callbacks: StreamCallbacks,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/chat/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Request-Id': requestId,
    },
    body: JSON.stringify(request),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  if (!response.body) throw new Error('Response has no body')

  callbacks.onOpen?.({ status: response.status, requestId: response.headers.get('X-Request-Id') })

  const parser = new SseParser((event) => callbacks.onEvent(event, performance.now()))
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      parser.push(value)
    }
    parser.end()
  } finally {
    reader.releaseLock()
  }
}
