// Live-room load test. Runs simulated founders through complete pitch sessions
// at the same time: connect, greeting, spoken answers streamed as real-time
// 16 kHz PCM, panel replies, verdicts and the scored report. It reports the
// waits each founder would have felt. Stages run one after another (e.g. 1,
// then 5, then 10 concurrent sessions) so the point where latency starts to
// climb is visible.
//
// Each simulated founder behaves like the browser in LivePitchRoom.tsx: it
// streams mic frames (speech, then silence) only while the panel is quiet,
// stops while panel audio "plays" for its real length, waits the 700 ms echo
// guard plus a human pause, then gives its next answer. After the last answer
// it requests verdicts and ends the session the way the End button does.
//
// Every session spends real Azure Speech and Azure OpenAI usage and writes a
// session row to the database. Nothing runs without --yes.
//
// Usage (from backend/):
//   powershell -File scripts/loadtest/makeAudio.ps1
//   npx tsx scripts/loadtest/users.ts seed --count 10
//   npx tsx scripts/loadtest/liveRoom.ts --stages 1,5,10 --server-port 3000 --yes
//   npx tsx scripts/loadtest/users.ts cleanup
//
// Options:
//   --url ws://localhost:3000/ws   live-room socket of the backend under test
//   --stages 1,3,5                 concurrent sessions per stage, run in order
//   --turns 5                      founder answers per session
//   --stagger 20                   seconds over which a stage's sessions start
//   --mode panel                   panel | coach
//   --auth mint                    mint: sign tokens with JWT_SECRET from .env
//                                  login: POST /api/auth/login (the server
//                                  allows 20 logins per 15 min per IP; tokens
//                                  are cached in out/users.json)
//   --server-port 3000             sample CPU and memory of the local process
//                                  listening on this port
//   --turn-timeout 60              seconds to wait for a panel reply
//   --report-timeout 300           seconds to wait for the report after End
//   --yes                          actually run
import "dotenv/config";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { readUsers, USERS_FILE, type LoadTestUser } from "./users.ts";

const execFileAsync = promisify(execFile);
const OUT_DIR = path.resolve(import.meta.dirname, "out");
const AUDIO_DIR = path.join(OUT_DIR, "audio");

// Matches frontend/public/pcm-processor.js: 1024 samples of 16 kHz PCM16.
const FRAME_BYTES = 2048;
const FRAME_MS = 64;
// Panel audio arrives as Raw24Khz16BitMonoPcm (ttsService.ts).
const TTS_BYTES_PER_MS = 48;
// The browser keeps the mic closed this long after panel audio ends.
const ECHO_GUARD_MS = 700;
// The browser stops waiting for verdicts after 45 s (triggerVerdictPhase).
const VERDICT_WAIT_MS = 45_000;
// restSocket.ts allows 50 live sockets per IP; one machine cannot exceed it.
const MAX_SOCKETS_PER_IP = 50;
const SILENCE = Buffer.alloc(FRAME_BYTES);

// Error codes after which the server closes the socket.
const FATAL_CODES = new Set([
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "AUTH_REVOKED",
  "CONNECTION_LIMIT",
  "TOO_MANY_SESSIONS",
  "USER_DELETED",
  "EMAIL_NOT_VERIFIED",
  "PLAN_QUOTA_EXCEEDED",
  "PITCH_ATTEMPT_LIMIT",
  "ADMISSION_TEMPORARILY_UNAVAILABLE",
  "CLIENT_READY_TIMEOUT",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMIT",
]);

interface Options {
  url: string;
  stages: number[];
  turns: number;
  stagger: number;
  mode: "panel" | "coach";
  auth: "mint" | "login";
  serverPort: number | null;
  turnTimeoutMs: number;
  reportTimeoutMs: number;
  yes: boolean;
}

