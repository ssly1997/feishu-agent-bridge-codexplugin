import type { BridgeConfig, ReceiveIdType } from "./types.js";
import { ConfigError, assertAppCredentialsReady, assertSendReady } from "./config.js";

type FetchLike = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

interface TokenResponse {
  code: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface MessageResponse {
  code: number;
  msg?: string;
  data?: {
    message_id?: string;
  };
}

interface MessageListResponse {
  code: number;
  msg?: string;
  data?: {
    items?: RawFeishuMessage[];
  };
}

interface RawFeishuMessage {
  message_id: string;
  create_time?: string;
  chat_id?: string;
  chat_type?: string;
  msg_type?: string;
  message_type?: string;
  body?: {
    content?: string;
  };
  content?: string;
  mentions?: RawFeishuMention[];
  sender?: {
    id?: string;
    id_type?: string;
    sender_type?: string;
    tenant_key?: string;
  };
}

interface RawFeishuMention {
  id?: string;
  id_type?: string;
  key?: string;
  name?: string;
  tenant_key?: string;
}

export interface FeishuChatMessage {
  messageId: string;
  createTime?: string;
  chatId: string;
  chatType?: string;
  messageType: string;
  content: string;
  mentions?: RawFeishuMention[];
  sender?: RawFeishuMessage["sender"];
}

export class FeishuApiError extends Error {
  readonly code?: number;
  readonly status?: number;

  constructor(message: string, options: { code?: number; status?: number } = {}) {
    super(message);
    this.name = "FeishuApiError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class FeishuClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private cachedToken?: {
    token: string;
    expiresAtMs: number;
  };

  constructor(options: { fetchImpl?: FetchLike; baseUrl?: string; now?: () => number } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://open.feishu.cn/open-apis";
    this.now = options.now ?? Date.now;
  }

  hasCachedToken(): boolean {
    return Boolean(this.cachedToken && this.cachedToken.expiresAtMs > this.now());
  }

  async sendInteractiveMessage(
    config: BridgeConfig,
    card: unknown
  ): Promise<{ messageId?: string }> {
    assertSendReady(config);
    return this.sendMessage(config, {
      receiveIdType: config.receiveIdType,
      receiveId: config.receiveId ?? "",
      msgType: "interactive",
      content: card
    });
  }

  async sendInteractiveMessageToReceiver(
    config: BridgeConfig,
    receiver: { receiveIdType: ReceiveIdType; receiveId: string },
    card: unknown
  ): Promise<{ messageId?: string }> {
    if (!receiver.receiveId) {
      throw new ConfigError("receiver.receiveId must be a non-empty string");
    }
    return this.sendMessage(config, {
      ...receiver,
      msgType: "interactive",
      content: card
    });
  }

  async sendTextMessage(
    config: BridgeConfig,
    receiver: { receiveIdType: ReceiveIdType; receiveId: string },
    text: string
  ): Promise<{ messageId?: string }> {
    if (!receiver.receiveId) {
      throw new ConfigError("receiver.receiveId must be a non-empty string");
    }
    if (!text) {
      throw new ConfigError("text must be a non-empty string");
    }
    return this.sendMessage(config, {
      ...receiver,
      msgType: "text",
      content: { text }
    });
  }

  async listChatMessages(
    config: BridgeConfig,
    chatId: string,
    options: { pageSize?: number } = {}
  ): Promise<FeishuChatMessage[]> {
    assertAppCredentialsReady(config);
    const token = await this.getTenantAccessToken(config);
    const url = new URL(`${this.baseUrl}/im/v1/messages`);
    url.searchParams.set("container_id_type", "chat");
    url.searchParams.set("container_id", chatId);
    url.searchParams.set("sort_type", "ByCreateTimeDesc");
    url.searchParams.set("page_size", String(options.pageSize ?? 20));

    const response = await this.getJson<MessageListResponse>(url.toString(), {
      Authorization: `Bearer ${token}`
    });

    if (response.code !== 0) {
      throw new FeishuApiError(`Feishu list messages failed: ${response.msg || "unknown error"}`, {
        code: response.code
      });
    }

    return (response.data?.items ?? []).map((item) => ({
      messageId: item.message_id,
      createTime: item.create_time,
      chatId: item.chat_id ?? chatId,
      chatType: item.chat_type,
      messageType: item.msg_type ?? item.message_type ?? "",
      content: item.body?.content ?? item.content ?? "",
      mentions: item.mentions,
      sender: item.sender
    }));
  }

  private async sendMessage(
    config: BridgeConfig,
    input: {
      receiveIdType: ReceiveIdType;
      receiveId: string;
      msgType: "interactive" | "text";
      content: unknown;
    }
  ): Promise<{ messageId?: string }> {
    assertAppCredentialsReady(config);
    const token = await this.getTenantAccessToken(config);
    const url = `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(
      input.receiveIdType
    )}`;
    const response = await this.postJson<MessageResponse>(
      url,
      {
        receive_id: input.receiveId,
        msg_type: input.msgType,
        content: JSON.stringify(input.content)
      },
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    );

    if (response.code !== 0) {
      throw new FeishuApiError(`Feishu send message failed: ${response.msg || "unknown error"}`, {
        code: response.code
      });
    }

    return {
      messageId: response.data?.message_id
    };
  }

  private async getTenantAccessToken(config: BridgeConfig): Promise<string> {
    assertAppCredentialsReady(config);
    if (this.cachedToken && this.cachedToken.expiresAtMs > this.now()) {
      return this.cachedToken.token;
    }

    const response = await this.postJson<TokenResponse>(
      `${this.baseUrl}/auth/v3/tenant_access_token/internal`,
      {
        app_id: config.appId,
        app_secret: config.appSecret
      },
      {
        "Content-Type": "application/json"
      }
    );

    if (response.code !== 0 || !response.tenant_access_token) {
      throw new FeishuApiError(`Feishu token request failed: ${response.msg || "unknown error"}`, {
        code: response.code
      });
    }

    const expireSeconds = Math.max((response.expire ?? 7200) - 60, 60);
    this.cachedToken = {
      token: response.tenant_access_token,
      expiresAtMs: this.now() + expireSeconds * 1000
    };

    return response.tenant_access_token;
  }

  private async postJson<T>(
    url: string,
    body: Record<string, unknown>,
    headers: Record<string, string>
  ): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let parsed: unknown;

    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new FeishuApiError(`Feishu API returned non-JSON response, HTTP ${response.status}`, {
        status: response.status
      });
    }

    if (!response.ok) {
      const message = isObject(parsed) && typeof parsed.msg === "string" ? parsed.msg : text;
      throw new FeishuApiError(`Feishu API HTTP ${response.status}: ${message}`, {
        status: response.status
      });
    }

    return parsed as T;
  }

  private async getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers
    });
    const text = await response.text();
    let parsed: unknown;

    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new FeishuApiError(`Feishu API returned non-JSON response, HTTP ${response.status}`, {
        status: response.status
      });
    }

    if (!response.ok) {
      const message = isObject(parsed) && typeof parsed.msg === "string" ? parsed.msg : text;
      throw new FeishuApiError(`Feishu API HTTP ${response.status}: ${message}`, {
        status: response.status
      });
    }

    return parsed as T;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
