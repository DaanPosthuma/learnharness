#!/bin/bash
# EC2 first-boot script for LearnHarness (Amazon Linux 2023, x86_64).
# Rendered by deploy/aws-launch.sh — the __PLACEHOLDERS__ are substituted
# there. Installs Docker + compose, adds swap (the box is small), writes the
# compose stack to /opt/learnharness, pulls the image from ECR (retrying
# until the push has landed) and starts it. Progress: /var/log/learnharness-setup.log
set -euxo pipefail
exec > >(tee -a /var/log/learnharness-setup.log | logger -t lh-setup) 2>&1

# --- swap: Next.js processes are memory-hungry for a 2GB instance ----------
if ! swapon --show | grep -q /swapfile; then
	fallocate -l 2G /swapfile
	chmod 600 /swapfile
	mkswap /swapfile
	swapon /swapfile
	echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=20

# --- docker + compose plugin ---------------------------------------------------
dnf install -y docker
systemctl enable --now docker
usermod -aG docker ec2-user || true
mkdir -p /usr/local/lib/docker/cli-plugins
curl -fsSL "https://github.com/docker/compose/releases/download/__COMPOSE_VERSION__/docker-compose-linux-x86_64" -o /usr/local/lib/docker/cli-plugins/docker-compose
chmod +x /usr/local/lib/docker/cli-plugins/docker-compose

# --- the stack ------------------------------------------------------------------
install -d -m 755 /opt/learnharness/deploy
echo '__COMPOSE_B64__' | base64 -d > /opt/learnharness/docker-compose.yml
echo '__CADDYFILE_B64__' | base64 -d > /opt/learnharness/deploy/Caddyfile
cat > /opt/learnharness/.env <<EOF
LH_IMAGE=__LH_IMAGE__
LH_DOMAIN=__LH_DOMAIN__
LH_IDLE_MINUTES=60
EOF
chown -R ec2-user:ec2-user /opt/learnharness

# ECR login helper (instance role): also used by the update script below.
cat > /usr/local/bin/lh-ecr-login <<'EOF'
#!/bin/bash
set -e
aws ecr get-login-password --region __AWS_REGION__ | docker login --username AWS --password-stdin __ECR_REGISTRY__
EOF
chmod +x /usr/local/bin/lh-ecr-login

# Update = re-login, pull, restart. Run as root or ec2-user (docker group).
cat > /usr/local/bin/lh-update <<'EOF'
#!/bin/bash
set -e
cd /opt/learnharness
/usr/local/bin/lh-ecr-login
docker compose pull
docker compose up -d
docker image prune -f
EOF
chmod +x /usr/local/bin/lh-update

cd /opt/learnharness
# The image may still be uploading when the instance boots: keep trying.
until /usr/local/bin/lh-ecr-login && docker compose pull; do
	echo "image not available yet; retrying in 30s"
	sleep 30
done
docker compose up -d
echo "LEARNHARNESS_READY"
