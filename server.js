require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { createSplitDownloads } = require('./lib/split-downloads');
const { spawn } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { createClient } = require('@supabase/supabase-js');
const ffmpegStatic = require('ffmpeg-static');
const Stripe = require('stripe');

const app = express();
const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';
const LIMITE_DIARIO = 3;
const PRECIO_PRO = 'price_1TIC9LBtHufgQ6dgLwEhA7NM';
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 días
};

if (process.env.DATABASE_URL) {
  sessionConfig.store = new pgSession({
    conString: process.env.DATABASE_URL,
    tableName: 'sessions',
    createTableIfMissing: true
  });
}

app.use(session(sessionConfig));

// Redirect Railway domain to production domain
app.use((req, res, next) => {
  if (req.hostname && req.hostname.includes('railway.app')) {
    return res.redirect(301, 'https://www.clipstoyou.com' + req.url);
  }
  next();
});

app.use(passport.initialize());
app.use(passport.session());

// ─── CLAVES API ──────────────────────────────────────────────────
const API_KEY_PREFIX = 'ctu_';
const MAX_API_KEYS = 5;
const hashApiKey = key => crypto.createHash('sha256').update(key).digest('hex');
const ERROR_API_PLAN = 'La API está disponible en los planes Pro y Pro Max.';
const tieneAccesoApi = u => u.email === (process.env.ADMIN_EMAIL || 'felixfernandezcardenas@hotmail.com')
  || ['pro', 'promax'].includes(u.plan);

app.use(async (req, res, next) => {
  const auth = req.get('Authorization') || '';
  if (!auth.startsWith('Bearer ')) return next();
  const key = auth.slice(7).trim();
  if (!key.startsWith(API_KEY_PREFIX)) return res.status(401).json({ error: 'Clave API inválida.' });

  const { data: apiKey, error } = await supabase
    .from('api_keys').select('*').eq('key_hash', hashApiKey(key)).maybeSingle();
  if (error) {
    console.error('API key lookup:', error.message);
    return res.status(503).json({ error: 'No se pudo verificar la clave API. Inténtalo de nuevo.' });
  }
  if (!apiKey) return res.status(401).json({ error: 'Clave API inválida o eliminada.' });
  if (apiKey.activa === false) return res.status(403).json({ error: 'Esta clave API está pausada.' });

  const { data: usuario } = await supabase.from('usuarios').select('*').eq('id', apiKey.usuario_id).single();
  if (!usuario) return res.status(401).json({ error: 'Clave API inválida o eliminada.' });
  if (!tieneAccesoApi(usuario)) return res.status(403).json({ error: ERROR_API_PLAN });

  req.user = usuario;
  req.viaApiKey = true;
  supabase.from('api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', apiKey.id).then(() => {});
  next();
});

// Keys can only be managed from a logged-in browser session, never with another key.
function soloSesionWeb(req, res, next) {
  if (!req.user || req.viaApiKey) return res.status(401).json({ error: 'Inicia sesión en la web para gestionar tus claves API.' });
  next();
}

// select('*') keeps working whether or not the optional "activa" column exists yet.
const clavePublica = ({ id, nombre, prefijo, created_at, last_used_at, activa }) =>
  ({ id, nombre, prefijo, created_at, last_used_at, activa: activa !== false });

app.get('/api/keys', soloSesionWeb, async (req, res) => {
  const { data, error } = await supabase
    .from('api_keys').select('*')
    .eq('usuario_id', req.user.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'No se pudieron cargar las claves.' });
  res.json(data.map(clavePublica));
});

app.patch('/api/keys/:id', soloSesionWeb, express.json(), async (req, res) => {
  if (typeof req.body?.activa !== 'boolean') return res.status(400).json({ error: 'Valor inválido.' });
  const { error } = await supabase.from('api_keys')
    .update({ activa: req.body.activa }).eq('id', req.params.id).eq('usuario_id', req.user.id);
  if (error) return res.status(500).json({ error: 'No se pudo actualizar la clave.' });
  res.json({ ok: true });
});

