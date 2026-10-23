const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const express = require('express');
const { createSplitDownloads } = require('../lib/split-downloads');

const root = path.resolve(__dirname, '..');
const realRequire = createRequire(path.join(root, 'server.js'));
const ffmpeg = process.env.TEST_FFMPEG_PATH || require('ffmpeg-static');

function localServer() {
  const db = { from() { return this; }, select() { return this; },
    eq() { return this; }, update() { return this; },
    async single() { return { data: { total_usos: 0 } }; } };
  const passport = {
    use() {}, serializeUser() {}, deserializeUser() {},
    authenticate() { return (req, res, next) => next(); },
    session() { return (req, res, next) => next(); },
    initialize() { return (req, res, next) => {
      const id = req.get('x-test-user');
      if (id) req.user = { id, email: `${id}@example.test`, plan: 'pro', usos_hoy: 0 };
      next();
    }; }
  };
  // Test-only dependencies: no Google, Supabase, Stripe, .env or production
  // credentials are used. The application routes themselves run unchanged.
  function requireForTest(name) {
    if (name === 'dotenv') return { config() {} };
    if (name === 'passport') return passport;
    if (name === 'passport-google-oauth20') return { Strategy: class {} };
    if (name === '@supabase/supabase-js') return { createClient: () => db };
    if (name === 'stripe') return () => ({});
    return realRequire(name);
  }
  const context = { require: requireForTest, module: { exports: {} },
    console, Buffer, setInterval: () => ({ unref() {} }),
    process: { env: { FFMPEG_PATH: ffmpeg, ADMIN_EMAIL: 'owner@example.test' } } };
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const tail = "app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));";
  assert.equal(source.split(tail).length, 2);
  vm.runInNewContext(source.replace(tail, 'module.exports = { app, jobs916, splitDownloads };'), context);
  return context.module.exports;
}

function zipNames(buffer) {
  // Read the standard ZIP central directory, independent of archiver.
  const names = [];
  for (let i = 0; i < buffer.length - 46; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue;
    const length = buffer.readUInt16LE(i + 28);
    names.push(buffer.subarray(i + 46, i + 46 + length).toString('utf8'));
    i += 45 + length + buffer.readUInt16LE(i + 30) + buffer.readUInt16LE(i + 32);
  }
  return names;
}

test('both split routes produce native downloads, preserve Unicode and enforce download ownership', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstoyou_test_'));
  const input = path.join(tmp, 'input.mp4');
  const generated = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-t', '7',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '12', input]);
  assert.equal(generated.status, 0, generated.stderr?.toString());
  const media = fs.readFileSync(input);
  const runtime = localServer();
  const server = runtime.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = { 'x-test-user': 'owner' };
  async function upload(accept, bytes = media) {
    const form = new FormData();
    form.append('video', new Blob([bytes], { type: 'video/mp4' }), 'Cámara 🔥.mp4');
    form.append('duracion', '2');
    return fetch(base + '/dividir', { method: 'POST', headers: { ...owner, Accept: accept }, body: form });
  }
  try {
    const prepared = await upload('application/json');
    assert.equal(prepared.status, 200);
    assert.match(prepared.headers.get('content-type'), /application\/json/);
    const data = await prepared.json();
    assert.equal(data.partes, 4);
    assert.match(data.downloadUrl, /^\/descargas-partes\/[a-f0-9-]+$/);
    assert.equal((await fetch(base + data.downloadUrl)).status, 401);
    assert.equal((await fetch(base + data.downloadUrl, { headers: { 'x-test-user': 'other' } })).status, 404);
    const downloaded = await fetch(base + data.downloadUrl, { headers: owner });
    assert.equal(downloaded.status, 200);
    assert.match(downloaded.headers.get('content-disposition'), /attachment/);
    const zip = Buffer.from(await downloaded.arrayBuffer());
    assert.equal(Number(downloaded.headers.get('content-length')), zip.length);
    assert.deepEqual(zipNames(zip), [1, 2, 3, 4].map(i => `Cámara 🔥 - parte ${i}.mp4`));
    const range = await fetch(base + data.downloadUrl, { headers: { ...owner, Range: 'bytes=0-31' } });
    assert.equal(range.status, 206);
    assert.equal((await range.arrayBuffer()).byteLength, 32);

    runtime.jobs916.set('converted-fixture', { owner: 'owner', status: 'done', outputFile: input, nombreOriginal: 'Vertical' });
    for (const url of ['/api/job916/converted-fixture', '/api/job916/converted-fixture/download']) {
      assert.equal((await fetch(base + url, { headers: { 'x-test-user': 'other' } })).status, 404);
    }
    const ajeno = await fetch(base + '/dividir-desde-916/converted-fixture', {
      method: 'POST', headers: { 'x-test-user': 'other', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duracion: 2 })
    });
    assert.equal(ajeno.status, 404);
    const converted = await fetch(base + '/dividir-desde-916/converted-fixture', {
      method: 'POST', headers: { ...owner, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ duracion: 2 })
    });
    assert.equal(converted.status, 200);
    const convertedData = await converted.json();
    const convertedZip = await fetch(base + convertedData.downloadUrl, { headers: owner });
    assert.deepEqual(zipNames(Buffer.from(await convertedZip.arrayBuffer())),
      [1, 2, 3, 4].map(i => `Vertical_9_16 - parte ${i}.mp4`));
    assert.ok(fs.existsSync(input), 'splitting a conversion must preserve the source video');

    const legacy = await upload('*/*');
    assert.equal(legacy.status, 200);
    assert.equal(zipNames(Buffer.from(await legacy.arrayBuffer())).length, 4);
    const invalid = await upload('application/json', Buffer.from('not a video'));
    assert.equal(invalid.status, 500);
    assert.ok((await invalid.json()).error);
    assert.equal((await fetch(base + '/api/usuario', { headers: owner })).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    runtime.splitDownloads.close();
    fs.unlinkSync(input);
    fs.rmdirSync(tmp);
  }
});

test('expired download links are rejected and their temporary ZIP is removed', async () => {
  let now = 100;
  const downloads = createSplitDownloads({ ttlMs: 10, now: () => now });
  const parts = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstoyou_test_'));
  fs.writeFileSync(path.join(parts, 'parte_00.mp4'), 'fixture');
  const app = express();
  app.use((req, res, next) => { req.user = { id: 'owner' }; next(); });
  app.use('/descargas-partes', downloads.router);
  app.post('/prepare', (req, res, next) => downloads.send(req, res, parts, 'test').catch(next));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(base + '/prepare', { method: 'POST', headers: { Accept: 'application/json' } });
    const data = await response.json();
    now = 111;
    assert.equal((await fetch(base + data.downloadUrl)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    downloads.close();
    fs.unlinkSync(path.join(parts, 'parte_00.mp4'));
    fs.rmdirSync(parts);
  }
});
