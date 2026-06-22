require('dotenv').config();
const express = require('express');
const multer = require('multer');
const archiver = require('archiver');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const session = require('express-session');
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

app.use(session({
  secret: process.env.SESSION_SECRET || 'secreto',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

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

  res.json({
    autenticado: true,
    nombre: req.user.nombre,
    email: req.user.email,
    plan: req.user.plan,
    usos_hoy: req.user.usos_hoy,
    limite: LIMITE_DIARIO,
    restantes: Math.max(0, LIMITE_DIARIO - req.user.usos_hoy)
  });
});

// Crear sesión de pago Stripe
app.post('/crear-checkout', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'No autenticado' });

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
          product_data: { name: 'ClipsToYou Pro' },
          unit_amount: 499,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      customer_email: req.user.email,
      metadata: { usuario_id: req.user.id },
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
    const usuarioId = s.metadata.usuario_id;
    const customerId = s.customer;
    const subscriptionId = s.subscription;
    await supabase.from('usuarios').update({
      plan: 'pro',
      stripe_customer_id: customerId,
      stripe_subscription_id: subscriptionId
    }).eq('id', usuarioId);
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

  if (req.user.plan === 'free' && usos >= LIMITE_DIARIO) {
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

    await supabase
      .from('usuarios')
      .update({ usos_hoy: usos + 1, ultimo_reset: hoy })
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
