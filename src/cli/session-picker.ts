import { fail } from "../lib/errors.js";
import { sanitizeInline } from "../output/format.js";
import { selectManyWithSearch } from "../output/prompt.js";
import type { CodexSession } from "../services/sessions.js";
import { shortTime } from "../services/sessions.js";

export async function selectSessionIds(sessions: CodexSession[]): Promise<string[]> {
  if (sessions.length === 0) {
    fail("No Codex sessions found.");
  }

  const selectedIndexes = await selectManyWithSearch(
    sessions.map((session) => ({
      label: `${sanitizeInline(session.title)} (${session.id.slice(0, 8)})`,
      detail: `${shortTime(session.updatedAt)}  ${session.location}`,
      searchText: `${session.title} ${session.id} ${session.location}`,
    })),
    { initialPrompt: "Search by title/id, then enter numbers/ranges (Enter cancels): " },
  );

  if (selectedIndexes === null) {
    fail("Cancelled.");
  }

  if (selectedIndexes.length === 0) {
    fail("No sessions selected.");
  }

  return selectedIndexes.map((index) => sessions[index].id);
}
