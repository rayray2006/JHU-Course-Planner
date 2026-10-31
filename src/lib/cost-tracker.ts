import { createClient } from "@supabase/supabase-js";
import { PRICING } from "./model-config";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const INPUT_COST_PER_TOKEN = PRICING.input;
const OUTPUT_COST_PER_TOKEN = PRICING.output;

const BUDGET_LIMIT = 150; // dollars — cut off at $150 to preserve credits

/** Anthropic cache pricing, relative to the base input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25; // 5-minute TTL; a 1-hour write is 2x

/**
 * The budget gate used to sit on the critical path: every chat request paid a
 * Supabase round trip before the model was even called. The running total only
 * matters near the $150 cutoff, so a short cache is enough — and `recordUsage`
 * refreshes it from its own read, so the cached figure tracks real spend.
 */
const BUDGET_CACHE_MS = 60_000;
let cachedTotal: { cost: number; at: number } | null = null;

export async function checkBudget(): Promise<{ allowed: boolean; totalCost: number }> {
  if (cachedTotal && Date.now() - cachedTotal.at < BUDGET_CACHE_MS) {
    return { allowed: cachedTotal.cost < BUDGET_LIMIT, totalCost: cachedTotal.cost };
  }

  const { data } = await supabase
    .from("cost_tracking")
    .select("total_cost")
    .eq("id", "global")
    .single();

  const totalCost = data?.total_cost ?? 0;
  cachedTotal = { cost: totalCost, at: Date.now() };
  return { allowed: totalCost < BUDGET_LIMIT, totalCost };
}

/**
 * Call this ONCE per request with the totals summed across every step, from the
 * route's `onFinish`. It was previously called from `onStepFinish`, which put a
 * select plus an update between each LLM call — two round trips of dead air in
 * the middle of a stream the user was already watching.
 */
export async function recordUsage(
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): Promise<number> {
  // Anthropic bills a cached read at a tenth of the input rate and a 5-minute
  // cache write at 1.25x. inputTokens counts every input token including the
  // cached ones, so charging it whole would overstate spend badly now that the
  // tool schemas and system prompt are cached — and this figure gates the
  // $150 cutoff, so overstating it would shut the app off early.
  const uncachedTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const cost =
    uncachedTokens * INPUT_COST_PER_TOKEN +
    cacheReadTokens * INPUT_COST_PER_TOKEN * CACHE_READ_MULTIPLIER +
    cacheWriteTokens * INPUT_COST_PER_TOKEN * CACHE_WRITE_MULTIPLIER +
    outputTokens * OUTPUT_COST_PER_TOKEN;

  const { data: existing } = await supabase
    .from("cost_tracking")
    .select("total_cost, total_input_tokens, total_output_tokens, request_count")
    .eq("id", "global")
    .single();

  if (existing) {
    await supabase
      .from("cost_tracking")
      .update({
        total_cost: existing.total_cost + cost,
        total_input_tokens: existing.total_input_tokens + inputTokens,
        total_output_tokens: existing.total_output_tokens + outputTokens,
        request_count: existing.request_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "global");
  } else {
    await supabase
      .from("cost_tracking")
      .insert({
        id: "global",
        total_cost: cost,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        request_count: 1,
        updated_at: new Date().toISOString(),
      });
  }

  const total = (existing?.total_cost ?? 0) + cost;
  cachedTotal = { cost: total, at: Date.now() };
  return total;
}
