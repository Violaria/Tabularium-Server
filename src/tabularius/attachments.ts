// Conversation attachments: what a file is, and the text a model reads from it. Images go to the model as images; text
// files and PDFs as their text, taken here when the file is uploaded, so a file that cannot be read fails at once.

export class AttachmentError extends Error {}

/** Text beyond this many characters is cut, with a note, so one file cannot fill the model's context. */
export const TEXT_LIMIT = 200_000;
/** At most this many attachments go with one message. */
export const PER_MESSAGE = 10;

/** The image type from the file's first bytes; the name and the browser's claim are not trusted. */
export function imageType(data: Buffer): string | undefined {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return undefined;
}

const isPdf = (data: Buffer) => data.subarray(0, 5).toString('latin1') === '%PDF-';
const cut = (text: string) => text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[Truncated: the file has ${text.length} characters.]` : text;

/** UTF-8 text, refused when it is not text (invalid UTF-8, or NUL bytes as binary files have). */
function plainText(data: Buffer) {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw new AttachmentError('Not a text file'); }
  if (text.includes('\0')) throw new AttachmentError('Not a text file');
  return text.replace(/^\uFEFF/, '');
}

/** The text layer of a PDF, page by page. pdf.js only reads the file: it runs no scripts from it and evaluates no code. */
async function pdfText(data: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(data), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  let document;
  try {
    document = await task.promise;
  } catch (error) {
    await task.destroy();
    throw new AttachmentError((error as Error).name === 'PasswordException' ? 'The PDF is protected by a password' : 'The PDF cannot be read');
  }
  try {
    const pages: string[] = [];
    for (let n = 1; n <= document.numPages; n++) {
      const content = await (await document.getPage(n)).getTextContent();
      pages.push(content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('').trim());
    }
    const text = pages.map((page, i) => `[Page ${i + 1}]\n${page}`).join('\n\n');
    if (!pages.some(Boolean)) throw new AttachmentError('The PDF has no text layer (a scan?)');
    return text;
  } finally {
    await task.destroy();
  }
}

/** What an uploaded file is: an image with its type, or text (from a text file or a PDF). */
export async function examine(data: Buffer): Promise<{ kind: 'image'; mime: string } | { kind: 'text'; mime: string; text: string }> {
  if (!data.length) throw new AttachmentError('The file is empty');
  const image = imageType(data);
  if (image) return { kind: 'image', mime: image };
  if (isPdf(data)) return { kind: 'text', mime: 'application/pdf', text: cut(await pdfText(data)) };
  return { kind: 'text', mime: 'text/plain', text: cut(plainText(data)) };
}
