.PHONY: dev down logs ps check build test verify backup

dev:
	docker compose up --build

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
