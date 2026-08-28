.PHONY: dev down logs ps check build

dev:
	docker compose up --build

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

check:
	docker compose run --rm backend npm run check --workspace @personal-platform/backend
	docker compose run --rm frontend npm run check --workspace @personal-platform/frontend

build:
	npm run build
