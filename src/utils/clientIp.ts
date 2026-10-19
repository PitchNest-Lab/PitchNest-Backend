import { isIP } from "node:net";

/**
 * Resolve the browser address when exactly one trusted reverse proxy is in
 * front of the process. Proxies append the address they observed to the right
 * of any client-supplied X-Forwarded-For values, so the right-most hop is the
 * only one a browser cannot choose. Outside that deployment shape the socket's
 * direct peer address remains authoritative.
 */
export function resolveClientIp(
  forwardedFor: string | string[] | undefined,
  directAddress: string | undefined,
  trustOneProxy: boolean,
): string {
  const fallback = directAddress || "unknown";
  if (!trustOneProxy || !forwardedFor) return fallback;

  const chain = (Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor)
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  const proxyObservedAddress = chain.at(-1) || "";

  return isIP(proxyObservedAddress) ? proxyObservedAddress : fallback;
}
