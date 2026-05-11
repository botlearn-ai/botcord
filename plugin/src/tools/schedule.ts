/**
 * botcord_schedule — manage BotCord proactive schedules from the agent.
 */
import { withClient } from "./with-client.js";
import { validationError } from "./tool-result.js";

const DEFAULT_MESSAGE = "【BotCord 自主任务】执行本轮工作目标。";

function everyMsFromArgs(args: any): number | undefined {
  if (typeof args.everyMs === "number") return Math.trunc(args.everyMs);
  if (typeof args.every_ms === "number") return Math.trunc(args.every_ms);
  return undefined;
}

function calendarScheduleFromArgs(args: any): Record<string, unknown> | undefined {
  const frequency = String(args.frequency || "");
  if (frequency !== "daily" && frequency !== "weekly") return undefined;
  if (typeof args.time !== "string" || !/^\d{2}:\d{2}$/.test(args.time)) return undefined;
  const timezone = typeof args.timezone === "string" && args.timezone ? args.timezone : "UTC";
  if (frequency === "daily") {
    return { kind: "calendar", frequency, time: args.time, timezone };
  }
  const weekdays = Array.isArray(args.weekdays) ? args.weekdays.map((day: unknown) => Math.trunc(Number(day))) : [];
  if (weekdays.length === 0) return undefined;
  return { kind: "calendar", frequency, time: args.time, timezone, weekdays };
}

export function createScheduleTool() {
  return {
    name: "botcord_schedule",
    label: "BotCord Schedule",
    description:
      "Create, list, edit, pause, delete, or manually run BotCord proactive schedules. " +
      "Use this to configure autonomous execution after the owner has approved the cadence.",
    parameters: {
      type: "object" as const,
      properties: {
        action: {
          type: "string" as const,
          enum: ["list", "add", "edit", "pause", "resume", "delete", "run", "runs"],
        },
        scheduleId: { type: "string" as const, description: "Schedule id for edit/delete/run/runs." },
        name: { type: "string" as const, description: "Human-readable schedule name." },
        everyMs: { type: "number" as const, description: "Interval in milliseconds. Minimum 300000." },
        frequency: {
          type: "string" as const,
          enum: ["daily", "weekly"],
          description: "Calendar cadence. Use with time and timezone instead of everyMs.",
        },
        time: { type: "string" as const, description: "Local 24-hour time in HH:MM format." },
        timezone: { type: "string" as const, description: "IANA timezone, for example Asia/Shanghai." },
        weekdays: {
          type: "array" as const,
          items: { type: "number" as const },
          description: "Weekly weekdays, Monday=0 through Sunday=6.",
        },
        message: {
          type: "string" as const,
          description: "Message used to trigger the proactive turn.",
        },
        confirm: {
          type: "boolean" as const,
          description: "Required for add/edit/pause/resume/delete/run.",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId: any, args: any) => {
      const action = String(args?.action || "");
      if (!action) return validationError("action is required");
      const mutating = action !== "list" && action !== "runs";
      if (mutating && !args?.confirm) {
        return validationError("confirm=true is required for schedule mutations");
      }

      return withClient(async (client) => {
        switch (action) {
          case "list":
            return { response: await client.request("GET", "/hub/schedules") };
          case "runs": {
            if (!args.scheduleId) return validationError("scheduleId is required");
            return {
              response: await client.request("GET", `/hub/schedules/${encodeURIComponent(args.scheduleId)}/runs`),
            };
          }
          case "add": {
            const everyMs = everyMsFromArgs(args);
            const calendarSchedule = calendarScheduleFromArgs(args);
            if (!args.name) return validationError("name is required");
            if (!everyMs && !calendarSchedule) return validationError("everyMs or frequency/time is required");
            return { response: await client.request("POST", "/hub/schedules", {
              body: {
                name: args.name,
                enabled: args.enabled !== false,
                schedule: calendarSchedule || { kind: "every", every_ms: everyMs },
                payload: { kind: "agent_turn", message: args.message || DEFAULT_MESSAGE },
              },
            }) };
          }
          case "edit": {
            if (!args.scheduleId) return validationError("scheduleId is required");
            const body: Record<string, unknown> = {};
            const everyMs = everyMsFromArgs(args);
            const calendarSchedule = calendarScheduleFromArgs(args);
            if (args.name) body.name = args.name;
            if (everyMs) body.schedule = { kind: "every", every_ms: everyMs };
            if (calendarSchedule) body.schedule = calendarSchedule;
            if (args.message) body.payload = { kind: "agent_turn", message: args.message };
            if (args.enabled !== undefined) body.enabled = Boolean(args.enabled);
            if (Object.keys(body).length === 0) return validationError("nothing to edit");
            return {
              response: await client.request("PATCH", `/hub/schedules/${encodeURIComponent(args.scheduleId)}`, { body }),
            };
          }
          case "pause":
          case "resume": {
            if (!args.scheduleId) return validationError("scheduleId is required");
            return { response: await client.request("PATCH", `/hub/schedules/${encodeURIComponent(args.scheduleId)}`, {
              body: { enabled: action === "resume" },
            }) };
          }
          case "delete": {
            if (!args.scheduleId) return validationError("scheduleId is required");
            return { response: await client.request("DELETE", `/hub/schedules/${encodeURIComponent(args.scheduleId)}`) };
          }
          case "run": {
            if (!args.scheduleId) return validationError("scheduleId is required");
            return { response: await client.request("POST", `/hub/schedules/${encodeURIComponent(args.scheduleId)}/run`) };
          }
          default:
            return validationError(`unsupported action: ${action}`);
        }
      });
    },
  };
}
