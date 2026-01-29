/**
 * Date formatting utilities for Memento MCP
 */

/**
 * Format timestamp as human-readable ISO date
 * @param ts - Unix timestamp in milliseconds
 * @returns ISO date string (YYYY-MM-DD) or null if timestamp is null/undefined
 */
export function formatTimestamp(ts: number | null | undefined): string | null {
  if (ts == null) return null;
  const date = new Date(ts);
  if (isNaN(date.getTime())) return null;
  return date.toISOString().split('T')[0]; // "2025-05-27"
}
