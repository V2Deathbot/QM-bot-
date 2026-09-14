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
  const settings = validatePresenceSettings(input);
  stopPresenceRotation();
  if (!client.user) return;
  if (!settings.enabled) {
    client.user.setPresence({ activities: [] });
    return;
  }
  let activityIndex = 0;
  const update = () => {
    if (!client.user) return;
    client.user.setPresence({
      activities: [{ name: settings.activities[activityIndex]!, type: ActivityType.Watching }],
    });
    if (settings.rotationEnabled && settings.activities.length > 1) {
      const minimum = settings.minIntervalMinutes * 60_000;
      const maximum = settings.maxIntervalMinutes * 60_000;
      const delay = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
      timer = setTimeout(() => {
        activityIndex = (activityIndex + 1) % settings.activities.length;
        update();
      }, delay);
      timer.unref();
    }
  };
  update();
}