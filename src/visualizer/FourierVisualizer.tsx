import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, ChromaticAberration, EffectComposer, Noise, SMAA, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  PointsMaterial,
  type Group,
} from "three";
import { createSpectrumVisualizer } from "./spectrum";
import type { FourierMode, FourierRegion, FourierVisualizerProps, SpectrogramLayer } from "./types";

const WINDOW_SIZE = 2048;
const HOP_SIZE = 1024;
const BIN_COUNT = 96;
const MIN_FREQUENCY = 35;
const MAX_FREQUENCY = 22_000;
const WATERFALL_DEPTH = 5.8;
const WATERFALL_WIDTH = 10.5;
const WATERFALL_HEIGHT = 4.4;
const WATERFALL_BASE_Y = -2.16;
const WATERFALL_AMPLITUDE_HEIGHT = 3.75;
const LIVE_BIN_COUNT = 128;
const LIVE_HISTORY_STEPS = 96;
const CARRIER_COLOR = new Color("#61dafb");
const DATA_COLOR = new Color("#ff6b9d");
const LIVE_COLOR = new Color("#f7d774");

type SpectrogramRequestHandle = {
  promise: Promise<SpectrogramLayer>;
  cancel(): void;
};

const layerCache = new WeakMap<AudioBuffer, SpectrogramLayer>();
const pendingLayerCache = new WeakMap<AudioBuffer, SpectrogramRequestHandle>();
let nextJobId = 1;

export function FourierVisualizer(props: FourierVisualizerProps) {
  const webglAvailable = useWebGLAvailable();

  if (webglAvailable === false) {
    return <CanvasFallback {...props} />;
  }

  return (
    <div style={{ position: "relative", width: "100%", height: "100%", minHeight: 260 }}>
      <Canvas
        camera={{ position: [0, 3.2, 8.4], fov: 44, near: 0.1, far: 80 }}
        dpr={[1, 1.6]}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#080b11"]} />
        <fog attach="fog" args={["#080b11", 9, 18]} />
        <ambientLight intensity={0.72} />
        <directionalLight position={[2.5, 4, 3]} intensity={1.1} />
        <FourierScene {...props} />
        <OrbitControls
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minDistance={5.5}
          maxDistance={13}
          minPolarAngle={0.75}
          maxPolarAngle={1.36}
        />
        <EffectComposer multisampling={0}>
          <SMAA />
          <Bloom intensity={0.28} luminanceThreshold={0.36} luminanceSmoothing={0.58} mipmapBlur />
          <ChromaticAberration offset={[0.00045, 0.00024]} radialModulation modulationOffset={0.15} />
          <Noise opacity={0.035} />
          <Vignette offset={0.22} darkness={0.58} />
        </EffectComposer>
      </Canvas>
      {props.mode === "hybrid" ? <WaveformOverlay carrier={props.carrier} data={props.data} regions={props.regions} /> : null}
      <SeekOverlay carrier={props.carrier} data={props.data} onSeek={props.onSeek} />
    </div>
  );
}

function FourierScene(props: FourierVisualizerProps) {
  const carrierLayer = useSpectrogramLayer(props.carrier);
  const dataLayer = useSpectrogramLayer(props.data);
  const playheadX = timeToX(props.playheadTime ?? 0, Math.max(props.carrier?.duration ?? 0, props.data?.duration ?? 0, 1));
  const showWaterfall = props.mode === "hybrid" || props.mode === "waterfall";
  const showLive = props.mode === "hybrid" || props.mode === "live";

  return (
    <group>
      <GridPlane />
      {showWaterfall && carrierLayer ? <SpectrogramPoints layer={carrierLayer} color={CARRIER_COLOR} opacity={0.56} zOffset={0} /> : null}
      {showWaterfall && dataLayer ? <SpectrogramPoints layer={dataLayer} color={DATA_COLOR} opacity={0.72} zOffset={0.08} /> : null}
      <RegionBands regions={props.regions} duration={Math.max(props.carrier?.duration ?? 0, props.data?.duration ?? 0, 1)} />
      <Playhead x={playheadX} playing={props.playing} />
      {showLive ? <LiveWaterfall frequencyData={props.liveFrequencyData} sampleRate={props.liveSampleRate} mode={props.mode} /> : null}
    </group>
  );
}

