import { describe, expect, it } from "vitest";
import { formatMessageTimestamp, isSameLocalDate } from "./message-time";

const timeOnlyOptions: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
};

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

describe("formatMessageTimestamp", () => {
  it("shows only the time for messages from the current local day", () => {
    const now = new Date(2026, 5, 2, 10, 0);
    const messageDate = new Date(2026, 5, 2, 8, 15);

    expect(formatMessageTimestamp(messageDate.toISOString(), now)).toBe(
      messageDate.toLocaleTimeString([], timeOnlyOptions),
    );
  });

  it("shows date and time for yesterday even when it is within 24 hours", () => {
    const now = new Date(2026, 5, 2, 10, 0);
    const messageDate = new Date(2026, 5, 1, 23, 30);

    expect(isSameLocalDate(messageDate, now)).toBe(false);
    expect(now.getTime() - messageDate.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    expect(formatMessageTimestamp(messageDate.toISOString(), now)).toBe(
      messageDate.toLocaleString([], dateTimeOptions),
    );
  });

  it("returns an empty string for invalid timestamps", () => {
    expect(formatMessageTimestamp("not-a-date")).toBe("");
  });
});
