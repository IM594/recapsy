import { useUnifiedBoard } from "@/hooks/useUnifiedBoard";
import { COPY } from "@/constants/copy";
import { JournalSidebar } from "./unified-board/JournalSidebar";
import { JournalEntry } from "./unified-board/JournalEntry";
import { RepoPickerDialog } from "@/components/RepoPickerDialog";

interface UnifiedBoardProps {
  year?: number;
}

export function UnifiedBoard({
  year = new Date().getFullYear(),
}: UnifiedBoardProps) {
  const {
    structure,
    selectedNode,
    setSelectedNode,
    content,
    loadingContent,
    regenerating,
    regenerate,
    repoPicker,
    setRepoPickerOpen,
    setRepoPickerRepo,
    confirmRepoPicker,
  } = useUnifiedBoard(year);

  if (!structure) {
    return (
      <div className="p-8 text-center text-muted-foreground animate-pulse">
        {COPY.unifiedBoard.loading}
      </div>
    );
  }

  return (
    <>
      <RepoPickerDialog
        open={repoPicker.open}
        onOpenChange={setRepoPickerOpen}
        date={repoPicker.date}
        repos={repoPicker.repos}
        repo={repoPicker.repo}
        onRepoChange={setRepoPickerRepo}
        onConfirm={confirmRepoPicker}
      />

      <div className="grid grid-cols-12 h-[calc(100vh-10rem)] bg-white rounded-lg shadow-sm border border-slate-200 overflow-hidden">
      {/* Sidebar - Timeline Navigation */}
      <div className="col-span-3 h-full overflow-hidden border-r bg-slate-50">
        <JournalSidebar
          structure={structure}
          selectedNode={selectedNode}
          onSelect={setSelectedNode}
          className="h-full"
        />
      </div>

      {/* Main Content Area */}
      <div className="col-span-9 h-full overflow-hidden bg-white relative">
        {selectedNode ? (
          <JournalEntry
            node={selectedNode}
            content={content}
            loading={loadingContent}
            onRegenerate={regenerate}
            isRegenerating={regenerating}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-400">
            <div className="h-16 w-16 bg-slate-100 rounded-full flex items-center justify-center mb-4">
              <span className="text-2xl">📓</span>
            </div>
            <p className="text-lg font-medium text-slate-500">
              {COPY.unifiedBoard.empty.title}
            </p>
            <p className="text-sm">
              {COPY.unifiedBoard.empty.description}
            </p>
          </div>
        )}
      </div>
    </div>
    </>
  );
}