app.post('/api/keys', soloSesionWeb, express.json(), async (req, res) => {
  if (!tieneAccesoApi(req.user)) return res.status(403).json({ error: ERROR_API_PLAN });
  const { count, error: countError } = await supabase
    .from('api_keys').select('id', { count: 'exact', head: true }).eq('usuario_id', req.user.id);
  if (countError) return res.status(500).json({ error: 'No se pudo crear la clave.' });
  if (count >= MAX_API_KEYS) return res.status(400).json({ error: `Máximo ${MAX_API_KEYS} claves. Elimina alguna antes de crear otra.` });

  const nombre = String(req.body?.nombre || '').trim().slice(0, 50) || 'Mi clave';
  const key = API_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
  const { data, error } = await supabase.from('api_keys')
    .insert([{ usuario_id: req.user.id, nombre, prefijo: key.slice(0, 10), key_hash: hashApiKey(key) }])
    .select('*').single();
  if (error) return res.status(500).json({ error: 'No se pudo crear la clave.' });
  res.json({ ...clavePublica(data), key });
});

app.delete('/api/keys/:id', soloSesionWeb, async (req, res) => {
  const { error } = await supabase.from('api_keys').delete().eq('id', req.params.id).eq('usuario_id', req.user.id);
  if (error) return res.status(500).json({ error: 'No se pudo eliminar la clave.' });
  res.json({ ok: true });
});

const CALLBACK_URL = process.env.CALLBACK_URL || 'http://localhost:3000/auth/google/callback';

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: CALLBACK_URL
}, async (accessToken, refreshToken, profile, done) => {
  try {
    const googleId = profile.id;
    const email = profile.emails[0].value;
    const nombre = profile.displayName;

    let { data: usuario } = await supabase
      .from('usuarios')
      .select('*')
      .eq('google_id', googleId)
      .single();

    if (!usuario) {
      const { data: nuevo } = await supabase
        .from('usuarios')
        .insert([{ google_id: googleId, email, nombre }])
        .select()
        .single();
      usuario = nuevo;
    }

    return done(null, usuario);
  } catch (err) {
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));

passport.deserializeUser(async (id, done) => {
  const { data } = await supabase
    .from('usuarios')
    .select('*')
    .eq('id', id)
    .single();
  done(null, data);
});

app.use(express.static('public'));

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => res.redirect('/')
);

app.get('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/usuario', async (req, res) => {
  if (!req.user) return res.json({ autenticado: false });

  const hoy = new Date().toISOString().split('T')[0];
  if (req.user.ultimo_reset !== hoy) {
    await supabase
      .from('usuarios')
      .update({ usos_hoy: 0, ultimo_reset: hoy })
      .eq('id', req.user.id);
    req.user.usos_hoy = 0;
  }

  const esAdminReq = req.user.email === (process.env.ADMIN_EMAIL || 'felixfernandezcardenas@hotmail.com');
  res.json({
    autenticado: true,
    nombre: req.user.nombre,
    email: req.user.email,
    plan: req.user.plan,
    isAdmin: esAdminReq,
    usos_hoy: req.user.usos_hoy,
    limite: esAdminReq ? null : LIMITE_DIARIO,
    restantes: esAdminReq ? null : Math.max(0, LIMITE_DIARIO - req.user.usos_hoy)
  });
});

// ─── ADMIN ───────────────────────────────────────────────────────
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'felixfernandezcardenas@hotmail.com';
function esAdmin(req, res, next) {
  if (!req.user || req.user.email !== ADMIN_EMAIL) return res.status(403).json({ error: 'Acceso denegado' });
  next();
}

