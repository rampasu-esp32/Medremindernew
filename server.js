// Cloud relay for the Smart Medicine Reminder.
// Serves the same web app the ESP32 used to serve locally, and bridges its
// /api/* calls to MQTT so the device can be scheduled from anywhere.
//
// Env vars (set these in your hosting platform, don't hardcode secrets):
//   MQTT_URL       e.g. mqtts://YOUR_CLUSTER.s1.eu.hivemq.cloud:8883
//   MQTT_USER, MQTT_PASS   broker credentials
//   DEVICE_ID      must match DEVICE_ID in the firmware (default "box1")
//   APP_USER, APP_PASS     login for the web app itself (it's now on the public internet)
//   PORT           usually set automatically by the host

const path = require('path');
const express = require('express');
const basicAuth = require('express-basic-auth');
const mqtt = require('mqtt');

const DEVICE_ID = process.env.DEVICE_ID || 'box1';
const BASE = `medrem/${DEVICE_ID}`;
const PORT = process.env.PORT || 3000;

// ---------- MQTT ----------
let lastState = null;     // last JSON payload received on .../state
let deviceOnline = false;
let lastSeenMs = 0;

if (!process.env.MQTT_URL) {
  console.error('MQTT_URL is not set. Expected something like mqtts://HOST:8883');
  process.exit(1);
}
try {
  const u = new URL(process.env.MQTT_URL.trim());
  console.log(`[mqtt] connecting to ${u.protocol}//${u.hostname}:${u.port || '(default)'} as user "${process.env.MQTT_USER || ''}"`);
} catch (e) {
  console.error('MQTT_URL is not a valid URL:', JSON.stringify(process.env.MQTT_URL));
  process.exit(1);
}

const client = mqtt.connect(process.env.MQTT_URL.trim(), {
  username: process.env.MQTT_USER,
  password: process.env.MQTT_PASS,
  clientId: 'relay-' + Math.random().toString(16).slice(2),
  reconnectPeriod: 3000,
  connectTimeout: 15000,
});

client.on('connect', () => {
  console.log('[mqtt] connected to broker');
  client.subscribe(`${BASE}/state`, { qos: 1 });
  client.subscribe(`${BASE}/status`, { qos: 1 });
});
client.on('reconnect', () => console.log('[mqtt] reconnecting...'));
client.on('error', (e) => console.error('[mqtt] error', e.message));

client.on('message', (topic, payload) => {
  if (topic === `${BASE}/state`) {
    try { lastState = JSON.parse(payload.toString()); lastSeenMs = Date.now(); }
    catch (e) { console.error('[mqtt] bad state JSON', e.message); }
  } else if (topic === `${BASE}/status`) {
    deviceOnline = payload.toString() === 'online';
    lastSeenMs = Date.now();
  }
});

function publishCmd(sub, obj) {
  return new Promise((resolve, reject) => {
    client.publish(`${BASE}/cmd/${sub}`, JSON.stringify(obj), { qos: 1 }, (err) => err ? reject(err) : resolve());
  });
}

// ---------- HTTP ----------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Simple login so the schedule isn't wide open on the public internet.
// For anything beyond personal/family use, swap this for a real auth system.
if (process.env.APP_USER && process.env.APP_PASS) {
  app.use(basicAuth({
    users: { [process.env.APP_USER]: process.env.APP_PASS },
    challenge: true,
    realm: 'Medicine reminder',
  }));
} else {
  console.warn('APP_USER/APP_PASS not set - the web app has NO password. Set them before deploying.');
}

const fs = require('fs');
const PUBLIC_DIR = path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
if (!fs.existsSync(INDEX_FILE)) {
  console.error(`MISSING ${INDEX_FILE} - the web page was not deployed. Make sure the public/ folder (with index.html) is in your repo next to server.js.`);
}

app.get('/', (req, res) => {
  if (!fs.existsSync(INDEX_FILE)) {
    return res.status(500).send('Server is running, but public/index.html is missing from the deployment. Check that the public/ folder was pushed to the repo.');
  }
  res.sendFile(INDEX_FILE);
});
app.use(express.static(PUBLIC_DIR, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('manifest.json')) res.setHeader('Content-Type', 'application/manifest+json');
    if (filePath.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');   // belt and braces; sw.js is already served from root
  },
}));

// Same endpoint shapes the web app already calls - it doesn't need to change.
app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!lastState) {
    return res.json({
      valid: false, tz: 0, vol: 14, lang: 0, time: '', date: '',
      status: deviceOnline ? 'waiting' : 'offline',
      next: deviceOnline ? 'Waiting for the device...' : 'Device is offline',
      boxes: [
        { name: '', instr: '', en: false, days: 127, open: false, alarm: false, last: '', times: [] },
        { name: '', instr: '', en: false, days: 127, open: false, alarm: false, last: '', times: [] },
        { name: '', instr: '', en: false, days: 127, open: false, alarm: false, last: '', times: [] },
        { name: '', instr: '', en: false, days: 127, open: false, alarm: false, last: '', times: [] },
      ],
      log: [],
    });
  }
  const stale = Date.now() - lastSeenMs > 30000;
  res.json({ ...lastState, online: deviceOnline && !stale });
});

app.post('/api/box', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!(id >= 0 && id < 4)) return res.status(400).send('bad id');
  const times = (req.body.times || '').split(',').map(s => s.trim()).filter(Boolean);
  try {
    await publishCmd('box', {
      id,
      name: req.body.name || '',
      instr: req.body.instr || '',
      en: req.body.en === '1' ? 1 : 0,
      days: parseInt(req.body.days, 10) || 0,
      times,
    });
    res.send('ok');
  } catch (e) { res.status(502).send('mqtt publish failed'); }
});

app.post('/api/test', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!(id >= 0 && id < 4)) return res.status(400).send('bad id');
  try { await publishCmd('test', { id }); res.send('ok'); }
  catch (e) { res.status(502).send('mqtt publish failed'); }
});

app.post('/api/ack', async (req, res) => {
  const id = parseInt(req.body.id, 10);
  if (!(id >= 0 && id < 4)) return res.status(400).send('bad id');
  try { await publishCmd('ack', { id }); res.send('ok'); }
  catch (e) { res.status(502).send('mqtt publish failed'); }
});

app.post('/api/settings', async (req, res) => {
  try {
    const tz = parseInt(req.body.tz, 10);
    const vol = parseInt(req.body.vol, 10);
    const lang = parseInt(req.body.lang, 10);
    await publishCmd('settings', {
      tz: Number.isNaN(tz) ? 0 : tz,
      vol: Number.isNaN(vol) ? 14 : vol,          // 0 (mute) is a valid volume, so don't use || here
      ...(Number.isNaN(lang) ? {} : { lang }),    // 0 = English, 1 = Tamil
    });
    res.send('ok');
  } catch (e) { res.status(502).send('mqtt publish failed'); }
});

app.listen(PORT, () => console.log(`Relay listening on port ${PORT}, device id "${DEVICE_ID}"`));
