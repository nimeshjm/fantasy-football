/**
 * Tests for src/alert.ts -- the only outbound notification channel.
 *
 * Two properties matter more than the happy path: it never throws (a failed
 * alert must not be able to cost a gameweek), and it never puts secret
 * material on the wire.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sendWebhookAlert } from '../src/alert';
import type { SessionAlertPayload } from '../src/sessionHealth';

const URL_OK = 'https://hooks.example.com/abc';

function payload(overrides: Partial<SessionAlertPayload> = {}): SessionAlertPayload {
  return {
    streak: 3,
    threshold: 3,
    reason: 'unauthenticated',
    firstFailureAt: '2026-09-10T14:00:00.000Z',
    lastFailureAt: '2026-09-10T16:00:00.000Z',
    lastOkAt: '2026-09-10T13:00:00.000Z',
    firstOkAt: '2026-09-01T13:00:00.000Z',
    cookieFingerprint: 'aaaaaaaaaaaa',
    worker: 'fantasy-football-agent',
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sendWebhookAlert', () => {
  it('does not fetch at all when ALERT_WEBHOOK_URL is unset', async () => {
    // The supported "alerting is off" state -- CI and local dev must post
    // nowhere without needing a stub.
    const delivery = await sendWebhookAlert({}, payload());

    expect(delivery.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs the payload as JSON and reports delivery', async () => {
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const delivery = await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    expect(delivery).toEqual({ delivered: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.streak).toBe(3);
    expect(typeof body.text).toBe('string');
  });

  it('sends the summary under both text and content, so one URL suits Slack or Discord', async () => {
    // Discord requires one of content/embeds/file and rejects a body with
    // none of them as `400 Cannot send an empty message`; Slack renders
    // `text`. Sending both is what avoids a per-service adapter.
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.content).toBe(body.text);
    expect(body.content).toContain('fantasy session dead');
  });

  it('names the secret to re-paste in the summary itself', async () => {
    // The alert fires at most once per incident, so this string may be the
    // only thing anyone ever reads about the outage -- it has to say what to
    // do without a trip to the dashboard.
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.text).toContain('FANTASY_SESSION_COOKIE');
  });

  it('reports a non-2xx response as undelivered rather than throwing', async () => {
    // Undelivered must be a value, not an exception: the caller latches
    // `session_alert_open` only on real delivery.
    fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));

    const delivery = await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    expect(delivery.delivered).toBe(false);
    expect(delivery.detail).toContain('500');
  });

  it('reports a thrown fetch as undelivered rather than throwing', async () => {
    fetchMock.mockRejectedValueOnce(new Error('connection refused'));

    const delivery = await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    expect(delivery).toEqual({ delivered: false, detail: 'connection refused' });
  });

  it('refuses a non-https URL instead of sending the payload in plaintext', async () => {
    const delivery = await sendWebhookAlert(
      { ALERT_WEBHOOK_URL: 'http://hooks.example.com/abc' },
      payload(),
    );

    expect(delivery.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a malformed URL', async () => {
    const delivery = await sendWebhookAlert({ ALERT_WEBHOOK_URL: 'not a url' }, payload());

    expect(delivery.delivered).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('puts no cookie or token on the wire', async () => {
    // The regression guard that matters most. The payload carries a
    // truncated fingerprint precisely so the cookie never has to travel.
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await sendWebhookAlert({ ALERT_WEBHOOK_URL: URL_OK }, payload());

    const serialized = JSON.stringify(fetchMock.mock.calls[0]);
    expect(serialized).not.toContain('sessionid');
    expect(serialized).not.toContain('DASHBOARD_TOKEN');
    expect(serialized).not.toContain('FANTASY_PASSWORD');
  });
});
