import createGgWave, { type GgWaveModule, type GgWaveParameters, type GgWaveProtocol } from "@vpalmisano/ggwave";

const GGWAVE_VOLUME = 10;
const PCM_8_MAX = 127;
const PCM_8_MIN = -128;

let modulePromise: Promise<GgWaveModule> | null = null;

type GgWavePayload = string | Uint8Array;

type GgWaveInstance = {
  module: GgWaveModule;
  id: number;
};

const getModule = async (): Promise<GgWaveModule> => {
  modulePromise ??= createGgWave();
  return modulePromise;
};

const makeParameters = (module: GgWaveModule, sampleRate: number): GgWaveParameters => {
  const parameters = module.getDefaultParameters();
  parameters.sampleRate = sampleRate;
  parameters.sampleRateInp = sampleRate;
  parameters.sampleRateOut = sampleRate;
  parameters.operatingMode |= module.GGWAVE_OPERATING_MODE_USE_DSS;
  return parameters;
};

const withInstance = async <T>(sampleRate: number, run: (instance: GgWaveInstance) => T): Promise<T> => {
  const module = await getModule();
  const id = module.init(makeParameters(module, sampleRate));

  try {
    return run({ module, id });
  } finally {
    module.free(id);
  }
};

const preferredProtocol = (module: GgWaveModule): GgWaveProtocol =>
  module.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST
  ?? module.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_NORMAL
  ?? module.ProtocolId.GGWAVE_PROTOCOL_AUDIBLE_FAST;

const bytesFromWaveform = (waveform: Int8Array | Uint8Array | string): Int8Array => {
  if (typeof waveform === "string") {
    return Int8Array.from(new TextEncoder().encode(waveform), (byte) => byte - 128);
  }

  if (waveform instanceof Int8Array) {
    return new Int8Array(waveform.buffer.slice(waveform.byteOffset, waveform.byteOffset + waveform.byteLength));
  }

  return Int8Array.from(waveform, (byte) => byte - 128);
};

const bytesFromDecoded = (decoded: Int8Array | Uint8Array | string | null): Uint8Array | null => {
  if (decoded === null) {
    return null;
  }

  if (typeof decoded === "string") {
    return new TextEncoder().encode(decoded);
  }

  const bytes = new Uint8Array(decoded.byteLength);
  for (let index = 0; index < decoded.byteLength; index += 1) {
    bytes[index] = decoded[index] & 0xff;
  }
  return bytes;
};

export const encodeGgWave = async (payload: GgWavePayload, sampleRate: number): Promise<Float32Array> => {
  const waveform = await withInstance(sampleRate, ({ module, id }) =>
    bytesFromWaveform(module.encode(id, payload, preferredProtocol(module), GGWAVE_VOLUME)),
  );
  const samples = new Float32Array(waveform.length);

  for (let index = 0; index < samples.length; index += 1) {
    const value = waveform[index];
    samples[index] = value < 0 ? value / -PCM_8_MIN : value / PCM_8_MAX;
  }

  return samples;
};

export const decodeGgWave = async (samples: Float32Array, sampleRate: number): Promise<Uint8Array | null> => {
  const bytes = new Int8Array(samples.length);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    const intSample = clamped < 0 ? clamped * -PCM_8_MIN : clamped * PCM_8_MAX;
    bytes[index] = Math.round(intSample);
  }

  return withInstance(sampleRate, ({ module, id }) => bytesFromDecoded(module.decode(id, bytes)));
};
