import { AudioSample, AudioSampleSource, BufferTarget, Mp3OutputFormat, Output, canEncodeAudio } from "mediabunny";

import type { ExportArtifact } from "../types/payload";

const PCM_16_MAX = 32767;
const PCM_16_MIN = -32768;
const WAV_HEADER_BYTES = 44;
const MP3_BITRATE = 320000;
let mp3EncoderRegistered = false;

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

const encodeMp3Blob = async (buffer: AudioBuffer): Promise<Blob> => {
  if (!mp3EncoderRegistered) {
    const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
    registerMp3Encoder();
    mp3EncoderRegistered = true;
  }

  if (!(await canEncodeAudio("mp3", { bitrate: MP3_BITRATE, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate }))) {
    throw new Error("MP3 encoding is unavailable in this browser.");
  }

  const target = new BufferTarget();
  const output = new Output({
    format: new Mp3OutputFormat(),
    target,
  });
  const source = new AudioSampleSource({ codec: "mp3", bitrate: MP3_BITRATE });
  output.addAudioTrack(source);
  await output.start();

  const samples = AudioSample.fromAudioBuffer(buffer, 0);
  for (const sample of samples) {
    try {
      await source.add(sample);
    } finally {
      sample.close();
    }
  }

  await output.finalize();

  if (target.buffer === null) {
    throw new Error("MP3 encoder finalized without output.");
  }

  return new Blob([target.buffer], { type: "audio/mpeg" });
};

export const makeExportArtifacts = async (
  buffer: AudioBuffer,
  baseName: string,
  verify: (buffer: AudioBuffer) => Promise<boolean>,
): Promise<ExportArtifact[]> => {
  const safeBaseName = sanitizeBaseName(baseName);
  const wavBlob = encodeWavBlob(buffer);
  const artifacts: ExportArtifact[] = [];
  let fallbackReason: string | undefined;

  try {
    const mp3Blob = await encodeMp3Blob(buffer);
    const decodedMp3 = await decodeAudioBlob(mp3Blob);
    const mp3Verified = await verify(decodedMp3);

    if (mp3Verified) {
      artifacts.push({
        kind: "mp3",
        format: "mp3",
        blob: mp3Blob,
        fileName: `${safeBaseName}.mp3`,
        mimeType: "audio/mpeg",
        verified: true,
        message: "MP3 export verified.",
      });
    } else {
      fallbackReason = "MP3 export did not pass verification.";
    }
  } catch (error) {
    fallbackReason = error instanceof Error ? error.message : "MP3 export failed.";
  }

  let wavVerified = false;
  try {
    wavVerified = await verify(await decodeAudioBlob(wavBlob));
  } catch {
    wavVerified = await verify(buffer);
  }

  artifacts.push({
    kind: "wav",
    format: "wav",
    blob: wavBlob,
    fileName: `${safeBaseName}.wav`,
    mimeType: "audio/wav",
    verified: wavVerified,
    message: fallbackReason ?? (wavVerified ? "WAV export verified." : "WAV export ready; verification failed."),
    fallbackReason,
  });

  return artifacts;
};
