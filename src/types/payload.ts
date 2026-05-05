export type PayloadBytes = Uint8Array<ArrayBuffer>;

export type PayloadInput =
  | {
      kind: "text";
      text: string;
      bytes: PayloadBytes;
      size: number;
      fileName: string;
      mimeType: string;
    }
  | {
      kind: "file";
      bytes: PayloadBytes;
      size: number;
      fileName: string;
      mimeType: string;
    };

export type DetectedPayload =
  | {
      kind: "text";
      text: string;
      bytes: PayloadBytes;
      fileName: string;
      mimeType: string;
      size: number;
      crc32: number;
      chunks: number;
      chunkCount: number;
      regions: HighlightRegion[];
    }
  | {
      kind: "file";
      bytes: PayloadBytes;
      fileName: string;
      mimeType: string;
      size: number;
      crc32: number;
      chunks: number;
      chunkCount: number;
      regions: HighlightRegion[];
    };

export type HighlightRegion = {
  kind: PayloadInput["kind"];
  start: number;
  end: number;
  startTime: number;
  endTime: number;
  label: string;
};

export type EmbedResult = {
  buffer: AudioBuffer;
  dataBuffer: AudioBuffer;
  payload: PayloadInput;
  highlights: HighlightRegion[];
  regions: HighlightRegion[];
  embedded: DetectedPayload;
};

export type ExportArtifact = {
  kind: "mp3" | "wav";
  format: "mp3" | "wav";
  blob: Blob;
  fileName: string;
  mimeType: string;
  verified: boolean;
  message: string;
  fallbackReason?: string;
};
