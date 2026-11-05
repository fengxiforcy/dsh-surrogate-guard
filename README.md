# dsh-surrogate-guard

DeepSeek Harness 插件：在内容进入会话日志之前，把**落单的半个字符**（UTF-16 孤立代理）中和成替换符 U+FFFD。

从 **0.1.5** 起还会**自检自修已经落盘的存量会话**：模型请求失败（400）时或每 10 分钟，扫描最近修改的会话文件，命中就备份并修复——用于钩子覆盖不到的入口（如 `agent/inbox/spliced`，2026-11-03 小汐事故）。**修完必须重启 DSH 才生效**（内存里的会话仍是坏的）。

## 它解决什么

工具结果（read / grep / 命令输出 / 联网抓取）在某些截断路径上会把 emoji 从代理对中间切断，只留一个 0xD800-0xDBFF。这个字符在 JS 里合法，`JSON.stringify` 会安静地转义成 6 个字符；送到 DeepSeek API 时解析失败：

```text
serde_json: unexpected end of hex escape at line 1 column NNNNN
→ 400 INVALID_REQUEST
```

因为每一轮都会重发已存历史，它一旦写进会话，**该会话此后每一轮都 400**：重试无效、重启无效，只能手工修会话文件。

官方 Discussion（deepseek-ai/deepseek-harness）：#8846（read 工具截断切开代理对）、#1449（工具结果截断 → 永久 400）。

## 与 dsh-text-guard 的区别

| | dsh-text-guard | 本插件 |
|---|---|---|
| 靶子 | 区域指示符对（国旗 emoji） | 落单的代理（UTF-16 截断产物） |
| 报错 | Content Exists Risk | unexpected end of hex escape |
| 病因 | 内容合规过滤 | 截断把字符切成两半 |

症状相同（会话永久 400），药不同，需要一起装才覆盖两种。

## 安装

```sh
dsh plugin --profile <profile> add github:<your-github>/dsh-surrogate-guard
# 或发到 npm 后：dsh plugin --profile <profile> add dsh-surrogate-guard
```

然后把 `dsh-surrogate-guard` 加进 profile `package.json` 的 `dsh.profile.bundles`，重启生效。

## 配置

```yaml
- id: surrogate-guard
  config:
    replacement: '?'      # 默认 U+FFFD
    toolResults: true     # tools/post-execute + tools/ptc-dispatch-log
    userMessages: true    # agent/pre-step
    log: true             # 只记数量，不记内容
    autoRepair: true      # 0.1.5：存量会话自检自修（请求失败时 + 定时）
    realtime: true        # 0.1.6：fs.watch 实时监视，文件一变就扫
    watchDebounceMs: 1000 # 0.1.6：实时监视去抖（毫秒）
    sessionsRoot: 'E:/dsh-home/sessions'   # 会话目录
    repairIntervalMs: 600000               # 定时巡检间隔，默认 10 分钟
    maxScanFiles: 5                        # 每次最多扫最近修改的几个会话
```

## 测试

```sh
node test/guard.test.mjs
```

17 项钩子检查 + 2 项存量修复检查（造毒会话 → 扫描 → 修复 → 复核帧数/行数不变、有备份）。

## 已知限制

- 经由系统提示段落的文本不经过这些入口。
- **`agent/inbox/spliced` 这条路径钩子覆盖不到**（它是 `session.append` 的普通事件，不是可拦截的钩子）——0.1.5 的自检自修就是为它兜底。
- 若上游已把孤立代理降级成 U+FFFD，钩子无法回溯；自检自修读的是**原始文件**，仍能定位并修复。
- **修复后必须重启 DSH**：改的是磁盘文件，内存里的会话仍是坏的。
- 改写是有损的，但只损残字本身。
- 无命中时零额外分配（返回原引用）。

## 许可

MIT

## 更新日志

### 0.1.8 (2026-11-05)

- **修复成功即刻推送**：不再只靠下一轮 `pre-step` 注入。修复后立即 `ctx.agents.list()` 遍历活跃会话、`agent.inject()` 推提醒，用户不发消息也能看到「已修好，请重启」。
- `pre-step` 保留为兜底：只在 `notified=false` 时注入，避免重复。
- 起因：老板指出「你修好了但我不知道」——原机制要等用户下一句话，不发消息就永远看不到。

### 0.1.10 (2026-11-05)

