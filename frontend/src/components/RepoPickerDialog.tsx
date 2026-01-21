import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface RepoPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  repos: string[];
  repo: string;
  onRepoChange: (repo: string) => void;
  onConfirm: () => void;
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export function RepoPickerDialog({
  open,
  onOpenChange,
  date,
  repos,
  repo,
  onRepoChange,
  onConfirm,
  title = "Select repository",
  description,
  confirmLabel = "Open",
  cancelLabel = "Cancel",
}: RepoPickerDialogProps) {
  const resolvedDescription =
    description || `Multiple repositories have daily summaries for ${date}.`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{resolvedDescription}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Label>Repository</Label>
          <Select value={repo} onValueChange={onRepoChange}>
            <SelectTrigger aria-label="Select repository" className="bg-white">
              <SelectValue placeholder="Select repository" />
            </SelectTrigger>
            <SelectContent>
              {repos.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </Button>
          <Button onClick={onConfirm} disabled={!repo}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

