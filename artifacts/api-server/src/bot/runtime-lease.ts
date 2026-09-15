const runtimeLockName = "discord-roblox-blacklist-bot/runtime/v1";

export interface BotRuntimeLease {
  /** Exposed only for isolated development integration tests. */
  backendPid: number;
  release(): Promise<void>;
}

export class BotRuntimeLeaseUnavailableError extends Error {
  constructor() {
    super("Another bot runtime already holds the PostgreSQL leadership lock.");
    this.name = "BotRuntimeLeaseUnavailableError";
  }
}

/**
 * Keep this exact PostgreSQL session open while Discord is connected. Advisory
 * locks are released automatically if its database connection dies, at which
 * point the caller must stop Discord immediately rather than risk two leaders.
 */
export async function acquireBotRuntimeLease(
  onLost: (error: Error) => void,
): Promise<BotRuntimeLease> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  let released = false;
  let backendPid: number | undefined;
  const lost = (error: Error) => {
    if (!released) onLost(error);
  };
  client.once("error", lost);
  try {
    const result = await client.query<{ acquired: boolean; backend_pid: number }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS acquired, pg_backend_pid() AS backend_pid",
      [runtimeLockName],
    );
    if (result.rows[0]?.acquired !== true) {
      throw new BotRuntimeLeaseUnavailableError();
    }
    backendPid = result.rows[0].backend_pid;
  } catch (error) {
    released = true;
    client.removeListener("error", lost);
    client.release();
    throw error;
  }
  return {
    backendPid: backendPid!,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      client.removeListener("error", lost);
      try {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [runtimeLockName]);
      } finally {
        client.release();
      }
    },
  };
}