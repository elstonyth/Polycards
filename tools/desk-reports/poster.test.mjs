import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getReport } from './http.mjs';
import { TOOLS, runTool } from './tools.mjs';

const KEY = 'k'.repeat(64);
const base = { baseUrl: 'https://backend.test', desk: 'growth', key: KEY };
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const jpegReply = async () =>
  new Response(JPEG, {
    status: 200,
    headers: { 'content-type': 'image/jpeg' },
  });
const poster = TOOLS.growth.find((t) => t.name === 'challenge_poster');
// Hermes attaches an MCP image only when the reply carries its MEDIA: line
// (MCP tools are not on the gateway's auto-attach list), so every image
// result must say so.
const ATTACH = /copy this result's MEDIA: line onto its own line in your reply/;

test('image mode returns the bytes as base64 and keeps the key safe', async () => {
  let seen;
  const img = await getReport({
    ...base,
    path: 'challenge-poster',
    as: 'image',
    fetchImpl: async (url, init) => {
      seen = init;
      return jpegReply();
    },
  });
  assert.equal(seen.headers.accept, 'image/*');
  assert.equal(seen.redirect, 'error');
  assert.deepEqual(img, {
    mimeType: 'image/jpeg',
    data: JPEG.toString('base64'),
    missingArt: '',
  });
});

test('challenge_poster tells the bot when prize art is a placeholder', async () => {
  const out = await runTool(
    poster,
    {},
    {
      ...base,
      fetchImpl: async () =>
        new Response(JPEG, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'x-poster-missing-art': '1,3',
          },
        }),
    },
  );
  assert.equal(out.content[0].type, 'image');
  assert.match(out.content[1].text, /rank 1,3 could not be loaded/);
  assert.doesNotMatch(out.content[1].text, /with the official card art/);
  assert.match(out.content[1].text, ATTACH);
});

test('image mode refuses a non-image and still relays error messages', async () => {
  await assert.rejects(
    getReport({
      ...base,
      path: 'challenge-poster',
      as: 'image',
      fetchImpl: async () =>
        new Response('<html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    }),
    /unreadable image/,
  );
  await assert.rejects(
    getReport({
      ...base,
      path: 'challenge-poster',
      as: 'image',
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'There is no stage 9.' }), {
          status: 400,
        }),
    }),
    /There is no stage 9/,
  );
});

test('challenge_poster asks for an image and returns an MCP image block', async () => {
  assert.deepEqual(poster.request({ stage: 3, leaders: true }), {
    path: 'challenge-poster',
    params: { stage: 3, leaders: 1 },
    as: 'image',
  });
  assert.deepEqual(poster.request({}).params, {
    stage: undefined,
    leaders: undefined,
  });
  const out = await runTool(poster, {}, { ...base, fetchImpl: jpegReply });
  assert.ok(!out.isError);
  assert.deepEqual(out.content[0], {
    type: 'image',
    data: JPEG.toString('base64'),
    mimeType: 'image/jpeg',
  });
  assert.equal(out.content[1].type, 'text');
  assert.match(out.content[1].text, ATTACH);
});

test('brand_logo returns the official file unchanged, without the backend', async () => {
  const logo = TOOLS.growth.find((t) => t.name === 'brand_logo');
  const noBackend = {
    ...base,
    fetchImpl: async () => assert.fail('must not call the backend'),
  };
  for (const [variant, file] of [
    [undefined, 'polycards-wordmark-white.png'],
    ['mark', 'polycards-mark.png'],
  ]) {
    const out = await runTool(logo, { variant }, noBackend);
    assert.ok(!out.isError);
    assert.equal(out.content[0].type, 'image');
    assert.equal(out.content[0].mimeType, 'image/png');
    const bytes = readFileSync(new URL(`./brand/${file}`, import.meta.url));
    assert.equal(out.content[0].data, bytes.toString('base64'));
    assert.match(out.content[1].text, ATTACH);
    // PNG signature: the file shipped is a real PNG.
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
});
