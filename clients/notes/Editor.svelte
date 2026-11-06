<script lang="ts">
    // Markdown editor (CodeMirror 6) in three presentations of one document: source, live render (marks hidden away from
    // the cursor, see livePreview.ts) and, in the parent's split view, source beside the preview. Switching keeps the
    // text, the cursor and the undo history. Selecting text shows the format menu; formats and templates are the same
    // text transforms the plug-in uses in Obsidian (formatting.ts). Read-only, it shows a note's source.
    import { onDestroy, onMount } from "svelte";
    import { Compartment, EditorState } from "@codemirror/state";
    import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
    import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
    import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
    import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
    import { tags } from "@lezer/highlight";
    import { format, insertTemplate, type Format, type Template, type TextEdit } from "@/features/tabularium/formatting";
    import { FORMAT_ACTIONS, HEADINGS, LINE_ACTIONS } from "@/features/tabularium/editorActions";
    import { sensitiveMarks } from "@/features/tabularium/sensitiveEditor";
    import { livePreview, type LiveOptions } from "./livePreview";
    import { t } from "../../ui/i18n";
    import { popMenu } from "../../ui/core";

    export type EditMode = "source" | "live";
    interface Props {
        text: string;
        mode: EditMode;
        live: LiveOptions;
        readonly?: boolean;
        changed?(text: string): void;
        save?(): void;
        dropped?(files: File[]): void;
        /** How far down the note is scrolled (0 to 1), for the split view's preview. */
        scrolled?(ratio: number): void;
    }
    let { text, mode, live, readonly = false, changed, save, dropped, scrolled }: Props = $props();
    let host: HTMLDivElement;
    let frame: HTMLDivElement;
    let view: EditorView | undefined;
    /** Set while the text is replaced from outside, so that the replacement is not reported as an edit. */
    let replacing = false;
    const presentation = new Compartment();
    let menu = $state<{ left: number; top: number } | undefined>();

    // Marks are quiet, headings and emphasis read as such; no underlined headings.
    const style = HighlightStyle.define([
        { tag: tags.heading, fontWeight: "650" },
        { tag: tags.emphasis, fontStyle: "italic" },
        { tag: tags.strong, fontWeight: "650" },
        { tag: tags.strikethrough, textDecoration: "line-through" },
        { tag: [tags.link, tags.url], color: "var(--accent)" },
        { tag: tags.monospace, fontFamily: "var(--mono)", fontSize: "0.92em" },
        { tag: [tags.processingInstruction, tags.contentSeparator, tags.quote, tags.meta], color: "var(--faint)" },
    ]);
    const words = () => ({
        start: t("editor.word.start"), end: t("editor.word.end"), step: t("editor.word.step"), topic: t("editor.word.topic"), idea: t("editor.word.idea"),
        task: t("editor.word.task"), heading: t("editor.word.heading"), cell: t("editor.word.cell"), callout: t("editor.word.callout"), formula: "E=mc^2",
    });

    function dispatch(edit: TextEdit) {
        if (!view) return;
        view.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.anchor, head: edit.head }, scrollIntoView: true });
        view.focus();
    }
    /** Applies a format to the selection; the same format again takes it off. */
    export function apply(kind: Format) {
        if (!view || readonly) return;
        const { from, to } = view.state.selection.main;
        dispatch(format(view.state.doc.toString(), from, to, kind, { linkText: t("editor.linkText") }));
    }
    /** Inserts a template at the cursor and selects its first placeholder. */
    export function template(kind: Template) {
        if (!view || readonly) return;
        const { from, to } = view.state.selection.main;
        dispatch(insertTemplate(view.state.doc.toString(), from, to, kind, words()));
    }

    function placeMenu() {
        if (!view || readonly || !view.hasFocus) return (menu = undefined);
        const range = view.state.selection.main;
        if (range.empty) return (menu = undefined);
        const start = view.coordsAtPos(range.from);
        const box = frame.getBoundingClientRect();
        if (!start) return (menu = undefined);
        // Above the selection, or below it when there is no room above.
        const above = start.top - box.top - 46;
        const end = view.coordsAtPos(range.to) ?? start;
        menu = { left: Math.max(0, Math.min(start.left - box.left, box.width - 420)), top: above > 4 ? above : end.bottom - box.top + 8 };
    }

    onMount(() => {
        view = new EditorView({
            parent: host,
            state: EditorState.create({
                doc: text,
                extensions: [
                    history(),
                    drawSelection(),
                    highlightActiveLine(),
                    EditorView.lineWrapping,
                    markdown({ base: markdownLanguage }),
                    syntaxHighlighting(style),
                    presentation.of(mode === "live" ? livePreview(live) : []),
                    sensitiveMarks,
                    EditorState.readOnly.of(readonly),
                    EditorView.editable.of(!readonly),
                    keymap.of([
                        { key: "Mod-s", preventDefault: true, run: () => (save?.(), true) },
                        ...FORMAT_ACTIONS.filter((action) => action.key).map((action) => ({ key: action.key!, preventDefault: true, run: () => (apply(action.id), true) })),
                        indentWithTab,
                        ...defaultKeymap,
                        ...historyKeymap,
                    ]),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged && !replacing) changed?.(update.state.doc.toString());
                        if (update.selectionSet || update.focusChanged || update.docChanged || update.geometryChanged) placeMenu();
                    }),
                    EditorView.domEventHandlers({
                        drop: (event) => {
                            const files = [...(event.dataTransfer?.files ?? [])];
                            if (!files.length || !dropped) return false;
                            event.preventDefault();
                            dropped(files);
                            return true;
                        },
                        scroll: (_event, current) => {
                            const scroller = current.scrollDOM;
                            const room = scroller.scrollHeight - scroller.clientHeight;
                            scrolled?.(room > 0 ? scroller.scrollTop / room : 0);
                            placeMenu();
                            return false;
                        },
                    }),
                ],
            }),
        });
        if (!readonly) view.focus();
    });
    onDestroy(() => view?.destroy());

    // A change of presentation keeps the document, the cursor and the history.
    $effect(() => {
        const next = mode === "live" ? livePreview(live) : [];
        view?.dispatch({ effects: presentation.reconfigure(next) });
    });

    /** Replaces the whole text, for example after another device changed the note. */
    export function replace(next: string) {
        if (!view || view.state.doc.toString() === next) return;
        replacing = true;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
        replacing = false;
    }
    /** Inserts at the cursor. */
    export function insert(snippet: string) {
        if (!view) return;
        const { from, to } = view.state.selection.main;
        view.dispatch({ changes: { from, to, insert: snippet }, selection: { anchor: from + snippet.length } });
        view.focus();
    }
    function headings(event: MouseEvent) {
        popMenu(event.currentTarget as HTMLElement, HEADINGS.map((level) => ({ label: t(`editor.${level}` as "editor.h1"), action: () => apply(level) })));
    }
