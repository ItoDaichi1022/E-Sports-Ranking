// Supabaseとの読み書き。js/github.js + js/githubSync.js の置き換え。
//
// ここがDBとアプリの唯一の境界で、snake_case（DB）とcamelCase（in-memory state）の
// 変換もここだけで行う。おかげで js/ranking.js・js/bracket.js・js/playerStats.js などの
// 計算・描画ロジックはストレージを一切意識しない。
//
// GitHubをDB代わりにしていた頃に必要だった楽観ロックと三方マージは、すべて不要になった。
// Postgresは行単位で書き込むため、別々の大会・別々の選手を同時に編集しても競合しない。

import { supabase } from './supabaseClient.js';
import { state, findTournament, isTeamTournament, getEntrantMemberIds } from './state.js';
import { downscaleImage } from './util.js';

// ---------------------------------------------------------------------------
// 行 ⇄ stateオブジェクトの変換
// ---------------------------------------------------------------------------

// players から取る列を2段に分ける。
//
// 【全選手ぶんを常に運ぶものを最小にする】起動時の loadAll は全選手の行を取る。
// 自己紹介（bio）は text で上限が無く（supabase/schema.sql）、1人が長文を書けば
// ホームを開いた全員が毎回それを受け取ることになる。名前引き・行に敷く絵・
// BAN判定に要る列だけを常に取り、残りは ensurePlayerDetail で足す。
//
// 【game_account_id はこちら側】プロフィールだけの値に見えるが、エントリーの
// 表示名（js/entries.js の「名前（アカウントID）」）と選手検索でも使う。
// 向こうへ移すと、エントリー一覧を出すたびに全員分の詳細が要ることになる。
const PLAYER_LIST_COLUMNS =
  'id, user_id, display_name, past_names, game_account_id, avatar_url, main_characters, role, banned_at, banned_by';
const PLAYER_DETAIL_COLUMNS = 'id, bio, sns_x, sns_twitch, sns_youtube';

function toPlayer(row) {
  return {
    id: row.id,
    userId: row.user_id,
    currentName: row.display_name,
    pastNames: row.past_names ?? [],
    gameAccountId: row.game_account_id ?? '',
    bio: row.bio ?? '',
    avatarUrl: row.avatar_url ?? '',
    mainCharacters: row.main_characters ?? [],
    snsX: row.sns_x ?? '',
    // snsTwitch は入力欄・表示のどちらからも外したが、既に登録されている値を
    // 保存のたびに消してしまわないよう、読み書きだけは残している。
    snsTwitch: row.sns_twitch ?? '',
    snsYoutube: row.sns_youtube ?? '',
    // 詳細列がこの行に入っていたか。
    //
    // 【空文字と「まだ取っていない」を取り違えないこと】上の4つは、詳細列を
    // 選んでいない行では必ず空になる。その状態で savePlayer を呼ぶと、書かれていた
    // 自己紹介が null で上書きされて消える（下の savePlayer が弾いている）。
    detailLoaded: 'bio' in row,
    role: row.role ?? 'player',
    // 利用停止（BAN）の印。null なら停止されていない。
    // 列単位のGRANTから外してあるので、ここから書き戻すことはない（setPlayerBan を通す）。
    bannedAt: row.banned_at ?? null,
    bannedBy: row.banned_by ?? null,
  };
}

// 本人が編集できる列だけを取り出す。DB側でも列単位のGRANTで守っているが、
// 余計な列を送らないことでリクエストが弾かれるのを防ぐ。
function toPlayerUpdate(player) {
  return {
    display_name: player.currentName,
    past_names: player.pastNames ?? [],
    game_account_id: player.gameAccountId || null,
    bio: player.bio || null,
    avatar_url: player.avatarUrl || null,
    main_characters: player.mainCharacters ?? [],
    sns_x: player.snsX || null,
    sns_twitch: player.snsTwitch || null,
    sns_youtube: player.snsYoutube || null,
  };
}

// エントリー行を「出場枠（entrant）」単位にまとめる。
//
// team_id があればチーム、無ければ選手そのものが1枠になる。DBの定員トリガーが
// count(distinct coalesce(team_id, player_id)) で数えているのと同じ区切り方なので、
// 画面に出る枠数と定員判定が必ず一致する。
//
// 枠の並びはシード順（未確定なら登録順）。個人戦のシードは tournament_entries.seed に、
// チームのシードは tournament_teams.seed にある。
function buildEntrants(teamRows, entryRows) {
  const teamById = new Map(teamRows.map((t) => [t.id, t]));

  const entrants = new Map();
  [...entryRows]
    .sort((a, b) => a.entered_at.localeCompare(b.entered_at))
    .forEach((e) => {
      const id = e.team_id ?? e.player_id;
      if (!entrants.has(id)) {
        const team = e.team_id ? teamById.get(e.team_id) ?? null : null;
        entrants.set(id, {
          id,
          team,
          memberIds: [],
          seed: team ? team.seed : e.seed,
          enteredAt: e.entered_at,
        });
      }
      entrants.get(id).memberIds.push(e.player_id);
    });

  const ordered = [...entrants.values()].sort((a, b) => {
    if (a.seed != null && b.seed != null) return a.seed - b.seed;
    if (a.seed != null) return -1;
    if (b.seed != null) return 1;
    return a.enteredAt.localeCompare(b.enteredAt);
  });

  return {
    entrantIds: ordered.map((x) => x.id),
    // entrantIds と同じ並びのシード番号。まだ決まっていない枠（募集中）は null。
    // 並び順だけでは「登録順に並んでいるだけ」と区別が付かないので、番号を出す側が
    // 決定済みかどうかを見分けられるように、値そのものを持ち回る。
    entrantSeeds: ordered.map((x) => x.seed ?? null),
    participantIds: ordered.flatMap((x) => x.memberIds),
    teams: ordered
      .filter((x) => x.team)
      .map((x) => ({
        id: x.team.id,
        name: x.team.name,
        memberIds: x.memberIds,
        seed: x.team.seed,
        placement: x.team.placement,
      })),
  };
}

function toTournament(row, { entrantIds, entrantSeeds, participantIds, teams }) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    format: row.format,
    // ランキング反映の条件判定に使う対戦方法（js/rankingEligibility.js）。
    // この機能より前に作られた大会は null で、対象外として扱われる。
    matchType: row.match_type,
    matchTypeNote: row.match_type_note ?? '',
    // ランキングに反映させるかどうかの運営の設定。この列より前に作られた大会は
    // null で来るので、真に寄せる（これまでどおり条件だけで決まる）。
    rankingOptIn: row.ranking_opt_in !== false,
    rules: row.rules,
    imageUrl: row.image_url ?? '',
    // 配信元のURL。未設定は空文字（入力欄の value にそのまま渡せる形に揃える）
    streamUrl: row.stream_url ?? '',
    // 三位決定戦を行うか。この列より前に作られた大会は null で来るので偽に寄せる
    thirdPlaceMatch: Boolean(row.third_place_match),
    weight: row.weight,
    status: row.status,
    capacity: row.capacity,
    // 運営が掲げるエントリーの締切時刻（ISO文字列）。未設定は null。
    // これを過ぎても自動では何も起きない（画面に出すだけ。js/entries.js を参照）
    entryDeadline: row.entry_deadline ?? null,
    createdBy: row.created_by,
    // 出場枠と出場した人。個人戦では同じ配列になる（js/state.js の説明を参照）
    entrantIds,
    entrantSeeds,
    participantIds,
    teams,
    // 一覧カード用の人数。行を読み込んでいない大会では loadAll が
    // 埋め込みカウントの値で上書きする（配列は空でも人数は出せるように）
    entrantCount: entrantIds.length,
    participantCount: participantIds.length,
  };
}

function toMatch(row) {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    winnerId: row.winner_id,
    loserId: row.loser_id,
    winnerTeamId: row.winner_team_id ?? null,
    loserTeamId: row.loser_team_id ?? null,
    score: row.score,
    round: row.round,
  };
}

function fromMatch(match) {
  return {
    id: match.id,
    tournament_id: match.tournamentId,
    winner_id: match.winnerId ?? null,
    loser_id: match.loserId ?? null,
    winner_team_id: match.winnerTeamId ?? null,
    loser_team_id: match.loserTeamId ?? null,
    score: match.score,
    round: match.round,
  };
}

function toRound(row) {
  return {
    tournamentId: row.tournament_id,
    roundIndex: row.round_index,
    streamedMatchIds: row.streamed_match_ids ?? [],
    startedAt: row.started_at,
    startedBy: row.started_by,
  };
}

function toRoomCode(row) {
  return {
    tournamentId: row.tournament_id,
    matchId: row.match_id,
    code: row.code,
    setBy: row.set_by,
    updatedAt: row.updated_at,
  };
}

function toChatReport(row) {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    matchId: row.match_id,
    reporterId: row.reporter_id,
    body: row.body,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

function toPlayerReport(row) {
  return {
    id: row.id,
    targetId: row.target_id,
    reporterId: row.reporter_id,
    reason: row.reason,
    body: row.body ?? '',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution ?? null,
  };
}

function toTournamentReport(row) {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    reporterId: row.reporter_id,
    reason: row.reason,
    body: row.body ?? '',
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution ?? null,
  };
}

