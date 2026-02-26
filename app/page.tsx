"use client";

import { useEffect, useRef, useState } from "react";

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<any>(null);
  const vrButtonRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<any>(null);

  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  // We store the pivot group here (not the raw splat), so we can remove/replace cleanly.
  const splatRootRef = useRef<any>(null);

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

        const THREE = await import("three");
        const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");
        const { OrbitControls } = await import(
          "three/examples/jsm/controls/OrbitControls.js"
        );

        // Spark from npm (Vercel-safe)
        const { SplatMesh } = await import("@sparkjsdev/spark");

        if (disposed) return;

        // ---------- Scene ----------
        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
          65,
          window.innerWidth / window.innerHeight,
          0.05,
          5000
        );
        camera.position.set(0, 1.6, 2.2);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.xr.enabled = true;
        rendererRef.current = renderer;

        // Mount canvas
        mountRef.current.innerHTML = "";
        mountRef.current.appendChild(renderer.domElement);

        // VR button (will show not supported if not available)
        if (vrButtonRef.current) {
          try {
            vrButtonRef.current.remove();
          } catch {}
          vrButtonRef.current = null;
        }
        const vrBtn = VRButton.createButton(renderer) as HTMLElement;
        vrButtonRef.current = vrBtn;
        document.body.appendChild(vrBtn);

        // Orbit controls (mouse/touch navigation)
        const controls = new OrbitControls(camera, renderer.domElement);
        controlsRef.current = controls;

        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        controls.screenSpacePanning = false;

        controls.minDistance = 0.2;
        controls.maxDistance = 2000;

        // Default target (will be overwritten when splat loads)
        controls.target.set(0, 1.2, 0);
        controls.update();

        // Disable OrbitControls during XR sessions
        const onSessionStart = () => {
          if (controlsRef.current) controlsRef.current.enabled = false;
        };
        const onSessionEnd = () => {
          if (controlsRef.current) controlsRef.current.enabled = true;
        };
        renderer.xr.addEventListener("sessionstart", onSessionStart);
        renderer.xr.addEventListener("sessionend", onSessionEnd);

        // Lighting
        scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 1));

        // Resize
        const onResize = () => {
          if (!rendererRef.current || !cameraRef.current) return;
          const cam = cameraRef.current;
          cam.aspect = window.innerWidth / window.innerHeight;
          cam.updateProjectionMatrix();
          rendererRef.current.setSize(window.innerWidth, window.innerHeight);
        };
        window.addEventListener("resize", onResize);

        // Helper: wait a couple frames so the object has matrices ready
        const waitFrames = (n: number) =>
          new Promise<void>((resolve) => {
            let i = 0;
            const tick = () => {
              i++;
              if (i >= n) resolve();
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          });

        // Helper: center camera + controls on an Object3D (pivot)
        function frameCameraToObject(root: any) {
          const cam = cameraRef.current;
          const ctrls = controlsRef.current;
          const r = rendererRef.current;
          if (!cam || !ctrls || !r) return;

          // Compute world bounds
          root.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(root);

          // If the box is empty (rare), just bail
          if (!isFinite(box.min.x) || !isFinite(box.max.x) || box.isEmpty()) return;

          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);

          // Rough radius
          const radius = Math.max(size.x, size.y, size.z) * 0.5;
          const safeRadius = Math.max(radius, 0.5);

          // Choose a start direction (slightly above and back)
          const dir = new THREE.Vector3(0.25, 0.25, 1).normalize();

          // Distance based on FOV so it fits nicely
          const fov = (cam.fov * Math.PI) / 180;
          const fitDist = safeRadius / Math.tan(fov / 2);

          const distance = fitDist * 1.15; // padding
          const newPos = center.clone().add(dir.multiplyScalar(distance));

          cam.position.copy(newPos);

          // Keep near/far sane for big worlds
          cam.near = Math.max(0.01, distance / 1000);
          cam.far = Math.max(5000, distance * 20);
          cam.updateProjectionMatrix();

          ctrls.target.copy(center);
          ctrls.update();
        }

        // Load world splat + flip + frame camera to center
        async function loadWorld(world: any) {
          const match = JSON.stringify(world).match(/https:\/\/[^"]+\.spz/);
          if (!match) throw new Error("No .spz found in world payload.");
          const url = match[0];

          // Remove prior splat root
          if (splatRootRef.current) {
            try {
              scene.remove(splatRootRef.current);
              // if Spark exposes dispose on mesh, this tries to clean it up
              splatRootRef.current?.traverse?.((o: any) => o?.dispose?.());
            } catch {}
            splatRootRef.current = null;
          }

          setStatus("Loading splat…");

          // Pivot root (so we can rotate/transform cleanly)
          const pivot = new THREE.Group();

          // ✅ Fix upside-down: most common is 180° around X
          pivot.rotation.x = Math.PI;

          // If you ever find it's still rotated weirdly, try toggling:
          // pivot.rotation.y = Math.PI;
          // pivot.rotation.z = Math.PI / 2;

          const splat = new SplatMesh({ url });
          pivot.add(splat);

          scene.add(pivot);
          splatRootRef.current = pivot;

          // Wait a couple frames so the object/matrices settle, then frame camera
          await waitFrames(2);
          frameCameraToObject(pivot);

          setStatus("Ready.");
        }

        (window as any).loadWorldAssets = loadWorld;

        // Render loop
        renderer.setAnimationLoop(() => {
          if (controlsRef.current && controlsRef.current.enabled) {
            controlsRef.current.update();
          }
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

      try {
        if (rendererRef.current) {
          rendererRef.current.setAnimationLoop(null);
          rendererRef.current.dispose?.();
        }
      } catch {}
      rendererRef.current = null;

      try {
        controlsRef.current?.dispose?.();
      } catch {}
      controlsRef.current = null;

      try {
        if (vrButtonRef.current) vrButtonRef.current.remove();
      } catch {}
      vrButtonRef.current = null;

      try {
        if (sceneRef.current && splatRootRef.current) {
          sceneRef.current.remove(splatRootRef.current);
        }
      } catch {}
      splatRootRef.current = null;

      cameraRef.current = null;
      sceneRef.current = null;
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
        const op = await fetch(`/api/operations/${opId}`, {
          cache: "no-store",
        }).then((x) => x.json());

        if (op?.metadata?.world_id) {
          const worldId = op.metadata.world_id;

          // Poll world until it contains .spz
          while (true) {
            const world = await fetch(`/api/worlds/${worldId}`, {
              cache: "no-store",
            }).then((x) => x.json());

            if (JSON.stringify(world).includes(".spz")) {
              setStatus("Loading…");
              if (typeof (window as any).loadWorldAssets !== "function") {
                throw new Error("Renderer not ready yet (loadWorldAssets missing).");
              }
              await (window as any).loadWorldAssets(world);
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
