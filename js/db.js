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
    role: row.role ?? 'player',
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

function toTournament(row, { entrantIds, participantIds, teams }) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    format: row.format,
    // ランキング反映の条件判定に使う対戦方法（js/rankingEligibility.js）。
    // この機能より前に作られた大会は null で、対象外として扱われる。
    matchType: row.match_type,
    matchTypeNote: row.match_type_note ?? '',
    rules: row.rules,
    imageUrl: row.image_url ?? '',
    weight: row.weight,
    status: row.status,
    capacity: row.capacity,
    createdBy: row.created_by,
    // 出場枠と出場した人。個人戦では同じ配列になる（js/state.js の説明を参照）
    entrantIds,
    participantIds,
    teams,
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

function toResultReport(row) {
  return {
    tournamentId: row.tournament_id,
    matchId: row.match_id,
    reportedBy: row.reported_by,
    reporterPlayerId: row.reporter_player_id,
    score: row.score,
    winnerEntrantId: row.winner_entrant_id,
    createdAt: row.created_at,
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

// 全データを取得して state を丸ごと差し替える。認証は不要（RLSがSELECTを全員に許可）。
// 途中で失敗しても中途半端な表示にならないよう、全部揃ってから state に入れる。
//
// ブラケットだけは中身を持ってこない。JSONBが1大会あたり数KB〜数十KBあり、
// 全大会分となるとこの読み込みの大半を占めるのに、使うのは対戦表を開いた1大会だけだから。
// ここでは「どの大会に対戦表があるか」のIDだけを取り、中身は loadBracket で取りに行く。
// 順位（優勝/準優勝/ベストN）は tournament_entries.placement に保存済みなので、
// 一覧や選手ページはブラケットが無くてもこれまで通り表示できる。
export async function loadAll() {
  // 既に開いている対戦表は中身も取り直す。Realtimeで勝敗が届いたときに
  // 見ている表がその場で更新されるようにするため（通常は0件か1件）。
  const openBracketIds = Object.keys(state.brackets);

  const [players, tournaments, teams, entries, bracketIds, openBrackets, matches, ranking,
    announcements, reports, resultReports, rounds, roomCodes] = await Promise.all([
    supabase.from('players').select('*').order('display_name'),
    supabase.from('tournaments').select('*').order('date', { ascending: true, nullsFirst: false }),
    supabase.from('tournament_teams').select('*'),
    supabase.from('tournament_entries').select('*'),
    supabase.from('brackets').select('tournament_id'),
    openBracketIds.length > 0
      ? supabase.from('brackets').select('tournament_id, data, updated_at').in('tournament_id', openBracketIds)
      : Promise.resolve({ data: [], error: null }),
    supabase.from('matches').select('*'),
    // スナップショットは最新の1件だけ使う（過去の公開履歴は残しておく）
    supabase.from('published_rankings').select('*').order('published_at', { ascending: false }).limit(1),
    // 固定を先頭に、あとは新しい順
    supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }),
    // RLSにより、運営には全件・一般の選手には自分の分だけ・ゲストには0件が返る
    supabase.from('match_chat_reports').select('*').order('created_at', { ascending: false }),
    // 承認待ちのゲームカウント。当事者と運営にしか返らない
    supabase.from('match_result_reports').select('*'),
    // 回戦ごとの開始と配信台。誰でも見られる
    supabase.from('tournament_rounds').select('*'),
    // 対戦ごとのルームコード。当事者と運営にしか返らない
    supabase.from('match_room_codes').select('*'),
  ]);

  check(players.error, '選手の読み込み');
  check(tournaments.error, '大会の読み込み');
  check(teams.error, 'チームの読み込み');
  check(entries.error, 'エントリーの読み込み');
  check(bracketIds.error, 'ブラケットの読み込み');
  check(openBrackets.error, 'ブラケットの読み込み');
  check(matches.error, '試合結果の読み込み');
  check(ranking.error, 'ランキングの読み込み');
  check(announcements.error, 'お知らせの読み込み');
  check(reports.error, '報告の読み込み');
  check(resultReports.error, '承認待ちの結果の読み込み');
  check(rounds.error, '回戦の読み込み');
  check(roomCodes.error, 'ルームコードの読み込み');

  // 大会ごとにエントリーとチームをまとめ、出場枠の並び（シード順、未確定なら登録順）を作る。
  // 成績はチーム戦でもメンバーの行に書き写してあるので、ここは選手IDのままでよい
  // （選手ページはチームの存在を知らずに済む）。
  const entriesByTournament = new Map();
  const teamsByTournament = new Map();
  const placementsByTournament = {};

  entries.data.forEach((e) => {
    if (!entriesByTournament.has(e.tournament_id)) entriesByTournament.set(e.tournament_id, []);
    entriesByTournament.get(e.tournament_id).push(e);

    if (e.placement == null) return;
    if (!placementsByTournament[e.tournament_id]) placementsByTournament[e.tournament_id] = {};
    placementsByTournament[e.tournament_id][e.player_id] = e.placement;
  });

  teams.data.forEach((t) => {
    if (!teamsByTournament.has(t.tournament_id)) teamsByTournament.set(t.tournament_id, []);
    teamsByTournament.get(t.tournament_id).push(t);
  });

  // 取り直した分だけをキャッシュに残す。消された大会のブラケットもここで落ちる。
  // 版数も一緒に更新しておかないと、次の保存が「DB側が進んでいる」と誤検知する。
  const bracketsById = {};
  openBrackets.data.forEach((b) => {
    bracketsById[b.tournament_id] = b.data;
    bracketVersions[b.tournament_id] = b.updated_at;
  });

  const snapshot = ranking.data?.[0];

  state.players = players.data.map(toPlayer);
  state.tournaments = tournaments.data.map((t) => toTournament(
    t,
    buildEntrants(teamsByTournament.get(t.id) ?? [], entriesByTournament.get(t.id) ?? []),
  ));
  state.matches = matches.data.map(toMatch);
  state.brackets = bracketsById;
  state.bracketIds = new Set(bracketIds.data.map((b) => b.tournament_id));
  state.placements = placementsByTournament;
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
  state.announcements = announcements.data.map(toAnnouncement);
  state.chatReports = reports.data.map(toChatReport);
  state.resultReports = resultReports.data.map(toResultReport);
  state.rounds = rounds.data.map(toRound);
  state.roomCodes = roomCodes.data.map(toRoomCode);
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
}

