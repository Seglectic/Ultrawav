import createGgWave, { type GgWaveModule, type GgWaveParameters, type GgWaveProtocol } from "@vpalmisano/ggwave";

const GGWAVE_VOLUME = 10;
const DECODE_NORMALIZE_FLOOR = 0.000_001;
const TARGET_ULTRASONIC_START_HZ = 18_000;

let modulePromise: Promise<GgWaveModule> | null = null;

type GgWavePayload = string | Uint8Array;

type GgWaveInstance = {
  module: GgWaveModule;
  id: number;
};

const createSilentModule = (): Promise<GgWaveModule> =>
  createGgWave({
    print: () => undefined,
    printErr: () => undefined,
  });

const getModule = async (): Promise<GgWaveModule> => {
  modulePromise ??= createSilentModule();
  return modulePromise;
};

const makeParameters = (module: GgWaveModule, sampleRate: number): GgWaveParameters => {
  const parameters = module.getDefaultParameters();
  parameters.sampleRate = sampleRate;
  parameters.sampleRateInp = sampleRate;
  parameters.sampleRateOut = sampleRate;
  parameters.sampleFormatInp = module.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.sampleFormatOut = module.SampleFormat.GGWAVE_SAMPLE_FORMAT_F32;
  parameters.operatingMode |= module.GGWAVE_OPERATING_MODE_USE_DSS;
  return parameters;
};

const tuneUltrasonicProtocol = (module: GgWaveModule, sampleRate: number): void => {
  const protocol = preferredProtocol(module);
  const frequencyBin = Math.round((TARGET_ULTRASONIC_START_HZ * 1024) / sampleRate);
  module.txProtocolSetFreqStart(protocol, frequencyBin);
  module.rxProtocolSetFreqStart(protocol, frequencyBin);
};

const withInstance = async <T>(sampleRate: number, run: (instance: GgWaveInstance) => T): Promise<T> => {
  const module = await getModule();
  tuneUltrasonicProtocol(module, sampleRate);
  const id = module.init(makeParameters(module, sampleRate));

  try {
    return run({ module, id });
  } finally {
    module.free(id);
  }
};

const withFreshInstance = async <T>(sampleRate: number, run: (instance: GgWaveInstance) => T): Promise<T> => {
  const module = await createSilentModule();
  tuneUltrasonicProtocol(module, sampleRate);
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

const bytesFromWaveform = (waveform: Int8Array | Uint8Array | string): Uint8Array => {
  if (typeof waveform === "string") {
    return new TextEncoder().encode(waveform);
  }

  return new Uint8Array(waveform.buffer.slice(waveform.byteOffset, waveform.byteOffset + waveform.byteLength));
};

const samplesFromWaveform = (waveform: Int8Array | Uint8Array | string): Float32Array => {
  const bytes = bytesFromWaveform(waveform);

  if (bytes.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error("GGWave returned non-F32 waveform data.");
  }

  return new Float32Array(bytes.buffer);
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
  return withInstance(sampleRate, ({ module, id }) =>
    samplesFromWaveform(module.encode(id, payload, preferredProtocol(module), GGWAVE_VOLUME)),
  );
};

export const decodeGgWave = async (samples: Float32Array, sampleRate: number): Promise<Uint8Array | null> => {
  const normalized = new Float32Array(samples.length);
  let peak = DECODE_NORMALIZE_FLOOR;

  for (const sample of samples) {
    peak = Math.max(peak, Math.abs(sample));
  }

  for (let index = 0; index < normalized.length; index += 1) {
    normalized[index] = Math.max(-1, Math.min(1, samples[index] / peak));
  }

  return withFreshInstance(sampleRate, ({ module, id }) =>
    bytesFromDecoded(module.decode(id, new Uint8Array(normalized.buffer))),
  );
};
