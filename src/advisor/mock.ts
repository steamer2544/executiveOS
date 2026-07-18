// MockAdvisor — deterministic, offline. Derives a few plausible proposals from
// context so tests (and offline use) get sensible, varied cards.

import type { Advisor, ProposalDraft } from "./types.js";
import type { Context } from "../state/types.js";

export class MockAdvisor implements Advisor {
  readonly name = "mock";

  async propose(context: Context, openTitles: string[]): Promise<ProposalDraft[]> {
    const s = context.state;
    const open = new Set(openTitles.map((t) => t.toLowerCase()));
    const drafts: ProposalDraft[] = [];

    if (s.tests === "failing") {
      drafts.push({
        category: "work",
        title: "Fix the failing tests",
        detail: "Tests are red on " + (s.git.branch ?? "the current branch") + "; green them before moving on.",
        action: "Run the test suite and fix the first failing assertion.",
      });
    }
    if (s.blocked) {
      drafts.push({
        category: "admin",
        title: "Unblock: " + (s.blockedReason ?? "current blocker"),
        detail: "You flagged a blocker — a nudge to the right person often clears it fastest.",
        action: "Send a one-line follow-up about: " + (s.blockedReason ?? "the blocker") + ".",
      });
    }
    if (s.currentTask) {
      drafts.push({
        category: "work",
        title: "Timebox: " + s.currentTask,
        detail: "A 45-minute focused block on the current task keeps momentum.",
        action: "Start a 45-minute timer and work only on " + s.currentTask + ".",
      });
    }
    // A life/rest card, always available.
    drafts.push({
      category: "rest",
      title: "Take a 10-minute break",
      detail: "Short breaks protect focus and reduce decision fatigue.",
      action: "Step away from the screen for 10 minutes.",
    });

    return drafts.filter((d) => !open.has(d.title.toLowerCase()));
  }
}