function toAnnouncement(row) {
  return {
    id: row.id,
    title: row.title,
    body: row.body ?? '',
    imageUrl: row.image_url ?? '',
    pinned: row.pinned ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// PostgRESTのエラーを日本語にして投げ直す。
// 原因究明のため、元のコードと詳細も必ず残す（コードだけでは何が起きたか分からない）。
function check(error, what) {
  if (!error) return;

  console.error(`[db] ${what}に失敗`, error);

  const detail = [error.code, error.details, error.hint].filter(Boolean).join(' / ');
  const suffix = detail ? `（${detail}）` : '';

  if (error.code === '42501' || error.message?.includes('row-level security')) {
    throw new Error(
      `${what}の権限がありません。ログインし直すか、運営権限が必要な操作でないか確認してください。${suffix}`,
    );
  }
  if (error.code === '23505') {
    throw new Error(`${what}: 同じ内容が既に登録されています。${suffix}`);
  }
  throw new Error(`${what}に失敗しました: ${error.message}${suffix}`);
}

// RPCのエラーはSQL側で日本語の文言を付けて raise してあるので、包み直さずそのまま見せる。
// 「チームでのエントリーに失敗しました: すでに…（P0001）」より「すでに…」のほうが伝わる。
function checkRpc(error, what) {
  if (!error) return;
  console.error(`[db] ${what}に失敗`, error);
  throw new Error(error.message || `${what}に失敗しました。`);
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

// どこまで読み込んだかの記録。増え続けるデータ（エントリー・試合結果・お知らせ）は
// 最初に全部読まず、そのページを開いたときに必要な分だけ取りに行く（下の ensure〜 関数）。
// loadAll はこの記録に従って「読み込み済みの範囲だけ」を取り直し、
// 開きっぱなしのページがRealtimeの更新で古くならないようにする。
const loadedDetailIds = new Set(); // エントリー・チームを読み込んだ大会
const loadedMatchIds = new Set(); // 試合結果を読み込んだ大会（対戦表を開いた大会）
let fullDataLoaded = false; // 運営の集計操作（ensureFullData）で全件を読み込んだか

// 一度でもDBから読めたか。0件なのか、まだ届いていないのかを画面が見分けるために使う。
// 「まだ大会はありません」と「読み込んでいます」は、出す相手にとってまるで違う。
let everLoaded = false;

export function hasLoadedOnce() {
  return everLoaded;
}
let allAnnouncementsLoaded = false; // お知らせを全件読み込んだか（一覧ページを開いたか）

// 先に読むお知らせの件数。ホーム（最新3件）に足りればよく、全件は一覧ページで読む。
const ANNOUNCEMENTS_PRELOAD = 6;

const noRows = () => Promise.resolve({ data: [], error: null, count: 0 });

// state の「部位」。loadAll はここに挙げた単位でしか取り直さない。
//
// 分け方の基準は「同じ問い合わせ結果から組み立てられるか」。たとえば大会・エントリー・
// チームは1つの部位にまとまっている ── 出場枠の配列（entrantIds）も優勝の記録も
// この3つを突き合わせて初めて作れるので、どれか1つだけ取り直すことができない。
export const ALL_PARTS = [
  'players',        // state.players
  'tournaments',    // state.tournaments / placements / teamChampions
  'brackets',       // state.brackets / bracketIds
  'matches',        // state.matches
  'ranking',        // state.publishedRanking
  'announcements',  // state.announcements
  'chatReports',    // state.chatReports
  'playerReports',  // state.playerReports
  'tournamentReports', // state.tournamentReports
  'organizers',     // state.tournamentOrganizers
  'rounds',         // state.rounds
  'roomCodes',      // state.roomCodes
];

// 問い合わせが失敗したときに画面へ出す名前。
const QUERY_LABELS = {
  players: '選手の読み込み',
  playerCount: '登録選手数の読み込み',
  bannedPlayers: '利用停止中の選手の読み込み',
  tournaments: '大会の読み込み',
  teams: 'チームの読み込み',
  entries: 'エントリーの読み込み',
  championEntries: '優勝記録の読み込み',
  championTeams: '優勝チームの読み込み',
  bracketIds: 'ブラケットの読み込み',
  openBrackets: 'ブラケットの読み込み',
  matches: '試合結果の読み込み',
  ranking: 'ランキングの読み込み',
  announcements: 'お知らせの読み込み',
  reports: '報告の読み込み',
  playerReports: '通報の読み込み',
  tournamentReports: '大会への通報の読み込み',
  organizers: '大会運営の読み込み',
  rounds: '回戦の読み込み',
  roomCodes: 'ルームコードの読み込み',
};

// 基本データを取得して state を差し替える。認証は不要（RLSがSELECTを全員に許可）。
// 途中で失敗しても中途半端な表示にならないよう、全部揃ってから state に入れる。
//
// parts に部位名の配列を渡すと、その部位だけを取り直す（省略すると全部位）。
// Realtimeで1テーブルが変わっただけのときに全テーブルを取り直さないための引数で、
// 「どのテーブルがどの部位に対応するか」は下の PART_BY_TABLE が持っている。
//
// 増え続けるデータは行を運ばない：
//   ブラケット      IDだけ取り、中身は loadBracket（対戦表を開いたとき）
//   エントリー・チーム  一覧カード用の人数はDB側で数えてもらい（埋め込みカウント）、
//                   行は ensureTournamentDetail（大会詳細を開いたとき）。
//                   ただし優勝の記録（placement=1）だけは「優勝: ○○」表示用に常に取る
//                   （1大会あたり1〜2行で、終了した大会の数しか増えない）
//   試合結果        ensureTournamentMatches（対戦表を開いたとき）と
//                   ensureFullData（運営の集計操作）でだけ読む
//   お知らせ        最新数件だけ。全件は ensureAllAnnouncements（一覧ページ）
export async function loadAll(parts = null) {
  const want = new Set(parts ?? ALL_PARTS);
  if (want.size === 0) return;

  // 既に開いている対戦表・詳細ページは中身も取り直す。Realtimeで変更が届いたときに
  // 見ている画面がその場で更新されるようにするため（通常は0件か1件）。
  const openBracketIds = Object.keys(state.brackets);
  const detailIds = [...loadedDetailIds];
  const matchIds = [...loadedMatchIds];

  // 要る部位の問い合わせだけを組み立てる。ここに入れなければ通信そのものが起きない。
  const queries = {};

  if (want.has('players')) {
    // 【全選手の行はもう取らない】以前はここで players の全行を配っていた。
    // ホームを開いただけの人にも全員分が降りてきて、登録者が増えるほど、
    // 誰がどのページを見ても重くなり続ける作りだった。
    //
    // いま取るのは2つだけ。
    //   1. 人数（行はゼロ。ホームの「登録選手 N人」に要る）
    //   2. 既に手元に持っている人の、最新の中身
    //
    // 【2が要る理由】手元の行を取り直さないと、誰かが改名しても、その人を
    // 一度でも見た人の画面には古い名前が残り続ける（以前は毎回作り直していたので
    // 勝手に直っていた）。持っている人だけなので、増えても際限なく重くならない。
    //
    // 必要な選手を新しく取るのは ensurePlayers（下）。
    queries.playerCount = supabase.from('players').select('id', { count: 'exact', head: true });

    const heldIds = state.players.map((p) => p.id);
    queries.players = heldIds.length
      ? supabase.from('players').select(PLAYER_LIST_COLUMNS).in('id', heldIds)
      : noRows();

    // 【ランキングの集計でも全員は取らないこと】ensureFullData（運営の集計操作）は
    // 全試合・全エントリーを読むが、選手の行までは要らない。集計に使うのは選手IDと
    // スコアだけで、名前が要るのは最後に画面へ出す人だけ ── 発表は10〜50人なので、
    // そのぶんを順位発表の画面が自分で取りに行く（js/reveal.js の fillPickerNames）。
    // シード順の並び替え（js/app.js・js/entries.js）にいたっては名前を1つも使わない。

    // 【利用停止中の選手だけは常に全員取ること】運営のBAN一覧（js/app.js の
    // renderBanReview）は state.players から停止中の人を拾って並べる。手元に
    // 居る人しか拾えないと、解除すべき相手が一覧に出てこない ── 運営が「解除の
    // しようがない」状態になる。
    // 停止は例外的な操作なので件数は少なく、索引もある（players_banned_idx）。
    queries.bannedPlayers = supabase.from('players')
      .select(PLAYER_LIST_COLUMNS).not('banned_at', 'is', null);
  }

  if (want.has('tournaments')) {
    // 一覧カードに出す人数は行を運ばずDB側で数えてもらう（埋め込みカウント）
    queries.tournaments = supabase.from('tournaments')
      .select('*, tournament_entries(count), tournament_teams(count)')
      .order('date', { ascending: true, nullsFirst: false });
    queries.teams = fullDataLoaded
      ? supabase.from('tournament_teams').select('*')
      : (detailIds.length
        ? supabase.from('tournament_teams').select('*').in('tournament_id', detailIds)
        : noRows());
    queries.entries = fullDataLoaded
      ? supabase.from('tournament_entries').select('*')
      : (detailIds.length
        ? supabase.from('tournament_entries').select('*').in('tournament_id', detailIds)
        : noRows());
    // 優勝の記録。全件読み込み後は entries に含まれるので二重に取らない
    queries.championEntries = fullDataLoaded
      ? noRows()
      : supabase.from('tournament_entries').select('tournament_id, player_id, placement').eq('placement', 1);
    queries.championTeams = fullDataLoaded
      ? noRows()
      : supabase.from('tournament_teams').select('tournament_id, name, placement').eq('placement', 1);
  }

  if (want.has('brackets')) {
    queries.bracketIds = supabase.from('brackets').select('tournament_id');
    queries.openBrackets = openBracketIds.length > 0
      ? supabase.from('brackets').select('tournament_id, data, updated_at').in('tournament_id', openBracketIds)
      : noRows();
  }

  if (want.has('matches')) {
    queries.matches = fullDataLoaded
      ? supabase.from('matches').select('*')
      : (matchIds.length
        ? supabase.from('matches').select('*').in('tournament_id', matchIds)
        : noRows());
  }

  if (want.has('ranking')) {
    // スナップショットは最新の1件だけ使う（過去の公開履歴は残しておく）
    queries.ranking = supabase.from('published_rankings').select('*').order('published_at', { ascending: false }).limit(1);
  }

  if (want.has('announcements')) {
    // 固定を先頭に、あとは新しい順
    queries.announcements = allAnnouncementsLoaded
      ? supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false })
      : supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }).limit(ANNOUNCEMENTS_PRELOAD);
  }

  if (want.has('chatReports')) {
    // RLSにより、運営には全件・一般の選手には自分の分だけ・ゲストには0件が返る
    queries.reports = supabase.from('match_chat_reports').select('*').order('created_at', { ascending: false });
  }

  if (want.has('playerReports')) {
    // 選手ページからの通報。RLSにより、運営には全件・一般の選手には自分が出した
    // 分だけ・ゲストには0件が返る（通報された本人にも自分宛ての分は返らない）
    queries.playerReports = supabase.from('player_reports').select('*').order('created_at', { ascending: false });
  }

  if (want.has('tournamentReports')) {
    // 大会そのものへの通報。RLSにより、サイト全体の運営には全件・出した本人には
    // 自分の分だけ・それ以外には0件が返る（その大会の運営にも見えない）
    queries.tournamentReports = supabase.from('tournament_reports').select('*').order('created_at', { ascending: false });
  }

  if (want.has('organizers')) {
    // 大会ごとの運営。誰でも見られる（大会ページに「運営: ○○」として出す）
    queries.organizers = supabase.from('tournament_organizers').select('*');
  }

  if (want.has('rounds')) {
    // 回戦ごとの開始と配信台。誰でも見られる
    queries.rounds = supabase.from('tournament_rounds').select('*');
  }

  if (want.has('roomCodes')) {
    // 対戦ごとのルームコード。当事者と運営にしか返らない
    queries.roomCodes = supabase.from('match_room_codes').select('*');
  }

  const names = Object.keys(queries);
  const settled = await Promise.all(names.map((name) => queries[name]));
  const r = {};
  names.forEach((name, i) => {
    check(settled[i].error, QUERY_LABELS[name]);
    r[name] = settled[i];
  });

  // ここまで来たら、少なくとも一度はDBの中身を見たことになる。
  // 画面はこれを見て「まだ読んでいない」と「読んだ結果0件」を区別する
  // （区別しないと、読み込み中の一瞬だけ「まだ大会はありません」と嘘を出す）。
  everLoaded = true;

  if (want.has('tournaments')) {
    // 大会ごとにエントリーとチームをまとめ、出場枠の並び（シード順、未確定なら登録順）を作る。
    // 成績はチーム戦でもメンバーの行に書き写してあるので、ここは選手IDのままでよい
    // （選手ページはチームの存在を知らずに済む）。
    const entriesByTournament = new Map();
    const teamsByTournament = new Map();
    const placementsByTournament = {};

    r.entries.data.forEach((e) => {
      if (!entriesByTournament.has(e.tournament_id)) entriesByTournament.set(e.tournament_id, []);
      entriesByTournament.get(e.tournament_id).push(e);

      if (e.placement == null) return;
      if (!placementsByTournament[e.tournament_id]) placementsByTournament[e.tournament_id] = {};
      placementsByTournament[e.tournament_id][e.player_id] = e.placement;
    });

    r.teams.data.forEach((t) => {
      if (!teamsByTournament.has(t.tournament_id)) teamsByTournament.set(t.tournament_id, []);
      teamsByTournament.get(t.tournament_id).push(t);
    });

    // 優勝の記録。行ごと読んでいない大会でも「優勝: ○○」を出せるようにする。
    r.championEntries.data.forEach((e) => {
      if (!placementsByTournament[e.tournament_id]) placementsByTournament[e.tournament_id] = {};
      placementsByTournament[e.tournament_id][e.player_id] = e.placement;
    });

    // チーム戦の優勝チーム名（championLabel がチームの行の代わりに参照する）
    const teamChampions = {};
    r.championTeams.data.forEach((t) => { teamChampions[t.tournament_id] = t.name; });
    r.teams.data.forEach((t) => {
      if (t.placement === 1) teamChampions[t.tournament_id] = t.name;
    });

    const detailLoaded = (id) => fullDataLoaded || loadedDetailIds.has(id);

    state.tournaments = r.tournaments.data.map((t) => {
      // 行を読み込んだ大会だけ entrantIds などの配列を組み立てる。それ以外は空配列のままにし、
      // 一覧カードに出す人数は埋め込みカウントから拾う（詳細を開くと実際の配列に置き換わる）。
      const assembled = detailLoaded(t.id)
        ? buildEntrants(teamsByTournament.get(t.id) ?? [], entriesByTournament.get(t.id) ?? [])
        : { entrantIds: [], entrantSeeds: [], participantIds: [], teams: [] };
      const tournament = toTournament(t, assembled);
      if (detailLoaded(t.id)) {
        tournament.participantCount = assembled.participantIds.length;
        tournament.entrantCount = assembled.entrantIds.length;
      } else {
        const participantCount = t.tournament_entries?.[0]?.count ?? 0;
        const teamCount = t.tournament_teams?.[0]?.count ?? 0;
        tournament.participantCount = participantCount;
        tournament.entrantCount = teamCount > 0 ? teamCount : participantCount;
      }
      return tournament;
    });
    state.teamChampions = teamChampions;
    state.placements = placementsByTournament;
  }

  if (want.has('brackets')) {
    // 取り直した分だけをキャッシュに残す。消された大会のブラケットもここで落ちる。
    // 版数も一緒に更新しておかないと、次の保存が「DB側が進んでいる」と誤検知する。
    const bracketsById = {};
    r.openBrackets.data.forEach((b) => {
      bracketsById[b.tournament_id] = b.data;
      bracketVersions[b.tournament_id] = b.updated_at;
    });
    state.brackets = bracketsById;
    state.bracketIds = new Set(r.bracketIds.data.map((b) => b.tournament_id));
  }

  if (want.has('players')) {
    state.playerCount = r.playerCount.count ?? 0;
    // 作り直さず、手元の行に上書きする。作り直すと、画面が掴んでいる参照が
    // 古いものになり、そちらを見ている表示だけが更新から取り残される。
    rememberPlayers(r.players.data.map(toPlayer));
    rememberPlayers(r.bannedPlayers.data.map(toPlayer));
  }
  if (want.has('matches')) state.matches = r.matches.data.map(toMatch);
  if (want.has('ranking')) {
    const snapshot = r.ranking.data?.[0];
    state.publishedRanking = snapshot
      ? {
          publishedAt: snapshot.published_at,
          periodStart: snapshot.period_start ?? null,
          periodEnd: snapshot.period_end ?? null,
          // 移行前の「直近Nか月」形式で公開された古いデータの表示にだけ使う
          periodMonths: snapshot.period_months ?? null,
          rankings: snapshot.data?.rankings ?? [],
        }
      : null;
  }
  if (want.has('announcements')) state.announcements = r.announcements.data.map(toAnnouncement);
  if (want.has('chatReports')) state.chatReports = r.reports.data.map(toChatReport);
  if (want.has('playerReports')) state.playerReports = r.playerReports.data.map(toPlayerReport);
  if (want.has('tournamentReports')) {
    state.tournamentReports = r.tournamentReports.data.map(toTournamentReport);
  }
  if (want.has('organizers')) {
    state.tournamentOrganizers = r.organizers.data.map((row) => ({
      tournamentId: row.tournament_id,
      playerId: row.player_id,
    }));
  }
  if (want.has('rounds')) state.rounds = r.rounds.data.map(toRound);
  if (want.has('roomCodes')) state.roomCodes = r.roomCodes.data.map(toRoomCode);

  // 【名前が要る選手を、読んだものから拾ってここで取ること】
  //
  // 全選手を配るのをやめた以上、名前を出す画面は「その名前の選手を手元に
  // 持っている」ことを自分で確かめなければならない。それを描く側に撒くと、
  // 必ずどこかで忘れる ── 忘れた場所には (不明) と出るが、どの大会・どの選手で
  // 出るかはデータ次第なので、検査でも手元の確認でも捕まえきれない。
  //
  // だから、撒かずにここへ集める。ここは「何を読んだか」を知っている唯一の場所で、
  // 読んだものが選手IDを指しているなら、その選手も一緒に要るに決まっている。
  // 新しく選手IDを持つテーブルを足したときは、ここにも1行足すこと。
  const referenced = new Set();
  if (want.has('organizers')) {
    // 大会ページの「運営: ○○」
    state.tournamentOrganizers.forEach((o) => referenced.add(o.playerId));
  }
  if (want.has('chatReports')) {
    // 対戦チャットからの報告。運営の画面に通報者名が出る
    state.chatReports.forEach((x) => referenced.add(x.reporterId));
  }
  if (want.has('playerReports')) {
    // 選手ページからの通報。運営の画面に「誰が誰を」が出る
    state.playerReports.forEach((x) => { referenced.add(x.targetId); referenced.add(x.reporterId); });
  }
  if (want.has('tournamentReports')) {
    // 大会への通報。運営の画面に通報者名が出る
    state.tournamentReports.forEach((x) => referenced.add(x.reporterId));
  }
  if (want.has('ranking')) {
    // 公開済みランキング（順位発表・お知らせ）。中身は選手IDの並び
    (state.publishedRanking?.rankings ?? []).forEach((e) => referenced.add(e.id));
  }
  referenced.delete(null);
  referenced.delete(undefined);
  await ensurePlayers([...referenced]);
}

