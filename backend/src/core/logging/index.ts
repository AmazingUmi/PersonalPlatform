import pino from "pino";
import type { Logger as PinoLogger } from "pino";

export type Logger = PinoLogger;

export function createLogger(level: string = "info"): Logger {
  return pino({ level });
}
