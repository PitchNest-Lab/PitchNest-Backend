import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./src/config/env.ts";
import app from "./src/app.ts";
import { initRestSocket } from "./src/sockets/restSocket.ts";
import { checkApiKeyStatus } from "./src/services/aiService.ts";
import { checkTtsStatus } from "./src/services/ttsService.ts";

const server = createServer(app);
const wss = new WebSocketServer({ server });

// 1. Catch errors on the WebSocket server instance itself
wss.on("error", (error) => {
  console.error("🚨 [WSS SERVER ERROR]:", error);
});

// Bind WebSocket router proxy
initRestSocket(wss);

// 2. Wrap startup tasks in try...catch
server.listen(config.port, "0.0.0.0", async () => {
  console.log(`\n🚀 PITCHNEST BRAIN IS ONLINE (MODULAR HIGH-PERFORMANCE PROD STANDARD)`);
  console.log(`📡 Listening on PORT ${config.port}\n`);
  
  try {
    await checkApiKeyStatus();
    await checkTtsStatus();
  } catch (err) {
    console.error("⚠️ Error during API/TTS startup checks:", err);
  }
});

// 3. Global safety nets so unhandled errors don't crash Node silently
process.on("uncaughtException", (err) => {
  console.error("🚨 [CRITICAL UNCAUGHT EXCEPTION]:", err);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("🚨 [UNHANDLED REJECTION] at:", promise, "reason:", reason);
});