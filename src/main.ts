import "./style.css";

import {
  MAX_FILE_PAYLOAD_BYTES,
  decodeAudioFile,
  detectEmbeddedPayload,
  downloadArtifact,
  embedPayload,
  exportAudio,
  makeTextPayload,
  readFilePayload,
  type DetectedPayload,
  type EmbedResult,
  type ExportArtifact,
  type HighlightRegion,
  type PayloadInput,
} from "./audio";
import { createSpectrumVisualizer } from "./visualizer";
import { createAudioNodeField } from "./webgl";

type PayloadMode = "text" | "file";

type PlaybackState = {
  context: AudioContext;
  analyser: AnalyserNode;
  source: AudioBufferSourceNode | null;
  startedAt: number;
  offset: number;
  playing: boolean;
};

type AppState = {
  carrierFile: File | null;
  carrierBuffer: AudioBuffer | null;
  augmented: EmbedResult | null;
  detected: DetectedPayload | null;
  payloadMode: PayloadMode;
  filePayload: PayloadInput | null;
  artifacts: ExportArtifact[];
  playback: PlaybackState | null;
};

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Missing #app root.");
}

appElement.innerHTML = `
  <canvas class="node-field" data-node-field aria-hidden="true"></canvas>
  <main class="app-shell">
    <section class="workbench" aria-label="GGWave audio embedder">
      <header class="masthead">
        <div>
          <p class="eyebrow">Stepgrid</p>
          <h1>Ultrasonic payload encoder</h1>
        </div>
        <div class="meter" data-status>Drop an audio file</div>
      </header>

      <div class="drop-grid">
        <button class="dropzone primary" data-carrier-drop type="button">
          <span>Carrier audio</span>
          <strong data-carrier-name>Drop MP3, WAV, M4A, OGG</strong>
        </button>
        <button class="dropzone" data-payload-drop type="button">
          <span>Small payload</span>
          <strong data-payload-name>Drop file, max 4 KB</strong>
        </button>
      </div>

      <div class="mode-row" role="tablist" aria-label="Payload mode">
        <button class="mode is-active" data-mode="text" type="button">Text</button>
        <button class="mode" data-mode="file" type="button">File</button>
      </div>

      <textarea data-text rows="4" maxlength="2048" spellcheck="false" placeholder="Payload text"></textarea>

      <div class="file-card" data-file-card hidden>
        <div>
          <span>Payload file</span>
          <strong data-file-meta>No file selected</strong>
        </div>
        <button data-clear-file type="button">Clear</button>
      </div>

      <div class="transport">
        <button data-play type="button" disabled>Play</button>
        <button data-stop type="button" disabled>Stop</button>
        <button data-embed type="button" disabled>Embed</button>
        <button data-export type="button" disabled>Export</button>
      </div>

      <div class="detected" data-detected hidden>
        <div>
          <span>Detected payload</span>
          <strong data-detected-meta></strong>
        </div>
        <button data-download-payload type="button" hidden>Download payload</button>
      </div>

      <div class="downloads" data-downloads></div>

      <canvas class="spectrum" data-spectrum aria-label="Fourier view"></canvas>
    </section>
  </main>
  <input data-audio-input type="file" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm" hidden />
  <input data-payload-input type="file" hidden />
`;

const state: AppState = {
  carrierFile: null,
  carrierBuffer: null,
  augmented: null,
  detected: null,
  payloadMode: "text",
  filePayload: null,
  artifacts: [],
  playback: null,
};

const nodeCanvas = query<HTMLCanvasElement>("[data-node-field]");
const spectrumCanvas = query<HTMLCanvasElement>("[data-spectrum]");
const audioInput = query<HTMLInputElement>("[data-audio-input]");
const payloadInput = query<HTMLInputElement>("[data-payload-input]");
const statusElement = query<HTMLElement>("[data-status]");
const carrierDrop = query<HTMLButtonElement>("[data-carrier-drop]");
const payloadDrop = query<HTMLButtonElement>("[data-payload-drop]");
const carrierName = query<HTMLElement>("[data-carrier-name]");
const payloadName = query<HTMLElement>("[data-payload-name]");
const textInput = query<HTMLTextAreaElement>("[data-text]");
const fileCard = query<HTMLElement>("[data-file-card]");
const fileMeta = query<HTMLElement>("[data-file-meta]");
const clearFileButton = query<HTMLButtonElement>("[data-clear-file]");
const playButton = query<HTMLButtonElement>("[data-play]");
const stopButton = query<HTMLButtonElement>("[data-stop]");
const embedButton = query<HTMLButtonElement>("[data-embed]");
const exportButton = query<HTMLButtonElement>("[data-export]");
const detectedPanel = query<HTMLElement>("[data-detected]");
const detectedMeta = query<HTMLElement>("[data-detected-meta]");
const downloadPayloadButton = query<HTMLButtonElement>("[data-download-payload]");
const downloads = query<HTMLElement>("[data-downloads]");
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-mode]")];

const visualizer = createSpectrumVisualizer(spectrumCanvas);
const nodeField = createAudioNodeField(nodeCanvas);
const frequencyData = new Uint8Array(256);
const timeData = new Uint8Array(256);

