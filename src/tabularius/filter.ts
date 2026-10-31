import { matchesGlob } from 'node:path';

// Values that look like credentials: key prefixes of common services, PEM private keys, and `password: value` style assignments.
const BUILT_IN = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|glpat-)[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
// Only the value (group 1) is masked.
const ASSIGNMENT = /(?<![A-Za-z0-9_])(?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|密码|口令|令牌|密钥)\s*[:=：]\s*(\S+)/dgi;
export const REDACTED = '[REDACTED]';

/** A masked range: `start`/`end` in the original text, `at` where its `[REDACTED]` begins in the masked text. */
export interface Span { start: number; end: number; at: number }
export interface Redaction { text: string; spans: Span[] }
export interface Filter { excluded(path: string): boolean; mask(text: string): string; redact(text: string): Redaction }

/** `excluded`: one glob per line; `masks`: one regular expression per line, added to the built-in rules. */
export function createFilter(excluded: string, masks: string): Filter {
  const globs = lines(excluded);
  const extra = lines(masks).map(source => new RegExp(source, 'g'));
  // All matches are found on the original text and merged, so a masked text maps back to the original exactly.
  function redact(text: string): Redaction {
    const ranges: [number, number][] = [];
    for (const pattern of [...BUILT_IN, ...extra])
      for (const match of text.matchAll(pattern)) if (match[0]) ranges.push([match.index, match.index + match[0].length]);
    for (const match of text.matchAll(ASSIGNMENT)) ranges.push(match.indices![1]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]); else merged.push([...range]);
    }
    let out = ''; let position = 0;
    const spans: Span[] = [];
    for (const [start, end] of merged) {
      out += text.slice(position, start);
      spans.push({ start, end, at: out.length });
      out += REDACTED;
      position = end;
    }
    return { text: out + text.slice(position), spans };
  }
  return {
    excluded: path => globs.some(glob => matchesGlob(path, glob) || matchesGlob(path, `${glob.replace(/\/+$/, '')}/**`)),
    mask: text => redact(text).text,
    redact,
  };
}

const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);

/** Rejects a rule list that would fail later: every mask must compile. */
/**
 * Mask patterns run on the server's main thread over every note, so patterns that can take exponential time are refused:
 * a quantified group that itself contains a quantifier (such as `(a+)+`), and back-references.
 */
export function checkMasks(masks: string) {
  for (const source of lines(masks)) {
    if (source.length > 300 || /\\[1-9]|\\k</.test(source) || /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*(?:[+*{]|\?(?!:))/.test(source)) throw new Error('Unsafe mask pattern');
    new RegExp(source, 'g');
  }
}

/**
 * Applies one edit written against the masked text to the original. `old` must occur once in the masked text and must not
 * cut through a `[REDACTED]`; each `[REDACTED]` in `replacement` takes back, in order, a value masked inside `old`.
 */
export function applyMaskedEdit(filter: Filter, original: string, old: string, replacement: string): string {
  const { text, spans } = filter.redact(original);
  if (!old) throw new Error('old must not be empty');
  const at = text.indexOf(old);
  if (at < 0) throw new Error('old text not found');
  if (text.indexOf(old, at + 1) >= 0) throw new Error('old text occurs more than once; include more context');
  const end = at + old.length;
  const toOriginal = (position: number) => {
    let shift = 0;
    for (const span of spans) {
      if (span.at >= position) break;
      if (position < span.at + REDACTED.length) throw new Error('old text cuts through a [REDACTED] value');
      shift += span.end - span.start - REDACTED.length;
    }
    return position + shift;
  };
  const start = toOriginal(at); const stop = toOriginal(end);
  const values = spans.filter(span => span.at >= at && span.at + REDACTED.length <= end).map(span => original.slice(span.start, span.end));
  const pieces = replacement.split(REDACTED);
  if (pieces.length - 1 > values.length) throw new Error('new text has more [REDACTED] values than old text');
  return original.slice(0, start) + pieces.map((piece, i) => i ? values[i - 1] + piece : piece).join('') + original.slice(stop);
}
