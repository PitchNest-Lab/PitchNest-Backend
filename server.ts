import dns from "dns";
dns.setDefaultResultOrder("ipv4first");
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { config } from "./src/config/env.ts";
import app from "./src/app.ts";
import { initRestSocket } from "./src/sockets/restSocket.ts";
import { checkApiKeyStatus } from "./src/services/aiService.ts";
import { checkTtsStatus } from "./src/services/ttsService.ts";
import { startTrialLifecycleJob } from "./src/jobs/trialLifecycle.ts";

const server = createServer(app);
const wss = new WebSocketServer({ server });

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