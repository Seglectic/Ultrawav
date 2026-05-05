export type SpectrumVisualizer = {
  render(options: SpectrumRenderOptions): void;
  dispose(): void;
};

export type SpectrumRenderOptions = {
  carrier: AudioBuffer | null;
  data: AudioBuffer | null;
  regions: readonly { start: number; end: number; kind: string }[];
  playheadTime: number | null;
};

type RegionRole = "start-packet" | "tail" | "payload" | "selection";

type ResolvedRegion = {
  start: number;
  end: number;
  role: RegionRole;
};

type AudioOverview = {
  buffer: AudioBuffer;
  peaks: Float32Array;
};

const BIN_COUNT = 112;
const FOURIER_WINDOW_SIZE = 2048;
const OVERVIEW_BUCKET_COUNT = 720;
const MIN_FREQUENCY_HZ = 30;
const MAX_FREQUENCY_HZ = 22_000;
const TOP_PANEL_RATIO = 0.32;
const PANEL_GAP_PX = 18;
const EDGE_PADDING_PX = 28;
const PLAYHEAD_WIDTH_PX = 2;
const MIN_CANVAS_SIZE_PX = 1;
const AMPLITUDE_FLOOR = 0.000_001;

const COLORS = {
  background: "#080b11",
  carrier: "#54e7ff",
  data: "#ff6b9d",
  startPacket: "rgba(91, 141, 255, 0.26)",
  tail: "rgba(255, 190, 92, 0.24)",
  grid: "rgba(255, 255, 255, 0.09)",
  text: "rgba(232, 238, 247, 0.7)",
};

export function createSpectrumVisualizer(canvas: HTMLCanvasElement): SpectrumVisualizer {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("2D canvas context unavailable for spectrum visualizer.");
  }
  const renderingContext = context;

  let disposed = false;
  let carrierOverview: AudioOverview | null = null;
  let dataOverview: AudioOverview | null = null;

  function render(options: SpectrumRenderOptions): void {
    if (disposed) {
      return;
    }

    if (carrierOverview?.buffer !== options.carrier) {
      carrierOverview = options.carrier ? buildOverview(options.carrier) : null;
    }
    if (dataOverview?.buffer !== options.data) {
      dataOverview = options.data ? buildOverview(options.data) : null;
    }

    const { width, height } = resizeCanvasToDisplaySize(canvas, renderingContext);
    drawBackground(renderingContext, width, height);

    const overviewHeight = Math.max(80, height * TOP_PANEL_RATIO);
    const spectrumTop = overviewHeight + PANEL_GAP_PX;
    const spectrumHeight = Math.max(80, height - spectrumTop - EDGE_PADDING_PX);
    const duration = Math.max(options.carrier?.duration ?? 0, options.data?.duration ?? 0, 1);
    const playheadTime = Math.max(0, options.playheadTime ?? 0);
    const regions = options.regions.map(resolveRegion).filter((region): region is ResolvedRegion => region !== null);

    drawRegions(renderingContext, regions, duration, EDGE_PADDING_PX, width - EDGE_PADDING_PX, 0, overviewHeight);
    drawOverview(renderingContext, carrierOverview, EDGE_PADDING_PX, width - EDGE_PADDING_PX, 0, overviewHeight, COLORS.carrier);
    drawOverview(renderingContext, dataOverview, EDGE_PADDING_PX, width - EDGE_PADDING_PX, 0, overviewHeight, COLORS.data);
    drawPlayhead(renderingContext, playheadTime, duration, EDGE_PADDING_PX, width - EDGE_PADDING_PX, 0, overviewHeight);

    drawSpectrumPanel(renderingContext, EDGE_PADDING_PX, spectrumTop, width - EDGE_PADDING_PX, spectrumHeight);
    drawSpectrumLayer(renderingContext, options.carrier, playheadTime, EDGE_PADDING_PX, spectrumTop, width - EDGE_PADDING_PX, spectrumHeight, COLORS.carrier);
    drawSpectrumLayer(renderingContext, options.data, playheadTime, EDGE_PADDING_PX, spectrumTop, width - EDGE_PADDING_PX, spectrumHeight, COLORS.data);
    drawFrequencyLabels(renderingContext, EDGE_PADDING_PX, spectrumTop, width - EDGE_PADDING_PX, spectrumHeight);
  }

  function dispose(): void {
    disposed = true;
    carrierOverview = null;
    dataOverview = null;
    renderingContext.clearRect(0, 0, canvas.width, canvas.height);
  }

  return { render, dispose };
}

