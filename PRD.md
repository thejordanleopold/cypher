# Cypher — Product Requirements Document

**Version:** 0.1 (Draft)
**Date:** 2026-04-30
**Owner:** Jordan Leopold

---

## 1. Summary

Cypher is a mobile-first web app that functions as a pocket-sized DAW (Digital Audio Workstation). It lets users sketch musical ideas on the go by layering imported audio (mp3/wav) and live mic recordings (built-in mic, Bluetooth, wired) onto multiple tracks, then exporting a mixdown as mp3 or wav.

The product exists to capture musical ideas at the moment of inspiration — when a full DAW is unavailable but a phone is. It is **not** a replacement for Logic, Ableton, or FL Studio; it is the napkin-sketch for those tools.

## 2. Goals & Non-Goals

### Goals
- Open the app and start recording in **under 5 seconds** from a cold load.
- Layer at least **6 simultaneous audio tracks** without dropouts on a mid-range phone (iPhone 12 / Pixel 6 class).
- Record mic input synchronized to playback with **<30 ms perceived latency** when using wired/Bluetooth-LE audio.
- Export a final mixdown as **mp3 (192 kbps)** or **wav (16-bit / 44.1 kHz)**.
- Work offline once loaded; no account required for v1.

### Non-Goals (v1)
- MIDI, virtual instruments, or notation.
- Effects beyond gain, pan, mute/solo, and a single global limiter.
- Cloud collaboration or multi-device sync.
- Native iOS/Android apps (web-only, installable as PWA).
- Pro mastering features (EQ, compression chains, sidechain, automation curves).

## 3. Target User

- **Primary:** Hobbyist musicians, songwriters, and producers who want to capture an idea (a vocal hook, a beat tap, a riff) before it disappears.
- **Secondary:** Podcasters / voice-memo users who want a slightly more capable multitrack recorder.

## 4. Core User Flows

### 4.1 First-time use
1. User loads `cypher.app` on phone → sees a single empty project with two tracks.
2. Taps **+** on Track 1 → picks an mp3 from device storage.
3. Taps **● Record** on Track 2 → grants mic permission → records over playback.
4. Taps **Export** → chooses mp3 or wav → file saves to device.

### 4.2 Returning use
- Last project auto-loads. Project list (saved locally) is one tap away.

### 4.3 Track-level actions
- Add audio file (mp3, wav, m4a, ogg)
- Record from mic
- Trim (set in/out points)
- Set volume (0–150%)
- Pan (L/R)
- Mute / Solo
- Delete

### 4.4 Project-level actions
- Play / pause / stop / scrub
- Set tempo + metronome (click track during recording)
- Save / rename / duplicate / delete project
- Export mixdown

## 5. Functional Requirements

| ID | Requirement |
|---|---|
| F1 | Support 6+ tracks with independent gain, pan, mute, solo |
| F2 | Import mp3, wav, m4a, ogg from device file picker |
| F3 | Record from any input device exposed by `getUserMedia` (built-in, Bluetooth, USB) |
| F4 | Synchronize recording start with playback within ±30 ms |
| F5 | Visual waveform per track, scrubbing supported |
| F6 | Metronome with adjustable BPM (40–240) and time signature |
| F7 | Mixdown export to mp3 (LAME, 192 kbps) and wav (PCM 16/44.1) |
| F8 | Persist projects locally across sessions (survives reload) |
| F9 | Installable as PWA with offline support after first load |
| F10 | Handle interruptions gracefully (incoming call, app backgrounded) |

## 6. Non-Functional Requirements

- **Latency:** Output latency budget ≤ 50 ms total during overdub recording.
- **Performance:** No audible glitches with 6 tracks @ 44.1 kHz on iPhone 12 / Pixel 6.
- **Storage:** Single project ≤ 100 MB; warn user at 80% device-quota usage.
- **Compatibility:** iOS Safari 16+, Chrome Android 110+, desktop Chrome/Safari/Firefox latest.
- **Accessibility:** Touch targets ≥ 44 px, color-contrast WCAG AA, transport controls keyboard-accessible.
- **Privacy:** All audio processing client-side; mic data never leaves the device in v1.

## 7. Recommended Tech Stack

The constraint shaping every choice: **low-latency multitrack audio in a mobile browser, exported on-device.** This rules out most server-rendered or heavyweight frameworks.

### Frontend framework
- **Next.js 16.2 (App Router) + React 19.2** — static export mode keeps the app fully client-side and deployable to GitHub Pages.
- **TypeScript** throughout.

### Audio engine
- **Web Audio API** — the only viable browser API for sample-accurate scheduling and multi-track mixing.
- **Tone.js** as a thin convenience layer over Web Audio for transport, scheduling, and the metronome. Avoids reinventing the clock. Drop down to raw `AudioContext` for buffer manipulation and routing.
- **MediaRecorder API** for the recording path, with Web Audio analyser nodes for metering and decoded `AudioBuffer`s for playback/editing.

