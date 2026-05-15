import { ConfigError, assertAppCredentialsReady, assertSendReady } from "./config.js";
export class FeishuApiError extends Error {
    code;
    status;
    constructor(message, options = {}) {
        super(message);
        this.name = "FeishuApiError";
        this.code = options.code;
        this.status = options.status;
    }
}
export class FeishuClient {
    fetchImpl;
    baseUrl;
    now;
    cachedToken;
    constructor(options = {}) {
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.baseUrl = options.baseUrl ?? "https://open.feishu.cn/open-apis";
        this.now = options.now ?? Date.now;
    }
    hasCachedToken() {
        return Boolean(this.cachedToken && this.cachedToken.expiresAtMs > this.now());
    }
    async sendInteractiveMessage(config, card) {
        assertSendReady(config);
        return this.sendMessage(config, {
            receiveIdType: config.receiveIdType,
            receiveId: config.receiveId ?? "",
            msgType: "interactive",
            content: card
        });
    }
    async sendInteractiveMessageToReceiver(config, receiver, card) {
        if (!receiver.receiveId) {
            throw new ConfigError("receiver.receiveId must be a non-empty string");
        }
        return this.sendMessage(config, {
            ...receiver,
            msgType: "interactive",
            content: card
        });
    }
    async sendTextMessage(config, receiver, text) {
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
    async sendMessage(config, input) {
        assertAppCredentialsReady(config);
        const token = await this.getTenantAccessToken(config);
        const url = `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(input.receiveIdType)}`;
        const response = await this.postJson(url, {
            receive_id: input.receiveId,
            msg_type: input.msgType,
            content: JSON.stringify(input.content)
        }, {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
        });
        if (response.code !== 0) {
            throw new FeishuApiError(`Feishu send message failed: ${response.msg || "unknown error"}`, {
                code: response.code
            });
        }
        return {
            messageId: response.data?.message_id
        };
    }
    async getTenantAccessToken(config) {
        assertAppCredentialsReady(config);
        if (this.cachedToken && this.cachedToken.expiresAtMs > this.now()) {
            return this.cachedToken.token;
        }
        const response = await this.postJson(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
            app_id: config.appId,
            app_secret: config.appSecret
        }, {
            "Content-Type": "application/json"
        });
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
    async postJson(url, body, headers) {
        const response = await this.fetchImpl(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
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
        return parsed;
    }
    async getJson(url, headers) {
        const response = await this.fetchImpl(url, {
            method: "GET",
            headers
        });
        const text = await response.text();
        let parsed;
        try {
            parsed = text ? JSON.parse(text) : {};
        }
        catch {
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
        return parsed;
    }
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
