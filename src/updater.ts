import { Notice, Plugin, requestUrl } from "obsidian";

const BRANCH = "main";

function newer(remote: string, local: string): boolean {
	const a = remote.split(".").map((n) => parseInt(n, 10) || 0);
	const b = local.split(".").map((n) => parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return false;
}

async function fetchText(repo: string, ref: string, file: string): Promise<string> {
	const url = `https://raw.githubusercontent.com/${repo}/${ref}/${file}?t=${Date.now()}`;
	return (await requestUrl({ url, headers: { "Cache-Control": "no-cache" } })).text;
}

// Resolve the branch to an exact commit so a stale CDN copy of "main" is never read.
async function latestRef(repo: string): Promise<string> {
	try {
		const res = await requestUrl({
			url: `https://api.github.com/repos/${repo}/commits/${BRANCH}`,
			headers: { Accept: "application/vnd.github+json", "Cache-Control": "no-cache" },
		});
		if (res.json?.sha) return res.json.sha;
	} catch (e) {
		console.warn("Auto-update: commit lookup failed, falling back to branch", e);
	}
	return BRANCH;
}

async function check(plugin: Plugin, repo: string, manual: boolean) {
	const { manifest, app } = plugin;
	try {
		const ref = await latestRef(repo);
		const remoteManifest = await fetchText(repo, ref, "manifest.json");
		const version: string = JSON.parse(remoteManifest).version;
		// Read the installed version from disk: after a reload Obsidian keeps serving the stale in-memory manifest.
		let installed = manifest.version;
		try { installed = JSON.parse(await app.vault.adapter.read(`${manifest.dir}/manifest.json`)).version; } catch { /* use in-memory */ }
		if (!newer(version, installed)) {
			if (manual) new Notice(`${manifest.name} is up to date (version ${installed}).`);
			return;
		}

		const mainJs = await fetchText(repo, ref, "main.js");
		if (!mainJs.trim()) throw new Error("downloaded main.js is empty");
		let css: string | null = null;
		try { css = await fetchText(repo, ref, "styles.css"); } catch { /* optional */ }

		const dir = manifest.dir!;
		const adapter = app.vault.adapter;
		await adapter.write(`${dir}/main.js`, mainJs);
		await adapter.write(`${dir}/manifest.json`, remoteManifest);
		if (css !== null) await adapter.write(`${dir}/styles.css`, css);

		new Notice(`${manifest.name} updated to ${version}. Reloading…`);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const plugins = (app as any).plugins;
		setTimeout(async () => {
			await plugins.disablePlugin(manifest.id);
			await plugins.enablePlugin(manifest.id);
		}, 500);
	} catch (e) {
		console.error(`${manifest.name} auto-update:`, e);
		if (manual) new Notice(`Update check failed: ${(e as Error).message}`);
	}
}

/** Checks `repo` on GitHub for a newer version on startup and installs it. Call from onload(). */
export function setupAutoUpdate(plugin: Plugin, repo: string) {
	plugin.addCommand({
		id: "check-for-update",
		name: "Check for update now",
		callback: () => check(plugin, repo, true),
	});
	plugin.app.workspace.onLayoutReady(() => check(plugin, repo, false));
}