// 大会詳細の問い合わせを「始めただけ」の状態で覚えておく置き場。
//
// 【なぜ通信と組み立てを分けるか】
// この2本は、組み立てる先（state.tournaments のその大会の行）が loadAll で
// 出来ていないと最後まで進めない。ところが「問い合わせを投げる」だけなら
// 大会IDさえあれば足りる ── URLに入っているので、起動した瞬間から分かる。
//
// 分ける前は routeFromLocation（= loadAll の完了後）で初めて投げていたので、
// 回線の往復が2回、順番待ちで並んでいた。実測（Slow 4G・大会詳細）では
// loadAll の最後が届くのが 5.47秒、そこから投げ直して 6.11秒 ── 中身は
// 合わせて2KBも無いのに、往復1回ぶん（約640ms）がまるまる待ち時間だった。
//
// 起動時に prefetchTournamentDetail を呼んでおけば、この2本は loadAll と
// 同時に流れ出す。ensureTournamentDetail は届いた結果を組み立てるだけになる。
const detailRequests = new Map(); // tournamentId -> Promise<{ teams, entries }>

// 大会詳細の問い合わせだけを先に始める。組み立ては ensureTournamentDetail が行う。
//
// 待たない・例外を投げないこと。ここは「ついでに始めておく」場所で、
// 失敗したかどうかを見るのは、実際に中身を要る ensureTournamentDetail の役目。
// ここで throw すると、起動処理そのものが道連れになる。
export function prefetchTournamentDetail(tournamentId) {
  if (!tournamentId) return;
  if (fullDataLoaded || loadedDetailIds.has(tournamentId)) return;
  if (detailRequests.has(tournamentId)) return;

  const request = Promise.all([
    supabase.from('tournament_teams').select('*').eq('tournament_id', tournamentId),
    supabase.from('tournament_entries').select('*').eq('tournament_id', tournamentId),
  ]).then(([teams, entries]) => ({ teams, entries }));

  // 誰も await しないまま失敗すると unhandledrejection になる。捕まえておいて、
  // 中身は捨てない（ensureTournamentDetail が改めて await して、そこで throw する）。
  request.catch(() => {});

  detailRequests.set(tournamentId, request);
}

