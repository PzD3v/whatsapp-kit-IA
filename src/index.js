// Bot de WhatsApp en Cloudflare Workers (Zernio + Gemini + Supabase) — plantilla general
//
// Quién responde:
//  - Pregunta normal                         -> la IA
//  - Pide persona / precios / inscripción    -> mensaje de traspaso, chat en modo "humano"
//  - Manda foto, documento o audio           -> mensaje de recibido, chat en modo "humano"
//  - Alguien responde desde el celular       -> chat en modo "humano" (el bot se calla)
//  - Falla la IA                             -> mensaje de espera, chat en modo "humano"
//  - HUMANO_TIMEOUT_HORAS sin actividad humana, o /admin/bot -> vuelve el bot

import { verifySignature, parseWebhook, sendMessage } from './zernio.js';
import { makeDb } from './db.js';
import { askLLM, HANDOFF_MARK } from './llm.js';
import { MSG } from './knowledge.js';

export const PIDE_PERSONA =
  /(hablar|comunic\w*|conectar|pasar|p[aá]same|contactar).{0,30}(persona|humano|asesor|alguien|encargad|directora|due[ñn]a|secretaria|agente|operador)|\b(humano|asesora?|agente|operadora?)\b|persona real/i;

const REQUERIDAS = ['ZERNIO_API_KEY', 'ZERNIO_WEBHOOK_SECRET', 'LLM_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_TOKEN'];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      const faltan = REQUERIDAS.filter((k) => !env[k]);
      return Response.json({ status: faltan.length ? 'faltan variables' : 'ok', faltan });
    }
    if (url.pathname === '/webhook' && request.method === 'POST') return handleWebhook(request, env, ctx);
    if (url.pathname.startsWith('/admin/') && request.method === 'GET') return handleAdmin(request, env, url);
    return new Response('not found', { status: 404 });
  },

  // Limpieza diaria (ver "triggers" en wrangler.toml)
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(makeDb(env).cleanup());
  },
};

async function handleWebhook(request, env, ctx) {
  const raw = await request.arrayBuffer();
  const firma = request.headers.get('x-zernio-signature') || request.headers.get('x-late-signature');
  if (!(await verifySignature(raw, firma, env.ZERNIO_WEBHOOK_SECRET))) {
    return new Response('firma invalida', { status: 401 });
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response('json invalido', { status: 400 });
  }

  const msg = parseWebhook(payload);
  if (!msg) return Response.json({ status: 'ignorado' });

  // Responder 200 YA (Zernio espera 5 s) y trabajar después
  ctx.waitUntil(processMessage(msg, env).catch((e) => console.error('processMessage:', e)));
  return Response.json({ status: 'ok' });
}

async function processMessage(msg, env) {
  const db = makeDb(env);
  const clave = msg.ctx.conversationId || msg.phone;
  if (!clave) return;
  const eventId = msg.ctx.eventId || msg.messageId;
  if (!(await db.claimEvent(eventId))) return; // aviso repetido

  const timeoutMs = Number(env.HUMANO_TIMEOUT_HORAS || 8) * 3600_000;
  const text = msg.text.trim();

  try {
    // 1) Una persona del equipo respondió: el bot se calla
    if (msg.human) {
      await db.setMode(clave, 'humano', 'respondio una persona desde la app');
      if (text) await db.addMessage(clave, 'assistant', text);
      return;
    }

    // 2) ¿Lo atiende una persona?
    const conv = await db.getConv(clave);
    if (conv?.modo === 'humano') {
      const desde = conv.ultimo_humano_en ? Date.parse(conv.ultimo_humano_en) : 0;
      if (Date.now() - desde < timeoutMs) {
        if (text) await db.addMessage(clave, 'user', text);
        return;
      }
      await db.setMode(clave, 'bot', 'vencio el tiempo sin actividad humana', msg.phone);
    }

    // 3) Archivos: los revisa una persona
    if (msg.hasAttachment && !text) {
      return handoff(db, env, msg, clave, eventId, MSG.media, 'el cliente envio un archivo');
    }
    if (!text) return;

    // 4) Pide una persona
    if (PIDE_PERSONA.test(text)) {
      await db.addMessage(clave, 'user', text);
      return handoff(db, env, msg, clave, eventId, MSG.handoff, 'el cliente pidio una persona', true);
    }

    // 5) Responde la IA
    const history = await db.history(clave);
    const { text: answer, status } = await askLLM(env, history, text);

    if (status === 'error') {
      await db.addMessage(clave, 'user', text);
      return handoff(db, env, msg, clave, eventId, MSG.error, 'fallo la IA');
    }
    if (status === 'ok' && answer.includes(HANDOFF_MARK)) {
      const limpio = answer.replaceAll(HANDOFF_MARK, '').trim() || MSG.handoff;
      await db.addMessage(clave, 'user', text);
      return handoff(db, env, msg, clave, eventId, limpio, 'la IA lo derivo', true);
    }

    if (!(await sendMessage(env, msg.ctx, answer))) {
      await db.releaseEvent(eventId); // que el reintento de Zernio sí se procese
      return;
    }
    if (status === 'ok') {
      await db.addMessage(clave, 'user', text);
      await db.addMessage(clave, 'assistant', answer);
    }
  } catch (e) {
    console.error(`Error procesando ${clave}:`, e);
    await db.releaseEvent(eventId).catch(() => {});
  }
}

async function handoff(db, env, msg, clave, eventId, texto, motivo, guardar = false) {
  await db.setMode(clave, 'humano', motivo, msg.phone);
  if (await sendMessage(env, msg.ctx, texto)) {
    if (guardar) await db.addMessage(clave, 'assistant', texto);
  } else {
    await db.releaseEvent(eventId);
  }
}

async function handleAdmin(request, env, url) {
  const token = request.headers.get('x-admin-token') || url.searchParams.get('token');
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return new Response('no autorizado', { status: 403 });
  const db = makeDb(env);

  if (url.pathname === '/admin/humano') {
    return Response.json({ conversaciones: await db.listHuman() });
  }
  if (url.pathname === '/admin/bot') {
    const clave = url.searchParams.get('conversacion');
    if (!clave) return new Response('falta ?conversacion=', { status: 400 });
    await db.setMode(clave, 'bot', 'devuelta manualmente');
    return Response.json({ ok: true, conversacion: clave, modo: 'bot' });
  }
  return new Response('not found', { status: 404 });
}