wireEvents();
render();
animate();

function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);

  if (!element) {
    throw new Error(`Missing element: ${selector}`);
  }

  return element;
}

function wireEvents() {
  audioInput.addEventListener("change", () => {
    const file = audioInput.files?.[0];
    audioInput.value = "";

    if (file) {
      void loadCarrier(file);
    }
  });

  payloadInput.addEventListener("change", () => {
    const file = payloadInput.files?.[0];
    payloadInput.value = "";

    if (file) {
      void loadPayload(file);
    }
  });

  carrierDrop.addEventListener("click", () => audioInput.click());
  payloadDrop.addEventListener("click", () => payloadInput.click());
  clearFileButton.addEventListener("click", clearPayloadFile);
  playButton.addEventListener("click", () => void togglePlay());
  stopButton.addEventListener("click", stopPlayback);
  embedButton.addEventListener("click", () => void embedCurrentPayload());
  exportButton.addEventListener("click", () => void exportCurrentAudio());
  downloadPayloadButton.addEventListener("click", downloadDetectedPayload);

  textInput.addEventListener("input", () => {
    if (state.payloadMode === "text") {
      state.artifacts = [];
      render();
    }
  });

  modeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;

      if (mode === "text" || mode === "file") {
        state.payloadMode = mode;
        render();
      }
    });
  });

  document.addEventListener("dragover", (event) => {
    event.preventDefault();
    document.body.classList.add("is-dragging");
  });

  document.addEventListener("dragleave", () => {
    document.body.classList.remove("is-dragging");
  });

  document.addEventListener("drop", (event) => {
    event.preventDefault();
    document.body.classList.remove("is-dragging");

    const file = event.dataTransfer?.files[0];

    if (!file) {
      return;
    }

    if (isAudioFile(file) || !state.carrierBuffer) {
      void loadCarrier(file);
    } else {
      void loadPayload(file);
    }
  });

  window.addEventListener("resize", () => {
    nodeField.resize();
    renderVisualizer();
  });
}

async function loadCarrier(file: File) {
  setStatus("Decoding carrier...");
  stopPlayback();

  try {
    const buffer = await decodeAudioFile(file);
    const detected = await detectEmbeddedPayload(buffer);

    state.carrierFile = file;
    state.carrierBuffer = buffer;
    state.augmented = null;
    state.detected = detected;
    state.artifacts = [];
    carrierName.textContent = `${file.name} · ${formatDuration(buffer.duration)}`;

    if (detected?.kind === "text" && detected.text) {
      state.payloadMode = "text";
      textInput.value = detected.text;
    }

    setStatus(detected ? "Embedded payload found" : "Carrier ready");
  } catch (error) {
    setStatus(errorMessage(error));
  }

  render();
}

async function loadPayload(file: File) {
  setStatus("Reading payload...");

  try {
    state.filePayload = await readFilePayload(file);
    state.payloadMode = "file";
    state.artifacts = [];
    setStatus("Payload ready");
  } catch (error) {
    setStatus(errorMessage(error));
  }

  render();
}

function clearPayloadFile() {
  state.filePayload = null;
  state.payloadMode = "text";
  state.artifacts = [];
  render();
}

async function embedCurrentPayload() {
  if (!state.carrierBuffer) {
    setStatus("Drop carrier first");
    return;
  }

  const payload = getPayloadInput();

  if (!payload) {
    return;
  }

  setStatus("Embedding GGWave...");
  stopPlayback();

  try {
    state.augmented = await embedPayload(state.carrierBuffer, payload);
    state.detected = state.augmented.embedded;
    state.artifacts = [];
    setStatus("Payload embedded");
  } catch (error) {
    setStatus(errorMessage(error));
  }

  render();
}

async function exportCurrentAudio() {
  const buffer = state.augmented?.buffer;

  if (!buffer) {
    setStatus("Embed first");
    return;
  }

  setStatus("Exporting...");

  try {
    state.artifacts = await exportAudio(buffer, baseName(), async (candidate) => {
      const detected = await detectEmbeddedPayload(candidate);
      return Boolean(detected);
    });
    setStatus(state.artifacts.some((artifact) => artifact.verified) ? "Export verified" : "WAV fallback ready");
  } catch (error) {
    setStatus(errorMessage(error));
  }

  render();
}

function getPayloadInput(): PayloadInput | null {
  if (state.payloadMode === "file") {
    if (!state.filePayload) {
      setStatus("Drop payload file");
      return null;
    }

    return state.filePayload;
  }

  const text = textInput.value.trim();

  if (!text) {
    setStatus("Enter text");
    return null;
  }

  return makeTextPayload(text);
}

async function togglePlay() {
  if (state.playback?.playing) {
    pausePlayback();
    return;
  }

  const buffer = state.augmented?.buffer ?? state.carrierBuffer;

  if (!buffer) {
    return;
  }

  const playback = getPlayback();
  const source = playback.context.createBufferSource();
  source.buffer = buffer;
  source.connect(playback.analyser);
  playback.analyser.connect(playback.context.destination);
  source.addEventListener("ended", () => {
    if (playback.source === source) {
      playback.playing = false;
      playback.offset = 0;
      playback.source = null;
      render();
    }
  });

  if (playback.context.state === "suspended") {
    await playback.context.resume();
  }

  playback.source = source;
  playback.startedAt = playback.context.currentTime - playback.offset;
  playback.playing = true;
  source.start(0, playback.offset);
  render();
}

