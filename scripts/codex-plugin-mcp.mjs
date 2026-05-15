#!/usr/bin/env node
import { access, mkdir, readFile, readdir, symlink } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const entry = join(repoRoot, "dist", "src", "index.js");

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 11)) {
  console.error(
    `[feishu-agent-bridge] Node.js ${process.versions.node} is too old. Please use Node.js 20.11 or newer.`
  );
  process.exit(1);
}

try {
  await access(entry);
} catch {
  console.error(
    `[feishu-agent-bridge] Missing ${entry}. Run "corepack pnpm install && corepack pnpm build" in ${repoRoot} before enabling the Codex plugin.`
  );
  process.exit(1);
}

await repairPnpmDependencyLinks(repoRoot);
await ensureRuntimeSidecar(repoRoot);

const child = spawn(process.execPath, [entry], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit"
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    const signalExitCodes = {
      SIGHUP: 129,
      SIGINT: 130,
      SIGTERM: 143
    };
    process.exit(signalExitCodes[signal] ?? 1);
    return;
  }
  process.exit(code ?? 1);
});

async function ensureRuntimeSidecar(root) {
  if (process.env.FEISHU_AGENT_BRIDGE_SKIP_RUNTIME_AUTOSTART === "1") return;
  const control = join(root, "scripts", "runtime-control.mjs");
  try {
    await access(control);
  } catch {
    return;
  }

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [control, "ensure", "--quiet"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "ignore", "inherit"]
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, 5_000);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.on("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function repairPnpmDependencyLinks(root) {
  const packageJsonPath = join(root, "package.json");
  const nodeModules = join(root, "node_modules");
  let pkg;

  try {
    pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    return;
  }

  const dependencies = {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {})
  };

  for (const packageName of Object.keys(dependencies)) {
    const linkPath = join(nodeModules, ...packageName.split("/"));
    if (await exists(linkPath)) continue;

    const target = await findPnpmPackageTarget(nodeModules, packageName);
    if (!target) continue;

    await mkdir(dirname(linkPath), { recursive: true });
    const linkTarget = relative(dirname(linkPath), target);
    await symlink(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
  }
}

async function findPnpmPackageTarget(nodeModules, packageName) {
  const pnpmDir = join(nodeModules, ".pnpm");
  const encodedName = packageName.replace("/", "+");

  let entries;
  try {
    entries = await readdir(pnpmDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${encodedName}@`)) continue;
    const candidate = join(pnpmDir, entry.name, "node_modules", ...packageName.split("/"));
    if (await exists(candidate)) return candidate;
  }

  return null;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
