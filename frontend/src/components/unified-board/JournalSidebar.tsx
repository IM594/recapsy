import { useEffect, useMemo, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Calendar as CalendarIcon,
  Search,
  LayoutTemplate,
  Trophy,
  CalendarRange,
  ChevronRight,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { getWeekMonday, toDateString } from "@/lib/date-utils";
import { RepoPickerDialog } from "@/components/RepoPickerDialog";
import { YearCalendar } from "@/components/YearCalendar";
import { MonthSelect } from "@/components/MonthSelect";

import { Structure, NavigationNode } from "./types";
import { ContributionGraph } from "./ContributionGraph";

interface JournalSidebarProps {
  structure: Structure;
  selectedNode: NavigationNode | null;
  onSelect: (node: NavigationNode) => void;
  className?: string;
}

export function JournalSidebar({
  structure,
  selectedNode,
  onSelect,
  className,
}: JournalSidebarProps) {
  const [openCommand, setOpenCommand] = useState(false);
  const [expandedMonths, setExpandedMonths] = useState<string[]>([]);
  const [jumpOpen, setJumpOpen] = useState(false);
  const [jumpTab, setJumpTab] = useState<"daily" | "weekly" | "monthly">(
    "daily"
  );
  const [jumpDate, setJumpDate] = useState<Date | undefined>(undefined);
  const [jumpMonth, setJumpMonth] = useState<string>("01");
  const [repoPicker, setRepoPicker] = useState<{
    open: boolean;
    date: string;
    repos: string[];
    repo: string;
  }>({ open: false, date: "", repos: [], repo: "" });

  // Calculate days that have summaries for the heatmap
  const summaryDays = useMemo(() => {
    const days: Date[] = [];
    structure.months.forEach((m) => {
      m.days.forEach((d) => {
        if (d.hasSummary) {
          days.push(parseISO(d.date));
        }
      });
    });
    return days;
  }, [structure]);

  // Flatten structure for Command search
  const searchItems = useMemo(() => {
    const items: {
      label: string;
      value: string;
      node: NavigationNode;
      icon: any;
    }[] = [];

    // Year
    if (structure.hasYearlySummary) {
      items.push({
        label: `${structure.year} Annual Review`,
        value: `year ${structure.year}`,
        node: {
          type: "yearly",
          id: String(structure.year),
          label: "Annual Review",
        },
        icon: Trophy,
      });
    }

    // Months & Days
    structure.months.forEach((m) => {
      items.push({
        label: `${m.month} Monthly Report`,
        value: `month ${m.month} report`,
        node: { type: "monthly", id: m.month, label: `${m.month} Report` },
        icon: CalendarRange,
      });

      m.days.forEach((d) => {
        items.push({
          label: `${d.date} (${d.repo})`,
          value: `daily ${d.date} ${d.repo} log`,
          node: { type: "daily", id: d.date, repo: d.repo, label: d.date },
          icon: CalendarIcon,
        });
      });
    });

    // Weeks
    structure.weeks.forEach((w) => {
      items.push({
        label: `${w.title} (${w.weekStart})`,
        value: `week ${w.title} ${w.weekStart} report`,
        node: { type: "weekly", id: w.weekStart, label: w.title },
        icon: LayoutTemplate,
      });
    });

    return items;
  }, [structure]);

  const toggleMonth = (month: string) => {
    setExpandedMonths((prev) =>
      prev.includes(month) ? prev.filter((m) => m !== month) : [...prev, month]
    );
  };

  const ensureMonthExpanded = (month: string) => {
    if (!month) return;
    setExpandedMonths((prev) => (prev.includes(month) ? prev : [...prev, month]));
  };

  const getDailyReposForDate = (dateStr: string): string[] => {
    const repos = new Set<string>();
    for (const m of structure.months) {
      for (const d of m.days) {
        if (d.date === dateStr) repos.add(d.repo);
      }
    }
    return Array.from(repos).sort((a, b) => a.localeCompare(b));
  };

  const selectDaily = (dateStr: string) => {
    const repos = getDailyReposForDate(dateStr);
    const month = dateStr.substring(0, 7);

    if (repos.length === 0) {
      toast.info(`No daily summaries for ${dateStr}.`);
      return;
    }

    if (repos.length === 1) {
      ensureMonthExpanded(month);
      onSelect({ type: "daily", id: dateStr, repo: repos[0], label: dateStr });
      return;
    }

    setRepoPicker({
      open: true,
      date: dateStr,
      repos,
      repo: repos[0],
    });
  };

  const handleHeatmapSelect = (date: Date) => {
    const dateStr = format(date, "yyyy-MM-dd");
    selectDaily(dateStr);
  };

  useEffect(() => {
    if (!jumpOpen) return;
    const today = new Date();
    const defaultDate =
      structure.year === today.getFullYear()
        ? today
        : new Date(structure.year, 0, 1);

    setJumpDate(defaultDate);
    setJumpMonth(
      structure.year === today.getFullYear()
        ? String(today.getMonth() + 1).padStart(2, "0")
        : "01"
    );
    setJumpTab("daily");
  }, [jumpOpen, structure.year]);

  const handleJumpConfirm = () => {
    if (jumpTab === "monthly") {
      const month = `${structure.year}-${jumpMonth}`;
      ensureMonthExpanded(month);
      onSelect({ type: "monthly", id: month, label: `${month} Report` });
      setJumpOpen(false);
      return;
    }

    if (!jumpDate) return;

    if (jumpTab === "weekly") {
      const weekStart = toDateString(getWeekMonday(jumpDate));
      const week = structure.weeks.find((w) => w.weekStart === weekStart);
      ensureMonthExpanded(weekStart.substring(0, 7));
      onSelect({
        type: "weekly",
        id: weekStart,
        label: week?.title ?? `Week of ${weekStart}`,
      });
      setJumpOpen(false);
      return;
    }

    const dateStr = toDateString(jumpDate);
    selectDaily(dateStr);
    setJumpOpen(false);
  };

  return (
    <div
      className={cn(
        "flex flex-col h-full bg-slate-50 border-r border-slate-200",
        className
      )}
    >
      {/* 1. Top Section: Search & Heatmap */}
      <div className="p-4 bg-white border-b border-slate-100 shadow-sm z-10 sticky top-0">
        <Button
          variant="outline"
          className="w-full justify-start text-slate-500 bg-slate-50 border-slate-200 h-9 px-3 mb-4"
          onClick={() => setOpenCommand(true)}
        >
          <Search className="mr-2 h-4 w-4" />
          <span className="text-xs">Search logs...</span>
          <kbd className="pointer-events-none ml-auto inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground opacity-100">
            <span className="text-xs">⌘</span>K
          </kbd>
        </Button>

        <Button
          variant="outline"
          className="w-full justify-start text-slate-500 bg-slate-50 border-slate-200 h-9 px-3 mb-4"
          onClick={() => setJumpOpen(true)}
        >
          <CalendarRange className="mr-2 h-4 w-4" />
          <span className="text-xs">Jump to date/month...</span>
        </Button>

        <div className="mb-1 pl-1">
          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-2 flex items-center gap-2">
            <LayoutTemplate className="h-3 w-3" />
            {structure.year} Activity
          </div>
          <ContributionGraph
            data={summaryDays}
            year={structure.year}
            onSelectDate={handleHeatmapSelect}
          />
        </div>
      </div>

      {/* 2. Scrollable Tree Structure */}
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-1">
          {/* Yearly Node */}
          <div
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors mb-2",
              selectedNode?.type === "yearly"
                ? "bg-amber-50 text-amber-900 border border-amber-200"
                : "hover:bg-slate-100 text-slate-700"
            )}
            onClick={() =>
              onSelect({
                type: "yearly",
                id: String(structure.year),
                label: `Annual Review`,
              })
            }
          >
            <Trophy className="h-4 w-4 text-amber-500" />
            {structure.year} Annual Review
          </div>

          <div className="px-2 pb-2 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
            Timeline
          </div>

          {/* Month Folders */}
          {structure.months
            .slice()
            .reverse()
            .map((m) => {
              const isExpanded = expandedMonths.includes(m.month);
              // const formatMonth = format(parseISO(`${m.month}-01`), "MMMM");
              const formatMonth = m.month
                ? format(parseISO(`${m.month}-01`), "MMMM")
                : "";

              // Find weeks that start in this month
              const displayWeeks = structure.weeks.filter((w) =>
                w.weekStart.startsWith(m.month)
              );

              return (
                <div key={m.month} className="mb-1">
                  <div
                    className={cn(
                      "flex items-center gap-1 px-2 py-1.5 rounded-md text-sm cursor-pointer select-none group transition-colors",
                      selectedNode?.type === "monthly" &&
                        selectedNode.id === m.month
                        ? "bg-indigo-50 text-indigo-900 font-medium"
                        : "hover:bg-slate-100 text-slate-700"
                    )}
                  >
                    <button
                      className="p-0.5 rounded-sm hover:bg-slate-200 text-slate-400"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleMonth(m.month);
                      }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                    </button>

                    <span
                      className="flex-1 flex items-center gap-2"
                      onClick={() =>
                        onSelect({
                          type: "monthly",
                          id: m.month,
                          label: `${m.month} Report`,
                        })
                      }
                    >
                      <CalendarRange className="h-3.5 w-3.5 text-slate-400 group-hover:text-indigo-500" />
                      {formatMonth}
                      {m.hasSummary && (
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500 ml-auto" />
                      )}
                    </span>
                  </div>

                  {/* Sub-items: Weeks & Days */}
                  {isExpanded && (
                    <div className="ml-4 pl-3 border-l border-slate-200 mt-1 space-y-0.5">
                      {/* Weeks in this month */}
                      {displayWeeks.length > 0 && (
                        <div className="mb-2 space-y-0.5">
                          {displayWeeks.reverse().map((w) => (
                            <div
                              key={w.weekStart}
                              className={cn(
                                "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors",
                                selectedNode?.type === "weekly" &&
                                  selectedNode.id === w.weekStart
                                  ? "bg-purple-50 text-purple-900 font-medium"
                                  : "hover:bg-slate-100 text-slate-600"
                              )}
                              onClick={() =>
                                onSelect({
                                  type: "weekly",
                                  id: w.weekStart,
                                  label: w.title,
                                })
                              }
                            >
                              <LayoutTemplate className="h-3 w-3 text-slate-400" />
                              <span className="truncate flex-1">{w.title}</span>
                              {w.hasSummary && (
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Days */}
                      {m.days
                        .slice()
                        .reverse()
                        .map((d) => (
                          <div
                            key={`${d.date}-${d.repo}`}
                            className={cn(
                              "flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer transition-colors",
                              selectedNode?.type === "daily" &&
                                selectedNode.id === d.date &&
                                selectedNode.repo === d.repo
                                ? "bg-blue-50 text-blue-700 font-medium"
                                : "hover:bg-slate-100 text-slate-600"
                            )}
                            onClick={() =>
                              onSelect({
                                type: "daily",
                                id: d.date,
                                repo: d.repo,
                                label: d.date,
                              })
                            }
                          >
                            <span className="w-1 h-1 rounded-full bg-slate-300 shrink-0" />
                            <span className="font-mono shrink-0">
                              {d.date.substring(8)}
                            </span>
                            <span className="text-slate-500 truncate">
                              {d.repo}
                            </span>
                            {d.hasSummary && (
                              <span className="ml-auto text-[9px] text-green-600 font-medium">
                                ✓
                              </span>
                            )}
                          </div>
                        ))}
                      {m.days.length === 0 && (
                        <div className="px-2 py-1 text-xs text-slate-400 italic">
                          No logs
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </ScrollArea>

      {/* Jump Dialog */}
      <Dialog open={jumpOpen} onOpenChange={setJumpOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Jump to entry</DialogTitle>
            <DialogDescription>
              Select a date or month to navigate within {structure.year}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <Tabs value={jumpTab} onValueChange={(v) => setJumpTab(v as any)}>
              <TabsList className="w-full">
                <TabsTrigger value="daily" className="flex-1 text-xs">
                  Day
                </TabsTrigger>
                <TabsTrigger value="weekly" className="flex-1 text-xs">
                  Week
                </TabsTrigger>
                <TabsTrigger value="monthly" className="flex-1 text-xs">
                  Month
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {(jumpTab === "daily" || jumpTab === "weekly") && (
              <div className="space-y-2">
                <Label>Pick a date</Label>
                <YearCalendar
                  year={structure.year}
                  selected={jumpDate}
                  onSelect={setJumpDate}
                />
                {jumpTab === "daily" &&
                  jumpDate &&
                  getDailyReposForDate(toDateString(jumpDate)).length > 1 && (
                    <p className="text-xs text-muted-foreground">
                      Multiple repositories found for this day — you will be
                      asked to choose one.
                    </p>
                  )}
              </div>
            )}

            {jumpTab === "monthly" && (
              <div className="space-y-2">
                <Label>Pick a month</Label>
                <MonthSelect
                  year={structure.year}
                  value={jumpMonth}
                  onValueChange={setJumpMonth}
                />
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setJumpOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleJumpConfirm} disabled={jumpTab !== "monthly" && !jumpDate}>
              Jump
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Repo Picker Dialog (daily only) */}
      <RepoPickerDialog
        open={repoPicker.open}
        onOpenChange={(open) => setRepoPicker((prev) => ({ ...prev, open }))}
        date={repoPicker.date}
        repos={repoPicker.repos}
        repo={repoPicker.repo}
        onRepoChange={(repo) => setRepoPicker((prev) => ({ ...prev, repo }))}
        onConfirm={() => {
          const month = repoPicker.date.substring(0, 7);
          ensureMonthExpanded(month);
          onSelect({
            type: "daily",
            id: repoPicker.date,
            repo: repoPicker.repo,
            label: repoPicker.date,
          });
          setRepoPicker((prev) => ({ ...prev, open: false }));
        }}
      />

      {/* Command Palette */}
      <CommandDialog open={openCommand} onOpenChange={setOpenCommand}>
        <CommandInput placeholder="Type a command or search..." />
        <CommandList>
          <CommandEmpty>No results found.</CommandEmpty>
          <CommandGroup heading="Recent">
            {searchItems.slice(0, 5).map((item) => (
              <CommandItem
                key={item.value}
                onSelect={() => {
                  onSelect(item.node);
                  setOpenCommand(false);
                }}
              >
                <item.icon className="mr-2 h-4 w-4" />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="All Entries">
            {searchItems.slice(5).map((item) => (
              <CommandItem
                key={item.value}
                onSelect={() => {
                  onSelect(item.node);
                  setOpenCommand(false);
                }}
              >
                <item.icon className="mr-2 h-4 w-4" />
                <span>{item.label}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </div>
  );
}
