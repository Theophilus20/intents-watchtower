import type { ComponentResult, RouteVerdict, Status } from "@watchtower/core";
import { DEFAULT_ASSETS, formatUsdCents, parseRoute, reasonCode, reasonSubject } from "@watchtower/core";

/**
 * Plain-language incident explanations.
 *
 * Rule 1: the AI explains, it never decides. Status comes from deterministic checks; this module
 * only turns a signed verdict into a sentence.
 * Rule 2: every number in the sentence must come from the facts. An AI answer that invents a
 * number, contradicts the status, or runs long is thrown away and the template is used instead.
 */

export type Lang = "en" | "zh" | "ja" | "ko" | "es" | "fr" | "pt" | "de" | "ru" | "tr" | "vi";
export const LANGS: Record<Lang, string> = { en: "English", zh: "Simplified Chinese", ja: "Japanese", ko: "Korean", es: "Spanish", fr: "French", pt: "Brazilian Portuguese", de: "German", ru: "Russian", tr: "Turkish", vi: "Vietnamese" };

export interface Facts {
  route: string;
  routeLabel: string;
  status: Status;
  codes: string[];
  /** Pre-formatted figures the sentence may use. */
  figures: {
    ghostUsd?: string;
    exitedUsd?: string;
    backingPct?: string;
    outflowX?: string;
    drainPct?: string;
    hhi?: string;
    topSharePct?: string;
    chain?: string;
    depegPrice?: string;
    /** Partly verified: how much the treasury is short ("2.2121 BTC"), and the day it was already short. */
    gapAmount?: string;
    sinceDate?: string;
  };
  evidence: string[];
}

function sym(asset: string): string {
  return asset.split(":")[0]!.toUpperCase();
}

function chainName(id: string): string {
  const names: Record<string, string> = { bitcoin: "Bitcoin", ethereum: "Ethereum", bsc: "BNB Chain", solana: "Solana", litecoin: "Litecoin", near: "NEAR" };
  return names[id] ?? id;
}

export function extractFacts(v: Pick<RouteVerdict, "route" | "status" | "reasons" | "components">): Facts {
  const r = parseRoute(v.route);
  const comp = (check: ComponentResult["check"]) => v.components.filter((c) => c.check === check && c.status !== "green");
  const f: Facts["figures"] = {};
  const big = (x: unknown) => BigInt(String(x ?? "0"));

  for (const g of comp("ghost")) {
    const ghost = big(g.metrics.ghost_usd_cents);
    const exited = big(g.metrics.exited_usd_cents);
    if (ghost > 0n) f.ghostUsd = formatUsdCents(ghost, { compact: true });
    if (exited > 0n) f.exitedUsd = formatUsdCents(exited, { compact: true });
    if (!f.ghostUsd && big(g.metrics.pending_usd_cents) > 0n) f.ghostUsd = formatUsdCents(big(g.metrics.pending_usd_cents), { compact: true });
  }
  for (const b of comp("backing")) {
    if (typeof b.metrics.backing_ppm === "number" && b.metrics.backing_ppm >= 0) f.backingPct = `${(b.metrics.backing_ppm / 10_000).toFixed(2)}%`;
    if (b.metrics.baseline_gap !== undefined) {
      const a = DEFAULT_ASSETS.find((x) => x.key === b.subject);
      const short = big(b.metrics.deficit);
      if (a) f.gapAmount = `${(Number(short / 10n ** BigInt(Math.max(0, a.decimals - 4))) / 10_000).toLocaleString("en-US", { maximumFractionDigits: 4 })} ${sym(a.key)}`;
      if (typeof b.metrics.partial_since_ms === "number") f.sinceDate = new Date(b.metrics.partial_since_ms).toISOString().slice(0, 10);
    }
  }
  for (const a of comp("anomaly")) {
    const mean = Number(a.metrics.baseline_mean_usd_cents ?? 0);
    const cur = Number(a.metrics.outflow_1h_usd_cents ?? 0);
    if (mean > 0 && cur > mean) f.outflowX = `${Math.round(cur / mean)}×`;
    const drop = Number(a.metrics.hot_wallet_drop_ppm ?? 0);
    if (drop > 0) f.drainPct = `${Math.round(drop / 10_000)}%`;
  }
  for (const c of comp("concentration")) {
    if (typeof c.metrics.hhi === "number") f.hhi = String(c.metrics.hhi);
    if (typeof c.metrics.top_solver_ppm === "number") f.topSharePct = `${Math.round(c.metrics.top_solver_ppm / 10_000)}%`;
  }
  for (const c of comp("chain")) f.chain = chainName(c.subject);
  for (const d of comp("depeg")) if (d.metrics.price_micro_usd) f.depegPrice = `$${(Number(d.metrics.price_micro_usd) / 1e6).toFixed(3)}`;

  const evidence = v.components.flatMap((c) => c.evidence.map((e) => e.ref)).slice(0, 5);
  let codes = [...new Set(v.reasons.map((x) => reasonCode(x)).filter((x): x is NonNullable<typeof x> => !!x && x !== "GHOST_UNCHECKED"))];
  // Liquidity concentration is context, not the headline, when something else is wrong.
  const CONC = new Set(["SOLVER_CONCENTRATED", "SINGLE_SOLVER_ROUTE", "THIN_DEPTH", "LOW_ACTIVITY"]);
  if (codes.some((c) => !CONC.has(c) && c !== "BASELINE_WARMING" && c !== "HYSTERESIS_HOLD")) codes = codes.filter((c) => !CONC.has(c));
  return { route: v.route, routeLabel: `${sym(r.src)} (${chainName(r.srcChain)}) → ${sym(r.dst)} (${chainName(r.dstChain)})`, status: v.status, codes, figures: f, evidence };
}

// ---------------------------------------------------------------------------------------------
// Deterministic templates
// ---------------------------------------------------------------------------------------------

type Phrase = (f: Facts["figures"], subject?: string) => string | null;
/** end: what follows the body before the closing advice; sp: what separates the head from the body. */
type Table = { head: Record<Status, (label: string) => string>; tail: Record<Status, string>; phrases: Record<string, Phrase>; join: string; end?: string; sp?: string };

