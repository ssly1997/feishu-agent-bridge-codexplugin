import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("FeishuClient downloads a message resource to a local file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-feishu-resource-"));
  const outputPath = join(dir, "image.png");
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    const body = Buffer.from("image-bytes");
    return {
      ok: true,
      status: 200,
      text: async () => "image-bytes",
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type" ? "image/png" : null
      }
    };
  };

  try {
    const client = new FeishuClient({ fetchImpl });
    const result = await client.downloadMessageResource(
      readyConfig,
      "om_image",
      "img_key",
      outputPath
    );

    assert.equal(await readFile(outputPath, "utf8"), "image-bytes");
    assert.equal(result.path, outputPath);
    assert.equal(result.mimeType, "image/png");
    assert.equal(result.sizeBytes, Buffer.byteLength("image-bytes"));
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    const resourceCall = calls.find((call) => call.url.includes("/messages/om_image/resources/img_key"));
    assert.ok(resourceCall);
    assert.match(resourceCall.url, /[?&]type=image(?:&|$)/);
    assert.equal(resourceCall.init?.method, "GET");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FeishuClient reads chat info", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token/internal")) {
      return jsonResponse({ code: 0, tenant_access_token: "tat_test", expire: 7200 });
    }
    return jsonResponse({
      code: 0,
      data: {
        chat_id: "oc_test",
        name: "测试群",
        chat_type: "group"
      }
    });
  };

  const client = new FeishuClient({ fetchImpl });
  const result = await client.getChatInfo(readyConfig, "oc_test");

  assert.equal(result.chatId, "oc_test");
  assert.equal(result.name, "测试群");
  assert.equal(result.chatType, "group");
  const chatCall = calls.find((call) => call.url.includes("/im/v1/chats/oc_test"));
  assert.ok(chatCall);
  assert.equal(chatCall.init?.method, "GET");
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
