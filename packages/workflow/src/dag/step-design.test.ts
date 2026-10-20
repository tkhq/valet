import { describe, expect, it } from 'vitest';
import { approvalRequestWarning } from './step-design.js';

const session = (prompt: string) => ({ type: 'session', prompt });

describe('approvalRequestWarning', () => {
  it('flags an agent step that tells its agent to get approval', () => {
    expect(approvalRequestWarning(session(
      'Send the people lead a DM: "Linear project creation is ready for approval. Open the workflow run to approve or deny the project creation." Then create the project.',
    ))).toContain('tool step');
    expect(approvalRequestWarning(session('Ask the hiring manager for approval before you send the offer.'))).toBeDefined();
    expect(approvalRequestWarning({ type: 'orchestrator', prompt: 'Call ask_approval before posting.' })).toBeDefined();
    expect(approvalRequestWarning(session('Wait for sign-off from finance, then pay the invoice.'))).toBeDefined();
  });

  it('stays quiet for prompts that forbid asking, or never mention approval', () => {
    expect(approvalRequestWarning(session('The project already exists. Do not ask anyone for approval or send DMs.'))).toBeUndefined();
    expect(approvalRequestWarning(session('Never request approval; report what you need instead.'))).toBeUndefined();
    expect(approvalRequestWarning(session('Summarize the approved budget in three bullets.'))).toBeUndefined();
    expect(approvalRequestWarning({ type: 'llm', prompt: 'Ask for approval.' })).toBeUndefined();
  });
});
