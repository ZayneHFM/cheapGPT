import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawnSteerableCodex } from "./steerable-codex.mjs";

const [codexLocation, credential, powershell] = process.argv.slice(2);
const executionSandboxMode = process.env.DEEPSEEK_WORKER_SANDBOX_MODE ?? "workspace-write";
if (executionSandboxMode !== "workspace-write" && executionSandboxMode !== "danger-full-access") {
  throw new Error("DEEPSEEK_WORKER_SANDBOX_MODE must be workspace-write or danger-full-access");
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionsRoot = path.join(path.dirname(path.resolve(credential)), "sessions");
const runsRoot = path.join(path.dirname(sessionsRoot), "runs");
const ATTEMPT_TIMEOUT_MS = 230000;
const RECOVERY_TIMEOUT_MS = 85000;
const BATCH_DEFAULT_TIME_BUDGET_SEC = 90;
const BATCH_MIN_TIME_BUDGET_SEC = 45;
const BATCH_MAX_TIME_BUDGET_SEC = 230;
const MIN_BATCH_CONCURRENCY = 1;
const MAX_BATCH_CONCURRENCY = 3;
const BATCH_DEFAULT_CONCURRENCY = 3;
const BATCH_RECOVERY_TIMEOUT_MS = 35000;
const MAX_EVIDENCE = 12;
const MAX_BATCH_TASKS = 8;
const MAX_BATCH_WAIT_MS = 45000;
const BATCH_FINAL_LIMIT = 2000;
const tool = {
  name: "execute",
  description: "Implement a scoped coding task with DeepSeek via CommandCode. The workspace sets the working directory. The executor uses the configured OS permissions; the brief sets the authorized scope. Send only the task context needed for execution. GPT should define acceptance criteria and independently verify the resulting diff and tests. Sessions are ephemeral unless retain_session is set; resume a retained session with session_id.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "Absolute path to the user-authorized project directory." },
      task: { type: "string", description: "Implementation brief with allowed scope and acceptance checks.", maxLength: 16000 },
      retain_session: { type: "boolean", description: "Keep the worker session on disk so it can be resumed later by session_id. Defaults to an ephemeral session that is discarded. Mutually exclusive with session_id." },
      session_id: { type: "string", description: "Resume a previously retained session by the UUID returned in its structuredContent. Mutually exclusive with retain_session." },
      recovery_mode: { type: "string", enum: ["verify", "repair"], description: "Recovery policy applied if the first attempt times out. verify (default) runs a read-only verification pass. repair runs a fresh ephemeral pass with the configured execution permissions, inspects already landed state, and fixes a concrete in-scope deficiency." },
      soft_steer: { type: "boolean", description: "Run the first (non-recovery) attempt through the steerable adapter so a soft deadline can be observed. Defaults to false; recovery attempts always use the plain codex exec path." },
    },
    required: ["workspace", "task"],
    additionalProperties: false,
  },
};
const startBatchTool = {
  name: "start_batch",
  description: "Register several independent read-only ephemeral DeepSeek tasks in one call and return a batch_id immediately. Every item and its verify recovery run under a real read-only sandbox. Poll progress with batch_status. Concurrency defaults to 3 (max 3, still bounded by the item count); use 1 for a serial baseline.",
  inputSchema: {
    type: "object",
    properties: {
      workspace: { type: "string", description: "Absolute path to the user-authorized project directory." },
      tasks: { type: "array", minItems: 1, maxItems: 8, items: {
        type: "object",
        properties: {
          id: { type: "string", minLength: 1, maxLength: 200, description: "Short unique id for the item." },
          task: { type: "string", maxLength: 16000, description: "Implementation brief with allowed scope and acceptance checks." },
        },
        required: ["id", "task"], additionalProperties: false } },
      concurrency: { type: "integer", minimum: MIN_BATCH_CONCURRENCY, maximum: MAX_BATCH_CONCURRENCY, description: "Parallel slots. Defaults to 3; use 1 for serial. Also bounded by the number of tasks." },
      time_budget_sec: { type: "integer", minimum: BATCH_MIN_TIME_BUDGET_SEC, maximum: BATCH_MAX_TIME_BUDGET_SEC, description: `Per-item first-attempt budget in seconds. Defaults to ${BATCH_DEFAULT_TIME_BUDGET_SEC}; allowed ${BATCH_MIN_TIME_BUDGET_SEC}-${BATCH_MAX_TIME_BUDGET_SEC}. Batch verify recovery is capped at ${BATCH_RECOVERY_TIMEOUT_MS / 1000}s; standalone execute keeps 230/85.` },
      soft_steer: { type: "boolean", description: "Apply the soft-deadline steering adapter to each item's first (non-recovery) attempt. Defaults to false; recovery attempts always use the plain codex exec path." },
    },
    required: ["workspace", "tasks"], additionalProperties: false,
  },
};
const batchStatusTool = {
  name: "batch_status",
  description: "Return incremental batch progress after a completion cursor, plus completed/total and batch status. Returns as soon as new items or completion are available, otherwise waits up to wait_ms (max 45000).",
  inputSchema: {
    type: "object",
    properties: {
      batch_id: { type: "string", description: "batch_id returned by start_batch." },
      after_cursor: { type: "integer", minimum: 0, description: "Return items completed after this cursor. Defaults to 0." },
      wait_ms: { type: "integer", minimum: 0, maximum: 45000, description: "Bounded wait. Defaults to 0 (immediate)." },
    },
    required: ["batch_id"], additionalProperties: false,
  },
};
const tools = [tool, startBatchTool, batchStatusTool];

