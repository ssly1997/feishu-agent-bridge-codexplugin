#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2] ? resolve(root, process.argv[2]) : join(root, "dist/src/index.js");

await runSmoke("content-length");
await runSmoke("line");
console.log("MCP smoke passed");

async function runSmoke(mode) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    stdio: ["pipe", "pipe", "inherit"]
  });

  let buffer = Buffer.alloc(0);
  const responses = [];

  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (mode === "line") {
      parseLineResponses();
    } else {
      parseContentLengthResponses();
    }
  });

  function parseLineResponses() {
    while (true) {
      const lineEnd = buffer.indexOf("\n");
      if (lineEnd === -1) return;
      const body = buffer.subarray(0, lineEnd).toString("utf8").trim();
      buffer = buffer.subarray(lineEnd + 1);
      if (body.length > 0) {
        responses.push(JSON.parse(body));
      }
    }
  }

  function parseContentLengthResponses() {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const headers = buffer.subarray(0, headerEnd).toString("utf8");
      const match = headers.match(/Content-Length:\s*(\d+)/i);
      assert.ok(match, `missing Content-Length in ${headers}`);
      const length = Number(match[1]);
      const start = headerEnd + 4;
      const end = start + length;
      if (buffer.length < end) return;
      responses.push(JSON.parse(buffer.subarray(start, end).toString("utf8")));
      buffer = buffer.subarray(end);
    }
  }

  function send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (mode === "line") {
      child.stdin.write(`${body.toString("utf8")}\n`);
    } else {
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
      child.stdin.write(body);
    }
  }

  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "feishu-agent-bridge-smoke",
        version: "0.1.0"
      }
    }
  });
  send({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "feishu_status",
      arguments: {}
    }
  });

  const deadline = Date.now() + 5000;
  while (responses.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  child.stdin.end();
  await once(child, "exit");

  assert.equal(responses.length, 3, `${mode} response count`);
  assert.equal(responses[0].result.serverInfo.name, "feishu-agent-bridge");
  const tools = responses[1].result.tools.map((tool) => tool.name);
  assert.deepEqual(tools.sort(), [
    "feishu_ack_command",
    "feishu_command_status",
    "feishu_list_commands",
    "feishu_next_command",
    "feishu_notify",
    "feishu_notify_task_result",
    "feishu_send_test",
    "feishu_set_enabled",
    "feishu_set_inbound_enabled",
    "feishu_start_command_listener",
    "feishu_status",
    "feishu_stop_command_listener"
  ]);
  assert.match(responses[2].result.content[0].text, /configPath/);
}
