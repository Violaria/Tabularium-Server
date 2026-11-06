// Copy protection on the share viewer: the page keeps its elements (headings, lists, tables, code blocks) and their
// layout, but every piece of text becomes a canvas drawn in the same place, one for each line of a text node, and images
// and diagrams become canvases as well. Nothing here keeps a determined visitor from the content, which must reach the
// browser to be shown; it means the text cannot be selected, and is not in the page for the inspector to read.
const ROOM = 0.25;
/** Kept inside the line by this many pixels, so that rounding the baseline does not make the line taller. */
const INSET = 1;

interface Word {
    text: string;
    x: number;
}
interface Piece {
    node: Text;
    /** A preserved line break between the lines of the node, or a line of it. */
    newline?: boolean;
    /** The white space of a line that holds nothing else, kept as it is. */
    blank?: string;
    words?: Word[];
    width?: number;
}

/** The decoration lines of the inline elements around this text; they do not reach a canvas by themselves. */
function decorations(element: Element) {
    const lines: { line: string; color: string }[] = [];
    for (let at: Element | null = element; at; at = at.parentElement) {
        const style = getComputedStyle(at);
        if (style.display !== "inline") break;
        if (style.textDecorationLine !== "none") lines.push({ line: style.textDecorationLine, color: style.textDecorationColor });
    }
    return lines;
}

