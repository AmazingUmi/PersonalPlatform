.PHONY: dev dev-expose down logs ps check build test verify backup

dev:
	docker compose up --build

# Dev stack with database/backend published on host loopback and the
# frontend reachable from the LAN (FP-7.4 explicit-exposure variant).
dev-expose:
	docker compose -f docker-compose.yml -f docker/compose.expose.yml up --build

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

check:
	npm run check

build:
	npm run build

test:
	npm test

verify:
	bash scripts/verify.sh

backup:
	bash scripts/backup.sh backup
