/**
 * dsh-session-prune —— Host 半侧
 *
 * 路由（只接受本机回环 + Host 头校验）：
 *   GET  /session-prune/api/delete?sessionId=...&dry=1     仅预览，永远不改动任何东西
 *   POST /session-prune/api/delete   { sessionId, force?, dry? }   真正删除
 *
 * 设计要点（相对 v1 的修正）：
 *   1. GET 只允许 dry-run —— GET 是"安全方法"，不允许有副作用（防 <img> 预取、链接预览、CSRF）
 *   2. 删除只走 POST，并要求 content-type: application/json
 *   3. 活动状态拿不到时 **fail-closed**：会话还挂在内存里就拒绝，除非显式 force
 *   4. 先 dispose（可恢复）再删文件（不可恢复）——dispose 失败就整体放弃，不摘登记
 *   5. force 停活动后会等待真正空闲（最多 2 秒）再删，避免边删边写
 *   6. 文件操作走 fs/promises，不阻塞宿主主线程
 */

import { existsSync } from 'node:fs'
import { readdir, rmdir, rm, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-session-prune'

/** 硬依赖：宿主 webServer（路由载体）。 */
export const inject = ['webServer']

const ROUTE = '/session-prune/api/delete'
const SESSION_ID = /^session-[0-9a-zA-Z_-]+$/
const BODY_LIMIT = 64 * 1024
const IDLE_WAIT_MS = 2000
const IDLE_POLL_MS = 100

function dshHome() {
  const env = process.env.DSH_HOME
  const home = env && env.trim() !== '' ? env : join(homedir(), '.dsh')
  return resolve(home)
}

/** DSH_HOME 至少得像一个 DSH 家目录，否则拒绝操作（防止环境变量指错地方误删）。 */
function homeLooksSane(home) {
  try {
    return existsSync(join(home, 'profiles')) || existsSync(join(home, 'sessions')) || existsSync(join(home, 'storages'))
  } catch {
    return false
  }
}

/** 回环 socket + Host 头都必须是本机（防 DNS rebinding）。 */
function isLocalRequest(req) {
  const addr = (req.socket && req.socket.remoteAddress) || ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!loopback) return false

  const host = String((req.headers && req.headers.host) || '')
  if (host === '') return true // 非浏览器客户端可能不带 Host
  const hostname = host.split(':')[0].replace(/^\[|\]$/g, '').toLowerCase()
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    req.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        done = true
        reject(new Error('body too large'))
        try { req.destroy() } catch { /* 已经断开 */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error)}`))
      }
    })
    req.on('error', (error) => { if (!done) { done = true; reject(error) } })
  })
}

/** 找出这个会话在磁盘上的所有痕迹（不删除）。 */
async function collectArtifacts(home, sessionId) {
  const paths = []

  const sessionsRoot = join(home, 'sessions')
  try {
    for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(sessionsRoot, entry.name, sessionId)
      if (existsSync(candidate)) paths.push(candidate)
    }
  } catch { /* 没有 sessions 目录就当没有痕迹 */ }

  const cache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (existsSync(cache)) paths.push(cache)

  return paths
}

async function removePath(target) {
  const info = await stat(target)
  if (info.isDirectory()) await rm(target, { recursive: true, force: true })
  else await unlink(target)
}

/** 仅供自测注入失败用；生产路径永远是 removePath 本身。 */
let removeImpl = removePath

export function __testSetRemover(fn) {
  removeImpl = typeof fn === 'function' ? fn : removePath
}

async function removeArtifact(target) {
  await removeImpl(target)
}

/** 这个会话是否还挂在宿主内存里（不等于"在干活"）。 */
function doesLive(ctx, sessionId) {
  try {
    return ctx.get('sessions')?.get?.(sessionId) !== undefined
  } catch {
    return false
  }
}

/**
 * 读取活动状态。返回 { known, count }：
 *   known=false 表示宿主里没有这个 waterfall / 它返回了非数组 —— 此时按"未知"处理，fail-closed。
 */
const NO_LISTENER = Symbol('no-listener')

async function readActivity(ctx, sessionId) {
  if (typeof ctx.waterfall !== 'function') return { known: false, count: 0 }
  try {
    // 传哨兵兜底： distinguishes「没人监听」和「监听者返回空数组」，
    // 前者对我们是"未知"，必须 fail-closed。
    const result = await ctx.waterfall('workspace/session-activity', { sessionId }, () => NO_LISTENER)
    if (result === NO_LISTENER || result === undefined || result === null) return { known: false, count: 0 }
    if (Array.isArray(result)) return { known: true, count: result.length }
    return { known: true, count: result ? 1 : 0 }
  } catch {
    return { known: false, count: 0 }
  }
}

/** 等会话真正空闲（force 停活动之后用），最多等 timeoutMs。 */
async function waitIdle(ctx, sessionId, timeoutMs = IDLE_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const activity = await readActivity(ctx, sessionId)
    if (activity.known ? activity.count === 0 : !doesLive(ctx, sessionId)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, IDLE_POLL_MS))
  }
}

/**
 * 把一个还挂在宿主里的会话摘掉：SessionStore.detachEntered 会删掉 live_sessions
 * 里的条目并派发 `session/disposed`，各处据此收尾。
 */
function disposeLive(ctx, sessionId) {
  const store = ctx.get('sessions')
  const session = store?.get?.(sessionId)
  if (!session) return false
  try {
    const entry = typeof store.liveEntryFor === 'function' ? store.liveEntryFor(session) : undefined
    if (!entry || typeof store.detachEntered !== 'function') return false
    store.detachEntered(entry)
    return true
  } catch (error) {
    ctx.logger?.warn?.(`session-prune: detaching live session ${sessionId} failed: ${String(error)}`)
    return false
  }
}

/** 从 workspace registry 摘除（幂等；服务不在时安静跳过）。 */
async function detachFromRegistry(ctx, sessionId) {
  const touched = []
  const registry = ctx.get('workspaceRegistry')
  if (!registry) return touched

  try {
    for (const workspace of registry.list()) {
      const ids = workspace?.sessionIds
      if (Array.isArray(ids) && ids.includes(sessionId)) {
        await workspace.detachSession(sessionId)
        touched.push(`workspace:${workspace.id ?? workspace.record?.path ?? '?'}`)
      }
    }
  } catch (error) {
    ctx.logger?.warn?.(`session-prune: detach failed for ${sessionId}: ${String(error)}`)
  }

  for (const [method, label] of [['unpinSession', 'pin'], ['unarchiveSession', 'archive']]) {
    try {
      if (typeof registry[method] === 'function') {
        await registry[method](sessionId)
        touched.push(label)
      }
    } catch (error) {
      ctx.logger?.warn?.(`session-prune: ${method} failed for ${sessionId}: ${String(error)}`)
    }
  }

  return touched
}

export function apply(ctx) {
  try {
    registerRoute(ctx)
  } catch (error) {
    ctx.logger?.error?.(`session-prune: failed to register route: ${String(error)}`)
  }
}

function registerRoute(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => {
      if (!isLocalRequest(req)) {
        sendJson(res, 403, { ok: false, error: 'loopback only' })
        return
      }

      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        const isPost = req.method === 'POST'
        const isGet = req.method === 'GET'

        const queryDry = url.searchParams.get('dry') === '1'
        const queryForce = url.searchParams.get('force') === '1'

        let body = {}
        if (isPost) {
          const type = String(req.headers['content-type'] || '').toLowerCase()
          if (!type.includes('application/json')) {
            sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
            return
          }
          body = await readBody(req)
        }

        const sessionId = String(body.sessionId || url.searchParams.get('sessionId') || '').trim()
        if (!SESSION_ID.test(sessionId)) {
          sendJson(res, 400, { ok: false, error: 'bad sessionId' })
          return
        }

        const dry = body.dry === true || queryDry
        const force = body.force === true || queryForce

        // GET 只能 dry-run：不允许用 GET 造成任何副作用
        if (isGet && !dry) {
          sendJson(res, 405, {
            ok: false,
            error: 'get-not-allowed',
            message: 'GET 只能预演（加 dry=1 参数）；真正删除请用 POST。',
          })
          return
        }
        if (!isGet && !isPost) {
          sendJson(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }

        const home = dshHome()
        if (!homeLooksSane(home)) {
          sendJson(res, 500, {
            ok: false,
            error: 'bad-home',
            message: `DSH_HOME 看起来不像 DSH 家目录，已拒绝操作：${home}`,
          })
          return
        }

        const artifacts = await collectArtifacts(home, sessionId)
        const loaded = doesLive(ctx, sessionId)
        const activity = await readActivity(ctx, sessionId)

        if (dry) {
          sendJson(res, 200, {
            ok: true,
            dry: true,
            sessionId,
            loaded,
            activity: activity.count,
            activityKnown: activity.known,
            home,
            artifacts,
            registered: Boolean(ctx.get('workspaceRegistry')),
          })
          return
        }

        // ① 活动检测：未知时 fail-closed（会话还挂着就要求 force）
        if (!force) {
          if (activity.known && activity.count > 0) {
            sendJson(res, 409, {
              ok: false,
              error: 'busy',
              message: '这个会话还有任务在跑，先等它结束，或点「停止并删除」。',
            })
            return
          }
          if (!activity.known && loaded) {
            sendJson(res, 409, {
              ok: false,
              error: 'unknown',
              message: '拿不到这个会话的运行状态，为安全起见先不删。确认要删请点「停止并删除」。',
            })
            return
          }
        }

        // ② force：先停活动，再等它真正空闲
        let stopped = false
        if (force) {
          const needStop = (activity.known && activity.count > 0) || (!activity.known && loaded)
          if (needStop) {
            try {
              await ctx.get('workspaceRegistry')?.stopSessionActivity?.(sessionId)
              stopped = true
            } catch { /* 停不下来后面如实报错 */ }
            // 只有在「活动状态可知」时才等；状态未知时我们无法观察，直接按 force 继续
            if (activity.known) {
              const idle = await waitIdle(ctx, sessionId, IDLE_WAIT_MS)
              if (!idle) {
                sendJson(res, 409, {
                  ok: false,
                  error: 'still-busy',
                  message: '已经请求停止，但这个会话在 2 秒内还没停下来，再试一次或等一会儿。',
                })
                return
              }
            }
          }
        }

        // ③ 先把内存里的会话摘掉（可恢复：重启 DSH 会重新加载磁盘上的会话）
        let disposed = false
        if (loaded) {
          disposed = disposeLive(ctx, sessionId)
          if (!disposed) {
            sendJson(res, 500, {
              ok: false,
              error: 'detach-failed',
              message: '这个会话还挂在宿主内存里但摘不掉，为了不留幽灵条目，已放弃删除（文件与登记都没动）。',
            })
            return
          }
        }

        // ④ 删文件（不可恢复）
        const removed = []
        const failed = []
        for (const target of artifacts) {
          try {
            await removeArtifact(target)
            removed.push(target)
          } catch (error) {
            failed.push({ path: target, error: String(error && error.message ? error.message : error) })
          }
        }

        // dispose 的事件是异步派发的，个别实现可能在之后回写一次快照；复查一遍再补删
        if (failed.length === 0) {
          await new Promise((r) => setTimeout(r, 120))
          for (const target of [...removed]) {
            if (!existsSync(target)) continue
            try {
              await removeArtifact(target)
              ctx.logger?.warn?.(`session-prune: ${target} 被重建，已补删一次`)
            } catch (error) {
              failed.push({ path: target, error: String(error && error.message ? error.message : error) })
            }
          }
        }

        if (failed.length > 0) {
          sendJson(res, 500, {
            ok: false,
            error: 'files-busy',
            message: '删不掉：会话文件被占用。等这个会话停下来（或重启 DSH）再删。',
            failed,
            removed,
            disposed,
          })
          return
        }

        // ⑤ 文件都没了才摘登记：不会掉进「未分组」
        const registryTouched = await detachFromRegistry(ctx, sessionId)

        // ⑥ 只清空 sessions/<workspace-key> 这种一层父目录；
        //    projcache 的父目录不能删（DSH 下次写缓存要用）
        const sessionsRoot = join(home, 'sessions')
        for (const target of removed) {
          if (!target.startsWith(sessionsRoot)) continue
          try {
            const parent = join(target, '..')
            if (parent === sessionsRoot) continue
            if (existsSync(parent) && (await readdir(parent)).length === 0) await rmdir(parent)
          } catch { /* 无所谓 */ }
        }

        ctx.logger?.info?.(`session-prune: removed ${sessionId} (${removed.length} paths, disposed=${disposed}, stopped=${stopped})`)
        sendJson(res, 200, {
          ok: true,
          sessionId,
          loaded,
          disposed,
          removed,
          registryTouched,
        })
      } catch (error) {
        const message = error && error.message ? error.message : String(error)
        const status = /body too large/i.test(message) ? 413 : 500
        try {
          sendJson(res, status, { ok: false, error: message })
        } catch { /* 客户端已经断开 */ }
      }
    },
  }), `session-prune: ${ROUTE}`)
}
