import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";

import { isSpecSource, parseSpecs, sortedTree } from "./sorting";
import { foldSortingNotes } from "./sortingNotes";

const file = (path: string) => ({ path });
const names = (node: { children: { name: string }[] }) => node.children.map((child) => child.name);

describe("web notes sorting", () => {
    it("reads the rules notes", () => {
        expect(isSpecSource("Collation.md")).toBe(true);
        expect(isSpecSource("a/b/Collation.md")).toBe(true);
        expect(isSpecSource("sortspec.md")).toBe(false);
        expect(isSpecSource("Zeta/Zeta.md")).toBe(false);
        expect(isSpecSource("Tabularius.md")).toBe(false);
    });

    it("orders as the list says, the rest by name with folders first, as in Obsidian", () => {
        const parsed = parseSpecs([{ path: "Collation.md", text: "规则\n\n- Zeta —— 先放\n  - two\n  - ...\n  - one\n- Alpha\n- Collation\n" }], []);
        expect(parsed.unconverted).toBe(false);
        const files = ["Alpha/a.md", "Beta.md", "Zeta/one.md", "Zeta/two.md", "Zeta/three.md", "Collation.md", "Gamma/g.md"].map(file);
        const tree = sortedTree(files, "Vault", parsed.rules);
        expect(tree.name).toBe("Vault");
        expect(names(tree)).toEqual(["Zeta", "Alpha", "Collation.md", "Gamma", "Beta.md"]);
        expect(names(tree.children[0])).toEqual(["two.md", "three.md", "one.md"]);
    });

    it("sorts by name without rules, and says when the rules are still in front matter", () => {
        const files = ["b.md", "A/x.md", "c.md", "a10.md", "a9.md"].map(file);
        expect(names(sortedTree(files, ""))).toEqual(["A", "a9.md", "a10.md", "b.md", "c.md"]);
        // The former note is not read, and the page asks to convert it until the folder has a Collation.md.
        const former = parseSpecs([], ["sortspec.md", "b.md"]);
        expect(former.unconverted).toBe(true);
        expect(parseSpecs([], ["sortspec.md", "Collation.md"]).unconverted).toBe(false);
        expect(names(sortedTree(files, "", former.rules))).toEqual(["A", "a9.md", "a10.md", "b.md", "c.md"]);
    });
});

describe("notes in Collation.md when reading", () => {
    it("puts a list item's note behind an icon, and leaves other notes as written", () => {
        const tip = (text: string) => `<span class="tip" data-tip="${text}"></span>`;
        const render = (fold: boolean) => {
            const md = new MarkdownIt();
            if (fold) foldSortingNotes(md, tip);
            return md.render("- 网络工程 —— 按路由、交换、组网的顺序\n  - 路由服务器 —— 先读 [[基本WAN_LAN]] 再看 PPPoE\n- 其他\n\n正文 —— 不是列表\n");
        };
        const folded = render(true);
        expect(folded).toContain('<li>网络工程<span class="tip" data-tip="按路由、交换、组网的顺序"></span>');
        expect(folded).toContain('data-tip="先读 [[基本WAN_LAN]] 再看 PPPoE"');
        expect(folded).toContain("<p>正文 —— 不是列表</p>");
        expect(render(false)).toContain("网络工程 —— 按路由");
    });
});
