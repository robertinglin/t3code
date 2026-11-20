import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(fileURLToPath(import.meta.url)), "..");
const installDirectory = NodePath.resolve(
  process.env.T3CODE_LOCAL_DESKTOP_INSTALL_DIR?.trim() ||
    NodePath.join(NodeOS.homedir(), ".local", "opt", "t3code-local"),
);
const buildOutputDirectory = NodePath.join(repoRoot, "release", "local-desktop-build");
const builtAppDirectory = NodePath.join(buildOutputDirectory, "linux-unpacked");
const installedAppDirectory = NodePath.join(installDirectory, "linux-unpacked");
const launcherPath = NodePath.join(installDirectory, "t3code-local");

const build = NodeChildProcess.spawnSync(
  process.execPath,
  [
    NodePath.join(repoRoot, "scripts", "build-desktop-artifact.ts"),
    "--platform",
    "linux",
    "--target",
    "dir",
    "--arch",
    "x64",
    "--output-dir",
    buildOutputDirectory,
  ],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: [NodePath.join(repoRoot, "node_modules", ".bin"), process.env.PATH]
        .filter(Boolean)
        .join(NodePath.delimiter),
    },
    stdio: "inherit",
  },
);

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

await NodeFS.access(NodePath.join(builtAppDirectory, "t3code"), NodeFS.constants.X_OK);
await NodeFS.mkdir(installDirectory, { recursive: true });

const nextAppDirectory = `${installedAppDirectory}.next-${process.pid}`;
const previousAppDirectory = `${installedAppDirectory}.previous-${process.pid}`;
await NodeFS.rm(nextAppDirectory, { recursive: true, force: true });
await NodeFS.cp(builtAppDirectory, nextAppDirectory, { recursive: true });

let movedPreviousApp = false;
try {
  await NodeFS.rename(installedAppDirectory, previousAppDirectory);
  movedPreviousApp = true;
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

try {
  await NodeFS.rename(nextAppDirectory, installedAppDirectory);
} catch (error) {
  if (movedPreviousApp) {
    await NodeFS.rename(previousAppDirectory, installedAppDirectory);
  }
  throw error;
}

if (movedPreviousApp) {
  await NodeFS.rm(previousAppDirectory, { recursive: true, force: true });
}

const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const localHome = NodePath.join(repoRoot, ".data");
const launcher = [
  "#!/usr/bin/env bash",
  "set -euo pipefail",
  `export T3CODE_HOME=${shellQuote(localHome)}`,
  `export T3CODE_DESKTOP_LAUNCHER_PATH=${shellQuote(launcherPath)}`,
  `export XDG_CONFIG_HOME=${shellQuote(NodePath.join(localHome, "local-config"))}`,
  `export XDG_DATA_HOME=${shellQuote(NodePath.join(localHome, "local-share"))}`,
  `exec ${shellQuote(NodePath.join(installedAppDirectory, "t3code"))} "$@"`,
  "",
].join("\n");
const nextLauncherPath = `${launcherPath}.next-${process.pid}`;
await NodeFS.writeFile(nextLauncherPath, launcher, { mode: 0o755 });
await NodeFS.rename(nextLauncherPath, launcherPath);

process.stdout.write(`Deployed local T3 Code to ${installedAppDirectory}\n`);
