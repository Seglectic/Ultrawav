# Ultrawav

Browser-only tool for hiding payloads inside audio files using ultrasonic [GGWave](https://github.com/ggerganov/ggwave) encoding. Drop in a carrier audio file, enter text or attach a small file, and export an MP3 that carries the payload in the inaudible frequency range. Drop the exported audio back in to recover it.

No backend, no uploads, no accounts.

## What it does

- **Embed** — mixes a GGWave ultrasonic signal into carrier audio above ~18 kHz
- **Detect** — scans a loaded audio file for an existing embedded payload and auto-populates the UI
- **Visualize** — live Fourier spectrogram and waveform view of carrier vs. data frequency regions
- **Export** — MP3 (with round-trip verification) or WAV fallback

Payload types:
- **Text** — up to 2048 characters, encoded near the beginning of the carrier
- **File** — up to 4 KB binary, appended as an ultrasonic tail

## Stack

| Layer | Technology |
|---|---|
| UI | React 19 + TypeScript |
| Build | Vite (vite-plus) |
| Audio | Web Audio API |
| Encoding | [@vpalmisano/ggwave](https://www.npmjs.com/package/@vpalmisano/ggwave) |
| FFT | fft.js |
| Background | Three.js / React Three Fiber (WebGL) |

## Development

```sh
pnpm install
pnpm dev --host 127.0.0.1
```

Build and type-check:
```sh
pnpm build
```

Type-check only:
```sh
pnpm exec tsc --noEmit --pretty false
```

## How embedding works

1. Carrier audio is low-pass filtered at 17 kHz to clear the ultrasonic band
2. Payload bytes are framed (kind, filename, MIME type, CRC-32, chunk index/total)
3. Each frame is GGWave-encoded to a Float32 waveform at the carrier's sample rate, targeting the `ULTRASOUND_FAST` protocol starting at 18 kHz
4. Frames are mixed into the carrier at 22% gain with 10 ms fade-in/out edges
5. The combined buffer is normalized and exported

Detection scans the audio in 24-second windows with a 1-second step, starting at 0.5 s and checking the tail for file payloads.

## Caveats

- MP3 re-encoding can destroy ultrasonic content depending on the browser's encoder. Export is verified by decoding the output and re-detecting the payload; WAV is offered as the authoritative fallback when verification fails.
- Maximum file payload is 4 KB. Larger payloads require more carrier duration and are not supported.
- Requires a browser with Web Audio API and WebAssembly support.
