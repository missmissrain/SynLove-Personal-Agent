// backend/packages/webhook/webhook-qq/src/index.ts
import z from "@deepseek-ai/schemastery";
import { readFileSync as readFileSync3, unlinkSync, writeFileSync as writeFileSync2 } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { brandString } from "@deepseek-ai/dsh-brand";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { HarnessSessionHost, probe, get_shared_memory, register_timeline_tools, register_graph_tools } from "@deepseek-ai/dsh-webhook-weixin";

// backend/packages/webhook/webhook-qq/src/gateway.ts
var QqGateway = class {
  /** options 指定鉴权和事件处理；构造不联网。 */
  constructor(options) {
    this.options = options;
  }
  socket;
  heartbeat;
  handshake;
  reconnect;
  controller;
  seq = 0;
  sessionId = "";
  stopped = true;
  attempt = 0;
  generation = 0;
  awaiting_ack = false;
  ready = false;
  interval_ms = 3e4;
  kick_times = [];
  cooldown_until = 0;
  /** 无参数；幂等启动一个连接生命周期。 */
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }
  /** 无参数；取消资源并使旧异步回调失效。 */
  stop() {
    this.stopped = true;
    this.generation++;
    this.clear_connection();
    this.ready = false;
    if (this.reconnect !== void 0) clearTimeout(this.reconnect);
    this.reconnect = void 0;
    this.health("stopped");
  }
  /** phase 为阶段；以实际心跳周期计算健康证据有效期。 */
  health(phase) {
    this.options.on_health?.({ phase, expires_at: Date.now() + Math.max(3e4, this.interval_ms * 2 + 5e3) });
  }
  /** 无参数；释放连接资源，不负责重连。 */
  clear_connection() {
    if (this.heartbeat !== void 0) clearInterval(this.heartbeat);
    if (this.handshake !== void 0) clearTimeout(this.handshake);
    this.heartbeat = void 0;
    this.handshake = void 0;
    this.controller?.abort();
    this.controller = void 0;
    const socket = this.socket;
    this.socket = void 0;
    try {
      socket?.close();
    } catch (error) {
      this.options.log?.(`gateway \u5173\u95ED\u5931\u8D25\uFF1A${String(error).slice(0, 80)}`);
    }
  }
  /** gen 为连接代次，reason 为原因；当前连接最多安排一个重连。 */
  fail_connection(gen, reason) {
    if (this.stopped || gen !== this.generation) return;
    this.generation++;
    this.ready = false;
    this.clear_connection();
    this.health("reconnecting");
    const delay = Math.max(this.cooldown_until - Date.now(), Math.min(3e4, 1e3 * 2 ** Math.min(this.attempt++, 5)));
    this.options.log?.(`gateway ${reason}\uFF0C${Math.round(delay / 1e3)}s \u540E\u91CD\u8FDE`);
    if (this.reconnect !== void 0) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      this.reconnect = void 0;
      if (!this.stopped) void this.connect();
    }, delay);
  }
  /** 无参数；令牌、取地址、WebSocket 握手共用同一取消与超时边界。 */
  async connect() {
    if (this.stopped) return;
    const gen = ++this.generation;
    const live = () => !this.stopped && gen === this.generation;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.health("connecting");
    this.handshake = setTimeout(() => this.fail_connection(gen, "\u63E1\u624B\u8D85\u65F6"), this.options.handshake_timeout_ms ?? 3e4);
    try {
      const token = await this.options.token();
      if (!live()) return;
      const response = await fetch(`${this.options.baseUrl ?? "https://api.bot.qq.com"}/gateway`, {
        headers: { Authorization: `QQBot ${token}` },
        signal
      });
      if (!response.ok) throw new Error(`GET /gateway HTTP ${response.status}`);
      const body = await response.json();
      if (!live()) return;
      if (!body.url) throw new Error("GET /gateway \u6CA1\u8FD4\u56DE url");
      const socket = new WebSocket(body.url);
      this.socket = socket;
      socket.addEventListener("open", () => {
        if (live()) this.options.log?.("gateway \u5DF2\u8FDE\u63A5");
      });
      socket.addEventListener("message", (event) => {
        if (!live()) return;
        void this.handle_frame(String(event.data), gen).catch((error) => this.fail_connection(gen, `\u5904\u7406\u5E27\u5931\u8D25\uFF1A${String(error).slice(0, 120)}`));
      });
      socket.addEventListener("close", () => this.fail_connection(gen, "\u65AD\u5F00"));
      socket.addEventListener("error", () => this.fail_connection(gen, "\u8FDE\u63A5\u9519\u8BEF"));
    } catch (error) {
      this.fail_connection(gen, `\u8FDE\u63A5\u5931\u8D25\uFF1A${String(error).slice(0, 120)}`);
    }
  }
  /** raw 为协议帧，gen 为连接代次；确认和业务事件只作用于当前连接。 */
  async handle_frame(raw, gen = this.generation) {
    if (this.stopped || gen !== this.generation) return;
    let frame;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    switch (frame.op) {
      case 10: {
        const interval = Number(frame.d?.heartbeat_interval ?? 3e4);
        if (!Number.isFinite(interval) || interval < 1e3) throw new Error("\u5FC3\u8DF3\u95F4\u9694\u65E0\u6548");
        this.interval_ms = interval;
        await this.identify(gen);
        return;
      }
      case 11:
        this.awaiting_ack = false;
        this.health(this.ready ? "healthy" : "connecting");
        this.options.log?.("gateway \u5FC3\u8DF3\u5DF2\u786E\u8BA4");
        return;
      case 0:
        if (typeof frame.s === "number") this.seq = frame.s;
        if (frame.t === "READY" || frame.t === "RESUMED") {
          const id = frame.d?.session_id;
          if (id) this.sessionId = id;
          if (this.handshake !== void 0) clearTimeout(this.handshake);
          this.handshake = void 0;
          this.ready = true;
          this.attempt = 0;
          this.start_heartbeat(this.interval_ms, gen);
          this.health("ready");
          this.options.log?.("gateway READY");
        } else if (frame.t === "C2C_MESSAGE_CREATE" || frame.t === "GROUP_AT_MESSAGE_CREATE") {
          this.options.on_event({ t: frame.t, d: frame.d ?? {} });
        }
        return;
      case 7:
        this.kick_times = this.kick_times.filter((at) => Date.now() - at < 6e5);
        this.kick_times.push(Date.now());
        if (this.kick_times.length >= 5) {
          this.cooldown_until = Date.now() + 3e5;
          this.kick_times = [];
        }
        this.fail_connection(gen, "\u8981\u6C42\u91CD\u8FDE\uFF08op=7\uFF09");
        return;
      case 9:
        this.sessionId = "";
        this.seq = 0;
        this.fail_connection(gen, "\u4F1A\u8BDD\u5931\u6548\uFF08op=9\uFF09");
        return;
      default:
        return;
    }
  }
  /** interval 为心跳周期，gen 为连接代次；确认超时立即废弃旧连接。 */
  start_heartbeat(interval, gen) {
    if (this.heartbeat !== void 0) clearInterval(this.heartbeat);
    this.interval_ms = interval;
    this.awaiting_ack = false;
    const send = () => {
      if (this.stopped || gen !== this.generation) return;
      if (this.awaiting_ack) {
        this.fail_connection(gen, "\u5FC3\u8DF3\u786E\u8BA4\u8D85\u65F6");
        return;
      }
      try {
        if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("socket \u672A\u6253\u5F00");
        this.socket.send(JSON.stringify({ op: 1, d: this.seq }));
        this.awaiting_ack = true;
      } catch (error) {
        this.fail_connection(gen, `\u5FC3\u8DF3\u53D1\u9001\u5931\u8D25\uFF1A${String(error).slice(0, 80)}`);
      }
    };
    send();
    if (!this.stopped && gen === this.generation) this.heartbeat = setInterval(send, interval);
  }
  /** gen 为所属连接代次；取令牌后再核验代次，防止 stop 后复活。 */
  async identify(gen) {
    const token = await this.options.token();
    if (this.stopped || gen !== this.generation) return;
    const payload = this.sessionId === "" ? { op: 2, d: { token: `QQBot ${token}`, intents: this.options.intents ?? 1 << 25, shard: [0, 1], properties: {} } } : { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.seq } };
    this.socket?.send(JSON.stringify(payload));
  }
};

