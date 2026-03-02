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

function pickSpzUrl(payload: any, choice: SplatResChoice): { url: string | null; key?: string } {
  try {
    const spzUrls = payload?.assets?.splats?.spz_urls;
    if (spzUrls && typeof spzUrls === "object") {
      const entries = Object.entries(spzUrls).filter(
        ([, v]) => typeof v === "string" && (v as string).includes(".spz")
      ) as Array<[string, string]>;

      if (entries.length === 0) return { url: null };

      const map = new Map(entries);
      const tryKeys = choice === "auto" ? ["500k", "100k", "full_res"] : [choice];

      for (const k of tryKeys) {
        if (map.has(k)) return { url: map.get(k)!, key: k };
      }

      const [k0, u0] = entries[0];
      return { url: u0, key: k0 };
    }

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

/**
 * Sample the current rendered canvas to estimate:
 * - average luminance (0..1)
 * - dominant-ish hue (0..360) from average RGB
 */
function sampleCanvasLook(canvas: HTMLCanvasElement): { lum: number; hue: number; rgb: [number, number, number] } | null {
  try {
    const w = 96;
    const h = 54;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(canvas, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h).data;

    let r = 0, g = 0, b = 0;
    let count = 0;

    // stride to be cheap
    for (let i = 0; i < img.length; i += 16) {
      r += img[i + 0];
      g += img[i + 1];
      b += img[i + 2];
      count++;
    }
    if (!count) return null;

    r /= count; g /= count; b /= count;

    // luminance (perceived)
    const lum = clamp((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, 0, 1);

    // hue from rgb
    const rf = r / 255, gf = g / 255, bf = b / 255;
    const max = Math.max(rf, gf, bf);
    const min = Math.min(rf, gf, bf);
    const d = max - min;

    let hue = 0;
    if (d !== 0) {
      if (max === rf) hue = ((gf - bf) / d) % 6;
      else if (max === gf) hue = (bf - rf) / d + 2;
      else hue = (rf - gf) / d + 4;
      hue *= 60;
      if (hue < 0) hue += 360;
    }

    return { lum, hue, rgb: [r, g, b] };
  } catch {
    return null;
  }
}

function hslToCss(h: number, s: number, l: number) {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
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

  const ambientRef = useRef<any>(null);
  const sunRef = useRef<any>(null);

  const baseFogDensityRef = useRef<number>(0.035);

  const camAnimCancelRef = useRef<{ cancel: boolean } | null>(null);

  // reactive UI theme (from splat)
  const [uiMode, setUiMode] = useState<"dark" | "light">("dark");
  const [accentHue, setAccentHue] = useState<number>(210);

  // animated background driver
  const [bgPhase, setBgPhase] = useState<number>(0);

  // progress / busy
  const [progress, setProgress] = useState(0);
  const fakeProgressRef = useRef<number | null>(null);
  const [busy, setBusy] = useState(false);

  // cinematic mode
  const [cinematic, setCinematic] = useState(false);
  const cinematicOrbitRef = useRef<{ t: number; radius: number } | null>(null);

  // prompt enhancer
  const [enhancePrompt, setEnhancePrompt] = useState(true);

  // model / res
  const [modelChoice, setModelChoice] = useState<ModelChoice>("Marble 0.1-mini");
  const [splatResChoice, setSplatResChoice] = useState<SplatResChoice>("auto");

  // status
  const [status, setStatus] = useState<
    "Idle" | "Booting" | "Ready" | "Generating" | "Loading splat" | "Error"
  >("Idle");
  const [statusDetail, setStatusDetail] = useState("");
  const [lastWorldId, setLastWorldId] = useState("");
  const [shareUrl, setShareUrl] = useState("");

  const presets = useMemo(
    () => [
      "Barcelona Gothic alleyway at night after rain, wet cobblestones, warm sodium street lamps, subtle neon reflections, cinematic depth of field, realistic scale, ultra-detailed.",
      "Futuristic metro platform, glossy tiles, soft volumetric light shafts, puddles and reflections, cinematic wide shot, realistic scale, high detail.",
      "Minimalist sci-fi atrium, white stone + brushed metal, skylight grid, sunbeams with volumetric fog, calm museum-grade lighting, wide-angle composition, realistic scale.",
      "Industrial warehouse gallery, concrete floor, overhead truss lights, haze, strong perspective lines, cinematic contrast, realistic scale, ultra-detailed.",
      "Underground tunnel with LED strips, wet floor reflections, moody fog, strong vanishing point, cinematic lighting, realistic scale.",
      "Ancient cloister courtyard, arches and columns, soft morning light, light fog, mossy stone, peaceful ambience, cinematic wide shot, realistic scale.",
      "Cyberpunk street market under a canopy, neon signage, rain mist, reflective puddles, crowd silhouettes, cinematic lighting, realistic scale, detailed textures.",
      "Brutalist exterior plaza (NOT interior), dramatic overcast sky, wet concrete, strong geometry, moody film lighting, realistic scale, high detail.",
    ],
    []
  );

  const [prompt, setPrompt] = useState(presets[0]);

  function stopFakeProgress() {
    if (fakeProgressRef.current != null) {
      window.clearInterval(fakeProgressRef.current);
      fakeProgressRef.current = null;
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

  // Cinematic ESC exit + fog tweak
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && cinematic) setCinematic(false);
    };
    window.addEventListener("keydown", onKey);

    // fog bump when cinematic
    const scene = sceneRef.current;
    if (scene?.fog) {
      const base = baseFogDensityRef.current;
      scene.fog.density = cinematic ? base * 1.15 : base;
    }

    // hide/show orbit controls
    if (controlsRef.current) {
      controlsRef.current.enabled = !cinematic;
    }

    return () => window.removeEventListener("keydown", onKey);
  }, [cinematic]);

  // background animation tied to camera
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const cam = cameraRef.current;
      if (cam) {
        // subtle phase driver: position magnitude + yaw-ish
        const px = cam.position?.x ?? 0;
        const pz = cam.position?.z ?? 0;
        const m = Math.sqrt(px * px + pz * pz);
        const yaw = cam.rotation?.y ?? 0;
        const phase = (m * 0.08 + yaw * 0.9 + performance.now() * 0.00008) % 1000;
        setBgPhase(phase);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

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

        const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 8000);
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
          try { vrButtonRef.current.remove(); } catch {}
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

        const onSessionStart = () => { if (controlsRef.current) controlsRef.current.enabled = false; };
        const onSessionEnd = () => { if (controlsRef.current) controlsRef.current.enabled = !cinematic; };
        renderer.xr.addEventListener("sessionstart", onSessionStart);
        renderer.xr.addEventListener("sessionend", onSessionEnd);

        // lighting
        const ambient = new THREE.AmbientLight(0xffffff, 0.35);
        ambientRef.current = ambient;
        scene.add(ambient);

        const hemi = new THREE.HemisphereLight(0xbfdfff, 0x080820, 0.6);
        scene.add(hemi);

        const sun = new THREE.DirectionalLight(0xffffff, 1.2);
        sun.position.set(5, 10, 7);
        sunRef.current = sun;
        scene.add(sun);

        // fog base
        scene.fog = new THREE.FogExp2(0x05060a, baseFogDensityRef.current);

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

        function animateCameraTo(startPos: any, endPos: any, startTarget: any, endTarget: any, durationMs = 2200) {
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

          const startPos = target.clone().add(new THREE.Vector3(0, safeRadius * 1.8, safeRadius * 3.2));
          const startTarget = target.clone().add(new THREE.Vector3(0, safeRadius * 0.15, 0));

          // store cinematic orbit radius around target
          cinematicOrbitRef.current = { t: 0, radius: distance };

          if (hero) animateCameraTo(startPos, endPos, startTarget, target, 2200);
          else {
            cancelHeroCam();
            cam.position.copy(endPos);
            ctrls.target.copy(target);
            ctrls.update();
          }
        }

        async function updateUiFromSplatLook() {
          const r = rendererRef.current;
          if (!r) return;

          // sample the rendered canvas; do it a moment after load for a stable frame
          const canvas = r.domElement as HTMLCanvasElement;
          const s = sampleCanvasLook(canvas);
          if (!s) return;

          // dark/light mode threshold (tuned for moody scenes)
          setUiMode(s.lum > 0.52 ? "light" : "dark");

          // accent hue: keep it in a pleasing band, avoid extremes
          const hue = isFinite(s.hue) ? s.hue : 210;
          setAccentHue(hue);
        }

        async function loadWorldAssets(worldPayload: AnyObj, opts?: { hero?: boolean }) {
          const hero = opts?.hero ?? true;

          const picked = pickSpzUrl(worldPayload, splatResChoice);
          if (!picked.url) throw new Error("No .spz found in payload.");
          currentSpzUrlRef.current = picked.url;

          if (splatRootRef.current) {
            try {
              scene.remove(splatRootRef.current);
              splatRootRef.current.traverse?.((o: any) => o?.dispose?.());
            } catch {}
            splatRootRef.current = null;
          }

          setStatus("Loading splat");
          setStatusDetail(picked.key ? `Streaming splat (${picked.key})…` : "Streaming gaussian splats…");

          // Upright fix
          const pivot = new THREE.Group();
          pivot.rotation.x = Math.PI;

          const splat = new SplatMesh({ url: picked.url });
          pivot.add(splat);

          scene.add(pivot);
          splatRootRef.current = pivot;

          await waitFrames(2);
          frameCameraToObject(pivot, hero);

          // wait a couple frames, then sample look for UI theme
          await waitFrames(8);
          await updateUiFromSplatLook();

          setStatus("Ready");
          setStatusDetail("");
        }

        (window as any).loadWorldAssets = loadWorldAssets;

        // main loop: cinematic orbit + normal render
        renderer.setAnimationLoop(() => {
          const cam = cameraRef.current;
          const ctrls = controlsRef.current;

          // cinematic orbit
          if (cinematic && cam && ctrls) {
            const info = cinematicOrbitRef.current;
            if (info) {
              info.t += 0.0018; // speed
              const r = info.radius;
              const y = ctrls.target.y + Math.max(0.15, r * 0.08);
              const x = ctrls.target.x + Math.sin(info.t) * r;
              const z = ctrls.target.z + Math.cos(info.t) * r;
              cam.position.set(x, y, z);
              cam.lookAt(ctrls.target);
            }
          } else {
            if (ctrls && ctrls.enabled) ctrls.update();
          }

          renderer.render(scene, camera);
        });

        // load cached/shared world
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

      try { cleanup?.(); } catch {}

      try {
        if (rendererRef.current) {
          rendererRef.current.setAnimationLoop(null);
          rendererRef.current.dispose?.();
        }
      } catch {}
      rendererRef.current = null;

      try { controlsRef.current?.dispose?.(); } catch {}
      controlsRef.current = null;

      try { if (vrButtonRef.current) vrButtonRef.current.remove(); } catch {}
      vrButtonRef.current = null;

      try {
        if (sceneRef.current && splatRootRef.current) sceneRef.current.remove(splatRootRef.current);
      } catch {}
      splatRootRef.current = null;

      cameraRef.current = null;
      sceneRef.current = null;
      ambientRef.current = null;
      sunRef.current = null;
    };
  }, [splatResChoice, cinematic]);

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

  function buildFinalPrompt(raw: string) {
    const base = raw.trim();
    if (!enhancePrompt) return base;

    const enhancer =
      "cinematic wide-angle lens, realistic scale, architectural depth, volumetric light, strong perspective lines, coherent geometry, crisp material definition";

    // avoid duplicating if user already pasted similar phrases
    const lower = base.toLowerCase();
    const already =
      lower.includes("realistic scale") ||
      lower.includes("volumetric") ||
      lower.includes("wide-angle") ||
      lower.includes("wide angle") ||
      lower.includes("architectural depth");

    return already ? base : `${base}\n\n${enhancer}`;
  }

  async function generate() {
    try {
      setBusy(true);
      setStatus("Generating");
      setStatusDetail("Starting…");
      startFakeProgress();

      const finalText = buildFinalPrompt(prompt);

      const r = await fetch("/api/worlds/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: finalText,
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

  // --- UI styling derived from splat look + camera movement ---
  const accent = hslToCss(accentHue, uiMode === "dark" ? 72 : 60, uiMode === "dark" ? 62 : 40);
  const accentSoft = hslToCss(accentHue, 78, uiMode === "dark" ? 60 : 42);

  // background gradient tied to bgPhase
  const bgA = hslToCss((accentHue + bgPhase * 12) % 360, 70, uiMode === "dark" ? 16 : 92);
  const bgB = hslToCss((accentHue + 80 + bgPhase * 9) % 360, 70, uiMode === "dark" ? 10 : 86);
  const bgC = hslToCss((accentHue + 190 + bgPhase * 6) % 360, 65, uiMode === "dark" ? 12 : 88);

  const panelStyle: React.CSSProperties = {
    position: "absolute",
    top: 16,
    left: 16,
    width: 600,
    maxWidth: "calc(100vw - 32px)",
    background:
      uiMode === "dark"
        ? "linear-gradient(180deg, rgba(12,12,14,0.80), rgba(12,12,14,0.56))"
        : "linear-gradient(180deg, rgba(250,250,252,0.82), rgba(250,250,252,0.60))",
    border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)",
    padding: 14,
    borderRadius: 18,
    color: uiMode === "dark" ? "rgba(255,255,255,0.92)" : "rgba(10,10,12,0.92)",
    backdropFilter: "blur(14px)",
    boxShadow:
      uiMode === "dark"
        ? `0 24px 80px rgba(0,0,0,0.58), 0 0 28px ${accentSoft}20`
        : `0 24px 80px rgba(0,0,0,0.18), 0 0 24px ${accentSoft}20`,
    fontFamily:
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
  };

  const buttonStyle = (variant: "primary" | "secondary" = "secondary"): React.CSSProperties => {
    const bg =
      variant === "primary"
        ? uiMode === "dark"
          ? `${accent}22`
          : `${accent}18`
        : uiMode === "dark"
          ? "rgba(124,180,255,0.14)"
          : "rgba(0,0,0,0.06)";
    const border = uiMode === "dark" ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(0,0,0,0.10)";
    return {
      cursor: "pointer",
      padding: "10px 12px",
      borderRadius: 12,
      border,
      background: bg,
      color: uiMode === "dark" ? "rgba(255,255,255,0.92)" : "rgba(10,10,12,0.92)",
      fontWeight: 800,
      letterSpacing: 0.2,
      userSelect: "none",
    };
  };

  const selectStyle: React.CSSProperties = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 12,
    border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,0,0,0.10)",
    background: uiMode === "dark" ? "rgba(0,0,0,0.28)" : "rgba(255,255,255,0.65)",
    color: uiMode === "dark" ? "rgba(255,255,255,0.92)" : "rgba(10,10,12,0.92)",
    outline: "none",
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    cursor: "pointer",
    fontSize: 12,
    padding: "8px 10px",
    borderRadius: 999,
    border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.14)" : "1px solid rgba(0,0,0,0.10)",
    background: active
      ? uiMode === "dark"
        ? `${accent}22`
        : `${accent}18`
      : uiMode === "dark"
        ? "rgba(255,255,255,0.06)"
        : "rgba(0,0,0,0.05)",
    color: uiMode === "dark" ? "rgba(255,255,255,0.92)" : "rgba(10,10,12,0.92)",
    whiteSpace: "nowrap",
  });

  const toggleRowStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 12px",
    borderRadius: 14,
    border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)",
    background: uiMode === "dark" ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.55)",
  };

  return (
    <>
      {/* Animated “world-aware” background tied to camera */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            `radial-gradient(900px 620px at 18% 18%, ${bgA}22, rgba(0,0,0,0) 62%),` +
            `radial-gradient(780px 520px at 86% 28%, ${bgB}20, rgba(0,0,0,0) 60%),` +
            `radial-gradient(900px 720px at 50% 92%, ${bgC}16, rgba(0,0,0,0) 64%),` +
            (uiMode === "dark" ? "rgba(0,0,0,0.22)" : "rgba(255,255,255,0.08)"),
          pointerEvents: "none",
          transition: "background 280ms ease",
        }}
      />

      <div ref={mountRef} style={{ width: "100vw", height: "100vh" }} />

      {/* Vignette overlay (only in cinematic) */}
      {cinematic && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              "radial-gradient(1200px 700px at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.42) 100%)",
            mixBlendMode: "multiply",
          }}
        />
      )}

      {/* If cinematic hides UI, we still show an exit hint */}
      {cinematic && (
        <div
          style={{
            position: "absolute",
            left: 16,
            bottom: 16,
            padding: "10px 12px",
            borderRadius: 14,
            background: uiMode === "dark" ? "rgba(0,0,0,0.35)" : "rgba(255,255,255,0.55)",
            border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)",
            color: uiMode === "dark" ? "rgba(255,255,255,0.86)" : "rgba(10,10,12,0.86)",
            backdropFilter: "blur(12px)",
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"',
            fontSize: 12,
          }}
        >
          Cinematic mode • Press <b>ESC</b> to exit
        </div>
      )}

      {/* Main UI panel (hidden in cinematic mode) */}
      {!cinematic && (
        <div style={panelStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: 99,
                background: statusDotColor(),
                boxShadow: `0 0 18px ${accentSoft}30`,
              }}
            />
            <div style={{ fontWeight: 900, letterSpacing: 0.35 }}>TERRANOVA SPATIAL</div>
            <div style={{ marginLeft: "auto", opacity: uiMode === "dark" ? 0.75 : 0.7, fontSize: 12 }}>
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
                  background: uiMode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
                  border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.10)" : "1px solid rgba(0,0,0,0.10)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    height: "100%",
                    width: `${Math.max(2, Math.min(100, progress))}%`,
                    borderRadius: 999,
                    background: `linear-gradient(90deg, ${accentSoft}88, ${accent}88)`,
                    transition: "width 180ms ease",
                  }}
                />
              </div>
            </div>
          )}

          <div style={{ marginTop: 10, opacity: uiMode === "dark" ? 0.82 : 0.78, fontSize: 13 }}>
            Status: <span style={{ fontWeight: 800 }}>{status}</span>
            {statusDetail ? <span style={{ opacity: 0.85 }}> — {statusDetail}</span> : null}
          </div>

          {/* toggles */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <div style={toggleRowStyle}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Cinematic Mode</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Vignette + auto orbit</div>
              </div>
              <input
                type="checkbox"
                checked={cinematic}
                onChange={(e) => setCinematic(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: accent }}
                disabled={busy}
              />
            </div>

            <div style={toggleRowStyle}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 13 }}>Prompt Enhancer</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Spatial realism boost</div>
              </div>
              <input
                type="checkbox"
                checked={enhancePrompt}
                onChange={(e) => setEnhancePrompt(e.target.checked)}
                style={{ width: 18, height: 18, accentColor: accent }}
                disabled={busy}
              />
            </div>
          </div>

          {/* model + resolution */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>World model</div>
              <select
                value={modelChoice}
                onChange={(e) => setModelChoice(e.target.value as ModelChoice)}
                style={selectStyle}
                disabled={busy}
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
                disabled={busy}
              >
                <option value="auto">Auto (best available)</option>
                <option value="100k">100k (fastest)</option>
                <option value="500k">500k (recommended)</option>
                <option value="full_res">full_res (heaviest)</option>
              </select>
            </div>
          </div>

          {/* presets */}
          <div style={{ marginTop: 12, display: "flex", flexWrap: "wrap", gap: 8 }}>
            {presets.map((p) => (
              <button key={p} onClick={() => setPrompt(p)} style={chipStyle(prompt === p)} disabled={busy}>
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
              height: 104,
              resize: "none",
              borderRadius: 14,
              padding: 12,
              border: uiMode === "dark" ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(0,0,0,0.10)",
              background: uiMode === "dark" ? "rgba(0,0,0,0.32)" : "rgba(255,255,255,0.70)",
              color: uiMode === "dark" ? "rgba(255,255,255,0.92)" : "rgba(10,10,12,0.92)",
              outline: "none",
              lineHeight: 1.25,
            }}
            disabled={busy}
          />

          {/* actions */}
          <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={generate}
              disabled={busy}
              style={{
                ...buttonStyle("primary"),
                flex: 1,
                minWidth: 220,
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
            <div style={{ marginTop: 8, fontSize: 12, opacity: uiMode === "dark" ? 0.7 : 0.72, wordBreak: "break-all" }}>
              {shareUrl}
            </div>
          ) : null}

          <div style={{ marginTop: 8, fontSize: 12, opacity: uiMode === "dark" ? 0.62 : 0.66 }}>
            Drag to orbit • Scroll to zoom • VR button appears when supported
          </div>

          {/* subtle “accent glow” strip */}
          <div
            style={{
              marginTop: 12,
              height: 2,
              borderRadius: 999,
              background: `linear-gradient(90deg, ${accentSoft}00, ${accentSoft}AA, ${accent}AA, ${accentSoft}00)`,
              opacity: uiMode === "dark" ? 0.65 : 0.55,
            }}
          />
        </div>
      )}

      {/* Slight veil while generating */}
      {busy && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            background:
              uiMode === "dark"
                ? `radial-gradient(900px 520px at 20% 20%, ${accentSoft}10, rgba(0,0,0,0.0) 60%), rgba(0,0,0,0.18)`
                : `radial-gradient(900px 520px at 20% 20%, ${accentSoft}14, rgba(255,255,255,0.0) 60%), rgba(255,255,255,0.06)`,
          }}
        />
      )}
    </>
  );
}