app.get('/admin', (req, res) => {
  if (!req.user || req.user.email !== ADMIN_EMAIL) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/admin/stats', esAdmin, async (req, res) => {
  const { data: usuarios } = await supabase
    .from('usuarios').select('id, nombre, email, plan, usos_hoy, total_usos, conversion_gratis_usada')
    .order('total_usos', { ascending: false, nullsFirst: false });
  const total = usuarios?.length || 0;
  const pro = usuarios?.filter(u => u.plan === 'pro').length || 0;
  const promax = usuarios?.filter(u => u.plan === 'promax').length || 0;
  const totalClips = usuarios?.reduce((s, u) => s + (u.total_usos || 0), 0) || 0;
  res.json({ usuarios: usuarios || [], totalUsuarios: total, totalPro: pro, totalProMax: promax, totalFree: total - pro - promax, totalClips });
});

app.get('/api/admin/sugerencias', esAdmin, async (req, res) => {
  const { data } = await supabase.from('sugerencias').select('*').order('fecha', { ascending: false });
  res.json(data || []);
});

app.patch('/api/admin/sugerencias/:id', esAdmin, async (req, res) => {
  await supabase.from('sugerencias').update({ leida: true }).eq('id', req.params.id);
  res.json({ ok: true });
});

app.post('/api/sugerencia', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  const texto = (req.body?.texto || '').trim();
  if (texto.length < 5) return res.status(400).json({ error: 'Escribe al menos 5 caracteres.' });
  if (texto.length > 1000) return res.status(400).json({ error: 'Máximo 1000 caracteres.' });
  await supabase.from('sugerencias').insert([{
    usuario_id: req.user.id, nombre: req.user.nombre, email: req.user.email, texto
  }]);
  res.json({ ok: true });
});

// Crear sesión de pago Stripe
app.post('/crear-checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });

  const planType = req.query.plan === 'promax' ? 'promax' : 'pro';
  const planInfo = planType === 'promax'
    ? { name: 'ClipsToYou Pro Max', amount: 999 }
    : { name: 'ClipsToYou Pro', amount: 499 };

  const BASE = process.env.CALLBACK_URL
    ? process.env.CALLBACK_URL.replace('/auth/google/callback', '')
    : 'http://localhost:3000';

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: planInfo.name },
          unit_amount: planInfo.amount,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      customer_email: req.user.email,
      metadata: { usuario_id: req.user.id, plan: planType },
      success_url: `${BASE}/?pago=ok&plan=${planType}`,
      cancel_url: `${BASE}/?pago=cancelado`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Error Stripe checkout:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Webhook de Stripe (suscripción activada/cancelada)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const planNuevo = s.metadata?.plan === 'promax' ? 'promax' : 'pro';
    await supabase.from('usuarios').update({
      plan: planNuevo,
      stripe_customer_id: s.customer,
      stripe_subscription_id: s.subscription
    }).eq('id', s.metadata.usuario_id);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supabase.from('usuarios').update({ plan: 'free' })
      .eq('stripe_subscription_id', sub.id);
  }

  res.json({ received: true });
});

// Portal de cliente (cancelar/gestionar suscripción)
app.post('/portal', async (req, res) => {
  if (!req.user || !req.user.stripe_customer_id) return res.status(400).json({ error: 'Sin suscripción' });

  const BASE = process.env.CALLBACK_URL
    ? process.env.CALLBACK_URL.replace('/auth/google/callback', '')
    : 'http://localhost:3000';

  const portal = await stripe.billingPortal.sessions.create({
    customer: req.user.stripe_customer_id,
    return_url: BASE,
  });

  res.json({ url: portal.url });
});

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }
});

const splitDownloads = createSplitDownloads();
app.use('/descargas-partes', splitDownloads.router);

function cleanSplitParts(directory) {
  // Only remove clips generated in this request's own temporary folder.
  try {
    for (const name of fs.readdirSync(directory)) {
      if (name.endsWith('.mp4')) fs.unlinkSync(path.join(directory, name));
    }
    fs.rmdirSync(directory);
  } catch (_) {}
}

function duracionDeLog(log) {
  const m = log.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Math.round(+m[1] * 3600 + +m[2] * 60 + +m[3]) : null;
}

