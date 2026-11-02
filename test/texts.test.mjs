import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogues } from '../dist/public/messages.js';

test('web texts contain no emoji', () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const [lang, catalogue] of Object.entries(catalogues))
    assert.deepEqual(Object.entries(catalogue).filter(([, text]) => emoji.test(text)).map(([key]) => key), [], lang);
});
