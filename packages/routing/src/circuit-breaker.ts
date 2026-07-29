import type { CircuitBreakerPolicy } from "./resilience.js";

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitSnapshot {
  key: string;
  state: CircuitState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  openedAt?: string;
}

interface MutableCircuit {
  state: CircuitState;
  consecutiveFailures: number;
  halfOpenSuccesses: number;
  openedAt?: number;
  probeInFlight: boolean;
}

export class CircuitBreakerRegistry {
  private readonly circuits = new Map<string, MutableCircuit>();

  public constructor(
    private readonly policy: CircuitBreakerPolicy,
    private readonly now: () => number = Date.now,
  ) {}

  public canRequest(key: string): boolean {
    const circuit = this.circuits.get(key);
    if (!circuit || circuit.state === "closed") {
      return true;
    }
    if (circuit.state === "open") {
      if (
        circuit.openedAt !== undefined &&
        this.now() - circuit.openedAt >= this.policy.openDurationMs
      ) {
        circuit.state = "half_open";
        circuit.probeInFlight = true;
        return true;
      }
      return false;
    }
    if (circuit.probeInFlight) {
      return false;
    }
    circuit.probeInFlight = true;
    return true;
  }

  public recordSuccess(key: string): void {
    const circuit = this.getOrCreate(key);
    if (circuit.state === "half_open") {
      circuit.halfOpenSuccesses += 1;
      circuit.probeInFlight = false;
      if (circuit.halfOpenSuccesses >= this.policy.halfOpenSuccessThreshold) {
        this.circuits.delete(key);
      }
      return;
    }
    this.circuits.delete(key);
  }

  public recordFailure(key: string): void {
    const circuit = this.getOrCreate(key);
    if (circuit.state === "half_open") {
      this.open(circuit);
      return;
    }
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= this.policy.failureThreshold) {
      this.open(circuit);
    }
  }

  public releaseProbe(key: string): void {
    const circuit = this.circuits.get(key);
    if (circuit?.state === "half_open") {
      circuit.probeInFlight = false;
    }
  }

  public blockedKeys(): Set<string> {
    const blocked = new Set<string>();
    for (const [key] of this.circuits) {
      if (this.isBlocked(key)) {
        blocked.add(key);
      }
    }
    return blocked;
  }

  public snapshot(key: string): CircuitSnapshot {
    const circuit = this.circuits.get(key);
    if (!circuit) {
      return {
        key,
        state: "closed",
        consecutiveFailures: 0,
        halfOpenSuccesses: 0,
      };
    }
    return {
      key,
      state: circuit.state,
      consecutiveFailures: circuit.consecutiveFailures,
      halfOpenSuccesses: circuit.halfOpenSuccesses,
      ...(circuit.openedAt === undefined
        ? {}
        : { openedAt: new Date(circuit.openedAt).toISOString() }),
    };
  }

  private getOrCreate(key: string): MutableCircuit {
    const existing = this.circuits.get(key);
    if (existing) {
      return existing;
    }
    const created: MutableCircuit = {
      state: "closed",
      consecutiveFailures: 0,
      halfOpenSuccesses: 0,
      probeInFlight: false,
    };
    this.circuits.set(key, created);
    return created;
  }

  private isBlocked(key: string): boolean {
    const circuit = this.circuits.get(key);
    if (!circuit || circuit.state === "closed") {
      return false;
    }
    if (
      circuit.state === "open" &&
      circuit.openedAt !== undefined &&
      this.now() - circuit.openedAt >= this.policy.openDurationMs
    ) {
      circuit.state = "half_open";
      circuit.probeInFlight = false;
    }
    return circuit.state === "open" || circuit.probeInFlight;
  }

  private open(circuit: MutableCircuit): void {
    circuit.state = "open";
    circuit.openedAt = this.now();
    circuit.halfOpenSuccesses = 0;
    circuit.probeInFlight = false;
  }
}
