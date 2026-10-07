import type {FastifyBaseLogger} from 'fastify';

/** 同じキーの通知をまとめる間隔 */
const THROTTLE_MS = 5 * 60_000;
const SEND_TIMEOUT_MS = 5_000;

export interface NotifyEvent {
  /** まとめる単位（エラーコードなど） */
  key: string;
  title: string;
  fields: Record<string, string | number | null | undefined>;
}

export interface Notifier {
  notify(event: NotifyEvent): void;
}

type Fetch = typeof fetch;

/**
 * Slack 通知。Webhook 未設定なら何もしない（ログには常に出ている前提）。
 * 通知の失敗はログに出すだけで、呼び出し元の処理には影響させない。再帰的に通知しない。
 */
export function createNotifier(options: {
  webhookUrl: string;
  appVersion: string;
  logger: FastifyBaseLogger;
  fetchImpl?: Fetch;
  now?: () => number;
}): Notifier {
  const {webhookUrl, appVersion, logger} = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const lastSent = new Map<string, number>();
  const suppressed = new Map<string, number>();

  async function send(text: string): Promise<void> {
    const res = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text}),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
  }

  return {
    notify(event) {
      if (!webhookUrl) return;
      const t = now();
      const last = lastSent.get(event.key);
      if (last !== undefined && t - last < THROTTLE_MS) {
        suppressed.set(event.key, (suppressed.get(event.key) ?? 0) + 1);
        return;
      }
      const skipped = suppressed.get(event.key) ?? 0;
      lastSent.set(event.key, t);
      suppressed.delete(event.key);

      const lines = [
        `:rotating_light: [gift-inspector ${appVersion}] ${event.title}`,
        ...Object.entries(event.fields)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `• ${k}: ${String(v)}`),
      ];
      if (skipped > 0) lines.push(`• 直近5分にまとめた同種の通知: ${skipped}件`);

      send(lines.join('\n')).catch((err: unknown) => {
        logger.error(
          {notifyKey: event.key, err: err instanceof Error ? err.message : String(err)},
          'Slack通知に失敗しました'
        );
      });
    },
  };
}

export const noopNotifier: Notifier = {notify() {}};
