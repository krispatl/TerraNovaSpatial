"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [prompt, setPrompt] = useState(
    "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, cinematic lighting."
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Idle.");

  useEffect(() => {
    if (!mountRef.current) return;

    // Inject import map once
    if (!document.getElementById("three-importmap")) {
      const script = document.createElement("script");
      script.type = "importmap";
      script.id = "three-importmap";
      script.textContent = JSON.stringify({
        imports: {
          three: "https://unpkg.com/three@0.178.0/build/three.module.js",
          "three/examples/jsm/":
            "https://unpkg.com/three@0.178.0/examples/jsm/",
        },
      });
      document.head.appendChild(script);
    }

    async function boot() {
      const THREE = await import("three");
      const { VRButton } = await import(
        "three/examples/jsm/webxr/VRButton.js"
      );

      const spark = await import(
        "https://sparkjs.dev/releases/spark/0.1.10/spark.module.js"
      );

      const SplatMesh = spark.SplatMesh;

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
      });

      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;

      mountRef.current!.appendChild(renderer.domElement);
      document.body.appendChild(VRButton.createButton(renderer));

      scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1));

      let splat: any = null;

      async function loadWorld(world: any) {
        const spz = JSON.stringify(world).match(/https:\/\/[^"]+\.spz/);
        if (!spz) throw new Error("No .spz found.");

        if (splat) scene.remove(splat);
        splat = new SplatMesh({ url: spz[0] });
        scene.add(splat);
      }

      renderer.setAnimationLoop(() => {
        renderer.render(scene, camera);
      });

      (window as any).loadWorldAssets = loadWorld;
    }

    boot();
  }, []);

  async function generate() {
    setBusy(true);
    setStatus("Starting…");

    const r = await fetch("/api/worlds/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: prompt }),
    });

    const gen = await r.json();

    const opId = gen.operation_id;

    while (true) {
      const op = await fetch(`/api/operations/${opId}`, {
        cache: "no-store",
      }).then((r) => r.json());

      if (op.metadata?.world_id) {
        const worldId = op.metadata.world_id;

        while (true) {
          const world = await fetch(`/api/worlds/${worldId}`, {
            cache: "no-store",
          }).then((r) => r.json());

          if (JSON.stringify(world).includes(".spz")) {
            setStatus("Loading…");
            await (window as any).loadWorldAssets(world);
            setStatus("Ready.");
            setBusy(false);
            return;
          }

          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      await new Promise((r) => setTimeout(r, 2000));
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
      </div>
    </>
  );
}
