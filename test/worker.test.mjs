// Prueba sin internet: simula Zernio, Gemini y Supabase.   Uso: npm test
import crypto from 'node:crypto';
import worker from '../src/index.js';

// ── Supabase falso en memoria ──
const db = { events: new Set(), convs: new Map(), msgs: [] };
let msgId = 0;
const sent = []; // [conversationId, texto]
const ia = { text: 'Atendemos de lunes a viernes, de 07:30 a 17:30 😊', status: 200 };

function json(data) {
  return new Response(data === undefined ? '' : JSON.stringify(data), { status: 200 });
}
function eqVal(q, k) {
  const v = q.get(k);
  return v && v.startsWith('eq.') ? v.slice(3) : null;
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method || 'GET';
  const body = init.body ? JSON.parse(init.body) : null;

  if (url.hostname === 'zernio.com') {
    const conv = decodeURIComponent(url.pathname.split('/')[5]);
    sent.push([conv, body.message]);
    return json({ ok: true });
  }
  if (url.hostname.includes('googleapis')) {
    if (ia.status !== 200) return new Response('quota', { status: ia.status });
    return json({ choices: [{ message: { content: ia.text } }] });
  }

  const table = url.pathname.split('/').pop();
  const q = url.searchParams;
  if (table === 'zc_events') {
    if (method === 'POST') {
      if (db.events.has(body.evento_id)) return json([]);
      db.events.add(body.evento_id);
      return json([body]);
    }
    if (method === 'DELETE') { const id = eqVal(q, 'evento_id'); if (id) db.events.delete(id); return json(); }
  }
  if (table === 'zc_conversations') {
    if (method === 'POST') { db.convs.set(body.clave, { ...(db.convs.get(body.clave) || {}), ...body }); return json(); }
    const clave = eqVal(q, 'clave');
    if (clave) return json(db.convs.has(clave) ? [db.convs.get(clave)] : []);
    return json([...db.convs.values()].filter((c) => c.modo === 'humano'));
  }
  if (table === 'zc_messages') {
    if (method === 'POST') { db.msgs.push({ id: ++msgId, ...body }); return json(); }
    const clave = eqVal(q, 'clave');
    return json(db.msgs.filter((m) => m.clave === clave).sort((a, b) => b.id - a.id).slice(0, Number(q.get('limit'))));
  }
  throw new Error('fetch no simulado: ' + url);
};

const env = {
  ZERNIO_API_KEY: 'sk_prueba', ZERNIO_WEBHOOK_SECRET: 'secreto', LLM_API_KEY: 'k',
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_x', ADMIN_TOKEN: 'adm',
};

let n = 0;
function evento(tipo, conv, text = '', extra = {}) {
  n++;
  return {
    id: `evt_${n}`, event: tipo,
    message: {
      id: `m_${n}`, conversationId: conv, platform: 'whatsapp', platformMessageId: `wamid.${n}`,
      direction: tipo === 'message.received' ? 'incoming' : 'outgoing', text, attachments: [],
      sender: { phoneNumber: '+593990000000' }, ...extra,
    },
    conversation: { participantId: '593990000000' },
    account: { id: 'acc_1' },
  };
}

async function post(payload, secret = 'secreto') {
  const body = JSON.stringify(payload);
  const sig = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const pending = [];
  const res = await worker.fetch(
    new Request('https://w.dev/webhook', { method: 'POST', body, headers: { 'X-Zernio-Signature': sig } }),
    env, { waitUntil: (p) => pending.push(p) },
  );
  await Promise.all(pending);
  return res;
}
const get = (path, headers = {}) => worker.fetch(new Request('https://w.dev' + path, { headers }), env, { waitUntil() {} });
const de = (c) => sent.filter(([x]) => x === c).map(([, t]) => t);

let fallos = 0;
const ok = (nombre, cond) => { console.log((cond ? '  OK    ' : '  FALLA ') + nombre); if (!cond) fallos++; };

console.log('\nPruebas del Worker (todo simulado)\n');

ok('Rechaza firma inválida (401)', (await post(evento('message.received', 'c1', 'hola'), 'otro')).status === 401);

const p = evento('message.received', 'c1', '¿Qué horario tienen?');
await post(p);
ok('Responde una pregunta', de('c1')[0] === ia.text);
await post(p);
ok('No responde dos veces el mismo aviso', de('c1').length === 1);

await post(evento('message.received', 'c2', 'Quiero hablar con una persona'));
ok('Pide persona -> mensaje de traspaso', de('c2')[0]?.includes('Te paso con una persona'));
await post(evento('message.received', 'c2', '¿Sigue ahí?'));
ok('En modo humano el bot no responde', de('c2').length === 1);

await post(evento('message.sent', 'c3', 'Hola, soy del equipo', { source: 'whatsapp_business_app', sentVia: null }));
await post(evento('message.received', 'c3', 'Gracias, ¿y los precios?'));
ok('Responden desde el celular -> el bot se calla', de('c3').length === 0);

await post(evento('message.sent', 'c4', 'Hola', { source: 'cloud_api', sentVia: 'api' }));
await post(evento('message.received', 'c4', '¿Dónde quedan?'));
ok('Mensajes del propio bot no lo silencian', de('c4').length === 1);

await post(evento('message.received', 'c5', '', { attachments: [{ type: 'image' }] }));
ok('Foto del cliente -> pasa a persona', de('c5')[0]?.includes('lo recibimos'));

ia.text = 'Los valores te los dan las dueñas 💛\n[[HUMANO]]';
await post(evento('message.received', 'c6', '¿Cuánto cuesta sala cuna?'));
ok('La IA deriva y la marca [[HUMANO]] no llega al cliente', de('c6')[0] === 'Los valores te los dan las dueñas 💛');

ia.status = 429;
await post(evento('message.received', 'c7', 'Hola, info por favor'));
ok('Cuota de Gemini agotada -> pasa a persona', de('c7')[0]?.includes('te atenderá una persona'));
ia.status = 200;

ok('Admin sin clave -> 403', (await get('/admin/humano')).status === 403);
const lista = await (await get('/admin/humano', { 'x-admin-token': 'adm' })).json();
const claves = new Set(lista.conversaciones.map((c) => c.clave));
ok('Admin lista los chats en modo humano', ['c2', 'c3', 'c5', 'c6', 'c7'].every((c) => claves.has(c)));

await get('/admin/bot?conversacion=c2', { 'x-admin-token': 'adm' });
ia.text = '¡Claro! ¿En qué te ayudo?';
await post(evento('message.received', 'c2', 'Hola de nuevo'));
ok('Devuelto al bot -> responde otra vez', de('c2').at(-1) === '¡Claro! ¿En qué te ayudo?');

const salud = await (await get('/')).json();
ok('Salud: no faltan variables', salud.status === 'ok');

console.log(`\n${fallos ? fallos + ' prueba(s) fallaron' : 'Todo bien'}\n`);
process.exit(fallos ? 1 : 0);
