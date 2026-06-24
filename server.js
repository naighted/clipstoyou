require('dotenv').config();
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { spawn } = require('child_process');
const path = require('path');
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
      success_url: `${BASE}/?pago=ok`,
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

// In-memory job store for background video processing
const jobs916 = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs916.entries()) {
    if (job.createdAt < cutoff) {
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

  const modoCam = req.body.modoCam === 'sin-cam' ? 'sin-cam' : 'con-cam';
  const inputFile = req.file.path;
  const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const outputFile = path.join(os.tmpdir(), 'v916_' + jobId + '.mp4');
  let args;

  if (modoCam === 'sin-cam') {
    const filtro = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
    args = ['-i', inputFile, '-vf', filtro, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-c:a', 'aac', '-b:a', '128k', '-y', outputFile];
  } else {
    const camCoords = ['camX','camY','camW','camH'].map(k => Math.round(Number(req.body[k])));
    if (camCoords.some(isNaN) || camCoords.some(v => v < 0)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Coordenadas inválidas.' });
    }
    const [cx, cy, cw, ch] = camCoords;
    const camPosicion = req.body.camPosicion === 'arriba' ? 'arriba' : 'abajo';
    const videoW = Math.round(Number(req.body.videoW)) || 0;
    const videoH = Math.round(Number(req.body.videoH)) || 0;

    const filtroCam = `crop=${cw}:${ch}:${cx}:${cy},scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;
    let filtroGameplay = `scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960`;
    if (videoW > 0 && videoH > 0) {
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
    args = ['-i', inputFile, '-filter_complex', filterComplex, '-map', '[out]', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-y', outputFile];
  }

  // Register job and respond immediately — no timeout possible
  jobs916.set(jobId, { status: 'processing', createdAt: Date.now(), outputFile: null, error: null });
  res.json({ jobId });

  // Process in background
  const ffmpeg = spawn(FFMPEG, args);
  let stderrLog = '';
  ffmpeg.stderr.on('data', d => { stderrLog += d.toString(); });

  ffmpeg.on('close', async (code) => {
    try { fs.unlinkSync(inputFile); } catch(e) {}
    if (code !== 0) {
      console.error('FFmpeg 9:16 error (code', code, '):', stderrLog.slice(-500));
      jobs916.set(jobId, { ...jobs916.get(jobId), status: 'error', error: 'Error al convertir. Código: ' + code });
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

    jobs916.set(jobId, { ...jobs916.get(jobId), status: 'done', outputFile });
  });
});

app.get('/api/job916/:jobId', (req, res) => {
  const job = jobs916.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job no encontrado' });
  res.json({ status: job.status, error: job.error });
});

app.get('/api/job916/:jobId/download', (req, res) => {
  const job = jobs916.get(req.params.jobId);
  if (!job || job.status !== 'done' || !job.outputFile) return res.status(404).json({ error: 'No disponible' });
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', 'attachment; filename="video_9_16.mp4"');
  const stream = fs.createReadStream(job.outputFile);
  stream.pipe(res);
  stream.on('end', () => {
    try { fs.unlinkSync(job.outputFile); } catch(e) {}
    jobs916.delete(req.params.jobId);
  });
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
    '-i', inputFile, '-c', 'copy', '-map', '0',
    '-segment_time', String(duracion), '-reset_timestamps', '1',
    '-f', 'segment', outputPattern
  ];

  const ffmpeg = spawn(FFMPEG, args);

  ffmpeg.on('close', async (code) => {
    fs.unlinkSync(inputFile);

    if (code !== 0) return res.status(500).json({ error: 'Error al procesar el video.' });

    const partes = fs.readdirSync(outputDir).filter(f => f.endsWith('.mp4')).sort();
    if (partes.length === 0) return res.status(500).json({ error: 'No se generaron partes.' });

    const { data: u } = await supabase.from('usuarios').select('total_usos').eq('id', req.user.id).single();
    await supabase.from('usuarios')
      .update({ usos_hoy: usos + 1, ultimo_reset: hoy, total_usos: (u?.total_usos || 0) + 1 })
      .eq('id', req.user.id);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="partes.zip"');

    const zip = archiver('zip');
    zip.pipe(res);
    partes.forEach(parte => zip.file(path.join(outputDir, parte), { name: parte }));
    zip.finalize();

    zip.on('end', () => {
      partes.forEach(parte => fs.unlinkSync(path.join(outputDir, parte)));
      fs.rmdirSync(outputDir);
    });
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor listo en http://localhost:${PORT}`));
