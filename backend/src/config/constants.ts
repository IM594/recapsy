export const ENV_KEYS = {
  port: "PORT",
  debugStartup: "DEBUG_STARTUP",
  debugHttp: "DEBUG_HTTP",
  debugWorkflowProgress: "DEBUG_WORKFLOW_PROGRESS",
  projectsRoot: "PROJECTS_ROOT",
  gitIncludeStat: "GIT_INCLUDE_STAT",
  recaplyEnvPath: "RECAPLY_ENV_PATH",
  recaplyConfigPath: "RECAPLY_CONFIG_PATH",
  recaplyOutputDir: "RECAPLY_OUTPUT_DIR",
} as const;

export const DEFAULTS = {
  serverPort: 3456,
  scheduleTimezone: "Asia/Shanghai",
  outputDirectory: "outputs",
} as const;
