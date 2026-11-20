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

## 会话与等待

- 写任务可以 `retain_session: true`，之后用返回的 `session_id` 续接。
- 仅长任务可选 `soft_steer: true`：首轮仍活跃时，在预算 61.8% 处发送一次收尾提示，硬截止仍然存在。

## 批次与轮询

- `start_batch` 提交多个独立条目，每条有独立 ID、独立 brief 与可观察的验收标准。
- 用 `batch_status` 配合返回的游标（cursor）读取已完成条目的结果。

## 数据范围

- 只派发你授权范围内的内容；外部提供商会收到被派发的工作内容。
- 若示例包含可选的 `deepseek_files`，按固定文件路径范围复核。

## start_batch 示例（示意）

一次提交两个相互独立的只读小任务：

```json
{
  "items": [
    {
      "id": "docs-count",
      "mode": "read-only",
      "brief": "只读：统计仓库内 Markdown 文件数量，并列出前 5 个路径。",
      "acceptance": "返回数量与前 5 个路径。"
    },
    {
      "id": "config-sections",
      "mode": "read-only",
      "brief": "只读：列出 config.example.toml 的顶层配置段名称。",
      "acceptance": "返回段名列表。"
    }
  ]
}
```

等价一句话：一次 `start_batch` 提交两个互不依赖、只读、各有独立验收标准的小任务，随后用返回的 cursor 调 `batch_status` 取结果。