function useSpectrogramLayer(buffer: AudioBuffer | null): SpectrogramLayer | null {
  const [layer, setLayer] = useState<SpectrogramLayer | null>(null);

  useEffect(() => {
    if (!buffer) {
      setLayer(null);
      return;
    }

    let cancelled = false;
    const request = getSpectrogramLayer(buffer);
    request.promise.then((nextLayer) => {
      if (!cancelled) {
        setLayer(nextLayer);
      }
    }).catch(() => {
      if (!cancelled) {
        setLayer(null);
      }
    });

    return () => {
      cancelled = true;
      request.cancel();
    };
  }, [buffer]);

  return layer;
}

function getSpectrogramLayer(buffer: AudioBuffer): SpectrogramRequestHandle {
  const cached = layerCache.get(buffer);
  if (cached) {
    return { promise: Promise.resolve(cached), cancel: () => {} };
  }

  const pending = pendingLayerCache.get(buffer);
  if (pending) {
    return pending;
  }

  const samples = mixBufferToMono(buffer);
  const targetSteps = window.innerWidth < 760 ? 112 : 176;
  const hopSize = Math.max(HOP_SIZE, Math.floor(buffer.length / targetSteps));
  const worker = new Worker(new URL("./spectrogram.worker.ts", import.meta.url), { type: "module" });
  const jobId = nextJobId;
  nextJobId += 1;
  let settled = false;
  let rejectRequest: ((error: Error) => void) | null = null;

  const promise = new Promise<SpectrogramLayer>((resolve, reject) => {
    rejectRequest = reject;
    worker.onmessage = (event: MessageEvent<SpectrogramWorkerResponse>) => {
      const message = event.data;
      if (message.jobId !== jobId) {
        return;
      }
      settled = true;
      worker.terminate();
      pendingLayerCache.delete(buffer);
      if (message.type === "error") {
        reject(new Error(message.message));
        return;
      }
      const layer = {
        duration: message.duration,
        sampleRate: message.sampleRate,
        timeSteps: message.timeSteps,
        binCount: message.binCount,
        magnitudes: message.magnitudes,
      };
      layerCache.set(buffer, layer);
      resolve(layer);
    };
    worker.onerror = () => {
      settled = true;
      worker.terminate();
      pendingLayerCache.delete(buffer);
      reject(new Error("Spectrogram worker unavailable."));
    };
  });

  worker.postMessage(
    {
      type: "compute",
      jobId,
      sampleRate: buffer.sampleRate,
      samples,
      windowSize: WINDOW_SIZE,
      hopSize,
      binCount: BIN_COUNT,
      minFrequency: MIN_FREQUENCY,
      maxFrequency: MAX_FREQUENCY,
    },
    [samples.buffer],
  );

  const handle = {
    promise,
    cancel: () => {
      if (settled) {
        return;
      }
      settled = true;
      worker.postMessage({ type: "cancel", jobId });
      worker.terminate();
      pendingLayerCache.delete(buffer);
      rejectRequest?.(new Error("Spectrogram request cancelled."));
    },
  };
  pendingLayerCache.set(buffer, handle);
  return handle;
}

function mixBufferToMono(buffer: AudioBuffer): Float32Array {
  const samples = new Float32Array(buffer.length);
  for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
    const channel = buffer.getChannelData(channelIndex);
    for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex += 1) {
      samples[sampleIndex] += channel[sampleIndex] / buffer.numberOfChannels;
    }
  }
  return samples;
}

function SpectrogramPoints(props: { layer: SpectrogramLayer; color: Color; opacity: number; zOffset: number }) {
  const geometry = useMemo(() => buildSpectrogramGeometry(props.layer, props.color, props.zOffset), [props.layer, props.color, props.zOffset]);
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: 0.027,
        vertexColors: true,
        transparent: true,
        opacity: props.opacity,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [props.opacity],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <points args={[geometry, material]} />;
}

