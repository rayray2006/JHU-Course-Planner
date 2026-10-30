import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { CURRENT_TERM } from "@/lib/terms";

export async function GET() {
  const { data, error } = await supabase
    .from("available_terms")
    .select("term, sort_order, has_sis_data, course_count, is_current")
    .order("sort_order");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const currentTerm = data?.find((t) => t.is_current)?.term || CURRENT_TERM;

  return NextResponse.json({ terms: data || [], currentTerm });
}
