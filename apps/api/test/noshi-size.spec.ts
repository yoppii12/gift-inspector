/**
 * のし紙の長短の計測（#55）。合成画像（グレーの背景に白い長方形）で、縦横比による判定を確かめる。
 * 実物写真での確認結果は docs/requirements/261016_requirements.md 5-2 を参照。
 */
import {describe, expect, it} from 'vitest';

import {LONG_MIN_RATIO, measureNoshiSize, SHORT_MAX_RATIO} from '../src/measure/noshi-size';
import {photo} from './helpers';

const SHORT = 260;

// 合成画像（1600×1200）の生成と JPEG 化をテスト内で行うため、並列実行では既定の 5 秒を超えることがある
describe('のし紙の長短の計測', {timeout: 30_000}, () => {
  it('しきい値は受領写真の測定値（長い 3.51〜3.58、短い 2.89〜3.01）の間にある', () => {
    expect(LONG_MIN_RATIO).toBeLessThan(3.51);
    expect(SHORT_MAX_RATIO).toBeGreaterThan(3.01);
    expect(SHORT_MAX_RATIO).toBeLessThan(LONG_MIN_RATIO);
  });

  it.each([
    ['長い（水平）', {long: SHORT * 3.55, angle: 0}, '長い'],
    ['長い（7°傾き）', {long: SHORT * 3.55, angle: 7}, '長い'],
    ['長い（-20°傾き・文字と水引あり）', {long: SHORT * 3.52, angle: -20, marks: true}, '長い'],
    ['短い（水平）', {long: SHORT * 2.95, angle: 0}, '短い'],
    ['短い（12°傾き・文字と水引あり）', {long: SHORT * 2.98, angle: 12, marks: true}, '短い'],
  ] as const)('%s → %s', (_l, sheet, size) => {
    const r = measureNoshiSize(photo([{cx: 800, cy: 600, short: SHORT, ...sheet}]), 'image/jpeg');
    expect(r).toMatchObject({size, reason: 'MEASURED'});
    expect(r.candidates).toHaveLength(1);
  });

  it('境目に近い縦横比（3.25）は判定しない（BORDERLINE）', () => {
    const r = measureNoshiSize(
      photo([{cx: 800, cy: 600, short: SHORT, long: SHORT * 3.25}]),
      'image/jpeg'
    );
    expect(r).toMatchObject({size: null, reason: 'BORDERLINE'});
    expect(r.ratio).toBeGreaterThan(SHORT_MAX_RATIO);
    expect(r.ratio).toBeLessThan(LONG_MIN_RATIO);
  });

  it('のし紙らしい紙がなければ NOT_FOUND（取扱説明書のような縦横比の小さい白い紙は数えない）', () => {
    const r = measureNoshiSize(photo([{cx: 800, cy: 600, short: 300, long: 420}]), 'image/jpeg');
    expect(r).toMatchObject({size: null, reason: 'NOT_FOUND'});
  });

  it('のし紙と取扱説明書が離れて写っていれば、のし紙だけを測る', () => {
    const r = measureNoshiSize(
      photo([
        {cx: 560, cy: 300, short: 200, long: 200 * 3.55},
        {cx: 1300, cy: 850, short: 260, long: 360},
      ]),
      'image/jpeg'
    );
    expect(r).toMatchObject({size: '長い', reason: 'MEASURED'});
  });

  it('のし紙らしい紙が2枚あれば判定しない（MULTIPLE）', () => {
    const r = measureNoshiSize(
      photo([
        {cx: 520, cy: 300, short: 180, long: 180 * 3.55},
        {cx: 1050, cy: 850, short: 180, long: 180 * 2.95},
      ]),
      'image/jpeg'
    );
    expect(r).toMatchObject({size: null, reason: 'MULTIPLE'});
    expect(r.candidates).toHaveLength(2);
  });

  it('2枚が接していて1つの塊になったら、のし紙として数えない（判定しない）', () => {
    const r = measureNoshiSize(
      photo([
        {cx: 800, cy: 480, short: 240, long: 240 * 3.55},
        {cx: 800, cy: 718, short: 240, long: 240 * 2.95},
      ]),
      'image/jpeg'
    );
    expect(r).toMatchObject({size: null, reason: 'NOT_FOUND'});
  });

  it.each([0.1, 0.15, 0.3])(
    '長い紙が写真の端で %s 切れていたら測らない（TOUCHES_EDGE。短いと誤らない）',
    cut => {
      const long = SHORT * 3.55;
      const r = measureNoshiSize(
        photo([{cx: 1600 - long / 2 + long * cut, cy: 600, short: SHORT, long}]),
        'image/jpeg'
      );
      expect(r).toMatchObject({size: null, reason: 'TOUCHES_EDGE'});
    }
  );

  it('白い箱・明るい台の上に置いたら測らない（BACKGROUND_TOO_BRIGHT）', () => {
    const onBox = measureNoshiSize(
      photo([
        {cx: 800, cy: 600, short: 900, long: 1100},
        {cx: 800, cy: 600, short: 200, long: 200 * 3.55, marks: true},
      ]),
      'image/jpeg'
    );
    expect(onBox).toMatchObject({size: null, reason: 'BACKGROUND_TOO_BRIGHT'});
    const brightTable = measureNoshiSize(
      photo([{cx: 800, cy: 600, short: SHORT, long: SHORT * 3.55}], 1600, 1200, [230, 230, 228]),
      'image/jpeg'
    );
    expect(brightTable.size).toBeNull();
  });

  it('斜めから撮って台形に写った紙は測らない（長方形度が足りない）', () => {
    const r = measureNoshiSize(
      photo([{cx: 800, cy: 600, short: SHORT, long: SHORT * 2.95, taper: 0.15}]),
      'image/jpeg'
    );
    expect(r.size).toBeNull();
  });

  it('寸法の分かっている大きすぎる画像は復号しない（TOO_LARGE）', () => {
    expect(
      measureNoshiSize(Buffer.from([0xff, 0xd8]), 'image/jpeg', {width: 4032, height: 3024})
    ).toMatchObject({size: null, reason: 'TOO_LARGE'});
  });

  it('候補ごとの値（縦横比・長方形度・面積比・縁）を記録用に返す', () => {
    const r = measureNoshiSize(
      photo([{cx: 800, cy: 600, short: SHORT, long: SHORT * 3.55}]),
      'image/jpeg'
    );
    expect(r.candidates[0]).toMatchObject({touchesEdge: false});
    expect(r.candidates[0]?.rectangularity).toBeGreaterThan(0.95);
  });

  it('色の付いた紙（メッセージカード等）は白い紙として数えない', () => {
    const r = measureNoshiSize(
      photo([{cx: 800, cy: 600, short: SHORT, long: SHORT * 3.55, rgb: [160, 214, 216]}]),
      'image/jpeg'
    );
    expect(r).toMatchObject({size: null, reason: 'NOT_FOUND'});
  });

  it('JPEG 以外は判定しない（UNSUPPORTED_FORMAT）', () => {
    expect(measureNoshiSize(Buffer.from('png'), 'image/png')).toMatchObject({
      size: null,
      reason: 'UNSUPPORTED_FORMAT',
    });
  });

  it('壊れた JPEG は例外になる（呼び出し側でログに残し「判定できず」にする）', () => {
    expect(() => measureNoshiSize(Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg')).toThrow();
  });
});