// backend/packages/webhook/webhook-qq/src/send.ts
var CHUNK_CHARS = 1200;
function split_text(text, limit = CHUNK_CHARS) {
  const value = text.trim();
  if (value === "") return [];
  const chunks = [];
  for (let index = 0; index < value.length; index += limit) chunks.push(value.slice(index, index + limit));
  return chunks;
}
async function send_qq_text(tokenProvider, target, text, msgId, baseUrl = "https://api.bot.qq.com", progress) {
  const chunks = split_text(text);
  if (chunks.length === 0) return { ok: true, mode: msgId === void 0 ? "active" : "passive" };
  const scope = target.groupOpenid !== void 0 ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}/messages` : target.userOpenid !== void 0 ? `/v2/users/${encodeURIComponent(target.userOpenid)}/messages` : void 0;
  if (scope === void 0) return { ok: false, mode: "passive", error: "\u6CA1\u6709\u53D1\u9001\u76EE\u6807\uFF08userOpenid / groupOpenid \u90FD\u4E3A\u7A7A\uFF09" };
  const mode = msgId === void 0 ? "active" : "passive";
  let lastId;
  for (const [index, chunk] of chunks.entries()) {
    if (progress?.sent_parts.includes(index)) continue;
    const body = { content: chunk, msg_type: 0 };
    if (msgId !== void 0) {
      body.msg_id = msgId;
      body.msg_seq = index + 1;
    }
    try {
      const token = await tokenProvider.get();
      const response = await fetch(`${baseUrl}${scope}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2e4)
      });
      const raw = await response.text();
      if (!response.ok) return { ok: false, mode, error: `HTTP ${response.status} ${raw.slice(0, 160)}` };
      progress?.on_sent(index);
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.id === "string") lastId = parsed.id;
      } catch {
      }
    } catch (error) {
      return { ok: false, mode, error: String(error).slice(0, 160) };
    }
  }
  return { ok: true, mode, ...lastId === void 0 ? {} : { id: lastId } };
}
function media_type_of(path) {
  const dot = path.lastIndexOf(".");
  const ext = dot < 0 ? "" : path.slice(dot + 1).toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) return 1;
  if (["mp4", "mov", "avi", "mkv", "webm"].includes(ext)) return 2;
  if (["silk", "amr", "mp3", "wav", "ogg", "m4a"].includes(ext)) return 3;
  return 4;
}
async function send_qq_media(tokenProvider, target, filePath, msgId, baseUrl = "https://api.bot.qq.com") {
  const scope = target.groupOpenid !== void 0 ? `/v2/groups/${encodeURIComponent(target.groupOpenid)}` : target.userOpenid !== void 0 ? `/v2/users/${encodeURIComponent(target.userOpenid)}` : void 0;
  if (scope === void 0) return { ok: false, mode: "passive", error: "\u6CA1\u6709\u53D1\u9001\u76EE\u6807" };
  let data;
  try {
    const { readFile } = await import("node:fs/promises");
    data = await readFile(filePath);
  } catch (error) {
    return { ok: false, mode: "passive", error: `\u8BFB\u53D6\u6587\u4EF6\u5931\u8D25\uFF1A${String(error).slice(0, 120)}` };
  }
  if (data.byteLength > 20 * 1024 * 1024) {
    return { ok: false, mode: "passive", error: `\u6587\u4EF6\u8FC7\u5927\uFF08${(data.byteLength / 1024 / 1024).toFixed(1)}MB\uFF0C\u4E0A\u9650 20MB\uFF09` };
  }
  try {
    const token = await tokenProvider.get();
    const upload = await fetch(`${baseUrl}${scope}/files`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
      body: JSON.stringify({
        file_type: media_type_of(filePath),
        file_data: data.toString("base64"),
        srv_send_msg: false
      }),
      signal: AbortSignal.timeout(6e4)
    });
    const uploadRaw = await upload.text();
    if (!upload.ok) return { ok: false, mode: "passive", error: `\u4E0A\u4F20\u5931\u8D25 HTTP ${upload.status} ${uploadRaw.slice(0, 160)}` };
    const info = JSON.parse(uploadRaw);
    if (typeof info.file_info !== "string" || info.file_info === "") {
      return { ok: false, mode: "passive", error: `\u4E0A\u4F20\u672A\u8FD4\u56DE file_info\uFF1A${uploadRaw.slice(0, 160)}` };
    }
    const send_once = async (passive) => {
      const body = { content: " ", msg_type: 7, media: { file_info: info.file_info } };
      if (passive && msgId !== void 0) {
        body.msg_id = msgId;
        body.msg_seq = 1;
      }
      const response = await fetch(`${baseUrl}${scope}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `QQBot ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(3e4)
      });
      const raw = await response.text();
      const mode = passive && msgId !== void 0 ? "passive" : "active";
      if (!response.ok) return { ok: false, mode, error: `HTTP ${response.status} ${raw.slice(0, 160)}` };
      try {
        const parsed = JSON.parse(raw);
        return { ok: true, mode, ...parsed.id === void 0 ? {} : { id: parsed.id } };
      } catch {
        return { ok: true, mode };
      }
    };
    const first = await send_once(true);
    if (first.ok) return first;
    console.error(`[webhook-qq] \u5A92\u4F53\u88AB\u52A8\u53D1\u9001\u5931\u8D25\uFF0C\u6539\u4E3B\u52A8\u91CD\u8BD5\uFF1A${first.error ?? ""}`);
    return await send_once(false);
  } catch (error) {
    return { ok: false, mode: "passive", error: String(error).slice(0, 160) };
  }
}

