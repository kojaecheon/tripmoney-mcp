// Permission failures in an auxiliary panel must not restart the whole page.
// The existing travel controller owns session/account changes and access loss.
export function createPlanningRecovery({travel,ledger}) {
  let pending = null;
  return function recover() {
    if (pending) return pending;
    const account = travel.state.accountId;
    const trip = travel.state.selectedTripId;
    const current = () => travel.state.accountId === account && travel.state.selectedTripId === trip;
    pending = (async () => {
      if (!account || !await travel.recheckAccount() || !current()) return false;
      await travel.refresh();
      if (!current()) return false;
      return ledger.refresh();
    })().finally(() => {pending = null;});
    return pending;
  };
}
