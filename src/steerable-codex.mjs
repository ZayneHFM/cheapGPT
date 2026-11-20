import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline";

const SOFT_LIMIT_FRACTION = 0.618;
const SOFT_LIMIT_MESSAGE = "停止扩大范围和新增改动。安全完成手头这一步，交回已有证据、已落盘内容及未验证项。时间不足就先交部分结果。";

function asExecItem(item) {
  const type = { commandExecution: "command_execution", fileChange: "file_change", agentMessage: "agent_message" }[item?.type] ?? item?.type;
  if (type === "command_execution") {
    return { ...item, type, command: Array.isArray(item.command) ? item.command.join(" ") : item.command,
      exit_code: item.exitCode ?? item.exit_code, aggregated_output: item.aggregatedOutput ?? item.aggregated_output };
  }
  if (type === "file_change") {
    return { ...item, type, changes: item.changes?.map(change => ({ ...change, kind: change.kind?.type ?? change.kind })) };
  }
  return { ...item, type };
}

export function spawnSteerableCodex({ codex, configArgs, cwd, env, sandbox, model, provider, resumeThreadId, ephemeral, timeoutMs }) {
  const child = spawn(codex, ["app-server", ...configArgs], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const facade = new EventEmitter();
  facade.stdin = new PassThrough();
  facade.stdout = new PassThrough();
  facade.stderr = new PassThrough();
  child.stderr.pipe(facade.stderr, { end: false });

  let requestId = 0;
  let threadId;
  let turnId;
  let turnStartedAt;
  let steerTimer;
  let exitTimer;
  let closing = false;
  let exited = false;
  let exitCode;
  let finalAnswerStarted = false;
  const pending = new Map();

  const emitLine = value => facade.stdout.write(JSON.stringify(value) + "\n");
  const send = value => child.stdin.write(JSON.stringify(value) + "\n");

  function request(method, params) {
    return new Promise((resolve, reject) => {
      if (closing) { reject(new Error("App Server connection is closing")); return; }
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });
  }

  function finish(code, interrupt = false) {
    if (closing) return;
    closing = true;
    exitCode = code;
    clearTimeout(steerTimer);
    if (interrupt && threadId && turnId && !exited) {
      send({ id: ++requestId, method: "turn/interrupt", params: { threadId, turnId } });
    }
    child.stdin.end();
    exitTimer = setTimeout(() => {
      if (exited || !child.pid) return;
      if (process.platform !== "win32") { child.kill(); return; }
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => { if (!exited) child.kill(); });
      killer.once("exit", code => { if (code !== 0 && !exited) child.kill(); });
    }, 1200);
  }

  function fail(error) {
    if (closing) return;
    facade.stderr.write(String(error?.message ?? error ?? "App Server failed").slice(0, 1000) + "\n");
    finish(1);
  }

  function armSteer(id) {
    if (!id || closing || turnStartedAt !== undefined) return;
    turnId = id;
    turnStartedAt = Date.now();
    steerTimer = setTimeout(async () => {
      if (closing || finalAnswerStarted) return;
      const elapsed_ms = Date.now() - turnStartedAt;
      try {
        const reply = await request("turn/steer", {
          threadId, expectedTurnId: turnId, input: [{ type: "text", text: SOFT_LIMIT_MESSAGE }],
        });
        if (!closing) emitLine({ type: "worker.soft_steer", status: reply.turnId === turnId ? "accepted" : "rejected", elapsed_ms });
      } catch {
        if (!closing) emitLine({ type: "worker.soft_steer", status: "rejected", elapsed_ms });
      }
    }, Math.round(timeoutMs * SOFT_LIMIT_FRACTION));
  }

  function onLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id != null && message.method) {
      if (!closing) send({ id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      return;
    }
    if (message.id != null) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message ?? "App Server request failed"));
      else waiter.resolve(message.result ?? {});
      return;
    }
    if (closing) return;
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== threadId) return;
    if (message.method === "turn/started") {
      armSteer(params.turn?.id ?? params.turnId);
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = asExecItem(params.item);
      if (item.type === "agent_message" && ["final_answer", "finalAnswer"].includes(item.phase)) finalAnswerStarted = true;
      emitLine({ type: message.method.replace("/", "."), item });
    } else if (message.method === "turn/completed") {
      const turn = params.turn ?? {};
      if (turnId && turn.id && turn.id !== turnId) return;
      if (turn.status === "completed") {
        emitLine({ type: "turn.completed", ...(turn.usage ? { usage: turn.usage } : {}) });
        finish(0);
      } else {
        fail(turn.error?.message ?? ("App Server turn ended with status " + (turn.status ?? "unknown")));
      }
    }
  }

  async function begin(prompt) {
    await request("initialize", { clientInfo: { name: "deepseek-worker", title: "DeepSeek Worker", version: "1" } });
    send({ method: "initialized", params: {} });
    const settings = { cwd, model, modelProvider: provider, sandbox, approvalPolicy: "never" };
    const opened = resumeThreadId
      ? await request("thread/resume", { ...settings, threadId: resumeThreadId })
      : await request("thread/start", { ...settings, ephemeral });
    const thread = opened.thread;
    if (!thread?.id || (opened.modelProvider ?? thread.modelProvider) !== provider ||
        (resumeThreadId && thread.id !== resumeThreadId)) {
      throw new Error("App Server thread or provider does not match the requested DeepSeek context");
    }
    threadId = thread.id;
    emitLine({ type: "thread.started", thread_id: threadId });
    const started = await request("turn/start", { threadId, input: [{ type: "text", text: prompt }] });
    if (started.turn?.status === "inProgress" || started.turn?.status === "running") armSteer(started.turn.id);
  }

  let prompt = "";
  facade.stdin.setEncoding("utf8");
  facade.stdin.on("data", part => { prompt += part; });
  facade.stdin.once("end", () => { begin(prompt).catch(fail); });
  facade.kill = () => { finish(1, true); return true; };
  child.stdin.on("error", fail);
  child.once("exit", () => { exited = true; });
  child.once("error", error => { facade.emit("error", error); });
  child.once("close", (code, signal) => {
    exited = true;
    closing = true;
    clearTimeout(steerTimer);
    clearTimeout(exitTimer);
    for (const waiter of pending.values()) waiter.reject(new Error("App Server closed"));
    pending.clear();
    facade.stdout.end();
    facade.stderr.end();
    setImmediate(() => facade.emit("close", exitCode ?? (code === 0 ? 1 : code), signal));
  });
  createInterface({ input: child.stdout }).on("line", onLine);
  return facade;
}
