# Text Cover Generator

Shows automatically generated text as the cover of each card in Obsidian Bases card views. If a note has no cover image, it shows a snippet of the note instead.

## Install

You don't need a GitHub account. You do need [Obsidian](https://obsidian.md) installed and a vault open. Pick **one** of the two options.

### Option A: download and unzip (no extra plugins)

1. [Click here to download `text-cover-generator.zip`](https://github.com/VeryRandomness/obsidian-text-cover-generator/releases/latest/download/text-cover-generator.zip).
2. In Obsidian, click the **gear icon** (bottom-left) to open **Settings**, then click **Community plugins**. If you see **Turn on community plugins**, click it.
3. Next to "Installed plugins", click the **folder icon**. A folder window opens.
4. Unzip the download. Drag the folder inside it (named `text-cover-generator`) into the folder window from step 3.
5. Close Obsidian completely and open it again.
6. Go back to **Settings → Community plugins** and switch **Text Cover Generator** on.

### Option B: use the BRAT helper plugin

1. In **Settings → Community plugins → Browse**, search for **BRAT**, then **Install** and **Enable** it (one time only).
2. Open the Command palette (`Ctrl+P`, or `Cmd+P` on a Mac), type **BRAT: Add a beta plugin for testing** and press Enter.
3. Paste `VeryRandomness/obsidian-text-cover-generator` and click **Add Plugin**.
4. Go to **Settings → Community plugins** and switch **Text Cover Generator** on.

## How to use it

1. Open a Base in **Cards** view. Notes without a cover image now show text on a colored background.
2. To choose the cover text yourself, add a `textCover` property to a note's frontmatter.
3. To change colors, font size, or how much text shows, open **Settings → Text Cover Generator**.

## Updates

Updates install themselves. Each time you open Obsidian, the plugin checks for a newer version and installs it, then shows a short message. To check right away, open the Command palette and run **Text Cover Generator: Check for update now**.

## Something not working?

[Open an issue](https://github.com/VeryRandomness/obsidian-text-cover-generator/issues) or message Chris.
