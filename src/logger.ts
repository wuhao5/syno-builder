export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function timestamp(): string {
  return new Date().toISOString();
}

export const logger: Logger = {
  info(message: string): void {
    console.log(`[${timestamp()}] [INFO] ${message}`);
  },
  warn(message: string): void {
    console.warn(`[${timestamp()}] [WARN] ${message}`);
  },
  error(message: string): void {
    console.error(`[${timestamp()}] [ERROR] ${message}`);
  },
};
