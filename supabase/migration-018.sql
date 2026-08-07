-- ============================================================================
-- 差分適用スクリプト 018
--
-- 既に schema.sql（＋002〜017）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   ゲームカウントの「相手の承認」を撤廃する。
--
--   これまでは片方が報告し、相手が承認して初めて確定していた（一方的な入力で
--   勝ち上がれないようにするため）。実際に運用してみると、承認する側が席を
--   外していたり、そのまま気付かずに解散したりで、勝敗が入っているのに表が
--   進まない試合が出た。試合そのものは終わっているのに、あとから当事者を
--   捕まえないと次の回戦を始められない ── 進行を止める理由が「不正の防止」
--   ではなく「片方が画面を見ていない」になってしまっていた。
--
--   そこで、どちらが入力しても、その場で確定するようにする。
--   食い違いや間違いは、対戦チャットの「運営に報告」から運営に伝えてもらい、
--   運営が結果を編集して直す（その導線は元からある）。運営が直せる以上、
--   誤りが残り続けることはない。
--
--   この変更で match_result_reports（承認待ちの置き場）は要らなくなるので、
--   テーブルごと落とす。承認関数 approve_match_result も落とす。
--
--   【注意】適用した時点で承認待ちだった報告は、テーブルと一緒に消える。
--   その試合は未入力の状態に戻るので、どちらかにもう一度入れ直してもらうこと
--   （入っていた値は対戦表にはまだ反映されていないので、消えて困るものは無い）。
-- ============================================================================

-- 承認関数は先に落とす（この関数だけがテーブルを読み書きしている）
drop function if exists approve_match_result(uuid, uuid);

-- 選手が入力したゲームカウントを、その場で確定させる。
--
-- 元は match_result_reports に置くだけの関数だったが、承認の撤廃にともない
-- 確定までをここで行う（旧 approve_match_result の後半をそのまま引き取った形）。
-- 選手は brackets に直接書けないので、確定の処理はこの security definer の
-- 関数に閉じ込めたままにする。
create or replace function report_match_result(
  p_tournament_id     uuid,
  p_match_id          uuid,
  p_score             text,
  p_winner_entrant_id uuid
) returns void
  language plpgsql
  security definer
  set search_path = public
as $$
declare
  v_me         uuid;
  v_my_entrant uuid;
  v_m          jsonb;
  v_p1         uuid;
  v_p2         uuid;
  v_s1         int;
  v_s2         int;
  v_loser      uuid;
  v_round      text;
  v_is_team    boolean;
begin
  v_me := current_player_id();
  if v_me is null then
    raise exception '選手登録がまだのため入力できません。' using errcode = 'insufficient_privilege';
  end if;

  -- 両者が同時に入力しても二重に確定させない。対戦表の行を先に押さえてから
  -- 確定済みかどうかを見る（押さえる前に見ると、二人とも「未確定」を見て通る）。
  perform 1 from brackets where tournament_id = p_tournament_id for update;

  v_m := bracket_match(p_tournament_id, p_match_id);
  if v_m is null then
    raise exception '対象の試合が見つかりません。' using errcode = 'no_data_found';
  end if;
  if coalesce((v_m->>'confirmed')::boolean, false) then
    raise exception 'この試合は既に確定済みです。' using errcode = 'check_violation';
  end if;

  if not round_is_started(p_tournament_id, p_match_id) then
    raise exception 'この回戦はまだ開始されていません。運営の開始をお待ちください。'
      using errcode = 'check_violation';
  end if;

  v_p1 := (v_m->>'player1Id')::uuid;
  v_p2 := (v_m->>'player2Id')::uuid;
  if v_p1 is null or v_p2 is null then
    raise exception '対戦カードが確定していないため入力できません。' using errcode = 'check_violation';
  end if;

  v_my_entrant := my_entrant_id(p_tournament_id);
  if v_my_entrant is null or v_my_entrant not in (v_p1, v_p2) then
    raise exception 'この対戦の当事者ではありません。' using errcode = 'insufficient_privilege';
  end if;
  if p_winner_entrant_id not in (v_p1, v_p2) then
    raise exception '勝者は対戦カードから選んでください。' using errcode = 'check_violation';
  end if;

  if p_score !~ '^[0-9]{1,3}-[0-9]{1,3}$' then
    raise exception 'ゲームカウントの形式が正しくありません。' using errcode = 'check_violation';
  end if;
  v_s1 := split_part(p_score, '-', 1)::int;
  v_s2 := split_part(p_score, '-', 2)::int;
  if v_s1 = v_s2 then
    raise exception 'ゲームカウントが同点のため勝者を判定できません。' using errcode = 'check_violation';
  end if;
  -- スコアの左が player1 側。勝者の指定と向きが食い違っていたら受け付けない
  if (v_s1 > v_s2) <> (p_winner_entrant_id = v_p1) then
    raise exception 'ゲームカウントと勝者が食い違っています。' using errcode = 'check_violation';
  end if;

  v_loser := case when p_winner_entrant_id = v_p1 then v_p2 else v_p1 end;
  v_round := v_m->>'round';

  update brackets
     set data = apply_match_result_json(
           data, p_match_id, p_winner_entrant_id, v_loser, p_score)
   where tournament_id = p_tournament_id;

  -- 試合の記録。チーム戦はチーム列に入れる（個人の通算成績に混ぜないため）
  select match_type = '2v2' into v_is_team from tournaments where id = p_tournament_id;

  if v_is_team then
    insert into matches (id, tournament_id, winner_team_id, loser_team_id, score, round)
      values (p_match_id, p_tournament_id, p_winner_entrant_id, v_loser, p_score, v_round);
  else
    insert into matches (id, tournament_id, winner_id, loser_id, score, round)
      values (p_match_id, p_tournament_id, p_winner_entrant_id, v_loser, p_score, v_round);
  end if;
end;
$$;

revoke all on function report_match_result(uuid, uuid, text, uuid) from anon, public;
grant execute on function report_match_result(uuid, uuid, text, uuid) to authenticated;

-- 承認待ちの置き場。ポリシー・権限・Realtimeへの登録もテーブルと一緒に消える。
drop table if exists match_result_reports;
