#!/usr/bin/env node
/**
 * Structure guard for the root package.json scripts block.
 *
 * The root scripts block is the single entry point for every recurring task
 * (CLAUDE.md § "Root package.json scripts"), which only holds if its targets
 * actually resolve. This checks that:
 *
 *   - every `bash <path>` / `node <path>` target exists on disk
 *   - every `pnpm -C <dir> <script>` resolves to a real script in that workspace
 *   - every `pnpm run <name>` refers to a real root script
 *   - every script sits under a `//-- group --` divider
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const scripts = pkg.scripts ?? {};

const errors = [];
const names = Object.keys(scripts);
const realNames = names.filter((n) => !n.startsWith("//--"));

// --- every script sits under a divider ------------------------------------
let sawDivider = false;
for (const name of names) {
  if (name.startsWith("//--")) {
    sawDivider = true;
    if (typeof scripts[name] !== "string" || scripts[name].trim() === "") {
      errors.push(`divider "${name}" has no description`);
    }
    continue;
  }
  if (!sawDivider) {
    errors.push(`script "${name}" appears before any "//-- group --" divider`);
  }
}

// --- targets resolve -------------------------------------------------------
for (const name of realNames) {
  const body = scripts[name];

  for (const match of body.matchAll(/\b(?:bash|node)\s+([\w./-]+\.(?:sh|mjs|js))/g)) {
    const target = match[1];
    if (!existsSync(join(repoRoot, target))) {
      errors.push(`script "${name}" runs "${target}", which does not exist`);
    }
  }

  for (const match of body.matchAll(/pnpm\s+-C\s+([\w./-]+)\s+([\w:-]+)/g)) {
    const [, dir, script] = match;
    const manifest = join(repoRoot, dir, "package.json");
    if (!existsSync(manifest)) {
      errors.push(`script "${name}" delegates to "${dir}", which has no package.json`);
      continue;
    }
    const workspace = JSON.parse(readFileSync(manifest, "utf8"));
    if (!workspace.scripts?.[script]) {
      errors.push(`script "${name}" delegates to "${dir}" script "${script}", which is not defined`);
    }
  }

  for (const match of body.matchAll(/pnpm\s+run\s+([\w:-]+)/g)) {
    const target = match[1];
    if (!realNames.includes(target)) {
      errors.push(`script "${name}" calls "pnpm run ${target}", which is not a root script`);
    }
  }
}

if (errors.length > 0) {
  console.error("✗ root package.json scripts");
  for (const error of errors) console.error(`    ${error}`);
  process.exit(1);
}

console.log(`✓ root package.json scripts: ${realNames.length} scripts, all targets resolve`);
