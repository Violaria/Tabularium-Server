import { defaultServerConditions, defaultServerMainFields, defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resolve = (...args: string[]) => path.resolve(...args).replace(/\\/g, "/");
// Versions of the plug-in, whose sources the CLI is built from.
const repoRoot = path.resolve(__dirname, "../../../obsidian");

function readVersion(filePath: string): string | undefined {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
        return undefined;
    }
    return typeof parsed.version === "string" ? parsed.version : undefined;
}

const packageVersion = readVersion(path.resolve(repoRoot, "package.json"));
const manifestVersion = readVersion(path.resolve(repoRoot, "manifest.json"));
// https://vite.dev/config/
const defaultExternal = [
    "obsidian",
    "electron",
    "crypto",
    "pouchdb-adapter-leveldb",
    "commander",
    "chokidar",
    "punycode",
];
// Polyfill FileReader at the very top of the CJS bundle. octagonal-wheels uses
// FileReader for base64 conversion when Uint8Array.toBase64 (TC39 proposal) is
// unavailable. Node.js has neither, so we inject a minimal FileReader shim before
// any module-scope code evaluates.
const fileReaderPolyfillBanner = `
if (typeof globalThis.FileReader === "undefined") {
    globalThis.FileReader = class FileReader {
        constructor() { this.result = null; this.onload = null; this.onerror = null; }
        readAsDataURL(blob) {
            blob.arrayBuffer().then((buf) => {
                var b64 = require("buffer").Buffer.from(buf).toString("base64");
                this.result = "data:" + (blob.type || "application/octet-stream") + ";base64," + b64;
                if (this.onload) this.onload({ target: this });
            }).catch((err) => { if (this.onerror) this.onerror({ target: this, error: err }); });
        }
        readAsArrayBuffer() { throw new Error("FileReader.readAsArrayBuffer is not implemented in this polyfill"); }
        readAsBinaryString() { throw new Error("FileReader.readAsBinaryString is not implemented in this polyfill"); }
        readAsText() { throw new Error("FileReader.readAsText is not implemented in this polyfill"); }
        abort() { throw new Error("FileReader.abort is not implemented in this polyfill"); }
    };
}
`;

function injectBanner(): import("vite").Plugin {
    return {
        name: "inject-banner",
        generateBundle(_options, bundle) {
            for (const chunk of Object.values(bundle)) {
                if (chunk.type === "chunk" && chunk.isEntry) {
                    // Insert after the shebang line if present, otherwise at the top.
                    if (chunk.code.startsWith("#!")) {
                        const newline = chunk.code.indexOf("\n");
                        chunk.code =
                            chunk.code.slice(0, newline + 1) + fileReaderPolyfillBanner + chunk.code.slice(newline + 1);
                    } else {
                        chunk.code = fileReaderPolyfillBanner + chunk.code;
                    }
                }
            }
        },
    };
}

const buildInputs: Record<string, string> = {
    index: resolve(__dirname, "entrypoint.ts"),
};

export default defineConfig({
    plugins: [svelte(), injectBanner()],
    resolve: {
        // This bundle runs in Node. Vite's client defaults include the `browser`
        // export condition, which would select Commonlib's inline Web Worker.
        conditions: [...defaultServerConditions],
        mainFields: [...defaultServerMainFields],
        alias: {
            // Force fflate to the Node CJS entry; browser entry expects Web Worker globals.
            fflate: resolve(__dirname, "../node_modules/fflate/lib/node.cjs"),
            "@": resolve(__dirname, "../../../obsidian/src"),
            "@clients": resolve(__dirname, ".."),
        },
    },

    base: "./",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        minify: false,
        rollupOptions: {
            input: buildInputs,
            external: (id) => {
                if (isBuiltin(id)) return true;
                if (defaultExternal.includes(id)) return true;
                if (id.startsWith(".") || id.startsWith("/")) return false;
                if (id.startsWith("@/")) return false;
                if (id.endsWith(".ts") || id.endsWith(".js")) return false;
                if (id.startsWith("pouchdb-")) return true;
                return false;
            },
        },
        lib: {
            entry: resolve(__dirname, "entrypoint.ts"),
            formats: ["cjs"],
            fileName: (_format, entryName) => `${entryName}.cjs`,
        },
    },
    define: {
        self: "globalThis",
        global: "globalThis",
        nonInteractive: "true",
        // localStorage: "undefined", // Prevent usage of localStorage in the CLI environment
        MANIFEST_VERSION: JSON.stringify(process.env.MANIFEST_VERSION || manifestVersion || "0.0.0"),
        PACKAGE_VERSION: JSON.stringify(process.env.PACKAGE_VERSION || packageVersion || "0.0.0"),
    },
});
