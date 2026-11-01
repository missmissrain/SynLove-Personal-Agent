/**
 * 微信出站状态端口。参数由出站协调器传入；实现可以是本地 SQLite 或远程 HTTP 服务。
 *
 * 返回值允许同步或异步，协调器统一使用 await，因此本地模式保持原有行为，
 * 远程模式不会把 HTTP Promise 当成本地记录。
 */
import type { DeliveryRecord, OutboxRecord } from '../types/domain.ts'
import type { WeixinStateStore } from './weixinStateStore.ts'

type MaybePromise<T> = T | Promise<T>
type OutboxInput = Parameters<WeixinStateStore['enqueue_outbox']>[0]
type Json = Record<string, unknown>

export interface StatePort {
  close?(): MaybePromise<void>
  get_cursor(): MaybePromise<string>
  set_cursor(cursor: string): MaybePromise<void>
  get_session_id(user_id: string): MaybePromise<string | undefined>
  set_session_id(user_id: string, session_id: string): MaybePromise<void>
  session_id_for(user_id: string): MaybePromise<string>
  context_epoch(user_id: string): MaybePromise<number>
  get_meta(key: string): MaybePromise<string | undefined>
  set_meta(key: string, value: string): MaybePromise<void>
  list_meta_prefix(prefix: string): MaybePromise<Array<{ key: string, value: string }>>
  delete_meta?(key: string): MaybePromise<void>
  list_users(): MaybePromise<string[]>
  latest_user_id?(): MaybePromise<string | undefined>
  snapshot(): MaybePromise<Json>
  put_delivery_if_absent(record: Json): MaybePromise<boolean>
  get_delivery(delivery_id: string): MaybePromise<DeliveryRecord | undefined>
  delivery_context_token(delivery_id: string): MaybePromise<string | undefined>
  update_delivery(delivery_id: string, status: string, patch?: Json): MaybePromise<boolean>
  batch_committable(delivery_ids: readonly string[]): MaybePromise<boolean>
  clear_queue(): MaybePromise<number>
  enqueue_outbox(input: OutboxInput): MaybePromise<OutboxRecord>
  next_outbox_per_session(now?: number): MaybePromise<OutboxRecord[]>
  next_outbox(session_id: string, now?: number): MaybePromise<OutboxRecord | undefined>
  mark_outbox_sending(outbound_id: string): MaybePromise<void>
  mark_outbox_part_sent(outbound_id: string, index: number): MaybePromise<void>
  mark_outbox_sent(outbound_id: string): MaybePromise<void>
  mark_outbox_failed(
    outbound_id: string,
    status: 'failed_retryable' | 'failed_terminal',
    error: string,
    next_retry_at?: number,
  ): MaybePromise<void>
  get_outbox?(outbound_id: string): MaybePromise<OutboxRecord | undefined>
  prune_parked_results(max_age_ms: number, now?: number): MaybePromise<number>
  trim_pending_notices(session_id: string, keep?: number): MaybePromise<number>
  list_pending_outbox(limit?: number): MaybePromise<OutboxRecord[]>
  try_acquire_lease(input: {
    owner_id: string
    pid: number
    process_started_at: number
    account_id: string
    stale_ms: number
  }): MaybePromise<boolean>
  get_lease(): MaybePromise<{
    owner_id: string
    pid: number
    heartbeat_at: number
    account_id: string
    process_started_at: number
  } | undefined>
  heartbeat_lease(owner_id: string): MaybePromise<boolean>
  release_lease(owner_id: string): MaybePromise<void>
  bind_turn_context?(input: Json): MaybePromise<void>
  get_turn_context?(session_id: string, turn: number): MaybePromise<{
    delivery_id: string
    user_id: string
    context_token?: string
  } | undefined>
  latest_delivery_for_session?(session_id: string): MaybePromise<DeliveryRecord | undefined>
  prune_turn_context?(session_id: string, keep?: number): MaybePromise<void>
  parked_results?(limit?: number): MaybePromise<Array<{
    outbound_id: string
    sequence: number
    text: string
    created_at: number
  }>>
}
