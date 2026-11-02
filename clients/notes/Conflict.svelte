<script module lang="ts">
    export interface Version {
        rev: string;
        text: string;
        mtime: number;
        current: boolean;
    }
</script>

<script lang="ts">
    // Versions of a conflicted note side by side, their differences from the current version, and a merge editor.
    import { DIFF_DELETE, DIFF_INSERT, diff_match_patch } from "diff-match-patch";
    import Editor from "./Editor.svelte";
    import { formatDate, t } from "../../ui/i18n";

    interface Props {
        versions: Version[];
        binary: boolean;
        keep(version: Version): void;
        merge(text: string): void;
    }
    let { versions, binary, keep, merge }: Props = $props();
    let merged = $state(versions.find((v) => v.current)?.text ?? "");

    function difference(from: string, to: string) {
        const dmp = new diff_match_patch();
        const diffs = dmp.diff_main(from, to);
        dmp.diff_cleanupSemantic(diffs);
        return diffs.map(([op, text]) => ({ op: op === DIFF_INSERT ? "ins" : op === DIFF_DELETE ? "del" : "same", text }));
    }
    const current = $derived(versions.find((v) => v.current));
</script>

<section class="conflict">
    <p class="notice">{t("notes.conflictHint")}</p>
    <div class="versions">
        {#each versions as version (version.rev)}
            <div class="version">
                <header>
                    <strong>{version.current ? t("notes.currentVersion") : t("notes.otherVersion")}</strong>
                    <small>{formatDate(version.mtime)}</small>
                    <button onclick={() => keep(version)}>{t("notes.keepVersion")}</button>
                </header>
                {#if binary}
                    <p class="hint">{t("notes.binaryVersion")}</p>
                {:else if version.current || !current}
                    <pre>{version.text}</pre>
                {:else}
                    <pre>{#each difference(current.text, version.text) as part, i (i)}{#if part.op === "ins"}<ins>{part.text}</ins>{:else if part.op === "del"}<del>{part.text}</del>{:else}{part.text}{/if}{/each}</pre>
                {/if}
            </div>
        {/each}
    </div>
    {#if !binary}
        <h3>{t("notes.mergeTitle")}</h3>
        <Editor text={merged} changed={(text) => (merged = text)} save={() => merge(merged)} dropped={() => {}} />
        <button class="primary" onclick={() => merge(merged)}>{t("notes.saveMerge")}</button>
    {/if}
</section>
