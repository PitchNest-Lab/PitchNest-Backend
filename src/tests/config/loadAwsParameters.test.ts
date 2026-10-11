import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { GetParametersCommand } from "@aws-sdk/client-ssm";
import { loadAwsParameters } from "../../config/loadAwsParameters.ts";

/**
 * SSM loader tests. A fake client stands in for AWS — no network, no
 * credentials. Values are dummies, and every test asserts none of them reaches
 * the console or an error message.
 */

const REQUIRED = [
  "JWT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "GOOGLE_CLIENT_ID",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
];
const dummy = (name: string) => `dummy-value-for-${name}-do-not-log`;

class FakeSsm {
  calls: { Names: string[]; WithDecryption?: boolean }[] = [];
  constructor(private store: Record<string, string>) {}
  async send(command: GetParametersCommand) {
    const input = command.input as { Names: string[]; WithDecryption?: boolean };
    this.calls.push({ Names: [...input.Names], WithDecryption: input.WithDecryption });
    return {
      Parameters: input.Names.filter((n) => n in this.store).map((n) => ({ Name: n, Value: this.store[n] })),
      InvalidParameters: input.Names.filter((n) => !(n in this.store)),
    };
  }
}

function fullStore(env = "dev") {
  return Object.fromEntries(REQUIRED.map((n) => [`/pitchnest/${env}/${n}`, dummy(n)]));
}

function captureConsole() {
  const lines: string[] = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig) as (keyof typeof orig)[]) {
    (console as any)[k] = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  }
  return { lines, restore: () => Object.assign(console, orig) };
}

beforeEach(() => {
  delete process.env.PITCHNEST_ENV;
  for (const n of REQUIRED) delete process.env[n];
});

test("loads all nine parameters, including Azure OpenAI, in one decrypted call", async () => {
  const fake = new FakeSsm(fullStore());
  const out = captureConsole();
  try {
    await loadAwsParameters(fake as any);
  } finally {
    out.restore();
  }
  assert.equal(fake.calls.length, 1, "nine names fit in a single GetParameters call");
  assert.equal(fake.calls[0].WithDecryption, true);
  assert.deepEqual(fake.calls[0].Names.sort(), REQUIRED.map((n) => `/pitchnest/dev/${n}`).sort());
  for (const n of REQUIRED) assert.equal(process.env[n], dummy(n));
  assert.deepEqual(out.lines, ["Loaded 9 configuration parameters from AWS SSM"]);
});

test("Azure values are visible to config/env.ts when it is imported after loading", async () => {
  await loadAwsParameters(new FakeSsm(fullStore()) as any);
  process.env.JWT_SECRET = "test-only-secret";
  const { config, hasAzureOpenAiConfig } = await import("../../config/env.ts");
  assert.equal(config.azureOpenAiEndpoint, dummy("AZURE_OPENAI_ENDPOINT"));
  assert.equal(config.azureOpenAiApiKey, dummy("AZURE_OPENAI_API_KEY"));
  assert.equal(config.azureOpenAiDeployment, dummy("AZURE_OPENAI_DEPLOYMENT"));
  assert.equal(hasAzureOpenAiConfig(), true);
});

test("honours PITCHNEST_ENV for the parameter path", async () => {
  process.env.PITCHNEST_ENV = "test";
  const fake = new FakeSsm(fullStore("test"));
  await loadAwsParameters(fake as any);
  assert.ok(fake.calls[0].Names.every((n) => n.startsWith("/pitchnest/test/")));
});

for (const missing of ["AZURE_OPENAI_API_KEY", "JWT_SECRET"]) {
  test(`fails closed, naming the path but no values, when ${missing} is missing`, async () => {
    const store = fullStore();
    delete store[`/pitchnest/dev/${missing}`];
    const out = captureConsole();
    let err: Error | null = null;
    try {
      await loadAwsParameters(new FakeSsm(store) as any);
    } catch (e) {
      err = e as Error;
    } finally {
      out.restore();
    }
    assert.ok(err, "must throw");
    assert.match(err!.message, new RegExp(`/pitchnest/dev/${missing}`));
    assert.ok(!err!.message.includes("dummy-value"), "error must not contain any value");
    assert.ok(!out.lines.join("\n").includes("dummy-value"), "nothing logged with a value");
    for (const n of REQUIRED) assert.equal(process.env[n], undefined, "no partial environment on failure");
  });
}

test("fails closed on an empty parameter value", async () => {
  const store = fullStore();
  store["/pitchnest/dev/AZURE_OPENAI_ENDPOINT"] = "";
  await assert.rejects(loadAwsParameters(new FakeSsm(store) as any), /empty parameter: \/pitchnest\/dev\/AZURE_OPENAI_ENDPOINT/);
  assert.equal(process.env.JWT_SECRET, undefined);
});

test("rejects a parameter outside the expected set or path", async () => {
  const fake = new FakeSsm(fullStore());
  const realSend = fake.send.bind(fake);
  fake.send = async (c: GetParametersCommand) => {
    const r = await realSend(c);
    r.Parameters.push({ Name: "/pitchnest/prod/JWT_SECRET", Value: "x" });
    return r;
  };
  await assert.rejects(loadAwsParameters(fake as any), /Unexpected AWS SSM parameter/);
});

test("propagates AWS errors (e.g. AccessDenied before IAM is updated) without leaking values", async () => {
  const denied = {
    send: async () => {
      const e = new Error("User is not authorized to perform: ssm:GetParameters");
      e.name = "AccessDeniedException";
      throw e;
    },
  };
  await assert.rejects(loadAwsParameters(denied as any), { name: "AccessDeniedException" });
  assert.equal(process.env.JWT_SECRET, undefined);
});