function buildSpectrogramGeometry(layer: SpectrogramLayer, color: Color, zOffset: number): BufferGeometry {
  const count = layer.timeSteps * layer.binCount;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const duration = Math.max(layer.duration, 0.001);

  for (let timeIndex = 0; timeIndex < layer.timeSteps; timeIndex += 1) {
    const timeRatio = timeIndex / Math.max(1, layer.timeSteps - 1);
    const x = timeToX(timeRatio * duration, duration);
    for (let binIndex = 0; binIndex < layer.binCount; binIndex += 1) {
      const index = timeIndex * layer.binCount + binIndex;
      const magnitude = layer.magnitudes[index];
      const frequencyRatio = binIndex / Math.max(1, layer.binCount - 1);
      const y = WATERFALL_BASE_Y + magnitude * WATERFALL_AMPLITUDE_HEIGHT;
      const z = (frequencyRatio - 0.5) * WATERFALL_DEPTH + zOffset;
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
      colors[index * 3] = color.r * (0.12 + magnitude * 1.08);
      colors[index * 3 + 1] = color.g * (0.12 + magnitude * 1.08);
      colors[index * 3 + 2] = color.b * (0.12 + magnitude * 1.08);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

function normalizeLiveMagnitude(value: number, source: Float32Array | Uint8Array): number {
  if (source instanceof Uint8Array) {
    return value / 255;
  }
  return Math.min(1, Math.max(0, (value + 96) / 96));
}

function LiveWaterfall(props: { frequencyData: Float32Array | Uint8Array | null; sampleRate: number | null; mode: FourierMode }) {
  const binCount = props.mode === "live" ? LIVE_BIN_COUNT : 96;
  const historySteps = props.mode === "live" ? LIVE_HISTORY_STEPS : 52;
  const historyRef = useRef(new Float32Array(historySteps * binCount));
  const cursorRef = useRef(0);
  const lastWriteRef = useRef(0);
  const geometry = useMemo(() => {
    const nextGeometry = new BufferGeometry();
    const pointCount = historySteps * binCount;
    nextGeometry.setAttribute("position", new BufferAttribute(new Float32Array(pointCount * 3), 3));
    nextGeometry.setAttribute("color", new BufferAttribute(new Float32Array(pointCount * 3), 3));
    nextGeometry.setDrawRange(0, 0);
    return nextGeometry;
  }, [binCount, historySteps]);
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: props.mode === "live" ? 0.041 : 0.03,
        vertexColors: true,
        transparent: true,
        opacity: props.mode === "live" ? 0.84 : 0.52,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [props.mode],
  );

  useEffect(() => {
    historyRef.current = new Float32Array(historySteps * binCount);
    cursorRef.current = 0;
    lastWriteRef.current = 0;
  }, [binCount, historySteps]);

  useFrame((state) => {
    if (!props.frequencyData || props.frequencyData.length < 2 || !props.sampleRate) {
      const history = historyRef.current;
      for (let index = 0; index < history.length; index += 1) {
        history[index] *= 0.965;
      }
      writeLiveWaterfallGeometry(geometry, history, cursorRef.current, binCount, historySteps, props.mode, state.clock.elapsedTime);
      return;
    }

    if (state.clock.elapsedTime - lastWriteRef.current >= 1 / 28) {
      const history = historyRef.current;
      const cursor = cursorRef.current;
      const rowOffset = cursor * binCount;

      for (let index = 0; index < binCount; index += 1) {
        const ratio = index / Math.max(1, binCount - 1);
        const nextSourceIndex = Math.min(props.frequencyData.length - 1, Math.floor(ratio * props.frequencyData.length));
        history[rowOffset + index] = normalizeLiveMagnitude(props.frequencyData[nextSourceIndex], props.frequencyData);
      }

      cursorRef.current = (cursor + 1) % historySteps;
      lastWriteRef.current = state.clock.elapsedTime;
    }

    writeLiveWaterfallGeometry(geometry, historyRef.current, cursorRef.current, binCount, historySteps, props.mode, state.clock.elapsedTime);
  });

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <points args={[geometry, material]} />;
}

function writeLiveWaterfallGeometry(
  geometry: BufferGeometry,
  history: Float32Array,
  cursor: number,
  binCount: number,
  historySteps: number,
  mode: FourierMode,
  elapsedTime: number,
): void {
  const positions = geometry.attributes.position.array as Float32Array;
  const colors = geometry.attributes.color?.array as Float32Array | undefined;
  const depth = mode === "live" ? WATERFALL_DEPTH : 1.65;
  const zStart = mode === "live" ? -WATERFALL_DEPTH / 2 : -WATERFALL_DEPTH / 2 - 0.45;
  let outputIndex = 0;

  for (let age = 0; age < historySteps; age += 1) {
    const sourceRow = (cursor - 1 - age + historySteps) % historySteps;
    const ageRatio = age / Math.max(1, historySteps - 1);
    const z = zStart + ageRatio * depth;
    const fade = 1 - ageRatio * 0.72;

    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      const frequencyRatio = binIndex / Math.max(1, binCount - 1);
      const magnitude = history[sourceRow * binCount + binIndex] * fade;
      const ripple = Math.sin(elapsedTime * 2.1 + ageRatio * Math.PI * 3 + frequencyRatio * Math.PI * 2) * 0.025;
      positions[outputIndex * 3] = (frequencyRatio - 0.5) * WATERFALL_WIDTH;
      positions[outputIndex * 3 + 1] = WATERFALL_BASE_Y + magnitude * WATERFALL_AMPLITUDE_HEIGHT + ripple;
      positions[outputIndex * 3 + 2] = z;

      if (colors) {
        const intensity = 0.14 + magnitude * 1.15;
        colors[outputIndex * 3] = LIVE_COLOR.r * intensity;
        colors[outputIndex * 3 + 1] = LIVE_COLOR.g * intensity;
        colors[outputIndex * 3 + 2] = LIVE_COLOR.b * intensity;
      }

      outputIndex += 1;
    }
  }

  geometry.setDrawRange(0, outputIndex);
  geometry.attributes.position.needsUpdate = true;
  if (geometry.attributes.color) {
    geometry.attributes.color.needsUpdate = true;
  }
}

function GridPlane() {
  const material = useMemo(
    () =>
      new MeshBasicMaterial({
        color: "#17202b",
        transparent: true,
        opacity: 0.34,
        side: DoubleSide,
      }),
    [],
  );

  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -2.25, 0] as any}>
      <planeGeometry args={[WATERFALL_WIDTH, WATERFALL_DEPTH, 12, 8]} />
      <primitive object={material} attach="material" />
    </mesh>
  );
}

