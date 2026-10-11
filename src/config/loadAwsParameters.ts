
import {
  SSMClient,
  GetParametersCommand,
} from "@aws-sdk/client-ssm";

const PARAMETER_NAMES = [
  "JWT_SECRET",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY",
  "GOOGLE_CLIENT_ID",
] as const;

const ssm = new SSMClient({
  region: process.env.AWS_REGION || "eu-west-2",
});

export async function loadAwsParameters(): Promise<void> {
  const environment = process.env.PITCHNEST_ENV || "dev";

  const names = PARAMETER_NAMES.map(
    (name) => `/pitchnest/${environment}/${name}`,
  );

  const response = await ssm.send(
    new GetParametersCommand({
      Names: names,
      WithDecryption: true,
    }),
  );

  if (response.InvalidParameters?.length) {
    throw new Error(
      "Required AWS SSM parameters are missing",
    );
  }

  const parameters = response.Parameters ?? [];

  if (parameters.length !== names.length) {
    throw new Error(
      "Failed to retrieve all required AWS SSM parameters",
    );
  }

  for (const parameter of parameters) {
    if (!parameter.Name || !parameter.Value) {
      throw new Error("AWS SSM returned an empty parameter");
    }

    const key = parameter.Name.split("/").pop();

    if (!key || !PARAMETER_NAMES.includes(key as typeof PARAMETER_NAMES[number])) {
      throw new Error("Unexpected AWS SSM parameter");
    }

    process.env[key] = parameter.Value;
  }

  console.info(
    `Loaded ${parameters.length} configuration parameters from AWS SSM`,
  );
}
