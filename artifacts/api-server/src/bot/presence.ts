import { ActivityType, type Client } from "discord.js";

export interface PresenceSettings {
  enabled: boolean;
  activities: string[];
  rotationEnabled: boolean;
  minIntervalMinutes: number;
  maxIntervalMinutes: number;
  disabledActivities?: string[];
  dynamicActivitiesEnabled?: boolean;
}

export const DEFAULT_PRESENCE_SETTINGS: PresenceSettings = {
  enabled: true,
  activities: [
    "Customers",
    "Blacklist Records",
    "Quartermaster Corps",
    "Supply Operations",
    "Trello Records",
    "Security Logs",
    "Personnel Records",
    "{ACTIVE_BLACKLISTS} Active Blacklists",
    "{SERVER_MEMBERS} Personnel",
  ],
  rotationEnabled: true,
  minIntervalMinutes: 5,
  maxIntervalMinutes: 20,
  disabledActivities: [],
  dynamicActivitiesEnabled: true,
};

export interface PresenceStats {
  activeBlacklists?: number;
  serverMembers?: number;
}
const activityWeights: Record<string, number> = {
  Customers: 30,
  "Blacklist Records": 15,
  "Quartermaster Corps": 15,
  "Supply Operations": 10,
  "Security Logs": 10,
  "Trello Records": 5,
  "Personnel Records": 5,
  "{ACTIVE_BLACKLISTS} Active Blacklists": 5,
  "{SERVER_MEMBERS} Personnel": 5,
};
let statsProvider: (() => Promise<PresenceStats>) | undefined;
export function setPresenceStatsProvider(provider: () => Promise<PresenceStats>): void {
  statsProvider = provider;
}

function resolveActivity(template: string, stats: PresenceStats): string | null {
  let unavailable = false;
  const result = template.replace(/\{(ACTIVE_BLACKLISTS|SERVER_MEMBERS)\}/g, (_, key: string) => {
    const value = key === "ACTIVE_BLACKLISTS" ? stats.activeBlacklists : stats.serverMembers;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      unavailable = true;
      return "";
    }
    return value.toLocaleString("en-US");
  });
  return unavailable || result.length > 128 ? null : result;
}

export function getPresenceActivityPreview(
  settings: PresenceSettings,
  stats: PresenceStats = {},
): Array<{ template: string; activity: string | null; enabled: boolean; weight: number }> {
  return settings.activities.map((template) => ({
    template,
    activity: resolveActivity(template, stats),
    enabled: !(settings.disabledActivities ?? []).includes(template) &&
      (settings.dynamicActivitiesEnabled !== false || !template.includes("{")),
    weight: activityWeights[template] ?? 5,
  }));
}

let timer: ReturnType<typeof setTimeout> | undefined;
let statsTimeout: ReturnType<typeof setTimeout> | undefined;
let cancelStats: (() => void) | undefined;
let generation = 0;
const lastPublished = new WeakMap<Client, string>();
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
let currentActivity: string | null = "Customers";

function primaryActivity(): string | null {
  if (!normalSettings.enabled) return null;
  const available = getPresenceActivityPreview(normalSettings)
    .filter((entry) => entry.enabled && entry.activity !== null);
  return available.find((entry) => entry.template === "Customers")?.activity ??
    available[0]?.activity ?? null;
}

export function getEffectivePresence(): {
  status: "online" | "idle" | "dnd";
  activity: string | null;
  mode: PresenceMode;
} {
  if (priority.lockdown) return { status: "dnd", activity: "Security Lockdown", mode: "lockdown" };
  if (priority.maintenance) return { status: "idle", activity: "Maintenance", mode: "maintenance" };
  if (priority.serviceFailure) return { status: "idle", activity: "Trello Connection", mode: "serviceFailure" };
  if (priority.startup) return { status: "idle", activity: "Systems Initialize", mode: "startup" };
  return {
    status: "online",
    activity: currentActivity,
    mode: "normal",
  };
}

/** Updating an unchanged/lower-priority flag must not reset the rotation timer. */
export function setPresencePriority(client: Client, update: Partial<PresencePriorityState>): void {
  const before = getEffectivePresence();
  priority = { ...priority, ...update };
  const after = getEffectivePresence();
  if (before.mode === after.mode) return;
  currentActivity = primaryActivity();
  renderPresence(client);
}

