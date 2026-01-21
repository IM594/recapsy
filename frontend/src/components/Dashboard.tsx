import { useState } from "react";
import {
  CalendarDays,
  Calendar,
  Trophy,
  ArrowRight,
  Clock,
  Settings,
  LayoutTemplate,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { useSettings } from "@/hooks/useSettings";
import { SettingsDialog } from "./SettingsDialog";
import { GenerationPreview } from "./GenerationPreview";
import { toast } from "sonner";
import { COPY } from "@/constants/copy";
import type { GenerationConfig, SummaryType } from "@/types/summary";

// Updated signature to match App.tsx
type GenerationRequest = Pick<
  GenerationConfig,
  "summaryType" | "year" | "since" | "until"
>;

interface DashboardProps {
  onGenerate: (req: GenerationRequest) => Promise<void>;
  onViewYearReview: (mode: "view" | "regenerate") => void;
  year?: number;
  isGenerating?: boolean;
}

export function Dashboard({
  onGenerate,
  onViewYearReview,
  year = new Date().getFullYear(),
  isGenerating = false,
}: DashboardProps) {
  const { isConfigured } = useSettings();
  const [showSettings, setShowSettings] = useState(false);
  const [previewType, setPreviewType] = useState<SummaryType | null>(null);

  const handleAction = (type: SummaryType) => {
    if (!isConfigured) {
      toast.info(COPY.toasts.configureReposFirst);
      setShowSettings(true);
      return;
    }
    setPreviewType(type);
  };

  const handleEnterBoard = () => {
    onViewYearReview("view");
  };

  return (
    <div className="space-y-8 animate-in fade-in duration-700 relative">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-900">
            {COPY.dashboard.title}
          </h2>
          <p className="text-muted-foreground mt-1">
            {isConfigured
              ? COPY.dashboard.subtitle.configured
              : COPY.dashboard.subtitle.notConfigured}
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-sm text-slate-500 bg-white border px-3 py-1 rounded-full flex items-center gap-2 shadow-sm">
            <Clock className="h-3 w-3" />
            {new Date().toLocaleDateString()}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setShowSettings(true)}
            title={COPY.dashboard.settingsButtonTitle}
          >
            <Settings className="h-5 w-5 text-slate-500 hover:text-slate-900 transition-colors" />
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {/* Daily */}
        <Button
          variant="outline"
          className="h-40 flex flex-col items-center justify-center gap-4 hover:border-blue-300 hover:bg-blue-50/50 transition-all border-2 group"
          onClick={() => handleAction("daily")}
          disabled={isGenerating}
        >
          <div className="p-4 bg-blue-100 text-blue-600 rounded-full group-hover:scale-110 transition-transform">
            <CalendarDays className="h-6 w-6" />
          </div>
          <div className="text-center">
            <span className="font-semibold text-lg block text-slate-700 group-hover:text-blue-700">
              {COPY.summaryTypes.label("daily")}
            </span>
            <span className="text-xs text-muted-foreground group-hover:text-blue-600">
              {COPY.dashboard.cards.daily.description}
            </span>
          </div>
        </Button>

        {/* Weekly */}
        <Button
          variant="outline"
          className="h-40 flex flex-col items-center justify-center gap-4 hover:border-purple-300 hover:bg-purple-50/50 transition-all border-2 group"
          onClick={() => handleAction("weekly")}
          disabled={isGenerating}
        >
          <div className="p-4 bg-purple-100 text-purple-600 rounded-full group-hover:scale-110 transition-transform">
            <Calendar className="h-6 w-6" />
          </div>
          <div className="text-center">
            <span className="font-semibold text-lg block text-slate-700 group-hover:text-purple-700">
              {COPY.summaryTypes.label("weekly")}
            </span>
            <span className="text-xs text-muted-foreground group-hover:text-purple-600">
              {COPY.dashboard.cards.weekly.description}
            </span>
          </div>
        </Button>

        {/* Monthly */}
        <Button
          variant="outline"
          className="h-40 flex flex-col items-center justify-center gap-4 hover:border-indigo-300 hover:bg-indigo-50/50 transition-all border-2 group"
          onClick={() => handleAction("monthly")}
          disabled={isGenerating}
        >
          <div className="p-4 bg-indigo-100 text-indigo-600 rounded-full group-hover:scale-110 transition-transform">
            <LayoutTemplate className="h-6 w-6" />
          </div>
          <div className="text-center">
            <span className="font-semibold text-lg block text-slate-700 group-hover:text-indigo-700">
              {COPY.summaryTypes.label("monthly")}
            </span>
            <span className="text-xs text-muted-foreground group-hover:text-indigo-600">
              {COPY.dashboard.cards.monthly.description}
            </span>
          </div>
        </Button>

        {/* Yearly */}
        <Button
          variant="outline"
          className="h-40 flex flex-col items-center justify-center gap-4 hover:border-amber-300 hover:bg-amber-50/50 transition-all border-2 group"
          onClick={() => handleAction("yearly")}
          disabled={isGenerating}
        >
          <div className="p-4 bg-amber-100 text-amber-600 rounded-full group-hover:scale-110 transition-transform">
            <Trophy className="h-6 w-6" />
          </div>
          <div className="text-center">
            <span className="font-semibold text-lg block text-slate-700 group-hover:text-amber-700">
              {COPY.summaryTypes.label("yearly")}
            </span>
            <span className="text-xs text-muted-foreground group-hover:text-amber-600">
              {COPY.dashboard.cards.yearly.description(year)}
            </span>
          </div>
        </Button>
      </div>

      {/* Unified Board Access */}
      <Card className="border-2 border-slate-200 bg-slate-50/50">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>{COPY.dashboard.unifiedBoard.title}</CardTitle>
            <CardDescription>
              {COPY.dashboard.unifiedBoard.description}
            </CardDescription>
          </div>
          <Button onClick={handleEnterBoard} className="gap-2">
            {COPY.common.buttons.enterBoard}
            <ArrowRight className="h-4 w-4" />
          </Button>
        </CardHeader>
      </Card>

      <SettingsDialog open={showSettings} onOpenChange={setShowSettings} />

      {previewType && (
        <GenerationPreview
          open={!!previewType}
          onOpenChange={(open) => !open && setPreviewType(null)}
          type={previewType}
          year={year}
          onGenerateStart={(req) => {
            onGenerate(req);
            setPreviewType(null);
          }}
        />
      )}
    </div>
  );
}
