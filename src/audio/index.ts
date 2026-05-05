import { downmixWindow, mixMonoSignal, normalizeAudioBuffer, cloneAudioBuffer, lowPassAudioBuffer } from "./buffer";
import { makeExportArtifacts } from "./export";
import { assembleFrames, crc32, decodeFrame, encodeFrames, MAX_FILE_PAYLOAD_BYTES } from "./framing";
import { decodeGgWave, encodeGgWave } from "../ggwave/adapter";

import type { DetectedPayload, EmbedResult, ExportArtifact, HighlightRegion, PayloadInput } from "../types/payload";

export { MAX_FILE_PAYLOAD_BYTES };
export type { DetectedPayload, EmbedResult, ExportArtifact, HighlightRegion, PayloadInput };

const EMBED_START_SECONDS = 0.5;
const FRAME_GAP_SECONDS = 0.25;
const EMBED_SIGNAL_GAIN = 0.22;
const EMBED_SIGNAL_FADE_SECONDS = 0.01;
const CARRIER_LOW_PASS_HZ = 17_000;
const DETECTION_START_SECONDS = 90;
const DETECTION_TAIL_SECONDS = 600;
const DETECTION_WINDOW_SECONDS = 24;
const DETECTION_STEP_SECONDS = 1;
const DETECTED_FRAME_REGION_SECONDS = 8;

type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
};

type DecodedFrame = NonNullable<ReturnType<typeof decodeFrame>>;

type ScannedFrame = {
  frame: DecodedFrame;
  start: number;
  end: number;
};

const textEncoder = new TextEncoder();

const makeAudioContext = (): AudioContext => {
  const contextWindow = window as AudioContextWindow;
  const AudioContextConstructor = contextWindow.AudioContext ?? contextWindow.webkitAudioContext;

  if (AudioContextConstructor === undefined) {
    throw new Error("Web Audio is unavailable in this browser.");
  }

  return new AudioContextConstructor();
};

export const decodeAudioFile = async (file: File): Promise<AudioBuffer> => {
  const context = makeAudioContext();

  try {
    return await context.decodeAudioData(await file.arrayBuffer());
  } finally {
    await context.close();
  }
};

export const readFilePayload = async (file: File): Promise<PayloadInput> => {
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (bytes.byteLength > MAX_FILE_PAYLOAD_BYTES) {
    throw new Error(`File payload must be ${MAX_FILE_PAYLOAD_BYTES} bytes or smaller.`);
  }

  return {
    kind: "file",
    bytes,
    size: bytes.byteLength,
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
  };
};

export const makeTextPayload = (text: string): PayloadInput => {
  const bytes = textEncoder.encode(text);
  return {
    kind: "text",
    text,
    bytes,
    size: bytes.byteLength,
    fileName: "message.txt",
    mimeType: "text/plain;charset=utf-8",
  };
};

const frameLabel = (payload: PayloadInput): string => payload.kind === "text" ? "Text payload" : payload.fileName;

export const embedPayload = async (carrier: AudioBuffer, payload: PayloadInput): Promise<EmbedResult> => {
  const frames = encodeFrames(payload);
  const fadeSamples = Math.round(EMBED_SIGNAL_FADE_SECONDS * carrier.sampleRate);
  const encodedFrames = await Promise.all(frames.map(async (frame) => fadeSignalEdges(await encodeGgWave(frame, carrier.sampleRate), fadeSamples)));
  const frameGapSamples = Math.round(FRAME_GAP_SECONDS * carrier.sampleRate);
  const embeddedLength = encodedFrames.reduce(
    (length, frame) => length + frame.length + frameGapSamples,
    0,
  );
  let cursor = Math.round(EMBED_START_SECONDS * carrier.sampleRate);

  if (cursor + embeddedLength > carrier.length) {
    throw new Error(`Payload needs ${formatSeconds(embeddedLength / carrier.sampleRate)} of carrier after ${formatSeconds(EMBED_START_SECONDS)}.`);
  }

  const filteredCarrier = await lowPassAudioBuffer(carrier, CARRIER_LOW_PASS_HZ);
  const output = cloneAudioBuffer(filteredCarrier);
  const dataBuffer = new AudioBuffer({
    length: output.length,
    numberOfChannels: carrier.numberOfChannels,
    sampleRate: carrier.sampleRate,
  });
  const highlightStart = cursor;

  for (const frame of encodedFrames) {
    mixMonoSignal(dataBuffer, frame, cursor, EMBED_SIGNAL_GAIN);
    cursor = mixMonoSignal(output, frame, cursor, EMBED_SIGNAL_GAIN) + frameGapSamples;
  }

  normalizeAudioBuffer(output);

  const highlight: HighlightRegion = {
    kind: payload.kind,
    start: highlightStart / carrier.sampleRate,
    end: cursor / carrier.sampleRate,
    startTime: highlightStart / carrier.sampleRate,
    endTime: cursor / carrier.sampleRate,
    label: frameLabel(payload),
  };
  const checksum = crc32(payload.bytes);
  const embedded: DetectedPayload = payload.kind === "text"
    ? {
        kind: "text",
        text: payload.text,
        bytes: payload.bytes,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        size: payload.bytes.byteLength,
        crc32: checksum,
        chunks: frames.length,
        chunkCount: frames.length,
        regions: [highlight],
      }
    : {
        kind: "file",
        bytes: payload.bytes,
        fileName: payload.fileName,
        mimeType: payload.mimeType,
        size: payload.bytes.byteLength,
        crc32: checksum,
        chunks: frames.length,
        chunkCount: frames.length,
        regions: [highlight],
      };

  return {
    buffer: output,
    dataBuffer,
    payload,
    highlights: [highlight],
    regions: [highlight],
    embedded,
  };
};

