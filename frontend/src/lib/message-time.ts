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

export function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate()
  );
}

export function formatMessageTimestamp(isoTime: string, now = new Date()): string {
  const date = new Date(isoTime);
  if (Number.isNaN(date.getTime())) return "";

  if (isSameLocalDate(date, now)) {
    return date.toLocaleTimeString([], timeOnlyOptions);
  }

  return date.toLocaleString([], dateTimeOptions);
}