const activeChildren = new Set();
const batches = new Map();
let activeExecution = false;
let disconnected = false;

function loadSession(sessionId, workspace) {
  if (!UUID_PATTERN.test(sessionId)) throw new Error("session_id must be a UUID");
  const dir = path.join(sessionsRoot, sessionId);
  const metaPath = path.join(dir, "session.json");
  if (!existsSync(metaPath)) throw new Error("Unknown session_id");
  let meta;
  try { meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { throw new Error("Session metadata could not be read"); }
  if (!meta || typeof meta.workspace !== "string" ||
      typeof meta.thread_id !== "string" || !UUID_PATTERN.test(meta.thread_id)) {
    throw new Error("Session metadata is invalid");
  }
  if (meta.workspace !== workspace) throw new Error("session_id belongs to a different workspace");
  return { dir, metaPath, threadId: meta.thread_id };
}

function appendCheckpoint(context, record) {
  if (!context.runsDir) return;
  try {
    mkdirSync(context.runsDir, { recursive: true });
    writeFileSync(path.join(context.runsDir, `${context.taskId}.jsonl`),
      JSON.stringify(record) + "\n", { flag: "a" });
  } catch (failure) {
    if (!context.ledgerWarning) context.ledgerWarning = failure?.message || String(failure);
  }
}

function compactCommand(attempt, item) {
  return { attempt, kind: "command",
    command: typeof item.command === "string" ? item.command.slice(0, 500) : "",
    exit: item.exit_code };
}

function compactFileChange(attempt, item) {
  const changed = Array.isArray(item.changes)
    ? item.changes.slice(0, 20).map(entry => {
        if (typeof entry === "string") return entry.slice(0, 300);
        if (entry && typeof entry.path === "string") return entry.path.slice(0, 300);
        return undefined;
      }).filter(Boolean)
    : [];
  return { attempt, kind: "file_change", status: item.status, changed };
}

function resolveCodexCommand() {
  if (!statSync(codexLocation, { throwIfNoEntry: false })?.isDirectory()) {
    return codexLocation;
  }

  const launcher = path.join(codexLocation, "codex.exe");
  if (statSync(launcher, { throwIfNoEntry: false })?.isFile()) return launcher;

  const installations = readdirSync(codexLocation, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[0-9a-f]{16}$/i.test(entry.name))
    .map(entry => {
      const directory = path.join(codexLocation, entry.name);
      return {
        command: path.join(directory, "codex.exe"),
        updatedAt: statSync(directory, { throwIfNoEntry: false })?.mtimeMs ?? 0,
      };
    })
    .filter(installation => statSync(installation.command, { throwIfNoEntry: false })?.isFile())
    .sort((a, b) => b.updatedAt - a.updatedAt || a.command.localeCompare(b.command));
  if (!installations.length) {
    throw new Error("No installed Codex executable found in " + codexLocation);
  }
  return installations[0].command;
}

function runAttempt(args, context, recovery = false) {
  const { workspace } = context;
  const codex = resolveCodexCommand();
  const attempt = ++context.attempt;
  const timeoutMs = recovery
    ? (context.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS)
    : (context.timeBudgetMs ?? ATTEMPT_TIMEOUT_MS);
  const readOnly = context.readOnly || (recovery && context.recoveryMode !== "repair");
  const sandboxMode = readOnly ? "read-only" : executionSandboxMode;

  const command = ["-a", "never", "exec", "--ignore-user-config", "--ignore-rules"];
  if (recovery || !context.persistent) command.push("--ephemeral");
  command.push("--skip-git-repo-check");
  if (!recovery && context.persistent) {
    command.push("-c", 'sandbox_mode="' + sandboxMode + '"');
  } else {
    command.push("-C", workspace, "-s", sandboxMode);
  }
  command.push(
    "-m", "deepseek/deepseek-v4-flash",
    "-c", 'model_reasoning_effort="high"',
    "-c", 'model_provider="commandcode"',
    "-c", 'model_providers.commandcode.name="CommandCode"',
    "-c", 'model_providers.commandcode.base_url="https://api.commandcode.ai/provider/v1"',
    "-c", 'model_providers.commandcode.env_key="COMMANDCODE_API_KEY"',
    "-c", 'windows.sandbox="unelevated"',
    "-c", 'sandbox_workspace_write.network_access=false',
    "-c", 'shell_environment_policy.inherit="core"',
    "-c", 'shell_environment_policy.exclude=["COMMANDCODE_API_KEY"]',
  );
  if (readOnly) command.push("-c", 'sandbox_mode="read-only"');
  command.push("--json");
  if (!recovery && context.storedThreadId) command.push("resume", context.storedThreadId, "-");
  else command.push("-");

  let prompt;
  if (recovery) {
    const observed = context.evidence.slice(-MAX_EVIDENCE);
    prompt = context.recoveryMode === "repair" ? [
      "You are the DeepSeek executor. The primary Codex session has already delegated this work to you. This is a fresh, bounded repair pass: the previous attempt timed out after some work landed.",
      "Inspect the already landed state first and do not redo or replay any completed side effect.",
      "Run the original safe acceptance checks to determine what actually landed and what is still deficient.",
      "Fix only a concrete deficiency within the original authorized scope, then rerun the affected checks to confirm the fix.",
      "Never replay completed side effects, expand scope, publish, or delete user data.",
      "If ambiguity or risk prevents a reliable continuation, stop and return a decision request with the evidence you gathered instead of guessing.",
      `Windows edits: use PowerShell with a single-quoted here-string for $patch, then run & '${codex.replaceAll("'", "''")}' --codex-run-as-apply-patch $patch from the workspace. Check $LASTEXITCODE and verify the file. If it fails, inspect once and use an exact text replacement when appropriate.`,
      "Report changed files, the exact check commands and observed results, and anything still incomplete.",
      `Original scope: ${args.task}`,
      `Last observed operations (most recent ${observed.length}): ${JSON.stringify(observed)}`,
    ].join("\n").replaceAll(context.apiKey, "[redacted]") : [
      "You are the DeepSeek executor. The primary Codex session has already delegated this work to you. This is a read-only verification pass: the previous attempt timed out.",
      "Do not modify, create, or delete any file and do not change any state. Verify only what already landed and run only the requested checks that are safe in read-only mode.",
      "Do not rewrite the task, replay the original writes, or escalate scope. Report what landed, the exact check commands and results, and anything still incomplete.",
      `Original scope: ${args.task}`,
      `Last observed operations (most recent ${observed.length}): ${JSON.stringify(observed)}`,
    ].join("\n").replaceAll(context.apiKey, "[redacted]");
  } else {
    const quickScan = context.quickScanHint ? [
      "Quick-scan hint for this first look only. It does not change the brief's permissions, goal, or scope; stay with the real read-only CLI.",
      "Start by finding one acceptance-checkable result for the inputs the brief lists, merging retrieval into as few passes as possible.",
      "Aim for about 3-4 tool rounds by default (not a hard limit; adjust when the task explicitly requires more). If you already have enough evidence, finalize now.",
      "List anything unread or missing evidence as explicit follow-ups instead of chasing it.",
      "Avoid whole-repository sweeps and repeated re-checking of the same inputs.",
    ] : [];
    prompt = [
      ...quickScan,
      "You are the DeepSeek executor. The primary Codex session has already delegated this work to you. Carry out the assigned work directly.",
      "Implement the assigned task. Keep edits within its stated scope and preserve existing work.",
      `Windows edits: use PowerShell with a single-quoted here-string for $patch, then run & '${codex.replaceAll("'", "''")}' --codex-run-as-apply-patch $patch from the workspace. Check $LASTEXITCODE and verify the file. If it fails, inspect once and use an exact text replacement when appropriate.`,
      "Run the requested local checks. Report changed files, actual test results, and blockers.",
      "",
      args.task,
    ].join("\n");
  }

  const env = { ...process.env, COMMANDCODE_API_KEY: context.apiKey };
  if (!recovery && context.childHome) env.CODEX_HOME = context.childHome;
  // configArgs: flat ["-c", value, ...] pairs extracted verbatim from the command.
  const configArgs = [];
  for (let index = 0; index < command.length - 1; index++) {
    if (command[index] === "-c") configArgs.push("-c", command[index + 1]);
  }
  const child = !recovery && args?.soft_steer === true
    ? spawnSteerableCodex({ codex, configArgs, cwd: workspace, env, sandbox: sandboxMode,
        model: "deepseek/deepseek-v4-flash", provider: "commandcode",
        resumeThreadId: context.storedThreadId, ephemeral: !context.persistent, timeoutMs })
    : spawn(codex, command, { cwd: workspace, env,
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  activeChildren.add(child);
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let summary = "";
    let stderr = "";
    let timedOut = false;
    let usage;
    let usageKnown = false;
    let metadataError;
    let threadMismatch = false;
    let identityConfirmed = false;
    let turnCompleted = false;
    let checkpoints = 0;
    const checks = [];
    const pending = new Set();
    const commandStarts = new Map();
    appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
      event: "attempt_start", timeout_ms: timeoutMs });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const lines = readline.createInterface({ input: child.stdout });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
    lines.on("line", line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (!event || typeof event !== "object") return;
      if (event.type === "thread.started") {
        const threadId = event.thread_id;
        const validThreadId = typeof threadId === "string" && UUID_PATTERN.test(threadId);
        if (!recovery && context.storedThreadId && threadId !== context.storedThreadId) {
          threadMismatch = true;
          child.kill();
          return;
        }
        if (validThreadId) {
          identityConfirmed = true;
          if (!recovery && context.retain && !context.metadataWritten) {
            try {
              writeFileSync(context.metaPath,
                JSON.stringify({ workspace, thread_id: threadId, created_at: new Date().toISOString() }, null, 2) + "\n",
                { flag: "wx" });
              context.metadataWritten = true;
            } catch (failure) { metadataError = failure; }
          }
        }
        return;
      }
      if (event.type === "turn.completed") {
        turnCompleted = true;
        if (event.usage !== undefined) { usage = event.usage; usageKnown = true; }
        return;
      }
      if (event.type === "worker.soft_steer") {
        appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
          event: "soft_steer", soft_steer: event.status === "accepted" ? "accepted" : "rejected",
          ...(typeof event.elapsed_ms === "number" ? { elapsed_ms: event.elapsed_ms } : {}) });
        return;
      }
      if (event.type === "item.started") {
        const item = event.item;
        if (item && typeof item === "object" && typeof item.id === "string" &&
            (item.type === "command_execution" || item.type === "file_change")) {
          pending.add(item.id);
          if (item.type === "command_execution") {
            commandStarts.set(item.id, Date.now());
            appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
              event: "command_started", item_id: item.id });
          }
        }
        return;
      }
      if (event.type !== "item.completed") return;
      const item = event.item;
      if (!item || typeof item !== "object") return;
      if (typeof item.id === "string") pending.delete(item.id);
      if (item.type === "agent_message" && typeof item.text === "string") summary = item.text;
      if (item.type === "command_execution") {
        if (checks.length === MAX_EVIDENCE) checks.shift();
        checks.push(compactCommand(attempt, item));
        checkpoints++;
        const commandStartedAt = typeof item.id === "string" ? commandStarts.get(item.id) : undefined;
        if (typeof item.id === "string") commandStarts.delete(item.id);
        appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
          event: "command_execution", count: checkpoints, exit_code: item.exit_code,
          ...(typeof item.id === "string" ? { item_id: item.id } : {}),
          ...(typeof commandStartedAt === "number" ? { duration_ms: Date.now() - commandStartedAt } : {}),
          ...(recovery ? { recovery_mode: context.recoveryMode } : {}) });
      } else if (item.type === "file_change") {
        if (checks.length === MAX_EVIDENCE) checks.shift();
        checks.push(compactFileChange(attempt, item));
        checkpoints++;
        appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
          event: "file_change", count: checkpoints,
          ...(recovery ? { recovery_mode: context.recoveryMode } : {}) });
      }
    });
    child.once("error", failure => { activeChildren.delete(child); reject(failure); });
    child.once("close", code => {
      clearTimeout(timer);
      activeChildren.delete(child);
      const durationMs = Date.now() - startedAt;
      const identityMissing = context.persistent && !recovery && !identityConfirmed && !threadMismatch;
      const success = !timedOut && code === 0 && turnCompleted && Boolean(summary) &&
        !threadMismatch && !metadataError && !identityMissing;
      const finalStatus = timedOut ? "timed_out" : success ? "completed" : "failed";
      appendCheckpoint(context, { timestamp: new Date().toISOString(), attempt,
        event: "turn_end", duration_ms: durationMs, status: finalStatus,
        ...(recovery ? { recovery_mode: context.recoveryMode } : {}),
        ...(usageKnown ? { usage } : {}) });
      context.checkpointCount += checkpoints;
      for (const id of pending) context.unconfirmed.add(id);
      for (const check of checks) {
        if (context.evidence.length === MAX_EVIDENCE) context.evidence.shift();
        context.evidence.push(check);
      }
      resolve({
        recovery, attempt, timedOut, exitCode: code, turnCompleted,
        summary, stderr, usage, usageKnown, checks, checkpoints,
        threadMismatch, identityMissing, metadataError, durationMs, success,
      });
    });
  });
}

