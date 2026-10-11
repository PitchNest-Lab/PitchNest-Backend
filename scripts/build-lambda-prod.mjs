#!/usr/bin/env node
// Builds the PROD Lambda deployment package for the Express REST API.
//
//   node scripts/build-lambda-prod.mjs
//
// Output (git-ignored):
//   dist/lambda-prod/                    staging directory (exact zip contents)
//   dist/pitchnest-api-prod.zip          deployment package (deterministic)
//   dist/pitchnest-api-prod.manifest.json  commit, sha256, sizes, layout
//
// Layout inside the zip:
//   index.mjs          shim: export { handler } from "./app/index.mjs"
//                      (keeps the Lambda handler "index.handler" unchanged)
//   app/index.mjs      esbuild bundle of src/lambda.ts (the existing adapter)
//   assets/            fonts + logos; pdfService resolves <app>/../assets
//   node_modules/      ONLY packages that break when bundled:
//                        pdfkit   (reads its AFM font data via __dirname)
//                        pdf-parse (pdfjs needs real module files/workers)
//                      plus their dependency closure, pruned.
//
// The DEV build (build-lambda.sh) is intentionally untouched.

import * as esbuild from "esbuild";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const STAGE = path.join(DIST, "lambda-prod");
const ZIP = path.join(DIST, "pitchnest-api-prod.zip");
const MANIFEST = path.join(DIST, "pitchnest-api-prod.manifest.json");

/** Packages shipped as real node_modules instead of being bundled. */
const RUNTIME_PACKAGES = ["pdfkit", "pdf-parse"];
/** Never shipped: unused native modules / platform-specific binaries. */
const EXCLUDED_PACKAGES = new Set(["@napi-rs/canvas", "bcrypt", "better-sqlite3"]);
/** Externals for esbuild: shipped packages + excluded native modules. */
const EXTERNALS = [...RUNTIME_PACKAGES, "bcrypt", "better-sqlite3"];
/** Per-package top-level directories that the Node runtime never loads. */
const PRUNE_DIRS = {
  "pdfjs-dist": ["build", "web", "types", "image_decoders"],
};
const PRUNE_FILE = /\.(map|d\.ts|d\.cts|d\.mts|md|markdown)$/i;
const PRUNE_SEGMENT = new Set(["test", "tests", "__tests__", "docs", "example", "examples", ".github"]);

const log = (...a) => console.log("[build-lambda-prod]", ...a);

// ── 1. Clean ────────────────────────────────────────────────────────────────
fs.rmSync(STAGE, { recursive: true, force: true });
fs.rmSync(ZIP, { force: true });
fs.mkdirSync(path.join(STAGE, "app"), { recursive: true });

// ── 2. Bundle the existing adapter (src/lambda.ts) ──────────────────────────
const result = await esbuild.build({
  absWorkingDir: ROOT,
  entryPoints: ["src/lambda.ts"],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: path.join(STAGE, "app", "index.mjs"),
  external: EXTERNALS,
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});
if (result.errors.length) throw new Error("esbuild failed");

fs.writeFileSync(
  path.join(STAGE, "index.mjs"),
  "// Lambda entry point (handler: index.handler). The bundle lives in app/ so\n" +
    "// that pdfService resolves its assets at <app>/../assets.\n" +
    'export { handler } from "./app/index.mjs";\n',
);

// ── 3. Assets (fonts, logos) ────────────────────────────────────────────────
fs.cpSync(path.join(ROOT, "src", "assets"), path.join(STAGE, "assets"), { recursive: true });

// ── 4. Runtime packages + dependency closure ────────────────────────────────
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir || !parent.startsWith(ROOT)) return null;
    dir = parent;
  }
}

const shipped = new Map(); // absolute dir -> package name
const queue = RUNTIME_PACKAGES.map((name) => ({ name, from: ROOT, optional: false }));
while (queue.length) {
  const { name, from, optional } = queue.shift();
  if (EXCLUDED_PACKAGES.has(name)) continue;
  const dir = findPackageDir(name, from);
  if (!dir) {
    if (optional) continue;
    throw new Error(`Required runtime dependency not installed: ${name} (needed from ${path.relative(ROOT, from) || "."})`);
  }
  if (shipped.has(dir)) continue;
  shipped.set(dir, name);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, optional: false });
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, optional: true });
}

