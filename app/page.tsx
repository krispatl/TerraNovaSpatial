"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type AnyObj = Record<string, any>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/**
 * Prefer structured URL locations if present, otherwise fallback to regex scan.
 * This supports both:
 * - operation.response (WorldLabs op payload)
 * - /api/worlds/:id payload
 */
function findFirstSpzUrl(payload: any): string | null {
  try {
    const structured =
      payload?.assets?.splats?.spz_urls && Object.values(payload.assets.splats.spz_urls)[0];
    if (typeof structured === "string" && structured.includes(".spz")) return structured;

    const urls = payload?.assets?.splats?.spz_urls
      ? (Object.values(payload.assets.splats.spz_urls).filter((u) => typeof u === "string") as string[])
      : [];
    const hit = urls.find((u) => u.includes(".spz"));
    if (hit) return hit;

    const s = JSON.stringify(payload);
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

  // store pivot group here
  const splatRootRef = useRef<any>(null);

  // hero cam cancel token
  const camAnimCancelRef = useRef<{ cancel: boolean } | null>(null);

  const presets = useMemo(
    () => [
      "A vast cyberpunk train station in the rain, neon signage, wet reflective floors, cinematic lighting.",
      "An alien cathedral made of living light, towering arcs, sacred geometry, volumetric glow.",
      "A brutalist museum atrium, soft skylight, monumental concrete, ultra clean architectural lines.",
      "A bioluminescent forest with glowing mushrooms, mist, fireflies, dreamlike depth.",
      "A Barcelona gothic alley at night in the rain, sodium lamps, puddles, moody contrast.",
    ],
    []
  );

  const [prompt, setPrompt] = useState(presets[0]);
  const [busy, setBusy] = useState(false);

  const [status, setStatus] = useState<
    "Idle" | "Booting" | "Ready" | "Generating" | "Loading splat" | "Error"
  >("Idle");
  const [statusDetail, setStatusDetail] = useState("");

  const [lastWorldId, setLastWorldId] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  function statusDotColor() {
    switch (status) {
      case "Ready":
        return "rgba(124,255,178,0.95)";
      case "Error":
        return "rgba(255,120,120,0.95)";
      case "Generating":
      case "Loading splat":
      case "Booting":
        return "rgba(255,210,120,0.95)";
      default:
        return "rgba(200,200,200,0.7)";
    }
  }

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
        const { SplatMesh } = await import("@sparkjsdev/spark");

        if (disposed) return;

        const scene = new THREE.Scene();
        sceneRef.current = scene;

        const camera = new THREE.PerspectiveCamera(
          65,
          window.innerWidth / window.innerHeight,
          0.05,
          8000
        );
        camera.position.set(0, 1.6, 2.2);
        cameraRef.current = camera;

        const renderer = new THREE.WebGLRenderer({ antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));

        // demo look
        renderer.outputColorSpace = THREE.SRGBColorSpace;
        renderer.toneMapping = THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = 1.25;
        (renderer as any).physicallyCorrectLights = true;

        renderer.xr.enabled = true;
        rendererRef.current = renderer;

        mountRef.current.innerHTML = "";
        mountRef.current.appendChild(renderer.domElement);

        if (vrButtonRef.current) {
          try {
            vrButtonRef.current.remove();
          } catch {}
          vrButtonRef.current = null;
        }
        const vrBtn = VRButton.createButton(renderer) as HTMLElement;
        vrButtonRef.current = vrBtn;
        document.body.appendChild(vrBtn);

        const controls = new OrbitControls(camera, renderer.domElement);
        controlsRef.current = controls;
        controls.enableDamping = true;
        controls.dampingFactor = 0.08;
        controls.enablePan = true;
        controls.minDistance = 0.2;
        controls.maxDistance = 2500;
        controls.target.set(0, 1.2, 0);
        controls.update();

        const onSessionStart = () => {
          if (controlsRef.current) controlsRef.current.enabled = false;
        };
        const onSessionEnd = () => {
          if (controlsRef.current) controlsRef.current.enabled = true;
        };
        renderer.xr.addEventListener("sessionstart", onSessionStart);
        renderer.xr.addEventListener("sessionend", onSessionEnd);

        // lighting
        scene.add(new THREE.AmbientLight(0xffffff, 0.35));
        scene.add(new THREE.HemisphereLight(0xbfdfff, 0x080820, 0.6));
        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(5, 10, 7);
        scene.add(sun);

        scene.fog = new THREE.FogExp2(0x05060a, 0.035);

        const onResize = () => {
          if (!rendererRef.current || !cameraRef.current) return;
          const cam = cameraRef.current;
          cam.aspect = window.innerWidth / window.innerHeight;
          cam.updateProjectionMatrix();
          rendererRef.current.setSize(window.innerWidth, window.innerHeight);
          rendererRef.current.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        };
        window.addEventListener("resize", onResize);

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
            const ease = 1 - Math.pow(1 - k, 3);

            cam.position.lerpVectors(startPos, endPos, ease);
            ctrls.target.lerpVectors(startTarget, endTarget, ease);
            ctrls.update();

            if (k < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }

        function frameCameraToObject(root: any, hero: boolean) {
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

          // “standing” target
          const target = new THREE.Vector3(center.x, box.min.y + size.y * 0.25, center.z);

          const radius = Math.max(size.x, size.y, size.z) * 0.5;
          const safeRadius = Math.max(radius, 0.75);

          const fov = (cam.fov * Math.PI) / 180;
          const fitDist = safeRadius / Math.tan(fov / 2);
          const distance = fitDist * 1.25;

          const dir = new THREE.Vector3(0.25, 0.18, 1).normalize();
          const endPos = target.clone().add(dir.multiplyScalar(distance));

          cam.near = Math.max(0.02, distance / 1500);
          cam.far = Math.max(8000, distance * 35);
          cam.updateProjectionMatrix();

          const startPos = target
            .clone()
            .add(new THREE.Vector3(0, safeRadius * 1.8, safeRadius * 3.2));
          const startTarget = target.clone().add(new THREE.Vector3(0, safeRadius * 0.15, 0));

          if (hero) animateCameraTo(startPos, endPos, startTarget, target, 2200);
          else {
            cancelHeroCam();
            cam.position.copy(endPos);
            ctrls.target.copy(target);
            ctrls.update();
          }
        }

        async function loadWorldAssets(worldPayload: AnyObj, opts?: { hero?: boolean }) {
          const hero = opts?.hero ?? true;

          const url = findFirstSpzUrl(worldPayload);
          if (!url) throw new Error("No .spz found in payload.");

          // remove old
          if (splatRootRef.current) {
            try {
              scene.remove(splatRootRef.current);
              splatRootRef.current.traverse?.((o: any) => o?.dispose?.());
            } catch {}
            splatRootRef.current = null;
          }

          setStatus("Loading splat");
          setStatusDetail("Streaming gaussian splats…");

          // Upright fix
          const pivot = new THREE.Group();
          pivot.rotation.x = Math.PI;

          const splat = new SplatMesh({ url });
          pivot.add(splat);

          scene.add(pivot);
          splatRootRef.current = pivot;

          await waitFrames(2);
          frameCameraToObject(pivot, hero);

          setStatus("Ready");
          setStatusDetail("");
        }

        (window as any).loadWorldAssets = loadWorldAssets;

        renderer.setAnimationLoop(() => {
          if (controlsRef.current && controlsRef.current.enabled) controlsRef.current.update();
          renderer.render(scene, camera);
        });

        // Load shared/cached world (single fetch; no infinite wait here)
        const params = new URLSearchParams(window.location.search);
        const shared = params.get("world");
        const cached = localStorage.getItem("lastWorld");
        const initialWorldId = shared || cached || "";

        if (initialWorldId) {
          setLastWorldId(initialWorldId);
          setShareUrl(
            `${window.location.origin}${window.location.pathname}?world=${initialWorldId}`
          );

          try {
            setStatusDetail("Loading saved world…");
            const resp = await fetch(`/api/worlds/${initialWorldId}`, { cache: "no-store" });
            if (resp.ok) {
              const w = await resp.json();
              await (window as any).loadWorldAssets(w, { hero: true });
            } else {
              setStatus("Ready");
              setStatusDetail("");
            }
          } catch {
            setStatus("Ready");
            setStatusDetail("");
          }
        } else {
          setStatus("Ready");
          setStatusDetail("");
        }

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

  async function copyShareLink() {
    try {
      const text = shareUrl || window.location.href;
      await navigator.clipboard.writeText(text);
      setStatusDetail("Copied share link.");
      setTimeout(() => setStatusDetail(""), 1200);
    } catch {
      setStatusDetail("Could not copy link.");
      setTimeout(() => setStatusDetail(""), 1500);
    }
  }

  /**
   * FAST + RELIABLE:
   * - Ask for Marble 0.1-mini
   * - Poll /api/operations/:id until op.done === true
   * - Use op.response directly (contains splat URLs) instead of waiting on /api/worlds/:id to publish assets
   */
  async function generate() {
    try {
      setBusy(true);
      setStatus("Generating");
      setStatusDetail("Starting…");

      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: prompt,
          model: "Marble 0.1-mini",
        }),
      });

      if (!r.ok) throw new Error(`Generate failed: ${r.status} ${r.statusText}`);

      const gen = await r.json();
      const opId = gen.operation_id;
      if (!opId) throw new Error("No operation_id returned.");

      const POLL_MS = 1200;

      while (true) {
        const opResp = await fetch(`/api/operations/${opId}`, { cache: "no-store" });
        if (!opResp.ok) {
          setStatusDetail(`Polling operation… (${opResp.status})`);
          await sleep(POLL_MS);
          continue;
        }

        const op = await opResp.json();

        // progress (best effort)
        const progress =
          op?.metadata?.progress ??
          op?.metadata?.percent ??
          op?.metadata?.percentage ??
          null;

        if (progress != null) setStatusDetail(`Generating… ${progress}%`);
        else setStatusDetail("Generating…");

        if (op?.error) {
          throw new Error(op.error?.message || "World generation failed.");
        }

        if (op?.done) {
          const world = op?.response;
          if (!world) throw new Error("Operation done but response missing.");

          const worldId = world?.world_id || op?.metadata?.world_id || "";
          if (worldId) {
            setLastWorldId(worldId);
            localStorage.setItem("lastWorld", worldId);
            const newShare = `${window.location.origin}${window.location.pathname}?world=${worldId}`;
            setShareUrl(newShare);
          }

          setStatus("Loading splat");
          setStatusDetail("Loading final assets…");

          await (window as any).loadWorldAssets(world, { hero: true });

          setBusy(false);
          return;
        }

        await sleep(POLL_MS);
      }
    } catch (err: any) {
      console.error(err);
      setStatus("Error");
      setStatusDetail(err?.message || String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />

      <div
        style={{
          position: "absolute",
          top: 18,
          left: 18,
          width: 480,
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
          {presets.map((p) => (
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
            {busy ? "Generating…" : "Generate World (Fast)"}
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
