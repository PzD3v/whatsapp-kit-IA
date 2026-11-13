// Supabase por REST (sin librerías). Usa la secret key: solo en el servidor.
// Tablas: zc_conversations (bot/humano), zc_messages (historial), zc_events (anti-duplicados)

const enc = encodeURIComponent;

export function makeDb(env) {
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const key = env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        // Las claves nuevas (sb_secret_…) solo van en "apikey"; las antiguas (JWT) también como Bearer
        ...(key?.startsWith('eyJ') ? { Authorization: `Bearer ${key}` } : {}),
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const t = await res.text();
    return t ? JSON.parse(t) : null;
  }

  return {
    /** true si el evento es nuevo; false si ya se procesó (Zernio reintenta) */
    async claimEvent(id) {
      if (!id) return true;
      const rows = await rest('zc_events?on_conflict=evento_id', {
        method: 'POST',
        prefer: 'resolution=ignore-duplicates,return=representation',
        body: { evento_id: id },
      });
      return Array.isArray(rows) && rows.length > 0;
    },

    releaseEvent(id) {
      return id ? rest(`zc_events?evento_id=eq.${enc(id)}`, { method: 'DELETE' }) : null;
    },

    async getConv(clave) {
      const rows = await rest(`zc_conversations?clave=eq.${enc(clave)}&select=*&limit=1`);
      return rows?.[0] ?? null;
    },

    setMode(clave, modo, motivo = '', telefono = '') {
      const now = new Date().toISOString();
      return rest('zc_conversations?on_conflict=clave', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
          clave,
          modo,
          motivo: motivo.slice(0, 200),
          actualizado_en: now,
          ...(telefono ? { telefono } : {}),
          ...(modo === 'humano' ? { ultimo_humano_en: now } : {}),
        },
      });
    },

    addMessage(clave, role, content) {
      return rest('zc_messages', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { clave, role, content },
      });
    },

    async history(clave, limit = 20) {
      const rows =
        (await rest(`zc_messages?clave=eq.${enc(clave)}&select=role,content&order=id.desc&limit=${limit}`)) ?? [];
      rows.reverse();
      while (rows.length && rows[0].role !== 'user') rows.shift();
      return rows;
    },

    listHuman() {
      return rest(
        'zc_conversations?modo=eq.humano&select=clave,telefono,motivo,ultimo_humano_en&order=actualizado_en.desc',
      );
    },

    /** Limpieza diaria: eventos > 7 días y mensajes > 90 días (privacidad y espacio) */
    async cleanup() {
      const d7 = new Date(Date.now() - 7 * 864e5).toISOString();
      const d90 = new Date(Date.now() - 90 * 864e5).toISOString();
      await rest(`zc_events?created_at=lt.${enc(d7)}`, { method: 'DELETE' });
      await rest(`zc_messages?created_at=lt.${enc(d90)}`, { method: 'DELETE' });
    },
  };
}
