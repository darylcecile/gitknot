CREATE TABLE roles (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id),
  repo_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  built_in INTEGER NOT NULL DEFAULT 0 CHECK (built_in IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (built_in = 0 OR (account_id IS NULL AND repo_id IS NULL)),
  UNIQUE (account_id, repo_id, name)
);
CREATE INDEX roles_account_cursor ON roles(account_id, id);
CREATE INDEX roles_repo_cursor ON roles(repo_id, id);

CREATE TABLE role_capabilities (
  role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  PRIMARY KEY (role_id, capability, effect)
);

CREATE TABLE memberships (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  principal_id TEXT NOT NULL REFERENCES principals(id),
  role_id TEXT NOT NULL REFERENCES roles(id),
  state TEXT NOT NULL CHECK (state IN ('active','suspended')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, principal_id)
);
CREATE INDEX memberships_principal ON memberships(principal_id, state, account_id);
CREATE INDEX memberships_owners ON memberships(account_id, role_id, state, principal_id);

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members','secret')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, slug),
  UNIQUE (account_id, id)
);
CREATE TABLE team_members (
  account_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','maintainer')),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, principal_id),
  FOREIGN KEY (account_id, team_id) REFERENCES teams(account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, principal_id) REFERENCES memberships(account_id, principal_id) ON DELETE CASCADE
);
CREATE INDEX team_members_principal ON team_members(account_id, principal_id, team_id);

