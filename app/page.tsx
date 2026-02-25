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
      const { SplatMesh } = await import("@sparkjsdev/spark");

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

      // A subtle reference grid you can disable later
      const grid = new THREE.GridHelper(12, 24, 0x334455, 0x223344);
      (grid.material as any).transparent = true;
      (grid.material as any).opacity = 0.25;
      scene.add(grid);

      // Floor (for non-mesh worlds and as fallback)
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(200, 200),
        new THREE.MeshStandardMaterial({ color: 0x0b0f17, metalness: 0.0, roughness: 1.0 })
      );
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -0.01;
      floor.receiveShadow = true;
      scene.add(floor);

      const gltfLoader = new GLTFLoader();

      // For grounding the rig on collider mesh (simple raycast)
      let colliderRoot: any = null;
      let colliderMeshes: any[] = [];

      function collectColliderMeshes(root: any) {
        colliderMeshes = [];
        root.traverse((o: any) => {
          if (o?.isMesh) {
            colliderMeshes.push(o);
          }
        });
      }

      const downRay = new THREE.Raycaster();
      const tmpVec = new THREE.Vector3();

      // Locomotion (thumbstick)
      const move = { x: 0, z: 0 };
      const speed = 1.8; // meters/sec
      const clock = new THREE.Clock();

      function updateLocomotion(dt: number) {
        const session = renderer.xr.getSession();
        if (!session) return;

        let ax = 0, ay = 0;
        for (const src of session.inputSources) {
          const gp = (src as any)?.gamepad;
          if (!gp || !gp.axes || gp.axes.length < 2) continue;

          // Heuristic:
          // - some controllers use axes[2,3] for thumbstick; some use [0,1]
          const a0 = gp.axes[0] ?? 0;
          const a1 = gp.axes[1] ?? 0;
          const a2 = gp.axes[2] ?? 0;
          const a3 = gp.axes[3] ?? 0;

          // pick the pair with larger magnitude
          const mag01 = Math.abs(a0) + Math.abs(a1);
          const mag23 = Math.abs(a2) + Math.abs(a3);
          if (mag23 > mag01) { ax = a2; ay = a3; } else { ax = a0; ay = a1; }

          // Use first usable gamepad (Quest controllers)
          break;
        }

        // Deadzone
        const dz = 0.15;
        move.x = Math.abs(ax) > dz ? ax : 0;
        move.z = Math.abs(ay) > dz ? ay : 0;

        if (move.x === 0 && move.z === 0) return;

        // Forward/right based on camera direction (XZ plane)
        const camWorld = new THREE.Vector3();
        camera.getWorldPosition(camWorld);

        const forward = new THREE.Vector3();
        camera.getWorldDirection(forward);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

        const delta = new THREE.Vector3()
          .addScaledVector(right, move.x)
          .addScaledVector(forward, -move.z)
          .multiplyScalar(speed * dt);

        rig.position.add(delta);
      }

      function groundRig() {
        if (!colliderMeshes.length) return;

        // Raycast from rig downwards
        tmpVec.copy(rig.position);
        tmpVec.y += 3.0;

        downRay.set(tmpVec, new THREE.Vector3(0, -1, 0));
        downRay.far = 20;

        const hits = downRay.intersectObjects(colliderMeshes, true);
        if (!hits.length) return;

        const y = hits[0].point.y;
        // Keep headset ~1.6m above ground; because rig holds camera at y=1.6 by default
        rig.position.y = y;
      }

      // Active world objects
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
          // Make it mostly invisible but raycastable.
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

        // Spark SplatMesh supports .spz directly (streamed)
        splat = new SplatMesh({ url: spz.url });
        splat.position.set(0, 0, 0);
        // Some splats come in rotated; you can adjust here if needed.
        scene.add(splat);

        // Spawn rig slightly back so you don't start inside the cloud
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
      try { runtimeRef.current?.dispose?.(); } catch {}
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

      let done = false;
      let last: any = null;

      while (!done) {
        await new Promise((res) => setTimeout(res, 1500));
        const opRes = await fetch(`/api/operations/${opId}`);
        const op = await opRes.json();
        last = op;

        if (!opRes.ok) throw new Error(op?.error || "Operation polling failed.");

        if (op?.error?.message) throw new Error(op.error.message);
        done = Boolean(op?.done);

        const pct = typeof op?.metadata?.progress === "number" ? Math.round(op.metadata.progress * 100) : null;
        setStatus(done ? "Finalizing…" : pct !== null ? `Generating… ${pct}%` : "Generating…");
      }

      const w: World | null = last?.response ?? null;
      if (!w?.world_id) throw new Error("Operation completed but no world returned.");

      // Fetch the latest world snapshot (recommended by docs)
      const wRes = await fetch(`/api/worlds/${w.world_id}`);
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
              placeholder="Describe a location… (up to 2000 chars)"
              spellCheck={false}
            />
            <button className="btn" onClick={generate} disabled={busy || !prompt.trim()}>
              {busy ? "Working…" : "Generate"}
            </button>
          </div>

          <div className="meta" style={{ marginTop: 10 }}>
            <div className="pill"><span style={{ color: "var(--muted)" }}>Status:</span> {status}</div>
            {world?.world_id ? (
              <div className="pill">
                <span style={{ color: "var(--muted)" }}>World:</span>{" "}
                <a href={world.world_marble_url} target="_blank" rel="noreferrer">{world.world_id.slice(0, 8)}…</a>
              </div>
            ) : null}
            {spzInfo ? (
              <div className="pill"><span style={{ color: "var(--muted)" }}>SPZ:</span> {spzInfo.key}</div>
            ) : null}
          </div>

          {error ? (
            <div className="hint statusBad">
              {error}
            </div>
          ) : (
            <div className="hint">
              Quest: open this site in the Quest browser, click <b>ENTER VR</b>, then generate. Movement: use thumbstick (smooth locomotion).
              <br />
              Splats are rendered via Spark’s <code>SplatMesh</code> which supports <code>.spz</code> directly. 
            </div>
          )}
        </div>
      </div>
    </>
  );
}
