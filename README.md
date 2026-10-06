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

Set `PORT=5000` in `.env` so this API does not collide with the Next.js
dev server on port 3000.

Health check: `GET /api/health`

---

## Attendance

Face ID + office geofence + live presence. Employee routes live under
`/api/attendance` (site-user JWT + Attendance module). Admin routes live
under `/api/attendance/admin` (admin JWT).

Local stub: `GET /api/attendance/ping`

Non-production CORS also allows `http://localhost:3000` and
`http://127.0.0.1:3000`. Optional extra origins:
`EXTRA_ALLOWED_ORIGINS=http://localhost:3001`

Configuration variables:
- `FACE_ENC_KEY`: 32-byte key as 64 hex characters for AES-256-GCM encryption of stored face templates.
- `FACE_MATCH_THRESHOLD`: Euclidean distance threshold for 1:1 face matching (default `0.5`).
- `FACE_REPLAY_EPSILON`: Minimum pairwise distance between multi-frame descriptors for replay detection (default `0.004`). Note: this threshold must be tuned with real camera capture data and is not a substitute for proper biometric liveness.
- `TRUSTED_PROXY_HOPS`: Number of reverse proxy hops to trust counting from the right of `X-Forwarded-For` (default `1` for AWS ALB / Nginx).

See `ATTENDANCE_API.md` (added in a later phase) for the full contract.

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
| `EXTRA_ALLOWED_ORIGINS` | No | Comma-separated extra CORS origins (e.g., dev/preview domains) |
| `FACE_ENC_KEY` | Yes (in prod) | 32-byte key as 64 hex chars (`openssl rand -hex 32`) for AES-256-GCM face template encryption |
| `FACE_MATCH_THRESHOLD` | No | Euclidean distance threshold for 1:1 face matching (default `0.5`) |
| `FACE_REPLAY_EPSILON` | No | Pairwise Euclidean distance threshold for multi-frame replay detection (default `0.004`) |
| `TRUSTED_PROXY_HOPS` | No | Number of reverse proxy hops to trust counting from right of `X-Forwarded-For` (default `1`) |

---

## Smoke & Acceptance Tests

```bash
# Run local smoke tests (health checks, CORS verification, unauthenticated route barriers)
npm run smoke

# When testing a remote deployment without making DB modifications:
BASE_URL=https://api.techbigsolutions.in npm run smoke

# Run acceptance test suites (local DB only)
node scripts/test-phase2.js
node scripts/test-phase3.js
node scripts/test-phase4.js
node scripts/benchmark-sweeper.js
```

---

## Database migrations

```bash
npm run migrate
```

Migrations are strictly additive and idempotent:
- Dynamic collation: tables inherit charset and collation from `site_users.user_id` without altering existing tables.
- Creates `attendance_offices`, `attendance_profiles`, `attendance_records`, `attendance_intervals`, `attendance_attempts`, `attendance_presence`, `attendance_reverify_tasks`, `attendance_regularization_requests`, and `attendance_leaves`.
- Safe to re-run in continuous deployment pipelines.

---

## Deployment Checklist & Rollback

### Production Checklist
1. Ensure RDS MySQL 8.0+ is running with UTF8MB4 charset.
2. Run database migration:
   ```bash
   npm run migrate
   ```
3. Set environment variables in Elastic Beanstalk / ECS:
   ```bash
   eb setenv FACE_ENC_KEY=$(openssl rand -hex 32) \
              FACE_MATCH_THRESHOLD=0.5 \
              TRUSTED_PROXY_HOPS=1 \
              ALLOWED_ORIGINS=https://techbigsolutions.in,https://www.techbigsolutions.in
   ```
4. Deploy application:
   ```bash
   eb deploy
   ```
5. Verify deployment:
   ```bash
   BASE_URL=https://api.techbigsolutions.in npm run smoke
   ```

### Rollback Note
- Attendance database migrations only create new `attendance_*` tables and do not modify existing `site_users` or `admins` tables.
- If rolling back application code, previous application versions will ignore the `attendance_*` tables without error.

---

## Known Operational Limits
- **Single Sweeper Leader**: Attendance sweeper uses MySQL cooperative lock `GET_LOCK('attendance_sweeper', 0)`. When running multiple API instances behind ALB, exactly one instance runs the 30s sweep; concurrent sweeps are safely skipped.
- **SSE Stream Limit**: Maximum 5 concurrent SSE live connections per admin instance (`/api/attendance/admin/stream`).
- **Face Liveness**: Client performs multi-frame challenge-response. The server applies replay rejection (`FACE_REPLAY_EPSILON`) and rate limits (lockout after 5 consecutive failures). Hardware biometrics / active depth cameras can be added if higher security assurance is required.

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
