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