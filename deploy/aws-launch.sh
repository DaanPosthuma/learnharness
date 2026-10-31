#!/usr/bin/env bash
# Stand LearnHarness up on one small EC2 instance (accounts + mobile wave).
#
#   deploy/aws-launch.sh infra     ECR repo, IAM role/profile, security group, Elastic IP
#   deploy/aws-launch.sh push      tag + push the local image (learnharness-web:local) to ECR
#   deploy/aws-launch.sh launch    run the instance (user-data: deploy/aws-user-data.sh)
#   deploy/aws-launch.sh status    instance state, public hostname, setup log tail
#   deploy/aws-launch.sh run CMD…  run a shell command on the box through SSM
#   deploy/aws-launch.sh adduser NAME [PASSWORD]   create an account on the box
#   deploy/aws-launch.sh update    pull the latest pushed image and restart
#   deploy/aws-launch.sh all       infra → push → launch → wait
#
# Idempotent: every step looks before it creates. Configuration via env:
#   AWS_PROFILE / AWS_REGION   (required: the account and region)
#   LH_NAME        resource name prefix            (default learnharness)
#   LH_INSTANCE    instance type                   (default t3a.small — 2 vCPU, 2GB)
#   LH_DISK_GB     root volume size                (default 16)
#   LH_DOMAIN      public hostname; default <elastic-ip>.sslip.io (works with no DNS
#                  of your own; point a real name at the Elastic IP and set this)
#   LH_KEY_NAME    optional EC2 key pair for SSH   (default none — SSM only)
#   LH_SSH_CIDR    open port 22 to this CIDR       (default: not opened)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

NAME="${LH_NAME:-learnharness}"
INSTANCE_TYPE="${LH_INSTANCE:-t3a.small}"
DISK_GB="${LH_DISK_GB:-16}"
COMPOSE_VERSION="${LH_COMPOSE_VERSION:-v2.29.7}"
REGION="${AWS_REGION:-$(aws configure get region)}"
export AWS_REGION="$REGION" AWS_DEFAULT_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
IMAGE="${REGISTRY}/${NAME}-web:latest"
LOCAL_IMAGE="${LH_LOCAL_IMAGE:-learnharness-web:local}"

say() { printf '\033[1m%s\033[0m\n' "$*" >&2; }

# ------------------------------------------------------------------ lookups
vpc_id() { aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text; }
sg_id() { aws ec2 describe-security-groups --filters "Name=group-name,Values=${NAME}-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null | grep -v None || true; }
eip_alloc() { aws ec2 describe-addresses --filters "Name=tag:Name,Values=${NAME}" --query 'Addresses[0].AllocationId' --output text 2>/dev/null | grep -v None || true; }
eip_ip() { aws ec2 describe-addresses --filters "Name=tag:Name,Values=${NAME}" --query 'Addresses[0].PublicIp' --output text 2>/dev/null | grep -v None || true; }
instance_id() {
	aws ec2 describe-instances --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
		--query 'Reservations[].Instances[].InstanceId' --output text | awk '{print $1}'
}
domain() { echo "${LH_DOMAIN:-$(eip_ip | tr . -).sslip.io}"; }

# -------------------------------------------------------------------- infra
cmd_infra() {
	say "ECR repository ${NAME}-web"
	aws ecr describe-repositories --repository-names "${NAME}-web" >/dev/null 2>&1 ||
		aws ecr create-repository --repository-name "${NAME}-web" --image-scanning-configuration scanOnPush=true >/dev/null
	aws ecr put-lifecycle-policy --repository-name "${NAME}-web" --lifecycle-policy-text \
		'{"rules":[{"rulePriority":1,"description":"keep 5 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":5},"action":{"type":"expire"}}]}' >/dev/null

	say "IAM role ${NAME}-ec2 (SSM + ECR pull)"
	if ! aws iam get-role --role-name "${NAME}-ec2" >/dev/null 2>&1; then
		aws iam create-role --role-name "${NAME}-ec2" --assume-role-policy-document \
			'{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
	fi
	aws iam attach-role-policy --role-name "${NAME}-ec2" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
	aws iam attach-role-policy --role-name "${NAME}-ec2" --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly
	if ! aws iam get-instance-profile --instance-profile-name "${NAME}-ec2" >/dev/null 2>&1; then
		aws iam create-instance-profile --instance-profile-name "${NAME}-ec2" >/dev/null
		aws iam add-role-to-instance-profile --instance-profile-name "${NAME}-ec2" --role-name "${NAME}-ec2"
		sleep 10 # IAM propagation before run-instances can reference it
	fi

	say "security group ${NAME}-sg (80/443 open; 22 only if LH_SSH_CIDR)"
	local vpc sg; vpc="$(vpc_id)"; sg="$(sg_id)"
	if [ -z "$sg" ]; then
		sg="$(aws ec2 create-security-group --group-name "${NAME}-sg" --description "LearnHarness web" --vpc-id "$vpc" --query GroupId --output text)"
		aws ec2 create-tags --resources "$sg" --tags "Key=Name,Value=${NAME}-sg"
	fi
	for port in 80 443; do
		aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
			"IpProtocol=tcp,FromPort=$port,ToPort=$port,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]" >/dev/null 2>&1 || true
	done
	if [ -n "${LH_SSH_CIDR:-}" ]; then
		aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$LH_SSH_CIDR" >/dev/null 2>&1 || true
	fi

	say "Elastic IP"
	if [ -z "$(eip_alloc)" ]; then
		local alloc; alloc="$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)"
		aws ec2 create-tags --resources "$alloc" --tags "Key=Name,Value=${NAME}"
	fi
	say "public IP $(eip_ip) → hostname $(domain)"
}

# --------------------------------------------------------------------- push
cmd_push() {
	say "pushing ${LOCAL_IMAGE} → ${IMAGE}"
	aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
	docker tag "$LOCAL_IMAGE" "$IMAGE"
	docker push "$IMAGE"
}

# ------------------------------------------------------------------- launch
render_user_data() {
	local compose caddy
	# The server copy of the compose file never builds: it only pulls.
	compose="$(sed '/^    build: \.$/d' "$ROOT/docker-compose.yml" | base64 -w0)"
	caddy="$(base64 -w0 "$ROOT/deploy/Caddyfile")"
	sed -e "s|__COMPOSE_B64__|$compose|" -e "s|__CADDYFILE_B64__|$caddy|" \
		-e "s|__LH_IMAGE__|$IMAGE|" -e "s|__LH_DOMAIN__|$(domain)|" \
		-e "s|__AWS_REGION__|$REGION|" -e "s|__ECR_REGISTRY__|$REGISTRY|" \
		-e "s|__COMPOSE_VERSION__|$COMPOSE_VERSION|" \
		"$ROOT/deploy/aws-user-data.sh"
}

cmd_launch() {
	local id; id="$(instance_id)"
	if [ -n "$id" ]; then say "instance $id already exists"; return; fi
	local ami sg subnet userdata
	ami="$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)"
	sg="$(sg_id)"; [ -n "$sg" ] || { echo "run 'infra' first" >&2; exit 1; }
	subnet="$(aws ec2 describe-subnets --filters "Name=vpc-id,Values=$(vpc_id)" "Name=default-for-az,Values=true" --query 'Subnets[0].SubnetId' --output text)"
	userdata="$(mktemp)"; render_user_data > "$userdata"
	local key_arg=(); [ -n "${LH_KEY_NAME:-}" ] && key_arg=(--key-name "$LH_KEY_NAME")
	say "launching ${INSTANCE_TYPE} (${ami}) in ${subnet}"
	id="$(aws ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" --subnet-id "$subnet" --security-group-ids "$sg" \
		--iam-instance-profile "Name=${NAME}-ec2" --user-data "file://$userdata" "${key_arg[@]}" \
		--block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${DISK_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
		--metadata-options HttpTokens=required,HttpEndpoint=enabled \
		--credit-specification CpuCredits=standard \
		--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}}]" "ResourceType=volume,Tags=[{Key=Name,Value=${NAME}}]" \
		--query 'Instances[0].InstanceId' --output text)"
	rm -f "$userdata"
	say "instance $id — waiting for running"
	aws ec2 wait instance-running --instance-ids "$id"
	aws ec2 associate-address --instance-id "$id" --allocation-id "$(eip_alloc)" >/dev/null
	say "https://$(domain)  (first boot takes a few minutes: docker install, image pull, certificate)"
}

