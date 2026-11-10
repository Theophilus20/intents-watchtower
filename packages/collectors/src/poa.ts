import { jsonRpc, type HttpOptions } from "./http.ts";

/** PoA bridge JSON-RPC (POST https://bridge.chaindefuser.com/rpc). */
export interface PoaToken {
  defuse_asset_identifier: string;
  near_token_id: string;
  decimals: number;
  asset_name: string;
  min_deposit_amount: string;
  min_withdrawal_amount: string;
  withdrawal_fee: string;
}

export interface PoaDeposit {
  tx_hash?: string;
  chain: string;
  defuse_asset_identifier: string;
  decimals: number;
  amount: number | string;
  account_id: string;
  address: string;
  status: "PENDING" | "COMPLETED" | "FAILED";
}

export class PoaBridgeClient {
  constructor(readonly url = "https://bridge.chaindefuser.com/rpc", readonly http: HttpOptions = {}) {}

  async supportedTokens(chains?: string[]): Promise<PoaToken[]> {
    const r = await jsonRpc<{ tokens: PoaToken[] }>(this.url, "supported_tokens", [chains ? { chains } : {}], this.http);
    return r.tokens;
  }

  async recentDeposits(accountId: string, chain: string): Promise<PoaDeposit[]> {
    const r = await jsonRpc<{ deposits: PoaDeposit[] }>(this.url, "recent_deposits", [{ account_id: accountId, chain }], this.http);
    return r.deposits;
  }

  async withdrawalStatus(withdrawalHash: string): Promise<{ status: string; data?: Record<string, unknown> }> {
    return jsonRpc(this.url, "withdrawal_status", [{ withdrawal_hash: withdrawalHash }], this.http);
  }
}
