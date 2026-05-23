# htmlz on AWS

A single EC2 instance is enough. The setup below uses `t4g.nano`
(~$3/month), Amazon Linux 2023, SSM Session Manager for shell access
(no SSH keys), and a Security Group locked to your own IP.

Total moving parts: one instance, one Security Group, one IAM role.
No load balancer, no ECS, no CloudFormation. You can paste the
commands below and have a working server in five minutes.

## Prerequisites

- AWS CLI installed and authenticated (`aws sts get-caller-identity`).
- Default VPC in your chosen region (`aws ec2 describe-vpcs --filters Name=is-default,Values=true`).
- The `AmazonSSMRoleForInstancesQuickSetup` instance profile in your
  account (AWS creates it the first time you use SSM, or you can run
  `aws iam create-instance-profile --instance-profile-name htmlz-ssm`
  and attach `AmazonSSMManagedInstanceCore`).

```bash
export AWS_REGION=us-east-1  # whatever you prefer
```

## 1 · Security Group

Allow inbound TCP `8000` only from your home IP. Everything else
closed. (If you'll front this with Tailscale, see the alternative at
the bottom — you can have *zero* inbound rules.)

```bash
MY_IP=$(curl -fsSL https://checkip.amazonaws.com)/32

SG_ID=$(aws ec2 create-security-group \
  --group-name htmlz \
  --description "htmlz HTML host" \
  --query GroupId --output text)

aws ec2 authorize-security-group-ingress \
  --group-id "$SG_ID" \
  --protocol tcp --port 8000 \
  --cidr "$MY_IP"
```

If your IP changes (laptop on different networks), re-run the
`authorize-security-group-ingress` step with the new CIDR. Or skip
ingress entirely and use Tailscale.

## 2 · Launch the instance

The user-data script ([`aws-user-data.sh`](aws-user-data.sh)) installs
Docker + Compose, clones the repo to `/opt/htmlz`, and brings it up.
Bootstrap takes ~90 seconds.

```bash
# Latest AL2023 ARM64 AMI for your region:
AMI=$(aws ssm get-parameter \
  --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 \
  --query Parameter.Value --output text)

INSTANCE_ID=$(aws ec2 run-instances \
  --image-id "$AMI" \
  --instance-type t4g.nano \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile Name=AmazonSSMRoleForInstancesQuickSetup \
  --user-data file://infra/aws-user-data.sh \
  --metadata-options "HttpTokens=required,HttpPutResponseHopLimit=2" \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=htmlz}]' \
  --query "Instances[0].InstanceId" --output text)

echo "Launched $INSTANCE_ID — waiting for it to come up…"
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"

PUBLIC_IP=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" \
  --query "Reservations[0].Instances[0].PublicIpAddress" --output text)

echo "✓ http://$PUBLIC_IP:8000  (give it ~90s to finish bootstrap)"
```

Open `http://$PUBLIC_IP:8000` from the same machine. You should see the
landing page within a couple of minutes.

## 3 · Wire up your agent

From the same machine that just launched the instance:

```bash
curl -fsSL "http://$PUBLIC_IP:8000/install.sh" | bash
htmlz identity "your name"
htmlz publish ./examples/hello.html
```

The install script auto-templates the BASE URL into
`~/.config/htmlz/config.json`, so you don't need to set `HTMLZ_BASE`
on every command.

## 4 · Shell access (no SSH keys)

```bash
aws ssm start-session --target "$INSTANCE_ID"
```

Once inside:

```bash
sudo -i
cd /opt/htmlz
docker compose ps
docker compose logs -f htmlz
```

Update the running service:

```bash
cd /opt/htmlz
sudo git pull
sudo docker compose up -d --build
```

The first bootstrap output is at `/var/log/htmlz-bootstrap.log`.

## 5 · Optional: put it behind Tailscale

If you want zero public ingress (the cleanest model for "trust the
network"), install Tailscale on the box and remove the Security Group
inbound rule.

```bash
aws ssm start-session --target "$INSTANCE_ID"
sudo -i
curl -fsSL https://tailscale.com/install.sh | sh
tailscale up --ssh
tailscale ip -4   # → 100.x.y.z, the address you'll use
exit
exit
# Now back on your laptop:
aws ec2 revoke-security-group-ingress \
  --group-id "$SG_ID" --protocol tcp --port 8000 --cidr "$MY_IP"
```

The htmlz server is now only reachable from devices on your tailnet.
Use `http://100.x.y.z:8000/` (or set a MagicDNS name) from any of them.

## 6 · Cost

| Item | Monthly |
|---|---|
| `t4g.nano` (24×7, on-demand) | ~$3.00 |
| EBS gp3 8GB | ~$0.64 |
| Data transfer | ~$0 (well under free tier for personal use) |
| **Total** | **~$3.50** |

## 7 · DNS (optional)

If you want a friendlier name than the public IP, create a Route 53
A record pointing your subdomain at `$PUBLIC_IP`, or use Tailscale
MagicDNS if you went the Tailscale route. The htmlz install script
templates `{{BASE}}` from whatever host the request came in on, so the
same install command keeps working under any name.

## Teardown

```bash
aws ec2 terminate-instances --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-terminated --instance-ids "$INSTANCE_ID"
aws ec2 delete-security-group --group-id "$SG_ID"
```

Page data lives only on the instance's EBS volume — terminating wipes
it. Snapshot the volume first if you want to keep anything.
