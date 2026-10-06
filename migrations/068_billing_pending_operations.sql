CREATE UNIQUE INDEX billing_subscription_one_pending ON billing_subscription_changes(account_id) WHERE state='pending';
