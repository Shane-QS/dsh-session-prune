# dsh-session-prune

给 **DSH Desktop**（DeepSeek Harness 桌面端）的侧栏会话菜单加一条「删除会话」。
官方菜单只有置顶 / 重命名 / 分叉 / 归档，没有删除；这个插件把删除补齐：点一下就把会话的
**记录、投影缓存、工作区登记**三处一起清干净，页面自动刷新，不用重启 DSH。

```
⋯  ← 会话行右侧的菜单
├ 置顶会话
├ 重命名          Ctrl + Alt + G
├ 分叉会话        Ctrl + Shift + F
├ 归档会话        Ctrl + Alt + A
└ 🗑 删除会话     ← 本插件加的一条
```

仅在 Windows 上测试和使用。

## 安装

> 注意：这个插件**不发布到 npm**，所以 `dsh plugin add dsh-session-prune` 会失败（会去 registry 找一个不存在的包）。用下面两种方式之一。

### 方式一：从 GitHub 安装

```powershell
dsh plugin --profile desktop add github:Shane-QS/dsh-session-prune
dsh plugin --profile desktop add github:Shane-QS/dsh-session-prune#v1.0.0   # 锁定版本
```

### 方式二：克隆后用 install.ps1

```powershell
git clone https://github.com/Shane-QS/dsh-session-prune.git dsh-session-prune
cd dsh-session-prune
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

然后**重启 DSH Desktop**（托盘里退出再打开）。侧栏任意会话行的「⋯」菜单最后一条就是「删除会话」。

安装脚本只做两件事，都不碰 DSH 的安装目录：

1. 把本目录复制到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-session-prune`
2. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 末尾追加一段带标记的 `insert`（改前自动备份）

| 参数 | 说明 |
|---|---|
| `-DryRun` | 只打印计划，不动文件 |
| `-Uninstall` | 卸载：删插件目录 + 移除补丁段（改前备份） |
| `-DshHome <path>` | 自定义 DSH_HOME，默认 `%USERPROFILE%\.dsh` |
| `-Profile <name>` | 默认 `desktop` |

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

然后重启 DSH。也可以用 `cordis.patch.yml.bak-*` 备份手动还原。

## 行为

点「删除会话」后，菜单里**就地**变成确认条（不弹窗、不跳页面）：

```
删除「会话标题」？会话记录、缓存会一起清掉，不可恢复。
当前正在看的会话不要在这里删；删除成功后整页会刷新，未发送的输入会丢失。
[ 删除 ]  [ 取消 ]
```

确认后 Host 侧按这个顺序执行，**任何一步失败都不继续往下走**：

1. **判断有没有任务在跑**：拿不到活动状态时按「未知」处理 —— 只要会话还挂在宿主内存里就拒绝，除非点「停止并删除」
2. **force 时先停活动**，再最多等 2 秒确认真的空闲（避免边删边写）
3. **摘掉宿主内存里的会话**（可恢复：重启 DSH 会从磁盘重新加载）—— 摘不掉就整体放弃，文件与登记都不动
4. **删磁盘**：`%USERPROFILE%\.dsh\sessions\<workspace-key>\<session-id>\` 与 `%USERPROFILE%\.dsh\storages\session_projcache\sessions\<session-id>.json`
5. **最后才摘工作区登记**（`detachSession` / `unpinSession` / `unarchiveSession`）

顺序的理由：dispose 是可恢复的（重启会重新加载），删文件是不可恢复的，登记最后摘。
这样最坏情况是"会话还在，只是被摘出内存"，不会出现"文件没了、登记还在"的幽灵条目。

| 情况 | 表现 |
|---|---|
| 普通会话 / 切走后仍挂在内存里的 | 直接删掉，页面自动刷新一次 |
| 还有任务在跑 | 提示「这个会话还有任务在跑」+「停止并删除」按钮 |
| 活动状态拿不到、会话还挂着 | 提示「拿不到运行状态」+「停止并删除」按钮（fail-closed） |
| 文件被占用 | 500 + 原因，登记不动，不会进「未分组」 |
| 宿主内存里摘不掉 | 500 + 原因，**文件与登记都没动** |

## Host 接口

插件在宿主 webServer 上挂一条只接受本机请求的路由（同时校验回环地址与 `Host` 头，防 DNS rebinding）：

```
GET  /session-prune/api/delete?sessionId=session-xxx&dry=1    仅预演，永远不改动
POST /session-prune/api/delete                                 真正删除
     Content-Type: application/json
     { "sessionId": "session-xxx", "force": false, "dry": false }
