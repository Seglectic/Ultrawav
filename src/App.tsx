import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import { FourierVisualizer } from "./visualizer";
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
const TEXT_APPLY_DEBOUNCE_MS = 650;

export function App() {
  const [carrierFile, setCarrierFile] = useState<File | null>(null);
  const [carrierBuffer, setCarrierBuffer] = useState<AudioBuffer | null>(null);
  const [augmented, setAugmented] = useState<EmbedResult | null>(null);
  const [detected, setDetected] = useState<DetectedPayload | null>(null);
  const [detectedDataBuffer, setDetectedDataBuffer] = useState<AudioBuffer | null>(null);
  const [payloadMode, setPayloadMode] = useState<PayloadMode>("text");
  const [filePayload, setFilePayload] = useState<PayloadInput | null>(null);
  const [augmentedKey, setAugmentedKey] = useState("");
  const [payloadDirty, setPayloadDirty] = useState(false);
  const [carrierNotice, setCarrierNotice] = useState("");
  const [payloadNotice, setPayloadNotice] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  const [isPreparing, setIsPreparing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [textPayload, setTextPayload] = useState("");
  const [playbackSnapshot, setPlaybackSnapshot] = useState<PlaybackSnapshot>(INITIAL_PLAYBACK);
  const [playheadTime, setPlayheadTime] = useState(0);

  const nodeCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const payloadInputRef = useRef<HTMLInputElement | null>(null);
  const nodeFieldRef = useRef<AudioNodeField | null>(null);
  const playbackRef = useRef<PlaybackState | null>(null);
  const carrierBufferRef = useRef<AudioBuffer | null>(null);
  const carrierFileRef = useRef<File | null>(null);
  const augmentedRef = useRef<EmbedResult | null>(null);
  const augmentedKeyRef = useRef("");
  const detectedRef = useRef<DetectedPayload | null>(null);
  const detectedDataBufferRef = useRef<AudioBuffer | null>(null);
  const textPayloadRef = useRef("");
  const payloadModeRef = useRef<PayloadMode>("text");
  const filePayloadRef = useRef<PayloadInput | null>(null);
  const payloadDirtyRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const embedJobRef = useRef(0);
  const playheadUpdateRef = useRef(0);
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
    augmentedKeyRef.current = augmentedKey;
  }, [augmentedKey]);

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

  useEffect(() => {
    payloadDirtyRef.current = payloadDirty;
  }, [payloadDirty]);

  const syncPlaybackSnapshot = useCallback(() => {
    const playback = playbackRef.current;
    setPlaybackSnapshot({
      playing: Boolean(playback?.playing),
      offset: playback?.offset ?? 0,
    });
  }, []);

  const getActiveAugmented = useCallback(() => {
    const currentAugmented = augmentedRef.current;
    return currentAugmented?.payload.kind === payloadModeRef.current ? currentAugmented : null;
  }, []);

  const getActiveDetected = useCallback(() => {
    const currentDetected = detectedRef.current;
    return currentDetected?.kind === payloadModeRef.current ? currentDetected : null;
  }, []);

  const getPlayableBuffer = useCallback(() => getActiveAugmented()?.buffer ?? carrierBufferRef.current, [getActiveAugmented]);

  const getPlayheadTime = useCallback(() => {
    const playback = playbackRef.current;

    if (!playback) {
      return 0;
    }

    return playback.playing ? playback.context.currentTime - playback.startedAt : playback.offset;
  }, []);

  const updatePlayhead = useCallback((force = false) => {
    const now = performance.now();
    if (!force && now - playheadUpdateRef.current < 100) {
      return;
    }
    playheadUpdateRef.current = now;
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
    updatePlayhead(true);
  }, [stopSource, syncPlaybackSnapshot, updatePlayhead]);

  const getPayloadInput = useCallback((options: { require?: boolean } = {}): PayloadInput | null => {
    if (payloadModeRef.current === "file") {
      if (!filePayloadRef.current) {
        if (options.require) {
          setPayloadNotice("Drop file here or click to select");
        }
        return null;
      }

      return filePayloadRef.current;
    }

    const text = textPayloadRef.current.trim();

    if (!text) {
      if (options.require) {
        setPayloadNotice("Enter text to encode");
      }
      return null;
    }

    return makeTextPayload(text);
  }, []);

  const applyPayload = useCallback(async (payload: PayloadInput): Promise<EmbedResult | null> => {
    const carrier = carrierBufferRef.current;

    if (!carrier) {
      setCarrierNotice("Drop audio here or click to select");
      return null;
    }

    const key = makeEmbedKey(carrierFileRef.current, carrier, payload);
    const currentAugmented = augmentedRef.current;

    if (currentAugmented && augmentedKeyRef.current === key) {
      return currentAugmented;
    }

    const jobId = embedJobRef.current + 1;
    embedJobRef.current = jobId;
    setIsPreparing(true);
    setActionNotice("Applying payload...");
    stopPlayback();

    try {
      const result = await embedPayload(carrier, payload);

      if (embedJobRef.current !== jobId) {
        return null;
      }

      setAugmented(result);
      setAugmentedKey(key);
      setDetected(result.embedded);
      setDetectedDataBuffer(null);
      setPayloadDirty(false);
      setPayloadNotice("");
      setActionNotice("Payload applied");
      return result;
    } catch (error) {
      if (embedJobRef.current === jobId) {
        setActionNotice(errorMessage(error));
      }
      return null;
    } finally {
      if (embedJobRef.current === jobId) {
        setIsPreparing(false);
      }
    }
  }, [stopPlayback]);

  const resolvePlaybackBuffer = useCallback(async () => {
    const carrier = carrierBufferRef.current;

    if (!carrier) {
      return null;
    }

    if (payloadDirtyRef.current) {
      const payload = getPayloadInput();
      if (payload) {
        const result = await applyPayload(payload);
        return result?.buffer ?? null;
      }
    }

    return getActiveAugmented()?.buffer ?? carrier;
  }, [applyPayload, getActiveAugmented, getPayloadInput]);

  const startPlayback = useCallback(async () => {
    const buffer = await resolvePlaybackBuffer();

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
        updatePlayhead(true);
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
    updatePlayhead(true);
  }, [getPlayback, resolvePlaybackBuffer, syncPlaybackSnapshot, updatePlayhead]);

  const pausePlayback = useCallback(() => {
    const playback = playbackRef.current;

    if (!playback?.playing || !playback.source) {
      return;
    }

    playback.offset = playback.context.currentTime - playback.startedAt;
    stopSource(playback);
    playback.playing = false;
    syncPlaybackSnapshot();
    updatePlayhead(true);
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
      updatePlayhead(true);
    }
  }, [getPlayableBuffer, getPlayback, startPlayback, stopSource, syncPlaybackSnapshot, updatePlayhead]);

  const loadCarrier = useCallback(async (file: File) => {
    setCarrierNotice("Decoding audio...");
    setPayloadNotice("");
    setActionNotice("");
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
      setAugmentedKey("");
      setDetected(embeddedPayload);
      setDetectedDataBuffer(embeddedDataBuffer);
      setCarrierNotice("");

      if (embeddedPayload?.kind === "text" && embeddedPayload.text) {
        setPayloadMode("text");
        setTextPayload(embeddedPayload.text);
        setFilePayload(null);
        setPayloadDirty(false);
      } else if (embeddedPayload?.kind === "file") {
        setPayloadMode("file");
        setFilePayload(null);
        setPayloadDirty(false);
      } else {
        setPayloadDirty(hasPayloadInput(payloadModeRef.current, textPayloadRef.current, filePayloadRef.current));
      }
    } catch (error) {
      setCarrierNotice(errorMessage(error));
    }
  }, [stopPlayback]);

  const loadPayload = useCallback(async (file: File) => {
    setPayloadNotice("Reading file...");

    try {
      const payload = await readFilePayload(file);
      setFilePayload(payload);
      setPayloadMode("file");
      setAugmented(null);
      setAugmentedKey("");
      setDetected(null);
      setDetectedDataBuffer(null);
      setPayloadDirty(true);
      setPayloadNotice("");
      setActionNotice(carrierBufferRef.current ? "Applying payload..." : "");
    } catch (error) {
      setPayloadNotice(errorMessage(error));
    }
  }, []);

  const clearPayloadFile = useCallback(() => {
    setFilePayload(null);
    setPayloadMode("text");
    setAugmented(null);
    setAugmentedKey("");
    setDetected(null);
    setDetectedDataBuffer(null);
    setPayloadDirty(Boolean(textPayloadRef.current.trim()));
    setPayloadNotice("");
    setActionNotice("");
  }, []);

  const selectPayloadMode = useCallback((mode: PayloadMode) => {
    setPayloadMode(mode);
    setPayloadNotice("");
    setActionNotice("");

    const hasActiveOutput = augmentedRef.current?.payload.kind === mode || detectedRef.current?.kind === mode;
    setPayloadDirty(hasPayloadInput(mode, textPayloadRef.current, filePayloadRef.current) && !hasActiveOutput);
  }, []);

  const exportCurrentAudio = useCallback(async () => {
    const carrier = carrierBufferRef.current;

    if (!carrier) {
      setCarrierNotice("Drop audio here or click to select");
      return;
    }

    setIsExporting(true);
    setActionNotice("");

    try {
      let currentAugmented = getActiveAugmented();

      if (payloadDirtyRef.current) {
        const payload = getPayloadInput({ require: true });
        if (!payload) {
          return;
        }
        currentAugmented = await applyPayload(payload);
        if (!currentAugmented) {
          return;
        }
      }

      const regions = currentAugmented?.regions ?? getActiveDetected()?.regions ?? [];
      const buffer = currentAugmented?.buffer ?? carrier;
      const exportedArtifacts = await exportAudio(buffer, baseName(carrierFileRef.current), async (candidate) => {
        const foundPayload = await detectEmbeddedPayload(candidate, regions);
        return Boolean(foundPayload);
      });
      const artifact = chooseDownloadArtifact(exportedArtifacts);
      if (!artifact.verified) {
        throw new Error("Export verification failed; payload was not downloaded.");
      }
      downloadArtifact(artifact);
      setActionNotice("Export verified");
    } catch (error) {
      setActionNotice(errorMessage(error));
    } finally {
      setIsExporting(false);
    }
  }, [applyPayload, getActiveAugmented, getActiveDetected, getPayloadInput]);

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
    updatePlayhead(true);
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

  useEffect(() => {
    if (!carrierBuffer || payloadMode !== "file" || !filePayload || !payloadDirty) {
      return;
    }

    void applyPayload(filePayload);
  }, [applyPayload, carrierBuffer, filePayload, payloadDirty, payloadMode]);

  useEffect(() => {
    if (!carrierBuffer || payloadMode !== "text" || !payloadDirty) {
      return undefined;
    }

    const text = textPayload.trim();

    if (!text) {
      return undefined;
    }

    const timeoutId = window.setTimeout(() => {
      void applyPayload(makeTextPayload(text));
    }, TEXT_APPLY_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [applyPayload, carrierBuffer, payloadDirty, payloadMode, textPayload]);

  const activeAugmented = augmented?.payload.kind === payloadMode ? augmented : null;
  const activeDetected = detected?.kind === payloadMode ? detected : null;
  const payloadLabelText = useMemo(() => payloadLabel(filePayload), [filePayload]);
  const detectedFile = activeDetected?.kind === "file" ? activeDetected : null;
  const detectedFileDetail = useMemo(() => detectedMetadata(detectedFile), [detectedFile]);
  const filePanelLabel = payloadNotice || (filePayload ? payloadLabelText : detectedFileDetail || "Drop file here or click to select");
  const filePanelHint = !payloadNotice && !filePayload && !detectedFileDetail ? `Max ${formatBytes(MAX_FILE_PAYLOAD_BYTES)}` : "";
  const visualizerRegions = useMemo(
    () => [...(activeAugmented?.regions ?? []), ...(activeDetected?.regions ?? [])] as HighlightRegion[],
    [activeAugmented, activeDetected],
  );
  const hasCarrier = Boolean(carrierBuffer);
  const hasPayload = payloadMode === "text" ? textPayload.trim().length > 0 : Boolean(filePayload);
  const hasEncodedOutput = Boolean(activeAugmented || activeDetected);
  const canExport = hasCarrier && (hasPayload || hasEncodedOutput);
  const canStop = playbackSnapshot.playing || playbackSnapshot.offset > 0;
  const carrierPanelLabel = carrierNotice
    || (carrierFile && carrierBuffer ? `${carrierFile.name} · ${formatDuration(carrierBuffer.duration)}` : "Drop audio here or click to select");
  const playLabel = playbackSnapshot.playing ? "Pause" : isPreparing ? "Applying..." : "Play";
  const exportLabel = isExporting ? "Exporting..." : "Export";
  const transportNotice = isExporting ? "Exporting..." : isPreparing ? "Applying payload..." : actionNotice;
  const visualizerData = activeAugmented?.dataBuffer ?? (activeDetected ? detectedDataBuffer : null);

  return (
    <>
      <canvas className="node-field" ref={nodeCanvasRef} data-node-field aria-hidden="true" />
      <main className="app-shell">
        <section className="workbench" aria-label="GGWave audio embedder">
          <div className="control-rail">
            <div className="drop-grid">
              <button className="dropzone primary" type="button" onClick={() => audioInputRef.current?.click()}>
                <span>Carrier audio</span>
                <strong>{carrierPanelLabel}</strong>
              </button>
            </div>

            <section className="payload-panel" aria-label="Payload">
              <div className="mode-row" role="tablist" aria-label="Payload mode">
                <button className={`mode${payloadMode === "text" ? " is-active" : ""}`} type="button" onClick={() => selectPayloadMode("text")}>Text</button>
                <button className={`mode${payloadMode === "file" ? " is-active" : ""}`} type="button" onClick={() => selectPayloadMode("file")}>File</button>
              </div>

              <textarea
                hidden={payloadMode !== "text"}
                rows={3}
                maxLength={2048}
                spellCheck={false}
                placeholder="Payload text"
                value={textPayload}
                className="payload-surface"
                onChange={(event) => {
                  const nextText = event.target.value;
                  setTextPayload(nextText);
                  setAugmented(null);
                  setAugmentedKey("");
                  setDetected(null);
                  setDetectedDataBuffer(null);
                  setPayloadDirty(Boolean(nextText.trim()));
                  setPayloadNotice("");
                  setActionNotice("");
                }}
              />

              <div className="file-panel payload-surface" hidden={payloadMode !== "file"}>
                <button className="dropzone" type="button" onClick={() => payloadInputRef.current?.click()}>
                  <span>{detectedFile && !filePayload ? "Detected file" : "Payload file"}</span>
                  <strong>{filePanelLabel}</strong>
                  {filePanelHint ? <small>{filePanelHint}</small> : null}
                </button>
                <div className="file-actions" hidden={!filePayload && !detectedFile}>
                  {filePayload ? <button type="button" onClick={clearPayloadFile}>Clear</button> : null}
                  {detectedFile ? <button type="button" onClick={downloadDetectedPayload}>Download</button> : null}
                </div>
              </div>
            </section>
          </div>

          <section className="visual-panel" aria-label="Live Fourier view">
            <div className="transport-panel" aria-label="Transport">
              <div className="transport">
                <button type="button" disabled={!hasCarrier || (!playbackSnapshot.playing && (isPreparing || isExporting))} onClick={() => void togglePlay()}>{playLabel}</button>
                <button type="button" disabled={!canStop} onClick={stopPlayback}>Stop</button>
                {transportNotice ? <span className="transport-status">{transportNotice}</span> : null}
                <button className="export-button" type="button" disabled={!canExport || isPreparing || isExporting} onClick={() => void exportCurrentAudio()}>{exportLabel}</button>
              </div>
              <TransportWaveform
                carrier={carrierBuffer}
                data={visualizerData}
                playheadTime={playheadTime}
                regions={visualizerRegions}
                onSeek={(time) => {
                  void seekPlayback(time);
                }}
              />
            </div>

            <div
              className="spectrum"
              aria-label="Fourier view"
            >
              <FourierVisualizer
                carrier={carrierBuffer}
                data={visualizerData}
                regions={visualizerRegions}
                playheadTime={playheadTime}
                liveFrequencyData={playbackSnapshot.playing ? frequencyDataRef.current : null}
                liveSampleRate={playbackRef.current?.context.sampleRate ?? carrierBuffer?.sampleRate ?? null}
              />
            </div>
          </section>
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
    return `Max ${formatBytes(MAX_FILE_PAYLOAD_BYTES)}`;
  }

  return `${payload.fileName} · ${formatBytes(payload.size)}`;
}

function detectedMetadata(detected: DetectedPayload | null) {
  if (!detected) {
    return "";
  }

  return detected.kind === "file"
    ? `${detected.fileName ?? "payload"} · ${formatBytes(detected.size)}`
    : `${formatBytes(detected.size)} text`;
}

function hasPayloadInput(mode: PayloadMode, text: string, filePayload: PayloadInput | null): boolean {
  return mode === "text" ? text.trim().length > 0 : Boolean(filePayload);
}

function makeEmbedKey(file: File | null, carrier: AudioBuffer, payload: PayloadInput): string {
  const carrierId = `${file?.name ?? "buffer"}:${file?.lastModified ?? 0}:${carrier.length}:${carrier.sampleRate}`;
  const payloadId = payload.kind === "text"
    ? `text:${payload.text}:${payload.size}`
    : `file:${payload.fileName}:${payload.mimeType}:${payload.size}:${payload.bytes[0] ?? 0}:${payload.bytes[payload.bytes.length - 1] ?? 0}`;
  return `${carrierId}|${payloadId}`;
}

function chooseDownloadArtifact(artifacts: readonly ExportArtifact[]): ExportArtifact {
  const verifiedMp3 = artifacts.find((artifact) => artifact.kind === "mp3" && artifact.verified);
  const verified = artifacts.find((artifact) => artifact.verified);
  const wav = artifacts.find((artifact) => artifact.kind === "wav");
  const fallback = verifiedMp3 ?? verified ?? wav ?? artifacts[0];

  if (!fallback) {
    throw new Error("Export failed.");
  }

  return fallback;
}

function TransportWaveform(props: {
  carrier: AudioBuffer | null;
  data: AudioBuffer | null;
  regions: readonly HighlightRegion[];
  playheadTime: number;
  onSeek: (time: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * pixelRatio);
    canvas.height = Math.round(height * pixelRatio);
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    drawTransportWaveform(context, width, height, props.carrier, props.data, props.regions, props.playheadTime);
  }, [props.carrier, props.data, props.playheadTime, props.regions]);

  const duration = Math.max(props.carrier?.duration ?? 0, props.data?.duration ?? 0, 0);

  return (
    <canvas
      className="transport-waveform"
      ref={canvasRef}
      aria-label="Transport waveform"
      role="img"
      onPointerDown={(event) => {
        if (duration <= 0) {
          return;
        }
        const bounds = event.currentTarget.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (event.clientX - bounds.left) / Math.max(1, bounds.width)));
        props.onSeek(ratio * duration);
      }}
    />
  );
}

