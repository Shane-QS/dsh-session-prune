/**
 * dsh-session-prune —— 浏览器半侧
 *
 * 往「侧栏 → 会话行 → ⋯」那个菜单里加一条「删除会话」。
 * 菜单里已有：置顶会话 / 重命名 / 分叉会话 / 归档会话（archive），这条排在最后。
 *
 * 交互：
 *   点「删除会话」→ 这一行原地变成确认条「删除后不可恢复」＋ 删除 / 取消
 *   → 确认后打 Host 的 POST /session-prune/api/delete
 *   → 成功就 reload 一次（侧栏立刻干净）；失败（会话正在用）在行内提示
 *
 * 样式尽量跟着菜单走：颜色继承，hover 用 DSH 的 interactive-bg-hover 变量。
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-prune',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState } = React

    const COLORS = {
      danger: 'var(--dsw-alias-state-error-primary, #f2555a)',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16))',
      hoverDanger: 'var(--dsw-alias-interactive-bg-hover-danger, rgba(242,85,90,.16))',
      secondary: 'var(--dsw-alias-label-secondary, rgba(128,128,128,.85))',
      icon: 'var(--dsw-alias-menu-icon, currentColor)',
    }

    /* 行样式照抄 primitives 的 Menu.module.css `.item` / `.danger`：
       min-height 34、padding 6px 8px、gap 6、字号 13 / 行高 20，颜色全走 DSH 变量，
       这样塞进菜单里跟「归档会话」那些行一模一样高、一样对齐。 */
    const ROW = {
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      width: '100%',
      minHeight: 34,
      boxSizing: 'border-box',
      padding: '6px 8px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: 'none',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      textAlign: 'left',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    }

    function TrashIcon() {
      return h('svg', {
        width: 14,
        height: 14,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.4,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { flex: 'none', opacity: 0.9 },
        'aria-hidden': true,
      },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V3.2c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.3' }),
        h('path', { d: 'M3.8 4.5l.6 8.1c0 .7.6 1.2 1.3 1.2h4.6c.7 0 1.3-.5 1.3-1.2l.6-8.1' }),
        h('path', { d: 'M6.6 7.2v3.9M9.4 7.2v3.9' }),
      )
    }

    function HoverRow({ onClick, children, danger, disabled }) {
      const [hover, setHover] = useState(false)
      return h('button', {
        type: 'button',
        role: 'menuitem',
        disabled,
        onClick,
        style: {
          ...ROW,
          color: danger ? COLORS.danger : 'inherit',
          background: hover && !disabled ? (danger ? COLORS.hoverDanger : COLORS.hover) : 'transparent',
          opacity: disabled ? 0.4 : 1,
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
      }, children)
    }

    function DeleteSessionMenuItem(props) {
      const sessionId = props && props.sessionId
      const title = (props && props.displayTitle) || '这个会话'
      const [phase, setPhase] = useState('idle')   // idle | confirm | busy | error
      const [message, setMessage] = useState('')
      const [busy, setBusy] = useState(false)

      if (!sessionId) return null

      const label = (() => {
        const name = String(title).length > 18 ? `${String(title).slice(0, 18)}…` : String(title)
        return name
      })()

      const put = async (payload) => {
        setPhase('busy')
        setMessage('')
        try {
          const res = await fetch('/session-prune/api/delete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(payload),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || json.ok !== true) {
            setPhase('error')
            setBusy(json.error === 'busy' || json.error === 'unknown')
            setMessage(json.message || json.error || `HTTP ${res.status}`)
            return
          }
          /* 成功了：整个界面重载一次，侧栏里这一行就没了 */
          window.location.reload()
        } catch (error) {
          setPhase('error')
          setMessage(String((error && error.message) || error))
        }
      }

      if (phase === 'idle') {
        return h(HoverRow, { onClick: () => setPhase('confirm'), danger: true },
          h('span', { style: { display: 'inline-flex', width: 14, height: 14, flex: 'none', alignItems: 'center', justifyContent: 'center', color: COLORS.icon } }, h(TrashIcon)),
          h('span', {
            style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          }, '删除会话'))
      }

      if (phase === 'confirm') {
        return h('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '8px 10px 9px',
            borderRadius: 8,
            background: COLORS.hover,
          },
          onClick: (event) => event.stopPropagation(),
        },
          h('div', { style: { fontSize: 12, lineHeight: '16px', whiteSpace: 'normal', maxWidth: 230 } },
            '删除「', label, '」？会话记录、缓存会一起清掉，不可恢复。',
            h('br'),
            '当前正在看的会话不要在这里删；删除成功后整页会刷新，未发送的输入会丢失。'),
          h('div', { style: { display: 'flex', gap: 6 } },
            h('button', {
              type: 'button',
              onClick: () => put({ sessionId }),
              style: {
                ...ROW, width: 'auto', justifyContent: 'center', padding: '4px 10px',
                background: COLORS.danger, color: '#fff', fontWeight: 600,
              },
            }, '删除'),
            h('button', {
              type: 'button',
              onClick: () => { setPhase('idle'); setMessage('') },
              style: {
                ...ROW, width: 'auto', justifyContent: 'center', padding: '4px 10px',
                border: '1px solid rgba(128,128,128,.45)',
              },
            }, '取消')))
      }

      /* busy / error */
      return h('div', {
        style: { padding: '8px 10px', fontSize: 12, lineHeight: '16px', whiteSpace: 'normal', maxWidth: 240 },
        onClick: (event) => event.stopPropagation(),
      },
        h('div', { style: { color: phase === 'error' ? COLORS.danger : COLORS.secondary } },
          phase === 'busy' ? '正在删除…' : `删除失败：${message}`),
        h('div', { style: { display: 'flex', gap: 6, marginTop: 6 } },
          phase === 'error' && busy
            ? h('button', {
                type: 'button',
                onClick: () => put({ sessionId, force: true }),
                style: {
                  ...ROW, width: 'auto', padding: '3px 9px', fontSize: 12,
                  background: COLORS.danger, color: '#fff',
                },
              }, '停止并删除')
            : null,
          h('button', {
            type: 'button',
            onClick: () => { setPhase('idle'); setMessage(''); setBusy(false) },
            style: { ...ROW, width: 'auto', padding: '3px 9px', color: COLORS.secondary, fontSize: 12 },
          }, '返回')))
    }

    return {
      name: 'dsh-session-prune',
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
            name: 'sidebar.workspaces.session.menu.item',
            id: 'session-prune-menu-item',
            order: 500,
          }, DeleteSessionMenuItem))
        } catch (error) {
          console.error('[dsh-session-prune] menu item registration failed:', error)
        }
      },
    }
  },
})
