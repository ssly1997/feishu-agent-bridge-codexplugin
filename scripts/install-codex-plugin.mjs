#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const pluginName = "feishu-agent-bridge";
const marketplaceName = "local";
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const home = homedir();
const pluginLink = join(home, "plugins", pluginName);
const pluginVersion = await loadPluginVersion(join(repoRoot, ".codex-plugin", "plugin.json"));
const pluginCachePath = join(
  home,
  ".codex",
  "plugins",
  "cache",
  marketplaceName,
  pluginName,
  pluginVersion
);
const marketplacePath = join(home, ".agents", "plugins", "marketplace.json");
const codexConfigPath = join(home, ".codex", "config.toml");
const bridgeConfigPath = join(home, ".feishu-agent-bridge", "config.json");
const dryRun = process.argv.includes("--dry-run");

const entry = {
  name: pluginName,
  source: {
    source: "local",
    path: `./plugins/${pluginName}`
  },
  policy: {
    installation: "AVAILABLE",
    authentication: "ON_INSTALL"
  },
  category: "Coding"
};

const marketplace = await loadMarketplace(marketplacePath);
const index = marketplace.plugins.findIndex((plugin) => plugin?.name === pluginName);
if (index >= 0) {
  marketplace.plugins[index] = entry;
} else {
  marketplace.plugins.push(entry);
}

if (dryRun) {
  console.log(
    JSON.stringify(
      {
        repoRoot,
        pluginLink,
        marketplacePath,
        codexConfigPath,
        codexMarketplace: {
          name: marketplaceName,
          source: home
        },
        codexPluginKey: `${pluginName}@${marketplaceName}`,
        pluginCachePath,
        pluginVersion,
        bridgeConfigPath,
        marketplaceEntry: entry,
        action: index >= 0 ? "update" : "append"
      },
      null,
      2
    )
  );
  process.exit(0);
}

await mkdir(dirname(pluginLink), { recursive: true });
await removeExistingPluginLink(pluginLink);
await symlink(repoRoot, pluginLink, "dir");

await refreshPluginCache(pluginCachePath);

await mkdir(dirname(marketplacePath), { recursive: true });
await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`, "utf8");
await updateCodexConfig(codexConfigPath);

console.log(`Installed ${pluginName} plugin link: ${pluginLink}`);
console.log(`Refreshed ${pluginName} plugin cache: ${pluginCachePath}`);
console.log(`Updated marketplace: ${marketplacePath}`);
console.log(`Updated Codex config: ${codexConfigPath}`);
await warnIfPollingFallbackEnabled(bridgeConfigPath);
console.log("Restart Codex or refresh plugins after running corepack pnpm build.");

async function loadPluginVersion(path) {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error(`${path} must contain a non-empty version`);
  }
  return parsed.version;
}

async function loadMarketplace(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return {
      name: "local",
      interface: {
        displayName: "Local Plugins"
      },
      plugins: []
    };
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`${path} must contain a JSON object`);
  }

  return {
    name: typeof parsed.name === "string" ? parsed.name : "local",
    interface:
      parsed.interface && typeof parsed.interface === "object"
        ? parsed.interface
        : { displayName: "Local Plugins" },
    plugins: Array.isArray(parsed.plugins) ? parsed.plugins : []
  };
}

async function removeExistingPluginLink(path) {
  let stat;
  try {
    stat = await lstat(path);
  } catch {
    return;
  }

  if (!stat.isSymbolicLink()) {
    throw new Error(
      `${path} already exists and is not a symlink. Move it aside before installing this plugin.`
    );
  }

  await rm(path, { force: true });
}

async function refreshPluginCache(path) {
  await rm(path, { force: true, recursive: true });
  await mkdir(path, { recursive: true });

  const entries = [
    ".codex-plugin",
    ".mcp.json",
    "assets",
    "dist",
    "node_modules",
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "scripts",
    "skills"
  ];

  for (const entryName of entries) {
    const source = join(repoRoot, entryName);
    try {
      await lstat(source);
    } catch {
      continue;
    }
    await cp(source, join(path, entryName), {
      recursive: true,
      dereference: entryName !== "node_modules",
      force: true
    });
  }
}

async function updateCodexConfig(path) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    text = "";
  }

  const additions = [];
  if (!text.includes(`[marketplaces.${marketplaceName}]`)) {
    additions.push(
      [
        `[marketplaces.${marketplaceName}]`,
        `source_type = "local"`,
        `source = "${escapeTomlString(home)}"`
      ].join("\n")
    );
  }

  const pluginKey = `${pluginName}@${marketplaceName}`;
  if (!text.includes(`[plugins."${pluginKey}"]`)) {
    additions.push([`[plugins."${pluginKey}"]`, "enabled = true"].join("\n"));
  }

  if (additions.length === 0) return;

  await mkdir(dirname(path), { recursive: true });
  const next = [text.trimEnd(), ...additions].filter(Boolean).join("\n\n") + "\n";
  await writeFile(path, next, "utf8");
}

async function warnIfPollingFallbackEnabled(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[feishu-agent-bridge] Warning: ${path} is not valid JSON.`);
    return;
  }

  if (parsed?.inbound?.pollingEnabled === true) {
    console.warn(
      `[feishu-agent-bridge] Warning: inbound.pollingEnabled is true in ${path}. ` +
        "Long connection should be preferred; polling can replay recent Feishu messages. " +
        "Set inbound.pollingEnabled to false unless you are actively debugging event delivery."
    );
  }
}

function escapeTomlString(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
