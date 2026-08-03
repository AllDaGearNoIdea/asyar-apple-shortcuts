/**
 * Renders a shortcut's icon the way Shortcuts.app does: a rounded tile in
 * the user's chosen colour with the white glyph they picked, emitted as an
 * SVG data URI (the launcher renders `data:image` icons through an img tag,
 * same as app icons).
 *
 * Glyph artwork is not bundled — it is read out of the system's own
 * WorkflowGlyphs.ttf at runtime (see glyphFont.ts) and handed in here as
 * path data. Numbers with no artwork fall back to the Shortcuts lozenge,
 * which is also the correct rendering for GLYPH_DEFAULT.
 */

/** "No glyph chosen" — Shortcuts draws its own lozenge mark for this. */
export const GLYPH_DEFAULT = 61440;

/**
 * Colour swatch identifiers, as Shortcuts stores them, mapped to what it
 * actually paints. These are legacy Workflow.app constants: some still
 * decode to their colour as RGBA (yellow, blue), but several were re-skinned
 * without changing the stored number — 255 renders as a blue-grey rather
 * than black, and 4292093695 renders green rather than the gold its bytes
 * spell. Values were measured off a rendered Shortcuts library and
 * converted from Display P3 to sRGB.
 *
 * Anything absent here falls back to reading the number as RGBA, which
 * lands in the right colour family for the swatches not covered above.
 */
const PALETTE: Record<number, string> = {
  4282601983: 'FC6977', // red
  4251333119: 'FF8E6F', // dark orange
  4271458815: 'FBB458', // orange
  4274264319: 'FCCA19', // yellow
  4292093695: '49D665', // green
  3031607807: '9AB4A2', // sage
  1440408063: '00C1FB', // light blue
  463140863: '2493FE', // blue
  946986751: '4D6ED1', // dark blue
  3679049983: 'C883F1', // purple
  3980825855: 'F995E2', // pink
  2846468607: 'B89B7C', // taupe
  255: '909AA6', // grey
};

const LOZENGE =
  '<g fill="#fff">' +
  '<rect x="6.2" y="10.2" width="10" height="10" rx="2.8" transform="rotate(45 11.2 15.2)" opacity="0.55"/>' +
  '<rect x="9.8" y="5.8" width="10" height="10" rx="2.8" transform="rotate(45 14.8 10.8)"/>' +
  '</g>';

export interface ShortcutIconSpec {
  /** Icon background colour as Shortcuts stores it (signed RGBA int). */
  colorValue?: number;
  /** Glyph number as Shortcuts stores it. */
  glyph?: number;
  /** Path data for `glyph`, when the system font gave us artwork for it. */
  glyphPath?: string;
}

/**
 * The colour Shortcuts paints for a stored swatch value, as `RRGGBB`.
 * Values are 32-bit and arrive signed or unsigned depending on how the row
 * was written, so they are normalised before lookup.
 */
export function shortcutTileColor(colorValue: number): string {
  const key = colorValue >>> 0;
  const known = PALETTE[key];
  if (known) return known;
  return ((key >>> 8) & 0xffffff).toString(16).padStart(6, '0');
}

export function shortcutIconDataUri(spec: ShortcutIconSpec): string | undefined {
  if (typeof spec.colorValue !== 'number') return undefined;
  const markup = spec.glyphPath ? `<path d="${spec.glyphPath}" fill="#fff"/>` : LOZENGE;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26">' +
    `<rect width="26" height="26" rx="6" fill="#${shortcutTileColor(spec.colorValue)}"/>` +
    markup +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
