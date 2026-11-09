/**
 * 自测：不启动 DSH，直接把 Host 半侧的 handler 挂到本机 http 上打一遍。
 * 覆盖：dry-run / 非法 id / 有任务在跑 / 停止并删除 / 切走后的“仍加载但空闲” / 文件被占用 / 修残留 / 幂等
 */
import http from 'node:http'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = join(tmpdir(), 'dsh-session-prune-selftest')
const wsKey = '--C-Users-test-workspace--'
const sid = 'session-selftest-0001'

function fixture() {
  rmSync(home, { recursive: true, force: true })
  mkdirSync(join(home, 'sessions', wsKey, sid), { recursive: true })
  writeFileSync(join(home, 'sessions', wsKey, sid, 'session.v4.jsonl.zstd'), 'x')
  mkdirSync(join(home, 'storages', 'session_projcache', 'sessions'), { recursive: true })
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`), '{}')
  writeFileSync(join(home, 'storages', 'session_projcache', 'sessions', 'session-keep-0002.json'), '{}')
}

process.env.DSH_HOME = home

// ── 假宿主 ────────────────────────────────────────────────────────────
const routes = []
let calls = []
let loaded = false          // 会话是否还挂在宿主内存里
let activity = 0            // 跑了几个活动
let removeBlocked = false   // 模拟文件被占用
let activityUnknown = false // 模拟 waterfall 拿不到活动状态

const live = { id: sid }
const store = {
  get(id) { return loaded && id === sid ? live : undefined },
  liveEntryFor(session) { if (!loaded || session !== live) throw new Error('not live'); return { id: sid } },
  detachEntered(entry) { calls.push('dispose:live'); loaded = false; removeBlocked = false },
}
const entity = {
  id: 'ws-1',
  sessionIds: [sid, 'session-keep-0002'],
  detachSession(id) { calls.push(`detach:${id}`); this.sessionIds = this.sessionIds.filter((x) => x !== id) },
}
const registry = {
  list: () => [entity],
  unpinSession: (id) => calls.push(`unpin:${id}`),
  unarchiveSession: (id) => calls.push(`unarchive:${id}`),
  stopSessionActivity: (id) => { calls.push(`stop:${id}`); activity = 0 },
}

const ctx = {
  effect(fn) { fn(); return () => {} },
  webServer: { register(route) { routes.push(route); return () => {} } },
  get(name) {
    if (name === 'workspaceRegistry') return registry
    if (name === 'sessions') return store
    return undefined
  },
  waterfall(event, args, fallback) {
    if (activityUnknown) return fallback ? fallback() : undefined
    if (event === 'workspace/session-activity') return activity > 0 ? [{ provider: 'agent-loop' }] : []
    return fallback ? fallback() : undefined
  },
  logger: { info: () => {}, warn: (m) => console.log('[warn]', m) },
}

const plugin = await import(new URL('../lib/index.js', import.meta.url).href)
plugin.apply(ctx)
plugin.__testSetRemover((target) => {
  if (removeBlocked) throw new Error('EBUSY: resource busy or locked')
  rmSync(target, { recursive: true, force: true })
})

const server = http.createServer((req, res) => routes[0].handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}/session-prune/api/delete`
const say = (...a) => console.log(...a)
const get = async (qs) => { const r = await fetch(`${base}?${qs}`); return [r.status, await r.json()] }
const post = async (body) => {
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return [r.status, await r.json()]
}
let fails = 0
const check = (label, ok, extra = '') => { if (ok) say(`   ✓ ${label}`); else { fails++; say(`   ✗ ${label} ${extra}`) } }
const reset = ({ isLoaded = false, act = 0, blocked = false } = {}) => {
  fixture(); calls = []; loaded = isLoaded; activity = act; removeBlocked = blocked; activityUnknown = false
  entity.sessionIds = [sid, 'session-keep-0002']
}

// 1) dry-run
reset({ isLoaded: true })
{
  const [status, body] = await get(`sessionId=${sid}&dry=1`)
  say('1) dry-run')
  check('200 + dry', status === 200 && body.dry === true)
  check('loaded=true, activity=0', body.loaded === true && body.activity === 0)
  check('没动文件/登记', existsSync(join(home, 'sessions', wsKey, sid)) && calls.length === 0)
}

// 2) 非法 id
{
  const [status] = await get('sessionId=../../evil&dry=1')
  say('2) 非法 id')
  check('400', status === 400)
}

// 3) 有任务在跑，且没点强删 → 409
reset({ isLoaded: true, act: 1 })
{
  const [status, body] = await post({ sessionId: sid })
  say('3) 有任务在跑')
  check('409 busy', status === 409 && body.error === 'busy', JSON.stringify(body).slice(0, 100))
  check('什么都没动', calls.length === 0 && existsSync(join(home, 'sessions', wsKey, sid)))
}

// 4) 有任务在跑 + 停止并删除
reset({ isLoaded: true, act: 1 })
{
  const [status, body] = await post({ sessionId: sid, force: true })
  say('4) 停止并删除')
  check('200 ok', status === 200 && body.ok === true)
  check('先停了活动', calls[0] === `stop:${sid}`, calls.join(','))
  check('文件都删了', !existsSync(join(home, 'sessions', wsKey, sid)))
}

// 5) 切到别的会话后（仍加载、但空闲）→ 直接删成功，不再报“还开着”
reset({ isLoaded: true, act: 0 })
{
  const [status, body] = await post({ sessionId: sid })
  say('5) 切走后删除（仍加载但空闲）')
  check('200 ok（不再 409）', status === 200 && body.ok === true, JSON.stringify(body).slice(0, 100))
  check('宿主里的会话被摘掉（dispose）', body.disposed === true && calls.includes('dispose:live'), calls.join(','))
  check('文件都没了', !existsSync(join(home, 'sessions', wsKey, sid)) && !existsSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`)))
  check('登记已摘（不会留未分组）', calls.includes(`detach:${sid}`) && calls.includes(`unpin:${sid}`) && calls.includes(`unarchive:${sid}`), calls.join(','))
}

// 6) 文件先被占着 → 摘掉宿主里的会话后重试成功
reset({ isLoaded: true, act: 0, blocked: true })
{
  const [status, body] = await post({ sessionId: sid })
  say('6) 文件被占用 → 释放后重试')
  check('200 ok', status === 200 && body.ok === true, JSON.stringify(body).slice(0, 120))
  check('先 dispose 再删', calls.includes('dispose:live'), calls.join(','))
  check('文件确实没了', !existsSync(join(home, 'sessions', wsKey, sid)))
}

// 7) 文件删不掉且摘不掉会话 → 500，且不摘登记
reset({ isLoaded: false, act: 0, blocked: true })
{
  const [status, body] = await post({ sessionId: sid })
  say('7) 删不掉（无 live 可摘）')
  check('500 files-busy', status === 500 && body.error === 'files-busy', JSON.stringify(body).slice(0, 100))
  check('登记没动（关键）', calls.length === 0, calls.join(','))
}

// 8) 文件已没了、只剩登记 → 只摘登记
{
  reset({ isLoaded: false })
  rmSync(join(home, 'sessions', wsKey, sid), { recursive: true, force: true })
  rmSync(join(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`), { force: true })
  const [status, body] = await post({ sessionId: sid })
  say('8) 只剩登记（修残留）')
  check('200 ok, removed 为空', status === 200 && body.ok === true && body.removed.length === 0)
  check('仍然摘了登记', calls.includes(`detach:${sid}`), calls.join(','))
}