function buildResult(context, initial, verification) {
  const status = verification?.success ? (context.recoveryMode === "repair" ? "timed_out_with_repair" : "timed_out_with_verification")
    : initial.timedOut ? "timed_out"
    : initial.success ? "completed"
    : "failed";
  const hasMetadata = context.resume !== undefined || context.metadataWritten;

  const parts = [];
  parts.push(`Status: ${status}`);
  parts.push(`Task ID: ${context.taskId}`);
  if (hasMetadata) parts.push(`Session ID: ${context.handle}`);
  parts.push(`Attempts: ${context.attempt}`);
  if (context.ledgerWarning) parts.push(`Checkpoint ledger warning: ${context.ledgerWarning}`);
  parts.push(initial.timedOut ? `Worker timed out after ${context.timeBudgetMs ?? ATTEMPT_TIMEOUT_MS} ms` : `Worker exit code: ${initial.exitCode}`);
  if (initial.threadMismatch) parts.push("The resumed session reported a different thread id; the run was aborted.");
  if (initial.identityMissing) parts.push("The run did not confirm a valid session thread id; the session may not be resumable.");
  if (initial.metadataError) parts.push(`The session metadata could not be stored: ${initial.metadataError.message}`);
  if (!initial.turnCompleted && !initial.timedOut) parts.push("The worker did not report a completed turn.");
  if (initial.summary) parts.push(initial.summary);
  if (initial.checks.length) parts.push(JSON.stringify(initial.checks));
  if (initial.usageKnown) parts.push(`Worker token usage: ${JSON.stringify(initial.usage)}`);
  if (initial.exitCode !== 0 && initial.stderr) parts.push(initial.stderr);

  if (verification) {
    parts.push(context.recoveryMode === "repair" ? "Recovery attempt (ephemeral, workspace-write, repair):" : "Verification attempt (ephemeral, read-only):");
    if (verification.error) {
      parts.push(`Verification attempt could not be started: ${verification.error}`);
    } else {
      parts.push(verification.timedOut ? `Verification timed out after ${context.recoveryTimeoutMs ?? RECOVERY_TIMEOUT_MS} ms` : `Verification exit code: ${verification.exitCode}`);
      if (!verification.turnCompleted && !verification.timedOut) parts.push("The verification run did not report a completed turn.");
      if (verification.summary) parts.push(verification.summary);
      if (verification.checks.length) parts.push(JSON.stringify(verification.checks));
      if (verification.usageKnown) parts.push(`Verification worker token usage: ${JSON.stringify(verification.usage)}`);
      if (verification.exitCode !== 0 && verification.stderr) parts.push(verification.stderr);
    }
    parts.push("The initial attempt timed out. Judge final acceptance from the recovery evidence.");
  }

  const structuredContent = {
    task_id: context.taskId,
    status,
    attempts: context.attempt,
    evidence: JSON.parse(JSON.stringify(context.evidence.slice(-MAX_EVIDENCE)).replaceAll(context.apiKey, "[redacted]")),
  };
  if (verification) structuredContent.verification_status =
    verification.error ? "failed" : verification.success ? "completed"
    : verification.timedOut ? "timed_out" : "failed";
  if (verification) structuredContent.recovery_mode = context.recoveryMode;
  if (hasMetadata) structuredContent.session_id = context.handle;

  return {
    content: [{ type: "text",
      text: parts.filter(Boolean).join("\n\n").replaceAll(context.apiKey, "[redacted]").slice(0, 16000) }],
    isError: Boolean(verification) || !initial.success,
    structuredContent,
  };
}

