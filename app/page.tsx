"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type AnyObj = Record<string, any>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function findFirstSpzUrl(world: any): string | null {
  // Fast path: regex scan on stringified JSON (works with your current API shape)
  try {
    const s = JSON.stringify(world);
    const m = s.match(/https:\/\/[^"'\\s]+?\.spz/);
    return m?.[0] ?? null;
  } catch {
    return null;
  }
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<any>(null);
  const vrButtonRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<any>(null);

  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  // We store the pivot group (not the raw splat) so we can remove/replace cleanly.
  const splatRootRef = useRef<any>(null);

  // Smooth “hero” camera animation cancel token
  const camAnimCancelRef = useRef<{ cancel: boolean } | null>(null);

  const presets = useMemo(
    () => [
      "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, cinematic lighting.",
      "An alien cathedral made of living light, towering arcs, sacred geometry, volumetric glow.",
      "A brutalist museum atrium, soft skylight, monumental concrete, ultra clean architectural lines.",
      "A bioluminescent forest with glowing mushrooms, mist, fireflies, dreamlike depth.",
      "A Barcelona gothic alley at night in the rain, sodium lamps, puddles, moody contrast.",
      "Underwater ruins with shafts of light, drifting particles, ancient stone reliefs, serene.",
    ],
    []
  );

  const [prompt, setPrompt] = useState(presets[0]);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<
    "Idle" | "Booting" | "Ready" | "Generating" | "Waiting assets" | "Loading splat" | "Error"
  >("Idle");
  const [statusDetail, setStatusDetail] = useState<string>("");

  const [lastWorldId, setLastWorldId] = useState<string>("");
  const [shareUrl, setShareUrl] = useState<string>("");

  // --- Boot three/spark once ---
  useEffect(() => {
    let disposed = false;

    async function boot() {
      if (!mountRef.current) return;

      try {
        setStatus("Booting");
        setStatusDetail("Initializing renderer…");

        const THREE = await import("three");
        const { VRButton } = await import("three/examples/jsm/webxr/VRButton.js");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");

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

        // Quality + punch (demo polish)
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
        renderer.xr.enabled = true;

        // Some builds of three have this:
        (renderer as any).physicallyCorrectLights = true;

        rendererRef.current = renderer;

        // Mount canvas
        mountRef.current.innerHTML = "";
        mountRef.current.appendChild(renderer.domElement);

        // VR button (safe if device doesn't support XR)
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

        // Default target (gets overwritten when splat loads)
        controls.target.set(0, 1.2, 0);
        controls.update();

        // Disable orbit during XR sessions
        const onSessionStart = () => {
          if (controlsRef.current) controlsRef.current.enabled = false;
        };
        const onSessionEnd = () => {
          if (controlsRef.current) controlsRef.current.enabled = true;
        };
        renderer.xr.addEventListener("sessionstart", onSessionStart);
        renderer.xr.addEventListener("sessionend", onSessionEnd);

        // Lighting (more “product demo”)
        scene.add(new THREE.AmbientLight(0xffffff, 0.35));
        scene.add(new THREE.HemisphereLight(0xbfdfff, 0x080820, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(5, 10, 7);
        scene.add(sun);

        // Subtle fog for depth (optional but looks great in demos)
        scene.fog = new THREE.FogExp2(0x05060a, 0.035);

        // Resize
        const onResize = () => {
          if (!rendererRef.current || !cameraRef.current) return;
          const cam = cameraRef.current;
          cam.aspect = window.innerWidth / window.innerHeight;
          cam.updateProjectionMatrix();
          rendererRef.current.setSize(window.innerWidth, window.innerHeight);
          rendererRef.current.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        };
        window.addEventListener("resize", onResize);

        // Helpers
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

        function cancelHeroCam() {
          if (camAnimCancelRef.current) camAnimCancelRef.current.cancel = true;
          camAnimCancelRef.current = null;
        }

        function animateCameraTo(
          startPos: any,
          endPos: any,
          startTarget: any,
          endTarget: any,
          durationMs = 2200
        ) {
          cancelHeroCam();
          const token = { cancel: false };
          camAnimCancelRef.current = token;

          const cam = cameraRef.current;
          const ctrls = controlsRef.current;
          if (!cam || !ctrls) return;

          const t0 = performance.now();

          const tick = (t: number) => {
            if (token.cancel) return;

            const k = clamp((t - t0) / durationMs, 0, 1);
            // cubic ease-out
            const ease = 1 - Math.pow(1 - k, 3);

            cam.position.lerpVectors(startPos, endPos, ease);
            ctrls.target.lerpVectors(startTarget, endTarget, ease);

            ctrls.update();

            if (k < 1) requestAnimationFrame(tick);
          };

          requestAnimationFrame(tick);
        }

        function frameCameraToObject(root: any, doHeroMove: boolean) {
          const cam = cameraRef.current;
          const ctrls = controlsRef.current;
          if (!cam || !ctrls) return;

          root.updateMatrixWorld(true);

          const box = new THREE.Box3().setFromObject(root);
          if (!isFinite(box.min.x) || !isFinite(box.max.x) || box.isEmpty()) return;

          const center = new THREE.Vector3();
          const size = new THREE.Vector3();
          box.getCenter(center);
          box.getSize(size);

          // “standing” target: slightly above “floor”
          const target = new THREE.Vector3(
            center.x,
            box.min.y + size.y * 0.25,
            center.z
          );

          const radius = Math.max(size.x, size.y, size.z) * 0.5;
          const safeRadius = Math.max(radius, 0.75);

          const fov = (cam.fov * Math.PI) / 180;
          const fitDist = safeRadius / Math.tan(fov / 2);
          const distance = fitDist * 1.25;

          // Choose a pleasing viewing direction
          const dir = new THREE.Vector3(0.25, 0.18, 1).normalize();

          const endPos = target.clone().add(dir.multiplyScalar(distance));

          // Near/Far adjust
          cam.near = Math.max(0.02, distance / 1500);
          cam.far = Math.max(5000, distance * 30);
          cam.updateProjectionMatrix();

          const startPos = target.clone().add(new THREE.Vector3(0, safeRadius * 1.8, safeRadius * 3.2));
          const startTarget = target.clone().add(new THREE.Vector3(0, safeRadius * 0.15, 0));

          if (doHeroMove) {
            animateCameraTo(startPos, endPos, startTarget, target, 2200);
          } else {
            cancelHeroCam();
            cam.position.copy(endPos);
            ctrls.target.copy(target);
            ctrls.update();
          }
        }

        // Load splat (flip + center camera)
        async function loadWorldAssets(world: AnyObj, opts?: { hero?: boolean }) {
          const hero = opts?.hero ?? true;

          const url = findFirstSpzUrl(world);
          if (!url) {
            console.log("World payload (no .spz found):", world);
            throw new Error("No .spz found in world payload.");
          }

          // Remove previous
          if (splatRootRef.current) {
            try {
              scene.remove(splatRootRef.current);
              // best-effort dispose
              splatRootRef.current.traverse?.((o: any) => o?.dispose?.());
            } catch {}
            splatRootRef.current = null;
          }

          setStatus("Loading splat");
          setStatusDetail("Streaming gaussian splats…");

          // Pivot root (fix upside-down)
          const pivot = new THREE.Group();
          pivot.rotation.x = Math.PI; // <— common upright fix

          const splat = new SplatMesh({ url });
          pivot.add(splat);

          scene.add(pivot);
          splatRootRef.current = pivot;

          // Wait a couple frames for matrices, then frame camera
          await waitFrames(2);
          frameCameraToObject(pivot, hero);

          setStatus("Ready");
          setStatusDetail("");
        }

        (window as any).loadWorldAssets = loadWorldAssets;

        // Render loop
        renderer.setAnimationLoop(() => {
          // OrbitControls needs update for damping
          if (controlsRef.current && controlsRef.current.enabled) {
            controlsRef.current.update();
          }
          renderer.render(scene, camera);
        });

        // If a shared world is in URL, load it immediately; else load last cached world
        const urlParams = new URLSearchParams(window.location.search);
        const sharedWorld = urlParams.get("world");
        const cachedWorld = localStorage.getItem("lastWorld") || "";
        const initialWorld = sharedWorld || cachedWorld;

        if (initialWorld) {
          setLastWorldId(initialWorld);
          setShareUrl(`${window.location.origin}${window.location.pathname}?world=${initialWorld}`);
          setStatus("Loading splat");
          setStatusDetail("Loading saved world…");
          try {
            const w = await fetch(`/api/worlds/${initialWorld}`, { cache: "no-store" }).then((r) =>
              r.json()
            );
            await (window as any).loadWorldAssets(w, { hero: true });
          } catch (e) {
            console.warn("Failed to load initial world:", e);
            setStatus("Ready");
            setStatusDetail("");
          }
        } else {
          setStatus("Ready");
          setStatusDetail("");
        }

        // Cleanup
        return () => {
          window.removeEventListener("resize", onResize);
          renderer.xr.removeEventListener("sessionstart", onSessionStart);
          renderer.xr.removeEventListener("sessionend", onSessionEnd);
          cancelHeroCam();
        };
      } catch (err: any) {
        console.error(err);
        setStatus("Error");
        setStatusDetail(err?.message || String(err));
      }
    }

    let cleanup: (() => void) | null = null;
    boot().then((c) => {
      if (typeof c === "function") cleanup = c;
    });

    return () => {
      disposed = true;

      try {
        cleanup?.();
      } catch {}

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
      setStatus("Generating");
      setStatusDetail("Queued → generating world…");

      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      if (!r.ok) throw new Error(`Generate failed: ${r.status} ${r.statusText}`);

      const gen = await r.json();
      const opId = gen.operation_id;
      if (!opId) throw new Error("No operation_id returned.");

      const t0 = Date.now();
      const MAX_MS = 3 * 60 * 1000; // 3 min hard timeout for demo safety
      let pollOpDelay = 1200;
      let pollWorldDelay = 1800;

      // Poll operation until world_id appears
      while (true) {
        if (Date.now() - t0 > MAX_MS) throw new Error("Timed out waiting for generation.");

        const op = await fetch(`/api/operations/${opId}`, { cache: "no-store" }).then((x) =>
          x.json()
        );

        if (op?.metadata?.world_id) {
          const worldId = op.metadata.world_id as string;

          setLastWorldId(worldId);
          localStorage.setItem("lastWorld", worldId);
          const newShare = `${window.location.origin}${window.location.pathname}?world=${worldId}`;
          setShareUrl(newShare);

          setStatus("Waiting assets");
          setStatusDetail("Generating → uploading assets…");

          // Poll world until it includes .spz
          while (true) {
            if (Date.now() - t0 > MAX_MS) throw new Error("Timed out waiting for assets.");

            const world = await fetch(`/api/worlds/${worldId}`, { cache: "no-store" }).then((x) =>
              x.json()
            );

            const spz = findFirstSpzUrl(world);
            if (spz) {
              setStatus("Loading splat");
              setStatusDetail("Streaming geometry…");

              if (typeof (window as any).loadWorldAssets !== "function") {
                throw new Error("Renderer not ready yet (loadWorldAssets missing).");
              }

              await (window as any).loadWorldAssets(world, { hero: true });

              setBusy(false);
              return;
            }

            await sleep(pollWorldDelay);
            pollWorldDelay = Math.min(5000, Math.floor(pollWorldDelay * 1.18));
          }
        }

        await sleep(pollOpDelay);
        pollOpDelay = Math.min(3500, Math.floor(pollOpDelay * 1.15));
      }
    } catch (err: any) {
      console.error(err);
      setStatus("Error");
      setStatusDetail(err?.message || String(err));
      setBusy(false);
    }
  }

  async function copyShareLink() {
    try {
      const text = shareUrl || window.location.href;
      await navigator.clipboard.writeText(text);
      setStatusDetail("Copied share link.");
      setTimeout(() => {
        setStatusDetail("");
      }, 1200);
    } catch {
      setStatusDetail("Could not copy link (clipboard blocked).");
      setTimeout(() => setStatusDetail(""), 1500);
    }
  }

  function statusDotColor() {
    switch (status) {
      case "Ready":
        return "rgba(124,255,178,0.95)";
      case "Error":
        return "rgba(255,120,120,0.95)";
      case "Generating":
      case "Waiting assets":
      case "Loading splat":
      case "Booting":
        return "rgba(255,210,120,0.95)";
      default:
        return "rgba(200,200,200,0.7)";
    }
  }

  return (
    <>
      <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />

      {/* Top-left HUD */}
      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          width: 460,
          background: "rgba(0,0,0,0.62)",
          border: "1px solid rgba(255,255,255,0.10)",
          padding: 14,
          borderRadius: 14,
          color: "rgba(255,255,255,0.92)",
          backdropFilter: "blur(10px)",
          boxShadow: "0 18px 50px rgba(0,0,0,0.45)",
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              background: statusDotColor(),
              boxShadow: "0 0 16px rgba(255,255,255,0.25)",
            }}
          />
          <div style={{ fontWeight: 700, letterSpacing: 0.2 }}>TERRANOVA SPATIAL</div>
          <div style={{ marginLeft: "auto", opacity: 0.75, fontSize: 12 }}>
            {lastWorldId ? `World ${lastWorldId.slice(0, 8)}…` : "—"}
          </div>
        </div>

        <div style={{ marginTop: 8, opacity: 0.78, fontSize: 13 }}>
          Status: <span style={{ fontWeight: 600 }}>{status}</span>
          {statusDetail ? <span style={{ opacity: 0.85 }}> — {statusDetail}</span> : null}
        </div>

        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {presets.slice(0, 5).map((p) => (
            <button
              key={p}
              onClick={() => setPrompt(p)}
              style={{
                cursor: "pointer",
                fontSize: 12,
                padding: "8px 10px",
                borderRadius: 999,
                border: "1px solid rgba(255,255,255,0.14)",
                background: prompt === p ? "rgba(183,185,255,0.22)" : "rgba(255,255,255,0.06)",
                color: "rgba(255,255,255,0.92)",
              }}
            >
              {p.length > 28 ? p.slice(0, 28) + "…" : p}
            </button>
          ))}
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{
            marginTop: 10,
            width: "100%",
            height: 86,
            resize: "none",
            borderRadius: 12,
            padding: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.35)",
            color: "rgba(255,255,255,0.92)",
            outline: "none",
            lineHeight: 1.25,
          }}
        />

        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          <button
            onClick={generate}
            disabled={busy}
            style={{
              cursor: busy ? "not-allowed" : "pointer",
              flex: 1,
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: busy ? "rgba(255,255,255,0.08)" : "rgba(124,255,178,0.18)",
              color: "rgba(255,255,255,0.92)",
              fontWeight: 700,
              letterSpacing: 0.2,
            }}
          >
            {busy ? "Generating…" : "Generate World"}
          </button>

          <button
            onClick={copyShareLink}
            disabled={!lastWorldId}
            style={{
              cursor: !lastWorldId ? "not-allowed" : "pointer",
              padding: "10px 12px",
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.14)",
              background: !lastWorldId ? "rgba(255,255,255,0.06)" : "rgba(124,180,255,0.16)",
              color: "rgba(255,255,255,0.92)",
              fontWeight: 700,
            }}
            title={shareUrl || ""}
          >
            Share
          </button>
        </div>

        {shareUrl ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.75, wordBreak: "break-all" }}>
            {shareUrl}
          </div>
        ) : null}

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.65 }}>
          Tip: drag to orbit, scroll to zoom. VR button appears when supported.
        </div>
      </div>

      {/* Fullscreen loading veil (demo polish) */}
      {busy && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "radial-gradient(1200px 700px at 20% 20%, rgba(183,185,255,0.10), rgba(0,0,0,0.0) 60%), rgba(0,0,0,0.18)",
          }}
        />
      )}
    </>
  );
}
