'use client';

import type { AgentStateDTO, FeedEvent, RealtimeMessage } from '@workforce/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { api } from './api';

type Conn = 'connecting' | 'live' | 'offline';

type LiveState = {
  conn: Conn;
  lastSeq: number;
  feed: FeedEvent[];
  freshIds: Set<string>;
  agents: Record<string, AgentStateDTO>;
  setConn: (c: Conn) => void;
  seed: (feed: FeedEvent[], agents: AgentStateDTO[]) => void;
  apply: (msgs: RealtimeMessage[], fresh?: boolean) => { prsChanged: boolean };
};

const FEED_MAX = 120;

/**
 * Live data lives in one small store. Socket deltas patch it directly, so the page never refetches
 * the feed or the roster; lists that are computed server-side (queues, KPIs) are invalidated instead.
 */
export const useLive = create<LiveState>((set, get) => ({
  conn: 'connecting',
  lastSeq: 0,
  feed: [],
  freshIds: new Set(),
  agents: {},
  setConn: (conn) => set({ conn }),
  seed: (feed, agents) =>
    set({ feed, agents: Object.fromEntries(agents.map((a) => [a.employeeId, a])), freshIds: new Set() }),
  apply: (msgs, markFresh = true) => {
    let { feed, agents, lastSeq } = get();
    const fresh = new Set<string>();
    let prsChanged = false;
    for (const m of [...msgs].sort((a, b) => a.seq - b.seq)) {
      if (m.seq <= lastSeq) continue; // already applied (replay overlap)
      lastSeq = m.seq;
      if (m.type === 'event') {
        if (!feed.some((f) => f.id === m.event.id)) {
          feed = [m.event, ...feed];
          if (markFresh) fresh.add(m.event.id);
        }
      } else if (m.type === 'agent') {
        agents = { ...agents, [m.agent.employeeId]: m.agent };
      } else if (m.type === 'pr') {
        prsChanged = true;
      }
    }
    feed = feed
      .slice()
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
      .slice(0, FEED_MAX);
    set({ feed, agents, lastSeq, freshIds: fresh });
    return { prsChanged };
  },
}));

const RT_URL = process.env.NEXT_PUBLIC_RT_URL ?? 'http://localhost:4000';

/** Buffer socket traffic until a consistent snapshot is installed; replay never celebrates. */
export function useLiveConnection(enabled = true) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    let stopped = false,
      recovering = true,
      busy = false;
    let buffered: RealtimeMessage[] = [];
    let retry: ReturnType<typeof setTimeout> | undefined;
    const socket = io(RT_URL, {
      path: '/rt',
      transports: ['websocket'],
      withCredentials: true,
      autoConnect: false,
      auth: (cb) => cb({ lastSeq: useLive.getState().lastSeq }),
    });
    const refresh = async () => {
      if (busy || stopped) return;
      busy = true;
      recovering = true;
      useLive.getState().setConn('connecting');
      try {
        const snapshot = await api.get<{ feed: FeedEvent[]; agents: AgentStateDTO[]; cursor: number }>(
          '/office/snapshot',
        );
        if (stopped) return;
        useLive.getState().seed(snapshot.feed, snapshot.agents);
        useLive.setState({ lastSeq: snapshot.cursor });
        useLive.getState().apply(buffered, false);
        buffered = [];
        recovering = false;
        if (!socket.connected) socket.connect();
        else useLive.getState().setConn('live');
        void qc.invalidateQueries({ queryKey: ['office-layout'] });
      } catch {
        if (!stopped) {
          useLive.getState().setConn('offline');
          retry = setTimeout(() => void refresh(), 5000);
        }
      } finally {
        busy = false;
      }
    };
    socket.on('connect', () => {
      recovering = true;
      useLive.getState().setConn('connecting');
    });
    socket.on('disconnect', () => {
      recovering = true;
      useLive.getState().setConn('offline');
    });
    socket.on('connect_error', () => useLive.getState().setConn('offline'));
    socket.on('unauthorized', () => {
      if (!stopped) location.href = '/login';
    });
    socket.on('replay', (messages: RealtimeMessage[]) => buffered.push(...messages));
    socket.on('deltas', (messages: RealtimeMessage[]) => {
      if (recovering) buffered.push(...messages);
      else {
        useLive.getState().apply(messages);
        void qc.invalidateQueries({ queryKey: ['office-layout'] });
      }
    });
    socket.on('ready', () => void refresh());
    socket.on('resync', () => void refresh());
    void refresh();
    return () => {
      stopped = true;
      socket.disconnect();
      if (retry) clearTimeout(retry);
      useLive.getState().seed([], []);
      useLive.setState({ lastSeq: 0, conn: 'connecting' });
    };
  }, [enabled, qc]);
}
