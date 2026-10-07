#!/usr/bin/env node

// Experimental: derive a celld-compatible config (https://celld.dev) from a Wrangler config.
//
//   node scripts/celld/make-config.ts packages/workshop-backend/wrangler.jsonc [--serve-frontend-assets]
//
// Writes `wrangler.celld.json` beside the input. celld rejects every top-level key it does not
// implement, so this keeps only the keys it accepts, drops bindings it has no equivalent for
// (Browser Rendering), and adds explicit module rules, since celld applies no Wrangler defaults.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "jsonc-parser";

const ACCEPTED_KEYS = new Set([
  "$schema", "name", "main", "no_bundle",
  "compatibility_date", "compatibility_flags",
  "durable_objects", "migrations",
  "assets", "services", "triggers", "vars",
  "d1_databases", "kv_namespaces", "queues", "workflows", "r2_buckets",
  "worker_loaders", "containers",
  "define", "rules",
]);

const [input, ...flags] = process.argv.slice(2);
if (!input) {
  console.error("usage: make-config.ts <wrangler.jsonc> [--serve-frontend-assets]");
  process.exit(1);
}

const config = parse(readFileSync(input, "utf8"));

for (const key of Object.keys(config)) {
  if (!ACCEPTED_KEYS.has(key)) {
    console.warn(`dropping unsupported key: ${key}`);
    delete config[key];
  }
}

// celld names a namespace by its `id`; reuse Wrangler's local `preview_id` (or the binding name).
for (const kv of config.kv_namespaces ?? []) {
  kv.id ??= kv.preview_id ?? kv.binding;
  delete kv.preview_id;
}

// celld builds a `ctx.exports` namespace only for a class with a `durable_objects` binding, where
// workerd builds one for every migrated class. Bind each migrated class under its own name.
const bound = new Set(
    (config.durable_objects?.bindings ?? []).map((b: { class_name: string }) => b.class_name));
for (const migration of config.migrations ?? []) {
  for (const className of migration.new_sqlite_classes ?? []) {
    if (bound.has(className)) continue;
    config.durable_objects ??= { bindings: [] };
    config.durable_objects.bindings.push({ name: className, class_name: className });
    bound.add(className);
  }
}

// Wrangler's default module rules, which celld does not apply implicitly.
config.rules = [
  ...(config.rules ?? []),
  { type: "Text", globs: ["**/*.txt"] },
];

if (flags.includes("--serve-frontend-assets")) {
  config.assets = {
    // celld requires the directory inside the project; run-celld links it there.
    directory: "celld-assets",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api", "/api/*", "/blueprint-screenshot/*"],
  };
}

const outPath = join(dirname(input), "wrangler.celld.json");
writeFileSync(outPath, JSON.stringify(config, null, 2) + "\n");
console.log(`generated: ${outPath}`);