function drawTransportWaveform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  carrier: AudioBuffer | null,
  data: AudioBuffer | null,
  regions: readonly HighlightRegion[],
  playheadTime: number,
): void {
  context.clearRect(0, 0, width, height);

  const duration = Math.max(carrier?.duration ?? 0, data?.duration ?? 0, 1);
  const laneGap = 7;
  const carrierHeight = Math.floor((height - laneGap) * 0.56);
  const dataTop = carrierHeight + laneGap;
  const dataHeight = Math.max(1, height - dataTop);

  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgba(84, 231, 255, 0.08)");
  gradient.addColorStop(0.52, "rgba(216, 255, 79, 0.055)");
  gradient.addColorStop(1, "rgba(255, 107, 157, 0.1)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (const region of regions) {
    if (region.end <= region.start) {
      continue;
    }
    const left = (region.start / duration) * width;
    const right = (region.end / duration) * width;
    context.fillStyle = "rgba(255, 107, 157, 0.1)";
    context.fillRect(left, dataTop, Math.max(1, right - left), dataHeight);
  }

  drawWaveformFill(context, carrier, 0, carrierHeight, width, "#54e7ff", 0.82, 10);
  drawWaveformFill(context, data, dataTop, dataHeight, width, "#ff6b9d", 0.78, 10);

  context.strokeStyle = "rgba(238, 244, 221, 0.16)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, carrierHeight + laneGap / 2);
  context.lineTo(width, carrierHeight + laneGap / 2);
  context.stroke();

  const x = Math.min(1, Math.max(0, playheadTime / duration)) * width;
  context.fillStyle = "rgba(216, 255, 79, 0.95)";
  context.fillRect(x - 1.5, 0, 3, height);
}

