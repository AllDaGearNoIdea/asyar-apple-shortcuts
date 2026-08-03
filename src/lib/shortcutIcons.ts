import type {
  IApplicationService,
  ILogService,
  IShellService,
  IStorageService,
} from 'asyar-sdk/contracts';

import { extractGlyphPaths, isFontGlyph, readGlyphFont } from './glyphFont';
import { GLYPH_DEFAULT, shortcutIconDataUri } from './shortcutIcon';
import type { Shortcut } from './shortcutsWorker';

const GLYPH_PATH_CACHE_KEY = 'glyphPaths';

/**
 * A shortcut written on iPhone records the iOS bundle id, which for several
 * of Apple's own apps is not the one the Mac build ships with. Shortcuts.app
 * resolves those to the same app; without this a shortcut built around
 * Safari on iOS shows no icon on a Mac that plainly has Safari.
 *
 * Only Apple ids that genuinely differ across platforms are listed — the
 * many that match (Music, Maps, Reminders, Messages, Podcasts, Freeform)
 * need no entry. Third-party iOS-only apps have no Mac counterpart to find.
 */
const IOS_BUNDLE_ALIASES: Record<string, string> = {
  'com.apple.mobilesafari': 'com.apple.Safari',
  'com.apple.mobilemail': 'com.apple.mail',
  'com.apple.mobilenotes': 'com.apple.Notes',
  'com.apple.mobilecal': 'com.apple.iCal',
  'com.apple.mobileslideshow': 'com.apple.Photos',
  'com.apple.MobileAddressBook': 'com.apple.AddressBook',
  'com.apple.mobiletimer': 'com.apple.clock',
  'com.apple.Preferences': 'com.apple.systempreferences',
};

/** `listApplications()` rows, narrowed to what an icon lookup needs. */
type AppRow = { bundleId?: string; icon?: string };

/**
 * Works out the icon for each shortcut the way Shortcuts.app decides it.
 *
 * In precedence order:
 *   1. an associated app — Shortcuts shows that app's icon, whatever the
 *      glyph says, so a shortcut built around Home or Waze looks like Home
 *      or Waze. Resolved against the launcher's own application index, so
 *      apps installed only on the user's iPhone have nothing to show and
 *      fall through.
 *   2. a glyph the system font carries — drawn from the user's own
 *      WorkflowGlyphs.ttf, so it is the exact artwork they picked.
 *   3. the Shortcuts lozenge on the chosen colour, which is both the
 *      fallback and the correct rendering for GLYPH_DEFAULT.
 *
 * Both lookups are cached: glyph outlines persist in storage so the font is
 * normally never read, and the application index is only re-listed when a
 * bundle id turns up that has not been looked for yet.
 */
export class ShortcutIconResolver {
  private readonly shell: IShellService;
  private readonly storage: IStorageService;
  private readonly application: IApplicationService;
  private readonly logger: ILogService;

  private glyphPaths: Record<number, string> | null = null;
  private appIcons = new Map<string, string>();
  private searchedBundleIds = new Set<string>();
  private loggedMissingGlyphs = new Set<number>();

  constructor(deps: {
    shell: IShellService;
    storage: IStorageService;
    application: IApplicationService;
    logger: ILogService;
  }) {
    this.shell = deps.shell;
    this.storage = deps.storage;
    this.application = deps.application;
    this.logger = deps.logger;
  }

  /** Fill in `icon` on every shortcut in the list, in place. */
  async apply(list: Shortcut[]): Promise<void> {
    await this.ensureGlyphPaths(list);
    await this.ensureAppIcons(list);
    for (const shortcut of list) {
      shortcut.icon = this.iconFor(shortcut);
    }
    this.logMissingGlyphs(list);
  }

  private iconFor(shortcut: Shortcut): string | undefined {
    if (shortcut.appBundleId) {
      const appIcon =
        this.appIcons.get(shortcut.appBundleId) ??
        this.appIcons.get(IOS_BUNDLE_ALIASES[shortcut.appBundleId] ?? '');
      if (appIcon) return appIcon;
    }
    const glyphPath =
      shortcut.glyph !== undefined ? this.glyphPaths?.[shortcut.glyph] : undefined;
    return shortcutIconDataUri({
      colorValue: shortcut.colorValue,
      glyph: shortcut.glyph,
      glyphPath,
    });
  }

  /**
   * Load cached outlines, and read the font only when the list needs a
   * glyph that isn't cached yet. A library the user hasn't changed the
   * icons of therefore costs no subprocess at all.
   */
  private async ensureGlyphPaths(list: Shortcut[]): Promise<void> {
    if (this.glyphPaths === null) {
      this.glyphPaths = await this.loadGlyphCache();
    }
    const missing = new Set<number>();
    for (const s of list) {
      if (isFontGlyph(s.glyph) && this.glyphPaths[s.glyph!] === undefined) {
        missing.add(s.glyph!);
      }
    }
    if (missing.size === 0) return;

    try {
      const font = await readGlyphFont(this.shell);
      const found = extractGlyphPaths(font, missing);
      // Record every requested number, including ones the font turned out
      // not to carry: an empty string is a cached "there is nothing here",
      // which stops the read repeating on every refresh.
      const merged = { ...this.glyphPaths };
      for (const cp of missing) merged[cp] = found[cp] ?? '';
      this.glyphPaths = merged;
      await this.saveGlyphCache(merged);
      this.logger.info(
        `Apple Shortcuts: read ${Object.keys(found).length}/${missing.size} glyphs from the system font`,
      );
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: glyph font read failed: ${describe(err)}`);
    }
  }

  private async ensureAppIcons(list: Shortcut[]): Promise<void> {
    const wanted = new Set<string>();
    for (const s of list) if (s.appBundleId) wanted.add(s.appBundleId);
    if ([...wanted].every((id) => this.searchedBundleIds.has(id))) return;

    try {
      const apps = (await this.application.listApplications()) as AppRow[];
      this.appIcons.clear();
      for (const app of apps) {
        if (app.bundleId && app.icon) this.appIcons.set(app.bundleId, app.icon);
      }
      for (const id of wanted) this.searchedBundleIds.add(id);
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: application index read failed: ${describe(err)}`);
    }
  }

  /**
   * Glyph numbers at or above 0xF000 are not codepoints into the font —
   * Shortcuts resolves those through a table compiled into WorkflowKit — so
   * they render the lozenge. Log each once so they can be identified.
   */
  private logMissingGlyphs(list: Shortcut[]): void {
    const unresolved = new Set<number>();
    for (const s of list) {
      if (s.glyph === undefined || s.glyph === GLYPH_DEFAULT) continue;
      if (this.glyphPaths?.[s.glyph]) continue;
      if (this.loggedMissingGlyphs.has(s.glyph)) continue;
      unresolved.add(s.glyph);
      this.loggedMissingGlyphs.add(s.glyph);
    }
    if (unresolved.size > 0) {
      this.logger.info(
        `Apple Shortcuts: no artwork for glyph ${[...unresolved].join(', ')}; using the lozenge tile`,
      );
    }
  }

  private async loadGlyphCache(): Promise<Record<number, string>> {
    try {
      const raw = await this.storage.get(GLYPH_PATH_CACHE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, string>;
      const out: Record<number, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[Number(k)] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  private async saveGlyphCache(paths: Record<number, string>): Promise<void> {
    try {
      await this.storage.set(GLYPH_PATH_CACHE_KEY, JSON.stringify(paths));
    } catch (err) {
      this.logger.warn(`Apple Shortcuts: glyph cache save failed: ${describe(err)}`);
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
