/**
 * Голос → текст і фото чека → сума/дата. Працює лише коли задано OPENAI_API_KEY.
 * Без ключа бот чесно каже, що ця функція вимкнена, і просить написати текстом.
 */
import { config } from '../config.js';

const API = 'https://api.openai.com/v1';

export const aiEnabled = () => Boolean(config.openaiKey);

async function call(path, init) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${config.openaiKey}`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 200);
    try { msg = JSON.parse(text).error?.message || msg; } catch {}
    throw new Error(`AI: ${msg}`);
  }
  return text;
}

/** Розшифровка голосового (ogg/opus з Telegram). */
export async function transcribe(buffer, filename = 'voice.ogg') {
  if (!aiEnabled()) throw new Error('Голосовий ввід вимкнено: адміну треба додати OPENAI_API_KEY.');
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/ogg' }), filename);
  form.append('model', config.aiTranscribeModel);
  form.append('language', 'uk');
  form.append('response_format', 'text');
  const text = await call('/audio/transcriptions', { method: 'POST', body: form });
  return text.trim();
}

/** Фото чека / скріну оплати → { amount, currency, date, title, type } або null. */
export async function readReceipt(buffer, mime = 'image/jpeg') {
  if (!aiEnabled()) throw new Error('Розпізнавання чеків вимкнено: адміну треба додати OPENAI_API_KEY.');
  const b64 = Buffer.from(buffer).toString('base64');
  const body = {
    model: config.aiVisionModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'Ти бухгалтер. З фото чека або скріншота банківської операції витягни дані. '
          + 'Відповідай лише JSON: {"amount": число (підсумкова сума, без знака), "currency": "UAH|USD|EUR|USDT|PLN|GBP", '
          + '"date": "YYYY-MM-DD" або null, "title": коротко що це (магазин/отримувач/призначення), '
          + '"type": "expense" або "income" (income лише якщо гроші надійшли нам)}. Якщо суми не видно — {"amount": null}.',
      },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }] },
    ],
  };
  const text = await call('/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const content = JSON.parse(text).choices?.[0]?.message?.content || '{}';
  let j;
  try { j = JSON.parse(content); } catch { return null; }
  const amount = Number(j.amount);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = ['UAH', 'USD', 'EUR', 'USDT', 'PLN', 'GBP'].includes(String(j.currency).toUpperCase())
    ? String(j.currency).toUpperCase() : 'UAH';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(j.date || '') ? j.date : null;
  return {
    amount: Math.round(amount * 100),
    currency,
    date,
    title: String(j.title || '').slice(0, 200) || null,
    type: j.type === 'income' ? 'income' : 'expense',
  };
}
