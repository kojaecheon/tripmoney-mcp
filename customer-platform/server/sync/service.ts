import { IdentityError } from '../../core/contracts.js';
import type { IdentityService } from '../identity/contracts.js';
import type { LedgerService } from '../ledger/contracts.js';

export interface TripChangeNotifier {
  publish(tripId: string): void;
  wait(tripId: string, options: { signal?: AbortSignal; timeoutMs: number }): Promise<void>;
  close(): void;
}
export interface TripChangesService {
  wait(options: {
    tripId: string;
    afterRevision: number;
    readCurrent: () => Promise<{ accountId: string; revision: number }>;
    signal?: AbortSignal;
  }): Promise<{ tripId: string; revision: number }>;
  close(): void;
}
export interface TripChangesOptions { heartbeatMs?: number; probeMs?: number; requestTimeoutMs?: number }

const unavailable = () => new IdentityError('unavailable', '여행 변경 알림을 잠시 사용할 수 없습니다.');
const limited = () => new IdentityError('rate_limited', '변경 대기 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
const invalid = (field: string): never => { throw new IdentityError('validation', '입력 내용을 확인해 주세요.', field); };
const abortError = () => new DOMException('변경 대기가 취소되었습니다.', 'AbortError');
function normalizeId(value: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) return invalid('tripId');
  return value.toLowerCase();
}
function timing(value: number | undefined, maximum: number, field: string): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) return invalid(field);
  return value;
}

// Only pending signals are retained. There are no revision receipts or trip histories.
export function createTripChangeNotifier(): TripChangeNotifier {
  const listeners = new Map<string, Set<(error?: Error) => void>>();
  let closed = false, count = 0;
  return {
    publish(rawTripId) {
      if (closed) return;
      const tripId = normalizeId(rawTripId);
      for (const finish of [...(listeners.get(tripId) ?? [])]) finish();
    },
    async wait(rawTripId, { signal, timeoutMs }) {
      if (closed) throw unavailable();
      const tripId = normalizeId(rawTripId);
      timing(timeoutMs, 15_000, 'timeoutMs');
      if (signal?.aborted) throw abortError();
      if (count >= 64) throw limited();
      return new Promise<void>((resolve, reject) => {
        const entries = listeners.get(tripId) ?? new Set<(error?: Error) => void>();
        let timer: ReturnType<typeof setTimeout>;
        const onAbort = () => finish(abortError());
        const finish = (error?: Error) => {
          if (!entries.delete(finish)) return;
          count--;
          if (!entries.size) listeners.delete(tripId);
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          if (error) reject(error); else resolve();
        };
        entries.add(finish); listeners.set(tripId, entries); count++;
        timer = setTimeout(() => finish(), timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entries of [...listeners.values()]) for (const finish of [...entries]) finish(unavailable());
    },
  };
}

// The read is supplied by the authenticated HTTP boundary and must check the current
// session and membership every time. Cancellation cannot cancel its underlying I/O,
// so both outcomes stay handled even after the caller stops waiting.
function readWithAbort<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason); };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return read();
    }).then(value => {
      signal.removeEventListener('abort', onAbort); resolve(value);
    }, error => {
      signal.removeEventListener('abort', onAbort); reject(error);
    });
  });
}