function resolveWorkspace(raw) {
  if (typeof raw !== "string" || !path.isAbsolute(raw)) {
    throw new Error("Provide an absolute project directory");
  }
  const workspace = realpathSync(raw);
  const home = realpathSync(homedir()).toLowerCase();
  if (!statSync(workspace).isDirectory() || workspace === path.parse(workspace).root ||
      workspace.toLowerCase() === home || workspace.toLowerCase().startsWith(home + path.sep + ".codex")) {
    throw new Error("Choose a project directory");
  }
  return workspace;
}

function requireTask(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 16000) {
    throw new Error("Provide a task of 1 to 16,000 characters");
  }
  return raw;
}

function createBatchContext(args, workspace, apiKey) {
  return {
    workspace, task: args.task, apiKey,
    resume: undefined, retain: false, persistent: false, readOnly: true,
    recoveryMode: "verify",
    timeBudgetMs: args.timeBudgetMs,
    recoveryTimeoutMs: BATCH_RECOVERY_TIMEOUT_MS,
    quickScanHint: true,
    batch: true,
    handle: undefined, dir: undefined, metaPath: undefined, storedThreadId: undefined,
    lockPath: undefined, childHome: undefined,
    taskId: args.taskId,
    runsDir: runsRoot,
    evidence: [], unconfirmed: new Set(), checkpointCount: 0, attempt: 0,
    metadataWritten: false, ledgerWarning: undefined,
  };
}

