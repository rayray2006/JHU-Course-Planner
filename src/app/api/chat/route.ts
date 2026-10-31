import { createAgentUIStreamResponse, UIMessage } from "ai";
import { createCourseAgent } from "@/lib/agents/course-agent";
import { setSessionId, setActiveTerm } from "@/lib/tools/schedule-tools";
import { checkBudget, recordUsage } from "@/lib/cost-tracker";
import { resolveSessionId } from "@/lib/session";
import { termHasSisData } from "@/lib/data";
import { CURRENT_TERM } from "@/lib/terms";

export const maxDuration = 60;

export async function POST(req: Request) {
  // Parse first — it needs no network, and activeTerm is the only input the
  // lookups below depend on.
  const { messages, activeTerm: bodyTerm, selectedPrograms: bodyPrograms }: {
    messages: UIMessage[];
    activeTerm?: string;
    selectedPrograms?: string[];
  } = await req.json();

  const activeTerm = bodyTerm || CURRENT_TERM;
  const selectedPrograms = bodyPrograms || [];

  // These three used to run one after another, so every chat request paid
  // three serial Supabase round trips (~350ms each) before the model was even
  // asked anything. Nothing here depends on anything else here.
  //
  // resolveSessionId must still finish before the stream opens: a cookie
  // cannot be set once the response has started streaming.
  const [budget, hasSisData, sessionId] = await Promise.all([
    checkBudget(),
    // Read it from available_terms rather than naming a term: a future term
    // flips to having sections the moment SIS publishes them.
    termHasSisData(activeTerm),
    resolveSessionId(),
  ]);

  if (!budget.allowed) {
    return new Response(
      `data: {"type":"start"}\n\ndata: {"type":"start-step"}\n\ndata: {"type":"text-start","id":"0"}\n\ndata: {"type":"text-delta","id":"0","delta":"Sorry, the API credits for this app have been used up. The service is temporarily unavailable."}\n\ndata: {"type":"text-end","id":"0"}\n\ndata: {"type":"finish-step"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
    );
  }

  setSessionId(sessionId);
  setActiveTerm(activeTerm);

  const agent = createCourseAgent(activeTerm, hasSisData, selectedPrograms);

  // Accumulated in memory across steps and written once in onFinish. Writing
  // per step meant two Supabase round trips between every LLM call, stalling a
  // stream the user was already reading.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  try {
    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      onStepFinish: (event) => {
        const usage = event.usage;
        const cacheRead = usage?.inputTokenDetails?.cacheReadTokens || 0;
        const cacheWrite = usage?.inputTokenDetails?.cacheWriteTokens || 0;
        totalInputTokens += usage?.inputTokens || 0;
        totalOutputTokens += usage?.outputTokens || 0;
        totalCacheRead += cacheRead;
        totalCacheWrite += cacheWrite;
        console.log(
          `[cost] step: ${usage?.inputTokens || 0} in (${cacheRead} cached, ${cacheWrite} written) / ${usage?.outputTokens || 0} out`
        );
      },
      onFinish: async () => {
        // Runs after the response has streamed, so this is off the critical path.
        if (totalInputTokens || totalOutputTokens) {
          const total = await recordUsage(totalInputTokens, totalOutputTokens, totalCacheRead, totalCacheWrite);
          console.log(
            `[cost] request: ${totalInputTokens} in (${totalCacheRead} cached, ${totalCacheWrite} written) / ${totalOutputTokens} out — running total: $${total.toFixed(4)}`
          );
        }
      },
      onError: (error) => {
        console.error("[chat agent error]", error);
        return String(error);
      },
    });
  } catch (e) {
    console.error("[chat route error]", e);
    return new Response(JSON.stringify({ error: "Agent failed" }), { status: 500 });
  }
}
