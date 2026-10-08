# Text Cover Generator

Shows automatically generated text as the cover of each card in Obsidian Bases card views. If a note has no cover image, it shows a snippet of the note instead.

## Install (about 2 minutes)

You don't need a GitHub account. You do need [Obsidian](https://obsidian.md) installed and a vault open.

**Step 1: install the helper plugin (one time only)**

1. In Obsidian, click the **gear icon** (bottom-left) to open **Settings**.
2. Click **Community plugins**. If you see a button that says **Turn on community plugins**, click it.
3. Click **Browse**, search for **BRAT**, click it, then click **Install**, then **Enable**.

**Step 2: add this plugin**

1. Open the Obsidian **Command palette** (press `Ctrl+P`, or `Cmd+P` on a Mac).
2. Type **BRAT: Add a beta plugin for testing** and press Enter.
3. Paste this exactly, then click **Add Plugin**:

   ```
   VeryRandomness/obsidian-text-cover-generator
   ```

4. When it says it's installed, go to **Settings → Community plugins** and switch **Text Cover Generator** on.

That's it.

## How to use it

1. Open a Base in **Cards** view. Notes without a cover image now show text on a colored background.
2. To choose the cover text yourself, add a `textCover` property to a note's frontmatter.
3. To change colors, font size, or how much text shows, open **Settings → Text Cover Generator**.

## Updates

Updates install themselves. Each time you open Obsidian, the plugin checks for a newer version and installs it, then shows a short message. To check right away, open the Command palette and run **Text Cover Generator: Check for update now**.

## Installing without BRAT (manual)

1. Go to the [Releases page](https://github.com/VeryRandomness/obsidian-text-cover-generator/releases/latest) and download `main.js`, `manifest.json` and `styles.css` (if listed).
2. In Obsidian, open **Settings → Community plugins** and click the **folder icon** next to "Installed plugins".
3. Create a new folder named `text-cover-generator` and put the downloaded files inside it.
4. Restart Obsidian, then switch the plugin on under **Settings → Community plugins**.

## Something not working?

[Open an issue](https://github.com/VeryRandomness/obsidian-text-cover-generator/issues) or message Chris.