for (const [dir, name] of shipped) {
  const rel = path.relative(ROOT, dir);
  const prune = new Set(PRUNE_DIRS[name] ?? []);
  fs.cpSync(dir, path.join(STAGE, rel), {
    recursive: true,
    filter: (src) => {
      const inner = path.relative(dir, src);
      if (!inner) return true;
      const parts = inner.split(path.sep);
      if (parts.includes("node_modules")) return false; // nested deps are copied via the closure
      if (prune.has(parts[0])) return false;
      if (parts.some((p) => PRUNE_SEGMENT.has(p.toLowerCase()))) return false;
      return !PRUNE_FILE.test(src);
    },
  });
}

// ── 5. Deterministic zip (UNIX 0644 entries, fixed timestamp, sorted) ───────
function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const crc32 =
  typeof zlib.crc32 === "function"
    ? (buf) => zlib.crc32(buf) >>> 0
    : (() => {
        const table = new Uint32Array(256).map((_, n) => {
          let c = n;
          for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
          return c >>> 0;
        });
        return (buf) => {
          let c = 0xffffffff;
          for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
          return (c ^ 0xffffffff) >>> 0;
        };
      })();

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01
const files = listFiles(STAGE)
  .map((full) => ({ full, name: path.relative(STAGE, full).split(path.sep).join("/") }))
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

const chunks = [];
const central = [];
let offset = 0;
let uncompressedTotal = 0;
for (const { full, name } of files) {
  const data = fs.readFileSync(full);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  const useDeflate = deflated.length < data.length;
  const body = useDeflate ? deflated : data;
  const crc = crc32(data);
  const nameBuf = Buffer.from(name, "utf8");
  uncompressedTotal += data.length;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(useDeflate ? 8 : 0, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  chunks.push(local, nameBuf, body);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE((3 << 8) | 20, 4); // made by UNIX
  cen.writeUInt16LE(20, 6);
  cen.writeUInt16LE(0x0800, 8);
  cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
  cen.writeUInt16LE(DOS_TIME, 12);
  cen.writeUInt16LE(DOS_DATE, 14);
  cen.writeUInt32LE(crc, 16);
  cen.writeUInt32LE(body.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nameBuf.length, 28);
  cen.writeUInt16LE(0, 30);
  cen.writeUInt16LE(0, 32);
  cen.writeUInt16LE(0, 34);
  cen.writeUInt16LE(0, 36);
  cen.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
  cen.writeUInt32LE(offset, 42);
  central.push(cen, nameBuf);

  offset += local.length + nameBuf.length + body.length;
}
if (files.length > 0xffff) throw new Error("Too many files for a non-ZIP64 archive");
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zipBuf = Buffer.concat([...chunks, centralBuf, end]);
fs.writeFileSync(ZIP, zipBuf);

// ── 6. Manifest (traceability; no secrets) ──────────────────────────────────
const sha256 = crypto.createHash("sha256").update(zipBuf).digest("base64");
let commit = "unknown";
let dirty = null;
try {
  commit = execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
  dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim().length > 0;
} catch {}
const manifest = {
  artifact: path.relative(ROOT, ZIP).split(path.sep).join("/"),
  sha256_base64: sha256, // equals Lambda's CodeSha256 after upload
  zipBytes: zipBuf.length,
  uncompressedBytes: uncompressedTotal,
  fileCount: files.length,
  handler: "index.handler",
  runtime: "nodejs22.x",
  gitCommit: commit,
  gitDirty: dirty,
  bundledEntry: "src/lambda.ts",
  externals: EXTERNALS,
  shippedPackages: [...shipped.values()].sort(),
  excludedPackages: [...EXCLUDED_PACKAGES],
  builtWith: { node: process.versions.node, esbuild: esbuild.version },
};
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

log(`zip:     ${manifest.artifact} (${(zipBuf.length / 1048576).toFixed(2)} MiB, ${files.length} files, ${(uncompressedTotal / 1048576).toFixed(2)} MiB unzipped)`);
log(`sha256:  ${sha256}`);
log(`commit:  ${commit}${dirty ? " (working tree has uncommitted changes)" : ""}`);
log(`shipped: ${manifest.shippedPackages.join(", ")}`);
if (zipBuf.length > 50 * 1048576) throw new Error("Package exceeds the 50 MiB direct-upload limit");
if (uncompressedTotal > 250 * 1048576) throw new Error("Package exceeds the 250 MiB unzipped limit");