// backend/packages/webhook/webhook-qq/src/token.ts
var QqTokenProvider = class {
  constructor(options) {
    this.options = options;
  }
  token = "";
  expiresAt = 0;
  pending;
  /** 取一个可用 token（必要时刷新；并发调用只发一次请求）。 */
  async get() {
    if (this.token !== "" && Date.now() < this.expiresAt - 6e4) return this.token;
    this.pending ??= this.fetch_token().finally(() => {
      this.pending = void 0;
    });
    return this.pending;
  }
  /** 真正去换 token；失败直接抛（调用方按通道故障处理）。 */
  async fetch_token() {
    const base = this.options.baseUrl ?? "https://api.bot.qq.com";
    const response = await fetch(`${base}/app/getAppAccessToken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.options.appId, clientSecret: this.options.clientSecret }),
      signal: AbortSignal.timeout(15e3)
    });
    if (!response.ok) throw new Error(`QQ getAppAccessToken HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data.access_token !== "string" || data.access_token === "") {
      throw new Error(`QQ getAppAccessToken failed: ${data.message ?? "no access_token"}`);
    }
    const ttl = Number(data.expires_in ?? 7200);
    this.token = data.access_token;
    this.expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 7200) * 1e3;
    return this.token;
  }
};

// backend/packages/webhook/webhook-qq/src/QqOutbox.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
var QqOutbox = class {
  /** path 为队列文件，send 接收消息与分段确认回调，report 只报告脱敏元数据。 */
  constructor(path, send, report) {
    this.path = path;
    this.send = send;
    this.report = report;
    if (!existsSync(path)) return;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.some((row) => typeof row.id !== "string" || typeof row.text !== "string" || !Array.isArray(row.sent_parts) || typeof row.attempt !== "number" || typeof row.next_at !== "number" || !row.target || !["pending", "failed_terminal"].includes(row.status))) {
      throw new Error("QQ outbox \u6587\u4EF6\u683C\u5F0F\u65E0\u6548\uFF0C\u539F\u6587\u4EF6\u5DF2\u4FDD\u7559");
    }
    this.rows = data.rows;
  }
  rows = [];
  draining = false;
  stopped = false;
  /** 无参数；写入临时文件后原子替换，私聊正文只保存在本地状态目录。 */
  save_rows() {
    mkdirSync(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: 1, rows: this.rows }), { mode: 384, flush: true });
    renameSync(temp, this.path);
  }
  /** reply 为完整待发回复；持久化失败会抛出，调用方不得删除内存回复。 */
  enqueue_reply(reply) {
    if (reply.msgId !== void 0) {
      const duplicate = this.rows.find((row2) => row2.msgId === reply.msgId && JSON.stringify(row2.target) === JSON.stringify(reply.target) && row2.text === reply.text && row2.status !== "failed_terminal");
      if (duplicate !== void 0) return duplicate.id;
    }
    if (this.rows.length >= 1024) throw new Error("QQ outbox \u5DF2\u6EE1\uFF0C\u5F85\u53D1\u6D88\u606F\u672A\u5220\u9664");
    const row = {
      ...reply,
      id: randomUUID(),
      attempt: 0,
      next_at: 0,
      status: "pending",
      sent_parts: []
    };
    this.rows.push(row);
    try {
      this.save_rows();
    } catch (error) {
      this.rows.pop();
      throw error;
    }
    return row.id;
  }
  /** 无参数；串行发送到期消息，失败保留，防止相同目标后续消息越过失败记录。 */
  async drain_queue() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    const blocked = /* @__PURE__ */ new Set();
    try {
      for (const row of [...this.rows]) {
        if (this.stopped) break;
        if (row.status === "failed_terminal") continue;
        const target = JSON.stringify(row.target);
        if (blocked.has(target)) continue;
        if (row.next_at > Date.now()) {
          blocked.add(target);
          continue;
        }
        let result;
        try {
          result = await this.send(row, (index) => {
            if (!row.sent_parts.includes(index)) row.sent_parts.push(index);
            this.save_rows();
          });
        } catch (error) {
          result = { ok: false, mode: "passive", error: String(error).slice(0, 160) };
        }
        if (result.ok) {
          this.rows.splice(this.rows.indexOf(row), 1);
        } else {
          row.attempt++;
          row.error = result.error ?? "\u53D1\u9001\u5931\u8D25";
          row.next_at = Date.now() + Math.min(3e5, 5e3 * 2 ** row.attempt);
          if (row.attempt >= 5) row.status = "failed_terminal";
          blocked.add(target);
        }
        this.save_rows();
        this.report({ outbound_id: row.id, ok: result.ok, status: result.ok ? "sent" : row.status, attempt: row.attempt });
      }
    } finally {
      this.draining = false;
    }
  }
  /** 无参数；停止取新任务，已经在途的发送仍可持久记录结果。 */
  stop_queue() {
    this.stopped = true;
  }
};