// 大会のエントリー・チームの行を読み込み、entrantIds などを実際の配列にする。
// 「誰が出ているか」を出すページ（大会詳細・対戦表）の入り口で呼ぶ。
// 一度読めば以後の loadAll が取り直すため、開いている間は最新に保たれる。
export async function ensureTournamentDetail(tournamentId) {
  if (fullDataLoaded || loadedDetailIds.has(tournamentId)) return;

  // 起動時に先に投げてあればそれを待つ。無ければここで投げる（画面の中で
  // 大会を開いた場合はこちらの経路になる）。
  prefetchTournamentDetail(tournamentId);
  let teams;
  let entries;
  try {
    ({ teams, entries } = await detailRequests.get(tournamentId));
  } finally {
    // 成否によらず捨てる。残すと、失敗した問い合わせの結果を次の呼び出しが
    // そのまま受け取り、画面を開き直しても同じエラーが出続ける。
    detailRequests.delete(tournamentId);
  }
  check(teams.error, 'チームの読み込み');
  check(entries.error, 'エントリーの読み込み');

  loadedDetailIds.add(tournamentId);

  const tournament = state.tournaments.find((t) => t.id === tournamentId);
  if (!tournament) return;

  const assembled = buildEntrants(teams.data, entries.data);
  tournament.entrantIds = assembled.entrantIds;
  tournament.entrantSeeds = assembled.entrantSeeds;
  tournament.participantIds = assembled.participantIds;
  tournament.teams = assembled.teams;
  tournament.entrantCount = assembled.entrantIds.length;
  tournament.participantCount = assembled.participantIds.length;

  const placements = {};
  entries.data.forEach((e) => {
    if (e.placement != null) placements[e.player_id] = e.placement;
  });
  if (Object.keys(placements).length > 0) state.placements[tournamentId] = placements;

  teams.data.forEach((t) => {
    if (t.placement === 1) state.teamChampions[tournamentId] = t.name;
  });

  // 出場者の名前を揃える。この大会を出す画面（大会詳細・対戦表・出場選手一覧・
  // 対戦チャット）は全部ここを通るので、名前が要る選手はここで出そろう。
  await ensurePlayers(tournament.participantIds);
}

// 試合結果の問い合わせを「始めただけ」の状態で覚えておく置き場。
// 分ける理由は detailRequests と同じ（対戦表のURLで着地したときの往復を1回減らす）。
const matchRequests = new Map(); // tournamentId -> Promise<PostgRESTの応答>

// その大会の試合結果の問い合わせだけを先に始める。
// 待たない・例外を投げない（prefetchTournamentDetail と同じ約束）。
export function prefetchTournamentMatches(tournamentId) {
  if (!tournamentId) return;
  if (fullDataLoaded || loadedMatchIds.has(tournamentId)) return;
  if (matchRequests.has(tournamentId)) return;

  // 【Promise.resolve で包むこと】supabase-js のクエリビルダーは Promise ではなく
  // 遅延 thenable で、通信は then() が呼ばれた中で初めて始まる（vendor/supabase.js の
  // PostgrestBuilder.then）。組み立てただけの値を Map に入れても何も飛ばないので、
  // ここで then() を1回踏ませて実際に走らせる。
  // （detailRequests 側は Promise.all が then() を呼ぶので、そちらは包む必要がない）
  const started = Promise.resolve(supabase.from('matches').select('*').eq('tournament_id', tournamentId));
  started.catch(() => {});

  matchRequests.set(tournamentId, started);
}

// その大会の試合結果を state.matches に読み込む。対戦表ページの入り口で呼ぶ。
// syncTournamentProgress は state.matches とDBの差分で保存するため、
// 対戦表を操作する前に必ずその大会の分が手元に揃っていなければならない。
export async function ensureTournamentMatches(tournamentId) {
  if (fullDataLoaded || loadedMatchIds.has(tournamentId)) return;

  prefetchTournamentMatches(tournamentId);
  let data;
  let error;
  try {
    ({ data, error } = await matchRequests.get(tournamentId));
  } finally {
    // 失敗した結果を次の呼び出しへ持ち越さない（detailRequests と同じ理由）
    matchRequests.delete(tournamentId);
  }
  check(error, '試合結果の読み込み');

  loadedMatchIds.add(tournamentId);
  state.matches = state.matches
    .filter((m) => m.tournamentId !== tournamentId)
    .concat(data.map(toMatch));
}

// 運営の集計操作（ランキング編集・シード決定）用に全データを読み込む。
// ランキングは全試合・全順位・チーム構成に依存するため、材料を丸ごと揃えてから
// 既存の computeRankings をそのまま使う。一度読めば以後の loadAll も全件を取り直す。
export async function ensureFullData() {
  if (fullDataLoaded) return;
  fullDataLoaded = true;
  try {
    await loadAll();
  } catch (err) {
    fullDataLoaded = false;
    throw err;
  }
}

// 一度取った詳細（自己紹介・SNS）の控え。playerId -> 詳細だけの部分オブジェクト。
//
// 新しく取ってきた行に、ここから詳細を戻す（下の withPlayerDetail）。
// 一覧用の問い合わせは自己紹介とSNSを取らないので、控えを持たずに state 側だけ
// 書き換えると、その選手を取り直した瞬間に自己紹介が空になる。
const playerDetails = new Map();

function withPlayerDetail(player) {
  const detail = playerDetails.get(player.id);
  return detail ? Object.assign(player, detail, { detailLoaded: true }) : player;
}

// その選手の自己紹介とSNSを読み込む。選手ページを開く入り口と、
// プロフィールを保存し得る操作（運営のプレイヤー名変更）の前で呼ぶ。
//
// 【保存の前に必ず通すこと】これを呼ばずに savePlayer へ渡すと、手元に無い
// 自己紹介が null で上書きされて消える。savePlayer がそれを弾くので黙って
// 壊れることはないが、弾かれた側は保存できないままになる。
export async function ensurePlayerDetail(playerId) {
  if (!playerId || playerDetails.has(playerId)) return;

  const { data, error } = await supabase
    .from('players')
    .select(PLAYER_DETAIL_COLUMNS)
    .eq('id', playerId)
    .maybeSingle();
  check(error, 'プロフィールの読み込み');
  if (!data) return;   // 消された選手。控えを作らないので、次に開けばもう一度見に行く

  playerDetails.set(playerId, {
    bio: data.bio ?? '',
    snsX: data.sns_x ?? '',
    snsTwitch: data.sns_twitch ?? '',
    snsYoutube: data.sns_youtube ?? '',
  });

  const player = state.players.find((p) => p.id === playerId);
  if (player) withPlayerDetail(player);
}

// お知らせの全件読み込み（一覧ページ・古いお知らせの詳細用）。普段は最新数件しか読まない。
export async function ensureAllAnnouncements() {
  if (allAnnouncementsLoaded) return;

  const { data, error } = await supabase
    .from('announcements')
    .select('*')
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });
  check(error, 'お知らせの読み込み');

  allAnnouncementsLoaded = true;
  state.announcements = data.map(toAnnouncement);
}

// 全件が手元にあるか。「そのお知らせは無い」と言い切ってよいかの判断に使う
// （最新数件しか読んでいない状態で言い切ると、古いお知らせのURLを開いた人に
//   一瞬「見つかりません」を見せることになる。js/app.js の applyRouteMeta）。
export function hasAllAnnouncements() {
  return allAnnouncementsLoaded;
}

// 選手ページ用。その選手の出場記録（大会・順位・チーム名）だけを取る。
// チーム名はエントリー行から tournament_teams を辿って一緒に受け取る。
export async function loadPlayerEntries(playerId) {
  const { data, error } = await supabase
    .from('tournament_entries')
    .select('tournament_id, placement, team:tournament_teams(name)')
    .eq('player_id', playerId);
  check(error, '出場記録の読み込み');

  return data.map((e) => ({
    tournamentId: e.tournament_id,
    placement: e.placement,
    teamName: e.team?.name ?? null,
  }));
}

// 1回の問い合わせに入れるIDの数。
//
// PostgRESTの in.(...) はURLのクエリに並ぶので、際限なく詰めるとURLが長くなりすぎて
// 弾かれる（サーバーやCDNの上限に当たる。何件で切れるかは環境ごとに違う）。
// uuidは36文字なので、200件でおよそ7.5KB ── 一般的な上限（8KB前後）の内側に収まる。
const PLAYER_FETCH_CHUNK = 200;

// 名前を出すのに要る選手を、手元に揃える。
//
// 【必要なぶんだけ取るための入口】起動時に全選手を配るのをやめた（loadAll の注記）
// ので、名前を出す前にここを通す。既に持っている人は問い合わせない。
export async function ensurePlayers(ids) {
  const missing = [...new Set(ids)]
    .filter((id) => id && !state.players.some((p) => p.id === id));
  if (missing.length === 0) return;

  const chunks = [];
  for (let i = 0; i < missing.length; i += PLAYER_FETCH_CHUNK) {
    chunks.push(missing.slice(i, i + PLAYER_FETCH_CHUNK));
  }

  const results = await Promise.all(chunks.map(
    (chunk) => supabase.from('players').select(PLAYER_LIST_COLUMNS).in('id', chunk),
  ));
  for (const { error } of results) check(error, '選手の読み込み');

  rememberPlayers(results.flatMap((res) => res.data.map(toPlayer)));
}

// アカウント統合の候補（本人が自分で作った選手行＝user_id を持つ行）。
//
// 運営が、代理登録した行に本人のアカウントを結び付けるときにだけ使う。
// 移行してきた選手の初回だけの操作なので、開いた瞬間に取りに行くのではなく、
// 欄に触れたときに初めて呼ぶ（js/players.js）。
//
// 【上限を置いてあること】user_id を持つ行は「一度でもログインした人」全員で、
// 登録者が増えれば全選手とほぼ同じ数になる。この欄のためだけに全員を配らない。
// 溢れたかどうかを返すので、呼ぶ側は「多すぎて出しきれない」と伝えられる。
export async function loadMergeCandidates(limit = 200) {
  const { data, error } = await supabase
    .from('players')
    .select(PLAYER_LIST_COLUMNS)
    .not('user_id', 'is', null)
    .order('display_name')
    .limit(limit + 1);
  check(error, '統合候補の読み込み');

  const players = data.map(toPlayer);
  return { players: rememberPlayers(players.slice(0, limit)), hasMore: players.length > limit };
}

