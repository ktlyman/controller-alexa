/**
 * Routine manager — creates, triggers, and manages routines.
 *
 * Since there is no consumer Alexa API for routine CRUD, this module
 * maintains its own store and interacts with Alexa through:
 *
 * 1. Custom Triggers API (developer preview) — fires a trigger that
 *    the user has wired to an Alexa Routine in the Alexa app.
 * 2. Direct device commands — executes the actions list by sending
 *    control directives in sequence.
 */

import https from 'https';
import { v4 as uuid } from 'uuid';
import type { AlexaAgentConfig } from '../config';
import type { RoutineDefinition, RoutineSummary } from '../types/agent';
import type { StoredRoutine, RoutineStore } from './routine-store';
import { InMemoryRoutineStore, toSummary } from './routine-store';

export class RoutineManager {
  private store: RoutineStore;
  private config: AlexaAgentConfig;

  constructor(config: AlexaAgentConfig, store?: RoutineStore) {
    this.config = config;
    this.store = store ?? new InMemoryRoutineStore();
  }

  /**
   * Create a new routine definition and persist it.
   */
  async createRoutine(definition: RoutineDefinition): Promise<string> {
    const id = uuid();
    const routine: StoredRoutine = {
      id,
      name: definition.name,
      trigger: definition.trigger,
      actions: definition.actions,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    await this.store.create(routine);
    return id;
  }

  /**
   * List all routines.
   */
  async listRoutines(): Promise<RoutineSummary[]> {
    const all = await this.store.list();
    return all.map(toSummary);
  }

  /**
   * Trigger a routine by ID.
   *
   * If the routine has a custom trigger, we fire it through the
   * Alexa Routines Trigger API.  Otherwise we return the action
   * list so the caller can execute the device commands.
   */
  async triggerRoutine(routineId: string, accessToken?: string): Promise<{
    triggered: boolean;
    actionsToExecute?: StoredRoutine['actions'];
  }> {
    const routine = await this.store.get(routineId);
    if (!routine) throw new Error(`Routine ${routineId} not found`);
    if (!routine.enabled) throw new Error(`Routine ${routineId} is disabled`);

    // Update last triggered timestamp
    await this.store.update(routineId, {
      lastTriggered: new Date().toISOString(),
    });

    if (routine.trigger.type === 'custom' && accessToken) {
      await this.fireCustomTrigger(routine.trigger.triggerId, accessToken);
      return { triggered: true };
    }

    // For non-custom triggers, return actions so caller can execute them
    return { triggered: true, actionsToExecute: routine.actions };
  }

  /**
   * Delete a routine.
   */
  async deleteRoutine(routineId: string): Promise<boolean> {
    return this.store.delete(routineId);
  }

  /**
   * Get a single routine by ID.
   */
  async getRoutine(routineId: string): Promise<StoredRoutine | null> {
    return this.store.get(routineId);
  }

  // -----------------------------------------------------------------------
  // Alexa Custom Trigger API
  // -----------------------------------------------------------------------

  /**
   * Fire a custom trigger instance via the Alexa Routines Trigger API.
   *
   * POST https://api.amazonalexa.com/v1/skills/{skillId}/routines/triggerInstances
   */
  private fireCustomTrigger(triggerId: string, accessToken: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        triggerEventId: triggerId,
        deliveryMode: 'UNICAST',
        timestamp: new Date().toISOString(),
      });

      const req = https.request(
        {
          hostname: 'api.amazonalexa.com',
          port: 443,
          path: `/v1/skills/${this.config.skillId}/routines/triggerInstances`,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: string) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Custom trigger failed (${res.statusCode}): ${data}`));
            }
          });
        },
      );

      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }
}