function leerInfoVideo(file) {
  return new Promise(resolve => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-i', file]);
    let log = '';
    proc.stderr.on('data', d => { log += d; });
    proc.on('error', () => resolve({}));
    proc.on('close', () => {
      const res = log.match(/Video:.*?(\d{2,5})x(\d{2,5})/);
      resolve({ duracion: duracionDeLog(log), ancho: res ? +res[1] : null, alto: res ? +res[2] : null });
    });
  });
}

// Lets API clients pick "webcam in a corner" instead of drawing the crop box in the browser.
const ESQUINAS_CAM = ['arriba-izquierda', 'arriba-derecha', 'abajo-izquierda', 'abajo-derecha'];
function coordsCamEsquina(esquina, tamano, ancho, alto) {
  const fraccion = { pequena: 0.2, mediana: 0.28, grande: 0.36 }[tamano] || 0.28;
  const w = Math.round(ancho * fraccion);
  const h = Math.min(alto, Math.round(w * 9 / 16));
  return [esquina.endsWith('derecha') ? ancho - w : 0, esquina.startsWith('abajo') ? alto - h : 0, w, h];
}

// In-memory job store for background video processing
const jobs916 = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs916.entries()) {
    if (job.status === 'processing') continue;
    if ((job.finishedAt || job.createdAt) < cutoff) {
      if (job.outputFile) try { fs.unlinkSync(job.outputFile); } catch(e) {}
      jobs916.delete(id);
    }
  }
}, 15 * 60 * 1000);

