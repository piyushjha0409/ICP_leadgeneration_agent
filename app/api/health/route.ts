import { NextResponse } from "next/server";
import { MODELS } from "@/src/config";
import { chat } from "@/src/lib/llm";
import {
  isSearchSuccess,
  resolveSearchProviders,
  webSearch,
} from "@/src/lib/search";

export async function GET() {
  if (!process.env.OPENROUTER_API_KEY) {
    return NextResponse.json(
      { ok: false, reason: "OPENROUTER_API_KEY not set" },
      { status: 200 },
    );
  }

  const usage: Record<string, unknown> = {};

  let basicReply: string | { error: string };
  try {
    const result = await chat(
      MODELS.operator,
      [{ role: "user", content: "Reply with the single word: ok" }],
      { maxTokens: 50 },
    );
    basicReply = result.text;
    usage.basic = result.usage;
  } catch (err) {
    basicReply = { error: err instanceof Error ? err.message : String(err) };
  }

  // Search is a separate provider (Firecrawl or Tavily), not an LLM plugin —
  // probe it directly. Costs one search's credits (2 Firecrawl / 1 Tavily).
  const resolution = resolveSearchProviders();
  const searchProviders =
    "providers" in resolution
      ? resolution.providers.map((provider) => provider.id)
      : { error: resolution.error };

  const search = await webSearch("marketing agency industry news", {
    maxResults: 3,
  });
  const searchReply = isSearchSuccess(search)
    ? {
        provider: search.provider,
        results: search.results.map(
          (result) => `${result.title} — ${result.url}`,
        ),
      }
    : { error: search.error };

  return NextResponse.json({
    ok: true,
    operatorModel: MODELS.operator,
    strategistModel: MODELS.strategist,
    basicReply,
    searchProviders,
    searchReply,
    usage,
  });
}