- **客户端弹窗**（新增 `lib/client.js`）：host 修复后记录最近一次修复（session/backup/ts）并注册 `GET /surrogate-guard/pending`；浏览器端每 4 秒轮询，发现新记录就弹**系统通知**「DSH 会话已自动修复…请点热重启」。不依赖用户是否在看对话。
- 修复「推错会话」：notifyAgents 优先推最近 pre-step 的 agent（用户正在看的会话）。
- 文案去掉方位词（热重启按钮位置会变）。

### 0.1.7 (2026-11-05)

- **修复提醒带会话名**：注入文案由「本会话」改为「会话 `<工作区>/<session-id>`」。原因：notice 是全局的，谁下一个 pre-step 就注入给谁，曾出现「修的是 `--E-ws-test--`、提醒却进了 `--E-ws-dsh--`」的误导。
- `writeRepairNotice` 的 session 字段改为相对 `sessionsRoot` 的路径（含工作区前缀）。

### 0.1.1 (2026-10-30)

**修复 read 路径漏扫（Kluth 实测发现）**：tools/post-execute 的决策里，read 工具把行文本放在 data.meta.lines[].text，旧版只扫 value / content，导致 read 截断产生的孤立代理原样写进会话。现在改为：

- 决策自身所有字段深扫（value / content / meta / 任意工具自定义字段）；
- 决策没带、但结果上有的载荷字段（value / content / meta / data / output / result / lines）也一并深扫。

新增 4 项离线检查（read 结构、仅 result 携带、错误结果不改、拒绝决策不改），共 13 项。

> 顺带说明：DSH 侧 @deepseek-ai/dsh-tool-fs 的 truncateLine 仍是裸 substring 截断（line.substring(0, 2000)），这是产生孤立代理的源头。本插件只能事后中和，根治要在核心侧做码点对齐。

### 0.1.3 (2026-10-30)

- 把 `test/` 打进 npm 包：此前 `files` 漏了它，装包的人无法复现 13 项检查。现在 `node test/guard.test.mjs` 装完即可跑。
- 同步 GitHub 与 npm：0.1.1 只发到了 npm，GitHub 停在 0.1.0，导致 `dsh plugin add github:...` 会装到有 bug 的旧版。本版起两边一致（0.1.2 与 0.1.3 内容相同，0.1.3 是绕开 npm 一次状态卡顿的重发）。

### 0.1.6 (2026-11-05)

- **实时监视**：`fs.watch` 监听会话根目录，`.jsonl.zstd` 一变就扫（去抖 1 秒），把中毒暴露窗口从「最多 30 分钟」压到「约 1 秒」；`fs.watch` 不可用时自动降级为定时巡检。
- **覆盖 run_code**：`neutralizeDecision` 的字段顺序补 `stdout` / `stderr`（#11476 提醒 run_code 打印也会触发同类问题）。
- 配置新增 `realtime`（默认 true）与 `watchDebounceMs`（默认 1000）。

### 0.1.5 (2026-11-03)

**新增存量会话自检自修（B 档：自动修，不自动重启）**：

- 监听 `agent/request-error`：失败信息含 400 / INVALID_REQUEST / surrogate / invalid utf 时，扫描最近修改的会话文件；
- 每 10 分钟定时巡检兜底；
- 修复流程：备份 → 删除孤立的 `\uXXXX` 转义 → 重新压缩 → 校验帧数/行数/可解析/无孤立；
- 修复后写日志并提示「RESTART DSH to reload the session」。

来源：2026-11-03 小汐会话（`agent/inbox/spliced`，半个 emoji → 永久 400）复盘，冯愿/小汐侧实测。

### 0.1.4 (2026-10-30)

**修复 0.1.1 引入的回归（Kluth 实测）**：tools/post-execute 的合约规定 accept 决策**不能同时替换 value 与 content**。0.1.1 遍历全部字段做深扫，read 的 value 与 content 同源同义、两处同时命中，导致框架拒掉整条结果：

```text
Error: tools/post-execute accept decision cannot replace both value and content
```

现象是「毒没进会话，但 read 内容完全拿不到」——比原来的 bug 更糟。

现在改为：按 value → content → meta → data → output → result → lines 的顺序找**第一处命中**，命中即返回，**绝不两处都改**。深扫的覆盖面保留，落地只替换一处。

新增 4 项测试（同时命中只改 value、只 content、只 value、只有 meta），合计 17 项。
