import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  MIXDOWN_SAMPLE_RATE,
  mixdown,
  type MixTrack,
} from "../src/audio/mixdown.ts";

interface ContextConstruction {
  channels: number;
  length: number;
  sampleRate: number;
}

const constructions: ContextConstruction[] = [];
const originalOfflineAudioContext = globalThis.OfflineAudioContext;

class FakeAudioNode {
  connect() {
    return this;
  }
}

class FakeOfflineAudioContext {
  readonly destination = new FakeAudioNode();
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;

  constructor(
    numberOfChannels: number,
    length: number,
    sampleRate: number,
  ) {
    this.numberOfChannels = numberOfChannels;
    this.length = length;
    this.sampleRate = sampleRate;
    constructions.push({
      channels: numberOfChannels,
      length,
      sampleRate,
    });
  }

  createDynamicsCompressor() {
    return Object.assign(new FakeAudioNode(), {
      threshold: { value: 0 },
      knee: { value: 0 },
      ratio: { value: 0 },
      attack: { value: 0 },
      release: { value: 0 },
    });
  }

  createGain() {
    return Object.assign(new FakeAudioNode(), { gain: { value: 0 } });
  }

  createStereoPanner() {
    return Object.assign(new FakeAudioNode(), { pan: { value: 0 } });
  }

  createBufferSource() {
    return Object.assign(new FakeAudioNode(), {
      buffer: null,
      start: () => {},
    });
  }

  async startRendering() {
    return {
      length: this.length,
      numberOfChannels: this.numberOfChannels,
      sampleRate: this.sampleRate,
    } as AudioBuffer;
  }
}

globalThis.OfflineAudioContext =
  FakeOfflineAudioContext as unknown as typeof OfflineAudioContext;

after(() => {
  if (originalOfflineAudioContext) {
    globalThis.OfflineAudioContext = originalOfflineAudioContext;
  } else {
    Reflect.deleteProperty(globalThis, "OfflineAudioContext");
  }
});

function track(buffer: AudioBuffer | null): MixTrack {
  return {
    buffer,
    volume: 1,
    pan: 0,
    trimInSec: 0,
    trimOutSec: null,
  };
}

function sourceBuffer(sampleRate: number, duration: number): AudioBuffer {
  return { duration, sampleRate } as AudioBuffer;
}

test("empty mixdowns use a one-second 44.1 kHz export buffer", async () => {
  constructions.length = 0;

  const rendered = await mixdown([]);

  assert.equal(MIXDOWN_SAMPLE_RATE, 44_100);
  assert.equal(rendered.sampleRate, 44_100);
  assert.deepEqual(constructions, [
    { channels: 2, length: 44_100, sampleRate: 44_100 },
  ]);
});

test("mixdowns render at 44.1 kHz regardless of source sample rate", async () => {
  constructions.length = 0;

  const rendered = await mixdown([track(sourceBuffer(96_000, 0.5))]);

  assert.equal(rendered.sampleRate, 44_100);
  assert.deepEqual(constructions, [
    { channels: 2, length: 22_050, sampleRate: 44_100 },
  ]);
});

test("sampler-event stems use the same fixed export sample rate", async () => {
  constructions.length = 0;
  const samplerTrack: MixTrack = {
    ...track(null),
    events: [
      {
        buffer: sourceBuffer(8_000, 0.25),
        timeSec: 1,
      },
    ],
  };

  const rendered = await mixdown([samplerTrack]);

  assert.equal(rendered.sampleRate, 44_100);
  assert.deepEqual(constructions, [
    { channels: 2, length: 55_125, sampleRate: 44_100 },
  ]);
});
