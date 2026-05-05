import type { ExportArtifact } from "../types/payload";

const PCM_16_MAX = 32767;
const PCM_16_MIN = -32768;
const WAV_HEADER_BYTES = 44;

const sanitizeBaseName = (baseName: string): string => {
  const clean = baseName.trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return clean.length > 0 ? clean : "audio";
};

const decodeAudioBlob = async (blob: Blob): Promise<AudioBuffer> => {
  const AudioContextConstructor = window.AudioContext;
  const context = new AudioContextConstructor();

  try {
    return await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
};

export const encodeWavBlob = (buffer: AudioBuffer): Blob => {
  const bytesPerSample = 2;
  const blockAlign = buffer.numberOfChannels * bytesPerSample;
  const dataBytes = buffer.length * blockAlign;
  const wavBytes = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(wavBytes.buffer);
  let offset = 0;

  const writeAscii = (value: string): void => {
    for (let index = 0; index < value.length; index += 1) {
      wavBytes[offset] = value.charCodeAt(index);
      offset += 1;
    }
  };

  writeAscii("RIFF");
  view.setUint32(offset, 36 + dataBytes, true);
  offset += 4;
  writeAscii("WAVE");
  writeAscii("fmt ");
  view.setUint32(offset, 16, true);
  offset += 4;
  view.setUint16(offset, 1, true);
  offset += 2;
  view.setUint16(offset, buffer.numberOfChannels, true);
  offset += 2;
  view.setUint32(offset, buffer.sampleRate, true);
  offset += 4;
  view.setUint32(offset, buffer.sampleRate * blockAlign, true);
  offset += 4;
  view.setUint16(offset, blockAlign, true);
  offset += 2;
  view.setUint16(offset, 16, true);
  offset += 2;
  writeAscii("data");
  view.setUint32(offset, dataBytes, true);
  offset += 4;

  for (let sample = 0; sample < buffer.length; sample += 1) {
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      const clamped = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[sample]));
      const intSample = clamped < 0 ? clamped * -PCM_16_MIN : clamped * PCM_16_MAX;
      view.setInt16(offset, Math.round(intSample), true);
      offset += bytesPerSample;
    }
  }

  return new Blob([wavBytes], { type: "audio/wav" });
};

export const makeExportArtifacts = async (
  buffer: AudioBuffer,
  baseName: string,
  verify: (buffer: AudioBuffer) => Promise<boolean>,
): Promise<ExportArtifact[]> => {
  const safeBaseName = sanitizeBaseName(baseName);
  const wavBlob = encodeWavBlob(buffer);
  let wavVerified = false;

  try {
    wavVerified = await verify(await decodeAudioBlob(wavBlob));
  } catch {
    wavVerified = await verify(buffer);
  }

  return [{
    kind: "wav",
    format: "wav",
    blob: wavBlob,
    fileName: `${safeBaseName}.wav`,
    mimeType: "audio/wav",
    verified: wavVerified,
    message: wavVerified ? "WAV export verified." : "WAV export ready; verification failed.",
  }];
};