const fontMetrics = new Map<string, { ascent: number; descent: number }>();
/** Ascent and descent as the page's layout uses them, which a canvas's own measurements round differently. */
function metricsOf(font: string) {
    let metrics = fontMetrics.get(font);
    if (metrics) return metrics;
    const probe = document.createElement("div");
    Object.assign(probe.style, { position: "absolute", visibility: "hidden", font, lineHeight: "normal", whiteSpace: "nowrap" });
    const text = document.createElement("span");
    text.textContent = "x";
    const base = document.createElement("span");
    Object.assign(base.style, { display: "inline-block", width: "0", height: "0" });
    probe.append(text, base);
    document.body.append(probe);
    const box = text.getBoundingClientRect();
    const baseline = base.getBoundingClientRect().bottom;
    metrics = { ascent: baseline - box.top, descent: box.bottom - baseline };
    probe.remove();
    fontMetrics.set(font, metrics);
    return metrics;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The lines of a text node as laid out now, each with its words at their places. */
function measure(node: Text): Piece[] {
    const range = document.createRange();
    const preserved = /^(pre|break-spaces)/.test(getComputedStyle(node.parentElement).whiteSpace);
    const pieces: Piece[] = [];
    let line: { left: number; right: number; bottom: number; words: Word[]; blank: string } | undefined;
    let open = false;
    const finish = () => {
        if (line) pieces.push(line.words.length ? { node, words: line.words, width: line.right - line.left } : { node, blank: line.blank });
        line = undefined;
        open = false;
    };
    for (const { segment, index } of graphemes.segment(node.data)) {
        if (preserved && segment === "\n") {
            finish();
            pieces.push({ node, newline: true });
            continue;
        }
        range.setStart(node, index);
        range.setEnd(node, index + segment.length);
        const rect = range.getBoundingClientRect();
        // Collapsed white space takes no room and draws nothing.
        if (rect.width === 0) continue;
        if (line && (rect.top >= line.bottom - 1 || rect.left < line.left)) finish();
        line ??= { left: rect.left, right: rect.right, bottom: rect.bottom, words: [], blank: "" };
        line.right = Math.max(line.right, rect.right);
        if (/^\s$/.test(segment)) {
            line.blank += segment;
            open = false;
            continue;
        }
        if (open) line.words[line.words.length - 1].text += segment;
        else line.words.push({ text: segment, x: rect.left - line.left });
        open = true;
    }
    finish();
    return pieces;
}

/** One line of text as a canvas that takes the room the text took, on the same baseline. */
function draw(piece: Required<Pick<Piece, "words" | "width">>, parent: Element) {
    const style = getComputedStyle(parent);
    const canvas = document.createElement("canvas");
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const { ascent, descent } = metricsOf(font);
    const size = parseFloat(style.fontSize);
    const room = size * ROOM;
    const height = ascent + descent;
    const lineHeight = parseFloat(style.lineHeight) || height;
    const lead = (lineHeight - height) / 2;
    const scale = window.devicePixelRatio || 1;
    // Slightly under the measured width, so rounding never pushes a full line's last piece onto the next line.
    const width = Math.floor(piece.width * 64) / 64;
    canvas.width = Math.ceil((width + room * 2) * scale);
    canvas.height = Math.ceil((height + room * 2) * scale);
    Object.assign(canvas.style, {
        display: "inline-block",
        width: `${width + room * 2}px`,
        height: `${height + room * 2}px`,
        margin: `${lead - room - INSET}px ${-room}px`,
        verticalAlign: `${-(descent + lead - INSET)}px`,
    });
    const drawing = canvas.getContext("2d", { willReadFrequently: true });
    drawing.scale(scale, scale);
    drawing.font = font;
    drawing.fontKerning = "normal";
    drawing.fillStyle = style.color;
    drawing.textBaseline = "alphabetic";
    if ("letterSpacing" in drawing && style.letterSpacing !== "normal") drawing.letterSpacing = style.letterSpacing;
    const baseline = room + ascent;
    const shown = (text: string) => (style.textTransform === "uppercase" ? text.toUpperCase() : style.textTransform === "lowercase" ? text.toLowerCase() : text);
    for (const word of piece.words) drawing.fillText(shown(word.text), room + word.x, baseline);
    for (const { line, color } of decorations(parent)) {
        drawing.fillStyle = color;
        const thickness = Math.max(1, size / 16);
        if (line.includes("underline")) drawing.fillRect(room, baseline + size * 0.1, width, thickness);
        if (line.includes("line-through")) drawing.fillRect(room, baseline - size * 0.3, width, thickness);
    }
    return canvas;
}

/** A bitmap of an image, to stand in for the image element. */
async function bitmap(source: string, width: number, height: number) {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    const scale = height && width ? window.devicePixelRatio || 1 : 1;
    canvas.width = Math.ceil((width || image.naturalWidth) * scale);
    canvas.height = Math.ceil((height || image.naturalHeight) * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    if (width && height) Object.assign(canvas.style, { width: `${width}px`, height: `${height}px` });
    return canvas;
}

/** Draws an image file into a canvas in place of `element`; the canvas keeps the element's class. */
export async function drawImage(element: HTMLElement, data: Uint8Array, type: string) {
    const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
    const canvas = await bitmap(url, 0, 0);
    URL.revokeObjectURL(url);
    canvas.className = "share-image";
    canvas.setAttribute("role", "img");
    element.replaceWith(canvas);
}

/** Mermaid's drawing as a picture; its labels are the only text an SVG would keep readable in the page. */
async function drawDiagram(svg: SVGSVGElement) {
    const box = svg.getBoundingClientRect();
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(box.width));
    copy.setAttribute("height", String(box.height));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
    const canvas = await bitmap(url, box.width, box.height);
    URL.revokeObjectURL(url);
    svg.replaceWith(canvas);
}

/** Replaces what can be read under `root` with drawings of it. Call it with diagrams and formulas already drawn. */
export async function rasterize(root: HTMLElement) {
    await document.fonts.ready;
    for (const element of root.querySelectorAll(".katex-mathml, .sr-only, .code-copy, style")) if (!element.closest("svg")) element.remove();
    for (const element of root.querySelectorAll("[data-tex], [data-source], [alt], [title]")) {
        for (const attribute of ["data-tex", "data-source", "alt", "title"]) element.removeAttribute(attribute);
    }
    for (const svg of root.querySelectorAll<SVGSVGElement>(".mermaid-diagram svg")) await drawDiagram(svg);
    // Everything is measured before anything changes, as each replacement moves what follows it.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) if ((node.nodeValue ?? "").trim() && !node.parentElement.closest("svg")) nodes.push(node as Text);
    const measured = nodes.map(measure);
    for (const [index, node] of nodes.entries()) {
        const parent = node.parentElement;
        const fragment = document.createDocumentFragment();
        for (const piece of measured[index]) {
            if (piece.newline) fragment.append("\n");
            else if (piece.words) fragment.append(draw(piece as Required<Pick<Piece, "words" | "width">>, parent));
            else fragment.append(piece.blank);
        }
        node.replaceWith(fragment);
    }
}

const BLOCKED_KEYS = new Set(["F12"]);
/** Keeps the page's own ways of copying, saving and inspecting closed. */
export function blockInteraction() {
    document.documentElement.classList.add("share-protected");
    for (const name of ["copy", "cut", "contextmenu", "dragstart", "selectstart"]) document.addEventListener(name, (event) => event.preventDefault());
    document.addEventListener("keydown", (event) => {
        const key = event.key.toLowerCase();
        const command = event.ctrlKey || event.metaKey;
        const inspector = command && (event.shiftKey || event.altKey) && ["i", "j", "c"].includes(key);
        if (BLOCKED_KEYS.has(event.key) || inspector || (command && ["u", "s", "p", "a", "c", "x"].includes(key))) event.preventDefault();
    });
}
