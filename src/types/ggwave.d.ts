declare module "@vpalmisano/ggwave" {
  export type GgWaveProtocol = object;

  export type GgWaveParameters = {
    payloadLength: number;
    sampleRateInp: number;
    sampleRateOut: number;
    sampleRate: number;
    samplesPerFrame: number;
    soundMarkerThreshold: number;
    sampleFormatInp: object;
    sampleFormatOut: object;
    operatingMode: number;
  };

  export type GgWaveModule = {
    GGWAVE_OPERATING_MODE_USE_DSS: number;
    ProtocolId: {
      GGWAVE_PROTOCOL_ULTRASOUND_FAST: GgWaveProtocol;
      GGWAVE_PROTOCOL_ULTRASOUND_NORMAL: GgWaveProtocol;
      GGWAVE_PROTOCOL_AUDIBLE_FAST: GgWaveProtocol;
    };
    getDefaultParameters(): GgWaveParameters;
    init(parameters: GgWaveParameters): number;
    free(instance: number): void;
    encode(
      instance: number,
      payload: string | Uint8Array,
      protocol: GgWaveProtocol,
      volume: number,
    ): Int8Array | Uint8Array | string;
    decode(instance: number, waveform: Int8Array | Uint8Array): Int8Array | Uint8Array | string | null;
  };

  export default function createGgWave(options?: {
    print?: (message: string) => void;
    printErr?: (message: string) => void;
  }): Promise<GgWaveModule>;
}
