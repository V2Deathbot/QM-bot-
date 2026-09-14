import { ActivityType, type Client } from "discord.js";

export interface PresenceSettings {
  enabled: boolean;
  activities: string[];
  rotationEnabled: boolean;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  enabled: true,
  activities: [
    "Customers",
    "Quartermaster Corps",
    "Blacklist Records",
    "Supply Operations",
    "Active Blacklists",
  ],
  rotationEnabled: true,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 20,
};

let timer: ReturnType<typeof setTimeout> | undefined;
export interface PresencePriorityState {
  lockdown: boolean;
  maintenance: boolean;
  serviceFailure: boolean;
  startup: boolean;
}

type PresenceMode = "lockdown" | "maintenance" | "serviceFailure" | "startup" | "normal";
let priority: PresencePriorityState = {
  lockdown: false, maintenance: false, serviceFailure: false, startup: false,
};
let normalSettings = { ...DEFAULT_PRESENCE_SETTINGS };
let activityIndex = 0;

export function getEffectivePresence(): {
  status: "online" | "idle" | "dnd";
  activity: string | null;
  mode: PresenceMode;
} {
  if (priority.lockdown) return { status: "dnd", activity: "Security Lockdown", mode: "lockdown" };
  if (priority.maintenance) return { status: "idle", activity: "Maintenance", mode: "maintenance" };
  if (priority.serviceFailure) return { status: "dnd", activity: "Service Unavailable", mode: "serviceFailure" };
  if (priority.startup) return { status: "idle", activity: "Starting Up", mode: "startup" };
  return {
    status: "online",
    activity: normalSettings.enabled ? normalSettings.activities[activityIndex]! : null,
    mode: "normal",
  };
}

/** Updating an unchanged/lower-priority flag must not reset the rotation timer. */
export function setPresencePriority(client: Client, update: Partial<PresencePriorityState>): void {
  const before = getEffectivePresence();
  priority = { ...priority, ...update };
  const after = getEffectivePresence();
  if (before.mode === after.mode) return;
  activityIndex = 0;
  renderPresence(client);
}

export function validatePresenceSettings(settings: PresenceSettings): PresenceSettings {
  if (typeof settings.enabled !== "boolean" || typeof settings.rotationEnabled !== "boolean") {
    throw new Error("Presence and rotation must be enabled or disabled.");
  }
  if (!Array.isArray(settings.activities) || settings.activities.length < 1 || settings.activities.length > 10) {
    throw new Error("Provide between 1 and 10 watching activities.");
  }
  const activities = settings.activities.map((activity) => {
    if (typeof activity !== "string") throw new Error("Activities must be text.");
    const value = activity.trim();
    if (!value || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Activities must contain 1–100 characters without control characters.");
    }
    return value;
  });
  const { minIntervalMinutes, maxIntervalMinutes } = settings;
  if (
    !Number.isInteger(minIntervalMinutes) ||
    !Number.isInteger(maxIntervalMinutes) ||
    minIntervalMinutes < 1 ||
    maxIntervalMinutes > 1440 ||
    minIntervalMinutes > maxIntervalMinutes
  ) {
    throw new Error("Rotation intervals must be whole minutes between 1 and 1440, with minimum no greater than maximum.");
  }
  return { ...settings, activities };
}

export function stopPresenceRotation(): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

export function applyPresenceSettings(client: Client, input: PresenceSettings): void {
  normalSettings = validatePresenceSettings(input);
  activityIndex = 0;
  renderPresence(client);
}

function renderPresence(client: Client): void {
  stopPresenceRotation();
  if (!client.user) return;
  const effective = getEffectivePresence();
  client.user.setPresence({
    status: effective.status,
    activities: effective.activity
      ? [{ name: effective.activity, type: ActivityType.Watching }]
      : [],
  });
  if (
    effective.mode === "normal" && normalSettings.enabled &&
    normalSettings.rotationEnabled && normalSettings.activities.length > 1
  ) {
    const minimum = normalSettings.minIntervalMinutes * 60_000;
    const maximum = normalSettings.maxIntervalMinutes * 60_000;
    const delay = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    timer = setTimeout(() => {
      activityIndex = (activityIndex + 1) % normalSettings.activities.length;
      renderPresence(client);
    }, delay);
    timer.unref();
  }
}