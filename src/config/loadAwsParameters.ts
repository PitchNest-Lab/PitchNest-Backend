
import {
  SSMClient,
  GetParametersCommand,
  type Parameter,
} from "@aws-sdk/client-ssm";

/**
 * Configuration loaded from SSM Parameter Store before the Express app (and
 * therefore config/env.ts, the Supabase client and the AI client) initialises.
 * Every name is REQUIRED: a missing or empty parameter fails initialisation
 * rather than letting the app boot half-configured.
 */
const PARAMETER_NAMES = [
  "JWT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "GOOGLE_CLIENT_ID",
  // Azure OpenAI — read by config/env.ts (hasAzureOpenAiConfig) and
  // services/aiService.ts (getOpenAIClient); used on Lambda by Deck Check.
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_DEPLOYMENT",
] as const;

type ParameterName = (typeof PARAMETER_NAMES)[number];

/**
 * Flutterwave billing keys. Requested only while BILLING_CHECKOUT_ENABLED is
 * "true", so an environment with billing off never asks for them. They are
 * fetched in a call of their own, because GetParameters is refused as a whole
 * when any name in it is denied: a missing or unreadable key leaves billing off
 * (config/env.ts hasBillingConfig) instead of failing start-up.
 */
const OPTIONAL_PARAMETER_NAMES = ["FLW_SECRET_KEY", "FLW_WEBHOOK_HASH"] as const;

type OptionalParameterName = (typeof OPTIONAL_PARAMETER_NAMES)[number];

/** SSM GetParameters accepts at most 10 names per call. */
const MAX_NAMES_PER_CALL = 10;

const ssm = new SSMClient({
  region: process.env.AWS_REGION || "eu-west-2",
});

type SsmSender = Pick<SSMClient, "send">;

/**
 * Loads every required parameter, and the billing keys it can read when
 * checkout is enabled, into process.env. Called once per Lambda execution
 * environment (src/lambda.ts caches the result), so this costs one
 * GetParameters call per cold start (two with checkout enabled) — not per
 * request.
 *
 * Errors name the missing parameter PATHS only; values are never logged or
 * included in messages.
 */
export async function loadAwsParameters(client: SsmSender = ssm): Promise<void> {
  const environment = process.env.PITCHNEST_ENV || "dev";
  const prefix = `/pitchnest/${environment}/`;

  const names = PARAMETER_NAMES.map((name) => `${prefix}${name}`);

  const parameters: Parameter[] = [];
  const invalid: string[] = [];

  for (let i = 0; i < names.length; i += MAX_NAMES_PER_CALL) {
    const response = await client.send(
      new GetParametersCommand({
        Names: names.slice(i, i + MAX_NAMES_PER_CALL),
        WithDecryption: true,
      }),
    );
    invalid.push(...(response.InvalidParameters ?? []));
    parameters.push(...(response.Parameters ?? []));
  }

  if (invalid.length) {
    throw new Error(
      `Required AWS SSM parameters are missing: ${invalid.join(", ")}`,
    );
  }

  const values = new Map<ParameterName, string>();

  for (const parameter of parameters) {
    const key = parameter.Name?.startsWith(prefix)
      ? parameter.Name.slice(prefix.length)
      : undefined;

    if (!key || !PARAMETER_NAMES.includes(key as ParameterName)) {
      throw new Error("Unexpected AWS SSM parameter");
    }

    if (!parameter.Value) {
      throw new Error(`AWS SSM returned an empty parameter: ${parameter.Name}`);
    }

    values.set(key as ParameterName, parameter.Value);
  }

  const missing = PARAMETER_NAMES.filter((name) => !values.has(name));
  if (missing.length) {
    throw new Error(
      `Failed to retrieve required AWS SSM parameters: ${missing
        .map((name) => `${prefix}${name}`)
        .join(", ")}`,
    );
  }

  const optional =
    process.env.BILLING_CHECKOUT_ENABLED === "true"
      ? await loadOptionalParameters(client, prefix)
      : new Map<OptionalParameterName, string>();

  // Only assign once everything is present, so a failed load never leaves a
  // partially populated environment behind for a retry.
  for (const [key, value] of [...values, ...optional]) {
    process.env[key] = value;
  }

  console.info(
    optional.size
      ? `Loaded ${values.size} configuration parameters and ${optional.size} optional billing parameters from AWS SSM`
      : `Loaded ${values.size} configuration parameters from AWS SSM`,
  );
}

/** Never throws: an absent, empty or unreadable optional key is simply skipped. */
async function loadOptionalParameters(
  client: SsmSender,
  prefix: string,
): Promise<Map<OptionalParameterName, string>> {
  const found = new Map<OptionalParameterName, string>();
  let parameters: Parameter[];
  try {
    const response = await client.send(
      new GetParametersCommand({
        Names: OPTIONAL_PARAMETER_NAMES.map((name) => `${prefix}${name}`),
        WithDecryption: true,
      }),
    );
    parameters = response.Parameters ?? [];
  } catch (error) {
    // e.g. AccessDenied while the role may read only the required set.
    const name = error instanceof Error ? error.name : "error";
    console.warn(`Optional billing parameters not loaded from AWS SSM (${name}); billing stays off.`);
    return found;
  }
  for (const parameter of parameters) {
    const key = parameter.Name?.startsWith(prefix)
      ? (parameter.Name.slice(prefix.length) as OptionalParameterName)
      : undefined;
    if (key && OPTIONAL_PARAMETER_NAMES.includes(key) && parameter.Value) {
      found.set(key, parameter.Value);
    }
  }
  return found;
}
