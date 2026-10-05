// 브라우저의 설치 신호(beforeinstallprompt)를 앱이 그려지기 전부터 받아 둔다.
// 설치 여부와 설치 창 신호만 다루며 문서·저장소와는 관계가 없다.

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallSnapshot {
  installed: boolean;
  canPrompt: boolean;
}

let deferred: InstallPromptEvent | null = null;
let snapshot: InstallSnapshot = { installed: false, canPrompt: false };
const listeners = new Set<() => void>();

function standalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function update(next: Partial<InstallSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

export function startInstallWatcher(): void {
  snapshot = { installed: standalone(), canPrompt: false };
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    update({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    update({ installed: true, canPrompt: false });
  });
}

export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function installSnapshot(): InstallSnapshot {
  return snapshot;
}

/** 브라우저 설치 창을 띄운다. 띄울 수 없으면 false를 돌려준다. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  update({ canPrompt: false });
  await event.prompt();
  try { await event.userChoice; } catch { /* 사용자가 창을 닫아도 앱은 그대로 동작 */ }
  return true;
}
