import { cn } from '@/lib/cn';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

interface HeroMetricCardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  userValue?: string;
  delta?: number;
  /**
   * Whether an increase is good (green) or bad (red). Cost- and error-style
   * metrics should pass 'lower-is-better'. Defaults to 'higher-is-better'.
   */
  deltaPolarity?: 'higher-is-better' | 'lower-is-better';
  tooltip?: React.ReactNode;
  index?: number;
}

export function HeroMetricCard({ icon, label, value, userValue, delta, deltaPolarity = 'higher-is-better', tooltip, index = 0 }: HeroMetricCardProps) {
  return (
    <div
      className="group relative rounded-lg border border-neutral-200/80 bg-white p-5 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] transition-shadow hover:shadow-[0_2px_8px_-2px_rgb(0_0_0/0.08)] animate-stagger-in dark:border-neutral-800 dark:bg-surface-1 dark:shadow-none"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-1 text-neutral-400 transition-colors group-hover:bg-accent/8 group-hover:text-accent">
          {icon}
        </span>
        <span className="label-mono text-neutral-400">{label}</span>
        {tooltip !== undefined && (
          <TooltipProvider delayDuration={150}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`How ${label} is measured`}
                  className="ml-auto inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-300 text-[10px] font-semibold leading-none text-neutral-400 transition hover:border-neutral-500 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-neutral-600 dark:text-neutral-500 dark:hover:border-neutral-400 dark:hover:text-neutral-200"
                >
                  i
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-[340px] text-left leading-relaxed" side="top">
                {tooltip}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <div className="mt-3 flex items-baseline gap-2.5">
        <span className="text-[28px] font-semibold leading-none tabular-nums tracking-tight text-neutral-900 dark:text-neutral-100 animate-number-in" style={{ animationDelay: `${index * 60 + 120}ms` }}>
          {value}
        </span>
        {userValue !== undefined && (
          <span className="font-mono text-[11px] text-neutral-400 dark:text-neutral-500">
            You: {userValue}
          </span>
        )}
        {delta !== undefined && delta !== 0 && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums leading-none',
              (delta > 0) === (deltaPolarity === 'higher-is-better')
                ? 'bg-emerald-500/8 text-emerald-600'
                : 'bg-red-500/8 text-red-600'
            )}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className={cn(delta < 0 && 'rotate-180')}>
              <path d="M5 2.5L7.5 5.5H2.5L5 2.5Z" fill="currentColor" />
            </svg>
            {Math.abs(delta)}%
          </span>
        )}
      </div>
    </div>
  );
}
