// HTTP API for the client's test page. Progress is pushed as Server-Sent Events.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalogForClient } from './catalog.mjs'
import { Runner, summarizeRun, targetHealth } from './runner.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8070)
const runner = new Runner({
  dataDir: process.env.DATA_DIR ?? path.join(here, '..', 'data', 'runs'),
  k6Bin: process.env.K6_BIN ?? 'k6',
  script: process.env.K6_SCRIPT ?? path.join(here, '..', 'k6', 'sse-case.js'),
})

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(JSON.stringify(body))
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function caseListItem(r) {
  const { events, ...rest } = r
  return { ...rest, eventCount: events?.length ?? 0 }
}

function sse(req, res, runId) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' })
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const onRun = (run) => run.id === runId && send('run', { ...run, log: undefined, summary: run.summary ?? summarizeRun(run) })
  const onCase = (run, c) => run.id === runId && send('case', { case: c, summary: summarizeRun(run) })
  const onLog = (run, entry) => run.id === runId && send('log', entry)
  const onEnd = (run) => run.id === runId && send('end', { id: run.id, status: run.status })
  runner.on('run', onRun).on('case', onCase).on('log', onLog).on('end', onEnd)
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000)
  req.on('close', () => {
    clearInterval(heartbeat)
    runner.off('run', onRun).off('case', onCase).off('log', onLog).off('end', onEnd)
  })
  runner.getRun(runId).then((run) => {
    if (!run) return send('error', { message: '알 수 없는 실행입니다' })
    send('snapshot', { ...run, summary: run.summary ?? summarizeRun(run) })
    if (run.status !== 'running') send('end', { id: run.id, status: run.status })
  })
}

const routes = [
  ['GET', /^\/api\/catalog$/, (req, res) => json(res, 200, catalogForClient())],
  ['GET', /^\/api\/health$/, async (req, res) => json(res, 200, { runner: true, running: runner.current?.id ?? null, targets: await targetHealth() })],
  ['GET', /^\/api\/runs$/, async (req, res) => json(res, 200, await runner.listRuns())],
  ['POST', /^\/api\/runs$/, async (req, res) => {
    const body = await readBody(req)
    const mode = ['full', 'quick', 'custom'].includes(body.mode) ? body.mode : 'quick'
    const run = await runner.start(mode, Array.isArray(body.cases) ? body.cases : [])
    json(res, 202, { id: run.id })
  }],
  ['GET', /^\/api\/runs\/([^/]+)$/, async (req, res, [id]) => {
    const run = await runner.getRun(id)
    if (!run) return json(res, 404, { message: '알 수 없는 실행입니다' })
    json(res, 200, { ...run, summary: run.summary ?? summarizeRun(run) })
  }],
  ['POST', /^\/api\/runs\/([^/]+)\/stop$/, (req, res, [id]) => json(res, runner.stop(id) ? 202 : 409, {})],
  ['GET', /^\/api\/runs\/([^/]+)\/events$/, (req, res, [id]) => sse(req, res, id)],
  ['GET', /^\/api\/runs\/([^/]+)\/cases\/([^/]+)\/requests$/, async (req, res, [id, cid]) => {
    const list = await runner.requests(id, cid)
    if (!list) return json(res, 404, { message: '요청 기록이 없습니다' })
    json(res, 200, list.map(caseListItem))
  }],
  ['GET', /^\/api\/runs\/([^/]+)\/cases\/([^/]+)\/requests\/([^/]+)$/, async (req, res, [id, cid, rid]) => {
    const found = (await runner.requests(id, cid))?.find((r) => r.rid === rid)
    if (!found) return json(res, 404, { message: '요청을 찾을 수 없습니다' })
    json(res, 200, found)
  }],
  ['GET', /^\/api\/runs\/([^/]+)\/cases\/([^/]+)\/log$/, (req, res, [id, cid]) => {
    const file = runner.caseLogFile(id, cid)
    if (!fs.existsSync(file)) return json(res, 404, { message: '로그가 없습니다' })
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    fs.createReadStream(file).pipe(res)
  }],
  ['GET', /^\/api\/runs\/([^/]+)\/cases\/([^/]+)\/raw$/, async (req, res, [id, cid]) => {
    const files = await runner.rawFiles(id, cid)
    if (!files.length) return json(res, 404, { message: 'k6 원시 데이터가 없습니다' })
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${id}_${cid}.k6.jsonl"`,
    })
    for (const f of files) {
      await new Promise((resolve, reject) => fs.createReadStream(f).on('end', resolve).on('error', reject).pipe(res, { end: false }))
    }
    res.end()
  }],
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  for (const [method, pattern, handler] of routes) {
    const m = req.method === method && pattern.exec(url.pathname)
    if (!m) continue
    try {
      return await handler(req, res, m.slice(1).map(decodeURIComponent))
    } catch (e) {
      return json(res, e.status ?? 500, { message: e.message })
    }
  }
  json(res, 404, { message: 'Not found' })
})

await runner.init()
server.listen(PORT, () => console.log(`test-runner listening on :${PORT}`))
