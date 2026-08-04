# Cypher

A pocket DAW for sketching musical ideas. Mobile-first PWA — record from any mic, layer audio, mix, export WAV or MP3.

## Local development

```bash
pnpm install
pnpm dev
# open http://localhost:3000
```

Run the same quality gates as CI with `pnpm verify`; dependency advisories are
checked separately with `pnpm audit --audit-level low`.

With the dev server running and AirPods connected for both input and output,
run `pnpm test:audio-hardware`. Chrome plays a six-second synthetic
instrumental while capturing the selected headset mic with browser DSP off. It
reports the negotiated device format, clipping, and backing-track correlation,
then writes the JSON report and captured WAV under `output/playwright/`.

For a static deployment below a URL prefix, build with a normalized path such
as `NEXT_PUBLIC_BASE_PATH=/cypher pnpm build`. Next.js, public demo samples,
PWA metadata, and service-worker scope all use that build-time prefix.

The `pnpm.overrides` entries in `package.json` are narrow security exceptions
for vulnerable transitive versions, including Next.js's currently pinned
PostCSS. The production build and browser suite cover the override; remove each
exception once its parent dependency resolves to an audited version.

## Testing on a real phone

Mic capture (`getUserMedia`) requires a **secure origin** in every modern browser. `localhost` is exempt; the LAN IP printed by `next dev` is **not** — Safari and Chrome will silently refuse the mic prompt over plain HTTP. Use one of these:

### Option A — Cloudflare Tunnel (fastest, no signup for quick tests)

```bash
brew install cloudflared       # one time
cloudflared tunnel --url http://localhost:3000
```

It prints a public `https://<random>.trycloudflare.com` URL. Open that on your phone over the same Wi-Fi (or any network).

### Option B — ngrok

```bash
brew install ngrok
ngrok http 3000
```

### Option C — Vercel deploy

```bash
pnpm dlx vercel
```

Follow the prompts. You'll get a permanent `https://*.vercel.app` URL. Re-deploy with `pnpm dlx vercel --prod` for the production URL.

## What to test on device

- **First run:** start the demo, enable pattern recording on the Drum Kit, then tap **▶ Play**. Play stays disabled for a truly silent project, but an armed sampler with a loaded pad can roll before its first event. iOS Safari requires a real user gesture before audio starts, so this also verifies audio unlock.
- **Recording:** pick a mic with the mic picker, hit transport **●**, talk, hit **●** again. The waveform should turn green afterward and you should hear the recording when you tap **▶**.
- **Background:** background the tab during a recording — it should auto-stop and save what was captured up to that point. Returning to the foreground should leave the audio context working.
- **Bluetooth:** with AirPods connected, recording typically falls back to the phone's built-in mic (iOS limitation, not the app's). Wired headphones or a USB mic work as expected.
- **PWA install:** Safari → Share → "Add to Home Screen". The icon should be the green-bars Cypher logo. Launching from the home screen runs in standalone mode.
- **Storage:** open the menu (☰) — you should see a green "X MB" bar at the bottom. Recording for a while and reloading the page should show your tracks restored.

## Architecture

```
src/
  audio/
    engine.ts           Tone.js + Web Audio singleton; tracks, recording sessions
    mixdown.ts          OfflineAudioContext bounce → AudioBuffer
    export.ts           WAV/MP3 export pipeline
    mp3-worker.ts       lamejs encoder running in a Web Worker
    wav.ts              In-house AudioBuffer → WAV blob encoder
  state/
    store.ts            Zustand store: project state, persistence orchestration
  persistence/
    db.ts               IndexedDB layer (idb wrapper) for projects + audio blobs
  components/
    Transport.tsx       Top bar: play/stop/record + BPM + ☰ menu
    Timeline.tsx        Project-wide playhead and scrubber
    TrackRow.tsx        One row per track: M/S/R, mic picker, sliders, waveform
    Waveform.tsx        Cached canvas peak display with accessible trim controls
    LiveWaveform.tsx    Live bar-graph during recording (canvas)
    InputPicker.tsx     Per-track mic device dropdown
    MainMenu.tsx        Library + export hamburger menu
    ...
```

Recording uses an **AudioWorklet PCM path** when Web Audio can preserve the
microphone's sample rate. The worklet transfers raw Float32 chunks to a
dedicated worker, which spools them to temporary OPFS storage when available
and streams bounded segments into the final `AudioBuffer`. This avoids a
perceptual-codec round trip without retaining the whole take on the UI thread.
The worker uses isolated memory when OPFS is unavailable. MediaRecorder remains
a compatibility fallback when the worklet/worker cannot start or Web Audio
would reduce input bandwidth. An `AnalyserNode` runs in parallel for the live
waveform.
