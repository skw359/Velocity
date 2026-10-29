import { useState, useEffect } from 'react';

// Mounts a modal when `show` turns on and fades it in on the next frame; on close it
// fades out, then unmounts once the 250ms CSS transition has finished.
export function useModalTransition(show) {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  // Adjusted during render rather than in the effect so the modal mounts in the same pass.
  if (show && !mounted) setMounted(true);
  if (!show && visible) setVisible(false);

  useEffect(() => {
    if (show) {
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      const t = setTimeout(() => setMounted(false), 250);
      return () => clearTimeout(t);
    }
  }, [show]);

  return { mounted, visible };
}
