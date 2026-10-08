import esbuild from 'esbuild';
import { readFileSync } from 'fs';

const prod = process.argv[2] === 'production';

const banner = `/*
Text Cover Generator — Obsidian Plugin
*/`;

await esbuild.build({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  target: 'es2018',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});