CREATE TABLE account_policies (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE account_policy_barriers (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  id TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL,
  previous_policy_revision INTEGER NOT NULL,
  recover_after TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX account_policy_barriers_recovery ON account_policy_barriers(recover_after,account_id);

CREATE TABLE access_grants (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','team','application','service','agent','runner','job','viewer')),
  principal_id TEXT NOT NULL,
  role_id TEXT REFERENCES roles(id),
  capability TEXT,
  effect TEXT NOT NULL DEFAULT 'allow' CHECK (effect IN ('allow','deny')),
  conditions_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(conditions_json)),
  expires_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((role_id IS NULL) != (capability IS NULL))
);
CREATE INDEX access_grants_principal ON access_grants(account_id, principal_id, repo_id, id) WHERE revoked_at IS NULL;
CREATE INDEX access_grants_repo_cursor ON access_grants(repo_id, id) WHERE revoked_at IS NULL;
CREATE INDEX access_grants_expiry ON access_grants(expires_at) WHERE revoked_at IS NULL AND expires_at IS NOT NULL;

CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  repo_id TEXT,
  email TEXT NOT NULL COLLATE NOCASE,
  role_id TEXT NOT NULL REFERENCES roles(id),
  team_id TEXT REFERENCES teams(id),
  token_hash TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','accepted','revoked','expired')),
  expires_at TEXT NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  accepted_at TEXT,
  seat_quote_json TEXT NOT NULL CHECK (json_valid(seat_quote_json)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX invitations_account_cursor ON invitations(account_id, id);
CREATE INDEX invitations_email ON invitations(email, state, id);
CREATE UNIQUE INDEX invitations_pending_member ON invitations(account_id, email) WHERE state = 'pending' AND repo_id IS NULL;
CREATE UNIQUE INDEX invitations_pending_collaborator ON invitations(repo_id, email) WHERE state = 'pending' AND repo_id IS NOT NULL;

INSERT INTO roles (id, name, description, built_in, created_at, updated_at) VALUES
 ('owner','Owner','Account ownership and recovery; assignable only to verified people.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('administrator','Administrator','Repository and organization administration without ownership or billing.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('maintainer','Maintainer','Maintain code, collaboration, workflows, and repository configuration.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('contributor','Contributor','Contribute code and collaboration without changing security policy.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('reviewer','Reviewer','Read repository content and review proposed changes.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('reader','Reader','Read repository content and collaboration.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('billing_manager','Billing Manager','Manage billing independently of code access.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z'),
 ('member','Member','Organization membership without implicit private-repository access.',1,'2026-10-04T00:00:00.000Z','2026-10-04T00:00:00.000Z');

INSERT INTO role_capabilities (role_id, capability, effect) VALUES
 ('owner','*','allow'),
 ('administrator','accounts.read','allow'),('administrator','accounts.manage','allow'),
 ('administrator','members.*','allow'),('administrator','teams.*','allow'),('administrator','invitations.*','allow'),
 ('administrator','identities.*','allow'),('administrator','roles.*','allow'),('administrator','policy.*','allow'),
 ('administrator','repositories.*','allow'),('administrator','permissions.*','allow'),('administrator','contents.*','allow'),
 ('administrator','issues.*','allow'),('administrator','pull_requests.*','allow'),('administrator','discussions.*','allow'),
 ('administrator','tasks.*','allow'),('administrator','rules.*','allow'),('administrator','workflows.*','allow'),
 ('administrator','runs.*','allow'),('administrator','runners.*','allow'),('administrator','environments.*','allow'),
 ('administrator','secrets.*','allow'),('administrator','variables.*','allow'),('administrator','webhooks.*','allow'),
 ('administrator','releases.*','allow'),('administrator','lfs.*','allow'),('administrator','attachments.*','allow'),
 ('administrator','search.*','allow'),('administrator','tokens.*','allow'),('administrator','installations.*','allow'),
 ('administrator','audit.read','allow'),('administrator','exports.*','allow'),
 ('maintainer','accounts.read','allow'),('maintainer','repositories.read','allow'),('maintainer','repositories.manage','allow'),
 ('maintainer','repositories.export','allow'),('maintainer','contents.*','allow'),('maintainer','issues.*','allow'),
 ('maintainer','pull_requests.*','allow'),('maintainer','discussions.*','allow'),('maintainer','tasks.*','allow'),
 ('maintainer','workflows.read','allow'),('maintainer','workflows.run','allow'),('maintainer','workflows.manage','allow'),
 ('maintainer','runs.*','allow'),('maintainer','releases.*','allow'),('maintainer','lfs.*','allow'),
 ('maintainer','attachments.*','allow'),('maintainer','search.read','allow'),('maintainer','search.scan','allow'),
 ('maintainer','rules.read','allow'),('maintainer','environments.read','allow'),('maintainer','environments.approve','allow'),
 ('contributor','accounts.read','allow'),('contributor','repositories.read','allow'),('contributor','repositories.export','allow'),
 ('contributor','contents.read','allow'),('contributor','contents.push','allow'),('contributor','issues.read','allow'),
 ('contributor','issues.write','allow'),('contributor','pull_requests.read','allow'),('contributor','pull_requests.write','allow'),
 ('contributor','pull_requests.review','allow'),('contributor','discussions.read','allow'),('contributor','discussions.write','allow'),
 ('contributor','tasks.read','allow'),('contributor','tasks.write','allow'),('contributor','workflows.read','allow'),
 ('contributor','workflows.run','allow'),('contributor','runs.read','allow'),('contributor','releases.read','allow'),
 ('contributor','lfs.read','allow'),('contributor','lfs.write','allow'),('contributor','attachments.read','allow'),
 ('contributor','attachments.write','allow'),('contributor','search.read','allow'),('contributor','rules.read','allow'),
 ('reviewer','accounts.read','allow'),('reviewer','repositories.read','allow'),('reviewer','contents.read','allow'),
 ('reviewer','issues.read','allow'),('reviewer','pull_requests.read','allow'),('reviewer','pull_requests.review','allow'),
 ('reviewer','discussions.read','allow'),('reviewer','discussions.write','allow'),('reviewer','workflows.read','allow'),
 ('reviewer','runs.read','allow'),('reviewer','releases.read','allow'),('reviewer','lfs.read','allow'),
 ('reviewer','attachments.read','allow'),('reviewer','search.read','allow'),('reviewer','rules.read','allow'),
 ('reader','accounts.read','allow'),('reader','repositories.read','allow'),('reader','repositories.export','allow'),
 ('reader','contents.read','allow'),('reader','issues.read','allow'),('reader','pull_requests.read','allow'),
 ('reader','discussions.read','allow'),('reader','tasks.read','allow'),('reader','workflows.read','allow'),
 ('reader','runs.read','allow'),('reader','releases.read','allow'),('reader','lfs.read','allow'),
 ('reader','attachments.read','allow'),('reader','search.read','allow'),('reader','rules.read','allow'),
 ('billing_manager','accounts.read','allow'),('billing_manager','billing.*','allow'),
 ('member','accounts.read','allow'),('member','members.read','allow'),('member','teams.read','allow'),
 ('member','repositories.create','allow');
