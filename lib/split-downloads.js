const express = require('express');
const archiver = require('archiver');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');

// Keep ZIP data out of XMLHttpRequest/Blob storage in the browser. The POST
// returns a small JSON response; a normal download handles the resulting file.
function createSplitDownloads({ ttlMs = 30 * 60 * 1000, now = Date.now } = {}) {
  const downloads = new Map();
  const router = express.Router();

  function remove(entry) {
    downloads.delete(entry.id);
    try { fs.unlinkSync(entry.file); } catch (_) {}
    try { fs.rmdirSync(entry.directory); } catch (_) {}
  }

  function expire() {
    for (const entry of downloads.values()) {
      if (entry.expiresAt <= now() && entry.active === 0) remove(entry);
    }
  }

  const timer = setInterval(expire, 60 * 1000);
  timer.unref();

  function stream(res, entry) {
    entry.active++;
    res.setHeader('Cache-Control', 'private, no-store');
    return new Promise(resolve => {
      res.download(entry.file, 'partes.zip', err => {
        entry.active--;
        if (entry.expiresAt <= now() && entry.active === 0) remove(entry);
        if (err) {
          if (!res.headersSent && !res.destroyed) {
            res.status(500).json({ error: 'No se pudo descargar el ZIP. Inténtalo de nuevo.' });
          } else if (!res.destroyed) {
            res.destroy();
          }
        }
        resolve();
      });
    });
  }

  router.get('/:id', (req, res) => {
    if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión para descargar las partes.' });
    const entry = downloads.get(req.params.id);
    if (!entry || entry.owner !== String(req.user.id) || entry.expiresAt <= now()) {
      expire();
      return res.status(404).json({ error: 'La descarga ha caducado. Vuelve a dividir el video.' });
    }
    return stream(res, entry);
  });

  async function send(req, res, directory, baseName) {
    const parts = fs.readdirSync(directory).filter(name => name.endsWith('.mp4')).sort();
    if (!parts.length) throw new Error('No se generaron partes.');
    const zipDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'clipstoyou_zip_'));
    const entry = {
      id: crypto.randomUUID(), owner: String(req.user.id),
      directory: zipDirectory, file: path.join(zipDirectory, 'partes.zip'),
      active: 0, expiresAt: 0
    };
    // MP4 is already compressed. STORE avoids recompressing hundreds of MB.
    // statConcurrency 1 keeps ZIP entries in part order (parallel stats reorder them).
    const zip = archiver('zip', { store: true, statConcurrency: 1 });
    const output = fs.createWriteStream(entry.file, { flags: 'wx' });
    const writing = pipeline(zip, output);
    // A source-file warning must fail the whole download, not produce a ZIP
    // with missing clips. pipeline also propagates disk-full and stream errors.
    zip.on('warning', err => zip.destroy(err));
    const safeName = baseName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || 'video';
    try {
      parts.forEach((part, i) => zip.file(path.join(directory, part), {
        name: `${safeName} - parte ${i + 1}.mp4`
      }));
      await Promise.all([writing, zip.finalize()]);
      entry.expiresAt = now() + ttlMs;
      downloads.set(entry.id, entry);
      if (req.get('Accept')?.includes('application/json')) {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ downloadUrl: `/descargas-partes/${entry.id}`, partes: parts.length });
      } else {
        // Tabs opened before deployment can still receive a ZIP response.
        await stream(res, entry);
      }
    } catch (err) {
      zip.destroy();
      await writing.catch(() => {});
      remove(entry);
      throw err;
    }
  }

  return { router, send, expire, close() { clearInterval(timer); for (const entry of downloads.values()) remove(entry); } };
}

module.exports = { createSplitDownloads };
