// Executes a run: one `k6 run` per case (and per sub-run), keeps k6's raw JSON output,
// extracts the per-request records, judges them and stores everything under DATA_DIR/<runId>.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { BACKEND_URL, MAIN_TARGETS, PITFALLS, TARGETS, caseId, planCases, scenarioById } from './catalog.mjs'
import { judgeCase } from './judge.mjs'

const MAX_LOG_LINES_IN_MEMORY = 400

export class Runner extends EventEmitter {
  constructor({ dataDir, k6Bin, script }) {
    super()
    this.dataDir = dataDir
    this.k6Bin = k6Bin
    this.script = script
    this.current = null
    this.children = new Set()
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true })
    // A run that was in progress when the container stopped can never finish.
    for (const run of await this.listRuns()) {
      if (run.status === 'running') {
        const full = await this.getRun(run.id)
        full.status = 'interrupted'
        for (const c of full.cases) if (c.status === 'running' || c.status === 'queued') c.status = 'skipped'
        await this.save(full)
      }
    }
  }

  runDir(id) {
    return path.join(this.dataDir, id)
  }

  async start(mode, explicitCases = []) {
    if (this.current) {
      const err = new Error('이미 실행 중인 테스트가 있습니다')
      err.status = 409
      throw err
    }
    const cases = planCases(mode, explicitCases)
    if (!cases.length) {
      const err = new Error('실행할 케이스가 없습니다')
      err.status = 400
      throw err
    }
    const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-') +
      '-' + Math.random().toString(36).slice(2, 5)
    const run = { id, mode, status: 'running', startedAt: Date.now(), finishedAt: null, cases, log: [] }
    await fsp.mkdir(this.runDir(id), { recursive: true })
    this.current = run
    await this.save(run)
    this.emit('run', run)
    this.execute(run).catch((e) => this.log(run, null, `실행기 오류: ${e.stack ?? e}`))
    return run
  }

  stop(id) {
    if (!this.current || this.current.id !== id) return false
    this.current.stopRequested = true
    for (const child of this.children) child.kill('SIGINT')
    return true
  }

  async execute(run) {
    const long = run.cases.filter((c) => scenarioById(c.scenarioId).group === 'long')
    const rest = run.cases.filter((c) => !long.includes(c))
    // Long, single-stream cases only check that a stream is not cut, so they can share the time.
    await Promise.all(long.map((c) => this.runCase(run, c)))
    for (const c of rest) await this.runCase(run, c)

    run.status = run.stopRequested ? 'stopped' : 'done'
    run.finishedAt = Date.now()
    run.summary = summarizeRun(run)
    delete run.stopRequested
    this.current = null
    await this.save(run)
    this.emit('run', run)
    this.emit('end', run)
  }

  async runCase(run, c) {
    const scenario = scenarioById(c.scenarioId)
    const target = TARGETS[c.targetId]
    if (run.stopRequested) {
      c.status = 'skipped'
      return this.caseChanged(run, c)
    }
    c.status = 'running'
    c.startedAt = Date.now()
    this.caseChanged(run, c)

    // Right after `docker compose up` the JVMs need a while; wait instead of failing the case.
    let up = await isUp(target.url)
    if (!up) {
      this.log(run, c.id, `${target.label}(${target.url})가 준비되기를 기다리는 중 (최대 90초)`)
      const deadline = Date.now() + 90_000
      while (!up && Date.now() < deadline && !run.stopRequested) {
        await new Promise((r) => setTimeout(r, 2000))
        up = await isUp(target.url)
      }
    }
    if (!up) {
      return this.finishCase(run, c, { verdict: 'error', reason: `대상 서비스가 응답하지 않습니다 (${target.url}). docker compose ps로 상태를 확인하세요`, metrics: {} })
    }

    const subrunDefs = scenario.subruns
      ? scenario.subruns(c.targetId)
      : Array.from({ length: scenario.repeat ?? 1 }, (_, i) => ({ label: scenario.repeat ? `${i + 1}회차` : null, url: target.url, params: {} }))

    const sampler = scenario.resources ? startSampler(target.url) : null
    const subruns = []
    let failedToRun = null
    for (const [n, sub] of subrunDefs.entries()) {
      if (run.stopRequested) break
      const params = { ...scenario.params, ...(c.quick ? scenario.quick : {}), ...sub.params }
      const rawFile = path.join(this.runDir(run.id), `${c.id}.${n}.jsonl`)
      const code = await this.k6(run, c, { ...params, KIND: scenario.kind ?? 'stream', CASE: `${c.id}.${n}`, RUN: run.id.slice(-3), BASE_URL: sub.url, BACKEND_URL }, rawFile, sub.label)
      const parsed = await parseRaw(rawFile)
      parsed.requests.forEach((r) => Object.assign(r, { sub: n, subLabel: sub.label }))
      subruns.push({ label: sub.label, ...parsed })
      if (code !== 0 && !parsed.requests.length && !parsed.checks.length) failedToRun = code
    }
    c.resources = sampler ? await sampler.stop() : null

    const requests = subruns.flatMap((s) => s.requests)
    await fsp.writeFile(path.join(this.runDir(run.id), `${c.id}.requests.json`), JSON.stringify(requests))
    c.subrunCount = subruns.length

    if (run.stopRequested && subruns.length < subrunDefs.length) {
      return this.finishCase(run, c, { verdict: 'error', reason: '실행을 중지해서 판정하지 않았습니다', metrics: {} }, 'skipped')
    }
    if (failedToRun !== null) {
      return this.finishCase(run, c, { verdict: 'error', reason: `k6가 비정상 종료했습니다 (exit ${failedToRun}). 로그를 확인하세요`, metrics: {} })
    }
    const baseline = scenario.baseline ? run.cases.find((x) => x.id === caseId(scenario.id, scenario.baseline)) : null
    return this.finishCase(run, c, judgeCase(scenario, subruns, { targetId: c.targetId, baseline }))
  }

  async finishCase(run, c, result, status = 'done') {
    Object.assign(c, result, { status, finishedAt: Date.now() })
    const pitfall = PITFALLS.find((p) => p.scenario === c.scenarioId && p.target === c.targetId)
    if (pitfall) c.expected = 'fail'
    this.log(run, c.id, `판정: ${verdictText(c)} — ${c.reason}`)
    await this.caseChanged(run, c)
  }

  async caseChanged(run, c) {
    this.emit('case', run, c)
    await this.save(run)
  }

  log(run, caseIdValue, line) {
    const entry = { t: Date.now(), caseId: caseIdValue, line }
    run.log.push(entry)
    if (run.log.length > MAX_LOG_LINES_IN_MEMORY) run.log.splice(0, run.log.length - MAX_LOG_LINES_IN_MEMORY)
    if (caseIdValue) fs.appendFile(path.join(this.runDir(run.id), `${caseIdValue}.log`), line + '\n', () => {})
    this.emit('log', run, entry)
  }

  k6(run, c, env, rawFile, label) {
    const args = ['run', '--quiet', '--summary-mode', 'disabled', '--out', `json=${rawFile}`]
    for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`)
    args.push(this.script)
    this.log(run, c.id, `$ k6 ${args.filter((a) => a !== '-e').join(' ').replace(this.script, path.basename(this.script))}${label ? `   # ${label}` : ''}`)
    return new Promise((resolve) => {
      const child = spawn(this.k6Bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      this.children.add(child)
      const onLine = (line) => {
        const msg = /msg="((?:[^"\\]|\\.)*)"/.exec(line)
        this.log(run, c.id, msg ? msg[1].replace(/\\"/g, '"') : line)
      }
      readline.createInterface({ input: child.stdout }).on('line', onLine)
      readline.createInterface({ input: child.stderr }).on('line', onLine)
      child.on('error', (e) => {
        this.log(run, c.id, `k6 실행 실패: ${e.message}`)
        this.children.delete(child)
        resolve(127)
      })
      child.on('close', (code) => {
        this.children.delete(child)
        resolve(code ?? 1)
      })
    })
  }

  async save(run) {
    const { log, ...rest } = run
    await fsp.writeFile(path.join(this.runDir(run.id), 'run.json'), JSON.stringify({ ...rest, log: log.slice(-MAX_LOG_LINES_IN_MEMORY) }))
  }

  async getRun(id) {
    if (this.current?.id === id) return this.current
    try {
      return JSON.parse(await fsp.readFile(path.join(this.runDir(safeId(id)), 'run.json'), 'utf8'))
    } catch {
      return null
    }
  }

  async listRuns() {
    const ids = (await fsp.readdir(this.dataDir).catch(() => [])).sort().reverse()
    const runs = []
    for (const id of ids) {
      const run = await this.getRun(id)
      if (!run) continue
      runs.push({ id: run.id, mode: run.mode, status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt, caseCount: run.cases.length, summary: run.summary ?? summarizeRun(run) })
    }
    return runs
  }

  async requests(runId, cid) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.runDir(safeId(runId)), `${safeId(cid)}.requests.json`), 'utf8'))
    } catch {
      return null
    }
  }

  async rawFiles(runId, cid) {
    const dir = this.runDir(safeId(runId))
    const prefix = `${safeId(cid)}.`
    const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl')).sort()
    return files.map((f) => path.join(dir, f))
  }

  caseLogFile(runId, cid) {
    return path.join(this.runDir(safeId(runId)), `${safeId(cid)}.log`)
  }
}

function safeId(id) {
  return String(id).replace(/[^A-Za-z0-9._-]/g, '')
}

function verdictText(c) {
  return { pass: '성공', fail: '실패', error: '측정 불가', baseline: '기준값' }[c.verdict] ?? c.verdict
}

export function summarizeRun(run) {
  const byTarget = {}
  for (const t of MAIN_TARGETS) byTarget[t] = { pass: 0, fail: 0, error: 0, baseline: 0, pending: 0 }
  let pitfallsMatched = 0
  let pitfallsDone = 0
  for (const c of run.cases) {
    if (TARGETS[c.targetId]?.pitfall) {
      if (c.status === 'done' && c.verdict !== 'error') {
        pitfallsDone++
        if (c.verdict === 'fail') pitfallsMatched++
      }
      continue
    }
    const bucket = byTarget[c.targetId]
    if (!bucket) continue
    if (c.status !== 'done') bucket.pending++
    else bucket[c.verdict] = (bucket[c.verdict] ?? 0) + 1
  }
  return { byTarget, pitfalls: { matched: pitfallsMatched, done: pitfallsDone, total: run.cases.filter((c) => TARGETS[c.targetId]?.pitfall).length } }
}

async function isUp(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/actuator/health`, { signal: AbortSignal.timeout(2000) })
    return res.ok
  } catch {
    return false
  }
}

