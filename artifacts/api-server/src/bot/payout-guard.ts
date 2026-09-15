/**
 * Coordinates spreadsheet writers in this process.  A payout takes an
 * exclusive workbook gate; ordinary uniform writes take a shared gate.  The
 * reset intent is set before waiting for existing writers, so a writer that
 * arrives while a reset is queued cannot slip in after its snapshot.
 *
 * The durable run store is the cross-restart/process authority.  This small
 * gate deliberately only solves in-process ordering.
 */
interface WorkbookGate {
  resetting: boolean;
  activeMutations: number;
  waiters: Array<() => void>;
}

const gates = new Map<string, WorkbookGate>();

function gateFor(spreadsheetId: string): WorkbookGate {
  let gate = gates.get(spreadsheetId);
  if (!gate) {
    gate = { resetting: false, activeMutations: 0, waiters: [] };
    gates.set(spreadsheetId, gate);
  }
  return gate;
}

function wake(gate: WorkbookGate): void {
  if (gate.activeMutations !== 0 || !gate.resetting) return;
  for (const resolve of gate.waiters.splice(0)) resolve();
}

/** Run one normal uniform spreadsheet mutation, or refuse during a reset. */
export async function withUniformWorkbookMutation<T>(
  spreadsheetId: string,
  work: () => Promise<T>,
): Promise<T> {
  const gate = gateFor(spreadsheetId);
  if (gate.resetting) {
    throw new Error("A payout reset is in progress for this spreadsheet. Uniform changes are temporarily unavailable.");
  }
  gate.activeMutations++;
  try {
    return await work();
  } finally {
    gate.activeMutations--;
    wake(gate);
  }
}

/**
 * Mark reset intent synchronously, wait for already-started mutations, then
 * run exclusively. Callers must also hold the persistent payout lock.
 */
export async function withPayoutWorkbookExclusivity<T>(
  spreadsheetId: string,
  work: () => Promise<T>,
): Promise<T> {
  const gate = gateFor(spreadsheetId);
  if (gate.resetting) throw new Error("A payout reset is already in progress for this spreadsheet.");
  gate.resetting = true;
  try {
    if (gate.activeMutations) {
      await new Promise<void>((resolve) => gate.waiters.push(resolve));
    }
    return await work();
  } finally {
    gate.resetting = false;
    // A normal write never waits at the gate (it is rejected instead), but
    // clean up idle entries to avoid retaining arbitrary spreadsheet IDs.
    if (gate.activeMutations === 0) gates.delete(spreadsheetId);
  }
}

export function resetPayoutGuardsForTests(): void {
  gates.clear();
}