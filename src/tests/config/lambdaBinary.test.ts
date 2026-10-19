import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createLambdaHandler, isBinaryResponse } from "../../lambda.ts";

/**
 * Binary responses through the Lambda adapter. A PDF must reach API Gateway
 * base64-encoded and decode to the exact bytes the app sent; text stays text.
 * No AWS: the handler is invoked directly with an HTTP API (v2) event.
 */

// Bytes above 0x7f are the ones a text conversion destroys.
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x33, 0x0a, 0x80, 0x9f, 0xc3, 0xff, 0x00, 0xe2, 0x82]);
const AUDIO = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]);

const app = express();
app.get("/report.pdf", (_req, res) => {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Length", PDF.length);
  res.end(PDF);
});
app.get("/recording", (_req, res) => {
  res.type("audio/webm").send(AUDIO);
});
app.get("/json", (_req, res) => {
  res.json({ status: "ok", name: "Café" });
});
app.get("/page", (_req, res) => {
  res.type("html").send("<p>Café</p>");
});

const handler = createLambdaHandler(app);

async function get(path: string) {
  const event = {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { host: "api.test", "accept-encoding": "gzip, deflate, br" },
    isBase64Encoded: false,
    requestContext: {
      stage: "$default",
      http: { method: "GET", path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "test" },
    },
  };
  const result: any = await handler(event as any, {} as any);
  const body = result.isBase64Encoded
    ? Buffer.from(result.body, "base64")
    : Buffer.from(result.body, "utf8");
  return { status: result.statusCode, isBase64Encoded: result.isBase64Encoded, body };
}

test("a PDF reaches API Gateway base64-encoded and byte-for-byte intact", async () => {
  const r = await get("/report.pdf");
  assert.equal(r.status, 200);
  assert.equal(r.isBase64Encoded, true);
  assert.ok(r.body.equals(PDF), "PDF bytes changed in transit");
});

test("audio is binary too", async () => {
  const r = await get("/recording");
  assert.equal(r.isBase64Encoded, true);
  assert.ok(r.body.equals(AUDIO), "audio bytes changed in transit");
});

test("JSON and HTML stay plain text", async () => {
  const json = await get("/json");
  assert.equal(json.isBase64Encoded, false);
  assert.deepEqual(JSON.parse(json.body.toString("utf8")), { status: "ok", name: "Café" });
  const page = await get("/page");
  assert.equal(page.isBase64Encoded, false);
  assert.equal(page.body.toString("utf8"), "<p>Café</p>");
});

test("only text content types without compression are sent as text", () => {
  const text = [
    "application/json; charset=utf-8",
    "application/problem+json",
    "application/xml",
    "image/svg+xml",
    "text/csv",
  ];
  for (const type of text) {
    assert.equal(isBinaryResponse({ headers: { "content-type": type } }), false, type);
  }
  const binary = ["application/pdf", "application/octet-stream", "image/png", "video/webm", ""];
  for (const type of binary) {
    assert.equal(isBinaryResponse({ headers: { "content-type": type } }), true, type || "(none)");
  }
  assert.equal(
    isBinaryResponse({ headers: { "content-type": "application/json", "content-encoding": "gzip" } }),
    true,
    "compressed text is binary",
  );
});
