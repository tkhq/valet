// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { PageTitleProvider, usePageTitle, usePageTitleCount } from "./page-title";

function Page({ title }: { title: string }) {
  usePageTitle(title);
  return null;
}

it("updates conversation and workspace titles, then clears the conversation on navigation", () => {
  const view = render(<PageTitleProvider workspaceName="Platform"><Page title="Fix login" /></PageTitleProvider>);
  expect(document.title).toBe("Fix login · Platform · Valet");
  view.rerender(<PageTitleProvider workspaceName="Platform"><Page title="Login fixed" /></PageTitleProvider>);
  expect(document.title).toBe("Login fixed · Platform · Valet");
  view.rerender(<PageTitleProvider workspaceName="Personal"><Page title="New idea" /></PageTitleProvider>);
  expect(document.title).toBe("New idea · Personal · Valet");
  view.rerender(<PageTitleProvider workspaceName="Personal"><div>Dashboard</div></PageTitleProvider>);
  expect(document.title).toBe("Personal · Valet");
  view.unmount();
  expect(document.title).toBe("Valet");
});

function Notifications({ count }: { count: number }) {
  usePageTitleCount(count);
  return null;
}

it("preserves page and workspace names across notification refreshes and navigation", () => {
  const view = render(<PageTitleProvider workspaceName="Personal"><Notifications count={0} /><Page title="Fix login" /></PageTitleProvider>);
  expect(document.title).toBe("Fix login · Personal · Valet");
  view.rerender(<PageTitleProvider workspaceName="Personal"><Notifications count={2} /><Page title="Fix login" /></PageTitleProvider>);
  expect(document.title).toBe("(2) Fix login · Personal · Valet");
  view.rerender(<PageTitleProvider workspaceName="Platform"><Notifications count={2} /><Page title="Review changes" /></PageTitleProvider>);
  expect(document.title).toBe("(2) Review changes · Platform · Valet");
  view.rerender(<PageTitleProvider workspaceName="Platform"><Notifications count={0} /></PageTitleProvider>);
  expect(document.title).toBe("Platform · Valet");
});
