# techbigsolutions-node-api

A Node.js / Express REST API backed by MySQL, deployed on AWS.

---

## Local development

```bash
cp .env.example .env        # fill in your local values
npm install
npm run migrate             # create tables
npm run dev                 # starts with nodemon
```

Health check: `GET /api/health`

---

## AWS deployment

The project ships configuration for three AWS deployment paths. Pick the one that fits your setup.

### Option A — Elastic Beanstalk (Node.js platform)

Suitable for a quick lift-and-shift without Docker.

```bash
# Install the EB CLI (once)
pip install awsebcli

# Initialise (run once per machine)
eb init techbigsolutions-node-api --platform node.js-20 --region us-east-1

# Create the environment
eb create techbigsolutions-prod --elb-type application

# Set environment variables (never commit secrets)
eb setenv NODE_ENV=production \
           DB_HOST=<rds-endpoint> \
           DB_USER=<user> \
           DB_PASSWORD=<password> \
           DB_NAME=<dbname> \
           DB_SSL=true \
           JWT_SECRET=$(openssl rand -hex 64) \
           JWT_EXPIRES_IN=1d \
           ALLOWED_ORIGINS=https://yourapp.com

# Deploy subsequent updates
eb deploy
```

Configuration lives in `.ebextensions/` — edit `00_env.config` to adjust Node version,
load-balancer settings, or health-check path.

---

### Option B — ECS (Docker / Fargate)

1. **Build & push image to ECR**

```bash
AWS_ACCOUNT_ID=123456789012
AWS_REGION=us-east-1
ECR_REPO=techbigsolutions-node-api

# Authenticate
aws ecr get-login-password --region $AWS_REGION \
  | docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

# Create repo (once)
aws ecr create-repository --repository-name $ECR_REPO --region $AWS_REGION

# Build & push
docker build -t $ECR_REPO .
docker tag $ECR_REPO:latest $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
docker push $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO:latest
```

2. Create an ECS cluster, task definition (use the image URI above), and service.
3. Point your ALB target group to the ECS service; set the health-check path to `/api/health`.
4. Store secrets in **AWS Secrets Manager** and reference them in the task definition — never hard-code them.

---

### Option C — EC2 via CodeDeploy

`appspec.yml` and the `scripts/` directory drive a CodeDeploy in-place or blue/green deployment to EC2.

Typical pipeline: **CodeCommit / GitHub → CodeBuild → CodeDeploy → EC2**

`buildspec.yml` handles the CodeBuild phase (Docker build + ECR push).
Required CodeBuild environment variables: `AWS_ACCOUNT_ID`, `AWS_REGION`, `ECR_REPO_NAME`.

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default `3000`; EB uses `8080`) |
| `NODE_ENV` | Yes | `production` or `development` |
| `DB_HOST` | Yes | MySQL / RDS hostname |
| `DB_PORT` | No | Default `3306` |
| `DB_USER` | Yes | Database user |
| `DB_PASSWORD` | Yes | Database password |
| `DB_NAME` | Yes | Database name |
| `DB_SSL` | No | `true` for RDS (default), `false` for local dev |
| `DB_CONNECTION_LIMIT` | No | Pool size (default `10`) |
| `JWT_SECRET` | Yes | Long random string — use `openssl rand -hex 64` |
| `JWT_EXPIRES_IN` | No | Token TTL (default `1d`) |
| `ALLOWED_ORIGINS` | Yes | Comma-separated allowed CORS origins |

---

## Database migrations

```bash
npm run migrate
```

---

## Project structure

```
src/
  app.js              # Express app setup
  server.js           # HTTP server + graceful shutdown
  config/
    db.js             # MySQL2 connection pool
    migrate.js        # Schema migration runner
  controllers/        # Route handlers
  middlewares/        # Auth guards, error handler
  models/             # DB query helpers
  routes/             # Express routers
.ebextensions/        # Elastic Beanstalk config
scripts/              # CodeDeploy lifecycle hooks
Dockerfile            # Multi-stage production image
buildspec.yml         # AWS CodeBuild spec
appspec.yml           # AWS CodeDeploy spec
Procfile              # EB process declaration
```
