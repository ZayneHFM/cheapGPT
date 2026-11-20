# cheapGPT

> English: GPT plans and reviews; DeepSeek executes through CommandCode / Codex.

GPT 负责规划、拆解、决策与验收；DeepSeek 通过 CommandCode 或 Codex 执行具体工作。

## 环境要求

- Windows
- Node.js 24（发布环境使用的版本）
- 支持 app-server 的 Codex
- PowerShell
- 个人 CommandCode API key

## 安装

```powershell
git clone https://github.com/ZayneHFM/cheapGPT.git
```

## 配置

把 `config.example.toml` 中相关的 MCP 段合并进你自己的 Codex `config.toml`（只合并相关段落，不要整体覆盖）。合并时，把示例中的路径替换成你自己的：

- Node 可执行文件
- 仓库内 `src/*.mjs`
- Codex 可执行文件，或包含它的 bin 目录
- 单独保存的 `credential.dpapi`
- PowerShell

保存后重新启动 Codex。

## 凭据

API key 保存在仓库之外，只有同一个 Windows 用户、同一台电脑能读取。示例（交互输入，密文写入文件）：

```powershell
$dir = Join-Path $env:LOCALAPPDATA 'cheapGPT'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Read-Host -AsSecureString 'CommandCode API key' |
  ConvertFrom-SecureString |
  Set-Content -Encoding utf8 -Path (Join-Path $dir 'credential.dpapi')
```

`ConvertFrom-SecureString` 的输出由当前 Windows 用户的 DPAPI 保护，不要把这个文件放进仓库。

## 安全与权限

- 安全默认权限：`workspace-write`
- 批次内强制：`read-only`

## 执行入口与批次

- 三个独立执行入口，每个入口同一时间只接受一单。
- 单批最多 3 个并发。
- 并发上限来自调度，不要把「入口数 × 批内上限」误算成固定 9。
- 同一会话由锁保护；写入范围冲突由调度串行处理。

## 会话派发与恢复

派发时按工作性质选择会话，即使预计一轮能完成也用同一规则。

| 工作 | 首次怎么派发 | 后续怎么派发 |
| --- | --- | --- |
| 修改代码、文档或配置，修复问题，或校验本轮改动 | `execute`，显式传 `retain_session: true`。若诊断预计直接进入修复，从诊断开始保留会话 | 同一入口、同一工作区，用返回的 `session_id` 做修改、校验和返工 |
| 一次性只读调研、报告或独立验收 | 精确文件复核用 `deepseek_files`，互相独立的项目检查用只读 `start_batch` | 以后若获准开始修改，把已确认的发现交给一个新保留会话 |

1. **派发前**记下工作项、执行入口、工作区和验收标准。首轮取得 `session_id` 后，把它记到同一工作项的调度记录里。已有关联会话时，先续接该会话。每次调用在 `retain_session: true` 和 `session_id` 中选一个。
2. **每轮后**记录已落盘变更、已完成检查及结果、未确认项和下一步。给续接轮的任务只补 GPT 做出的新决定、已有证据与下一项验收。让执行者在同一会话修正普通失败并复验。只有相关证据失效时才重复诊断。
3. **超时后**先核对落盘状态、恢复结果和会话是否仍在运行。已完成的步骤不用重派。自动 `verify` 或 `repair` 可能由独立的临时进程执行。把它实际完成的改动和检查交给原会话，再从第一个未完成的步骤继续。原会话确实不可用、或首轮没有返回可续接 ID 时，才新开一个保留会话并带上这份记录。
4. **结束时**按证据判断验收是否完成。新工作项开新会话，刻意独立的验收单独派发。会话延续会保留已有上下文。缓存按服务侧对输入前缀的匹配计算，可在用量报告暴露缓存指标时据实核对。 [DeepSeek 上下文缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache/)

长任务可选 `soft_steer: true`。首轮仍活跃时，在预算 61.8% 处发送一次收尾提示。硬截止继续生效。

**首次派发示例**

```json
{
  "workspace": "C:/Projects/example",
  "retain_session": true,
  "recovery_mode": "repair",
  "task": "复现按钮文字截断，修复后复验同一尺寸，报告改动路径和检查结果。"
}
```

**续接示例**

```json
{
  "workspace": "C:/Projects/example",
  "session_id": "<替换为首轮返回的 session_id>",
  "recovery_mode": "repair",
  "task": "沿用已确认的截断原因和当前改动。修正上轮仍失败的窄屏用例，复验此用例并报告结果。"
}
```

流程参考 [Claude Code 的续接工作流](https://code.claude.com/docs/en/common-workflows#resume-previous-conversations) 和 [OpenHands 的会话持久化](https://github.com/OpenHands/software-agent-sdk/blob/main/examples/01_standalone_sdk/10_persistence.py)。

## 批次与轮询

`start_batch` 只用于互相独立的只读条目。每条包含唯一 `id` 和一份可验收的 `task`。

```json
{
  "workspace": "C:/Projects/example",
  "concurrency": 2,
  "tasks": [
    {
      "id": "docs-count",
      "task": "只读统计仓库内 Markdown 文件数量，并列出前 5 个路径。"
    },
    {
      "id": "config-sections",
      "task": "只读列出 config.example.toml 的顶层配置段。"
    }
  ]
}
```

提交后记下 `batch_id`。用 `batch_status` 取回结果，后续查询将返回的 `cursor` 传给 `after_cursor`，仅读新增的已完成项。

## 数据范围

- 只派发你授权范围内的内容；外部提供商会收到被派发的工作内容。
- 若示例包含可选的 `deepseek_files`，按固定文件路径范围复核。
