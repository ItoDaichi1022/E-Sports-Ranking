-- ============================================================================
-- 差分適用スクリプト 025
--
-- 既に schema.sql（＋002〜024）を実行済みのプロジェクトに、あとから入った
-- 変更だけを当てる。Supabaseダッシュボードの SQL Editor に貼り付けて「Run」。
-- 何度実行しても同じ結果になる。
--
-- 新しくプロジェクトを作る場合はこれは不要（schema.sql に取り込み済み）。
--
-- 内容:
--   大会そのものへの通報。
--
--   大会は誰でも開ける。開いたきり進行しない大会、結果が明らかにおかしい大会、
--   規約に反する内容の大会 ── どれも、その大会の運営に言っても始まらない
--   （言う相手が当の本人であることが多い）。宛先はサイト全体の運営にする。
--
--   【自動では何も起きない】通報が積み上がると運営の画面に並ぶだけで、
--   大会を消すかどうかを決めるのは人。選手の通報（player_reports）と同じ考え方で、
--   自動で消す作りにすると、結託した数アカウントで正当な大会を潰せてしまう。
-- ============================================================================

create table if not exists tournament_reports (
  id            uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references tournaments(id) on delete cascade,
  reporter_id   uuid not null references players(id) on delete cascade,
  -- 分類。選手への通報と同じ選択肢にそろえてある（js/app.js の REPORT_REASONS）。
  -- 別の言葉を並べると、通報する側が「どちらの画面から出すか」で迷う。
  reason        text not null,
  -- 具体的な状況。任意だが、これが無い通報は運営が判断できないので画面では促す
  body          text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references players(id) on delete set null,
  resolution    text,
  constraint tournament_reports_reason_check check (
    reason in ('harassment', 'cheating', 'impersonation', 'inappropriate', 'spam', 'other')
  ),
  constraint tournament_reports_body_length check (body is null or char_length(body) <= 500),
  constraint tournament_reports_resolution_check check (
    resolution is null or resolution in ('deleted', 'dismissed')
  )
);

-- 画面が見るのはほぼ「未対応の通報」だけなので、そこに絞る
create index if not exists tournament_reports_open_idx
  on tournament_reports (tournament_id) where resolved_at is null;

-- 【同じ人からの連投を1件に潰す】数えるのは「何件届いたか」ではなく
-- 「何人から届いたか」。1人が10回押しても1件にしかならないようにしておかないと、
-- 積み上がった件数を運営が判断材料にできない。未対応のものだけを対象にするのは、
-- 一度運営が見終えたあとの別件を通報できなくならないようにするため。
create unique index if not exists tournament_reports_open_uniq
  on tournament_reports (tournament_id, reporter_id) where resolved_at is null;

alter table tournament_reports enable row level security;

-- anon にも select を与えるのは、ゲストの読み込み（js/db.js の loadAll）が
-- 権限エラーで止まらないようにするため（ポリシーを満たさないので返るのは常に0件）。
grant select on tournament_reports to anon, authenticated;
grant insert on tournament_reports to authenticated;

-- 読めるのは運営と、自分が出した通報だけ。
-- 大会の運営には見せない ── 誰が通報したかが分かると報復の材料になる。
drop policy if exists tournament_reports_select on tournament_reports;
create policy tournament_reports_select on tournament_reports
  for select to anon, authenticated
  using (is_admin() or reporter_id = current_player_id());

-- 自分の名前でしか通報できない。停止中の人は通報できない
-- （止められた腹いせに通報を撒く経路を残さない）。
--
-- 【その大会の運営は自分の大会を通報できない】通報は「この大会に問題がある」と
-- 申し立てるもので、運営が自分の大会に出すのは筋が通らない。件数を自分で
-- 積み上げられる余地も残さない。画面側でも歯車の中身を出し分けている。
drop policy if exists tournament_reports_insert on tournament_reports;
create policy tournament_reports_insert on tournament_reports
  for insert to authenticated
  with check (
    reporter_id = current_player_id()
    and not is_banned()
    and not is_tournament_admin(tournament_id)
  );

-- update / delete のポリシーは意図的に置いていない（GRANT も与えていない）。
-- 対応済みにするのは下の admin_dismiss_tournament_reports からだけ。

-- 通報を「見た。問題なし」として畳む（運営専用）。
-- 大会を消す場合は tournaments を消せば、外部キーの cascade で通報も消える。
create or replace function admin_dismiss_tournament_reports(target_tournament_id uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  if not is_admin() then
    raise exception '運営権限が必要です。' using errcode = 'insufficient_privilege';
  end if;

  update tournament_reports
     set resolved_at = now(),
         resolved_by = current_player_id(),
         resolution = 'dismissed'
   where tournament_id = target_tournament_id and resolved_at is null;
end;
$$;

revoke all on function admin_dismiss_tournament_reports(uuid) from anon, public;
grant execute on function admin_dismiss_tournament_reports(uuid) to authenticated;