function pausePlayback() {
  const playback = state.playback;

  if (!playback?.playing || !playback.source) {
    return;
  }

  playback.offset = playback.context.currentTime - playback.startedAt;
  playback.source.stop();
  playback.source.disconnect();
  playback.source = null;
  playback.playing = false;
  render();
}

function stopPlayback() {
  const playback = state.playback;

  if (!playback) {
    return;
  }

  if (playback.source) {
    playback.source.stop();
    playback.source.disconnect();
  }

  playback.source = null;
  playback.offset = 0;
  playback.playing = false;
  render();
}

function getPlayback(): PlaybackState {
  if (state.playback) {
    return state.playback;
  }

  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;

  state.playback = {
    context,
    analyser,
    source: null,
    startedAt: 0,
    offset: 0,
    playing: false,
  };

  return state.playback;
}

function render() {
  const hasCarrier = Boolean(state.carrierBuffer);
  const hasAugmented = Boolean(state.augmented);
  const hasPayload = state.payloadMode === "text" ? textInput.value.trim().length > 0 : Boolean(state.filePayload);

  modeButtons.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.payloadMode);
  });

  fileCard.hidden = state.payloadMode !== "file";
  payloadName.textContent = payloadLabel();
  fileMeta.textContent = payloadLabel();
  playButton.disabled = !hasCarrier;
  stopButton.disabled = !state.playback?.playing && !state.playback?.offset;
  embedButton.disabled = !hasCarrier || !hasPayload;
  exportButton.disabled = !hasAugmented;
  playButton.textContent = state.playback?.playing ? "Pause" : "Play";

  renderDetected();
  renderDownloads();
  renderVisualizer();
}

function renderDetected() {
  const detected = state.detected;
  detectedPanel.hidden = !detected;

  if (!detected) {
    return;
  }

  const detail = detected.kind === "file"
    ? `${detected.fileName ?? "payload"} · ${formatBytes(detected.size)} · ${detected.chunkCount} chunks`
    : `${formatBytes(detected.size)} text · ${detected.chunkCount} chunks`;

  detectedMeta.textContent = detail;
  downloadPayloadButton.hidden = detected.kind !== "file";
}

function renderDownloads() {
  downloads.replaceChildren();

  for (const artifact of state.artifacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = artifact.verified ? "download verified" : "download";
    button.textContent = `${artifact.kind.toUpperCase()} · ${artifact.verified ? "verified" : "fallback"}`;
    button.title = artifact.message;
    button.addEventListener("click", () => downloadArtifact(artifact));
    downloads.append(button);
  }
}

function renderVisualizer() {
  const playheadTime = getPlayheadTime();
  const augmentedRegions = state.augmented?.regions ?? [];
  const detectedRegions = state.detected?.regions ?? [];
  const regions = [...augmentedRegions, ...detectedRegions] as HighlightRegion[];

  visualizer.render({
    carrier: state.carrierBuffer,
    data: state.augmented?.dataBuffer ?? null,
    regions,
    playheadTime,
  });
}

function animate() {
  const playback = state.playback;

  if (playback?.playing) {
    playback.analyser.getByteFrequencyData(frequencyData);
    playback.analyser.getByteTimeDomainData(timeData);
  }

  nodeField.update({
    frequencyData: playback?.playing ? frequencyData : null,
    timeData: playback?.playing ? timeData : null,
    playing: Boolean(playback?.playing),
  });

  if (playback?.playing) {
    renderVisualizer();
  }

  requestAnimationFrame(animate);
}

function getPlayheadTime() {
  const playback = state.playback;

  if (!playback) {
    return null;
  }

  return playback.playing ? playback.context.currentTime - playback.startedAt : playback.offset;
}

function payloadLabel() {
  const payload = state.filePayload;

  if (!payload || payload.kind !== "file") {
    return `Drop file, max ${formatBytes(MAX_FILE_PAYLOAD_BYTES)}`;
  }

  return `${payload.fileName} · ${formatBytes(payload.size)}`;
}

function downloadDetectedPayload() {
  const detected = state.detected;

  if (!detected || detected.kind !== "file" || !detected.bytes) {
    return;
  }

  const blob = new Blob([detected.bytes], { type: detected.mimeType || "application/octet-stream" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = detected.fileName || "payload.bin";
  link.click();
  URL.revokeObjectURL(link.href);
}

function baseName() {
  const name = state.carrierFile?.name ?? "stepgrid";
  return name.replace(/\.[^.]+$/, "") || "stepgrid";
}

function isAudioFile(file: File) {
  return file.type.startsWith("audio/")
    || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(file.name);
}

function setStatus(message: string) {
  statusElement.textContent = message;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.max(0, Math.round(seconds - minutes * 60));
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Operation failed";
}
