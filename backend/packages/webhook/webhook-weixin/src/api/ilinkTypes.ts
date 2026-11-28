/** 微信 iLink 协议类型层：定义请求、响应、消息和媒体字段；不保存凭据。 */

export interface IlinkBaseInfo {
  channel_version?: string
  bot_agent?: string
}

export interface IlinkMedia {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
  full_url?: string
}

export interface IlinkVoiceItem {
  media?: IlinkMedia
  encode_type?: number
  sample_rate?: number
  playtime?: number
  text?: string
}

export interface IlinkImageItem {
  media?: IlinkMedia
  thumb_media?: IlinkMedia
  aeskey?: string
  url?: string
  mid_size?: number
  thumb_size?: number
  thumb_height?: number
  thumb_width?: number
  hd_size?: number
}

export interface IlinkFileItem {
  media?: IlinkMedia
  file_name?: string
  md5?: string
  len?: string
}

export interface IlinkMessageItem {
  type?: number
  create_time_ms?: number
  msg_id?: string
  text_item?: { text?: string }
  image_item?: IlinkImageItem
  voice_item?: IlinkVoiceItem
  file_item?: IlinkFileItem
  ref_msg?: { title?: string; message_item?: IlinkMessageItem }
}

export interface IlinkMessage {
  seq?: number
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  item_list?: IlinkMessageItem[]
  context_token?: string
  run_id?: string
}

export interface IlinkGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: IlinkMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export interface IlinkSendMessageResponse {
  ret?: number
  errmsg?: string
}

export interface IlinkClientOptions {
  base_url: string
  cdn_base_url?: string
  token: string
  channel_version?: string
  bot_agent?: string
  timeout_ms?: number
  long_poll_timeout_ms?: number
  fetch_impl?: typeof fetch
  random_uin?: string
  send_retry_count?: number
  send_retry_delay_ms?: number
}

export interface IlinkSendMessageInput {
  to_user_id: string
  context_token?: string
  text: string
  client_id?: string
  item_list?: IlinkMessageItem[]
  run_id?: string
}

export interface IlinkUploadRequest {
  filekey: string
  media_type: number
  to_user_id: string
  rawsize: number
  rawfilemd5: string
  filesize: number
  no_need_thumb?: boolean
  aeskey: string
}

export interface IlinkUploadResponse {
  upload_param?: string
  upload_full_url?: string
  thumb_upload_param?: string
}

export interface IlinkUpdateCursor {
  get_updates_buf: string
}
