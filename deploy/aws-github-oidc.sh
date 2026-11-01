#!/usr/bin/env bash
# GitHub Actions → AWS trust for the learnharness deploy workflow (OIDC, no long-lived keys).
set -euo pipefail
export AWS_PROFILE=clickhouse AWS_REGION=eu-west-2
ACCOUNT=489323024070
REPO=DaanPosthuma/learnharness
ROLE=learnharness-github-deploy
INSTANCE=i-00d4a1eab8468a1b5
W=$HOME/lh-oidc; mkdir -p "$W"

# 1. The GitHub OIDC identity provider (account-wide, idempotent).
PROVIDER_ARN="arn:aws:iam::$ACCOUNT:oidc-provider/token.actions.githubusercontent.com"
if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd >/dev/null
  echo "created OIDC provider"
else
  echo "OIDC provider exists"
fi

# 2. The role only the repo's main branch (and manual runs on main) can assume.
# GitHub's subject claim now carries the owner and repository ids
# (repo:OWNER@ID/REPO@ID:ref:...), seen in CloudTrail 2026-11-01; older
# tokens carry plain names. Accept exactly these two spellings, nothing wider.
OWNER_ID=$(gh api "users/${REPO%%/*}" -q .id)
REPO_ID=$(gh api "repos/$REPO" -q .id)
SUB_PLAIN="repo:$REPO:ref:refs/heads/main"
SUB_IDS="repo:${REPO%%/*}@$OWNER_ID/${REPO##*/}@$REPO_ID:ref:refs/heads/main"
cat > "$W/trust.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "$PROVIDER_ARN" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      "StringLike": { "token.actions.githubusercontent.com:sub": ["$SUB_PLAIN", "$SUB_IDS"] }
    }
  }]
}
EOF
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "file://$W/trust.json"
  echo "role exists; trust policy refreshed"
else
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "file://$W/trust.json" \
    --description "GitHub Actions deploy for $REPO: push the image to ECR and run lh-update on the box via SSM" >/dev/null
  echo "created role $ROLE"
fi

# 3. Least privilege: push to the one ECR repo, run one SSM document on the one instance.
cat > "$W/policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EcrLogin", "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    { "Sid": "EcrPush", "Effect": "Allow",
      "Action": ["ecr:BatchCheckLayerAvailability","ecr:CompleteLayerUpload","ecr:InitiateLayerUpload","ecr:PutImage","ecr:UploadLayerPart","ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:DescribeImages"],
      "Resource": "arn:aws:ecr:eu-west-2:$ACCOUNT:repository/learnharness-web" },
    { "Sid": "SsmRunUpdate", "Effect": "Allow", "Action": "ssm:SendCommand",
      "Resource": ["arn:aws:ec2:eu-west-2:$ACCOUNT:instance/$INSTANCE", "arn:aws:ssm:eu-west-2::document/AWS-RunShellScript"] },
    { "Sid": "SsmReadResult", "Effect": "Allow", "Action": ["ssm:GetCommandInvocation","ssm:ListCommandInvocations"], "Resource": "*" }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE" --policy-name learnharness-deploy --policy-document "file://$W/policy.json"
echo "role arn: $(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"
