import { Plugin, TFile, WorkspaceLeaf, requestUrl } from 'obsidian';
import { setupAutoUpdate } from './updater';
import { TextCoverSettingTab, DEFAULT_SETTINGS, type TextCoverSettings } from './settings';

// ── Selectors (confirmed from DOM snapshot, Obsidian 1.8–1.9) ─────────────────
const LEAF_TYPE = 'bases';
const LEAF_DATA_TYPE_ATTR = '[data-type="bases"]';

const CARD_SELECTORS = ['.bases-cards-item', '.bases-card-item'];
const COVER_SELECTORS = ['.bases-cards-cover', '.bases-card-cover'];

const COVER_CLASS = 'tcg-cover';

const IMAGE_PROPERTY_KEYS = ['banner', 'cover', 'image', 'coverUrl'];
// Book Search Plus also writes these alongside `coverUrl`. They're never used
// as the display property itself, but they're a useful fallback source URL
// when the primary property has gone stale (see downloadRemoteCovers below).
const ALT_SOURCE_KEYS = ['coverSmallUrl', 'coverMediumUrl', 'coverLargeUrl'];

// Bump this if `_extractText`'s logic changes in a way that makes previously
// cached text wrong even though the settings fingerprint didn't change.
const CACHE_SCHEMA_VERSION = 1;

// ~128px thumbnails and "image not available" placeholders are a few KB;
// real covers are much bigger.
const MIN_GOOD_BYTES = 15000;

interface CacheEntry {
  text: string | null; // null = definitively no text (was in _noText)
  mtime: number;
}

interface PersistedCache {
  fingerprint: string;
  entries: Record<string, CacheEntry>;
}

interface PersistedData {
  settings: TextCoverSettings;
  cache?: PersistedCache;
}

export default class TextCoverPlugin extends Plugin {
  settings!: TextCoverSettings;

  // ── Cache: file path → cover text, persisted to disk between sessions ─────
  private _cache    = new Map<string, string>();   // path → text
  private _noText   = new Set<string>();           // paths where text is definitively absent
  private _mtimes   = new Map<string, number>();   // path → mtime as of last extraction
  private _nameIdx  = new Map<string, string>();   // display name → path

