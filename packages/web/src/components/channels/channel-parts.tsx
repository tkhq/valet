/** Small shared pieces of the channel views: the provider icon and link. */
import { ArrowUpRight, GitPullRequest, Slack } from "lucide-react";
import type { ChannelProvider } from "@valet/api/wire";
import { cn } from "~/lib/cn";
import { textLinkClass } from "~/components/primitives";

export function ChannelIcon({ provider, className }: { provider: ChannelProvider; className?: string }) {
  const Icon = provider === "slack" ? Slack : GitPullRequest;
  return <Icon aria-hidden className={cn("h-4 w-4 shrink-0 text-muted", className)} />;
}

/** "Open in Slack" or "Open on GitHub", in a new tab. */
export function ProviderLink({ provider, href, label, className }: {
  provider: ChannelProvider; href: string; label?: string; className?: string;
}) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={cn(textLinkClass, "text-xs", className)}>
      {label ?? (provider === "slack" ? "Open in Slack" : "Open on GitHub")}
      <ArrowUpRight aria-hidden className="h-3 w-3" />
    </a>
  );
}
