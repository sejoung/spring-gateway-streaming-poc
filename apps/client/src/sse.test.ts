import { describe, expect, it } from 'vitest'
import { SseParser, type SseEvent } from './sse'

function parse(chunks: string[]): SseEvent[] {
  const events: SseEvent[] = []
  const parser = new SseParser((e) => events.push(e))
  chunks.forEach((c) => parser.push(c))
  parser.end()
  return events
}

const stream =
  'event: token\ndata: {"index":0,"content":"token-0"}\n\n' +
  'event:token\ndata:{"index":1,"content":"token-1"}\n\n' +
  'event: done\ndata: {"total":2}\n\n'

const expected: SseEvent[] = [
  { event: 'token', data: '{"index":0,"content":"token-0"}', id: undefined },
  { event: 'token', data: '{"index":1,"content":"token-1"}', id: undefined },
  { event: 'done', data: '{"total":2}', id: undefined },
]

describe('SseParser', () => {
  it('parses whole events', () => {
    expect(parse([stream])).toEqual(expected)
  })

  it('parses events split at every possible chunk boundary', () => {
    for (let i = 1; i < stream.length; i++) {
      expect(parse([stream.slice(0, i), stream.slice(i)])).toEqual(expected)
    }
  })

  it('parses one character at a time', () => {
    expect(parse(stream.split(''))).toEqual(expected)
  })

  it('handles CRLF, including a CRLF split across chunks', () => {
    const crlf = stream.replace(/\n/g, '\r\n')
    expect(parse([crlf])).toEqual(expected)
    for (let i = 1; i < crlf.length; i++) {
      expect(parse([crlf.slice(0, i), crlf.slice(i)])).toEqual(expected)
    }
  })

  it('handles bare CR line endings', () => {
    expect(parse([stream.replace(/\n/g, '\r')])).toEqual(expected)
  })

  it('joins multi-line data and ignores comments', () => {
    expect(parse([': keep-alive\n\ndata: a\ndata: b\nid: 7\n\n'])).toEqual([{ event: 'message', data: 'a\nb', id: '7' }])
  })

  it('dispatches a final event without trailing blank line on end()', () => {
    expect(parse(['event: done\ndata: {}'])).toEqual([{ event: 'done', data: '{}', id: undefined }])
  })
})
