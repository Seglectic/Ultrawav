import { downmixWindow, mixMonoSignal, normalizeAudioBuffer, cloneAudioBuffer, lowPassAudioBuffer } from "./buffer";
import { makeExportArtifacts } from "./export";
import { assembleFrames, crc32, decodeFrame, encodeFrames, MAX_FILE_PAYLOAD_BYTES } from "./framing";
import { decodeGgWave, encodeGgWave } from "../ggwave/adapter";

import type { DetectedPayload, EmbedResult, ExportArtifact, HighlightRegion, PayloadInput } from "../types/payload";

export { MAX_FILE_PAYLOAD_BYTES };
export type { DetectedPayload, EmbedResult, ExportArtifact, HighlightRegion, PayloadInput };

const TEXT_EMBED_START_SECONDS = 0.5;
const TAIL_EMBED_GAP_SECONDS = 0.5;
const FRAME_GAP_SECONDS = 0.25;
const EMBED_SIGNAL_GAIN = 0.35;
const CARRIER_LOW_PASS_HZ = 14_000;
const DETECTION_START_SECONDS = 90;
const DETECTION_TAIL_SECONDS = 600;
const DETECTION_WINDOW_SECONDS = 24;
const DETECTION_STEP_SECONDS = 1;

type AudioContextWindow = Window & {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
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
  const encodedFrames = await Promise.all(frames.map((frame) => encodeGgWave(frame, carrier.sampleRate)));
  const frameGapSamples = Math.round(FRAME_GAP_SECONDS * carrier.sampleRate);
  const embedStartSeconds = payload.kind === "text" ? TEXT_EMBED_START_SECONDS : carrier.duration + TAIL_EMBED_GAP_SECONDS;
  let cursor = Math.round(embedStartSeconds * carrier.sampleRate);

  const embeddedLength = encodedFrames.reduce(
    (length, frame) => length + frame.length + frameGapSamples,
    0,
  );
  const outputLength = Math.max(carrier.length, cursor + embeddedLength);
  const filteredCarrier = await lowPassAudioBuffer(carrier, CARRIER_LOW_PASS_HZ);
  const output = cloneAudioBuffer(filteredCarrier, outputLength);
  const dataBuffer = new AudioBuffer({
    length: outputLength,
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

const scanRegion = async (
  buffer: AudioBuffer,
  startSeconds: number,
  endSeconds: number,
  frameMap: Map<string, ReturnType<typeof decodeFrame>>,
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
    frameMap.set(key, frame);
  }
};

export const detectEmbeddedPayload = async (buffer: AudioBuffer): Promise<DetectedPayload | null> => {
  const frames = new Map<string, ReturnType<typeof decodeFrame>>();
  const duration = buffer.duration;
  await scanRegion(buffer, 0, Math.min(duration, DETECTION_START_SECONDS), frames);

  const tailStart = Math.max(0, duration - DETECTION_TAIL_SECONDS);
  if (tailStart > DETECTION_START_SECONDS) {
    await scanRegion(buffer, tailStart, duration, frames);
  }

  const frameList = [...frames.values()].filter((frame) => frame !== null);
  const groups = new Map<string, typeof frameList>();

  for (const frame of frameList) {
    const key = [frame.kind, frame.fileName, frame.mimeType, frame.size, frame.crc32, frame.chunkTotal].join(":");
    const group = groups.get(key) ?? [];
    group.push(frame);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const payload = assembleFrames(group);
    if (payload !== null) {
      return payload;
    }
  }

  return null;
};

export const exportAudio = (
  buffer: AudioBuffer,
  baseName: string,
  verify: (buffer: AudioBuffer) => Promise<boolean>,
): Promise<ExportArtifact[]> => makeExportArtifacts(buffer, baseName, verify);

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