interface SessionResult {
  stage: number;
  index: number;
  userId: number;
  ok: boolean;
  failure?: string;
  connectMs?: number;
  greetingMs?: number;
  /** Founder stops talking → first panel audio. The wait a founder feels. */
  replyMs: number[];
  /** Founder stops talking → their words echoed back by speech-to-text. */
  sttEchoMs: number[];
  noReply: number;
  /** Of noReply: answers speech-to-text never returned, so the panel never heard them. */
  untranscribed: number;
  /** On-screen answer tips received (one is attempted per panel question). */
  tips: number;
  earlyReplies: number;
  abortedTurns: number;
  verdictMs?: number;
  reportMs?: number;
  evaluationStatus?: string;
  errors: string[];
  closeCode?: number;
  speechSentSec: number;
  audioSentSec: number;
  ttsReceivedSec: number;
  panelTurns: number;
  maxBufferedBytes: number;
  totalSec: number;
}

function parseOptions(argv: string[]): Options {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[argv[i].slice(2)] = "true";
    } else {
      args[argv[i].slice(2)] = next;
      i++;
    }
  }
  const stages = (args.stages || "1,3,5").split(",").map(Number);
  if (stages.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_SOCKETS_PER_IP)) {
    throw new Error(`--stages must be whole numbers from 1 to ${MAX_SOCKETS_PER_IP}`);
  }
  return {
    url: args.url || "ws://localhost:3000/ws",
    stages,
    turns: Math.max(1, Number(args.turns || 5)),
    stagger: Math.max(0, Number(args.stagger || 20)),
    mode: args.mode === "coach" ? "coach" : "panel",
    auth: args.auth === "login" ? "login" : "mint",
    serverPort: args["server-port"] ? Number(args["server-port"]) : null,
    turnTimeoutMs: Number(args["turn-timeout"] || 60) * 1000,
    reportTimeoutMs: Number(args["report-timeout"] || 300) * 1000,
    yes: args.yes === "true",
  };
}

function httpBaseFor(wsUrl: string): string {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.origin;
}

/** Returns the PCM samples of a 16 kHz mono 16-bit WAV file. */
function readWavPcm(file: string): Buffer {
  const buf = fs.readFileSync(file);
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${file} is not a WAV file`);
  }
  let format: { channels: number; rate: number; bits: number } | null = null;
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      format = {
        channels: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format || format.rate !== 16000 || format.bits !== 16 || format.channels !== 1) {
        throw new Error(`${file} must be 16 kHz, 16-bit, mono`);
      }
      return buf.subarray(body, Math.min(body + size, buf.length));
    }
    offset = body + size + (size % 2);
  }
  throw new Error(`${file} has no audio data`);
}

function loadClips(): Buffer[] {
  const files = fs.existsSync(AUDIO_DIR)
    ? fs.readdirSync(AUDIO_DIR).filter((f) => f.toLowerCase().endsWith(".wav")).sort()
    : [];
  if (files.length === 0) {
    throw new Error(`No founder audio in ${AUDIO_DIR}. Run: powershell -File scripts/loadtest/makeAudio.ps1`);
  }
  return files.map((f) => readWavPcm(path.join(AUDIO_DIR, f)));
}

async function tokenFor(user: LoadTestUser, opts: Options, httpBase: string): Promise<string> {
  if (opts.auth === "mint") {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error("JWT_SECRET is not set in backend/.env; use --auth login");
    // Same claims as signToken() in authController.ts, checked by accessToken.ts.
    return jwt.sign(
      { kind: "access", id: user.id, rememberMe: false, accountType: "user", authVersion: user.authVersion },
      secret,
      { algorithm: "HS256", issuer: "pitchnest", audience: "pitchnest-web", expiresIn: "6h" },
    );
  }
  const cached = user.token ? (jwt.decode(user.token) as { exp?: number } | null) : null;
  if (user.token && cached?.exp && cached.exp * 1000 > Date.now() + 60 * 60 * 1000) {
    return user.token;
  }
  const res = await fetch(`${httpBase}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password, rememberMe: true }),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.token !== "string") {
    throw new Error(`Login failed for ${user.email}: HTTP ${res.status} ${body.error || body.message || ""}`);
  }
  user.token = body.token;
  return body.token;
}

