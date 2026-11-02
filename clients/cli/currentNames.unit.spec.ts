import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveToCurrentNames } from "./currentNames";

describe("moving the CLI's data to the current names", () => {
    it("renames the database directory, the runtime directory, the snapshot and the device-name value", async () => {
        const base = await mkdtemp(join(tmpdir(), "cli-names-"));
        const db = join(base, "db");
        const vault = join(base, "vault");
        await mkdir(join(db, "headless-vault-livesync-v2"), { recursive: true });
        await mkdir(join(db, ".livesync", "runtime"), { recursive: true });
        await writeFile(join(db, ".livesync", "runtime", "local-storage.json"), JSON.stringify({ "obsidian-live-sync-vaultanddevicename-headless-vault-": "Tabularius", other: 1 }));
        await mkdir(join(vault, ".livesync"), { recursive: true });
        await writeFile(join(vault, ".livesync", "ignore"), "*.tmp\n");
        await writeFile(join(vault, ".livesync-snapshot.json"), "{}");

        await moveToCurrentNames(db, vault);

        expect((await readdir(db)).sort()).toEqual([".tabularium", "headless-vault-localdb"]);
        expect(JSON.parse(await readFile(join(db, ".tabularium", "runtime", "local-storage.json"), "utf8"))).toEqual({
            "device-name-headless-vault-": "Tabularius",
            other: 1,
        });
        expect(await readFile(join(vault, ".tabularium", "ignore"), "utf8")).toBe("*.tmp\n");
        expect((await readdir(vault)).sort()).toEqual([".tabularium", ".tabularium-snapshot.json"]);
        // A second start finds nothing to move.
        await moveToCurrentNames(db, vault);
        expect((await readdir(db)).sort()).toEqual([".tabularium", "headless-vault-localdb"]);
    });
});
