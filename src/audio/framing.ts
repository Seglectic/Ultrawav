import type { DetectedPayload, HighlightRegion, PayloadInput, PayloadBytes } from "../types/payload";

export const MAX_FILE_PAYLOAD_BYTES = 4096;

const GGWAVE_PAYLOAD_LIMIT_BYTES = 140;
const FRAME_TARGET_BYTES = 128;
const FRAME_MAGIC = 0x53475756;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 22;
const FRAME_NAME_MIME_LIMIT_BYTES = 80;

const KIND_TEXT = 1;
const KIND_FILE = 2;
const EMPTY_REGIONS: HighlightRegion[] = [];

type Frame = {
  kind: PayloadInput["kind"];
  fileName: string;
  mimeType: string;
  size: number;
  crc32: number;
  chunkIndex: number;
  chunkTotal: number;
  chunk: Uint8Array;
};

const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

export const crc32 = (bytes: Uint8Array): number => {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
};

const kindToByte = (kind: PayloadInput["kind"]): number => kind === "text" ? KIND_TEXT : KIND_FILE;

const byteToKind = (value: number): PayloadInput["kind"] | null => {
  if (value === KIND_TEXT) {
    return "text";
  }
  if (value === KIND_FILE) {
    return "file";
  }
  return null;
};

const validateMetadata = (nameBytes: Uint8Array, mimeBytes: Uint8Array): void => {
  if (nameBytes.byteLength > 255 || mimeBytes.byteLength > 255) {
    throw new Error("Payload filename and MIME type must each fit in 255 UTF-8 bytes.");
  }

  if (nameBytes.byteLength + mimeBytes.byteLength > FRAME_NAME_MIME_LIMIT_BYTES) {
    throw new Error(`Payload filename and MIME type must fit in ${FRAME_NAME_MIME_LIMIT_BYTES} UTF-8 bytes total.`);
  }
};

const chunkSizeFor = (nameBytes: Uint8Array, mimeBytes: Uint8Array): number => {
  validateMetadata(nameBytes, mimeBytes);
  const chunkSize = FRAME_TARGET_BYTES - FRAME_HEADER_BYTES - nameBytes.byteLength - mimeBytes.byteLength;

  if (chunkSize <= 0 || FRAME_TARGET_BYTES > GGWAVE_PAYLOAD_LIMIT_BYTES) {
    throw new Error("Payload metadata leaves no room for GGWave frame data.");
  }

  return chunkSize;
};

export const encodeFrames = (payload: PayloadInput): Uint8Array[] => {
  if (payload.kind === "file" && payload.bytes.byteLength > MAX_FILE_PAYLOAD_BYTES) {
    throw new Error(`File payload must be ${MAX_FILE_PAYLOAD_BYTES} bytes or smaller.`);
  }

  const textEncoder = new TextEncoder();
  const nameBytes = textEncoder.encode(payload.fileName);
  const mimeBytes = textEncoder.encode(payload.mimeType);
  const chunkSize = chunkSizeFor(nameBytes, mimeBytes);
  const chunkTotal = Math.max(1, Math.ceil(payload.bytes.byteLength / chunkSize));
  const checksum = crc32(payload.bytes);

  if (chunkTotal > 65535) {
    throw new Error("Payload requires too many GGWave chunks.");
  }

  const frames: Uint8Array[] = [];

  for (let chunkIndex = 0; chunkIndex < chunkTotal; chunkIndex += 1) {
    const chunkStart = chunkIndex * chunkSize;
    const chunk = payload.bytes.slice(chunkStart, Math.min(payload.bytes.byteLength, chunkStart + chunkSize));
    const frame = new Uint8Array(FRAME_HEADER_BYTES + nameBytes.byteLength + mimeBytes.byteLength + chunk.byteLength);
    const view = new DataView(frame.buffer);
    let offset = 0;

    view.setUint32(offset, FRAME_MAGIC, false);
    offset += 4;
    frame[offset] = FRAME_VERSION;
    offset += 1;
    frame[offset] = kindToByte(payload.kind);
    offset += 1;
    frame[offset] = nameBytes.byteLength;
    offset += 1;
    frame[offset] = mimeBytes.byteLength;
    offset += 1;
    view.setUint32(offset, payload.bytes.byteLength, false);
    offset += 4;
    view.setUint32(offset, checksum, false);
    offset += 4;
    view.setUint16(offset, chunkIndex, false);
    offset += 2;
    view.setUint16(offset, chunkTotal, false);
    offset += 2;
    view.setUint16(offset, chunk.byteLength, false);
    offset += 2;
    frame.set(nameBytes, offset);
    offset += nameBytes.byteLength;
    frame.set(mimeBytes, offset);
    offset += mimeBytes.byteLength;
    frame.set(chunk, offset);
    frames.push(frame);
  }

  return frames;
};

