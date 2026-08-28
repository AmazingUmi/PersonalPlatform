import Fastify from "fastify";
import pg from "pg";

const { Pool } = pg;
const port = Number(process.env.PORT ?? 8000);
const host = process.env.HOST ?? "0.0.0.0";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://personal_platform:change-me-for-local-development@localhost:5432/personal_platform";

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL?.toLowerCase() ?? "info",
  },
});
const database = new Pool({ connectionString: databaseUrl });

app.get("/api/core/health/live", async () => ({
  status: "ok",
  service: "personal-platform-backend",
}));

app.get("/api/core/health/ready", async (_request, reply) => {
  try {
    await database.query("SELECT 1");
    return { status: "ok", database: "ok" };
  } catch (error) {
    app.log.error(error, "database readiness check failed");
    return reply.code(503).send({ status: "error", database: "unavailable" });
  }
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.end();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await database.query("SELECT 1");
  app.log.info("database connection verified");
  await app.listen({ host, port });
} catch (error) {
  app.log.fatal(error, "backend startup failed");
  await database.end();
  process.exit(1);
}