export function createTripChangesService(notifier: TripChangeNotifier, options: TripChangesOptions = {}): TripChangesService {
  const heartbeatMs = timing(options.heartbeatMs, 15_000, 'heartbeatMs');
  const probeMs = timing(options.probeMs, 3_000, 'probeMs');
  const requestTimeoutMs = timing(options.requestTimeoutMs, 30_000, 'requestTimeoutMs');
  const accounts = new Map<string, number>();
  const controllers = new Set<AbortController>();
  let closed = false, count = 0;
  return {
    async wait({ tripId: rawTripId, afterRevision, readCurrent, signal }) {
      if (closed) throw unavailable();
      const tripId = normalizeId(rawTripId);
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) return invalid('afterRevision');
      if (typeof readCurrent !== 'function') return invalid('readCurrent');
      if (signal?.aborted) throw abortError();
      // Include initial authentication I/O in the global process capacity. The
      // account-specific quota below still follows successful authorization.
      if (controllers.size >= 64) throw limited();
      const controller = new AbortController();
      const onAbort = () => controller.abort(abortError());
      signal?.addEventListener('abort', onAbort, { once: true });
      controllers.add(controller);
      const requestTimer = setTimeout(() => controller.abort(unavailable()), requestTimeoutMs);
      let accountId: string | undefined, reserved = false;
      const read = async () => {
        const value = await readWithAbort(readCurrent, controller.signal);
        if (controller.signal.aborted) throw controller.signal.reason;
        if (!value || typeof value.accountId !== 'string' || !value.accountId || value.accountId.length > 128 || !Number.isSafeInteger(value.revision) || value.revision < 1) throw unavailable();
        if (accountId !== undefined && value.accountId !== accountId) throw new IdentityError('unauthenticated', '다시 로그인해 주세요.');
        if (afterRevision > value.revision) throw new IdentityError('conflict', '여행 정보를 다시 불러와 주세요.');
        return value;
      };
      try {
        const first = await read();
        accountId = first.accountId;
        if (first.revision > afterRevision) return { tripId, revision: first.revision };
        // Authorize before looking at the account-specific waiting quota.
        if (count >= 64 || (accounts.get(accountId) ?? 0) >= 2) throw limited();
        count++; accounts.set(accountId, (accounts.get(accountId) ?? 0) + 1); reserved = true;
        const deadline = performance.now() + heartbeatMs;
        for (;;) {
          const iteration = new AbortController();
          const cancelIteration = () => iteration.abort(controller.signal.reason);
          controller.signal.addEventListener('abort', cancelIteration, { once: true });
          if (controller.signal.aborted) cancelIteration();
          // Subscribe synchronously before the second read. Immediately handle rejection
          // because a read may still be running when this subscription is cancelled.
          const notified = notifier.wait(tripId, { signal: iteration.signal, timeoutMs: Math.max(1, Math.min(probeMs, Math.ceil(deadline - performance.now()))) })
            .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
          try {
            const current = await read();
            if (current.revision > afterRevision || performance.now() >= deadline) return { tripId, revision: current.revision };
            const result = await notified;
            if (!result.ok) throw result.error;
          } finally {
            controller.signal.removeEventListener('abort', cancelIteration);
            iteration.abort(abortError());
          }
        }
      } finally {
        clearTimeout(requestTimer);
        signal?.removeEventListener('abort', onAbort);
        controllers.delete(controller);
        if (reserved && accountId !== undefined) {
          count--;
          const remaining = (accounts.get(accountId) ?? 1) - 1;
          if (remaining) accounts.set(accountId, remaining); else accounts.delete(accountId);
        }
      }
    },
    close() {
      if (closed) return;
      closed = true;
      for (const controller of controllers) controller.abort(unavailable());
      notifier.close();
    },
  };
}

export function createNotifyingServices({ identityService: identity, ledgerService: ledger, notifier }: {
  identityService: IdentityService; ledgerService: LedgerService; notifier: TripChangeNotifier;
}): { identityService: IdentityService; ledgerService: LedgerService } {
  const identityService: IdentityService = {
    async createTrip(...args) { const result = await identity.createTrip(...args); if (!result.replayed) notifier.publish(result.value.trip.id); return result; },
    async acceptInvite(...args) { const result = await identity.acceptInvite(...args); if (!result.replayed) notifier.publish(result.value.trip.id); return result; },
    async updateTrip(...args) { const result = await identity.updateTrip(...args); if (!result.replayed) notifier.publish(args[1]); return result; },
    async manageMember(...args) { const result = await identity.manageMember(...args); if (!result.replayed) notifier.publish(args[1]); return result; },
    async issueInvite(...args) { const result = await identity.issueInvite(...args); if (!result.replayed) notifier.publish(args[1]); return result; },
    async revokeInvite(...args) { const result = await identity.revokeInvite(...args); if (!result.replayed) notifier.publish(args[1]); return result; },
    listTrips: (...args) => identity.listTrips(...args),
    getTrip: (...args) => identity.getTrip(...args),
    listMembers: (...args) => identity.listMembers(...args),
    listInvites: (...args) => identity.listInvites(...args),
    getInviteLink: (...args) => identity.getInviteLink(...args),
    inspectInvite: (...args) => identity.inspectInvite(...args),
  };
  const ledgerService: LedgerService = {
    get: (...args) => ledger.get(...args),
    async execute(...args) { const result = await ledger.execute(...args); if (!result.replayed) notifier.publish(args[1]); return result; },
  };
  return { identityService, ledgerService };
}