// backend/packages/webhook/webhook-qq/src/QqRemoteOutbox.ts
var QqRemoteOutbox = class {
  /** 创建只通过远程状态端口工作的 QQ 队列。 */
  constructor(client, send, report) {
    this.client = client;
    this.send = send;
    this.report = report;
  }
  draining = false;
  stopped = false;
  /** 将回复原子加入远程队列，返回远程记录 ID。 */
  async enqueue_reply(reply) {
    const row = await this.client.enqueue(reply);
    return String(row.id);
  }
  /** 串行发送到期消息；同一目标的失败会阻塞其后续消息。 */
  async drain_queue() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    const blocked = /* @__PURE__ */ new Set();
    try {
      for (const raw of await this.client.list_pending()) {
        if (this.stopped) break;
        const row = raw;
        if (row.status === "failed_terminal") continue;
        const target = JSON.stringify(row.target);
        if (blocked.has(target) || row.next_at > Date.now()) {
          blocked.add(target);
          continue;
        }
        const marks = [];
        const mark = (index) => {
          if (!row.sent_parts.includes(index)) row.sent_parts.push(index);
          marks.push(this.client.mark_part_sent(row.id, index));
        };
        let result;
        try {
          result = await this.send(row, mark);
          await Promise.all(marks);
        } catch (error) {
          result = { ok: false, mode: "passive", error: String(error).slice(0, 160) };
        }
        if (result.ok) {
          await this.client.mark_sent(row.id);
        } else {
          const attempt = row.attempt + 1;
          await this.client.mark_failed(
            row.id,
            result.error ?? "\u53D1\u9001\u5931\u8D25",
            Date.now() + Math.min(3e5, 5e3 * 2 ** attempt),
            attempt >= 5
          );
          blocked.add(target);
        }
        this.report({
          outbound_id: row.id,
          ok: result.ok,
          status: result.ok ? "sent" : attempt_status(row, result),
          attempt: row.attempt + (result.ok ? 0 : 1)
        });
      }
    } finally {
      this.draining = false;
    }
  }
  /** 停止接收新发送任务；已在途请求由当前调用自然结束。 */
  stop_queue() {
    this.stopped = true;
  }
};
function attempt_status(row, result) {
  return result.ok ? "sent" : row.attempt + 1 >= 5 ? "failed_terminal" : "pending";
}

