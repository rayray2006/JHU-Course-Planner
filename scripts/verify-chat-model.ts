/**
 * Says which model the chat agent will use and makes one cheap call to prove
 * the credentials work. Run after adding or rotating ANTHROPIC_API_KEY.
 *
 *   npx tsx --env-file=.env.local scripts/verify-chat-model.ts
 */
import { generateText } from "ai";
import { createVertex } from "@ai-sdk/google-vertex";
import { createAnthropic } from "@ai-sdk/anthropic";
import { CHAT_MODEL, USE_CLAUDE, PRICING } from "../src/lib/model-config";

async function main() {
  console.log(`Active model : ${CHAT_MODEL}`);
  console.log(`Provider     : ${USE_CLAUDE ? "Anthropic API (ANTHROPIC_API_KEY)" : "Google Vertex (ADC / service account)"}`);
  console.log(`Pricing      : $${(PRICING.input * 1_000_000).toFixed(2)}/1M in, $${(PRICING.output * 1_000_000).toFixed(2)}/1M out`);
  if (!USE_CLAUDE) {
    console.log("\nSet ANTHROPIC_API_KEY in .env.local to switch the agent to Claude.");
  }

  const model = USE_CLAUDE
    ? createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY })(CHAT_MODEL)
    : createVertex()(CHAT_MODEL);

  const started = Date.now();
  try {
    const r = await generateText({
      model,
      prompt: "Reply with the single word: ok",
      maxOutputTokens: 16,
      providerOptions: USE_CLAUDE
        ? { anthropic: { effort: "low" as const } }
        : { vertex: { thinkingConfig: { thinkingBudget: 0 } } },
    });
    console.log(`\nOK — ${JSON.stringify(r.text.trim())} in ${Date.now() - started}ms (${r.usage.inputTokens} in / ${r.usage.outputTokens} out)`);
  } catch (e) {
    console.error(`\nFAILED after ${Date.now() - started}ms: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

main();
