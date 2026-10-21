# Live-pitch performance plan

## Goal

Keep the live room warm and make response latency predictable while several founders pitch at the same time.

The target is not literal zero latency. The first release target is:

- warm WebSocket connection: p95 below 500 ms;
- first transcript after end-of-speech: p95 below 500 ms;
- first model token: p95 below 1.5 s;
- first spoken audio: p95 below 3 s;
- no user-visible cold start after 15+ minutes without traffic.

Targets are provisional until the staged load test produces real baselines.

## Deployment shape

- Keep the REST API on Lambda initially.
- Run the live WebSocket server on an always-on ECS/Fargate service behind an ALB in `eu-west-2`.
- Keep two warm production tasks once shared session state is ready; use one task only for the first DEV smoke test.
- Keep Render running temporarily as a rollback path during the AWS cutover.
- Move report/PDF generation, deck analysis, research and trial emails away from the live WebSocket process.
- Use shared state for resume grants and global admission limits before routing production traffic to multiple tasks.

## Acceptance gates

1. The AWS live-pitch service has two warm production tasks, an ALB health check on `/health`, and no scale-to-zero path.
2. The staged load test is run against DEV at 1, 3, 5, 10 and then higher concurrent sessions.
3. Every stage records first-token, first-audio, reply p95, CPU, memory, provider errors and event-loop pressure.
4. Azure OpenAI, Speech and TTS quotas are confirmed for the target concurrency.
5. A deploy or restart does not silently lose active sessions; graceful draining and reconnect behavior are tested.
6. Horizontal scaling is blocked until resume grants, active-session limits and reconnect ownership are shared across instances.

## Code work after the baseline

- Add graceful WebSocket draining instead of immediately closing every socket on `SIGTERM`.
- Move trial lifecycle execution out of every live server instance.
- Move resume grants and global connection/admission state to shared storage before horizontal scaling.
- Prefer binary WebSocket audio frames over base64 JSON audio payloads.
- Keep the existing streaming STT, streamed model response, TTS prewarming and first-token/first-audio timing logs.

## Safety

This plan does not authorize a production release, database migration, secret change or Render/AWS setting change. Test accounts and live provider load must be approved before running the external load test.
