import pino from "pino";

export type Logger = pino.Logger;

export function createRootLogger(config: { level: string; env: string }): Logger {
  const isDev = config.env === "development";

  if (isDev) {
    return pino({
      level: config.level,
      transport: { target: "pino-pretty", options: { colorize: true } },
      base: { service: "recaply-engine" },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
    });
  }

  return pino({
    level: config.level,
    base: { service: "recaply-engine" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}
