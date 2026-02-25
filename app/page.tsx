"use client";

import { useEffect, useRef, useState } from "react";

type World = {
  world_id: string;
  display_name?: string;
  world_marble_url?: string;
  assets?: any;
  [k: string]: any;
};

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
  // crude heuristic: prefer urls that include higher-detail tokens
  const prefs = ["10m", "5m", "2m", "1m", "500k", "300k", "200k", "100k", "50k"];
  const lower = urls.map((u) => u.toLowerCase());
  for (const p of prefs) {
    const idx = lower.findIndex((u) => u.includes(p));
    if (idx >= 0) return urls[idx];
  }
  return urls[0];
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<any>(null);

  const [prompt, setPrompt] = useState(
    "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, distant crowds, cinematic lighting."
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Idle.");
  const [error, setError] = useState<string | null>(null);
  const [world, setWorld] = useState<World | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    let disposed = false;

    async function boot() {
      const THREE = await import("three");
      const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");

      // Spark via CDN so Vercel/Next doesn’t bundle it.
      const spark = await import(/* webpackIgnore: true */ "https://esm.sh/@sparkjsdev/spark@0.1.10");
      const SplatMesh = (spark as any).SplatMesh;

      if (disposed || !mountRef.current) return;

      const scene = new THREE.Scene();

      const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 2000);
      camera.position.set(0, 1.6, 2.2);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.xr.enabled = true;

      mountRef.current.appendChild(renderer.domElement);
      document.body.appendChild(VRButton.createButton(renderer));

      const rig = new THREE.Group();
      rig.add(camera);
      scene.add(rig);

      // lighting
      scene.add(new THREE.HemisphereLight(0xffffff, 0x222233, 0.9));
      const dir = new THREE.DirectionalLight(0xffffff, 0.55);
      dir.position.set(3, 6, 2);
      scene.add(dir);

      // grid + fallback floor
      const grid = new THREE.GridHelper(12, 24, 0x334455, 0x223344);
      (grid.material as any).transparent = true;
      (grid.material as any).opacity = 0.25;
      scene.add(grid);

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({ color: 0x0b0f17, metalness: 0.0, roughness: 1.0 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      scene.add(floor);

      const gltfLoader = new GLTFLoader();

      // collider grounding
      let colliderRoot: any = null;
      let colliderMeshes: any[] = [];

      function collectColliderMeshes(root: any) {
        colliderMeshes = [];
        root.traverse((o: any) => {
          if (o?.isMesh) colliderMeshes.push(o);
        });
      }

      const downRay = new THREE.Raycaster();
      const tmpVec = new THREE.Vector3();

      function groundRig() {
        if (!colliderMeshes.length) return;
        tmpVec.copy(rig.position);
        tmpVec.y += 3.0;
        downRay.set(tmpVec, new THREE.Vector3(0, -1, 0));
        downRay.far = 20;
        const hits = downRay.intersectObjects(colliderMeshes, true);
        if (!hits.length) return;
        rig.position.y = hits[0].point.y;
      }

      // locomotion
      const speed = 1.8;
      const clock = new THREE.Clock();

      function updateLocomotion(dt: number) {
        const session = renderer.xr.getSession();
        if (!session) return;

        let ax = 0,
          ay = 0;

        for (const src of session.inputSources) {
          const gp = (src as any)?.gamepad;
          if (!gp || !gp.axes || gp.axes.length < 2) continue;

          const a0 = gp.axes[0] ?? 0;
          const a1 = gp.axes[1] ?? 0;
          const a2 = gp.axes[2] ?? 0;
          const a3 = gp.axes[3] ?? 0;

          const mag01 = Math.abs(a0) + Math.abs(a1);
          const mag23 = Math.abs(a2) + Math.abs(a3);
          if (mag23 > mag01) {
            ax = a2;
            ay = a3;
          } else {
            ax = a0;
            ay = a1;
          }
          break;
        }

        const dz = 0.15;
        const mx = Math.abs(ax) > dz ? ax : 0;
        const mz = Math.abs(ay) > dz ? ay : 0;
        if (mx === 0 && mz === 0) return;

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        rig.position.addScaledVector(right, mx * speed * dt);
        rig.position.addScaledVector(forward, -mz * speed * dt);
      }

      let splat: any = null;

      async function loadWorldAssets(w: World) {
        const assets = w.assets || {};
        const panoUrl = assets?.imagery?.pano_url;
        const meshUrl = assets?.mesh?.collider_mesh_url;

        // Find a .spz anywhere in the world JSON
        const spzCandidates = findUrlsDeep(w, [".spz"]);
        if (!spzCandidates.length) {
          console.log("World JSON (no .spz found):", w);
          throw new Error("No .spz URL found anywhere in world JSON.");
        }
        const spzUrl = pickBestUrl(spzCandidates);

        if (panoUrl) {
          const tex = await new THREE.TextureLoader().loadAsync(panoUrl);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          scene.background = tex;
        }

        if (meshUrl) {
          const gltf = await gltfLoader.loadAsync(meshUrl);
          if (colliderRoot) scene.remove(colliderRoot);
          colliderRoot = gltf.scene;

          colliderRoot.traverse((o: any) => {
            if (o?.isMesh) {
              o.material = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.0 });
              o.frustumCulled = false;
            }
          });

          scene.add(colliderRoot);
          collectColliderMeshes(colliderRoot);
        }

        if (splat) scene.remove(splat);
        splat = new (SplatMesh as any)({ url: spzUrl });
        scene.add(splat);

        rig.position.set(0, 0, 2.5);
        groundRig();
      }

      function onResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      }
      window.addEventListener("resize", onResize);

      renderer.setAnimationLoop(() => {
        const dt = Math.min(clock.getDelta(), 0.05);
        updateLocomotion(dt);
        groundRig();
        renderer.render(scene, camera);
      });

      runtimeRef.current = {
        loadWorldAssets,
        dispose() {
          window.removeEventListener("resize", onResize);
          renderer.setAnimationLoop(null as any);
          renderer.dispose();
          if (renderer.domElement?.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
          const vrBtn = document.getElementById("VRButton");
          if (vrBtn?.parentNode) vrBtn.parentNode.removeChild(vrBtn);
        },
      };
    }

    boot().catch((e) => {
      console.error(e);
      setError(String(e?.message || e));
    });

    return () => {
      disposed = true;
      try {
        runtimeRef.current?.dispose?.();
      } catch {}
      runtimeRef.current = null;
    };
  }, []);

  async function waitForWorldWithSplats(worldId: string) {
    const started = Date.now();
    const MAX_MS = 8 * 60 * 1000; // splats can take time
    let attempt = 0;

    while (true) {
      const wRes = await fetch(`/api/worlds/${worldId}`, { cache: "no-store" });
      const w = await wRes.json();
      if (!wRes.ok) throw new Error(w?.error || "Failed to fetch world.");

      // Do we have a .spz anywhere yet?
      const spz = findUrlsDeep(w, [".spz"]);
      if (spz.length) return w as World;

      // Still baking
      const msg =
        w?.assets?.splats?.progress?.description ||
        w?.status ||
        "Waiting for splats to finish…";
      setStatus(typeof msg === "string" ? msg : "Waiting for splats to finish…");

      if (Date.now() - started > MAX_MS) {
        console.log("World JSON (timed out waiting for .spz):", w);
        throw new Error("Timed out waiting for .spz splat URLs to appear in world JSON.");
      }

      const delay = Math.min(2000 + attempt * 400, 7000);
      attempt++;
      await sleep(delay);
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

      const opId = gen.operation_id as string;
      if (!opId) throw new Error("No operation_id returned.");

      // Poll operation until we have world_id
      const started = Date.now();
      const MAX_MS = 6 * 60 * 1000;
      let attempt = 0;
      let worldId: string | null = null;

      while (!worldId) {
        const delay = Math.min(1500 + attempt * 300, 6000);
        await sleep(delay);
        attempt++;

        const opRes = await fetch(`/api/operations/${opId}`, { cache: "no-store" });
        const op = await opRes.json();

        if (!opRes.ok) throw new Error(op?.error || "Operation polling failed.");
        if (op?.error?.message) throw new Error(op.error.message);

        setStatus(op?.metadata?.progress?.description || op?.metadata?.progress?.status || "Generating…");

        worldId = op?.metadata?.world_id || null;

        if (Date.now() - started > MAX_MS) throw new Error("Timed out waiting for world_id from operation.");
      }

      setStatus("World created. Waiting for splats…");

      // ✅ NEW: wait until splats exist
      const wFull = await waitForWorldWithSplats(worldId);

      setWorld(wFull);
      setStatus("Loading assets into WebXR viewer…");

      const rt = runtimeRef.current;
      if (!rt?.loadWorldAssets) throw new Error("Viewer not ready.");
      await rt.loadWorldAssets(wFull);

      setStatus("Ready. Enter VR to explore.");
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
      setStatus("Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="canvasWrap" ref={mountRef} />
      <div className="ui">
        <div className="panel">
          <div className="row">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Describe a location…" />
            <button className="btn" onClick={generate} disabled={busy || !prompt.trim()}>
              {busy ? "Working…" : "Generate"}
            </button>
          </div>

          <div className="meta" style={{ marginTop: 10 }}>
            <div className="pill">
              <span style={{ color: "var(--muted)" }}>Status:</span> {status}
            </div>
            {world?.world_id ? (
              <div className="pill">
                <span style={{ color: "var(--muted)" }}>World:</span> {world.world_id.slice(0, 8)}…
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="hint statusBad">{error}</div>
          ) : (
            <div className="hint">
              Quest: open in Quest Browser, click <b>ENTER VR</b>, then Generate. Movement: thumbstick.
            </div>
          )}
        </div>
      </div>
    </>
  );
}
