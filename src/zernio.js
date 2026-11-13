// Conexión con Zernio: verificar firma, leer el aviso (webhook) y enviar mensajes.
// Docs: https://docs.zernio.com/platforms/whatsapp

const BASE_URL = 'https://zernio.com/api/v1';
const enc = new TextEncoder();

/** Firma X-Zernio-Signature = HMAC-SHA256 (hex) del cuerpo crudo. Comparación en tiempo constante. */
export async function verifySignature(rawBytes, header, secret) {
  if (!secret || !header) return false;
  const hex = header.trim().toLowerCase().replace(/^sha256=/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) return false;
  const sig = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  return crypto.subtle.verify('HMAC', key, sig, rawBytes);
}

/**
 * Convierte el aviso de Zernio a un mensaje simple, o null si no interesa.
 *  - message.received -> mensaje del cliente
 *  - message.sent con source "whatsapp_business_app" (celular) o sentVia "human" (bandeja)
 *    -> lo escribió una PERSONA del equipo
 *  - message.sent del propio bot (source "cloud_api", sentVia "api") -> se ignora
 */
export function parseWebhook(payload) {
  const m = payload?.message || {};
  if (m.platform !== 'whatsapp') return null;

  const acc = payload.account || {};
  const ctx = {
    eventId: payload.id || '',
    conversationId: m.conversationId || '',
    accountId: acc.id || acc.accountId || '',
  };
  const base = { messageId: m.platformMessageId || m.id || '', text: m.text || '', ctx };

  if (payload.event === 'message.received') {
    if (m.direction && m.direction !== 'incoming') return null;
    if (m.metadata?.standby) return null; // otra app tiene el control del chat
    const s = m.sender || {};
    const phone = (s.phoneNumber || '').replace(/^\+/, '') || s.businessScopedUserId || s.id || '';
    return { ...base, phone, human: false, hasAttachment: (m.attachments || []).length > 0 };
  }

  if (payload.event === 'message.sent') {
    // sentVia null = desconocido, NO humano
    if (m.source !== 'whatsapp_business_app' && m.sentVia !== 'human') return null;
    if (!ctx.accountId) ctx.accountId = m.sender?.id || '';
    const phone = String(payload.conversation?.participantId || '').replace(/^\+/, '');
    return { ...base, phone, human: true, hasAttachment: false };
  }

  return null; // delivered, read, etc.
}

/** Responde dentro de la conversación. Devuelve true si Zernio lo aceptó. */
export async function sendMessage(env, ctx, text) {
  if (!env.ZERNIO_API_KEY || !ctx.conversationId || !ctx.accountId) {
    console.error('No se puede enviar: falta ZERNIO_API_KEY, conversationId o accountId');
    return false;
  }
  const headers = {
    Authorization: `Bearer ${env.ZERNIO_API_KEY}`,
    'Content-Type': 'application/json',
  };
  // Si Zernio reintenta el aviso, esta clave evita enviar la respuesta dos veces
  if (ctx.eventId) headers['Idempotency-Key'] = `bot-${ctx.eventId}`;

  try {
    const res = await fetch(`${BASE_URL}/inbox/conversations/${encodeURIComponent(ctx.conversationId)}/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ accountId: ctx.accountId, message: text.slice(0, 4000) }),
    });
    if (res.ok) return true;
    console.error(`Zernio rechazó el envío [${res.status}]: ${(await res.text()).slice(0, 300)}`);
  } catch (e) {
    console.error('Error de red con Zernio:', e);
  }
  return false;
}