export async function targetHealth() {
  const entries = await Promise.all(
    Object.entries(TARGETS).map(async ([id, t]) => [id, await isUp(t.url)]),
  )
  return Object.fromEntries(entries)
}

/** Polls the target's actuator while a concurrency case runs. */
function startSampler(baseUrl) {
  const samples = []
  let stopped = false
  const metric = async (name) => {
    const res = await fetch(`${baseUrl}/actuator/metrics/${name}`, { signal: AbortSignal.timeout(1000) })
    return res.ok ? (await res.json()).measurements[0].value : null
  }
  const loop = (async () => {
    while (!stopped) {
      const [cpu, mem, threads] = await Promise.all(
        ['process.cpu.usage', 'jvm.memory.used', 'jvm.threads.live'].map((m) => metric(m).catch(() => null)),
      )
      samples.push({ cpu, mem, threads })
      await new Promise((r) => setTimeout(r, 500))
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop
      const pick = (k) => samples.map((s) => s[k]).filter((v) => v != null)
      const cpu = pick('cpu')
      const mem = pick('mem')
      const threads = pick('threads')
      const round = (n) => Math.round(n * 10) / 10
      return {
        samples: samples.length,
        cpuAvgPct: cpu.length ? round((100 * cpu.reduce((a, b) => a + b, 0)) / cpu.length) : null,
        cpuMaxPct: cpu.length ? round(100 * Math.max(...cpu)) : null,
        memMaxMb: mem.length ? round(Math.max(...mem) / 1024 / 1024) : null,
        threadsMax: threads.length ? Math.max(...threads) : null,
      }
    },
  }
}

async function parseRaw(file) {
  const requests = []
  const checks = []
  if (!fs.existsSync(file)) return { requests, checks }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.includes('"type":"Point"')) continue
    const isRequest = line.includes('"metric":"sse_request_ms"')
    const isCheck = line.includes('"metric":"case_check"')
    if (!isRequest && !isCheck) continue
    const point = JSON.parse(line)
    const meta = point.data.metadata ?? {}
    const detail = meta.detail ? JSON.parse(meta.detail) : {}
    if (isRequest) requests.push({ rid: meta.rid, warmup: point.data.tags.warmup === 'true', at: point.data.time, ...detail })
    else checks.push({ check: point.data.tags.check, value: point.data.value, detail })
  }
  return { requests, checks }
}
