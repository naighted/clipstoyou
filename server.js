const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { spawn } = require('child_process');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const fs = require('fs');
const os = require('os');

const app = express();
const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

app.use(express.static('public'));

app.post('/dividir', upload.single('video'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se subió ningún video.' });
  }

  const duracion = parseInt(req.body.duracion);
  if (!duracion || duracion < 1) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Duración inválida.' });
  }

  const inputFile = req.file.path;
  const outputDir = path.join(os.tmpdir(), 'partes_' + Date.now());
  fs.mkdirSync(outputDir);

  const outputPattern = path.join(outputDir, 'parte_%02d.mp4');

  const args = [
    '-i', inputFile,
    '-c', 'copy',
    '-map', '0',
    '-segment_time', String(duracion),
    '-reset_timestamps', '1',
    '-f', 'segment',
    outputPattern
  ];

  const ffmpeg = spawn(FFMPEG, args);

  ffmpeg.on('close', (code) => {
    fs.unlinkSync(inputFile);

    if (code !== 0) {
      return res.status(500).json({ error: 'Error al procesar el video.' });
    }

    const partes = fs.readdirSync(outputDir)
      .filter(f => f.endsWith('.mp4'))
      .sort();

    if (partes.length === 0) {
      return res.status(500).json({ error: 'No se generaron partes.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="partes.zip"');

    const zip = archiver('zip');
    zip.pipe(res);

    partes.forEach(parte => {
      zip.file(path.join(outputDir, parte), { name: parte });
    });

    zip.finalize();

    zip.on('end', () => {
      partes.forEach(parte => fs.unlinkSync(path.join(outputDir, parte)));
      fs.rmdirSync(outputDir);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});
