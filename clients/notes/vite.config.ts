import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const version = (JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(path.resolve(__dirname, "../../../obsidian/manifest.json"), "utf8"))) as { version: string }).version;

// Built into the server's /notes/ directory as a module of the web application: the shell imports the fixed-name
// entry notes-module.js (with notes-module.css); the other files carry hashes so they can be cached for long.
export default defineConfig({
    plugins: [svelte()],
    // The plug-in's sorting engine is bundled from source; it imports "obsidian" for its file classes, which in the
    // browser come from a small stand-in.
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "../../../obsidian/src"),
            "@clients": path.resolve(__dirname, ".."),
            obsidian: path.resolve(__dirname, "obsidian-shim.ts"),
        },
    },
    base: "/notes/",
    publicDir: false,
    build: {
        outDir: path.resolve(__dirname, "../../notes-dist"),
        emptyOutDir: true,
        chunkSizeWarningLimit: 4096,
        cssCodeSplit: false,
        // Files stay files: the pages allow fonts and images only from the server itself, not data: URLs.
        assetsInlineLimit: 0,
        rollupOptions: {
            external: ["crypto"],
            // The notes module for the shell, the share viewer page (/s/…), which loads nothing else, and the renderer of
            // Tabularius answers, which loads without the notes module.
            input: { notes: path.resolve(__dirname, "main.ts"), viewer: path.resolve(__dirname, "viewer.ts"), answer: path.resolve(__dirname, "answer.ts") },
            preserveEntrySignatures: "exports-only",
            output: {
                entryFileNames: (chunk) => (chunk.name === "viewer" ? "assets/share-viewer.js" : chunk.name === "answer" ? "assets/answer-markdown.js" : "assets/notes-module.js"),
                assetFileNames: (asset) => (asset.names?.some((name) => name.endsWith(".css")) ? "assets/notes-module.css" : "assets/[name]-[hash][extname]"),
            },
        },
    },
    define: { MANIFEST_VERSION: JSON.stringify(version), PACKAGE_VERSION: JSON.stringify(version), global: "globalThis", self: "globalThis" },
});