// Internal read-only, ephemeral path for batch items: same validation, attempt
// lifecycle and result shaping as execute, but it does not take the
// single-execution gate. Call arguments are supplied by the batch layer.
async function runBatchTask(args, apiKey) {
  const workspace = resolveWorkspace(args?.workspace);
  requireTask(args?.task);
  const context = createBatchContext(args, workspace, apiKey);
  const initial = await runAttempt(args, context, false);
  let verification;
  if (initial.timedOut && !disconnected && context.checkpointCount > 0 &&
      context.unconfirmed.size === 0) {
    try {
      verification = await runAttempt(args, context, true);
    } catch (failure) {
      verification = {
        recovery: true, attempt: context.attempt, timedOut: false, exitCode: -1,
        turnCompleted: false, summary: "", usageKnown: false, checks: [], checkpoints: 0,
        threadMismatch: false, identityMissing: false, metadataError: undefined,
        durationMs: 0, success: false,
        error: (String(failure?.message ?? failure).replaceAll(context.apiKey, "[redacted]").slice(0, 300) ||
          "Verification attempt could not be started"),
      };
    }
  }
  return { context, result: buildResult(context, initial, verification) };
}

function loadCredential() {
  const apiKey = execFileSync(
    powershell,
    ["-NoProfile", "-NonInteractive", "-Command",
      "$secret = Get-Content -LiteralPath $env:DEEPSEEK_WORKER_CREDENTIAL | ConvertTo-SecureString; [System.Net.NetworkCredential]::new('', $secret).Password"],
    { encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, DEEPSEEK_WORKER_CREDENTIAL: credential } },
  ).trim();
  if (!apiKey) throw new Error("The CommandCode credential could not be loaded");
  return apiKey;
}

function itemPath(batch, item) {
  return path.join(batch.dir, "items", `${item.seq}.json`);
}

function notifyBatch(batch) {
  const waiters = [...batch.waiters];
  batch.waiters.clear();
  for (const resolve of waiters) resolve();
}

function waitForBatch(batch, ms) {
  return new Promise(resolve => {
    let timer;
    const finish = () => { clearTimeout(timer); batch.waiters.delete(finish); resolve(); };
    timer = setTimeout(finish, ms);
    batch.waiters.add(finish);
  });
}

