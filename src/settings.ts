import { App, PluginSettingTab, Setting } from 'obsidian';
import type TextCoverPlugin from './main';

export interface TextCoverSettings {
  /** Frontmatter property to use as explicit cover text */
  contentProperty: string;
  /** Use the file title as the cover text instead of the note body */
  defaultToTitle: boolean;
  /** Fall back to extracting text from note body when no property found */
  fallbackToBody: boolean;
  /** Max characters before text is truncated */
  maxChars: number;
  /** Default CSS background (color or gradient) */
  defaultBg: string;
  /** Default CSS text color */
  defaultColor: string;
  /** Font size for cover text */
  fontSize: string;
  /** Padding inside cover */
  padding: string;
  /** Show opening quote mark decoration */
  showQuoteMark: boolean;
  /** Vault-relative folder to save downloaded remote covers into */
  coversFolder: string;
  /** Log debug info to console */
  debugMode: boolean;
}

export const DEFAULT_SETTINGS: TextCoverSettings = {
  contentProperty: 'textCover',
  defaultToTitle: false,
  fallbackToBody: true,
  maxChars: 300,
  defaultBg: 'linear-gradient(160deg, #1a1a2e 0%, #16213e 55%, #0f3460 100%)',
  defaultColor: '#e0e0e0',
  fontSize: '0.82em',
  padding: '1em 1.1em',
  showQuoteMark: true,
  coversFolder: 'Covers',
  debugMode: false,
};