function RegionBands(props: { regions: readonly FourierRegion[]; duration: number }) {
  return (
    <group position={[0, -2.2, 0] as any}>
      {props.regions.map((region, index) => {
        if (region.end <= region.start) {
          return null;
        }
        const startX = timeToX(region.start, props.duration);
        const endX = timeToX(region.end, props.duration);
        const width = Math.max(0.035, endX - startX);
        const color = resolveRegionColor(region.kind);
        return (
          <mesh key={`${region.kind}-${region.start}-${region.end}-${index}`} position={[startX + width / 2, 0.015, 0] as any}>
            <boxGeometry args={[width, 0.03, WATERFALL_DEPTH]} />
            <meshBasicMaterial args={[{ color, transparent: true, opacity: 0.34 }]} />
          </mesh>
        );
      })}
    </group>
  );
}

function Playhead(props: { x: number; playing: boolean }) {
  const ref = useRef<Group>(null);
  useFrame((state) => {
    if (ref.current && props.playing) {
      ref.current.position.y = Math.sin(state.clock.elapsedTime * 5) * 0.035;
    }
  });

  return (
    <group ref={ref} position={[props.x, 0, 0] as any}>
      <mesh position={[0, 0, 0] as any}>
        <boxGeometry args={[0.035, WATERFALL_HEIGHT + 0.9, WATERFALL_DEPTH]} />
        <meshBasicMaterial args={[{ color: "#d8ff4f", transparent: true, opacity: props.playing ? 0.09 : 0.055 }]} />
      </mesh>
      <mesh position={[0, 0, -WATERFALL_DEPTH / 2] as any}>
        <boxGeometry args={[0.045, WATERFALL_HEIGHT + 0.9, 0.045]} />
        <meshBasicMaterial args={[{ color: "#ffffff", transparent: true, opacity: 0.76 }]} />
      </mesh>
    </group>
  );
}