class SimSession {
  readonly result: SessionResult;
  private ws!: WebSocket;
  private phase: "connecting" | "pitching" | "verdict" | "ending" | "done" = "connecting";
  private startedAt = 0;
  private clientReadyAt = 0;
  private verdictRequestedAt = 0;
  private endSentAt = 0;
  private micOpen = false;
  private nextFrameAt = 0;
  private clip: Buffer | null = null;
  private clipPos = 0;
  private answersGiven = 0;
  private founderStoppedAt: number | null = null;
  private awaitingReply = false;
  private echoSeen = false;
  private greetingPending = false;
  private panelSpeaking = false;
  private playEndAt = 0;
  private resumeTimer: NodeJS.Timeout | null = null;
  private replyTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private timers = new Set<NodeJS.Timeout>();
  private resolveDone: (result: SessionResult) => void = () => {};

  constructor(
    private readonly opts: Options,
    private readonly clips: Buffer[],
    private readonly token: string,
    stage: number,
    private readonly index: number,
    userId: number,
  ) {
    this.result = {
      stage,
      index,
      userId,
      ok: false,
      replyMs: [],
      sttEchoMs: [],
      noReply: 0,
      untranscribed: 0,
      tips: 0,
      earlyReplies: 0,
      abortedTurns: 0,
      errors: [],
      speechSentSec: 0,
      audioSentSec: 0,
      ttsReceivedSec: 0,
      panelTurns: 0,
      maxBufferedBytes: 0,
      totalSec: 0,
    };
  }

  run(): Promise<SessionResult> {
    return new Promise((resolve) => {
      this.resolveDone = resolve;
      this.startedAt = Date.now();
      // Same subprotocol handshake as SocketContext.tsx.
      this.ws = new WebSocket(this.opts.url, ["pitchnest-v1", `pitchnest-auth.${this.token}`]);
      this.ws.on("open", () => {
        this.result.connectMs = Date.now() - this.startedAt;
      });
      this.ws.on("message", (raw, isBinary) => {
        if (isBinary) return;
        let msg: any;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        this.onMessage(msg);
      });
      this.ws.on("close", (code, reason) => {
        this.result.closeCode = code;
        const why = reason.toString();
        this.finish(false, `closed ${code}${why ? ` (${why})` : ""}`);
      });
      this.ws.on("error", (err) => {
        this.result.errors.push(`socket: ${err.message}`);
      });
      this.after(
        this.opts.turns * 90_000 + VERDICT_WAIT_MS + this.opts.reportTimeoutMs + 120_000,
        () => this.finish(false, "session timeout"),
      );
    });
  }

  /** Called by the shared ticker; sends the mic frames that are due. */
  pump(now: number) {
    if (!this.micOpen || this.ws.readyState !== WebSocket.OPEN) return;
    // After an event-loop stall, drop the backlog rather than bursting past
    // the server's audio rate limit.
    if (now - this.nextFrameAt > 1000) this.nextFrameAt = now;
    let sent = 0;
    while (this.micOpen && this.nextFrameAt <= now && sent < 8) {
      this.sendFrame();
      this.nextFrameAt += FRAME_MS;
      sent++;
    }
    this.result.maxBufferedBytes = Math.max(this.result.maxBufferedBytes, this.ws.bufferedAmount);
  }

