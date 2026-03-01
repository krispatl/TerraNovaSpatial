"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type AnyObj = Record<string, any>;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

type ModelChoice = "Marble 0.1-mini" | "Marble 0.1-plus";
type SplatResChoice = "auto" | "100k" | "500k" | "full_res";

/**
 * Pick a .spz URL from a world payload based on a requested resolution key.
 * - If choice is "auto", we pick best available order: 500k -> 100k -> full_res -> first found.
 */
function pickSpzUrl(payload: any, choice: SplatResChoice): { url: string | null; key?: string } {
  try {
    const spzUrls = payload?.assets?.splats?.spz_urls;
    if (spzUrls && typeof spzUrls === "object") {
      const entries = Object.entries(spzUrls).filter(
        ([, v]) => typeof v === "string" && (v as string).includes(".spz")
      ) as Array<[string, string]>;

      if (entries.length === 0) return { url: null };

      const map = new Map(entries);

      const tryKeys =
        choice === "auto"
          ? ["500k", "100k", "full_res"]
          : [choice];

      for (const k of tryKeys) {
        if (map.has(k)) return { url: map.get(k)!, key: k };
      }

      // fallback: first available
      const [k0, u0] = entries[0];
      return { url: u0, key: k0 };
    }

    // Fallback regex scan
    const s = JSON.stringify(payload);
    const m = s.match(/https:\/\/[^"'\\s]+?\.spz/);
    return { url: m?.[0] ?? null };
  } catch {
    return { url: null };
  }
}

function makeFileNameFromUrl(url: string, fallback = "terranova_splat.spz") {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop() || fallback;
    return base.endsWith(".spz") ? base : `${base}.spz`;
  } catch {
    return fallback;
  }
}

async function downloadUrl(url: string, filename: string) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
    return;
  } catch {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.target = "_blank";
    a.rel = "noreferrer";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export default function Home() {
  const mountRef = useRef<HTMLDivElement | null>(null);

  const rendererRef = useRef<any>(null);
  const vrButtonRef = useRef<HTMLElement | null>(null);
  const controlsRef = useRef<any>(null);

  const sceneRef = useRef<any>(null);
  const cameraRef = useRef<any>(null);

  const splatRootRef = useRef<any>(null);
  const currentSpzUrlRef = useRef<string | null>(null);

  const camAnimCancelRef = useRef<{ cancel: boolean } | null>(null);

  const presets = useMemo(
    () => [
      "Barcelona Gothic alleyway at night after rain, wet cobblestones, warm sodium street lamps, subtle neon reflections, cinematic depth of field, realistic scale, ultra-detailed.",
      "Futuristic metro platform, glossy tiles, soft volumetric light shafts, puddles and reflections, cinematic wide shot, realistic scale, high detail.",
      "Minimalist sci-fi atrium, white stone + brushed metal, skylight grid, sunbeams with volumetric fog, calm museum-grade lighting, wide-angle, realistic scale.",
      "Industrial warehouse gallery, concrete floor, overhead truss lights, haze, strong perspective lines, cinematic contrast, realistic scale.",
      "Underground tunnel with LED strips, wet floor reflections, moody fog, strong vanishing point, cinematic lighting, realistic scale.",
      "Cyberpunk street market under a canopy, neon signage, rain mist, reflective puddles, crowd silhouettes, cinematic lighting, realistic scale, detailed textures.",
    ],
    []
  );

  const [prompt, setPrompt] = useState(presets[0]);

  // NEW: model + splat resolution dropdowns
  const [modelChoice, setModelChoice] = useState<ModelChoice>("Marble 0.1-mini");
  const [splatResChoice, setSplatResChoice] = useState<SplatResChoice>("auto");

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<
    "Idle" | "Booting" | "Ready" | "Generating" | "Loading splat" | "Error"
  >("Idle");
  const [statusDetail, setStatusDetail] = useState("");

  const [lastWorldId, setLastWorldId] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  // progress bar
  const [progress, setProgress] = useState(0);
  const fakeProgressRef = useRef<number | null>(null);

  function startFakeProgress() {
    stopFakeProgress();
    setProgress(2);
    let p = 2;
    fakeProgressRef.current = window.setInterval(() => {
      const remaining = 92 - p;
      const step = Math.max(0.15, remaining * 0.02);
      p = Math.min(92, p + step);
      setProgress(p);
    }, 140);
  }
  function stopFakeProgress() {
    if (fakeProgressRef.current != null) {
      window.clearInterval(fakeProgressRef.current);
      fakeProgressRef.current = null;
    }
  }
  function finishProgress() {
    stopFakeProgress();
    setProgress(100);
    window.setTimeout(() => setProgress(0), 450);
  }

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

          const picked = pickSpzUrl(worldPayload, splatResChoice);
          if (!picked.url) throw new Error("No .spz found in payload.");
          currentSpzUrlRef.current = picked.url;

          // remove old
          if (splatRootRef.current) {
            try {
              scene.remove(splatRootRef.current);
              splatRootRef.current.traverse?.((o: any) => o?.dispose?.());
            } catch {}
            splatRootRef.current = null;
          }

          setStatus("Loading splat");
          setStatusDetail(
            picked.key ? `Streaming splat (${picked.key})…` : "Streaming gaussian splats…"
          );

          // Upright fix
          const pivot = new THREE.Group();
          pivot.rotation.x = Math.PI;

          const splat = new SplatMesh({ url: picked.url });
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

        // Load shared/cached world
        const params = new URLSearchParams(window.location.search);
        const shared = params.get("world");
        const cached = localStorage.getItem("lastWorld");
        const initialWorldId = shared || cached || "";

        if (initialWorldId) {
          setLastWorldId(initialWorldId);
          setShareUrl(`${window.location.origin}${window.location.pathname}?world=${initialWorldId}`);
          try {
            setStatusDetail("Loading saved world…");
            const resp = await fetch(`/api/worlds/${initialWorldId}`, { cache: "no-store" });
            if (resp.ok) {
              const w = await resp.json();
              await (window as any).loadWorldAssets(w, { hero: true });
            }
          } catch {
            // ignore
          }
        }

        setStatus("Ready");
        setStatusDetail("");

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
      stopFakeProgress();
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
        if (sceneRef.current && splatRootRef.current) sceneRef.current.remove(splatRootRef.current);
      } catch {}
      splatRootRef.current = null;

      cameraRef.current = null;
      sceneRef.current = null;
    };
  }, [splatResChoice]); // re-pick url on next load when selection changes

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

  async function downloadCurrentSplat() {
    const url = currentSpzUrlRef.current;
    if (!url) {
      setStatusDetail("No splat loaded yet.");
      setTimeout(() => setStatusDetail(""), 1200);
      return;
    }
    setStatusDetail("Downloading .spz…");
    const name = makeFileNameFromUrl(
      url,
      lastWorldId ? `world_${lastWorldId}_${splatResChoice}.spz` : "terranova_splat.spz"
    );
    await downloadUrl(url, name);
    setStatusDetail("Download started.");
    setTimeout(() => setStatusDetail(""), 1200);
  }

  async function generate() {
    try {
      setBusy(true);
      setStatus("Generating");
      setStatusDetail("Starting…");
      startFakeProgress();

      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: prompt,
          model: modelChoice,
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

        const progressRaw =
          op?.metadata?.progress ??
          op?.metadata?.percent ??
          op?.metadata?.percentage ??
          op?.progress ??
          null;

        const parsed =
          typeof progressRaw === "number"
            ? progressRaw
            : typeof progressRaw === "string"
              ? Number(progressRaw)
              : null;

        if (parsed != null && isFinite(parsed)) {
          const p = parsed <= 1 ? parsed * 100 : parsed;
          const cp = clamp(p, 0, 99);
          setProgress(cp);
          setStatusDetail(`Generating… ${Math.round(cp)}%`);
        } else {
          setStatusDetail("Generating…");
        }

        if (op?.error) throw new Error(op.error?.message || "World generation failed.");

        if (op?.done) {
          const world = op?.response;
          if (!world) throw new Error("Operation done but response missing.");

          const worldId = world?.world_id || op?.metadata?.world_id || "";
          if (worldId) {
            setLastWorldId(worldId);
            localStorage.setItem("lastWorld", worldId);
            setShareUrl(`${window.location.origin}${window.location.pathname}?world=${worldId}`);
          }

          setStatus("Loading splat");
          setStatusDetail("Loading final assets…");

          await (window as any).loadWorldAssets(world, { hero: true });

          finishProgress();
          setBusy(false);
          return;
        }

        await sleep(POLL_MS);
      }
    } catch (err: any) {
      console.error(err);
      stopFakeProgress();
      setProgress(0);
      setStatus("Error");
      setStatusDetail(err?.message || String(err));
      setBusy(false);
    }
  }

  function startFakeProgress() {
    stopFakeProgress();
    setProgress(2);
    let p = 2;
    fakeProgressRef.current = window.setInterval(() => {
      const remaining = 92 - p;
      const step = Math.max(0.15, remaining * 0.02);
      p = Math.min(92, p + step);
      setProgress(p);
    }, 140);
  }

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 16,
    left: 16,
    width: 560,
    maxWidth: "calc(100vw - 32px)",
    background: "linear-gradient(180deg, rgba(12,12,14,0.78), rgba(12,12,14,0.56))",
    border: "1px solid rgba(255,255,255,0.10)",
    padding: 14,
    borderRadius: 16,
    color: "rgba(255,255,255,0.92)",
    backdropFilter: "blur(14px)",
    boxShadow: "0 24px 80px rgba(0,0,0,0.55)",
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    fontSize: 12,
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid rgba(255,255,255,0.14)",
    background: active ? "rgba(183,185,255,0.20)" : "rgba(255,255,255,0.06)",
    color: "rgba(255,255,255,0.92)",
    whiteSpace: "nowrap",
  });

  const buttonStyle = (variant: "primary" | "secondary" = "secondary"): React.CSSProperties => {
    const bg = variant === "primary" ? "rgba(124,255,178,0.18)" : "rgba(124,180,255,0.14)";
    return {
      cursor: "pointer",
      padding: "10px 12px",
      borderRadius: 12,
      border: "1px solid rgba(255,255,255,0.14)",
      background: bg,
      color: "rgba(255,255,255,0.92)",
      fontWeight: 700,
      letterSpacing: 0.2,
      userSelect: "none",
    };
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(0,0,0,0.28)",
    color: "rgba(255,255,255,0.92)",
    outline: "none",
  };

  return (
    <>
      <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />

      <div style={panelStyle}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: 99,
              background: statusDotColor(),
              boxShadow: "0 0 18px rgba(255,255,255,0.18)",
            }}
          />
          <div style={{ fontWeight: 800, letterSpacing: 0.35 }}>TERRANOVA SPATIAL</div>
          <div style={{ marginLeft: "auto", opacity: 0.75, fontSize: 12 }}>
            {lastWorldId ? `World ${lastWorldId.slice(0, 8)}…` : "—"}
          </div>
        </div>

        {/* progress */}
        {busy && (
          <div style={{ marginTop: 10 }}>
            <div
              style={{
                height: 8,
                borderRadius: 999,
                background: "rgba(255,255,255,0.08)",
                border: "1px solid rgba(255,255,255,0.10)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${Math.max(2, Math.min(100, progress))}%`,
                  borderRadius: 999,
                  background:
                    "linear-gradient(90deg, rgba(183,185,255,0.55), rgba(124,255,178,0.55))",
                  transition: "width 180ms ease",
                }}
              />
            </div>
          </div>
        )}

        {/* status */}
        <div style={{ marginTop: 10, opacity: 0.82, fontSize: 13 }}>
          Status: <span style={{ fontWeight: 700 }}>{status}</span>
          {statusDetail ? <span style={{ opacity: 0.85 }}> — {statusDetail}</span> : null}
        </div>

        {/* NEW: controls row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>World model</div>
            <select
              value={modelChoice}
              onChange={(e) => setModelChoice(e.target.value as ModelChoice)}
              style={selectStyle}
            >
              <option value="Marble 0.1-mini">Marble 0.1-mini (fast)</option>
              <option value="Marble 0.1-plus">Marble 0.1-plus (higher quality)</option>
            </select>
          </div>

          <div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Splat resolution</div>
            <select
              value={splatResChoice}
              onChange={(e) => setSplatResChoice(e.target.value as SplatResChoice)}
              style={selectStyle}
            >
              <option value="auto">Auto (best available)</option>
              <option value="100k">100k (fastest)</option>
              <option value="500k">500k (recommended)</option>
              <option value="full_res">full_res (heaviest)</option>
            </select>
          </div>
        </div>

        {/* chips */}
        <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {presets.map((p) => (
            <button key={p} onClick={() => setPrompt(p)} style={chipStyle(prompt === p)}>
              {p.length > 34 ? p.slice(0, 34) + "…" : p}
            </button>
          ))}
        </div>

        {/* prompt */}
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{
            marginTop: 10,
            width: "100%",
            height: 96,
            resize: "none",
            borderRadius: 14,
            padding: 12,
            border: "1px solid rgba(255,255,255,0.12)",
            background: "rgba(0,0,0,0.32)",
            color: "rgba(255,255,255,0.92)",
            outline: "none",
            lineHeight: 1.25,
          }}
        />

        {/* actions */}
        <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={generate}
            disabled={busy}
            style={{
              ...buttonStyle("primary"),
              flex: 1,
              minWidth: 200,
              opacity: busy ? 0.6 : 1,
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            {busy ? "Generating…" : "Generate World"}
          </button>

          <button
            onClick={copyShareLink}
            disabled={!lastWorldId}
            style={{
              ...buttonStyle("secondary"),
              opacity: !lastWorldId ? 0.5 : 1,
              cursor: !lastWorldId ? "not-allowed" : "pointer",
            }}
            title={shareUrl || ""}
          >
            Share
          </button>

          <button
            onClick={downloadCurrentSplat}
            disabled={!currentSpzUrlRef.current}
            style={{
              ...buttonStyle("secondary"),
              opacity: currentSpzUrlRef.current ? 1 : 0.5,
              cursor: currentSpzUrlRef.current ? "pointer" : "not-allowed",
            }}
            title={currentSpzUrlRef.current || ""}
          >
            Download .spz
          </button>
        </div>

        {shareUrl ? (
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.70, wordBreak: "break-all" }}>
            {shareUrl}
          </div>
        ) : null}

        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.62 }}>
          Drag to orbit • Scroll to zoom • VR button appears when supported
        </div>
      </div>

      {busy && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "radial-gradient(900px 520px at 20% 20%, rgba(183,185,255,0.10), rgba(0,0,0,0.0) 60%), rgba(0,0,0,0.18)",
          }}
        />
      )}
    </>
  );
}
