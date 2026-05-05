# Stepgrid Agent Notes

## Project

Client-only Vite/TypeScript app for embedding and recovering small GGWave payloads in carrier audio.

Core flow:
- drop compatible audio
- enter text or attach small file payload
- embed ultrasonic GGWave data
- visualize carrier/data frequency regions
- export MP3, with WAV fallback when verification fails

## Architecture

- UI/state orchestration: `src/main.ts`
- Audio pipeline: `src/audio/`
- GGWave boundary: `src/ggwave/`
- Shared payload types: `src/types/`
- Fourier view: `src/visualizer/`
- animated page background: `src/webgl/`
- global styling: `src/style.css`

Keep implementation details in source. Use this file for orientation only.

## Design Rationale

- Browser-only: no backend, no tokens/env required.
- Web Audio owns decode/playback/buffer work.
- GGWave wrapper isolated behind adapter; payload framing isolated from UI.
- MP3 export is best-effort because ultrasonic payload survival depends on encoder/browser behavior.
- WAV fallback is authoritative recovery path.
- Visuals are live-audio driven but must degrade cleanly when WebGL unavailable.

## Constraints

- Default max raw file payload: 4 KB.
- Text payload starts near beginning of carrier.
- File payload appends as ultrasonic tail.
- Existing embedded payloads should populate UI and expose payload download.
- Preserve clear user errors for unsupported audio or oversized files.

## Development

- Package manager: `pnpm`
- Type/build check: `pnpm build`
- Type-only check: `pnpm exec tsc --noEmit --pretty false`
- Local dev server: `pnpm dev --host 127.0.0.1`

## Agent Rules

- Prefer small, scoped changes.
- Follow existing module boundaries before adding new ones.
- Do not duplicate low-level behavior in docs; point to source.
- Verify audio/framing changes with focused roundtrips when possible.