// backend/packages/webhook/webhook-qq/src/QqStateRemoteClient.ts
function normalize_row(row) {
  return {
    ...row,
    ...typeof row.msg_id === "string" ? { msgId: row.msg_id } : {},
    ...Array.isArray(row.sent_parts) ? { sent_parts: row.sent_parts } : { sent_parts: [] }
  };
}
var QqStateRemoteClient = class {
  base_url;
  api_key;
  timeout_ms;
  /** 读取环境配置并创建远程状态客户端。 */
  constructor(options = {}) {
    this.base_url = (options.base_url ?? process.env.SYNLOVE_QQSTATE_BASE_URL ?? "http://127.0.0.1:8799/v1").replace(/\/+$/, "");
    this.api_key = options.api_key ?? process.env.SYNLOVE_QQSTATE_API_KEY ?? "";
    this.timeout_ms = Math.max(1e3, Math.min(12e4, options.timeout_ms ?? 3e4));
  }
  /** 调用 qqstate 服务工具，必要时等待异步操作完成。 */
  async call(name2, arguments_ = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout_ms);
    try {
      const response = await fetch(`${this.base_url}/rpc`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.api_key === "" ? {} : { Authorization: `Bearer ${this.api_key}` }
        },
        body: JSON.stringify({
          requestId: `qqstate-${crypto.randomUUID()}`,
          message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name2, arguments: arguments_ } }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`qqstate \u670D\u52A1 HTTP ${response.status}`);
      let operation = await response.json();
      while (operation.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(String(operation.requestId ?? ""))}`, {
          headers: this.api_key === "" ? {} : { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal
        });
        operation = await status.json();
      }
      if (operation.state !== "done") throw new Error(`qqstate \u670D\u52A1\u4EFB\u52A1\u72B6\u6001 ${String(operation.state)}`);
      const outer = operation.result ?? {};
      const rpc = outer.result ?? outer;
      if (rpc.isError === true) throw new Error(String(rpc.content ?? "qqstate \u670D\u52A1\u8C03\u7528\u5931\u8D25"));
      return rpc.structuredContent ?? {};
    } finally {
      clearTimeout(timer);
    }
  }
  /** 幂等加入 QQ outbox。 */
  async enqueue(reply) {
    return normalize_row((await this.call("qq_enqueue", { reply })).outbox);
  }
  /** 读取待发送 QQ outbox。 */
  async list_pending(limit = 1024) {
    const rows = (await this.call("qq_list_pending", { limit })).outbox;
    return Array.isArray(rows) ? rows.map((row) => normalize_row(row)) : [];
  }
  /** 记录分段已发送。 */
  async mark_part_sent(id, index) {
    await this.call("qq_mark_part_sent", { id, index });
  }
  /** 标记消息成功并从队列删除。 */
  async mark_sent(id) {
    await this.call("qq_mark_sent", { id });
  }
  /** 标记失败并设置下次重试时间。 */
  async mark_failed(id, error, next_at, terminal) {
    await this.call("qq_mark_failed", { id, error, nextAt: next_at, terminal });
  }
  /** 原子获取 QQ 网关租约。 */
  async acquire_lease(input) {
    return (await this.call("qq_acquire_lease", input)).acquired === true;
  }
  /** 续租 QQ 网关租约。 */
  async heartbeat_lease(owner_id) {
    return (await this.call("qq_heartbeat_lease", { ownerId: owner_id })).updated === true;
  }
  /** 释放 QQ 网关租约。 */
  async release_lease(owner_id) {
    await this.call("qq_release_lease", { ownerId: owner_id });
  }
};

// backend/packages/webhook/webhook-qq/src/QqRemoteLease.ts
import { randomUUID as randomUUID2 } from "node:crypto";
var QqRemoteLease = class {
  /** 创建远程租约实例。 */
  constructor(client, account_id, stale_ms = 3e4) {
    this.client = client;
    this.account_id = account_id;
    this.stale_ms = stale_ms;
  }
  owner_id = randomUUID2();
  started_at = Date.now() - Math.round(process.uptime() * 1e3);
  held = false;
  timer;
  /** 向服务端原子申请唯一 QQ 消费者租约。 */
  async acquire_lease() {
    this.held = await this.client.acquire_lease({
      ownerId: this.owner_id,
      pid: process.pid,
      startedAt: this.started_at,
      staleMs: this.stale_ms,
      accountId: this.account_id
    });
    if (this.held && this.timer === void 0) {
      this.timer = setInterval(() => {
        void this.client.heartbeat_lease(this.owner_id).then((ok) => {
          if (!ok) this.held = false;
        }).catch(() => {
          this.held = false;
        });
      }, Math.max(1e3, Math.floor(this.stale_ms / 3)));
      this.timer.unref?.();
    }
    return this.held;
  }
  /** 释放当前持有者租约。 */
  async release_lease() {
    if (!this.held) return;
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    await this.client.release_lease(this.owner_id);
    this.held = false;
  }
};

// backend/packages/webhook/webhook-qq/src/QqGatewayLease.ts
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
import { randomUUID as randomUUID3 } from "node:crypto";
function is_pid_alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function process_started_at(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-Command",
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p) { Write-Output ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() }`
      ], { encoding: "utf8", timeout: 5e3, windowsHide: true });
      const value = Number(out.trim());
      return Number.isFinite(value) && value > 0 ? value : void 0;
    }
    const stat = readFileSync2(`/proc/${pid}/stat`, "utf8");
    const ticks = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]);
    const boot = Number(readFileSync2("/proc/stat", "utf8").split("\n").find((line) => line.startsWith("btime "))?.split(" ")[1]);
    return Number.isFinite(ticks) && Number.isFinite(boot) ? (boot + ticks / 100) * 1e3 : void 0;
  } catch {
    return void 0;
  }
}
function lease_holder_alive(pid, recorded_started_at) {
  if (!is_pid_alive(pid)) return false;
  const actual = process_started_at(pid);
  return actual === void 0 || Math.abs(actual - recorded_started_at) <= 6e4;
}
var QqGatewayLease = class {
  db;
  owner = randomUUID3();
  closed = false;
  /** path 为租约库文件；仅初始化锁表，不创建网关连接。 */
  constructor(path) {
    mkdirSync2(dirname2(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("CREATE TABLE IF NOT EXISTS gateway_lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, pid INTEGER, started_at INTEGER)");
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version === 0) this.db.exec("PRAGMA user_version=1");
    else if (version !== 1) throw new Error(`QQ lease schema \u7248\u672C\u4E0D\u5339\u914D\uFF1A${version}`);
  }
  /** 无参数；单个事务核对活进程并获取租约，冲突返回 false。 */
  acquire_lease() {
    if (this.closed) throw new Error("QQ lease \u5DF2\u5173\u95ED");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT pid,started_at FROM gateway_lease WHERE id=1").get();
      if (row && lease_holder_alive(row.pid, row.started_at)) {
        this.db.exec("COMMIT");
        return false;
      }
      this.db.prepare("INSERT INTO gateway_lease VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,pid=excluded.pid,started_at=excluded.started_at").run(this.owner, process.pid, Date.now() - Math.round(process.uptime() * 1e3));
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** 无参数；仅释放自己的租约并关闭连接，重复释放无副作用。 */
  release_lease() {
    if (this.closed) return;
    this.db.prepare("DELETE FROM gateway_lease WHERE owner=?").run(this.owner);
    this.db.close();
    this.closed = true;
  }
};

// backend/packages/webhook/webhook-qq/src/index.ts
function shared_session_id() {
  if ((process.env.DSH_SESSION_SHARED ?? "").trim() === "") return "";
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh");
  try {
    return readFileSync3(join(home, "shared-session.txt"), "utf8").split("\n")[0]?.trim() ?? "";
  } catch {
    return "main";
  }
}
var name = "webhook-qq";
var inject = ["agents", "agentPresets", "sessionPersistence"];
var Config = z.object({
  app_id: z.string().required(),
  client_secret: z.string().role("secret").required(),
  workspace_path: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  agent_preset: z.string(),
  base_url: z.string(),
  intents: z.number()
});
function apply(ctx, config) {
  if (!config.app_id.trim()) throw new Error("webhook-qq app_id must be non-empty");
  if (!config.client_secret.trim()) throw new Error("webhook-qq client_secret must be non-empty");
  probe("lifecycle", "qq.plugin.apply", { app_id: config.app_id, preset: config.agent_preset ?? "", shared_env: process.env.DSH_SESSION_SHARED ?? "", shared_id: shared_session_id() });
  const host = new HarnessSessionHost(ctx, {
    ...config.agent_preset === void 0 ? {} : { agent_preset: config.agent_preset },
    workspace_path: config.workspace_path,
    provider: config.provider,
    model: config.model
  });
  host.assert_capabilities();
  const tokens = new QqTokenProvider({
    appId: config.app_id,
    clientSecret: config.client_secret,
    ...config.base_url === void 0 ? {} : { baseUrl: config.base_url }
  });
  const pending = /* @__PURE__ */ new Map();
  const bound = /* @__PURE__ */ new WeakSet();
  let outbox;
  const last_msg = /* @__PURE__ */ new Map();
  const asst_seq = /* @__PURE__ */ new Map();
  const record_memory = async (session_id, role, text, stable_id) => {
    const suite = get_shared_memory();
    if (suite === void 0) return;
    try {
      await suite.timeline.append({
        id: stable_id,
        ts: Date.now(),
        role,
        text,
        session_id,
        user_id: session_id
      });
    } catch (error) {
      probe("memory", "qq.record_failed", { error: String(error) });
    }
  };
  const register_query_tools = (ctx2) => {
    const suite = get_shared_memory();
    if (suite === void 0) return;
    register_timeline_tools(ctx2, suite.timeline);
    register_graph_tools(ctx2, suite.graph);
  };
  const flush = async (session_id) => {
    const item = pending.get(session_id);
    if (item === void 0 || item.text.trim() === "") return;
    const seq = (asst_seq.get(session_id) ?? 0) + 1;
    asst_seq.set(session_id, seq);
    await record_memory(session_id, "assistant", item.text.trim(), `qq-asst-${session_id}-${seq}`);
    {
      await get_outbox().enqueue_reply(item);
      pending.delete(session_id);
      await get_outbox().drain_queue();
    }
  };
  const bind_stream = (agent, session_id) => {
    if (bound.has(agent)) return;
    bound.add(agent);
    agent.ctx.on("agent/assistant-stream", (payload) => {
      if (payload.agent !== void 0 && payload.agent !== agent) return;
      const frame = payload.frame;
      if (frame?.type !== "chunk") return;
      const chunk = frame.chunk;
      if (chunk?.type !== "text-delta" || typeof chunk.text !== "string") return;
      const item = pending.get(session_id);
      if (item !== void 0) item.text += chunk.text;
    });
    agent.ctx.on("agent/turn-stopping", (payload) => {
      if (payload.agent !== void 0 && payload.agent !== agent) return;
      void flush(session_id).catch((error) => probe("outbound", "qq.flush_failed", { error: String(error).slice(0, 160) }));
    });
  };
  const wait_for_agent = async (session_id) => {
    const deadline = Date.now() + 45e3;
    let last_error;
    while (Date.now() < deadline) {
      const live = host.get_agent(session_id);
      if (live !== void 0) return live;
      try {
        return await host.create_agent(session_id);
      } catch (error) {
        last_error = error;
        const message = String(error?.message ?? error);
        if (!/SessionAlreadyOwned|already owned|already exists|正在写入|busy/i.test(message)) throw error;
        probe("inbound", "qq.session_busy", { session_id: String(session_id), retry_ms: 2e3 });
        await new Promise((resolve) => setTimeout(resolve, 2e3));
      }
    }
    throw last_error ?? new Error("\u4F1A\u8BDD\u4E00\u76F4\u88AB\u5360\u7528\uFF0C\u7B49\u4E0D\u5230\u5199\u5165\u53E5\u67C4");
  };
  const handle_event = async (kind, data) => {
    const author = data.author ?? {};
    const openid = author.user_openid ?? author.member_openid ?? author.id;
    const content = typeof data.content === "string" ? data.content.trim() : "";
    const msg_id = typeof data.id === "string" ? data.id : void 0;
    const group = typeof data.group_openid === "string" ? data.group_openid : void 0;
    if (openid === void 0 || content === "") return;
    const shared = group === void 0 ? shared_session_id() : "";
    const session_id = brandString(shared !== "" ? shared : `qq-${group === void 0 ? openid : `g-${group}-${openid}`}`);
    const target = group === void 0 ? { userOpenid: openid } : { groupOpenid: group };
    probe("inbound", "qq.message", { kind, session_id: String(session_id), chars: content.length, group: group !== void 0 });
    if (msg_id !== void 0) await record_memory(String(session_id), "user", content, `qq-${msg_id}`);
    try {
      const agent = await wait_for_agent(session_id);
      register_query_tools(agent.ctx);
      const session_key = String(session_id);
      if (msg_id !== void 0) last_msg.set(session_key, msg_id);
      const media_tool = defineTool({
        name: "send_file",
        description: '\u628A\u672C\u5730\u56FE\u7247/\u89C6\u9891/\u8BED\u97F3/\u6587\u6863\u771F\u6B63\u53D1\u5230\u5F53\u524D QQ \u804A\u5929\uFF08\u4E0D\u662F\u53EA\u7ED9\u8DEF\u5F84\uFF09\u3002\u7528\u6237\u8BF4"\u53D1\u6211""\u53D1\u8FC7\u6765""\u622A\u56FE\u7ED9\u6211"\u65F6\u7528\u5B83\u3002',
        parameters: {
          path: { type: "string", description: "\u672C\u5730\u6587\u4EF6\u7EDD\u5BF9\u8DEF\u5F84\uFF0820MB \u4EE5\u5185\uFF09" }
        },
        output: {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              ok: { type: "boolean", required: true },
              text: { type: "string", required: true }
            }
          },
          render: (_args, value) => [{ type: "text", text: value.text }]
        },
        async execute(args) {
          const file = String(args.path ?? "").trim();
          if (file === "") return { ok: false, text: "path \u4E0D\u80FD\u4E3A\u7A7A" };
          const result = await send_qq_media(tokens, target, file, last_msg.get(session_key), config.base_url);
          if (result.ok) return { ok: true, text: `\u5DF2\u53D1\u9001\uFF1A${file}\uFF08${result.mode}\uFF09` };
          return { ok: false, text: `\u53D1\u9001\u5931\u8D25\uFF1A${result.error ?? "\u672A\u77E5\u9519\u8BEF"}` };
        }
      });
      const current = agent.ctx.tools.get("send_file", agent);
      if (current === void 0) {
        agent.ctx.tools.register(media_tool);
      } else {
        current.description = media_tool.description;
        current.parameters = media_tool.parameters;
        current.execute = media_tool.execute;
      }
      bind_stream(agent, String(session_id));
      pending.set(String(session_id), {
        text: pending.get(String(session_id))?.text ?? "",
        ...msg_id === void 0 ? {} : { msgId: msg_id },
        target
      });
      const message = createUserMessage({
        content: [{ type: "text", text: content }],
        source: { kind: "plugin", plugin: "webhook-qq", form: "notice", summary: "QQ \u6D88\u606F" }
      });
      if (agent.status === "idle") agent.followup(message);
      else agent.steer(message);
    } catch (error) {
      probe("inbound", "qq.handle_failed", { session_id: String(session_id), error: String(error).slice(0, 160) });
      console.error(`[webhook-qq] \u5904\u7406\u6D88\u606F\u5931\u8D25\uFF1A${String(error).slice(0, 200)}`);
      await send_qq_text(tokens, target, "\u6211\u8FD9\u8FB9\u521A\u624D\u6CA1\u5904\u7406\u6210\uFF0C\u7A0D\u540E\u518D\u8BD5\u4E00\u6B21\u597D\u5417\uFF1F", msg_id, config.base_url);
    }
  };
  const get_outbox = () => {
    if (outbox !== void 0) return outbox;
    const send = async (row, mark) => {
      const progress = { sent_parts: row.sent_parts, on_sent: mark };
      const result = await send_qq_text(tokens, row.target, row.text, row.msgId, config.base_url, progress);
      if (!result.ok && result.mode === "passive" && /HTTP 400|HTTP 403/.test(result.error ?? "")) {
        return send_qq_text(tokens, row.target, row.text, void 0, config.base_url, progress);
      }
      return result;
    };
    const report = (state) => probe("outbound", "qq.send", state);
    if ((process.env.SYNLOVE_QQ_STATE_MODE ?? "local").trim().toLowerCase() === "remote") {
      outbox = new QqRemoteOutbox(new QqStateRemoteClient(), send, report);
    } else {
      outbox = new QqOutbox(
        process.env.DSH_QQ_OUTBOX ?? join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "qq-outbox.json"),
        send,
        report
      );
    }
    return outbox;
  };
  const gateway = new QqGateway({
    token: () => tokens.get(),
    ...config.intents === void 0 ? {} : { intents: config.intents },
    ...config.base_url === void 0 ? {} : { baseUrl: config.base_url },
    on_event: (event) => {
      void handle_event(event.t, event.d);
    },
    on_health: (state) => probe("lifecycle", "qq.health", { ...state, pid: process.pid }),
    log: (message) => {
      console.error(`[webhook-qq] ${message}`);
      probe("lifecycle", "qq.gateway", { message: message.slice(0, 160) });
    }
  });
  const lock_path = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "qq-gateway.pid");
  const remote_state = (process.env.SYNLOVE_QQ_STATE_MODE ?? "local").trim().toLowerCase() === "remote";
  const lock_held = (() => {
    try {
      const pid = Number(readFileSync3(lock_path, "utf8").trim());
      if (pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      }
    } catch {
      return false;
    }
    return false;
  })();
  ctx.effect(async () => {
    if (!remote_state && lock_held) {
      console.error("[webhook-qq] \u53E6\u4E00\u4E2A\u5B9E\u4F8B\u5DF2\u5360\u7528\u7F51\u5173\uFF08qq-gateway.pid\uFF09\uFF0C\u672C\u5B9E\u4F8B\u4E0D\u8FDE QQ");
      probe("lifecycle", "qq.gateway.skip_duplicate", { pid: process.pid });
      return () => {
      };
    }
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const remote_client = remote_state ? new QqStateRemoteClient() : void 0;
    const lease = remote_client === void 0 ? new QqGatewayLease(join(home, "qq-gateway-lease.db")) : new QqRemoteLease(remote_client, config.app_id);
    if (!await lease.acquire_lease()) {
      await lease.release_lease();
      probe("lifecycle", "qq.gateway.skip_duplicate", { pid: process.pid });
      return () => {
      };
    }
    let retry;
    try {
      if (!remote_state) writeFileSync2(lock_path, String(process.pid), "utf8");
      get_outbox();
      retry = setInterval(() => {
        void outbox?.drain_queue().catch((error) => probe("outbound", "qq.outbox_failed", { error: String(error).slice(0, 160) }));
      }, 5e3);
      void get_outbox().drain_queue().catch((error) => probe("outbound", "qq.outbox_failed", { error: String(error).slice(0, 160) }));
      gateway.start();
      probe("lifecycle", "qq.gateway.start", {});
    } catch (error) {
      if (retry !== void 0) clearInterval(retry);
      outbox?.stop_queue();
      await lease.release_lease();
      try {
        if (!remote_state && readFileSync3(lock_path, "utf8").trim() === String(process.pid)) unlinkSync(lock_path);
      } catch {
      }
      throw error;
    }
    return async () => {
      gateway.stop();
      if (retry !== void 0) clearInterval(retry);
      outbox?.stop_queue();
      await lease.release_lease();
      try {
        if (!remote_state && readFileSync3(lock_path, "utf8").trim() === String(process.pid)) unlinkSync(lock_path);
      } catch {
      }
      probe("lifecycle", "qq.gateway.stop", {});
    };
  });
}
export {
  Config,
  apply,
  inject,
  name
};
