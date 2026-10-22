.PHONY: dev dev-expose down logs ps prod prod-down prod-logs prod-ps check build test verify verify-docker backup

PROD_ENV ?= .env.production
PROD_COMPOSE = docker compose --env-file "$(PROD_ENV)" -f docker/docker-compose.prod.yml

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

# Standalone production stack; do not merge it with docker-compose.yml.
prod:
	$(PROD_COMPOSE) up --build -d --wait --wait-timeout 180

prod-down:
	$(PROD_COMPOSE) down

prod-logs:
	$(PROD_COMPOSE) logs -f

prod-ps:
	$(PROD_COMPOSE) ps

check:
	npm run check

build:
	npm run build

test:
	npm test

verify:
	bash scripts/verify.sh

verify-docker:
	npm run verify:docker

backup:
	bash scripts/backup.sh backup
