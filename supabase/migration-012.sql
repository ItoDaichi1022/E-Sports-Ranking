-- ============================================================================
-- 差分適用スクリプト 012
--
-- 既に schema.sql（＋002〜011）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   対戦カードごとのルームコード。
--
--   これまで部屋のコードはチャットの発言として伝えていたが、会話が進むと
--   埋もれてしまい、さかのぼって探すことになる。専用の欄を1つ持たせて、
--   対戦チャットの上部と対戦表のカードに常に見えるようにする。
--
--   記入できるのはその試合の当事者と運営。運営が回戦の開始前に配信台の
--   コードを入れておけば、選手は開始と同時にコードを確認できる。
-- ============================================================================

create table if not exists match_room_codes (
  tournament_id uuid not null references tournaments(id) on delete cascade,
  match_id      uuid not null,
  code          text not null,
  -- 誰が記入したか（表示用。消えた選手は null になるだけで、コードは残る）
  set_by        uuid references players(id) on delete set null,
  updated_at    timestamptz not null default now(),
  -- 1試合につき1つ。書き直すと上書きされる
  primary key (tournament_id, match_id),
  constraint room_code_not_blank check (btrim(code) <> ''),
  constraint room_code_length check (char_length(code) <= 50)
);

-- 読み取りは anon にも grant するが、実際に行が返るかはポリシー次第
-- （ゲストは is_match_participant が偽なので常に0件。grant が無いと
--  loadAll の select がエラーになってしまう）。
grant select on match_room_codes to anon, authenticated;
grant insert, update, delete on match_room_codes to authenticated;

alter table match_room_codes enable row level security;

-- 部屋のコードは当事者と運営だけが見る。観戦者に見せると、無関係の人が
-- 部屋に入って来られてしまう。
drop policy if exists room_codes_select on match_room_codes;
create policy room_codes_select on match_room_codes
  for select to anon, authenticated
  using (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_insert on match_room_codes;
create policy room_codes_insert on match_room_codes
  for insert to authenticated
  with check (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_update on match_room_codes;
create policy room_codes_update on match_room_codes
  for update to authenticated
  using (is_match_participant(tournament_id, match_id))
  with check (is_match_participant(tournament_id, match_id));

drop policy if exists room_codes_delete on match_room_codes;
create policy room_codes_delete on match_room_codes
  for delete to authenticated
  using (is_match_participant(tournament_id, match_id));

-- 相手が入れたコードを待っている場面で使うものなので、届いた瞬間に出したい。
-- Realtimeの配信にもRLSが効くため、当事者と運営以外には流れない。
do $$
begin
  execute 'alter publication supabase_realtime add table match_room_codes';
exception when duplicate_object then null;
end $$;
