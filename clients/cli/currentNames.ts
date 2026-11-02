// 1.0 renamed what the CLI keeps on disk: the local database directory, the runtime and settings directory (.tabularium),
// the vault's snapshot and the device-name value. Data written by earlier versions moves to the current names before
// anything opens it, so nothing is fetched again.
import { fsPromises as fs, path } from "@clients/cli/platform";
import {
    DeviceNameKeyPrefix,
    FORMER_NAMES,
    SuffixDatabaseName,
} from "@tabularium/sync-core/compat/common/types";

/** The directory that holds the CLI's runtime values and default settings, in the database and in the vault. */
export const CLI_DIRECTORY = ".tabularium";
const FORMER_CLI_DIRECTORY = ".livesync";
export const SNAPSHOT_FILE = ".tabularium-snapshot.json";
const FORMER_SNAPSHOT_FILE = ".livesync-snapshot.json";

const exists = (target: string) =>
    fs.stat(target).then(
        () => true,
        () => false
    );
async function rename(from: string, to: string) {
    if ((await exists(from)) && !(await exists(to))) await fs.rename(from, to);
}

export async function moveToCurrentNames(databasePath: string, vaultPath: string) {
    for (const entry of await fs.readdir(databasePath))
        if (entry.endsWith(FORMER_NAMES.databaseSuffix))
            await rename(
                path.join(databasePath, entry),
                path.join(databasePath, entry.slice(0, -FORMER_NAMES.databaseSuffix.length) + SuffixDatabaseName)
            );
    for (const base of new Set([databasePath, vaultPath])) await rename(path.join(base, FORMER_CLI_DIRECTORY), path.join(base, CLI_DIRECTORY));
    await rename(path.join(vaultPath, FORMER_SNAPSHOT_FILE), path.join(vaultPath, SNAPSHOT_FILE));
    const values = path.join(databasePath, CLI_DIRECTORY, "runtime", "local-storage.json");
    if (!(await exists(values))) return;
    const stored = JSON.parse(await fs.readFile(values, "utf8")) as Record<string, unknown>;
    let changed = false;
    for (const key of Object.keys(stored)) {
        if (!key.startsWith(FORMER_NAMES.deviceNameKeyPrefix)) continue;
        const current = DeviceNameKeyPrefix + key.slice(FORMER_NAMES.deviceNameKeyPrefix.length);
        if (!(current in stored)) stored[current] = stored[key];
        delete stored[key];
        changed = true;
    }
    if (changed) await fs.writeFile(values, JSON.stringify(stored, null, 2));
}
