import { runTrialLifecycleSweep } from "./trialLifecycle.ts";

try {
  const result = await runTrialLifecycleSweep();
  console.log(JSON.stringify({ job: "trial-lifecycle", ...result }));
  if (result.failed > 0) process.exitCode = 1;
} catch (error) {
  console.error("Trial lifecycle job failed:", error);
  process.exitCode = 1;
}