# ------------------------------------------------------------------- remote
cmd_run() {
	local id; id="$(instance_id)"; [ -n "$id" ] || { echo "no instance" >&2; exit 1; }
	local cmd_json; cmd_json="$(printf '%s' "$*" | python3 -c 'import json,sys; print(json.dumps({"commands":[sys.stdin.read()]}))')"
	local cid
	cid="$(aws ssm send-command --instance-ids "$id" --document-name AWS-RunShellScript --parameters "$cmd_json" --query 'Command.CommandId' --output text)"
	for _ in $(seq 1 120); do
		local status
		status="$(aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query Status --output text 2>/dev/null || echo Pending)"
		case "$status" in Pending|InProgress|Delayed) sleep 2 ;; *) break ;; esac
	done
	aws ssm get-command-invocation --command-id "$cid" --instance-id "$id" --query '[StandardOutputContent,StandardErrorContent]' --output text
}

cmd_status() {
	local id; id="$(instance_id)"
	if [ -z "$id" ]; then say "no instance named ${NAME}"; return; fi
	aws ec2 describe-instances --instance-ids "$id" --query 'Reservations[0].Instances[0].{id:InstanceId,type:InstanceType,state:State.Name,ip:PublicIpAddress,az:Placement.AvailabilityZone}' --output table
	say "https://$(domain)"
	cmd_run 'tail -n 15 /var/log/learnharness-setup.log 2>/dev/null; docker ps --format "{{.Names}}  {{.Status}}" 2>/dev/null' || true
}

cmd_adduser() {
	local user="$1" pw="${2:-}"
	[ -n "$user" ] || { echo "usage: adduser NAME [PASSWORD]" >&2; exit 1; }
	if [ -n "$pw" ]; then
		cmd_run "cd /opt/learnharness && docker compose exec -T app node gateway/cli.mjs add '$user' --password '$pw'"
	else
		cmd_run "cd /opt/learnharness && docker compose exec -T app node gateway/cli.mjs add '$user'"
	fi
}

cmd_update() { cmd_run "/usr/local/bin/lh-update"; }

cmd_wait_ready() {
	say "waiting for first boot to finish (up to 15 min)"
	for _ in $(seq 1 45); do
		if cmd_run 'grep -q LEARNHARNESS_READY /var/log/learnharness-setup.log 2>/dev/null && echo READY' 2>/dev/null | grep -q READY; then
			say "ready: https://$(domain)"; return 0
		fi
		sleep 20
	done
	say "still not ready — check: $0 status"; return 1
}

case "${1:-}" in
	infra) cmd_infra ;;
	push) cmd_push ;;
	launch) cmd_launch ;;
	status) cmd_status ;;
	run) shift; cmd_run "$@" ;;
	adduser) shift; cmd_adduser "$@" ;;
	update) cmd_update ;;
	wait) cmd_wait_ready ;;
	all) cmd_infra; cmd_push; cmd_launch; cmd_wait_ready ;;
	*) sed -n '2,20p' "$0"; exit 1 ;;
esac
