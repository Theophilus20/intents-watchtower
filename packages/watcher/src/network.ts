import type { ObservationBatch } from "@watchtower/core";
import { ContractMirror, generateWatcherKey } from "@watchtower/core";
import type { EngineConfig } from "@watchtower/engine";
import { AggregatingSubmitter, MirrorSubmitter } from "./submitter.ts";
import { WatcherNode, type StepResult } from "./node.ts";

export interface LocalNetworkOptions {
  contractId?: string;
  watchers?: number;
  quorum?: number;
  escalationThreshold?: number;
  config?: EngineConfig;
  /** Make watcher #i see a tampered batch (to demonstrate disagreement). */
  tamper?: (watcherIndex: number, batch: ObservationBatch) => ObservationBatch;
  seed?: string;
}

/**
 * N independent watchers + the contract model, in one process. Each watcher runs its own
 * engine over the same observations and signs with its own key; a relayer batches signatures
 * into the mirror contract. This is exactly the production topology, minus the network.
 */
export class LocalNetwork {
  readonly mirror: ContractMirror;
  readonly watchers: WatcherNode[];
  private relayer: AggregatingSubmitter;

  constructor(readonly opts: LocalNetworkOptions = {}) {
    const n = opts.watchers ?? 3;
    const contractId = opts.contractId ?? "watchtower.near";
    this.mirror = new ContractMirror(contractId, opts.quorum ?? 2, opts.escalationThreshold ?? 1);
    this.relayer = new AggregatingSubmitter(new MirrorSubmitter(this.mirror), opts.quorum ?? 2);
    this.watchers = Array.from({ length: n }, (_, i) => {
      const seed = new Uint8Array(32);
      new TextEncoder().encodeInto(`${opts.seed ?? "watchtower"}-w${i + 1}`, seed);
      const key = generateWatcherKey(seed);
      const watcherId = `w${i + 1}.${contractId}`;
      this.mirror.addWatcher(watcherId, key.publicKey);
      return new WatcherNode({ watcherId, secretKey: key.secretKey, contractId, config: opts.config, submitter: this.relayer, refreshEpochs: 1 });
    });
  }

  async step(batch: ObservationBatch): Promise<StepResult[]> {
    this.mirror.nowMs = batch.asOfMs + 5_000;
    const out: StepResult[] = [];
    for (const [i, w] of this.watchers.entries()) out.push(await w.step(this.opts.tamper ? this.opts.tamper(i, structuredClone(batch)) : batch));
    await this.relayer.flush();
    return out;
  }
}
