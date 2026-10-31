import { copyFile, cp, rm } from 'node:fs/promises';
for (const file of ['app.html', 'app.css', 'sw.js', 'share.html', 'icon.svg']) await copyFile(`ui/${file}`, `dist/public/${file}`);
// The web notes page is built separately (npm run build:notes) because it needs the plug-in's dependencies.
await rm('dist/public/notes', { recursive: true, force: true });
await cp('notes-dist', 'dist/public/notes', { recursive: true });
