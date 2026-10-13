// Data hooks for the GPU view (view-local data: offers, history, server log, account). Owner: ui-views.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcResult } from '@shared/protocol';
import type { GpuOffer, GpuSessionRecord } from '@shared/types';
import { errorMessage, rpc } from '@renderer/lib/rpc';
import { useConnection } from '@renderer/state/connection';
import { useGpu } from '@renderer/state/gpu';

export function useIsConnected(): boolean {
  return useConnection((s) => s.state.status === 'open');
}

// ───────────────────────────── Offers ─────────────────────────────

export interface OfferState {
  state: 'idle' | 'loading' | 'ok' | 'error';
  offers: GpuOffer[];
  error?: string;
  at?: number;
}

const EMPTY_OFFERS: OfferState = { state: 'idle', offers: [] };
const OFFERS_REFRESH_MS = 3 * 60_000;

/** Live offers per profile (cheapest first), refreshed every 3 minutes while mounted. Works without an API key. */
export function useOffers(profileIds: string[], enabled: boolean) {
  const key = profileIds.join('|');
  const [byProfile, setByProfile] = useState<Record<string, OfferState>>({});
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async (id: string) => {
    setByProfile((s) => ({ ...s, [id]: { ...(s[id] ?? EMPTY_OFFERS), state: 'loading', error: undefined } }));
    try {
      const offers = await rpc.request('gpu.offers', { profileId: id, limit: 30 });
      if (!alive.current) return;
      setByProfile((s) => ({ ...s, [id]: { state: 'ok', offers, at: Date.now() } }));
    } catch (err) {
      if (!alive.current) return;
      setByProfile((s) => ({ ...s, [id]: { state: 'error', offers: s[id]?.offers ?? [], error: errorMessage(err), at: s[id]?.at } }));
    }
  }, []);

  const refreshAll = useCallback(() => {
    for (const id of key.split('|').filter(Boolean)) void load(id);
  }, [key, load]);

  useEffect(() => {
    if (!enabled || !key) return;
    refreshAll();
    const t = setInterval(refreshAll, OFFERS_REFRESH_MS);
    return () => clearInterval(t);
  }, [enabled, key, refreshAll]);

  return { byProfile, refresh: load, refreshAll };
}

// ───────────────────────────── History ─────────────────────────────

/** Past clock-in sessions; refetched whenever the GPU goes back to 'off'. */
export function useHistory(limit: number, enabled: boolean) {
  const idle = useGpu((s) => s.status?.phase === 'off' || s.status?.phase === 'error');
  const [records, setRecords] = useState<GpuSessionRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRecords(await rpc.request('gpu.history', { limit }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [limit]);

  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [enabled, load, idle]);

  return { records, error, reload: load };
}

// ───────────────────────────── Account (credit balance) ─────────────────────────────

export type AccountCheck = RpcResult<'gpu.testKey'>;

/** Runs gpu.testKey when the view opens (and on demand) to show the credit balance. */
export function useAccountCheck(hasApiKey: boolean | null, enabled: boolean) {
  const [result, setResult] = useState<AccountCheck | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      setResult(await rpc.request('gpu.testKey', {}));
    } catch (err) {
      setResult({ ok: false, message: errorMessage(err) });
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (enabled && hasApiKey) void check();
    if (hasApiKey === false) setResult(null);
  }, [enabled, hasApiKey, check]);

  return { result, checking, check };
}

// ───────────────────────────── Server log ─────────────────────────────

/** `reloadKey`: bump it to load again (e.g. "View server log" while the viewer is already open). */
export function useServerLog(enabled: boolean, autoRefreshMs: number | null, reloadKey = 0) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await rpc.request('gpu.serverLog', { lines: 300 });
      setText(r.text);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void load();
    if (!autoRefreshMs) return;
    const t = setInterval(() => void load(), autoRefreshMs);
    return () => clearInterval(t);
  }, [enabled, autoRefreshMs, load, reloadKey]);

  return { text, loading, error, reload: load };
}