  private _observer!: MutationObserver;
  private _debounce: ReturnType<typeof setTimeout> | null = null;
  private _cacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private _rebuildDebounce: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  async onload() {
    setupAutoUpdate(this, 'VeryRandomness/obsidian-text-cover-generator');
    await this.loadSettings();
    this.addSettingTab(new TextCoverSettingTab(this.app, this));

    // Keep cache fresh. Only metadataCache 'changed' is used for edits: vault
    // 'modify' fires *before* frontmatter is re-parsed, so extracting there
    // cached stale text under the new mtime, and the fast path then skipped
    // the correct re-extraction when 'changed' arrived. 'changed' is the
    // authoritative signal, so it always forces a re-extract.
    this.registerEvent(this.app.metadataCache.on('changed', (f) => this._refreshFile(f, true)));
    this.registerEvent(this.app.vault.on('delete',  (f) => {
      if (f instanceof TFile) {
        this._cache.delete(f.path);
        this._noText.delete(f.path);
        this._mtimes.delete(f.path);
        this._scheduleCacheSave();
      }
    }));
    this.registerEvent(this.app.vault.on('rename',  (f, old) => {
      this._cache.delete(old);
      this._noText.delete(old);
      this._mtimes.delete(old);
      if (f instanceof TFile) this._refreshFile(f);
    }));

    // DOM observer
    this._observer = new MutationObserver(() => this._schedule());
    this._observer.observe(document.body, { childList: true, subtree: true });
    this.registerEvent(this.app.workspace.on('layout-change',     () => this._schedule()));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this._schedule()));

    // Reuse whatever we saved last session — entries whose mtime still matches
    // the file on disk are trusted as-is, so a cold start only re-extracts
    // text for notes that are new or actually changed since we last saved.
    // If the settings that affect extraction changed (fingerprint mismatch,
    // e.g. synced in from another device while this one was closed), the
    // persisted cache is discarded here and _buildAll below recomputes it all.
    const warmStart = this._hydrateFromDisk();

    // Hydrated covers can render immediately; the refresh pass waits until the
    // metadata cache is usable, otherwise frontmatter reads come back empty and
    // wrong text (or "no text") gets cached against the file's current mtime.
    this.app.workspace.onLayoutReady(() => {
      this._buildAll().then(() => {
        this._log(`Cache ready (${warmStart ? 'warm' : 'cold'} start) — ${this._cache.size} covers, ${this._nameIdx.size} names indexed.`);
        this.resetAndProcess();
      });
    });
    // Picks up any files skipped above because their metadata wasn't indexed yet
    // (cheap: unchanged files hit the mtime fast path).
    this.registerEvent(this.app.metadataCache.on('resolved', () => { void this._buildAll(); }));

    this._schedule();
    this._log('Text Cover Generator loaded.');
  }

  onunload() {
    this._observer.disconnect();
    if (this._debounce) clearTimeout(this._debounce);
    if (this._rebuildDebounce) clearTimeout(this._rebuildDebounce);
    if (this._cacheSaveTimer) {
      clearTimeout(this._cacheSaveTimer);
      void this._persist();
    }
  }

  // ── Public (called from settings tab) ────────────────────────────────────────

  async buildCache() {
    this._cache.clear();
    this._noText.clear();
    this._mtimes.clear();
    this._nameIdx.clear();
    await this._buildAll();
    this._log(`Rebuilt — ${this._cache.size} covers.`);
    this.resetAndProcess();
    await this._persist();
  }

  /** Debounced full rebuild, for settings whose changes invalidate cached text. */
  scheduleContentRebuild() {
    if (this._rebuildDebounce) clearTimeout(this._rebuildDebounce);
    this._rebuildDebounce = setTimeout(() => {
      this._rebuildDebounce = null;
      void this.buildCache();
    }, 800);
  }

  get cacheSize() { return this._cache.size; }

  logDomSnapshot() {
    const leaves = this._getBaseLeaves();
    if (!leaves.length) { console.info('[TCG] No Base views found.'); return; }
    for (const leaf of leaves) {
      const el = (leaf.view as any)?.containerEl as HTMLElement | undefined;
      if (el) console.info('[TCG] Base view DOM:', el.innerHTML.slice(0, 8000));
    }
  }

  resetAndProcess() {
    // Remove all our injected covers so they get re-evaluated
    document.querySelectorAll(`.${COVER_CLASS}`).forEach((el) => el.remove());
    this._processAll();
  }

  // ── Cache building ────────────────────────────────────────────────────────────

  private async _buildAll() {
    const files = this.app.vault.getMarkdownFiles();
    this._log(`Building cache for ${files.length} files…`);
    for (const file of files) {
      await this._refreshFile(file);
    }
    this._pruneStale(new Set(files.map((f) => f.path)));
  }

  /** Drop cache/mtime entries for notes that vanished while we weren't looking. */
  private _pruneStale(validPaths: Set<string>) {
    let pruned = 0;
    for (const path of this._mtimes.keys()) {
      if (!validPaths.has(path)) {
        this._mtimes.delete(path);
        this._cache.delete(path);
        this._noText.delete(path);
        pruned++;
      }
    }
    if (pruned) this._scheduleCacheSave();
  }

  private async _refreshFile(file: TFile, force = false) {
    if (file.extension !== 'md') return;

    // Update name index
    this._nameIdx.set(file.basename, file.path);
    const meta = this.app.metadataCache.getFileCache(file);
    const fmTitle = meta?.frontmatter?.['title'];
    if (fmTitle) this._nameIdx.set(String(fmTitle), file.path);

    // Fast path: mtime unchanged since we last extracted text for this file
    // (whether that was this session or hydrated from disk) — nothing to do.
    const mtime = file.stat.mtime;
    if (!force && this._mtimes.get(file.path) === mtime && (this._cache.has(file.path) || this._noText.has(file.path))) {
      return;
    }

    // Metadata not indexed yet — extracting now would miss frontmatter and
    // cache the wrong answer. Leave any existing entry alone; 'changed' or
    // 'resolved' will bring us back here once it's parsed.
    if (!meta) return;

    // Update cover text cache
    const prev = this._cache.get(file.path) ?? null;
    const text = await this._extractText(file);
    this._mtimes.set(file.path, mtime);
    if (text) {
      this._cache.set(file.path, text);
      this._noText.delete(file.path);
    } else {
      this._cache.delete(file.path);
      this._noText.add(file.path);
    }
    this._scheduleCacheSave();

    // Covers already on screen for this note are skipped by _processCard (same
    // path), so drop them to let the next pass redraw with the new text/image.
    if (force || prev !== (text || null)) {
      document.querySelectorAll<HTMLElement>(`.${COVER_CLASS}`).forEach((el) => {
        if (el.dataset['tcgPath'] === file.path) el.remove();
      });
      this._schedule();
    }
  }

  // ── Core processing ───────────────────────────────────────────────────────────

  private _schedule() {
    if (this._debounce) clearTimeout(this._debounce);
    this._debounce = setTimeout(() => this._processAll(), 300);
  }

  private _getBaseLeaves(): WorkspaceLeaf[] {
    const leaves: WorkspaceLeaf[] = [];
    try { leaves.push(...this.app.workspace.getLeavesOfType(LEAF_TYPE)); } catch {}
    return leaves;
  }

  private _processAll() {
    for (const leaf of this._getBaseLeaves()) {
      const el = (leaf.view as any)?.containerEl as HTMLElement | undefined;
      if (el) this._processContainer(el);
    }
    document.querySelectorAll<HTMLElement>(LEAF_DATA_TYPE_ATTR + ' .view-content')
      .forEach((el) => this._processContainer(el));
  }

  private _processContainer(container: HTMLElement) {
    const cards = this._findCards(container);
    this._log(`Processing ${cards.length} cards.`);
    for (const card of cards) this._processCard(card);
  }

  private _findCards(root: HTMLElement): HTMLElement[] {
    for (const sel of CARD_SELECTORS) {
      const found = Array.from(root.querySelectorAll<HTMLElement>(sel));
      if (found.length) return found;
    }
    return [];
  }

  private _processCard(card: HTMLElement) {
    // Skip the hidden virtual-scroll placeholder group
    const group = card.closest<HTMLElement>('.bases-cards-group');
    if (group && (group.style.opacity === '0' || group.style.pointerEvents === 'none')) return;

    const coverEl = this._findCover(card);
    if (!coverEl) return;

    // Resolve which note this card represents
    const path = this._resolveNotePath(card);
    if (!path) return; // title not rendered yet — MutationObserver will retry

    // Check for virtual-scroll reuse: if we already injected for THIS path, done
    const existing = coverEl.querySelector<HTMLElement>(`.${COVER_CLASS}`);
    if (existing?.dataset['tcgPath'] === path) return;

    // Remove stale cover from a recycled card element
    if (existing) existing.remove();

    // ── Vault-based image check ──────────────────────────────────────────────
    // Look at the note's 'banner' (or any 'image') frontmatter property and
    // confirm the file actually exists in the vault before skipping.
    if (this._noteHasValidImage(path)) return;

    // Skip if we already know there is no text for this note
    if (this._noText.has(path)) return;

    const text = this._cache.get(path);
    if (!text) return; // cache not warm yet — will retry after buildAll finishes

    const file = this.app.vault.getFileByPath(path);
    if (!(file instanceof TFile)) return;

    this._inject(coverEl, text, file, path);
  }

  // ── Vault-based image check ───────────────────────────────────────────────────
  // Returns true if the note has a banner/image property pointing to a file that
  // actually exists in the vault. Does NOT rely on DOM backgroundImage at all.
  private _noteHasValidImage(notePath: string): boolean {
    const file = this.app.vault.getFileByPath(notePath);
    if (!(file instanceof TFile)) return false;

    const meta = this.app.metadataCache.getFileCache(file);
    if (!meta?.frontmatter) return false;

    // Check common image-property names used by Bases / Pixel Banner
    for (const key of IMAGE_PROPERTY_KEYS) {
      const val = meta.frontmatter[key];
      if (!val) continue;
      const imgFile = this.app.metadataCache.getFirstLinkpathDest(String(val), notePath);
      if (imgFile) return true; // file exists → real image
    }

    return false;
  }

  // ── Remote cover download (called from settings tab) ─────────────────────────
  // Notes whose cover/banner/image property is a remote http(s) URL (e.g. Google
  // Books links from Book Search Plus) never resolve as a "valid image" above,
  // and Obsidian's Bases card view can fail to load them at all (CORS, mixed
  // content). Downloading them into the vault and repointing frontmatter at the
  // local file fixes both: it's now a same-origin resource with no CORS involved.
  async downloadRemoteCovers(onProgress?: (done: number, total: number) => void): Promise<number> {
    const files = this.app.vault.getMarkdownFiles();
    const targets: { file: TFile; key: string; url: string; fm: Record<string, unknown>; upgrade?: TFile }[] = [];

    for (const file of files) {
      const meta = this.app.metadataCache.getFileCache(file);
      const fm = meta?.frontmatter;
      if (!fm) continue;

      // Case 1: the display property itself still holds a live remote URL.
      let foundLiveUrl = false;
      for (const key of IMAGE_PROPERTY_KEYS) {
        const val = fm[key];
        if (typeof val !== 'string' || !/^https?:\/\//i.test(val)) continue;
        targets.push({ file, key, url: val, fm });
        foundLiveUrl = true;
      }
      if (foundLiveUrl) continue;

      // Case 2: the display property has a *local* value but the file behind
      // it doesn't actually exist (e.g. a previous download attempt failed
      // partway, or was later removed). Recover a source URL from Book Search
      // Plus's other cover fields, which are never overwritten by our own
      // download step and often still hold the original remote link.
      let brokenKey: string | null = null;
      let weakFile: { key: string; file: TFile } | null = null;
      for (const key of IMAGE_PROPERTY_KEYS) {
        const val = fm[key];
        if (typeof val !== 'string' || !val) continue;
        const dest = this.app.metadataCache.getFirstLinkpathDest(val, file.path);
        if (!dest) {
          brokenKey = key;
          break;
        }
        // Case 3: the file exists but is a thumbnail/placeholder from an earlier
        // download. Retry it so a better source can replace it.
        if (dest.stat.size < MIN_GOOD_BYTES && !weakFile) weakFile = { key, file: dest };
      }

      const altUrl = ALT_SOURCE_KEYS.map((k) => fm[k]).find((v) => typeof v === 'string' && /^https?:\/\//i.test(v)) as string | undefined;
      if (brokenKey) {
        if (altUrl) targets.push({ file, key: brokenKey, url: altUrl, fm });
      } else if (weakFile && (altUrl || isbnOf(fm))) {
        targets.push({ file, key: weakFile.key, url: altUrl ?? '', fm, upgrade: weakFile.file });
      }
    }

    if (targets.length === 0) return 0;

    const folder = this.settings.coversFolder || 'Covers';
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.createFolder(folder);
    }

    let done = 0;
    for (const { file, key, url, fm, upgrade } of targets) {
      try {
        const localPath = await this._downloadCover(file, url, fm, upgrade);
        if (!localPath) {
          this._log(`No better cover found for "${file.basename}"`);
        } else {
          await this.app.fileManager.processFrontMatter(file, (f) => {
            f[key] = localPath;
          });
          this._log(`Downloaded cover for "${file.basename}" → ${localPath}`);
          done++;
        }
      } catch (e) {
        this._log(`Failed to download cover for "${file.basename}": ${(e as Error).message}`);
      }
      onProgress?.(done, targets.length);
    }

    this.resetAndProcess();
    return done;
  }

  private async _downloadCover(file: TFile, url: string, fm: Record<string, unknown>, upgrade?: TFile): Promise<string | null> {
    const res = await this._fetchBestCoverResponse(url, fm);

    if (upgrade) {
      // Only replace the existing file if the new image is clearly bigger.
      if (res.arrayBuffer.byteLength <= upgrade.stat.size * 1.5) return null;
      await this.app.vault.modifyBinary(upgrade, res.arrayBuffer);
      return upgrade.path;
    }

    const folder = this.settings.coversFolder || 'Covers';
    const ext = extensionFromContentType(res.headers['content-type']) ?? extensionFromUrl(url) ?? '.jpg';
    const name = sanitizeFilename(file.basename) + ext;
    let path = `${folder}/${name}`;

    // Don't clobber an existing different cover file.
    let i = 2;
    while (await this.app.vault.adapter.exists(path)) {
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        const existingData = await this.app.vault.readBinary(existing);
        if (arrayBuffersEqual(existingData, res.arrayBuffer)) return path; // already downloaded
      }
      path = `${folder}/${sanitizeFilename(file.basename)}-${i}${ext}`;
      i++;
    }

    await this.app.vault.createBinary(path, res.arrayBuffer);
    return path;
  }

  // Google Books' API-provided thumbnail URL (zoom=1) is a ~128px-wide postage
  // stamp. The same /books/content endpoint serves much larger images if you
  // ask for a different zoom level directly — confirmed live: zoom=0 typically
  // returns ~1800x2700 vs. ~128x193 for zoom=1. Some volumes only have a real
  // image at certain zoom levels, so we try a few and keep the largest valid one.
  private async _fetchBestCoverResponse(url: string, fm: Record<string, unknown> = {}) {
    type Res = Awaited<ReturnType<typeof requestUrl>>;
    let best: Res | null = null;
    const consider = (res: Res | null): res is Res => {
      if (!res) return false;
      if (!best || res.arrayBuffer.byteLength > best.arrayBuffer.byteLength) best = res;
      return res.arrayBuffer.byteLength >= MIN_GOOD_BYTES;
    };
    const tryGet = async (u: string): Promise<Res | null> => {
      try {
        const r = await requestUrl({ url: u });
        return /image\//i.test(r.headers['content-type'] ?? 'image/') ? r : null;
      } catch {
        return null; // not available — try the next source
      }
    };

    const parsed = url ? tryParseUrl(url) : null;
    const isGoogleBooksContent =
      parsed && /(^|\.)books\.google\.[a-z.]+$/i.test(parsed.hostname) && parsed.pathname.includes('/books/content');
    const id = parsed?.searchParams.get('id');

    if (parsed && !isGoogleBooksContent) {
      if (consider(await tryGet(url.replace(/^http:\/\//i, 'https://')))) return best!;
    }

    // 1. Google Books direct zoom levels (zoom=1 is a ~128px thumbnail; zoom=0
    //    is usually ~1800px). Some volumes only have a real image at some levels.
    if (isGoogleBooksContent && id) {
      const printsec = parsed!.searchParams.get('printsec') ?? 'frontcover';
      for (const zoom of [0, 3, 2, 1]) {
        const candidate =
          `https://books.google.com/books/content?id=${encodeURIComponent(id)}` +
          `&printsec=${encodeURIComponent(printsec)}&img=1&zoom=${zoom}&source=gbs_api`;
        if (consider(await tryGet(candidate))) return best!;
      }
    }

    // 2. Open Library by ISBN — often a full-size scan when Google has none.
    for (const isbn of isbnsOf(fm)) {
      if (consider(await tryGet(`https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`))) return best!;
    }

    // 3. Google Books by ISBN lookup, taking the largest imageLink offered.
    for (const isbn of isbnsOf(fm)) {
      try {
        const r = await requestUrl({ url: `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}` });
        const links = r.json?.items?.[0]?.volumeInfo?.imageLinks;
        const link: string | undefined = links?.extraLarge ?? links?.large ?? links?.medium;
        if (link && consider(await tryGet(link.replace(/^http:\/\//i, 'https://').replace(/&edge=curl/, '')))) return best!;
      } catch { /* no result */ }
    }

    if (best) return best as Res;
    if (parsed) return requestUrl({ url: parsed.toString().replace(/^http:\/\//i, 'https://') });
    throw new Error('no cover source available');
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private _findCover(card: HTMLElement): HTMLElement | null {
    for (const sel of COVER_SELECTORS) {
      const el = card.querySelector<HTMLElement>(sel);
      if (el) return el;
    }
    return null;
  }

  private _resolveNotePath(card: HTMLElement): string | null {
    // 1. data-path attribute
    if (card.dataset['path']) return card.dataset['path'];

    // 2. All .bases-cards-line elements → look up in pre-built name index
    for (const line of card.querySelectorAll<HTMLElement>('.bases-cards-line')) {
      const name = line.textContent?.trim();
      if (name && this._nameIdx.has(name)) return this._nameIdx.get(name)!;
    }

    // 3. Internal link href
    for (const link of card.querySelectorAll<HTMLAnchorElement>('a[data-href], a.internal-link')) {
      const href = link.dataset['href'] ?? link.getAttribute('href');
      if (href && !href.startsWith('http')) {
        const f = this.app.metadataCache.getFirstLinkpathDest(href, '');
        if (f) return f.path;
      }
    }

    return null;
  }

  private async _extractText(file: TFile): Promise<string | null> {
    const meta = this.app.metadataCache.getFileCache(file);

    // Explicit frontmatter property wins
    const prop = meta?.frontmatter?.[this.settings.contentProperty];
    if (prop != null) return String(prop);

    // File title mode
    if (this.settings.defaultToTitle) {
      return meta?.frontmatter?.['title'] ?? file.basename;
    }

    if (!this.settings.fallbackToBody) return null;

    const raw = await this.app.vault.cachedRead(file);
    const body = raw.replace(/^---[\s\S]*?---\s*\n/, '');

    // Collect all blockquote lines and join them (handles multi-line quotes)
    const bqLines = [...body.matchAll(/^>\s*(.+)$/gm)].map(m => m[1].trim());
    if (bqLines.length) {
      // Strip surrounding curly/straight quotes
      const joined = bqLines.join(' ').replace(/^["""]+|["""]+$/g, '').trim();
      if (joined) return joined;
    }

    // First non-heading, non-empty paragraph
    const para = body.match(/^(?![#\->])(\S.+)/m);
    if (para?.[1]) return para[1].trim();

    return null;
  }

  private _inject(coverEl: HTMLElement, text: string, file: TFile, path: string) {
    const meta = this.app.metadataCache.getFileCache(file);
    const fm = meta?.frontmatter ?? {};

    const bg: string    = fm['textCoverBg']    ?? this.settings.defaultBg;
    const color: string = fm['textCoverColor'] ?? this.settings.defaultColor;

    const truncated = text.length > this.settings.maxChars
      ? text.slice(0, this.settings.maxChars).trimEnd() + '…'
      : text;

    coverEl.innerHTML = '';

    const div = document.createElement('div');
    div.className = COVER_CLASS;
    div.dataset['tcgPath'] = path; // for virtual-scroll reuse detection
    div.setAttribute('aria-label', truncated);
    if (this.settings.showQuoteMark) div.dataset['quotemark'] = '1';

    div.style.cssText = [
      `background:${bg}`,
      `color:${color}`,
      `font-size:${this.settings.fontSize}`,
      `padding:${this.settings.padding}`,
    ].join(';');

    div.textContent = truncated;
    coverEl.appendChild(div);

    this._log(`Injected cover for "${file.basename}": "${truncated.slice(0, 50)}"`);
  }

  // ── Persistence (settings + cache share one data.json) ───────────────────────

  private _persistedCache?: PersistedCache;

  /** Identifies which cached-text extraction rules produced the persisted cache. */
  private _fingerprint(): string {
    return JSON.stringify({
      v: CACHE_SCHEMA_VERSION,
      contentProperty: this.settings.contentProperty,
      defaultToTitle: this.settings.defaultToTitle,
      fallbackToBody: this.settings.fallbackToBody,
    });
  }

  /**
   * Loads whatever was persisted last session into the live maps, but only if
   * it was built under the same settings we're running with now. Returns
   * false (and leaves the maps empty) on a fingerprint mismatch or first run,
   * which makes the following _buildAll() do a full recompute — exactly like
   * clicking "Rebuild now", but automatic.
   */
  private _hydrateFromDisk(): boolean {
    const persisted = this._persistedCache;
    if (!persisted || persisted.fingerprint !== this._fingerprint()) return false;

    for (const [path, entry] of Object.entries(persisted.entries)) {
      this._mtimes.set(path, entry.mtime);
      if (entry.text != null) this._cache.set(path, entry.text);
      else this._noText.add(path);
    }
    return true;
  }

  private _scheduleCacheSave() {
    if (this._cacheSaveTimer) clearTimeout(this._cacheSaveTimer);
    this._cacheSaveTimer = setTimeout(() => {
      this._cacheSaveTimer = null;
      void this._persist();
    }, 2000);
  }

  private async _persist() {
    const entries: Record<string, CacheEntry> = {};
    for (const [path, mtime] of this._mtimes) {
      entries[path] = { text: this._cache.get(path) ?? null, mtime };
    }
    const data: PersistedData = {
      settings: this.settings,
      cache: { fingerprint: this._fingerprint(), entries },
    };
    await this.saveData(data);
  }

  // ── Settings ──────────────────────────────────────────────────────────────────

  async loadSettings() {
    const raw = await this.loadData();
    if (raw && typeof raw === 'object' && 'settings' in raw) {
      const data = raw as PersistedData;
      this.settings = Object.assign({}, DEFAULT_SETTINGS, data.settings);
      this._persistedCache = data.cache;
    } else {
      // Legacy shape from before cache persistence: the whole file was just
      // the settings object. Migrate it in-place; there's no cache to hydrate.
      this.settings = Object.assign({}, DEFAULT_SETTINGS, raw ?? {});
      this._persistedCache = undefined;
    }
  }

  async saveSettings() {
    await this._persist();
  }

  private _log(...args: unknown[]) {
    if (this.settings.debugMode) console.info('[TCG]', ...args);
  }
}

// ── Free-standing helpers ────────────────────────────────────────────────────

function tryParseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isbnsOf(fm: Record<string, unknown>): string[] {
  return ['isbn13', 'isbn10']
    .map((k) => String(fm[k] ?? '').replace(/[-\s]/g, ''))
    .filter((v) => /^(\d{13}|\d{9}[\dXx])$/.test(v));
}

function isbnOf(fm: Record<string, unknown>): string | undefined {
  return isbnsOf(fm)[0];
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim();
}

function extensionFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/image\/(jpeg|jpg|png|gif|webp)/i);
  if (!match) return null;
  const type = match[1].toLowerCase();
  return type === 'jpeg' ? '.jpg' : `.${type}`;
}

function extensionFromUrl(url: string): string | null {
  const match = url.match(/\.(jpe?g|png|gif|webp)(?:[?#]|$)/i);
  return match ? `.${match[1].toLowerCase()}` : null;
}

function arrayBuffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}
