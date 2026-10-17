/**
 * のし紙の長短の計測（参考判定。#55、要件定義書 5-2）。
 * 長短2サイズは高さが共通で長さだけが違うため、のし紙（白い長方形）の輪郭を検出し、
 * 最小外接長方形の縦横比（長辺÷短辺）で見分ける。AI は使わない。
 *
 * 判定できないとき（のし紙が見つからない・複数ある・境目に近い・JPEG 以外）は size = null を返す。
 * 「判定できず」は参考判定の警告になるだけで、主判定（OK/NG）には影響しない。
 */
import jpeg from 'jpeg-js';

import type {NoshiSize} from '@gift-inspector/shared';

/** 2026/10/16 の受領写真の測定: 長い 3.51〜3.58、短い 2.89〜3.01。この間は判定しない */
export const LONG_MIN_RATIO = 3.35;
export const SHORT_MAX_RATIO = 3.15;
/** のし紙とみなす縦横比の範囲（取扱説明書・カードなど縦横比の小さい白い紙を除く） */
const CANDIDATE_RATIO = {min: 2.5, max: 4.2};
/** 外接長方形をどれだけ埋めていれば長方形とみなすか（くっついた紙・影を除く） */
const MIN_RECTANGULARITY = 0.9;
/** 画像全体に対する面積の下限（細かいゴミを除く） */
const MIN_AREA_FRACTION = 0.01;
/** 計測に使う画像の長辺（縮小してから処理する） */
const WORK_LONG_EDGE = 800;
/** 白い紙とみなす画素: 明るさ（0〜255）の下限と、彩度（0〜1）の上限 */
const WHITE = {minValue: 175, maxSaturation: 0.24};

export type NoshiSizeReason =
  'MEASURED' | 'BORDERLINE' | 'NOT_FOUND' | 'MULTIPLE' | 'UNSUPPORTED_FORMAT';

export interface NoshiSizeMeasurement {
  /** 判定できたときだけ入る */
  size: NoshiSize | null;
  /** のし紙が1枚だけ見つかったときの縦横比（長辺÷短辺） */
  ratio: number | null;
  reason: NoshiSizeReason;
  /** 見つかった候補の数（記録・調整用） */
  candidates: number;
}

export function measureNoshiSize(image: Buffer, mime: string): NoshiSizeMeasurement {
  if (mime !== 'image/jpeg') {
    return {size: null, ratio: null, reason: 'UNSUPPORTED_FORMAT', candidates: 0};
  }
  const decoded = jpeg.decode(image, {
    useTArray: true,
    maxResolutionInMP: 40,
    maxMemoryUsageInMB: 256,
  });
  const {mask, width, height} = whiteMask(decoded.data, decoded.width, decoded.height);
  const cleaned = close(open(mask, width, height, 2), width, height, 3);
  const ratios = components(cleaned, width, height)
    .filter(c => c.area >= width * height * MIN_AREA_FRACTION)
    .map(c => minAreaRect(c.boundary, c.area))
    .filter(
      r =>
        r.rectangularity >= MIN_RECTANGULARITY &&
        r.ratio >= CANDIDATE_RATIO.min &&
        r.ratio <= CANDIDATE_RATIO.max
    )
    .map(r => r.ratio);

  if (ratios.length === 0) return {size: null, ratio: null, reason: 'NOT_FOUND', candidates: 0};
  if (ratios.length > 1) {
    return {size: null, ratio: null, reason: 'MULTIPLE', candidates: ratios.length};
  }
  const ratio = Math.round((ratios[0] as number) * 1000) / 1000;
  if (ratio >= LONG_MIN_RATIO) return {size: '長い', ratio, reason: 'MEASURED', candidates: 1};
  if (ratio <= SHORT_MAX_RATIO) return {size: '短い', ratio, reason: 'MEASURED', candidates: 1};
  return {size: null, ratio, reason: 'BORDERLINE', candidates: 1};
}

