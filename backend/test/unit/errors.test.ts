import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { AppError, errorHandler, notFoundHandler, sendError } from "../../src/core/api/errors.js";

interface ReplyProbe {
  reply: FastifyReply;
  statusCode(): number;
  body(): unknown;
}

function fakeReply(): ReplyProbe {
  const state = { statusCode: 0, body: undefined as unknown };
  const reply = {
    code(status: number) {
      state.statusCode = status;
      return reply;
    },
    send(payload: unknown) {
      state.body = payload;
      return reply;
    },
  } as unknown as FastifyReply;
  return {
    reply,
    statusCode: () => state.statusCode,
    body: () => state.body,
  };
}

const fakeRequest = { id: "req-42", log: { error: () => undefined } } as unknown as FastifyRequest;

describe("unified error envelope", () => {
  it("sendError produces { error: { code, message, requestId, details? } }", () => {
    const probe = fakeReply();
    sendError(probe.reply, 400, "validation_error", "bad input", "req-1", [{ path: "/name" }]);
    assert.equal(probe.statusCode(), 400);
    assert.deepEqual(probe.body(), {
      error: {
        code: "validation_error",
        message: "bad input",
        requestId: "req-1",
        details: [{ path: "/name" }],
      },
    });
  });

  it("maps AppError to its code and status", () => {
    const probe = fakeReply();
    errorHandler(new AppError(404, "app_not_found", "app missing"), fakeRequest, probe.reply);
    assert.equal(probe.statusCode(), 404);
    const body = probe.body() as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, "app_not_found");
    assert.equal(body.error.requestId, "req-42");
  });

  it("maps Fastify validation errors to validation_error", () => {
    const probe = fakeReply();
    const error = {
      statusCode: 400,
      code: "FST_ERR_VALIDATION",
      message: "body must be object",
      validation: [{}],
    } as unknown as FastifyError;
    errorHandler(error, fakeRequest, probe.reply);
    assert.equal(probe.statusCode(), 400);
    const body = probe.body() as { error: { code: string } };
    assert.equal(body.error.code, "validation_error");
  });

  it("hides internal error messages behind 500", () => {
    const probe = fakeReply();
    errorHandler(new Error("secret stack detail") as unknown as FastifyError, fakeRequest, probe.reply);
    assert.equal(probe.statusCode(), 500);
    const body = probe.body() as { error: { code: string; message: string } };
    assert.equal(body.error.code, "internal_error");
    assert.equal(body.error.message, "Internal Server Error");
  });

  it("notFoundHandler returns unified 404", () => {
    const probe = fakeReply();
    notFoundHandler(fakeRequest, probe.reply);
    assert.equal(probe.statusCode(), 404);
    const body = probe.body() as { error: { code: string } };
    assert.equal(body.error.code, "not_found");
  });
});
