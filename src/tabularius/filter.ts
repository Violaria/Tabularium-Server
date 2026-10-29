import { matchesGlob } from 'node:path';

// Values that look like credentials: key prefixes of common services, PEM private keys, and `password: value` style assignments.
const BUILT_IN = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk-ant-|sk-|ghp_|gho_|ghs_|github_pat_|xox[abposr]-|glpat-)[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
const ASSIGNMENT = /(?<![A-Za-z0-9_])((?:password|passwd|passphrase|pwd|token|secret|api[_-]?key|access[_-]?key|密码|口令|令牌|密钥)\s*[:=：]\s*)(\S+)/gi;
export const REDACTED = '[REDACTED]';

export interface Filter { excluded(path: string): boolean; mask(text: string): string }

/** `excluded`: one glob per line; `masks`: one regular expression per line, added to the built-in rules. */
export function createFilter(excluded: string, masks: string): Filter {
  const globs = lines(excluded);
  const extra = lines(masks).map(source => new RegExp(source, 'g'));
  return {
    excluded: path => globs.some(glob => matchesGlob(path, glob) || matchesGlob(path, `${glob.replace(/\/+$/, '')}/**`)),
    mask(text) {
      let result = text;
      for (const pattern of [...BUILT_IN, ...extra]) result = result.replace(pattern, REDACTED);
      return result.replace(ASSIGNMENT, (_, key: string, value: string) => value === REDACTED ? `${key}${value}` : `${key}${REDACTED}`);
    },
  };
}

const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);

/** Rejects a rule list that would fail later: every mask must compile. */
export function checkMasks(masks: string) {
  for (const source of lines(masks)) new RegExp(source, 'g');
}
