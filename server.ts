import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./src/config/env.ts";
import app from "./src/app.ts";
import { initRestSocket } from "./src/sockets/restSocket.ts";
import { checkApiKeyStatus } from "./src/services/aiService.ts";

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Bind WebSocket router proxy
initRestSocket(wss);

// Boot server on 0.0.0.0 to enable access inside local Docker/IPv4 routers if needed
server.listen(config.port, "0.0.0.0", async () => {
  console.log(`\n🚀 PITCHNEST BRAIN IS ONLINE (MODULAR HIGH-PERFORMANCE PROD STANDARD)`);
  console.log(`📡 Listening on PORT ${config.port}\n`);
  
  // Proactively check Gemini API health
  await checkApiKeyStatus();
});