  private onMessage(msg: any) {
    const now = Date.now();
    switch (msg.type) {
      case "status":
        if (msg.status === "vertex_ready" && this.phase === "connecting") this.sendReady();
        break;
      case "audio":
        this.onPanelSpeech(typeof msg.data === "string" ? Math.floor((msg.data.length * 3) / 4) : 0);
        break;
      case "transcript":
      case "verdict_message":
        this.onPanelSpeech(0);
        break;
      case "turn_aborted":
        this.result.abortedTurns++;
        this.onPanelTurnEnd();
        break;
      case "turn_complete":
        this.onPanelTurnEnd();
        break;
      case "verdict_complete":
        this.result.verdictMs = now - this.verdictRequestedAt;
        this.panelSpeaking = false;
        this.after(Math.max(0, this.playEndAt - now), () => this.sendEnd());
        break;
      case "chat_message":
        if (msg.role === "user" && this.awaitingReply && this.founderStoppedAt !== null && !this.echoSeen) {
          this.echoSeen = true;
          this.result.sttEchoMs.push(now - this.founderStoppedAt);
        }
        break;
      case "answer_tip":
        this.result.tips++;
        break;
      case "voice_end_session":
        this.conclude();
        break;
      case "report":
        this.result.reportMs = now - this.endSentAt;
        this.result.evaluationStatus = msg.data?.evaluationStatus ?? "unknown";
        this.finish(true);
        break;
      case "idle_end":
        this.result.errors.push("IDLE_END");
        break;
      case "error":
        this.result.errors.push(String(msg.code || msg.message || "error"));
        if (FATAL_CODES.has(msg.code)) this.finish(false, String(msg.code));
        break;
    }
  }

  private sendReady() {
    this.phase = "pitching";
    this.clientReadyAt = Date.now();
    this.greetingPending = true;
    this.send({
      type: "client_ready",
      config: {
        mode: this.opts.mode,
        businessName: `FarmLink Load Test ${this.index + 1}`,
        description:
          "Marketplace connecting smallholder farmers in Nigeria directly with restaurants and supermarkets.",
        industry: "Agritech",
        fundingStage: "Seed",
        investorArchetype: "Seed Stage - Venture Capital",
        aggressiveness: 60,
        riskAppetite: 75,
        duration: 10,
        browserLanguages: ["en-NG", "en"],
      },
    });
    // The browser streams the mic as soon as the room opens.
    this.openMic();
    this.heartbeat = setInterval(() => {
      if (this.micOpen) this.send({ type: "heartbeat" });
    }, 5000);
    this.scheduleResume(this.opts.turnTimeoutMs, () => {
      this.result.errors.push("NO_GREETING");
      this.greetingPending = false;
      this.speakNext();
    });
  }

  private onPanelSpeech(bytes: number) {
    const now = Date.now();
    if (this.phase === "connecting" || this.phase === "done") return;
    if (this.greetingPending) {
      this.greetingPending = false;
      this.result.greetingMs = now - this.clientReadyAt;
    }
    if (!this.panelSpeaking) {
      this.panelSpeaking = true;
      this.result.panelTurns++;
      if (this.phase === "pitching") this.cancelResume();
      if (this.clip) {
        // The panel replied to an earlier pause while the founder was still
        // talking; the browser's echo guard cuts the founder off here.
        this.result.earlyReplies++;
        this.clip = null;
        this.awaitingReply = false;
      } else if (this.awaitingReply && this.founderStoppedAt !== null) {
        this.result.replyMs.push(now - this.founderStoppedAt);
        this.awaitingReply = false;
      }
      this.clearReplyTimer();
      this.micOpen = false;
    }
    if (bytes > 0) {
      const ms = bytes / TTS_BYTES_PER_MS;
      this.playEndAt = Math.max(this.playEndAt, now) + ms;
      this.result.ttsReceivedSec += ms / 1000;
    }
  }

  private onPanelTurnEnd() {
    this.panelSpeaking = false;
    if (this.phase !== "pitching") return;
    const now = Date.now();
    const micAt = Math.max(this.playEndAt, now) + ECHO_GUARD_MS;
    this.scheduleResume(micAt - now, () => {
      this.openMic();
      this.scheduleResume(800 + Math.random() * 1200, () => this.speakNext());
    });
  }

  private speakNext() {
    if (this.phase !== "pitching" || this.panelSpeaking) return;
    if (this.awaitingReply) {
      this.result.noReply++;
      if (!this.echoSeen) this.result.untranscribed++;
      this.awaitingReply = false;
    }
    if (this.answersGiven >= this.opts.turns) {
      this.conclude();
      return;
    }
    this.openMic();
    this.clip = this.clips[(this.index + this.answersGiven) % this.clips.length];
    this.clipPos = 0;
    this.answersGiven++;
    this.founderStoppedAt = null;
    this.echoSeen = false;
    this.awaitingReply = true;
    this.clearReplyTimer();
  }

