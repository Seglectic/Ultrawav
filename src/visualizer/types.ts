export type FourierMode = "hybrid" | "waterfall" | "live";

export type FourierRegion = {
  start: number;
  end: number;
  kind: string;
};

export type FourierVisualizerProps = {
  carrier: AudioBuffer | null;
  data: AudioBuffer | null;
  regions: readonly FourierRegion[];
  playheadTime: number | null;
  playing: boolean;
  liveFrequencyData: Float32Array | Uint8Array | null;
  liveSampleRate: number | null;
  mode: FourierMode;
  onSeek: (time: number) => void;
};

export type SpectrogramLayer = {
  duration: number;
  sampleRate: number;
  timeSteps: number;
  binCount: number;
  magnitudes: Float32Array;
};
