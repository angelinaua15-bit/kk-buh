import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const env = process.env;

const railwayUrl = env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${env.RAILWAY_PUBLIC_DOMAIN.replace(/^https?:\/\//, '')}`
  : '';

function resolveWebAppUrl() {
  const raw = (env.WEBAPP_URL || '').replace(/\/$/, '');
  const stale = /lhr\.life|loca\.lt|ngrok|pinggy|serveo|trycloudflare|localhost|127\.0\.0\.1|railway\.com\/project/i.test(raw);
  let host = '';
  try { host = new URL(raw.startsWith('http') ? raw : `https://${raw}`).hostname; } catch { host = ''; }
  if (railwayUrl && (!raw || stale || !/\.up\.railway\.app$/i.test(host))) return railwayUrl;
  return raw || railwayUrl;
}

// Railway: база живе між деплоями лише на підключеному Volume (RAILWAY_VOLUME_MOUNT_PATH)
const volumePath = env.RAILWAY_VOLUME_MOUNT_PATH || '';
const persistDir = volumePath || (fs.existsSync('/data') ? '/data' : path.join(ROOT, 'data'));
fs.mkdirSync(persistDir, { recursive: true });

const webAppUrl = resolveWebAppUrl();
const onRailway = Boolean(railwayUrl);

export const config = {
  botToken: env.BOT_TOKEN || '',
  adminIds: (env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number),
  webAppUrl,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  dbPath: env.DB_PATH || path.join(persistDir, 'kkbuh.sqlite'),
  webhookSecret: env.WEBHOOK_SECRET || '',
  onRailway,
  volumePath,
  /** false — на Railway без Volume: після кожного деплою база створюється заново */
  persistent: !onRailway || Boolean(volumePath) || Boolean(env.DB_PATH),
  useWebhook: env.USE_WEBHOOK === '1' || onRailway,
  runPolling: env.RUN_POLLING === '1',
  forceTelegramIp: env.TELEGRAM_FORCE_IP === '1',
  devMode: env.DEV_MODE === '1',
  timezone: env.TZ || 'Europe/Kyiv',
  companyName: env.COMPANY_NAME || 'King Kong Lab',
  openaiKey: env.OPENAI_API_KEY || '',
  aiTranscribeModel: env.AI_TRANSCRIBE_MODEL || 'whisper-1',
  aiVisionModel: env.AI_VISION_MODEL || 'gpt-4o-mini',
  monoToken: env.MONO_TOKEN || '',
  syncToken: env.SHEET_SYNC_TOKEN || '',
};
