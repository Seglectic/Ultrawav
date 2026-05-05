export const cloneAudioBuffer = (buffer: AudioBuffer, length = buffer.length): AudioBuffer => {
  const copy = new AudioBuffer({
    length,
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
  });
  const framesToCopy = Math.min(buffer.length, length);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    copy.copyToChannel(buffer.getChannelData(channel).slice(0, framesToCopy), channel);
  }

  return copy;
};

export const mixMonoSignal = (
  buffer: AudioBuffer,
  signal: Float32Array,
  startSample: number,
  gain: number,
): number => {
  const endSample = Math.min(buffer.length, startSample + signal.length);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const target = buffer.getChannelData(channel);
    for (let sample = startSample; sample < endSample; sample += 1) {
      target[sample] += signal[sample - startSample] * gain;
    }
  }

  return endSample;
};

export const normalizeAudioBuffer = (buffer: AudioBuffer): AudioBuffer => {
  let peak = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }

  if (peak <= 1) {
    return buffer;
  }

  const gain = 1 / peak;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let sample = 0; sample < samples.length; sample += 1) {
      samples[sample] *= gain;
    }
  }

  return buffer;
};

export const scaleAudioBufferToPeak = (buffer: AudioBuffer, targetPeak: number): AudioBuffer => {
  let peak = 0;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (const sample of samples) {
      peak = Math.max(peak, Math.abs(sample));
    }
  }

  if (peak <= 0 || targetPeak <= 0) {
    return buffer;
  }

  const gain = targetPeak / peak;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const samples = buffer.getChannelData(channel);
    for (let sample = 0; sample < samples.length; sample += 1) {
      samples[sample] *= gain;
    }
  }

  return buffer;
};

export const downmixWindow = (buffer: AudioBuffer, startSample: number, sampleCount: number): Float32Array => {
  const safeStart = Math.max(0, Math.min(buffer.length, startSample));
  const safeEnd = Math.max(safeStart, Math.min(buffer.length, safeStart + sampleCount));
  const mono = new Float32Array(safeEnd - safeStart);

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const source = buffer.getChannelData(channel);
    for (let sample = 0; sample < mono.length; sample += 1) {
      mono[sample] += source[safeStart + sample] / buffer.numberOfChannels;
    }
  }

  return mono;
};

export const lowPassAudioBuffer = async (buffer: AudioBuffer, cutoffHz: number): Promise<AudioBuffer> => {
  const nyquist = buffer.sampleRate / 2;

  if (cutoffHz >= nyquist - 200) {
    return cloneAudioBuffer(buffer);
  }

  const context = new OfflineAudioContext(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  const source = context.createBufferSource();
  const filter = context.createBiquadFilter();

  source.buffer = buffer;
  filter.type = "lowpass";
  filter.frequency.value = Math.max(100, Math.min(cutoffHz, nyquist - 200));
  filter.Q.value = 0.707;
  source.connect(filter);
  filter.connect(context.destination);
  source.start();

  return context.startRendering();
};
