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
 */
export function useApprovalNotifications(approvals: ExecutionApproval[] | undefined) {
  const seenApprovalsRef = useRef<Set<string>>(new Set());
  const hasShownNotificationRef = useRef(false);

  useEffect(() => {
    if (!approvals || approvals.length === 0) {
      return;
    }

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

      // Only show notification once per batch of new approvals
      if (!hasShownNotificationRef.current) {
        const message = newApprovals.length === 1
          ? `Approval required for: ${newApprovals[0].nodeId}`
          : `${newApprovals.length} approvals required`;

        toastWarning('⚠️ Action Required', message);
        hasShownNotificationRef.current = true;

        // Reset notification flag after timeout to allow repeated notifications
        setTimeout(() => {
          hasShownNotificationRef.current = false;
        }, 5000);
      }
    }
  }, [approvals]);
}
