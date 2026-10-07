#!/usr/bin/env node

// Experimental celld variant of `pnpm run-local` (see scripts/run-local.ts): runs the backend, serving
// the pre-built frontend, on celld (https://celld.dev) instead of wrangler. Gatekeepers are not
// started, since `celld dev` runs a single project. See scripts/celld/TODO.md for what works.
//
// Extra flags (e.g. --clean, --port, --logs) are passed on to `celld dev`.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pnpmCommand } from "../pnpm-command.ts";
import { relayTermination } from "../relay-termination.ts";
import { vpRunEnv } from "../vp/concurrency.ts";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BACKEND_DIR = join(ROOT, "packages", "workshop-backend");

const env = vpRunEnv();

// Workspaces need RPC targets to cross isolates, which only a patched celld build supports
// (https://github.com/patcon/celld/tree/rpc-targets-cross-isolate; see scripts/celld/TODO.md).
const PATCHED_VERSION = /-rpc-targets\.\d+/;
let celldVersion: string;
try {
  celldVersion = execFileSync("celld", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n").find(line => line.startsWith("celld ")) ?? "celld (unknown version)";
} catch {
  console.error("celld is not on PATH. Install it: https://celld.dev");
  process.exit(1);
}
if (!PATCHED_VERSION.test(celldVersion)) {
  console.warn(`\nWarning: ${celldVersion} lacks the rpc-targets patch; opening a workspace will fail.\n`);
}

function runPnpm(args: string[], cwd = ROOT): void {
  console.log(`\n> pnpm ${args.join(" ")}`);
  const [command, argv] = pnpmCommand(args);
  execFileSync(command, argv, { stdio: "inherit", cwd, env });
}

runPnpm(["install"]);
runPnpm(["exec", "vp", "run", "--cache", "@gadgets/typed-storage#build"]);
runPnpm(["exec", "vp", "run", "--cache", "@gadgets/workshop-frontend#build:assets"]);
// wrangler runs this as the backend's `build.command`; celld only bundles.
runPnpm(["run", "build:worker"], BACKEND_DIR);

execFileSync(process.execPath, [
  join(ROOT, "scripts", "celld", "make-config.ts"),
  join(BACKEND_DIR, "wrangler.jsonc"),
  "--serve-frontend-assets",
], { stdio: "inherit", cwd: ROOT });

// celld refuses an assets directory outside the project, or a symlink, so copy the bundle in.
const assetsDir = join(BACKEND_DIR, "celld-assets");
rmSync(assetsDir, { recursive: true, force: true });
cpSync(join(ROOT, "packages", "workshop-frontend", "dist"), assetsDir, { recursive: true });

console.log("\nStarting celld ...");
const server = spawn("celld", ["dev", "wrangler.celld.json", ...process.argv.slice(2)],
    { stdio: "inherit", cwd: BACKEND_DIR, env });
relayTermination(server);
