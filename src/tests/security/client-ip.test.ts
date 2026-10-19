import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveClientIp } from "../../utils/clientIp.ts";

test("uses the direct peer unless the deployment trusts one proxy", () => {
  assert.equal(resolveClientIp("198.51.100.8", "127.0.0.1", false), "127.0.0.1");
});

test("uses the proxy-observed right-most forwarded address", () => {
  assert.equal(
    resolveClientIp("203.0.113.44, 198.51.100.8", "10.0.0.5", true),
    "198.51.100.8",
  );
});

test("does not accept a spoofed first address or malformed final hop", () => {
  assert.equal(
    resolveClientIp("192.0.2.99, not-an-ip", "10.0.0.5", true),
    "10.0.0.5",
  );
});

test("supports IPv6 and repeated forwarded headers", () => {
  assert.equal(
    resolveClientIp(["192.0.2.10", "2001:db8::7"], "10.0.0.5", true),
    "2001:db8::7",
  );
});
