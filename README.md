# dsh-surrogate-guard

DeepSeek Harness 插件：在内容进入会话日志之前，把**落单的半个字符**（UTF-16 孤立代理）中和成替换符 U+FFFD。

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
```

## 测试

```sh
node test/guard.test.mjs
```

9 项离线检查：干净文本返回同一引用、孤立高位/低位代理、合法代理对保留、混合串、自定义替换、连续孤立、空值、幂等。

## 已知限制

- 经由系统提示段落的文本不经过这些入口。
- 改写是有损的，但只损残字本身。
- 无命中时零额外分配（返回原引用）。

## 许可

MIT

## 更新日志

### 0.1.1 (2026-10-30)

**修复 read 路径漏扫（Kluth 实测发现）**：tools/post-execute 的决策里，read 工具把行文本放在 data.meta.lines[].text，旧版只扫 value / content，导致 read 截断产生的孤立代理原样写进会话。现在改为：

- 决策自身所有字段深扫（value / content / meta / 任意工具自定义字段）；
- 决策没带、但结果上有的载荷字段（value / content / meta / data / output / result / lines）也一并深扫。

新增 4 项离线检查（read 结构、仅 result 携带、错误结果不改、拒绝决策不改），共 13 项。

> 顺带说明：DSH 侧 @deepseek-ai/dsh-tool-fs 的 truncateLine 仍是裸 substring 截断（line.substring(0, 2000)），这是产生孤立代理的源头。本插件只能事后中和，根治要在核心侧做码点对齐。

### 0.1.3 (2026-10-30)

- 把 `test/` 打进 npm 包：此前 `files` 漏了它，装包的人无法复现 13 项检查。现在 `node test/guard.test.mjs` 装完即可跑。
- 同步 GitHub 与 npm：0.1.1 只发到了 npm，GitHub 停在 0.1.0，导致 `dsh plugin add github:...` 会装到有 bug 的旧版。本版起两边一致（0.1.2 与 0.1.3 内容相同，0.1.3 是绕开 npm 一次状态卡顿的重发）。