function resizeCanvasToDisplaySize(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): { width: number; height: number } {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const displayWidth = Math.max(MIN_CANVAS_SIZE_PX, canvas.clientWidth || canvas.width || MIN_CANVAS_SIZE_PX);
  const displayHeight = Math.max(MIN_CANVAS_SIZE_PX, canvas.clientHeight || canvas.height || MIN_CANVAS_SIZE_PX);
  const targetWidth = Math.round(displayWidth * devicePixelRatio);
  const targetHeight = Math.round(displayHeight * devicePixelRatio);

  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }

  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  return { width: displayWidth, height: displayHeight };
}

function buildOverview(buffer: AudioBuffer): AudioOverview {
  const bucketCount = Math.min(OVERVIEW_BUCKET_COUNT, Math.max(1, buffer.length));
  const peaks = new Float32Array(bucketCount);
  const samplesPerBucket = Math.max(1, Math.floor(buffer.length / bucketCount));

  for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
    const start = bucketIndex * samplesPerBucket;
    const end = Math.min(buffer.length, start + samplesPerBucket);
    let peak = 0;

    for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
      peak = Math.max(peak, Math.abs(readMixedSample(buffer, sampleIndex)));
    }

    peaks[bucketIndex] = peak;
  }

  normalizeInPlace(peaks);
  return { buffer, peaks };
}

function readMixedSample(buffer: AudioBuffer, sampleIndex: number): number {
  const channelCount = buffer.numberOfChannels;
  if (channelCount === 1) {
    return buffer.getChannelData(0)[sampleIndex] ?? 0;
  }

  let sum = 0;
  for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
    sum += buffer.getChannelData(channelIndex)[sampleIndex] ?? 0;
  }
  return sum / channelCount;
}

function drawBackground(context: CanvasRenderingContext2D, width: number, height: number): void {
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);

  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.045)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);
}

function drawRegions(
  context: CanvasRenderingContext2D,
  regions: readonly ResolvedRegion[],
  duration: number,
  left: number,
  right: number,
  top: number,
  height: number,
): void {
  for (const region of regions) {
    if (region.role !== "start-packet" && region.role !== "tail") {
      continue;
    }

    const regionLeft = left + (region.start / duration) * (right - left);
    const regionRight = left + (region.end / duration) * (right - left);
    context.fillStyle = region.role === "start-packet" ? COLORS.startPacket : COLORS.tail;
    context.fillRect(regionLeft, top, Math.max(1, regionRight - regionLeft), height);
  }
}

