// PostHog browser client wrapper. Lazy-loads posthog-js only after the
// daemon /api/analytics/config response confirms a key is present, so dev
// builds and forks impose zero runtime cost. All entry points are
// fire-and-forget: capture failures must never propagate to product code.

import type { PostHog } from 'posthog-js';
import {
  EVENT_SCHEMA_VERSION,
  type AnalyticsClientType,
  type AnalyticsConfigResponse,
} from '@open-design/contracts/analytics';

interface AnalyticsContext {
  anonymousId: string;
  sessionId: string;
  clientType: AnalyticsClientType;
  locale: string;
  appVersion: string;
}

let client: PostHog | null = null;
let initPromise: Promise<PostHog | null> | null = null;

export async function getAnalyticsClient(
  context: AnalyticsContext,
): Promise<PostHog | null> {
  if (client) return client;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const res = await fetch('/api/analytics/config');
      if (!res.ok) return null;
      const cfg = (await res.json()) as AnalyticsConfigResponse;
      if (!cfg.enabled || !cfg.key || !cfg.host) return null;
      const mod = await import('posthog-js');
      const posthog = mod.default;
      posthog.init(cfg.key, {
        api_host: cfg.host,
        // Identify by our own anonymous_id so daemon-side captures (which
        // use the same id as distinctId) land on the same person record.
        bootstrap: { distinctID: context.anonymousId },
        // Disable session recording and autocapture; this integration is
        // event-based only. A future spec can opt in selectively.
        disable_session_recording: true,
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        persistence: 'localStorage',
        loaded: (instance) => {
          instance.register({
            event_schema_version: EVENT_SCHEMA_VERSION,
            ui_version: context.appVersion,
            app_version: context.appVersion,
            client_type: context.clientType,
            locale: context.locale,
            session_id: context.sessionId,
            anonymous_id: context.anonymousId,
          });
        },
      });
      client = posthog;
      return posthog;
    } catch {
      // Network failure, missing endpoint, third-party fork without keys —
      // all collapse to the same no-op.
      return null;
    }
  })();
  return initPromise;
}

export function capture(
  client: PostHog | null,
  args: {
    event: string;
    properties: Record<string, unknown>;
    insertId: string;
    requestId?: string | null;
  },
): void {
  if (!client) return;
  try {
    client.capture(args.event, {
      ...args.properties,
      event_id: args.insertId,
      // PostHog's official dedup key. The daemon mirrors result events with
      // the same $insert_id so duplicates from the dual-side capture pattern
      // get coalesced server-side.
      $insert_id: args.insertId,
      ...(args.requestId ? { request_id: args.requestId } : {}),
    });
  } catch {
    // Swallow — analytics failures must not propagate.
  }
}
