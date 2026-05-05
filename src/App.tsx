import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  MAX_FILE_PAYLOAD_BYTES,
  decodeAudioFile,
  detectEmbeddedPayload,
  downloadArtifact,
  embedPayload,
  exportAudio,
  extractEmbeddedDataBuffer,
  makeTextPayload,
  readFilePayload,
  type DetectedPayload,
  type EmbedResult,
  type ExportArtifact,
  type HighlightRegion,
  type PayloadInput,
} from "./audio";
import { FourierVisualizer, type FourierMode } from "./visualizer";
import { createAudioNodeField, type AudioNodeField } from "./webgl";

type PayloadMode = "text" | "file";

type PlaybackState = {
  context: AudioContext;
  analyser: AnalyserNode;
  source: AudioBufferSourceNode | null;
  startedAt: number;
  offset: number;
  playing: boolean;
};

type PlaybackSnapshot = {
  playing: boolean;
  offset: number;
};

const INITIAL_PLAYBACK: PlaybackSnapshot = {
  playing: false,
  offset: 0,
};

export function App() {
  const [carrierFile, setCarrierFile] = useState<File | null>(null);
  const [carrierBuffer, setCarrierBuffer] = useState<AudioBuffer | null>(null);
  const [augmented, setAugmented] = useState<EmbedResult | null>(null);
  const [detected, setDetected] = useState<DetectedPayload | null>(null);
  const [detectedDataBuffer, setDetectedDataBuffer] = useState<AudioBuffer | null>(null);
  const [payloadMode, setPayloadMode] = useState<PayloadMode>("text");
  const [filePayload, setFilePayload] = useState<PayloadInput | null>(null);
  const [artifacts, setArtifacts] = useState<ExportArtifact[]>([]);
  const [status, setStatus] = useState("Drop an audio file");
  const [textPayload, setTextPayload] = useState("");
  const [playbackSnapshot, setPlaybackSnapshot] = useState<PlaybackSnapshot>(INITIAL_PLAYBACK);
  const [playheadTime, setPlayheadTime] = useState(0);
  const [visualizerMode, setVisualizerMode] = useState<FourierMode>("hybrid");

  const nodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const payloadInputRef = useRef<HTMLInputElement | null>(null);
  const nodeFieldRef = useRef<AudioNodeField | null>(null);
  const playbackRef = useRef<PlaybackState | null>(null);
  const carrierBufferRef = useRef<AudioBuffer | null>(null);
  const carrierFileRef = useRef<File | null>(null);
  const augmentedRef = useRef<EmbedResult | null>(null);
  const detectedRef = useRef<DetectedPayload | null>(null);
  const detectedDataBufferRef = useRef<AudioBuffer | null>(null);
  const textPayloadRef = useRef("");
  const payloadModeRef = useRef<PayloadMode>("text");
  const filePayloadRef = useRef<PayloadInput | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const frequencyDataRef = useRef(new Uint8Array(256));
  const timeDataRef = useRef(new Uint8Array(256));

  useEffect(() => {
    carrierBufferRef.current = carrierBuffer;
  }, [carrierBuffer]);

  useEffect(() => {
    carrierFileRef.current = carrierFile;
  }, [carrierFile]);

  useEffect(() => {
    augmentedRef.current = augmented;
  }, [augmented]);

  useEffect(() => {
    detectedRef.current = detected;
  }, [detected]);

  useEffect(() => {
    detectedDataBufferRef.current = detectedDataBuffer;
  }, [detectedDataBuffer]);

  useEffect(() => {
    textPayloadRef.current = textPayload;
  }, [textPayload]);

  useEffect(() => {
    payloadModeRef.current = payloadMode;
  }, [payloadMode]);

  useEffect(() => {
    filePayloadRef.current = filePayload;
  }, [filePayload]);

  const syncPlaybackSnapshot = useCallback(() => {
    const playback = playbackRef.current;
    setPlaybackSnapshot({
      playing: Boolean(playback?.playing),
      offset: playback?.offset ?? 0,
    });
  }, []);

  const getPlayableBuffer = useCallback(() => augmentedRef.current?.buffer ?? carrierBufferRef.current, []);

  const getPlayheadTime = useCallback(() => {
    const playback = playbackRef.current;

    if (!playback) {
      return 0;
    }

    return playback.playing ? playback.context.currentTime - playback.startedAt : playback.offset;
  }, []);

  const updatePlayhead = useCallback(() => {
    setPlayheadTime(getPlayheadTime());
  }, [getPlayheadTime]);

  const stopSource = useCallback((playback: PlaybackState) => {
    const source = playback.source;
    playback.source = null;

    if (!source) {
      return;
    }

    try {
      source.stop();
    } catch {
      // Already stopped.
    }

    source.disconnect();
  }, []);

  const getPlayback = useCallback(() => {
    if (playbackRef.current) {
      return playbackRef.current;
    }

    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.78;
    frequencyDataRef.current = new Uint8Array(analyser.frequencyBinCount);
    timeDataRef.current = new Uint8Array(analyser.frequencyBinCount);

    playbackRef.current = {
      context,
      analyser,
      source: null,
      startedAt: 0,
      offset: 0,
      playing: false,
    };

    return playbackRef.current;
  }, []);

  const stopPlayback = useCallback(() => {
    const playback = playbackRef.current;

    if (!playback) {
      return;
    }

    stopSource(playback);
    playback.offset = 0;
    playback.playing = false;
    syncPlaybackSnapshot();
    updatePlayhead();
  }, [stopSource, syncPlaybackSnapshot, updatePlayhead]);

  const startPlayback = useCallback(async () => {
    const buffer = getPlayableBuffer();

    if (!buffer) {
      return;
    }

    const playback = getPlayback();
    const source = playback.context.createBufferSource();
    const offset = Math.min(playback.offset, Math.max(0, buffer.duration - 0.001));

    source.buffer = buffer;
    source.connect(playback.analyser);
    playback.analyser.connect(playback.context.destination);
    source.addEventListener("ended", () => {
      if (playback.source === source) {
        playback.playing = false;
        playback.offset = 0;
        playback.source = null;
        syncPlaybackSnapshot();
        updatePlayhead();
      }
    });

    if (playback.context.state === "suspended") {
      await playback.context.resume();
    }

    playback.source = source;
    playback.offset = offset;
    playback.startedAt = playback.context.currentTime - offset;
    playback.playing = true;
    source.start(0, offset);
    syncPlaybackSnapshot();
    updatePlayhead();
  }, [getPlayableBuffer, getPlayback, syncPlaybackSnapshot, updatePlayhead]);

  const pausePlayback = useCallback(() => {
    const playback = playbackRef.current;

    if (!playback?.playing || !playback.source) {
      return;
    }

    playback.offset = playback.context.currentTime - playback.startedAt;
    stopSource(playback);
    playback.playing = false;
    syncPlaybackSnapshot();
    updatePlayhead();
  }, [stopSource, syncPlaybackSnapshot, updatePlayhead]);

  const togglePlay = useCallback(async () => {
    if (playbackRef.current?.playing) {
      pausePlayback();
      return;
    }

    await startPlayback();
  }, [pausePlayback, startPlayback]);

  const seekPlayback = useCallback(async (time: number) => {
    const buffer = getPlayableBuffer();

    if (!buffer) {
      return;
    }

    const playback = getPlayback();
    const wasPlaying = playback.playing;

    stopSource(playback);
    playback.offset = Math.max(0, Math.min(time, buffer.duration));
    playback.playing = false;

    if (wasPlaying) {
      await startPlayback();
    } else {
      syncPlaybackSnapshot();
      updatePlayhead();
    }
  }, [getPlayableBuffer, getPlayback, startPlayback, stopSource, syncPlaybackSnapshot, updatePlayhead]);

  const loadCarrier = useCallback(async (file: File) => {
    setStatus("Decoding carrier...");
    stopPlayback();

    try {
      const buffer = await decodeAudioFile(file);
      const embeddedPayload = await detectEmbeddedPayload(buffer);
      const embeddedDataBuffer = embeddedPayload
        ? await extractEmbeddedDataBuffer(buffer, embeddedPayload.regions)
        : null;

      setCarrierFile(file);
      setCarrierBuffer(buffer);
      setAugmented(null);
      setDetected(embeddedPayload);
      setDetectedDataBuffer(embeddedDataBuffer);
      setArtifacts([]);

      if (embeddedPayload?.kind === "text" && embeddedPayload.text) {
        setPayloadMode("text");
        setTextPayload(embeddedPayload.text);
      }

      setStatus(embeddedPayload ? "Embedded payload found" : "Carrier ready");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [stopPlayback]);

  const loadPayload = useCallback(async (file: File) => {
    setStatus("Reading payload...");

    try {
      const payload = await readFilePayload(file);
      setFilePayload(payload);
      setPayloadMode("file");
      setArtifacts([]);
      setStatus("Payload ready");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, []);

  const clearPayloadFile = useCallback(() => {
    setFilePayload(null);
    setPayloadMode("text");
    setArtifacts([]);
  }, []);

  const getPayloadInput = useCallback((): PayloadInput | null => {
    if (payloadModeRef.current === "file") {
      if (!filePayloadRef.current) {
        setStatus("Drop payload file");
        return null;
      }

      return filePayloadRef.current;
    }

    const text = textPayloadRef.current.trim();

    if (!text) {
      setStatus("Enter text");
      return null;
    }

    return makeTextPayload(text);
  }, []);

  const embedCurrentPayload = useCallback(async () => {
    const carrier = carrierBufferRef.current;

    if (!carrier) {
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
      const result = await embedPayload(carrier, payload);
      setAugmented(result);
      setDetected(result.embedded);
      setDetectedDataBuffer(null);
      setArtifacts([]);
      setStatus("Payload embedded");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, [getPayloadInput, stopPlayback]);

  const exportCurrentAudio = useCallback(async () => {
    const currentAugmented = augmentedRef.current;
    const buffer = currentAugmented?.buffer;

    if (!buffer) {
      setStatus("Embed first");
      return;
    }

    setStatus("Exporting...");

    try {
      const exportedArtifacts = await exportAudio(buffer, baseName(carrierFileRef.current), async (candidate) => {
        const foundPayload = await detectEmbeddedPayload(candidate, currentAugmented?.regions);
        return Boolean(foundPayload);
      });
      setArtifacts(exportedArtifacts);
      setStatus(exportedArtifacts.some((artifact) => artifact.verified) ? "Export verified" : "WAV fallback ready");
    } catch (error) {
      setStatus(errorMessage(error));
    }
  }, []);

  const downloadDetectedPayload = useCallback(() => {
    const currentDetected = detectedRef.current;

    if (!currentDetected || currentDetected.kind !== "file" || !currentDetected.bytes) {
      return;
    }

    const blob = new Blob([currentDetected.bytes], {
      type: currentDetected.mimeType || "application/octet-stream",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = currentDetected.fileName || "payload.bin";
    link.click();
    URL.revokeObjectURL(link.href);
  }, []);

  const onVisualizerKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }

    const buffer = getPlayableBuffer();

    if (!buffer) {
      return;
    }

    event.preventDefault();
    const deltaSeconds = event.key === "ArrowLeft" ? -5 : 5;
    void seekPlayback(Math.max(0, Math.min(buffer.duration, getPlayheadTime() + deltaSeconds)));
  }, [getPlayableBuffer, getPlayheadTime, seekPlayback]);

  const onDocumentDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    document.body.classList.add("is-dragging");
  }, []);

  const onDocumentDragLeave = useCallback(() => {
    document.body.classList.remove("is-dragging");
  }, []);

  const onDocumentDrop = useCallback((event: DragEvent) => {
    event.preventDefault();
    document.body.classList.remove("is-dragging");

    const file = event.dataTransfer?.files[0];

    if (!file) {
      return;
    }

    if (isAudioFile(file) || !carrierBufferRef.current) {
      void loadCarrier(file);
    } else {
      void loadPayload(file);
    }
  }, [loadCarrier, loadPayload]);

  useEffect(() => {
    const nodeCanvas = nodeCanvasRef.current;

    if (!nodeCanvas) {
      return;
    }

    const nodeField = createAudioNodeField(nodeCanvas);
    nodeFieldRef.current = nodeField;

    return () => {
      nodeField.dispose();
      nodeFieldRef.current = null;
    };
  }, []);

  useEffect(() => {
    updatePlayhead();
  }, [carrierBuffer, augmented, detected, detectedDataBuffer, updatePlayhead]);

  useEffect(() => {
    const onResize = () => {
      nodeFieldRef.current?.resize();
    };

    window.addEventListener("resize", onResize);
    document.addEventListener("dragover", onDocumentDragOver);
    document.addEventListener("dragleave", onDocumentDragLeave);
    document.addEventListener("drop", onDocumentDrop);

    return () => {
      window.removeEventListener("resize", onResize);
      document.removeEventListener("dragover", onDocumentDragOver);
      document.removeEventListener("dragleave", onDocumentDragLeave);
      document.removeEventListener("drop", onDocumentDrop);
    };
  }, [onDocumentDragLeave, onDocumentDragOver, onDocumentDrop]);

  useEffect(() => {
    const animate = () => {
      const playback = playbackRef.current;

      if (playback?.playing) {
        playback.analyser.getByteFrequencyData(frequencyDataRef.current);
        playback.analyser.getByteTimeDomainData(timeDataRef.current);
      }

      nodeFieldRef.current?.update({
        frequencyData: playback?.playing ? frequencyDataRef.current : null,
        timeData: playback?.playing ? timeDataRef.current : null,
        playing: Boolean(playback?.playing),
      });

      if (playback?.playing) {
        updatePlayhead();
      }

      animationFrameRef.current = requestAnimationFrame(animate);
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [updatePlayhead]);

  useEffect(() => () => {
    const playback = playbackRef.current;

    if (!playback) {
      return;
    }

    stopSource(playback);
    void playback.context.close();
  }, [stopSource]);

  const payloadLabelText = useMemo(() => payloadLabel(filePayload), [filePayload]);
  const detectedDetail = useMemo(() => detectedMetadata(detected), [detected]);
  const visualizerRegions = useMemo(
    () => [...(augmented?.regions ?? []), ...(detected?.regions ?? [])] as HighlightRegion[],
    [augmented, detected],
  );
  const hasCarrier = Boolean(carrierBuffer);
  const hasAugmented = Boolean(augmented);
  const hasPayload = payloadMode === "text" ? textPayload.trim().length > 0 : Boolean(filePayload);
  const visualizerData = augmented?.dataBuffer ?? detectedDataBuffer;

  return (
    <>
      <canvas className="node-field" ref={nodeCanvasRef} data-node-field aria-hidden="true" />
      <main className="app-shell">
        <section className="workbench" aria-label="GGWave audio embedder">
          <header className="masthead">
            <div>
              <p className="eyebrow">Stepgrid</p>
              <h1>Ultrasonic payload encoder</h1>
            </div>
            <div className="meter" data-status>{status}</div>
          </header>

          <div className="drop-grid">
            <button className="dropzone primary" type="button" onClick={() => audioInputRef.current?.click()}>
              <span>Carrier audio</span>
              <strong>{carrierFile && carrierBuffer ? `${carrierFile.name} · ${formatDuration(carrierBuffer.duration)}` : "Drop MP3, WAV, M4A, OGG"}</strong>
            </button>
            <button className="dropzone" type="button" onClick={() => payloadInputRef.current?.click()}>
              <span>Small payload</span>
              <strong>{payloadLabelText}</strong>
            </button>
          </div>

          <div className="mode-row" role="tablist" aria-label="Payload mode">
            <button className={`mode${payloadMode === "text" ? " is-active" : ""}`} type="button" onClick={() => setPayloadMode("text")}>Text</button>
            <button className={`mode${payloadMode === "file" ? " is-active" : ""}`} type="button" onClick={() => setPayloadMode("file")}>File</button>
          </div>

          <textarea
            rows={4}
            maxLength={2048}
            spellCheck={false}
            placeholder="Payload text"
            value={textPayload}
            onChange={(event) => {
              setTextPayload(event.target.value);
              if (payloadModeRef.current === "text") {
                setArtifacts([]);
              }
            }}
          />

          <div className="file-card" hidden={payloadMode !== "file"}>
            <div>
              <span>Payload file</span>
              <strong>{payloadLabelText}</strong>
            </div>
            <button type="button" onClick={clearPayloadFile}>Clear</button>
          </div>

          <div className="transport">
            <button type="button" disabled={!hasCarrier} onClick={() => void togglePlay()}>{playbackSnapshot.playing ? "Pause" : "Play"}</button>
            <button type="button" disabled={!playbackSnapshot.playing && !playbackSnapshot.offset} onClick={stopPlayback}>Stop</button>
            <button type="button" disabled={!hasCarrier || !hasPayload} onClick={() => void embedCurrentPayload()}>Embed</button>
            <button type="button" disabled={!hasAugmented} onClick={() => void exportCurrentAudio()}>Export</button>
          </div>

          <div className="detected" hidden={!detected}>
            <div>
              <span>Detected payload</span>
              <strong>{detectedDetail}</strong>
            </div>
            <button type="button" hidden={detected?.kind !== "file"} onClick={downloadDetectedPayload}>Download payload</button>
          </div>

          <div className="downloads">
            {artifacts.map((artifact: ExportArtifact) => (
              <button
                className={artifact.verified ? "download verified" : "download"}
                key={`${artifact.fileName}-${artifact.kind}-${artifact.verified ? "verified" : "fallback"}`}
                title={artifact.message}
                type="button"
                onClick={() => downloadArtifact(artifact)}
              >
                {artifact.kind.toUpperCase()} · {artifact.verified ? "verified" : "fallback"}
              </button>
            ))}
          </div>

          <div className="visualizer-head">
            <span>Fourier view</span>
            <div className="mode-row visualizer-modes" role="tablist" aria-label="Fourier view mode">
              {(["hybrid", "waterfall", "live"] as const).map((mode) => (
                <button
                  className={`mode${visualizerMode === mode ? " is-active" : ""}`}
                  key={mode}
                  type="button"
                  onClick={() => setVisualizerMode(mode)}
                >
                  {mode[0].toUpperCase() + mode.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div
            className="spectrum"
            aria-label="Fourier view"
            tabIndex={0}
            onKeyDown={onVisualizerKeyDown}
          >
            <FourierVisualizer
              carrier={carrierBuffer}
              data={visualizerData}
              regions={visualizerRegions}
              playheadTime={playheadTime}
              playing={playbackSnapshot.playing}
              liveFrequencyData={playbackSnapshot.playing ? frequencyDataRef.current : null}
              liveSampleRate={playbackRef.current?.context.sampleRate ?? carrierBuffer?.sampleRate ?? null}
              mode={visualizerMode}
              onSeek={(time) => {
                void seekPlayback(time);
              }}
            />
          </div>
        </section>
      </main>
      <input
        ref={audioInputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac,.webm"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";

          if (file) {
            void loadCarrier(file);
          }
        }}
      />
      <input
        ref={payloadInputRef}
        type="file"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";

          if (file) {
            void loadPayload(file);
          }
        }}
      />
    </>
  );
}

function payloadLabel(payload: PayloadInput | null) {
  if (!payload || payload.kind !== "file") {
    return `Drop file, max ${formatBytes(MAX_FILE_PAYLOAD_BYTES)}`;
  }

  return `${payload.fileName} · ${formatBytes(payload.size)}`;
}

function detectedMetadata(detected: DetectedPayload | null) {
  if (!detected) {
    return "";
  }

  return detected.kind === "file"
    ? `${detected.fileName ?? "payload"} · ${formatBytes(detected.size)} · ${detected.chunkCount} chunks`
    : `${formatBytes(detected.size)} text · ${detected.chunkCount} chunks`;
}

function baseName(file: File | null) {
  const name = file?.name ?? "stepgrid";
  return name.replace(/\.[^.]+$/, "") || "stepgrid";
}

function isAudioFile(file: File) {
  return file.type.startsWith("audio/")
    || /\.(mp3|wav|m4a|aac|ogg|flac|webm)$/i.test(file.name);
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
