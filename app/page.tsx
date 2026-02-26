"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<any>(null);
  const vrButtonRef = useRef<HTMLElement | null>(null);
  const splatRef = useRef<any>(null);

  const [prompt, setPrompt] = useState(
    "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, cinematic lighting."
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Idle.");

  useEffect(() => {
    let disposed = false;

    async function boot() {
      if (!mountRef.current) return;

      try {
        setStatus("Booting…");

        // Load Three + helpers from your installed deps (NOT CDN import maps)
        const THREE = await import("three");
        const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");

        // ✅ Load Spark from npm (this is the critical fix for Vercel)
        const { SplatMesh } = await import("@sparkjsdev/spark");

        if (disposed) return;

        // --- Scene ---
        const scene = new THREE.Scene();

        const camera = new THREE.PerspectiveCamera(
          65,
          window.innerWidth / window.innerHeight,
          0.05,
          2000
        );
        camera.position.set(0, 1.6, 2.2);

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.xr.enabled = true;

        // Save renderer so we can clean up
        rendererRef.current = renderer;

        // Mount canvas
        mountRef.current.innerHTML = "";
        mountRef.current.appendChild(renderer.domElement);

        // Add VR button (avoid duplicates on HMR / re-mount)
        if (vrButtonRef.current) {
          try {
            vrButtonRef.current.remove();
          } catch {}
          vrButtonRef.current = null;
        }
        const vrBtn = VRButton.createButton(renderer) as HTMLElement;
        vrButtonRef.current = vrBtn;
        document.body.appendChild(vrBtn);

        // Lighting
        scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1));

        // Resize handling
        const onResize = () => {
          if (!rendererRef.current) return;
          const r = rendererRef.current;
          camera.aspect = window.innerWidth / window.innerHeight;
          camera.updateProjectionMatrix();
          r.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener("resize", onResize);

        // Load splat from the WorldLabs world JSON
        async function loadWorld(world: any) {
          const match = JSON.stringify(world).match(/https:\/\/[^"]+\.spz/);
          if (!match) throw new Error("No .spz found in world payload.");

          const url = match[0];

          // Remove prior splat
          if (splatRef.current) {
            try {
              scene.remove(splatRef.current);
              // Spark meshes are THREE objects; dispose if available
              splatRef.current?.dispose?.();
            } catch {}
            splatRef.current = null;
          }

          const splat = new SplatMesh({ url });
          splatRef.current = splat;

          // Optional: tweak orientation/position if needed
          // splat.position.set(0, 0, -3);

          scene.add(splat);
        }

        (window as any).loadWorldAssets = loadWorld;

        renderer.setAnimationLoop(() => {
          renderer.render(scene, camera);
        });

        setStatus("Ready.");
      } catch (err: any) {
        console.error(err);
        setStatus(`Boot error: ${err?.message || String(err)}`);
      }
    }

    boot();

    return () => {
      disposed = true;

      // Stop XR loop + dispose renderer
      try {
        if (rendererRef.current) {
          rendererRef.current.setAnimationLoop(null);
          rendererRef.current.dispose?.();
        }
      } catch {}

      rendererRef.current = null;

      // Remove VR button if present
      try {
        if (vrButtonRef.current) vrButtonRef.current.remove();
      } catch {}
      vrButtonRef.current = null;

      // Clear splat
      try {
        splatRef.current?.dispose?.();
      } catch {}
      splatRef.current = null;
    };
  }, []);

  async function generate() {
    try {
      setBusy(true);
      setStatus("Starting…");

      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });

      if (!r.ok) throw new Error(`Generate failed: ${r.status} ${r.statusText}`);

      const gen = await r.json();
      const opId = gen.operation_id;
      if (!opId) throw new Error("No operation_id returned.");

      // Poll operation until it yields a world_id
      while (true) {
        const op = await fetch(`/api/operations/${opId}`, { cache: "no-store" }).then(
          (x) => x.json()
        );

        if (op?.metadata?.world_id) {
          const worldId = op.metadata.world_id;

          // Poll world until it contains .spz
          while (true) {
            const world = await fetch(`/api/worlds/${worldId}`, { cache: "no-store" }).then(
              (x) => x.json()
            );

            if (JSON.stringify(world).includes(".spz")) {
              setStatus("Loading…");
              if (typeof (window as any).loadWorldAssets !== "function") {
                throw new Error("Renderer not ready yet (loadWorldAssets missing).");
              }
              await (window as any).loadWorldAssets(world);
              setStatus("Ready.");
              setBusy(false);
              return;
            }

            await new Promise((res) => setTimeout(res, 3000));
          }
        }

        await new Promise((res) => setTimeout(res, 2000));
      }
    } catch (err: any) {
      console.error(err);
      setStatus(`Error: ${err?.message || String(err)}`);
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
      </div>
    </>
  );
}
