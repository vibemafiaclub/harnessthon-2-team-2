import { fail } from "./canonical.mjs";

// Loop-control contract carried over from the lab skill: at most three
// automatic repair attempts and five human-directed rounds, then escalate.
// Limits are configurable but always visible in the persisted state.
export const DEFAULT_LIMITS = Object.freeze({ maxAutoRepairs: 3, maxHumanRounds: 5 });

export function createControlState(overrides = {}) {
  const maxAutoRepairs = boundedInteger(overrides.maxAutoRepairs, 0, 10, DEFAULT_LIMITS.maxAutoRepairs);
  const maxHumanRounds = boundedInteger(overrides.maxHumanRounds, 1, 20, DEFAULT_LIMITS.maxHumanRounds);
  return {
    limits: { maxAutoRepairs, maxHumanRounds },
    autoRepairsUsed: 0,
    humanRoundsUsed: 0,
    escalated: false,
    escalationReason: null,
    history: [],
  };
}

export function recordAutoRepair(state, detail) {
  assertState(state);
  if (state.escalated) fail("already_escalated", "The run is escalated; no further automatic repairs are allowed.");
  if (state.autoRepairsUsed >= state.limits.maxAutoRepairs) {
    return escalate(state, `Automatic repair limit reached (${state.limits.maxAutoRepairs}).`);
  }
  state.autoRepairsUsed += 1;
  state.history.push({ kind: "auto_repair", round: state.autoRepairsUsed, detail: String(detail || "") });
  return state;
}

export function recordHumanRound(state, detail) {
  assertState(state);
  if (state.escalated) fail("already_escalated", "The run is escalated; no further human-directed rounds are allowed.");
  if (state.humanRoundsUsed >= state.limits.maxHumanRounds) {
    return escalate(state, `Human-directed round limit reached (${state.limits.maxHumanRounds}).`);
  }
  state.humanRoundsUsed += 1;
  state.history.push({ kind: "human_round", round: state.humanRoundsUsed, detail: String(detail || "") });
  return state;
}

export function escalate(state, reason) {
  assertState(state);
  state.escalated = true;
  state.escalationReason = String(reason || "Escalated.");
  state.history.push({ kind: "escalation", detail: state.escalationReason });
  return state;
}

export function remaining(state) {
  assertState(state);
  return {
    autoRepairs: Math.max(0, state.limits.maxAutoRepairs - state.autoRepairsUsed),
    humanRounds: Math.max(0, state.limits.maxHumanRounds - state.humanRoundsUsed),
    escalated: state.escalated,
  };
}

function assertState(state) {
  if (!state || typeof state !== "object" || !state.limits) fail("control_state_invalid", "A control state from createControlState is required.");
}

function boundedInteger(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}
