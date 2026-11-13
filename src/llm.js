// IA: Gemini (plan gratuito) por su endpoint compatible con OpenAI.
// Sirve cualquier proveedor compatible: se cambia con LLM_BASE_URL, LLM_API_KEY y LLM_MODEL.

import { SYSTEM_PROMPT, MSG } from './knowledge.js';

export const HANDOFF_MARK = '[[HUMANO]]';

/**
 * Devuelve { text, status }:
 *   "ok"       respuesta real (puede traer HANDOFF_MARK)
 *   "fallback" mensaje vacío o muy corto
 *   "error"    falló la IA (p. ej. 429 = cuota gratuita agotada) -> pasa a una persona
 */
export async function askLLM(env, history, userText) {
  if (!userText || userText.trim().length < 2) return { text: MSG.fallback, status: 'fallback' };
  if (!env.LLM_API_KEY) {
    console.error('Falta LLM_API_KEY');
    return { text: MSG.error, status: 'error' };
  }

  const base = (env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LLM_API_KEY}` },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'gemini-3.5-flash-lite',
        temperature: 0.3,
        max_tokens: Number(env.LLM_MAX_TOKENS || 800),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: userText },
        ],
      }),
    });
    if (!res.ok) {
      console.error(`IA respondió ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return { text: MSG.error, status: 'error' };
    }
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) return { text: MSG.fallback, status: 'fallback' };
    return { text, status: 'ok' };
  } catch (e) {
    console.error('Error de red con la IA:', e);
    return { text: MSG.error, status: 'error' };
  }
}