// 選手の検索。打った文字に当たった人だけをDBから受け取る。
//
// 【全選手を手元に持たないための唯一の経路】画面の検索欄は4か所ある
// （選手検索・運営の参加者選び・相方選び・運営の指名）。どれも以前は
// state.players を手元で絞っていて、そのために全行を配る必要があった。
// 新しい検索欄を作るときも、手元で絞らずここを通すこと。
//
// 当たったかどうかを見るのは players.search_text（生成列。名前・ゲームID・
// 過去名の直近2件を小文字でつないだもの。supabase/schema.sql を参照）。
// 大文字小文字の区別が無いのは、列の側で lower 済みだから。
//
// 取ってきた行は state.players に混ぜる（下の mergePlayers）。混ぜておくと、
// 名前を引くだけの箇所（getPlayerName など）が、検索で見かけた人を
// そのまま引けるようになる。
export async function searchPlayers(query, { includeBanned = false, limit = 50 } = {}) {
  const q = query.trim().toLowerCase();
  // 空欄では問い合わせない。戻りの形は当たったときと同じにしておく
  // ── ここだけ配列で返すと、呼ぶ側の分割代入（{ players }）が黙って undefined になる。
  if (!q) return { players: [], hasMore: false };

  // 【% と _ を潰すこと】ilike のワイルドカード。潰さないと、検索欄に「%」と
  // 打っただけで全員が返る（絞るための欄が、全件取得の入口になる）。
  const escaped = q.replace(/([\\%_])/g, '\\$1');

  let request = supabase
    .from('players')
    .select(PLAYER_LIST_COLUMNS)
    .ilike('search_text', `%${escaped}%`)
    .order('display_name')
    // 上限を置くのは、1文字だけ打たれたときに全員返るのを防ぐため。
    // 溢れたことは呼ぶ側に伝える（下の戻り値）ので、画面で「絞り込んでください」と出せる。
    .limit(limit + 1);

  // 利用停止中の選手は運営にだけ出す。解除する相手を探せる場所が
  // 選手検索しかないので、運営の画面からは消せない。
  if (!includeBanned) request = request.is('banned_at', null);

  const { data, error } = await request;
  check(error, '選手の検索');

  const players = data.map(toPlayer);
  const hasMore = players.length > limit;
  return { players: rememberPlayers(players.slice(0, limit)), hasMore };
}

// 消えた選手を手元からも外す。
//
// 【外さないと古い名前が残り続ける】state.players はもう loadAll が作り直さない
// （持っている行を上書きするだけ）。消された行はどこからも上書きされないので、
// 何もしなければ、消したはずの選手が名前付きで出続ける。
function forgetPlayer(playerId) {
  playerDetails.delete(playerId);
  const at = state.players.findIndex((p) => p.id === playerId);
  if (at !== -1) state.players.splice(at, 1);
}

// 取ってきた選手を state.players に混ぜ、混ぜたあとの行を返す。
//
// 既にある行は中身を更新する（作り直さない）。作り直すと、画面が掴んでいる
// 参照が古いものになり、そちらを見ている表示だけが更新から取り残される。
//
// 【下の mergePlayers（運営のアカウント統合）とは別物】あちらは2人の選手を
// DB上で1人にまとめる操作。こちらは取得結果を手元に覚えるだけ。
function rememberPlayers(players) {
  return players.map((incoming) => {
    const existing = state.players.find((p) => p.id === incoming.id);
    if (!existing) {
      state.players.push(withPlayerDetail(incoming));
      return state.players[state.players.length - 1];
    }
    // 詳細（自己紹介・SNS）は一覧の問い合わせでは取れていない。
    // 既に持っているものを、空で塗り潰さない。
    const { bio, snsX, snsTwitch, snsYoutube, detailLoaded, ...rest } = incoming;
    return Object.assign(existing, rest);
  });
}

// 選手ページ用。その選手の試合と出場記録だけを取る（全試合は読まない）。
// チーム戦の試合は選手IDが入っていないためここには含まれないが、
// 個人の通算成績にチーム戦を混ぜない方針なので、これで足りる。
export async function loadPlayerRecord(playerId) {
  const [matches, entries] = await Promise.all([
    supabase
      .from('matches')
      .select('*')
      .or(`winner_id.eq.${playerId},loser_id.eq.${playerId}`),
    loadPlayerEntries(playerId),
  ]);
  check(matches.error, '試合結果の読み込み');

  return { matches: matches.data.map(toMatch), entries };
}

// 選手の削除ガード用。試合結果か出場記録が1件でも残っているかを行を運ばずに数える。
export async function playerHasRecords(playerId) {
  const [m, e] = await Promise.all([
    supabase
      .from('matches')
      .select('id', { count: 'exact', head: true })
      .or(`winner_id.eq.${playerId},loser_id.eq.${playerId}`),
    supabase
      .from('tournament_entries')
      .select('tournament_id', { count: 'exact', head: true })
      .eq('player_id', playerId),
  ]);
  check(m.error, '試合記録の確認');
  check(e.error, '出場記録の確認');

  return { inMatches: (m.count ?? 0) > 0, inTournaments: (e.count ?? 0) > 0 };
}

// ---------------------------------------------------------------------------
// 選手
// ---------------------------------------------------------------------------

// 初回ログイン後のオンボーディングで呼ぶ。自分のアカウントに紐づく選手行を作る。
export async function createOwnPlayer(userId, profile) {
  const { data, error } = await supabase
    .from('players')
    .insert({ user_id: userId, ...toPlayerUpdate(profile) })
    .select()
    .single();
  check(error, '選手登録');
  return toPlayer(data);
}

// プロフィールの更新。本人か運営でなければRLSに弾かれる。
// role と user_id は列単位のGRANTで更新不可なので、ここから触れることはない。
//
// .select() を付けて実際に更新された行を確認している。RLSで弾かれたUPDATEは
// エラーではなく「0行更新」として成功で返るため、これが無いと何も保存されていないのに
// 「保存しました」と表示され、原因の分からない不具合になる。
export async function savePlayer(player) {
  // 【自己紹介とSNSを手元に持たないまま保存しないこと】起動時に取る行には
  // これらの列が入っていない（PLAYER_LIST_COLUMNS）。そのまま update すると、
  // 画面に出ていなかった自己紹介が null で上書きされて消える ── 書いた本人が
  // 選手ページを見るまで誰も気付かない。呼ぶ前に ensurePlayerDetail を通すこと。
  if (!player.detailLoaded) {
    throw new Error('プロフィールの読み込みが終わっていません。'
      + '画面を開き直してから、もう一度お試しください。');
  }

  const { data, error } = await supabase
    .from('players')
    .update(toPlayerUpdate(player))
    .eq('id', player.id)
    .select('id');
  check(error, 'プロフィールの保存');

  if (!data || data.length === 0) {
    throw new Error(
      'プロフィールが保存されませんでした。この選手を編集する権限がありません'
      + '（本人のアカウントでログインしているか確認してください）。',
    );
  }

  // 控えも今の値にする。ここを忘れると、保存直後の loadAll が
  // 古い控えを書き戻し、保存したはずの自己紹介が元に戻って見える。
  playerDetails.set(player.id, {
    bio: player.bio ?? '',
    snsX: player.snsX ?? '',
    snsTwitch: player.snsTwitch ?? '',
    snsYoutube: player.snsYoutube ?? '',
  });
}

export async function deletePlayer(playerId) {
  const { error } = await supabase.from('players').delete().eq('id', playerId);
  // 試合結果から参照されている選手は外部キー(on delete restrict)で守られている。
  // 画面側でも事前に止めているが、他端末が同時に試合を入れた場合はここで弾かれる。
  if (error?.code === '23503') {
    throw new Error('この選手は試合結果に記録されているため削除できません。');
  }
  check(error, '選手の削除');

  forgetPlayer(playerId);
}

// 運営権限の付け外し。roleは直接UPDATEできないのでRPC経由。
export async function setPlayerRole(playerId, role) {
  const { error } = await supabase.rpc('admin_set_player_role', {
    target_player_id: playerId,
    new_role: role,
  });
  check(error, '権限の変更');
}

// 代理登録されていた選手に、本人のアカウントを対応付ける。
export async function linkPlayerAccount(playerId, userId) {
  const { error } = await supabase.rpc('admin_link_player_account', {
    target_player_id: playerId,
    target_user_id: userId,
  });
  check(error, 'アカウントの対応付け');
}

// ---------------------------------------------------------------------------
// 通報と利用停止（BAN）
// ---------------------------------------------------------------------------

// 選手ページからの通報。
//
// 同じ相手への未対応の通報は1件までで、2回目はDB側の部分ユニーク索引に弾かれる
// （schema.sql の player_reports_open_uniq）。画面でもボタンを「通報済み」に
// 変えて止めているが、別のタブから押された場合はここに来る。
export async function reportPlayer(targetId, reporterId, reason, body) {
  const { error } = await supabase.from('player_reports').insert({
    target_id: targetId,
    reporter_id: reporterId,
    reason,
    body: body?.trim() || null,
  });
  if (error?.code === '23505') {
    throw new Error('この選手はすでに通報済みです。運営が確認するまでお待ちください。');
  }
  check(error, '通報の送信');
}

// 大会そのものへの通報。宛先はサイト全体の運営（その大会の運営には見えない）。
//
// 同じ大会への未対応の通報は1人1件までで、2回目はDB側の部分ユニーク索引に弾かれる
// （schema.sql の tournament_reports_open_uniq）。画面でも歯車の中身を
// 「通報済み」に変えて止めているが、別のタブから押された場合はここに来る。
//
// その大会の運営は通報できない（ポリシー側で弾く）。画面では歯車の中身が
// そもそも「大会情報を編集／削除」になっているので、普通は届かない。
export async function reportTournament(tournamentId, reporterId, reason, body) {
  const { error } = await supabase.from('tournament_reports').insert({
    tournament_id: tournamentId,
    reporter_id: reporterId,
    reason,
    body: body?.trim() || null,
  });
  if (error?.code === '23505') {
    throw new Error('この大会はすでに通報済みです。運営が確認するまでお待ちください。');
  }
  check(error, '通報の送信');
}

// 大会への通報を「見た。問題なし」として畳む（運営専用）。
// 大会そのものを消す場合はこれを呼ばなくてよい（消せば通報も cascade で消える）。
export async function dismissTournamentReports(tournamentId) {
  const { error } = await supabase.rpc('admin_dismiss_tournament_reports', {
    target_tournament_id: tournamentId,
  });
  check(error, '通報の取り下げ');
}

// 利用停止のオン・オフ。banned_at は列単位のGRANTから外してあるのでRPC経由。
// 停止しても解除しても、その人に届いていた未対応の通報はDB側でまとめて片付く。
export async function setPlayerBan(playerId, banned) {
  const { error } = await supabase.rpc('admin_set_player_ban', {
    target_player_id: playerId,
    p_banned: banned,
  });
  check(error, banned ? '利用停止' : '利用停止の解除');
}

