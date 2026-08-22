const NOTIFICATION_KEY = 'smartrecap.completionNotifications';
const supported = () => typeof window !== 'undefined' && 'Notification' in window;

function remember(value) {
  try {
    localStorage.setItem(NOTIFICATION_KEY, String(value));
  } catch {
    /* storage unavailable */
  }
}

function enabled() {
  try {
    return localStorage.getItem(NOTIFICATION_KEY) === 'true';
  } catch {
    return false;
  }
}

export async function enableCompletionNotifications() {
  if (!supported()) return false;
  if (Notification.permission === 'granted') {
    remember(true);
    return true;
  }
  if (Notification.permission !== 'default') return false;
  const permission = await Notification.requestPermission();
  if (permission === 'granted') remember(true);
  return permission === 'granted';
}

export function sendCompletionNotification(title, body, onClickPath) {
  if (!supported() || Notification.permission !== 'granted' || !enabled()) return;
  if (document.visibilityState === 'visible') return;
  const notification = new Notification(title, { body, tag: `smartrecap-${onClickPath}` });
  notification.onclick = () => {
    window.focus();
    window.location.assign(onClickPath);
    notification.close();
  };
}
/* ----------------------------------------------------------- session alerts */

const SESSION_ASK_KEY = 'smartrecap.sessionAlertAsked';

/**
 * Session-end alerts are a separate concern from "your recap is ready".
 *
 * They deliberately do not consult the completion opt-in above: a person who
 * turned off finished-job notifications has not asked to be signed out
 * silently. All that matters here is whether the browser will let us speak.
 */
export function sessionAlertState() {
  if (!supported()) return 'unsupported';
  return Notification.permission; // 'granted' | 'denied' | 'default'
}

export function sessionAlertAsked() {
  try {
    return localStorage.getItem(SESSION_ASK_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Ask for permission. Must be called from a user gesture — Safari refuses
 * otherwise, and Chrome discards prompts that arrive without one.
 *
 * The answer is remembered so a person who dismisses the browser prompt is not
 * asked again on every sign-in.
 */
export async function requestSessionAlerts() {
  if (!supported()) return 'unsupported';
  try {
    localStorage.setItem(SESSION_ASK_KEY, 'true');
  } catch {
    /* storage unavailable — we may ask once more next time, which is survivable */
  }
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}
