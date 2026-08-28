import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";

/** Application-level error with a stable machine code. */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function sendError(
  reply: FastifyReply,
  statusCode: number,
  code: string,
  message: string,
  requestId: string,
  details?: unknown,
): FastifyReply {
  const body: Record<string, unknown> = { error: { code, message, requestId } };
  if (details !== undefined) (body["error"] as Record<string, unknown>)["details"] = details;
  return reply.code(statusCode).send(body);
}

export const errorHandler = (
  error: FastifyError,
  request: FastifyRequest,
  reply: FastifyReply,
): void => {
  const statusCode = error.statusCode ?? 500;
  let code: string;
  let message: string;
  let details: unknown;

  if (error instanceof AppError) {
    code = error.code;
    message = error.message;
    details = error.details;
  } else if (statusCode === 400 || error.code === "FST_ERR_VALIDATION") {
    code = "validation_error";
    message = error.message || "Validation failed";
    details = error.validation;
  } else if (statusCode < 500) {
    code = "bad_request";
    message = error.message || "Bad Request";
  } else {
    code = "internal_error";
    message = "Internal Server Error";
  }

  request.log.error({ err: error }, "request failed");
  sendError(reply, statusCode, code, message, request.id, details);
};

export const notFoundHandler = (request: FastifyRequest, reply: FastifyReply): void => {
  sendError(reply, 404, "not_found", "Not Found", request.id);
};
