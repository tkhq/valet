/**
 * The in-app tour's steps (docs/specs/2026-11-03-feature-tour-design.md).
 * On a wider screen each step with a `target` is a popover anchored on the
 * element with that `data-tour` value. A step whose target is not on the
 * page (a feature is off, the sidebar is collapsed, the person lacks access)
 * is skipped. A phone shows every step as a full-screen card with its
 * `phone` copy, because its targets sit in the closed drawer.
 *
 * Step ids are saved as the resume point. Rename one only with a version
 * bump, or a person mid-tour resumes at the first step.
 */
import { House, ListChecks, MessageSquare, MessagesSquare, Plug, Radio, User, Workflow, type LucideIcon } from "lucide-react";

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** Copy for the phone card, where the drawer and tabs replace the sidebar. */
  phone?: string;
  /** The `data-tour` value of the element the popover points at. None: a centered card. */
  target?: string;
  side?: "right" | "bottom" | "left";
  /** A plugin the step is about. The step is skipped when the plugin is off for the person. */
  plugin?: string;
  /** Shown on the phone card and the centered card, where no element is pointed at. */
  icon: LucideIcon;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "home",
    icon: House,
    title: "Home",
    body: "Home is your conversation with Valet. Ask for anything here. When Valet starts a task for you, the task shows in Tasks.",
    phone: "Home is your conversation with Valet. Ask for anything here. When Valet starts a task for you, the task shows in the Tasks tab.",
    target: "home",
    side: "right",
  },
  {
    id: "tasks",
    icon: ListChecks,
    title: "Tasks",
    body: "Tasks shows what needs you, what is in progress, and what is finished. Open a task to see its thread.",
    phone: "The Tasks tab shows what needs you, what is in progress, and what is finished. Tap a task to open its thread.",
    target: "tasks",
    side: "bottom",
  },
  {
    id: "spaces",
    icon: User,
    title: "Spaces",
    body: "Spaces lists Personal and each of your teams. Each space has Threads, Workflows, Presence, and Artifacts. When you open another space, you stay on the same page.",
    phone: "Open the menu at the top left to see Spaces: Personal and each of your teams. Each space has Threads, Workflows, Presence, and Artifacts.",
    target: "spaces",
    side: "right",
  },
  {
    id: "threads",
    icon: MessageSquare,
    title: "Threads and projects",
    body: "Each piece of work has its own thread. Put related threads in a project to keep them together. Valet archives a thread after 7 days without use, by default. A new message brings it back.",
    phone: "The menu also lists your threads. Put related threads in a project to keep them together. Valet archives a thread after 7 days without use, by default. A new message brings it back.",
    target: "projects",
    side: "right",
  },
  {
    id: "workflows",
    icon: Workflow,
    title: "Workflows",
    body: "A workflow does recurring work for you, on a schedule or when an event occurs.",
    target: "workflows",
    side: "right",
  },
  {
    id: "presence",
    icon: Radio,
    title: "Presence",
    body: "Presence shows where Valet watches and acts: Slack channels, repositories, and schedules.",
    target: "presence",
    side: "right",
  },
  {
    id: "integrations",
    icon: Plug,
    title: "Integrations",
    body: "Each space has a Settings row with Integrations, Skills, Memory, and Usage. Connect your accounts in Integrations. You can share a connection with a team.",
    target: "space-settings",
    side: "right",
  },
  {
    id: "slack",
    icon: MessagesSquare,
    title: "Slack",
    body: "Send Valet a direct message in Slack, or mention it in a channel. Valet can reply with images and diagrams.",
    plugin: "slack",
  },
];

/** The line under the last step. */
export const TOUR_REPLAY_HINT = "To see this tour again, open your account menu and choose Take the tour.";

/** Pure: the first index at or after `from` (moving by `direction`) whose step
 * is available, or -1 when none is left. */
export function nextAvailableIndex(
  steps: readonly TourStep[],
  from: number,
  available: (step: TourStep) => boolean,
  direction: 1 | -1 = 1,
): number {
  for (let index = from; index >= 0 && index < steps.length; index += direction) {
    if (available(steps[index]!)) return index;
  }
  return -1;
}

/** Pure: where a tour starts. A saved step id resumes there; an unknown or
 * missing id starts at the beginning. */
export function resumeIndex(steps: readonly TourStep[], savedStep: string | null): number {
  const index = savedStep === null ? -1 : steps.findIndex((step) => step.id === savedStep);
  return index < 0 ? 0 : index;
}

/** The visible element a step points at, if it is on the page. */
export function findTourTarget(target: string, root: ParentNode = document): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>(`[data-tour="${target}"]`)) {
    // Skip a hidden copy (a closed menu, `display: none`). A browser
    // without checkVisibility counts every match as visible.
    if (typeof element.checkVisibility !== "function" || element.checkVisibility()) return element;
  }
  return null;
}
