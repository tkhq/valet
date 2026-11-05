/**
 * The in-app tour (docs/specs/2026-11-03-feature-tour-design.md). It starts
 * by itself on Home when the server says it is due (`GET /api/tutorial`):
 * the person has not finished or skipped it, or an operator or org admin
 * raised the tour version since. Each step saves the resume point; Done and
 * Skip save the outcome with the versions the person saw. Anyone can replay
 * it from the account menu (`useFeatureTour().start`).
 *
 * A wider screen anchors a popover on each step's `data-tour` element and
 * skips a step whose element is not on the page. A phone shows full-screen
 * cards, since the sidebar is in the closed drawer.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { TutorialStateResponse } from "@valet/api/wire";
import { pluginEnabledForCaller, useOrg } from "~/api/settings";
import { useSaveTutorial, useTutorialState } from "~/api/tutorial";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle, Popover, PopoverAnchor, PopoverContent } from "~/components/primitives";
import { useMobileLayout } from "~/hooks/use-mobile-layout";
import { findTourTarget, nextAvailableIndex, resumeIndex, TOUR_REPLAY_HINT, TOUR_STEPS, type TourStep } from "./tour-steps";

/** How long a step waits for its element to render before it is skipped. */
const TARGET_WAIT_MS = 1500;
const TARGET_POLL_MS = 100;

interface FeatureTourControls {
  /** Open Home and show the tour from the first step. */
  start: () => void;
}

const FeatureTourContext = createContext<FeatureTourControls | null>(null);

/** The tour's controls, or null outside `FeatureTourProvider`. */
export function useFeatureTour(): FeatureTourControls | null {
  return useContext(FeatureTourContext);
}

