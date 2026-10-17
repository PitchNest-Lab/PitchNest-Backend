#!/usr/bin/env node
// Verifies the BUILT PROD Lambda package (dist/pitchnest-api-prod.zip) — not
// the TypeScript sources — without any AWS access:
//
//   node scripts/verify-lambda-artifact.mjs [path/to/zip]
//
//  1. Extracts the zip (integrity: every CRC checked) into a temp directory
//     OUTSIDE the repo, so no repo node_modules can mask a missing dependency.
//  2. Starts a local fake SSM endpoint serving DUMMY values and runs the real
//     packaged handler (index.handler) against API Gateway v2 events, with the
//     PROD Lambda environment (NODE_ENV=production, PITCHNEST_ENV=prod, ...).
//  3. Runs PDF generation + PDF text extraction from the same layout.
// Exits non-zero on any failure. No secrets are used or printed.

import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZIP = path.resolve(process.argv[2] ?? path.join(ROOT, "dist", "pitchnest-api-prod.zip"));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "pitchnest-artifact-"));
const failures = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures.push(name);
};

// PROD Lambda environment as set by Terraform (non-secret).
const LAMBDA_ENV = {
  NODE_ENV: "production",
  PITCHNEST_ENV: "prod",
  CLIENT_URL: "https://www.pitchnest.app",
  ALLOWED_ORIGIN: "https://www.pitchnest.app",
  APP_BASE_URL: "https://www.pitchnest.app",
  AZURE_OPENAI_API_VERSION: "2026-07-09",
  PRO_PLAN_AMOUNT: "10",
  PRO_PLAN_CURRENCY: "USD",
  PRO_PLAN_DAYS: "30",
  BILLING_CHECKOUT_ENABLED: "false",
};
const REQUIRED = [
  "JWT_SECRET", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY",
  "GOOGLE_CLIENT_ID", "AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_DEPLOYMENT",
];
const DUMMY = {
  JWT_SECRET: "artifact-verify-dummy-jwt-secret",
  SUPABASE_URL: "http://127.0.0.1:9",
  SUPABASE_ANON_KEY: "dummy-anon",
  SUPABASE_SERVICE_ROLE_KEY: "dummy-service-role",
  RESEND_API_KEY: "re_dummy_artifact_verify",
  GOOGLE_CLIENT_ID: "dummy.apps.googleusercontent.com",
  AZURE_OPENAI_ENDPOINT: "https://dummy.openai.azure.com",
  AZURE_OPENAI_API_KEY: "dummy-azure-key",
  AZURE_OPENAI_DEPLOYMENT: "dummy-deployment",
};