function drawOverview(
  context: CanvasRenderingContext2D,
  overview: AudioOverview | null,
  left: number,
  right: number,
  top: number,
  height: number,
  color: string,
): void {
  if (!overview) {
    return;
  }

  const centerY = top + height / 2;
  const halfHeight = height * 0.36;
  context.save();
  context.strokeStyle = color;
  context.globalAlpha = 0.78;
  context.lineWidth = 1.25;
  context.beginPath();

  for (let index = 0; index < overview.peaks.length; index += 1) {
    const x = left + (index / Math.max(1, overview.peaks.length - 1)) * (right - left);
    const y = centerY - overview.peaks[index] * halfHeight;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  for (let index = overview.peaks.length - 1; index >= 0; index -= 1) {
    const x = left + (index / Math.max(1, overview.peaks.length - 1)) * (right - left);
    const y = centerY + overview.peaks[index] * halfHeight;
    context.lineTo(x, y);
  }

  context.closePath();
  context.stroke();
  context.globalAlpha = 0.16;
  context.fillStyle = color;
  context.fill();
  context.restore();
}

function drawPlayhead(
  context: CanvasRenderingContext2D,
  playheadTime: number,
  duration: number,
  left: number,
  right: number,
  top: number,
  height: number,
): void {
  const x = left + (Math.min(playheadTime, duration) / duration) * (right - left);
  context.fillStyle = "rgba(255, 255, 255, 0.82)";
  context.fillRect(x - PLAYHEAD_WIDTH_PX / 2, top, PLAYHEAD_WIDTH_PX, height);
}

function drawSpectrumPanel(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  height: number,
): void {
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;

  for (let gridIndex = 0; gridIndex <= 4; gridIndex += 1) {
    const y = top + (gridIndex / 4) * height;
    context.beginPath();
    context.moveTo(left, y);
    context.lineTo(right, y);
    context.stroke();
  }
}

function drawSpectrumLayer(
  context: CanvasRenderingContext2D,
  buffer: AudioBuffer | null,
  playheadTime: number,
  left: number,
  top: number,
  right: number,
  height: number,
  color: string,
): void {
  if (!buffer) {
    return;
  }

  const spectrum = computeSpectrum(buffer, playheadTime);
  context.save();
  context.strokeStyle = color;
  context.shadowColor = color;
  context.shadowBlur = 8;
  context.lineWidth = 2;
  context.beginPath();

  for (let index = 0; index < spectrum.length; index += 1) {
    const x = left + (index / Math.max(1, spectrum.length - 1)) * (right - left);
    const y = top + height - spectrum[index] * height;
    if (index === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  context.stroke();
  context.restore();
}

function drawFrequencyLabels(
  context: CanvasRenderingContext2D,
  left: number,
  top: number,
  right: number,
  height: number,
): void {
  context.fillStyle = COLORS.text;
  context.font = "12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  context.textBaseline = "bottom";
  context.fillText(`${MIN_FREQUENCY_HZ} Hz`, left, top + height + 18);
  context.textAlign = "right";
  context.fillText(`${Math.round(MAX_FREQUENCY_HZ / 1000)} kHz`, right, top + height + 18);
  context.textAlign = "left";
}

function computeSpectrum(buffer: AudioBuffer, playheadTime: number): Float32Array {
  const spectrum = new Float32Array(BIN_COUNT);
  const centerSample = Math.round(playheadTime * buffer.sampleRate);
  const startSample = centerSample - Math.floor(FOURIER_WINDOW_SIZE / 2);
  const logMin = Math.log(MIN_FREQUENCY_HZ);
  const logMax = Math.log(Math.min(MAX_FREQUENCY_HZ, buffer.sampleRate / 2));

  for (let binIndex = 0; binIndex < BIN_COUNT; binIndex += 1) {
    const binRatio = binIndex / Math.max(1, BIN_COUNT - 1);
    const frequencyHz = Math.exp(logMin + (logMax - logMin) * binRatio);
    spectrum[binIndex] = computeWindowMagnitude(buffer, startSample, frequencyHz);
  }

  normalizeInPlace(spectrum);
  return spectrum;
}

function computeWindowMagnitude(buffer: AudioBuffer, startSample: number, frequencyHz: number): number {
  const phaseStep = (Math.PI * 2 * frequencyHz) / buffer.sampleRate;
  const phaseCos = Math.cos(phaseStep);
  const phaseSin = Math.sin(phaseStep);
  let oscillatorCos = 1;
  let oscillatorSin = 0;
  let real = 0;
  let imaginary = 0;

  for (let windowIndex = 0; windowIndex < FOURIER_WINDOW_SIZE; windowIndex += 1) {
    const sampleIndex = startSample + windowIndex;
    const sample = sampleIndex >= 0 && sampleIndex < buffer.length ? readMixedSample(buffer, sampleIndex) : 0;
    const windowValue = 0.5 - 0.5 * Math.cos((Math.PI * 2 * windowIndex) / Math.max(1, FOURIER_WINDOW_SIZE - 1));
    real += sample * windowValue * oscillatorCos;
    imaginary -= sample * windowValue * oscillatorSin;

    const nextCos = oscillatorCos * phaseCos - oscillatorSin * phaseSin;
    oscillatorSin = oscillatorSin * phaseCos + oscillatorCos * phaseSin;
    oscillatorCos = nextCos;
  }

  return Math.sqrt(real * real + imaginary * imaginary) / FOURIER_WINDOW_SIZE;
}

function normalizeInPlace(values: Float32Array): void {
  let peak = AMPLITUDE_FLOOR;
  for (const value of values) {
    peak = Math.max(peak, Math.abs(value));
  }

  for (let index = 0; index < values.length; index += 1) {
    values[index] = Math.min(1, Math.sqrt(Math.abs(values[index]) / peak));
  }
}

function resolveRegion(region: SpectrumRenderOptions["regions"][number]): ResolvedRegion | null {
  if (region.end <= region.start) {
    return null;
  }

  return {
    start: Math.max(0, region.start),
    end: Math.max(0, region.end),
    role: resolveRegionRole(region.kind),
  };
}

function resolveRegionRole(kind: string): RegionRole {
  const normalized = kind.toLowerCase();
  if (normalized === "text") {
    return "start-packet";
  }
  if (normalized === "file") {
    return "tail";
  }
  if (normalized.includes("start")) {
    return "start-packet";
  }
  if (normalized.includes("tail") || normalized.includes("append")) {
    return "tail";
  }
  if (normalized.includes("payload") || normalized.includes("data")) {
    return "payload";
  }
  return "selection";
}
