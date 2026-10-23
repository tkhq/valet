export type ProgressStatus = "pending" | "in_progress" | "waiting" | "complete" | "error" | "interrupted";

export interface ProgressTask {
  id: string;
  title: string;
  status: ProgressStatus;
  details?: string;
  output?: string;
  sources?: Array<{ url: string; title: string }>;
}

export interface TurnProgress {
  turnId: string;
  title: string;
  status: ProgressStatus;
  revision: string;
  updatedAt: number;
  tasks: ProgressTask[];
  omittedTasks: number;
}
