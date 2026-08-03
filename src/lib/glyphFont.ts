/**
 * Reads glyph artwork out of macOS' own Shortcuts glyph font.
 *
 * Shortcuts stores an icon as a colour plus a glyph *number*, and those
 * numbers below 0xF000 are codepoints into
 * `VoiceShortcutClient.framework/Resources/WorkflowGlyphs.ttf` — the font
 * Shortcuts renders its own icons from. Pulling the outlines from there
 * means the artwork is the user's, exactly, and stays correct across OS
 * updates; nothing is bundled or redrawn.
 *
 * Only a TrueType `glyf`/`loca` font with a format 4 cmap is handled,
 * which is what that file is. Anything unexpected throws and the caller
 * falls back to the plain tile.
 */

import type { IShellService } from 'asyar-sdk/contracts';

const FONT_PATH =
  '/System/Library/PrivateFrameworks/VoiceShortcutClient.framework/Versions/A/Resources/WorkflowGlyphs.ttf';

/** Codepoints the font covers. Glyph numbers outside it are not in there. */
export const GLYPH_FONT_RANGE = { min: 0xe000, max: 0xefff } as const;

export function isFontGlyph(glyph: number | undefined): boolean {
  return (
    glyph !== undefined &&
    glyph >= GLYPH_FONT_RANGE.min &&
    glyph <= GLYPH_FONT_RANGE.max
  );
}

/**
 * Read the glyph font off the system. Routed through `/bin/sh` rather than
 * a file-read permission because the SDK's file reads are lossy UTF-8 text,
 * which would corrupt the outlines; base64 survives the trip intact.
 *
 * `fold` re-chunks the payload so it arrives in a few dozen messages rather
 * than a couple of thousand, and the trailing `echo` terminates the last
 * line. Silent because this is plumbing the user never asked for.
 */
export function readGlyphFont(shell: IShellService): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const handle = shell.spawn({
      program: '/bin/sh',
      silent: true,
      args: [
        '-c',
        `{ /usr/bin/base64 -i ${FONT_PATH} | /usr/bin/tr -d '\\n' | /usr/bin/fold -w 8192; echo; }`,
      ],
    });
    const chunks: string[] = [];
    handle.onChunk(({ stream, data }) => {
      if (stream === 'stdout') chunks.push(data);
    });
    handle.onDone((code) => {
      if (code !== 0 && code !== undefined) {
        reject(new Error(`glyph font read exited with code ${code}`));
        return;
      }
      try {
        resolve(decodeFontBase64(chunks));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    handle.onError((err) => reject(new Error(err.message)));
  });
}

/** Side length of the tile the paths are normalised into. */
const BOX = 26;
/** Inset from the tile edge, matching how Shortcuts sizes its glyphs. */
const PAD = 4.5;

interface TableRecord {
  offset: number;
  length: number;
}

type Point = { x: number; y: number; on: boolean };

class Reader {
  private readonly d: DataView;
  constructor(d: DataView) {
    this.d = d;
  }
  u8(o: number): number {
    return this.d.getUint8(o);
  }
  u16(o: number): number {
    return this.d.getUint16(o);
  }
  i16(o: number): number {
    return this.d.getInt16(o);
  }
  u32(o: number): number {
    return this.d.getUint32(o);
  }
  i8(o: number): number {
    return this.d.getInt8(o);
  }
}

/**
 * Decode the base64 the shell produced. Whitespace is stripped rather than
 * assumed absent, so it does not matter whether the chunks arrived line by
 * line or split at arbitrary boundaries.
 */
export function decodeFontBase64(chunks: string[]): Uint8Array {
  const b64 = chunks.join('').replace(/\s+/g, '');
  if (!b64) throw new Error('empty font payload');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * SVG path data for each requested codepoint, normalised to a 26x26 tile.
 * Codepoints the font does not carry are simply absent from the result.
 */
export function extractGlyphPaths(
  font: Uint8Array,
  codepoints: Iterable<number>,
): Record<number, string> {
  const r = new Reader(new DataView(font.buffer, font.byteOffset, font.byteLength));

  const tables = readTableDirectory(r);
  const head = required(tables, 'head');
  const glyf = required(tables, 'glyf');
  const loca = required(tables, 'loca');
  const longLoca = r.i16(head.offset + 50) === 1;

  const cmap = readCmap(r, required(tables, 'cmap'));

  const out: Record<number, string> = {};
  for (const cp of codepoints) {
    const gid = cmap.get(cp);
    if (gid === undefined) continue;
    const contours = readGlyph(r, glyf, loca, longLoca, gid, 0);
    const path = contoursToPath(contours);
    if (path) out[cp] = path;
  }
  return out;
}

function required(tables: Map<string, TableRecord>, tag: string): TableRecord {
  const t = tables.get(tag);
  if (!t) throw new Error(`font is missing the '${tag}' table`);
  return t;
}

function readTableDirectory(r: Reader): Map<string, TableRecord> {
  const numTables = r.u16(4);
  const tables = new Map<string, TableRecord>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(r.u8(rec), r.u8(rec + 1), r.u8(rec + 2), r.u8(rec + 3));
    tables.set(tag, { offset: r.u32(rec + 8), length: r.u32(rec + 12) });
  }
  return tables;
}

