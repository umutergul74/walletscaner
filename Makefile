install:
	npm install

dev:
	npm run dev

test:
	npm test

typecheck:
	npm run typecheck

lint:
	npm run lint

docker-up:
	docker compose up --build

backfill:
	npm run backfill:dexscreener

# ── Server Deploy ────────────────────────────────
deploy:
	bash scripts/deploy.sh

server-status:
	bash scripts/server-status.sh

server-logs:
	ssh root@46.101.142.68 "cd /opt/walletscaner && docker compose -f docker-compose.server.yml logs -f market-watch"

server-restart:
	ssh root@46.101.142.68 "cd /opt/walletscaner && docker compose -f docker-compose.server.yml restart market-watch"

pull-reports:
	bash scripts/pull-reports.sh
