import { NextResponse } from "next/server";
import { getWorld } from "../../../../lib/worldlabs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const out = await getWorld(params.id);
    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "World fetch failed." }, { status: 500 });
  }
}
