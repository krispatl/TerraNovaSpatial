import { NextResponse } from "next/server";
import { getOperation } from "../../../../lib/worldlabs";

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const out = await getOperation(params.id);
    return NextResponse.json(out);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Operation fetch failed." }, { status: 500 });
  }
}
