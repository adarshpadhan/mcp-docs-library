CREATE TABLE IF NOT EXISTS subscriptions (
  email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'past_due', 'cancelled')),
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO subscriptions (email, status) SELECT email, 'active' FROM users ON CONFLICT (email) DO NOTHING;
