import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { inlineMathEnd, math } from "./math";

const render = (text: string) => {
    const md = new MarkdownIt();
    math(md);
    return md.render(text);
};

describe("formulas", () => {
    it("finds inline and display formulas as Obsidian does", () => {
        expect(render("质能方程 $E=mc^2$。")).toContain('<span class="math" data-tex="E=mc^2">');
        expect(render("行内 $$a+b$$ 显示")).toContain('<span class="math display" data-tex="a+b">');
        expect(render("$$\n\\int_0^1 x\\,dx\n$$\n")).toContain('<div class="math display" data-tex="\\int_0^1 x\\,dx">');
        expect(render("$$x^2$$\n")).toContain('<div class="math display" data-tex="x^2">');
    });
    it("leaves prices, escapes and code alone", () => {
        expect(render("花了 $5，又花了 $10")).not.toContain("math");
        expect(render("价格 \\$5 和 \\$6")).not.toContain("math");
        expect(render("`$a$` 是代码")).not.toContain('class="math');
        expect(render("$ a$")).not.toContain("math");
        expect(inlineMathEnd("$a$1", 0)).toBe(-1);
    });
});

describe("highlights", () => {
    it("marks ==text== as Obsidian does", async () => {
        const { enhance } = await import("./markdown");
        const md = new MarkdownIt();
        enhance(md, { copy: "copy" });
        expect(md.render("这是 ==重点== 吧")).toContain("<mark>重点</mark>");
        expect(md.render("a == b == c")).not.toContain("<mark>");
    });
});
