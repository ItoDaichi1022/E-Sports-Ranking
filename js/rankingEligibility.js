// 大会をランキングに反映するかどうかの条件判定。
//
// 大会の試合は自動でランキングに乗るが、少人数の大会やチーム戦まで同じ土俵で
// 集計すると、個人の実力を表す指標として成り立たなくなる。そこで
//   ① 参加人数が16人以上
//   ② 対戦方法が 1v1 またはリレー（＝個人の勝敗として数えられるもの）
//   ③ 配信元がYouTubeのURL（＝試合が公開の場に残っている）
// のすべてを満たす大会だけをスコア計算の対象とする。
//
// ③は「誰でも後から確認できる形で行われた大会か」を見るための条件。結果を争う
// スコアの根拠になる以上、当事者以外にも試合を追える必要がある。判定に使うのは
// 運営が大会情報に入れた配信元URL（tournaments.stream_url）で、実際に配信された
// かどうかまでは分からない ── そこはURLを載せる運営の責任として扱う。
//
// これに加えて、運営が大会ごとに「反映しない」を選べる（tournaments.ranking_opt_in）。
// 条件は満たすが順位に混ぜたくない大会 ── エキシビションや練習会 ── のための逃げ道で、
// 条件の側とは性質が違う。あちらは「数えられないから外れる」、こちらは「数えられるが
// 数えないと決めた」。画面でも別の言葉で伝える（js/app.js の rankingEligibilityHtml）。
//
// 判定は保存せず、そのつど大会の内容から算出する（tournamentTier.js と同じ方針）。
// 参加人数は募集中に増えるので、値を持たせると実態とずれてしまうため。
export const RANKED_MIN_PARTICIPANTS = 16;

// 対戦方法。ranked が true のものだけがランキングのスコア計算に入る。
// キーはDBの tournaments.match_type にそのまま入る値。
export const MATCH_TYPES = {
  '1v1': { label: '1v1', ranked: true },
  relay: { label: 'リレー', ranked: true },
  '2v2': { label: '2v2', ranked: false },
  other: { label: 'その他', ranked: false },
};

export const MATCH_TYPE_KEYS = Object.keys(MATCH_TYPES);

// 配信元がYouTubeか。youtu.be（共有時の短縮URL）と、www / m / gaming などの
// サブドメイン付きも同じものとして通す。
//
// ホスト名だけで見るのは、URLの形が配信・アーカイブ・チャンネル・ライブと何通りも
// あり、そのどれを載せるかは運営に任せているため。
const YOUTUBE_HOSTS = ['youtube.com', 'youtu.be'];

export function isYouTubeUrl(value) {
  if (!value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  const host = url.hostname.toLowerCase();
  return YOUTUBE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// 表示用の対戦方法名。「その他」は運営が書いた説明をそのまま見せる。
// 未設定（この機能より前に作られた大会）は空欄ではなく理由が分かる文言にする。
export function matchTypeLabel(tournament) {
  const type = MATCH_TYPES[tournament.matchType];
  if (!type) return '未設定';
  if (tournament.matchType === 'other' && tournament.matchTypeNote) {
    return `その他（${tournament.matchTypeNote}）`;
  }
  return type.label;
}

// 大会がランキング反映の対象かどうかと、対象外ならその理由。
//
// 戻り値:
//   ranked   スコア計算に入れるか（条件と運営の設定をすべて満たすときだけ true）
//   reasons  条件を満たしていない項目（人数・対戦方法・配信元）。満たしていれば空
//   optedOut 運営が「反映しない」を選んでいるか
//
// reasons と optedOut を分けているのは、伝える言葉が違うため。条件は大会の中身で
// 決まるので「何が足りないか」を出すが、運営の設定は足りないものではない。
export function rankingEligibility(tournament) {
  const reasons = [];

  // 数えるのは出場枠。チーム戦は下の対戦方法の条件で必ず外れるので、
  // ここが人数かチーム数かは結果に影響しないが、画面に出る「参加人数」と揃えておく。
  const count = tournament.entrantCount;
  if (count < RANKED_MIN_PARTICIPANTS) {
    reasons.push(`参加${RANKED_MIN_PARTICIPANTS}人以上（現在${count}人）`);
  }

  const type = MATCH_TYPES[tournament.matchType];
  if (!type) {
    reasons.push('対戦方法が未設定');
  } else if (!type.ranked) {
    reasons.push(`対戦方法が1v1・リレー以外（${type.label}）`);
  }

  // 配信元。この条件より前に作られた大会は空欄のことがあり、その場合は対象から外れる
  // （運営が大会情報を編集してURLを入れれば、次の集計から入る）。
  if (!tournament.streamUrl) {
    reasons.push('配信元が未設定');
  } else if (!isYouTubeUrl(tournament.streamUrl)) {
    reasons.push('配信元がYouTubeではない');
  }

  // 運営が外している大会は、条件を満たしていても対象にしない。
  // この列より前に作られた大会は undefined で来るので、明示的な false だけを見る
  // （既定は「反映する」── 増えた設定のせいで過去の大会が黙って外れないように）。
  const optedOut = tournament.rankingOptIn === false;

  return { ranked: !optedOut && reasons.length === 0, reasons, optedOut };
}

export function isRankedTournament(tournament) {
  return rankingEligibility(tournament).ranked;
}
