import { handler } from "./dist/lambda/index.mjs";

function makeEvent(method, path, body) {
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: path,
    rawQueryString: "",
    headers: { "content-type": "application/json", host: "localhost" },
    requestContext: {
      http: { method, path, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "local-test" },
      stage: "$default",
    },
    body: body ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  };
}

// 1. Health check
const health = await handler(makeEvent("GET", "/api/health"), {});
console.log("HEALTH:", health.statusCode, health.body);

// 2. A protected route without a token (should be 401, not 500)
const protectedRoute = await handler(makeEvent("GET", "/api/profile"), {});
console.log("PROTECTED (no token):", protectedRoute.statusCode, protectedRoute.body);

// 3. Unknown route (should be 404 JSON)
const missing = await handler(makeEvent("GET", "/api/does-not-exist"), {});
console.log("NOT FOUND:", missing.statusCode, missing.body);

process.exit(0);
