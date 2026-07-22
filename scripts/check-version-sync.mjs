#!/usr/bin/env node
// Guards against package.json and the plugin manifest's version drifting apart
// (#1238) — same drift-gate shape as check:node/check:wrangler-compat/gen:index:
// compare a derived value against a fixed source of truth, fail loud.
//
//   node scripts/check-version-sync.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PACKAGE = join(ROOT, 'package.json');
const PLUGIN = join(ROOT, 'plugins', 'sux', '.claude-plugin', 'plugin.json');

const pkgVersion = JSON.parse(readFileSync(PACKAGE, 'utf8')).version;
const pluginVersion = JSON.parse(readFileSync(PLUGIN, 'utf8')).version;

if (!pkgVersion) throw new Error(`${PACKAGE}: missing "version"`);
if (!pluginVersion) throw new Error(`${PLUGIN}: missing "version"`);

if (pkgVersion !== pluginVersion) {
  console.error(
    `version drift: package.json=${pkgVersion} vs plugins/sux/.claude-plugin/plugin.json=${pluginVersion}\n\nBump both together, then commit.`,
  );
  process.exit(1);
}

console.log(`OK — package.json and plugin.json both at ${pkgVersion}.`);
