import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { createServer } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { config } from "./src/config/env.ts";
import { isAllowedBrowserOrigin } from "./src/config/origins.ts";
import app from "./src/app.ts";
import { initRestSocket } from "./src/sockets/restSocket.ts";
import { checkApiKeyStatus } from "./src/services/aiService.ts";
import { checkTtsStatus } from "./src/services/ttsService.ts";
import { startTrialLifecycleJob } from "./src/jobs/trialLifecycle.ts";

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Audio arrives as small PCM chunks and application JSON is tightly bounded.
  // One MiB is far above a legitimate frame while preventing ws's historical
  // 100 MiB default from becoming a one-message heap exhaustion primitive.
  maxPayload: 1024 * 1024,
  perMessageDeflate: false,
  // Keep the JWT out of the URL: the browser offers it as another protocol,
  // while the server echoes only this fixed application protocol.
  handleProtocols: (protocols) =>
    protocols.has("pitchnest-v1") ? "pitchnest-v1" : false,
  verifyClient: ({ origin }, done) => {
    // Native/mobile and server clients may omit Origin. Browser clients always
    // send it and must match the same explicit allowlist as HTTP CORS.
    if (!origin || isAllowedBrowserOrigin(origin)) return done(true);
    return done(false, 403, "Origin not allowed");
  },
});

type HeartbeatSocket = WebSocket & { isAlive?: boolean };
wss.on("connection", (socket: HeartbeatSocket) => {
  socket.isAlive = true;
  socket.on("pong", () => {
    socket.isAlive = true;
  });
});

const heartbeat = setInterval(() => {
  for (const socket of wss.clients as Set<HeartbeatSocket>) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);
heartbeat.unref?.();
server.on("close", () => clearInterval(heartbeat));

// Bind WebSocket router proxy
initRestSocket(wss);

// Trial reminder emails (T-7 / T-3 / T-1, plus one when the trial ends). Runs
// on an in-process timer — production only unless TRIAL_JOBS_ENABLED is set
// explicitly, so a laptop pointed at the shared database cannot email founders.
// The first sweep is delayed so it never competes with a cold start.
startTrialLifecycleJob();

// Boot server on 0.0.0.0 to enable access inside local Docker/IPv4 routers if needed
server.listen(config.port, "0.0.0.0", async () => {
  console.log(`\n🚀 PITCHNEST BRAIN IS ONLINE (MODULAR HIGH-PERFORMANCE PROD STANDARD)`);
  console.log(`📡 Listening on PORT ${config.port}\n`);
  
  await checkApiKeyStatus();
  await checkTtsStatus();
});

let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received; draining HTTP and WebSocket connections.`);
  for (const socket of wss.clients) socket.close(1012, "Service restarting");
  wss.close();
  server.close((error) => {
    if (error) console.error("Server shutdown error:", error);
    process.exit(error ? 1 : 0);
  });
  const forcedExit = setTimeout(() => process.exit(1), 25_000);
  forcedExit.unref?.();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
