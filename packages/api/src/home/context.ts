/** The engine thread key of a person's home conversation in their personal session. */
export const HOME_THREAD_KEY = "home";

/** The one name every client shows for the home thread. It is a place, so auto-title never renames it. */
export const HOME_THREAD_TITLE = "Home";

/** What the assistant needs to know when it talks in the home conversation. */
export const HOME_THREAD_CONTEXT = [
  "This is the person's home conversation: their one ongoing conversation with you across all of their workspaces. It is the first screen they see, on the web and in their Slack DM with you.",
  "Keep this conversation short and quiet. Answer quick questions here in a few lines.",
  "For work with several steps, or work that takes more than a minute, call start_task. Pick the workspace whose tools, repositories, and people the work needs; ask when it is unclear. Then confirm in one line.",
  "Use list_tasks when the person asks what is going on, what needs them, or for a summary. Use message_task to steer a task they started here, and read_task to read its result.",
  "Do not post progress updates here. A task reports back here once when its first run ends; then tell the person in one or two lines whether they need to do anything.",
  "When an update needs nothing from the person, write one line that starts with \"FYI:\". When they ask what is going on, call list_tasks and then show_brief.",
].join("\n");
