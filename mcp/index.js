#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Agent, FormData, fetch } from 'undici';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';

const BASE = (process.env.CLIPSTOYOU_URL || 'https://www.clipstoyou.com').replace(/\/+$/, '');
const KEY = process.env.CLIPSTOYOU_API_KEY;
const EXTENSIONES = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const CARPETA_916 = 'Videos 9-16';
const CARPETA_CLIPS = 'Clips';
const DURACION_PARTE_DEFECTO = 120;
const MAX_ESPERA_CONVERSION_MS = 3 * 60 * 60 * 1000;

// Multi-GB uploads can take longer than undici's default 5-minute timeouts.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

async function api(ruta, opciones = {}) {
  if (!KEY) throw new Error(`Falta la clave API. Genera una en ${BASE}/api-docs y ponla en CLIPSTOYOU_API_KEY.`);
  const res = await fetch(BASE + ruta, {
    ...opciones,
    dispatcher,
    headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', ...opciones.headers }
  });
  if (!res.ok) {
    let mensaje;
    try { mensaje = (await res.json()).error; } catch (_) {}
    throw new Error(mensaje || `ClipsToYou respondió ${res.status}.`);
  }
  return res;
}

async function descargar(ruta, destino) {
  const res = await api(ruta, { headers: { Accept: '*/*' } });
  const temporal = destino + '.descargando';
  try {
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(temporal));
    await fsp.rename(temporal, destino);
  } catch (err) {
    await fsp.rm(temporal, { force: true });
    throw err;
  }
}

function extraerClips(zipPath, destino, nombre) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err) return reject(err);
      const clips = [];
      zip.on('error', reject);
      zip.on('end', () => resolve(clips.sort((a, b) => a.parte - b.parte)));
      zip.on('entry', entry => {
        // Output names come only from the part number, never from paths inside the ZIP.
        const m = entry.fileName.match(/parte (\d+)\.mp4$/);
        if (!m) return zip.readEntry();
        const parte = Number(m[1]);
        const archivo = path.join(destino, `${nombre} - parte ${parte}.mp4`);
        zip.openReadStream(entry, (err, stream) => {
          if (err) return reject(err);
          pipeline(stream, fs.createWriteStream(archivo))
            .then(() => { clips.push({ parte, archivo }); zip.readEntry(); }, reject);
        });
      });
      zip.readEntry();
    });
  });
}

const espera = ms => new Promise(r => setTimeout(r, ms));

const tareas = new Map();
let cola = Promise.resolve();

