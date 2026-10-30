/**
 * Which model the chat agent runs on, and what it costs.
 *
 * Claude Haiku 5.5 is cheaper than Gemini 2.5 Flash on both sides of the meter
 * ($0.10/$0.50 per 1M vs $0.30/$2.50), and output tokens dominate this app's
 * spend, so it is the default whenever an Anthropic key is present. Without one
 * the agent stays on Vertex, so a deploy that hasn't had the key added yet
 * keeps working instead of 500ing on every chat request.
 *
 * Claude is also servable through Vertex (`createVertexAnthropic` in
 * @ai-sdk/google-vertex/anthropic) using the GCP credentials already
 * configured, which avoids a second key entirely — but the models have to be
 * enabled for the project in Vertex Model Garden first, and only the `global`
 * location serves them. Until that's done this key-based path is the one that
 * works.
 */
export const USE_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY);

export const CHAT_MODEL = USE_CLAUDE ? "claude-haiku-5-5" : "gemini-2.5-flash";

/** Per-token prices for whichever model is active, used by the cost tracker. */
export const PRICING = USE_CLAUDE
  ? {
      // Claude Haiku 5.5, first-party API, prompts up to 100K tokens.
      input: 0.10 / 1_000_000,
      output: 0.50 / 1_000_000,
    }
  : {
      // Gemini 2.5 Flash on Vertex AI.
      input: 0.30 / 1_000_000,
      output: 2.50 / 1_000_000,
    };
