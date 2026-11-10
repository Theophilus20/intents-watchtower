/**
 * NEP-297 event parsing for the contracts Watchtower indexes:
 *  - bridge token contracts (NEP-141 ft_mint / ft_burn; NEP-245 mt_mint / mt_burn for multi-token bridges)
 *  - intents.near (DIP-4 token_diff for settled swaps; NEP-245 mt_* for balance moves)
 */
export interface Nep297<T = unknown> {
  standard: string;
  version: string;
  event: string;
  data: T[];
}

export function parseEventLog(log: string): Nep297 | null {
  if (!log.startsWith("EVENT_JSON:")) return null;
  try {
    const e = JSON.parse(log.slice("EVENT_JSON:".length)) as Nep297;
    if (typeof e.standard !== "string" || typeof e.event !== "string" || !Array.isArray(e.data)) return null;
    return e;
  } catch {
    return null;
  }
}

export interface FtMintBurn {
  owner_id: string;
  amount: string;
  memo?: string;
}

export interface FtTransfer {
  old_owner_id: string;
  new_owner_id: string;
  amount: string;
  memo?: string;
}

export interface MtMintBurn {
  owner_id: string;
  token_ids: string[];
  amounts: string[];
  memo?: string;
}

export interface TokenDiff {
  account_id: string;
  intent_hash: string;
  diff: Record<string, string>;
}
