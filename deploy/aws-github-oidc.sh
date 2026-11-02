#!/usr/bin/env bash
# GitHub Actions → AWS trust for the learnharness deploy workflow (OIDC, no
# long-lived keys), plus the three repo secrets the workflow reads so that the
# account id, the instance id and the hostname appear neither in the public
# source nor in the public run logs (Actions masks secret values wherever
# they show up). Idempotent; re-run after the instance or the IP changes.
#
# Needs: aws (a profile for the account) and gh (signed in as the repo owner).
# Configuration via env; everything else is derived from the account:
#   AWS_PROFILE / AWS_REGION   the account and region (default region eu-west-2)
#   LH_REPO          GitHub owner/name     (default: this checkout's origin)
#   LH_NAME          resource name prefix  (default learnharness, as in aws-launch.sh)
#   LH_INSTANCE_ID   the box               (default: the instance tagged Name=$LH_NAME)
#   LH_SITE_HOST     public hostname       (default: <elastic-ip>.sslip.io, EIP tagged Name=$LH_NAME)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export AWS_REGION="${AWS_REGION:-eu-west-2}"
export AWS_DEFAULT_REGION="$AWS_REGION"

NAME="${LH_NAME:-learnharness}"
REPO="${LH_REPO:-$(git -C "$HERE" remote get-url origin | sed -E 's#\.git$##; s#.*github\.com[:/]##')}"
ROLE=learnharness-github-deploy
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
INSTANCE="${LH_INSTANCE_ID:-$(aws ec2 describe-instances \
  --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}')}"
HOST="${LH_SITE_HOST:-$(aws ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" \
  --query 'Addresses[0].PublicIp' --output text | tr . -).sslip.io}"
case "$INSTANCE" in ""|None) echo "no instance tagged Name=$NAME in $AWS_REGION; set LH_INSTANCE_ID" >&2; exit 1 ;; esac
case "$HOST" in None.sslip.io|.sslip.io) echo "no Elastic IP tagged Name=$NAME; set LH_SITE_HOST" >&2; exit 1 ;; esac
echo "repo $REPO · account $ACCOUNT · instance $INSTANCE · host $HOST"
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
      "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT:repository/$NAME-web" },
    { "Sid": "SsmRunUpdate", "Effect": "Allow", "Action": "ssm:SendCommand",
      "Resource": ["arn:aws:ec2:$AWS_REGION:$ACCOUNT:instance/$INSTANCE", "arn:aws:ssm:$AWS_REGION::document/AWS-RunShellScript"] },
    { "Sid": "SsmReadResult", "Effect": "Allow", "Action": ["ssm:GetCommandInvocation","ssm:ListCommandInvocations"], "Resource": "*" }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE" --policy-name learnharness-deploy --policy-document "file://$W/policy.json"
echo "role arn: $(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text)"

# 4. The repo secrets .github/workflows/deploy.yml reads. Not credentials —
# just where the deployment lives, kept out of the public source and logs.
gh secret set AWS_ACCOUNT_ID -R "$REPO" -b "$ACCOUNT"
gh secret set INSTANCE_ID    -R "$REPO" -b "$INSTANCE"
gh secret set SITE_HOST      -R "$REPO" -b "$HOST"
echo "repo secrets set: AWS_ACCOUNT_ID INSTANCE_ID SITE_HOST"