// Atomic publish: write the item record to a temp file, rename it into place,
// and only then advance the readable cursor. A crash cannot expose a partial
// record or advance the cursor for an unpublished item.
function publishItem(batch, item) {
  const cursor = item.cursor ?? batch.cursorSeq + 1;
  const record = {
    seq: item.seq, id: item.id, status: item.status,
    duration_ms: item.durationMs ?? null, attempts: item.attempts ?? 0,
    task_id: item.taskId, final: (item.final ?? "").slice(0, BATCH_FINAL_LIMIT),
    cursor,
  };
  try {
    mkdirSync(path.join(batch.dir, "items"), { recursive: true });
    const file = itemPath(batch, item);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(record) + "\n");
    renameSync(tmp, file);
  } catch (failure) {
    if (!batch.ledgerWarning) batch.ledgerWarning = String(failure?.message ?? failure).slice(0, 200);
    return;
  }
  item.cursor = cursor;
  if (cursor > batch.cursorSeq) batch.cursorSeq = cursor;
  notifyBatch(batch);
}

async function runBatchItem(batch, item) {
  if (disconnected) return;
  item.status = "running";
  const startedAt = Date.now();
  try {
    const softSteer = batch.softSteer === true;
    const { context, result } = await runBatchTask({ workspace: batch.workspace, task: item.task, taskId: item.taskId, timeBudgetMs: batch.timeBudgetMs, soft_steer: softSteer }, batch.apiKey);
    item.status = result.structuredContent.status;
    item.attempts = context.attempt;
    item.final = String(result.content?.[0]?.text ?? "").replaceAll(batch.apiKey, "[redacted]");
  } catch (failure) {
    item.status = "failed";
    item.final = String(failure?.message ?? failure).replaceAll(batch.apiKey, "[redacted]");
  }
  item.durationMs = Date.now() - startedAt;
  publishItem(batch, item);
}

async function runBatch(batch) {
  const loop = async () => {
    while (!disconnected) {
      const index = batch.next++;
      if (index >= batch.items.length) return;
      await runBatchItem(batch, batch.items[index]);
    }
  };
  try {
    const runners = [];
    for (let slot = 0; slot < batch.concurrency; slot++) runners.push(loop());
    await Promise.all(runners);
    for (const item of batch.items) {
      if (item.cursor === undefined) { item.status = "interrupted"; publishItem(batch, item); }
    }
    batch.status = batch.items.some(item => item.status === "interrupted") ? "interrupted" : "completed";
  } catch (failure) {
    if (!batch.ledgerWarning) batch.ledgerWarning = String(failure?.message ?? failure).slice(0, 200);
    batch.status = "interrupted";
  } finally {
    notifyBatch(batch);
    activeExecution = false;
  }
}

function batchSnapshot(batch, afterCursor) {
  const items = batch.items
    .filter(item => item.cursor !== undefined && item.cursor > afterCursor)
    .sort((a, b) => a.cursor - b.cursor)
    .map(item => ({
      id: item.id, cursor: item.cursor, status: item.status, task_id: item.taskId,
      attempts: item.attempts ?? 0, duration_ms: item.durationMs ?? null,
      final: (item.final ?? "").slice(0, BATCH_FINAL_LIMIT),
    }));
  const completed = batch.items.filter(item => item.cursor !== undefined).length;
  return { items, completed, total: batch.total, cursor: batch.cursorSeq };
}

function formatBatchStatus(batch, snapshot) {
  const lines = [`Batch ID: ${batch.id}`, `Status: ${batch.status}`,
    `Completed: ${snapshot.completed}/${snapshot.total}`, `Cursor: ${snapshot.cursor}`];
  if (batch.ledgerWarning) lines.push(`Checkpoint ledger warning: ${batch.ledgerWarning}`);
  for (const item of snapshot.items) {
    lines.push(`${item.id}: ${item.status} (cursor ${item.cursor}, attempts ${item.attempts}, ${item.duration_ms ?? "?"} ms)`);
  }
  return {
    content: [{ type: "text", text: lines.join("\n").slice(0, 16000) }],
    isError: false,
    structuredContent: {
      batch_id: batch.id, status: batch.status, completed: snapshot.completed,
      total: snapshot.total, cursor: snapshot.cursor, items: snapshot.items,
    },
  };
}

function loadBatch(batchId) {
  const dir = path.join(runsRoot, "batches", batchId);
  const manifestPath = path.join(dir, "manifest.json");
  if (!existsSync(manifestPath)) return undefined;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { throw new Error("Batch manifest could not be read"); }
  if (!manifest || !Array.isArray(manifest.items)) throw new Error("Batch manifest is invalid");
  let ledgerWarning;
  const items = manifest.items.map(entry => {
    const item = {
      seq: entry.seq, id: entry.id, taskId: entry.task_id, task: undefined,
      status: "interrupted", attempts: 0, durationMs: null, final: "", cursor: undefined,
    };
    const file = path.join(dir, "items", `${entry.seq}.json`);
    if (existsSync(file)) {
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        item.status = typeof record.status === "string" ? record.status : "failed";
        item.attempts = Number.isInteger(record.attempts) ? record.attempts : 0;
        item.durationMs = typeof record.duration_ms === "number" ? record.duration_ms : null;
        item.final = typeof record.final === "string" ? record.final : "";
        item.cursor = Number.isInteger(record.cursor) ? record.cursor : entry.seq;
      } catch { if (!ledgerWarning) ledgerWarning = "A batch item record could not be read"; }
    }
    return item;
  });
  const cursorSeq = items.reduce((max, item) => item.cursor !== undefined && item.cursor > max ? item.cursor : max, 0);
  return {
    id: batchId, dir, workspace: undefined, apiKey: undefined,
    concurrency: manifest.concurrency, total: items.length, items,
    status: items.every(item => item.cursor !== undefined && item.status !== "interrupted") ? "completed" : "interrupted",
    next: items.length, cursorSeq, waiters: new Set(), ledgerWarning,
  };
}

