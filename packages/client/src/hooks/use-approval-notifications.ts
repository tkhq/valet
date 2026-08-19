import { useEffect, useRef } from 'react';
import type { ExecutionApproval } from '@/api/executions';
import { toastWarning } from './use-toast';

/**
 * FIX: Approval Gate Notifications
 * 
 * Hook that watches for new pending approvals and shows a notification
 * when an approval gate is triggered. This ensures users are notified
 * even if they're not actively looking at the execution view.
 * 
 * Tracks previously seen approval IDs to avoid duplicate notifications
 * when the same approval is polled multiple times.
 * 
 * KNOWN LIMITATION: The seenApprovalsRef is scoped to this hook instance,
 * so if the component remounts (e.g., due to navigation), the seen set
 * resets and notifications may be shown again for the same approval IDs.
 * This is acceptable for the current use case (approval notifications are
 * short-lived, and re-showing after navigation is reasonable). If this
 * becomes problematic, consider persisting seen IDs via localStorage or
 * a context provider shared across navigation.
 */
export function useApprovalNotifications(approvals: ExecutionApproval[] | undefined) {
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  const hasShownNotificationRef = useRef(false);
  const timeoutIdRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Early returns: avoid computing pending list if not needed
    if (!approvals || approvals.length === 0) {
      return;
    }

    // Find new approvals by filtering the full list for 'pending' status
    // and checking against previously seen IDs
    const pending = approvals.filter((a) => a.status === 'pending');

    if (pending.length === 0) {
      return;
    }

    // Find new approvals we haven't seen before
    const newApprovals = pending.filter((a) => !seenApprovalsRef.current.has(a.id));

    if (newApprovals.length > 0) {
      // Track all seen approvals for future comparisons
      newApprovals.forEach((a) => {
        seenApprovalsRef.current.add(a.id);
      });

      // Clean up IDs that are no longer in the current pending list to prevent unbounded growth
      const currentIds = new Set(pending.map((a) => a.id));
      const idsToRemove: string[] = [];
      seenApprovalsRef.current.forEach((id) => {
        if (!currentIds.has(id)) {
          idsToRemove.push(id);
        }
      });
      idsToRemove.forEach((id) => {
        seenApprovalsRef.current.delete(id);
      });

      // Only show notification once per batch of new approvals
      if (!hasShownNotificationRef.current) {
        const message = newApprovals.length === 1
          ? `Approval required for: ${newApprovals[0].nodeId}`
          : `${newApprovals.length} approvals required`;

        toastWarning('⚠️ Action Required', message);
        hasShownNotificationRef.current = true;

        // Reset notification flag after timeout to allow repeated notifications
        // Clear any existing timeout before setting a new one
        if (timeoutIdRef.current !== null) {
          clearTimeout(timeoutIdRef.current);
        }
        timeoutIdRef.current = setTimeout(() => {
          hasShownNotificationRef.current = false;
          timeoutIdRef.current = null;
        }, 5000);
      }
    }

    // Cleanup: clear timeout on unmount
    return () => {
      if (timeoutIdRef.current !== null) {
        clearTimeout(timeoutIdRef.current);
        timeoutIdRef.current = null;
      }
    };
  }, [approvals]);
}