try {
  // ── 1. Extract with CRC verification ──────────────────────────────────────
  const zip = fs.readFileSync(ZIP);
  const eocd = zip.length - 22;
  if (zip.readUInt32LE(eocd) !== 0x06054b50) throw new Error("zip: end-of-central-directory not found");
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  let crcFailures = 0;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error("zip: bad central directory entry");
    const method = zip.readUInt16LE(p + 10);
    const crc = zip.readUInt32LE(p + 16);
    const csize = zip.readUInt32LE(p + 20);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    const lNameLen = zip.readUInt16LE(localOffset + 26);
    const lExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = zip.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    if ((zlib.crc32 ? zlib.crc32(data) >>> 0 : crc) !== crc) crcFailures++;
    if (name.includes("..") || path.isAbsolute(name)) throw new Error(`zip: unsafe entry ${name}`);
    const dest = path.join(WORK, ...name.split("/"));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  check("zip integrity", crcFailures === 0, `${count} entries, extracted outside the repo`);
  check("layout: index.mjs shim + app/ + assets/ fonts", ["index.mjs", "app/index.mjs", "assets/fonts/Inter-Regular.ttf", "assets/fonts/Inter-Bold.ttf", "assets/logo.png"].every((f) => fs.existsSync(path.join(WORK, f))));
  check("no native canvas / unused native modules shipped", !["node_modules/@napi-rs", "node_modules/bcrypt", "node_modules/better-sqlite3"].some((d) => fs.existsSync(path.join(WORK, d))));
  const imgDir = path.join(WORK, "node_modules", "@img");
  const sharpBinaries = fs.existsSync(imgDir) ? fs.readdirSync(imgDir).filter((d) => d.startsWith("sharp-")) : [];
  check(
    "sharp ships the linux-x64 binary Lambda loads, and no other platform's",
    ["node_modules/sharp/package.json", "node_modules/@img/sharp-linux-x64/package.json", "node_modules/@img/sharp-libvips-linux-x64/package.json"].every((f) => fs.existsSync(path.join(WORK, f))) &&
      sharpBinaries.length === 2 &&
      sharpBinaries.every((d) => d.endsWith("-linux-x64")),
    sharpBinaries.join(", "),
  );

  // ── 2. Fake SSM + real handler ────────────────────────────────────────────
  const ssmRequests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const input = JSON.parse(body || "{}");
      ssmRequests.push({ target: req.headers["x-amz-target"], names: input.Names ?? [], decrypt: input.WithDecryption });
      const params = [];
      const invalid = [];
      for (const n of input.Names ?? []) {
        const key = n.replace(/^\/pitchnest\/prod\//, "");
        if (n.startsWith("/pitchnest/prod/") && DUMMY[key]) params.push({ Name: n, Type: "SecureString", Value: DUMMY[key], Version: 1 });
        else invalid.push(n);
      }
      res.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
      res.end(JSON.stringify({ Parameters: params, InvalidParameters: invalid }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const ssmUrl = `http://127.0.0.1:${server.address().port}`;

  const runner = `
const { handler } = await import("./index.mjs");
const ev = (method, p, headers = {}) => ({
  version: "2.0", routeKey: "$default", rawPath: p, rawQueryString: "",
  headers: { host: "artifact.test", ...headers },
  requestContext: { accountId: "000000000000", apiId: "artifact", domainName: "artifact.test", requestId: "req-" + Math.random(),
    http: { method, path: p, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "artifact-verify" },
    stage: "$default", time: new Date().toUTCString(), timeEpoch: Date.now() },
  isBase64Encoded: false,
});
const run = async (label, e) => {
  const r = await handler(e, { callbackWaitsForEmptyEventLoop: false });
  let json = null; try { json = JSON.parse(r.isBase64Encoded ? Buffer.from(r.body, "base64").toString() : r.body); } catch {}
  const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  console.log("RESULT " + JSON.stringify({ label, status: r.statusCode, json, acao: h["access-control-allow-origin"] ?? null }));
};
await run("health", ev("GET", "/api/health"));
await run("price", ev("GET", "/api/billing/price"));
await run("unknown", ev("GET", "/api/does-not-exist"));
await run("me-no-token", ev("GET", "/api/auth/me"));
await run("checkout-no-token", ev("POST", "/api/billing/checkout"));
await run("cors-allowed", ev("OPTIONS", "/api/auth/login", { origin: "https://www.pitchnest.app", "access-control-request-method": "POST" }));
await run("cors-apex", ev("OPTIONS", "/api/auth/login", { origin: "https://pitchnest.app", "access-control-request-method": "POST" }));
await run("cors-evil", ev("OPTIONS", "/api/auth/login", { origin: "https://evil.example", "access-control-request-method": "POST" }));
await run("health-warm", ev("GET", "/health"));
// sharp's binary is linux-x64: it can only be exercised on a matching host.
if (process.platform === "linux" && process.arch === "x64") {
  const sharp = (await import("sharp")).default;
  const out = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#000" } }).webp().toBuffer();
  console.log("SHARP " + JSON.stringify({ ok: out.length > 0 }));
} else {
  console.log("SHARP " + JSON.stringify({ skipped: process.platform + "-" + process.arch }));
}
process.exit(0);
`;
  fs.writeFileSync(path.join(WORK, "verify-runner.mjs"), runner);

  const isolatedEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
    ...LAMBDA_ENV,
    AWS_REGION: "eu-west-2",
    AWS_ACCESS_KEY_ID: "AKIAARTIFACTVERIFY",
    AWS_SECRET_ACCESS_KEY: "artifact-verify-dummy",
    AWS_ENDPOINT_URL_SSM: ssmUrl,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_CONFIG_FILE: path.join(WORK, "no-aws-config"),
    AWS_SHARED_CREDENTIALS_FILE: path.join(WORK, "no-aws-credentials"),
    AWS_LAMBDA_FUNCTION_NAME: "pitchnest-prod-api",
  };
  const child = await new Promise((resolve) => {
    // Async spawn so the in-process fake SSM server can answer.
    import("node:child_process").then(({ spawn }) => {
      const c = spawn(process.execPath, ["verify-runner.mjs"], { cwd: WORK, env: isolatedEnv });
      let stdout = "", stderr = "";
      c.stdout.on("data", (d) => (stdout += d));
      c.stderr.on("data", (d) => (stderr += d));
      c.on("close", (code) => resolve({ code, stdout, stderr }));
    });
  });
  server.close();

  const results = Object.fromEntries(
    child.stdout.split("\n").filter((l) => l.startsWith("RESULT ")).map((l) => JSON.parse(l.slice(7))).map((r) => [r.label, r]),
  );
  check("packaged handler ran", child.code === 0 && Object.keys(results).length === 9, child.code !== 0 ? child.stderr.split("\n").slice(-6).join(" | ") : "");
  check("GET /api/health -> 200", results.health?.status === 200 && results.health?.json?.status === "ok");
  const price = results.price?.json;
  const proMonthly = price?.catalog?.find((c) => c.plan === "pro" && c.term === "monthly");
  check("GET /api/billing/price -> billingEnabled=false", results.price?.status === 200 && price?.billingEnabled === false);
  check("Pro monthly priced USD 10 for 30 days", proMonthly?.amount === 10 && proMonthly?.currency === "USD" && proMonthly?.days === 30 && price?.price?.amount === 10);
  check("unknown route -> 404 JSON", results.unknown?.status === 404 && !!results.unknown?.json);
  check("protected route without token -> 401", results["me-no-token"]?.status === 401);
  check("checkout without token -> 401", results["checkout-no-token"]?.status === 401);
  check("CORS allows https://www.pitchnest.app", [200, 204].includes(results["cors-allowed"]?.status) && results["cors-allowed"]?.acao === "https://www.pitchnest.app");
  // Browser origins come only from ALLOWED_ORIGIN and CORS_EXTRA_ORIGINS. The
  // apex redirects to www, so it is refused unless CORS_EXTRA_ORIGINS lists it.
  check("CORS refuses https://pitchnest.app unless configured", !results["cors-apex"]?.acao);
  const sharpLine = child.stdout.split("\n").find((l) => l.startsWith("SHARP "));
  const sharpResult = sharpLine ? JSON.parse(sharpLine.slice(6)) : null;
  if (sharpResult?.skipped) {
    console.log(`SKIP  sharp image round-trip (needs a linux-x64 host; this is ${sharpResult.skipped})`);
  } else {
    check("sharp loads and encodes an image inside the package", sharpResult?.ok === true);
  }
  check("CORS refuses unlisted origin (production mode)", results["cors-evil"]?.status === 403 && !results["cors-evil"]?.acao);
  const names = ssmRequests.flatMap((r) => r.names);
  check("SSM: exactly one GetParameters call across cold + warm invocations", ssmRequests.length === 1 && ssmRequests[0].target === "AmazonSSM.GetParameters");
  check("SSM: the nine /pitchnest/prod/ names, decrypted, no Flutterwave", ssmRequests[0]?.decrypt === true && names.length === 9 && REQUIRED.every((n) => names.includes(`/pitchnest/prod/${n}`)) && !names.some((n) => n.includes("FLW")));
  check("SSM values never printed", !child.stdout.includes("dummy-service-role") && !child.stderr.includes("dummy-service-role"));

  // ── 3. PDF generation + extraction inside the package layout ──────────────
  await esbuild.build({
    absWorkingDir: ROOT,
    entryPoints: ["src/tests/artifact/artifact-smoke.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "esm",
    outfile: path.join(WORK, "app", "artifact-smoke.mjs"),
    external: ["pdfkit", "pdf-parse", "bcrypt", "better-sqlite3"],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    logLevel: "warning",
  });
  const smoke = spawnSync(process.execPath, [path.join("app", "artifact-smoke.mjs")], {
    cwd: WORK,
    env: { ...isolatedEnv, ...DUMMY },
    encoding: "utf8",
    timeout: 120000,
  });
  const line = (smoke.stdout || "").split("\n").find((l) => l.startsWith("ARTIFACT_SMOKE "));
  const s = line ? JSON.parse(line.slice(15)) : { ok: false, error: (smoke.stderr || "").slice(-400) };
  check("pdfkit and pdf-parse resolve from the package's node_modules", s.pdfkitResolvedInsidePackage === true && s.pdfParseResolvedInsidePackage === true);
  check("H2 fixed: session report PDF generated with Inter fonts", s.ok === true && s.reportIsPdf === true && s.reportEmbedsInterFont === true, `bytes=${s.reportBytes ?? "n/a"}`);
  check("H2 fixed: deck audit PDF generated", s.auditIsPdf === true);
  check("H3 fixed: PDF text extracted", (s.extractedChars ?? 0) > 100 && (s.extractedPages ?? 0) >= 1 && s.extractedContainsBusinessName === true, `chars=${s.extractedChars ?? 0} pages=${s.extractedPages ?? 0}${s.error ? " error=" + s.error : ""}`);
} catch (err) {
  check("verification harness", false, String(err?.message || err));
} finally {
  fs.rmSync(WORK, { recursive: true, force: true });
}

console.log(failures.length ? `\nARTIFACT VERIFICATION FAILED (${failures.length})` : "\nARTIFACT VERIFICATION PASSED");
process.exit(failures.length ? 1 : 0);
