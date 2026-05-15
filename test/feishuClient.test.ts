import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CONFIG } from "../src/config.js";
import { FeishuApiError, FeishuClient } from "../src/feishuClient.js";

const readyConfig = {
  ...DEFAULT_CONFIG,
  appId: "cli_test",
  appSecret: "secret_test",
  receiveId: "oc_test",
  enabled: true
};

test("FeishuClient obtains and caches tenant_access_token", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: "om_test" } });
  };

  const client = new FeishuClient({ fetchImpl });
  await client.sendInteractiveMessage(readyConfig, { header: { title: "one" } });
  await client.sendInteractiveMessage(readyConfig, { header: { title: "two" } });

  assert.equal(
    calls.filter((call) => call.url.includes("/auth/v3/tenant_access_token/internal")).length,
    1
  );
  assert.equal(calls.filter((call) => call.url.includes("/im/v1/messages")).length, 2);
  assert.equal(client.hasCachedToken(), true);
});

test("FeishuClient sends interactive content as a JSON string", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: "om_test" } });
  };

  const client = new FeishuClient({ fetchImpl });
  await client.sendInteractiveMessage(readyConfig, { config: { wide_screen_mode: true } });

  const messageCall = calls.find((call) => call.url.includes("/im/v1/messages"));
  assert.ok(messageCall);
  const body = JSON.parse(String(messageCall.init?.body));
  assert.equal(body.receive_id, "oc_test");
  assert.equal(body.msg_type, "interactive");
  assert.equal(typeof body.content, "string");
  assert.deepEqual(JSON.parse(body.content), { config: { wide_screen_mode: true } });
});

test("FeishuClient sends text messages to an explicit receiver", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: "om_text" } });
  };

  const client = new FeishuClient({ fetchImpl });
  await client.sendTextMessage(
    { ...readyConfig, receiveId: undefined },
    { receiveIdType: "chat_id", receiveId: "oc_reply" },
    "收到"
  );

  const messageCall = calls.find((call) => call.url.includes("/im/v1/messages"));
  assert.ok(messageCall);
  assert.match(messageCall.url, /receive_id_type=chat_id/);
  const body = JSON.parse(String(messageCall.init?.body));
  assert.equal(body.receive_id, "oc_reply");
  assert.equal(body.msg_type, "text");
  assert.deepEqual(JSON.parse(body.content), { text: "收到" });
});

test("FeishuClient sends interactive messages to an explicit receiver", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: "om_card" } });
  };

  const client = new FeishuClient({ fetchImpl });
  await client.sendInteractiveMessageToReceiver(
    { ...readyConfig, receiveId: undefined },
    { receiveIdType: "chat_id", receiveId: "oc_reply" },
    { config: { wide_screen_mode: true } }
  );

  const messageCall = calls.find((call) => call.url.includes("/im/v1/messages"));
  assert.ok(messageCall);
  assert.match(messageCall.url, /receive_id_type=chat_id/);
  const body = JSON.parse(String(messageCall.init?.body));
  assert.equal(body.receive_id, "oc_reply");
  assert.equal(body.msg_type, "interactive");
  assert.deepEqual(JSON.parse(body.content), { config: { wide_screen_mode: true } });
});

test("FeishuClient updates an existing interactive message", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 0, data: { message_id: "om_card" } });
  };

  const client = new FeishuClient({ fetchImpl });
  await client.updateInteractiveMessage(readyConfig, "om_card", { config: { update_multi: true } });

  const updateCall = calls.find((call) => call.url.includes("/im/v1/messages/om_card"));
  assert.ok(updateCall);
  assert.equal(updateCall.init?.method, "PATCH");
  const body = JSON.parse(String(updateCall.init?.body));
  assert.equal(typeof body.content, "string");
  assert.deepEqual(JSON.parse(body.content), { config: { update_multi: true } });
});

test("FeishuClient maps Feishu API errors without exposing credentials", async () => {
  const fetchImpl = async (url: string) => {
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({ code: 99991663, msg: "Access denied" });
  };

  const client = new FeishuClient({ fetchImpl });
  await assert.rejects(
    client.sendInteractiveMessage(readyConfig, {}),
    (error) => {
      assert.ok(error instanceof FeishuApiError);
      assert.match(error.message, /Access denied/);
      assert.doesNotMatch(error.message, /secret_test/);
      assert.doesNotMatch(error.message, /tat_test/);
      return true;
    }
  );
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  };
}