/** Holds the tour for the signed-in shell and renders the current step. */
export function FeatureTourProvider({ children, enabled = true }: { children: ReactNode; enabled?: boolean }) {
  const stateQ = useTutorialState(enabled);
  const save = useSaveTutorial();
  const orgQ = useOrg();
  const mobile = useMobileLayout();
  const navigate = useNavigate();
  const onHome = useRouterState({ select: (state) => state.location.pathname === "/" });
  const [index, setIndex] = useState<number | null>(null);
  // One automatic start per page load: a dismissal must hold even while the
  // saved outcome is still in flight.
  const autoStarted = useRef(false);
  const pendingReplay = useRef(false);

  const pluginOn = useCallback((step: TourStep) => !step.plugin || pluginEnabledForCaller(orgQ.data, step.plugin) !== false, [orgQ.data]);

  const open = useCallback((from: number) => {
    const first = nextAvailableIndex(TOUR_STEPS, from, pluginOn);
    if (first >= 0) setIndex(first);
  }, [pluginOn]);

  useEffect(() => {
    const state = stateQ.data;
    if (!state?.due || autoStarted.current || !onHome || orgQ.data === undefined) return;
    autoStarted.current = true;
    open(resumeIndex(TOUR_STEPS, state.step));
  }, [stateQ.data, onHome, orgQ.data, open]);

  // A replay from another page opens once Home is showing.
  useEffect(() => {
    if (!pendingReplay.current || !onHome || orgQ.data === undefined) return;
    pendingReplay.current = false;
    autoStarted.current = true;
    open(0);
  }, [onHome, orgQ.data, open]);

  const start = useCallback(() => {
    if (onHome && orgQ.data !== undefined) {
      autoStarted.current = true;
      open(0);
      return;
    }
    pendingReplay.current = true;
    void navigate({ to: "/" });
  }, [onHome, orgQ.data, open, navigate]);

  const step = index === null ? undefined : TOUR_STEPS[index];
  useEffect(() => {
    const state = stateQ.data;
    if (step && state) save.mutate({ step: step.id, version: state.version, orgVersion: state.orgVersion });
    // Save once per step shown; the mutation object changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step?.id]);

  const finish = useCallback((outcome: "completed" | "skipped") => {
    setIndex(null);
    const state: TutorialStateResponse | undefined = stateQ.data;
    if (state) save.mutate({ outcome, version: state.version, orgVersion: state.orgVersion });
  }, [save, stateQ.data]);

  const move = useCallback((direction: 1 | -1, available: (step: TourStep) => boolean) => {
    if (index === null) return;
    const next = nextAvailableIndex(TOUR_STEPS, index + direction, available, direction);
    if (next >= 0) setIndex(next);
    else if (direction === 1) finish("completed");
  }, [index, finish]);

  const controls = useMemo(() => ({ start }), [start]);
  return <FeatureTourContext.Provider value={controls}>
    {children}
    {step && index !== null && (mobile
      ? <PhoneTourCard key={step.id} step={step} index={index} available={pluginOn}
        onBack={() => move(-1, pluginOn)} onNext={() => move(1, pluginOn)} onSkip={() => finish("skipped")} />
      : <DesktopTourStep key={step.id} step={step} index={index} pluginOn={pluginOn}
        onBack={(available) => move(-1, available)} onNext={(available) => move(1, available)} onSkip={() => finish("skipped")} />)}
  </FeatureTourContext.Provider>;
}

/** Pure: "2 of 6" over the steps that can show. */
function progressLabel(index: number, available: (step: TourStep) => boolean): string {
  const shown = TOUR_STEPS.filter(available);
  const position = shown.indexOf(TOUR_STEPS[index]!) + 1;
  return `${Math.max(position, 1)} of ${shown.length}`;
}

function isLast(index: number, available: (step: TourStep) => boolean): boolean {
  return nextAvailableIndex(TOUR_STEPS, index + 1, available) < 0;
}

function isFirst(index: number, available: (step: TourStep) => boolean): boolean {
  return nextAvailableIndex(TOUR_STEPS, index - 1, available, -1) < 0;
}

function StepButtons({ index, available, onBack, onNext, onSkip }: {
  index: number; available: (step: TourStep) => boolean; onBack: () => void; onNext: () => void; onSkip: () => void;
}) {
  const last = isLast(index, available);
  return <div className="flex items-center gap-2">
    {!last && <Button variant="ghost" size="sm" onClick={onSkip}>Skip tour</Button>}
    <span className="flex-1" />
    {!isFirst(index, available) && <Button variant="secondary" size="sm" onClick={onBack}>Back</Button>}
    <Button size="sm" onClick={onNext}>{last ? "Done" : "Next"}</Button>
  </div>;
}

/**
 * One desktop step: a popover anchored on the step's element, or a centered
 * card for a step with no target. A missing element gets a short wait for a
 * slow render, then the step is skipped forward.
 */
function DesktopTourStep({ step, index, pluginOn, onBack, onNext, onSkip }: {
  step: TourStep; index: number; pluginOn: (step: TourStep) => boolean;
  onBack: (available: (step: TourStep) => boolean) => void;
  onNext: (available: (step: TourStep) => boolean) => void;
  onSkip: () => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(() => step.target ? findTourTarget(step.target) : null);
  useEffect(() => {
    if (!step.target || anchor) return;
    const target = step.target;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const found = findTourTarget(target);
      if (found) {
        window.clearInterval(timer);
        setAnchor(found);
      } else if (Date.now() - started >= TARGET_WAIT_MS) {
        window.clearInterval(timer);
        onNext((candidate) => candidate.id !== step.id && available(candidate));
      }
    }, TARGET_POLL_MS);
    return () => window.clearInterval(timer);
    // The step is keyed by id: this runs once per step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Keep the element in view and mark it while its step shows.
  useEffect(() => {
    if (!anchor) return;
    anchor.scrollIntoView?.({ block: "nearest" });
    anchor.setAttribute("data-tour-active", "");
    return () => anchor.removeAttribute("data-tour-active");
  }, [anchor]);

  // A step is available when its plugin is on and its element is on the page.
  const available = (candidate: TourStep) => pluginOn(candidate)
    && (!candidate.target || candidate.id === step.id || findTourTarget(candidate.target) !== null);
  const body = <StepBody step={step} index={index} available={available} copy={step.body} showIcon={!step.target}
    onBack={() => onBack(available)} onNext={() => onNext(available)} onSkip={onSkip} />;

  if (!step.target) {
    return <Dialog open onOpenChange={(next) => { if (!next) onSkip(); }}>
      <DialogContent hideClose aria-describedby={undefined} className="max-w-sm">{body}</DialogContent>
    </Dialog>;
  }
  if (!anchor) return null;
  return <Popover open onOpenChange={(next) => { if (!next) onSkip(); }}>
    <PopoverAnchor virtualRef={{ current: anchor }} />
    <PopoverContent side={step.side ?? "right"} align="start" sideOffset={10} role="dialog" aria-label={`Tour: ${step.title}`}
      // The tour stays open while the person clicks around; Escape or Skip closes it.
      onInteractOutside={(event) => event.preventDefault()}
      className="w-80">
      {body}
    </PopoverContent>
  </Popover>;
}

function StepBody({ step, index, available, copy, onBack, onNext, onSkip, titleAs = "h2", showIcon = false }: {
  step: TourStep; index: number; available: (step: TourStep) => boolean; copy: string;
  onBack: () => void; onNext: () => void; onSkip: () => void; titleAs?: "h2" | "dialog"; showIcon?: boolean;
}) {
  const last = isLast(index, available);
  return <div className="grid gap-3">
    {showIcon && <span aria-hidden className="mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-moss-wash-strong text-moss">
      <step.icon className="h-6 w-6" />
    </span>}
    <p className="text-xs text-muted">{progressLabel(index, available)}</p>
    {titleAs === "dialog"
      ? <DialogTitle className="text-base font-semibold tracking-tight text-ink">{step.title}</DialogTitle>
      : <h2 className="text-sm font-semibold text-ink">{step.title}</h2>}
    {titleAs === "dialog"
      ? <DialogDescription className="text-sm text-muted">{copy}</DialogDescription>
      : <p className="text-sm text-muted">{copy}</p>}
    {last && <p className="text-xs text-muted">{TOUR_REPLAY_HINT}</p>}
    <StepButtons index={index} available={available} onBack={onBack} onNext={onNext} onSkip={onSkip} />
  </div>;
}

/** One phone step: a full-screen card over the drawer and tabs layout. */
function PhoneTourCard({ step, index, available, onBack, onNext, onSkip }: {
  step: TourStep; index: number; available: (step: TourStep) => boolean;
  onBack: () => void; onNext: () => void; onSkip: () => void;
}) {
  return <Dialog open onOpenChange={(next) => { if (!next) onSkip(); }}>
    <DialogContent hideClose aria-describedby={undefined}
      className="left-0 top-0 h-dvh w-full max-w-none translate-x-0 translate-y-0 content-center rounded-none border-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto w-full max-w-sm">
        <StepBody step={step} index={index} available={available} copy={step.phone ?? step.body} titleAs="dialog" showIcon
          onBack={onBack} onNext={onNext} onSkip={onSkip} />
      </div>
    </DialogContent>
  </Dialog>;
}
