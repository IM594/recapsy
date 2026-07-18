export type DesktopSingleInstanceHost = {
  requestSingleInstanceLock(): boolean;
  on(event: 'second-instance', listener: () => void): unknown;
  quit(): void;
};

export type DesktopSingleInstanceOptions<TRuntime> = {
  app: DesktopSingleInstanceHost;
  start(): TRuntime;
  onSecondInstance(runtime: TRuntime): void;
};

/** Prevents two processes from sharing one SQLite/profile ownership domain. */
export function startDesktopSingleInstance<TRuntime>(
  options: DesktopSingleInstanceOptions<TRuntime>,
): TRuntime | undefined {
  if (!options.app.requestSingleInstanceLock()) {
    options.app.quit();
    return undefined;
  }

  const runtime = options.start();
  options.app.on('second-instance', () => options.onSecondInstance(runtime));
  return runtime;
}
