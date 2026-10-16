import { config } from "./env.ts";

/**
 * Browser origins allowed to call either HTTP or WebSocket endpoints.
 * Preview deployments are opt-in through CORS_EXTRA_ORIGINS; accepting every
 * *.vercel.app / *.pages.dev hostname lets any stranger-controlled project
 * become an allowed browser origin.
 */
export function allowedBrowserOrigins(): Set<string> {
  const origins = new Set(
    [
      config.allowedOrigin,
      ...config.corsExtraOrigins,
      ...(config.nodeEnv === "production"
        ? []
        : [
            "http://localhost:5173",
            "https://localhost:5173",
            "http://localhost:5174",
            "https://localhost:5174",
            "http://localhost:3000",
          ]),
    ]
      // Lowercased because a browser's Origin header always is.
      .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  );
  return origins;
}

export function isAllowedBrowserOrigin(origin: string): boolean {
  try {
    return allowedBrowserOrigins().has(new URL(origin).origin);
  } catch {
    return false;
  }
}
