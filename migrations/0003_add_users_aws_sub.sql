-- AWS Cognito sub claim for SSO users (see shared/schema users.awsSub)
ALTER TABLE users ADD COLUMN IF NOT EXISTS aws_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_aws_sub_unique ON users (aws_sub);
