# World Labs → WebXR (Quest) — Splats Day One

A **straight web** (no Unity) Next.js app you can deploy on **Vercel**, that:

- Generates Marble worlds from **text-only prompts**
- Polls the World Labs **operations** endpoint until done
- Loads the returned assets into a **Three.js WebXR** scene
- Renders **SPZ gaussian splats** (day one) using **Spark** (`@sparkjsdev/spark`)

## 1) Setup

### Env var (Vercel + local)
Set **one** of these (the app checks them in order):

- `WORLDS_API_KEY` (recommended)
- `WLT_API_KEY`
- `WORLDLABS_API_KEY`

Value = your `WLT-Api-Key`.

## 2) Run locally

```bash
npm install
npm run dev
```

Open http://localhost:3000

> WebXR requires HTTPS for headset browsing. For local Quest testing, deploy to Vercel or use an HTTPS tunnel.

## 3) Deploy to Vercel

- Import this repo into Vercel
- Add env var `WORLDS_API_KEY`
- Deploy
- Open the URL in **Quest Browser**
- Click **ENTER VR**, then Generate

## Notes

- World generation uses `POST /marble/v1/worlds:generate` with a text prompt.  
- Polls `GET /marble/v1/operations/{id}` until `done=true`.  
- Fetches the full world from `GET /marble/v1/worlds/{world_id}` (recommended by docs).

World Labs API docs:
- Generate World: https://docs.worldlabs.ai/api/reference/worlds/generate
- Get Operation: https://docs.worldlabs.ai/api/reference/operations/get
- Get World: https://docs.worldlabs.ai/api/reference/worlds/get

Spark (SPZ renderer for Three.js):
- https://github.com/sparkjsdev/spark

## Controls

- **VR**: click ENTER VR (bottom-right)
- **Move**: thumbstick (smooth locomotion)
