-- ============================================================================
-- 差分適用スクリプト 022
--
-- 既に schema.sql（＋002〜021）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   準備中（draft）の大会を、運営以外には一切返さないようにする。
--
--   これまで draft は「募集ページに出さない」だけだった。画面では隠れていても、
--   大会そのものは誰でも読める状態（tournaments_select は using (true)）で、
--   共有URL（/t/{大会ID}）を開けば大会名も日付もルールも出たし、APIを直に
--   叩けば準備中の大会が全部並んだ。「運営が確定するまで公表しない」を
--   画面の出し分けだけで支えることはできない。
--
--   そこで draft の行はDBの側で返さないようにする。大会本体だけでなく、
--   ぶら下がるもの（エントリー・チーム・その大会の運営・対戦表・回戦・試合結果）も
--   同じ見え方にそろえる ── 本体を隠しても、チーム名や組み合わせが読めるなら
--   隠したことにならない。
--
--   【既に公開中の大会には影響しない】変わるのは status = 'draft' の行だけ。
--   募集中・進行中・終了した大会はこれまでどおり誰でも見られる。
--
--   【運営には見える】その大会の運営（tournament_organizers に入っている人）と
--   サイト全体の運営（admin / owner）には今までどおり返る。作った人は
--   トリガで必ず運営に入るので、自分が準備している大会は見える。
-- ============================================================================

-- その大会を世間に出してよいか。準備中（draft）の大会は運営にしか見えない。
--
-- security definer なのは、中で見る tournaments 自身の閲覧ポリシーに
-- 引っかからないようにするため（掛かると draft の行が見えず、
-- 「draft ではない大会が無い」＝常に真になってしまい、何も隠せない）。
create or replace function is_tournament_visible(p_tournament_id uuid)
  returns boolean
  language sql
  security definer
  stable
  set search_path = public
as $$
  -- case にしているのは、評価の順を確実にするため。or で並べると、どちらを先に
  -- 見るかは実行計画しだいで、行ごとに is_tournament_admin（さらにその中で
  -- players の参照）が走ることになりかねない。公開済みの大会が大多数なので、
  -- 主キー1回の確認で済ませられる側を必ず先に見る。
  select case
    when exists (
      select 1 from tournaments t
      where t.id = p_tournament_id
        and (t.status <> 'draft' or t.created_by = current_player_id())
    ) then true
    else is_tournament_admin(p_tournament_id)
  end;
$$;

-- 【anon への実行許可は必須】下のポリシーは anon（ログアウト状態）にも適用され、
-- その中でこの関数を呼ぶ。実行権限が無いと、ゲストの読み込みが0件になるのではなく
-- 42501でエラーになり、サイトが開けなくなる（migration-013 と同じ落とし穴）。
-- 答えるのは「公開済みの大会か」だけなので、許してもゲストに見えるものは増えない。
revoke all on function is_tournament_visible(uuid) from anon, public;
grant execute on function is_tournament_visible(uuid) to anon, authenticated;

-- 大会本体。ここが要。
--
-- 【created_by を見ている理由】大会の作成は insert ... returning で行う
-- （js/db.js の createTournament）。returning で返る行にもこのポリシーが掛かるが、
-- 作った人を運営に入れるのは after insert のトリガなので、その時点ではまだ
-- tournament_organizers に行が無い ── is_tournament_admin だけで判定すると、
-- サイト全体の運営でない人は自分が作った大会を受け取れずに失敗する。
-- 作った本人にはいつでも見えるべきものでもあるので、ここで直接見る。
drop policy if exists tournaments_select on tournaments;
create policy tournaments_select on tournaments
  for select to anon, authenticated
  using (
    status <> 'draft'
    or created_by = current_player_id()
    or is_tournament_admin(id)
  );

-- 大会にぶら下がるものは、例外なく大会と同じ見え方にそろえる。
--
-- 対戦表（brackets）・回戦（tournament_rounds）・試合結果（matches）まで含めるのは、
-- 運営が参加者を直接選ぶ大会では作成した時点で組み合わせが出来ていて、公開しないまま
-- 回戦を始めることもできるため。本体だけ隠しても、チーム名や組み合わせや勝敗が
-- 読めるなら隠したことにならない。
drop policy if exists organizers_select on tournament_organizers;
create policy organizers_select on tournament_organizers
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));

drop policy if exists teams_select on tournament_teams;
create policy teams_select on tournament_teams
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));

drop policy if exists entries_select on tournament_entries;
create policy entries_select on tournament_entries
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));

drop policy if exists brackets_select on brackets;
create policy brackets_select on brackets
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));

drop policy if exists rounds_select on tournament_rounds;
create policy rounds_select on tournament_rounds
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));

drop policy if exists matches_select on matches;
create policy matches_select on matches
  for select to anon, authenticated
  using (is_tournament_visible(tournament_id));
