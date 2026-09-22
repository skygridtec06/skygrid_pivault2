insert into public.profiles (id, username, created_at)
select
  users.id,
  lower(coalesce(users.raw_user_meta_data ->> 'username', split_part(users.email, '@', 1))),
  users.created_at
from auth.users as users
where not exists (
  select 1 from public.profiles as profiles where profiles.id = users.id
)
and lower(coalesce(users.raw_user_meta_data ->> 'username', split_part(users.email, '@', 1)))
  ~ '^[a-z0-9_-]{3,32}$'
on conflict (username) do nothing;
