#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Створено .env — впиши BOT_TOKEN і ADMIN_IDS"
fi
echo "1) Токен бота: @BotFather → /newbot"
echo "2) Твій Telegram id: @userinfobot"
echo "3) Відкрий .env і заповни BOT_TOKEN + ADMIN_IDS"
echo "4) npm start"
echo "5) HTTPS для Mini App: cloudflared tunnel --url http://localhost:3000"
echo "   скопіюй https://….trycloudflare.com у WEBAPP_URL і в Menu Button бота"
echo ""
echo "Локальний превʼю без бота:"
echo "  DEV_MODE=1 npm start"
echo "  відкрий http://localhost:3000/?dev=1"
