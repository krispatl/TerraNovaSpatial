export const WORLDLABS_BASE = "https://api.worldlabs.ai/marble/v1";

function requireKey(): string {
  const key = process.env.WORLDS_API_KEY || process.env.WLT_API_KEY || process.env.WORLDLABS_API_KEY;
  if (!key) {
    throw new Error("Missing WORLDS_API_KEY env var (set this in Vercel).");
  }
  return key;
}

export async function worldlabsFetch(path: string, init: RequestInit = {}) {
  const key = requireKey();
  const url = `${WORLDLABS_BASE}${path.startsWith("/") ? "" : "/"}${path}`;

  const headers = new Headers(init.headers);
  headers.set("WLT-Api-Key", key);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const res = await fetch(url, { ...init, headers, cache: "no-store" });
  const text = await res.text();

  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = typeof data === "object" && data?.detail ? JSON.stringify(data.detail) : JSON.stringify(data);
    throw new Error(`World Labs API error ${res.status}: ${msg}`);
  }
  return data;
}

export type GenerateRequest = {
  text: string;
  displayName?: string;
  model?: "Marble 0.1-mini" | "Marble 0.1-plus";
  seed?: number;
  tags?: string[];
  public?: boolean;
};

export async function generateWorld(req: GenerateRequest) {
  const body = {
    world_prompt: {
      disable_recaption: true,
      text_prompt: req.text,
      type: "text",
    },
    display_name: req.displayName ?? null,
    model: req.model ?? "Marble 0.1-plus",
    permission: {
      allowed_readers: [],
      allowed_writers: [],
      public: Boolean(req.public),
    },
    seed: typeof req.seed === "number" ? req.seed : null,
    tags: req.tags ?? null,
  };

  return worldlabsFetch("/worlds:generate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export async function getOperation(operationId: string) {
  return worldlabsFetch(`/operations/${operationId}`, { method: "GET" });
}

export async function getWorld(worldId: string) {
  return worldlabsFetch(`/worlds/${worldId}`, { method: "GET" });
}
