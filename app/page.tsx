"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type WorldAssets = {
  imagery?: { pano_url?: string };
  mesh?: { collider_mesh_url?: string };
  splats?: { spz_urls?: Record<string, string> };
  thumbnail_url?: string;
  caption?: string;
};

type World = {
  world_id: string;
  display_name?: string;
  world_marble_url?: string;
  assets?: WorldAssets;
};

function pickBestSpz(spz_urls?: Record<string, string>): { key: string; url: string } | null {
  if (!spz_urls) return null;
  const entries = Object.entries(spz_urls).filter(([, url]) => typeof url === "string" && url.length > 0);
  if (!entries.length) return null;

  // Prefer higher-detail keys if present; fall back to first.
  const prefs = ["10m", "5m", "2m", "1m", "500k", "300k", "200k", "100k", "50k"];
  for (const p of prefs) {
    const hit = entries.find(([k]) => k.toLowerCase() === p);
    if (hit) return { key: hit[0], url: hit[1] };
  }

  // Some APIs might use numeric-ish keys; try largest number found.
  const numeric = entries
    .map(([k, url]) => ({ k, url, n: Number(String(k).replace(/[^0-9]/g, "")) }))
    .filter((x) => Number.isFinite(x.n) && x.n > 0)
    .sort((a, b) => b.n - a.n);

  if (numeric.length) return { key: numeric[0].k, url: numeric[0].url };

  return { key: entries[0][0], url: entries[0][1] };
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const [prompt, setPrompt] = useState(
    "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, distant crowds, cinematic lighting."
  );
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("Idle.");
  const [error, setError] = useState<string | null>(null);

  const [world, setWorld] = useState<World | null>(null);

  // Three.js runtime refs (kept in a single object so we can dispose cleanly)
  const runtimeRef = useRef<any>(null);

  const canRender = useMemo(() => !!mountRef.current, [mountRef.current]);

  useEffect(() => {
    if (!mountRef.current) return;

    let disposed = false;

    async function boot() {
      // Dynamic imports to keep everything client-only.
      const THREE = await import("three");
      const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");
      const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
      // IMPORTANT: load Spark at runtime via CDN so Next/Vercel doesn't try to bundle it.
      const { SplatMesh } = await import(
        /* webpackIgnore: true */ "https://esm.sh/@sparkjsdev/spark@0.1.10"
      );

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

      // Basic lighting (splats don't need it, but mesh does)
      const hemi = new THREE.HemisphereLight(0xffffff, 0x222233, 0.9);
      scene.add(hemi);

      const dir = new THREE.DirectionalLight(0xffffff, 0.55);
      dir.position.set(3, 6, 2);
      scene.add(dir);

      // A subtle reference grid
      const grid = new THREE.GridHelper(12, 24, 0x334455, 0x223344);
      (grid.material as any).transparent = true;
      (grid.material as any).opacity = 0.25;
      scene.add(grid);

      // Floor (fallback)
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({ color: 0x0b0f17, metalness: 0.0, roughness: 1.0 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      scene.add(floor);

      const gltfLoader = new GLTFLoader();

      // Collider mesh handling (raycast)
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

      // Smooth locomotion via thumbstick
      const speed = 1.8; // m/s
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

        const delta = new THREE.Vector3()
          .addScaledVector(right, mx)
          .addScaledVector(forward, -mz)
          .multiplyScalar(speed * dt);

        rig.position.add(delta);
      }

      function groundRig() {
        if (!colliderMeshes.length) return;

        tmpVec.copy(rig.position);
        tmpVec.y += 3.0;

        downRay.set(tmpVec, new THREE.Vector3(0, -1, 0));
        downRay.far = 20;

        const hits = downRay.intersectObjects(colliderMeshes, true);
        if (!hits.length) return;

        const y = hits[0].point.y;
        rig.position.y = y; // camera is at y=1.6 inside rig
      }

      // Active world object refs
      let splat: any = null;

      async function loadWorldAssets(w: World) {
        const assets = w.assets || {};
        const panoUrl = assets.imagery?.pano_url;
        const meshUrl = assets.mesh?.collider_mesh_url;
        const spz = pickBestSpz(assets.splats?.spz_urls);

        // 1) background pano
        if (panoUrl) {
          const tex = await new THREE.TextureLoader().loadAsync(panoUrl);
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          scene.background = tex;
        }

        // 2) collider mesh
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

        // 3) SPZ splats (day one)
        if (!spz?.url) throw new Error("No SPZ splat URL found in world assets.");

        if (splat) scene.remove(splat);

        // Spark SplatMesh supports .spz directly
        splat = new (SplatMesh as any)({ url: spz.url });
        splat.position.set(0, 0, 0);
        scene.add(splat);

        // Spawn rig slightly back
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
        THREE,
        scene,
        camera,
        renderer,
        rig,
        loadWorldAssets,
        dispose() {
          window.removeEventListener("resize", onResize);
          renderer.setAnimationLoop(null as any);
          renderer.dispose();
          if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
          const vrBtn = document.getElementById("VRButton");
          if (vrBtn && vrBtn.parentNode) vrBtn.parentNode.removeChild(vrBtn);
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

  async function generate() {
    setBusy(true);
    setError(null);
    setStatus("Starting generation…");

    try {
      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: prompt.trim(),
          model: "Marble 0.1-plus",
        }),
      });

      const gen = await r.json();
      if (!r.ok) throw new Error(gen?.error || "Generate failed.");

      const opId = gen.operation_id as string;
      if (!opId) throw new Error("No operation_id returned.");

      setStatus(`Generating… (operation ${opId.slice(0, 8)}…)`);

      // --- Poll operation until we get world_id (World Labs returns it in metadata) ---
      const started = Date.now();
      const MAX_MS = 6 * 60 * 1000; // 6 minutes
      let attempt = 0;

      let last: any = null;

      while (true) {
        const delay = Math.min(1500 + attempt * 300, 6000);
        await new Promise((res) => setTimeout(res, delay));
        attempt++;

        const opRes = await fetch(`/api/operations/${opId}`, { cache: "no-store" });
        const op = await opRes.json();
        last = op;

        if (!opRes.ok) throw new Error(op?.error || "Operation polling failed.");
        if (op?.error?.message) throw new Error(op.error.message);

        const statusText =
          op?.metadata?.progress?.description ||
          op?.metadata?.progress?.status ||
          "World generation in progress";

        setStatus(statusText);

        const worldId =
          op?.metadata?.world_id ||
          op?.metadata?.worldId ||
          op?.response?.world_id ||
          op?.response?.world?.world_id;

        // ✅ KEY FIX: break as soon as we have world_id (even if done=false / response=null)
        if (worldId) {
          last = { ...op, response: { world_id: worldId } };
          break;
        }

        if (op?.done === true) break;

        if (Date.now() - started > MAX_MS) {
          throw new Error("Timed out waiting for world_id from operation.");
        }
      }

      const w: any = last?.response ?? null;
      if (!w?.world_id) throw new Error("No world_id found after polling.");

      // Fetch full world snapshot
      const wRes = await fetch(`/api/worlds/${w.world_id}`, { cache: "no-store" });
      const wFull = await wRes.json();
      if (!wRes.ok) throw new Error(wFull?.error || "Failed to fetch world.");

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

  const spzInfo = pickBestSpz(world?.assets?.splats?.spz_urls);

  return (
    <>
      <div className="canvasWrap" ref={mountRef} />

      <div className="ui">
        <div className="panel">
          <div className="row">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe a location…"
              spellCheck={false}
            />
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
                <span style={{ color: "var(--muted)" }}>World:</span>{" "}
                {world.world_marble_url ? (
                  <a href={world.world_marble_url} target="_blank" rel="noreferrer">
                    {world.world_id.slice(0, 8)}…
                  </a>
                ) : (
                  <span>{world.world_id.slice(0, 8)}…</span>
                )}
              </div>
            ) : null}

            {spzInfo ? (
              <div className="pill">
                <span style={{ color: "var(--muted)" }}>SPZ:</span> {spzInfo.key}
              </div>
            ) : null}
          </div>

          {error ? (
            <div className="hint statusBad">{error}</div>
          ) : (
            <div className="hint">
              Quest: open this site in Quest Browser, click <b>ENTER VR</b>, then Generate.
              <br />
              Movement: thumbstick (smooth locomotion).
            </div>
          )}
        </div>
      </div>
    </>
  );
}