/** Codepoint -> glyph id from the Windows BMP (3,1) format 4 subtable. */
function readCmap(r: Reader, cmap: TableRecord): Map<number, number> {
  const n = r.u16(cmap.offset + 2);
  let sub = -1;
  for (let i = 0; i < n; i++) {
    const rec = cmap.offset + 4 + 8 * i;
    const platform = r.u16(rec);
    const encoding = r.u16(rec + 2);
    const off = cmap.offset + r.u32(rec + 4);
    if (r.u16(off) !== 4) continue;
    // (3,1) is the canonical one; (0,3) is an acceptable stand-in.
    if (platform === 3 && encoding === 1) sub = off;
    else if (sub < 0 && platform === 0) sub = off;
  }
  if (sub < 0) throw new Error('font has no usable format 4 cmap subtable');

  const segCountX2 = r.u16(sub + 6);
  const segCount = segCountX2 / 2;
  const endBase = sub + 14;
  const startBase = endBase + segCountX2 + 2;
  const deltaBase = startBase + segCountX2;
  const rangeBase = deltaBase + segCountX2;

  const map = new Map<number, number>();
  for (let s = 0; s < segCount; s++) {
    const end = r.u16(endBase + 2 * s);
    const start = r.u16(startBase + 2 * s);
    if (start === 0xffff) continue;
    const delta = r.i16(deltaBase + 2 * s);
    const rangeOffset = r.u16(rangeBase + 2 * s);
    for (let c = start; c <= end; c++) {
      let gid: number;
      if (rangeOffset === 0) {
        gid = (c + delta) & 0xffff;
      } else {
        gid = r.u16(rangeBase + 2 * s + rangeOffset + 2 * (c - start));
        if (gid !== 0) gid = (gid + delta) & 0xffff;
      }
      if (gid !== 0) map.set(c, gid);
    }
  }
  return map;
}

function glyphRange(
  r: Reader,
  loca: TableRecord,
  longLoca: boolean,
  gid: number,
): [number, number] {
  if (longLoca) {
    return [r.u32(loca.offset + 4 * gid), r.u32(loca.offset + 4 * gid + 4)];
  }
  return [r.u16(loca.offset + 2 * gid) * 2, r.u16(loca.offset + 2 * gid + 2) * 2];
}

function readGlyph(
  r: Reader,
  glyf: TableRecord,
  loca: TableRecord,
  longLoca: boolean,
  gid: number,
  depth: number,
): Point[][] {
  const [start, end] = glyphRange(r, loca, longLoca, gid);
  if (start >= end) return [];
  const g = glyf.offset + start;
  const numContours = r.i16(g);
  if (numContours < 0) {
    // A composite glyph references other glyphs; the depth cap is a
    // cycle guard, not a real limit (the font nests one level at most).
    return depth > 4 ? [] : readComposite(r, glyf, loca, longLoca, g + 10, depth);
  }

  const endPts: number[] = [];
  for (let i = 0; i < numContours; i++) endPts.push(r.u16(g + 10 + 2 * i));
  const pointCount = endPts.length ? endPts[endPts.length - 1] + 1 : 0;

  let p = g + 10 + 2 * numContours;
  p += 2 + r.u16(p); // skip instructions

  const flags: number[] = [];
  while (flags.length < pointCount) {
    const f = r.u8(p++);
    flags.push(f);
    if (f & 8) {
      let repeat = r.u8(p++);
      while (repeat-- > 0 && flags.length < pointCount) flags.push(f);
    }
  }

  const xs: number[] = [];
  let x = 0;
  for (const f of flags) {
    if (f & 2) {
      const dx = r.u8(p++);
      x += f & 16 ? dx : -dx;
    } else if (!(f & 16)) {
      x += r.i16(p);
      p += 2;
    }
    xs.push(x);
  }

  const ys: number[] = [];
  let y = 0;
  for (const f of flags) {
    if (f & 4) {
      const dy = r.u8(p++);
      y += f & 32 ? dy : -dy;
    } else if (!(f & 32)) {
      y += r.i16(p);
      p += 2;
    }
    ys.push(y);
  }

  const contours: Point[][] = [];
  let from = 0;
  for (const e of endPts) {
    const pts: Point[] = [];
    for (let i = from; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: (flags[i] & 1) !== 0 });
    contours.push(pts);
    from = e + 1;
  }
  return contours;
}

