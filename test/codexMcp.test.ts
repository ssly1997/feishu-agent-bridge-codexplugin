import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG } from "../src/config.js";
import {
  parseCodexMcpListOutput,
  readCodexMcpList,
  sanitizeCodexCliText
} from "../src/codexMcp.js";

const MCP_LIST_OUTPUT = `Name                 Command                                                                                                       Args                                                                                          Env                                                     Cwd                                                                            Status    Auth       
computer-use         ./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient  mcp                                                                                           -                                                       /Users/example/.codex/plugins/cache/openai-bundled/computer-use/1.0.793/.     enabled   Unsupported
figma                /Users/example/.nvm/versions/node/v22.22.0/bin/npx                                                            -y figma-developer-mcp --figma-api-key=figd_example123 --stdio                                 -                                                       -                                                                              enabled   Unsupported
live-socket          /Users/example/projects/live-agentprobe-mcp/.build/debug/live-agentprobe-mcp                                  -                                                                                             AGENT_PROBE_BASE_URL=abc, LIVE_SOCKET_MCP_HOME=/tmp     -                                                                              disabled  Unsupported

Name         Url                         Bearer Token Env Var  Status   Auth       
viewinspect  http://127.0.0.1:47199/mcp  -                     enabled  Unsupported
`;

test("parseCodexMcpListOutput parses stdio and http MCP tables", () => {
  const servers = parseCodexMcpListOutput(MCP_LIST_OUTPUT);

  assert.equal(servers.length, 4);
  assert.deepEqual(servers[0], {
    name: "computer-use",
    transport: "stdio",
    command: "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
    args: "mcp",
    env: undefined,
    cwd: "/Users/example/.codex/plugins/cache/openai-bundled/computer-use/1.0.793/.",
    status: "enabled",
    auth: "Unsupported"
  });
  assert.equal(servers[1].name, "figma");
  assert.equal(servers[1].args, "-y figma-developer-mcp --figma-api-key=*** --stdio");
  assert.equal(servers[2].status, "disabled");
  assert.equal(servers[2].env, "AGENT_PROBE_BASE_URL=***, LIVE_SOCKET_MCP_HOME=***");
  assert.deepEqual(servers[3], {
    name: "viewinspect",
    transport: "http",
    url: "http://127.0.0.1:47199/mcp",
    bearerTokenEnvVar: undefined,
    status: "enabled",
    auth: "Unsupported"
  });
});

test("sanitizeCodexCliText masks token-like values", () => {
  assert.equal(
    sanitizeCodexCliText("--figma-api-key=figd_abc123 TOKEN=secret Bearer abc.def"),
    "--figma-api-key=*** TOKEN=*** Bearer ***"
  );
});

test("readCodexMcpList executes configured codex command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fab-mcp-list-"));
  const scriptPath = join(dir, "fake-codex.mjs");
  try {
    await writeFile(scriptPath, `#!/usr/bin/env node
if (process.argv[2] !== "mcp" || process.argv[3] !== "list") {
  process.exit(2);
}
process.stdout.write(${JSON.stringify(MCP_LIST_OUTPUT)});
`, "utf8");
    await chmod(scriptPath, 0o755);

    const result = await readCodexMcpList({
      ...DEFAULT_CONFIG.codex,
      command: scriptPath
    });

    assert.equal(result.error, undefined);
    assert.equal(result.command, `${scriptPath} mcp list`);
    assert.equal(result.servers.length, 4);
    assert.equal(result.servers[1].args, "-y figma-developer-mcp --figma-api-key=*** --stdio");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
