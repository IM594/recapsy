import type { SummaryType } from "@/types/summary";
import { SUMMARY_TYPES } from "@recaply/shared";

const SUMMARY_TYPE_LABELS: Record<SummaryType, string> = {
  daily: "Daily Brief",
  weekly: "Weekly Report",
  monthly: "Monthly Summary",
  yearly: "Yearly Review",
};

export const COPY = {
  appName: "Recaply",

  common: {
    buttons: {
      backToDashboard: "Back to Dashboard",
      cancel: "Cancel",
      close: "Close",
      open: "Open",
      jump: "Jump",
      rescan: "Rescan",
      startGeneration: "Start Generation",
      enterBoard: "Enter Board",
      regenerate: "Regenerate",
      refine: "Refine",
      copy: "Copy",
      download: "Download",
      saveConfiguration: "Save Configuration",
    },
    aria: {
      selectYear: "Select year",
      selectMonth: "Select month",
      selectRepository: "Select repository",
    },
    placeholders: {
      year: "Year",
      selectMonth: "Select month",
      selectRepository: "Select repository",
      repository: "Repository",
      authorExample: "e.g. user",
      scanRootExample: "e.g. /Users/you/projects",
    },
    labels: {
      repository: "Repository",
      pickDate: "Pick a date",
      pickMonth: "Pick a month",
      timeRange: "Time Range:",
      repositories: "Repositories:",
      author: "Author:",
      gitAuthorName: "Git Author Name",
      scanRootPath: "Scan Root Path",
    },
    tabs: {
      read: "Read",
      source: "Source",
    },
    words: {
      you: "you",
    },
  },

  toasts: {
    noCommitsFound: "No commits found for the selected period.",
    regenerationSuccessful: "Regeneration successful!",
    regenerationFailedFallback: "Regeneration failed",
    taskAlreadyRunning: "A task is already running.",
    startedGenerationTask: "Started background generation task...",
    generationCompleted: "Summary generation completed!",
    workflowErrorPrefix: "Error:",

    copiedToClipboard: "Copied to clipboard",
    copyFailed: "Copy failed",
    downloadingMarkdown: "Downloading markdown file...",
    downloadFailed: "Download failed",

    scanReposFailed: "Failed to scan repositories",
    selectAtLeastOneRepo: "Please select at least one repository",
    settingsSaved: "Settings saved",

    boardStructureFailed: "Failed to load board structure",
    boardContentFailed: "Failed to load content",
    missingDailyRepoForRegeneration: "Missing repo info for daily regeneration",
    networkErrorDuringRegeneration: "Network error during regeneration",
    resetStatusFailed: "Failed to reset status",
    configureReposFirst: "Please configure your repositories first",
    noDailySummariesForDate: (date: string) => `No daily summaries for ${date}.`,
  },

  app: {
    generatedSummaryDialogTitle: "Generated Summary",
  },

  summaryTypes: {
    label: (type: SummaryType) => SUMMARY_TYPE_LABELS[type],
    generationPreviewTitle: (type: SummaryType, year: number) => {
      if (type === SUMMARY_TYPES.yearly) return `Yearly Review (${year})`;
      return SUMMARY_TYPE_LABELS[type];
    },
  },

  dashboard: {
    title: "Work Dashboard",
    subtitle: {
      configured: "Generate summaries or view your progress.",
      notConfigured: "Connect your repositories to get started.",
    },
    settingsButtonTitle: "Settings",
    cards: {
      daily: {
        title: SUMMARY_TYPE_LABELS.daily,
        description: "Summarize today's work",
      },
      weekly: {
        title: SUMMARY_TYPE_LABELS.weekly,
        description: "Review this week",
      },
      monthly: {
        title: SUMMARY_TYPE_LABELS.monthly,
        description: "Wrap up the month",
      },
      yearly: {
        title: SUMMARY_TYPE_LABELS.yearly,
        description: (year: number) => `${year} Retrospective`,
      },
    },
    unifiedBoard: {
      title: "Unified Board",
      description: "Access all your generated summaries in one place.",
    },
  },

  settings: {
    title: "Configure Work Context",
    description: "Select the repositories you work on and your git author name.",
    gitAuthorHelp: "Used to filter commits that belong to you.",
    scanRootHelp: "Used to discover git repositories for selection.",
    scanningDirectories: "Scanning directories...",
    emptyRepos: "No git repositories found in default path.",
    repositoriesSelectedLabel: (count: number) =>
      `Repositories (${count} selected)`,
  },

  generationPreview: {
    title: (type: SummaryType, year: number) => {
      if (type === SUMMARY_TYPES.yearly) return `Generate Yearly Review (${year})`;
      return `Generate ${SUMMARY_TYPE_LABELS[type]}`;
    },
    description: "Review the scope before generating your summary.",
    help: {
      dailyOrWeekly: (type: typeof SUMMARY_TYPES.daily | typeof SUMMARY_TYPES.weekly) =>
        `We will generate a ${type} summary for the selected period.`,
      monthly: (year: number) => `We will generate a monthly summary for ${year}.`,
    },
    checkingExistingData: "Checking existing data...",
    alreadyExists: {
      title: "Summary Already Exists",
      description:
        "Existing summaries were found for this period. Generation will reuse cached results where available.",
    },
    ready: {
      title: "Ready to Generate",
      description: "No existing data found. You are good to go.",
    },
    buttons: {
      overwriteGenerate: "Overwrite & Generate",
      generateSummary: "Generate Summary",
    },
  },

  repoPicker: {
    title: "Select repository",
    description: (date: string) =>
      `Multiple repositories have daily summaries for ${date}.`,
  },

  resultCard: {
    defaultTitle: "Generation Complete",
    refinePlaceholder:
      "Add extra instructions (e.g., 'Make it more concise', 'Focus on bug fixes')",
    regeneratingButtonLabel: "Regenerating...",
  },

  unifiedBoard: {
    loading: "Loading board...",
    weekTitle: (weekNumber: number) => `Week ${weekNumber}`,
    empty: {
      title: "Select an entry to view details",
      description: "Explore your work history using the heatmap or timeline",
    },
  },

  journalSidebar: {
    searchButton: "Search logs...",
    jumpButton: "Jump to date/month...",
    activityTitle: (year: number) => `${year} Activity`,
    annualReview: "Annual Review",
    timelineHeading: "Timeline",
    weekOf: (weekStart: string) => `Week of ${weekStart}`,
    noLogs: "No logs",
    jumpDialog: {
      title: "Jump to entry",
      description: (year: number) => `Select a date or month to navigate within ${year}.`,
      tabs: {
        day: "Day",
        week: "Week",
        month: "Month",
      },
      multiRepoHint:
        "Multiple repositories found for this day — you will be asked to choose one.",
    },
    commandPalette: {
      inputPlaceholder: "Type a command or search...",
      empty: "No results found.",
      recentHeading: "Recent",
      allEntriesHeading: "All Entries",
    },
  },

  journalEntry: {
    refineTitle: "Refine with AI",
    refinePlaceholder:
      "Tell AI how to improve this summary... (e.g., 'Make it more concise', 'Focus on the bug fix')",
    loading: "Consulting the archives...",
    noEntry: {
      line1: "No journal entry for this date.",
      line2: 'Click "Refine" to generate one.',
    },
    rawContextTitle: "Raw Context Data",
    rawContextPlaceholderNote:
      "Raw source view not yet implemented, showing node info",
    minRead: (minutes: string) => `${minutes} min read`,
  },

  contributionGraph: {
    monthLabels: {
      jan: "Jan",
      jun: "Jun",
      dec: "Dec",
    },
    activityMark: "✅",
  },

  yearEnd: {
    steps: {
      collect: {
        title: "Collecting Data",
        description: "Scanning git history",
      },
      daily: {
        title: "Analyzing Days",
        description: "Generating daily summaries",
      },
      weekly: {
        title: "Structuring Weeks",
        description: "Aggregating weekly reports",
      },
      monthly: {
        title: "Structuring Months",
        description: "Aggregating monthly reports",
      },
      yearly: {
        title: "Finalizing Review",
        description: "Writing executive summary",
      },
    },
    generatingTitle: (year: number) => `Generating ${year} Review`,
    generatingDescription: {
      error: "An error occurred during generation.",
      running: "Hold tight, we're condensing a year of work into insights.",
    },
    readyTitle: (year: number) => `Ready for ${year} Review?`,
    readyDescription: (repoCount: number, author: string) =>
      `We will analyze your git history from ${repoCount} repositories acting as ${author}.`,
  },
} as const;