function readComposite(
  r: Reader,
  glyf: TableRecord,
  loca: TableRecord,
  longLoca: boolean,
  start: number,
  depth: number,
): Point[][] {
  const out: Point[][] = [];
  let p = start;
  for (;;) {
    const flags = r.u16(p);
    const gid = r.u16(p + 2);
    p += 4;

    let arg1: number;
    let arg2: number;
    if (flags & 1) {
      arg1 = r.i16(p);
      arg2 = r.i16(p + 2);
      p += 4;
    } else {
      arg1 = r.i8(p);
      arg2 = r.i8(p + 1);
      p += 2;
    }

    // F2Dot14 fixed point.
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & 8) {
      a = d = r.i16(p) / 16384;
      p += 2;
    } else if (flags & 0x40) {
      a = r.i16(p) / 16384;
      d = r.i16(p + 2) / 16384;
      p += 4;
    } else if (flags & 0x80) {
      a = r.i16(p) / 16384;
      b = r.i16(p + 2) / 16384;
      c = r.i16(p + 4) / 16384;
      d = r.i16(p + 6) / 16384;
      p += 8;
    }

    // ARGS_ARE_XY_VALUES; point-matching placement is not used by this font.
    const dx = flags & 2 ? arg1 : 0;
    const dy = flags & 2 ? arg2 : 0;

    for (const contour of readGlyph(r, glyf, loca, longLoca, gid, depth + 1)) {
      out.push(
        contour.map((pt) => ({
          x: pt.x * a + pt.y * c + dx,
          y: pt.x * b + pt.y * d + dy,
          on: pt.on,
        })),
      );
    }

    if (!(flags & 0x20)) break;
  }
  return out;
}

/**
 * TrueType quadratic contours to an SVG path, scaled to fit the tile and
 * flipped (font y grows upwards, SVG y grows downwards).
 */
function contoursToPath(contours: Point[][]): string {
  const pts = contours.flat();
  if (pts.length === 0) return '';

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const span = Math.max(w, h);
  if (span <= 0) return '';

  const scale = (BOX - 2 * PAD) / span;
  const ox = (BOX - w * scale) / 2 - minX * scale;
  const oy = (BOX + h * scale) / 2 + minY * scale;
  const tx = (x: number) => round(ox + x * scale);
  const ty = (y: number) => round(oy - y * scale);

  const parts: string[] = [];
  for (const contour of contours) {
    let ring = contour;
    if (ring.length === 0) continue;

    const first = ring.findIndex((p) => p.on);
    if (first < 0) {
      // An all-off-curve ring implies a start point midway between the
      // last and first control points.
      const a = ring[0];
      const b = ring[ring.length - 1];
      ring = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...ring];
    } else {
      ring = ring.slice(first).concat(ring.slice(0, first));
    }

    parts.push(`M${tx(ring[0].x)} ${ty(ring[0].y)}`);
    const n = ring.length;
    let i = 1;
    while (i <= n) {
      const cur = ring[i % n];
      if (cur.on) {
        parts.push(`L${tx(cur.x)} ${ty(cur.y)}`);
        i += 1;
        continue;
      }
      const next = ring[(i + 1) % n];
      // Two consecutive control points imply an on-curve point between them.
      const endX = next.on ? next.x : (cur.x + next.x) / 2;
      const endY = next.on ? next.y : (cur.y + next.y) / 2;
      parts.push(`Q${tx(cur.x)} ${ty(cur.y)} ${tx(endX)} ${ty(endY)}`);
      i += next.on ? 2 : 1;
    }
    parts.push('Z');
  }
  return parts.join('');
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
