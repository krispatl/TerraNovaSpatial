"use client";

import { useEffect, useRef, useState } from "react";

type Operation = {
  operation_id: string;
  done?: boolean;
  error?: any;
  metadata?: any;
  response?: any;
};

type World = {
  world_id: string;
  world_marble_url?: string;
  display_name?: string;
  assets?: any;
  [k: string]: any;
};

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

function findUrlsDeep(obj: any, exts: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<any>();
  const extsLower = exts.map((e) => e.toLowerCase());

  function walk(x: any) {
    if (!x || typeof x !== "object") return;
    if (seen.has(x)) return;
    seen.add(x);

    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }

    for (const k of Object.keys(x)) {
      const v = x[k];
      if (typeof v === "string") {
        const s = v.toLowerCase();
        if (extsLower.some((e) => s.includes(e))) out.push(v);
      } else if (typeof v === "object") {
        walk(v);
      }
    }
  }

  walk(obj);
  return Array.from(new Set(out));
}

function pickBestUrl(urls: string[]): string {
  if (!urls.length) return "";
  return urls[0];
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<any>(null);

  const [prompt, setPrompt] = useState(
    "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, cinematic lighting."
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Idle.");
  const [error, setError] = useState<string | null>(null);
  const [debugOp, setDebugOp] = useState<any>(null);
  const [debugWorld, setDebugWorld] = useState<any>(null);

  // =============================
  // VIEWER BOOT
  // =============================
  useEffect(() => {
    if (!mountRef.current) return;

    let disposed = false;

    async function boot() {
      const THREE = await import("three");
      const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");

      // @ts-expect-error - remote URL module
      const spark = await import(
        /* webpackIgnore: true */
        "https://sparkjs.dev/releases/spark/0.1.10/spark.module.js"
      );

      const SplatMesh = (spark as any).SplatMesh;

      if (disposed || !mountRef.current) return;

      const scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(
        65,
        window.innerWidth / window.innerHeight,
        0.05,
        2000
      );
      camera.position.set(0, 1.6, 2.2);

      const renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;

      mountRef.current.appendChild(renderer.domElement);
      document.body.appendChild(VRButton.createButton(renderer));

      const rig = new THREE.Group();
      rig.add(camera);
      scene.add(rig);

      scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1));
      scene.add(new THREE.GridHelper(12, 24));

      const gltfLoader = new GLTFLoader();

      let splat: any = null;

      async function loadWorldAssets(w: World) {
        const spzCandidates = findUrlsDeep(w, [".spz"]);
        const spzUrl = pickBestUrl(spzCandidates);

        if (!spzUrl) {
          console.log("World JSON:", w);
          throw new Error("No .spz URL found in world payload.");
        }

        if (splat) scene.remove(splat);

        splat = new SplatMesh({ url: spzUrl });
        scene.add(splat);

        rig.position.set(0, 0, 2.5);
      }

      const clock = new THREE.Clock();

      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
      });

      runtimeRef.current = {
        loadWorldAssets,
        dispose() {
          renderer.setAnimationLoop(null as any);
          renderer.dispose();
        },
      };
    }

    boot().catch((e) => {
      console.error(e);
      setError(String(e?.message || e));
    });

    return () => {
      disposed = true;
      runtimeRef.current?.dispose?.();
      runtimeRef.current = null;
    };
  }, []);

  // =============================
  // GENERATION FLOW
  // =============================

  async function waitForWorldId(operationId: string) {
    while (true) {
      const r = await fetch(`/api/operations/${operationId}`, {
        cache: "no-store",
      });

      const op = (await r.json()) as Operation;
      setDebugOp(op);

      const wid = op?.metadata?.world_id;
      if (wid) return wid;

      await sleep(2000);
    }
  }

  async function waitForSpz(worldId: string) {
    while (true) {
      const r = await fetch(`/api/worlds/${worldId}`, {
        cache: "no-store",
      });

      const w = (await r.json()) as World;
      setDebugWorld(w);

      const spz = findUrlsDeep(w, [".spz"]);
      if (spz.length) return w;

      await sleep(3000);
    }
  }

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus("Starting generation…");

    try {
      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt.trim(), model: "Marble 0.1-plus" }),
      });

      const gen = await r.json();
      if (!r.ok) throw new Error(gen?.error || "Generate failed.");

      const operationId = gen.operation_id;
      setStatus("Waiting for world_id…");

      const wid = await waitForWorldId(operationId);
      setStatus("Waiting for splats…");

      const w = await waitForSpz(wid);

      setStatus("Loading viewer…");

      const rt = runtimeRef.current;
      if (!rt?.loadWorldAssets) throw new Error("Viewer not ready.");

      await rt.loadWorldAssets(w);

      setStatus("Ready. Enter VR.");
    } catch (e: any) {
      setError(e?.message || String(e));
      setStatus("Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />

      <div
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          width: 420,
          background: "rgba(0,0,0,0.75)",
          padding: 16,
          borderRadius: 12,
          color: "white",
        }}
      >
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ width: "100%", height: 80 }}
        />
        <button
          onClick={generate}
          disabled={busy}
          style={{ marginTop: 10, width: "100%" }}
        >
          {busy ? "Working…" : "Generate"}
        </button>

        <div style={{ marginTop: 10 }}>Status: {status}</div>
        {error && <div style={{ color: "red" }}>{error}</div>}

        <details style={{ marginTop: 10 }}>
          <summary>Debug</summary>
          <pre style={{ fontSize: 11 }}>
            {JSON.stringify(
              { lastOperation: debugOp, lastWorld: debugWorld },
              null,
              2
            )}
          </pre>
        </details>
      </div>
    </>
  );
}
