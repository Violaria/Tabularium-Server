import { copyFile } from 'node:fs/promises';
for (const file of ['index.html', 'home.html', 'admin.css']) await copyFile(`ui/${file}`, `dist/public/${file}`);