  private sendFrame() {
    let frame = SILENCE;
    if (this.clip) {
      frame = this.clip.subarray(this.clipPos, this.clipPos + FRAME_BYTES);
      if (frame.length < FRAME_BYTES) frame = Buffer.concat([frame, SILENCE.subarray(frame.length)]);
      this.clipPos += FRAME_BYTES;
      this.result.speechSentSec += FRAME_MS / 1000;
      if (this.clipPos >= this.clip.length) {
        this.clip = null;
        this.founderStoppedAt = Date.now();
        this.armReplyTimer();
      }
    }
    this.ws.send(frame, { binary: true });
    this.result.audioSentSec += FRAME_MS / 1000;
  }

  private conclude() {
    if (this.phase !== "pitching") return;
    this.cancelResume();
    this.clearReplyTimer();
    this.micOpen = false;
    this.clip = null;
    this.send({ type: "prepare_evaluation" });
    if (this.opts.mode === "panel") {
      this.phase = "verdict";
      this.verdictRequestedAt = Date.now();
      this.send({ type: "verdict_request", personas: [], timeLeft: 0 });
      this.after(VERDICT_WAIT_MS, () => {
        if (this.result.verdictMs === undefined) this.result.errors.push("VERDICT_TIMEOUT");
        this.sendEnd();
      });
    } else {
      this.sendEnd();
    }
  }

  private sendEnd() {
    if (this.phase === "ending" || this.phase === "done") return;
    this.phase = "ending";
    this.micOpen = false;
    this.endSentAt = Date.now();
    this.send({ type: "prepare_evaluation" });
    this.send({ type: "end_session" });
    this.after(this.opts.reportTimeoutMs, () => this.finish(false, "no report"));
  }

  private finish(ok: boolean, failure?: string) {
    if (this.phase === "done") return;
    this.phase = "done";
    this.micOpen = false;
    this.result.ok = ok;
    if (failure) this.result.failure = failure;
    this.result.totalSec = (Date.now() - this.startedAt) / 1000;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.cancelResume();
    this.clearReplyTimer();
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "Load test session done");
    else if (this.ws.readyState === WebSocket.CONNECTING) this.ws.terminate();
    this.resolveDone(this.result);
  }

  private openMic() {
    if (this.micOpen) return;
    this.micOpen = true;
    this.nextFrameAt = Date.now();
  }

  private armReplyTimer() {
    this.clearReplyTimer();
    this.replyTimer = setTimeout(() => {
      this.replyTimer = null;
      if (this.awaitingReply && !this.panelSpeaking) this.speakNext();
    }, this.opts.turnTimeoutMs);
  }

  private clearReplyTimer() {
    if (this.replyTimer) clearTimeout(this.replyTimer);
    this.replyTimer = null;
  }

  private scheduleResume(ms: number, fn: () => void) {
    this.cancelResume();
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      fn();
    }, Math.max(0, ms));
  }

  private cancelResume() {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
    this.resumeTimer = null;
  }

  private after(ms: number, fn: () => void) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private send(payload: Record<string, unknown>) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }
}

/** Times GET /health every 2 s: a stalled event loop shows up here first. */
class HealthProbe {
  private samples: number[] = [];
  private failures = 0;
  private readonly timer: NodeJS.Timeout;

