<script module lang="ts">
    export type { SortedNode as TreeNode } from "./sorting";
</script>

<script lang="ts">
    import Self from "./Tree.svelte";
    import type { KindleItem } from "./kindle";
    import type { SortedNode as TreeNode } from "./sorting";
    import { t } from "../../ui/i18n";

    interface Props {
        node: TreeNode;
        current?: string;
        selecting: boolean;
        selected: KindleItem[];
        conflicted: Set<string>;
        expandAll: boolean;
        open(path: string): void;
        toggle(item: KindleItem): void;
        send(item: KindleItem): void;
        select(item: KindleItem): void;
        rename(item: KindleItem): void;
        remove(item: KindleItem): void;
        share(item: KindleItem): void;
        depth?: number;
    }
    let { node, current, selecting, selected, conflicted, expandAll, open, toggle, send, select, rename, remove, share, depth = 0 }: Props = $props();
    let expanded = $state<Record<string, boolean>>({});
    let menu = $state<string>();

    const sendable = (child: TreeNode) => child.folder || /\.md$/i.test(child.name);
    const item = (child: TreeNode): KindleItem => ({ path: child.path, folder: child.folder });
    const label = (child: TreeNode) => (child.folder ? child.name : child.name.replace(/\.md$/i, ""));
    // The menu floats over the tree; a click anywhere but its own button or panel, or Escape, closes it.
    const outside = (event: MouseEvent) => {
        if (menu !== undefined && (event.target as Element).closest?.("[data-owner]")?.getAttribute("data-owner") !== menu) menu = undefined;
    };
</script>

<svelte:window onclick={outside} onkeydown={(event) => event.key === "Escape" && (menu = undefined)} />

<ul>
    {#each node.children as child (child.path + (child.folder ? "/" : ""))}
        <li>
            <div class="row" class:current={child.path === current} class:menu-open={menu === child.path} style:--depth={depth}>
                {#if selecting && sendable(child)}
                    <input type="checkbox" aria-label={t("notes.selectItem", { name: child.name })} checked={selected.some((s) => s.path === child.path)} onchange={() => toggle(item(child))} />
                {/if}
                {#if child.folder}
                    {@const shown = expandAll || !!expanded[child.path]}
                    <button class="name folder" aria-expanded={shown} onclick={() => (expanded[child.path] = !expanded[child.path])}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true">{#if shown}<path d="M1.8 12.5V3.8c0-.4.3-.8.8-.8h3.3l1.5 1.6h5.4c.4 0 .8.3.8.8v1.4M1.8 12.5l1.7-5.1c.1-.3.4-.5.7-.5h9.6c.5 0 .8.5.7 1l-1.5 4.1c-.1.3-.4.5-.7.5z" />{:else}<path d="M1.8 12.2V3.8c0-.4.3-.8.8-.8h3.3l1.5 1.6h6c.4 0 .8.3.8.8v6.8c0 .4-.4.8-.8.8H2.6c-.5 0-.8-.4-.8-.8z" />{/if}</svg><span class="label">{child.name}</span></button>
                {:else}
                    <button class="name" class:other={!/\.md$/i.test(child.name)} onclick={() => open(child.path)}><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.8h5.2l3 3v9c0 .4-.3.7-.7.7H4c-.4 0-.7-.3-.7-.7V2.5c0-.4.3-.7.7-.7z" /><path d="M9 1.8v3.2h3.2" /></svg><span class="label">{label(child)}</span></button>
                    {#if conflicted.has(child.path)}<span class="conflict-mark" title={t("notes.stateConflict")}>{t("notes.conflictMark")}</span>{/if}
                {/if}
                {#if !selecting}
                    <button class="more" data-owner={child.path} aria-haspopup="menu" aria-expanded={menu === child.path} aria-label={t("notes.more")} title={t("notes.more")} onclick={() => (menu = menu === child.path ? undefined : child.path)}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r="1.1" /><circle cx="8" cy="8" r="1.1" /><circle cx="12.5" cy="8" r="1.1" /></svg></button>
                {/if}
            </div>
            {#if menu === child.path}
                <div class="menu" role="menu" data-owner={child.path}>
                    {#if sendable(child)}
                        <button role="menuitem" onclick={() => ((menu = undefined), share(item(child)))}>{t("share.menu")}</button>
                        <button role="menuitem" onclick={() => ((menu = undefined), send(item(child)))}>{t("notes.send")}</button>
                        <button role="menuitem" onclick={() => ((menu = undefined), select(item(child)))}>{t("notes.select")}</button>
                    {/if}
                    <button role="menuitem" onclick={() => ((menu = undefined), rename(item(child)))}>{t("notes.rename")}</button>
                    <button role="menuitem" onclick={() => ((menu = undefined), remove(item(child)))}>{t("notes.delete")}</button>
                </div>
            {/if}
            {#if child.folder && (expandAll || expanded[child.path])}
                <Self node={child} depth={depth + 1} {current} {selecting} {selected} {conflicted} {expandAll} {open} {toggle} {send} {select} {rename} {remove} {share} />
            {/if}
        </li>
    {/each}
</ul>