```

**GET 只允许 `dry=1`**，否则返回 405 —— GET 是"安全方法"，不允许有副作用（否则一个 `<img src=...>` 或链接预览就能触发删除）。

| 状态码 | 含义 |
|---|---|
| 200 | `{ ok: true, disposed, removed: [...], registryTouched: [...] }` |
| 400 | sessionId 不合法（只接受 `session-...` 形式的 id） |
| 403 | 非回环请求，或 `Host` 头不是本机 |
| 405 | GET 没带 `dry=1`，或方法不是 GET/POST |
| 409 | `busy`（有任务在跑）/ `unknown`（拿不到活动状态）/ `still-busy`（请求停止后 2 秒仍未空闲），前两个加 `force` 可继续 |
| 413 | 请求体超过 64 KB |
| 415 | POST 的 `Content-Type` 不是 `application/json` |
| 500 | `files-busy`（文件删不掉，登记保持原样）/ `detach-failed`（内存里摘不掉，整体放弃）/ `bad-home`（DSH_HOME 不像 DSH 家目录） |

`dry=1` 返回 `{ ok, dry, loaded, activity, activityKnown, home, artifacts, registered }`，列出会动到的路径，不修改任何东西。

## 目录结构

```
dsh-session-prune/
├─ package.json          dsh.bundle.patch + dsh.client 两个声明
├─ cordis.patch.yml      作为 bundle 安装时用的补丁层（install.ps1 走的是直接写 profile 补丁）
├─ lib/index.js          宿主半侧：cordis 插件，注册上面的路由
├─ client.js             浏览器半侧：window.__ModuleLoader__.load(...) + slots.inject 注入菜单项
├─ install.ps1           安装 / 卸载（幂等）
└─ tests/
   ├─ host.test.mjs      宿主侧自测：13 个场景，真跑 HTTP
   ├─ client.test.mjs    前端侧自测：极简 React 桩，模拟点击走完整条链路
   └─ run-tests.ps1      两份一起跑
```

菜单项注入的插槽是 `sidebar.workspaces.session.menu.item`——官方那四条也是往这里注册的，所以本插件与它们同级；
行样式照抄 `Menu.module.css` 的 `.item`（min-height 34、padding 6px 8px、gap 6、13px/20px、hover 用 `--dsw-alias-interactive-bg-hover`）。

## 测试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
```

不需要装 DSH、不需要联网：运行时优先用 PATH 里的 `node`，没有就用 DSH Desktop 自带的 Electron
（`ELECTRON_RUN_AS_NODE=1`）。所有测试都在 `%TEMP%` 下的临时 DSH_HOME 里跑，不碰真实数据。

宿主侧 13 个场景：dry-run、非法 id、有任务在跑、停止并删除、切走后删除、文件被占用后释放重试、
删不掉时登记不动、只剩登记时修残留、幂等、**GET 不带 dry 返回 405**、**活动状态未知时 fail-closed**、
**未知 + force 可删**、**GET dry=1 正常**。

前端侧：渲染菜单项 → 点击进确认 → 取消回退 → 确认发请求 → 成功后 reload；409 时显示提示且不 reload。

## 兼容性与风险

- 插件用到了 DSH 的内部 API：`SessionStore.liveEntryFor` / `detachEntered`、
  `workspaceRegistry.detachSession` / `unpinSession` / `unarchiveSession` / `stopSessionActivity`、
  `workspace/session-activity` waterfall。**这些不是公开稳定接口**，DSH 大版本更新后可能改名。
  真变了的话：菜单照常显示，点删除会返回 500 并说明原因（`apply` 全程 try/catch，不会拖垮 DSH 启动）。
- 只在 **DSH Desktop（Windows）** 上验证过；`sidebar.workspaces.session.menu.item` 插槽在 Web 版未测试。
- 删除不可恢复（没有回收站）。想留着就先「归档会话」。
- 活动状态拿不到时是**拒绝删除**（fail-closed），所以极少数情况下会"删不动"，这时用「停止并删除」。
- 路由强制回环 + `Host` 头校验，只有本机页面能调用；不接受局域网访问。

## 开发

改 `lib/index.js` 或 `client.js` 后需要重启 DSH Desktop（宿主启动时才装配 profile 与客户端 bundle）。
快速自测不必重启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\run-tests.ps1
```

## 许可

个人自用项目，未附许可协议。