// Convertir video a formato 9:16 — devuelve jobId inmediatamente, procesa en background
app.post('/convertir-916', upload.single('video'), async (req, res) => {
  if (!req.user) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Debes iniciar sesión.' });
  }

  const esAdminUser = req.user.email === ADMIN_EMAIL;
  if (!esAdminUser) {
    const plan = req.user.plan || 'free';
    if (plan === 'free') {
      if ((req.user.conversiones_916_total || 0) >= 2) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(429).json({ error: 'Has usado tus 2 conversiones gratuitas. Actualiza a Pro para 7/semana o Pro Max para ilimitadas.', tipo: 'limite_free' });
      }
    } else if (plan === 'pro') {
      const hoy = new Date().toISOString().split('T')[0];
      const diasDesdeReset = req.user.reset_916_semana
        ? Math.floor((new Date(hoy) - new Date(req.user.reset_916_semana)) / 86400000)
        : 999;
      if (diasDesdeReset >= 7) {
        await supabase.from('usuarios').update({ conversiones_916_semana: 0, reset_916_semana: hoy }).eq('id', req.user.id);
        req.user.conversiones_916_semana = 0;
      }
      if ((req.user.conversiones_916_semana || 0) >= 7) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(429).json({ error: 'Límite semanal de 7 conversiones alcanzado. Vuelve el lunes o actualiza a Pro Max para ilimitadas.', tipo: 'limite_pro' });
      }
    }
  }

  if (!req.file) return res.status(400).json({ error: 'No se subió ningún video.' });

  const modoCam = ['sin-cam', 'blur'].includes(req.body.modoCam) ? req.body.modoCam : 'con-cam';
  const inputFile = req.file.path;
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const outputFile = path.join(os.tmpdir(), 'v916_' + jobId + '.mp4');
  // Keyframe every second: splitting later uses -c copy, which can only cut on keyframes.
  let args;

  if (modoCam === 'blur') {
    const filterComplex = [
      '[0:v]scale=270:480:force_original_aspect_ratio=increase,crop=270:480,gblur=sigma=8,scale=1080:1920[bg]',
      '[0:v]scale=1080:1920:force_original_aspect_ratio=decrease[fg]',
      '[bg][fg]overlay=(W-w)/2:(H-h)/2[out]'
    ].join(';');
    args = ['-i', inputFile, '-filter_complex', filterComplex, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-y', outputFile];
  } else if (modoCam === 'sin-cam') {
    const cropCoords = ['cropX','cropY','cropW','cropH'].map(k => Math.round(Number(req.body[k])));
    let filtro;
    if (cropCoords.every(v => !isNaN(v) && v >= 0) && cropCoords[2] > 0 && cropCoords[3] > 0) {
      const [crX, crY, crW, crH] = cropCoords;
      filtro = `crop=${crW}:${crH}:${crX}:${crY},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
    } else {
      filtro = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
    }
    args = ['-i', inputFile, '-vf', filtro, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-c:a', 'aac', '-b:a', '128k', '-y', outputFile];
  } else {
    let camCoords = ['camX','camY','camW','camH'].map(k => Math.round(Number(req.body[k])));
    let videoW = Math.round(Number(req.body.videoW)) || 0;
    let videoH = Math.round(Number(req.body.videoH)) || 0;
    if (camCoords.some(isNaN) && ESQUINAS_CAM.includes(req.body.camEsquina)) {
      const info = await leerInfoVideo(inputFile);
      if (info.ancho && info.alto) {
        videoW = info.ancho;
        videoH = info.alto;
        camCoords = coordsCamEsquina(req.body.camEsquina, req.body.camTamano, videoW, videoH);
      }
    }
    if (camCoords.some(isNaN) || camCoords.some(v => v < 0)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Coordenadas inválidas.' });
    }
    const [cx, cy, cw, ch] = camCoords;
    const camPosicion = req.body.camPosicion === 'arriba' ? 'arriba' : 'abajo';

    const filtroCam = `crop=${cw}:${ch}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;
    let filtroGameplay = `scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;

    const gpCoords = ['gpX','gpY','gpW','gpH'].map(k => Math.round(Number(req.body[k])));
    if (gpCoords.every(v => !isNaN(v) && v >= 0) && gpCoords[2] > 0 && gpCoords[3] > 0) {
      const [gx, gy, gw, gh] = gpCoords;
      filtroGameplay = `crop=${gw}:${gh}:${gx}:${gy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;
    } else if (videoW > 0 && videoH > 0) {
      const candidates = [
        { x: 0,     y: 0,      w: videoW,       h: cy           },
        { x: 0,     y: cy+ch,  w: videoW,       h: videoH-cy-ch },
        { x: 0,     y: 0,      w: cx,           h: videoH       },
        { x: cx+cw, y: 0,      w: videoW-cx-cw, h: videoH       },
      ].filter(r => r.w > videoW * 0.15 && r.h > videoH * 0.15);
      if (candidates.length > 0) {
        const best = candidates.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b));
        filtroGameplay = `crop=${best.w}:${best.h}:${best.x}:${best.y},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;
      }
    }

    const topFilter = camPosicion === 'arriba' ? filtroCam : filtroGameplay;
    const botFilter = camPosicion === 'arriba' ? filtroGameplay : filtroCam;
    const filterComplex = [`[0:v]${topFilter}[top]`, `[0:v]${botFilter}[bot]`, `[top][bot]vstack=inputs=2[out]`].join(';');
    args = ['-i', inputFile, '-filter_complex', filterComplex, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-force_key_frames', 'expr:gte(t,n_forced*1)', '-y', outputFile];
  }

  const originalName916Decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const nombreOriginal916 = path.parse(originalName916Decoded).name.replace(/[\\/:*?"<>|]/g, '').trim() || 'video';

  // Register job and respond immediately — no timeout possible
  jobs916.set(jobId, { owner: String(req.user.id), status: 'processing', createdAt: Date.now(), outputFile: null, error: null, nombreOriginal: nombreOriginal916 });
  res.json({ jobId });

  // Process in background
  const ffmpeg = spawn(FFMPEG, args);
  let stderrLog = '';
  ffmpeg.stderr.on('data', d => { stderrLog += d.toString(); });

  ffmpeg.on('close', async (code) => {
    try { fs.unlinkSync(inputFile); } catch(e) {}
    if (code !== 0) {
      console.error('FFmpeg 9:16 error (code', code, '):', stderrLog.slice(-500));
      jobs916.set(jobId, { ...jobs916.get(jobId), status: 'error', finishedAt: Date.now(), error: 'Error al convertir. Código: ' + code });
      return;
    }

    if (!esAdminUser) {
      const plan = req.user.plan || 'free';
      const hoy = new Date().toISOString().split('T')[0];
      if (plan === 'free') {
        await supabase.from('usuarios').update({ conversiones_916_total: (req.user.conversiones_916_total || 0) + 1 }).eq('id', req.user.id);
      } else if (plan === 'pro') {
        await supabase.from('usuarios').update({
          conversiones_916_semana: (req.user.conversiones_916_semana || 0) + 1,
          reset_916_semana: req.user.reset_916_semana || hoy
        }).eq('id', req.user.id);
      }
    }

    const duracionSegundos = duracionDeLog(stderrLog);
    jobs916.set(jobId, { ...jobs916.get(jobId), status: 'done', finishedAt: Date.now(), outputFile, duracionSegundos });
  });
});

function jobDelUsuario(req) {
  const job = jobs916.get(req.params.jobId);
  return job && req.user && job.owner === String(req.user.id) ? job : null;
}

app.get('/api/job916/:jobId', (req, res) => {
  const job = jobDelUsuario(req);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json({ status: job.status, error: job.error, duracionSegundos: job.duracionSegundos ?? null });
});

app.get('/api/job916/:jobId/download', (req, res) => {
  const job = jobDelUsuario(req);
  if (!job || job.status !== 'done' || !job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: 'No disponible' });
  }
  const nombreDescarga = (job.nombreOriginal || 'video') + '_9_16.mp4';
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="video_9_16.mp4"; filename*=UTF-8''${encodeURIComponent(nombreDescarga)}`);
  const stream = fs.createReadStream(job.outputFile);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

app.post('/dividir', upload.single('video'), async (req, res) => {
  if (!req.user) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(401).json({ error: 'Debes iniciar sesión para usar esta función.' });
  }

  const hoy = new Date().toISOString().split('T')[0];
  let usos = req.user.usos_hoy || 0;

  if (req.user.ultimo_reset !== hoy) {
    usos = 0;
    await supabase.from('usuarios').update({ usos_hoy: 0, ultimo_reset: hoy }).eq('id', req.user.id);
  }

  const esAdminDiv = req.user.email === ADMIN_EMAIL;
  if (!esAdminDiv && req.user.plan === 'free' && usos >= LIMITE_DIARIO) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(429).json({ error: `Has alcanzado el límite de ${LIMITE_DIARIO} videos gratis hoy. Vuelve mañana.` });
  }

  if (!req.file) return res.status(400).json({ error: 'No se subió ningún video.' });

  let duracion = parseInt(req.body.duracion);
  const partes = parseInt(req.body.partes);
  if (!duracion && partes >= 1) {
    const total = (await leerInfoVideo(req.file.path)).duracion;
    if (total) duracion = Math.ceil(total / partes);
  }
  if (!duracion || duracion < 1) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Duración inválida.' });
  }

  const inputFile = req.file.path;
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partes_'));
  const outputPattern = path.join(outputDir, 'parte_%02d.mp4');

  const args = [
    '-i', inputFile, '-c', 'copy', '-map', '0',
    '-segment_time', String(duracion), '-reset_timestamps', '1',
    '-f', 'segment', outputPattern
  ];

  const ffmpeg = spawn(FFMPEG, args);
  // Consume progress output so FFmpeg cannot block on a full stderr pipe.
  ffmpeg.stderr.resume();
  ffmpeg.on('error', err => {
    console.error('FFmpeg dividir:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo iniciar el procesamiento del video.' });
  });

  ffmpeg.on('close', async (code) => {
    try { fs.unlinkSync(inputFile); } catch (_) {}
    try {
      if (res.headersSent || res.destroyed) return;
      if (code !== 0) return res.status(500).json({ error: 'Error al procesar el video.' });
      const { data: u } = await supabase.from('usuarios').select('total_usos').eq('id', req.user.id).single();
      await supabase.from('usuarios')
        .update({ usos_hoy: usos + 1, ultimo_reset: hoy, total_usos: (u?.total_usos || 0) + 1 })
        .eq('id', req.user.id);
      const decoded = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      await splitDownloads.send(req, res, outputDir, path.parse(decoded).name);
    } catch (err) {
      console.error('ZIP dividir:', err.message);
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'No se pudo preparar el ZIP. Inténtalo de nuevo.' });
    } finally {
      cleanSplitParts(outputDir);
    }
  });
});

