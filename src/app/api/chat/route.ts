import { createAgentUIStreamResponse, UIMessage } from "ai";
import { createCourseAgent } from "@/lib/agents/course-agent";
import { setSessionId, setActiveTerm } from "@/lib/tools/schedule-tools";
import { checkBudget, recordUsage } from "@/lib/cost-tracker";
import { cookies } from "next/headers";
import { termHasSisData } from "@/lib/data";
import { CURRENT_TERM } from "@/lib/terms";

export const maxDuration = 60;

export async function POST(req: Request) {
  // Check budget before processing
  const budget = await checkBudget();
  if (!budget.allowed) {
    return new Response(
      `data: {"type":"start"}\n\ndata: {"type":"start-step"}\n\ndata: {"type":"text-start","id":"0"}\n\ndata: {"type":"text-delta","id":"0","delta":"Sorry, the API credits for this app have been used up. The service is temporarily unavailable."}\n\ndata: {"type":"text-end","id":"0"}\n\ndata: {"type":"finish-step"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
    );
  }

  const { messages, activeTerm: bodyTerm, selectedPrograms: bodyPrograms }: {
    messages: UIMessage[];
    activeTerm?: string;
    selectedPrograms?: string[];
  } = await req.json();

  const activeTerm = bodyTerm || CURRENT_TERM;
  const selectedPrograms = bodyPrograms || [];

  const cookieStore = await cookies();
  let sessionId = cookieStore.get("schedule_session")?.value;
  if (!sessionId) sessionId = "default";
  setSessionId(sessionId);
  setActiveTerm(activeTerm);

  // Read it from available_terms rather than naming a term: a future term
  // flips to having sections the moment SIS publishes them.
  const hasSisData = await termHasSisData(activeTerm);

  const agent = createCourseAgent(activeTerm, hasSisData, selectedPrograms);

  // Accumulated in memory across steps and written once in onFinish. Writing
  // per step meant two Supabase round trips between every LLM call, stalling a
  // stream the user was already reading.
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  try {
    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      onStepFinish: (event) => {
        const usage = event.usage;
        totalInputTokens += usage?.inputTokens || 0;
        totalOutputTokens += usage?.outputTokens || 0;
        console.log(`[cost] step: ${usage?.inputTokens || 0} in / ${usage?.outputTokens || 0} out`);
      },
      onFinish: async () => {
        // Runs after the response has streamed, so this is off the critical path.
        if (totalInputTokens || totalOutputTokens) {
          const total = await recordUsage(totalInputTokens, totalOutputTokens);
          console.log(`[cost] request: ${totalInputTokens} in / ${totalOutputTokens} out — running total: $${total.toFixed(4)}`);
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
