import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, atr, trueRange, volumeSpike, crossover, crossunder, barsSinceCross, lastValue } from '../src/indicators.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('sma', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('ema seeds with SMA and follows a linear series', () => {
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const e = ema(v, 3);
  assert.equal(e[1], null);
  close(e[2], 2);
  close(e[3], 3); // 4*0.5 + 2*0.5
  close(e[9], 9); // lag of 1 on a slope-1 series with k=0.5
});

test('ema skips leading nulls (used for MACD signal)', () => {
  const e = ema([null, null, 2, 2, 2, 2], 2);
  assert.deepEqual(e, [null, null, null, 2, 2, 2]);
});

test('rsi extremes and symmetry', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = up.map((x) => 300 - x);
  assert.equal(rsi(up, 14)[29], 100);
  assert.equal(rsi(down, 14)[29], 0);
  assert.equal(rsi(new Array(30).fill(5), 14)[29], 50);
  const wave = Array.from({ length: 60 }, (_, i) => 100 + 10 * Math.sin(i / 3) + i * 0.1);
  const mirror = wave.map((x) => 200 - x);
  const a = rsi(wave, 14);
  const b = rsi(mirror, 14);
  close(a[59] + b[59], 100, 1e-9);
  assert.equal(a[13], null);
  assert.ok(a[14] !== null);
});

test('macd is zero on a flat series and positive on an uptrend', () => {
  const flat = macd(new Array(60).fill(3));
  close(lastValue(flat.macd), 0);
  close(lastValue(flat.histogram), 0);
  const upm = macd(Array.from({ length: 80 }, (_, i) => 10 + i));
  assert.ok(lastValue(upm.macd) > 0);
  assert.ok(Math.abs(lastValue(upm.histogram)) < 1e-3); // converges on a linear trend
});

test('trueRange uses previous close gaps', () => {
  const tr = trueRange([
    { h: 11, l: 9, c: 10 },
    { h: 15, l: 12, c: 14 },
  ]);
  assert.deepEqual(tr, [2, 5]);
});

test('atr of constant-range candles', () => {
  const candles = Array.from({ length: 30 }, () => ({ h: 11, l: 9, c: 10 }));
  const a = atr(candles, 14);
  assert.equal(a[12], null);
  close(a[13], 2);
  close(a[29], 2);
});

test('volumeSpike', () => {
  assert.equal(volumeSpike([...new Array(20).fill(1), 5], 20), 5);
  assert.equal(volumeSpike([1, 2, 3], 20), null);
  assert.equal(volumeSpike([...new Array(20).fill(0), 5], 20), null);
});

test('crossover / crossunder / barsSinceCross', () => {
  const a = [1, 1, 3, 3, 3];
  const b = [2, 2, 2, 2, 2];
  assert.equal(crossover(a, b, 2), true);
  assert.equal(crossover(a, b, 3), false);
  assert.equal(crossunder([3, 1], [2, 2], 1), true);
  assert.equal(barsSinceCross(a, b, 'up', 3), 2);
  assert.equal(barsSinceCross(a, b, 'up', 1), null);
  assert.equal(barsSinceCross(a, b, 'down', 3), null);
});
