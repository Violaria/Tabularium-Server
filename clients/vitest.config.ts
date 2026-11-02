// Unit tests of the CLI and the browser and web-app adapters, with the plug-in's unit test settings. Run from the
// plug-in directory (its settings read manifest.json there): npm run test:clients in the parent repository.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import unit from "../../obsidian/vitest.config.unit";

const here = path.dirname(fileURLToPath(import.meta.url));
export default mergeConfig(
    unit,
    defineConfig({
        resolve: { alias: { "@clients": here } },
        test: { name: "client-tests", root: here, exclude: ["notes/**", "cli/test/**", "cli/testdeno/**"] },
    })
);
