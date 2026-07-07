#!/usr/bin/env node
// Single source of truth for the residential-node deploy artifact. The installer
// `root@192.168.1.1` embeds node/server.mjs as a base64 blob; this regenerates
// that blob from server.mjs so the two can never silently diverge (the exact
// drift that let the binary-egress bug ship). `--check` verifies they match
// (CI drift gate) without writing.
//
//   node sux/node/build-deploy.mjs           # regenerate the blob in place
//   node sux/node/build-deploy.mjs --check   # exit 1 if the blob is stale

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // sux/node
const serverPath = resolve(here, "server.mjs");
const deployPath = resolve(here, "../..", "root@192.168.1.1"); // repo root

const server = readFileSync(serverPath);
const blob = server.toString("base64");
const deploy = readFileSync(deployPath, "utf8");

const MARKERS = /(<<'B64_EOF'\n)[\s\S]*?(\nB64_EOF)/;
if (!MARKERS.test(deploy)) {
	console.error(`build-deploy: B64_EOF markers not found in ${deployPath}`);
	process.exit(2);
}
const next = deploy.replace(MARKERS, (_m, open, close) => open + blob + close);

// Self-check: the blob we just wrote must decode back to server.mjs byte-for-byte.
const roundTrip = Buffer.from(MARKERS.exec(next)[0].split("\n").slice(1, -1).join("\n"), "base64");
if (!roundTrip.equals(server)) {
	console.error("build-deploy: round-trip mismatch — refusing to emit a corrupt blob");
	process.exit(2);
}

if (process.argv.includes("--check")) {
	if (next !== deploy) {
		console.error("build-deploy: DRIFT — root@192.168.1.1 blob is stale.\n  Run: node sux/node/build-deploy.mjs");
		process.exit(1);
	}
	console.log("build-deploy: deploy blob is in sync with server.mjs");
} else {
	writeFileSync(deployPath, next);
	console.log(`build-deploy: regenerated deploy blob from server.mjs (${server.length} bytes)`);
}
