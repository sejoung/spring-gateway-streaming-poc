export interface SseEvent {
  event: string
  data: string
  id?: string
}

/**
 * Incremental text/event-stream parser.
 *
 * Network chunks do not line up with event boundaries, so text is buffered until a
 * complete line is available and an event is dispatched on each blank line.
 * Handles LF, CRLF and CR line endings, including a CRLF split across two chunks.
 */
export class SseParser {
  private buffer = ''
  private eventType = ''
  private dataLines: string[] = []
  private lastEventId: string | undefined

  constructor(private readonly onEvent: (event: SseEvent) => void) {}

  push(chunk: string): void {
    this.buffer += chunk
    let start = 0
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i]
      if (ch !== '\n' && ch !== '\r') continue
      // A trailing CR may be the first half of a CRLF; wait for the next chunk.
      if (ch === '\r' && i === this.buffer.length - 1) break
      this.processLine(this.buffer.slice(start, i))
      if (ch === '\r' && this.buffer[i + 1] === '\n') i++
      start = i + 1
    }
    this.buffer = this.buffer.slice(start)
  }

  /** Call when the stream ends; dispatches a final event that was not terminated by a blank line. */
  end(): void {
    if (this.buffer.length > 0) {
      this.processLine(this.buffer.replace(/\r$/, ''))
      this.buffer = ''
    }
    this.dispatch()
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch()
      return
    }
    if (line.startsWith(':')) return // comment / heartbeat

    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    switch (field) {
      case 'event':
        this.eventType = value
        break
      case 'data':
        this.dataLines.push(value)
        break
      case 'id':
        this.lastEventId = value
        break
    }
  }

  private dispatch(): void {
    if (this.dataLines.length > 0) {
      this.onEvent({ event: this.eventType || 'message', data: this.dataLines.join('\n'), id: this.lastEventId })
    }
    this.eventType = ''
    this.dataLines = []
  }
}
