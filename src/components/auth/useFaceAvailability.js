import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';

/**
 * Does this deployment actually do face sign-in?
 *
 * The button used to be rendered unconditionally, so on a backend without the
 * feature a student opened their camera, agreed to a biometric capture, and
 * only then got an error. Asking first means the option is simply not offered.
 *
 * Answered optimistically-then-corrected: the status call is cheap but not
 * instant, and flashing the button in and then out is worse than showing it a
 * beat late. So it starts hidden and appears only once the backend has said
 * yes — a feature that is missing stays missing, and one that works appears
 * within a few hundred milliseconds.
 */
export default function useFaceAvailability() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.auth.faceStatus();
        if (!cancelled) setAvailable(res?.available !== false);
      } catch {
        // 501, 404, or the API being unreachable. All of them mean the same
        // thing to a student standing in front of this screen.
        if (!cancelled) setAvailable(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return available;
}
