var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};

// backend/packages/webhook/webhook-weixin/src/media/mediaTranscoder.ts
var mediaTranscoder_exports = {};
__export(mediaTranscoder_exports, {
  transcode_silk_to_wav: () => transcode_silk_to_wav
});
function pcm_to_wav(pcm, sample_rate) {
  const result = Buffer.alloc(44 + pcm.byteLength);
  result.write("RIFF", 0);
  result.writeUInt32LE(result.length - 8, 4);
  result.write("WAVE", 8);
  result.write("fmt ", 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sample_rate, 24);
  result.writeUInt32LE(sample_rate * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36);
  result.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm).copy(result, 44);
  return result;
}
async function transcode_silk_to_wav(data, sample_rate = 24e3) {
  try {
    const decoder = await import("silk-wasm");
    const decoded = await decoder.decode(data, sample_rate);
    return { data: pcm_to_wav(decoded.data, sample_rate), mime_type: "audio/wav", transcoded: true };
  } catch {
    return { data, mime_type: "audio/silk", transcoded: false };
  }
}
var init_mediaTranscoder = __esm({
  "backend/packages/webhook/webhook-weixin/src/media/mediaTranscoder.ts"() {
  }
});

// backend/packages/webhook/webhook-weixin/src/api/ilinkClient.ts
import { createHash, randomBytes, createCipheriv } from "node:crypto";
import { join } from "node:path";

// backend/packages/webhook/webhook-weixin/src/diagnostics/probe.ts
import { appendFile } from "node:fs/promises";
import { ObservationRecorder } from "@deepseek-ai/dsh-llm";
function probe_path() {
  const path = process.env.DSH_WEIXIN_PROBE_LOG;
  return path !== void 0 && path.length > 0 ? path : void 0;
}
function probe_enabled() {
  return probe_path() !== void 0;
}
function probe(scope, event, fields) {
  const path = probe_path();
  if (path === void 0) return;
  const session_id = typeof fields?.session_id === "string" ? fields.session_id : void 0;
  const trace = typeof fields?.outbound_id === "string" ? ObservationRecorder.outbound_context(fields.outbound_id) : session_id === void 0 ? void 0 : typeof fields?.turn === "number" ? ObservationRecorder.turn_context(session_id, fields.turn) : ObservationRecorder.current(session_id);
  if (trace && !event.startsWith("poll.")) {
    ObservationRecorder.emit({
      traceId: trace.traceId,
      parentSpanId: trace.spanId,
      sessionId: session_id,
      kind: "transport",
      phase: "event",
      name: `${scope}.${event}`,
      deliveryId: fields?.delivery_id,
      outboxId: fields?.outbound_id,
      outcome: fields?.outcome,
      durationMs: fields?.duration_ms
    });
  }
  const record = {
    at: (/* @__PURE__ */ new Date()).toISOString(),
    scope,
    event,
    ...fields === void 0 ? {} : { data: sanitize(fields) }
  };
  void appendFile(path, JSON.stringify(record) + "\n", "utf8").catch(() => void 0);
}
function probe_timer(scope, event, fields) {
  const started = Date.now();
  return (extra) => probe(scope, event, { ...fields, ...extra, duration_ms: Date.now() - started });
}
function sanitize(value, depth = 0) {
  if (typeof value === "string") return value.length > 400 ? value.slice(0, 400) + `\u2026(+${value.length - 400})` : value;
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === void 0) return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((item) => sanitize(item, depth + 1));
    return value.length > 20 ? [...head, `\u2026(+${value.length - 20})`] : head;
  }
  if (typeof value === "object") {
    if (depth > 3) return "[deep]";
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = sanitize(item, depth + 1);
    return out;
  }
  return String(value);
}

// backend/packages/webhook/webhook-weixin/src/media/mediaCrypto.ts
import { createDecipheriv } from "node:crypto";
function parse_aes_key(value) {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 16) return decoded;
  const text = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(text)) return Buffer.from(text, "hex");
  throw new Error(`invalid iLink AES key length: ${decoded.length}`);
}
function decrypt_aes_ecb(data, key) {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(Buffer.from(data)), decipher.final()]);
}

// backend/packages/webhook/webhook-weixin/src/api/ilinkClient.ts
var ILINK_APP_ID = process.env.WEIXIN_ILINK_APP_ID?.trim() || "bot";
var ILINK_APP_CLIENT_VERSION = process.env.WEIXIN_ILINK_APP_VERSION?.trim() || "132105";
function token_marker_path() {
  return process.env.DSH_WEIXIN_TOKEN_MARKER ?? join(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? ".", ".dsh"), "weixin-token-invalid.flag");
}
function mark_token_invalid(reason) {
  const path = token_marker_path();
  void import("node:fs/promises").then(async (fs) => {
    const stat = await fs.stat(path).catch(() => void 0);
    if (stat !== void 0 && Date.now() - stat.mtimeMs < 6e4) return;
    await fs.appendFile(path, `${(/* @__PURE__ */ new Date()).toISOString()} ${reason}
`, "utf8");
  }).catch(() => void 0);
}
function clear_token_invalid() {
  void import("node:fs/promises").then((fs) => fs.unlink(token_marker_path())).catch(() => void 0);
}
var IlinkClient = class {
  options;
  fetch_impl;
  wechat_uin;
  /** 使用协议配置创建客户端；token 只保存在进程内。 */
  constructor(options) {
    if (!options.base_url || !options.token) throw new Error("iLink base_url and token are required");
    this.options = {
      ...options,
      base_url: options.base_url.replace(/\/$/, ""),
      token: options.token,
      timeout_ms: options.timeout_ms ?? 15e3,
      long_poll_timeout_ms: options.long_poll_timeout_ms ?? 35e3
    };
    this.fetch_impl = options.fetch_impl ?? fetch;
    this.wechat_uin = options.random_uin ?? Buffer.from(randomBytes(4)).toString("base64");
  }
  /** 执行一次 getUpdates 长轮询；外部 signal 可立即取消请求。 */
  async get_updates(cursor, signal) {
    return this.post_json("ilink/bot/getupdates", {
      get_updates_buf: cursor,
      base_info: this.base_info()
    }, this.options.long_poll_timeout_ms, signal);
  }
  /** 向一个微信用户发送单条文本消息。 */
  async send_message(input, signal) {
    const response = await this.post_json("ilink/bot/sendmessage", {
      msg: {
        from_user_id: "",
        to_user_id: input.to_user_id,
        client_id: input.client_id ?? `dsh-${Date.now()}`,
        ...input.context_token === void 0 ? {} : { context_token: input.context_token },
        message_type: 2,
        message_state: 2,
        item_list: input.item_list ?? (input.text ? [{ type: 1, text_item: { text: input.text } }] : []),
        ...input.run_id === void 0 ? {} : { run_id: input.run_id }
      },
      base_info: this.base_info()
    }, this.options.timeout_ms, signal);
    if (response.ret !== void 0 && response.ret !== 0) {
      const rate_limited = response.ret === -2;
      const effective_items = (input.item_list ?? (input.text ? [1] : [])).length;
      if (response.errcode === -14) mark_token_invalid(response.errmsg ?? "session timeout");
      const shown = input.context_token === void 0 ? "none" : `${input.context_token.slice(0, 12)}\u2026${input.context_token.slice(-8)}`;
      if (rate_limited) {
        probe("outbound", "send.rejected", {
          ret: response.ret,
          errmsg: response.errmsg,
          app_id: ILINK_APP_ID,
          app_client_version: ILINK_APP_CLIENT_VERSION,
          has_context_token: input.context_token !== void 0,
          context_token_hash: input.context_token === void 0 ? void 0 : createHash("sha256").update(input.context_token).digest("hex").slice(0, 12),
          token_hash: createHash("sha256").update(this.options.token).digest("hex").slice(0, 12),
          items: effective_items,
          text_len: (input.text ?? "").length
        });
      }
      const error = new Error(`iLink sendMessage failed: ${response.errmsg ?? response.ret} (ret=${response.ret}, errcode=${response.errcode ?? "-"}, items=${effective_items}, len=${(input.text ?? "").length}, token=${shown})`);
      error.retryable = rate_limited || response.ret >= 500 || response.ret === 429;
      error.rate_limited = rate_limited;
      throw error;
    }
    clear_token_invalid();
  }
  /** 以稳定 client_id 有限重试发送，避免瞬时网络错误导致回复丢失。 */
  async send_message_with_retry(input, signal) {
    const attempts = Math.max(1, (this.options.send_retry_count ?? 2) + 1);
    const client_id = input.client_id ?? `dsh-${Date.now()}-${randomBytes(6).toString("hex")}`;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await this.send_message({ ...input, client_id }, signal);
        return;
      } catch (error) {
        const rate_limited = error?.rate_limited === true;
        const retryable = !rate_limited && !(error && typeof error === "object" && "retryable" in error && error.retryable === false);
        if (!retryable || signal?.aborted || error instanceof Error && error.name === "AbortError" || attempt === attempts - 1) throw error;
        const delay = Math.max(0, this.options.send_retry_delay_ms ?? 250) * 2 ** attempt;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delay);
          const on_abort = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("aborted"));
          };
          signal?.addEventListener("abort", on_abort, { once: true });
        });
      }
    }
  }
  /** 通知微信连接器开始工作。 */
  async notify_start(signal) {
    await this.post_json("ilink/bot/msg/notifystart", { base_info: this.base_info() }, this.options.timeout_ms, signal);
  }
  /** 通知微信连接器停止工作。 */
  async notify_stop(signal) {
    await this.post_json("ilink/bot/msg/notifystop", { base_info: this.base_info() }, this.options.timeout_ms, signal);
  }
  /** 下载并解密一个媒体引用；无完整 URL 时要求调用方提供 CDN URL。 */
  async download_media(media, signal) {
    const url = media.full_url ?? (media.encrypt_query_param && this.options.cdn_base_url ? `${this.options.cdn_base_url.replace(/\/$/, "")}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}` : void 0);
    if (!url) throw new Error("iLink media full_url or cdn_base_url/encrypt_query_param is required");
    const response = await this.fetch_impl(url, signal === void 0 ? {} : { signal });
    if (!response.ok) throw new Error(`iLink media download failed: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return media.aes_key ? decrypt_aes_ecb(bytes, parse_aes_key(media.aes_key)) : bytes;
  }
  /** 获取微信 CDN 媒体上传地址，参数与官方 getuploadurl 协议一致。 */
  async get_upload_url(input, signal) {
    return this.post_json("ilink/bot/getuploadurl", {
      ...input,
      base_info: this.base_info()
    }, this.options.timeout_ms, signal);
  }
  /** 使用官方 AES-ECB 上传链路上传媒体并返回发送所需 CDN 引用。 */
  async upload_media(input, signal) {
    const raw = Buffer.from(input.data);
    const key = randomBytes(16);
    const filekey = randomBytes(16).toString("hex");
    const encrypted = this.encrypt_aes_ecb(raw, key);
    const request = {
      filekey,
      media_type: input.media_type,
      to_user_id: input.to_user_id,
      rawsize: raw.length,
      rawfilemd5: createHash("md5").update(raw).digest("hex"),
      filesize: encrypted.length,
      no_need_thumb: true,
      aeskey: key.toString("hex")
    };
    const result = await this.get_upload_url(request, signal);
    const upload_url = result.upload_full_url ?? (result.upload_param && this.options.cdn_base_url ? `${this.options.cdn_base_url.replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(result.upload_param)}&filekey=${encodeURIComponent(filekey)}` : void 0);
    if (!upload_url) throw new Error("iLink getuploadurl returned no upload URL");
    const uploaded = await this.fetch_impl(upload_url, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(encrypted),
      ...signal === void 0 ? {} : { signal }
    });
    if (!uploaded.ok) throw new Error(`iLink CDN upload failed: ${uploaded.status}`);
    const encrypted_query_param = uploaded.headers.get("x-encrypted-param");
    if (!encrypted_query_param) throw new Error("iLink CDN upload missing x-encrypted-param");
    return { filekey, encrypted_query_param, aes_key: key.toString("base64"), rawsize: raw.length, filesize: encrypted.length };
  }
  /** 上传并回传一张图片；文本说明会作为独立 item 一并发送。 */
  async send_image(input, signal) {
    const uploaded = await this.upload_media({ data: input.data, to_user_id: input.to_user_id, media_type: 1 }, signal);
    const item_list = [];
    if (input.caption) item_list.push({ type: 1, text_item: { text: input.caption } });
    item_list.push({
      type: 2,
      image_item: {
        media: { encrypt_query_param: uploaded.encrypted_query_param, aes_key: uploaded.aes_key, encrypt_type: 1 },
        mid_size: uploaded.filesize
      }
    });
    await this.send_message({ to_user_id: input.to_user_id, text: "", ...input.context_token === void 0 ? {} : { context_token: input.context_token }, item_list }, signal);
  }
  /** 返回协议所需的脱敏基础信息。 */
  base_info() {
    return { channel_version: this.options.channel_version ?? "dsh-webhook-weixin", bot_agent: this.options.bot_agent ?? "DeepSeekHarness" };
  }
  /** 发起带超时、Bearer Token 和 base_info 的 JSON POST。 */
  async post_json(endpoint, body, timeout_ms, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    const on_abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", on_abort, { once: true });
    try {
      const response = await this.fetch_impl(`${this.options.base_url}/${endpoint}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.options.token}`,
          AuthorizationType: "ilink_bot_token",
          "X-WECHAT-UIN": this.wechat_uin,
          // 官方客户端身份头：缺失会导致 sendMessage 被判 prepare failed。
          "iLink-App-Id": ILINK_APP_ID,
          "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`iLink ${endpoint} failed: HTTP ${response.status}`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", on_abort);
    }
  }
  /** 使用 PKCS#7 填充执行 AES-128-ECB 加密。 */
  encrypt_aes_ecb(data, key) {
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
    return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
  }
};

// backend/packages/webhook/webhook-weixin/src/index.ts
init_mediaTranscoder();

// backend/packages/webhook/webhook-weixin/src/message/messageNormalizer.ts
var MAX_MEDIA_BYTES = Number(process.env.DSH_WEIXIN_MAX_MEDIA_BYTES ?? String(20 * 1024 * 1024));
var MessageNormalizer = class {
  /** 规范化消息并生成稳定 delivery id。 */
  normalize_message(message) {
    const user_id = message.from_user_id ?? "";
    if (!user_id) throw new Error("iLink message has no from_user_id");
    const items = message.item_list ?? [];
    const text_parts = [];
    const media = [];
    for (const item of items) this.normalize_item(item, text_parts, media);
    const delivery_id = String(message.message_id ?? message.seq ?? `${user_id}:${message.create_time_ms ?? Date.now()}`);
    return {
      delivery_id,
      user_id,
      ...message.context_token === void 0 ? {} : { context_token: message.context_token },
      text: text_parts.join("\n").trim(),
      media,
      received_at: message.create_time_ms ?? Date.now()
    };
  }
  /** 下载并填充消息中的媒体字节；语音已有文本时不触发下载或 ASR。 */
  async hydrate_media(message, loader) {
    for (const media of message.media) {
      if (media.data || !media.media || media.kind === "voice" && media.source_text !== "voice_media_requires_asr") continue;
      const declared = media.media.rawsize ?? media.media.filesize;
      if (typeof declared === "number" && declared > MAX_MEDIA_BYTES) {
        media.source_text = `\u5A92\u4F53\u8FC7\u5927\u5DF2\u8DF3\u8FC7\uFF08${Math.round(declared / 1024 / 1024)}MB > \u4E0A\u9650 ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB\uFF09`;
        continue;
      }
      media.data = await loader(media.media);
      if (media.data.length > MAX_MEDIA_BYTES) {
        delete media.data;
        media.source_text = `\u5A92\u4F53\u8FC7\u5927\u5DF2\u8DF3\u8FC7\uFF08>${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB\uFF09`;
        continue;
      }
      if (media.kind === "voice") {
        media.raw_data = media.data;
        const { transcode_silk_to_wav: transcode_silk_to_wav2 } = await Promise.resolve().then(() => (init_mediaTranscoder(), mediaTranscoder_exports));
        const converted = await transcode_silk_to_wav2(media.data);
        media.data = converted.data;
        media.mime_type = converted.mime_type;
        media.transcoded = converted.transcoded;
      }
      if (media.kind === "image" && media.mime_type === void 0) media.mime_type = "image/jpeg";
    }
    return message;
  }
  /** 解析一个消息项，保证 voice_item.text 优先于语音媒体。 */
  normalize_item(item, text_parts, media) {
    if (item.type === 1 && item.text_item?.text !== void 0) text_parts.push(item.text_item.text);
    if (item.type === 2 && item.image_item) media.push({ kind: "image", mime_type: "image/jpeg", name: "weixin-image.jpg", media: { ...item.image_item.media, ...item.image_item.aeskey === void 0 ? {} : { aes_key: Buffer.from(item.image_item.aeskey, "hex").toString("base64") } } });
    if (item.type === 3 && item.voice_item) {
      if (item.voice_item.text) text_parts.push(item.voice_item.text);
      else media.push({ kind: "voice", mime_type: "audio/silk", source_text: "voice_media_requires_asr", ...item.voice_item.media === void 0 ? {} : { media: item.voice_item.media } });
    }
    if (item.type === 4 && item.file_item) media.push({ kind: "file", ...item.file_item.file_name === void 0 ? {} : { name: item.file_item.file_name }, mime_type: "application/octet-stream", ...item.file_item.media === void 0 ? {} : { media: item.file_item.media } });
  }
};

// backend/packages/webhook/webhook-weixin/src/types/domain.ts
function is_cursor_committable(status) {
  return status === "injected" || status === "control_applied" || status === "failed_terminal";
}

// backend/packages/webhook/webhook-weixin/src/state/weixinStateStore.ts
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join as join2 } from "node:path";
var STATE_SCHEMA_VERSION = 3;
var INFLIGHT_TURN_PREFIX = "inflight_turn:";
var WeixinStateStore = class {
  db;
  storeDir;
  closed = false;
  /** 打开（或创建）状态库并校验 schema。 */
  constructor(options) {
    const create = options.create ?? true;
    this.storeDir = dirname(options.path);
    if (!create && !existsSync(options.path)) {
      throw new Error(`weixin state store \u4E0D\u5B58\u5728\u4E14\u4E0D\u5141\u8BB8\u521B\u5EFA\uFF1A${options.path}`);
    }
    mkdirSync(dirname(options.path), { recursive: true });
    const done = probe_timer("state", "store.open", { path: options.path });
    this.db = new DatabaseSync(options.path);
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      try {
        this.db.close();
      } catch {
      }
      this.closed = true;
      throw error;
    }
    done();
  }
  /** 建表 + schema 校验；不匹配则 fail closed。 */
  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transport_cursor (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cursor TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS route (
        user_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery (
        delivery_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        injected_at INTEGER,
        last_error TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        context_token TEXT,
        payload_json TEXT
      );
      CREATE INDEX IF NOT EXISTS delivery_status_idx ON delivery (status, received_at);
      CREATE TABLE IF NOT EXISTS outbox (
        outbound_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        turn INTEGER,
        sequence INTEGER NOT NULL,
        kind TEXT NOT NULL,
        text TEXT NOT NULL,
        context_token TEXT,
        client_id TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        next_retry_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        sent_at INTEGER,
        sent_parts_json TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS outbox_queue_idx ON outbox (status, session_id, sequence);
      CREATE TABLE IF NOT EXISTS turn_context (
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        delivery_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        context_token TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (session_id, turn)
      );
      CREATE TABLE IF NOT EXISTS consumer_lease (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        owner_id TEXT NOT NULL,
        pid INTEGER NOT NULL,
        process_started_at INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
    `);
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version");
    if (row === void 0) {
      this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schema_version", String(STATE_SCHEMA_VERSION));
      return;
    }
    const found = Number(row.value);
    if (found === STATE_SCHEMA_VERSION) return;
    if (found >= 1 && found < STATE_SCHEMA_VERSION) {
      const delivery_columns = this.column_names("delivery");
      if (!delivery_columns.includes("context_token")) {
        this.db.exec("ALTER TABLE delivery ADD COLUMN context_token TEXT");
      }
      if (!delivery_columns.includes("payload_json")) {
        this.db.exec("ALTER TABLE delivery ADD COLUMN payload_json TEXT");
      }
      const outbox_columns = this.column_names("outbox");
      if (!outbox_columns.includes("sent_parts_json")) {
        this.db.exec("ALTER TABLE outbox ADD COLUMN sent_parts_json TEXT NOT NULL DEFAULT '[]'");
      }
      this.db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(String(STATE_SCHEMA_VERSION), "schema_version");
      probe("state", "schema.migrated", { from: found, to: STATE_SCHEMA_VERSION });
      return;
    }
    throw new Error(
      `weixin state store schema \u7248\u672C\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${STATE_SCHEMA_VERSION}\uFF0C\u5B9E\u9645 ${found}\u3002\u62D2\u7EDD\u81EA\u52A8\u8FC1\u79FB\u6216\u6E05\u7A7A\uFF0C\u8BF7\u4EBA\u5DE5\u5904\u7406\u540E\u518D\u542F\u52A8\u3002`
    );
  }
  /** 读取某张表的列名集合；用于幂等的前向迁移。 */
  column_names(table) {
    return this.db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
  }
  /** 关闭数据库；幂等。 */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
  // ── 事务 ────────────────────────────────────────────────────────────────
  /**
   * 在一个事务里执行；抛错自动回滚并向上传播。
   * 这是"一个事实一个权威写入者"的实现手段：相关状态要么一起成功，要么一起不生效。
   */
  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      probe("state", "transaction.rollback", { error: String(error) });
      throw error;
    }
  }
  // ── transport cursor ────────────────────────────────────────────────────
  /** 读取当前 getUpdates 游标。 */
  get_cursor() {
    const row = this.db.prepare("SELECT cursor FROM transport_cursor WHERE id = 1").get();
    return row?.cursor ?? "";
  }
  /** 提交游标；失败抛错（调用方不得把未落盘当作已提交）。 */
  set_cursor(cursor) {
    this.db.prepare(
      "INSERT INTO transport_cursor (id, cursor, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at"
    ).run(cursor, Date.now());
    probe("state", "cursor.committed", { cursor_len: cursor.length });
  }
  // ── meta（键值，存 Codex thread 等） ─────────────────────────────────────
  /** 读一个 meta 键。 */
  get_meta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value;
  }
  /** 写一个 meta 键。 */
  set_meta(key, value) {
    this.db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, value);
  }
  /** 按前缀列出 meta 键值（启动时找"进行中的轮次"标记用）。 */
  list_meta_prefix(prefix) {
    return this.db.prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key").all(`${prefix}%`);
  }
  /** 删除一个 meta 键（不存在也算成功）。 */
  delete_meta(key) {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  }
  // ── route ───────────────────────────────────────────────────────────────
  /**
   * 共享会话的基名（用户要求"微信和 QQ 单聊聊同一段"时启用）。
   *
   * 开关：环境变量 `DSH_SESSION_SHARED` 非空；基名存在 `$DSH_HOME/shared-session.txt`
   * （清空上下文后代次会变，文件也会被改写，QQ 侧每次读它以保证两边同一个会话）。
   * 未启用时返回空串，行为与以前完全一致。
   */
  shared_base() {
    if ((process.env.DSH_SESSION_SHARED ?? "").trim() === "") return "";
    try {
      const text = readFileSync(join2(this.storeDir, "shared-session.txt"), "utf8");
      return (text.split("\n")[0] ?? "").trim().replace(/-c\d+$/, "") || "main";
    } catch {
      return "main";
    }
  }
  /** 把共享会话当前 id 写回文件（只在变化时写），让 QQ 通道跟着走。 */
  persist_shared(id) {
    try {
      const file = join2(this.storeDir, "shared-session.txt");
      const current = existsSync(file) ? (readFileSync(file, "utf8").split("\n")[0] ?? "").trim() : "";
      if (current !== id) writeFileSync(file, `${id}
`, "utf8");
    } catch {
    }
  }
  /** 读取 user → session 路由。 */
  get_session_id(user_id) {
    if (this.shared_base() !== "") return this.session_id_for(user_id);
    const row = this.db.prepare("SELECT session_id FROM route WHERE user_id = ?").get(user_id);
    return row?.session_id;
  }
  /**
   * 清空出站队列：删掉所有**未终态**的行（待发 / 发送中 / 停放待问）。
   *
   * 用"删"而不是"标记失败"：队列的用途只是"还没发出去的东西"，
   * 清空之后 `bridge_results` 里也不会再翻出这些旧内容——这才是用户要的"清空队列"。
   * 已发送（sent）与明确失败（failed_terminal）的历史不动，它们只是记录。
   *
   * @returns 删掉的条数。
   */
  clear_queue() {
    const result = this.db.prepare(
      "DELETE FROM outbox WHERE status IN ('pending', 'sending', 'failed_retryable')"
    ).run();
    const removed = Number(result.changes ?? 0);
    probe("state", "outbox.cleared", { removed });
    return removed;
  }
  /**
   * 某个用户当前应使用的会话 id（把上下文代次编进去）。
   *
   * 代次 0（从没清空过）就用 `weixin-<user>`，保持历史数据不变；
   * 清空过就用 `weixin-<user>-c<epoch>`——换名字是为了**让新会话不与旧文件重名**，
   * 这样即便旧文件没删掉，也一定会新建一个空上下文的会话。
   */
  session_id_for(user_id) {
    const base = this.shared_base();
    if (base !== "") {
      const epoch2 = this.context_epoch(user_id);
      const id = epoch2 <= 0 ? base : `${base}-c${epoch2}`;
      this.persist_shared(id);
      return id;
    }
    const epoch = this.context_epoch(user_id);
    return epoch <= 0 ? `weixin-${user_id}` : `weixin-${user_id}-c${epoch}`;
  }
  /**
   * 删除 user → session 路由（清空上下文用）。
   *
   * 删掉后下一条消息会走"新建会话"分支，于是拿到一个**全新**的会话（空上下文）。
   * 只删路由是不够的——旧会话文件还在原地，所以必须配合"换一个会话 id"（见 epoch），
   * 否则新建时会撞上已存在的同名会话、又恢复回旧上下文。
   */
  clear_session_id(user_id) {
    this.db.prepare("DELETE FROM route WHERE user_id = ?").run(user_id);
    probe("state", "route.cleared", { user_id });
  }
  /**
   * 上下文代次（epoch）：同一用户名下第几段会话。
   *
   * 每次"清空上下文"就 +1，于是新会话 id 变成 `weixin-<user>` 之外的另一个名字，
   * 不会与旧会话文件重名。**这样即使旧文件删不掉（路径推导失败/被占用），
   * 上下文也一定是干净的**——文件删除只是顺手回收磁盘。
   */
  context_epoch(user_id) {
    const raw = this.get_meta(`context_epoch:${user_id}`);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  /** 上下文代次 +1，返回新值。 */
  bump_context_epoch(user_id) {
    const next = this.context_epoch(user_id) + 1;
    this.set_meta(`context_epoch:${user_id}`, String(next));
    probe("state", "context.epoch_bumped", { user_id, epoch: next });
    return next;
  }
  /** 写入 user → session 路由。 */
  set_session_id(user_id, session_id) {
    this.db.prepare(
      "INSERT INTO route (user_id, session_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET session_id = excluded.session_id, updated_at = excluded.updated_at"
    ).run(user_id, session_id, Date.now());
    probe("state", "route.bound", { user_id, session_id });
  }
  /** 列出所有有路由的微信用户（主动推送时要知道推给谁）。 */
  list_users() {
    const rows = this.db.prepare("SELECT user_id FROM route ORDER BY updated_at DESC").all();
    return rows.map((row) => row.user_id);
  }
  /** 统计路由条数与会话数（装配检查/诊断用）。 */
  route_summary() {
    const row = this.db.prepare("SELECT COUNT(*) AS users, COUNT(DISTINCT session_id) AS sessions FROM route").get();
    return { users: row?.users ?? 0, sessions: row?.sessions ?? 0 };
  }
  // ── delivery ────────────────────────────────────────────────────────────
  /**
   * 幂等登记一条 delivery。
   * @returns `true` 表示首次登记（应继续处理）；`false` 表示此前已登记（重复投递）。
   * 注意：这里只登记接收事实，**不代表已注入会话**；cursor 提交仍取决于后续状态。
   */
  put_delivery_if_absent(record) {
    const existing = this.db.prepare("SELECT delivery_id FROM delivery WHERE delivery_id = ?").get(record.delivery_id);
    if (existing !== void 0) {
      probe("state", "delivery.duplicate", { delivery_id: record.delivery_id, user_id: record.user_id });
      return false;
    }
    this.db.prepare(
      "INSERT INTO delivery (delivery_id, user_id, status, received_at, attempt, context_token, payload_json) VALUES (?, ?, ?, ?, 0, ?, ?)"
    ).run(
      record.delivery_id,
      record.user_id,
      "received",
      record.received_at,
      record.context_token ?? null,
      record.payload_json ?? null
    );
    probe("state", "delivery.received", {
      delivery_id: record.delivery_id,
      user_id: record.user_id,
      has_context_token: record.context_token !== void 0
    });
    return true;
  }
  /** 最近一条入站消息的用户；调试注入口在未指定 user_id 时用它作为默认收件人。 */
  latest_user_id() {
    const row = this.db.prepare(
      "SELECT user_id FROM delivery ORDER BY received_at DESC LIMIT 1"
    ).get();
    return row?.user_id;
  }
  /** 读取某条 delivery 的 context_token（回复时必须用它）。 */
  delivery_context_token(delivery_id) {
    const row = this.db.prepare("SELECT context_token FROM delivery WHERE delivery_id = ?").get(delivery_id);
    return row?.context_token ?? void 0;
  }
  /** 读取一条 delivery。 */
  get_delivery(delivery_id) {
    const row = this.db.prepare("SELECT * FROM delivery WHERE delivery_id = ?").get(delivery_id);
    return row === void 0 ? void 0 : to_delivery(row);
  }
  /**
   * 更新 delivery 状态（CAS：可指定期望的当前状态）。
   *
   * attempt 只统计**实际处理失败**的次数，不由状态迁移本身消耗：
   * `received → routing → injected` 是正常流转，不应该吃掉重试预算；
   * 只有重试与终态失败才传 `increment_attempt: true`。
   */
  update_delivery(delivery_id, status, fields) {
    const current = this.get_delivery(delivery_id);
    if (current === void 0) throw new Error(`delivery \u4E0D\u5B58\u5728\uFF1A${delivery_id}`);
    if (fields?.expect !== void 0 && current.status !== fields.expect) {
      probe("state", "delivery.cas_miss", {
        delivery_id,
        expected: fields.expect,
        actual: current.status
      });
      return false;
    }
    const result = this.db.prepare(
      "UPDATE delivery SET status = ?, session_id = COALESCE(?, session_id), injected_at = COALESCE(?, injected_at), last_error = ?, attempt = attempt + ? WHERE delivery_id = ? AND status = ?"
    ).run(
      status,
      fields?.session_id ?? null,
      fields?.injected_at ?? null,
      fields?.last_error ?? null,
      fields?.increment_attempt === true ? 1 : 0,
      delivery_id,
      fields?.expect ?? current.status
    );
    if (result.changes === 0) return false;
    probe("state", "delivery.status", {
      delivery_id,
      from: current.status,
      to: status,
      attempt: current.attempt + (fields?.increment_attempt === true ? 1 : 0)
    });
    return true;
  }
  /** 列出未完成（需要恢复）的 delivery。 */
  list_unfinished_deliveries(limit = 200) {
    const rows = this.db.prepare(
      "SELECT * FROM delivery WHERE status IN ('received','routing','failed_retryable') ORDER BY received_at LIMIT ?"
    ).all(limit);
    return rows.map(to_delivery);
  }
  /** 批次内 delivery 是否都达到可提交 cursor 的状态。 */
  batch_committable(delivery_ids) {
    if (delivery_ids.length === 0) return true;
    const placeholders = delivery_ids.map(() => "?").join(",");
    const row = this.db.prepare(
      `SELECT COUNT(*) AS pending FROM delivery WHERE delivery_id IN (${placeholders}) AND status NOT IN ('injected','control_applied','failed_terminal')`
    ).get(...delivery_ids);
    return (row?.pending ?? 0) === 0;
  }
  // ── outbox ──────────────────────────────────────────────────────────────
  /**
   * 入队一条出站消息；sequence 在同一 Session 内单调递增（由本方法分配）。
   * @returns 落库后的完整记录（含分配的 sequence）。
   */
  enqueue_outbox(input) {
    return this.transaction(() => {
      const row = this.db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS last FROM outbox WHERE session_id = ?"
      ).get(input.session_id);
      const sequence = (row?.last ?? 0) + 1;
      const outbound_id = `${input.session_id}:${sequence}`;
      const client_id = input.client_id ?? `dsh-${input.session_id}-${sequence}-${Date.now().toString(36)}`;
      const created_at = Date.now();
      this.db.prepare(
        "INSERT INTO outbox (outbound_id, session_id, user_id, turn, sequence, kind, text, context_token, client_id, status, attempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
      ).run(
        outbound_id,
        input.session_id,
        input.user_id,
        input.turn ?? null,
        sequence,
        input.kind,
        input.text,
        input.context_token ?? null,
        client_id,
        "pending",
        created_at
      );
      probe("state", "outbox.enqueued", {
        outbound_id,
        session_id: input.session_id,
        kind: input.kind,
        sequence,
        text_len: input.text.length
      });
      return {
        outbound_id,
        session_id: input.session_id,
        user_id: input.user_id,
        ...input.turn === void 0 ? {} : { turn: input.turn },
        sequence,
        kind: input.kind,
        text: input.text,
        ...input.context_token === void 0 ? {} : { context_token: input.context_token },
        client_id,
        status: "pending",
        attempt: 0,
        created_at
      };
    });
  }
  /**
   * 取出某 Session 中下一条可发送记录（pending 或到时间的 failed_retryable）。
   *
   * **优先级**：`turn` 非空的是"针对某一轮的正式回复"，`turn` 为空的是通知类
   * （codex/opencode 完成汇报、进度、心跳）。平台对短时发送条数有限额，通知量一大
   * 就会把正式回复挤到窗口外，所以回复一律排在通知前面。
   */
  next_outbox(session_id, now = Date.now()) {
    const row = this.db.prepare(
      "SELECT * FROM outbox WHERE session_id = ? AND (status = 'pending' OR (status = 'failed_retryable' AND (next_retry_at IS NULL OR next_retry_at <= ?))) ORDER BY (turn IS NULL), sequence LIMIT 1"
    ).get(session_id, now);
    return row === void 0 ? void 0 : to_outbox(row);
  }
  /** 列出所有会话中待处理的下一条（用于跨会话并发发送）。 */
  next_outbox_per_session(now = Date.now()) {
    const rows = this.db.prepare(
      "SELECT * FROM outbox WHERE status = 'pending' OR (status = 'failed_retryable' AND (next_retry_at IS NULL OR next_retry_at <= ?)) ORDER BY session_id, (turn IS NULL), sequence"
    ).all(now);
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const row of rows) {
      if (seen.has(row.session_id)) continue;
      seen.add(row.session_id);
      result.push(to_outbox(row));
    }
    return result;
  }
  /** 标记发送中；失败抛错。 */
  mark_outbox_sending(outbound_id) {
    this.db.prepare("UPDATE outbox SET status = 'sending', attempt = attempt + 1 WHERE outbound_id = ?").run(outbound_id);
    probe("state", "outbox.sending", { outbound_id });
  }
  /**
   * 列出"已停放、尚未送达"的处理结果（通知类），供工具按需取回。
   *
   * 场景：codex/opencode 任务做完了，但用户此时不在微信里（会话窗口关闭），
   * 平台不允许推送。这些结果**停放在队列里保留一段时间**，等用户主动问起时由工具返回，
   * 而不是反复重试（重试必然失败，还会拖慢真实回复）。
   */
  parked_results(limit = 20) {
    return this.db.prepare(
      "SELECT outbound_id, sequence, text, created_at FROM outbox WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') ORDER BY sequence LIMIT ?"
    ).all(limit);
  }
  /** 丢弃超过保留期的停放结果（默认 6 小时），避免长期堆积。 */
  prune_parked_results(max_age_ms, now = Date.now()) {
    const removed = this.db.prepare(
      "DELETE FROM outbox WHERE turn IS NULL AND status IN ('pending','failed_retryable','failed_terminal') AND created_at < ?"
    ).run(now - max_age_ms).changes;
    if (removed > 0) probe("state", "parked.pruned", { removed, max_age_ms });
    return Number(removed);
  }
  /**
   * 每个会话最多保留多少条**待发通知**（turn 为空）。
   *
   * 通知类消息（任务完成汇报、进度）时效性很强，积压后往往已经没意义，
   * 而且会占用平台的发送限额、把正式回复挤掉——所以超出上限时**丢最旧的**。
   */
  trim_pending_notices(session_id, keep = 3) {
    const removed = this.db.prepare(
      "DELETE FROM outbox WHERE outbound_id IN (  SELECT outbound_id FROM outbox WHERE session_id = ? AND status = 'pending' AND turn IS NULL   ORDER BY sequence DESC LIMIT -1 OFFSET ?)"
    ).run(session_id, keep).changes;
    if (removed > 0) probe("state", "outbox.notices_trimmed", { session_id, removed, keep });
    return Number(removed);
  }
  /**
   * 记录某一分段已成功送达（立即落盘）。
   *
   * 必须在每段发送成功后马上写，而不是整条发完再写：否则进程在中间崩溃，
   * 重启后会从头重发，用户收到重复内容。
   */
  mark_outbox_part_sent(outbound_id, index) {
    const row = this.db.prepare("SELECT sent_parts_json FROM outbox WHERE outbound_id = ?").get(outbound_id);
    if (row === void 0) return;
    const parts = parse_sent_parts(row.sent_parts_json);
    if (parts.includes(index)) return;
    parts.push(index);
    parts.sort((a, b) => a - b);
    this.db.prepare("UPDATE outbox SET sent_parts_json = ? WHERE outbound_id = ?").run(JSON.stringify(parts), outbound_id);
    probe("state", "outbox.part_sent", { outbound_id, index, parts: parts.length });
  }
  /** 标记已发送。 */
  mark_outbox_sent(outbound_id) {
    this.db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, last_error = NULL WHERE outbound_id = ?").run(Date.now(), outbound_id);
    probe("state", "outbox.sent", { outbound_id });
  }
  /** 标记失败（可重试/终态），并给出下次重试时间。 */
  mark_outbox_failed(outbound_id, status, error, next_retry_at) {
    this.db.prepare("UPDATE outbox SET status = ?, last_error = ?, next_retry_at = ? WHERE outbound_id = ?").run(status, error, next_retry_at ?? null, outbound_id);
    probe("state", "outbox.failed", { outbound_id, status, error });
  }
  /** 读取一条 outbox 记录。 */
  get_outbox(outbound_id) {
    const row = this.db.prepare("SELECT * FROM outbox WHERE outbound_id = ?").get(outbound_id);
    return row === void 0 ? void 0 : to_outbox(row);
  }
  /** 列出未发送完成的记录（恢复用）。 */
  list_pending_outbox(limit = 500) {
    const rows = this.db.prepare(
      "SELECT * FROM outbox WHERE status IN ('pending','sending','failed_retryable') ORDER BY session_id, sequence LIMIT ?"
    ).all(limit);
    return rows.map(to_outbox);
  }
  // ── turn context ────────────────────────────────────────────────────────
  /** 绑定 `session_id + turn` → delivery/context_token（设计文档 §7.1）。 */
  bind_turn_context(input) {
    this.db.prepare(
      "INSERT INTO turn_context (session_id, turn, delivery_id, user_id, context_token, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, turn) DO UPDATE SET delivery_id = excluded.delivery_id, user_id = excluded.user_id, context_token = excluded.context_token"
    ).run(input.session_id, input.turn, input.delivery_id, input.user_id, input.context_token ?? null, Date.now());
    probe("state", "turn_context.bound", {
      session_id: input.session_id,
      turn: input.turn,
      delivery_id: input.delivery_id,
      has_token: input.context_token !== void 0
    });
  }
  /** 读取某 turn 的上下文绑定。 */
  get_turn_context(session_id, turn) {
    const row = this.db.prepare("SELECT * FROM turn_context WHERE session_id = ? AND turn = ?").get(session_id, turn);
    if (row === void 0) return void 0;
    return {
      delivery_id: row.delivery_id,
      user_id: row.user_id,
      ...row.context_token === null ? {} : { context_token: row.context_token }
    };
  }
  /** 最近一条 delivery → session 绑定（重启后补 turn context 用）。 */
  latest_delivery_for_session(session_id) {
    const row = this.db.prepare(
      "SELECT * FROM delivery WHERE session_id = ? AND status IN ('injected','control_applied') ORDER BY received_at DESC LIMIT 1"
    ).get(session_id);
    return row === void 0 ? void 0 : to_delivery(row);
  }
  /** 清理过期的 turn_context（保留最近 N 个 turn）。 */
  prune_turn_context(session_id, keep = 20) {
    this.db.prepare(
      "DELETE FROM turn_context WHERE session_id = ? AND turn NOT IN (SELECT turn FROM turn_context WHERE session_id = ? ORDER BY turn DESC LIMIT ?)"
    ).run(session_id, session_id, keep);
  }
  // ── lease ───────────────────────────────────────────────────────────────
  /** 读取当前 lease（若有）。`process_started_at` 用于识别 pid 被回收的情况。 */
  get_lease() {
    const row = this.db.prepare(
      "SELECT owner_id, pid, heartbeat_at, account_id, process_started_at FROM consumer_lease WHERE id = 1"
    ).get();
    return row;
  }
  /**
   * 原子获取 lease：主键唯一 + UPDATE ... WHERE 条件保证只有一个进程成功。
   * @returns true 表示获取成功。
   */
  try_acquire_lease(input) {
    const now = Date.now();
    return this.transaction(() => {
      const existing = this.get_lease();
      if (existing !== void 0) {
        const alive = lease_holder_alive(existing.pid, existing.process_started_at);
        if (alive) {
          probe("state", "lease.busy", { held_by: existing.owner_id, pid: existing.pid, age_ms: now - existing.heartbeat_at });
          return false;
        }
        probe("state", "lease.takeover", {
          held_by: existing.owner_id,
          pid: existing.pid,
          pid_alive: alive,
          age_ms: now - existing.heartbeat_at,
          reason: alive ? "stale" : "holder_dead"
        });
      }
      this.db.prepare(
        "INSERT INTO consumer_lease (id, owner_id, pid, process_started_at, account_id, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, pid = excluded.pid, process_started_at = excluded.process_started_at, account_id = excluded.account_id, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at"
      ).run(input.owner_id, input.pid, input.process_started_at, input.account_id, now, now);
      probe("state", "lease.acquired", { owner_id: input.owner_id, pid: input.pid, account_id: input.account_id });
      return true;
    });
  }
  /** 续租；只有持有者能续。 */
  heartbeat_lease(owner_id) {
    const row = this.db.prepare("SELECT owner_id FROM consumer_lease WHERE id = 1").get();
    if (row === void 0 || row.owner_id !== owner_id) return false;
    this.db.prepare("UPDATE consumer_lease SET heartbeat_at = ? WHERE id = 1").run(Date.now());
    return true;
  }
  /** 释放 lease；只有持有者能释放。 */
  release_lease(owner_id) {
    this.db.prepare("DELETE FROM consumer_lease WHERE id = 1 AND owner_id = ?").run(owner_id);
    probe("state", "lease.released", { owner_id });
  }
  /** 诊断快照：各状态计数，供启动日志与探针使用。 */
  snapshot() {
    const count = (sql) => {
      const row = this.db.prepare(sql).get();
      return row?.n ?? 0;
    };
    return {
      cursor_len: this.get_cursor().length,
      routes: this.route_summary(),
      delivery: {
        received: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'received'"),
        injected: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'injected'"),
        control_applied: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'control_applied'"),
        failed_retryable: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_retryable'"),
        failed_terminal: count("SELECT COUNT(*) AS n FROM delivery WHERE status = 'failed_terminal'")
      },
      outbox: {
        pending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'"),
        sending: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sending'"),
        sent: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'sent'"),
        failed_retryable: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_retryable'"),
        failed_terminal: count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'failed_terminal'")
      },
      lease: this.get_lease() ?? null
    };
  }
};
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
      const parsed = Number(out.trim());
      return Number.isFinite(parsed) && parsed > 0 ? parsed : void 0;
    }
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks)) return void 0;
    const bootTime = readFileSync("/proc/stat", "utf8").split("\n").find((line) => line.startsWith("btime "))?.split(" ")[1];
    const uptimeSeconds = Number(bootTime);
    if (!Number.isFinite(uptimeSeconds)) return void 0;
    return (uptimeSeconds + startTicks / 100) * 1e3;
  } catch {
    return void 0;
  }
}
function lease_holder_alive(pid, recorded_started_at) {
  if (!is_pid_alive(pid)) return false;
  const actual = process_started_at(pid);
  if (actual === void 0) return true;
  return Math.abs(actual - recorded_started_at) <= 6e4;
}
function to_delivery(row) {
  return {
    delivery_id: row.delivery_id,
    user_id: row.user_id,
    ...row.session_id === null ? {} : { session_id: row.session_id },
    status: row.status,
    received_at: row.received_at,
    ...row.injected_at === null ? {} : { injected_at: row.injected_at },
    ...row.last_error === null ? {} : { last_error: row.last_error },
    attempt: row.attempt,
    ...row.context_token === null ? {} : { context_token: row.context_token },
    ...row.payload_json === null ? {} : { payload_json: row.payload_json }
  };
}
function to_outbox(row) {
  return {
    outbound_id: row.outbound_id,
    session_id: row.session_id,
    user_id: row.user_id,
    ...row.turn === null ? {} : { turn: row.turn },
    sequence: row.sequence,
    kind: row.kind,
    text: row.text,
    ...row.context_token === null ? {} : { context_token: row.context_token },
    client_id: row.client_id,
    status: row.status,
    attempt: row.attempt,
    ...row.next_retry_at === null ? {} : { next_retry_at: row.next_retry_at },
    ...row.last_error === null ? {} : { last_error: row.last_error },
    created_at: row.created_at,
    ...row.sent_at === null ? {} : { sent_at: row.sent_at },
    sent_parts: parse_sent_parts(row.sent_parts_json)
  };
}
function parse_sent_parts(raw) {
  if (raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => typeof item === "number");
  } catch {
    return [];
  }
}

// backend/packages/webhook/webhook-weixin/src/state/turnContextStore.ts
var TurnContextStore = class {
  store;
  /** 绑定到状态库。 */
  constructor(store) {
    this.store = store;
  }
  /** 绑定 `session_id + turn`；同 turn 重复绑定会覆盖为最新。 */
  bind(session_id, turn, context) {
    this.store.bind_turn_context({
      session_id,
      turn,
      delivery_id: context.delivery_id,
      user_id: context.user_id,
      ...context.context_token === void 0 ? {} : { context_token: context.context_token }
    });
  }
  /** 读取 turn 上下文；未绑定返回 undefined（回复层应回退到最近一条，而不是别的 turn 的 token）。 */
  get(session_id, turn) {
    return this.store.get_turn_context(session_id, turn);
  }
  /**
   * 仅在**尚未绑定**时写入（first-wins）。
   *
   * 这是修复"同一 turn 的回复上下文被后续消息覆盖"的关键原语：
   * 长任务期间用户再发消息时，那条消息属于下一个 turn，
   * 绝不能改写本轮回复应当使用的 delivery / context_token。
   *
   * @returns true = 本次完成绑定；false = 已存在绑定，保持原值不变。
   */
  bind_if_absent(session_id, turn, context) {
    if (this.get(session_id, turn) !== void 0) {
      probe("turn-context", "bind.skipped_exists", { session_id, turn, delivery_id: context.delivery_id });
      return false;
    }
    this.bind(session_id, turn, context);
    return true;
  }
  /**
   * 解析用于回复的上下文：
   * 1. 优先精确命中 `session_id + turn`；
   * 2. 未命中（重启/历史 turn）时回退到该会话最近一条已注入的 delivery；
   * 3. 仍无则返回 undefined —— 此时必须**无 token 发送**或报错，绝不复用其它 turn 的 token。
   */
  resolve(session_id, turn) {
    const exact = this.get(session_id, turn);
    if (exact !== void 0) return exact;
    const fallback = this.store.latest_delivery_for_session(session_id);
    if (fallback === void 0) {
      probe("turn-context", "resolve.miss", { session_id, turn });
      return void 0;
    }
    probe("turn-context", "resolve.fallback", {
      session_id,
      turn,
      delivery_id: fallback.delivery_id,
      received_at: fallback.received_at,
      has_context_token: fallback.context_token !== void 0
    });
    return {
      delivery_id: fallback.delivery_id,
      user_id: fallback.user_id,
      ...fallback.context_token === void 0 ? {} : { context_token: fallback.context_token }
    };
  }
  /**
   * 该会话最近一次可用的回复上下文（含 context_token）；没有则 undefined。
   *
   * 给"不针对某一轮"的消息（通知/进度）用：它们没有自己的 turn，
   * 但带上最近的 token 才有机会在会话窗口开着时送达。
   */
  latest(session_id) {
    const fallback = this.store.latest_delivery_for_session(session_id);
    if (fallback === void 0) return void 0;
    return {
      delivery_id: fallback.delivery_id,
      user_id: fallback.user_id,
      ...fallback.context_token === void 0 ? {} : { context_token: fallback.context_token }
    };
  }
  /**
   * 该会话最近一次的 context_token，**但只在它足够新鲜时才返回**。
   *
   * 为什么需要"新鲜度"判断：token 会过期，而**过期 token 的发送必然被拒**。
   * 实测教训：给通知类无脑带上"最近一次 token"后，旧 token 被拒 →
   * 被误当成真限流 → 全局熔断冻结整条链路（10 小时发不出消息）。
   * 所以这里只在新入站刚发生（会话窗口还开着）时才带 token，否则宁可不带。
   *
   * @param session_id - 会话。
   * @param max_age_ms - 允许多旧，默认 10 分钟。
   */
  latest_token_if_fresh(session_id, max_age_ms = 10 * 6e4) {
    const fallback = this.store.latest_delivery_for_session(session_id);
    if (fallback?.context_token === void 0) return void 0;
    return Date.now() - fallback.received_at <= max_age_ms ? fallback.context_token : void 0;
  }
  /**
   * 异步解析精确轮次上下文；本地 SQLite 会立即完成，远程端口会等待 HTTP 结果。
   * 远程出站协调器必须使用这个入口，不能读取同步方法的 Promise。
   */
  async resolve_async(session_id, turn) {
    const exact = await this.store.get_turn_context(session_id, turn);
    if (exact !== void 0) return exact;
    const fallback = await this.store.latest_delivery_for_session(session_id);
    if (fallback === void 0) {
      probe("turn-context", "resolve.miss", { session_id, turn });
      return void 0;
    }
    return {
      delivery_id: fallback.delivery_id,
      user_id: fallback.user_id,
      ...fallback.context_token === void 0 ? {} : { context_token: fallback.context_token }
    };
  }
  /** 异步读取新鲜 token，兼容本地和远程状态端口。 */
  async latest_token_if_fresh_async(session_id, max_age_ms = 10 * 6e4) {
    const fallback = await this.store.latest_delivery_for_session(session_id);
    if (fallback === void 0 || Date.now() - fallback.received_at > max_age_ms) return void 0;
    return fallback.context_token;
  }
  /** 异步绑定轮次上下文。 */
  async bind_async(session_id, turn, context) {
    await this.store.bind_turn_context({
      session_id,
      turn,
      delivery_id: context.delivery_id,
      user_id: context.user_id,
      ...context.context_token === void 0 ? {} : { context_token: context.context_token }
    });
  }
  /** 异步清理旧轮次上下文。 */
  async prune_async(session_id, keep = 20) {
    await this.store.prune_turn_context(session_id, keep);
  }
  /** 一轮结束后清理历史，避免表无限增长。 */
  prune(session_id, keep = 20) {
    this.store.prune_turn_context(session_id, keep);
  }
};

// backend/packages/webhook/webhook-weixin/src/state/migrateLegacyRouteState.ts
import { copyFileSync, existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
function migrate_legacy_route_state(store, legacy_path) {
  if (!existsSync2(legacy_path)) {
    return { migrated: false, reason: "legacy_absent", sessions: 0, deliveries: 0, cursor: false };
  }
  const existing = store.route_summary();
  if (existing.users > 0 || store.get_cursor().length > 0) {
    probe("state", "migrate.skip", { reason: "target_not_empty", users: existing.users });
    return { migrated: false, reason: "target_not_empty", sessions: 0, deliveries: 0, cursor: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(legacy_path, "utf8"));
  } catch (error) {
    probe("state", "migrate.failed", { error: String(error) });
    throw new Error(
      `\u65E7\u8DEF\u7531\u72B6\u6001\u65E0\u6CD5\u89E3\u6790\uFF0C\u62D2\u7EDD\u4ECE\u7A7A\u72B6\u6001\u542F\u52A8\uFF08fail closed\uFF09\uFF1A${legacy_path} \u2014\u2014 ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const snapshot = `${legacy_path}.migrated-${Date.now()}`;
  try {
    copyFileSync(legacy_path, snapshot);
  } catch (error) {
    probe("state", "migrate.snapshot_failed", { error: String(error) });
  }
  const sessions = Object.entries(parsed.sessions ?? {});
  const deliveries = parsed.deliveries ?? [];
  store.transaction(() => {
    for (const [user_id, session_id] of sessions) store.set_session_id(user_id, session_id);
    for (const delivery_id of deliveries) {
      const user_id = sessions.find(([, sid]) => sid !== void 0)?.[0] ?? "legacy";
      if (store.put_delivery_if_absent({ delivery_id, user_id, received_at: Date.now() })) {
        store.update_delivery(delivery_id, "injected", { injected_at: Date.now(), session_id: user_id });
      }
    }
    if (parsed.cursor) store.set_cursor(parsed.cursor);
  });
  const result = {
    migrated: true,
    reason: "migrated",
    sessions: sessions.length,
    deliveries: deliveries.length,
    cursor: Boolean(parsed.cursor)
  };
  probe("state", "migrate.done", { ...result });
  console.error(`[webhook-weixin] \u5DF2\u8FC1\u79FB\u65E7\u8DEF\u7531\u72B6\u6001\uFF1A\u8DEF\u7531 ${result.sessions} \u6761\u3001\u53BB\u91CD ${result.deliveries} \u6761\u3001\u6E38\u6807 ${result.cursor ? "\u6709" : "\u65E0"}\uFF1B\u65E7\u6587\u4EF6\u4FDD\u7559\u5728 ${legacy_path}`);
  return result;
}

// backend/packages/webhook/webhook-weixin/src/transport/weixinIngress.ts
var WeixinIngress = class {
  normalizer = new MessageNormalizer();
  client;
  observer;
  /** 绑定协议客户端与观察器。 */
  constructor(options) {
    this.client = options.client;
    this.observer = options.observer ?? {};
  }
  /** 通知服务端消费者上线；失败抛出，由协调器决定是否致命。 */
  async notify_start(signal) {
    await this.client.notify_start(signal);
    probe("ingress", "notify_start.ok");
  }
  /** 通知服务端消费者下线；尽力而为。 */
  async notify_stop(signal) {
    try {
      await this.client.notify_stop(signal);
      probe("ingress", "notify_stop.ok");
    } catch (error) {
      probe("ingress", "notify_stop.failed", { error: String(error) });
    }
  }
  /**
   * 执行一轮长轮询并规范化消息。
   *
   * 分类而非抛错：把"可继续"（超时/网络抖动）与"必须停止"（鉴权失效/未知协议）
   * 明确区分，交给协调器按设计文档 §10.2 处理，避免无限重试风暴。
   */
  async poll(cursor, signal) {
    let response;
    try {
      response = await this.client.get_updates(cursor, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const aborted = error instanceof Error && error.name === "AbortError";
      if (aborted) {
        probe("ingress", "poll.long_poll_timeout");
        return { kind: "session_timeout" };
      }
      probe("ingress", "poll.network_error", { error: String(error) });
      this.observer.on_error?.(error);
      return { kind: "protocol_error", detail: error instanceof Error ? error.message : String(error) };
    }
    const errmsg = response.errmsg?.toLowerCase() ?? "";
    if (errmsg.includes("session timeout")) {
      probe("ingress", "poll.session_timeout");
      return { kind: "session_timeout" };
    }
    const ret = response.ret ?? 0;
    const errcode = response.errcode ?? 0;
    if (ret !== 0 || errcode !== 0) {
      const detail = response.errmsg ?? String(ret !== 0 ? ret : errcode);
      if (ret === 401 || ret === 403 || errcode === 401 || errcode === 403 || /token|auth|unauthor|login|expired/i.test(detail)) {
        probe("ingress", "poll.auth_required", { ret, errcode, detail });
        this.observer.on_status?.("auth_required", detail);
        return { kind: "auth_required", detail };
      }
      probe("ingress", "poll.protocol_error", { ret, errcode, detail });
      this.observer.on_error?.(new Error(`iLink getUpdates failed: ${detail}`));
      return { kind: "protocol_error", detail };
    }
    const raw = response.msgs ?? [];
    const cursor_next = response.get_updates_buf;
    if (raw.length === 0) {
      probe("ingress", "poll.idle");
      return { kind: "idle", cursor: cursor_next };
    }
    const messages = raw.map((message) => this.normalizer.normalize_message(message));
    probe("ingress", "poll.messages", {
      count: messages.length,
      users: [...new Set(messages.map((m) => m.user_id))],
      delivery_ids: messages.map((m) => m.delivery_id)
    });
    return { kind: "messages", messages, cursor: cursor_next };
  }
  /** 下载媒体（供协调器的分片调度调用，不阻塞轮询）。 */
  async download_media(media) {
    return this.client.download_media(media);
  }
  /** 暴露规范化器的媒体补全能力，供协调器在分片任务中使用。 */
  get media_normalizer() {
    return this.normalizer;
  }
};

// backend/packages/webhook/webhook-weixin/src/coordination/inboundCoordinator.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import { defineTool } from "@deepseek-ai/dsh-tools";
function serialize_payload(message) {
  return JSON.stringify({
    delivery_id: message.delivery_id,
    user_id: message.user_id,
    ...message.context_token === void 0 ? {} : { context_token: message.context_token },
    text: message.text,
    received_at: message.received_at,
    media: message.media.map((item) => ({
      kind: item.kind,
      ...item.name === void 0 ? {} : { name: item.name },
      ...item.mime_type === void 0 ? {} : { mime_type: item.mime_type },
      ...item.source_text === void 0 ? {} : { source_text: item.source_text },
      ...item.media === void 0 ? {} : { media: item.media }
    }))
  });
}
function deserialize_payload(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.delivery_id !== "string" || typeof parsed.user_id !== "string") return void 0;
    return {
      delivery_id: parsed.delivery_id,
      user_id: parsed.user_id,
      ...parsed.context_token === void 0 ? {} : { context_token: parsed.context_token },
      text: typeof parsed.text === "string" ? parsed.text : "",
      media: Array.isArray(parsed.media) ? parsed.media : [],
      received_at: typeof parsed.received_at === "number" ? parsed.received_at : Date.now()
    };
  } catch {
    return void 0;
  }
}
function merge_messages(messages) {
  const last = messages[messages.length - 1];
  const first = messages[0];
  const text = messages.map((item) => item.text.trim()).filter((item) => item !== "").join("\n");
  const media = messages.flatMap((item) => [...item.media]);
  return {
    ...last,
    // 用第一条的 delivery_id 作代表（它是最早那条，日志里好追）
    delivery_id: first.delivery_id,
    text,
    media,
    received_at: last.received_at
  };
}
var PENDING_MEDIA_LIMIT = 20;
var COALESCE_MS = Number(process.env.DSH_WEIXIN_COALESCE_MS ?? "6000");
var MEDIA_TIMEOUT_MS = Number(process.env.DSH_WEIXIN_MEDIA_TIMEOUT_MS ?? "120000");
var MAX_DELIVERY_ATTEMPTS = Number(process.env.DSH_WEIXIN_DELIVERY_MAX_ATTEMPTS ?? "3");
var MAX_SHARD_DEPTH = Number(process.env.DSH_WEIXIN_MAX_INBOUND_DEPTH ?? "30");
var CANCEL_CLEARS_PENDING = true;
var CANCEL_COMMANDS = /* @__PURE__ */ new Set(["\u505C\u6B62", "\u53D6\u6D88", "\u4E2D\u65AD", "\u522B\u505A\u4E86", "\u505C\u4E0B", "stop", "cancel", "abort", "\u4E2D\u65AD\u4EFB\u52A1", "\u505C\u6B62\u4EFB\u52A1"]);
var CANCEL_KEEP_COMMANDS = /* @__PURE__ */ new Set(["\u505C\u6B62\u5F53\u524D\u4F46\u4FDD\u7559\u961F\u5217", "\u53D6\u6D88\u5F53\u524D\u4F46\u4FDD\u7559\u961F\u5217", "stop-keep-queue"]);
var STEER_PREFIXES = ["\u63D2\u8BDD\uFF1A", "\u63D2\u8BDD:", "\u8865\u5145\uFF1A", "\u8865\u5145:", "\u7EA0\u6B63\uFF1A", "\u7EA0\u6B63:", "steer:", "steer\uFF1A"];
var STATUS_COMMANDS = /* @__PURE__ */ new Set(["\u72B6\u6001", "status"]);
function parse_control_command(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (CANCEL_COMMANDS.has(lower)) return { kind: "cancel_current", clear_pending: CANCEL_CLEARS_PENDING };
  if (CANCEL_KEEP_COMMANDS.has(lower)) return { kind: "cancel_current", clear_pending: false };
  if (STATUS_COMMANDS.has(lower)) return { kind: "status" };
  for (const prefix of STEER_PREFIXES) {
    if (lower.startsWith(prefix.toLowerCase())) {
      const rest = trimmed.slice(prefix.length).trim();
      if (rest.length > 0) return { kind: "steer_current", text: rest };
    }
  }
  return void 0;
}
var InboundCoordinator = class {
  /** 绑定状态库与宿主。 */
  constructor(options) {
    this.options = options;
  }
  disposed = false;
  shards = /* @__PURE__ */ new Map();
  pending_media = /* @__PURE__ */ new Map();
  /** 各用户最近一次 context_token（媒体被动回复要用） */
  latest_token = /* @__PURE__ */ new Map();
  /**
   * 同一个人连续发的消息先攒着，静默 COALESCE_MS 之后**合并成一条**喂给模型。
   *
   * 为什么要攒：人是断续打的（"在吗" → "帮我看看" → "那个文件"），逐条喂会得到三次回答，
   * 又慢又吵；合并成一次提问，模型也更容易答到点上。控制命令（`/codex`、`/opencode`）
   * 与纯媒体消息**不缓冲**，立刻处理。
   */
  coalesced = /* @__PURE__ */ new Map();
  /** 合并窗口内最近一次收到消息的时间（用于日志里的"等了多久"）。 */
  coalesced_last_at = /* @__PURE__ */ new Map();
  /** delivery 成功注入后记录的 `delivery_id → session_id`，供 outbox 绑定使用。 */
  delivery_sessions = /* @__PURE__ */ new Map();
  /** 暴露 delivery → session 映射（outbox 需要）。 */
  session_for_delivery(delivery_id) {
    return this.delivery_sessions.get(delivery_id);
  }
  /**
   * 处理一个批次：逐条登记 + 分片投递，最后按"全部达到终态"决定是否提交 cursor。
   *
   * @param messages - 本批消息
   * @param cursor - 平台游标
   * @param options.hold - true 时**只登记不投递**（压缩上下文期间用）：
   *   delivery 停在 `received` 且 payload 已落库，压缩结束后由 `recover_unfinished()` 重投。
   *   此时故意不返回可提交，让游标保持未提交、消息不会丢。
   * @returns 是否允许提交该批次 cursor。
   */
  async handle_batch(messages, cursor = void 0, options) {
    const done = probe_timer("inbound", "batch.start", {
      count: messages.length,
      has_cursor: cursor !== void 0,
      hold: options?.hold === true
    });
    const tasks = [];
    for (const message of messages) {
      const put_result = this.options.store.put_delivery_if_absent({
        delivery_id: message.delivery_id,
        user_id: message.user_id,
        received_at: message.received_at,
        // 回复必须用本条消息的 context_token，所以从入站就把它持久化下来。
        ...message.context_token === void 0 ? {} : { context_token: message.context_token },
        // 落一份可恢复的入站事实：崩溃后据此重新注入，而不是假定"已喂给模型"。
        payload_json: serialize_payload(message)
      });
      const first = put_result instanceof Promise ? await put_result : put_result;
      if (!first) {
        probe("inbound", "batch.skip_duplicate", { delivery_id: message.delivery_id });
        const duplicate = this.options.store.get_delivery(message.delivery_id);
        const duplicate_record = duplicate instanceof Promise ? await duplicate : duplicate;
        if (duplicate_record?.status === "failed_retryable") {
          tasks.push(this.enqueue_for_user(message));
        }
        continue;
      }
      const route_result = this.options.store.get_session_id(message.user_id);
      const route = route_result instanceof Promise ? await route_result : route_result;
      const recorded = this.options.record_entry?.({
        id: message.delivery_id,
        ts: message.received_at,
        role: "user",
        text: message.text,
        user_id: message.user_id,
        ...route === void 0 ? {} : { session_id: route }
      });
      if (recorded !== void 0) await recorded;
      if (options?.hold === true) {
        probe("inbound", "batch.held", { delivery_id: message.delivery_id, user_id: message.user_id });
        continue;
      }
      tasks.push(this.enqueue_for_user(message));
    }
    const settled = await Promise.allSettled(tasks);
    const rejected = settled.filter((item) => item.status === "rejected").length;
    if (rejected > 0) probe("inbound", "batch.task_rejected", { rejected });
    const ids = messages.map((message) => message.delivery_id);
    const committable = await this.options.store.batch_committable(ids);
    done({ committable, rejected });
    return committable;
  }
  /** 把一条消息排进其所属用户的分片链；同用户严格保序，不同用户并发。 */
  async enqueue_for_user(message, run) {
    if (this.disposed) return Promise.resolve();
    const previous = this.shards.get(message.user_id) ?? { chain: Promise.resolve(), depth: 0 };
    if (previous.depth >= MAX_SHARD_DEPTH) {
      probe("inbound", "shard.overflow", {
        user_id: message.user_id,
        depth: previous.depth,
        limit: MAX_SHARD_DEPTH
      });
      const updated = this.options.store.update_delivery(message.delivery_id, "failed_terminal", {
        last_error: `\u5165\u7AD9\u961F\u5217\u8FC7\u6DF1\uFF08${previous.depth} \u2265 ${MAX_SHARD_DEPTH}\uFF09\uFF0C\u5DF2\u4E22\u5F03`,
        increment_attempt: true
      });
      if (updated instanceof Promise) await updated;
      const route = this.options.store.get_session_id(message.user_id);
      if (route instanceof Promise) {
        const session_id = await route ?? `weixin-${message.user_id}`;
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: "error",
          text: `\u6D88\u606F\u4E00\u4E0B\u6709\u70B9\u591A\u5566\uFF0C\u8FD9\u6761\u6211\u5148\u653E\u4E00\u653E\uFF08\u961F\u5217\u5DF2\u6EE1 ${MAX_SHARD_DEPTH} \u6761\uFF09\u{1F605} \u7A0D\u540E\u518D\u53D1\u4E00\u6B21\u597D\u5417\uFF1F`
        });
        return;
      }
      this.options.enqueue_outbound({
        session_id: route instanceof Promise ? `weixin-${message.user_id}` : route ?? `weixin-${message.user_id}`,
        user_id: message.user_id,
        kind: "error",
        text: `\u6D88\u606F\u4E00\u4E0B\u6709\u70B9\u591A\u5566\uFF0C\u8FD9\u6761\u6211\u5148\u653E\u4E00\u653E\uFF08\u961F\u5217\u5DF2\u6EE1 ${MAX_SHARD_DEPTH} \u6761\uFF09\u{1F605} \u7A0D\u540E\u518D\u53D1\u4E00\u6B21\u597D\u5417\uFF1F`
      });
      return;
    }
    const shard = { chain: previous.chain, depth: previous.depth + 1 };
    this.shards.set(message.user_id, shard);
    probe("inbound", "shard.enqueue", { user_id: message.user_id, depth: shard.depth });
    const task = shard.chain.then(async () => {
      await (run === void 0 ? this.process_message(message) : run());
    });
    shard.chain = task.catch((error) => {
      probe("inbound", "shard.task_failed", {
        user_id: message.user_id,
        delivery_id: message.delivery_id,
        error: String(error)
      });
    }).finally(() => {
      const current = this.shards.get(message.user_id);
      if (current !== void 0) {
        current.depth = Math.max(0, current.depth - 1);
        if (current.depth === 0) this.shards.delete(message.user_id);
      }
    });
    return task;
  }
  /** 处理单条消息：Codex 指令 / 控制命令 / 普通消息。 */
  async process_message(message) {
    if (this.options.hydrate_message !== void 0 && message.media.length > 0) {
      try {
        message = await this.options.hydrate_message(message);
      } catch (error) {
        probe("inbound", "media.hydrate_failed", {
          delivery_id: message.delivery_id,
          error: String(error)
        });
      }
    }
    const control = parse_control_command(message.text);
    try {
      const oc_command = this.options.opencode_bridge?.parse(message.text);
      if (oc_command !== void 0 && this.options.opencode_bridge !== void 0) {
        const session_id = await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`;
        await this.options.store.update_delivery(message.delivery_id, "control_applied", { injected_at: Date.now() });
        probe("inbound", "opencode.command", { delivery_id: message.delivery_id, action: oc_command.action });
        await this.options.opencode_bridge.handle(
          message.user_id,
          session_id,
          oc_command,
          message.context_token
        );
        return;
      }
      const codex_command = this.options.codex_bridge?.parse(message.text);
      if (codex_command !== void 0 && this.options.codex_bridge !== void 0) {
        const session_id = await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`;
        await this.options.store.update_delivery(message.delivery_id, "control_applied", { injected_at: Date.now() });
        probe("inbound", "codex.command", { delivery_id: message.delivery_id, action: codex_command.action });
        await this.options.codex_bridge.handle(
          message.user_id,
          session_id,
          codex_command,
          message.context_token
        );
        return;
      }
      if (control !== void 0) {
        await this.apply_control(message, control);
        return;
      }
      await this.coalesce_message(message);
    } catch (error) {
      await this.handle_message_failure(message, error);
    }
  }
  /** message 为原始投递，error 为处理异常；统一计次、记录原错并在达到上限时发送失败回执。 */
  async handle_message_failure(message, error) {
    if (this.disposed) return;
    const current = await this.options.store.get_delivery(message.delivery_id);
    if (current !== void 0 && is_cursor_committable(current.status)) return;
    const detail = error instanceof Error ? error.message : String(error);
    const attempt = ((await this.options.store.get_delivery(message.delivery_id))?.attempt ?? 0) + 1;
    if (attempt >= MAX_DELIVERY_ATTEMPTS) {
      await this.options.store.update_delivery(message.delivery_id, "failed_terminal", {
        last_error: detail,
        increment_attempt: true
      });
      probe("inbound", "message.failed_terminal", {
        delivery_id: message.delivery_id,
        attempt,
        error: detail
      });
      this.options.enqueue_outbound({
        session_id: await this.options.store.get_session_id(message.user_id) ?? `weixin-${message.user_id}`,
        user_id: message.user_id,
        kind: "error",
        text: "\uFF08\u8FD9\u6761\u6D88\u606F\u5904\u7406\u5931\u8D25\u4E86\uFF0C\u6211\u5DF2\u7ECF\u8BB0\u5F55\u4E0B\u6765\uFF1B\u8BF7\u7A0D\u540E\u518D\u53D1\u4E00\u6B21\u6216\u544A\u8BC9\u6211\u6362\u79CD\u8BF4\u6CD5\uFF09",
        ...message.context_token === void 0 ? {} : { context_token: message.context_token }
      });
      return;
    }
    await this.options.store.update_delivery(message.delivery_id, "failed_retryable", {
      last_error: detail,
      increment_attempt: true
    });
    probe("inbound", "message.failed", { delivery_id: message.delivery_id, attempt, error: detail });
  }
  /** 应用控制命令（幂等：delivery 已登记过就不会重复执行）。 */
  async apply_control(message, control) {
    const done = probe_timer("inbound", "control.apply", {
      delivery_id: message.delivery_id,
      user_id: message.user_id,
      command: control.kind
    });
    const session_id = await this.options.store.get_session_id(message.user_id);
    if (session_id === void 0) {
      await this.options.store.update_delivery(message.delivery_id, "control_applied");
      this.options.enqueue_outbound({
        session_id: `weixin-unrouted:${message.user_id}`,
        user_id: message.user_id,
        kind: "control_ack",
        text: "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u4EFB\u52A1\uFF09",
        ...message.context_token === void 0 ? {} : { context_token: message.context_token }
      });
      done({ outcome: "no_route" });
      return;
    }
    const agent = this.options.host.get_agent(brandString(session_id));
    if (agent === void 0) {
      await this.options.store.update_delivery(message.delivery_id, "control_applied");
      this.options.enqueue_outbound({
        session_id,
        user_id: message.user_id,
        kind: "control_ack",
        text: control.kind === "status" ? "\uFF08\u5F53\u524D\u7A7A\u95F2\uFF0C\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u4EFB\u52A1\uFF09" : "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u4EFB\u52A1\uFF09",
        ...message.context_token === void 0 ? {} : { context_token: message.context_token }
      });
      done({ outcome: "no_agent" });
      return;
    }
    if (control.kind === "cancel_current") {
      if (agent.status === "idle") {
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: "control_ack",
          text: "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u4EFB\u52A1\uFF09",
          ...message.context_token === void 0 ? {} : { context_token: message.context_token }
        });
      } else {
        agent.cancel({ kind: "user" }, { keepInbox: !control.clear_pending });
        await this.options.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
        this.options.on_turn_cancelled?.(session_id);
        const stopped = await this.options.on_cancel?.(message.user_id);
        const external = stopped === void 0 || stopped.killed === 0 ? "" : `\uFF0C\u5E76\u4E2D\u65AD\u4E86 ${stopped.killed} \u4E2A\u5916\u90E8\u4EFB\u52A1`;
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: "control_ack",
          text: `\uFF08\u5DF2\u53D6\u6D88\u5F53\u524D\u8FD9\u4E00\u8F6E${external}${control.clear_pending ? "\uFF0C\u6392\u961F\u6D88\u606F\u5DF2\u6E05\u7A7A" : "\uFF0C\u6392\u961F\u6D88\u606F\u4FDD\u7559"}\uFF09`,
          ...message.context_token === void 0 ? {} : { context_token: message.context_token }
        });
      }
    } else if (control.kind === "steer_current") {
      if (agent.status === "idle") {
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: "control_ack",
          text: "\uFF08\u6CA1\u6709\u6B63\u5728\u8FDB\u884C\u7684\u4EFB\u52A1\uFF0C\u63D2\u8BDD\u672A\u751F\u6548\uFF1B\u8BF7\u76F4\u63A5\u53D1\u6D88\u606F\uFF09",
          ...message.context_token === void 0 ? {} : { context_token: message.context_token }
        });
      } else {
        agent.steer(createUserMessage({
          content: [{ type: "text", text: control.text }],
          source: { kind: "plugin", plugin: "dsh-webhook-weixin", form: "notice", summary: "\u5FAE\u4FE1\u63D2\u8BDD" }
        }));
        this.options.enqueue_outbound({
          session_id,
          user_id: message.user_id,
          kind: "control_ack",
          text: "\uFF08\u5DF2\u628A\u4F60\u7684\u8865\u5145\u63D2\u8FDB\u5F53\u524D\u4EFB\u52A1\uFF09",
          ...message.context_token === void 0 ? {} : { context_token: message.context_token }
        });
      }
    } else {
      this.options.enqueue_outbound({
        session_id,
        user_id: message.user_id,
        kind: "control_ack",
        text: `\uFF08\u72B6\u6001\uFF1AAgent ${agent.status}\uFF09`,
        ...message.context_token === void 0 ? {} : { context_token: message.context_token }
      });
    }
    await this.options.store.update_delivery(message.delivery_id, "control_applied", {
      session_id,
      injected_at: Date.now()
    });
    done({ outcome: "applied", agent_status: agent.status });
  }
  /**
   * 普通消息入口：先攒进合并窗口，静默一段时间后一次性注入。
   *
   * 不缓冲的情况：
   * - 关闭了合并（COALESCE_MS = 0）；
   * - 只有媒体没有文字 —— 那种要等用户补文字，交给 `inject_message` 自己的媒体缓存逻辑。
   */
  async coalesce_message(message) {
    const text = message.text.trim();
    if (COALESCE_MS <= 0 || text === "" && message.media.length > 0) {
      await this.inject_message(message);
      return;
    }
    this.begin_routing(message.delivery_id);
    const existing = this.coalesced.get(message.user_id);
    if (existing !== void 0) clearTimeout(existing.timer);
    const messages = [...existing?.messages ?? [], message];
    const first_at = existing?.first_at ?? Date.now();
    const timer = setTimeout(() => {
      const task = this.enqueue_for_user(message, () => this.flush_coalesced(message.user_id));
      void task.catch((error) => probe("inbound", "coalesce.scheduler_failed", { error: String(error) }));
    }, COALESCE_MS);
    this.coalesced.set(message.user_id, { messages, timer, first_at });
    this.coalesced_last_at.set(message.user_id, Date.now());
    probe("inbound", "coalesce.buffered", {
      user_id: message.user_id,
      pending: messages.length,
      window_ms: COALESCE_MS
    });
  }
  /** 合并窗口到期：把攒下的消息并成一条注入（游标要等这条注入完才提交）。 */
  async flush_coalesced(user_id) {
    const bucket = this.coalesced.get(user_id);
    if (bucket === void 0) return;
    this.coalesced.delete(user_id);
    const waited = Date.now() - (this.coalesced_last_at.get(user_id) ?? Date.now());
    this.coalesced_last_at.delete(user_id);
    const merged = merge_messages(bucket.messages);
    const extras = bucket.messages.slice(1).map((item) => item.delivery_id);
    probe("inbound", "coalesce.flushed", {
      user_id,
      messages: bucket.messages.length,
      chars: merged.text.length,
      waited_ms: Date.now() - bucket.first_at,
      idle_ms: waited
    });
    try {
      await this.inject_message(merged, extras);
    } catch (error) {
      probe("inbound", "coalesce.inject_failed", { user_id, error: String(error) });
      for (const message of bucket.messages) await this.handle_message_failure(message, error);
    }
  }
  /** delivery_id 为已登记投递；复用既有 routing，只从明确可处理状态进入路由。 */
  async begin_routing(delivery_id) {
    const row = await this.options.store.get_delivery(delivery_id);
    if (row?.status === "routing") return;
    const status = row?.status ?? "received";
    if (status !== "received" && status !== "failed_retryable") throw new Error(`delivery \u4E0D\u53EF\u8DEF\u7531\uFF1A${status}`);
    const claimed = await this.options.store.update_delivery(delivery_id, "routing", { expect: status });
    if (claimed === false) {
      throw new Error("delivery \u72B6\u6001\u5DF2\u53D8\u66F4\uFF0C\u8DEF\u7531\u672A\u83B7\u5F97\u6240\u6709\u6743");
    }
  }
  /** 无参数；取消尚未到期的合并计时器，保留数据库载荷供下次恢复。 */
  async dispose() {
    this.disposed = true;
    for (const bucket of this.coalesced.values()) clearTimeout(bucket.timer);
    this.coalesced.clear();
    this.coalesced_last_at.clear();
    await Promise.allSettled([...this.shards.values()].map((shard) => shard.chain));
  }
  /** 普通消息：媒体 → Agent → followup → 标记 injected。 */
  async inject_message(message, also_mark = []) {
    if (this.disposed) return;
    const done = probe_timer("inbound", "message.inject", {
      delivery_id: message.delivery_id,
      user_id: message.user_id
    });
    await this.begin_routing(message.delivery_id);
    const text = message.text.trim();
    if (!text && message.media.length > 0) {
      const pending = this.pending_media.get(message.user_id) ?? [];
      pending.push(...message.media);
      while (pending.length > PENDING_MEDIA_LIMIT) pending.shift();
      this.pending_media.set(message.user_id, pending);
      await this.options.store.update_delivery(message.delivery_id, "control_applied", { injected_at: Date.now() });
      done({ outcome: "media_buffered", buffered: pending.length });
      return;
    }
    const buffered = this.pending_media.get(message.user_id);
    if (buffered !== void 0 && buffered.length > 0) this.pending_media.delete(message.user_id);
    const media = buffered === void 0 || buffered.length === 0 ? message.media : [...buffered, ...message.media];
    let session_id = await this.options.store.get_session_id(message.user_id);
    let agent;
    if (session_id !== void 0) {
      const branded = brandString(session_id);
      agent = this.options.host.get_agent(branded) ?? await this.options.host.resume_agent(branded);
    } else {
      session_id = await this.options.store.session_id_for(message.user_id);
      agent = await this.options.host.create_agent(brandString(session_id));
      await this.options.store.set_session_id(message.user_id, session_id);
    }
    const session_key = String(agent.id);
    if (this.disposed) return;
    this.options.on_agent_ready?.(agent);
    this.options.on_agent_bound?.(agent);
    if (message.context_token !== void 0) this.latest_token.set(message.user_id, message.context_token);
    if (this.options.send_media !== void 0) {
      const send_media = this.options.send_media;
      const latest_token = this.latest_token;
      const user_id = message.user_id;
      const media_tool = defineTool({
        name: "send_file",
        description: '\u628A\u672C\u5730\u56FE\u7247\u53D1\u5230\u5F53\u524D\u5FAE\u4FE1\u804A\u5929\uFF08\u53EA\u652F\u6301 jpg/png/gif/webp \u7B49\u56FE\u7247\uFF1B\u6587\u4EF6\u6682\u4E0D\u652F\u6301\uFF09\u3002\u7528\u6237\u8BF4"\u53D1\u6211""\u53D1\u8FC7\u6765""\u622A\u56FE\u7ED9\u6211"\u65F6\u7528\u5B83\u3002',
        parameters: {
          path: { type: "string", description: "\u672C\u5730\u56FE\u7247\u7EDD\u5BF9\u8DEF\u5F84" }
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
          try {
            await send_media(user_id, file, latest_token.get(user_id));
            return { ok: true, text: `\u5DF2\u53D1\u9001\uFF1A${file}` };
          } catch (error) {
            return { ok: false, text: `\u53D1\u9001\u5931\u8D25\uFF1A${String(error).slice(0, 160)}` };
          }
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
    }
    this.options.on_user_message?.(session_key, message.user_id, text);
    const content = await this.build_content(text, media);
    if (content.length === 0) content.push({ type: "text", text: "[\u5FAE\u4FE1\u7A7A\u6D88\u606F]" });
    const incoming = createUserMessage({
      content,
      source: { kind: "plugin", plugin: "dsh-webhook-weixin", form: "notice", summary: "\u5FAE\u4FE1\u6D88\u606F" }
    });
    if (this.disposed) return;
    const steering = agent.status !== "idle";
    if (steering) {
      agent.steer(incoming);
      probe("inbound", "message.steer", { delivery_id: message.delivery_id, session_id: session_key });
    } else {
      agent.followup(incoming);
    }
    this.delivery_sessions.set(message.delivery_id, session_key);
    await this.options.store.update_delivery(message.delivery_id, "injected", {
      session_id: session_key,
      injected_at: Date.now()
    });
    for (const delivery_id of also_mark) {
      this.delivery_sessions.set(delivery_id, session_key);
      await this.options.store.update_delivery(delivery_id, "injected", {
        session_id: session_key,
        injected_at: Date.now()
      });
    }
    done({ outcome: "injected", session_id: session_key, blocks: content.length, merged: also_mark.length });
  }
  /** 构造消息内容块；媒体下载失败降级为说明文本，不影响文字投递。 */
  async build_content(text, media) {
    const content = [];
    if (text) content.push({ type: "text", text });
    for (const item of media) {
      try {
        if (item.data && item.kind === "image" && this.options.attachments) {
          const media_type = item.mime_type === "image/png" || item.mime_type === "image/webp" || item.mime_type === "image/gif" ? item.mime_type : "image/jpeg";
          const attachment = await with_timeout(
            this.options.attachments.saveImage({ data: item.data, mediaType: media_type, ...item.name === void 0 ? {} : { name: item.name } }),
            MEDIA_TIMEOUT_MS,
            "saveImage"
          );
          content.push({ type: "image", attachment });
        } else if (item.data && item.kind === "file" && this.options.attachments?.saveFile) {
          const attachment = await with_timeout(
            this.options.attachments.saveFile({ data: item.data, ...item.name === void 0 ? {} : { name: item.name } }),
            MEDIA_TIMEOUT_MS,
            "saveFile"
          );
          content.push({ type: "file", attachment });
        } else {
          const note = `[\u5FAE\u4FE1\u5A92\u4F53 ${item.kind}${item.source_text ? `:${item.source_text}` : ""}]`;
          content.push({ type: "text", text: note });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        probe("inbound", "media.failed", { kind: item.kind, error: detail });
        content.push({ type: "text", text: `[\u5FAE\u4FE1\u5A92\u4F53 ${item.kind} \u5904\u7406\u5931\u8D25\uFF1A${detail}]` });
      }
    }
    return content;
  }
  /**
   * 恢复未完成的 delivery（设计文档 §5.2 的恢复协议）。
   *
   * 关键：**不能因为 delivery 已有 session_id 就把它标成 injected**。那样会掩盖这个窗口：
   * `delivery 已登记 → session_id 已写入 → agent.followup() 尚未执行 → 进程崩溃`。
   * 有 `payload_json` 的必须重新走一遍完整注入，成功才由 process_message 写 injected；
   * 失败则保持 failed_retryable，交给现有重试机制——绝不"假成功"地丢消息。
   */
  async recover_unfinished() {
    const unfinished = await this.options.store.list_unfinished_deliveries();
    let needs_reinject = 0;
    let reinjected = 0;
    for (const record of unfinished) {
      if (record.payload_json !== void 0) {
        const message = deserialize_payload(record.payload_json);
        if (message !== void 0) {
          needs_reinject += 1;
          probe("inbound", "recover.reinject", {
            delivery_id: record.delivery_id,
            user_id: record.user_id,
            from_status: record.status
          });
          await this.enqueue_for_user(message);
          reinjected += 1;
          continue;
        }
      }
      needs_reinject += 1;
      await this.options.store.update_delivery(record.delivery_id, "failed_terminal", {
        last_error: "\u65E0\u6CD5\u6062\u590D\uFF1A\u5165\u7AD9\u8F7D\u8377\u7F3A\u5931\uFF0C\u672A\u91CD\u65B0\u6267\u884C"
      });
    }
    probe("inbound", "recover.done", { unfinished: unfinished.length, needs_reinject, reinjected });
    return { recovered: unfinished.length, needs_reinject };
  }
  /** 该 delivery 是否可提交 cursor。 */
  is_committable(delivery_id) {
    const record = this.options.store.get_delivery(delivery_id);
    return record !== void 0 && is_cursor_committable(record.status);
  }
  /** 异步查询 delivery 是否可提交，供远程状态端口使用。 */
  async is_committable_async(delivery_id) {
    const record = await this.options.store.get_delivery(delivery_id);
    return record !== void 0 && is_cursor_committable(record.status);
  }
};
async function with_timeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} \u8D85\u65F6\uFF08${ms}ms\uFF09`)), ms);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}

// backend/packages/webhook/webhook-weixin/src/coordination/outboundCoordinator.ts
import { ObservationRecorder as ObservationRecorder2 } from "@deepseek-ai/dsh-llm";
var MAX_TEXT_CHARS = Number(process.env.DSH_WEIXIN_MAX_TEXT_CHARS ?? "1000");
function split_text(text, limit) {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const cut = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("\u3002"), window.lastIndexOf(" "));
    const at = cut > limit * 0.5 ? cut + 1 : limit;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest.length > 0) parts.push(rest);
  return parts;
}
var OutboundCoordinator = class {
  store;
  turn_context;
  sender;
  classify_retryable;
  /** 把"最终回复"记进长期记忆；由连接器注入，失败也不影响发送。 */
  record_entry;
  max_attempts;
  retry_base_ms;
  heartbeat_idle_ms;
  heartbeat_max_per_turn;
  send_min_gap_ms;
  send_batch_limit;
  /** 每个会话上次发送的时间，用于节流。 */
  last_send_at = /* @__PURE__ */ new Map();
  /** 全局上次发送时间：不同会话也压制一下总速率。 */
  last_send_any_at = 0;
  progress = /* @__PURE__ */ new Map();
  draining = false;
  stopped = false;
  /** 限流熔断：在此时间戳之前整条链路暂停发送（见 options.rate_limit_cooldown_ms）。 */
  paused_until = 0;
  /** 熔断期间唯一的唤醒定时器；避免并发 drain 累积出定时器/日志风暴。 */
  pause_timer;
  /** 上次打印 drain.paused 的时间；熔断期间按秒级降噪。 */
  pause_logged_at = 0;
  /** 连续限流次数，用于指数加大冷却；发送成功即清零。 */
  rate_limit_streak = 0;
  rate_limit_cooldown_ms;
  rate_limit_cooldown_max_ms;
  /** 无 context_token 的消息被拒后，推迟多久再试（默认 5 分钟）。 */
  no_token_defer_ms;
  /** 通知类结果停放多久（默认 6 小时）。 */
  parked_retention_ms;
  /** 绑定状态库与发送实现。 */
  constructor(options) {
    this.store = options.store;
    this.turn_context = options.turn_context;
    this.sender = options.sender;
    this.classify_retryable = options.classify_retryable;
    this.record_entry = options.record_entry;
    this.max_attempts = options.max_attempts ?? 5;
    this.retry_base_ms = options.retry_base_ms ?? 500;
    this.heartbeat_idle_ms = options.heartbeat_idle_ms ?? Number(process.env.DSH_WEIXIN_HEARTBEAT_IDLE_MS ?? "300000");
    this.heartbeat_max_per_turn = options.heartbeat_max_per_turn ?? 6;
    this.send_min_gap_ms = options.send_min_gap_ms ?? Number(process.env.DSH_WEIXIN_SEND_MIN_GAP_MS ?? "2200");
    this.send_batch_limit = options.send_batch_limit ?? Number(process.env.DSH_WEIXIN_SEND_BATCH_LIMIT ?? "3");
    this.rate_limit_cooldown_ms = options.rate_limit_cooldown_ms ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MS ?? "60000");
    this.rate_limit_cooldown_max_ms = options.rate_limit_cooldown_max_ms ?? Number(process.env.DSH_WEIXIN_RATE_LIMIT_COOLDOWN_MAX_MS ?? "600000");
    this.no_token_defer_ms = options.no_token_defer_ms ?? Number(process.env.DSH_WEIXIN_NO_TOKEN_DEFER_MS ?? "300000");
    this.parked_retention_ms = options.parked_retention_ms ?? Number(process.env.DSH_WEIXIN_PARKED_RETENTION_MS ?? "21600000");
  }
  // ── 入队 API（协调器调用） ─────────────────────────────────────────────
  /** 入队一条正式回复（转级上下文由 turn 决定）。 */
  enqueue_assistant(input) {
    if (!input.text.trim()) return;
    const context = this.turn_context.resolve(input.session_id, input.turn);
    const record = this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: context?.user_id ?? input.user_id,
      kind: "assistant",
      text: input.text,
      turn: input.turn,
      ...context?.context_token === void 0 ? {} : { context_token: context.context_token }
    });
    if (record instanceof Promise) {
      void record.then((value) => {
        ObservationRecorder2.bind_outbound(value.outbound_id, input.session_id, input.turn);
      });
      return;
    }
    ObservationRecorder2.bind_outbound(record.outbound_id, input.session_id, input.turn);
    void Promise.resolve(this.record_entry?.({
      id: record.outbound_id,
      ts: record.created_at,
      role: "assistant",
      text: input.text,
      user_id: record.user_id,
      session_id: record.session_id,
      turn: input.turn
    })).catch((error) => probe("timeline", "append.failed", { id: record.outbound_id, error: String(error) }));
  }
  /** 入队控制回执 / 错误 / 进度。 */
  enqueue_notice(input) {
    if (!input.text.trim()) return;
    if (input.turn === void 0) {
      const trimmed = this.store.trim_pending_notices(input.session_id);
      if (trimmed instanceof Promise) void trimmed;
    }
    const fallback_token = input.context_token ?? this.turn_context.latest_token_if_fresh(input.session_id);
    const record = this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: input.user_id,
      kind: input.kind,
      text: input.text,
      ...input.turn === void 0 ? {} : { turn: input.turn },
      ...fallback_token === void 0 ? {} : { context_token: fallback_token }
    });
    if (record instanceof Promise) void record;
  }
  // ── 发送 ──────────────────────────────────────────────────────────────
  /**
   * 泵出所有会话的可发送消息。
   * - 不同 Session 并发；同一 Session 严格按 sequence。
   * - 单条失败不阻塞其它会话。
   */
  async drain() {
    if (this.stopped) return;
    const wait = this.paused_until - Date.now();
    if (wait > 0) {
      const now = Date.now();
      if (now - this.pause_logged_at > 5e3) {
        this.pause_logged_at = now;
        probe("outbound", "drain.paused", { remaining_ms: wait, streak: this.rate_limit_streak });
      }
      if (this.pause_timer === void 0) {
        this.pause_timer = setTimeout(() => {
          this.pause_timer = void 0;
          void this.drain();
        }, wait + 50);
        this.pause_timer.unref?.();
      }
      return;
    }
    if (this.draining) return;
    this.draining = true;
    try {
      const heads = await this.store.next_outbox_per_session();
      await Promise.all(heads.map((head) => this.send_head(head)));
    } finally {
      this.draining = false;
    }
  }
  /**
   * 发送某会话当前队首；成功后继续推进该会话。
   *
   * 关键防护：记录本次已处理过的 outbound_id，禁止在同一次泵出里重复发送同一条。
   * 否则"终态失败 → 入队 error → error 也失败 → 再入队 error"会变成无限循环。
   */
  async send_head(record) {
    const handled = /* @__PURE__ */ new Set();
    let current = record;
    let sent = 0;
    while (current !== void 0 && !this.stopped) {
      if (handled.has(current.outbound_id)) {
        probe("outbound", "pump.guard_tripped", { outbound_id: current.outbound_id });
        return;
      }
      handled.add(current.outbound_id);
      await this.throttle(current.session_id);
      const ok = await this.send_one(current);
      if (!ok) return;
      sent += 1;
      if (sent >= this.send_batch_limit) {
        probe("outbound", "pump.batch_capped", { session_id: current.session_id, sent });
        return;
      }
      current = await this.store.next_outbox(current.session_id);
    }
  }
  /** 发送前等待，保证最小间隔（会话级 + 全局级）。 */
  async throttle(session_id) {
    const now = Date.now();
    const last_same = this.last_send_at.get(session_id) ?? 0;
    const wait_same = this.send_min_gap_ms - (now - last_same);
    const wait_any = Math.floor(this.send_min_gap_ms / 2) - (now - this.last_send_any_at);
    const wait = Math.max(0, wait_same, wait_any);
    if (wait > 0) {
      probe("outbound", "throttle.wait", { session_id, wait_ms: wait });
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.last_send_at.set(session_id, Date.now());
    this.last_send_any_at = Date.now();
  }
  /** 发送单条；返回是否应继续推进该会话队列。 */
  async send_one(record) {
    const done = probe_timer("outbound", "send.attempt", {
      outbound_id: record.outbound_id,
      session_id: record.session_id,
      kind: record.kind,
      sequence: record.sequence,
      attempt: record.attempt,
      turn: record.turn
    });
    await this.store.mark_outbox_sending(record.outbound_id);
    try {
      const send_token = record.context_token ?? this.turn_context.latest_token_if_fresh(record.session_id);
      if (send_token !== void 0 && record.context_token === void 0) {
        probe("outbound", "token.picked_at_send", { outbound_id: record.outbound_id, kind: record.kind });
      }
      const parts = split_text(record.text, MAX_TEXT_CHARS);
      const already_sent = new Set(record.sent_parts ?? []);
      let sent_any = already_sent.size > 0;
      for (let index = 0; index < parts.length; index += 1) {
        if (already_sent.has(index)) continue;
        if (sent_any) await this.throttle(record.session_id);
        await this.sender({
          user_id: record.user_id,
          text: parts[index],
          // 同一记录的多段共享 client_id 前缀 + 段号，保证每段唯一且重试可复用。
          client_id: `${record.client_id}#${index}`,
          ...send_token === void 0 ? {} : { context_token: send_token }
        });
        await this.store.mark_outbox_part_sent(record.outbound_id, index);
        sent_any = true;
      }
      await this.store.mark_outbox_sent(record.outbound_id);
      this.paused_until = 0;
      this.rate_limit_streak = 0;
      done({ outcome: "sent" });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const retryable = this.classify_retryable(error);
      const rate_limited = error?.rate_limited === true;
      const attempt = record.attempt + 1;
      if (rate_limited) {
        const is_notice = record.turn === void 0;
        if (is_notice) {
          const park_ms = this.parked_retention_ms;
          await this.store.mark_outbox_failed(
            record.outbound_id,
            "failed_retryable",
            "\u4F1A\u8BDD\u7A97\u53E3\u5DF2\u5173\u95ED\uFF1A\u5DF2\u505C\u653E\uFF0C\u7B49\u7528\u6237\u8BE2\u95EE\u65F6\u8FD4\u56DE",
            Date.now() + park_ms
          );
          await this.store.prune_parked_results(park_ms);
          done({ outcome: "notice_parked", error: detail, attempt, park_ms });
          probe("outbound", "notice.parked", {
            outbound_id: record.outbound_id,
            park_ms,
            has_token: record.context_token !== void 0
          });
          return true;
        }
        if (record.context_token === void 0) {
          const defer_ms = this.no_token_defer_ms;
          await this.store.mark_outbox_failed(
            record.outbound_id,
            "failed_retryable",
            detail,
            Date.now() + defer_ms
          );
          done({ outcome: "deferred_no_token", error: detail, attempt, defer_ms });
          probe("outbound", "send.deferred_no_token", {
            outbound_id: record.outbound_id,
            kind: record.kind,
            defer_ms
          });
          return true;
        }
        this.rate_limit_streak += 1;
        const cooldown = Math.min(
          this.rate_limit_cooldown_ms * 2 ** (this.rate_limit_streak - 1),
          this.rate_limit_cooldown_max_ms
        );
        this.paused_until = Date.now() + cooldown;
        await this.store.mark_outbox_failed(record.outbound_id, "failed_retryable", detail, Date.now() + cooldown);
        done({
          outcome: "rate_limited",
          error: detail,
          attempt,
          cooldown_ms: cooldown,
          streak: this.rate_limit_streak
        });
        return false;
      }
      if (!retryable || attempt >= this.max_attempts) {
        await this.store.mark_outbox_failed(record.outbound_id, "failed_terminal", detail);
        done({ outcome: "failed_terminal", error: detail, attempt });
        probe("outbound", "send.gave_up", {
          outbound_id: record.outbound_id,
          kind: record.kind,
          attempt,
          error: detail
        });
        return true;
      }
      const base = this.retry_base_ms;
      const next_retry_at = Date.now() + base * 2 ** Math.min(attempt, 6);
      await this.store.mark_outbox_failed(record.outbound_id, "failed_retryable", detail, next_retry_at);
      done({
        outcome: "failed_retryable",
        error: detail,
        attempt,
        next_retry_in_ms: next_retry_at - Date.now()
      });
      return false;
    }
  }
  // ── 进度 / 心跳（摘要驱动） ───────────────────────────────────────────
  /** 一轮开始：记录进度状态并启动"摘要超时"检查。 */
  begin_turn(session_id, turn) {
    this.clear_progress(session_id);
    const state = {
      turn,
      last_visible_at: Date.now(),
      heartbeats: 0,
      active: true
    };
    if (this.heartbeat_idle_ms > 0) {
      state.timer = setInterval(() => {
        void this.maybe_heartbeat(session_id);
      }, Math.max(5e3, Math.floor(this.heartbeat_idle_ms / 3)));
      state.timer.unref?.();
    }
    this.progress.set(session_id, state);
    probe("outbound", "turn.begin", { session_id, turn, heartbeat_idle_ms: this.heartbeat_idle_ms });
  }
  /**
   * 标记"刚有可见输出"。
   *
   * 思考摘要与正文分段都会调用这里——**摘要本身就是心跳**，
   * 所以它同时把 last_visible_at 推后，从而抑制额外的固定心跳。
   */
  note_visible(session_id) {
    const state = this.progress.get(session_id);
    if (state !== void 0) state.last_visible_at = Date.now();
  }
  /** 一轮结束：停止检查。 */
  end_turn(session_id) {
    this.clear_progress(session_id);
    probe("outbound", "turn.end", { session_id });
  }
  /** 距上次可见输出超过阈值才补发心跳。 */
  async maybe_heartbeat(session_id) {
    const state = this.progress.get(session_id);
    if (state === void 0 || !state.active) return;
    const idle = Date.now() - state.last_visible_at;
    if (idle < this.heartbeat_idle_ms) return;
    if (state.heartbeats >= this.heartbeat_max_per_turn) {
      this.clear_progress(session_id);
      return;
    }
    const context = this.turn_context.resolve(session_id, state.turn);
    if (context === void 0) return;
    state.heartbeats += 1;
    state.last_visible_at = Date.now();
    this.store.enqueue_outbox({
      session_id,
      user_id: context.user_id,
      kind: "heartbeat",
      text: `\uFF08\u8FD8\u5728\u5904\u7406\u4E2D\uFF0C\u5DF2\u7B49\u5F85\u7EA6 ${Math.round(idle / 1e3)} \u79D2\u2026\uFF09`,
      turn: state.turn,
      ...context.context_token === void 0 ? {} : { context_token: context.context_token }
    });
    probe("outbound", "heartbeat.enqueued", {
      session_id,
      turn: state.turn,
      idle_ms: idle,
      count: state.heartbeats
    });
    await this.drain();
  }
  /** 入队一条思考摘要（进度）：它既是进度也是心跳。 */
  enqueue_progress(session_id, text) {
    const state = this.progress.get(session_id);
    if (state === void 0) return;
    const context = this.turn_context.resolve(session_id, state.turn);
    if (context === void 0) return;
    this.note_visible(session_id);
    const record = this.store.enqueue_outbox({
      session_id,
      user_id: context.user_id,
      kind: "progress",
      text,
      turn: state.turn,
      ...context.context_token === void 0 ? {} : { context_token: context.context_token }
    });
    if (record instanceof Promise) void record;
  }
  /**
   * 远程状态端口专用的异步正式回复入口。
   *
   * 本方法与旧同步入口语义一致，但会等待 turn context、outbox 和长期记忆写入，
   * 用于避免远程 HTTP 状态尚未落库就开始发送。
   */
  async enqueue_assistant_async(input) {
    if (!input.text.trim()) return;
    const context = await this.turn_context.resolve_async(input.session_id, input.turn);
    const record = await this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: context?.user_id ?? input.user_id,
      kind: "assistant",
      text: input.text,
      turn: input.turn,
      ...context?.context_token === void 0 ? {} : { context_token: context.context_token }
    });
    ObservationRecorder2.bind_outbound(record.outbound_id, input.session_id, input.turn);
    await Promise.resolve(this.record_entry?.({
      id: record.outbound_id,
      ts: record.created_at,
      role: "assistant",
      text: input.text,
      user_id: record.user_id,
      session_id: record.session_id,
      turn: input.turn
    }));
  }
  /** 远程状态端口专用的异步通知入口。 */
  async enqueue_notice_async(input) {
    if (!input.text.trim()) return;
    if (input.turn === void 0) await this.store.trim_pending_notices(input.session_id);
    const fallback_token = input.context_token ?? await this.turn_context.latest_token_if_fresh_async(input.session_id);
    await this.store.enqueue_outbox({
      session_id: input.session_id,
      user_id: input.user_id,
      kind: input.kind,
      text: input.text,
      ...input.turn === void 0 ? {} : { turn: input.turn },
      ...fallback_token === void 0 ? {} : { context_token: fallback_token }
    });
  }
  /** 远程状态端口专用的异步进度入口。 */
  async enqueue_progress_async(session_id, text) {
    const state = this.progress.get(session_id);
    if (state === void 0) return;
    const context = await this.turn_context.resolve_async(session_id, state.turn);
    if (context === void 0) return;
    this.note_visible(session_id);
    await this.store.enqueue_outbox({
      session_id,
      user_id: context.user_id,
      kind: "progress",
      text,
      turn: state.turn,
      ...context.context_token === void 0 ? {} : { context_token: context.context_token }
    });
  }
  /** 清理某会话的进度状态。 */
  clear_progress(session_id) {
    const state = this.progress.get(session_id);
    if (state?.timer !== void 0) clearInterval(state.timer);
    this.progress.delete(session_id);
  }
  /** 停止出站泵；幂等。 */
  stop() {
    this.stopped = true;
    if (this.pause_timer !== void 0) {
      clearTimeout(this.pause_timer);
      this.pause_timer = void 0;
    }
    for (const session_id of [...this.progress.keys()]) this.clear_progress(session_id);
    probe("outbound", "stopped");
  }
  /** 启动时恢复 pending outbox（设计文档 §10.3）。 */
  async recover_pending() {
    const pending = await this.store.list_pending_outbox();
    const now = Date.now();
    const stale_ms = Number(process.env.DSH_WEIXIN_OUTBOX_STALE_MS ?? String(10 * 6e4));
    const reply_stale_ms = Number(process.env.DSH_WEIXIN_REPLY_STALE_MS ?? String(30 * 6e4));
    let dropped = 0;
    for (const record of pending) {
      const limit = record.turn === void 0 ? Math.max(stale_ms, this.parked_retention_ms) : Math.max(stale_ms, reply_stale_ms);
      if (now - record.created_at > limit) {
        await this.store.mark_outbox_failed(record.outbound_id, "failed_terminal", "\u91CD\u542F\u6062\u590D\uFF1A\u8D85\u8FC7\u8865\u53D1\u65F6\u9650\uFF0C\u5DF2\u4E22\u5F03");
        dropped += 1;
        continue;
      }
      if (record.status === "sending") {
        await this.store.mark_outbox_failed(record.outbound_id, "failed_retryable", "\u91CD\u542F\u6062\u590D\uFF1A\u4E0A\u6B21\u53D1\u9001\u4E2D\u65AD");
      }
    }
    probe("outbound", "recover.pending", { count: pending.length, dropped_stale: dropped });
    return pending.length;
  }
};

// backend/packages/webhook/webhook-weixin/src/lifecycle/consumerLease.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
var DEFAULT_STALE_MS = 9e4;
var DEFAULT_HEARTBEAT_MS = 3e4;
var ConsumerLease = class {
  owner_id;
  store;
  account_id;
  marker_path;
  stale_ms;
  heartbeat_ms;
  timer;
  released = false;
  /** 创建持有者（尚未获取）。 */
  constructor(options) {
    this.store = options.store;
    this.account_id = options.account_id;
    this.marker_path = options.marker_path;
    this.stale_ms = options.stale_ms ?? DEFAULT_STALE_MS;
    this.heartbeat_ms = options.heartbeat_ms ?? DEFAULT_HEARTBEAT_MS;
    this.owner_id = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  }
  /**
   * 尝试获取 lease；失败抛出（调用方必须让连接器启动失败）。
   * @throws 已有活跃消费者时抛出，错误信息包含持有者 pid/账号，便于直接定位。
   */
  async acquire() {
    const held = await this.store.try_acquire_lease({
      owner_id: this.owner_id,
      pid: process.pid,
      process_started_at: Date.now() - Math.round(process.uptime() * 1e3),
      account_id: this.account_id,
      stale_ms: this.stale_ms
    });
    if (!held) {
      const existing = await this.store.get_lease();
      const detail = existing === void 0 ? "\uFF08\u672A\u77E5\u6301\u6709\u8005\uFF09" : `pid=${existing.pid} owner=${existing.owner_id} account=${existing.account_id} \u5FC3\u8DF3\u4E8E ${Math.round((Date.now() - existing.heartbeat_at) / 1e3)} \u79D2\u524D`;
      probe("lifecycle", "lease.acquire_failed", { detail });
      throw new Error(
        `webhook-weixin: \u5DF2\u6709\u53E6\u4E00\u4E2A\u5FAE\u4FE1\u6D88\u8D39\u8005\u5728\u8FD0\u884C\uFF0C\u62D2\u7EDD\u542F\u52A8 \u2014\u2014 ${detail}\u3002\u540C\u4E00\u5FAE\u4FE1\u8D26\u53F7\u53EA\u5141\u8BB8\u4E00\u4E2A\u6D88\u8D39\u8005\uFF0C\u5426\u5219\u4F1A\u91CD\u590D\u5904\u7406\u6D88\u606F\u3001\u5206\u88C2\u4F1A\u8BDD\u3002\u8BF7\u5148\u505C\u6389\u5B83\u3002`
      );
    }
    this.write_marker();
    this.timer = setInterval(() => {
      void Promise.resolve(this.store.heartbeat_lease(this.owner_id)).then((held2) => {
        if (held2) return;
        probe("lifecycle", "lease.heartbeat_lost", { owner_id: this.owner_id });
        console.error("[webhook-weixin] lease \u5DF2\u4E22\u5931\uFF08\u53EF\u80FD\u88AB\u62A2\u5360\uFF09\uFF0C\u505C\u6B62\u7EED\u79DF");
        this.stop_heartbeat();
      }).catch((error) => {
        probe("lifecycle", "lease.heartbeat_error", { owner_id: this.owner_id, error: String(error) });
        this.stop_heartbeat();
      });
    }, this.heartbeat_ms);
    this.timer.unref?.();
    probe("lifecycle", "lease.held", { owner_id: this.owner_id, account_id: this.account_id });
  }
  /** 是否仍持有 lease（心跳丢失后为 false）。 */
  async is_held() {
    const lease = await this.store.get_lease();
    return !this.released && lease?.owner_id === this.owner_id;
  }
  /** 释放 lease；幂等。 */
  async release() {
    if (this.released) return;
    this.released = true;
    this.stop_heartbeat();
    await this.store.release_lease(this.owner_id);
    if (this.marker_path !== void 0) {
      try {
        writeFileSync2(this.marker_path, "", "utf8");
      } catch {
      }
    }
  }
  /** 停止续租定时器。 */
  stop_heartbeat() {
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
  }
  /** 写人类可读标记；仅诊断用途。 */
  write_marker() {
    if (this.marker_path === void 0) return;
    try {
      mkdirSync2(dirname2(this.marker_path), { recursive: true });
      writeFileSync2(this.marker_path, `owner=${this.owner_id} pid=${process.pid} account=${this.account_id}
`, "utf8");
    } catch {
    }
  }
};
function preflight_openclaw_isolation(openclawConfigPath) {
  const problems = [];
  const path = openclawConfigPath ?? join3(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".openclaw", "openclaw.json");
  try {
    const raw = readFileSync3(path, "utf8");
    const parsed = JSON.parse(raw);
    const entry = parsed.plugins?.entries?.["openclaw-weixin"];
    if (entry?.enabled === true) {
      problems.push(`OpenClaw \u7684 openclaw-weixin \u4ECD\u4E3A enabled: true\uFF08${path}\uFF09`);
    }
  } catch (error) {
    const code = error.code;
    if (code !== "ENOENT") {
      problems.push(`OpenClaw \u914D\u7F6E\u65E0\u6CD5\u89E3\u6790\uFF08${path}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}`);
    }
  }
  problems.push(...scan_openclaw_gateway_processes());
  const result = { ok: problems.length === 0, problems };
  probe("lifecycle", "preflight.openclaw", { ok: result.ok, problems });
  return result;
}
function scan_openclaw_gateway_processes() {
  if (process.platform !== "win32") return [];
  const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  try {
    const stdout = execFileSync2(
      "powershell.exe",
      ["-NoLogo", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { encoding: "utf8", timeout: 2e4, windowsHide: true }
    );
    const parsed = JSON.parse(stdout.trim() === "" ? "[]" : stdout);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const found = [];
    for (const row of rows) {
      const command = (row.CommandLine ?? "").toLowerCase();
      if (!command.includes("openclaw")) continue;
      if (!command.includes("gateway")) continue;
      if (!command.includes("weixin") && !command.includes("channel")) continue;
      found.push(`\u68C0\u6D4B\u5230\u6B63\u5728\u8FD0\u884C\u7684 OpenClaw \u5FAE\u4FE1 gateway\uFF08pid=${row.ProcessId ?? "?"}\uFF09`);
    }
    return found;
  } catch (error) {
    return ["\u65E0\u6CD5\u786E\u8BA4 OpenClaw gateway \u662F\u5426\u5728\u8FD0\u884C\uFF08\u8FDB\u7A0B\u626B\u63CF\u5931\u8D25\uFF0C\u6309 fail-closed \u5904\u7406\uFF09\uFF1A" + (error instanceof Error ? error.message : String(error))];
  }
}

// backend/packages/webhook/webhook-weixin/src/reply/replyAggregator.ts
var SENTENCE_BOUNDARIES = /* @__PURE__ */ new Set(["\u3002", "\uFF01", "!", "\uFF1F", "?"]);
var KEPT = /* @__PURE__ */ new Set(["\uFF01", "!", "\uFF1F", "?"]);
var MIN_SEGMENT_CHARS = 40;
var MAX_SEGMENTS_PER_TURN = 4;
var THINK_TAG = /<\/?think[^<>]*>/gi;
var THINK_TAG_TAIL = /<\/?think[^<>]*$/i;
function looks_like_tool_call(text) {
  const trimmed = text.trimStart();
  if (/FunctionCall(Begin|End)?/.test(trimmed)) return true;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  return /"(name|arguments|parameters|tool_call|tool_calls|function)"\s*:/.test(trimmed);
}
var ReplyAggregator = class {
  pending = "";
  reasoning = "";
  suppressed = false;
  finished = false;
  /** 本轮已经切出去的段数（用于 MAX_SEGMENTS_PER_TURN 限流保护）。 */
  emitted = 0;
  /**
   * 接收一个正文分片，返回应立刻发送的段落列表。
   * 命中"工具调用外壳"时整轮静默，避免把内部结构泄露给用户。
   */
  accept_chunk(text) {
    if (this.finished || !text) return [];
    if (this.suppressed || looks_like_tool_call(this.pending + text)) {
      this.suppressed = true;
      this.pending = "";
      return [];
    }
    this.pending = (this.pending + text).replace(THINK_TAG, "");
    if (THINK_TAG_TAIL.test(this.pending)) return [];
    if (this.emitted >= MAX_SEGMENTS_PER_TURN) return [];
    return this.extract();
  }
  /** 累计思考摘要（不发送）。 */
  accept_reasoning(text) {
    this.reasoning = (this.reasoning + text).slice(-4e3);
  }
  /**
   * 取出一段思考摘要并清空。
   * 摘要推送后应调用 `mark_visible()`，因为它本身就是一次"用户可见输出"。
   */
  take_reasoning_excerpt(limit) {
    const text = this.reasoning.replace(/\s+/g, " ").trim();
    if (!text) return void 0;
    this.reasoning = "";
    return text.length > limit ? "\u2026" + text.slice(-limit) : text;
  }
  /** 结束本轮，返回尚未发送的尾段。 */
  finish() {
    if (this.finished) return void 0;
    this.finished = true;
    if (this.suppressed) return void 0;
    const tail = this.pending.trim();
    this.pending = "";
    return tail || void 0;
  }
  /** 是否已被判定为工具调用外壳（整轮静默）。 */
  get is_suppressed() {
    return this.suppressed;
  }
  /** 按句子标点切出可发送段落。 */
  extract() {
    const segments = [];
    let start = 0;
    let index = 0;
    let in_code = false;
    while (index < this.pending.length) {
      if (this.pending.startsWith("```", index)) {
        in_code = !in_code;
        index += 3;
        continue;
      }
      if (!in_code && SENTENCE_BOUNDARIES.has(this.pending[index])) {
        let end = index + 1;
        let kept = "";
        if (KEPT.has(this.pending[index])) {
          while (end < this.pending.length && KEPT.has(this.pending[end])) end += 1;
          kept = this.pending.slice(index, end);
        }
        const segment = (this.pending.slice(start, index).trim() + kept).trim();
        if (segment.length >= MIN_SEGMENT_CHARS && this.emitted < MAX_SEGMENTS_PER_TURN) {
          segments.push(segment);
          this.emitted += 1;
          start = end;
          index = end;
          continue;
        }
        index = end;
        continue;
      }
      index += 1;
    }
    this.pending = this.pending.slice(start);
    return segments;
  }
};

// backend/packages/webhook/webhook-weixin/src/session/weixinSessionHost.ts
import { appendFile as appendFile2 } from "node:fs/promises";
var HarnessSessionHost = class {
  /** 绑定 Cordis 上下文与组合参数。 */
  constructor(ctx, options) {
    this.ctx = ctx;
    this.options = options;
  }
  handles = /* @__PURE__ */ new Map();
  disposed = false;
  composition;
  /**
   * 启动时装配检查（设计文档 §8.2 / §9.3）：缺任何一个必需服务都立即失败。
   * @throws 缺少 agents / agent-loop / agentPresets / sessionPersistence 时抛出。
   */
  assert_capabilities() {
    const get = (name2) => this.ctx.get(name2);
    const missing = [];
    if (get("agents") === void 0) missing.push("agents");
    if (get("agentPresets") === void 0) missing.push("agentPresets");
    if (get("sessionPersistence") === void 0) missing.push("sessionPersistence");
    if (get("llm") === void 0) missing.push("llm");
    if (this.options.agent_preset !== void 0 && get("agentPresets") !== void 0) {
      probe("lifecycle", "capability.preset_requested", { preset: this.options.agent_preset });
    }
    if (missing.length > 0) {
      throw new Error(
        `webhook-weixin: \u88C5\u914D\u68C0\u67E5\u5931\u8D25\uFF0C\u7F3A\u5C11\u670D\u52A1 ${missing.join(", ")}\u3002\u8FDE\u63A5\u5668\u62D2\u7EDD\u542F\u52A8\uFF08\u907F\u514D\u51FA\u73B0"\u80FD\u542F\u52A8\u4F46\u53D1\u6D88\u606F\u624D\u53D1\u73B0\u6CA1\u6709\u5DE5\u5177/\u6CA1\u6709\u6301\u4E45\u5316"\u7684\u5047\u6210\u529F\uFF09\u3002`
      );
    }
    probe("lifecycle", "capability.ok", {
      preset: this.options.agent_preset ?? "(default)",
      provider: this.options.provider,
      model: this.options.model
    });
  }
  /**
   * 忘掉已解析的 preset 组合（挂载/卸载工具后调用）。
   *
   * `compose()` 是**按宿主实例记忆**的：不重置的话，改完 preset 之后
   * 新会话仍然拿到旧工具集，用户会以为"勾选了没生效"。
   * 重置后下一次创建 Agent 会重新解析 preset（已有 Agent 不受影响，
   * 需要新会话或清空上下文才会换上新工具）。
   */
  reset_composition() {
    this.composition = void 0;
    probe("lifecycle", "composition.reset");
  }
  /** 查找在线 Agent。 */
  get_agent(session_id) {
    return this.ctx.agents.get(session_id);
  }
  /** 创建 Agent；Session 已存在时自动恢复。 */
  async create_agent(session_id) {
    this.assert_not_disposed();
    const composition = await this.compose();
    try {
      const handle = await this.ctx.agents.create({
        sessionId: session_id,
        meta: {
          cwd: this.options.workspace_path,
          ...composition.agentPreset === void 0 ? {} : { agentPreset: composition.agentPreset },
          ...this.options.provider === void 0 ? {} : { provider: this.options.provider },
          ...this.options.model === void 0 ? {} : { model: this.options.model }
        },
        ...this.agent_options() === void 0 ? {} : { agentOptions: this.agent_options() },
        ...composition.setup === void 0 ? {} : { setup: composition.setup }
      });
      this.handles.set(String(handle.agent.id), handle);
      probe("lifecycle", "agent.created", { session_id: String(handle.agent.id) });
      return handle.agent;
    } catch (error) {
      if (!is_session_already_exists(error)) throw error;
      probe("lifecycle", "agent.create_conflict_resume", { session_id: String(session_id) });
      return this.resume_agent(session_id);
    }
  }
  /** 恢复持久化 Session。 */
  async resume_agent(session_id) {
    this.assert_not_disposed();
    const composition = await this.compose();
    let handle;
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: session_id,
        ...this.agent_options() === void 0 ? {} : { agentOptions: this.agent_options() },
        ...composition.setup === void 0 ? {} : { setup: composition.setup }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/^session ["'][^"']+["'] not found$/i.test(message)) throw error;
      probe("lifecycle", "agent.resume_missing_create", { session_id: String(session_id) });
      return this.create_agent(session_id);
    }
    this.handles.set(String(handle.agent.id), handle);
    probe("lifecycle", "agent.resumed", { session_id: String(handle.agent.id) });
    return handle.agent;
  }
  /**
   * 释放**单个** Agent（清空某个用户的上下文用），返回是否真的释放了。
   *
   * 必须是 owner 来释放：只有 dispose 才会关掉会话日志的写句柄。
   * 否则外部删掉 session 文件后，进程内残留的句柄会在下次 append 时
   * **新建一个没有 header 的坏文件**（实测的坑），那个会话就再也恢复不起来了。
   */
  async dispose_agent(session_id) {
    const key = String(session_id);
    const handle = this.handles.get(key);
    if (handle === void 0) return false;
    this.handles.delete(key);
    try {
      await handle.dispose();
      probe("lifecycle", "agent.disposed_one", { session_id: key });
      return true;
    } catch (error) {
      probe("lifecycle", "agent.dispose_failed", { session_id: key, error: String(error) });
      return false;
    }
  }
  /**
   * 释放本宿主创建的全部 Agent；**幂等**（重复调用、卸载后调用都安全）。
   * 这是唯一的 owner 释放点。
   */
  async dispose_agents() {
    if (this.disposed) return;
    this.disposed = true;
    const entries = [...this.handles.values()];
    this.handles.clear();
    for (const handle of entries) {
      try {
        await handle.dispose();
      } catch (error) {
        probe("lifecycle", "agent.dispose_failed", { error: String(error) });
      }
    }
    probe("lifecycle", "agents.disposed", { count: entries.length });
  }
  /** 组装 preset（解析失败必须抛错，禁止静默降级成"无工具 Agent"）。 */
  async compose() {
    if (this.composition !== void 0) return this.composition;
    const presets = this.ctx.get("agentPresets");
    if (presets === void 0) {
      throw new Error("webhook-weixin: agentPresets \u670D\u52A1\u7F3A\u5931\uFF0C\u65E0\u6CD5\u6302\u8F7D Agent preset\uFF08\u4F1A\u5BFC\u81F4 Agent \u6CA1\u6709\u4EFB\u4F55\u5DE5\u5177\uFF09\u3002");
    }
    try {
      const resolvedId = (await presets.resolve(this.options.agent_preset)).id;
      const composition = {
        agentPreset: resolvedId,
        setup: async (agentCtx) => {
          await presets.mount(agentCtx, resolvedId);
        }
      };
      this.composition = composition;
      probe("lifecycle", "preset.resolved", { requested: this.options.agent_preset ?? "(default)", resolved: resolvedId });
      return composition;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `webhook-weixin: \u65E0\u6CD5\u89E3\u6790 Agent preset "${this.options.agent_preset ?? "(default)"}"\uFF0C\u62D2\u7EDD\u4EE5"\u65E0\u5DE5\u5177 Agent"\u7EE7\u7EED\u8FD0\u884C\uFF1A${detail}`
      );
    }
  }
  /**
   * 组装 Agent 运行选项。
   *
   * provider/model 必须传给 `ctx.agents.create/resume`：preset 的 persona 前缀里有
   * `{{model}}` 这类提示变量，不传会导致 Agent 启动即报
   * `prompt variable "{{model}}" has no value for this assembly`，
   * 表现为"消息已注入但永远没有回复"（探针里能看到 agent.error）。
   */
  agent_options() {
    const provider = this.options.provider;
    const model = this.options.model;
    if (provider === void 0 || model === void 0) {
      probe("lifecycle", "agent_options.missing_model", { provider, model });
      return void 0;
    }
    const level = this.options.reasoning_effort;
    if (level === void 0) return { provider, model };
    return { provider, model, reasoningEffort: level };
  }
  /** 卸载后禁止再创建。 */
  assert_not_disposed() {
    if (this.disposed) throw new Error("webhook-weixin: \u5BBF\u4E3B\u5DF2\u91CA\u653E\uFF0C\u4E0D\u80FD\u518D\u521B\u5EFA Agent");
  }
};
function is_session_already_exists(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /already exists|duplicate|EEXIST|session_exists/i.test(message);
}
async function trace_to_file(line) {
  const path = process.env.DSH_WEIXIN_DEBUG_LOG;
  if (!path) return;
  try {
    await appendFile2(path, `${(/* @__PURE__ */ new Date()).toISOString()} [weixin] ${line}
`, "utf8");
  } catch {
  }
}

// backend/packages/webhook/webhook-weixin/src/runtime/weixinConnector.ts
import { copyFileSync as copyFileSync2, readFileSync as readFileSync10, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join13 } from "node:path";
import { createHash as createHash2, randomBytes as randomBytes2 } from "node:crypto";
import { spawn as spawn3 } from "node:child_process";
import { createConnection } from "node:net";
import { brandString as brandString2 } from "@deepseek-ai/dsh-brand";
import { ObservationRecorder as ObservationRecorder3 } from "@deepseek-ai/dsh-llm";

// backend/packages/webhook/webhook-weixin/src/diagnostics/injectServer.ts
import { createServer } from "node:http";
var MAX_BODY_BYTES = 64 * 1024;
function start_inject_server(options) {
  const server = createServer((request, response) => {
    const reply = (status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(body);
    };
    const path = (request.url ?? "").split("?")[0] ?? "";
    const is_inject = path === "/inject";
    const admin_match = /^\/admin\/([a-z][a-z0-9-]*)$/.exec(path);
    if (request.method !== "POST" || !is_inject && admin_match === null) {
      reply(404, { ok: false, error: "only POST /inject and POST /admin/<action> are supported" });
      return;
    }
    if (admin_match !== null && options.admin === void 0) {
      reply(501, { ok: false, error: "admin actions are not wired in this build" });
      return;
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reply(413, { ok: false, error: "body too large" });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      let parsed;
      try {
        const text2 = Buffer.concat(chunks).toString("utf8");
        parsed = text2.trim() === "" ? {} : JSON.parse(text2);
      } catch {
        reply(400, { ok: false, error: "body must be JSON" });
        return;
      }
      if (admin_match !== null) {
        const action = admin_match[1];
        options.admin(action, parsed).then(
          (result) => reply(200, { ok: true, ...result }),
          (error) => {
            probe("lifecycle", "admin.failed", { action, error: String(error) });
            reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
          }
        );
        return;
      }
      const text = typeof parsed.text === "string" ? parsed.text : "";
      if (text.trim() === "") {
        reply(400, { ok: false, error: "text is required" });
        return;
      }
      const input = {
        text,
        ...typeof parsed.user_id === "string" ? { user_id: parsed.user_id } : {}
      };
      options.inject(input).then(
        (result) => reply(200, { ok: true, ...result }),
        (error) => {
          probe("inbound", "inject.failed", { error: String(error) });
          reply(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      );
    });
  });
  server.listen(options.port, "127.0.0.1");
  probe("lifecycle", "inject_server.listening", { port: options.port, host: "127.0.0.1" });
  return server;
}

// backend/packages/webhook/webhook-weixin/src/session/sessionFiles.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join as join4 } from "node:path";
var LOG_FILE_PATTERN = /^session\.v\d+\.jsonl(\..+)?$/;
function encode_segment(raw) {
  if (raw.length === 0) throw new Error("cannot encode an empty path segment");
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}
function project_key(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separator_run = false;
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separator_run) readable += "-";
      separator_run = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separator_run = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separator_run = false;
    }
  }
  const slug = readable.replace(/^-+/, "") || "root";
  return `--${slug.slice(0, 251)}--`;
}
function sessions_root(dsh_home) {
  const home = dsh_home ?? process.env.DSH_HOME ?? join4(homedir(), ".dsh");
  return join4(home, "sessions");
}
function session_dir_path(root, cwd, id) {
  const project = cwd === void 0 ? "_no-cwd" : project_key(cwd);
  return join4(root, project, encode_segment(id));
}
function clear_directory_contents(dir) {
  if (!existsSync3(dir)) {
    mkdirSync3(dir, { recursive: true });
    return { files: 0, bytes: 0, dir };
  }
  let files = 0;
  let bytes = 0;
  for (const name2 of readdirSync(dir)) {
    const path = join4(dir, name2);
    try {
      const stat = statSync(path);
      if (stat.isFile()) {
        bytes += stat.size;
        files += 1;
      } else {
        bytes += directory_bytes(path);
        files += 1;
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
    }
  }
  return { files, bytes, dir };
}
function directory_bytes(dir) {
  let total = 0;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name2 of names) {
    const path = join4(dir, name2);
    try {
      const stat = statSync(path);
      total += stat.isDirectory() ? directory_bytes(path) : stat.size;
    } catch {
    }
  }
  return total;
}
function session_log_stats(dir) {
  if (!existsSync3(dir)) return void 0;
  let bytes = 0;
  let modified_at = 0;
  let files = 0;
  for (const name2 of readdirSync(dir)) {
    if (!LOG_FILE_PATTERN.test(name2)) continue;
    try {
      const stat = statSync(join4(dir, name2));
      bytes += stat.size;
      modified_at = Math.max(modified_at, stat.mtimeMs);
      files += 1;
    } catch {
    }
  }
  return files === 0 ? void 0 : { bytes, modified_at, files };
}
function delete_session_artifacts(input) {
  let dir = "";
  try {
    dir = session_dir_path(input.root, input.cwd, input.id);
  } catch (error) {
    return { deleted: false, dir: "", reason: `\u8DEF\u5F84\u63A8\u5BFC\u5931\u8D25\uFF1A${String(error)}` };
  }
  if (!existsSync3(dir)) return { deleted: false, dir, reason: "\u76EE\u5F55\u4E0D\u5B58\u5728\uFF08\u53EF\u80FD\u8FD8\u6CA1\u843D\u76D8\uFF09" };
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (error) {
    return { deleted: false, dir, reason: `\u8BFB\u76EE\u5F55\u5931\u8D25\uFF1A${String(error)}` };
  }
  if (!entries.some((name2) => LOG_FILE_PATTERN.test(name2))) {
    return { deleted: false, dir, reason: "\u76EE\u5F55\u91CC\u6CA1\u6709\u4F1A\u8BDD\u65E5\u5FD7\u6587\u4EF6\uFF0C\u4E0D\u50CF\u4F1A\u8BDD\u76EE\u5F55\uFF0C\u5DF2\u8DF3\u8FC7" };
  }
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return { deleted: true, dir };
  } catch (error) {
    return { deleted: false, dir, reason: `\u5220\u9664\u5931\u8D25\uFF1A${String(error)}` };
  }
}

// backend/packages/webhook/webhook-weixin/src/coordination/codexBridge.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { join as join5 } from "node:path";
var DEFAULT_WORKSPACE = process.env.DSH_CODEX_WORKSPACE?.trim() || process.cwd();
var RUN_TIMEOUT_MS = Number(process.env.DSH_CODEX_TIMEOUT_MS ?? String(30 * 6e4));
function resolve_codex_bin() {
  const configured = process.env.CODEX_BIN;
  if (configured !== void 0 && configured.trim() && existsSync4(configured.trim())) return configured.trim();
  const fallback = join5(process.env.LOCALAPPDATA ?? "", "OpenAI", "Codex", "bin", "codex.exe");
  if (existsSync4(fallback)) return fallback;
  return "codex";
}
function parse_codex_command(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (!lower.startsWith("/codex")) return void 0;
  const rest = trimmed.slice(6).trim();
  if (rest === "") return { action: "help", text: "" };
  const [head, ...tail] = rest.split(/\s+/);
  const keyword = (head ?? "").toLowerCase();
  const body = tail.join(" ").trim();
  if (keyword === "stop" || keyword === "\u505C\u6B62") return { action: "stop", text: body };
  if (keyword === "status" || keyword === "\u72B6\u6001") return { action: "status", text: body };
  if (keyword === "new" || keyword === "\u65B0\u5F00") return { action: "new", text: body };
  if (keyword === "help" || keyword === "\u5E2E\u52A9") return { action: "help", text: body };
  return { action: "run", text: rest };
}
var CodexBridge = class {
  /** 绑定状态库与推送实现。 */
  constructor(store, push, workspace = DEFAULT_WORKSPACE) {
    this.store = store;
    this.push = push;
    this.workspace = workspace;
  }
  tasks = /* @__PURE__ */ new Map();
  seq = /* @__PURE__ */ new Map();
  /** 处理一条 `/codex` 指令。 */
  async handle(user_id, session_id, command, context_token) {
    if (command.action === "help") {
      await this.push(user_id, session_id, [
        "\u8FD9\u91CC\u662F Codex \u8FDC\u7A0B\u63A7\u5236\uFF0C\u7528\u6CD5\uFF1A",
        "- /codex <\u4EFB\u52A1>     \u4EA4\u7ED9 Codex \u6267\u884C\uFF08\u9ED8\u8BA4\u7EED\u7528\u4E0A\u6B21\u7EBF\u7A0B\uFF09",
        "- /codex new <\u4EFB\u52A1> \u65B0\u5F00\u4E00\u4E2A Codex \u7EBF\u7A0B",
        "- /codex status     \u67E5\u770B\u5F53\u524D\u72B6\u6001",
        "- /codex stop       \u7EC8\u6B62\u5F53\u524D\u4EFB\u52A1",
        `\u9ED8\u8BA4\u5DE5\u4F5C\u533A\uFF1A${this.workspace}`
      ].join("\n"), "assistant", context_token);
      return;
    }
    if (command.action === "status") {
      const task = this.tasks.get(user_id);
      const thread = await this.thread_for(user_id);
      const text = task === void 0 ? `\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684 Codex \u4EFB\u52A1${thread === void 0 ? "" : `\uFF1B\u4E0A\u6B21\u7EBF\u7A0B ${thread.slice(0, 8)}`}\uFF09` : `\uFF08Codex \u6B63\u5728\u8FD0\u884C\uFF1A\u7B2C ${task.turn} \u8F6E\uFF0C\u5DF2 ${Math.round((Date.now() - task.started_at) / 1e3)} \u79D2\uFF0C\u7EBF\u7A0B ${task.thread_id?.slice(0, 8) ?? "\u521D\u59CB\u5316\u4E2D"}\uFF09`;
      await this.push(user_id, session_id, text, "assistant", context_token);
      return;
    }
    if (command.action === "stop") {
      const stopped = this.stop(user_id);
      await this.push(user_id, session_id, stopped ? "\uFF08\u5DF2\u7EC8\u6B62\u5F53\u524D\u7684 Codex \u4EFB\u52A1\uFF09" : "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684 Codex \u4EFB\u52A1\uFF09", "assistant", context_token);
      return;
    }
    if (command.action === "new") {
      await this.store.set_meta("codex_thread:" + user_id, "");
    }
    if (this.tasks.has(user_id)) {
      await this.push(user_id, session_id, "\uFF08\u5DF2\u7ECF\u6709\u4E00\u4E2A Codex \u4EFB\u52A1\u5728\u8DD1\uFF0C\u7B49\u5B83\u7ED3\u675F\u6216\u5148\u53D1 /codex stop\uFF09", "error", context_token);
      return;
    }
    if (!command.text.trim()) {
      await this.push(user_id, session_id, "\uFF08/codex \u540E\u9762\u8981\u8DDF\u5177\u4F53\u4EFB\u52A1\uFF09", "error", context_token);
      return;
    }
    await this.run(user_id, session_id, command.text.trim(), context_token);
  }
  /** 终止某用户当前任务；返回是否真的终止了。 */
  stop(user_id) {
    const task = this.tasks.get(user_id);
    if (task === void 0) return false;
    probe("codex", "stop", { user_id, pid: task.child.pid });
    task.child.kill();
    this.tasks.delete(user_id);
    return true;
  }
  /** 当前用户是否有任务在跑。 */
  is_running(user_id) {
    return this.tasks.has(user_id);
  }
  /** 读取该用户记住的 Codex 线程 id。 */
  async thread_for(user_id) {
    const value = await this.store.get_meta("codex_thread:" + user_id);
    return value !== void 0 && value.length > 0 ? value : void 0;
  }
  /** 执行一次 Codex 任务，边跑边把事件推给用户，结束后发最终结果。 */
  async run(user_id, session_id, task, context_token) {
    const thread = await this.thread_for(user_id);
    const bin = resolve_codex_bin();
    const args = thread === void 0 ? [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color",
      "never",
      "-C",
      this.workspace,
      task
    ] : [
      "exec",
      "resume",
      thread,
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--color",
      "never",
      task
    ];
    const turn = (this.seq.get(user_id) ?? 0) + 1;
    this.seq.set(user_id, turn);
    probe("codex", "run.start", { user_id, turn, resume: thread !== void 0, workspace: this.workspace, task_len: task.length });
    const child = spawn(bin, args, {
      cwd: this.workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const running = { child, turn, started_at: Date.now(), ...thread === void 0 ? {} : { thread_id: thread } };
    this.tasks.set(user_id, running);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    const timer = setTimeout(() => {
      probe("codex", "run.timeout", { user_id, turn });
      child.kill();
    }, RUN_TIMEOUT_MS);
    const pushed = /* @__PURE__ */ new Set();
    let last_push_at = 0;
    const interval = child.stdout;
    void interval;
    await new Promise((resolve) => {
      let buffer = "";
      const flush_lines = () => {
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const text = line.trim();
          if (!text.startsWith("{")) continue;
          let event;
          try {
            event = JSON.parse(text);
          } catch {
            continue;
          }
          void this.consume_event(user_id, session_id, event, pushed, () => last_push_at, (at) => {
            last_push_at = at;
          }, context_token);
        }
      };
      child.stdout?.on("data", flush_lines);
      child.on("close", async (code) => {
        flush_lines();
        clearTimeout(timer);
        this.tasks.delete(user_id);
        const ok = code === 0;
        probe("codex", "run.close", { user_id, turn, code, pushed: pushed.size });
        if (!ok) {
          const detail = stderr.split("\n").filter(Boolean).slice(-6).join(" ");
          await this.push(user_id, session_id, `\uFF08Codex \u9000\u51FA\u7801 ${code}${detail ? "\uFF1A" + detail : ""}\uFF09`, "error", context_token);
        }
        resolve();
      });
    });
  }
  /** 解析单个 Codex JSON 事件并（必要时）推送给用户。 */
  async consume_event(user_id, session_id, event, pushed, _get_last, set_last, context_token) {
    const type = String(event.type ?? "");
    if (type === "thread.started") {
      const thread_id = String(event.thread_id ?? "");
      if (thread_id) {
        await this.store.set_meta("codex_thread:" + user_id, thread_id);
        const running = this.tasks.get(user_id);
        if (running !== void 0) running.thread_id = thread_id;
      }
      return;
    }
    if (type === "turn.completed") {
      const usage = event.usage;
      probe("codex", "turn.completed", { user_id, usage });
      return;
    }
    if (type === "item.completed" || type === "item.started" || type === "item.updated") {
      const item = event.item;
      if (item === void 0) return;
      const item_id = String(item.id ?? "");
      const item_type = String(item.type ?? "");
      const key = `${type}:${item_id}:${item_type}`;
      if (pushed.has(key)) return;
      let text;
      if (item_type === "agent_message" && typeof item.text === "string" && type === "item.completed") {
        text = item.text;
      }
      if (text === void 0 || text.trim() === "") return;
      pushed.add(key);
      set_last(Date.now());
      await this.push(user_id, session_id, text.trim(), item_type === "agent_message" ? "assistant" : "progress", context_token);
    }
  }
};

// backend/packages/webhook/webhook-weixin/src/coordination/codexWatcher.ts
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
import { existsSync as existsSync5 } from "node:fs";
import { readFileSync as readFileSync4, readdirSync as readdirSync2, statSync as statSync2 } from "node:fs";
import { join as join6 } from "node:path";
var CodexWatcher = class {
  store;
  push;
  poll_ms;
  codex_home;
  summary_limit;
  timer;
  sweeping = false;
  /** 是否已完成首轮基线扫描（首轮不通知）。 */
  seeded = false;
  /** 绑定状态库与推送实现。 */
  constructor(options) {
    this.store = options.store;
    this.push = options.push;
    this.poll_ms = options.poll_ms ?? Number(process.env.DSH_CODEX_WATCH_MS ?? "8000");
    this.codex_home = options.codex_home ?? process.env.CODEX_HOME ?? join6(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".codex");
    this.summary_limit = options.summary_limit ?? Number(process.env.DSH_CODEX_SUMMARY_LIMIT ?? "1800");
  }
  /** 开始监视；幂等。 */
  start() {
    if (this.timer !== void 0) return;
    const timer = setInterval(() => {
      void this.sweep();
    }, this.poll_ms);
    timer.unref?.();
    this.timer = timer;
    probe("codex-watch", "start", { poll_ms: this.poll_ms, codex_home: this.codex_home });
    void this.sweep();
  }
  /** 停止监视；幂等。 */
  stop() {
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    probe("codex-watch", "stop");
  }
  /** 扫一轮：读取最近的 Codex 会话状态，检测"刚完成"并推送。 */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const statuses = this.read_statuses();
      if (statuses.length === 0) return;
      for (const item of statuses) {
        const key = "codex_watch:" + item.thread_id;
        const signature = `${item.status}|${item.event_at ?? ""}`;
        const previous = await this.store.get_meta(key);
        if (previous === signature) continue;
        await this.store.set_meta(key, signature);
        if (!this.seeded) continue;
        if (item.status !== "\u5DF2\u5B8C\u6210" && item.status !== "\u5DF2\u4E2D\u6B62") continue;
        const text = this.compose(item);
        probe("codex-watch", "notify", {
          thread_id: item.thread_id,
          status: item.status,
          event_at: item.event_at
        });
        for (const user_id of await this.store.list_users()) await this.push(user_id, text);
      }
      this.seeded = true;
    } catch (error) {
      probe("codex-watch", "sweep_failed", { error: String(error) });
    } finally {
      this.sweeping = false;
    }
  }
  /** 组装通知文本。 */
  compose(item) {
    const summary = item.status === "\u5DF2\u4E2D\u6B62" ? "\uFF08\u4EFB\u52A1\u88AB\u4E2D\u6B62\uFF09" : this.latest_assistant_text(item.rollout_path).slice(0, this.summary_limit);
    const name2 = item.workspace.split(/[\\/]/).filter(Boolean).pop() ?? item.workspace;
    return [
      `Codex \u4EFB\u52A1${item.status}`,
      `\u9879\u76EE\uFF1A${name2}`,
      `\u4EFB\u52A1\uFF1A${item.title.slice(0, 80)}`,
      "",
      "\u7ED3\u679C\uFF1A",
      summary || "\uFF08\u6CA1\u6709\u53D6\u5230\u7ED3\u679C\u6587\u672C\uFF09"
    ].join("\n");
  }
  /** 读取最近的非归档 Codex 会话状态（只读，不打扰 Codex）。 */
  read_statuses(limit = 8) {
    const state_path = join6(this.codex_home, "state_5.sqlite");
    if (!existsSync5(state_path)) return [];
    let db;
    try {
      db = new DatabaseSync2(state_path, { readOnly: true });
      const rows = db.prepare(
        "SELECT id, rollout_path, cwd, title, updated_at FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?"
      ).all(limit);
      return rows.map((row) => {
        const rollout = String(row.rollout_path ?? "");
        const { status, event_at } = this.read_lifecycle(rollout);
        return {
          thread_id: String(row.id),
          rollout_path: rollout,
          workspace: normalize_path(String(row.cwd ?? "")),
          title: this.latest_user_message(rollout) || String(row.title ?? "\u672A\u547D\u540D\u4EFB\u52A1"),
          status,
          ...event_at === void 0 ? {} : { event_at }
        };
      });
    } catch (error) {
      probe("codex-watch", "state_db_failed", { error: String(error) });
      return [];
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }
  /** 从 rollout 尾部找最近的生命周期事件（倒序扫描，避免读整个大文件）。 */
  read_lifecycle(rollout_path) {
    if (!rollout_path || !existsSync5(rollout_path)) return { status: "\u8BB0\u5F55\u7F3A\u5931" };
    const patterns = [
      ['"type":"task_complete"', "\u5DF2\u5B8C\u6210"],
      ['"type":"turn_aborted"', "\u5DF2\u4E2D\u6B62"],
      ['"type":"task_started"', "\u8FD0\u884C\u4E2D"]
    ];
    try {
      const size = statSync2(rollout_path).size;
      const block = 512 * 1024;
      const handle = readFileSync4(rollout_path);
      const tail = handle.subarray(Math.max(0, size - block)).toString("utf8");
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        for (const [marker, status] of patterns) {
          if (!line.includes(marker)) continue;
          const at = line.match(/"timestamp":"([^"]+)"/);
          return { status, ...at === null ? {} : { event_at: at[1] } };
        }
      }
    } catch (error) {
      probe("codex-watch", "rollout_read_failed", { error: String(error), rollout_path });
    }
    return { status: "\u7B49\u5F85\u9996\u6B21\u8FD0\u884C" };
  }
  /** 取最近一条真实用户消息作为任务标题。 */
  latest_user_message(rollout_path) {
    return this.scan_tail(rollout_path, (line) => {
      if (!line.includes('"type":"user_message"')) return void 0;
      try {
        const parsed = JSON.parse(line);
        const message = String(parsed.payload?.message ?? "").trim();
        return clean_user_message(message) || void 0;
      } catch {
        return void 0;
      }
    }) ?? "";
  }
  /** 取最近一条助手回答文本。 */
  latest_assistant_text(rollout_path) {
    let latest = "";
    try {
      const text = readFileSync4(rollout_path, "utf8");
      for (const line of text.split("\n")) {
        if (!line.includes('"role":"assistant"')) continue;
        try {
          const parsed = JSON.parse(line);
          const payload = parsed.payload;
          if (parsed.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant") continue;
          const parts = (payload.content ?? []).map((part) => part.text ?? part.output_text ?? "").filter((item) => item.length > 0);
          if (parts.length > 0) latest = parts.join("\n").trim();
        } catch {
          continue;
        }
      }
    } catch (error) {
      probe("codex-watch", "assistant_read_failed", { error: String(error) });
    }
    return latest;
  }
  /** 从文件尾部往前找第一个满足条件的行（避免全文件解析）。 */
  scan_tail(rollout_path, pick) {
    if (!existsSync5(rollout_path)) return void 0;
    try {
      const size = statSync2(rollout_path).size;
      const block = 1024 * 1024;
      const data = readFileSync4(rollout_path);
      const tail = data.subarray(Math.max(0, size - block)).toString("utf8");
      const lines = tail.split("\n");
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const value = pick(lines[i]);
        if (value !== void 0) return value;
      }
    } catch {
      return void 0;
    }
    return void 0;
  }
};
function clean_user_message(message) {
  const marker = "## My request for Codex:";
  let text = message;
  if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length);
  text = text.trim();
  if (text.startsWith("<environment_context>") || text.startsWith("<permissions instructions>")) return "";
  return text;
}
function normalize_path(path) {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

// backend/packages/webhook/webhook-weixin/src/coordination/opencodeBridge.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
var DEFAULT_WORKSPACE2 = process.env.DSH_OPENCODE_WORKSPACE?.trim() || process.cwd();
var RUN_TIMEOUT_MS2 = Number(process.env.DSH_OPENCODE_TIMEOUT_MS ?? String(30 * 6e4));
function kill_tree(child) {
  const pid = child.pid;
  if (pid === void 0) {
    child.kill();
    return;
  }
  if (process.platform === "win32") {
    spawn2("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  child.kill("SIGKILL");
}
function resolve_bin() {
  const configured = process.env.OPENCODE_BIN;
  if (configured !== void 0 && configured.trim() && existsSync6(configured.trim())) return configured.trim();
  const fallback = "opencode";
  return existsSync6(fallback) ? fallback : "opencode";
}
function strip_ansi(text) {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "");
}
var DEFAULT_MODEL_CHAIN = [
  "opencode-go/deepseek-v4.1-flash",
  "dahuangfen/gpt-5.6-sol",
  "volcengine/deepseek-v4-flash-ga-260731"
];
var CONNECTIVITY_FAILURE = /Cannot connect|ProviderHeaderTimeoutError|AI_APICallError|not supported by any configured account|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|connect timeout|socket hang up|socket connection unexpectedly closed|stream error|ProviderError/i;
var APPROVAL_TTL_MS = Number(process.env.DSH_OPENCODE_APPROVAL_TTL_MS ?? String(30 * 6e4));
function parse_opencode_command(text) {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  let rest;
  if (lower.startsWith("/opencode")) rest = trimmed.slice(9).trim();
  else if (lower.startsWith("/oc ")) rest = trimmed.slice(3).trim();
  else if (lower === "/oc") rest = "";
  if (rest === void 0) return void 0;
  if (rest === "") return { action: "help", text: "" };
  const [head, ...tail] = rest.split(/\s+/);
  const keyword = (head ?? "").toLowerCase();
  const body = tail.join(" ").trim();
  if (keyword === "stop" || keyword === "\u505C\u6B62") return { action: "stop", text: body };
  if (keyword === "status" || keyword === "\u72B6\u6001") return { action: "status", text: body };
  if (keyword === "new" || keyword === "\u65B0\u5F00") return { action: "new", text: body };
  if (keyword === "help" || keyword === "\u5E2E\u52A9") return { action: "help", text: body };
  if (keyword === "yes" || keyword === "\u540C\u610F" || keyword === "ok") return { action: "yes", text: body };
  if (keyword === "no" || keyword === "\u4E0D\u540C\u610F" || keyword === "\u4E0D\u7528" || keyword === "\u53D6\u6D88") return { action: "no", text: body };
  return { action: "run", text: rest };
}
var OpencodeBridge = class {
  /** 绑定状态库、推送回调、server 地址与工作区。 */
  constructor(store, push, server_url = process.env.OPENCODE_SERVER_URL ?? "http://127.0.0.1:4096", workspace = process.env.DSH_OPENCODE_WORKSPACE ?? DEFAULT_WORKSPACE2) {
    this.store = store;
    this.push = push;
    this.server_url = server_url;
    this.workspace = workspace;
    const configured = process.env.DSH_OPENCODE_MODEL_CHAIN;
    this.chain = configured !== void 0 && configured.trim() !== "" ? configured.split(",").map((item) => item.trim()).filter(Boolean) : DEFAULT_MODEL_CHAIN;
  }
  tasks = /* @__PURE__ */ new Map();
  /** 等用户确认"切火山"的挂起任务。 */
  pending = /* @__PURE__ */ new Map();
  /** 用户已同意切火山；在 TTL 内有效。 */
  approvals = /* @__PURE__ */ new Map();
  chain;
  /** 当前是否在有效期内的"已同意切火山"。 */
  has_volcengine_approval(user_id) {
    const at = this.approvals.get(user_id);
    if (at === void 0) return false;
    if (Date.now() - at > APPROVAL_TTL_MS) {
      this.approvals.delete(user_id);
      return false;
    }
    return true;
  }
  /** 处理一条 `/opencode` 指令。 */
  async handle(user_id, session_id, command, context_token) {
    if (command.action === "help") {
      await this.push(user_id, session_id, [
        "\u8FD9\u91CC\u662F opencode \u8FDC\u7A0B\u63A7\u5236\uFF0C\u7528\u6CD5\uFF1A",
        "- /opencode <\u4EFB\u52A1>     \u4EA4\u7ED9 opencode \u6267\u884C",
        "- /opencode status     \u67E5\u770B\u72B6\u6001",
        "- /opencode stop       \u7EC8\u6B62\u5F53\u524D\u4EFB\u52A1",
        '- /opencode yes|no     \u786E\u8BA4/\u62D2\u7EDD"\u5207\u5230\u706B\u5C71\u6A21\u578B"',
        `\u9ED8\u8BA4\u5DE5\u4F5C\u533A\uFF1A${this.workspace}`,
        `\u6A21\u578B\u4F18\u5148\u7EA7\uFF1A${this.chain.join(" \u2192 ")}`
      ].join("\n"), "assistant", context_token);
      return;
    }
    if (command.action === "yes") {
      const waiting = this.pending.get(user_id);
      if (waiting === void 0) {
        await this.push(user_id, session_id, "\uFF08\u5F53\u524D\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5207\u6362\u8BF7\u6C42\uFF09", "error", context_token);
        return;
      }
      this.pending.delete(user_id);
      this.approvals.set(user_id, Date.now());
      const volcanic = this.chain[2] ?? this.chain[this.chain.length - 1];
      await this.push(user_id, session_id, `\uFF08\u597D\uFF0C\u8FD9\u6B21\u7528\u706B\u5C71\u6A21\u578B ${volcanic} \u7EE7\u7EED\uFF09`, "progress", context_token);
      await this.run(user_id, session_id, waiting.text, context_token, volcanic);
      return;
    }
    if (command.action === "no") {
      const waiting = this.pending.get(user_id);
      if (waiting === void 0) {
        await this.push(user_id, session_id, "\uFF08\u5F53\u524D\u6CA1\u6709\u5F85\u786E\u8BA4\u7684\u5207\u6362\u8BF7\u6C42\uFF09", "error", context_token);
        return;
      }
      this.pending.delete(user_id);
      this.approvals.delete(user_id);
      await this.push(user_id, session_id, "\uFF08\u597D\uFF0C\u90A3\u6211\u505C\u4E0B\u4E86\uFF1Bopencode \u548C\u5927\u9EC4\u8702\u90FD\u4E0D\u901A\uFF0C\u7B49\u4F60\u5904\u7406\u7F51\u7EDC\u6216\u7528\u522B\u7684\u529E\u6CD5\uFF09", "assistant", context_token);
      return;
    }
    if (command.action === "status") {
      const task2 = this.tasks.get(user_id);
      await this.push(
        user_id,
        session_id,
        task2 === void 0 ? "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684 opencode \u4EFB\u52A1\uFF09" : `\uFF08opencode \u6B63\u5728\u8FD0\u884C\uFF1A\u5DF2 ${Math.round((Date.now() - task2.started_at) / 1e3)} \u79D2\uFF09`,
        "assistant",
        context_token
      );
      return;
    }
    if (command.action === "stop") {
      const stopped = this.stop(user_id);
      await this.push(user_id, session_id, stopped ? "\uFF08\u5DF2\u7EC8\u6B62\u5F53\u524D\u7684 opencode \u4EFB\u52A1\uFF09" : "\uFF08\u5F53\u524D\u6CA1\u6709\u6B63\u5728\u8FD0\u884C\u7684 opencode \u4EFB\u52A1\uFF09", "assistant", context_token);
      return;
    }
    if (this.tasks.has(user_id)) {
      await this.push(user_id, session_id, "\uFF08\u5DF2\u7ECF\u6709\u4E00\u4E2A opencode \u4EFB\u52A1\u5728\u8DD1\uFF0C\u7B49\u5B83\u7ED3\u675F\u6216\u5148\u53D1 /opencode stop\uFF09", "error", context_token);
      return;
    }
    if (!command.text.trim()) {
      await this.push(user_id, session_id, "\uFF08/opencode \u540E\u9762\u8981\u8DDF\u5177\u4F53\u4EFB\u52A1\uFF09", "error", context_token);
      return;
    }
    const task = command.text.trim();
    if (this.has_volcengine_approval(user_id) && this.chain.length >= 3) {
      await this.run(user_id, session_id, task, context_token, this.chain[2]);
      return;
    }
    const outcome = await this.try_chain(user_id, session_id, task, context_token, this.chain.slice(0, 2));
    if (outcome === "connectivity_failed") {
      const volcanic = this.chain[2];
      if (volcanic === void 0) {
        await this.push(user_id, session_id, "\uFF08opencode \u548C\u5927\u9EC4\u8702\u90FD\u8FDE\u4E0D\u4E0A\uFF0C\u4E14\u6CA1\u6709\u914D\u7F6E\u7B2C\u4E09\u7EA7\u6A21\u578B\uFF09", "error", context_token);
        return;
      }
      this.pending.set(user_id, {
        text: task,
        ...context_token === void 0 ? {} : { context_token },
        asked_at: Date.now()
      });
      await this.push(user_id, session_id, [
        "opencode\uFF08\u9996\u9009\uFF09\u548C\u5927\u9EC4\u8702\uFF08\u6B21\u9009\uFF09\u90FD\u8FDE\u4E0D\u901A\u3002",
        `\u73B0\u5728\u53EA\u5269\u706B\u5C71\u53EF\u7528\uFF1A${volcanic}`,
        "\u8981\u6211\u5207\u5230\u706B\u5C71\u7EE7\u7EED\u505A\u8FD9\u4E2A\u4EFB\u52A1\u5417\uFF1F",
        "\u56DE\u590D `/opencode yes` \u540C\u610F\uFF0C\u6216 `/opencode no` \u53D6\u6D88\uFF08\u6211\u5C31\u505C\u5728\u8FD9\u91CC\uFF0C\u4E0D\u4F1A\u81EA\u5DF1\u8DF3\u8FC7\u53BB\uFF09\u3002"
      ].join("\n"), "assistant", context_token);
    }
  }
  /**
   * 依次用给定模型尝试任务。
   * @returns 'ok' 表示成功；'connectivity_failed' 表示全部因连通性失败；'failed' 表示任务本身失败。
   */
  async try_chain(user_id, session_id, task, context_token, models) {
    for (const model of models) {
      const result = await this.run(user_id, session_id, task, context_token, model);
      if (result.ok) return "ok";
      if (!result.connectivity) return "failed";
      probe("opencode-bridge", "chain.fallback", { user_id, failed_model: model });
    }
    return "connectivity_failed";
  }
  /** 终止当前任务；返回是否真的终止。 */
  stop(user_id) {
    const task = this.tasks.get(user_id);
    if (task === void 0) return false;
    probe("opencode-bridge", "stop", { user_id, pid: task.child.pid });
    kill_tree(task.child);
    this.tasks.delete(user_id);
    return true;
  }
  /**
   * 执行一次任务：边跑边把有意义的输出行推给用户，结束后给结论。
   * @returns ok=成功；connectivity=连通性失败（调用方据此降级）；否则是任务本身失败。
   */
  async run(user_id, session_id, task_text, context_token, model_override) {
    const bin = resolve_bin();
    const model = model_override ?? process.env.DSH_OPENCODE_MODEL?.trim();
    const args = [
      "run",
      "--auto",
      "--attach",
      this.server_url,
      "--dir",
      this.workspace,
      ...model === void 0 || model === "" ? [] : ["-m", model],
      task_text
    ];
    probe("opencode-bridge", "run.start", {
      user_id,
      workspace: this.workspace,
      model: model ?? "(default)",
      attach: this.server_url,
      task_len: task_text.length
    });
    const window_start = Date.now();
    await this.store.set_meta("oc_bridge_window", JSON.stringify({ start: window_start, end: 0 }));
    await this.push(user_id, session_id, `\uFF08\u597D\u5440\uFF0C\u6211\u8BA9 opencode \u5F00\u59CB\u505A\u4E86\uFF5E${model === void 0 ? "" : "\u6A21\u578B " + model}\uFF09`, "progress", context_token);
    const child = spawn2(bin, args, { cwd: this.workspace, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    this.tasks.set(user_id, { child, started_at: Date.now(), model: model ?? "(default)" });
    const timer = setTimeout(() => {
      probe("opencode-bridge", "run.timeout", { user_id, timeout_ms: RUN_TIMEOUT_MS2 });
      kill_tree(child);
    }, RUN_TIMEOUT_MS2);
    let stderr = "";
    let buffer = "";
    const tail = [];
    const pushed = 0;
    const handle_lines = (raw) => {
      buffer += raw;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const raw_line of lines) {
        const line = strip_ansi(raw_line).trim();
        if (line === "" || line.length < 2) continue;
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    };
    child.stdout?.on("data", (data) => handle_lines(String(data)));
    child.stderr?.on("data", (data) => {
      stderr += String(data);
    });
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.tasks.delete(user_id);
        resolve(result);
      };
      child.on("close", async (code) => {
        handle_lines(buffer);
        await this.store.set_meta("oc_bridge_window", JSON.stringify({ start: window_start, end: Date.now() }));
        const detail = strip_ansi(stderr).split("\n").filter(Boolean).slice(-3).join(" ").slice(0, 300);
        const connectivity = CONNECTIVITY_FAILURE.test(detail);
        probe("opencode-bridge", "run.close", { user_id, code, model, pushed_lines: pushed, connectivity });
        const summary = tail.slice(-15).join("\n").trim();
        if (code === 0) {
          await this.push(
            user_id,
            session_id,
            summary === "" ? "\uFF08opencode \u4EFB\u52A1\u5B8C\u6210\uFF0C\u6CA1\u6709\u8F93\u51FA\u5185\u5BB9\uFF09" : summary,
            "assistant",
            context_token
          );
          finish({ ok: true, connectivity: false });
          return;
        }
        if (!connectivity) {
          await this.push(
            user_id,
            session_id,
            `\uFF08opencode \u9000\u51FA\u7801 ${code}${detail ? "\uFF1A" + detail : ""}\uFF09` + (summary === "" ? "" : `
\u6700\u8FD1\u8F93\u51FA\uFF1A
${summary}`),
            "error",
            context_token
          );
        }
        finish({ ok: false, connectivity });
      });
      child.on("error", async (error) => {
        probe("opencode-bridge", "run.error", { user_id, error: error.message });
        await this.push(user_id, session_id, `\uFF08opencode \u8FDB\u7A0B\u542F\u52A8\u5931\u8D25\uFF1A${error.message}\uFF09`, "error", context_token);
        finish({ ok: false, connectivity: false });
      });
    });
  }
};

// backend/packages/webhook/webhook-weixin/src/coordination/opencodeWatcher.ts
import { DatabaseSync as DatabaseSync3 } from "node:sqlite";
import { existsSync as existsSync7 } from "node:fs";
import { join as join7 } from "node:path";
var OpencodeWatcher = class {
  store;
  push;
  poll_ms;
  data_dir;
  summary_limit;
  idle_ms;
  timer;
  sweeping = false;
  seeded = false;
  /** 绑定状态库与推送实现。 */
  constructor(options) {
    this.store = options.store;
    this.push = options.push;
    this.poll_ms = options.poll_ms ?? Number(process.env.DSH_OPENCODE_WATCH_MS ?? "10000");
    this.data_dir = options.data_dir ?? process.env.OPENCODE_DATA_DIR ?? join7(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".local", "share", "opencode");
    this.summary_limit = options.summary_limit ?? Number(process.env.DSH_OPENCODE_SUMMARY_LIMIT ?? "1800");
    this.idle_ms = options.idle_ms ?? Number(process.env.DSH_OPENCODE_IDLE_MS ?? "8000");
  }
  /** 开始监视；幂等。 */
  start() {
    if (this.timer !== void 0) return;
    const timer = setInterval(() => {
      void this.sweep();
    }, this.poll_ms);
    timer.unref?.();
    this.timer = timer;
    probe("opencode-watch", "start", { poll_ms: this.poll_ms, data_dir: this.data_dir });
    void this.sweep();
  }
  /** 停止监视；幂等。 */
  stop() {
    if (this.timer !== void 0) {
      clearInterval(this.timer);
      this.timer = void 0;
    }
    probe("opencode-watch", "stop");
  }
  /** 手动扫一轮（供测试与诊断直接调用）。 */
  async sweep_once() {
    await this.sweep();
  }
  /** 扫一轮：找出"刚完成"的外部 opencode 会话并推送。 */
  async sweep() {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const db_path = join7(this.data_dir, "opencode.db");
      if (!existsSync7(db_path)) return;
      const sessions = this.read_recent_sessions(db_path);
      for (const session of sessions) {
        if (Date.now() - session.time_updated < this.idle_ms) continue;
        if (await this.within_bridge_window(session.time_created)) {
          probe("opencode-watch", "skip_bridge_session", { session_id: session.id });
          continue;
        }
        const last = this.last_assistant_message(db_path, session.id);
        if (last === void 0) continue;
        const key = "oc_done:" + session.id;
        if (await this.store.get_meta(key) === last.message_id) continue;
        await this.store.set_meta(key, last.message_id);
        if (!this.seeded) continue;
        const text = last.text;
        if (text.trim() === "") continue;
        const task = this.last_user_text(db_path, session.id) || session.title;
        const name2 = session.directory.split(/[\\/]/).filter(Boolean).pop() ?? session.directory;
        const body = [
          "opencode \u4EFB\u52A1\u5B8C\u6210",
          `\u9879\u76EE\uFF1A${name2}`,
          `\u4EFB\u52A1\uFF1A${task.slice(0, 80)}`,
          "",
          "\u7ED3\u679C\uFF1A",
          text.slice(0, this.summary_limit)
        ].join("\n");
        probe("opencode-watch", "notify", { session_id: session.id });
        for (const user_id of await this.store.list_users()) await this.push(user_id, body);
      }
      this.seeded = true;
    } catch (error) {
      probe("opencode-watch", "sweep_failed", { error: String(error) });
    } finally {
      this.sweeping = false;
    }
  }
  /** 该会话是否落在微信桥的运行窗口内（防重复汇报）。 */
  async within_bridge_window(created_at) {
    const raw = await this.store.get_meta("oc_bridge_window");
    if (raw === void 0 || raw === "") return false;
    try {
      const window = JSON.parse(raw);
      const start = window.start ?? 0;
      const end = window.end ?? 0;
      return created_at >= start - 2e3 && (end === 0 || created_at <= end + 15e3);
    } catch {
      return false;
    }
  }
  /** 读取最近更新的会话。 */
  read_recent_sessions(db_path, limit = 10) {
    let db;
    try {
      db = new DatabaseSync3(db_path, { readOnly: true });
      const rows = db.prepare(
        "SELECT id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?"
      ).all(limit);
      return rows;
    } catch (error) {
      probe("opencode-watch", "db_failed", { error: String(error) });
      return [];
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }
  /**
   * 取会话**最后一条助手消息**的 id 与其文本。
   *
   * 先定位最后一条 assistant message（按 message.rowid 倒序），再取该消息的 text 分片——
   * 这样得到的 message_id 就是稳定的"完成指纹"，同一轮完成不会被重复汇报。
   */
  last_assistant_message(db_path, session_id) {
    let db;
    try {
      db = new DatabaseSync3(db_path, { readOnly: true });
      const message = db.prepare(
        `SELECT id FROM message WHERE session_id = ? AND data LIKE '%"role":"assistant"%' ORDER BY rowid DESC LIMIT 1`
      ).get(session_id);
      if (message === void 0) return void 0;
      const rows = db.prepare(
        "SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC"
      ).all(message.id);
      const texts = [];
      for (const row of rows) {
        try {
          const part = JSON.parse(row.data);
          if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
            texts.push(part.text.trim());
            if (texts.join("\n").length > this.summary_limit) break;
          }
        } catch {
        }
      }
      if (texts.length === 0) return void 0;
      return { message_id: message.id, text: texts.join("\n") };
    } catch (error) {
      probe("opencode-watch", "assistant_read_failed", { error: String(error) });
      return void 0;
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
  }
  /** 取会话最后一条用户消息文本（作为任务标题）。 */
  last_user_text(db_path, session_id) {
    let db;
    try {
      db = new DatabaseSync3(db_path, { readOnly: true });
      const rows = db.prepare(
        `SELECT p.data FROM part p JOIN message m ON p.message_id = m.id WHERE p.session_id = ? AND m.data LIKE '%"role":"user"%' ORDER BY p.rowid DESC LIMIT 20`
      ).all(session_id);
      for (const row of rows) {
        try {
          const part = JSON.parse(row.data);
          if (part.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
            return part.text.trim();
          }
        } catch {
        }
      }
    } catch {
      return "";
    } finally {
      try {
        db?.close();
      } catch {
      }
    }
    return "";
  }
};

// backend/packages/webhook/webhook-weixin/src/memory/timelineStore.ts
import { appendFileSync, existsSync as existsSync8, mkdirSync as mkdirSync4, readFileSync as readFileSync6, readdirSync as readdirSync3, statSync as statSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join8 } from "node:path";

// backend/packages/webhook/webhook-weixin/src/memory/fileLock.ts
import { closeSync, openSync, readFileSync as readFileSync5, renameSync, statSync as statSync3, unlinkSync, writeSync } from "node:fs";
function pid_alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function sleep_ms(ms) {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}
function with_file_lock(target_path, fn, options) {
  const timeout_ms = options?.timeout_ms ?? 1e4;
  const stale_ms = options?.stale_ms ?? 3e4;
  const retry_ms = options?.retry_ms ?? 20;
  const lock_path = `${target_path}.lock`;
  const deadline = Date.now() + timeout_ms;
  let handle;
  while (handle === void 0) {
    try {
      handle = openSync(lock_path, "wx");
      writeSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const info = JSON.parse(readFileSync5(lock_path, "utf8"));
        const age = Date.now() - (info.at ?? 0);
        stale = age > stale_ms || !pid_alive(info.pid);
      } catch {
        try {
          stale = Date.now() - statSync3(lock_path).mtimeMs > stale_ms;
        } catch {
          stale = true;
        }
      }
      if (stale) {
        probe("lock", "stale_taken_over", { lock_path });
        try {
          unlinkSync(lock_path);
        } catch {
        }
        continue;
      }
      if (Date.now() > deadline) {
        probe("lock", "timeout", { lock_path, timeout_ms });
        throw new Error(`\u7B49\u9501\u8D85\u65F6\uFF08${timeout_ms}ms\uFF09\uFF1A${lock_path}\u3002\u4E3A\u907F\u514D\u8986\u76D6\u5176\u5B83\u8FDB\u7A0B\u7684\u5408\u6CD5\u5199\u5165\uFF0C\u672C\u6B21\u5199\u5165\u653E\u5F03\u3002`);
      }
      sleep_ms(retry_ms);
    }
  }
  try {
    return fn();
  } finally {
    try {
      closeSync(handle);
    } catch {
    }
    try {
      unlinkSync(lock_path);
    } catch {
    }
  }
}
function rename_with_retry(from, to, attempts = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = error.code;
      if (attempt >= attempts - 1 || code !== "EPERM" && code !== "EBUSY") throw error;
      sleep_ms(15 * (attempt + 1));
    }
  }
}

// backend/packages/webhook/webhook-weixin/src/memory/timelineStore.ts
var DEFAULT_TIMEZONE = "Asia/Shanghai";
var INDEX_VERSION = 1;
var TimelineStore = class {
  dir;
  days_dir;
  timezone;
  persist_reasoning;
  idle_ms;
  /**
   * 已写入记录 id 的内存缓存（按天）。
   *
   * 用途：append 的幂等校验本来要读整天文件（O(n)），1000 条时是 O(n²)。
   * 用 `文件大小:mtime` 当缓存键——文件没变就直接复用，append 变成 O(1)。
   * 别的进程改了文件，键会变，缓存自动失效（配合 file lock 保证一致）。
   */
  id_cache = /* @__PURE__ */ new Map();
  /** 视图（.md）待重建的日期；惰性重建，避免每次 append 都重写 Markdown。 */
  dirty_views = /* @__PURE__ */ new Set();
  /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
  tmp_seq = 0;
  /** 正在重建索引：防止 load_index ↔ rebuild_index 互相递归。 */
  rebuilding_index = false;
  /** 每日元数据的内存缓存（追加时增量更新，避免每次重算整天）。 */
  meta_cache = /* @__PURE__ */ new Map();
  constructor(options) {
    this.dir = options.dir;
    this.days_dir = join8(this.dir, "days");
    this.timezone = options.timezone ?? DEFAULT_TIMEZONE;
    this.persist_reasoning = options.persist_reasoning ?? process.env.DSH_TIMELINE_PERSIST_REASONING === "1";
    this.idle_ms = options.idle_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? "3")) * 36e5;
    this.ensure_dirs();
  }
  // ── 更新 ────────────────────────────────────────────────────────────────
  /**
   * 追加一条记录（幂等：同一 id 重复追加会被忽略）。
   *
   * @returns `true` 表示真的写入；`false` 表示这条 id 已存在。
   */
  /** 存储目录（清空记忆时需要，避免调用方另算一遍路径）。 */
  dir_path() {
    return this.dir;
  }
  /**
   * 确保存储目录存在（含 `days/` 子目录）。
   *
   * **清空记忆之后必须调用**：清空会连 `days/` 一起删掉，而 store 实例是长驻的，
   * 不会自己重建——下一次 append 就会 ENOENT（实测 2026-09-21 23:46 那轮就撞上了）。
   * 构造函数与 append 也会调用它，所以外部删目录同样能自愈。
   */
  ensure_dirs() {
    mkdirSync4(this.days_dir, { recursive: true });
  }
  /**
   * 丢掉全部内存缓存。
   *
   * **外部清空目录之后必须调用**：`meta_cache` 是按天缓存的，文件被删掉了它却还在，
   * 于是 `list_days()` 会继续列出早已不存在的天。id 缓存虽按 `size:mtime` 校验，
   * 但也一并清掉更省心。
   */
  forget_caches() {
    this.id_cache.clear();
    this.meta_cache.clear();
    probe("timeline", "caches.forgotten", {});
  }
  append(entry) {
    this.ensure_dirs();
    const date = this.day_key(entry.ts);
    const path = this.entries_path(date);
    const record = this.persist_reasoning ? entry : { ...entry, reasoning: void 0 };
    const line = JSON.stringify(strip_undefined(record));
    const written = with_file_lock(path, () => {
      const ids = this.known_ids(date);
      if (ids.has(entry.id)) {
        probe("timeline", "append.duplicate", { date, id: entry.id });
        return false;
      }
      const base = this.base_meta(date);
      appendFileSync(path, `${line}
`, "utf8");
      ids.add(entry.id);
      this.set_meta(date, increment_meta(base, entry));
      this.dirty_views.add(date);
      return true;
    });
    if (written) {
      this.regenerate_view_if_due(date);
      probe("timeline", "append.ok", { date, role: entry.role, id: entry.id, chars: entry.text.length });
    }
    return written;
  }
  /**
   * 该日期已知的记录 id 集合（带 mtime 缓存）。
   *
   * 文件被别的进程改过（大小/mtime 变化）时会重新读，保证跨进程也准确。
   */
  known_ids(date) {
    const path = this.entries_path(date);
    const stat = existsSync8(path) ? statSync4(path) : void 0;
    const key = stat === void 0 ? "missing" : `${stat.size}:${stat.mtimeMs}`;
    const cached = this.id_cache.get(date);
    if (cached !== void 0 && cached.key === key) return cached.ids;
    const ids = new Set(this.read_entries(date).map((item) => item.id));
    this.id_cache.set(date, { key, ids });
    return ids;
  }
  /**
   * 取某日"当前基数"（追加前）。
   *
   * 优先用内存缓存（热路径 O(1)）；缓存冷时**从记录文件算**，而不是信索引——
   * 索引只是缓存，记录文件才是权威。
   */
  base_meta(date) {
    const cached = this.meta_cache.get(date);
    if (cached !== void 0) return cached;
    const entries = this.read_entries(date);
    const meta = this.meta_from_entries(date, entries);
    this.meta_cache.set(date, meta);
    return meta;
  }
  /** 写入某日的元数据（覆盖，不累加）。 */
  set_meta(date, meta) {
    this.meta_cache.set(date, meta);
    const index = this.load_index();
    this.save_index({ ...index, days: { ...index.days, [date]: meta } });
  }
  /** 由记录列表直接算元数据（不读索引，避免递归/双重计数）。 */
  meta_from_entries(date, entries) {
    const ts = entries.map((item) => item.ts);
    return strip_undefined({
      date,
      timezone: this.timezone,
      entries: entries.length,
      user_entries: entries.filter((item) => item.role === "user").length,
      assistant_entries: entries.filter((item) => item.role === "assistant").length,
      first_ts: ts.length === 0 ? void 0 : Math.min(...ts),
      last_ts: ts.length === 0 ? void 0 : Math.max(...ts),
      updated_at: Date.now()
    });
  }
  /** 视图惰性重建：同一日期最多每 5 秒重建一次，且文件缺失时必建。 */
  regenerate_view_if_due(date) {
    if (!this.dirty_views.has(date)) return;
    const path = this.view_path(date);
    const stat = existsSync8(path) ? statSync4(path) : void 0;
    if (stat !== void 0 && Date.now() - stat.mtimeMs < 5e3) return;
    this.regenerate_view(date);
    this.dirty_views.delete(date);
  }
  /** 强制把所有待重建的视图刷出来（调度器空闲时调用）。 */
  flush_views() {
    for (const date of [...this.dirty_views]) {
      this.regenerate_view(date);
      this.dirty_views.delete(date);
    }
  }
  /**
   * 批量追加；返回真正写入的条数。用于恢复/回填历史。
   */
  append_many(entries) {
    let written = 0;
    for (const entry of entries) {
      if (this.append(entry)) written += 1;
    }
    return written;
  }
  /**
   * 给某条记录补写媒体引用/描述（记录本身是 append-only，这里做定点改写）。
   *
   * 为什么需要它：消息先落盘（拿到事实），媒体要等下载完才拿得到引用、
   * 描述更要等视觉模型跑完；这两件事都比"记下这句话"晚，所以必须能后补。
   * 改写是**整天重写 + 原子替换**（一天记录量很小），失败也不会留下半截文件。
   *
   * @returns 是否命中并改写。
   */
  update_entry(date, entry_id, patch) {
    assert_day_key(date);
    const path = this.entries_path(date);
    return with_file_lock(path, () => {
      const entries = this.read_entries(date);
      const index = entries.findIndex((item) => item.id === entry_id);
      if (index < 0) {
        probe("timeline", "entry.update_miss", { date, id: entry_id });
        return false;
      }
      const current = entries[index];
      const next = strip_undefined({
        ...current,
        ...patch.text === void 0 ? {} : { text: patch.text },
        ...patch.attachments === void 0 ? {} : { attachments: patch.attachments }
      });
      entries[index] = next;
      this.write_atomic(path, `${entries.map((item) => JSON.stringify(strip_undefined(item))).join("\n")}
`);
      this.refresh_meta(date);
      this.regenerate_view(date);
      this.dirty_views.delete(date);
      probe("timeline", "entry.updated", {
        date,
        id: entry_id,
        attachments: patch.attachments?.length
      });
      return true;
    });
  }
  /**
   * 给某条记录里的某个附件补上描述（视觉模型跑完后回填）。
   *
   * @returns 是否命中并写入。
   */
  update_attachment_description(date, entry_id, attachment_id, description) {
    const entry = this.read_entries(date).find((item) => item.id === entry_id);
    if (entry?.attachments === void 0) return false;
    const next = entry.attachments.map((item) => item.id === attachment_id ? strip_undefined({ ...item, description }) : item);
    if (!next.some((item, i) => item.description !== entry.attachments?.[i]?.description)) return false;
    return this.update_entry(date, entry_id, { attachments: next });
  }
  /**
   * 更新某一日的摘要（权威来源是 `days/<date>.summary.md`，可人工编辑）。
   *
   * @param date - `YYYY-MM-DD`。
   * @param summary - 摘要正文；空字符串表示清空。
   * @param meta - 可选的生成信息（例如模型名），会写进索引。
   */
  update_summary(date, summary, meta) {
    assert_day_key(date);
    this.write_atomic(this.summary_path(date), summary.trim() === "" ? "" : `${summary.trim()}
`);
    const index = this.load_index();
    const current = index.days[date] ?? this.empty_meta(date);
    const next = strip_undefined({
      ...current,
      summary_updated_at: Date.now(),
      summary_model: meta?.model ?? current.summary_model,
      updated_at: Date.now()
    });
    this.save_index({ ...index, days: { ...index.days, [date]: next } });
    this.regenerate_view(date);
    this.dirty_views.delete(date);
    probe("timeline", "summary.updated", { date, chars: summary.length, model: meta?.model });
  }
  /** 从权威记录重新生成人类可读视图（`<date>.md`）；人工改过视图时用它复原。 */
  regenerate_view(date) {
    assert_day_key(date);
    const entries = this.read_entries(date);
    const meta = this.meta_for(date, entries);
    const summary = this.read_summary(date);
    this.write_atomic(this.view_path(date), render_view(meta, summary, entries));
  }
  /**
   * 重建索引：**直接扫 `days/*.jsonl`**（权威数据），不信任 index.json。
   *
   * 这是索引损坏时的自愈路径——审计复现过"损坏索引后旧日期彻底不可发现"，
   * 而记录文件其实还在。所以读取路径发现索引缺失/损坏时必须自动走这里。
   */
  rebuild_index() {
    const dates = existsSync8(this.days_dir) ? readdirSync3(this.days_dir).filter((name2) => name2.endsWith(".jsonl")).map((name2) => name2.slice(0, -".jsonl".length)).sort() : [];
    const days = {};
    for (const date of dates) days[date] = this.meta_for(date, this.read_entries(date));
    this.save_index({ version: INDEX_VERSION, timezone: this.timezone, updated_at: Date.now(), days });
    this.id_cache.clear();
    this.meta_cache.clear();
    for (const [date, meta] of Object.entries(days)) this.meta_cache.set(date, meta);
    probe("timeline", "index.rebuilt", { days: dates.length });
    return dates.length;
  }
  // ── 摘要触发（按"空闲"而不是按整点）────────────────────────────────────
  /**
   * 找出"该更新摘要"的日期。
   *
   * 判定两条同时成立：
   * 1. **已经空闲**：距该日最后一条记录 ≥ `idle_ms`（默认 3 小时）——
   *    说明这段对话讲完了，现在总结不会再反复重写；
   * 2. **有待总结的内容**：还没有摘要，或上次摘要之后又新增了记录。
   *
   * @param now - 当前时间（便于测试注入）。
   */
  days_needing_summary(now = Date.now()) {
    const index = this.load_index();
    const out = [];
    for (const meta of Object.values(index.days)) {
      if (meta.entries === 0 || meta.last_ts === void 0) continue;
      if (now - meta.last_ts < this.idle_ms) continue;
      const summarized_at = meta.summary_updated_at ?? 0;
      if (summarized_at >= meta.last_ts) continue;
      out.push(meta.date);
    }
    return out.sort();
  }
  /**
   * 用注入的摘要器更新指定日期的摘要。
   *
   * @param date - `YYYY-MM-DD`。
   * @param summarize - 摘要实现（本地 Gemma / 云端模型都行）。
   * @returns 摘要文本；该日没有记录时返回 undefined（不写空摘要）。
   */
  async summarize_day(date, summarize) {
    assert_day_key(date);
    const entries = this.read_entries(date);
    if (entries.length === 0) return void 0;
    const previous = this.read_summary(date);
    const result = await summarize({
      date,
      timezone: this.timezone,
      entries,
      ...previous === void 0 ? {} : { previous_summary: previous }
    });
    const text = result.text.trim();
    if (text === "") return void 0;
    this.update_summary(date, text, {
      ...result.model === void 0 ? {} : { model: result.model }
    });
    return text;
  }
  /** 扫描并按需更新所有到期摘要；返回更新过的日期。 */
  async summarize_due(summarize, now = Date.now()) {
    const done = [];
    for (const date of this.days_needing_summary(now)) {
      try {
        const text = await this.summarize_day(date, summarize);
        if (text !== void 0) done.push(date);
      } catch (error) {
        probe("timeline", "summary.failed", { date, error: String(error) });
      }
    }
    return done;
  }
  // ── 读取 ────────────────────────────────────────────────────────────────
  /** 读一天的 node（摘要 + 记录 + 元数据）；可用 filter 按人/会话过滤。 */
  read_day(date, filter) {
    assert_day_key(date);
    const all = this.read_entries(date);
    const entries = filter === void 0 ? all : all.filter((item) => match_filter(item, filter));
    const summary = this.read_summary(date);
    return {
      // 元数据按**过滤后**的口径给，避免调用方拿到和 entries 不一致的计数。
      meta: this.meta_for(date, entries),
      ...summary === void 0 ? {} : { summary },
      entries
    };
  }
  /**
   * 读一段日期区间（含两端）。
   *
   * @param from - 起始 `YYYY-MM-DD`。
   * @param to - 结束 `YYYY-MM-DD`；缺省等于 `from`。
   */
  read_range(from, to) {
    const end = to ?? from;
    assert_day_key(from);
    assert_day_key(end);
    return this.list_days().map((meta) => meta.date).filter((date) => date >= from && date <= end).map((date) => this.read_day(date));
  }
  /** 列出所有 node 的元数据（按日期升序）。 */
  list_days() {
    const index = this.load_index();
    return Object.values(index.days).sort((a, b) => a.date.localeCompare(b.date));
  }
  /** 读原始摘要文本；没有则 undefined。 */
  read_summary(date) {
    const path = this.summary_path(date);
    if (!existsSync8(path)) return void 0;
    const text = readFileSync6(path, "utf8").trim();
    return text === "" ? void 0 : text;
  }
  /**
   * 跨天全文搜索（大小写不敏感的朴素子串匹配）。
   *
   * 长期记忆规模有限（一天一个文件），朴素扫描足够；命中按时间倒序返回。
   */
  search(keyword, options) {
    const needle = keyword.trim().toLowerCase();
    if (needle === "") return [];
    const limit = options?.limit ?? 50;
    const filter = {
      ...options?.user_id === void 0 ? {} : { user_id: options.user_id },
      ...options?.session_id === void 0 ? {} : { session_id: options.session_id }
    };
    const hits = [];
    const dates = this.list_days().map((meta) => meta.date).reverse();
    for (const date of dates) {
      if (options?.from !== void 0 && date < options.from) continue;
      if (options?.to !== void 0 && date > options.to) continue;
      for (const entry of this.read_entries(date)) {
        if (!match_filter(entry, filter)) continue;
        if (entry.text.toLowerCase().includes(needle)) hits.push({ date, entry });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }
  /** 全局统计。 */
  stats() {
    const days = this.list_days();
    return strip_undefined({
      days: days.length,
      entries: days.reduce((sum, meta) => sum + meta.entries, 0),
      first_date: days[0]?.date,
      last_date: days[days.length - 1]?.date
    });
  }
  // ── 内部：路径与日期 ────────────────────────────────────────────────────
  /** 时间戳 → 时区内的日期键。 */
  day_key(ts) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ts));
  }
  entries_path(date) {
    return join8(this.days_dir, `${date}.jsonl`);
  }
  summary_path(date) {
    return join8(this.days_dir, `${date}.summary.md`);
  }
  view_path(date) {
    return join8(this.days_dir, `${date}.md`);
  }
  index_path() {
    return join8(this.dir, "index.json");
  }
  // ── 内部：读写 ──────────────────────────────────────────────────────────
  read_entries(date) {
    const path = this.entries_path(date);
    if (!existsSync8(path)) return [];
    const out = [];
    for (const line of readFileSync6(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        out.push(JSON.parse(trimmed));
      } catch {
        probe("timeline", "entries.bad_line", { date });
      }
    }
    return out;
  }
  meta_for(date, entries) {
    const index = this.load_index();
    const stored = index.days[date];
    const ts = entries.map((entry) => entry.ts);
    return strip_undefined({
      date,
      timezone: this.timezone,
      entries: entries.length,
      user_entries: entries.filter((entry) => entry.role === "user").length,
      assistant_entries: entries.filter((entry) => entry.role === "assistant").length,
      first_ts: ts.length === 0 ? void 0 : Math.min(...ts),
      last_ts: ts.length === 0 ? void 0 : Math.max(...ts),
      updated_at: stored?.updated_at ?? Date.now(),
      summary_updated_at: stored?.summary_updated_at,
      summary_model: stored?.summary_model
    });
  }
  empty_meta(date) {
    return {
      date,
      timezone: this.timezone,
      entries: 0,
      user_entries: 0,
      assistant_entries: 0,
      updated_at: Date.now()
    };
  }
  refresh_meta(date) {
    const index = this.load_index();
    const entries = this.read_entries(date);
    const next = strip_undefined({
      ...this.meta_from_entries(date, entries),
      summary_updated_at: index.days[date]?.summary_updated_at,
      summary_model: index.days[date]?.summary_model
    });
    this.meta_cache.set(date, next);
    this.save_index({ ...index, days: { ...index.days, [date]: next } });
  }
  /**
   * 读索引；**缺失或损坏时自动从权威 JSONL 重建**。
   *
   * 审计复现过：索引坏掉后旧日期"数据还在但彻底不可发现"（list_days/search/摘要调度都看不到）。
   * 所以这里不能返回空索引了事——记录文件才是权威，索引只是缓存，坏了就重建。
   */
  load_index() {
    const path = this.index_path();
    if (!existsSync8(path)) return this.rebuild_from_disk();
    try {
      const parsed = JSON.parse(readFileSync6(path, "utf8"));
      if (parsed.version !== INDEX_VERSION || typeof parsed.days !== "object" || parsed.days === null) {
        probe("timeline", "index.invalid_shape", { path });
        return this.rebuild_from_disk();
      }
      return parsed;
    } catch {
      probe("timeline", "index.corrupt", { path });
      return this.rebuild_from_disk();
    }
  }
  /** 从磁盘重建索引（带递归保护：重建期间再问索引就返回空表）。 */
  rebuild_from_disk() {
    const empty = { version: INDEX_VERSION, timezone: this.timezone, updated_at: Date.now(), days: {} };
    if (this.rebuilding_index) return empty;
    this.rebuilding_index = true;
    try {
      this.rebuild_index();
    } catch (error) {
      probe("timeline", "index.rebuild_failed", { error: String(error) });
      return empty;
    } finally {
      this.rebuilding_index = false;
    }
    try {
      return JSON.parse(readFileSync6(this.index_path(), "utf8"));
    } catch {
      return empty;
    }
  }
  save_index(index) {
    this.write_atomic(this.index_path(), `${JSON.stringify({ ...index, updated_at: Date.now() }, null, 2)}
`);
  }
  /**
   * 原子写：临时文件 + rename。
   *
   * 临时名带**进程内递增序号**：同一进程同一毫秒的两次写不会撞名
   * （只带 pid 会撞，因为 pid 相同）；rename 带重试，Windows 并发时偶发 EPERM。
   */
  write_atomic(path, content) {
    this.tmp_seq += 1;
    const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`;
    writeFileSync3(tmp, content, "utf8");
    rename_with_retry(tmp, path);
  }
};
function increment_meta(base, entry) {
  return strip_undefined({
    ...base,
    entries: base.entries + 1,
    user_entries: base.user_entries + (entry.role === "user" ? 1 : 0),
    assistant_entries: base.assistant_entries + (entry.role === "assistant" ? 1 : 0),
    first_ts: base.first_ts === void 0 ? entry.ts : Math.min(base.first_ts, entry.ts),
    last_ts: base.last_ts === void 0 ? entry.ts : Math.max(base.last_ts, entry.ts),
    updated_at: Date.now()
  });
}
function match_filter(entry, filter) {
  if (filter.user_id !== void 0 && entry.user_id !== filter.user_id) return false;
  if (filter.session_id !== void 0 && entry.session_id !== filter.session_id) return false;
  return true;
}
function assert_day_key(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`\u975E\u6CD5\u7684\u65E5\u671F\u952E\uFF1A${date}\uFF08\u5E94\u4E3A YYYY-MM-DD\uFF09`);
}
function strip_undefined(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== void 0) out[key] = item;
  }
  return out;
}
function render_view(meta, summary, entries) {
  const lines = [];
  lines.push("---");
  lines.push(`date: ${meta.date}`);
  lines.push(`timezone: ${meta.timezone}`);
  lines.push(`entries: ${meta.entries}`);
  lines.push(`user_entries: ${meta.user_entries}`);
  lines.push(`assistant_entries: ${meta.assistant_entries}`);
  if (meta.first_ts !== void 0) lines.push(`first_at: ${iso(meta.first_ts, meta.timezone)}`);
  if (meta.last_ts !== void 0) lines.push(`last_at: ${iso(meta.last_ts, meta.timezone)}`);
  lines.push(`updated_at: ${iso(meta.updated_at, meta.timezone)}`);
  if (meta.summary_updated_at !== void 0) lines.push(`summary_updated_at: ${iso(meta.summary_updated_at, meta.timezone)}`);
  if (meta.summary_model !== void 0) lines.push(`summary_model: ${meta.summary_model}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${meta.date}`);
  lines.push("");
  lines.push("## \u6458\u8981");
  lines.push("");
  lines.push("<!-- \u6743\u5A01\u6765\u6E90\uFF1A\u540C\u76EE\u5F55 <date>.summary.md\uFF1B\u672C\u6587\u4EF6\u662F\u751F\u6210\u89C6\u56FE\uFF0C\u52FF\u624B\u6539\u3002 -->");
  lines.push("");
  lines.push(summary ?? "\uFF08\u5C1A\u672A\u751F\u6210\uFF09");
  lines.push("");
  lines.push("## \u8BB0\u5F55");
  lines.push("");
  lines.push("<!-- \u6743\u5A01\u6765\u6E90\uFF1A\u540C\u76EE\u5F55 <date>.jsonl\uFF1B\u672C\u6587\u4EF6\u662F\u751F\u6210\u89C6\u56FE\uFF0C\u52FF\u624B\u6539\u3002 -->");
  lines.push("");
  for (const entry of entries) {
    lines.push(`### ${clock(entry.ts, meta.timezone)} \xB7 ${entry.role === "user" ? "\u7528\u6237" : "\u6B23\u7231"}`);
    lines.push("");
    if (entry.text.trim() !== "") lines.push(entry.text.trim());
    for (const item of entry.attachments ?? []) {
      const size = item.bytes === void 0 ? "" : `\uFF08${Math.round(item.bytes / 1024)}KB\uFF09`;
      const dims = item.width !== void 0 && item.height !== void 0 ? ` ${item.width}\xD7${item.height}` : "";
      lines.push(`- [${item.media_type}]${dims}${size} \u9644\u4EF6 ${item.id}${item.name === void 0 ? "" : ` \xB7 ${item.name}`}`);
      if (item.description !== void 0) lines.push(`  - \u5185\u5BB9\uFF1A${item.description}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}
`;
}
function clock(ts, timezone) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ts));
}
function iso(ts, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(ts));
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(new Date(ts)).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const zone = offset === "GMT" ? "+00:00" : offset.replace("GMT", "");
  return `${parts.replace(", ", "T").replace(/\//g, "-")}${zone}`;
}

// backend/packages/webhook/webhook-weixin/src/memory/memoryRemoteClient.ts
var MemoryRemoteClient = class {
  base_url;
  api_key;
  timeout_ms;
  constructor(options = {}) {
    this.base_url = (options.base_url ?? process.env.SYNLOVE_MEMORY_BASE_URL ?? "http://127.0.0.1:8797/v1").replace(/\/+$/, "");
    this.api_key = options.api_key ?? process.env.SYNLOVE_MEMORY_API_KEY ?? "";
    this.timeout_ms = Math.max(1e3, Math.min(12e4, options.timeout_ms ?? 3e4));
  }
  /** 追加一条时间线记录；返回是否真的写入。 */
  async append(entry) {
    const result = await this.call("memory_append", { entry });
    return result.written === true;
  }
  /** 按服务约定时区把时间戳转换为日期键。 */
  day_key(ts) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(ts));
  }
  /** 列出日期索引。 */
  async list_days() {
    const result = await this.call("memory_days", { limit: 100 });
    return Array.isArray(result.days) ? result.days : [];
  }
  /** 读取某日摘要。 */
  async read_summary(date) {
    const result = await this.call("memory_read", { date, includeEntries: false });
    return typeof result.summary === "string" && result.summary !== "" ? result.summary : void 0;
  }
  /** 读取某一天的完整时间线。 */
  async read_day(date, filter) {
    const day = await this.call("memory_read", { date, includeEntries: true });
    let entries = Array.isArray(day.entries) ? day.entries : [];
    if (filter?.user_id !== void 0) entries = entries.filter((item) => item.user_id === filter.user_id);
    if (filter?.session_id !== void 0) entries = entries.filter((item) => item.session_id === filter.session_id);
    const summary = typeof day.summary === "string" && day.summary !== "" ? day.summary : void 0;
    return {
      ...summary === void 0 ? {} : { summary },
      entries,
      meta: {
        date: String(day.date ?? date),
        timezone: "Asia/Shanghai",
        entries: entries.length,
        user_entries: entries.filter((item) => item.role === "user").length,
        assistant_entries: entries.filter((item) => item.role === "assistant").length,
        updated_at: Date.now()
      }
    };
  }
  /** 按日期和稳定 ID 更新记录字段。 */
  async update_entry(date, entry_id, patch) {
    const result = await this.call("memory_update_entry", { date, entryId: entry_id, patch });
    return result.updated === true;
  }
  /** 更新媒体附件的描述。 */
  async update_attachment_description(date, entry_id, attachment_id, description) {
    const result = await this.call("memory_update_attachment", {
      date,
      entryId: entry_id,
      attachmentId: attachment_id,
      description
    });
    return result.updated === true;
  }
  /** 更新某日摘要。 */
  async update_summary(date, summary, meta) {
    const result = await this.call("memory_update_summary", { date, summary, ...meta === void 0 ? {} : { meta } });
    return result.updated === true;
  }
  /** 返回已达到空闲阈值、且尚未生成摘要的日期。 */
  async days_needing_summary(now = Date.now()) {
    const dates = await this.list_days();
    const due = [];
    const idle_ms = Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? "3")) * 36e5;
    for (const item of dates) {
      if (item.last_ts === void 0 || now - item.last_ts < idle_ms) continue;
      if (await this.read_summary(item.date) === void 0) due.push(item.date);
    }
    return due;
  }
  /** 调用注入的摘要器并把结果提交给远程记忆服务。 */
  async summarize_due(summarizer, now = Date.now()) {
    const updated = [];
    for (const date of await this.days_needing_summary(now)) {
      const day = await this.read_day(date);
      const result = await summarizer({
        date,
        timezone: "Asia/Shanghai",
        entries: day.entries,
        ...day.summary === void 0 ? {} : { previous_summary: day.summary }
      });
      if (await this.update_summary(date, result.text, { model: result.model ?? "" })) updated.push(date);
    }
    return updated;
  }
  /** 读取时间线统计。 */
  async stats() {
    const days = await this.list_days();
    const result = {
      days: days.length,
      entries: days.reduce((sum, day) => sum + day.entries, 0)
    };
    if (days.length > 0) {
      const first = days[days.length - 1]?.date;
      const last = days[0]?.date;
      if (first !== void 0) result.first_date = first;
      if (last !== void 0) result.last_date = last;
    }
    return result;
  }
  /** 按关键词搜索时间线。 */
  async search(keyword, options = {}) {
    const result = await this.call("memory_search", { keyword, limit: options.limit ?? 20 });
    const hits = Array.isArray(result.hits) ? result.hits : [];
    return hits.filter((hit) => options.from === void 0 || hit.date >= options.from).filter((hit) => options.to === void 0 || hit.date <= options.to);
  }
  /** 读取一个日期或日期区间。 */
  async read_range(from, to, filter) {
    const end = to ?? from;
    const days = await this.list_days();
    const selected = days.map((item) => item.date).filter((date) => date >= from && date <= end).slice(-3);
    const result = [];
    for (const date of selected) {
      const day = await this.call("memory_read", { date, includeEntries: true });
      let entries = Array.isArray(day.entries) ? day.entries : [];
      if (filter?.user_id !== void 0) entries = entries.filter((item) => item.user_id === filter.user_id);
      if (filter?.session_id !== void 0) entries = entries.filter((item) => item.session_id === filter.session_id);
      const summary = typeof day.summary === "string" && day.summary !== "" ? day.summary : void 0;
      result.push({
        ...summary === void 0 ? {} : { summary },
        entries,
        meta: {
          date: day.date,
          timezone: "Asia/Shanghai",
          entries: entries.length,
          user_entries: entries.filter((item) => item.role === "user").length,
          assistant_entries: entries.filter((item) => item.role === "assistant").length,
          updated_at: Date.now()
        }
      });
    }
    return result;
  }
  /** 读取图谱快照。 */
  async snapshot() {
    const result = await this.call("graph_snapshot");
    return {
      nodes: Array.isArray(result.nodes) ? result.nodes : [],
      edges: Array.isArray(result.edges) ? result.edges : []
    };
  }
  /** 确保图谱中心节点存在。 */
  async ensure_center() {
    await this.call("graph_ensure_center");
  }
  /** 新增或更新人物节点。 */
  async upsert_person(person) {
    const result = await this.call("graph_upsert_person", { person });
    return result.person;
  }
  /** 新增或更新关系边。 */
  async upsert_edge(edge) {
    const result = await this.call("graph_upsert_edge", { edge });
    return result.edge;
  }
  /** 读取图谱增量水位。 */
  async last_update_ms() {
    const result = await this.call("graph_watermark");
    return typeof result.ts === "number" ? result.ts : void 0;
  }
  /** 读取同一毫秒下已处理的记录 ID。 */
  async last_update_ids() {
    const result = await this.call("graph_watermark");
    return Array.isArray(result.ids) ? result.ids.filter((id) => typeof id === "string") : [];
  }
  /** 提交图谱增量水位。 */
  async set_last_update(ts, ids) {
    await this.call("graph_watermark", { update: { ts, ids } });
  }
  /** 找到人物节点。 */
  async find(name_or_id) {
    const snapshot = await this.snapshot();
    const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, "");
    return snapshot.nodes.find((node) => node.id === name_or_id || node.name.toLocaleLowerCase().replace(/\s+/g, "") === needle || (node.aliases ?? []).some((alias) => alias.toLocaleLowerCase().replace(/\s+/g, "") === needle));
  }
  /** 返回全部节点。 */
  async nodes() {
    return [...(await this.snapshot()).nodes];
  }
  /** 返回从某节点出发的边。 */
  async edges_from(id) {
    return (await this.snapshot()).edges.filter((edge) => edge.from === id);
  }
  /** 返回指向某节点的边。 */
  async edges_to(id) {
    return (await this.snapshot()).edges.filter((edge) => edge.to === id);
  }
  /** 返回节点属性；年龄等派生字段由服务端存储值直接提供。 */
  async attributes(name2) {
    return this.find(name2);
  }
  /** 返回某人的关系网。 */
  async neighborhood(name2, options = {}) {
    const snapshot = await this.snapshot();
    const start = await this.find_in_snapshot(snapshot, name2);
    if (start === void 0) return [];
    const max_depth = Math.max(1, Math.min(6, options.max_depth ?? 2));
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const outgoing = /* @__PURE__ */ new Map();
    for (const edge of snapshot.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
    const seen = /* @__PURE__ */ new Map();
    let frontier = [start.id];
    for (let depth = 1; depth <= max_depth; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (edge.to === start.id || seen.has(edge.to)) continue;
          seen.set(edge.to, { name: nodes.get(edge.to)?.name ?? edge.to, label: edge.label, depth });
          next.push(edge.to);
        }
      }
      frontier = next;
    }
    return [...seen.values()];
  }
  /** 查找两人之间的简单路径。 */
  async paths(from_name, to_name, options = {}) {
    const snapshot = await this.snapshot();
    const start = await this.find_in_snapshot(snapshot, from_name);
    const end = await this.find_in_snapshot(snapshot, to_name);
    if (start === void 0 || end === void 0) return [];
    const max_depth = Math.max(1, Math.min(8, options.max_depth ?? 4));
    const nodes = new Map(snapshot.nodes.map((node) => [node.id, node]));
    const outgoing = /* @__PURE__ */ new Map();
    for (const edge of snapshot.edges) outgoing.set(edge.from, [...outgoing.get(edge.from) ?? [], edge]);
    const result = [];
    const walk = (current, visited, hops) => {
      if (current === end.id && hops.length > 0) {
        result.push({
          node_ids: [start.id, ...hops.map((edge) => edge.to)],
          names: [start.name, ...hops.map((edge) => nodes.get(edge.to)?.name ?? edge.to)],
          hops: hops.map((edge) => ({ from: edge.from, to: edge.to, label: edge.label })),
          readable: [start.name, ...hops.map((edge) => nodes.get(edge.to)?.name ?? edge.to)].join(" \u2192 ")
        });
        return;
      }
      if (hops.length >= max_depth) return;
      for (const edge of outgoing.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        visited.add(edge.to);
        walk(edge.to, visited, [...hops, edge]);
        visited.delete(edge.to);
      }
    };
    walk(start.id, /* @__PURE__ */ new Set([start.id]), []);
    return result.sort((a, b) => a.hops.length - b.hops.length);
  }
  async find_in_snapshot(snapshot, name_or_id) {
    const needle = name_or_id.trim().toLocaleLowerCase().replace(/\s+/g, "");
    return snapshot.nodes.find((node) => node.id === name_or_id || node.name.toLocaleLowerCase().replace(/\s+/g, "") === needle || (node.aliases ?? []).some((alias) => alias.toLocaleLowerCase().replace(/\s+/g, "") === needle));
  }
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
          requestId: `memory-${crypto.randomUUID()}`,
          message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name2, arguments: arguments_ } }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`memory \u670D\u52A1 HTTP ${response.status}`);
      let operation = await response.json();
      while (operation.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const id = String(operation.requestId ?? "");
        const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(id)}`, {
          headers: this.api_key === "" ? {} : { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal
        });
        operation = await status.json();
      }
      if (operation.state !== "done") throw new Error(`memory \u670D\u52A1\u4EFB\u52A1\u72B6\u6001 ${String(operation.state)}`);
      const result = operation.result?.result ?? operation.result;
      if (result?.isError === true) throw new Error(String(result.content ?? "memory \u670D\u52A1\u8C03\u7528\u5931\u8D25"));
      return result?.structuredContent ?? {};
    } finally {
      clearTimeout(timer);
    }
  }
};

// backend/packages/webhook/webhook-weixin/src/memory/timelineTools.ts
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";

// backend/packages/webhook/webhook-weixin/src/memory/MemoryToolRegistry.ts
var MemoryToolRegistry = class {
  static bound = /* @__PURE__ */ new WeakMap();
  /** ctx 为作用域，key 为工具组，install 接收受事务保护的注册函数；成功后记录，卸载时移除。 */
  static register_tools(ctx, key, install) {
    const groups = this.bound.get(ctx) ?? /* @__PURE__ */ new Set();
    if (groups.has(key)) return;
    const releases = [];
    try {
      install((tool) => {
        releases.push(ctx.tools.register(tool));
      });
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    groups.add(key);
    this.bound.set(ctx, groups);
    if (typeof ctx.effect === "function") {
      ctx.effect(() => () => {
        for (const release of releases.reverse()) release();
        groups.delete(key);
      }, `shared-memory.${key}`);
    }
  }
};

// backend/packages/webhook/webhook-weixin/src/memory/timelineTools.ts
var MAX_CHARS = 6e3;
function clip(text) {
  return text.length <= MAX_CHARS ? text : `${text.slice(0, MAX_CHARS)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u5171 ${text.length} \u5B57\u7B26\uFF1B\u8BF7\u7F29\u5C0F\u8303\u56F4\u91CD\u67E5\uFF09`;
}
function as_date(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? value.trim() : void 0;
}
function register_timeline_tools(agent_ctx, store) {
  MemoryToolRegistry.register_tools(agent_ctx, "timeline", (register) => {
    register(defineTool2({
      name: "timeline_days",
      description: [
        '\u67E5\u770B"\u957F\u671F\u8BB0\u5FC6\u91CC\u6709\u54EA\u4E9B\u5929"\uFF0C\u4EE5\u53CA\u6BCF\u5929\u7684\u5BF9\u8BDD\u6761\u6570\u548C\u5F53\u5929\u6458\u8981\u3002\u8FD9\u662F\u6700\u4FBF\u5B9C\u7684\u4E00\u5C42\u3002',
        "",
        "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
        '- \u7528\u6237\u63D0\u5230"\u524D\u51E0\u5929/\u4E0A\u6B21/\u6700\u8FD1"\u8FD9\u7C7B\u6A21\u7CCA\u65F6\u95F4\uFF0C\u4F60\u4E0D\u786E\u5B9A\u5177\u4F53\u662F\u54EA\u5929\uFF1B',
        '- \u7528\u6237\u95EE"\u8FD9\u51E0\u5929\u90FD\u804A\u4E86\u4EC0\u4E48/\u6700\u8FD1\u600E\u4E48\u6837"\uFF1B',
        "- \u4F60\u60F3\u5148\u770B\u770B\u8BB0\u5FC6\u91CC\u6709\u6CA1\u6709\u76F8\u5173\u5185\u5BB9\uFF0C\u518D\u51B3\u5B9A\u8981\u4E0D\u8981\u7EC6\u67E5\u3002",
        "",
        "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
        '- \u5F53\u524D\u5BF9\u8BDD\u91CC\u5DF2\u7ECF\u6709\u7684\u4FE1\u606F\uFF0C\u4E0D\u8981\u4E3A\u4E86"\u786E\u8BA4"\u518D\u67E5\u4E00\u904D\uFF1B',
        '- \u4E0E\u7528\u6237\u5F53\u524D\u8BF7\u6C42\u65E0\u5173\u65F6\uFF0C\u4E0D\u8981\u4E3A\u4E86"\u66F4\u4E86\u89E3\u4ED6"\u800C\u4E3B\u52A8\u7FFB\u8BB0\u5FC6\u3002',
        "",
        "\u7528\u6CD5\u5EFA\u8BAE\uFF1A\u5148\u8C03\u7528\u5B83\u62FF\u5230\u65E5\u671F\uFF0C\u518D\u7528 timeline_read \u8BFB\u67D0\u4E00\u5929\u7684\u7EC6\u8282\u3002"
      ].join("\n"),
      parameters: {
        limit: {
          type: "number",
          description: "\u6700\u591A\u5217\u51FA\u6700\u8FD1\u591A\u5C11\u5929\uFF0C\u9ED8\u8BA4 14\u3002"
        },
        include_summary: {
          type: "boolean",
          description: "\u662F\u5426\u4E00\u5E76\u8FD4\u56DE\u6BCF\u5929\u7684\u6458\u8981\uFF08\u9ED8\u8BA4 true\uFF1B\u5173\u6389\u53EA\u8FD4\u56DE\u65E5\u671F\u4E0E\u6761\u6570\uFF0C\u66F4\u7701\uFF09\u3002"
        }
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
        render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
      },
      async execute(args) {
        const days = await store.list_days();
        if (days.length === 0) return { ok: true, text: "\u957F\u671F\u8BB0\u5FC6\u91CC\u8FD8\u6CA1\u6709\u4EFB\u4F55\u8BB0\u5F55\u3002" };
        const limit = Math.max(1, Math.min(120, Number(args.limit) || 14));
        const picked = days.slice(-limit).reverse();
        const with_summary = args.include_summary !== false;
        const lines = await Promise.all(picked.map(async (meta) => {
          const head = `- ${meta.date}\uFF08${meta.entries} \u6761\uFF1A\u7528\u6237 ${meta.user_entries} / \u6211 ${meta.assistant_entries}\uFF09`;
          if (!with_summary) return head;
          const summary = await store.read_summary(meta.date);
          return summary === void 0 ? `${head}
  \u6458\u8981\uFF1A\uFF08\u5C1A\u672A\u751F\u6210\uFF09` : `${head}
  \u6458\u8981\uFF1A${summary.replace(/\n/g, " / ")}`;
        }));
        const stats = await store.stats();
        return {
          ok: true,
          text: clip(`\u5171 ${stats.days} \u5929\u8BB0\u5FC6\uFF08${stats.first_date ?? "?"} ~ ${stats.last_date ?? "?"}\uFF09\uFF0C\u6700\u8FD1 ${picked.length} \u5929\uFF1A

` + lines.join("\n"))
        };
      }
    }));
    register(defineTool2({
      name: "timeline_search",
      description: [
        "\u5728\u957F\u671F\u8BB0\u5FC6\u91CC\u6309\u5173\u952E\u8BCD\u641C\u7D22\uFF0C\u8FD4\u56DE**\u547D\u4E2D\u7684\u65E5\u671F + \u8C01\u8BF4\u7684 + \u7247\u6BB5**\u3002\u4E2D\u95F4\u5C42\u3002",
        "",
        "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
        '- \u7528\u6237\u8BF4"\u6211\u4E4B\u524D\u4E0D\u662F\u8BF4\u8FC7\u2026/\u4F60\u8FD8\u8BB0\u5F97\u2026\u5417"\uFF0C\u4F60\u8981\u5148\u786E\u8BA4\u6709\u6CA1\u6709\u3001\u5728\u54EA\u5929\uFF1B',
        '- \u8981\u56DE\u5FC6\u67D0\u4E2A\u4EBA\u540D\u3001\u5730\u70B9\u3001\u4E8B\u9879\u3001\u504F\u597D\uFF08\u4F8B\u5982"\u623F\u79DF""\u590D\u67E5""\u5988\u5988"\uFF09\uFF1B',
        "- \u60F3\u627E\u67D0\u4E2A\u8BDD\u9898\u6700\u65E9/\u6700\u8FD1\u4E00\u6B21\u51FA\u73B0\u3002",
        "",
        "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
        '- \u522B\u7528\u5B83\u6765"\u904D\u5386\u6240\u6709\u8BB0\u5FC6"\uFF1A\u4E00\u6B21\u53EA\u641C\u4E00\u4E2A\u5177\u4F53\u5173\u952E\u8BCD\uFF0C\u4E0D\u8981\u62FF"\u7684""\u4E86"\u8FD9\u7C7B\u5E38\u89C1\u5B57\u53BB\u641C\uFF1B',
        "- \u5DF2\u77E5\u5177\u4F53\u65E5\u671F\u65F6\u76F4\u63A5\u7528 timeline_read\uFF0C\u4E0D\u5FC5\u641C\u3002",
        "",
        "\u8FD4\u56DE\u7684\u53EA\u662F\u7247\u6BB5\uFF1B\u8981\u770B\u4E0A\u4E0B\u6587\uFF0C\u518D\u7528 timeline_read \u8BFB\u90A3\u4E00\u5929\u3002"
      ].join("\n"),
      parameters: {
        keyword: {
          type: "string",
          required: true,
          description: '\u8981\u641C\u7D22\u7684\u5173\u952E\u8BCD\uFF08\u4F8B\u5982"\u623F\u79DF"\u3001"\u533B\u9662"\uFF09\u3002\u4E00\u6B21\u4E00\u4E2A\uFF0C\u5C3D\u91CF\u5177\u4F53\u3002'
        },
        from: { type: "string", description: "\u8D77\u59CB\u65E5\u671F YYYY-MM-DD\uFF08\u53EF\u9009\uFF09\u3002" },
        to: { type: "string", description: "\u7ED3\u675F\u65E5\u671F YYYY-MM-DD\uFF08\u53EF\u9009\uFF09\u3002" },
        limit: { type: "number", description: "\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u6761\u547D\u4E2D\uFF0C\u9ED8\u8BA4 20\u3002" }
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
        render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
      },
      async execute(args) {
        const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
        if (keyword === "") return { ok: false, text: "\u9700\u8981\u4E00\u4E2A\u975E\u7A7A keyword\u3002" };
        const from = as_date(args.from);
        const to = as_date(args.to);
        const hits = await store.search(keyword, {
          limit: Math.max(1, Math.min(100, Number(args.limit) || 20)),
          ...from === void 0 ? {} : { from },
          ...to === void 0 ? {} : { to }
        });
        if (hits.length === 0) return { ok: true, text: `\u6CA1\u6709\u627E\u5230\u5305\u542B"${keyword}"\u7684\u8BB0\u5F55\u3002\u4E0D\u8981\u731C\u5185\u5BB9\uFF0C\u5982\u5B9E\u544A\u8BC9\u7528\u6237\u6CA1\u627E\u5230\u3002` };
        const lines = hits.map((hit) => `- ${hit.date} ${hit.entry.role === "user" ? "\u7528\u6237" : "\u6211"}\uFF1A${hit.entry.text.replace(/\n/g, " ")}`);
        return {
          ok: true,
          text: clip(`\u5305\u542B"${keyword}"\u7684\u8BB0\u5F55\uFF08${hits.length} \u6761\uFF0C\u65B0\u7684\u5728\u524D\uFF09\uFF1A

${lines.join("\n")}

\u8981\u770B\u5B8C\u6574\u4E0A\u4E0B\u6587\uFF0C\u7528 timeline_read \u8BFB\u5BF9\u5E94\u65E5\u671F\u3002`)
        };
      }
    }));
    register(defineTool2({
      name: "timeline_read",
      description: [
        "\u8BFB\u67D0\u4E00\u5929\uFF08\u6216\u4E00\u6BB5\u65E5\u671F\uFF09\u7684\u957F\u671F\u8BB0\u5FC6\uFF1A**\u5F53\u5929\u7684\u6458\u8981 + \u9010\u53E5\u539F\u6587**\u3002\u6700\u8D35\u7684\u4E00\u5C42\uFF0C\u8BF7\u6700\u540E\u7528\u3002",
        "",
        "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
        "- \u5DF2\u7ECF\u7528 timeline_search / timeline_days \u5B9A\u4F4D\u5230\u67D0\u5929\uFF0C\u73B0\u5728\u9700\u8981\u770B\u5F53\u65F6\u5230\u5E95\u8BF4\u4E86\u4EC0\u4E48\uFF1B",
        '- \u7528\u6237\u660E\u786E\u95EE"X \u6708 X \u65E5\u90A3\u5929\u6211\u4EEC\u804A\u4E86\u4EC0\u4E48"\uFF1B',
        "- \u8981\u6062\u590D\u67D0\u4E2A\u4E8B\u9879\u7684\u5B8C\u6574\u80CC\u666F\uFF08\u65F6\u95F4\u3001\u6570\u5B57\u3001\u627F\u8BFA\uFF09\u3002",
        "",
        "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
        "- **\u4E0D\u8981**\u4E3A\u4E86\u56DE\u7B54\u666E\u901A\u95EE\u9898\u800C\u4E00\u6B21\u8BFB\u5F88\u591A\u5929\uFF1B\u5355\u6B21\u6700\u591A\u8BFB 3 \u5929\uFF0C\u4E14\u4F18\u5148\u53EA\u8BFB\u6458\u8981\u786E\u8BA4\u771F\u6709\u9700\u8981\u518D\u770B\u539F\u6587\uFF1B",
        '- \u4E0D\u8981\u51ED\u8BB0\u5FC6\u91CC\u7684"\u5927\u6982\u65E5\u671F"\u53CD\u590D\u8BD5\u9519\uFF1B\u4E0D\u786E\u5B9A\u65E5\u671F\u5C31\u5148 timeline_days\u3002',
        "",
        "\u6CE8\u610F\uFF1A\u8FD9\u4E9B\u662F\u7528\u6237\u8BF4\u8FC7\u7684\u539F\u8BDD\u4E0E\u4F60\u7684\u5386\u53F2\u56DE\u590D\uFF0C\u5C5E\u4E8E\u9690\u79C1\u5185\u5BB9\uFF0C\u53EA\u7528\u4E8E\u56DE\u7B54\u7528\u6237\u672C\u4EBA\u3002"
      ].join("\n"),
      parameters: {
        date: {
          type: "string",
          required: true,
          description: "\u8981\u8BFB\u53D6\u7684\u65E5\u671F YYYY-MM-DD\u3002"
        },
        to: {
          type: "string",
          description: "\u7ED3\u675F\u65E5\u671F YYYY-MM-DD\uFF08\u53EF\u9009\uFF09\u3002\u7ED9\u533A\u95F4\u65F6\u4F1A\u8BFB\u591A\u5929\uFF0C\u5355\u6B21\u6700\u591A 3 \u5929\u3002"
        },
        include_entries: {
          type: "boolean",
          description: "\u662F\u5426\u5305\u542B\u9010\u53E5\u539F\u6587\uFF08\u9ED8\u8BA4 true\uFF09\u3002\u53EA\u60F3\u770B\u6458\u8981\u65F6\u8BBE false\uFF0C\u66F4\u7701\u3002"
        }
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
        render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
      },
      async execute(args) {
        const date = as_date(args.date);
        if (date === void 0) return { ok: false, text: "date \u5FC5\u987B\u662F YYYY-MM-DD \u683C\u5F0F\u3002" };
        const to = as_date(args.to) ?? date;
        const days = await store.read_range(date, to);
        const non_empty = days.filter((day) => day.entries.length > 0);
        if (non_empty.length === 0) {
          return { ok: true, text: `${date}${to === date ? "" : " ~ " + to} \u6CA1\u6709\u5BF9\u8BDD\u8BB0\u5F55\u3002\u4E0D\u8981\u7F16\u9020\u5185\u5BB9\u3002` };
        }
        const with_entries = args.include_entries !== false;
        const blocks = non_empty.map((day) => {
          const head = `## ${day.meta.date}\uFF08${day.meta.entries} \u6761\uFF09`;
          const summary = `\u6458\u8981\uFF1A${day.summary ?? "\uFF08\u5C1A\u672A\u751F\u6210\uFF09"}`;
          if (!with_entries) return `${head}
${summary}`;
          const entries = day.entries.map((item) => `[${item.role === "user" ? "\u7528\u6237" : "\u6211"}] ${item.text}`);
          return `${head}
${summary}

${entries.join("\n")}`;
        });
        return { ok: true, text: clip(blocks.join("\n\n")) };
      }
    }));
  });
}

// backend/packages/webhook/webhook-weixin/src/memory/graphStore.ts
import { existsSync as existsSync9, mkdirSync as mkdirSync5, readFileSync as readFileSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join9 } from "node:path";

// backend/packages/webhook/webhook-weixin/src/memory/graphTypes.ts
var GRAPH_ASSISTANT_NAME = "\u6B23\u7231";
var GRAPH_USER_NAME = "\u4E3B\u4EBA";

// backend/packages/webhook/webhook-weixin/src/memory/graphStore.ts
var DEFAULT_MAX_DEPTH = 4;
var KnowledgeGraphStore = class {
  dir;
  /** 临时文件序号（同进程同毫秒多次写不撞名）。 */
  tmp_seq = 0;
  constructor(options) {
    this.dir = options.dir;
    mkdirSync5(this.dir, { recursive: true });
  }
  // ── 读取 ────────────────────────────────────────────────────────────────
  /** 全部节点。 */
  nodes() {
    return read_jsonl(this.nodes_path());
  }
  /** 全部边。 */
  edges() {
    return read_jsonl(this.edges_path());
  }
  snapshot() {
    return { nodes: this.nodes(), edges: this.edges() };
  }
  /** 按 id 或姓名/别名找人（姓名匹配忽略大小写与空格）。 */
  find(name_or_id) {
    const needle = normalize(name_or_id);
    if (needle === "") return void 0;
    return this.nodes().find((node) => node.id === name_or_id || normalize(node.name) === needle || (node.aliases ?? []).some((alias) => normalize(alias) === needle));
  }
  /** 某人对外（他称呼别人）的边。 */
  edges_from(id) {
    return this.edges().filter((edge) => edge.from === id);
  }
  /** 别人对某人的边（别人怎么称呼他）。 */
  edges_to(id) {
    return this.edges().filter((edge) => edge.to === id);
  }
  /**
   * 查询 A 与 B 之间的链路（**支持"朋友的朋友"这种多跳**）。
   *
   * 从 `from` 出发按有向边广度优先，找出所有到 `to` 的简单路径（不重复经过同一节点），
   * 深度上限默认 4 跳。深度必须限制：再远的关系已经解释不动，而且搜索会爆炸。
   *
   * @returns 按跳数从短到长排序的链路；没有通路返回空数组。
   */
  paths(from_name, to_name, options) {
    const start = this.find(from_name);
    const end = this.find(to_name);
    if (start === void 0 || end === void 0) return [];
    const max_depth = Math.max(1, Math.min(8, options?.max_depth ?? DEFAULT_MAX_DEPTH));
    const nodes = new Map(this.nodes().map((node) => [node.id, node]));
    const outgoing = /* @__PURE__ */ new Map();
    for (const edge of this.edges()) {
      const list = outgoing.get(edge.from) ?? [];
      list.push(edge);
      outgoing.set(edge.from, list);
    }
    const results = [];
    const walk = (current, visited, hops) => {
      if (current === end.id && hops.length > 0) {
        results.push(build_path(hops, nodes));
        return;
      }
      if (hops.length >= max_depth) return;
      for (const edge of outgoing.get(current) ?? []) {
        if (visited.has(edge.to)) continue;
        if (edge.to === end.id) {
          results.push(build_path([...hops, edge], nodes));
          continue;
        }
        visited.add(edge.to);
        walk(edge.to, visited, [...hops, edge]);
        visited.delete(edge.to);
      }
    };
    walk(start.id, /* @__PURE__ */ new Set([start.id]), []);
    return results.sort((a, b) => a.hops.length - b.hops.length);
  }
  /**
   * 某人的关系网（向外 expand 多少跳），用于"他身边都有谁"这类问题。
   */
  neighborhood(name2, options) {
    const start = this.find(name2);
    if (start === void 0) return [];
    const max_depth = Math.max(1, Math.min(6, options?.max_depth ?? 2));
    const nodes = new Map(this.nodes().map((node) => [node.id, node]));
    const outgoing = /* @__PURE__ */ new Map();
    for (const edge of this.edges()) {
      const list = outgoing.get(edge.from) ?? [];
      list.push(edge);
      outgoing.set(edge.from, list);
    }
    const seen = /* @__PURE__ */ new Map();
    let frontier = [start.id];
    for (let depth = 1; depth <= max_depth; depth += 1) {
      const next = [];
      for (const id of frontier) {
        for (const edge of outgoing.get(id) ?? []) {
          if (edge.to === start.id || seen.has(edge.to)) continue;
          seen.set(edge.to, {
            name: nodes.get(edge.to)?.name ?? edge.to,
            label: edge.label,
            depth
          });
          next.push(edge.to);
        }
      }
      frontier = next;
    }
    return [...seen.values()];
  }
  /** 人物属性（含由生日推算的年龄）。 */
  attributes(name2) {
    const node = this.find(name2);
    if (node === void 0) return void 0;
    const age = node.age ?? age_from_birthday(node.birthday);
    return age === void 0 ? node : { ...node, age };
  }
  // ── 初始化 ──────────────────────────────────────────────────────────────
  /**
   * 建立（或修复）图谱的中心——**欣爱是绝对中心**。
   *
   * 做三件事，全部幂等，所以启动时无脑调用即可：
   * 1. **只建两个中心节点**：`欣爱` 与 `主人`。除姓名外不预设任何属性——
   *    图谱应该是"聊到什么补什么"，凭空写一个"状态：unknown"只会变成噪音。
   * 2. **建立两人互相的称呼**：欣爱→主人 标 `主人`（她这么称呼他），
   *    主人→欣爱 标 `欣爱`。这两条边给了所有多跳查询一个共同起点。
   * 3. **迁移历史数据**：早期版本把用户节点叫"我"（还硬写了 `status: unknown`），
   *    这里就地改名为"主人"，并把"我"保留成别名——于是按"我""用户"仍然查得到，
   *    已有边因为存的是 id，完全不受影响。
   */
  ensure_center() {
    const user_exists = this.find(GRAPH_USER_NAME) !== void 0;
    let changed = false;
    const migrated = this.nodes().map((node) => {
      let next = node;
      if (!user_exists && normalize(node.name) === "\u6211") {
        next = strip_undefined2({
          ...next,
          name: GRAPH_USER_NAME,
          aliases: merge_list(next.aliases, ["\u6211"])
        });
        probe("graph", "center.migrated_self", { id: node.id });
      }
      if (next.status === "unknown") next = strip_undefined2({ ...next, status: void 0 });
      if (next !== node) changed = true;
      return next;
    });
    if (changed) this.write_nodes(migrated);
    for (const name2 of [GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME]) {
      if (this.find(name2) === void 0) {
        this.upsert_person({ name: name2, evidence: { date: today(), note: "\u56FE\u8C31\u4E2D\u5FC3\u8282\u70B9" } });
        probe("graph", "center.created", { name: name2 });
      }
    }
    this.upsert_edge({ from: GRAPH_ASSISTANT_NAME, to: GRAPH_USER_NAME, label: GRAPH_USER_NAME, kind: "address" });
    this.upsert_edge({ from: GRAPH_USER_NAME, to: GRAPH_ASSISTANT_NAME, label: GRAPH_ASSISTANT_NAME, kind: "address" });
  }
  // ── 更新 ────────────────────────────────────────────────────────────────
  /**
   * 新增或更新一个人（按姓名/别名匹配已有节点；匹配不到就新建）。
   *
   * **改名只认显式 id**：只有调用方给出 `id`（说明它已经解析出"这是谁"）时，
   * `name` 才会被当成新正名。否则用别名调用（"妈妈"→已存在的"王丽"）会把正名
   * 覆盖成别名，节点从此在"王丽"名下查不到——这个坑实测踩过。
   *
   * @returns 落库后的节点。
   */
  upsert_person(input) {
    return with_file_lock(this.nodes_path(), () => this.upsert_person_locked(input));
  }
  upsert_person_locked(input) {
    const existing = input.id === void 0 ? this.find(input.name) : this.nodes().find((n) => n.id === input.id);
    const nodes = this.nodes();
    const now = Date.now();
    if (existing === void 0) {
      const node = strip_undefined2({
        id: this.next_id(),
        name: input.name.trim(),
        aliases: input.aliases,
        birthday: input.birthday,
        age: input.age,
        gender: input.gender,
        status: input.status,
        contacts: input.contacts,
        location: input.location,
        occupation: input.occupation,
        family_summary: input.family_summary,
        important_dates: input.important_dates,
        notes: input.notes,
        updated_at: now,
        sources: input.evidence === void 0 ? void 0 : [input.evidence]
      });
      nodes.push(node);
      this.write_nodes(nodes);
      probe("graph", "person.created", { id: node.id, name: node.name });
      return node;
    }
    const requested = input.name.trim();
    const renaming = input.id !== void 0 && requested !== "" && normalize(requested) !== normalize(existing.name);
    const merged = strip_undefined2({
      ...existing,
      name: input.id === void 0 || requested === "" ? existing.name : requested,
      // 改名时把旧正名收成别名：改名后按老名字依然找得到这个人
      aliases: merge_list(renaming ? merge_list(existing.aliases, [existing.name]) : existing.aliases, input.aliases),
      birthday: input.birthday ?? existing.birthday,
      age: input.age ?? existing.age,
      gender: input.gender ?? existing.gender,
      status: input.status ?? existing.status,
      contacts: merge_list(existing.contacts, input.contacts),
      location: input.location ?? existing.location,
      occupation: input.occupation ?? existing.occupation,
      family_summary: input.family_summary ?? existing.family_summary,
      important_dates: merge_dates(existing.important_dates, input.important_dates),
      notes: input.notes ?? existing.notes,
      updated_at: now,
      sources: merge_evidence(existing.sources, input.evidence)
    });
    this.write_nodes(nodes.map((node) => node.id === existing.id ? merged : node));
    probe("graph", "person.updated", { id: merged.id, name: merged.name });
    return merged;
  }
  /**
   * 新增或更新一条"称呼"边。
   *
   * 同一对人可以有多个称呼（`妈` / `母亲`），所以按 (from,to,label) 去重而不是按 (from,to)。
   */
  upsert_edge(input) {
    return with_file_lock(this.edges_path(), () => this.upsert_edge_locked(input));
  }
  upsert_edge_locked(input) {
    const from = this.find(input.from);
    const to = this.find(input.to);
    if (from === void 0 || to === void 0) {
      probe("graph", "edge.missing_person", { from: input.from, to: input.to });
      return void 0;
    }
    if (from.id === to.id) return void 0;
    const edges = this.edges();
    const label = input.label.trim();
    if (label === "") return void 0;
    const now = Date.now();
    const address = edges.find((edge) => edge.from === from.id && edge.to === to.id && edge.kind === "address");
    if (input.kind === "address" && address !== void 0 && address.label !== label) {
      const merged2 = strip_undefined2({
        ...address,
        label,
        previous_labels: [address.label, ...address.previous_labels ?? []].slice(0, 8),
        updated_at: now,
        sources: merge_evidence(address.sources, input.evidence)
      });
      this.write_edges(edges.map((edge) => edge === address ? merged2 : edge));
      probe("graph", "edge.address_updated", {
        from: from.name,
        to: to.name,
        before: address.label,
        after: label
      });
      return merged2;
    }
    const existing = edges.find((edge) => edge.from === from.id && edge.to === to.id && edge.label === label);
    if (existing === void 0) {
      const edge = strip_undefined2({
        from: from.id,
        to: to.id,
        label,
        kind: input.kind,
        updated_at: now,
        sources: input.evidence === void 0 ? void 0 : [input.evidence]
      });
      edges.push(edge);
      this.write_edges(edges);
      probe("graph", "edge.created", { from: from.name, to: to.name, label });
      return edge;
    }
    const merged = strip_undefined2({
      ...existing,
      kind: input.kind ?? existing.kind,
      updated_at: now,
      sources: merge_evidence(existing.sources, input.evidence)
    });
    this.write_edges(edges.map((edge) => edge === existing ? merged : edge));
    return merged;
  }
  /** 人类可读视图（生成）。 */
  to_markdown() {
    const nodes = this.nodes();
    const edges = this.edges();
    const by_id = new Map(nodes.map((node) => [node.id, node]));
    const lines = ["# \u4EBA\u7269\u5173\u7CFB\u56FE", "", `\u8282\u70B9 ${nodes.length} \xB7 \u79F0\u547C ${edges.length}`, ""];
    for (const node of nodes) {
      lines.push(`## ${node.name}\uFF08${node.id}\uFF09`);
      lines.push("");
      lines.push(`- \u522B\u540D\uFF1A${(node.aliases ?? []).join("\u3001") || "\u2014"}`);
      lines.push(`- \u751F\u65E5\uFF1A${node.birthday ?? "\u2014"}\u3000\u5E74\u9F84\uFF1A${node.age ?? age_from_birthday(node.birthday) ?? "\u2014"}`);
      lines.push(`- \u6027\u522B\uFF1A${node.gender ?? "\u2014"}\u3000\u72B6\u6001\uFF1A${node.status ?? "unknown"}`);
      lines.push(`- \u804C\u4E1A\uFF1A${node.occupation ?? "\u2014"}\u3000\u6240\u5728\u5730\uFF1A${node.location ?? "\u2014"}`);
      lines.push(`- \u8054\u7CFB\u65B9\u5F0F\uFF1A${(node.contacts ?? []).join("\u3001") || "\u2014"}`);
      lines.push(`- \u5BB6\u5EAD\u60C5\u51B5\uFF1A${node.family_summary ?? "\u2014"}`);
      if ((node.important_dates ?? []).length > 0) {
        lines.push(`- \u91CD\u8981\u65E5\u671F\uFF1A${(node.important_dates ?? []).map((d) => `${d.label} ${d.date}`).join("\uFF1B")}`);
      }
      if (node.notes !== void 0) lines.push(`- \u5907\u6CE8\uFF1A${node.notes}`);
      const out = edges.filter((edge) => edge.from === node.id);
      if (out.length > 0) {
        lines.push("");
        lines.push("\u4ED6/\u5979\u662F\u8FD9\u6837\u79F0\u547C\u522B\u4EBA\u7684\uFF1A");
        for (const edge of out) lines.push(`- \u2192 ${by_id.get(edge.to)?.name ?? edge.to}\uFF1A${edge.label}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
  /** 重建人类可读视图。 */
  regenerate_view() {
    this.write_atomic(join9(this.dir, "graph.md"), `${this.to_markdown()}
`);
  }
  /** 统计。 */
  stats() {
    return { people: this.nodes().length, relations: this.edges().length };
  }
  /** 存储目录（清空图谱时需要，避免调用方另算一遍路径）。 */
  dir_path() {
    return this.dir;
  }
  /**
   * 把"消化到哪了"的水位清零。
   *
   * 清空图谱后要调它：否则水位还停在被清掉之前的位置，后续更新只会处理**新**记录，
   * 图谱会一直空着。归零之后，下一次空闲更新会把时间线里的历史重新消化一遍，
   * 图谱就能从已有记忆里逐步长回来。
   */
  reset_watermark() {
    const index = this.load_index();
    const { last_update_ms, last_update_ids, ...rest } = index;
    this.save_index(rest);
    probe("graph", "watermark.reset", { previous: last_update_ms ?? 0 });
  }
  // ── 内部 ────────────────────────────────────────────────────────────────
  nodes_path() {
    return join9(this.dir, "nodes.jsonl");
  }
  edges_path() {
    return join9(this.dir, "edges.jsonl");
  }
  index_path() {
    return join9(this.dir, "index.json");
  }
  /**
   * 上次用聊天记录更新图谱的时间（毫秒）。
   *
   * 用它做**增量更新**：每次只处理比它更新的记录，避免重复消化同一批对话
   * （重复处理不仅浪费，还会让模型反复"确认"同一件事，容易把错误固化下来）。
   */
  last_update_ms() {
    return this.load_index().last_update_ms;
  }
  /** 本次水位同时刻已处理过的记录 id（用于 (ts, id) 复合游标）。 */
  last_update_ids() {
    return this.load_index().last_update_ids ?? [];
  }
  /**
   * 记录本次更新覆盖到的水位：时间戳 + **该时间戳上已处理的记录 id**。
   *
   * 为什么要带 id：只存毫秒时间戳时，同一毫秒内后来新增的记录会被
   * `ts > since` 永久跳过（审计复现过）。带上 id 就能精确续上。
   */
  set_last_update(ts, ids = []) {
    const index = this.load_index();
    const previous = index.last_update_ms ?? 0;
    if (ts < previous) return;
    const same_moment = ts === previous ? [.../* @__PURE__ */ new Set([...index.last_update_ids ?? [], ...ids])] : [...new Set(ids)];
    this.save_index({ ...index, last_update_ms: ts, last_update_ids: same_moment.slice(-200) });
  }
  /**
   * 分配下一个节点 id。
   *
   * **不能只信索引**：审计复现过"索引损坏 → 计数器归零 → 新节点又拿到 p1"，
   * 重复 id 会让边指向错误的人。所以这里取"索引计数器"和"实际节点里最大编号"的较大值 + 1。
   * 万一算出已存在的 id，直接抛错（fail closed），绝不写重复 id。
   */
  next_id() {
    const index = this.load_index();
    const from_nodes = this.max_seq_in_nodes();
    const next = Math.max(index.last_person_seq ?? 0, from_nodes) + 1;
    if (this.nodes().some((node) => node.id === `p${next}`)) {
      throw new Error(`\u77E5\u8BC6\u56FE\u8C31 id \u51B2\u7A81\uFF1Ap${next} \u5DF2\u5B58\u5728\u3002\u62D2\u7EDD\u5199\u5165\u4EE5\u514D\u8FB9\u6307\u5411\u9519\u8BEF\u7684\u4EBA\u3002`);
    }
    this.save_index({ ...index, last_person_seq: next });
    return `p${next}`;
  }
  /** 扫节点文件取最大编号（`p12` → 12）；这是 id 分配的**权威兜底**。 */
  max_seq_in_nodes() {
    let max = 0;
    for (const node of this.nodes()) {
      const match = /^p(\d+)$/.exec(node.id);
      if (match !== null) max = Math.max(max, Number(match[1]));
    }
    return max;
  }
  load_index() {
    const path = this.index_path();
    if (!existsSync9(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync7(path, "utf8"));
      return parsed;
    } catch {
      const recovered = this.max_seq_in_nodes();
      probe("graph", "index.corrupt_recovered", { recovered_seq: recovered });
      return { last_person_seq: recovered };
    }
  }
  save_index(index) {
    this.write_atomic(this.index_path(), `${JSON.stringify({ ...index, updated_at: Date.now() }, null, 2)}
`);
  }
  write_nodes(nodes) {
    this.write_atomic(this.nodes_path(), `${nodes.map((node) => JSON.stringify(strip_undefined2(node))).join("\n")}
`);
    this.regenerate_view();
  }
  write_edges(edges) {
    this.write_atomic(this.edges_path(), `${edges.map((edge) => JSON.stringify(strip_undefined2(edge))).join("\n")}
`);
    this.regenerate_view();
  }
  /** 原子写：临时文件（带进程内序号防撞名）+ rename（带重试，Windows 偶发 EPERM）。 */
  write_atomic(path, content) {
    mkdirSync5(this.dir, { recursive: true });
    this.tmp_seq += 1;
    const tmp = `${path}.tmp-${process.pid}-${this.tmp_seq}`;
    writeFileSync4(tmp, content, "utf8");
    rename_with_retry(tmp, path);
  }
};
function read_jsonl(path) {
  if (!existsSync9(path)) return [];
  const out = [];
  for (const line of readFileSync7(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      probe("graph", "jsonl.bad_line", { path });
    }
  }
  return out;
}
function today() {
  const now = /* @__PURE__ */ new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
function normalize(value) {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}
function age_from_birthday(birthday) {
  if (birthday === void 0) return void 0;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthday.trim());
  if (match === null) return void 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const now = /* @__PURE__ */ new Date();
  let age = now.getFullYear() - year;
  const before_birthday = now.getMonth() + 1 < month || now.getMonth() + 1 === month && now.getDate() < day;
  if (before_birthday) age -= 1;
  return age >= 0 && age < 150 ? age : void 0;
}
function merge_list(existing, added) {
  const out = [];
  for (const item of [...existing ?? [], ...added ?? []]) {
    const value = item.trim();
    if (value !== "" && !out.includes(value)) out.push(value);
  }
  return out.length === 0 ? void 0 : out;
}
function merge_dates(existing, added) {
  const map = /* @__PURE__ */ new Map();
  for (const item of existing ?? []) map.set(item.label, item.date);
  for (const item of added ?? []) map.set(item.label, item.date);
  return map.size === 0 ? void 0 : [...map].map(([label, date]) => ({ label, date }));
}
function merge_evidence(existing, added) {
  if (added === void 0) return existing === void 0 ? void 0 : [...existing];
  const out = [...existing ?? []];
  if (!out.some((item) => item.date === added.date && item.note === added.note)) out.push(added);
  return out.slice(-12);
}
function build_path(hops, nodes) {
  const name2 = (id) => nodes.get(id)?.name ?? id;
  const node_ids = [hops[0].from, ...hops.map((edge) => edge.to)];
  const readable = hops.map((edge) => `${name2(edge.from)}\u7684${edge.label}\u662F${name2(edge.to)}`).join("\uFF0C");
  return {
    node_ids,
    names: node_ids.map(name2),
    hops: hops.map((edge) => ({ from: name2(edge.from), to: name2(edge.to), label: edge.label })),
    readable
  };
}
function strip_undefined2(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== void 0) out[key] = item;
  }
  return out;
}

// backend/packages/webhook/webhook-weixin/src/memory/graphTools.ts
import { defineTool as defineTool3 } from "@deepseek-ai/dsh-tools";
var MAX_CHARS2 = 5e3;
function clip2(text) {
  return text.length <= MAX_CHARS2 ? text : `${text.slice(0, MAX_CHARS2)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u8BF7\u7F29\u5C0F\u8303\u56F4\uFF09`;
}
function describe_person(node) {
  const bits = [];
  if (node.aliases !== void 0 && node.aliases.length > 0) bits.push(`\u522B\u540D ${node.aliases.join("\u3001")}`);
  if (node.gender !== void 0 && node.gender !== "unknown") {
    bits.push(`\u6027\u522B ${{ male: "\u7537", female: "\u5973", other: "\u5176\u4ED6" }[node.gender] ?? node.gender}`);
  }
  if (node.birthday !== void 0) bits.push(`\u751F\u65E5 ${node.birthday}`);
  if (node.age !== void 0) bits.push(`\u5E74\u9F84 ${node.age}`);
  if (node.status !== void 0 && node.status !== "unknown") {
    bits.push(`\u72B6\u6001 ${{ alive: "\u5728\u4E16", deceased: "\u5DF2\u6545", lost_contact: "\u5931\u8054" }[node.status] ?? node.status}`);
  }
  if (node.occupation !== void 0) bits.push(`\u804C\u4E1A ${node.occupation}`);
  if (node.location !== void 0) bits.push(`\u6240\u5728\u5730 ${node.location}`);
  if (node.contacts !== void 0 && node.contacts.length > 0) bits.push(`\u8054\u7CFB\u65B9\u5F0F ${node.contacts.join("\u3001")}`);
  if (node.family_summary !== void 0) bits.push(`\u5BB6\u5EAD\u60C5\u51B5 ${node.family_summary}`);
  if (node.important_dates !== void 0 && node.important_dates.length > 0) {
    bits.push(`\u91CD\u8981\u65E5\u671F ${node.important_dates.map((item) => `${item.label} ${item.date}`).join("\uFF1B")}`);
  }
  if (node.notes !== void 0) bits.push(`\u5907\u6CE8 ${node.notes}`);
  return bits.length === 0 ? "\uFF08\u6682\u65E0\u5C5E\u6027\uFF09" : bits.join("\uFF1B");
}
async function relation_lines(graph, id) {
  const out = await graph.edges_from(id);
  if (out.length === 0) return [];
  const by_id = new Map((await graph.nodes()).map((node) => [node.id, node.name]));
  return [`\u3000\u4ED6/\u5979\u79F0\u547C\uFF1A${out.map((edge) => `${by_id.get(edge.to) ?? edge.to}\u4E3A\u300C${edge.label}\u300D`).join("\uFF1B")}`];
}
function register_graph_tools(agent_ctx, graph) {
  MemoryToolRegistry.register_tools(agent_ctx, "graph", (register) => {
    register(defineTool3({
      name: "relation_query",
      description: [
        "\u67E5\u8BE2\u5BB6\u4EBA/\u670B\u53CB\u5173\u7CFB\uFF08\u77E5\u8BC6\u56FE\u8C31\uFF09\u3002\u8FD9\u5F20\u56FE**\u4EE5\u300C\u6B23\u7231\u300D\uFF08\u4F60\u81EA\u5DF1\uFF09\u4E3A\u4E2D\u5FC3**\uFF1A",
        '\u4E0D\u586B from \u5C31\u9ED8\u8BA4\u4ECE\u6B23\u7231\u51FA\u53D1\uFF0C\u6240\u4EE5"\u4E3B\u4EBA\u548C XX \u662F\u4EC0\u4E48\u5173\u7CFB"\u76F4\u63A5\u7ED9 to \u5373\u53EF\u3002',
        "\u56FE\u8C31\u91CC\u7684\u4E24\u4E2A\u56FA\u5B9A\u8282\u70B9\uFF1A`\u6B23\u7231`\uFF08\u4F60\uFF09\u4E0E `\u4E3B\u4EBA`\uFF08\u7528\u6237\u672C\u4EBA\uFF0C\u771F\u540D\u53EF\u80FD\u5728\u4ED6\u7684\u522B\u540D\u91CC\uFF09\u3002",
        "",
        "\u4E24\u79CD\u7528\u6CD5\uFF1A",
        '- \u53EA\u7ED9 to\uFF1A\u67E5"\u6B23\u7231 \u2192 to"\u7684\u94FE\u8DEF\uFF0C\u4E5F\u5C31\u662F\u8FD9\u4E2A\u4EBA\u548C\u8FD9\u4E2A\u5BB6\u662F\u4EC0\u4E48\u5173\u7CFB\uFF1B',
        "- \u53EA\u7ED9 from\uFF1A\u67E5\u8FD9\u4E2A\u4EBA\u7684\u8D44\u6599 + \u4ED6\u8EAB\u8FB9\u90FD\u6709\u8C01\uFF08\u5411\u5916 2 \u5C42\uFF09\uFF1B",
        "- \u540C\u65F6\u7ED9 from \u548C to\uFF1A\u67E5\u4E24\u4EBA\u7684\u5173\u7CFB\u94FE\u8DEF\uFF0C**\u4F1A\u81EA\u52A8\u9012\u5F52\u591A\u8DF3**\uFF0C",
        '  \u4F8B\u5982"\u5C0F\u7EA2\u662F\u5C0F\u660E\u7684\u670B\u53CB\uFF0C\u5C0F\u7EA2\u7684\u670B\u53CB\u662F\u8001\u738B"\u3002',
        "",
        "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
        '- \u7528\u6237\u95EE"XX \u662F\u8C01/XX \u7684\u7535\u8BDD/XX \u5728\u54EA/XX \u662F\u6211\u4EC0\u4E48\u4EBA"\uFF08"\u6211"\u5C31\u662F `\u4E3B\u4EBA`\uFF09\uFF1B',
        "- \u7528\u6237\u63D0\u5230\u4E00\u4E2A\u4F60\u4E0D\u8BA4\u8BC6\u7684\u4EBA\u540D\uFF0C\u9700\u8981\u5148\u67E5\u4E00\u4E0B\u518D\u56DE\u7B54\uFF1B",
        '- \u9700\u8981\u7406\u6E05"\u8C01\u7684\u8C01"\u8FD9\u79CD\u94FE\u8DEF\uFF08\u4EB2\u621A\u3001\u670B\u53CB\u7684\u670B\u53CB\uFF09\u3002',
        "",
        "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
        "- \u5F53\u524D\u5BF9\u8BDD\u91CC\u5DF2\u7ECF\u8BF4\u6E05\u695A\u7684\u4FE1\u606F\uFF0C\u4E0D\u8981\u4E3A\u4E86\u786E\u8BA4\u518D\u67E5\uFF1B",
        "- \u7528\u6237\u53EA\u662F\u95F2\u804A\u3001\u4E0D\u6D89\u53CA\u5177\u4F53\u4EBA\u7269\u65F6\u4E0D\u8981\u8C03\u7528\u3002",
        "",
        "\u8FD4\u56DE\u7684\u662F\u56FE\u8C31\u91CC**\u5DF2\u8BB0\u5F55**\u7684\u5185\u5BB9\uFF1B\u5982\u679C\u6CA1\u8FD9\u4E2A\u4EBA\u6216\u6CA1\u6709\u901A\u8DEF\uFF0C\u4F1A\u5982\u5B9E\u544A\u8BC9\u4F60\uFF0C",
        "\u4E0D\u8981\u636E\u6B64\u7F16\u9020\u5173\u7CFB\u6216\u5C5E\u6027\u3002"
      ].join("\n"),
      parameters: {
        from: { type: "string", description: "\u8D77\u70B9\u4EBA\u7269\u59D3\u540D\uFF08\u6216\u5DF2\u77E5\u522B\u540D\uFF09\uFF1B\u4E0D\u586B\u9ED8\u8BA4\u300C\u6B23\u7231\u300D\u3002" },
        to: { type: "string", description: "\u7EC8\u70B9\u4EBA\u7269\u59D3\u540D\uFF1B\u7ED9\u4E86\u5C31\u67E5\u4E24\u4EBA\u4E4B\u95F4\u7684\u5173\u7CFB\u94FE\u8DEF\u3002" },
        max_depth: { type: "number", description: "\u94FE\u8DEF\u6700\u591A\u51E0\u8DF3\uFF0C\u9ED8\u8BA4 4\u3002" }
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
        render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
      },
      async execute(args) {
        if (graph === void 0) {
          return { ok: false, text: "\u77E5\u8BC6\u56FE\u8C31\u670D\u52A1\u5F53\u524D\u4E0D\u53EF\u7528\u3002" };
        }
        const from = typeof args.from === "string" ? args.from.trim() : "";
        const to = typeof args.to === "string" ? args.to.trim() : "";
        if (from === "" && to === "") {
          return { ok: false, text: "\u81F3\u5C11\u8981\u7ED9 from \u6216 to \u4E00\u4E2A\u4EBA\u540D\u3002" };
        }
        const origin = from === "" ? GRAPH_ASSISTANT_NAME : from;
        const start = await graph.find(origin);
        if (start === void 0) {
          const known = (await graph.nodes()).map((node) => node.name).slice(0, 30);
          return {
            ok: true,
            text: known.length === 0 ? "\u77E5\u8BC6\u56FE\u8C31\u91CC\u8FD8\u6CA1\u6709\u4EFB\u4F55\u4EBA\u7269\u8BB0\u5F55\u3002" : `\u6CA1\u6709\u627E\u5230"${origin}"\u3002\u76EE\u524D\u8BB0\u5F55\u5728\u518C\u7684\u4EBA\u6709\uFF1A${known.join("\u3001")}\u3002\u8BF7\u786E\u8BA4\u540D\u5B57\uFF0C\u6216\u5982\u5B9E\u544A\u8BC9\u7528\u6237\u4F60\u8FD8\u4E0D\u8BA4\u8BC6\u8FD9\u4E2A\u4EBA\u3002`
          };
        }
        const max_depth = Number(args.max_depth) || 4;
        if (to === "") {
          const attributes = await graph.attributes(start.name);
          const ring = await graph.neighborhood(start.name, { max_depth: 2 });
          const lines2 = [
            `\u3010${start.name}\u3011${describe_person(attributes ?? start)}`
          ];
          if (ring.length > 0) {
            lines2.push("");
            lines2.push("\u5173\u7CFB\u7F51\uFF08\u4ED6/\u5979\u600E\u4E48\u79F0\u547C\u522B\u4EBA\uFF09\uFF1A");
            for (const item of ring) {
              lines2.push(`- ${item.label}\uFF1A${item.name}${item.depth > 1 ? `\uFF08${item.depth} \u5C42\u5173\u7CFB\uFF09` : ""}`);
            }
          } else {
            lines2.push("", "\uFF08\u56FE\u8C31\u91CC\u8FD8\u6CA1\u6709\u8FD9\u4E2A\u4EBA\u7684\u5173\u7CFB\u8BB0\u5F55\uFF09");
          }
          return { ok: true, text: clip2(lines2.join("\n")) };
        }
        const end = await graph.find(to);
        if (end === void 0) {
          const known = (await graph.nodes()).map((node) => node.name).slice(0, 30);
          return { ok: true, text: `\u6CA1\u6709\u627E\u5230"${to}"\u3002\u76EE\u524D\u8BB0\u5F55\u5728\u518C\u7684\u4EBA\u6709\uFF1A${known.join("\u3001")}\u3002` };
        }
        const paths = await graph.paths(start.name, end.name, { max_depth });
        if (paths.length === 0) {
          return {
            ok: true,
            text: `\u56FE\u8C31\u91CC\u6CA1\u6709\u4ECE"${start.name}"\u5230"${end.name}"\u7684\u5173\u7CFB\u94FE\u8DEF\uFF08\u6700\u591A\u627E\u4E86 ${max_depth} \u8DF3\uFF09\u3002\u4E0D\u8981\u636E\u6B64\u7F16\u9020\u5173\u7CFB\uFF1B\u5982\u679C\u7528\u6237\u8BF4\u4E86\u4ED6\u4EEC\u7684\u5173\u7CFB\uFF0C\u53EF\u4EE5\u5728\u56DE\u590D\u91CC\u8BF7\u7528\u6237\u786E\u8BA4\u3002`
          };
        }
        const lines = [
          `\u3010${start.name}\u3011${describe_person(await graph.attributes(start.name) ?? start)}`,
          ...await relation_lines(graph, start.id),
          `\u3010${end.name}\u3011${describe_person(await graph.attributes(end.name) ?? end)}`,
          ...await relation_lines(graph, end.id),
          "",
          `\u627E\u5230 ${paths.length} \u6761\u5173\u7CFB\u94FE\u8DEF\uFF1A`
        ];
        for (const path of paths.slice(0, 5)) {
          lines.push(`- ${path.readable}\uFF08${path.hops.length} \u8DF3\uFF09`);
        }
        return { ok: true, text: clip2(lines.join("\n")) };
      }
    }));
  });
}

// backend/packages/webhook/webhook-weixin/src/memory/graphProtocol.ts
var ATTRIBUTE_FIELDS = {
  \u59D3\u540D: "name",
  \u522B\u540D: "aliases",
  \u51FA\u751F\u65E5\u671F: "birthday",
  \u751F\u65E5: "birthday",
  \u5E74\u9F84: "age",
  \u6027\u522B: "gender",
  \u72B6\u6001: "status",
  \u8054\u7CFB\u65B9\u5F0F: "contacts",
  \u7535\u8BDD: "contacts",
  \u6240\u5728\u5730: "location",
  \u804C\u4E1A: "occupation",
  \u5BB6\u5EAD\u60C5\u51B5: "family_summary",
  \u91CD\u8981\u65E5\u671F: "important_dates",
  \u5907\u6CE8: "notes"
};
function map_attribute_field(field) {
  const key = field.trim();
  return ATTRIBUTE_FIELDS[key] ?? key;
}
function is_known_attribute_field(field) {
  return ATTRIBUTE_FIELDS[field.trim()] !== void 0;
}
function parse_facts(text) {
  const facts = [];
  const bad_lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (line === "" || line === "\u65E0" || line.startsWith("#")) continue;
    const parts = line.split("|").map((item) => item.trim());
    const at = (index) => parts[index] ?? "";
    const tag = at(0);
    switch (tag) {
      case "\u4EBA\u7269": {
        if (at(1) === "") {
          bad_lines.push(line);
          break;
        }
        const aliases = at(2).split(/[,，、]/).map((item) => item.trim()).filter((item) => item !== "");
        facts.push({ kind: "person", name: at(1), ...aliases.length === 0 ? {} : { aliases } });
        break;
      }
      case "\u5C5E\u6027": {
        if (at(1) === "" || at(2) === "" || at(3) === "") {
          bad_lines.push(line);
          break;
        }
        facts.push({ kind: "attribute", name: at(1), field: at(2), value: at(3) });
        break;
      }
      case "\u5173\u7CFB": {
        if (at(1) === "" || at(2) === "" || at(3) === "") {
          bad_lines.push(line);
          break;
        }
        facts.push({ kind: "relation", from: at(1), to: at(2), label: at(3) });
        break;
      }
      case "\u4E8B\u4EF6": {
        if (at(1) === "" || at(3) === "") {
          bad_lines.push(line);
          break;
        }
        facts.push({ kind: "event", name: at(1), date: at(2), description: at(3) });
        break;
      }
      case "\u672A\u7ED1\u5B9A": {
        if (at(1) === "") {
          bad_lines.push(line);
          break;
        }
        facts.push({ kind: "unresolved", reference: at(1), quote: at(3) === "" ? at(2) : at(3) });
        break;
      }
      case "\u4E0A\u6587": {
        const text2 = parts.slice(1).join("|").trim();
        if (text2 === "") {
          bad_lines.push(line);
          break;
        }
        facts.push({ kind: "gist", text: text2 });
        break;
      }
      default:
        bad_lines.push(line);
    }
  }
  return { facts, bad_lines };
}
function render_candidates(people, limit = 30) {
  const unique = [];
  for (const item of people) {
    const value = item.trim();
    if (value !== "" && !unique.includes(value)) unique.push(value);
  }
  if (unique.length === 0) return "\uFF08\u6682\u65E0\u5DF2\u77E5\u4EBA\u7269\uFF09";
  return unique.slice(-limit).join("\u3001");
}
function render_pending(pending, limit = 5) {
  if (pending.length === 0) return "";
  return pending.slice(-limit).map((item) => `- "${item.reference}" \u2192 \u53EF\u80FD\u6307\uFF1A${item.quote}`).join("\n");
}

// backend/packages/webhook/webhook-weixin/src/memory/graphUpdater.ts
var SELF_ALIASES = ["\u6211", "\u7528\u6237", "\u4E3B\u4EBA", "\u672C\u4EBA", "\u81EA\u5DF1"];
var ASSISTANT_ALIASES = ["\u6B23\u7231", "\u52A9\u624B", "\u5C0F\u7231", "\u4F60"];
function canonical_person_name(name2) {
  const value = name2.trim();
  if (SELF_ALIASES.includes(value)) return GRAPH_USER_NAME;
  if (ASSISTANT_ALIASES.includes(value)) return GRAPH_ASSISTANT_NAME;
  return value;
}
var EXTRACT_RULES = [
  '\u4F60\u5728\u628A\u804A\u5929\u8BB0\u5F55\u6574\u7406\u6210"\u4EBA\u7269\u4E8B\u5B9E"\uFF0C\u7528\u4E8E\u7EF4\u62A4\u4E00\u4EFD\u5BB6\u4EBA/\u670B\u53CB\u5173\u7CFB\u56FE\u3002',
  "",
  "\u3010\u8F93\u51FA\u683C\u5F0F\u3011\u6BCF\u884C\u4E00\u6761\uFF0C\u5404\u6B04\u7528\u7AD6\u7EBF\u5206\u9694\u3002\u884C\u9996\u6807\u7B7E\u53EA\u5141\u8BB8\u8FD9\u51E0\u79CD\uFF1A",
  '\u7B2C\u4E00\u79CD\u662F"\u4EBA\u7269"\uFF0C\u540E\u9762\u4F9D\u6B21\u8DDF\uFF1A\u4EBA\u540D\u3001\u522B\u540D\uFF08\u591A\u4E2A\u7528\u9017\u53F7\u9694\u5F00\uFF0C\u6CA1\u6709\u5C31\u7559\u7A7A\uFF09\u3002',
  '\u7B2C\u4E8C\u79CD\u662F"\u5C5E\u6027"\uFF0C\u540E\u9762\u4F9D\u6B21\u8DDF\uFF1A\u4EBA\u540D\u3001\u5B57\u6BB5\u540D\u3001\u503C\u3002',
  '\u7B2C\u4E09\u79CD\u662F"\u5173\u7CFB"\uFF0C\u540E\u9762\u4F9D\u6B21\u8DDF\uFF1A\u79F0\u547C\u8005\u3001\u88AB\u79F0\u547C\u8005\u3001\u79F0\u547C\u3002',
  '\u7B2C\u56DB\u79CD\u662F"\u4E8B\u4EF6"\uFF0C\u540E\u9762\u4F9D\u6B21\u8DDF\uFF1A\u4EBA\u540D\u3001\u65E5\u671F\u3001\u63CF\u8FF0\u3002',
  '\u7B2C\u4E94\u79CD\u662F"\u672A\u7ED1\u5B9A"\uFF0C\u540E\u9762\u4F9D\u6B21\u8DDF\uFF1A\u6307\u4EE3\u8BCD\u3001\u539F\u6587\u7247\u6BB5\u3002',
  '\u7B2C\u516D\u79CD\u662F"\u4E0A\u6587"\uFF0C\u540E\u9762\u8DDF\u4E00\u53E5\u8BDD\uFF0C\u6982\u62EC\u8FD9\u4E00\u5757\u91CC\u4E0E\u4EBA\u7269\u6709\u5173\u7684\u8981\u70B9\uFF08\u4F9B\u4E0B\u4E00\u5757\u5224\u65AD\u6307\u4EE3\u7528\uFF09\u3002',
  "\uFF08\u4E0D\u8981\u628A\u4E0A\u9762\u8FD9\u4E9B\u8BF4\u660E\u5F53\u6210\u5185\u5BB9\u6284\u4E0B\u6765\uFF1B\u53EA\u8F93\u51FA\u771F\u5B9E\u63D0\u53D6\u5230\u7684\u884C\u3002\uFF09",
  "\u6CA1\u6709\u5185\u5BB9\u5C31\u8F93\u51FA\uFF1A\u65E0",
  "",
  "\u3010\u5B57\u6BB5\u540D\u53EA\u80FD\u7528\u8FD9\u4E9B\u3011\u59D3\u540D/\u522B\u540D/\u51FA\u751F\u65E5\u671F/\u5E74\u9F84/\u6027\u522B/\u72B6\u6001/\u8054\u7CFB\u65B9\u5F0F/\u6240\u5728\u5730/\u804C\u4E1A/\u5BB6\u5EAD\u60C5\u51B5/\u91CD\u8981\u65E5\u671F/\u5907\u6CE8",
  "",
  "\u3010\u786C\u6027\u89C4\u5219\u3011",
  '0. \u8FD9\u5F20\u56FE\u4EE5"\u6B23\u7231"\u4E3A\u4E2D\u5FC3\u3002\u8BB0\u5F55\u91CC\u7684\u4E24\u4E2A\u8BF4\u8BDD\u4EBA\u5DF2\u7ECF\u6709\u540D\u5B57\uFF0C\u76F4\u63A5\u7528\uFF1A',
  '   "[\u4E3B\u4EBA]"\u662F\u4E3B\u4EBA\u672C\u4EBA\uFF08\u56FE\u8C31\u91CC\u7684\u89C4\u8303\u540D\u5C31\u662F"\u4E3B\u4EBA"\uFF09\uFF0C"[\u6B23\u7231]"\u662F\u4F60\u81EA\u5DF1\uFF08\u89C4\u8303\u540D"\u6B23\u7231"\uFF09\u3002',
  '   \u51E1\u662F\u6CA1\u6709\u6307\u660E"\u8C01\u5728\u79F0\u547C"\u7684\u4EB2\u5C5E\u5173\u7CFB\uFF0C\u90FD\u662F\u4E3B\u4EBA\u7684\u5173\u7CFB\uFF0C\u79F0\u547C\u8005\u4E00\u5F8B\u5199"\u4E3B\u4EBA"\u3002',
  '0.1 "\u4E3B\u4EBA"\u53EA\u662F**\u79F0\u547C**\uFF0C\u4E0D\u662F\u4E3B\u4EBA\u7684\u59D3\u540D\u2014\u2014**\u4ED6\u7684\u59D3\u540D\u8FD8\u4E0D\u77E5\u9053**\u3002',
  '   \u9664\u975E\u8BB0\u5F55\u91CC\u660E\u786E\u8BF4\u51FA\u59D3\u540D\uFF08"\u6211\u53EB\u5F20\u4E09"\uFF09\uFF0C\u5426\u5219\u4E0D\u8981\u5199 \u5C5E\u6027|\u4E3B\u4EBA|\u59D3\u540D|\u2026\uFF0C\u4E5F\u4E0D\u8981\u731C\u3002',
  '   \u5982\u679C\u8BB0\u5F55\u91CC\u8BF4\u4E86\u4EE5\u540E\u600E\u4E48\u79F0\u547C\uFF08"\u4EE5\u540E\u53EB\u6211\u8001\u677F"\uFF09\uFF0C\u5199\u6210\uFF1A\u5173\u7CFB|\u6B23\u7231|\u4E3B\u4EBA|\u8001\u677F\u3002',
  "1. \u53EA\u5199\u8BB0\u5F55\u91CC\u660E\u786E\u51FA\u73B0\u7684\u4FE1\u606F\u3002\u7981\u6B62\u63A8\u65AD\u3001\u7981\u6B62\u8865\u5E38\u8BC6\u3001\u7981\u6B62\u7F16\u9020\u3002",
  '1.1 "\u7528\u6237""\u52A9\u624B"\u8FD9\u7C7B\u8BCD\u662F\u8BF4\u8BDD\u4EBA\u6807\u8BB0\uFF0C**\u4E0D\u662F\u4EBA\u540D**\uFF0C\u7EDD\u4E0D\u8981\u5199\u6210 \u4EBA\u7269 \u884C\uFF0C\u4E5F\u4E0D\u8981\u636E\u6B64\u7F16\u9020\u804C\u4E1A/\u8EAB\u4EFD\u3002',
  '2. "\u5173\u7CFB"\u7684\u65B9\u5411\u662F**\u79F0\u547C\u8005\u600E\u4E48\u79F0\u547C\u88AB\u79F0\u547C\u8005**\uFF1A\u8BB0\u5F55\u91CC\u8BF4"\u6211\u5988\u738B\u4E3D"\uFF0C\u5C31\u5199\uFF1A\u5173\u7CFB|\u4E3B\u4EBA|\u738B\u4E3D|\u5988\u5988\u3002',
  "3. \u6307\u4EE3\u8BCD\uFF08\u4ED6/\u5979/\u90A3\u4E2A\u4EBA/\u4E4B\u524D\u90A3\u4E2A/\u6211\u540C\u4E8B\uFF09**\u5FC5\u987B\u6362\u6210\u540D\u5355\u91CC\u7684\u5177\u4F53\u59D3\u540D**\u624D\u80FD\u5199\u6210 \u4EBA\u7269/\u5C5E\u6027/\u5173\u7CFB\u3002",
  "   \u6362\u4E0D\u51FA\u6765\u5C31\u5199 \u672A\u7ED1\u5B9A|\u6307\u4EE3\u8BCD|\u539F\u6587\u7247\u6BB5\uFF0C\u4E0D\u8981\u731C\u3002",
  "4. \u4E0D\u8981\u628A\u5BD2\u6684\u3001\u60C5\u7EEA\u3001\u8BED\u6C14\u8BCD\u5199\u6210\u4E8B\u5B9E\u3002",
  "5. \u4E0D\u786E\u5B9A\u7684\u5B81\u53EF\u4E0D\u5199\u3002"
].join("\n");
var MERGE_RULES = [
  '\u4F60\u5728\u538B\u7F29\u4E00\u4EFD"\u4EBA\u7269\u4E8B\u5B9E"\u7684\u4E0A\u4E0B\u6587\uFF0C\u538B\u7F29\u540E\u4F1A\u7EE7\u7EED\u7528\u6765\u5904\u7406\u540E\u9762\u7684\u804A\u5929\u8BB0\u5F55\u3002',
  "\u8F93\u5165\u6709\u4E09\u90E8\u5206\uFF1A\u65E7\u7684\u4E0A\u4E0B\u6587\u63D0\u8981\u3001\u65E7\u7684\u4E8B\u5B9E\u6E05\u5355\u3001\u65B0\u7684\u4E00\u6BB5\u804A\u5929\u8BB0\u5F55\u3002",
  "",
  "\u3010\u8F93\u51FA\u683C\u5F0F\u3011\u6BCF\u884C\u4E00\u6761\uFF0C\u7528\u7AD6\u7EBF\u5206\u9694\uFF1A",
  '\u63D0\u8981\u884C\uFF1A\u884C\u9996\u5199"\u4E0A\u6587"\uFF0C\u540E\u9762\u8DDF\u4E00\u53E5\u8BDD\u6982\u62EC\u8981\u70B9\uFF08\u6700\u591A 10 \u884C\uFF1B\u52A1\u5FC5\u4FDD\u7559\u8FD8\u6CA1\u89E3\u5F00\u7684\u6307\u4EE3\uFF09\u3002',
  '\u4E8B\u5B9E\u884C\uFF1A\u884C\u9996\u5199"\u5C5E\u6027"\u6216"\u5173\u7CFB"\u6216"\u4EBA\u7269"\uFF0C\u540E\u9762\u6309\u539F\u6765\u7684\u5B57\u6BB5\u987A\u5E8F\u8DDF\u5185\u5BB9\uFF08\u53BB\u91CD\uFF0C\u6700\u591A 60 \u884C\uFF09\u3002',
  "",
  "\u3010\u786C\u6027\u89C4\u5219\u3011",
  "1. **\u4E8B\u5B9E\u4E0D\u80FD\u56E0\u4E3A\u538B\u7F29\u800C\u4E22**\uFF1A\u4EBA\u540D\u3001\u79F0\u547C\u3001\u5173\u952E\u5C5E\u6027\u5FC5\u987B\u4FDD\u7559\u4E0B\u6765\u3002",
  "2. \u65B0\u65E7\u51B2\u7A81\u65F6\u4EE5\u65B0\u8BB0\u5F55\u4E3A\u51C6\u3002",
  "3. \u53EA\u8F93\u51FA\u4E0A\u9762\u4E24\u79CD\u884C\uFF0C\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u524D\u8A00\u540E\u8BED\u3002"
].join("\n");
var REVIEW_RULES = [
  "\u4F60\u5728\u5BA1\u6838\u4E00\u4E2A\u4EBA\u7269\u6863\u6848\u8981\u4E0D\u8981\u66F4\u65B0\u3002",
  "",
  "\u3010\u8F93\u51FA\u683C\u5F0F\u3011\u6BCF\u884C\u4E00\u6761\uFF0C\u53EA\u5141\u8BB8\uFF1A",
  "\u66F4\u65B0|\u5B57\u6BB5|\u503C",
  "\u6CA1\u6709\u9700\u8981\u66F4\u65B0\u5C31\u8F93\u51FA\uFF1A\u65E0",
  "",
  "\u3010\u786C\u6027\u89C4\u5219\u3011",
  '1. \u53EA\u80FD\u6839\u636E\u4E0B\u9762\u7ED9\u51FA\u7684"\u672C\u6B21\u4E8B\u5B9E"\u6765\u66F4\u65B0\uFF0C\u4E0D\u80FD\u51ED\u5370\u8C61\u8865\u5145\u3002',
  "2. \u5B57\u6BB5\u540D\u53EA\u80FD\u7528\uFF1A\u59D3\u540D/\u522B\u540D/\u51FA\u751F\u65E5\u671F/\u5E74\u9F84/\u6027\u522B/\u72B6\u6001/\u8054\u7CFB\u65B9\u5F0F/\u6240\u5728\u5730/\u804C\u4E1A/\u5BB6\u5EAD\u60C5\u51B5/\u91CD\u8981\u65E5\u671F/\u5907\u6CE8\u3002",
  "3. \u4E8B\u5B9E\u4E0E\u73B0\u6709\u6863\u6848\u51B2\u7A81\u65F6\uFF0C\u4EE5\u672C\u6B21\u4E8B\u5B9E\u4E3A\u51C6\u5E76\u66F4\u65B0\uFF1B\u6CA1\u6709\u63D0\u5230\u7684\u5B57\u6BB5\u4E0D\u8981\u52A8\u3002",
  "4. \u4E0D\u786E\u5B9A\u5C31\u4E0D\u8F93\u51FA\u3002"
].join("\n");
var NEW_PERSON_RULES = [
  "\u4F60\u5728\u51B3\u5B9A\u8981\u4E0D\u8981\u7ED9\u5173\u7CFB\u56FE\u6DFB\u52A0**\u65B0\u4EBA\u7269**\u3002",
  "",
  "\u3010\u8F93\u51FA\u683C\u5F0F\u3011\u6BCF\u884C\u4E00\u6761\uFF0C\u53EA\u5141\u8BB8\uFF1A",
  "\u4EBA\u7269|\u59D3\u540D|\u522B\u540D1,\u522B\u540D2",
  "\u5173\u7CFB|\u79F0\u547C\u8005|\u88AB\u79F0\u547C\u8005|\u79F0\u547C",
  "\u6CA1\u6709\u65B0\u4EBA\u7269\u5C31\u8F93\u51FA\uFF1A\u65E0",
  "",
  "\u3010\u786C\u6027\u89C4\u5219\u3011",
  "1. \u540D\u5355\u91CC\u5DF2\u7ECF\u6709\u7684\u4EBA**\u4E0D\u8981**\u518D\u8F93\u51FA \u4EBA\u7269 \u884C\u3002",
  "2. \u53EA\u6DFB\u52A0\u8BB0\u5F55\u91CC\u660E\u786E\u51FA\u73B0\u3001\u4E14\u6709\u540D\u5B57\u7684\u4EBA\u3002\u6307\u4EE3\u8BCD\u6362\u4E0D\u51FA\u59D3\u540D\u7684\u4E0D\u8981\u6DFB\u52A0\u3002",
  '3. \u5173\u7CFB\u884C\u7684\u65B9\u5411\u662F"\u79F0\u547C\u8005\u600E\u4E48\u79F0\u547C\u88AB\u79F0\u547C\u8005"\u3002',
  "4. \u4E0D\u786E\u5B9A\u5C31\u4E0D\u8F93\u51FA\u3002"
].join("\n");
async function update_graph_from_records(options, records) {
  const graph = options.graph;
  const chunk_chars = options.chunk_chars ?? Number(process.env.DSH_GRAPH_CHUNK_CHARS ?? "8000");
  const max_prompt_chars = options.max_prompt_chars ?? Number(process.env.DSH_GRAPH_MAX_PROMPT_CHARS ?? "30000");
  await graph.ensure_center();
  const chunks = chunk_records(records, chunk_chars);
  const all_facts = [];
  let bad_lines = 0;
  let unresolved_total = 0;
  let unresolved = [];
  const gists = [];
  const facts_carried = [];
  let trimmed_prompts = 0;
  let merged_count = 0;
  for (const [index, chunk] of chunks.entries()) {
    const date = chunk[chunk.length - 1]?.date ?? "";
    const build = async (gist_list, fact_list) => [
      EXTRACT_RULES,
      "",
      "\u3010\u5DF2\u77E5\u4EBA\u7269\u540D\u5355\uFF08\u6307\u4EE3\u8BCD\u53EA\u80FD\u4ECE\u4E2D\u9009\u62E9\uFF0C\u6216\u7528 \u672A\u7ED1\u5B9A\uFF09\u3011",
      render_candidates(await candidate_names(graph)),
      ...carry_section(gist_list, fact_list, unresolved),
      ...tail_of(records, chunk, 4) === "" ? [] : ["", "\u3010\u672C\u5757\u4E4B\u524D\u7684\u51E0\u53E5\uFF08\u5E2E\u52A9\u5224\u65AD\u6307\u4EE3\uFF09\u3011", tail_of(records, chunk, 4)],
      "",
      "\u3010\u672C\u5757\u804A\u5929\u8BB0\u5F55\u3011",
      chunk.map((item) => format_line(item)).join("\n")
    ].join("\n");
    let prompt = await build(gists, facts_carried);
    if (prompt.length > max_prompt_chars && (gists.length > 0 || facts_carried.length > 0)) {
      const merge_prompt = build_merge(gists, facts_carried, chunk);
      if (merge_prompt.length <= max_prompt_chars) {
        const merged = parse_facts(await options.complete(merge_prompt));
        bad_lines += merged.bad_lines.length;
        gists.length = 0;
        facts_carried.length = 0;
        for (const fact of merged.facts) {
          if (fact.kind === "unresolved") {
            unresolved.push({ reference: fact.reference, quote: fact.quote });
            unresolved_total += 1;
            continue;
          }
          if (fact.kind === "gist") {
            gists.push(fact.text);
            continue;
          }
          const canonical = canonicalize_fact(fact);
          all_facts.push({ fact: canonical, date, quote: quote_of(canonical) });
          facts_carried.push(render_fact(canonical));
        }
        merged_count += 1;
        probe("graph", "update.merged", {
          index: index + 1,
          gists: gists.length,
          facts: facts_carried.length,
          prompt_chars: merge_prompt.length
        });
        continue;
      }
      let gist_list = [...gists];
      let fact_list = [...facts_carried];
      while (merge_prompt.length > max_prompt_chars && (gist_list.length > 0 || fact_list.length > 0)) {
        if (gist_list.length > 0) gist_list = gist_list.slice(1);
        else fact_list = fact_list.slice(1);
        trimmed_prompts += 1;
        break;
      }
      gists.length = 0;
      gists.push(...gist_list);
      facts_carried.length = 0;
      facts_carried.push(...fact_list);
      prompt = await build(gists, facts_carried);
    }
    const parsed = parse_facts(await options.complete(prompt));
    bad_lines += parsed.bad_lines.length;
    unresolved = [];
    for (const fact of parsed.facts) {
      if (fact.kind === "unresolved") {
        unresolved.push({ reference: fact.reference, quote: fact.quote });
        unresolved_total += 1;
        continue;
      }
      if (fact.kind === "gist") {
        gists.push(fact.text);
        continue;
      }
      const canonical = canonicalize_fact(fact);
      all_facts.push({ fact: canonical, date, quote: quote_of(canonical) });
      facts_carried.push(render_fact(canonical));
    }
    probe("graph", "update.chunk_done", {
      index: index + 1,
      chunks: chunks.length,
      facts: parsed.facts.length,
      bad: parsed.bad_lines.length,
      prompt_chars: prompt.length,
      trimmed: trimmed_prompts
    });
  }
  const created = [];
  const touched = /* @__PURE__ */ new Set();
  for (const item of all_facts) {
    switch (item.fact.kind) {
      case "person": {
        const existed = await graph.find(item.fact.name) !== void 0;
        await graph.upsert_person({
          name: item.fact.name,
          ...item.fact.aliases === void 0 ? {} : { aliases: item.fact.aliases },
          evidence: { date: item.date, note: item.quote }
        });
        if (!existed) created.push(item.fact.name);
        touched.add(item.fact.name);
        break;
      }
      case "attribute":
        touched.add(item.fact.name);
        break;
      case "relation":
        touched.add(item.fact.from);
        touched.add(item.fact.to);
        break;
      default:
        break;
    }
  }
  const to_review = options.full_scan === true ? (await graph.nodes()).map((node) => node.name) : [...touched];
  const updated = [];
  for (const name2 of to_review) {
    const node = await graph.find(name2);
    if (node === void 0) continue;
    const related = all_facts.filter((item) => item.fact.kind === "attribute" && item.fact.name === name2 || item.fact.kind === "person" && item.fact.name === name2);
    if (related.length === 0 && options.full_scan !== true) continue;
    const prompt = [
      REVIEW_RULES,
      "",
      `\u3010\u4EBA\u7269\u3011${node.name}`,
      `\u3010\u73B0\u6709\u6863\u6848\u3011${describe_current(node)}`,
      "",
      "\u3010\u672C\u6B21\u4E8B\u5B9E\u3011",
      related.length === 0 ? "\uFF08\u65E0\uFF09" : related.map((item) => render_fact(item.fact)).join("\n")
    ].join("\n");
    const parsed = parse_facts_review(await options.complete(prompt));
    bad_lines += parsed.bad_lines.length;
    if (parsed.updates.length === 0) continue;
    const patch = patch_from_updates(parsed.updates);
    if (Object.keys(patch).length === 0) continue;
    await graph.upsert_person({
      id: node.id,
      name: node.name,
      ...patch,
      evidence: { date: all_facts[0]?.date ?? "", note: "\u9010\u8282\u70B9\u5BA1\u6838" }
    });
    updated.push(node.name);
    probe("graph", "update.node_reviewed", { name: node.name, fields: Object.keys(patch).length });
  }
  for (const item of all_facts) {
    if (item.fact.kind !== "attribute") continue;
    const patch = patch_from_updates([{ field: item.fact.field, value: item.fact.value }]);
    if (Object.keys(patch).length === 0) continue;
    const existing = await graph.find(item.fact.name);
    await graph.upsert_person({
      name: item.fact.name,
      ...patch,
      // 只有"要改姓名"时才带 id（改名走就地改名 + 旧名转别名）。
      // 其它字段带 id 会把正名覆盖成别名——"属性|妈妈|职业|医生"不该把"王丽"改名成"妈妈"。
      ...existing !== void 0 && typeof patch.name === "string" ? { id: existing.id } : {},
      evidence: { date: item.date, note: item.quote }
    });
    touched.add(item.fact.name);
  }
  let relations_created = 0;
  for (const item of all_facts) {
    if (item.fact.kind !== "relation") continue;
    const edge = await graph.upsert_edge({
      from: item.fact.from,
      to: item.fact.to,
      label: item.fact.label,
      // 两个中心人物之间是"当面称呼"（替换语义）：她说的是"以后叫我老板"，
      // 那旧称呼就该让位；别人的亲属称谓仍然允许多个叫法并存。
      ...is_address_pair(item.fact.from, item.fact.to) ? { kind: "address" } : {},
      evidence: { date: item.date, note: item.quote }
    });
    if (edge !== void 0) relations_created += 1;
  }
  const known = await candidate_names(graph);
  const fact_lines = all_facts.map((item) => render_fact(item.fact));
  const build_new = (lines) => [
    NEW_PERSON_RULES,
    "",
    "\u3010\u5DF2\u77E5\u4EBA\u7269\u540D\u5355\u3011",
    render_candidates(known, 60),
    "",
    "\u3010\u672C\u6B21\u6574\u7406\u51FA\u7684\u4E8B\u5B9E\u3011",
    lines.length === 0 ? "\uFF08\u65E0\uFF09" : lines.join("\n")
  ].join("\n");
  let kept = fact_lines;
  let new_prompt = build_new(kept);
  while (new_prompt.length > max_prompt_chars && kept.length > 0) {
    kept = kept.slice(1);
    new_prompt = build_new(kept);
    trimmed_prompts += 1;
  }
  const new_parsed = parse_facts(await options.complete(new_prompt));
  bad_lines += new_parsed.bad_lines.length;
  for (const fact of new_parsed.facts) {
    if (fact.kind === "person" && await graph.find(fact.name) === void 0) {
      await graph.upsert_person({
        name: fact.name,
        ...fact.aliases === void 0 ? {} : { aliases: fact.aliases },
        evidence: { date: all_facts[0]?.date ?? "", note: "\u65B0\u589E\u4EBA\u7269\u5BA1\u6838" }
      });
      created.push(fact.name);
    }
    if (fact.kind === "relation") {
      const edge = await graph.upsert_edge({
        from: fact.from,
        to: fact.to,
        label: fact.label,
        evidence: { date: all_facts[0]?.date ?? "", note: "\u65B0\u589E\u4EBA\u7269\u5BA1\u6838" }
      });
      if (edge !== void 0) relations_created += 1;
    }
  }
  const result = {
    chunks: chunks.length,
    facts: all_facts.length,
    bad_lines,
    people_created: created,
    people_updated: updated,
    relations_created,
    unresolved: unresolved_total,
    merged_blocks: merged_count,
    trimmed_prompts
  };
  probe("graph", "update.done", { ...result });
  return result;
}
function build_merge(gists, facts, chunk) {
  return [
    MERGE_RULES,
    "",
    "\u3010\u65E7\u7684\u4E0A\u4E0B\u6587\u63D0\u8981\u3011",
    gists.length === 0 ? "\uFF08\u65E0\uFF09" : gists.map((item) => `- ${item}`).join("\n"),
    "",
    "\u3010\u65E7\u7684\u4E8B\u5B9E\u6E05\u5355\u3011",
    facts.length === 0 ? "\uFF08\u65E0\uFF09" : facts.join("\n"),
    "",
    "\u3010\u65B0\u7684\u4E00\u6BB5\u804A\u5929\u8BB0\u5F55\u3011",
    chunk.map((item) => format_line(item)).join("\n")
  ].join("\n");
}
function carry_section(gists, facts, unresolved) {
  const out = [];
  if (gists.length > 0) {
    out.push("", "\u3010\u524D\u6587\u63D0\u8981\uFF08\u524D\u9762\u51E0\u5757\u7684\u538B\u7F29\u8981\u70B9\uFF0C\u5E2E\u52A9\u5224\u65AD\u6307\u4EE3\uFF09\u3011");
    for (const gist of gists.slice(-8)) out.push(`- ${gist}`);
  }
  if (facts.length > 0) {
    out.push("", "\u3010\u524D\u9762\u5DF2\u63D0\u53D6\u7684\u4E8B\u5B9E\uFF08\u4E0D\u8981\u91CD\u590D\u8F93\u51FA\u8FD9\u4E9B\uFF09\u3011");
    for (const fact of facts.slice(-40)) out.push(fact);
  }
  if (unresolved.length > 0) {
    out.push("", "\u3010\u524D\u9762\u672A\u89E3\u5F00\u7684\u6307\u4EE3\u3011", render_pending(unresolved));
  }
  return out;
}
function is_address_pair(from, to) {
  const centers = [GRAPH_ASSISTANT_NAME, GRAPH_USER_NAME];
  return from !== to && centers.includes(from) && centers.includes(to);
}
async function candidate_names(graph) {
  const out = [];
  for (const node of await graph.nodes()) {
    out.push(node.name);
    for (const alias of node.aliases ?? []) out.push(alias);
  }
  return out;
}
function chunk_records(records, budget) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const record of records) {
    const cost = record.text.length + 8;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(record);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
function tail_of(records, chunk, lines) {
  const first = records.indexOf(chunk[0]);
  if (first <= 0) return "";
  return records.slice(Math.max(0, first - lines), first).map((item) => format_line(item)).join("\n");
}
function format_line(item) {
  const speaker = item.role === "user" ? GRAPH_USER_NAME : GRAPH_ASSISTANT_NAME;
  return `[${speaker}] ${item.text}`;
}
function canonicalize_fact(fact) {
  switch (fact.kind) {
    case "person":
      return { ...fact, name: canonical_person_name(fact.name) };
    case "attribute":
      return { ...fact, name: canonical_person_name(fact.name) };
    case "relation":
      return { ...fact, from: canonical_person_name(fact.from), to: canonical_person_name(fact.to) };
    case "event":
      return { ...fact, name: canonical_person_name(fact.name) };
    default:
      return fact;
  }
}
function render_fact(fact) {
  switch (fact.kind) {
    case "person":
      return `\u4EBA\u7269|${fact.name}${fact.aliases === void 0 ? "" : "|" + fact.aliases.join(",")}`;
    case "attribute":
      return `\u5C5E\u6027|${fact.name}|${fact.field}|${fact.value}`;
    case "relation":
      return `\u5173\u7CFB|${fact.from}|${fact.to}|${fact.label}`;
    case "event":
      return `\u4E8B\u4EF6|${fact.name}|${fact.date}|${fact.description}`;
    case "unresolved":
      return `\u672A\u7ED1\u5B9A|${fact.reference}|${fact.quote}`;
    case "gist":
      return `\u4E0A\u6587|${fact.text}`;
  }
}
function quote_of(fact) {
  return render_fact(fact).slice(0, 80);
}
function describe_current(node) {
  const bits = [];
  if (node.aliases !== void 0 && node.aliases.length > 0) bits.push(`\u522B\u540D=${node.aliases.join(",")}`);
  if (node.birthday !== void 0) bits.push(`\u51FA\u751F\u65E5\u671F=${node.birthday}`);
  if (node.age !== void 0) bits.push(`\u5E74\u9F84=${node.age}`);
  if (node.gender !== void 0) bits.push(`\u6027\u522B=${node.gender}`);
  if (node.status !== void 0) bits.push(`\u72B6\u6001=${node.status}`);
  if (node.contacts !== void 0 && node.contacts.length > 0) bits.push(`\u8054\u7CFB\u65B9\u5F0F=${node.contacts.join(",")}`);
  if (node.location !== void 0) bits.push(`\u6240\u5728\u5730=${node.location}`);
  if (node.occupation !== void 0) bits.push(`\u804C\u4E1A=${node.occupation}`);
  if (node.family_summary !== void 0) bits.push(`\u5BB6\u5EAD\u60C5\u51B5=${node.family_summary}`);
  if (node.notes !== void 0) bits.push(`\u5907\u6CE8=${node.notes}`);
  return bits.length === 0 ? "\uFF08\u7A7A\uFF09" : bits.join("\uFF1B");
}
function parse_facts_review(text) {
  const updates = [];
  const bad_lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^[-*]\s*/, "");
    if (line === "" || line === "\u65E0" || line.startsWith("#")) continue;
    const parts = line.split("|").map((item) => item.trim());
    const field = parts[1] ?? "";
    if (parts[0] !== "\u66F4\u65B0" || field === "" || parts.length < 3) {
      bad_lines.push(line);
      continue;
    }
    updates.push({ field, value: parts.slice(2).join("|") });
  }
  return { updates, bad_lines };
}
function patch_from_updates(updates) {
  const patch = {};
  for (const { field, value } of updates) {
    if (!is_known_attribute_field(field)) continue;
    const key = map_attribute_field(field);
    switch (key) {
      case "age": {
        const age = Number(value.replace(/[^\d]/g, ""));
        if (Number.isFinite(age) && age > 0 && age < 150) patch.age = age;
        break;
      }
      case "contacts":
        patch.contacts = value.split(/[,，、;；]/).map((item) => item.trim()).filter((item) => item !== "");
        break;
      case "aliases":
        patch.aliases = value.split(/[,，、;；]/).map((item) => item.trim()).filter((item) => item !== "");
        break;
      case "status":
        patch.status = /已故|去世|过世/.test(value) ? "deceased" : /失联|联系不上/.test(value) ? "lost_contact" : /在世|健在/.test(value) ? "alive" : "unknown";
        break;
      case "gender":
        patch.gender = /男/.test(value) ? "male" : /女/.test(value) ? "female" : "unknown";
        break;
      case "important_dates": {
        const match = /^(.+?)\s*[:：]?\s*(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})$/.exec(value.trim());
        if (match !== null) patch.important_dates = [{ label: match[1].trim(), date: match[2] }];
        break;
      }
      default:
        if (value.trim() !== "") patch[key] = value.trim();
    }
  }
  return patch;
}

// backend/packages/webhook/webhook-weixin/src/memory/graphScheduler.ts
function start_graph_scheduler(options) {
  const idle_ms = options.idle_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_IDLE_HOURS ?? "3")) * 36e5;
  const interval_ms = options.interval_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? "5")) * 6e4;
  const max_days = options.max_days ?? 7;
  let busy = false;
  let stopped = false;
  const run_once = async (now = Date.now()) => {
    if (busy) {
      probe("graph", "scheduler.skipped_busy");
      return void 0;
    }
    busy = true;
    try {
      const since = await options.graph.last_update_ms() ?? 0;
      const done_ids = new Set(await options.graph.last_update_ids());
      const days = (await options.timeline.list_days()).slice(-max_days);
      const all = (await Promise.all(days.map((day) => options.timeline.read_day(day.date)))).flatMap((day) => day.entries);
      const fresh = all.filter((item) => item.ts > since || item.ts === since && !done_ids.has(item.id)).sort((a, b) => a.ts - b.ts);
      const records = fresh.map((item) => ({ date: new Date(item.ts).toISOString().slice(0, 10), role: item.role, text: item.text }));
      if (records.length === 0) return void 0;
      const last_ts = Math.max(...all.map((item) => item.ts), since);
      const ids_at_watermark = all.filter((item) => item.ts === last_ts).map((item) => item.id);
      if (now - last_ts < idle_ms) return void 0;
      probe("graph", "scheduler.started_update", { records: records.length, since });
      const result = await update_graph_from_records(
        { graph: options.graph, complete: options.complete },
        records
      );
      await options.graph.set_last_update(last_ts, ids_at_watermark);
      options.on_update?.(result);
      return result;
    } catch (error) {
      probe("graph", "scheduler.failed", { error: String(error) });
      return void 0;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void run_once();
  }, interval_ms);
  timer.unref?.();
  probe("graph", "scheduler.started", { interval_ms, idle_ms, max_days });
  return {
    run_once,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      probe("graph", "scheduler.stopped");
    }
  };
}

// backend/packages/webhook/webhook-weixin/src/memory/gpuMonitor.ts
import { execFileSync as execFileSync3 } from "node:child_process";
function gpu_memory() {
  try {
    const output = execFileSync3(
      "nvidia-smi",
      ["--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 15e3, windowsHide: true }
    );
    const first = output.trim().split("\n")[0] ?? "";
    const parts = first.split(",").map((item) => Number(item.trim()));
    const used = parts[0];
    const total = parts[1];
    if (used === void 0 || total === void 0) return void 0;
    if (!Number.isFinite(used) || !Number.isFinite(total)) return void 0;
    return { used_mb: used, total_mb: total, free_mb: total - used };
  } catch {
    return void 0;
  }
}
async function wait_for_free_vram(options) {
  const min_free_mb = options?.min_free_mb ?? 5200;
  const timeout_ms = options?.timeout_ms ?? 6e5;
  const poll_ms = options?.poll_ms ?? 3e4;
  const label = options?.label ?? "gemma";
  if (min_free_mb <= 0) return true;
  const deadline = Date.now() + timeout_ms;
  let waited = false;
  for (; ; ) {
    const memory = gpu_memory();
    if (memory === void 0) {
      if (waited) probe("gpu", "vram.wait_skipped", { label, reason: "no_nvidia_smi" });
      return true;
    }
    if (memory.free_mb >= min_free_mb) {
      if (waited) probe("gpu", "vram.free_now", { label, free_mb: memory.free_mb });
      return true;
    }
    if (Date.now() >= deadline) {
      probe("gpu", "vram.wait_timeout", {
        label,
        free_mb: memory.free_mb,
        need_mb: min_free_mb,
        timeout_ms
      });
      return false;
    }
    if (!waited) {
      waited = true;
      probe("gpu", "vram.busy_wait", {
        label,
        free_mb: memory.free_mb,
        need_mb: min_free_mb,
        total_mb: memory.total_mb
      });
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(poll_ms, Math.max(0, deadline - Date.now()))));
  }
}

// backend/packages/webhook/webhook-weixin/src/memory/gemmaGate.ts
function create_gemma_gate(options) {
  const concurrency = Math.max(1, options?.concurrency ?? 1);
  const max_queue = Math.max(0, options?.max_queue ?? 20);
  const wait_timeout_ms = options?.wait_timeout_ms ?? 6e5;
  let active = 0;
  const queue = [];
  const release = () => {
    active -= 1;
    const next = queue.shift();
    if (next !== void 0) next();
  };
  return {
    async run(label, fn) {
      const vram_ok = await wait_for_free_vram({
        min_free_mb: options?.min_free_vram_mb ?? 5200,
        timeout_ms: options?.vram_wait_ms ?? 6e5,
        poll_ms: options?.vram_poll_ms ?? 3e4,
        label
      });
      if (!vram_ok) {
        throw new Error(`\u663E\u5B58\u4E00\u76F4\u88AB\u5360\u7528\uFF0C\u6682\u7F13\u300C${label}\u300D\uFF08\u7B49\u4E0D\u5230\u81F3\u5C11 ${options?.min_free_vram_mb ?? 5200}MB \u7A7A\u95F2\uFF09\u3002\u7A0D\u540E\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002`);
      }
      if (options?.ensure_ready !== void 0) await options.ensure_ready();
      if (active >= concurrency) {
        if (queue.length >= max_queue) {
          probe("gemma", "gate.rejected", { label, active, queued: queue.length });
          throw new Error(`Gemma \u8C03\u7528\u6392\u961F\u5DF2\u6EE1\uFF08${max_queue}\uFF09\uFF0C\u672C\u6B21\u300C${label}\u300D\u8DF3\u8FC7\u3002`);
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const at = queue.indexOf(entry);
            if (at >= 0) queue.splice(at, 1);
            reject(new Error(`\u7B49\u5F85 Gemma \u95F8\u95E8\u8D85\u65F6\uFF08${wait_timeout_ms}ms\uFF09\uFF1A${label}`));
          }, wait_timeout_ms);
          const entry = () => {
            clearTimeout(timer);
            resolve();
          };
          queue.push(entry);
        });
      }
      active += 1;
      probe("gemma", "gate.enter", { label, active, queued: queue.length });
      try {
        return await fn();
      } finally {
        release();
        probe("gemma", "gate.leave", { label, active, queued: queue.length });
      }
    },
    stats: () => ({ active, queued: queue.length })
  };
}

// backend/packages/webhook/webhook-weixin/src/coordination/notifySettings.ts
function meta_key(target) {
  return `notify.${target}`;
}
function create_notify_settings(store) {
  return {
    is_enabled(target) {
      return store.get_meta(meta_key(target)) !== "0";
    },
    set_enabled(target, enabled) {
      store.set_meta(meta_key(target), enabled ? "1" : "0");
    },
    snapshot() {
      return {
        codex: store.get_meta(meta_key("codex")) !== "0",
        opencode: store.get_meta(meta_key("opencode")) !== "0"
      };
    },
    async is_enabled_async(target) {
      return await store.get_meta(meta_key(target)) !== "0";
    },
    async set_enabled_async(target, enabled) {
      await store.set_meta(meta_key(target), enabled ? "1" : "0");
    },
    async snapshot_async() {
      const [codex, opencode] = await Promise.all([
        store.get_meta(meta_key("codex")),
        store.get_meta(meta_key("opencode"))
      ]);
      return { codex: codex !== "0", opencode: opencode !== "0" };
    }
  };
}

// backend/packages/webhook/webhook-weixin/src/coordination/notifyTools.ts
import { defineTool as defineTool4 } from "@deepseek-ai/dsh-tools";
var TARGETS = ["codex", "opencode"];
function parse_targets(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value === "" || value === "all" || value === "both" || value === "\u5168\u90E8") return [...TARGETS];
  const matched = TARGETS.filter((target) => value === target || value.includes(target));
  return matched.length === 0 ? void 0 : matched;
}
function register_notify_tools(agent_ctx, settings) {
  agent_ctx.tools.register(defineTool4({
    name: "notify_control",
    description: [
      '\u67E5\u770B\u6216\u8BBE\u7F6E"\u4EFB\u52A1\u5B8C\u6210\u6C47\u62A5"\u7684\u63A8\u9001\u5F00\u5173\uFF08codex \u4E0E opencode \u5404\u81EA\u72EC\u7ACB\uFF09\u3002',
      "",
      "\u52A8\u4F5C\uFF1A",
      "- status\uFF1A\u67E5\u770B\u5F53\u524D\u4E24\u4E2A\u5F00\u5173\u662F\u5F00\u8FD8\u662F\u5173\u3002",
      "- set\uFF1A\u8BBE\u7F6E\u5F00\u5173\uFF0C\u9700\u8981\u540C\u65F6\u7ED9 target\uFF08codex / opencode / all\uFF09\u548C enabled\uFF08true/false\uFF09\u3002",
      "",
      "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
      '- \u7528\u6237\u8BF4"\u522B\u8001\u662F\u6C47\u62A5\u4E86/\u5173\u6389\u90A3\u4E2A\u901A\u77E5/\u592A\u5435\u4E86" \u2192 action=set, target=all, enabled=false\uFF1B',
      '- \u7528\u6237\u8BF4"\u628A\u901A\u77E5\u6253\u5F00/\u6C47\u62A5\u6062\u590D\u4E00\u4E0B" \u2192 action=set, target=all, enabled=true\uFF1B',
      '- \u7528\u6237\u95EE"\u901A\u77E5\u5F00\u7740\u5417" \u2192 action=status\u3002',
      "",
      "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
      '- \u4E0D\u8981\u56E0\u4E3A"\u89C9\u5F97\u5435"\u5C31\u81EA\u5DF1\u5173\u6389\u901A\u77E5\u2014\u2014\u5FC5\u987B\u7528\u6237\u660E\u786E\u8981\u6C42\u624D\u6539\uFF1B',
      '- \u8FD9\u4E2A\u5F00\u5173\u53EA\u5F71\u54CD"\u5916\u90E8\u4EFB\u52A1\u7684\u5B8C\u6210\u6C47\u62A5"\uFF0C\u4E0D\u5F71\u54CD\u4F60\u6B63\u5E38\u7684\u5BF9\u8BDD\u56DE\u590D\u3002'
    ].join("\n"),
    parameters: {
      action: {
        type: "string",
        required: true,
        description: "status\uFF08\u67E5\u770B\uFF09\u6216 set\uFF08\u8BBE\u7F6E\uFF09\u3002"
      },
      target: {
        type: "string",
        description: "set \u65F6\u5FC5\u586B\uFF1Acodex / opencode / all\u3002"
      },
      enabled: {
        type: "boolean",
        description: "set \u65F6\u5FC5\u586B\uFF1Atrue \u6253\u5F00\u3001false \u5173\u95ED\u3002"
      }
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
      render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
    },
    async execute(args) {
      const action = typeof args.action === "string" ? args.action.trim().toLowerCase() : "";
      const render = (state) => `codex \u5B8C\u6210\u6C47\u62A5\uFF1A${state.codex ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED"}
opencode \u5B8C\u6210\u6C47\u62A5\uFF1A${state.opencode ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED"}`;
      const snapshot = async () => settings.snapshot_async === void 0 ? settings.snapshot() : await settings.snapshot_async();
      if (action === "status" || action === "") {
        return { ok: true, text: `\u5F53\u524D\u901A\u77E5\u5F00\u5173\uFF1A
${render(await snapshot())}` };
      }
      if (action !== "set") {
        return { ok: false, text: `\u672A\u77E5\u52A8\u4F5C"${action}"\uFF1B\u53EF\u7528\uFF1Astatus | set` };
      }
      const targets = parse_targets(args.target);
      if (targets === void 0) {
        return { ok: false, text: "target \u5FC5\u987B\u662F codex / opencode / all \u4E4B\u4E00\u3002" };
      }
      if (typeof args.enabled !== "boolean") {
        return { ok: false, text: "set \u9700\u8981 enabled\uFF08true \u6253\u5F00\u3001false \u5173\u95ED\uFF09\u3002" };
      }
      for (const target of targets) {
        if (settings.set_enabled_async === void 0) settings.set_enabled(target, args.enabled);
        else await settings.set_enabled_async(target, args.enabled);
      }
      return {
        ok: true,
        text: `\u5DF2${args.enabled ? "\u5F00\u542F" : "\u5173\u95ED"}\uFF1A${targets.join("\u3001")}\u3002
${render(await snapshot())}`
      };
    }
  }));
}

// backend/packages/webhook/webhook-weixin/src/memory/bridgeResultTools.ts
import { defineTool as defineTool5 } from "@deepseek-ai/dsh-tools";
var MAX_CHARS3 = 6e3;
function clip3(text) {
  return text.length <= MAX_CHARS3 ? text : `${text.slice(0, MAX_CHARS3)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF0C\u8FD8\u6709\u66F4\u591A\u6761\uFF0C\u53EF\u518D\u67E5\uFF09`;
}
function ago(ms) {
  const minutes = Math.round((Date.now() - ms) / 6e4);
  if (minutes < 1) return "\u521A\u521A";
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  return `${Math.round(minutes / 60)} \u5C0F\u65F6\u524D`;
}
function register_bridge_result_tools(agent_ctx, store, retention_ms = 6 * 36e5) {
  agent_ctx.tools.register(defineTool5({
    name: "bridge_results",
    description: [
      'codex-opencode \u5904\u7406\u7ED3\u679C\u65E5\u5FD7\uFF1A\u67E5\u770B"\u4EFB\u52A1\u5DF2\u5B8C\u6210\u3001\u4F46\u5F53\u65F6\u6CA1\u80FD\u53D1\u7ED9\u4F60"\u7684\u5904\u7406\u7ED3\u679C\u3002',
      "",
      "\u80CC\u666F\uFF1A\u5FAE\u4FE1\u53EA\u5141\u8BB8\u5728\u4F60\u521A\u53D1\u8FC7\u6D88\u606F\u7684\u90A3\u4E00\u5C0F\u6BB5\u65F6\u95F4\u5185\u53D1\u9001\u3002\u6240\u4EE5\u4F60\u5728\u5FD9\u522B\u7684\u4E8B\u65F6\uFF0C",
      `\u7531 codex / opencode \u8DD1\u5B8C\u7684\u4EFB\u52A1\u7ED3\u679C\u4F1A**\u505C\u653E\u5728\u8FD9\u91CC**\uFF08\u4FDD\u7559 ${Math.round(retention_ms / 36e5)} \u5C0F\u65F6\uFF09\uFF0C\u4E0D\u4F1A\u4E3B\u52A8\u63A8\u7ED9\u4F60\u3002`,
      "",
      "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
      '- \u7528\u6237\u95EE"\u521A\u624D\u90A3\u4E2A\u4EFB\u52A1\u505A\u5B8C\u4E86\u5417 / \u6709\u4EC0\u4E48\u7ED3\u679C / \u6709\u6CA1\u6709\u4EC0\u4E48\u8981\u544A\u8BC9\u6211\u7684"\uFF1B',
      "- \u7528\u6237\u63D0\u5230\u4E4B\u524D\u8BA9 codex \u6216 opencode \u505A\u7684\u4E8B\uFF0C\u800C\u4F60\u4E0D\u786E\u5B9A\u7ED3\u679C\u3002",
      "",
      "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A",
      "- \u7528\u6237\u6CA1\u95EE\u3001\u4E5F\u6CA1\u6709\u76F8\u5173\u8BDD\u9898\u65F6\uFF0C\u4E0D\u8981\u4E3B\u52A8\u53BB\u7FFB\u8FD9\u4E2A\u65E5\u5FD7\uFF1B",
      '- \u8FD9\u91CC\u53EA\u6709"\u7ED3\u679C"\uFF0C\u6CA1\u6709\u4E2D\u95F4\u8FC7\u7A0B\u2014\u2014\u4E2D\u95F4\u8FC7\u7A0B\u4E0D\u4F1A\u63A8\u4E5F\u4E0D\u5728\u8FD9\u91CC\u3002'
    ].join("\n"),
    parameters: {
      limit: { type: "number", description: "\u6700\u591A\u8FD4\u56DE\u591A\u5C11\u6761\uFF0C\u9ED8\u8BA4 10\u3002" },
      keyword: { type: "string", description: "\u53EF\u9009\uFF1A\u53EA\u8FD4\u56DE\u5305\u542B\u8BE5\u5173\u952E\u8BCD\u7684\u7ED3\u679C\u3002" }
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
      render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
    },
    async execute(args) {
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
      const keyword = typeof args.keyword === "string" ? args.keyword.trim() : "";
      let rows = await store.parked_results(limit * 3);
      if (keyword !== "") rows = rows.filter((row) => row.text.includes(keyword));
      rows = rows.slice(0, limit);
      probe("bridge-results", "queried", { count: rows.length, keyword });
      if (rows.length === 0) {
        return {
          ok: true,
          text: keyword === "" ? "\u5904\u7406\u7ED3\u679C\u65E5\u5FD7\u91CC\u6CA1\u6709\u5F85\u53D6\u56DE\u7684\u7ED3\u679C\uFF08\u8BF4\u660E\u8BE5\u63A8\u7684\u90FD\u5DF2\u7ECF\u53D1\u51FA\u53BB\u4E86\uFF09\u3002" : `\u6CA1\u6709\u5305\u542B"${keyword}"\u7684\u5904\u7406\u7ED3\u679C\u3002`
        };
      }
      const blocks = rows.map((row) => `### ${ago(row.created_at)}
${row.text.trim()}`);
      return { ok: true, text: clip3(`\u6709 ${rows.length} \u6761\u5F85\u53D6\u56DE\u7684\u5904\u7406\u7ED3\u679C\uFF1A

${blocks.join("\n\n")}`) };
    }
  }));
}

// backend/packages/webhook/webhook-weixin/src/coordination/bridgeSessionTools.ts
import { existsSync as existsSync10, readFileSync as readFileSync8, statSync as statSync5 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join10 } from "node:path";
import { DatabaseSync as DatabaseSync4 } from "node:sqlite";
import { defineTool as defineTool6 } from "@deepseek-ai/dsh-tools";
var MAX_CHARS4 = 6e3;
function codex_home() {
  return process.env.CODEX_HOME ?? join10(process.env.USERPROFILE ?? homedir2(), ".codex");
}
function opencode_data_dir() {
  return process.env.OPENCODE_DATA_DIR ?? join10(process.env.USERPROFILE ?? homedir2(), ".local", "share", "opencode");
}
function list_codex_sessions(limit = 8) {
  const state_path = join10(codex_home(), "state_5.sqlite");
  if (!existsSync10(state_path)) return [];
  let db;
  try {
    db = new DatabaseSync4(state_path, { readOnly: true });
    const rows = db.prepare(
      "SELECT id, rollout_path, cwd, title, updated_at FROM threads WHERE archived = 0 ORDER BY updated_at DESC LIMIT ?"
    ).all(limit);
    return rows.map((row) => {
      const rollout = String(row.rollout_path ?? "");
      const last_user = read_codex_messages(rollout, 12).filter((item) => item.role === "user").at(-1);
      const title = last_user?.text ?? String(row.title ?? "\u672A\u547D\u540D\u4EFB\u52A1");
      return {
        tool: "codex",
        id: String(row.id),
        title: title.slice(0, 80),
        workspace: normalize_path2(String(row.cwd ?? "")),
        status: codex_lifecycle(rollout),
        updated_at: Number(row.updated_at ?? 0),
        rollout_path: rollout
      };
    });
  } catch (error) {
    probe("bridge-sessions", "codex_db_failed", { error: String(error) });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function codex_lifecycle(rollout_path) {
  if (rollout_path === "" || !existsSync10(rollout_path)) return "\u8BB0\u5F55\u7F3A\u5931";
  const patterns = [
    ['"type":"task_complete"', "\u5DF2\u5B8C\u6210"],
    ['"type":"turn_aborted"', "\u5DF2\u4E2D\u6B62"],
    ['"type":"task_started"', "\u8FD0\u884C\u4E2D"]
  ];
  try {
    const size = statSync5(rollout_path).size;
    const data = readFileSync8(rollout_path);
    const tail = data.subarray(Math.max(0, size - 512 * 1024)).toString("utf8");
    const lines = tail.split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      for (const [marker, status] of patterns) {
        if (line.includes(marker)) return status;
      }
    }
  } catch {
  }
  return "\u672A\u77E5";
}
function read_codex_messages(rollout_path, limit = 12) {
  if (rollout_path === "" || !existsSync10(rollout_path)) return [];
  const out = [];
  try {
    const size = statSync5(rollout_path).size;
    const data = readFileSync8(rollout_path);
    const text = data.subarray(Math.max(0, size - 4 * 1024 * 1024)).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"role":"user"') && !line.includes('"role":"assistant"')) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "response_item" || parsed.payload?.type !== "message") continue;
        const role = parsed.payload.role;
        if (role !== "user" && role !== "assistant") continue;
        const parts = (parsed.payload.content ?? []).map((part) => part.text ?? part.output_text ?? "").filter((item) => item.trim() !== "");
        const body = parts.join("\n").trim();
        if (body === "") continue;
        const clean = role === "user" ? clean_user_message2(body) : body;
        if (clean === "") continue;
        out.push({ role, text: clean, ...parsed.timestamp === void 0 ? {} : { at: parsed.timestamp } });
      } catch {
      }
    }
  } catch (error) {
    probe("bridge-sessions", "codex_rollout_failed", { error: String(error) });
  }
  return out.slice(-limit);
}
function normalize_path2(path) {
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
function clean_user_message2(message) {
  const marker = "## My request for Codex:";
  let text = message;
  if (text.includes(marker)) text = text.slice(text.indexOf(marker) + marker.length);
  text = text.trim();
  if (text.startsWith("<environment_context>") || text.startsWith("<permissions instructions>")) return "";
  return text;
}
function list_opencode_sessions(limit = 8) {
  const db_path = join10(opencode_data_dir(), "opencode.db");
  if (!existsSync10(db_path)) return [];
  let db;
  try {
    db = new DatabaseSync4(db_path, { readOnly: true });
    const rows = db.prepare(
      "SELECT id, directory, title, time_created, time_updated FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT ?"
    ).all(limit);
    return rows.map((row) => ({
      tool: "opencode",
      id: String(row.id),
      title: String(row.title ?? "").trim() || "(\u65E0\u6807\u9898)",
      workspace: String(row.directory ?? ""),
      status: "opencode \u4F1A\u8BDD",
      updated_at: Number(row.time_updated ?? 0)
    }));
  } catch (error) {
    probe("bridge-sessions", "opencode_db_failed", { error: String(error) });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
}
function read_opencode_messages(session_id, limit = 12) {
  const db_path = join10(opencode_data_dir(), "opencode.db");
  if (session_id === "" || !existsSync10(db_path)) return [];
  let db;
  const out = [];
  try {
    db = new DatabaseSync4(db_path, { readOnly: true });
    const scan = Math.min(400, Math.max(limit * 8, 40));
    const messages = db.prepare(
      "SELECT id, data FROM message WHERE session_id = ? ORDER BY rowid DESC LIMIT ?"
    ).all(session_id, scan);
    for (const message of messages.reverse()) {
      let role = "";
      try {
        const parsed = JSON.parse(message.data);
        role = String(parsed.role ?? "");
      } catch {
      }
      if (role !== "user" && role !== "assistant") continue;
      const parts = db.prepare(
        "SELECT data FROM part WHERE message_id = ? ORDER BY rowid ASC"
      ).all(message.id);
      const texts = [];
      for (const part of parts) {
        try {
          const parsed = JSON.parse(part.data);
          if (parsed.type === "text" && typeof parsed.text === "string" && parsed.text.trim() !== "") {
            texts.push(parsed.text.trim());
          }
        } catch {
        }
      }
      if (texts.length === 0) continue;
      out.push({ role, text: texts.join("\n") });
    }
  } catch (error) {
    probe("bridge-sessions", "opencode_messages_failed", { error: String(error) });
    return [];
  } finally {
    try {
      db?.close();
    } catch {
    }
  }
  return out.slice(-limit);
}
function ago2(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "\u65F6\u95F4\u672A\u77E5";
  const minutes = Math.round((Date.now() - ms) / 6e4);
  if (minutes < 1) return "\u521A\u521A";
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} \u5C0F\u65F6\u524D`;
  return `${Math.round(hours / 24)} \u5929\u524D`;
}
function clip4(text) {
  return text.length <= MAX_CHARS4 ? text : `${text.slice(0, MAX_CHARS4)}
\u2026\uFF08\u5DF2\u622A\u65AD\uFF09`;
}
function render_sessions(sessions, tool) {
  const mine = sessions.filter((item) => item.tool === tool);
  if (mine.length === 0) return [`\u3010${tool} \u4F1A\u8BDD\u3011\u6CA1\u6709\u627E\u5230\u4F1A\u8BDD\u8BB0\u5F55\u3002`];
  const lines = [`\u3010${tool} \u4F1A\u8BDD\u3011\u6700\u8FD1 ${mine.length} \u4E2A\uFF1A`];
  for (const item of mine) {
    const short = item.id.slice(0, 8);
    const name2 = item.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
    lines.push(`- ${short}\u2026\uFF08${item.id}\uFF09`);
    lines.push(`    \u4EFB\u52A1\uFF1A${item.title}`);
    lines.push(`    \u9879\u76EE\uFF1A${name2 || item.workspace}\u3000\u72B6\u6001\uFF1A${item.status}\u3000\u66F4\u65B0\uFF1A${ago2(item.updated_at)}`);
  }
  return lines;
}
function register_bridge_session_tools(agent_ctx) {
  agent_ctx.tools.register(defineTool6({
    name: "bridge_sessions",
    description: [
      "codex/opencode \u4F1A\u8BDD\u8BB0\u5F55\uFF1A\u5217\u51FA\u672C\u673A Codex \u4E0E opencode \u7684\u4F1A\u8BDD\uFF08\u5E26\u540D\u5B57\u4E0E\u9879\u76EE\uFF09\uFF0C",
      "\u6216\u8BFB\u67D0\u4E2A\u4F1A\u8BDD\u7684\u804A\u5929\u8BB0\u5F55\u3002\u7528\u4E8E**\u8FDC\u7A0B\u6307\u6325**\u8FD9\u4E9B\u4F1A\u8BDD\u3002",
      "",
      "\u4E24\u79CD\u7528\u6CD5\uFF1A",
      "- \u4E0D\u586B session_id\uFF1A\u5217\u51FA\u4E24\u4E2A\u5DE5\u5177\u7684\u6700\u8FD1\u4F1A\u8BDD\uFF08\u542B\u4F1A\u8BDD id\u3001\u4EFB\u52A1\u540D\u3001\u9879\u76EE\u3001\u72B6\u6001\u3001\u66F4\u65B0\u65F6\u95F4\uFF09\uFF1B",
      "- \u586B session_id\uFF1A\u8BFB\u90A3\u4E2A\u4F1A\u8BDD\u6700\u8FD1\u7684\u804A\u5929\u8BB0\u5F55\uFF08\u7528\u6237\u8BF4\u4E86\u4EC0\u4E48\u3001\u52A9\u624B\u56DE\u4E86\u4EC0\u4E48\uFF09\u3002",
      "",
      "\u4EC0\u4E48\u65F6\u5019\u8BE5\u7528\uFF1A",
      '- \u7528\u6237\u95EE"\u6709\u54EA\u4E9B\u4F1A\u8BDD/\u4E0A\u6B21\u90A3\u4E2A\u4EFB\u52A1\u53EB\u4EC0\u4E48/\u90A3\u4E2A\u9879\u76EE\u505A\u5230\u54EA\u4E86"\uFF1B',
      "- \u7528\u6237\u60F3\u7EE7\u7EED\u67D0\u4E2A\u4EFB\u52A1\uFF0C\u4F46\u6CA1\u8BF4\u6E05\u662F\u54EA\u4E2A\u4F1A\u8BDD\u2014\u2014\u5148\u5217\u51FA\u6765\u8BA9\u4ED6\u786E\u8BA4\uFF1B",
      '- \u7528\u6237\u95EE"\u4F60\u521A\u624D\u5728\u90A3\u4E2A\u4F1A\u8BDD\u91CC\u8BF4\u4E86\u4EC0\u4E48/\u7ED3\u679C\u662F\u4EC0\u4E48"\u3002',
      "",
      "\u62FF\u5230 session_id \u4E4B\u540E\uFF0C\u53EF\u4EE5\u7528 `codex` / `opencode` \u5DE5\u5177\u7EED\u90A3\u4E2A\u4F1A\u8BDD\uFF08\u4E0D\u8981\u51ED\u5370\u8C61\u7F16\u9020\u4F1A\u8BDD id\uFF09\u3002",
      "\u4EC0\u4E48\u65F6\u5019\u4E0D\u8BE5\u7528\uFF1A\u7528\u6237\u53EA\u662F\u95F2\u804A\u3001\u6216\u660E\u786E\u5728\u8BF4\u5FAE\u4FE1\u8FD9\u8FB9\u7684\u5BF9\u8BDD\u65F6\u4E0D\u8981\u8C03\u7528\u3002"
    ].join("\n"),
    parameters: {
      tool: {
        type: "string",
        description: "\u67E5\u54EA\u4E2A\u5DE5\u5177\uFF1Acodex | opencode | both\uFF08\u9ED8\u8BA4 both\uFF09\u3002"
      },
      session_id: {
        type: "string",
        description: "\u8981\u8BFB\u804A\u5929\u8BB0\u5F55\u7684\u4F1A\u8BDD id\uFF08\u5217\u8868\u91CC\u90A3\u4E00\u957F\u4E32\uFF09\uFF1B\u4E0D\u586B\u5C31\u53EA\u5217\u4F1A\u8BDD\u3002"
      },
      limit: { type: "number", description: "\u6700\u591A\u51E0\u6761\uFF0C\u9ED8\u8BA4 8\uFF08\u5217\u4F1A\u8BDD\uFF09/ 12\uFF08\u8BFB\u8BB0\u5F55\uFF09\u3002" }
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
      render: (_args, value) => [{ type: "text", text: String(value.text ?? "") }]
    },
    async execute(args) {
      const tool = (args.tool ?? "both").trim().toLowerCase();
      const session_id = typeof args.session_id === "string" ? args.session_id.trim() : "";
      const limit = Number.isFinite(Number(args.limit)) && Number(args.limit) > 0 ? Math.min(30, Math.floor(Number(args.limit))) : session_id === "" ? 8 : 12;
      if (session_id !== "") {
        const codex_sessions = list_codex_sessions(30);
        const codex_hit = codex_sessions.find((item) => item.id === session_id || item.id.startsWith(session_id));
        if (codex_hit !== void 0 && codex_hit.rollout_path !== void 0) {
          const messages = read_codex_messages(codex_hit.rollout_path, limit);
          return {
            ok: true,
            text: clip4(render_messages("codex", codex_hit, messages))
          };
        }
        const opencode_sessions = list_opencode_sessions(30);
        const opencode_hit = opencode_sessions.find((item) => item.id === session_id || item.id.startsWith(session_id));
        if (opencode_hit !== void 0) {
          const messages = read_opencode_messages(opencode_hit.id, limit);
          return { ok: true, text: clip4(render_messages("opencode", opencode_hit, messages)) };
        }
        return {
          ok: true,
          text: `\u6CA1\u6709\u627E\u5230\u4F1A\u8BDD"${session_id}"\u3002\u53EF\u4EE5\u4E0D\u5E26 session_id \u5148\u5217\u4E00\u904D\uFF08\u4F1A\u8BDD id \u5F88\u957F\uFF0C\u5217\u8868\u91CC\u7ED9\u7684\u662F\u5B8C\u6574 id\uFF0C\u8BF7\u6574\u4E32\u7167\u6284\uFF09\u3002`
        };
      }
      const sessions = [
        ...tool === "opencode" ? [] : list_codex_sessions(limit),
        ...tool === "codex" ? [] : list_opencode_sessions(limit)
      ];
      if (sessions.length === 0) {
        return { ok: true, text: "\u672C\u673A\u6CA1\u6709\u627E\u5230 Codex / opencode \u7684\u4F1A\u8BDD\u8BB0\u5F55\u3002" };
      }
      const lines = [];
      if (tool !== "opencode") lines.push(...render_sessions(sessions, "codex"));
      if (tool !== "codex") {
        if (lines.length > 0) lines.push("");
        lines.push(...render_sessions(sessions, "opencode"));
      }
      lines.push("", "\uFF08\u8981\u770B\u67D0\u4E2A\u4F1A\u8BDD\u7684\u804A\u5929\u8BB0\u5F55\uFF1A\u628A\u5B83\u7684\u4F1A\u8BDD id \u4F20\u7ED9\u672C\u5DE5\u5177\u7684 session_id\u3002\uFF09");
      return { ok: true, text: clip4(lines.join("\n")) };
    }
  }));
}
function render_messages(tool, session, messages) {
  const name2 = session.workspace.split(/[\\/]/).filter(Boolean).at(-1) ?? session.workspace;
  const lines = [
    `\u3010${tool} \u4F1A\u8BDD ${session.id}\u3011`,
    `\u4EFB\u52A1\uFF1A${session.title}`,
    `\u9879\u76EE\uFF1A${name2}\u3000\u72B6\u6001\uFF1A${session.status}\u3000\u66F4\u65B0\uFF1A${ago2(session.updated_at)}`,
    ""
  ];
  if (messages.length === 0) {
    lines.push("\uFF08\u8FD9\u4E2A\u4F1A\u8BDD\u91CC\u6CA1\u6709\u53EF\u8BFB\u7684\u5BF9\u8BDD\u5185\u5BB9\uFF09");
    return lines.join("\n");
  }
  for (const message of messages) {
    lines.push(`[${message.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}] ${message.text}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// backend/packages/webhook/webhook-weixin/src/coordination/externalRuns.ts
import { execFileSync as execFileSync4 } from "node:child_process";
var RUN_PATTERN = "(opencode|codex).*(run|exec)\\b";
function kill_external_runs() {
  if (process.platform !== "win32") {
    return { killed: 0, pids: [], error: "\u975E Windows \u5E73\u53F0\u672A\u5B9E\u73B0\u5916\u90E8\u8FDB\u7A0B\u4E2D\u65AD" };
  }
  try {
    const list = execFileSync4("powershell", [
      "-NoProfile",
      "-Command",
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${RUN_PATTERN}' -and $_.Name -notmatch 'powershell|pwsh' } | ForEach-Object { $_.ProcessId }`
    ], { encoding: "utf8", windowsHide: true, timeout: 2e4 });
    const pids = list.split("\n").map((line) => Number(line.trim())).filter((value) => Number.isInteger(value) && value > 0);
    if (pids.length === 0) {
      probe("external-runs", "kill.none", {});
      return { killed: 0, pids: [] };
    }
    for (const pid of pids) {
      try {
        execFileSync4("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 2e4 });
      } catch {
      }
    }
    probe("external-runs", "kill.done", { pids });
    return { killed: pids.length, pids };
  } catch (error) {
    probe("external-runs", "kill.failed", { error: String(error).slice(0, 160) });
    return { killed: 0, pids: [], error: String(error).slice(0, 160) };
  }
}

// backend/packages/webhook/webhook-weixin/src/runtime/modelFailover.ts
import { existsSync as existsSync11 } from "node:fs";
import { join as join11 } from "node:path";
function find_model_config(workspace) {
  const candidates = [join11(workspace, "config", "modelConfig.json"), join11(workspace, "modelConfig.json")];
  return candidates.find((path) => existsSync11(path));
}
var DEFAULT_COOLDOWN_MS = 60 * 6e4;
var AUTH_COOLDOWN_MS = 24 * 60 * 6e4;
var RATE_LIMIT_COOLDOWN_MS = 3 * 6e4;
var NON_CHAT_PROVIDERS = /* @__PURE__ */ new Set(["gemma-local"]);
function classify_llm_failure(message) {
  const text = message.toLowerCase();
  if (/限额|额度|quota|insufficient|欠费|余额不足/.test(text)) {
    return "quota";
  }
  if (/concurrent|too many requests|overload|temporarily unavailable|请稍后重试|并发|繁忙|(^|[^0-9])429([^0-9]|$)/.test(text)) {
    return "rate_limit";
  }
  if (/(^|[^0-9])40[13]([^0-9]|$)|unauthorized|forbidden|invalid.?api.?key|api.?key.*(invalid|无效|失效|不正确)|鉴权|认证失败|token.*(invalid|无效|过期)/.test(text)) {
    return "auth";
  }
  if (/(^|[^0-9])404([^0-9]|$)|model.*not.*found|no such model|does not exist|模型不存在|模型已下线/.test(text)) {
    return "model_missing";
  }
  return void 0;
}
function cooldown_ms(reason, config) {
  if (reason === "rate_limit") return RATE_LIMIT_COOLDOWN_MS;
  return reason === "quota" ? config.cooldown_ms : AUTH_COOLDOWN_MS;
}
function parse_failover_config(config) {
  const raw = config.failover ?? {};
  const enabled = raw.enabled !== false;
  const cooldown = Number(raw.cooldownMs);
  const known = (provider, model) => {
    const entry = (config.providers ?? {})[provider];
    if (entry === void 0) return false;
    return (entry.models ?? []).some((item) => item.id === model);
  };
  const explicit = (raw.order ?? []).filter((item) => typeof item?.provider === "string" && typeof item?.model === "string" && item.provider !== "" && item.model !== "").map((item) => ({ provider: String(item.provider), model: String(item.model) })).filter((item) => known(item.provider, item.model));
  const derived = [];
  const push = (candidate) => {
    if (derived.some((item) => item.provider === candidate.provider && item.model === candidate.model)) return;
    derived.push(candidate);
  };
  const default_model = config.defaultModel;
  if (default_model?.provider !== void 0 && default_model?.model !== void 0) {
    push({ provider: default_model.provider, model: default_model.model });
  }
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    if (NON_CHAT_PROVIDERS.has(provider)) continue;
    if (entry.apiKey === void 0 || entry.apiKey === "") continue;
    for (const model of entry.models ?? []) {
      if (typeof model.id === "string" && model.id !== "") push({ provider, model: model.id });
    }
  }
  const order = explicit.length > 0 ? explicit : derived;
  return {
    enabled,
    order,
    cooldown_ms: Number.isFinite(cooldown) && cooldown > 0 ? cooldown : DEFAULT_COOLDOWN_MS
  };
}
function next_alive_candidate(order, current, is_dead) {
  const start = current === void 0 ? 0 : Math.max(0, order.findIndex((item) => item.provider === current.provider && item.model === current.model) + 1);
  for (let index = start; index < order.length; index += 1) {
    const candidate = order[index];
    if (!is_dead(candidate)) return candidate;
  }
  for (let index = 0; index < start && index < order.length; index += 1) {
    const candidate = order[index];
    if (!is_dead(candidate)) return candidate;
  }
  return void 0;
}
var ModelHealth = class _ModelHealth {
  constructor(now = () => Date.now()) {
    this.now = now;
  }
  dead = /* @__PURE__ */ new Map();
  static key(candidate) {
    return `${candidate.provider}/${candidate.model}`;
  }
  mark_dead(candidate, reason, detail, ms) {
    const entry = { until: this.now() + ms, reason, detail: detail.slice(0, 200), at: this.now() };
    this.dead.set(_ModelHealth.key(candidate), entry);
    return entry;
  }
  mark_alive(candidate) {
    this.dead.delete(_ModelHealth.key(candidate));
  }
  is_dead(candidate) {
    const entry = this.dead.get(_ModelHealth.key(candidate));
    if (entry === void 0) return false;
    if (entry.until <= this.now()) {
      this.dead.delete(_ModelHealth.key(candidate));
      return false;
    }
    return true;
  }
  /** 当前失活的模型（供控制台/诊断展示）。 */
  snapshot() {
    const out = [];
    for (const [key, entry] of this.dead) {
      if (entry.until <= this.now()) continue;
      const [provider, ...rest] = key.split("/");
      out.push({ provider: provider ?? "", model: rest.join("/"), ...entry });
    }
    return out;
  }
};

// backend/packages/webhook/webhook-weixin/src/memory/gemmaSummarizer.ts
var INSTRUCTIONS = [
  '\u3010\u89D2\u8272\u3011\u4F60\u662F\u957F\u671F\u8BB0\u5FC6\u6574\u7406\u5668\u3002\u8F93\u5165\u662F\u67D0\u4E00\u5929"\u7528\u6237"\u4E0E"\u52A9\u624B"\u7684\u5BF9\u8BDD\u8BB0\u5F55\u3002',
  "\u3010\u8F93\u51FA\u683C\u5F0F\u3011",
  '- \u4E2D\u6587\uFF0C\u6700\u591A 6 \u6761\uFF0C\u6BCF\u6761\u4E00\u884C\uFF0C\u4EE5 "- " \u5F00\u5934',
  "- \u6BCF\u884C\u4EE5\u7C7B\u522B\u5F00\u5934\uFF0C\u7C7B\u522B\u53EA\u80FD\u662F\uFF1A\u4E8B\u5B9E / \u5F85\u529E / \u504F\u597D",
  "- \u53EA\u8F93\u51FA\u8FD9\u4E9B\u884C\uFF0C\u4E0D\u8981\u6807\u9898\u3001\u524D\u8A00\u3001\u7ED3\u8BED\u3001\u89E3\u91CA",
  "\u3010\u5B8C\u6210\u6807\u8BB0\u7684\u552F\u4E00\u5224\u636E\u3011",
  'A. \u53EA\u6709"\u8BB0\u5F55\u91CC\u660E\u786E\u8BF4\u4E86\u8FD9\u4EF6\u4E8B\u5DF2\u7ECF\u505A\u5B8C"\u624D\u80FD\u6807"\uFF08\u5DF2\u5B8C\u6210\uFF09"\uFF1A\u52A9\u624B\u7684\u5B8C\u6210\u58F0\u660E\uFF08\u6539\u597D\u4E86/\u5DF2\u53D1\u51FA/\u6D4B\u8BD5\u901A\u8FC7/\u5DF2\u5173\u95ED\uFF09\uFF0C\u6216\u7528\u6237\u7684\u5B8C\u6210\u58F0\u660E\uFF08\u5DF2\u7ECF\u4EA4\u4E86/\u5DF2\u7ECF\u5F04\u5B8C\u4E86/\u4E0D\u7528\u4E86\uFF09\u3002',
  'B. "\u8BBE\u7F6E\u63D0\u9192""\u5B89\u6392\u65F6\u95F4""\u7EA6\u5B9A\u65E5\u671F""\u8BB0\u4E0B\u6765"\u4E00\u5F8B**\u4E0D\u662F**\u5B8C\u6210\uFF0C\u5FC5\u987B\u5199\u6210\u5F85\u529E\u3002',
  'C. \u672A\u5B8C\u6210\u7684\u3001\u6B63\u5728\u8FDB\u884C\u4E2D\u7684\u3001\u672A\u6765\u7684\u4E8B\u60C5\uFF0C\u4E00\u5F8B**\u4E0D\u5F97**\u51FA\u73B0"\uFF08\u5DF2\u5B8C\u6210\uFF09"\u4E09\u4E2A\u5B57\u3002',
  "\u3010\u9010\u884C\u89C4\u5219\u3011",
  '1. \u5DF2\u5B8C\u6210\u7684\u4E8B\u9879\u5199\u6210\uFF1A"- \u4E8B\u5B9E\uFF1A<\u4E8B\u9879>\uFF08\u5DF2\u5B8C\u6210\uFF09"\uFF1B\u5B8C\u6210\u6807\u8BB0**\u53EA\u5141\u8BB8\u51FA\u73B0\u5728 \u4E8B\u5B9E \u884C**\u3002',
  '2. \u5F85\u529E\u5199\u6210\uFF1A"- \u5F85\u529E\uFF1A<\u4E8B\u9879>\uFF08<\u65F6\u95F4\uFF0C\u82E5\u6709>\uFF09"\uFF0C\u5F85\u529E\u884C**\u7981\u6B62**\u51FA\u73B0\u4EFB\u4F55\u5B8C\u6210\u5B57\u6837\u3002',
  '3. \u504F\u597D\u5199\u6210\uFF1A"- \u504F\u597D\uFF1A<\u5185\u5BB9>"\uFF1B\u7528\u6237\u53D1\u6765\u7684\u56FE\u7247\u82E5\u5199\u4E86\u5185\u5BB9\u63CF\u8FF0\uFF0C\u53EF\u5199\u6210 "- \u4E8B\u5B9E\uFF1A\u7528\u6237\u53D1\u6765\u4E00\u5F20\u7167\u7247\uFF08<\u63CF\u8FF0\u8981\u70B9>\uFF09"\u3002',
  "4. \u6BCF\u6761\u5FC5\u987B\u80FD\u5BF9\u5E94\u5230\u8BB0\u5F55\u539F\u8BDD\uFF1B\u5BF9\u5E94\u4E0D\u4E0A\u5C31\u4E0D\u5199\u3002\u7981\u6B62\u63A8\u65AD\u3001\u8865\u5E38\u8BC6\u3001\u8BC4\u4EF7\u3001\u7F16\u9020\u3002",
  "5. \u65F6\u95F4\u53E3\u5F84\u4FDD\u7559\u8BB0\u5F55\u539F\u8BDD\uFF1B\u8BB0\u5F55\u672A\u7ED9\u5177\u4F53\u65E5\u671F\u65F6\u4E0D\u8981\u81EA\u5DF1\u6362\u7B97\u3002",
  "6. \u4E0D\u5199\u5BD2\u6684\u3001\u60C5\u7EEA\u3001\u5BA2\u5957\u8BDD\u3002"
].join("\n");
function render_entries(entries) {
  return entries.map((item) => {
    const head = `[${item.role === "user" ? "\u7528\u6237" : "\u52A9\u624B"}] ${item.text.trim()}`;
    const media = (item.attachments ?? []).map((attach) => `  [\u56FE\u7247${attach.name === void 0 ? "" : " " + attach.name}] ${attach.description ?? "(\u65E0\u63CF\u8FF0)"}`).join("\n");
    return media === "" ? head : `${head}
${media}`;
  }).join("\n");
}
function chunk_entries(entries, budget) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of entries) {
    const cost = item.text.length + 16;
    if (current.length > 0 && size + cost > budget) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
function create_gemma_summarizer(options) {
  const base_url = (options?.base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
  const model = options?.model ?? process.env.DSH_GEMMA_MODEL ?? "gemma-4-E4B-it-Q4_K_M";
  const max_tokens = options?.max_tokens ?? 600;
  const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? "300000");
  const chunk_chars = options?.chunk_chars ?? 24e3;
  const fetch_impl = options?.fetch_impl ?? fetch;
  const complete = options?.complete ?? (async (prompt, tokens) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const response = await fetch_impl(`${base_url}/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          ...process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? "SYNLOVE_LLM_API_KEY"] ? { Authorization: `Bearer ${process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? "SYNLOVE_LLM_API_KEY"]}` } : {}
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: tokens,
          stream: false
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`gemma HTTP ${response.status}`);
      const parsed = await response.json();
      const text = parsed.choices?.[0]?.message?.content ?? "";
      probe("timeline", "gemma.completion", {
        model,
        prompt_tokens: parsed.usage?.prompt_tokens,
        completion_tokens: parsed.usage?.completion_tokens
      });
      return text.trim();
    } finally {
      clearTimeout(timer);
    }
  });
  return async (request) => {
    const rendered = render_entries(request.entries);
    const previous = "";
    if (rendered.length <= chunk_chars) {
      const text = await complete(
        `${INSTRUCTIONS}${previous}

\u3010\u6570\u636E\u3011
\u65E5\u671F\uFF1A${request.date}
\u5BF9\u8BDD\u8BB0\u5F55\uFF1A
${rendered}`,
        max_tokens
      );
      return { text, model };
    }
    const chunks = chunk_entries(request.entries, chunk_chars);
    probe("timeline", "gemma.map_reduce", { date: request.date, chunks: chunks.length, chars: rendered.length });
    const partials = [];
    for (const [index, chunk] of chunks.entries()) {
      const text = await complete(
        `${INSTRUCTIONS}

\u3010\u6570\u636E\u3011
\u8FD9\u662F\u5F53\u5929\u7B2C ${index + 1}/${chunks.length} \u6BB5\u8BB0\u5F55\uFF0C\u8BF7\u53EA\u6574\u7406\u8FD9\u4E00\u6BB5\uFF1A
${render_entries(chunk)}`,
        300
      );
      partials.push(`\u3010\u7B2C ${index + 1} \u6BB5\u3011
${text}`);
    }
    const merged = await complete(
      `${INSTRUCTIONS}${previous}

\u3010\u6570\u636E\u3011
\u4E0B\u9762\u662F\u540C\u4E00\u5929\u5404\u6BB5\u7684\u5C0F\u7ED3\uFF0C\u8BF7\u5408\u5E76\u6210\u4E00\u4EFD\u5F53\u5929\u6458\u8981\uFF08\u683C\u5F0F\u540C\u4E0A\uFF0C\u4E0D\u8981\u7167\u6284\u6BB5\u843D\u7F16\u53F7\uFF09\uFF1A

${partials.join("\n\n")}`,
      max_tokens
    );
    return { text: merged, model };
  };
}

// backend/packages/webhook/webhook-weixin/src/memory/memoryModel.ts
import { existsSync as existsSync12, readFileSync as readFileSync9 } from "node:fs";
import { dirname as dirname3, join as join12 } from "node:path";
var DEFAULT_CLOUD_MODEL = "volcengine/doubao-seed-2-0-lite-260215";
function default_config_path() {
  return join12(process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd(), "config", "modelConfig.json");
}
function resolve_cloud_target(config_path, cloud_model) {
  try {
    const config = JSON.parse(readFileSync9(config_path, "utf8"));
    const [provider_id, model_id] = cloud_model.split("/");
    const provider = config.providers?.[provider_id ?? ""];
    if (provider === void 0) return void 0;
    const model = model_id !== void 0 && model_id !== "" ? model_id : provider.models?.[0]?.id;
    if (model === void 0 || provider.baseURL === void 0) return void 0;
    const api_key = provider.apiKey ?? read_secret_api_key(config_path, provider_id ?? "");
    return {
      base_url: provider.baseURL.replace(/\/$/, ""),
      model,
      ...api_key === void 0 ? {} : { api_key }
    };
  } catch {
    return void 0;
  }
}
function read_secret_api_key(config_path, provider_id) {
  try {
    const secrets_path = join12(dirname3(config_path), "secrets.json");
    if (!existsSync12(secrets_path)) return void 0;
    const secrets = JSON.parse(readFileSync9(secrets_path, "utf8"));
    const key = secrets.providers?.[provider_id]?.apiKey;
    return typeof key === "string" && key !== "" ? key : void 0;
  } catch {
    return void 0;
  }
}
function create_memory_model(options) {
  const timeout_ms = options?.timeout_ms ?? Number(process.env.SYNLOVE_LLM_TIMEOUT_MS ?? "300000");
  const fetch_impl = options?.fetch_impl ?? fetch;
  const engine = options.engine;
  const config_path = options.config_path ?? default_config_path();
  let base_url;
  let model;
  let api_key;
  let label;
  if (engine === "cloud") {
    const wanted = options.cloud_model?.trim() || DEFAULT_CLOUD_MODEL;
    const target = resolve_cloud_target(config_path, wanted);
    if (target === void 0) {
      probe("memory-model", "cloud.resolve_failed", { wanted, config_path });
      const fallback = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
      base_url = fallback;
      model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? "gemma-4-E4B-it-Q4_K_M";
      api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? "SYNLOVE_LLM_API_KEY"];
      label = `\u672C\u5730 Gemma\uFF08\u4E91\u7AEF ${wanted} \u89E3\u6790\u5931\u8D25\uFF0C\u5DF2\u56DE\u9000\uFF09`;
    } else {
      base_url = target.base_url;
      model = target.model;
      api_key = target.api_key;
      label = `\u4E91\u7AEF ${wanted}`;
    }
  } else {
    base_url = (options.gemma_base_url ?? process.env.GEMMA_LOCAL_BASE_URL ?? "http://127.0.0.1:8080/v1").replace(/\/$/, "");
    model = options.gemma_model ?? process.env.DSH_GEMMA_MODEL ?? "gemma-4-E4B-it-Q4_K_M";
    api_key = process.env[process.env.SYNLOVE_LLM_API_KEY_ENV ?? "SYNLOVE_LLM_API_KEY"];
    label = `\u672C\u5730 Gemma\uFF08${model}\uFF09`;
  }
  const chat = async (content, max_tokens) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);
    try {
      const response = await fetch_impl(`${base_url}/chat/completions`, {
        redirect: "error",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...api_key === void 0 ? {} : { Authorization: `Bearer ${api_key}` }
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content }],
          temperature: 0.2,
          max_tokens,
          stream: false
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`\u8BB0\u5FC6\u6A21\u578B HTTP ${response.status}\uFF08${label}\uFF09`);
      const parsed = await response.json();
      probe("memory-model", "completion", {
        label,
        prompt_tokens: parsed.usage?.prompt_tokens,
        completion_tokens: parsed.usage?.completion_tokens
      });
      return parsed.choices?.[0]?.message?.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    label,
    complete: (prompt, max_tokens) => chat(prompt, max_tokens ?? 1200),
    describe_image: async (input) => {
      const instruction = "\u7528\u4E00\u53E5\u4E2D\u6587\u63CF\u8FF0\u8FD9\u5F20\u56FE\u7247\u7684\u4E3B\u8981\u5185\u5BB9\uFF08\u8C01/\u4EC0\u4E48\u3001\u5728\u54EA\u3001\u5728\u505A\u4EC0\u4E48\u3001\u660E\u663E\u7684\u6587\u5B57\uFF09\u3002\u53EA\u8F93\u51FA\u8FD9\u4E00\u53E5\u8BDD\uFF0C\u4E0D\u8981\u8BC4\u4EF7\u3001\u4E0D\u8981\u5BA2\u5957\u3002";
      return chat([
        { type: "text", text: instruction },
        {
          type: "image_url",
          image_url: { url: `data:${input.media_type};base64,${Buffer.from(input.data).toString("base64")}` }
        }
      ], 200);
    }
  };
}

// backend/packages/webhook/webhook-weixin/src/memory/timelineScheduler.ts
function start_timeline_scheduler(options) {
  const interval_ms = options.interval_ms ?? Math.max(1, Number(process.env.DSH_TIMELINE_CHECK_MINUTES ?? "5")) * 6e4;
  let busy = false;
  let stopped = false;
  const run_once = async (now = Date.now()) => {
    if (busy) {
      probe("timeline", "check.skipped_busy");
      return [];
    }
    busy = true;
    try {
      const due = await options.store.days_needing_summary(now);
      if (due.length === 0) return [];
      probe("timeline", "check.due", { dates: due });
      const updated = await options.store.summarize_due(options.summarizer, now);
      if (updated.length > 0) options.on_update?.(updated);
      return updated;
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    void run_once();
  }, interval_ms);
  timer.unref?.();
  probe("timeline", "scheduler.started", { interval_ms });
  return {
    run_once,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      probe("timeline", "scheduler.stopped");
    }
  };
}

// backend/packages/webhook/webhook-weixin/src/memory/sharedMemory.ts
var suite;
function set_shared_memory(next) {
  suite = next;
}
function get_shared_memory() {
  return suite;
}

// backend/packages/webhook/webhook-weixin/src/state/stateRemoteClient.ts
var StateRemoteClient = class {
  base_url;
  api_key;
  timeout_ms;
  /** 读取配置并创建远程状态客户端。 */
  constructor(options = {}) {
    this.base_url = (options.base_url ?? process.env.SYNLOVE_STATE_BASE_URL ?? "http://127.0.0.1:8798/v1").replace(/\/+$/, "");
    this.api_key = options.api_key ?? process.env.SYNLOVE_STATE_API_KEY ?? "";
    this.timeout_ms = Math.max(1e3, Math.min(12e4, options.timeout_ms ?? 3e4));
  }
  /** 关闭远程客户端；HTTP 无持久连接，方法保持与本地状态库对称。 */
  close() {
  }
  /** 调用远程工具并返回结构化结果。 */
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
          requestId: `state-${crypto.randomUUID()}`,
          message: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: name2, arguments: arguments_ } }
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`state \u670D\u52A1 HTTP ${response.status}`);
      let operation = await response.json();
      while (operation.state === "running") {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const status = await fetch(`${this.base_url}/operations/${encodeURIComponent(String(operation.requestId ?? ""))}`, {
          headers: this.api_key === "" ? {} : { Authorization: `Bearer ${this.api_key}` },
          signal: controller.signal
        });
        operation = await status.json();
      }
      if (operation.state !== "done") throw new Error(`state \u670D\u52A1\u4EFB\u52A1\u72B6\u6001 ${String(operation.state)}`);
      const outer = operation.result ?? {};
      const rpc = outer.result ?? outer;
      if (rpc.isError === true) throw new Error(String(rpc.content ?? "state \u670D\u52A1\u8C03\u7528\u5931\u8D25"));
      return rpc.structuredContent ?? {};
    } finally {
      clearTimeout(timer);
    }
  }
  /** 读取游标。 */
  async get_cursor() {
    return String((await this.call("state_get_cursor")).cursor ?? "");
  }
  /** 写入游标。 */
  async set_cursor(cursor) {
    await this.call("state_set_cursor", { cursor });
  }
  /** 读取用户会话路由。 */
  async get_session_id(user_id) {
    const value = (await this.call("state_get_session", { userId: user_id })).sessionId;
    return typeof value === "string" ? value : void 0;
  }
  /** 写入用户会话路由。 */
  async set_session_id(user_id, session_id) {
    await this.call("state_set_session", { userId: user_id, sessionId: session_id });
  }
  /** 读取元数据。 */
  async get_meta(key) {
    const value = (await this.call("state_get_meta", { key })).value;
    return typeof value === "string" ? value : void 0;
  }
  /** 写入元数据。 */
  async set_meta(key, value) {
    await this.call("state_set_meta", { key, value });
  }
  /** 按前缀读取元数据。 */
  async list_meta_prefix(prefix) {
    const items = (await this.call("state_list_meta_prefix", { prefix })).items;
    return Array.isArray(items) ? items : [];
  }
  /** 删除元数据。 */
  async delete_meta(key) {
    await this.call("state_delete_meta", { key });
  }
  /** 生成用户当前会话 ID。 */
  async session_id_for(user_id) {
    return String((await this.call("state_session_id_for", { userId: user_id })).sessionId ?? `weixin-${user_id}`);
  }
  /** 读取上下文代次。 */
  async context_epoch(user_id) {
    return Number((await this.call("state_context_epoch", { userId: user_id })).epoch ?? 0);
  }
  /** 递增上下文代次。 */
  async bump_context_epoch(user_id) {
    return Number((await this.call("state_bump_context_epoch", { userId: user_id })).epoch ?? 0);
  }
  /** 清除用户路由。 */
  async clear_session_id(user_id) {
    await this.call("state_clear_session", { userId: user_id });
  }
  /** 列出已有路由的用户。 */
  async list_users() {
    const users = (await this.call("state_list_users")).users;
    return Array.isArray(users) ? users.filter((item) => typeof item === "string") : [];
  }
  /** 清空未完成出站队列。 */
  async clear_queue() {
    return Number((await this.call("state_clear_queue")).removed ?? 0);
  }
  /** 读取状态服务诊断快照。 */
  async snapshot() {
    return this.call("state_snapshot");
  }
  /** 幂等登记入站投递。 */
  async put_delivery_if_absent(record) {
    return (await this.call("state_put_delivery", { record })).first === true;
  }
  /** 读取入站投递。 */
  async get_delivery(delivery_id) {
    return (await this.call("state_get_delivery", { deliveryId: delivery_id })).delivery;
  }
  /** 读取入站投递的上下文令牌。 */
  async delivery_context_token(delivery_id) {
    const value = (await this.call("state_delivery_context_token", { deliveryId: delivery_id })).contextToken;
    return typeof value === "string" ? value : void 0;
  }
  /** 更新入站投递状态。 */
  async update_delivery(delivery_id, status, patch) {
    return (await this.call("state_update_delivery", { deliveryId: delivery_id, status, patch })).updated === true;
  }
  /** 列出未完成入站投递。 */
  async list_unfinished_deliveries(limit = 200) {
    const rows = (await this.call("state_list_unfinished_deliveries", { limit })).deliveries;
    return Array.isArray(rows) ? rows : [];
  }
  /** 检查一批投递是否可提交游标。 */
  async batch_committable(delivery_ids) {
    return (await this.call("state_batch_committable", { deliveryIds: [...delivery_ids] })).committable === true;
  }
  /** 读取最近入站用户。 */
  async latest_user_id() {
    const value = (await this.call("state_latest_user")).userId;
    return typeof value === "string" ? value : void 0;
  }
  /** 写入出站队列。 */
  async enqueue_outbox(input) {
    return (await this.call("state_enqueue_outbox", { input })).outbox;
  }
  /** 读取指定会话下一条出站消息。 */
  async next_outbox(session_id, now) {
    return (await this.call("state_next_outbox", { sessionId: session_id, ...now === void 0 ? {} : { now } })).outbox;
  }
  /** 读取各会话下一条待发送消息。 */
  async next_outbox_per_session(now) {
    const rows = (await this.call("state_next_outbox_per_session", now === void 0 ? {} : { now })).outbox;
    return Array.isArray(rows) ? rows : [];
  }
  /** 列出需要恢复的出站消息。 */
  async list_pending_outbox(limit = 500) {
    const rows = (await this.call("state_list_pending_outbox", { limit })).outbox;
    return Array.isArray(rows) ? rows : [];
  }
  /** 读取出站消息。 */
  async get_outbox(outbound_id) {
    return (await this.call("state_get_outbox", { outboundId: outbound_id })).outbox;
  }
  /** 标记出站消息发送中。 */
  async mark_outbox_sending(outbound_id) {
    await this.call("state_mark_outbox_sending", { outboundId: outbound_id });
  }
  /** 标记出站消息已发送。 */
  async mark_outbox_sent(outbound_id) {
    await this.call("state_mark_outbox_sent", { outboundId: outbound_id });
  }
  /** 标记出站消息失败。 */
  async mark_outbox_failed(outbound_id, status, error, next_retry_at) {
    await this.call("state_mark_outbox_failed", {
      outboundId: outbound_id,
      status,
      error,
      ...next_retry_at === void 0 ? {} : { nextRetryAt: next_retry_at }
    });
  }
  /** 记录出站消息分段。 */
  async mark_outbox_part_sent(outbound_id, index) {
    await this.call("state_mark_outbox_part_sent", { outboundId: outbound_id, index });
  }
  /** 读取停放通知。 */
  async parked_results(limit = 20) {
    const rows = (await this.call("state_parked_results", { limit })).results;
    return Array.isArray(rows) ? rows : [];
  }
  /** 清理过期停放通知。 */
  async prune_parked_results(max_age_ms, now) {
    const result = await this.call("state_prune_parked_results", { maxAgeMs: max_age_ms, ...now === void 0 ? {} : { now } });
    return Number(result.removed ?? 0);
  }
  /** 限制待发通知数量。 */
  async trim_pending_notices(session_id, keep = 3) {
    const result = await this.call("state_trim_pending_notices", { sessionId: session_id, keep });
    return Number(result.removed ?? 0);
  }
  /** 记录轮次上下文。 */
  async bind_turn_context(input) {
    await this.call("state_bind_turn_context", { input });
  }
  /** 读取轮次上下文。 */
  async get_turn_context(session_id, turn) {
    return (await this.call("state_get_turn_context", { sessionId: session_id, turn })).context;
  }
  /** 读取会话最近一条已处理入站消息。 */
  async latest_delivery_for_session(session_id) {
    return (await this.call("state_latest_delivery_for_session", { sessionId: session_id })).delivery;
  }
  /** 清理旧轮次上下文。 */
  async prune_turn_context(session_id, keep = 20) {
    await this.call("state_prune_turn_context", { sessionId: session_id, keep });
  }
  /** 读取当前消费者租约。 */
  async get_lease() {
    return (await this.call("state_get_lease")).lease;
  }
  /** 原子获取消费者租约。 */
  async try_acquire_lease(input) {
    return (await this.call("state_try_acquire_lease", { input })).acquired === true;
  }
  /** 续租。 */
  async heartbeat_lease(owner_id) {
    return (await this.call("state_heartbeat_lease", { ownerId: owner_id })).updated === true;
  }
  /** 释放租约。 */
  async release_lease(owner_id) {
    await this.call("state_release_lease", { ownerId: owner_id });
  }
};

// backend/packages/webhook/webhook-weixin/src/runtime/weixinConnector.ts
var PROJECT_CONFIG_DIR = process.env.DSH_WEIXIN_WORKSPACE ?? process.cwd();
function port_open(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
var BACKOFF_STEPS = [1e3, 2e3, 5e3, 1e4, 2e4, 3e4];
var PROGRESS_MIN_INTERVAL_MS = Number(process.env.DSH_WEIXIN_PROGRESS_INTERVAL_MS ?? "25000");
var PROGRESS_MIN_CHARS = 12;
var BINDING_TTL_MS = Number(process.env.DSH_WEIXIN_BINDING_TTL_MS ?? String(30 * 6e4));
var AGENT_ERROR_GRACE_MS = Number(process.env.DSH_WEIXIN_AGENT_ERROR_GRACE_MS ?? "60000");
var INFLIGHT_RESCUE_MIN_AGE_MS = 5e3;
function account_fingerprint(token) {
  if (token === void 0 || token === "") return "unknown";
  return "acct-" + createHash2("sha256").update(token).digest("hex").slice(0, 12);
}
function read_json_file(path) {
  try {
    return JSON.parse(readFileSync10(path, "utf8"));
  } catch {
    return {};
  }
}
var WeixinConnector = class {
  /** 本地 SQLite 或远程 state API；远程模式下所有调用点必须等待可能的 Promise。 */
  store;
  /** 是否使用远程状态服务；用于选择同步兼容入口或真正等待的异步入口。 */
  remote_state;
  turn_context;
  ingress;
  inbound;
  outbound;
  host;
  lease;
  client;
  /** Codex 远程桥（`/codex` 指令）。 */
  codex_bridge;
  /** Codex 任务完成监视器：任务一结束就主动推微信。 */
  codex_watcher;
  /** opencode 远程桥（`/opencode` 指令）。 */
  opencode_bridge;
  /** opencode 完成监视器：只汇报外部发起的任务。 */
  opencode_watcher;
  controller = new AbortController();
  stream_disposers = /* @__PURE__ */ new Map();
  stream_agents = /* @__PURE__ */ new Map();
  observation_disposers;
  /** 每个 Stream 的工具调用计数（用于"每 N 次工具调用推一次摘要"）。 */
  tool_calls_seen = /* @__PURE__ */ new Map();
  /**
   * 每个 Session 当前所在的 turn。
   * 只有 `start` 帧带 `turn`；`chunk`/`end` 帧不带，因此必须记住最近一次的 turn，
   * 否则 turn context 会全部绑到 0（绑定/查询错位）。
   */
  current_turn = /* @__PURE__ */ new Map();
  /**
   * 待定的"这一轮失败了"收尾定时器（agent 报错后等宽限期，没有恢复就收尾）。
   * 没有它的话，模型持续报错时这一轮会永远停在"处理中"。
   */
  turn_failure_timers = /* @__PURE__ */ new Map();
  /** 当前在用的模型（故障转移会改它；初值来自配置）。 */
  current_model = { provider: "", model: "" };
  /** 模型健康表：失活的 API 在冷却期内不再被选。 */
  model_health = new ModelHealth();
  /** 每个会话最近一条用户消息（换模型后要重做它）。 */
  last_user_message = /* @__PURE__ */ new Map();
  /** 本轮是否报过错（用于"整轮失败却一个字都没发"时补一条说明）。 */
  turn_error = /* @__PURE__ */ new Map();
  /** 本轮有没有成功发出过正文。 */
  turn_visible = /* @__PURE__ */ new Set();
  /**
   * 正在压缩上下文的会话（`session_id`）。
   *
   * 压缩要读完整段历史（实测 1–3 分钟），这期间**不应该再往会话里塞新消息**：
   * 否则新消息会和压缩抢同一个会话、甚至被压缩吞掉。做法是期间的新消息只入库不投递
   * （`handle_batch(..., { hold: true })`），压缩结束后由恢复流程统一重投。
   */
  compacting_sessions = /* @__PURE__ */ new Set();
  /** 压缩期间已经回过"稍后回复"的会话（同一个压缩窗口只回一次，别刷屏）。 */
  compact_ack_sent = /* @__PURE__ */ new Set();
  /** 每个 Session 上次推送思考摘要的时间（进度节流）。 */
  last_progress_at = /* @__PURE__ */ new Map();
  aggregators = /* @__PURE__ */ new Map();
  running;
  stopped = false;
  /** 本机调试注入口（仅当设置 DSH_WEIXIN_INJECT_PORT 时启用）。 */
  inject_server;
  /** 长期记忆（时间线）；DSH_TIMELINE_ENABLED=0 可整体关闭。 */
  timeline;
  /** 知识图谱（社交网络）：人物 + "谁称呼谁为什么"的有向边。 */
  graph;
  /** 会话工作目录（会话落盘路径由它推导，必须与 HarnessSessionHost 一致）。 */
  workspace_path = process.cwd();
  /** 通知开关：codex / opencode 的完成汇报是否推送。 */
  notify;
  /** 摘要调度器（低频、纯本地检查；与 iLink 轮询无关）。 */
  timeline_scheduler;
  /** 知识图谱的空闲增量更新调度器。 */
  graph_scheduler;
  /**
   * 记忆更新的模型客户端：本地 Gemma 或云端模型（由 `DSH_MEMORY_ENGINE` 决定）。
   *
   * 本地免费但要占约 5.3GB 显存；云端不占显存但花额度。用户可在控制台切换。
   */
  memory;
  /**
   * 后台任务的闸门（摘要 / 图谱 / 图片描述共用）。
   *
   * 本地引擎：并发 1 + **等显存空闲再启动**（用户可能在跑游戏/训练）；
   * 云端引擎：不等显存（本来就不占），但同样限制并发，避免把额度打爆。
   */
  gemma;
  /** 组装全部组件；构造期不做 IO 失败判定。 */
  /** 宿主 ctx（故障转移要经它取 sessionController）。 */
  ctx;
  constructor(ctx, options) {
    this.ctx = ctx;
    this.observation_disposers = [
      ctx.on("session/event", (session, event) => {
        try {
          ObservationRecorder3.observe_event(String(session.id), event);
        } catch {
        }
      }),
      ctx.on("session/disposed", (session) => {
        ObservationRecorder3.forget_session(String(session.id));
      })
    ];
    const db_path = options.state_db ?? join13(join13(process.env.DSH_HOME ?? join13(process.env.USERPROFILE ?? ".", ".dsh")), "weixin-state.db");
    const remote_state = process.env.SYNLOVE_STATE_MODE === "remote";
    this.remote_state = remote_state;
    this.store = remote_state ? new StateRemoteClient() : new WeixinStateStore({ path: db_path });
    if (!remote_state) {
      const legacy_path = options.state_file ?? join13(process.env.DSH_WEIXIN_STATE_FILE ?? join13(process.cwd(), "runtime", "weixin-route-state.json"));
      const migration = migrate_legacy_route_state(this.store, legacy_path);
      probe("lifecycle", "migration.result", { ...migration });
    } else {
      probe("lifecycle", "state.remote", { base_url: process.env.SYNLOVE_STATE_BASE_URL ?? "default" });
    }
    this.turn_context = new TurnContextStore(this.store);
    const timeline_enabled = process.env.DSH_TIMELINE_ENABLED !== "0";
    const remote_timeline = process.env.SYNLOVE_MEMORY_TIMELINE_MODE === "remote";
    const remote_memory = remote_timeline ? new MemoryRemoteClient() : void 0;
    this.timeline = timeline_enabled ? remote_timeline ? remote_memory : new TimelineStore({
      dir: options.timeline_dir ?? process.env.DSH_TIMELINE_DIR ?? join13(process.env.DSH_HOME ?? join13(process.env.USERPROFILE ?? ".", ".dsh"), "timeline"),
      ...process.env.DSH_TIMELINE_TIMEZONE === void 0 ? {} : { timezone: process.env.DSH_TIMELINE_TIMEZONE }
    }) : void 0;
    this.graph = remote_memory ?? new KnowledgeGraphStore({
      dir: options.graph_dir ?? process.env.DSH_GRAPH_DIR ?? join13(process.env.DSH_HOME ?? join13(process.env.USERPROFILE ?? ".", ".dsh"), "graph")
    });
    if (this.timeline !== void 0) set_shared_memory({ timeline: this.timeline, graph: this.graph });
    try {
      const center_result = this.graph.ensure_center();
      if (center_result instanceof Promise) {
        void center_result.catch((error) => probe("graph", "center.failed", { error: String(error) }));
      }
      probe("graph", "center.ready", { remote: this.graph instanceof MemoryRemoteClient });
    } catch (error) {
      probe("graph", "center.failed", { error: String(error) });
    }
    this.notify = create_notify_settings(this.store);
    const engine = process.env.DSH_MEMORY_ENGINE === "cloud" ? "cloud" : "gemma";
    this.memory = create_memory_model({
      engine,
      ...process.env.DSH_MEMORY_CLOUD_MODEL === void 0 ? {} : { cloud_model: process.env.DSH_MEMORY_CLOUD_MODEL },
      // 同一个"路径要带 config/ 子目录"的坑：找不到就交给记忆模型自己回退到本地引擎
      config_path: find_model_config(PROJECT_CONFIG_DIR) ?? join13(PROJECT_CONFIG_DIR, "config", "modelConfig.json")
    });
    this.gemma = create_gemma_gate({
      // 只有本地引擎才需要等显存（云端不占显存，等了也没意义）
      min_free_vram_mb: engine === "gemma" && process.env.SYNLOVE_LLM_MANAGEMENT !== "external" ? Number(process.env.DSH_GEMMA_MIN_FREE_VRAM_MB ?? "5200") : 0,
      ...engine === "gemma" && process.env.SYNLOVE_LLM_MANAGEMENT !== "external" ? { ensure_ready: () => this.ensure_gemma_running() } : {}
    });
    probe("lifecycle", "memory_engine", { engine, label: this.memory.label });
    this.client = new IlinkClient(options);
    this.workspace_path = options.workspace_path ?? process.cwd();
    this.current_model = {
      provider: options.provider ?? "",
      model: options.model ?? ""
    };
    this.host = new HarnessSessionHost(ctx, {
      ...options.agent_preset === void 0 ? {} : { agent_preset: options.agent_preset },
      workspace_path: options.workspace_path ?? process.cwd(),
      ...options.provider === void 0 ? {} : { provider: options.provider },
      ...options.model === void 0 ? {} : { model: options.model },
      ...options.reasoning_effort === void 0 ? {} : { reasoning_effort: options.reasoning_effort }
    });
    this.lease = new ConsumerLease({
      store: this.store,
      // 租约身份**不要用 token 片段**：日志、探针、租约标记文件里都会写它，
      // 而这些文件就在项目内（随项目一起被拷走/备份）。用不可逆哈希，既能区分账号，
      // 又不泄漏 token 的任何字符。
      account_id: account_fingerprint(options.token),
      ...options.lease_marker === void 0 ? {} : { marker_path: options.lease_marker }
    });
    this.ingress = new WeixinIngress({
      client: this.client,
      observer: {
        on_error: (error) => probe("ingress", "observer.error", { error: String(error) }),
        on_status: (status, detail) => probe("ingress", "observer.status", { status, detail })
      }
    });
    this.outbound = new OutboundCoordinator({
      store: this.store,
      turn_context: this.turn_context,
      sender: async (input) => {
        if (!await this.lease.is_held()) throw new Error("\u5FAE\u4FE1\u6D88\u8D39\u8005\u6240\u6709\u6743\u5DF2\u4E22\u5931\uFF0C\u505C\u6B62\u53D1\u9001");
        await this.client.send_message_with_retry({
          to_user_id: input.user_id,
          text: input.text,
          client_id: input.client_id,
          ...input.context_token === void 0 ? {} : { context_token: input.context_token }
        });
      },
      record_entry: (entry) => this.record_timeline(entry),
      classify_retryable: (error) => {
        const retryable = error?.retryable;
        return retryable !== false;
      }
    });
    const attachments = ctx.get("attachments");
    this.codex_bridge = new CodexBridge(
      this.store,
      (user_id, session_id, text, kind, context_token) => {
        this.queue_notice({
          session_id,
          user_id,
          kind,
          text,
          ...context_token === void 0 ? {} : { context_token }
        });
        void this.outbound.drain();
      },
      options.codex_workspace ?? process.env.DSH_CODEX_WORKSPACE
    );
    this.opencode_bridge = new OpencodeBridge(
      this.store,
      (user_id, session_id, text, kind, context_token) => {
        this.queue_notice({
          session_id,
          user_id,
          kind,
          text,
          ...context_token === void 0 ? {} : { context_token }
        });
        void this.outbound.drain();
      }
    );
    this.opencode_watcher = new OpencodeWatcher({
      store: this.store,
      push: async (user_id, text) => {
        const enabled = this.notify.is_enabled_async === void 0 ? this.notify.is_enabled("opencode") : await this.notify.is_enabled_async("opencode");
        if (!enabled) {
          probe("opencode-watch", "notify.suppressed");
          return;
        }
        const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
        this.queue_notice({ session_id, user_id, kind: "assistant", text });
        await this.outbound.drain();
      }
    });
    this.codex_watcher = new CodexWatcher({
      store: this.store,
      push: async (user_id, text) => {
        const enabled = this.notify.is_enabled_async === void 0 ? this.notify.is_enabled("codex") : await this.notify.is_enabled_async("codex");
        if (!enabled) {
          probe("codex-watch", "notify.suppressed");
          return;
        }
        const session_id = await this.store.get_session_id(user_id) ?? `weixin-${user_id}`;
        this.queue_notice({ session_id, user_id, kind: "assistant", text });
        await this.outbound.drain();
      }
    });
    this.inbound = new InboundCoordinator({
      store: this.store,
      turn_context: this.turn_context,
      host: this.host,
      ...attachments === void 0 ? {} : { attachments },
      enqueue_outbound: (input) => {
        this.queue_notice(input);
      },
      // 媒体回传：iLink 目前只提供 send_image（图片），文件类走文本提示
      send_media: async (user_id, path, context_token) => {
        if (!await this.lease.is_held()) throw new Error("\u5FAE\u4FE1\u6D88\u8D39\u8005\u6240\u6709\u6743\u5DF2\u4E22\u5931\uFF0C\u505C\u6B62\u53D1\u9001\u5A92\u4F53");
        const { readFile } = await import("node:fs/promises");
        const data = new Uint8Array(await readFile(path));
        if (!await this.lease.is_held()) throw new Error("\u5FAE\u4FE1\u6D88\u8D39\u8005\u6240\u6709\u6743\u5DF2\u4E22\u5931\uFF0C\u505C\u6B62\u53D1\u9001\u5A92\u4F53");
        await this.client.send_image({
          to_user_id: user_id,
          data,
          ...context_token === void 0 ? {} : { context_token }
        });
        probe("outbound", "weixin.send_image", { user_id, bytes: data.byteLength });
      },
      on_agent_ready: (agent) => {
        this.bind_agent_stream(agent);
      },
      on_user_message: (session_id, user_id, text) => {
        this.remember_user_message(session_id, user_id, text);
      },
      // 用户说"停止"：除了取消模型那一轮，还要**真的把外部任务杀掉**
      // （桥里的任务 + 模型用工具起的 opencode/codex 进程）。
      on_cancel: async (user_id) => {
        this.opencode_bridge.stop(user_id);
        this.codex_bridge.stop(user_id);
        const result = kill_external_runs();
        probe("inbound", "cancel.external_runs", { user_id, killed: result.killed, pids: [...result.pids] });
        return { killed: result.killed, pids: result.pids };
      },
      // 取消后的收尾（abort 路径不会触发 agent/turn-stopping，必须在这里补：
      // 停心跳、清 inflight 标记、清聚合器，避免"还在处理中"和"取消的任务被复活"）。
      on_turn_cancelled: (session_id) => {
        void this.finalize_turn(session_id);
      },
      codex_bridge: {
        parse: (text) => parse_codex_command(text),
        handle: (user_id, session_id, command, context_token) => this.codex_bridge.handle(user_id, session_id, command, context_token)
      },
      opencode_bridge: {
        parse: (text) => parse_opencode_command(text),
        handle: (user_id, session_id, command, context_token) => this.opencode_bridge.handle(user_id, session_id, command, context_token)
      },
      // 媒体补全真正接上：不接的话图片/文件/语音只会变成 `[微信媒体 image]` 占位文字。
      // 顺带把媒体记进长期记忆（原图存附件库、只留引用；描述后台补写）。
      hydrate_message: async (message) => {
        const hydrated = await this.ingress.media_normalizer.hydrate_media(
          message,
          (media) => this.ingress.download_media(media)
        );
        await this.record_media_to_timeline(hydrated, attachments).catch((error) => {
          probe("timeline", "media.record_failed", { error: String(error) });
        });
        return hydrated;
      },
      // 长期记忆：用户上行落盘（幂等，重放不会重复记）。
      record_entry: (entry) => this.record_timeline(entry)
    });
    probe("lifecycle", "connector.constructed", {
      db_path,
      preset: options.agent_preset ?? "(default)",
      workspace: options.workspace_path
    });
  }
  /** 入队通知；远程状态模式等待 outbox 与 token 的异步提交。 */
  queue_notice(input) {
    if (this.remote_state) void this.outbound.enqueue_notice_async(input);
    else this.outbound.enqueue_notice(input);
  }
  /** 入队正式回复；远程状态模式等待轮次上下文和 outbox 提交。 */
  queue_assistant(input) {
    if (this.remote_state) void this.outbound.enqueue_assistant_async(input);
    else this.outbound.enqueue_assistant(input);
  }
  /** 入队思考进度；远程状态模式等待状态服务写入。 */
  queue_progress(session_id, text) {
    if (this.remote_state) void this.outbound.enqueue_progress_async(session_id, text);
    else this.outbound.enqueue_progress(session_id, text);
  }
  /**
   * 启动：preflight → 装配检查 → lease → 恢复 → 开轮询。
   * 任一步失败都抛出，让上层把"微信消费者未启动"如实暴露出来（禁止假成功）。
   */
  async start() {
    if (this.running !== void 0) return this.running;
    this.running = this.run();
    return this.running;
  }
  /** 真正的启动序列。 */
  async run() {
    if (process.env.DSH_WEIXIN_SKIP_OPENCLAW_CHECK !== "1") {
      const isolation = preflight_openclaw_isolation();
      if (!isolation.ok) {
        throw new Error(
          "webhook-weixin: OpenClaw \u9694\u79BB\u68C0\u67E5\u672A\u901A\u8FC7\uFF0C\u62D2\u7EDD\u542F\u52A8\uFF1A\n  - " + isolation.problems.join("\n  - ") + "\n\u8BF7\u5148\u505C\u7528 OpenClaw \u7684\u5FAE\u4FE1\u901A\u9053\uFF08openclaw-weixin.enabled=false\uFF09\u3002"
        );
      }
    }
    this.host.assert_capabilities();
    await this.reload_preset();
    await this.lease.acquire();
    const rescued = await this.rescue_interrupted_turns();
    const recovered = await this.inbound.recover_unfinished();
    const pending = await this.outbound.recover_pending();
    probe("lifecycle", "recover.summary", { ...recovered, outbox_pending: pending, rescued_turns: rescued });
    console.error(`[webhook-weixin] \u542F\u52A8\u6062\u590D\uFF1Adelivery=${recovered.recovered} outbox=${pending}${rescued > 0 ? `\uFF0C\u8865\u8DD1\u88AB\u6253\u65AD\u7684\u8F6E\u6B21=${rescued}` : ""}\uFF1B\u72B6\u6001\u5FEB\u7167 ${JSON.stringify(await this.store.snapshot())}`);
    this.codex_watcher.start();
    this.opencode_watcher.start();
    this.start_inject_server_if_configured();
    this.start_timeline_scheduler_if_enabled();
    try {
      await this.ingress.notify_start(this.controller.signal);
      await this.poll_loop();
    } finally {
      await this.ingress.notify_stop(this.controller.signal);
    }
  }
  /**
   * 启动本机注入口（开发设施，默认关闭）。
   *
   * 用途：把一条"用户消息"塞进真实入站管线（delivery → 协调器 → agent → outbox → 微信），
   * 这样测试时不必每次都用真手机发微信。只绑 127.0.0.1，且只有设置端口才启用。
   */
  start_inject_server_if_configured() {
    const port = Number(process.env.DSH_WEIXIN_INJECT_PORT ?? "0");
    if (!Number.isInteger(port) || port <= 0) return;
    this.inject_server = start_inject_server({
      port,
      inject: (input) => this.inject_test_message(input),
      admin: (action, body) => this.admin_action(action, body)
    });
  }
  /**
   * 管理动作分发（控制台按钮走这里）。
   *
   * 之所以由本进程执行而不是让控制台直接删文件：时间线/图谱有内存缓存、
   * 会话上下文还被 agent 句柄持有——只有持有者才知道该怎么正确清。
   */
  async admin_action(action, body) {
    const user_id = typeof body.user_id === "string" && body.user_id !== "" ? body.user_id : void 0;
    switch (action) {
      case "clear-context":
        return this.clear_context(user_id === void 0 ? {} : { user_id });
      case "clear-memory": {
        const target = String(body.target ?? "");
        if (target !== "timeline" && target !== "graph") {
          throw new Error(`clear-memory \u7684 target \u53EA\u80FD\u662F timeline \u6216 graph\uFF0C\u6536\u5230\uFF1A${target}`);
        }
        return await this.clear_memory(target);
      }
      case "memory-stats":
        return await this.memory_stats();
      case "clear-queue":
        return { removed: await this.store.clear_queue() };
      case "failover-status": {
        const path = find_model_config(PROJECT_CONFIG_DIR);
        const config = path === void 0 ? {} : read_json_file(path);
        return {
          current: this.current_model,
          order: parse_failover_config(config).order,
          dead: this.model_health.snapshot()
        };
      }
      case "reload-preset":
        return this.reload_preset();
      default:
        throw new Error(`\u672A\u77E5\u7684\u7BA1\u7406\u52A8\u4F5C\uFF1A${action}`);
    }
  }
  /**
   * 清空长期记忆。
   *
   * - `timeline`：删掉时间线目录内容，并清掉存储层的内存缓存（否则还会列出已删的天）；
   * - `graph`：删掉图谱目录内容 → **重建中心**（欣爱 + 主人，否则查询会说"图谱里没有人"）
   *   → 水位归零（让图谱从现有历史里重新长出来）。
   *
   * 与"清空上下文"是两件事：这里清的是"她长期记得什么"，上下文是"这次聊天记得什么"。
   */
  async clear_memory(target) {
    if (target === "timeline") {
      if (this.timeline === void 0) {
        return { target, files: 0, bytes: 0, dir: "", note: "\u65F6\u95F4\u7EBF\u8BB0\u5FC6\u672A\u542F\u7528\uFF08DSH_TIMELINE_ENABLED=0\uFF09" };
      }
      if (!(this.timeline instanceof TimelineStore)) {
        return { target, files: 0, bytes: 0, dir: "remote", note: "\u8FDC\u7A0B\u65F6\u95F4\u7EBF\u5FC5\u987B\u7531 memory \u670D\u52A1\u6267\u884C\u6E05\u7A7A\uFF1B\u672C\u5730\u63A7\u5236\u5668\u4E0D\u4F1A\u7ED5\u8FC7 API \u5220\u9664\u670D\u52A1\u7AEF\u6570\u636E" };
      }
      const removed2 = clear_directory_contents(this.timeline.dir_path());
      this.timeline.ensure_dirs();
      this.timeline.forget_caches();
      probe("memory", "timeline.cleared", { ...removed2 });
      return { target, ...removed2 };
    }
    if (!(this.graph instanceof KnowledgeGraphStore)) {
      return { target, files: 0, bytes: 0, dir: "remote", note: "\u8FDC\u7A0B\u56FE\u8C31\u5FC5\u987B\u7531 memory \u670D\u52A1\u6267\u884C\u6E05\u7A7A\uFF1B\u672C\u5730\u63A7\u5236\u5668\u4E0D\u4F1A\u7ED5\u8FC7 API \u5220\u9664\u670D\u52A1\u7AEF\u6570\u636E" };
    }
    const removed = clear_directory_contents(this.graph.dir_path());
    this.graph.ensure_center();
    this.graph.reset_watermark();
    probe("memory", "graph.cleared", { ...removed });
    return {
      target,
      ...removed,
      note: `\u5DF2\u91CD\u5EFA\u4E2D\u5FC3\uFF08\u6B23\u7231 \xB7 \u4E3B\u4EBA\uFF09\uFF0C\u5E76\u5F52\u96F6\u6C34\u4F4D\uFF1B\u4E0B\u6B21\u7A7A\u95F2\u65F6\u4F1A\u4ECE\u73B0\u6709\u5386\u53F2\u91CC\u91CD\u65B0\u79EF\u7D2F`
    };
  }
  /**
   * 三类记忆的体量（控制台展示用）。
   *
   * 上下文的体量按**落盘会话文件**算（用户 id → 会话 id → 会话目录），
   * 所以它显示的是真实占用，而不是一个估计值。
   */
  async memory_stats() {
    const stats = this.timeline === void 0 ? { error: "\u65F6\u95F4\u7EBF\u8BB0\u5FC6\u672A\u542F\u7528" } : this.timeline instanceof MemoryRemoteClient ? /* @__PURE__ */ (() => {
      return { error: "\u65F6\u95F4\u7EBF\u7531\u8FDC\u7A0B memory \u670D\u52A1\u6258\u7BA1\uFF1B\u76EE\u5F55\u5927\u5C0F\u7531\u670D\u52A1\u7AEF\u7EDF\u8BA1" };
    })() : (() => {
      const summary = this.timeline.stats();
      return {
        days: summary.days ?? 0,
        entries: summary.entries ?? 0,
        bytes: directory_bytes(this.timeline.dir_path()),
        dir: this.timeline.dir_path()
      };
    })();
    const graph_stats = this.graph instanceof MemoryRemoteClient ? { error: "\u56FE\u8C31\u7531\u8FDC\u7A0B memory \u670D\u52A1\u6258\u7BA1\uFF1B\u76EE\u5F55\u5927\u5C0F\u7531\u670D\u52A1\u7AEF\u7EDF\u8BA1" } : (() => {
      const summary = this.graph.stats();
      return {
        people: summary.people,
        relations: summary.relations,
        bytes: directory_bytes(this.graph.dir_path()),
        dir: this.graph.dir_path()
      };
    })();
    const root = sessions_root();
    const users = [];
    for (const user_id of await this.store.list_users()) {
      const route = await this.store.get_session_id(user_id);
      const session_id = route ?? await this.store.session_id_for(user_id);
      const log = session_log_stats(session_dir_path(root, this.workspace_path, session_id));
      users.push({
        user_id,
        session_id,
        epoch: await this.store.context_epoch(user_id),
        online: this.host.get_agent(brandString2(session_id)) !== void 0,
        bytes: log?.bytes ?? 0,
        modified_at: log?.modified_at ?? 0
      });
    }
    return {
      timeline: stats,
      graph: graph_stats,
      context: { users, bytes: users.reduce((sum, item) => sum + item.bytes, 0) }
    };
  }
  /**
   * 清空对话上下文（控制台「清空上下文」按钮调这里）。
   *
   * 四步，顺序不能换：
   * 1. **dispose agent**：只有 owner 释放才会关掉会话日志的写句柄。
   *    若跳过这步直接删文件，残留句柄下次 append 会写出"没有 header 的坏文件"——
   *    那个会话以后再也恢复不起来（这是实测踩过的坑）。
   * 2. 丢掉该会话的内存残留（stream/turn/聚合器）。
   * 3. **尽力删除旧会话文件**：回收磁盘；删不掉也不影响结果（见第 4 步）。
   * 4. **清路由 + 代次 +1**：下一条消息因此拿到一个新会话 id → 必然是空上下文。
   *
   * 长期记忆（时间线/图谱）**不动**：上下文是"这次聊天记得什么"，
   * 长期记忆是"她这个人记得什么"，两者是分开的，各有各的清空入口。
   */
  async clear_context(input) {
    const users = input.user_id === void 0 || input.user_id === "" ? await this.store.list_users() : [input.user_id];
    const epochs = {};
    const results = [];
    for (const user_id of users) {
      const session_id = await this.store.get_session_id(user_id) ?? await this.store.session_id_for(user_id);
      const disposed = await this.host.dispose_agent(session_id);
      this.forget_session(session_id);
      const deletion = delete_session_artifacts({
        root: sessions_root(),
        cwd: this.workspace_path,
        id: session_id
      });
      await this.store.clear_session_id(user_id);
      epochs[user_id] = await this.store.bump_context_epoch(user_id);
      results.push({
        user_id,
        session_id,
        disposed,
        deleted: deletion.deleted,
        ...deletion.reason === void 0 ? {} : { note: deletion.reason }
      });
      probe("lifecycle", "context.cleared", {
        user_id,
        session_id,
        disposed,
        deleted: deletion.deleted,
        epoch: epochs[user_id]
      });
    }
    return { users: results, epochs };
  }
  /**
   * 重新解析 preset（GUI 挂载/卸载工具后调用），并**真的验证一次**。
   *
   * 为什么要在本进程做：preset 组合是宿主实例记忆的，必须由持有它的进程重置。
   * 验证方式是用一个探针会话真创建一次 Agent —— preset 里挂了个缺依赖的插件时，
   * 失败会在这里暴露（而不是等到用户下一条消息才发现 bot 不回话了），
   * 验证完立刻释放并删掉探针会话文件，不留痕迹。
   */
  async reload_preset() {
    this.host.reset_composition();
    const probe_id = `preset-check-${Date.now().toString(36)}`;
    let failure = "";
    try {
      const agent = await this.host.create_agent(brandString2(probe_id));
      if (this.timeline !== void 0) {
        register_timeline_tools(agent.ctx, this.timeline);
        register_graph_tools(agent.ctx, this.graph);
      }
      this.bind_agent_stream(agent);
      this.bind_agent_stream(agent);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      this.forget_session(probe_id);
      await this.host.dispose_agent(probe_id);
      delete_session_artifacts({ root: sessions_root(), cwd: this.workspace_path, id: probe_id });
    }
    if (failure !== "") {
      probe("lifecycle", "preset.reload_failed", { error: failure });
      throw new Error(`preset \u7EC4\u88C5\u5931\u8D25\uFF0C\u5DF2\u56DE\u6EDA\uFF1A${failure}`);
    }
    probe("lifecycle", "preset.reloaded", {});
    return { reloaded: true, routing_checked: true };
  }
  /** 丢掉某个会话在内存里的残留状态（上下文已经清掉，这些映射不能再留着）。 */
  forget_session(session_id) {
    try {
      this.stream_disposers.get(session_id)?.();
    } catch (error) {
      probe("lifecycle", "context.dispose_failed", { session_id, error: String(error) });
    }
    this.stream_disposers.delete(session_id);
    this.stream_agents.delete(session_id);
    this.tool_calls_seen.delete(session_id);
    this.current_turn.delete(session_id);
    this.last_progress_at.delete(session_id);
    this.aggregators.delete(session_id);
  }
  /** 注入一条测试消息：复用真实入站管线，但不提交 iLink 游标（它本来就不是 iLink 来的）。 */
  async inject_test_message(input) {
    const user_id = input.user_id ?? await this.store.latest_user_id();
    if (user_id === void 0) {
      throw new Error("\u8FD8\u6CA1\u6709\u4EFB\u4F55\u5165\u7AD9\u7528\u6237\uFF0C\u65E0\u6CD5\u786E\u5B9A\u6536\u4EF6\u4EBA\uFF1B\u8BF7\u5148\u7528\u771F\u5B9E\u5FAE\u4FE1\u53D1\u4E00\u6761\u6D88\u606F");
    }
    const delivery_id = `inject-${Date.now()}-${randomBytes2(4).toString("hex")}`;
    probe("inbound", "inject.accepted", {
      delivery_id,
      user_id,
      text_len: input.text.length,
      text: input.text.slice(0, 120)
    });
    await this.handle_inbound([{
      delivery_id,
      user_id,
      text: input.text,
      media: [],
      received_at: Date.now()
    }], void 0);
    const route = await this.store.get_session_id(user_id);
    return {
      delivery_id,
      ...route === void 0 ? {} : { session_id: route }
    };
  }
  /**
   * 把消息里的媒体记进长期记忆。
   *
   * 分两步，且都**不阻塞**用户这条消息的处理：
   * 1. 解析出附件引用（原图由 harness 附件服务按内容寻址存好，天然去重），
   *    把引用挂到当天那条记录上——**不复制文件**，所以"存原图"几乎零成本；
   * 2. 后台让视觉模型（Gemma + mmproj）写一句描述，回填到引用上——
   *    描述让"发了什么图"变成可检索文本，并会随当天摘要一起被总结。
   *
   * 原图永远是权威：描述错了、模型不在线，都不影响原始事实已经存下来了。
   */
  async record_media_to_timeline(message, attachments) {
    if (this.timeline === void 0 || attachments === void 0) return;
    const images = message.media.filter((item) => item.kind === "image" && item.data !== void 0);
    if (images.length === 0) return;
    const date = this.timeline.day_key(message.received_at);
    const refs = [];
    for (const item of images) {
      try {
        const ref = await attachments.saveImage({
          data: item.data,
          mediaType: item.mime_type ?? "image/jpeg",
          ...item.name === void 0 ? {} : { name: item.name }
        });
        refs.push({
          id: String(ref.attachmentId),
          media_type: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...ref.name === void 0 ? {} : { name: ref.name }
        });
      } catch (error) {
        probe("timeline", "media.save_failed", { error: String(error) });
      }
    }
    if (refs.length === 0) return;
    await this.timeline.update_entry(date, message.delivery_id, { attachments: refs });
    probe("timeline", "media.recorded", { date, delivery_id: message.delivery_id, count: refs.length });
    for (const [index, item] of images.entries()) {
      const ref = refs[index];
      if (ref === void 0) continue;
      void this.describe_image(item, date, message.delivery_id, ref.id);
    }
  }
  /** 让视觉模型给一张图写一句描述并回填；全程 best-effort。 */
  async describe_image(media, date, entry_id, attachment_id) {
    if (this.timeline === void 0 || media.data === void 0) return;
    try {
      const text = await this.gemma.run("image-describe", () => this.memory.describe_image({
        data: media.data,
        media_type: media.mime_type ?? "image/jpeg"
      }));
      if (text.trim() === "") return;
      await this.timeline.update_attachment_description(date, entry_id, attachment_id, text.trim());
    } catch (error) {
      probe("timeline", "media.describe_failed", { attachment_id, error: String(error) });
    }
  }
  /** 写一条长期记忆；失败只留痕，绝不影响消息收发。 */
  async record_timeline(entry) {
    if (this.timeline === void 0) return;
    try {
      await this.timeline.append(entry);
    } catch (error) {
      probe("timeline", "append.failed", { id: entry.id, error: String(error) });
    }
  }
  /**
   * 启动时间线摘要调度（低频、纯本地）。
   *
   * 刻意与 iLink 轮询解耦：这里只读本地文件，不发任何微信请求；
   * 触发条件是"某日已空闲 ≥3 小时"，所以 5 分钟看一次足够，也不会给微信链路添压力。
   */
  start_timeline_scheduler_if_enabled() {
    if (this.timeline === void 0) return;
    const summarize = create_gemma_summarizer({
      complete: (prompt, max_tokens) => this.memory.complete(prompt, max_tokens)
    });
    this.timeline_scheduler = start_timeline_scheduler({
      store: this.timeline,
      summarizer: (request) => this.gemma.run("timeline-summary", () => summarize(request)),
      on_update: (dates) => probe("timeline", "summary.updated_days", { dates })
    });
    if (this.timeline instanceof TimelineStore && this.graph instanceof KnowledgeGraphStore || this.timeline instanceof MemoryRemoteClient && this.graph instanceof MemoryRemoteClient) {
      this.graph_scheduler = start_graph_scheduler({
        graph: this.graph,
        timeline: this.timeline,
        complete: (prompt) => this.gemma.run("graph-extract", () => this.memory.complete(prompt)),
        on_update: (result) => probe("graph", "updated", { ...result })
      });
    } else {
      probe("graph", "scheduler.deferred_mixed_memory_backend");
    }
  }
  /**
   * 确保本地 Gemma 服务在跑（运行期按需补拉）。
   *
   * 启动时如果显存被占用，启动器会跳过拉起；等显存空出来之后由这里补拉，
   * 路径/端口都从启动器注入的环境变量读取（**不在这里重新猜路径**，避免两处不一致）。
   */
  async ensure_gemma_running() {
    if (process.env.SYNLOVE_LLM_MANAGEMENT === "external") return;
    if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? "8080"))) return;
    const binary = process.env.GEMMA_SERVER_BIN;
    const model = process.env.GEMMA_MODEL_PATH;
    if (binary === void 0 || model === void 0) {
      throw new Error("\u4E0D\u77E5\u9053 Gemma \u600E\u4E48\u542F\u52A8\uFF08\u7F3A GEMMA_SERVER_BIN/GEMMA_MODEL_PATH\uFF09\uFF0C\u8BF7\u91CD\u542F\u4E00\u6B21\u94FE\u8DEF\u3002");
    }
    const args = [
      "-m",
      model,
      "--host",
      "127.0.0.1",
      "--port",
      process.env.GEMMA_SERVER_PORT ?? "8080",
      "-c",
      process.env.GEMMA_CONTEXT ?? "32768",
      "-ngl",
      "99",
      "--jinja",
      "--reasoning",
      "off",
      "-np",
      "1",
      "-fa",
      "on",
      "--alias",
      process.env.DSH_GEMMA_MODEL ?? "gemma-4-E4B-it-Q4_K_M",
      "--sleep-idle-seconds",
      process.env.DSH_GEMMA_SLEEP_IDLE_SECONDS ?? "120"
    ];
    if (process.env.GEMMA_MMPROJ_PATH !== void 0 && process.env.GEMMA_MMPROJ_PATH !== "") {
      args.push("--mmproj", process.env.GEMMA_MMPROJ_PATH);
    }
    probe("gemma", "server.start_on_demand", { binary, model });
    const child = spawn3(binary, args, { windowsHide: true, stdio: "ignore", detached: true });
    child.unref();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (await port_open(Number(process.env.GEMMA_SERVER_PORT ?? "8080"))) return;
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    throw new Error("Gemma \u670D\u52A1\u542F\u52A8\u540E\u4E00\u76F4\u6CA1\u5C31\u7EEA");
  }
  /** 轮询主循环：批次完成后才提交 cursor；错误按类别处理。 */
  async poll_loop() {
    let backoff_index = 0;
    let cursor_stall = 0;
    while (!this.controller.signal.aborted && !this.stopped) {
      if (!await this.lease.is_held()) {
        this.controller.abort();
        this.outbound.stop();
        await this.inbound.dispose();
        probe("lifecycle", "lease.lost_stop");
        return;
      }
      void this.outbound.drain();
      const cursor = await this.store.get_cursor();
      const result = await this.ingress.poll(cursor, this.controller.signal);
      if (!await this.lease.is_held()) continue;
      switch (result.kind) {
        case "messages": {
          backoff_index = 0;
          const committable = await this.handle_inbound(result.messages, result.cursor);
          if (committable && result.cursor !== void 0) {
            await this.store.set_cursor(result.cursor);
            cursor_stall = 0;
          } else if (!committable) {
            probe("inbound", "cursor.held", {
              reason: "\u6709 delivery \u672A\u8FBE\u7EC8\u6001\uFF0C\u7B49\u5F85\u91CD\u6295\u6216\u6062\u590D",
              delivery_ids: result.messages.map((m) => m.delivery_id),
              stall: cursor_stall + 1
            });
            cursor_stall += 1;
            await sleep(Math.min(5e3, 500 * cursor_stall), this.controller.signal);
          }
          await this.outbound.drain();
          break;
        }
        case "idle": {
          backoff_index = 0;
          if (result.cursor !== void 0) await this.store.set_cursor(result.cursor);
          await this.outbound.drain();
          break;
        }
        case "session_timeout": {
          probe("ingress", "session_timeout.recover");
          await this.ingress.notify_start(this.controller.signal).catch((error) => {
            probe("ingress", "session_timeout.notify_failed", { error: String(error) });
          });
          break;
        }
        case "auth_required": {
          probe("lifecycle", "auth_required", { detail: result.detail });
          this.write_auth_marker(result.detail);
          this.stopped = true;
          return;
        }
        case "protocol_error": {
          const wait = BACKOFF_STEPS[Math.min(backoff_index, BACKOFF_STEPS.length - 1)];
          backoff_index += 1;
          probe("ingress", "backoff", { wait_ms: wait, attempt: backoff_index, detail: result.detail });
          await sleep(wait, this.controller.signal);
          break;
        }
      }
    }
  }
  /** 写认证失效标记，供启动器提示扫码。 */
  write_auth_marker(detail) {
    const marker = process.env.DSH_WEIXIN_TOKEN_MARKER ?? join13(process.env.DSH_HOME ?? join13(process.env.USERPROFILE ?? ".", ".dsh"), "weixin-token-invalid.flag");
    void import("node:fs/promises").then((fs) => fs.writeFile(marker, `${(/* @__PURE__ */ new Date()).toISOString()} ${detail}
`, "utf8")).catch(() => void 0);
    console.error("[webhook-weixin] \u8BA4\u8BC1\u5931\u6548\uFF0C\u5DF2\u505C\u6B62\u6D88\u8D39\uFF1B\u8BF7\u8FD0\u884C weixin_login.py \u91CD\u65B0\u626B\u7801\u3002\u6807\u8BB0\uFF1A" + marker);
  }
  /** 桥接 assistant-stream：聚合成正文、按 turn 绑定上下文、驱动进度/心跳。 */
  bind_agent_stream(agent) {
    const session_id = String(agent.id);
    if (this.stream_agents.get(session_id) === agent) return;
    this.stream_disposers.get(session_id)?.();
    if (this.timeline !== void 0) {
      agent.ctx.effect(() => {
        register_timeline_tools(agent.ctx, this.timeline);
        register_graph_tools(agent.ctx, this.graph);
        register_notify_tools(agent.ctx, this.notify);
        register_bridge_result_tools(agent.ctx, this.store);
        register_bridge_session_tools(agent.ctx);
        return () => {
        };
      }, "webhook-weixin.memory-tools()");
    }
    const dispose = agent.ctx.on("agent/assistant-stream", ({ agent: subject, frame }) => {
      if (subject !== agent) return;
      if (frame.type === "chunk") this.handle_chunk(session_id, frame);
    });
    const dispose_pre_step = agent.ctx.on(
      "agent/pre-step",
      async ({ agent: subject, turn, step }, next) => {
        if (subject === agent && (step === 1 || this.current_turn.get(session_id) !== turn)) {
          await this.begin_turn_once(session_id, turn);
        }
        return next();
      }
    );
    const dispose_turn_stopping = agent.ctx.on(
      "agent/turn-stopping",
      ({ agent: subject, turn }) => {
        if (subject !== agent) return;
        void this.handle_turn_end(session_id, turn);
      }
    );
    const dispose_error = agent.ctx.on("agent/error", ({ error }) => {
      const detail = error instanceof Error ? error.message : String(error);
      probe("inbound", "agent.error", { session_id, error: detail });
      console.error(`[webhook-weixin] agent error session=${session_id}: ${detail}`);
      this.turn_error.set(session_id, detail);
      this.arm_turn_failure(session_id, detail);
      const reason = classify_llm_failure(detail);
      if (reason !== void 0) void this.failover_model(session_id, detail, reason);
    });
    const dispose_compaction = agent.ctx.on(
      "session/event",
      (session, event) => {
        if (session !== agent.session) return;
        if (event.type === "compaction/start") {
          this.compacting_sessions.add(session_id);
          probe("lifecycle", "compaction.suspend_inbound", { session_id });
          return;
        }
        if (event.type !== "compaction/end") return;
        this.compacting_sessions.delete(session_id);
        this.compact_ack_sent.delete(session_id);
        probe("lifecycle", "compaction.resume_inbound", { session_id });
        void this.inbound.recover_unfinished().then((result) => {
          if (result.recovered > 0) {
            probe("lifecycle", "compaction.requeued", { session_id, recovered: result.recovered });
            void this.outbound.drain();
          }
        }).catch((error) => {
          probe("lifecycle", "compaction.requeue_failed", { session_id, error: String(error) });
        });
      }
    );
    this.stream_disposers.set(session_id, () => {
      dispose();
      dispose_error();
      dispose_pre_step();
      dispose_turn_stopping();
      dispose_compaction();
      ObservationRecorder3.forget_session(session_id);
    });
    this.stream_agents.set(session_id, agent);
    probe("lifecycle", "stream.bound", { session_id });
  }
  /**
   * 补跑"被重启打断的轮次"。
   *
   * 做法：启动时扫描 `inflight_turn:*` 残留标记（轮次开始写、结束删），把对应 delivery
   * 从 injected 退回 received —— 随后 `inbound.recover_unfinished()` 会把它重新注入，
   * 用户就能拿到这一轮的回复，而不是被静默丢掉。
   *
   * @returns 补跑的轮次数
   */
  async rescue_interrupted_turns() {
    let rescued = 0;
    for (const item of await this.store.list_meta_prefix(INFLIGHT_TURN_PREFIX)) {
      const session_id = item.key.slice(INFLIGHT_TURN_PREFIX.length);
      let detail = {};
      try {
        detail = JSON.parse(item.value);
      } catch {
      }
      await this.store.delete_meta(item.key);
      if (typeof detail.delivery_id !== "string") continue;
      if (typeof detail.at === "number" && Date.now() - detail.at < INFLIGHT_RESCUE_MIN_AGE_MS) continue;
      const record = await this.store.get_delivery(detail.delivery_id);
      if (record === void 0 || record.status === "failed_terminal") continue;
      try {
        await this.store.update_delivery(detail.delivery_id, "received", { last_error: "\u91CD\u542F\u6253\u65AD\u4E86\u8FD9\u4E00\u8F6E\uFF0C\u81EA\u52A8\u91CD\u6295" });
        rescued += 1;
        probe("inbound", "turn.rescued", { session_id, turn: detail.turn, delivery_id: detail.delivery_id });
        this.queue_notice({
          session_id,
          user_id: record.user_id,
          kind: "assistant",
          text: "\u521A\u624D\u90A3\u8F6E\u88AB\u91CD\u542F\u6253\u65AD\u4E86\uFF0C\u6211\u91CD\u8DD1\u4E00\u904D\u3002"
        });
      } catch (error) {
        probe("inbound", "turn.rescue_failed", {
          session_id,
          delivery_id: detail.delivery_id,
          error: String(error)
        });
      }
    }
    if (rescued > 0) console.error(`[webhook-weixin] \u8865\u8DD1\u88AB\u6253\u65AD\u7684\u8F6E\u6B21\uFF1A${rescued} \u6761`);
    return rescued;
  }
  /**
   * 入站批次的统一入口（轮询与调试注入口都走这里）。
   *
   * **压缩上下文期间不收新消息**：只入库（payload 已落库）+ 回一句"稍后回复"，
   * 游标故意不提交；压缩结束后 `recover_unfinished()` 会把它们重投。
   * 这样新消息既不会打断/污染压缩，也不会丢。
   *
   * @param messages - 本批入站消息
   * @param cursor - 平台游标（注入口没有）
   * @returns 是否允许提交该批次 cursor
   */
  async handle_inbound(messages, cursor) {
    const compacting = [];
    for (const item of messages) {
      const session = await this.store.session_id_for(item.user_id);
      if (this.compacting_sessions.has(session)) compacting.push(item);
    }
    if (compacting.length > 0) {
      for (const item of compacting) await this.notify_compacting(item.user_id);
      await this.inbound.handle_batch(messages, cursor, { hold: true });
      probe("inbound", "batch.held_for_compaction", { count: messages.length });
      await this.outbound.drain();
      return false;
    }
    return this.inbound.handle_batch(messages, cursor);
  }
  /**
   * 压缩上下文期间收到消息：回一句"正在压缩上下文，稍后回复"（同一个窗口只回一次）。
   * 消息本身已经入库，压缩结束后会补处理。
   */
  async notify_compacting(user_id) {
    const key = await this.store.session_id_for(user_id);
    if (this.compact_ack_sent.has(key)) return;
    this.compact_ack_sent.add(key);
    probe("outbound", "compaction_ack", { user_id, session_id: key });
    this.queue_notice({
      session_id: key,
      user_id,
      kind: "assistant",
      text: "\uFF08\u6B63\u5728\u538B\u7F29\u4E0A\u4E0B\u6587\uFF0C\u7A0D\u540E\u56DE\u590D\uFF1B\u4F60\u8FD9\u6761\u5DF2\u7ECF\u6392\u4E0A\u961F\u4E86\uFF09"
    });
  }
  /**
   * 取消后的收尾（幂等）。
   *
   * `agent.cancel()` 走 abort 路径时**不会**触发 `agent/turn-stopping`（实测），
   * 所以这里把 handle_turn_end 里那些"必须做"的清理补上：
   * 停心跳（否则每 5 分钟继续发「还在处理中」）、删 inflight 标记（否则下次启动会重跑已取消的任务）、
   * 清错误/可见性/聚合器/当前轮次状态。
   */
  async finalize_turn(session_id) {
    const turn = this.current_turn.get(session_id);
    this.outbound.end_turn(session_id);
    await this.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
    this.turn_error.delete(session_id);
    this.turn_visible.delete(session_id);
    this.clear_turn_failure(session_id);
    this.aggregators.delete(session_id);
    this.tool_calls_seen.delete(session_id);
    this.current_turn.delete(session_id);
    probe("lifecycle", "turn.finalized_after_cancel", { session_id, turn });
  }
  /**
   * 一轮开始：**只在首次进入该 turn 时**绑定回复上下文并启动进度追踪。
   *
   * 关键约束（修复"同一 turn 上下文被后续消息覆盖"）：
   * 已经绑定过的 turn 绝不重绑——长任务期间用户再发消息时，
   * 那条新消息属于下一个 turn，不能改写本轮回复该用的 context_token。
   */
  async begin_turn_once(session_id, turn) {
    const already = await this.turn_context.resolve_async(session_id, turn);
    this.current_turn.set(session_id, turn);
    this.aggregators.set(session_id, new ReplyAggregator());
    this.tool_calls_seen.set(session_id, /* @__PURE__ */ new Set());
    this.outbound.begin_turn(session_id, turn);
    if (already !== void 0 && await this.binding_is_fresh(already.delivery_id)) {
      probe("outbound", "turn.start_reuse", { session_id, turn, delivery_id: already.delivery_id });
      await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
        turn,
        delivery_id: already.delivery_id,
        at: Date.now()
      }));
      return;
    }
    if (already !== void 0) {
      probe("outbound", "turn.rebind_stale", { session_id, turn, delivery_id: already.delivery_id });
    }
    const latest = await this.store.latest_delivery_for_session(session_id);
    if (latest !== void 0) {
      const delivery = await this.store.get_delivery(latest.delivery_id);
      const context_token = await this.store.delivery_context_token(latest.delivery_id);
      await this.turn_context.bind_async(session_id, turn, {
        delivery_id: latest.delivery_id,
        user_id: delivery?.user_id ?? latest.user_id,
        ...context_token === void 0 ? {} : { context_token }
      });
    }
    const context = await this.turn_context.resolve_async(session_id, turn);
    probe("outbound", "turn.start", {
      session_id,
      turn,
      delivery_id: context?.delivery_id,
      has_token: context?.context_token !== void 0
    });
    await this.store.set_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`, JSON.stringify({
      turn,
      delivery_id: context?.delivery_id,
      at: Date.now()
    }));
  }
  /**
   * 该 turn 绑定是否仍然新鲜。
   * 超过 TTL 就视为"重启前的旧绑定"：turn 号会重复，但 context_token 可能已失效。
   */
  async binding_is_fresh(delivery_id) {
    const record = await this.store.get_delivery(delivery_id);
    if (record === void 0) return false;
    return Date.now() - record.received_at < BINDING_TTL_MS;
  }
  /**
   * 自动换模型：把失活的 API 拉黑，切到下一个可用的，并把用户刚才那条消息重做一遍。
   *
   * 全过程不重启、不丢上下文（`sessionController.selectModel` 装到下一个请求上），
   * 并同步写回 `modelConfig.json` 的默认模型——否则控制台显示的、以及下次启动器同步出去的
   * 还是那个已经挂掉的模型，等于白换。
   */
  async failover_model(session_id, detail, reason) {
    try {
      const config_path = find_model_config(PROJECT_CONFIG_DIR);
      if (config_path === void 0) {
        probe("failover", "config_missing", { workspace: PROJECT_CONFIG_DIR });
        return;
      }
      const config = read_json_file(config_path);
      const failover = parse_failover_config(config);
      if (!failover.enabled) return;
      const current = this.current_model;
      const dead = this.model_health.mark_dead(current, reason, detail, cooldown_ms(reason, failover));
      probe("failover", "model.dead", {
        provider: current.provider,
        model: current.model,
        reason,
        until: dead.until,
        detail: detail.slice(0, 120)
      });
      const next = next_alive_candidate(failover.order, current, (candidate) => this.model_health.is_dead(candidate));
      if (next === void 0) {
        probe("failover", "no_candidate", { tried: current });
        const user_id2 = await this.store.latest_user_id();
        if (user_id2 !== void 0) {
          const session_key = await this.store.get_session_id(user_id2) ?? session_id;
          this.queue_notice({
            session_id: session_key,
            user_id: user_id2,
            kind: "assistant",
            text: `\u914D\u7F6E\u91CC\u7684\u6A21\u578B\u63A5\u53E3\u90FD\u4E0D\u53EF\u7528\u4E86\uFF08${current.model}\uFF1A${detail.slice(0, 80)}\uFF09\u3002\u6362\u4E2A key \u6216\u7B49\u989D\u5EA6\u6062\u590D\u540E\u6211\u518D\u8BD5\uFF1B\u4E5F\u53EF\u4EE5\u8BA9\u6211\u7528\u522B\u7684\u6A21\u578B\u3002`
          });
          await this.outbound.drain();
        }
        return;
      }
      const controller = this.ctx.get("sessionController");
      if (controller?.selectModel === void 0) {
        probe("failover", "controller_missing", {});
        return;
      }
      await controller.selectModel({
        sessionId: brandString2(session_id),
        provider: next.provider,
        model: next.model
      });
      this.current_model = { provider: next.provider, model: next.model };
      this.persist_default_model(config_path, config, next);
      probe("failover", "model.switched", {
        from: `${current.provider}/${current.model}`,
        to: `${next.provider}/${next.model}`,
        reason
      });
      const user_id = await this.store.latest_user_id();
      if (user_id !== void 0) {
        const session_key = await this.store.get_session_id(user_id) ?? session_id;
        this.queue_notice({
          session_id: session_key,
          user_id,
          kind: "assistant",
          text: `\u300C${current.model}\u300D\u8FD9\u4E2A\u63A5\u53E3\u7528\u4E0D\u4E86\u4E86\uFF08${reason === "quota" ? "\u989D\u5EA6\u7528\u5B8C" : reason === "auth" ? "key \u5931\u6548" : "\u6A21\u578B\u4E0B\u7EBF"}\uFF09\uFF0C\u6211\u5148\u6362\u6210\u300C${next.model}\u300D\uFF0C\u628A\u4F60\u521A\u624D\u90A3\u6761\u91CD\u505A\u4E00\u904D\u3002`
        });
        await this.outbound.drain();
        await this.retry_last_message(session_id, user_id);
      }
    } catch (error) {
      probe("failover", "failed", { error: String(error).slice(0, 200) });
    }
  }
  /** 把新的默认模型写回 modelConfig.json（含备份）。 */
  persist_default_model(config_path, config, next) {
    try {
      const parsed = config;
      parsed.defaultModel = { provider: next.provider, model: next.model };
      parsed.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
      copyFileSync2(config_path, `${config_path}.bak-failover`);
      writeFileSync5(config_path, `${JSON.stringify(parsed, null, 2)}
`, "utf8");
    } catch (error) {
      probe("failover", "persist_failed", { error: String(error).slice(0, 160) });
    }
  }
  /** 记住最近一条用户消息（换模型后要重做它）。 */
  remember_user_message(session_id, user_id, text) {
    this.last_user_message.set(session_id, { user_id, text, at: Date.now(), retried: false });
  }
  /**
   * 重做最近一条用户消息（每个会话只自动重做一次，避免连环重试）。
   *
   * 走的是**真实入站管线**（和用户自己发一样），所以工具、记忆、回复都一样；
   * 只是 delivery id 用 `retry-` 前缀，便于在探针里区分。
   */
  async retry_last_message(session_id, user_id) {
    const remembered = this.last_user_message.get(session_id);
    if (remembered === void 0 || remembered.text.trim() === "") return;
    if (remembered.retried) {
      probe("failover", "retry.skipped_already", { session_id });
      return;
    }
    remembered.retried = true;
    const delivery_id = `retry-${Date.now()}-${randomBytes2(3).toString("hex")}`;
    probe("failover", "retry.start", { session_id, delivery_id, chars: remembered.text.length });
    try {
      await this.handle_inbound([{
        delivery_id,
        user_id,
        text: remembered.text,
        media: [],
        received_at: Date.now()
      }], void 0);
    } catch (error) {
      probe("failover", "retry.failed", { session_id, error: String(error).slice(0, 160) });
    }
  }
  /**
   * 记一次 agent 错误，并在宽限期后把这一轮按失败收尾。
   *
   * 为什么必须做：模型接口持续报错（例如 429「api key 日限额已用完」）时，agent loop
   * 会一直重试/卡住，`agent/turn-stopping` 永远不来——用户那边只看到每 5 分钟一条
   * "还在处理中"，永远等不到结果（2026-09-21 23:46 那轮实测卡了 10 分钟以上）。
   * 宽限期内只要有任何新分片就取消收尾（说明重试成功了，别抢话）。
   */
  arm_turn_failure(session_id, detail) {
    const existing = this.turn_failure_timers.get(session_id);
    if (existing !== void 0) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.turn_failure_timers.delete(session_id);
      void this.fail_turn(session_id, detail);
    }, AGENT_ERROR_GRACE_MS);
    this.turn_failure_timers.set(session_id, timer);
  }
  /** 有活动就取消待定的失败收尾。 */
  clear_turn_failure(session_id) {
    const timer = this.turn_failure_timers.get(session_id);
    if (timer !== void 0) {
      clearTimeout(timer);
      this.turn_failure_timers.delete(session_id);
    }
  }
  /**
   * 把模型接口的报错翻成"人话 + 该怎么办"。
   *
   * 为什么必须分类：以前**所有**失败都写"多半是额度/限额用完或 key 失效"，而实测
   * 最常见的其实是传输层失败（OpenAI SDK 的 `APIConnectionError`，消息就是
   * "Connection error."——接口那一小段时间连不上/连接被断开），跟额度完全无关。
   * 说错原因会让用户白等额度、或者去换根本不坏的 key。
   */
  explain_llm_failure(detail) {
    const text = detail.toLowerCase();
    if (/connection error|fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|transport|proxy/.test(text)) {
      return "\u8FD9\u662F**\u7F51\u7EDC/\u63A5\u53E3\u8FDE\u63A5**\u95EE\u9898\uFF08\u4E0D\u662F\u989D\u5EA6\uFF09\uFF1A\u63A5\u53E3\u90A3\u8FB9\u8FD9\u4E00\u5C0F\u4F1A\u513F\u6CA1\u8FDE\u4E0A\u6216\u628A\u8FDE\u63A5\u65AD\u4E86\u3002\u8BA9\u6211\u91CD\u8BD5\u4E00\u822C\u5C31\u6062\u590D\u3002";
    }
    if (/quota|insufficient|余额|欠费|限额|额度/.test(text)) {
      return "\u8FD9\u662F**\u989D\u5EA6/\u9650\u989D**\u95EE\u9898\uFF1A\u7B49\u989D\u5EA6\u6062\u590D\uFF0C\u6216\u5728\u63A7\u5236\u53F0\u300C\u6A21\u578B\u9009\u62E9\u300D\u6362\u4E00\u4E2A\u6A21\u578B\u3002";
    }
    if (/401|403|unauthor|invalid.*key|api.?key|鉴权|auth/.test(text)) {
      return "\u8FD9\u662F**\u9274\u6743**\u5931\u8D25\uFF08key \u5931\u6548\u6216\u6CA1\u6743\u9650\uFF09\uFF1A\u9700\u8981\u6362 key\uFF0C\u6216\u6362\u4E00\u4E2A\u6A21\u578B\u3002";
    }
    if (/429|rate.?limit|too many|限流/.test(text)) {
      return "\u8FD9\u662F\u88AB**\u9650\u6D41**\u4E86\uFF1A\u7A0D\u7B49\u4E00\u4E0B\u5C31\u597D\uFF0C\u6211\u53EF\u4EE5\u518D\u8BD5\u4E00\u6B21\u3002";
    }
    return "\u53EF\u4EE5\u8BA9\u6211\u518D\u8BD5\u4E00\u6B21\uFF1B\u5982\u679C\u53CD\u590D\u51FA\u73B0\uFF0C\u5C31\u5728\u63A7\u5236\u53F0\u300C\u6A21\u578B\u9009\u62E9\u300D\u6362\u4E00\u4E2A\u6A21\u578B\u3002";
  }
  /**
   * 把卡住的一轮按失败收尾：**如实说明原因**，并把这一轮关掉。
   *
   * 宁可说"没做成 + 为什么"，也不要让用户对着"还在处理中"干等——
   * 这也是人格里"工具失败就直接说失败和可确认的原因"的要求。
   */
  async fail_turn(session_id, detail) {
    const turn = this.current_turn.get(session_id);
    if (turn === void 0) return;
    const user_id = (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? "";
    probe("inbound", "turn.failed", { session_id, turn, detail });
    this.turn_error.delete(session_id);
    this.queue_assistant({
      session_id,
      user_id,
      turn,
      text: `\u6211\u8FD9\u8F6E\u6CA1\u505A\u6210\uFF1A\u6A21\u578B\u63A5\u53E3\u62A5\u9519\u300C${detail.slice(0, 140)}\u300D\u3002
${this.explain_llm_failure(detail)}`
    });
    await this.handle_turn_end(session_id, turn);
  }
  /** 一轮结束：补发尾段、清理状态。 */
  async handle_turn_end(session_id, turn) {
    this.clear_turn_failure(session_id);
    await this.store.delete_meta(`${INFLIGHT_TURN_PREFIX}${session_id}`);
    const error = this.turn_error.get(session_id);
    const visible = this.turn_visible.has(session_id);
    this.turn_error.delete(session_id);
    this.turn_visible.delete(session_id);
    if (error !== void 0 && !visible) {
      probe("outbound", "turn.failed_notice", { session_id, turn });
      this.queue_notice({
        session_id,
        user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? "",
        kind: "assistant",
        text: `\u6211\u8FD9\u8F6E\u6CA1\u505A\u6210\uFF1A\u6A21\u578B\u63A5\u53E3\u62A5\u9519\u300C${error.slice(0, 120)}\u300D\u3002
${this.explain_llm_failure(error)}`
      });
    }
    const aggregator = this.aggregators.get(session_id);
    this.aggregators.delete(session_id);
    if (aggregator !== void 0) {
      const tail = aggregator.finish();
      if (tail) {
        this.queue_assistant({
          session_id,
          user_id: (await this.turn_context.resolve_async(session_id, turn))?.user_id ?? "",
          turn,
          text: tail
        });
      }
    }
    this.outbound.end_turn(session_id);
    this.tool_calls_seen.delete(session_id);
    this.current_turn.delete(session_id);
    this.last_progress_at.delete(session_id);
    await this.turn_context.prune_async(session_id);
    await this.outbound.drain();
    probe("outbound", "turn.done", { session_id, turn });
  }
  /** 处理流分片：正文聚合发送、思考摘要作为进度（即心跳）。 */
  handle_chunk(session_id, frame) {
    if (frame.type !== "chunk") return;
    this.clear_turn_failure(session_id);
    const chunk = frame.chunk;
    if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
      const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
      this.aggregators.set(session_id, aggregator);
      const turn = this.current_turn.get(session_id) ?? 0;
      for (const segment of aggregator.accept_chunk(chunk.text)) {
        this.outbound.note_visible(session_id);
        this.turn_visible.add(session_id);
        this.queue_assistant({ session_id, user_id: "", turn, text: segment });
      }
      this.outbound.note_visible(session_id);
      void this.outbound.drain();
      return;
    }
    if (chunk?.type === "reasoning-delta" && typeof chunk.text === "string") {
      const aggregator = this.aggregators.get(session_id) ?? new ReplyAggregator();
      this.aggregators.set(session_id, aggregator);
      aggregator.accept_reasoning(chunk.text);
      this.maybe_push_progress(session_id, aggregator);
      return;
    }
    if (chunk?.type === "tool-call-delta" && typeof chunk.name === "string" && chunk.name.length > 0) {
      const seen = this.tool_calls_seen.get(session_id) ?? /* @__PURE__ */ new Set();
      const call_id = typeof chunk.id === "string" && chunk.id.length > 0 ? chunk.id : `${chunk.name}:${seen.size}`;
      if (seen.has(call_id)) return;
      seen.add(call_id);
      this.tool_calls_seen.set(session_id, seen);
    }
  }
  /**
   * 按时间推送思考摘要（即进度，也是心跳）。
   *
   * 触发条件：距上次推送 ≥ PROGRESS_MIN_INTERVAL_MS，且有足够长度的新摘要。
   * 不再依赖工具调用次数——否则"只调一次工具"的任务全程无进度。
   */
  maybe_push_progress(session_id, aggregator) {
    if (PROGRESS_MIN_INTERVAL_MS <= 0) return;
    const now = Date.now();
    const last = this.last_progress_at.get(session_id) ?? 0;
    if (now - last < PROGRESS_MIN_INTERVAL_MS) return;
    const excerpt = aggregator.take_reasoning_excerpt(120);
    if (excerpt === void 0 || excerpt.length < PROGRESS_MIN_CHARS) return;
    const cjk = (excerpt.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (cjk < PROGRESS_MIN_CHARS) return;
    this.last_progress_at.set(session_id, now);
    this.queue_progress(session_id, `\uFF08\u8FDB\u5EA6\xB7\u6B23\u7231\u5728\u60F3\uFF09${excerpt}`);
    probe("outbound", "progress.pushed", { session_id, chars: excerpt.length });
    void this.outbound.drain();
  }
  /** 停止：幂等；释放监听、租约与 Agent。 */
  async stop() {
    if (this.stopped && this.running === void 0) return;
    this.stopped = true;
    this.controller.abort();
    await this.running?.catch(() => void 0);
    this.codex_watcher.stop();
    this.opencode_watcher.stop();
    this.outbound.stop();
    if (this.inject_server !== void 0) {
      this.inject_server.close();
      this.inject_server = void 0;
    }
    this.timeline_scheduler?.stop();
    this.timeline_scheduler = void 0;
    try {
      if (this.timeline instanceof TimelineStore) this.timeline.flush_views();
    } catch (error) {
      probe("timeline", "flush.failed", { error: String(error) });
    }
    this.graph_scheduler?.stop();
    this.graph_scheduler = void 0;
    for (const dispose of this.stream_disposers.values()) dispose();
    this.stream_disposers.clear();
    this.stream_agents.clear();
    await this.inbound.dispose();
    this.aggregators.clear();
    this.tool_calls_seen.clear();
    await this.outbound.drain().catch(() => void 0);
    await this.host.dispose_agents();
    for (const dispose of this.observation_disposers) dispose();
    await this.lease.release();
    this.store.close();
    probe("lifecycle", "connector.stopped");
  }
};
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
function install_weixin_connector(ctx, options) {
  const connector = new WeixinConnector(ctx, options);
  ctx.effect(async () => {
    const done = probe_timer("lifecycle", "connector.start");
    try {
      await connector.start();
      done({ outcome: "ok" });
    } catch (error) {
      probe("lifecycle", "connector.start_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      console.error("[webhook-weixin] \u8FDE\u63A5\u5668\u542F\u52A8\u5931\u8D25\uFF1A" + (error instanceof Error ? error.stack ?? error.message : String(error)));
      throw error;
    }
    return () => connector.stop();
  }, "webhook-weixin.lifecycle()");
  return connector;
}

// backend/packages/webhook/webhook-weixin/src/plugin.ts
import z from "@deepseek-ai/schemastery";
var name = "webhook-weixin";
var inject = ["agents", "agentPresets", "sessionPersistence"];
var Config = z.object({
  base_url: z.string().required(),
  token: z.string().role("secret").required(),
  cdn_base_url: z.string(),
  state_file: z.string(),
  workspace_path: z.string().required(),
  provider: z.string().required(),
  model: z.string().required(),
  reasoning_effort: z.string(),
  agent_preset: z.string(),
  send_retry_count: z.number(),
  send_retry_delay_ms: z.number(),
  state_db: z.string(),
  lease_marker: z.string()
});
function apply(ctx, config) {
  if (!config.base_url.startsWith("http")) throw new Error("webhook-weixin base_url must be an HTTP URL");
  if (!config.token.trim()) throw new Error("webhook-weixin token must be non-empty");
  probe("lifecycle", "plugin.apply", {
    base_url: config.base_url,
    preset: config.agent_preset ?? "(default)",
    provider: config.provider,
    model: config.model,
    state_db: config.state_db ?? "(default)"
  });
  install_weixin_connector(ctx, config);
}
export {
  Config,
  ConsumerLease,
  GRAPH_ASSISTANT_NAME,
  GRAPH_USER_NAME,
  HarnessSessionHost,
  INFLIGHT_TURN_PREFIX,
  IlinkClient,
  InboundCoordinator,
  KnowledgeGraphStore,
  MemoryRemoteClient,
  MessageNormalizer,
  OutboundCoordinator,
  ReplyAggregator,
  STATE_SCHEMA_VERSION,
  TimelineStore,
  TurnContextStore,
  WeixinConnector,
  WeixinIngress,
  WeixinStateStore,
  apply,
  decrypt_aes_ecb,
  get_shared_memory,
  inject,
  install_weixin_connector,
  is_cursor_committable,
  lease_holder_alive,
  merge_messages,
  migrate_legacy_route_state,
  name,
  parse_aes_key,
  parse_control_command,
  preflight_openclaw_isolation,
  probe,
  probe_enabled,
  probe_timer,
  register_graph_tools,
  register_timeline_tools,
  set_shared_memory,
  trace_to_file,
  transcode_silk_to_wav
};