export async function deletePlayer(playerId) {
  const { error } = await supabase.from('players').delete().eq('id', playerId);
  // 試合結果から参照されている選手は外部キー(on delete restrict)で守られている。
  // 画面側でも事前に止めているが、他端末が同時に試合を入れた場合はここで弾かれる。
  if (error?.code === '23503') {
    throw new Error('この選手は試合結果に記録されているため削除できません。');
  }
  check(error, '選手の削除');
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

// 本人が先に新規登録してしまい二重になった行を、戦績のある古い行へ統合する。
export async function mergePlayers(sourcePlayerId, targetPlayerId) {
  const { error } = await supabase.rpc('admin_merge_players', {
    source_player_id: sourcePlayerId,
    target_player_id: targetPlayerId,
  });
  check(error, '選手の統合');
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
      rules: tournament.rules || null,
      image_url: tournament.imageUrl || null,
      status: tournament.status ?? 'draft',
      capacity: tournament.capacity ?? null,
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
      rules: tournament.rules || null,
      image_url: tournament.imageUrl || null,
      status: tournament.status,
      capacity: tournament.capacity ?? null,
    })
    .eq('id', tournament.id);
  check(error, '大会の保存');
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
// 確定させていると（approve_match_result はDB側で直接反映する）、気づかずに
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

  // 運営が自分で結果を入れた試合に、選手からの承認待ちが残っていたら片付ける。
  // 残しておくと、確定済みの試合に「承認しますか？」が出続ける。
  const confirmedIds = state.brackets[tournamentId].rounds
    .flatMap((r) => r.matches)
    .filter((m) => m.confirmed)
    .map((m) => m.id);

  if (confirmedIds.length) {
    const { error: pendingError } = await supabase
      .from('match_result_reports')
      .delete()
      .eq('tournament_id', tournamentId)
      .in('match_id', confirmedIds);
    check(pendingError, '承認待ちの片付け');
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
// 開始の前に配信台を決めなければならないという条件は、テーブルのCHECK制約
// （rounds_stream_before_start）が持っている。ここで作れるのは運営だけ（RLS）。
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

// 回戦を開始する。配信台が未定のままだとCHECK制約に弾かれるので、
// クライアント側の出し分けを抜けても開始できない。
export async function startRound(tournamentId, roundIndex, adminPlayerId) {
  const { data, error } = await supabase
    .from('tournament_rounds')
    .update({ started_at: new Date().toISOString(), started_by: adminPlayerId })
    .eq('tournament_id', tournamentId)
    .eq('round_index', roundIndex)
    .select('started_at');

  if (error?.code === '23514') {
    throw new Error('先に配信台（配信する試合）を決めてください。');
  }
  check(error, '回戦の開始');

  // 配信台を一度も決めていない回戦には行が無く、UPDATEは0行で「成功」する。
  // そのまま開始した扱いにすると、選手の画面が開かないまま運営だけが開始したつもりになる。
  if (!data || data.length === 0) {
    throw new Error('先に配信台（配信する試合）を決めてください。');
  }
}

// 開始を取り消す。押し間違い用。
// 残っている承認待ちも消す（開始前に出された報告が生き残らないように）。
export async function stopRound(tournamentId, roundIndex, matchIds) {
  const { error } = await supabase
    .from('tournament_rounds')
    .update({ started_at: null, started_by: null })
    .eq('tournament_id', tournamentId)
    .eq('round_index', roundIndex);
  check(error, '開始の取り消し');

  if (matchIds.length === 0) return;
  const { error: pendingError } = await supabase
    .from('match_result_reports')
    .delete()
    .eq('tournament_id', tournamentId)
    .in('match_id', matchIds);
  check(pendingError, '承認待ちの片付け');
}

// ---------------------------------------------------------------------------
// 選手が入力するゲームカウント
//
// 選手は brackets に直接書けない（brackets_write は運営限定）。ここを緩めると
// 対戦表を丸ごと書き換えられてしまうので、確定の処理はDB側の関数に閉じ込めてある。
// 片方が報告し、相手が承認して初めて確定する。
// ---------------------------------------------------------------------------

// score は "3-1" 形式で、左が player1Id 側（対戦表の上の行）。
export async function reportMatchResult(tournamentId, matchId, score, winnerEntrantId) {
  const { error } = await supabase.rpc('report_match_result', {
    p_tournament_id: tournamentId,
    p_match_id: matchId,
    p_score: score,
    p_winner_entrant_id: winnerEntrantId,
  });
  checkRpc(error, 'ゲームカウントの報告');
}

// 相手の報告を承認して確定させる。対戦表への反映と matches への記録もここで行われる。
export async function approveMatchResult(tournamentId, matchId) {
  const { error } = await supabase.rpc('approve_match_result', {
    p_tournament_id: tournamentId,
    p_match_id: matchId,
  });
  checkRpc(error, '結果の承認');
}

// 自分が出した報告の取り消し（運営は誰の分でも消せる）。RLSのポリシーが判定する。
export async function withdrawMatchResult(tournamentId, matchId) {
  const { error } = await supabase
    .from('match_result_reports')
    .delete()
    .eq('tournament_id', tournamentId)
    .eq('match_id', matchId);
  check(error, '報告の取り消し');
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

// 変更のプッシュが今ちゃんと届く状態か。
//
// 呼び出し側は、これが真の間は保険の全件取得を控えてよい（無駄な通信を減らす）。
// WebSocketが黙って切れる事故はあるが、supabase-jsが25秒ごとにハートビートを
// 送っていて、応答が無ければ SUBSCRIBED から外れるので、この値で判断できる。
export function isRealtimeConnected() {
  return realtimeConnected;
}

// いずれかのテーブルが変わったら onChange を呼ぶ。短時間に複数の変更が届いても
// まとめて1回で済むよう、少しだけ待ってから通知する。
export function subscribeToChanges(onChange, debounceMs = 400) {
  unsubscribeFromChanges();

  let timer = null;
  const notify = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };

  channel = supabase.channel('app-data');
  ['players', 'tournaments', 'tournament_teams', 'tournament_entries', 'brackets', 'matches',
    'tournament_rounds', 'match_result_reports', 'match_room_codes', 'published_rankings',
    'announcements']
    .forEach((table) => {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, notify);
    });

  // status は SUBSCRIBED / CHANNEL_ERROR / TIMED_OUT / CLOSED のいずれか
  channel.subscribe((status) => {
    realtimeConnected = status === 'SUBSCRIBED';
  });
}

export function unsubscribeFromChanges() {
  realtimeConnected = false;
  if (!channel) return;
  supabase.removeChannel(channel);
  channel = null;
}