  constructor(url: string) {
    this.timer = setInterval(async () => {
      const startedAt = Date.now();
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        await res.arrayBuffer();
        if (res.ok) this.samples.push(Date.now() - startedAt);
        else this.failures++;
      } catch {
        this.failures++;
      }
    }, 2000);
  }

  take() {
    const taken = { samples: this.samples, failures: this.failures };
    this.samples = [];
    this.failures = 0;
    return taken;
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Samples CPU and memory of the backend process listening on a local port. */
class ProcessSampler {
  private cores: number[] = [];
  private memoryMb: number[] = [];
  private last: { cpuSec: number; at: number } | null = null;
  private readonly timer: NodeJS.Timeout;

  private constructor(private readonly pid: number) {
    this.timer = setInterval(() => void this.sample(), 5000);
  }

  static async forPort(port: number): Promise<ProcessSampler | null> {
    try {
      const { stdout } =
        process.platform === "win32"
          ? await execFileAsync("powershell", [
              "-NoProfile",
              "-Command",
              `(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1).OwningProcess`,
            ])
          : await execFileAsync("lsof", ["-t", `-iTCP:${port}`, "-sTCP:LISTEN"]);
      const pid = Number(stdout.trim().split(/\s+/)[0]);
      return Number.isInteger(pid) && pid > 0 ? new ProcessSampler(pid) : null;
    } catch {
      return null;
    }
  }

  get processId() {
    return this.pid;
  }

  private async sample() {
    try {
      let cpuSec: number;
      let rssBytes: number;
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("powershell", [
          "-NoProfile",
          "-Command",
          `$p = Get-Process -Id ${this.pid}; [string]::Format([cultureinfo]::InvariantCulture, '{0} {1}', $p.TotalProcessorTime.TotalSeconds, $p.WorkingSet64)`,
        ]);
        [cpuSec, rssBytes] = stdout.trim().split(" ").map(Number);
      } else {
        const stat = fs.readFileSync(`/proc/${this.pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        cpuSec = (Number(fields[11]) + Number(fields[12])) / 100;
        rssBytes = Number(fields[21]) * 4096;
      }
      const at = Date.now();
      if (this.last) this.cores.push((cpuSec - this.last.cpuSec) / ((at - this.last.at) / 1000));
      this.last = { cpuSec, at };
      this.memoryMb.push(rssBytes / 1024 / 1024);
    } catch {
      // The process may have restarted; the gap shows in the samples.
    }
  }

  take() {
    const taken = { cores: this.cores, memoryMb: this.memoryMb };
    this.cores = [];
    this.memoryMb = [];
    return taken;
  }

  stop() {
    clearInterval(this.timer);
  }
}

function pct(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

const avg = (values: number[]) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function secs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function spread(values: number[]): string {
  if (values.length === 0) return "—";
  return `p50 ${secs(pct(values, 0.5))}  p95 ${secs(pct(values, 0.95))}  max ${secs(Math.max(...values))}  (n=${values.length})`;
}

function tally(items: string[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(", ") || "none";
}

interface StageSummary {
  concurrent: number;
  ok: number;
  minutes: number;
  replyP50: number | null;
  replyP95: number | null;
  reportP95: number | null;
  healthP95: number | null;
  cpuAvg: number | null;
  cpuPeak: number | null;
  memPeak: number | null;
}

function summarize(
  concurrent: number,
  results: SessionResult[],
  health: { samples: number[]; failures: number },
  server: { cores: number[]; memoryMb: number[] } | null,
  minutes: number,
): StageSummary {
  const ok = results.filter((r) => r.ok);
  const replies = results.flatMap((r) => r.replyMs);
  const reports = ok.map((r) => r.reportMs!).filter((v) => v !== undefined);
  const lines = [
    `  Completed with a report     ${ok.length}/${results.length}` +
      (results.length > ok.length
        ? `   failures: ${tally(results.filter((r) => !r.ok).map((r) => r.failure || "?"))}`
        : ""),
    `  Report status               ${tally(ok.map((r) => r.evaluationStatus || "?"))}`,
    `  Panel reply wait            ${spread(replies)}`,
    `    (founder stops talking → first panel audio)`,
    `  Speech-to-text echo         ${spread(results.flatMap((r) => r.sttEchoMs))}`,
    `  Greeting                    ${spread(results.map((r) => r.greetingMs!).filter((v) => v !== undefined))}`,
    `  Verdicts                    ${spread(results.map((r) => r.verdictMs!).filter((v) => v !== undefined))}`,
    `  Report after End            ${spread(reports)}`,
    `  Connect                     ${spread(results.map((r) => r.connectMs!).filter((v) => v !== undefined))}`,
    `  Answers with no reply       ${sum(results.map((r) => r.noReply))} (never transcribed: ${sum(results.map((r) => r.untranscribed))})   panel replied mid-answer: ${sum(results.map((r) => r.earlyReplies))}   aborted turns: ${sum(results.map((r) => r.abortedTurns))}`,
    `  Answer tips received        ${sum(results.map((r) => r.tips))} for ${replies.length} panel replies`,
    `  /health                     ${spread(health.samples)}   failures ${health.failures}`,
  ];
  if (server && server.memoryMb.length) {
    lines.push(
      `  Server CPU                  avg ${avg(server.cores)?.toFixed(2) ?? "—"} cores   peak ${server.cores.length ? Math.max(...server.cores).toFixed(2) : "—"} cores`,
      `  Server memory               peak ${Math.max(...server.memoryMb).toFixed(0)} MB`,
    );
  }
  const errors = results.flatMap((r) => r.errors);
  lines.push(`  Errors from server          ${tally(errors)}`);
  const maxBuffered = Math.max(0, ...results.map((r) => r.maxBufferedBytes));
  if (maxBuffered > 256 * 1024) {
    lines.push(
      `  ⚠ Up to ${(maxBuffered / 1024).toFixed(0)} KB of audio queued on this machine — its own upload may be the bottleneck.`,
    );
  }
  lines.push(
    `  Usage                       ${(sum(results.map((r) => r.audioSentSec)) / 60).toFixed(1)} min audio to speech-to-text, ` +
      `${(sum(results.map((r) => r.ttsReceivedSec)) / 60).toFixed(1)} min panel voice, ${sum(results.map((r) => r.panelTurns))} panel turns`,
  );
  console.log(`\nStage — ${concurrent} concurrent session(s), ${minutes.toFixed(1)} min`);
  console.log(lines.join("\n"));

  return {
    concurrent,
    ok: ok.length,
    minutes,
    replyP50: pct(replies, 0.5),
    replyP95: pct(replies, 0.95),
    reportP95: pct(reports, 0.95),
    healthP95: pct(health.samples, 0.95),
    cpuAvg: server ? avg(server.cores) : null,
    cpuPeak: server && server.cores.length ? Math.max(...server.cores) : null,
    memPeak: server && server.memoryMb.length ? Math.max(...server.memoryMb) : null,
  };
}

function printComparison(stages: StageSummary[]) {
  const cols = ["Concurrent", "Done", "Reply p50", "Reply p95", "Report p95", "/health p95", "CPU avg", "CPU peak", "Mem peak"];
  const rows = stages.map((s) => [
    String(s.concurrent),
    `${s.ok}/${s.concurrent}`,
    secs(s.replyP50),
    secs(s.replyP95),
    secs(s.reportP95),
    secs(s.healthP95),
    s.cpuAvg === null ? "—" : `${s.cpuAvg.toFixed(2)}`,
    s.cpuPeak === null ? "—" : `${s.cpuPeak.toFixed(2)}`,
    s.memPeak === null ? "—" : `${s.memPeak.toFixed(0)} MB`,
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log("\n" + line(cols));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));

  const withCpu = stages.filter((s) => s.cpuAvg !== null && s.cpuAvg > 0);
  if (withCpu.length) {
    const top = withCpu[withCpu.length - 1];
    const perSession = top.cpuAvg! / top.concurrent;
    console.log(
      `\nCPU per live session ≈ ${perSession.toFixed(3)} cores on this machine (stage of ${top.concurrent}). ` +
        `A 0.1-core server (Render free) saturates near ${Math.max(1, Math.floor(0.1 / perSession))} sessions; ` +
        `0.5 cores near ${Math.floor(0.5 / perSession)}; 1 core near ${Math.floor(1 / perSession)}. ` +
        `Rough: a slower CPU uses more per session.`,
    );
  }
}

async function main() {
  const opts = parseOptions(process.argv.slice(2));
  const clips = loadClips();
  const users = readUsers();
  const maxStage = Math.max(...opts.stages);
  const httpBase = httpBaseFor(opts.url);
  const totalSessions = sum(opts.stages);
  const clipSec = avg(clips.map((c) => c.length / 32000))!;
  console.log(
    `Target       ${opts.url}\n` +
      `Stages       ${opts.stages.join(" → ")} concurrent sessions (${totalSessions} sessions in total)\n` +
      `Each session ${opts.mode} mode, ${opts.turns} spoken answers of ~${clipSec.toFixed(0)}s, then verdicts and the report\n` +
      `Spend        ~${((totalSessions * opts.turns * clipSec) / 60).toFixed(1)} min of founder speech plus every panel reply, ` +
      `verdict and evaluation on your Azure keys; ${totalSessions} session rows in the database`,
  );
  if (users.length < maxStage) {
    throw new Error(
      `Need ${maxStage} test accounts, found ${users.length}. Run: npx tsx scripts/loadtest/users.ts seed --count ${maxStage}`,
    );
  }
  if (!opts.yes) {
    console.log("\nDry run only. Add --yes to start.");
    return;
  }

  try {
    const res = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err: any) {
    throw new Error(`Backend not reachable at ${httpBase}/health: ${err.message}`);
  }

  const tokens: string[] = [];
  for (const user of users.slice(0, maxStage)) tokens.push(await tokenFor(user, opts, httpBase));
  if (opts.auth === "login") fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));

  const sampler = opts.serverPort ? await ProcessSampler.forPort(opts.serverPort) : null;
  if (opts.serverPort) {
    console.log(
      sampler
        ? `Sampling server process ${sampler.processId} on port ${opts.serverPort}`
        : `Could not find a process listening on port ${opts.serverPort}; skipping CPU/memory`,
    );
  }
  const probe = new HealthProbe(`${httpBase}/health`);
  const active = new Set<SimSession>();
  const ticker = setInterval(() => {
    const now = Date.now();
    for (const session of active) session.pump(now);
  }, 16);

  const summaries: StageSummary[] = [];
  const allResults: SessionResult[] = [];
  try {
    for (const [stageIndex, concurrent] of opts.stages.entries()) {
      console.log(`\n▶ Stage ${stageIndex + 1}/${opts.stages.length}: ${concurrent} concurrent session(s)`);
      probe.take();
      sampler?.take();
      const stageStartedAt = Date.now();
      const status = setInterval(() => {
        console.log(`  … ${active.size} running, ${((Date.now() - stageStartedAt) / 60000).toFixed(1)} min`);
      }, 30_000);
      const runs = Array.from(
        { length: concurrent },
        (_, k) =>
          new Promise<SessionResult>((resolve) => {
            const delay = concurrent === 1 ? 0 : (k * opts.stagger * 1000) / concurrent;
            setTimeout(() => {
              const session = new SimSession(opts, clips, tokens[k], stageIndex + 1, k, users[k].id);
              active.add(session);
              void session.run().then((r) => {
                active.delete(session);
                const median = pct(r.replyMs, 0.5);
                console.log(
                  r.ok
                    ? `  ✓ #${k + 1} report in ${secs(r.reportMs)}, ${r.replyMs.length} replies, median wait ${secs(median)}`
                    : `  ✗ #${k + 1} ${r.failure}${r.errors.length ? ` [${tally(r.errors)}]` : ""}`,
                );
                resolve(r);
              });
            }, delay);
          }),
      );
      const results = await Promise.all(runs);
      clearInterval(status);
      allResults.push(...results);
      summaries.push(
        summarize(concurrent, results, probe.take(), sampler?.take() ?? null, (Date.now() - stageStartedAt) / 60000),
      );
      if (stageIndex < opts.stages.length - 1) await new Promise((r) => setTimeout(r, 10_000));
    }
  } finally {
    clearInterval(ticker);
    probe.stop();
    sampler?.stop();
  }

  printComparison(summaries);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify({ options: { ...opts, yes: undefined }, summaries, sessions: allResults }, null, 2));
  console.log(`\nRaw results: ${file}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