// 9) 幂等
{
  calls = []
  const [status, body] = await post({ sessionId: sid })
  say('9) 幂等')
  check('200 ok', status === 200 && body.ok === true)
}


// 10) GET 不带 dry —— 必须拒绝，且什么都不动
reset({ isLoaded: false })
{
  const [status, body] = await get(`sessionId=${sid}`)
  say('10) GET 不带 dry（安全方法不许有副作用）')
  check('405', status === 405, JSON.stringify(body).slice(0, 90))
  check('文件仍在', existsSync(join(home, 'sessions', wsKey, sid)))
  check('登记没动', calls.length === 0, calls.join(','))
}

// 11) 拿不到活动状态 + 会话还挂着 → fail-closed（409 unknown）
reset({ isLoaded: true })
activityUnknown = true
{
  const [status, body] = await post({ sessionId: sid })
  say('11) 活动状态未知 → fail-closed')
  check('409 unknown', status === 409 && body.error === 'unknown', JSON.stringify(body).slice(0, 90))
  check('什么都没动', calls.length === 0 && existsSync(join(home, 'sessions', wsKey, sid)))
}

// 12) 同上，但显式 force → 允许删除
activityUnknown = true
{
  const [status, body] = await post({ sessionId: sid, force: true })
  say('12) 活动状态未知 + force → 删除')
  check('200 ok', status === 200 && body.ok === true, JSON.stringify(body).slice(0, 120))
  check('文件没了', !existsSync(join(home, 'sessions', wsKey, sid)))
}

// 13) GET dry 仍然可用
reset({ isLoaded: false })
{
  const [status, body] = await get(`sessionId=${sid}&dry=1`)
  say('13) GET dry=1')
  check('200 dry', status === 200 && body.dry === true)
  check('activityKnown 字段存在', typeof body.activityKnown === 'boolean')
}

server.close()
const verdict = { name: 'host', ok: fails === 0, failures: fails }
const outPath = process.env.DSH_SELFTEST_RESULT
if (outPath) writeFileSync(outPath, JSON.stringify(verdict))
say(verdict.ok ? 'SELFTEST DONE (all pass)' : `SELFTEST FAILED (${fails})`)
process.exitCode = verdict.ok ? 0 : 1