// ─── PÁGINAS LEGALES ─────────────────────────────────────────────────────────
app.get('/terminos', (req, res) => res.sendFile(path.join(__dirname, 'public', 'terminos.html')));
app.get('/privacidad', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacidad.html')));
app.get('/cookies', (req, res) => res.sendFile(path.join(__dirname, 'public', 'cookies.html')));
app.get('/api-docs', (req, res) => res.sendFile(path.join(__dirname, 'public', 'api.html')));

// ─── DIVIDIR DIRECTAMENTE DESDE UN JOB 9:16 (sin resubir el video) ──────────
app.post('/dividir-desde-916/:jobId', express.json(), async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Debes iniciar sesión.' });
  const job = jobDelUsuario(req);
  if (!job || job.status !== 'done' || !job.outputFile || !fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: 'El video convertido ya no está disponible (expiró).' });
  }

  const hoy = new Date().toISOString().split('T')[0];
  let usos = req.user.usos_hoy || 0;
  if (req.user.ultimo_reset !== hoy) {
    usos = 0;
    await supabase.from('usuarios').update({ usos_hoy: 0, ultimo_reset: hoy }).eq('id', req.user.id);
  }
  const esAdmin = req.user.email === ADMIN_EMAIL;
  if (!esAdmin && req.user.plan === 'free' && usos >= LIMITE_DIARIO) {
    return res.status(429).json({ error: `Has alcanzado el límite de ${LIMITE_DIARIO} videos gratis hoy.` });
  }

  const duracion = parseInt(req.body.duracion);
  if (!duracion || duracion < 1) return res.status(400).json({ error: 'Duración inválida.' });

  const inputFile = job.outputFile;
  const nombreBase = (job.nombreOriginal || 'video') + '_9_16';
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'partes916_'));
  const outputPattern = path.join(outputDir, 'parte_%02d.mp4');

  const args = [
    '-i', inputFile,
    '-c', 'copy', '-map', '0',
    '-segment_time', String(duracion), '-reset_timestamps', '1',
    '-f', 'segment', outputPattern
  ];

  const ffmpegProc = spawn(FFMPEG, args);
  ffmpegProc.stderr.resume();
  ffmpegProc.on('error', err => {
    console.error('FFmpeg dividir 9:16:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'No se pudo iniciar el procesamiento del video.' });
  });
  ffmpegProc.on('close', async (code) => {
    try {
      if (res.headersSent || res.destroyed) return;
      if (code !== 0) return res.status(500).json({ error: 'Error al dividir el video.' });
      if (!esAdmin) {
        const { data: u } = await supabase.from('usuarios').select('total_usos').eq('id', req.user.id).single();
        await supabase.from('usuarios').update({
          usos_hoy: usos + 1, ultimo_reset: hoy,
          total_usos: (u?.total_usos || 0) + 1
        }).eq('id', req.user.id);
      }
      await splitDownloads.send(req, res, outputDir, nombreBase);
    } catch (err) {
      console.error('ZIP dividir 9:16:', err.message);
      if (!res.headersSent && !res.destroyed) res.status(500).json({ error: 'No se pudo preparar el ZIP. Inténtalo de nuevo.' });
    } finally {
      cleanSplitParts(outputDir);
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