function getBatch(batchId) {
  let batch = batches.get(batchId);
  if (batch) return batch;
  batch = loadBatch(batchId);
  if (!batch) throw new Error("Unknown batch_id");
  batches.set(batchId, batch);
  return batch;
}

async function startBatch(args) {
  if (activeExecution) throw new Error("A DeepSeek execution is already running");
  if (disconnected) throw new Error("The wrapper is disconnected");
  const workspace = resolveWorkspace(args?.workspace);
  const tasks = args?.tasks;
  if (args.soft_steer !== undefined && typeof args.soft_steer !== "boolean") {
    throw new Error("soft_steer must be a boolean");
  }
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > MAX_BATCH_TASKS) {
    throw new Error(`Provide 1 to ${MAX_BATCH_TASKS} tasks`);
  }
  const seen = new Set();
  const items = tasks.map((entry, index) => {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim()) {
      throw new Error(`tasks[${index}].id must be a non-empty string`);
    }
    const id = entry.id.trim();
    if (id.length > 200) throw new Error(`tasks[${index}].id must be at most 200 characters`);
    if (seen.has(id)) throw new Error("Task ids must be unique");
    seen.add(id);
    requireTask(entry.task);
    return {
      seq: index + 1, id, task: entry.task, taskId: randomUUID(),
      status: "pending", attempts: 0, durationMs: null, final: "", cursor: undefined,
    };
  });
  let concurrency = BATCH_DEFAULT_CONCURRENCY;
  if (args.concurrency !== undefined) {
    if (!Number.isInteger(args.concurrency) ||
        args.concurrency < MIN_BATCH_CONCURRENCY ||
        args.concurrency > MAX_BATCH_CONCURRENCY) {
      throw new Error(`concurrency must be an integer from ${MIN_BATCH_CONCURRENCY} to ${MAX_BATCH_CONCURRENCY}`);
    }
    concurrency = args.concurrency;
  }
  concurrency = Math.min(concurrency, items.length);
  let timeBudgetSec = BATCH_DEFAULT_TIME_BUDGET_SEC;
  if (args.time_budget_sec !== undefined) {
    if (!Number.isInteger(args.time_budget_sec) ||
        args.time_budget_sec < BATCH_MIN_TIME_BUDGET_SEC ||
        args.time_budget_sec > BATCH_MAX_TIME_BUDGET_SEC) {
      throw new Error(`time_budget_sec must be an integer from ${BATCH_MIN_TIME_BUDGET_SEC} to ${BATCH_MAX_TIME_BUDGET_SEC}`);
    }
    timeBudgetSec = args.time_budget_sec;
  }
  const timeBudgetMs = timeBudgetSec * 1000;
  const softSteer = args?.soft_steer === true;

  activeExecution = true;
  let batch;
  try {
    const apiKey = loadCredential();
    const batchId = randomUUID();
    const dir = path.join(runsRoot, "batches", batchId);
    mkdirSync(dir, { recursive: true });
    const manifestPath = path.join(dir, "manifest.json");
    const manifestTmp = `${manifestPath}.tmp`;
    writeFileSync(manifestTmp, JSON.stringify({
      batch_id: batchId, created_at: new Date().toISOString(), concurrency, total: items.length,
      time_budget_sec: timeBudgetSec,
      items: items.map(item => ({ seq: item.seq, id: item.id, task_id: item.taskId })),
    }) + "\n");
    renameSync(manifestTmp, manifestPath);
    batch = {
      id: batchId, dir, workspace, apiKey, concurrency, total: items.length, items,
      timeBudgetSec, timeBudgetMs,
      softSteer,
      status: "running", next: 0, cursorSeq: 0, waiters: new Set(), ledgerWarning: undefined,
    };
    batches.set(batchId, batch);
  } catch (failure) {
    activeExecution = false;
    throw failure;
  }
  runBatch(batch).catch(failure => {
    if (!batch.ledgerWarning) batch.ledgerWarning = String(failure?.message ?? failure).slice(0, 200);
  });
  return {
    content: [{ type: "text",
      text: `Batch started\nBatch ID: ${batch.id}\nTasks: ${batch.total}\nConcurrency: ${batch.concurrency}\nTime budget: ${batch.timeBudgetSec}s per item (verify recovery ${BATCH_RECOVERY_TIMEOUT_MS / 1000}s)` }],
    isError: false,
    structuredContent: { batch_id: batch.id, status: "running", total: batch.total, concurrency: batch.concurrency, time_budget_sec: batch.timeBudgetSec, recovery_timeout_sec: BATCH_RECOVERY_TIMEOUT_MS / 1000 },
  };
}

