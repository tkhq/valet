import type { ReactNode } from "react";
import { SectionHeading } from "~/components/settings/section";

/** The order every Access page shares. `proxy` is null until the scope's
 * proxy data loads. */
export function ProxyAccessLayout({ setupIntro, setup, proxy, children }: {
  setupIntro?: ReactNode; setup: ReactNode; proxy: ReactNode; children?: ReactNode;
}) {
  return (
    <>
      <section className="min-w-0 max-w-full space-y-6">
        <SectionHeading title="Set up a coding tool" />
        {setupIntro}
        {setup}
      </section>
      {children}
      {proxy}
    </>
  );
}
