import { OrbitControls } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, SMAA, Vignette } from "@react-three/postprocessing";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  MeshBasicMaterial,
  PointsMaterial,
} from "three";
import { createSpectrumVisualizer } from "./spectrum";
import type { FourierVisualizerProps, SpectrogramLayer } from "./types";

const WINDOW_SIZE = 2048;
const HOP_SIZE = 1024;
const BIN_COUNT = 96;
const MIN_FREQUENCY = 35;
const MAX_FREQUENCY = 22_000;
const WATERFALL_DEPTH = 5.8;
const WATERFALL_WIDTH = 10.5;
const WATERFALL_BASE_Y = -2.16;
const WATERFALL_AMPLITUDE_HEIGHT = 3.75;
const LIVE_BIN_COUNT = 96;
const LIVE_HISTORY_STEPS = 72;
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
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <Canvas
        camera={{ position: [6.8, 4.6, 8.8], fov: 46, near: 0.1, far: 80 }}
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
          target={[0, -0.65, 0] as any}
        />
        <EffectComposer multisampling={0}>
          <SMAA />
          <Bloom intensity={0.32} luminanceThreshold={0.34} luminanceSmoothing={0.58} mipmapBlur />
          <Vignette offset={0.22} darkness={0.58} />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

function FourierScene(props: FourierVisualizerProps) {
  const carrierLayer = useSpectrogramLayer(props.carrier);
  const dataLayer = useSpectrogramLayer(props.data);

  return (
    <group>
      <GridPlane />
      <LiveWaterfall frequencyData={props.liveFrequencyData} sampleRate={props.liveSampleRate} />
      {carrierLayer ? <SpectrumProfile layer={carrierLayer} color={CARRIER_COLOR} opacity={0.52} playheadTime={props.playheadTime ?? 0} z={-2.48} size={0.048} gain={0.9} /> : null}
      {dataLayer ? <SpectrumProfile layer={dataLayer} color={DATA_COLOR} opacity={0.52} playheadTime={props.playheadTime ?? 0} z={-2.48} size={0.048} gain={0.9} /> : null}
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

function SpectrumProfile(props: {
  layer: SpectrogramLayer;
  color: Color;
  opacity: number;
  playheadTime: number;
  z: number;
  size: number;
  gain: number;
}) {
  const geometry = useMemo(
    () => buildProfileGeometry(props.layer, props.color, props.playheadTime, props.z, props.gain),
    [props.layer, props.color, props.playheadTime, props.z, props.gain],
  );
  const material = useMemo(
    () =>
      new PointsMaterial({
        size: props.size,
        vertexColors: true,
        transparent: true,
        opacity: props.opacity,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [props.opacity, props.size],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  return <points args={[geometry, material]} />;
}

function buildProfileGeometry(layer: SpectrogramLayer, color: Color, playheadTime: number, z: number, gain: number): BufferGeometry {
  const count = layer.binCount;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const duration = Math.max(layer.duration, 0.001);
  const timeRatio = Math.min(1, Math.max(0, playheadTime / duration));
  const timeIndex = Math.min(layer.timeSteps - 1, Math.max(0, Math.round(timeRatio * Math.max(0, layer.timeSteps - 1))));

  for (let binIndex = 0; binIndex < layer.binCount; binIndex += 1) {
    const magnitude = Math.min(1, (layer.magnitudes[timeIndex * layer.binCount + binIndex] ?? 0) * gain);
    const frequencyRatio = binIndex / Math.max(1, layer.binCount - 1);
    const index = binIndex;
    positions[index * 3] = (frequencyRatio - 0.5) * WATERFALL_WIDTH;
    positions[index * 3 + 1] = WATERFALL_BASE_Y + magnitude * WATERFALL_AMPLITUDE_HEIGHT;
    positions[index * 3 + 2] = z;
    colors[index * 3] = color.r * (0.1 + magnitude * 1.2);
    colors[index * 3 + 1] = color.g * (0.1 + magnitude * 1.2);
    colors[index * 3 + 2] = color.b * (0.1 + magnitude * 1.2);
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

function LiveWaterfall(props: { frequencyData: Float32Array | Uint8Array | null; sampleRate: number | null }) {
  const binCount = LIVE_BIN_COUNT;
  const historySteps = LIVE_HISTORY_STEPS;
  const historyRef = useRef(new Float32Array(historySteps * binCount));
  const cursorRef = useRef(0);
  const lastWriteRef = useRef(0);
  const lastDrawRef = useRef(0);
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
        size: 0.041,
        vertexColors: true,
        transparent: true,
        opacity: 0.84,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    [],
  );

  useEffect(() => {
    historyRef.current = new Float32Array(historySteps * binCount);
    cursorRef.current = 0;
    lastWriteRef.current = 0;
  }, [binCount, historySteps]);

  useFrame((state) => {
    if (state.clock.elapsedTime - lastDrawRef.current < 1 / 24) {
      return;
    }
    lastDrawRef.current = state.clock.elapsedTime;

    if (!props.frequencyData || props.frequencyData.length < 2 || !props.sampleRate) {
      const history = historyRef.current;
      for (let index = 0; index < history.length; index += 1) {
        history[index] *= 0.965;
      }
      writeLiveWaterfallGeometry(geometry, history, cursorRef.current, binCount, historySteps);
      return;
    }

    if (state.clock.elapsedTime - lastWriteRef.current >= 1 / 24) {
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

    writeLiveWaterfallGeometry(geometry, historyRef.current, cursorRef.current, binCount, historySteps);
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
): void {
  const positions = geometry.attributes.position.array as Float32Array;
  const colors = geometry.attributes.color?.array as Float32Array | undefined;
  const depth = WATERFALL_DEPTH;
  const zStart = -WATERFALL_DEPTH / 2;
  let outputIndex = 0;

  for (let age = 0; age < historySteps; age += 1) {
    const sourceRow = (cursor - 1 - age + historySteps) % historySteps;
    const ageRatio = age / Math.max(1, historySteps - 1);
    const z = zStart + ageRatio * depth;
    const fade = 1 - ageRatio * 0.72;

    for (let binIndex = 0; binIndex < binCount; binIndex += 1) {
      const frequencyRatio = binIndex / Math.max(1, binCount - 1);
      const magnitude = history[sourceRow * binCount + binIndex] * fade;
      positions[outputIndex * 3] = (frequencyRatio - 0.5) * WATERFALL_WIDTH;
      positions[outputIndex * 3 + 1] = WATERFALL_BASE_Y + magnitude * WATERFALL_AMPLITUDE_HEIGHT;
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

  return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
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