async function batchStatus(args) {
  if (typeof args?.batch_id !== "string" || !UUID_PATTERN.test(args.batch_id)) {
    throw new Error("batch_id must be a UUID");
  }
  let afterCursor = 0;
  if (args.after_cursor !== undefined) {
    if (!Number.isInteger(args.after_cursor) || args.after_cursor < 0) {
      throw new Error("after_cursor must be a non-negative integer");
    }
    afterCursor = args.after_cursor;
  }
  let waitMs = 0;
  if (args.wait_ms !== undefined) {
    if (!Number.isInteger(args.wait_ms) || args.wait_ms < 0 || args.wait_ms > MAX_BATCH_WAIT_MS) {
      throw new Error(`wait_ms must be an integer from 0 to ${MAX_BATCH_WAIT_MS}`);
    }
    waitMs = args.wait_ms;
  }
  const batch = getBatch(args.batch_id);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const snapshot = batchSnapshot(batch, afterCursor);
    if (snapshot.items.length > 0 || batch.status !== "running") return formatBatchStatus(batch, snapshot);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return formatBatchStatus(batch, snapshot);
    await waitForBatch(batch, remaining);
  }
}

async function execute(args) {
  if (activeExecution) throw new Error("A DeepSeek execution is already running");
  requireTask(args?.task);
  if (args.retain_session !== undefined && typeof args.retain_session !== "boolean") {
    throw new Error("retain_session must be a boolean");
  }
  if (args.session_id !== undefined && typeof args.session_id !== "string") {
    throw new Error("session_id must be a string");
  }
  if (args.retain_session !== undefined && args.session_id !== undefined) {
    throw new Error("retain_session and session_id are mutually exclusive");
  }
  if (args.recovery_mode !== undefined && args.recovery_mode !== "verify" && args.recovery_mode !== "repair") {
    throw new Error("recovery_mode must be verify or repair");
  }
  if (args.soft_steer !== undefined && typeof args.soft_steer !== "boolean") {
    throw new Error("soft_steer must be a boolean");
  }
  const recoveryMode = args.recovery_mode === "repair" ? "repair" : "verify";
  const workspace = resolveWorkspace(args?.workspace);

  const resume = args.session_id;
  const retain = args.retain_session === true;
  const persistent = retain || resume !== undefined;
  let handle;
  let dir;
  let metaPath;
  let storedThreadId;
  if (resume !== undefined) {
    const session = loadSession(resume, workspace);
    handle = resume;
    dir = session.dir;
    metaPath = session.metaPath;
    storedThreadId = session.threadId;
  } else if (retain) {
    handle = randomUUID();
    dir = path.join(sessionsRoot, handle);
    metaPath = path.join(dir, "session.json");
  }

  activeExecution = true;
  let lockPath;
  let lockOwned = false;
  let childHome;
  try {
    const apiKey = loadCredential();

    if (persistent) {
      childHome = path.join(dir, "home");
      mkdirSync(childHome, { recursive: true });
      lockPath = path.join(dir, "lock");
      try {
        const lockFd = openSync(lockPath, "wx");
        lockOwned = true;
        closeSync(lockFd);
      } catch (failure) {
        if (failure?.code === "EEXIST") {
          throw new Error("This session is locked by another wrapper that has not exited; unlock it manually before retrying");
        }
        throw failure;
      }
    }

    const context = {
      workspace, task: args.task, apiKey, resume, retain, persistent,
      handle, dir, metaPath, storedThreadId, lockPath, childHome,
      taskId: randomUUID(),
      recoveryMode,
      runsDir: runsRoot,
      evidence: [],
      unconfirmed: new Set(),
      checkpointCount: 0,
      attempt: 0,
      metadataWritten: false,
      ledgerWarning: undefined,
    };

    const initial = await runAttempt(args, context, false);
    let verification;
    if (initial.timedOut && !disconnected && context.checkpointCount > 0 &&
        context.unconfirmed.size === 0) {
      try {
        verification = await runAttempt(args, context, true);
      } catch (failure) {
        verification = {
          recovery: true, attempt: context.attempt, timedOut: false, exitCode: -1,
          turnCompleted: false, summary: "", usageKnown: false, checks: [], checkpoints: 0,
          threadMismatch: false, identityMissing: false, metadataError: undefined,
          durationMs: 0, success: false,
          error: (String(failure?.message ?? failure).replaceAll(context.apiKey, "[redacted]").slice(0, 300) ||
            "Verification attempt could not be started"),
        };
      }
    }
    return buildResult(context, initial, verification);
  } finally {
    if (lockOwned) { try { unlinkSync(lockPath); } catch {} }
    activeExecution = false;
  }
}

const input = readline.createInterface({ input: process.stdin });
input.on("close", () => { disconnected = true; for (const child of activeChildren) { try { child.kill(); } catch {} } });
input.on("line", async line => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  const { id, method, params } = request;
  if (id === undefined) return;
  let result;
  let error;
  try {
    switch (method) {
      case "initialize":
        result = { protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} }, serverInfo: { name: "deepseek-worker", version: "1.0.0" } };
        break;
      case "ping": result = {}; break;
      case "tools/list": result = { tools }; break;
      case "tools/call": {
        const name = params?.name;
        if (name === tool.name) result = await execute(params.arguments);
        else if (name === startBatchTool.name) result = await startBatch(params.arguments);
        else if (name === batchStatusTool.name) result = await batchStatus(params.arguments);
        else throw new Error("Unknown tool");
        break;
      }
      default: error = { code: -32601, message: "Method not found" };
    }
  } catch (failure) {
    error = { code: -32603, message: failure.message };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result, error }) + "\n");
});
