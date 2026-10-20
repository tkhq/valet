import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontal } from "lucide-react";
import { useState } from "react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/primitives";
import { ImportV1Dialog } from "./import-v1-dialog";
import { ImportWorkflowDialog } from "./import-workflow-dialog";
import { NewWorkflowDialog } from "./new-workflow-dialog";

/**
 * The Workflows page actions, in the page header's title row like every
 * other page's actions. "New workflow" opens the composer through the list's
 * `create` search param, so the header and the list share one state.
 */
export function WorkflowsHeaderActions() {
  const navigate = useNavigate();
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [v1Open, setV1Open] = useState(false);

  return (
    <div className="flex items-center gap-2">
      <Button size="sm" onClick={() => void navigate({ to: "/workflows", search: (prev) => ({ ...prev, create: true }) })}>
        New workflow
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="ghost" aria-label="Workflow options"><MoreHorizontal className="h-4 w-4" /></Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setImportOpen(true)}>Import workflow</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setV1Open(true)}>Import from V1</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setNewOpen(true)}>Manual setup</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportWorkflowDialog open={importOpen} onOpenChange={setImportOpen} />
      <ImportV1Dialog open={v1Open} onOpenChange={setV1Open} />
    </div>
  );
}
