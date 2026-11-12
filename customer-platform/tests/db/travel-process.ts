import { createPools } from '../../server/db/pools.js';
import { readDbTestConfig } from '../../server/db/config.js';
import { gatedDurableTestPool, guardDurableTestClient, loadDurableTestManifest } from '../../server/db/durable-test-recovery.js';
import { createPgTravelRepositories } from '../../server/db/travel-repositories.js';
import { input, operation } from './travel-fixtures.js';
import type { Actor } from '../../core/contracts.js';

// IPC loss means the test controller has terminated. No orphan may start another transaction.
process.on('disconnect', () => process.exit(1));
if (!process.connected) throw new Error('durable_restart_ipc_required');
process.once('message', async (message: unknown) => {
  let pools: Awaited<ReturnType<typeof createPools>> | undefined;
  let repository: ReturnType<typeof createPgTravelRepositories> | undefined;
  let releaseLifetime: (() => Promise<void>) | undefined;
  try {
    const config = readDbTestConfig(process.env), manifest = loadDurableTestManifest(undefined, config.targetId);
    const request = message as { mode?: string; actor?: Actor; tripId?: string };
    const actor = manifest.actors.find(a => a.userId === request.actor?.userId && a.sessionHash === request.actor?.sessionHash);
    if (!actor || (request.mode !== 'write' && request.mode !== 'read')) throw Error();
    pools = await createPools({ appUrl: config.appUrl, authUrl: config.authUrl });
    // Hold a lifetime shared gate across gaps between transactions. Parent recovery cannot finish
    // while an IPC-bound subprocess could still start its next product transaction.
    const lifetime = guardDurableTestClient(await pools.app.connect());
    releaseLifetime = async () => {
      let discard = false;
      try { await lifetime.query('select pg_advisory_unlock_shared($1::bigint)', [manifest.gate]); }
      catch { discard = true; } finally { lifetime.release(discard); }
    };
    await lifetime.query('select pg_advisory_lock_shared($1::bigint)', [manifest.gate]);
    repository = createPgTravelRepositories({ pool: gatedDurableTestPool(pools.app, manifest) });
    let tripId: string;
    if (request.mode === 'write') {
      const created = await repository.identityRepository.create(actor, { ...input, name: `합성-${manifest.runId}-restart` }, operation());
      tripId = created.value.trip.id;
      await repository.ledgerRepository.execute(actor, tripId, () => ({ command: { type: 'schedule.create', input: {
        date: '2026-11-01', title: '프로세스 재시작 보존 일정', place: '합성 장소', budgetKrw: 1200,
        startTime: '10:00', endTime: '11:00' } }, expectedRevision: 1, operation: operation() }));
    } else {
      if (typeof request.tripId !== 'string' || !/^[0-9a-f-]{36}$/.test(request.tripId)) throw Error();
      tripId = request.tripId;
    }
    const trip = await repository.identityRepository.get(actor, tripId), ledger = await repository.ledgerRepository.get(actor, tripId);
    const result = { tripId, name: trip.trip.name, revision: ledger.revision, budgetKrw: ledger.budgetKrw,
      items: ledger.items.map(item => ({ id: item.id, title: item.title, budgetKrw: item.budgetKrw })) };
    repository.close(); await releaseLifetime(); releaseLifetime = undefined;
    await Promise.all([pools.app.end(), pools.auth.end()]); pools = undefined;
    process.send?.({ ok: true, result }, () => process.exit(0));
  } catch {
    repository?.close(); try { await releaseLifetime?.(); } catch { /* Fixed IPC error only. */ }
    if (pools) await Promise.allSettled([pools.app.end(), pools.auth.end()]);
    process.send?.({ ok: false }, () => process.exit(1));
  }
});
