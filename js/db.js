// Supabaseとの読み書き。js/github.js + js/githubSync.js の置き換え。
//
// ここがDBとアプリの唯一の境界で、snake_case（DB）とcamelCase（in-memory state）の
// 変換もここだけで行う。おかげで js/ranking.js・js/bracket.js・js/playerStats.js などの
// 計算・描画ロジックはストレージを一切意識しない。
//
// GitHubをDB代わりにしていた頃に必要だった楽観ロックと三方マージは、すべて不要になった。
// Postgresは行単位で書き込むため、別々の大会・別々の選手を同時に編集しても競合しない。

import { supabase } from './supabaseClient.js';
import { state } from './state.js';
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

function toTournament(row, participantIds) {
  return {
    id: row.id,
    name: row.name,
    date: row.date,
    format: row.format,
    rules: row.rules,
    imageUrl: row.image_url ?? '',
    weight: row.weight,
    status: row.status,
    capacity: row.capacity,
    createdBy: row.created_by,
    participantIds,
  };
}

function toMatch(row) {
  return {
    id: row.id,
    tournamentId: row.tournament_id,
    winnerId: row.winner_id,
    loserId: row.loser_id,
    score: row.score,
    round: row.round,
  };
}

function fromMatch(match) {
  return {
    id: match.id,
    tournament_id: match.tournamentId,
    winner_id: match.winnerId,
    loser_id: match.loserId,
    score: match.score,
    round: match.round,
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

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

// 全データを取得して state を丸ごと差し替える。認証は不要（RLSがSELECTを全員に許可）。
// 途中で失敗しても中途半端な表示にならないよう、全部揃ってから state に入れる。
export async function loadAll() {
  const [players, tournaments, entries, brackets, matches, ranking, announcements] = await Promise.all([
    supabase.from('players').select('*').order('display_name'),
    supabase.from('tournaments').select('*').order('date', { ascending: true, nullsFirst: false }),
    supabase.from('tournament_entries').select('*'),
    supabase.from('brackets').select('*'),
    supabase.from('matches').select('*'),
    // スナップショットは最新の1件だけ使う（過去の公開履歴は残しておく）
    supabase.from('published_rankings').select('*').order('published_at', { ascending: false }).limit(1),
    // 固定を先頭に、あとは新しい順
    supabase.from('announcements').select('*').order('pinned', { ascending: false }).order('created_at', { ascending: false }),
  ]);

  check(players.error, '選手の読み込み');
  check(tournaments.error, '大会の読み込み');
  check(entries.error, 'エントリーの読み込み');
  check(brackets.error, 'ブラケットの読み込み');
  check(matches.error, '試合結果の読み込み');
  check(ranking.error, 'ランキングの読み込み');
  check(announcements.error, 'お知らせの読み込み');

  // participantIds はシード順（未確定なら登録順）。旧データの並び順の意味を引き継ぐ。
  const participantsByTournament = new Map();
  [...entries.data]
    .sort((a, b) => {
      if (a.seed != null && b.seed != null) return a.seed - b.seed;
      if (a.seed != null) return -1;
      if (b.seed != null) return 1;
      return a.entered_at.localeCompare(b.entered_at);
    })
    .forEach((e) => {
      if (!participantsByTournament.has(e.tournament_id)) participantsByTournament.set(e.tournament_id, []);
      participantsByTournament.get(e.tournament_id).push(e.player_id);
    });

  const bracketsById = {};
  brackets.data.forEach((b) => { bracketsById[b.tournament_id] = b.data; });

  const snapshot = ranking.data?.[0];

  state.players = players.data.map(toPlayer);
  state.tournaments = tournaments.data.map((t) => toTournament(t, participantsByTournament.get(t.id) ?? []));
  state.matches = matches.data.map(toMatch);
  state.brackets = bracketsById;
  state.publishedRanking = snapshot
    ? {
        publishedAt: snapshot.published_at,
        periodMonths: snapshot.period_months,
        rankings: snapshot.data?.rankings ?? [],
      }
    : null;
  state.announcements = announcements.data.map(toAnnouncement);
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

// 運営が代理登録する選手（本人のアカウントはまだ無い）。
export async function createProxyPlayer(profile) {
  const { data, error } = await supabase
    .from('players')
    .insert({ user_id: null, ...toPlayerUpdate(profile) })
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

// 運営が参加者を直接指定する場合（募集を使わず大会を立てるとき）。
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

export async function saveBracket(tournamentId, bracket) {
  const { error } = await supabase
    .from('brackets')
    .upsert({ tournament_id: tournamentId, data: bracket }, { onConflict: 'tournament_id' });
  check(error, 'ブラケットの保存');
}

// ブラケットの操作（勝敗の確定・取り消し）を1回で保存する。
//
// js/bracket.js の confirmMatch / editMatch は in-memory の state を書き換えるだけで、
// 「どの試合が増えたか・減ったか」を返さない。取り消しは次ラウンド以降へ連鎖することも
// あるため、差分を追いかけるより、その大会の試合をDBと突き合わせて揃えるほうが確実。
// 1大会の試合は多くても数十件なので、毎回の照合でも十分に軽い。
export async function syncTournamentProgress(tournamentId) {
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
// ランキングの公開
// ---------------------------------------------------------------------------

// 公開のたびに1行追加する（上書きではない）。過去に何をいつ公開したかが残る。
export async function publishRanking(snapshot) {
  const { error } = await supabase.from('published_rankings').insert({
    published_at: snapshot.publishedAt,
    period_months: snapshot.periodMonths,
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
  ['players', 'tournaments', 'tournament_entries', 'brackets', 'matches', 'published_rankings', 'announcements']
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
