import { useEffect, useState } from 'react';

/**
 * Shared maximize/restore state for the manage surfaces (`ManageDialog` /
 * `ManageDrawer`). Resets to `defaultExpanded` every time the surface (re)opens
 * so a previously-maximized dialog doesn't reopen maximized unexpectedly.
 */
export function useExpandable(open: boolean, defaultExpanded = false) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  useEffect(() => {
    if (open) setExpanded(defaultExpanded);
  }, [defaultExpanded, open]);
  const toggle = () => setExpanded((value) => !value);
  return { expanded, setExpanded, toggle };
}
