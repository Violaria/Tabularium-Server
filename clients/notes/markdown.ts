// What web notes and the share viewer add to markdown-it so notes read like they do in Obsidian: code blocks with the
// language named, a copy button and highlighting (shell sessions look like a terminal, configuration files like a
// settings panel), Obsidian callouts (> [!note] Title), and task lists. Raw HTML stays disabled; highlight.js returns
// escaped text with its own spans only.
import type MarkdownIt from "markdown-it";
// The common set of highlight.js (about forty languages, from C++ to Swift) and the rest that notes of operations,
// systems and science tend to hold.
import hljs from "highlight.js/lib/common";
import powershell from "highlight.js/lib/languages/powershell";
import dos from "highlight.js/lib/languages/dos";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import nginx from "highlight.js/lib/languages/nginx";
import latex from "highlight.js/lib/languages/latex";
import apache from "highlight.js/lib/languages/apache";
import http from "highlight.js/lib/languages/http";
import properties from "highlight.js/lib/languages/properties";
import cmake from "highlight.js/lib/languages/cmake";
import groovy from "highlight.js/lib/languages/groovy";
import gradle from "highlight.js/lib/languages/gradle";
import scala from "highlight.js/lib/languages/scala";
import haskell from "highlight.js/lib/languages/haskell";
import elixir from "highlight.js/lib/languages/elixir";
import erlang from "highlight.js/lib/languages/erlang";
import clojure from "highlight.js/lib/languages/clojure";
import fsharp from "highlight.js/lib/languages/fsharp";
import ocaml from "highlight.js/lib/languages/ocaml";
import julia from "highlight.js/lib/languages/julia";
import matlab from "highlight.js/lib/languages/matlab";
import dart from "highlight.js/lib/languages/dart";
import protobuf from "highlight.js/lib/languages/protobuf";
import nix from "highlight.js/lib/languages/nix";
import verilog from "highlight.js/lib/languages/verilog";
import vhdl from "highlight.js/lib/languages/vhdl";
import x86asm from "highlight.js/lib/languages/x86asm";
import armasm from "highlight.js/lib/languages/armasm";
import llvm from "highlight.js/lib/languages/llvm";
import awk from "highlight.js/lib/languages/awk";
import vim from "highlight.js/lib/languages/vim";
import tcl from "highlight.js/lib/languages/tcl";
import prolog from "highlight.js/lib/languages/prolog";
import lisp from "highlight.js/lib/languages/lisp";
import scheme from "highlight.js/lib/languages/scheme";
import fortran from "highlight.js/lib/languages/fortran";
import delphi from "highlight.js/lib/languages/delphi";
import coffeescript from "highlight.js/lib/languages/coffeescript";
import handlebars from "highlight.js/lib/languages/handlebars";
import pgsql from "highlight.js/lib/languages/pgsql";
import nsis from "highlight.js/lib/languages/nsis";
import autohotkey from "highlight.js/lib/languages/autohotkey";
import applescript from "highlight.js/lib/languages/applescript";
import vbscript from "highlight.js/lib/languages/vbscript";
import dns from "highlight.js/lib/languages/dns";
import routeros from "highlight.js/lib/languages/routeros";
import glsl from "highlight.js/lib/languages/glsl";
import arduino from "highlight.js/lib/languages/arduino";
import qml from "highlight.js/lib/languages/qml";
import crystal from "highlight.js/lib/languages/crystal";
import dlang from "highlight.js/lib/languages/d";
import nim from "highlight.js/lib/languages/nim";
import elm from "highlight.js/lib/languages/elm";
import haxe from "highlight.js/lib/languages/haxe";
import ada from "highlight.js/lib/languages/ada";
import cspLang from "highlight.js/lib/languages/csp";
import { escapeXml } from "@/features/tabularium/epub";
import { math } from "./math";

for (const [name, language] of Object.entries({ powershell, dos, dockerfile, nginx, latex, apache, http, properties, cmake, groovy, gradle, scala, haskell, elixir, erlang, clojure, fsharp, ocaml, julia, matlab, dart, protobuf, nix, verilog, vhdl, x86asm, armasm, llvm, awk, vim, tcl, prolog, lisp, scheme, fortran, delphi, coffeescript, handlebars, pgsql, nsis, autohotkey, applescript, vbscript, dns, routeros, glsl, arduino, qml, crystal, d: dlang, nim, elm, haxe, ada, csp: cspLang }))
    hljs.registerLanguage(name, language);