/** 縮小しながら白い紙の画素を 1 にした二値画像を作る */
function whiteMask(rgba: Uint8Array, srcW: number, srcH: number) {
  const scale = Math.min(1, WORK_LONG_EDGE / Math.max(srcW, srcH));
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(srcH - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x / scale));
      const i = (sy * srcW + sx) * 4;
      const r = rgba[i] as number;
      const g = rgba[i + 1] as number;
      const b = rgba[i + 2] as number;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      if (max >= WHITE.minValue && saturation <= WHITE.maxSaturation) mask[y * width + x] = 1;
    }
  }
  return {mask, width, height};
}

/** 正方形の窓（半径 r）での最小値・最大値（分離して横→縦の順に処理する） */
function morph(src: Uint8Array, w: number, h: number, r: number, erode: boolean): Uint8Array {
  const pick = erode ? Math.min : Math.max;
  // 画像の外は背景（0）として扱う
  const outside = 0;
  const tmp = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        v = pick(v, xx < 0 || xx >= w ? outside : (src[y * w + xx] as number));
      }
      tmp[y * w + x] = v;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        v = pick(v, yy < 0 || yy >= h ? outside : (tmp[yy * w + x] as number));
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

/** 小さな白い点を消す */
function open(m: Uint8Array, w: number, h: number, r: number) {
  return morph(morph(m, w, h, r, true), w, h, r, false);
}

/** 紙の上の文字・水引などの小さな穴を埋める */
function close(m: Uint8Array, w: number, h: number, r: number) {
  return morph(morph(m, w, h, r, false), w, h, r, true);
}

interface Component {
  area: number;
  /** 輪郭の画素（隣に背景がある画素）の座標 */
  boundary: [number, number][];
}

/** 4近傍の連結成分 */
function components(m: Uint8Array, w: number, h: number): Component[] {
  const label = new Int32Array(w * h);
  const result: Component[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < m.length; start++) {
    if (m[start] !== 1 || label[start] !== 0) continue;
    next++;
    label[start] = next;
    stack.push(start);
    let area = 0;
    const boundary: [number, number][] = [];
    while (stack.length > 0) {
      const p = stack.pop() as number;
      area++;
      const x = p % w;
      const y = (p - x) / w;
      let edge = false;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) {
          edge = true;
          continue;
        }
        const q = ny * w + nx;
        if (m[q] !== 1) {
          edge = true;
          continue;
        }
        if (label[q] === 0) {
          label[q] = next;
          stack.push(q);
        }
      }
      if (edge) boundary.push([x, y]);
    }
    result.push({area, boundary});
  }
  return result;
}

/** 凸包（Andrew の単調鎖） */
function convexHull(points: [number, number][]): [number, number][] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower.at(-2)!, lower.at(-1)!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of pts.reverse()) {
    while (upper.length >= 2 && cross(upper.at(-2)!, upper.at(-1)!, p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * 最小外接長方形（凸包の各辺の向きで投影して面積が最小になるもの）。
 * 画素の中心座標なので、各辺に 1 画素ぶんを足して面積・縦横比を求める。
 */
function minAreaRect(boundary: [number, number][], area: number) {
  const hull = convexHull(boundary);
  let best = {w: 0, h: 0, rectArea: Number.POSITIVE_INFINITY};
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i] as [number, number];
    const b = hull[(i + 1) % hull.length] as [number, number];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    const ux = (b[0] - a[0]) / len;
    const uy = (b[1] - a[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      minU = Math.min(minU, u);
      maxU = Math.max(maxU, u);
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
    }
    const w = maxU - minU + 1;
    const h = maxV - minV + 1;
    if (w * h < best.rectArea) best = {w, h, rectArea: w * h};
  }
  const long = Math.max(best.w, best.h);
  const short = Math.min(best.w, best.h);
  return {
    ratio: short > 0 ? long / short : 0,
    rectangularity: best.rectArea > 0 ? area / best.rectArea : 0,
  };
}
