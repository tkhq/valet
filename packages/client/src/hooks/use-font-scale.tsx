import * as React from 'react';
import { useUIStore } from '@/stores/ui';
import { useAuthStore } from '@/stores/auth';

const MIN_SCALE = 0.8;
const MAX_SCALE = 1.5;

export function useFontScale() {
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);

  React.useEffect(() => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fontScale));
    document.documentElement.style.fontSize = `${clamped * 100}%`;
  }, [fontScale]);

  return { fontScale, setFontScale, MIN_SCALE, MAX_SCALE };
}

/**
 * Mounted at the app root. Does two things:
 * 1. Applies the stored fontScale to document.documentElement on every change.
 * 2. Reconciles the server-side fontScale (from the auth store user object) into
 *    the local UI store so the server value wins after login / across devices.
 */
export function FontScaleProvider({ children }: { children: React.ReactNode }) {
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);
  const isHydrated = useAuthStore((s) => s.isHydrated);
  const userFontScale = useAuthStore((s) => s.user?.fontScale);

  // Apply to DOM whenever local scale changes (instant - no server round-trip needed)
  React.useEffect(() => {
    const clamped = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fontScale));
    document.documentElement.style.fontSize = `${clamped * 100}%`;
  }, [fontScale]);

  // Server wins: when the auth store user has a fontScale (after login or /me refresh),
  // push it into the UI store so both are in sync.
  React.useEffect(() => {
    if (isHydrated && userFontScale != null) {
      setFontScale(userFontScale);
    }
  }, [isHydrated, userFontScale, setFontScale]);

  return <>{children}</>;
}
