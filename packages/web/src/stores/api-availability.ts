import { create } from "zustand";

/**
 * Whether the api answered the last request. `api/client.ts` writes it, the
 * reconnecting banner reads it.
 *
 * The api runs as one pod with a Recreate rollout, so every deploy has a
 * window where the ingress answers 502/503/504 itself. The client marks the
 * api unavailable on those gateway answers and on network failures, and
 * available again on any answer from the api, success or not.
 */
interface ApiAvailabilityState {
  /** Epoch ms of the first failed request in the current outage, or null. */
  unavailableSince: number | null;
  markUnavailable: () => void;
  markAvailable: () => void;
}

export const useApiAvailability = create<ApiAvailabilityState>((set, get) => ({
  unavailableSince: null,
  markUnavailable: () => {
    if (get().unavailableSince === null) set({ unavailableSince: Date.now() });
  },
  markAvailable: () => {
    if (get().unavailableSince !== null) set({ unavailableSince: null });
  },
}));