hljs.registerAliases(["sh", "zsh", "fish"], { languageName: "bash" });
hljs.registerAliases(["console", "terminal"], { languageName: "shell" });
hljs.registerAliases(["toml", "conf", "cfg", "env", "properties", "systemd", "service"], { languageName: "ini" });
hljs.registerAliases(["html", "svg", "xaml"], { languageName: "xml" });
hljs.registerAliases(["cmd", "bat"], { languageName: "dos" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["cu", "cuda", "hpp", "cc", "cxx", "h++"], { languageName: "cpp" });
hljs.registerAliases(["caddyfile"], { languageName: "nginx" });

/** Shell sessions read as a terminal, configuration as a settings panel, the rest as code. */
const TERMINAL = new Set(["bash", "sh", "zsh", "fish", "shell", "console", "terminal", "powershell", "ps1", "pwsh", "ps", "cmd", "bat", "dos"]);
const CONFIG = new Set(["yaml", "yml", "json", "jsonc", "json5", "toml", "ini", "conf", "cfg", "env", "properties", "nginx", "dockerfile", "systemd", "service", "xml", "caddyfile"]);
const NAMES: Record<string, string> = {
    bash: "Bash", sh: "Shell", zsh: "Zsh", fish: "Fish", shell: "Shell", console: "Terminal", terminal: "Terminal", powershell: "PowerShell", ps1: "PowerShell",
    pwsh: "PowerShell", cmd: "CMD", bat: "Batch", yaml: "YAML", yml: "YAML", json: "JSON", jsonc: "JSON", toml: "TOML", ini: "INI", conf: "Config", cfg: "Config",
    env: "Env", nginx: "nginx", dockerfile: "Dockerfile", systemd: "systemd", xml: "XML", html: "HTML", css: "CSS", js: "JavaScript", javascript: "JavaScript",
    ts: "TypeScript", typescript: "TypeScript", py: "Python", python: "Python", cpp: "C++", "c++": "C++", c: "C", cs: "C#", csharp: "C#", java: "Java",
    go: "Go", rust: "Rust", rs: "Rust", sql: "SQL", diff: "Diff", md: "Markdown", markdown: "Markdown", php: "PHP", lua: "Lua", makefile: "Makefile",
    tex: "LaTeX", latex: "LaTeX", text: "Text", txt: "Text", plaintext: "Text",
};
const CALLOUT_GROUPS: Record<string, string> = {
    note: "note", info: "note", todo: "note", abstract: "summary", summary: "summary", tldr: "summary", tip: "tip", hint: "tip", important: "tip",
    success: "success", check: "success", done: "success", question: "question", help: "question", faq: "question", warning: "warning",
    caution: "warning", attention: "warning", failure: "danger", fail: "danger", missing: "danger", danger: "danger", error: "danger", bug: "danger",
    example: "example", quote: "quote", cite: "quote",
};

export interface MarkdownTexts {
    copy: string;
}

/** Adds code blocks, callouts and task lists to a markdown-it instance. */
export function enhance(md: MarkdownIt, texts: MarkdownTexts) {
    math(md);
    // ==highlight==, as in Obsidian: no space just inside the marks, within one paragraph.
    md.inline.ruler.before("emphasis", "highlight", (state, silent) => {
        const src = state.src;
        const start = state.pos;
        if (src.charCodeAt(start) !== 0x3d || src.charCodeAt(start + 1) !== 0x3d || /\s|=/.test(src[start + 2] ?? " ")) return false;
        const close = src.indexOf("==", start + 2);
        if (close < 0 || /\s/.test(src[close - 1]) || src.slice(start + 2, close).includes("\n\n")) return false;
        if (!silent) {
            state.push("mark_open", "mark", 1);
            const end = state.posMax;
            state.pos = start + 2;
            state.posMax = close;
            state.md.inline.tokenize(state);
            state.posMax = end;
            state.push("mark_close", "mark", -1);
        }
        state.pos = close + 2;
        return true;
    });
    md.renderer.rules.fence = (tokens, index) => {
        const token = tokens[index];
        const lang = token.info.trim().split(/\s+/)[0].toLowerCase();
        // Diagrams are drawn after the page shows them (renderDiagrams); until then, and where they cannot be, the source shows.
        if (lang === "mermaid") return `<figure class="mermaid-diagram" data-source="${escapeXml(token.content)}"><pre><code>${escapeXml(token.content)}</code></pre></figure>`;
        const known = lang && hljs.getLanguage(lang);
        const body = known ? hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value : escapeXml(token.content);
        const kind = TERMINAL.has(lang) ? "terminal" : CONFIG.has(lang) ? "config" : "code";
        const name = NAMES[lang] ?? (known ? known.name ?? lang : lang);
        return `<figure class="code-block" data-kind="${kind}"><figcaption><span class="code-lang">${escapeXml(name)}</span><button type="button" class="code-copy">${escapeXml(texts.copy)}</button></figcaption><pre><code class="hljs">${body}</code></pre></figure>`;
    };
    // Callouts: a quote whose first line is [!type] with an optional title (and +/- for folding, shown open here).
    md.core.ruler.after("block", "callouts", (state) => {
        const tokens = state.tokens;
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i].type !== "blockquote_open" || tokens[i + 1]?.type !== "paragraph_open" || tokens[i + 2]?.type !== "inline") continue;
            const inline = tokens[i + 2];
            const match = /^\[!([A-Za-z-]+)\][+-]?[ \t]*([^\n]*)\n?/.exec(inline.content);
            if (!match) continue;
            const type = match[1].toLowerCase();
            tokens[i].meta = { callout: CALLOUT_GROUPS[type] ?? "note", title: match[2].trim() || type.charAt(0).toUpperCase() + type.slice(1) };
            inline.content = inline.content.slice(match[0].length);
            // A callout with only a title has an empty first paragraph: drop it.
            if (!inline.content.trim()) {
                tokens[i + 1].hidden = true;
                tokens[i + 3].hidden = true;
            }
        }
    });
    md.renderer.rules.blockquote_open = (tokens, index, options, env, self) => {
        const meta = tokens[index].meta as { callout: string; title: string } | null;
        if (!meta) return self.renderToken(tokens, index, options);
        return `<div class="callout" data-callout="${meta.callout}"><div class="callout-title">${escapeXml(meta.title)}</div><div class="callout-body">`;
    };
    md.renderer.rules.blockquote_close = (tokens, index, options, env, self) => {
        let depth = 0;
        for (let open = index - 1; open >= 0; open--) {
            if (tokens[open].type === "blockquote_close") depth++;
            else if (tokens[open].type === "blockquote_open") {
                if (depth === 0) return tokens[open].meta ? "</div></div>" : self.renderToken(tokens, index, options);
                depth--;
            }
        }
        return self.renderToken(tokens, index, options);
    };
    // Task lists: "- [ ] item" and "- [x] item".
    md.core.ruler.after("inline", "tasks", (state) => {
        const tokens = state.tokens;
        for (let i = 2; i < tokens.length; i++) {
            const inline = tokens[i];
            if (inline.type !== "inline" || tokens[i - 1].type !== "paragraph_open" || tokens[i - 2].type !== "list_item_open") continue;
            const first = inline.children?.[0];
            const match = first?.type === "text" ? /^\[([ xX])\]\s/.exec(first.content) : null;
            if (!match || !first) continue;
            first.content = first.content.slice(match[0].length);
            const box = new state.Token("html_inline", "", 0);
            box.content = `<input type="checkbox" disabled${match[1] === " " ? "" : " checked"}> `;
            inline.children.unshift(box);
            tokens[i - 2].attrJoin("class", match[1] === " " ? "task" : "task done");
        }
    });
}

/** Copies the code of the block whose copy button was clicked; returns whether the click was on one. */
export function copyCode(event: MouseEvent, copied: string) {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".code-copy");
    if (!button) return false;
    event.preventDefault();
    const code = button.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    const label = button.textContent;
    void navigator.clipboard.writeText(code).then(() => {
        button.textContent = copied;
        window.setTimeout(() => (button.textContent = label), 1500);
    });
    return true;
}
