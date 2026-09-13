-- Account kinds: what an account IS, and whether its money is spendable.
--
-- A 401k, an IRA, a brokerage or an HSA is real money and belongs in net
-- worth, but it is not money that can pay next week's rent. `kind` names the
-- account and `include_in_cashflow` decides whether the projection and the
-- spending baseline are allowed to see it. The two are separate on purpose:
-- the kind is a fact about the account, the flag is the policy, and the owner
-- can override the policy per account (a brokerage they really do spend from).

alter table accounts add column if not exists kind text not null default 'cash';
alter table accounts add column if not exists include_in_cashflow boolean not null default true;
alter table accounts add column if not exists institution text null;
alter table accounts add column if not exists notes text null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'accounts_kind_check'
  ) then
    alter table accounts
      add constraint accounts_kind_check
      check (kind in ('cash', 'savings', 'retirement', 'investment', 'hsa', 'other'));
  end if;
end $$;

-- Backfill: everything already recorded is cash the owner can spend. The one
-- refinement is naming — a savings/reserve/growth pot is still liquid, so it
-- is relabelled 'savings' but stays inside the cash flow.
update accounts
   set kind = 'savings'
 where kind = 'cash'
   and name ~* '(savings|reserve|growth)';

create index if not exists accounts_cashflow_idx on accounts (include_in_cashflow);