const T: Record<Lang, Table> = {
  en: {
    head: { red: (l) => `🔴 ${l} paused.`, unknown: (l) => `⚪ ${l} unverified.`, amber: (l) => `🟡 ${l}: caution.`, green: (l) => `🟢 ${l} healthy.` },
    tail: { red: "Avoid this route until it turns green.", unknown: "We can't vouch for it right now, so treat it as unsafe.", amber: "Fine for small amounts; large swaps should wait.", green: "All checks passing." },
    join: ", and ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "Money"} credited with no matching deposit is already being withdrawn`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ?? "Some tokens"} were credited on NEAR with no matching deposit`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "A large credit"} is still waiting for its deposit`,
      BACKING_BELOW_THRESHOLD: (f) => `only ${f.backingPct ?? "part"} of credited funds are backed`,
      BACKING_DROP_FAST: (f) => `backing is falling fast${f.backingPct ? ` (now ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `backing is a hair under 100%${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `withdrawals are running ${f.outflowX ?? "far"} above normal`,
      HOT_WALLET_DRAIN: (f) => `the bridge hot wallet lost ${f.drainPct ?? "a large share"} in minutes`,
      FRESH_ACCOUNT_EXIT: () => `brand-new accounts are withdrawing large amounts`,
      MINT_THEN_EXIT: () => `funds are being credited and pulled out within minutes`,
      SINGLE_SOLVER_ROUTE: (f) => `one solver fills ${f.topSharePct ?? "almost all"} of this route`,
      SOLVER_CONCENTRATED: (f) => `liquidity is concentrated (top solver ${f.topSharePct ?? "dominant"})`,
      CHAIN_ADVISORY: (f) => `a security advisory is active for ${f.chain ?? "a connected chain"}`,
      CHAIN_STALLED: (f) => `${f.chain ?? "a connected chain"} has stopped producing blocks`,
      CHAIN_SLOW: (f) => `${f.chain ?? "a connected chain"} is producing blocks slowly`,
      CHAIN_REORG: (f) => `${f.chain ?? "a connected chain"} rewrote recent blocks`,
      ASSET_DEPEG: (f) => `a stablecoin on this route trades at ${f.depegPrice ?? "well under $1"}`,
      CUSTODY_DATA_STALE: () => `we can't see the home-chain custody balance`,
      CUSTODY_NOT_CONFIGURED: () => `we don't know yet where the bridge keeps its funds`,
      BACKING_PARTIAL: (f) => `the bridge's treasury holds only ${f.backingPct ?? "part"} of what users are owed (${f.gapAmount ?? "some"} short, already short on ${f.sinceDate ?? "the first day we checked"})`,
      BACKING_GAP_GROWN: (f) => `the bridge's treasury shortfall has grown to ${f.gapAmount ?? "more than usual"}`,
      CHAIN_DATA_STALE: (f) => `we can't currently read ${f.chain ?? "a connected chain"}`,
    },
  },
  fr: {
    head: { red: (l) => `🔴 ${l} suspendue.`, unknown: (l) => `⚪ ${l} non vérifiée.`, amber: (l) => `🟡 ${l} : prudence.`, green: (l) => `🟢 ${l} en bonne santé.` },
    tail: { red: "Évitez cette route jusqu'à son retour au vert.", unknown: "Considérez-la comme risquée pour l'instant.", amber: "Les petits montants passent ; les gros swaps devraient attendre.", green: "Tous les contrôles sont au vert." },
    join: ", et ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "des fonds"} crédités sans dépôt sont déjà retirés`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ?? "des jetons"} ont été crédités sur NEAR sans dépôt correspondant`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "un gros crédit"} attend encore son dépôt`,
      BACKING_BELOW_THRESHOLD: (f) => `seulement ${f.backingPct ?? "une partie"} des fonds crédités sont couverts`,
      BACKING_DROP_FAST: () => `la couverture chute rapidement`,
      BACKING_TOLERANCE: () => `la couverture est juste sous 100 %`,
      OUTFLOW_SPIKE: (f) => `les retraits sont ${f.outflowX ?? "bien"} au-dessus de la normale`,
      HOT_WALLET_DRAIN: (f) => `le hot wallet du pont a perdu ${f.drainPct ?? "beaucoup"} en quelques minutes`,
      FRESH_ACCOUNT_EXIT: () => `des comptes tout neufs retirent de gros montants`,
      MINT_THEN_EXIT: () => `des fonds sont crédités puis retirés en quelques minutes`,
      SINGLE_SOLVER_ROUTE: (f) => `un seul solveur assure ${f.topSharePct ?? "presque tout"} de cette route`,
      SOLVER_CONCENTRATED: () => `la liquidité est concentrée sur peu de solveurs`,
      CHAIN_ADVISORY: (f) => `une alerte de sécurité vise ${f.chain ?? "une chaîne connectée"}`,
      CHAIN_STALLED: (f) => `${f.chain ?? "une chaîne connectée"} ne produit plus de blocs`,
      CHAIN_SLOW: (f) => `${f.chain ?? "une chaîne connectée"} ralentit`,
      CHAIN_REORG: (f) => `${f.chain ?? "une chaîne connectée"} a réorganisé des blocs récents`,
      ASSET_DEPEG: (f) => `un stablecoin de cette route vaut ${f.depegPrice ?? "moins de 1 $"}`,
      CUSTODY_DATA_STALE: () => `nous ne voyons plus le solde de garde`,
      CUSTODY_NOT_CONFIGURED: () => `nous ne savons pas encore où le pont garde ses fonds`,
      BACKING_PARTIAL: (f) => `la trésorerie du pont ne détient que ${f.backingPct ?? "une partie"} de ce qui est dû aux utilisateurs (il manque ${f.gapAmount ?? "une partie"}, déjà manquants le ${f.sinceDate ?? "premier jour vérifié"})`,
      BACKING_GAP_GROWN: (f) => `le manque dans la trésorerie du pont a grandi jusqu'à ${f.gapAmount ?? "un niveau inhabituel"}`,
      CHAIN_DATA_STALE: (f) => `nous ne pouvons plus lire ${f.chain ?? "une chaîne"}`,
    },
  },
  es: {
    head: { red: (l) => `🔴 ${l} en pausa.`, unknown: (l) => `⚪ ${l} sin verificar.`, amber: (l) => `🟡 ${l}: precaución.`, green: (l) => `🟢 ${l} saludable.` },
    tail: { red: "Evita esta ruta hasta que vuelva a verde.", unknown: "Trátala como insegura por ahora.", amber: "Montos pequeños sí; los swaps grandes deberían esperar.", green: "Todos los controles en verde." },
    join: ", y ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "fondos"} acreditados sin depósito ya se están retirando`,
      GHOST_CREDIT: (f) => `se acreditaron ${f.ghostUsd ?? "tokens"} en NEAR sin depósito correspondiente`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "un crédito grande"} aún espera su depósito`,
      BACKING_BELOW_THRESHOLD: (f) => `solo el ${f.backingPct ?? "parte"} de los fondos acreditados está respaldado`,
      BACKING_DROP_FAST: () => `el respaldo cae rápido`,
      BACKING_TOLERANCE: () => `el respaldo está apenas bajo el 100 %`,
      OUTFLOW_SPIKE: (f) => `los retiros van ${f.outflowX ?? "muy"} por encima de lo normal`,
      HOT_WALLET_DRAIN: (f) => `la hot wallet del puente perdió ${f.drainPct ?? "mucho"} en minutos`,
      FRESH_ACCOUNT_EXIT: () => `cuentas recién creadas retiran montos grandes`,
      MINT_THEN_EXIT: () => `se acreditan fondos y se retiran en minutos`,
      SINGLE_SOLVER_ROUTE: (f) => `un solo solver cubre ${f.topSharePct ?? "casi todo"} de esta ruta`,
      SOLVER_CONCENTRATED: () => `la liquidez está concentrada en pocos solvers`,
      CHAIN_ADVISORY: (f) => `hay una alerta de seguridad para ${f.chain ?? "una cadena conectada"}`,
      CHAIN_STALLED: (f) => `${f.chain ?? "una cadena conectada"} dejó de producir bloques`,
      CHAIN_SLOW: (f) => `${f.chain ?? "una cadena conectada"} va lenta`,
      CHAIN_REORG: (f) => `${f.chain ?? "una cadena conectada"} reescribió bloques recientes`,
      ASSET_DEPEG: (f) => `una stablecoin de esta ruta cotiza a ${f.depegPrice ?? "menos de $1"}`,
      CUSTODY_DATA_STALE: () => `perdimos de vista el saldo en custodia`,
      CUSTODY_NOT_CONFIGURED: () => `aún no sabemos dónde guarda el puente sus fondos`,
      BACKING_PARTIAL: (f) => `la tesorería del puente solo tiene el ${f.backingPct ?? "parte"} de lo que se debe a los usuarios (faltan ${f.gapAmount ?? "fondos"}, ya faltaban el ${f.sinceDate ?? "primer día revisado"})`,
      BACKING_GAP_GROWN: (f) => `el faltante en la tesorería del puente creció a ${f.gapAmount ?? "un nivel inusual"}`,
      CHAIN_DATA_STALE: (f) => `no podemos leer ${f.chain ?? "una cadena"} ahora`,
    },
  },

  zh: {
    head: { red: (l) => `🔴 ${l} 已暂停。`, unknown: (l) => `⚪ ${l} 无法验证。`, amber: (l) => `🟡 ${l}：请谨慎。`, green: (l) => `🟢 ${l} 运行正常。` },
    tail: { red: "在恢复为绿色之前，请勿使用此路线。", unknown: "目前无法为其担保，请视为不安全。", amber: "小额可以，大额兑换请稍后再进行。", green: "所有检查均已通过。" },
    join: "；", end: "。", sp: "",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `没有对应存款却已入账的${f.exitedUsd ?? f.ghostUsd ? ` ${f.exitedUsd ?? f.ghostUsd} ` : "资金"}正在被提走`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ? `${f.ghostUsd} ` : "部分代币"}在 NEAR 上入账，但没有对应的存款`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ? `${f.ghostUsd} 的大额入账` : "一笔大额入账"}仍在等待对应的存款`,
      BACKING_BELOW_THRESHOLD: (f) => `已入账的资金只有 ${f.backingPct ?? "一部分"} 有储备支持`,
      BACKING_DROP_FAST: (f) => `储备率正在快速下降${f.backingPct ? `（目前 ${f.backingPct}）` : ""}`,
      BACKING_TOLERANCE: (f) => `储备率略低于 100%${f.backingPct ? `（${f.backingPct}）` : ""}`,
      OUTFLOW_SPIKE: (f) => `提款量远高于正常水平${f.outflowX ? `（${f.outflowX}）` : ""}`,
      HOT_WALLET_DRAIN: (f) => `跨链桥热钱包在几分钟内损失了${f.drainPct ? ` ${f.drainPct} 的余额` : "大部分余额"}`,
      FRESH_ACCOUNT_EXIT: () => `新建的账户正在提取大额资金`,
      MINT_THEN_EXIT: () => `资金入账后几分钟内就被转出`,
      SINGLE_SOLVER_ROUTE: (f) => `单个做市方完成了此路线${f.topSharePct ? ` ${f.topSharePct} ` : "几乎全部"}的成交`,
      SOLVER_CONCENTRATED: (f) => `流动性集中在少数做市方手中${f.topSharePct ? `（最大一方占 ${f.topSharePct}）` : ""}`,
      CHAIN_ADVISORY: (f) => `${f.chain ? `${f.chain} ` : "一条关联链"}有生效中的安全警报`,
      CHAIN_STALLED: (f) => `${f.chain ? `${f.chain} ` : "一条关联链"}已停止出块`,
      CHAIN_SLOW: (f) => `${f.chain ? `${f.chain} ` : "一条关联链"}出块缓慢`,
      CHAIN_REORG: (f) => `${f.chain ? `${f.chain} ` : "一条关联链"}重写了最近的区块`,
      ASSET_DEPEG: (f) => `此路线上的一种稳定币交易价格为${f.depegPrice ? ` ${f.depegPrice}` : "明显低于 1 美元"}`,
      CUSTODY_DATA_STALE: () => `我们暂时看不到原链上的托管余额`,
      CUSTODY_NOT_CONFIGURED: () => `我们还不知道跨链桥把资金存放在哪里`,
      BACKING_PARTIAL: (f) => `跨链桥金库只持有应付用户资产的 ${f.backingPct ?? "一部分"}（缺少 ${f.gapAmount ?? "一部分"}，${f.sinceDate ?? "我们首次检查时"} 就已短缺）`,
      BACKING_GAP_GROWN: (f) => `跨链桥金库的缺口已扩大到 ${f.gapAmount ?? "异常水平"}`,
      CHAIN_DATA_STALE: (f) => `我们目前无法读取${f.chain ? ` ${f.chain} ` : "一条链"}的数据`,
    },
  },
  ja: {
    head: { red: (l) => `🔴 ${l} は停止中です。`, unknown: (l) => `⚪ ${l} は検証できません。`, amber: (l) => `🟡 ${l}：注意。`, green: (l) => `🟢 ${l} は正常です。` },
    tail: { red: "緑に戻るまで、このルートは使わないでください。", unknown: "現時点では保証できないため、安全でないものとして扱ってください。", amber: "少額なら問題ありませんが、大口のスワップは待ってください。", green: "すべてのチェックに合格しています。" },
    join: "。さらに、", end: "。", sp: "",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `対応する入金のない${f.exitedUsd ?? f.ghostUsd ? ` ${f.exitedUsd ?? f.ghostUsd} ` : "資金"}がすでに引き出されています`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ? `${f.ghostUsd} ` : "一部のトークン"}が対応する入金なしで NEAR に記帳されました`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ? `${f.ghostUsd} ` : "大口の記帳"}がまだ入金を待っています`,
      BACKING_BELOW_THRESHOLD: (f) => `記帳された資金のうち裏付けがあるのは ${f.backingPct ?? "一部"} だけです`,
      BACKING_DROP_FAST: (f) => `裏付け率が急速に低下しています${f.backingPct ? `（現在 ${f.backingPct}）` : ""}`,
      BACKING_TOLERANCE: (f) => `裏付け率が 100% をわずかに下回っています${f.backingPct ? `（${f.backingPct}）` : ""}`,
      OUTFLOW_SPIKE: (f) => `出金が通常より大幅に多くなっています${f.outflowX ? `（${f.outflowX}）` : ""}`,
      HOT_WALLET_DRAIN: (f) => `ブリッジのホットウォレットが数分で${f.drainPct ? ` ${f.drainPct} ` : "大部分"}を失いました`,
      FRESH_ACCOUNT_EXIT: () => `作成されたばかりのアカウントが大口の出金をしています`,
      MINT_THEN_EXIT: () => `資金が記帳されて数分以内に引き出されています`,
      SINGLE_SOLVER_ROUTE: (f) => `このルートの${f.topSharePct ? ` ${f.topSharePct} ` : "ほぼすべて"}を1つのソルバーが約定しています`,
      SOLVER_CONCENTRATED: (f) => `流動性が少数のソルバーに集中しています${f.topSharePct ? `（最大 ${f.topSharePct}）` : ""}`,
      CHAIN_ADVISORY: (f) => `${f.chain ?? "接続先のチェーン"}にセキュリティ警告が出ています`,
      CHAIN_STALLED: (f) => `${f.chain ?? "接続先のチェーン"}がブロックの生成を停止しました`,
      CHAIN_SLOW: (f) => `${f.chain ?? "接続先のチェーン"}のブロック生成が遅くなっています`,
      CHAIN_REORG: (f) => `${f.chain ?? "接続先のチェーン"}で直近のブロックが書き換えられました`,
      ASSET_DEPEG: (f) => `このルートのステーブルコインが${f.depegPrice ? ` ${f.depegPrice} ` : "1ドルを大きく下回る価格"}で取引されています`,
      CUSTODY_DATA_STALE: () => `元のチェーンの保管残高を確認できなくなっています`,
      CUSTODY_NOT_CONFIGURED: () => `ブリッジが資金をどこに保管しているかはまだ分かっていません`,
      BACKING_PARTIAL: (f) => `ブリッジの金庫が保有しているのは、利用者に支払うべき額の ${f.backingPct ?? "一部"} だけです（${f.gapAmount ?? "一部"} 不足、${f.sinceDate ?? "最初の確認時"} には既に不足）`,
      BACKING_GAP_GROWN: (f) => `ブリッジの金庫の不足額が ${f.gapAmount ?? "通常を超える水準"} に拡大しました`,
      CHAIN_DATA_STALE: (f) => `現在 ${f.chain ?? "チェーン"} を読み取れません`,
    },
  },
  ko: {
    head: { red: (l) => `🔴 ${l} 일시 중지.`, unknown: (l) => `⚪ ${l} 확인 불가.`, amber: (l) => `🟡 ${l}: 주의.`, green: (l) => `🟢 ${l} 정상.` },
    tail: { red: "초록색으로 돌아올 때까지 이 경로를 사용하지 마세요.", unknown: "지금은 보증할 수 없으니 안전하지 않은 것으로 간주하세요.", amber: "소액은 괜찮지만 큰 금액의 스왑은 기다리세요.", green: "모든 검사를 통과했습니다." },
    join: ". 또한 ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `입금 없이 기록된 자금${f.exitedUsd ?? f.ghostUsd ? ` ${f.exitedUsd ?? f.ghostUsd}` : ""}이 이미 인출되고 있습니다`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ? `${f.ghostUsd} 상당의 토큰` : "일부 토큰"}이 대응하는 입금 없이 NEAR에 기록되었습니다`,
      GHOST_CREDIT_PENDING: (f) => `큰 금액의 기록${f.ghostUsd ? ` ${f.ghostUsd}` : ""}이 아직 입금을 기다리고 있습니다`,
      BACKING_BELOW_THRESHOLD: (f) => `기록된 자금 중 ${f.backingPct ?? "일부"}만 담보되어 있습니다`,
      BACKING_DROP_FAST: (f) => `담보 비율이 빠르게 떨어지고 있습니다${f.backingPct ? ` (현재 ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `담보 비율이 100%를 약간 밑돌고 있습니다${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `인출이 평소보다 훨씬 많습니다${f.outflowX ? ` (${f.outflowX})` : ""}`,
      HOT_WALLET_DRAIN: (f) => `브리지 핫월렛이 몇 분 만에 잔액의 ${f.drainPct ?? "상당 부분"}을 잃었습니다`,
      FRESH_ACCOUNT_EXIT: () => `새로 만든 계정들이 큰 금액을 인출하고 있습니다`,
      MINT_THEN_EXIT: () => `자금이 기록된 지 몇 분 만에 빠져나가고 있습니다`,
      SINGLE_SOLVER_ROUTE: (f) => `솔버 하나가 이 경로의 ${f.topSharePct ?? "거의 전부"}를 체결하고 있습니다`,
      SOLVER_CONCENTRATED: (f) => `유동성이 소수의 솔버에 집중되어 있습니다${f.topSharePct ? ` (최대 ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `${f.chain ?? "연결된 체인"}에 보안 경고가 발령되어 있습니다`,
      CHAIN_STALLED: (f) => `${f.chain ?? "연결된 체인"}의 블록 생성이 멈췄습니다`,
      CHAIN_SLOW: (f) => `${f.chain ?? "연결된 체인"}의 블록 생성이 느립니다`,
      CHAIN_REORG: (f) => `${f.chain ?? "연결된 체인"}에서 최근 블록이 다시 쓰였습니다`,
      ASSET_DEPEG: (f) => `이 경로의 스테이블코인이 ${f.depegPrice ?? "1달러보다 크게 낮은 가격"}에 거래되고 있습니다`,
      CUSTODY_DATA_STALE: () => `원래 체인의 보관 잔액을 확인할 수 없습니다`,
      CUSTODY_NOT_CONFIGURED: () => `브리지가 자금을 어디에 보관하는지 아직 모릅니다`,
      BACKING_PARTIAL: (f) => `브리지 금고는 사용자에게 지급해야 할 금액의 ${f.backingPct ?? "일부"}만 보유하고 있습니다(${f.gapAmount ?? "일부"} 부족, ${f.sinceDate ?? "처음 확인한 날"}에도 이미 부족)`,
      BACKING_GAP_GROWN: (f) => `브리지 금고의 부족분이 ${f.gapAmount ?? "평소보다 큰 수준"}으로 커졌습니다`,
      CHAIN_DATA_STALE: (f) => `지금은 ${f.chain ?? "체인"} 데이터를 읽을 수 없습니다`,
    },
  },
  pt: {
    head: { red: (l) => `🔴 ${l} pausada.`, unknown: (l) => `⚪ ${l} não verificada.`, amber: (l) => `🟡 ${l}: cautela.`, green: (l) => `🟢 ${l} saudável.` },
    tail: { red: "Evite esta rota até ela voltar ao verde.", unknown: "Não podemos garanti-la agora; trate-a como insegura.", amber: "Valores pequenos tudo bem; swaps grandes devem esperar.", green: "Todas as verificações passaram." },
    join: ", e ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "fundos"} creditados sem depósito correspondente já estão sendo sacados`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ?? "alguns tokens"} foram creditados na NEAR sem depósito correspondente`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "um crédito grande"} ainda aguarda o depósito`,
      BACKING_BELOW_THRESHOLD: (f) => `só ${f.backingPct ?? "parte"} dos fundos creditados tem lastro`,
      BACKING_DROP_FAST: (f) => `o lastro está caindo rápido${f.backingPct ? ` (agora ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `o lastro está um pouco abaixo de 100%${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `os saques estão ${f.outflowX ?? "muito"} acima do normal`,
      HOT_WALLET_DRAIN: (f) => `a hot wallet da ponte perdeu ${f.drainPct ?? "boa parte do saldo"} em minutos`,
      FRESH_ACCOUNT_EXIT: () => `contas recém-criadas estão sacando valores altos`,
      MINT_THEN_EXIT: () => `fundos estão sendo creditados e retirados em minutos`,
      SINGLE_SOLVER_ROUTE: (f) => `um único solver executa ${f.topSharePct ?? "quase tudo"} desta rota`,
      SOLVER_CONCENTRATED: (f) => `a liquidez está concentrada em poucos solvers${f.topSharePct ? ` (o maior tem ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `há um alerta de segurança ativo para ${f.chain ?? "uma rede conectada"}`,
      CHAIN_STALLED: (f) => `${f.chain ?? "uma rede conectada"} parou de produzir blocos`,
      CHAIN_SLOW: (f) => `${f.chain ?? "uma rede conectada"} está produzindo blocos devagar`,
      CHAIN_REORG: (f) => `${f.chain ?? "uma rede conectada"} reescreveu blocos recentes`,
      ASSET_DEPEG: (f) => `uma stablecoin desta rota está cotada a ${f.depegPrice ?? "bem menos de US$ 1"}`,
      CUSTODY_DATA_STALE: () => `perdemos de vista o saldo em custódia na rede de origem`,
      CUSTODY_NOT_CONFIGURED: () => `ainda não sabemos onde a ponte guarda os fundos`,
      BACKING_PARTIAL: (f) => `a tesouraria da ponte tem só ${f.backingPct ?? "parte"} do que é devido aos usuários (faltam ${f.gapAmount ?? "fundos"}, já faltavam em ${f.sinceDate ?? "o primeiro dia verificado"})`,
      BACKING_GAP_GROWN: (f) => `o déficit na tesouraria da ponte cresceu para ${f.gapAmount ?? "um nível incomum"}`,
      CHAIN_DATA_STALE: (f) => `não conseguimos ler ${f.chain ?? "uma rede"} agora`,
    },
  },
  de: {
    head: { red: (l) => `🔴 ${l} pausiert.`, unknown: (l) => `⚪ ${l} nicht überprüfbar.`, amber: (l) => `🟡 ${l}: Vorsicht.`, green: (l) => `🟢 ${l} in Ordnung.` },
    tail: { red: "Diese Route meiden, bis sie wieder grün ist.", unknown: "Wir können sie gerade nicht bestätigen, also gilt sie als unsicher.", amber: "Kleine Beträge gehen; große Swaps sollten warten.", green: "Alle Prüfungen bestanden." },
    join: ", und ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "Geld"}, ohne passende Einzahlung gutgeschrieben, wird bereits abgezogen`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ?? "einige Token"} wurden auf NEAR ohne passende Einzahlung gutgeschrieben`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "eine große Gutschrift"} wartet noch auf die Einzahlung`,
      BACKING_BELOW_THRESHOLD: (f) => `nur ${f.backingPct ?? "ein Teil"} der gutgeschriebenen Mittel ist gedeckt`,
      BACKING_DROP_FAST: (f) => `die Deckung fällt schnell${f.backingPct ? ` (jetzt ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `die Deckung liegt knapp unter 100 %${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `Abhebungen liegen ${f.outflowX ?? "weit"} über dem Normalwert`,
      HOT_WALLET_DRAIN: (f) => `das Hot Wallet der Bridge hat in Minuten ${f.drainPct ?? "einen großen Teil"} verloren`,
      FRESH_ACCOUNT_EXIT: () => `ganz neue Konten heben große Beträge ab`,
      MINT_THEN_EXIT: () => `Mittel werden gutgeschrieben und binnen Minuten abgezogen`,
      SINGLE_SOLVER_ROUTE: (f) => `ein einziger Solver füllt ${f.topSharePct ?? "fast alles"} dieser Route`,
      SOLVER_CONCENTRATED: (f) => `die Liquidität liegt bei wenigen Solvern${f.topSharePct ? ` (größter: ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `für ${f.chain ?? "eine verbundene Chain"} gilt eine Sicherheitswarnung`,
      CHAIN_STALLED: (f) => `${f.chain ?? "eine verbundene Chain"} produziert keine Blöcke mehr`,
      CHAIN_SLOW: (f) => `${f.chain ?? "eine verbundene Chain"} produziert Blöcke nur langsam`,
      CHAIN_REORG: (f) => `${f.chain ?? "eine verbundene Chain"} hat jüngste Blöcke umgeschrieben`,
      ASSET_DEPEG: (f) => `ein Stablecoin auf dieser Route handelt bei ${f.depegPrice ?? "deutlich unter 1 $"}`,
      CUSTODY_DATA_STALE: () => `wir sehen den Verwahrungssaldo auf der Ursprungschain nicht mehr`,
      CUSTODY_NOT_CONFIGURED: () => `wir wissen noch nicht, wo die Bridge ihre Mittel verwahrt`,
      BACKING_PARTIAL: (f) => `die Treasury der Bridge hält nur ${f.backingPct ?? "einen Teil"} dessen, was den Nutzern zusteht (es fehlen ${f.gapAmount ?? "Mittel"}, schon am ${f.sinceDate ?? "ersten geprüften Tag"})`,
      BACKING_GAP_GROWN: (f) => `die Lücke in der Treasury der Bridge ist auf ${f.gapAmount ?? "ein ungewöhnliches Maß"} gewachsen`,
      CHAIN_DATA_STALE: (f) => `wir können ${f.chain ?? "eine Chain"} gerade nicht lesen`,
    },
  },
  ru: {
    head: { red: (l) => `🔴 ${l}: приостановлен.`, unknown: (l) => `⚪ ${l}: не проверен.`, amber: (l) => `🟡 ${l}: осторожно.`, green: (l) => `🟢 ${l}: в порядке.` },
    tail: { red: "Не используйте этот маршрут, пока он не станет зелёным.", unknown: "Сейчас мы не можем за него поручиться, считайте его небезопасным.", amber: "Небольшие суммы можно; крупные обмены лучше отложить.", green: "Все проверки пройдены." },
    join: ", и ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `средства, зачисленные без депозита${f.exitedUsd ?? f.ghostUsd ? ` (${f.exitedUsd ?? f.ghostUsd})` : ""}, уже выводятся`,
      GHOST_CREDIT: (f) => `в NEAR зачислено ${f.ghostUsd ?? "некоторое количество токенов"} без соответствующего депозита`,
      GHOST_CREDIT_PENDING: (f) => `крупное зачисление${f.ghostUsd ? ` (${f.ghostUsd})` : ""} всё ещё ждёт своего депозита`,
      BACKING_BELOW_THRESHOLD: (f) => `обеспечено только ${f.backingPct ?? "часть"} зачисленных средств`,
      BACKING_DROP_FAST: (f) => `обеспечение быстро падает${f.backingPct ? ` (сейчас ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `обеспечение чуть ниже 100%${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `вывод средств намного выше нормы${f.outflowX ? ` (${f.outflowX})` : ""}`,
      HOT_WALLET_DRAIN: (f) => `горячий кошелёк моста за минуты потерял ${f.drainPct ?? "большую часть средств"}`,
      FRESH_ACCOUNT_EXIT: () => `только что созданные аккаунты выводят крупные суммы`,
      MINT_THEN_EXIT: () => `средства зачисляются и выводятся в течение нескольких минут`,
      SINGLE_SOLVER_ROUTE: (f) => `один солвер исполняет ${f.topSharePct ?? "почти все"} сделок на этом маршруте`,
      SOLVER_CONCENTRATED: (f) => `ликвидность сосредоточена у немногих солверов${f.topSharePct ? ` (у крупнейшего ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `для сети ${f.chain ?? "маршрута"} действует предупреждение безопасности`,
      CHAIN_STALLED: (f) => `сеть ${f.chain ?? "маршрута"} перестала производить блоки`,
      CHAIN_SLOW: (f) => `сеть ${f.chain ?? "маршрута"} медленно производит блоки`,
      CHAIN_REORG: (f) => `сеть ${f.chain ?? "маршрута"} переписала недавние блоки`,
      ASSET_DEPEG: (f) => `стейблкоин на этом маршруте торгуется по ${f.depegPrice ?? "цене заметно ниже $1"}`,
      CUSTODY_DATA_STALE: () => `мы потеряли из виду баланс хранения в исходной сети`,
      CUSTODY_NOT_CONFIGURED: () => `мы пока не знаем, где мост хранит средства`,
      BACKING_PARTIAL: (f) => `казна моста хранит только ${f.backingPct ?? "часть"} того, что причитается пользователям (не хватает ${f.gapAmount ?? "части"}, нехватка была уже ${f.sinceDate ?? "в первый день проверки"})`,
      BACKING_GAP_GROWN: (f) => `нехватка в казне моста выросла до ${f.gapAmount ?? "необычного уровня"}`,
      CHAIN_DATA_STALE: (f) => `сейчас мы не можем прочитать данные сети${f.chain ? ` ${f.chain}` : ""}`,
    },
  },
  tr: {
    head: { red: (l) => `🔴 ${l} durduruldu.`, unknown: (l) => `⚪ ${l} doğrulanamıyor.`, amber: (l) => `🟡 ${l}: dikkat.`, green: (l) => `🟢 ${l} sağlıklı.` },
    tail: { red: "Yeşile dönene kadar bu rotayı kullanmayın.", unknown: "Şu an buna kefil olamıyoruz; güvensiz kabul edin.", amber: "Küçük tutarlar olur; büyük takaslar beklemeli.", green: "Tüm kontroller geçti." },
    join: " ve ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `karşılık gelen bir yatırma olmadan kaydedilen ${f.exitedUsd ?? f.ghostUsd ?? "fonlar"} şimdiden çekiliyor`,
      GHOST_CREDIT: (f) => `NEAR'da karşılık gelen bir yatırma olmadan ${f.ghostUsd ?? "bazı tokenler"} kaydedildi`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "büyük bir kayıt"} hâlâ yatırmasını bekliyor`,
      BACKING_BELOW_THRESHOLD: (f) => `kaydedilen fonların yalnızca ${f.backingPct ?? "bir kısmı"} karşılıklı`,
      BACKING_DROP_FAST: (f) => `karşılık oranı hızla düşüyor${f.backingPct ? ` (şu an ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `karşılık oranı %100'ün biraz altında${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `çekimler normalin çok üzerinde${f.outflowX ? ` (${f.outflowX})` : ""}`,
      HOT_WALLET_DRAIN: (f) => `köprünün sıcak cüzdanı dakikalar içinde ${f.drainPct ? `bakiyesinin ${f.drainPct}'ini` : "büyük bir kısmını"} kaybetti`,
      FRESH_ACCOUNT_EXIT: () => `yeni açılmış hesaplar büyük tutarlar çekiyor`,
      MINT_THEN_EXIT: () => `fonlar kaydedilip dakikalar içinde çıkarılıyor`,
      SINGLE_SOLVER_ROUTE: (f) => `bu rotanın ${f.topSharePct ? `${f.topSharePct}'ini` : "neredeyse tamamını"} tek bir solver dolduruyor`,
      SOLVER_CONCENTRATED: (f) => `likidite birkaç solver'da yoğunlaşmış${f.topSharePct ? ` (en büyüğü ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `${f.chain ?? "bağlı bir ağ"} için aktif bir güvenlik uyarısı var`,
      CHAIN_STALLED: (f) => `${f.chain ?? "bağlı bir ağ"} blok üretmeyi durdurdu`,
      CHAIN_SLOW: (f) => `${f.chain ?? "bağlı bir ağ"} blokları yavaş üretiyor`,
      CHAIN_REORG: (f) => `${f.chain ?? "bağlı bir ağ"} son blokları yeniden yazdı`,
      ASSET_DEPEG: (f) => `bu rotadaki bir stablecoin ${f.depegPrice ?? "1 doların epey altında"} fiyattan işlem görüyor`,
      CUSTODY_DATA_STALE: () => `kaynak ağdaki saklama bakiyesini göremiyoruz`,
      CUSTODY_NOT_CONFIGURED: () => `köprünün fonları nerede tuttuğunu henüz bilmiyoruz`,
      BACKING_PARTIAL: (f) => `köprünün hazinesi kullanıcılara borçlu olunanın yalnızca ${f.backingPct ?? "bir kısmını"} tutuyor (${f.gapAmount ?? "bir kısım"} eksik, ${f.sinceDate ?? "ilk kontrol gününde"} de eksikti)`,
      BACKING_GAP_GROWN: (f) => `köprü hazinesindeki açık ${f.gapAmount ?? "olağandışı bir düzeye"} büyüdü`,
      CHAIN_DATA_STALE: (f) => `şu an ${f.chain ?? "bir ağın"} verilerini okuyamıyoruz`,
    },
  },
  vi: {
    head: { red: (l) => `🔴 ${l} tạm dừng.`, unknown: (l) => `⚪ ${l} chưa xác minh được.`, amber: (l) => `🟡 ${l}: cần thận trọng.`, green: (l) => `🟢 ${l} hoạt động bình thường.` },
    tail: { red: "Tránh tuyến này cho đến khi nó chuyển lại màu xanh.", unknown: "Hiện chúng tôi không thể bảo đảm, hãy coi là không an toàn.", amber: "Số tiền nhỏ thì được; giao dịch lớn nên chờ.", green: "Mọi kiểm tra đều đạt." },
    join: ", và ",
    phrases: {
      GHOST_CREDIT_WITHDRAWN: (f) => `${f.exitedUsd ?? f.ghostUsd ?? "tiền"} được ghi có mà không có khoản nạp tương ứng đang bị rút ra`,
      GHOST_CREDIT: (f) => `${f.ghostUsd ?? "một số token"} đã được ghi có trên NEAR mà không có khoản nạp tương ứng`,
      GHOST_CREDIT_PENDING: (f) => `${f.ghostUsd ?? "một khoản ghi có lớn"} vẫn đang chờ khoản nạp`,
      BACKING_BELOW_THRESHOLD: (f) => `chỉ ${f.backingPct ?? "một phần"} số tiền đã ghi có được bảo chứng`,
      BACKING_DROP_FAST: (f) => `tỷ lệ bảo chứng đang giảm nhanh${f.backingPct ? ` (hiện ${f.backingPct})` : ""}`,
      BACKING_TOLERANCE: (f) => `tỷ lệ bảo chứng hơi dưới 100%${f.backingPct ? ` (${f.backingPct})` : ""}`,
      OUTFLOW_SPIKE: (f) => `lượng rút đang cao hơn nhiều so với bình thường${f.outflowX ? ` (${f.outflowX})` : ""}`,
      HOT_WALLET_DRAIN: (f) => `ví nóng của cầu mất ${f.drainPct ?? "phần lớn số dư"} chỉ trong vài phút`,
      FRESH_ACCOUNT_EXIT: () => `các tài khoản mới tạo đang rút số tiền lớn`,
      MINT_THEN_EXIT: () => `tiền được ghi có rồi rút ra chỉ trong vài phút`,
      SINGLE_SOLVER_ROUTE: (f) => `một solver khớp ${f.topSharePct ?? "gần như toàn bộ"} giao dịch của tuyến này`,
      SOLVER_CONCENTRATED: (f) => `thanh khoản tập trung vào vài solver${f.topSharePct ? ` (lớn nhất ${f.topSharePct})` : ""}`,
      CHAIN_ADVISORY: (f) => `đang có cảnh báo bảo mật cho ${f.chain ?? "một chuỗi liên quan"}`,
      CHAIN_STALLED: (f) => `${f.chain ?? "một chuỗi liên quan"} đã ngừng tạo khối`,
      CHAIN_SLOW: (f) => `${f.chain ?? "một chuỗi liên quan"} đang tạo khối chậm`,
      CHAIN_REORG: (f) => `${f.chain ?? "một chuỗi liên quan"} đã viết lại các khối gần đây`,
      ASSET_DEPEG: (f) => `một stablecoin trên tuyến này đang giao dịch ở ${f.depegPrice ?? "mức thấp hơn nhiều so với 1 USD"}`,
      CUSTODY_DATA_STALE: () => `chúng tôi không còn thấy số dư lưu ký trên chuỗi gốc`,
      CUSTODY_NOT_CONFIGURED: () => `chúng tôi chưa biết cầu giữ tiền ở đâu`,
      BACKING_PARTIAL: (f) => `kho bạc của cầu chỉ giữ ${f.backingPct ?? "một phần"} số tiền nợ người dùng (thiếu ${f.gapAmount ?? "một phần"}, đã thiếu từ ${f.sinceDate ?? "ngày đầu kiểm tra"})`,
      BACKING_GAP_GROWN: (f) => `khoản thiếu trong kho bạc của cầu đã tăng lên ${f.gapAmount ?? "mức bất thường"}`,
      CHAIN_DATA_STALE: (f) => `hiện chúng tôi không đọc được ${f.chain ?? "một chuỗi"}`,
    },
  },
};

/** The explanation without the status/route head, for UIs that already show both. */
export function templateBody(facts: Facts, lang: Lang = "en"): string {
  const t = T[lang];
  const parts: string[] = [];
  for (const code of facts.codes) {
    const p = t.phrases[code]?.(facts.figures);
    if (p && !parts.includes(p)) parts.push(p);
    if (parts.length === 2) break;
  }
  if (facts.status === "green" || parts.length === 0) return t.tail[facts.status];
  const body = parts.join(t.join);
  return `${body.charAt(0).toUpperCase()}${body.slice(1)}${t.end ?? ". "}${t.tail[facts.status]}`;
}

export function templateExplain(facts: Facts, lang: Lang = "en"): string {
  const t = T[lang];
  const parts: string[] = [];
  for (const code of facts.codes) {
    const p = t.phrases[code]?.(facts.figures);
    if (p && !parts.includes(p)) parts.push(p);
    if (parts.length === 2) break;
  }
  const head = t.head[facts.status](facts.routeLabel);
  const sp = t.sp ?? " ";
  if (facts.status === "green" || parts.length === 0) return `${head}${sp}${t.tail[facts.status]}`;
  const body = parts.join(t.join);
  return `${head}${sp}${body.charAt(0).toUpperCase()}${body.slice(1)}${t.end ?? ". "}${t.tail[facts.status]}`;
}

// ---------------------------------------------------------------------------------------------
// NEAR AI (OpenAI-compatible), with guard rails
// ---------------------------------------------------------------------------------------------

export interface AiOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export const NEAR_AI_DEFAULTS = { baseUrl: "https://cloud-api.near.ai/v1", model: "zai-org/GLM-5.1-FP8" };

export function buildPrompt(facts: Facts, lang: Lang): { system: string; user: string } {
  return {
    system:
      "You write one or two short sentences explaining a crypto route-safety alert to ordinary users. " +
      "Use ONLY the facts given. Never invent numbers, causes, names or advice beyond the facts. " +
      "Do not change the status. Start with the status emoji given. Max 260 characters. " +
      `Write in ${LANGS[lang]}.`,
    user: JSON.stringify({ status: facts.status, emoji: { red: "🔴", amber: "🟡", unknown: "⚪", green: "🟢" }[facts.status], route: facts.routeLabel, signals: facts.codes, figures: facts.figures }),
  };
}

/** Reject AI text that invents numbers, contradicts the status, or rambles. */
export function validateAiText(text: string, facts: Facts): string | null {
  const clean = text.trim().replace(/^["'`]+|["'`]+$/g, "");
  if (clean.length === 0 || clean.length > 300) return null;
  const emoji = { red: "🔴", amber: "🟡", unknown: "⚪", green: "🟢" }[facts.status];
  if (!clean.startsWith(emoji)) return null;
  for (const other of ["🔴", "🟡", "⚪", "🟢"]) if (other !== emoji && clean.includes(other)) return null;
  const allowed = new Set<string>();
  for (const v of Object.values(facts.figures)) for (const n of String(v ?? "").match(/\d+(?:[.,]\d+)?/g) ?? []) allowed.add(n.replace(",", "."));
  for (const n of clean.match(/\d+(?:[.,]\d+)?/g) ?? []) {
    const norm = n.replace(",", ".");
    if (!allowed.has(norm) && norm !== "100") return null; // "100%" is allowed as a reference point
  }
  return clean;
}

export async function aiExplain(facts: Facts, lang: Lang, ai: AiOptions): Promise<{ text: string; source: "near-ai" | "template" }> {
  const fallback = { text: templateExplain(facts, lang), source: "template" as const };
  const f = ai.fetch ?? globalThis.fetch.bind(globalThis);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ai.timeoutMs ?? 6000);
  try {
    const { system, user } = buildPrompt(facts, lang);
    const res = await f(`${ai.baseUrl ?? NEAR_AI_DEFAULTS.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify({ model: ai.model ?? NEAR_AI_DEFAULTS.model, temperature: 0.2, max_tokens: 160, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const ok = validateAiText(body.choices?.[0]?.message?.content ?? "", facts);
    return ok ? { text: ok, source: "near-ai" } : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

/** One call: facts → AI if configured and trustworthy, template otherwise. */
export async function explain(v: Pick<RouteVerdict, "route" | "status" | "reasons" | "components">, lang: Lang = "en", ai?: AiOptions): Promise<{ text: string; source: "near-ai" | "template"; facts: Facts }> {
  const facts = extractFacts(v);
  const out = ai?.apiKey ? await aiExplain(facts, lang, ai) : { text: templateExplain(facts, lang), source: "template" as const };
  return { ...out, facts };
}

export { reasonSubject };
