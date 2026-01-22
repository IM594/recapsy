export interface RepoConfigFile {
  version?: string;
  profiles?: Record<string, unknown>;
  activeProfile?: string;
}

export interface NormalizedProfileConfig {
  git: {
    rootPaths: string[];
    defaultRepos: string[];
    authorPattern: string;
    includeStat: boolean;
    sinceFallback: string;
  };
  output: {
    directory: string | null;
  };
  schedule: {
    enabled: boolean;
    cron: string;
    timezone: string;
  };
}

export interface AppConfig {
  server: {
    port: number;
  };
  repos: {
    defaultRootPath: string | null;
  };
  git: {
    includeStat: boolean;
    rootPaths: string[];
  };
  paths: {
    envPath: string | null;
    configPath: string;
    outputDir: string;
  };
  schedule: {
    enabled: boolean;
    cron: string;
    timezone: string;
  };
}