export function validatePresenceSettings(settings: PresenceSettings): PresenceSettings {
  if (typeof settings.enabled !== "boolean" || typeof settings.rotationEnabled !== "boolean") {
    throw new Error("Presence and rotation must be enabled or disabled.");
  }
  if (!Array.isArray(settings.activities) || settings.activities.length < 1 || settings.activities.length > 20) {
    throw new Error("Provide between 1 and 20 watching activities.");
  }
  const activities = settings.activities.map((activity) => {
    if (typeof activity !== "string") throw new Error("Activities must be text.");
    const value = activity.trim();
    if (!value || value.length > 128 || /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(value)) {
      throw new Error("Activities must contain 1–128 characters without control or invisible formatting characters.");
    }
    if (/@(?:everyone|here)\b|<@[^>]*>/i.test(value)) throw new Error("Discord mentions are not allowed in activities.");
    if (/[{}]/.test(value.replace(/\{(?:ACTIVE_BLACKLISTS|SERVER_MEMBERS)\}/g, ""))) {
      throw new Error("Only {ACTIVE_BLACKLISTS} and {SERVER_MEMBERS} placeholders are supported.");
    }
    return value;
  });
  if (new Set(activities).size !== activities.length) throw new Error("Each activity must be unique.");
  if (settings.dynamicActivitiesEnabled !== undefined && typeof settings.dynamicActivitiesEnabled !== "boolean") {
    throw new Error("Dynamic activities must be enabled or disabled.");
  }
  const disabledActivities = settings.disabledActivities ?? [];
  if (!Array.isArray(disabledActivities) || disabledActivities.some((value) => typeof value !== "string" || !activities.includes(value))) {
    throw new Error("Disabled activities must refer to configured activities.");
  }
  if (!activities.some((value) => !disabledActivities.includes(value) && !value.includes("{"))) {
    throw new Error("Keep at least one static activity enabled for when live counts are unavailable.");
  }
  const { minIntervalMinutes, maxIntervalMinutes } = settings;
  if (
    !Number.isInteger(minIntervalMinutes) ||
    !Number.isInteger(maxIntervalMinutes) ||
    minIntervalMinutes < 2 ||
    maxIntervalMinutes > 1440 ||
    minIntervalMinutes > maxIntervalMinutes
  ) {
    throw new Error("Rotation intervals must be whole minutes between 2 and 1440, with minimum no greater than maximum.");
  }
  return { ...settings, activities, disabledActivities: [...new Set(disabledActivities)],
    dynamicActivitiesEnabled: settings.dynamicActivitiesEnabled ?? true };
}

function cancelRotation(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
  if (statsTimeout) clearTimeout(statsTimeout);
  statsTimeout = undefined;
  cancelStats?.();
  cancelStats = undefined;
}

export function stopPresenceRotation(): void {
  cancelRotation();
}

export function applyPresenceSettings(client: Client, input: PresenceSettings): void {
  normalSettings = validatePresenceSettings(input);
  currentActivity = primaryActivity();
  renderPresence(client);
}

function renderPresence(client: Client): void {
  cancelRotation();
  publishPresence(client);
  scheduleRotation(client);
}

function publishPresence(client: Client): void {
  if (!client.user) return;
  const effective = getEffectivePresence();
  const payload = {
    status: effective.status,
    activities: effective.activity
      ? [{ name: effective.activity, type: ActivityType.Watching }]
      : [],
  };
  const signature = JSON.stringify(payload);
  if (lastPublished.get(client) === signature) return;
  client.user.setPresence(payload);
  lastPublished.set(client, signature);
}

function scheduleRotation(client: Client): void {
  const effective = getEffectivePresence();
  if (
    client.user && effective.mode === "normal" && normalSettings.enabled &&
    normalSettings.rotationEnabled &&
    getPresenceActivityPreview(normalSettings).filter((entry) => entry.enabled).length > 1
  ) {
    const minimum = normalSettings.minIntervalMinutes * 60_000;
    const maximum = normalSettings.maxIntervalMinutes * 60_000;
    const delay = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
    const token = generation;
    timer = setTimeout(() => { timer = undefined; void rotate(client, token); }, delay);
    timer.unref();
  }
}

async function readStats(): Promise<PresenceStats> {
  if (!statsProvider || normalSettings.dynamicActivitiesEnabled === false) return {};
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<PresenceStats>((resolve) => {
    cancelStats = () => resolve({});
    timeout = setTimeout(() => resolve({}), 3000);
    timeout.unref();
    statsTimeout = timeout;
  });
  try {
    return await Promise.race([Promise.resolve().then(() => statsProvider!()).catch(() => ({})), deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (statsTimeout === timeout) {
      statsTimeout = undefined;
      cancelStats = undefined;
    }
  }
}

async function rotate(client: Client, token: number): Promise<void> {
  const stats = await readStats();
  if (token !== generation || getEffectivePresence().mode !== "normal") return;
  const candidates = getPresenceActivityPreview(normalSettings, stats)
    .filter((entry) => entry.enabled && entry.activity !== null && entry.activity !== currentActivity);
  if (candidates.length) {
    const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
    let choice = Math.random() * total;
    const selected = candidates.find((entry) => { choice -= entry.weight; return choice < 0; }) ?? candidates.at(-1)!;
    currentActivity = selected.activity;
    publishPresence(client);
  }
  scheduleRotation(client);
}