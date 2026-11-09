/**
 * 自测（浏览器半侧）：用极简 React 桩把菜单项渲染出来，模拟点击走完
 * 「删除会话 → 确认 → 打 Host → reload」这条链路。
 * 运行：powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
 */
import { readFileSync, writeFileSync } from 'node:fs'

let loaded = null
globalThis.window = {
  __ModuleLoader__: { load: (def) => { loaded = def } },
  location: { reload: () => { reloaded = true } },
}

let reloaded = false
let fetchCalls = []

// ── 极简 React：支持 useState + 重渲染 ───────────────────────────────
let hookStore = []
let hookIndex = 0
let tree = null
let renderFn = null

const ReactStub = {
  createElement(type, props, ...children) {
    return { type, props: props || {}, children: children.flat(9).filter((c) => c !== null && c !== undefined && c !== false) }
  },
  useState(init) {
    const slot = hookIndex++
    if (!(slot in hookStore)) hookStore[slot] = init
    const set = (next) => {
      const value = typeof next === 'function' ? next(hookStore[slot]) : next
      if (value === hookStore[slot]) return
      hookStore[slot] = value
      rerender()
    }
    return [hookStore[slot], set]
  },
}

function rerender() {
  hookIndex = 0
  tree = renderFn()
}

function requireStub(name) {
  if (name === 'react') return ReactStub
  throw new Error(`unexpected require(${name})`)
}

// ── 加载插件 ────────────────────────────────────────────────────────
const code = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const run = new Function('window', 'require', code)
run(globalThis.window, requireStub)
if (loaded === null) throw new Error('client.js 没有调用 __ModuleLoader__.load')

const plugin = loaded.factory(requireStub)
const registrations = []
plugin.apply({
  slots: {
    inject(name, fn) { fn() },
    register(spec, Component) { registrations.push({ spec, Component }) },
  },
})
if (registrations.length !== 1) throw new Error(`期望注册 1 个点，实际 ${registrations.length}`)
const { spec, Component } = registrations[0]
console.log('slot:', spec.name, '| id:', spec.id, '| order:', spec.order)

// ── 渲染 + 交互 ─────────────────────────────────────────────────────
function walk(node, visit) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}
function findByText(text) {
  let hit = null
  walk(tree, (node) => {
    if (hit) return
    const kids = node.children || []
    if (kids.length === 1 && kids[0] === text && node.type === 'span') hit = node
  })
  return hit
}
function click(node) {
  let target = node
  while (target && typeof target.props?.onClick !== 'function') target = null
  node.props.onClick()
}

renderFn = () => {
  hookStore = hookStore.length ? hookStore : []
  hookIndex = 0
  return Component({ sessionId: 'session-abc', displayTitle: '一个很长的会话标题用来测试截断' })
}
rerender()
console.log('初始行文本:', JSON.stringify(tree.children[1].children ?? tree.children[1]))
if (findByText('删除会话') === null) throw new Error('初始行里没有「删除会话」文案')

// 点「删除会话」→ 进入确认
const row = tree
click(row)
console.log('确认态文本片段:', JSON.stringify(tree.children[0].children?.slice?.(0, 3)))
if (!/不可恢复/.test(JSON.stringify(tree.children[0]))) throw new Error('没有进入确认态')

// 取消
const cancelBtn = tree.children[1].children[1]
console.log('取消按钮文案:', cancelBtn.children[0])
click(cancelBtn)
if (findByText('删除会话') === null) throw new Error('取消后没有回到初始态')

// 再来一次，确认删除
click(tree)

globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options })
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, removed: ['x'] }),
  }
}
const confirmBtn = tree.children[1].children[0]
console.log('确认按钮文案:', confirmBtn.children[0])
click(confirmBtn)
await new Promise((r) => setTimeout(r, 60))

console.log('fetch 次数:', fetchCalls.length)
console.log('fetch url:', fetchCalls[0]?.url)
console.log('fetch body:', fetchCalls[0]?.options?.body)
console.log('reload 被调用:', reloaded)
if (!reloaded) throw new Error('成功后没有 reload')

// 失败分支：409 busy
reloaded = false
hookStore = []
rerender()
globalThis.fetch = async () => ({
  ok: false,
  status: 409,
  json: async () => ({ ok: false, error: 'busy', message: '这个会话还有任务在跑' }),
})
click(tree)
click(tree.children[1].children[0])
await new Promise((r) => setTimeout(r, 60))
console.log('失败态文本:', JSON.stringify(tree.children[0].children))
if (!/任务在跑/.test(JSON.stringify(tree))) throw new Error('失败信息没有显示')
if (reloaded) throw new Error('失败时不该 reload')

const verdict = { name: 'client', ok: true, failures: 0 }
const outPath = process.env.DSH_SELFTEST_RESULT
if (outPath) writeFileSync(outPath, JSON.stringify(verdict))
console.log('CLIENT SELFTEST DONE')
