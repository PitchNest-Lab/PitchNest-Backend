
import dns from "node:dns";
import serverlessExpress from "@codegenie/serverless-express";
import { loadAwsParameters } from "./config/loadAwsParameters.ts";

dns.setDefaultResultOrder("ipv4first");

type LambdaHandler = ReturnType<typeof serverlessExpress>;

// API Gateway passes a response body through as text unless the handler marks
// it base64. The adapter's default marks only images and compressed bodies, so
// a PDF arrived as UTF-8 text with every page blank. Mark everything that is
// not text: base64 is harmless for text, text is destructive for binary.
const TEXT_CONTENT_TYPE =
  /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded)\b|[^;]*\+(json|xml)\b)/i;

export function isBinaryResponse({ headers }: { headers: Record<string, unknown> }): boolean {
  const encoding = String(headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding && encoding !== "identity") return true;
  return !TEXT_CONTENT_TYPE.test(String(headers["content-type"] ?? "").trim());
}

export function createLambdaHandler(
  app: Parameters<typeof serverlessExpress>[0]["app"],
): LambdaHandler {
  return serverlessExpress({ app, binarySettings: { isBinary: isBinaryResponse } });
}

let handlerPromise: Promise<LambdaHandler> | undefined;

async function initialize(): Promise<LambdaHandler> {
  // Load configuration before importing the application.
  await loadAwsParameters();

  // Dynamic import ensures env.ts and Supabase initialize afterward.
  const { default: app } = await import("./app.ts");

  return createLambdaHandler(app);
}

export const handler = async (
  event: Parameters<LambdaHandler>[0],
  context: Parameters<LambdaHandler>[1],
) => {
  // Reuse initialization across warm Lambda invocations.
  handlerPromise ??= initialize();

  try {
    const expressHandler = await handlerPromise;
    return await expressHandler(event, context);
  } catch (error) {
    // Allow initialization to retry after a transient SSM failure.
    handlerPromise = undefined;
    throw error;
  }
};