function SeekOverlay(props: { carrier: AudioBuffer | null; data: AudioBuffer | null; onSeek: (time: number) => void }) {
  const duration = Math.max(props.carrier?.duration ?? 0, props.data?.duration ?? 0, 0);
  return (
    <div
      aria-hidden="true"
      onPointerDown={(event: React.PointerEvent<HTMLDivElement>) => {
        if (duration <= 0) {
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
        props.onSeek(ratio * duration);
      }}
      style={{ position: "absolute", inset: 0, cursor: duration > 0 ? "crosshair" : "default" }}
    />
  );
}

function WaveformOverlay(props: { carrier: AudioBuffer | null; data: AudioBuffer | null; regions: readonly FourierRegion[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawWaveformOverlay(context, width, height, props.carrier, props.data, props.regions);
  }, [props.carrier, props.data, props.regions]);

  return <canvas ref={canvasRef} className="waveform-overlay" aria-hidden="true" />;
}

function drawWaveformOverlay(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  carrier: AudioBuffer | null,
  data: AudioBuffer | null,
  regions: readonly FourierRegion[],
): void {
  context.clearRect(0, 0, width, height);
  const duration = Math.max(carrier?.duration ?? 0, data?.duration ?? 0, 1);

  for (const region of regions) {
    if (region.end <= region.start) {
      continue;
    }
    const left = (region.start / duration) * width;
    const right = (region.end / duration) * width;
    context.fillStyle = resolveRegionColor(region.kind);
    context.globalAlpha = 0.18;
    context.fillRect(left, 0, Math.max(1, right - left), height);
  }

  context.globalAlpha = 1;
  drawWaveformLayer(context, carrier, width, height, "#61dafb", 0.58);
  drawWaveformLayer(context, data, width, height, "#ff6b9d", 0.82);
}

function drawWaveformLayer(
  context: CanvasRenderingContext2D,
  buffer: AudioBuffer | null,
  width: number,
  height: number,
  color: string,
  alpha: number,
): void {
  if (!buffer) {
    return;
  }

  const centerY = height / 2;
  const scaleY = height * 0.34;
  const samplesPerPixel = Math.max(1, Math.floor(buffer.length / Math.max(1, width)));
  context.strokeStyle = color;
  context.globalAlpha = alpha;
  context.lineWidth = 1.2;
  context.beginPath();

  for (let x = 0; x < width; x += 1) {
    const start = x * samplesPerPixel;
    const end = Math.min(buffer.length, start + samplesPerPixel);
    let peak = 0;

    for (let index = start; index < end; index += 1) {
      peak = Math.max(peak, Math.abs(readMixedSample(buffer, index)));
    }

    const y = centerY - peak * scaleY;
    if (x === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
  context.globalAlpha = 1;
}

function readMixedSample(buffer: AudioBuffer, sampleIndex: number): number {
  let sum = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    sum += buffer.getChannelData(channel)[sampleIndex] ?? 0;
  }

  return sum / Math.max(1, buffer.numberOfChannels);
}

function CanvasFallback(props: FourierVisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const visualizerRef = useRef<ReturnType<typeof createSpectrumVisualizer> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }
    visualizerRef.current = createSpectrumVisualizer(canvas);
    return () => {
      visualizerRef.current?.dispose();
      visualizerRef.current = null;
    };
  }, []);

  useEffect(() => {
    visualizerRef.current?.render({
      carrier: props.carrier,
      data: props.data,
      regions: props.regions,
      playheadTime: props.playheadTime,
    });
  }, [props.carrier, props.data, props.playheadTime, props.regions]);

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", minHeight: 260, display: "block" }} />;
}

function useWebGLAvailable(): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    setAvailable(Boolean(context));
  }, []);

  return available;
}

function timeToX(time: number, duration: number): number {
  return (Math.min(Math.max(time, 0), duration) / Math.max(duration, 0.001) - 0.5) * WATERFALL_WIDTH;
}

function resolveRegionColor(kind: string): string {
  const normalized = kind.toLowerCase();
  if (normalized === "text" || normalized.includes("start")) {
    return "#5b8dff";
  }
  if (normalized === "file" || normalized.includes("tail") || normalized.includes("append")) {
    return "#ffbe5c";
  }
  return "#7df0b3";
}

type SpectrogramWorkerResponse =
  | {
      type: "complete";
      jobId: number;
      duration: number;
      sampleRate: number;
      timeSteps: number;
      binCount: number;
      magnitudes: Float32Array;
    }
  | {
      type: "error";
      jobId: number;
      message: string;
    };
