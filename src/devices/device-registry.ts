/**
 * Local cache of discovered devices.
 *
 * Populated when Alexa sends a Discover directive or when the agent
 * proactively queries devices.  The registry allows the agent tool to
 * enumerate and look up devices without re-discovering every time.
 */

import type { DiscoveredDevice, DisplayCategory } from '../types/alexa';

export class DeviceRegistry {
  private devices = new Map<string, DiscoveredDevice>();

  /** Replace the entire device list (called after a Discover response). */
  setAll(devices: DiscoveredDevice[]): void {
    this.devices.clear();
    for (const d of devices) {
      this.devices.set(d.endpointId, d);
    }
  }

  /** Add or update a single device (e.g., from AddOrUpdateReport). */
  upsert(device: DiscoveredDevice): void {
    this.devices.set(device.endpointId, device);
  }

  /** Remove a device (e.g., from DeleteReport). */
  remove(endpointId: string): boolean {
    return this.devices.delete(endpointId);
  }

  /** Get a single device by endpoint ID. */
  get(endpointId: string): DiscoveredDevice | undefined {
    return this.devices.get(endpointId);
  }

  /** List all devices, optionally filtered by display category. */
  list(category?: DisplayCategory): DiscoveredDevice[] {
    const all = Array.from(this.devices.values());
    if (!category) return all;
    return all.filter((d) => d.displayCategories.includes(category));
  }

  /** Total number of registered devices. */
  get size(): number {
    return this.devices.size;
  }

  /** Check whether a device with the given ID exists. */
  has(endpointId: string): boolean {
    return this.devices.has(endpointId);
  }
}
