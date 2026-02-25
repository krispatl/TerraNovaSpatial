import { NextResponse } from "next/server";
import { generateWorld } from "../../../../lib/worldlabs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const text = String(body?.text || "").trim();
    if (!text) return NextResponse.json({ error: "Missing 'text' prompt." }, { status: 400 });

    const displayName = typeof body?.displayName === "string" ? body.displayName : null;
    const model = body?.model === "Marble 0.1-mini" ? "Marble 0.1-mini" : "Marble 0.1-plus";
    const seed = typeof body?.seed === "number" ? body.seed : null;

    const out = await generateWorld({ text, displayName: displayName ?? undefined, model, seed: seed ?? undefined });
    // out: {done, operation_id, ...}
    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Generate failed." }, { status: 500 });
  }
}
