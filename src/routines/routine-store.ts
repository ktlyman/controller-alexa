/**
 * Routine storage.
 *
 * Because there is no consumer-facing Alexa API to list/read routines,
 * we maintain our own registry of routines that were created through
 * the agent tool.  These map to either:
 * - Custom triggers registered with the Alexa Routines Trigger API
 * - Virtual device-based triggers (Voice Monkey, virtual buttons)
 * - Scheduled actions managed by our own scheduler
 */

import type { RoutineDefinition, RoutineSummary, RoutineTrigger } from '../types/agent';

export interface StoredRoutine {
  id: string;
  name: string;
  trigger: RoutineTrigger;
  actions: RoutineDefinition['actions'];
  enabled: boolean;
  lastTriggered?: string;
  createdAt: string;
}

export interface RoutineStore {
  create(routine: StoredRoutine): Promise<void>;
  get(routineId: string): Promise<StoredRoutine | null>;
  list(): Promise<StoredRoutine[]>;
  update(routineId: string, updates: Partial<StoredRoutine>): Promise<void>;
  delete(routineId: string): Promise<boolean>;
}

export class InMemoryRoutineStore implements RoutineStore {
  private routines = new Map<string, StoredRoutine>();

  async create(routine: StoredRoutine): Promise<void> {
    this.routines.set(routine.id, routine);
  }

  async get(routineId: string): Promise<StoredRoutine | null> {
    return this.routines.get(routineId) ?? null;
  }

  async list(): Promise<StoredRoutine[]> {
    return Array.from(this.routines.values());
  }

  async update(routineId: string, updates: Partial<StoredRoutine>): Promise<void> {
    const existing = this.routines.get(routineId);
    if (!existing) throw new Error(`Routine ${routineId} not found`);
    this.routines.set(routineId, { ...existing, ...updates });
  }

  async delete(routineId: string): Promise<boolean> {
    return this.routines.delete(routineId);
  }
}

export function toSummary(routine: StoredRoutine): RoutineSummary {
  return {
    id: routine.id,
    name: routine.name,
    trigger: routine.trigger,
    actionCount: routine.actions.length,
    enabled: routine.enabled,
    lastTriggered: routine.lastTriggered,
    createdAt: routine.createdAt,
  };
}