function drawWaveformFill(
  context: CanvasRenderingContext2D,
  buffer: AudioBuffer | null,
  top: number,
  height: number,
  width: number,
  color: string,
  alpha: number,
  maxGain: number,
): void {
  const centerY = top + height / 2;
  const scaleY = height * 0.43;

  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.globalAlpha = alpha;
  context.lineWidth = 1.2;

  if (!buffer) {
    context.globalAlpha = 0.16;
    context.beginPath();
    context.moveTo(0, centerY);
    context.lineTo(width, centerY);
    context.stroke();
    context.restore();
    return;
  }

  const pixelCount = Math.max(1, Math.floor(width));
  const samplesPerPixel = Math.max(1, Math.floor(buffer.length / pixelCount));
  const peaks = new Float32Array(pixelCount);
  let maxPeak = 0;

  for (let x = 0; x < pixelCount; x += 1) {
    const peak = readPeak(buffer, x * samplesPerPixel, samplesPerPixel);
    peaks[x] = peak;
    maxPeak = Math.max(maxPeak, peak);
  }

  const fitGain = maxPeak > 0 ? Math.min(maxGain, 0.88 / maxPeak) : 1;
  context.beginPath();

  for (let x = 0; x < pixelCount; x += 1) {
    const peak = Math.min(1, peaks[x] * fitGain);
    const y = centerY - peak * scaleY;
    if (x === 0) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  for (let x = pixelCount - 1; x >= 0; x -= 1) {
    const peak = Math.min(1, peaks[x] * fitGain);
    context.lineTo(x, centerY + peak * scaleY);
  }

  context.closePath();
  context.globalAlpha = alpha * 0.16;
  context.fill();
  context.globalAlpha = alpha;
  context.stroke();
  context.restore();
}

function readPeak(buffer: AudioBuffer, startSample: number, sampleCount: number): number {
  const endSample = Math.min(buffer.length, startSample + sampleCount);
  let peak = 0;

  for (let sampleIndex = startSample; sampleIndex < endSample; sampleIndex += 1) {
    let sum = 0;
    for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
      sum += buffer.getChannelData(channel)[sampleIndex] ?? 0;
    }
    peak = Math.max(peak, Math.abs(sum / Math.max(1, buffer.numberOfChannels)));
  }

  return peak;
}

function baseName(file: File | null) {
  const name = file?.name ?? "ultrasonic-encoder";
  return name.replace(/\.[^.]+$/, "") || "ultrasonic-encoder";
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