async function procesar(t) {
  const nombre = path.parse(t.video).name;
  t.estado = 'en curso';

  t.etapa = 'subiendo el vídeo a ClipsToYou';
  const form = new FormData();
  form.append('video', await fs.openAsBlob(t.video), path.basename(t.video));
  form.append('modoCam', t.modo);
  const { jobId } = await (await api('/convertir-916', { method: 'POST', body: form })).json();

  t.etapa = 'convirtiendo a 9:16';
  const limite = Date.now() + MAX_ESPERA_CONVERSION_MS;
  let job;
  do {
    await espera(5000);
    job = await (await api(`/api/job916/${jobId}`)).json();
    if (job.status === 'error') throw new Error(job.error || 'La conversión falló.');
    if (Date.now() > limite) throw new Error('La conversión está tardando demasiado.');
  } while (job.status !== 'done');

  t.etapa = 'descargando el vídeo 9:16';
  await fsp.mkdir(t.carpeta916, { recursive: true });
  const video916 = path.join(t.carpeta916, nombre + '.mp4');
  await descargar(`/api/job916/${jobId}/download`, video916);
  t.resultado = { video916, duracionSegundos: job.duracionSegundos };

  let duracion = t.duracionParte;
  if (!duracion) {
    if (!job.duracionSegundos) throw new Error('No se pudo leer la duración del vídeo; indica duracion_parte_segundos en lugar de numero_partes.');
    duracion = Math.ceil(job.duracionSegundos / t.numeroPartes);
  }

  t.etapa = 'dividiendo en partes';
  const { downloadUrl } = await (await api(`/dividir-desde-916/${jobId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duracion })
  })).json();

  t.etapa = 'descargando los clips';
  const carpetaClips = path.join(t.carpetaClips, nombre);
  await fsp.mkdir(carpetaClips, { recursive: true });
  const zip = path.join(os.tmpdir(), `clipstoyou_${t.id}.zip`);
  try {
    await descargar(downloadUrl, zip);
    const clips = await extraerClips(zip, carpetaClips, nombre);
    t.resultado = { ...t.resultado, duracionParteSegundos: duracion, carpetaClips, clips };
  } finally {
    await fsp.rm(zip, { force: true });
  }

  t.estado = 'terminado';
  t.etapa = null;
}

function encolar(t) {
  tareas.set(t.id, t);
  cola = cola.then(() => procesar(t)).catch(err => {
    t.estado = 'error';
    t.error = err.message;
    console.error(`[clipstoyou] ${path.basename(t.video)}: ${err.message}`);
  }).finally(() => { t.terminadaEn = new Date().toISOString(); });
}

function resumen(t) {
  const { id, video, modo, estado, etapa, error, resultado, creadaEn, terminadaEn } = t;
  return { id, video, modo, estado, etapa, error, resultado, creadaEn, terminadaEn };
}

const json = datos => ({ content: [{ type: 'text', text: JSON.stringify(datos, null, 2) }] });
const fallo = mensaje => ({ isError: true, content: [{ type: 'text', text: mensaje }] });

const server = new McpServer({ name: 'clipstoyou', version: '1.0.0' });

server.registerTool('listar_videos_pendientes', {
  title: 'Listar vídeos pendientes',
  description: 'Lista los vídeos de una carpeta que todavía no se han pasado a 9:16 (no existe un vídeo con el mismo nombre en la carpeta de 9:16) y que no se están procesando ahora.',
  inputSchema: {
    carpeta_entrada: z.string().describe('Ruta absoluta de la carpeta con los vídeos originales, p. ej. C:\\Users\\yo\\Videos\\YouTube'),
    carpeta_916: z.string().optional().describe(`Carpeta donde se guardan los vídeos 9:16. Por defecto "<carpeta_entrada>\\${CARPETA_916}".`)
  }
}, async ({ carpeta_entrada, carpeta_916 }) => {
  const destino = carpeta_916 || path.join(carpeta_entrada, CARPETA_916);
  let entradas;
  try { entradas = await fsp.readdir(carpeta_entrada, { withFileTypes: true }); }
  catch (err) { return fallo(`No se pudo leer la carpeta: ${err.message}`); }
  const enCurso = new Set([...tareas.values()].filter(t => t.estado !== 'error').map(t => t.video));
  const pendientes = [];
  for (const e of entradas) {
    if (!e.isFile() || !EXTENSIONES.has(path.extname(e.name).toLowerCase())) continue;
    const ruta = path.join(carpeta_entrada, e.name);
    if (enCurso.has(ruta) || fs.existsSync(path.join(destino, path.parse(e.name).name + '.mp4'))) continue;
    const { size, mtime } = await fsp.stat(ruta);
    pendientes.push({ ruta, tamanoMB: Math.round(size / 1048576), modificado: mtime.toISOString() });
  }
  return json({ carpeta916: destino, pendientes });
});

server.registerTool('procesar_video', {
  title: 'Convertir a 9:16 y dividir en clips',
  description: [
    'Sube un vídeo local a ClipsToYou, lo convierte a 9:16, guarda el vídeo 9:16 con el mismo nombre en la carpeta de 9:16,',
    'lo divide en partes y guarda los clips como "<nombre> - parte N.mp4" en "<carpeta_clips>\\<nombre>".',
    'Se ejecuta en segundo plano y devuelve un id: consulta su avance con estado_proceso cada 30-60 segundos.',
    'Un vídeo de 10 minutos puede tardar varios minutos según la conexión. Los vídeos se procesan de uno en uno.',
    `Si el usuario no indica cómo dividir, se usan partes de ${DURACION_PARTE_DEFECTO} segundos.`,
    'Si el vídeo se graba en este momento, espera a que el archivo deje de cambiar de tamaño antes de procesarlo.'
  ].join(' '),
  inputSchema: {
    ruta_video: z.string().describe('Ruta absoluta del vídeo original (mp4, mov, avi, mkv o webm).'),
    modo: z.enum(['blur', 'sin-cam']).default('blur').describe('blur: vídeo completo sobre fondo desenfocado. sin-cam: recorte centrado a pantalla completa.'),
    duracion_parte_segundos: z.number().int().min(5).optional().describe('Duración de cada clip en segundos.'),
    numero_partes: z.number().int().min(1).max(100).optional().describe('Alternativa a duracion_parte_segundos: número de clips iguales.'),
    carpeta_916: z.string().optional().describe(`Carpeta para el vídeo 9:16. Por defecto "${CARPETA_916}" junto al vídeo original.`),
    carpeta_clips: z.string().optional().describe(`Carpeta para los clips. Por defecto "${CARPETA_CLIPS}" junto al vídeo original.`)
  }
}, async ({ ruta_video, modo, duracion_parte_segundos, numero_partes, carpeta_916, carpeta_clips }) => {
  const video = path.resolve(ruta_video);
  if (!EXTENSIONES.has(path.extname(video).toLowerCase())) return fallo('Formato no soportado. Usa mp4, mov, avi, mkv o webm.');
  try {
    if (!(await fsp.stat(video)).isFile()) return fallo('La ruta no es un archivo.');
  } catch (_) {
    return fallo(`No existe el archivo: ${video}`);
  }
  if (duracion_parte_segundos && numero_partes) return fallo('Indica duracion_parte_segundos o numero_partes, no ambos.');
  const repetida = [...tareas.values()].find(t => t.video === video && t.estado !== 'error' && t.estado !== 'terminado');
  if (repetida) return json({ aviso: 'Este vídeo ya se está procesando.', tarea: resumen(repetida) });

  const carpeta = path.dirname(video);
  const t = {
    id: crypto.randomUUID().slice(0, 8),
    video, modo,
    duracionParte: duracion_parte_segundos || (numero_partes ? null : DURACION_PARTE_DEFECTO),
    numeroPartes: numero_partes || null,
    carpeta916: carpeta_916 ? path.resolve(carpeta_916) : path.join(carpeta, CARPETA_916),
    carpetaClips: carpeta_clips ? path.resolve(carpeta_clips) : path.join(carpeta, CARPETA_CLIPS),
    estado: 'en cola', etapa: null, error: null, resultado: null,
    creadaEn: new Date().toISOString(), terminadaEn: null
  };
  encolar(t);
  return json({ id: t.id, estado: t.estado, carpeta916: t.carpeta916, carpetaClips: path.join(t.carpetaClips, path.parse(video).name) });
});

server.registerTool('estado_proceso', {
  title: 'Estado del procesamiento',
  description: 'Devuelve el estado de un procesamiento (o de todos si no se indica id): en cola, en curso (con la etapa actual), terminado (con la ruta del vídeo 9:16 y la lista de clips en orden) o error.',
  inputSchema: { id: z.string().optional().describe('Id devuelto por procesar_video.') }
}, async ({ id }) => {
  if (!id) return json([...tareas.values()].map(resumen));
  const t = tareas.get(id);
  return t ? json(resumen(t)) : fallo('No existe ningún procesamiento con ese id en esta sesión.');
});

server.registerTool('estado_cuenta', {
  title: 'Cuenta de ClipsToYou',
  description: 'Muestra el plan de la cuenta de ClipsToYou asociada a la clave API y los usos restantes.',
  inputSchema: {}
}, async () => {
  try {
    const u = await (await api('/api/usuario')).json();
    if (!u.autenticado) return fallo('La clave API no es válida.');
    const { nombre, email, plan, isAdmin, limite, restantes } = u;
    return json({ nombre, email, plan: isAdmin ? 'admin' : plan, divisionesRestantesHoy: restantes, limiteDiario: limite });
  } catch (err) {
    return fallo(err.message);
  }
});

await server.connect(new StdioServerTransport());
console.error(`[clipstoyou] Conector listo (${BASE})${KEY ? '' : ' — falta CLIPSTOYOU_API_KEY'}`);