export class TextCoverSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TextCoverPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Text Cover Generator' });
    containerEl.createEl('p', {
      text: 'Generates styled text covers for cards in Obsidian Bases views.',
      cls: 'setting-item-description',
    });

    // ── How to see text covers ────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'How to see text covers' });
    const steps = containerEl.createEl('ol', { cls: 'setting-item-description' });
    [
      'Open a Base and switch to (or add) a Cards view.',
      'In the view options, set "Image property" to textCover.',
      'Each card without a real image now shows its text cover. The text comes from the note’s ' +
        'textCover property if set, otherwise from the note body (see Content below).',
      'Optional: set textCoverBg / textCoverColor in a note’s properties to style its cover.',
    ].forEach((t) => steps.createEl('li', { text: t }));

    // ── Content ──────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Content' });

    new Setting(containerEl)
      .setName('Cover text property')
      .setDesc(
        'Frontmatter property name to use as explicit cover text. ' +
          'Per-note override: add this property to any note.'
      )
      .addText((t) =>
        t
          .setPlaceholder('textCover')
          .setValue(this.plugin.settings.contentProperty)
          .onChange(async (v) => {
            this.plugin.settings.contentProperty = v.trim() || 'textCover';
            await this.plugin.saveSettings();
            this.plugin.scheduleContentRebuild();
          })
      );

    new Setting(containerEl)
      .setName('Default to file title')
      .setDesc(
        'Use the note title as cover text when no cover text property is set. ' +
          'Uses the "title" frontmatter property if present, otherwise the file name.'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.defaultToTitle).onChange(async (v) => {
          this.plugin.settings.defaultToTitle = v;
          await this.plugin.saveSettings();
          this.plugin.scheduleContentRebuild();
        })
      );

    new Setting(containerEl)
      .setName('Fall back to note body')
      .setDesc(
        'When no cover text property is found (and "Default to file title" is off), ' +
          'extract text from the note body (first blockquote, then first paragraph).'
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.fallbackToBody).onChange(async (v) => {
          this.plugin.settings.fallbackToBody = v;
          await this.plugin.saveSettings();
          this.plugin.scheduleContentRebuild();
        })
      );

    new Setting(containerEl)
      .setName('Max characters')
      .setDesc('Truncate cover text after this many characters.')
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.maxChars))
          .onChange(async (v) => {
            const n = parseInt(v);
            if (!isNaN(n) && n > 0) {
              this.plugin.settings.maxChars = n;
              await this.plugin.saveSettings();
              this.plugin.resetAndProcess();
            }
          })
      );

    // ── Appearance ───────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Appearance' });
    containerEl.createEl('p', {
      text:
        'Per-note overrides: add textCoverBg or textCoverColor to a note\'s frontmatter.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Default background')
      .setDesc('CSS background value (color, gradient, etc.) for the cover.')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultBg)
          .onChange(async (v) => {
            this.plugin.settings.defaultBg = v;
            await this.plugin.saveSettings();
            this.plugin.resetAndProcess();
          })
      );

    new Setting(containerEl)
      .setName('Default text color')
      .setDesc('CSS color value for the cover text.')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.defaultColor)
          .onChange(async (v) => {
            this.plugin.settings.defaultColor = v;
            await this.plugin.saveSettings();
            this.plugin.resetAndProcess();
          })
      );

    new Setting(containerEl)
      .setName('Font size')
      .setDesc('CSS font-size for the cover text (e.g. 0.82em, 13px).')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.fontSize)
          .onChange(async (v) => {
            this.plugin.settings.fontSize = v;
            await this.plugin.saveSettings();
            this.plugin.resetAndProcess();
          })
      );

    new Setting(containerEl)
      .setName('Padding')
      .setDesc('CSS padding inside the cover (e.g. 1em 1.1em).')
      .addText((t) =>
        t
          .setValue(this.plugin.settings.padding)
          .onChange(async (v) => {
            this.plugin.settings.padding = v;
            await this.plugin.saveSettings();
            this.plugin.resetAndProcess();
          })
      );

    new Setting(containerEl)
      .setName('Show quote mark decoration')
      .setDesc('Show a large decorative opening-quote glyph in the cover background.')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showQuoteMark).onChange(async (v) => {
          this.plugin.settings.showQuoteMark = v;
          await this.plugin.saveSettings();
          this.plugin.resetAndProcess();
        })
      );

    // ── Covers ────────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Remote covers' });

    new Setting(containerEl)
      .setName('Covers folder')
      .setDesc('Vault-relative folder to save downloaded remote covers into.')
      .addText((t) =>
        t
          .setPlaceholder('Covers')
          .setValue(this.plugin.settings.coversFolder)
          .onChange(async (v) => {
            this.plugin.settings.coversFolder = v.trim().replace(/^\/+|\/+$/g, '') || 'Covers';
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Download remote covers to vault')
      .setDesc(
        'Finds notes whose banner/cover/image property points to a remote http(s) URL, or ' +
          'whose property points to a local file that no longer exists, downloads the best ' +
          'available image (recovering the source from coverSmallUrl/coverMediumUrl/' +
          'coverLargeUrl when needed) into the folder above, and repoints the property at ' +
          'the local file. Fixes covers that fail to load in Bases due to CORS or ' +
          'mixed-content blocking.'
      )
      .addButton((b) =>
        b.setButtonText('Download now').onClick(async () => {
          b.setButtonText('Downloading…').setDisabled(true);
          const count = await this.plugin.downloadRemoteCovers((done, total) => {
            b.setButtonText(`Downloading… ${done}/${total}`);
          });
          b.setButtonText(count > 0 ? `Done — ${count} downloaded` : 'No remote covers found').setDisabled(false);
        })
      );

    // ── Cache ─────────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Cache' });

    new Setting(containerEl)
      .setName('Rebuild cover cache')
      .setDesc(
        `The cache is saved to disk and persists across restarts, and updates itself ` +
          `automatically as notes change or as content settings above are edited. ` +
          `Currently ${this.plugin.cacheSize} covers cached. Use this button to force a ` +
          `full recompute — e.g. if notes were bulk-edited by an external tool.`
      )
      .addButton((b) =>
        b.setButtonText('Rebuild now').onClick(async () => {
          b.setButtonText('Building…').setDisabled(true);
          await this.plugin.buildCache();
          b.setButtonText(`Done — ${this.plugin.cacheSize} covers`).setDisabled(false);
        })
      );

    // ── Debug ────────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'Debug' });

    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Log card-selector activity to the browser console (Ctrl+Shift+I).')
      .addToggle((t) =>
        t.setValue(this.plugin.settings.debugMode).onChange(async (v) => {
          this.plugin.settings.debugMode = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Log DOM snapshot')
      .setDesc(
        'Print the inner HTML of active Base views to the console. ' +
          'Use this to discover class names if covers are not appearing.'
      )
      .addButton((b) =>
        b.setButtonText('Snapshot now').onClick(() => {
          this.plugin.logDomSnapshot();
        })
      );

    new Setting(containerEl)
      .setName('Re-process all cards')
      .setDesc('Force re-scanning all Base views right now.')
      .addButton((b) =>
        b.setButtonText('Refresh').onClick(() => {
          this.plugin.resetAndProcess();
        })
      );
  }
}
