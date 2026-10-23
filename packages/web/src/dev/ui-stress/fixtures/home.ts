/**
 * Home fixtures: the person's home conversation and a Tasks list that spans
 * three workspaces, with long titles, plans, questions, and finished tasks.
 */
import type { HomeConversationResponse, HomeTaskItem, HomeTasksResponse } from "@valet/api/wire";
import { HOUR, MINUTE, NOW, TITLE_400, stressTeams, unbroken, words } from "./common";
import { SIDEBAR_SESSION_ID } from "./threads";

export const HOME_THREAD_ID = "thread-home-stress";
export const stressHomeConversation: HomeConversationResponse = { sessionId: SIDEBAR_SESSION_ID, threadId: HOME_THREAD_ID };

const personal = { key: "user", name: "Personal" };
const team = (i: number) => ({ key: stressTeams[i % stressTeams.length]!.id, name: stressTeams[i % stressTeams.length]!.name });

function item(id: number, partial: Partial<HomeTaskItem> & Pick<HomeTaskItem, "state">): HomeTaskItem {
  return { id: `home-task-${id}`, sessionId: SIDEBAR_SESSION_ID, threadId: `thread-home-task-${id}`, title: `Task ${id}`,
    workspace: personal, updatedAt: NOW - id * 7 * MINUTE, ...partial };
}

export const HOME_TASK_COUNT = 14;

export const stressHomeTasks: HomeTasksResponse = {
  needsYou: [
    item(1, { state: "needs_you", title: "Merge the Slack table fix after the soak", workspace: team(0) }),
    item(2, { state: "waiting", question: true, title: TITLE_400, workspace: team(1),
      detail: "Which repository should the release report read from, the monorepo or the deploy repository?" }),
    item(3, { state: "failed", title: unbroken("deploy-check-", 120), workspace: personal }),
  ],
  working: [
    item(4, { state: "working", title: "Port the Slack table fix to the production instance", workspace: team(0),
      plan: { done: 2, total: 5, current: "Deploy the branch and watch the first reply render" }, homeTaskId: "ht_4" }),
    item(5, { state: "working", title: "Refresh the recruiting dashboard", workspace: team(1), plan: { done: 7, total: 7 } }),
    item(6, { state: "working", title: words("Investigate the overnight alert storm in the incident channel", 180), workspace: team(2),
      plan: { done: 0, total: 20, current: words("Read every alert since midnight and group them by service", 200) } }),
    item(7, { state: "working", title: "Draft the weekly update", workspace: personal }),
  ],
  updates: [
    item(8, { state: "waiting", unread: true, title: "Calendar cleanup", workspace: personal,
      detail: "I moved the design review to Thursday and declined the duplicate invite." }),
    item(9, { state: "waiting", title: "Vendor contract summary", workspace: team(0), detail: words("The contract renews automatically each year unless you cancel", 600) }),
    item(10, { state: "waiting", title: "سجل التغييرات للإصدار التالي", workspace: team(1), detail: "تمت كتابة المسودة وهي جاهزة للمراجعة." }),
  ],
  finished: [
    item(11, { state: "done", title: "Summarize the customer call", workspace: personal, homeTaskId: "ht_11", updatedAt: NOW - 2 * HOUR }),
    item(12, { state: "done", title: "Open the pull request for the drawer", workspace: team(0), homeTaskId: "ht_12", plan: { done: 4, total: 4 },
      outputs: [
        { kind: "pull_request", title: "tkhq/valet #1031", href: "https://github.com/tkhq/valet/pull/1031", state: "merged", updatedAt: NOW - 20 * MINUTE },
        { kind: "file", title: words("Drawer redesign notes with a long title that wraps", 120), href: "/a/fixture-token", updatedAt: NOW - 2 * HOUR },
      ] }),
    item(13, { state: "done", title: TITLE_400, workspace: team(2), homeTaskId: "ht_13" }),
    item(14, { state: "done", title: "🚀 Ship the release notes 🎉", workspace: team(1), homeTaskId: "ht_14" }),
  ],
};

export const stressBrief = {
  headline: "Morning. 4 in progress, 2 need you.",
  items: [
    { topic: "Release report", text: "Drafted and waiting for your OK to post in #eng.", state: "needs_you" as const, threadId: "thread-home-task-1" },
    { topic: "TKAI-512", text: words("The fix is up and needs a reviewer before the freeze window starts", 220), state: "needs_you" as const },
    { topic: "Recruiting dashboard", text: "Refreshing now. Done around 10.", state: "working" as const },
    { topic: "Alerts", text: "Quiet overnight.", state: "fyi" as const },
    { topic: unbroken("verylongtopic", 40), text: "Shipped.", state: "done" as const },
  ],
};