### Waveform rendering
- **Custom canvas peak renderer** — immutable `AudioBuffer`s are summarized once into cached min/max bins, so resize and remount work stays bounded even for long recordings.

### Encoding / export
- **`@mediabunny/mp3-encoder`** or **`lamejs`** (WASM build) for mp3 export — runs in a Web Worker so the UI stays responsive.
- **Native `AudioBuffer` → WAV** via a small in-house encoder (~50 lines, no dependency).
- Mixdown done via `OfflineAudioContext` for faster-than-realtime bounce.

### State & persistence
- **Zustand** for app/transport state — lighter than Redux, no provider boilerplate, plays well with React 19.
- **IndexedDB via `idb`** for project persistence (audio buffers as `Blob`s, project metadata as JSON). LocalStorage is too small for audio.

### UI
- **Tailwind CSS v4** with semantic custom controls. Canvas/SVG handle waveforms, the timeline, transport icons, and meters.

### PWA
- **Generated service worker** with a content-revisioned static-export manifest. User recordings remain in IndexedDB and are never placed in HTTP caches.

### Tooling
- **pnpm**, **ESLint**, Node's test runner, and **Playwright** for persistence/offline browser regressions.
- **Sentry** for error tracking once we ship.

### Hosting
- **GitHub Pages**. No backend in v1 — everything is static + client-side.

### Why not …
- **Native (React Native / Expo)** — defers v1 by months; the spec says mobile *web* app, and `getUserMedia` + Web Audio cover the requirement.
- **Flutter** — weaker browser audio story; would need to bridge to JS for everything that matters.
- **A custom Rust/WASM engine** — overkill for v1. Tone.js + AudioWorklet handles 6 tracks comfortably. Revisit if we add effects chains.
- **Supabase/Firebase** — no server-side need yet. Avoid the dependency until accounts/sync land in v2.

## 8. Architecture Overview

```
┌────────────────────────────────────────────────────────┐
│  React UI (Next.js, Tailwind, shadcn)                  │
│   ├─ Transport / Track List / Mixer                    │
│   └─ Cached canvas waveform views                      │
├────────────────────────────────────────────────────────┤
│  Zustand store  ⇄  IndexedDB (idb) / OPFS              │
├────────────────────────────────────────────────────────┤
│  Audio Engine                                          │
│   ├─ Tone.Transport (clock, metronome)                 │
│   ├─ Per-track GainNode → PannerNode → master bus      │
│   ├─ Master bus → DynamicsCompressor (limiter) → dest  │
│   ├─ Recording: getUserMedia → MediaRecorder → Buffer  │
│   └─ Export: OfflineAudioContext → WAV/MP3 (Worker)    │
└────────────────────────────────────────────────────────┘
```

## 9. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| iOS Safari audio quirks (autoplay, AudioContext resume, background suspension) | Gate all audio start on a user gesture; resume context on visibility change; show a clear "tap to enable audio" affordance |
| Bluetooth audio adds 100–300 ms latency, breaking overdubs | Detect output device class; warn user and offer wired-headphone recommendation; allow per-track latency offset |
| iOS limits IndexedDB / OPFS quota (often ~1 GB combined) | Show storage usage UI; let user delete old projects; warn at 80% |
| mp3 encoding is slow on low-end phones | Run in Worker; show progress; offer wav as the faster default |
| Mic permission revoked mid-session | Detect `MediaStreamTrack.onended`, prompt re-grant, preserve recorded data |
| Browser tab killed under memory pressure | Persist after every recording stop; debounced auto-save during edits |

## 10. Milestones

1. **M1 — Walking skeleton:** Next.js PWA shell, Tone.js transport, one track, file import, playback.
2. **M2 — Recording:** Mic capture via AudioWorklet, overdub against playback, metronome.
3. **M3 — Multitrack + mixer:** N-track support, gain/pan/mute/solo, waveform UI, trim.
4. **M4 — Export:** WAV bounce, then mp3 via lamejs Worker.
5. **M5 — Persistence & PWA polish:** IndexedDB projects, offline shell, install prompt.
6. **M6 — Beta:** PWA install on real devices, bug bash, ship v1.

## 11. Open Questions

- Do we want a click-track-only "rehearsal" mode that doesn't write to a track?
- Should imported files be copied into IndexedDB or referenced by File handle (Origin File System Access)?
- Latency calibration: ship a one-tap "tap the click" calibration flow in v1, or defer to v2?
- Project sharing in v1: export the project as a `.cypher` zip (audio + JSON), or skip until accounts exist?

## 12. Future (Post-v1)

- Effects: EQ, reverb, delay, compression per track
- MIDI input + simple sampler/drum pad
- Cloud sync + sharing (Supabase)
- Stems export
- Cut/copy/paste regions, ripple edit
- Ableton Link for jamming with desktop DAWs