// 通報を却下する（停止はしない）。見終えた印だけを付けて一覧から下ろす。
export async function dismissPlayerReports(playerId) {
  const { error } = await supabase.rpc('admin_dismiss_player_reports', {
    target_player_id: playerId,
  });
  check(error, '通報の却下');
}

// 本人が先に新規登録してしまい二重になった行を、戦績のある古い行へ統合する。
export async function mergePlayers(sourcePlayerId, targetPlayerId) {
  const { error } = await supabase.rpc('admin_merge_players', {
    source_player_id: sourcePlayerId,
    target_player_id: targetPlayerId,
  });
  check(error, '選手の統合');

  // 統合元の行はDB側で消える（admin_merge_players）。手元からも外す。
  forgetPlayer(sourcePlayerId);
}

// ---------------------------------------------------------------------------
// アイコン画像
// ---------------------------------------------------------------------------

const AVATAR_BUCKET = 'avatars';
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// アイコンは最大でも5rem（80px）の丸で出る。高精細画面を考えても512pxあれば足りる。
const AVATAR_MAX_DIMENSION = 512;

// アイコンをアップロードし、公開URLを返す。
// 保存先は avatars/{自分のuser_id}/... で固定する。Storage側のポリシーが
// 「先頭フォルダ名 = 自分のID」を要求しているので、他人のアイコンは差し替えられない。
export async function uploadAvatar(userId, file) {
  if (!AVATAR_TYPES.includes(file.type)) {
    throw new Error('画像はPNG / JPEG / WebP / GIF のいずれかにしてください。');
  }

  // 先に縮小してから容量を見る。スマホの写真はそのままだと数MBあるが、
  // 縮小後は数十KBに収まるので、この順なら「大きすぎます」で弾かれずに済む。
  const upload = await downscaleImage(file, AVATAR_MAX_DIMENSION);
  if (upload.size > AVATAR_MAX_BYTES) {
    throw new Error('画像のサイズは2MBまでにしてください。');
  }

  // 同じ名前で上書きするとCDNに古い画像が残るため、毎回別名で入れる
  const ext = (upload.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${userId}/${Date.now()}.${ext || 'png'}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, upload, { contentType: upload.type, upsert: false });
  if (error) {
    console.error('[db] アイコンのアップロードに失敗', error);
    throw new Error(`アイコンのアップロードに失敗しました: ${error.message}`);
  }

  const { data } = supabase.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// 古いアイコンを消す。自分のバケット内のURLでなければ何もしない。
// 失敗しても本体の保存は済んでいるので、呼び出し側は無視してよい。
export async function removeAvatarByUrl(url) {
  if (!url) return;
  const marker = `/${AVATAR_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return;
  const path = url.slice(index + marker.length).split('?')[0];
  await supabase.storage.from(AVATAR_BUCKET).remove([decodeURIComponent(path)]);
}

// ---------------------------------------------------------------------------
// 大会・お知らせの画像
//
// アイコンと違い、書き込めるのは運営だけ（Storageのポリシーが is_admin() を要求）。
// バナー用途なので上限を少し大きめ（5MB）にしている。
// ---------------------------------------------------------------------------

const IMAGE_BUCKET = 'images';
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
// 詳細ページのヘッダーで最大22rem（352px）、一覧のカードでは160〜260px。
// 高精細画面でも足りるよう長辺1600pxまでに収める。
const IMAGE_MAX_DIMENSION = 1600;

// 画像をアップロードして公開URLを返す。folder は 'tournaments' / 'announcements' など。
export async function uploadImage(file, folder = 'misc') {
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error('画像はPNG / JPEG / WebP / GIF のいずれかにしてください。');
  }

  // 先に縮小してから容量を見る（uploadAvatar と同じ理由）
  const upload = await downscaleImage(file, IMAGE_MAX_DIMENSION);
  if (upload.size > IMAGE_MAX_BYTES) {
    throw new Error('画像のサイズは5MBまでにしてください。');
  }

  const ext = (upload.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext || 'png'}`;

  const { error } = await supabase.storage
    .from(IMAGE_BUCKET)
    .upload(path, upload, { contentType: upload.type, upsert: false });
  if (error) {
    console.error('[db] 画像のアップロードに失敗', error);
    throw new Error(`画像のアップロードに失敗しました: ${error.message}`);
  }

  const { data } = supabase.storage.from(IMAGE_BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// 使われなくなった画像を消す。images バケットのURLでなければ何もしない。
// 失敗しても本体の保存は済んでいるので、呼び出し側は無視してよい。
export async function removeImageByUrl(url) {
  if (!url) return;
  const marker = `/${IMAGE_BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return;
  const path = url.slice(index + marker.length).split('?')[0];
  await supabase.storage.from(IMAGE_BUCKET).remove([decodeURIComponent(path)]);
}

// ---------------------------------------------------------------------------
// 大会
// ---------------------------------------------------------------------------

export async function createTournament(tournament) {
  const { data, error } = await supabase
    .from('tournaments')
    .insert({
      id: tournament.id,
      name: tournament.name,
      date: tournament.date || null,
      format: tournament.format ?? 'single_elim',
      match_type: tournament.matchType || null,
      match_type_note: tournament.matchTypeNote || null,
      ranking_opt_in: tournament.rankingOptIn !== false,
      rules: tournament.rules || null,
      image_url: tournament.imageUrl || null,
      stream_url: tournament.streamUrl || null,
      third_place_match: Boolean(tournament.thirdPlaceMatch),
      status: tournament.status ?? 'draft',
      capacity: tournament.capacity ?? null,
      entry_deadline: tournament.entryDeadline || null,
      weight: tournament.weight ?? null,
      created_by: tournament.createdBy ?? null,
    })
    .select()
    .single();
  check(error, '大会の作成');
  return data;
}

export async function saveTournament(tournament) {
  const { error } = await supabase
    .from('tournaments')
    .update({
      name: tournament.name,
      date: tournament.date || null,
      match_type: tournament.matchType || null,
      match_type_note: tournament.matchTypeNote || null,
      ranking_opt_in: tournament.rankingOptIn !== false,
      rules: tournament.rules || null,
      image_url: tournament.imageUrl || null,
      stream_url: tournament.streamUrl || null,
      third_place_match: Boolean(tournament.thirdPlaceMatch),
      status: tournament.status,
      capacity: tournament.capacity ?? null,
      entry_deadline: tournament.entryDeadline || null,
    })
    .eq('id', tournament.id);
  check(error, '大会の保存');
}

// この大会の運営を、渡された顔ぶれちょうどに揃える。
//
// 消してから入れ直すのではなく差分で当てる。全消しにすると、消した直後の一瞬だけ
// 運営が0人になり、そのときに走った書き込み（Realtimeで届いた別の操作など）が
// RLSに弾かれる。作った本人は必ず残す ── 自分を外すと自分の大会を編集できなくなり、
// サイト全体の運営に頼むしかなくなるため（呼び出し側でも外せないようにしてある）。
export async function setTournamentOrganizers(tournamentId, playerIds) {
  const wanted = [...new Set(playerIds.filter(Boolean))];

  const { data, error } = await supabase
    .from('tournament_organizers')
    .select('player_id')
    .eq('tournament_id', tournamentId);
  check(error, '大会運営の読み込み');

  const current = data.map((r) => r.player_id);
  const toAdd = wanted.filter((id) => !current.includes(id));
  const toRemove = current.filter((id) => !wanted.includes(id));

  if (toAdd.length) {
    const { error: insertError } = await supabase
      .from('tournament_organizers')
      .insert(toAdd.map((playerId) => ({ tournament_id: tournamentId, player_id: playerId })));
    check(insertError, '大会運営の追加');
  }
  if (toRemove.length) {
    const { error: deleteError } = await supabase
      .from('tournament_organizers')
      .delete()
      .eq('tournament_id', tournamentId)
      .in('player_id', toRemove);
    check(deleteError, '大会運営の削除');
  }
}

export async function setTournamentStatus(tournamentId, status) {
  const { error } = await supabase.from('tournaments').update({ status }).eq('id', tournamentId);
  check(error, '大会状態の変更');
}

// ブラケット・試合・エントリーは外部キーのON DELETE CASCADEで一緒に消える。
export async function deleteTournament(tournamentId) {
  const { error } = await supabase.from('tournaments').delete().eq('id', tournamentId);
  check(error, '大会の削除');
}

// ---------------------------------------------------------------------------
// エントリー
// ---------------------------------------------------------------------------

// 募集中の大会に自分でエントリーする。定員超過はDBのトリガーが弾く
// （クライアント側で残枠を確認してからINSERTする方式は、同時に押されると両方通ってしまう）。
export async function enterTournament(tournamentId, playerId) {
  const { error } = await supabase
    .from('tournament_entries')
    .insert({ tournament_id: tournamentId, player_id: playerId });

  if (error?.code === '23505') throw new Error('すでにエントリー済みです。');
  if (error?.message?.includes('定員')) throw new Error('この大会は定員に達しています。');
  check(error, 'エントリー');
}

export async function cancelEntry(tournamentId, playerId) {
  const { error } = await supabase
    .from('tournament_entries')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('player_id', playerId);
  check(error, 'エントリーの取り消し');
}

// チーム戦（2v2）のエントリー。チーム行とメンバー2人のエントリー行を1回で作る。
//
// RLSの entries_insert は「自分の選手行だけ」しか挿入させないので、相方の行を
// 入れるにはRPCを通すしかない。定員（チーム数）の検査も関数の中で行われる。
export async function enterTournamentAsTeam(tournamentId, teamName, memberIds) {
  const { data, error } = await supabase.rpc('enter_tournament_as_team', {
    p_tournament_id: tournamentId,
    p_team_name: teamName,
    p_member_ids: memberIds,
  });
  checkRpc(error, 'チームでのエントリー');
  return data;
}

// チームのエントリー取り消し。メンバーなら誰でも取り消せる（募集中のみ）。
// メンバーのエントリー行は team_id の ON DELETE CASCADE で一緒に消える。
export async function cancelTeamEntry(teamId) {
  const { error } = await supabase.rpc('cancel_team_entry', { p_team_id: teamId });
  checkRpc(error, 'チームのエントリー取り消し');
}

// 募集締切時に、確定したチームのシード順を書き込む（seededTeamIds[0] が第1シード）。
// チームのシードは tournament_entries ではなく tournament_teams に持つ。
//
// upsert に name も載せるのは、not null 列を欠いた行を作れないため。既存行との衝突は
// 主キー(id)で先に解決されるので、(tournament_id, name) の一意制約には触れない。
export async function saveTeamSeeds(tournamentId, seededTeamIds) {
  const tournament = findTournament(tournamentId);
  const rows = seededTeamIds.map((teamId, index) => {
    const team = tournament?.teams.find((tm) => tm.id === teamId);
    if (!team) throw new Error('シードを付けるチームが見つかりません。画面を再読み込みしてください。');
    return { id: teamId, tournament_id: tournamentId, name: team.name, seed: index + 1 };
  });
  const { error } = await supabase
    .from('tournament_teams')
    .upsert(rows, { onConflict: 'id' });
  check(error, 'シードの保存');
}

// 募集締切時に、確定したシード順をまとめて書き込む（seededPlayerIds[0] が第1シード）。
export async function saveSeeds(tournamentId, seededPlayerIds) {
  const rows = seededPlayerIds.map((playerId, index) => ({
    tournament_id: tournamentId,
    player_id: playerId,
    seed: index + 1,
  }));
  const { error } = await supabase
    .from('tournament_entries')
    .upsert(rows, { onConflict: 'tournament_id,player_id' });
  check(error, 'シードの保存');
}

// 運営が参加者を直接指定する場合（募集を使わず大会を立てるとき）。個人戦専用。
// チーム戦はチーム編成が必要なため、この経路は使わない（大会作成画面で弾いている）。
//
// 「全部消してから入れ直す」順序にしてはいけない。挿入側が失敗すると削除だけが残り、
// 参加者0人の大会ができてしまう（実際にこの不具合が起きた）。
// 先に入れてから不要な行を削る順序なら、途中で失敗しても元の参加者は残る。
export async function replaceEntries(tournamentId, seededPlayerIds) {
  if (seededPlayerIds.length > 0) {
    await saveSeeds(tournamentId, seededPlayerIds);
  }

  let query = supabase.from('tournament_entries').delete().eq('tournament_id', tournamentId);
  if (seededPlayerIds.length > 0) {
    query = query.not('player_id', 'in', `(${seededPlayerIds.join(',')})`);
  }
  const { error } = await query;
  check(error, '参加者の更新');
}

// ---------------------------------------------------------------------------
// ブラケットと試合
// ---------------------------------------------------------------------------

// 読み込んだ時点の brackets.updated_at。
//
// 対戦表は運営が手元のコピーを丸ごと書き戻す作りなので、その間に選手が結果を
// 確定させていると（report_match_result はDB側で直接反映する）、気づかずに
// 上書きして消してしまう。書き戻す直前にこの版数を突き合わせて、DB側が進んで
// いれば保存を中断する。
const bracketVersions = {};   // tournamentId -> updated_at

// 1大会分の対戦表を取りに行き、state のキャッシュに載せる。
// loadAll は中身を持ってこないので、対戦表を開くときはここを通す。
//
// 一度読めば以後の loadAll が中身も取り直すため、開いている間は最新に保たれる。
export async function loadBracket(tournamentId) {
  if (state.brackets[tournamentId]) return state.brackets[tournamentId];
  // 対戦表がまだ組まれていない大会は問い合わせるまでもない
  if (!state.bracketIds.has(tournamentId)) return null;

  const { data, error } = await supabase
    .from('brackets')
    .select('data, updated_at')
    .eq('tournament_id', tournamentId)
    .maybeSingle();
  check(error, 'ブラケットの読み込み');

  if (!data) return null;
  state.brackets[tournamentId] = data.data;
  bracketVersions[tournamentId] = data.updated_at;
  return data.data;
}

export async function saveBracket(tournamentId, bracket) {
  const { data, error } = await supabase
    .from('brackets')
    .upsert({ tournament_id: tournamentId, data: bracket }, { onConflict: 'tournament_id' })
    .select('updated_at')
    .single();
  check(error, 'ブラケットの保存');
  // 自分の保存で版数が進むので、次の保存のために覚え直す
  bracketVersions[tournamentId] = data.updated_at;
}

// 手元のコピーが最新かを確かめる。DB側が先に進んでいたら保存させない。
//
// 「確定済みの試合が増えているか」で判定してはいけない。運営が結果の確定を
// 取り消す操作（editMatch）でも、手元だけ未確定に戻った状態になるため、
// 正しい操作を誤検知してしまう。版数で見れば操作の向きに依らない。
async function assertBracketUnchanged(tournamentId) {
  const known = bracketVersions[tournamentId];
  if (!known) return;   // まだ一度も読んでいない（生成直後など）

  const { data, error } = await supabase
    .from('brackets')
    .select('updated_at')
    .eq('tournament_id', tournamentId)
    .maybeSingle();
  check(error, '対戦表の照合');

  if (data && data.updated_at !== known) {
    throw new Error(
      '対戦表が別の場所で更新されています（選手が結果を確定させた可能性があります）。'
      + '画面を再読み込みして、最新の状態から操作してください。',
    );
  }
}

// ブラケットの操作（勝敗の確定・取り消し）を1回で保存する。
//
// js/bracket.js の confirmMatch / editMatch は in-memory の state を書き換えるだけで、
// 「どの試合が増えたか・減ったか」を返さない。取り消しは次ラウンド以降へ連鎖することも
// あるため、差分を追いかけるより、その大会の試合をDBと突き合わせて揃えるほうが確実。
// 1大会の試合は多くても数十件なので、毎回の照合でも十分に軽い。
export async function syncTournamentProgress(tournamentId) {
  await assertBracketUnchanged(tournamentId);
  await saveBracket(tournamentId, state.brackets[tournamentId]);

  const { data, error } = await supabase
    .from('matches')
    .select('id')
    .eq('tournament_id', tournamentId);
  check(error, '試合結果の照合');

  const remoteIds = new Set(data.map((r) => r.id));
  const localMatches = state.matches.filter((m) => m.tournamentId === tournamentId);
  const localIds = new Set(localMatches.map((m) => m.id));

  const toInsert = localMatches.filter((m) => !remoteIds.has(m.id));
  const toDelete = [...remoteIds].filter((id) => !localIds.has(id));

  if (toInsert.length) {
    const { error: insertError } = await supabase.from('matches').insert(toInsert.map(fromMatch));
    check(insertError, '試合結果の保存');
  }
  if (toDelete.length) {
    const { error: deleteError } = await supabase.from('matches').delete().in('id', toDelete);
    check(deleteError, '試合結果の取り消し');
  }
}

// ---------------------------------------------------------------------------
// 確定した成績
//
// 運営が「結果を確定する」を押した時点の順位を、エントリー行に書き込んでおく。
// こうしておけば選手ページやランキングが対戦表を読まずに済む（loadAll のコメント参照）。
// 書けるのは運営だけ（RLSの entries_update が is_admin() を要求する）。
// ---------------------------------------------------------------------------

// placements は [{ entrantId, depth }]。depth は優勝=1、準優勝=2、ベストN=N。
// entrantId は個人戦なら選手ID、チーム戦ならチームID。
//
// チーム戦では、チーム行に書いたうえで同じ値をメンバー全員のエントリー行へ写す。
// 二重に持つことになるが、こうしておくと選手ページ・ランキングカードが
// チームの存在を一切知らずに「優勝」「ベスト4」を出せる。
//
// seed / team_id 列は送らないので、既に入っている値はそのまま残る。
export async function saveEntryPlacements(tournamentId, placements) {
  if (placements.length === 0) return;
  const tournament = findTournament(tournamentId);

  if (isTeamTournament(tournament)) {
    const teamRows = placements.map(({ entrantId, depth }) => {
      const team = tournament.teams.find((tm) => tm.id === entrantId);
      if (!team) throw new Error('成績を記録するチームが見つかりません。画面を再読み込みしてください。');
      return { id: entrantId, tournament_id: tournamentId, name: team.name, placement: depth };
    });
    const { error } = await supabase
      .from('tournament_teams')
      .upsert(teamRows, { onConflict: 'id' });
    check(error, '最終順位の保存');
  }

  const rows = placements.flatMap(({ entrantId, depth }) =>
    getEntrantMemberIds(tournamentId, entrantId).map((playerId) => ({
      tournament_id: tournamentId,
      player_id: playerId,
      placement: depth,
    })));
  const { error } = await supabase
    .from('tournament_entries')
    .upsert(rows, { onConflict: 'tournament_id,player_id' });
  check(error, '最終順位の保存');
}

// 確定を取り消したとき用。順位を消しておかないと、進行中に戻したはずの大会の
// 成績が選手ページに残り続ける。
export async function clearEntryPlacements(tournamentId) {
  const { error } = await supabase
    .from('tournament_entries')
    .update({ placement: null })
    .eq('tournament_id', tournamentId);
  check(error, '最終順位の取り消し');

  const { error: teamError } = await supabase
    .from('tournament_teams')
    .update({ placement: null })
    .eq('tournament_id', tournamentId);
  check(teamError, '最終順位の取り消し');
}

// ---------------------------------------------------------------------------
// 回戦の開始と配信台
//
// 選手がゲームカウントを入力できるのは、運営がその回戦を開始してから。
// 配信台（配信に乗せる試合）は任意で、決めなくても開始できる。
// ここで作れるのは運営だけ（RLS）。
// ---------------------------------------------------------------------------

// 配信台に乗せる試合を決める。基本は1つだが、全試合を配信する大会もあるので配列。
export async function saveRoundStream(tournamentId, roundIndex, matchIds) {
  const { error } = await supabase
    .from('tournament_rounds')
    .upsert(
      { tournament_id: tournamentId, round_index: roundIndex, streamed_match_ids: matchIds },
      { onConflict: 'tournament_id,round_index' },
    );
  check(error, '配信台の保存');
}

// ルームコードの記入・書き直し。書けるのは当事者と運営（RLSが判定を持つ）。
export async function saveMatchRoomCode(tournamentId, matchId, code, playerId) {
  const { error } = await supabase
    .from('match_room_codes')
    .upsert(
      {
        tournament_id: tournamentId,
        match_id: matchId,
        code,
        set_by: playerId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'tournament_id,match_id' },
    );
  check(error, 'ルームコードの保存');
}

// ルームコードを消す（空欄で保存したとき）。
export async function clearMatchRoomCode(tournamentId, matchId) {
  const { error } = await supabase
    .from('match_room_codes')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('match_id', matchId);
  check(error, 'ルームコードの削除');
}

// 回戦を開始する。配信台は未定のままでもよい（配信しない大会もある）。
//
// UPDATEではなくUPSERT。配信台を一度も決めていない回戦にはまだ行が無く、
// UPDATEだと0行で「成功」して、選手の画面が開かないまま運営だけが
// 開始したつもりになる。streamed_match_ids は送らないので、既に決めてある
// 配信台はそのまま残る。
export async function startRound(tournamentId, roundIndex, adminPlayerId) {
  const { error } = await supabase
    .from('tournament_rounds')
    .upsert(
      {
        tournament_id: tournamentId,
        round_index: roundIndex,
        started_at: new Date().toISOString(),
        started_by: adminPlayerId,
      },
      { onConflict: 'tournament_id,round_index' },
    );
  check(error, '回戦の開始');
}

// 開始を取り消す。押し間違い用。
export async function stopRound(tournamentId, roundIndex) {
  const { error } = await supabase
    .from('tournament_rounds')
    .update({ started_at: null, started_by: null })
    .eq('tournament_id', tournamentId)
    .eq('round_index', roundIndex);
  check(error, '開始の取り消し');
}

// ---------------------------------------------------------------------------
// 選手が入力するゲームカウント
//
// 選手は brackets に直接書けない（brackets_write は運営限定）。ここを緩めると
// 対戦表を丸ごと書き換えられてしまうので、確定の処理はDB側の関数に閉じ込めてある。
// 当事者のどちらが入力しても、その場で確定する（相手の承認は挟まない）。
// 食い違いは対戦チャットの「運営に報告」から運営に伝えてもらい、運営が直す。
// ---------------------------------------------------------------------------

// score は "3-1" 形式で、左が player1Id 側（対戦表の上の行）。
export async function reportMatchResult(tournamentId, matchId, score, winnerEntrantId) {
  const { error } = await supabase.rpc('report_match_result', {
    p_tournament_id: tournamentId,
    p_match_id: matchId,
    p_score: score,
    p_winner_entrant_id: winnerEntrantId,
  });
  checkRpc(error, 'ゲームカウントの入力');
}

// ---------------------------------------------------------------------------
// 対戦カードごとのチャット
//
// 読み書きできるのは その試合の当事者と運営だけ。判定はすべてDB側のポリシー
// （can_use_match_chat）が行うので、ここでは普通に問い合わせるだけでよい。
// 権限が無ければ 0件が返るか、書き込みが弾かれる。
//
// state には載せない。全データを持ち回る他のものと違い、チャットは開いている
// 1部屋しか要らず、他人の部屋は取得できてもいけないため。
// ---------------------------------------------------------------------------

// 1部屋分のメッセージを古い順に取る。sinceId を渡すと、それ以降の分だけを取る
// （開いている間の差分取得。毎回全件を取り直さないため）。
export async function loadMatchChat(tournamentId, matchId, since = null) {
  let query = supabase
    .from('match_chat_messages')
    .select('*')
    .eq('tournament_id', tournamentId)
    .eq('match_id', matchId)
    .order('created_at', { ascending: true });

  if (since) query = query.gt('created_at', since);

  const { data, error } = await query;
  check(error, 'チャットの読み込み');

  return data.map((row) => ({
    id: row.id,
    playerId: row.player_id,
    body: row.body,
    createdAt: row.created_at,
  }));
}

export async function sendMatchChatMessage(tournamentId, matchId, playerId, body) {
  const { error } = await supabase.from('match_chat_messages').insert({
    tournament_id: tournamentId,
    match_id: matchId,
    player_id: playerId,
    body,
  });

  // ポリシーで弾かれた場合、RLSは「権限が無い」としか言わない。ここで届く経路は
  // ほぼ「試合が確定して書けなくなった」なので、その旨を出す。
  if (error?.code === '42501') {
    throw new Error('この対戦はすでに結果が確定しているため、書き込めません。');
  }
  check(error, 'メッセージの送信');
}

// 不適切な発言の取り消し。運営だけが通る（RLSの chat_delete）。
export async function deleteMatchChatMessage(messageId) {
  const { error } = await supabase.from('match_chat_messages').delete().eq('id', messageId);
  check(error, 'メッセージの削除');
}

// ---------------------------------------------------------------------------
// チャットからの運営への報告
// ---------------------------------------------------------------------------

export async function reportMatchChat(tournamentId, matchId, reporterId, body) {
  const { error } = await supabase.from('match_chat_reports').insert({
    tournament_id: tournamentId,
    match_id: matchId,
    reporter_id: reporterId,
    body,
  });
  check(error, '運営への報告');
}

export async function resolveChatReport(reportId, adminPlayerId) {
  const { error } = await supabase
    .from('match_chat_reports')
    .update({ resolved_at: new Date().toISOString(), resolved_by: adminPlayerId })
    .eq('id', reportId);
  check(error, '報告の対応済み');
}

// 報告だけを取り直す。
//
// 全件取得（loadAll）の保険は15分間隔なので、それ待ちでは運営に報告が届くのが遅い。
// かといってチャットと同じ理由でRealtimeには載せられないため、報告だけを短い間隔で
// 見に行く。行数はごく少なく、RLSで運営と本人以外には0件しか返らない。
//
// 戻り値: 未対応の顔ぶれが前回から変わったか（変わったときだけ画面を描き直す）。
export async function refreshChatReports() {
  const { data, error } = await supabase
    .from('match_chat_reports')
    .select('*')
    .order('created_at', { ascending: false });
  check(error, '報告の読み込み');

  const signature = (list) => list
    .map((r) => `${r.id}:${r.resolvedAt ? 1 : 0}`)
    .join(',');

  const before = signature(state.chatReports);
  state.chatReports = data.map(toChatReport);
  return signature(state.chatReports) !== before;
}

// ---------------------------------------------------------------------------
// ランキングの公開
// ---------------------------------------------------------------------------

// 公開のたびに1行追加する（上書きではない）。過去に何をいつ公開したかが残る。
// period_months はもう書き込まない（カレンダーの開始日・終了日に置き換わったため）。
export async function publishRanking(snapshot) {
  const { error } = await supabase.from('published_rankings').insert({
    published_at: snapshot.publishedAt,
    period_start: snapshot.periodStart,
    period_end: snapshot.periodEnd,
    data: { rankings: snapshot.rankings },
  });
  check(error, 'ランキングの公開');
}

// ---------------------------------------------------------------------------
// お知らせ（ホーム画面）
//
// 投稿・編集・削除はRLSで運営だけに絞られている。created_by は本人の選手行。
// ---------------------------------------------------------------------------

export async function createAnnouncement({ title, body, imageUrl, pinned, createdBy }) {
  const { data, error } = await supabase
    .from('announcements')
    .insert({
      title,
      body: body ?? '',
      image_url: imageUrl || null,
      pinned: Boolean(pinned),
      created_by: createdBy ?? null,
    })
    .select()
    .single();
  check(error, 'お知らせの投稿');
  return toAnnouncement(data);
}

export async function updateAnnouncement(id, { title, body, imageUrl, pinned }) {
  const { data, error } = await supabase
    .from('announcements')
    .update({ title, body: body ?? '', image_url: imageUrl || null, pinned: Boolean(pinned) })
    .eq('id', id)
    .select('id');
  check(error, 'お知らせの更新');
  // RLSで弾かれたUPDATEは0行の「成功」で返るため、更新された行を確認する
  if (!data || data.length === 0) {
    throw new Error('お知らせを更新できませんでした。運営権限が必要です。');
  }
}

export async function deleteAnnouncement(id) {
  const { error } = await supabase.from('announcements').delete().eq('id', id);
  check(error, 'お知らせの削除');
}

// ---------------------------------------------------------------------------
// Realtime
//
// 10秒ごとのポーリング（旧 app.js の autoRefresh）の置き換え。進行中の大会を
// 見ている観戦者へ、勝敗が入った瞬間に変更がプッシュされる。
// ---------------------------------------------------------------------------

let channel = null;
let realtimeConnected = false;
let changeTimer = null;

// 購読するテーブルと、それが変わったときに取り直す state の部位（ALL_PARTS を参照）。
//
// 大会・エントリー・チームが同じ部位を指しているのは、この3つが1つの組み立てを
// 共有しているため（loadAll のコメント参照）。逆に、試合結果が入っただけのときに
// 選手やお知らせまで取り直す必要はない ── 進行中の大会は勝敗が入るたびに
// 観戦者全員がこの通知を受けるので、そこで全テーブルを引くと人数分だけ通信が膨らむ。
const PART_BY_TABLE = {
  players: 'players',
  tournaments: 'tournaments',
  tournament_entries: 'tournaments',
  tournament_teams: 'tournaments',
  brackets: 'brackets',
  matches: 'matches',
  tournament_rounds: 'rounds',
  tournament_organizers: 'organizers',
  match_room_codes: 'roomCodes',
  published_rankings: 'ranking',
  announcements: 'announcements',
};

// 変更のプッシュが今ちゃんと届く状態か。
//
// 呼び出し側は、これが真の間は保険の全件取得を控えてよい（無駄な通信を減らす）。
// WebSocketが黙って切れる事故はあるが、supabase-jsが25秒ごとにハートビートを
// 送っていて、応答が無ければ SUBSCRIBED から外れるので、この値で判断できる。
export function isRealtimeConnected() {
  return realtimeConnected;
}

// いずれかのテーブルが変わったら onChange(parts) を呼ぶ。短時間に複数の変更が届いても
// まとめて1回で済むよう、少しだけ待ってから通知する。
//
// parts は「変わったテーブルに対応する部位」の配列で、そのまま loadAll に渡せる。
// 待っているあいだに別のテーブルの変更が届いたら部位を足していくので、
// 1回の勝敗確定でブラケットと試合結果が同時に動いても、取り直しは1往復で済む。
export function subscribeToChanges(onChange, debounceMs = 400) {
  unsubscribeFromChanges();

  let pending = new Set();
  const notify = (table) => {
    pending.add(PART_BY_TABLE[table]);
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => {
      const parts = [...pending];
      pending = new Set();
      onChange(parts);
    }, debounceMs);
  };

  channel = supabase.channel('app-data');
  Object.keys(PART_BY_TABLE).forEach((table) => {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => notify(table));
  });

  // status は SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED のいずれか
  channel.subscribe((status) => {
    realtimeConnected = status === 'SUBSCRIBED';
  });
}

export function unsubscribeFromChanges() {
  realtimeConnected = false;
  // 待機中の通知は捨てる。購読をやめたあとに古い onChange が動くのを防ぐ。
  clearTimeout(changeTimer);
  changeTimer = null;
  if (!channel) return;
  supabase.removeChannel(channel);
  channel = null;
}
