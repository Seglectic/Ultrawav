import FFTConstructor from "fft.js";

type SpectrogramRequest = {
  type: "compute";
  jobId: number;
  sampleRate: number;
  samples: Float32Array;
  windowSize: number;
  hopSize: number;
  binCount: number;
  minFrequency: number;
  maxFrequency: number;
};

type CancelRequest = {
  type: "cancel";
  jobId: number;
};

type WorkerRequest = SpectrogramRequest | CancelRequest;

const cancelledJobs = new Set<number>();
const workerScope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  if (message.type === "cancel") {
    cancelledJobs.add(message.jobId);
    return;
  }

  if (cancelledJobs.has(message.jobId)) {
    cancelledJobs.delete(message.jobId);
    return;
  }

  try {
    const result = computeSpectrogram(message);
    if (cancelledJobs.has(message.jobId)) {
      cancelledJobs.delete(message.jobId);
      return;
    }

    workerScope.postMessage(
      {
        type: "complete",
        jobId: message.jobId,
        duration: message.samples.length / message.sampleRate,
        sampleRate: message.sampleRate,
        timeSteps: result.timeSteps,
        binCount: message.binCount,
        magnitudes: result.magnitudes,
      },
      [result.magnitudes.buffer],
    );
  } catch (error) {
    workerScope.postMessage({
      type: "error",
      jobId: message.jobId,
      message: error instanceof Error ? error.message : "Spectrogram worker failed.",
    });
  } finally {
    cancelledJobs.delete(message.jobId);
  }
};

function computeSpectrogram(request: SpectrogramRequest): { timeSteps: number; magnitudes: Float32Array } {
  const fft = new FFTConstructor(request.windowSize);
  const frame = new Float32Array(request.windowSize);
  const spectrum = fft.createComplexArray() as number[];
  const timeSteps = Math.max(1, Math.ceil(Math.max(1, request.samples.length - request.windowSize) / request.hopSize));
  const magnitudes = new Float32Array(timeSteps * request.binCount);
  const frequencyToFftBin = request.windowSize / request.sampleRate;
  const logMin = Math.log(Math.max(1, request.minFrequency));
  const logMax = Math.log(Math.min(request.maxFrequency, request.sampleRate / 2));
  let globalPeak = 0.000_001;

  for (let timeIndex = 0; timeIndex < timeSteps; timeIndex += 1) {
    if (cancelledJobs.has(request.jobId)) {
      break;
    }

    const sampleOffset = timeIndex * request.hopSize;
    for (let windowIndex = 0; windowIndex < request.windowSize; windowIndex += 1) {
      const sample = request.samples[sampleOffset + windowIndex] ?? 0;
      const windowValue = 0.5 - 0.5 * Math.cos((Math.PI * 2 * windowIndex) / Math.max(1, request.windowSize - 1));
      frame[windowIndex] = sample * windowValue;
    }

    fft.realTransform(spectrum, frame);

    for (let binIndex = 0; binIndex < request.binCount; binIndex += 1) {
      const ratio = binIndex / Math.max(1, request.binCount - 1);
      const frequency = Math.exp(logMin + (logMax - logMin) * ratio);
      const fftBin = Math.min(Math.floor(request.windowSize / 2) - 1, Math.max(1, Math.round(frequency * frequencyToFftBin)));
      const real = spectrum[fftBin * 2] ?? 0;
      const imaginary = spectrum[fftBin * 2 + 1] ?? 0;
      const magnitude = Math.sqrt(real * real + imaginary * imaginary) / request.windowSize;
      const outputIndex = timeIndex * request.binCount + binIndex;
      magnitudes[outputIndex] = magnitude;
      globalPeak = Math.max(globalPeak, magnitude);
    }
  }

  for (let index = 0; index < magnitudes.length; index += 1) {
    magnitudes[index] = Math.min(1, Math.log1p((magnitudes[index] / globalPeak) * 28) / Math.log1p(28));
  }

  return { timeSteps, magnitudes };
}