export const decodeFrame = (bytes: Uint8Array): Frame | null => {
  if (bytes.byteLength < FRAME_HEADER_BYTES) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== FRAME_MAGIC || bytes[4] !== FRAME_VERSION) {
    return null;
  }

  const kind = byteToKind(bytes[5]);
  if (kind === null) {
    return null;
  }

  const nameLength = bytes[6];
  const mimeLength = bytes[7];
  const size = view.getUint32(8, false);
  const checksum = view.getUint32(12, false);
  const chunkIndex = view.getUint16(16, false);
  const chunkTotal = view.getUint16(18, false);
  const chunkLength = view.getUint16(20, false);
  const expectedLength = FRAME_HEADER_BYTES + nameLength + mimeLength + chunkLength;

  if (chunkTotal === 0 || chunkIndex >= chunkTotal || bytes.byteLength < expectedLength) {
    return null;
  }

  const textDecoder = new TextDecoder();
  const nameStart = FRAME_HEADER_BYTES;
  const mimeStart = nameStart + nameLength;
  const chunkStart = mimeStart + mimeLength;

  return {
    kind,
    fileName: textDecoder.decode(bytes.slice(nameStart, mimeStart)),
    mimeType: textDecoder.decode(bytes.slice(mimeStart, chunkStart)),
    size,
    crc32: checksum,
    chunkIndex,
    chunkTotal,
    chunk: bytes.slice(chunkStart, chunkStart + chunkLength),
  };
};

export const assembleFrames = (frames: Frame[]): DetectedPayload | null => {
  if (frames.length === 0) {
    return null;
  }

  const first = frames[0];
  const byIndex = new Map<number, Frame>();

  for (const frame of frames) {
    if (
      frame.kind !== first.kind
      || frame.fileName !== first.fileName
      || frame.mimeType !== first.mimeType
      || frame.size !== first.size
      || frame.crc32 !== first.crc32
      || frame.chunkTotal !== first.chunkTotal
    ) {
      continue;
    }
    byIndex.set(frame.chunkIndex, frame);
  }

  if (byIndex.size !== first.chunkTotal) {
    return null;
  }

  const bytes = new Uint8Array(first.size);
  let offset = 0;

  for (let index = 0; index < first.chunkTotal; index += 1) {
    const frame = byIndex.get(index);
    if (frame === undefined || offset + frame.chunk.byteLength > bytes.byteLength) {
      return null;
    }
    bytes.set(frame.chunk, offset);
    offset += frame.chunk.byteLength;
  }

  if (offset !== bytes.byteLength || crc32(bytes) !== first.crc32) {
    return null;
  }

  if (first.kind === "text") {
    return {
      kind: "text",
      text: new TextDecoder().decode(bytes),
      bytes,
      fileName: first.fileName,
      mimeType: first.mimeType,
      size: first.size,
      crc32: first.crc32,
      chunks: first.chunkTotal,
      chunkCount: first.chunkTotal,
      regions: EMPTY_REGIONS,
    };
  }

  return {
    kind: "file",
    bytes: bytes as PayloadBytes,
    fileName: first.fileName,
    mimeType: first.mimeType,
    size: first.size,
    crc32: first.crc32,
    chunks: first.chunkTotal,
    chunkCount: first.chunkTotal,
    regions: EMPTY_REGIONS,
  };
};
