import { config, hasResearchConfig } from "../config/env.ts";
import { getOpenAIClient } from "./aiService.ts";

/**
 * Background web research — builds a compact, dated "MARKET SNAPSHOT" the
 * live panel and the post-session evaluation can ground themselves in.
 *
 * Design constraints (do not weaken):
 * - Fire-and-forget: callers start this WITHOUT awaiting at session start.
 *   No live turn may ever wait on it.
 * - Silent failure: any error, timeout, or thin result resolves to null and
 *   the session behaves exactly as if research were disabled.
 * - The snapshot always carries its retrieval date so neither the panel nor
 *   the report can present it as verified/current beyond that.
 */

export interface MarketSnapshot {
  /** ≤ ~700 chars of competitor / market-size / trend lines. */
  text: string;
  /** ISO date the web results were retrieved. */
  retrievedAt: string;
}

const SEARCH_TIMEOUT_MS = 20_000;
const MAX_RESULTS_PER_QUERY = 4;

type SearchResult = { title: string; snippet: string; url: string };

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function searchTavily(query: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    "https://api.tavily.com/search",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.tavilyApiKey,
        query,
        max_results: MAX_RESULTS_PER_QUERY,
        search_depth: "basic",
      }),
    },
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  const data: any = await res.json();
  return (Array.isArray(data?.results) ? data.results : [])
    .map((r: any) => ({
      title: String(r?.title || ""),
      snippet: String(r?.content || ""),
      url: String(r?.url || ""),
    }))
    .filter((r: SearchResult) => r.snippet);
}

async function searchSerper(query: string): Promise<SearchResult[]> {
  const res = await fetchWithTimeout(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": config.serperApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: MAX_RESULTS_PER_QUERY }),
    },
    SEARCH_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`Serper search failed: ${res.status}`);
  const data: any = await res.json();
  return (Array.isArray(data?.organic) ? data.organic : [])
    .map((r: any) => ({
      title: String(r?.title || ""),
      snippet: String(r?.snippet || ""),
      url: String(r?.link || ""),
    }))
    .filter((r: SearchResult) => r.snippet);
}

function webSearch(query: string): Promise<SearchResult[]> {
  if (config.tavilyApiKey) return searchTavily(query);
  return searchSerper(query);
}

/**
 * Runs the searches + one small summarization call and returns a snapshot,
 * or null on any failure / when research is not configured. Never throws.
 */
export async function researchStartup(params: {
  businessName: string;
  description?: string;
  industry?: string;
}): Promise<MarketSnapshot | null> {
  if (!hasResearchConfig()) return null;

  const { businessName, description, industry } = params;
  const year = new Date().getFullYear();
  const subject = (description || businessName || "").trim().slice(0, 120);
  if (!subject) return null;

  const queries = [
    `${subject} competitors`,
    `${(industry || subject).trim()} market size ${year}`,
  ];

  try {
    const resultSets = await Promise.all(
      queries.map((q) => webSearch(q).catch(() => [] as SearchResult[])),
    );
    const results = resultSets.flat();
    if (results.length === 0) return null;

    const sourceMaterial = results
      .slice(0, 8)
      .map((r) => `- ${r.title}: ${r.snippet.slice(0, 240)} (${r.url})`)
      .join("\n");

    const client = getOpenAIClient();
    const completion = await client.chat.completions.create({
      model: config.azureOpenAiDeployment || "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You distill raw web search results into a compact market snapshot for an investor panel. Return ONLY the snapshot text, no preamble.
RULES:
- ≤ 700 characters total.
- Lines: up to 4 real competitors (name + one-line position), ONE market-size figure WITH its source name and year, and one recent trend.
- Use ONLY facts present in the search results below. If the results are thin or off-topic for the business, respond with exactly: NOTHING_FOUND
- Never stretch weak results; omitting a line is better than guessing.`,
        },
        {
          role: "user",
          content: `BUSINESS: ${businessName}\nWHAT IT DOES: ${description || "(not stated)"}\nINDUSTRY: ${industry || "(not stated)"}\n\nSEARCH RESULTS:\n${sourceMaterial}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });

    const text = (completion.choices?.[0]?.message?.content || "").trim();
    if (!text || text.includes("NOTHING_FOUND") || text.length < 40) {
      return null;
    }

    return {
      text: text.slice(0, 900),
      retrievedAt: new Date().toISOString().slice(0, 10),
    };
  } catch (err) {
    console.warn("[research] snapshot failed (session continues without):", err);
    return null;
  }
}

/**
 * Prompt block appended to the live system instruction once research lands.
 */
export function buildMarketSnapshotBlock(snapshot: MarketSnapshot): string {
  return `
MARKET SNAPSHOT (web results retrieved ${snapshot.retrievedAt} — the only external facts you may assert):
${snapshot.text}
SNAPSHOT RULES:
- You may reference these facts with light attribution ("recent reports put the market around..."), especially to test the founder's own market and competitor claims.
- Never assert market facts beyond this snapshot; outside it, challenge internal consistency instead (the Grounding rule).`;
}