</script>

<div class="editor" class:live-mode={mode === "live"} class:source-mode={mode === "source"} class:readonly bind:this={frame}>
    <div class="cm-host" bind:this={host}></div>
    {#if menu}
        <!-- Clicks on the menu keep the editor's focus and selection. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="format-menu" role="toolbar" tabindex="-1" aria-label={t("editor.format")} style:left="{menu.left}px" style:top="{menu.top}px" onmousedown={(event) => event.preventDefault()}>
            {#each FORMAT_ACTIONS as action (action.id)}
                <button type="button" aria-label={t(`editor.${action.id}` as "editor.bold")} title={t(`editor.${action.id}` as "editor.bold")} onclick={() => apply(action.id)}>{@html action.icon}</button>
            {/each}
            <span class="sep"></span>
            {#each LINE_ACTIONS as action (action.id)}
                {#if action.id === "h2"}
                    <button type="button" aria-label={t("editor.heading")} title={t("editor.heading")} aria-haspopup="menu" onclick={headings}>{@html action.icon}</button>
                {:else}
                    <button type="button" aria-label={t(`editor.${action.id}` as "editor.bold")} title={t(`editor.${action.id}` as "editor.bold")} onclick={() => apply(action.id)}>{@html action.icon}</button>
                {/if}
            {/each}
        </div>
    {/if}
</div>