const formatSeconds = (seconds: number): string => `${seconds.toFixed(1)}s`;

const fadeSignalEdges = (signal: Float32Array, fadeSamples: number): Float32Array => {
  if (fadeSamples <= 1) {
    return signal;
  }

  const faded = new Float32Array(signal);
  const fadeLength = Math.min(fadeSamples, Math.floor(faded.length / 2));

  for (let index = 0; index < fadeLength; index += 1) {
    const gain = index / fadeLength;
    faded[index] *= gain;
    faded[faded.length - 1 - index] *= gain;
  }

  return faded;
};

const scanRegion = async (
  buffer: AudioBuffer,
  startSeconds: number,
  endSeconds: number,
  frameMap: Map<string, ScannedFrame>,
): Promise<void> => {
  const windowSamples = Math.round(DETECTION_WINDOW_SECONDS * buffer.sampleRate);
  const stepSamples = Math.round(DETECTION_STEP_SECONDS * buffer.sampleRate);
  const startSample = Math.round(startSeconds * buffer.sampleRate);
  const endSample = Math.round(endSeconds * buffer.sampleRate);

  for (let cursor = startSample; cursor < endSample; cursor += stepSamples) {
    const samples = downmixWindow(buffer, cursor, Math.min(windowSamples, endSample - cursor));
    if (samples.length === 0) {
      continue;
    }

    const decoded = await decodeGgWave(samples, buffer.sampleRate);
    if (decoded === null) {
      continue;
    }

    const frame = decodeFrame(decoded);
    if (frame === null) {
      continue;
    }

    const key = [
      frame.kind,
      frame.fileName,
      frame.mimeType,
      frame.size,
      frame.crc32,
      frame.chunkIndex,
      frame.chunkTotal,
    ].join(":");
    frameMap.set(key, {
      frame,
      start: cursor / buffer.sampleRate,
      end: Math.min(endSeconds, cursor / buffer.sampleRate + DETECTED_FRAME_REGION_SECONDS),
    });
  }
};

const assembleDetectedFrames = (frames: Map<string, ScannedFrame>): DetectedPayload | null => {
  const frameList = [...frames.values()];
  const groups = new Map<string, ScannedFrame[]>();

  for (const scanned of frameList) {
    const frame = scanned.frame;
    const key = [frame.kind, frame.fileName, frame.mimeType, frame.size, frame.crc32, frame.chunkTotal].join(":");
    const group = groups.get(key) ?? [];
    group.push(scanned);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const payload = assembleFrames(group.map((scanned) => scanned.frame));
    if (payload !== null) {
      const start = Math.min(...group.map((scanned) => scanned.start));
      const end = Math.max(...group.map((scanned) => scanned.end));
      const region: HighlightRegion = {
        kind: payload.kind,
        start,
        end,
        startTime: start,
        endTime: end,
        label: payload.kind === "file" ? payload.fileName : "Text payload",
      };
      return {
        ...payload,
        regions: [region],
      };
    }
  }

  return null;
};

export const detectEmbeddedPayload = async (
  buffer: AudioBuffer,
  regions: readonly HighlightRegion[] = [],
): Promise<DetectedPayload | null> => {
  const frames = new Map<string, ScannedFrame>();
  const duration = buffer.duration;

  for (const region of regions) {
    await scanRegion(buffer, region.start, Math.min(duration, region.end), frames);
  }

  const detectedFromRegions = assembleDetectedFrames(frames);
  if (detectedFromRegions !== null) {
    return detectedFromRegions;
  }

  await scanRegion(
    buffer,
    EMBED_START_SECONDS,
    Math.min(duration, EMBED_START_SECONDS + DETECTION_WINDOW_SECONDS),
    frames,
  );

  const detectedFromDefaultStart = assembleDetectedFrames(frames);
  if (detectedFromDefaultStart !== null) {
    return detectedFromDefaultStart;
  }

  await scanRegion(buffer, 0, Math.min(duration, DETECTION_START_SECONDS), frames);

  const tailStart = Math.max(0, duration - DETECTION_TAIL_SECONDS);
  if (tailStart > DETECTION_START_SECONDS) {
    await scanRegion(buffer, tailStart, duration, frames);
  }

  return assembleDetectedFrames(frames);
};

export const exportAudio = (
  buffer: AudioBuffer,
  baseName: string,
  verify: (buffer: AudioBuffer) => Promise<boolean>,
): Promise<ExportArtifact[]> => makeExportArtifacts(buffer, baseName, verify);

export const extractEmbeddedDataBuffer = async (
  buffer: AudioBuffer,
  regions: readonly HighlightRegion[],
): Promise<AudioBuffer | null> => {
  const usableRegions = regions.filter((region) => region.end > region.start);
  if (usableRegions.length === 0) {
    return null;
  }

  const lowPassed = await lowPassAudioBuffer(buffer, CARRIER_LOW_PASS_HZ);
  const output = new AudioBuffer({
    length: buffer.length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });

  for (const region of usableRegions) {
    const startSample = Math.max(0, Math.floor(region.start * buffer.sampleRate));
    const endSample = Math.min(buffer.length, Math.ceil(region.end * buffer.sampleRate));

    for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
      const source = buffer.getChannelData(channelIndex);
      const low = lowPassed.getChannelData(channelIndex);
      const target = output.getChannelData(channelIndex);

      for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
        target[sampleIndex] = source[sampleIndex] - low[sampleIndex];
      }
    }
  }

  return normalizeAudioBuffer(output);
};

export const downloadArtifact = (artifact: ExportArtifact): void => {
  const url = URL.createObjectURL(artifact.blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = artifact.fileName;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};
