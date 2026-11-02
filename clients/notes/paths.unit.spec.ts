import { describe, expect, it } from "vitest";
import { freePath, normalisePath } from "./paths";

describe("web notes paths", () => {
    it("normalises typed paths and adds .md to notes", () => {
        expect(normalisePath(" 文件夹 / 新笔记 ", true)).toBe("文件夹/新笔记.md");
        expect(normalisePath("a\\b.md", true)).toBe("a/b.md");
        expect(normalisePath("图.png")).toBe("图.png");
    });
    it("rejects empty, relative, hidden and absolute segments", () => {
        for (const bad of ["", "/a", "a//b", "../a", "a/./b", ".obsidian/x", "a/.hidden", "x".repeat(600)]) expect(normalisePath(bad, true)).toBeUndefined();
    });
    it("finds a free name before the extension", () => {
        const taken = new Set(["f/图.png", "f/图 1.png"]);
        expect(freePath("f", "图.png", (p) => taken.has(p))).toBe("f/图 2.png");
        expect(freePath("", "README", () => false)).toBe("README");
    });
});
