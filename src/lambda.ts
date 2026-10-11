
import dns from "node:dns";
import serverlessExpress from "@codegenie/serverless-express";
import { loadAwsParameters } from "./config/loadAwsParameters.ts";

dns.setDefaultResultOrder("ipv4first");

type LambdaHandler = ReturnType<typeof serverlessExpress>;

let handlerPromise: Promise<LambdaHandler> | undefined;

async function initialize(): Promise<LambdaHandler> {
  // Load configuration before importing the application.
  await loadAwsParameters();

  // Dynamic import ensures env.ts and Supabase initialize afterward.
  const { default: app } = await import("./app.ts");

  return serverlessExpress({ app });
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
