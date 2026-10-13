/**
 * Public URL of the frontend that links in emails (verify, reset password)
 * must point to.
 *
 * Order:
 *   1. APP_BASE_URL, then CLIENT_URL: the explicit setting for this deploy.
 *   2. NODE_ENV as a fallback: development → the DEV frontend, localhost →
 *      the Vite dev server, anything else → production.
 *
 * Explicit settings must win: the production Render service runs with
 * NODE_ENV=development while CLIENT_URL/APP_BASE_URL point at
 * www.pitchnest.app, so inferring from NODE_ENV alone sent production users
 * to the DEV site, and the old ALLOWED_ORIGIN fallback sent reset links to
 * localhost when it was unset.
 */
export const PROD_FRONTEND_URL = "https://www.pitchnest.app";
export const DEV_FRONTEND_URL = "https://pitchnest-development.vercel.app";
export const LOCAL_FRONTEND_URL = "http://localhost:5174";

function clean(url: string | undefined): string | null {
  // ALLOWED_ORIGIN-style lists are comma separated; take the first entry.
  const first = (url || "").split(",")[0].trim().replace(/\/+$/, "");
  return /^https?:\/\/[^\s/]+/i.test(first) ? first : null;
}

export function frontendBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = clean(env.APP_BASE_URL) || clean(env.CLIENT_URL);
  if (explicit) return explicit;
  if (env.NODE_ENV === "development") return DEV_FRONTEND_URL;
  if (env.NODE_ENV === "localhost") return LOCAL_FRONTEND_URL;
  return PROD_FRONTEND_URL;
}

/**
 * Resolves a send-mail promise or gives up after `ms`, so a request can wait
 * for delivery (needed on Lambda, which freezes once the response is sent)
 * without hanging on a slow mail provider.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
